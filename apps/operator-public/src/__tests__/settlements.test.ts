import { paymentTestOpening, signPaymentTestVoucher } from '@papercusp/operator-core/lib/p2p/_payment-voucher-fixture';
/**
 * P-033 batch settlement execution through the shipped Worker production door.
 *
 * The chain is injected as a deterministic fake facilitator. Everything else is
 * production code: authentication, the real migrated D1 schema (mig 026), the
 * P-032 channel funding door, voucher batching, the integer-atomic split, the
 * durable double-spend guard, the P-016 commerce event log, and the
 * claim-versus-finality lifecycle.
 *
 * Usage receipts are seeded as rows rather than driven through the P-031
 * metering door: their provenance is that item's tested concern, and what THIS
 * door promises is what it does with settled receipts once they exist.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EvmSettlementFacilitator,
  EvmTransactionObservation,
} from '@papercusp/operator-core/lib/p2p/evm-settlement.ts';
import type { PaymentChannelFundingAdapter } from '@papercusp/operator-core/lib/p2p/channel-funding.ts';
import {
  paymentVoucherDigest,
  unsignedVoucher,
  type CumulativePaymentVoucher,
} from '@papercusp/operator-core/lib/p2p/microcharge.ts';
import { revenueSplitManifest } from '@papercusp/operator-core/lib/p2p/revenue-settlement.ts';
import { buildApi } from '../routes/index.ts';
import { makeEnv } from './fake-d1.ts';
import { makeSqliteDb } from './sqlite-d1.ts';

const auth = vi.hoisted(() => ({ resolveGithubBearer: vi.fn() }));
vi.mock('../auth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth.ts')>();
  return { ...actual, resolveGithubBearer: auth.resolveGithubBearer };
});

const CHAIN_ID = 84_532;
const SIGNER = `0x${'1'.repeat(40)}`;
const STABLECOIN = `0x${'3'.repeat(40)}`;
const SETTLEMENT_CONTRACT = `0x${'4'.repeat(40)}`;
const TREASURY = `0x${'5'.repeat(40)}`;
const CHANNEL = 'chan-settle-1';
const ESCROW = 1_000_000;

const SHARES = {
  creator: 6_000,
  host: 2_000,
  component: 500,
  dao: 1_000,
  reserve: 300,
  tax: 100,
  operating: 100,
} as const;
const SPLIT = revenueSplitManifest({ version: 'v1', sharesBps: SHARES });

const CLAIM_TX = `0x${'a'.repeat(64)}`;
const CLAIM_BLOCK_HASH = `0x${'b'.repeat(64)}`;
const REFUND_TX = `0x${'c'.repeat(64)}`;

function fakeFacilitator(
  options: {
    failClaim?: boolean;
    requiredConfirmations?: number;
    observation?: EvmTransactionObservation;
  } = {},
) {
  const submitBatchClaim = vi.fn<EvmSettlementFacilitator['submitBatchClaim']>(async () => {
    if (options.failClaim) throw new Error('fake rail claim failure');
    return { transactionHash: CLAIM_TX, blockNumber: 100n, blockHash: CLAIM_BLOCK_HASH };
  });
  const submitRefund = vi.fn<EvmSettlementFacilitator['submitRefund']>(async () => ({
    transactionHash: REFUND_TX,
    blockNumber: 150n,
    blockHash: `0x${'d'.repeat(64)}`,
  }));
  const observeTransaction = vi.fn<EvmSettlementFacilitator['observeTransaction']>(
    async () =>
      options.observation ?? {
        present: true,
        blockNumber: 100n,
        blockHash: CLAIM_BLOCK_HASH,
        headBlockNumber: 101n,
      },
  );
  const facilitator: EvmSettlementFacilitator = {
    chainId: CHAIN_ID,
    settlementContract: SETTLEMENT_CONTRACT,
    stablecoin: STABLECOIN,
    signerAddress: SIGNER,
    requiredConfirmations: options.requiredConfirmations ?? 12,
    submitBatchClaim,
    submitRefund,
    observeTransaction,
    signSettlementProof: async () => 'fake-proof-signature',
  };
  return { facilitator, submitBatchClaim, submitRefund, observeTransaction };
}

function fakeChannelAdapter(): PaymentChannelFundingAdapter {
  return {
    rail: 'evm-x402',
    chainId: CHAIN_ID,
    stablecoinAddress: STABLECOIN,
    settlementContractAddress: SETTLEMENT_CONTRACT,
    signerAddress: SIGNER,
    openChannel: async () => ({ transactionHash: `0x${'e'.repeat(64)}`, blockNumber: 1n }),
    closeChannel: async () => ({ transactionHash: `0x${'f'.repeat(64)}`, blockNumber: 2n }),
  };
}

function harness(facilitator?: EvmSettlementFacilitator) {
  const { db } = makeSqliteDb();
  const { env } = makeEnv();
  env.DB = db;
  env.REVENUE_SPLIT_MANIFEST = JSON.stringify({ version: 'v1', sharesBps: SHARES });
  env.DAO_TREASURY_ADDRESS = TREASURY;
  return {
    api: buildApi({ paymentChannelAdapter: fakeChannelAdapter(), settlementFacilitator: facilitator }),
    db,
    env,
  };
}

function bearer(body?: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(paymentTestOpening(body, { payer: 'gh:7', chainId: CHAIN_ID, stablecoinAddress: STABLECOIN, settlementContractAddress: SETTLEMENT_CONTRACT, walletAddress: SIGNER })),
  };
}

function voucher(nonce: string, cumulative: number): CumulativePaymentVoucher {
  return signPaymentTestVoucher({
    channelId: CHANNEL,
    payer: 'gh:7',
    seller: 'gh:9',
    releaseRef: 'release:widget@1.0.0',
    usageNonce: nonce,
    meterQuantity: 1n,
    pricePerUnitMicros: BigInt(cumulative),
    priceVersion: 'p1',
    splitManifestHash: SPLIT.manifestHash,
    expiresAtMs: 4_000_000_000_000,
    cumulativeClaimMicros: BigInt(cumulative),
    signature: `sig-${nonce}`,
  });
}

async function bindWallet(db: D1Database): Promise<void> {
  await db
    .prepare(
      `INSERT INTO wallet_bindings
         (principal_id, wallet_address, chain_id, challenge_id, verified_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind('gh:7', SIGNER, CHAIN_ID, 'challenge-1', 1, 1, 1)
    .run();
}

/** Seed one SETTLED usage receipt, exactly as the P-031 door would leave it. */
async function seedSettledReceipt(
  db: D1Database,
  nonce: string,
  cumulative: number,
  splitManifestHash = SPLIT.manifestHash,
): Promise<void> {
  const v: CumulativePaymentVoucher = signPaymentTestVoucher({ ...voucher(nonce, cumulative), splitManifestHash });
  await db
    .prepare(
      `INSERT INTO usage_receipts
         (channel_id, usage_nonce, principal_id, offer_id, payer, seller, release_ref,
          meter_unit, meter_quantity, unit_price_micros, price_version, split_manifest_hash,
          reserved_micros, amount_micros, cumulative_claim_micros, expires_at_ms,
          voucher_digest, voucher_signature, receipt_signature, state, reserved_at_ms, settled_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'call', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'receipt-sig', 'settled', ?, ?)`,
    )
    .bind(
      CHANNEL,
      nonce,
      'gh:7',
      'offer-1',
      v.payer,
      v.seller,
      v.releaseRef,
      Number(v.meterQuantity),
      Number(v.pricePerUnitMicros),
      v.priceVersion,
      splitManifestHash,
      cumulative,
      cumulative,
      cumulative,
      v.expiresAtMs,
      paymentVoucherDigest(unsignedVoucher(v)),
      v.signature,
      1,
      2,
    )
    .run();
}

async function openChannel(api: ReturnType<typeof buildApi>, env: Env2): Promise<void> {
  const response = await api.request(
    `/commerce/payment-channels`,
    bearer({ channelId: CHANNEL, escrowMicros: ESCROW, fundingSource: 'bound-wallet' }),
    env,
  );
  if (response.status !== 201) throw new Error(`channel open failed: ${response.status} ${await response.text()}`);
}

type Env2 = ReturnType<typeof harness>['env'];

async function claim(api: ReturnType<typeof buildApi>, env: Env2): Promise<Response> {
  return api.request(`/commerce/payment-channels/${CHANNEL}/settlements`, bearer(), env);
}

async function finality(api: ReturnType<typeof buildApi>, env: Env2, batchId: string): Promise<Response> {
  return api.request(
    `/commerce/payment-channels/${CHANNEL}/settlements/${batchId}/finality`,
    bearer(),
    env,
  );
}

describe('POST /commerce/payment-channels/:channelId/settlements', () => {
  beforeEach(() => {
    auth.resolveGithubBearer.mockReset();
    auth.resolveGithubBearer.mockResolvedValue({ id: 7, login: 'buyer' });
  });

  it('retains an unused signed closure without submitting a zero payment claim', async () => {
    const { facilitator, submitBatchClaim } = fakeFacilitator();
    const { api, db, env } = harness(facilitator);
    await bindWallet(db);
    await openChannel(api, env);
    await seedSettledReceipt(db, 'unused', 1000);
    await db.prepare('UPDATE usage_receipts SET amount_micros=0, settled_meter_quantity=0 WHERE usage_nonce=?').bind('unused').run();
    const response = await claim(api, env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'no_settled_usage' });
    expect(submitBatchClaim).not.toHaveBeenCalled();
    expect(await db.prepare('SELECT state, amount_micros FROM usage_receipts WHERE usage_nonce=?').bind('unused').first())
      .toMatchObject({ state: 'settled', amount_micros: 0 });
  });

  it('preserves exact component author amounts through the claim, D1 reload and finality response', async () => {
    const { facilitator } = fakeFacilitator({ requiredConfirmations: 1 });
    const { api, db, env } = harness(facilitator);
    const componentDependencies = [
      { packageKind: 'blueprint', ref: 'parent', revision: '1.0.0', contentHash: 'a'.repeat(64), author: 'alice' },
      { packageKind: 'pack', ref: 'knowledge', revision: '2.0.0', contentHash: 'b'.repeat(64), author: 'bob' },
    ];
    const split = revenueSplitManifest({ version: 'v1', sharesBps: SHARES, componentDependencies });
    env.REVENUE_SPLIT_MANIFEST = JSON.stringify({ version: 'v1', sharesBps: SHARES, componentDependencies });
    await bindWallet(db);
    await openChannel(api, env);
    await seedSettledReceipt(db, 'authors', 3000, split.manifestHash);
    const claimed = await claim(api, env);
    expect(claimed.status).toBe(201);
    const { batch, proofEventId: claimProofId } = await claimed.json() as {
      batch: { batchId: string; componentAllocationsMicros: Record<string, string> };
      proofEventId: string;
    };
    expect(batch.componentAllocationsMicros).toEqual({ alice: '75', bob: '75' });
    const final = await finality(api, env, batch.batchId);
    expect(final.status).toBe(200);
    const finalBody = await final.json() as { proofEventId: string };
    expect(finalBody).toMatchObject({ batch: { state: 'final', componentAllocationsMicros: { alice: '75', bob: '75' } } });
    for (const proofEventId of [claimProofId, finalBody.proofEventId]) {
      const event = await db.prepare('SELECT payload FROM commerce_event_log WHERE event_id = ?')
        .bind(proofEventId).first<{ payload: string }>();
      expect(JSON.parse(event!.payload)).toMatchObject({ componentAllocationsMicros: { alice: '75', bob: '75' } });
    }
    const row = await db.prepare('SELECT allocations_micros FROM settlement_batches WHERE batch_id = ?')
      .bind(batch.batchId).first<{ allocations_micros: string }>();
    expect(JSON.parse(row!.allocations_micros)).toMatchObject({ componentAuthors: { alice: '75', bob: '75' } });
  });

  it('submits a claim on the rail and records it as a CLAIM, never as finality', async () => {
    const { facilitator, submitBatchClaim } = fakeFacilitator();
    const { api, db, env } = harness(facilitator);
    await bindWallet(db);
    await openChannel(api, env);
    await seedSettledReceipt(db, 'n1', 1_000);
    await seedSettledReceipt(db, 'n2', 3_000);

    const response = await claim(api, env);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { batch: Record<string, unknown>; proofEventId: string };

    expect(submitBatchClaim).toHaveBeenCalledTimes(1);
    expect(body.batch.state).toBe('claimed');
    expect(body.batch.final).toBe(false);
    expect(body.batch.claimMicros).toBe(3_000);
    expect(body.batch.claimTransactionHash).toBe(CLAIM_TX);
    expect(body.batch.voucherDigests).toHaveLength(2);

    // Integer-atomic split, recorded (routing it to the treasury is P-034).
    const allocations = body.batch.allocationsMicros as Record<string, string>;
    const total = Object.values(allocations).reduce((sum, value) => sum + BigInt(value), 0n);
    expect(total).toBe(3_000n);
    expect(allocations.creator).toBe('1800');
    expect(body.batch.daoTreasury).toBe(TREASURY);

    // The settlement proof reached the P-016 commerce event log.
    const event = await db
      .prepare(`SELECT kind, payload, signature FROM commerce_event_log WHERE event_id = ?`)
      .bind(body.proofEventId)
      .first<{ kind: string; payload: string; signature: string }>();
    expect(event?.kind).toBe('settlement-proof');
    expect(event?.signature).toBe('fake-proof-signature');
    const payload = JSON.parse(event?.payload ?? '{}') as Record<string, unknown>;
    expect(payload.finality).toBe('claimed');
    expect(payload.final).toBe(false);
    expect(payload.claimMicros).toBe('3000');
  });

  it('is idempotent: a resubmitted identical batch replays rather than claiming twice', async () => {
    const { facilitator, submitBatchClaim } = fakeFacilitator();
    const { api, db, env } = harness(facilitator);
    await bindWallet(db);
    await openChannel(api, env);
    await seedSettledReceipt(db, 'n1', 1_000);

    const first = await claim(api, env);
    expect(first.status).toBe(201);
    const second = await claim(api, env);

    // Nothing is left to claim once the receipts are consumed, so the second
    // call refuses rather than re-submitting: the vouchers are spent.
    expect(second.status).toBe(409);
    expect((await second.json()) as { error: string }).toMatchObject({ error: 'no_settled_usage' });
    expect(submitBatchClaim).toHaveBeenCalledTimes(1);

    const rows = await db.prepare(`SELECT COUNT(*) AS n FROM settlement_batches`).first<{ n: number }>();
    expect(Number(rows?.n)).toBe(1);
  });

  it('refuses when no settled usage is outstanding, and when the signed split disagrees', async () => {
    const { facilitator } = fakeFacilitator();
    const { api, db, env } = harness(facilitator);
    await bindWallet(db);
    await openChannel(api, env);

    expect((await claim(api, env)).status).toBe(409);

    await seedSettledReceipt(db, 'n1', 1_000, 'sha256:' + 'f'.repeat(64));
    const mismatched = await claim(api, env);
    expect(mismatched.status).toBe(409);
    expect((await mismatched.json()) as { error: string }).toMatchObject({ error: 'split_manifest_mismatch' });
  });

  it('fails closed when the settlement rail or the split is not configured', async () => {
    const { api, db, env } = harness();
    await bindWallet(db);
    await openChannel(api, env);
    await seedSettledReceipt(db, 'n1', 1_000);

    // No facilitator injected and no PAYMENT_CHANNEL_* secrets in the env.
    const unconfigured = await claim(api, env);
    expect(unconfigured.status).toBe(503);
    expect((await unconfigured.json()) as { error: string }).toMatchObject({ error: 'not-configured' });

    const { facilitator } = fakeFacilitator();
    const configuredRail = harness(facilitator);
    await bindWallet(configuredRail.db);
    await openChannel(configuredRail.api, configuredRail.env);
    await seedSettledReceipt(configuredRail.db, 'n1', 1_000);
    configuredRail.env.REVENUE_SPLIT_MANIFEST = undefined;
    const noSplit = await claim(configuredRail.api, configuredRail.env);
    expect(noSplit.status).toBe(503);
  });

  it('records nothing when the rail rejects the claim', async () => {
    const { facilitator } = fakeFacilitator({ failClaim: true });
    const { api, db, env } = harness(facilitator);
    await bindWallet(db);
    await openChannel(api, env);
    await seedSettledReceipt(db, 'n1', 1_000);

    const response = await claim(api, env);
    expect(response.status).toBe(502);
    const rows = await db.prepare(`SELECT COUNT(*) AS n FROM settlement_batches`).first<{ n: number }>();
    expect(Number(rows?.n)).toBe(0);
    const links = await db.prepare(`SELECT COUNT(*) AS n FROM settlement_batch_vouchers`).first<{ n: number }>();
    expect(Number(links?.n)).toBe(0);
  });

  it('rejects a caller who does not own the channel', async () => {
    const { facilitator } = fakeFacilitator();
    const { api, db, env } = harness(facilitator);
    await bindWallet(db);
    await openChannel(api, env);
    await seedSettledReceipt(db, 'n1', 1_000);

    auth.resolveGithubBearer.mockResolvedValue({ id: 99, login: 'stranger' });
    expect((await claim(api, env)).status).toBe(404);
  });
});

describe('claim finality and reorg recovery', () => {
  beforeEach(() => {
    auth.resolveGithubBearer.mockReset();
    auth.resolveGithubBearer.mockResolvedValue({ id: 7, login: 'buyer' });
  });

  async function claimed(options: Parameters<typeof fakeFacilitator>[0] = {}) {
    const fake = fakeFacilitator(options);
    const { api, db, env } = harness(fake.facilitator);
    await bindWallet(db);
    await openChannel(api, env);
    await seedSettledReceipt(db, 'n1', 1_000);
    await seedSettledReceipt(db, 'n2', 3_000);
    const response = await claim(api, env);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { batch: { batchId: string } };
    return { ...fake, api, db, env, batchId: body.batch.batchId };
  }

  it('stays a claim below the required depth and becomes final at it', async () => {
    const shallow = await claimed({ requiredConfirmations: 12 });
    const still = await finality(shallow.api, shallow.env, shallow.batchId);
    expect(still.status).toBe(200);
    const stillBody = (await still.json()) as { verdict: { state: string; final: boolean }; batch: { state: string; confirmations: number } };
    expect(stillBody.verdict).toMatchObject({ state: 'claimed', final: false });
    expect(stillBody.batch.state).toBe('claimed');
    expect(stillBody.batch.confirmations).toBe(2);

    const deep = await claimed({
      requiredConfirmations: 12,
      observation: { present: true, blockNumber: 100n, blockHash: CLAIM_BLOCK_HASH, headBlockNumber: 111n },
    });
    const response = await finality(deep.api, deep.env, deep.batchId);
    const body = (await response.json()) as { verdict: { state: string; final: boolean }; batch: { state: string; final: boolean }; proofEventId: string };
    expect(body.verdict).toMatchObject({ state: 'final', final: true });
    expect(body.batch).toMatchObject({ state: 'final', final: true });

    // A SECOND proof, distinct from the claim proof, reports finality.
    const events = await deep.db
      .prepare(`SELECT event_id, payload FROM commerce_event_log ORDER BY sequence ASC`)
      .all<{ event_id: string; payload: string }>();
    expect(events.results).toHaveLength(2);
    const payloads = (events.results ?? []).map((row) => JSON.parse(row.payload) as { finality: string; final: boolean });
    expect(payloads.map((p) => p.finality)).toEqual(['claimed', 'final']);
    expect(payloads.map((p) => p.final)).toEqual([false, true]);
  });

  it('unwinds a dropped claim and makes the same vouchers claimable again', async () => {
    const dropped = await claimed({ observation: { present: false, headBlockNumber: 130n } });
    const response = await finality(dropped.api, dropped.env, dropped.batchId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { verdict: { state: string; reason: string }; recovered: boolean; batch: { state: string } };
    expect(body.verdict).toMatchObject({ state: 'reorged', reason: 'dropped' });
    expect(body.batch.state).toBe('reorged');
    expect(body.recovered).toBe(true);

    // The voucher links are released, which is what recovery MEANS.
    const links = await dropped.db
      .prepare(`SELECT COUNT(*) AS n FROM settlement_batch_vouchers WHERE channel_id = ?`)
      .bind(CHANNEL)
      .first<{ n: number }>();
    expect(Number(links?.n)).toBe(0);

    // And the channel is no longer frozen, so the batch can be re-claimed.
    dropped.observeTransaction.mockResolvedValue({
      present: true,
      blockNumber: 100n,
      blockHash: CLAIM_BLOCK_HASH,
      headBlockNumber: 101n,
    });
    const again = await claim(dropped.api, dropped.env);
    expect(again.status).toBe(201);
    const reclaimed = (await again.json()) as { batch: { claimMicros: number; state: string } };
    expect(reclaimed.batch.claimMicros).toBe(3_000);
    expect(dropped.submitBatchClaim).toHaveBeenCalledTimes(2);
  });

  it('treats a reverted or re-mined claim as a reorg too', async () => {
    const reverted = await claimed({
      observation: { present: true, blockNumber: 100n, blockHash: CLAIM_BLOCK_HASH, headBlockNumber: 130n, reverted: true },
    });
    const revertedBody = (await (await finality(reverted.api, reverted.env, reverted.batchId)).json()) as { verdict: { reason: string } };
    expect(revertedBody.verdict.reason).toBe('reverted');

    const remined = await claimed({
      observation: { present: true, blockNumber: 105n, blockHash: `0x${'9'.repeat(64)}`, headBlockNumber: 130n },
    });
    const reminedBody = (await (await finality(remined.api, remined.env, remined.batchId)).json()) as { verdict: { reason: string } };
    expect(reminedBody.verdict.reason).toBe('block-hash-changed');
  });
});

describe('dispute freeze and refund', () => {
  beforeEach(() => {
    auth.resolveGithubBearer.mockReset();
    auth.resolveGithubBearer.mockResolvedValue({ id: 7, login: 'buyer' });
  });

  async function disputed() {
    const fake = fakeFacilitator();
    const { api, db, env } = harness(fake.facilitator);
    await bindWallet(db);
    await openChannel(api, env);
    await seedSettledReceipt(db, 'n1', 1_000);
    const first = await claim(api, env);
    const batchId = ((await first.json()) as { batch: { batchId: string } }).batch.batchId;
    const opened = await api.request(
      `/commerce/payment-channels/${CHANNEL}/settlements/${batchId}/dispute`,
      bearer({ action: 'open', reason: 'buyer contests the meter' }),
      env,
    );
    expect(opened.status).toBe(200);
    return { ...fake, api, db, env, batchId };
  }

  it('freezes further settlement while a dispute is open', async () => {
    const d = await disputed();
    await seedSettledReceipt(d.db, 'n2', 5_000);
    const blocked = await claim(d.api, d.env);
    expect(blocked.status).toBe(409);
    expect((await blocked.json()) as { error: string; reason: string }).toMatchObject({
      error: 'settlement_frozen',
      reason: 'dispute',
    });
    expect(d.submitBatchClaim).toHaveBeenCalledTimes(1);
  });

  it('dismissing a dispute lets the claim stand and thaws the channel', async () => {
    const d = await disputed();
    const dismissed = await d.api.request(
      `/commerce/payment-channels/${CHANNEL}/settlements/${d.batchId}/dispute`,
      bearer({ action: 'resolve', outcome: 'dismiss' }),
      d.env,
    );
    expect(dismissed.status).toBe(200);
    expect(((await dismissed.json()) as { batch: { state: string } }).batch.state).toBe('claimed');

    await seedSettledReceipt(d.db, 'n2', 5_000);
    const next = await claim(d.api, d.env);
    expect(next.status).toBe(201);
    // The cumulative watermark carried: the second claim is the DELTA only.
    expect(((await next.json()) as { batch: { claimMicros: number } }).batch.claimMicros).toBe(4_000);
  });

  it('refunding a dispute submits a refund and releases the vouchers', async () => {
    const d = await disputed();
    const refunded = await d.api.request(
      `/commerce/payment-channels/${CHANNEL}/settlements/${d.batchId}/dispute`,
      bearer({ action: 'resolve', outcome: 'refund' }),
      d.env,
    );
    expect(refunded.status).toBe(200);
    const body = (await refunded.json()) as { batch: { state: string; refundTransactionHash: string } };
    expect(body.batch).toMatchObject({ state: 'refunded', refundTransactionHash: REFUND_TX });
    expect(d.submitRefund).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: CHANNEL, amountMicros: 1_000n, refundAddress: SIGNER }),
    );

    const links = await d.db
      .prepare(`SELECT COUNT(*) AS n FROM settlement_batch_vouchers WHERE channel_id = ?`)
      .bind(CHANNEL)
      .first<{ n: number }>();
    expect(Number(links?.n)).toBe(0);
  });

  it('rejects a malformed dispute request', async () => {
    const d = await disputed();
    const bad = await d.api.request(
      `/commerce/payment-channels/${CHANNEL}/settlements/${d.batchId}/dispute`,
      bearer({ action: 'resolve' }),
      d.env,
    );
    expect(bad.status).toBe(400);
  });
});

describe('GET /commerce/payment-channels/:channelId/settlements', () => {
  beforeEach(() => {
    auth.resolveGithubBearer.mockReset();
    auth.resolveGithubBearer.mockResolvedValue({ id: 7, login: 'buyer' });
  });

  it('lists batches with the channel freeze state', async () => {
    const { facilitator } = fakeFacilitator();
    const { api, db, env } = harness(facilitator);
    await bindWallet(db);
    await openChannel(api, env);
    await seedSettledReceipt(db, 'n1', 1_000);
    await claim(api, env);

    const response = await api.request(
      `/commerce/payment-channels/${CHANNEL}/settlements`,
      { headers: { Authorization: 'Bearer test-token' } },
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { batches: Array<{ state: string; final: boolean }>; freeze: { frozen: boolean } };
    expect(body.batches).toHaveLength(1);
    expect(body.batches[0]).toMatchObject({ state: 'claimed', final: false });
    expect(body.freeze).toEqual({ frozen: false });
  });
});
