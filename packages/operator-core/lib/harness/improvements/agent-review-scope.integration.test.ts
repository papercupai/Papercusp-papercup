/** P-026: real pickup queries against migrated PG, with a full excluded page. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OrgTestDb } from '../../../test/_org-test-db';
import type { WorkItem } from '../../work-items';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../../workspace-registry', async (orig) => ({
  ...(await orig<typeof import('../../workspace-registry')>()), activeWorkspaceId: () => 'wrong-ambient-workspace',
}));

const { createOrgTestDb } = await import('../../../test/_org-test-db');
const { FEATURE_COLS, featureRowToWorkItem } = await import('../../work-items');
const { adoptNextAgentReviewRevision, claimNextAgentReview, claimNextVerificationTask, resubmitAgentReview } = await import('./agent-review');
const { LEGACY_AGENT_REVIEW_SUBMITTER } = await import('./agent-review-policy');
const { buildP2pLaneFence } = await import('../../scheduler/p2p-lane-fence');
const WS = 'ws-verifier-scope';
const HARNESS = 'papercusp';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

async function ensureClaimNextIndex(db: OrgTestDb) {
  const existing = await db.adminSql`SELECT 1 FROM pg_indexes
    WHERE schemaname = 'harness_shared' AND indexname = 'work_items_agent_review_claim_next_idx'`;
  if (existing.length) return;

  // During migration authoring the allocated .DRAFT is intentionally invisible to
  // the migration runner. Apply that one additive DDL in this isolated test DB so
  // the integration assertion exercises the exact draft before it is armed.
  const candidates = [
    resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql/1435-agent-review-claim-next-index.sql.DRAFT'),
    resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql/1435-agent-review-claim-next-index.sql'),
  ];
  const path = candidates.find(existsSync);
  if (!path) throw new Error('1435 agent-review claim-next migration is missing');
  await db.adminSql.unsafe(readFileSync(path, 'utf8'));
}

describe('P-026 canonical verifier scope before LIMIT, real PG', () => {
  let db: OrgTestDb;
  beforeAll(async () => {
    db = await createOrgTestDb();
    await ensureClaimNextIndex(db);
    h.sql = db.adminSql;
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(async () => { await db.adminSql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS}`; });

  async function seed(id: string, review: boolean, index: number, plan: string | null, conflict?: string, kind = review ? 'change' : 'task') {
    const payload = review
      ? { agentReview: { status: 'pending', submittedBy: conflict ?? 'su-filer', ledgerIdeaId: id, round: 2 } }
      : { verification: { schemaVersion: 'verification-task-v1', subject: 'WI-S', check: 'completion', reporters: conflict ? [conflict] : [] } };
    await db.adminSql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, item_kind, status, payload, source_plan_slug, created_ts, feature_order)
      VALUES (${WS}, ${HARNESS}, ${id}, 'Neutral queue item', 'Current fixture', ${kind},
        'open', ${JSON.stringify(payload)}::text::jsonb, ${plan}, ${index}, ${index})`;
  }

  function writer() {
    const getWorkItem = vi.fn(async (id: string): Promise<WorkItem | null> => {
      const rows = await db.adminSql.unsafe(`SELECT ${FEATURE_COLS} FROM harness_shared.work_items WHERE workspace_id=$1 AND feature_id=$2`, [WS, id]);
      return rows[0] ? featureRowToWorkItem(rows[0] as never) : null;
    });
    const claimWorkItem = vi.fn(async (id: string, assignee: string) => {
      const rows = await db.adminSql`UPDATE harness_shared.work_items SET taken_by=${assignee}
        WHERE workspace_id=${WS} AND feature_id=${id} AND taken_by IS NULL RETURNING feature_id`;
      return rows.length ? getWorkItem(id) : null;
    });
    const deps = {
      getWorkItem, claimWorkItem, readLedgerGrade: vi.fn(async () => null),
      releaseWorkItem: vi.fn(async (id: string, opts: { expectedAssignee?: string }) => {
        await db.adminSql`UPDATE harness_shared.work_items SET taken_by=NULL
          WHERE workspace_id=${WS} AND feature_id=${id} AND taken_by=${opts.expectedAssignee ?? ''}`;
        return getWorkItem(id);
      }),
    };
    return { deps, claimWorkItem };
  }

  it.each(['su-reviewer', 'owner'])('resubmit resets only the matching agent verdict; gradedBy=%s (EI-26211005060590945)', async (gradedBy) => {
    const id = `WI-RESUBMIT-${gradedBy}`;
    await seed(id, true, 0, null);
    await db.adminSql`UPDATE harness_shared.work_items
      SET taken_by='su-filer', payload=jsonb_set(payload, '{agentReview,status}', '"revision-requested"')
      WHERE workspace_id=${WS} AND feature_id=${id}`;
    for (const ideaId of [id, `${id}-unrelated`]) {
      await db.adminSql`INSERT INTO harness_shared.scout_routed_ideas
        (idea_id, workspace_id, harness_slug, lens, rail, routed_ref, routed_at,
         human_grade, human_feedback, graded_by, graded_at)
        VALUES (${ideaId}, ${WS}, ${HARNESS}, 'first-principles', 'improvement', ${'wi:' + ideaId}, 0,
          2, 'previous round feedback', ${gradedBy}, now())`;
    }
    const { deps } = writer();
    const mergeWorkItemPayload = vi.fn(async (_id: string, patch: object) => {
      await db.adminSql`UPDATE harness_shared.work_items SET payload=payload || ${JSON.stringify(patch)}::jsonb
        WHERE workspace_id=${WS} AND feature_id=${id}`;
      return deps.getWorkItem(id);
    });
    const result = await resubmitAgentReview({ id, submittedBy: 'su-filer' }, {
      ...deps, mergeWorkItemPayload,
      resolveSubmitterLiveness: vi.fn(async () => ({ sessionState: 'live' as const })),
    } as never);
    expect(result).toMatchObject({ resubmitted: true, state: { status: 'pending', round: 3 } });
    const [row] = await db.adminSql`SELECT human_grade, human_feedback, graded_by, graded_at
      FROM harness_shared.scout_routed_ideas WHERE idea_id=${id}`;
    if (gradedBy === 'owner') {
      expect(row).toMatchObject({ human_grade: 2, human_feedback: 'previous round feedback', graded_by: 'owner' });
      expect(row.graded_at).not.toBeNull();
    } else {
      expect(row).toEqual({ human_grade: null, human_feedback: null, graded_by: null, graded_at: null });
    }
    const [unrelated] = await db.adminSql`SELECT human_grade, human_feedback, graded_by
      FROM harness_shared.scout_routed_ideas WHERE idea_id=${`${id}-unrelated`}`;
    expect(unrelated).toEqual({ human_grade: 2, human_feedback: 'previous round feedback', graded_by: gradedBy });
  });

  it.each([
    [true, 'change'],
    [true, 'bug'],
    [false, 'task'],
  ] as const)('filters a full excluded page before independent pickup; review=%s kind=%s', async (review, kind) => {
    for (let i = 0; i < 30; i++) await seed(`WI-EXCLUDED-${i}`, review, i, 'p2p-release', undefined, kind);
    await seed('WI-CONFLICT', review, 30, 'queue-flow', 'su-verifier', kind);
    // The bug has no plan approval, acceptance contract or reproduction receipt.
    // Pickup assigns validation; it must not silently turn that into bug acceptance.
    await seed('WI-IN', review, 31, null, undefined, kind);
    const { deps, claimWorkItem } = writer();
    const scope = { harnessSlug: HARNESS, workspaceId: WS, filter: buildP2pLaneFence() };
    const result = review
      ? await claimNextAgentReview({ ...scope, reviewer: 'su-verifier' }, deps as never)
      : await claimNextVerificationTask({ ...scope, verifier: 'su-verifier' }, deps as never);
    expect(result?.id).toBe('WI-IN');
    expect(result?.kind).toBe(kind);
    if (kind === 'bug') {
      expect(result?.payload).not.toHaveProperty('intakeReproduction');
      expect(result?.payload).not.toHaveProperty('implementationReadiness');
    }
    expect(claimWorkItem.mock.calls.map((c) => c[0])).toEqual(['WI-IN']);
    const held = await db.adminSql`SELECT feature_id FROM harness_shared.work_items WHERE workspace_id=${WS} AND taken_by IS NOT NULL`;
    expect(held.map((row) => row.feature_id)).toEqual(['WI-IN']);
  });

  it('keeps the pending-review projection and claim-next partial index aligned (EI-25555666233005302)', async () => {
    await seed('WI-PROJECTION', true, 1, null);
    await db.adminSql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, item_kind, status, payload, created_ts, feature_order)
      SELECT ${WS}, ${HARNESS}, 'WI-PLAN-FILLER-' || i::text, 'Neutral queue item', 'Plan fixture', 'change',
        'open', '{}'::jsonb, i + 1, i + 1
      FROM generate_series(1, 5000) AS i`;
    await db.adminSql`ANALYZE harness_shared.work_items`;

    const [row] = await db.adminSql`SELECT agent_review_projection
      FROM harness_shared.work_items
      WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = 'WI-PROJECTION'`;
    const [index] = await db.adminSql`SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'harness_shared' AND indexname = 'work_items_agent_review_claim_next_idx'`;
    const [plan] = await db.adminSql`EXPLAIN (FORMAT JSON, COSTS FALSE)
      SELECT feature_id
      FROM harness_shared.work_items wi
      WHERE workspace_id = ${WS}
        AND harness_slug = ${HARNESS}
        AND status = 'open'
        AND item_kind IN ('bug', 'change', 'task', 'feature')
        AND (taken_by IS NULL OR btrim(taken_by) = '')
        AND agent_review_projection ->> 'status' = 'pending'
      ORDER BY feature_order ASC NULLS LAST, created_ts ASC
      LIMIT 25`;
    const indexDef = index?.indexdef ?? '';

    expect(row?.agent_review_projection).toMatchObject({ status: 'pending', submittedBy: 'su-filer' });
    expect(indexDef).toMatch(/agent_review_projection\s*->>\s*'status'(?:::text)?\)?\s*=\s*'pending'(?:::text)?/);
    expect(indexDef).toMatch(/status\s*=\s*'open'(?:::text)?/);
    expect(indexDef).toMatch(/btrim\(\s*taken_by\s*\)\s*=\s*''(?:::text)?/);
    expect(JSON.stringify(plan)).toContain('work_items_agent_review_claim_next_idx');
  });

  it('adopt-next discovers the oldest proven-orphan content revision and leaves every other route alone (D-008)', async () => {
    const revision = async (id: string, index: number, review: Record<string, unknown>) => {
      const payload = { agentReview: { status: 'revision-requested', ledgerIdeaId: id, round: 2, revisionKind: 'content', ...review } };
      await db.adminSql`INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, item_kind, status, payload, created_ts, feature_order)
        VALUES (${WS}, ${HARNESS}, ${id}, 'Neutral queue item', 'Current fixture', 'bug',
          'open', ${JSON.stringify(payload)}::text::jsonb, ${index}, ${index})`;
    };
    await revision('WI-REPRO', 0, { submittedBy: 'su-gone', revisionKind: 'reproduction' });
    await revision('WI-LEGACY', 1, { submittedBy: LEGACY_AGENT_REVIEW_SUBMITTER });
    await revision('WI-OWN', 2, { submittedBy: 'su-adopter' });
    await revision('WI-PENDING', 3, { submittedBy: 'su-gone', status: 'pending', revisionKind: undefined });
    await revision('WI-LIVE', 4, { submittedBy: 'su-live' });
    await revision('WI-ORPHAN', 5, { submittedBy: 'su-gone' });
    await revision('WI-ORPHAN-LATER', 6, { submittedBy: 'su-gone' });

    const { deps } = writer();
    const liveness = vi.fn(async (ownerId: string) => ({ sessionState: ownerId === 'su-live' ? 'live' : 'ended' }) as const);
    const adoptDeps = {
      ...deps,
      claimWorkItem: vi.fn(async (id: string, assignee: string, opts: { expectedAssignee?: string } = {}) => {
        const rows = await db.adminSql`UPDATE harness_shared.work_items SET taken_by=${assignee}
          WHERE workspace_id=${WS} AND feature_id=${id}
            AND (taken_by IS NULL OR taken_by = ${opts.expectedAssignee ?? ''}) RETURNING feature_id`;
        return rows.length ? deps.getWorkItem(id) : null;
      }),
      mergeWorkItemPayload: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        await db.adminSql`UPDATE harness_shared.work_items
          SET payload = COALESCE(payload, '{}'::jsonb) || ${JSON.stringify(patch)}::text::jsonb
          WHERE workspace_id=${WS} AND feature_id=${id}`;
        return deps.getWorkItem(id);
      }),
      getWorkItemDetail: vi.fn(async () => ({ posts: [] })),
      commentWorkItem: vi.fn(async () => ({})),
      resolveSubmitterLiveness: liveness,
      resolveVerifiedSubmitterAlias: vi.fn(async () => null),
    };

    const result = await adoptNextAgentReviewRevision(
      { adopter: 'su-adopter', harnessSlug: HARNESS, workspaceId: WS },
      adoptDeps as never,
    );

    expect(result).toMatchObject({ adopted: true, workItem: { id: 'WI-ORPHAN' }, scanned: 2, refusals: { 'not-submitter': 1 } });
    // Liveness is measured only for content revisions the query admitted, oldest first.
    expect(liveness.mock.calls.map((call) => call[0])).toEqual(['su-live', 'su-gone']);
    const rows = await db.adminSql`SELECT feature_id, taken_by, payload FROM harness_shared.work_items
      WHERE workspace_id=${WS} ORDER BY created_ts`;
    const held = Object.fromEntries(rows.map((row) => [row.feature_id, row.taken_by]));
    expect(held).toEqual({
      'WI-REPRO': null, 'WI-LEGACY': null, 'WI-OWN': null, 'WI-PENDING': null,
      'WI-LIVE': null, 'WI-ORPHAN': 'su-adopter', 'WI-ORPHAN-LATER': null,
    });
    const adopted = rows.find((row) => row.feature_id === 'WI-ORPHAN')?.payload as Record<string, Record<string, unknown>>;
    expect(adopted.agentReview).toMatchObject({ status: 'revision-requested', submittedBy: 'su-adopter', round: 2 });
    expect(adopted.agentReviewAdoption).toMatchObject({ from: 'su-gone', sessionState: 'ended', adoptedBy: 'su-adopter' });
  });

  /**
   * bug-queue-legitimacy D-011 C (SPEC-BQL-P-009-CONVERGENCE): the window is the 25 OLDEST
   * candidates, so rows that can never be adopted at the head of the queue would pin it
   * forever. A STABLE refusal stamps the row and later scans move past it; a transient one
   * stamps nothing; a new review round or an expired stamp re-qualifies. D-011 B: the spec's
   * view.filter scopes discovery.
   */
  it('adopt-next stamps STABLE refusals so the window converges, and honours the spec filter (D-011 B/C)', async () => {
    const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    const revision = async (
      id: string, index: number, submittedBy: string,
      extra: { plan?: string; probe?: Record<string, unknown> } = {},
    ) => {
      const payload = {
        agentReview: { status: 'revision-requested', ledgerIdeaId: id, round: 2, revisionKind: 'content', submittedBy },
        ...(extra.probe ? { agentReviewAdoptionProbe: extra.probe } : {}),
      };
      await db.adminSql`INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, item_kind, status, payload, source_plan_slug, created_ts, feature_order)
        VALUES (${WS}, ${HARNESS}, ${id}, 'Neutral queue item', 'Current fixture', 'bug',
          'open', ${JSON.stringify(payload)}::text::jsonb, ${extra.plan ?? null}, ${index}, ${index})`;
    };
    // More stable refusals than the 25-row scan window must not hide the eligible tail.
    for (let i = 0; i < 30; i++) await revision(`WI-STABLE-HEAD-${i}`, i - 30, 'su-ghost');
    await revision('WI-SYNTH', 0, 'system:stranded-tool-failure-sweep');
    await revision('WI-UNMEASURED', 1, 'su-ghost');
    await revision('WI-LIVE', 2, 'su-live');
    await revision('WI-STALE-PROBE', 3, 'su-ghost', { probe: { reason: 'not-submitter:liveness-unknown', round: 2, at: at(25 * 3_600_000) } });
    await revision('WI-OLD-ROUND', 4, 'su-ghost', { probe: { reason: 'not-submitter:liveness-unknown', round: 1, at: at(60_000) } });
    const freshAt = at(60_000);
    await revision('WI-FRESH-PROBE', 5, 'su-gone', { probe: { reason: 'not-submitter:liveness-unknown', round: 2, at: freshAt } });
    await revision('WI-P2P', 6, 'su-gone', { plan: 'p2p-release' });
    await revision('WI-ORPHAN', 7, 'su-gone');

    const { deps } = writer();
    const adoptDeps = {
      ...deps,
      claimWorkItem: vi.fn(async (id: string, assignee: string, opts: { expectedAssignee?: string } = {}) => {
        const rows = await db.adminSql`UPDATE harness_shared.work_items SET taken_by=${assignee}
          WHERE workspace_id=${WS} AND feature_id=${id}
            AND (taken_by IS NULL OR taken_by = ${opts.expectedAssignee ?? ''}) RETURNING feature_id`;
        return rows.length ? deps.getWorkItem(id) : null;
      }),
      mergeWorkItemPayload: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        await db.adminSql`UPDATE harness_shared.work_items
          SET payload = COALESCE(payload, '{}'::jsonb) || ${JSON.stringify(patch)}::text::jsonb
          WHERE workspace_id=${WS} AND feature_id=${id}`;
        return deps.getWorkItem(id);
      }),
      getWorkItemDetail: vi.fn(async () => ({ posts: [] })),
      commentWorkItem: vi.fn(async () => ({})),
      // su-ghost has no oracle signal (liveness-unknown); su-live is live; su-gone has ended.
      resolveSubmitterLiveness: vi.fn(async (ownerId: string) =>
        ownerId === 'su-live' ? { sessionState: 'live' } : ownerId === 'su-gone' ? { sessionState: 'ended' } : null),
      resolveVerifiedSubmitterAlias: vi.fn(async () => null),
    };
    const scope = { adopter: 'su-adopter', harnessSlug: HARNESS, workspaceId: WS };
    const payloadOf = async (id: string) => {
      const [row] = await db.adminSql`SELECT taken_by, payload FROM harness_shared.work_items
        WHERE workspace_id=${WS} AND feature_id=${id}`;
      return row as { taken_by: string | null; payload: Record<string, Record<string, unknown>> };
    };

    const head = await adoptNextAgentReviewRevision({ ...scope, filter: buildP2pLaneFence() }, adoptDeps as never);
    expect(head).toMatchObject({
      adopted: false, scanned: 25, refusals: { 'not-submitter:liveness-unknown': 25 },
    });
    expect((await payloadOf('WI-ORPHAN')).taken_by).toBeNull();

    // The next scan skips the stamped full page, then reaches the eligible tail.
    // The fresh same-round stamp is skipped by SQL, the p2p row by the filter.
    const first = await adoptNextAgentReviewRevision({ ...scope, filter: buildP2pLaneFence() }, adoptDeps as never);
    expect(first).toMatchObject({
      adopted: true, workItem: { id: 'WI-ORPHAN' }, scanned: 11,
      refusals: { 'not-submitter:authority-unknown': 1, 'not-submitter:liveness-unknown': 8, 'not-submitter': 1 },
    });
    expect((await payloadOf('WI-SYNTH')).payload.agentReviewAdoptionProbe)
      .toMatchObject({ reason: 'not-submitter:authority-unknown', round: 2 });
    for (const id of ['WI-UNMEASURED', 'WI-STALE-PROBE', 'WI-OLD-ROUND']) {
      const probe = (await payloadOf(id)).payload.agentReviewAdoptionProbe;
      expect(probe).toMatchObject({ reason: 'not-submitter:liveness-unknown', round: 2 });
      expect(Date.parse(String(probe?.at))).toBeGreaterThan(Date.now() - 60_000);
    }
    for (let i = 0; i < 30; i++) {
      expect((await payloadOf(`WI-STABLE-HEAD-${i}`)).payload.agentReviewAdoptionProbe)
        .toMatchObject({ reason: 'not-submitter:liveness-unknown', round: 2 });
    }
    // A live submitter is TRANSIENT: nothing is stamped, so the row keeps being re-checked.
    expect((await payloadOf('WI-LIVE')).payload.agentReviewAdoptionProbe).toBeUndefined();
    expect((await payloadOf('WI-FRESH-PROBE')).payload.agentReviewAdoptionProbe?.at).toBe(freshAt);
    expect((await payloadOf('WI-P2P')).taken_by).toBeNull();

    // Scan 2: the stamped head no longer occupies the window; only the transient row remains.
    const second = await adoptNextAgentReviewRevision({ ...scope, filter: buildP2pLaneFence() }, adoptDeps as never);
    expect(second).toMatchObject({ adopted: false, scanned: 1, refusals: { 'not-submitter': 1 } });

    // FALSIFIABILITY CONTROL for the filter: unscoped, the p2p orphan IS adoptable.
    const unscoped = await adoptNextAgentReviewRevision(scope, adoptDeps as never);
    expect(unscoped).toMatchObject({ adopted: true, workItem: { id: 'WI-P2P' }, scanned: 2 });
  });
});
