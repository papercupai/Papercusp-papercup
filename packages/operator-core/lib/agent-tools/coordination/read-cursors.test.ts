/**
 * read-cursors — the two-phase ACK-ON-NEXT-READ contract
 * (fleet-deltas-leader-primitives-2026-07-10 P-004; mig 537).
 *
 * Exercised on InMemoryReadCursorStore (the same store tests inject via
 * configureReadCursorStore — mirrors watermarks.ts's injection contract). The
 * Pg store's single-statement CTE implements the identical promote-then-advance
 * semantics; read-cursors.integration.test.ts runs it against a real migrated
 * Postgres.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  InMemoryReadCursorStore,
  configureReadCursorStore,
  resetReadCursorStore,
  ackAndAdvance,
  ackAndRead,
  stage,
  annotateReadCursorByToken,
  clearReadCursor,
} from './read-cursors';

describe('read-cursors — ack-on-next-read (P-004)', () => {
  beforeEach(() => configureReadCursorStore(new InMemoryReadCursorStore()));
  afterEach(() => resetReadCursorStore());

  it('first call for a surface is a BASELINE (no committed state to diff against)', async () => {
    const r = await ackAndAdvance('su-1', 'fleet:monitor', { a: 1 });
    expect(r).toEqual({ committed: null, baseline: true });
  });

  it("call N+1 promotes call N's pending → committed (the arrival IS the ack)", async () => {
    await ackAndAdvance('su-1', 'fleet:monitor', { state: 'N' });
    const r2 = await ackAndAdvance('su-1', 'fleet:monitor', { state: 'N+1' });
    // Diff base for call N+1 = what call N DELIVERED, now provably seen.
    expect(r2).toEqual({ committed: { state: 'N' }, baseline: false });
    const r3 = await ackAndAdvance('su-1', 'fleet:monitor', { state: 'N+2' });
    expect(r3.committed).toEqual({ state: 'N+1' });
  });

  it('a died wake RE-RECEIVES: the diff base does not advance until the next call arrives', async () => {
    await ackAndAdvance('su-1', 'fleet:monitor', { seen: ['m1'] }); // call 1 (baseline delivered)
    // Call 2 delivers delta vs call-1 state… and the caller DIES mid-turn.
    const call2 = await ackAndAdvance('su-1', 'fleet:monitor', { seen: ['m1', 'm2'] });
    expect(call2.committed).toEqual({ seen: ['m1'] });
    // Call 3 (the recovery wake): committed is call-2's pending — everything
    // call 2 delivered is INSIDE the new diff window, so nothing is skipped.
    // (committed advanced exactly one delivery; had call 2's delivery been
    // committed at delivery time, its content would be lost forever.)
    const call3 = await ackAndAdvance('su-1', 'fleet:monitor', { seen: ['m1', 'm2', 'm3'] });
    expect(call3.committed).toEqual({ seen: ['m1', 'm2'] });
  });

  it('cursors are isolated per (owner, surface)', async () => {
    await ackAndAdvance('su-1', 'fleet:monitor', { a: 1 });
    const otherOwner = await ackAndAdvance('su-2', 'fleet:monitor', { b: 2 });
    const otherSurface = await ackAndAdvance('su-1', 'inbox', { c: 3 });
    expect(otherOwner.baseline).toBe(true);
    expect(otherSurface.baseline).toBe(true);
    const own = await ackAndAdvance('su-1', 'fleet:monitor', { a: 2 });
    expect(own.committed).toEqual({ a: 1 });
  });

  it('clear() resets a surface to baseline (fingerprint-schema invalidation path)', async () => {
    await ackAndAdvance('su-1', 'fleet:monitor', { a: 1 });
    await ackAndAdvance('su-1', 'fleet:monitor', { a: 2 });
    await clearReadCursor('su-1', 'fleet:monitor');
    const r = await ackAndAdvance('su-1', 'fleet:monitor', { a: 3 });
    expect(r).toEqual({ committed: null, baseline: true });
  });
});

/**
 * The SPLIT-PHASE half of the same protocol (D-006 step 1). A WINDOWED surface
 * (coord:inbox) needs the committed floor BEFORE its query in order to bound it,
 * and only learns `next` after — so it cannot use the fused ackAndAdvance.
 * These assert the split preserves the property the fused form is trusted for.
 */
describe('read-cursors — split-phase ackAndRead + stage (D-006)', () => {
  beforeEach(() => configureReadCursorStore(new InMemoryReadCursorStore()));
  afterEach(() => resetReadCursorStore());

  it('first ackAndRead for a surface is a BASELINE — deliver in full, never a silent empty delta', async () => {
    expect(await ackAndRead('su-1', 'inbox')).toEqual({ committed: null, baseline: true });
  });

  it('a staged delivery is promoted by the NEXT ackAndRead (arrival is the ack)', async () => {
    await ackAndRead('su-1', 'inbox'); // turn 1: baseline
    await stage('su-1', 'inbox', { ts: 'T1' }); // ...delivered through T1
    const turn2 = await ackAndRead('su-1', 'inbox');
    expect(turn2).toEqual({ committed: { ts: 'T1' }, baseline: false });
  });

  it('AT-LEAST-ONCE: a turn that dies between ackAndRead and stage re-delivers from the SAME floor', async () => {
    await ackAndRead('su-1', 'inbox');
    await stage('su-1', 'inbox', { ts: 'T1' });
    // Turn 2 promotes T1, then DIES before staging what it delivered.
    expect((await ackAndRead('su-1', 'inbox')).committed).toEqual({ ts: 'T1' });
    // Turn 3 must re-diff against T1 — never skip past the dead turn's content.
    expect((await ackAndRead('su-1', 'inbox')).committed).toEqual({ ts: 'T1' });
    // And once a turn survives to stage, the floor finally advances.
    await stage('su-1', 'inbox', { ts: 'T2' });
    expect((await ackAndRead('su-1', 'inbox')).committed).toEqual({ ts: 'T2' });
  });

  it('repeated ackAndRead never advances the floor on its own — only stage() can', async () => {
    await ackAndRead('su-1', 'inbox');
    await stage('su-1', 'inbox', { ts: 'T1' });
    await ackAndRead('su-1', 'inbox');
    for (let i = 0; i < 3; i++) {
      expect((await ackAndRead('su-1', 'inbox')).committed).toEqual({ ts: 'T1' });
    }
  });

  it('interoperates with the fused form on the same surface (one cursor, two call shapes)', async () => {
    await ackAndRead('su-1', 'inbox');
    await stage('su-1', 'inbox', { ts: 'T1' });
    expect((await ackAndAdvance('su-1', 'inbox', { ts: 'T2' })).committed).toEqual({ ts: 'T1' });
    expect((await ackAndRead('su-1', 'inbox')).committed).toEqual({ ts: 'T2' });
  });

  it('stage() on a never-read surface creates the row, and the next read promotes it', async () => {
    // Guards the fresh-row INSERT branch of both statements (no prior row for
    // this owner+surface). stage() must NOT itself set `committed` — a floor may
    // only ever come from promoting something already delivered. If stage wrote
    // committed directly, a brand-new agent would start ABOVE its own backlog:
    // the EI-20190140825808810 failure shape, one layer down.
    await stage('su-new', 'inbox', { ts: 'T1' });
    expect(await ackAndRead('su-new', 'inbox')).toEqual({ committed: { ts: 'T1' }, baseline: false });
    // ...and the promotion is not re-applied on the following read.
    expect((await ackAndRead('su-new', 'inbox')).committed).toEqual({ ts: 'T1' });
  });

  it('cursors stay isolated per (owner, surface) under the split form', async () => {
    await ackAndRead('su-1', 'inbox');
    await stage('su-1', 'inbox', { ts: 'T1' });
    expect((await ackAndRead('su-2', 'inbox')).baseline).toBe(true);
    expect((await ackAndRead('su-1', 'plan-events')).baseline).toBe(true);
    expect((await ackAndRead('su-1', 'inbox')).committed).toEqual({ ts: 'T1' });
  });
});

/**
 * ACK-ON-PROOF (owner-directive-delivery-redesign-2026-09-22 P-005, D-005).
 * Arrival proves the caller came back, not that the last block reached the agent.
 * With a confirmation, only the token the caller proves it emitted promotes.
 * The same contract runs against real Postgres in read-cursors.integration.test.ts.
 */
describe('read-cursors — ack-on-proof (P-005)', () => {
  beforeEach(() => configureReadCursorStore(new InMemoryReadCursorStore()));
  afterEach(() => resetReadCursorStore());

  it('a MATCHING confirmation promotes, and the token never reaches committed', async () => {
    await ackAndRead('su-1', 'orient', { confirmedToken: null });
    await stage('su-1', 'orient', { gen: 1 }, { deliveryToken: 'tok-1' });
    expect(await ackAndRead('su-1', 'orient', { confirmedToken: 'tok-1' })).toEqual({
      committed: { gen: 1 },
      baseline: false,
    });
  });

  it('enriches a matching candidate before or after ACK without advancing the floor', async () => {
    await ackAndRead('su-1', 'orient', { confirmedToken: null });
    await stage('su-1', 'orient', { gen: 1, identity: { token: 'tok-1', status: 'pending' } },
      { deliveryToken: 'tok-1' });
    expect(await annotateReadCursorByToken('su-1', 'orient', 'identity', 'wrong',
      { token: 'wrong', status: 'bound' })).toBe(false);
    expect(await annotateReadCursorByToken('su-1', 'orient', 'identity', 'tok-1',
      { token: 'tok-1', status: 'bound' })).toBe(true);
    expect((await ackAndRead('su-1', 'orient', { confirmedToken: 'tok-1' })).committed).toEqual({
      gen: 1, identity: { token: 'tok-1', status: 'bound' },
    });
    expect(await annotateReadCursorByToken('su-1', 'orient', 'identity', 'tok-1',
      { token: 'tok-1', status: 'verified' })).toBe(true);
    expect((await ackAndRead('su-1', 'orient', { confirmedToken: null })).committed).toEqual({
      gen: 1, identity: { token: 'tok-1', status: 'verified' },
    });
    await stage('su-1', 'orient', { gen: 2, identity: { token: 'tok-2', status: 'pending' } },
      { deliveryToken: 'tok-2' });
    await ackAndRead('su-1', 'orient', { confirmedToken: 'tok-2' });
    expect(await annotateReadCursorByToken('su-1', 'orient', 'identity', 'tok-1',
      { token: 'tok-1', status: 'late' })).toBe(false);
  });

  it('the hook-killed case: a MISMATCHED confirmation keeps the old floor, so the block is re-diffed and re-sent', async () => {
    await ackAndRead('su-1', 'orient', { confirmedToken: null });
    await stage('su-1', 'orient', { gen: 1 }, { deliveryToken: 'tok-1' });
    await ackAndRead('su-1', 'orient', { confirmedToken: 'tok-1' });
    // Turn N staged gen 2, but its hook died before printing, so the ledger still
    // holds tok-1. Arrival alone would promote gen 2 here.
    await stage('su-1', 'orient', { gen: 2 }, { deliveryToken: 'tok-2' });
    expect((await ackAndRead('su-1', 'orient', { confirmedToken: 'tok-1' })).committed).toEqual({ gen: 1 });
    // The discarded pending does not come back on a later matching token either:
    // only what was staged AFTER the floor can be confirmed.
    expect((await ackAndRead('su-1', 'orient', { confirmedToken: 'tok-2' })).committed).toEqual({ gen: 1 });
  });

  it('a NULL confirmation discards pending but returns it for diagnostics', async () => {
    await stage('su-1', 'orient', { gen: 1 }, { deliveryToken: 'tok-1' });
    expect(await ackAndRead('su-1', 'orient', { confirmedToken: null })).toEqual({
      committed: null,
      baseline: true,
      unconfirmedPending: { gen: 1 },
    });
  });

  it('a pending staged WITHOUT a token cannot be confirmed — it is re-delivered once', async () => {
    await stage('su-1', 'orient', { gen: 1 });
    expect((await ackAndRead('su-1', 'orient', { confirmedToken: 'anything' })).committed).toBeNull();
  });

  it('no confirmation keeps ack-on-arrival, even for a tokened pending', async () => {
    await stage('su-1', 'orient', { gen: 1 }, { deliveryToken: 'tok-1' });
    expect(await ackAndRead('su-1', 'orient')).toEqual({ committed: { gen: 1 }, baseline: false });
  });
});
