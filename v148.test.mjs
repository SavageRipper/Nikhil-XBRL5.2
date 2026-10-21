// v14.8: the instance lists the current year first — contexts and, for each element, the current-year fact before the
// previous-year fact — as the MCA-filed reference instances do. The MCA AOC-4 XBRL form reported "Mismatch in financial
// year (to which financial statements relates) in Form and instance document" for an instance whose first context and
// first DateOfStartOfReportingPeriod / DateOfEndOfReportingPeriod facts were the previous year's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { authority, importSession } from './helpers.mjs';
import { Session } from './session.js';
import { buildExample } from './example.js';

const A = authority();
const contexts = (xml) => [...xml.matchAll(/<xbrli:context id="([^"]+)">[\s\S]*?<xbrli:period>([\s\S]*?)<\/xbrli:period>([\s\S]*?)<\/xbrli:context>/g)]
  .map((m) => ({ id: m[1], period: m[2].replace(/<[^>]+>/g, ' ').trim().replace(/\s+/g, '..'), dims: /scenario/.test(m[3]) }));
const periodFacts = (xml) => [...xml.matchAll(/<in-ca:(DateOfStartOfReportingPeriod|DateOfEndOfReportingPeriod) contextRef="[^"]+">([^<]+)</g)].map((m) => [m[1], m[2]]);

const check = (xml, cy, py) => {
  const c = contexts(xml);
  assert.equal(c[0].period, `${cy.start}..${cy.end}`, 'the first context is the current year');
  assert.equal(c[0].dims, false);
  // every current-year context before every previous-year context
  const rank = (x) => (x.period === `${cy.start}..${cy.end}` || x.period === cy.end ? 0 : x.period === `${py.start}..${py.end}` || x.period === py.end ? 1 : 2);
  const ranks = c.map(rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'current year, previous year, then other dates');
  assert.deepEqual(periodFacts(xml), [['DateOfStartOfReportingPeriod', cy.start], ['DateOfStartOfReportingPeriod', py.start], ['DateOfEndOfReportingPeriod', cy.end], ['DateOfEndOfReportingPeriod', py.end]]);
};

test('a filing entered here: the current year first', () => {
  const s = new Session(A); buildExample(s);
  const { cy, py } = s.filing.meta.periods;
  check(s.exportXml({ today: '2025-09-30' }).xml, cy, py);
});

const REF = ['FILING-A', 'FILING-B'].every((g) => existsSync(new URL(`./golden-${g}_2024-25.xml`, import.meta.url)));
test('the reference instances (filed with MCA) list the current year first; regenerated, they still do', { skip: !REF && 'reference instances not present' }, () => {
  for (const g of ['FILING-A', 'FILING-B']) {
    const xml = readFileSync(new URL(`./golden-${g}_2024-25.xml`, import.meta.url), 'utf8');
    const cy = { start: '2024-04-01', end: '2025-03-31' }, py = { start: '2023-04-01', end: '2024-03-31' };
    assert.equal(contexts(xml).find((x) => !x.dims && /\.\./.test(x.period)).period, `${cy.start}..${cy.end}`, `${g} as filed`);
    const { s } = importSession(xml);
    check(s.exportXml({ today: '2025-10-30' }).xml, cy, py);
  }
});
