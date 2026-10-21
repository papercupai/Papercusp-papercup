#!/usr/bin/env node
// Live evidence for AUTO-BAR-R-19-P-009@3 (event-wait-settlement-2026-10-20, WI-6554700010018160).
// Times the dependency-graph resolvers on the live operator database (time.mts, through tsx), lets the committed
// oracle (scripts/lib/dependency-graph-wait-latency-live-oracle.mjs) take every pass/fail decision, runs six
// negative controls that each corrupt one property of the real measurement, and writes
// docs/evidence/ews-p009-r19-latency-live.json. Exit 0 only if the live measurement passes AND every control
// fails on exactly the assertion it targets.
// Usage (repo root, host context): node docs/evidence/ews-p009-r19-latency-live/run.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  R19_ASSERTIONS,
  R19_MIN_RUNS,
  expectedDbFromDsn,
  judgeR19,
} from '../../../scripts/lib/dependency-graph-wait-latency-live-oracle.mjs';

const startedAt = new Date().toISOString();

const DIR = 'docs/evidence/ews-p009-r19-latency-live';
const OUT = `${DIR}.json`;
const PROBE = `${DIR}/time.mts`;
const ORACLE = 'scripts/lib/dependency-graph-wait-latency-live-oracle.mjs';
const ORACLE_TEST = 'scripts/lib/dependency-graph-wait-latency-live-oracle.test.ts';
const SOURCES = [
  'packages/operator-core/lib/sync-resolver/dependency-graph-edges.ts',
  'packages/operator-core/lib/sync-resolver/read-deadline.ts',
];

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const headBlob = (p) => {
  try {
    return git('rev-parse', `HEAD:${p}`);
  } catch {
    return null;
  }
};
const workBlob = (p) => git('hash-object', p);

// The operator's own connection string: the dev operator and dev:pg_query read this database. Without it the db
// library falls back to the desktop discovery file and times a different database with no error.
const unitEnv = execFileSync('systemctl', ['--user', 'show', 'papercup-dev-api.service', '-p', 'Environment'], {
  encoding: 'utf8',
});
const dsn = unitEnv
  .replace(/^Environment=/, '')
  .split(/\s+/)
  .find((s) => s.startsWith('HARNESS_ADMIN_DATABASE_URL='))
  ?.slice('HARNESS_ADMIN_DATABASE_URL='.length);
if (!dsn) {
  process.stderr.write('R19_EVIDENCE refused: papercup-dev-api.service carries no HARNESS_ADMIN_DATABASE_URL\n');
  process.exit(2);
}
const expectedDb = expectedDbFromDsn(dsn);

const raw = execFileSync('npx', ['tsx', PROBE], {
  encoding: 'utf8',
  env: { ...process.env, HARNESS_ADMIN_DATABASE_URL: dsn },
  maxBuffer: 64 << 20,
});
const line = raw.split('\n').find((l) => l.startsWith('R19_MEASUREMENT '));
if (!line) throw new Error('probe printed no R19_MEASUREMENT line');
const probe = JSON.parse(line.slice('R19_MEASUREMENT '.length));
const live = { db: probe.db, expectedDb, deadlineMs: probe.deadlineMs, runs: probe.runs };
const verdict = judgeR19(live);

// Each control corrupts exactly one property of the REAL measurement; the oracle must fail it on that property only.
const copy = () => structuredClone(live);
const CONTROLS = [
  {
    id: 'C1-run-at-deadline',
    targets: 'within-deadline',
    make: () => {
      const m = copy();
      m.runs[m.runs.length - 1].edgesPlusWaitsMs = m.deadlineMs;
      return m;
    },
  },
  { id: 'C2-other-database', targets: 'operator-db', make: () => ({ ...copy(), db: expectedDb.replace(/@\d+$/, '@1') }) },
  { id: 'C3-too-few-runs', targets: 'min-runs', make: () => ({ ...copy(), runs: copy().runs.slice(0, R19_MIN_RUNS - 1) }) },
  {
    id: 'C4-empty-graph',
    targets: 'graph-non-empty',
    make: () => {
      const m = copy();
      m.runs[0].edges = 0;
      return m;
    },
  },
  {
    id: 'C5-wait-leg-returned-nothing',
    targets: 'wait-leg-ran',
    make: () => {
      const m = copy();
      for (const r of m.runs) r.waits = 0;
      return m;
    },
  },
  {
    id: 'C6-before-not-timed',
    targets: 'before-recorded',
    make: () => {
      const m = copy();
      delete m.runs[0].edgesMs;
      return m;
    },
  },
];
const controls = CONTROLS.map((c) => {
  const v = judgeR19(c.make());
  return { id: c.id, targets: c.targets, failedIds: v.failedIds, caught: v.failedIds.length === 1 && v.failedIds[0] === c.targets };
});

const ok = verdict.ok && controls.every((c) => c.caught);
const runs = probe.runs;
const col = (k) => runs.map((r) => r?.[k]).join(',');
const LIVE_EVIDENCE = {
  'min-runs': `runs=${runs.length} (minimum ${R19_MIN_RUNS})`,
  'operator-db': `the probe read ${probe.db}; the operator connection string (papercup-dev-api.service) names ${expectedDb}`,
  'graph-non-empty': `depEdges rows per run: ${col('edges')}`,
  'wait-leg-ran': `depWaits rows per run: ${col('waits')}; depWaits alone ms per run: ${col('waitsAloneMs')}`,
  'before-recorded': `depEdges alone ms per run (the pane's load before the wait leg): ${col('edgesMs')}`,
  'within-deadline': `max depEdges alone ${verdict.maxEdgesMs} ms, max depEdges+depWaits ${verdict.maxEdgesPlusWaitsMs} ms, max depWaits alone ${verdict.maxWaitsAloneMs} ms; deadline ${probe.deadlineMs} ms (RESOLVER_READ_TIMEOUT_MS)`,
};
const assertions = [
  ...R19_ASSERTIONS.map((a) => ({ id: `live:${a}`, passed: !verdict.failedIds.includes(a), evidence: LIVE_EVIDENCE[a] })),
  ...controls.map((c) => ({
    id: `control:${c.id}`,
    passed: c.caught,
    evidence: `the control corrupts one property of the real measurement and must fail exactly ${c.targets}; the oracle failed ${c.failedIds.join(',') || 'nothing'}`,
  })),
];
const summary =
  `The R-19 probe (${PROBE}) timed the dependency-graph resolvers ${runs.length} times on the papercusp harness against ${probe.db}. ` +
  `Before the wait leg (depEdges alone) the slowest run took ${verdict.maxEdgesMs} ms; with it (depEdges and depWaits concurrently, as the pane loads them) ${verdict.maxEdgesPlusWaitsMs} ms; depWaits alone ${verdict.maxWaitsAloneMs} ms. ` +
  `The deadline is ${probe.deadlineMs} ms (RESOLVER_READ_TIMEOUT_MS). The committed oracle judged it ${verdict.ok ? 'PASS' : `FAIL on ${verdict.failedIds.join(',')}`}. ` +
  `${controls.filter((c) => c.caught).length} of ${controls.length} negative controls failed on exactly their targeted assertion.`;
const evidence = {
  schemaVersion: 1,
  kind: 'operational-test-evidence',
  name: 'P-009 / R-19 live dependency-graph resolver timing against the pane deadline (event-wait-settlement-2026-10-20)',
  framework: 'operational',
  command: ['node', 'docs/evidence/ews-p009-r19-latency-live/run.mjs'],
  exitCode: ok ? 0 : 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  plan: 'event-wait-settlement-2026-10-20',
  planItem: 'P-009',
  workItemId: 'WI-6554700010018160',
  specIds: ['AUTO-BAR-R-19-P-009@3'],
  evidencePlane: 'live',
  summary,
  assertions,
  environment: {
    database: `${probe.db} (the dev operator's HARNESS_ADMIN_DATABASE_URL)`,
    workspace: probe.workspaceId,
    harness: probe.harnessSlug,
    reader: 'docs/evidence/ews-p009-r19-latency-live/time.mts through npx tsx, in-process resolver calls',
    commit: git('rev-parse', 'HEAD'),
    measuredAt: probe.at,
  },
  measurement: {
    deadlineMs: probe.deadlineMs,
    deadlineSource: 'RESOLVER_READ_TIMEOUT_MS in packages/operator-core/lib/sync-resolver/read-deadline.ts, read by the probe',
    beforeAfter: {
      beforeMaxMs: verdict.maxEdgesMs,
      beforeMeans: 'workItems.depEdges alone: what the Work-tab dependency graph pane loaded before the wait leg',
      afterMaxMs: verdict.maxEdgesPlusWaitsMs,
      afterMeans: 'workItems.depEdges and workItems.depWaits concurrently: what the pane loads now',
      waitsAloneMaxMs: verdict.maxWaitsAloneMs,
    },
    runs,
    verdict,
  },
  sourceBlobs: Object.fromEntries([...SOURCES, ORACLE].map((p) => [p, workBlob(p)])),
  sourcesDirty: Object.fromEntries([...SOURCES, ORACLE].map((p) => [p, headBlob(p) !== workBlob(p)])),
  artifacts: Object.fromEntries([`${DIR}/run.mjs`, PROBE].map((p) => [p, `sha256:${sha256(p)}`])),
  instrument: {
    path: ORACLE,
    testPath: ORACLE_TEST,
    role: 'Every pass/fail decision on the measurement is taken by this committed oracle; run.mjs only runs the probe, applies the controls and records output. The oracle test also pins the bar deadline to RESOLVER_READ_TIMEOUT_MS.',
  },
  limitations: [
    "Timed in-process against the live operator database with the tree's resolver source. This is the resolver the bar names; the HTTP round trip and the webview render are not part of the timing.",
    'Wall-clock times on a shared dev box under live fleet load vary between runs; the receipt records the observed maxima over the runs, not an upper bound.',
    'The bound on the wait leg query count is the integration test bound to the same clause (dependency-graph-edges.integration.test.ts), not this receipt.',
  ],
};
writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(
  `R19_EVIDENCE ok=${ok} db=${probe.db} expected=${expectedDb} before=${verdict.maxEdgesMs} after=${verdict.maxEdgesPlusWaitsMs} deadline=${probe.deadlineMs} failed=${verdict.failedIds.join(',') || 'none'} out=${OUT}\n`,
);
for (const c of controls) process.stdout.write(`R19_CONTROL ${c.id} targets=${c.targets} failed=${c.failedIds.join(',') || 'none'} caught=${c.caught}\n`);
process.exit(ok ? 0 : 1);
