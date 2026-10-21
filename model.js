// Filing-state engine: the single source of truth for a filing's facts.
// Facts are keyed by (concept, period, dimensions). CURRENT/PRIOR is derived from the
// period dates, never from fact order.
import * as Dec from './decimal.js';
import { periodKey, periodFor, scopeOf, validatePeriods, isoDate } from './periods.js';
import { scalePower, toCanonical, monetaryDecimals, enteredDecimals, SCALE_POWERS } from './scaling.js';
import { defaultUnitFor } from './units.js';
import { xmlSafe } from './richtext.js';

export function normDims(dims) {
  return (dims || []).map((d) => (d.typed != null ? { axis: d.axis, typed: String(d.typed) } : { axis: d.axis, member: d.member }))
    .sort((a, b) => a.axis.localeCompare(b.axis));
}
export function dimKey(dims) {
  return normDims(dims).map((d) => (d.member ? `${d.axis}=${d.member}` : `${d.axis}="${d.typed}"`)).join('|');
}
export function factKey(concept, period, dims) { return `${concept}#${periodKey(period)}#${dimKey(dims)}`; }

export class FactValueError extends Error {}

export function defaultMeta() {
  return {
    name: 'Untitled filing',
    cin: '',
    reportType: 'Standalone',
    firstFinancialYear: false,
    periods: { cy: { start: '', end: '' }, py: { start: '', end: '' } },
    level: 'Actual',
    displayPlaces: 0,
    // v14.3: decimal places of the statement figures as presented (most amounts), null = displayPlaces. Typed amounts are
    // declared at the accuracy actually typed, never coarser than this (e.g. statements in lakhs to 2 places = decimals -3,
    // share capital typed to the rupee with 5 places = decimals 0)
    statementPlaces: null,
    currency: 'INR',
    schemaRef: null, // null = authority default (the V3 address the MCA XBRL Validator requires); set from an imported validated instance
    // text blocks (richtext.js): 'headings' = plain text, whole bold lines pasted from Word become headings (header5);
    // 'highlight' = bold/italic/underline -> highlightedText1/2/3 (white on grey in the MCA PDF); 'none' = plain text.
    // v14.1 default 'headings' (projects saved earlier keep their setting)
    textEmphasis: 'headings',
  };
}

// v14.3: the message for an amount typed with more decimal places than the filing takes (nothing is rounded)
export function placesMessage(display, typed, level, places) {
  const pow = SCALE_POWERS[level] ?? 0;
  const exact = level === 'Actual' ? ' (2 places = paise)' : ` (${pow} places = exact rupees, ${pow + 2} = paise)`;
  return `'${String(display).trim()}' has ${typed} decimal place${typed === 1 ? '' : 's'}; this filing takes amounts in ${level === 'Actual' ? 'rupees' : level} with up to ${places}. Nothing was rounded or saved. To keep every digit, increase "Decimal places as presented" on the company page${exact}.`;
}

export class Filing {
  constructor(authority, meta = {}) {
    this.A = authority;
    this.meta = { ...defaultMeta(), ...meta, periods: { ...defaultMeta().periods, ...(meta.periods || {}) } };
    this.facts = new Map();
    this.footnotes = new Map(); // id -> {id, text, lang, factKeys:Set}
    this.importReport = null;
    // v14: values that are not filing data — set aside when last year's filing is prepared as the next year's filing
    // (last year's previous year and opening balances, its disclosures) or when dates are moved: kept in the project,
    // never generated, never checked; shown (with restore / delete) under Hidden data
    this.setAside = [];
    // v14: last year's filed figures of the previous-year column (from the filed XML), to compare with
    this.filedReference = null;
    this.revision = 0;
  }

  periodsValid() { return validatePeriods(this.meta.periods).length === 0; }
  period(concept, scope) {
    const c = this.A.concept(concept);
    return periodFor(this.meta.periods, c.periodType, scope);
  }
  scopeOf(period) { return scopeOf(this.meta.periods, period); }

  // ---- canonicalisation of a raw value for a concept
  canonicalValue(concept, raw) {
    const A = this.A;
    const t = A.dataType(concept);
    if (raw == null) throw new FactValueError('Empty value');
    const s = String(raw).trim();
    if (A.isNumeric(concept)) {
      if (!Dec.isDecimalString(s.replace(/,/g, ''))) throw new FactValueError(`'${s}' is not a number`);
      return Dec.toString(Dec.parse(s));
    }
    switch (t) {
      case 'boolean': {
        if (/^(true|yes)$/i.test(s)) return 'true';
        if (/^(false|no)$/i.test(s)) return 'false';
        throw new FactValueError(`'${s}' is not true/false`);
      }
      case 'date': if (!isoDate(s)) throw new FactValueError(`'${s}' is not a yyyy-mm-dd date`); return s;
      case 'enum': {
        const en = A.enumerations(concept);
        if (!en.includes(s)) throw new FactValueError(`'${s}' is not one of: ${en.join(', ')}`);
        return s;
      }
      default: return xmlSafe(String(raw));
    }
  }

  // ---- low-level fact API (used by importer and controller)
  setFact({ concept, period, dims = [], value = null, nil = false, decimals, unit, lang, origin = 'user', source = null, id = null }) {
    const A = this.A;
    const c = A.concept(concept);
    if (!c) throw new FactValueError(`Unknown concept ${concept}`);
    if (!A.isReportable(concept)) throw new FactValueError(`${concept} is not a reportable item`);
    if (c.periodType === 'instant' && period.type !== 'instant') throw new FactValueError(`${concept} requires an instant period`);
    if (c.periodType === 'duration' && period.type !== 'duration') throw new FactValueError(`${concept} requires a duration period`);
    const nd = normDims(dims);
    const key = factKey(concept, period, nd);
    const numeric = A.isNumeric(concept);
    const canonical = nil ? null : this.canonicalValue(concept, value);
    const prev = this.facts.get(key);
    const fact = {
      key, concept, period: { ...period }, dims: nd, value: canonical, nil: !!nil,
      decimals: numeric && !nil ? (decimals ?? null) : null,
      unit: numeric ? (unit || defaultUnitFor(A.dataType(concept), this.meta.currency)) : null,
      lang: numeric || !A.langAllowed(concept) ? null : (lang || null),
      origin, source: source || prev?.source || null, sourceId: id || prev?.sourceId || null,
    };
    if (numeric && !nil && fact.decimals == null) fact.decimals = String(this.defaultDecimals(concept, canonical));
    this.facts.set(key, fact);
    this.revision++;
    return fact;
  }

  // v15.0 (Ind AS tool v1.5): accuracy (decimals) of the filing's statement figures for a monetary concept, null
  // otherwise — the fewest places a calculated total is rounded to (session.js sumDecimals)
  statementDecimals(concept) {
    return this.A.dataType(concept) === 'monetary' ? this.defaultDecimals(concept, '0') : null;
  }

  defaultDecimals(concept, canonical) {
    if (this.A.dataType(concept) === 'monetary') {
      // accuracy of the filing's statement figures (v14.3: meta.statementPlaces, null = the display places), raised if the
      // value carries finer digits — then to the accuracy of the display places (capped at 2, GR-8). With statementPlaces
      // null this is the v14.2 rule: the accuracy of the display places, raised by finer digits.
      const places = Math.min(this.meta.statementPlaces ?? this.meta.displayPlaces, this.meta.displayPlaces);
      const d = monetaryDecimals(this.meta.level, places);
      const req = Dec.requiredDecimals(Dec.parse(canonical));
      if (req === Infinity || req <= d) return Math.min(2, d);
      return Math.min(2, Math.max(monetaryDecimals(this.meta.level, this.meta.displayPlaces), req));
    }
    return enteredDecimals(canonical);
  }
  // v14.3: decimals of an amount typed with `typed` fraction digits (in the display scale): the accuracy actually typed,
  // never coarser than the statement figures' places, never finer than the display places (capped at 2, GR-8).
  // 45.26 lakhs → -3; share capital 12.52365 lakhs (5 places) → 0; with statementPlaces null and typed digits within the
  // display places this equals the v14.2 rule (the accuracy of the display places).
  typedDecimals(typed, canonical) {
    const dp = this.meta.displayPlaces;
    const sp = Math.min(this.meta.statementPlaces ?? dp, dp);
    const places = Math.min(dp, Math.max(sp, typed));
    const req = Dec.requiredDecimals(Dec.parse(canonical));
    const d = monetaryDecimals(this.meta.level, places);
    return Math.min(2, req === Infinity ? d : Math.max(d, req));
  }

  // UI/editing entry point: value typed in the filing's display scale.
  // Monetary values are rounded (half away from zero) to displayPlaces, then scaled to canonical.
  // v14.3: strict (the screen's entry path) — an amount with more decimal places than displayPlaces is refused, never
  // rounded (MCA: the XML must carry the actual values, e.g. share capital; rounding may route the form to BO processing)
  setDisplayValue({ concept, period, dims = [], display, origin = 'user', strict = false }) {
    const A = this.A;
    const key = factKey(concept, period, dims);
    if (display == null || String(display).trim() === '') { this.removeFact(key); return null; }
    const prev = this.facts.get(key);
    const t = A.dataType(concept);
    if (t === 'monetary') {
      const raw = String(display).trim().replace(/,/g, '');
      if (!Dec.isDecimalString(raw)) throw new FactValueError(`'${display}' is not a number`);
      const typed = (/\.(\d*)$/.exec(raw)?.[1] || '').length;
      const dp = Number(this.meta.displayPlaces) || 0;
      // refused only when a digit would be lost (trailing zeros beyond the places lose nothing)
      if (strict && typed > dp && !Dec.eq(Dec.round(Dec.parse(raw), dp), Dec.parse(raw))) throw new FactValueError(placesMessage(display, Math.max(0, Dec.requiredDecimals(Dec.parse(raw))), this.meta.level, dp));
      const rounded = Dec.toString(Dec.round(Dec.parse(raw), dp));
      const canonical = toCanonical(rounded, this.meta.level);
      let decimals = String(this.typedDecimals(Math.min(typed, dp), canonical));
      // keep imported decimals when the edited value is still consistent with them (v14.3: unless more decimal places than
      // the statement figures' were typed and they declare a finer accuracy — e.g. an imported share capital at -3 typed
      // again to the rupee becomes accurate to the rupee)
      const sp = Math.min(this.meta.statementPlaces ?? dp, dp);
      const finer = typed > sp && prev?.decimals != null && prev.decimals !== 'INF' && Number(decimals) > Number(prev.decimals);
      if (prev?.decimals != null && prev.origin !== 'user' && !finer && Dec.eq(Dec.round(Dec.parse(canonical), prev.decimals), Dec.parse(canonical))) decimals = prev.decimals;
      return this.setFact({ concept, period, dims, value: canonical, decimals, origin: prev ? prev.origin === 'user' ? 'user' : 'edited' : origin, unit: prev?.unit });
    }
    const canonical = this.canonicalValue(concept, display);
    let decimals;
    if (A.isNumeric(concept)) {
      decimals = String(enteredDecimals(canonical));
      if (prev?.decimals != null && prev.origin !== 'user' && Dec.eq(Dec.round(Dec.parse(canonical), prev.decimals), Dec.parse(canonical))) decimals = prev.decimals;
    }
    return this.setFact({ concept, period, dims, value: canonical, decimals, origin: prev ? prev.origin === 'user' ? 'user' : 'edited' : origin, unit: prev?.unit, lang: prev?.lang || (A.isNumeric(concept) ? null : 'en') });
  }

  removeFact(key) { const ok = this.facts.delete(key); if (ok) this.revision++; for (const f of this.footnotes.values()) f.factKeys.delete(key); return ok; }
  get(concept, period, dims = []) { return this.facts.get(factKey(concept, period, dims)) || null; }
  all() { return [...this.facts.values()]; }
  factsOf(concept) { return this.all().filter((f) => f.concept === concept); }
  inScope(scope) { return this.all().filter((f) => this.scopeOf(f.period) === scope); }

  // value lookup by concept + scope + dims (period resolved from the concept's periodType)
  value(concept, scope, dims = []) {
    const p = this.period(concept, scope);
    if (!p) return null;
    const f = this.get(concept, p, dims);
    return f && !f.nil ? f.value : null;
  }

  // ---- metadata facts mirrored into the general-information ELR
  addFootnote(text, factKeys = [], lang = 'en') {
    // next unused id (fn1, fn2, …): stays unique after a footnote is removed
    let n = this.footnotes.size + 1;
    while (this.footnotes.has(`fn${n}`)) n++;
    const id = `fn${n}`;
    this.footnotes.set(id, { id, text, lang, factKeys: new Set(factKeys) });
    this.revision++;
    return id;
  }

  // ---- persistence (local-first project file)
  toJSON() {
    return {
      format: 'mca-ci-xbrl-project', version: 1, authorityHash: this.A.meta.authorityHash,
      meta: this.meta,
      facts: this.all().map(({ key, ...f }) => f),
      footnotes: [...this.footnotes.values()].map((f) => ({ ...f, factKeys: [...f.factKeys] })),
      importReport: this.importReport,
      setAside: this.setAside,
      filedReference: this.filedReference,
    };
  }
  static fromJSON(authority, json) {
    if (json.format !== 'mca-ci-xbrl-project') throw new Error('Not an MCA C&I XBRL project file');
    const f = new Filing(authority, json.meta);
    for (const x of json.facts) {
      const fact = { ...x, dims: normDims(x.dims) };
      fact.key = factKey(fact.concept, fact.period, fact.dims);
      f.facts.set(fact.key, fact);
    }
    for (const fn of json.footnotes || []) f.footnotes.set(fn.id, { ...fn, factKeys: new Set(fn.factKeys) });
    f.importReport = json.importReport || null;
    f.setAside = Array.isArray(json.setAside) ? json.setAside.map((x) => ({ ...x, dims: normDims(x.dims || []) })) : [];
    f.filedReference = json.filedReference || null;
    // a project prepared by moving a "Current year only" import to the next year (v10) is an ordinary two-year filing
    const det = f.importReport?.periodDetection?.cy?.end;
    if (f.meta.yearMode === 'current' && det && f.meta.periods?.cy?.end && det !== f.meta.periods.cy.end) f.meta.yearMode = 'both';
    return f;
  }
}

export { scalePower };
