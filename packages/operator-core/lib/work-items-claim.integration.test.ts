/**
 * work-items-claim.integration.test.ts — the blackboard as a tuple-space (P3, D-004/D-007).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04. Proves the claim primitives against
 * real Postgres:
 *   • claim (`in`) is an ATOMIC compare-and-claim — two competing claims on one item ⇒
 *     exactly one wins (the old code was last-write-wins, where both "won").
 *   • claim_next is the ASSOCIATIVE `in` via SELECT … FOR UPDATE SKIP LOCKED + oldest-first
 *     (work-stealing, D-007): competing consumers each grab a different, most-starved item.
 *   • observe (`rd`) reads claimability WITHOUT taking.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEventSubstrateMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, applyClaimPathReadDeps, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { mintLegacyFleetScopeDowngradeAdmission } from './work-item-fleet-scope-recovery';
import { acknowledgeActivation, desiredActivation, prepareActivation } from './session-activation';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

// Canonical complete consolidated-features schema (single source of truth) — see
// test/_work-items-schema.ts (D-014 fixture-completeness debt).
const HFC_DDL = HARNESS_FEATURES_CONSOLIDATED_DDL;

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  // WI-10004367: member harness -> pot home slug, read by the potHomeSlugForHarness mock.
  potHomes: {} as Record<string, string>,
}));
// WI-10004367: potHomeSlugForHarness is a harness-REGISTRY read. Overriding only it makes a
// harness a pot MEMBER while the real resolveWorkItemPot / potExists path runs.
vi.mock('./hive-federation', async () => {
  const actual = await vi.importActual<typeof import('./hive-federation')>('./hive-federation');
  return {
    ...actual,
    potHomeSlugForHarness: async (...args: Parameters<typeof actual.potHomeSlugForHarness>) =>
      h.potHomes[args[1]] ?? actual.potHomeSlugForHarness(...args),
  };
});
const releaseReclaimedWorkItemLocks = vi.hoisted(() => vi.fn());
const leaderDispatchAdmission = vi.hoisted(() => ({
  resolveFleetScopeContext: vi.fn(),
  fleetControlWindDownRefusal: vi.fn(),
  leaderDispatchedAdmission: vi.fn(),
  selfFiledFalloutAdmission: vi.fn(),
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});
vi.mock('./work-item-lock-release', () => ({
  releaseReclaimedWorkItemLocks: (...args: unknown[]) => releaseReclaimedWorkItemLocks(...args),
}));
vi.mock('./scheduler/fleet-scope-admission', () => ({
  resolveFleetScopeContext: (...args: unknown[]) => leaderDispatchAdmission.resolveFleetScopeContext(...args),
  fleetControlWindDownRefusal: (...args: unknown[]) => leaderDispatchAdmission.fleetControlWindDownRefusal(...args),
  leaderDispatchedAdmission: (...args: unknown[]) => leaderDispatchAdmission.leaderDispatchedAdmission(...args),
  selfFiledFalloutAdmission: (...args: unknown[]) => leaderDispatchAdmission.selfFiledFalloutAdmission(...args),
}));

const wi = await import('./work-items');
const H = 'papercup';
let db: FreshPgDb;

async function seedFeature(
  id: string,
  opts: {
    createdTs?: number;
    kind?: string;
    status?: string;
    takenBy?: string | null;
    origin?: string;
    auditVerdict?: string | null;
    admission?: string | null;
  } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts, origin, audit_verdict, admission)
    VALUES (${H}, ${id}, ${opts.kind ?? 'feature'}, ${opts.status ?? 'open'}, ${opts.takenBy ?? null}, 'default', ${opts.createdTs ?? 0}, 0, ${opts.origin ?? 'local'}, ${opts.auditVerdict ?? null}, ${opts.admission ?? null})`;
}

// WI-3649: the issue-family (bug/change/task) counterpart of seedFeature — inserted
// directly into the base `work_items` table (mirroring how a real federated row
// arrives: the hyperbee->PG projector writes work_items directly, never through the
// engineer_issues view), so `origin` is under direct control the way a real
// federation-synced row would be.
async function seedIssue(
  id: string,
  opts: {
    createdTs?: number;
    kind?: string;
    status?: string;
    takenBy?: string | null;
    origin?: string;
    assignedBy?: string | null;
    createdBy?: string | null;
    admission?: string | null;
    // work-item-status-full-unify: the substrate author key. A row whose author is one this
    // workspace ALSO wrote locally is OUR own-node work even when it round-trips federation as
    // origin='remote' (issueOwnAuthorWhereSql). NULL ⇒ anonymous (the default federated row).
    authorPubkey?: string | null;
  } = {},
) {
  const payload = opts.assignedBy === undefined && opts.createdBy === undefined
    ? null
    : JSON.stringify({
        _ei: {
          ...(opts.assignedBy !== undefined ? { assigned_by: opts.assignedBy } : {}),
          ...(opts.createdBy !== undefined ? { created_by: opts.createdBy } : {}),
        },
      });
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts, origin, author_pubkey, payload, admission)
    VALUES (${H}, ${id}, ${opts.kind ?? 'bug'}, ${opts.status ?? 'open'}, ${opts.takenBy ?? null}, 'default', ${opts.createdTs ?? 0}, 0, ${opts.origin ?? 'local'}, ${opts.authorPubkey ?? null}, ${payload}::text::jsonb, ${opts.admission ?? null})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('wi-claim');
  h.sql = db.sql;
  await db.sql.unsafe(HFC_DDL);
  // EI-22040912157347872: every live claim/list path now reads the durable
  // plan-item assignment floor. Install the production table in this narrowed
  // fixture so its claim assertions exercise the real schema instead of failing
  // before the floor can be evaluated.
  await db.sql.unsafe(readMigration('140-plan-item-assignments.sql')).simple();
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple(); // claim path's P-005 readiness clause reads work_item_deps
  // P-007: claim authority reads the active role receipt. Narrow work-item
  // fixtures carry only the two columns sets that reader needs.
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.adv_sessions (
      id bigserial PRIMARY KEY, workspace_id text NOT NULL, coord_owner_id text,
      role text, started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz, ended_by text, launch_spec jsonb
    );
    CREATE TABLE harness_shared.session_briefs (
      workspace_id text NOT NULL, owner_id text NOT NULL, control_state jsonb,
      PRIMARY KEY (workspace_id, owner_id)
    );
    CREATE TABLE harness_shared.blueprint_specifications (
      workspace_id text NOT NULL, harness_slug text NOT NULL,
      specification_revision text NOT NULL, artifact jsonb NOT NULL,
      PRIMARY KEY (workspace_id, harness_slug, specification_revision)
    );
  `).simple();
  // The claim path emits awaited claim/release events and arms lifecycle-bound
  // interests. Keep this throwaway DB on the event schema those side effects
  // actually use; without it, the CAS assertions are obscured by fail-soft
  // event warnings and missing-relation errors (EI-21196424219621734). The shared
  // event-substrate list is audited from creation, so it cannot fall behind (WI-10004700).
  await applyEventSubstrateMigrationsForTest(db.sql, { label: 'work-items-claim.integration.test.ts' });
  // Per-assignee rank columns (local-hive P-020, migration 178 §1) — FEATURE_COLS/ISSUE_COLS select them.
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS assignee_rank integer, ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz;
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS assignee_rank integer, ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz,
      ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`).simple();
  // WI-3649: the by-id issue claim auto-subscribes the claimer (coord_entity_subscriptions).
  await ensureCoordCapabilityTables(db.sql);
  // WI-10005130: the shared claim-path read deps (trust list, deps, adv_sessions, event
  // tables, Scout ledger) go LAST — every statement is IF NOT EXISTS, so it only fills
  // what the hand-built schema above (adv_sessions, event substrate) left out.
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
}, 90_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await db.sql`
    TRUNCATE harness_shared.work_items,
             harness_shared.adv_sessions,
             harness_shared.session_briefs,
             harness_shared.blueprint_specifications,
             harness_shared.event_awaits,
             harness_shared.event_wake_deliveries,
             harness_shared.event_key_fires,
             harness_shared.predicate_watches`;
  releaseReclaimedWorkItemLocks.mockReset();
  releaseReclaimedWorkItemLocks.mockResolvedValue({ releases: [], failures: 0, skipped: null });
  leaderDispatchAdmission.resolveFleetScopeContext.mockReset().mockResolvedValue(null);
  leaderDispatchAdmission.fleetControlWindDownRefusal.mockReset().mockResolvedValue(null);
  leaderDispatchAdmission.leaderDispatchedAdmission.mockReset().mockResolvedValue(false);
  leaderDispatchAdmission.selfFiledFalloutAdmission.mockReset().mockReturnValue(false);
});

describe('blueprint operation claim authority (real PostgreSQL)', () => {
  const operationRevision = 'c'.repeat(64);
  const launchRevision = { specificationRevision: 'a'.repeat(64), stateRevision: 'b'.repeat(64) };
  const pin = () => ({
    kind: 'blueprint-operation', harnessSlug: H, operationId: 'execute',
    specificationRevision: operationRevision, operationVersion: '1.0.0', input: {},
  });

  async function activateWorker(
    ownerId: string,
    itemId: string,
    launch: { harnessSlug: string; pin: ReturnType<typeof pin> } = { harnessSlug: H, pin: pin() },
  ) {
    const activation = acknowledgeActivation(prepareActivation(desiredActivation(
      { actorId: ownerId, principalId: ownerId, sessionId: ownerId }, launchRevision,
    ), launchRevision), launchRevision);
    await db.sql`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, coord_owner_id, role, launch_spec)
      VALUES ('default', ${ownerId}, 'worker', ${db.sql.json({
        workspaceId: 'default', harnessSlug: launch.harnessSlug, role: 'worker', ...launchRevision,
        specificationArtifact: { configuration: { grants: {} } },
        acceptedOperation: {
          kind: 'blueprint-operation-worker', workItemId: itemId, operationId: 'execute',
          specificationRevision: operationRevision,
          pin: launch.pin,
          identity: { ref: 'worker', revision: '1.0.0', contentHash: 'd'.repeat(64) },
          requiredTools: ['work_items:claim'],
        },
      })})
    `;
    await db.sql`
      INSERT INTO harness_shared.session_briefs (workspace_id, owner_id, control_state)
      VALUES ('default', ${ownerId}, ${db.sql.json({ activation })})
    `;
  }

  it('requires an applied exact worker for pinned feature and issue claims', async () => {
    await seedFeature('WI-op-feature');
    await seedIssue('WI-op-issue');
    await db.sql`UPDATE harness_shared.work_items SET payload = ${db.sql.json({ blueprintOperation: pin() })}
      WHERE feature_id = 'WI-op-feature'`;
    await db.sql`UPDATE harness_shared.work_items SET payload = ${db.sql.json({ blueprintOperation: pin() })}
      WHERE feature_id = 'WI-op-issue'`;

    expect(await wi.claimWorkItem('WI-op-feature', 'ordinary-su', { harness: H })).toBeNull();
    expect(await wi.claimWorkItem('WI-op-issue', 'ordinary-su', { harness: H })).toBeNull();

    await activateWorker('worker-feature', 'WI-op-feature');
    expect(await wi.claimWorkItem('WI-op-issue', 'worker-feature', { harness: H })).toBeNull();
    expect((await wi.claimWorkItem('WI-op-feature', 'worker-feature', { harness: H }))?.assignee)
      .toBe('worker-feature');

    await activateWorker('worker-issue', 'WI-op-issue');
    expect((await wi.claimWorkItem('WI-op-issue', 'worker-issue', { harness: H }))?.assignee)
      .toBe('worker-issue');
    await db.sql`UPDATE harness_shared.adv_sessions SET ended_at = now() WHERE coord_owner_id = 'worker-issue'`;
    await db.sql`UPDATE harness_shared.work_items SET taken_by = NULL WHERE feature_id = 'WI-op-issue'`;
    expect(await wi.claimWorkItem('WI-op-issue', 'worker-issue', { harness: H })).toBeNull();
  });

  // WI-10004367: createWorkItem re-homes a pot MEMBER harness's accepted item to the pot
  // home slug, while its pin and the worker's launch receipt keep the member slug. The
  // claim guard and its SQL race fence compared both to ONE slug, so no worker could ever
  // claim a potted operation. The row must match the storage slug; the pin, the member.
  it('lets the applied worker claim a pot member item stored under its pot home, and nothing wider', async () => {
    const POT_HOME = 'claim-pot-home';
    const OTHER_HOME = 'claim-other-pot-home';
    const MEMBER = 'claim-pot-member';
    await db.sql`CREATE TABLE IF NOT EXISTS harness_shared.pots (
      workspace_id text NOT NULL, pot_home_slug text NOT NULL, PRIMARY KEY (workspace_id, pot_home_slug))`;
    await db.sql`INSERT INTO harness_shared.pots (workspace_id, pot_home_slug)
      VALUES ('default', ${POT_HOME}), ('default', ${OTHER_HOME}) ON CONFLICT DO NOTHING`;
    h.potHomes[MEMBER] = POT_HOME;
    try {
      const memberPin = { ...pin(), harnessSlug: MEMBER };
      await seedFeature('WI-op-potted');
      await seedFeature('WI-op-wrong-home');
      await db.sql`UPDATE harness_shared.work_items
        SET harness_slug = ${POT_HOME}, payload = ${db.sql.json({ blueprintOperation: memberPin })}
        WHERE feature_id = 'WI-op-potted'`;
      await db.sql`UPDATE harness_shared.work_items
        SET harness_slug = ${OTHER_HOME}, payload = ${db.sql.json({ blueprintOperation: memberPin })}
        WHERE feature_id = 'WI-op-wrong-home'`;
      // Positive control: the row really sits under the pot home, not the member slug.
      expect((await db.sql<{ harness_slug: string }[]>`SELECT harness_slug FROM harness_shared.work_items
        WHERE feature_id = 'WI-op-potted'`)[0]?.harness_slug).toBe(POT_HOME);

      expect(await wi.claimWorkItem('WI-op-potted', 'ordinary-su', { harness: POT_HOME })).toBeNull();
      await activateWorker('worker-potted', 'WI-op-potted', { harnessSlug: MEMBER, pin: memberPin });
      expect((await wi.claimWorkItem('WI-op-potted', 'worker-potted', { harness: POT_HOME }))?.assignee)
        .toBe('worker-potted');

      // Negative control: the same member pin stored under a pot home that is NOT the
      // member's stays unclaimable, so the storage slug is resolved, not trusted from the row.
      await activateWorker('worker-wrong-home', 'WI-op-wrong-home', { harnessSlug: MEMBER, pin: memberPin });
      expect(await wi.claimWorkItem('WI-op-wrong-home', 'worker-wrong-home', { harness: OTHER_HOME })).toBeNull();
    } finally {
      delete h.potHomes[MEMBER];
      await db.sql`DELETE FROM harness_shared.pots WHERE workspace_id = 'default'
        AND pot_home_slug IN (${POT_HOME}, ${OTHER_HOME})`;
    }
  });

  it('filters self-pull atomically to the applied operation item', async () => {
    await seedFeature('WI-pull-feature');
    await seedIssue('WI-pull-issue');
    await db.sql`UPDATE harness_shared.work_items SET payload = ${db.sql.json({ blueprintOperation: pin() })}
      WHERE feature_id IN ('WI-pull-feature', 'WI-pull-issue')`;

    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'ordinary-su' })).toBeNull();
    expect(await wi.claimNextIssueWorkItem({ harness: H, assignee: 'ordinary-su' }, 'default')).toBeNull();

    await activateWorker('pull-feature-worker', 'WI-pull-feature');
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'pull-feature-worker' }))?.id)
      .toBe('WI-pull-feature');
    expect(await wi.claimNextIssueWorkItem({ harness: H, assignee: 'pull-feature-worker' }, 'default'))
      .toBeNull();

    await activateWorker('pull-issue-worker', 'WI-pull-issue');
    expect((await wi.claimNextIssueWorkItem({ harness: H, assignee: 'pull-issue-worker' }, 'default'))?.id)
      .toBe('WI-pull-issue');
  });

  it('fences a receipt that ends or loses activation after admission was read', async () => {
    const owner = 'worker-stale-read';
    await seedFeature('WI-stale-receipt');
    await db.sql`UPDATE harness_shared.work_items SET payload = ${db.sql.json({ blueprintOperation: pin() })}
      WHERE feature_id = 'WI-stale-receipt'`;
    await activateWorker(owner, 'WI-stale-receipt');
    const claims = await import('./blueprint/operation-worker-binding');
    const read = await claims.readActiveOperationWorkerClaimBinding('default', owner);
    expect(read.status).toBe('bound');
    const stillEligible = () => db.sql`
      SELECT target.feature_id FROM harness_shared.work_items AS target
       WHERE target.feature_id = 'WI-stale-receipt'
         AND ${claims.operationWorkerClaimWhereSql(db.sql, read, {
           payload: 'target.payload', id: 'target.feature_id', harness: 'target.harness_slug',
         })}
    `;
    expect(await stillEligible()).toHaveLength(1);
    await db.sql`UPDATE harness_shared.work_items SET payload = ${db.sql.json({
      blueprintOperation: { ...pin(), input: { changed: true } },
    })} WHERE feature_id = 'WI-stale-receipt'`;
    expect(await stillEligible()).toHaveLength(0);
    await db.sql`UPDATE harness_shared.work_items SET payload = ${db.sql.json({ blueprintOperation: pin() })}
      WHERE feature_id = 'WI-stale-receipt'`;
    await db.sql`UPDATE harness_shared.adv_sessions SET ended_at = now() WHERE coord_owner_id = ${owner}`;
    expect(await stillEligible()).toHaveLength(0);
    await db.sql`UPDATE harness_shared.adv_sessions SET ended_at = NULL WHERE coord_owner_id = ${owner}`;
    await db.sql`UPDATE harness_shared.session_briefs SET control_state = ${db.sql.json({ activation: {
      status: 'desired', desired: { specificationRevision: 'a'.repeat(64), stateRevision: 'b'.repeat(64) },
      prepared: null, applied: null,
      schemaVersion: 1, attribution: { actorId: owner, principalId: owner, sessionId: owner },
    } })} WHERE owner_id = ${owner}`;
    expect(await stillEligible()).toHaveLength(0);
  });

  it('rejects an old feature holder at the state and completion writer after reassignment', async () => {
    const id = 'WI-operation-effect';
    await seedFeature(id);
    await db.sql`UPDATE harness_shared.work_items SET payload = ${db.sql.json({ blueprintOperation: pin() })}
      WHERE feature_id = ${id}`;
    await activateWorker('effect-old', id);
    await activateWorker('effect-current', id);
    expect((await wi.claimWorkItem(id, 'effect-old', { harness: H }))?.assignee).toBe('effect-old');
    expect((await wi.setWorkItemState(id, 'wip', { harness: H, by: 'effect-old' }))?.state).toBe('wip');
    await db.sql`UPDATE harness_shared.work_items SET taken_by = 'effect-current' WHERE feature_id = ${id}`;

    await expect(wi.setWorkItemState(id, 'done', {
      harness: H, by: 'effect-old', completionRef: 'stale result',
    })).rejects.toThrow('blueprint operation effect refused');
    expect((await wi.getWorkItem(id, H))?.state).toBe('wip');
    await expect(wi.setWorkItemState(id, 'done', {
      harness: H, by: 'effect-current', completionRef: 'current result',
    })).rejects.toThrow('accepted blueprint operation specification snapshot is missing');
    expect((await wi.getWorkItem(id, H))?.state).toBe('wip');
  });

  it('also fences the direct issue state writer after reassignment', async () => {
    const id = 'WI-operation-issue-effect';
    await seedIssue(id);
    await db.sql`UPDATE harness_shared.work_items SET payload = ${db.sql.json({ blueprintOperation: pin() })}
      WHERE feature_id = ${id}`;
    await activateWorker('issue-effect-old', id);
    await activateWorker('issue-effect-current', id);
    expect((await wi.claimWorkItem(id, 'issue-effect-old', { harness: H }))?.assignee).toBe('issue-effect-old');
    await db.sql`UPDATE harness_shared.work_items SET taken_by = 'issue-effect-current' WHERE feature_id = ${id}`;
    const { setIssueState } = await import('./issues-engineer');

    await expect(setIssueState(id, 'resolved', 'issue-effect-old', 'stale result'))
      .rejects.toThrow('blueprint operation effect refused');
    expect((await wi.getWorkItem(id, H))?.state).toBe('open');
    await expect(setIssueState(id, 'resolved', 'issue-effect-current', 'current result'))
      .rejects.toThrow('blueprint operation completion requires validated outputPayload');
    expect((await wi.getWorkItem(id, H))?.state).toBe('open');
  });

  it('reports pinned claimability for the exact worker and refuses other previews', async () => {
    const id = 'WI-operation-preview';
    await seedFeature(id);
    await seedFeature('WI-ordinary-preview');
    await db.sql`UPDATE harness_shared.work_items SET payload = ${db.sql.json({ blueprintOperation: pin() })}
      WHERE feature_id = ${id}`;
    await activateWorker('preview-worker', id);

    expect((await wi.observeWorkItem(id, { harness: H, assignee: 'preview-worker' }))?.available).toBe(true);
    expect((await wi.observeWorkItem(id, { harness: H, assignee: 'ordinary-su' }))?.operationClaimDenied)
      .toContain('requires its applied worker');
    expect((await wi.observeWorkItem('WI-ordinary-preview', { harness: H, assignee: 'preview-worker' }))?.available)
      .toBe(false);
  });

  // R-8 / R-16 (plan blueprint-backed-work-item-execution-2026-09-23): the receipt match covers the
  // WHOLE accepted pin, not only its key fields. A pin that agrees with the applied receipt on kind,
  // harness, operation and revision but carries a different accepted input is a different operation:
  // the preview must name the mismatch, and the claim must refuse it (its UPDATE fences the pin too).
  it('refuses a pin that matches the receipt key fields but differs in its accepted input', async () => {
    const id = 'WI-operation-drifted-pin';
    await seedFeature(id);
    await db.sql`UPDATE harness_shared.work_items
      SET payload = ${db.sql.json({ blueprintOperation: { ...pin(), input: { drifted: true } } })}
      WHERE feature_id = ${id}`;
    await activateWorker('drift-worker', id);

    expect((await wi.observeWorkItem(id, { harness: H, assignee: 'drift-worker' }))?.operationClaimDenied)
      .toContain('differs from the applied operation receipt');
    expect(await wi.claimWorkItem(id, 'drift-worker', { harness: H })).toBeNull();
  });
});

describe('EI-22536788145490710: upgrade the installed issue claim guard', () => {
  const migration = '1138-issue-claim-expected-holder-cas.sql';
  let originalDefinition: string | undefined;

  async function definition() {
    const [row] = await db.sql<{ definition: string }[]>`
      SELECT pg_get_functiondef('harness_shared.engineer_issues_view_dml()'::regprocedure) AS definition`;
    return row.definition;
  }

  async function upgrade() {
    // Draft migrations are tested before being armed for live auto-apply.
    const path = existsSync(resolve(SQL_DIR, migration)) ? migration : `${migration}.DRAFT`;
    await db.sql.unsafe(readMigration(path)).simple();
  }

  async function forceClaim(id: string, target: string, expectedAssignee = 'dead-holder') {
    const issues = await import('./issues-engineer');
    return wi.claimWorkItem(id, target, {
      harness: H,
      expectedAssignee,
      forceTakeoverAdmission: issues.mintForceTakeoverAdmission({
        itemId: id, target, expectedAssignee, workspaceId: 'default',
      }),
    });
  }

  beforeEach(async () => {
    originalDefinition = await definition();
    // Match the deployed pre-1138 guard, not the already-repaired hand-written
    // fixture. This change is confined to this test's throwaway database.
    const legacy = originalDefinition.replace(/^\s*OR taken_by = OLD\.assignee\s*$/m, '');
    expect(legacy).not.toBe(originalDefinition);
    await db.sql.unsafe(legacy).simple();
  });

  afterEach(async () => {
    if (originalDefinition) await db.sql.unsafe(originalDefinition).simple();
  });

  it.each(['auto', 'pending'])('upgrades an authorized %s task transfer from refusal to a persisted claim', async (admission) => {
    const id = `WI-upgrade-${admission}`;
    await seedIssue(id, { kind: 'task', admission, takenBy: 'dead-holder' });

    // Negative control: the actual writer reaches the old trigger and loses.
    expect(await forceClaim(id, 'rescuer')).toBeNull();
    expect((await wi.getWorkItem(id, H))?.assignee).toBe('dead-holder');

    await upgrade();
    expect((await forceClaim(id, 'rescuer'))?.assignee).toBe('rescuer');
    const [stored] = await db.sql`
      SELECT taken_by, admission, status, item_kind FROM harness_shared.work_items WHERE feature_id = ${id}`;
    expect(stored).toEqual({ taken_by: 'rescuer', admission, status: 'open', item_kind: 'task' });
  });

  it('allows the holder to transfer its own claim without force', async () => {
    await seedIssue('WI-upgrade-self', { kind: 'task', admission: 'auto', takenBy: 'caller' });
    await upgrade();
    expect((await wi.claimWorkItem('WI-upgrade-self', 'successor', {
      harness: H, fromHolder: 'caller',
    }))?.assignee).toBe('successor');
  });

  it('admits exactly one competing transfer from the same expected holder', async () => {
    await seedIssue('WI-upgrade-race', { admission: 'auto', takenBy: 'dead-holder' });
    await upgrade();
    const results = await Promise.all([
      forceClaim('WI-upgrade-race', 'rescuer-a'),
      forceClaim('WI-upgrade-race', 'rescuer-b'),
    ]);
    const winners = results.filter((result) => result !== null);
    expect(winners).toHaveLength(1);
    expect((await wi.getWorkItem('WI-upgrade-race', H))?.assignee).toBe(winners[0]!.assignee);
  });

  it('preserves stale-holder, ordinary-claim, admission and foreign-origin refusals', async () => {
    await upgrade();
    await seedIssue('WI-upgrade-stale', { admission: 'auto', takenBy: 'intervening-holder' });
    expect(await forceClaim('WI-upgrade-stale', 'rescuer')).toBeNull();
    expect(await wi.claimWorkItem('WI-upgrade-stale', 'ordinary-caller', { harness: H })).toBeNull();
    expect((await wi.getWorkItem('WI-upgrade-stale', H))?.assignee).toBe('intervening-holder');

    await seedIssue('WI-upgrade-pending', { admission: 'pending' });
    expect(await wi.claimWorkItem('WI-upgrade-pending', 'ordinary-caller', { harness: H })).toBeNull();
    await seedIssue('WI-upgrade-foreign', { admission: 'auto', origin: 'remote', takenBy: 'dead-holder' });
    expect(await forceClaim('WI-upgrade-foreign', 'rescuer')).toBeNull();
    expect((await wi.getWorkItem('WI-upgrade-foreign', H))?.assignee).toBe('dead-holder');
  });

  it('keeps unclaimed issue races atomic after the upgrade', async () => {
    await seedIssue('WI-upgrade-unclaimed', { admission: 'auto' });
    await upgrade();
    const results = await Promise.all([
      wi.claimWorkItem('WI-upgrade-unclaimed', 'new-a', { harness: H }),
      wi.claimWorkItem('WI-upgrade-unclaimed', 'new-b', { harness: H }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('preserves all unrelated function clauses and is idempotent', async () => {
    const before = await definition();
    await upgrade();
    const after = await definition();
    expect(after.replace('\n        OR taken_by = OLD.assignee', '')).toBe(before);
    await upgrade();
    expect(await definition()).toBe(after);
  });

  it('fails closed when the installed guard no longer has the expected anchor', async () => {
    const changed = (await definition()).replace('OR taken_by = NEW.assignee', "OR taken_by = 'unexpected-guard'");
    await db.sql.unsafe(changed).simple();
    await expect(upgrade()).rejects.toThrow('expected exactly one current-assignee claim guard');
    expect(await definition()).toBe(changed);
  });
});

describe('work_items claim — atomic `in` (D-004, real PG)', () => {
  it('retries issue- and feature-family claim writes after transient PostgreSQL contention', async () => {
    await seedIssue('EI-contention-retry', { admission: 'auto' });
    await seedFeature('F-contention-retry', { admission: 'auto' });

    const originalSql = h.sql;
    const injectedFailures = { issue: 0, feature: 0 };
    const interceptSql = (client: typeof originalSql): typeof originalSql => new Proxy(client, {
      apply(target, thisArg, args) {
        const strings = args[0];
        const statement = Array.isArray(strings) ? strings.join('').replace(/\s+/g, ' ') : '';
        const family = statement.includes('UPDATE harness_shared.engineer_issues')
          ? 'issue'
          : statement.includes('UPDATE harness_shared.harness_features_consolidated')
            ? 'feature'
            : null;
        if (family && injectedFailures[family] === 0) {
          injectedFailures[family] += 1;
          throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
        }
        return Reflect.apply(target, thisArg, args);
      },
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== 'begin') return value;
        // Claim writes run on the transaction client supplied by boundedOrgTxn.
        // Intercept that client too, so both claim families actually encounter contention.
        return (...args: unknown[]) => {
          const callback = args.at(-1);
          if (typeof callback === 'function') {
            args[args.length - 1] = (transaction: postgres.TransactionSql) =>
              callback(interceptSql(transaction as unknown as typeof originalSql));
          }
          return Reflect.apply(value, target, args);
        };
      },
    });
    h.sql = interceptSql(originalSql);

    try {
      expect((await wi.claimWorkItem('EI-contention-retry', 'issue-agent', { harness: H }))?.assignee).toBe(
        'issue-agent',
      );
      expect((await wi.claimWorkItem('F-contention-retry', 'feature-agent', { harness: H }))?.assignee).toBe(
        'feature-agent',
      );
    } finally {
      h.sql = originalSql;
    }

    expect(injectedFailures).toEqual({ issue: 1, feature: 1 });
  });

  it('two competing claims on one item ⇒ exactly one wins', async () => {
    await seedFeature('F-1');
    const [a, b] = await Promise.all([
      wi.claimWorkItem('F-1', 'agA', { harness: H }),
      wi.claimWorkItem('F-1', 'agB', { harness: H }),
    ]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1); // NOT both — atomic, not last-write-wins
    const row = await db.sql<{ taken_by: string }[]>`SELECT taken_by FROM harness_shared.harness_features_consolidated WHERE feature_id='F-1'`;
    expect(['agA', 'agB']).toContain(row[0].taken_by);
    expect(winners[0]!.assignee).toBe(row[0].taken_by);
  });

  it('claiming an item already held by someone else returns null (claim lost)', async () => {
    await seedFeature('F-2', { takenBy: 'agA' });
    expect(await wi.claimWorkItem('F-2', 'agB', { harness: H })).toBeNull();
    const row = await db.sql<{ taken_by: string }[]>`SELECT taken_by FROM harness_shared.harness_features_consolidated WHERE feature_id='F-2'`;
    expect(row[0].taken_by).toBe('agA'); // unchanged
  });

  it('refuses a terminal feature claim by id without changing the taken_by attribution', async () => {
    await seedFeature('F-terminal-claim', { status: 'done', admission: 'auto' });
    expect(await wi.claimWorkItem('F-terminal-claim', 'agB', { harness: H })).toBeNull();
    const row = await db.sql<{ status: string; taken_by: string | null }[]>`
      SELECT status, taken_by FROM harness_shared.harness_features_consolidated WHERE feature_id='F-terminal-claim'`;
    expect(row[0]).toEqual({ status: 'done', taken_by: null });
  });

  it('re-claiming by the same assignee is idempotent', async () => {
    await seedFeature('F-3');
    expect((await wi.claimWorkItem('F-3', 'agA', { harness: H }))?.assignee).toBe('agA');
    expect((await wi.claimWorkItem('F-3', 'agA', { harness: H }))?.assignee).toBe('agA');
  });

  // bug-drain-200k (2026-07-21, EI-18218648001542437 / migration 655): the ISSUE-family
  // counterpart of "two competing claims ⇒ exactly one wins" above. Issue-family claim-by-id
  // goes through claimIssue() -> `UPDATE engineer_issues SET assignee=... WHERE assignee IS
  // NULL OR ...` — an updatable view backed by an INSTEAD OF trigger, NOT the direct
  // FOR-UPDATE-SKIP-LOCKED base-table path the feature family uses. Before migration 655 the
  // trigger's inner `UPDATE work_items SET taken_by=NEW.assignee ... WHERE (pk)=(...)` had NO
  // taken_by re-check, so two concurrent claimIssue() calls could both pass the outer view-
  // level check against their own pre-commit snapshot and the second one's unconditional inner
  // write silently overwrote the first claimant's already-committed win — a REAL, observed
  // duplicate-claim, not a theoretical one.
  describe('issue-family claim-by-id (claimIssue via the engineer_issues view) — same atomicity guarantee', () => {
    it('two competing claims on one issue ⇒ exactly one wins (migration 655 regression)', async () => {
      await seedIssue('EI-race-1');
      const [a, b] = await Promise.all([
        wi.claimWorkItem('EI-race-1', 'agA', { harness: H }),
        wi.claimWorkItem('EI-race-1', 'agB', { harness: H }),
      ]);
      const winners = [a, b].filter(Boolean);
      expect(winners).toHaveLength(1); // NOT both — pre-655 this could flake to 2
      const row = await db.sql<{ taken_by: string }[]>`SELECT taken_by FROM harness_shared.work_items WHERE feature_id='EI-race-1'`;
      expect(['agA', 'agB']).toContain(row[0].taken_by);
      expect(winners[0]!.assignee).toBe(row[0].taken_by);
    });

    it('claiming an issue already held by someone else returns null (claim lost)', async () => {
      await seedIssue('EI-race-2', { takenBy: 'agA' });
      expect(await wi.claimWorkItem('EI-race-2', 'agB', { harness: H })).toBeNull();
      const row = await db.sql<{ taken_by: string }[]>`SELECT taken_by FROM harness_shared.work_items WHERE feature_id='EI-race-2'`;
      expect(row[0].taken_by).toBe('agA'); // unchanged
    });

    it('re-claiming an issue by the same assignee is idempotent', async () => {
      await seedIssue('EI-race-3');
      expect((await wi.claimWorkItem('EI-race-3', 'agA', { harness: H }))?.assignee).toBe('agA');
      expect((await wi.claimWorkItem('EI-race-3', 'agA', { harness: H }))?.assignee).toBe('agA');
    });

    it('claims an admission-pending issue durably dispatched by the current fleet leader', async () => {
      await seedIssue('EI-leader-dispatch-pending', {
        admission: 'pending',
        assignedBy: 'su-leader',
      });
      leaderDispatchAdmission.resolveFleetScopeContext.mockResolvedValue({
        ownerId: 'su-member',
        fleetSlug: 'dispatch-fleet',
        fleetRole: 'member',
        workspaceId: 'default',
        record: { source: 'fleet' },
      });
      leaderDispatchAdmission.leaderDispatchedAdmission.mockResolvedValue(true);

      const claimed = await wi.claimWorkItem('EI-leader-dispatch-pending', 'su-member', { harness: H });

      expect(claimed?.assignee).toBe('su-member');
      const row = (await db.sql<{ taken_by: string | null; admission: string | null }[]>`
        SELECT taken_by, admission
          FROM harness_shared.work_items
         WHERE feature_id = 'EI-leader-dispatch-pending'`)[0];
      expect(row).toEqual({ taken_by: 'su-member', admission: 'pending' });
    });

    it('claims an admission-pending bug filed by the target member via a server-derived capability', async () => {
      await seedIssue('EI-self-filed-pending', {
        admission: 'pending',
        createdBy: 'su-member',
      });
      leaderDispatchAdmission.resolveFleetScopeContext.mockResolvedValue({
        ownerId: 'su-member',
        fleetSlug: 'dispatch-fleet',
        fleetRole: 'member',
        workspaceId: 'default',
        record: { source: 'fleet' },
      });
      leaderDispatchAdmission.selfFiledFalloutAdmission.mockReturnValue(true);

      const claimed = await wi.claimWorkItem('EI-self-filed-pending', 'su-member', { harness: H });

      expect(claimed?.assignee).toBe('su-member');
      const row = (await db.sql<{ taken_by: string | null; admission: string | null }[]>`
        SELECT taken_by, admission
          FROM harness_shared.work_items
         WHERE feature_id = 'EI-self-filed-pending'`)[0];
      expect(row).toEqual({ taken_by: 'su-member', admission: 'pending' });
    });

    it('EI-226378: claims an exact legacy fleet-scope downgrade row with the server-minted capability', async () => {
      const marker = {
        requestedAssignee: 'su-member',
        reportedBy: 'su-leader',
        fleet: 'dispatch-fleet',
        code: 'fleet_scope_violation',
        at: new Date().toISOString(),
      } as const;
      await seedIssue('EI-legacy-downgrade-pending', {
        admission: 'pending',
        createdBy: 'su-leader',
      });
      await db.sql`
        UPDATE harness_shared.work_items
           SET payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{fleetScopeDowngrade}', ${JSON.stringify(marker)}::text::jsonb)
         WHERE feature_id = 'EI-legacy-downgrade-pending'`;

      const capability = mintLegacyFleetScopeDowngradeAdmission({
        ...marker,
        itemId: 'EI-legacy-downgrade-pending',
        target: 'su-member',
        workspaceId: 'default',
        leaderOwnerId: 'su-leader',
      });
      const claimed = await wi.claimWorkItem('EI-legacy-downgrade-pending', 'su-member', {
        harness: H,
        legacyFleetScopeDowngradeAdmission: capability,
      });
      expect(claimed?.assignee).toBe('su-member');
      const row = (await db.sql<{ taken_by: string | null; admission: string | null }[]>`
        SELECT taken_by, admission
          FROM harness_shared.work_items
         WHERE feature_id = 'EI-legacy-downgrade-pending'`)[0];
      expect(row).toEqual({ taken_by: 'su-member', admission: 'pending' });
    });

    it.each([
      ['a copied capability object', () => ({
        itemId: 'EI-legacy-forged',
        target: 'su-member',
        workspaceId: 'default',
        leaderOwnerId: 'su-leader',
        requestedAssignee: 'su-member',
        reportedBy: 'su-leader',
        fleet: 'dispatch-fleet',
        code: 'fleet_scope_violation',
        at: new Date().toISOString(),
      })],
      ['a capability for another target', () => mintLegacyFleetScopeDowngradeAdmission({
        itemId: 'EI-legacy-forged',
        target: 'other-member',
        workspaceId: 'default',
        leaderOwnerId: 'su-leader',
        requestedAssignee: 'su-member',
        reportedBy: 'su-leader',
        fleet: 'dispatch-fleet',
        code: 'fleet_scope_violation',
        at: new Date().toISOString(),
      })],
    ])('EI-226378: rejects %s at the claim writer', async (_label, capabilityFactory) => {
      await seedIssue('EI-legacy-forged', { admission: 'pending', createdBy: 'su-leader' });
      const claimed = await wi.claimWorkItem('EI-legacy-forged', 'su-member', {
        harness: H,
        legacyFleetScopeDowngradeAdmission: capabilityFactory() as never,
      });

      expect(claimed).toBeNull();
      const row = (await db.sql<{ taken_by: string | null; admission: string | null }[]>`
        SELECT taken_by, admission
          FROM harness_shared.work_items
         WHERE feature_id = 'EI-legacy-forged'`)[0];
      expect(row).toEqual({ taken_by: null, admission: 'pending' });
    });

    it('keeps a pending bug filed by a peer refused without the self-filed capability', async () => {
      await seedIssue('EI-peer-filed-pending', {
        admission: 'pending',
        createdBy: 'su-peer',
      });
      leaderDispatchAdmission.resolveFleetScopeContext.mockResolvedValue({
        ownerId: 'su-member',
        fleetSlug: 'dispatch-fleet',
        fleetRole: 'member',
        workspaceId: 'default',
        record: { source: 'fleet' },
      });

      expect(await wi.claimWorkItem('EI-peer-filed-pending', 'su-member', { harness: H })).toBeNull();
      const row = (await db.sql<{ taken_by: string | null }[]>`
        SELECT taken_by FROM harness_shared.work_items WHERE feature_id = 'EI-peer-filed-pending'`)[0];
      expect(row.taken_by).toBeNull();
    });

    it('keeps a self-filed pending non-bug refused instead of widening by provenance alone', async () => {
      await seedIssue('EI-self-filed-change-pending', {
        kind: 'change',
        admission: 'pending',
        createdBy: 'su-member',
      });
      leaderDispatchAdmission.resolveFleetScopeContext.mockResolvedValue({
        ownerId: 'su-member',
        fleetSlug: 'dispatch-fleet',
        fleetRole: 'member',
        workspaceId: 'default',
        record: { source: 'fleet' },
      });

      expect(await wi.claimWorkItem('EI-self-filed-change-pending', 'su-member', { harness: H })).toBeNull();
      const row = (await db.sql<{ taken_by: string | null }[]>`
        SELECT taken_by FROM harness_shared.work_items WHERE feature_id = 'EI-self-filed-change-pending'`)[0];
      expect(row.taken_by).toBeNull();
    });

    it('keeps a self-filed pending bug refused while the target fleet is winding down', async () => {
      await seedIssue('EI-self-filed-paused', {
        admission: 'pending',
        createdBy: 'su-member',
      });
      leaderDispatchAdmission.resolveFleetScopeContext.mockResolvedValue({
        ownerId: 'su-member',
        fleetSlug: 'dispatch-fleet',
        fleetRole: 'member',
        workspaceId: 'default',
        record: { source: 'fleet' },
      });
      leaderDispatchAdmission.fleetControlWindDownRefusal.mockResolvedValue({
        allowed: false,
        scoped: true,
        code: 'fleet_winding_down',
        scope: {},
        reason: 'fleet winding down',
      });
      leaderDispatchAdmission.selfFiledFalloutAdmission.mockReturnValue(true);

      expect(await wi.claimWorkItem('EI-self-filed-paused', 'su-member', { harness: H })).toBeNull();
      const row = (await db.sql<{ taken_by: string | null }[]>`
        SELECT taken_by FROM harness_shared.work_items WHERE feature_id = 'EI-self-filed-paused'`)[0];
      expect(row.taken_by).toBeNull();
      expect(leaderDispatchAdmission.selfFiledFalloutAdmission).not.toHaveBeenCalled();
    });

    it('keeps an ordinary admission-pending issue refused without the leader capability', async () => {
      await seedIssue('EI-ordinary-pending', { admission: 'pending' });

      expect(await wi.claimWorkItem('EI-ordinary-pending', 'su-member', { harness: H })).toBeNull();
      const row = (await db.sql<{ taken_by: string | null }[]>`
        SELECT taken_by FROM harness_shared.work_items WHERE feature_id = 'EI-ordinary-pending'`)[0];
      expect(row.taken_by).toBeNull();
      expect(leaderDispatchAdmission.resolveFleetScopeContext).not.toHaveBeenCalled();
    });

    it('keeps a stale or foreign leader assignment refused', async () => {
      await seedIssue('EI-stale-leader-pending', {
        admission: 'pending',
        assignedBy: 'su-former-leader',
      });
      leaderDispatchAdmission.resolveFleetScopeContext.mockResolvedValue({
        ownerId: 'su-member',
        fleetSlug: 'dispatch-fleet',
        fleetRole: 'member',
        workspaceId: 'default',
        record: { source: 'fleet' },
      });
      leaderDispatchAdmission.leaderDispatchedAdmission.mockResolvedValue(false);

      expect(await wi.claimWorkItem('EI-stale-leader-pending', 'su-member', { harness: H })).toBeNull();
      const row = (await db.sql<{ taken_by: string | null }[]>`
        SELECT taken_by FROM harness_shared.work_items WHERE feature_id = 'EI-stale-leader-pending'`)[0];
      expect(row.taken_by).toBeNull();
    });

    it('keeps a pending issue refused while the target fleet is winding down', async () => {
      await seedIssue('EI-paused-leader-pending', {
        admission: 'pending',
        assignedBy: 'su-leader',
      });
      leaderDispatchAdmission.resolveFleetScopeContext.mockResolvedValue({
        ownerId: 'su-member',
        fleetSlug: 'dispatch-fleet',
        fleetRole: 'member',
        workspaceId: 'default',
        record: { source: 'fleet' },
      });
      leaderDispatchAdmission.fleetControlWindDownRefusal.mockResolvedValue({
        allowed: false,
        scoped: true,
        code: 'fleet_winding_down',
        scope: {},
        reason: 'fleet winding down',
      });
      leaderDispatchAdmission.leaderDispatchedAdmission.mockResolvedValue(true);

      expect(await wi.claimWorkItem('EI-paused-leader-pending', 'su-member', { harness: H })).toBeNull();
      expect(leaderDispatchAdmission.leaderDispatchedAdmission).not.toHaveBeenCalled();
    });

    it('keeps a pending issue refused when the target uses the default fleet spec', async () => {
      await seedIssue('EI-default-spec-pending', {
        admission: 'pending',
        assignedBy: 'su-leader',
      });
      leaderDispatchAdmission.resolveFleetScopeContext.mockResolvedValue({
        ownerId: 'su-member',
        fleetSlug: 'dispatch-fleet',
        fleetRole: 'member',
        workspaceId: 'default',
        record: { source: 'default' },
      });
      leaderDispatchAdmission.leaderDispatchedAdmission.mockResolvedValue(true);

      expect(await wi.claimWorkItem('EI-default-spec-pending', 'su-member', { harness: H })).toBeNull();
      expect(leaderDispatchAdmission.leaderDispatchedAdmission).not.toHaveBeenCalled();
    });

    it('does not let leader dispatch bypass the feature-family pending gate', async () => {
      await seedFeature('F-leader-dispatch-pending', { admission: 'pending' });

      expect(await wi.claimWorkItem('F-leader-dispatch-pending', 'su-member', { harness: H })).toBeNull();
      const row = (await db.sql<{ taken_by: string | null; admission: string | null }[]>`
        SELECT taken_by, admission
          FROM harness_shared.work_items
         WHERE feature_id = 'F-leader-dispatch-pending'`)[0];
      expect(row).toEqual({ taken_by: null, admission: 'pending' });
      expect(leaderDispatchAdmission.resolveFleetScopeContext).not.toHaveBeenCalled();
    });

    it('does not let leader dispatch bypass the remote-origin issue guard', async () => {
      await seedIssue('EI-remote-leader-pending', {
        admission: 'pending',
        assignedBy: 'su-leader',
        origin: 'remote',
      });
      leaderDispatchAdmission.resolveFleetScopeContext.mockResolvedValue({
        ownerId: 'su-member',
        fleetSlug: 'dispatch-fleet',
        fleetRole: 'member',
        workspaceId: 'default',
        record: { source: 'fleet' },
      });
      leaderDispatchAdmission.leaderDispatchedAdmission.mockResolvedValue(true);

      expect(await wi.claimWorkItem('EI-remote-leader-pending', 'su-member', { harness: H })).toBeNull();
      const row = (await db.sql<{ taken_by: string | null; origin: string | null }[]>`
        SELECT taken_by, origin
          FROM harness_shared.work_items
         WHERE feature_id = 'EI-remote-leader-pending'`)[0];
      expect(row).toEqual({ taken_by: null, origin: 'remote' });
    });

    it('rejects a caller-forged leader-dispatch capability', async () => {
      await seedIssue('EI-forged-leader-dispatch', {
        admission: 'pending',
        assignedBy: 'su-leader',
      });
      const issues = await import('./issues-engineer');
      const forged = {
        itemId: 'EI-forged-leader-dispatch',
        target: 'su-member',
        workspaceId: 'default',
        assignedBy: 'su-leader',
      };

      expect(
        await issues.claimIssue('EI-forged-leader-dispatch', 'su-member', {
          workspaceId: 'default',
          leaderDispatchAdmission: forged,
        }),
      ).toBeNull();
      const row = (await db.sql<{ taken_by: string | null }[]>`
        SELECT taken_by
          FROM harness_shared.work_items
         WHERE feature_id = 'EI-forged-leader-dispatch'`)[0];
      expect(row.taken_by).toBeNull();
    });

    // EI-22345414208647835: the force handler has already proved the dead holder
    // reclaimable. Its opaque capability carries that authorization to the core writer,
    // which may bypass ONLY the born-pending floor while retaining the exact holder CAS.
    it('EI-22345414208647835: an authorized force capability bypasses the admission-pending gate (issue-family)', async () => {
      await seedIssue('EI-dead-holder-pending', { admission: 'pending', takenBy: 'dead-holder' });
      const issues = await import('./issues-engineer');
      const forceTakeoverAdmission = issues.mintForceTakeoverAdmission({
        itemId: 'EI-dead-holder-pending',
        target: 'rescuer',
        expectedAssignee: 'dead-holder',
        workspaceId: 'default',
      });

      const claimed = await wi.claimWorkItem('EI-dead-holder-pending', 'rescuer', {
        harness: H,
        expectedAssignee: 'dead-holder',
        forceTakeoverAdmission,
      });

      expect(claimed?.assignee).toBe('rescuer');
      const row = (await db.sql<{ taken_by: string | null; admission: string | null }[]>`
        SELECT taken_by, admission FROM harness_shared.work_items WHERE feature_id = 'EI-dead-holder-pending'`)[0];
      expect(row).toEqual({ taken_by: 'rescuer', admission: 'pending' });
    });

    it('EI-22345414208647835: an authorized force capability bypasses the admission-pending gate (feature-family)', async () => {
      await seedFeature('F-dead-holder-pending', { admission: 'pending', takenBy: 'dead-holder' });
      const issues = await import('./issues-engineer');
      const forceTakeoverAdmission = issues.mintForceTakeoverAdmission({
        itemId: 'F-dead-holder-pending',
        target: 'rescuer',
        expectedAssignee: 'dead-holder',
        workspaceId: 'default',
      });

      const claimed = await wi.claimWorkItem('F-dead-holder-pending', 'rescuer', {
        harness: H,
        expectedAssignee: 'dead-holder',
        forceTakeoverAdmission,
      });

      expect(claimed?.assignee).toBe('rescuer');
      const row = (await db.sql<{ taken_by: string | null; admission: string | null }[]>`
        SELECT taken_by, admission
          FROM harness_shared.harness_features_consolidated
         WHERE feature_id = 'F-dead-holder-pending'`)[0];
      expect(row).toEqual({ taken_by: 'rescuer', admission: 'pending' });
    });

    it('rejects a forged or mismatched force capability and preserves the pending holder', async () => {
      await seedIssue('EI-forged-force-pending', { admission: 'pending', takenBy: 'dead-holder' });
      const forged = {
        itemId: 'EI-forged-force-pending',
        target: 'rescuer',
        expectedAssignee: 'dead-holder',
        workspaceId: 'default',
      };

      expect(
        await wi.claimWorkItem('EI-forged-force-pending', 'rescuer', {
          harness: H,
          expectedAssignee: 'dead-holder',
          forceTakeoverAdmission: forged,
        }),
      ).toBeNull();
      let row = (await db.sql<{ taken_by: string | null; admission: string | null }[]>`
        SELECT taken_by, admission FROM harness_shared.work_items WHERE feature_id = 'EI-forged-force-pending'`)[0];
      expect(row).toEqual({ taken_by: 'dead-holder', admission: 'pending' });

      const issues = await import('./issues-engineer');
      const valid = issues.mintForceTakeoverAdmission({ ...forged });
      expect(
        await wi.claimWorkItem('EI-forged-force-pending', 'rescuer', {
          harness: H,
          expectedAssignee: 'different-holder',
          forceTakeoverAdmission: valid,
        }),
      ).toBeNull();
      row = (await db.sql<{ taken_by: string | null; admission: string | null }[]>`
        SELECT taken_by, admission FROM harness_shared.work_items WHERE feature_id = 'EI-forged-force-pending'`)[0];
      expect(row).toEqual({ taken_by: 'dead-holder', admission: 'pending' });
    });

    it('caller can atomically transfer an issue-family claim to a named assignee', async () => {
      await seedIssue('EI-self-transfer', { takenBy: 'former-holder' });

      const claimed = await wi.claimWorkItem('EI-self-transfer', 'successor', {
        harness: H,
        fromHolder: 'former-holder',
      });

      expect(claimed?.assignee).toBe('successor');
      const row = await db.sql<{ taken_by: string | null }[]>`
        SELECT taken_by FROM harness_shared.work_items WHERE feature_id = 'EI-self-transfer'`;
      expect(row[0].taken_by).toBe('successor');
    });

    it('expected-holder transfer releases only the prior holder touch-set', async () => {
      const transferPath = 'packages/operator-core/lib/external-triggers/source-store.ts';
      await seedFeature('F-transfer-locks', { takenBy: 'former-holder' });
      await db.sql`
        UPDATE harness_shared.harness_features_consolidated
           SET payload = ${db.sql.json({ paths: [transferPath] })}
         WHERE feature_id = 'F-transfer-locks'`;

      const claimed = await wi.claimWorkItem('F-transfer-locks', 'successor', {
        harness: H,
        expectedAssignee: 'former-holder',
      });

      expect(claimed?.assignee).toBe('successor');
      expect(releaseReclaimedWorkItemLocks).toHaveBeenCalledWith({
        ownerId: 'former-holder',
        paths: [transferPath],
        goalRef: 'F-transfer-locks',
      });
    });

    it('releasing an issue (assignee -> null) still works under the new guard', async () => {
      await seedIssue('EI-race-4', { takenBy: 'agA' });
      const issues = await import('./issues-engineer');
      const released = await issues.releaseIssue('EI-race-4', { expectedAssignee: 'agA' });
      expect(released?.assignee ?? null).toBeNull();
      const row = await db.sql<{ taken_by: string | null }[]>`SELECT taken_by FROM harness_shared.work_items WHERE feature_id='EI-race-4'`;
      expect(row[0].taken_by).toBeNull();
    });
  });
});

describe('work_items claim_next — associative `in` + work-stealing (D-004/D-007, real PG)', () => {
  it('steals the OLDEST unclaimed item first', async () => {
    await seedFeature('F-old', { createdTs: 100 });
    await seedFeature('F-mid', { createdTs: 200 });
    await seedFeature('F-new', { createdTs: 300 });
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'w1' }))?.id).toBe('F-old');
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'w1' }))?.id).toBe('F-mid');
  });

  it('competing consumers (SKIP LOCKED) never double-claim', async () => {
    await seedFeature('F-a', { createdTs: 100 });
    await seedFeature('F-b', { createdTs: 200 });
    const [a, b] = await Promise.all([
      wi.claimNextWorkItem({ harness: H, assignee: 'w1' }),
      wi.claimNextWorkItem({ harness: H, assignee: 'w2' }),
    ]);
    const ids = [a?.id, b?.id].filter(Boolean).sort();
    expect(ids).toEqual(['F-a', 'F-b']); // two DISTINCT items, no overlap
  });

  it('returns null when nothing matches the template', async () => {
    await seedFeature('F-done', { status: 'done' });
    await seedFeature('F-taken', { takenBy: 'someone' });
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'w1' })).toBeNull();
  });

  it('respects the kind filter', async () => {
    await seedFeature('F-chunk', { kind: 'chunk', createdTs: 100 });
    await seedFeature('F-feat', { kind: 'feature', createdTs: 200 });
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'w1', kind: 'feature' }))?.id).toBe('F-feat');
  });

  // P-009 / D-022 point 2: there is no hardcoded chunk exclusion any more. chunk stays
  // nature work / audience agent; work_items:create rejects chunk and every real chunk row is
  // terminal (measured 2026-10-01: done 45, dropped 6, passed 12, none open), so the claim
  // floors exclude it. An OPEN chunk row is a row no writer can mint, so the fixture seeds the
  // historical chunk the way it actually exists: terminal.
  it('never self-selects a historical (terminal) chunk, even when it is the only row', async () => {
    await seedFeature('F-historical-chunk', { kind: 'chunk', status: 'done', createdTs: 100 });
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'w1' })).toBeNull();
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'w1', kind: 'chunk' })).toBeNull();
  });
});

describe('work_items observe — `rd` (D-004, real PG)', () => {
  it('reads claimability without taking', async () => {
    await seedFeature('F-x');
    const obs1 = await wi.observeWorkItem('F-x', { harness: H });
    expect(obs1).toMatchObject({ available: true, claimedBy: null });
    // observe did NOT claim it.
    expect((await db.sql<{ taken_by: string | null }[]>`SELECT taken_by FROM harness_shared.harness_features_consolidated WHERE feature_id='F-x'`)[0].taken_by).toBeNull();

    await wi.claimWorkItem('F-x', 'agA', { harness: H });
    const obs2 = await wi.observeWorkItem('F-x', { harness: H });
    expect(obs2).toMatchObject({ available: false, claimedBy: 'agA' });
    expect(await wi.observeWorkItem('F-missing', { harness: H })).toBeNull();
  });

  it('reports terminal rows as unavailable while an unclaimed open row remains available (WI-6554700010009219)', async () => {
    await seedIssue('WI-done-observe', { status: 'done' });
    await seedFeature('F-done-observe', { status: 'done' });
    await seedIssue('WI-open-observe', { status: 'open' });

    expect(await wi.observeWorkItem('WI-done-observe', { harness: H }))
      .toMatchObject({ available: false, claimedBy: null });
    expect(await wi.observeWorkItem('F-done-observe', { harness: H }))
      .toMatchObject({ available: false, claimedBy: null });
    expect(await wi.observeWorkItem('WI-open-observe', { harness: H }))
      .toMatchObject({ available: true, claimedBy: null });
  });

  // EI-7841: observe/list historically reported `available: true` for ANY unclaimed
  // row while the claim paths ADDITIONALLY enforce the G2 admission/trust gate
  // (autoPickableWhereSql) for feature-family items — so a remote, un-admitted item
  // looked claimable here and then bounced with `not_claimable` on the real claim.
  // observe must agree with what claim will actually do.
  it('reports available:false + gated:true for a remote, un-admitted item — matching the claim gate', async () => {
    await seedFeature('F-remote-pending', { origin: 'remote', auditVerdict: null });
    const obs = await wi.observeWorkItem('F-remote-pending', { harness: H });
    expect(obs).toMatchObject({ available: false, claimedBy: null, gated: true });
    // ...and the claim path genuinely refuses it too — observe's `available` isn't lying either way.
    expect(await wi.claimWorkItem('F-remote-pending', 'agA', { harness: H })).toBeNull();
  });

  it('reports available:true (no gated flag) for a remote item the auditor ADMITTED', async () => {
    await seedFeature('F-remote-admitted', { origin: 'remote', auditVerdict: 'admit' });
    const obs = await wi.observeWorkItem('F-remote-admitted', { harness: H });
    expect(obs).toMatchObject({ available: true, claimedBy: null });
    expect(obs?.gated).toBeUndefined();
    expect((await wi.claimWorkItem('F-remote-admitted', 'agA', { harness: H }))?.assignee).toBe('agA');
  });

  it('a HELD remote un-admitted item reports available:false with the real holder, not gated', async () => {
    // Once claimed (e.g. by a swarm-affine placement before the gate tightened, or
    // idempotent re-claim by its own holder), a gated item is reported via its
    // actual holder — `gated` only applies to the UNCLAIMED-but-refused case.
    await seedFeature('F-remote-held', { origin: 'remote', auditVerdict: null, takenBy: 'agB' });
    const obs = await wi.observeWorkItem('F-remote-held', { harness: H });
    expect(obs).toMatchObject({ available: false, claimedBy: 'agB' });
    expect(obs?.gated).toBeUndefined();
  });

  it('revalidates stored held admission and trust for dispatch without changing ordinary rd or ownership', async () => {
    await seedFeature('F-held-replay', { origin: 'remote', auditVerdict: 'admit', takenBy: 'agB' });
    const request = { harness: H, revalidateHeld: true };
    expect(await wi.observeWorkItem('F-held-replay', request)).toMatchObject({ available: false, claimedBy: 'agB' });
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET audit_verdict = 'reject' WHERE feature_id = 'F-held-replay'`;
    expect(await wi.observeWorkItem('F-held-replay', request)).toMatchObject({ gated: true, claimedBy: 'agB' });
    expect((await wi.observeWorkItem('F-held-replay', { harness: H }))?.gated).toBeUndefined();
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET audit_verdict = 'admit', admission = 'pending' WHERE feature_id = 'F-held-replay'`;
    expect(await wi.observeWorkItem('F-held-replay', request)).toMatchObject({ gated: true, claimedBy: 'agB', admissionPending: { reason: expect.any(String) } });
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET admission = 'admitted' WHERE feature_id = 'F-held-replay'`;
    const recovered = await wi.observeWorkItem('F-held-replay', request);
    expect(recovered).toMatchObject({ available: false, claimedBy: 'agB' });
    expect(recovered?.gated).toBeUndefined();
    expect((await wi.getWorkItem('F-held-replay', H))?.assignee).toBe('agB');
  });

  // EI-22122824405906276: the admission-pending (duplicate-screening) floor is the FIRST
  // gate observeWorkItem checks — and, before this fix, the ONLY gated:true case that
  // carried no distinguishing field whatsoever (unlike claim-hold/plan-lane, which already
  // named themselves). A caller — or coord:dispatch, which folds this straight into its
  // `admission_gated` skip reason — could not tell "wait, this clears on its own" from any
  // other permanent refusal without re-deriving the fix from work-items-admission.ts by hand.
  it('reports admissionPending {reason, remedy} for a duplicate-screening-pending item — distinct from the G2/trust gate', async () => {
    await seedFeature('F-admission-pending', { admission: 'pending' });
    const obs = await wi.observeWorkItem('F-admission-pending', { harness: H });
    expect(obs).toMatchObject({ available: false, claimedBy: null, gated: true });
    expect(obs?.admissionPending?.reason).toMatch(/CLEARS ON ITS OWN/);
    expect(obs?.admissionPending?.remedy).toContain('assign_to');
    // The claim path genuinely refuses it too, for the same reason.
    expect(await wi.claimWorkItem('F-admission-pending', 'agA', { harness: H })).toBeNull();
  });

  it('an admitted (non-pending) item never carries admissionPending', async () => {
    await seedFeature('F-admitted-plain', { admission: 'unreviewed' });
    const obs = await wi.observeWorkItem('F-admitted-plain', { harness: H });
    expect(obs).toMatchObject({ available: true, claimedBy: null });
    expect(obs?.admissionPending).toBeUndefined();
  });

  it('the G2/trust gate (remote, un-admitted) reports gated:true WITHOUT admissionPending — a different floor', async () => {
    // Distinguishes the two `gated:true` populations: this one is a property of the ROW
    // (origin/trust), not a temporal duplicate-screening wait, so it must not carry the
    // "clears on its own" explanation — that would be actively misleading here.
    await seedFeature('F-remote-pending-vs-trust', { origin: 'remote', auditVerdict: null });
    const obs = await wi.observeWorkItem('F-remote-pending-vs-trust', { harness: H });
    expect(obs).toMatchObject({ available: false, claimedBy: null, gated: true });
    expect(obs?.admissionPending).toBeUndefined();
  });
});

describe('work_items:list admissibleOnly — claimable selector matches the claim gate (EI-7841)', () => {
  it('excludes a remote un-admitted item only when admissibleOnly is passed; default lists everything', async () => {
    await seedFeature('F-local', { origin: 'local' });
    await seedFeature('F-remote-gated', { origin: 'remote', auditVerdict: null });
    await seedFeature('F-remote-admitted', { origin: 'remote', auditVerdict: 'admit' });

    const full = await wi.listWorkItems({ harness: H, state: 'open' });
    expect(full.map((r) => r.id).sort()).toEqual(['F-local', 'F-remote-admitted', 'F-remote-gated']);

    const admissibleOnly = await wi.listWorkItems({ harness: H, state: 'open', admissibleOnly: true });
    expect(admissibleOnly.map((r) => r.id).sort()).toEqual(['F-local', 'F-remote-admitted']);
  });
});

// WI-3649: the issue-family (bug/change/task) counterpart of the EI-7833/EI-7841 gates
// above. A federated (origin='remote') issue-family row is owned EXCLUSIVELY by its
// authoring peer's core (engineer_issues_view_dml's remote-skip guard, migration 521) —
// there is NO trust-list escape hatch like the feature family's autoPickableWhereSql, so
// `isIssueLocallyClaimable` is a flat origin check. Three surfaces must all agree with
// what the real claim path (claimWorkItem → the view trigger) will actually do.
describe('issue-family (bug/change/task) remote-origin gate — the EI-7841 class, issue-family half (WI-3649)', () => {
  it('observeWorkItem reports available:false + gated:true for a remote issue-family item — matching the claim gate', async () => {
    await seedIssue('WI-remote-bug', { origin: 'remote' });
    const obs = await wi.observeWorkItem('WI-remote-bug', { harness: H });
    expect(obs).toMatchObject({ available: false, claimedBy: null, gated: true });
    // ...and the claim path genuinely refuses it too (the view trigger's remote-skip guard).
    expect(await wi.claimWorkItem('WI-remote-bug', 'agA', { harness: H })).toBeNull();
  });

  it('observeWorkItem reports available:true (no gated flag) for a local issue-family item', async () => {
    await seedIssue('WI-local-bug', { origin: 'local' });
    const obs = await wi.observeWorkItem('WI-local-bug', { harness: H });
    expect(obs).toMatchObject({ available: true, claimedBy: null });
    expect(obs?.gated).toBeUndefined();
    expect((await wi.claimWorkItem('WI-local-bug', 'agA', { harness: H }))?.assignee).toBe('agA');
  });

  it('a HELD remote issue-family item reports available:false with the real holder, not gated', async () => {
    await seedIssue('WI-remote-held', { origin: 'remote', takenBy: 'agB' });
    const obs = await wi.observeWorkItem('WI-remote-held', { harness: H });
    expect(obs).toMatchObject({ available: false, claimedBy: 'agB' });
    expect(obs?.gated).toBeUndefined();
  });

  it('revalidates held issue origin and duplicate admission from persisted rows', async () => {
    await seedIssue('WI-held-peer', { origin: 'remote', takenBy: 'agB' });
    expect(await wi.observeWorkItem('WI-held-peer', { harness: H, revalidateHeld: true }))
      .toMatchObject({ available: false, claimedBy: 'agB', gated: true });
    await seedIssue('WI-held-pending', { admission: 'pending', takenBy: 'agB' });
    expect(await wi.observeWorkItem('WI-held-pending', { harness: H, revalidateHeld: true }))
      .toMatchObject({ available: false, claimedBy: 'agB', gated: true, admissionPending: { reason: expect.any(String) } });
    expect((await wi.getWorkItem('WI-held-peer', H))?.assignee).toBe('agB');
    expect((await wi.getWorkItem('WI-held-pending', H))?.assignee).toBe('agB');
  });

  it('work_items:list admissibleOnly excludes a remote issue-family row only when passed; default lists everything', async () => {
    await seedIssue('WI-local', { origin: 'local' });
    await seedIssue('WI-remote', { origin: 'remote' });

    const full = await wi.listWorkItems({ harness: H, kind: 'bug', state: 'open' });
    expect(full.map((r) => r.id).sort()).toEqual(['WI-local', 'WI-remote']);

    const admissibleOnly = await wi.listWorkItems({ harness: H, kind: 'bug', state: 'open', admissibleOnly: true });
    expect(admissibleOnly.map((r) => r.id)).toEqual(['WI-local']);
  });

  it('claimNextIssueWorkItem (the claim_next/scheduler:get_next self-select) never claims a remote-origin row', async () => {
    await seedIssue('WI-remote-only', { origin: 'remote', createdTs: 100, status: 'open' });
    // Nothing else eligible — a remote-origin-only pool must report a genuine miss,
    // NOT silently succeed by writing taken_by on the federation-owned row (the WI-3649
    // bug: this UPDATE writes harness_shared.work_items directly, bypassing the view
    // trigger's EI-7833 remote-skip guard entirely).
    expect(await wi.claimNextIssueWorkItem({ harness: H, assignee: 'w1' }, 'default')).toBeNull();
    const row = (await db.sql`SELECT taken_by FROM harness_shared.work_items WHERE feature_id='WI-remote-only'`)[0];
    expect(row.taken_by).toBeNull();
  });

  it('claimNextIssueWorkItem skips a remote row and claims the local one behind it', async () => {
    await seedIssue('WI-remote-first', { origin: 'remote', createdTs: 100, status: 'open' });
    await seedIssue('WI-local-second', { origin: 'local', createdTs: 200, status: 'open' });
    const claimed = await wi.claimNextIssueWorkItem({ harness: H, assignee: 'w1' }, 'default');
    expect(claimed?.id).toBe('WI-local-second');
    const remoteRow = (await db.sql`SELECT taken_by FROM harness_shared.work_items WHERE feature_id='WI-remote-first'`)[0];
    expect(remoteRow.taken_by).toBeNull();
  });

  // work-item-status-full-unify (owner 2026-07-20 root-cause): the own-node leg of the
  // issue-family claim floor. A bug THIS box authored, once it round-trips the hyperbee
  // federation, comes back projected origin='remote'; when the box's substrate identity drifts
  // (re-provision / device re-key / hive re-join) that self-authored work would be permanently
  // stranded as un-claimable by the flat origin check above. isIssueLocallyClaimableWhereSql
  // admits a remote row whose author_pubkey is one this workspace has ALSO written locally
  // (evidence OUR substrate log produced it) — while a true-peer remote row stays owned by its
  // authoring core. This is the POSITIVE counterpart of the remote-skip tests above.
  it('claimNextIssueWorkItem CLAIMS a self-authored remote issue (own-node round-trip) but never a true-peer remote', async () => {
    // Enroll pk-self as one of OUR own substrate author keys via a row the box authored
    // locally. Own-key derivation reads the work_items BASE across ALL statuses/families, so a
    // DONE local issue is sufficient enrollment (it is itself un-claimable — status is terminal).
    await seedIssue('WI-own-enroll', { origin: 'local', status: 'done', authorPubkey: 'pk-self', createdTs: 50 });
    // A self-authored issue that round-tripped federation: origin='remote' but OUR author key.
    await seedIssue('WI-self-roundtrip', { origin: 'remote', status: 'open', authorPubkey: 'pk-self', createdTs: 100 });
    // A genuine peer-authored remote row (foreign key) — owned by its authoring core forever.
    await seedIssue('WI-peer-remote', { origin: 'remote', status: 'open', authorPubkey: 'pk-foreign', createdTs: 200 });

    // The own-node round-trip IS self-selectable; nothing else open is claimable, so it wins.
    const claimed = await wi.claimNextIssueWorkItem({ harness: H, assignee: 'w1' }, 'default');
    expect(claimed?.id).toBe('WI-self-roundtrip');
    const selfRow = (await db.sql`SELECT taken_by FROM harness_shared.work_items WHERE feature_id='WI-self-roundtrip'`)[0];
    expect(selfRow.taken_by).toBe('w1');

    // The foreign remote stays untouched, and a second self-select finds nothing else claimable
    // (only the terminal enroll row + the un-claimable peer remote remain).
    expect(await wi.claimNextIssueWorkItem({ harness: H, assignee: 'w1' }, 'default')).toBeNull();
    const peerRow = (await db.sql`SELECT taken_by FROM harness_shared.work_items WHERE feature_id='WI-peer-remote'`)[0];
    expect(peerRow.taken_by).toBeNull();
  });

  // EI-19340398119001086 (WI-7096 follow-up): observeWorkItem's own-node awareness.
  // Migration 728 gave the by-id claim DB trigger (engineer_issues_view_dml) the same
  // own-node leg claimNextIssueWorkItem already had (test above) — but observeWorkItem
  // (used by work_items:observe and folded into work_items:get) still called the flat,
  // own-node-UNAWARE isIssueLocallyClaimable(origin) predicate, so it kept reporting
  // available:false/gated:true for a row THIS workspace authored that merely
  // round-tripped federation, even after the real claim would succeed. This pins the
  // diagnostic against the SAME own-node fixture the self-select test above uses.
  it('observeWorkItem reports available:true for a self-authored remote issue (own-node round-trip), still gated for a true peer remote', async () => {
    await seedIssue('WI-own-enroll-2', { origin: 'local', status: 'done', authorPubkey: 'pk-self', createdTs: 50 });
    await seedIssue('WI-self-roundtrip-2', { origin: 'remote', status: 'open', authorPubkey: 'pk-self', createdTs: 100 });
    await seedIssue('WI-peer-remote-2', { origin: 'remote', status: 'open', authorPubkey: 'pk-foreign', createdTs: 200 });

    const own = await wi.observeWorkItem('WI-self-roundtrip-2', { harness: H });
    expect(own).toMatchObject({ available: true, claimedBy: null });
    expect(own?.gated).toBeUndefined();

    const peer = await wi.observeWorkItem('WI-peer-remote-2', { harness: H });
    expect(peer).toMatchObject({ available: false, claimedBy: null, gated: true });
  });
});

// work-item-status-full-unify (P-008, WI-5627): the WHOLE POINT of the status
// collapse — a single unified claimable token ('open') spans BOTH families, so ONE
// unqualified claim spec (no `kind` narrowing) drains a feature AND a bug that both
// read 'open'. Pre-unification, features used 'todo' and issues used 'open', so a
// claimer that floored on one vocabulary silently skipped the other family. These
// tests are the regression guard for that (claim floor ['open'] — work-items.ts:3224),
// plus the terminal_reason mapping that keeps the collapse loss-free + reversible.
describe('unified status vocab — one open token, both families claimable (P-008)', () => {
  // claimNextWorkItem's tier-3 issue-family fall-through is gated behind
  // SCHEDULER_ISSUES_CLAIMABLE (default-ON in prod; pin it so the fresh-DB flag store
  // can't leave the issue tier inert and mask a real cross-family regression).
  beforeEach(() => setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true }));
  afterEach(() => setFlagOverridesForTest({}));

  it('ONE unqualified claim spec drains BOTH a feature and a bug that both read `open`', async () => {
    // A feature (harness_features_consolidated leg) and a bug (issue leg) — DIFFERENT
    // families, SAME 'open' status. Older created_ts wins first (oldest-first, D-007).
    await seedFeature('F-open-feat', { status: 'open', createdTs: 100 });
    await seedIssue('WI-open-bug', { kind: 'bug', status: 'open', createdTs: 200 });

    // No `kind` filter ⇒ the unqualified spec. Two claims drain the whole pool.
    const first = await wi.claimNextWorkItem({ harness: H, assignee: 'w1' });
    const second = await wi.claimNextWorkItem({ harness: H, assignee: 'w1' });

    // BOTH ids drained by ONE unqualified spec — proves the single 'open' token spans
    // both families (the unification's headline behaviour).
    const ids = [first?.id, second?.id].sort();
    expect(ids).toEqual(['F-open-feat', 'WI-open-bug']);
    // …and BOTH families were actually crossed (not two rows of one family).
    const families = [first?.family, second?.family].sort();
    expect(families).toEqual(['feature', 'issue']);
    // The pool is now genuinely drained.
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'w1' })).toBeNull();
  });

  it('terminal_reason preserves the pre-unification spelling across the fold (loss-free)', async () => {
    async function reasonOf(id: string) {
      const r = (await db.sql<{ status: string; terminal_reason: string | null }[]>`
        SELECT status, terminal_reason FROM harness_shared.work_items WHERE feature_id = ${id}`)[0];
      return r;
    }

    // Issue-family legacy terminals: resolved→done, closed→dropped — reason = raw spelling.
    await seedIssue('WI-resolved', { kind: 'bug', status: 'open' });
    await wi.setWorkItemState('WI-resolved', 'resolved', { by: 'agA', completionRef: 'fixed it' });
    expect(await reasonOf('WI-resolved')).toEqual({ status: 'done', terminal_reason: 'resolved' });

    await seedIssue('WI-closed', { kind: 'bug', status: 'open' });
    await wi.setWorkItemState('WI-closed', 'closed', { by: 'agA', completionRef: 'wont fix' });
    expect(await reasonOf('WI-closed')).toEqual({ status: 'dropped', terminal_reason: 'closed' });

    // Feature-family legacy terminals: passed→done, deprecated→dropped.
    await seedFeature('F-passed', { kind: 'feature', status: 'open' });
    await wi.setWorkItemState('F-passed', 'passed', { by: 'agA', completionRef: 'shipped' });
    expect(await reasonOf('F-passed')).toEqual({ status: 'done', terminal_reason: 'passed' });

    await seedFeature('F-deprecated', { kind: 'feature', status: 'open' });
    await wi.setWorkItemState('F-deprecated', 'deprecated', { by: 'agA', completionRef: 'cut' });
    expect(await reasonOf('F-deprecated')).toEqual({ status: 'dropped', terminal_reason: 'deprecated' });

    // A PLAIN unified terminal carries no legacy nuance ⇒ terminal_reason stays NULL.
    await seedIssue('WI-plain-done', { kind: 'bug', status: 'open' });
    await wi.setWorkItemState('WI-plain-done', 'done', { by: 'agA', completionRef: 'done' });
    expect(await reasonOf('WI-plain-done')).toEqual({ status: 'done', terminal_reason: null });
  });
});

describe('P-009 / D-024: the by-id claim refuses rows that are not agent work by category (real PG)', () => {
  // The fixture has no stamping trigger (production's D-018 trigger derives nature/audience
  // from datatype_registry), so each row's category is set directly on the base table.
  async function seedCategory(id: string, kind: string, nature: string, audience: string | null) {
    await seedFeature(id, { kind });
    await db.sql`
      UPDATE harness_shared.work_items SET nature = ${nature}, audience = ${audience}
       WHERE harness_slug = ${H} AND feature_id = ${id}`;
  }

  it('refuses a work/human row and a record row by id, and still claims agent work', async () => {
    await seedCategory('F-cat-edp', 'email-draft-proposal', 'work', 'human');
    await seedCategory('F-cat-record', 'bet', 'record', null);
    await seedFeature('F-cat-agent');

    expect(await wi.claimWorkItem('F-cat-edp', 'agA', { harness: H })).toBeNull();
    expect(await wi.claimWorkItem('F-cat-record', 'agA', { harness: H })).toBeNull();
    expect((await wi.claimWorkItem('F-cat-agent', 'agA', { harness: H }))?.assignee).toBe('agA');

    const held = await db.sql<{ feature_id: string; taken_by: string | null }[]>`
      SELECT feature_id, taken_by FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${H} AND feature_id IN ('F-cat-edp', 'F-cat-record', 'F-cat-agent')
       ORDER BY feature_id`;
    expect(held.map((r) => [r.feature_id, r.taken_by])).toEqual([
      ['F-cat-agent', 'agA'],
      ['F-cat-edp', null],
      ['F-cat-record', null],
    ]);

    // The diagnostic claim.ts uses to name the refusal agrees with the gate that refused it.
    expect(await wi.readNonAgentWorkCategory('F-cat-edp', H)).toEqual({ nature: 'work', audience: 'human' });
    expect(await wi.readNonAgentWorkCategory('F-cat-record', H)).toEqual({ nature: 'record', audience: null });
    expect(await wi.readNonAgentWorkCategory('F-cat-agent', H)).toBeNull();
  });
});
