/**
 * work-items-admission.integration.test.ts — the G2 admission gate enforced on EVERY
 * claim path, against real Postgres (shared-hive-trust-admission-2026-06-14, Phase 1).
 *
 * The predecessor (papercusp-user-protection-gate-2026-05-31) pinned the gate on the
 * FRONTIER read only (user-protection-gate.integration.test.ts). The audit found the
 * Hive's fleet/blackboard distribution layer — claim_next, explicit claim, replica
 * fan-out, place_batch — read the consolidated table directly and BYPASSED the gate,
 * so un-screened remote work was claimable + runnable. This pins the gate on those
 * paths against a real testcontainer PG; a mock-pg test structurally cannot catch a
 * missing WHERE clause, only a real filter can. Gated on Docker like the other *-pg
 * integration tests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  USER_TRUST_LIST_DDL,
  WORK_ITEM_DEPS_DDL,
  applyClaimPathReadDeps,
} from '../test/_work-items-schema';
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

const { claimNextWorkItem, claimWorkItem, getWorkItem, listWorkItems } = await import('./work-items');
const { claimReplicaSlot } = await import('./work-item-redundancy');
const { claimNextAgentReview } = await import('./harness/improvements/agent-review');
const { autoPickableWhereSql, resolveVerifiedAuthorGithubId } = await import('./work-items-admission');
const {
  agentReviewPendingAdmissionSql,
  matchesAgentReviewClaimAdmission,
  mintAgentReviewClaimAdmission,
  readAgentReviewState,
} = await import('./harness/improvements/agent-review-policy');
const { buildHarnessFeaturesProjection } = await import('./sync/hyperbee/projections/harness-features');

const WS = 'default';
const HARNESS = 'h1';

const HFC_DDL = HARNESS_FEATURES_CONSOLIDATED_DDL;

// `fed_hlc` (migration 314, hlc-ordering-key) is a real prod column on
// harness_features_consolidated that the projection's writeToPg INSERTs, but it is
// NOT in the shared superset DDL yet. This test exercises that projection path, so
// patch the one missing column here (prod added it the same way: ADD COLUMN IF NOT
// EXISTS fed_hlc TEXT). FLAG: fold fed_hlc into _work-items-schema.ts's superset.
const HFC_FED_HLC_PATCH = `
  ALTER TABLE harness_shared.work_items ADD COLUMN IF NOT EXISTS fed_hlc text`;

// Claim admission now checks whether the claimant is an active blueprint
// operation worker. These ordinary test claimants have no adv_sessions row;
// keep the real lookup available so it returns `none` rather than failing
// because this focused database omitted the session table entirely.
const CLAIM_SESSION_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.adv_sessions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id text NOT NULL,
    coord_owner_id text,
    role text,
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ended_at timestamptz,
    ended_by text
  )`;

// P-008: the admission records the verified-author resolver reads. Minimal shape
// mirroring harness_shared.pot_members (migration 185): a member's bound devices
// (device_attestations jsonb array of {device_pubkey,...}) + the revoked blocklist
// + binding_status. The resolver returns github_user_id ONLY for a verified,
// non-revoked, attested pubkey.
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

// Phase 3 / P-009: the owner-keyed LOCAL trust list the admission predicate consults
// (shared DDL — USER_TRUST_LIST_DDL imported from ../test/_work-items-schema).

const REPLICAS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.work_item_replicas (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    work_item_id text NOT NULL,
    replica_index integer NOT NULL,
    redundancy integer NOT NULL,
    claim_id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner text NOT NULL,
    owner_label text,
    holder_pubkey text,
    ttl_sec integer DEFAULT 1800 NOT NULL,
    acquired_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    expires_ts timestamptz NOT NULL,
    last_activity_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    status text DEFAULT 'claimed' NOT NULL,
    result jsonb,
    judge_composite double precision, judge_rationale text, judge_model text,
    rubric_hash text, judge_cost_usd double precision, judged_ts timestamptz,
    created_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    updated_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT work_item_replicas_pkey PRIMARY KEY (workspace_id, harness_slug, work_item_id, replica_index),
    CONSTRAINT work_item_replicas_status_check CHECK (status IN ('claimed','complete','winner','loser')))`;

// getWorkItem (called by claimWorkItem) checks getIssue FIRST for every id — issue ids are
// globally unique — so the table must exist. Left EMPTY: getIssue returns null and the lookup
// falls through to the feature row. Minimal columns = exactly what ISSUE_COLS selects.
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

/** Seed one todo feature row differing ONLY in origin / audit_verdict (+ optional redundancy). */
function ins(fid: string, origin: string, verdict: string | null, ts: number, redundancy: number | null = null) {
  return h.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin, audit_verdict, redundancy, created_ts, updated_ts)
    VALUES (${WS}, ${HARNESS}, ${fid}, ${fid}, 'open', 'feature', ${origin}, ${verdict}, ${redundancy}, ${ts}, ${ts})`;
}

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('work-items-admission');
  h.sql = db.sql;
  await db.sql.unsafe(HFC_DDL);
  await db.sql.unsafe(HFC_FED_HLC_PATCH);
  await db.sql.unsafe(CLAIM_SESSION_DDL);
  await db.sql.unsafe(REPLICAS_DDL);
  await db.sql.unsafe(ISSUES_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple()); // event tables + any later claim-path dep (WI-10005130)
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple(); // claim path's P-005 readiness clause reads work_item_deps
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(HIVE_MEMBERS_DDL);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.harness_features_consolidated`;
  await db.sql`DELETE FROM harness_shared.work_item_replicas`;
  await db.sql`DELETE FROM harness_shared.user_trust_list`;
  await db.sql`DELETE FROM harness_shared.pot_members`;
});

/** Seed a feature carrying an `author_pubkey` (the substrate-log device key) — for the
 *  own-node leg. `pubkey` may be '' to reproduce the blank-authored back-compat row. */
function insAuthored(fid: string, origin: string, verdict: string | null, ts: number, pubkey: string | null) {
  return h.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin, audit_verdict, author_pubkey, created_ts, updated_ts)
    VALUES (${WS}, ${HARNESS}, ${fid}, ${fid}, 'open', 'feature', ${origin}, ${verdict}, ${pubkey}, ${ts}, ${ts})`;
}

/** Seed a feature with a VERIFIED author id (what P-008 stamps) — for the trust-leg cases. */
function insVerified(fid: string, origin: string, verdict: string | null, ts: number, verifiedAuthorId: number | null) {
  return h.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin, audit_verdict, verified_author_github_user_id, created_ts, updated_ts)
    VALUES (${WS}, ${HARNESS}, ${fid}, ${fid}, 'open', 'feature', ${origin}, ${verdict}, ${verifiedAuthorId}, ${ts}, ${ts})`;
}

/** Add a trusted github id to a workspace's local trust list (defaults to the test WS). */
function trust(githubId: number, ws: string = WS) {
  return h.sql`
    INSERT INTO harness_shared.user_trust_list (workspace_id, trusted_github_user_id, created_ts)
    VALUES (${ws}, ${githubId}, 1)`;
}

/** Seed a pot_members admission row (P-008 producer source). `pubkeys` become
 *  device_attestations; `revoked` go on revoked_pubkeys; `binding` is the binding_status. */
function seedMember(
  githubId: number,
  pubkeys: string[],
  binding: 'verified' | 'pending' | 'unverified',
  revoked: string[] = [],
  hive = 'hive-a',
  ws: string = WS,
) {
  const attestations = pubkeys.map((pk, i) => ({
    device_pubkey: pk,
    gist_id: `g${i}`,
    gist_url: 'u',
    device_label: 'd',
    created_at: 1,
    signature_by_device: 's',
  }));
  return h.sql`
    INSERT INTO harness_shared.pot_members
      (workspace_id, pot_home_slug, github_user_id, github_username, device_attestations, revoked_pubkeys, binding_status, joined_at)
    VALUES (${ws}, ${hive}, ${githubId}, ${'user' + githubId}, ${JSON.stringify(attestations)}::text::jsonb, ${revoked}, ${binding}, 1)`;
}

/** A minimal valid HarnessFeatureRow for driving the projection's writeToPg. */
function featureRow(fid: string): HarnessFeatureRow {
  return {
    harness_slug: HARNESS,
    feature_id: fid,
    title: fid,
    summary: '',
    status: 'open',
    attempts: 0,
    claims: 0,
    notes: null,
    metadata: null,
    kind: null,
    project_id: null,
    expected_cost_cents: null,
    tags: null,
    needs_human_review: false,
    ts: 1,
    created_ts: 1,
    updated_ts: 1,
    parent_id: null,
    goal_id: null,
    taken_by: null,
    taken_at: null,
    expires_at: null,
    item_kind: 'feature',
    feature_order: null,
    swarm_affinity: null,
    redundancy: null,
    payload: null,
  } as unknown as HarnessFeatureRow;
}

async function verifiedCol(fid: string): Promise<number | null> {
  const rows = await h.sql<{ v: string | number | null }[]>`
    SELECT verified_author_github_user_id AS v FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${HARNESS} AND feature_id = ${fid}`;
  const v = rows[0]?.v;
  return v == null ? null : Number(v);
}

describe('G2 admission gate — every claim path (real PG)', () => {
  it('claim_next (self-selection) never grabs a remote, un-admitted item', async () => {
    await ins('F-LOCAL', 'local', null, 1);
    await ins('F-ADMITTED', 'remote', 'admit', 2);
    await ins('F-PENDING', 'remote', null, 3);
    await ins('F-REJECTED', 'remote', 'reject', 4);

    const got: string[] = [];
    for (let i = 0; i < 4; i++) {
      const wi = await claimNextWorkItem({ harness: HARNESS, assignee: `bee-${i}` });
      if (wi) got.push(wi.id);
    }
    expect(got.sort()).toEqual(['F-ADMITTED', 'F-LOCAL']);
    expect(got).not.toContain('F-PENDING');
    expect(got).not.toContain('F-REJECTED');
  });

  it('explicit named claim of a remote, un-admitted item returns null; local + admitted succeed', async () => {
    await ins('F-LOCAL', 'local', null, 1);
    await ins('F-ADMITTED', 'remote', 'admit', 2);
    await ins('F-PENDING', 'remote', null, 3);

    expect(await claimWorkItem('F-PENDING', 'cup', { harness: HARNESS })).toBeNull();
    expect(await claimWorkItem('F-LOCAL', 'cup', { harness: HARNESS })).not.toBeNull();
    expect(await claimWorkItem('F-ADMITTED', 'cup', { harness: HARNESS })).not.toBeNull();
  });

  it('replica fan-out refuses a remote, un-admitted item (not-admitted); admits an admitted one', async () => {
    await ins('F-PENDING', 'remote', null, 1, 3);
    await ins('F-ADMITTED', 'remote', 'admit', 2, 3);

    const refused = await claimReplicaSlot({ harnessSlug: HARNESS, workItemId: 'F-PENDING', owner: 'cup' });
    expect(refused).toEqual({ ok: false, reason: 'not-admitted' });

    const ok = await claimReplicaSlot({ harnessSlug: HARNESS, workItemId: 'F-ADMITTED', owner: 'cup' });
    expect(ok.ok).toBe(true);
  });

  it('surfaces origin + auditVerdict on the WorkItem (placement visibility, P-005)', async () => {
    await ins('F-PENDING', 'remote', null, 1);
    const [wi] = await listWorkItems({ harness: HARNESS, kind: 'feature' });
    expect(wi.origin).toBe('remote');
    expect(wi.auditVerdict).toBeNull();
  });

  it('ANTI-TAUTOLOGY: the un-admitted rows are otherwise valid todo items — only the gate skips them', async () => {
    await ins('F-PENDING', 'remote', null, 1);
    await ins('F-REJECTED', 'remote', 'reject', 2);
    // Both surface in the unified list (todo, unassigned) — so a difference in the
    // CLAIMED set is attributable solely to the admission gate, not status/assignment.
    const items = await listWorkItems({ harness: HARNESS, kind: 'feature' });
    expect(items.map((i) => i.id).sort()).toEqual(['F-PENDING', 'F-REJECTED']);
    // ...yet neither is claimable.
    expect(await claimNextWorkItem({ harness: HARNESS, assignee: 'cup' })).toBeNull();
  });
});

/**
 * The OWN-NODE leg, against real Postgres — the leg that actually gates placement.
 * [owner 2026-07-13] "trust our own nodes ... that should be the default. all new
 * papercusp installs should have that behavior without needing to do anything".
 *
 * These MUST be real-PG: the unit tests hand the JS form a Set and never exercise SQL's
 * three-valued logic, where an unaudited row's `audit_verdict = 'admit'` is NULL rather
 * than FALSE. That distinction is exactly what silently broke the sibling starvation
 * counter, with every fixture-driven test still green.
 */
describe('G2 own-node leg — a workspace trusts its own substrate keys (real PG)', () => {
  const OURS = 'b5ab1807fbc9d091f7b6c76d9918549c1631e91dcb998298202f64797d4697ac';
  const STRANGER = '9999999999999999999999999999999999999999999999999999999999999999';

  it('THE DEADLOCK: a remote, NEVER-audited item authored by our own key is claimable', async () => {
    // The key is "ours" purely because it authored a LOCAL row here — no registry, no setup.
    await insAuthored('F-OURS-LOCAL', 'local', null, 1, OURS);
    // ...and this is the same key's work coming back through federation as origin='remote'.
    await insAuthored('F-OURS-REMOTE', 'remote', null, 2, OURS);

    const wi = await claimWorkItem('F-OURS-REMOTE', 'cup', { harness: HARNESS });
    expect(wi).not.toBeNull();
  });

  it("SECURITY: a stranger's key is still quarantined — this widens trust to US, not to everyone", async () => {
    await insAuthored('F-OURS-LOCAL', 'local', null, 1, OURS);
    await insAuthored('F-STRANGER', 'remote', null, 2, STRANGER);

    expect(await claimWorkItem('F-STRANGER', 'cup', { harness: HARNESS })).toBeNull();
  });

  it('SECURITY: a BLANK author_pubkey never enters the own-key set (or it would admit every blank-authored remote row)', async () => {
    // Blank-authored LOCAL rows genuinely exist (pre-federation back-compat).
    await insAuthored('F-BLANK-LOCAL', 'local', null, 1, '');
    await insAuthored('F-BLANK-REMOTE', 'remote', null, 2, '');
    await insAuthored('F-NULL-REMOTE', 'remote', null, 3, null);

    expect(await claimWorkItem('F-BLANK-REMOTE', 'cup', { harness: HARNESS })).toBeNull();
    expect(await claimWorkItem('F-NULL-REMOTE', 'cup', { harness: HARNESS })).toBeNull();
  });

  it('SECURITY (D-004): own-node trust does NOT leak across workspaces', async () => {
    // The key is local — and therefore "ours" — only in ANOTHER workspace.
    await h.sql`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, item_kind, origin, audit_verdict, author_pubkey, created_ts, updated_ts)
      VALUES ('other-ws', ${HARNESS}, 'F-OTHER-LOCAL', 'F-OTHER-LOCAL', 'open', 'feature', 'local', NULL, ${OURS}, 1, 1)`;
    await insAuthored('F-REMOTE-HERE', 'remote', null, 2, OURS);

    expect(await claimWorkItem('F-REMOTE-HERE', 'cup', { harness: HARNESS })).toBeNull();
  });

  it('a fresh install with no local history yet admits nothing remote (fail-safe, empty own-key set)', async () => {
    await insAuthored('F-REMOTE-ONLY', 'remote', null, 1, OURS);
    expect(await claimNextWorkItem({ harness: HARNESS, assignee: 'cup' })).toBeNull();
  });

  it('claim_next self-selection picks up our own federated work alongside local work', async () => {
    await insAuthored('F-OURS-LOCAL', 'local', null, 1, OURS);
    await insAuthored('F-OURS-REMOTE', 'remote', null, 2, OURS);
    await insAuthored('F-STRANGER', 'remote', null, 3, STRANGER);

    const got: string[] = [];
    for (let i = 0; i < 3; i++) {
      const wi = await claimNextWorkItem({ harness: HARNESS, assignee: `bee-${i}` });
      if (wi) got.push(wi.id);
    }
    expect(got.sort()).toEqual(['F-OURS-LOCAL', 'F-OURS-REMOTE']);
    expect(got).not.toContain('F-STRANGER');
  });
});

describe('G2 trust leg — owner-keyed LOCAL trust list (Phase 3 / P-010, real PG)', () => {
  it('claim_next: a remote+un-admitted item whose VERIFIED author is trusted IS claimable', async () => {
    await insVerified('F-TRUSTED', 'remote', null, 1, 42);
    await trust(42);
    const wi = await claimNextWorkItem({ harness: HARNESS, assignee: 'cup' });
    expect(wi?.id).toBe('F-TRUSTED');
  });

  it('claim_next: a remote+un-admitted item whose verified author is NOT trusted stays unclaimable', async () => {
    await insVerified('F-UNTRUSTED', 'remote', null, 1, 99);
    await trust(42); // a different id is trusted, not 99
    expect(await claimNextWorkItem({ harness: HARNESS, assignee: 'cup' })).toBeNull();
  });

  it('explicit claim: trusted verified author succeeds; untrusted fails', async () => {
    await insVerified('F-TRUSTED', 'remote', null, 1, 42);
    await insVerified('F-UNTRUSTED', 'remote', null, 2, 99);
    await trust(42);
    expect(await claimWorkItem('F-UNTRUSTED', 'cup', { harness: HARNESS })).toBeNull();
    expect(await claimWorkItem('F-TRUSTED', 'cup', { harness: HARNESS })).not.toBeNull();
  });

  it('SECURITY: an UNVERIFIED remote item (NULL verified author — unverified/revoked binding) is never trust-admitted', async () => {
    await insVerified('F-UNVERIFIED', 'remote', null, 1, null);
    await trust(42); // ids are trusted, but the item has no verified author
    expect(await claimNextWorkItem({ harness: HARNESS, assignee: 'cup' })).toBeNull();
    expect(await claimWorkItem('F-UNVERIFIED', 'cup', { harness: HARNESS })).toBeNull();
  });

  it('SECURITY (D-004): trust does NOT leak across workspaces — an author trusted in ANOTHER workspace is refused here', async () => {
    await insVerified('F-OTHERWS', 'remote', null, 1, 42); // feature lives in WS 'default'
    await trust(42, 'other-workspace'); // 42 trusted ONLY in a different workspace
    expect(await claimNextWorkItem({ harness: HARNESS, assignee: 'cup' })).toBeNull();
    expect(await claimWorkItem('F-OTHERWS', 'cup', { harness: HARNESS })).toBeNull();
  });

  it('replica fan-out: a trusted verified author is admitted', async () => {
    await insVerified('F-TRUSTED', 'remote', null, 1, 42);
    await h.sql`UPDATE harness_shared.harness_features_consolidated SET redundancy = 3 WHERE harness_slug = ${HARNESS} AND feature_id = 'F-TRUSTED'`;
    await trust(42);
    const ok = await claimReplicaSlot({ harnessSlug: HARNESS, workItemId: 'F-TRUSTED', owner: 'cup' });
    expect(ok.ok).toBe(true);
  });
});

describe('pending agent-review claims keep the shared admission floor narrow (real PG)', () => {
  it('admits only a matching pending reviewer snapshot; ordinary and stale claims remain blocked', async () => {
    const payload = {
      agentReview: { status: 'pending' as const, submittedBy: 'su-filer', ledgerIdeaId: 'F-REVIEW', round: 1 },
    };
    await ins('F-REVIEW', 'local', null, 1);
    await h.sql`
      UPDATE harness_shared.harness_features_consolidated
         SET admission = 'pending', payload = ${JSON.stringify(payload)}::text::jsonb
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = 'F-REVIEW'`;

    expect(await claimWorkItem('F-REVIEW', 'su-reviewer', { harness: HARNESS })).toBeNull();
    const admission = mintAgentReviewClaimAdmission({
      itemId: 'F-REVIEW',
      reviewer: 'su-reviewer',
      harnessSlug: HARNESS,
      review: payload.agentReview,
      parties: { reporters: [], implementers: [] },
    });
    expect(admission).not.toBeNull();
    const candidate = await getWorkItem('F-REVIEW', HARNESS);
    expect(candidate).not.toBeNull();
    expect(candidate).toMatchObject({
      id: 'F-REVIEW',
      family: 'feature',
      harness: HARNESS,
    });
    expect(readAgentReviewState(candidate!.payload)).toEqual(payload.agentReview);
    expect(admission).toMatchObject({
      itemId: 'F-REVIEW',
      reviewer: 'su-reviewer',
      harnessSlug: HARNESS,
      submittedBy: 'su-filer',
      ledgerIdeaId: 'F-REVIEW',
      round: 1,
    });
    expect(matchesAgentReviewClaimAdmission(admission, candidate!, 'su-reviewer')).toBe(true);
    const [claimFloor] = await h.sql<{
      admission: string;
      origin: string;
      taken_by: string | null;
      review_allowed: boolean;
      auto_pickable: boolean;
    }[]>`
      SELECT target.admission,
             target.origin,
             target.taken_by,
             ${agentReviewPendingAdmissionSql(h.sql, admission, {
               payload: 'target.payload',
               admission: 'target.admission',
             })} AS review_allowed,
             ${autoPickableWhereSql(h.sql, WS)} AS auto_pickable
        FROM harness_shared.harness_features_consolidated AS target
       WHERE target.workspace_id = ${WS}
         AND target.harness_slug = ${HARNESS}
         AND target.feature_id = 'F-REVIEW'`;
    expect(claimFloor).toEqual({
      admission: 'pending',
      origin: 'local',
      taken_by: null,
      review_allowed: true,
      auto_pickable: true,
    });
    const claimed = await claimWorkItem('F-REVIEW', 'su-reviewer', {
      harness: HARNESS,
      agentReviewAdmission: admission!,
    });
    expect(claimed).toMatchObject({ id: 'F-REVIEW', assignee: 'su-reviewer' });

    const nextPayload = {
      agentReview: { status: 'pending' as const, submittedBy: 'su-filer', ledgerIdeaId: 'F-REVIEW-NEXT', round: 1 },
    };
    await ins('F-REVIEW-NEXT', 'local', null, 3);
    await h.sql`
      UPDATE harness_shared.harness_features_consolidated
         SET admission = 'pending', payload = ${JSON.stringify(nextPayload)}::text::jsonb
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = 'F-REVIEW-NEXT'`;
    const nextClaim = await claimNextAgentReview({ reviewer: 'su-next-reviewer', harnessSlug: HARNESS });
    expect(nextClaim).toMatchObject({ id: 'F-REVIEW-NEXT', assignee: 'su-next-reviewer' });

    const stalePayload = {
      agentReview: {
        status: 'pending' as const,
        submittedBy: 'su-filer',
        ledgerIdeaId: 'F-REVIEW-STALE',
        round: 1,
      },
    };
    await ins('F-REVIEW-STALE', 'local', null, 2);
    await h.sql`
      UPDATE harness_shared.harness_features_consolidated
         SET admission = 'pending', payload = ${JSON.stringify(stalePayload)}::text::jsonb
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = 'F-REVIEW-STALE'`;
    const staleAdmission = mintAgentReviewClaimAdmission({
      itemId: 'F-REVIEW-STALE',
      reviewer: 'su-reviewer',
      harnessSlug: HARNESS,
      review: stalePayload.agentReview,
      parties: { reporters: [], implementers: [] },
    });
    expect(staleAdmission).not.toBeNull();
    await h.sql`
      UPDATE harness_shared.harness_features_consolidated
         SET payload = jsonb_set(payload, '{agentReview,status}', '"approved"'::jsonb)
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = 'F-REVIEW-STALE'`;
    expect(await claimWorkItem('F-REVIEW-STALE', 'su-reviewer', {
      harness: HARNESS,
      agentReviewAdmission: staleAdmission!,
    })).toBeNull();
  }, 30_000);
});

// P-008 — the PRODUCER of verified_author_github_user_id. Each case is a security
// assertion: a wrong resolution would let un-screened foreign work auto-run (D-002).
describe('P-008 — resolveVerifiedAuthorGithubId (verified-attestation resolver, real PG)', () => {
  it('resolves a VERIFIED, non-revoked, attested pubkey to its github_user_id', async () => {
    await seedMember(42, ['pk-verified'], 'verified');
    expect(await resolveVerifiedAuthorGithubId(h.sql, { workspaceId: WS, authorPubkey: 'pk-verified' })).toBe(42);
  });
  it('REFUSES a revoked pubkey (a verifier MUST refuse a revoked attestation) → null', async () => {
    await seedMember(42, ['pk-revoked'], 'verified', ['pk-revoked']);
    expect(await resolveVerifiedAuthorGithubId(h.sql, { workspaceId: WS, authorPubkey: 'pk-revoked' })).toBeNull();
  });
  it('REFUSES an unverified/pending binding → null', async () => {
    await seedMember(42, ['pk-pending'], 'pending');
    expect(await resolveVerifiedAuthorGithubId(h.sql, { workspaceId: WS, authorPubkey: 'pk-pending' })).toBeNull();
  });
  it('REFUSES a pubkey with no attestation (never a self-claimed id) → null', async () => {
    await seedMember(42, ['pk-other'], 'verified');
    expect(await resolveVerifiedAuthorGithubId(h.sql, { workspaceId: WS, authorPubkey: 'pk-unknown' })).toBeNull();
  });
  it('is WORKSPACE-scoped — a verified attestation in another workspace does NOT resolve here', async () => {
    await seedMember(42, ['pk-verified'], 'verified', [], 'hive-a', 'other-ws');
    expect(await resolveVerifiedAuthorGithubId(h.sql, { workspaceId: WS, authorPubkey: 'pk-verified' })).toBeNull();
  });
  it('handles NULL revoked_pubkeys / device_attestations without error', async () => {
    await h.sql`
      INSERT INTO harness_shared.pot_members
        (workspace_id, pot_home_slug, github_user_id, github_username, device_attestations, revoked_pubkeys, binding_status, joined_at)
      VALUES (${WS}, 'hive-a', 7, 'u7', ${JSON.stringify([{ device_pubkey: 'pk-7' }])}::text::jsonb, NULL, 'verified', 1)`;
    expect(await resolveVerifiedAuthorGithubId(h.sql, { workspaceId: WS, authorPubkey: 'pk-7' })).toBe(7);
    expect(await resolveVerifiedAuthorGithubId(h.sql, { workspaceId: WS, authorPubkey: '' })).toBeNull();
  });
});

describe('P-008 — projection stamp (producer wiring → the gate), real PG', () => {
  const proj = () => buildHarnessFeaturesProjection({ workspaceId: WS, harnessSlug: HARNESS, sql: h.sql });

  it('stamps a REMOTE row whose author_pubkey is verified', async () => {
    await seedMember(42, ['pk-verified'], 'verified');
    await proj().writeToPg(featureRow('F-R'), { authorPubkey: 'pk-verified', origin: 'remote', ts: 1 });
    expect(await verifiedCol('F-R')).toBe(42);
  });
  it('leaves a LOCAL row NULL even when the pubkey would verify (local never trust-stamped)', async () => {
    await seedMember(42, ['pk-verified'], 'verified');
    await proj().writeToPg(featureRow('F-L'), { authorPubkey: 'pk-verified', origin: 'local', ts: 1 });
    expect(await verifiedCol('F-L')).toBeNull();
  });
  it('leaves a REMOTE row NULL when its author pubkey is revoked', async () => {
    await seedMember(42, ['pk-revoked'], 'verified', ['pk-revoked']);
    await proj().writeToPg(featureRow('F-RV'), { authorPubkey: 'pk-revoked', origin: 'remote', ts: 1 });
    expect(await verifiedCol('F-RV')).toBeNull();
  });
  it('leaves a REMOTE row NULL when its author binding is unverified', async () => {
    await seedMember(42, ['pk-pending'], 'pending');
    await proj().writeToPg(featureRow('F-UV'), { authorPubkey: 'pk-pending', origin: 'remote', ts: 1 });
    expect(await verifiedCol('F-UV')).toBeNull();
  });
  it('END-TO-END: a verified remote feature gets stamped → and (when its author is trusted) becomes claimable through the gate', async () => {
    await seedMember(99, ['pk-99'], 'verified');
    await proj().writeToPg(featureRow('F-E2E'), { authorPubkey: 'pk-99', origin: 'remote', ts: 1 });
    expect(await verifiedCol('F-E2E')).toBe(99);
    // Untrusted: the stamped-but-untrusted remote item stays quarantined.
    expect(await claimWorkItem('F-E2E', 'cup', { harness: HARNESS })).toBeNull();
    // Trust the author → the SAME item is now claimable (producer + gate together).
    await trust(99);
    expect(await claimWorkItem('F-E2E', 'bee2', { harness: HARNESS })).not.toBeNull();
  });
});
