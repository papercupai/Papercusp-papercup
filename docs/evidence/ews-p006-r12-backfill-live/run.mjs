#!/usr/bin/env node
// Live evidence for AUTO-BAR-R-12-P-006@3 (event-wait-settlement-2026-10-20, WI-6554700010018158).
// Runs the clause's read-only probe and six negative controls against the operator database, lets the
// committed oracle (scripts/lib/unprovable-wait-backfill-live-oracle.mjs) take every pass/fail decision, and
// writes docs/evidence/ews-p006-r12-backfill-live.json. Exit 0 only if the live probe passes AND every control
// fails on the assertion it targets.
// Usage (repo root, host context with sudo): node docs/evidence/ews-p006-r12-backfill-live/run.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { judgeR12, parseR12Row } from '../../../scripts/lib/unprovable-wait-backfill-live-oracle.mjs';

const DIR = 'docs/evidence/ews-p006-r12-backfill-live';
const OUT = `${DIR}.json`;
const PROBE = `${DIR}/probe.sql`;
const ORACLE = 'scripts/lib/unprovable-wait-backfill-live-oracle.mjs';
const ORACLE_TEST = 'scripts/lib/unprovable-wait-backfill-live-oracle.test.ts';
const SOURCES = [
  'packages/operator-core/lib/attention/work-item-blocker-reaper.ts',
  'packages/operator-core/lib/events/await/catalog.ts',
];

// Each control rewrites exactly one /*@marker*/ span of the probe and must make the oracle fail on `expect`.
const CONTROLS = [
  {
    id: 'control-no-stamps',
    marker: "p.e->>'recheckAt' IS NOT NULL /*@stamped*/",
    replacement: 'false',
    expect: 'no-unprovable-unstamped',
    what: 're-check dates ignored: a database the backfill never stamped must fail',
  },
  {
    id: 'control-no-announcements',
    marker: 'coalesce(an.live, false) /*@announced*/',
    replacement: 'false',
    expect: 'no-unprovable-unstamped',
    what: 'live announcements ignored: an unstamped announced wait must then count as unprovable',
  },
  {
    id: 'control-no-concrete-keys',
    marker: '/*@concrete*/',
    replacement: 'AND false',
    expect: 'no-unprovable-unstamped',
    what: 'concrete condition-proving keys ignored: an unstamped proving wait must then count as unprovable',
  },
  {
    id: 'control-cleared-counts',
    marker: "e->>'clearedBy' = 'system:unprovable-wait-backfill' /*@cleared-actor*/",
    replacement: "e->>'status' = 'cleared'",
    expect: 'none-cleared-by-backfill',
    what: 'every cleared row attributed to the backfill: the cleared-row count must be able to fail',
  },
  {
    id: 'control-unattributed',
    marker: "e->>'status' <> 'active' AND e->>'clearedBy' IS NULL /*@unattributed*/",
    replacement: 'true',
    expect: 'no-unattributed-clear',
    what: 'every stamped row treated as cleared with no clearer: the fail-closed count must be able to fail',
  },
  {
    id: 'control-backfill-actor',
    marker: "'system:unprovable-wait-backfill' /*@backfill-actor*/",
    replacement: "'system:never-wrote' /*@backfill-actor*/",
    expect: 'backfill-observed',
    what: 'the backfill actor renamed to one that never wrote: a database the backfill never reached must fail',
  },
];

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const blob = (p) => execFileSync('git', ['hash-object', p], { encoding: 'utf8' }).trim();
const psql = (sql) =>
  execFileSync('sudo', ['-n', '-u', 'postgres', 'psql', '-d', 'papercusp', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    input: sql,
    encoding: 'utf8',
  }).trim();

/** Substitute one marker exactly once; a missing or repeated marker is a broken control, not a pass. */
const derive = (probe, marker, replacement) => {
  const first = probe.indexOf(marker);
  if (first < 0 || probe.indexOf(marker, first + marker.length) >= 0) {
    throw new Error(`control marker must occur exactly once in ${PROBE}: ${marker}`);
  }
  return probe.slice(0, first) + replacement + probe.slice(first + marker.length);
};

const probeSql = readFileSync(PROBE, 'utf8');
const startedAt = new Date().toISOString();
const liveLine = psql(probeSql);
const live = judgeR12(parseR12Row(liveLine));
const controls = CONTROLS.map((c) => {
  const sql = derive(probeSql, c.marker, c.replacement);
  const line = psql(sql);
  const verdict = judgeR12(parseR12Row(line));
  const failedIds = verdict.assertions.filter((a) => !a.passed).map((a) => a.id);
  return { ...c, sqlSha256: sha256(sql), row: line, verdict, failedIds };
});
const finishedAt = new Date().toISOString();

const assertions = [
  ...live.assertions.map((a) => ({ id: `live:${a.id}`, passed: a.passed, evidence: `${a.evidence}; row ${liveLine}` })),
  ...controls.map((c) => ({
    id: `${c.id}:fails-on-${c.expect}`,
    passed: c.verdict.passed === false && c.failedIds.includes(c.expect),
    evidence: `${c.what}; row ${c.row}; oracle passed=${c.verdict.passed}; failing assertions: ${c.failedIds.join(',') || 'none'}`,
  })),
];
const ok = assertions.every((a) => a.passed);
const row = parseR12Row(liveLine);
const controlsOk = controls.every((c) => !c.verdict.passed && c.failedIds.includes(c.expect));

const evidence = {
  schemaVersion: 1,
  kind: 'operational-test-evidence',
  name: 'P-006 / R-12 live unprovable-wait backfill reading on the operator database (event-wait-settlement-2026-10-20)',
  framework: 'operational',
  command: ['node', `${DIR}/run.mjs`],
  exitCode: ok ? 0 : 1,
  startedAt,
  finishedAt,
  plan: 'event-wait-settlement-2026-10-20',
  planItem: 'P-006',
  workItemId: 'WI-6554700010018158',
  specIds: ['AUTO-BAR-R-12-P-006@3'],
  evidencePlane: 'live',
  summary:
    `The R-12 probe (${PROBE}) read every active event/gate wait on a non-terminal papercusp-workspace item and returned ${liveLine}: ` +
    `${row.active_waits} active wait(s) = ${row.stamped} with a re-check date + ${row.proving_concrete} on a concrete condition-proving key + ` +
    `${row.announced_live} on a live announced key + ${row.announced_fired} on an already-fired announced key + ` +
    `${row.unprovable_unstamped} unprovable with no re-check date. The backfill (system:unprovable-wait-backfill) has stamped ` +
    `${row.backfill_stamped_rows} row(s) across all items, cleared ${row.backfill_cleared}, and ${row.stamped_inactive_unattributed} stamped ` +
    `row(s) went inactive with no recorded clearer. The committed oracle judged it ${live.passed ? 'PASS' : 'FAIL'}. ` +
    `All six negative controls ${controlsOk ? 'failed on their targeted assertion as required' : 'did NOT all fail as required'}.`,
  assertions,
  environment: {
    database: 'papercusp (native PG :5432)',
    workspace: 'papercusp-workspace',
    reader: 'sudo -n -u postgres psql -q -At (BEGIN READ ONLY ... ROLLBACK)',
    launchedBy: 'su-42565716-6d11-4087-93d3-1b2b0d5ded7b',
  },
  sourceBlobs: Object.fromEntries([...SOURCES, ORACLE].map((p) => [p, blob(p)])),
  artifacts: Object.fromEntries([
    [`${DIR}/run.mjs`, `sha256:${sha256(readFileSync(`${DIR}/run.mjs`))}`],
    [PROBE, `sha256:${sha256(probeSql)}`],
    ...controls.map((c) => [`${PROBE}#${c.id}`, `sha256:${c.sqlSha256}`]),
  ]),
  limitations: [
    'One live reading, not a continuous observation: a wait written through an old build (one without wait-ref-admission) after this reading is not covered until the backfill and this probe are re-run.',
    'Provability is decided by the probe independently of readEventConditionReachability: a concrete key of a catalog family whose fire proves the condition, or an exact live announcement. A provable wait of another shape (a predicate watch) would be reported as unprovable — fail-closed, and none exists at this reading.',
    'The reading judges the outcome (no unprovable wait left without a re-check date, none cleared by the backfill), not the backfill code path; the code path is covered by the tree evidence bound to the same clause (work-item-blocker-reaper.test.ts and its mutation runs).',
  ],
  instrument: {
    path: ORACLE,
    testPath: ORACLE_TEST,
    role: 'Every pass/fail decision on the probe rows is taken by this committed oracle; run.mjs only executes the SQL and records output. The oracle test also pins the probe\'s terminal-state and condition-family lists to the code.',
  },
};
writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`R12_EVIDENCE ok=${ok} live=${liveLine} out=${OUT}\n`);
for (const c of controls) process.stdout.write(`R12_CONTROL ${c.id} row=${c.row} failed=${c.failedIds.join(',') || 'none'}\n`);
process.exit(ok ? 0 : 1);
