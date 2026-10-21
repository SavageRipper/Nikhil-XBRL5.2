// v14.7: footnotes are written with the text editor (MCA HTML, as text blocks); an XML with errors says NOT VALIDATED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { authority, importSession } from './helpers.mjs';
import { Session } from './session.js';
import { buildExample } from './example.js';
import { addFootnote, updateFootnoteText } from './footnotes.js';
import { toMca } from './richtext.js';
import { buildPreviewHtml } from './pdf-preview.js';
import { xsdValidatorStatus, validateInstanceXml } from './xsd-validate.mjs';

const A = authority();
const today = '2025-09-30';
const RICH = toMca('<p>Secured by <b>hypothecation</b> of stock</p><ul><li>First charge on stock</li><li>Second charge on land</li></ul>', { emphasis: 'headings' });
const withFootnote = (text) => {
  const s = new Session(A); buildExample(s);
  const f = s.filing.all().find((x) => A.isNumeric(x.concept) && !x.nil && x.dims.length === 0);
  const fn = addFootnote(s.filing, text, [f.key]);
  return { s, f, fn };
};

test('a rich footnote is kept as MCA HTML and written to the XML as its text, as the MCA-validated instances have it', () => {
  assert.equal(RICH, '<p>Secured by hypothecation of stock</p><div class="noteText1"><p>•&nbsp;First charge on stock</p><p>•&nbsp;Second charge on land</p></div>');
  const { s } = withFootnote(RICH);
  const xml = s.exportXml({ today }).xml;
  assert.match(xml, /<link:footnote [^>]*xml:lang="en">&lt;p&gt;Secured by hypothecation of stock&lt;\/p&gt;&lt;div class=&quot;noteText1&quot;&gt;/);
  // read back unchanged
  const { s: r } = importSession(xml);
  assert.deepEqual([...r.filing.footnotes.values()].map((x) => x.text), [RICH]);
});

test('an empty rich footnote is refused; plain-text footnotes of older projects are unchanged', () => {
  const s = new Session(A); buildExample(s);
  const f = s.filing.all().find((x) => A.isNumeric(x.concept) && !x.nil);
  assert.throws(() => addFootnote(s.filing, '<p>&nbsp;</p><p></p>', [f.key]), /empty/);
  const fn = addFootnote(s.filing, 'Plain footnote', [f.key]);
  assert.match(s.exportXml({ today }).xml, /xml:lang="en">Plain footnote<\/link:footnote>/);
  assert.throws(() => updateFootnoteText(s.filing, fn.id ?? fn, '<p> </p>'), /empty/);
});

test('the preview prints a rich footnote formatted; a plain one as text', () => {
  const { s } = withFootnote(RICH);
  const html = buildPreviewHtml(s);
  assert.match(html, /<div class="fns"><div class="fnh">Footnotes<\/div><div>\(A\) <div class="mca fnrich"><p>Secured by hypothecation of stock<\/p><div class="noteText1">/);
  const { s: p } = withFootnote('Plain footnote');
  assert.match(buildPreviewHtml(p), /<div>\(A\) Plain footnote<\/div>/);
});

const st = xsdValidatorStatus();
test('XML Schema / XBRL 2.1 (Arelle): an instance with a rich footnote is valid', { skip: !st.available && `XSD validator not available: ${st.reason}` }, () => {
  const { s } = withFootnote(RICH);
  const r = validateInstanceXml(s.exportXml({ today }).xml, { label: 'fn.xml' });
  assert.equal(r.status, 'PASS', r.errors.slice(0, 3).map((e) => e.message).join('\n'));
});

const REF = existsSync(new URL('./golden-FILING-B_2024-25.xml', import.meta.url));
test('reference instance B: its <span> footnotes are read and written unchanged', { skip: !REF && 'reference instances not present' }, () => {
  const xml = readFileSync(new URL('./golden-FILING-B_2024-25.xml', import.meta.url), 'utf8');
  const { s } = importSession(xml);
  const notes = (x) => [...x.matchAll(/<link:footnote\b[^>]*>([^]*?)<\/link:footnote>/g)].map((m) => m[1].replace(/\r\n/g, '\n')); // (an XML parser reads CRLF as LF)
  assert.deepEqual(notes(s.exportXml({ today: '2025-10-30' }).xml), notes(xml));
});
