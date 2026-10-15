#!/usr/bin/env node
// Read-only operational probe for plan blueprint-backed-work-item-execution-2026-09-23.
//
// P-001 (owner review) and P-002 (source/design baseline) are audited `not-code`: they
// edited no product source by design. Their realization is a set of recorded facts, so
// this probe re-measures those facts from the live Papercusp database instead of citing
// prose. It backs two enforceable spec clauses (WI-10006332, owner directive #1410):
//
//   BBWE-R-1-P-001-owner-scope        R-1's direct-item scope traces to Avi's reviewed
//                                     turn-63 correction, and implementation was
//                                     authorized by owner turn 107 before activation.
//   BBWE-R-10-P-002-budgets-declared  The fixed workloads and budgets R-10 judges were
//                                     declared in D-016 before any R-10 measurement and
//                                     before P-013 was claimed.
//
// Usage:  node docs/evidence/bbwe-not-code-realization-probe-2026-10-06.mjs [--out <file>]
// Env:    PROBE_PSQL overrides the psql command (default: sudo -n -u postgres psql -d papercusp).
// Exit:   0 when every assertion passes, 1 when any fails, 2 when the database is unreachable.
// Writes nothing to the database; every statement is a SELECT.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const PLAN = 'blueprint-backed-work-item-execution-2026-09-23';
const SESSION = '01a0cf8f-d604-70a1-9760-a39906275e5f';
const SCOPE = `workspace_id='papercusp-workspace' AND harness_slug='papercusp'`;
const psqlCmd = (process.env.PROBE_PSQL ?? 'sudo -n -u postgres psql -d papercusp').split(/\s+/);

function rows(sql) {
  const out = execFileSync(psqlCmd[0], [...psqlCmd.slice(1), '-At', '-v', 'ON_ERROR_STOP=1', '-c',
    `SELECT coalesce(json_agg(x), '[]'::json) FROM (${sql}) x`], { encoding: 'utf8' });
  return JSON.parse(out.trim() || '[]');
}

const startedAt = new Date().toISOString();
const assertions = [];
const check = (id, passed, evidence) => assertions.push({ id, passed: Boolean(passed), evidence });

let unreachable = null;
try {
  // ── P-001 / R-1 ────────────────────────────────────────────────────────────
  const turns = Object.fromEntries(rows(`
    SELECT turn_idx, speaker, ts, text FROM harness_shared.session_turns
     WHERE source_kind='codex' AND session_id='${SESSION}' AND turn_idx IN (63,107,119)`)
    .map((t) => [t.turn_idx, t]));
  const t63 = turns[63], t107 = turns[107], t119 = turns[119];
  check('p001-owner-correction-turn-63',
    t63?.speaker === 'user' && /create work items directly/i.test(t63.text) && /skip the plan step/i.test(t63.text),
    `codex:${SESSION}:63 speaker=${t63?.speaker} at ${t63?.ts}: owner asks that blueprints create work items directly and that small well-defined tasks skip the plan step (R-1's direct-invocation scope).`);
  check('p001-owner-approval-turn-107',
    t107?.speaker === 'user' && /implement the plan yourself now from start to finish/i.test(t107.text),
    `codex:${SESSION}:107 speaker=${t107?.speaker} at ${t107?.ts}: "${t107?.text?.slice(0, 120)}".`);
  check('p001-owner-carry-turn-119',
    t119?.speaker === 'user' && /carry this plan to shipped status/i.test(t119.text),
    `codex:${SESSION}:119 speaker=${t119?.speaker} at ${t119?.ts}: "${t119?.text?.slice(0, 120)}".`);

  const [d015] = rows(`SELECT d->>'body' body FROM harness_shared.harness_plans p, jsonb_array_elements(p.decisions) d
     WHERE p.${SCOPE.replaceAll(' AND ', ' AND p.')} AND p.plan_slug='${PLAN}' AND d->>'id'='D-015'`);
  check('p001-d015-reconciles-turn-63',
    /turn 63/.test(d015?.body ?? '') && /direct item and optional plan/i.test(d015?.body ?? ''),
    `D-015 (P-002 source contract and owner-surface baseline) records the reviewed owner correction: ${
      (d015?.body ?? '').match(/Owner corrections[^.]*\./)?.[0] ?? 'NOT FOUND'}`);

  const [act] = rows(`
    WITH a AS (SELECT audit_seq, created_at, activation FROM harness_shared.plan_audits
                WHERE ${SCOPE} AND plan_slug='${PLAN}' AND audit_kind='activation')
    SELECT (SELECT min(created_at) FROM a) AS first_activation,
           (SELECT max(audit_seq) FROM a) AS latest_seq,
           (SELECT m FROM a, jsonb_array_elements(a.activation->'mappings') m
             WHERE a.audit_seq=(SELECT max(audit_seq) FROM a) AND m->>'id'='M-019') AS m019,
           (SELECT m FROM a, jsonb_array_elements(a.activation->'mappings') m
             WHERE a.audit_seq=(SELECT max(audit_seq) FROM a) AND m->>'id'='M-021') AS m021`);
  const refs = (m) => (m?.sourceRefs ?? []).join(',');
  check('p001-activation-follows-approval',
    t107 && act?.first_activation && new Date(act.first_activation) > new Date(t107.ts) &&
      refs(act.m019).endsWith(':107') && (act.m019?.planTargets ?? []).includes('P-001') &&
      refs(act.m021).endsWith(':119') && ['P-001', 'P-002'].every((p) => (act.m021?.planTargets ?? []).includes(p)),
    `first activation audit ${act?.first_activation} follows turn 107 (${t107?.ts}); latest activation audit #${act?.latest_seq}: ` +
      `M-019 <- ${refs(act?.m019)} -> ${(act?.m019?.planTargets ?? []).join(',')}; M-021 <- ${refs(act?.m021)} -> ${(act?.m021?.planTargets ?? []).join(',')}.`);

  const [impl] = rows(`
    SELECT min(to_timestamp(created_ts / 1000.0)) AS first_impl_item, count(*) AS n
      FROM harness_shared.work_items
     WHERE source_plan_slug='${PLAN}'
       AND NOT (coalesce(source_plan_item_ids, '{}')::text[] && ARRAY['P-001','P-002'])`);
  check('p001-implementation-after-approval',
    t107 && impl?.first_impl_item && new Date(impl.first_impl_item) > new Date(t107.ts),
    `${impl?.n} implementation work items promoted from the plan; earliest created ${impl?.first_impl_item}, after owner approval turn 107 (${t107?.ts}).`);

  const items = Object.fromEntries(rows(`
    SELECT i->>'id' id, i->>'status' status FROM harness_shared.harness_plans p, jsonb_array_elements(p.items) i
     WHERE p.${SCOPE.replaceAll(' AND ', ' AND p.')} AND p.plan_slug='${PLAN}' AND i->>'id' IN ('P-001','P-002','P-013')`)
    .map((r) => [r.id, r.status]));
  check('p001-p002-items-done', items['P-001'] === 'done' && items['P-002'] === 'done',
    `plan item status: P-001=${items['P-001']}, P-002=${items['P-002']}, P-013=${items['P-013']}.`);

  // ── P-002 / R-10 ───────────────────────────────────────────────────────────
  const [d016] = rows(`SELECT d->>'body' body FROM harness_shared.harness_plans p, jsonb_array_elements(p.decisions) d
     WHERE p.${SCOPE.replaceAll(' AND ', ' AND p.')} AND p.plan_slug='${PLAN}' AND d->>'id'='D-016'`);
  const body = d016?.body ?? '';
  check('p002-d016-declares-fixed-workloads',
    /Date: 2026-09-24/.test(body) && /\(A\)/.test(body) && /\(B\)/.test(body) && /\(D\)/.test(body) && /frozen now/i.test(body),
    `D-016 "P-002 fixed workload and provisional performance budget" is dated 2026-09-24, defines workloads (A), (B), (D) and states its numeric limits are "prospective and frozen now"; first workload: ${
      body.match(/\(A\)[^,;]*/)?.[0] ?? 'NOT FOUND'}.`);

  const [timing] = rows(`
    SELECT (SELECT to_timestamp(min(created_at) / 1000.0) FROM harness_shared.plan_revisions -- created_at is epoch ms
             WHERE ${SCOPE} AND plan_slug='${PLAN}' AND position('D-016' in content_snapshot) > 0) AS d016_first_revision,
           (SELECT min(created_at) FROM harness_shared.spec_evidence_bindings
             WHERE ${SCOPE} AND plan_slug='${PLAN}' AND spec_id LIKE 'AUTO-BAR-R-10-%') AS first_r10_binding,
           (SELECT to_timestamp(min(coalesce(extract(epoch FROM first_claimed_at) * 1000, created_ts)) / 1000.0)
              FROM harness_shared.work_items WHERE feature_id='WI-10002948') AS p013_first_claim,
           (SELECT status FROM harness_shared.work_items WHERE feature_id='WI-10002929') AS p002_wi_status`);
  const before = (a, b) => a && b && new Date(a) < new Date(b);
  check('p002-d016-before-first-r10-measurement', before(timing?.d016_first_revision, timing?.first_r10_binding),
    `D-016 first appears in plan revision at ${timing?.d016_first_revision}; first R-10 evidence binding at ${timing?.first_r10_binding}.`);
  check('p002-d016-before-p013-claim', before(timing?.d016_first_revision, timing?.p013_first_claim),
    `D-016 first revision ${timing?.d016_first_revision} precedes P-013 work item WI-10002948 first claim ${timing?.p013_first_claim}; P-002 work item WI-10002929 status=${timing?.p002_wi_status}.`);
} catch (error) {
  unreachable = String(error?.message ?? error).slice(0, 500);
}

const finishedAt = new Date().toISOString();
const failed = assertions.filter((a) => !a.passed).map((a) => a.id);
const exitCode = unreachable ? 2 : failed.length ? 1 : 0;
const evidence = {
  schemaVersion: 1,
  kind: 'operational-test-evidence',
  name: 'BBWE not-code realization probe: P-001 owner review (R-1) and P-002 declared budgets (R-10)',
  framework: 'node',
  command: ['node', 'docs/evidence/bbwe-not-code-realization-probe-2026-10-06.mjs', '--out',
    'docs/evidence/bbwe-not-code-realization-2026-10-06.json'],
  exitCode,
  startedAt,
  finishedAt,
  summary: unreachable
    ? `Database unreachable; nothing measured: ${unreachable}`
    : `Read-only re-measurement against the live Papercusp database. ${assertions.length - failed.length}/${assertions.length} assertions passed` +
      (failed.length ? `; failed: ${failed.join(', ')}.` : '.') +
      ' P-001 realizes the owner review behind R-1 and authorized implementation before activation; P-002 declared the R-10 workloads and budgets before measurement or tuning.',
  assertions: assertions.length ? assertions : [{ id: 'database-reachable', passed: false, evidence: unreachable ?? 'no assertions ran' }],
};

const json = `${JSON.stringify(evidence, null, 2)}\n`;
const outIdx = process.argv.indexOf('--out');
if (outIdx > 0 && process.argv[outIdx + 1]) writeFileSync(process.argv[outIdx + 1], json);
process.stdout.write(json);
process.exit(exitCode);
