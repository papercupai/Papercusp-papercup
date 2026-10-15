/**
 * beekeeper-gen0.integration.test.ts — the de-stub contract (real PG).
 *
 * Plan: apiary-generation-0-battery-2026-06-08. The PART-B "battery" was a STUB
 * (random scores, ephemeral DB). This proves the REAL wiring end-to-end with
 * zero spend: the orchestrator (`runBeekeeperBattery`) + the REAL metric
 * collector + the REAL `BeekeeperStorePg` against a testcontainer PG, mocking
 * ONLY the two injected effects (`runInstance`, `collectAndDistill`) and the
 * judge `llmCall`.
 *
 * The headline assertion is D-004: `collectAndDistill` now returns the run's
 * REAL `signals`, and the orchestrator threads them into the collectors — so the
 * seven metrics measure the actual run (a "solved, no-escalation, 150-token"
 * case scores success=true / tokens=150; an "escalated" case scores
 * success=false / escalation=true), NOT the stubbed defaults.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { readRepoFile } from '@papercusp/test-config';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { runBeekeeperBattery, type BeekeeperConfig, type BeekeeperDeps } from './beekeeper-runner';
import { seedCorpus } from './corpus';
import { BeekeeperStorePg } from './beekeeper-store-pg';
import { createMetricsCollector, type IQBatteryMetrics } from './collectors';
import type { CorpusCase } from './corpus';
import type { GymJudgeRubric } from '../gym/judge-scoring';

function migrationDdl(name: string): string {
  // Depth-/machine-proof (DG-6 P-049): walk up to the checkout root — no
  // hardcoded dev-box paths; runnable from (stagingSha, shard) on any machine.
  // Strip psql meta (`\\set …`) + standalone BEGIN;/COMMIT; so sql.unsafe
  // (which speaks SQL, not psql) can apply any migration file, incl. the
  // newer expand-contract renames (e.g. 555) that carry the txn wrapper.
  return readRepoFile(__dirname, `libs/papercusp/libs/db/sql/${name}`)
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('\\') && !/^(BEGIN|COMMIT);\s*$/i.test(l.trim()))
    .join('\n');
}

const RUBRIC: GymJudgeRubric = {
  version: 'v1-test',
  model: 'claude-opus-4-8',
  temperature: 0,
  thinkingBudgetTokens: 16_000,
  weights: { d1: 0.5, d2: 0.25, d3: 0.25 },
  dimensions: { d1: 'Intent & spec fidelity', d2: 'Code quality', d3: 'Process correctness' },
} as unknown as GymJudgeRubric;

function caseOf(variant: string, title: string): CorpusCase {
  return {
    id: `case-${variant}-${title}`.slice(0, 60),
    variant: variant as CorpusCase['variant'],
    title,
    prompt: `solve: ${title}`,
    groundTruth: {},
    rubric: {
      dimensions: [
        { name: 'Correctness', description: 'correct', weight: 0.5, scoring: 'binary' },
        { name: 'Quality', description: 'quality', weight: 0.5, scoring: 'binary' },
      ],
    },
    rotationIndex: 0,
    createdAt: new Date(),
  } as unknown as CorpusCase;
}

/** A real BeekeeperDeps with the two effects + judge mocked (no spawn, no network). */
function makeDeps(sql: postgres.Sql, opts: {
  signalsFor: (caseId: string) => Partial<IQBatteryMetrics> & {
    workItemStatus?: string; escalated?: boolean; inputTokens?: number; outputTokens?: number;
  };
  capturedMetrics: IQBatteryMetrics[];
}): BeekeeperDeps {
  const collector = { current: null as Awaited<ReturnType<typeof createMetricsCollector>> | null };
  return {
    store: new BeekeeperStorePg(sql),
    async runInstance(input) {
      return { instanceId: 'inst-1', instanceUrl: 'mock://x', targetSlug: 'gen0', costUsd: 0.01 };
    },
    async collectAndDistill({ case: c }) {
      return {
        distilledTrace: `trace for ${c.id}`,
        traceRef: `ref://${c.id}`,
        rawSignals: { caseId: c.id },
        signals: opts.signalsFor(c.id),
      };
    },
    async collectMetrics(input) {
      if (!collector.current) collector.current = await createMetricsCollector(sql);
      const m = await collector.current.collectMetrics(input);
      opts.capturedMetrics.push(m);
      return m;
    },
    llmCall: async () => ({
      text: '{"d1": 8, "d2": 7, "d3": 9, "rationale": "ok"}',
      costUsd: 0, inputTokens: 10, outputTokens: 10,
    }),
    newRunId: (caseId, repeat) => `run-${caseId}-r${repeat}`,
    now: () => 1_700_000_000_000,
  };
}

describe('beekeeper gen-0 battery — the de-stub contract (real PG)', () => {
  let admin: postgres.Sql;
  let sql: postgres.Sql;

  beforeAll(async () => {
    const adminUri = await getTestPg();
    const dbName = `bk_gen0_${randomBytes(5).toString('hex')}`;
    admin = postgres(adminUri, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
    const u = new URL(adminUri); u.pathname = `/${dbName}`;
    sql = postgres(u.toString(), { max: 6, onnotice: () => {} });
    await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
    await sql.unsafe(migrationDdl('179-iq-battery-corpus.sql'));
    await sql.unsafe(migrationDdl('180-beekeeper-runner.sql'));
    await sql.unsafe(migrationDdl('217-beekeeper-repeats-and-gen0-uniqueness.sql'));
    // P-009 Phase 2 (WI-3954): rename beekeeper_* -> cup_keeper_* so this rig
    // mirrors the live post-555 schema the store (BeekeeperStorePg) now writes.
    // Only the iq-battery tables are renamed inline (not the full 555 file, whose
    // UNCONDITIONAL compat VIEW targets cup_claim_specs — absent here → 42P01).
    // The store's ON CONFLICT targets are column lists (not constraint names), so
    // a table-only rename is sufficient.
    await sql.unsafe(`
      ALTER TABLE harness_shared.beekeeper_instances RENAME TO cup_keeper_instances;
      ALTER TABLE harness_shared.beekeeper_runs      RENAME TO cup_keeper_runs;
      ALTER TABLE harness_shared.beekeeper_scores    RENAME TO cup_keeper_scores;
    `);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await admin?.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql.unsafe(
      'TRUNCATE harness_shared.cup_keeper_scores, harness_shared.cup_keeper_runs, harness_shared.cup_keeper_instances CASCADE',
    );
  });

  it('seedCorpus persists all 20 cases with valid jsonb (regression: org-pool jsonb bind — corpus.ts:891)', async () => {
    // The smoke caught seedCorpus binding RAW objects to jsonb columns (ground_truth/rubric) →
    // postgres-js byteLength(Object) throws on a prepared statement. The fix is `${JSON.stringify(x)}::jsonb`.
    // A default `postgres(uri)` connection uses prepare:true, so this reproduces + guards the bug.
    await seedCorpus(sql);
    const [{ n }] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM iq_battery_cases`;
    expect(Number(n)).toBe(20);
    const rows = await sql<{ gt: unknown; rub: unknown }[]>`
      SELECT ground_truth AS gt, rubric AS rub FROM iq_battery_cases ORDER BY variant, rotation_index LIMIT 1`;
    // jsonb round-trips to valid JSON (parsed or raw depending on the connection's parse config).
    const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
    expect(typeof parse(rows[0].gt)).toBe('object');
    expect(parse(rows[0].rub)).toHaveProperty('dimensions');
  });

  it('D-004: threads REAL signals → the collectors measure the actual run (not stubbed defaults)', async () => {
    const solved = caseOf('fix-injected-bug', 'solved');
    const escalated = caseOf('build-spec', 'escalated');
    const captured: IQBatteryMetrics[] = [];

    const deps = makeDeps(sql, {
      capturedMetrics: captured,
      signalsFor: (id) =>
        id === solved.id
          ? { workItemStatus: 'done', escalated: false, inputTokens: 100, outputTokens: 50 }
          : { workItemStatus: 'escalated', escalated: true },
    });
    const config: BeekeeperConfig = {
      instanceSpec: { manifest: { instanceId: 'inst-1', workspaceId: 'default', codeSha: 'abc', createdAt: new Date() }, instanceUrl: 'mock://x' },
      corpus: [solved, escalated],
      repeats: 1,
      rubric: RUBRIC,
      maxDistillChars: 2000,
    };

    const result = await runBeekeeperBattery(config, deps);

    expect(result.totalCases).toBe(2);
    const solvedM = captured.find((m) => m.runId.includes('solved'))!;
    const escM = captured.find((m) => m.runId.includes('escalated'))!;
    // solved: success from status=done + not escalated; tokens = 100+50
    expect(solvedM.success).toBe(true);
    expect(solvedM.tokensPerSolvedTask).toBe(150);
    expect(solvedM.escalation).toBe(false);
    // escalated: NOT a success, escalation flagged — proves the signal flowed
    expect(escM.success).toBe(false);
    expect(escM.escalation).toBe(true);
  });

  it('persists one beekeeper_run + one beekeeper_score per case to real PG (repeats=1)', async () => {
    const cases = [caseOf('find-the-flaw', 'a'), caseOf('answer-from-colony-memory', 'b')];
    const deps = makeDeps(sql, {
      capturedMetrics: [],
      signalsFor: () => ({ workItemStatus: 'done', escalated: false, inputTokens: 10, outputTokens: 10 }),
    });
    const config: BeekeeperConfig = {
      instanceSpec: { manifest: { instanceId: 'inst-1', workspaceId: 'default', codeSha: 'abc', createdAt: new Date() }, instanceUrl: 'mock://x' },
      corpus: cases, repeats: 1, rubric: RUBRIC, maxDistillChars: 2000,
    };

    const result = await runBeekeeperBattery(config, deps);

    expect(result.passedCases).toBe(2);
    const [{ runs }] = await sql<{ runs: string }[]>`SELECT count(*)::text AS runs FROM harness_shared.cup_keeper_runs`;
    const [{ scores }] = await sql<{ scores: string }[]>`SELECT count(*)::text AS scores FROM harness_shared.cup_keeper_scores`;
    expect(Number(runs)).toBe(2);
    expect(Number(scores)).toBe(2);
  });

  it('D-005: re-running the SAME instance + run ids is idempotent (no duplicate-PK crash, scores overwritten)', async () => {
    // Regression for the gen-0 baseline crash: instance_id and run_id are DETERMINISTIC
    // (`gen0-<sha>-<case>-r<repeat>`), so a re-run at the same commit reuses every id.
    // upsertInstance/startRun/recordScore must be idempotent (D-005) — the prior store did a
    // plain INSERT (+ a mis-targeted instance ON CONFLICT) and threw
    // `duplicate key … cup_keeper_instances_pkey`. NOTE: no TRUNCATE here — that is the whole
    // point; the other tests truncate in beforeEach, which is why this never got caught.
    const cases = [caseOf('find-the-flaw', 'idem-a'), caseOf('build-spec', 'idem-b')];
    const config: BeekeeperConfig = {
      instanceSpec: { manifest: { instanceId: 'inst-idem', workspaceId: 'default', codeSha: 'sha-idem', createdAt: new Date() }, instanceUrl: 'mock://x' },
      corpus: cases, repeats: 1, rubric: RUBRIC, maxDistillChars: 2000,
    };
    const mkDeps = () => makeDeps(sql, {
      capturedMetrics: [],
      signalsFor: () => ({ workItemStatus: 'done', escalated: false, inputTokens: 10, outputTokens: 10 }),
    });

    const first = await runBeekeeperBattery(config, mkDeps());
    expect(first.passedCases).toBe(2);

    // Re-run the identical config — must NOT throw on any duplicate key.
    const second = await runBeekeeperBattery(config, mkDeps());
    expect(second.passedCases).toBe(2);
    expect(second.outcomes.filter((o) => o.status === 'errored').length).toBe(0);

    // Idempotent: still exactly one instance, N runs, N scores — re-run overwrote, didn't append.
    const [{ insts }] = await sql<{ insts: string }[]>`SELECT count(*)::text AS insts FROM harness_shared.cup_keeper_instances`;
    const [{ runs }] = await sql<{ runs: string }[]>`SELECT count(*)::text AS runs FROM harness_shared.cup_keeper_runs`;
    const [{ scores }] = await sql<{ scores: string }[]>`SELECT count(*)::text AS scores FROM harness_shared.cup_keeper_scores`;
    expect(Number(insts)).toBe(1);
    expect(Number(runs)).toBe(2);
    expect(Number(scores)).toBe(2);
  });

  it('repeats > 1 produce one scored run per (case × repeat) — noise calibration works (D-012)', async () => {
    // newRunId keys each run by (caseId, repeat), so the same case run twice
    // produces two distinct runs that both score — the noise-calibration repeats
    // (D-012) the orchestrator supports.
    const deps = makeDeps(sql, { capturedMetrics: [], signalsFor: () => ({ workItemStatus: 'done', escalated: false }) });
    const config: BeekeeperConfig = {
      instanceSpec: { manifest: { instanceId: 'inst-1', workspaceId: 'default', codeSha: 'abc', createdAt: new Date() }, instanceUrl: 'mock://x' },
      corpus: [caseOf('fix-injected-bug', 'r')], repeats: 2, rubric: RUBRIC, maxDistillChars: 2000,
    };

    const result = await runBeekeeperBattery(config, deps);

    // One outcome per (case × repeat) — the orchestrator iterates repeats.
    expect(result.outcomes.length).toBe(2);
    const scored = result.outcomes.filter((o) => o.status === 'scored').length;
    // BOTH repeats must score (EI-164: the old UNIQUE(instance_id, case_id)
    // errored repeat 2, and `scored >= 1` masked it — mig 217 dropped it).
    expect(scored).toBe(2);
    // Invariant: exactly the scored runs are persisted (one beekeeper_run each).
    const [{ runs }] = await sql<{ runs: string }[]>`SELECT count(*)::text AS runs FROM harness_shared.cup_keeper_runs`;
    expect(Number(runs)).toBe(scored);
  });

  it('a single instance failure is recorded as errored and the battery continues (per-run isolation)', async () => {
    const ok = caseOf('build-spec', 'ok');
    const boom = caseOf('build-spec', 'boom');
    const deps = makeDeps(sql, { capturedMetrics: [], signalsFor: () => ({ workItemStatus: 'done', escalated: false }) });
    // A clean failure seam: the instance run throws for the 'boom' case only.
    deps.runInstance = async ({ case: c }) => {
      if (c.id === boom.id) throw new Error('instance boot failed');
      return { instanceId: 'inst-1', instanceUrl: 'mock://x', targetSlug: 'gen0', costUsd: 0.01 };
    };
    const config: BeekeeperConfig = {
      instanceSpec: { manifest: { instanceId: 'inst-1', workspaceId: 'default', codeSha: 'abc', createdAt: new Date() }, instanceUrl: 'mock://x' },
      corpus: [ok, boom], repeats: 1, rubric: RUBRIC, maxDistillChars: 2000,
    };

    const result = await runBeekeeperBattery(config, deps);

    expect(result.totalCases).toBe(2);
    expect(result.outcomes.filter((o) => o.status === 'scored').length).toBe(1);
    expect(result.outcomes.filter((o) => o.status === 'errored').length).toBe(1);
  });
});
