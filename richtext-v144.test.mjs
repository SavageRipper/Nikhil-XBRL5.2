// v14.4 (ported from the Ind AS tool v1.5.3): text blocks in the MCA PDF — lists (noteText1, not the grey noteText2), merged table cells, heading levels.
// Synthetic data only (no golden files needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { authority, q } from './helpers.mjs';
import { baseSession } from './fixtures.mjs';
import { toMca, fromMca, tidy, layoutReport } from './richtext.js';
import { healthCheck } from './upkeep.js';

const A = authority();

test('lists: bulleted and numbered lists are written as noteText1 (the MCA PDF prints noteText2 in a grey box); read back as lists', () => {
  const mca = toMca('<ul><li>Alpha</li><li>Beta</li></ul><ol><li>One</li><li>Two</li></ol>');
  assert.equal(mca, '<div class="noteText1"><p>•&nbsp;Alpha</p><p>•&nbsp;Beta</p></div><div class="noteText1"><p>1.&nbsp;One</p><p>2.&nbsp;Two</p></div>');
  assert.equal(fromMca(mca), '<ul><li>Alpha</li><li>Beta</li></ul><ol><li>One</li><li>Two</li></ol>');
  // what v14.3 and earlier wrote is still read as a bulleted list
  assert.equal(fromMca('<div class="noteText2"><p>•&nbsp;Alpha</p></div>'), '<ul><li>Alpha</li></ul>');
});

test('lists: the health check moves bulleted lists of existing text blocks off the shaded style (class only)', () => {
  const s = baseSession();
  const c = q('DisclosureInBoardOfDirectorsReportExplanatoryTextBlock');
  const v = '<p>Changes:</p><div class="noteText2"><p>•&nbsp;A director ceased.</p></div>';
  s.filing.setFact({ concept: c, period: s.filing.period(c, 'CY'), value: v, origin: 'import', lang: 'en' });
  const h = healthCheck(s);
  assert.equal(h.lists.length, 1);
  assert.equal(s.getValue(c, 'CY').value, v.replace('noteText2', 'noteText1'));
  assert.equal(healthCheck(s).lists.length, 0, 'once');
});

const LONG1 = 'The Company has maintained proper records showing full particulars including quantitative details.';
const LONG2 = 'The Company has a regular programme of physical verification of its property, plant and equipment.';
const INTRO = 'In terms of the information and explanations sought by us and given by the Company, we state that:';
test('tables: the text of a merged cell (colspan) goes into the column that carries the table\'s text', () => {
  const word = `<table><tr><td colspan="4">${INTRO}</td></tr><tr><td>(i)</td><td>(a)</td><td>(A)</td><td>${LONG1}</td></tr>`
    + `<tr><td></td><td>(b)</td><td colspan="2">${LONG2}</td></tr></table>`;
  const mca = toMca(word, { borders: true });
  const rows = [...mca.matchAll(/<tr>(.*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((c) => c[1]));
  assert.ok(rows.every((r) => r.length === 4));
  assert.deepEqual(rows.map((r) => r.findIndex((c) => c.length > 40)), [3, 3, 3], 'all long texts in the last column');
  assert.equal(layoutReport(fromMca(mca)).wideTables, 0);
  // a heading over two amount columns stays over the first of them
  const amounts = toMca('<table><tr><td>Particulars</td><td colspan="2">As at 31 March</td></tr><tr><td>Cash</td><td>1,234</td><td>1,111</td></tr></table>');
  assert.match(amounts, /<tr><td><p>Particulars<\/p><\/td><td><p>As at 31 March<\/p><\/td><td><p>&nbsp;<\/p><\/td><\/tr>/);
});

test('tables: Tidy lines up long texts of a table whose merged cells were already flattened; paste-time tidy does not', () => {
  const flat = '<table><tbody>'
    + `<tr><td class="bordered">${INTRO}</td><td class="bordered">&nbsp;</td><td class="bordered">&nbsp;</td><td class="bordered">&nbsp;</td><td class="bordered">&nbsp;</td></tr>`
    + `<tr><td class="bordered">(i)</td><td class="bordered">(a)</td><td class="bordered">(A)</td><td class="bordered">&nbsp;</td><td class="bordered">${LONG1}</td></tr>`
    + `<tr><td class="bordered">&nbsp;</td><td class="bordered">(b)</td><td class="bordered">${LONG2}</td><td class="bordered">&nbsp;</td><td class="bordered">&nbsp;</td></tr>`
    + '</tbody></table>';
  const ed = fromMca(flat);
  assert.equal(layoutReport(ed).wideTables, 1, 'long text in three columns');
  assert.equal(tidy(ed, { style: 'headings' }).stats.moved, 0, 'paste-time tidy leaves the table');
  const { html, stats } = tidy(ed, { style: 'headings', keepLevels: true, wideTables: true });
  assert.equal(stats.moved, 2);
  assert.equal(stats.columns, 1, 'the column left empty is removed');
  assert.equal(layoutReport(html).wideTables, 0);
  const text = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|\s+/g, ' ').split(' ').filter(Boolean).sort().join(' ');
  assert.equal(text(toMca(html)), text(flat), 'no text lost');
});

test('headings: Tidy keeps a heading level chosen in the editor; pasted headings still become Heading 5', () => {
  const ed = '<h2>Directors</h2><h3>Appointments</h3><p><b>Short bold line</b></p><p>Text.</p>';
  assert.equal(toMca(tidy(ed, { style: 'headings', keepLevels: true }).html), '<p class="header2">Directors</p><p class="header3">Appointments</p><p class="header5">Short bold line</p><p>Text.</p>');
  assert.equal(toMca(tidy(ed, { style: 'headings' }).html), '<p class="header5">Directors</p><p class="header5">Appointments</p><p class="header5">Short bold line</p><p>Text.</p>');
  for (const n of [1, 2, 3, 4, 5]) assert.equal(fromMca(toMca(`<h${n}>T</h${n}>`)), `<h${n}>T</h${n}>`, `Heading ${n} round trip`);
});
