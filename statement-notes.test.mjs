// v13: main-statement figures supplied by their notes (derived.js statementNoteLinks) are read-only on the statement
// and derived from the note; the tab option "Allow editing of calculated cells" still lets the user type them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { q, authority, newSession } from './helpers.mjs';
import { statementNoteLinks } from './derived.js';
import { CalculatedCellError } from './session.js';

const A = authority();
const uri = (code) => A.elrByCode(code).uri;
const BS = uri('100100'), PL = uri('100200');
const RES = '200200:StatementOfChangesInReservesTable', BOR = '200300:ClassificationOfBorrowingsTable', TAN = '201000:DisclosureOfTangibleAssetsTable';
const m = (axis, member) => ({ axis: q(axis), member: q(member) });

test('links: the MCA "statement = note" rules and the notes\' own totals; statement totals are not linked', () => {
  const L = statementNoteLinks(A);
  const k = (l) => [...L.keys()].includes(q(l));
  for (const l of ['ShareCapital', 'ReservesAndSurplus', 'LongTermBorrowings', 'ShortTermBorrowings', 'LongTermProvisions', 'ShortTermProvisions', 'TangibleAssets', 'IntangibleAssets', 'TradeReceivables', 'CurrentInvestments', 'NoncurrentInvestments', 'Inventories', 'OtherCurrentLiabilities', 'CashAndBankBalances', 'OtherIncome', 'EmployeeBenefitExpense', 'FinanceCosts', 'OtherExpenses']) assert.ok(k(l), l);
  for (const l of ['ProfitLossForPeriod', 'Assets', 'CurrentAssets', 'EquityAndLiabilities', 'DeferredTaxLiabilitiesNet', 'Revenue']) assert.ok(!k(l), l);
  assert.equal(L.get(q('ReservesAndSurplus')).ruleId, 'SR-L555-1');
  assert.equal(L.get(q('ShareCapital')).ruleId, 'SR-L374-1');
});

test('statement cells supplied by a note are read-only by default, also while empty; other cells are not', () => {
  const s = newSession();
  for (const sc of ['CY', 'PY']) {
    for (const l of ['TangibleAssets', 'ReservesAndSurplus', 'LongTermBorrowings', 'Inventories', 'OtherCurrentLiabilities']) assert.ok(s.calculatedCell(q(l), sc, [], BS)?.note, `${l} ${sc}`);
    assert.ok(s.calculatedCell(q('OtherIncome'), sc, [], PL)?.note);
    assert.equal(s.calculatedCell(q('DeferredTaxLiabilitiesNet'), sc, [], BS), null);
    // the same element on its note is not locked by the link
    assert.equal(s.calculatedCell(q('OtherCurrentLiabilities'), sc, [], uri('200600')), null);
  }
  assert.throws(() => s.setValue(q('ReservesAndSurplus'), 'CY', '10', { tab: BS }), CalculatedCellError);
  // the tab option still allows a manual figure (kept, never replaced)
  s.setValue(q('ReservesAndSurplus'), 'CY', '10', { tab: BS, override: true, recalc: true });
  assert.equal(s.getValue(q('ReservesAndSurplus'), 'CY').origin, 'override');
});

test('the note table opens while the statement figure is not determined; 0 on the statement closes it (MCA condition)', () => {
  const s = newSession();
  for (const sc of ['CY', 'PY']) {
    const st = s.tableStatus(BOR, sc);
    assert.equal(st.applicable, true);
    assert.equal(st.mandatory, false);
  }
  s.setValue(q('LongTermBorrowings'), 'CY', '0', { tab: BS, override: true });
  s.setValue(q('ShortTermBorrowings'), 'CY', '0', { tab: BS, override: true });
  assert.equal(s.tableStatus(BOR, 'CY').applicable, false);
});

test('reserves and surplus = Σ first-level components of reserves (closing), follows the note, cascades', () => {
  const s = newSession();
  const ax = 'ComponentsOfReservesAxis';
  s.setTableValue(RES, 'CY', [m(ax, 'CapitalReservesMember')], q('Reserves'), '300', { preferredLabel: 'periodEndLabel', recalc: true, lockCalculated: true });
  assert.equal(s.getValue(q('ReservesAndSurplus'), 'CY').value, '300');
  assert.equal(s.getValue(q('ReservesAndSurplus'), 'CY').origin, 'calculated');
  s.setTableValue(RES, 'CY', [m(ax, 'SecuritiesPremiumAccountMember')], q('Reserves'), '200', { preferredLabel: 'periodEndLabel', recalc: true, lockCalculated: true });
  assert.equal(s.getValue(q('ReservesAndSurplus'), 'CY').value, '500');
  assert.equal(s.getValue(q('ShareholdersFunds'), 'CY').value, '500', 'statement total follows');
  assert.ok(s.calculatedCell(q('ReservesAndSurplus'), 'CY', [], BS)?.note);
  // typing the value it shows is accepted
  assert.doesNotThrow(() => s.setValue(q('ReservesAndSurplus'), 'CY', '500', { tab: BS }));
  s.setTableValue(RES, 'CY', [m(ax, 'CapitalReservesMember')], q('Reserves'), '', { preferredLabel: 'periodEndLabel', recalc: true, lockCalculated: true });
  s.setTableValue(RES, 'CY', [m(ax, 'SecuritiesPremiumAccountMember')], q('Reserves'), '', { preferredLabel: 'periodEndLabel', recalc: true, lockCalculated: true });
  assert.equal(s.getValue(q('ReservesAndSurplus'), 'CY'), null, 'no note values left: the derived figure is removed');
  // previous year the same way
  s.setTableValue(RES, 'PY', [m(ax, 'CapitalReservesMember')], q('Reserves'), '70', { preferredLabel: 'periodEndLabel', recalc: true, lockCalculated: true });
  assert.equal(s.getValue(q('ReservesAndSurplus'), 'PY').value, '70');
});

test('long-term / short-term borrowings = Σ classification of borrowings with the time-period member', () => {
  const s = newSession();
  // v14.5: borrowings columns give secured / unsecured (the sub-classification total is not usable)
  const lt = [m('ClassificationBasedOnTimePeriodAxis', 'LongTermMember'), m('ClassificationOfBorrowingsAxis', 'BondsDebenturesMember'), m('SubclassificationOfBorrowingsAxis', 'SecuredBorrowingsMember')];
  const st = [m('ClassificationBasedOnTimePeriodAxis', 'ShortTermMember'), m('ClassificationOfBorrowingsAxis', 'BondsDebenturesMember'), m('SubclassificationOfBorrowingsAxis', 'UnsecuredBorrowingsMember')];
  s.setTableValue(BOR, 'CY', lt, q('Borrowings'), '1000', { recalc: true, lockCalculated: true });
  s.setTableValue(BOR, 'CY', st, q('Borrowings'), '250', { recalc: true, lockCalculated: true });
  assert.equal(s.getValue(q('LongTermBorrowings'), 'CY').value, '1000');
  assert.equal(s.getValue(q('ShortTermBorrowings'), 'CY').value, '250');
  assert.equal(s.tableStatus(BOR, 'CY').mandatory, true, 'the MCA condition is met by the derived figures');
});

test('tangible assets = Σ carrying amount of the classes (SR-L1381-2)', () => {
  const s = newSession();
  const cls = (c) => [m('ClassesOfTangibleAssetsAxis', c)];
  s.setTableValue(TAN, 'CY', cls('LandMember'), q('TangibleAssets'), '400', { preferredLabel: 'periodEndLabel', recalc: true, lockCalculated: true });
  s.setTableValue(TAN, 'CY', cls('BuildingsMember'), q('TangibleAssets'), '600', { preferredLabel: 'periodEndLabel', recalc: true, lockCalculated: true });
  assert.equal(s.getValue(q('TangibleAssets'), 'CY').value, '1000');
  assert.ok(s.calculatedCell(q('TangibleAssets'), 'CY', [], BS)?.note);
});

test('an entered statement figure: kept and editable when it differs from the note, follows once it agreed', () => {
  const s = newSession();
  const ax = 'ComponentsOfReservesAxis';
  const RS = q('ReservesAndSurplus'), per = () => s.filing.period(RS, 'CY');
  const imported = (v) => { s.filing.setFact({ concept: RS, period: per(), value: v, decimals: '0', unit: 'INR', origin: 'import' }); };
  s.setTableValue(RES, 'CY', [m(ax, 'CapitalReservesMember')], q('Reserves'), '300', { preferredLabel: 'periodEndLabel', recalc: true, lockCalculated: true });
  imported('900'); // a figure imported from an XML that differs from its note
  assert.equal(s.calculatedCell(RS, 'CY', [], BS), null, 'differs from the note: editable');
  assert.deepEqual(s.statementNoteDifferences().map((d) => [d.concept, d.scope, d.value, d.note]), [[RS, 'CY', '900', '300']], 'listed on Validation');
  s.setTableValue(RES, 'CY', [m(ax, 'SecuritiesPremiumAccountMember')], q('Reserves'), '600', { preferredLabel: 'periodEndLabel', recalc: true, lockCalculated: true });
  assert.equal(s.getValue(RS, 'CY').value, '900', 'kept');
  assert.ok(s.calculatedCell(RS, 'CY', [], BS)?.note, 'agrees with the note: read-only');
  s.setTableValue(RES, 'CY', [m(ax, 'SecuritiesPremiumAccountMember')], q('Reserves'), '700', { preferredLabel: 'periodEndLabel', recalc: true, lockCalculated: true });
  assert.equal(s.getValue(RS, 'CY').value, '1000', 'follows the note');
  // an imported figure whose note is empty: the filer's own (editable) — it follows the note once the note is entered
  const t = newSession();
  t.filing.setFact({ concept: RS, period: t.filing.period(RS, 'CY'), value: '5', decimals: '0', unit: 'INR', origin: 'import' });
  assert.equal(t.calculatedCell(RS, 'CY', [], BS), null);
  t.setTableValue(RES, 'CY', [m(ax, 'CapitalReservesMember')], q('Reserves'), '300', { preferredLabel: 'periodEndLabel', recalc: true, lockCalculated: true });
  assert.equal(t.getValue(RS, 'CY').value, '300');
  // Recalculate (explicit) makes a different figure follow the note
  t.filing.setFact({ concept: RS, period: t.filing.period(RS, 'CY'), value: '5', decimals: '0', unit: 'INR', origin: 'import' });
  t.recalculateAll({ scopes: ['CY'] });
  assert.equal(t.getValue(RS, 'CY').value, '300');
});

test('a nil balance (0) can be reported on the statement while its note is empty; not once the note has values', () => {
  const s = newSession();
  s.setValue(q('LongTermBorrowings'), 'CY', '0', { tab: BS, recalc: true });
  assert.equal(s.getValue(q('LongTermBorrowings'), 'CY').value, '0');
  assert.ok(s.calculatedCell(q('LongTermBorrowings'), 'CY', [], BS)?.note, 'still read-only');
  assert.throws(() => s.setValue(q('ShortTermBorrowings'), 'CY', '5', { tab: BS }), CalculatedCellError);
  s.setTableValue(RES, 'CY', [m('ComponentsOfReservesAxis', 'CapitalReservesMember')], q('Reserves'), '300', { preferredLabel: 'periodEndLabel', recalc: true, lockCalculated: true });
  assert.throws(() => s.setValue(q('ReservesAndSurplus'), 'CY', '0', { tab: BS }), CalculatedCellError);
  s.setValue(q('OtherCurrentLiabilities'), 'CY', '0', { tab: BS, recalc: true });
  assert.equal(s.getValue(q('OtherCurrentLiabilities'), 'CY').value, '0');
});

test('a manual figure (tab option) is never replaced by the note', () => {
  const s = newSession();
  s.setValue(q('ReservesAndSurplus'), 'CY', '42', { tab: BS, override: true, recalc: true });
  s.setTableValue(RES, 'CY', [m('ComponentsOfReservesAxis', 'CapitalReservesMember')], q('Reserves'), '300', { preferredLabel: 'periodEndLabel', recalc: true, lockCalculated: true });
  assert.equal(s.getValue(q('ReservesAndSurplus'), 'CY').value, '42');
  s.recalculateAll({ scopes: ['CY'] });
  assert.equal(s.getValue(q('ReservesAndSurplus'), 'CY').value, '42');
});

test('same element on the statement and as the note total: one value, entered in the note', () => {
  const s = newSession();
  s.setValue(q('OtherCurrentLiabilities'), 'CY', '75', { tab: uri('200600'), recalc: true });
  assert.equal(s.getValue(q('OtherCurrentLiabilities'), 'CY').value, '75');
  assert.equal(s.getValue(q('CurrentLiabilities'), 'CY').value, '75', 'statement total follows');
  assert.ok(s.calculatedCell(q('OtherCurrentLiabilities'), 'CY', [], BS)?.note);
});

test('removing a note column re-derives the statement figure (v13.1); a stale derived figure is refreshed on opening', () => {
  const s = newSession();
  const col = (cls) => [m('ClassificationBasedOnTimePeriodAxis', 'ShortTermMember'), m('ClassificationOfBorrowingsAxis', cls), m('SubclassificationOfBorrowingsAxis', 'UnsecuredBorrowingsMember')];
  s.setTableValue(BOR, 'CY', col('TermLoansMember'), q('Borrowings'), '100', { recalc: true, lockCalculated: true });
  s.setTableValue(BOR, 'CY', col('OtherLoansAndAdvancesMember'), q('Borrowings'), '30', { recalc: true, lockCalculated: true });
  assert.equal(s.getValue(q('ShortTermBorrowings'), 'CY').value, '130');
  assert.equal(s.getValue(q('CurrentLiabilities'), 'CY').value, '130');
  s.removeSlice(BOR, 'CY', col('OtherLoansAndAdvancesMember'));
  assert.equal(s.getValue(q('ShortTermBorrowings'), 'CY').value, '100', 'follows the note');
  assert.equal(s.getValue(q('CurrentLiabilities'), 'CY').value, '100', 'and the statement total');
  // a project saved with a stale derived figure (removed below the session, as an older version did)
  const k = s.filing.get(q('Borrowings'), s.filing.period(q('Borrowings'), 'CY'), col('TermLoansMember')).key;
  s.filing.removeFact(k);
  s.setTableValue(BOR, 'CY', col('LoansRepayableOnDemandMember'), q('Borrowings'), '70', {});
  assert.equal(s.getValue(q('ShortTermBorrowings'), 'CY').value, '100', 'stale');
  const r = s.refreshDerivedStatements();
  assert.deepEqual(r.map((x) => [x.scope, x.before, x.after]), [['CY', '100', '70']]);
  assert.equal(s.getValue(q('CurrentLiabilities'), 'CY').value, '70');
  // entered or imported figures are never touched by it
  s.filing.setFact({ concept: q('ShortTermBorrowings'), period: s.filing.period(q('ShortTermBorrowings'), 'CY'), value: '5', decimals: '0', unit: 'INR', origin: 'import' });
  assert.deepEqual(s.refreshDerivedStatements(), []);
});

test('a note table stays open while a statement figure it feeds is derived from it — clearing its last value is undoable (v14)', () => {
  const s = newSession();
  const T = '200600c:LoansAndAdvancesTable';
  const dims = [m('ClassificationBasedOnTimePeriodAxis', 'ShortTermMember'), m('ClassificationOfAssetsBasedOnSecurityAxis', 'UnsecuredConsideredGoodMember'), m('ClassificationOfLoansAndAdvancesAxis', 'LoansAdvancesGivenEmployeesMember')];
  s.setValue(q('LongTermLoansAndAdvances'), 'CY', '0', { tab: BS, recalc: true }); // nil long-term (Nil button)
  s.setTableValue(T, 'CY', dims, q('LoansAndAdvances'), '1628', { recalc: true, lockCalculated: true });
  assert.equal(s.getValue(q('ShortTermLoansAndAdvances'), 'CY').value, '1628');
  s.setTableValue(T, 'CY', dims, q('LoansAndAdvances'), '', { recalc: true, lockCalculated: true });
  assert.equal(s.tableStatus(T, 'CY').applicable, true, 'still open: short-term is derived from it');
  s.setTableValue(T, 'CY', dims, q('LoansAndAdvances'), '1628', { recalc: true, lockCalculated: true });
  assert.equal(s.getValue(q('ShortTermLoansAndAdvances'), 'CY').value, '1628');
  // both figures entered as 0 (nothing to disclose): the MCA condition closes the table, as before
  const t = newSession();
  t.setValue(q('LongTermLoansAndAdvances'), 'CY', '0', { tab: BS });
  t.setValue(q('ShortTermLoansAndAdvances'), 'CY', '0', { tab: BS });
  assert.equal(t.tableStatus(T, 'CY').applicable, false);
});
