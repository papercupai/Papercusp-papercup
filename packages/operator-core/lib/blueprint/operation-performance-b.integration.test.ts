/** P-013 workload B fixture (plan D-016 (B)): an explicit plan target — one
 * 3-item fork/join DAG with two blocker edges and a fixed 1 KiB input — run as
 * plans:run-now (control) and as the blueprint operation that targets the same
 * template through blueprint:submit (candidate), in one migrated throwaway org DB.
 *
 * Default (no env): a fast admission/invariant smoke, not a latency grade.
 * P013_MATRIX=1: the paired D-016 matrix (knobs as workload A:
 * P013_MODES P013_CONCURRENCIES P013_WARMUPS P013_WARM_SAMPLES P013_COLD_SAMPLES
 * P013_REPETITIONS P013_REPETITION_OFFSET; P013_DEDICATED_PG / P013_FIXTURE_EMBEDDER per D-022). */
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { hashPlanContent } from '@papercusp/plan-parser/content-hash';
import { BlueprintSchema, compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { startDedicatedNativePg, startDedicatedTestPg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { assertNoLocalModelLoaded, installDeterministicEmbedder, type InstalledDeterministicEmbedder } from '../../test/_deterministic-embedder';
import { runPairedBenchmark, type BenchmarkArm } from '../../test/_paired-operation-benchmark';
import { createTextCollector } from '../child-output';
import { projectBlueprintToPg } from './project-to-pg';
import { getResourceProfile } from '../resource-profile';
import { materializePlanSchedule } from '../harness/routines/materialize-plan-schedule';
import {
  P013B_HARNESS, P013B_ITEMS, P013B_OPERATION, P013B_OUTPUT_SCHEMA, P013B_TEMPLATE, P013B_TEMPLATE_CONTENT, P013B_WORKSPACE,
  runP013WorkloadB, type P013BArm, type P013BSample,
} from './operation-performance-b-driver';

const fixture = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fixture.sql }),
  // Plan reads/writes run inside withWorkspace; pin it to the fixture DB too, as
  // the plan-run-action fixture does, or run-now resolves against the real DB.
  // MUST be a real transaction: callers take pg_advisory_xact_lock (the plan lock) inside it.
  // A bare fn(fixture.sql) ran every statement in autocommit, so the lock released at once and
  // concurrent completions raced on plan_items (WI-10003498 — a rig artifact, not a product bug).
  withWorkspace: async <T>(_workspaceId: string, fn: (tx: Sql) => Promise<T>) =>
    fixture.sql.begin((tx) => fn(tx as unknown as Sql)) as Promise<T>,
}));
vi.mock('@papercusp/flags/server', async () => ({
  ...(await vi.importActual<typeof import('@papercusp/flags/server')>('@papercusp/flags/server')),
  getFlag: async (flag: string) => (flag === 'papercusp-spec-triad-required' ? false : true),
}));
vi.mock('../agent-tools/plans/plan-spec-quality-gate', () => ({
  evaluatePlanSpecQualityGate: vi.fn(async ({ planSlug }: { planSlug: string }) => ({
    satisfied: true, applicable: false, mode: 'report-only', planSlug,
    specSetHash: null, wouldBlock: ['no-first-class-spec-clauses'],
  })),
}));
vi.mock('../workspace-registry', async () => ({
  ...(await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry')),
  activeWorkspaceId: () => 'p013-benchmark-b',
}));
vi.mock('../harness-core', async () => ({
  ...(await vi.importActual<typeof import('../harness-core')>('../harness-core')),
  resolveProject: async (slug: string) => ({ slug, path: `/tmp/${slug}` }),
}));
vi.mock('../hive-federation', async () => ({
  ...(await vi.importActual<typeof import('../hive-federation')>('../hive-federation')),
  potHomeSlugForHarness: async (_workspace: string, slug: string) => slug,
}));

// The completion saga reflects plan items and releases lanes via these projected tools.
await import('../agent-tools/plans/set-status');
await import('../agent-tools/plan-items/release');
const { default: runNowTool } = await import('../agent-tools/plans/run-now');
const { default: submitOperationTool } = await import('../agent-tools/blueprint/submit-operation');
const { default: operationResultTool } = await import('../agent-tools/blueprint/result-operation');
const { default: claimWorkItemTool } = await import('../agent-tools/work_items/claim');
const { default: completeWorkItemTool } = await import('../agent-tools/work_items/complete');
const { default: publishOutputsTool } = await import('../agent-tools/plans/publish-outputs');
const { reconcileScheduledPlanRuns } = await import('../harness/routines/reconcile-plan-runs');
const { getPlanRun } = await import('../agent-tools/plans/runs');
const warmTools = {
  runNowTool, submitOperationTool, operationResultTool, claimWorkItemTool, completeWorkItemTool,
  publishOutputsTool, getPlanRun,
  settle: (db: Sql) => reconcileScheduledPlanRuns({ sql: db, harnessSlug: P013B_HARNESS }),
};
const WS = P013B_WORKSPACE;
const HARNESS = P013B_HARNESS;
const SOURCE = {
  id: 'p013-workload-b', workItem: { kind: 'feature' },
  roles: [{ id: 'worker' }],
  spine: { steps: [{ id: 'open', op: 'coord:thread-open', args: { title: 'P-013 B' } }] },
  operations: [{
    id: P013B_OPERATION, version: '1',
    target: { kind: 'plan', template: { kind: 'plan-template', ref: P013B_TEMPLATE,
      revision: '0', contentHash: hashPlanContent(P013B_TEMPLATE_CONTENT) } },
    inputSchema: { type: 'object', required: ['value'],
      properties: { value: { type: 'string' } }, additionalProperties: false },
    acceptance: { resultSchema: { type: 'object', required: ['value'],
      properties: { value: { type: 'string' } }, additionalProperties: false } },
  }],
};

let db: OrgTestDb;
let dedicatedPg: Pick<StartedPostgreSqlContainer, 'getConnectionUri' | 'stop'> | DedicatedNativePg | undefined;
let fixtureEmbedder: InstalledDeterministicEmbedder | undefined;
const priorAdminUrl = process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
// P013_DEDICATED_PG=1 → a dedicated Docker container; =native → a dedicated cluster from the
// host's own PG binaries (no Docker; Docker create hangs 2–30 min here, WI-10003403). Both are
// D-022(c) run-owned clusters with server-default durability (D-022(b)).
// D-024: fixture.sql stands in for getOrgPg() AND withWorkspace, so size it like the
// production admin pool (resource-profile pgPoolMax). At the fixture default of 2,
// concurrent completions each hold a transaction connection and then wait for a second
// one that never frees — a rig-only pool starvation (b-smoke6 hung 192s, WI-10003498).
// P013_ORG_POOL_MAX=<n> pins a size for a deliberate pool-sensitivity A/B.
const P013_ORG_POOL_MAX = (() => {
  const pinned = Number(process.env.P013_ORG_POOL_MAX);
  return Number.isInteger(pinned) && pinned > 0 ? pinned : getResourceProfile().pgPoolMax;
})();
const dedicatedPgMode = process.env.P013_DEDICATED_PG === 'native'
  ? 'native' : process.env.P013_DEDICATED_PG === '1' ? 'container' : null;
const dedicatedPgRequested = dedicatedPgMode !== null;
const DEDICATED_PG_SETTINGS: Record<string, string> = {
  max_connections: '200',
  dynamic_shared_memory_type: 'mmap',
  // Forensics: P013_PG_LOG_DIR=<abs dir> captures every data-modifying statement with its
  // backend pid + xid, so a write collision can be attributed to the exact writer.
  ...(process.env.P013_PG_LOG_DIR
    ? {
        logging_collector: 'on',
        log_directory: process.env.P013_PG_LOG_DIR,
        // 'all', not 'mod': tx boundaries (BEGIN/COMMIT) and the plan advisory-lock SELECTs
        // are not data-modifying, and %x is assigned lazily (0 on nearly every execute line),
        // so only %v (virtual xid, set at BEGIN) attributes a statement to its transaction.
        log_statement: 'all',
        log_min_error_statement: 'error',
        log_line_prefix: '%m [%p] v%v x%x ',
      }
    : {}),
};
beforeAll(async () => {
  if (dedicatedPgMode === 'native') {
    dedicatedPg = await startDedicatedNativePg({ settings: DEDICATED_PG_SETTINGS });
    process.env.PAPERCUSP_TEST_PG_ADMIN_URL = dedicatedPg.getConnectionUri();
  } else if (dedicatedPgMode === 'container') {
    // startDedicatedTestPg: the stock pg_isready healthcheck crash-restarts a
    // dedicated cluster mid-run under load (2026-09-27, see the helper).
    dedicatedPg = await startDedicatedTestPg({
      command: ['postgres', ...Object.entries(DEDICATED_PG_SETTINGS).flatMap(([k, v]) => ['-c', `${k}=${v}`])],
    });
    process.env.PAPERCUSP_TEST_PG_ADMIN_URL = dedicatedPg.getConnectionUri();
  }
  // The default admission smoke checks the fork/join contract, so isolate it
  // from local model construction and device fallback. Matrix runs retain their
  // explicit provider choice; the existing helper replaces all embed cascades.
  if (process.env.P013_MATRIX !== '1' || process.env.P013_FIXTURE_EMBEDDER === '1') {
    fixtureEmbedder = await installDeterministicEmbedder();
  }
  db = await createOrgTestDb({ adminPoolMax: P013_ORG_POOL_MAX });
  fixture.sql = db.adminSql;
  const sql = db.adminSql;
  await sql`
    INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${WS}, ${HARNESS}, ${Buffer.from([14])}, 'kc-p013-benchmark-b', 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING`;
  await sql`
    INSERT INTO harness_shared.harness_registry (workspace_id, payload)
    VALUES (${WS}, ${JSON.stringify({ projects: [{ slug: HARNESS, path: `/tmp/${HARNESS}`, harness_kind: 'hive' }] })}::text::jsonb)
    ON CONFLICT (workspace_id) DO UPDATE SET payload = EXCLUDED.payload`;
  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, items, output_schema)
    VALUES (${WS}, ${HARNESS}, ${P013B_TEMPLATE}, 'P-013 fork/join', 'active',
            ${P013B_TEMPLATE_CONTENT}, ${hashPlanContent(P013B_TEMPLATE_CONTENT)},
            ${JSON.stringify(P013B_ITEMS)}::text::jsonb,
            ${JSON.stringify(P013B_OUTPUT_SCHEMA)}::text::jsonb)`;
  // Legacy BAR cohort, as the plan-run-action fixture: run instances inherit
  // template admission (D-018) and this template carries no BAR contract.
  await sql`
    UPDATE harness_shared.harness_plans SET acceptance_bar_epoch = NULL, acceptance_bar_cohort = NULL
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${P013B_TEMPLATE}`;
  // concurrency 'queue': overlapping runs at concurrency 8 must mint, never skip.
  await materializePlanSchedule({
    workspaceId: WS, harnessSlug: HARNESS, templateSlug: P013B_TEMPLATE,
    schedule: { kind: 'rrule', rrule: 'FREQ=DAILY', dtstart: '2026-01-01T09:00:00.000Z' },
    concurrency: 'queue', sql,
  });
  await projectBlueprintToPg(sql, {
    workspaceId: WS, harnessSlug: HARNESS,
    blueprint: BlueprintSchema.parse(SOURCE), specification: compileAgentSpecification({ source: SOURCE }),
  });
}, dedicatedPgRequested ? 420_000 : 120_000);
afterAll(async () => {
  await db?.cleanup();
  await dedicatedPg?.stop({ timeout: 10_000 });
  if (dedicatedPg) {
    if (priorAdminUrl === undefined) delete process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
    else process.env.PAPERCUSP_TEST_PG_ADMIN_URL = priorAdminUrl;
  }
}, dedicatedPgRequested ? 180_000 : 60_000);

describe('P-013 workload B fixture', () => {
  it('runs matching 3-item fork/join plan runs through run-now and the blueprint plan-target operation', async () => {
    if (process.env.P013_MATRIX !== '1') {
      expect(fixtureEmbedder, 'the default admission smoke must install its deterministic embedder').toBeDefined();
    }
    // plans:set-status emits a diagnostic console.warn when one status write crosses its 10 s
    // slow-path threshold. Under matrix load that is an expected observation, not a fixture
    // defect, and vitest-fail-on-console failed a 64-min matrix rep on it (WI-10002948, plan D-038).
    // Count and report ONLY that diagnostic; every other warn still reaches fail-on-console.
    const failOnConsoleWarn = console.warn;
    let setStatusSlowWarns = 0;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((message?: unknown, ...rest: unknown[]) => {
      if (typeof message === 'string' && message.startsWith('[plans:set-status] slow ')) { setStatusSlowWarns++; return; }
      failOnConsoleWarn.call(console, message, ...rest);
    });
    onTestFinished(() => {
      warnSpy.mockRestore();
      console.info('P-013 workload B set-status slow-path diagnostics', JSON.stringify({ setStatusSlowWarns }));
    });
    const runArm =(arm: P013BArm, index: number) => runP013WorkloadB(db.adminSql, warmTools, arm, index);
    let sequence = 0;
    const samples: P013BSample[] = [];
    if (process.env.P013_MATRIX === '1') {
      const matrix = matrixShape();
      let coldStarts = 0;
      const benchmarkArm = (arm: P013BArm): BenchmarkArm => ({
        warmup: async () => { samples.push(await runArm(arm, sequence++)); },
        run: async () => { const sample = await runArm(arm, sequence++); samples.push(sample); return sample.marks; },
        coldStart: async () => {
          const childSequence = sequence++;
          coldStarts++;
          const child = spawn(process.execPath, [
            '--import', 'tsx', fileURLToPath(new URL('./operation-performance-b-child.ts', import.meta.url)),
          ], {
            cwd: process.cwd(),
            env: { ...process.env, P013_COLD_DSN: db.adminDsn, P013_COLD_ARM: arm,
              P013_COLD_SEQUENCE: String(childSequence), PAPERCUSP_WORKSPACE_ID: WS,
              HARNESS_ADMIN_DATABASE_URL: db.adminDsn, HARNESS_DATABASE_URL: db.appDsn },
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            signal: AbortSignal.timeout(120_000),
          });
          const stderr = createTextCollector(child.stderr, { maxChars: 4_000 });
          let stage = 'spawned';
          let embedderCalls: number | null = null;
          let sample: P013BSample | undefined;
          const exit = new Promise<void>((resolve, reject) => {
            child.once('error', (error) => reject(new Error(`P-013 B cold child ${stage}: ${error.message}; ${stderr.peek()}`)));
            // 'close', not 'exit': under load 'exit' can fire before the already-sent p013-sample
            // IPC message is dispatched (the child self-SIGKILLs right after send's callback), so
            // a successful sample read as a failed child. 'close' waits for the IPC channel to drain.
            child.once('close', (code, signal) => code === 0 || (signal === 'SIGKILL' && sample)
              ? resolve()
              : reject(new Error(`P-013 B cold child ${stage} exited ${code}/${signal}: ${stderr.peek()}`)));
          });
          child.on('message', (message: { kind?: string; stage?: string; sample?: P013BSample; calls?: number }) => {
            if (message?.kind === 'p013-stage') stage = message.stage ?? stage;
            if (message?.kind === 'p013-embedder') embedderCalls = message.calls ?? null;
            if (message?.kind === 'p013-sample') sample = message.sample;
          });
          return {
            run: async () => {
              await exit;
              expect(sample?.arm).toBe(arm);
              if (fixtureEmbedder) expect(embedderCalls).not.toBeNull();
              samples.push(sample!);
              return sample!.marks;
            },
            close: async () => { if (!child.killed && child.exitCode === null) child.kill(); await exit.catch(() => {}); },
          };
        },
      });
      const trials = await runPairedBenchmark({ control: benchmarkArm('control'), candidate: benchmarkArm('candidate') }, matrix);
      expect(coldStarts).toBe(matrix.modes.includes('cold')
        ? 2 * matrix.repetitions * matrix.coldSamples * matrix.concurrencies.length : 0);
      expect(trials).toHaveLength(2 * matrix.repetitions * matrix.modes.length * matrix.concurrencies.length);
      console.info(`P-013 workload B ${matrix.modes.join('+')} trials`, JSON.stringify({
        ...matrix, cluster: dedicatedPg ? 'dedicated' : 'shared', clusterSubstrate: dedicatedPgMode ?? 'shared-container', fixtureEmbedder: Boolean(fixtureEmbedder), orgPoolMax: P013_ORG_POOL_MAX, trials }));
    } else {
      for (const arm of ['control', 'candidate'] as const) samples.push(await runArm(arm, sequence++));
      console.info('P-013 workload B admission/invariant smoke; no grade', JSON.stringify(
        samples.map(({ arm, runId, phasesMs }) => ({ arm, runId, ms: phasesMs.map((ms) => +ms.toFixed(2)) }))));
    }
    if (fixtureEmbedder) {
      // Cold-only matrix runs embed in their children; this process's counter
      // proves actual use only for the default in-process admission smoke.
      if (process.env.P013_MATRIX !== '1') {
        expect(fixtureEmbedder.calls(), 'the workload must exercise the deterministic embedder').toBeGreaterThan(0);
      }
      console.info('P-013 workload B local-model evidence', JSON.stringify({
        embedderCalls: fixtureEmbedder.calls(),
        ...assertNoLocalModelLoaded('P-013 B parent after the workload'),
      }));
    }
    // Behavioral invariants (both arms): exactly one plan_runs row and one instance
    // per sample, three items per run, every item done exactly once.
    const [counts] = await db.adminSql<Array<{ runs: number; instances: number; items: number; done: number; receipts: number }>>`
      SELECT
        (SELECT count(*)::int FROM harness_shared.plan_runs WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}) AS runs,
        (SELECT count(*)::int FROM harness_shared.harness_plans
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND template_slug = ${P013B_TEMPLATE}) AS instances,
        (SELECT count(*)::int FROM harness_shared.work_items
          WHERE workspace_id = ${WS} AND payload ? 'plan_run') AS items,
        (SELECT count(*)::int FROM harness_shared.work_items
          WHERE workspace_id = ${WS} AND payload ? 'plan_run' AND status = 'done') AS done,
        (SELECT count(*)::int FROM harness_shared.blueprint_operation_invocations
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND operation_id = ${P013B_OPERATION}
            AND target_kind = 'plan' AND target_ref IS NOT NULL) AS receipts`;
    const candidates = samples.filter((sample) => sample.arm === 'candidate').length;
    expect(counts).toEqual({ runs: sequence, instances: sequence, items: 3 * sequence, done: 3 * sequence,
      receipts: process.env.P013_MATRIX === '1' ? counts.receipts : candidates });
    expect(new Set(samples.map((sample) => sample.runId)).size).toBe(samples.length);
  }, budgetMs());
});

function matrixShape() {
  const count = (name: string, fallback: number, min: number) => {
    const value = Number(process.env[name] ?? String(fallback));
    if (!Number.isInteger(value) || value < min) throw new Error(`P-013 ${name} must be an integer >= ${min}`);
    return value;
  };
  const list = <T extends string>(name: string, fallback: string, allowed: readonly T[]): T[] => {
    const values = (process.env[name] ?? fallback).split(',').map((value) => value.trim()).filter(Boolean);
    if (values.length === 0 || values.some((value) => !allowed.includes(value as T))) {
      throw new Error(`P-013 ${name} must be a comma list of ${allowed.join('|')}`);
    }
    return values as T[];
  };
  return {
    repetitions: count('P013_REPETITIONS', 1, 1),
    repetitionOffset: count('P013_REPETITION_OFFSET', 0, 0),
    coldSamples: count('P013_COLD_SAMPLES', 1, 1),
    warmSamples: count('P013_WARM_SAMPLES', 1, 1),
    warmups: count('P013_WARMUPS', 0, 0),
    modes: list('P013_MODES', 'warm', ['warm', 'cold'] as const),
    concurrencies: list('P013_CONCURRENCIES', '1', ['1', '8'] as const).map(Number) as Array<1 | 8>,
  };
}

function budgetMs(): number {
  if (process.env.P013_MATRIX !== '1') return 180_000;
  const m = matrixShape();
  const perConcurrency = (m.modes.includes('cold') ? m.repetitions * m.coldSamples * 120_000 : 0) +
    (m.modes.includes('warm') ? m.repetitions * m.warmSamples * 10_000 : 0) + m.warmups * 10_000;
  return Math.min(115 * 60_000, Math.max(180_000, 2 * m.concurrencies.length * perConcurrency + 120_000));
}
