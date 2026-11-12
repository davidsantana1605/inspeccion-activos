// Voice notes: recording (MediaRecorder with chunked persistence), list, playback, delete, orphan recovery.
// Blob contracts are frozen in data.js. Chunks use kind 'audiochunk' so mediaCounts/export ignore them.
import * as db from './db.js';
import { blobId, getMedia, deleteMedia, nowIso } from './data.js';

const TIMESLICE_MS = 2000;
const MIME_CANDIDATES = [
  ['audio/webm;codecs=opus', 'webm'],
  ['audio/webm', 'webm'],
  ['audio/mp4', 'm4a'],
  ['audio/ogg;codecs=opus', 'ogg']
];
const EXPLAINED_KEY = 'audio_mic_explained';

// recIds being recorded right now in this session; recovery must never touch them.
const activeRecIds = new Set();

const chunkId = (assetId, recId, n) => `audiochunk:${assetId}:${recId}:${String(n).padStart(6, '0')}`;

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const [mime, ext] of MIME_CANDIDATES) {
    try { if (MediaRecorder.isTypeSupported(mime)) return { mime, ext }; } catch (_) { /* try next */ }
  }
  // Browser supports MediaRecorder but reports none of ours: let it choose its default.
  return { mime: '', ext: 'webm' };
}

function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function errorMessage(e) {
  const name = e && e.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Permiso de micrófono denegado. Actívalo en los ajustes del navegador o del sistema para este sitio y vuelve a intentarlo.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No se encontró ningún micrófono en este dispositivo.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'El micrófono está en uso por otra aplicación o no se pudo abrir. Ciérrala e inténtalo de nuevo.';
  if (name === 'QuotaExceededError') return 'No hay espacio suficiente en el dispositivo para guardar la nota de voz. Exporta o borra registros y vuelve a intentarlo.';
  if (name === 'NotSupportedError' || name === 'TypeError') return 'Este navegador no puede grabar audio.';
  return `No se pudo completar la operación de audio${e && e.message ? ` (${e.message})` : ''}.`;
}

// Writes the final 'audio' record and deletes its chunk keys in ONE transaction.
// Only IndexedDB requests are issued inside the callback (no awaits on anything else).
async function commitAudio({ assetId, blob, mime, ext, durationS, recordedAt, order, chunkKeys }) {
  const uid = crypto.randomUUID();
  const record = {
    id: blobId('audio', assetId, uid), asset_id: assetId, kind: 'audio', uid, blob,
    mime_type: mime, ext, duration_s: durationS, recorded_at: recordedAt, transcript: null, order
  };
  await db.tx('blobs', 'readwrite', (s) => {
    s.put(record);
    for (const k of chunkKeys) s.delete(k);
  });
  return record;
}

export async function recoverOrphanAudio() {
  let chunks;
  try {
    chunks = await db.tx('blobs', 'readonly', (s) => new Promise((resolve, reject) => {
      const req = s.index('kind').getAll(IDBKeyRange.only('audiochunk'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  } catch (e) {
    console.error('recoverOrphanAudio: read failed', e);
    return 0;
  }
  const groups = new Map();
  for (const c of chunks) {
    if (activeRecIds.has(c.rec_id)) continue;
    const key = `${c.asset_id}|${c.rec_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  let recovered = 0;
  for (const list of groups.values()) {
    try {
      list.sort((a, b) => a.n - b.n);
      const first = list[0];
      const mime = first.mime_type || 'audio/webm';
      const blob = new Blob(list.map((c) => c.blob), { type: mime });
      const started = Date.parse(first.started_at);
      await commitAudio({
        assetId: first.asset_id, blob, mime, ext: first.ext || 'webm',
        durationS: list.length * (TIMESLICE_MS / 1000), // rough estimate (interrupted recording)
        recordedAt: first.started_at || nowIso(),
        order: Number.isFinite(started) ? started : Date.now(),
        chunkKeys: list.map((c) => c.id)
      });
      recovered++;
    } catch (e) {
      console.error('recoverOrphanAudio: group failed (chunks kept)', e);
    }
  }
  return recovered;
}

export async function mountAudio(el, asset) {
  const assetId = asset.id;
  let destroyed = false;
  let urls = [];
  let rec = null; // active recording session
  let starting = false;
  let timerId = null;

  el.textContent = '';
  const root = document.createElement('div');
  root.className = 'audio-box';
  const recordBtn = document.createElement('button');
  recordBtn.type = 'button';
  recordBtn.className = 'btn primary audio-rec-btn';
  recordBtn.textContent = '● Grabar nota de voz';
  const timerEl = document.createElement('div');
  timerEl.className = 'audio-timer';
  timerEl.setAttribute('role', 'timer');
  timerEl.setAttribute('aria-live', 'polite');
  timerEl.hidden = true;
  const noticeEl = document.createElement('div'); // explanation / confirmation prompts
  const errorEl = document.createElement('div');
  errorEl.className = 'audio-error';
  errorEl.setAttribute('role', 'alert');
  errorEl.hidden = true;
  const listEl = document.createElement('div');
  listEl.className = 'audio-list';
  root.append(recordBtn, timerEl, noticeEl, errorEl, listEl);
  el.append(root);

  const showError = (msg) => { if (destroyed) return; errorEl.textContent = msg; errorEl.hidden = !msg; };

  function revokeUrls() { urls.forEach((u) => URL.revokeObjectURL(u)); urls = []; }

  async function refresh() {
    if (destroyed) return;
    let items;
    try { items = await getMedia(assetId, 'audio'); } catch (e) { showError(errorMessage(e)); return; }
    if (destroyed) return;
    revokeUrls();
    listEl.textContent = '';
    if (!items.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Sin notas de voz.';
      listEl.append(p);
      return;
    }
    items.forEach((it, i) => listEl.append(renderItem(it, i + 1)));
  }

  function renderItem(it, num) {
    const card = document.createElement('div');
    card.className = 'card audio-item';
    const head = document.createElement('div');
    head.className = 'row audio-item-head';
    const title = document.createElement('strong');
    title.textContent = `Nota ${num}`;
    const meta = document.createElement('span');
    meta.className = 'muted';
    const t = new Date(it.recorded_at);
    const time = Number.isNaN(t.getTime()) ? '' : t.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    const dur = it.duration_s != null ? fmtTime(it.duration_s) : '--:--';
    meta.textContent = `${dur}${time ? ` · ${time}` : ''}`;
    head.append(title, meta);

    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.className = 'audio-player';
    const url = URL.createObjectURL(it.blob);
    urls.push(url);
    audio.src = url;
    audio.addEventListener('error', () => { showError('No se pudo reproducir esta nota de voz en este dispositivo.'); });

    const actions = document.createElement('div');
    actions.className = 'row audio-item-actions';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn danger';
    del.textContent = 'Borrar';
    del.addEventListener('click', () => {
      actions.textContent = '';
      const q = document.createElement('span');
      q.className = 'audio-confirm-text';
      q.textContent = '¿Borrar esta nota de voz?';
      const yes = document.createElement('button');
      yes.type = 'button'; yes.className = 'btn danger'; yes.textContent = 'Sí, borrar';
      const no = document.createElement('button');
      no.type = 'button'; no.className = 'btn'; no.textContent = 'Cancelar';
      no.addEventListener('click', () => { actions.textContent = ''; actions.append(del); });
      yes.addEventListener('click', async () => {
        yes.disabled = no.disabled = true;
        try { await deleteMedia(assetId, ['audio'], it.uid); showError(''); } catch (e) { showError(errorMessage(e)); }
        refresh();
      });
      actions.append(q, yes, no);
      yes.focus();
    });
    actions.append(del);
    card.append(head, audio, actions);
    return card;
  }

  function micAlreadyGranted() {
    return (async () => {
      try {
        if (navigator.permissions && navigator.permissions.query) {
          const st = await navigator.permissions.query({ name: 'microphone' });
          if (st.state === 'granted') return true;
        }
      } catch (_) { /* unsupported name (Safari/Firefox) */ }
      try { return localStorage.getItem(EXPLAINED_KEY) === '1'; } catch (_) { return false; }
    })();
  }

  function askExplanation() {
    return new Promise((resolve) => {
      noticeEl.textContent = '';
      const box = document.createElement('div');
      box.className = 'card audio-explain';
      const p = document.createElement('p');
      p.textContent = 'La app necesita el micrófono para grabar notas de voz. El navegador te pedirá permiso; tócalo en "Permitir". El audio se queda solo en este dispositivo.';
      const row = document.createElement('div');
      row.className = 'row';
      const ok = document.createElement('button');
      ok.type = 'button'; ok.className = 'btn primary'; ok.textContent = 'Entendido, continuar';
      const cancel = document.createElement('button');
      cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = 'Cancelar';
      const done = (v) => { noticeEl.textContent = ''; resolve(v); };
      ok.addEventListener('click', () => { try { localStorage.setItem(EXPLAINED_KEY, '1'); } catch (_) { /* ignore */ } done(true); });
      cancel.addEventListener('click', () => done(false));
      row.append(ok, cancel);
      box.append(p, row);
      noticeEl.append(box);
      ok.focus();
    });
  }

  function setRecordingUi(on) {
    if (destroyed) return;
    recordBtn.textContent = on ? '■ Detener' : '● Grabar nota de voz';
    recordBtn.classList.toggle('danger', on);
    recordBtn.classList.toggle('primary', !on);
    recordBtn.classList.toggle('audio-recording', on);
    timerEl.hidden = !on;
    if (!on) { clearInterval(timerId); timerId = null; }
  }

  async function startRecording() {
    if (rec || starting) return;
    starting = true;
    showError('');
    recordBtn.disabled = true;
    let stream = null;
    try {
      const picked = pickMime();
      if (!picked || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showError('Este navegador no soporta la grabación de audio (MediaRecorder).');
        return;
      }
      if (!(await micAlreadyGranted())) {
        if (destroyed || !(await askExplanation())) return;
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (destroyed) { stream.getTracks().forEach((t) => t.stop()); return; }
      const recorder = picked.mime ? new MediaRecorder(stream, { mimeType: picked.mime }) : new MediaRecorder(stream);
      const mime = picked.mime || recorder.mimeType || 'audio/webm';
      const ext = /mp4/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : 'webm';
      const session = {
        recId: crypto.randomUUID(), recorder, stream, mime, ext,
        startedAt: nowIso(), order: Date.now(), t0: 0,
        parts: [], n: 0, writes: [], persistFailed: null, failure: null, finalizing: null
      };
      activeRecIds.add(session.recId);

      recorder.ondataavailable = (ev) => {
        if (!ev.data || !ev.data.size) return;
        const n = session.n++;
        session.parts.push(ev.data); // memory copy so a failed chunk write never loses audio
        const record = {
          id: chunkId(assetId, session.recId, n), asset_id: assetId, kind: 'audiochunk', rec_id: session.recId,
          n, blob: ev.data, mime_type: mime, ext, started_at: session.startedAt
        };
        session.writes.push(db.put('blobs', record).catch((e) => { session.persistFailed = e; }));
      };
      recorder.onerror = (ev) => {
        session.failure = (ev && ev.error) || new Error('Error de grabación');
        try { if (recorder.state !== 'inactive') recorder.stop(); } catch (_) { /* already stopping */ }
      };
      session.stopped = new Promise((resolve) => { recorder.onstop = resolve; });

      recorder.start(TIMESLICE_MS);
      session.t0 = performance.now();
      rec = session;
      setRecordingUi(true);
      timerEl.textContent = '00:00';
      timerId = setInterval(() => { if (rec) timerEl.textContent = fmtTime((performance.now() - rec.t0) / 1000); }, 500);
      // Auto-finalize if the recorder stops by itself (error, track ended); keeps data and frees the mic.
      session.stopped.then(() => { finalize(session); });
    } catch (e) {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      showError(errorMessage(e));
    } finally {
      starting = false;
      if (!destroyed) recordBtn.disabled = false;
    }
  }

  // Idempotent: stops mic, waits for pending chunk writes, assembles and commits in one tx.
  function finalize(session) {
    if (session.finalizing) return session.finalizing;
    session.finalizing = (async () => {
      const durationS = (performance.now() - session.t0) / 1000;
      session.stream.getTracks().forEach((t) => t.stop());
      if (rec === session) { rec = null; setRecordingUi(false); }
      try {
        await session.stopped;
        await Promise.all(session.writes);
        if (!session.parts.length) {
          showError('La grabación quedó vacía; no se guardó ningún audio.');
          return;
        }
        const blob = new Blob(session.parts, { type: session.mime });
        const keys = [];
        for (let i = 0; i < session.n; i++) keys.push(chunkId(assetId, session.recId, i));
        await commitAudio({
          assetId, blob, mime: session.mime, ext: session.ext, durationS: Math.round(durationS * 10) / 10,
          recordedAt: session.startedAt, order: session.order, chunkKeys: keys
        });
        if (session.failure) showError('La grabación se interrumpió por un error, pero se guardó lo grabado hasta ese momento.');
      } catch (e) {
        showError(`${errorMessage(e)} Los fragmentos grabados se conservan y se intentarán recuperar al abrir la app de nuevo.`);
      } finally {
        activeRecIds.delete(session.recId);
        refresh();
      }
    })();
    return session.finalizing;
  }

  async function stopRecording() {
    const session = rec;
    if (!session) return;
    recordBtn.disabled = true;
    try { if (session.recorder.state !== 'inactive') session.recorder.stop(); } catch (_) { /* finalize handles it */ }
    await finalize(session);
    if (!destroyed) recordBtn.disabled = false;
  }

  recordBtn.addEventListener('click', () => { (rec ? stopRecording() : startRecording()); });

  // Page hidden while recording: intentionally do nothing (keep recording).

  await refresh();

  return {
    destroy() {
      destroyed = true;
      clearInterval(timerId);
      timerId = null;
      // Never discard audio: let an active recording finish saving in the background.
      if (rec) {
        const s = rec;
        rec = null;
        try { if (s.recorder.state !== 'inactive') s.recorder.stop(); } catch (_) { /* ignore */ }
        finalize(s);
      }
      revokeUrls();
      el.textContent = '';
    }
  };
}
