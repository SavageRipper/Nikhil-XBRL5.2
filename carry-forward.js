// UI helper: carry a dimensional table's previous-year columns (and, optionally, values) into the current year.
// No compliance logic of its own — every step goes through the existing session APIs, exactly like a user doing it
// by hand: columns are checked with Session.validateSlice (the "Add row" path), values are entered with
// Session.setTableValue (the normal cell-entry path: applicability, dimensional validity, calculated-cell lock,
// decimals, recalculation). It never overwrites a current-year value.
//
// Skipped on purpose:
//   - opening-balance rows (periodStart): the current-year opening balance IS the previous-year closing fact (GR-7)
//   - closing-balance rows (periodEnd): this year's closing is opening + changes, never last year's closing
//   - statement figures in a table's total column (the same fact as e.g. a balance-sheet row)
//   - calculated cells: they are recalculated from their children
//   - cells that are not applicable or not valid for the member combination (the session refuses them anyway)
import { tableSlices, nondimRowConcepts } from './views.js';
import { reportingYear } from './periods.js';
import { dimKey } from './model.js';
import { dimensionallyValid, tablesForFact, unusableDefaultAxes } from './dimensions.js';

/** what a carry-forward would do (no changes) */
export function carryForwardPlan(S, tableId) {
  const A = S.A;
  const out = { available: false, reason: '', columns: [], newColumns: [], values: 0 };
  const cy = S.tableStatus(tableId, 'CY'), py = S.tableStatus(tableId, 'PY');
  if (!cy.applicable) { out.reason = 'The current-year table is not applicable.'; return out; }
  if (!py.applicable) { out.reason = 'The previous-year table is not applicable.'; return out; }
  // v14.5: a previous-year column left at a total the table does not allow (usable="false") is not carried forward
  const pyCols = tableSlices(A, S.filing, tableId, 'PY', reportingYear).filter((d) => !unusableDefaultAxes(A, tableId, d).length);
  if (!pyCols.length) { out.reason = 'The previous-year table has no columns.'; return out; }
  const have = new Set(tableSlices(A, S.filing, tableId, 'CY', reportingYear).map(dimKey));
  out.available = true;
  out.columns = pyCols;
  out.newColumns = pyCols.filter((d) => !have.has(dimKey(d)));
  out.values = valueCandidates(S, tableId, pyCols).length;
  return out;
}

function valueCandidates(S, tableId, cols) {
  const A = S.A;
  const t = A.table(tableId);
  // opening rows carry over by themselves (GR-7); closing rows are this year's balances (opening + changes), never
  // last year's — they are not copied
  const rows = (S.tableView(tableId).lineItems || []).filter((l) => !l.abstract && l.preferredLabel !== 'periodStartLabel' && l.preferredLabel !== 'periodEndLabel');
  const shared = nondimRowConcepts(A);
  const list = [];
  for (const dims of cols) for (const l of rows) {
    const pf = S.getValue(l.concept, 'PY', dims, l.preferredLabel);
    if (!pf || pf.nil) continue;
    if (!dims.length && shared.has(l.concept)) continue; // a statement figure (e.g. on the balance sheet) is not copied from last year
    if (S.getValue(l.concept, 'CY', dims, l.preferredLabel)) continue; // never overwrite
    if (!dimensionallyValid(A, l.concept, dims).valid || !S.conceptStatus(l.concept, 'CY').applicable) continue;
    if (A.isNumeric(l.concept) && S.calculatedCell(l.concept, 'CY', dims, t.presentationElr, l.preferredLabel)) continue;
    list.push({ dims, row: l, fact: pf });
  }
  return list;
}

/**
 * @returns {{ columns: object[][], values: number, skipped: { reason: string, concept: string }[] }}
 *   columns: current-year columns to show (previous-year member combinations not yet in the current year)
 */
export function carryForward(S, tableId, { values = false } = {}) {
  const plan = carryForwardPlan(S, tableId);
  if (!plan.available) throw new Error(plan.reason);
  const columns = plan.newColumns.map((d) => S.validateSlice(tableId, d));
  const res = { columns, values: 0, skipped: [] };
  if (!values) return res;
  for (const c of valueCandidates(S, tableId, plan.columns)) {
    try {
      S.setTableValue(tableId, 'CY', c.dims, c.row.concept, S.displayOf(c.fact), { preferredLabel: c.row.preferredLabel || null, recalc: true, lockCalculated: true });
      res.values++;
    } catch (e) { res.skipped.push({ reason: e.message, concept: c.row.concept }); }
  }
  return res;
}

// ---- disclosure tabs ([400100]–[400500]): reported for the current year only (MCA GR-12), so "previous year" is
// last year's filing: the previous-year values kept in the project (a project moved forward by changing its dates)
// or the values of last year's current year that an import as "Next year's filing" set aside as not applicable for a
// previous year (import report). Copied only into EMPTY current-year cells, through the normal entry path.
const keyOf = (concept, dims, period) => `${concept}#${dimKey(dims)}#${JSON.stringify(period)}`;
export function previousYearValues(S) {
  const f = S.filing, P = f.meta.periods, out = new Map();
  for (const x of f.all()) if (!x.nil && x.value != null && f.scopeOf(x.period) === 'PY') out.set(keyOf(x.concept, x.dims, x.period), x);
  // the set-aside store (v14: last year's values set aside by "Prepare next year's filing")
  for (const x of f.setAside || []) {
    if (x.value == null || reportingYear(P, x.period) !== 'PY' || !S.A.concept(x.concept)) continue;
    const k = keyOf(x.concept, x.dims || [], x.period);
    if (!out.has(k)) out.set(k, { concept: x.concept, dims: x.dims || [], period: x.period, value: x.value, nil: false });
  }
  for (const x of f.importReport?.notApplicable || []) {
    if (x.value == null || reportingYear(P, x.period) !== 'PY' || !S.A.concept(x.concept)) continue;
    const k = keyOf(x.concept, x.dims || [], x.period);
    if (!out.has(k)) out.set(k, { concept: x.concept, dims: x.dims || [], period: x.period, value: x.value, nil: false });
  }
  return out;
}
const isDisclosureTab = (A, uri) => A.elr(uri)?.group === 'Disclosures';
export const disclosureTab = isDisclosureTab;

/** what a copy would do on a disclosure tab (or one of its tables): { available, reason, items } (no changes) */
export function disclosureCarryPlan(S, elrUri, { tableId = null } = {}) {
  const A = S.A;
  const out = { available: false, reason: '', items: [] };
  if (!isDisclosureTab(A, elrUri)) { out.reason = 'Not a disclosure tab.'; return out; }
  if (!S.elrStatus(elrUri, 'CY').applicable) { out.reason = 'This tab is not applicable for the current year.'; return out; }
  const prev = previousYearValues(S);
  if (!prev.size) { out.reason = "No previous-year values: open last year's project moved forward, or import last year's XML as “Next year's filing”."; return out; }
  const display = (x) => S.displayOf({ concept: x.concept, value: x.value, nil: false });
  const empty = (x) => !x || x.nil;
  if (!tableId) for (const r of S.elrView(elrUri).rows) {
    if (r.kind !== 'item' || r.preferredLabel === 'periodStartLabel') continue;
    if (!S.cellStatus(elrUri, r.concept, 'CY').applicable || !empty(S.getValue(r.concept, 'CY', [], r.preferredLabel))) continue;
    if (A.isNumeric(r.concept) && S.calculatedCell(r.concept, 'CY', [], elrUri, r.preferredLabel)) continue;
    const pp = S.periodForCell(r.concept, 'PY', r.preferredLabel);
    const x = pp && prev.get(keyOf(r.concept, [], pp));
    if (x) out.items.push({ kind: 'row', concept: r.concept, dims: [], preferredLabel: r.preferredLabel || null, display: display(x) });
  }
  const tables = tableId ? [tableId] : S.elrView(elrUri).rows.filter((r) => r.kind === 'table').map((r) => r.tableId);
  for (const id of tables) {
    const t = A.table(id);
    if (!S.tableStatus(id, 'CY').applicable) continue;
    const lines = (S.tableView(id).lineItems || []).filter((l) => !l.abstract && l.preferredLabel !== 'periodStartLabel' && l.preferredLabel !== 'periodEndLabel');
    for (const x of prev.values()) {
      if (!t.lineItems.includes(x.concept)) continue;
      if (x.dims.length ? !tablesForFact(A, x).some((y) => y.id === id) : t.axes.length) continue;
      const l = lines.find((li) => li.concept === x.concept && JSON.stringify(S.periodForCell(x.concept, 'PY', li.preferredLabel)) === JSON.stringify(x.period));
      if (!l || !empty(S.getValue(x.concept, 'CY', x.dims, l.preferredLabel))) continue;
      if (!dimensionallyValid(A, x.concept, x.dims).valid || !S.conceptStatus(x.concept, 'CY').applicable) continue;
      try { S.validateSlice(id, x.dims); } catch { continue; }
      if (A.isNumeric(x.concept) && S.calculatedCell(x.concept, 'CY', x.dims, t.presentationElr, l.preferredLabel)) continue;
      out.items.push({ kind: 'cell', tableId: id, concept: x.concept, dims: x.dims, preferredLabel: l.preferredLabel || null, display: display(x) });
    }
  }
  out.available = true;
  if (!out.items.length) out.reason = 'Every current-year cell that last year reported is already filled.';
  return out;
}

/** copy previous-year values into empty current-year cells of a disclosure tab; Yes/No and choices first (they open
 *  dependent cells and tables), repeated while something new becomes applicable. @returns {{ copied, skipped }} */
export function disclosureCarry(S, elrUri, { tableId = null } = {}) {
  const A = S.A;
  const res = { copied: 0, skipped: [] };
  const answer = (it) => ['boolean', 'enum'].includes(A.dataType(it.concept));
  const tried = new Set();
  for (let pass = 0; pass < 4; pass++) {
    const plan = disclosureCarryPlan(S, elrUri, { tableId });
    const todo = plan.items.filter((it) => !tried.has(keyOf(it.concept, it.dims, it.preferredLabel)));
    if (!todo.length) break;
    todo.sort((a, b) => answer(b) - answer(a));
    for (const it of todo) {
      tried.add(keyOf(it.concept, it.dims, it.preferredLabel));
      try {
        if (it.kind === 'row') S.setValue(it.concept, 'CY', it.display, { preferredLabel: it.preferredLabel, tab: elrUri, recalc: true });
        else S.setTableValue(it.tableId, 'CY', it.dims, it.concept, it.display, { preferredLabel: it.preferredLabel, recalc: true, lockCalculated: true });
        res.copied++;
      } catch (e) { res.skipped.push({ concept: it.concept, reason: e.message }); }
    }
  }
  return res;
}
