// v15.1: the tool's validation brought in line with the MCA XBRL Validator on the evidence of a company's MCA-accepted
// filing (FY 2024-25, golden-FILING-C_2024-25.xml: 0 errors) and of that company's next filing run through the MCA XBRL
// Validator V5.1 (FY 2025-26, validator-FILING-C_2025-26.xml: exactly the validator's errors). Both files stay outside
// the package (as the other reference instances); the tests on them are skipped when they are absent. The other tests
// rebuild each case in a small filing of their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { authority } from './helpers.mjs';
import { Session } from './session.js';
import { Applicability } from './applicability.js';

const A = authority();
const g = (l) => 'in-gaap:' + l, c = (l) => 'in-ca:' + l;
const P = { cy: { start: '2025-04-01', end: '2026-03-31' }, py: { start: '2024-04-01', end: '2025-03-31' } };
function session() {
  const s = new Session(A);
  s.setMeta({ name: 'Test Co', cin: 'L72200KA2010PLC123456', reportType: 'Standalone', level: 'Actual', displayPlaces: 0, statementPlaces: 0, periods: JSON.parse(JSON.stringify(P)) });
  return s;
}
// a value as an imported fact (the cells' own applicability is what is under test)
const put = (s, q, scope, dims, value, origin = 'import') => s.filing.setFact({ concept: q, period: s.filing.period(q, scope), dims, value: String(value), origin, ...(A.isNumeric(q) ? { decimals: '0' } : {}) });
const ex = (axis, member) => ({ axis, member });
const ty = (axis, v) => ({ axis, typed: v });
const issues = (s, id, sev = null) => s.validate({ today: '2026-10-21' }).issues.filter((i) => i.ruleId === id && (!sev || i.severity === sev));

test('v15.1: a director without a middle or last name is complete (SR-L3762-2 / SR-L3851-2 follow ML-35 / ML-38: "except MiddleNameOfDirector and LastNameOfDirector")', () => {
  const s = session();
  const d = [ty(c('DirectorsSigningFinancialStatementsAxis'), '1')];
  put(s, c('FirstNameOfDirector'), 'CY', d, 'ASHA'); put(s, c('DesignationOfDirector'), 'CY', d, 'Director');
  put(s, c('DirectorIdentificationNumberOfDirector'), 'CY', d, '01234567'); put(s, c('DateOfSigningOfFinancialStatementsByDirector'), 'CY', d, '2026-05-29');
  assert.deepEqual(issues(s, 'SR-L3762-2', 'ERROR'), []);
  s.filing.removeFact(s.filing.get(c('DirectorIdentificationNumberOfDirector'), s.filing.period(c('DirectorIdentificationNumberOfDirector'), 'CY'), d).key);
  assert.equal(issues(s, 'SR-L3762-2', 'ERROR').length, 1, 'still an error without the DIN');
});

test('v15.1: the DIN is required for Managing / Whole Time / Independent / Other Non Executive Director (SR-L3472-1), not for other designations', () => {
  const s = session();
  const k = (n) => [ty(c('KeyManagerialPersonnelsAndDirectorsAxis'), 'KMP' + n)];
  put(s, c('NameOfKeyManagerialPersonnelOrDirector'), 'CY', k(1), 'A PERSON'); put(s, c('DesignationOfKeyManagerialPersonnelOrDirector'), 'CY', k(1), 'Independent Director');
  put(s, c('NameOfKeyManagerialPersonnelOrDirector'), 'CY', k(2), 'B PERSON'); put(s, c('DesignationOfKeyManagerialPersonnelOrDirector'), 'CY', k(2), 'Company Secretary');
  const e = issues(s, 'SR-L3472-1', 'ERROR');
  assert.equal(e.length, 1);
  assert.match(e[0].message, /KMP1/);
  assert.equal(e[0].location?.conceptQName || e[0].concept || c('DirectorIdentificationNumberOfKeyManagerialPersonnelOrDirector'), c('DirectorIdentificationNumberOfKeyManagerialPersonnelOrDirector'));
  put(s, c('DirectorIdentificationNumberOfKeyManagerialPersonnelOrDirector'), 'CY', k(1), '07654321');
  assert.deepEqual(issues(s, 'SR-L3472-1', 'ERROR'), []);
});

test('v15.1: "Nature of other …" is required on every duration context of the member that carries values (SR-L1482-1), not for amounts at a balance date only (SR-L938-1)', () => {
  const s = session();
  const cls = ex(g('ClassesOfIntangibleAssetsAxis'), g('OtherIntangibleAssetsOthersMember'));
  const sub = ex(g('SubClassesOfIntangibleAssetsAxis'), g('IntangibleAssetsOtherThanInternallyGeneratedMember'));
  put(s, g('NatureOfOtherIntangibleAssets'), 'PY', [cls], 'NA');
  put(s, g('DescriptionOfAmortizationMethodUsed'), 'PY', [cls, sub], 'NA');
  const e = issues(s, 'SR-L1482-1', 'ERROR');
  assert.equal(e.length, 1, 'the context with the sub-class has values but no nature');
  assert.equal(e[0].scope, 'PY');
  put(s, g('NatureOfOtherIntangibleAssets'), 'PY', [cls, sub], 'NA');
  assert.deepEqual(issues(s, 'SR-L1482-1', 'ERROR'), []);
  // loans and advances – others at the balance date only: no nature required
  const t = session();
  put(t, g('LoansAndAdvancesGross'), 'CY', [ex(g('ClassificationBasedOnTimePeriodAxis'), g('ShortTermMember')), ex(g('ClassificationOfLoansAndAdvancesAxis'), g('OtherLoansAndAdvancesOthersMember')), ex(g('ClassificationOfAssetsBasedOnSecurityAxis'), g('SecuredConsideredGoodMember'))], 4859500);
  assert.deepEqual(issues(t, 'SR-L938-1', 'ERROR'), []);
});

test('v15.1: GR-3 — a child member with 0 needs no parent; a parent reported without the child\'s extra split counts', () => {
  const s = session();
  const gross = ex(g('CarryingAmountAccumulatedDepreciationAndGrossCarryingAmountAxis'), g('GrossCarryingAmountMember'));
  const owned = ex(g('SubClassesOfTangibleAssetsAxis'), g('OwnedAssetsMember'));
  const q = g('AdditionsOtherThanThroughBusinessCombinationsTangibleAssets');
  const gr3 = () => issues(s, 'GR-3', 'ERROR').filter((i) => i.message.includes('AdditionsOtherThanThroughBusinessCombinationsTangibleAssets') && /BuildingsMember/.test(i.message));
  put(s, q, 'CY', [ex(g('ClassesOfTangibleAssetsAxis'), g('FactoryBuildingMember')), owned, gross], 0);
  assert.deepEqual(gr3(), [], 'a 0 under the child');
  put(s, q, 'CY', [ex(g('ClassesOfTangibleAssetsAxis'), g('FactoryBuildingMember')), owned, gross], 1597400);
  assert.equal(gr3().length, 1, 'an amount under the child without its parent');
  put(s, q, 'CY', [ex(g('ClassesOfTangibleAssetsAxis'), g('BuildingsMember')), gross], 1597400);
  assert.deepEqual(gr3(), [], 'the parent with Gross carrying amount, without Owned assets');
});

test('v15.1: CSR — the amount spent must equal the spending table also under "CSR not applicable"; the table stays open while the amount is reported', () => {
  const s = session();
  const T = '301000a:ClassificationOfCSRSpendingTable';
  put(s, g('WhetherProvisionsOfCorporateSocialResponsibilityAreApplicableOnCompany'), 'CY', [], 'false');
  assert.equal(s.tableStatus(T, 'CY').applicable, false, 'closed while nothing needs it (as before)');
  put(s, c('AmountCSRSpentForFinancialYear'), 'CY', [], 950000);
  assert.equal(issues(s, 'SR-L3613-2', 'ERROR').length, 1, 'an empty table totals 0');
  const st = s.tableStatus(T, 'CY');
  assert.equal(st.applicable, true); assert.notEqual(st.mandatory, true);
  s.setTableValue(T, 'CY', [ty(g('ClassificationOfCSRSpendingAxis'), 'Education')], g('AmountSpentOnProjectsOrPrograms'), '950000');
  assert.deepEqual(issues(s, 'SR-L3613-2', 'ERROR'), []);
});

test('v15.1: a statement figure against its note sum is still not determinable without the note (no new error)', () => {
  const s = session();
  put(s, g('TangibleAssets'), 'CY', [], 1000);
  assert.deepEqual(issues(s, 'SR-L1381-2', 'ERROR'), []);
});

test('v15.1: the previous year of the top-ten shareholders table (GR-12, board report) is not written; the 5% shareholders table is', () => {
  const s = session();
  put(s, g('WhetherThereAreAnyShareholdersHoldingMoreThanFivePerCentSharesInCompany'), 'PY', [], 'true');
  put(s, g('NameOfShareholder'), 'PY', [ex(c('NameOfTop10ShareholderAxis'), c('Top1ShareholderMember')), ex(c('ChangeInShareholdingAxis'), c('ShareholdingAtBeginningOfYearMember'))], 'A HOLDER');
  put(s, g('NameOfShareholder'), 'PY', [ex(g('ClassesOfShareCapitalAxis'), g('EquityShares1Member')), ex(g('NameOfShareholderAxis'), g('Shareholder1Member'))], 'A HOLDER');
  const { emit, excluded } = new Applicability(A).planFacts(s.filing);
  assert.equal(excluded.filter((x) => x.fact.concept === g('NameOfShareholder')).length, 1);
  assert.ok(excluded.some((x) => x.fact.dims.some((d) => /Top10/.test(d.axis)) && x.reasons.some((r) => /GR-12/.test(r))));
  assert.ok(emit.some((f) => f.concept === g('NameOfShareholder') && f.dims.some((d) => d.member === g('Shareholder1Member'))));
});

test('v15.1: calibrated on the MCA-accepted filing — ML-41 approval dates and SR-L4140-1 warn; ML-41 stays blocking for its other elements', () => {
  const s = session();
  const m = [ty(c('MaterialContractsArrangementsTransactionsAtArmsLengthBasisAxis'), 'RP1')];
  put(s, c('WhetherThereAreMaterialContractsArrangementsTransactionsAtArmsLengthBasis'), 'CY', [], 'true');
  put(s, g('NameOfRelatedParty'), 'CY', m, 'A PARTY'); put(s, c('NatureOfRelatedPartyRelationship'), 'CY', m, 'Key managerial personnel or his relative');
  put(s, c('DescriptionOfNatureOfMaterialContractsArrangementsTransactionsWithRelatedParty'), 'CY', m, 'Loan');
  put(s, c('DurationOfMaterialContractsArrangementsTransactionsWithRelatedParty'), 'CY', m, '1 year');
  put(s, c('WhetherApprovalTakenFromBoardForMaterialContractsorArrangementsorTransactionsWithRelatedParty'), 'CY', m, 'true');
  assert.deepEqual(issues(s, 'ML-41', 'ERROR'), []);
  assert.equal(issues(s, 'ML-41', 'WARNING').length, 1);
  s.filing.removeFact(s.filing.get(c('DurationOfMaterialContractsArrangementsTransactionsWithRelatedParty'), s.filing.period(c('DurationOfMaterialContractsArrangementsTransactionsWithRelatedParty'), 'CY'), m).key);
  assert.equal(issues(s, 'ML-41', 'ERROR').length, 1);
  const t = session();
  const sa = [ty(c('SignatoriesOfSecretarialAuditReportAxis'), '1')];
  put(t, c('WhetherSecretarialAuditReportIsApplicableOnCompany'), 'CY', [], 'true');
  put(t, c('CategoryOfSecretarialAuditor'), 'CY', sa, 'Secretarial auditors firm');
  assert.deepEqual(issues(t, 'SR-L4140-1', 'ERROR'), []);
  assert.equal(issues(t, 'SR-L4140-1', 'WARNING').length, 1);
});

test('v15.1: imported content under the other Yes/No answer is kept (the filer\'s filed content); typed or empty values are not', () => {
  const s = session();
  put(s, c('WhetherSecretarialAuditReportHasBeenQualifiedOrHasAnyObservationOrOtherRemarks'), 'CY', [], 'false');
  put(s, c('SecretarialQualificationsOrObservationsOrOtherRemarksInSecretarialAuditReport'), 'CY', [], 'Pursuant to section 204');
  const ap = new Applicability(A);
  assert.ok(ap.planFacts(s.filing).emit.some((f) => f.concept === c('SecretarialQualificationsOrObservationsOrOtherRemarksInSecretarialAuditReport')));
  const t = session();
  put(t, c('WhetherSecretarialAuditReportHasBeenQualifiedOrHasAnyObservationOrOtherRemarks'), 'CY', [], 'false');
  put(t, c('SecretarialQualificationsOrObservationsOrOtherRemarksInSecretarialAuditReport'), 'CY', [], 'Typed under Yes, then No', 'user');
  assert.ok(ap.planFacts(t.filing).excluded.some((x) => x.fact.concept === c('SecretarialQualificationsOrObservationsOrOtherRemarksInSecretarialAuditReport')));
});

// ---- on the reference files (local only)
const C24 = 'golden-FILING-C_2024-25.xml', C25 = 'validator-FILING-C_2025-26.xml';
test('v15.1: the MCA-accepted filing (FY 2024-25) — no error, every fact with content kept', { skip: !existsSync(C24) && 'reference file not present' }, () => {
  const s = new Session(A);
  const rep = s.importXml(readFileSync(C24, 'utf8'), { DOMParserImpl: DOMParser, yearMode: 'both' });
  assert.deepEqual(s.validate({ today: '2026-10-21' }).issues.filter((i) => i.severity === 'ERROR').map((i) => i.message), []);
  assert.deepEqual(rep.notApplicable.filter((x) => !(x.value == null || ['0', 'false'].includes(x.value) || !String(x.value).replace(/<[^>]*>/g, '').trim())), []);
});
test('v15.1: the next filing run through the MCA XBRL Validator (FY 2025-26) — exactly the validator\'s errors', { skip: !existsSync(C25) && 'reference file not present' }, () => {
  const s = new Session(A);
  s.importXml(readFileSync(C25, 'utf8'), { DOMParserImpl: DOMParser, yearMode: 'both' });
  const errs = s.validate({ today: '2026-10-21' }).issues.filter((i) => i.severity === 'ERROR');
  // the validator: (1) NameOfShareholder not applicable for the previous year → not written (below); (2) Nature of other
  // intangible assets on {other than internally generated, others} for 31/03/2025; (3) DIN of an independent director;
  // (4) amount spent on CSR ≠ total of the CSR spending table
  assert.deepEqual(errs.map((i) => `${i.ruleId} ${i.scope}`).sort(), ['SR-L1482-1 PY', 'SR-L3472-1 CY', 'SR-L3613-2 CY']);
  assert.match(errs.find((i) => i.ruleId === 'SR-L1482-1').message, /IntangibleAssetsOtherThanInternallyGenerated/);
  assert.match(errs.find((i) => i.ruleId === 'SR-L3472-1').message, /KMP5/);
  const xml = s.exportXml({ allowErrors: true, today: '2026-10-21' }).xml;
  const pyTop10 = [...xml.matchAll(/<xbrli:context id="([^"]+)">(?:(?!<\/xbrli:context>)[\s\S])*NameOfTop10ShareholderAxis(?:(?!<\/xbrli:context>)[\s\S])*<xbrli:startDate>2024-04-01/g)].map((m) => m[1]);
  assert.ok(!pyTop10.some((id) => new RegExp(`<in-gaap:NameOfShareholder contextRef="${id}"`).test(xml)), 'no previous-year name in the top-ten shareholders table');
});
