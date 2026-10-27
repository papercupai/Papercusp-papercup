/** P004: registered detector, real DBOS admission/recovery and physical launch effects.
 * The terminal agent transport is a PG idempotent fixture; no real agent is launched.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { fork, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { captureIsolatedWorker, isolatedTestFileWorkerOptions, recordIsolatedIntegrationProof }
  from '../test/isolated-integration-proof';
import { acceptanceGradingDispatchId } from './acceptance-grading-sweep-dispatch';
import type { AwaitingAcceptancePlanRow } from './acceptance-awaiting-plans';
// @ts-ignore -- share the maintained router's single-file deadline contract.
import { defaultTestFileRunTimeoutMs } from '../../../scripts/test-files.mjs';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql, submissions: 0 }));
const filePath = 'packages/operator-core/lib/acceptance-grading-sweep-run.integration.test.ts';
const root = resolve(import.meta.dirname, '../../..');
const phase = process.env.PAPERCUSP_GRADING_PROOF_PHASE;
const privateDriver = process.env.PAPERCUSP_TEST_RUN_GROUP?.endsWith(':grading-proof');
// The enclosing proof may have a much larger allowance. A phase owns one
// ordinary file run, so do not feed that encompassing override back into it.
const phaseEnv = { ...process.env,
  PAPERCUSP_TEST_FILE_TIMEOUT_MS: String(defaultTestFileRunTimeoutMs(1)) };
const phaseOptions = isolatedTestFileWorkerOptions(phaseEnv, 1);
const phaseTimeoutMs = phaseOptions.phaseTimeouts.executeMs + phaseOptions.killGraceMs
  + phaseOptions.drainGraceMs + 20_000;

vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./work-scope-policy', () => ({
  workScopePolicy: () => ({ mode: 'enforce', allowHarnesses: ['allowed'] }),
  isWorkScopeEnforced: () => true,
  isHarnessInScope: (slug: string | null) => !slug || slug === 'allowed',
}));
vi.mock('./plan-types/pins', () => ({ withPinnedPlanTypes: (_scope: unknown, fn: () => unknown) => fn() }));
vi.mock('./plan-acceptance-gate', () => ({
  evaluatePlanAcceptanceGate: async (slug: string) => ({ satisfied: slug.includes('no-action'), code: 'acceptance_ungraded' }),
}));
vi.mock('./acceptance-bar-pin-sweep', () => ({
  runAcceptanceBarPinSweep: async () => ({ scanned: 0, errors: [], nextCursor: null }),
}));
vi.mock('./grading-integrity', () => ({ reconcilePendingGradingAudits: async () => ({ receipts: [] }) }));
vi.mock('./task-manager/store', () => ({ listTasks: async () => [] }));
vi.mock('./acceptance-grading-sweep-observe', () => ({
  observeAcceptanceGrader: async () => ({ live: false, lastDispatchMs: null }),
}));
vi.mock('./dbos/primary-dbos-client', async () => {
  const { DBOSClient } = await import('@dbos-inc/dbos-sdk');
  let client: Awaited<ReturnType<typeof DBOSClient.create>>;
  return {
    primaryDbosAppVersion: () => 'grading-proof-v1',
    getPrimaryDbosClient: async () => {
      client ??= await DBOSClient.create({ systemDatabaseUrl: process.env.PAPERCUSP_GRADING_PROOF_DSN!, systemDatabaseSchemaName: 'dbos' });
      return { enqueue: async (...args: Parameters<typeof client.enqueue>) => {
        h.submissions++;
        if (process.env.PAPERCUSP_GRADING_PROOF_PHASE === 'before-admission') {
          await h.sql`INSERT INTO proof_boundary VALUES ('before-admission')`;
          process.kill(process.pid, 'SIGKILL');
        }
        const result = await client.enqueue(...args);
        if (process.env.PAPERCUSP_GRADING_PROOF_PHASE === 'after-admission') {
          await h.sql`INSERT INTO proof_boundary VALUES ('after-admission')`;
          process.kill(process.pid, 'SIGKILL');
        }
        return result;
      } };
    },
    closeProofClient: async () => client?.destroy(),
  };
});
// Keep the real receiver's launch-key construction. Replace only its reads and
// terminal transport with deterministic fixtures backed by this disposable DB.
vi.mock('./acceptance-grader', async original => {
  const actual = await original<typeof import('./acceptance-grader')>();
  const { parsePlan } = await import('./agent-tools/plans/parser');
  return { ...actual, resolveAcceptanceGrader: async (slug: string, ctx: Parameters<typeof actual.launchAcceptanceGrader>[1], options: { dispatchEpisodeIdentity: string }) =>
    actual.launchAcceptanceGrader(slug, ctx, {
      dispatchEpisodeIdentity: options.dispatchEpisodeIdentity,
      readPlan: async () => ({ archived: false, parsed: parsePlan('', { filePath: slug + '.md' }), row: {
        planSlug: slug, workspaceId: ctx.workspaceId, harnessSlug: ctx.harnessSlug,
        version: Date.now(), contentHash: 'neutral-revision-' + Date.now(), content: '',
        title: slug, status: 'ready', items: [], decisions: [],
      } }) as never,
      getRubric: async () => ({ rubricId: 'acceptance-' + slug, criteria: [], revision: 1 }) as never,
      getAudit: async () => ({ auditSeq: 1, items: [], findings: [] }) as never,
      readEffectiveAudits: async () => [], listWork: async () => [] as never,
      listTasks: async () => [] as never,
      launch: (async (args: { idempotencyKey: string }) => {
        const inserted = await h.sql`INSERT INTO proof_launch_effects (key, episode, plan_slug)
          VALUES (${args.idempotencyKey}, ${options.dispatchEpisodeIdentity}, ${slug})
          ON CONFLICT (key) DO NOTHING RETURNING key`;
        if (process.env.PAPERCUSP_GRADING_PROOF_PHASE === 'after-effect') {
          await h.sql`INSERT INTO proof_boundary VALUES ('after-effect')`;
          process.kill(process.pid, 'SIGKILL');
        }
        return { data: { deduped: inserted.length === 0,
          launch: { tasks: [{ taskId: args.idempotencyKey }] } } };
      }) as never,
    }),
  };
});

if (phase) {
  let sdk: typeof import('@dbos-inc/dbos-sdk');
  beforeAll(async () => {
    h.sql = postgres(process.env.PAPERCUSP_GRADING_PROOF_DSN!, { max: 4, onnotice: () => {} });
    sdk = await import('@dbos-inc/dbos-sdk');
    sdk.DBOS.setConfig({ name: 'grading-proof', systemDatabaseUrl: process.env.PAPERCUSP_GRADING_PROOF_DSN!,
      systemDatabaseSchemaName: 'dbos', applicationVersion: 'grading-proof-v1', executorID: 'grading-proof',
      runAdminServer: false, listenQueues: phase === 'after-admission' ? ['unconsumed'] : ['acceptance-grading-dispatch'] });
    // Match production bootstrap: the real grader imports the durable tool
    // orchestration receiver, whose workflow must be registered before launch.
    await import('./dbos/durable-orchestration-workflow');
    await import('./dbos/acceptance-grading-dispatch-workflow');
    await sdk.DBOS.launch();
  }, 120_000);
  afterAll(async () => {
    await (await import('./dbos/primary-dbos-client') as unknown as { closeProofClient(): Promise<void> }).closeProofClient();
    await sdk?.DBOS.shutdown();
    await h.sql?.end({ timeout: 5 });
  });
  it('executes the actual registered sweep and reconciles its persisted effects', async () => {
    await import('./harness/routines/acceptance-grading-sweep-action');
    const { getSystemAction } = await import('./harness/routines/system-actions');
    const { resetAcceptanceGradingSweepForTest } = await import('./harness/routines/acceptance-grading-sweep-action');
    const handler = getSystemAction('acceptance-grading-sweep')!;
    expect(handler).toBeTypeOf('function');
    const ctx = { workspaceId: 'proof-ws', installSlug: 'allowed', triggerConfig: {}, payloadTemplate: null };
    const started = Date.now();
    const results = await Promise.all([handler(ctx), handler(ctx)]);
    resetAcceptanceGradingSweepForTest();
    results.push(await handler(ctx));
    for (const r of results) expect(r?.diagnostics?.grading).toMatchObject({ budgetExhausted: false, failures: [] });
    expect(Date.now() - started).toBeLessThan(60_000);
    const rows = await h.sql<{ workflow_uuid: string }[]>`SELECT workflow_uuid FROM dbos.workflow_status
      WHERE name = 'acceptanceGradingDispatch'`;
    if (phase === 'empty' || phase === 'no-action') {
      expect(h.submissions).toBe(0);
      expect(rows).toEqual([]);
      expect(await h.sql`SELECT * FROM proof_launch_effects`).toEqual([]);
    } else {
      expect(rows).toHaveLength(2);
      for (const r of rows) await sdk.DBOS.getResult(r.workflow_uuid, { timeoutSeconds: 60 });
      expect(await h.sql`SELECT * FROM proof_launch_effects`).toHaveLength(2);
    }
  }, 120_000);
} else if (privateDriver) {
  let db: MigratedTestDb;
  let sql: Sql;
  beforeAll(async () => {
    db = await createFreshTestDb({ prefix: 'gradingproof' });
    sql = postgres(db.url, { max: 4, onnotice: () => {} }); h.sql = sql;
    await sql.unsafe(`CREATE SCHEMA harness_shared;
      CREATE TABLE harness_shared.harness_plans (workspace_id text, harness_slug text, plan_slug text,
        template text, template_slug text, template_data jsonb, created_at timestamptz, archived boolean DEFAULT false, status text);
      CREATE TABLE harness_shared.plan_audits (workspace_id text, plan_slug text, audit_kind text, created_at timestamptz);
      CREATE TABLE harness_shared.work_items (payload jsonb, status text);
      CREATE TABLE proof_launch_effects (key text PRIMARY KEY, episode text NOT NULL, plan_slug text NOT NULL);
      CREATE TABLE proof_boundary (phase text NOT NULL)`);
  }, 120_000);
  afterAll(async () => { await sql?.end({ timeout: 5 }); await db?.drop(); });
  async function seed(slug: string, harness = 'allowed', workspace = 'proof-ws', age = 5) {
    const date = new Date(Date.now() - age * 3_600_000);
    await sql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, template, template_data, created_at, status)
      VALUES (${workspace}, ${harness}, ${slug}, NULL, NULL, ${date}, 'ready'),
      (${workspace}, ${harness}, ${'acceptance-' + slug}, 'rubric', ${sql.json({ kind: 'acceptance', subjectPlan: slug })}, ${date}, 'ready')`;
    await sql`INSERT INTO harness_shared.plan_audits VALUES (${workspace}, ${slug}, 'completion', ${date})`;
  }
  async function runPhase(mode: string, crash = false) {
    const evidenceDir = mkdtempSync(join(process.env.PC_GRADING_PROOF_EVIDENCE_DIR!, 'phase-' + mode + '-'));
    const child = spawn(process.execPath, ['--import', './scripts/lib/committed-source-loader.mjs', 'scripts/test-files.mjs', filePath], {
      cwd: root, env: { ...phaseEnv, PAPERCUSP_GRADING_PROOF_PHASE: mode,
        PAPERCUSP_GRADING_PROOF_DSN: db.url }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = await captureIsolatedWorker(child, evidenceDir, {
      timeoutMs: phaseOptions.phaseTimeouts.executeMs,
      killGraceMs: phaseOptions.killGraceMs, drainGraceMs: phaseOptions.drainGraceMs,
    });
    const diagnostic = evidenceDir + '\n' + result.output.slice(-24_000);
    expect(result, diagnostic).toMatchObject({ code: crash ? 1 : 0, signal: null,
      timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
    if (crash) {
      const workerExits = result.output.split('\n').flatMap(line => {
        if (!line.startsWith('TEST_FILE_STARTUP_TRACE ')) return [];
        try { return [JSON.parse(line.slice('TEST_FILE_STARTUP_TRACE '.length))]; }
        catch { return []; }
      });
      // A failed router or arbitrary nonzero exit is not a crash witness.
      // The caller separately requires the committed, phase-specific SQL row.
      expect(workerExits, diagnostic).toContainEqual(expect.objectContaining({
        event: 'worker-exit', signal: 'SIGKILL', code: null, started: true,
      }));
    } else {
      expect(result.output, diagnostic).toContain('TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed');
      expect(result.output, diagnostic).toContain('skippedTests=0');
      expect(result.output, diagnostic).not.toContain('finalizationError=true');
    }
  }
  it('pages beyond the first100, wraps and filters scope before limiting the real SQL population', async () => {
    for (let i = 0; i < 205; i++) await seed('p-' + String(i).padStart(3, '0'), 'allowed', 'proof-ws', 6);
    for (let i = 0; i < 110; i++) await seed('excluded-' + i, 'excluded', 'proof-ws', 7);
    // Equal plan names in another scope remain independent cursor positions.
    await seed('p-000', 'allowed', 'other-ws', 6);
    const { listPlansAwaitingAcceptance } = await import('./acceptance-awaiting-plans');
    const seen = new Set<string>();
    let after: AwaitingAcceptancePlanRow | null = null;
    for (let tick = 0; tick < 3; tick++) {
      const page = await listPlansAwaitingAcceptance({ sql, rubricTemplateName: 'rubric', limit: 100, after });
      expect(page).toHaveLength(100);
      expect(page.every(r => r.harnessSlug === 'allowed')).toBe(true);
      for (const r of page) seen.add(JSON.stringify([r.workspaceId, r.harnessSlug, r.planSlug]));
      after = page.at(-1)!;
    }
    expect(seen.size).toBe(206);
    await sql`TRUNCATE harness_shared.harness_plans, harness_shared.plan_audits`;
  });
  it('performs empty and nonempty-no-action registered passes across re-arm and fresh processes with zero durable work', async () => {
    await runPhase('empty'); await runPhase('empty');
    await seed('no-action');
    await runPhase('no-action'); await runPhase('no-action');
    await sql`TRUNCATE harness_shared.harness_plans, harness_shared.plan_audits`;
  }, 4 * phaseTimeoutMs);
  it.each(['before-admission', 'after-admission', 'after-effect'])(
    'recovers a multi-plan pass after a fresh-process crash %s without logical duplication', async boundary => {
      await sql`TRUNCATE dbos.workflow_status CASCADE`;
      await sql`TRUNCATE proof_launch_effects, proof_boundary, harness_shared.harness_plans, harness_shared.plan_audits`;
      await seed(boundary + '-first'); await seed(boundary + '-second');
      await runPhase(boundary, true);
      expect(await sql`SELECT phase FROM proof_boundary`).toContainEqual({ phase: boundary });
      const before = await sql`SELECT * FROM proof_launch_effects`;
      expect(before.length).toBe(boundary === 'after-effect' ? 1 : 0);
      await runPhase('recover');
      await runPhase('recover');
      const { listPlansAwaitingAcceptance } = await import('./acceptance-awaiting-plans');
      const candidates = await listPlansAwaitingAcceptance({ sql, rubricTemplateName: 'rubric' });
      const expected = candidates.map(r => acceptanceGradingDispatchId({ ...r, harnessSlug: r.harnessSlug!, gradeableSinceMs: r.gradeableSinceMs! })).sort();
      const workflows = await sql<{ workflow_uuid: string; status: string }[]>`SELECT workflow_uuid, status FROM dbos.workflow_status
        WHERE name = 'acceptanceGradingDispatch' ORDER BY workflow_uuid`;
      expect(workflows.map(r => r.workflow_uuid)).toEqual(expected);
      expect(workflows.every(r => r.status === 'SUCCESS')).toBe(true);
      expect((await sql<{ episode: string }[]>`SELECT episode FROM proof_launch_effects ORDER BY episode`).map(r => r.episode)).toEqual(expected);
    }, 3 * phaseTimeoutMs);
} else {
  const options = isolatedTestFileWorkerOptions(process.env, 1);
  it('retains the private registered-sweep recovery and disposable-runtime cleanup proof', async context => {
    // Thirteen sequential child routers cover fresh-process no-op and crash
    // boundaries. Require an explicit full-proof allowance before allocation;
    // phaseEnv above retains each ordinary single-file child deadline.
    const runId = await recordIsolatedIntegrationProof({ root, filePath,
      minimumFileRunTimeoutMs: 90 * 60_000,
      sourcePaths: [filePath, 'packages/operator-core/lib/acceptance-grading-sweep-run.ts',
        'packages/operator-core/lib/acceptance-awaiting-plans.ts', 'packages/operator-core/lib/acceptance-grading-sweep-dispatch.ts',
        'packages/operator-core/lib/acceptance-grader.ts', 'packages/operator-core/lib/harness/routines/acceptance-grading-sweep-action.ts',
        'packages/operator-core/lib/dbos/acceptance-grading-dispatch-workflow.ts', 'packages/operator-core/test/isolated-integration-proof.ts',
        'scripts/with-test-pg.mjs'],
      execute: async (observe, evidenceDir) => {
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1',
          PC_GRADING_PROOF_EVIDENCE_DIR: evidenceDir,
          PAPERCUSP_TEST_RUN_GROUP: (process.env.PAPERCUSP_TEST_RUN_GROUP ?? '') + ':grading-proof' };
        for (const key of ['PC_EXECUTED_SOURCE_MAP_OUT', 'PC_EXECUTED_SOURCE_MAP_RESULT', 'PC_EXECUTED_SOURCE_MAP_WORKSPACE',
          'PAPERCUSP_TEST_RUN_RECEIPT_FILE', 'PAPERCUSP_TEST_RUNS_DB_URL', 'PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE']) delete env[key];
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime', '--', process.execPath,
          '--import', './scripts/lib/committed-source-loader.mjs', 'scripts/test-files.mjs', filePath],
        { cwd: root, env, detached: true, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        observe(child);
        const result = await captureIsolatedWorker(child, evidenceDir, options);
        expect(result, result.output.slice(-8000)).toMatchObject({ code: 0, signal: null, timedOut: false,
          exitWaitTimedOut: false, stdioDrainTimedOut: false });
        expect(result.output).toContain('TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed');
        expect(result.output).toContain('skippedTests=0');
      } });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ISOLATED_GRADING_SWEEP_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);
}
