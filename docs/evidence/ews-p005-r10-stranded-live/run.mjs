#!/usr/bin/env node
// Live evidence for AUTO-BAR-R-10-P-005@3 (event-wait-settlement-2026-10-20, WI-6554700010018157).
// Runs the clause's read-only probe and five negative controls against the operator database, lets the
// committed oracle (scripts/lib/stranded-blocked-live-oracle.mjs) take every pass/fail decision, and writes
// docs/evidence/ews-p005-r10-stranded-live.json. Exit 0 only if the live probe passes AND every control
// fails on the assertion it targets.
// Usage (repo root, host context with sudo): node docs/evidence/ews-p005-r10-stranded-live/run.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { judgeR10, parseR10Row } from '../../../scripts/lib/stranded-blocked-live-oracle.mjs';

const DIR = 'docs/evidence/ews-p005-r10-stranded-live';
const OUT = `${DIR}.json`;
const PROBE = `${DIR}/probe.sql`;
const ORACLE = 'scripts/lib/stranded-blocked-live-oracle.mjs';
const ORACLE_TEST = 'scripts/lib/stranded-blocked-live-oracle.test.ts';
const SOURCES = [
  'packages/operator-core/lib/attention/work-item-blocker-reaper.ts',
  'packages/operator-core/lib/attention/gate-watch-action.ts',
];

// A synthetic candidate row for the `c` CTE: feature_id, origin, source_plan_slug, state_changed_at, payload, last_clear.
const extra = (id, origin, stateChangedAt, payload) =>
  `UNION ALL SELECT '${id}', ${origin}, NULL::text, ${stateChangedAt}, '${payload}'::jsonb, now() - interval '1 day'`;

const CONTROLS = [
  {
    id: 'control-stranded',
    marker: '/*@extra-candidates*/',
    replacement: extra('EI-R10-CONTROL-STRANDED', "'local'", "now() - interval '2 days'", '{}'),
    expect: 'no-stranded-item',
    what: 'one synthetic local candidate, cleared a day before the tick, no hold keys: the falsifier must fire',
  },
  {
    id: 'control-null-flags',
    marker: '/*@extra-candidates*/',
    replacement: extra('EI-R10-CONTROL-NULL-FLAGS', 'NULL::text', "now() - interval '2 days'", '{"note":"no hold keys"}'),
    expect: 'no-stranded-item',
    what: 'a stranded candidate whose origin and hold keys are all absent (NULL): it must still be counted stranded, not dropped from every bucket',
  },
  {
    id: 'control-missing-time',
    marker: '/*@extra-candidates*/',
    replacement: extra('EI-R10-CONTROL-NO-TIME', "'local'", 'NULL::timestamptz', '{}'),
    expect: 'no-unknown-times',
    what: 'a candidate with no state_changed_at: an unclassifiable row must fail rather than pass silently',
  },
  {
    id: 'control-stale-sweep',
    marker: 'r.last_fired_at /*@tick-start*/',
    replacement: "r.last_fired_at - interval '1 day' /*@tick-start*/",
    expect: 'sweep-is-live',
    what: 'the sweep routine last start moved a day back: a stopped sweep must not read as nothing stranded',
  },
  {
    id: 'control-no-repair-path',
    marker: "'system:blocker-stranded-repair' /*@repair-actor*/",
    replacement: "'system:blocker-stranded-repair:control-absent' /*@repair-actor*/",
    expect: 'repair-path-observed',
    what: 'the repair actor renamed to one that never wrote: a build without the repair path must fail',
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
const live = judgeR10(parseR10Row(liveLine));
const controls = CONTROLS.map((c) => {
  const sql = derive(probeSql, c.marker, c.replacement);
  const line = psql(sql);
  const verdict = judgeR10(parseR10Row(line));
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
const row = parseR10Row(liveLine);

const evidence = {
  schemaVersion: 1,
  kind: 'operational-test-evidence',
  name: 'P-005 / R-10 live stranded-blocked reading on the operator database (event-wait-settlement-2026-10-20)',
  framework: 'operational',
  command: ['node', `${DIR}/run.mjs`],
  exitCode: ok ? 0 : 1,
  startedAt,
  finishedAt,
  plan: 'event-wait-settlement-2026-10-20',
  planItem: 'P-005',
  workItemId: 'WI-6554700010018157',
  specIds: ['AUTO-BAR-R-10-P-005@3'],
  evidencePlane: 'live',
  summary:
    `The R-10 probe (${PROBE}) read the re-check sweep's own population on papercusp-workspace and returned ${liveLine}: ` +
    `${row.all_cleared_blocked} blocked item(s) with every blocker cleared = ${row.reblocked_after_clear} re-blocked after the clear + ` +
    `${row.other_hold} under another hold + ${row.stranded} stranded + ${row.cleared_since_tick} cleared since the last completed tick + ` +
    `${row.missing_times} with unknown times; the sweep host routine last started ${row.tick_age_s}s before the reading and the repair ` +
    `path has written ${row.repair_audit_rows} audit row(s). The committed oracle judged it ${live.passed ? 'PASS' : 'FAIL'}. ` +
    `All five negative controls ${controls.every((c) => !c.verdict.passed && c.failedIds.includes(c.expect)) ? 'failed on their targeted assertion as required' : 'did NOT all fail as required'}.`,
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
    'One live reading, not a continuous observation: an item can be stranded and repaired between readings.',
    'The reading judges the outcome (no item left stranded past a tick), not the sweep code path; the code path is covered by the tree evidence bound to the same clause (work-item-blocker-reaper.integration.test.ts and its mutation run).',
    'Supersedes docs/evidence/ews-p005-r10-stranded-blocked-live.sql: that query classified with independent FILTERs whose hold flags could be NULL, so a stranded row with no needsOwnerAction key would have counted in no bucket. Its 2026-10-21T01:59Z reading still partitioned exactly (19 = 6 + 13 + 0 + 0), so that reading is unaffected; this probe closes the hole structurally and control-null-flags proves it.',
  ],
  instrument: {
    path: ORACLE,
    testPath: ORACLE_TEST,
    role: 'Every pass/fail decision on the probe rows is taken by this committed oracle; run.mjs only executes the SQL and records output.',
  },
};
writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`R10_EVIDENCE ok=${ok} live=${liveLine} out=${OUT}\n`);
for (const c of controls) process.stdout.write(`R10_CONTROL ${c.id} row=${c.row} failed=${c.failedIds.join(',') || 'none'}\n`);
process.exit(ok ? 0 : 1);
