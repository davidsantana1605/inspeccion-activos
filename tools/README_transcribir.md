# Transcribir las notas de voz (escritorio)

La app solo **graba** los audios. Este script los transcribe en tu PC con Whisper (faster-whisper), sin enviar nada a internet (solo se descarga el modelo la primera vez).

## Requisitos
- Python 3.10 o superior y `ffmpeg` en el PATH (`winget install Gyan.FFmpeg`).
- `python -m pip install -r tools/requirements.txt`
- Modelo `small` (por defecto): ~480 MB, se descarga solo la primera vez. Para más precisión usa `--modelo medium` (más lento).

## Uso
```bash
python tools/transcribir_audios.py inspeccion_xxxx_parte1.zip inspeccion_xxxx_parte2.zip -o transcritos
```

Por cada ZIP exportado por la app genera:
- `<nombre>_transcrito.zip`: **la misma estructura** que el original, con el campo `transcript` de cada audio rellenado en `activo.json` y `activos.json` (el `manifest.json` anota el modelo usado). Fotos y audios pasan intactos.
- `transcripciones.csv` (UTF-8 con BOM, abre bien en Excel): zip, carpeta, id, seq, inspector, edificio, piso, audio, estado, duración y texto.
- `transcripciones_cache.json`: evita repetir trabajo si vuelves a ejecutarlo.

Estados: `ok`, `sin_voz` (silencio; el `transcript` queda vacío), `ilegible` (audio dañado; no detiene el proceso) y `falta_archivo`.

## Opciones
`--modelo tiny|base|small|medium|large-v3`, `--idioma es` (por defecto; `auto` detecta el idioma), `-o CARPETA`.

## Notas
- Se fuerza español y VAD (detector de voz) para que Whisper no invente texto sobre el silencio.
- Funciona con audio de Chrome (`webm/opus`) y de iPhone (`m4a`).
- Revisa el texto: el modelo puede confundir términos técnicos o palabras parecidas.
