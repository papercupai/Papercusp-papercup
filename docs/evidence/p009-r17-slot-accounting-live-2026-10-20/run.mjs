#!/usr/bin/env node
// Live evidence for AUTO-BAR-R-17-P-009 (green-main-ratchet-convergence-2026-10-17, rubric rev 12).
// Runs the bar's registered probe and four negative controls against the operator database, lets the committed
// oracle (scripts/lib/sync-batch-coverage-accounting-oracle.mjs) take every pass/fail decision, and writes
// docs/evidence/p009-r17-slot-accounting-live-2026-10-20.json. Exit 0 only if the live probe passes AND every
// control fails. Usage (repo root): node docs/evidence/p009-r17-slot-accounting-live-2026-10-20/run.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { judgeR17, parseR17Row } from '../../../scripts/lib/sync-batch-coverage-accounting-oracle.mjs';

const DIR = 'docs/evidence/p009-r17-slot-accounting-live-2026-10-20';
const OUT = `${DIR}.json`;
const ORACLE = 'scripts/lib/sync-batch-coverage-accounting-oracle.mjs';
const ORACLE_TEST = 'scripts/lib/sync-batch-coverage-accounting-oracle.test.ts';
const SOURCES = [
  'packages/operator-core/lib/release/sync-batch-delta-check.ts',
  'packages/operator-core/lib/release/sync-batch-lint-guards.ts',
];
const CONTROLS = [
  { id: 'control-noalarm', file: `${DIR}/control-noalarm.sql`, what: 'alarm_open forced false: low coverage without an alarm must fail' },
  { id: 'control-stale', file: `${DIR}/control-stale.sql`, what: 'alarm freshness window moved into the future: a stale alarm must not count (H2)' },
  { id: 'control-terminal', file: `${DIR}/control-terminal.sql`, what: 'only terminal alarm rows match: a closed alarm must not count' },
  { id: 'control-floor', file: `${DIR}/control-floor.sql`, what: 'slot floor raised to 300 above the live 24h count: the probe must stop reporting accounted' },
];

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const blob = (p) => execFileSync('git', ['hash-object', p], { encoding: 'utf8' }).trim();
const psql = (file) =>
  execFileSync('sudo', ['-n', '-u', 'postgres', 'psql', '-d', 'papercusp', '-At', '-f', file], { encoding: 'utf8' }).trim();

const startedAt = new Date().toISOString();
const liveLine = psql(`${DIR}/probe.sql`);
const live = judgeR17(parseR17Row(liveLine));
const controls = CONTROLS.map((c) => {
  const line = psql(c.file);
  return { ...c, row: line, verdict: judgeR17(parseR17Row(line)) };
});
const finishedAt = new Date().toISOString();

const assertions = [
  ...live.assertions.map((a) => ({ id: `live:${a.id}`, passed: a.passed, evidence: `${a.evidence}; row ${liveLine}` })),
  ...controls.map((c) => ({
    id: `${c.id}:fails`,
    passed: c.verdict.passed === false,
    evidence: `${c.what}; row ${c.row}; oracle passed=${c.verdict.passed}; failing assertions: ${c.verdict.assertions.filter((a) => !a.passed).map((a) => a.id).join(',') || 'none'}`,
  })),
];
const ok = assertions.every((a) => a.passed);

const evidence = {
  schemaVersion: '1',
  kind: 'operational-test-evidence',
  name: 'P-009 / R-17 live sync-batch slot accounting on the operator database (green-main-ratchet-convergence-2026-10-17, rubric rev 12)',
  framework: 'operational',
  command: ['node', `${DIR}/run.mjs`],
  exitCode: ok ? 0 : 1,
  startedAt,
  finishedAt,
  plan: 'green-main-ratchet-convergence-2026-10-17',
  planItem: 'P-009',
  workItemId: 'WI-6554700010016943',
  specIds: ['AUTO-BAR-R-17-P-009@5'],
  evidencePlane: 'live',
  summary:
    `The R-17 probe (rubric rev 12 check, ${DIR}/probe.sql) read harness_shared.routines coverage records for sync-batch-delta-check and sync-batch-lint-guards plus their coverage-low alarm work-items, and returned ${liveLine}. ` +
    `The committed oracle judged it ${live.passed ? 'PASS' : 'FAIL'}: both routines present, every slot accounted, the slot floor met, and low coverage carrying a fresh open alarm. ` +
    `All four negative controls ${controls.every((c) => !c.verdict.passed) ? 'failed as required' : 'did NOT all fail'}. Coverage itself is about ${(parseR17Row(liveLine).min_ratio * 100).toFixed(1)}% of slots judged; the 95% target was rescoped out by owner choice (#D-036) and is not claimed here.`,
  assertions,
  environment: { database: 'papercusp (native PG :5432)', workspace: 'papercusp-workspace', reader: 'sudo -n -u postgres psql -At', launchedBy: 'su-807ee9d7-200a-4664-808d-c6000c52e818' },
  sourceBlobs: Object.fromEntries([...SOURCES, ORACLE].map((p) => [p, blob(p)])),
  artifacts: Object.fromEntries(
    [`${DIR}/run.mjs`, `${DIR}/probe.sql`, ...CONTROLS.map((c) => c.file)].map((p) => [p, `sha256:${sha256(p)}`]),
  ),
  limitations: [
    'This is one live reading of a rolling 24h window, not a continuous 24h observation; the routine keeps recording, so a later reading can differ.',
    'The probe judges the recorded slot causes, not whether each recorded cause is true; cause correctness is covered by the tree evidence bound to AUTO-BAR-R-8-P-009 and SPEC-P-009.',
  ],
  instrument: {
    path: ORACLE,
    testPath: ORACLE_TEST,
    role: 'Every pass/fail decision on the probe rows is taken by this committed oracle; run.mjs only executes the SQL and records output.',
  },
};
writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`R17_EVIDENCE ok=${ok} live=${liveLine} out=${OUT}\n`);
process.exit(ok ? 0 : 1);
