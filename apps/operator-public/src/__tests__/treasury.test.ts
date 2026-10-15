import { paymentTestOpening, signPaymentTestVoucher } from '@papercusp/operator-core/lib/p2p/_payment-voucher-fixture';
/**
 * P-034 DAO treasury routing through the shipped Worker production door.
 *
 * The Safe is injected as a deterministic fake adapter; everything else is
 * production code — authentication, the operator allowlist, the real migrated
 * D1 schema (migs 026 + 027), the P-032 channel funding door, the P-033
 * claim-then-finality lifecycle, the P-018 reconciliation, the P-023 policy
 * bounds, and the P-016 commerce event log.
 *
 * A settlement is driven to FINAL through the real settlements route rather
 * than seeded as a row, because "routing requires finality" is the property
 * under test and seeding a `final` row would assert it against a fixture rather
 * than against the lifecycle that produces one.
 */
import { beforeEach, describe, expect, inject, it, vi } from 'vitest';
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
import { authorizeTreasuryTransfer } from '@papercusp/operator-core/lib/p2p/treasury-controls.ts';
import { perUseRollup } from '@papercusp/operator-core/lib/cupboard/ledger-p2p-bridge.ts';
import type { CommerceEvent } from '@papercusp/operator-core/lib/p2p/commerce-events.ts';
import { identityPerUseOfferTerms, type IdentityPerUseOfferTerms } from '@papercusp/operator-core/lib/cupboard/identity-per-use-offer.ts';
import {
  RECONCILIATION_SIGNATURE_HEADER,
  TRANSFER_GATE_MAX_AGE_MS,
  TRANSFER_GATE_PATH,
  signReconciliationRequest,
} from '@papercusp/operator-core/lib/cupboard/reconciliation-hmac.ts';
import { buildApi } from '../routes/index.ts';
import { resolveTreasuryConfig } from '../routes/treasury.ts';
import type { SafeTreasuryAdapter } from '../treasury-adapter.ts';
import { makeEnv } from './fake-d1.ts';
import { makeSqliteDb } from './sqlite-d1.ts';
import { verifyLedgerStream, witnessLedgerStream } from '../ledger-chain-store.ts';
import { readReconciliationInputs } from '../transfer-gate-store.ts';
import { AuthError } from '../auth.ts';

const auth = vi.hoisted(() => ({ resolveGithubBearer: vi.fn() }));
vi.mock('../auth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth.ts')>();
  return { ...actual, resolveGithubBearer: auth.resolveGithubBearer };
});

const CHAIN_ID = 84_532;
const SIGNER = `0x${'1'.repeat(40)}`;
const AUTOMATION = `0x${'2'.repeat(40)}`;
const STABLECOIN = `0x${'3'.repeat(40)}`;
const SETTLEMENT_CONTRACT = `0x${'4'.repeat(40)}`;
const TREASURY = `0x${'5'.repeat(40)}`;
const SAFE = `0x${'6'.repeat(40)}`;
const ROLES_MODULE = `0x${'7'.repeat(40)}`;
const OWNER_A = `0x${'8'.repeat(40)}`;
const OWNER_B = `0x${'9'.repeat(40)}`;
const DEPLOY_TX = `0x${'e'.repeat(64)}`;
const TRANSFER_TX = `0x${'f'.repeat(64)}`;
const CHANNEL = 'chan-treasury-1';
const ESCROW = 1_000_000;
const GATE_WORKSPACE = 'ws-treasury';

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

function fakeFacilitator(observation?: EvmTransactionObservation): EvmSettlementFacilitator {
  return {
    chainId: CHAIN_ID,
    settlementContract: SETTLEMENT_CONTRACT,
    stablecoin: STABLECOIN,
    signerAddress: SIGNER,
    requiredConfirmations: 1,
    submitBatchClaim: async () => ({ transactionHash: CLAIM_TX, blockNumber: 100n, blockHash: CLAIM_BLOCK_HASH }),
    submitRefund: async () => ({ transactionHash: `0x${'c'.repeat(64)}`, blockNumber: 150n, blockHash: `0x${'d'.repeat(64)}` }),
    observeTransaction: async () =>
      observation ?? { present: true, blockNumber: 100n, blockHash: CLAIM_BLOCK_HASH, headBlockNumber: 200n },
    signSettlementProof: async () => 'fake-proof-signature',
  };
}

function fakeTreasuryAdapter(options: { failTransfer?: boolean } = {}) {
  const submitTransfer = vi.fn<SafeTreasuryAdapter['submitTransfer']>(async () => {
    if (options.failTransfer) throw new Error('fake Zodiac role refusal');
    return { transactionHash: TRANSFER_TX, blockNumber: 300n };
  });
  const adapter: SafeTreasuryAdapter = {
    chainId: CHAIN_ID,
    safeAddress: SAFE,
    rolesModuleAddress: ROLES_MODULE,
    automationSigner: AUTOMATION,
    submitTransfer,
    signTreasuryProof: async () => 'fake-treasury-signature',
  };
  return { adapter, submitTransfer };
}

function fakeChannelAdapter(): PaymentChannelFundingAdapter {
  return {
    rail: 'evm-x402',
    chainId: CHAIN_ID,
    stablecoinAddress: STABLECOIN,
    settlementContractAddress: SETTLEMENT_CONTRACT,
    signerAddress: SIGNER,
    openChannel: async () => ({ transactionHash: `0x${'1'.repeat(64)}`, blockNumber: 1n }),
    closeChannel: async () => ({ transactionHash: `0x${'2'.repeat(64)}`, blockNumber: 2n }),
  };
}

function harness(
  overrides: Partial<Record<string, string>> = {},
  adapter?: SafeTreasuryAdapter,
  observation?: EvmTransactionObservation,
) {
  const { db, raw } = makeSqliteDb();
  const { env } = makeEnv();
  env.DB = db;
  // P-043: the treasury door refuses unless reconciliation has pushed a fresh,
  // open, treasury-reconciled gate for the governing workspace. Every case here
  // tests the routing chain BEFORE that gate, so seed one; the gate's own
  // refusals are tested in treasury-transfer-gate.test.ts.
  env.RECONCILIATION_GATE_WORKSPACE = GATE_WORKSPACE;
  raw
    .prepare(
      `INSERT INTO treasury_transfer_gate
         (workspace_id, open, treasury_reconciled, reasons_json, run_id, at_ms, received_at_ms)
       VALUES (?, 1, 1, '[]', 'run-seed', ?, ?)`,
    )
    .run(GATE_WORKSPACE, Date.now(), Date.now());
  env.REVENUE_SPLIT_MANIFEST = JSON.stringify({ version: 'v1', sharesBps: SHARES });
  env.DAO_TREASURY_ADDRESS = TREASURY;
  env.PAYMENT_CHANNEL_STABLECOIN = STABLECOIN;
  env.TREASURY_SAFE_ADDRESS = SAFE;
  env.TREASURY_ROLES_MODULE_ADDRESS = ROLES_MODULE;
  env.TREASURY_SAFE_OWNERS = `${OWNER_A},${OWNER_B}`;
  env.TREASURY_SAFE_THRESHOLD = '2';
  env.TREASURY_SETTLEMENT_MAX_MICROS = '1000000';
  // Operator id 9 records deployments; the buyer (id 7) must not be able to.
  env.CUPBOARD_OPERATOR_GITHUB_IDS = '9';
  Object.assign(env, overrides);
  return {
    api: buildApi({
      paymentChannelAdapter: fakeChannelAdapter(),
      settlementFacilitator: fakeFacilitator(observation),
      treasuryAdapter: adapter,
    }),
    db,
    raw,
    env,
  };
}

type Env2 = ReturnType<typeof harness>['env'];
type Api = ReturnType<typeof buildApi>;

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

async function seedSettledReceipt(db: D1Database, nonce: string, cumulative: number, splitManifestHash = SPLIT.manifestHash, terms?: IdentityPerUseOfferTerms): Promise<void> {
  const v = signPaymentTestVoucher({ ...voucher(nonce, cumulative), splitManifestHash, ...(terms ? {
    releaseRef: terms.skuRef, priceVersion: terms.priceVersion, pricePerUnitMicros: BigInt(terms.unitPriceMicros),
    meterQuantity: BigInt(cumulative / terms.unitPriceMicros),
  } : {}) });
  await db
    .prepare(
      `INSERT INTO usage_receipts
         (channel_id, usage_nonce, principal_id, offer_id, payer, seller, release_ref,
          meter_unit, meter_quantity, unit_price_micros, price_version, split_manifest_hash,
          reserved_micros, amount_micros, cumulative_claim_micros, expires_at_ms,
          voucher_digest, voucher_signature, receipt_signature, state, reserved_at_ms, settled_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'receipt-sig', 'settled', ?, ?)`,
    )
    .bind(
      CHANNEL,
      nonce,
      'gh:7',
      'offer-1',
      v.payer,
      v.seller,
      v.releaseRef,
      terms?.meterUnit ?? 'call',
      Number(v.meterQuantity),
      Number(v.pricePerUnitMicros),
      v.priceVersion,
      v.splitManifestHash,
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

function deploymentBody(overrides: Record<string, unknown> = {}) {
  return {
    chainId: CHAIN_ID,
    safeAddress: SAFE,
    rolesModuleAddress: ROLES_MODULE,
    deploymentTransactionHash: DEPLOY_TX,
    network: 'testnet',
    owners: [OWNER_A, OWNER_B],
    threshold: 2,
    automationSigner: AUTOMATION,
    deployedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

/** Record the testnet Safe deployment as the operator, then return to the buyer. */
async function recordDeployment(api: Api, env: Env2, overrides: Record<string, unknown> = {}): Promise<Response> {
  auth.resolveGithubBearer.mockResolvedValue({ id: 9, login: 'operator' });
  const response = await api.request('/commerce/treasury/safe-deployments', bearer(deploymentBody(overrides)), env);
  auth.resolveGithubBearer.mockResolvedValue({ id: 7, login: 'buyer' });
  return response;
}

/** Drive a settlement all the way to FINAL through the real P-033 routes. */
async function settleToFinal(api: Api, db: D1Database, env: Env2, splitManifestHash = SPLIT.manifestHash, terms?: IdentityPerUseOfferTerms): Promise<string> {
  await bindWallet(db);
  const opened = await api.request(
    '/commerce/payment-channels',
    bearer({ channelId: CHANNEL, escrowMicros: ESCROW, fundingSource: 'bound-wallet' }),
    env,
  );
  if (opened.status !== 201) throw new Error(`channel open failed: ${opened.status} ${await opened.text()}`);
  await seedSettledReceipt(db, 'n1', 10_000, splitManifestHash, terms);

  const claimed = await api.request(`/commerce/payment-channels/${CHANNEL}/settlements`, bearer(), env);
  if (claimed.status !== 201) throw new Error(`claim failed: ${claimed.status} ${await claimed.text()}`);
  const batchId = ((await claimed.json()) as { batch: { batchId: string } }).batch.batchId;

  const final = await api.request(
    `/commerce/payment-channels/${CHANNEL}/settlements/${batchId}/finality`,
    bearer(),
    env,
  );
  if (final.status !== 200) throw new Error(`finality failed: ${final.status} ${await final.text()}`);
  const verdict = (await final.json()) as { batch: { state: string } };
  if (verdict.batch.state !== 'final') throw new Error(`batch did not reach finality: ${verdict.batch.state}`);
  return batchId;
}

async function route(api: Api, env: Env2, batchId: string): Promise<Response> {
  return api.request(`/commerce/payment-channels/${CHANNEL}/settlements/${batchId}/treasury`, bearer(), env);
}

beforeEach(() => {
  auth.resolveGithubBearer.mockReset();
  auth.resolveGithubBearer.mockResolvedValue({ id: 7, login: 'buyer' });
});

describe('POST /commerce/treasury/safe-deployments', () => {
  it('records a testnet Safe deployment for an operator and reads it back', async () => {
    const { api, env } = harness();
    const response = await recordDeployment(api, env);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { deployment: Record<string, unknown> };
    expect(body.deployment).toMatchObject({
      chainId: CHAIN_ID,
      safeAddress: SAFE,
      rolesModuleAddress: ROLES_MODULE,
      rolesVersion: 'v2',
      network: 'testnet',
      threshold: 2,
      automationSigner: AUTOMATION,
      deploymentTransactionHash: DEPLOY_TX,
      recordedBy: 'gh:9',
    });

    const listed = await api.request('/commerce/treasury/safe-deployments', { headers: { Authorization: 'Bearer test-token' } }, env);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { deployments: unknown[] }).deployments).toHaveLength(1);
  });

  it('refuses a non-operator, an automation signer that is a Safe owner, and a malformed record', async () => {
    const { api, env } = harness();

    // The buyer is authenticated but not an operator.
    const forbidden = await api.request('/commerce/treasury/safe-deployments', bearer(deploymentBody()), env);
    expect(forbidden.status).toBe(403);

    // The separation invariant, refused at RECORD time: an automation key that
    // is also an owner counts toward the owner threshold.
    const merged = await recordDeployment(api, env, { automationSigner: OWNER_A });
    expect(merged.status).toBe(400);
    expect((await merged.json()) as { detail: string }).toMatchObject({
      detail: expect.stringContaining('must not be a Safe owner'),
    });

    const malformed = await recordDeployment(api, env, { rolesModuleAddress: SAFE });
    expect(malformed.status).toBe(400);
  });
});

describe('POST /commerce/payment-channels/:channelId/settlements/:batchId/treasury', () => {
  it('reconciles retained author amounts and refuses a changed recipient even when the component total is preserved', async () => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    const componentDependencies = [
      { packageKind: 'blueprint', ref: 'parent', revision: '1.0.0', contentHash: 'a'.repeat(64), author: 'alice' },
      { packageKind: 'pack', ref: 'knowledge', revision: '2.0.0', contentHash: 'b'.repeat(64), author: 'bob' },
    ];
    const split = revenueSplitManifest({ version: 'v1', sharesBps: SHARES, componentDependencies });
    const { api, db, env } = harness({ REVENUE_SPLIT_MANIFEST: JSON.stringify({ version: 'v1', sharesBps: SHARES, componentDependencies }) }, adapter);
    const batchId = await settleToFinal(api, db, env, split.manifestHash);
    await recordDeployment(api, env);
    expect((await route(api, env, batchId)).status).toBe(200);
    expect(submitTransfer).toHaveBeenCalledTimes(1);
    const row = await db.prepare('SELECT allocations_micros FROM settlement_batches WHERE batch_id = ?')
      .bind(batchId).first<{ allocations_micros: string }>();
    const allocations = JSON.parse(row!.allocations_micros) as Record<string, unknown>;
    allocations.componentAuthors = { alice: '250', mallory: '250' };
    await db.prepare('UPDATE settlement_batches SET allocations_micros = ? WHERE batch_id = ?')
      .bind(JSON.stringify(allocations), batchId).run();
    const refused = await route(api, env, batchId);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'reconciliation_failed' });
    expect(submitTransfer).toHaveBeenCalledTimes(1);
  });

  it('routes the reconciled DAO share into the Safe and records an auditable receipt', async () => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    const { api, db, env } = harness({}, adapter);
    const batchId = await settleToFinal(api, db, env);
    await recordDeployment(api, env);

    const response = await route(api, env, batchId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      transfers: Array<Record<string, unknown>>;
      alreadyRouted: string[];
      unprovenTransfers: string[];
      network: string;
    };

    // This split allocates the full 10_000 bps, so there is no rounding
    // remainder for the DAO to absorb: 1_000 bps of 10_000 micros is exactly
    // 1_000, and that is what reaches the Safe.
    expect(submitTransfer).toHaveBeenCalledTimes(1);
    expect(submitTransfer.mock.calls[0]![0]).toMatchObject({
      share: 'dao',
      token: STABLECOIN,
      recipient: TREASURY,
      amountMicros: 1_000n,
    });
    expect(body.network).toBe('testnet');
    expect(body.unprovenTransfers).toEqual([]);
    expect(body.transfers).toHaveLength(1);
    expect(body.transfers[0]).toMatchObject({
      share: 'dao',
      role: 'settlement',
      amountMicros: '1000',
      transactionHash: TRANSFER_TX,
      safeAddress: SAFE,
      rolesModuleAddress: ROLES_MODULE,
    });

    // The auditable DAO treasury receipt reached the P-016 commerce event log.
    const proofEventId = body.transfers[0]!.proofEventId as string;
    const event = await db
      .prepare(`SELECT kind, payload, signature FROM commerce_event_log WHERE event_id = ?`)
      .bind(proofEventId)
      .first<{ kind: string; payload: string; signature: string }>();
    expect(event?.kind).toBe('revenue-split');
    expect(event?.signature).toBe('fake-treasury-signature');
    const payload = JSON.parse(event!.payload) as Record<string, unknown>;
    expect(payload).toMatchObject({
      share: 'dao',
      amountMicros: '1000',
      splitManifestHash: SPLIT.manifestHash,
      rolesVersion: 'v2',
      network: 'testnet',
      transactionHash: TRANSFER_TX,
    });

    const listed = await api.request(
      `/commerce/payment-channels/${CHANNEL}/settlements/${batchId}/treasury`,
      { headers: { Authorization: 'Bearer test-token' } },
      env,
    );
    expect(((await listed.json()) as { transfers: unknown[] }).transfers).toHaveLength(1);
  });

  it('refuses a batch that has only been CLAIMED — a reorg can still drop it', async () => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    // headBlockNumber == claim block, so the claim never reaches the required
    // confirmation depth and the batch stays 'claimed'.
    const { api, db, env } = harness({}, adapter, {
      present: true,
      blockNumber: 100n,
      blockHash: CLAIM_BLOCK_HASH,
      headBlockNumber: 100n,
    });
    await bindWallet(db);
    await api.request('/commerce/payment-channels', bearer({ channelId: CHANNEL, escrowMicros: ESCROW, fundingSource: 'bound-wallet' }), env);
    await seedSettledReceipt(db, 'n1', 10_000);
    const claimed = await api.request(`/commerce/payment-channels/${CHANNEL}/settlements`, bearer(), env);
    const batchId = ((await claimed.json()) as { batch: { batchId: string } }).batch.batchId;
    await recordDeployment(api, env);

    const response = await route(api, env, batchId);
    expect(response.status).toBe(409);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ error: 'batch_not_final', state: 'claimed' });
    // Nothing left the Safe.
    expect(submitTransfer).not.toHaveBeenCalled();
  });

  it('refuses to route without a recorded Safe deployment', async () => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    const { api, db, env } = harness({}, adapter);
    const batchId = await settleToFinal(api, db, env);

    const response = await route(api, env, batchId);
    expect(response.status).toBe(409);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ error: 'safe_deployment_unrecorded' });
    expect(submitTransfer).not.toHaveBeenCalled();
  });

  it('refuses a settlement whose recorded allocations no longer reconcile', async () => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    const { api, db, env } = harness({}, adapter);
    const batchId = await settleToFinal(api, db, env);
    await recordDeployment(api, env);

    // Tamper with the stored allocations, moving the DAO's share to the host
    // while keeping the total intact — the row is what sits between claim and
    // routing, and this is exactly what re-reconciliation exists to catch.
    const row = await db
      .prepare(`SELECT allocations_micros FROM settlement_batches WHERE batch_id = ?`)
      .bind(batchId)
      .first<{ allocations_micros: string }>();
    const allocations = JSON.parse(row!.allocations_micros) as Record<string, string>;
    const moved = {
      ...allocations,
      dao: String(BigInt(allocations.dao!) - 500n),
      host: String(BigInt(allocations.host!) + 500n),
    };
    await db
      .prepare(`UPDATE settlement_batches SET allocations_micros = ? WHERE batch_id = ?`)
      .bind(JSON.stringify(moved), batchId)
      .run();

    const response = await route(api, env, batchId);
    expect(response.status).toBe(409);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: 'reconciliation_failed',
      code: 'allocation-mismatch',
    });
    expect(submitTransfer).not.toHaveBeenCalled();
  });

  it('is idempotent: re-routing the same settlement does not transfer twice', async () => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    const { api, db, env } = harness({}, adapter);
    const batchId = await settleToFinal(api, db, env);
    await recordDeployment(api, env);

    const first = await route(api, env, batchId);
    expect(first.status).toBe(200);
    const second = await route(api, env, batchId);
    expect(second.status).toBe(200);

    // The receipt hash is derived from the settlement's own contents, so the
    // retry resolves to the SAME durable row rather than a second transfer.
    expect(submitTransfer).toHaveBeenCalledTimes(1);
    expect((await second.json()) as { alreadyRouted: string[] }).toMatchObject({ alreadyRouted: ['dao'] });
    const { results } = await db
      .prepare(`SELECT transfer_id FROM treasury_transfers WHERE batch_id = ?`)
      .bind(batchId)
      .all<{ transfer_id: string }>();
    expect(results).toHaveLength(1);
  });

  it('gates mainnet capital on explicit owner approval', async () => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    const { api, db, env } = harness({}, adapter);
    const batchId = await settleToFinal(api, db, env);
    await recordDeployment(api, env, { network: 'mainnet' });

    const refused = await route(api, env, batchId);
    expect(refused.status).toBe(409);
    expect((await refused.json()) as Record<string, unknown>).toMatchObject({
      error: 'routing_refused',
      code: 'mainnet-capital-not-approved',
    });
    expect(submitTransfer).not.toHaveBeenCalled();

    // The owner's approval is the ONLY thing that changes between these two.
    env.TREASURY_MAINNET_CAPITAL_APPROVED = 'true';
    const approved = await route(api, env, batchId);
    expect(approved.status).toBe(200);
    expect(submitTransfer).toHaveBeenCalledTimes(1);
  });

  it('reserves an uncertain rail outcome and prevents a retry from submitting it twice', async () => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter({ failTransfer: true });
    const { api, db, env } = harness({}, adapter);
    const batchId = await settleToFinal(api, db, env);
    await recordDeployment(api, env);

    const response = await route(api, env, batchId);
    expect(response.status).toBe(502);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ error: 'treasury_transfer_failed', share: 'dao' });
    const { results } = await db.prepare(`SELECT submission_state, transaction_hash FROM treasury_transfers`).all();
    expect(results).toEqual([{ submission_state: 'pending', transaction_hash: '' }]);
    expect((await route(api, env, batchId)).status).toBe(409);
    expect(submitTransfer).toHaveBeenCalledTimes(1);
    expect((await witnessLedgerStream(db, 'treasury.transfers', Date.now())).appended).toBe(0);
    expect(await verifyLedgerStream(db, 'treasury.transfers')).toMatchObject({ ok: true, unchainedCount: 0 });
    expect(await readReconciliationInputs(db, Date.now())).toMatchObject({ daoTransfers: [] });
  });

  it('fails closed when the treasury policy is unconfigured, and refuses routing a payee share', async () => {
    const { adapter } = fakeTreasuryAdapter();
    const unconfigured = harness({}, adapter);
    delete (unconfigured.env as unknown as Record<string, unknown>).TREASURY_SAFE_ADDRESS;
    const batchId = await settleToFinal(unconfigured.api, unconfigured.db, unconfigured.env);
    const missing = await route(unconfigured.api, unconfigured.env, batchId);
    expect(missing.status).toBe(503);
    expect((await missing.json()) as { detail: string }).toMatchObject({
      detail: expect.stringContaining('TREASURY_SAFE_ADDRESS'),
    });

    // `creator` is money owed outward to a person, not DAO capital: routing it
    // into the Safe would sweep a creator's earnings into the treasury.
    const payee = harness({ TREASURY_ROUTED_SHARES: 'creator' }, adapter);
    const payeeBatch = await settleToFinal(payee.api, payee.db, payee.env);
    const refused = await route(payee.api, payee.env, payeeBatch);
    expect(refused.status).toBe(503);
    expect((await refused.json()) as { detail: string }).toMatchObject({
      detail: expect.stringContaining("may not route payee share 'creator'"),
    });
  });
});

describe('component author payouts on the existing settlement resource', () => {
  const ALICE = `0x${'a'.repeat(40)}`;
  const BOB = `0x${'b'.repeat(40)}`;
  const componentDependencies = [
    { packageKind: 'blueprint', ref: 'parent', revision: '1.0.0', contentHash: 'a'.repeat(64), author: 'gh:11' },
    { packageKind: 'pack', ref: 'knowledge', revision: '2.0.0', contentHash: 'b'.repeat(64), author: 'gh:12' },
  ];
  const split = revenueSplitManifest({ version: 'v1', sharesBps: SHARES, componentDependencies });

  async function prepared(overrides: Partial<Record<string, string>> = {}, adapter = fakeTreasuryAdapter().adapter, useIdentityOffer = false) {
    const offer = identityPerUseOfferTerms({ identity: { id: 'widget', version: '1.0.0' },
      creatorBps: 8500, componentBps: 500, componentDependencies });
    if (!offer.ok) throw new Error(offer.detail);
    const h = harness({ REVENUE_SPLIT_MANIFEST: JSON.stringify({ version: 'v1', sharesBps: SHARES, componentDependencies }),
      TREASURY_COMPONENT_RECIPIENTS: `${ALICE},${BOB}`, ...overrides }, adapter);
    if (useIdentityOffer) h.env.REVENUE_SPLIT_MANIFEST = JSON.stringify({ version: 'v1', sharesBps: SHARES });
    const batchId = await settleToFinal(h.api, h.db, h.env, useIdentityOffer ? offer.manifest.manifestHash : split.manifestHash,
      useIdentityOffer ? offer.terms : undefined);
    await recordDeployment(h.api, h.env);
    for (const [principal, wallet] of [['gh:11', ALICE], ['gh:12', BOB]]) {
      await h.db.prepare(`INSERT INTO wallet_bindings
        (principal_id, wallet_address, chain_id, challenge_id, verified_at_ms, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, 1, 1, 1)`).bind(principal, wallet, CHAIN_ID, `challenge-${principal}`).run();
    }
    return { ...h, batchId };
  }

  function payout(h: Awaited<ReturnType<typeof prepared>>, body?: unknown) {
    return h.api.request(`/commerce/payment-channels/${CHANNEL}/settlements/${h.batchId}/treasury?scope=components`, bearer(body), h.env);
  }

  it('calibrates the signed identity fixture against its final integer allocations before any payout', async () => {
    expect(inject('papercuspTestLayer')).toBe('integration');
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    const h = await prepared({}, adapter, true);
    const usage = await h.db.prepare(`SELECT meter_quantity, unit_price_micros, amount_micros, state
      FROM usage_receipts WHERE channel_id = ? AND usage_nonce = 'n1'`)
      .bind(CHANNEL).first();
    // These literal amounts are independent of the split implementation:
    // fifty 200-micro uses, 500 component basis points and 1000 DAO basis points.
    expect(usage).toMatchObject({ meter_quantity: 50, unit_price_micros: 200, amount_micros: 10000, state: 'settled' });
    const batch = await h.db.prepare(`SELECT claim_micros, provider_cost_micros, distributable_micros,
      allocations_micros, state FROM settlement_batches WHERE batch_id = ?`)
      .bind(h.batchId).first<{ claim_micros: number; provider_cost_micros: number;
        distributable_micros: number; allocations_micros: string; state: string }>();
    expect(batch).toMatchObject({ claim_micros: 10000, provider_cost_micros: 0,
      distributable_micros: 10000, state: 'final' });
    expect(JSON.parse(batch!.allocations_micros)).toMatchObject({ creator: '8500', component: '500', dao: '1000',
      componentAuthors: { 'gh:11': '250', 'gh:12': '250' } });
    expect(submitTransfer).not.toHaveBeenCalled();
  });

  it('settles signed identity terms with exact authors independently of the deployment-wide manifest', async () => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    const h = await prepared({}, adapter, true);
    expect((await payout(h)).status).toBe(200);
    expect(submitTransfer.mock.calls.map(([transfer]) => [transfer.recipient, transfer.amountMicros])).toEqual([[ALICE, 250n], [BOB, 250n]]);
    expect((await route(h.api, h.env, h.batchId)).status).toBe(200);
    expect(submitTransfer.mock.calls[2]![0]).toMatchObject({ share: 'dao', amountMicros: 1000n });
    h.raw.prepare("UPDATE usage_receipts SET price_version = 'identity-markup-v1;markup=2000;creator=9000;component=0;dao=1000'").run();
    const refused = await payout(h);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'reconciliation_failed' });
    expect(submitTransfer).toHaveBeenCalledTimes(3);
  });

  it('pays each verified author exact micros, records signed distinct receipts, and replays once', async () => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    const h = await prepared({}, adapter);
    const response = await payout(h, { recipient: OWNER_A, amountMicros: 999_999, policyApproved: true });
    expect(response.status).toBe(200);
    const body = await response.json() as { transfers: Array<{ payeeId: string; proofEventId: string; safeTxHash: string }> };
    expect(body.transfers).toMatchObject([
      { share: 'component', payeeId: 'gh:11', recipient: ALICE, amountMicros: '250', submissionState: 'submitted' },
      { share: 'component', payeeId: 'gh:12', recipient: BOB, amountMicros: '250', submissionState: 'submitted' },
    ]);
    expect(new Set(body.transfers.map((t) => t.safeTxHash)).size).toBe(2);
    const payoutEvents: CommerceEvent[] = [];
    for (const transfer of body.transfers) {
      const proof = await h.db.prepare('SELECT payload, signature FROM commerce_event_log WHERE event_id = ?')
        .bind(transfer.proofEventId).first<{ payload: string; signature: string }>();
      expect(JSON.parse(proof!.payload)).toMatchObject({ payeeId: transfer.payeeId, amountMicros: '250', share: 'component',
        recipient: transfer.payeeId === 'gh:11' ? ALICE : BOB, splitManifestHash: split.manifestHash });
      expect(proof!.signature).toBe('fake-treasury-signature');
      expect(JSON.parse(proof!.payload)).toMatchObject({ channelId: CHANNEL, payer: 'gh:7', payoutStatus: 'submitted' });
      payoutEvents.push({ eventId: transfer.proofEventId, streamId: 'treasury:channel', kind: 'revenue-split', version: 1,
        issuer: AUTOMATION, sequence: payoutEvents.length, occurredAtMs: Date.now(), idempotencyKey: transfer.proofEventId,
        payload: JSON.parse(proof!.payload), signature: proof!.signature });
    }
    expect(perUseRollup(payoutEvents).channels[0]?.submittedPayouts).toEqual({ daoMicros: '0', componentAuthorsMicros: { 'gh:11': '250', 'gh:12': '250' } });
    expect((await payout(h)).status).toBe(200);
    expect(submitTransfer).toHaveBeenCalledTimes(2);
    // DAO capital remains a distinct transfer on the same batch.
    expect((await route(h.api, h.env, h.batchId)).status).toBe(200);
    expect(submitTransfer).toHaveBeenCalledTimes(3);
    expect(await verifyLedgerStream(h.db, 'treasury.transfers')).toMatchObject({ ok: true, unchainedCount: 0 });
  });

  it('binds the author into otherwise identical authorization and records distinct payout proofs', async () => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    const h = await prepared({}, adapter);
    // Verified wallet enrollment is one-to-one. Exercise the payee-only digest
    // counterfactual at its writer, then route authors with valid bindings.
    expect(() => h.raw.prepare('UPDATE wallet_bindings SET wallet_address = ? WHERE principal_id = ?')
      .run(ALICE, 'gh:12')).toThrow(/UNIQUE constraint/);
    const policy = resolveTreasuryConfig(h.env, adapter);
    if (!policy.ok) throw new Error(policy.detail);
    const request = { role: 'settlement' as const, token: STABLECOIN, recipient: TREASURY,
      amountMicros: 250n, settlementReceiptHash: 'same-receipt', policyApproved: true };
    const first = authorizeTreasuryTransfer(policy.config, { ...request, payeeId: 'gh:11' });
    const second = authorizeTreasuryTransfer(policy.config, { ...request, payeeId: 'gh:12' });
    if (!first.ok || !second.ok) throw new Error('valid authorization control refused');
    expect(first.safeTxHash).not.toBe(second.safeTxHash);
    expect(authorizeTreasuryTransfer(policy.config, { ...request, payeeId: 'gh:11' })).toEqual(first);
    const response = await payout(h);
    expect(response.status).toBe(200);
    const body = await response.json() as { transfers: Array<{ payeeId: string; safeTxHash: string; proofEventId: string }> };
    expect(submitTransfer.mock.calls.map(([transfer]) => [transfer.recipient, transfer.amountMicros]))
      .toEqual([[ALICE, 250n], [BOB, 250n]]);
    expect(body.transfers.map((transfer) => transfer.payeeId)).toEqual(['gh:11', 'gh:12']);
    expect(new Set(body.transfers.map((transfer) => transfer.safeTxHash)).size).toBe(2);
    expect(new Set(body.transfers.map((transfer) => transfer.proofEventId)).size).toBe(2);
    expect((await payout(h)).status).toBe(200);
    expect(submitTransfer).toHaveBeenCalledTimes(2);
  });

  it.each(['missing', 'other-chain', 'not-allowlisted', 'cap', 'mainnet', 'paused', 'not-final', 'tampered', 'no-safe'] as const)(
    'refuses %s evidence before any author transfer', async (failure) => {
      const { adapter, submitTransfer } = fakeTreasuryAdapter();
      const h = await prepared({}, adapter);
      if (failure === 'missing') h.raw.prepare('DELETE FROM wallet_bindings WHERE principal_id = ?').run('gh:12');
      if (failure === 'other-chain') h.raw.prepare('UPDATE wallet_bindings SET chain_id = 1 WHERE principal_id = ?').run('gh:12');
      if (failure === 'not-allowlisted') h.env.TREASURY_COMPONENT_RECIPIENTS = ALICE;
      if (failure === 'cap') h.env.TREASURY_SETTLEMENT_MAX_MICROS = '249';
      if (failure === 'mainnet') await recordDeployment(h.api, h.env, { network: 'mainnet' });
      if (failure === 'paused') h.raw.prepare('UPDATE treasury_transfer_gate SET open = 0').run();
      if (failure === 'not-final') h.raw.prepare("UPDATE settlement_batches SET state = 'claimed', finalized_at_ms = NULL WHERE batch_id = ?").run(h.batchId);
      if (failure === 'no-safe') h.raw.prepare('DELETE FROM treasury_safe_deployments').run();
      if (failure === 'tampered') {
        const row = h.raw.prepare('SELECT allocations_micros FROM settlement_batches WHERE batch_id = ?').get(h.batchId) as { allocations_micros: string };
        const allocations = JSON.parse(row.allocations_micros);
        allocations.componentAuthors = { 'gh:11': '249', 'gh:12': '251' };
        h.raw.prepare('UPDATE settlement_batches SET allocations_micros = ? WHERE batch_id = ?').run(JSON.stringify(allocations), h.batchId);
      }
      expect((await payout(h)).status).toBe(409);
      expect(submitTransfer).not.toHaveBeenCalled();
      expect(h.raw.prepare('SELECT COUNT(*) AS n FROM treasury_transfers').get()).toMatchObject({ n: 0 });
    },
  );

  it('requires configured payout authority and restricts the batch to its authenticated buyer', async () => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    const h = await prepared({}, adapter);
    delete h.env.TREASURY_COMPONENT_RECIPIENTS;
    expect((await payout(h)).status).toBe(503);
    h.env.TREASURY_COMPONENT_RECIPIENTS = `${ALICE},${BOB}`;
    auth.resolveGithubBearer.mockResolvedValue({ id: 8, login: 'stranger' });
    expect((await payout(h)).status).toBe(404);
    expect(submitTransfer).not.toHaveBeenCalled();
  });

  it('elects one sender when two requests race before the first chain receipt', async () => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    const h = await prepared({}, adapter);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    submitTransfer.mockImplementationOnce(async () => {
      entered();
      await pending;
      return { transactionHash: TRANSFER_TX, blockNumber: 300n };
    });
    const first = payout(h);
    await started;
    const second = await payout(h);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: 'treasury_transfer_pending' });
    expect(submitTransfer).toHaveBeenCalledTimes(1);
    release();
    expect((await first).status).toBe(200);
    expect(submitTransfer).toHaveBeenCalledTimes(2);
    expect((await payout(h)).status).toBe(200);
    expect(submitTransfer).toHaveBeenCalledTimes(2);
  });

  it('keeps successful author transfers recorded when a later submission fails', async () => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    const h = await prepared({}, adapter);
    submitTransfer.mockResolvedValueOnce({ transactionHash: TRANSFER_TX, blockNumber: 300n })
      .mockRejectedValueOnce(new Error('uncertain chain outcome'));
    expect((await payout(h)).status).toBe(502);
    expect((await payout(h)).status).toBe(409);
    expect(submitTransfer).toHaveBeenCalledTimes(2);
    expect(h.raw.prepare('SELECT payee_id, submission_state FROM treasury_transfers ORDER BY payee_id').all()).toEqual([
      { payee_id: 'gh:11', submission_state: 'submitted' }, { payee_id: 'gh:12', submission_state: 'pending' },
    ]);
    expect(await verifyLedgerStream(h.db, 'treasury.transfers')).toMatchObject({ ok: true, unchainedCount: 0 });
  });

  it('records a completed transfer even when signing its proof fails', async () => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    const h = await prepared({}, { ...adapter, signTreasuryProof: async () => { throw new Error('signer unavailable'); } });
    const response = await payout(h);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ unprovenTransfers: ['gh:11', 'gh:12'] });
    expect((await payout(h)).status).toBe(200);
    expect(submitTransfer).toHaveBeenCalledTimes(2);
  });
});

describe('the P-043 reconciliation gate on DAO transfers', () => {
  // A low-entropy test key, not a credential.
  const SECRET = 'k'.repeat(32);

  async function pushGate(api: Api, env: Env2, push: Record<string, unknown>): Promise<Response> {
    const body = JSON.stringify(push);
    const signature = await signReconciliationRequest({
      secret: SECRET,
      method: 'PUT',
      pathname: TRANSFER_GATE_PATH,
      body,
      nowMs: Date.now(),
    });
    return api.request(
      TRANSFER_GATE_PATH,
      { method: 'PUT', headers: { 'content-type': 'application/json', [RECONCILIATION_SIGNATURE_HEADER]: signature }, body },
      env,
    );
  }

  it.each([
    ['unauthorized', 401],
    ['invalid-config', 503],
    ['batch_not_final', 409],
    ['reconciliation_failed', 409],
    ['safe_deployment_unrecorded', 409],
    ['routing_refused', 409],
  ] as const)('preserves %s before checking a closed transfer gate', async (error, status) => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    const { api, db, raw, env } = harness({}, adapter);
    const batchId = await settleToFinal(api, db, env);
    if (error !== 'safe_deployment_unrecorded') await recordDeployment(api, env);
    raw.prepare('UPDATE treasury_transfer_gate SET open = 0, reasons_json = ?').run('["seeded break"]');
    if (error === 'unauthorized') auth.resolveGithubBearer.mockRejectedValue(new AuthError('missing_bearer'));
    if (error === 'invalid-config') env.TREASURY_SAFE_THRESHOLD = '0';
    if (error === 'batch_not_final') raw.prepare('UPDATE settlement_batches SET state = ?, finalized_at_ms = NULL WHERE batch_id = ?').run('claimed', batchId);
    if (error === 'reconciliation_failed') {
      const row = raw.prepare('SELECT allocations_micros FROM settlement_batches WHERE batch_id = ?').get(batchId) as { allocations_micros: string };
      const allocations = JSON.parse(row.allocations_micros) as Record<string, string>;
      allocations.dao = String(BigInt(allocations.dao!) - 1n);
      allocations.host = String(BigInt(allocations.host!) + 1n);
      raw.prepare('UPDATE settlement_batches SET allocations_micros = ? WHERE batch_id = ?').run(JSON.stringify(allocations), batchId);
    }
    if (error === 'routing_refused') env.TREASURY_SETTLEMENT_MAX_MICROS = '1';
    const response = await route(api, env, batchId);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error });
    expect(submitTransfer).not.toHaveBeenCalled();
    expect(raw.prepare('SELECT COUNT(*) AS n FROM treasury_transfers').get()).toMatchObject({ n: 0 });
  });

  it.each(['disputed', 'refunded'])('omits a formerly FINAL %s batch from independent reconciliation inputs', async (state) => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    const { api, db, raw, env } = harness({}, adapter);
    const batchId = await settleToFinal(api, db, env);
    const before = await readReconciliationInputs(db, Date.now());
    expect(before.finalSettlementBatches.map((batch) => batch.batchId)).toEqual([batchId]);
    raw.prepare('UPDATE settlement_batches SET state = ?, finalized_at_ms = NULL WHERE batch_id = ?').run(state, batchId);
    const after = await readReconciliationInputs(db, Date.now());
    expect(after.finalSettlementBatches).toEqual([]);
    expect(raw.prepare('SELECT state FROM settlement_batches WHERE batch_id = ?').get(batchId)).toMatchObject({ state });
    expect(submitTransfer).not.toHaveBeenCalled();
  });

  it('pauses DAO transfers for every gate state except a fresh, open, treasury-reconciled one', async () => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    const { api, db, raw, env } = harness({ RECONCILIATION_GATE_SECRET: SECRET }, adapter);
    const batchId = await settleToFinal(api, db, env);
    await recordDeployment(api, env);
    const setGate = (open: number, reconciled: number, reasons: string, atMs: number) =>
      raw
        .prepare(
          `UPDATE treasury_transfer_gate SET open = ?, treasury_reconciled = ?, reasons_json = ?, at_ms = ? WHERE workspace_id = ?`,
        )
        .run(open, reconciled, reasons, atMs, GATE_WORKSPACE);

    const expectPaused = async (code: string, detail?: string) => {
      const response = await route(api, env, batchId);
      expect(response.status).toBe(409);
      expect((await response.json()) as Record<string, unknown>).toMatchObject({
        error: 'transfers_paused',
        code,
        ...(detail ? { detail: expect.stringContaining(detail) } : {}),
      });
    };

    // No workspace governs this Worker.
    delete (env as unknown as Record<string, unknown>).RECONCILIATION_GATE_WORKSPACE;
    await expectPaused('no-governing-workspace');
    // A governing workspace reconciliation never reported for.
    env.RECONCILIATION_GATE_WORKSPACE = 'ws-never-reported';
    await expectPaused('never-reported');
    env.RECONCILIATION_GATE_WORKSPACE = GATE_WORKSPACE;
    // A break is open: the run's reason reaches the caller.
    setGate(0, 1, JSON.stringify(['credit-reserve: reserve 10 < outstanding 20']), Date.now());
    await expectPaused('break-open', 'credit-reserve');
    // Open, but the run never read this treasury.
    setGate(1, 0, '[]', Date.now());
    await expectPaused('treasury-not-reconciled');
    // Open and reconciled, but reconciliation stopped reporting.
    setGate(1, 1, '[]', Date.now() - TRANSFER_GATE_MAX_AGE_MS - 60_000);
    await expectPaused('stale');
    expect(submitTransfer).not.toHaveBeenCalled();

    // The reconciliation run's signed push is what reopens the door.
    const pushed = await pushGate(api, env, {
      workspaceId: GATE_WORKSPACE,
      open: true,
      reasons: [],
      runId: 'run-fresh',
      atMs: Date.now(),
      treasuryReconciled: true,
    });
    expect(pushed.status).toBe(200);
    expect((await pushed.json()) as Record<string, unknown>).toMatchObject({ applied: true, transfers: 'open' });
    const routed = await route(api, env, batchId);
    expect(routed.status).toBe(200);
    expect(submitTransfer).toHaveBeenCalledTimes(1);
  });

  it('a later run that finds a break closes the gate for the next routing', async () => {
    const { adapter, submitTransfer } = fakeTreasuryAdapter();
    const { api, db, env } = harness({ RECONCILIATION_GATE_SECRET: SECRET }, adapter);
    const batchId = await settleToFinal(api, db, env);
    await recordDeployment(api, env);

    const closed = await pushGate(api, env, {
      workspaceId: GATE_WORKSPACE,
      open: false,
      reasons: ['dao-payable: accrued 1000 - transferred 0 != payable 900'],
      runId: 'run-break',
      atMs: Date.now(),
      treasuryReconciled: true,
    });
    expect(closed.status).toBe(200);
    expect((await closed.json()) as Record<string, unknown>).toMatchObject({ applied: true, transfers: 'paused' });

    const response = await route(api, env, batchId);
    expect(response.status).toBe(409);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ error: 'transfers_paused', code: 'break-open' });
    expect(submitTransfer).not.toHaveBeenCalled();
  });
});
