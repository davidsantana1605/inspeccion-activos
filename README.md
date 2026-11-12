# Inspección de Activos (PWA offline)

App web instalable para registrar activos en campo, 100 % offline después de la primera carga. Sitio estático (HTML + CSS + JS, sin build) pensado para GitHub Pages. La especificación completa está en `BRIEF_App_Inspeccion_Activos.md`.

**Estado: fases 1–6 implementadas (v0.2.1).** Verificado en navegador de escritorio: registro, contexto recordado, fotos (redimensión y miniaturas), exportación ZIP, respaldo/restauración y lista con 300 activos. **Sin probar aún en dispositivo real:** cámara nativa, micrófono, compartir y modo avión en el S21 Ultra (ver pruebas manuales abajo).

## Estructura

```
index.html  styles.css  manifest.webmanifest  sw.js  .nojekyll
js/    app.js (rutas, ajustes, edificios) · assets.js (formulario, lista, departamentos) · data.js (contratos de datos)
       photos.js · audio.js · export.js · db.js (IndexedDB) · csv.js · version.js
css/   photos.css · audio.css · export.css      vendor/ fflate.esm.js (ZIP, vendorizado)
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

## Modelo de datos (resumen)

- `assets`: un registro por activo (`status` `draft` | `saved`). El borrador se autoguarda en cada cambio; el `seq` se asigna al guardar por primera vez.
- `blobs`: fotos (`photo`), miniaturas (`thumb`), audios (`audio`) y trozos de grabación en curso (`audiochunk`). Los módulos de medios nunca escriben el registro del activo; `photos[]`/`audios[]` se arman al exportar.
- Contexto recordado en `settings.last_context`. Un activo está "por exportar" si nunca se exportó o se editó después (`updated_at > exported_at`).

## Formato del ZIP exportado

`inspeccion_{device8}_{YYYYMMDD-HHmm}_parte{n}.zip` con `manifest.json`, `activos.csv` (UTF-8 con BOM), `activos.json`, `edificios.csv` y `activos/{BLDG}_{seq4}_{uuid8}/` con `activo.json`, `foto_NN.jpg`, `captura_NN.png`, `audio_NN.webm|m4a` y `notas.txt`. Se parte en varios ZIP según el tamaño máximo elegido. El respaldo completo (`respaldo_*.zip`) se restaura desde Exportar → *Restaurar respaldo*.

## Pruebas manuales en el S21 Ultra — Fase 1

1. Abrir la URL en Chrome con internet → *Instalar app*.
2. Abrir desde el ícono; escribir el nombre en Ajustes.
3. Activar **modo avión**, cerrar la app por completo (deslizar), reabrir: debe cargar y mostrar el nombre.
4. Importar `edificios_ejemplo.csv` y, además, un CSV guardado desde Excel (con `;` y acentos) → los acentos deben verse bien.
5. Ajustes → almacenamiento persistente debe decir *Sí*.

## Pruebas manuales en el S21 Ultra — Fases 2–6

1. Registrar 10 activos en modo avión; cerrar la app por completo y reabrir: todo sigue y el contexto (edificio/piso/departamento) se recuerda.
2. **Tomar foto** abre la cámara nativa; 20 fotos en un activo; zoom sobre una placa de datos legible. **Agregar de galería** con capturas de pantalla.
3. Con la cámara abierta, forzar el cierre de Chrome: al volver debe existir el borrador.
4. Grabar 5 audios en modo avión, reiniciar la app y reproducirlos. Cerrar la app grabando: al reabrir debe avisar que recuperó la nota.
5. Exportar 50 activos con fotos: abrir el ZIP en Windows; `activos.csv` en Excel con acentos correctos; probar *Compartir*.
6. Crear respaldo, borrar datos del sitio y restaurar.
7. iPhone (Safari 16.4+): mismo flujo; audio sale como `.m4a`.
