/**
 * agent-review-outcome-reconcile.integration.test.ts — WI-10007540 (plan
 * scout-su-ideate-pipeline-gaps-2026-10-08, residue of P-008 / WI-10007529).
 *
 * Measured 2026-10-08: 885 origin='agent-review' routed ideas pointed at a work item
 * that was ALREADY terminal (done / closed / dropped / resolved) yet read outcome NULL.
 * Two defects compounded:
 *   1. Nothing re-checked an agent-review row: the outcome-refresh frontier selects only
 *      scout + su-ideate candidates, so a missed eager write was permanent.
 *   2. Even a refresh would not have settled most of them: gatherCompletionsForOrigin
 *      gave the window-free, ref-scoped terminal read only to scout and su-ideate. An
 *      agent-review route saw the raw change feed alone, which never carries a loss
 *      terminal and drops a win that lacks terminal_completion_ref.
 *
 * Real PG, so the selector SQL and the ref-scoped join are what is under test. The
 * fixture's winning item is deliberately a `resolved` close WITHOUT a completion ref
 * (a work_items:complete close), and its losing item is `dropped`: neither reaches the
 * change feed, so only the agent-review ref-scoped branch can classify them.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

const { recordRoutedIdea, refreshScoutOutcomes, readTerminalUnresolvedRefIdeaIds } =
  await import('./routed-ledger');
const { gatherCompletions } = await import('../curation/change-feed');
const { buildChangeFeedReaders } = await import('../curation/change-feed-deps');
const { createOrgTestDb } = await import('../../test/_org-test-db');

const WS = 'ws-agent-review-outcome-reconcile';
const HARNESS = 'papercup';
const T = Date.parse('2026-10-08T08:00:00Z');

async function outcomeOf(sql: OrgTestDb['adminSql'], ideaId: string): Promise<string | null> {
  const rows = await sql<{ outcome: string | null }[]>`
    SELECT outcome FROM harness_shared.scout_routed_ideas
     WHERE workspace_id = ${WS} AND idea_id = ${ideaId}`;
  return rows[0]?.outcome ?? null;
}

describe('agent-review terminal outcome reconciliation (real PG — WI-10007540)', () => {
  let db: OrgTestDb;
  let envBefore: string | undefined;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    envBefore = process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_WORKSPACE_ID = WS;

    const review = (ideaId: string, ref: string, routedAt: number) =>
      recordRoutedIdea({
        origin: 'agent-review', ideaId, lens: 'agent-review', rail: 'improvement',
        routedRef: `wi:${ref}`, harnessSlug: HARNESS, title: `review ${ref}`,
        workspaceId: WS, routedAt,
      });
    await review('ar-won', 'EI-AR-RESOLVED', T);
    await review('ar-lost', 'EI-AR-DROPPED', T + 1_000);
    await review('ar-open', 'EI-AR-OPEN', T + 2_000);
    await review('ar-settled', 'EI-AR-SETTLED', T + 3_000);
    // A SCOUT row on the same terminal ref: an agent-review pass must never touch it.
    await recordRoutedIdea({
      ideaId: 'scout-same-ref', lens: 'analogical', rail: 'improvement',
      routedRef: 'wi:EI-AR-RESOLVED', harnessSlug: HARNESS, title: 'scout idea, same ref',
      workspaceId: WS, routedAt: T + 4_000,
    });

    await db.adminSql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, scope, title, state, updated_at, terminal_owner, terminal_completion_ref)
      VALUES
        (${WS}, 'EI-AR-RESOLVED', 'harness:papercup', 'reviewed and shipped', 'resolved',
         ${new Date(T + 10_000)}, 'su-reviewer', NULL),
        (${WS}, 'EI-AR-DROPPED', 'harness:papercup', 'reviewed and dropped', 'dropped',
         ${new Date(T + 10_000)}, NULL, NULL),
        (${WS}, 'EI-AR-OPEN', 'harness:papercup', 'still under review', 'open',
         ${new Date(T + 10_000)}, NULL, NULL),
        (${WS}, 'EI-AR-SETTLED', 'harness:papercup', 'already settled', 'resolved',
         ${new Date(T + 10_000)}, 'su-reviewer', NULL)`;
    // The eager path already settled this one: the selector must not re-pick it.
    await db.adminSql`
      UPDATE harness_shared.scout_routed_ideas
         SET outcome = 'won', outcome_checked_at = ${T + 20_000}
       WHERE workspace_id = ${WS} AND idea_id = 'ar-settled'`;
  }, 120_000);

  afterAll(async () => {
    if (envBefore === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
    else process.env.PAPERCUSP_WORKSPACE_ID = envBefore;
    await db?.cleanup();
  });

  it('control: neither terminal reaches the raw change feed, so only the agent-review ref-scoped join can settle them', async () => {
    // Without this, a green run below could come from the feed rather than the new
    // branch in gatherCompletionsForOrigin, and would prove nothing about the fix.
    const feed = await gatherCompletions(buildChangeFeedReaders());
    const refs = new Set(feed.map((e) => e.ref));
    expect(refs.has('wi:EI-AR-RESOLVED')).toBe(false);
    expect(refs.has('wi:EI-AR-DROPPED')).toBe(false);
  });

  it('selects only agent-review routes whose work item is terminal and whose outcome is unresolved', async () => {
    const ids = await readTerminalUnresolvedRefIdeaIds({ workspaceId: WS, origin: 'agent-review' });
    expect([...ids].sort()).toEqual(['ar-lost', 'ar-won']);
  });

  it('refreshing those ids under origin agent-review settles resolved ⇒ won and dropped ⇒ lost, never touching scout rows or lens weights', async () => {
    const weightsBefore = await db.adminSql<{ n: string }[]>`
      SELECT count(*) AS n FROM harness_shared.scout_lens_weights WHERE workspace_id = ${WS}`;
    const ids = await readTerminalUnresolvedRefIdeaIds({ workspaceId: WS, origin: 'agent-review' });
    const report = await refreshScoutOutcomes({
      workspaceId: WS,
      harnessSlug: HARNESS,
      origin: 'agent-review',
      ideaIds: ids,
    });

    const byId = new Map((report.refreshed ?? []).map((e) => [e.ideaId, e]));
    expect(byId.get('ar-won')).toMatchObject({ status: 'won', origin: 'agent-review', sourceRef: 'wi:EI-AR-RESOLVED' });
    expect(byId.get('ar-lost')).toMatchObject({ status: 'lost', origin: 'agent-review', sourceRef: 'wi:EI-AR-DROPPED' });

    expect(await outcomeOf(db.adminSql, 'ar-won')).toBe('won');
    expect(await outcomeOf(db.adminSql, 'ar-lost')).toBe('lost');
    expect(await outcomeOf(db.adminSql, 'ar-open')).toBeNull();
    expect(await outcomeOf(db.adminSql, 'ar-settled')).toBe('won');
    // Origin isolation: the scout row on the same terminal ref keeps its own state.
    expect(await outcomeOf(db.adminSql, 'scout-same-ref')).toBeNull();

    // D-003: agent-review is routing provenance, never lens learning.
    const weightsAfter = await db.adminSql<{ n: string }[]>`
      SELECT count(*) AS n FROM harness_shared.scout_lens_weights WHERE workspace_id = ${WS}`;
    expect(weightsAfter[0]?.n).toBe(weightsBefore[0]?.n);
  });

  it('is idempotent: once settled, the selector returns nothing until an item changes again', async () => {
    const ids = await readTerminalUnresolvedRefIdeaIds({ workspaceId: WS, origin: 'agent-review' });
    expect(ids).toEqual([]);
  });
});
