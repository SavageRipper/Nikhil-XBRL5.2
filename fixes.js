// v14 UI helper: a one-click remedy for a validation message, where the remedy is unambiguous. The gate and the MCA
// rules decide what is an error; a fix only performs an ordinary edit through the Session (the same path as typing:
// applicability, locks, recalculation), after the user confirms it. Messages without an unambiguous remedy have no fix
// (the message still opens its cell).
//
//   GR-1 a part entered, its total missing        → enter the total = the sum of its parts
//   GR-1 a previous-year opening value w/o total   → remove that opening value (its total has no cell for that date)
//   GR-1 total ≠ Σ parts (total entered)           → set the total to the sum of its parts
//   mandatory amount not present                   → report nil (0)
//   GR-6 previous year entered, current year not   → report nil (0) for the current year (only if it is nil!)
//   statement figure ≠ its note (SR-L555-1 …)      → take the figure from the note
//   v14.3 share capital declared coarser than ₹1   → confirm the figure as the actual value (declared to the rupee)
//   v14.5 a column left at a total the table does → move the column to the member(s) the user chooses
//         not allow (usable="false" default)
import { statementNoteLinks } from './derived.js';
import * as Dec from './decimal.js';
import { reportingYear } from './periods.js';
import { cellFor, setAside } from './upkeep.js';
import { SCALE_POWERS, toDisplay } from './scaling.js';
import { groupIN } from './pdf-preview.js';
import { unusableDefaultAxes } from './dimensions.js';

const PL = { CY: 'current year', PY: 'previous year' };
const esc = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function fixFor(S, issue) {
  if (issue?.code === 'shareCapital.rounded') return shareCapitalFix(S, issue);
  if (!issue || issue.severity !== 'ERROR') return null;
  const A = S.A, f = S.filing;
  const fact = issue.factKey ? f.facts.get(issue.factKey) : null;
  // v14.6: a schema reference that is not accepted (e.g. the old V2 address) → the V3 address
  if (issue.code === 'schemaRef') return { label: 'Use the V3 schema reference', confirm: `Write the XML with the schema reference the MCA XBRL Validator requires: <b>${esc(A.meta.schemaRef)}</b> (instead of ${esc(f.meta.schemaRef || '')}).`, apply: () => { f.meta.schemaRef = null; f.revision++; } };
  if (issue.code === 'dim.hypercube' && fact) { const x = columnTotalFix(S, fact); if (x) return x; }
  if (A.rules.rules.find((r) => r.id === issue.ruleId)?.ast?.type === 'lineItemSingleMember' && issue.concept && issue.tableId) return singleMemberFix(S, issue);
  const msg = issue.message || '';
  const scopeOfFact = (x) => reportingYear(f.meta.periods, x.period);
  const locked = (sc) => S.pyLocked(sc);
  // a value no tab shows (dated outside the filing's years, or a previous-year opening value without its cell)
  if (issue.location?.kind === 'pyo' && fact) {
    const other = f.scopeOf(fact.period) === 'OTHER';
    return { label: 'Set it aside', confirm: `Set aside <b>${esc(A.label(fact.concept))}</b> dated ${esc(fact.period.date || `${fact.period.start} → ${fact.period.end}`)}? ${other ? "It is outside this filing's two years" : 'No tab shows a cell for it'}; it stays in the project under Hidden data (restorable) and is no longer part of the filing.`, apply: () => setAside(S, [{ fact, reason: other ? 'otherDate' : 'openingNoCell' }], 'fix') };
  }
  // GR-1: part entered, total missing
  if (issue.ruleId === 'GR-1' && fact && /is entered but its calculation parent/.test(msg)) {
    if (f.scopeOf(fact.period) === 'PYO') {
      return { label: 'Remove this opening value', confirm: `Remove the previous-year opening value <b>${esc(A.label(fact.concept))}</b> dated ${fact.period.date}? Its total has no cell for that date; previous-year opening balances are optional.`, apply: () => S.removeFacts([fact]) };
    }
    const sc = scopeOfFact(fact);
    for (const p of S.calcParentsOf(fact.concept, fact.period, fact.dims)) {
      const t = S.totalFromParts(p, fact.period, fact.dims);
      if (!t) continue;
      if (locked(sc)) return { label: 'Enter the total', disabled: 'The previous year is locked (last year\'s filed figures) — unlock it first.' };
      return { label: `Enter ${A.label(p)} = sum of parts`, confirm: `Enter <b>${esc(A.label(p))}</b> (${PL[sc]}) as the sum of its parts reported here: <b>${esc(S.displayOf({ concept: p, value: t.value, nil: false }))}</b>.`, apply: () => S.setTotalFromParts(p, fact.period, fact.dims) };
    }
    return null;
  }
  // GR-1: total ≠ Σ parts, the total was entered (a calculated total follows its parts by itself)
  if (issue.ruleId === 'GR-1' && fact && issue.calc && /Calculation inconsistency/.test(msg) && fact.origin !== 'calculated') {
    const t = S.totalFromParts(fact.concept, fact.period, fact.dims);
    if (!t) return null;
    const sc = scopeOfFact(fact);
    if (locked(sc)) return { label: 'Set total = sum of parts', disabled: 'The previous year is locked (last year\'s filed figures) — unlock it first.' };
    return { label: 'Set total = sum of parts', confirm: `Replace <b>${esc(A.label(fact.concept))}</b> (${PL[sc]}) ${esc(S.displayOf(fact))} by the sum of its parts <b>${esc(S.displayOf({ concept: fact.concept, value: t.value, nil: false }))}</b>? Only if the parts are right — otherwise correct the parts.`, apply: () => S.setTotalFromParts(fact.concept, fact.period, fact.dims) };
  }
  // a statement figure that differs from its note (the MCA rule tying them)
  for (const l of statementNoteLinks(A).values()) {
    if (l.kind !== 'sum' || l.ruleId !== issue.ruleId) continue;
    const sc = issue.scope === 'PY' ? 'PY' : 'CY';
    const v = S.noteValue(l, sc);
    const p = f.period(l.concept, sc);
    const x = p && f.get(l.concept, p, []);
    if (!v || v.undetermined || !x) continue;
    if (locked(sc)) return { label: 'Take the figure from the note', disabled: 'The previous year is locked — unlock it first.' };
    return { label: 'Take the figure from the note', confirm: `Set <b>${esc(A.label(l.concept))}</b> (${PL[sc]}) to the note's figure <b>${esc(S.displayOf({ concept: l.concept, value: Dec.toString(v.total), nil: false }))}</b> (now ${esc(S.displayOf(x))})? Only if the note is right — otherwise correct the note.`, apply: () => { f.setFact({ concept: l.concept, period: p, dims: [], value: Dec.toString(v.total), decimals: v.decimals, unit: v.unit || x.unit, origin: 'calculated' }); S.recalcFrom(l.concept, p, [], 0, { before: x.value, after: Dec.toString(v.total) }); } };
  }
  // a mandatory amount not present → nil
  const m = /^'(.+)' is mandatory — not present for (CY|PY)/.exec(msg.replace(/^\[[^\]]+\]\s*/, ''));
  if (m && issue.concept && A.isNumeric(issue.concept)) return nilFix(S, issue.concept, m[2], issue.location);
  // GR-6: previous year entered, current year not → nil for the current year
  if (issue.ruleId === 'GR-6' && fact && A.isNumeric(fact.concept) && /current-year value should be entered/.test(msg)) {
    return nilFix(S, fact.concept, 'CY', null, fact.dims, fact);
  }
  return null;
}

// v14.3: share capital declared coarser than the rupee (MCA: the actual value) → the user confirms the figure as the actual
// value: it is declared accurate to the rupee (needs the decimal places for exact rupees, so that it can also be typed so)
// v14.5: the table (and its column) of a fact left at a total the table does not allow
export function columnAtUnusableTotal(S, fact) {
  const A = S.A;
  for (const t of A.tables) {
    if (!t.lineItems.includes(fact.concept) || !fact.dims.every((d) => t.axes.some((a) => a.axis === d.axis))) continue;
    const need = unusableDefaultAxes(A, t, fact.dims);
    if (need.length) return { tableId: t.id, scope: reportingYear(S.filing.meta.periods, fact.period), dims: fact.dims, need };
  }
  return null;
}
// the fix for that column: the user chooses a member for each such axis; every value of the column moves there
export function moveColumnFix(S, tableId, scope, dims) {
  const A = S.A;
  const need = unusableDefaultAxes(A, tableId, dims);
  if (!need.length || (scope !== 'CY' && scope !== 'PY')) return null;
  const label = 'Move the column to a member';
  if (S.pyLocked(scope)) return { label, disabled: 'The previous year is locked (last year\'s filed figures) — unlock it first.' };
  const facts = S.sliceFacts(tableId, scope, dims);
  const col = dims.length ? dims.map((d) => A.label(d.member || d.axis)).join(' · ') : 'the total column';
  return {
    label,
    choose: need.map((n) => ({ axis: n.axis, label: A.label(n.axis), options: n.members.map((m) => ({ value: m, label: A.label(m) })) })),
    confirm: `The column <b>${esc(col)}</b> (${PL[scope]}) leaves ${need.map((n) => `<b>${esc(A.label(n.axis))}</b>`).join(' and ')} at its total, which the MCA taxonomy does not allow in this table (the total member is marked “not usable”; the MCA Validator rejects such values as dimensionally invalid). Choose the member its ${facts.length} value(s) belong to — they are moved unchanged:`,
    apply: (chosen) => S.moveSliceToMembers(tableId, scope, dims, need.map((n, i) => ({ axis: n.axis, member: (chosen && chosen[i]) || n.members[0] }))),
  };
}
// v14.5 (SR-L3717-1): a line item given against several members — the user chooses the member to keep it under; its
// value in the other columns is removed (an ordinary edit of those cells)
function singleMemberFix(S, issue) {
  const A = S.A, f = S.filing;
  const sc = issue.scope === 'PY' ? 'PY' : 'CY';
  const t = A.table(issue.tableId);
  const axes = new Set(t.axes.map((a) => a.axis));
  const facts = f.all().filter((x) => x.concept === issue.concept && !x.nil && x.dims.length && x.dims.every((d) => axes.has(d.axis)) && reportingYear(f.meta.periods, x.period) === sc);
  if (facts.length < 2) return null;
  const label = 'Keep it under one member';
  if (S.pyLocked(sc)) return { label, disabled: 'The previous year is locked (last year\'s filed figures) — unlock it first.' };
  const name = (x) => x.dims.map((d) => A.label(d.member) || d.typed).join(' · ');
  const preview = (x) => { const v = String(x.value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); return v.length > 50 ? v.slice(0, 50) + '…' : v; };
  return {
    label,
    choose: [{ label: 'Keep it under', options: facts.map((x, i) => ({ value: String(i), label: `${name(x)} — ${preview(x)}` })) }],
    confirm: `<b>${esc(A.label(issue.concept))}</b> (${PL[sc]}) is given under ${facts.length} members; the MCA rule allows one. Choose the member to keep it under — its value in the other column(s) is removed:`,
    apply: (chosen) => {
      const keep = Number((chosen && chosen[0]) ?? 0);
      facts.forEach((x, i) => { if (i !== keep) S.setTableValue(issue.tableId, sc, x.dims, x.concept, null, { recalc: true }); });
    },
  };
}
function columnTotalFix(S, fact) {
  const c = columnAtUnusableTotal(S, fact);
  return c ? moveColumnFix(S, c.tableId, c.scope, c.dims) : null;
}

function shareCapitalFix(S, issue) {
  const A = S.A, f = S.filing;
  const fact = issue.factKey ? f.facts.get(issue.factKey) : null;
  if (!fact || fact.nil || fact.origin === 'calculated') return null;
  const label = 'Confirm as the actual value';
  const pow = SCALE_POWERS[f.meta.level] ?? 0;
  if ((Number(f.meta.displayPlaces) || 0) < pow) return { label, disabled: `First choose at least ${pow} "Decimal places as presented" on the company page (${pow} places = exact rupees in ${f.meta.level}), then confirm or type the exact figure.` };
  const sc = reportingYear(f.meta.periods, fact.period);
  if (S.pyLocked(sc)) return { label, disabled: 'The previous year is locked — unlock it first.' };
  const rupees = groupIN(Dec.toString(Dec.parse(fact.value)));
  const display = Dec.toFixed(Dec.parse(toDisplay(fact.value, f.meta.level)), pow);
  return { label, confirm: `Report <b>${esc(A.label(fact.concept))}</b> as exactly <b>₹${esc(rupees)}</b> (${esc(display)} in ${esc(f.meta.level)}), accurate to the rupee? Only if this is the actual share capital — otherwise type the exact figure in its cell.`, apply: () => {
    // the value is not changed: only its declared accuracy becomes the rupee (as if typed with ${pow} places); what is
    // calculated from it is re-derived (a share capital taken from its note is locked: its accuracy is confirmed the same way)
    const x = f.facts.get(fact.key);
    if (!x || x.nil) throw new Error('The value is no longer there');
    f.setFact({ concept: x.concept, period: x.period, dims: x.dims, value: x.value, decimals: String(f.typedDecimals(pow, x.value)), unit: x.unit, origin: x.origin });
    S.recalcFrom(x.concept, x.period, x.dims, 0, { before: x.value, after: x.value });
  } };
}

function nilFix(S, concept, scope, loc, dims = [], prevFact = null) {
  const A = S.A;
  if (S.pyLocked(scope)) return { label: 'Report nil (0)', disabled: 'The previous year is locked — unlock it first.' };
  const label = 'Report nil (0)';
  const confirm = `Report <b>${esc(A.label(concept))}</b> as <b>0</b> for the ${PL[scope]}${prevFact ? ` (the previous year reports ${esc(S.displayOf(prevFact))})` : ''}? Only if the amount really is nil — otherwise enter the figure in its cell.`;
  return { label, confirm, apply: () => {
    const period = S.filing.period(concept, scope);
    const t = cellFor(S, { concept, period, dims });
    if (t.why) throw new Error(`No cell for this value: ${t.why}`);
    if (t.kind === 'row') return S.setValue(concept, t.scope, '0', { preferredLabel: t.preferredLabel, tab: t.elrUri, recalc: true });
    return S.setTableValue(t.tableId, t.scope, t.dims, concept, '0', { preferredLabel: t.preferredLabel, recalc: true, lockCalculated: true });
  } };
}
