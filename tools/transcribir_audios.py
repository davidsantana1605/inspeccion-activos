#!/usr/bin/env python3
"""Transcribe las notas de voz de los ZIP exportados por la app (faster-whisper, local, sin internet
salvo la primera descarga del modelo).

Por cada ZIP de entrada genera, junto a el (o en --salida), `<nombre>_transcrito.zip`: una copia con
la MISMA estructura, donde el campo `transcript` de cada audio en activo.json y activos.json esta
relleno. Ademas escribe `transcripciones.csv` (UTF-8 con BOM, abre bien en Excel) y una cache
`transcripciones_cache.json` para no repetir trabajo.

Uso:
    python tools/transcribir_audios.py ZIP1 [ZIP2 ...] [-o CARPETA] [--modelo small] [--idioma es]

Requisitos: Python 3.10+, ffmpeg en el PATH, `pip install -r tools/requirements.txt`.
Ver tools/README_transcribir.md.
"""
import argparse
import csv
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

SIN_VOZ = "(sin voz detectada)"
RE_ACTIVO_JSON = re.compile(r"^activos/([^/]+)/activo\.json$")


def info(msg):
    print(msg, flush=True)


def nombre_seguro(nombre):
    """True si la ruta del ZIP es relativa y sin '..' (evita path traversal al copiar)."""
    n = nombre.replace("\\", "/")
    if n.startswith("/") or re.match(r"^[A-Za-z]:", n):
        return False
    return ".." not in [p for p in n.split("/")]


def decodificar(ruta):
    """Audio -> PCM float32 mono 16 kHz con ffmpeg (sirve para webm/opus de Chrome y m4a de iPhone)."""
    import numpy as np
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(ruta), "-vn", "-ac", "1", "-ar", "16000",
                        "-f", "f32le", "-"], capture_output=True, timeout=900)
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError("ffmpeg no pudo decodificar el audio")
    return np.frombuffer(r.stdout, dtype=np.float32)


class Transcriptor:
    def __init__(self, modelo, idioma, ruta_cache):
        self.modelo_nombre = modelo
        self.idioma = None if idioma in ("auto", "", None) else idioma
        self.ruta_cache = ruta_cache
        self.cache = {}
        if ruta_cache.exists():
            try:
                self.cache = json.loads(ruta_cache.read_text(encoding="utf-8"))
            except Exception:
                self.cache = {}
        self.modelo = None
        self.nuevas = 0
        self.de_cache = 0

    def _cargar(self):
        if self.modelo is None:
            from faster_whisper import WhisperModel
            info(f"Cargando modelo Whisper '{self.modelo_nombre}' (la primera vez se descarga, ~480 MB para 'small')...")
            self.modelo = WhisperModel(self.modelo_nombre, device="cpu", compute_type="int8")

    def en_cache(self, sha):
        e = self.cache.get(sha)
        return bool(e) and e.get("modelo") == self.modelo_nombre and e.get("idioma") == (self.idioma or "auto")

    def texto(self, sha, ruta):
        """Devuelve el texto ('' si no hay voz). Levanta excepcion si el audio no se puede leer."""
        if self.en_cache(sha):
            self.de_cache += 1
            return self.cache[sha]["texto"]
        self._cargar()
        # VAD: sin el, Whisper inventa texto sobre el silencio. condition_on_previous_text=False evita bucles.
        segs, _ = self.modelo.transcribe(decodificar(ruta), language=self.idioma, vad_filter=True, beam_size=5,
                                         condition_on_previous_text=False)
        txt = " ".join(s.text.strip() for s in segs).strip()
        self.cache[sha] = {"modelo": self.modelo_nombre, "idioma": self.idioma or "auto", "texto": txt}
        self.ruta_cache.write_text(json.dumps(self.cache, ensure_ascii=False, indent=2), encoding="utf-8")
        self.nuevas += 1
        return txt


def procesar_zip(ruta_zip, salida, trans, filas, resumen):
    destino = salida / (ruta_zip.stem + "_transcrito.zip")
    resultados = {}  # (carpeta, archivo_audio) -> (estado, texto)
    with zipfile.ZipFile(ruta_zip) as zin:
        infos = [zi for zi in zin.infolist() if not zi.is_dir() and nombre_seguro(zi.filename)]
        omitidas = len([zi for zi in zin.infolist() if not zi.is_dir()]) - len(infos)
        if omitidas:
            info(f"AVISO: {omitidas} entrada(s) con ruta insegura se ignoraron en {ruta_zip.name}")

        # 1) Transcribir todos los audios declarados en cada activo.json.
        docs = {}
        for zi in infos:
            m = RE_ACTIVO_JSON.match(zi.filename.replace("\\", "/"))
            if not m:
                continue
            try:
                doc = json.loads(zin.read(zi).decode("utf-8-sig"))
                if isinstance(doc, dict):
                    docs[m.group(1)] = (zi, doc)
            except Exception as e:
                info(f"AVISO: activo.json ilegible en '{m.group(1)}': {e}")
        total = sum(len([a for a in (d.get("audios") or []) if isinstance(a, dict) and a.get("file")]) for _, d in docs.values())
        n = 0
        with tempfile.TemporaryDirectory() as tmp:
            for carpeta, (zi, doc) in docs.items():
                for a in doc.get("audios") or []:
                    if not isinstance(a, dict) or not a.get("file"):
                        continue
                    n += 1
                    archivo = a["file"]
                    resumen["audios"] += 1
                    miembro = f"activos/{carpeta}/{archivo}"
                    try:
                        datos = zin.read(miembro)
                        if not datos:
                            raise RuntimeError("archivo de audio vacio")
                        sha = hashlib.sha1(datos).hexdigest()
                        origen = Path(tmp) / f"{n}{Path(archivo).suffix or '.bin'}"
                        if not trans.en_cache(sha):
                            origen.write_bytes(datos)
                        info(f"Transcribiendo {n}/{total}: {carpeta}/{archivo}" + (" (en cache)" if trans.en_cache(sha) else ""))
                        txt = trans.texto(sha, origen)
                        estado = "ok" if txt else "sin_voz"
                        resumen["ok" if txt else "sin_voz"] += 1
                        resultados[(carpeta, archivo)] = (estado, txt)
                    except KeyError:
                        resultados[(carpeta, archivo)] = ("falta_archivo", "")
                        resumen["fallos"] += 1
                        resumen["problemas"].append(f"{ruta_zip.name}: {miembro} figura en activo.json pero no esta en el ZIP")
                    except Exception as e:
                        resultados[(carpeta, archivo)] = ("ilegible", "")
                        resumen["fallos"] += 1
                        resumen["problemas"].append(f"{ruta_zip.name}: {miembro}: {e}")
                    estado, txt = resultados[(carpeta, archivo)]
                    filas.append({"zip": ruta_zip.name, "carpeta": carpeta, "id": doc.get("id", ""), "seq": doc.get("seq", ""),
                                  "inspector": doc.get("inspector", ""), "building_code": doc.get("building_code", ""),
                                  "floor": doc.get("floor", ""), "audio": archivo, "estado": estado,
                                  "duracion_s": a.get("duration_s", ""), "transcripcion": txt})

        # 2) Escribir la copia con los transcript rellenos; todo lo demas pasa intacto.
        por_id = {}
        for carpeta, (zi, doc) in docs.items():
            for a in doc.get("audios") or []:
                if isinstance(a, dict) and (carpeta, a.get("file")) in resultados:
                    estado, txt = resultados[(carpeta, a["file"])]
                    if estado in ("ok", "sin_voz"):
                        a["transcript"] = txt
            por_id[str(doc.get("id", ""))] = doc
        tmp_zip = destino.with_suffix(".zip.tmp")
        with zipfile.ZipFile(tmp_zip, "w") as zout:
            for zi in infos:
                nombre = zi.filename.replace("\\", "/")
                m = RE_ACTIVO_JSON.match(nombre)
                comp = zipfile.ZIP_STORED if re.search(r"\.(jpe?g|png|webm|m4a|ogg|mp3)$", nombre, re.I) else zipfile.ZIP_DEFLATED
                if m and m.group(1) in docs:
                    zout.writestr(nombre, json.dumps(docs[m.group(1)][1], ensure_ascii=False, indent=2), compress_type=comp)
                elif nombre == "activos.json":
                    try:
                        arr = json.loads(zin.read(zi).decode("utf-8-sig"))
                        for item in arr:
                            nuevo = por_id.get(str(item.get("id", ""))) if isinstance(item, dict) else None
                            if nuevo is not None:
                                item["audios"] = nuevo.get("audios", item.get("audios"))
                        zout.writestr(nombre, json.dumps(arr, ensure_ascii=False, indent=2), compress_type=comp)
                    except Exception:
                        zout.writestr(nombre, zin.read(zi), compress_type=comp)
                elif nombre == "manifest.json":
                    try:
                        man = json.loads(zin.read(zi).decode("utf-8-sig"))
                        man["transcription"] = {"engine": "faster-whisper", "model": trans.modelo_nombre,
                                                "language": trans.idioma or "auto"}
                        zout.writestr(nombre, json.dumps(man, ensure_ascii=False, indent=2), compress_type=comp)
                    except Exception:
                        zout.writestr(nombre, zin.read(zi), compress_type=comp)
                else:
                    zi2 = zipfile.ZipInfo(nombre, zi.date_time)
                    zi2.compress_type = comp
                    with zin.open(zi) as src, zout.open(zi2, "w", force_zip64=zi.file_size > 2**30) as dst:
                        shutil.copyfileobj(src, dst)
    tmp_zip.replace(destino)
    return destino


def main(argv=None):
    p = argparse.ArgumentParser(description="Transcribe los audios de los ZIP exportados por la app.")
    p.add_argument("zips", nargs="+", help="ZIP(s) exportados por la app")
    p.add_argument("-o", "--salida", help="carpeta de salida (por defecto, junto al primer ZIP)")
    p.add_argument("--modelo", default="small", help="modelo Whisper: tiny, base, small (defecto), medium, large-v3")
    p.add_argument("--idioma", default="es", help="idioma ('es' por defecto, 'auto' para detectarlo)")
    a = p.parse_args(argv)

    rutas = [Path(z) for z in a.zips]
    malos = [str(r) for r in rutas if not r.is_file() or not zipfile.is_zipfile(r)]
    if malos:
        info("ERROR: no son ZIP validos: " + ", ".join(malos))
        return 2
    salida = Path(a.salida) if a.salida else rutas[0].parent
    salida.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
    except Exception:
        info("ERROR: no se encontro ffmpeg en el PATH (instalalo: winget install Gyan.FFmpeg).")
        return 2
    try:
        import faster_whisper  # noqa: F401
    except ImportError:
        info("ERROR: falta faster-whisper. Ejecuta: python -m pip install -r tools/requirements.txt")
        return 2

    trans = Transcriptor(a.modelo, a.idioma, salida / "transcripciones_cache.json")
    resumen = {"audios": 0, "ok": 0, "sin_voz": 0, "fallos": 0, "problemas": []}
    filas, generados = [], []
    for r in rutas:
        info(f"== {r.name}")
        try:
            generados.append(procesar_zip(r, salida, trans, filas, resumen))
        except Exception as e:
            resumen["fallos"] += 1
            resumen["problemas"].append(f"{r.name}: {e}")
            info(f"ERROR procesando {r.name}: {e}")

    csv_path = salida / "transcripciones.csv"
    campos = ["zip", "carpeta", "id", "seq", "inspector", "building_code", "floor", "audio", "estado", "duracion_s", "transcripcion"]
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=campos, lineterminator="\r\n")
        w.writeheader()
        w.writerows(filas)

    info("\n=== RESUMEN ===")
    info(f"Audios: {resumen['audios']}  transcritos: {resumen['ok']}  sin voz: {resumen['sin_voz']}  fallos: {resumen['fallos']}  (de cache: {trans.de_cache})")
    for g in generados:
        info(f"ZIP con transcripciones: {g}")
    info(f"CSV: {csv_path}")
    for pr in resumen["problemas"]:
        info("  - " + pr)
    return 0 if not resumen["fallos"] else 1


if __name__ == "__main__":
    sys.exit(main())
