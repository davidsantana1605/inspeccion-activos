# Brief de desarrollo — App de inspección y registro de activos (PWA offline)

> **Instrucción para Claude:** Este documento es la especificación completa de una app a construir. Léelo entero antes de escribir código. Trabaja por fases (sección 12), entrega cada fase funcionando y probada antes de pasar a la siguiente, y pregunta solo si algo aquí es contradictorio o imposible. La interfaz de la app va en **español**; el código, nombres de variables y comentarios pueden ir en inglés.

---

## 1. Contexto

- **Usuario principal:** valuador de activos (MRICS) que inventaría activos en inspecciones de campo (edificios, plantas industriales).
- **Uso:** registrar hasta **~300 activos por jornada**, con **~5 fotos por activo** (≈1.500 fotos/día), notas de texto y notas de voz.
- **Conectividad:** frecuentemente **sin internet** dentro de los edificios. La app debe funcionar 100 % offline después de la primera carga.
- **Dispositivo principal:** Samsung Galaxy S21 Ultra, Chrome para Android. Luego se compartirá con colegas de la empresa (Android y algunos iPhone con Safari).
- **Destino de los datos:** en escritorio, el paquete exportado se procesará con IA (visión + transcripción de audio con Whisper) para generar un listado estructurado de activos. **La app solo captura; no procesa con IA ni transcribe.**
- **Prioridades:** rapidez de uso en campo (pocos toques por activo), fiabilidad (no perder datos nunca), y salida limpia para procesamiento posterior.

## 2. Decisiones técnicas (ya tomadas)

| Tema | Decisión |
|---|---|
| Tipo de app | PWA (Progressive Web App) instalable desde Chrome ("Añadir a pantalla de inicio") |
| Hosting | **GitHub Pages** (HTTPS gratis). Sitio 100 % estático. |
| Build | **Sin paso de build obligatorio.** HTML + CSS + JavaScript (ES modules). Librerías externas **vendorizadas** en `/vendor` (no CDN), para que el service worker las cachee y funcione offline. |
| Framework | Vanilla JS o una librería ligera sin build (p. ej. Preact + htm vendorizados). Evitar React/Vite salvo que se justifique; si se usa build, debe generar la carpeta `docs/` o una GitHub Action que publique. |
| Almacenamiento | **IndexedDB** para registros y blobs (fotos/audio). Se recomienda la librería `idb` (vendorizada) o Dexie. |
| Persistencia | Llamar `navigator.storage.persist()` al inicio y mostrar el estado. Mostrar uso de espacio con `navigator.storage.estimate()`. |
| Offline | Service worker con estrategia cache-first para el app shell. Versionado de caché y aviso "Hay una nueva versión — actualizar". |
| Exportación | ZIP generado en el cliente (JSZip o fflate vendorizado), por lotes. |
| Transcripción | **No en el teléfono.** Se graban audios y se transcriben en escritorio. |

## 3. Datos maestros (precargados)

### 3.1 Edificios
- Se importan desde un **CSV con exactamente 2 columnas**: `BLDG #` y `BLDG NAME`.
  ```csv
  BLDG #,BLDG NAME
  B-01,Edificio Administrativo
  B-02,Planta de Producción Norte
  ```
- Debe tolerar: separador `,` o `;`, BOM UTF-8, comillas, espacios extra, y acentos. Validar duplicados de `BLDG #` y avisar.
- Importar CSV **reemplaza o fusiona** (preguntar al usuario). También permitir agregar/editar/borrar un edificio manualmente en Ajustes.
- Exportar la lista de edificios a CSV.

### 3.2 Pisos (lista fija, en este orden)
```
BASEMENT 4, BASEMENT 3, BASEMENT 2, BASEMENT 1,
1, MEZZANINE 1, 2, MEZZANINE 2, 3, MEZZANINE 3, 4, MEZZANINE 4,
5, 6, 7, … 30
```
- El orden exacto de mezzanines puede ajustarse; lo importante es que la lista esté **toda disponible** y sea rápida de elegir. Alternativa aceptable: orden `BASEMENT 4→1`, `MEZZANINE 1–4`, `1–30`. Usar la que resulte más rápida de navegar y documentarla.
- Valor guardado: texto exacto (`"BASEMENT 2"`, `"MEZZANINE 1"`, `"12"`).

### 3.3 Departamentos
- Lista editable. Se puede **precargar por CSV** (1 columna: `DEPARTMENT`) o crear **al vuelo** desde el formulario ("+ Nuevo departamento" escribiendo el nombre).
- Los nuevos departamentos quedan guardados en la lista para usos futuros.
- Normalizar al comparar (mayúsculas/espacios) para no crear duplicados como "Mantenimiento" y "MANTENIMIENTO ".

## 4. Registro de un activo — formulario

### Campos
| Campo | Tipo | Comportamiento |
|---|---|---|
| Edificio (`BLDG #`) | Selector con búsqueda | Al elegir el código, **muestra el nombre del edificio automáticamente** (solo lectura). **Se recuerda del último registro.** |
| Nombre del edificio | Texto, solo lectura | Se toma de la tabla de edificios y se **guarda también en el registro** (copia, por si luego cambia la tabla). |
| Piso | Selector de lista fija | **Se recuerda del último registro.** |
| Departamento | Selector con búsqueda + "Nuevo" | **Se recuerda del último registro.** |
| Fotos | Lista de imágenes | Ilimitadas. Ver sección 5. |
| Notas | Texto libre multilínea | Opcional. |
| Notas de voz | Lista de audios | Ilimitadas. Ver sección 6. |
| Inspector | Texto | Se configura una vez en Ajustes y se agrega automáticamente a cada registro. |
| Campos automáticos | — | `id` (UUID v4), `seq` (número correlativo por dispositivo/jornada, visible como "Activo #127"), `created_at`, `updated_at` (ISO 8601 con zona horaria), `device_id` (UUID generado una vez por instalación), `app_version`. |
| GPS (opcional) | Lat/long/precisión | Desactivado por defecto; activable en Ajustes. No debe bloquear ni retrasar el guardado si no hay señal. |

### "Recordar del último registro"
- Edificio, piso y departamento se **precargan con los valores del último activo guardado** (persistidos en IndexedDB/localStorage, sobreviven a cerrar la app).
- Deben verse claramente en la parte superior del formulario como una **barra de contexto** (p. ej. `B-02 · Planta Norte | Piso 3 | Mantenimiento`), tocable para cambiar.

### Flujo ideal (rapidez)
1. Pantalla principal → botón grande **"+ Nuevo activo"**.
2. Formulario abre con el contexto precargado; foco en **"Tomar foto"**.
3. Tomar varias fotos seguidas, grabar una nota de voz si hace falta, escribir nota opcional.
4. **"Guardar y siguiente"** (guarda y abre un nuevo activo con el mismo contexto) y **"Guardar"** (vuelve a la lista).
5. Objetivo: registrar un activo típico en **< 30 segundos** y con el pulgar (botones grandes, zona inferior de la pantalla).

### Autoguardado
- El borrador del activo se guarda en IndexedDB **en cada cambio** (cada foto, audio o nota). Si la app se cierra, el navegador se recarga o el teléfono se reinicia, al volver se recupera el borrador. **Nunca perder una foto ya tomada.**

## 5. Fotos

- Dos botones dentro del activo:
  - **"Tomar foto"**: abre la cámara. Recomendado usar `<input type="file" accept="image/*" capture="environment">` porque usa la **cámara nativa** del teléfono (máxima calidad, enfoque, flash, HDR). Evaluar si conviene un modo de captura continua con `getUserMedia` para disparar varias seguidas sin salir de la app; si se implementa, que la calidad no sea inferior a la nativa (usar `ImageCapture.takePhoto()` cuando esté disponible). Si no es fiable, quedarse con la cámara nativa.
  - **"Agregar de galería"**: `<input type="file" accept="image/*" multiple>` para importar **capturas de pantalla** u otras imágenes existentes.
- Cada imagen guarda `source`: `"camera"` o `"gallery"` (las capturas de pantalla entran como `"gallery"`; si el nombre de archivo o dimensiones sugieren screenshot, marcar `is_screenshot: true` como pista, sin que sea crítico).
- **Calidad / tamaño** (ajuste global en Ajustes):
  - **Alta (por defecto):** redimensionar a **2.560 px en el lado largo**, JPEG calidad **0,90**. Corregir orientación EXIF antes de redimensionar (usar `createImageBitmap(file, { imageOrientation: 'from-image' })`).
  - **Original:** guardar el archivo tal cual, sin recomprimir.
  - Guardar en metadatos: ancho, alto, tamaño en bytes, fecha/hora de captura, y si fue redimensionada.
- Miniaturas: generar thumbnail pequeño (≈300 px) para la galería del activo y la lista, y así no cargar las fotos grandes en memoria.
- Vista de foto a pantalla completa con zoom; posibilidad de borrar (con confirmación) y reordenar es deseable pero no prioritario.
- La legibilidad de **placas de datos / etiquetas** es crítica: la IA posterior debe poder leer número de serie, marca, modelo, capacidades.

## 6. Notas de voz

- Botón **mantener pulsado para grabar** o **tocar para iniciar / tocar para detener** (implementar tocar-iniciar/detener como principal; es más cómodo con guantes o una mano ocupada).
- Usar `MediaRecorder`. Elegir el MIME soportado dinámicamente:
  - Android/Chrome: `audio/webm;codecs=opus`
  - iOS/Safari: `audio/mp4` (AAC)
  - Guardar la extensión correcta (`.webm` / `.m4a`) y el `mime_type` en metadatos.
- Mostrar temporizador mientras graba; duración en metadatos.
- Reproducir y borrar cada audio dentro del activo.
- Solicitar permiso de micrófono la primera vez con un mensaje explicativo.
- Guardar el audio en IndexedDB **apenas se detiene** la grabación (y idealmente en chunks con `timeslice` para no perder todo si la app se cierra a mitad).
- **Sin transcripción en el teléfono** (se hará en escritorio con Whisper). Opcional, si es trivial: un campo de texto "transcripción" vacío en el JSON para que el proceso de escritorio lo rellene.

## 7. Pantallas

1. **Inicio / Lista de activos**: lista de los activos registrados (más recientes arriba) con miniatura, `#seq`, edificio, piso, departamento, cantidad de fotos/audios y un fragmento de la nota. Filtros por edificio/piso/departamento y búsqueda por texto. Contador del día. Indicador de espacio usado y de "pendiente de exportar".
2. **Formulario de activo** (nuevo y edición).
3. **Exportar** (sección 8).
4. **Ajustes**: nombre del inspector, calidad de foto, GPS on/off, importar/editar edificios y departamentos, estado de almacenamiento persistente, versión de la app, borrar datos ya exportados.
5. **Ayuda corta**: cómo instalar la PWA y cómo exportar.

Diseño: limpio, alto contraste (uso en planta con mala luz o al sol), botones grandes, modo oscuro opcional. Mobile-first; en escritorio que al menos sea usable.

## 8. Exportación (salida para procesamiento con IA)

### Requisitos
- Exportar a **ZIP por lotes**, para no generar un ZIP gigante que agote la memoria. Opciones: por edificio, por rango de fechas, "solo no exportados", o en bloques de N activos / ~500 MB. Si un lote supera el límite, partirlo automáticamente en `parte_1`, `parte_2`…
- Marcar cada activo como `exported_at` tras exportarlo con éxito (sin borrarlo). Borrar datos exportados solo con acción explícita del usuario y doble confirmación.
- Además de la descarga, ofrecer **compartir** con la Web Share API (`navigator.share({ files })`) si está disponible, para enviar el ZIP a Google Drive, correo, etc.
- Generar el ZIP en streaming o lo más eficiente posible en memoria (fflate soporta streaming). Mostrar barra de progreso.
- **Respaldo completo**: opción de exportar *todo* (incluidos edificios, departamentos y ajustes) y **re-importar ese respaldo** en otro teléfono o tras reinstalar.

### Estructura del ZIP
```
inspeccion_{device_id8}_{YYYYMMDD-HHmm}_parte1.zip
├── manifest.json            # metadatos del lote
├── activos.csv              # una fila por activo (para abrir en Excel)
├── activos.json             # array con todos los activos del lote
├── edificios.csv            # tabla maestra usada
└── activos/
    ├── B-02_0127_3f9a1c2e/
    │   ├── activo.json
    │   ├── foto_01.jpg
    │   ├── foto_02.jpg
    │   ├── captura_01.png
    │   ├── audio_01.webm
    │   └── notas.txt
    └── …
```
- Nombre de carpeta: `{BLDG#}_{seq con 4 dígitos}_{primeros 8 caracteres del UUID}` (sanitizar caracteres no válidos en nombres de archivo).

### `activo.json` (esquema)
```json
{
  "schema_version": 1,
  "id": "3f9a1c2e-...",
  "seq": 127,
  "inspector": "Gabriel García",
  "device_id": "a1b2c3d4-...",
  "app_version": "1.0.0",
  "created_at": "2026-11-12T10:42:13-06:00",
  "updated_at": "2026-11-12T10:44:02-06:00",
  "building_code": "B-02",
  "building_name": "Planta de Producción Norte",
  "floor": "MEZZANINE 1",
  "department": "Mantenimiento",
  "notes": "Compresor con fuga de aceite, placa parcialmente legible",
  "gps": { "lat": null, "lon": null, "accuracy_m": null },
  "photos": [
    { "file": "foto_01.jpg", "source": "camera", "is_screenshot": false,
      "width": 2560, "height": 1920, "bytes": 1234567, "resized": true,
      "captured_at": "2026-11-12T10:42:20-06:00" }
  ],
  "audios": [
    { "file": "audio_01.webm", "mime_type": "audio/webm;codecs=opus",
      "duration_s": 14.2, "recorded_at": "2026-11-12T10:43:05-06:00",
      "transcript": null }
  ],
  "exported_at": null
}
```

### `activos.csv`
Columnas: `id, seq, inspector, created_at, building_code, building_name, floor, department, notes, n_photos, n_audios, folder`. UTF-8 **con BOM** (para que Excel muestre bien acentos).

## 9. Varios inspectores

- Cada teléfono guarda sus datos de forma independiente (no hay backend en v1).
- `id` UUID + `device_id` + `inspector` garantizan que al juntar ZIPs de varias personas en escritorio no haya choques.
- La numeración `seq` es por dispositivo; en el nombre de carpeta va acompañada del UUID para evitar colisiones.
- Debe ser posible distribuir la misma lista de edificios a todos (cada uno importa el mismo CSV, o se incluye un `edificios.csv` por defecto en el repo que se carga al primer inicio si la lista está vacía).

## 10. Requisitos no funcionales

- **Offline total** tras la primera carga: abrir la app en modo avión debe funcionar, incluido registrar, fotografiar, grabar y exportar.
- **Rendimiento:** con 300 activos y 1.500 fotos la lista debe seguir fluida (paginación o virtualización; cargar solo miniaturas).
- **Capacidad:** probar que con calidad "Alta" se pueden almacenar al menos ~2 GB en el S21 Ultra. Mostrar alerta si el espacio disponible estimado baja de un umbral (p. ej. < 1 GB o < 10 %).
- **Robustez:** manejo de errores visible (sin permisos de cámara/micrófono, sin espacio, IndexedDB bloqueado). Nunca fallar en silencio.
- **Privacidad:** ningún dato sale del teléfono salvo cuando el usuario exporta o comparte. Sin analítica ni llamadas a terceros.
- **Compatibilidad:** objetivo principal Chrome Android reciente. Debe funcionar razonablemente en Safari iOS 16.4+ instalada en pantalla de inicio (documentar sus límites: almacenamiento más restrictivo, audio en `audio/mp4`).
- **Accesibilidad básica:** tamaños táctiles ≥ 48 px, etiquetas legibles, contraste suficiente.

## 11. Despliegue en GitHub Pages

- Repositorio con la app en la raíz o en `/docs`, publicado con GitHub Pages.
- Todas las rutas **relativas** (la app vivirá en `https://usuario.github.io/nombre-repo/`, no en la raíz del dominio). Ojo con el `scope` y `start_url` del `manifest.webmanifest` y el registro del service worker.
- `manifest.webmanifest` con nombre ("Inspección de Activos"), íconos 192 y 512 px (incluir íconos *maskable*), `display: standalone`, colores de tema.
- Incluir un `README.md` con: cómo publicar en GitHub Pages paso a paso, cómo instalar la PWA en Android y en iPhone, cómo actualizar la versión (y forzar actualización del service worker), formato del CSV de edificios, y formato del ZIP exportado.
- Incluir `edificios_ejemplo.csv` con 5–10 edificios de prueba.

## 12. Fases de desarrollo

1. **Fase 1 — Esqueleto PWA:** estructura de carpetas, manifest, service worker, IndexedDB, Ajustes (inspector), importación de edificios CSV, publicación en GitHub Pages. ✅ Criterio: se instala en Android y abre en modo avión.
2. **Fase 2 — Registro básico:** formulario con edificio (nombre automático), piso, departamento (con "nuevo"), notas, "recordar último", autoguardado de borradores, lista de activos. ✅ Criterio: registrar 10 activos offline, cerrar y reabrir la app, todo sigue ahí con el contexto recordado.
3. **Fase 3 — Fotos:** cámara + galería (capturas), redimensionado con orientación correcta, miniaturas, visor. ✅ Criterio: 20 fotos en un activo, legibles al hacer zoom sobre una placa.
4. **Fase 4 — Audio:** grabación, reproducción, borrado, formatos Android/iOS. ✅ Criterio: grabar 5 audios en modo avión y reproducirlos tras reiniciar la app.
5. **Fase 5 — Exportación:** ZIP por lotes con la estructura de la sección 8, CSV con BOM, compartir, marcar exportados, respaldo completo y re-importación. ✅ Criterio: exportar 50 activos con fotos y abrir el ZIP en Windows sin errores; `activos.csv` abre bien en Excel.
6. **Fase 6 — Pulido y prueba de carga:** rendimiento con 300 activos / 1.500 fotos (se puede simular con datos generados), alertas de espacio, modo oscuro, README final.

En cada fase: probar en el navegador de escritorio con emulación móvil y documentar qué debe probarse manualmente en el S21 Ultra.

## 13. Fuera de alcance (v1)

- Transcripción de audio o análisis con IA dentro del teléfono.
- Backend, cuentas de usuario o sincronización en la nube automática.
- App nativa (Flutter/Kotlin) o publicación en Play Store / App Store.
- Lectura de códigos de barras/QR (posible v2).
- Campos estructurados del activo (marca, modelo, serie, capacidad): se extraerán después con IA a partir de fotos, audio y notas.

## 14. Posible v2 (no implementar ahora, pero no bloquear)

- Subida opcional de lotes a Google Drive / OneDrive cuando haya Wi‑Fi.
- Lector de código de barras / QR para etiquetas de activo.
- Script de escritorio (Python) que lea los ZIP, transcriba audios con Whisper y genere la base estructurada con IA de visión.
