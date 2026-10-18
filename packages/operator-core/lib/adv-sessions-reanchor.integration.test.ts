/**
 * adv-sessions-reanchor.integration.test.ts — the WI-5075 respawn re-anchor SQL
 * against REAL Postgres (the shared baseline-schema DB via the coord fixture).
 *
 * This seam MUST be guarded at the real schema: the original WI-5075 ship wrote
 * `RETURNING id, owner` against a table with no `owner` column, so the whole
 * UPDATE threw 42703 into its own catch and the re-anchor silently never
 * committed for ANY cohort — unit tests (mocked sql) were green the entire time.
 * The compaction watchdog's estimate stayed pinned to each dead predecessor's
 * transcript and only the streak breaker capped the successor-kill loop
 * (2026-07-18 su-57b6247d: 3 successor cuts in 16 min). Also pins the owner-keyed
 * sibling (interactive / legacy `psu --resume` sessions may have no adv id in env)
 * and its ambiguity guard — multiple active rows must not be selected by mutable
 * `started_at` ordering.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { restoreRawJsonbSerializer } from '@papercusp/db-org';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';
import {
  acquireAdvSessionResume,
  adoptStartingTerminalLaunch,
  classifyOwnerNativeSession,
  claimAdvSessionResume,
  finalizeAdvSessionResume,
  markAdvSessionEnded,
  readSuLaunchSpecByOwner,
  reanchorAdvSessionNativeId,
  reanchorAdvSessionNativeIdByOwner,
  recordSuLaunchSpec,
  reactivateAdvSessionByOwner,
  setAdvSessionPid,
  type AdvSessionExpectedBinding,
} from './adv-sessions';
import { activeWorkspaceId } from './workspace-registry';
import { resolveSessionRef } from './compaction-usage';
import { refreshControlAnchorAfterMutation, requestSessionIdentityActivation } from './agent-tools/coordination/control-anchor';
import { acknowledgeActivation, normalizeSessionActivation, prepareActivation } from './session-activation';
import { readActiveOperationWorkerClaimBinding } from './blueprint/operation-worker-binding';
import { compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { resolveIdentityArtifact } from './capability-envelope/identity-grants-port';
import { dispatchProjectedTool, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { controlAnchorKernelResolver, setStaleArtifactConverger } from './projected-tool-deps';
import { codexHomeForAdvSession, executeWake, type ExecuteWakeDeps } from './events/await/wake-executor';
import { makeDelivery } from '../test/_multi-session-testbed';
import { tagTurnForInjection } from './turn-provenance/turn-provenance';
import {
  carryIdentityReceiptForControlActivation,
  IDENTITY_HISTORY_LIMIT,
  parseSuLaunchSpecRecord,
} from './su-persona-render';

// Exercise the lifecycle SQL without scheduling real delayed cleanup of test rows.
vi.mock('./session-end-lease-release-hook', () => ({ scheduleSessionEndLeaseRelease: vi.fn() }));
vi.mock('./session-archive-hook', () => ({ scheduleArchiveForAdvSession: vi.fn() }));

let fx: BaselineCoordFixture;
let admin: postgres.Sql;
let isolatedDb: OrgTestDb | undefined;

const WS = 'reanchor-ws';
const OWNER = 'su-reanchor-owner';
const DEAD_ID = '3b0d2505-43a8-4062-b0d5-916f6c2953db';
const FRESH_ID = 'ee4dfd9b-a23c-47f1-abd8-bf0c5990f4f9';

async function seedAdv(opts: {
  coordOwnerId: string | null;
  sessionId?: string | null;
  startedAgoSec?: number;
  ended?: boolean;
}): Promise<number> {
  const rows = await admin<{ id: string | number }[]>`
    INSERT INTO harness_shared.adv_sessions
      (workspace_id, agent, mode, coord_owner_id, session_id, started_at, ended_at)
    VALUES (
      ${WS}, 'claude', 'console', ${opts.coordOwnerId}, ${opts.sessionId ?? null},
      now() - ${`${opts.startedAgoSec ?? 60} seconds`}::interval,
      ${opts.ended ? new Date() : null}
    )
    RETURNING id
  `;
  // postgres returns bigint columns as strings; callers require numeric ids.
  const id = Number(rows[0].id);
  expect(Number.isSafeInteger(id) && id > 0, 'seedAdv must return a positive numeric incarnation id').toBe(true);
  return id;
}

beforeAll(async () => {
  // Lifecycle tests truncate global tables. A migrated clone keeps this suite
  // independent of other files holding the shared baseline fixture mutex.
  isolatedDb = await createOrgTestDb();
  fx = await setupBaselineCoordFixture({ dsn: isolatedDb.adminDsn });
  admin = fx.admin;
});
async function cleanupReanchorFixture(
  currentAdmin?: postgres.Sql,
  currentFixture?: BaselineCoordFixture,
): Promise<void> {
  if (currentAdmin) await currentAdmin`TRUNCATE harness_shared.adv_sessions`.catch(() => {});
  if (currentFixture) await currentFixture.dispose();
}
afterAll(async () => {
  try {
    await cleanupReanchorFixture(admin, fx);
  } finally {
    await isolatedDb?.cleanup();
  }
});

describe('baseline fixture teardown', () => {
  it('is safe when beforeAll fails before returning fixture resources', async () => {
    await expect(cleanupReanchorFixture()).resolves.toBeUndefined();
  });
});
beforeEach(async () => {
  await admin`TRUNCATE harness_shared.adv_sessions`;
});

describe('exact native incarnation ownership (get-feedback D-006, real PG)', () => {
  it('rejects a deleted explicit row instead of borrowing another incarnation with the same native id', async () => {
    const deleted = await seedAdv({ coordOwnerId: OWNER, sessionId: DEAD_ID });
    await admin`DELETE FROM harness_shared.adv_sessions WHERE id = ${deleted}`;
    const replacement = await seedAdv({ coordOwnerId: OWNER, sessionId: DEAD_ID });
    await expect(classifyOwnerNativeSession({ ownerId: OWNER, sessionId: DEAD_ID, advSessionId: deleted }))
      .resolves.toEqual({ binding: 'foreign', boundSessionId: null, advSessionId: null });
    await expect(classifyOwnerNativeSession({ ownerId: OWNER, sessionId: DEAD_ID, advSessionId: replacement }))
      .resolves.toEqual({ binding: 'bound', boundSessionId: DEAD_ID, advSessionId: replacement });
  });

  it('rejects another owner\'s explicit row even when the caller has a matching native row', async () => {
    const own = await seedAdv({ coordOwnerId: OWNER, sessionId: DEAD_ID });
    const other = await seedAdv({ coordOwnerId: 'su-other-owner', sessionId: FRESH_ID });
    await expect(classifyOwnerNativeSession({ ownerId: OWNER, sessionId: DEAD_ID, advSessionId: other }))
      .resolves.toEqual({ binding: 'foreign', boundSessionId: null, advSessionId: null });
    await expect(classifyOwnerNativeSession({ ownerId: OWNER, sessionId: DEAD_ID, advSessionId: own }))
      .resolves.toEqual({ binding: 'bound', boundSessionId: DEAD_ID, advSessionId: own });
  });

  it('keeps both legitimate source incarnations and an existing pending first binding usable', async () => {
    const original = await seedAdv({ coordOwnerId: OWNER, sessionId: DEAD_ID });
    const continuation = await seedAdv({ coordOwnerId: OWNER, sessionId: FRESH_ID });
    const pending = await seedAdv({ coordOwnerId: OWNER });
    await expect(classifyOwnerNativeSession({ ownerId: OWNER, sessionId: DEAD_ID, advSessionId: original }))
      .resolves.toEqual({ binding: 'bound', boundSessionId: DEAD_ID, advSessionId: original });
    await expect(classifyOwnerNativeSession({ ownerId: OWNER, sessionId: FRESH_ID, advSessionId: continuation }))
      .resolves.toEqual({ binding: 'bound', boundSessionId: FRESH_ID, advSessionId: continuation });
    await expect(classifyOwnerNativeSession({ ownerId: OWNER, sessionId: FRESH_ID, advSessionId: pending }))
      .resolves.toEqual({ binding: 'unbound', boundSessionId: null, advSessionId: pending });
    await expect(classifyOwnerNativeSession({ ownerId: OWNER, sessionId: DEAD_ID }))
      .resolves.toEqual({ binding: 'bound', boundSessionId: DEAD_ID, advSessionId: original });
  });
});

describe('grant-bearing role receipt and activation (canonical PostgreSQL client)', () => {
  it.each(['exact', 'owner'] as const)(
    'retains the applied receipt across prepared resume revisions through the %s writer',
    async (target) => {
      const owner = `su-resume-receipt-${target}`;
      const id = await seedAdv({ coordOwnerId: owner });
      const makeRecord = (text: string) => {
        const artifact = compileAgentSpecification({
          source: {
            id: 'resume-receipt', workItem: { kind: 'feature' },
            spine: { edges: { DONE: { to: 'done' } } },
            grants: { requires: [], optional: [] },
          },
          prompt: { role: 'worker', text }, inputClosure: [],
        });
        return {
          v: 1, workspaceId: WS, harnessSlug: 'papercusp', role: 'worker',
          stack: ['domain:blueprint-operation-worker'],
          specificationRevision: artifact.specificationRevision,
          stateRevision: 'unchanged-control-state', specificationArtifact: artifact,
        };
      };
      const original = makeRecord('Original delivered instructions');
      const applied = {
        specificationRevision: original.specificationRevision, stateRevision: original.stateRevision,
      };
      const write = (record: unknown) => recordSuLaunchSpec(target === 'exact' ? id : null, owner, record);
      try {
        expect(await write(original)).toBe(true);
        const initial = await requestSessionIdentityActivation({
          ownerId: owner, workspaceId: WS, revision: applied, source: 'launch',
          attribution: { actorId: owner, principalId: owner, sessionId: owner },
        });
        const delivered = acknowledgeActivation(prepareActivation(initial.state.activation!, applied), applied);
        await admin`
          UPDATE harness_shared.session_briefs
             SET control_state = jsonb_set(control_state, '{activation}', ${admin.json(delivered)}, true)
           WHERE workspace_id = ${WS} AND owner_id = ${owner}
        `;
        // More pending refreshes than the retention limit must not evict the
        // one artifact the host actually acknowledged. A new launch is not ACK.
        for (let n = 0; n < IDENTITY_HISTORY_LIMIT + 2; n++) {
          const next = makeRecord(`Prepared successor ${n}`);
          expect(await write(next)).toBe(true);
          const desired = { specificationRevision: next.specificationRevision, stateRevision: next.stateRevision };
          const requested = await requestSessionIdentityActivation({
            ownerId: owner, workspaceId: WS, revision: desired, source: 'launch',
            attribution: { actorId: owner, principalId: owner, sessionId: owner },
          });
          const prepared = prepareActivation(requested.state.activation!, desired);
          await admin`
            UPDATE harness_shared.session_briefs
               SET control_state = jsonb_set(control_state, '{activation}', ${admin.json(prepared)}, true)
             WHERE workspace_id = ${WS} AND owner_id = ${owner}
          `;
          const [stored] = await admin<{ launch_spec: Record<string, unknown>; activation: unknown }[]>`
            SELECT a.launch_spec, b.control_state->'activation' AS activation
              FROM harness_shared.adv_sessions a
              JOIN harness_shared.session_briefs b ON b.workspace_id = a.workspace_id AND b.owner_id = a.coord_owner_id
             WHERE a.id = ${id}
          `;
          expect(stored.activation).toMatchObject({ status: 'prepared', desired, prepared: desired, applied });
          expect(stored.launch_spec).toMatchObject(next);
          const resolution = resolveIdentityArtifact(stored.launch_spec, applied);
          expect(resolution).toMatchObject({
            kind: 'governed', artifact: original.specificationArtifact, current: next.specificationArtifact,
          });
          expect(stored.launch_spec.identityHistory).toEqual(expect.any(Array));
          expect((stored.launch_spec.identityHistory as unknown[]).length).toBeLessThanOrEqual(IDENTITY_HISTORY_LIMIT);
          // Idempotent replay must neither duplicate nor discard the receipts.
          expect(await write(next)).toBe(true);
          expect(await readSuLaunchSpecByOwner(owner)).toEqual(stored.launch_spec);
        }
      } finally {
        await admin`DELETE FROM harness_shared.session_briefs WHERE workspace_id = ${WS} AND owner_id = ${owner}`;
      }
    },
  );

  it('adopts the launch row with its reserved owner and role metadata, without a duplicate', async () => {
    const id = await seedAdv({ coordOwnerId: OWNER });
    await admin`UPDATE harness_shared.adv_sessions SET display = 'terminal' WHERE id = ${id}`;
    expect(await adoptStartingTerminalLaunch({
      id, sessionId: FRESH_ID, role: 'worker', feature: 'WI-1', mode: 'console',
    })).toBe(true);
    const rows = await admin<{ id: string | number; coord_owner_id: string; session_id: string; role: string; feature: string }[]>`
      SELECT id, coord_owner_id, session_id, role, feature
        FROM harness_shared.adv_sessions WHERE coord_owner_id = ${OWNER}
    `;
    expect(rows).toHaveLength(1);
    expect({ ...rows[0], id: Number(rows[0].id) }).toMatchObject({ id, coord_owner_id: OWNER, session_id: FRESH_ID, role: 'worker', feature: 'WI-1' });
    expect(await adoptStartingTerminalLaunch({ id, sessionId: DEAD_ID, role: 'reviewer' })).toBe(false);
    const [unchanged] = await admin<{ session_id: string; role: string }[]>`
      SELECT session_id, role FROM harness_shared.adv_sessions WHERE id = ${id}
    `;
    expect(unchanged).toEqual({ session_id: FRESH_ID, role: 'worker' });
  });

  it('persists a readable artifact before recording the launch activation', async () => {
    const id = await seedAdv({ coordOwnerId: OWNER });
    const revision = { specificationRevision: 'a'.repeat(64), stateRevision: 'b'.repeat(64) };
    const artifact = { configuration: { grants: { requires: [], optional: [], suggestedProviders: {} } } };
    const launchSpec = {
      v: 1, workspaceId: WS, harnessSlug: 'papercusp', role: 'worker',
      stack: ['domain:blueprint-operation-worker'], ...revision,
      specificationArtifact: artifact,
    };
    expect(await recordSuLaunchSpec(id, OWNER, launchSpec)).toBe(true);
    const [stored] = await admin<{ value_kind: string; launch_spec: unknown }[]>`
      SELECT jsonb_typeof(launch_spec) AS value_kind, launch_spec
        FROM harness_shared.adv_sessions WHERE id = ${id}
    `;
    expect(stored?.value_kind).toBe('object');
    expect(stored?.launch_spec).toMatchObject(launchSpec);
    expect(await readSuLaunchSpecByOwner(OWNER)).toMatchObject(launchSpec);

    const anchor = await requestSessionIdentityActivation({
      ownerId: OWNER, workspaceId: WS, revision, source: 'launch',
      attribution: { actorId: OWNER, principalId: OWNER, sessionId: OWNER },
    });
    expect(anchor.state.activation).toMatchObject({ desired: revision, status: 'desired' });
    const [persisted] = await admin<{ activation: unknown }[]>`
      SELECT control_state->'activation' AS activation
        FROM harness_shared.session_briefs WHERE owner_id = ${OWNER}
    `;
    expect(persisted?.activation).toMatchObject({ desired: revision, status: 'desired' });
  });

  it.each(['current', 'history'] as const)(
    'copies only the exact applied receipt from a predecessor %s record',
    async (receiptSource) => {
      const owner = `su-cross-row-receipt-${receiptSource}-${randomUUID()}`;
      const predecessorId = await seedAdv({ coordOwnerId: owner, sessionId: DEAD_ID });
      const successorId = await seedAdv({ coordOwnerId: owner, sessionId: FRESH_ID, startedAgoSec: 0 });
      const makeArtifact = (text: string) => compileAgentSpecification({
        source: {
          id: 'cross-row-receipt', workItem: { kind: 'feature' },
          spine: { edges: { DONE: { to: 'done' } } },
          grants: { requires: [], optional: [] },
        },
        prompt: { role: 'worker', text }, inputClosure: [],
      });
      const makeReceipt = (
        artifact: ReturnType<typeof makeArtifact>,
        stateRevision: string,
      ) => ({
        stack: ['domain:blueprint-operation-worker'],
        specificationRevision: artifact.specificationRevision,
        stateRevision,
        specificationArtifact: artifact,
        recordedAt: '2026-10-01T00:00:00.000Z',
      });
      const appliedArtifact = makeArtifact('currently applied instructions');
      const olderArtifact = makeArtifact('older unrelated instructions');
      const predecessorCurrentArtifact = receiptSource === 'current'
        ? appliedArtifact
        : makeArtifact('predecessor current instructions');
      const successorArtifact = makeArtifact('successor instructions');
      const applied = {
        specificationRevision: appliedArtifact.specificationRevision,
        stateRevision: 'state-applied',
      };
      const predecessorRecord = {
        v: 1, workspaceId: WS, harnessSlug: 'papercusp', role: 'worker',
        stack: ['domain:blueprint-operation-worker'],
        specificationRevision: predecessorCurrentArtifact.specificationRevision,
        stateRevision: receiptSource === 'current' ? applied.stateRevision : 'state-predecessor-current',
        specificationArtifact: predecessorCurrentArtifact,
        identityHistory: [
          makeReceipt(appliedArtifact, 'state-other'),
          ...(receiptSource === 'history' ? [makeReceipt(appliedArtifact, applied.stateRevision)] : []),
          makeReceipt(olderArtifact, 'state-older'),
        ],
      };
      try {
        expect(await recordSuLaunchSpec(predecessorId, owner, predecessorRecord)).toBe(true);
        const requested = await requestSessionIdentityActivation({
          ownerId: owner, workspaceId: WS, revision: applied, source: 'launch',
          attribution: { actorId: owner, principalId: owner, sessionId: owner },
        });
        const delivered = acknowledgeActivation(
          prepareActivation(requested.state.activation!, applied), applied,
        );
        await admin`
          UPDATE harness_shared.session_briefs
             SET control_state = jsonb_set(control_state, '{activation}', ${admin.json(delivered)}, true)
           WHERE workspace_id = ${WS} AND owner_id = ${owner}
        `;

        const successorRecord = {
          v: 1, workspaceId: WS, harnessSlug: 'papercusp', role: 'worker',
          stack: ['domain:blueprint-operation-worker'],
          specificationRevision: successorArtifact.specificationRevision,
          stateRevision: 'state-successor',
          specificationArtifact: successorArtifact,
        };
        expect(await recordSuLaunchSpec(successorId, owner, successorRecord)).toBe(true);
        const [stored] = await admin<{ launch_spec: Record<string, unknown> }[]>`
          SELECT launch_spec FROM harness_shared.adv_sessions WHERE id = ${successorId}
        `;
        expect(stored.launch_spec).toMatchObject(successorRecord);
        const history = stored.launch_spec.identityHistory as Array<Record<string, unknown>>;
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({
          specificationRevision: applied.specificationRevision,
          stateRevision: applied.stateRevision,
          specificationArtifact: appliedArtifact,
        });
        expect(resolveIdentityArtifact(stored.launch_spec, applied)).toMatchObject({
          kind: 'governed', artifact: appliedArtifact, current: successorArtifact,
        });
      } finally {
        await admin`DELETE FROM harness_shared.session_briefs WHERE workspace_id = ${WS} AND owner_id = ${owner}`;
      }
    },
  );
});

describe('keyed resume applied receipt retention (real PG)', () => {
  it.each(['current', 'history', 'desired-only', 'foreign-owner', 'foreign-workspace'] as const)(
    'finalizes a retained row using only its exact applied same-owner receipt from %s',
    async (receiptSource) => {
      const owner = `su-finalize-receipt-${randomUUID()}`;
      const siblingOwner = receiptSource === 'foreign-owner' ? `su-other-${randomUUID()}` : owner;
      const retainedId = await seedAdv({ coordOwnerId: owner, sessionId: DEAD_ID, ended: true });
      const siblingId = await seedAdv({ coordOwnerId: siblingOwner, sessionId: FRESH_ID, startedAgoSec: 0 });
      const makeRecord = (text: string, stateRevision: string) => {
        const artifact = compileAgentSpecification({
          source: {
            id: 'finalize-receipt', workItem: { kind: 'feature' },
            spine: { edges: { DONE: { to: 'done' } } },
            grants: { requires: [], optional: [] },
          },
          prompt: { role: 'worker', text }, inputClosure: [],
        });
        return {
          v: 1, workspaceId: WS, harnessSlug: 'papercusp', role: 'worker',
          stack: ['domain:blueprint-operation-worker'],
          specificationRevision: artifact.specificationRevision,
          stateRevision, specificationArtifact: artifact,
        };
      };
      const oldRecord = makeRecord('retained old instructions', 'old-state');
      const appliedRecord = makeRecord('acknowledged newer instructions', 'applied-state');
      const applied = {
        specificationRevision: appliedRecord.specificationRevision,
        stateRevision: appliedRecord.stateRevision,
      };
      const key = `receipt-resume:${randomUUID()}`;
      try {
        expect(await recordSuLaunchSpec(retainedId, owner, oldRecord)).toBe(true);
        expect(await recordSuLaunchSpec(siblingId, siblingOwner, appliedRecord)).toBe(true);
        const requested = await requestSessionIdentityActivation({
          ownerId: owner, workspaceId: WS, revision: applied, source: 'launch',
          attribution: { actorId: owner, principalId: owner, sessionId: owner },
        });
        const activation = receiptSource === 'desired-only'
          ? requested.state.activation!
          : acknowledgeActivation(prepareActivation(requested.state.activation!, applied), applied);
        await admin`
          UPDATE harness_shared.session_briefs
             SET control_state = jsonb_set(control_state, '{activation}', ${admin.json(activation)}, true)
           WHERE workspace_id = ${WS} AND owner_id = ${owner}
        `;
        if (receiptSource === 'history') {
          expect(await recordSuLaunchSpec(
            siblingId, owner, makeRecord('newer prepared instructions', 'prepared-state'),
          )).toBe(true);
        }
        if (receiptSource === 'foreign-workspace') {
          await admin`UPDATE harness_shared.adv_sessions SET workspace_id = 'other-receipt-ws' WHERE id = ${siblingId}`;
        }
        // The acknowledged sibling ended before the retained native row returned.
        await markAdvSessionEnded(siblingId, 0, 'self');
        const readRetained = async () => (await admin<{
          launch_spec: Record<string, unknown>; ended: boolean; resume_claim_key: string | null;
        }[]>`
          SELECT launch_spec, ended_at IS NOT NULL AS ended, resume_claim_key
            FROM harness_shared.adv_sessions WHERE id = ${retainedId}
        `)[0];
        expect(resolveIdentityArtifact((await readRetained()).launch_spec, applied)).toEqual({
          kind: 'stale-artifact', reason: 'receipt-missing',
        });
        expect((await acquireAdvSessionResume(retainedId, key)).acquired).toBe(true);
        expect(await finalizeAdvSessionResume(retainedId, `${key}:wrong`)).toBe(false);
        expect((await readRetained()).launch_spec).toEqual(oldRecord);
        if (receiptSource === 'current') {
          // A receipt write failure must roll back liveness, reservation clearing,
          // and the keyed success verdict together.
          await admin.unsafe(`
            CREATE FUNCTION harness_shared.reject_resume_receipt() RETURNS trigger
              LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected receipt write rejection'; END $$;
            CREATE TRIGGER reject_resume_receipt BEFORE UPDATE OF launch_spec
              ON harness_shared.adv_sessions FOR EACH ROW
              EXECUTE FUNCTION harness_shared.reject_resume_receipt();
          `);
          try {
            await expect(finalizeAdvSessionResume(retainedId, key)).rejects.toThrow('injected receipt write rejection');
            expect(await readRetained()).toMatchObject({ ended: true, resume_claim_key: key });
            const [receipt] = await admin<{ count: number | string }[]>`
              SELECT count(*) AS count FROM harness_shared.agent_launch_idempotency
               WHERE workspace_id = ${WS} AND idempotency_key = ${`psu-resume-finalize:${retainedId}:${key}`}
            `;
            expect(Number(receipt.count)).toBe(0);
          } finally {
            await admin.unsafe('DROP TRIGGER reject_resume_receipt ON harness_shared.adv_sessions; DROP FUNCTION harness_shared.reject_resume_receipt()');
          }
        }
        expect(await finalizeAdvSessionResume(retainedId, key)).toBe(true);
        const stored = await readRetained();
        expect(stored).toMatchObject({ ended: false, resume_claim_key: null });
        expect(stored.launch_spec).toMatchObject(oldRecord);
        if (receiptSource === 'current' || receiptSource === 'history') {
          // This is the identity verdict used before tool readiness, not merely a JSON copy.
          expect(resolveIdentityArtifact(stored.launch_spec, applied)).toMatchObject({
            kind: 'governed', artifact: appliedRecord.specificationArtifact,
            current: oldRecord.specificationArtifact,
          });
          expect(stored.launch_spec.identityHistory).toHaveLength(1);
          expect(stored.launch_spec.identityHistory).toEqual([expect.objectContaining(applied)]);
        } else {
          expect(stored.launch_spec).toEqual(oldRecord);
          expect(resolveIdentityArtifact(stored.launch_spec, applied)).toEqual({
            kind: 'stale-artifact', reason: 'receipt-missing',
          });
        }
        // Lost-response replay returns the original verdict without modifying receipts.
        expect(await finalizeAdvSessionResume(retainedId, key)).toBe(true);
        expect(await readRetained()).toEqual(stored);
        if (receiptSource === 'current') {
          // Model a successful receipt committed before retention was deployed.
          // Replaying that key must repair identity without a second resurrection.
          await admin`UPDATE harness_shared.adv_sessions SET launch_spec = ${JSON.stringify(oldRecord)}::text::jsonb WHERE id = ${retainedId}`;
          expect(await finalizeAdvSessionResume(retainedId, key)).toBe(true);
          expect(resolveIdentityArtifact((await readRetained()).launch_spec, applied)).toMatchObject({
            kind: 'governed', artifact: appliedRecord.specificationArtifact,
          });
        }
      } finally {
        await admin`DELETE FROM harness_shared.session_briefs WHERE workspace_id = ${WS} AND owner_id IN (${owner}, ${siblingOwner})`;
        await admin`DELETE FROM harness_shared.agent_launch_idempotency WHERE workspace_id = ${WS} AND idempotency_key LIKE ${`psu-resume-finalize:${retainedId}:%`}`;
      }
    },
  );
  it('resumes a non-persona session without manufacturing launch or activation receipts', async () => {
    const owner = `su-resume-no-persona-${randomUUID()}`;
    const id = await seedAdv({ coordOwnerId: owner, ended: true });
    const key = randomUUID();
    try {
      expect((await acquireAdvSessionResume(id, key)).acquired).toBe(true);
      expect(await finalizeAdvSessionResume(id, key)).toBe(true);
      const [row] = await admin<{ launch_spec: unknown; ended: boolean }[]>`
        SELECT launch_spec, ended_at IS NOT NULL AS ended FROM harness_shared.adv_sessions WHERE id = ${id}
      `;
      expect(row).toEqual({ launch_spec: null, ended: false });
      expect(await admin`SELECT 1 FROM harness_shared.session_briefs WHERE workspace_id = ${WS} AND owner_id = ${owner}`).toHaveLength(0);
    } finally {
      await admin`DELETE FROM harness_shared.agent_launch_idempotency WHERE workspace_id = ${WS} AND idempotency_key = ${`psu-resume-finalize:${id}:${key}`}`;
    }
  });
});

describe('P040 retained Codex unkeyed wake persistence (real PG)', () => {
  function makeRecord(text: string, stateRevision: string, governed = true) {
    const specificationArtifact = compileAgentSpecification({
      source: {
        id: 'p040-retained-codex', workItem: { kind: 'feature' },
        spine: { edges: { DONE: { to: 'done' } } },
        ...(governed ? { grants: { requires: [], optional: [] } } : {}),
      },
      prompt: { role: 'worker', text }, inputClosure: [],
    });
    return {
      v: 1, workspaceId: WS, harnessSlug: 'papercusp', role: 'worker',
      stack: ['domain:blueprint-operation-worker'], stateRevision,
      specificationRevision: specificationArtifact.specificationRevision, specificationArtifact,
    };
  }

  async function retainedFixture(governed = true) {
    const owner = `su-p040-retained-${randomUUID()}`;
    const id = await seedAdv({ coordOwnerId: owner, sessionId: DEAD_ID, ended: true });
    await admin`
      UPDATE harness_shared.adv_sessions
         SET agent = 'codex', exit_code = 1, ended_by = 'signal', ended_signal = 'SIGTERM',
             shutdown_accepted_at = now()
       WHERE id = ${id}
    `;
    const original = makeRecord('P040 instructions acknowledged by the retained host', 'acknowledged', governed);
    const next = makeRecord('P040 prepared successor instructions', 'prepared', governed);
    const applied = { specificationRevision: original.specificationRevision, stateRevision: original.stateRevision };
    expect(await recordSuLaunchSpec(id, owner, original)).toBe(true);
    const requested = await requestSessionIdentityActivation({
      ownerId: owner, workspaceId: WS, revision: applied, source: 'launch',
      attribution: { actorId: owner, principalId: owner, sessionId: owner },
    });
    const activation = acknowledgeActivation(prepareActivation(requested.state.activation!, applied), applied);
    await admin`
      UPDATE harness_shared.session_briefs
         SET control_state = jsonb_set(control_state, '{activation}', ${admin.json(activation)}, true)
       WHERE workspace_id = ${WS} AND owner_id = ${owner}
    `;
    const read = async () => (await admin<Array<{
      agent: string; session_id: string; launch_spec: Record<string, unknown>;
      ended_at: unknown; exit_code: number | null; ended_by: string | null; ended_signal: string | null;
      shutdown_accepted_at: unknown; resume_claim_key: string | null; resume_claimed_at: unknown;
      started_at: unknown; control_state: unknown;
    }>>`
      SELECT a.agent, a.session_id, a.launch_spec, a.ended_at, a.exit_code, a.ended_by, a.ended_signal,
             a.shutdown_accepted_at, a.resume_claim_key, a.resume_claimed_at, a.started_at, b.control_state
        FROM harness_shared.adv_sessions a
        JOIN harness_shared.session_briefs b ON b.workspace_id = a.workspace_id AND b.owner_id = a.coord_owner_id
       WHERE a.id = ${id}
    `)[0];
    const ledger = () => admin`
      SELECT idempotency_key, summary FROM harness_shared.agent_launch_idempotency
       WHERE workspace_id = ${WS} AND idempotency_key LIKE ${`psu-resume%:${id}:%`}
       ORDER BY idempotency_key
    `;
    const cleanup = async () => {
      await admin`DELETE FROM harness_shared.session_identity_activation_events WHERE workspace_id = ${WS} AND owner_id = ${owner}`;
      await admin`DELETE FROM harness_shared.session_briefs WHERE workspace_id = ${WS} AND owner_id = ${owner}`;
      await admin`DELETE FROM harness_shared.adv_sessions WHERE id = ${id}`;
    };
    return { owner, id, original, next, applied, read, ledger, cleanup };
  }

  it.each(['current', 'history', 'missing-history'] as const)(
    'connects Channel 2 Codex wake, persisted %s receipt and ordinary tool dispatch', async (receiptSource) => {
      // Ordinary retained sessions have no grant-class enrollment. They still
      // require their acknowledged receipt: the missing-history control below
      // must fail before the same ordinary handler can execute.
      const f = await retainedFixture(false);
      const root = mkdtempSync(join(tmpdir(), 'p040-retained-wake-'));
      const previousHomes = process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
      const spawn = vi.fn<NonNullable<ExecuteWakeDeps['spawnDetached']>>(() => 4242);
      const account = vi.fn<NonNullable<ExecuteWakeDeps['accountHeadlessResumeTurn']>>(() => ({
        pidRecorded: Promise.resolve(), finish: () => {},
      }));
      const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'P040 ordinary sentinel' }] }));
      // Keep recovery observation local; this case never invents a receipt to
      // make the missing-history control pass.
      const converge = vi.fn(async () => false);
      setStaleArtifactConverger(converge);
      try {
        process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = root;
        const home = codexHomeForAdvSession(f.id);
        const sessions = join(home, 'sessions', '2026', '10', '18');
        mkdirSync(sessions, { recursive: true });
        writeFileSync(join(sessions, `rollout-2026-10-18T00-00-00-${DEAD_ID}.jsonl`), JSON.stringify({
          type: 'session_meta', payload: { id: DEAD_ID, cwd: root },
        }) + '\n');
        await admin`UPDATE harness_shared.adv_sessions SET cwd = ${root} WHERE id = ${f.id}`;
        if (receiptSource !== 'current') expect(await recordSuLaunchSpec(f.id, f.owner, f.next)).toBe(true);
        if (receiptSource === 'missing-history') {
          await admin`UPDATE harness_shared.adv_sessions SET launch_spec = launch_spec - 'identityHistory' WHERE id = ${f.id}`;
        }
        const before = await f.read();
        const claim = vi.fn(claimAdvSessionResume);
        const deps: ExecuteWakeDeps = {
          // Session lookup, owner election, claim, receipt persistence and the
          // dispatch authority reader stay real against the owned test DB.
          claimResume: claim,
          resolveWakeModeFn: async () => 'auto', getSessionLifecycle: async () => null,
          presence: async () => null, alive: () => false, findPty: () => null,
          findPsuHost: async () => null, codexThreadWriterHolder: () => null,
          ensureCodexHomeForWake: async () => ({ ok: true, repaired: false }),
          prepareDirectCodexWakeAuth: () => ({ checked: true, ready: true, reason: 'fixture-auth' }),
          ensureInboxWakeArmedForActiveSession: async () => false,
          getLoopStatusFn: async () => null,
          getLoopCarryNoteWithMetaFn: async () => ({ note: null, updatedAtMs: null }),
          tagTurn: (args) => tagTurnForInjection({ ...args, dir: join(root, 'provenance') }),
          spawnDetached: spawn, accountHeadlessResumeTurn: account,
        };
        const delivery = makeDelivery({
          workspaceId: WS, subscriberId: f.owner, eventKey: `p040:receipt:${f.owner}`,
          wakeHandle: { kind: 'adv-session', advSessionId: f.id, agent: 'codex',
            sessionId: DEAD_ID, ompThreadId: null, cwd: root, pid: null },
        });
        expect(await executeWake(delivery, deps)).toEqual({ kind: 'delivered', channel: 'resume-headless' });
        expect(claim).toHaveBeenCalledExactlyOnceWith(f.id, null, undefined, f.owner);
        expect(spawn).toHaveBeenCalledOnce();
        const [, argv, { env }] = spawn.mock.calls[0];
        expect(argv).toEqual(expect.arrayContaining(['resume', DEAD_ID]));
        expect(env).toMatchObject({ PAPERCUSP_SID: f.owner, PAPERCUSP_WORKSPACE: WS, CODEX_HOME: home });
        expect(account).toHaveBeenCalledOnce();
        const resumed = account.mock.calls[0][0];
        expect(resumed).toMatchObject({ advSessionId: f.id, coordOwnerId: f.owner, agent: 'codex', resumeId: DEAD_ID });
        expect(await classifyOwnerNativeSession({
          ownerId: env.PAPERCUSP_SID, sessionId: resumed.resumeId!, advSessionId: resumed.advSessionId, workspaceId: WS,
        })).toMatchObject({ binding: 'bound', advSessionId: f.id });
        const result = await dispatchProjectedTool({
          pluginName: 'fixture', description: 'P040 ordinary handler', inputSchema: { type: 'object' },
          capabilities: [], expose: { mcp: { name: 'fixture:p040-ordinary' } }, fn: handler,
        }, 'fixture:p040-ordinary', {}, {
          workspaceId: env.PAPERCUSP_WORKSPACE, uiClientId: env.PAPERCUSP_SID,
          advSessionId: resumed.advSessionId, isSuperuser: true,
        } as UnifiedToolContext, { kernelEnforcement: controlAnchorKernelResolver });
        if (receiptSource === 'missing-history') {
          expect(result.ok).toBe(false);
          expect(result.error?.message).toContain('stale-artifact');
          expect(handler).not.toHaveBeenCalled();
        } else {
          expect(result.ok).toBe(true);
          expect(handler).toHaveBeenCalledOnce();
          expect(JSON.stringify(result)).toContain('P040 ordinary sentinel');
          expect(converge).not.toHaveBeenCalled();
        }
        const after = await f.read();
        expect(after.ended_at).toBeNull();
        expect(after.launch_spec).toEqual(before.launch_spec);
        expect(after.control_state).toEqual(before.control_state);
        expect(await f.ledger()).toHaveLength(0);
      } finally {
        setStaleArtifactConverger(null);
        if (previousHomes === undefined) delete process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
        else process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = previousHomes;
        rmSync(root, { recursive: true, force: true });
        await f.cleanup();
      }
    },
  );

  it.each(['current', 'history'] as const)(
    'preserves the genuine %s receipt through the actual unkeyed claim without a keyed-finalize substitute',
    async (receiptSource) => {
      const f = await retainedFixture();
      try {
        if (receiptSource === 'history') expect(await recordSuLaunchSpec(f.id, f.owner, f.next)).toBe(true);
        const before = await f.read();
        expect(await classifyOwnerNativeSession({ ownerId: f.owner, sessionId: DEAD_ID, advSessionId: f.id, workspaceId: WS }))
          .toMatchObject({ binding: 'bound', advSessionId: f.id });
        expect(await claimAdvSessionResume(f.id, null, undefined, f.owner)).toBe(true);
        const stored = await f.read();
        expect(stored).toMatchObject({
          agent: 'codex', session_id: DEAD_ID, ended_at: null, exit_code: null,
          ended_by: null, ended_signal: null, shutdown_accepted_at: null,
          resume_claim_key: null, resume_claimed_at: null,
        });
        expect(stored.launch_spec).toEqual(before.launch_spec);
        expect(stored.control_state).toEqual(before.control_state);
        expect(resolveIdentityArtifact(stored.launch_spec, f.applied)).toMatchObject({
          kind: 'governed', artifact: f.original.specificationArtifact,
          current: (receiptSource === 'history' ? f.next : f.original).specificationArtifact,
        });
        // A second unkeyed delivery loses the liveness election. It must not
        // duplicate a receipt or masquerade as the keyed replay protocol.
        expect(await claimAdvSessionResume(f.id, null, undefined, f.owner)).toBe(false);
        expect(await f.read()).toEqual(stored);
        expect(await f.ledger()).toHaveLength(0);
      } finally { await f.cleanup(); }
    },
  );

  it.each(['missing', 'malformed', 'wrong-state'] as const)(
    'does not manufacture authority from a %s historical receipt during an unkeyed wake', async (shape) => {
      const f = await retainedFixture();
      try {
        expect(await recordSuLaunchSpec(f.id, f.owner, f.next)).toBe(true);
        const launch = {
          ...f.next,
          identityHistory: shape === 'missing' ? [] : shape === 'malformed' ? { receipt: f.original }
            : [{ ...f.original, stateRevision: 'never-acknowledged' }],
        };
        // Deliberately corrupt only this owned fixture, after the genuine
        // writer has run, to distinguish absent provenance from liveness.
        await admin`UPDATE harness_shared.adv_sessions SET launch_spec = ${admin.json(launch)} WHERE id = ${f.id}`;
        const before = await f.read();
        expect(await claimAdvSessionResume(f.id, null, undefined, f.owner)).toBe(true);
        const stored = await f.read();
        expect(stored.launch_spec).toEqual(before.launch_spec);
        expect(stored.control_state).toEqual(before.control_state);
        expect(resolveIdentityArtifact(stored.launch_spec, f.applied)).toEqual({
          kind: 'stale-artifact', reason: 'receipt-missing',
        });
        expect(await f.ledger()).toHaveLength(0);
      } finally { await f.cleanup(); }
    },
  );

  it('rolls back the entire unkeyed liveness transition on a real persistence fault', async () => {
    const f = await retainedFixture();
    try {
      expect(await recordSuLaunchSpec(f.id, f.owner, f.next)).toBe(true);
      const before = await f.read();
      const beforeLedger = await f.ledger();
      await admin.unsafe(`
        CREATE FUNCTION harness_shared.reject_p040_unkeyed() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'P040 unkeyed persistence rejection'; END $$;
        CREATE TRIGGER reject_p040_unkeyed BEFORE UPDATE ON harness_shared.adv_sessions
          FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_p040_unkeyed();
      `);
      try {
        await expect(claimAdvSessionResume(f.id, null, undefined, f.owner))
          .rejects.toThrow('P040 unkeyed persistence rejection');
        expect(await f.read()).toEqual(before);
        expect(await f.ledger()).toEqual(beforeLedger);
      } finally {
        await admin.unsafe('DROP TRIGGER reject_p040_unkeyed ON harness_shared.adv_sessions; DROP FUNCTION harness_shared.reject_p040_unkeyed()');
      }
    } finally { await f.cleanup(); }
  });

  it('leaves receipt, control, liveness and replay state unchanged when the receipt writer itself fails', async () => {
    const f = await retainedFixture();
    try {
      const before = await f.read();
      const beforeLedger = await f.ledger();
      await admin.unsafe(`
        CREATE FUNCTION harness_shared.reject_p040_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'P040 receipt write rejection'; END $$;
        CREATE TRIGGER reject_p040_receipt BEFORE UPDATE OF launch_spec ON harness_shared.adv_sessions
          FOR EACH ROW WHEN (OLD.id = ${f.id}) EXECUTE FUNCTION harness_shared.reject_p040_receipt();
      `);
      try {
        // This is a different statement boundary from claimAdvSessionResume:
        // the real launch_spec writer catches the transaction's failure.
        expect(await recordSuLaunchSpec(f.id, f.owner, f.next)).toBe(false);
        expect(await f.read()).toEqual(before);
        expect(await f.ledger()).toEqual(beforeLedger);
        expect(resolveIdentityArtifact(before.launch_spec, f.applied)).toMatchObject({
          kind: 'governed', artifact: f.original.specificationArtifact,
        });
      } finally {
        await admin.unsafe('DROP TRIGGER reject_p040_receipt ON harness_shared.adv_sessions; DROP FUNCTION harness_shared.reject_p040_receipt()');
      }
    } finally { await f.cleanup(); }
  });

  it.each(['claim-first', 'writer-first'] as const)(
    'retains one acknowledged receipt while the unkeyed wake and render writer overlap (%s)', async (order) => {
      const f = await retainedFixture();
      let releaseRow!: () => void;
      const mayCommit = new Promise<void>((resolve) => { releaseRow = resolve; });
      let signalLocked!: () => void;
      const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
      let blocker: Promise<unknown> | undefined;
      let operations: Array<Promise<unknown>> = [];
      try {
        const before = await f.read();
        blocker = admin.begin(async (tx) => {
          await tx`SELECT id FROM harness_shared.adv_sessions WHERE id = ${f.id} FOR UPDATE`;
          signalLocked();
          await mayCommit;
        });
        await Promise.race([locked, blocker.then(() => { throw new Error('P040 row lock ended before release'); })]);
        operations = order === 'claim-first'
          ? [claimAdvSessionResume(f.id, null, undefined, f.owner), recordSuLaunchSpec(f.id, f.owner, f.next)]
          : [recordSuLaunchSpec(f.id, f.owner, f.next), claimAdvSessionResume(f.id, null, undefined, f.owner)];
        // Observe both operations waiting on a real database lock before
        // releasing it, rather than assuming Promise creation caused overlap.
        for (const operation of operations) void operation.catch(() => {});
        await expect.poll(async () => {
          const [row] = await admin<Array<{ waiting: number | string }>>`
            SELECT count(*) AS waiting FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'
               AND query LIKE '%harness_shared.adv_sessions%'
          `;
          return Number(row.waiting);
        }, { timeout: 3_000 }).toBeGreaterThanOrEqual(2);
        releaseRow();
        expect(await Promise.all(operations)).toEqual([true, true]);
        await blocker;
        const stored = await f.read();
        expect(stored.ended_at).toBeNull();
        expect(stored.control_state).toEqual(before.control_state);
        expect(stored.launch_spec).toMatchObject(f.next);
        expect(stored.launch_spec.identityHistory).toEqual([expect.objectContaining(f.applied)]);
        expect(resolveIdentityArtifact(stored.launch_spec, f.applied)).toMatchObject({
          kind: 'governed', artifact: f.original.specificationArtifact, current: f.next.specificationArtifact,
        });
        expect(await recordSuLaunchSpec(f.id, f.owner, f.next)).toBe(true);
        expect(await f.read()).toEqual(stored);
        expect(await f.ledger()).toHaveLength(0);
      } finally {
        releaseRow();
        await Promise.allSettled([blocker, ...operations].filter((p): p is Promise<unknown> => Boolean(p)));
        await f.cleanup();
      }
    },
  );
});

describe('control activation receipt concurrency', () => {
  it('targets the live row over a newer ended sibling and waits for a concurrent rewrite', async () => {
    const owner = `su-control-receipt-race-${randomUUID()}`;
    const appliedArtifact = compileAgentSpecification({
      source: {
        id: 'control-receipt-race', workItem: { kind: 'feature' },
        spine: { edges: { DONE: { to: 'done' } } },
        grants: { requires: [], optional: [] },
      },
      prompt: { role: 'worker', text: 'applied identity for the receipt race' }, inputClosure: [],
    });
    const applied = { specificationRevision: appliedArtifact.specificationRevision, stateRevision: 'state-applied' };
    const initialRecord = {
      v: 1, agent: 'su-control-receipt-race', workspaceId: WS, harnessSlug: 'papercusp', role: 'worker',
      profile: 'engineer', contextSize: 'trimmed', personaTier: 'full',
      stack: ['domain:blueprint-operation-worker'],
      ...applied,
      specificationArtifact: appliedArtifact,
    };
    let advSessionId: number | null = null;
    let releaseWriter: (() => void) | undefined;
    let writer: Promise<unknown> | undefined;
    let refresh: Promise<Awaited<ReturnType<typeof refreshControlAnchorAfterMutation>>> | undefined;
    let selectionReturnedBeforeWriterCommit: boolean | undefined;
    let carriedReceipt: Record<string, unknown> | undefined;
    let receiptDiagnostic: unknown;
    let receiptReadSnapshot: unknown;
    let receiptUpdateRows: number | null = null;
    let newerEndedId: number | null = null;

    try {
      // Match getOrgPg's canonical serializer: a raw postgres client otherwise
      // JSON-encodes a bound JSON.stringify string again before ::jsonb.
      restoreRawJsonbSerializer(admin);
      advSessionId = await seedAdv({ coordOwnerId: owner, sessionId: FRESH_ID, startedAgoSec: 0 });
      newerEndedId = await seedAdv({ coordOwnerId: owner, sessionId: DEAD_ID, startedAgoSec: 0, ended: true });
      const activation = {
        schemaVersion: 1,
        attribution: { actorId: owner, principalId: owner, sessionId: owner },
        desired: applied,
        prepared: null,
        applied,
        status: 'applied',
      };
      await admin`
        INSERT INTO harness_shared.session_briefs
          (owner_id, workspace_id, control_generation, control_delivered_generation, control_state)
        VALUES (${owner}, ${WS}, 1, 1, ${JSON.stringify({ activation })}::text::jsonb)
      `;
      expect(await recordSuLaunchSpec(advSessionId, owner, initialRecord)).toBe(true);
      const [storedInitial] = await admin<Array<{ launch_spec: unknown }>>`
        SELECT launch_spec FROM harness_shared.adv_sessions WHERE id = ${advSessionId}
      `;
      const parsedInitial = parseSuLaunchSpecRecord(storedInitial?.launch_spec);
      expect(parsedInitial).not.toBeNull();
      expect(carryIdentityReceiptForControlActivation(parsedInitial, {
        specificationRevision: applied.specificationRevision, stateRevision: 'state-probe',
      })).not.toBeNull();

      let signalLocked!: () => void;
      const rowLocked = new Promise<void>((resolve) => { signalLocked = resolve; });
      let allowWriterCommit!: () => void;
      const writerMayCommit = new Promise<void>((resolve) => { allowWriterCommit = resolve; });
      releaseWriter = allowWriterCommit;
      writer = admin.begin(async (tx) => {
        await tx`
          SELECT id FROM harness_shared.adv_sessions WHERE id = ${advSessionId} FOR UPDATE
        `;
        signalLocked();
        await writerMayCommit;
        await tx`
          UPDATE harness_shared.adv_sessions
             SET launch_spec = ${JSON.stringify({ ...initialRecord, profile: 'successor-render' })}::text::jsonb
           WHERE id = ${advSessionId}
        `;
      });
      await rowLocked;

      let signalReceiptReadStarted!: () => void;
      const receiptReadStarted = new Promise<void>((resolve) => { signalReceiptReadStarted = resolve; });
      let allowReceiptRead!: () => void;
      const receiptReadAllowed = new Promise<void>((resolve) => { allowReceiptRead = resolve; });
      let signalReceiptReadReturned!: () => void;
      const receiptReadReturned = new Promise<void>((resolve) => { signalReceiptReadReturned = resolve; });
      refresh = admin.begin(async (tx) => {
        const observedTx = async (strings: TemplateStringsArray, ...values: postgres.ParameterOrFragment<never>[]) => {
          const statement = strings.join(' ');
          const isReceiptRead = statement.includes("SELECT a.id, to_jsonb(a)->'launch_spec' AS launch_spec");
          if (isReceiptRead) {
            signalReceiptReadStarted();
            await receiptReadAllowed;
          }
          const rows = await tx<Array<{ id: number | string; launch_spec: Record<string, unknown> }>>(strings, ...values);
          if (isReceiptRead) {
            const [row] = rows;
            receiptReadSnapshot = {
              id: row?.id,
              specificationRevision: row?.launch_spec?.specificationRevision,
              stateRevision: row?.launch_spec?.stateRevision,
              artifactRevision: (row?.launch_spec?.specificationArtifact as Record<string, unknown> | undefined)?.specificationRevision,
            };
            signalReceiptReadReturned();
          }
          if (statement.includes('UPDATE harness_shared.adv_sessions') && statement.includes('SET launch_spec')) {
            receiptUpdateRows = Array.isArray(rows) ? rows.length : null;
          }
          return rows;
        };
        return refreshControlAnchorAfterMutation({
          ownerId: owner,
          workspaceId: WS,
          origin: 'system',
          actorId: owner,
          source: 'mode:set',
          sql: observedTx as unknown as postgres.Sql,
        });
      });
      await receiptReadStarted;
      allowReceiptRead();
      selectionReturnedBeforeWriterCommit = await Promise.race([
        receiptReadReturned.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);

      // The writer still holds the row lock here. The receipt read must remain
      // pending on that lock until the rewrite commits; the old unlocked read
      // returned immediately and only waited later at its compare-and-set UPDATE.
      allowWriterCommit();
      if (!writer || !refresh) throw new Error('concurrency transactions did not start');
      const [_, refreshed] = await Promise.all([writer, refresh]);
      if (!refreshed) throw new Error('control-anchor refresh returned no anchor');
      const [stored] = await admin<Array<{ launch_spec: Record<string, unknown> }>>`
        SELECT launch_spec FROM harness_shared.adv_sessions WHERE id = ${advSessionId}
      `;
      const [activationEvent] = await admin<Array<{ adv_session_id: string | number | null }>>`
        SELECT adv_session_id
          FROM harness_shared.session_identity_activation_events
         WHERE workspace_id = ${WS} AND owner_id = ${owner}
           AND phase = 'desired' AND source = 'control'
         ORDER BY id DESC
         LIMIT 1
      `;
      const desired = refreshed.state.activation?.desired;
      const history = Array.isArray(stored?.launch_spec.identityHistory)
        ? stored.launch_spec.identityHistory as Array<Record<string, unknown>>
        : [];
      const parsedAfter = parseSuLaunchSpecRecord(stored?.launch_spec);
      const pureCarry = carryIdentityReceiptForControlActivation(parsedAfter, desired);
      carriedReceipt = history.find((entry) =>
        entry.specificationRevision === desired?.specificationRevision &&
        entry.stateRevision === desired?.stateRevision);
      receiptDiagnostic = {
        activation: refreshed.state.activation ?? null,
        activationEventAdvSessionId: activationEvent?.adv_session_id ?? null,
        receiptReadSnapshot,
        receiptUpdateRows,
        launchSpec: {
          v: stored?.launch_spec.v,
          agent: stored?.launch_spec.agent,
          contextSize: stored?.launch_spec.contextSize,
          specificationRevision: stored?.launch_spec.specificationRevision,
          stateRevision: stored?.launch_spec.stateRevision,
          artifactRevision: (stored?.launch_spec.specificationArtifact as Record<string, unknown> | undefined)?.specificationRevision,
          profile: stored?.launch_spec.profile,
        },
        parsed: parsedAfter !== null,
        pureCarryCount: pureCarry?.length ?? null,
        historyPairs: history.map((entry) => ({
          specificationRevision: entry.specificationRevision,
          stateRevision: entry.stateRevision,
        })),
      };
    } finally {
      releaseWriter?.();
      await Promise.allSettled([writer, refresh].filter((promise): promise is Promise<unknown> => Boolean(promise)));
      if (advSessionId !== null) {
        await admin`DELETE FROM harness_shared.session_identity_activation_events WHERE workspace_id = ${WS} AND owner_id = ${owner}`;
        await admin`DELETE FROM harness_shared.session_briefs WHERE workspace_id = ${WS} AND owner_id = ${owner}`;
        await admin`DELETE FROM harness_shared.adv_sessions WHERE workspace_id = ${WS} AND id IN (${advSessionId}, ${newerEndedId})`;
      }
    }

    expect(selectionReturnedBeforeWriterCommit).toBe(false);
    expect(newerEndedId).toBeGreaterThan(advSessionId ?? 0);
    expect(receiptDiagnostic && (receiptDiagnostic as { activationEventAdvSessionId?: string | number | null }).activationEventAdvSessionId)
      .toBe(String(advSessionId));
    if (!carriedReceipt) throw new Error(`control receipt missing after locked carry: ${JSON.stringify(receiptDiagnostic)}`);
    expect(carriedReceipt).toMatchObject({
      specificationRevision: applied.specificationRevision,
      specificationArtifact: appliedArtifact,
    });
    expect(carriedReceipt?.stateRevision).not.toBe(applied.stateRevision);
  });
});

describe('active operation worker claim receipt', () => {
  it('requires the applied active role receipt, then rejects an ended session', async () => {
    const owner = 'role-claim-reader-integration';
    const revision = { specificationRevision: 'a'.repeat(64), stateRevision: 'b'.repeat(64) };
    const acceptedOperation = {
      kind: 'blueprint-operation-worker', workItemId: 'WI-claim-reader', operationId: 'extract',
      specificationRevision: 'c'.repeat(64),
      pin: { kind: 'blueprint-operation', harnessSlug: 'papercusp', operationId: 'extract',
        specificationRevision: 'c'.repeat(64), operationVersion: '1.0.0', input: {} },
      identity: { ref: 'blueprint-operation-worker', revision: '0.1.0', contentHash: 'd'.repeat(64) },
      requiredTools: ['work_items:get'],
    };
    expect(await readActiveOperationWorkerClaimBinding(WS, owner)).toEqual({ status: 'none' });
    const id = await seedAdv({ coordOwnerId: owner });
    try {
      await admin`UPDATE harness_shared.adv_sessions SET role = 'worker' WHERE id = ${id}`;
      expect(await recordSuLaunchSpec(id, owner, {
        v: 1, workspaceId: WS, harnessSlug: 'papercusp', role: 'worker',
        ...revision, specificationArtifact: { configuration: { grants: { requires: ['work_items:get'] } } },
        acceptedOperation,
      })).toBe(true);
      await requestSessionIdentityActivation({
        ownerId: owner, workspaceId: WS, revision, source: 'launch',
        attribution: { actorId: owner, principalId: owner, sessionId: owner },
      });
      expect(await readActiveOperationWorkerClaimBinding(WS, owner)).toEqual({
        status: 'unavailable', reason: 'active operation worker identity is not applied',
      });

      const [brief] = await admin<{ activation: unknown }[]>`
        SELECT control_state->'activation' AS activation
          FROM harness_shared.session_briefs WHERE workspace_id = ${WS} AND owner_id = ${owner}
      `;
      const desired = normalizeSessionActivation(brief.activation)!;
      const applied = acknowledgeActivation(prepareActivation(desired, revision), revision);
      await admin`
        UPDATE harness_shared.session_briefs
           SET control_state = jsonb_set(control_state, '{activation}', ${admin.json(applied)}, true)
         WHERE workspace_id = ${WS} AND owner_id = ${owner}
      `;
      const claimBinding = await readActiveOperationWorkerClaimBinding(WS, owner);
      if (claimBinding.status !== 'bound') throw new Error(JSON.stringify(claimBinding));
      expect(claimBinding).toMatchObject({
        status: 'bound', receipt: {
          sessionId: Number(id), workspaceId: WS, ownerId: owner,
          specificationRevision: revision.specificationRevision,
          stateRevision: revision.stateRevision,
          acceptedOperation,
        }, binding: {
          workItemId: acceptedOperation.workItemId,
          harnessSlug: 'papercusp',
          operationId: acceptedOperation.operationId,
          specificationRevision: acceptedOperation.specificationRevision,
          identity: acceptedOperation.identity,
          requiredTools: ['work_items:get'],
        },
      });
      await admin`UPDATE harness_shared.adv_sessions SET ended_at = now(), ended_by = 'self' WHERE id = ${id}`;
      expect(await readActiveOperationWorkerClaimBinding(WS, owner)).toEqual({ status: 'none' });
    } finally {
      await admin`DELETE FROM harness_shared.session_briefs WHERE workspace_id = ${WS} AND owner_id = ${owner}`;
    }
  });
});

describe('successor lifecycle compare-and-swap (EI-22446987530949437, real PG)', () => {
  it('does not resurrect a terminal predecessor when owner activity belongs to an active successor', async () => {
    const predecessorId = await seedAdv({ coordOwnerId: OWNER, sessionId: DEAD_ID, ended: true });
    await admin`UPDATE harness_shared.adv_sessions SET ended_by = 'reconciler' WHERE id = ${predecessorId}`;
    const successorId = await seedAdv({ coordOwnerId: OWNER, sessionId: FRESH_ID, startedAgoSec: 0 });
    const before = await admin<{ id: string | number; ended_at: Date | null; ended_by: string | null; started_at: Date }[]>`
      SELECT id, ended_at, ended_by, started_at FROM harness_shared.adv_sessions ORDER BY id
    `;
    expect(await reactivateAdvSessionByOwner(OWNER)).toBe(false);
    const after = await admin<{ id: string | number; ended_at: Date | null; ended_by: string | null; started_at: Date }[]>`
      SELECT id, ended_at, ended_by, started_at FROM harness_shared.adv_sessions ORDER BY id
    `;
    expect(after).toEqual(before);
    expect(after.find((row) => Number(row.id) === successorId)?.ended_at).toBeNull();
  });

  it('still reactivates the sole terminal owner row when no successor is active', async () => {
    const id = await seedAdv({ coordOwnerId: OWNER, sessionId: DEAD_ID, ended: true });
    await admin`UPDATE harness_shared.adv_sessions SET ended_by = 'signal' WHERE id = ${id}`;
    expect(await reactivateAdvSessionByOwner(OWNER)).toBe(true);
    const [row] = await admin<{ ended_at: Date | null; ended_by: string | null }[]>`
      SELECT ended_at, ended_by FROM harness_shared.adv_sessions WHERE id = ${id}
    `;
    expect(row).toEqual({ ended_at: null, ended_by: null });
  });

  async function predecessor(): Promise<{ id: number; binding: AdvSessionExpectedBinding }> {
    const id = await seedAdv({ coordOwnerId: OWNER, sessionId: DEAD_ID });
    await admin`UPDATE harness_shared.adv_sessions SET started_at = '2026-09-05 18:00:00.123456+00'::timestamptz WHERE id = ${id}`;
    const [row] = await admin<{ started_at: string }[]>`
      SELECT started_at::text AS started_at FROM harness_shared.adv_sessions WHERE id = ${id}
    `;
    return { id, binding: { coordOwnerId: OWNER, sessionId: DEAD_ID, startedAt: row.started_at } };
  }

  it('ends only the exact observed binding, preserving full timestamp precision and provenance', async () => {
    const { id, binding } = await predecessor();
    expect(binding.startedAt).toContain('.123456');
    await expect(markAdvSessionEnded(id, null, 'reconciler', { expectedBinding: binding, throwOnError: true })).resolves.toBe(true);
    const [row] = await admin`SELECT ended_at, ended_by, exit_code FROM harness_shared.adv_sessions WHERE id = ${id}`;
    expect(row.ended_at).not.toBeNull();
    expect(row.ended_by).toBe('reconciler');
    expect(row.exit_code).toBeNull();
  });

  it.each(['owner', 'native', 'started'])('refuses when %s changes after the predecessor was observed', async (field) => {
    const { id, binding } = await predecessor();
    if (field === 'owner') await admin`UPDATE harness_shared.adv_sessions SET coord_owner_id = 'su-other' WHERE id = ${id}`;
    if (field === 'native') await admin`UPDATE harness_shared.adv_sessions SET session_id = ${FRESH_ID} WHERE id = ${id}`;
    if (field === 'started') await admin`UPDATE harness_shared.adv_sessions SET started_at = started_at + interval '1 microsecond' WHERE id = ${id}`;
    await expect(markAdvSessionEnded(id, null, 'reconciler', { expectedBinding: binding, throwOnError: true })).resolves.toBe(false);
    const [row] = await admin`SELECT ended_at, ended_by FROM harness_shared.adv_sessions WHERE id = ${id}`;
    expect(row.ended_at).toBeNull();
    expect(row.ended_by).toBeNull();
  });

  it('preserves an existing terminal observation on a retry', async () => {
    const { id, binding } = await predecessor();
    await markAdvSessionEnded(id, 0, 'self', { throwOnError: true });
    const [before] = await admin`SELECT ended_at, ended_by, exit_code FROM harness_shared.adv_sessions WHERE id = ${id}`;
    await expect(markAdvSessionEnded(id, null, 'reconciler', { expectedBinding: binding, throwOnError: true })).resolves.toBe(false);
    const [after] = await admin`SELECT ended_at, ended_by, exit_code FROM harness_shared.adv_sessions WHERE id = ${id}`;
    expect(after).toEqual(before);
  });

  // WI-10002854 split-brain: an end OBSERVATION vs a successor incarnation.
  it('refuses to end a row a successor reactivated AFTER the exit was observed (WI-10002854)', async () => {
    const { id } = await predecessor();
    // The killed predecessor's exit was observed a minute ago; a headless wake resume then
    // reactivated the row (started_at = now). The late/replayed report must not end it —
    // that is what let the next resume claim win against a still-running twin.
    const observedAt = new Date(Date.now() - 60_000);
    await admin`UPDATE harness_shared.adv_sessions SET started_at = now() WHERE id = ${id}`;
    await expect(markAdvSessionEnded(id, 0, 'self', { observedAt, throwOnError: true })).resolves.toBe(false);
    const [row] = await admin`SELECT ended_at, ended_by FROM harness_shared.adv_sessions WHERE id = ${id}`;
    expect(row.ended_at).toBeNull();
    expect(row.ended_by).toBeNull();
  });

  it('still ends the row when the observation follows the current incarnation start (WI-10002854)', async () => {
    const { id } = await predecessor();
    await admin`UPDATE harness_shared.adv_sessions SET started_at = now() - interval '5 minutes' WHERE id = ${id}`;
    await expect(markAdvSessionEnded(id, 0, 'self', { observedAt: new Date(), throwOnError: true })).resolves.toBe(true);
    const [row] = await admin`SELECT ended_at, ended_by FROM harness_shared.adv_sessions WHERE id = ${id}`;
    expect(row.ended_at).not.toBeNull();
    expect(row.ended_by).toBe('self');
  });
});

describe('reanchorAdvSessionNativeId (real PG — the 42703 RETURNING-column regression guard)', () => {
  it('re-anchors the row to the successor native id and returns the coord owner', async () => {
    const id = await seedAdv({ coordOwnerId: OWNER, sessionId: DEAD_ID, ended: true });
    const res = await reanchorAdvSessionNativeId(id, FRESH_ID);
    expect(res).toEqual({ reanchored: true, owner: OWNER });
    const [row] = await admin<{ session_id: string; ended_at: Date | null }[]>`
      SELECT session_id, ended_at FROM harness_shared.adv_sessions WHERE id = ${id}
    `;
    expect(row.session_id).toBe(FRESH_ID);
    expect(row.ended_at).toBeNull();
  });

  it('does not re-anchor or clear terminal state on a fleet-retired row', async () => {
    const id = await seedAdv({ coordOwnerId: OWNER, sessionId: DEAD_ID, ended: true });
    await admin`
      UPDATE harness_shared.adv_sessions
         SET retired_at = now(), retired_by = 'fleet:kill:test', retired_reason = 're-anchor regression test'
       WHERE id = ${id}
    `;
    const [before] = await admin<{ session_id: string; started_at: Date; ended_at: Date | null; retired_at: Date | null }[]>`
      SELECT session_id, started_at, ended_at, retired_at
        FROM harness_shared.adv_sessions
       WHERE id = ${id}
    `;

    await expect(reanchorAdvSessionNativeId(id, FRESH_ID))
      .resolves.toEqual({ reanchored: false, owner: null });

    const [after] = await admin<{ session_id: string; started_at: Date; ended_at: Date | null; retired_at: Date | null }[]>`
      SELECT session_id, started_at, ended_at, retired_at
        FROM harness_shared.adv_sessions
       WHERE id = ${id}
    `;
    expect(after).toEqual(before);
  });

  it('already-anchored → reanchored:false but STILL reports the owner (WI-41555)', async () => {
    // ⚠ This expectation deliberately CHANGED, and must not be "restored".
    // It used to assert `owner: null`, which encoded the frozen-gauge defect as
    // intended behaviour: the respawn route clears the context-usage + anchor
    // caches only `if (owner)`, so a NO-OP re-anchor — the ordinary case for the
    // cold-loop recycle cohort, whose spawn path stamps the new native id onto
    // the row before the report lands — skipped both clears. The anchored gauge
    // then served the DEAD predecessor's token count forever, so a fresh
    // successor rendered ~81%, re-cut immediately, and ITS successor inherited
    // the same number: an unbounded reset loop in which no session does work.
    // `reanchored` and `owner` answer INDEPENDENT questions — "did I change the
    // row" vs "whose row is it" — and respawn hygiene keys off the second.
    const id = await seedAdv({ coordOwnerId: OWNER, sessionId: FRESH_ID });
    const res = await reanchorAdvSessionNativeId(id, FRESH_ID);
    expect(res).toEqual({ reanchored: false, owner: OWNER });
  });

  it('a missing row touches nothing and reports false', async () => {
    const res = await reanchorAdvSessionNativeId(999_999, FRESH_ID);
    expect(res).toEqual({ reanchored: false, owner: null });
  });

  // WI-10004917: the row moved, but no applied identity event ever named the new
  // native id, so every owner-by-native-session oracle read the relaunched
  // incarnation's turns as foreign (the goal-brief R-3 probe runs exactly ownersOf).
  it.each(['exact', 'owner'] as const)(
    'opens an applied identity span for the re-anchored incarnation through the %s path (WI-10004917)',
    async (target) => {
      const owner = `su-reanchor-span-${target}`;
      // Activation events outlive both the per-test adv_sessions truncate and the run
      // (the baseline container is reused), so the successor id must be unique per
      // run or the positive control below sees an earlier run's span.
      const fresh = randomUUID();
      const id = await seedAdv({ coordOwnerId: owner, sessionId: DEAD_ID });
      const revision = { specificationRevision: 'c'.repeat(64), stateRevision: `reanchor-${target}` };
      const requested = await requestSessionIdentityActivation({
        ownerId: owner, workspaceId: WS, revision, source: 'launch',
        attribution: { actorId: owner, principalId: owner, sessionId: owner },
      });
      const applied = acknowledgeActivation(prepareActivation(requested.state.activation!, revision), revision);
      await admin`
        UPDATE harness_shared.session_briefs
           SET control_state = jsonb_set(control_state, '{activation}', ${admin.json(applied)}, true)
         WHERE workspace_id = ${WS} AND owner_id = ${owner}
      `;
      const ownersOf = (native: string) => admin`
        SELECT DISTINCT owner_id, workspace_id FROM harness_shared.session_identity_activation_spans
         WHERE native_session_id = ${native}
      `;
      const reanchor = () => (target === 'exact'
        ? reanchorAdvSessionNativeId(id, fresh)
        : reanchorAdvSessionNativeIdByOwner(owner, fresh));
      try {
        // Positive control: before the re-anchor the oracle cannot resolve the successor.
        expect(await ownersOf(fresh)).toEqual([]);
        expect(await reanchor()).toEqual({ reanchored: true, owner });
        expect(await ownersOf(fresh)).toEqual([{ owner_id: owner, workspace_id: WS }]);
        // A retried report is a no-op re-anchor and converges on the one event.
        expect(await reanchor()).toEqual({ reanchored: false, owner });
        const events = await admin<{ native_session_id: string; source: string; adv_session_id: string }[]>`
          SELECT native_session_id, source, adv_session_id::text
            FROM harness_shared.session_identity_activation_events
           WHERE workspace_id = ${WS} AND owner_id = ${owner} AND phase = 'applied'
             AND adv_session_id = ${id}
        `;
        expect(events).toEqual([{ native_session_id: fresh, source: 'reanchor', adv_session_id: String(id) }]);
      } finally {
        await admin`DELETE FROM harness_shared.session_briefs WHERE workspace_id = ${WS} AND owner_id = ${owner}`;
      }
    },
  );
});

describe('reanchorAdvSessionNativeIdByOwner (the interactive/`psu --resume` cohort)', () => {
  it('re-anchors the sole active row for the owner without consulting mutable started_at', async () => {
    await seedAdv({ coordOwnerId: OWNER, sessionId: 'a1a1a1a1-0000-4000-8000-000000000001', startedAgoSec: 3600, ended: true });
    const newest = await seedAdv({ coordOwnerId: OWNER, sessionId: DEAD_ID, startedAgoSec: 60 });
    const res = await reanchorAdvSessionNativeIdByOwner(OWNER, FRESH_ID);
    expect(res).toEqual({ reanchored: true, owner: OWNER });
    const [row] = await admin<{ session_id: string }[]>`
      SELECT session_id FROM harness_shared.adv_sessions WHERE id = ${newest}
    `;
    expect(row.session_id).toBe(FRESH_ID);
    // The consumer the whole fix exists for: the watchdog's owner→native resolve
    // must now name the LIVE successor, not the dead predecessor.
    const ref = await resolveSessionRef(OWNER);
    expect(ref?.sessionId).toBe(FRESH_ID);
  });

  it('does not select or revive a fleet-retired owner row', async () => {
    const id = await seedAdv({ coordOwnerId: OWNER, sessionId: DEAD_ID, ended: true });
    await admin`
      UPDATE harness_shared.adv_sessions
         SET retired_at = now(), retired_by = 'fleet:kill:test', retired_reason = 're-anchor regression test'
       WHERE id = ${id}
    `;
    const [before] = await admin<{ session_id: string; started_at: Date; ended_at: Date | null; retired_at: Date | null }[]>`
      SELECT session_id, started_at, ended_at, retired_at
        FROM harness_shared.adv_sessions
       WHERE id = ${id}
    `;

    await expect(reanchorAdvSessionNativeIdByOwner(OWNER, FRESH_ID))
      .resolves.toEqual({ reanchored: false, owner: null });

    const [after] = await admin<{ session_id: string; started_at: Date; ended_at: Date | null; retired_at: Date | null }[]>`
      SELECT session_id, started_at, ended_at, retired_at
        FROM harness_shared.adv_sessions
       WHERE id = ${id}
    `;
    expect(after).toEqual(before);
  });

  it('already-anchored → reanchored:false, still reports the owner, never touches another owner (WI-41555)', async () => {
    // Same deliberate change as the by-id sibling above: the no-op path must
    // still hand the caller an owner, or respawn gauge hygiene never runs for
    // the interactive / `psu --resume` cohort. Do not restore `owner: null`.
    const other = await seedAdv({ coordOwnerId: 'su-other', sessionId: DEAD_ID });
    await seedAdv({ coordOwnerId: OWNER, sessionId: FRESH_ID });
    const res = await reanchorAdvSessionNativeIdByOwner(OWNER, FRESH_ID);
    expect(res).toEqual({ reanchored: false, owner: OWNER });
    const [row] = await admin<{ session_id: string }[]>`
      SELECT session_id FROM harness_shared.adv_sessions WHERE id = ${other}
    `;
    expect(row.session_id).toBe(DEAD_ID);
  });

  it('refuses two active rows instead of selecting one by mutable started_at (WI-42507)', async () => {
    const first = await seedAdv({ coordOwnerId: OWNER, sessionId: DEAD_ID, startedAgoSec: 60 });
    const second = await seedAdv({
      coordOwnerId: OWNER,
      sessionId: 'a1a1a1a1-0000-4000-8000-000000000002',
      startedAgoSec: 3600,
    });
    const res = await reanchorAdvSessionNativeIdByOwner(OWNER, FRESH_ID);
    expect(res).toEqual({ reanchored: false, owner: null });
    const rows = await admin<{ id: number; session_id: string }[]>`
      SELECT id, session_id
        FROM harness_shared.adv_sessions
       WHERE id IN (${first}, ${second})
       ORDER BY id
    `;
    expect(rows.map((row) => row.session_id)).toEqual([
      DEAD_ID,
      'a1a1a1a1-0000-4000-8000-000000000002',
    ]);
  });

  it('an unknown owner touches nothing and reports false', async () => {
    const res = await reanchorAdvSessionNativeIdByOwner('su-nobody', FRESH_ID);
    expect(res).toEqual({ reanchored: false, owner: null });
  });
});

describe('setAdvSessionPid workspace override (WI-10002854, real PG)', () => {
  // The wake executor runs pinned to the coordination workspace, which is not the
  // workspace the row belongs to. The resumed turn's pid write therefore has to
  // name the row's workspace. The ambient scope matches zero rows and reports
  // nothing.
  it('the ambient scope misses a row in another workspace; the explicit override lands the pid', async () => {
    expect(activeWorkspaceId()).not.toBe(WS); // precondition: the two scopes really differ
    const id = await seedAdv({ coordOwnerId: OWNER, sessionId: DEAD_ID });

    await setAdvSessionPid(id, 4242);
    const [ambient] = await admin<{ pid: number | null }[]>`SELECT pid FROM harness_shared.adv_sessions WHERE id = ${id}`;
    expect(ambient.pid).toBeNull();

    await setAdvSessionPid(id, 4242, undefined, WS);
    const [scoped] = await admin<{ pid: number | null; terminal_bin: string | null }[]>`
      SELECT pid, terminal_bin FROM harness_shared.adv_sessions WHERE id = ${id}
    `;
    expect(scoped.pid).toBe(4242);
    expect(scoped.terminal_bin).toBeNull(); // an omitted terminalBin never blanks or invents one
  });

  it('keeps a terminal_bin another writer set (the headless launch-log key the roster reads)', async () => {
    const id = await seedAdv({ coordOwnerId: OWNER, sessionId: DEAD_ID });
    await admin`UPDATE harness_shared.adv_sessions SET terminal_bin = 'psu-headless:/tmp/x.log' WHERE id = ${id}`;
    await setAdvSessionPid(id, 5151, undefined, WS);
    const [row] = await admin<{ pid: number | null; terminal_bin: string | null }[]>`
      SELECT pid, terminal_bin FROM harness_shared.adv_sessions WHERE id = ${id}
    `;
    expect(row).toEqual({ pid: 5151, terminal_bin: 'psu-headless:/tmp/x.log' });
  });
});

describe('bootstrap-role receipt through the route and real PostgreSQL', () => {
  it('records the accepted operation and activates its grant-bearing identity before returning', async () => {
    const sid = 'su-receipt-route-integration';
    const nativeSessionId = 'f7e30bb4-772b-4994-a10b-e257afbb12ce';
    const startingId = await seedAdv({ coordOwnerId: sid });
    await admin`
      UPDATE harness_shared.adv_sessions SET display = 'terminal', workspace_id = ${activeWorkspaceId()}
       WHERE id = ${startingId}
    `;
    const cwd = mkdtempSync(join(tmpdir(), 'bootstrap-role-receipt-'));
    const priorLaunchContextDir = process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR;
    process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR = cwd;
    const artifact = { configuration: { grants: { requires: ['work_items:get'], optional: [], suggestedProviders: {} } } };
    const revision = { specificationRevision: 'a'.repeat(64), stateRevision: 'b'.repeat(64) };
    const acceptedOperation = {
      workItemId: 'F-route-receipt', operationId: 'run', specificationRevision: 'c'.repeat(64),
      pin: { kind: 'blueprint-operation', harnessSlug: 'papercusp', operationId: 'run',
        specificationRevision: 'c'.repeat(64), operationVersion: '1.0.0', input: {} },
      identity: { ref: 'blueprint-operation-worker', revision: '0.1.0', contentHash: 'd'.repeat(64) },
      stack: ['domain:blueprint-operation-worker'], requiredTools: ['work_items:get'],
    };
    const mocked = [
      './auth/require-principal', './role-registry', './role-launch-spec',
      './blueprint/operation-worker-binding', './spawn-config',
      './endpoint-route/routes/agent-mcp/bootstrap-su', '@papercusp/flags/server',
      './interactive-claude-config', './saved-prompts-materialize',
      './blueprint/support-workflow-native-launch',
    ];

    vi.doMock('./auth/require-principal', async (orig) => ({
      ...(await orig<typeof import('./auth/require-principal')>()),
      requirePrincipal: vi.fn(async () => {}),
    }));
    vi.doMock('./role-registry', async (orig) => ({
      ...(await orig<typeof import('./role-registry')>()),
      roleConsumes: () => ({ feature: 'required', plan: 'none' }),
    }));
    vi.doMock('./role-launch-spec', async (orig) => ({
      ...(await orig<typeof import('./role-launch-spec')>()),
      mintRoleLaunchIdentity: () => ({ sid: 'role-new-unpinned', nativeSessionId }),
      buildRoleLaunchSpec: async (input: { acceptedOperation?: unknown }) => ({
        role: 'worker', runId: 'worker-F-route-receipt-1', spawnId: 'sp-route-receipt',
        harnessSlug: 'papercusp', featureId: acceptedOperation.workItemId, cwd,
        promptText: 'RESTRICTED WORKER', promptFile: join(cwd, 'role.md'),
        mcpUrl: 'http://localhost:3070/api/mcp?role=worker&sig=test',
        mcpJsonContents: JSON.stringify({ mcpServers: { papercusp: { url: 'http://localhost:3070/api/mcp?role=worker&sig=test' } } }),
        sid, nativeSessionId,
        claudeConfigDir: join(cwd, 'claude'), sessionMcpDir: join(cwd, 'mcp'),
        contextSize: 'trimmed', stack: acceptedOperation.stack,
        acceptedOperation: input.acceptedOperation,
        specificationArtifact: artifact, ...revision, compositionSource: 'blueprint',
      }),
    }));
    vi.doMock('./blueprint/operation-worker-binding', async (orig) => ({
      ...(await orig<typeof import('./blueprint/operation-worker-binding')>()),
      resolveAcceptedOperationWorkerBinding: vi.fn(async () => acceptedOperation),
    }));
    vi.doMock('./spawn-config', async (orig) => ({
      ...(await orig<typeof import('./spawn-config')>()),
      resolveProjectDir: vi.fn(async () => cwd),
    }));
    vi.doMock('./endpoint-route/routes/agent-mcp/bootstrap-su', async (orig) => ({
      ...(await orig<typeof import('./endpoint-route/routes/agent-mcp/bootstrap-su')>()),
      resolveAccountPin: vi.fn(async () => ({ env: {}, notice: null, accountId: null, provider: null })),
      resolveFleet: vi.fn(async () => ({ env: {}, notice: null, fleetSlug: null, fleetRole: null })),
      reconstructPsuLaunchArgv: vi.fn(() => ['psu', '--role=worker']),
      stampFleetMembershipAtBoot: vi.fn(async () => null),
      stampPresenceAtBoot: vi.fn(async () => null),
    }));
    // The accepted operation here is synthetic; native support routing has its own route tests.
    vi.doMock('./blueprint/support-workflow-native-launch', () => ({
      prepareSupportOperationNativeLaunch: vi.fn(async () => null),
    }));
    vi.doMock('@papercusp/flags/server', async (orig) => ({
      ...(await orig<typeof import('@papercusp/flags/server')>()),
      getFlag: vi.fn(async () => false),
    }));
    vi.doMock('./interactive-claude-config', () => ({
      writeInteractiveClaudeConfig: vi.fn(() => ({ configDir: join(cwd, 'claude') })),
    }));
    vi.doMock('./saved-prompts-materialize', () => ({
      materializeCodexPrompts: vi.fn(async () => ({})),
      materializeWorkspacePrompts: vi.fn(async () => ({})),
      materializeHarnessPrompts: vi.fn(async () => ({})),
    }));

    try {
      const { default: routes } = await import('./endpoint-route/routes/agent-mcp/bootstrap-role');
      const post = routes.find((route) => route.method === 'POST')!;
      const response = await post.handler(new Request('http://localhost:3070/api/agent-mcp/console/bootstrap-role', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'worker', agent: 'claude', harness_slug: 'papercusp', feature: acceptedOperation.workItemId, owner_id: sid }),
      }), { principal: null, input: undefined, params: {}, log: () => {}, signal: new AbortController().signal });
      const launch = await response.json();
      expect(response.status, JSON.stringify(launch)).toBe(200);
      expect(launch.envelopeEnv.PAPERCUSP_SID).toBe(sid);
      expect(launch.sessionId).toBe(Number(startingId));
      const ownerRows = await admin<{ role: string; feature: string }[]>`
        SELECT role, feature FROM harness_shared.adv_sessions WHERE coord_owner_id = ${sid}
      `;
      expect(ownerRows).toEqual([{ role: 'worker', feature: acceptedOperation.workItemId }]);
      const [stored] = await admin<{ value_kind: string; launch_spec: unknown }[]>`
        SELECT jsonb_typeof(launch_spec) AS value_kind, launch_spec
          FROM harness_shared.adv_sessions WHERE id = ${launch.sessionId}
      `;
      expect(stored?.value_kind).toBe('object');
      expect(stored?.launch_spec).toMatchObject({
        specificationArtifact: artifact, ...revision,
        acceptedOperation: {
          kind: 'blueprint-operation-worker', workItemId: acceptedOperation.workItemId,
          pin: acceptedOperation.pin, identity: acceptedOperation.identity, requiredTools: ['work_items:get'],
        },
      });
      expect(await readSuLaunchSpecByOwner(sid)).toEqual(stored.launch_spec);
      const [brief] = await admin<{ activation: unknown }[]>`
        SELECT control_state->'activation' AS activation
          FROM harness_shared.session_briefs WHERE owner_id = ${sid}
      `;
      expect(brief?.activation).toMatchObject({ desired: revision, status: 'desired' });
    } finally {
      await admin`DELETE FROM harness_shared.session_briefs WHERE owner_id = ${sid}`;
      for (const name of mocked) vi.doUnmock(name);
      if (priorLaunchContextDir === undefined) delete process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR;
      else process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR = priorLaunchContextDir;
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});
