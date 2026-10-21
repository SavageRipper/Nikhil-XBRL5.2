// v14.4: "Download XML with errors" — the XML of a draft whose errors are not yet resolved, only for producing the PDF
// with the MCA tool. Without the option nothing changes: any error blocks generation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authority, q } from './helpers.mjs';
import { validCurrentInvestmentsSession, baseSession } from './fixtures.mjs';
import { GateError } from './gate.js';
import { generateInstance } from './generator.js';
import { Session } from './session.js';
import { buildExample } from './example.js';

const A = authority();
const today = '2017-06-30';

test('a filing with errors: blocked as before; with allowErrors the XML of exactly the facts a clean run writes', () => {
  const s = baseSession();
  s.setValue(q('CurrentInvestments'), 'CY', '1000');
  assert.throws(() => s.exportXml({ today }), GateError);
  const before = JSON.stringify(s.filing.toJSON());
  const r = s.exportXml({ today, allowErrors: true });
  assert.equal(r.validated, false);
  assert.ok(r.gate.summary.errors > 0);
  assert.match(r.xml, /^<\?xml/);
  assert.match(r.xml, /<in-gaap:CurrentInvestments [^>]*>1000</);
  assert.equal(JSON.stringify(s.filing.toJSON()), before, 'the project is not changed');
  // the same facts the gate plans to emit, with xml:lang as a clean export writes it
  const emit = r.gate.emit.map((f) => (A.isNumeric(f.concept) ? f : A.langAllowed(f.concept) ? (!f.nil && !f.lang ? { ...f, lang: 'en' } : f) : f.lang ? { ...f, lang: null } : f));
  // v14.7: the same XML with a NOT VALIDATED comment as its second line
  assert.equal(r.xml, generateInstance(A, s.filing, emit).xml.replace(/^(<\?xml[^>]*\?>)/, `$1\n<!-- NOT VALIDATED: generated with ${r.gate.summary.errors} unresolved internal validation error(s), for review only (e.g. the MCA validator's PDF). Do not file. -->`));
  assert.match(r.xml.split('\n')[1], /^<!-- NOT VALIDATED/);
});

test('a filing without errors: allowErrors gives the identical, validated XML', () => {
  const s = validCurrentInvestmentsSession();
  const a = s.exportXml({ today });
  const b = s.exportXml({ today, allowErrors: true });
  assert.equal(b.validated, true);
  assert.equal(b.xml, a.xml);
  assert.ok(!/NOT VALIDATED/.test(b.xml), 'no comment when there are no errors');
  const e = new Session(A); buildExample(e);
  assert.equal(e.exportXml({ today: '2025-09-30', allowErrors: true }).xml, e.exportXml({ today: '2025-09-30' }).xml);
});

test('the Generate XML page offers the option, names the file …_WITH-ERRORS.xml and asks first', () => {
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /data-act="download-xml-errors"/);
  assert.match(app, /_WITH-ERRORS\.xml/);
  assert.match(app, /S\.exportXml\(\{ allowErrors: true \}\)/);
  assert.match(app, /confirmDialog\('Download XML with errors'/);
});
