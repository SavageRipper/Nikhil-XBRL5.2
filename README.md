# MCA C&I XBRL Studio

Local-first, browser-based preparation of MCA C&I 2016 XBRL instance documents. Taxonomy, dimensions,
calculations and business rules are compiled from the MCA authority files in this repository.

**Open the app:** `index.html` (GitHub Pages serves it at the site root). It is the built app — rebuild with `npm run build` after changing any source file and commit the new `index.html`.

Flat repository: every file sits at the root (no folders to create when uploading).

## v15.2 — Save XML to workspace

Reported: *Save XML to workspace* always answered "The project was brought up to date when it was saved — generate the
XML again, then save it", however often the XML was generated again. The health check run on every save counted
"nothing to move to Hidden data" as a change of the project, and the XML was refused as possibly out of date. Now a
health check that changes nothing leaves the project as it is; when it does change something (once, e.g. a project from
an earlier version), the message still asks to generate the XML again — and the next save works.

Changed: `upkeep.js`. Browser smoke: +1 check (generate, then *Save XML to workspace* twice — xml v1 and v2), which
fails on v15.1. Nothing else changes: XML, validation and projects as in v15.1.

## v15.1 — validation matched to the MCA XBRL Validator on a third MCA-accepted filing

Reported: a filing validated by the tool gave 3 errors the MCA XBRL Validator V5.1 did not, and the validator gave 4
errors the tool did not. The company's previous filing (FY 2024-25, accepted by MCA) gave **357** errors in the tool.
Both files are now local reference cases (`golden-FILING-C_2024-25.xml`: 0 errors; `validator-FILING-C_2025-26.xml`:
exactly the validator's errors) — like the other reference instances they are not part of the package.

Errors the tool raised and MCA does not:
- **SR-L3762-2 / SR-L3851-2** (all details of at least one director): "all details" now means the elements MCA's
  mandatory-line-items sheet names for the table — "All elements mandatory except MiddleNameOfDirector and
  LastNameOfDirector" (ML-35 / ML-38; ML-34 for the auditors table). A director without a middle name is complete.
- **GR-3** (parent member): a child member reported with 0 needs no parent member (as GR-1, "applicable only if amount
  entered is not zero"); a parent reported without one of the child's extra splits counts (Buildings with Gross
  carrying amount, for Factory building with Gross carrying amount and Owned assets).
- **SR-L938-1 / SR-L1482-1 …** ("Nature of other …" mandatory for the "others" member): checked as the validator does —
  on every duration context of the member that carries values; amounts at a balance date alone do not require it.
- **SR-L4140-1** (firm registration number of a secretarial audit firm) and the board-approval date of **ML-41**: not
  enforced by MCA (two filings) — now warnings (`golden-DIVERGENCES.json`, which can now also name single elements of a
  mandatory-line-items rule; the rule stays blocking for its other elements).

Errors MCA raises and the tool did not:
- **NameOfShareholder for the previous year** in the top-ten shareholders table of the board report (GR-12): the screen
  already closed these cells, but the XML and the importer decided by the element (open in the 5% shareholders table).
  They now decide per table, as the screen: such values are left out of the XML (warning "Not applicable — excluded from
  XML") and are not taken over by an import.
- **SR-L1482-1** on a context with useful lives / amortisation method but no nature (see above).
- **SR-L3472-1**: the DIN is required for a Managing / Whole Time / Independent / Other Non Executive Director (the name
  check against the DIN register stays with MCA).
- **SR-L3613-2**: the amount spent on CSR must equal the total of the CSR spending table — an empty table totals 0. The
  table is "mandatory only if Yes"; under "No" it stays open (not mandatory) while an amount spent is reported.

Also: an imported value with content under the other Yes/No answer (secretarial-audit remarks under "not qualified", a
written CSR policy under "CSR not applicable") is the filer's filed content and is kept; values typed in the tool under
the other answer, and empty / 0 / No values, are handled as before.

Unchanged: the XML of both earlier reference instances and of the example filing (byte-identical), every other user
filing (identical errors and warnings, checked side by side with v15.0). Tests: `v151.test.mjs` (10 of 11 fail on
v15.0), the reference suite on the third filing.

## v15.0 — calculated totals rounded as the statements present them

Reported: with *Decimal places as presented* 3 and *Statement figures rounded to* 2 (lakhs), a share capital of 412.356
gave *Total shareholders' funds* 3,283.396 and *Total equity and liabilities* 8,299.706, where the balance sheet shows
3,283.40 and 8,299.71 — and *Total equity and liabilities* then differed from *Total assets* (8,299.71) by 0.004 lakhs
(SR-L28-1). The tool added totals up with every digit of the exact sum. The Ind AS tool (v1.5) rounds them.

- **A calculated total is rounded to the accuracy of its least accurate part**, never to fewer places than *Statement
  figures rounded to*: 412.356 + 2,871.04 = 3,283.40 (accurate to ₹1,000, as the 2-place figures it adds). The XML stays
  consistent (XBRL calculation: the parts' sum rounded to the total's accuracy equals the total) and its digits below
  that accuracy are 0 (Filing Manual #13).
- **Unchanged**: share capital keeps its actual value (412.356), also when it is taken from its note with a class still
  declared coarser (that class keeps its warning and *Confirm as the actual value*). A total whose parts are all as
  accurate as its own digits is not rounded; *Statement figures rounded to* = 3 (or *Same as presented*) keeps 3,283.396;
  a part that is 0 never makes a total coarser; figures imported as exact (`decimals="INF"`, e.g. amounts with paise)
  keep their digits in totals. Entered, imported and overridden figures are never changed.
- **Your project files**: on opening a project saved with an earlier version, the health check re-derives the totals the
  tool calculated (the message names them) — e.g. 3,283.396 → 3,283.40, 8,299.706 → 8,299.71; SR-L28-1 goes.
- **An XML generated with an earlier version and imported**: its totals are imported figures and are kept as they are;
  Validation → Fix tools → **Recalculate current year** rounds them. For the previous year, open the project file
  instead (or type the rounded total).

Changed: `session.js` (`sumDecimals`, `roundToDecimals`), `model.js` (`statementDecimals`), `gate.js` (the share-capital
element list exported). The XML of both reference instances (all three import modes), of the example filing and of a
user's filing is byte-identical to v14.9. Tests: `v150.test.mjs` (5 of its 8 tests fail on v14.9; 3 guard what must not
change).

## v14.9 — workspace folder, automatic backups, compare versions, version stamp

For working on the same filings on two laptops (e.g. with Google Drive for desktop, which keeps a folder the same on
both). Chrome or Edge on a computer; elsewhere *Open project* / *Save project* work as before.

- **Workspace folder** (menu → *Workspace folder*): choose one folder once on each laptop — e.g. `G:\My Drive\XBRL`.
  *Save to workspace* puts the filing in `<Company> (<CIN>) / FY 2025-26 / <COMPANY>_2025-26_Standalone.mca-ci.json`;
  afterwards **Ctrl+S** saves it there too (and in the browser, as always). The page lists every filing in the folder —
  company, year, report, last saved (when, on which laptop, version), number of XML files and backups — with **Open**.
  A corrected company name keeps the file; another year (e.g. *Prepare next year's filing*), report type or CIN is saved
  as a separate filing. The browser remembers the folder; after a restart it may ask once to allow access again.
- **Automatic backups**: each save keeps the version it replaces in `backups` (the last 10).
- **Version stamp**: every save — to the workspace or *Save project* (download) — records when, on which laptop (name it
  on the Workspace folder page) and the version number; shown on the company page and in the bar
  (*Workspace · v7*, *Workspace: not saved*).
- **The other laptop saved a newer version**: when the folder holds a newer version than the one opened here, the bar
  and the Workspace page say so (version, time, laptop) with *Open the newer version*, *Compare first* or *Keep this
  one*; a save never overwrites it without asking (*Save anyway* keeps it in backups).
- **Save XML to workspace** (Generate XML page): the XML goes to the filing's `xml` folder, numbered
  (`<CIN>_Standalone_2026-03-31_v3_2026-10-20.xml`), and the project it was generated from is kept with it in `backups`.
- **Compare versions** (menu): the open filing with a project or XML file, or two files — values, text blocks
  (formatting-only changes shown as such), dates, table columns, settings, footnotes; *Go* opens a cell of the open
  filing. On the Workspace page any saved version, backup or XML of a filing can be compared with the open filing.
- Unchanged: *Save project* still downloads the project file (now with its version stamp); *Open project*, import, the
  XML and the validation are as before.

New: `workspace.js`, `compare.js`. Changed: `app.js`, `shell.html`, `styles.css`. The XML of both reference
instances, of the example filing and of a user's filing is byte-identical to v14.8. Tests: `v149.test.mjs` (folder
logic on an in-memory folder); browser smoke +14 checks on the browser's real folder API (saving, Ctrl+S, backups, a
newer version from the other laptop, reload, compare, Save project).

## v14.8 — the current year first in the XML (AOC-4 XBRL: "Mismatch in financial year")

An XML accepted by the MCA XBRL Validator was refused by the AOC-4 XBRL form: *"Mismatch in financial year (to which
financial statements relates) in Form and instance document attached"*, although its dates were right (current year
01-04-2025 to 31-03-2026, previous year 01-04-2024 to 31-03-2025, every date in the XBRL format yyyy-mm-dd). The
contexts were written in order of their ids, so the **previous year came first** (`D2025` = 2024-25 before `D2026` =
2025-26), and so did its `DateOfStartOfReportingPeriod` / `DateOfEndOfReportingPeriod` facts. Both MCA-filed reference
instances list the current year first.

- Contexts: current year, previous year, the previous year's opening date, other dates (within a year, those without
  dimensions first).
- Facts: for each element the current-year fact before the previous-year fact.
- Only the order changes: every fact, value, context and footnote is the same (checked on both reference instances, the
  example filing and a user's filing: same facts, Arelle valid). The MCA XBRL Validator does not depend on the order.

Changed: `generator.js`. Tests: `v148.test.mjs`.

## v14.7 — footnotes in the text editor; the Ind AS tool v1.6 refinements

- **Footnotes are written with the text editor** — the same editor as text blocks: toolbar, Paragraph style (Heading
  1–5), lists, indentation, tables, Tidy and the "In the MCA PDF" status line; pasting from Word is tidied the same way.
  - *Alt+N* / *Footnote…* (new footnote) and **Edit text…** on the Footnotes page (existing footnote) open it;
    **Ctrl+Enter** saves.
  - The footnote is saved in the MCA HTML subset and written to the XML as its text (escaped), as the MCA-validated
    reference instance carries its footnotes (`&lt;span&gt;…`); the MCA PDF prints such footnotes as formatted text.
  - Footnotes of older projects (plain text) are unchanged until edited; an empty footnote is refused.
  - The printable preview shows a formatted footnote formatted.
- **From the Ind AS tool v1.6** (which took v14.4's features and refined three of them):
  - an XML downloaded *with errors* says so in its second line:
    `<!-- NOT VALIDATED: generated with n unresolved internal validation error(s), … Do not file. -->`;
  - after a Yes/No or list answer the cell also stays at its place on the screen when the answer adds or removes rows
    above it;
  - the Ind AS tool's keys work here too: **Alt+Shift+C** (Copy from previous year), **Alt+Shift+Y** (previous / current
    year), **Alt+Shift+B** (Back to note) — besides Alt+P / Alt+Y / Alt+R.
  - Not needed here: its taxonomy update (the Ind AS SRN pattern — done in v14.4 — and the biological-assets
    roll-forward, which exists only in the Ind AS taxonomy).

Changed: `app.js`, `footnotes.js`, `pdf-preview.js`, `gate.js` (the comment line). The XML of both reference instances,
of the example filing and of a user project is byte-identical to v14.6. Tests: `v147.test.mjs`;
`xml-errors-v144.test.mjs` expects the comment; browser smoke +6 checks.

## v14.6 — schema reference: the V3 address the MCA Validator requires

The MCA XBRL Validator now refuses the old address: *"Incorrect schema reference. Please use new schema URL:
https://www.mca.gov.in/V3XBRL/ instead of V2 Schema URL: http://www.mca.gov.in/XBRL/ in all taxonomies"*. The tool
wrote the V2 address that Filing Manual v4.0 §1.3.1(1) prescribes for every filing **entered from scratch**; only a
filing started by importing an MCA-validated instance carried the V3 address of that instance.

- Every XML is now written with `https://www.mca.gov.in/V3XBRL/2016/07/26/Taxonomy/CnI/in-ci-ent-2016-03-31.xsd`;
  the V2 address is no longer accepted.
- An instance imported with the V2 address: a warning on import; written with V3.
- A project saved with the V2 address: the health check sets V3 when it is opened or saved (reported in the
  message); otherwise Validation reports it with the fix **Use the V3 schema reference**.
- Nothing else changes: the XML of both reference instances is byte-identical to v14.5; the example filing differs only
  in its schema reference. The Ind AS tool already writes the V3 address.

Changed: `compile.mjs`, `upkeep.js`, `fixes.js`, `importer.js`, `app.js`, `model.js` (comment). Tests: `v146.test.mjs`;
`io.test.mjs` and `taxonomy.test.mjs` expect the V3 address.

## v14.5 — totals the taxonomy does not allow; auditor's report clauses under one member

- **A total that the MCA taxonomy marks "not usable" is never used.** In 13 tables the total of an axis is marked
  `usable="false"`: the time period and the secured / unsecured split of borrowings, the time period and the security
  classification of loans and advances, the shareholder of the >5% shareholders table, segments, top-10 shareholders,
  the auditor's-report remark, and others. Under XBRL Dimensions 1.0 such a total is not a valid value: the MCA
  Validator rejects the column as *dimensionally invalid* (confirmed with Arelle). Before v14.5 the tool offered it
  as "(default … — total)" and passed it. Now:
  - the column picker offers only real members for such an axis; a value in such a column is refused, with the reason;
  - a column of this kind in an imported instance or a saved project is reported at its column (the heading shows
    **total not allowed** and its values read-only), with **Move to a member…** in the heading and the fix **Move the
    column to a member** in Validation: choose the member (e.g. *Unsecured, considered good*); every value of the
    column moves there unchanged (refused if that column already has a value);
  - a previous-year column of this kind is not copied by "Copy from previous year";
  - GR-15 ("…complied by using default member, if applicable") treats such a total as not applicable.
- **MCA sum rules now add up over such an axis.** SR-L632-1/2 (long-term / short-term borrowings = Σ classification of
  borrowings) and SR-L936-1 (loans and advances) only summed columns without a secured / unsecured or security
  member — which a valid filing never has — so they never checked anything. They now add up across those members;
  both MCA-validated reference instances pass them.
- **[400200] auditor's report (CARO): each mandatory clause once, under any one member.** ML-39 lists 16 mandatory
  clauses and SR-L3717-1 allows a clause under one member only (favourable, unfavourable, disclaimer or clause not
  applicable). The tool asked for all 16 clauses in every member column — a clause moved to *Unfavourable* raised
  errors that could not be resolved. Now a clause is required once: the other columns are not marked and not
  reported; a clause given under no member is reported once at its row. A clause given under two members (SR-L3717-1)
  has the fix **Keep it under one member** (choose which).

Changed: `dimensions.js` (default member must be usable; `unusableDefaultAxes`), `expr.js` (sums over such axes),
`rules.js` (ML for one-member tables, SR-L3717-1 location, GR-15), `mandatory-marks.js`, `session.js`
(`moveSliceToMembers`, message), `fixes.js` (two fixes; a fix may ask for a choice), `carry-forward.js`, `app.js`,
`styles.css`. The XML of both reference instances and of the example filing, and the project files, are byte-identical
to v14.4. Tests: `v145.test.mjs`; nine older tests corrected (they wrote borrowings / loans columns without the
secured / unsecured or security member — data the MCA Validator rejects); browser smoke +4 checks.

## v14.4 — SRN of MCA V3 forms, text editor from the Ind AS tool, XML with errors for the MCA PDF, shortcuts

- **SRN in the MCA V3 format (two letters + seven digits, e.g. `AB1234567`)** is accepted for *SRN of form ADT-1* and
  *SRN of filing of balance sheet by subsidiary*. The C&I taxonomy that the MCA XBRL Validator downloads before it
  validates (`Taxonomy-2016-03-31.zip`, kept as supplied) carries this update; the package published on the MCA website
  (`Final_C_and_I_Taxonomy_2016_V1.2.zip`) does not yet. Compared file by file, the only difference in the C&I
  taxonomy is a second `xsd:pattern` on the type `in-ca-types:SRNNumber`
  (`IN-CA/in-ca-types-2016-03-31.xsd`); the validator's copy also carries the standard XBRL 2.1 / Dimensions / XLink
  specification schemas (not part of the C&I taxonomy, not used) and has no `Taxonomy-2016-03-31.xlsx`. The
  published package is extracted as before; files it shares with the validator's copy are taken from the validator's
  copy (`taxonomy-source.mjs`). XML Schema treats several patterns as alternatives, so the compiler now combines them
  (`dts.mjs`; only this type has more than one). The old format (`Z99999999`, one letter + eight digits) stays valid.
  Arelle — the open-source checker used in the tests — checks only the first of several patterns (its own source says
  so); a value matching another pattern of the type is therefore not counted as an error (`xsd-validate.mjs`).
- **Text editor (from the Ind AS tool v1.5.3)**: a *Paragraph style* list (Normal text, Heading 1–5) for the line at the
  cursor; bulleted lists are saved as `noteText1` (normal text, indented) instead of `noteText2`, which the MCA PDF
  prints bold in a grey box with a dotted border — existing text blocks are changed by the health check on opening
  (class only, text unchanged); the text of a merged table cell (colspan) goes into the column that holds the table's
  text, so the MCA PDF does not cut the table off at the right edge; **Tidy** keeps the heading levels chosen and lines up
  long texts of tables whose merged cells were already flattened; the status line warns about tables with long text in
  three or more columns. Not taken over: writing single-paragraph table cells without `<p>` (an Ind AS-only choice).
- **Download XML with errors (for the MCA PDF)** on the Generate XML page: the XML of a draft whose errors are not yet
  resolved, so that the MCA tool can produce its PDF. It asks first, names the number of errors and saves
  `…_WITH-ERRORS.xml`; the facts are exactly those a clean run writes; the page keeps showing the errors and nothing is
  marked validated. *Validate and generate* is unchanged and still blocks on any error.
- **Shortcuts**: **Alt+P** Copy from previous year, **Alt+Y** Switch to previous / current year, **Alt+R** Back to note —
  each presses the button at the top of the open table (or disclosure tab), after saving a value being typed; where the
  button is not available the reason is shown.
- **A Yes/No or list answer no longer moves the screen**: the tab is re-rendered with the table box at the same scroll
  position and the focus back on the same cell (also after the "Change answer?" dialog).

Changed: `taxonomy-source.mjs`, `dts.mjs`, `compile.mjs` (provenance of the validator's copy), `xsd-validate.mjs`,
`richtext.js`, `upkeep.js`, `gate.js` (`exportXml` option `allowErrors`), `app.js`, `styles.css`. The rule engine and
every MCA rule are unchanged; the XML of both reference instances and of the example filing is byte-identical to v14.3.
Tests: `srn-v144.test.mjs`, `richtext-v144.test.mjs`, `xml-errors-v144.test.mjs`; browser smoke +14 checks.

## v14.3 — amounts carry their actual values (MCA: "actual values for all the fields including share capital")

The MCA XBRL Validator asks that the XML carries the actual values — share capital in particular — and says the level of
rounding is for the PDF presentation only; a rounded share capital may route the form to BO processing. Before v14.3 an
amount could only be typed with 0–3 decimal places of the level of rounding (in lakhs: to the nearest ₹100 at best), and
digits beyond the chosen places were rounded without a word (1.005 lakhs with 2 places became ₹1,01,000).

- **Decimal places up to paise** (company page): Thousands 0–5, Lakhs 0–7, Millions 0–8, Crores 0–9, Actual 0–2 — in
  lakhs 5 places = exact rupees, 7 = paise. A filing's own setting is always offered.
- **Typed digits are never rounded**: an amount typed with more decimal places than chosen is refused with the reason
  and nothing is saved ("'12.52365' has 5 decimal places; this filing takes amounts in Lakhs with up to 4 … 5 places =
  exact rupees"). Trailing zeros lose nothing and are accepted.
- **Statement figures rounded to** (company page, from the Ind AS tool): the places most statement figures are presented
  with. Each typed amount is declared in the XML at the accuracy actually typed, never coarser than this: 45.26 lakhs →
  `decimals="-3"` (₹1,000), share capital 12.52365 → `decimals="0"` (the rupee), 100.00000 → the rupee. Choosing more
  places presets it to the places used so far. Set from the imported XML (the accuracy most of its amounts carry);
  "Same as presented" (projects saved before v14.3) keeps the v14.2 rule.
- **Share capital check** (Validation, warning — not blocking): a current-year share capital amount (share capital,
  value of shares authorised / issued / subscribed / called / paid-up) declared coarser than the rupee is listed with its
  cell, under a banner and a *share capital* filter; **Fix: Confirm as the actual value** declares it accurate to the
  rupee (value unchanged; available once enough decimal places are chosen) — or type the exact figure.
- An imported figure retyped with more digits becomes finer, never coarser.

Changed: `model.js` (strict entry, typed accuracy, `statementPlaces`), `session.js` (passes `strict`), `importer.js`
(infers `statementPlaces`), `gate.js` (share capital warning), `fixes.js` (its fix), `app.js` (company page, validation
banner, strict entry from the screen), `assurance.mjs` (re-key through the strict entry). The rule engine, taxonomy,
generator and every MCA rule are unchanged; the XML of both reference instances is byte-identical.
Tests: `decimals-v143.test.mjs`; browser smoke +5 checks.

## v14.2 — dates are typed day first (dd-mm-yyyy) in every browser

Date cells used the browser's own date field, which shows and reads dates in the order of the **browser's language**:
in a browser set to English (United States) the field is mm/dd/yyyy, so typing 05 09 2026 for 5 September 2026
stored **9 May 2026** (2026-05-09); the MCA PDF then correctly printed that date as 09/05/2026. The same keystrokes
in a browser set to English (India / UK) stored 5 September. The XML (xs:date, yyyy-mm-dd) and the MCA PDF
(dd/mm/yyyy) were never wrong — the entry was.

- Every date cell and the period dates on the company page are now **dd-mm-yyyy text fields**, the same in every
  browser: `05-09-2026`, `5/9/2026`, `05.09.2026` and `05092026` all mean 5 September 2026; `yyyy-mm-dd` is accepted
  as it is. An impossible date (31-02-2026, month 13) is refused with a day-first hint.
- After entry the date is confirmed in words ("Date entered: 5 September 2026") and shown in the cell's tooltip.
- 📅 next to the field opens the browser's calendar; the picked date is entered day first.
- Dates already in a project are not changed — check dates entered with an earlier version (see the tooltip).

Changed: `dates.js` (new), `app.js` (date fields), `styles.css`. Tests: `dates.test.mjs`; browser smoke +4 checks.

## v14.1 — text blocks print tidily in the MCA PDF

Text copied from Word printed untidily in the PDF made by the MCA XBRL Validator although it looked fine in the
editor. Measured on an MCA-generated PDF: the MCA HTML guidelines allow no bold / italic / underline, so the tool saved
them as `highlightedText1/2/3`, which the MCA PDF prints as **white text on a dark grey box**; Word headings became
`header2` (Helvetica bold **18 pt** on 9 pt text); every blank line copied from Word became an empty paragraph, which
the MCA PDF prints as a **gap of three lines** (paragraphs already get about two lines of space).

- **The editor shows the text as the MCA PDF prints it**: Times body text, Helvetica table cells and headings, headings
  at the MCA sizes, and — with the MCA highlight setting — bold / italic / underline as white text on grey.
- **A line above the text** says what would print untidily (empty paragraphs, grey boxes, large headings, empty table
  columns / rows).
- **Tidy** (toolbar) removes empty paragraphs and empty table columns / rows and applies the setting below the editor.
  Text is never removed. Cancel discards, Save Text keeps.
- **New setting, the default for new filings — "Plain text; whole bold lines become headings"**: a short line that is
  bold (or underlined) as a whole, and every Word heading, becomes one heading style (`header5`: bold, 12 pt, no
  shading); a bold sentence and inline bold become plain text. **H** in the toolbar makes the line at the cursor a
  heading or text. B / I / U (and Ctrl+B / I / U) are offered only with the MCA highlight setting.
- **Pasting from Word** is tidied the same way (with the highlight setting, emphasis is kept and only empty paragraphs
  and empty columns / rows are removed).
- Projects saved earlier keep their setting; an imported instance whose text blocks use `highlightedText` keeps the
  highlight setting, so editing it keeps its shading.
- The browser preview (`pdf-preview.js`) uses the measured MCA sizes and colours.

Changed: `richtext.js` (`tidy`, `layoutReport`, emphasis `'headings'`), `app.js` (editor), `styles.css`, `model.js`
(default setting), `importer.js` (keeps the highlight setting of an imported instance), `pdf-preview.js` (styles).
Nothing in the taxonomy, rules, gate or generator changed; stored text is changed only when the user saves it.
Tests: `text-tidy.test.mjs`; browser smoke +9 checks.

## v14 — keeping a project healthy, next year's filing, one-click fixes, keyboard

Architecture unchanged: the taxonomy, dimensions, calculation linkbase, MCA business rules, rule engine and XML
generator are untouched (the generated XML of both MCA-validated instances is byte-identical). New UI helper modules
`upkeep.js` and `fixes.js` act only through the Session (the normal entry path).

| # | Feature | How it works |
|---|---|---|
| 1 | **Health check** on opening, importing and saving a project | Values the tool calculated itself that are out of date are re-derived (statement figures taken from notes, totals, carrying amounts, closing balances — `Session.refreshCalculatedCells`, `refreshDerivedStatements`); values no tab can show (dates outside the two years; previous-year opening values without an opening-balance row that no shown value needs as its total) are moved to the set-aside store. Entered, imported and manual figures are never changed; nothing is deleted. The message on opening lists what changed. |
| 2 | **Prepare next year's filing** (Import XML, or from the open project on the company page) | Replaces "Current year only" / "Next year's filing" (hidden; old projects still open): last year's current year becomes the previous-year column — **locked as filed** (Unlock / Lock previous year in the tab tools; the Session refuses previous-year entries while locked) — and this year's opening balances (GR-7). Last year's previous year and opening balances, and the elements reported for the current year only (GR-12 disclosures) are **set aside**: kept in the project, never generated, never checked; "Copy from previous year" on the disclosure tabs reads them. Changing the dates by hand offers to set aside the values left outside the new years. |
| 3 | **Fix buttons** on validation messages (page and separate window) | Where the remedy is unambiguous: enter a missing total as the sum of its parts (GR-1); set an entered total to the sum of its parts; remove a previous-year opening value without its total, or set aside a value outside the filing's years; take a statement figure from its note (SR-L555-1 …); report nil (0) for a mandatory amount or a missing current-year value (GR-6). Each fix is tried on a copy first: the confirmation says what else it would raise. **Undo last fix**. GR-6 messages now open the cell where the value is missing. |
| 4 | **Previous year vs last year's filing** (Validation page) | Every previous-year figure compared with last year's filed figure (kept from the filed XML when the year is prepared, or attached later: "Compare with last year's filed XML…"): differs / missing / not filed, with "Use the filed figure". |
| 6 | **Live check** | Shortly after an edit (and on opening a tab) the rules of the open tab run in the background: cell marks and the bar ("This tab · N errors (live)") follow without pressing Validate. |
| 7 | **Hidden data** (menu, with a count) | The set-aside store (restore into the cell where this filing has one, or delete), values made not applicable (kept, excluded — e.g. after a Yes/No answer), values no tab shows. |

Keyboard: ↓ / ↑ also stop at the buttons under a cell (Go to note, Nil, Use parts total); Tab / Shift+Tab stay inside
the open tab; **Ctrl+Q** tab switcher (hold Ctrl; Q or ↓ / ↑; release Ctrl to open; Esc cancels); **Ctrl+Shift+S** save
project; **Ctrl+O** open project; **Alt+V** validate and open the messages window; **Ctrl+G** generate XML; **Ctrl+I**
import XML; **Alt+Shift+N** new filing; **Ctrl+H** MCA error help (Ctrl+V and Ctrl+N stay with the browser: paste and
new window). All shortcuts: menu → Keyboard shortcuts.

Tests: `v14.test.mjs`, `statement-notes.test.mjs` (note table kept open while it feeds a derived statement figure); 143 browser checks (`browser-smoke.mjs`).

## v13.2 — previous-year opening values

A project prepared by moving last year's filing forward (changing its dates) keeps last year's previous-year figures as
values dated the day before the previous year starts — previous-year **opening** values. Where such a value had lost
its total for that date, MCA generic rule GR-1 failed ("… is entered but its calculation parent … is not") and the
message pointed to the previous-year cell of the balance sheet, which shows a different date: the error could not be
resolved there, and the total cannot be entered (the balance sheet has no previous-year opening column).

Now the message says it is a previous-year opening value and gives its date; clicking it opens the cell that shows the
value (the previous-year opening row of the reconciliation, e.g. share capital at beginning of period), where it can be
cleared — or, when no tab shows it, offers to remove it. **Validation → Fix tools → Remove opening values without
totals** removes exactly the values behind those errors (and parts their removal leaves without a total), keeping
every other value. Previous-year opening balances are optional (a reference instance reports none).
Test: `opening-values.test.mjs`.

## v13.1 — correction

Removing a column of a note table (e.g. "Other loans and advances" in the borrowings note) deleted its values without
re-deriving what is calculated from them in other places, so the balance-sheet figure taken from the note (e.g.
short-term borrowings) kept the old sum and stayed read-only. `Session.removeSlice` now treats the removal as an edit of
each cell (re-derived like any edit). A project saved with such a stale figure is corrected when it is opened
(`Session.refreshDerivedStatements`: only figures the tool derived itself; entered, imported and manual figures are never
touched; the message on opening lists what changed). The Fix tools (Recalculate current year, Fill empty totals) are
available on the Validation page before a validation is run.

## v13 — five usability changes (architecture unchanged)

Same modules, same rule engine, same generator; the generated XML of both MCA-validated instances is byte-identical.

| # | Change | How it works |
|---|---|---|
| 1 | **Main-statement figures taken from their notes** — read-only on the balance sheet / statement of profit and loss, derived from the note, with a **Go to note** button under the cell | `derived.js statementNoteLinks`: (a) the MCA rules that state *statement figure = Σ of a note element over an axis* — share capital (SR-L374-1), reserves and surplus (SR-L555-1), long/short-term borrowings (SR-L632-1/2), provisions (SR-L784-2), loans and advances (SR-L936-1), trade receivables (SR-L1026-1), investments (SR-L675-2 / SR-L709-2), tangible / intangible assets (SR-L1381-2 / SR-L1505-2): the statement figure is recalculated whenever the note changes (`Session.deriveStatements`); (b) the same element as a total of the note's own calculation (other current liabilities, cash and bank balances, other income, employee benefit expense, finance costs, other expenses, current tax …) or as a note table's total column (inventories, producing properties …): one value, entered in the note. Statement totals (total assets, profit for the period …) are not linked. |
| | Read-only rules | Locked also while empty, as long as the note can be opened. A linked note table whose MCA condition reads only these statement figures (e.g. "borrowings table mandatory if borrowings > 0") is open while the figure is not determined yet, so the figure can be derived from it; a figure reported as 0 closes it as before. **Nil** button: a nil balance (0) can be reported on the statement while the note holds no value for it. A figure that was entered or imported and **differs** from its note stays editable (kept; the MCA rule reports the difference) — it follows the note once it agreed with it. **Allow editing of calculated cells** (tab option) still allows a manual figure, which is never replaced. **Recalculate current year** makes every statement figure follow its note (preview first). |
| | Note sums | The MCA rule's own reading of a level (first-level members, a first-level member not reported replaced by its reported descendants). When the note also reports one more added-up axis (secured / unsecured borrowings, security classification of loans) a member's value is its column without that axis, else the sum of that axis' first-level members; axes that are not added up (gross / accumulated depreciation → carrying amount) are never summed. Checked on both MCA-validated instances: every derived figure equals the filed figure. |
| 2 | **Validation messages in a separate window** | Validation → **Open in separate window ↗**: the list (errors / warnings / info / all) in a pop-up; clicking a message opens its cell in the main window; after an edit the list is marked out of date; **Validate again** refreshes it. |
| 3 | **Larger, resizable tables** | Tables are a little larger (page width 1280 px, table height = window − 150 px) and can be resized by dragging their bottom-right corner; the size is kept per tab/table in this browser (**Reset table size**). |
| 4 | **Copy from previous year on the disclosure tabs** ([400100]–[400500]) | Disclosures are reported for the current year only (GR-12), so "previous year" is last year's filing: the previous-year values kept in the project, or last year's current-year values set aside by an import as **Next year's filing**. Copied only into empty current-year cells (Yes/No answers first, then the cells they open), through the normal entry path; also per table (table view). |
| 5 | **Dark mode** | A mandatory cell still empty was painted near-white (`#fff7f7`) with light text — unreadable in dark mode, also in its dropdown list. Colours are now theme tokens (`--req-empty`, `--on-bad`); cells and dropdown options use the theme's text and panel colours. Checked by contrast (≥ 4.5) in the browser test. |

Also: typing the same value into a cell again no longer marks the filing as changed.

Tests: `statement-notes.test.mjs`, `disclosure-carry.test.mjs`, 117 browser checks of which 16 new (`browser-smoke.mjs`), assurance unchanged in substance (re-key of both MCA instances through the screen path — the statement figures now derive from their notes — mistakes / undo, locked cells, rule locations).

## v12 — the user can always resolve what the tool reports

Guarantee checked by machine on every release (`assurance.mjs`, `npm run test:assurance`, part of `npm test` and the
release gate), on both MCA-validated instances:

1. **Re-key**: starting from an empty filing, every fact of the reference instance can be typed through the screen's own
   entry path, in any order (taxonomy order, reverse, random) → identical values, 0 validation errors.
2. **Mistakes**: mistakes made through the screen (clear, change, Yes/No flip, other option) raise only errors whose
   location is a cell or table the user can open and edit, and typing the original value back restores the filing
   exactly — no error, no changed value left behind.
3. **Locked cells**: every read-only (calculated) cell shows exactly the value the tool derives; none is locked and empty.
4. **Every rule has a place to fix it**: every element named by an executable MCA business rule (≈10,000 element ×
   year × filing combinations: an empty filing and both MCA instances) locates to a cell or table the user can open.

During development the same checks ran on 8,000+ further mistakes (both reference instances and a 2025-26 test project, before
and after its fixes): 0 errors without a reachable, editable location. Undo restored the filing exactly every time,
except on the project as it came from v10: there the first edit also fills carrying amounts v10 had left empty
(MCA rule SR-L1380-1), which is intended.

Rules behind it (v12 corrections, all found by these checks):

| Rule | Before | Now |
|---|---|---|
| When is a total locked? | whenever its parts *could* be reported — an opening balance whose breakup is not reported (equity share warrants) could never be typed | only while the tool maintains it: a part has a value and the total is empty-filled/calculated or agrees with its parts. An empty cell is never locked |
| A total typed before its parts | replaced by the sum of whatever parts existed (balance-sheet trade receivables became 0 when the note's allowance 0 was typed, which switched the receivables table off — a dead end) | a total follows its parts when it agreed with them before the edit; a different entered or imported figure is kept and stays editable; GR-1 shows the difference. Result is independent of entry order |
| MCA "Parent child exempt calculation" (interest expense, warrants, refundable deposits, directors' remuneration …) | forced to the sum of the parts and locked | filled from the parts while empty, never locked, never overwrites an entered figure |
| Closing balance = opening + changes | locked (v11) — an audited closing with a rounding difference (reserves of a reference instance) could not be typed | filled while empty, stays editable (not an MCA rule) |
| Carrying amount = gross − accumulated (MCA rule) | — | locked only when it agrees; an entered different value stays editable and SR-L1380/1364 point to it |
| Decimals of a calculated total | lowest decimals of the parts — a part imported at `-4` next to `-3` made totals fail "non-significant digits", and undoing the edit did not clear it | never fewer decimals than the total's own digits need |
| Error location of a table total / table rule | the tab, where the element has no row ("cell not shown") | the table's total column (added on click if not shown), the totals table, or the table; a location that is not a valid cell falls back to its table |
| Conditional table whose condition is calculated from the table's own values (trade receivables) or is the table's own total column (share capital) | clearing a value switched the table off, and the error then pointed into a closed table | stays open while it holds values (other conditional tables unchanged — [200500] regression) |
| Error on an axis, a member or a line-item heading (GR-3 parent member, SR-L3592 …) | no location | the table that carries it |
| Typing a calculated cell's own value | refused ("calculated") | accepted |
| A locked cell reached from an error | no hint | explains: correct its parts, or allow editing of calculated cells |

## v11 audit (corrections to v10)

Found by replaying a FY 2025-26 test project (prepared from a 2024-25 reference instance) and by checking
that every fact of both reference instances has a visible cell. Architecture unchanged: same modules, same rule engine,
same generator; the generated XML of both golden instances is byte-identical to v10.

| # | Defect in v10 | Effect | Correction |
|---|---|---|---|
| 1 | Compiler (`dts.mjs`) treated arcs with the same parent/child but different `order`/`preferredLabel` as equivalent (XBRL 2.1 §3.5.3.9.7.4 requires all non-exempt attributes to match) | the **closing-balance row** of all 31 reconciliations was dropped (tangible/intangible assets, reserves, share capital, shares outstanding, other provisions, DBO, plan assets, cash-flow closing cash, …) — closings could not be entered: ML-1/ML-3/ML-14/ML-16 failed | key includes the non-exempt attributes; presentation gains the 31 `periodEndLabel` arcs, every other compiled section (hypercubes, dimensions, tables, calculations, rules) is identical |
| 2 | Dimensional tables had no **total column** (every axis at its default = facts without dimensions) | table totals that MCA-validated instances report could be imported but never entered for a new year (GR-6 "previous year entered, current year not") | `views.totalColumnAllowed` / `tableSlices`: the total column is shown first; "Add row" with every axis at its default adds it |
| 3 | Carrying amount was not derived | stale carrying values (e.g. a copied previous-year depreciation) failed SR-L1380-1 | `derived.js`: carrying = gross − accumulated (MCA SR-L1364-2/1380-1/1484-2/1504-1), for every movement row (480/480 triples in both golden instances) — calculated, read-only |
| 4 | Closing balance was not derived | closings missing | current-year closing = opening (previous-year closing, GR-7) + net change, for the 9 roll-forwards the taxonomy presents (not cash-flow cash, not the directors'-report shareholding) — calculated, read-only |
| 5 | Removing a table column deleted every fact with the same member combination in the whole filing | another table's column (e.g. borrowings long-term) could be deleted with a provisions column | `Session.sliceFacts` — only the table's own line items; the total column keeps statement figures |
| 6 | A table showed columns of another table whose axes are a subset (share-class columns inside the >5 % shareholders table) | values typed there belonged to the wrong table (ML-2) | `tableSlices` keeps a column only if its facts belong to the table (`tablesForFact`, as the rule engine) |
| 7 | "Current year only" import + moving the dates to prepare the next year kept `yearMode='current'` and last year's opening balances as previous-year *opening* facts | GR-1 "parent not entered" at the previous-year opening date | new import mode **Next year's filing** (the filed current year becomes the previous year; periods set; cash-flow method kept; GR-12 elements not carried; no previous-year opening facts, as in reference instance B); `setMeta` resets `yearMode`; Validation offers **Remove previous-year opening values** |

New explicit actions (each shows what it will change and asks first): **Recalculate current year** (re-derives every
calculated cell of the current year — totals, carrying amounts, closings — previous-year figures and manual overrides
untouched), **Fill empty totals** (per table and for all tables: empty total cells = sum of the part columns, only on the
axes the MCA rules add up, only in columns already in the table plus the total column when the other year reports it;
never overwrites). A statement figure that was entered or imported (e.g. Tangible assets on the balance sheet) is never
overwritten by a note's total — the note must agree and SR-L1364-2 / SR-L1381-2 / SR-L374-1 / SR-L555-1 report a
difference at the note.

## Run

```
npm install
pip install -r requirements.txt   # Arelle — offline XSD / XBRL 2.1 / Dimensions validator used by tests and release gate
npm run release                   # = compile → tests → build → release gate (below)
```

Pipeline (`npm run release`):

| Stage | Command | What it does |
|---|---|---|
| authority compile | `npm run compile` | unpacks the taxonomy zip to `.taxonomy/`, reads the rule workbook, writes `MCA_AUTHORITY.json` + `BUSINESS_RULE_COVERAGE.json`, prints the corpus report |
| unit tests | `npm run test:unit` | taxonomy, dimensions, typed members, rule corpus, every rule family (rule-by-rule positive/negative), calculations, scaling/decimals/units, applicability, rich text, import year modes |
| internal gate tests | `npm run test:gate` | importer/generator/gate, [200500] release regression |
| XML generation → XSD | `npm run test:xsd` | generated instances validated by Arelle (XML Schema + XBRL 2.1 + XBRL Dimensions), offline |
| golden regression | `npm run test:golden` | `golden-*.xml` import → model → regenerate → re-import → semantic compare; PDF cross-check |
| production build | `npm run build` | `index.html` (= `mca-ci-xbrl.html`), the single-file app with the compiled authority embedded |
| release gate | `node release-gate.mjs` | all of the above + build integrity + headless-browser UI regression; writes `RELEASE_REPORT.json` |

**Rule workbook:** the compiler reads the original MCA workbook `Final_Business_Rule_CI_Taxonomy_2016_V1.3.xls`
(14 sheets, read row by row, no export limit; sha256 `70faff6f5e33d5cf…`). "Specific rules for elements" has 567 rule rows
from [100100] Balance sheet to [400500] Secretarial audit report — not truncated. The older text export
`…V1.3.xls.txt` (truncated at 1000 rows) is kept only as a test fixture; a test proves it is an exact prefix of the workbook.

**Rule coverage** (`BUSINESS_RULE_COVERAGE.json`, one status per clause): EXECUTABLE 961, REVIEW_ONLY_EXTERNAL_DATA 49
(MCA21 master data, e-form, ICAI/ICSI databases, currency / ITC code lists — never auto-passed), NOT_APPLICABLE 153
(element not in the 2016 DTS, superseded duplicate sheets, permissive statements), UNIMPLEMENTED 1 (`ML-20-b`).

**Conditional tables:** "table is mandatory if …" is a requirement (the rule fails when the condition is true and the
table is empty). It disables the table only where the MCA text says "only if" and for the earlier [200100]–[200600]
table rules (incl. the [200500] current-investments regression). Evidence: a reference instance reports
[201100] intangible-asset rows while `IntangibleAssets` is 0.

**XSD validation:** genuine schema validation runs through [Arelle](https://arelle.org) (`requirements.txt`),
fully offline (XBRL specification schemas from Arelle's bundled cache, MCA taxonomy from the local zip). If Arelle is
not installed the XSD tests are skipped with an explicit message and the release gate blocks.
It is not the MCA XBRL Validator V5.1 and does not run MCA business rules.

**Rich text:** every text-block (narrative) element is a rich-text editor (bold, italic, underline, numbered and
bulleted lists, indentation, line breaks, paste from Word/HTML). Content is stored in the Filing Manual HTML subset:
bold/italic/underline → `span.highlightedText1/2/3`, lists → `div.noteText1/2` with visible markers, indentation →
`div.noteText3`, headings → `p.headerN`; it converts back to the same formatting on load and import.
Tables follow the MCA Validator's HTML schema (evidence: MCA error file — `colgroup` and `colspan` rejected): only
`table/thead/tbody/tfoot/tr/td/th` and the `class` attribute. Pasted Word/Excel tables are rebuilt on a grid (col,
colgroup, caption dropped; merged cells become empty cells; `&nbsp;` padding before numbers and whitespace-only
paragraphs removed, as they widen columns until the MCA PDF cuts the table) and get `class="bordered"` (▦ toggles
borders). A filing-level option saves bold/italic/underline as plain text instead of `highlightedText1/2/3` (the MCA PDF
renders highlightedText as shaded text). Control characters XML does not allow are removed (vertical tab = line break)
and blocked by the gate.

**Build id:** the header shows `BUILD <id>` (content hash, `BUILD_INFO.json`), and every generated XML starts with
`<!-- Generated by C&I XBRL Studio build <id> -->`. A different id in an XML means it came from a cached old page
(Ctrl+F5).

**MCA error help:** paste the MCA Validator error list; each message (Xerces `cvc-…` codes, the "contained HTML"
messages) is explained with cause and fix, grouped, and linked to the element (`mca-errors.js`). Explanation only — no
validation.

**Workbench behaviour** (one applicability decision — `Applicability.cellStatus` / `planFacts` — drives the UI, import,
validation and generation):
* **Text blocks** show a *Text Block* button; the editor opens in a popup (Save Text / Cancel). Storage is unchanged.
* **Import** keeps a fact only if its cell is applicable (previous year of a GR-12 ELR, the cash-flow statement not
  selected, a field under a "No" answer, a table whose condition is not met). Others are listed in the import report
  and never become filing data.
* **Cash flow method** (`TypeOfCashFlowStatement`) is chosen in *Disclosure of General Information about Company*; on
  import it is read from the XML, else detected from which statement the facts belong to, else asked.
* **Yes/No dependencies** are compiled from the MCA conditional rules (`booleanDependencies` in the authority model).
  Changing Yes → No asks first; values are kept but excluded.
* **Calculated cells** (parents in the tab's own calculation network; carrying amounts = gross − accumulated; current-year
  closing balances = opening + changes — `derived.js`) are auto-populated and read-only; each tab has
  an *Allow editing of calculated cells* option. Overridden values are kept and checked by GR-1.
* **Mandatory marks** (`mandatory-marks.js`, display only): rows show a *Mandatory* label (red: always; blue: because its
  condition is currently met) and mandatory cells a red edge, filled pink while empty. Read from the compiled business
  rules (mandatory, conditional mandatory, Mandatory Line Items per table row, member-specific); rules recorded as
  warnings in `golden-DIVERGENCES.json` are not marked. Nothing in the filing, validation or XML changes.
* **Validation** results carry a location (tab, table, cell = fact key); clicking one opens the tab and focuses the
  cell (errors red, warnings dashed). *Validate current tab* runs the same engine on the tab's facts and rules and
  marks cross-tab checks; XML generation always validates the entire filing.

**Usability (display only — no filing semantics):** column headings and the row-label column stay in view (the grid
scrolls in its own box); alternate-row shading and row highlight on hover/focus; Enter / Shift+Enter (and ↑/↓ in text
cells) move to the same column of the next/previous editable row; Ctrl+S saves in the browser now (the bar shows
*Saved hh:mm*); grid cells have accessible names (row — column), `aria-required` for mandatory marks and `aria-invalid`
for cells with errors; dialogs keep Tab inside, start on Cancel and return focus; *New filing* and removing a table row
that holds values ask first; a text block button shows ⚠ and its issue count after validation, and the editor lists
that text block's issues (last validation + the gate's HTML check of the stored value).

**Totals and parts on dimensional tables** (`member-hints.js` hints are display only; `totals-fill.js` "Fill empty totals" is an explicit action — tool guidance, not MCA rules; nothing in
the filing, validation or XML changes): the member pickers mark totals ("— total") and explain where a member sits
(part of … › …) and whether GR-3 needs its parent column; column headings show **TOTAL** / *part of …*; columns are shown
in taxonomy order (each total before its parts; *As entered* available); a part column whose GR-3 parent column is
missing offers **Add** (the decision is the rule engine's own `gr3RequiredParent`); under each total cell a line shows
*= parts ✓* or the parts total and the difference, with **Use parts total** (entered through the normal cell entry).
Sums are checked only on axes the MCA business rules themselves add up (`sumAxis` in the compiled rules: borrowings,
tangible/intangible asset classes, investments, …), only for amounts and share counts, rounded like XBRL Calculations
1.1. Leaving a table (or Validate / Generate) while totals differ asks *Stay and fix* / *Continue anyway*; Validation
lists them under **Totals hints**, separate from errors and warnings. Both MCA-validated filings: 0 hints, 0 missing
parent columns (several hundred totals compared).

**Copy from previous year** (`carry-forward.js`, current-year tables): adds the previous-year columns (member
combinations) through the normal *Add row* check and, if ticked, copies previous-year values into **empty** current-year
cells through the normal cell entry (applicability, dimensions, decimals, recalculation). Never overwrites; opening-balance
rows (same fact as the previous-year closing, GR-7), closing-balance rows (this year's opening + changes), statement figures
in a total column and calculated cells are not copied.

**Footnotes** (`footnotes.js`, *Footnotes* tab): select a cell with a value on any tab and press **Alt+N** (or *Footnote…*
in the tab tools) to add a footnote, or a new one reusing an existing footnote's text (one footnote per cell, as in
the reference instances); cells with footnotes show an *fn* mark. The tab lists every
footnote with its cells (Go / remove), edits its text and deletes it. Stored in the filing's existing footnote store and
written by the existing generator as an XBRL footnote link (`xml:lang="en"`, fact-footnote arcs) for generated cells only.
The preview shows them as the MCA PDFs do: "(A) value" in the cell, letters in reading order per table block, and a
"Footnotes" list after the block.

**Preview PDF** (`pdf-preview.js`, Generate XML tab): opens a printable preview of the facts the XML contains
(Print → Save as PDF; or download it as .html). It imitates the general layout of the MCA validator's PDF — company and
period heading, one section per statement/note, "Unless otherwise specified …", current/previous year, dimensional tables
in blocks of columns "..(n)" with axis/member headings, Indian digit grouping, text blocks as "Textual information (n)"
with the MCA classes styled — and is labelled **not the MCA rendering** on every page. Checked against the MCA PDF of a reference instance: the same statements/notes
and every balance-sheet value appear. The official PDF comes only from the MCA validator.

**Import:** choosing an XML opens a preview with the current/previous-year split (from the context dates). Choose
**Both years**, **Current year only** or **Next year's filing** before anything is imported; the import report states
what was imported. *Next year's filing* prepares the following year from a filed instance: its current-year facts become the
previous-year column (fact dates unchanged), the reporting periods are set to the next year, the cash-flow method is kept,
elements that do not apply to a previous year (GR-12) are listed as not applicable, and its own previous year and opening
balances are not imported (reference instance B: every fact carried, 0 differences).
*Current year only* imports the current-period facts plus the current-year **opening balances**: instant facts at the
previous-year end of the concepts the taxonomy presents with an opening-balance (periodStart) row — share capital,
reserves, tangible/intangible assets, cash, … MCA generic rule GR-7 ("there is a common element for specifying the opening
and closing balance … the Opening balance of current year be shown as the closing balance of previous year") makes that
one XBRL fact, so those items also show it as their previous-year closing. Every other previous-year fact (P&L and cash-flow
durations, balance-sheet comparatives, PY opening instants) is not imported (golden: 77 opening balances carried,
1,231 previous-year facts skipped).

Generated files (`.taxonomy/`, `MCA_AUTHORITY.json`, `BUSINESS_RULE_COVERAGE.json`, `artifact.html`,
`BUILD_INFO.json`, `RELEASE_REPORT.json`) are git-ignored. `index.html` / `mca-ci-xbrl.html` are committed (GitHub Pages).

## Files

| Role | Files |
|---|---|
| MCA authority inputs | `Final_C_and_I_Taxonomy_2016_V1.2.zip` (as published), `Taxonomy-2016-03-31.zip` (the copy the MCA XBRL Validator downloads; v14.4), `Final_Business_Rule_CI_Taxonomy_2016_V1.3.xls` (complete rule workbook), `Annexure_II_Main_Taxonomy_V2.xls.txt`, `Filing_Manual_CNI_V4.0.pdf`; `Final_Business_Rule_C_I_Taxonomy_2016_V1.3.xls.txt` (old truncated export, test fixture only) |
| Golden (reference instances A and B; not published) | `golden-FILING-B_2024-25.xml`, `golden-FILING-B_2024-25.pdf`, `golden-FILING-A_2024-25.xml`, `golden-DIVERGENCES.json` |
| Authority compiler | `compile.mjs`, `taxonomy-source.mjs`, `dts.mjs`, `tables.mjs`, `rules-source.mjs`, `rule-formalizer.mjs` |
| Runtime engines | `authority.js` (taxonomy), `dimensions.js` (dimension + hypercube), `calculation.js`, `rules.js` (business rules), `expr.js`, `applicability.js`, `model.js` (filing state), `periods.js`, `scaling.js`, `units.js`, `decimal.js`, `importer.js`, `generator.js` (only XML generator), `gate.js` (internal validation), `views.js` (table engine), `session.js` (controller), `derived.js` (carrying amount / closing balance derivations, statement figures taken from notes) |
| UI | `app.js`, `upkeep.js` (health check, hidden data, filed comparison), `fixes.js` (one-click fixes), `richtext.js` (text blocks; v14.1 tidy for the MCA PDF), `dates.js` (dd-mm-yyyy entry), `mandatory-marks.js`, `member-hints.js`, `totals-fill.js`, `carry-forward.js`, `footnotes.js`, `pdf-preview.js`, `mca-errors.js`, `example.js`, `shell.html`, `styles.css` |
| Build / release | `build.mjs`, `release-gate.mjs`, `xsd-validate.mjs`, `browser-smoke.mjs`, `requirements.txt`, `APPROVED_LIMITATIONS.json` |
| Assurance | `assurance.mjs` (re-key / mistakes / locked-cell harness), `assurance.test.mjs` |
| Tests | `*.test.mjs` (incl. `workbench.test.mjs`, `audit-filing-a.test.mjs`, `mca-html.test.mjs`, `member-hints.test.mjs`, `carry-forward.test.mjs`, `footnotes.test.mjs`, `pdf-preview.test.mjs`, `audit-v11.test.mjs`, `statement-notes.test.mjs`, `disclosure-carry.test.mjs`, `opening-values.test.mjs`, `v14.test.mjs`, `text-tidy.test.mjs`, `dates.test.mjs`, `decimals-v143.test.mjs`), `helpers.mjs`, `fixtures.mjs` |

## Status semantics

* **Internal gate** (in app): structure, contexts, units, decimals, dimensions/hypercubes, calculations,
  executable MCA rules. Generation is blocked on any error.
* **Official MCA validation**: always shown as *not run*. Only the MCA XBRL Validator V5.1 can change that.

## Known limitations (release gate BLOCKED until resolved or approved in `APPROVED_LIMITATIONS.json`)

1. **`ML-20-b` UNIMPLEMENTED** — Mandatory Line Items row 20: "In OutstandingBalancesForRelatedPartyTransactionsAbstract-
   Element for amount shall be mandatory for various transactions" does not identify the required elements (identical in
   both ML sheets of the complete workbook; no specific rule for that abstract). Needs MCA clarification. If the release
   owner approves it, it is shown as **APPROVED LIMITATION / NOT EXECUTED** and never as a PASS.
2. `golden-DIVERGENCES.json` records evidence from the reference instances: the V3 schemaRef is
   accepted; CH-4/5/6, SR-L3996-1/3997-1/3998-1 (main product/service from FY 2018-19), SR-L2537-2 (NumberOfSubsidiaryCompanies
   > 0 with "No" subsidiaries) and SR-L2116-1 (KMP remuneration; rule text quotes a value not in the enumeration) report as warnings.
3. Rules corrected from reference-instance evidence (`audit-filing-a.test.mjs`): calculations use XBRL Calculations 1.1 round-to-nearest;
   GR-4 sequence check applies to taxonomy members, not typed identifiers; GR-6 does not pair dimensional rows member by member;
   ML-20 accepts Key Management Personnel transactions; shareholding % sums allow the rounding of the reported decimals.
4. Rules needing data outside the instance are `REVIEW_ONLY_EXTERNAL_DATA` (manual review, never auto-passed).
5. Official MCA XBRL Validator V5.1: **NOT RUN**. GitHub Pages smoke test of the deployed site: **NOT RUN** from the build
   environment (the site is not reachable from it); `browser-smoke.mjs` runs the same checks against the built `index.html`.
