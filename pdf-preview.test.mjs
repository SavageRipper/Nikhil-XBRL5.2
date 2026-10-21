// Printable preview (pdf-preview.js) — display only; compared with the MCA validator's PDF of FILING-B.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DOMParser } from '@xmldom/xmldom';
import { authority, q } from './helpers.mjs';
import { baseSession } from './fixtures.mjs';
import { Session } from './session.js';
import { buildPreviewHtml, groupIN, formatValue } from './pdf-preview.js';
import { plainText } from './richtext.js';

globalThis.DOMParser ||= DOMParser;
const A = authority();
const load = () => { const S = new Session(A); S.importXml(readFileSync(new URL('golden-FILING-B_2024-25.xml', import.meta.url), 'utf8'), { yearMode: 'both' }); return S; };
const pdfText = () => { try { return execFileSync('pdftotext', ['-layout', 'golden-FILING-B_2024-25.pdf', '-'], { encoding: 'utf8', maxBuffer: 64e6 }); } catch { return null; } };

test('number formats as in the MCA PDF: Indian grouping, [shares], percentages, Yes/No, dd/mm/yyyy', () => {
  assert.equal(groupIN('1000000'), '10,00,000');
  assert.equal(groupIN('-15289.49'), '-15,289.49');
  assert.equal(groupIN('703.64'), '703.64');
  const S = load();
  const f = (l, dims = []) => S.getValue(q(l), 'CY', dims);
  assert.equal(formatValue(S, f('ReservesAndSurplus')), '3,735.31');
  assert.equal(formatValue(S, f('DateOfEndOfReportingPeriod')), '31/03/2025');
});

test('FILING-B: the same statements/notes as the MCA PDF, and every balance-sheet value of the MCA PDF appears', () => {
  const S = load();
  const html = buildPreviewHtml(S, { build: 'test' });
  assert.match(html, /not the MCA rendering/);
  const company = S.getValue(S.A.qnameOfLocal('NameOfCompany'), 'CY')?.value || '';
  assert.ok(company && html.includes(company.replace(/&/g, '&amp;')), 'company name in the preview');
  assert.match(html, /Standalone Financial Statements for period 01\/04\/2024 to 31\/03\/2025/);
  assert.ok(!/\[100300\]/.test(html), 'cash flow (direct) is not part of this filing');
  const text = existsSync('golden-FILING-B_2024-25.pdf') ? pdfText() : null;
  if (!text) return;
  const codes = (s, re) => [...new Set([...s.matchAll(re)].map((m) => m[1]))].sort();
  assert.deepEqual(codes(html, /<h2>\[([0-9]{6}[a-z]?)\]/g), codes(text, /^ +\[([0-9]{6}[a-z]?)\] /gm));
  const bs = text.split('[100100] Balance sheet')[1].split('[400300]')[0];
  let n = 0;
  for (const m of bs.matchAll(/ {2,}(-?[\d,]+(?:\.\d+)?) {2,}(-?[\d,]+(?:\.\d+)?)\s*$/gm)) { assert.ok(html.includes(`>${m[1]}<`) && html.includes(`>${m[2]}<`), m[0]); n++; }
  assert.ok(n >= 30, `${n} balance-sheet lines compared`);
});

test('text blocks are rendered from the MCA-subset markup only (no scripts or styles from the source)', () => {
  const s = baseSession();
  s.setValue(q('DisclosureInBoardOfDirectorsReportExplanatoryTextBlock'), 'CY', '<p>Hello</p><script>alert(1)</script><p style="color:red" onclick="x()">World</p><table><tr><td class="bordered">1</td></tr></table>');
  const html = buildPreviewHtml(s);
  const i = html.indexOf('<div class="til">Disclosure in board of directors report explanatory [Text Block]</div>');
  assert.ok(i > 0, 'text block shown as Textual information');
  const block = html.slice(i, html.indexOf('</div></div>', i));
  assert.ok(!/<script|onclick=|style=/.test(block), block);
  assert.match(block, /<p>Hello<\/p>/);
  assert.match(block, /<td class="bordered"><p>1<\/p><\/td>/);
});

test('footnotes as in the MCA PDF: "(A) value" in the cell and a Footnotes list after the block (FILING-B)', () => {
  const S = load();
  const html = buildPreviewHtml(S);
  // as in the MCA PDF of the reference instance: "(A) value" in the cells, then "(A) text", "(B) text" after the block
  assert.match(html, />\(A\) -?[\d,.]+</);
  assert.match(html, />\(B\) -?[\d,.]+</);
  assert.match(html, /<div class="fnh">Footnotes<\/div><div>\(A\) [^<]+<\/div><div>\(B\) [^<]+<\/div>/);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fns = [...S.filing.footnotes.values()].filter((fn) => fn.text?.trim());
  assert.ok(fns.length >= 3);
  for (const fn of fns) {
    const t = esc(/<\s*[a-zA-Z]/.test(fn.text) ? plainText(fn.text) : String(fn.text).trim()).replace(/\r?\n/g, '<br>');
    assert.ok(html.includes(`) ${t}</div>`), `footnote listed: ${t.slice(0, 40)}`);
  }
});
