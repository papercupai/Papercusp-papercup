/**
 * work-items-claim-issue-scope-reread.integration.test.ts — EI-6480.
 *
 * `work_items:claim_next` intermittently MISSED ("ready but a peer raced you (retry)") while
 * unclaimed, unblocked, open issue-family candidates verifiably existed. Root cause: the
 * issue tier of the claim ladder (`claimNextIssueWorkItem`) claims a row with an atomic
 * `UPDATE … RETURNING` scoped to `issueWs = issuesScopeWorkspace()` captured ONCE, then
 * RE-READ the just-claimed row to build its `WorkItem`. The re-read used the bare
 * `getIssue(id)`, which re-derives `issuesScopeWorkspace()` a SECOND time — and that value
 * can drift between the two calls (its flag cache self-heals on a 3s TTL, flipping
 * `default` ⇄ the active workspace). On a drift the re-read looked in the WRONG workspace,
 * found nothing, and returned `null` — so the claim path returned null WHILE the row was
 * already `taken_by`-set: a LEAKED claim reported to the caller as a spurious retryable race.
 *
 * The fix: re-read in the SAME captured workspace the row was claimed in
 * (`getIssueInWorkspace(issueWs, id)`), immune to scope re-derivation drift; and, defensively,
 * if that exact re-read still misses (a genuine anomaly, never a race) RELEASE the claim and
 * throw — so a fault is loud, not disguised as "retry".
 *
 * This proves against real Postgres (testcontainer; Docker required):
 *   • the fix PRIMITIVE — `getIssueInWorkspace(ws, id)` reads the EXACT workspace passed;
 *   • a legacy-DUPLICATE-id scenario where bare `getIssue(id)` can still return the WRONG
 *     (ambient-workspace, stale) twin instead of the just-claimed row (see the 2026-07-20
 *     note in the first test: `getIssue` was SUBSEQUENTLY hardened by EI-15486 to be
 *     ambient-independent for a single unambiguous row, so it no longer MISSES outright —
 *     but for a duplicate id it still prefers the ambient workspace over recency, which is
 *     the residual reason the claim-reread path must stay pinned to `getIssueInWorkspace`);
 *   • END-TO-END — with the claim's captured workspace DRIFTED away from `getIssue`'s
 *     re-derived scope, `claimNextWorkItem` still returns the claimed item (not a false miss)
 *     and the row is claimed exactly once. This test FAILS against the pre-fix `getIssue` re-read.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/work-items-claim-issue-scope-reread.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, applyClaimPathReadDeps, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  failIssueRead: false,
  issueReadClients: [] as unknown[],
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});
// Drift the workspace scope the CLAIM PATH captures (work-items.ts imports this symbol) away
// from the scope the module-internal `getIssue` re-derives. Overriding only the EXPORTS leaves
// issues-engineer's own internal `issuesScopeWorkspace()`/`resolveIssuesScopeWorkspace()` calls
// (used by the real `getIssue`, a SAME-FILE call vi.mock cannot intercept) intact at their
// flag-OFF default ('default') — exactly the two-derivations-disagree state EI-6480 hit in
// production. `getIssueInWorkspace` (the fix) is left REAL: it takes the workspace as a
// parameter and never calls either scope-resolver, so it is immune to this drift.
//
// WI-5261: `claimNextIssueWorkItem`'s claim-time scope now goes through
// `resolveIssuesScopeWorkspace(explicitActiveWorkspaceId)` (work-items.ts, imported from this
// module) rather than the bare `issuesScopeWorkspace()` — mock BOTH exports the same way (both
// unconditionally return CLAIM_WS, ignoring any argument) so the simulated drift still reaches
// the claim path exactly as before; the mocked function's own arg is irrelevant here since the
// point is "whatever value production logic would compute, this test forces it to CLAIM_WS,
// independent from `activeWorkspaceId`'s separately-mocked 'default'".
const CLAIM_WS = 'ws-drift';
vi.mock('./issues-engineer', async () => {
  const actual = await vi.importActual<typeof import('./issues-engineer')>('./issues-engineer');
  return {
    ...actual,
    issuesScopeWorkspace: () => CLAIM_WS,
    resolveIssuesScopeWorkspace: () => CLAIM_WS,
    getIssueInWorkspace: (...args: Parameters<typeof actual.getIssueInWorkspace>) => {
      h.issueReadClients.push(args[2]?.client);
      if (h.failIssueRead) return Promise.reject(new Error('synthetic issue reread failure'));
      return actual.getIssueInWorkspace(...args);
    },
  };
});

const wi = await import('./work-items');
const ie = await import('./issues-engineer');

const H = 'papercup';
let db: FreshPgDb;
let statementObserver: ((query: string) => void) | null = null;

/** An issue-family (bug/change/task) row in the work_items BASE, in an EXPLICIT workspace. */
async function seedIssueInWorkspace(
  id: string,
  workspaceId: string,
  opts: { status?: string; takenBy?: string | null; createdTs?: number; updatedTs?: number; harnessSlug?: string } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts)
    VALUES (${opts.harnessSlug ?? H}, ${id}, 'bug', ${`title ${id}`}, ${opts.status ?? 'open'}, ${opts.takenBy ?? null},
       ${workspaceId}, ${opts.createdTs ?? 0}, ${opts.updatedTs ?? 0})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('wi-claim-issue-scope-reread', {
    onQuery: (query) => statementObserver?.(query),
  });
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
}, 180_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  h.failIssueRead = false;
  h.issueReadClients.length = 0;
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
  // Issue tier ON (self-select over bug/change/task); inline readiness (no maintained sidecar).
  setFlagOverridesForTest({
    [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true,
    [FLAGS.SCHEDULER_MAINTAINED_READY]: false,
  });
});
afterEach(() => setFlagOverridesForTest({}));

describe('EI-6480 — issue-claim re-read is workspace-exact, not scope-re-deriving', () => {
  it('getIssueInWorkspace reads the EXACT workspace regardless of ambient scope drift', async () => {
    // The issue lives in CLAIM_WS; the module-internal scope (flag OFF) is 'default'.
    await seedIssueInWorkspace('EI-scope', CLAIM_WS);

    // The workspace-exact read (the EI-6480 fix) finds the row regardless of the derived scope.
    const exact = await ie.getIssueInWorkspace(CLAIM_WS, 'EI-scope');
    expect(exact?.id).toBe('EI-scope');
    expect(exact?.kind).toBe('bug');

    // NOTE (2026-07-20): bare `getIssue` was SUBSEQUENTLY hardened by EI-15486 to be
    // ambient-independent — it now resolves an issue's ACTUAL workspace by id
    // (`resolveIssueWorkspace`) instead of trusting a bare `issuesScopeWorkspace()`
    // derivation, so it no longer exhibits the original "re-derived scope looks in the
    // wrong workspace and misses" symptom for a SINGLE unambiguous row: it finds this
    // row too, in any workspace. That is a strict improvement over the old miss, so this
    // is no longer a `toBeNull()` regression assertion — see the next test for the
    // narrower case (a legacy duplicate id across workspaces) where the two reads still
    // genuinely disagree and `getIssueInWorkspace` remains the one the atomic
    // claim-then-reread path must use.
    expect((await ie.getIssue('EI-scope'))?.id).toBe('EI-scope');
  });

  it('a legacy DUPLICATE issue id (EI-7808: same issue_id, distinct physical harness_slug rows) across workspaces still needs getIssueInWorkspace: getIssue can prefer a stale ambient-workspace twin over the just-claimed row', async () => {
    // `work_items`'s PK is (harness_slug, feature_id) — NOT workspace-scoped — so two rows
    // sharing an issue_id can only coexist with DIFFERENT physical harness_slug values (the
    // EI-7808 legacy-dupe shape, e.g. '' beside 'papercup'), same as production. A stale twin
    // sits under the ambient workspace ('default', flag OFF) — e.g. a pre-migration leftover —
    // while the row that was JUST atomically claimed lives in CLAIM_WS with a newer updated_ts.
    // `resolveIssueWorkspace` prioritizes an AMBIENT workspace match over recency (ORDER BY
    // (workspace_id = ambient) DESC, updated_at DESC), so bare `getIssue` picks the wrong
    // (stale, differently-assigned) twin here — exactly the silent-wrong-row hazard
    // `getIssueInWorkspace(claimedWs, id)` (the EI-6480 fix, pinned to the SAME workspace the
    // atomic UPDATE just claimed in) avoids.
    await seedIssueInWorkspace('EI-dup', 'default', { takenBy: 'stale-twin', updatedTs: 1, harnessSlug: '' });
    await seedIssueInWorkspace('EI-dup', CLAIM_WS, { takenBy: 'w1', updatedTs: 1_000_000 });

    expect((await ie.getIssue('EI-dup'))?.assignee).toBe('stale-twin');
    const exact = await ie.getIssueInWorkspace(CLAIM_WS, 'EI-dup');
    expect(exact?.assignee).toBe('w1');
  });

  it('counts executed statements without counting interpolated tagged SQL fragments', async () => {
    const statementTexts: string[] = [];
    statementObserver = (query) => statementTexts.push(query);
    try {
      const fragment = db.sql`1`;
      expect(statementTexts).toEqual([]);
      await db.sql`SELECT 1 ORDER BY ${fragment}`;
      expect(statementTexts).toHaveLength(1);
      expect(statementTexts[0]).toMatch(/SELECT 1 ORDER BY 1/);
    } finally {
      statementObserver = null;
    }
  });

  it('WI-10003631: getIssue is ONE statement and, with no ambient twin, returns the freshest row across workspaces; a miss is one statement too', async () => {
    // The old two-step (resolveIssueWorkspace → getIssueInWorkspace) picked the freshest
    // row's workspace, then the freshest twin inside it — the same row the single ordered
    // read returns. Two non-ambient workspaces, freshest in ws-b.
    await seedIssueInWorkspace('EI-one', 'ws-a', { takenBy: 'older', updatedTs: 10, harnessSlug: '' });
    await seedIssueInWorkspace('EI-one', 'ws-b', { takenBy: 'newer', updatedTs: 1_000 });
    const statementTexts: string[] = [];
    statementObserver = (query) => statementTexts.push(query);
    try {
      expect((await ie.getIssue('EI-one'))?.assignee).toBe('newer');
      expect(statementTexts, JSON.stringify(statementTexts)).toHaveLength(1);
      statementTexts.length = 0;
      expect(await ie.getIssue('EI-missing')).toBeNull();
      expect(statementTexts, JSON.stringify(statementTexts)).toHaveLength(1);
    } finally {
      statementObserver = null;
    }
  });

  it('remote-origin issue rows surface provenance and refuse local set_state with a truthful error', async () => {
    await seedIssueInWorkspace('WI-remote', 'default', { status: 'open' });
    await db.sql`
      UPDATE harness_shared.work_items
         SET origin = 'remote'
       WHERE workspace_id = 'default' AND feature_id = 'WI-remote'`;

    const item = await wi.getWorkItem('WI-remote', H);
    expect(item?.family).toBe('issue');
    expect(item?.origin).toBe('remote');

    await expect(
      wi.setWorkItemState('WI-remote', 'resolved', {
        harness: H,
        by: 'w1',
        completionRef: 'verified elsewhere',
      }),
    ).rejects.toThrow(/remote-authored.*cannot be mutated locally/);

    const rows = await db.sql<{ status: string; terminal_owner: string | null }[]>`
      SELECT status, terminal_owner
        FROM harness_shared.work_items
       WHERE workspace_id = 'default' AND feature_id = 'WI-remote'`;
    expect(rows[0]).toEqual({ status: 'open', terminal_owner: null });
  });

  // EI-19313515375179600 (WI-6822 follow-up): `origin` can flip local→remote well after
  // creation (root cause still under investigation), stranding the TRUE author — the guard
  // above is correct for a genuinely foreign-authored row, but wrong when the caller IS the
  // row's own recorded author. selfHealAuthorOriginIfStranded resets the base-table `origin`
  // back to 'local' (identity-gated: only ever a row whose OWN created_by matches the caller)
  // BEFORE the write, so it isn't ALSO silently blocked by the trigger's unconditional
  // `origin='remote'` no-op (migration 655, mirrored in this test schema above).
  it("a row's own AUTHOR is never stranded by a wrongly-flipped origin: set_state self-heals and the write succeeds", async () => {
    await seedIssueInWorkspace('WI-self-heal', 'default', { status: 'open' });
    await db.sql`
      UPDATE harness_shared.work_items
         SET origin = 'remote', payload = '{"_ei":{"created_by":"w1"}}'::jsonb
       WHERE workspace_id = 'default' AND feature_id = 'WI-self-heal'`;

    const before = await wi.getWorkItem('WI-self-heal', H);
    expect(before?.origin).toBe('remote');
    expect(before?.createdBy).toBe('w1');

    // The caller (by:'w1') IS the recorded author — must NOT be refused, unlike the
    // genuinely-foreign-authored 'WI-remote' case immediately above.
    const result = await wi.setWorkItemState('WI-self-heal', 'resolved', {
      harness: H,
      by: 'w1',
      completionRef: 'verified elsewhere',
    });
    // work-item-status-full-unify (migration 638): the unified surface normalizes the
    // legacy 'resolved'/'passed' spellings onto 'done' (and 'closed'/'deprecated' onto
    // 'dropped') — this is the SAME normalization the pre-existing 'remote-origin issue
    // rows...' test above would have hit too, had its refusal not short-circuited before
    // ever reaching a real state write.
    expect(result?.state).toBe('done');

    const rows = await db.sql<{ status: string; origin: string; terminal_owner: string | null }[]>`
      SELECT status, origin, terminal_owner
        FROM harness_shared.work_items
       WHERE workspace_id = 'default' AND feature_id = 'WI-self-heal'`;
    expect(rows[0]).toEqual({ status: 'done', origin: 'local', terminal_owner: 'w1' });
  });

  it('a DIFFERENT caller (not the recorded author) on the SAME wrongly-flipped row is still correctly refused — self-heal never fires for a non-author', async () => {
    await seedIssueInWorkspace('WI-not-author', 'default', { status: 'open' });
    await db.sql`
      UPDATE harness_shared.work_items
         SET origin = 'remote', payload = '{"_ei":{"created_by":"w1"}}'::jsonb
       WHERE workspace_id = 'default' AND feature_id = 'WI-not-author'`;

    // 'w2' did not author this row — the guard must still refuse, exactly as before this fix.
    await expect(
      wi.setWorkItemState('WI-not-author', 'resolved', {
        harness: H,
        by: 'w2',
        completionRef: 'verified elsewhere',
      }),
    ).rejects.toThrow(/remote-authored.*cannot be mutated locally/);

    const rows = await db.sql<{ status: string; origin: string }[]>`
      SELECT status, origin
        FROM harness_shared.work_items
       WHERE workspace_id = 'default' AND feature_id = 'WI-not-author'`;
    expect(rows[0]).toEqual({ status: 'open', origin: 'remote' });
  });

  it('updateWorkItem (field-edit) likewise self-heals for the true author instead of returning remote_origin_not_editable', async () => {
    await seedIssueInWorkspace('WI-edit-heal', 'default', { status: 'open' });
    await db.sql`
      UPDATE harness_shared.work_items
         SET origin = 'remote', payload = '{"_ei":{"created_by":"w1"}}'::jsonb
       WHERE workspace_id = 'default' AND feature_id = 'WI-edit-heal'`;

    const res = await wi.updateWorkItem('WI-edit-heal', { title: 'corrected title' }, 'w1', { harness: H });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.item.title).toBe('corrected title');

    const rows = await db.sql<{ origin: string }[]>`
      SELECT origin FROM harness_shared.work_items
       WHERE workspace_id = 'default' AND feature_id = 'WI-edit-heal'`;
    expect(rows[0]?.origin).toBe('local');
  });

  // WI-10006515: `origin` records how a row ARRIVED, not who wrote it. A row whose author key
  // this workspace has written locally is OURS even when no caller matches its created_by
  // (system-filed rows), so the field-edit and needs-human paths must not strand it.
  const OWN_KEY = 'f89879623b37aaaa';
  const PEER_KEY = 'beef0000peer1111';
  async function seedStranded(id: string, author: string): Promise<void> {
    await seedIssueInWorkspace(id, 'default', { status: 'open' });
    await db.sql`
      UPDATE harness_shared.work_items
         SET origin = 'remote', author_pubkey = ${author},
             payload = '{"_ei":{"created_by":"system:capture"}}'::jsonb
       WHERE workspace_id = 'default' AND feature_id = ${id}`;
  }
  async function originOf(id: string): Promise<string | null> {
    const [r] = await db.sql<{ origin: string | null }[]>`
      SELECT origin FROM harness_shared.work_items WHERE workspace_id = 'default' AND feature_id = ${id}`;
    return r?.origin ?? null;
  }
  async function seedOwnKeyWitness(): Promise<void> {
    await seedIssueInWorkspace('WI-own-witness', 'default', { status: 'open' });
    await db.sql`
      UPDATE harness_shared.work_items SET origin = 'local', author_pubkey = ${OWN_KEY}
       WHERE workspace_id = 'default' AND feature_id = 'WI-own-witness'`;
  }

  it('WI-10006515: updateWorkItem heals an OWN-NODE row stranded at remote for a non-author caller', async () => {
    await seedOwnKeyWitness();
    await seedStranded('WI-own-edit', OWN_KEY);
    const res = await wi.updateWorkItem('WI-own-edit', { title: 'own-node edit' }, 'w9', { harness: H });
    expect(res.ok).toBe(true);
    expect(await originOf('WI-own-edit')).toBe('local');
  });

  it('WI-10006515 control: updateWorkItem still refuses a TRUE peer row (author key never written here)', async () => {
    await seedOwnKeyWitness();
    await seedStranded('WI-peer-edit', PEER_KEY);
    const res = await wi.updateWorkItem('WI-peer-edit', { title: 'peer edit' }, 'w9', { harness: H });
    expect(res).toMatchObject({ ok: false, reason: 'remote_origin_not_editable' });
    expect(await originOf('WI-peer-edit')).toBe('remote');
  });

  it('WI-10006515: ownNodeAuthoredRemoteIds classifies own-node strands, excludes peers and local rows, never writes', async () => {
    const { ownNodeAuthoredRemoteIds } = await import('./work-items-admission');
    await seedOwnKeyWitness();
    await seedStranded('WI-own-batch', OWN_KEY);
    await seedStranded('WI-peer-batch', PEER_KEY);
    const own = await ownNodeAuthoredRemoteIds('default', ['WI-own-batch', 'WI-peer-batch', 'WI-own-witness', 'WI-absent']);
    expect([...own]).toEqual(['WI-own-batch']);
    expect(await originOf('WI-own-batch')).toBe('remote');
    expect(await ownNodeAuthoredRemoteIds('other-ws', ['WI-own-batch'])).toEqual(new Set());
  });

  it('WI-10006515: a needs-human request on an OWN-NODE stranded row is not short-circuited as remote-owned', async () => {
    await seedOwnKeyWitness();
    await seedStranded('WI-own-nh', OWN_KEY);
    const outcome = await wi
      .setWorkItemStateWithAliasInfo('WI-own-nh', 'needs-human', { harness: H, by: 'w9' })
      .then(
        (r) => ({ note: r.aliasNote ?? '' }),
        (e: unknown) => ({ note: String(e) }),
      );
    // Reaches the canonical writer (which applies its own structured-ask rule) instead of
    // being answered "remote-owned" by the wrapper.
    expect(outcome.note).not.toMatch(/remote-owned|remote-authored/);
  });

  it('WI-10006515 control: a needs-human request on a TRUE peer row is still answered remote-owned', async () => {
    await seedOwnKeyWitness();
    await seedStranded('WI-peer-nh', PEER_KEY);
    const r = await wi.setWorkItemStateWithAliasInfo('WI-peer-nh', 'needs-human', { harness: H, by: 'w9' });
    expect(r.aliasNote ?? '').toMatch(/remote-owned/);
    expect(await originOf('WI-peer-nh')).toBe('remote');
  });

  it('claim_next SERVES an open issue even when the captured claim scope has drifted from getIssue’s re-derived scope (no leaked claim, no false miss)', async () => {
    // Row is in CLAIM_WS — the scope claimNextIssueWorkItem captures (issuesScopeWorkspace mock).
    // getIssue's own re-derivation would be 'default' (drift) and would MISS it → the pre-fix
    // path returned null while the row stayed claimed. The fix re-reads in CLAIM_WS and returns it.
    await seedIssueInWorkspace('EI-serve', CLAIM_WS, { createdTs: 100 });

    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'w1' });
    expect(got?.id).toBe('EI-serve'); // NOT a null miss — the pre-fix getIssue re-read returned null here
    expect(got?.family).toBe('issue');
    expect(got?.assignee).toBe('w1');
    expect(h.issueReadClients).toHaveLength(1);
    expect(h.issueReadClients[0]).toBeDefined(); // transaction client, not the raw admin pool
    expect(h.issueReadClients[0]).not.toBe(db.sql);

    // Claimed exactly once, and to w1 — the mutation is neither leaked nor lost.
    const rows = await db.sql<{ taken_by: string | null }[]>`
      SELECT taken_by FROM harness_shared.work_items
       WHERE workspace_id = ${CLAIM_WS} AND feature_id = 'EI-serve'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].taken_by).toBe('w1');

    // Pool now genuinely empty ⇒ a subsequent claim is a real (null) miss, not a spurious one.
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'w2' })).toBeNull();
  });

  it('rolls back the issue claim if the in-transaction reread fails', async () => {
    await seedIssueInWorkspace('EI-reread-fails', CLAIM_WS, { createdTs: 100 });
    h.failIssueRead = true;
    try {
      await expect(wi.claimNextWorkItem({ harness: H, assignee: 'w1' }))
        .rejects.toThrow('synthetic issue reread failure');
    } finally {
      h.failIssueRead = false;
    }

    const rows = await db.sql<{ taken_by: string | null }[]>`
      SELECT taken_by FROM harness_shared.work_items
       WHERE workspace_id = ${CLAIM_WS} AND feature_id = 'EI-reread-fails'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].taken_by).toBeNull();
    expect(h.issueReadClients).toHaveLength(1);
    expect(h.issueReadClients[0]).toBeDefined();
    expect(h.issueReadClients[0]).not.toBe(db.sql);
  });
});
