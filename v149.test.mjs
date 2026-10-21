// v14.9: workspace folder (save with backups, version stamp, newer-elsewhere check, XML, listing) and compare.
// The folder is an in-memory stand-in for the browser's File System Access API (the browser smoke uses the real one).
import test from 'node:test';
import assert from 'node:assert/strict';
import { authority, q, importSession } from './helpers.mjs';
import { Session } from './session.js';
import { Filing } from './model.js';
import { buildExample } from './example.js';
import { projectPath, targetPath, filingKey, fyLabel, stampProject, saveToWorkspace, saveXmlToWorkspace, listWorkspace, readWorkspaceFile, readWorkspaceProject, newerElsewhere, BACKUPS_KEPT } from './workspace.js';
import { compareFilings } from './compare.js';

class MemDir {
  constructor(name = 'root') { this.kind = 'directory'; this.name = name; this.entries = new Map(); }
  async getDirectoryHandle(n, { create = false } = {}) {
    let e = this.entries.get(n);
    if (!e) { if (!create) throw Object.assign(new Error('NotFound'), { name: 'NotFoundError' }); e = new MemDir(n); this.entries.set(n, e); }
    if (e.kind !== 'directory') throw new Error('TypeMismatch');
    return e;
  }
  async getFileHandle(n, { create = false } = {}) {
    let e = this.entries.get(n);
    if (!e) { if (!create) throw Object.assign(new Error('NotFound'), { name: 'NotFoundError' }); e = new MemFile(n); this.entries.set(n, e); }
    if (e.kind !== 'file') throw new Error('TypeMismatch');
    return e;
  }
  async *values() { for (const e of this.entries.values()) yield e; }
  async removeEntry(n) { if (!this.entries.delete(n)) throw new Error('NotFound'); }
}
class MemFile {
  constructor(name) { this.kind = 'file'; this.name = name; this.data = ''; }
  async getFile() { const d = this.data; return { text: async () => d, size: d.length }; }
  async createWritable() { let buf = ''; const f = this; return { write: async (t) => { buf += t; }, close: async () => { f.data = buf; } }; }
}

const A = authority();
const today = '2025-09-30';
const example = () => { const s = new Session(A); buildExample(s); s.setMeta({ name: 'Example Traders Private Limited', cin: 'U99999MH2000PTC999999' }); return s; };
const at = (h, m = 0) => new Date(2026, 9, 20, h, m);
const files = (d) => [...d.entries.keys()].sort();

test('folder and file names follow the company, CIN, year and report type', () => {
  const m = example().filing.meta;
  assert.equal(fyLabel(m), '2016-17');
  assert.deepEqual(projectPath(m), { company: 'Example Traders Private Limited (U99999MH2000PTC999999)', year: 'FY 2016-17', base: 'Example_Traders_Private_Limited_2016-17_Standalone', file: 'Example_Traders_Private_Limited_2016-17_Standalone.mca-ci.json' });
  // characters a folder name cannot have are replaced
  assert.equal(projectPath({ ...m, name: 'A/B: C* "D" <E>?' }).company, 'A B C D E (U99999MH2000PTC999999)');
});

test('the version stamp: saved when, on which laptop, version number', () => {
  const json = example().filing.toJSON();
  const s1 = stampProject(json, { device: 'LAPTOP-1', build: 'b1', now: at(10) });
  assert.deepEqual([s1.n, s1.device], [1, 'LAPTOP-1']);
  const s2 = stampProject(json, { device: 'LAPTOP-2', now: at(11) });
  assert.deepEqual([s2.n, s2.device, s2.at], [2, 'LAPTOP-2', at(11).toISOString()]);
  // the stamp survives opening the project
  const f = Filing.fromJSON(A, JSON.parse(JSON.stringify(json)));
  assert.equal(f.meta.lastSaved.n, 2);
});

test('saving: the project in its folder, the previous version in backups (last 10 kept)', async () => {
  const root = new MemDir();
  const s = example();
  let r = await saveToWorkspace(root, s.filing.toJSON(), { device: 'LAPTOP-1', now: at(9) });
  assert.equal(r.status, 'saved');
  assert.equal(r.backedUp, null, 'nothing to back up the first time');
  const fy = root.entries.get('Example Traders Private Limited (U99999MH2000PTC999999)').entries.get('FY 2016-17');
  assert.deepEqual(files(fy), ['Example_Traders_Private_Limited_2016-17_Standalone.mca-ci.json']);
  let base = r.lastSaved;
  for (let i = 1; i <= 12; i++) {
    const json = s.filing.toJSON(); json.meta.lastSaved = base;
    r = await saveToWorkspace(root, json, { base, device: 'LAPTOP-1', now: at(9, i) });
    assert.equal(r.status, 'saved', `save ${i}`);
    base = r.lastSaved;
  }
  assert.equal(base.n, 13);
  const bk = fy.entries.get('backups');
  assert.equal(files(bk).length, BACKUPS_KEPT);
  assert.equal(files(bk).at(-1), 'Example_Traders_Private_Limited_2016-17_Standalone_2026-10-20_0911_v12.mca-ci.json', 'the version before the last save');
  assert.equal(files(bk)[0], 'Example_Traders_Private_Limited_2016-17_Standalone_2026-10-20_0902_v3.mca-ci.json', 'the oldest ones are removed');
  const opened = JSON.parse(await readWorkspaceFile(root, ['Example Traders Private Limited (U99999MH2000PTC999999)', 'FY 2016-17'], 'Example_Traders_Private_Limited_2016-17_Standalone.mca-ci.json'));
  assert.equal(opened.meta.lastSaved.n, 13);
});

test('two laptops: a save over a newer version saved on the other laptop is stopped until confirmed; nothing is lost', async () => {
  const root = new MemDir();
  const s = example();
  const first = await saveToWorkspace(root, s.filing.toJSON(), { device: 'LAPTOP-1', now: at(9) });
  // laptop 2 opens it (base v1), changes and saves → v2
  const l2 = Filing.fromJSON(A, JSON.parse(await readWorkspaceFile(root, [first.path.company, first.path.year], first.path.file)));
  const l2base = l2.meta.lastSaved;
  const two = await saveToWorkspace(root, l2.toJSON(), { base: l2base, device: 'LAPTOP-2', now: at(10) });
  assert.equal(two.lastSaved.n, 2);
  // laptop 1 still has v1 open and saves
  const stale = await saveToWorkspace(root, s.filing.toJSON(), { base: first.lastSaved, device: 'LAPTOP-1', now: at(11) });
  assert.equal(stale.status, 'newer');
  assert.deepEqual([stale.other.n, stale.other.device], [2, 'LAPTOP-2']);
  const now = await readWorkspaceProject(root, s.filing.meta);
  assert.equal(now.lastSaved.device, 'LAPTOP-2', 'the newer version is untouched');
  assert.deepEqual(newerElsewhere(first.lastSaved, now.lastSaved).newer, true);
  // confirmed: saved, laptop 2's version kept in backups
  const forced = await saveToWorkspace(root, s.filing.toJSON(), { base: first.lastSaved, force: true, device: 'LAPTOP-1', now: at(11) });
  assert.equal(forced.status, 'saved');
  assert.match(forced.backedUp, /_2026-10-20_1000_v2\.mca-ci\.json$/);
  // a project not opened from the workspace (base null) over an existing file: also asked first
  assert.equal((await saveToWorkspace(root, s.filing.toJSON(), { device: 'LAPTOP-3', now: at(12) })).status, 'newer');
});

test('generated XML: numbered in xml/, the project it came from kept in backups; the listing shows every filing', async () => {
  const root = new MemDir();
  const s = example();
  const json = s.filing.toJSON();
  const r = await saveToWorkspace(root, json, { device: 'LAPTOP-1', now: at(9) });
  const xml = s.exportXml({ today }).xml;
  const x1 = await saveXmlToWorkspace(root, json, xml, { now: at(9, 5) });
  const x2 = await saveXmlToWorkspace(root, json, xml, { withErrors: true, now: at(9, 6) });
  assert.deepEqual([x1.file, x2.file], ['U99999MH2000PTC999999_Standalone_2017-03-31_v1_2026-10-20.xml', 'U99999MH2000PTC999999_Standalone_2017-03-31_v2_2026-10-20_WITH-ERRORS.xml']);
  assert.equal(x1.snapshot, 'Example_Traders_Private_Limited_2016-17_Standalone_v1_for-XML-v1.mca-ci.json');
  assert.equal(await readWorkspaceFile(root, [r.path.company, r.path.year], x1.file, 'xml'), xml);
  // a second company / a consolidated filing
  const c = example(); c.setMeta({ reportType: 'Consolidated' });
  await saveToWorkspace(root, c.filing.toJSON(), { device: 'LAPTOP-2', now: at(10) });
  const list = await listWorkspace(root);
  assert.deepEqual(list.map((x) => [x.name, x.fy, x.reportType, x.lastSaved.n, x.lastSaved.device, x.xml.length, x.backups.length]),
    [['Example Traders Private Limited', '2016-17', 'Consolidated', 1, 'LAPTOP-2', 0, 0], ['Example Traders Private Limited', '2016-17', 'Standalone', 1, 'LAPTOP-1', 2, 2]]);
});

test('compare: values, text, dates, settings and footnotes that differ — and nothing for the same filing', () => {
  const a = example();
  const b = new Session(A, Filing.fromJSON(A, JSON.parse(JSON.stringify(a.filing.toJSON()))));
  assert.equal(compareFilings(A, a.filing, b.filing).counts.total, 0);
  const num = a.filing.all().find((f) => A.dataType(f.concept) === 'monetary' && !f.nil && !f.dims.length && f.origin !== 'calculated' && a.filing.scopeOf(f.period) === 'CY');
  b.filing.setFact({ ...num, value: String(Number(num.value) + 1000) });
  b.setMeta({ name: 'Example Traders Pvt Ltd' });
  const tb = a.filing.all().find((f) => A.dataType(f.concept) === 'textBlock' && !f.nil);
  b.filing.setFact({ ...tb, value: tb.value.replace(/^<p>/, '<p class="header5">') === tb.value ? `<p class="header5">${tb.value}</p>` : tb.value.replace(/^<p>/, '<p class="header5">') });
  const gone = a.filing.all().find((f) => A.dataType(f.concept) === 'date' && !f.nil);
  b.filing.removeFact(gone.key);
  const r = compareFilings(A, a.filing, b.filing);
  assert.deepEqual(r.meta.map((x) => [x.label, x.a, x.b]), [['Company name', 'Example Traders Private Limited', 'Example Traders Pvt Ltd']]);
  const ch = r.facts.find((x) => x.concept === num.concept);
  assert.deepEqual([ch.kind, ch.year, ch.a.value, ch.b.value], ['changed', 'CY', num.value, String(Number(num.value) + 1000)]);
  const t = r.facts.find((x) => x.concept === tb.concept);
  assert.equal(t.formatOnly, true, 'same words, formatting changed');
  assert.ok(r.facts.some((x) => x.kind === 'removed' && x.concept === gone.concept));
  assert.equal(r.counts.total, 1 + r.facts.length);
});

test('compare a project with the XML generated from it: the same filing', () => {
  const a = example();
  const { s: b } = importSession(a.exportXml({ today }).xml);
  const r = compareFilings(A, a.filing, b.filing);
  // the XML carries only what is generated: values the tool keeps aside (not applicable, hidden) are not in it
  const emitted = new Set(a.app.planFacts(a.filing).emit.map((f) => f.key));
  assert.deepEqual(r.facts.filter((x) => !(x.kind === 'removed' && !emitted.has(x.a.key))).map((x) => `${x.kind} ${x.concept} ${x.year}`), []);
});

test('a corrected company name keeps its file; next year\'s filing or the other report type is a separate filing', async () => {
  const root = new MemDir();
  const s = example();
  const r1 = await saveToWorkspace(root, s.filing.toJSON(), { device: 'LAPTOP-1', now: at(9) });
  const link = { folder: r1.path.folder, file: r1.path.file, key: filingKey(s.filing.meta) };
  s.filing.meta.lastSaved = r1.lastSaved; // as the app keeps it after each save
  s.setMeta({ name: 'Example Traders Pvt Ltd' });
  const r2 = await saveToWorkspace(root, s.filing.toJSON(), { base: r1.lastSaved, link, device: 'LAPTOP-1', now: at(10) });
  assert.deepEqual([r2.path.file, r2.lastSaved.n], [r1.path.file, 2], 'same file, version 2');
  assert.match(r2.backedUp, /_v1\.mca-ci\.json$/);
  s.filing.meta.lastSaved = r2.lastSaved;
  // next year
  s.setMeta({ periods: { cy: { start: '2017-04-01', end: '2018-03-31' }, py: { start: '2016-04-01', end: '2017-03-31' } } });
  assert.deepEqual(targetPath(s.filing.meta, link).folder, ['Example Traders Pvt Ltd (U99999MH2000PTC999999)', 'FY 2017-18']);
  const r3 = await saveToWorkspace(root, s.filing.toJSON(), { base: r2.lastSaved, link, device: 'LAPTOP-1', now: at(11) });
  assert.equal(r3.status, 'saved');
  assert.equal(r3.path.file, 'Example_Traders_Pvt_Ltd_2017-18_Standalone.mca-ci.json');
  const list = await listWorkspace(root);
  assert.deepEqual(list.map((x) => [x.fy, x.file, x.backups.length]), [['2017-18', 'Example_Traders_Pvt_Ltd_2017-18_Standalone.mca-ci.json', 0], ['2016-17', 'Example_Traders_Private_Limited_2016-17_Standalone.mca-ci.json', 1]]);
});
