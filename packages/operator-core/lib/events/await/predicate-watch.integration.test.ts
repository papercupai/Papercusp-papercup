/**
 * predicate-watch.integration.test.ts — the predicate-watch store + eval + GC
 * lifecycle against real Postgres (fleet-deltas-leader-primitives-2026-07-10
 * P-008, migration 541 + the paired event_awaits rows from migration 163).
 *
 * Dispatch is faked via the configurePredicateDispatch seam (the projected-tool
 * dispatch itself is dispatch-projected's tested territory); emitAwaitedEvent is
 * faked to RECORD the emit and still drive the REAL store.fireAwaitsForKey, so
 * once-await consumption and the GC coupling stay honest. Follows the
 * org-fixture mock pattern (test/_org-test-db.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../../test/_org-test-db';
import type { PredicateOp } from './predicate-watch';
import type { CellSpec } from '../../cell-registry';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// P-005 drives its predicates off the REAL cell specs, so a registration edit moves the
// test with it instead of leaving it polling a path the cell no longer declares.
import { GATE_CANDIDATE_CELL, GIT_PIPELINE_POSITION_CELL } from '../../cell-registrations';

const h = vi.hoisted(() => ({
  sql: null as any,
  emits: [] as Array<{ key: string; payload: any; summary?: string }>,
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
  withWorkspace: async (_ws: string, fn: (tx: unknown) => Promise<unknown>) => fn(h.sql),
}));
// The real dispatch path is exercised in prod via dispatch-projected (tested
// there); tests drive the configurePredicateDispatch seam instead.
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  lookupByMcpName: () => undefined,
  dispatchProjectedTool: async () => ({ ok: false, error: { code: 'test', message: 'not wired in tests' } }),
}));
vi.mock('../../projected-tool-deps', () => ({ PROJECTED_DEPS: {} }));
vi.mock('@papercusp/scheduled-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/scheduled-registry')>()),
  managedSetInterval: () => ({ unref: () => {} }),
}));
vi.mock('./engine', () => ({
  emitAwaitedEvent: async (opts: { key: string; payload?: unknown; summary?: string }) => {
    h.emits.push({ key: opts.key, payload: opts.payload, summary: opts.summary });
    const store = await import('./store');
    const fired = await store.fireAwaitsForKey({ eventKey: opts.key, payload: opts.payload });
    return { ok: true, key: opts.key, woken: fired.length, notified: [], msgId: null, waiters: fired.length };
  },
}));

const pw = await import('./predicate-watch');
const store = await import('./store');
const servingHost = await import('../../serving-host-identity');
const { createOrgTestDb } = await import('../../../test/_org-test-db');

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_871_ARMED = resolve(HERE, '../../../../../libs/papercusp/libs/db/sql/871-lifecycle-bound-watches.sql');
const MIGRATION_871 = existsSync(MIGRATION_871_ARMED) ? MIGRATION_871_ARMED : `${MIGRATION_871_ARMED}.DRAFT`;

let seq = 0;
/** Register the paired await FIRST (the GC invariant), then the watch row. */
async function seedWatch(opts: {
  once?: boolean;
  awaitOnce?: boolean;
  intervalSec?: number;
  timeoutSec?: number;
  op?: PredicateOp;
  value?: unknown;
  path?: string;
  boundTo?: { kind: string; ref: string };
}) {
  const id = globalThis.crypto.randomUUID();
  const eventKey = `predicate:${id}`;
  const subscriber = `su-pw-${++seq}`;
  const awaitRow = await store.registerAwait({
    subscriberId: subscriber,
    eventKey,
    once: opts.awaitOnce ?? opts.once ?? true,
    timeoutSec: opts.timeoutSec,
    boundTo: opts.boundTo,
  });
  const row = await pw.registerPredicateWatch({
    id,
    workspaceId: 'ws-pw-test',
    ownerId: subscriber,
    role: 'su',
    harnessSlug: null,
    eventKey,
    tool: 'fake:read',
    args: {},
    path: opts.path ?? 'wm',
    op: opts.op ?? 'gt',
    value: opts.value ?? 127,
    intervalSec: opts.intervalSec ?? 60,
    once: opts.once ?? true,
    boundTo: opts.boundTo,
  });
  return { row, awaitRow, eventKey, subscriber };
}

async function backdate(id: string, seconds = 3600) {
  await h.sql`
    UPDATE harness_shared.predicate_watches
       SET last_polled_at = now() - make_interval(secs => ${seconds})
     WHERE id = ${id}
  `;
}

describe('predicate watches (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    // The allocator keeps migration 871 parked as .DRAFT until verification is
    // green. Apply that exact source to this throwaway DB so the pre-arm test
    // exercises the real DDL without exposing a half-verified migration to boot.
    await h.sql.unsafe(readFileSync(MIGRATION_871, 'utf8'));
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  afterEach(() => {
    pw.configurePredicateDispatch(null);
    h.emits = [];
  });

  it('registration stamps last_polled_at, so a fresh row is not due until its interval', async () => {
    const { row } = await seedWatch({ intervalSec: 60 });
    expect(row.active).toBe(true);
    expect(row.lastPolledAt).not.toBeNull();
    const due = await pw.claimDuePredicateWatches();
    expect(due.map((d) => d.id)).not.toContain(row.id);
  });

  it('persists a lifecycle binding and names it in both match and terminal-error payloads', async () => {
    const binding = { kind: 'plan-lane', ref: 'state-plane#P-013' };
    const matched = await seedWatch({ once: true, op: 'gt', value: 3, boundTo: binding });
    expect(matched.row.boundTo).toEqual(binding);
    expect(matched.awaitRow.boundTo).toEqual(binding);

    pw.configurePredicateDispatch(async () => ({ wm: 4 }));
    await expect(pw.evalPredicateWatch(matched.row)).resolves.toMatchObject({ fired: true });
    expect(h.emits.at(-1)?.payload).toMatchObject({
      observed: 4,
      bound_to: binding,
      armed_because: 'interest machinery bound this watch to plan-lane:state-plane#P-013',
    });

    const errored = await seedWatch({ once: true, boundTo: binding });
    await h.sql`
      UPDATE harness_shared.predicate_watches
         SET consecutive_errors = ${pw.PREDICATE_MAX_CONSECUTIVE_ERRORS - 1}
       WHERE id = ${errored.row.id}`;
    pw.configurePredicateDispatch(async () => {
      throw new Error('resolver unavailable');
    });
    await expect(pw.evalPredicateWatch((await pw.getPredicateWatch(errored.row.id))!)).resolves.toMatchObject({
      fired: true,
      deactivated: true,
    });
    expect(h.emits.at(-1)?.payload).toMatchObject({
      predicateError: 'resolver unavailable',
      bound_to: binding,
      armed_because: 'interest machinery bound this watch to plan-lane:state-plane#P-013',
    });
  });

  it('migration 871 rejects whitespace-only and extra-key lifecycle addresses', async () => {
    const { row, awaitRow } = await seedWatch({ once: false });
    await expect(h.sql`
      UPDATE harness_shared.predicate_watches
         SET bound_to = ${{ kind: 'fleet-leadership', ref: '   ' }}
       WHERE id = ${row.id}`).rejects.toThrow(/predicate_watches_bound_to_shape/);
    await expect(h.sql`
      UPDATE harness_shared.event_awaits
         SET bound_to = ${{ kind: 'work-item', ref: 'WI-1', extra: true }}
       WHERE id = ${awaitRow.id}`).rejects.toThrow(/event_awaits_bound_to_shape/);
  });

  it('claim-by-stamp: a backdated row is claimed exactly once per window', async () => {
    const { row } = await seedWatch({ intervalSec: 5 });
    await backdate(row.id);
    const first = await pw.claimDuePredicateWatches();
    expect(first.map((d) => d.id)).toContain(row.id);
    const second = await pw.claimDuePredicateWatches();
    expect(second.map((d) => d.id)).not.toContain(row.id);
  });

  it('once:true lifecycle — below threshold: no fire; cross: EDGE-fires, consumes the await, deactivates', async () => {
    const { row, eventKey } = await seedWatch({ once: true, op: 'gt', value: 127 });

    pw.configurePredicateDispatch(async () => ({ wm: 127 }));
    const below = await pw.evalPredicateWatch(row);
    expect(below).toMatchObject({ matched: false, fired: false, deactivated: false });
    expect(h.emits).toHaveLength(0);

    pw.configurePredicateDispatch(async () => ({ wm: 128 }));
    const crossed = await pw.evalPredicateWatch((await pw.getPredicateWatch(row.id))!);
    expect(crossed).toMatchObject({ matched: true, fired: true, deactivated: true });
    expect(h.emits).toHaveLength(1);
    expect(h.emits[0].key).toBe(eventKey);
    expect(h.emits[0].payload).toMatchObject({ observed: 128, predicate: { tool: 'fake:read', op: 'gt', value: 127 } });

    // The once-await was consumed by the fire; the row is inactive and never claimed again.
    expect(await store.listActiveAwaitsForKey(eventKey)).toHaveLength(0);
    const after = (await pw.getPredicateWatch(row.id))!;
    expect(after.active).toBe(false);
    expect(after.lastEval).toBe(true);
    await backdate(row.id);
    expect((await pw.claimDuePredicateWatches()).map((d) => d.id)).not.toContain(row.id);
  });

  it('once:false is edge-triggered — no re-fire while true; re-fires only on the next false→true cross', async () => {
    const { row } = await seedWatch({ once: false, awaitOnce: false, op: 'gte', value: 10 });

    pw.configurePredicateDispatch(async () => ({ wm: 12 }));
    const first = await pw.evalPredicateWatch(row);
    expect(first).toMatchObject({ matched: true, fired: true, deactivated: false });

    // Still true → NO second fire (lastEval already true).
    const still = await pw.evalPredicateWatch((await pw.getPredicateWatch(row.id))!);
    expect(still).toMatchObject({ matched: true, fired: false });
    expect(h.emits).toHaveLength(1);

    // Drop below, then re-cross → second fire; row stays active throughout.
    pw.configurePredicateDispatch(async () => ({ wm: 3 }));
    await pw.evalPredicateWatch((await pw.getPredicateWatch(row.id))!);
    pw.configurePredicateDispatch(async () => ({ wm: 11 }));
    const recross = await pw.evalPredicateWatch((await pw.getPredicateWatch(row.id))!);
    expect(recross).toMatchObject({ matched: true, fired: true });
    expect(h.emits).toHaveLength(2);
    expect((await pw.getPredicateWatch(row.id))!.active).toBe(true);
  });

  it('error ladder — errors accumulate; the 5th consecutive one deactivates AND emits predicateError', async () => {
    const { row, eventKey } = await seedWatch({ once: true });
    pw.configurePredicateDispatch(async () => {
      throw new Error('role gate: denied');
    });
    for (let i = 1; i <= pw.PREDICATE_MAX_CONSECUTIVE_ERRORS; i++) {
      const r = await pw.evalPredicateWatch((await pw.getPredicateWatch(row.id))!);
      expect(r.error).toMatch(/role gate/);
      const cur = (await pw.getPredicateWatch(row.id))!;
      expect(cur.consecutiveErrors).toBe(i);
      expect(cur.lastError).toMatch(/role gate/);
      expect(cur.active).toBe(i < pw.PREDICATE_MAX_CONSECUTIVE_ERRORS);
    }
    expect(h.emits).toHaveLength(1);
    expect(h.emits[0].key).toBe(eventKey);
    expect(h.emits[0].payload).toMatchObject({ predicateError: expect.stringContaining('role gate') });
  });

  it('a successful eval resets the error ladder', async () => {
    const { row } = await seedWatch({ once: true, op: 'gt', value: 999 });
    pw.configurePredicateDispatch(async () => {
      throw new Error('transient');
    });
    await pw.evalPredicateWatch(row);
    expect((await pw.getPredicateWatch(row.id))!.consecutiveErrors).toBe(1);
    pw.configurePredicateDispatch(async () => ({ wm: 1 }));
    await pw.evalPredicateWatch((await pw.getPredicateWatch(row.id))!);
    const cur = (await pw.getPredicateWatch(row.id))!;
    expect(cur.consecutiveErrors).toBe(0);
    expect(cur.lastError).toBeNull();
  });

  it('GC deactivates a row whose paired await was cancelled; a live standing await protects its row', async () => {
    const dead = await seedWatch({ once: true });
    const alive = await seedWatch({ once: false, awaitOnce: false });
    await store.cancelAwait({ awaitId: dead.awaitRow.id, subscriberId: dead.subscriber });

    const gc = await pw.gcOrphanedPredicateWatches();
    expect(gc).toBeGreaterThanOrEqual(1);
    expect((await pw.getPredicateWatch(dead.row.id))!.active).toBe(false);
    expect((await pw.getPredicateWatch(dead.row.id))!.lastError).toMatch(/gc:/);
    expect((await pw.getPredicateWatch(alive.row.id))!.active).toBe(true);
  });

  it('retains a timed-out predicate spec for its registrant, but not for another subscriber', async () => {
    const timedOut = await seedWatch({ once: true, timeoutSec: 3600 });
    await h.sql.unsafe(
      'UPDATE harness_shared.event_awaits SET expires_ts = now() - make_interval(secs => 1) WHERE id = ' +
        Number(timedOut.awaitRow.id),
    );
    const expiredAwaits = await store.fireTimedOutAwaits();
    expect(expiredAwaits).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: timedOut.awaitRow.id, firedReason: 'timeout' })]),
    );
    await pw.gcOrphanedPredicateWatches();

    const recovered = await pw.getPredicateTimeoutContext({
      eventKey: timedOut.eventKey,
      subscriberId: timedOut.subscriber,
    });
    expect(recovered).toMatchObject({
      id: timedOut.row.id,
      eventKey: timedOut.eventKey,
      ownerId: timedOut.subscriber,
      active: false,
      tool: 'fake:read',
      args: {},
      path: 'wm',
      op: 'gt',
      value: 127,
    });
    await expect(
      pw.getPredicateTimeoutContext({ eventKey: timedOut.eventKey, subscriberId: 'other-subscriber' }),
    ).resolves.toBeNull();
  });

  it('pollDuePredicateWatches — one tick GCs, claims the due batch, and fires crossed rows', async () => {
    const { row, eventKey } = await seedWatch({ once: true, op: 'gte', value: 128, intervalSec: 5 });
    await backdate(row.id);
    pw.configurePredicateDispatch(async () => ({ wm: 128 }));
    const tick = await pw.pollDuePredicateWatches();
    expect(tick.polled).toBeGreaterThanOrEqual(1);
    expect(tick.fired).toBeGreaterThanOrEqual(1);
    expect(h.emits.some((e) => e.key === eventKey)).toBe(true);
    expect((await pw.getPredicateWatch(row.id))!.active).toBe(false);
  });

  describe('findMatchingActivePredicateWatch (P-004 dedup, fleet-reliability-verification-2026-07-10)', () => {
    // A unique `path` PER TEST — every other test in this file seeds against the
    // default path 'wm' (many still active, never fired/cancelled), so a shared
    // path here would spuriously match a STALE row left over from an earlier test
    // rather than proving this test's own dedup logic.
    let dedupSeq = 0;
    const scopeFor = (path: string) => ({
      workspaceId: 'ws-pw-test',
      role: 'su',
      harnessSlug: null,
      tool: 'fake:read',
      args: {},
      path,
    });

    it('matches an existing ACTIVE row with the identical scope + predicate + cardinality', async () => {
      const path = `dedup-probe-${++dedupSeq}`;
      const { row } = await seedWatch({ once: true, op: 'gt', value: 127, intervalSec: 30, path });
      const match = await pw.findMatchingActivePredicateWatch({
        ...scopeFor(path),
        op: 'gt',
        value: 127,
        intervalSec: 30,
        once: true,
      });
      expect(match?.id).toBe(row.id);
    });

    it("does NOT match a different role — the poll dispatches under the registrant's authority envelope", async () => {
      const path = `dedup-probe-${++dedupSeq}`;
      await seedWatch({ once: true, op: 'gt', value: 127, intervalSec: 30, path });
      const match = await pw.findMatchingActivePredicateWatch({
        ...scopeFor(path),
        role: 'worker',
        op: 'gt',
        value: 127,
        intervalSec: 30,
        once: true,
      });
      expect(match).toBeNull();
    });

    it("does NOT match a different `once` cardinality (the shared row's `once` governs deactivate-on-fire for everyone on it)", async () => {
      const path = `dedup-probe-${++dedupSeq}`;
      await seedWatch({ once: true, op: 'gt', value: 127, intervalSec: 30, path });
      const match = await pw.findMatchingActivePredicateWatch({
        ...scopeFor(path),
        op: 'gt',
        value: 127,
        intervalSec: 30,
        once: false,
      });
      expect(match).toBeNull();
    });

    it('does NOT match a different interval_sec, op, or value', async () => {
      const path = `dedup-probe-${++dedupSeq}`;
      await seedWatch({ once: true, op: 'gt', value: 127, intervalSec: 30, path });
      expect(
        await pw.findMatchingActivePredicateWatch({
          ...scopeFor(path),
          op: 'gt',
          value: 127,
          intervalSec: 60,
          once: true,
        }),
      ).toBeNull();
      expect(
        await pw.findMatchingActivePredicateWatch({
          ...scopeFor(path),
          op: 'gte',
          value: 127,
          intervalSec: 30,
          once: true,
        }),
      ).toBeNull();
      expect(
        await pw.findMatchingActivePredicateWatch({
          ...scopeFor(path),
          op: 'gt',
          value: 999,
          intervalSec: 30,
          once: true,
        }),
      ).toBeNull();
    });

    it('does NOT match a DEACTIVATED row (a GC/error/fired row is not joinable)', async () => {
      const path = `dedup-probe-${++dedupSeq}`;
      const { row, awaitRow, subscriber } = await seedWatch({
        once: true,
        op: 'gt',
        value: 127,
        intervalSec: 30,
        path,
      });
      await store.cancelAwait({ awaitId: awaitRow.id, subscriberId: subscriber });
      await pw.gcOrphanedPredicateWatches();
      expect((await pw.getPredicateWatch(row.id))!.active).toBe(false);
      const match = await pw.findMatchingActivePredicateWatch({
        ...scopeFor(path),
        op: 'gt',
        value: 127,
        intervalSec: 30,
        once: true,
      });
      expect(match).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // P-005 — `state:subscribe` end-to-end over a REAL cell
  // (agent-state-plane-verification-2026-07-27)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The suites above prove the predicate machinery is edge-correct for a hand-written
   * (tool, path, op, value). This one proves the CELL half: that a subscription whose
   * predicate came from a real `CellSpec` actually wakes its subscriber when the
   * underlying store moves, and — the P-021 property — that a `target:'material'`
   * subscription stays silent through churn on the cell's headline path.
   *
   * ── WHAT THIS COVERS, AND WHAT IT HONESTLY DOES NOT ─────────────────────────
   *
   * `state:subscribe` is a PRESET over `watch:create` and holds no polling logic of its
   * own, so the end-to-end chain has three links and they are asserted in two places:
   *
   *   1. state:subscribe resolves a cell NAME to the cell's declared (tool, path) and
   *      hands it to watch:create  →  asserted in `agent-tools/state/state-tools.test.ts`
   *      ("takes the (tool, args, path) triple from the CELL", and the `target`
   *      re-pointing).
   *   2. that predicate is registered and polled                    →  asserted HERE.
   *   3. crossing it wakes the subscriber with the new value        →  asserted HERE.
   *
   * This file does NOT re-invoke the tool (it needs a full MCP ctx, and duplicating that
   * setup would test the harness rather than the behaviour). It instead derives its
   * predicate FROM THE SAME `CellSpec` the tool reads, so the two cannot silently drift:
   * a registration change moves both. The `TRIPLE PROVENANCE` test below pins that.
   */
  describe('P-005 — a cell subscription wakes on a real store mutation', () => {
    /**
     * The "underlying store" — a mutable object the faked dispatch serves. Mutating it
     * between evals IS the store mutation the item asks for; the resolver tool is not
     * the subject under test here (its own dispatch is dispatch-projected's territory).
     */
    let STORE: Record<string, unknown> = {};

    /** Seed a watch from a CELL SPEC, taking the triple off the spec rather than typing
     *  it — exactly as `state:subscribe` does. `of` selects headline vs materiality. */
    async function seedCellWatch(
      spec: CellSpec,
      // `target` mirrors state:subscribe's arg (P-005/D-014 §4 renamed `of` → `target`,
      // `value` → `measurement`). This fixture hand-builds the row rather than calling
      // the tool, so it takes only the two targets these cases exercise.
      opts: { target?: 'measurement' | 'material'; op?: PredicateOp; value?: unknown; once?: boolean },
    ) {
      if (spec.changeSignal.kind !== 'poll') throw new Error('P-005 fixture needs a poll cell');
      const path = opts.target === 'material' ? (spec.materiality as { path: string }).path : spec.changeSignal.path;
      const id = globalThis.crypto.randomUUID();
      const eventKey = `predicate:${id}`;
      const subscriber = `su-cell-${++seq}`;
      await store.registerAwait({ subscriberId: subscriber, eventKey, once: opts.once ?? false });
      const row = await pw.registerPredicateWatch({
        id,
        workspaceId: 'ws-pw-test',
        ownerId: subscriber,
        role: 'su',
        harnessSlug: null,
        eventKey,
        tool: spec.changeSignal.tool,
        args: {},
        path,
        op: opts.op ?? 'eq',
        value: opts.value,
        intervalSec: 60,
        once: opts.once ?? false,
      });
      return { row, eventKey, subscriber, path };
    }

    /** Re-read the row and evaluate it — the poller's per-tick unit. */
    const step = async (id: string) => pw.evalPredicateWatch((await pw.getPredicateWatch(id))!);

    /**
     * ⚠ `beforeEach`, NOT `beforeAll` — the enclosing describe's `afterEach` nulls the
     * dispatch seam after EVERY test, so a once-only arm leaves every case after the
     * first polling a dispatch that is not there. That failure is silent in the worst
     * way: the eval simply never matches, so an assertion of the form "it did not wake"
     * PASSES. This suite caught it only because the material case proves the watch can
     * fire BEFORE asserting any silence — which is precisely the vacuous pass P-005
     * names, reproduced here for real.
     */
    beforeEach(() => {
      STORE = {};
      pw.configurePredicateDispatch(async () => STORE);
    });

    it('TRIPLE PROVENANCE: the watch polls the tool + path the CELL declares, not a copy', async () => {
      const spec = GATE_CANDIDATE_CELL;
      const { row } = await seedCellWatch(spec, { target: 'measurement', op: 'exists' });
      // If a registration edit moves the cell's resolver or path, this fails HERE rather
      // than the suite quietly polling a path the cell no longer declares.
      expect(row.tool).toBe((spec.changeSignal as { tool: string }).tool);
      expect(row.path).toBe((spec.changeSignal as { path: string }).path);
    });

    it('⚠ POSITIVE WAKE FIRST — mutating the store across the condition wakes the subscriber', async () => {
      const { row, eventKey } = await seedCellWatch(GIT_PIPELINE_POSITION_CELL, {
        op: 'eq',
        value: true,
      });

      // Not yet deployed.
      STORE = { positions: { deployed: false } };
      expect(await step(row.id)).toMatchObject({ matched: false, fired: false });
      expect(h.emits).toHaveLength(0);

      // THE MUTATION: the deploy lands.
      STORE = { positions: { deployed: true } };
      const crossed = await step(row.id);

      expect(crossed).toMatchObject({ matched: true, fired: true });
      expect(h.emits).toHaveLength(1);
      expect(h.emits[0].key).toBe(eventKey);
    });

    it('the wake carries the NEW value — a subscriber must not be woken with the stale one', async () => {
      const { row } = await seedCellWatch(GIT_PIPELINE_POSITION_CELL, { op: 'eq', value: true });

      STORE = { positions: { deployed: false } };
      await step(row.id);
      STORE = { positions: { deployed: true } };
      await step(row.id);

      expect(h.emits).toHaveLength(1);
      // `observed` is what the poll actually read at the crossing — the post-mutation
      // value. A wake carrying the pre-mutation value would resume an agent on the very
      // condition it was waiting to leave.
      expect(h.emits[0].payload).toMatchObject({ observed: true });
      expect((await pw.getPredicateWatch(row.id))!.lastValue).toBe(true);
    });

    /**
     * ⚠⚠ THE VACUOUS PASS THIS ITEM NAMES, AND THE ORDER THAT DEFEATS IT.
     *
     * "A change below the materiality path does not wake me" is satisfied PERFECTLY by a
     * subscription that is broken and can never wake at all. A test that asserts only
     * the silence cannot tell the two apart, and it would report the strongest possible
     * green over a dead subscriber.
     *
     * So this case proves the watch CAN fire before it is ever asked to stay quiet, on
     * the SAME row — not a sibling fixture, because a sibling only proves some other
     * watch works. `once:false` is what makes one row able to carry both halves.
     */
    it('⚠ MATERIALITY: proven-capable FIRST, then silent through headline churn', async () => {
      const spec = GATE_CANDIDATE_CELL;
      const materialPath = (spec.materiality as { path: string }).path;
      const headlinePath = (spec.changeSignal as { path: string }).path;
      expect(materialPath, 'the fixture needs two DIFFERENT paths to say anything').not.toBe(headlinePath);

      const { row } = await seedCellWatch(spec, { target: 'material', op: 'eq', value: true });

      // ── LEG 1: PROVE IT CAN FIRE. Without this the rest is unfalsifiable.
      STORE = { changeInCandidate: { judgingSha: 'aaaaaaa', judgingContainsPath: false } };
      expect(await step(row.id)).toMatchObject({ matched: false, fired: false });

      STORE = { changeInCandidate: { judgingSha: 'aaaaaaa', judgingContainsPath: true } };
      expect(
        await step(row.id),
        'the material watch never fired at all — every silence asserted below would be vacuous',
      ).toMatchObject({ matched: true, fired: true });
      expect(h.emits).toHaveLength(1);

      // Back to false so the next cross is a real false→true edge.
      STORE = { changeInCandidate: { judgingSha: 'aaaaaaa', judgingContainsPath: false } };
      expect(await step(row.id)).toMatchObject({ matched: false, fired: false });

      // ── LEG 2: THE HEADLINE CHURNS. `judgingSha` moves on every commit — this is the
      // high-frequency path P-021 exists to insulate a subscriber from.
      for (const sha of ['bbbbbbb', 'ccccccc', 'ddddddd', 'eeeeeee']) {
        STORE = { changeInCandidate: { judgingSha: sha, judgingContainsPath: false } };
        expect(await step(row.id), `sha churn to ${sha} must not wake a material subscriber`).toMatchObject({
          fired: false,
        });
      }
      expect(h.emits, 'four headline changes produced a wake — materiality is not gating').toHaveLength(1);

      // ── LEG 3: AND IT STILL WORKS. The silence above was gating, not death.
      STORE = { changeInCandidate: { judgingSha: 'eeeeeee', judgingContainsPath: true } };
      expect(await step(row.id)).toMatchObject({ matched: true, fired: true });
      expect(h.emits).toHaveLength(2);
    });

    /**
     * The sharpest statement of the property: two subscriptions to the SAME cell, given
     * the IDENTICAL store mutation, must diverge. Anything less could be explained by
     * the mutation simply not having happened.
     */
    it('⚠ the SAME mutation wakes a headline subscriber and not a material one', async () => {
      const spec = GATE_CANDIDATE_CELL;
      const headline = await seedCellWatch(spec, { target: 'measurement', op: 'eq', value: 'ccccccc' });
      const material = await seedCellWatch(spec, { target: 'material', op: 'eq', value: true });

      STORE = { changeInCandidate: { judgingSha: 'aaaaaaa', judgingContainsPath: false } };
      await step(headline.row.id);
      await step(material.row.id);
      expect(h.emits).toHaveLength(0);

      // ONE mutation: the candidate sha moves. Nothing material changed.
      STORE = { changeInCandidate: { judgingSha: 'ccccccc', judgingContainsPath: false } };
      const headlineOut = await step(headline.row.id);
      const materialOut = await step(material.row.id);

      expect(headlineOut, 'the headline subscriber asked about the sha and the sha moved').toMatchObject({
        fired: true,
      });
      expect(materialOut, 'the material subscriber asked a question whose answer did not change').toMatchObject({
        fired: false,
      });
      expect(h.emits.map((e) => e.key)).toEqual([headline.eventKey]);
    });

    /**
     * ⚠ REGRESSION — the STRING-OPERAND round-trip (found by this suite, fixed in
     * `parseJsonb`).
     *
     * A jsonb operand is decoded by the driver before it reaches us, and re-parsing it
     * nulled every operand that was not itself valid JSON — i.e. every sha, ref, path
     * and id anyone would actually subscribe on. Every pre-existing test used a number
     * or a boolean operand, which took the branch that was always correct, so the whole
     * suite stayed green over a feature that could not fire.
     *
     * These cases exist because the FIX is invisible to a test that only checks firing:
     * the operand has to be read back and compared to what was stored.
     */
    it('⚠ a STRING operand survives the jsonb round-trip — it must not come back null', async () => {
      const sha = '42123c7841cd4a2ad86e5efb2beda80ca6117488';
      const { row } = await seedCellWatch(GATE_CANDIDATE_CELL, { target: 'measurement', op: 'eq', value: sha });
      expect(row.value, 'the operand was lost on write').toBe(sha);
      expect((await pw.getPredicateWatch(row.id))!.value, 'the operand was lost on read').toBe(sha);
    });

    it('⚠ a JSON-LOOKING string operand is not silently RETYPED', async () => {
      // "123" must stay the STRING "123" — a `eq` against a numeric sha prefix or a
      // stringly-typed id must not start comparing as a number.
      for (const literal of ['123', 'true', 'null', '{}']) {
        const { row } = await seedCellWatch(GATE_CANDIDATE_CELL, { target: 'measurement', op: 'eq', value: literal });
        expect(typeof (await pw.getPredicateWatch(row.id))!.value, `"${literal}" changed type`).toBe('string');
        expect((await pw.getPredicateWatch(row.id))!.value).toBe(literal);
      }
    });

    it('⚠ and a string operand actually FIRES — the null operand could never match', async () => {
      const sha = 'deadbeefcafe';
      const { row } = await seedCellWatch(GATE_CANDIDATE_CELL, { target: 'measurement', op: 'eq', value: sha });

      STORE = { changeInCandidate: { judgingSha: 'something-else' } };
      expect(await step(row.id)).toMatchObject({ matched: false, fired: false });

      STORE = { changeInCandidate: { judgingSha: sha } };
      expect(await step(row.id)).toMatchObject({ matched: true, fired: true });
    });

    /**
     * ⚠ THE DANGEROUS HALF. With the operand nulled, `ne` became
     * `!absent && !deepEq(observed, null)` — TRUE on the first poll that observed
     * anything at all. "Wake me when the deployed sha CHANGES" fired immediately and
     * reported a deploy that had not happened: a false ALL-CLEAR, which is worse than a
     * missed wake because the agent proceeds on a condition never established.
     */
    it('⚠ `ne` against a string operand does NOT fire while the value still equals it', async () => {
      const sha = 'deadbeefcafe';
      const { row } = await seedCellWatch(GATE_CANDIDATE_CELL, { target: 'measurement', op: 'ne', value: sha });

      STORE = { changeInCandidate: { judgingSha: sha } };
      expect(
        await step(row.id),
        'a `ne` watch fired while the observed value still EQUALS its operand — the operand was lost',
      ).toMatchObject({ matched: false, fired: false });
      expect(h.emits).toHaveLength(0);

      STORE = { changeInCandidate: { judgingSha: 'a-different-sha' } };
      expect(await step(row.id)).toMatchObject({ matched: true, fired: true });
    });

    it('a cell whose declared path is ABSENT from the store does not fire — and does not error out', async () => {
      const { row } = await seedCellWatch(GIT_PIPELINE_POSITION_CELL, { op: 'eq', value: true });
      // The resolver answered, but with a shape that has no `positions.deployed`.
      STORE = { somethingElse: true };
      const out = await step(row.id);
      // `comparePredicate` refuses to decide on absent evidence rather than reading
      // undefined as "not true" — a wake on absent evidence is a false all-clear.
      expect(out).toMatchObject({ matched: false, fired: false });
      expect(h.emits).toHaveLength(0);
      // ...and the row stays healthy: a missing path is not an error-ladder event.
      expect((await pw.getPredicateWatch(row.id))!.active).toBe(true);
    });
  });

  /**
   * WI-10004125 — several hosts poll one row and split the due batch between them, and
   * they routinely run DIFFERENT BUILDS (main lags staging). A value derived by code can
   * then differ between hosts at the same instant. Measured: a `changed` watch on the
   * gate verdict fired twice in minutes while the repair queue was byte-identical,
   * because :3070 answered 'inconclusive' and :3170 'repair-head-red'.
   *
   * The evaluator is switched the way production tells hosts apart: the serving port.
   */
  describe('WI-10004125 — each evaluator compares only against its own baseline', () => {
    const savedPort = process.env.PAPERCUSP_HONO_PORT;
    const as = (port: string) => {
      process.env.PAPERCUSP_HONO_PORT = port;
      servingHost._resetServingHostIdentityForTest();
    };
    const step = async (id: string, verdict: unknown) => {
      pw.configurePredicateDispatch(async () => ({ verdict }));
      return pw.evalPredicateWatch((await pw.getPredicateWatch(id))!);
    };

    afterEach(() => {
      if (savedPort === undefined) delete process.env.PAPERCUSP_HONO_PORT;
      else process.env.PAPERCUSP_HONO_PORT = savedPort;
      servingHost._resetServingHostIdentityForTest();
    });

    it('POSITIVE CONTROL — the same observations from ONE evaluator DO fire `changed`', async () => {
      const { row } = await seedWatch({ once: false, awaitOnce: false, op: 'changed', value: null, path: 'verdict' });
      as('3070');
      expect(await step(row.id, 'inconclusive')).toMatchObject({ fired: false });
      expect(await step(row.id, 'repair-head-red')).toMatchObject({ matched: true, fired: true });
      expect(h.emits.at(-1)?.payload).toMatchObject({
        observed: 'repair-head-red',
        predicate: { op: 'changed', changedFrom: 'inconclusive' },
      });
    });

    it('two builds answering differently for the SAME state never fire `changed`', async () => {
      const { row } = await seedWatch({ once: false, awaitOnce: false, op: 'changed', value: null, path: 'verdict' });
      for (let i = 0; i < 3; i++) {
        as('3070');
        expect(await step(row.id, 'inconclusive'), `cross-build flap #${i} (3070)`).toMatchObject({ fired: false });
        as('3170');
        expect(await step(row.id, 'repair-head-red'), `cross-build flap #${i} (3170)`).toMatchObject({ fired: false });
      }
      expect(h.emits).toHaveLength(0);

      const polled = (await pw.getPredicateWatch(row.id))!;
      const keys = Object.keys(polled.evaluatorBaselines);
      expect(keys).toHaveLength(2);
      expect(keys.some((k) => k.startsWith('port-3070@'))).toBe(true);
      expect(keys.some((k) => k.startsWith('port-3170@'))).toBe(true);
      // The row-level latest observation is still the most recent one, for joiners.
      expect(polled.lastValue).toBe('repair-head-red');

      // A REAL change on one evaluator still fires, reporting that evaluator's own baseline.
      as('3070');
      expect(await step(row.id, 'green')).toMatchObject({ matched: true, fired: true });
      expect(h.emits).toHaveLength(1);
      expect(h.emits[0].payload).toMatchObject({ observed: 'green', predicate: { changedFrom: 'inconclusive' } });
    });

    it('a standing condition does not re-fire when a new evaluator first polls it', async () => {
      const { row } = await seedWatch({ once: false, awaitOnce: false, op: 'eq', value: 'green', path: 'verdict' });
      as('3070');
      expect(await step(row.id, 'green')).toMatchObject({ matched: true, fired: true });

      // A host restarting onto a new build is a new evaluator; the condition still holds.
      as('3170');
      expect(await step(row.id, 'green')).toMatchObject({ matched: true, fired: false });
      expect(h.emits).toHaveLength(1);

      // ...but that evaluator's own false→true cross still fires.
      expect(await step(row.id, 'red')).toMatchObject({ matched: false, fired: false });
      expect(await step(row.id, 'green')).toMatchObject({ matched: true, fired: true });
      expect(h.emits).toHaveLength(2);
    });

    /**
     * EI-25217293871529814 — the measured false wake, through the real store. One
     * evaluator's absent read (a degraded payload missing the path; no throw, so the
     * error path never ran) was persisted as an established null baseline, and its
     * next present read fired `changed from null` while the value never moved.
     */
    it('an absent read is never persisted as a `changed` baseline', async () => {
      const { row } = await seedWatch({ once: false, awaitOnce: false, op: 'changed', value: null, path: 'verdict' });
      as('3070');
      expect(await step(row.id, 'awaiting-gate')).toMatchObject({ fired: false });
      expect(await step(row.id, null)).toMatchObject({ fired: false });
      expect(await step(row.id, undefined)).toMatchObject({ fired: false });
      expect(await step(row.id, 'awaiting-gate'), 'A → absent → A is not a change').toMatchObject({ fired: false });

      // A fresh evaluator (a host restarted onto new code) whose FIRST read is absent.
      as('3170');
      expect(await step(row.id, null)).toMatchObject({ fired: false });
      const afterAbsent = (await pw.getPredicateWatch(row.id))!;
      expect(Object.keys(afterAbsent.evaluatorBaselines).some((k) => k.startsWith('port-3170@'))).toBe(false);
      expect(await step(row.id, 'awaiting-gate'), 'its first present read establishes, not fires').toMatchObject({
        fired: false,
      });
      expect(h.emits).toHaveLength(0);

      // POSITIVE CONTROL — a real move after an absent read still fires, from the last PRESENT value.
      as('3070');
      expect(await step(row.id, null)).toMatchObject({ fired: false });
      expect(await step(row.id, 'in-main')).toMatchObject({ matched: true, fired: true });
      expect(h.emits).toHaveLength(1);
      expect(h.emits[0].payload).toMatchObject({
        observed: 'in-main',
        predicate: { op: 'changed', changedFrom: 'awaiting-gate' },
      });
    });
  });
});
