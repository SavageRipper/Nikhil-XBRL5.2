// v14.2: dates are typed day first (dd-mm-yyyy) whatever the browser's language
import test from 'node:test';
import assert from 'node:assert/strict';
import { dmyOf, isoOfDmy, longDate } from './dates.js';

test('day first: dd-mm-yyyy, d-m-yyyy, / . space separators, ddmmyyyy', () => {
  for (const s of ['05-09-2026', '5-9-2026', '05/09/2026', '05.09.2026', '5 9 2026', '05092026', ' 05-09-2026 ']) assert.deepEqual(isoOfDmy(s), { iso: '2026-09-05' }, s);
  assert.deepEqual(isoOfDmy('31-03-2026'), { iso: '2026-03-31' });
  assert.deepEqual(isoOfDmy('29-02-2024'), { iso: '2024-02-29' });
});
test('yyyy-mm-dd is accepted as it is; empty clears', () => {
  assert.deepEqual(isoOfDmy('2026-09-05'), { iso: '2026-09-05' });
  assert.deepEqual(isoOfDmy(''), { iso: '' });
  assert.deepEqual(isoOfDmy('   '), { iso: '' });
});
test('impossible or unreadable dates are refused with a day-first hint', () => {
  for (const s of ['31-02-2026', '29-02-2025', '05-13-2026', '00-01-2026', '5 Sept 2026', '05-09-26', '2026/09/05x']) {
    const r = isoOfDmy(s);
    assert.ok(r.error && /dd-mm-yyyy/.test(r.error), s);
  }
});
test('display: dd-mm-yyyy and in words', () => {
  assert.equal(dmyOf('2026-09-05'), '05-09-2026');
  assert.equal(dmyOf(''), '');
  assert.equal(longDate('2026-09-05'), '5 September 2026');
  assert.equal(longDate('2026-05-09'), '9 May 2026');
  assert.equal(longDate('2026-02-30'), '');
  for (const iso of ['2026-01-01', '2026-12-31', '2024-02-29']) assert.equal(isoOfDmy(dmyOf(iso)).iso, iso);
});
