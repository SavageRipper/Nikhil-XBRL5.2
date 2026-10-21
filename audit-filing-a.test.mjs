// Suite: regression of the false positives found by auditing the MCA-validated reference instance FILING-A.
// Each case is pinned to the reference instance and to a constructed negative case,
// so the corrected rules still fire where they must.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { authority, importSession, q } from './helpers.mjs';
import { runCalculations } from './calculation.js';
import { Filing } from './model.js';
import { RuleEngine } from './rules.js';

const A = authority();
const FILE = 'golden-FILING-A_2024-25.xml';
const skip = !existsSync(FILE);
const xml = skip ? '' : readFileSync(FILE, 'utf8');
const today = '2025-10-30';

test('FILING-A: validated source identity and full import', { skip }, () => {
  const { s, report } = importSession(xml);
  assert.equal(report.counts.sourceFacts, 3939);
  assert.equal(report.counts.unresolved, 0);
  // 16 facts sit under a "No" answer of their Yes/No parent (all 0 / false / empty): not applicable, not imported
  assert.equal(report.counts.notApplicable, 16);
  for (const x of report.notApplicable) {
    assert.ok(x.reasons.every((r) => r.startsWith('DEP:')), x.reasons.join());
    assert.ok(x.value === null || ['0', 'false'].includes(x.value) || !x.value.replace(/<[^>]*>/g, '').trim(), `${x.concept}: ${x.value}`);
  }
  assert.equal(report.counts.imported, 3939 - 16);
  assert.equal(report.byYear.current + report.byYear.previous + report.byYear.previousOpening, 3939 - 16);
  assert.ok(report.byYear.previousOpening > 0, 'PY opening (2023-03-31) instants recognised');
  const g = s.validate({ today });
  assert.equal(g.summary.errors, 0, g.issues.filter((i) => i.severity === 'ERROR').slice(0, 10).map((i) => i.message).join('\n'));
  assert.equal(g.summary.excluded, 0);
});

test('calculation: Calculations 1.1 round-to-nearest — unrounded Σ children, rounded once (was: 6 false GR-1 errors)', () => {
  const f = new Filing(A, { cin: 'U99999MH2000PTC999999', periods: { cy: { start: '2023-04-01', end: '2024-03-31' }, py: { start: '2022-04-01', end: '2023-03-31' } } });
  const put = (l, v, d) => f.setFact({ concept: q(l), period: f.period(q(l), 'CY'), value: v, decimals: d });
  // current assets in rupees and paise next to a part reported with decimals 0: rounding each part first gives 359578056,
  // the reported total is 359578054.28 = the unrounded sum
  put('CurrentAssets', '359578054.28', 'INF'); put('CurrentInvestments', '0', '0'); put('Inventories', '100000000.6', 'INF');
  put('TradeReceivables', '100000000.6', 'INF'); put('CashAndBankBalances', '100000000.6', 'INF'); put('ShortTermLoansAndAdvances', '50000000.6', 'INF'); put('OtherCurrentAssets', '9578051.88', 'INF');
  const c = runCalculations(A, f).find((x) => x.parent === q('CurrentAssets') && x.children.length);
  assert.equal(c.status, 'PASS', `${c.reported} vs ${c.computed}`);
  put('CurrentAssets', '359578056', 'INF'); // a real difference still fails
  assert.equal(runCalculations(A, f).find((x) => x.parent === q('CurrentAssets') && x.children.length).status, 'FAIL');
});

test('GR-4 applies to taxonomy members, not typed identifiers (was: 526 false errors)', { skip }, () => {
  const { s } = importSession(xml);
  const res = new RuleEngine(A).run(s.filing, { today, only: new Set(['GR-4']) }).results;
  assert.equal(res.filter((r) => r.status === 'FAIL').length, 0);
  assert.ok(res.some((r) => r.status === 'PASS'), 'explicit-member axes evaluated');
});

test('GR-6: dimensional rows are not paired member by member (was: 15 false errors)', { skip }, () => {
  const { s } = importSession(xml);
  const res = new RuleEngine(A).run(s.filing, { today, only: new Set(['GR-6']) }).results;
  assert.equal(res.filter((r) => r.status === 'FAIL').length, 0);
  // non-dimensional pairing still enforced
  const f = s.filing;
  const k = f.get(q('OtherCurrentAssets'), f.period(q('OtherCurrentAssets'), 'PY'), []);
  f.removeFact(k.key);
  assert.ok(new RuleEngine(A).run(f, { today, only: new Set(['GR-6']) }).results.some((r) => r.status === 'FAIL' && /OtherCurrentAssets|Other current assets/i.test(r.message)));
});

test('ML-20: Key Management Personnel transactions satisfy "at least one transaction" (was: 5 false errors)', { skip }, () => {
  const { s } = importSession(xml);
  const res = new RuleEngine(A).run(s.filing, { today, only: new Set(['ML-20']) }).results;
  assert.equal(res.filter((r) => r.status === 'FAIL').length, 0);
  const ml = A.rules.rules.find((r) => r.id === 'ML-20');
  assert.ok(ml.ast.atLeastOne[0].includes(q('RemunerationForKeyManagerialPersonnel')));
  assert.ok(ml.ast.atLeastOne[0].includes(q('PurchasesOfGoodsRelatedPartyTransactions')));
});

test('SR-L2116-1 is a documented divergence (WARNING with evidence), not silently dropped', () => {
  const r = A.rules.rules.find((x) => x.id === 'SR-L2116-1');
  assert.equal(r.status, 'EXECUTABLE');
  assert.equal(r.severity, 'WARNING');
  assert.match(r.divergence, /reference instance/);
});

test('ML-20-b evidence: MCA-validated instances report related-party rows without any outstanding-balance amount', () => {
  const OB = ['AmountsPayableRelatedPartyTransactions', 'AmountsReceivableRelatedPartyTransactions', 'ProvisionsForDoubtfulDebtsRelatedToOutstandingBalancesOfRelatedPartyTransaction', 'ShareApplicationMoneyReceivedFromRelatedParty', 'ShareApplicationMoneyGivenToRelatedParty', 'MaximumAmountPayableToRelatedPartyDuringPeriod', 'MaximumAmountReceivableFromRelatedPartyDuringPeriod'];
  let rows = 0;
  for (const f of ['golden-FILING-B_2024-25.xml', 'golden-FILING-A_2024-25.xml'].filter(existsSync)) {
    const src = readFileSync(f, 'utf8');
    for (const e of OB) assert.ok(!src.includes(`<in-gaap:${e} `), `${f}: no ${e}`);
    rows += (src.match(/<in-gaap:NameOfRelatedParty /g) || []).length;
  }
  if (rows) assert.ok(rows >= 34, 'related-party rows validated without outstanding balances');
  // so ML-20-b is not formalized as "an outstanding-balance amount is mandatory per row": it stays UNIMPLEMENTED
  assert.equal(A.rules.rules.find((r) => r.id === 'ML-20-b').status, 'UNIMPLEMENTED');
});
