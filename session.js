// Application controller: the only API the UI talks to. Enforces applicability and dimensional
// validity on every write (independently of any disabled UI control).
import { Filing, FactValueError, normDims, dimKey } from './model.js';
import { Applicability, ApplicabilityError } from './applicability.js';
import { checkDimensionSyntax, dimensionallyValid, nextTypedMember, nondimAllowed, unusableDefaultAxes } from './dimensions.js';
import { buildElrView, buildTableView, tableSlices, totalColumnAllowed, nondimRowConcepts, nondimRowElrs } from './views.js';
import { reportingYear, openingPeriodFor, scopeOf } from './periods.js';
import { carryingRuleFor, carryingTargetOf, rollForwardChangeOf, rollForwardClosingOf, statementNoteLinks, statementLinksFrom, derivations } from './derived.js';
import { sumAxisFacts } from './expr.js';
import { Gate, exportXml, SHARE_CAPITAL } from './gate.js';
import { RuleEngine } from './rules.js';
import { importInstance, CashFlowChoiceError } from './importer.js';
import { toDisplay } from './scaling.js';
import * as Dec from './decimal.js';

export class DimensionError extends Error { constructor(msg, details) { super(msg); this.details = details; } }
export class CalculatedCellError extends Error {}
// v14: the previous-year column carried in from last year's filed XML is locked until unlocked (meta.pyLocked)
export class PyLockedError extends Error {}
const PY_LOCKED = 'The previous year is locked: it carries last year\'s filed figures. Unlock the previous year (tab tools) to change it.';

// Calculation-network index from the taxonomy calculation linkbase (read-only; the arcs are never changed).
const CALC = new WeakMap();
function calcIndex(A) {
  if (CALC.has(A)) return CALC.get(A);
  const parentsByChild = new Map(), childrenOf = new Map(), byParent = new Map();
  for (const [elr, arcs] of Object.entries(A.json.calculation)) {
    const code = A.json.roles[elr]?.code?.slice(0, 6);
    for (const a of arcs) {
      (parentsByChild.get(a.to) || parentsByChild.set(a.to, []).get(a.to)).push({ elr, code, parent: a.from });
      const k = elr + '|' + a.from;
      (childrenOf.get(k) || childrenOf.set(k, []).get(k)).push(a);
      (byParent.get(a.from) || byParent.set(a.from, []).get(a.from)).push({ elr, code });
    }
  }
  // MCA sheet "Parent child exempt calculation" (rules.js calcExemptions): a total whose parts are ALL exempt (interest
  // expense, equity share warrants, refundable deposits, directors' remuneration, …) need not equal the sum of the parts
  // reported — it is filled from them while empty but stays editable (a "soft" total)
  const ex = new RuleEngine(A).calcExemptions();
  const soft = new Set();
  for (const [k, arcs] of childrenOf) if (arcs.every((a) => ex.has(a.to))) soft.add(k);
  const idx = { parentsByChild, childrenOf, byParent, soft };
  CALC.set(A, idx);
  return idx;
}

// v15.0 (the rule of the Ind AS tool v1.5): decimals of a calculated total — the accuracy of its least accurate part
// (XBRL), and the total's value is rounded to it (roundToDecimals), so it equals the total as presented in the
// statements. Before v15.0 every digit of the exact sum was kept: share capital 412.356 lakhs (to ₹100) plus amounts
// to 2 places (to ₹1,000) gave a total of 8,299.706 where the balance sheet shows 8,299.71 — and Total equity and
// liabilities no longer equalled Total assets (SR-L28-1) by 0.004 lakhs.
// - a part that is 0 carries no rounding (a 0 typed next to amounts to 4 places does not make the total coarser)
// - a total is never rounded to fewer places than the statement figures (floor = Filing.statementDecimals): the digits
//   its exact sum carries down to that accuracy are kept (a part imported at decimals="-4" next to parts at "-3" keeps
//   a non-zero thousands digit — Filing Manual #13 non-significant digits)
// - every part as accurate as the total's own digits (e.g. all to 4 places): nothing is rounded
// - C&I: a part reported as exact (decimals="INF", as in an imported instance — e.g. figures with paise in a filing in
//   rupees) is presented with all its digits: the total keeps them too (the floor is raised to them), as before v15.0
// - C&I: share capital (floor 'EXACT', floorFor below) is the actual value (MCA): the sum of its classes keeps every digit,
//   as before v15.0, also while a class is still declared coarser (that class carries the share-capital warning and its
//   fix "Confirm as the actual value"); the totals above share capital are rounded as any other
export function sumDecimals(facts, total, floor = null) {
  const nonZero = facts.filter((x) => !(x.value != null && Dec.isDecimalString(String(x.value)) && Dec.isZero(Dec.parse(x.value))));
  const decs = nonZero.map((x) => x.decimals).filter((d) => d != null && d !== 'INF').map(Number);
  if (!decs.length) return 'INF';
  const min = Math.min(...decs);
  if (floor === 'EXACT') { const need = Dec.requiredDecimals(total); return String(Math.max(min, need === Infinity ? -Infinity : need)); }
  if (floor == null || !Number.isFinite(Number(floor))) return String(min);
  for (const x of nonZero) {
    if (x.decimals !== 'INF' || x.value == null || !Dec.isDecimalString(String(x.value))) continue;
    const r = Dec.requiredDecimals(Dec.parse(x.value));
    if (r !== Infinity) floor = Math.max(Number(floor), r);
  }
  const req = Dec.requiredDecimals(total);
  return String(Math.max(min, Math.min(Number(floor), req === Infinity ? min : req)));
}
export const roundToDecimals = (total, decimals) => (decimals == null || decimals === 'INF' ? total : Dec.round(total, Number(decimals)));
// the floor of sumDecimals for a calculated value of this element
const floorFor = (filing, concept) => (SHARE_CAPITAL.has(String(concept).split(':').pop()) ? 'EXACT' : filing.statementDecimals(concept));
// the display value a user typed equals what the cell shows (numbers compared as numbers)
function sameDisplay(S, fact, display) {
  if (!fact || fact.nil || display == null) return false;
  const shown = String(S.displayOf(fact)).replace(/,/g, '').trim(), typed = String(display).replace(/,/g, '').trim();
  if (typed === '') return false;
  if (S.A.isNumeric(fact.concept)) return Dec.isDecimalString(typed) && Dec.isDecimalString(shown) && Dec.eq(Dec.parse(typed), Dec.parse(shown));
  return typed === shown;
}
// a total agrees with the sum of its parts when equal after rounding both to the total's decimals (XBRL Calculations 1.1)
function agrees(x, sum) {
  const d = x.decimals == null || x.decimals === 'INF' ? 'INF' : Number(x.decimals);
  return Dec.eq(Dec.round(Dec.parse(x.value), d), Dec.round(sum.total, d));
}

export class Session {
  constructor(A, filing = null) {
    this.A = A;
    this.app = new Applicability(A);
    this.filing = filing || new Filing(A);
    this._views = new Map();
  }

  // ---- filing setup: meta values are mirrored into the general-information facts
  setMeta(patch) {
    const oldCyEnd = this.filing.meta.periods?.cy?.end;
    Object.assign(this.filing.meta, patch);
    if (patch.periods) this.filing.meta.periods = { ...this.filing.meta.periods, ...patch.periods };
    const f = this.filing, A = this.A, P = f.meta.periods;
    // a "Current year only" import treats previous-year-end opening balances as current-year cells; once the
    // current year is moved (next year's filing prepared from it) both years are ordinary filing years
    if (f.meta.yearMode === 'current' && oldCyEnd && P.cy?.end && P.cy.end !== oldCyEnd) f.meta.yearMode = 'both';
    const mirror = (local, value, scopes = ['CY']) => {
      const q = A.qnameOfLocal(local);
      if (!q || value == null || value === '') return;
      for (const s of scopes) { const p = f.period(q, s); if (p) f.setFact({ concept: q, period: p, value, origin: 'meta', lang: A.isNumeric(q) ? null : 'en' }); }
    };
    if (P.cy.start && P.cy.end) {
      mirror('CorporateIdentityNumber', f.meta.cin);
      mirror('NatureOfReportStandaloneConsolidated', f.meta.reportType);
      mirror('LevelOfRoundingUsedInFinancialStatements', f.meta.level);
      mirror('DateOfStartOfReportingPeriod', P.cy.start);
      mirror('DateOfEndOfReportingPeriod', P.cy.end);
      if (!f.meta.firstFinancialYear && P.py.start && P.py.end) {
        const qs = A.qnameOfLocal('DateOfStartOfReportingPeriod'), qe = A.qnameOfLocal('DateOfEndOfReportingPeriod');
        f.setFact({ concept: qs, period: f.period(qs, 'PY'), value: P.py.start, origin: 'meta' });
        f.setFact({ concept: qe, period: f.period(qe, 'PY'), value: P.py.end, origin: 'meta' });
      }
    }
    f.revision++;
  }

  elrView(uri) { if (!this._views.has(uri)) this._views.set(uri, buildElrView(this.A, uri)); return this._views.get(uri); }
  tableView(id) { const k = 'T' + id; if (!this._views.has(k)) this._views.set(k, buildTableView(this.A, id)); return this._views.get(k); }

  elrStatus(uri, scope) { return this.app.elrStatus(this.filing, uri, scope); }
  conceptStatus(q, scope) { return this.app.conceptStatus(this.filing, q, scope); }
  tableStatus(id, scope) { return this.app.tableStatus(this.filing, id, scope); }

  // ---- non-dimensional values
  periodForCell(concept, scope, preferredLabel) {
    const c = this.A.concept(concept);
    if (c.periodType === 'instant' && preferredLabel === 'periodStartLabel') return openingPeriodFor(this.filing.meta.periods, scope);
    return this.filing.period(concept, scope);
  }
  getValue(concept, scope, dims = [], preferredLabel = null) {
    const p = this.periodForCell(concept, scope, preferredLabel);
    return p ? this.filing.get(concept, p, dims) : null;
  }
  displayOf(fact) {
    if (!fact || fact.nil) return '';
    return this.A.dataType(fact.concept) === 'monetary' ? toDisplay(fact.value, this.filing.meta.level) : fact.value;
  }
  // Editing options (UI): tab = the filing tab (ELR) the cell is on — its applicability decides (cellStatus);
  // recalc = re-derive calculated parent cells; override = the tab's "edit calculated cells" option is on.
  pyLocked(scope, unlockPY = false) { return scope === 'PY' && !!this.filing.meta.pyLocked && !unlockPY; }
  setValue(concept, scope, display, { preferredLabel = null, tab = null, recalc = false, override = false, unlockPY = false, strict = false } = {}) {
    if (this.pyLocked(scope, unlockPY)) throw new PyLockedError(PY_LOCKED);
    const st = tab ? this.app.cellStatus(this.filing, tab, concept, scope) : this.app.conceptStatus(this.filing, concept, scope);
    if (!st.applicable) throw new ApplicabilityError(`${concept} is not applicable for ${scope}`, st.reasons);
    if (!nondimAllowed(this.A, concept)) throw new DimensionError(`${concept} can only be reported inside its table`);
    const lock = tab && !override ? this.calculatedCell(concept, scope, [], tab, preferredLabel) : null;
    if (lock && !(lock.note && this.nilAllowed(lock.note, concept, scope, display, preferredLabel))) {
      const cur = this.getValue(concept, scope, [], preferredLabel);
      if (sameDisplay(this, cur, display)) return cur; // typing the value it already shows is not an error
      if (lock.note) throw new CalculatedCellError(`${this.A.label(concept)} is taken from its note — enter it there, or enable editing of calculated cells for this tab to override it`);
      throw new CalculatedCellError(`${this.A.label(concept)} is calculated from its child elements — enable editing of calculated cells for this tab to override it`);
    }
    const p = this.periodForCell(concept, scope, preferredLabel);
    if (!p) throw new FactValueError('Reporting periods are not set');
    const before = this.filing.get(concept, p, []);
    const was = before && !before.nil ? before.value : null;
    const calc = override && tab ? this.calculatedCell(concept, scope, [], tab, preferredLabel) : null;
    const f = this.filing.setDisplayValue({ concept, period: p, display, strict }); // v14.3 strict: typed digits never rounded
    if (f && calc) f.origin = 'override';
    if (recalc) this.recalcFrom(concept, p, [], 0, { before: was, after: f && !f.nil ? f.value : null });
    return f;
  }

  // ---- calculated (auto-populated) cells
  // A cell is calculated when the tab's own calculation network (same ELR code) defines the concept as a parent
  // with at least one child that can be reported in the cell's context, and that network applies to the filing.
  // Locked (read-only, recalculated) only where the arithmetic is required and a part has a value: a total of the
  // tab's own calculation network that is not MCA-exempt, once at least one of its parts has a value in the cell's
  // context; a carrying amount once its gross or accumulated cell has a value. A total without any part entered is an
  // ordinary input cell (e.g. an opening balance whose breakup is not reported) — GR-1 tells when parts are required.
  calculatedCell(concept, scope, dims = [], tabElrUri = null, preferredLabel = null) {
    const A = this.A, f = this.filing;
    const idx = calcIndex(A);
    const code = tabElrUri ? A.elr(tabElrUri)?.code.slice(0, 6) : null;
    const nd = normDims(dims);
    const p = this.periodForCell(concept, scope, preferredLabel);
    if (!p) return null;
    // a main-statement figure supplied by its note (derived.js statementNoteLinks) is read-only on the statement —
    // also while empty — whenever its note can be opened: it is entered (or derived) there. A different figure that
    // was entered or imported stays editable (the MCA rule reports the difference to the note).
    const nl = nd.length ? null : this.noteLink(concept, scope, tabElrUri);
    if (nl) {
      const x = f.get(concept, p, []);
      if (nl.kind !== 'sum') return { note: nl, children: [] };
      const v = this.noteValue(nl, scope);
      // the note's values cannot be added up (an unusual layout): the figure is entered on the statement
      if (!v?.undetermined) {
        if (!x || x.nil || x.origin === 'calculated' || x.origin === 'override') return { note: nl, children: [] };
        // an entered/imported figure: read-only when it agrees with the note, or is a nil (0) while the note is empty;
        // another figure with an empty note is the filer's own (editable) until the note is entered — then it follows
        if (v ? agrees(x, v) : Dec.eq(Dec.parse(x.value), Dec.ZERO)) return { note: nl, children: [] };
      }
    }
    for (const { elr, code: c } of idx.byParent.get(concept) || []) {
      if (code && c !== code) continue;
      if (idx.soft.has(elr + '|' + concept)) continue;
      const pres = A.elrs.find((e) => e.code === c);
      if (pres && !this.app.elrStatus(f, pres.uri, scope).applicable) continue;
      const sum = this.networkSum(elr, concept, p, nd);
      if (!sum.count) continue;
      // maintained by the tool: empty, calculated, or agreeing with its parts; a different figure that was entered
      // or imported is the filer's own and stays editable (GR-1 reports the difference)
      // an empty cell is never locked (the tool fills it as soon as a part changes; until then it can be typed)
      const x = f.get(concept, p, nd);
      if (x && !x.nil && (x.origin === 'calculated' || x.origin === 'override' || agrees(x, sum))) return { elr, children: (idx.childrenOf.get(elr + '|' + concept) || []).map((a) => a.to) };
    }
    return this.derivedCell(concept, scope, dims, preferredLabel, tabElrUri);
  }
  // Locked cells derived outside the calculation linkbase (derived.js): carrying amount = gross − accumulated (MCA
  // SR-L1364-2 / SR-L1380-1 …), when the gross or accumulated cell of the same row/column has a value. The closing
  // balance (opening + changes) is not an MCA rule: it is filled while empty and stays editable (applyDerived soft).
  derivedCell(concept, scope, dims = [], preferredLabel = null, tabElrUri = null) {
    const A = this.A, f = this.filing;
    if (!A.isNumeric(concept)) return null;
    const nd = normDims(dims);
    // a statement figure (e.g. Tangible assets on the balance sheet) is never locked on the statement by a note's
    // derivation: it can always be typed there; the note's MCA rule reports a difference
    if (!nd.length && tabElrUri && nondimRowElrs(A).get(concept)?.has(tabElrUri)) return null;
    const p = this.periodForCell(concept, scope, preferredLabel);
    if (!p) return null;
    if (this.statementFigure(concept, p, nd)) return null;
    const r = carryingRuleFor(A, concept, nd);
    if (r && [...r.plusDims, ...r.minusDims].some((d) => f.get(concept, p, normDims(d)))) {
      // maintained only while empty, calculated or agreeing; a different value that was entered stays editable and
      // MCA SR-L1364-2 / SR-L1380-1 point to it
      const x = f.get(concept, p, nd);
      const v = this.carryingValue(concept, p, nd);
      if (!x || x.nil) return null; // empty: never locked
      if (x.origin !== 'calculated' && x.origin !== 'override' && v && !Dec.eq(Dec.parse(x.value), Dec.parse(v.value))) return null;
      return { derived: 'carrying', rules: r.rules, children: [] };
    }
    return null;
  }
  // Σ(child × weight) of the parts reported for one total of one calculation network
  networkSum(elr, parent, period, nd, override = null) {
    const f = this.filing;
    const kids = (calcIndex(this.A).childrenOf.get(elr + '|' + parent) || []).map((a) => ({ a, fact: override && a.to === override.concept ? override.fact : f.get(a.to, period, nd) })).filter((k) => k.fact && !k.fact.nil);
    const total = Dec.sum(kids.map((k) => Dec.mul(Dec.parse(k.fact.value), Dec.parse(String(k.a.weight)))));
    const decimals = sumDecimals(kids.map((k) => k.fact), total, floorFor(f, parent)); // v15.0
    return { count: kids.length, total: roundToDecimals(total, decimals), decimals, unit: kids[0]?.fact.unit, kids };
  }
  // Re-derive the calculation parents of an edited cell (same period and dimensions), bottom-up. The parent is
  // Σ(child × weight) of the children reported in its network. A total FOLLOWS its parts when it is empty, calculated,
  // or agreed with its parts before this edit; a total that was entered or imported with a different value is the
  // filer's own figure and is kept (GR-1 shows the difference at that cell, which stays editable) — so the result does
  // not depend on the order in which totals and parts are typed. A manual override is never replaced.
  // change = { before, after } values of the edited cell; force (explicit Recalculate) makes every total follow.
  recalcFrom(concept, period, dims = [], depth = 0, change = null, { force = false } = {}) {
    if (depth > 40) return;
    const A = this.A, f = this.filing, idx = calcIndex(A);
    const nd = normDims(dims);
    const seen = new Set();
    for (const { elr, code, parent } of idx.parentsByChild.get(concept) || []) {
      if (seen.has(parent)) continue;
      const pc = A.concept(parent);
      if (!pc || (pc.periodType === 'instant') !== (period.type === 'instant')) continue;
      const pres = A.elrs.find((e) => e.code === code);
      const scope = reportingYear(f.meta.periods, period);
      if (scope !== 'CY' && scope !== 'PY') continue;
      if (pres && !this.app.elrStatus(f, pres.uri, scope).applicable) continue;
      if (!this.app.conceptStatus(f, parent, scope).applicable) continue;
      if (nd.length ? !dimensionallyValid(A, parent, nd).valid : !nondimAllowed(A, parent)) continue;
      const existing = f.get(parent, period, nd);
      if (existing && existing.origin === 'override') { seen.add(parent); continue; }
      const now = this.networkSum(elr, parent, period, nd);
      const typed = existing && !existing.nil && existing.origin !== 'calculated';
      if (typed && !force) {
        // an MCA-exempt total keeps a value that was entered (soft); another total keeps it unless it agreed with its
        // parts before this edit
        if (idx.soft.has(elr + '|' + parent)) { seen.add(parent); continue; }
        const old = change && concept !== parent ? this.networkSum(elr, parent, period, nd, { concept, fact: change.before == null ? null : { value: change.before, decimals: 'INF', nil: false } }) : null;
        if (!old || !old.count || !agrees(existing, old)) { seen.add(parent); continue; }
      }
      seen.add(parent);
      if (!now.count) { if (existing && existing.origin === 'calculated') { f.removeFact(existing.key); this.recalcFrom(parent, period, nd, depth + 1, { before: existing.value, after: null }, { force }); } continue; }
      const value = Dec.toString(now.total);
      // an identical value is left as it is (keeps its origin, e.g. an imported total)
      if (!(existing && !existing.nil && existing.value === value && existing.decimals === now.decimals)) f.setFact({ concept: parent, period, dims: nd, value, decimals: now.decimals, unit: now.unit, origin: 'calculated' });
      this.recalcFrom(parent, period, nd, depth + 1, { before: existing && !existing.nil ? existing.value : null, after: value }, { force });
    }
    this.deriveFrom(concept, period, nd, depth, force, change);
  }

  // Re-derive the cells derived from an edited cell (derived.js): the carrying-amount cell of a gross/accumulated
  // cell, and the current-year closing balance of a reconciliation when its net change or opening balance changes.
  deriveFrom(concept, period, nd, depth, force = false, change = null) {
    const A = this.A, f = this.filing;
    if (!A.isNumeric(concept)) return;
    this.deriveStatements(concept, period, nd, depth, force, change);
    const td = carryingTargetOf(A, concept, nd);
    if (td) {
      const tdn = normDims(td);
      // the carrying amount before this edit: an entered carrying value follows only if it agreed with it
      const prior = () => {
        if (!change) return null;
        const now = this.carryingValue(concept, period, tdn);
        if (!now) return null;
        const r = carryingRuleFor(A, concept, tdn);
        const minus = r.minusDims.some((d) => dimKey(normDims(d)) === dimKey(nd));
        const delta = Dec.sub(change.after == null ? Dec.ZERO : Dec.parse(change.after), change.before == null ? Dec.ZERO : Dec.parse(change.before));
        return minus ? Dec.add(Dec.parse(now.value), delta) : Dec.sub(Dec.parse(now.value), delta);
      };
      this.applyDerived(concept, period, tdn, depth, () => this.carryingValue(concept, period, tdn), { force, prior });
    }
    const P = f.meta.periods;
    const s = scopeOf(P, period);
    const closing = rollForwardClosingOf(A, concept);
    if (closing && s === 'CY' && period.type === 'duration') { const cp = f.period(closing, 'CY'); if (cp) this.applyDerived(closing, cp, nd, depth, () => this.rollForwardValue(closing, nd), { soft: true, force }); }
    if (s === 'PY' && period.type === 'instant' && rollForwardChangeOf(A, concept)) { const cp = f.period(concept, 'CY'); if (cp) this.applyDerived(concept, cp, nd, depth, () => this.rollForwardValue(concept, nd), { soft: true, force }); }
  }
  carryingValue(concept, period, dims) {
    const r = carryingRuleFor(this.A, concept, dims);
    if (!r) return undefined;
    const get = (d) => { const x = this.filing.get(concept, period, normDims(d)); return x && !x.nil ? x : null; };
    const plus = r.plusDims.map(get).filter(Boolean), minus = r.minusDims.map(get).filter(Boolean);
    if (!plus.length && !minus.length) return null;
    const v = Dec.sub(Dec.sum(plus.map((x) => Dec.parse(x.value))), Dec.sum(minus.map((x) => Dec.parse(x.value))));
    return { value: Dec.toString(v), from: [...plus, ...minus] };
  }
  rollForwardValue(concept, dims) {
    const A = this.A, f = this.filing;
    const ch = rollForwardChangeOf(A, concept);
    const cf = f.get(ch, f.period(ch, 'CY'), dims);
    if (!cf || cf.nil) return null;
    // the carrying column of an asset reconciliation follows gross − accumulated when those closings exist
    const r = carryingRuleFor(A, concept, dims);
    if (r && [...r.plusDims, ...r.minusDims].some((d) => f.get(concept, f.period(concept, 'CY'), normDims(d)))) return undefined;
    const open = f.get(concept, f.period(concept, 'PY'), dims);
    const v = Dec.add(open && !open.nil ? Dec.parse(open.value) : Dec.ZERO, Dec.parse(cf.value));
    return { value: Dec.toString(v), from: [cf, ...(open && !open.nil ? [open] : [])] };
  }
  // set (or clear) one derived cell; undefined = another derivation owns the cell, null = no sources left
  applyDerived(concept, period, dims, depth, compute, { soft = false, force = false, prior = null } = {}) {
    const A = this.A, f = this.filing;
    const scope = reportingYear(f.meta.periods, period);
    if (scope !== 'CY' && scope !== 'PY') return;
    if (!this.app.conceptStatus(f, concept, scope).applicable) return;
    if (dims.length ? !dimensionallyValid(A, concept, dims).valid : !nondimAllowed(A, concept)) return;
    const existing = f.get(concept, period, dims);
    if (existing && existing.origin === 'override') return;
    if (this.statementFigure(concept, period, dims)) return;
    // soft (closing balance): an entered value is kept — audited closings may differ from opening + changes by rounding
    if (soft && !force && existing && !existing.nil && existing.origin !== 'calculated') return;
    // an entered value is kept unless it agreed with the derivation before this edit (order-independent, never stuck)
    if (!soft && !force && existing && !existing.nil && existing.origin !== 'calculated') {
      const before = prior ? prior() : null;
      if (!before || !Dec.eq(Dec.parse(existing.value), before)) return;
    }
    let res = compute();
    if (res === undefined) return;
    if (res === null) {
      if (existing && existing.origin === 'calculated') { f.removeFact(existing.key); this.recalcFrom(concept, period, dims, depth + 1, { before: existing.value, after: null }, { force }); }
      return;
    }
    // v15.0: rounded to the accuracy of its least accurate part, as totals are (sumDecimals)
    const decimals = sumDecimals(res.from, Dec.parse(res.value), floorFor(f, concept));
    res = { ...res, value: Dec.toString(roundToDecimals(Dec.parse(res.value), decimals)) };
    if (existing && !existing.nil && existing.value === res.value && existing.decimals === decimals) return;
    f.setFact({ concept, period, dims, value: res.value, decimals, unit: res.from[0].unit, origin: 'calculated' });
    this.recalcFrom(concept, period, dims, depth + 1, { before: existing && !existing.nil ? existing.value : null, after: res.value }, { force });
  }

  // A figure of a statement (its own non-dimensional row, e.g. Tangible assets / Share capital on the balance sheet)
  // that was entered or imported is kept: a note's total column is the same fact, and the note must agree with the
  // statement — MCA rules SR-L1364-2 / SR-L1381-2 / SR-L374-1 … report a difference at the note. It is derived only
  // while empty or itself calculated.
  statementFigure(concept, period, dims) {
    if (dims.length || !nondimRowConcepts(this.A).has(concept)) return false;
    const x = this.filing.get(concept, period, []);
    return !!x && !x.nil && x.origin !== 'calculated' && x.origin !== 'override';
  }

  // ---- main-statement figures supplied by their notes (derived.js statementNoteLinks)
  // the link of a statement cell, when the cell is on a main statement and its note can be opened for the year
  noteLink(concept, scope, tabElrUri) {
    const A = this.A, f = this.filing;
    if (!tabElrUri || A.elr(tabElrUri)?.group !== 'Statements') return null;
    const l = statementNoteLinks(A).get(concept);
    if (!l) return null;
    const ok = l.kind === 'row' ? this.app.cellStatus(f, l.elrUri, l.target, scope).applicable
      : this.app.tableStatus(f, l.tableId, scope).applicable && this.app.conceptStatus(f, l.target, scope).applicable;
    return ok ? l : null;
  }
  // statement figures that differ from the note they are taken from (sum links; tool guidance shown on Validation)
  statementNoteDifferences() {
    const A = this.A, f = this.filing, out = [];
    for (const l of statementNoteLinks(A).values()) {
      if (l.kind !== 'sum') continue;
      for (const scope of ['CY', 'PY']) {
        const p = f.period(l.concept, scope);
        const x = p && f.get(l.concept, p, []);
        if (!x || x.nil || !this.app.conceptStatus(f, l.concept, scope).applicable) continue;
        const v = this.noteValue(l, scope);
        if (!v || v.undetermined || agrees(x, v)) continue;
        out.push({ concept: l.concept, scope, value: x.value, note: Dec.toString(v.total), difference: Dec.toString(Dec.sub(Dec.parse(x.value), v.total)), link: l, cellId: x.key });
      }
    }
    return out;
  }
  // v14 health check: a cell the tool calculated itself (origin 'calculated') that no longer equals its derivation —
  // a total of its parts (taxonomy calculation), a carrying amount (gross − accumulated) or a closing balance (opening
  // + changes) — is re-derived. Only the tool's own values: entered, imported and manual figures are never touched;
  // a calculated value whose parts are all gone is left as it is (reported, not removed).
  refreshCalculatedCells() {
    const A = this.A, f = this.filing, idx = calcIndex(A), changed = [];
    const expected = (x) => {
      const scope = reportingYear(f.meta.periods, x.period);
      if (scope !== 'CY' && scope !== 'PY') return undefined;
      // v15.0: each candidate with its accuracy, rounded as the tool calculates it (sumDecimals): a total calculated before
      // v15.0 with every digit of its exact sum (3,996.122 where the statements show 3,996.12) is re-derived
      const derived = (v) => { const d = sumDecimals(v.from, Dec.parse(v.value), floorFor(f, x.concept)); return { value: Dec.toString(roundToDecimals(Dec.parse(v.value), d)), decimals: d }; };
      const cands = [];
      const r = carryingRuleFor(A, x.concept, x.dims);
      if (r && [...r.plusDims, ...r.minusDims].some((d) => f.get(x.concept, x.period, normDims(d)))) { const v = this.carryingValue(x.concept, x.period, x.dims); if (v) cands.push(derived(v)); }
      for (const { elr, code } of idx.byParent.get(x.concept) || []) {
        if (idx.soft.has(elr + '|' + x.concept)) continue;
        const pres = A.elrs.find((e) => e.code === code);
        if (pres && !this.app.elrStatus(f, pres.uri, scope).applicable) continue;
        const sum = this.networkSum(elr, x.concept, x.period, x.dims);
        if (sum.count) cands.push({ value: Dec.toString(sum.total), decimals: sum.decimals });
      }
      if (scope === 'CY' && x.period.type === 'instant' && rollForwardChangeOf(A, x.concept)) { const v = this.rollForwardValue(x.concept, x.dims); if (v) cands.push(derived(v)); }
      if (!cands.length) return undefined;
      return cands.some((c) => Dec.eq(Dec.parse(c.value), Dec.parse(x.value))) ? null : cands[0];
    };
    for (let pass = 0; pass < 6; pass++) {
      let n = 0;
      for (const x of f.all()) {
        if (x.origin !== 'calculated' || x.nil || !A.isNumeric(x.concept) || this.statementFigure(x.concept, x.period, x.dims)) continue;
        const c = expected(x);
        if (c == null) continue;
        const v = c.value;
        f.setFact({ concept: x.concept, period: x.period, dims: x.dims, value: v, decimals: c.decimals, unit: x.unit, origin: 'calculated' });
        this.recalcFrom(x.concept, x.period, x.dims, 0, { before: x.value, after: v });
        changed.push({ concept: x.concept, period: x.period, dims: x.dims, before: x.value, after: v });
        n++;
      }
      if (!n) break;
    }
    return changed;
  }
  // v14 fixes: the sum of the parts of a total (its first applicable calculation network with parts in this context)
  totalFromParts(parent, period, dims = []) {
    const A = this.A, f = this.filing, idx = calcIndex(A), nd = normDims(dims);
    const scope = reportingYear(f.meta.periods, period);
    for (const { elr, code } of idx.byParent.get(parent) || []) {
      const pres = A.elrs.find((e) => e.code === code);
      if (pres && (scope === 'CY' || scope === 'PY') && !this.app.elrStatus(f, pres.uri, scope).applicable) continue;
      const sum = this.networkSum(elr, parent, period, nd);
      if (sum.count) return { value: Dec.toString(sum.total), decimals: sum.decimals, unit: sum.unit, elr };
    }
    return null;
  }
  // the calculation parents of an element that can be reported in this context (GR-1: a part entered needs its total)
  calcParentsOf(concept, period, dims = []) {
    const A = this.A, idx = calcIndex(A), nd = normDims(dims);
    const pt = A.concept(concept)?.periodType;
    return [...new Set((idx.parentsByChild.get(concept) || []).map((p) => p.parent))].filter((q) => A.concept(q)?.periodType === pt && (nd.length ? dimensionallyValid(A, q, nd).valid : nondimAllowed(A, q)));
  }
  // set a total to the sum of its parts (a tool fix the user confirms); what is derived from it follows
  setTotalFromParts(parent, period, dims = [], { unlockPY = false } = {}) {
    const f = this.filing, nd = normDims(dims);
    if (this.pyLocked(reportingYear(f.meta.periods, period), unlockPY)) throw new PyLockedError(PY_LOCKED);
    const t = this.totalFromParts(parent, period, nd);
    if (!t) return null;
    const before = f.get(parent, period, nd);
    const x = f.setFact({ concept: parent, period, dims: nd, value: t.value, decimals: t.decimals, unit: t.unit, origin: 'calculated' });
    this.recalcFrom(parent, period, nd, 0, { before: before && !before.nil ? before.value : null, after: t.value });
    return x;
  }
  // a nil balance (0) may be reported on the statement while its note holds no value for it: nothing to disclose
  nilAllowed(link, concept, scope, display, preferredLabel = null) {
    const t = String(display ?? '').replace(/,/g, '').trim();
    if (!Dec.isDecimalString(t) || !Dec.eq(Dec.parse(t), Dec.ZERO)) return false;
    if (link.kind === 'sum') return this.noteValue(link, scope) === null;
    const cur = this.getValue(concept, scope, [], preferredLabel);
    return !cur || cur.nil || Dec.eq(Dec.parse(cur.value), Dec.ZERO);
  }
  // Σ of the note element the MCA rule adds up (sum links): { total, decimals, unit, count }, null when the note has
  // no value for it, or { undetermined: true } when its values cannot be added up.
  // The MCA rule sums the element over one axis (with fixed members). Filings often report one more axis of the note
  // table as well (secured / unsecured borrowings, security classification of loans): the value of a member is its
  // column without that axis when reported, else the sum of that axis' first-level members (a first-level member not
  // reported replaced by its reported descendants — the MCA rule's own reading of a level). An axis whose members are
  // not added up (gross / accumulated depreciation → carrying amount, MCA member-difference rules) is never summed.
  noteValue(link, scope, filing = this.filing) {
    const A = this.A, spec = link.spec;
    const period = filing.period(spec.concept, scope);
    if (!period) return null;
    const same = (p) => JSON.stringify(p) === JSON.stringify(period);
    const fixed = spec.fixed || {};
    const arith = new Set(derivations(A).arith.keys());
    const facts = filing.factsOf(spec.concept).filter((x) => !x.nil && x.value != null && same(x.period) && x.dims.some((d) => d.axis === spec.axis) && Object.entries(fixed).every(([ax, mem]) => x.dims.some((d) => d.axis === ax && d.member === mem)));
    if (!facts.length) return null;
    const extraOf = (x) => x.dims.filter((d) => d.axis !== spec.axis && !(d.axis in fixed));
    const memberKey = (x) => { const d = x.dims.find((y) => y.axis === spec.axis); return d.member ?? `"${d.typed}"`; };
    const byM = new Map();
    for (const x of facts) (byM.get(memberKey(x)) || byM.set(memberKey(x), []).get(memberKey(x))).push(x);
    const collapsed = [];
    for (const [, list] of byM) {
      const total = list.find((x) => !extraOf(x).length);
      if (total) { collapsed.push(total); continue; }
      // members reported only on a non-added axis (e.g. gross without its carrying amount) give no value here
      const one = list.filter((x) => extraOf(x).length === 1 && !arith.has(extraOf(x)[0].axis) && extraOf(x)[0].member);
      const axes = new Set(one.map((x) => extraOf(x)[0].axis));
      if (!one.length) { if (list.every((x) => extraOf(x).some((d) => arith.has(d.axis)))) continue; return { undetermined: true }; }
      if (axes.size !== 1 || one.length !== list.filter((x) => !extraOf(x).some((d) => arith.has(d.axis))).length) return { undetermined: true };
      const E = [...axes][0], info = A.axisInfo(E);
      const kids = new Map();
      for (const [mm, pp] of info.parents) (kids.get(pp) || kids.set(pp, []).get(pp)).push(mm);
      const roots = [...info.members.values()].filter((mm) => !info.parents.has(mm.member)).map((mm) => mm.member);
      const onE = new Map(one.map((x) => [extraOf(x)[0].member, x]));
      const picked = [];
      const take = (mm) => { if (onE.has(mm)) { picked.push(onE.get(mm)); return; } for (const c of kids.get(mm) || []) take(c); };
      for (const r of roots) for (const c of kids.get(r) || []) take(c);
      if (!picked.length) return { undetermined: true };
      const decs = picked.map((x) => x.decimals).filter((d) => d != null && d !== 'INF').map(Number);
      collapsed.push({ ...picked[0], dims: picked[0].dims.filter((d) => d.axis !== E), value: Dec.toString(Dec.sum(picked.map((x) => Dec.parse(x.value)))), decimals: decs.length ? String(Math.min(...decs)) : 'INF' });
    }
    const src = { period: (q, sc) => filing.period(q, sc), factsOf: (q) => (q === spec.concept ? collapsed : filing.factsOf(q)) };
    const picked = sumAxisFacts(spec, { filing: src, A, scope }) || [];
    if (!picked.length) return null;
    const total = Dec.sum(picked.map((x) => Dec.parse(x.value)));
    const decimals = sumDecimals(picked, total, floorFor(this.filing, spec.concept)); // v15.0
    return { total: roundToDecimals(total, decimals), decimals, unit: picked[0].unit, count: picked.length };
  }
  // re-derive the statement figure(s) taken from an edited note element (sum links). Follows the same principle as
  // totals: an empty or calculated figure follows; an entered/imported figure follows only if it agreed with the note
  // before this edit; a manual override is never replaced.
  deriveStatements(concept, period, nd, depth, force, change) {
    const A = this.A, f = this.filing;
    for (const l of statementLinksFrom(A, concept)) {
      if (l.concept === concept && !nd.length) continue; // the statement figure itself
      const scope = reportingYear(f.meta.periods, period);
      if (scope !== 'CY' && scope !== 'PY') continue;
      const sp = f.period(l.target, scope);
      if (!sp || JSON.stringify(sp) !== JSON.stringify(period)) continue;
      const tp = f.period(l.concept, scope);
      if (!tp || !this.app.conceptStatus(f, l.concept, scope).applicable || !nondimAllowed(A, l.concept)) continue;
      const existing = f.get(l.concept, tp, []);
      if (existing && existing.origin === 'override') continue;
      if (existing && !existing.nil && existing.origin !== 'calculated' && !force) {
        if (!change) continue;
        // the note's sum before this edit: the edited fact at its previous value
        const key = dimKey(nd);
        const prior = { period: (q, sc) => f.period(q, sc), factsOf: (q) => { const list = f.factsOf(q).filter((x) => !(x.concept === concept && dimKey(x.dims) === key && JSON.stringify(x.period) === JSON.stringify(period))); return change.before == null ? list : [...list, { concept, period, dims: nd, value: change.before, decimals: 'INF', nil: false }]; } };
        const old = this.noteValue(l, scope, prior);
        // follows when the note was empty before this edit, or agreed with it
        if (old && (old.undetermined || !agrees(existing, old))) continue;
      }
      const now = this.noteValue(l, scope);
      if (!now || now.undetermined) {
        if (existing && existing.origin === 'calculated') { f.removeFact(existing.key); this.recalcFrom(l.concept, tp, [], depth + 1, { before: existing.value, after: null }, { force }); }
        continue;
      }
      const value = Dec.toString(now.total);
      if (existing && !existing.nil && existing.value === value && existing.decimals === now.decimals) continue;
      f.setFact({ concept: l.concept, period: tp, dims: [], value, decimals: now.decimals, unit: now.unit, origin: 'calculated' });
      this.recalcFrom(l.concept, tp, [], depth + 1, { before: existing && !existing.nil ? existing.value : null, after: value }, { force });
    }
  }

  // Recalculate every calculated / derived cell of the given scopes from the values entered (explicit user action).
  // Previous-year values (last year's filed figures) are not touched unless 'PY' is asked for. A manual override is
  // never replaced. With apply=false the filing is left unchanged and the changes are only reported.
  recalculateAll({ scopes = ['CY'], apply = true, force = true } = {}) {
    const A = this.A, f = this.filing;
    const before = new Map(f.facts);
    for (let pass = 0; pass < 3; pass++) {
      const rev = f.revision;
      const sources = f.all().filter((x) => !x.nil && A.isNumeric(x.concept) && scopes.includes(f.scopeOf(x.period)));
      for (const x of sources) if (f.facts.get(x.key)) this.recalcFrom(x.concept, x.period, x.dims, 0, null, { force });
      if (f.revision === rev) break;
    }
    const changes = [];
    for (const [k, x] of f.facts) { const b = before.get(k); if (!b) changes.push({ key: k, before: null, after: x }); else if (b !== x && (b.value !== x.value || b.nil !== x.nil)) changes.push({ key: k, before: b, after: x }); }
    for (const [k, b] of before) if (!f.facts.has(k)) changes.push({ key: k, before: b, after: null });
    if (!apply) { f.facts = before; f.revision++; }
    return { changes };
  }

  // ---- tables (authoritative controller layer)
  openTable(tableId, scope) {
    this.app.assertTableOpen(this.filing, tableId, scope);
    const view = this.tableView(tableId);
    const slices = tableSlices(this.A, this.filing, tableId, scope, reportingYear);
    return { view, slices, status: this.app.tableStatus(this.filing, tableId, scope) };
  }
  validateSlice(tableId, dims) {
    const t = this.A.table(tableId);
    const nd = normDims(dims);
    const errs = checkDimensionSyntax(this.A, nd);
    for (const d of nd) if (!t.axes.some((a) => a.axis === d.axis)) errs.push({ code: 'dim.notInTable', msg: `${d.axis} is not an axis of ${t.hypercube}` });
    // every axis at its default = the table's total column (facts without dimensions, as MCA reports table totals)
    if (!nd.length && t.axes.length && !totalColumnAllowed(this.A, tableId)) {
      // v14.5: say which axes need a member when their totals are marked not usable in this table
      const need = unusableDefaultAxes(this.A, t, nd);
      errs.push({ code: 'dim.none', msg: need.length ? `At least one axis member is required for a table row — ${need.map((n) => n.axis).join(' and ')} must be given a member (its total is not usable in this table)` : 'At least one axis member is required for a table row' });
    }
    if (errs.length) throw new DimensionError(errs.map((e) => e.msg).join('; '), errs);
    return nd;
  }
  setTableValue(tableId, scope, dims, concept, display, { preferredLabel = null, recalc = false, override = false, lockCalculated = false, unlockPY = false, strict = false } = {}) {
    if (this.pyLocked(scope, unlockPY)) throw new PyLockedError(PY_LOCKED);
    this.app.assertTableOpen(this.filing, tableId, scope);
    const t = this.A.table(tableId);
    if (!t.lineItems.includes(concept)) throw new DimensionError(`${concept} is not a line item of ${t.hypercube}`);
    const nd = this.validateSlice(tableId, dims);
    const dv = dimensionallyValid(this.A, concept, nd);
    if (!dv.valid) throw new DimensionError(`${concept} is not valid for [${dimKey(nd)}]: ${dv.reason}`);
    const st = this.app.conceptStatus(this.filing, concept, scope);
    if (!st.applicable) throw new ApplicabilityError(`${concept} is not applicable for ${scope}`, st.reasons);
    const calc = lockCalculated || override ? this.calculatedCell(concept, scope, nd, t.presentationElr, preferredLabel) : null;
    if (lockCalculated && !override && calc && sameDisplay(this, this.getValue(concept, scope, nd, preferredLabel), display)) return this.getValue(concept, scope, nd, preferredLabel);
    if (lockCalculated && !override && calc) throw new CalculatedCellError(`${this.A.label(concept)} is calculated from its child elements — enable editing of calculated cells for this tab to override it`);
    const p = this.periodForCell(concept, scope, preferredLabel);
    const before = this.filing.get(concept, p, nd);
    const was = before && !before.nil ? before.value : null;
    const f = this.filing.setDisplayValue({ concept, period: p, dims: nd, display, strict });
    if (f && override && calc) f.origin = 'override';
    if (recalc) this.recalcFrom(concept, p, nd, 0, { before: was, after: f && !f.nil ? f.value : null });
    return f;
  }
  // rename a typed member (edit imported or new typed members) — moves every fact of the slice
  renameTypedMember(tableId, scope, dims, axis, newValue) {
    if (this.pyLocked(scope)) throw new PyLockedError(PY_LOCKED);
    this.app.assertTableOpen(this.filing, tableId, scope);
    if (!String(newValue).trim()) throw new DimensionError('Typed member value must not be empty');
    const from = dimKey(normDims(dims));
    const to = normDims(dims.map((d) => (d.axis === axis ? { axis, typed: newValue } : d)));
    this.validateSlice(tableId, to);
    const moved = [];
    for (const f of this.filing.all()) {
      if (dimKey(f.dims) !== from || reportingYear(this.filing.meta.periods, f.period) !== scope) continue;
      if (this.filing.get(f.concept, f.period, to)) throw new DimensionError(`A row with ${axis}="${newValue}" already exists`);
      moved.push(f);
    }
    for (const f of moved) {
      this.filing.removeFact(f.key);
      this.filing.setFact({ ...f, dims: to, value: f.value, origin: f.origin === 'import' ? 'edited' : f.origin });
    }
    return to;
  }
  // v14.5: a column left at a total that the table does not allow (an axis whose default member is usable="false") is
  // moved to the members chosen for those axes: every fact of the column, values unchanged; what is derived from them
  // is re-derived. Refused when the target column already holds a value for any of them.
  moveSliceToMembers(tableId, scope, dims, additions) {
    if (this.pyLocked(scope)) throw new PyLockedError(PY_LOCKED);
    // (like removing a column, a correction of values already there: allowed whether or not the table is open)
    const to = this.validateSlice(tableId, [...dims, ...additions]);
    const facts = this.sliceFacts(tableId, scope, dims);
    for (const f of facts) {
      if (this.filing.get(f.concept, f.period, to)) throw new DimensionError(`The column [${dimKey(to)}] already has a value for ${f.concept}`);
      const dv = dimensionallyValid(this.A, f.concept, to);
      if (!dv.valid) throw new DimensionError(`${f.concept} is not valid for [${dimKey(to)}]: ${dv.reason}`);
    }
    for (const f of facts) {
      this.filing.removeFact(f.key);
      this.filing.setFact({ ...f, dims: to, origin: f.origin === 'import' ? 'edited' : f.origin });
    }
    for (const f of facts) if (this.A.isNumeric(f.concept) && !f.nil) this.recalcFrom(f.concept, f.period, to, 0, { before: null, after: f.value });
    return { to, moved: facts.length };
  }
  // facts of one table column: only the table's own line items (another table may use the same member combination);
  // for the total column, not the elements that are also rows of a statement/note or of another table's total column
  sliceFacts(tableId, scope, dims) {
    const A = this.A, t = A.table(tableId);
    const k = dimKey(normDims(dims));
    let items = new Set(t.lineItems);
    if (!k) {
      const shared = nondimRowConcepts(A);
      const other = new Set(A.tables.filter((x) => x.id !== tableId && totalColumnAllowed(A, x.id)).flatMap((x) => x.lineItems));
      items = new Set([...items].filter((q) => !shared.has(q) && !other.has(q)));
    }
    return this.filing.all().filter((f) => items.has(f.concept) && dimKey(f.dims) === k && reportingYear(this.filing.meta.periods, f.period) === scope);
  }
  // removing a column is an edit of each of its cells: what is derived from them (totals of other columns, the
  // statement figures taken from the note) is re-derived, one cell at a time
  removeSlice(tableId, scope, dims) {
    if (this.pyLocked(scope)) throw new PyLockedError(PY_LOCKED);
    for (const f of this.sliceFacts(tableId, scope, dims)) {
      if (!this.filing.facts.has(f.key)) continue; // already re-derived away by an earlier removal
      this.filing.removeFact(f.key);
      if (this.A.isNumeric(f.concept) && !f.nil) this.recalcFrom(f.concept, f.period, f.dims, 0, { before: f.value, after: null });
    }
  }
  // Statement figures that the tool derived from their notes (origin 'calculated') but that no longer equal their note
  // — e.g. in a project saved before v13.1, where removing a note column did not re-derive them. Re-derived on
  // opening: only the tool's own derived values are touched, never an entered, imported or manual figure.
  refreshDerivedStatements() {
    const A = this.A, f = this.filing, changed = [];
    for (const l of statementNoteLinks(A).values()) {
      if (l.kind !== 'sum') continue;
      for (const scope of ['CY', 'PY']) {
        const p = f.period(l.concept, scope);
        const x = p && f.get(l.concept, p, []);
        if (!x || x.nil || x.origin !== 'calculated') continue;
        const v = this.noteValue(l, scope);
        if (v && !v.undetermined && agrees(x, v)) continue;
        const before = x.value;
        if (!v || v.undetermined) { f.removeFact(x.key); this.recalcFrom(l.concept, p, [], 0, { before, after: null }); }
        else { f.setFact({ concept: l.concept, period: p, dims: [], value: Dec.toString(v.total), decimals: v.decimals, unit: v.unit || x.unit, origin: 'calculated' }); this.recalcFrom(l.concept, p, [], 0, { before, after: Dec.toString(v.total) }); }
        changed.push({ concept: l.concept, scope, before, after: f.get(l.concept, p, [])?.value ?? null });
      }
    }
    return changed;
  }
  suggestTypedValue(tableId, scope, axis) {
    const view = this.tableView(tableId);
    const ax = view.axes.find((a) => a.axis === axis);
    const prefix = (ax.typedDomain || axis).split(':')[1].replace(/Domain$/, '').replace(/ies$/, 'y').replace(/s$/, '');
    const existing = this.filing.all().flatMap((f) => f.dims.filter((d) => d.axis === axis && d.typed != null).map((d) => d.typed));
    // keep the naming already used on this axis (uniform, sequential member names — Filing Manual §1.3.2(6))
    const used = existing.map((v) => /^(.*?)\d+$/.exec(v)?.[1]).filter((x) => x != null);
    return nextTypedMember(existing, used.length ? used.sort()[0] : prefix);
  }

  // ---- validation / XML
  validate(opts) { return new Gate(this.A).run(this.filing, opts); }
  validateTab(elrUri, opts = {}) { return new Gate(this.A).run(this.filing, { ...opts, tab: elrUri }); }
  cellStatus(elrUri, concept, scope) { return this.app.cellStatus(this.filing, elrUri, concept, scope); }
  dependencies() { return this.app.deps; }
  exportXml(opts) { return exportXml(this.A, this.filing, opts); }
  // Dry run used by the import dialog: year breakdown of the source before the user chooses a mode.
  previewXml(text, opts = {}) {
    let res;
    try { res = importInstance(this.A, text, { ...opts, yearMode: 'both' }); }
    catch (e) {
      if (!(e instanceof CashFlowChoiceError)) throw e;
      // ambiguous cash-flow method: preview with either method to show the year split, then ask the user
      res = importInstance(this.A, text, { ...opts, yearMode: 'both', cashFlowMethod: 'Indirect Method' });
      res.report.cashFlow = { ...e.cashFlow, needsChoice: true };
    }
    const { report } = res;
    return { periods: report.periodDetection, byYear: report.byYear, counts: report.counts, unresolved: report.unresolvedFacts.length, errors: report.errors, cashFlow: report.cashFlow, notApplicable: report.notApplicable.length };
  }
  importXml(text, opts) {
    const { filing, report } = importInstance(this.A, text, opts);
    this.filing = filing;
    this._views.clear();
    // next year's filing: mirror the company information into the new current year (CIN, report type, rounding, dates)
    if (report.yearMode === 'next') this.setMeta({});
    return report;
  }

  // Previous-year opening balances (instants at the day before the previous year starts). A filing prepared by
  // moving last year's current-year-only import forward carries last year's opening balances there; MCA-validated
  // instances report none (FILING-B) or report them together with their parents (FILING-A).
  pyOpeningFacts() { return this.filing.all().filter((f) => this.filing.scopeOf(f.period) === 'PYO'); }
  // previous-year opening values left without the total MCA generic rule GR-1 requires for that date (e.g. share
  // capital at the previous year's opening date, whose total — shareholders' funds — has no cell for that date): the
  // facts behind the GR-1 errors on previous-year opening values
  pyOpeningOrphans(gate = null) {
    const g = gate || this.validate({});
    const keys = new Set(g.issues.filter((i) => i.ruleId === 'GR-1' && i.severity === 'ERROR' && i.factKey).map((i) => i.factKey));
    return this.pyOpeningFacts().filter((f) => keys.has(f.key));
  }
  // remove them; removing an opening value can leave its own parts without their total for that date, so repeated
  // until none is left. @returns the removed facts
  removePyOpeningOrphans(gate = null) {
    const removed = [];
    let g = gate;
    for (let pass = 0; pass < 20; pass++) {
      const list = this.pyOpeningOrphans(g);
      if (!list.length) break;
      this.removeFacts(list);
      removed.push(...list);
      g = null;
    }
    return removed;
  }
  // remove previous-year opening values (each removal is an edit: what is derived from it follows)
  removeFacts(list) {
    let n = 0;
    for (const f of list) {
      if (!this.filing.facts.has(f.key)) continue;
      this.filing.removeFact(f.key); n++;
      if (this.A.isNumeric(f.concept) && !f.nil) this.recalcFrom(f.concept, f.period, f.dims, 0, { before: f.value, after: null });
    }
    return n;
  }
  removePyOpeningFacts() { const list = this.pyOpeningFacts(); for (const f of list) this.filing.removeFact(f.key); return list.length; }
}

export { ApplicabilityError };
