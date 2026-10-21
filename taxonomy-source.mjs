// Extracts the MCA taxonomy package (Final_C_and_I_Taxonomy_2016_V1.2.zip, kept as supplied) into
// .taxonomy/ (git-ignored) so the DTS loader can read it. Pure Node (zlib), no dependencies.
// v14.4: the C&I taxonomy that the MCA XBRL Validator downloads before it validates (Taxonomy-2016-03-31.zip, kept as
// supplied) carries an update not yet in the package published on the MCA website: the SRN type also accepts the MCA V3
// format (two letters + seven digits). Each taxonomy file of the published package that the validator's copy also has
// is taken from the validator's copy (today only IN-CA/in-ca-types-2016-03-31.xsd differs); the validator's copy also
// carries the standard XBRL specification schemas, which are not part of the C&I taxonomy and are not used.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const TAXONOMY_ZIP = path.join(ROOT, 'Final_C_and_I_Taxonomy_2016_V1.2.zip');
export const VALIDATOR_TAXONOMY_ZIP = path.join(ROOT, 'Taxonomy-2016-03-31.zip');
export const TAXONOMY_DIR = path.join(ROOT, '.taxonomy');
export const TAXONOMY_ROOT = path.join(TAXONOMY_DIR, 'Taxonomy-2016-03-31');
const MARKER = path.join(TAXONOMY_DIR, '.validator-update');

// every file of a zip: [{ name, data }]
export function zipEntries(buf, label = 'Taxonomy zip') {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error(`${label}: end of central directory not found`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`${label}: bad central directory`);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen).replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (name.split('/').includes('..') || name.startsWith('/')) throw new Error(`${label}: unsafe path ${name}`);
    const lnlen = buf.readUInt16LE(local + 26), lxlen = buf.readUInt16LE(local + 28);
    const raw = buf.subarray(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize);
    if (method !== 0 && method !== 8) throw new Error(`${label}: unsupported compression ${method} for ${name}`);
    out.push({ name, data: method === 0 ? raw : inflateRawSync(raw) });
  }
  return out;
}

// the files of the published package replaced by the validator's copy: [{ file, bytes }] (relative to TAXONOMY_ROOT)
export function validatorUpdates() {
  if (!existsSync(VALIDATOR_TAXONOMY_ZIP)) return [];
  const updated = [];
  for (const { name, data } of zipEntries(readFileSync(VALIDATOR_TAXONOMY_ZIP), 'Validator taxonomy zip')) {
    const rel = name.replace(/^Taxonomy-2016-03-31\//, '');
    const target = path.join(TAXONOMY_ROOT, rel);
    if (!existsSync(target)) continue; // not part of the published C&I taxonomy (XBRL specification schemas)
    if (Buffer.compare(readFileSync(target), data) === 0) continue;
    writeFileSync(target, data);
    updated.push({ file: rel, bytes: data.length });
  }
  return updated;
}

export function ensureTaxonomy() {
  const stamp = existsSync(VALIDATOR_TAXONOMY_ZIP) ? String(readFileSync(VALIDATOR_TAXONOMY_ZIP).length) : 'none';
  if (existsSync(path.join(TAXONOMY_ROOT, 'in-ci-ent-2016-03-31.xsd')) && existsSync(MARKER)
    && JSON.parse(readFileSync(MARKER, 'utf8')).stamp === stamp) return TAXONOMY_ROOT;
  rmSync(TAXONOMY_DIR, { recursive: true, force: true }); // an older extraction without the validator update
  for (const { name, data } of zipEntries(readFileSync(TAXONOMY_ZIP))) {
    const out = path.join(TAXONOMY_DIR, name);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, data);
  }
  const updated = validatorUpdates();
  writeFileSync(MARKER, JSON.stringify({ stamp, updated }, null, 1));
  return TAXONOMY_ROOT;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  ensureTaxonomy();
  console.log(readFileSync(MARKER, 'utf8'));
}
