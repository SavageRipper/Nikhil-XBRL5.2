// v13.2: previous-year OPENING values (dated the day before the previous year starts) left from an earlier year's
// filing when its dates are moved forward. GR-1 errors on them point to the opening-balance cell that shows them
// (previous-year view of the reconciliation), or — when no tab shows them — to a removable "opening value" location;
// "Remove opening values without totals" removes exactly the values behind those errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { authority } from './helpers.mjs';
import { Session } from './session.js';
import { reachable } from './assurance.mjs';

const A = authority();
const xml = readFileSync(new URL('./golden-FILING-B_2024-25.xml', import.meta.url), 'utf8');
const TODAY = '2026-10-06';

function movedForward() {
  // last year's accepted filing, both years imported, then its dates moved one year forward (the way a
  // 2025-26 project was prepared): last year's previous-year figures become previous-year OPENING values
  const S = new Session(A);
  S.importXml(xml, { DOMParserImpl: DOMParser, yearMode: 'both' });
  S.setMeta({ periods: { cy: { start: '2025-04-01', end: '2026-03-31' }, py: { start: '2024-04-01', end: '2025-03-31' } } });
  // as in such a project: the opening values of some totals are gone (shareholders' funds, fixed assets, provisions)
  const gone = new Set(['ShareholdersFunds', 'NoncurrentLiabilities', 'CurrentLiabilities', 'EquityAndLiabilities', 'FixedAssets', 'NoncurrentAssets', 'CurrentAssets', 'Assets', 'Provisions'].map((l) => A.qnameOfLocal(l)));
  for (const f of S.pyOpeningFacts()) if (gone.has(f.concept)) S.filing.removeFact(f.key);
  return S;
}

test('GR-1 on a previous-year opening value: the message says so and points to a cell or a removable value', () => {
  const S = movedForward();
  assert.ok(S.pyOpeningFacts().length > 0);
  const g = S.validate({ today: TODAY });
  const pyo = g.issues.filter((i) => i.ruleId === 'GR-1' && i.severity === 'ERROR' && /calculation parent/.test(i.message) && S.filing.scopeOf(S.filing.facts.get(i.factKey)?.period) === 'PYO');
  assert.ok(pyo.length > 0, 'the scenario produces GR-1 errors on opening values');
  for (const i of pyo) {
    assert.match(i.message, /previous-year opening value \(dated \d{4}-\d{2}-\d{2}\)/);
    assert.equal(reachable(S, i.location), null, i.message);
    if (i.location.kind === 'cell') assert.equal(i.location.cellId, i.factKey, 'the cell that shows the value');
    else assert.equal(i.location.kind, 'pyo');
  }
});

test('"Remove opening values without totals" removes only the values behind those errors', () => {
  const S = movedForward();
  const before = S.pyOpeningFacts().length;
  const kept = new Map(S.pyOpeningFacts().map((f) => [f.key, f.value]));
  const g = S.validate({ today: TODAY });
  const orphans = S.pyOpeningOrphans(g);
  assert.ok(orphans.length > 0 && orphans.length < before, `${orphans.length} of ${before}`);
  const removed = S.removePyOpeningOrphans(g);
  assert.ok(removed.length >= orphans.length);
  const g2 = S.validate({ today: TODAY });
  const left = g2.issues.filter((i) => i.severity === 'ERROR' && S.filing.scopeOf(S.filing.facts.get(i.factKey)?.period) === 'PYO');
  assert.deepEqual(left.map((i) => i.message), []);
  // every other opening value is kept with its value (totals of the remaining parts may be recalculated, as for any edit)
  const gone = new Set(removed.map((f) => f.key));
  for (const [k, v] of kept) if (!gone.has(k)) { const f = S.filing.facts.get(k); assert.ok(f, k); if (f.origin !== 'calculated') assert.equal(f.value, v, k); }
  assert.ok(S.pyOpeningFacts().length > 0 && removed.length < before);
});
