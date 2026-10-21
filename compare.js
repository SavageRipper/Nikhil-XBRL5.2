// v14.9 UI helper: what differs between two versions of a filing — two project files, two XML files, a project and an
// XML, or the open filing and a file. Reads two Filing objects (the project as opened / the XML as imported); changes
// nothing. Facts are matched by element, year (current / previous / previous-year opening, from each filing's own
// dates) and members, so two years' filings can be compared year by year as well.
import { scopeOf } from './periods.js';
import { plainText } from './richtext.js';
import * as Dec from './decimal.js';

const META_FIELDS = [
  ['name', 'Company name'], ['cin', 'CIN'], ['reportType', 'Standalone / consolidated'],
  ['periods.cy.start', 'Current year from'], ['periods.cy.end', 'Current year to'],
  ['periods.py.start', 'Previous year from'], ['periods.py.end', 'Previous year to'],
  ['level', 'Level of rounding'], ['displayPlaces', 'Decimal places as presented'], ['statementPlaces', 'Statement figures rounded to'],
  ['textEmphasis', 'Bold / italic / underline setting'], ['firstFinancialYear', 'First financial year'],
];
const get = (o, path) => path.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
const dimsKey = (dims) => dims.map((d) => `${d.axis}=${d.member ?? `"${d.typed}"`}`).sort().join('|');
const textOf = (v) => plainText(String(v ?? '')).replace(/[\s ]+/g, ' ').trim();

function yearOf(filing, period) {
  const s = scopeOf(filing.meta.periods, period);
  if (s && s !== 'OTHER') return s;
  return period.type === 'instant' ? period.date : `${period.start}..${period.end}`;
}
function index(A, filing) {
  const m = new Map();
  for (const f of filing.all()) m.set(`${f.concept}#${yearOf(filing, f.period)}#${dimsKey(f.dims)}`, f);
  return m;
}
function same(A, a, b) {
  if (!!a.nil !== !!b.nil) return false;
  if (a.nil) return true;
  if (A.isNumeric(a.concept)) {
    try { if (Dec.cmp(Dec.parse(a.value), Dec.parse(b.value)) !== 0) return false; } catch { if (a.value !== b.value) return false; }
    return String(a.decimals ?? '') === String(b.decimals ?? '') || a.decimals == null || b.decimals == null;
  }
  return String(a.value) === String(b.value);
}

/**
 * @returns {{ meta: {field,label,a,b}[], facts: {kind:'changed'|'added'|'removed', concept, year, dims, a, b, formatOnly?, decimalsOnly?}[],
 *            footnotes: {kind, a, b}[], differentYears: boolean, counts: object }}
 *   'added' = only in the second, 'removed' = only in the first
 */
export function compareFilings(A, first, second) {
  const meta = [];
  for (const [field, label] of META_FIELDS) {
    const a = get(first.meta, field), b = get(second.meta, field);
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) meta.push({ field, label, a: a ?? null, b: b ?? null });
  }
  const differentYears = first.meta.periods?.cy?.end !== second.meta.periods?.cy?.end;
  const ia = index(A, first), ib = index(A, second);
  const facts = [];
  for (const [k, a] of ia) {
    const b = ib.get(k);
    const year = yearOf(first, a.period);
    if (!b) { facts.push({ kind: 'removed', concept: a.concept, year, dims: a.dims, a, b: null }); continue; }
    if (same(A, a, b)) continue;
    const isText = !A.isNumeric(a.concept) && A.dataType(a.concept) === 'textBlock';
    const formatOnly = isText && !a.nil && !b.nil && textOf(a.value) === textOf(b.value);
    let decimalsOnly = false;
    if (A.isNumeric(a.concept) && !a.nil && !b.nil) { try { decimalsOnly = Dec.cmp(Dec.parse(a.value), Dec.parse(b.value)) === 0; } catch { /* not numbers */ } }
    facts.push({ kind: 'changed', concept: a.concept, year, dims: a.dims, a, b, ...(formatOnly ? { formatOnly } : {}), ...(decimalsOnly ? { decimalsOnly } : {}) });
  }
  for (const [k, b] of ib) if (!ia.has(k)) facts.push({ kind: 'added', concept: b.concept, year: yearOf(second, b.period), dims: b.dims, a: null, b });
  // footnotes: compared by their text and the cells they are on
  const notes = (filing) => {
    const m = new Map();
    for (const fn of filing.footnotes.values()) {
      const cells = [...fn.factKeys].map((key) => filing.facts.get(key)).filter(Boolean).map((f) => `${f.concept}#${yearOf(filing, f.period)}#${dimsKey(f.dims)}`).sort().join(',');
      m.set(`${textOf(fn.text)}@${cells}`, fn);
    }
    return m;
  };
  const na = notes(first), nb = notes(second);
  const footnotes = [...[...na].filter(([k]) => !nb.has(k)).map(([, fn]) => ({ kind: 'removed', a: fn, b: null })), ...[...nb].filter(([k]) => !na.has(k)).map(([, fn]) => ({ kind: 'added', a: null, b: fn }))];
  const counts = { meta: meta.length, changed: facts.filter((x) => x.kind === 'changed').length, added: facts.filter((x) => x.kind === 'added').length, removed: facts.filter((x) => x.kind === 'removed').length, footnotes: footnotes.length };
  counts.total = counts.meta + counts.changed + counts.added + counts.removed + counts.footnotes;
  return { meta, facts, footnotes, differentYears, counts };
}
