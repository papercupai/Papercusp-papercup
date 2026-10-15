/**
 * work-items-already-terminally-completed-exclusion.integration.test.ts — the issue-family
 * "already carries a genuine terminal completion but `status` was never flipped" self-select
 * exclusion (EI-8972).
 *
 * `work_items:complete` records a structured completion (`terminal_owner` +
 * `terminal_completion_ref`) but a caller can call it WITHOUT a top-level `state` — the tool
 * warns about it (`stateWarning`) but does not reject it, so the row's `status` can be left
 * sitting in a non-terminal value (e.g. still `open`) even though the item has genuinely been
 * completed/diagnosed by whoever ran it. Without this floor that row stays in the claimable
 * pool and a DIFFERENT agent (possibly a different fleet) self-selects it fresh, re-discovering
 * work a peer already finished — observed live: WI-3646, completed + terminal-owned by one agent
 * as a duplicate of WI-3543, re-claimed whole by another agent via `claim_next` minutes later
 * because `state` was never flipped off `'open'`.
 *
 * Mirrors work-items-needs-human-exclusion.integration.test.ts's shape exactly (same pool-level
 * exclusion pattern, gating on two columns being jointly non-empty instead of a payload key):
 *
 * Proves against real Postgres (testcontainer; Docker required):
 *   • claimNextWorkItem's issue tier SKIPS a row that carries BOTH terminal_owner AND
 *     terminal_completion_ref and serves a real item instead — even when the completed row is
 *     oldest (would otherwise win the oldest-first steal);
 *   • a row with only ONE of the two columns set (a dedup/hygiene flip, per WI-1405's
 *     completion-integrity contract) is NOT excluded — only a GENUINE completion (both set) is;
 *   • a completed row is STILL directly claimable BY ID (the floor only gates self-select);
 *   • diagnoseClaimNextMiss reports an already-completed-ONLY backlog as DRAINED
 *     (pendingUnclaimed===0, drained===true) — it is not work-queue material AT ALL;
 *   • a real ready item alongside a completed one counts fully (the completed row neither
 *     shadows siblings nor inflates the pending/ready counts).
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/work-items-already-terminally-completed-exclusion.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, applyClaimPathReadDeps, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const wi = await import('./work-items');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

/** An issue-family row in the work_items BASE, with an explicit (possibly null) title and
 *  optional terminal_owner / terminal_completion_ref (status stays 'open' unless overridden —
 *  the exact shape a `work_items:complete` call without `state` leaves behind). */
async function seedIssue(
  id: string,
  opts: {
    kind?: string;
    status?: string;
    title?: string | null;
    createdTs?: number;
    terminalOwner?: string | null;
    terminalCompletionRef?: string | null;
  } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts, payload,
       terminal_owner, terminal_completion_ref)
    VALUES (${H}, ${id}, ${opts.kind ?? 'task'}, ${opts.title ?? `title ${id}`}, ${opts.status ?? 'open'}, ${null},
       ${WS}, ${opts.createdTs ?? 0}, 0, ${null}, ${opts.terminalOwner ?? null}, ${opts.terminalCompletionRef ?? null})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('wi-already-terminally-completed');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  // The by-id issue claim auto-subscribes the claimer (coord_entity_subscriptions).
  await ensureCoordCapabilityTables(db.sql);
}, 180_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
  setFlagOverridesForTest({
    [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true,
    [FLAGS.SCHEDULER_MAINTAINED_READY]: false,
  });
});
afterEach(() => setFlagOverridesForTest({}));

describe('claimNextWorkItem SKIPS an already-genuinely-terminally-completed row (EI-8972)', () => {
  it('serves the real item, never a row with BOTH terminal_owner + terminal_completion_ref set, even when oldest', async () => {
    await seedIssue('WI-completed-stray', {
      createdTs: 100,
      terminalOwner: 'su-peer',
      terminalCompletionRef: 'Duplicate of WI-3543',
    });
    await seedIssue('WI-real', { createdTs: 200 });

    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-real');

    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'bee-2' })).toBeNull();

    const rows = await db.sql<{ taken_by: string | null }[]>`
      SELECT taken_by FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = 'WI-completed-stray'`;
    expect(rows[0]?.taken_by).toBeNull();
  });

  it('a row with only terminal_owner set (no terminal_completion_ref) is NOT excluded — must be a GENUINE completion', async () => {
    await seedIssue('WI-partial-owner-only', { createdTs: 100, terminalOwner: 'su-peer', terminalCompletionRef: null });
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-partial-owner-only');
  });

  it('a row with only terminal_completion_ref set (no terminal_owner) is NOT excluded — must be a GENUINE completion', async () => {
    await seedIssue('WI-partial-ref-only', { createdTs: 100, terminalOwner: null, terminalCompletionRef: 'some note' });
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-partial-ref-only');
  });

  it('a completed row is STILL directly claimable by id (the floor only gates self-select)', async () => {
    await seedIssue('WI-completed-direct', {
      createdTs: 100,
      terminalOwner: 'su-peer',
      terminalCompletionRef: 'Duplicate of WI-3543',
    });
    const claimed = await wi.claimWorkItem('WI-completed-direct', 'p2p-fleet', { harness: H });
    expect(claimed?.id).toBe('WI-completed-direct');
    expect(claimed?.assignee).toBe('p2p-fleet');
  });

  // WI-5826: the by-id escape hatch above is deliberate, but for a long time it was also
  // SILENT — work_items:claim returned a bare ok:true on a finished row, so an agent could not
  // tell fresh work from finished work. Confirmed live 2026-07-26 (a fleet member claimed a
  // state='done' row by id and only noticed because they read the returned workItem closely).
  // Both halves are pinned HERE, together, so a future change cannot quietly drop one: the
  // claim must keep SUCCEEDING (EI-8972's decision, asserted above) AND must keep WARNING.
  it('the deliberate by-id claim of a completed row is LOUD — a terminalWarning is attached', async () => {
    const { terminalClaimWarning } = await import('./agent-tools/work_items/claim');
    await seedIssue('WI-completed-warn', {
      createdTs: 100,
      terminalOwner: 'su-peer',
      terminalCompletionRef: 'Duplicate of WI-3543',
    });

    // The escape hatch still works — this must NOT become a refusal.
    const claimed = await wi.claimWorkItem('WI-completed-warn', 'p2p-fleet', { harness: H });
    expect(claimed?.id).toBe('WI-completed-warn');

    // …and the claim can no longer be mistaken for fresh work.
    const warning = terminalClaimWarning(claimed);
    expect(warning).toBeTruthy();
    expect(String(warning)).toMatch(/ALREADY/i);
    expect(String(warning)).toContain('Duplicate of WI-3543');
    expect(String(warning)).toMatch(/NOT fresh work/i);

    // A live (non-terminal) item must stay silent — the warning must not cry wolf on real work.
    await seedIssue('WI-live-row', { createdTs: 101 });
    const live = await wi.claimWorkItem('WI-live-row', 'p2p-fleet', { harness: H });
    expect(terminalClaimWarning(live)).toBeNull();

    // "Finished" has TWO expressions and both must warn. The row above is the
    // terminal_owner+ref shape (state may still be 'open'); this is the terminal-STATE shape,
    // which is what was actually reported live on 2026-07-26.
    expect(terminalClaimWarning({ state: 'done' })).toMatch(/ALREADY DONE/i);
    expect(terminalClaimWarning({ state: 'resolved' })).toBeTruthy();

    // …and the PARTIAL shapes must stay silent, matching EI-8972's rule that only ONE of the
    // two terminal columns is NOT a genuine completion (it has its own tests above asserting
    // such a row remains self-selectable). Warning here would contradict the floor.
    expect(terminalClaimWarning({ state: 'open', terminalOwner: 'su-peer' })).toBeNull();
    expect(terminalClaimWarning({ state: 'open', terminalCompletionRef: 'some note' })).toBeNull();
  });

  it('a normal unclaimed row with no terminal columns set is NOT excluded', async () => {
    await seedIssue('WI-normal', { createdTs: 100 });
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-normal');
  });
});

describe('diagnoseClaimNextMiss treats an already-completed-only backlog as DRAINED (EI-8972)', () => {
  it('pendingUnclaimed === 0 and drained === true (idle is correct — NOT pending-but-gated)', async () => {
    await seedIssue('WI-completed-diag', {
      createdTs: 100,
      terminalOwner: 'su-peer',
      terminalCompletionRef: 'Duplicate of WI-3543',
    });

    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'diag' });
    expect(diag.pendingUnclaimed).toBe(0);
    expect(diag.readyUnclaimed).toBe(0);
    expect(diag.drained).toBe(true);
  });

  it('a real ready item alongside a completed row counts fully (completed row neither shadows nor inflates)', async () => {
    await seedIssue('WI-completed-diag-2', {
      createdTs: 100,
      terminalOwner: 'su-peer',
      terminalCompletionRef: 'Duplicate of WI-3543',
    });
    await seedIssue('WI-ready-diag-2', { createdTs: 200 });

    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'diag' });
    expect(diag.pendingUnclaimed).toBe(1); // ONLY the real item — the completed row is excluded
    expect(diag.readyUnclaimed).toBe(1);
    expect(diag.drained).toBe(false);
  });
});
