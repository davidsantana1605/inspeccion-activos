// Pure CSV helpers for the buildings list. No DOM, no IndexedDB.

// Decode bytes: UTF-8 (strict) first, then windows-1252 (Excel in Spanish locales saves ANSI).
export function decodeBytes(buffer) {
  let bytes = new Uint8Array(buffer);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch (_) {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

// Detect the delimiter from the header line, ignoring characters inside quotes.
export function detectDelimiter(text) {
  const nl = text.search(/\r\n|\r|\n/);
  const head = nl === -1 ? text : text.slice(0, nl);
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQ = false;
  for (const ch of head) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  let best = ',';
  for (const d of [';', '\t']) if (counts[d] > counts[best]) best = d;
  return best;
}

// RFC 4180 parser. Returns array of records (arrays of strings). Handles "" escapes and newlines in quotes.
export function parseRecords(text, delimiter) {
  const records = [];
  let rec = [];
  let field = '';
  let inQ = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQ = true; i++; continue; }
    if (ch === delimiter) { rec.push(field); field = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      rec.push(field); records.push(rec); rec = []; field = ''; i++; continue;
    }
    field += ch; i++;
  }
  if (inQ) throw new Error('Comillas sin cerrar en el CSV.');
  if (field !== '' || rec.length) { rec.push(field); records.push(rec); }
  return records;
}

const headerNorm = (s) => String(s).normalize('NFC').toLowerCase().replace(/[^a-z0-9]/g, '');
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const keyOf = (code) => clean(code).toUpperCase();

// ArrayBuffer in -> { rows:[{code,name}], duplicates:[{code,line}], errors:[string], delimiter, encoding }
export function parseBuildingsCsv(buffer) {
  const out = { rows: [], duplicates: [], errors: [], delimiter: ',', encoding: 'utf-8' };
  let decoded;
  try { decoded = decodeBytes(buffer); } catch (e) { out.errors.push('No se pudo leer el archivo: ' + e.message); return out; }
  out.encoding = decoded.encoding;
  const text = decoded.text.replace(/^﻿/, '');
  if (!text.trim()) { out.errors.push('El archivo está vacío.'); return out; }
  out.delimiter = detectDelimiter(text);
  let records;
  try { records = parseRecords(text, out.delimiter); } catch (e) { out.errors.push(e.message); return out; }
  // Skip leading blank records (and find header).
  let h = 0;
  while (h < records.length && records[h].every((c) => !clean(c))) h++;
  if (h >= records.length) { out.errors.push('El archivo está vacío.'); return out; }
  const header = records[h].map(headerNorm);
  const iCode = header.indexOf('bldg');
  const iName = header.indexOf('bldgname');
  if (iCode === -1 || iName === -1) {
    out.errors.push('Faltan encabezados. Se esperan exactamente las columnas "BLDG #" y "BLDG NAME".');
    return out;
  }
  const seen = new Map();
  for (let r = h + 1; r < records.length; r++) {
    const rec = records[r];
    if (rec.every((c) => !clean(c))) continue; // blank line or only trailing delimiters
    const line = r + 1;
    const code = clean(rec[iCode]);
    const name = clean(rec[iName]);
    if (!code) { out.errors.push(`Fila ${line}: falta el valor de BLDG #.`); continue; }
    if (!name) { out.errors.push(`Fila ${line}: falta el valor de BLDG NAME (${code}).`); continue; }
    const k = keyOf(code);
    if (seen.has(k)) { out.duplicates.push({ code, line, firstLine: seen.get(k) }); continue; }
    seen.set(k, line);
    out.rows.push({ code, name });
  }
  return out;
}

export function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\r\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Buildings -> CSV text with UTF-8 BOM, CRLF line endings (Excel-friendly).
export function buildingsToCsv(rows) {
  const lines = ['BLDG #,BLDG NAME', ...rows.map((r) => csvEscape(r.code) + ',' + csvEscape(r.name))];
  return '﻿' + lines.join('\r\n') + '\r\n';
}
