// v14.1: text blocks pasted from Word print tidily in the MCA PDF (richtext.js tidy / layoutReport; emphasis 'headings')
import test from 'node:test';
import assert from 'node:assert/strict';
import { toMca, fromMca, tidy, layoutReport, plainText } from './richtext.js';
import { htmlGuidelineIssues } from './gate.js';

// the shape of a Board's report / Auditor's report pasted from Word, as stored by v13.2 (Word paste, 'highlight' setting)
const STORED = '<p>    </p><p><span class="highlightedText1">BOARD\'S REPORT</span></p><p>&nbsp;</p><p>To,</p><p>&nbsp;</p>'
  + '<p class="header2"><span class="highlightedText1">1. EXTRACT OF ANNUAL RETURN</span>&nbsp;</p><p>The Company does not operate a website.</p>'
  + '<p>We have audited the statements of <span class="highlightedText1">M/s.</span> <span class="highlightedText1">EXAMPLE LIMITED</span> (the Company).</p>'
  + '<p><span class="highlightedText1">We believe that the audit evidence we have obtained is sufficient.</span></p>'
  + '<p class="header5">We have audited the internal financial controls over financial reporting of the Company as of 31st March 2026 in conjunction with our audit of the Financial Statements of the Company for the year ended on that date.</p>'
  + '<table><tbody><tr><td class="bordered"><p><span class="highlightedText1">Sr. No.</span></p></td><td class="bordered"><p>&nbsp;</p></td><td class="bordered"><p><span class="highlightedText1">Date</span></p></td></tr>'
  + '<tr><td class="bordered"><p>1.</p></td><td class="bordered"><p>&nbsp;</p></td><td class="bordered"><p>7th May 2025</p></td></tr>'
  + '<tr><td class="bordered"><p>&nbsp;</p></td><td class="bordered"><p>&nbsp;</p></td><td class="bordered"><p>&nbsp;</p></td></tr></tbody></table>'
  + '<p>&nbsp;</p><p><span class="highlightedText2">italic</span> and <span class="highlightedText3">underlined</span> words</p><p>&nbsp;</p>';

test('layoutReport: what prints untidily in the MCA PDF', () => {
  const r = layoutReport(fromMca(STORED));
  assert.equal(r.blank, 5); // leading whitespace paragraph + 4 &nbsp; paragraphs (padding inside cells is not counted)
  assert.equal(r.largeHeadings, 1); // header2
  assert.equal(r.columns, 1); // the empty middle column
  assert.equal(r.rows, 1); // the empty last row
  assert.ok(r.shaded >= 7);
});

test("tidy 'headings': short whole-bold lines and headings → header5, other emphasis plain, blanks / empty columns / rows removed, text unchanged", () => {
  const { html, stats } = tidy(fromMca(STORED), { style: 'headings' });
  const mca = toMca(html, { emphasis: 'headings' });
  assert.equal(plainText(mca).replace(/\s+/g, ' '), plainText(STORED).replace(/\s+/g, ' ').replace(/^\s+/, ''));
  assert.ok(!/highlightedText|header2/.test(mca), mca);
  assert.match(mca, /^<p class="header5">BOARD'S REPORT<\/p><p>To,<\/p><p class="header5">1\. EXTRACT OF ANNUAL RETURN&nbsp;<\/p>/);
  assert.match(mca, /<p>We have audited the statements of M\/s\. EXAMPLE LIMITED \(the Company\)\.<\/p>/); // inline bold → plain
  assert.match(mca, /<p>We believe that the audit evidence we have obtained is sufficient\.<\/p>/); // a bold sentence stays text
  assert.match(mca, /<p>We have audited the internal financial controls/); // a long heading becomes text
  assert.match(mca, /<p>italic and underlined words<\/p>$/);
  assert.match(mca, /<table><tbody><tr><td class="bordered"><p>Sr\. No\.<\/p><\/td><td class="bordered"><p>Date<\/p><\/td><\/tr><tr><td class="bordered"><p>1\.<\/p><\/td><td class="bordered"><p>7th May 2025<\/p><\/td><\/tr><\/tbody><\/table>/);
  assert.ok(!/<p>(&nbsp;|\s)*<\/p>/.test(mca.replace(/<table>.*<\/table>/, '')), 'no empty paragraphs outside tables');
  assert.deepEqual({ blank: stats.blank, columns: stats.columns, rows: stats.rows }, { blank: 5, columns: 1, rows: 1 });
  assert.equal(htmlGuidelineIssues(mca).errors?.length ?? 0, 0);
  const again = layoutReport(html);
  assert.deepEqual(again, { blank: 0, shaded: 0, largeHeadings: 0, columns: 0, rows: 0, wideTables: 0 });
  // idempotent
  assert.equal(tidy(html, { style: 'headings' }).html, html);
});

test("tidy 'keep' (MCA highlight setting): emphasis and headings kept, only blanks and empty columns / rows removed", () => {
  const { html } = tidy(fromMca(STORED), { style: 'keep' });
  const mca = toMca(html);
  assert.match(mca, /<p><span class="highlightedText1">BOARD'S REPORT<\/span><\/p><p>To,<\/p><p class="header2">/);
  assert.match(mca, /highlightedText2">italic/);
  assert.ok(!/<p>(&nbsp;|\s)*<\/p>/.test(mca.replace(/<table>.*<\/table>/, '')));
});

test("tidy 'plain': all emphasis removed, headings become text", () => {
  const mca = toMca(tidy(fromMca(STORED), { style: 'plain' }).html, { emphasis: 'none' });
  assert.ok(!/highlightedText|header\d/.test(mca), mca);
  assert.match(mca, /^<p>BOARD'S REPORT<\/p><p>To,<\/p><p>1\. EXTRACT OF ANNUAL RETURN&nbsp;<\/p>/);
});

test("emphasis 'headings' on save: marks dropped, headings kept (header5), lists / indentation unchanged", () => {
  const ed = '<h5>Opinion</h5><p><b>Bold</b> <i>it</i> <u>u</u></p><ol><li>One</li></ol><blockquote><p>In</p></blockquote>';
  assert.equal(toMca(ed, { emphasis: 'headings' }), '<p class="header5">Opinion</p><p>Bold it u</p><div class="noteText1"><p>1.&nbsp;One</p></div><div class="noteText3"><p>In</p></div>');
  // the default (no option) is unchanged: highlight classes
  assert.equal(toMca('<p><b>Bold</b></p>'), '<p><span class="highlightedText1">Bold</span></p>');
});

test('tidy keeps list items and indentation; a list item left empty is dropped', () => {
  const { html } = tidy('<ol><li><b>Point one</b></li><li>&nbsp;</li><li>Point two</li></ol><blockquote><p>&nbsp;</p><p>Kept</p></blockquote>', { style: 'headings' });
  assert.equal(html, '<ol><li>Point one</li><li>Point two</li></ol><blockquote><p>Kept</p></blockquote>');
});

test('tidy of empty or blank-only text gives empty text; a table of only empty cells keeps one cell', () => {
  assert.equal(tidy('<p>&nbsp;</p><p> </p>').html, '');
  assert.equal(tidy('').html, '');
  const t = tidy('<table><tr><td>&nbsp;</td><td>&nbsp;</td></tr><tr><td>x</td><td>&nbsp;</td></tr></table>').html;
  assert.equal(t, '<table><tbody><tr><td><p>x</p></td></tr></tbody></table>');
});
