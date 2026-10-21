// Derived cells beyond the calculation linkbase — read from the taxonomy and the compiled MCA rules, no table-specific
// code. Used by the Session to auto-populate (and lock) cells exactly like calculation parents.
//
//   carrying amount   MCA rules SR-L1364-2 / SR-L1380-1 / SR-L1484-2 / SR-L1504-1 (pattern member-difference):
//                     CarryingAmountMember (the axis default = the column without that axis) =
//                     GrossCarryingAmountMember − AccumulatedDepreciation/AmortisationAndImpairmentMember.
//                     Applied to every monetary line item of the tables carrying that axis: both MCA-validated
//                     instances satisfy it for every movement row (480 of 480 complete triples), and where only the
//                     gross column is reported (e.g. additions) carrying = gross (missing side = 0).
//   roll-forward      a reconciliation presents one instant concept twice — opening (periodStartLabel) and closing
//                     (periodEndLabel) — around its net-change total (tangible/intangible assets, reserves, share
//                     capital, shares outstanding, other provisions, defined benefit obligation, plan assets, cash
//                     and cash equivalents of the cash flow statement …): closing(CY) = opening(CY) + change(CY), the
//                     opening being the previous-year closing fact (GR-7). Only for the current year: the previous-year
//                     opening is normally not reported (MCA-validated FILING-B instance), so the previous-year closing
//                     is entered/imported. Amounts and share counts only; the Directors' report shareholding tables
//                     (400400, per-person typed rows, percentages) are not derived.
//   statement figure  a figure of a main statement (balance sheet, statement of profit and loss, cash flow statement)
//                     that its note supplies (statementNoteLinks):
//                       'sum'    MCA rules stating the statement figure = Σ of a note element over an axis (SR-L555-1
//                                reserves, SR-L632-1/2 borrowings, SR-L784-2 provisions, SR-L936-1 loans and advances,
//                                SR-L1381-2 / SR-L1505-2 tangible / intangible assets, SR-L374-1 share capital,
//                                SR-L1026-1 trade receivables, SR-L675-2 / SR-L709-2 investments): derived from the note
//                       'row'    the same element is a total of the note's own calculation (other current liabilities,
//                                cash and bank balances, other income, employee benefit expense …): one fact, entered
//                                in the note
//                       'column' the same element is the total column of a note table (inventories, producing
//                                properties …): one fact, entered in the note
//                     A statement total computed on the statement itself (profit for the period …) is not linked.
// A derived value never replaces a manual override (origin 'override'), as for calculation parents.
import { dimensionallyValid, nondimAllowed } from './dimensions.js';
import { buildElrView, buildTableView, totalColumnAllowed } from './views.js';

const CACHE = new WeakMap();
const NUMERIC_KINDS = new Set(['monetary', 'shares']);

export function derivations(A) {
  if (CACHE.has(A)) return CACHE.get(A);
  // ---- carrying = gross − accumulated (axes from the compiled member-difference rules)
  const arith = new Map(); // axis -> { axis, target, plus, minus, concepts:Set }
  for (const r of A.rules.rules) {
    const a = r.ast;
    if (r.status !== 'EXECUTABLE' || a?.type !== 'memberArith') continue;
    if (a.target !== A.dimensionDefault(a.axis)) continue; // the target column is the column without the axis
    if (!arith.has(a.axis)) {
      const concepts = new Set();
      for (const t of A.tables) if (t.axes.some((x) => x.axis === a.axis)) for (const q of t.lineItems) if (!A.concept(q)?.abstract && A.dataType(q) === 'monetary') concepts.add(q);
      arith.set(a.axis, { axis: a.axis, target: a.target, plus: a.plus, minus: a.minus, concepts, rules: [] });
    }
    arith.get(a.axis).rules.push(r.id);
  }
  // ---- roll-forwards from the presentation linkbase
  const kind = (q) => A.dataType(q);
  const byClosing = new Map(); // closing concept -> change concept
  const byChange = new Map(); // change concept -> closing concepts
  const seenChange = new Map();
  for (const [elr, arcs] of Object.entries(A.json.presentation)) {
    const code = A.json.roles[elr]?.code?.slice(0, 6);
    if (code === '400400') continue;
    const kids = new Map();
    for (const x of arcs) (kids.get(x.from) || kids.set(x.from, []).get(x.from)).push(x);
    for (const list of kids.values()) list.sort((p, q) => p.order - q.order);
    const lastTotal = (q) => { const t = (kids.get(q) || []).filter((x) => /totalLabel$/.test(x.preferredLabel || '')); return t.length ? t[t.length - 1].to : null; };
    for (const list of kids.values()) {
      for (const s of list) {
        if (!/periodStartLabel$/.test(s.preferredLabel || '')) continue;
        const e = list.find((x) => x.to === s.to && /periodEndLabel$/.test(x.preferredLabel || ''));
        if (!e || A.concept(s.to)?.periodType !== 'instant' || !NUMERIC_KINDS.has(kind(s.to))) continue;
        const cands = [];
        for (const x of list) {
          if (x.order <= s.order || x.order >= e.order) continue;
          const c = A.concept(x.to);
          if (!c) continue;
          if (c.abstract) { const t = lastTotal(x.to); if (t) cands.push(t); }
          else if (c.periodType === 'duration' && kind(x.to) === kind(s.to)) cands.push(x.to);
        }
        const uniq = [...new Set(cands)];
        if (uniq.length !== 1) continue;
        const ch = uniq[0];
        if (A.concept(ch)?.periodType !== 'duration') continue;
        if (byClosing.has(s.to) && byClosing.get(s.to) !== ch) { byClosing.set(s.to, null); continue; } // ambiguous
        byClosing.set(s.to, ch);
        (seenChange.get(ch) || seenChange.set(ch, new Set()).get(ch)).add(s.to);
      }
    }
  }
  for (const [x, ch] of [...byClosing]) if (!ch || seenChange.get(ch).size !== 1) byClosing.delete(x); // one change per balance
  for (const [x, ch] of byClosing) byChange.set(ch, x);
  const out = { arith, byClosing, byChange };
  CACHE.set(A, out);
  return out;
}

// carrying-amount derivation that targets (concept, dims) — the carrying column has no member on the axis
export function carryingRuleFor(A, concept, dims) {
  for (const d of derivations(A).arith.values()) {
    if (!d.concepts.has(concept) || dims.some((x) => x.axis === d.axis)) continue;
    // a side may be excluded for a line item (notAll: e.g. depreciation has no gross-carrying-amount cell) — it is 0
    const plus = d.plus.map((m) => [...dims, { axis: d.axis, member: m }]).filter((x) => dimensionallyValid(A, concept, x).valid);
    const minus = d.minus.map((m) => [...dims, { axis: d.axis, member: m }]).filter((x) => dimensionallyValid(A, concept, x).valid);
    if (!plus.length && !minus.length) continue;
    return { ...d, plusDims: plus, minusDims: minus };
  }
  return null;
}
// the carrying cell(s) a gross / accumulated cell feeds
export function carryingTargetOf(A, concept, dims) {
  for (const d of derivations(A).arith.values()) {
    if (!d.concepts.has(concept)) continue;
    const m = dims.find((x) => x.axis === d.axis);
    if (!m || ![...d.plus, ...d.minus].includes(m.member)) continue;
    return dims.filter((x) => x.axis !== d.axis);
  }
  return null;
}
export const rollForwardChangeOf = (A, concept) => derivations(A).byClosing.get(concept) || null;
export const rollForwardClosingOf = (A, change) => derivations(A).byChange.get(change) || null;

// ---- statement figures supplied by their notes: Map statement concept -> link (see the header)
const LINKS = new WeakMap();
export function statementNoteLinks(A) {
  if (LINKS.has(A)) return LINKS.get(A);
  const out = new Map();
  const statements = A.elrs.filter((e) => e.group === 'Statements');
  const notes = A.elrs.filter((e) => e.group === 'Notes');
  const code = (uri) => A.elr(uri)?.code.slice(0, 6);
  // calculation parents per ELR code
  const parentIn = new Map();
  for (const [elr, arcs] of Object.entries(A.json.calculation)) {
    const c = A.json.roles[elr]?.code?.slice(0, 6);
    for (const a of arcs) (parentIn.get(a.from) || parentIn.set(a.from, new Set()).get(a.from)).add(c);
  }
  const rows = new Map(); // statement concept -> statement codes where it has a row
  for (const e of statements) for (const r of buildElrView(A, e.uri).rows) if (r.kind === 'item' && A.isNumeric(r.concept)) (rows.get(r.concept) || rows.set(r.concept, new Set()).get(r.concept)).add(code(e.uri));
  const ownTotal = (q) => [...(rows.get(q) || [])].some((c) => parentIn.get(q)?.has(c));
  // the row a note table shows an element in: its closing (period end) row for a balance, else its plain row
  const lineRow = (t, q) => {
    const items = buildTableView(A, t.id).lineItems.filter((l) => l.concept === q);
    return (items.find((l) => l.preferredLabel === 'periodEndLabel') || items.find((l) => l.preferredLabel !== 'periodStartLabel') || items[0])?.preferredLabel || null;
  };
  const noteTable = (q, axis, fixed) => A.tables.find((t) => A.elr(t.presentationElr)?.group === 'Notes' && t.lineItems.includes(q) && t.axes.some((x) => x.axis === axis) && Object.keys(fixed || {}).every((ax) => t.axes.some((x) => x.axis === ax)));
  // 1. MCA rules: statement figure = Σ note element over an axis
  const cmps = (n) => (!n ? [] : n.op === 'and' ? n.args.flatMap(cmps) : n.op === 'cmp' ? [n] : []);
  for (const r of A.rules.rules) {
    if (r.status !== 'EXECUTABLE' || r.ast?.type !== 'assert') continue;
    for (const c of cmps(r.ast.assert)) {
      if (c.cmp !== '==') continue;
      for (const [s, o] of [[c.l, c.r], [c.r, c.l]]) {
        if (!s?.fact || s.ctx !== 'nondim' || !rows.has(s.fact) || !o?.sumAxis || ownTotal(s.fact)) continue;
        const spec = o.sumAxis;
        const t = noteTable(spec.concept, spec.axis, spec.fixed);
        if (!t) continue;
        const prev = out.get(s.fact);
        // one link per statement figure: the rule over the same element first (share capital: SR-L374-1, not paid-up)
        if (prev && (prev.kind !== 'sum' || prev.target === s.fact || spec.concept !== s.fact)) continue;
        out.set(s.fact, { concept: s.fact, kind: 'sum', ruleId: r.id, spec, target: spec.concept, tableId: t.id, elrUri: t.presentationElr, preferredLabel: lineRow(t, spec.concept) });
      }
    }
  }
  // 2. the same element is a total in a note: a calculation total of the note, or a note table's total column
  for (const [q] of rows) {
    if (out.has(q) || ownTotal(q) || !nondimAllowed(A, q)) continue;
    let link = null;
    for (const e of notes) {
      const r = buildElrView(A, e.uri).rows.find((x) => x.kind === 'item' && x.concept === q);
      if (r && parentIn.get(q)?.has(code(e.uri))) { link = { concept: q, kind: 'row', target: q, elrUri: e.uri, preferredLabel: r.preferredLabel || null }; break; }
    }
    if (!link) {
      const t = A.tables.find((x) => A.elr(x.presentationElr)?.group === 'Notes' && x.axes.length && x.lineItems.includes(q) && totalColumnAllowed(A, x.id));
      if (t) link = { concept: q, kind: 'column', target: q, tableId: t.id, elrUri: t.presentationElr, preferredLabel: lineRow(t, q) };
    }
    if (link) out.set(q, link);
  }
  LINKS.set(A, out);
  return out;
}
// the statement figures derived from a note element (sum links), by the note element
const BYTARGET = new WeakMap();
export function statementLinksFrom(A, concept) {
  if (!BYTARGET.has(A)) {
    const m = new Map();
    for (const l of statementNoteLinks(A).values()) if (l.kind === 'sum') (m.get(l.target) || m.set(l.target, []).get(l.target)).push(l);
    BYTARGET.set(A, m);
  }
  return BYTARGET.get(A).get(concept) || [];
}
