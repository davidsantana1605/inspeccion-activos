// Verifies every PRECACHE path in sw.js exists on disk with EXACT case (GitHub Pages is case-sensitive),
// that index.html assets are precached, and that sw.js VERSION matches js/version.js.
// Usage: node tools/check-precache.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sw = readFileSync(join(root, 'sw.js'), 'utf8');
let failed = false;
const fail = (m) => { console.error('FAIL ' + m); failed = true; };

const block = sw.match(/const PRECACHE = \[([\s\S]*?)\];/);
if (!block) { fail('PRECACHE not found in sw.js'); process.exit(1); }
const list = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

function existsExactCase(rel) {
  let dir = root;
  for (const part of rel.split('/').filter(Boolean)) {
    if (!readdirSync(dir).includes(part)) return false;
    dir = join(dir, part);
  }
  return existsSync(dir);
}
for (const p of list) {
  if (p === './') continue;
  if (!existsExactCase(p)) fail('missing or wrong case: ' + p);
}
if (!list.includes('./') || !list.includes('index.html')) fail("PRECACHE must include './' and 'index.html'");

// Every local asset referenced from index.html / manifest must be precached.
const html = readFileSync(join(root, 'index.html'), 'utf8');
for (const m of html.matchAll(/(?:href|src)="([^"#:]+)"/g)) {
  const ref = m[1];
  if (ref.startsWith('#') || ref.includes('//')) continue;
  if (!list.includes(ref)) fail('referenced in index.html but not precached: ' + ref);
}
const manifest = JSON.parse(readFileSync(join(root, 'manifest.webmanifest'), 'utf8'));
for (const i of manifest.icons) if (!list.includes(i.src)) fail('manifest icon not precached: ' + i.src);

// Static imports between modules must be precached too.
for (const p of list.filter((x) => x.endsWith('.js') && x.startsWith('js/'))) {
  const src = readFileSync(join(root, p), 'utf8');
  for (const m of src.matchAll(/from\s+'\.\/([^']+)'/g)) {
    const dep = 'js/' + m[1];
    if (!list.includes(dep)) fail(`${p} imports ${dep} which is not precached`);
  }
}

const swV = sw.match(/const VERSION = '([^']+)'/)?.[1];
const appV = readFileSync(join(root, 'js/version.js'), 'utf8').match(/APP_VERSION = '([^']+)'/)?.[1];
if (!swV || swV !== appV) fail(`version mismatch: sw.js=${swV} version.js=${appV}`);

if (failed) process.exit(1);
console.log(`OK: ${list.length} precache paths verified (case-exact), version ${swV}`);
