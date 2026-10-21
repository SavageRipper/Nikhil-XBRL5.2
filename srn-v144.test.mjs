// v14.4: the SRN of MCA V3 forms (two letters + seven digits, e.g. AB1234567) is accepted, as in the C&I taxonomy that
// the MCA XBRL Validator downloads (in-ca-types:SRNNumber has a second xsd:pattern; XML Schema treats several patterns
// as alternatives). The older format (one letter + eight digits, e.g. Z99999999) stays valid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authority } from './helpers.mjs';
import { Session } from './session.js';
import { buildExample } from './example.js';
import { xsdValidatorStatus, validateInstanceXml } from './xsd-validate.mjs';
import { ensureTaxonomy, validatorUpdates } from './taxonomy-source.mjs';
import { generateInstance } from './generator.js';

const A = authority();
const today = '2025-09-30';
const withSrn = (srn) => {
  const S = new Session(A); buildExample(S);
  const f = [...S.filing.facts.values()].find((x) => x.concept === 'in-ca:SRNOfFormADT1');
  S.setTableValue('400200a:DetailsRegardingAuditorsTable', 'CY', f.dims, 'in-ca:SRNOfFormADT1', srn);
  assert.equal(S.filing.facts.get(f.key).value, srn);
  return S;
};
const srnIssues = (S) => S.validate({ today }).issues.filter((i) => /value\.(pattern|length)/.test(i.code) && /SRN/.test(i.message));

test('the SRN type compiles both patterns of the validator taxonomy, as alternatives', () => {
  const t = A.types['in-ca-types:SRNNumber'];
  assert.deepEqual(t.patterns, ['[A-Z][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]', '[A-Z][A-Z][0-9][0-9][0-9][0-9][0-9][0-9][0-9]']);
  assert.equal(t.length, '9');
  for (const c of ['in-ca:SRNOfFormADT1', 'in-ca:SRNOfFilingOfBalanceSheetBySubsidiary']) assert.equal(A.concepts[c].type, 'in-ca-types:SRNNumber', c);
  // every other type keeps its single pattern exactly as before
  const multi = Object.entries(A.types).filter(([, x]) => x.patterns).map(([k]) => k);
  assert.deepEqual(multi, ['in-ca-types:SRNNumber']);
});

test('only the SRN type differs between the published taxonomy and the validator\'s copy', () => {
  const root = ensureTaxonomy();
  const marker = JSON.parse(readFileSync(new URL('./.taxonomy/.validator-update', import.meta.url), 'utf8'));
  assert.deepEqual(marker.updated.map((u) => u.file), ['IN-CA/in-ca-types-2016-03-31.xsd']);
  assert.deepEqual(validatorUpdates(), [], 'already applied');
  assert.match(readFileSync(`${root}/IN-CA/in-ca-types-2016-03-31.xsd`, 'utf8'), /<xsd:pattern value="\[A-Z\]\[A-Z\]\[0-9\]/);
});

test('validation: SRN in the MCA V3 format and in the old format pass; other shapes are errors', () => {
  for (const ok of ['AB1234567', 'A12345678', 'Z99999999', 'F12345678']) assert.deepEqual(srnIssues(withSrn(ok)).map((i) => i.message), [], ok);
  for (const bad of ['ABC123456', '123456789', 'AB12345678', 'A1234567', 'ab1234567', 'A1B234567']) assert.ok(srnIssues(withSrn(bad)).length >= 1, bad);
});

const st = xsdValidatorStatus();
test('XML Schema validation (Arelle, with the validator taxonomy): the MCA V3 SRN is valid, a wrong SRN is not', { skip: !st.available && `XSD validator not available: ${st.reason}` }, () => {
  const good = validateInstanceXml(withSrn('AB1234567').exportXml({ today }).xml, { label: 'srn-v3.xml' });
  assert.equal(good.status, 'PASS', good.errors.slice(0, 5).map((e) => e.message).join('\n'));
  // Arelle itself checks only the first pattern; its report on the V3 SRN is recognised as not an error
  assert.ok(good.warnings.some((w) => /AB1234567/.test(w.message) && /another xsd:pattern/.test(w.note || '')), 'Arelle limitation recognised');
  // the gate refuses to export a wrong SRN, so the instance is written directly to prove the schema itself rejects it
  const S = withSrn('ABC123456');
  const bad = validateInstanceXml(generateInstance(A, S.filing, S.app.planFacts(S.filing).emit).xml, { label: 'srn-bad.xml' });
  assert.ok(bad.errors.some((e) => /ABC123456|SRNNumber|pattern/i.test(e.message)), JSON.stringify(bad.errors.slice(0, 3)));
  assert.equal(bad.status, 'FAIL');
});
