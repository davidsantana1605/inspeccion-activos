# Inspección de Activos (PWA offline)

App web instalable para registrar activos en campo, 100 % offline después de la primera carga. Sitio estático (HTML + CSS + JS, sin build) pensado para GitHub Pages. La especificación completa está en `BRIEF_App_Inspeccion_Activos.md`.

**Estado: Fase 1 de 6** — esqueleto PWA, Ajustes (inspector), importación/edición de edificios. Registro de activos, fotos, audio y exportación llegan en las fases 2–5.

## Estructura

```
index.html  styles.css  manifest.webmanifest  sw.js  .nojekyll
js/    app.js (UI y rutas) · db.js (IndexedDB) · csv.js (parser) · version.js
icons/ iconos PNG (any, maskable, apple-touch)
tools/ make-icons.ps1 · check-precache.mjs
edificios_ejemplo.csv
```

Todos los nombres de archivo van en **minúsculas**: GitHub Pages distingue mayúsculas y un solo error en la lista de precaché impide que el service worker se instale. Antes de cada publicación:

```bash
node tools/check-precache.mjs
```

## Probar en local

```bash
python -m http.server 8080
```

Abre `http://localhost:8080` (localhost cuenta como contexto seguro, el service worker funciona).

## Publicar en GitHub Pages

1. Crea un repositorio en GitHub (p. ej. `inspeccion-activos`) y sube estos archivos a la raíz de la rama `main`.
2. En el repositorio: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `/ (root)` → Save**.
3. Espera ~1 minuto. La app queda en `https://USUARIO.github.io/inspeccion-activos/`.
4. Todas las rutas de la app son relativas, así que funciona dentro del subdirectorio del repo.

## Instalar la PWA

- **Android (Chrome):** abre la URL **con internet** una vez → menú ⋮ → *Instalar app*. Ábrela desde el ícono y prueba en modo avión.
- **iPhone (Safari 16.4+):** abre la URL en Safari → Compartir → *Añadir a pantalla de inicio*. Abre siempre desde el ícono. iOS limita más el almacenamiento y puede borrarlo si no se usa la app durante semanas; exporta con frecuencia.

## Publicar una versión nueva

1. Cambia la versión en **dos** sitios: `VERSION` en `sw.js` y `APP_VERSION` en `js/version.js` (el script `check-precache.mjs` falla si no coinciden).
2. Si agregaste archivos nuevos, añádelos a `PRECACHE` en `sw.js`.
3. `node tools/check-precache.mjs`, commit y push.
4. En el teléfono, al abrir la app aparece el aviso **"Hay una nueva versión — Actualizar"**. También: Ajustes → *Buscar actualización*. La app nunca se actualiza sola a mitad de un registro.
5. Para forzar: cerrar la app por completo y reabrir, o en Chrome → Configuración del sitio → Borrar datos (**¡borra los registros!**; exporta antes).

## Formato del CSV de edificios

Exactamente 2 columnas con encabezados `BLDG #` y `BLDG NAME` (mayúsculas/espacios no importan).

```csv
BLDG #,BLDG NAME
B-01,Edificio Administrativo
B-05,"Taller de Mantenimiento, Anexo"
```

- Separador `,` o `;` (se detecta solo). Acepta BOM UTF-8, comillas, espacios extra y acentos.
- Si el archivo no es UTF-8 (Excel en español guarda en ANSI/Windows-1252) se reinterpreta automáticamente.
- Códigos `BLDG #` duplicados (sin distinguir mayúsculas): se avisa y se conserva la primera fila.
- Al importar con una lista existente se elige **Reemplazar** o **Fusionar**.
- *Exportar CSV* en Edificios descarga `edificios.csv` (UTF-8 con BOM).
- Para dar la misma lista a todos los inspectores, compartan el mismo CSV. `edificios_ejemplo.csv` es solo de prueba.

## Formato del ZIP exportado

Se documenta en la Fase 5 (ver sección 8 del brief).

## Pruebas manuales en el S21 Ultra — Fase 1

1. Abrir la URL en Chrome con internet → *Instalar app*.
2. Abrir desde el ícono; escribir el nombre en Ajustes.
3. Activar **modo avión**, cerrar la app por completo (deslizar), reabrir: debe cargar y mostrar el nombre.
4. Importar `edificios_ejemplo.csv` y, además, un CSV guardado desde Excel (con `;` y acentos) → los acentos deben verse bien.
5. Ajustes → almacenamiento persistente debe decir *Sí*.
