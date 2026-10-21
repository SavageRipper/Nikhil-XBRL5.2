// v14.5: (1) a column left at a total the table does not allow (the axis' default member is usable="false" in the
// taxonomy — e.g. the security classification of loans and advances, secured / unsecured borrowings): never offered,
// refused on entry, reported at its column with a fix that moves it to the member chosen; MCA sum rules add up over
// such axes. (2) [400200] auditor's report: each mandatory clause (ML-39) is required once, under any one member
// (SR-L3717-1 allows a clause under one member only); a clause given under two members has a "keep it under one" fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { authority, q, importSession } from './helpers.mjs';
import { baseSession } from './fixtures.mjs';
import { dimensionallyValid, nondimAllowed, unusableDefaultAxes } from './dimensions.js';
import { totalColumnAllowed } from './views.js';
import { fixFor } from './fixes.js';
import { mandatoryCell } from './mandatory-marks.js';
import { carryForwardPlan } from './carry-forward.js';
import { generateInstance } from './generator.js';
import { xsdValidatorStatus, validateInstanceXml } from './xsd-validate.mjs';

const A = authority();
const today = '2017-06-30';
const m = (axis, member) => ({ axis: q(axis), member: q(member) });
const LOANS = '200600c:LoansAndAdvancesTable', BOR = '200300:ClassificationOfBorrowingsTable';
const ST = m('ClassificationBasedOnTimePeriodAxis', 'ShortTermMember');
const OTH = m('ClassificationOfLoansAndAdvancesAxis', 'OtherLoansAndAdvancesOthersMember');
const UNSEC = m('ClassificationOfAssetsBasedOnSecurityAxis', 'UnsecuredConsideredGoodMember');

test('the taxonomy rule: a total marked not usable is not a valid value (XBRL Dimensions 1.0)', () => {
  assert.equal(dimensionallyValid(A, q('LoansAndAdvances'), [ST, OTH]).valid, false);
  assert.match(dimensionallyValid(A, q('LoansAndAdvances'), [ST, OTH]).reason, /ClassificationOfAssetsBasedOnSecurityAxis must be given a member/);
  assert.equal(dimensionallyValid(A, q('LoansAndAdvances'), [ST, OTH, UNSEC]).valid, true);
  assert.deepEqual(unusableDefaultAxes(A, LOANS, [ST, OTH]).map((x) => x.axis), [q('ClassificationOfAssetsBasedOnSecurityAxis')]);
  assert.deepEqual(unusableDefaultAxes(A, LOANS, [ST, OTH])[0].members, ['SecuredConsideredGoodMember', 'UnsecuredConsideredGoodMember', 'DoubtfulMember'].map(q));
  assert.equal(totalColumnAllowed(A, LOANS), false);
  assert.equal(totalColumnAllowed(A, BOR), false);
  assert.equal(totalColumnAllowed(A, '201000:DisclosureOfTangibleAssetsTable'), true, 'tables whose totals are usable keep their total column');
  assert.equal(nondimAllowed(A, q('DisclosureInAuditorsReportRelatingToInventories')), false, 'an auditor\'s-report clause is always under a member');
});

test('entering a value in such a column is refused with the reason', () => {
  const s = baseSession();
  s.setValue(q('ShortTermLoansAndAdvances'), 'CY', '100');
  assert.throws(() => s.setTableValue(LOANS, 'CY', [ST, OTH], q('LoansAndAdvances'), '100'), /ClassificationOfAssetsBasedOnSecurityAxis must be given a member/);
  assert.throws(() => s.validateSlice(LOANS, []), /must be given a member/);
  s.setTableValue(LOANS, 'CY', [ST, OTH, UNSEC], q('LoansAndAdvances'), '100');
});

// a project or instance from elsewhere that carries such a column
const withBadColumn = () => {
  const s = baseSession();
  s.setValue(q('ShortTermLoansAndAdvances'), 'CY', '100');
  for (const [c, v] of [['LoansAndAdvancesGross', '100'], ['LoansAndAdvances', '100'], ['NatureOfOtherLoansAndAdvances', 'Balance with authorities']]) {
    s.filing.setFact({ concept: q(c), period: s.filing.period(q(c), 'CY'), dims: [ST, OTH], value: v, ...(A.isNumeric(q(c)) ? { decimals: '0', unit: 'INR' } : {}), origin: 'import' });
  }
  return s;
};

test('such a column is an error at its column, with a fix that moves it to the member chosen (values unchanged)', () => {
  const s = withBadColumn();
  const errs = s.validate({ today }).issues.filter((i) => i.code === 'dim.hypercube');
  assert.equal(errs.length, 3);
  assert.ok(errs.every((i) => i.location && i.location.tableId === LOANS), 'opens the loans table');
  const fx = fixFor(s, errs[0]);
  assert.equal(fx.label, 'Move the column to a member');
  assert.deepEqual(fx.choose.map((c) => c.options.map((o) => o.value)), [['SecuredConsideredGoodMember', 'UnsecuredConsideredGoodMember', 'DoubtfulMember'].map(q)]);
  assert.match(fx.confirm, /does not allow/);
  fx.apply([q('UnsecuredConsideredGoodMember')]);
  assert.equal(s.validate({ today }).issues.filter((i) => i.code === 'dim.hypercube').length, 0);
  assert.equal(s.getValue(q('LoansAndAdvances'), 'CY', [ST, OTH, UNSEC]).value, '100');
  assert.equal(s.getValue(q('NatureOfOtherLoansAndAdvances'), 'CY', [ST, OTH, UNSEC]).value, 'Balance with authorities');
  assert.equal(s.getValue(q('LoansAndAdvances'), 'CY', [ST, OTH]), null);
});

test('the move is refused when the chosen column already has a value; previous-year columns at such a total are not carried forward', () => {
  const s = withBadColumn();
  s.setTableValue(LOANS, 'CY', [ST, OTH, UNSEC], q('LoansAndAdvancesGross'), '5');
  const fx = fixFor(s, s.validate({ today }).issues.find((i) => i.code === 'dim.hypercube'));
  assert.throws(() => fx.apply([q('UnsecuredConsideredGoodMember')]), /already has a value/);
  fx.apply([q('DoubtfulMember')]);
  assert.equal(s.getValue(q('LoansAndAdvances'), 'CY', [ST, OTH, m('ClassificationOfAssetsBasedOnSecurityAxis', 'DoubtfulMember')]).value, '100');
  const p = baseSession();
  p.filing.setFact({ concept: q('LoansAndAdvances'), period: p.filing.period(q('LoansAndAdvances'), 'PY'), dims: [ST, OTH], value: '7', decimals: '0', unit: 'INR', origin: 'import' });
  assert.ok(!carryForwardPlan(p, LOANS).columns.some((d) => d.length === 2));
});

const st = xsdValidatorStatus();
test('XML Schema / Dimensions (Arelle): the column is invalid before the fix and valid after', { skip: !st.available && `XSD validator not available: ${st.reason}` }, () => {
  const s = withBadColumn();
  const before = validateInstanceXml(generateInstance(A, s.filing, s.app.planFacts(s.filing).emit).xml, { label: 'bad.xml' });
  assert.ok(before.errors.some((e) => /PrimaryItemDimensionallyInvalid/.test(e.code)));
  fixFor(s, s.validate({ today }).issues.find((i) => i.code === 'dim.hypercube')).apply([q('UnsecuredConsideredGoodMember')]);
  const after = validateInstanceXml(generateInstance(A, s.filing, s.app.planFacts(s.filing).emit).xml, { label: 'good.xml' });
  assert.ok(!after.errors.some((e) => /PrimaryItemDimensionallyInvalid/.test(e.code)), JSON.stringify(after.errors.slice(0, 3)));
});

test('MCA sum rules add up over an axis that must always be given (SR-L632: long-term borrowings = Σ secured + unsecured)', () => {
  const s = baseSession();
  for (const [l, v] of [['LongTermBorrowings', 300], ['NoncurrentLiabilities', 300], ['EquityAndLiabilities', 300], ['CashAndBankBalances', 300], ['CurrentAssets', 300], ['Assets', 300]]) s.setValue(q(l), 'CY', String(v));
  const lt = m('ClassificationBasedOnTimePeriodAxis', 'LongTermMember'), tl = m('ClassificationOfBorrowingsAxis', 'TermLoansMember');
  s.setTableValue(BOR, 'CY', [lt, tl, m('SubclassificationOfBorrowingsAxis', 'SecuredBorrowingsMember')], q('Borrowings'), '200');
  s.setTableValue(BOR, 'CY', [lt, tl, m('SubclassificationOfBorrowingsAxis', 'UnsecuredBorrowingsMember')], q('Borrowings'), '100');
  const res = (id) => s.validate({ today }).ruleResults.filter((r) => r.ruleId === id).map((r) => r.status);
  assert.deepEqual(res('SR-L632-1'), ['PASS']);
  s.setTableValue(BOR, 'CY', [lt, tl, m('SubclassificationOfBorrowingsAxis', 'UnsecuredBorrowingsMember')], q('Borrowings'), '90');
  assert.deepEqual(res('SR-L632-1'), ['FAIL']);
});

// ---- (2) [400200] auditor's report
const CARO = '400200:DisclosureOfAuditorsQualificationsReservationsOrAdverseRemarksInAuditorsReportTable';
const AX = 'AuditorsQualificationsReservationsOrAdverseRemarksInAuditorsReportAxis';
const FAV = [m(AX, 'AuditorsFavourableRemarkMember')], UNF = [m(AX, 'AuditorsUnfavourableRemarkMember')], NA = [m(AX, 'ClauseNotApplicableMember')];
const ML39 = A.rules.rules.find((r) => r.id === 'ML-39').ast.concepts;
const caroSession = () => {
  const s = baseSession();
  s.setValue(q('WhetherCompaniesAuditorsReportOrderIsApplicableOnCompany'), 'CY', 'true');
  for (const c of ML39) s.setTableValue(CARO, 'CY', FAV, c, A.dataType(c) === 'textBlock' ? '<p>Clause complied with.</p>' : 'Clause complied with.');
  return s;
};
const ml39 = (s) => s.validate({ today }).issues.filter((i) => i.ruleId === 'ML-39');
const single = (s) => s.validate({ today }).issues.filter((i) => i.ruleId === 'SR-L3717-1');

test('ML-39: a clause under Unfavourable or Not applicable instead of Favourable is complete — no clause is asked for in every column', () => {
  const s = caroSession();
  assert.equal(ml39(s).length, 0);
  const inv = q('DisclosureInAuditorsReportRelatingToInventories'), nidhi = q('DisclosureInAuditorsReportRelatingToNidhiCompany');
  s.setTableValue(CARO, 'CY', FAV, inv, null);
  s.setTableValue(CARO, 'CY', UNF, inv, 'Physical verification not conducted.');
  s.setTableValue(CARO, 'CY', FAV, nidhi, null);
  s.setTableValue(CARO, 'CY', NA, nidhi, 'Not applicable.');
  assert.deepEqual(ml39(s).map((i) => i.message), []);
  assert.equal(single(s).length, 0);
  // required marks: the Unfavourable / Not applicable columns do not ask for the other clauses
  assert.equal(mandatoryCell(s, q('DisclosureInAuditorsReportRelatingToLoans'), 'CY', UNF, CARO).mandatory, false);
  assert.equal(mandatoryCell(s, inv, 'CY', UNF, CARO).mandatory, true, 'the cell that holds the clause stays marked');
  assert.equal(mandatoryCell(s, q('DisclosureInAuditorsReportRelatingToLoans'), 'CY', FAV, CARO).mandatory, true);
});

test('ML-39: a clause given under no member is reported once, at its row in the main column', () => {
  const s = caroSession();
  s.setTableValue(CARO, 'CY', UNF, q('DisclosureInAuditorsReportRelatingToInventories'), 'Remark.');
  s.setTableValue(CARO, 'CY', FAV, q('DisclosureInAuditorsReportRelatingToInventories'), null);
  const nidhi = q('DisclosureInAuditorsReportRelatingToNidhiCompany');
  s.setTableValue(CARO, 'CY', FAV, nidhi, null);
  const e = ml39(s);
  assert.equal(e.length, 1);
  assert.match(e[0].message, /DisclosureInAuditorsReportRelatingToNidhiCompany\] not present under any member/);
  assert.equal(e[0].location.tableId, CARO);
  assert.match(e[0].location.cellId, /AuditorsFavourableRemarkMember/);
  assert.equal(mandatoryCell(s, nidhi, 'CY', UNF, CARO).mandatory, true, 'still missing: marked in every column');
});

test('SR-L3717-1: a clause under two members — the fix keeps it under the member chosen', () => {
  const s = caroSession();
  const loans = q('DisclosureInAuditorsReportRelatingToLoans');
  s.setTableValue(CARO, 'CY', UNF, loans, 'Terms prejudicial.');
  const e = single(s);
  assert.equal(e.length, 1);
  const fx = fixFor(s, e[0]);
  assert.equal(fx.label, 'Keep it under one member');
  assert.equal(fx.choose[0].options.length, 2);
  const keep = fx.choose[0].options.findIndex((o) => /unfavourable/i.test(o.label));
  fx.apply([String(keep)]);
  assert.equal(single(s).length, 0);
  assert.equal(ml39(s).length, 0);
  assert.equal(s.getValue(loans, 'CY', UNF).value, 'Terms prejudicial.');
  assert.equal(s.getValue(loans, 'CY', FAV), null);
});

const REF = ['FILING-A', 'FILING-B'].every((g) => existsSync(new URL(`./golden-${g}_2024-25.xml`, import.meta.url)));
test('reference instances: the borrowings / loans sum rules now really check them, and pass', { skip: !REF && 'reference instances not present' }, () => {
  for (const g of ['FILING-A', 'FILING-B']) {
    const { s } = importSession(readFileSync(new URL(`./golden-${g}_2024-25.xml`, import.meta.url), 'utf8'));
    const v = s.validate({ today: '2025-10-30' });
    assert.equal(v.summary.errors, 0, g);
    const st2 = (id) => v.ruleResults.filter((r) => r.ruleId === id).map((r) => r.status);
    assert.ok(st2('SR-L632-1').includes('PASS') && st2('SR-L632-2').includes('PASS'), `${g} SR-L632`);
  }
});
