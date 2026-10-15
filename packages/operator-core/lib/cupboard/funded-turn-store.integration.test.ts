import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { paymentVoucherDigest } from '../p2p/microcharge';
import { usageReceiptSigningBytes } from '../p2p/metered-invocation';
import { identityPerUseOfferTerms, quoteIdentityInferenceTurn } from './identity-per-use-offer';
import { FundedIdentityTurnStore, fundedIdentityTurnId, type FundedIdentityTurnBinding,
  type FundedIdentityTurn } from './funded-turn-store';
import type { UsageReceiptWire, IdentityMarkupOriginWire } from './metered-invocation-door-io';
import type { IdentityTurnUsageBinding, IdentityTurnBilledCost } from './shadow-metering-reader';

let db: FreshPgDb;
let peerSql: postgres.Sql;
let store: FundedIdentityTurnStore;
let peer: FundedIdentityTurnStore;
let serial = 0;
const migrationPath = resolve('..', '..', 'libs/papercusp/libs/db/sql/1423-cupboard-funded-turn-ledger.sql');
const migrationFile = () => existsSync(migrationPath) ? migrationPath : migrationPath + '.DRAFT';
const usageKey = 'a'.repeat(64);
const offered = identityPerUseOfferTerms({ identity: { id: 'engineer', version: '1.2.0' }, markupBps: 2500 });
if (!offered.ok) throw new Error(offered.detail);
const terms = offered.terms;
beforeAll(async () => {
  db = await createFreshPgDb('funded-identity-turns');
  await applyMigrationForTest(db.sql, migrationFile());
  const nativeMigration = resolve('..', '..', 'libs/papercusp/libs/db/sql/1424-funded-turn-native-binding.sql');
  await applyMigrationForTest(db.sql, existsSync(nativeMigration) ? nativeMigration : nativeMigration + '.DRAFT');
  // Two independent database clients, not an in-memory mutex shared by stores.
  peerSql = postgres(db.url, { prepare: false });
  store = new FundedIdentityTurnStore(db.sql);
  peer = new FundedIdentityTurnStore(peerSql);
});
afterAll(async () => { await peerSql?.end({ timeout: 1 }); await db?.cleanup(); });

function binding(overrides: Partial<FundedIdentityTurnBinding> = {}): FundedIdentityTurnBinding {
  return { workspaceId: 'funded-turn-ws-' + ++serial, ownerId: 'su-buyer', principalId: 'system:superuser',
    nativeSessionId: 'native-session', nativeTurnId: 'turn-1', specificationRevision: 'spec-1', stateRevision: 'state-1',
    payer: 'gh:1', seller: 'gh:2', offerId: 'offer-1', channelId: 'channel-1', offer: terms,
    inferenceCeilingMicros: 1000n, expiresAtMs: 10_000, ...overrides };
}
function accepted(result: Awaited<ReturnType<FundedIdentityTurnStore['prepare']>>): FundedIdentityTurn {
  if (!result.ok) throw new Error(result.code + ': ' + result.detail);
  return result.turn;
}
function funding(b: FundedIdentityTurnBinding): UsageReceiptWire {
  const q = quoteIdentityInferenceTurn({ offer: b.offer, inferenceCeilingMicros: b.inferenceCeilingMicros, billedInferenceMicros: 0n });
  if (!q.ok) throw new Error(q.detail);
  const unsigned = { channelId: b.channelId, payer: b.payer, seller: b.seller, releaseRef: b.offer.skuRef,
    usageNonce: fundedIdentityTurnId(b), meterQuantity: q.reservationQuantity, pricePerUnitMicros: BigInt(b.offer.unitPriceMicros),
    priceVersion: b.offer.priceVersion, splitManifestHash: b.offer.splitManifestHash,
    expiresAtMs: b.expiresAtMs, cumulativeClaimMicros: q.reservedMarkupMicros };
  return { channelId: b.channelId, usageNonce: unsigned.usageNonce, offerId: b.offerId, payer: b.payer, seller: b.seller,
    releaseRef: b.offer.skuRef, meterUnit: b.offer.meterUnit, meterQuantity: String(q.reservationQuantity),
    unitPriceMicros: String(b.offer.unitPriceMicros), priceVersion: b.offer.priceVersion, splitManifestHash: b.offer.splitManifestHash,
    reservedMicros: String(q.reservedMarkupMicros), amountMicros: null, cumulativeClaimMicros: String(unsigned.cumulativeClaimMicros),
    expiresAtMs: b.expiresAtMs, voucherDigest: paymentVoucherDigest(unsigned), voucherSignature: 'payer-signature',
    receiptSignature: null, state: 'reserved', reservedAtMs: 1, settledAtMs: null,
    identityInference: { ceilingMicros: String(b.inferenceCeilingMicros), billedInferenceMicros: null,
      priorRemainderNumerator: null, remainderNumerator: null } };
}
const sign = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function origin(b: FundedIdentityTurnBinding, remainderNumerator = '0'): IdentityMarkupOriginWire {
  return { payer: b.payer, seller: b.seller, offerId: b.offerId, offer: b.offer, remainderNumerator };
}
function usage(cost: bigint) {
  return async (_sql: postgres.Sql, input: IdentityTurnUsageBinding): Promise<IdentityTurnBilledCost> =>
    ({ ok: true, billedInferenceMicros: cost,
      samples: input.usageEventKeys.map((usageEventKey) => ({ usageEventKey, sampleId: 'sample-1', activationEventId: 'span-1' })) });
}
async function funded(b: FundedIdentityTurnBinding): Promise<FundedIdentityTurn> {
  const t = accepted(await store.prepare(b));
  const [account] = await db.sql<{ remainder_numerator: number }[]>`SELECT remainder_numerator
    FROM harness_shared.cupboard_metered_accounts WHERE workspace_id = ${b.workspaceId} AND account_id = ${t.accountId}`;
  return accepted(await store.confirmFunding(b.workspaceId, t.turnId, t.revision, funding(b), origin(b, String(account!.remainder_numerator))));
}
async function closed(b: FundedIdentityTurnBinding): Promise<FundedIdentityTurn> {
  const f = await funded(b);
  const r = accepted(await store.enter(b.workspaceId, f.turnId, f.revision, b, 2));
  return accepted(await store.close(b.workspaceId, r.turnId, r.revision, [usageKey], 3));
}
function ack(t: FundedIdentityTurn): UsageReceiptWire {
  return { ...t.fundingReceipt!, state: 'settled', amountMicros: t.settlementOutbox!.receipt.amountMicros,
    receiptSignature: t.settlementOutbox!.receipt.signature, settledAtMs: t.settlementOutbox!.receipt.occurredAtMs,
    identityInference: { ceilingMicros: String(t.binding.inferenceCeilingMicros),
      billedInferenceMicros: t.settlementOutbox!.billedInferenceMicros,
      priorRemainderNumerator: t.settlementOutbox!.priorRemainderNumerator,
      remainderNumerator: t.settlementOutbox!.remainderNumerator } };
}

describe('funded native turn SQL history', () => {
  it('retains exact outcome attribution through restart, closure and settlement, and refuses retargeting', async () => {
    const b = binding({ workItem: { id: 'WI-123', harness: 'papercusp' } });
    const c = await closed(b);
    expect((await peer.read(b.workspaceId, c.turnId))!.binding.workItem).toEqual(b.workItem);
    const s = accepted(await peer.stageSettlement(b.workspaceId, c.turnId, c.revision,
      { signReceipt: sign, readUsage: usage(999n) }));
    const settled = accepted(await store.acknowledgeSettlement(b.workspaceId, s.turnId, s.revision, ack(s)));
    expect(settled.binding.workItem).toEqual(b.workItem);
    for (const workItem of [{ ...b.workItem!, id: 'WI-124' }, { ...b.workItem!, harness: 'other' }, undefined]) {
      expect(await peer.prepare({ ...b, workItem })).toMatchObject({ ok: false, code: 'turn-binding-changed' });
    }
  });

  it.each([{ id: '', harness: 'papercusp' }, { id: 'WI-123', harness: '../other' },
    { id: 'WI-123', harness: 'papercusp', accepted: true }])('refuses malformed outcome binding before any SQL write %j', async workItem => {
    const b = binding({ workItem });
    expect(await store.prepare(b)).toMatchObject({ ok: false, code: 'invalid-turn-binding' });
    expect(await store.read(b.workspaceId, fundedIdentityTurnId(b))).toBeNull();
  });

  it('reserves before a native ID exists, then retains the same funding nonce across binding and restart', async () => {
    const b = binding({ admissionId: 'host-owner-turn-1', nativeTurnId: null });
    const f = await funded(b);
    const running = accepted(await store.enter(b.workspaceId, f.turnId, f.revision, b, 2));
    expect(await peer.close(b.workspaceId, running.turnId, running.revision, [usageKey], 3))
      .toMatchObject({ ok: false, code: 'native-turn-unbound' });
    const bound = accepted(await peer.bindNativeTurn(b.workspaceId, running.turnId, running.revision, 'actual-native-turn'));
    expect(bound.turnId).toBe(f.turnId);
    expect(fundedIdentityTurnId(bound.binding)).toBe(f.turnId);
    expect(bound.fundingReceipt).toEqual(f.fundingReceipt);
    expect(bound.binding).toEqual({ ...b, nativeTurnId: 'actual-native-turn' });
    expect(await new FundedIdentityTurnStore(db.sql).read(b.workspaceId, f.turnId)).toEqual(bound);
    expect(accepted(await store.bindNativeTurn(b.workspaceId, bound.turnId, bound.revision, 'actual-native-turn'))).toEqual(bound);
    expect(await store.bindNativeTurn(b.workspaceId, bound.turnId, bound.revision, 'different-native-turn'))
      .toMatchObject({ ok: false, code: 'native-turn-binding-changed' });
    const c = accepted(await store.close(b.workspaceId, bound.turnId, bound.revision, [usageKey], 3));
    const readUsage = vi.fn(usage(1n));
    accepted(await store.stageSettlement(b.workspaceId, c.turnId, c.revision, { signReceipt: sign, readUsage }));
    expect(readUsage).toHaveBeenCalledWith(db.sql, expect.objectContaining({ nativeTurnId: 'actual-native-turn', usageEventKeys: [usageKey] }));
  });

  it('elects one immutable binding across independent clients', async () => {
    const b = binding({ admissionId: 'host-racing-turn', nativeTurnId: null });
    const f = await funded(b), r = accepted(await store.enter(b.workspaceId, f.turnId, f.revision, b, 2));
    const verdicts = await Promise.all([store.bindNativeTurn(b.workspaceId, r.turnId, r.revision, 'native-a'),
      peer.bindNativeTurn(b.workspaceId, r.turnId, r.revision, 'native-b')]);
    expect(verdicts.filter((v) => v.ok)).toHaveLength(1);
    expect(verdicts.filter((v) => !v.ok)).toEqual([expect.objectContaining({ code: 'stale-turn' })]);
    expect((await store.read(b.workspaceId, r.turnId))!.revision).toBe(r.revision + 1);
  });

  it('refuses a second admission for the same native session/turn/offer and retains its uncertainty', async () => {
    const b = binding({ admissionId: 'first-admission', nativeTurnId: null });
    const f = await funded(b), r = accepted(await store.enter(b.workspaceId, f.turnId, f.revision, b, 2));
    accepted(await store.bindNativeTurn(b.workspaceId, r.turnId, r.revision, 'shared-native'));
    const other = { ...b, admissionId: 'second-admission', payer: 'gh:another' };
    const f2 = await funded(other), r2 = accepted(await peer.enter(other.workspaceId, f2.turnId, f2.revision, other, 2));
    expect(await peer.bindNativeTurn(b.workspaceId, r2.turnId, r2.revision, 'shared-native'))
      .toMatchObject({ ok: false, code: 'native-turn-already-bound' });
    expect(await store.read(b.workspaceId, r2.turnId)).toEqual(r2);
    expect(await peer.prepare({ ...other, admissionId: 'third-admission' }))
      .toMatchObject({ ok: false, code: 'account-turn-pending' });
  });

  it('requires explicit admission identity and refuses unfunded or unentered native binding', async () => {
    expect(await store.prepare(binding({ nativeTurnId: null }))).toMatchObject({ ok: false, code: 'invalid-turn-binding' });
    expect(await store.prepare(binding({ nativeTurnId: null, admissionId: '' }))).toMatchObject({ ok: false, code: 'invalid-turn-binding' });
    const b = binding({ admissionId: 'unentered-admission', nativeTurnId: null });
    const p = accepted(await store.prepare(b));
    expect(await store.bindNativeTurn(b.workspaceId, p.turnId, p.revision, 'native-turn'))
      .toMatchObject({ ok: false, code: 'invalid-turn-state' });
    const f = await funded(b);
    expect(await store.bindNativeTurn(b.workspaceId, f.turnId, f.revision, 'native-turn'))
      .toMatchObject({ ok: false, code: 'invalid-turn-state' });
    expect(await store.bindNativeTurn(b.workspaceId, f.turnId, f.revision, ''))
      .toMatchObject({ ok: false, code: 'invalid-native-turn' });
  });

  it('requires an exact authenticated offer origin and seeds a nonzero hosted remainder', async () => {
    const b = binding(), t = accepted(await store.prepare(b));
    for (const bad of [undefined, { ...origin(b), payer: 'gh:else' }, { ...origin(b), remainderNumerator: '10000' },
      { ...origin(b), offer: { ...b.offer, splitManifestHash: 'changed' } }]) {
      expect(await store.confirmFunding(b.workspaceId, t.turnId, t.revision, funding(b), bad as IdentityMarkupOriginWire))
        .toMatchObject({ ok: false, code: 'funding-origin-mismatch' });
    }
    const f = accepted(await store.confirmFunding(b.workspaceId, t.turnId, t.revision, funding(b), origin(b, '7500')));
    const running = accepted(await store.enter(b.workspaceId, t.turnId, f.revision, b, 2));
    const c = accepted(await store.close(b.workspaceId, t.turnId, running.revision, [usageKey], 3));
    const p = accepted(await store.stageSettlement(b.workspaceId, t.turnId, c.revision, { signReceipt: sign, readUsage: usage(1n) }));
    expect(p.settlementOutbox).toMatchObject({ priorRemainderNumerator: '7500', remainderNumerator: '0', receipt: { amountMicros: '1' } });
  });
  it('reapplying the migration retains monetary history and row-level security', async () => {
    const b = binding();
    const t = accepted(await store.prepare(b));
    await applyMigrationForTest(db.sql, migrationFile());
    expect(await peer.read(b.workspaceId, t.turnId)).toEqual(t);
    const rows = await db.sql<{ relname: string; relrowsecurity: boolean }[]>`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE oid IN ('harness_shared.cupboard_metered_accounts'::regclass,
        'harness_shared.cupboard_funded_turns'::regclass) ORDER BY relname`;
    expect(rows).toEqual([
      { relname: 'cupboard_funded_turns', relrowsecurity: true },
      { relname: 'cupboard_metered_accounts', relrowsecurity: true },
    ]);
  });

  it('retains prepared uncertainty across restart and refuses unfunded inference', async () => {
    const b = binding();
    const t = accepted(await store.prepare(b));
    expect(await peer.read(b.workspaceId, t.turnId)).toEqual(t);
    expect(await peer.enter(b.workspaceId, t.turnId, t.revision, b, 2))
      .toMatchObject({ ok: false, code: 'invalid-turn-state' });
    expect(accepted(await peer.prepare(b))).toEqual(t);
    expect(await peer.prepare({ ...b, nativeTurnId: 'turn-2' }))
      .toMatchObject({ ok: false, code: 'account-turn-pending' });
  });

  it('serializes two independently prepared turns on the payer/offer account', async () => {
    const b = binding();
    const results = await Promise.all([store.prepare(b), peer.prepare({ ...b, nativeTurnId: 'turn-2' })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, code: 'account-turn-pending',
      detail: 'resolve the previous funded turn before admitting another on this payer/offer' }]);
  });

  it('refuses simultaneous different payers on one native turn without a unique-key exception', async () => {
    const b = binding();
    const results = await Promise.all([store.prepare(b), peer.prepare({ ...b, payer: 'gh:other' })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: 'turn-binding-changed' });
  });

  it.each(['payer', 'ownerId', 'principalId', 'channelId', 'specificationRevision', 'stateRevision'] as const)
    ('rejects a changed %s on historical native turn identity', async (field) => {
      const b = binding();
      await store.prepare(b);
      expect(await peer.prepare({ ...b, [field]: 'changed' })).toMatchObject({ ok: false, code: 'turn-binding-changed' });
    });

  it('pins seller and immutable offer terms for the payer/offer account', async () => {
    const b = binding();
    await store.prepare(b);
    expect(await store.prepare({ ...b, nativeTurnId: 'turn-2', seller: 'gh:other' }))
      .toMatchObject({ ok: false, code: 'offer-binding-changed' });
  });

  it.each(['payer', 'seller', 'channelId', 'offerId', 'releaseRef', 'voucherDigest', 'meterQuantity', 'reservedMicros'] as const)
    ('rejects foreign or corrupted hosted reservation %s', async (field) => {
      const b = binding();
      const t = accepted(await store.prepare(b));
      expect(await store.confirmFunding(b.workspaceId, t.turnId, 0, { ...funding(b), [field]: 'changed' }, origin(b)))
        .toMatchObject({ ok: false, code: 'funding-binding-mismatch' });
      expect((await peer.read(b.workspaceId, t.turnId))!.state).toBe('prepared');
    });

  it('elects exactly one inference entrant and refuses replay after restart', async () => {
    const b = binding();
    const f = await funded(b);
    const results = await Promise.all([store.enter(b.workspaceId, f.turnId, f.revision, b, 2),
      peer.enter(b.workspaceId, f.turnId, f.revision, b, 2)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: 'stale-turn' });
    const running = (await new FundedIdentityTurnStore(peerSql).read(b.workspaceId, f.turnId))!;
    expect(await peer.enter(b.workspaceId, f.turnId, running.revision, b, 2))
      .toMatchObject({ ok: false, code: 'invalid-turn-state' });
  });

  it('refuses identity switch and expiry before entry while preserving funding', async () => {
    const b = binding();
    const t = await funded(b);
    expect(await store.enter(b.workspaceId, t.turnId, t.revision, { ...b, stateRevision: 'switched' }, 2))
      .toMatchObject({ code: 'turn-binding-changed' });
    expect(await store.enter(b.workspaceId, t.turnId, t.revision, b, 10_001)).toMatchObject({ code: 'turn-expired' });
    expect((await peer.read(b.workspaceId, t.turnId))!.state).toBe('funded');
  });

  it('rejects empty/repeated usage populations and freezes the closed population', async () => {
    const b = binding();
    const t = await funded(b);
    const r = accepted(await store.enter(b.workspaceId, t.turnId, t.revision, b, 2));
    for (const keys of [[], [usageKey, usageKey], ['not-an-event']]) {
      expect(await store.close(b.workspaceId, t.turnId, r.revision, keys, 3)).toMatchObject({ code: 'invalid-closed-turn' });
    }
    const c = accepted(await store.close(b.workspaceId, t.turnId, r.revision, [usageKey], 3));
    expect(await peer.close(b.workspaceId, c.turnId, c.revision, ['b'.repeat(64)], 4))
      .toMatchObject({ code: 'invalid-turn-state' });
    expect((await peer.read(b.workspaceId, c.turnId))!.usageEventKeys).toEqual([usageKey]);
  });

  it('does not sign or stage incomplete, unbillable, or over-ceiling evidence', async () => {
    const b = binding();
    const c = await closed(b);
    const signer = vi.fn(sign);
    const bad = await store.stageSettlement(b.workspaceId, c.turnId, c.revision, { signReceipt: signer,
      readUsage: async () => ({ ok: false, code: 'identity-usage-not-bill-grade', detail: 'estimated' }) });
    expect(bad).toMatchObject({ code: 'identity-usage-not-bill-grade' });
    expect(await store.stageSettlement(b.workspaceId, c.turnId, c.revision,
      { signReceipt: signer, readUsage: usage(1001n) })).toMatchObject({ code: 'inference-ceiling-exceeded' });
    expect(signer).not.toHaveBeenCalled();
    expect((await peer.read(b.workspaceId, c.turnId))!.settlementOutbox).toBeNull();
  });

  it('persists exact signed actual cost for restart retry and advances remainder only on acknowledgement', async () => {
    const b = binding();
    const c = await closed(b);
    const signer = vi.fn(sign);
    const p = accepted(await store.stageSettlement(b.workspaceId, c.turnId, c.revision, { signReceipt: signer, readUsage: usage(999n) }));
    expect(signer).toHaveBeenCalledWith(expect.any(Buffer), { turnId: c.turnId,
      identityInference: { billedInferenceMicros: 999n, priorRemainderNumerator: 0n } });
    expect(p.settlementOutbox).toMatchObject({ billedInferenceMicros: '999', priorRemainderNumerator: '0', remainderNumerator: '7500',
      receipt: { amountMicros: '249', meterQuantity: '1', occurredAtMs: 3 } });
    const { signature, ...wire } = p.settlementOutbox!.receipt;
    expect(signature).toBe(sign(usageReceiptSigningBytes({ ...wire, meterQuantity: BigInt(wire.meterQuantity), amountMicros: BigInt(wire.amountMicros) })));
    const restarted = new FundedIdentityTurnStore(peerSql);
    expect(await restarted.read(b.workspaceId, p.turnId)).toEqual(p);
    expect(await peer.prepare({ ...b, nativeTurnId: 'turn-2' })).toMatchObject({ code: 'account-turn-pending' });
    expect(await peer.acknowledgeSettlement(b.workspaceId, p.turnId, p.revision, { ...ack(p), amountMicros: '250' }))
      .toMatchObject({ code: 'settlement-binding-mismatch' });
    for (const field of ['ceilingMicros', 'billedInferenceMicros', 'priorRemainderNumerator', 'remainderNumerator'] as const) {
      const wrong = { ...ack(p), identityInference: { ...ack(p).identityInference!, [field]: '100' } };
      expect(await peer.acknowledgeSettlement(b.workspaceId, p.turnId, p.revision, wrong))
        .toMatchObject({ code: 'settlement-binding-mismatch' });
    }
    const settled = accepted(await restarted.acknowledgeSettlement(b.workspaceId, p.turnId, p.revision, ack(p)));
    expect(settled.state).toBe('settled');
    expect(await peer.acknowledgeSettlement(b.workspaceId, p.turnId, p.revision, ack(p))).toMatchObject({ code: 'stale-turn' });
    const next = { ...b, nativeTurnId: 'turn-2', channelId: 'new-channel' };
    const c2 = await closed(next);
    const p2 = accepted(await peer.stageSettlement(b.workspaceId, c2.turnId, c2.revision, { signReceipt: sign, readUsage: usage(1n) }));
    expect(p2.settlementOutbox).toMatchObject({ priorRemainderNumerator: '7500', remainderNumerator: '0', receipt: { amountMicros: '1' } });
    // Original history remains terminal even after the account admits a successor.
    expect(accepted(await peer.prepare(b)).state).toBe('settled');
  });

  it('stages a zero billed turn with zero money and a signed release of escrow', async () => {
    const b = binding();
    const c = await closed(b);
    const p = accepted(await store.stageSettlement(b.workspaceId, c.turnId, c.revision, { signReceipt: sign, readUsage: usage(0n) }));
    expect(p.settlementOutbox!.receipt.amountMicros).toBe('0');
    expect(accepted(await peer.acknowledgeSettlement(b.workspaceId, p.turnId, p.revision, ack(p))).state).toBe('settled');
  });

  it('does not persist an outbox when signing fails or returns no signature', async () => {
    const b = binding();
    const c = await closed(b);
    await expect(store.stageSettlement(b.workspaceId, c.turnId, c.revision, {
      signReceipt: () => { throw new Error('key unavailable'); }, readUsage: usage(999n),
    })).rejects.toThrow('key unavailable');
    expect(await store.stageSettlement(b.workspaceId, c.turnId, c.revision, {
      signReceipt: () => '', readUsage: usage(999n),
    })).toMatchObject({ code: 'unsigned-receipt' });
    expect((await peer.read(b.workspaceId, c.turnId))!.state).toBe('closed');
  });

  it('snapshots evidence before an asynchronous signer can mutate it', async () => {
    const b = binding();
    const c = await closed(b);
    const evidence = await usage(999n)(db.sql, { ...b, nativeTurnId: b.nativeTurnId!, usageEventKeys: [usageKey] });
    if (!evidence.ok) throw new Error('fixture');
    const pending = accepted(await store.stageSettlement(b.workspaceId, c.turnId, c.revision, {
      readUsage: async () => evidence,
      signReceipt: async (bytes) => {
        // Deliberately mutate the callback-owned object after the reader returns.
        (evidence as { billedInferenceMicros: bigint }).billedInferenceMicros = 1000n;
        (evidence.samples[0] as { sampleId: string }).sampleId = 'changed';
        return sign(bytes);
      },
    }));
    expect(pending.settlementOutbox).toMatchObject({ billedInferenceMicros: '999', receipt: { amountMicros: '249' },
      samples: [{ sampleId: 'sample-1' }] });
  });

  it('reader callback cannot change the closed population used by the quote', async () => {
    const b = binding();
    const c = await closed(b);
    const signer = vi.fn(sign);
    expect(await store.stageSettlement(b.workspaceId, c.turnId, c.revision, { signReceipt: signer,
      readUsage: async (_sql, input) => {
        (input.usageEventKeys as string[])[0] = 'b'.repeat(64);
        return usage(999n)(db.sql, input);
      },
    })).toMatchObject({ code: 'usage-population-mismatch' });
    expect(signer).not.toHaveBeenCalled();
    expect((await peer.read(b.workspaceId, c.turnId))!.usageEventKeys).toEqual([usageKey]);
  });

  it('CAS elects one outbox when independent processes sign concurrently', async () => {
    const b = binding();
    const c = await closed(b);
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolveBarrier) => { release = resolveBarrier; });
    const signer = async (bytes: Buffer) => { if (++arrivals === 2) release(); await barrier; return sign(bytes); };
    const outcomes = await Promise.all([store.stageSettlement(b.workspaceId, c.turnId, c.revision, { signReceipt: signer, readUsage: usage(999n) }),
      peer.stageSettlement(b.workspaceId, c.turnId, c.revision, { signReceipt: signer, readUsage: usage(999n) })]);
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    expect(outcomes.find((r) => !r.ok)).toMatchObject({ code: 'stale-turn' });
  });

  it('partitions independent workspace and payer/offer accounts', async () => {
    const b = binding();
    const a = accepted(await store.prepare(b));
    const other = accepted(await peer.prepare({ ...b, workspaceId: b.workspaceId + '-other' }));
    expect(await peer.read(b.workspaceId + '-other', a.turnId)).toBeNull();
    expect(other.turnId).not.toBe(a.turnId);
    expect(accepted(await peer.prepare({ ...b, offerId: 'another-offer' })).state).toBe('prepared');
  });

  it('reads the complete exact local release population, retaining pending and legacy unlinked turns', async () => {
    const b = binding({ workItem: { id: 'WI-123', harness: 'papercusp' } });
    const first = accepted(await store.prepare(b));
    const legacy = accepted(await store.prepare({ ...b, offerId: 'offer-2', nativeTurnId: 'turn-2', workItem: undefined }));
    await peer.prepare({ ...b, workspaceId: b.workspaceId + '-other' });
    const otherTerms = identityPerUseOfferTerms({ identity: { id: 'other', version: '1.0.0' }, markupBps: 2500 });
    if (!otherTerms.ok) throw new Error(otherTerms.detail);
    await store.prepare({ ...b, offerId: 'other-release', offer: otherTerms.terms });
    const population = await peer.readReleasePopulation(b.workspaceId, b.offer.skuRef);
    expect(population.map(t => t.turnId).sort()).toEqual([first.turnId, legacy.turnId].sort());
    expect(population.every(t => t.state === 'prepared')).toBe(true);
    expect(population.find(t => t.turnId === legacy.turnId)!.binding.workItem).toBeUndefined();
  });

  it('database constraints refuse impossible phase or fractional remainder', async () => {
    const b = binding();
    const t = accepted(await store.prepare(b));
    await expect(db.sql`UPDATE harness_shared.cupboard_funded_turns SET state = 'running'
      WHERE workspace_id = ${b.workspaceId} AND turn_id = ${t.turnId}`).rejects.toMatchObject({ code: '23514' });
    await expect(db.sql`UPDATE harness_shared.cupboard_metered_accounts SET remainder_numerator = 10000
      WHERE workspace_id = ${b.workspaceId}`).rejects.toMatchObject({ code: '23514' });
  });
});
