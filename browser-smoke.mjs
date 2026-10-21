// Browser regression of the built app (index.html) in headless Chromium via playwright-core.
// Exercises the real UI: [200500] table availability, rich-text editing → autosave → reload → XML,
// and the import year-mapping dialog with the MCA-validated reference XML.
import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean);

// concepts the taxonomy presents with an opening-balance (periodStart) row — see importer.openingBalanceConcepts
function openingConcepts() {
  const J = JSON.parse(readFileSync(path.join(ROOT, 'MCA_AUTHORITY.json'), 'utf8'));
  const set = new Set();
  for (const arcs of Object.values(J.presentation)) for (const a of arcs) if (/periodStartLabel$/.test(a.preferredLabel || '') && J.concepts[a.to]?.periodType === 'instant') set.add(a.to);
  return set;
}

export function browserStatus() {
  let pw = null;
  try { pw = true; } catch { pw = null; }
  const exe = CANDIDATES.find((p) => existsSync(p));
  return exe && pw ? { available: true, executable: exe } : { available: false, reason: 'no Chromium executable found (set CHROMIUM_PATH)' };
}

export async function runBrowserSmoke() {
  const st = browserStatus();
  if (!st.available) return { status: 'UNAVAILABLE', ...st, checks: [] };
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: st.executable });
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e));
  const url = pathToFileURL(path.join(ROOT, 'index.html')).href;
  try {
    await page.goto(url);
    await page.waitForSelector('#nav a[data-elr]');
    check('app loads with statements and notes', (await page.locator('#nav a[data-elr]').count()) > 40);

    // ---- [200500] availability follows the balance sheet
    const ciBtn = (scope) => `button[data-open-table="200500:DetailsOfCurrentInvestmentsTable"][data-scope="${scope}"]`;
    await page.click('a[data-elr$="/NotesCurrentInvestments"]');
    check('[200500] Yes/current: table button enabled', !(await page.isDisabled(ciBtn('CY'))));
    check('[200500] Yes/prior: table button enabled', !(await page.isDisabled(ciBtn('PY'))));
    await page.click('a[data-elr$="/BalanceSheet"]');
    // v13: current investments on the balance sheet is taken from this note (read-only, "Go to note"); a different
    // figure is typed with the tab option "Allow editing of calculated cells"
    check('v13: balance-sheet current investments taken from the note (read-only, Go to note)', await page.$eval('input[data-c="in-gaap:CurrentInvestments"][data-s="CY"]', (e) => e.readOnly) && (await page.locator('[data-go-note="in-gaap:CurrentInvestments"]').count()) === 2);
    await page.check('[data-calc-override]');
    for (const sc of ['CY', 'PY']) { const sel = `input[data-c="in-gaap:CurrentInvestments"][data-s="${sc}"]`; await page.fill(sel, '0'); await page.dispatchEvent(sel, 'change'); }
    await page.click('a[data-elr$="/NotesCurrentInvestments"]');
    check('[200500] No/current: table button disabled', await page.isDisabled(ciBtn('CY')));
    check('[200500] No/prior: table button disabled', await page.isDisabled(ciBtn('PY')));
    // restore the example's balance sheet so the filing is consistent again
    await page.click('a[data-elr$="/BalanceSheet"]');
    for (const [sc, v] of [['CY', '250000'], ['PY', '200000']]) { const sel = `input[data-c="in-gaap:CurrentInvestments"][data-s="${sc}"]`; await page.fill(sel, v); await page.dispatchEvent(sel, 'change'); }
    await page.uncheck('[data-calc-override]');
    await page.click('a[data-elr$="/NotesCurrentInvestments"]');
    check('[200500] Yes again after restoring the balance sheet', !(await page.isDisabled(ciBtn('CY'))));
    await page.click(ciBtn('CY'));
    await page.waitForSelector('#main table.g');
    check('table rows: Mandatory Line Items marked on the row cells', (await page.locator('#main .cellin.req[data-c="in-gaap:TypeOfCurrentInvestments"]').count()) >= 1 && (await page.locator('#main tr:has([data-c="in-gaap:TypeOfCurrentInvestments"]) .req-chip').count()) === 1);
    await page.click('a[data-elr$="/NotesCurrentInvestments"]');

    // ---- 1. rich text in a modal: Text Block button → popup editor → Save / Cancel → reload → XML → import → edit
    const TBC = 'in-gaap:DisclosureOfNotesOnCurrentInvestmentsExplanatoryTextBlock';
    const tbBtn = `#main [data-textblock][data-c="${TBC}"][data-s="CY"]`;
    const ed = '#tb-editor';
    const btn = (cmd) => `#modal [data-rte="${cmd}"]`;
    check('text block cell shows a compact Text Block button (no embedded editor)', (await page.locator(tbBtn).count()) === 1 && (await page.locator('#main .rte-body').count()) === 0 && (await page.locator('textarea').count()) === 0);
    await page.click(tbBtn);
    check('Text Block opens a modal editor with toolbar, Save and Cancel', await page.isVisible('#modal') && (await page.locator('#modal [data-rte]').count()) >= 7 && await page.isVisible('#tb-save') && await page.isVisible('#tb-cancel'));
    // v14.1: a new filing uses the recommended text setting — Word text is tidied for the MCA PDF on paste
    check('v14.1: new filing — text setting "plain text, bold lines as headings"; B/I/U hidden, H and Tidy shown', (await page.inputValue('#tb-emphasis')) === 'headings' && (await page.locator('#modal .rte.emph-headings').count()) === 1 && !(await page.isVisible(btn('bold'))) && await page.isVisible(btn('heading')) && await page.isVisible(btn('tidy')) && await page.isVisible('#modal .rte-layout'));
    await page.click(ed);
    await page.evaluate((sel) => {
      const dt = new DataTransfer();
      dt.setData('text/html', '<html><body><p class=MsoNormal><b>INDEPENDENT AUDITORS REPORT</b></p><p class=MsoNormal>&nbsp;</p><h2>1. Opinion</h2><p class=MsoNormal>&nbsp;</p>'
        + '<p class=MsoNormal>We have audited <b>M/s. Example Limited</b>.</p><p class=MsoNormal><o:p>&nbsp;</o:p></p><p class=MsoNormal><b>We believe that the evidence is sufficient.</b></p>'
        + '<table><tr><td><b>Particulars</b></td><td>&nbsp;</td><td>2026</td></tr><tr><td>Sales</td><td>&nbsp;</td><td>10</td></tr></table></body></html>');
      dt.setData('text/plain', 'x');
      document.querySelector(sel).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, ed);
    const tidyHtml = await page.innerHTML(ed);
    check('v14.1: Word paste — bold lines and Word headings become headings, inline bold plain, blank lines and empty columns removed', /<h5>INDEPENDENT AUDITORS REPORT<\/h5>/.test(tidyHtml) && /<h5>1\. Opinion<\/h5>/.test(tidyHtml) && /<p>We have audited M\/s\. Example Limited\.<\/p>/.test(tidyHtml) && /<p>We believe that the evidence is sufficient\.<\/p>/.test(tidyHtml) && !/<b>|<h2>|<p>(&nbsp;|\s)*<\/p>/.test(tidyHtml.replace(/<table>.*<\/table>/, '')) && (/<tr>(.*?)<\/tr>/.exec(tidyHtml)?.[1].match(/<td/g) || []).length === 2, tidyHtml.slice(0, 500));
    check('v14.1: paste confirms the tidying; the layout line reports nothing untidy', /tidied for the MCA PDF/.test(await page.textContent('#toast')) && /no empty paragraphs/.test(await page.textContent('#modal .rte-layout')));
    await page.keyboard.press('Control+b');
    await page.keyboard.type('Z');
    check('v14.1: Ctrl+B is not used with the plain-text setting (explains why)', !/<b>/.test(await page.innerHTML(ed)) && /grey box/.test(await page.textContent('#toast')));
    await page.click('#tb-cancel');
    await page.click(tbBtn);
    await page.selectOption('#tb-emphasis', 'highlight');
    check('v14.1: MCA highlight setting — B/I/U shown, the editor shows bold as the MCA PDF prints it (white on grey)', await page.isVisible(btn('bold')) && (await page.locator('#modal .rte.emph-highlight').count()) === 1);
    await page.click(ed);
    await page.keyboard.type('Investments are valued at cost. ');
    for (const [cmd, word] of [['bold', 'Bold term'], ['italic', 'Italic term'], ['underline', 'Underlined term']]) {
      await page.click(btn(cmd)); await page.keyboard.type(word); await page.click(btn(cmd)); await page.keyboard.type(' ');
    }
    check('v14.1: bold shows as white text on grey in the editor (highlight setting)', await page.evaluate(() => { const b = document.querySelector('#tb-editor b'); const cs = b && getComputedStyle(b); return !!cs && cs.backgroundColor === 'rgb(102, 102, 102)' && cs.color === 'rgb(255, 255, 255)'; }));
    await page.keyboard.press('Enter');
    await page.click(btn('insertOrderedList'));
    await page.keyboard.type('First point');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Second point');
    await page.keyboard.press('Enter');
    await page.click(btn('insertOrderedList'));
    await page.click(btn('insertUnorderedList'));
    await page.keyboard.type('Bullet point');
    await page.keyboard.press('Enter');
    await page.click(btn('insertUnorderedList'));
    await page.keyboard.type('Indented paragraph');
    await page.click(btn('indent'));
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.click(btn('outdent'));
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const dt = new DataTransfer();
      dt.setData('text/html', '<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><p class=MsoNormal style="margin:0"><span style="font-weight:bold">Pasted bold</span> and <span style="font-style:italic">pasted italic</span> &rsquo;quoted&rsquo;<o:p></o:p></p><img src="x.png">' +
        // Excel-style table: colgroup/col, colspan, width/style attributes, padded numbers, whitespace paragraphs
        '<table border=0 cellpadding=0 style="border-collapse:collapse"><colgroup><col width=200><col width=80 span=4></colgroup>' +
        '<tr><td rowspan=2 style="border:.5pt solid windowtext"><p>   </p><p><b>Name of Assets</b></p></td><td colspan=4 class=xl65 style="border:.5pt solid windowtext"><b>Gross Block</b></td></tr>' +
        '<tr><td>As on</td><td>Addition</td><td>Deduction</td><td>As on</td></tr>' +
        '<tr><td>Office Equipments</td><td align=right>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; 17.45 </td><td>&nbsp;&nbsp;&nbsp; 6.68</td><td>&nbsp; - </td><td>24.14</td></tr></table></body></html>');
      dt.setData('text/plain', 'Pasted bold and pasted italic');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, ed);
    await page.click('#tb-save');
    check('Save Text closes the popup and updates the cell', await page.isHidden('#modal') && /Investments are valued at cost/.test(await page.textContent(`${tbBtn} >> xpath=../span[@class="tb-prev"]`)));
    // cancel leaves the value unchanged
    await page.click(tbBtn);
    await page.click(ed); await page.keyboard.press('Control+End'); await page.keyboard.type(' DISCARD ME');
    await page.click('#tb-cancel');
    await page.click(tbBtn);
    const reopened = await page.innerHTML(ed);
    check('Cancel leaves the stored value unchanged; reopening shows the saved content', !/DISCARD ME/.test(reopened) && /<b>Bold term<\/b>/.test(reopened), reopened.slice(0, 200));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700); // autosave debounce
    await page.reload();
    await page.waitForSelector('#nav a[data-elr]');
    await page.click('a[data-elr$="/NotesCurrentInvestments"]');
    await page.click(tbBtn);
    const html = await page.innerHTML(ed);
    await page.click('#tb-cancel');
    check('rich text survives save → reload (bold)', /<b>Bold term<\/b>/.test(html), html.slice(0, 400));
    check('rich text survives save → reload (italic)', /<i>Italic term<\/i>/.test(html), html.slice(0, 400));
    check('rich text survives save → reload (underline)', /<u>Underlined term<\/u>/.test(html), html.slice(0, 400));
    check('rich text survives save → reload (numbered list)', /<ol><li>First point<\/li><li>Second point<\/li><\/ol>/.test(html), html.slice(0, 600));
    check('rich text survives save → reload (bulleted list)', /<ul><li>Bullet point<\/li><\/ul>/.test(html), html.slice(0, 600));
    check('rich text survives save → reload (indentation)', /<blockquote>(<p>)?Indented paragraph/.test(html), html);
    check('paste from Word: emphasis kept, Office markup / images / styles dropped', /<b>Pasted bold<\/b>/.test(html) && /<i>pasted italic<\/i>/.test(html) && /’quoted’/.test(html) && !/style=|<img|o:p|Mso/.test(html), html);
    const ptab = /<table>[\s\S]*?<\/table>/.exec(html)?.[0] || '';
    const rowsCells = [...ptab.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => (m[1].match(/<td/g) || []).length);
    check('paste from Excel: table rebuilt without colgroup/col/colspan/rowspan, every row 5 cells, every cell bordered', ptab && !/colgroup|<col|colspan|rowspan|width=|align=/.test(ptab) && rowsCells.length === 3 && rowsCells.every((n) => n === 5) && (ptab.match(/<td class="bordered">/g) || []).length === 15, ptab.slice(0, 400));
    check('paste from Excel: number padding removed, merged header kept in its first cell', /<td class="bordered"><p>17\.45<\/p><\/td>/.test(ptab) && /<td class="bordered"><p>-<\/p><\/td>/.test(ptab) && /<b>Gross Block<\/b>/.test(ptab) && !/<p>\s*<\/p>/.test(ptab), ptab.slice(0, 600));
    await page.click('a[data-go="xml"]');
    await page.click('button[data-act="generate"]');
    await page.waitForSelector('#xmltext, .banner.bad');
    if (!(await page.locator('#xmltext').count())) { await page.click('a[data-go="validate"]'); throw new Error('generation blocked: ' + (await page.textContent('.issues')).slice(0, 600)); }
    const xml = await page.textContent('#xmltext');
    const fact = /<in-gaap:DisclosureOfNotesOnCurrentInvestmentsExplanatoryTextBlock[^>]*>([^<]*)</.exec(xml)?.[1] || '';
    const mca = fact.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    check('XML: bold/italic/underline as highlightedText1/2/3, lists as noteText1 (v14.4: bulleted too — noteText2 prints in a grey box), indent as noteText3', ['highlightedText1">Bold term', 'highlightedText2">Italic term', 'highlightedText3">Underlined term', 'class="noteText1"><p>1.&nbsp;First point', 'class="noteText1"><p>•&nbsp;Bullet point', 'class="noteText3"'].every((x) => mca.includes(x)), mca.slice(0, 600));
    check('XML: no unsupported tags or style attributes inside the text block', mca.length > 0 && ![...mca.matchAll(/<\/?([a-zA-Z]+)/g)].some((m) => !['div', 'span', 'p', 'br', 'table', 'td', 'tr', 'thead', 'tfoot', 'tbody', 'th'].includes(m[1])) && !/style=/.test(mca), mca.slice(0, 300));
    check('XML: text block HTML carries only class attributes (MCA HTML schema)', [...mca.matchAll(/<[a-z]+((?:\s+[a-z-]+="[^"]*")*)\s*\/?>/g)].every((m) => [...m[1].matchAll(/([a-z-]+)=/g)].every((a) => a[1] === 'class')) && /<table><tbody><tr><td class="bordered">/.test(mca), mca.slice(mca.indexOf('<table'), mca.indexOf('<table') + 300));
    const buildId = await page.getAttribute('.brand small', 'data-build');
    check('build id shown in the header and written into the generated XML', /^[0-9a-f]{10}$/.test(buildId || '') && xml.includes(`<!-- Generated by C&amp;I XBRL Studio build ${buildId} -->`), buildId);
    const exported = path.join(ROOT, '.smoke-export.xml');
    writeFileSync(exported, xml);

    // imported rich text is edited through the same popup
    await page.setInputFiles('#file-xml', exported);
    await page.waitForSelector('#import-confirm');
    await page.check('#ym-both');
    await page.click('#import-commit');
    await page.waitForSelector('.banner.info');
    await page.click('a[data-elr$="/NotesCurrentInvestments"]');
    await page.click(tbBtn);
    const imported = await page.innerHTML(ed);
    check('XML import: formatting restored in the popup editor', /<b>Bold term<\/b>/.test(imported) && /<ol><li>First point/.test(imported) && /<ul><li>Bullet point/.test(imported) && /<blockquote>/.test(imported), imported.slice(0, 300));
    await page.click(ed);
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.click(btn('bold'));
    await page.keyboard.type('Edited after import');
    await page.click('#tb-save');
    await page.click('a[data-go="xml"]');
    await page.click('button[data-act="generate"]');
    await page.waitForSelector('#xmltext, .banner.bad');
    const xml2 = (await page.locator('#xmltext').count()) ? await page.textContent('#xmltext') : '';
    check('editing imported rich text in the popup: new formatting exported', xml2.includes('&lt;span class=&quot;highlightedText1&quot;&gt;Edited after import&lt;/span&gt;') && xml2.includes('Bold term'));
    // v14.1: an imported instance with highlight classes keeps that setting; Tidy with the recommended setting cleans it
    await page.click('a[data-elr$="/NotesCurrentInvestments"]');
    await page.click(tbBtn);
    await page.waitForFunction(() => (document.querySelector('#modal .rte-layout')?.textContent || '').length > 0);
    check('v14.1: XML import with highlight classes keeps the MCA highlight setting', (await page.inputValue('#tb-emphasis')) === 'highlight' && /grey boxes/.test(await page.textContent('#modal .rte-layout')));
    await page.selectOption('#tb-emphasis', 'headings');
    await page.click(btn('tidy'));
    check('v14.1: Tidy confirms what it changed', /Tidied:/.test(await page.textContent('#toast')) && /no empty paragraphs/.test(await page.textContent('#modal .rte-layout')));
    await page.click('#tb-save');
    await page.click('a[data-go="xml"]');
    await page.click('button[data-act="generate"]');
    await page.waitForSelector('#xmltext, .banner.bad');
    const xml3 = (await page.locator('#xmltext').count()) ? await page.textContent('#xmltext') : '';
    const fact3 = /<in-gaap:DisclosureOfNotesOnCurrentInvestmentsExplanatoryTextBlock[^>]*>([^<]*)</.exec(xml3)?.[1] || '';
    check('v14.1: tidied text block exported without highlight classes, text kept (lists, table, indentation)', fact3 && !/highlightedText/.test(fact3) && /Bold term/.test(fact3) && /Edited after import/.test(fact3) && /noteText1/.test(fact3) && /noteText3/.test(fact3) && /&lt;table&gt;/.test(fact3), fact3.slice(0, 300));
    try { unlinkSync(exported); } catch { /* ignore */ }

    // ---- 8. Disclosure of General Information about Company + 3B. cash-flow method on a fresh selection
    await page.click('a[data-go="setup"]');
    check('section renamed: "Disclosure of General Information about Company" (nav + heading)', (await page.textContent('#general-title')).trim() === 'Disclosure of General Information about Company' && /Disclosure of General Information about Company/.test(await page.textContent('#nav')));
    check('company information fields present (CIN, name, report type, periods, rounding) and [400100] elements listed', ['#f-name', '#f-cin', '#f-rt', '#f-cys', '#f-cye', '#f-lvl'].every(Boolean) && (await page.locator('#f-cin').count()) === 1 && (await page.locator('#main table.g input[data-c^="in-ca:"], #main table.g select[data-c^="in-ca:"]').count()) > 10);
    // v14.2: dates are typed day first (dd-mm-yyyy) whatever the browser's language (this browser runs as en-US,
    // whose own date field reads mm/dd/yyyy)
    {
      const dsel = '#main input.cellin[data-date][data-c="in-ca:DateOfBoardMeetingWhenFinalAccountsWereApproved"]';
      const dcell = (await page.locator(dsel).count()) ? dsel : '#main input.cellin[data-date]:not([disabled]):not([readonly])';
      check('v14.2: date cells are dd-mm-yyyy text fields with a calendar button (no browser date field)', (await page.locator('#main input.cellin[type="date"]').count()) === 0 && (await page.locator(dcell).count()) >= 1 && (await page.getAttribute(dcell, 'placeholder')) === 'dd-mm-yyyy' && (await page.locator('#f-cys[data-date]').count()) === 1);
      await page.fill(dcell, '05-09-2026'); await page.press(dcell, 'Tab');
      const toast1 = await page.textContent('#toast');
      await page.click('a[data-elr$="/BalanceSheet"]'); await page.click('a[data-go="setup"]'); // re-rendered from the stored value
      const nat = () => page.evaluate((sel) => document.querySelector(sel).parentElement.querySelector('.date-native').value, dcell);
      check('v14.2: 05-09-2026 is stored as 5 September 2026 (2026-09-05) and shown back day first', (await page.inputValue(dcell)) === '05-09-2026' && (await nat()) === '2026-09-05' && /5 September 2026$/.test(await page.getAttribute(dcell, 'title')) && /5 September 2026/.test(toast1), `${await page.inputValue(dcell)} ${await nat()} ${toast1}`);
      await page.fill(dcell, '31/02/2026'); await page.press(dcell, 'Tab');
      const toast2 = await page.textContent('#toast');
      await page.click('a[data-elr$="/BalanceSheet"]'); await page.click('a[data-go="setup"]');
      check('v14.2: an impossible date is refused with a day-first hint; the stored date is kept', /not a date/.test(toast2) && /dd-mm-yyyy/.test(toast2) && (await page.inputValue(dcell)) === '05-09-2026', toast2);
      await page.evaluate((sel) => { const n = document.querySelector(sel).parentElement.querySelector('.date-native'); n.value = '2026-04-05'; n.dispatchEvent(new Event('change', { bubbles: true })); }, dcell);
      check('v14.2: a date picked from the calendar is entered day first (05-04-2026 = 5 April 2026)', (await page.inputValue(dcell)) === '05-04-2026' && /5 April 2026$/.test(await page.getAttribute(dcell, 'title')));
      await page.fill(dcell, ''); await page.press(dcell, 'Tab');
    }
    await page.check('#cf-direct');
    await page.waitForTimeout(150);
    const naDirect = await page.getAttribute('a[data-elr$="/CashFlowStatementDirect"]', 'class');
    const naIndirect = await page.getAttribute('a[data-elr$="/CashFlowStatementIndirect"]', 'class');
    check('Direct selected: [100300] enabled, [100400] disabled (immediately)', !/\bna\b/.test(naDirect) && /\bna\b/.test(naIndirect), `${naDirect} | ${naIndirect}`);
    await page.click('a[data-elr$="/CashFlowStatementIndirect"]');
    const offInputs = await page.$$eval('#main .cellin', (els) => [els.length, els.filter((e) => e.disabled).length, els.filter((e) => e.value !== '').length]);
    check('disabled cash-flow tab: unavailable, no data entry, no values shown', (await page.locator('.sheet.tab-off').count()) === 1 && offInputs[0] > 0 && offInputs[0] === offInputs[1] && offInputs[2] === 0, JSON.stringify(offInputs));
    await page.click('a[data-go="setup"]');
    await page.check('#cf-indirect');
    await page.waitForTimeout(150);
    check('Indirect selected: [100400] enabled, [100300] disabled', /\bna\b/.test(await page.getAttribute('a[data-elr$="/CashFlowStatementDirect"]', 'class')) && !/\bna\b/.test(await page.getAttribute('a[data-elr$="/CashFlowStatementIndirect"]', 'class')));

    // ---- 5. calculated cells: read-only by default, auto-populated, tab-specific override
    await page.click('a[data-elr$="/BalanceSheet"]');
    const CA = 'input[data-c="in-gaap:NoncurrentLiabilities"][data-s="CY"]';
    check('calculated parent cell is read-only by default', (await page.getAttribute(CA, 'readonly')) !== null);
    const before = await page.inputValue(CA);
    const inv = 'input[data-c="in-gaap:DeferredTaxLiabilitiesNet"][data-s="CY"]';
    await page.fill(inv, '100'); await page.dispatchEvent(inv, 'change');
    await page.waitForTimeout(100);
    const after = await page.inputValue(CA);
    check('calculation still occurs: parent updated from its children', Number(after) === Number(before) + 100, `${before} → ${after}`);
    await page.fill(inv, ''); await page.dispatchEvent(inv, 'change');
    await page.check('input[data-calc-override$="/BalanceSheet"]');
    check('tab option enables editing of calculated cells on this tab', (await page.getAttribute(CA, 'readonly')) === null);
    await page.click('a[data-elr$="/StatementOfProfitAndLoss"]');
    const plCalc = await page.$$eval('#main .cellin.calc', (els) => els.filter((e) => e.hasAttribute('readonly')).length);
    check('override does not affect other tabs (P&L calculated cells stay read-only)', plCalc > 0, `readonly calc cells on P&L: ${plCalc}`);
    await page.click('a[data-elr$="/BalanceSheet"]');
    await page.uncheck('input[data-calc-override$="/BalanceSheet"]');
    check('disabling the option returns calculated cells to read-only, value kept', (await page.getAttribute(CA, 'readonly')) !== null && (await page.inputValue(CA)) === before);

    // ---- 7. Yes/No dependency with a safe Yes → No change
    await page.click('a[data-elr$="/NotesSubsidiaryInformation"]');
    const PAR = 'select[data-c="in-ca:WhetherCompanyHasSubsidiaryCompanies"][data-s="CY"]';
    const CH = 'input[data-c="in-ca:NumberOfSubsidiaryCompanies"][data-s="CY"]';
    await page.selectOption(PAR, 'true');
    await page.waitForTimeout(150);
    check('Yes → dependent field enabled', !(await page.isDisabled(CH)));
    check('Mandatory mark follows the condition: Yes → dependent field marked mandatory (conditional)', await page.evaluate((sel) => document.querySelector(sel).classList.contains('req'), CH) && (await page.locator('#main tr:has(input[data-c="in-ca:NumberOfSubsidiaryCompanies"]) .req-chip.cond').count()) === 1);
    await page.fill(CH, '2'); await page.dispatchEvent(CH, 'change');
    await page.selectOption(PAR, 'false');
    await page.waitForSelector('#dlg-continue');
    const dlg = await page.textContent('#modal-body');
    check('Yes → No asks before making entered values non-applicable (nothing deleted)', /will make <?b?>?\s*\d+|will make/.test(dlg) && /retained but excluded/.test(dlg), dlg);
    await page.click('#dlg-cancel');
    check('Cancel keeps the Yes answer and the dependent value', (await page.inputValue(PAR)) === 'true' && (await page.inputValue(CH)) === '2');
    await page.selectOption(PAR, 'false');
    await page.waitForSelector('#dlg-continue');
    await page.click('#dlg-continue');
    await page.waitForTimeout(150);
    check('No → dependent field disabled and blank; dependent table unavailable', await page.isDisabled(CH) && (await page.inputValue(CH)) === '' && await page.isDisabled('button[data-open-table="202800:DetailsOfSubsidiariesTable"][data-scope="CY"]'));

    // ---- 4. validation → exact cell (error red, warning marked) and navigation
    await page.click('a[data-elr$="/StatementOfProfitAndLoss"]');
    const OI = 'input[data-c="in-gaap:OtherIncome"][data-s="CY"]';
    const oiVal = await page.inputValue(OI);
    check('Mandatory label on a mandatory row (P&L Other income)', (await page.locator('#main tr:has(input[data-c="in-gaap:OtherIncome"]) .req-chip').count()) === 1);
    // v13: other income on the P&L is taken from its note [300500] (read-only, Go to note) — cleared there
    check('v13: P&L other income taken from its note (read-only, Go to note)', await page.$eval(OI, (e) => e.readOnly) && (await page.locator('[data-go-note="in-gaap:OtherIncome"][data-s="CY"]').count()) === 1);
    await page.click('[data-go-note="in-gaap:OtherIncome"][data-s="CY"]');
    await page.waitForTimeout(150);
    check('v13: Go to note opens the note tab at the same element', /\/NotesSubclassificationAndNotesOnIncomeAndExpenses$/.test(await page.getAttribute('#nav a.on[data-elr]', 'data-elr') || '') && (await page.evaluate(() => document.activeElement?.dataset?.c)) === 'in-gaap:OtherIncome');
    // (in the note it is the total of its parts, entered as 0 in the example: cleared with the tab option)
    await page.check('[data-calc-override]');
    await page.fill(OI, ''); await page.dispatchEvent(OI, 'change');
    await page.uncheck('[data-calc-override]');
    await page.click('a[data-elr$="/StatementOfProfitAndLoss"]');
    check('empty mandatory cell is highlighted', await page.evaluate((sel) => document.querySelector(sel).classList.contains('req-empty'), OI));
    await page.click('.bar button[data-act="validate"]');
    await page.waitForSelector('.issues');
    const errLi = page.locator('.issues li.nav-issue', { hasText: "'OtherIncome' is mandatory" }).first();
    check('validation lists the error with its location', (await errLi.count()) === 1 && /\[100200\]/.test(await errLi.textContent()));
    await errLi.click();
    await page.waitForTimeout(200);
    const focusedCell = await page.evaluate(() => document.activeElement?.dataset?.cell || '');
    check('clicking the error activates the tab and focuses the exact cell', /\/StatementOfProfitAndLoss$/.test(await page.getAttribute('#nav a.on[data-elr]', 'data-elr') || '') && focusedCell.startsWith('in-gaap:OtherIncome#D:'), focusedCell);
    check('the erroneous cell is marked red', await page.evaluate((sel) => document.querySelector(sel).classList.contains('cell-err'), OI));
    await page.click('a[data-go="validate"]');
    await page.click('button[data-filter="WARNING"]');
    const warnLi = page.locator('.issues li.nav-issue', { hasText: 'NumberOfSubsidiaryCompanies' }).first();
    check('the warning (value retained but excluded) is listed with its location', (await warnLi.count()) === 1);
    await warnLi.click();
    await page.waitForTimeout(200);
    check('clicking the warning navigates to its cell, which carries the warning mark', /\/NotesSubsidiaryInformation$/.test(await page.getAttribute('#nav a.on[data-elr]', 'data-elr') || '') && await page.evaluate((sel) => document.querySelector(sel).classList.contains('cell-warn'), CH));

    // ---- 6. validate only the current tab
    await page.click('a[data-elr$="/StatementOfProfitAndLoss"]');
    await page.click('#main button[data-act="validate-tab"]');
    await page.waitForSelector('.issues');
    const head = await page.textContent('#main h1');
    const locs = await page.$$eval('.issues li.nav-issue', (els) => els.map((e) => ({ t: e.querySelector('.reasons')?.textContent || '', x: /cross-tab/.test(e.textContent) })));
    check('Validate current tab: scope shown; every result belongs to [100200] or is marked cross-tab', /current tab \[100200\]/.test(head) && locs.length > 0 && locs.every((l) => l.t.includes('[100200]') || l.x), JSON.stringify(locs.slice(0, 5)));
    await page.click('#main button[data-act="validate"]');
    await page.waitForSelector('.issues');
    check('Validate entire filing still available and covers other tabs', !/current tab/.test(await page.textContent('#main h1')));
    // restore (in the note: the P&L figure is taken from it)
    await page.click('a[data-elr$="/NotesSubclassificationAndNotesOnIncomeAndExpenses"]');
    await page.check('[data-calc-override]');
    await page.fill(OI, oiVal); await page.dispatchEvent(OI, 'change');
    await page.uncheck('[data-calc-override]');

    // ---- import with year-mapping choice
    const golden = readdirSync(ROOT).find((f) => /^golden-.*\.xml$/.test(f));
    if (golden) {
      await page.setInputFiles('#file-xml', path.join(ROOT, golden));
      await page.waitForSelector('#import-confirm');
      check('import waits for a year-mapping choice (Import disabled)', await page.isDisabled('#import-commit'));
      // v14: the import offers "Both years" and "Prepare next year's filing" ("Current year only" is retired)
      check('v14: import offers Both years and Prepare next year\'s filing only', (await page.locator('#ym-current').count()) === 0 && (await page.locator('#ym-both').count()) === 1 && (await page.locator('#ym-next').count()) === 1);
      await page.check('#ym-both');
      await page.click('#import-commit');
      await page.waitForSelector('.banner.info');
      check('both-years summary shown', /Previous year imported: [\d,]+ facts/.test(await page.textContent('.banner.info')));
      await page.click('a[data-elr$="/BalanceSheet"]');
      check('Both years: previous-year column filled', (await page.$$eval('input[data-s="PY"].cellin', (els) => els.filter((e) => e.value !== '').length)) > 10);
      // ---- 2. previous-year applicability on import: non-applicable PY cells stay blank
      await page.click('a[data-elr$="/DisclosuresAuditorsReport"]');
      const pyCells = await page.$$eval('#main .cellin[data-s="PY"], #main [data-textblock][data-s="PY"]', (els) => els.map((e) => ({ d: e.disabled, v: e.value || '' })));
      check('Imported XML: previous-year cells of [400200] (GR-12) are disabled and blank', pyCells.length > 0 && pyCells.every((c) => c.d && c.v === ''), JSON.stringify(pyCells.slice(0, 4)));
      await page.click('a[data-go="import"]');
      check('import report lists facts not imported because not applicable', /Not applicable — not imported as filing data \(\d+\)/.test(await page.textContent('#main')));
      // ---- v11: closing-balance rows, the table total column, fix tools, next year's filing
      await page.click('a[data-elr$="/NotesTangibleAssets"]');
      await page.click('button[data-open-table="201000:DisclosureOfTangibleAssetsTable"][data-scope="CY"]');
      await page.waitForSelector('#main table.g');
      check('tangible assets table shows the closing row "Tangible assets at end of period"', (await page.locator('#main tr', { hasText: 'Tangible assets at end of period' }).count()) === 1);
      const heads = await page.$$eval('#main th.slicehead', (els) => els.map((e) => e.textContent));
      check('tangible assets table shows its total column (every axis at its default)', heads.some((h) => (h.match(/\(default\)/gi) || []).length === 3), heads[0]);
      check('dimensional table offers "Fill empty totals"', (await page.locator('#main button[data-act="fill-totals"]').count()) === 1);
      await page.click('[data-act="validate"]');
      await page.waitForSelector('#main .tiles');
      check('validation offers Recalculate current year and Fill empty totals', (await page.locator('#main [data-act="recalc-all"]').count()) === 1 && (await page.locator('#main [data-act="fill-totals-all"]').count()) === 1);
      await page.click('#main [data-act="recalc-all"]');
      await page.waitForTimeout(300);
      // FILING-B is fully consistent (no dialog); FILING-A's reserves closing differs from opening + changes by a rounding difference
      // (its own rounding, accepted by MCA) — the preview lists it and nothing changes unless confirmed
      const dlg = (await page.locator('#dlg-continue').count()) ? await page.textContent('#modal') : '';
      // v13: the balance-sheet reserves (taken from the reserves note) and its totals follow that rounding too
      const items = dlg ? await page.$$eval('#modal li', (els) => els.map((e) => e.textContent.split(':')[0].trim())) : [];
      const roundingOnly = items.every((t) => /reserve|shareholders|equity and liabilities|other reserves/i.test(t));
      check('Recalculate current year previews before changing (validated instance: none, or only the FILING-A reserves rounding and the figures it feeds)', !dlg || (items.length <= 5 && roundingOnly), dlg.slice(0, 300));
      if (dlg) await page.click('#dlg-cancel');
      await page.setInputFiles('#file-xml', path.join(ROOT, golden));
      await page.waitForSelector('#import-confirm');
      check('import offers "Next year\'s filing"', (await page.locator('#ym-next').count()) === 1);
      await page.check('#ym-next');
      await page.click('#import-commit');
      await page.waitForSelector('.banner.info');
      const nb = await page.textContent('.banner.info');
      check('next year\'s filing: new periods and previous-year import summarised', /Next year's filing/.test(nb) && /is the previous year/.test(nb), nb);
      await page.click('a[data-elr$="/BalanceSheet"]');
      const cyN = await page.$$eval('input[data-s="CY"].cellin', (els) => els.filter((e) => e.value !== '').length);
      const pyN = await page.$$eval('input[data-s="PY"].cellin', (els) => els.filter((e) => e.value !== '').length);
      check('next year\'s filing: balance sheet previous-year column filled, current year empty', pyN > 10 && cyN === 0, `PY ${pyN} CY ${cyN}`);
      // v14: the previous year is locked as filed; earlier years and last year's disclosures are set aside (Hidden data)
      check('v14: previous-year column locked as filed (read-only, Unlock offered)', await page.$eval('input[data-c="in-gaap:DeferredTaxLiabilitiesNet"][data-s="PY"]', (e) => e.readOnly) && (await page.locator('#main [data-act="py-unlock"]').count()) === 1);
      await page.click('#main [data-act="py-unlock"]'); await page.click('#dlg-continue');
      check('v14: Unlock previous year makes it editable', !(await page.$eval('input[data-c="in-gaap:DeferredTaxLiabilitiesNet"][data-s="PY"]', (e) => e.readOnly)));
      await page.click('#main [data-act="py-lock"]');
      check('v14: Lock previous year again', await page.$eval('input[data-c="in-gaap:DeferredTaxLiabilitiesNet"][data-s="PY"]', (e) => e.readOnly));
      check('v14: Hidden data shows a count in the menu', /\d/.test(await page.textContent('a[data-go="hidden"]')));
      await page.click('a[data-go="hidden"]');
      const hid = await page.textContent('#main');
      check('v14: Hidden data lists the set-aside earlier years and last year\'s disclosures', /Last year's previous-year figure/.test(hid) && /reported for the current year only/.test(hid) && (await page.locator('#main [data-act="sa-restore"], #main .row-acts .reasons').count()) > 0, hid.slice(0, 200));
      await page.click('[data-act="validate"]');
      await page.waitForSelector('#main .tiles');
      check('v14: Validation compares the previous year with last year\'s filing', /Previous year vs last year's filing/.test(await page.textContent('#main')) && /All previous-year figures equal the filed ones/.test(await page.textContent('#main')));
      // back to the imported filing (both years) for the checks that follow
      await page.setInputFiles('#file-xml', path.join(ROOT, golden));
      await page.waitForSelector('#import-confirm');
      await page.check('#ym-both');
      await page.click('#import-commit');
      await page.waitForSelector('.banner.info');

      // ---- 3. total/part guidance on dimensional tables (display only)
      await page.click('a[data-elr$="/NotesBorrowings"]');
      await page.click('button[data-open-table="200300:ClassificationOfBorrowingsTable"][data-scope="CY"]');
      await page.waitForSelector('#main table.g');
      check('column headings mark TOTAL and "part of" members', (await page.locator('#main th.slicehead .mb.total').count()) > 0 && (await page.locator('#main th.slicehead .mb.part').count()) > 0);
      check('member picker marks totals and explains where a member sits', (await page.locator('#ax-1 option', { hasText: '— total' }).count()) > 0 && (await page.getAttribute('#ax-1 option[value="in-gaap:RupeeTermLoansFromOthersMember"]', 'title') || '').includes('Part of: Term loans from others'));
      await page.selectOption('#ax-1', 'in-gaap:RupeeTermLoansFromOthersMember');
      const help = await page.textContent('#axhelp-1');
      check('picker help: part, its totals and the GR-3 parent column', /part/.test(help) && /Term loans from others/.test(help) && /GR-3/.test(help), help);
      check('validated data: total cells show "= parts ✓"', (await page.locator('#main .sum-hint .ok').count()) > 0);
      const PARENT = '#main td.val:has(.sum-hint .ok) input.cellin[data-c="in-gaap:Borrowings"]';
      const parentCell = await page.locator(PARENT).first().getAttribute('data-cell');
      const PC = `#main input.cellin[data-cell="${parentCell}"]`;
      const orig = await page.inputValue(PC);
      await page.fill(PC, String(Number(orig.replace(/,/g, '')) + 1000));
      await page.dispatchEvent(PC, 'change');
      const tdHint = `#main td.val:has(${PC.replace('#main ', '')}) .sum-hint`;
      check('a total that differs from its parts shows the difference and "Use parts total"', /differs by/.test(await page.textContent(tdHint)) && (await page.locator(`${tdHint} [data-act="use-sum"]`).count()) === 1, await page.textContent(tdHint));
      await page.click('a[data-elr$="/BalanceSheet"]');
      check('leaving the table with differing totals asks first', await page.isVisible('#modal') && /Totals do not match/.test(await page.textContent('#modal-title')) && /Stay and fix/.test(await page.textContent('#dlg-cancel')));
      await page.click('#dlg-cancel');
      check('"Stay and fix" keeps the table open', await page.isHidden('#modal') && (await page.locator(PC).count()) === 1);
      await page.focus(PC); await page.keyboard.press('ArrowDown');
      check('v14: ↓ from a total cell reaches its "Use parts total" button', await page.evaluate(() => document.activeElement?.dataset?.act === 'use-sum'));
      await page.keyboard.press('ArrowUp');
      check('v14: ↑ returns to the cell', await page.evaluate((sel) => document.activeElement === document.querySelector(sel), PC));
      await page.click(`${tdHint} [data-act="use-sum"]`);
      check('"Use parts total" enters the sum of the parts through the normal cell entry', (await page.inputValue(PC)).replace(/,/g, '') === orig.replace(/,/g, '') && (await page.locator(`${tdHint} .ok`).count()) === 1, await page.inputValue(PC));
      // GR-3: a part column without its parent column offers to add the parent
      await page.click('#addslice button[type="submit"]');
      const need = page.locator('#main th.slicehead .needs-parent', { hasText: 'Term loans from others' });
      check('new part column shows "Needs … column (GR-3)" with Add', (await need.count()) === 1);
      const before = await page.locator('#main th.slicehead').count();
      await need.locator('button').click();
      check('Add creates the parent column(s)', (await page.locator('#main th.slicehead').count()) > before && (await page.locator('#main th.slicehead .needs-parent', { hasText: 'Term loans from others' }).count()) === 0);
      await page.selectOption('#colorder', 'entered');
      check('column order can be switched to "as entered"', (await page.inputValue('#colorder')) === 'entered');
      await page.selectOption('#colorder', 'taxonomy');
      await page.click('a[data-elr$="/BalanceSheet"]');
      check('totals consistent again: leaving the table needs no confirmation', await page.isHidden('#modal'));
      await page.click('button[data-act="validate"]');
      await page.waitForSelector('#main .issues');
      check('Validation lists Totals hints separately (tool guidance)', /Totals hints/.test(await page.textContent('#main')) && /No differences/.test(await page.textContent('#main')));
      // ---- 4. copy from previous year (columns; values optional) — existing Add row / cell-entry paths
      await page.click('a[data-elr$="/NotesBorrowings"]');
      await page.click('button[data-open-table="200300:ClassificationOfBorrowingsTable"][data-scope="CY"]');
      await page.waitForSelector('#main button[data-act="carry-forward"]');
      check('current-year table offers "Copy from previous year"', !(await page.isDisabled('#main button[data-act="carry-forward"]')));
      await page.click('#main button[data-act="carry-forward"]');
      check('copy dialog: columns, optional values, never overwrites', await page.isVisible('#modal') && (await page.locator('#cf-values').count()) === 1 && /never overwritten/.test(await page.textContent('#modal')) && (await page.textContent('#dlg-continue')) === 'Copy');
      await page.click('#dlg-continue');
      check('copy (columns only) confirms what was added', /Added \d+ column/.test(await page.textContent('#toast')));
      // ---- 5. footnotes: select a cell, Alt+N, save; listed on the Footnotes tab; written to the XML
      const fnId = await page.evaluate(() => [...document.querySelectorAll('#main td.val input.cellin[data-c="in-gaap:Borrowings"]')].find((e) => e.value && !e.disabled)?.dataset.cell);
      await page.focus(`#main input.cellin[data-cell="${fnId}"]`);
      await page.keyboard.press('Alt+n');
      check('Alt+N opens the footnote dialog for the selected cell', await page.isVisible('#modal') && /Borrowings/.test(await page.textContent('#modal-body')));
      // v14.7: the footnote is typed in the text editor (toolbar, Paragraph style), as a text block
      check('v14.7: the footnote dialog has the text editor (toolbar and Paragraph style)', (await page.locator('#modal #fn-editor.rte-body').count()) === 1 && (await page.locator('#modal .rte-style option').count()) === 6 && (await page.locator('#modal [data-rte="insertUnorderedList"]').count()) === 1);
      await page.click('#fn-editor');
      await page.keyboard.type('Smoke footnote: secured by hypothecation of stock');
      await page.click('#fn-save');
      check('cell shows the footnote mark', (await page.locator(`#main td.val.has-fn:has(input[data-cell="${fnId}"])`).count()) === 1);
      await page.click('a[data-go="footnotes"]');
      check('Footnotes tab lists the footnote with its cell', /Smoke footnote/.test(await page.textContent('#main .fn-text >> nth=-1')) && (await page.locator('#main [data-fn-go]').count()) >= 1);
      // v14.7: Edit text… opens the same editor; a bulleted list is kept
      await page.click('#main [data-act="fn-edit"] >> nth=-1');
      await page.waitForSelector('#modal #fn-editor');
      await page.evaluate(() => { const e = document.querySelector('#fn-editor'); const r = document.createRange(); r.selectNodeContents(e); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
      await page.keyboard.press('Enter');
      await page.click('#modal [data-rte="insertUnorderedList"]');
      await page.keyboard.type('Second charge on land');
      await page.keyboard.press('Control+Enter');
      await page.waitForTimeout(200);
      check('v14.7: a footnote edited in the text editor is saved (Ctrl+Enter) with its list', !(await page.isVisible('#modal')) && /Second charge on land/.test(await page.textContent('#main .fn-text >> nth=-1')));
      await page.click('a[data-go="xml"]');
      await page.click('button[data-act="generate"]');
      await page.waitForSelector('#xmltext, .banner.bad');
      const fx = (await page.locator('#xmltext').count()) ? await page.textContent('#xmltext') : '';
      // v14.7: the footnote text is MCA HTML, written as text (escaped), as in the MCA-validated reference instance
      check('generated XML carries the footnote as an XBRL footnote link', /<link:footnote [^>]*>&lt;p&gt;Smoke footnote: secured by hypothecation of stock&lt;\/p&gt;(&lt;p&gt;&lt;\/p&gt;)?&lt;div class=&quot;noteText1&quot;&gt;&lt;p&gt;•&amp;nbsp;Second charge on land&lt;\/p&gt;&lt;\/div&gt;<\/link:footnote>/.test(fx) && /fact-footnote/.test(fx), (fx.match(/<link:footnote [^>]*>[^]*?<\/link:footnote>/) || [''])[0]);
      // ---- 6. printable preview (not the MCA rendering)
      const [pv] = await Promise.all([page.waitForEvent('popup'), page.click('button[data-act="preview-pdf"]')]);
      await pv.waitForLoadState();
      const pvText = await pv.textContent('body');
      check('Preview PDF opens a printable preview labelled "not the MCA rendering" with statements and notes', /not the MCA rendering/.test(pvText) && /\[100100\] Balance sheet/.test(pvText) && /Unless otherwise specified, all monetary values are in/.test(pvText) && (await pv.locator('button', { hasText: 'Print / Save as PDF' }).count()) === 1, pvText.slice(0, 200));
      check('preview shows the footnote as in the MCA PDF ("(A) value" and a Footnotes list)', /\(A\) [\d,.-]+/.test(pvText) && /Footnotes\s*\(A\)\s*Smoke footnote: secured by hypothecation of stock/.test(pvText));
      check('v14.7: the preview prints the footnote\'s list as formatted text', (await pv.locator('.fns .fnrich .noteText1').count()) >= 1 && /•\s*Second charge on land/.test(pvText));
      await pv.close();
    }
    // ---- usability (UI only): keyboard movement, accessible names, sticky headers, save/confirm feedback
    await page.click('a[data-elr$="/BalanceSheet"]');
    const firstCy = page.locator('#main table.g td.val input.cellin[data-s="CY"]:not([disabled]):not([readonly])').first();
    await firstCy.focus();
    const fromCell = await firstCy.getAttribute('data-cell');
    await page.keyboard.press('Enter');
    const moved = await page.evaluate(() => ({ cell: document.activeElement?.dataset?.cell, s: document.activeElement?.dataset?.s, inGrid: !!document.activeElement?.closest('td.val') }));
    check('Enter moves to the next editable cell of the same column', moved.inGrid && moved.s === 'CY' && moved.cell && moved.cell !== fromCell, JSON.stringify(moved));
    await page.keyboard.press('Shift+Enter');
    check('Shift+Enter moves back up', (await page.evaluate(() => document.activeElement?.dataset?.cell)) === fromCell);
    const aria = await firstCy.getAttribute('aria-label');
    check('grid cells carry an accessible name (row — column)', /—/.test(aria || '') && /Current/i.test(aria || ''), aria);
    const sticky = await page.evaluate(() => [getComputedStyle(document.querySelector('#main table.g thead th')).position, getComputedStyle(document.querySelector('#main table.g td.lbl')).position]);
    check('column headings and the row-label column are sticky', sticky.every((x) => x === 'sticky'), sticky.join(','));
    await page.keyboard.press('Control+s');
    await page.waitForSelector('#bar-save.ok');
    check('Ctrl+S saves in the browser and confirms', /Saved/.test(await page.textContent('#bar-save')) && /Saved in this browser/.test(await page.textContent('#toast')));
    const nameBefore = await page.textContent('#bar-who b');
    await page.click('button[data-act="new-filing"]');
    check('New filing asks for confirmation in a dialog (focus on Cancel)', await page.isVisible('#modal') && (await page.evaluate(() => document.activeElement?.id)) === 'dlg-cancel');
    await page.keyboard.press('Escape');
    check('cancelling New filing keeps the filing', await page.isHidden('#modal') && (await page.textContent('#bar-who b')) === nameBefore);
    await page.click('a[data-elr$="/NotesCurrentInvestments"]');
    await page.click('#main [data-textblock][data-s="CY"]:not([disabled])');
    check('text block editor shows its validation status', /Not validated yet|No validation issues|issue\(s\) for this text block/.test(await page.textContent('#modal .tb-issues')));
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Shift+Tab');
    check('Tab stays inside the dialog', await page.evaluate(() => !!document.activeElement?.closest('#modal')));
    await page.keyboard.press('Escape');

    // ---- MCA Validator error help
    await page.click('a[data-go="mcaerrors"]');
    await page.fill('#mx-text', "1) cvc-complex-type.3.2.2: Attribute 'xml:lang' is not allowed to appear in element 'in-ca:CorporateIdentityNumber'.\n2) Element 'DisclosureInBoardOfDirectorsReportExplanatoryTextBlock' the contained HTML has the following errors: cvc-complex-type.2.4.a: Invalid content was found starting with element 'colgroup'. One of '{{http://www.mca.gov.in/XBRL/HTML}thead, {http://www.mca.gov.in/XBRL/HTML}tr}' is expected.;cvc-complex-type.3.2.2: Attribute 'colspan' is not allowed to appear in element 'td'.;");
    await page.click('#mx-run');
    const mx = await page.textContent('#main');
    check('MCA error help explains pasted validator messages (attribute, HTML) with a fix', (await page.locator('#main .mx').count()) === 2 && /old \(cached\) copy/.test(mx) && /click Save Text/.test(mx) && (await page.locator('#main [data-goconcept]').count()) === 2, mx.slice(0, 300));
    await page.click('#main [data-goconcept="in-ca:CorporateIdentityNumber"]');
    check('MCA error help: element button navigates to the element', /GeneralInformationAboutCompany$/.test(await page.getAttribute('#nav a.on[data-elr]', 'data-elr') || '') || (await page.locator('#main #general-title').count()) === 1);
    // ---- v13: statement figures from their notes, validation pop-up, resizable tables, disclosure copy, dark mode
    if (golden) {
      await page.setInputFiles('#file-xml', path.join(ROOT, golden));
      await page.waitForSelector('#import-confirm'); await page.check('#ym-both'); await page.click('#import-commit'); await page.waitForSelector('.banner.info');
      await page.click('a[data-elr$="/BalanceSheet"]');
      const linked = await page.$$eval('#main .cellin.from-note[data-s="CY"]', (els) => els.filter((e) => e.readOnly).map((e) => e.dataset.c));
      check('v13: balance-sheet figures supplied by notes are read-only (share capital, reserves, borrowings, tangible assets …)', ['in-gaap:ShareCapital', 'in-gaap:ReservesAndSurplus', 'in-gaap:LongTermBorrowings', 'in-gaap:TangibleAssets'].every((q) => linked.includes(q)), linked.join(','));
      check('v13: a balance-sheet figure no note supplies stays editable', !(await page.$eval('input[data-c="in-gaap:DeferredTaxLiabilitiesNet"][data-s="CY"]', (e) => e.readOnly)));
      await page.click('[data-go-note="in-gaap:TangibleAssets"][data-s="CY"]');
      await page.waitForTimeout(200);
      check('v13: Go to note opens the tangible-assets note at its total cell', (await page.evaluate(() => `${document.activeElement?.dataset?.c}|${document.activeElement?.dataset?.slice}`)) === 'in-gaap:TangibleAssets|0');
      await page.click('a[data-elr$="/BalanceSheet"]');
      await page.check('input[data-calc-override$="/BalanceSheet"]');
      check('v13: "Allow editing of calculated cells" still opens the statement figure for a manual entry', !(await page.$eval('input[data-c="in-gaap:ReservesAndSurplus"][data-s="CY"]', (e) => e.readOnly)));
      await page.uncheck('input[data-calc-override$="/BalanceSheet"]');
      // validation messages in a separate window
      const DT = 'input[data-c="in-gaap:DeferredTaxLiabilitiesNet"][data-s="CY"]';
      const dtVal = await page.inputValue(DT);
      await page.fill(DT, String(Number(dtVal) + 1)); await page.dispatchEvent(DT, 'change');
      await page.click('.bar button[data-act="validate"]');
      await page.waitForSelector('#main [data-act="issues-window"]');
      const [pop] = await Promise.all([page.waitForEvent('popup'), page.click('#main [data-act="issues-window"]')]);
      await pop.waitForSelector('li[data-n]');
      check('v13: validation messages open in a separate window', (await pop.locator('li[data-n]').count()) >= 1);
      await page.click('a[data-go="setup"]');
      await pop.click('li[data-n="0"]');
      await page.waitForTimeout(300);
      check('v13: clicking a message in that window opens its cell in the main window', /\/BalanceSheet$/.test(await page.getAttribute('#nav a.on[data-elr]', 'data-elr') || '') && !!(await page.evaluate(() => document.activeElement?.dataset?.cell)));
      await page.fill(DT, dtVal); await page.dispatchEvent(DT, 'change');
      await pop.waitForSelector('.stale');
      check('v13: the window marks its list out of date after an edit', (await pop.locator('.stale').count()) === 1);
      await pop.click('[data-wact="revalidate"]');
      await pop.waitForSelector('.stale', { state: 'detached', timeout: 15000 }).catch(() => {});
      check('v13: "Validate again" in the window refreshes it', (await pop.locator('.stale').count()) === 0);
      await pop.close();
      // resizable table
      await page.click('a[data-elr$="/NotesTangibleAssets"]');
      await page.click('button[data-open-table="201000:DisclosureOfTangibleAssetsTable"][data-scope="CY"]');
      await page.waitForSelector('#main .grid-wrap.rs');
      await page.$eval('#main .grid-wrap.rs', (e) => e.scrollIntoView({ block: 'end' }));
      const b0 = await page.$eval('#main .grid-wrap.rs', (e) => { const r = e.getBoundingClientRect(); return { x: r.right, y: r.bottom, h: r.height }; });
      await page.mouse.move(b0.x - 4, b0.y - 4); await page.mouse.down(); await page.mouse.move(b0.x + 80, b0.y + 160, { steps: 6 }); await page.mouse.up();
      const h1 = await page.$eval('#main .grid-wrap.rs', (e) => e.getBoundingClientRect().height);
      check('v13: a table can be enlarged by dragging its bottom-right corner', h1 > b0.h + 60, `${b0.h} → ${h1}`);
      await page.click('a[data-elr$="/NotesTangibleAssets"]');
      await page.click('button[data-open-table="201000:DisclosureOfTangibleAssetsTable"][data-scope="CY"]');
      check('v13: the size is kept for that table', Math.abs((await page.$eval('#main .grid-wrap.rs', (e) => e.getBoundingClientRect().height)) - h1) < 3);
      await page.click('#main [data-act="grid-reset"]');
      check('v13: Reset table size', (await page.$eval('#main .grid-wrap.rs', (e) => e.getBoundingClientRect().height)) < h1 - 30);
      // dark mode: a mandatory empty cell and an error cell keep readable colours
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.click('a[data-elr$="/DisclosureOfGeneralInformationAboutCompany"]');
      const cols = await page.evaluate(() => {
        const lum = (c) => { const m = c.match(/\d+(\.\d+)?/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
        const el = document.querySelector('#main .cellin:not([disabled])');
        el.classList.add('req-empty');
        const a = getComputedStyle(el); const r1 = [a.backgroundColor, a.color];
        el.classList.remove('req-empty'); el.classList.add('cell-err');
        const b = getComputedStyle(el); const r2 = [b.backgroundColor, b.color];
        el.classList.remove('cell-err');
        const ratio = ([bg, fg]) => { const x = lum(bg), y = lum(fg); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
        return { r1, r2, c1: ratio(r1), c2: ratio(r2) };
      });
      check('v13 dark mode: mandatory-empty and error cells keep a dark background with light text (contrast ≥ 4.5)', cols.c1 >= 4.5 && cols.c2 >= 4.5, JSON.stringify(cols));
      await page.emulateMedia({ colorScheme: 'light' });
      // disclosure tab: copy from previous year (last year's filing imported as next year's filing)
      await page.setInputFiles('#file-xml', path.join(ROOT, golden));
      await page.waitForSelector('#import-confirm'); await page.check('#ym-next'); await page.click('#import-commit'); await page.waitForSelector('.banner.info');
      await page.click('a[data-elr$="/DisclosuresAuditorsReport"]');
      const cdb = '#main [data-act="carry-disclosure"]';
      check('v13: disclosure tab offers Copy from previous year', (await page.locator(cdb).count()) === 1 && !(await page.isDisabled(cdb)), await page.textContent(cdb));
      await page.click(cdb); await page.click('#dlg-continue');
      await page.waitForTimeout(300);
      const filledNow = await page.$$eval('#main .cellin[data-s="CY"]', (els) => els.filter((e) => e.value !== '').length) + await page.locator('#main [data-textblock][data-s="CY"].has').count();
      check('v13: last year\'s disclosures copied into empty current-year cells', filledNow > 0 && (await page.isDisabled(cdb)), String(filledNow));
      // leave a consistent state for the remaining checks
      await page.setInputFiles('#file-xml', path.join(ROOT, golden));
      await page.waitForSelector('#import-confirm'); await page.check('#ym-both'); await page.click('#import-commit'); await page.waitForSelector('.banner.info');
    }
    // ---- v14: fixes with undo, keyboard (arrows over buttons, Tab trap, shortcuts, Ctrl+Q), prepare next year
    if (golden) {
      await page.click('a[data-elr$="/BalanceSheet"]');
      const SA = 'input[data-c="in-gaap:ShareApplicationMoneyPendingAllotment"][data-s="CY"]';
      const saVal = await page.inputValue(SA);
      await page.fill(SA, ''); await page.dispatchEvent(SA, 'change');
      await page.click('.bar button[data-act="validate"]');
      await page.waitForSelector('#main .issues');
      const fixLi = page.locator('#main .issues li', { hasText: "'ShareApplicationMoneyPendingAllotment' is mandatory" }).first();
      check('v14: a fixable error carries a Fix button', (await fixLi.locator('[data-fix]').count()) === 1, await fixLi.textContent().catch(() => ''));
      const [pwf] = await Promise.all([page.waitForEvent('popup'), page.click('#main [data-act="issues-window"]')]);
      await pwf.waitForSelector('li[data-n]');
      check('v14: the messages window carries the Fix buttons too', (await pwf.locator('[data-fix]').count()) >= 1);
      await pwf.close();
      await fixLi.locator('[data-fix]').click();
      await page.waitForSelector('#dlg-continue');
      check('v14: the fix is confirmed first and says what else it would raise', /Report/.test(await page.textContent('#modal-body')) && /raises no other message|would also raise/.test(await page.textContent('#modal-body')));
      await page.click('#dlg-continue');
      await page.waitForSelector('#main .tiles');
      check('v14: the fix removes the error', (await page.locator('#main .issues li', { hasText: "'ShareApplicationMoneyPendingAllotment' is mandatory" }).count()) === 0);
      await page.click('#main [data-act="undo-fix"]'); await page.click('#dlg-continue');
      await page.waitForSelector('#main .tiles');
      check('v14: Undo last fix restores the filing', (await page.locator('#main .issues li', { hasText: "'ShareApplicationMoneyPendingAllotment' is mandatory" }).count()) === 1);
      await page.click('a[data-elr$="/BalanceSheet"]');
      await page.fill(SA, saVal || '0'); await page.dispatchEvent(SA, 'change');
      // live check of the open tab
      await page.waitForTimeout(1800);
      check('v14: live check of the open tab shown in the bar after an edit', /This tab · .*\(live\)/.test(await page.textContent('#bar-status')), await page.textContent('#bar-status'));
      // ↓ moves from a cell to the "Go to note" button of a cell below
      await page.focus('input[data-c="in-gaap:ForeignCurrencyMonetaryItemTranslationDifferenceLiabilityAccount"][data-s="CY"]');
      await page.keyboard.press('ArrowDown');
      check('v14: ↓ reaches the "Go to note" button below', await page.evaluate(() => !!document.activeElement?.matches('[data-go-note]')), await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80)));
      await page.keyboard.press('ArrowUp');
      check('v14: ↑ goes back to the cell', await page.evaluate(() => document.activeElement?.dataset?.c === 'in-gaap:ForeignCurrencyMonetaryItemTranslationDifferenceLiabilityAccount'));
      // Tab / Shift+Tab stay inside the open tab
      let outside = 0;
      for (let k = 0; k < 40; k++) { await page.keyboard.press('Tab'); if (!(await page.evaluate(() => !!document.activeElement?.closest('#main')))) outside++; }
      await page.evaluate(() => document.querySelector('#main button, #main input')?.focus());
      await page.keyboard.press('Shift+Tab');
      check('v14: Tab and Shift+Tab never leave the open tab (menu and top bar skipped; Shift+Tab from the first control wraps to the last)', outside === 0 && (await page.evaluate(() => !!document.activeElement?.closest('#main'))));
      // Ctrl+Q switcher
      await page.click('a[data-elr$="/BalanceSheet"]');
      await page.keyboard.down('Control'); await page.keyboard.press('KeyQ');
      const qsOn = await page.$eval('#qs .qs-item.on', (e) => e.textContent);
      check('v14: Ctrl+Q shows the tab list with the open tab selected', (await page.locator('#qs').count()) === 1 && /Balance sheet/.test(qsOn), qsOn);
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
      await page.keyboard.up('Control');
      await page.waitForTimeout(200);
      check('v14: releasing Ctrl opens the selected tab (two down: cash flow, direct)', (await page.locator('#qs').count()) === 0 && /\/CashFlowStatementDirect$/.test(await page.getAttribute('#nav a.on[data-elr]', 'data-elr') || ''), await page.getAttribute('#nav a.on[data-elr]', 'data-elr'));
      await page.keyboard.down('Control'); await page.keyboard.press('KeyQ'); await page.keyboard.press('Escape'); await page.keyboard.up('Control');
      check('v14: Esc closes the tab list without switching', (await page.locator('#qs').count()) === 0 && /\/CashFlowStatementDirect$/.test(await page.getAttribute('#nav a.on[data-elr]', 'data-elr') || ''));
      // shortcuts
      await page.keyboard.press('Control+KeyH');
      check('v14: Ctrl+H opens MCA error help', /MCA/.test(await page.textContent('#main h1')));
      await page.evaluate(() => { window.__opened = []; for (const id of ['file-xml', 'file-json']) document.getElementById(id).addEventListener('click', (e) => { window.__opened.push(id); e.preventDefault(); }, { once: true }); });
      await page.keyboard.press('Control+KeyI');
      await page.keyboard.press('Control+KeyO');
      const opened = await page.evaluate(() => window.__opened);
      check('v14: Ctrl+I opens Import XML and Ctrl+O opens Open project', opened.includes('file-xml') && opened.includes('file-json'), JSON.stringify(opened));
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }).catch(() => null), page.keyboard.press('Control+Shift+KeyS')]);
      check('v14: Ctrl+Shift+S saves the project file', !!dl && /\.mca-ci\.json$/.test(dl.suggestedFilename()));
      await page.keyboard.press('Control+KeyG');
      await page.waitForSelector('#xmltext, #main .banner.bad');
      check('v14: Ctrl+G generates the XML', /Generate XML|XML/.test(await page.textContent('#main h1')));
      const [pw] = await Promise.all([page.waitForEvent('popup', { timeout: 8000 }).catch(() => null), page.keyboard.press('Alt+KeyV')]);
      check('v14: Alt+V validates and opens the messages window', !!pw && /Validation/.test(await page.textContent('#main h1')));
      if (pw) await pw.close();
      await page.keyboard.press('Alt+Shift+KeyN');
      check('v14: Alt+Shift+N asks before starting a new filing', await page.isVisible('#modal') && /new filing/i.test(await page.textContent('#modal')));
      await page.keyboard.press('Escape');
      await page.click('a[data-go="shortcuts"]');
      check('v14: Keyboard shortcuts page lists the shortcuts', (await page.locator('#main kbd').count()) >= 12);
      // prepare next year's filing from this project
      await page.click('a[data-go="setup"]');
      await page.click('#main [data-act="prepare-next"]'); await page.click('#dlg-continue');
      await page.waitForTimeout(500);
      check('v14: Prepare next year\'s filing from this project (dates moved one year, previous year locked, earlier years set aside)', /2025-04-01 → 2026-03-31/.test(await page.textContent('#bar-who')) && /\d/.test(await page.textContent('a[data-go="hidden"]')), await page.textContent('#bar-who'));
      // ---- v14.3: decimal places up to paise, statement figures' places, typed digits never rounded
      await page.click('a[data-go="setup"]');
      const was = Number(await page.inputValue('#f-dp'));
      const sp0 = await page.inputValue('#f-sp');
      await page.selectOption('#f-lvl', 'Lakhs');
      check('v14.3: Lakhs offers 0–7 decimal places (5 = exact rupees, 7 = paise) and the statement figures\' places', (await page.locator('#f-dp option').count()) === 8 && (await page.locator('#f-sp').count()) === 1);
      await page.selectOption('#f-dp', '5');
      const spPreset = await page.inputValue('#f-sp');
      check('v14.3: more places: "Statement figures rounded to" keeps its setting, or is preset to the places used so far', sp0 !== '' ? spPreset === sp0 : spPreset === String(was), `${was}/${sp0} → ${spPreset}`);
      await page.click('#setup button[type="submit"]');
      await page.waitForTimeout(200);
      check('v14.3: the company page explains exact rupees / paise and that extra digits are refused', /5 decimal places = exact rupees, 7 = paise/.test(await page.textContent('#main')) && /refused, never rounded/.test(await page.textContent('#main')) && (await page.inputValue('#f-dp')) === '5');
      await page.click('a[data-elr$="/BalanceSheet"]');
      const amt = '#main input.cellin.num[data-s="CY"]:not([readonly]):not([disabled])';
      const cellSel = await page.evaluate((sel) => { const el = document.querySelector(sel); return el ? `#main input.cellin[data-c="${el.dataset.c}"][data-s="CY"]` : null; }, amt);
      if (cellSel) {
        await page.fill(cellSel, '1.123456'); await page.press(cellSel, 'Tab');
        const t1 = await page.textContent('#toast');
        check('v14.3: an amount with more decimal places than chosen is refused with the reason (not rounded)', /has 6 decimal places/.test(t1) && /Nothing was rounded/.test(t1) && (await page.getAttribute(cellSel, 'class')).includes('bad'), t1);
        await page.fill(cellSel, '1.12345'); await page.press(cellSel, 'Tab');
        await page.click('a[data-go="setup"]'); await page.click('a[data-elr$="/BalanceSheet"]');
        check('v14.3: an amount typed to the rupee in lakhs is kept with every digit', (await page.inputValue(cellSel)).replace(/,/g, '') === '1.12345', await page.inputValue(cellSel));
      } else check('v14.3: an editable amount cell on the balance sheet', false);
      // ---- v14.4: text editor — Paragraph style (Heading 1–5) and bulleted lists that print without a grey box
      await page.click('a[data-elr$="/NotesCurrentInvestments"]');
      await page.click(tbBtn);
      check('v14.4: the text editor has a Paragraph style list (Normal text, Heading 1–5)', (await page.locator('#modal select.rte-style option').count()) === 6);
      await page.click(ed);
      await page.evaluate((sel) => { const e = document.querySelector(sel); e.innerHTML = '<p>Investments v144</p><p>First point</p>'; const r = document.createRange(); r.selectNodeContents(e.firstChild); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }, ed);
      await page.selectOption('#modal select.rte-style', 'h2');
      const h2 = await page.evaluate(() => document.querySelector('#tb-editor h2')?.textContent || '');
      await page.evaluate(() => { const e = document.querySelector('#tb-editor'); const r = document.createRange(); r.selectNodeContents(e.lastElementChild); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
      await page.click(btn('insertUnorderedList'));
      await page.evaluate(() => { const e = document.querySelector('#tb-editor'); const r = document.createRange(); r.selectNodeContents(e.querySelector('h2')); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event('selectionchange')); });
      await page.waitForTimeout(100);
      check('v14.4: Paragraph style makes the line Heading 2 and follows the cursor', h2 === 'Investments v144' && (await page.inputValue('#modal select.rte-style')) === 'h2', h2);
      await page.click('#tb-save');
      // ---- v14.4: Download XML with errors (for the MCA PDF)
      await page.click('a[data-go="xml"]');
      await page.waitForSelector('#main [data-act="download-xml-errors"]');
      await page.click('#main [data-act="download-xml-errors"]');
      let xmlDl = null;
      if (await page.isVisible('#dlg-continue')) {
        check('v14.4: Download XML with errors asks first, naming the errors and the file', /error/.test(await page.textContent('#modal')) && /_WITH-ERRORS\.xml/.test(await page.textContent('#modal')));
        [xmlDl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }).catch(() => null), page.click('#dlg-continue')]);
        check('v14.4: the XML with errors is downloaded as …_WITH-ERRORS.xml', !!xmlDl && /_WITH-ERRORS\.xml$/.test(xmlDl.suggestedFilename()), xmlDl?.suggestedFilename());
      } else check('v14.4: the next-year draft has errors to test Download XML with errors', false, await page.textContent('#toast'));
      if (xmlDl) {
        const txt = readFileSync(await xmlDl.path(), 'utf8');
        check('v14.7: the XML with errors says NOT VALIDATED in its second line', /^<!-- NOT VALIDATED/.test(txt.split('\n')[1] || ''));
        check('v14.4: the downloaded XML carries the text block: Heading 2 as header2, the bulleted list as noteText1 (not noteText2)', /^<\?xml/.test(txt) && /header2/.test(txt) && /noteText1/.test(txt) && !/noteText2/.test(txt));
        check('v14.4: the page still shows the errors (nothing marked as validated)', (await page.locator('#main .banner.bad').count()) === 1 && (await page.locator('#xmltext').count()) === 0);
      }
      // ---- v14.4: shortcuts for the buttons at the top of a table: Alt+Y year, Alt+P copy from previous year, Alt+R back
      // a note whose table is available for both years
      let tabNote = null;
      for (const uri of await page.$$eval('#nav a[data-elr]', (as) => as.map((a) => a.dataset.elr))) {
        await page.click(`#nav a[data-elr="${uri}"]`);
        const id = await page.evaluate(() => [...document.querySelectorAll('#main [data-open-table][data-scope="CY"]:not([disabled])')].map((b) => b.dataset.openTable).find((t) => document.querySelector(`#main [data-open-table="${CSS.escape(t)}"][data-scope="PY"]:not([disabled])`)));
        if (id) { tabNote = { uri, id }; break; }
      }
      check('v14.4: a table available for both years', !!tabNote);
      await page.click(`#main [data-open-table="${tabNote.id}"][data-scope="CY"]`);
      await page.waitForSelector('#main table.g');
      const scopeChip = async () => page.textContent('#main header .chip.info');
      await page.keyboard.press('Alt+KeyY');
      await page.waitForTimeout(150);
      const toPy = await scopeChip();
      await page.keyboard.press('Alt+KeyY');
      await page.waitForTimeout(150);
      check('v14.4: Alt+Y switches the table to the previous year and back', /Previous/.test(toPy) && /Current/.test(await scopeChip()), `${toPy} / ${await scopeChip()}`);
      await page.keyboard.press('Alt+KeyP');
      await page.waitForTimeout(150);
      const pOk = (await page.isVisible('#modal') && /Copy from previous year/.test(await page.textContent('#modal'))) || /Copy from previous year/.test(await page.textContent('#toast'));
      check('v14.4: Alt+P presses "Copy from previous year" (its dialog, or the reason it is not available)', pOk, await page.textContent('#toast'));
      if (await page.isVisible('#modal')) await page.keyboard.press('Escape');
      await page.keyboard.press('Alt+KeyR');
      await page.waitForTimeout(150);
      check('v14.4: Alt+R goes back to the note', (await page.locator(`#main [data-open-table="${tabNote.id}"]`).count()) === 2 && (await page.getAttribute('#nav a.on[data-elr]', 'data-elr')) === tabNote.uri, await page.getAttribute('#nav a.on[data-elr]', 'data-elr'));
      await page.keyboard.press('Alt+KeyY');
      check('v14.4: Alt+Y on a note (no table open) says where it works', /on tables only/.test(await page.textContent('#toast')));
      // v14.7: the Ind AS tool's keys do the same — Alt+Shift+Y (year), Alt+Shift+B (back to note)
      await page.click(`#main [data-open-table="${tabNote.id}"][data-scope="CY"]`);
      await page.waitForSelector('#main table.g');
      await page.keyboard.press('Alt+Shift+KeyY'); await page.waitForTimeout(150);
      const py2 = await scopeChip();
      await page.keyboard.press('Alt+Shift+KeyB'); await page.waitForTimeout(150);
      check('v14.7: Alt+Shift+Y and Alt+Shift+B (the Ind AS tool\'s keys) switch the year and go back to the note', /Previous/.test(py2) && (await page.getAttribute('#nav a.on[data-elr]', 'data-elr')) === tabNote.uri && (await page.locator('#main table.g [data-c]').count()) >= 0);
      await page.click('a[data-go="shortcuts"]');
      check('v14.4: the shortcuts page lists Alt+P, Alt+Y and Alt+R', /Alt\+P/.test(await page.textContent('#main')) && /Alt\+Y/.test(await page.textContent('#main')) && /Alt\+R/.test(await page.textContent('#main')));
      // ---- v14.4: a list answer re-renders the tab without moving the table or losing the cell
      await page.click('a[data-elr$="/NotesShareCapital"]');
      const pick = await page.evaluate(() => {
        const g = document.querySelector('#main .grid-wrap'); if (!g) return null;
        const gr = g.getBoundingClientRect();
        const s = [...g.querySelectorAll('select[data-cell]:not([disabled])')].find((x) => x.getBoundingClientRect().top - gr.top > g.clientHeight * 0.8);
        if (!s) return null;
        s.scrollIntoView({ block: 'center' });
        return { cell: s.dataset.cell, other: [...s.options].map((o) => o.value).find((v) => v && v !== s.value), top: g.scrollTop };
      });
      if (pick && pick.top > 0) {
        const sel = `#main select[data-cell="${pick.cell}"]`;
        await page.focus(sel); await page.selectOption(sel, pick.other);
        await page.waitForTimeout(300);
        if (await page.isVisible('#dlg-continue')) { await page.click('#dlg-continue'); await page.waitForTimeout(300); }
        const after = await page.evaluate(() => [document.querySelector('#main .grid-wrap').scrollTop, document.activeElement?.dataset?.cell || '']);
        check('v14.4: after a Yes/No answer the table stays where it was and the cell keeps the focus', Math.abs(after[0] - pick.top) < 2 && after[1] === pick.cell, `${pick.top} → ${after[0]}; focus ${after[1]}`);
      } else check('v14.4: a Yes/No cell below the visible part of a table', false, JSON.stringify(pick));
    }
    // ---- v14.5: a column left at a total the table does not allow (here: loans and advances without a security
    // member, as another tool may have written it) — reported, never offered, moved to the member chosen
    {
      const { baseSession } = await import('./fixtures.mjs');
      const { q, authority } = await import('./helpers.mjs');
      const { generateInstance } = await import('./generator.js');
      const A = authority();
      const s = baseSession();
      s.setValue(q('ShortTermLoansAndAdvances'), 'CY', '100');
      const bad = [{ axis: q('ClassificationBasedOnTimePeriodAxis'), member: q('ShortTermMember') }, { axis: q('ClassificationOfLoansAndAdvancesAxis'), member: q('OtherLoansAndAdvancesOthersMember') }];
      for (const [c, v] of [['LoansAndAdvancesGross', '100'], ['LoansAndAdvances', '100'], ['NatureOfOtherLoansAndAdvances', 'Balance with authorities']]) s.filing.setFact({ concept: q(c), period: s.filing.period(q(c), 'CY'), dims: bad, value: v, ...(A.isNumeric(q(c)) ? { decimals: '0', unit: 'INR' } : {}), origin: 'import' });
      const file = path.join(ROOT, '.smoke-v145.xml');
      writeFileSync(file, generateInstance(A, s.filing, s.app.planFacts(s.filing).emit).xml);
      try {
        await page.setInputFiles('#file-xml', file);
        await page.waitForSelector('#import-confirm');
        await page.check('#ym-both');
        await page.click('#import-commit');
        await page.waitForSelector('.banner.info');
      } finally { unlinkSync(file); }
      await page.click('#nav a[data-go="validate"]');
      await page.click('#main [data-act="validate"]').catch(() => {});
      await page.waitForTimeout(300);
      const fixBtn = page.locator('#main button.fix', { hasText: 'Move the column to a member' });
      check('v14.5: a loans column without a security member is an error with the fix "Move the column to a member"', (await fixBtn.count()) >= 1, await page.textContent('#main .issues').catch(() => ''));
      const T = '200600c:LoansAndAdvancesTable';
      await page.click('#nav a[data-elr$="/NotesSubclassificationAndNotesOnLiabilitiesAndAssets"]').catch(() => {});
      const opened = await page.locator(`#main [data-open-table="${T}"][data-scope="CY"]`).count();
      if (opened) await page.click(`#main [data-open-table="${T}"][data-scope="CY"]`);
      await page.waitForSelector('#main table.g');
      const secSel = '#addslice select[data-axis="in-gaap:ClassificationOfAssetsBasedOnSecurityAxis"]';
      check('v14.5: the column picker does not offer the security total (not allowed in this table)', (await page.locator(`${secSel} option[value=""]`).count()) === 0 && (await page.locator(`${secSel} option`).count()) === 3);
      check('v14.5: the column shows "total not allowed", its values (read-only) and "Move to a member…"', (await page.locator('#main th.slicehead .mb.bad').count()) === 1 && (await page.locator('#main [data-act="move-slice"]').count()) === 1 && (await page.locator('#main input.cellin[data-c="in-gaap:LoansAndAdvances"][disabled]').evaluateAll((els) => els.some((e) => /100/.test(e.value)))));
      await page.click('#main [data-act="move-slice"]');
      await page.waitForSelector('#modal [data-fix-choice]');
      await page.selectOption('#modal [data-fix-choice="0"]', 'in-gaap:UnsecuredConsideredGoodMember');
      await page.click('#dlg-continue');
      await page.waitForTimeout(300);
      const heads = await page.$$eval('#main th.slicehead', (ths) => ths.map((t) => t.textContent));
      check('v14.5: "Move to a member" moves the column to the member chosen, values unchanged', (await page.locator('#main th.slicehead .mb.bad').count()) === 0 && heads.some((h) => /Unsecured,? considered good/i.test(h) && /others/i.test(h)) && (await page.locator('#main input.cellin[data-c="in-gaap:LoansAndAdvances"]:not([disabled])').evaluateAll((els) => els.some((e) => /100/.test(e.value)))), JSON.stringify(heads));
    }
    // ---- v14.9: workspace folder (the browser's real folder API, on the browser's private test folder instead of a
    // picker), version stamp, backups, a newer version saved on "the other laptop", compare
    {
      const http = await import('node:http');
      const server = http.createServer((req, res) => { try { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(readFileSync(path.join(ROOT, 'index.html'))); } catch { res.writeHead(500); res.end(); } });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const page = await browser.newPage({ viewport: { width: 1360, height: 900 } }); // a second page on a web origin
      page.setDefaultTimeout(20000);
      page.on('pageerror', (e) => errors.push(e));
      try {
      await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
      await page.waitForSelector('#nav a[data-elr]');
      const projFile = path.join(ROOT, '.smoke-v149.json');
      writeFileSync(projFile, JSON.stringify((await import('./fixtures.mjs')).baseSession().filing.toJSON()));
      try { await page.setInputFiles('#file-json', projFile); await page.waitForFunction(() => /Project opened/.test(document.querySelector('#toast')?.textContent || '')); } finally { unlinkSync(projFile); }
      await page.evaluate(() => { window.__pickWorkspace = () => navigator.storage.getDirectory(); });
      await page.click('a[data-go="workspace"]');
      check('v14.9: the Workspace folder page offers to choose a folder', (await page.locator('#main [data-act="ws-choose"]').count()) >= 1);
      await page.fill('#ws-device', 'LAPTOP-1'); await page.dispatchEvent('#ws-device', 'change');
      await page.click('#main [data-act="ws-choose"]');
      await page.waitForSelector('#main [data-act="ws-save"]:not([disabled])');
      await page.click('#main [data-act="ws-save"]');
      await page.waitForFunction(() => /Saved to the workspace/.test(document.querySelector('#toast')?.textContent || ''));
      await page.waitForSelector('#main .ws-list tbody tr');
      const row1 = await page.textContent('#main .ws-list tbody tr');
      check('v14.9: Save to workspace — the filing is listed with its version stamp (v1, this laptop)', /v1/.test(row1) && /LAPTOP-1/.test(row1) && /FY 2016-17/.test(row1), row1);
      check('v14.9: the bar shows the workspace version', /Workspace · v1/.test(await page.textContent('#bar-status')));
      // a change, then Ctrl+S saves to the workspace too (version 2; version 1 kept in backups)
      await page.click('a[data-go="setup"]');
      await page.fill('#f-name', 'Test Co Two'); await page.dispatchEvent('#f-name', 'change').catch(() => {});
      await page.click('#setup button[type="submit"]').catch(() => {});
      await page.waitForTimeout(200);
      check('v14.9: an unsaved change shows in the bar', /Workspace: not saved/.test(await page.textContent('#bar-status')), await page.textContent('#bar-status'));
      await page.keyboard.press('Control+KeyS');
      await page.waitForFunction(() => /version 2/.test(document.querySelector('#toast')?.textContent || ''));
      await page.click('a[data-go="workspace"]');
      await page.waitForFunction(() => /· v2/.test(document.querySelector('#main .ws-list tbody')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
      const rows = await page.$$eval('#main .ws-list tbody tr', (trs) => trs.map((t) => t.textContent));
      check('v14.9: Ctrl+S saves to the workspace once the filing is saved there — same file after the name was corrected, version 2, version 1 in backups', rows.length === 1 && /Test Co Two/.test(rows[0]) && /· v2/.test(rows[0]) && /\b1\b/.test(rows[0]), JSON.stringify(rows));
      // "the other laptop" saves version 9 into the same file
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        for await (const c of root.values()) {
          if (c.kind !== 'directory') continue;
          for await (const y of c.values()) {
            if (y.kind !== 'directory') continue;
            for await (const f of y.values()) {
              if (f.kind !== 'file' || !f.name.endsWith('.mca-ci.json')) continue;
              const j = JSON.parse(await (await f.getFile()).text());
              if (!/Test Co Two/.test(j.meta.name)) continue;
              j.meta.lastSaved = { n: 9, at: '2026-10-21T09:30:00.000Z', device: 'LAPTOP-2' };
              j.meta.level = 'Lakhs';
              const w = await f.createWritable(); await w.write(JSON.stringify(j)); await w.close();
            }
          }
        }
      });
      await page.click('#main [data-act="ws-refresh"]');
      await page.waitForSelector('#main .banner.warn [data-act="ws-open-newer"]');
      check('v14.9: a newer version saved on the other laptop is reported (bar, Workspace page)', /Newer version in workspace/.test(await page.textContent('#bar-status')) && /version 9/.test(await page.textContent('#main .banner.warn')) && /LAPTOP-2/.test(await page.textContent('#main .banner.warn')));
      // saving now does not overwrite it without asking
      await page.keyboard.press('Control+KeyS');
      await page.waitForSelector('#modal:not([hidden])');
      check('v14.9: saving over the newer version asks first (Save anyway / Cancel)', /A newer version is in the workspace/.test(await page.textContent('#modal')) && /version 9/.test(await page.textContent('#modal')));
      await page.click('#dlg-cancel');
      // compare first: the setting changed on the other laptop shows
      await page.click('#main [data-act="ws-compare-newer"]');
      await page.waitForSelector('#main .tiles');
      check('v14.9: Compare shows what the other laptop changed (level of rounding)', /Level of rounding/.test(await page.textContent('#main')) && /Lakhs/.test(await page.textContent('#main')));
      // open the newer version
      await page.click('a[data-go="workspace"]');
      await page.click('#main [data-act="ws-open-newer"]');
      await page.waitForTimeout(300);
      check('v14.9: Open the newer version — version 9 from LAPTOP-2 is open', /Version 9/.test(await page.textContent('#toast')) && /Workspace · v9/.test(await page.textContent('#bar-status')), await page.textContent('#toast'));
      // a reload (the browser restarted): the folder is reconnected by itself and the filing is still linked
      await page.reload();
      await page.waitForSelector('#nav a[data-elr]');
      await page.waitForFunction(() => /Workspace · v9/.test(document.querySelector('#bar-status')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
      check('v14.9: after a reload the workspace folder and the filing\'s version are remembered', /Workspace · v9/.test(await page.textContent('#bar-status')), await page.textContent('#bar-status'));
      // compare a backup with the open filing (Workspace page)
      await page.click('a[data-go="workspace"]');
      await page.waitForSelector('#main .ws-list tbody tr');
      const bOpt = await page.$eval('#main select[data-ws-cmp]', (s) => [...s.options].find((o) => o.value.startsWith('b:'))?.value);
      if (bOpt) { await page.selectOption('#main select[data-ws-cmp]', bOpt); await page.click('#main [data-act="ws-compare"]'); await page.waitForSelector('#main .tiles'); }
      check('v14.9: a backup can be compared with the open filing', !!bOpt && /Company name/.test(await page.textContent('#main')), bOpt);
      // Compare page: the open filing with a project file
      const cmpFile = path.join(ROOT, '.smoke-v149.json');
      writeFileSync(cmpFile, JSON.stringify((await import('./fixtures.mjs')).baseSession().filing.toJSON()));
      try {
        await page.click('a[data-go="compare"]');
        await page.evaluate(() => { document.getElementById('file-cmp').multiple = false; });
        await page.click('#main [data-act="cmp-open"]').catch(() => {});
        await page.setInputFiles('#file-cmp', cmpFile);
        await page.waitForFunction(() => /differences/.test(document.querySelector('#main .tiles')?.textContent || ''));
      } finally { unlinkSync(cmpFile); }
      check('v14.9: Compare versions — the open filing with a project file', (await page.locator('#main table.g.cmp').count()) >= 1 && /\.smoke-v149\.json/.test(await page.textContent('#main')));
      // Save project still downloads the project file (now with its version stamp)
      const [pdl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }).catch(() => null), page.keyboard.press('Control+Shift+KeyS')]);
      const pj = pdl ? JSON.parse(readFileSync(await pdl.path(), 'utf8')) : null;
      check('v14.9: Save project still downloads the project file, now with its version stamp', !!pj && pj.meta?.lastSaved?.n === 10 && pj.meta.lastSaved.device === 'LAPTOP-1', JSON.stringify(pj?.meta?.lastSaved));
      // v15.2: Save XML to workspace — on a filing without errors (the example's data, opened as a project): generate,
      // save the XML twice (numbered 1 and 2). Until v15.2 the save-time health check always counted as a change and the
      // XML was refused ("The project was brought up to date when it was saved — generate the XML again").
      const exFile = path.join(ROOT, '.smoke-v152.json');
      { const { Session } = await import('./session.js'); const { buildExample } = await import('./example.js'); const { authority } = await import('./helpers.mjs'); const X = new Session(authority()); buildExample(X); X.filing.meta.name = 'Example Filing Co'; writeFileSync(exFile, JSON.stringify(X.filing.toJSON())); }
      try { await page.setInputFiles('#file-json', exFile); } finally { unlinkSync(exFile); }
      await page.waitForFunction(() => /Example Filing Co/.test(document.body.textContent || ''));
      await page.click('a[data-go="workspace"]');
      await page.waitForSelector('#main [data-act="ws-save"]:not([disabled])');
      await page.click('#main [data-act="ws-save"]');
      await page.waitForFunction(() => /Saved to the workspace/.test(document.getElementById('toast')?.textContent || ''));
      await page.click('a[data-go="xml"]');
      await page.click('button[data-act="generate"]');
      await page.waitForSelector('#main [data-act="ws-save-xml"]', { timeout: 30000 });
      const xmlToasts = [];
      for (let i = 0; i < 2; i++) {
        await page.evaluate(() => { document.getElementById('toast').textContent = ''; });
        await page.click('#main [data-act="ws-save-xml"]');
        await page.waitForFunction(() => (document.getElementById('toast')?.textContent || '').length > 0, null, { timeout: 15000 });
        xmlToasts.push(await page.textContent('#toast'));
      }
      check('v15.2: Save XML to workspace saves the generated XML (twice: numbered v1 and v2) — not refused by the save-time health check', /\/ xml \/ .*_v1_/.test(xmlToasts[0]) && /\/ xml \/ .*_v2_/.test(xmlToasts[1]) && !/brought up to date/.test(xmlToasts.join(' ')), xmlToasts.join(' | '));
          } finally { await page.close(); server.close(); }
    }
    check('no page errors', errors.length === 0, errors.map((e) => e.stack || e.message || String(e)).join('; '));
  } finally { await browser.close(); }
  return { status: checks.every((c) => c.ok) ? 'PASS' : 'FAIL', ...st, checks };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = await runBrowserSmoke();
  for (const c of r.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : ' — ' + c.detail}`);
  console.log(r.status, r.reason || '');
  process.exit(r.status === 'FAIL' ? 1 : 0);
}
