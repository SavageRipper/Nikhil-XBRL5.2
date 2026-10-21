// v14.6: the schema reference is the V3 address the MCA XBRL Validator requires — "Incorrect schema reference. Please
// use new schema URL: https://www.mca.gov.in/V3XBRL/ instead of V2 Schema URL: http://www.mca.gov.in/XBRL/" — for a
// filing entered from scratch, an instance imported with the V2 address, and a project saved with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { authority, importSession } from './helpers.mjs';
import { Session } from './session.js';
import { Filing } from './model.js';
import { buildExample } from './example.js';
import { healthCheck } from './upkeep.js';
import { fixFor } from './fixes.js';

const A = authority();
const V3 = 'https://www.mca.gov.in/V3XBRL/2016/07/26/Taxonomy/CnI/in-ci-ent-2016-03-31.xsd';
const V2 = 'http://www.mca.gov.in/XBRL/2016/07/26/Taxonomy/CnI/in-ci-ent-2016-03-31.xsd';
const today = '2025-09-30';
const href = (xml) => /<link:schemaRef [^>]*xlink:href="([^"]+)"/.exec(xml)[1];
const example = () => { const s = new Session(A); buildExample(s); return s; };

test('a filing entered from scratch is written with the V3 address; the V2 address is not accepted', () => {
  assert.equal(A.meta.schemaRef, V3);
  assert.deepEqual(A.meta.acceptedSchemaRefs.map((x) => x.href), [V3]);
  assert.deepEqual(A.meta.retiredSchemaRefs, [V2]);
  const xml = example().exportXml({ today }).xml;
  assert.equal(href(xml), V3);
  assert.ok(!xml.includes('www.mca.gov.in/XBRL/'), 'no V2 address anywhere');
});

test('an instance with the V2 address is imported with a warning and written with V3', () => {
  const v2xml = example().exportXml({ today }).xml.replace(V3, V2);
  const { s, report } = importSession(v2xml);
  assert.ok(report.warnings.some((w) => /old V2 address/.test(w)), report.warnings.join('\n'));
  assert.equal(href(s.exportXml({ today }).xml), V3);
});

test('a project saved with the V2 address: the health check sets V3 on opening; validation offers the same as a fix', () => {
  const s = example();
  const json = s.filing.toJSON(); json.meta.schemaRef = V2;
  const P = new Session(A, Filing.fromJSON(A, JSON.parse(JSON.stringify(json))));
  const h = healthCheck(P);
  assert.deepEqual(h.schemaRef, { before: V2, after: V3 });
  assert.ok(h.changed >= 1);
  assert.equal(href(P.exportXml({ today }).xml), V3);
  // without the health check (e.g. a project restored before saving): an error at General Information, with a fix
  const Q = new Session(A, Filing.fromJSON(A, JSON.parse(JSON.stringify(json))));
  const e = Q.validate({ today }).issues.find((i) => i.code === 'schemaRef');
  assert.ok(e && e.severity === 'ERROR');
  const fx = fixFor(Q, e);
  assert.equal(fx.label, 'Use the V3 schema reference');
  fx.apply();
  assert.equal(Q.validate({ today }).issues.filter((i) => i.code === 'schemaRef').length, 0);
  assert.equal(href(Q.exportXml({ today }).xml), V3);
});
