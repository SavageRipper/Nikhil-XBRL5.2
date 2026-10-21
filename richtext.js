// Rich text for narrative (text block) facts.
//
// Two representations of the same content:
//   editor HTML  — what the browser editor shows: <p>, <br>, <b>, <i>, <u>, <ol>/<ul>/<li>, <blockquote>, <h1>-<h5>, tables
//   MCA markup   — what goes into the XBRL fact. The Filing Manual HTML guidelines allow only
//                  div, span, p, br, table, td, tr, thead, tfoot, tbody, th (col/colgroup are listed by the manual but
//                  rejected by the MCA Validator's HTML schema, as are colspan/rowspan), lower-case tags,
//                  no style attribute, no <b>/<i>, and the predefined classes (header1-5, highlightedText1-4,
//                  noteText1-4, bordered, normalText, ...). Formatting is therefore carried by those classes:
//                    bold       -> <span class="highlightedText1">
//                    italic     -> <span class="highlightedText2">
//                    underline  -> <span class="highlightedText3">
//                    numbered list -> <div class="noteText1"><p>1.&nbsp;item</p>...</div>
//                    bulleted list -> <div class="noteText1"><p>•&nbsp;item</p>...</div> (v14.4; before: noteText2, which
//                                     the MCA PDF prints as bold text in a grey box with a dotted border — noteText1
//                                     prints as normal text, slightly indented; the marker tells the two lists apart)
//                    indentation   -> <div class="noteText3">...</div>
//                    heading N     -> <p class="headerN">
//                  The list markers are real text, so the MCA PDF rendering shows the list; the classes make the
//                  conversion back to an editable list lossless. Only &nbsp; &amp; &lt; &gt; entities are emitted.
// Pure string code: identical behaviour in the browser and in Node tests.

const VOID = new Set(['br', 'col', 'img', 'hr', 'input', 'meta', 'link', 'wbr', 'area', 'base']);
const DROP = new Set(['script', 'style', 'img', 'object', 'embed', 'iframe', 'svg', 'math', 'head', 'title', 'meta', 'link', 'xml']);
const BLOCKS = new Set(['p', 'div', 'table', 'ol', 'ul', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot']);
const TABLE = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'col', 'colgroup']);
const MCA_CLASSES = new Set(['header1', 'header2', 'header3', 'header4', 'header5', 'bordered', 'unbordered', 'tableHeader', 'tableRow', 'tableRowLabel', 'tableRowValue', 'normalText', 'noteText1', 'noteText2', 'noteText3', 'noteText4', 'numericValue', 'nonNumericValue', 'highlightedText1', 'highlightedText2', 'highlightedText3', 'highlightedText4']);

// ------------------------------------------------------------------ parsing
const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" ,
  // named entities common in text pasted from Word / web pages (decoded to characters; the MCA output then only
  // uses &nbsp; &amp; &lt; &gt;)
  rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201D', ldquo: '\u201C', sbquo: '\u201A', bdquo: '\u201E', ndash: '\u2013', mdash: '\u2014',
  hellip: '\u2026', bull: '\u2022', middot: '\u00B7', copy: '\u00A9', reg: '\u00AE', trade: '\u2122', deg: '\u00B0', sect: '\u00A7',
  para: '\u00B6', times: '\u00D7', divide: '\u00F7', plusmn: '\u00B1', frac12: '\u00BD', frac14: '\u00BC', frac34: '\u00BE',
  laquo: '\u00AB', raquo: '\u00BB', euro: '\u20AC', pound: '\u00A3', yen: '\u00A5', cent: '\u00A2', rupee: '\u20B9', shy: '', zwnj: '', zwj: '' };
// characters XML 1.0 does not allow (the MCA Validator stops with "An invalid XML character … was found"):
// C0 controls other than tab/newline/carriage return, U+FFFE/U+FFFF and lone surrogates. A vertical tab / form feed
// (Word's manual line break in plain-text clipboard data) is a line break.
const XML_ILLEGAL = /[\u0000-\u0008\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export function xmlSafe(s) { return String(s).replace(/[\u000B\u000C]/g, '\n').replace(XML_ILLEGAL, ''); }
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n <= 0x10FFFF ? xmlSafe(String.fromCodePoint(n)) : m; }
    return ENT[e.toLowerCase()] ?? m;
  });
}
function attrs(src) {
  const out = {};
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(src))) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}
export function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<\/\s*([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)|</g;
  let m;
  while ((m = re.exec(html))) {
    if (m[5] != null || m[0] === '<') { top().children.push({ text: decodeEntities(m[5] ?? '<') }); continue; }
    if (m[1]) { // closing tag
      const name = m[1].toLowerCase();
      const i = stack.map((n) => n.tag).lastIndexOf(name);
      if (i > 0) stack.length = i;
      continue;
    }
    if (!m[2]) continue; // comment / doctype / PI
    const name = m[2].toLowerCase(); // namespaced Office tags (o:p, w:...) stay distinct and are treated as inline wrappers
    // implicit closes
    if (BLOCKS.has(name) && top().tag === 'p' && name !== 'td') stack.pop();
    if (name === 'li') { const i = stack.map((n) => n.tag).lastIndexOf('li'); const j = Math.max(stack.map((n) => n.tag).lastIndexOf('ol'), stack.map((n) => n.tag).lastIndexOf('ul')); if (i > j && i > 0) stack.length = i; }
    if (name === 'tr' || name === 'td' || name === 'th') { const t = name === 'tr' ? ['tr', 'td', 'th'] : ['td', 'th']; while (t.includes(top().tag) && top().tag !== 'tr' || (name === 'tr' && top().tag === 'tr')) { stack.pop(); if (name !== 'tr' && top().tag === 'tr') break; } }
    const node = { tag: name, attrs: attrs(m[3] || ''), children: [] };
    top().children.push(node);
    if (!VOID.has(name) && !m[4]) stack.push(node);
  }
  return root;
}

// ------------------------------------------------------------------ normalised content model
// block: {b:'p'|'h1'..'h5'|'ol'|'ul'|'indent'|'table', inl?:[inline], items?:[[block]], children?:[block], rows?}
// inline: {t:'text', s, m:'biu' subset} | {t:'br'}
function marksOf(node, m) {
  const cls = (node.attrs.class || '').split(/\s+/);
  const st = (node.attrs.style || '').toLowerCase();
  let out = m;
  const add = (c) => { if (!out.includes(c)) out += c; };
  if (node.tag === 'b' || node.tag === 'strong' || cls.includes('highlightedText1') || /font-weight\s*:\s*(bold|bolder|[6-9]00)/.test(st)) add('b');
  if (node.tag === 'i' || node.tag === 'em' || node.tag === 'cite' || cls.includes('highlightedText2') || /font-style\s*:\s*(italic|oblique)/.test(st)) add('i');
  if (node.tag === 'u' || node.tag === 'ins' || cls.includes('highlightedText3') || /text-decoration[^;]*underline/.test(st)) add('u');
  return [...'biu'].filter((c) => out.includes(c)).join('');
}
const MARKER = /^[\s ]*(?:\d+[.)]|[••●▪\-–o§])[\s ]+/;

function toModel(node, baseMarks = '') {
  const blocks = [];
  let inl = null;
  const flush = () => { if (inl && inl.some((x) => x.t === 'br' || x.s.trim() !== '' || / /.test(x.s))) blocks.push({ b: 'p', inl }); else if (inl && inl.length && blocks.length === 0) blocks.push({ b: 'p', inl }); inl = null; };
  const inline = (n, m) => {
    if (n.text != null) { (inl ||= []).push({ t: 'text', s: n.text.replace(/[\r\n\t]+/g, ' '), m }); return; }
    if (DROP.has(n.tag)) return;
    if (n.tag === 'br') { (inl ||= []).push({ t: 'br' }); return; }
    if (BLOCKS.has(n.tag)) { flush(); blocks.push(...block(n, m)); return; }
    const mm = marksOf(n, m);
    for (const c of n.children) inline(c, mm);
  };
  const block = (n, m) => {
    const cls = (n.attrs.class || '').split(/\s+/);
    const mm = marksOf(n, m);
    const t = n.tag;
    if (t === 'ol' || t === 'ul' || (t === 'div' && (cls.includes('noteText1') || cls.includes('noteText2')))) {
      // v14.4: a noteText1 block whose first item starts with a bullet is a bulleted list
      const firstText = () => { const p = (n.children || []).find((c) => c.tag === 'p' || c.tag === 'div'); const walkT = (x) => (x.text != null ? x.text : (x.children || []).map(walkT).join('')); return p ? walkT(p) : ''; };
      const kind = t === 'ol' ? 'ol' : t === 'ul' ? 'ul' : cls.includes('noteText2') ? 'ul' : /^[\s\u00a0]*[•●▪]/.test(firstText()) ? 'ul' : 'ol';
      const items = [];
      for (const c of n.children) {
        if (c.text != null) { if (c.text.trim() && items.length) items[items.length - 1].push(...toModel({ tag: 'p', attrs: {}, children: [c] })); continue; }
        if (c.tag === 'li') items.push(toModel(c, mm));
        else if ((c.tag === 'ol' || c.tag === 'ul' || c.tag === 'div') && items.length) items[items.length - 1].push(...block(c, mm));
        else if (c.tag === 'p' || c.tag === 'div') {
          const sub = toModel(c, mm);
          if (sub[0]?.inl) { const first = sub[0].inl.find((x) => x.t === 'text'); if (first) first.s = first.s.replace(MARKER, ''); }
          items.push(sub);
        }
      }
      return [{ b: kind, items }];
    }
    if (t === 'blockquote' || (t === 'div' && cls.includes('noteText3'))) return [{ b: 'indent', children: toModel(n, mm) }];
    if (t === 'table' || TABLE.has(t)) {
      if (t === 'col' || t === 'colgroup') return [];
      const tm = tableModel(t === 'table' ? n : { tag: 'table', attrs: {}, children: [n] }, mm, OPTS);
      return [...tm.before, { b: 'table', html: tm }];
    }
    const h = /^h([1-6])$/.exec(t) || (t === 'p' && cls.map((c) => /^header([1-5])$/.exec(c)).find(Boolean));
    if (t === 'li') return toModel(n, m);
    const sub = toModel(n, m);
    if (!sub.length || sub[0].b !== 'p') sub.unshift({ b: 'p', inl: [] });
    if (h) sub[0] = { b: 'h' + Math.min(5, Number(h[1])), inl: sub[0].inl };
    return sub;
  };
  const kids = node.children || [];
  for (const c of kids) inline(c, node.tag === '#root' ? baseMarks : marksOf(node, baseMarks));
  flush();
  return blocks;
}
// Tables are normalised to what the MCA HTML schema accepts (MCA Validator, Xerces, namespace
// http://www.mca.gov.in/XBRL/HTML): <table> holds only thead/tbody/tfoot/tr, cells carry only the class attribute.
// Word/Excel tables are rebuilt on a grid:
//   col / colgroup / caption     -> dropped (caption text becomes a paragraph above the table)
//   colspan / rowspan            -> the cell keeps its content; the covered positions become empty cells with the same
//                                   class, so every row has the same number of cells and borders stay continuous
//   loose <tr>                   -> wrapped in <tbody> (the structure of MCA-validated instances)
//   cell padding                 -> whitespace-only paragraphs removed; leading spaces before a number (Word/Excel
//                                   right-alignment padding, which widens columns until the MCA PDF truncates the
//                                   table) and trailing spaces removed. Indentation before text is kept.
const WS_ONLY = /^[\s\u00a0]*$/;
const NUMBER_LIKE = /^[(\-\u2013\u2014\u2212]?[\s\u00a0]*[\d.,]*\d[\d.,]*[\s\u00a0]*\)?%?$|^[-\u2013\u2014]$/;
const MAX_SPAN = 100;
const span = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 1 ? Math.min(n, MAX_SPAN) : 1; };
const paraText = (bl) => (bl.inl || []).map((x) => (x.t === 'text' ? x.s : '')).join('');
const isPara = (bl) => bl.b === 'p' || /^h\d$/.test(bl.b);
const EMPTY_CELL = () => [{ b: 'p', inl: [{ t: 'text', s: '\u00a0', m: '' }] }];
function cleanCell(blocks) {
  const kept = blocks.filter((bl) => !(isPara(bl) && WS_ONLY.test(paraText(bl))));
  if (!kept.length) return EMPTY_CELL();
  for (const bl of kept) {
    if (!isPara(bl)) continue;
    const runs = bl.inl.filter((x) => x.t === 'text');
    if (!runs.length) continue;
    if (NUMBER_LIKE.test(paraText(bl).replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, ''))) {
      for (const x of runs) { const t = x.s.replace(/^[\s\u00a0]+/, ''); x.s = t; if (t) break; }
    }
    for (const x of [...runs].reverse()) { const t = x.s.replace(/[\s\u00a0]+$/, ''); x.s = t; if (t) break; }
    bl.inl = bl.inl.filter((x) => x.t !== 'text' || x.s !== '');
  }
  return kept;
}
const cellClasses = (c) => (c.attrs.class || '').split(/\s+/).filter((x) => MCA_CLASSES.has(x));
function tableModel(n, m, opts = {}) {
  const sections = [];
  const before = [];
  let loose = null;
  const visit = (c) => {
    if (!c.tag) return;
    if (c.tag === 'thead' || c.tag === 'tbody' || c.tag === 'tfoot') { loose = null; sections.push({ tag: c.tag, rows: (c.children || []).filter((k) => k.tag === 'tr') }); }
    else if (c.tag === 'tr') { if (!loose) sections.push(loose = { tag: 'tbody', rows: [] }); loose.rows.push(c); }
    else if (c.tag === 'caption') before.push(...toModel(c, m));
    else if (c.tag === 'td' || c.tag === 'th') { if (!loose) sections.push(loose = { tag: 'tbody', rows: [] }); loose.rows.push({ tag: 'tr', attrs: {}, children: [c] }); }
    // col / colgroup and anything else: not part of the MCA HTML schema
  };
  (n.children || []).forEach(visit);
  const out = [];
  for (const sec of sections) {
    const rows = [];
    const carry = []; // carry[col] = {left, cls, tag} for rowspan
    for (const tr of sec.rows) {
      const row = [];
      const fill = () => { while (carry[row.length]?.left > 0) { const k = carry[row.length]; k.left--; row.push({ tag: k.tag, cls: k.cls, blocks: EMPTY_CELL() }); } };
      for (const c of (tr.children || []).filter((k) => k.tag === 'td' || k.tag === 'th')) {
        fill();
        const cls = cellClasses(c);
        if (opts.borders && !cls.includes('bordered') && !cls.includes('unbordered')) cls.unshift('bordered');
        const cs = span(c.attrs.colspan), rs = span(c.attrs.rowspan);
        for (let k = 0; k < cs; k++) {
          if (rs > 1) carry[row.length] = { left: rs - 1, cls: cls.join(' '), tag: c.tag };
          row.push({ tag: c.tag, cls: cls.join(' '), blocks: k ? EMPTY_CELL() : cleanCell(toModel(c, m)), ...(k ? { spanned: true } : cs > 1 ? { span: cs } : {}) });
        }
      }
      while (row.length < carry.length) { const k = carry[row.length]; if (k?.left > 0) { k.left--; row.push({ tag: k.tag, cls: k.cls, blocks: EMPTY_CELL() }); } else row.push(null); }
      rows.push(row);
    }
    if (rows.length) out.push({ tag: sec.tag, rows });
  }
  placeMergedCells(out);
  // rectangular grid: missing cells (ragged rows) become empty cells with the row's class
  const width = Math.max(0, ...out.flatMap((s) => s.rows.map((r) => r.length)));
  for (const s of out) for (const r of s.rows) {
    const ref = r.find(Boolean) || { tag: 'td', cls: opts.borders ? 'bordered' : '' };
    for (let i = 0; i < width; i++) if (!r[i]) r[i] = { tag: ref.tag === 'th' ? 'th' : 'td', cls: ref.cls, blocks: EMPTY_CELL() };
  }
  return { before, sections: out };
}

// v14.4: a merged cell (colspan) has no MCA equivalent; its text goes into the column of the span that carries the
// table's text (most text in unmerged cells), not always the first one. The MCA PDF does not shrink a table to the page:
// with an audit-report annexure pasted from Word ("(i) | (a) | (A) | text", the clause rows merged across the label
// columns), the text landed in three different columns, every column became wide, and the table was cut off at the right
// edge of the page. A span over columns of similar text (a header over two amount columns) keeps its first column.
const cellTextLen = (c) => (c?.blocks || []).reduce((n, bl) => n + (isPara(bl) ? paraText(bl).replace(/[\s\u00a0]+/g, ' ').trim().length : bl.b === 'table' ? 0 : JSON.stringify(bl).length / 4), 0);
function placeMergedCells(sections) {
  const weight = [];
  for (const s of sections) for (const r of s.rows) r.forEach((c, j) => { if (c && !c.span && !c.spanned) weight[j] = (weight[j] || 0) + cellTextLen(c); });
  for (const s of sections) for (const r of s.rows) {
    for (let j = 0; j < r.length; j++) {
      const c = r[j];
      if (!c?.span) continue;
      let best = j;
      for (let k = j + 1; k < j + c.span && k < r.length; k++) if ((weight[k] || 0) > (weight[best] || 0)) best = k;
      if (best !== j && (weight[best] || 0) > 2 * (weight[j] || 0) + 20) { const t = r[best].blocks; r[best].blocks = c.blocks; c.blocks = t; }
    }
    for (const c of r) if (c) { delete c.span; delete c.spanned; }
  }
}

// ------------------------------------------------------------------ serialisers
const escText = (s, nbsp) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, nbsp);
function inlineHtml(inl, mode) {
  let out = '';
  for (const x of inl || []) {
    if (x.t === 'br') { out += mode === 'mca' ? '<br/>' : '<br>'; continue; }
    let s = escText(x.s, '&nbsp;');
    if (!s) continue;
    const marks = WS_ONLY.test(x.s) ? '' : mode === 'mca' ? [...x.m].filter(() => OPTS.emphasis !== 'none' && OPTS.emphasis !== 'headings').join('') : x.m;
    for (const k of [...marks].reverse()) s = mode === 'mca' ? `<span class="highlightedText${'biu'.indexOf(k) + 1}">${s}</span>` : `<${k}>${s}</${k}>`;
    out += s;
  }
  // merge adjacent identical mark wrappers produced by run splitting
  return mode === 'mca' ? out.replace(/<\/span><span class="(highlightedText\d)">/g, (m, c) => m) : out.replace(/<\/(b|i|u)><\1>/g, '');
}
function tableHtml(t, mode) {
  if (!t || !t.sections.length) return '';
  const cell = (c) => `<${c.tag}${c.cls ? ` class="${c.cls}"` : ''}>${blocksHtml(c.blocks, mode)}</${c.tag}>`;
  return `<table>${t.sections.map((s) => `<${s.tag}>${s.rows.map((r) => `<tr>${r.map(cell).join('')}</tr>`).join('')}</${s.tag}>`).join('')}</table>`;
}
function blocksHtml(blocks, mode) {
  let out = '';
  for (const bl of blocks) {
    if (bl.b === 'p') out += `<p>${inlineHtml(bl.inl, mode)}</p>`;
    else if (/^h\d$/.test(bl.b)) out += mode === 'mca' ? `<p class="header${bl.b[1]}">${inlineHtml(bl.inl, mode)}</p>` : `<${bl.b}>${inlineHtml(bl.inl, mode)}</${bl.b}>`;
    else if (bl.b === 'indent') out += mode === 'mca' ? `<div class="noteText3">${blocksHtml(bl.children, mode)}</div>` : `<blockquote>${blocksHtml(bl.children, mode)}</blockquote>`;
    else if (bl.b === 'table') out += tableHtml(bl.html, mode);
    else if (bl.b === 'ol' || bl.b === 'ul') {
      if (mode === 'mca') {
        out += '<div class="noteText1">'; // v14.4: both lists (noteText2 prints shaded in the MCA PDF)
        bl.items.forEach((item, i) => {
          const marker = bl.b === 'ol' ? `${i + 1}.&nbsp;` : '•&nbsp;';
          const [first, ...rest] = item;
          if (first && first.b === 'p') out += `<p>${marker}${inlineHtml(first.inl, mode)}</p>${blocksHtml(rest, mode)}`;
          else out += `<p>${marker}</p>${blocksHtml(item, mode)}`;
        });
        out += '</div>';
      } else {
        out += `<${bl.b}>${bl.items.map((item) => {
          const [first, ...rest] = item;
          return `<li>${first && first.b === 'p' ? inlineHtml(first.inl, mode) + blocksHtml(rest, mode) : blocksHtml(item, mode)}</li>`;
        }).join('')}</${bl.b}>`;
      }
    }
  }
  return out;
}

const looksHtml = (s) => /<\s*[a-zA-Z][^>]*>/.test(s);
function model(str) {
  str = xmlSafe(str ?? '');
  if (!looksHtml(str)) {
    if (String(str).trim() === '') return [];
    const paras = String(str).split(/\r?\n\s*\r?\n/);
    return paras.map((p) => ({ b: 'p', inl: p.split(/\r?\n/).flatMap((line, i) => (i ? [{ t: 'br' }] : []).concat(line ? [{ t: 'text', s: decodeEntities(line), m: '' }] : [])) }));
  }
  return toModel(parseHtml(str));
}

/** editor HTML (or pasted HTML from any source) -> MCA-compliant markup for the XBRL fact */
// options: { borders: true } — pasted tables without an MCA border class get class="bordered" on every cell;
//          { emphasis: 'none' | 'headings' } — bold/italic/underline are not converted to highlightedText classes
//          (saved as plain text; headings stay headings)
let OPTS = {};
export function toMca(html, opts = {}) { OPTS = opts; try { return blocksHtml(model(html ?? ''), 'mca'); } finally { OPTS = {}; } }
/** MCA markup (or plain text) from a fact -> editor HTML */
export function fromMca(value) { OPTS = {}; return blocksHtml(model(value ?? ''), 'editor'); }
/** visible text, for comparisons */
export function plainText(html) {
  // a block element starts and ends a line ("31<div>st</div> March" renders on three lines)
  const walk = (n) => {
    if (n.text != null) return n.text;
    if (n.tag === 'br') return '\n';
    const nl = BLOCKS.has(n.tag) && n.tag !== 'td' && n.tag !== 'th' ? '\n' : '';
    return nl + (n.children || []).map(walk).join('') + nl;
  };
  return walk(parseHtml(html)).replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}
/** formatting summary (for regression tests): counts of b/i/u runs, list items, indents, headings */
export function formatting(html) {
  const s = { b: 0, i: 0, u: 0, ol: 0, ul: 0, li: 0, indent: 0, h: 0, br: 0, p: 0, table: 0 };
  const walkB = (blocks) => { for (const bl of blocks) {
    if (bl.b === 'p') s.p++;
    if (/^h\d$/.test(bl.b)) s.h++;
    if (bl.b === 'indent') { s.indent++; walkB(bl.children); }
    if (bl.b === 'table') s.table++;
    if (bl.b === 'ol' || bl.b === 'ul') { s[bl.b]++; s.li += bl.items.length; bl.items.forEach(walkB); }
    for (const x of bl.inl || []) { if (x.t === 'br') s.br++; else for (const k of x.m) s[k]++; }
  } };
  walkB(model(html));
  return s;
}

// ------------------------------------------------------------------ tidy for the MCA PDF (v14.1)
// How the MCA XBRL Validator's PDF prints a text block (measured on an MCA-generated PDF): paragraphs in Times 9pt with
// about two lines of space between paragraphs, so an empty paragraph (a blank line copied from Word) adds a gap of
// three lines; highlightedText1 as white Helvetica on a dark grey box; header2 as Helvetica bold 18pt, header5 as
// Helvetica bold 12pt without shading; table cells in Helvetica. Text copied from Word therefore prints untidily:
// every bold run becomes a grey box, Word headings become very large, blank lines become large gaps.
// tidy() rewrites editor HTML into what prints cleanly:
//   - empty paragraphs (only spaces / &nbsp; / line breaks) are removed
//   - table columns that are empty in every row, and rows that are empty in every cell, are removed (Word layout
//     tables) — the table keeps at least one column
//   - { style: 'headings' }: a short line that is bold or underlined as a whole, and every heading, becomes one
//     heading style (<h5> → <p class="header5">: bold, no shading); a heading that reads as a sentence (longer than
//     HEADING_MAX characters, or ending with . or ;) becomes a normal paragraph; all other bold / italic / underline is
//     removed (it can only print as shading). Inside tables and list items, emphasis is removed and no headings are made.
//   - { style: 'plain' }: all emphasis removed and headings become normal paragraphs (plain text throughout)
//   - { style: 'keep' }: emphasis and headings are kept (only empty paragraphs, columns and rows are removed)
// Text is never removed — only empty paragraphs, empty cells' columns/rows and emphasis. Returns { html, stats }.
const HEADING_MAX = 200;
const lineText = (inl) => (inl || []).map((x) => (x.t === 'text' ? x.s : ' ')).join('').replace(/[\s ]+/g, ' ').trim();
const emphasised = (inl) => (inl || []).filter((x) => x.t === 'text' && x.m && !WS_ONLY.test(x.s)).length;
const plainRuns = (inl) => (inl || []).map((x) => (x.t === 'text' && x.m ? { ...x, m: '' } : x));
const blankPara = (bl) => isPara(bl) && WS_ONLY.test(paraText(bl));
function wholeLine(inl, mark) { const runs = (inl || []).filter((x) => x.t === 'text' && !WS_ONLY.test(x.s)); return runs.length > 0 && runs.every((x) => x.m.includes(mark)); }
const headingLike = (t) => t.length > 0 && t.length <= HEADING_MAX && !/[.;]$/.test(t);
function tidyBlocks(blocks, o, st) {
  const out = [];
  for (const bl of blocks || []) {
    if (blankPara(bl)) { st.blank++; continue; }
    if (isPara(bl)) {
      if (o.style === 'keep') { out.push(bl); continue; }
      const isH = bl.b !== 'p';
      // v14.4: Tidy keeps every heading at the level chosen in the editor (Paragraph style)
      if (isH && o.keepLevels && o.style !== 'plain') { out.push({ b: bl.b, inl: plainRuns(bl.inl) }); continue; }
      const t = lineText(bl.inl);
      const n = emphasised(bl.inl);
      if (o.style === 'headings' && !o.inTable && (isH || wholeLine(bl.inl, 'b') || wholeLine(bl.inl, 'u')) && headingLike(t)) {
        out.push({ b: 'h5', inl: plainRuns(bl.inl) });
        if (bl.b !== 'h5') st.headings++;
      } else {
        out.push({ b: 'p', inl: plainRuns(bl.inl) });
        if (isH) st.headingsToText++;
        st.emphasis += n;
      }
      continue;
    }
    if (bl.b === 'indent') { const ch = tidyBlocks(bl.children, o, st); if (ch.length) out.push({ ...bl, children: ch }); continue; }
    if (bl.b === 'ol' || bl.b === 'ul') {
      const items = bl.items.map((it) => tidyBlocks(it, { ...o, inTable: true }, st)).filter((it) => it.length); // no headings in list items
      if (items.length) out.push({ ...bl, items });
      continue;
    }
    if (bl.b === 'table') { const t = tidyTable(bl.html, o, st); if (t) out.push({ b: 'table', html: t }); continue; }
    out.push(bl);
  }
  return out;
}
// v14.4 (Tidy button): a table whose merged cells were already flattened (text left in the first column of the old
// span, the rest of the row empty) gets its long texts back into one column — the rightmost column that holds long
// text — so that the MCA PDF does not cut the table off at the right edge. Only a long text (LONG_TEXT characters or
// more) followed by empty cells only, and only into an empty cell, is moved; text is never removed.
const LONG_TEXT = 40;
function alignLongText(sections, empty) {
  let target = -1;
  for (const s of sections) for (const r of s.rows) r.forEach((c, j) => { if (cellTextLen(c) >= LONG_TEXT && j > target) target = j; });
  if (target < 1) return 0;
  let moved = 0;
  for (const s of sections) for (const r of s.rows) {
    if (r.length <= target || !empty(r[target])) continue;
    let last = -1;
    r.forEach((c, j) => { if (!empty(c)) last = j; });
    if (last < 0 || last >= target || cellTextLen(r[last]) < LONG_TEXT) continue;
    const t = r[target].blocks; r[target].blocks = r[last].blocks; r[last].blocks = t; moved++;
  }
  return moved;
}
function tidyTable(t, o, st) {
  if (!t) return null;
  const cellOpts = { ...o, inTable: true };
  const empty = (c) => !c || c.blocks.every(blankPara);
  const sections = t.sections.map((s) => ({ ...s, rows: s.rows.map((r) => r.map((c) => {
    if (!c) return c;
    const before = st.blank;
    const blocks = tidyBlocks(c.blocks, cellOpts, st);
    st.blank = before; // blank paragraphs inside cells are padding, not counted
    return { ...c, blocks: blocks.length ? blocks : EMPTY_CELL() };
  })) }));
  if (o.wideTables) st.moved += alignLongText(sections, empty);
  const width = Math.max(0, ...sections.flatMap((s) => s.rows.map((r) => r.length)));
  const keepCol = [];
  for (let j = 0; j < width; j++) keepCol[j] = sections.some((s) => s.rows.some((r) => !empty(r[j])));
  if (!keepCol.some(Boolean) && width) keepCol[0] = true;
  const dropped = keepCol.filter((k) => !k).length;
  st.columns += dropped;
  const out = [];
  for (const s of sections) {
    const rows = [];
    for (const r of s.rows) {
      if (r.every(empty)) { st.rows++; continue; }
      rows.push(r.filter((_, j) => keepCol[j] !== false));
    }
    if (rows.length) out.push({ ...s, rows });
  }
  return out.length || t.before.length ? { before: t.before, sections: out } : null;
}
export function tidy(html, { style = 'headings', keepLevels = false, wideTables = false } = {}) {
  const st = { blank: 0, columns: 0, rows: 0, headings: 0, headingsToText: 0, emphasis: 0, moved: 0 };
  const blocks = tidyBlocks(model(html ?? ''), { style, keepLevels, wideTables }, st);
  return { html: blocksHtml(blocks, 'editor'), stats: st };
}
/** what would print untidily in the MCA PDF (for the editor's status line): empty paragraphs, shaded runs
 *  (emphasis printed as highlightedText when the filing setting is "highlight"), large headings (header1-4),
 *  empty table columns / rows */
export function layoutReport(html) {
  const r = { blank: 0, shaded: 0, largeHeadings: 0, columns: 0, rows: 0, wideTables: 0 };
  const walk = (blocks, inTable) => { for (const bl of blocks || []) {
    if (blankPara(bl)) { if (!inTable) r.blank++; continue; }
    if (isPara(bl)) { r.shaded += emphasised(bl.inl); if (/^h[1-4]$/.test(bl.b)) r.largeHeadings++; continue; }
    if (bl.b === 'indent') walk(bl.children, inTable);
    else if (bl.b === 'ol' || bl.b === 'ul') bl.items.forEach((it) => walk(it, inTable));
    else if (bl.b === 'table' && bl.html) {
      for (const s of bl.html.sections) for (const row of s.rows) for (const c of row) if (c) walk(c.blocks, true);
      // v14.4: long text in three or more columns — the MCA PDF does not always shrink such a table to the page and may cut
      // it off at the right edge (an audit-report annexure pasted from Word with merged cells); two such columns print well
      const cols = new Set();
      for (const s of bl.html.sections) for (const row of s.rows) row.forEach((c, j) => { if (cellTextLen(c) >= LONG_TEXT) cols.add(j); });
      if (cols.size > 2) r.wideTables++;
    }
  } };
  const blocks = model(html ?? '');
  walk(blocks, false);
  const st = { blank: 0, columns: 0, rows: 0, headings: 0, headingsToText: 0, emphasis: 0, moved: 0 };
  tidyBlocks(blocks, { style: 'keep' }, st);
  r.columns = st.columns; r.rows = st.rows;
  return r;
}
export { MCA_CLASSES };
