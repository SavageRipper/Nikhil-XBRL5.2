// v14.3: amounts carry their actual values (MCA XBRL Validator: "make sure that validated XML has actual values for all the
// fields including share capital … the Level Of Rounding Off selection in XBRL instance is for PDF presentation purpose only")
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { authority, q } from './helpers.mjs';
import { Session } from './session.js';
import { Filing, FactValueError } from './model.js';
import { fixFor } from './fixes.js';
import { generateInstance } from './generator.js';

const A = authority();
const today = '2026-10-12';
const P = { cy: { start: '2025-04-01', end: '2026-03-31' }, py: { start: '2024-04-01', end: '2025-03-31' } };
const session = (meta) => { const S = new Session(A); S.setMeta({ name: 'T', cin: 'U99999MH2000PTC999999', reportType: 'Standalone', firstFinancialYear: false, periods: P, ...meta }); return S; };
const put = (S, local, display, o = {}) => { S.setValue(q(local), 'CY', display, { strict: true, ...o }); return S.getValue(q(local), 'CY'); };
const scWarnings = (S) => S.validate({ today }).issues.filter((i) => i.code === 'shareCapital.rounded');

test('the user\'s examples: lakhs, 5 places, statements at 2 — every digit kept, each amount at the accuracy typed', () => {
  const S = session({ level: 'Lakhs', displayPlaces: 5, statementPlaces: 2 });
  let f = put(S, 'ShareCapital', '12.5236'); assert.deepEqual([f.value, f.decimals], ['1252360', '-1']);
  f = put(S, 'ShareCapital', '12.52365'); assert.deepEqual([f.value, f.decimals], ['1252365', '0']);
  f = put(S, 'TradeReceivables', '45.26'); assert.deepEqual([f.value, f.decimals], ['4526000', '-3']);
  f = put(S, 'TradeReceivables', '45.2567'); assert.deepEqual([f.value, f.decimals], ['4525670', '-1']);
  f = put(S, 'ShareCapital', '100.00000'); assert.deepEqual([f.value, f.decimals], ['10000000', '0'], 'trailing zeros typed = accuracy typed');
  f = put(S, 'ShareCapital', '100'); assert.deepEqual([f.value, f.decimals], ['10000000', '-3'], 'never coarser than the statement figures');
  const S7 = session({ level: 'Lakhs', displayPlaces: 7, statementPlaces: 2 });
  f = put(S7, 'TradeReceivables', '1.2345678'); assert.deepEqual([f.value, f.decimals], ['123456.78', '2'], 'paise with 7 places in lakhs');
});

test('more digits than the places chosen are refused, never rounded; nothing is changed', () => {
  const S = session({ level: 'Lakhs', displayPlaces: 4, statementPlaces: 2 });
  put(S, 'ShareCapital', '12.5236');
  assert.throws(() => put(S, 'ShareCapital', '12.52365'), (e) => e instanceof FactValueError && /has 5 decimal places/.test(e.message) && /up to 4/.test(e.message) && /5 places = exact rupees, 7 = paise/.test(e.message) && /Nothing was rounded/.test(e.message));
  assert.equal(S.getValue(q('ShareCapital'), 'CY').value, '1252360', 'the stored value is unchanged');
  const g = put(S, 'ShareCapital', '12.52360000'); // trailing zeros lose nothing
  assert.equal(g.value, '1252360');
  // the old (non-strict) entry paths keep their behaviour: internal derivations round to the places as before
  S.setValue(q('ShareCapital'), 'CY', '12.52365');
  assert.equal(S.getValue(q('ShareCapital'), 'CY').value, '1252370');
});

test('Actual: rupees exact, paise with 2 places, a third decimal refused', () => {
  const S = session({ level: 'Actual', displayPlaces: 2 });
  assert.deepEqual([put(S, 'ShareCapital', '1252365').value, put(S, 'ShareCapital', '1252365').decimals], ['1252365', '2']);
  assert.throws(() => put(S, 'TradeReceivables', '10.005'), /has 3 decimal places/);
  const Z = session({ level: 'Actual', displayPlaces: 0 });
  assert.throws(() => put(Z, 'TradeReceivables', '10.5'), /2 places = paise/);
});

test('statement places "same as presented" (null) = the v14.2 rule: every typed amount at the accuracy of the places', () => {
  const S = session({ level: 'Lakhs', displayPlaces: 2 });
  assert.equal(S.filing.meta.statementPlaces, null);
  assert.equal(put(S, 'TradeReceivables', '45.26').decimals, '-3');
  assert.equal(put(S, 'TradeReceivables', '45.2').decimals, '-3');
  assert.equal(put(S, 'TradeReceivables', '45').decimals, '-3');
});

test('share capital declared coarser than the rupee: a warning at its cell (not blocking) with a fix that only confirms the accuracy', () => {
  const S = session({ level: 'Lakhs', displayPlaces: 2 });
  put(S, 'ShareCapital', '100');
  const w = scWarnings(S);
  assert.equal(w.length, 1);
  assert.equal(w[0].severity, 'WARNING');
  assert.match(w[0].message, /accurate only to ₹1,000 \(decimals -3\)/);
  assert.match(w[0].message, /BO processing/);
  assert.ok(w[0].location, 'the warning opens its cell');
  assert.ok(fixFor(S, w[0]).disabled, 'needs the places for exact rupees first');
  S.setMeta({ displayPlaces: 5, statementPlaces: 2 });
  const fx = fixFor(S, scWarnings(S)[0]);
  assert.equal(fx.label, 'Confirm as the actual value');
  assert.match(fx.confirm, /₹1,00,00,000/);
  fx.apply();
  const f = S.getValue(q('ShareCapital'), 'CY');
  assert.deepEqual([f.value, f.decimals], ['10000000', '0']);
  assert.equal(scWarnings(S).length, 0);
  // a typed figure to the rupee raises nothing; the previous year and zeros are not checked
  const T = session({ level: 'Lakhs', displayPlaces: 5, statementPlaces: 2 });
  put(T, 'ShareCapital', '12.52365');
  T.setValue(q('ShareCapital'), 'PY', '12', { strict: true });
  assert.equal(scWarnings(T).length, 0);
});

// the reference instances are not published: skipped where they are not present
const REF = ['FILING-A', 'FILING-B'].every((g) => existsSync(new URL(`./golden-${g}_2024-25.xml`, import.meta.url)));
test('reference instances: statement places inferred, no share-capital warning, XML unchanged by v14.3', { skip: !REF && 'reference instances not present' }, () => {
  for (const [g, level, dp, sp] of [['FILING-A', 'Actual', 2, 0], ['FILING-B', 'Lakhs', 2, 2]]) {
    const xml = readFileSync(new URL(`./golden-${g}_2024-25.xml`, import.meta.url), 'utf8');
    const S = new Session(A); S.importXml(xml, { DOMParserImpl: DOMParser, yearMode: 'both' });
    assert.deepEqual([S.filing.meta.level, S.filing.meta.displayPlaces, S.filing.meta.statementPlaces], [level, dp, sp], g);
    assert.equal(scWarnings(S).length, 0, g);
    // a project saved and opened again keeps the setting
    const R = new Session(A, Filing.fromJSON(A, JSON.parse(JSON.stringify(S.filing.toJSON()))));
    assert.equal(R.filing.meta.statementPlaces, sp);
  }
});

test('an imported figure retyped with more digits becomes finer, never coarser; retyped the same it keeps its accuracy', () => {
  const S = session({ level: 'Lakhs', displayPlaces: 5, statementPlaces: 2 });
  const p = S.filing.period(q('ShareCapital'), 'CY');
  S.filing.setFact({ concept: q('ShareCapital'), period: p, value: '10000000', decimals: '-3', origin: 'import' });
  assert.equal(put(S, 'ShareCapital', '100.00000').decimals, '0');
  S.filing.setFact({ concept: q('ShareCapital'), period: p, value: '10000000', decimals: 'INF', origin: 'import' });
  assert.equal(put(S, 'ShareCapital', '100').decimals, 'INF');
});

test('generated XML carries the exact values and the accuracy typed', () => {
  const S = session({ level: 'Lakhs', displayPlaces: 5, statementPlaces: 2 });
  put(S, 'ShareCapital', '12.52365');
  put(S, 'TradeReceivables', '45.26');
  const xml = generateInstance(A, S.filing, S.app.planFacts(S.filing).emit).xml;
  assert.match(xml, /<in-gaap:ShareCapital [^>]*decimals="0"[^>]*>1252365</);
  assert.match(xml, /<in-gaap:TradeReceivables [^>]*decimals="-3"[^>]*>4526000</);
});
