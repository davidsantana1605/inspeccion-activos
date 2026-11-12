// Photo capture, processing, thumbnail grid and full-screen viewer for one asset.
// Contract: see js/data.js (blob records 'photo' / 'thumb'). Never writes the asset record.
import * as db from './db.js';
import { nowIso, blobId, getMedia, deleteMedia } from './data.js';

const MAX_SIDE_ALTA = 2560;
const THUMB_SIDE = 300;
const MAX_SCALE = 8;

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heif', 'image/gif': 'gif', 'image/avif': 'avif'
};

function extFor(file) {
  const t = (file.type || '').toLowerCase();
  if (MIME_EXT[t]) return MIME_EXT[t];
  const m = /\.([a-z0-9]{2,5})$/i.exec(file.name || '');
  return m ? m[1].toLowerCase() : 'jpg';
}

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of kids) if (c) e.append(c);
  return e;
}

function fmtBytes(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

// ---- Image processing (all async work happens here, never inside an IDB transaction) ----

async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    // Some browsers reject the options bag; retry plain (they usually honor EXIF by default).
    return await createImageBitmap(file);
  }
}

async function renderJpeg(bitmap, w, h, quality) {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    return c.convertToBlob({ type: 'image/jpeg', quality });
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
  c.width = c.height = 0;
  if (!blob) throw new Error('toBlob devolvió null');
  return blob;
}

function fitSize(w, h, maxSide) {
  const k = maxSide / Math.max(w, h);
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

// Returns the two records ready to be written. Does not touch IndexedDB.
async function buildRecords(file, assetId, source, quality) {
  if (file.type && !file.type.startsWith('image/')) {
    const e = new Error('not-image'); e.code = 'not-image'; throw e;
  }
  let bitmap;
  try { bitmap = await decode(file); } catch (e) { const x = new Error('decode'); x.code = 'decode'; x.cause = e; throw x; }
  try {
    let blob = file, width = bitmap.width, height = bitmap.height, resized = false;
    let mime = file.type || MIME_EXT[extFor(file)] || 'image/jpeg', ext = extFor(file);
    if (quality === 'alta' && Math.max(width, height) > MAX_SIDE_ALTA) {
      const s = fitSize(width, height, MAX_SIDE_ALTA);
      blob = await renderJpeg(bitmap, s.w, s.h, 0.90);
      width = s.w; height = s.h; resized = true; mime = 'image/jpeg'; ext = 'jpg';
    }
    const ts = Math.max(width, height) > THUMB_SIDE ? fitSize(width, height, THUMB_SIDE) : { w: width, h: height };
    const thumbBlob = await renderJpeg(bitmap, ts.w, ts.h, 0.7);

    const name = file.name || '';
    const isShot = source === 'gallery' && (/screenshot|captura|screen/i.test(name) || file.type === 'image/png');
    const captured = file.lastModified ? nowIso(new Date(file.lastModified)) : nowIso();
    const uid = crypto.randomUUID();
    const order = Date.now();
    return {
      uid,
      photo: {
        id: blobId('photo', assetId, uid), asset_id: assetId, kind: 'photo', uid, blob, mime_type: mime, ext,
        source, is_screenshot: isShot, width, height, bytes: blob.size, resized, captured_at: captured, order
      },
      // `order` on the thumb is an additive field so the grid can sort thumbs without loading photo records.
      thumb: { id: blobId('thumb', assetId, uid), asset_id: assetId, kind: 'thumb', uid, blob: thumbBlob, mime_type: 'image/jpeg', order }
    };
  } finally {
    try { bitmap.close(); } catch (_) { /* noop */ }
  }
}

function errorMessage(err, name) {
  const n = name ? `"${name}": ` : '';
  if (err && err.code === 'not-image') return `${n}el archivo no es una imagen.`;
  if (err && err.code === 'decode') return `${n}no se pudo leer la imagen (formato no compatible o archivo dañado).`;
  const nm = err && err.name;
  if (nm === 'QuotaExceededError' || (err && /quota/i.test(err.message || ''))) {
    return `${n}no hay espacio suficiente en el dispositivo. Libere espacio o exporte y borre activos ya enviados.`;
  }
  return `${n}no se pudo guardar la foto (${(err && (err.message || err.name)) || 'error desconocido'}).`;
}

// ---- Public API ----

export async function mountPhotos(el, asset, { quality = 'alta' } = {}) {
  const assetId = asset.id;
  let destroyed = false;
  let items = [];          // [{uid, order, url}]
  let queue = Promise.resolve();
  let batchTotal = 0, batchDone = 0;
  const errors = [];

  el.textContent = '';
  const root = h('div', { class: 'ph-root' });
  const camInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'sr', id: `ph-cam-${assetId}`, 'aria-label': 'Tomar foto' });
  const galInput = h('input', { type: 'file', accept: 'image/*', multiple: '', class: 'sr', id: `ph-gal-${assetId}`, 'aria-label': 'Agregar fotos de galería' });
  const btnCam = h('button', { type: 'button', class: 'btn primary', text: 'Tomar foto', onclick: () => camInput.click() });
  const btnGal = h('button', { type: 'button', class: 'btn', text: 'Agregar de galería', onclick: () => galInput.click() });
  const actions = h('div', { class: 'row ph-actions' }, btnCam, btnGal, camInput, galInput);
  const countEl = h('p', { class: 'muted ph-count', 'aria-live': 'polite' });
  const statusEl = h('p', { class: 'ph-status', role: 'status', 'aria-live': 'polite' });
  statusEl.hidden = true;
  const errBox = h('div', { class: 'ph-errors', role: 'alert' });
  const grid = h('div', { class: 'ph-grid' });
  root.append(actions, countEl, statusEl, errBox, grid);

  // ---- Viewer ----
  const dlg = h('dialog', { class: 'ph-viewer', 'aria-label': 'Visor de fotos' });
  const stage = h('div', { class: 'ph-stage' });
  const img = h('img', { class: 'ph-img', alt: 'Foto del activo', draggable: 'false' });
  stage.append(img);
  const vTitle = h('span', { class: 'ph-vtitle' });
  const btnClose = h('button', { type: 'button', class: 'btn ph-vbtn', text: 'Cerrar', 'aria-label': 'Cerrar visor' });
  const top = h('div', { class: 'ph-vbar ph-vtop' }, vTitle, btnClose);
  const btnPrev = h('button', { type: 'button', class: 'btn ph-vbtn', text: '‹ Anterior', 'aria-label': 'Foto anterior' });
  const btnNext = h('button', { type: 'button', class: 'btn ph-vbtn', text: 'Siguiente ›', 'aria-label': 'Foto siguiente' });
  const btnZoomOut = h('button', { type: 'button', class: 'btn ph-vbtn', text: '−', 'aria-label': 'Alejar' });
  const btnZoomIn = h('button', { type: 'button', class: 'btn ph-vbtn', text: '+', 'aria-label': 'Acercar' });
  const btnReset = h('button', { type: 'button', class: 'btn ph-vbtn', text: '1:1', 'aria-label': 'Restablecer zoom' });
  const btnDel = h('button', { type: 'button', class: 'btn danger ph-vbtn', text: 'Borrar' });
  const bottom = h('div', { class: 'ph-vbar ph-vbottom' }, btnPrev, btnZoomOut, btnReset, btnZoomIn, btnNext, btnDel);
  const vMsg = h('p', { class: 'ph-vmsg', role: 'status' });
  vMsg.hidden = true;
  const confirmBox = h('div', { class: 'ph-confirm', role: 'alertdialog', 'aria-label': 'Confirmar borrado' });
  const btnConfirmYes = h('button', { type: 'button', class: 'btn danger', text: 'Sí, borrar' });
  const btnConfirmNo = h('button', { type: 'button', class: 'btn', text: 'Cancelar' });
  confirmBox.append(h('p', { text: '¿Borrar esta foto? No se puede deshacer.' }), h('div', { class: 'row' }, btnConfirmNo, btnConfirmYes));
  confirmBox.hidden = true;
  dlg.append(top, stage, vMsg, bottom, confirmBox);
  root.append(dlg);
  el.append(root);

  let curIndex = -1;
  let fullUrl = null;
  let loadToken = 0;
  let scale = 1, tx = 0, ty = 0;

  function applyTransform() {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }
  function clamp() {
    if (scale <= 1) { scale = 1; tx = 0; ty = 0; return; }
    const mx = Math.max(0, (img.offsetWidth * scale - stage.clientWidth) / 2);
    const my = Math.max(0, (img.offsetHeight * scale - stage.clientHeight) / 2);
    tx = Math.min(mx, Math.max(-mx, tx));
    ty = Math.min(my, Math.max(-my, ty));
  }
  // Zoom keeping the point (px, py), relative to the stage centre, fixed.
  function zoomAt(newScale, px = 0, py = 0) {
    const ns = Math.min(MAX_SCALE, Math.max(1, newScale));
    const k = ns / scale;
    tx = px - (px - tx) * k;
    ty = py - (py - ty) * k;
    scale = ns;
    clamp();
    applyTransform();
  }
  function resetZoom() { scale = 1; tx = 0; ty = 0; applyTransform(); }
  const centerOf = (cx, cy) => {
    const r = stage.getBoundingClientRect();
    return { x: cx - (r.left + r.width / 2), y: cy - (r.top + r.height / 2) };
  };

  // Pointer gestures
  const pointers = new Map();
  let lastDist = 0, lastMid = null, downInfo = null, lastTap = { t: 0, x: 0, y: 0 };
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      downInfo = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
      lastMid = { x: e.clientX, y: e.clientY };
    } else if (pointers.size === 2) {
      downInfo = null;
      const [a, b] = [...pointers.values()];
      lastDist = Math.hypot(a.x - b.x, a.y - b.y);
      lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (lastDist > 0) {
        tx += mid.x - lastMid.x; ty += mid.y - lastMid.y;
        const c = centerOf(mid.x, mid.y);
        zoomAt(scale * (dist / lastDist), c.x, c.y);
      }
      lastDist = dist; lastMid = mid;
    } else if (pointers.size === 1) {
      if (downInfo && Math.hypot(e.clientX - downInfo.x, e.clientY - downInfo.y) > 10) downInfo.moved = true;
      if (scale > 1 && lastMid) {
        tx += e.clientX - lastMid.x; ty += e.clientY - lastMid.y;
        clamp(); applyTransform();
      }
      lastMid = { x: e.clientX, y: e.clientY };
    }
  });
  const endPointer = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size === 1) {
      const [p] = [...pointers.values()];
      lastMid = { x: p.x, y: p.y }; lastDist = 0;
    }
    if (pointers.size === 0 && downInfo && e.type === 'pointerup' && !downInfo.moved && Date.now() - downInfo.t < 300) {
      const now = Date.now();
      if (now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        const c = centerOf(e.clientX, e.clientY);
        if (scale > 1.05) { resetZoom(); } else { zoomAt(3, c.x, c.y); }
        lastTap = { t: 0, x: 0, y: 0 };
      } else {
        lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
    }
    if (pointers.size === 0) downInfo = null;
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const c = centerOf(e.clientX, e.clientY);
    zoomAt(scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2), c.x, c.y);
  }, { passive: false });
  btnZoomIn.addEventListener('click', () => zoomAt(scale * 1.5));
  btnZoomOut.addEventListener('click', () => zoomAt(scale / 1.5));
  btnReset.addEventListener('click', resetZoom);

  function hideConfirm() { confirmBox.hidden = true; }
  function setVMsg(text) { vMsg.textContent = text || ''; vMsg.hidden = !text; }

  async function showPhoto(i) {
    if (i < 0 || i >= items.length) return;
    curIndex = i;
    const it = items[i];
    const token = ++loadToken;
    hideConfirm(); setVMsg('');
    resetZoom();
    vTitle.textContent = `Foto ${i + 1} de ${items.length}`;
    btnPrev.disabled = i === 0;
    btnNext.disabled = i === items.length - 1;
    // Show the thumbnail instantly while the full image loads.
    img.src = it.url;
    try {
      const rec = await db.get('blobs', blobId('photo', assetId, it.uid));
      if (destroyed || token !== loadToken) return;
      if (!rec || !rec.blob) { setVMsg('No se encontró la foto original en el dispositivo.'); return; }
      const old = fullUrl;
      fullUrl = URL.createObjectURL(rec.blob);
      img.src = fullUrl;
      if (old) URL.revokeObjectURL(old);
      vTitle.textContent = `Foto ${i + 1} de ${items.length} · ${rec.width}×${rec.height} · ${fmtBytes(rec.bytes || rec.blob.size)}`;
    } catch (e) {
      if (!destroyed && token === loadToken) setVMsg('No se pudo cargar la foto grande: ' + (e.message || e.name));
    }
  }
  function openViewer(i) {
    if (!dlg.open) dlg.showModal();
    showPhoto(i);
  }
  function closeViewer() {
    if (dlg.open) dlg.close();
  }
  dlg.addEventListener('close', () => {
    loadToken++;
    img.removeAttribute('src');
    if (fullUrl) { URL.revokeObjectURL(fullUrl); fullUrl = null; }
    hideConfirm(); setVMsg(''); resetZoom(); curIndex = -1;
  });
  btnClose.addEventListener('click', closeViewer);
  btnPrev.addEventListener('click', () => showPhoto(curIndex - 1));
  btnNext.addEventListener('click', () => showPhoto(curIndex + 1));
  btnDel.addEventListener('click', () => { confirmBox.hidden = false; btnConfirmNo.focus(); });
  btnConfirmNo.addEventListener('click', hideConfirm);
  btnConfirmYes.addEventListener('click', async () => {
    const it = items[curIndex];
    if (!it) return;
    btnConfirmYes.disabled = true;
    try {
      await deleteMedia(assetId, ['photo', 'thumb'], it.uid);
      const was = curIndex;
      await refresh();
      if (destroyed) return;
      hideConfirm();
      if (!items.length) closeViewer();
      else showPhoto(Math.min(was, items.length - 1));
    } catch (e) {
      hideConfirm();
      setVMsg('No se pudo borrar la foto: ' + (e.message || e.name));
    } finally {
      btnConfirmYes.disabled = false;
    }
  });

  // ---- Grid ----
  function revokeAll() { for (const it of items) URL.revokeObjectURL(it.url); }

  function renderGrid() {
    grid.textContent = '';
    items.forEach((it, i) => {
      const b = h('button', { type: 'button', class: 'ph-thumb', 'aria-label': `Abrir foto ${i + 1} de ${items.length}`, onclick: () => openViewer(i) });
      const im = h('img', { src: it.url, alt: `Foto ${i + 1}`, loading: 'lazy', draggable: 'false' });
      b.append(im, h('span', { class: 'ph-num', text: String(i + 1) }));
      grid.append(b);
    });
    countEl.textContent = items.length === 0 ? 'Sin fotos todavía.' : items.length === 1 ? '1 foto' : `${items.length} fotos`;
  }

  async function refresh() {
    let recs;
    try { recs = await getMedia(assetId, 'thumb'); }
    catch (e) { addError('No se pudieron leer las fotos guardadas: ' + (e.message || e.name)); return; }
    if (destroyed) return;
    const old = items;
    items = recs.map((r) => ({ uid: r.uid, order: r.order ?? 0, url: URL.createObjectURL(r.blob) }));
    items.sort((a, b) => a.order - b.order);
    renderGrid();
    for (const it of old) URL.revokeObjectURL(it.url);
  }

  // ---- Errors / status ----
  function renderErrors() {
    errBox.textContent = '';
    for (const msg of errors) {
      errBox.append(h('div', { class: 'ph-error' },
        h('span', { text: msg }),
        h('button', { type: 'button', class: 'btn ph-dismiss', text: 'Cerrar', 'aria-label': 'Descartar mensaje', onclick: () => { errors.splice(errors.indexOf(msg), 1); renderErrors(); } })));
    }
  }
  function addError(msg) { errors.push(msg); renderErrors(); }
  function renderStatus(current) {
    if (current) { statusEl.textContent = `Procesando ${current}/${batchTotal}…`; statusEl.hidden = false; }
    else { statusEl.textContent = ''; statusEl.hidden = true; }
  }

  // ---- Intake queue (strictly sequential) ----
  async function processOne(file, source) {
    try {
      const { photo, thumb } = await buildRecords(file, assetId, source, quality);
      if (destroyed) return;
      // The IDB transaction only issues requests; every await on other APIs happened above.
      await db.tx('blobs', 'readwrite', (s) => { s.put(photo); s.put(thumb); });
    } catch (e) {
      addError(errorMessage(e, file.name));
    }
  }
  function enqueue(files, source) {
    if (!files.length) return;
    batchTotal += files.length;
    for (const f of files) {
      queue = queue.then(async () => {
        if (destroyed) return;
        batchDone++;
        renderStatus(batchDone);
        await processOne(f, source);
        await refresh();
      }).catch((e) => addError(errorMessage(e, f.name)));
    }
    queue = queue.then(() => {
      if (batchDone >= batchTotal) { batchDone = 0; batchTotal = 0; if (!destroyed) renderStatus(0); }
    });
  }
  function onPick(source) {
    return (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      enqueue(files, source);
    };
  }
  camInput.addEventListener('change', onPick('camera'));
  galInput.addEventListener('change', onPick('gallery'));

  await refresh();
  if (!items.length) renderGrid();

  return {
    destroy() {
      destroyed = true;
      try { if (dlg.open) dlg.close(); } catch (_) { /* noop */ }
      if (fullUrl) { URL.revokeObjectURL(fullUrl); fullUrl = null; }
      revokeAll(); items = [];
      el.textContent = '';
    }
  };
}
