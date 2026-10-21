// Business-rule engine: executes every EXECUTABLE rule of the compiled MCA corpus.
// Rule results: PASS | FAIL | WARN | NOT_APPLICABLE | REVIEW_ONLY_EXTERNAL_DATA | UNIMPLEMENTED | APPROVED_LIMITATION_NOT_EXECUTED.
// No rule is ever reported PASS unless it was actually evaluated.
import * as Dec from './decimal.js';
import { evalPred, evalExpr } from './expr.js';
import { Applicability } from './applicability.js';
import { dimensionallyValid, sequentialGaps, tablesForFact } from './dimensions.js';
import { runCalculations, CalcStatus } from './calculation.js';
import { reportingYear, scopeOf } from './periods.js';
import { dimKey } from './model.js';

// tables whose line items may be given against one member only ("lineItemSingleMember" rules, e.g. SR-L3717-1)
const SINGLE = new WeakMap();
function singleMemberTables(A) {
  if (!SINGLE.has(A)) SINGLE.set(A, new Set(A.rules.rules.filter((r) => r.status === 'EXECUTABLE' && r.ast?.type === 'lineItemSingleMember').flatMap((r) => r.ast.tables)));
  return SINGLE.get(A);
}

// GR-3 (parent member required when a child member is reported): the parent member of `member` on `axis` that
// must also be reported, or null. The default member is the axis total, reported without the axis (often on the
// face of the statements); MCA-validated instances omit it in multi-axis tables, so only non-default parents are
// required (Filing Manual Annex II #14 example: OfficeEquipmentMember). Exemptions: sheet 'Exempt parent member -
// Dimension' for the given hypercube names. Shared by the rule engine and the table UI hints (mandatory-marks-style
// display only), so both use the same decision.
export function gr3RequiredParent(A, axis, member, tableNames) {
  const info = A.axisInfo(axis);
  const parent = info?.parents.get(member);
  if (!parent || parent === A.dimensionDefault(axis) || info.members.get(parent)?.usable === false) return null;
  if (A.rules.exemptions.parentMember.some((e) => e.axis === axis && e.member === parent && tableNames.includes(e.table))) return null;
  return parent;
}

export class RuleEngine {
  constructor(A) {
    this.A = A;
    this.app = new Applicability(A);
    this.rules = A.rules.rules;
    this._mandatoryConcepts = new Set(this.rules.filter((r) => r.status === 'EXECUTABLE' && r.ast?.type === 'mandatory' && !r.ast.when).map((r) => r.ast.concept));
    this._calcExempt = null;
  }

  run(filing, { today = new Date().toISOString().slice(0, 10), only = null } = {}) {
    this.today = today;
    const results = [];
    const executed = {};
    const ctx = { filing, results, calc: null };
    for (const r of this.rules) {
      if (only && !only.has(r.id)) continue;
      if (r.status !== 'EXECUTABLE') {
        if (r.status === 'UNIMPLEMENTED' && r.approvedLimitation) {
          results.push({ ruleId: r.id, scope: null, status: 'APPROVED_LIMITATION_NOT_EXECUTED', message: `APPROVED LIMITATION / NOT EXECUTED: ${r.text}` });
          executed[r.id] = 'APPROVED LIMITATION / NOT EXECUTED';
          continue;
        }
        if (r.status === 'REVIEW_ONLY_EXTERNAL_DATA' || r.status === 'UNIMPLEMENTED') results.push({ ruleId: r.id, scope: null, status: r.status, message: r.reason || r.text });
        executed[r.id] = r.status;
        continue;
      }
      if (!r.ast) { executed[r.id] = 'EXECUTED'; continue; } // data rows consumed by generic handlers
      const before = results.length;
      try {
        this.exec(r, ctx);
      } catch (e) {
        results.push({ ruleId: r.id, scope: null, status: 'FAIL', message: `Rule engine error: ${e.message}`, engineError: true });
      }
      executed[r.id] = 'EXECUTED';
      if (results.length === before) results.push({ ruleId: r.id, scope: null, status: 'NOT_APPLICABLE', message: 'No facts or conditions in scope' });
    }
    return { results, ruleStatus: executed, calculations: ctx.calc };
  }

  env(filing, scope, extra = {}) { return this.app.env(filing, scope, { today: this.today, ...extra }); }
  scopes(r, filing) {
    const s = r.scope?.periods || ['CY', 'PY'];
    return s.filter((x) => x === 'CY' || (!filing.meta.firstFinancialYear && x === 'PY'));
  }
  factsIn(filing, concept, scope) {
    return filing.factsOf(concept).filter((f) => !f.nil && reportingYear(filing.meta.periods, f.period) === scope && filing.scopeOf(f.period) !== 'PYO');
  }
  out(ctx, r, scope, status, message, extra = {}) {
    // a rule contradicted by an MCA-validated instance reports failures as warnings (evidence attached)
    if (status === 'FAIL' && r.severity === 'WARNING') { status = 'WARN'; message += ` — not blocking: ${r.divergence}`; }
    // location anchor for the UI (cell navigation): the rule's subject concept unless the result names its own
    const a = r.ast || {};
    if (a.type === 'tableRequired') { if (!extra.tableId) extra.tableId = a.tables?.[0] || null; }
    else if (extra.concept === undefined && !extra.factKey) extra.concept = r.subject || a.concept || (a.concepts || [])[0] || null;
    ctx.results.push({ ruleId: r.id, scope, status, message, ...extra });
  }
  label(q) { return this.A.concept(q)?.name || q; }

  exec(r, ctx) {
    const { filing } = ctx;
    const a = r.ast;
    switch (a.type) {
      case 'mandatory': return this.mandatory(r, ctx);
      case 'eachFact': case 'eachFactOf': {
        for (const scope of this.scopes(r, filing)) {
          for (const f of this.factsIn(filing, a.concept, scope)) {
            const env = this.env(filing, scope, { self: f, dims: f.dims });
            if (a.when && evalPred(a.when, env) !== true) continue;
            const v = evalPred(a.assert, env);
            if (v === true) this.out(ctx, r, scope, 'PASS', r.text, { factKey: f.key });
            else if (v === false) {
              // "X is mandatory if <trigger>": the error belongs to the missing X cell, not to the trigger
              const missing = a.type === 'eachFactOf' && a.assert?.op === 'entered' && a.assert.e?.fact;
              const loc = missing ? { concept: missing, dims: dimensionallyValid(this.A, missing, f.dims).valid ? f.dims : [], relatedFactKey: f.key } : { factKey: f.key };
              this.out(ctx, r, scope, 'FAIL', `${this.label(a.concept)}${f.dims.length ? ' [' + dimKey(f.dims) + ']' : ''}: ${a.message || r.text}`, loc);
            }
          }
        }
        return;
      }
      case 'assert': {
        for (const scope of this.scopes(r, filing)) {
          if (r.subject && !this.app.conceptStatus(filing, r.subject, scope).applicable) continue;
          const env = this.env(filing, scope);
          if (a.when && evalPred(a.when, env) !== true) continue;
          const v = evalPred(a.assert, env);
          if (v === true) this.out(ctx, r, scope, 'PASS', r.text);
          else if (v === false) this.out(ctx, r, scope, 'FAIL', `${this.label(r.subject)}: ${r.text}`);
        }
        return;
      }
      case 'iffEntered': {
        const [p, q] = a.concepts;
        for (const scope of this.scopes(r, filing)) {
          const ctxs = new Map();
          for (const c of a.concepts) for (const f of this.factsIn(filing, c, scope)) ctxs.set(dimKey(f.dims), f.dims);
          for (const dims of ctxs.values()) {
            const hp = filing.value(p, scope, dims) != null, hq = filing.value(q, scope, dims) != null;
            if (hp && hq) this.out(ctx, r, scope, 'PASS', r.text);
            else this.out(ctx, r, scope, 'FAIL', `${this.label(hp ? q : p)} is required because ${this.label(hp ? p : q)} is entered${dims.length ? ' [' + dimKey(dims) + ']' : ''}`, { concept: hp ? q : p, dims });
          }
        }
        return;
      }
      case 'memberMandatory': {
        // v15.1 — as the MCA validator reads it: every context of the element's period type (a duration, for the
        // "Nature of other …" elements) that carries the member and any value — of any element, e.g. useful lives in the
        // additional-information table — must carry the element on the same members; contexts at a balance date only
        // (amounts) are not checked. MCA: "Element 'NatureOfOtherIntangibleAssets' is not present: on explicit-members:
        // {IntangibleAssetsOtherThanInternallyGeneratedMember, OtherIntangibleAssetsOthersMember} for date:31/03/2025"
        // (a context holding useful lives and the amortisation method); not reported for loans and advances – others
        // given at the balance date only (an MCA-accepted filing).
        const pt = this.A.concept(a.concept)?.periodType;
        for (const scope of this.scopes(r, filing)) {
          const ctxs = new Map();
          for (const f of filing.all()) if (!f.nil && f.period.type === pt && reportingYear(filing.meta.periods, f.period) === scope && f.dims.some((d) => d.member === a.member)) ctxs.set(dimKey(f.dims), f.dims);
          for (const dims of ctxs.values()) {
            if (!dimensionallyValid(this.A, a.concept, dims).valid) continue;
            if (filing.value(a.concept, scope, dims) != null) this.out(ctx, r, scope, 'PASS', r.text);
            else this.out(ctx, r, scope, 'FAIL', `${this.label(a.concept)} is mandatory for ${this.label(a.member)} [${dimKey(dims)}]`, { concept: a.concept, dims });
          }
        }
        return;
      }
      case 'tableRequired': {
        for (const scope of this.scopes(r, filing)) {
          const elrOk = a.tables.some((t) => this.app.elrStatus(filing, this.A.table(t).presentationElr, scope).applicable);
          if (!elrOk) continue;
          const v = evalPred(a.when, this.env(filing, scope));
          if (v !== true) continue;
          const has = this.tableHasData(filing, a.tables, scope);
          this.out(ctx, r, scope, has ? 'PASS' : 'FAIL', has ? r.text : `Table ${this.label(this.A.table(a.tables[0]).hypercube)} is mandatory for ${scope}: ${r.text}`);
        }
        return;
      }
      case 'tableIffMembers': {
        for (const scope of this.scopes(r, filing)) {
          const members = this.app.membersHaveData(filing, scope, a.otherTables, a.axis, a.members);
          const table = this.tableHasData(filing, a.tables, scope);
          if (!members && !table) continue;
          this.out(ctx, r, scope, members === table ? 'PASS' : 'FAIL', members === table ? r.text : members ? 'DetailsOfBondsOrDebenturesTable is mandatory because Bonds/Debentures borrowings are reported' : 'Bonds/Debentures borrowings must be reported because DetailsOfBondsOrDebenturesTable is provided');
        }
        return;
      }
      case 'groupSum': {
        for (const scope of this.scopes(r, filing)) {
          const groups = new Map();
          const tol = new Map();
          for (const f of this.factsIn(filing, a.concept, scope)) {
            const g = f.dims.find((d) => d.axis === a.groupAxis);
            if (!g || !this.isUnder(a.groupAxis, g.member, a.groupUnder)) continue;
            const k = g.member;
            groups.set(k, Dec.add(groups.get(k) || Dec.ZERO, Dec.parse(f.value)));
            // each reported percentage is accurate to its decimals (±½ unit of the last place)
            const dd = f.decimals == null || f.decimals === 'INF' ? null : Number(f.decimals);
            if (dd != null) tol.set(k, Dec.add(tol.get(k) || Dec.ZERO, Dec.shift(Dec.parse('5'), -(dd + 1))));
          }
          for (const [m, total] of groups) {
            const ok = Dec.cmp(Dec.sub(total, tol.get(m) || Dec.ZERO), Dec.parse(a.limit)) <= 0;
            const tbl = this.A.tablesForConcept(a.concept).find((t) => t.axes.some((x) => x.axis === a.groupAxis) && t.axes.some((x) => x.axis === a.sumAxis));
            this.out(ctx, r, scope, ok ? 'PASS' : 'FAIL', ok ? r.text : `Σ ${this.label(a.concept)} for ${this.label(m)} = ${Dec.toString(total)} exceeds ${a.limit} (100%)`, tbl ? { tableId: tbl.id, concept: null } : {});
          }
        }
        return;
      }
      case 'unique': {
        const tables = (a.tables || []).map((id) => this.A.table(id)).filter(Boolean);
        const axes = new Set(tables.flatMap((t) => t.axes.map((x) => x.axis)));
        for (const scope of this.scopes(r, filing)) {
          const facts = this.factsIn(filing, a.concept, scope).filter((f) => !axes.size || (f.dims.length && f.dims.every((d) => axes.has(d.axis))));
          if (!facts.length) continue;
          const seen = new Map();
          for (const f of facts) { const k = String(f.value).trim().toUpperCase(); (seen.get(k) || seen.set(k, []).get(k)).push(f); }
          const dups = [...seen.entries()].filter(([, fs]) => fs.length > 1);
          if (!dups.length) this.out(ctx, r, scope, 'PASS', r.text);
          for (const [v, fs] of dups) this.out(ctx, r, scope, 'FAIL', `${this.label(a.concept)} '${v}' is entered for ${fs.length} members [${fs.map((f) => dimKey(f.dims)).join(' | ')}]: ${r.text}`, { factKey: fs[1].key });
        }
        return;
      }
      case 'memberArith': {
        const def = this.A.dimensionDefault(a.axis);
        const withMember = (dims, m) => (m === def ? dims : [...dims, { axis: a.axis, member: m }]);
        for (const scope of this.scopes(r, filing)) {
          for (const f of this.factsIn(filing, a.concept, scope)) {
            if (!f.dims.some((d) => d.axis === a.axis && d.member === a.plus[0])) continue;
            const others = f.dims.filter((d) => d.axis !== a.axis);
            const val = (m) => { const v = filing.value(a.concept, scope, withMember(others, m)); return v == null ? null : Dec.parse(v); };
            const target = val(a.target);
            const parts = [...a.plus.map((m) => val(m)), ...a.minus.map((m) => val(m))];
            if (target == null || parts.some((x) => x == null)) continue;
            const computed = Dec.sub(Dec.sum(parts.slice(0, a.plus.length)), Dec.sum(parts.slice(a.plus.length)));
            const okv = Dec.eq(target, computed);
            this.out(ctx, r, scope, okv ? 'PASS' : 'FAIL', okv ? r.text : `${this.label(a.concept)}${others.length ? ' [' + dimKey(others) + ']' : ''}: ${this.label(a.target)} ${Dec.toString(target)} ≠ ${Dec.toString(computed)} (${a.plus.map((m) => this.label(m)).join(' + ')} − ${a.minus.map((m) => this.label(m)).join(' − ')})`, { factKey: f.key });
          }
        }
        return;
      }
      case 'tableOneComplete': {
        const except = new Set(a.except || []);
        for (const id of a.tables) {
          const t = this.A.table(id);
          for (const scope of this.scopes(r, filing)) {
            const groups = this.tableGroups(filing, t, scope);
            if (!groups.size) continue;
            // v15.1: "all details" = the elements MCA's mandatory-line-items sheet names for this table, when it has a rule
            // for it — "DetailsOfDirectorsSigningFinancialStatementsTable: All elements mandatory except MiddleNameOfDirector
            // and LastNameOfDirector" (ML-35 / ML-38; ML-34 for auditors). A director without a middle name was "not
            // complete" for SR-L3762-2 / SR-L3851-2, which the MCA validator does not report.
            const ml = this.A.rules.rules.filter((x) => x.status === 'EXECUTABLE' && x.ast?.type === 'lineItemsMandatory' && x.ast.tables.includes(id));
            const named = ml.length ? new Set(ml.flatMap((x) => x.ast.concepts)) : null;
            const items = t.lineItems.filter((q) => (!named || named.has(q)) && !except.has(q) && !this.A.concept(q)?.abstract && this.app.conceptStatus(filing, q, scope).applicable);
            const complete = [...groups.values()].some((dims) => items.every((q) => !dimensionallyValid(this.A, q, dims).valid || filing.value(q, scope, dims) != null));
            this.out(ctx, r, scope, complete ? 'PASS' : 'FAIL', complete ? r.text : `Table ${this.label(t.hypercube)}: no member has all details entered (${r.text})`);
          }
        }
        return;
      }
      case 'lineItemSingleMember': {
        for (const id of a.tables) {
          const t = this.A.table(id);
          const items = new Set(t.lineItems);
          const axes = new Set(t.axes.map((x) => x.axis));
          for (const scope of this.scopes(r, filing)) {
            const where = new Map();
            for (const f of filing.all()) {
              if (!items.has(f.concept) || f.nil || !f.dims.length || !f.dims.every((d) => axes.has(d.axis)) || reportingYear(filing.meta.periods, f.period) !== scope) continue;
              (where.get(f.concept) || where.set(f.concept, new Set()).get(f.concept)).add(dimKey(f.dims));
            }
            if (!where.size) continue;
            const multi = [...where.entries()].filter(([, ks]) => ks.size > 1);
            if (!multi.length) this.out(ctx, r, scope, 'PASS', r.text);
            // v14.5: located at the line item (its first column) so that it opens and offers "keep it under one member"
            for (const [q, ks] of multi) this.out(ctx, r, scope, 'FAIL', `${this.label(q)} is provided against ${ks.size} members [${[...ks].join(' | ')}]: ${r.text}`, { concept: q, dims: filing.all().find((f) => f.concept === q && !f.nil && dimKey(f.dims) === [...ks][0] && reportingYear(filing.meta.periods, f.period) === scope)?.dims || [], tableId: id });
          }
        }
        return;
      }
      case 'cashFlowMethod': {
        const type = filing.value(a.concept, 'CY', []);
        if (type == null) return;
        const other = { 'Direct Method': '100400', 'Indirect Method': '100300' }[type];
        if (!other) return;
        const mine = other === '100400' ? '100300' : '100400';
        let bad = 0;
        for (const f of filing.all()) {
          if (f.nil) continue;
          const codes = this.A.conceptElrs(f.concept).map((u) => this.A.elr(u).code.slice(0, 6));
          if (codes.includes(other) && !codes.includes(mine) && codes.every((c) => c === other || c === '100300' || c === '100400')) {
            bad++;
            this.out(ctx, r, reportingYear(filing.meta.periods, f.period), 'FAIL', `'${this.label(f.concept)}' belongs only to the ${other === '100300' ? 'direct' : 'indirect'}-method cash flow statement but TypeOfCashFlowStatement is '${type}'`, { factKey: f.key });
          }
        }
        if (!bad) this.out(ctx, r, 'CY', 'PASS', r.text);
        return;
      }
      case 'lineItemsMandatory': return this.lineItems(r, ctx);
      case 'generic': return this.generic(r, ctx);
      default: throw new Error(`Unknown rule AST type ${a.type}`);
    }
  }

  isUnder(axis, member, ancestor) {
    let m = member;
    for (let i = 0; i < 20 && m; i++) { if (m === ancestor) return true; m = this.A.memberParent(axis, m); }
    return false;
  }

  tableGroups(filing, t, scope) {
    const items = new Set(t.lineItems);
    const axes = new Set(t.axes.map((x) => x.axis));
    const groups = new Map();
    for (const f of filing.all()) {
      if (!items.has(f.concept) || f.nil || !f.dims.length || !f.dims.every((d) => axes.has(d.axis))) continue;
      if (reportingYear(filing.meta.periods, f.period) !== scope || filing.scopeOf(f.period) === 'PYO') continue;
      groups.set(dimKey(f.dims), f.dims);
    }
    return groups;
  }

  tableHasData(filing, tableIds, scope) {
    for (const id of tableIds) {
      const t = this.A.table(id);
      const items = new Set(t.lineItems);
      const axes = new Set(t.axes.map((x) => x.axis));
      if (filing.all().some((f) => items.has(f.concept) && !f.nil && f.dims.length && f.dims.every((d) => axes.has(d.axis)) && reportingYear(filing.meta.periods, f.period) === scope)) return true;
    }
    return false;
  }

  mandatory(r, ctx) {
    const { filing } = ctx;
    const a = r.ast;
    for (const scope of this.scopes(r, filing)) {
      if (!this.app.conceptStatus(filing, a.concept, scope).applicable) continue;
      if (a.when) { const v = evalPred(a.when, this.env(filing, scope)); if (v !== true) continue; }
      const nd = filing.value(a.concept, scope, []) != null;
      const any = nd || this.factsIn(filing, a.concept, scope).length > 0;
      this.out(ctx, r, scope, any ? 'PASS' : 'FAIL', any ? r.text : `'${this.label(a.concept)}' is mandatory — not present for ${scope} (${scope === 'CY' ? filing.meta.periods.cy.end : filing.meta.periods.py.end})`, { concept: a.concept });
    }
  }

  lineItems(r, ctx) {
    const { filing } = ctx;
    const a = r.ast;
    for (const id of a.tables) {
      const t = this.A.table(id);
      const items = new Set(t.lineItems);
      const axes = new Set(t.axes.map((x) => x.axis));
      for (const scope of this.scopes(r, filing)) {
        if (!this.app.tableStatus(filing, id, scope).applicable && !this.tableHasData(filing, [id], scope)) continue;
        const groups = new Map();
        for (const f of filing.all()) {
          if (!items.has(f.concept) || f.nil || !f.dims.length || !f.dims.every((d) => axes.has(d.axis))) continue;
          if (!tablesForFact(this.A, f).some((x) => x.hypercube === t.hypercube)) continue;
          if (reportingYear(filing.meta.periods, f.period) !== scope || filing.scopeOf(f.period) === 'PYO') continue;
          groups.set(dimKey(f.dims), f.dims);
        }
        // v14.5: a table whose line items may be given against one member only (SR-L3717-1, [400200] auditor's report):
        // each mandatory line item is required once, under any one member — not in every column (that would contradict
        // SR-L3717-1 and could never be satisfied)
        if (groups.size && singleMemberTables(this.A).has(id)) {
          const cols = [...groups.values()];
          const count = (dims) => a.concepts.filter((q) => filing.value(q, scope, dims) != null).length;
          const main = cols.reduce((b, d) => (count(d) > count(b) ? d : b), cols[0]); // the column where most are given
          const missing = a.concepts.filter((q) => this.app.conceptStatus(filing, q, scope).applicable
            && cols.some((dims) => dimensionallyValid(this.A, q, dims).valid)
            && !cols.some((dims) => filing.value(q, scope, dims) != null));
          if (missing.length) this.out(ctx, r, scope, 'FAIL', `Table ${this.label(t.hypercube)} mandatory element(s) [${missing.map((q) => this.label(q)).join(', ')}] not present under any member for ${scope} (each is required once, under one member)`, { concept: missing.find((q) => dimensionallyValid(this.A, q, main).valid) || missing[0], dims: main, tableId: id });
          else this.out(ctx, r, scope, 'PASS', r.text);
          continue;
        }
        for (const dims of groups.values()) {
          const missing = [];
          for (const q of a.concepts) {
            if (!dimensionallyValid(this.A, q, dims).valid) continue; // notAll exemption
            if (!this.app.conceptStatus(filing, q, scope).applicable) continue;
            if (filing.value(q, scope, dims) == null) missing.push(this.label(q));
          }
          for (const grp of a.atLeastOne || []) {
            const valid = grp.filter((q) => dimensionallyValid(this.A, q, dims).valid);
            if (valid.length && !valid.some((q) => filing.value(q, scope, dims) != null)) missing.push(`at least one of ${valid.length} elements under the transactions abstract`);
          }
          const firstMissing = a.concepts.find((q) => dimensionallyValid(this.A, q, dims).valid && this.app.conceptStatus(filing, q, scope).applicable && filing.value(q, scope, dims) == null) || (a.atLeastOne || []).flat().find((q) => dimensionallyValid(this.A, q, dims).valid) || null;
          // v15.1: elements an MCA-accepted filing omits (golden-DIVERGENCES.json "concepts") are reported, not blocking
          const soft = new Set((a.softConcepts || []).map((q) => this.label(q)));
          const hard = missing.filter((m) => !soft.has(m));
          if (missing.length && !hard.length) this.out(ctx, r, scope, 'WARN', `Table ${this.label(t.hypercube)} element(s) [${missing.join(', ')}] not present on [${dimKey(dims)}] for ${scope} — not blocking: ${r.softEvidence}`, { concept: firstMissing, dims, tableId: id });
          else if (missing.length) this.out(ctx, r, scope, 'FAIL', `Table ${this.label(t.hypercube)} mandatory element(s) [${missing.join(', ')}] not present on [${dimKey(dims)}] for ${scope}`, { concept: firstMissing, dims, tableId: id });
          else this.out(ctx, r, scope, 'PASS', r.text);
        }
      }
    }
  }

  calcExemptions() {
    if (this._calcExempt) return this._calcExempt;
    const ex = new Set();
    const A = this.A;
    for (const e of A.rules.exemptions.calculation) {
      if (e.abstract) {
        const desc = new Set();
        for (const uri of A.conceptElrs(e.abstract)) {
          const stack = [e.abstract];
          while (stack.length) { const c = stack.pop(); for (const arc of A.presentationChildren(uri, c)) { desc.add(arc.to); stack.push(arc.to); } }
        }
        for (const q of desc) if (e.mode !== 'except' || !e.concepts.includes(q)) ex.add(q);
      } else if (e.mode === 'listed') for (const q of e.concepts) ex.add(q);
    }
    for (const q of this._mandatoryConcepts) ex.delete(q); // "In case an element is mandatory, then the same shall not be exempt"
    this._calcExempt = ex;
    return ex;
  }

  generic(r, ctx) {
    const { filing } = ctx;
    const A = this.A;
    const h = r.ast.handler;
    const P = filing.meta.periods;
    switch (h) {
      case 'calc-parent-child': {
        const isElrApplicable = (elr) => {
          const code = A.json.roles[elr]?.code?.slice(0, 6);
          const pres = A.elrs.find((e) => e.code === code);
          return pres ? this.app.elrStatus(filing, pres.uri, 'CY').applicable : true;
        };
        const calc = runCalculations(A, filing, { isElrApplicable });
        ctx.calc = calc;
        const ex = this.calcExemptions();
        const reported = new Set();
        for (const c of calc) {
          if (c.status === CalcStatus.FAIL) {
            const exempt = c.children.some((k) => ex.has(k.concept)) || c.missingChildren.some((q) => ex.has(q));
            this.out(ctx, r, reportingYear(P, c.period), exempt ? 'WARN' : 'FAIL', `Calculation inconsistency in ${A.json.roles[c.elr]?.definition || c.elr}: ${this.label(c.parent)} reported ${c.reported} ≠ Σ children ${c.computed}${c.dims.length ? ' [' + dimKey(c.dims) + ']' : ''}`, { factKey: c.factKey, calc: true });
          } else if (c.status === CalcStatus.INSUFFICIENT_DATA) {
            const pf = filing.facts.get(c.factKey);
            if (!pf || Dec.isZero(Dec.parse(pf.value))) continue;
            // a parent with networks in several ELRs is satisfied when any of them has children in this context
            if (calc.some((o) => o.factKey === c.factKey && o.status !== CalcStatus.INSUFFICIENT_DATA && o.status !== CalcStatus.NOT_APPLICABLE)) continue;
            if (reported.has(c.factKey)) continue;
            reported.add(c.factKey);
            const net = A.json.calculation[c.elr].filter((x) => x.from === c.parent);
            if (net.every((x) => ex.has(x.to))) continue;
            // a network whose children cannot be reported in this context does not apply to it
            if (!net.some((x) => dimensionallyValid(A, x.to, c.dims).valid)) continue;
            this.out(ctx, r, reportingYear(P, c.period), 'FAIL', `${this.label(c.parent)} is entered (non-zero) but none of its calculation children are entered (${A.json.roles[c.elr]?.definition})${c.dims.length ? ' [' + dimKey(c.dims) + ']' : ''}`, { factKey: c.factKey });
          } else if (c.status === CalcStatus.PASS) this.out(ctx, r, reportingYear(P, c.period), 'PASS', 'calculation consistent');
        }
        // vice-versa: child entered (non-zero) => parent entered in same context, within applicable ELRs
        const parentsOf = new Map();
        for (const [elr, arcs] of Object.entries(A.json.calculation)) {
          if (!isElrApplicable(elr)) continue;
          for (const a of arcs) (parentsOf.get(a.to) || parentsOf.set(a.to, []).get(a.to)).push({ elr, parent: a.from });
        }
        for (const f of filing.all()) {
          if (f.nil || !parentsOf.has(f.concept) || ex.has(f.concept) || !A.isNumeric(f.concept) || Dec.isZero(Dec.parse(f.value))) continue;
          const ps = parentsOf.get(f.concept);
          const ok = ps.some((p) => filing.get(p.parent, f.period, f.dims) || !dimensionallyValid(A, p.parent, f.dims).valid || A.concept(p.parent).periodType !== A.concept(f.concept).periodType);
          // a previous-year opening value (dated the day before the previous year starts): say so — its total usually
          // has no cell for that date (the balance sheet has none), so the opening value itself is cleared
          const pyo = scopeOf(P, f.period) === 'PYO' ? ` — a previous-year opening value (dated ${f.period.date}); MCA requires its total for that date as well. Previous-year opening balances are optional: clear this value, or remove every such value with Validation → Fix tools → “Remove opening values without totals”` : '';
          if (!ok) this.out(ctx, r, reportingYear(P, f.period), 'FAIL', `${this.label(f.concept)} is entered but its calculation parent ${ps.map((p) => this.label(p.parent)).join(' / ')} is not${f.dims.length ? ' [' + dimKey(f.dims) + ']' : ''}${pyo}`, { factKey: f.key });
        }
        return;
      }
      case 'mandatory-line-items-driver': this.out(ctx, r, null, 'PASS', 'Executed through the ML-* rules (one per table in sheet "Mandatory Line Items")'); return;
      case 'dimension-parent-child-members': {
        const exC = A.rules.exemptions.childMember;
        const excluded = new Set(r.ast.excludedLineItems);
        for (const f of filing.all()) {
          if (f.nil || !f.dims.length || excluded.has(f.concept)) continue;
          const tables = tablesForFact(A, f);
          const tnames = tables.map((t) => t.hypercube.split(':')[1]);
          const scope = reportingYear(P, f.period);
          for (const d of f.dims) {
            if (!d.member) continue;
            const info = A.axisInfo(d.axis);
            const parent = gr3RequiredParent(A, d.axis, d.member, tnames);
            // v15.1: an amount of 0 under a child member does not require its parent member — as GR-1 ("applicable only if
            // amount entered is not zero"): an MCA-accepted filing reports a whole column of zeros under Other intangible
            // assets – others without Other intangible assets
            const zero = A.isNumeric(f.concept) && Dec.isDecimalString(String(f.value)) && Dec.isZero(Dec.parse(f.value));
            {
              if (parent && !zero) {
                const pd = f.dims.map((x) => (x.axis === d.axis ? { axis: x.axis, member: parent } : x));
                // v15.1: the parent member is present also where it is reported without one of the child's other axes
                // (Buildings with Gross carrying amount, for Factory building with Gross carrying amount and Owned assets): an
                // MCA-accepted filing reports the extra split (owned / leased) only for the child members
                const others = f.dims.filter((x) => x.axis !== d.axis);
                const rolledUp = () => filing.factsOf(f.concept).some((g) => !g.nil && JSON.stringify(g.period) === JSON.stringify(f.period) && g.dims.some((x) => x.axis === d.axis && x.member === parent)
                  && g.dims.every((x) => x.axis === d.axis || others.some((o) => o.axis === x.axis && o.member === x.member && o.typed === x.typed)));
                if (dimensionallyValid(A, f.concept, pd).valid && !filing.get(f.concept, f.period, pd) && !rolledUp()) {
                  this.out(ctx, r, scope, 'FAIL', `The parent member {${this.label(parent)}} for element '${this.label(f.concept)}' should be present for axis (${this.label(d.axis)}) — child {${this.label(d.member)}} is reported`, { factKey: f.key });
                }
              }
            }
            const kids = [...info.parents.entries()].filter(([, p]) => p === d.member).map(([m]) => m).filter((m) => info.members.get(m)?.usable);
            if (kids.length && !exC.some((e) => e.axis === d.axis && e.member === d.member && tnames.includes(e.table))) {
              const anyKid = kids.some((k) => filing.get(f.concept, f.period, f.dims.map((x) => (x.axis === d.axis ? { axis: x.axis, member: k } : x))));
              const kidValid = kids.some((k) => dimensionallyValid(A, f.concept, f.dims.map((x) => (x.axis === d.axis ? { axis: x.axis, member: k } : x))).valid);
              if (!anyKid && kidValid) this.out(ctx, r, scope, 'FAIL', `At least one child member of {${this.label(d.member)}} should be present for element '${this.label(f.concept)}' on axis (${this.label(d.axis)})`, { factKey: f.key });
            }
          }
        }
        return;
      }
      case 'sequential-members': {
        const groups = new Map();
        // "members defined as 1, 2, 3 … n" = members defined in the taxonomy (EquityShares1Member, Shareholder1Member,
        // FinancialYearMember1 …). Typed members are free identifiers chosen by the filer: the MCA-validated FILING-A
        // instance uses "_<name>_2" / "<name>_17" style values without 1.
        for (const f of filing.all()) for (const d of f.dims) {
          if (!d.member) continue;
          const k = `${d.axis}|${reportingYear(P, f.period)}`;
          (groups.get(k) || groups.set(k, new Set()).get(k)).add(d.member.split(':')[1]);
        }
        for (const [k, vals] of groups) {
          const [axis, scope] = k.split('|');
          const gaps = sequentialGaps([...vals]);
          if (gaps.length) for (const g of gaps) this.out(ctx, r, scope, 'FAIL', `Members on (${this.label(axis)}) are not sequential: ${g.prefix}${g.missing} missing while ${g.prefix}${g.max} is provided`);
          else this.out(ctx, r, scope, 'PASS', 'sequential');
        }
        return;
      }
      case 'no-images': {
        for (const f of filing.all()) if (!f.nil && !A.isNumeric(f.concept) && /<img\b|data:image\/|<svg\b|<object\b|<embed\b/i.test(f.value)) this.out(ctx, r, reportingYear(P, f.period), 'FAIL', `Images/charts are not allowed (${this.label(f.concept)})`, { factKey: f.key });
        return;
      }
      case 'cy-py-pairing': {
        if (filing.meta.firstFinancialYear) { this.out(ctx, r, null, 'NOT_APPLICABLE', 'First financial year'); return; }
        const exemptElr = new Set(r.ast.exemptElrCodes);
        for (const f of filing.all()) {
          if (f.nil || !A.isMonetary(f.concept)) continue;
          const scope = filing.scopeOf(f.period);
          if (scope !== 'CY' && scope !== 'PY') continue;
          const elrs = A.conceptElrs(f.concept).map((u) => A.elr(u).code.slice(0, 6));
          if (elrs.length && elrs.every((c) => exemptElr.has(c))) continue;
          // "this rule shall not be applicable in case of dimensional tables. However, in case the table itself is
          // mandatory ... the previous year figures shall be made as mandatory" — the table must carry previous-year
          // figures (enforced per year by the table rules), not every member combination of the other year: the
          // MCA-validated FILING-A instance has borrowing / investment rows reported in one year only.
          if (f.dims.length) continue;
          const other = scope === 'CY' ? 'PY' : 'CY';
          if (!this.app.conceptStatus(filing, f.concept, other).applicable) continue;
          const op = filing.period(f.concept, other);
          if (!filing.get(f.concept, op, f.dims)) this.out(ctx, r, scope, 'FAIL', `Since '${this.label(f.concept)}' is entered for the ${scope === 'CY' ? 'current' : 'previous'} year, the corresponding ${other === 'CY' ? 'current' : 'previous'}-year value should be entered${f.dims.length ? ' [' + dimKey(f.dims) + ']' : ''}`, { factKey: f.key, locateMissing: { concept: f.concept, scope: other } });
        }
        return;
      }
      case 'opening-equals-prior-closing': this.out(ctx, r, null, 'PASS', 'Structural: CY opening and PY closing balances share one instant context in the filing model'); return;
      case 'monetary-max-2-decimals': {
        for (const f of filing.all()) {
          if (f.nil || !A.isMonetary(f.concept)) continue;
          const fd = Dec.fractionDigits(Dec.parse(f.value));
          if (fd > 2 || (f.decimals !== 'INF' && Number(f.decimals) > 2)) this.out(ctx, r, reportingYear(P, f.period), 'FAIL', `'${this.label(f.concept)}' has more than 2 decimal places`, { factKey: f.key });
        }
        return;
      }
      case 'inr-currency': {
        const exemptTables = new Set(r.ast.exemptTables);
        for (const f of filing.all()) {
          if (f.nil || !A.isMonetary(f.concept) || f.unit === 'INR') continue;
          if (tablesForFact(A, f).some((t) => exemptTables.has(t.id))) continue;
          this.out(ctx, r, reportingYear(P, f.period), 'FAIL', `Reporting currency should be INR for '${this.label(f.concept)}' (unit ${f.unit})`, { factKey: f.key });
        }
        return;
      }
      case 'elr-not-for-consolidated': case 'elr-not-for-prior-year': case 'elr-not-for-standalone': case 'general-info-consolidated': {
        for (const f of filing.all()) {
          const scope = reportingYear(P, f.period);
          if (scope !== 'CY' && scope !== 'PY') continue;
          const st = this.app.conceptStatus(filing, f.concept, scope);
          if (st.applicable) continue;
          const tag = { 'elr-not-for-consolidated': 'GR-11', 'elr-not-for-prior-year': 'GR-12', 'elr-not-for-standalone': 'GR-14', 'general-info-consolidated': 'GR-13' }[h];
          const mine = st.reasons.filter((x) => x.startsWith(tag));
          if (mine.length && mine.length === st.reasons.filter((x) => /^GR-1[1-4]/.test(x)).length) this.out(ctx, r, scope, 'FAIL', `'${this.label(f.concept)}' must not be reported: ${mine.join('; ')}`, { factKey: f.key });
        }
        if (h === 'general-info-consolidated') this.out(ctx, r, null, 'REVIEW_ONLY_EXTERNAL_DATA', 'Equality of general-information values between the standalone and consolidated instance documents requires the other instance document');
        return;
      }
      case 'mandatory-axes': {
        for (const [tname, axesLocal] of Object.entries(r.ast.tables)) {
          for (const t of A.tables.filter((x) => x.hypercube.split(':')[1] === tname)) {
            const items = new Set(t.lineItems);
            const tAxes = new Set(t.axes.map((x) => x.axis));
            for (const f of filing.all()) {
              if (!items.has(f.concept) || !f.dims.length || !f.dims.every((d) => tAxes.has(d.axis))) continue;
              for (const al of axesLocal) {
                const ax = A.qnameOfLocal(al);
                // v14.5: "using default member (if applicable)" — not applicable where the table marks the default not usable
                const def = A.dimensionDefault(ax);
                // (a fact valid in another table that shares these axes — e.g. a share-class column of the share capital
                // table — is that table's fact, not a column of this one)
                const defOk = (def && t.axes.find((x) => x.axis === ax)?.members.some((m) => m.member === def && m.usable)) || (def && dimensionallyValid(A, f.concept, f.dims).valid);
                if (!f.dims.some((d) => d.axis === ax) && !defOk) this.out(ctx, r, reportingYear(P, f.period), 'FAIL', `Axis (${al}) is mandatory for table ${tname}`, { factKey: f.key });
              }
            }
          }
        }
        return;
      }
      case 'taxonomy-period-applicability': {
        const start = P.cy.start;
        if (!start) return;
        this.out(ctx, r, 'CY', start >= r.ast.from ? 'PASS' : 'FAIL', start >= r.ast.from ? 'C&I Taxonomy 2016 applies' : `C&I Taxonomy 2016 applies only to financial years commencing on or after ${r.ast.from}`);
        return;
      }
      default: throw new Error(`No generic handler ${h}`);
    }
  }
}
