import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryPlanPartsStore } from './store';
import { capturePlanParts } from './federation';
import {
  reconcilePlanParts,
  ensurePlanPartsReconciledOnce,
  __resetPlanPartsReconcileOnceForTests,
  type PlanContentRow,
} from './reconcile';
import { joinFederatedParts } from '@papercusp/plan-parser';

const PLAN_A = `---\ntitle: A\nslug: a\n---\n\n# A\n\n## Phase 1 — x\n\n- **P-001** \`todo\` one\n- **P-002** \`todo\` two\n`;
const PLAN_B = `---\ntitle: B\nslug: b\n---\n\n# B\n\n## Now\n\n**State:** hi\n`;

function rig(plans: PlanContentRow[]) {
  const stores = new Map<string, InMemoryPlanPartsStore>();
  const storeFor = (_sql: unknown, _ws: string, h: string) => {
    let s = stores.get(h);
    if (!s) { s = new InMemoryPlanPartsStore(); stores.set(h, s); }
    return s;
  };
  return {
    stores,
    deps: {
      workspaceId: 'ws',
      sql: {} as never,
      loadPlans: async () => plans,
      storeFor: storeFor as never,
    },
  };
}

describe('reconcilePlanParts (P-005 capture / P-007 backfill)', () => {
  it('backfills every plan into per-part rows; the parts recompose to the source', async () => {
    const { stores, deps } = rig([
      { harness_slug: 'h', plan_slug: 'a', content: PLAN_A, content_ts: 1000 },
      { harness_slug: 'h', plan_slug: 'b', content: PLAN_B, content_ts: 1000 },
    ]);
    const r = await reconcilePlanParts(deps);
    expect(r.plansScanned).toBe(2);
    expect(r.partsWritten).toBeGreaterThan(0);
    expect(r.errors).toBe(0);
    const store = stores.get('h')!;
    expect(joinFederatedParts(await store.getParts('a'))).toBe(PLAN_A); // round-trips
    expect(joinFederatedParts(await store.getParts('b'))).toBe(PLAN_B);
  });

  it('is idempotent — a second run over unchanged content writes nothing', async () => {
    const { deps } = rig([{ harness_slug: 'h', plan_slug: 'a', content: PLAN_A, content_ts: 1000 }]);
    const first = await reconcilePlanParts(deps);
    expect(first.partsWritten).toBeGreaterThan(0);
    const second = await reconcilePlanParts(deps);
    expect(second.partsWritten).toBe(0); // diff sees no change
  });

  it('captures only the CHANGED part on an edit', async () => {
    const { deps } = rig([{ harness_slug: 'h', plan_slug: 'a', content: PLAN_A, content_ts: 1000 }]);
    await reconcilePlanParts(deps);
    // Edit one item; re-point loadPlans at the edited content.
    const edited = PLAN_A.replace('`todo` one', '`done` ONE');
    (deps.loadPlans as unknown) = async () => [{ harness_slug: 'h', plan_slug: 'a', content: edited, content_ts: 2000 }];
    const r = await reconcilePlanParts(deps);
    expect(r.partsWritten).toBe(1); // just item:P-001
  });

  // WI-10004610: the sweep loads every plan up front and reaches each one later. A plan
  // edited in between is held as its OLD body; stamped with the sweep's clock it beat
  // the edit's own capture, and the next recompose rewrote the plan with the old body.
  it('a body loaded before a later edit cannot overwrite that edit\'s parts', async () => {
    const edited = PLAN_A.replace('`todo` one', '`done` ONE');
    const { stores, deps } = rig([{ harness_slug: 'h', plan_slug: 'a', content: PLAN_A, content_ts: 1000 }]);
    await reconcilePlanParts(deps); // baseline at the old body's write time
    const store = stores.get('h')!;
    // The edit commits AFTER the sweep loaded the old body; with-plan-lock captures it.
    await capturePlanParts(store, 'a', edited, 2000, 'local');

    // The sweep now reaches the plan still holding the old body (written at 1000).
    await reconcilePlanParts(deps);
    expect(joinFederatedParts(await store.getParts('a'))).toBe(edited);

    // Positive control: the same old body, genuinely written AFTER the edit (a real
    // revert), is captured — so the assertion above can fail, it is not vacuous.
    (deps.loadPlans as unknown) = async () => [{ harness_slug: 'h', plan_slug: 'a', content: PLAN_A, content_ts: 3000 }];
    await reconcilePlanParts(deps);
    expect(joinFederatedParts(await store.getParts('a'))).toBe(PLAN_A);
  });

  // WI-10006276: a body the per-part recompose wrote (origin='remote') is DERIVED from the
  // parts, so the parts are authoritative. Its updated_at is the LOCAL recompose time, which
  // can be later than the authoring time of newer parts that arrived but are not recomposed
  // yet (a node catching up after being offline). Re-capturing it published the old body as
  // the newest parts — the same rollback as WI-10004610, through a later stamp.
  it('never re-captures a recompose-derived (origin=remote) body over existing parts', async () => {
    const edited = PLAN_A.replace('`todo` one', '`done` ONE');
    const { stores, deps } = rig([{ harness_slug: 'h', plan_slug: 'a', content: PLAN_A, content_ts: 1000 }]);
    await reconcilePlanParts(deps);
    const store = stores.get('h')!;
    // The newer version arrives from a peer (authored at 2000) and is not recomposed yet.
    await capturePlanParts(store, 'a', edited, 2000, 'peer');
    // The row still holds the old body, which a local recompose wrote at 5000.
    (deps.loadPlans as unknown) = async () => [
      { harness_slug: 'h', plan_slug: 'a', content: PLAN_A, content_ts: 5000, origin: 'remote' },
    ];
    const r = await reconcilePlanParts(deps);
    expect(r.partsWritten).toBe(0);
    expect(joinFederatedParts(await store.getParts('a'))).toBe(edited);

    // Positive control: a remote-origin row with NO parts yet is still backfilled, so the
    // skip is scoped to bodies already represented in parts.
    const fresh = rig([{ harness_slug: 'h', plan_slug: 'b', content: PLAN_B, content_ts: 5000, origin: 'remote' }]);
    await reconcilePlanParts(fresh.deps);
    expect(joinFederatedParts(await fresh.stores.get('h')!.getParts('b'))).toBe(PLAN_B);
  });

  it('isolates a per-plan failure (loadPlans throw → errors, never throws)', async () => {
    const r = await reconcilePlanParts({
      workspaceId: 'ws',
      sql: {} as never,
      loadPlans: async () => { throw new Error('db down'); },
    });
    expect(r.errors).toBe(1);
    expect(r.plansScanned).toBe(0);
  });
});

describe('ensurePlanPartsReconciledOnce (flag-gated, once-per-process)', () => {
  beforeEach(() => __resetPlanPartsReconcileOnceForTests());

  it('flag OFF → no-op (DARK): the reconcile never loads plans', async () => {
    let loaded = false;
    ensurePlanPartsReconciledOnce(['ws'], {
      isFlagOn: async () => false,
      loadPlans: async () => { loaded = true; return []; },
      storeFor: (() => new InMemoryPlanPartsStore()) as never,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(loaded).toBe(false);
  });

  it('flag ON → runs once; a second call no-ops (once-flag)', async () => {
    let runs = 0;
    // Wait on the EVENT, not on a duration. ensurePlanPartsReconciledOnce fires a
    // detached async IIFE (await isFlagOn → await reconcilePlanParts → loadPlans),
    // and this used to sleep a fixed 5ms for that chain to land. That passes on an
    // idle box and fails under full-suite load, where 5ms elapses before the chain
    // reaches loadPlans — leaving runs at 0 and reddening the shared gate with
    // "expected +0 to be 1" while the production code was entirely correct.
    let firstRunReached!: () => void;
    const firstRun = new Promise<void>((resolve) => {
      firstRunReached = resolve;
    });
    const seams = {
      isFlagOn: async () => true,
      // `sql` must be injected even though every other seam is: reconcilePlanParts
      // resolves `deps.sql ?? getOrgPg().sql` BEFORE it calls loadPlans, so without
      // this the real pool is opened (and the no-real-PG rail throws) before any
      // seam runs — swallowed by the best-effort catch, leaving runs at 0.
      sql: {} as never,
      loadPlans: async () => {
        runs++;
        firstRunReached();
        return [];
      },
      storeFor: (() => new InMemoryPlanPartsStore()) as never,
    };
    ensurePlanPartsReconciledOnce(['ws'], seams);
    await firstRun; // the first run provably happened — no timing assumption
    ensurePlanPartsReconciledOnce(['ws'], seams); // once-flag → skipped
    // This second wait asserts NON-occurrence, so a fixed settle is sound: under
    // load a would-be second run is slower, which can only mask a regression here,
    // never manufacture the false failure the first wait was causing.
    await new Promise((r) => setTimeout(r, 5));
    expect(runs).toBe(1);
  });
});
