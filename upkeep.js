// v14 UI helper: keeping a project healthy. No compliance logic of its own — every value goes through the Session
// (setValue / setTableValue: applicability, dimensions, locks, recalculation); the gate and the rule engine decide what
// is an error.
//
//   healthCheck      on opening / saving: re-derive values the tool calculated itself that are out of date (statement
//                    figures taken from notes, totals, carrying amounts, closing balances) and move values that no tab
//                    can show (other dates, previous-year opening values without an opening-balance cell) to the
//                    set-aside store. Entered, imported and manual figures are never changed; nothing is deleted.
//   hiddenData       everything in the project that is not shown as filing data: the set-aside store, values made not
//                    applicable (kept, excluded from the filing — e.g. after a Yes/No answer changed), values no tab shows
//   restore / delete set-aside values (restore = the normal entry path into the cell that shows that date)
//   compareWithFiled the previous-year column against last year's filed figures (from the filed XML)
import { Gate } from './gate.js';
import { scopeOf } from './periods.js';
import { tablesForFact, dimensionallyValid, nondimAllowed } from './dimensions.js';
import { factKey, dimKey, normDims } from './model.js';
import { totalColumnAllowed } from './views.js';
import { importInstance } from './importer.js';
import * as Dec from './decimal.js';

export const SET_ASIDE_REASONS = {
  yearBeforeLast: "Last year's previous-year figure (not part of this filing)",
  openingBeforeLast: "Last year's previous-year opening balance (not part of this filing)",
  notApplicablePreviousYear: 'Last year\'s value of an element that is reported for the current year only (disclosures, GR-12) — see "Copy from previous year" on its tab',
  otherDate: "Dated outside this filing's two years",
  openingNoCell: 'Previous-year opening value that no tab shows (its totals cannot be entered for that date)',
};

const samePeriod = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// values in the filing that no tab can show: other dates, previous-year opening values without an opening-balance cell.
// Not among them: values the tool calculated itself, and opening values that are the totals (GR-1) of opening values
// that ARE shown — a filing may report its previous-year opening balance sheet (the MCA-validated FILING-A filing does).
export function unshownFacts(S) {
  const g = new Gate(S.A), f = S.filing, out = [];
  const pyo = f.all().filter((x) => f.scopeOf(x.period) === 'PYO');
  const shown = new Set(pyo.filter((x) => x.origin === 'calculated' || g._openingCell(f, x.concept, x.period, x.dims)).map((x) => x.key));
  // totals of shown opening values (and their totals …) are needed for that date
  const needed = new Set();
  const up = (x, depth = 0) => {
    if (depth > 30) return;
    for (const p of S.calcParentsOf(x.concept, x.period, x.dims)) {
      const px = f.get(p, x.period, x.dims);
      if (px && !needed.has(px.key)) { needed.add(px.key); up(px, depth + 1); }
    }
  };
  for (const x of pyo) if (shown.has(x.key)) up(x);
  for (const x of f.all()) {
    const sc = f.scopeOf(x.period);
    if (sc === 'OTHER') out.push({ fact: x, reason: 'otherDate' });
    else if (sc === 'PYO' && !shown.has(x.key) && !needed.has(x.key)) out.push({ fact: x, reason: 'openingNoCell' });
  }
  return out;
}

// move values out of the filing into the set-aside store (each removal re-derives what was calculated from it)
export function setAside(S, items, source = 'health check') {
  // v15.2: nothing to move is no change (the filing's revision stays) — the health check runs on every save, and "Save
  // XML to workspace" refuses an XML whose project changed while it was being saved: it refused every time
  if (!items.length) return [];
  const at = new Date().toISOString().slice(0, 10);
  const list = items.map(({ fact, reason }) => ({ concept: fact.concept, period: fact.period, dims: fact.dims, value: fact.nil ? null : fact.value, nil: !!fact.nil, decimals: fact.decimals ?? null, unit: fact.unit ?? null, lang: fact.lang ?? null, reason, source, at }));
  S.removeFacts(items.map((i) => i.fact));
  S.filing.setAside.push(...list);
  S.filing.revision++;
  return list;
}

export function healthCheck(S, { move = true } = {}) {
  // v14.4: bulleted lists written by v14.3 and earlier as noteText2 (the MCA PDF prints it bold in a grey box) take
  // the list style numbered lists use (noteText1: normal text, indented) — the class only, the text is unchanged
  const lists = [];
  for (const f of S.filing.all()) {
    if (f.nil || typeof f.value !== 'string' || !f.value.includes('class="noteText2"') || S.A.dataType(f.concept) !== 'textBlock') continue;
    const v = f.value.replace(/<div class="noteText2">(?=<p>\u2022)/g, '<div class="noteText1">');
    if (v !== f.value) { lists.push({ concept: f.concept, period: f.period, dims: f.dims }); f.value = v; S.filing.revision++; }
  }
  // v14.6: a project that kept the schema reference of an imported instance with the old V2 address (or any address
  // that is not accepted) is written with the V3 address the MCA XBRL Validator requires
  let schemaRef = null;
  const sref = S.filing.meta.schemaRef;
  if (sref && !(S.A.meta.acceptedSchemaRefs || []).some((x) => x.href === sref)) { schemaRef = { before: sref, after: S.A.meta.schemaRef }; S.filing.meta.schemaRef = null; S.filing.revision++; }
  const statements = S.refreshDerivedStatements();
  const cells = S.refreshCalculatedCells();
  // automatically: values dated outside the filing's years (the gate rejects them as filing data) and previous-year
  // opening values that no tab shows and no shown value needs
  const moved = move ? setAside(S, unshownFacts(S)) : [];
  return { statements, cells, moved, lists, schemaRef, changed: statements.length + cells.length + moved.length + lists.length + (schemaRef ? 1 : 0) };
}

export function hiddenData(S) {
  const f = S.filing;
  const notApplicable = S.app.planFacts(f).excluded.map((x) => ({ fact: x.fact, reasons: x.reasons }));
  return { setAside: f.setAside.map((x, i) => ({ ...x, index: i })), notApplicable, unshown: unshownFacts(S) };
}
export const hiddenCount = (S) => { const h = hiddenData(S); return h.setAside.length + h.notApplicable.length + h.unshown.length; };

// the cell a set-aside value would go back into (same element, date and members), or why there is none
export function restoreTarget(S, x) {
  if (S.filing.get(x.concept, x.period, normDims(x.dims || []))) return { why: 'the cell already has a value' };
  return cellFor(S, x);
}
// the cell (tab row or table cell) that shows an element at a date with members, or why there is none
export function cellFor(S, x) {
  const A = S.A, f = S.filing, g = new Gate(A);
  const sc = scopeOf(f.meta.periods, x.period);
  const dims = normDims(x.dims || []);
  if (!A.concept(x.concept)) return { why: 'element unknown to the taxonomy' };
  if (sc === 'OTHER' || !sc) return { why: "dated outside this filing's years" };
  if (sc === 'PYO') {
    const loc = g._openingCell(f, x.concept, x.period, dims);
    return loc ? { kind: loc.tableId ? 'cell' : 'row', scope: 'PY', elrUri: loc.elrUri, tableId: loc.tableId, dims, preferredLabel: 'periodStartLabel' } : { why: 'no tab shows a cell for this date' };
  }
  const plOk = (pl) => samePeriod(S.periodForCell(x.concept, sc, pl), x.period);
  if (!dims.length) {
    for (const e of A.elrs) {
      const r = S.elrView(e.uri).rows.find((y) => y.kind === 'item' && y.concept === x.concept && plOk(y.preferredLabel));
      if (r && S.cellStatus(e.uri, x.concept, sc).applicable) return { kind: 'row', scope: sc, elrUri: e.uri, dims: [], preferredLabel: r.preferredLabel || null };
    }
  }
  const ts = dims.length ? tablesForFact(A, { concept: x.concept, dims }) : A.tables.filter((t) => t.lineItems.includes(x.concept) && (!t.axes.length || totalColumnAllowed(A, t.id)) && nondimAllowed(A, x.concept));
  for (const t of ts) {
    if (!S.tableStatus(t.id, sc).applicable) continue;
    const l = S.tableView(t.id).lineItems.find((y) => y.concept === x.concept && plOk(y.preferredLabel));
    if (!l) continue;
    try { S.validateSlice(t.id, dims); } catch { continue; }
    if (dims.length && !dimensionallyValid(A, x.concept, dims).valid) continue;
    return { kind: 'cell', scope: sc, tableId: t.id, elrUri: t.presentationElr, dims, preferredLabel: l.preferredLabel || null };
  }
  return { why: S.conceptStatus(x.concept, sc).applicable ? 'no tab shows a cell for it' : 'not applicable to this filing' };
}

// put set-aside values back into their cells (normal entry path); those restored leave the store
export function restoreSetAside(S, indexes, { unlockPY = false } = {}) {
  const f = S.filing, res = { restored: 0, skipped: [] };
  const done = new Set();
  for (const i of indexes) {
    const x = f.setAside[i];
    if (!x) continue;
    const t = restoreTarget(S, x);
    if (t.why) { res.skipped.push({ concept: x.concept, reason: t.why }); continue; }
    const display = x.nil ? '' : S.displayOf({ concept: x.concept, value: x.value, nil: false });
    try {
      if (t.kind === 'row') S.setValue(x.concept, t.scope, display, { preferredLabel: t.preferredLabel, tab: t.elrUri, recalc: true, unlockPY, override: true });
      else S.setTableValue(t.tableId, t.scope, t.dims, x.concept, display, { preferredLabel: t.preferredLabel, recalc: true, unlockPY });
      done.add(i); res.restored++;
    } catch (e) { res.skipped.push({ concept: x.concept, reason: e.message }); }
  }
  f.setAside = f.setAside.filter((_, i) => !done.has(i));
  f.revision++;
  return res;
}
export function deleteSetAside(S, indexes) {
  const drop = new Set(indexes);
  const n = S.filing.setAside.length;
  S.filing.setAside = S.filing.setAside.filter((_, i) => !drop.has(i));
  S.filing.revision++;
  return n - S.filing.setAside.length;
}

// ---- last year's filed figures (previous-year column)
const valueEq = (A, concept, a, b) => {
  if (a == null || b == null) return a == null && b == null;
  if (A.isNumeric(concept) && Dec.isDecimalString(String(a)) && Dec.isDecimalString(String(b))) return Dec.eq(Dec.parse(String(a)), Dec.parse(String(b)));
  return String(a).trim() === String(b).trim();
};
// differences between the previous-year column and last year's filed figures: changed / missing / added
export function compareWithFiled(S) {
  const A = S.A, f = S.filing, ref = f.filedReference;
  if (!ref?.facts?.length) return null;
  const out = [];
  const keys = new Set();
  for (const r of ref.facts) {
    if (!r.concept || !A.concept(r.concept)) continue;
    const dims = normDims(r.dims || []);
    const key = factKey(r.concept, r.period, dims);
    keys.add(key);
    const x = f.facts.get(key);
    if (!x || x.nil) { if (r.value != null && S.conceptStatus(r.concept, 'PY').applicable) out.push({ kind: 'missing', concept: r.concept, period: r.period, dims, filed: r.value, now: null, key }); continue; }
    if (!valueEq(A, r.concept, x.value, r.value)) out.push({ kind: 'changed', concept: r.concept, period: r.period, dims, filed: r.value, now: x.value, key });
  }
  for (const x of f.all()) {
    if (f.scopeOf(x.period) !== 'PY' || keys.has(x.key) || x.nil || x.origin === 'calculated' || x.origin === 'import' || x.origin === 'meta') continue;
    out.push({ kind: 'added', concept: x.concept, period: x.period, dims: x.dims, filed: null, now: x.value, key: x.key });
  }
  return { file: ref.file, items: out };
}
// attach last year's filed XML as the reference for an existing project (its current year must be this filing's
// previous year)
export function attachFiledXml(S, text, { fileName = 'filed.xml', DOMParserImpl } = {}) {
  const { filing: g } = importInstance(S.A, text, { fileName, yearMode: 'next', DOMParserImpl });
  const py = S.filing.meta.periods.py, gpy = g.meta.periods.py;
  if (!py?.end || py.start !== gpy.start || py.end !== gpy.end) throw new Error(`This XML reports the year ${gpy.start || '?'} → ${gpy.end || '?'}, not this filing's previous year (${py?.start || '?'} → ${py?.end || '?'}).`);
  S.filing.filedReference = { ...g.filedReference, file: fileName };
  S.filing.revision++;
  return compareWithFiled(S);
}
// put the filed figure back into the previous-year column
export function useFiledFigure(S, item) {
  const loc = restoreTarget(S, { concept: item.concept, period: item.period, dims: item.dims, value: item.filed });
  const display = S.displayOf({ concept: item.concept, value: item.filed, nil: false });
  const existing = S.filing.facts.get(item.key);
  if (existing) S.filing.removeFact(existing.key);
  const t = existing ? restoreTarget(S, { concept: item.concept, period: item.period, dims: item.dims }) : loc;
  if (t.why) { if (existing) S.filing.facts.set(existing.key, existing); throw new Error(t.why); }
  if (t.kind === 'row') S.setValue(item.concept, t.scope, display, { preferredLabel: t.preferredLabel, tab: t.elrUri, recalc: true, unlockPY: true, override: true });
  else S.setTableValue(t.tableId, t.scope, t.dims, item.concept, display, { preferredLabel: t.preferredLabel, recalc: true, unlockPY: true, override: true });
}

// a date change that leaves values outside the filing (setup page): the values that no tab would show
export const leftAfterDateChange = (S) => unshownFacts(S);
export { dimKey };
