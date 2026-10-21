// v15.0: a calculated total is rounded to the accuracy of its least accurate part (the rule of the Ind AS tool v1.5),
// never to fewer places than the statement figures, so it equals the total as presented in the statements. Before v15.0
// every digit of the exact sum was kept: share capital 412.356 lakhs (to ₹100) with amounts to 2 places (to ₹1,000) gave
// Total equity and liabilities 8,299.706 where the balance sheet shows 8,299.71, and SR-L28-1 (= Total assets) failed.
// Share capital itself stays the actual value (MCA); figures reported as exact (decimals="INF") keep their digits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { authority } from './helpers.mjs';
import { Session, sumDecimals } from './session.js';
import { Filing } from './model.js';
import { healthCheck } from './upkeep.js';
import * as Dec from './decimal.js';
import { DOMParser } from '@xmldom/xmldom';

const A = authority();
const q = (l) => 'in-gaap:' + l;
const P = { cy: { start: '2025-04-01', end: '2026-03-31' }, py: { start: '2024-04-01', end: '2025-03-31' } };
function session({ dp = 3, sp = 2, level = 'Lakhs' } = {}) {
  const s = new Session(A);
  s.setMeta({ name: 'Test Co', cin: 'U72200KA2010PTC123456', reportType: 'Standalone', level, displayPlaces: dp, statementPlaces: sp, periods: JSON.parse(JSON.stringify(P)) });
  return s;
}
const put = (s, entries, scopes = ['CY']) => { for (const [l, v] of entries) for (const sc of scopes) s.setValue(q(l), sc, v, { recalc: true, strict: true }); };
const cell = (s, l, sc = 'CY') => s.filing.get(q(l), s.filing.period(q(l), sc), []);
const shown = (s, l, sc = 'CY') => { const f = cell(s, l, sc); return f ? String(s.displayOf(f)) : null; };
const sr28 = (s) => s.validate({ today: '2026-10-05' }).issues.filter((i) => i.ruleId === 'SR-L28-1');

// the balance sheet of the report (lakhs, 3 places shown, statement figures to 2 places, share capital to 3)
const BS = [['ShareCapital', '412.356'], ['ReservesAndSurplus', '2871.04'], ['ShareApplicationMoneyPendingAllotment', '0'], ['LongTermBorrowings', '158.27'], ['OtherLongTermLiabilities', '0'], ['LongTermProvisions', '94.61'],
  ['ShortTermBorrowings', '2950.44'], ['TradePayables', '1423.18'], ['OtherCurrentLiabilities', '301.72'], ['ShortTermProvisions', '88.09'],
  ['TangibleAssets', '3500.00'], ['Inventories', '2500.00'], ['CashAndBankBalances', '2299.71']];

test('v15.0: totals over a share capital to 3 places are rounded to the statement figures — 3,283.40 and 8,299.71; Equity and liabilities = Assets', () => {
  const s = session();
  put(s, BS, ['CY', 'PY']);
  for (const sc of ['CY', 'PY']) {
    assert.equal(shown(s, 'ShareCapital', sc), '412.356', 'share capital keeps its actual value');
    assert.equal(shown(s, 'ShareholdersFunds', sc), '3283.4');
    assert.equal(cell(s, 'ShareholdersFunds', sc).decimals, '-3');
    assert.equal(shown(s, 'NoncurrentLiabilities', sc), '252.88');
    assert.equal(shown(s, 'CurrentLiabilities', sc), '4763.43');
    assert.equal(shown(s, 'EquityAndLiabilities', sc), '8299.71');
    assert.equal(shown(s, 'Assets', sc), '8299.71');
  }
  assert.deepEqual(sr28(s), []);
  // XBRL calculation (Calculations 1.1): the parts' sum rounded to the total's decimals equals the total
  const sum = Dec.sum(['ShareCapital', 'ReservesAndSurplus'].map((l) => Dec.parse(cell(s, l).value)));
  assert.ok(Dec.eq(Dec.round(sum, -3), Dec.parse(cell(s, 'ShareholdersFunds').value)));
  // non-significant digits are 0 (Filing Manual #13)
  assert.ok(Dec.eq(Dec.round(Dec.parse(cell(s, 'EquityAndLiabilities').value), -3), Dec.parse(cell(s, 'EquityAndLiabilities').value)));
  const xml = s.exportXml({ allowErrors: true, today: '2026-10-05' }).xml;
  assert.match(xml, /<in-gaap:EquityAndLiabilities contextRef="[^"]+" unitRef="[^"]+" decimals="-3">829971000</);
  assert.match(xml, /<in-gaap:ShareCapital contextRef="[^"]+" unitRef="[^"]+" decimals="-2">41235600</);
});

test('v15.0: rounding half away from zero, below half, negative totals', () => {
  for (const [sc, re, out] of [['412.355', '2871.04', '3283.4'], ['412.354', '2871.04', '3283.39'], ['412.356', '-2871.04', '-2458.68']]) {
    const s = session();
    put(s, [['ShareCapital', sc], ['ReservesAndSurplus', re]]);
    assert.equal(shown(s, 'ShareholdersFunds'), out, `${sc} + ${re}`);
  }
});

test('v15.0: nothing is rounded when every part is as accurate as the total (all to 3 places), or when the statement figures are at 3 places', () => {
  const s = session();
  put(s, [['ShareCapital', '412.356'], ['ReservesAndSurplus', '2871.045']]);
  assert.equal(shown(s, 'ShareholdersFunds'), '3283.401');
  const t = session({ sp: 3 });
  put(t, [['ShareCapital', '412.356'], ['ReservesAndSurplus', '2871.04']]);
  assert.equal(shown(t, 'ShareholdersFunds'), '3283.396');
  // "Same as presented" (no statement places chosen, projects before v14.3): as before v15.0
  const u = session({ sp: null });
  put(u, [['ShareCapital', '412.356'], ['ReservesAndSurplus', '2871.04']]);
  assert.equal(shown(u, 'ShareholdersFunds'), '3283.396');
});

test('v15.0: a part that is 0 does not make a total coarser', () => {
  const s = session();
  put(s, [['ShareCapital', '412.356'], ['ReservesAndSurplus', '2871.045'], ['MoneyReceivedAgainstShareWarrants', '0']]);
  assert.equal(shown(s, 'ShareholdersFunds'), '3283.401');
  assert.equal(sumDecimals([{ value: '0', decimals: '-5' }, { value: '100', decimals: '0' }], Dec.parse('100'), -3), '0');
});

test('v15.0: share capital from its note keeps the actual value, also with a class still declared coarser; the totals above it are rounded', () => {
  const T = A.tables.find((t) => t.id.startsWith('200100:')).id;
  const AX = q('ClassesOfShareCapitalAxis');
  const s = session();
  s.setTableValue(T, 'CY', [{ axis: AX, member: q('EquityShares1Member') }], q('ShareCapital'), '380.356', { recalc: true });
  s.setTableValue(T, 'CY', [{ axis: AX, member: q('PreferenceShares1Member') }], q('ShareCapital'), '32.00', { recalc: true });
  put(s, [['ReservesAndSurplus', '2871.04']]);
  assert.equal(shown(s, 'ShareCapital'), '412.356');
  assert.equal(shown(s, 'ShareholdersFunds'), '3283.4');
  // the class declared to ₹1,000 still carries the share-capital warning (with its fix)
  assert.ok(s.validate({ today: '2026-10-05' }).issues.some((i) => /share capital is reported accurate only to ₹1,000/.test(i.message)));
});

test('v15.0: figures reported as exact (decimals="INF") keep their digits in a total — a figure with paise in a filing in rupees', () => {
  const s = session({ level: 'Actual', dp: 2, sp: 0 });
  const set = (l, v, d) => s.filing.setFact({ concept: q(l), period: s.filing.period(q(l), 'CY'), value: v, decimals: d, origin: 'import' });
  set('ShareCapital', '10000000', '0'); set('ReservesAndSurplus', '18402557.36', 'INF');
  s.recalcFrom(q('ReservesAndSurplus'), s.filing.period(q('ReservesAndSurplus'), 'CY'), [], 0, { before: null, after: '18402557.36' });
  assert.equal(cell(s, 'ShareholdersFunds').value, '28402557.36');
  assert.equal(cell(s, 'ShareholdersFunds').decimals, '2');
});

test('v15.0: a v14.9 project (calculated totals with every digit) is corrected by the health check on opening; entered and imported figures are not changed', () => {
  const s = session();
  put(s, BS, ['CY', 'PY']);
  const json = s.filing.toJSON();
  // as v14.9 saved it: the calculated totals carried the share capital's third decimal
  for (const f of json.facts) {
    const l = f.concept.split(':')[1];
    if (l === 'ShareholdersFunds') Object.assign(f, { value: '328339600', decimals: '-2' });
    if (l === 'EquityAndLiabilities') Object.assign(f, { value: '829970600', decimals: '-2' });
  }
  const S = new Session(A, Filing.fromJSON(A, json));
  assert.equal(sr28(S).length, 2, 'v14.9 project: Equity and liabilities ≠ Assets, both years');
  const h = healthCheck(S);
  assert.ok(h.changed);
  assert.equal(shown(S, 'ShareholdersFunds'), '3283.4');
  assert.equal(shown(S, 'EquityAndLiabilities', 'PY'), '8299.71');
  assert.deepEqual(sr28(S), []);
  for (const f of S.filing.all()) if (f.origin !== 'calculated') assert.equal(f.value, s.filing.get(f.concept, f.period, f.dims).value, f.concept);
});

test('v15.0: an XML generated by v14.9 keeps its imported totals; Recalculate rounds them', () => {
  const s = session();
  put(s, BS);
  const xml = s.exportXml({ allowErrors: true, today: '2026-10-05' }).xml
    .replace(/(<in-gaap:ShareholdersFunds [^>]*decimals=")-3(">)328340000/, '$1-2$2328339600')
    .replace(/(<in-gaap:EquityAndLiabilities [^>]*decimals=")-3(">)829971000/, '$1-2$2829970600');
  assert.match(xml, />829970600</);
  const S = new Session(A);
  S.importXml(xml, { DOMParserImpl: DOMParser, yearMode: 'current' });
  assert.equal(shown(S, 'EquityAndLiabilities'), '8299.706', 'an imported total is the filer\'s figure');
  assert.equal(sr28(S).length, 1);
  S.recalculateAll({ scopes: ['CY'] });
  assert.equal(shown(S, 'EquityAndLiabilities'), '8299.71');
  assert.deepEqual(sr28(S), []);
});
