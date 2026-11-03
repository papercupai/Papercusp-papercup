/**
 * reconcile-linked-work-items.integration.test.ts — EI-5925.
 *
 * Mirrors convert.integration.test.ts's strategy: the `../work-items` module
 * (getWorkItem / setWorkItemState / isSettledWorkItemState) is mocked so each
 * WorkItem's shape (state / lastProgressAt / family) is fully controlled per
 * test, while `coord_links` + `harness_features_consolidated` / `engineer_issues`
 * are REAL Postgres (the same lightweight schema fixture, so the actual SQL --
 * the `implements` edge lookup AND the `payload.plan_item` stamp-unwrap match --
 * is proven, not assumed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { PLAN_ITEM_KIND, planItemRef } from '../issue-blocks-merge';
// NOTE (WI-10004585): do NOT statically import './convert' (or anything else that
// reaches '../agent-tools/plans/source') here — see the SUT import below.

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

interface StubWorkItem {
  id: string;
  harness: string | null;
  state: string;
  family: 'issue' | 'feature';
  lastProgressAt: string | null;
  /** WI-6303: the in-flight guards now require a LIVE assignee alongside
   *  lastProgressAt (a stale timestamp with no current holder is reclaimed
   *  residue, not real in-flight work). Defaults to null (unclaimed). */
  assignee?: string | null;
  payload?: Record<string, unknown> | null;
}

const h2 = vi.hoisted(() => ({
  items: new Map<string, StubWorkItem>(),
  setWorkItemState: vi.fn(async (id: string, state: string) => {
    const wi = h2.items.get(id);
    if (wi) wi.state = state;
    return wi ?? null;
  }),
  // EI-18732669095544832: the lane-sync GATE leg (applyLaneGateToWorkItem)
  // flips state through setWorkItemStateWithAliasInfo, not plain
  // setWorkItemState — needed once tests below exercise resyncPlanItemLaneNow.
  setWorkItemStateWithAliasInfo: vi.fn(async (id: string, state: string) => {
    const wi = h2.items.get(id);
    if (wi) wi.state = state;
    return wi ? { workItem: wi } : null;
  }),
}));
const setWorkItemState = h2.setWorkItemState;
const setWorkItemStateWithAliasInfo = h2.setWorkItemStateWithAliasInfo;
// EI-18653945816361859: recording stubs for the stale-lane-hold clear path —
// mergeWorkItemPayload / setWorkItemClaimHold apply directly to the in-memory
// stub so a subsequent activeExternalBlockers/readWorkItemHeldOpenBy read (the
// REAL pure functions, imported actual below) sees the mutation.
const h4 = vi.hoisted(() => ({
  mergeWorkItemPayload: vi.fn(async (id: string, patch: Record<string, unknown>, opts?: { unset?: string[] }) => {
    const wi = h2.items.get(id);
    if (wi) {
      const payload = { ...(wi.payload ?? {}), ...patch };
      for (const key of opts?.unset ?? []) delete payload[key];
      wi.payload = payload;
    }
    return wi ?? null;
  }),
  setWorkItemClaimHold: vi.fn(
    async (id: string, hold: boolean, opts?: { leaseOnly?: boolean; expectedLeaseHolder?: string }) => {
      const wi = h2.items.get(id);
      if (wi?.payload && !hold) {
        const next = { ...wi.payload };
        const hasDurablePark = typeof next.claim_hold_by === 'string' && next.claim_hold_by.length > 0;
        delete next.held_open_by;
        delete next.held_open_at;
        delete next.held_open_reason;
        if (!(opts?.leaseOnly && hasDurablePark)) {
          delete next._claimHold;
          delete next.claim_hold_by;
          delete next.claim_hold_at;
          delete next.claim_hold_reason;
        }
        wi.payload = next;
      }
      return wi ? { id, harness: wi.harness, hold, applicable: true } : null;
    },
  ),
}));
vi.mock('../work-items', async () => {
  const actual = await vi.importActual<typeof import('../work-items')>('../work-items');
  return {
    // P-006: the ungate path dynamically imports work-items-events, which in turn
    // imports additional pure work-items exports. Spread the real module first,
    // then override only the stateful I/O seams this fixture owns. A hand-listed
    // export mock turns every newly imported helper into a swallowed `noop` and
    // makes lane-sync assertions fail without revealing the missing export.
    ...actual,
    getWorkItem: (id: string) => h2.items.get(id) ?? null,
    setWorkItemState: h2.setWorkItemState,
    setWorkItemStateWithAliasInfo: h2.setWorkItemStateWithAliasInfo,
    mergeWorkItemPayload: h4.mergeWorkItemPayload,
    setWorkItemClaimHold: h4.setWorkItemClaimHold,
  };
});

// EI-8970: the stale-read guard's plan re-read. Defaults to `null` (no row
// resolvable) for every pre-existing test above — matching the guard's
// fail-open behaviour and leaving all prior assertions unaffected; only the
// new "EI-8970" describe block below overrides it per-test.
const h3 = vi.hoisted(() => ({
  getPlanRow: vi.fn(
    async (_slug: string, _opts?: unknown) =>
      null as {
        planSlug?: string;
        content?: string;
        items: {
          id: string;
          status: string;
          blockedBy?: string[];
          text?: string;
          decisionRefs?: string[];
        }[];
        // EI-19319970920449941: optional in every pre-existing test (defaults to
        // undefined -> the reconciler treats a missing field as "no decisions").
        decisions?: { id: string; title: string; body: string; date: string | null; itemRefs: string[] }[];
        nowNext?: string | null;
      } | null,
  ),
}));
// EI-18732669095544832: `classifyPlanLane` (the new resyncPlanItemLaneNow's lane
// classifier) also imports `planItemsForRow` off this SAME module — a real, pure
// function with no I/O. Only `getPlanRow` needs mocking (the stale-read guard's
// re-read target); passing through the real `planItemsForRow` via importActual
// keeps that lane-classification path exercised for real instead of undefined.
vi.mock('../agent-tools/plans/source', async () => {
  const actual = await vi.importActual<typeof import('../agent-tools/plans/source')>('../agent-tools/plans/source');
  return { ...actual, getPlanRow: h3.getPlanRow };
});

// WI-10004553: pin the per-workspace coord scope to a tenant DISTINCT from the default,
// as on the live box, so the split implements-link plane is actually split here. With
// both resolving to 'default' a reader pinned to one tenant passes vacuously.
const { COORD_SCOPE_WS } = vi.hoisted(() => ({ COORD_SCOPE_WS: 'tenant-coord-scope' }));
vi.mock('../agent-tools/coordination/log', async () => {
  const actual = await vi.importActual<typeof import('../agent-tools/coordination/log')>(
    '../agent-tools/coordination/log',
  );
  return { ...actual, coordScopeWorkspace: () => COORD_SCOPE_WS };
});

const {
  reconcileLinkedWorkItemsForPlanItem,
  reconcileOrphanedPlanItemWorkItems,
  reconcilePlanAuthoredDependenciesNow,
  resyncDependentPlanItemLanesNow,
  resyncPlanItemLaneNow,
  syncLinkedWorkItemsToPlanLane,
  planLaneBlockerRef,
  PLAN_AUTHORED_BLOCKERS_KEY,
} = await import('./reconcile-linked-work-items');
// WI-10004585: the SUT MUST be the first module to import '../agent-tools/plans/source'.
// source.ts statically reaches the SUT (source → fleet-drained-events → events/await →
// … → events/builtin-actions → reconcile-linked-work-items). If anything ELSE imports
// source first (this file used to `import { IMPLEMENTS_REL } from './convert'` at the
// top; convert.ts imports source), the h3 mock factory's vi.importActual evaluates
// the SUT for the FIRST time from inside the factory — and Vitest resolves a mocked
// id that is already on the factory callstack to the REAL module, so the SUT binds
// the real getPlanRow forever. 20 getPlanRow-driven tests then fail confusingly
// (2026-09-04 → 2026-10-01). The 'mock wiring' test below pins the order.
const { IMPLEMENTS_REL } = await import('./convert');
const { getFeatureBlockers, syncFeatureBlockEdges } = await import('../dbos/feature-blockers-edges');
const { mirrorWorkItemBlockingEdge } = await import('../dbos/work-item-deps-store');
const { fireBuiltinReactionAction, PLAN_ITEM_LANE_RESYNC_ACTION } = await import('../events/builtin-actions');
const { activeExternalBlockers, updateExternalBlockerHistory } = await import('../external-blockers');
const { isClaimHoldParked } = await import('../work-items');

const WS = DEFAULT_COORD_WORKSPACE;
let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `recwi_${randomBytes(5).toString('hex')}`;
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
    CREATE TABLE harness_shared.coord_links (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      workspace_id text DEFAULT 'default' NOT NULL,
      src_kind text NOT NULL, src_ref text NOT NULL,
      dst_kind text NOT NULL, dst_ref text NOT NULL,
      rel text NOT NULL, created_by text,
      created_at timestamptz DEFAULT now() NOT NULL
    )`);
  await rootSql.unsafe(`
    CREATE UNIQUE INDEX coord_links_identity_uq
      ON harness_shared.coord_links (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel)
  `);
  await rootSql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await rootSql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.coord_links, harness_shared.work_items, harness_shared.work_item_deps, harness_shared.plan_items`;
  h2.items.clear();
  setWorkItemState.mockClear();
  setWorkItemStateWithAliasInfo.mockClear();
  h3.getPlanRow.mockReset();
  h3.getPlanRow.mockResolvedValue(null);
});

async function edge(o: { plan: string; item: string; srcKind?: string; srcRef: string; workspace?: string }) {
  await rootSql`
    INSERT INTO harness_shared.coord_links (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel)
    VALUES (${o.workspace ?? WS}, ${o.srcKind ?? 'issue'}, ${o.srcRef}, ${PLAN_ITEM_KIND},
            ${planItemRef(o.plan, o.item)}, ${IMPLEMENTS_REL})`;
}

function stub(over: Partial<StubWorkItem> & { id: string }): StubWorkItem {
  const wi: StubWorkItem = {
    harness: 'sheets',
    state: 'open',
    family: 'issue',
    lastProgressAt: null,
    assignee: null,
    ...over,
  };
  h2.items.set(wi.id, wi);
  return wi;
}

/**
 * Insert a REAL base-table work-item row carrying a `payload.plan_item` stamp — the
 * source the periodic sweep's candidate query (harness_shared.work_items) AND
 * findAllLinkedWorkItems's stamp backstop both read. getWorkItem is still the mock,
 * so pair each row with a `stub` of the same id. Payload is a plain jsonb object,
 * matching production (verified: every live stamped payload is object-shaped).
 */
async function insertWorkItemRow(o: {
  id: string;
  kind: 'feature' | 'bug';
  status: string;
  planSlug: string;
  itemId: string;
  harness?: string;
  linkage?: 'payload' | 'columns';
}) {
  // jsonb_build_object (NOT `${jsonString}::jsonb`) — postgres.js binds a JS string
  // under a ::jsonb cast as a jsonb STRING-SCALAR, not an object, which then trips
  // the engineer_issues view's `(payload - '_ei')` ("cannot delete from scalar").
  // Production payloads are object-shaped (verified live), so build an object here.
  await rootSql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, status, payload,
       source_plan_slug, source_plan_item_ids, created_ts, updated_ts)
    VALUES (${WS}, ${o.harness ?? 'sheets'}, ${o.id}, ${o.kind}, ${o.status},
            ${
              o.linkage === 'columns'
                ? rootSql.json({})
                : rootSql`jsonb_build_object('plan_item', jsonb_build_object('plan_slug', ${o.planSlug}::text, 'item_id', ${o.itemId}::text))`
            },
            ${o.linkage === 'columns' ? o.planSlug : null},
            ${o.linkage === 'columns' ? [o.itemId] : []},
            0, 0)`;
}

/** Seed endpoint rows for canonical dependency admission while the work-item API remains mocked. */
async function insertDependencyRows(ids: readonly string[], harness = 'sheets') {
  for (const id of ids) {
    await rootSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, payload, created_ts, updated_ts)
      VALUES (${WS}, ${harness}, ${id}, 'feature', 'open', '{}'::jsonb, 0, 0)`;
  }
}

async function withExpectedLaneWarning<T>(run: () => Promise<T>, fragment: string): Promise<T> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const result = await run();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(fragment));
    return result;
  } finally {
    warn.mockRestore();
  }
}

describe('mock wiring (WI-10004585)', () => {
  it('the SUT reads plan status through the h3.getPlanRow mock, not the real source module', async () => {
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-wire', status: 'wip' }] });

    await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p-wiring', itemId: 'P-wire' });

    expect(
      h3.getPlanRow.mock.calls.map((c) => c[0]),
      'reconcile-linked-work-items bound the REAL getPlanRow: something imported ' +
        "'../agent-tools/plans/source' before the SUT (see the WI-10004585 note at the SUT import). " +
        'Every getPlanRow-driven assertion in this file is meaningless until the import order is fixed.',
    ).toContain('p-wiring');
  });
});

describe('reconcileLinkedWorkItemsForPlanItem (PG, EI-5925)', () => {
  it('resolves a non-terminal, no-progress linked work-item via the implements edge', async () => {
    stub({ id: 'WI-mirror-1', state: 'open', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-001', srcRef: 'WI-mirror-1' });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-001' });

    expect(result.reconciled).toEqual(['WI-mirror-1']);
    expect(result.skippedInFlight).toEqual([]);
    expect(result.skippedAlreadyTerminal).toEqual([]);
    expect(setWorkItemState).toHaveBeenCalledWith(
      'WI-mirror-1',
      'resolved',
      expect.objectContaining({ by: 'system:plan-item-reconcile' }),
    );
  });

  it('never clobbers a linked item carrying independent in-flight progress', async () => {
    stub({ id: 'WI-active', state: 'open', lastProgressAt: '2026-07-02T00:00:00Z', assignee: 'su-live-holder' });
    await edge({ plan: 'p1', item: 'P-002', srcRef: 'WI-active' });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-002' });

    expect(result.reconciled).toEqual([]);
    expect(result.skippedInFlight).toEqual(['WI-active']);
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('EI-22178190387074148: never terminal-closes a linked item in state `blocked` — that state is the authority, not a phantom-todo', async () => {
    // The reported repro: an unclaimed issue-family work-item carrying an open
    // owner-decision question (state='blocked', no assignee, real implements
    // edge) was silently closed when a sibling plan item was dropped.
    stub({ id: 'WI-gated', state: 'blocked', lastProgressAt: null, assignee: null });
    await edge({ plan: 'p1', item: 'P-010', srcRef: 'WI-gated' });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-010' });

    expect(result.reconciled).toEqual([]);
    expect(result.skippedGatedState).toEqual(['WI-gated']);
    expect(result.skippedInFlight).toEqual([]);
    expect(result.skippedUnprovenLink).toEqual([]);
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('EI-22178190387074148: never terminal-closes a linked item in state `needs-human`', async () => {
    stub({ id: 'WI-gated-2', state: 'needs-human', lastProgressAt: null, assignee: null });
    await edge({ plan: 'p1', item: 'P-011', srcRef: 'WI-gated-2' });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-011' });

    expect(result.reconciled).toEqual([]);
    expect(result.skippedGatedState).toEqual(['WI-gated-2']);
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('EI-22178190387074148: a `blocked` item that is ALSO actively claimed still never closes — the gated-state guard runs first', async () => {
    // Ordering sanity: whichever guard trips, the item must never close. The
    // gated-state check runs before the in-flight check (state is the more
    // fundamental "don't touch" signal, independent of who — if anyone — holds
    // it), so it lands in skippedGatedState here, not skippedInFlight. Pinning
    // the bucket, not just "never closes", so a future reordering is a visible,
    // deliberate test change rather than a silent behavior drift.
    stub({
      id: 'WI-gated-claimed',
      state: 'blocked',
      lastProgressAt: '2026-07-02T00:00:00Z',
      assignee: 'su-live-holder',
    });
    await edge({ plan: 'p1', item: 'P-012', srcRef: 'WI-gated-claimed' });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-012' });

    expect(result.reconciled).toEqual([]);
    expect(result.skippedGatedState).toEqual(['WI-gated-claimed']);
    expect(result.skippedInFlight).toEqual([]);
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('WI-6303: a STALE lastProgressAt with NO current assignee is reconciled, not skipped as in-flight', async () => {
    // Root cause: work-items-stale-claims.ts's dead/stalled-holder reaper,
    // fleet-monitors.ts's sweepOrphanedTakenBy, and pg-stores.ts's fleet:cancel
    // claim release all clear taken_by/taken_at on reclaim but historically left
    // last_progress_at stamped from the dead holder — live-verified on
    // WI-5130/WI-5136/WI-5137, unclaimed for 10+ days yet still reading as
    // "in-flight" against their already-`done` plan items P-104/P-301/P-402.
    stub({ id: 'WI-stale', state: 'open', lastProgressAt: '2026-07-17T00:00:00Z', assignee: null });
    await edge({ plan: 'p1', item: 'P-006', srcRef: 'WI-stale' });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-006' });

    expect(result.reconciled).toEqual(['WI-stale']);
    expect(result.skippedInFlight).toEqual([]);
    expect(setWorkItemState).toHaveBeenCalledWith(
      'WI-stale',
      'resolved',
      expect.objectContaining({ by: 'system:plan-item-reconcile' }),
    );
  });

  it('EI-20405552992224051: a FRESHLY-CLAIMED item with no lastProgressAt YET is skipped as in-flight, not re-closed', async () => {
    // The reopen/re-close loop. An agent reopens a falsely-closed item and claims it
    // to finish the work; nothing has been recorded against it since the reopen, so
    // `lastProgressAt` is still null while a LIVE holder owns it. While the guard
    // required BOTH signals, this sweep terminal-closed the item back out from under
    // that holder on its very next pass, so the reopen never stuck — WI-38661 and
    // WI-38600 each had to be hand-repaired twice by two agents who independently
    // discovered that reopening the work-item alone does nothing while its plan item
    // stays terminal. This is the REVERSE of the WI-6303 case directly above: there
    // the stamp was stale and the holder absent, here the holder is present and the
    // stamp merely absent.
    stub({ id: 'WI-reopened', state: 'wip', lastProgressAt: null, assignee: 'su-live-holder' });
    await edge({ plan: 'p1', item: 'P-reopen', srcRef: 'WI-reopened' });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-reopen' });

    expect(result.reconciled).toEqual([]);
    expect(result.skippedInFlight).toEqual(['WI-reopened']);
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('skips an already-terminal linked item as a no-op', async () => {
    stub({ id: 'WI-done', state: 'resolved', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-003', srcRef: 'WI-done' });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-003' });

    expect(result.reconciled).toEqual([]);
    expect(result.skippedAlreadyTerminal).toEqual(['WI-done']);
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('a feature-family linked item resolves to "passed", not "resolved"', async () => {
    stub({ id: 'F-mirror-1', harness: 'sheets', state: 'todo', family: 'feature', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-004', srcRef: 'sheets#F-mirror-1', srcKind: 'feature' });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-004' });

    expect(result.reconciled).toEqual(['F-mirror-1']);
    expect(setWorkItemState).toHaveBeenCalledWith('F-mirror-1', 'passed', expect.anything());
  });

  // EI-18677799334390930: the triggering actor remains transient context only. A
  // reconciler mirror is a proposed judgement, not independent completion evidence,
  // so it must not manufacture a synthetic completionRef or persist the actor in one.
  it('records proposed authority without manufacturing completion evidence (EI-18677799334390930)', async () => {
    stub({ id: 'WI-attributed', state: 'open', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-005', srcRef: 'WI-attributed' });

    await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-005', triggeredBy: 'su-abc123' });

    expect(setWorkItemState).toHaveBeenCalledWith(
      'WI-attributed',
      'resolved',
      expect.objectContaining({
        by: 'system:plan-item-reconcile',
        completionAuthority: 'proposed',
      }),
    );
    const call = setWorkItemState.mock.calls.find(([id]) => id === 'WI-attributed') as unknown as
      | [string, string, Record<string, unknown>]
      | undefined;
    expect(call?.[2]).not.toHaveProperty('completionRef');
    expect(JSON.stringify(call?.[2])).not.toContain('su-abc123');
  });

  it('records proposed authority without a completionRef when no triggering actor was resolved (periodic sweep)', async () => {
    stub({ id: 'WI-unattributed', state: 'open', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-P22', srcRef: 'WI-unattributed' });

    await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-P22' });

    expect(setWorkItemState).toHaveBeenCalledWith(
      'WI-unattributed',
      'resolved',
      expect.objectContaining({ completionAuthority: 'proposed' }),
    );
    const call = setWorkItemState.mock.calls.find(([id]) => id === 'WI-unattributed') as unknown as
      | [string, string, Record<string, unknown>]
      | undefined;
    expect(call?.[2]).not.toHaveProperty('completionRef');
  });

  // NOTE: the payload.plan_item STAMP backstop path (mirroring
  // findConvertedWorkItemByStamp's already-proven jsonb-string-scalar unwrap,
  // convert.integration.test.ts) is exercised by findAllLinkedWorkItems's
  // second query but is NOT separately covered here — a first attempt at this
  // case did not match as expected and, given time budget, is left for a
  // follow-up rather than shipped un-debugged. The PRIMARY truth source (the
  // `implements` coord_links edge, covered above) is fully proven.

  it('no linked work-item at all is a clean no-op', async () => {
    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-999' });
    expect(result).toEqual({
      planSlug: 'p1',
      itemId: 'P-999',
      reconciled: [],
      skippedInFlight: [],
      skippedAlreadyTerminal: [],
      skippedUnprovenLink: [],
      skippedGatedState: [],
    });
  });

  it('reconciles MULTIPLE distinct work-items linked to the SAME plan item', async () => {
    stub({ id: 'WI-dup-1', state: 'open', lastProgressAt: null });
    stub({ id: 'WI-dup-2', state: 'open', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-006', srcRef: 'WI-dup-1' });
    await edge({ plan: 'p1', item: 'P-006', srcRef: 'WI-dup-2' });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-006' });

    expect(result.reconciled.sort()).toEqual(['WI-dup-1', 'WI-dup-2']);
  });
});

/**
 * EI-19460536530145188 — the truth source, not the kind, decides whether a
 * terminal close is warranted.
 *
 * A `payload.plan_item` STAMP alone does not assert that the work-item
 * IMPLEMENTS the plan item: `work_items:create { plan_item }` writes its coord
 * edge as `relates` and writes the stamp only so work_items:complete's FORWARD
 * auto-flip can find it (EI-19390496242545842). Reading it in reverse as
 * implementation destroyed WI-9333 — a bug discovered while working P-007,
 * closed as "stale residue" the moment P-007 was marked done, with no fix and
 * no completion evidence.
 *
 * These four tests pin the exact boundary, including the two regressions a
 * kind-based fix would have caused (29 `change` + 585 `feature` rows).
 */
describe('reconcileLinkedWorkItemsForPlanItem — stamp is not implementation (EI-19460536530145188)', () => {
  it('does NOT close an issue-family item reached ONLY by the payload stamp (the WI-9333 case)', async () => {
    stub({ id: 'WI-discovered', state: 'open', family: 'issue', lastProgressAt: null });
    await insertWorkItemRow({
      id: 'WI-discovered',
      kind: 'bug',
      status: 'open',
      planSlug: 'p1',
      itemId: 'P-020',
    });
    // NO edge() — a bug DISCOVERED while working P-020, not an implementation of it.

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-020' });

    expect(result.skippedUnprovenLink).toEqual(['WI-discovered']);
    expect(result.reconciled).toEqual([]);
    expect(setWorkItemState).not.toHaveBeenCalled();
    // The item must remain claimable — a surviving open bug is recoverable,
    // a silently-closed one is not.
    expect(h2.items.get('WI-discovered')?.state).toBe('open');
  });

  it('STILL closes an issue-family item that carries a real implements edge (29 `change` rows must not regress)', async () => {
    stub({ id: 'WI-implements', state: 'open', family: 'issue', lastProgressAt: null });
    await insertWorkItemRow({
      id: 'WI-implements',
      kind: 'bug',
      status: 'open',
      planSlug: 'p1',
      itemId: 'P-021',
    });
    await edge({ plan: 'p1', item: 'P-021', srcRef: 'WI-implements' });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-021' });

    // Found by BOTH truth sources — the edge proves implementation, and the
    // later stamp pass must not downgrade it (viaImplementsEdge is sticky-true).
    expect(result.reconciled).toEqual(['WI-implements']);
    expect(result.skippedUnprovenLink).toEqual([]);
  });

  it('WI-10004553: an implements edge under the PER-WORKSPACE coord scope still proves the link (post-2026-08-27 writers)', async () => {
    stub({ id: 'WI-scoped-edge', state: 'open', family: 'issue', lastProgressAt: null });
    await insertWorkItemRow({
      id: 'WI-scoped-edge',
      kind: 'bug',
      status: 'open',
      planSlug: 'p1',
      itemId: 'P-024',
    });
    // Written where every promotion since 2026-08-27 writes it — NOT the default tenant.
    await edge({ plan: 'p1', item: 'P-024', srcRef: 'WI-scoped-edge', workspace: COORD_SCOPE_WS });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-024' });

    // Pinned to the default tenant this read the edge as absent → skippedUnprovenLink, and
    // the promoted issue stayed open on a terminal plan item forever (~190 live rows).
    expect(result.reconciled).toEqual(['WI-scoped-edge']);
    expect(result.skippedUnprovenLink).toEqual([]);
  });

  it('STILL closes a FEATURE-family item reached only by the stamp (585 `feature` rows are entirely stamp-borne)', async () => {
    stub({ id: 'WI-feat-stamped', state: 'open', family: 'feature', lastProgressAt: null });
    await insertWorkItemRow({
      id: 'WI-feat-stamped',
      kind: 'feature',
      status: 'open',
      planSlug: 'p1',
      itemId: 'P-022',
    });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-022' });

    expect(result.reconciled).toEqual(['WI-feat-stamped']);
    expect(result.skippedUnprovenLink).toEqual([]);
  });

  it('the guard is scoped to the LINK, not the kind — two items on one plan item split correctly', async () => {
    stub({ id: 'WI-impl-2', state: 'open', family: 'issue', lastProgressAt: null });
    stub({ id: 'WI-found-2', state: 'open', family: 'issue', lastProgressAt: null });
    await insertWorkItemRow({
      id: 'WI-found-2',
      kind: 'bug',
      status: 'open',
      planSlug: 'p1',
      itemId: 'P-023',
    });
    await edge({ plan: 'p1', item: 'P-023', srcRef: 'WI-impl-2' });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-023' });

    expect(result.reconciled).toEqual(['WI-impl-2']);
    expect(result.skippedUnprovenLink).toEqual(['WI-found-2']);
  });
});

describe('reconcileLinkedWorkItemsForPlanItem — stale-read guard (EI-8970)', () => {
  it('bails the WHOLE sweep, touching nothing, when the plan item is no longer `done` by the time the sweep runs', async () => {
    stub({ id: 'WI-corrected', state: 'wip', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-007', srcRef: 'WI-corrected' });
    // A peer corrected the plan item back to `wip` between the `done` event
    // firing and this sweep actually running — the exact race on
    // cup-lexicon-full-rename-2026-07-09#P-006 / WI-3463.
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-007', status: 'wip' }] });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-007' });

    expect(result).toEqual({
      planSlug: 'p1',
      itemId: 'P-007',
      reconciled: [],
      skippedInFlight: [],
      skippedAlreadyTerminal: [],
      skippedUnprovenLink: [],
      skippedGatedState: [],
    });
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('proceeds normally when the re-read CONFIRMS the plan item is still `done`', async () => {
    stub({ id: 'WI-confirmed', state: 'open', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-008', srcRef: 'WI-confirmed' });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-008', status: 'done' }] });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-008' });

    expect(result.reconciled).toEqual(['WI-confirmed']);
    expect(setWorkItemState).toHaveBeenCalledWith(
      'WI-confirmed',
      'resolved',
      expect.objectContaining({ by: 'system:plan-item-reconcile' }),
    );
  });

  it('fails OPEN (proceeds as before) when the re-read throws — a DB hiccup must never suppress a real reconcile', async () => {
    stub({ id: 'WI-failopen', state: 'open', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-009', srcRef: 'WI-failopen' });
    h3.getPlanRow.mockRejectedValue(new Error('connection reset'));

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-009' });

    expect(result.reconciled).toEqual(['WI-failopen']);
  });

  it('fails OPEN when the row resolves but the item id is absent from its derived index', async () => {
    stub({ id: 'WI-noindex', state: 'open', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-010', srcRef: 'WI-noindex' });
    // e.g. an un-normalized row (Stage-3 index not yet populated) — items: [].
    h3.getPlanRow.mockResolvedValue({ items: [] });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-010' });

    expect(result.reconciled).toEqual(['WI-noindex']);
  });
});

describe('reconcileLinkedWorkItemsForPlanItem — dropped plan item (EI-14693)', () => {
  it('maps a `dropped` plan item to `deprecated` for a feature-family linked item', async () => {
    stub({ id: 'F-drop', harness: 'sheets', state: 'todo', family: 'feature', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-d1', srcRef: 'sheets#F-drop', srcKind: 'feature' });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-d1', status: 'dropped' }] });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-d1' });

    expect(result.reconciled).toEqual(['F-drop']);
    expect(setWorkItemState).toHaveBeenCalledWith('F-drop', 'deprecated', expect.anything());
  });

  it('maps a `dropped` plan item to `closed` for an issue-family linked item', async () => {
    stub({ id: 'WI-drop', state: 'open', family: 'issue', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-d2', srcRef: 'WI-drop' });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-d2', status: 'dropped' }] });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-d2' });

    expect(result.reconciled).toEqual(['WI-drop']);
    expect(setWorkItemState).toHaveBeenCalledWith(
      'WI-drop',
      'closed',
      expect.objectContaining({ by: 'system:plan-item-reconcile' }),
    );
  });

  it('the reaction path (no knownTerminalStatus) still BAILS when the item is neither done nor dropped', async () => {
    stub({ id: 'WI-todo', state: 'open', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-d3', srcRef: 'WI-todo' });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-d3', status: 'todo' }] });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-d3' });

    expect(result.reconciled).toEqual([]);
    expect(setWorkItemState).not.toHaveBeenCalled();
  });
});

describe('reconcileLinkedWorkItemsForPlanItem — plan decisions are not completion evidence (EI-19319970920449941)', () => {
  it('does not copy plan decisions or their itemRefs into a completionRef', async () => {
    stub({ id: 'WI-evidenced', state: 'open', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-020', srcRef: 'WI-evidenced' });
    h3.getPlanRow.mockResolvedValue({
      items: [{ id: 'P-020', status: 'done' }],
      decisions: [
        { id: 'D-001', title: 'Unrelated', body: '...', date: null, itemRefs: ['P-999'] },
        { id: 'D-002', title: 'The real evidence', body: '...', date: null, itemRefs: ['P-020', 'P-021'] },
      ],
    });

    await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-020' });

    expect(setWorkItemState).toHaveBeenCalledWith(
      'WI-evidenced',
      'resolved',
      expect.objectContaining({
        completionAuthority: 'proposed',
      }),
    );
    // Plan decisions are an audit trail for the plan, not independent verification
    // of the mirrored work-item. Neither decision may reach the terminal write.
    const call = setWorkItemState.mock.calls.find(([id]) => id === 'WI-evidenced') as unknown as
      | [string, string, Record<string, unknown>]
      | undefined;
    expect(call?.[2]).not.toHaveProperty('completionRef');
    expect(JSON.stringify(call?.[2])).not.toContain('D-002');
  });

  it('periodic reconciliation also writes authority only, even when the row has decisions', async () => {
    await insertWorkItemRow({
      id: 'F-swevidence',
      kind: 'feature',
      status: 'todo',
      planSlug: 'psevidence',
      itemId: 'P-1',
    });
    await edge({ plan: 'psevidence', item: 'P-1', srcRef: 'sheets#F-swevidence', srcKind: 'feature' });
    stub({ id: 'F-swevidence', harness: 'sheets', state: 'todo', family: 'feature', lastProgressAt: null });
    h3.getPlanRow.mockResolvedValue({
      items: [{ id: 'P-1', status: 'done' }],
      decisions: [{ id: 'D-010', title: 'Sweep evidence', body: '...', date: null, itemRefs: ['P-1'] }],
    });

    await reconcileOrphanedPlanItemWorkItems();

    expect(setWorkItemState).toHaveBeenCalledWith(
      'F-swevidence',
      'passed',
      expect.objectContaining({ completionAuthority: 'proposed' }),
    );
    const call = setWorkItemState.mock.calls.find(([id]) => id === 'F-swevidence') as unknown as
      | [string, string, Record<string, unknown>]
      | undefined;
    expect(call?.[2]).not.toHaveProperty('completionRef');
  });

  it('does not need a decision record to mark a mirror as proposed', async () => {
    stub({ id: 'WI-bare', state: 'open', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-021', srcRef: 'WI-bare' });
    h3.getPlanRow.mockResolvedValue({
      items: [{ id: 'P-021', status: 'done' }],
      decisions: [{ id: 'D-003', title: 'About something else', body: '...', date: null, itemRefs: ['P-999'] }],
    });

    await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-021' });

    expect(setWorkItemState).toHaveBeenCalledWith(
      'WI-bare',
      'resolved',
      expect.objectContaining({ completionAuthority: 'proposed' }),
    );
    const call = setWorkItemState.mock.calls.find(([id]) => id === 'WI-bare') as unknown as
      | [string, string, Record<string, unknown>]
      | undefined;
    expect(call?.[2]).not.toHaveProperty('completionRef');
  });

  it('is a clean proposed close when the plan has no decisions at all (undefined field, pre-existing rows)', async () => {
    stub({ id: 'WI-nodecisions', state: 'open', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-022', srcRef: 'WI-nodecisions' });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-022', status: 'done' }] });

    await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-022' });

    expect(setWorkItemState).toHaveBeenCalledWith(
      'WI-nodecisions',
      'resolved',
      expect.objectContaining({ completionAuthority: 'proposed' }),
    );
    const call = setWorkItemState.mock.calls.find(([id]) => id === 'WI-nodecisions') as unknown as
      | [string, string, Record<string, unknown>]
      | undefined;
    expect(call?.[2]).not.toHaveProperty('completionRef');
  });
});

describe('reconcileLinkedWorkItemsForPlanItem — stale plan-lane hold cleared before terminal flip (EI-18653945816361859)', () => {
  beforeEach(() => {
    h4.mergeWorkItemPayload.mockClear();
    h4.setWorkItemClaimHold.mockClear();
  });

  it('clears a stale plan-lane external blocker + held_open lease BEFORE the terminal flip', async () => {
    const laneRef = planLaneBlockerRef('p1', 'P-011');
    stub({
      id: 'WI-stale-hold',
      state: 'blocked',
      lastProgressAt: null,
      payload: {
        held_open_by: 'system:plan-item-lane-sync',
        held_open_at: new Date().toISOString(),
        _claimHold: true,
        externalBlockers: [
          {
            kind: 'gate',
            capability: 'live-dependency',
            capabilitySource: 'explicit',
            ref: laneRef,
            summary: 'plan lane blocked',
            status: 'active',
            createdAt: new Date().toISOString(),
            createdBy: 'system:plan-item-lane-sync',
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    });
    await edge({ plan: 'p1', item: 'P-011', srcRef: 'WI-stale-hold' });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-011', status: 'done' }] });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-011' });

    expect(h4.mergeWorkItemPayload).toHaveBeenCalledWith(
      'WI-stale-hold',
      expect.objectContaining({ externalBlockers: expect.any(Array) }),
      expect.anything(),
    );
    expect(h4.setWorkItemClaimHold).toHaveBeenCalledWith(
      'WI-stale-hold',
      false,
      expect.objectContaining({ by: 'system:plan-item-lane-sync' }),
    );
    expect(result.reconciled).toEqual(['WI-stale-hold']);
    expect(setWorkItemState).toHaveBeenCalledWith('WI-stale-hold', 'resolved', expect.anything());
  });

  it('is a no-op when the linked item carries no plan-lane hold at all', async () => {
    stub({ id: 'WI-clean', state: 'open', lastProgressAt: null, payload: null });
    await edge({ plan: 'p1', item: 'P-012', srcRef: 'WI-clean' });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-012', status: 'done' }] });

    await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-012' });

    expect(h4.mergeWorkItemPayload).not.toHaveBeenCalled();
    expect(h4.setWorkItemClaimHold).not.toHaveBeenCalled();
  });

  it('EI-19968934836644509: clears the stale hold even when the item is SKIPPED as in-flight — the terminal flip is deferred, the hold-clear is not', async () => {
    // Repro shape: WI-37408. A plan item's lane holds a linked work-item; the
    // SAME agent then claims that work-item and makes real progress on it
    // (lastProgressAt + a live assignee) while the plan item independently goes
    // done. The reconciler must correctly refuse to yank the terminal flip out
    // from under the active holder (skippedInFlight) — but that refusal must NOT
    // also leave the now-stale lane blocker/hold in place forever, since every
    // future sweep pass re-observes the SAME in-flight state and would `continue`
    // right past a hold-clear that only ran after the skip checks.
    const laneRef = planLaneBlockerRef('p1', 'P-013');
    stub({
      id: 'WI-active-held',
      state: 'blocked',
      lastProgressAt: '2026-08-09T09:50:00Z',
      assignee: 'su-live-holder',
      payload: {
        held_open_by: 'system:plan-item-lane-sync',
        held_open_at: new Date().toISOString(),
        _claimHold: true,
        externalBlockers: [
          {
            kind: 'gate',
            capability: 'live-dependency',
            capabilitySource: 'explicit',
            ref: laneRef,
            summary: 'plan lane blocked',
            status: 'active',
            createdAt: new Date().toISOString(),
            createdBy: 'system:plan-item-lane-sync',
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    });
    await edge({ plan: 'p1', item: 'P-013', srcRef: 'WI-active-held' });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-013', status: 'done' }] });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-013' });

    // The terminal flip is correctly deferred — never clobber active work.
    expect(result.skippedInFlight).toEqual(['WI-active-held']);
    expect(result.reconciled).toEqual([]);
    expect(setWorkItemState).not.toHaveBeenCalled();
    // But the stale lane hold IS lifted regardless, so the item is no longer
    // gate-parked once its holder eventually releases/completes it.
    expect(h4.mergeWorkItemPayload).toHaveBeenCalledWith(
      'WI-active-held',
      expect.objectContaining({ externalBlockers: expect.any(Array) }),
      expect.anything(),
    );
    expect(h4.setWorkItemClaimHold).toHaveBeenCalledWith(
      'WI-active-held',
      false,
      expect.objectContaining({ by: 'system:plan-item-lane-sync' }),
    );
  });

  it('EI-19968934836644509: also clears the stale hold when the item is SKIPPED as unproven-link (stamp-only issue)', async () => {
    const laneRef = planLaneBlockerRef('p1', 'P-014');
    stub({
      id: 'WI-stamp-only',
      state: 'blocked',
      family: 'issue',
      lastProgressAt: null,
      payload: {
        held_open_by: 'system:plan-item-lane-sync',
        held_open_at: new Date().toISOString(),
        _claimHold: true,
        externalBlockers: [
          {
            kind: 'gate',
            capability: 'live-dependency',
            capabilitySource: 'explicit',
            ref: laneRef,
            summary: 'plan lane blocked',
            status: 'active',
            createdAt: new Date().toISOString(),
            createdBy: 'system:plan-item-lane-sync',
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    });
    // Stamp only — no `implements` edge — so viaImplementsEdge is false and this
    // hits the skippedUnprovenLink branch, not the terminal flip.
    await insertWorkItemRow({ id: 'WI-stamp-only', kind: 'bug', status: 'blocked', planSlug: 'p1', itemId: 'P-014' });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-014', status: 'done' }] });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-014' });

    expect(result.skippedUnprovenLink).toEqual(['WI-stamp-only']);
    expect(setWorkItemState).not.toHaveBeenCalled();
    expect(h4.setWorkItemClaimHold).toHaveBeenCalledWith(
      'WI-stamp-only',
      false,
      expect.objectContaining({ by: 'system:plan-item-lane-sync' }),
    );
  });
});

describe('reconcileOrphanedPlanItemWorkItems — periodic data-heal (EI-14693)', () => {
  it('enumerates the live feature-column linkage even when payload.plan_item is absent', async () => {
    await insertWorkItemRow({
      id: 'F-column-link',
      kind: 'feature',
      status: 'todo',
      planSlug: 'pcolumns',
      itemId: 'P-100',
      linkage: 'columns',
    });
    stub({ id: 'F-column-link', harness: 'sheets', state: 'todo', family: 'feature', lastProgressAt: null });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-100', status: 'done' }] });

    const result = await reconcileOrphanedPlanItemWorkItems();

    expect(result.candidatePlanItems).toBe(1);
    expect(result.reconciled).toEqual(['F-column-link']);
  });
  it('heals BOTH a feature and an issue orphan of an already-`done` plan item', async () => {
    // Real base-table rows carrying the stamp (the candidate + stamp-backstop source)
    // + matching stub entries (getWorkItem/setWorkItemState are mocked).
    await insertWorkItemRow({ id: 'F-sweep', kind: 'feature', status: 'todo', planSlug: 'psweep', itemId: 'P-100' });
    await insertWorkItemRow({ id: 'WI-sweep', kind: 'bug', status: 'open', planSlug: 'psweep', itemId: 'P-100' });
    // Real orphans also carry the `implements` edge convert.ts writes (verified in
    // prod for WI-3488 et al) — findAllLinkedWorkItems finds them via that edge.
    await edge({ plan: 'psweep', item: 'P-100', srcRef: 'sheets#F-sweep', srcKind: 'feature' });
    await edge({ plan: 'psweep', item: 'P-100', srcRef: 'WI-sweep' });
    stub({ id: 'F-sweep', harness: 'sheets', state: 'todo', family: 'feature', lastProgressAt: null });
    stub({ id: 'WI-sweep', harness: 'sheets', state: 'open', family: 'issue', lastProgressAt: null });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-100', status: 'done' }] });

    const result = await reconcileOrphanedPlanItemWorkItems();

    expect(result.candidatePlanItems).toBe(1);
    expect(result.terminalPlanItems).toBe(1);
    expect(result.reconciled.sort()).toEqual(['F-sweep', 'WI-sweep']);
    expect(setWorkItemState).toHaveBeenCalledWith('F-sweep', 'passed', expect.anything());
    expect(setWorkItemState).toHaveBeenCalledWith('WI-sweep', 'resolved', expect.anything());
  });

  it('maps a `dropped` plan item to deprecated/closed in the sweep too', async () => {
    await insertWorkItemRow({ id: 'F-swdrop', kind: 'feature', status: 'todo', planSlug: 'psd', itemId: 'P-1' });
    await edge({ plan: 'psd', item: 'P-1', srcRef: 'sheets#F-swdrop', srcKind: 'feature' });
    stub({ id: 'F-swdrop', harness: 'sheets', state: 'todo', family: 'feature', lastProgressAt: null });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-1', status: 'dropped' }] });

    const result = await reconcileOrphanedPlanItemWorkItems();

    expect(result.reconciled).toEqual(['F-swdrop']);
    expect(setWorkItemState).toHaveBeenCalledWith('F-swdrop', 'deprecated', expect.anything());
  });

  it('is FAIL-CLOSED: a candidate whose plan item is still `wip` is left untouched', async () => {
    await insertWorkItemRow({ id: 'F-open', kind: 'feature', status: 'todo', planSlug: 'popen', itemId: 'P-1' });
    stub({ id: 'F-open', harness: 'sheets', state: 'todo', family: 'feature', lastProgressAt: null });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-1', status: 'wip' }] });

    const result = await reconcileOrphanedPlanItemWorkItems();

    expect(result.candidatePlanItems).toBe(1);
    expect(result.terminalPlanItems).toBe(0);
    expect(result.reconciled).toEqual([]);
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('is FAIL-CLOSED: a candidate whose plan cannot be resolved (getPlanRow → null) is left untouched', async () => {
    await insertWorkItemRow({ id: 'F-noplan', kind: 'feature', status: 'todo', planSlug: 'pnull', itemId: 'P-1' });
    stub({ id: 'F-noplan', harness: 'sheets', state: 'todo', family: 'feature', lastProgressAt: null });
    h3.getPlanRow.mockResolvedValue(null);

    const result = await reconcileOrphanedPlanItemWorkItems();

    expect(result.terminalPlanItems).toBe(0);
    expect(result.reconciled).toEqual([]);
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('does NOT enumerate an already-terminal work-item as a candidate (non-terminal predicate)', async () => {
    await insertWorkItemRow({ id: 'F-term', kind: 'feature', status: 'passed', planSlug: 'pterm', itemId: 'P-1' });
    await insertWorkItemRow({ id: 'WI-term', kind: 'bug', status: 'resolved', planSlug: 'pterm', itemId: 'P-2' });
    h3.getPlanRow.mockResolvedValue({
      items: [
        { id: 'P-1', status: 'done' },
        { id: 'P-2', status: 'done' },
      ],
    });

    const result = await reconcileOrphanedPlanItemWorkItems();

    expect(result.candidatePlanItems).toBe(0);
    expect(result.reconciled).toEqual([]);
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('WI-5279: does NOT enumerate a work-item stored with the UNIFIED terminal spelling (done/dropped), not just the legacy one', async () => {
    // work-item-status-full-unify (2026-07-19): rows can now be written with the
    // literal 'done'/'dropped' status instead of the legacy per-family spelling.
    // The candidate query's exclusion list must cover BOTH or these rows leak back
    // in as "candidates" every sweep tick, wasting work and — at scale — crowding
    // out genuine orphans from the `LIMIT cap` window (WI-5279/EI-13337 class).
    await insertWorkItemRow({
      id: 'F-unified-term',
      kind: 'feature',
      status: 'done',
      planSlug: 'punified',
      itemId: 'P-1',
    });
    await insertWorkItemRow({
      id: 'WI-unified-term',
      kind: 'bug',
      status: 'dropped',
      planSlug: 'punified',
      itemId: 'P-2',
    });
    h3.getPlanRow.mockResolvedValue({
      items: [
        { id: 'P-1', status: 'done' },
        { id: 'P-2', status: 'dropped' },
      ],
    });

    const result = await reconcileOrphanedPlanItemWorkItems();

    expect(result.candidatePlanItems).toBe(0);
    expect(result.reconciled).toEqual([]);
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('WI-5279: a genuine orphan is not starved out of the LIMIT-cap window by already-terminal (unified-spelling) noise', async () => {
    // Reproduces the production shape found live-verifying WI-5279: a large volume
    // of already-`done`/`dropped` stamped rows sitting alongside one genuine
    // non-terminal orphan. With a tight cap and the STALE exclusion list, the noise
    // could fill the whole candidate window before the real orphan is ever read.
    for (let i = 0; i < 5; i++) {
      await insertWorkItemRow({
        id: `F-noise-${i}`,
        kind: 'feature',
        status: 'done',
        planSlug: 'pnoise',
        itemId: `P-noise-${i}`,
      });
    }
    await insertWorkItemRow({
      id: 'F-real-orphan',
      kind: 'feature',
      status: 'todo',
      planSlug: 'pnoise',
      itemId: 'P-real',
    });
    await edge({ plan: 'pnoise', item: 'P-real', srcRef: 'sheets#F-real-orphan', srcKind: 'feature' });
    stub({ id: 'F-real-orphan', harness: 'sheets', state: 'todo', family: 'feature', lastProgressAt: null });
    h3.getPlanRow.mockResolvedValue({
      items: [
        ...Array.from({ length: 5 }, (_, i) => ({ id: `P-noise-${i}`, status: 'done' })),
        { id: 'P-real', status: 'done' },
      ],
    });

    const result = await reconcileOrphanedPlanItemWorkItems({ candidateCap: 3 });

    expect(result.candidatePlanItems).toBe(1);
    expect(result.reconciled).toEqual(['F-real-orphan']);
    expect(setWorkItemState).toHaveBeenCalledWith('F-real-orphan', 'passed', expect.anything());
  });

  it('WI-10004586: a terminal orphan is prioritised into a saturated window ahead of perpetually-skipped lane-sync candidates', async () => {
    // Live shape (2026-10-01): 536 candidates vs a 500 cap, 16 of 68 terminal
    // orphans outside the unordered window. Here: 6 NON-terminal candidates (their
    // plan items are `wip`, so every pass only lane-syncs them) + 1 terminal
    // orphan whose slug sorts LAST, under a cap of 3. An unordered or slug-ordered
    // window never reaches it; the derived plan_items index must pull it in.
    for (let i = 0; i < 6; i++) {
      await insertWorkItemRow({ id: `F-lane-${i}`, kind: 'feature', status: 'todo', planSlug: 'pa-lane', itemId: `P-lane-${i}` });
      stub({ id: `F-lane-${i}`, harness: 'sheets', state: 'todo', family: 'feature', lastProgressAt: null });
      await rootSql`INSERT INTO harness_shared.plan_items (plan_slug, item_id, seq, status)
                    VALUES ('pa-lane', ${`P-lane-${i}`}, ${i}, 'wip')`;
    }
    await insertWorkItemRow({ id: 'F-term-orphan', kind: 'feature', status: 'todo', planSlug: 'pz-term', itemId: 'P-term' });
    await edge({ plan: 'pz-term', item: 'P-term', srcRef: 'sheets#F-term-orphan', srcKind: 'feature' });
    stub({ id: 'F-term-orphan', harness: 'sheets', state: 'todo', family: 'feature', lastProgressAt: null });
    await rootSql`INSERT INTO harness_shared.plan_items (plan_slug, item_id, seq, status)
                  VALUES ('pz-term', 'P-term', 0, 'done')`;
    h3.getPlanRow.mockImplementation(async (slug: string) =>
      slug === 'pz-term'
        ? { items: [{ id: 'P-term', status: 'done' }] }
        : { items: Array.from({ length: 6 }, (_, i) => ({ id: `P-lane-${i}`, status: 'wip' })) },
    );

    const result = await reconcileOrphanedPlanItemWorkItems({ candidateCap: 3 });

    expect(result.candidateWindowSaturated).toBe(true);
    expect(result.candidatePlanItems).toBe(3);
    expect(result.terminalPlanItems).toBe(1);
    expect(result.reconciled).toEqual(['F-term-orphan']);
  });

  it('WI-10004586: an unsaturated window reports candidateWindowSaturated=false', async () => {
    await insertWorkItemRow({ id: 'F-one', kind: 'feature', status: 'todo', planSlug: 'pone', itemId: 'P-1' });
    stub({ id: 'F-one', harness: 'sheets', state: 'todo', family: 'feature', lastProgressAt: null });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-1', status: 'wip' }] });

    const result = await reconcileOrphanedPlanItemWorkItems({ candidateCap: 3 });

    expect(result.candidatePlanItems).toBe(1);
    expect(result.candidateWindowSaturated).toBe(false);
  });

  it('skips a candidate carrying independent in-flight progress (lastProgressAt)', async () => {
    await insertWorkItemRow({ id: 'F-active', kind: 'feature', status: 'wip', planSlug: 'pact', itemId: 'P-1' });
    await edge({ plan: 'pact', item: 'P-1', srcRef: 'sheets#F-active', srcKind: 'feature' });
    stub({
      id: 'F-active',
      harness: 'sheets',
      state: 'wip',
      family: 'feature',
      lastProgressAt: '2026-07-10T00:00:00Z',
      assignee: 'su-live-holder',
    });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-1', status: 'done' }] });

    const result = await reconcileOrphanedPlanItemWorkItems();

    expect(result.terminalPlanItems).toBe(1);
    expect(result.reconciled).toEqual([]);
    expect(result.skippedInFlight).toEqual(['F-active']);
    expect(setWorkItemState).not.toHaveBeenCalled();
  });
});

describe('syncLinkedWorkItemsToPlanLane failure reporting (WI-10003685)', () => {
  it('returns a structured read failure when linked-item lookup throws', async () => {
    const originalSql = h.sql;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.sql = (() => {
      throw new Error('injected: linked-item lookup unavailable');
    }) as unknown as postgres.Sql;

    try {
      const result = await syncLinkedWorkItemsToPlanLane(
        { planSlug: 'p-read-failure', itemId: 'P-FAIL', harnessSlug: 'sheets' },
        'blocked',
      );

      expect(result.failures).toEqual([
        { stage: 'linked-work-item-read', message: 'injected: linked-item lookup unavailable' },
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"event":"plan_lane_sync_failure"'));
    } finally {
      h.sql = originalSql;
      warn.mockRestore();
    }
  });
});

describe('resyncPlanItemLaneNow — inline lane resync off plans:set-item-blocked-by (EI-18732669095544832)', () => {
  beforeEach(() => {
    h4.mergeWorkItemPayload.mockClear();
    h4.setWorkItemClaimHold.mockClear();
  });

  it('CLEARING a blocked-by edge un-parks the linked work-item RIGHT NOW (the reported bug)', async () => {
    // Repro shape: P-011 was `blocked-by: P-010`; the lane sync GATED WI-6096 for
    // it (an `active` plan-lane external blocker + state:'blocked'). The caller
    // just cleared the edge (blockedBy: [] on P-011) — resyncPlanItemLaneNow must
    // reflect that immediately, not 15 minutes later.
    await edge({ plan: 'pblk', item: 'P-011', srcRef: 'WI-6096' });
    const ref = planLaneBlockerRef('pblk', 'P-011');
    const { blockers } = updateExternalBlockerHistory(
      {},
      { kind: 'gate', capability: 'live-dependency', ref, summary: 'parked' },
      'system:plan-item-lane-sync',
    );
    stub({
      id: 'WI-6096',
      harness: 'sheets',
      state: 'blocked',
      family: 'issue',
      lastProgressAt: null,
      payload: {
        _claimHold: true,
        held_open_by: 'system:plan-item-lane-sync',
        held_open_at: new Date().toISOString(),
        externalBlockers: blockers,
      },
    });
    h3.getPlanRow.mockResolvedValue({
      items: [
        { id: 'P-010', status: 'done', blockedBy: [] },
        { id: 'P-011', status: 'todo', blockedBy: [] }, // cleared
      ],
    });

    const result = await resyncPlanItemLaneNow('pblk', 'P-011', null);

    expect(result).not.toBeNull();
    expect(result!.ungated).toEqual(['WI-6096']);
    expect(h4.setWorkItemClaimHold).toHaveBeenCalledWith(
      'WI-6096',
      false,
      expect.objectContaining({
        by: 'system:plan-item-lane-sync',
        leaseOnly: true,
        expectedLeaseHolder: 'system:plan-item-lane-sync',
      }),
    );
  });

  it('blocked → actionable clears the dependency-derived P-068 durable park and restores exact-plan width', async () => {
    const plan = 'byoc-cloud-workspaces-gcp-aws-azure-2026-08-22';
    const itemId = 'P-068';
    const ref = planLaneBlockerRef(plan, itemId);
    await edge({ plan, item: itemId, srcRef: 'WI-40822' });
    const { blockers } = updateExternalBlockerHistory(
      {},
      { kind: 'gate', capability: 'live-dependency', ref, summary: 'parked' },
      'system:plan-item-lane-sync',
    );
    const gatedAt = Date.parse(blockers[0]!.createdAt);
    const row = stub({
      id: 'WI-40822',
      harness: 'papercusp',
      state: 'blocked',
      family: 'feature',
      lastProgressAt: null,
      payload: {
        _claimHold: true,
        claim_hold_by: 'su-former-owner',
        claim_hold_at: new Date(gatedAt + 1_000).toISOString(),
        claim_hold_reason:
          'P-068 requires production hosted auth/transport integration and an independent black-box security review',
        planLaneParkedFrom: 'todo',
        externalBlockers: blockers,
      },
    });
    h3.getPlanRow.mockResolvedValue({
      planSlug: plan,
      items: [{ id: itemId, status: 'todo', blockedBy: [] }],
      decisions: [],
    });

    const otherExactPlanRows = [{}, {}];
    expect([...otherExactPlanRows, row.payload].filter((payload) => !isClaimHoldParked(payload)).length).toBe(2);

    const result = await resyncPlanItemLaneNow(plan, itemId, 'papercusp');

    expect(result?.ungated).toEqual(['WI-40822']);
    expect(row.state).toBe('todo');
    expect(isClaimHoldParked(row.payload)).toBe(false);
    expect(row.payload).not.toHaveProperty('claim_hold_by');
    expect(row.payload).not.toHaveProperty('claim_hold_reason');
    expect([...otherExactPlanRows, row.payload].filter((payload) => !isClaimHoldParked(payload)).length).toBe(3);
    expect(h4.setWorkItemClaimHold).toHaveBeenCalledWith(
      'WI-40822',
      false,
      expect.objectContaining({
        parkedBy: 'system:plan-item-lane-sync',
        parkedReason: expect.stringContaining(`${plan}#${itemId} cleared`),
      }),
    );
  });

  it('blocked → actionable preserves an explicit manual durable park and suppresses claimable dispatch', async () => {
    const plan = 'p-manual-park';
    const itemId = 'P-068';
    const ref = planLaneBlockerRef(plan, itemId);
    await edge({ plan, item: itemId, srcRef: 'WI-manual-park' });
    const { blockers } = updateExternalBlockerHistory(
      {},
      { kind: 'gate', capability: 'live-dependency', ref, summary: 'parked' },
      'system:plan-item-lane-sync',
    );
    const gatedAt = Date.parse(blockers[0]!.createdAt);
    const row = stub({
      id: 'WI-manual-park',
      state: 'blocked',
      family: 'feature',
      payload: {
        _claimHold: true,
        claim_hold_by: 'su-owner',
        claim_hold_at: new Date(gatedAt + 1_000).toISOString(),
        claim_hold_reason: 'P-068 is owner-directed paused until a new authorization',
        planLaneParkedFrom: 'todo',
        externalBlockers: blockers,
      },
    });
    h3.getPlanRow.mockResolvedValue({
      planSlug: plan,
      items: [{ id: itemId, status: 'todo', blockedBy: [] }],
      decisions: [],
    });

    const result = await resyncPlanItemLaneNow(plan, itemId, null);

    expect(result?.ungated).toEqual(['WI-manual-park']);
    expect(row.state).toBe('todo');
    expect(isClaimHoldParked(row.payload)).toBe(true);
    expect(row.payload).toHaveProperty('claim_hold_by', 'su-owner');
    expect(h4.setWorkItemClaimHold).not.toHaveBeenCalled();
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'WI-manual-park',
      'todo',
      expect.objectContaining({ announceClaimable: false }),
    );
  });

  it('repairs a false owner park while preserving an independent runtime blocker', async () => {
    await edge({ plan: 'pactionable', item: 'P-001', srcRef: 'WI-false-human' });
    // EI-21274031426739947: a FALSE owner park is one whose capability an agent can
    // actually supply. This fixture used capability:'credential' — a capability the
    // policy marks requiresOwnerCapability:true — so it asserted that the sync clears
    // a real, unsatisfied prerequisite. The case is about the human/runtime split, so
    // it keeps that and uses a genuinely auto-clearable human blocker.
    const human = updateExternalBlockerHistory(
      {},
      {
        kind: 'human',
        capability: 'approval-auto-clearable',
        ref: 'approval:ship-it',
        summary: 'standing approval',
      },
      'su-a',
    );
    const both = updateExternalBlockerHistory(
      { externalBlockers: human.blockers },
      { kind: 'runtime', capability: 'live-dependency', ref: 'db:ready', summary: 'database unavailable' },
      'su-b',
    );
    const row = stub({
      id: 'WI-false-human',
      state: 'needs-human',
      family: 'issue',
      payload: { externalBlockers: both.blockers, needsOwnerAction: true, needsHuman: true },
    });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-001', status: 'todo', blockedBy: [] }] });

    const result = await resyncPlanItemLaneNow('pactionable', 'P-001', null);

    expect(result?.gated).toEqual(['WI-false-human']);
    expect(row.state).toBe('blocked');
    expect(row.payload).not.toHaveProperty('needsOwnerAction');
    expect(row.payload).not.toHaveProperty('needsHuman');
    const active = (row.payload?.externalBlockers as Array<{ kind: string; status: string }>).filter(
      (blocker) => blocker.status === 'active',
    );
    expect(active.map((blocker) => blocker.kind)).toEqual(['runtime']);
  });

  // EI-21274031426739947 — end-to-end guard for the WI-1439 recurrence. The pure
  // decision is unit-tested in plan-item-lane-sync.test.ts; this proves the APPLY path
  // leaves the row genuinely parked: the prerequisite stays active, the needs-human
  // signal survives, and the state is never restored to a claimable one. Without this,
  // an actionable lane cleared the owner-at-mic blocker and the scheduler handed the
  // item to an agent that structurally could not perform it, over and over.
  it('never clears an unsatisfied owner-capability prerequisite on an actionable lane', async () => {
    await edge({ plan: 'pactionable', item: 'P-001', srcRef: 'WI-owner-mic' });
    const { blockers } = updateExternalBlockerHistory(
      {},
      {
        kind: 'human',
        capability: 'physical-device',
        ref: 'owner-microphone-acceptance',
        summary: 'owner must accept at the mic',
      },
      'su-a',
    );
    const row = stub({
      id: 'WI-owner-mic',
      state: 'needs-human',
      family: 'issue',
      payload: { externalBlockers: blockers, needsOwnerAction: true, needsHuman: true },
    });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-001', status: 'todo', blockedBy: [] }] });

    const result = await resyncPlanItemLaneNow('pactionable', 'P-001', null);

    expect(result?.ungated ?? []).not.toContain('WI-owner-mic');
    expect(row.state).toBe('needs-human');
    expect(row.payload).toHaveProperty('needsOwnerAction');
    const active = (row.payload?.externalBlockers as Array<{ ref: string; status: string }>).filter(
      (blocker) => blocker.status === 'active',
    );
    expect(active.map((blocker) => blocker.ref)).toEqual(['owner-microphone-acceptance']);
  });

  it('a terminal dependency edge opens only dependents whose full blocker set is resolved', async () => {
    await edge({ plan: 'pdependency', item: 'P-002', srcRef: 'WI-ready' });
    await edge({ plan: 'pdependency', item: 'P-003', srcRef: 'WI-still-blocked' });

    const readyRef = planLaneBlockerRef('pdependency', 'P-002');
    const stillBlockedRef = planLaneBlockerRef('pdependency', 'P-003');
    const { blockers: readyBlockers } = updateExternalBlockerHistory(
      {},
      { kind: 'gate', capability: 'live-dependency', ref: readyRef, summary: 'parked' },
      'system:plan-item-lane-sync',
    );
    const { blockers: stillBlockedBlockers } = updateExternalBlockerHistory(
      {},
      { kind: 'gate', capability: 'live-dependency', ref: stillBlockedRef, summary: 'parked' },
      'system:plan-item-lane-sync',
    );
    const ready = stub({
      id: 'WI-ready',
      state: 'blocked',
      payload: {
        _claimHold: true,
        held_open_by: 'system:plan-item-lane-sync',
        held_open_at: new Date().toISOString(),
        externalBlockers: readyBlockers,
      },
    });
    const stillBlocked = stub({
      id: 'WI-still-blocked',
      state: 'blocked',
      payload: { externalBlockers: stillBlockedBlockers },
    });
    h3.getPlanRow.mockResolvedValue({
      items: [
        { id: 'P-001', status: 'done', blockedBy: [] },
        { id: 'P-004', status: 'todo', blockedBy: [] },
        { id: 'P-002', status: 'todo', blockedBy: ['P-001'] },
        { id: 'P-003', status: 'todo', blockedBy: ['P-001', 'P-004'] },
      ],
    });

    const action = await fireBuiltinReactionAction(
      PLAN_ITEM_LANE_RESYNC_ACTION,
      { dependencies: [{ planSlug: 'pdependency', itemId: 'P-001', harnessSlug: null }] },
      WS,
    );

    expect(action.ok).toBe(true);
    expect(ready.state).toBe('open');
    expect(stillBlocked.state).toBe('blocked');
    expect(h4.setWorkItemClaimHold).toHaveBeenCalledWith(
      'WI-ready',
      false,
      expect.objectContaining({ by: 'system:plan-item-lane-sync' }),
    );
    expect(h4.setWorkItemClaimHold).not.toHaveBeenCalledWith('WI-still-blocked', false, expect.anything());
  });

  it('blocker history CAS rejects a lane gate conflict before lifecycle mutation', async () => {
    await edge({ plan: 'pcas', item: 'P-011', srcRef: 'WI-cas' });
    const row = stub({ id: 'WI-cas', harness: 'sheets', state: 'open', family: 'issue', lastProgressAt: null, payload: {} });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-011', status: 'blocked', blockedBy: [] }] });
    h4.mergeWorkItemPayload.mockResolvedValueOnce(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = await resyncPlanItemLaneNow('pcas', 'P-011', null);
      expect(result?.gated).toEqual([]);
      expect(result?.failures).toEqual([{ stage: 'apply-gate', workItemId: 'WI-cas', message: 'blocker history changed before lane gate write' }]);
      expect(row.state).toBe('open');
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(h4.mergeWorkItemPayload).toHaveBeenCalledWith('WI-cas', expect.any(Object), expect.objectContaining({ expectedExternalBlockers: undefined, requireNonTerminal: true }));
    } finally { warn.mockRestore(); }
  });

  it('keeps the lane blocker active when lifecycle restore fails, so the next sweep can retry', async () => {
    // EI-20268159828040355: clearing blocker history before the state write made a
    // concurrent lifecycle rejection permanent — the row stayed `blocked`, but the
    // actionable decision no longer saw an active lane blocker and skipped it.
    await edge({ plan: 'pretry', item: 'P-011', srcRef: 'WI-retry' });
    const ref = planLaneBlockerRef('pretry', 'P-011');
    const { blockers } = updateExternalBlockerHistory(
      {},
      { kind: 'gate', capability: 'live-dependency', ref, summary: 'parked' },
      'system:plan-item-lane-sync',
    );
    const row = stub({
      id: 'WI-retry',
      harness: 'sheets',
      state: 'blocked',
      family: 'issue',
      lastProgressAt: null,
      payload: {
        _claimHold: true,
        held_open_by: 'system:plan-item-lane-sync',
        held_open_at: new Date().toISOString(),
        externalBlockers: blockers,
      },
    });
    h3.getPlanRow.mockResolvedValue({
      items: [{ id: 'P-011', status: 'todo', blockedBy: [] }],
    });
    setWorkItemStateWithAliasInfo.mockRejectedValueOnce(new Error('concurrent lifecycle guard'));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const failed = await resyncPlanItemLaneNow('pretry', 'P-011', null);

      expect(failed).not.toBeNull();
      expect(failed!.ungated).toEqual([]);
      expect(failed!.failures).toEqual([
        { stage: 'apply-gate', workItemId: 'WI-retry', message: 'concurrent lifecycle guard' },
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"stage":"apply-gate"'));
    } finally {
      warn.mockRestore();
    }
    expect((row.payload?.externalBlockers as Array<{ status: string }>).some((b) => b.status === 'active')).toBe(true);
    expect(h4.mergeWorkItemPayload).not.toHaveBeenCalled();

    const retried = await resyncPlanItemLaneNow('pretry', 'P-011', null);

    expect(retried).not.toBeNull();
    expect(retried!.ungated).toEqual(['WI-retry']);
    expect(row.state).toBe('open');
    expect((row.payload?.externalBlockers as Array<{ status: string }>).some((b) => b.status === 'active')).toBe(false);
    expect(h4.setWorkItemClaimHold).toHaveBeenCalledWith(
      'WI-retry',
      false,
      expect.objectContaining({ by: 'system:plan-item-lane-sync' }),
    );
  });

  it('retries a 57014 lane write from fresh state while preserving the conversion-owned migration park', async () => {
    const plan = 'p-timeout-migration';
    const itemId = 'P-002';
    await edge({ plan, item: itemId, srcKind: 'feature', srcRef: 'sheets#F-migration' });
    const ref = planLaneBlockerRef(plan, itemId);
    const { blockers } = updateExternalBlockerHistory({},
      { kind: 'gate', capability: 'live-dependency', ref, summary: 'dependency blocked' },
      'system:plan-item-lane-sync');
    const row = stub({ id: 'F-migration', family: 'feature', state: 'blocked', payload: {
      externalBlockers: blockers, planLaneParkedFrom: 'open', _claimHold: true,
      claim_hold_by: 'migration:plan-line-work-item-nodes',
      claim_hold_reason: 'D-011: conversion-owned park until P-008',
    } });
    h3.getPlanRow.mockResolvedValue({ items: [
      { id: 'P-001', status: 'done', blockedBy: [] },
      { id: itemId, status: 'todo', blockedBy: ['P-001'] },
    ] });
    setWorkItemStateWithAliasInfo.mockRejectedValueOnce(Object.assign(
      new Error('operator write exceeded its time budget'), { pgCode: '57014' }));

    const result = await withExpectedLaneWarning(
      () => resyncPlanItemLaneNow(plan, itemId, 'sheets'), '"retryable":true');
    expect(result?.ungated).toEqual(['F-migration']);
    expect(result?.failures).toBeUndefined();
    expect(row.state).toBe('open');
    expect(activeExternalBlockers(row.payload)).toEqual([]);
    expect(row.payload).toMatchObject({ _claimHold: true, claim_hold_by: 'migration:plan-line-work-item-nodes' });
    expect(h4.setWorkItemClaimHold).not.toHaveBeenCalled();
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledTimes(2);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenLastCalledWith('F-migration', 'open',
      expect.objectContaining({ announceClaimable: false }));
  });

  it('reclassifies a new dependency before retrying a timed-out lane write', async () => {
    const plan = 'p-timeout-new-blocker';
    await edge({ plan, item: 'P-002', srcRef: 'WI-new-blocker' });
    const ref = planLaneBlockerRef(plan, 'P-002');
    const { blockers } = updateExternalBlockerHistory({},
      { kind: 'gate', capability: 'live-dependency', ref, summary: 'dependency blocked' },
      'system:plan-item-lane-sync');
    const row = stub({ id: 'WI-new-blocker', state: 'blocked', payload: { externalBlockers: blockers } });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-002', status: 'todo', blockedBy: [] }] });
    setWorkItemStateWithAliasInfo.mockImplementationOnce(async () => {
      h3.getPlanRow.mockResolvedValue({ items: [
        { id: 'P-002', status: 'todo', blockedBy: ['P-003'] },
        { id: 'P-003', status: 'todo', blockedBy: [] },
      ] });
      throw Object.assign(new Error('statement timeout'), { code: '57014' });
    });

    const result = await withExpectedLaneWarning(
      () => resyncPlanItemLaneNow(plan, 'P-002', null), '"retryable":true');
    expect(result?.failures).toBeUndefined();
    expect(row.state).toBe('blocked');
    expect(activeExternalBlockers(row.payload)).toHaveLength(1);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledOnce();
  });

  it.each(['items', 'dependencies'] as const)('reports an unreconciled lane to the reaction engine in %s mode', async (mode) => {
    const plan = `p-reaction-failure-${mode}`;
    await edge({ plan, item: 'P-002', srcRef: 'WI-reaction-failure' });
    const ref = planLaneBlockerRef(plan, 'P-002');
    const { blockers } = updateExternalBlockerHistory({},
      { kind: 'gate', capability: 'live-dependency', ref, summary: 'dependency blocked' },
      'system:plan-item-lane-sync');
    const row = stub({ id: 'WI-reaction-failure', state: 'blocked', payload: { externalBlockers: blockers } });
    h3.getPlanRow.mockResolvedValue({ items: [
      { id: 'P-001', status: 'done', blockedBy: [] },
      { id: 'P-002', status: 'todo', blockedBy: ['P-001'] },
    ] });
    setWorkItemStateWithAliasInfo.mockRejectedValueOnce(new Error('lifecycle guard rejected restore'));

    const result = await withExpectedLaneWarning(() => fireBuiltinReactionAction(PLAN_ITEM_LANE_RESYNC_ACTION, {
      [mode]: [{ planSlug: plan, itemId: mode === 'items' ? 'P-002' : 'P-001', harnessSlug: null }],
    }, WS), 'lifecycle guard rejected restore');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('WI-reaction-failure');
    expect(result.error).toContain('lifecycle guard rejected restore');
    expect(row.state).toBe('blocked');
    expect(activeExternalBlockers(row.payload)).toHaveLength(1);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledOnce();
  });

  it('ADDING a blocked-by edge parks the linked work-item RIGHT NOW (the symmetric mirror case)', async () => {
    await edge({ plan: 'pblk2', item: 'P-021', srcKind: 'feature', srcRef: 'sheets#F-xyz' });
    stub({ id: 'F-xyz', harness: 'sheets', state: 'todo', family: 'feature', lastProgressAt: null });
    h3.getPlanRow.mockResolvedValue({
      items: [
        { id: 'P-020', status: 'todo', blockedBy: [] },
        { id: 'P-021', status: 'todo', blockedBy: ['P-020'] }, // just added, unresolved
      ],
    });

    const result = await resyncPlanItemLaneNow('pblk2', 'P-021', null);

    expect(result).not.toBeNull();
    expect(result!.gated).toEqual(['F-xyz']);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'F-xyz',
      'blocked',
      expect.objectContaining({ by: 'system:plan-item-lane-sync' }),
    );
  });

  it('does not park a linked work-item named by its gated lane exit condition [WI-131638]', async () => {
    await edge({ plan: 'pcircular', item: 'P-007', srcRef: 'WI-41764' });
    const row = stub({
      id: 'WI-41764',
      state: 'todo',
      family: 'issue',
      payload: {},
    });
    h3.getPlanRow.mockResolvedValue({
      planSlug: 'pcircular',
      items: [
        { id: 'P-006', status: 'todo', blockedBy: [] },
        {
          id: 'P-007',
          status: 'todo',
          blockedBy: ['P-006'],
          text: 'require WI-41764 terminal proof before this lane can clear',
          decisionRefs: [],
        },
      ],
      nowNext: 'require WI-41764 terminal proof with status=passed',
      decisions: [],
    });

    const result = await resyncPlanItemLaneNow('pcircular', 'P-007', null);

    expect(result?.gated).toEqual([]);
    expect(result?.circularPrerequisites).toEqual([
      {
        kind: 'circular-prerequisite',
        planSlug: 'pcircular',
        itemId: 'P-007',
        workItemId: 'WI-41764',
        sources: ['lane-item-text', 'plan-now-next'],
      },
    ]);
    expect(row.state).toBe('todo');
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('D-050: replaces only plan-authored blocker edges while preserving an unrelated live blocker', async () => {
    const plan = 'p-dependency-replace';
    const target = stub({
      id: 'F-target',
      harness: 'sheets',
      state: 'todo',
      family: 'feature',
      payload: {
        [PLAN_AUTHORED_BLOCKERS_KEY]: {
          planSlug: plan,
          itemId: 'P-003',
          blockerWorkItemIds: ['F-old'],
        },
      },
    });
    stub({ id: 'F-old', harness: 'sheets', state: 'todo', family: 'feature' });
    stub({ id: 'F-new', harness: 'sheets', state: 'todo', family: 'feature' });
    stub({ id: 'F-manual', harness: 'sheets', state: 'todo', family: 'feature' });
    await insertDependencyRows(['F-target', 'F-old', 'F-new', 'F-manual']);
    await edge({ plan, item: 'P-001', srcKind: 'feature', srcRef: 'sheets#F-old' });
    await edge({ plan, item: 'P-002', srcKind: 'feature', srcRef: 'sheets#F-new' });
    await edge({ plan, item: 'P-003', srcKind: 'feature', srcRef: 'sheets#F-target' });
    await syncFeatureBlockEdges('sheets', 'F-target', ['F-old', 'F-manual']);
    h3.getPlanRow.mockResolvedValue({
      items: [
        { id: 'P-001', status: 'todo', blockedBy: [] },
        { id: 'P-002', status: 'todo', blockedBy: [] },
        { id: 'P-003', status: 'todo', blockedBy: ['P-002'] },
      ],
    });

    const result = await reconcilePlanAuthoredDependenciesNow(plan, 'P-003', null);

    expect(result).toEqual({
      canonicalId: 'F-target',
      desired: ['F-manual', 'F-new'],
      resolved: ['F-new'],
    });
    expect((await getFeatureBlockers('sheets')).get('F-target')?.sort()).toEqual(['F-manual', 'F-new']);
    expect(target.payload?.[PLAN_AUTHORED_BLOCKERS_KEY]).toEqual({
      planSlug: plan,
      itemId: 'P-003',
      blockerWorkItemIds: ['F-new'],
    });
  });

  it.each([
    { label: 'the matching holder', createdBy: 'su-holder', admitted: true },
    { label: 'a different caller', createdBy: 'su-other', admitted: false },
    { label: 'no authenticated caller', createdBy: undefined, admitted: false },
  ])('D-050: admits a plan-authored edge behind an active dependant only for $label', async ({
    createdBy,
    admitted,
  }) => {
    const plan = 'p-dependency-author';
    const target = stub({
      id: 'F-target',
      harness: 'sheets',
      state: 'wip',
      family: 'feature',
      assignee: 'su-holder',
    });
    stub({ id: 'F-new', harness: 'sheets', state: 'todo', family: 'feature' });
    await insertDependencyRows(['F-target', 'F-new']);
    await rootSql`
      UPDATE harness_shared.work_items
         SET status = 'wip', taken_by = 'su-holder'
       WHERE workspace_id = ${WS} AND harness_slug = 'sheets' AND feature_id = 'F-target'`;
    await edge({ plan, item: 'P-002', srcKind: 'feature', srcRef: 'sheets#F-new' });
    await edge({ plan, item: 'P-003', srcKind: 'feature', srcRef: 'sheets#F-target' });
    h3.getPlanRow.mockResolvedValue({ items: [
      { id: 'P-002', status: 'todo', blockedBy: [] },
      { id: 'P-003', status: 'wip', blockedBy: ['P-002'] },
    ] });

    const result = await reconcilePlanAuthoredDependenciesNow(plan, 'P-003', null, createdBy);
    const edges = await rootSql`
      SELECT created_by FROM harness_shared.work_item_deps
       WHERE blocked_ref = 'sheets#F-target' AND blocker_ref = 'sheets#F-new'`;

    if (admitted) {
      expect(result).toEqual({ canonicalId: 'F-target', desired: ['F-new'], resolved: ['F-new'] });
      expect(edges).toEqual([{ created_by: 'su-holder' }]);
      expect(target.payload?.[PLAN_AUTHORED_BLOCKERS_KEY]).toEqual({
        planSlug: plan,
        itemId: 'P-003',
        blockerWorkItemIds: ['F-new'],
      });
    } else {
      expect(result).toBeNull();
      expect(edges).toEqual([]);
      expect(target.payload?.[PLAN_AUTHORED_BLOCKERS_KEY]).toBeUndefined();
    }
  });

  it.each([
    { label: 'the matching holder', createdBy: 'su-holder', admitted: true },
    { label: 'a different caller', createdBy: 'su-other', admitted: false },
    { label: 'no authenticated caller', createdBy: undefined, admitted: false },
  ])('D-050: terminal P-001 cascade resyncs held P-002..P-004 as $label', async ({ createdBy, admitted }) => {
    const plan = 'p-terminal-dependent-cascade';
    const dependentItems = ['P-002', 'P-003', 'P-004'];
    const targetIds = dependentItems.map((id) => `F-target-${id.slice(-1)}`);
    const blockerId = 'F-live-blocker';
    for (const targetId of targetIds) {
      stub({ id: targetId, harness: 'sheets', state: 'wip', family: 'feature', assignee: 'su-holder' });
    }
    stub({ id: blockerId, harness: 'sheets', state: 'todo', family: 'feature' });
    await insertDependencyRows([...targetIds, blockerId]);
    for (const targetId of targetIds) {
      await rootSql`
        UPDATE harness_shared.work_items
           SET status = 'wip', taken_by = 'su-holder'
         WHERE workspace_id = ${WS} AND harness_slug = 'sheets' AND feature_id = ${targetId}`;
    }
    for (const [index, itemId] of dependentItems.entries()) {
      await edge({ plan, item: itemId, srcKind: 'feature', srcRef: `sheets#${targetIds[index]}` });
    }
    await edge({ plan, item: 'P-005', srcKind: 'feature', srcRef: `sheets#${blockerId}` });
    h3.getPlanRow.mockResolvedValue({ items: [
      { id: 'P-001', status: 'done', blockedBy: [] },
      ...dependentItems.map((id) => ({ id, status: 'wip', blockedBy: ['P-001', 'P-005'] })),
      { id: 'P-005', status: 'todo', blockedBy: [] },
    ] });

    const resynced = await resyncDependentPlanItemLanesNow(plan, 'P-001', null, createdBy);
    const edges = await rootSql`
      SELECT blocked_ref, blocker_ref, created_by FROM harness_shared.work_item_deps
       WHERE blocker_ref = ${`sheets#${blockerId}`} ORDER BY blocked_ref`;

    expect(resynced).toEqual(dependentItems);
    expect(edges).toEqual(admitted
      ? targetIds.map((id) => ({
          blocked_ref: `sheets#${id}`,
          blocker_ref: `sheets#${blockerId}`,
          created_by: 'su-holder',
        }))
      : []);
    for (let index = 0; index < dependentItems.length; index++) {
      expect(h2.items.get(targetIds[index])?.payload?.[PLAN_AUTHORED_BLOCKERS_KEY]).toEqual(admitted
        ? { planSlug: plan, itemId: dependentItems[index], blockerWorkItemIds: [blockerId] }
        : undefined);
    }
  });

  it.each([
    { label: 'empty provenance', prior: [] as string[] | null },
    { label: 'replaced provenance', prior: ['F-old'] },
    // WI-10006540: no marker at all (first reconcile) owns NO edges, so it must remove none.
    // Passing undefined instead of [] would select the full-replace contract and drop WI-source.
    { label: 'no provenance marker', prior: null },
  ])('EI-252075: preserves mixed-family SUCCESS blockers with $label', async ({ prior }) => {
    const plan = 'p-mixed-success';
    const target = stub({
      id: 'F-target', harness: 'sheets', state: 'todo', family: 'feature',
      payload: prior === null ? {} : {
        [PLAN_AUTHORED_BLOCKERS_KEY]: { planSlug: plan, itemId: 'P-003', blockerWorkItemIds: prior },
      },
    });
    stub({ id: 'F-new', harness: 'sheets', state: 'todo', family: 'feature' });
    await insertDependencyRows(['F-target', 'F-old', 'F-new', 'F-manual']);
    await rootSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, payload, created_ts, updated_ts)
      VALUES (${WS}, 'sheets', 'WI-source', 'bug', 'open', '{}'::jsonb, 0, 0)`;
    await edge({ plan, item: 'P-002', srcKind: 'feature', srcRef: 'sheets#F-new' });
    await edge({ plan, item: 'P-003', srcKind: 'feature', srcRef: 'sheets#F-target' });
    await syncFeatureBlockEdges('sheets', 'F-target', prior ?? []);
    for (const blocker of [
      { kind: 'issue', ref: 'WI-source' },
      { kind: 'feature', ref: 'sheets#F-manual' },
    ]) {
      await mirrorWorkItemBlockingEdge(blocker, { kind: 'feature', ref: 'sheets#F-target' }, {
        satisfaction: 'success', createdBy: 'manual-source',
      });
    }
    const manualEdges = () => rootSql`
      SELECT id, blocker_kind, blocker_ref, satisfaction, created_by, created_at
        FROM harness_shared.work_item_deps
       WHERE blocked_ref = 'sheets#F-target'
         AND blocker_ref IN ('WI-source', 'sheets#F-manual')
       ORDER BY blocker_ref`;
    const before = await manualEdges();
    expect(before).toHaveLength(2);
    expect(before.every((row) => row.satisfaction === 'success')).toBe(true);
    h3.getPlanRow.mockResolvedValue({ items: [
      { id: 'P-002', status: 'todo', blockedBy: [] },
      { id: 'P-003', status: 'todo', blockedBy: ['P-002'] },
    ] });

    const result = await reconcilePlanAuthoredDependenciesNow(plan, 'P-003', null);

    expect(result).toEqual({ canonicalId: 'F-target', desired: ['F-manual', 'F-new'], resolved: ['F-new'] });
    expect(await manualEdges()).toEqual(before);
    expect((await getFeatureBlockers('sheets')).get('F-target')?.sort()).toEqual(['F-manual', 'F-new']);
    expect(target.payload?.[PLAN_AUTHORED_BLOCKERS_KEY]).toEqual({
      planSlug: plan, itemId: 'P-003', blockerWorkItemIds: ['F-new'],
    });

    // Strengthening a retained plan edge must also survive an idempotent reconciliation.
    await mirrorWorkItemBlockingEdge(
      { kind: 'feature', ref: 'sheets#F-new' }, { kind: 'feature', ref: 'sheets#F-target' },
      { satisfaction: 'success' },
    );
    // A repeat and then removal of the plan's last blocker must not touch either manual edge.
    await reconcilePlanAuthoredDependenciesNow(plan, 'P-003', null);
    expect(await manualEdges()).toEqual(before);
    expect(await rootSql`
      SELECT satisfaction FROM harness_shared.work_item_deps
       WHERE blocked_ref = 'sheets#F-target' AND blocker_ref = 'sheets#F-new'`
    ).toEqual([{ satisfaction: 'success' }]);
    h3.getPlanRow.mockResolvedValue({ items: [
      { id: 'P-002', status: 'todo', blockedBy: [] },
      { id: 'P-003', status: 'todo', blockedBy: [] },
    ] });
    await reconcilePlanAuthoredDependenciesNow(plan, 'P-003', null);
    expect(await manualEdges()).toEqual(before);
    expect((await getFeatureBlockers('sheets')).get('F-target')).toEqual(['F-manual']);
    expect(target.payload?.[PLAN_AUTHORED_BLOCKERS_KEY]).toEqual({
      planSlug: plan, itemId: 'P-003', blockerWorkItemIds: [],
    });
  });

  it('never clobbers independent in-flight progress even when the lane just went blocked', async () => {
    await edge({ plan: 'pblk3', item: 'P-031', srcKind: 'feature', srcRef: 'sheets#F-active2' });
    stub({
      id: 'F-active2',
      harness: 'sheets',
      state: 'wip',
      family: 'feature',
      lastProgressAt: '2026-07-20T00:00:00Z',
      assignee: 'su-live-holder',
    });
    h3.getPlanRow.mockResolvedValue({
      items: [
        { id: 'P-030', status: 'todo', blockedBy: [] },
        { id: 'P-031', status: 'todo', blockedBy: ['P-030'] },
      ],
    });

    const result = await resyncPlanItemLaneNow('pblk3', 'P-031', null);

    expect(result).not.toBeNull();
    expect(result!.gated).toEqual([]);
    expect(result!.skippedInFlight).toEqual(['F-active2']);
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('is a fail-closed no-op when the plan cannot be resolved (getPlanRow → null)', async () => {
    await edge({ plan: 'pnoplan', item: 'P-001', srcRef: 'WI-x' });
    stub({ id: 'WI-x', harness: 'sheets', state: 'blocked', family: 'issue', lastProgressAt: null });
    h3.getPlanRow.mockResolvedValue(null);

    const result = await resyncPlanItemLaneNow('pnoplan', 'P-001', null);

    expect(result).toBeNull();
    expect(h4.setWorkItemClaimHold).not.toHaveBeenCalled();
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });
});

describe('reconcileOrphanedPlanItemWorkItems — circular prerequisite census [WI-131638]', () => {
  it('aggregates typed circular-prerequisite findings without parking the candidate', async () => {
    await insertWorkItemRow({
      id: 'WI-periodic-cycle',
      kind: 'bug',
      status: 'todo',
      planSlug: 'pperiodic-cycle',
      itemId: 'P-007',
    });
    await edge({ plan: 'pperiodic-cycle', item: 'P-007', srcRef: 'WI-periodic-cycle' });
    const row = stub({
      id: 'WI-periodic-cycle',
      state: 'todo',
      family: 'issue',
      payload: {},
    });
    h3.getPlanRow.mockResolvedValue({
      planSlug: 'pperiodic-cycle',
      items: [
        {
          id: 'P-007',
          status: 'todo',
          blockedBy: ['P-006'],
          text: 'WI-periodic-cycle must reach terminal proof',
          decisionRefs: [],
        },
        { id: 'P-006', status: 'todo', blockedBy: [] },
      ],
      nowNext: null,
      decisions: [],
    });

    const result = await reconcileOrphanedPlanItemWorkItems();

    expect(result.circularPrerequisites).toEqual([
      {
        kind: 'circular-prerequisite',
        planSlug: 'pperiodic-cycle',
        itemId: 'P-007',
        workItemId: 'WI-periodic-cycle',
        sources: ['lane-item-text'],
      },
    ]);
    expect(result.gated).toEqual([]);
    expect(row.state).toBe('todo');
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });
});
