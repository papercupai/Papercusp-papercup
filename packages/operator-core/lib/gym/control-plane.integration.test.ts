/**
 * control-plane.integration.test.ts — the gym autoloop control plane
 * (getAutoloop/setAutoloop over gym_autoloop_config, mig 110), against a real
 * Postgres. Both take sql directly (injectable).
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - setAutoloop is a read-merge-write upsert: a PARTIAL set PRESERVES unset
 *    fields (enabled/spentUsd/status/lastCycle…);
 *  - budgetUsd distinguishes null from undefined — `null` CLEARS the cap,
 *    `undefined` PRESERVES the existing cap (the `q.budgetUsd !== undefined`
 *    test, not `??`);
 *  - full round-trip via getAutoloop; null for an unknown harness.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { createCandidateVersionVerdict } from './loop';
import { decideAccept, type VariantEval } from './gate-engine';
import { unmeasuredEvidence } from './gates';
import { readProducerObservations } from '../experiment/producer-lifecycle-store';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { getAutoloop, setAutoloop, getPrompts, setPrompt, recordProposal, listProposals, autoDecideRunProposals, GYM_PROMPT_KEYS } = await import('./control-plane');
const AGENT_ROLE = (GYM_PROMPT_KEYS as readonly string[]).find((k) => k !== 'judge')!; // a valid non-judge editable role

const WS = 'ws-cp';
const HS = 'web';
let rootSql: postgres.Sql;
const read = () => getAutoloop(rootSql, { workspaceId: WS, harnessSlug: HS });

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `cp_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.gym_autoloop_config (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      enabled boolean NOT NULL DEFAULT false,
      budget_usd double precision,
      spent_usd double precision NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'idle',
      last_cycle integer, last_cycle_at bigint,
      updated_at bigint NOT NULL,
      PRIMARY KEY (workspace_id, harness_slug)
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.harness_prompt_overrides (
      workspace_id text NOT NULL, harness_slug text NOT NULL, role text NOT NULL,
      prompt_md text NOT NULL, updated_at bigint NOT NULL,
      PRIMARY KEY (workspace_id, harness_slug, role)
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.gym_champion_outcomes (
      proposal_id text PRIMARY KEY,
      workspace_id text NOT NULL, harness_slug text NOT NULL,
      role text NOT NULL, variant_id text, cycle integer NOT NULL DEFAULT 0,
      accepted_at bigint NOT NULL,
      baseline_dev_anchor_delta double precision, baseline_cost_delta double precision,
      baseline_probe_status text,
      baseline_runs integer NOT NULL DEFAULT 0, baseline_succeeded integer NOT NULL DEFAULT 0,
      baseline_failed integer NOT NULL DEFAULT 0,
      post_window_ends_at bigint NOT NULL,
      post_runs integer, post_succeeded integer, post_failed integer,
      success_rate_delta double precision,
      verdict text NOT NULL DEFAULT 'pending', evaluated_at bigint
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.spawned_agents (
      workspace_id text NOT NULL, harness_slug text NOT NULL,
      child_role text NOT NULL, status text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now()
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.gym_proposals (
      id text PRIMARY KEY,
      workspace_id text NOT NULL, harness_slug text NOT NULL,
      cycle integer NOT NULL DEFAULT 0, variant_id text, role text NOT NULL,
      original_md text, proposed_md text NOT NULL, rationale text,
      dev_anchor_delta double precision, cost_delta double precision, probe_status text,
      status text NOT NULL DEFAULT 'pending', created_at bigint NOT NULL, decided_at bigint,
      task_corpus text NOT NULL DEFAULT 'synthetic', candidate_verdict jsonb,
      learning_lifecycle jsonb
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.gym_autoloop_config, harness_shared.harness_prompt_overrides, harness_shared.gym_proposals, harness_shared.gym_champion_outcomes, harness_shared.spawned_agents`;
});

describe('setAutoloop / getAutoloop (PG)', () => {
  it('full upsert round-trips every field', async () => {
    const cfg = await setAutoloop(rootSql, { workspaceId: WS, harnessSlug: HS, enabled: true, budgetUsd: 100, spentUsd: 5, status: 'running', lastCycle: 3, lastCycleAt: 1000 });
    expect(cfg).toMatchObject({ enabled: true, budgetUsd: 100, spentUsd: 5, status: 'running', lastCycle: 3, lastCycleAt: 1000 });
    expect(await read()).toMatchObject({ enabled: true, budgetUsd: 100, spentUsd: 5, status: 'running', lastCycle: 3, lastCycleAt: 1000 });
  });

  it('a PARTIAL set preserves unset fields (read-merge-write)', async () => {
    await setAutoloop(rootSql, { workspaceId: WS, harnessSlug: HS, enabled: true, budgetUsd: 100, spentUsd: 7 });
    await setAutoloop(rootSql, { workspaceId: WS, harnessSlug: HS, status: 'running' }); // only status
    expect(await read()).toMatchObject({ enabled: true, budgetUsd: 100, spentUsd: 7, status: 'running' }); // rest preserved
  });

  it('budgetUsd: undefined PRESERVES the cap, null CLEARS it', async () => {
    await setAutoloop(rootSql, { workspaceId: WS, harnessSlug: HS, budgetUsd: 100 });
    await setAutoloop(rootSql, { workspaceId: WS, harnessSlug: HS, spentUsd: 5 }); // budgetUsd undefined → preserve
    expect((await read())!.budgetUsd).toBe(100);
    await setAutoloop(rootSql, { workspaceId: WS, harnessSlug: HS, budgetUsd: null }); // explicit null → clear the cap
    expect((await read())!.budgetUsd).toBeNull();
  });

  it('getAutoloop returns null for an unknown harness', async () => {
    expect(await getAutoloop(rootSql, { workspaceId: WS, harnessSlug: 'nope' })).toBeNull();
  });
});

describe('setPrompt / getPrompts (PG)', () => {
  it('upserts role-scoped prompts; getPrompts splits the judge rubric from the role overrides', async () => {
    await setPrompt(rootSql, { workspaceId: WS, harnessSlug: HS, role: 'judge', md: 'RUBRIC v1' });
    await setPrompt(rootSql, { workspaceId: WS, harnessSlug: HS, role: AGENT_ROLE, md: 'ROLE v1' });
    let p = await getPrompts(rootSql, { workspaceId: WS, harnessSlug: HS });
    expect(p.judgeRubric).toBe('RUBRIC v1'); // role='judge' → judgeRubric
    expect(p.roles[AGENT_ROLE]).toBe('ROLE v1'); // other roles → roles map

    await setPrompt(rootSql, { workspaceId: WS, harnessSlug: HS, role: 'judge', md: 'RUBRIC v2' }); // same (ws,harness,role) → upsert
    p = await getPrompts(rootSql, { workspaceId: WS, harnessSlug: HS });
    expect(p.judgeRubric).toBe('RUBRIC v2'); // overwritten, not duplicated
    expect(await rootSql`SELECT 1 FROM harness_shared.harness_prompt_overrides WHERE role='judge'`).toHaveLength(1);
  });

  it('rejects a non-editable prompt key (not judge or an agent role)', async () => {
    await expect(setPrompt(rootSql, { workspaceId: WS, harnessSlug: HS, role: 'definitely-not-a-role', md: 'x' })).rejects.toThrow();
  });
});

describe('recordProposal (PG)', () => {
  const propose = (over: Record<string, unknown> = {}) =>
    recordProposal(rootSql, { workspaceId: WS, harnessSlug: HS, cycle: 1, variantId: 'v1', role: AGENT_ROLE, proposedMd: 'P v1', ...over });

  it('upserts a pending proposal deterministically; a retried cycle updates the PENDING row', async () => {
    const id = await propose({ proposedMd: 'P v1' });
    expect(id).toBe(`v1__${AGENT_ROLE}`); // deterministic id per (variant, role)
    await propose({ proposedMd: 'P v2' }); // retry same (variant, role) → same id → update
    const rows = await rootSql<{ proposed_md: string }[]>`SELECT proposed_md FROM harness_shared.gym_proposals WHERE id=${id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.proposed_md).toBe('P v2'); // pending row updated
    const receipts = await readProducerObservations(rootSql, { producer: 'gym', workspaceId: WS });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      sourceRef: `gym:${id}`, sourceCurrent: true, stage: 'observation',
      contract: null, promotionAllowed: false, source: { proposed_md: 'P v2', status: 'pending' },
    });
  });

  it('persists the detached candidate and rollback receipt through the native proposal writer', async () => {
    const variant = { promptOverrides: { [AGENT_ROLE]: 'evaluated prompt' } };
    const parent = { promptOverrides: { [AGENT_ROLE]: 'rollback prompt' } };
    const measured = (variantId: string, trainAgg: number) => ({
      evalResult: { variantId, trainAgg, trainVector: [trainAgg], devAnchorAgg: trainAgg,
        realAnchorAgg: 0, realAnchorEvidence: unmeasuredEvidence(['real-task']), meanCost: 1,
        regressionEvidence: unmeasuredEvidence(['task']), probeEvidence: unmeasuredEvidence(['probe']) } satisfies VariantEval,
      costUsd: 2, runIds: [`fixture-run:${variantId}`],
    });
    const evaluation = { candidate: measured('v1', 8), parent: measured('baseline', 7),
      champion: measured('incumbent', 7), thresholds: { epsilon: 0.2, delta: 0.3, costCeiling: 2 }, baselineMeanCost: 1 };
    const gates = decideAccept(evaluation.candidate.evalResult, evaluation.parent.evalResult,
      evaluation.champion.evalResult, evaluation.baselineMeanCost, evaluation.thresholds);
    const candidateVersion = createCandidateVersionVerdict({
      candidateId: 'v1', parentId: 'baseline', variant, parent, recordedAt: 1,
      gateResults: gates.results, evaluation,
    });
    const expected = JSON.parse(JSON.stringify(candidateVersion));
    variant.promptOverrides[AGENT_ROLE] = 'later candidate edit';
    parent.promptOverrides[AGENT_ROLE] = 'later rollback edit';
    evaluation.candidate.evalResult.trainVector[0] = -100;
    evaluation.champion.runIds.push('later-run');
    const id = await propose({ proposedMd: 'evaluated prompt', candidateVersion });
    const row = (await rootSql`SELECT candidate_verdict FROM harness_shared.gym_proposals WHERE id=${id}`)[0]!;
    expect(row.candidate_verdict).toEqual(expected);
    const saved = row.candidate_verdict.evaluation;
    expect(decideAccept(saved.candidate.evalResult, saved.parent.evalResult, saved.champion.evalResult,
      saved.baselineMeanCost, saved.thresholds).results).toEqual(row.candidate_verdict.gateResults);
    const receipts = await readProducerObservations(rootSql, { producer: 'gym', workspaceId: WS });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ sourceCurrent: true, promotionAllowed: false, contract: null,
      source: { candidate_verdict: expected, proposed_md: 'evaluated prompt' } });
  });

  it('NEVER resurrects a DECIDED proposal — the conflict-update only touches a still-pending row', async () => {
    const id = await propose({ proposedMd: 'P v1' });
    await rootSql`UPDATE harness_shared.gym_proposals SET status='accepted' WHERE id=${id}`; // human decided
    await propose({ proposedMd: 'P v2-should-be-ignored' }); // re-record the same id
    const row = (await rootSql<{ proposed_md: string; status: string }[]>`SELECT proposed_md, status FROM harness_shared.gym_proposals WHERE id=${id}`)[0]!;
    expect(row.status).toBe('accepted'); // decision survives
    expect(row.proposed_md).toBe('P v1'); // NOT overwritten — the WHERE status='pending' blocked it
  });

  it('listProposals filters by status + variant, newest cycle first', async () => {
    await propose({ id: 'a', cycle: 1, variantId: 'v1', proposedMd: 'A' });
    await propose({ id: 'b', cycle: 3, variantId: 'v1', proposedMd: 'B' });
    await propose({ id: 'c', cycle: 2, variantId: 'v2', proposedMd: 'C' });
    const v1 = await listProposals(rootSql, { workspaceId: WS, harnessSlug: HS, variantId: 'v1' });
    expect(v1.map((p) => p.id)).toEqual(['b', 'a']); // cycle DESC, only v1
    const pending = await listProposals(rootSql, { workspaceId: WS, harnessSlug: HS, status: 'pending' });
    expect(pending).toHaveLength(3); // all pending
  });
});

describe('autoDecideRunProposals — autonomous promotion (owner mandate 2026-07-19)', () => {
  const RUN_START = 1_800_000_000_000;
  const NOW = RUN_START + 60_000;
  // This minimal harness carries no engineer_issues table, so the accept
  // path's BEST-EFFORT champion-escalation capture warns (accept unaffected —
  // exactly its fail-soft contract). Expected here; assert it stays that warn.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      const msg = String(args[0]);
      const expectedFailSoft =
        msg.includes('champion-escalation capture failed') ||
        msg.includes('[change-ledger] FAILED to record');
      if (!expectedFailSoft) {
        throw new Error(`unexpected console.warn: ${args.map(String).join(' ')}`);
      }
    });
  });
  afterEach(() => warnSpy.mockRestore());
  const seed = (over: {
    id: string;
    createdAt: number;
    devAnchorDelta: number | null;
    status?: string;
    proposedMd?: string;
    candidateVerdict?: unknown;
  }) =>
    rootSql`
      INSERT INTO harness_shared.gym_proposals
      (id, workspace_id, harness_slug, cycle, variant_id, role, proposed_md,
         dev_anchor_delta, status, candidate_verdict, created_at)
      VALUES
        (${over.id}, ${WS}, ${HS}, 1, ${over.id}, ${AGENT_ROLE},
         ${over.proposedMd ?? `P ${over.id}`}, ${over.devAnchorDelta},
         ${over.status ?? 'pending'}, ${JSON.stringify(over.candidateVerdict ?? {
           schemaVersion: 1,
           candidateId: over.id,
           parentId: 'baseline',
           variant: { promptOverrides: { [AGENT_ROLE]: `P ${over.id}` } },
           parent: { promptOverrides: {} },
           hashes: { variantHash: 'variant', parentHash: 'parent', evaluatorHash: 'evaluator', rubricHash: 'rubric', taskHash: 'task', codeHash: 'code' },
           gateResults: [
             {
               gate: 'fixture',
               pass: over.devAnchorDelta != null && over.devAnchorDelta > 0,
               status: over.devAnchorDelta != null && over.devAnchorDelta > 0 ? ('pass' as const) : ('fail' as const),
               detail: 'fixture',
             },
             // P-002 / D-004(3): promotion now also requires the real-anchor pool to
             // have held. Tracks the fixture gate so a seeded "winner" still wins and a
             // seeded "loser" still loses — the point of THESE tests is the sweep's
             // accept/reject bookkeeping, not the gate, which has its own coverage.
             {
               gate: 'real-anchor-no-regress',
               pass: over.devAnchorDelta != null && over.devAnchorDelta > 0,
               status: over.devAnchorDelta != null && over.devAnchorDelta > 0 ? ('pass' as const) : ('fail' as const),
               detail: 'fixture',
             },
           ],
           verdict: over.devAnchorDelta != null && over.devAnchorDelta > 0 ? 'accept' : 'reject',
           recordedAt: over.createdAt,
         })}::text::jsonb, ${over.createdAt})`;

  it('accepts the winner (prompt promoted + outcome window opened), rejects the rest, leaves pre-run rows alone', async () => {
    await seed({ id: 'old-pending', createdAt: RUN_START - 10_000, devAnchorDelta: 9 }); // BEFORE the run
    await seed({ id: 'winner', createdAt: RUN_START + 1, devAnchorDelta: 0.05, proposedMd: 'CHAMPION MD' });
    await seed({ id: 'loser', createdAt: RUN_START + 2, devAnchorDelta: -0.02 });
    await seed({ id: 'no-delta', createdAt: RUN_START + 3, devAnchorDelta: null });

    const res = await autoDecideRunProposals(rootSql, {
      workspaceId: WS,
      harnessSlug: HS,
      sinceMs: RUN_START,
      now: NOW,
    });
    expect(res).toEqual({ accepted: 1, rejected: 2 });

    const byId = new Map(
      (await rootSql<{ id: string; status: string; decided_at: string | null }[]>`
        SELECT id, status, decided_at FROM harness_shared.gym_proposals`).map((r) => [r.id, r]),
    );
    expect(byId.get('winner')!.status).toBe('accepted');
    expect(byId.get('loser')!.status).toBe('rejected');
    expect(byId.get('no-delta')!.status).toBe('rejected');
    // A row recorded BEFORE this run is not this run's to decide.
    expect(byId.get('old-pending')!.status).toBe('pending');

    // The winning challenger's prompt IS the new champion (the same atomic
    // write the human accept performed).
    const promo = await rootSql<{ prompt_md: string }[]>`
      SELECT prompt_md FROM harness_shared.harness_prompt_overrides
       WHERE workspace_id = ${WS} AND harness_slug = ${HS} AND role = ${AGENT_ROLE}`;
    expect(promo).toHaveLength(1);
    expect(promo[0]!.prompt_md).toBe('CHAMPION MD');

    // Acceptance opened the post-acceptance outcome-tracking window.
    const outcome = await rootSql<{ proposal_id: string; verdict: string }[]>`
      SELECT proposal_id, verdict FROM harness_shared.gym_champion_outcomes`;
    expect(outcome).toHaveLength(1);
    expect(outcome[0]!.proposal_id).toBe('winner');
    expect(outcome[0]!.verdict).toBe('pending');
  });

  it('is idempotent — a second sweep finds nothing pending and decides nothing', async () => {
    await seed({ id: 'winner', createdAt: RUN_START + 1, devAnchorDelta: 1 });
    await autoDecideRunProposals(rootSql, { workspaceId: WS, harnessSlug: HS, sinceMs: RUN_START, now: NOW });
    const again = await autoDecideRunProposals(rootSql, { workspaceId: WS, harnessSlug: HS, sinceMs: RUN_START, now: NOW });
    expect(again).toEqual({ accepted: 0, rejected: 0 });
  });

  it('never touches already-decided rows in the window', async () => {
    await seed({ id: 'decided', createdAt: RUN_START + 1, devAnchorDelta: 5, status: 'rejected' });
    const res = await autoDecideRunProposals(rootSql, { workspaceId: WS, harnessSlug: HS, sinceMs: RUN_START, now: NOW });
    expect(res).toEqual({ accepted: 0, rejected: 0 });
    const rows = await rootSql<{ status: string }[]>`SELECT status FROM harness_shared.gym_proposals WHERE id = 'decided'`;
    expect(rows[0]!.status).toBe('rejected');
  });

  it('does not auto-promote a positive dev-anchor delta when the immutable gate verdict rejects', async () => {
    await seed({
      id: 'unsafe-positive',
      createdAt: RUN_START + 1,
      devAnchorDelta: 5,
      candidateVerdict: {
        schemaVersion: 1,
        candidateId: 'unsafe-positive',
        parentId: 'baseline',
        variant: { promptOverrides: { [AGENT_ROLE]: 'unsafe' } },
        parent: { promptOverrides: {} },
        hashes: { variantHash: 'variant', parentHash: 'parent', evaluatorHash: 'evaluator', rubricHash: 'rubric', taskHash: 'task', codeHash: 'code' },
        gateResults: [{ gate: 'no-new-regressions', pass: false, status: 'fail' as const, detail: 'regression' }],
        verdict: 'reject',
        recordedAt: RUN_START + 1,
      },
    });
    const res = await autoDecideRunProposals(rootSql, { workspaceId: WS, harnessSlug: HS, sinceMs: RUN_START, now: NOW });
    expect(res).toEqual({ accepted: 0, rejected: 1 });
    const row = (await rootSql<{ status: string }[]>`SELECT status FROM harness_shared.gym_proposals WHERE id = 'unsafe-positive'`)[0]!;
    expect(row.status).toBe('rejected');
    const prompts = await rootSql<{ prompt_md: string }[]>`
      SELECT prompt_md FROM harness_shared.harness_prompt_overrides
       WHERE workspace_id = ${WS} AND harness_slug = ${HS} AND role = ${AGENT_ROLE}`;
    expect(prompts).toHaveLength(0);
  });
});
