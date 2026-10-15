/**
 * trust-admission-e2e.integration.test.ts — Brief A5 (Phase 5) of
 * shared-hive-trust-admission-2026-06-14: the THREE-TIER admission flow proven
 * end-to-end as a SYSTEM, against real Postgres.
 *
 * Unlike work-items-admission.integration.test.ts (which pins the gate predicate
 * by setting audit_verdict DIRECTLY), this drives the REAL pieces together:
 *   - the G2 gate            — work-items-admission via the real claimNextWorkItem /
 *                              claimWorkItem / isWorkItemAutoPickable claim paths;
 *   - the REAL auditor lane   — @papercusp/orchestrator `dispatchAuditorLane`, with a
 *                              FAKE auditor agent injected through its `spawnAuditor`
 *                              seam (the ONLY fake — exactly how the composition rig
 *                              fakes the LLM); the lane's verdict→audit_verdict write
 *                              and reject→escalation are real;
 *   - the REAL verified-author producer — the harness-features projection stamp
 *                              (resolveVerifiedAuthorGithubId over pot_members);
 *   - the REAL owner trust store — trust/user-trust-list addTrustedUser /
 *                              removeTrustedUser (the `trust:add` / `trust:remove` tools).
 *
 * The three owner-directed legs (A5):
 *   (a) UNTRUSTED remote → quarantined → auditor ADMIT → auto-runs (claimable);
 *       + the reject sub-leg: auditor REJECT → escalation raised + stays quarantined.
 *   (b) TRUSTED remote (verified author in the owner trust list) → auto-runs WITHOUT
 *       the auditor: claimable while STILL in the auditor's pending set + audit_verdict
 *       still NULL — the trust leg admits it with no verdict needed.
 *   (c) REVOKE trust (trust:remove) → the SAME item is back to screening (un-claimable).
 *
 * PREREQ — the lane is LIVE (confirmed in code, not just defaulted): the auditor lane
 * runs on the real system because PAPERCUSP_DBOS_ORCHESTRATOR is default-ON
 * (dbos-flags.ts isDbosOrchestratorEnabled = `env.PAPERCUSP_DBOS_ORCHESTRATOR !== '0'`),
 * orchestrator-loop.ts calls dispatchAuditorLane as a pre-pick pass each tick, and
 * wireAuditorLane (orchestrator-runner.ts) injects the real spawnInvokeOnce('auditor')
 * + openEscalation. So screened-foreign genuinely resolves — it is NOT silently-never-run.
 *
 * Gated on Docker like the other *-integration tests (real testcontainer PG).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL, applyClaimPathReadDeps } from '../test/_work-items-schema';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { CLAIM_STATES_ALLOWLIST } from './scheduler/claim-states';
import type { HarnessFeatureRow } from './sync/hyperbee/projections/harness-features';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const { claimNextWorkItem, claimWorkItem } = await import('./work-items');
const { isWorkItemAutoPickable } = await import('./work-items-admission');
const { addTrustedUser, removeTrustedUser } = await import('./trust/user-trust-list');
const { buildHarnessFeaturesProjection } = await import('./sync/hyperbee/projections/harness-features');
const { dispatchAuditorLane, selectRemotePendingFeatures } = await import('@papercusp/orchestrator');

const WS = 'default';
const HARNESS = 'h1';

const HFC_DDL = HARNESS_FEATURES_CONSOLIDATED_DDL;

// The verified-author producer source (pot_members, migration 185): a member's
// attested devices + revoked blocklist + binding_status. resolveVerifiedAuthorGithubId
// returns github_user_id ONLY for a verified, non-revoked, attested pubkey.
const HIVE_MEMBERS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.pot_members (
    workspace_id text NOT NULL,
    pot_home_slug text NOT NULL,
    github_user_id bigint NOT NULL,
    github_username text NOT NULL,
    display_name text, avatar_url text,
    device_attestations jsonb,
    revoked_pubkeys text[],
    binding_status text NOT NULL DEFAULT 'unverified',
    joined_at bigint,
    PRIMARY KEY (workspace_id, pot_home_slug, github_user_id))`;

// The owner-keyed LOCAL trust list the admission predicate consults (P-009) —
// The trust list (USER_TRUST_LIST_DDL) arrives via applyClaimPathReadDeps from ../test/_work-items-schema.

// addTrustedUser / removeTrustedUser append a security-grant audit row (fail-safe,
// but the table must exist or it console.warns → vitest-fail-on-console.
const AUDIT_LOG_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.audit_log (
    id text PRIMARY KEY,
    ts bigint, actor text, action text, subject text,
    details jsonb, workspace_id text)`;

// getWorkItem (called by claimWorkItem) probes getIssue FIRST for every id, so the
// table must exist. Left EMPTY → the lookup falls through to the feature row.
const ISSUES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.engineer_issues (
    workspace_id text NOT NULL DEFAULT 'default',
    issue_id text NOT NULL,
    kind text, scope text, title text, body text, severity text, source text, state text,
    assignee text, assigned_by text, assigned_at timestamptz, payload jsonb,
    found_during text, linked_feature_id text, created_by text, signal_origin text,
    assignee_rank integer, rank_writer text, rank_updated_at timestamptz,
    created_at timestamptz, updated_at timestamptz,
    PRIMARY KEY (workspace_id, issue_id))`;

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('trust-admission-e2e');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  h.sql = db.sql;
  await db.sql.unsafe(HFC_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple(); // claim path's P-005 readiness clause reads work_item_deps
  await db.sql.unsafe(HIVE_MEMBERS_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(AUDIT_LOG_DDL);
  await db.sql.unsafe(ISSUES_DDL);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.harness_features_consolidated`;
  await db.sql`DELETE FROM harness_shared.pot_members`;
  await db.sql`DELETE FROM harness_shared.user_trust_list`;
  await db.sql`DELETE FROM harness_shared.audit_log`;
});

/**
 * The status a fixture row must carry to be visible to the claim floors.
 *
 * work-item-status-full-unify (2026-07-19, commit 5c112e51) made `open` the single
 * unified claimable token; the feature-family `todo` was retired. A row written at
 * 'todo' is invisible to `claimNextWorkItem` REGARDLESS of admission, which in this
 * file is especially treacherous: the quarantine assertions here are all
 * `toBeNull()`, and an unclaimable-by-STATUS row is indistinguishable from a
 * correctly-quarantined one — so those legs kept passing VACUOUSLY while leg (a),
 * the one that asserts a successful claim, failed as `expected undefined to be
 * 'F-FOREIGN'`.
 *
 * Derived from the production allowlist, never hardcoded — see the guard test below.
 */
const CLAIMABLE_STATUS = 'open';

/** A remote, un-screened (audit_verdict NULL, no verified author) claimable-status feature — the foreign work the gate quarantines. */
function insRemotePending(fid: string, ts = 1) {
  return h.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin, audit_verdict, created_ts, updated_ts)
    VALUES (${WS}, ${HARNESS}, ${fid}, ${fid}, ${CLAIMABLE_STATUS}, 'feature', 'remote', NULL, ${ts}, ${ts})`;
}

/** Seed a pot_members admission row — `pubkeys` become device_attestations; `binding` is the binding_status. */
function seedMember(githubId: number, pubkeys: string[], binding: 'verified' | 'pending' | 'unverified', hive = 'hive-a') {
  const attestations = pubkeys.map((pk, i) => ({
    device_pubkey: pk, gist_id: `g${i}`, gist_url: 'u', device_label: 'd', created_at: 1, signature_by_device: 's',
  }));
  return h.sql`
    INSERT INTO harness_shared.pot_members
      (workspace_id, pot_home_slug, github_user_id, github_username, device_attestations, revoked_pubkeys, binding_status, joined_at)
    VALUES (${WS}, ${hive}, ${githubId}, ${'user' + githubId}, ${JSON.stringify(attestations)}::text::jsonb, ${[]}, ${binding}, 1)`;
}

/** A minimal valid HarnessFeatureRow for driving the projection's writeToPg (the producer path). */
function featureRow(fid: string): HarnessFeatureRow {
  return {
    harness_slug: HARNESS, feature_id: fid, title: fid, summary: '', status: 'todo', attempts: 0, claims: 0,
    notes: null, metadata: null, kind: null, project_id: null, expected_cost_cents: null, tags: null,
    needs_human_review: false, ts: 1, created_ts: 1, updated_ts: 1, parent_id: null, goal_id: null,
    taken_by: null, taken_at: null, expires_at: null, item_kind: 'feature', feature_order: null,
    swarm_affinity: null, redundancy: null, payload: null,
  } as unknown as HarnessFeatureRow;
}

const proj = () => buildHarnessFeaturesProjection({ workspaceId: WS, harnessSlug: HARNESS, sql: h.sql });

async function auditVerdictCol(fid: string): Promise<string | null> {
  const rows = await h.sql<{ v: string | null }[]>`
    SELECT audit_verdict AS v FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${HARNESS} AND feature_id = ${fid}`;
  return rows[0]?.v ?? null;
}

/** dispatchAuditorLane / selectRemotePendingFeatures want OrchestratorPg (not exported by
 *  name); the test's postgres.Sql is structurally compatible — derive the param type for tsc. */
const opg = (): Parameters<typeof selectRemotePendingFeatures>[0] =>
  h.sql as unknown as Parameters<typeof selectRemotePendingFeatures>[0];

/** Drive ONE real auditor-lane pass with an injected fake auditor agent (no CLI). */
function runAuditorLane(verdict: 'admit' | 'reject', reasons = '') {
  const spawnAuditor = vi.fn(async () => ({ verdict, reasons }));
  const createEscalation = vi.fn(async () => {});
  return dispatchAuditorLane({ pg: opg(), workspaceId: WS, spawnAuditor, createEscalation, log: () => {} }, HARNESS).then(
    (res) => ({ res, spawnAuditor, createEscalation }),
  );
}

describe('Brief A5 — three-tier admission flow end-to-end (real PG)', () => {
  // RECURRENCE GUARD (status-vocabulary drift — the 2026-07-19 unify broke this file).
  // Critical HERE because most quarantine assertions below are `toBeNull()`: if the
  // fixture status stops being claimable they keep passing for the WRONG REASON, and the
  // suite reports a green admission gate that is really testing nothing. Assert the
  // coupling directly so the next vocabulary change fails here, naming itself.
  it('fixture status is a token the claim floors accept (guards status-vocabulary drift)', () => {
    expect(CLAIM_STATES_ALLOWLIST).toContain(CLAIMABLE_STATUS);
  });

  it('(a) UNTRUSTED remote → quarantined → auditor ADMIT → auto-runs', async () => {
    await insRemotePending('F-FOREIGN');

    // Quarantined: the gate refuses un-screened foreign work.
    expect(await claimNextWorkItem({ harness: HARNESS, assignee: 'bee0' })).toBeNull();

    // The REAL auditor lane screens it; the fake auditor admits.
    const { res, spawnAuditor, createEscalation } = await runAuditorLane('admit', 'reviewed — safe');
    expect(res.admitted).toEqual(['F-FOREIGN']);
    expect(res.rejected).toEqual([]);
    expect(spawnAuditor).toHaveBeenCalledTimes(1); // the auditor WAS spawned for foreign work
    expect(createEscalation).not.toHaveBeenCalled();
    expect(await auditVerdictCol('F-FOREIGN')).toBe('admit'); // verdict written

    // Now it auto-runs (claimable).
    const wi = await claimNextWorkItem({ harness: HARNESS, assignee: 'bee1' });
    expect(wi?.id).toBe('F-FOREIGN');
  });

  it('(a-reject) auditor REJECT → escalation raised + stays quarantined', async () => {
    await insRemotePending('F-BADACTOR');

    const { res, createEscalation } = await runAuditorLane('reject', 'exfiltration risk');
    expect(res.rejected).toEqual(['F-BADACTOR']);
    expect(res.admitted).toEqual([]);
    expect(createEscalation).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: 'F-BADACTOR', harnessSlug: HARNESS, reasons: 'exfiltration risk' }),
    );
    expect(await auditVerdictCol('F-BADACTOR')).toBe('reject');

    // Still quarantined — a rejected remote feature never auto-runs.
    expect(await claimNextWorkItem({ harness: HARNESS, assignee: 'cup' })).toBeNull();
  });

  it('(b) TRUSTED remote → auto-runs WITHOUT the auditor (claimable while still auditor-pending, audit_verdict NULL)', async () => {
    // Producer: a verified author stamps the remote row (the real P-008 path).
    await seedMember(7, ['pk-ally'], 'verified');
    await proj().writeToPg(featureRow('F-ALLY'), { authorPubkey: 'pk-ally', origin: 'remote', ts: 1 });

    // Verified ≠ trusted: still quarantined until the owner trusts the author.
    expect(await claimWorkItem('F-ALLY', 'bee0', { harness: HARNESS })).toBeNull();

    // Owner trusts the author via the trust:add path.
    await addTrustedUser(WS, { githubUserId: 7, note: 'my collaborator', actor: 'owner', nowMs: 1 });

    // The auditor has NOT run — the feature is STILL in its pending set (audit_verdict NULL)…
    const pending = await selectRemotePendingFeatures(opg(), WS, HARNESS);
    expect(pending.map((p) => p.feature_id)).toContain('F-ALLY');
    expect(await auditVerdictCol('F-ALLY')).toBeNull();

    // …yet the trust leg makes it auto-runnable RIGHT NOW, no auditor verdict needed.
    const wi = await claimWorkItem('F-ALLY', 'cup', { harness: HARNESS });
    expect(wi).not.toBeNull();
  });

  it('(c) REVOKE trust (trust:remove) → the SAME item returns to screening (un-claimable)', async () => {
    await seedMember(7, ['pk-ally'], 'verified');
    await proj().writeToPg(featureRow('F-ALLY'), { authorPubkey: 'pk-ally', origin: 'remote', ts: 1 });
    await addTrustedUser(WS, { githubUserId: 7, actor: 'owner', nowMs: 1 });

    // Trusted → the gate admits it (read-only check — does not consume the item).
    expect(await isWorkItemAutoPickable('F-ALLY', { harness: HARNESS, workspaceId: WS })).toBe(true);

    // Owner revokes trust via the trust:remove path.
    const { removed } = await removeTrustedUser(WS, 7, 'owner');
    expect(removed).toBe(true);

    // Back to screening: audit_verdict is still NULL and the author is no longer trusted,
    // so the gate refuses it again — it must go through the auditor now.
    expect(await auditVerdictCol('F-ALLY')).toBeNull();
    expect(await isWorkItemAutoPickable('F-ALLY', { harness: HARNESS, workspaceId: WS })).toBe(false);
    expect(await claimWorkItem('F-ALLY', 'cup', { harness: HARNESS })).toBeNull();
  });
});
