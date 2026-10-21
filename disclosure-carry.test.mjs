// v13: "Copy from previous year" on the disclosure tabs ([400100]–[400500], reported for the current year only —
// MCA GR-12): last year's values come from the project (a project moved forward) or from an import as
// "Next year's filing" (kept in the import report as not applicable for a previous year).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { authority, q } from './helpers.mjs';
import { Session } from './session.js';
import { disclosureCarryPlan, disclosureCarry, previousYearValues } from './carry-forward.js';

const A = authority();
const xml = readFileSync(new URL('./golden-FILING-B_2024-25.xml', import.meta.url), 'utf8');
const discs = A.elrs.filter((e) => e.group === 'Disclosures');
const errors = (S) => S.validate({ today: '2025-09-30' }).issues.filter((i) => i.severity === 'ERROR').length;

test('next year\'s filing: last year\'s disclosures are offered and copied into empty current-year cells only', () => {
  const S = new Session(A);
  S.importXml(xml, { DOMParserImpl: DOMParser, yearMode: 'next' });
  assert.ok(previousYearValues(S).size > 0);
  const before = errors(S);
  let copied = 0;
  for (const e of discs) {
    const plan = disclosureCarryPlan(S, e.uri);
    assert.ok(plan.available, plan.reason);
    const r = disclosureCarry(S, e.uri);
    assert.deepEqual(r.skipped, []);
    copied += r.copied;
    assert.equal(disclosureCarryPlan(S, e.uri).items.length, 0, 'nothing left to copy');
  }
  assert.ok(copied > 100, String(copied));
  // the copied values are last year's current-year values
  const G = new Session(A);
  G.importXml(xml, { DOMParserImpl: DOMParser, yearMode: 'both' });
  for (const l of ['NameOfCompany', 'NameOfAuditFirm', 'WhetherCompanyIsListedCompany']) {
    const c = q(l);
    const v = S.getValue(c, 'CY'), g = G.getValue(c, 'CY');
    if (g && G.conceptStatus(c, 'CY').applicable) assert.equal(v?.value, g.value, l);
  }
  assert.ok(errors(S) <= before, 'copying never adds errors here');
});

test('existing current-year values are never overwritten; other tab groups are not offered', () => {
  const S = new Session(A);
  S.importXml(xml, { DOMParserImpl: DOMParser, yearMode: 'next' });
  const gi = discs.find((e) => e.code === '400100').uri;
  const plan = disclosureCarryPlan(S, gi);
  const row = plan.items.find((i) => i.kind === 'row' && A.dataType(i.concept) === 'string');
  S.setValue(row.concept, 'CY', 'MY OWN VALUE', { tab: gi, preferredLabel: row.preferredLabel });
  disclosureCarry(S, gi);
  assert.equal(S.getValue(row.concept, 'CY', [], row.preferredLabel).value, 'MY OWN VALUE');
  assert.equal(disclosureCarryPlan(S, A.elrByCode('100100').uri).available, false);
});

test('a filing without last year\'s values offers nothing (with the reason)', () => {
  const S = new Session(A);
  S.importXml(xml, { DOMParserImpl: DOMParser, yearMode: 'both' });
  const p = disclosureCarryPlan(S, discs[1].uri);
  assert.equal(p.items.length, 0);
  assert.ok(p.reason);
});
