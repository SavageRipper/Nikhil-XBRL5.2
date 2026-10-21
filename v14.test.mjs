// v14: health check, "Prepare next year's filing" with the set-aside store, hidden data, previous-year lock and the
// comparison with last year's filing, one-click fixes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { authority, q, newSession } from './helpers.mjs';
import { Session, PyLockedError } from './session.js';
import { Filing } from './model.js';
import { generateInstance } from './generator.js';
import { healthCheck, hiddenData, unshownFacts, restoreSetAside, restoreTarget, compareWithFiled, attachFiledXml, useFiledFigure, deleteSetAside } from './upkeep.js';
import { fixFor } from './fixes.js';
import { reachable } from './assurance.mjs';

const A = authority();
const xml = (g) => readFileSync(new URL(`./golden-${g}_2024-25.xml`, import.meta.url), 'utf8');
const TODAY = '2026-10-07';
const both = (g) => { const S = new Session(A); S.importXml(xml(g), { DOMParserImpl: DOMParser, yearMode: 'both' }); return S; };
const next = (g) => { const S = new Session(A); S.importXml(xml(g), { DOMParserImpl: DOMParser, yearMode: 'next' }); return S; };
const errors = (S) => S.validate({ today: TODAY }).issues.filter((i) => i.severity === 'ERROR');
const BS = A.elrByCode('100100').uri;

test('prepare next year: last year\'s current year is the previous year (locked); everything else is set aside, not filing data', () => {
  for (const g of ['FILING-B', 'FILING-A']) {
    const S = next(g), B = both(g);
    const P = S.filing.meta.periods;
    assert.equal(P.py.end, B.filing.meta.periods.cy.end);
    assert.equal(S.filing.meta.pyLocked, true);
    // no fact of an earlier date in the filing, all of them in the set-aside store
    assert.equal(S.filing.all().filter((f) => ['PYO', 'OTHER'].includes(S.filing.scopeOf(f.period))).length, 0, g);
    const reasons = new Set(S.filing.setAside.map((x) => x.reason));
    assert.ok(reasons.has('notApplicablePreviousYear'), g);
    if (g === 'FILING-A') assert.ok(reasons.has('yearBeforeLast') && reasons.has('openingBeforeLast'));
    // this year's opening balances = last year's closing (GR-7): the same fact
    const sc = q('ShareCapital');
    assert.equal(S.getValue(sc, 'CY', [], 'periodStartLabel')?.value, B.getValue(sc, 'CY')?.value);
    // nothing to compare: every previous-year figure is the filed one
    assert.deepEqual(compareWithFiled(S).items, []);
    // the set-aside values never reach the gate
    assert.equal(hiddenData(S).setAside.length, S.filing.setAside.length);
  }
});

test('previous-year lock: entries refused until unlocked; tool fixes respect it', () => {
  const S = next('FILING-B');
  const DT = q('DeferredTaxLiabilitiesNet');
  assert.throws(() => S.setValue(DT, 'PY', '1', { tab: BS }), PyLockedError);
  assert.doesNotThrow(() => S.setValue(DT, 'CY', '1', { tab: BS }));
  S.filing.meta.pyLocked = false;
  S.setValue(DT, 'PY', '999', { tab: BS, recalc: true });
  const c = compareWithFiled(S);
  assert.deepEqual(c.items.find((x) => x.concept === DT)?.kind, 'changed');
  assert.ok(c.items.every((x) => x.kind === 'changed'), 'its totals follow it and are listed too');
  useFiledFigure(S, c.items.find((x) => x.concept === DT));
  assert.deepEqual(compareWithFiled(S).items, [], 'restoring the part restores its totals');
});

test('compare with last year\'s filed XML for an existing project; a different year is refused', () => {
  const S = both('FILING-B');
  S.setMeta({ periods: { cy: { start: '2025-04-01', end: '2026-03-31' }, py: { start: '2024-04-01', end: '2025-03-31' } } });
  const r = attachFiledXml(S, xml('FILING-B'), { fileName: 'filed.xml', DOMParserImpl: DOMParser });
  assert.deepEqual(r.items, [], 'the moved project still carries the filed figures');
  const LT = q('LongTermLoansAndAdvances');
  S.filing.setFact({ ...S.filing.get(LT, S.filing.period(LT, 'PY'), []), value: '0', origin: 'user' });
  assert.deepEqual(compareWithFiled(S).items.map((x) => [x.kind, x.concept, x.filed, x.now]), [['changed', LT, '331000', '0']]);
  const T = both('FILING-B');
  assert.throws(() => attachFiledXml(T, xml('FILING-B'), { DOMParserImpl: DOMParser }), /not this filing's previous year/);
});

test('prepare next year from a project = from its XML', () => {
  const B = both('FILING-B');
  const { xml: x } = generateInstance(A, B.filing, B.filing.all());
  const N = new Session(A); N.importXml(x, { DOMParserImpl: DOMParser, yearMode: 'next', fileName: 'p.xml' });
  const X = next('FILING-B');
  const vals = (S) => S.filing.all().filter((f) => S.filing.scopeOf(f.period) === 'PY').map((f) => `${f.key}=${f.value}`).sort();
  assert.deepEqual(vals(N), vals(X));
});

test('health check: an out-of-date value the tool calculated is re-derived; entered and imported values untouched; goldens unchanged', () => {
  for (const g of ['FILING-B', 'FILING-A']) {
    const S = both(g);
    const before = JSON.stringify(S.filing.toJSON().facts);
    const h = healthCheck(S);
    assert.equal(h.changed, 0, g);
    assert.equal(JSON.stringify(S.filing.toJSON().facts), before, g);
  }
  const S = newSession();
  const DT = q('DeferredTaxLiabilitiesNet'), FX = q('ForeignCurrencyMonetaryItemTranslationDifferenceLiabilityAccount'), NCL = q('NoncurrentLiabilities');
  S.setValue(DT, 'CY', '100', { tab: BS, recalc: true });
  S.setValue(FX, 'CY', '50', { tab: BS, recalc: true });
  assert.equal(S.getValue(NCL, 'CY').value, '150');
  // a part changed below the session (as an older version could leave it)
  S.filing.setFact({ ...S.getValue(FX, 'CY'), value: '70' });
  const h = healthCheck(S);
  assert.equal(S.getValue(NCL, 'CY').value, '170');
  assert.ok(h.cells.some((c) => c.concept === NCL));
  assert.equal(S.getValue(q('EquityAndLiabilities'), 'CY').value, '170', 'and what is derived from it');
});

test('health check sets aside a previous-year opening value no tab shows; keeps the opening totals a filing reports', () => {
  const S = both('FILING-B');
  S.setMeta({ periods: { cy: { start: '2025-04-01', end: '2026-03-31' }, py: { start: '2024-04-01', end: '2025-03-31' } } });
  const OP = q('OtherProvisions');
  const lt = [{ axis: q('ClassificationBasedOnTimePeriodAxis'), member: q('LongTermMember') }];
  const orphan = S.filing.all().find((f) => f.concept === OP && S.filing.scopeOf(f.period) === 'PYO' && f.dims.length === 1);
  assert.ok(orphan, 'the moved project carries last year\'s provisions at the previous-year opening date');
  assert.ok(unshownFacts(S).some((x) => x.fact.key === orphan.key));
  const h = healthCheck(S);
  assert.ok(h.moved.some((x) => x.concept === OP), 'set aside');
  assert.equal(S.filing.get(OP, orphan.period, lt), null);
  assert.ok(S.filing.setAside.some((x) => x.concept === OP && x.reason === 'openingNoCell'));
  // the FILING-A filing reports its opening balance sheet with its totals: nothing set aside
  const C = both('FILING-A');
  assert.equal(healthCheck(C).moved.length, 0);
});

test('hidden data: restore a set-aside opening value into its opening cell (unlocking the previous year), delete', () => {
  const S = next('FILING-A');
  const i = S.filing.setAside.findIndex((x) => x.concept === q('ShareCapital') && !x.dims.length && S.filing.scopeOf(x.period) === 'PYO');
  assert.ok(i >= 0);
  const t = restoreTarget(S, S.filing.setAside[i]);
  assert.ok(!t.why && t.preferredLabel === 'periodStartLabel', JSON.stringify(t));
  assert.equal(restoreSetAside(S, [i]).restored, 0, 'refused while the previous year is locked');
  const r = restoreSetAside(S, [i], { unlockPY: true });
  assert.equal(r.restored, 1);
  assert.ok(S.getValue(q('ShareCapital'), 'PY', [], 'periodStartLabel'));
  const n = S.filing.setAside.length;
  assert.equal(deleteSetAside(S, [0, 1]), 2);
  assert.equal(S.filing.setAside.length, n - 2);
  // a project file keeps the store
  const R = Filing.fromJSON(A, JSON.parse(JSON.stringify(S.filing.toJSON())));
  assert.equal(R.setAside.length, n - 2);
  assert.equal(R.meta.pyLocked, true);
});

test('fixes: each offered fix removes its message; every error location stays reachable', () => {
  // a moved-forward project with leftovers (GR-1 on previous-year opening values) and missing totals
  const S = both('FILING-B');
  S.setMeta({ periods: { cy: { start: '2025-04-01', end: '2026-03-31' }, py: { start: '2024-04-01', end: '2025-03-31' } } });
  const gone = new Set(['ShareholdersFunds', 'NoncurrentLiabilities', 'CurrentLiabilities', 'EquityAndLiabilities', 'FixedAssets', 'NoncurrentAssets', 'CurrentAssets', 'Assets', 'Provisions'].map((l) => q(l)));
  for (const f of S.pyOpeningFacts()) if (gone.has(f.concept)) S.filing.removeFact(f.key);
  const errs = errors(S);
  assert.ok(errs.length > 40);
  for (const i of errs) assert.equal(reachable(S, i.location), null, `${i.message} ${JSON.stringify(i.location)}`);
  let fixed = 0;
  for (let n = 0; n < Math.min(errs.length, 40); n++) {
    const T = new Session(A, Filing.fromJSON(A, JSON.parse(JSON.stringify(S.filing.toJSON()))));
    const i = errors(T)[n];
    assert.equal(reachable(T, i.location), null, `${i.message} ${JSON.stringify(i.location)}`);
    const fx = fixFor(T, i);
    if (!fx || fx.disabled) continue;
    fx.apply();
    assert.ok(!errors(T).some((e) => e.message === i.message), `${fx.label}: ${i.message}`);
    fixed++;
  }
  assert.ok(fixed > 5, String(fixed));
});

test('fixes: statement figure from its note; total = sum of parts; nil for a mandatory amount', () => {
  const S = newSession();
  const RES = '200200:StatementOfChangesInReservesTable';
  S.setTableValue(RES, 'CY', [{ axis: q('ComponentsOfReservesAxis'), member: q('CapitalReservesMember') }], q('Reserves'), '300', { preferredLabel: 'periodEndLabel', recalc: true, lockCalculated: true });
  S.filing.setFact({ concept: q('ReservesAndSurplus'), period: S.filing.period(q('ReservesAndSurplus'), 'CY'), value: '900', decimals: '0', unit: 'INR', origin: 'import' });
  const i = errors(S).find((e) => e.ruleId === 'SR-L555-1');
  assert.ok(i);
  const fx = fixFor(S, i);
  assert.equal(fx.label, 'Take the figure from the note');
  fx.apply();
  assert.equal(S.getValue(q('ReservesAndSurplus'), 'CY').value, '300');
  assert.ok(!errors(S).some((e) => e.ruleId === 'SR-L555-1'));
  const m = errors(S).find((e) => /is mandatory — not present for CY/.test(e.message) && e.concept === q('LongTermBorrowings'));
  assert.ok(m);
  const nf = fixFor(S, m);
  assert.equal(nf.label, 'Report nil (0)');
  nf.apply();
  assert.equal(S.getValue(q('LongTermBorrowings'), 'CY').value, '0');
});

test('fixes: a total entered differently from its parts → set it to the sum of its parts; GR-6 points to the missing cell', () => {
  const S = newSession();
  const DT = q('DeferredTaxLiabilitiesNet'), FX = q('ForeignCurrencyMonetaryItemTranslationDifferenceLiabilityAccount'), NCL = q('NoncurrentLiabilities');
  S.setValue(DT, 'CY', '100', { tab: BS, recalc: true });
  S.setValue(FX, 'CY', '50', { tab: BS, recalc: true });
  S.setValue(NCL, 'CY', '999', { tab: BS, override: true, recalc: true });
  const i = errors(S).find((e) => e.calc && e.factKey === S.getValue(NCL, 'CY').key);
  assert.ok(i, 'calculation inconsistency reported');
  const fx = fixFor(S, i);
  assert.equal(fx.label, 'Set total = sum of parts');
  fx.apply();
  assert.equal(S.getValue(NCL, 'CY').value, '150');
  // GR-6: previous year entered, current year missing → the message opens the current-year cell
  S.setValue(q('MinorityInterest'), 'PY', '5', { tab: BS });
  const g6 = errors(S).find((e) => e.ruleId === 'GR-6' && /MinorityInterest/.test(e.message));
  assert.equal(g6.location.scope, 'CY');
  assert.equal(g6.location.cellId, `${q('MinorityInterest')}#I:${S.filing.meta.periods.cy.end}#`);
});
