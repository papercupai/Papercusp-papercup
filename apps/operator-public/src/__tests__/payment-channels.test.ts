import { paymentTestOpening, paymentTestKey } from '@papercusp/operator-core/lib/p2p/_payment-voucher-fixture';
import { paymentChannelPayerSigningBytes } from '@papercusp/operator-core/lib/p2p/channel-funding';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '@papercusp/operator-core/lib/identity/ed25519';
/**
 * Buyer-side channel funding through the shipped Worker production door.
 *
 * The EVM rail is injected as a deterministic fake, while authentication,
 * wallet/prepaid authority, D1 migrations, lifecycle persistence, idempotency,
 * compensation, and partial-refund accounting are all production code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentChannelFundingAdapter } from '@papercusp/operator-core/lib/p2p/channel-funding.ts';
import {
  CREDIT_MICROS_PER_USD_MINOR,
  PREPAID_CREDIT_OFFER_ID,
  PREPAID_CREDIT_TOP_UP,
  prepaidCreditCatalogEvents,
} from '@papercusp/operator-core/lib/cupboard/prepaid-credits.ts';
import type { LedgerEvent } from '@papercusp/operator-core/lib/cupboard/commerce-ledger.ts';
import { buildApi } from '../routes/index.ts';
import { appendLedgerEvents, projectLedger } from '../commerce-store.ts';
import { projectPrepaidCredits } from '../prepaid-credit-store.ts';
import { makeEnv } from './fake-d1.ts';
import { makeSqliteDb } from './sqlite-d1.ts';

const auth = vi.hoisted(() => ({ resolveGithubBearer: vi.fn() }));
vi.mock('../auth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth.ts')>();
  return { ...actual, resolveGithubBearer: auth.resolveGithubBearer };
});

const CHAIN_ID = 84_532;
const SIGNER = `0x${'1'.repeat(40)}`;
const OTHER_WALLET = `0x${'2'.repeat(40)}`;
const STABLECOIN = `0x${'3'.repeat(40)}`;
const SETTLEMENT_CONTRACT = `0x${'4'.repeat(40)}`;
const CREDIT_GRANT =
  PREPAID_CREDIT_TOP_UP.amountMinor * CREDIT_MICROS_PER_USD_MINOR;

function fakeAdapter(options: { failOpen?: boolean; signer?: string } = {}) {
  const openChannel = vi.fn<PaymentChannelFundingAdapter['openChannel']>(
    async () => {
      if (options.failOpen) throw new Error('fake rail open failure');
      return {
        transactionHash: `0x${'a'.repeat(64)}`,
        blockNumber: 101n,
      };
    },
  );
  const closeChannel = vi.fn<PaymentChannelFundingAdapter['closeChannel']>(
    async () => ({
      transactionHash: `0x${'b'.repeat(64)}`,
      blockNumber: 202n,
    }),
  );
  const adapter: PaymentChannelFundingAdapter = {
    rail: 'evm-x402',
    chainId: CHAIN_ID,
    stablecoinAddress: STABLECOIN,
    settlementContractAddress: SETTLEMENT_CONTRACT,
    signerAddress: options.signer ?? SIGNER,
    openChannel,
    closeChannel,
  };
  return { adapter, openChannel, closeChannel };
}

function harness(adapter?: PaymentChannelFundingAdapter) {
  const { db, raw } = makeSqliteDb();
  const { env } = makeEnv();
  env.DB = db;
  return {
    api: buildApi({ paymentChannelAdapter: adapter }),
    db,
    env,
    raw,
  };
}

function bearerJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(paymentTestOpening(body, { payer: 'gh:42', chainId: CHAIN_ID, stablecoinAddress: STABLECOIN, settlementContractAddress: SETTLEMENT_CONTRACT, walletAddress: SIGNER })),
  };
}

async function seedCredits(db: D1Database): Promise<void> {
  const events: LedgerEvent[] = [
    ...prepaidCreditCatalogEvents(1_000),
    {
      ledgerEventId: 'payment-channel-test:order-created',
      kind: 'order.created',
      occurredAtMs: 2_000,
      source: { provider: 'operator', providerEventId: null },
      payload: {
        orderId: 'payment-channel-test:order',
        offerId: PREPAID_CREDIT_OFFER_ID,
        buyerId: 'gh:42',
      },
    },
    {
      ledgerEventId: 'payment-channel-test:order-paid',
      kind: 'order.paid',
      occurredAtMs: 3_000,
      source: { provider: 'stripe', providerEventId: 'evt-channel-credit' },
      payload: { orderId: 'payment-channel-test:order' },
    },
  ];
  await appendLedgerEvents(db, events);
  await projectLedger(db);
  await projectPrepaidCredits(db);
}

async function bindWallet(
  db: D1Database,
  walletAddress = SIGNER,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO wallet_bindings
       (principal_id, wallet_address, chain_id, challenge_id, verified_at_ms,
        created_at_ms, updated_at_ms)
       VALUES ('gh:42', ?, ?, 'channel-test-challenge', 1, 1, 1)`,
    )
    .bind(walletAddress, CHAIN_ID)
    .run();
}

describe('payment-channel Worker production door', () => {
  beforeEach(() => {
    auth.resolveGithubBearer.mockReset();
    auth.resolveGithubBearer.mockResolvedValue({
      id: 42,
      login: 'channel-buyer',
    });
  });

  it('refuses missing, forged and altered opening-key proofs before escrow I/O', async () => {
    const rail = fakeAdapter(); const h = harness(rail.adapter); await bindWallet(h.db);
    const signed = JSON.parse(String(bearerJson({ channelId: 'authenticated-key', escrowMicros: 100,
      fundingSource: 'bound-wallet' }).body)) as Record<string, unknown>;
    for (const change of [ { payerPubkeyBase64: undefined, payerKeyProof: undefined },
      { payerKeyProof: 'forged' }, { channelId: 'substituted-channel' }, { escrowMicros: 101 } ]) {
      const response = await h.api.request('/commerce/payment-channels', bearerJson({ ...signed, ...change }), h.env);
      expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ error: 'invalid_payer_key' });
    }
    expect(rail.openChannel).not.toHaveBeenCalled();
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM payment_channels').get()).toMatchObject({ n: 0 });
  });

  it('pins the authenticated opening key and refuses replacement on retry and in D1', async () => {
    const rail = fakeAdapter(); const h = harness(rail.adapter); await bindWallet(h.db);
    const body = { channelId: 'immutable-key', escrowMicros: 100, fundingSource: 'bound-wallet' };
    expect((await h.api.request('/commerce/payment-channels', bearerJson(body), h.env)).status).toBe(201);
    const stranger = generateEd25519KeypairDer();
    const binding = { channelId: body.channelId, payer: 'gh:42', payerPubkeyBase64: stranger.pubkeyBase64,
      chainId: CHAIN_ID, stablecoinAddress: STABLECOIN, settlementContractAddress: SETTLEMENT_CONTRACT,
      escrowMicros: '100', fundingSource: { kind: 'bound-wallet' as const, walletAddress: SIGNER } };
    const replacement = { ...body, payerPubkeyBase64: stranger.pubkeyBase64,
      payerKeyProof: signWithPrivateKeyDer(stranger.privateKeyDer, paymentChannelPayerSigningBytes(binding)).toString('base64') };
    const response = await h.api.request('/commerce/payment-channels', bearerJson(replacement), h.env);
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: 'channel-conflict' });
    expect(rail.openChannel).toHaveBeenCalledTimes(1);
    expect(() => h.raw.prepare('UPDATE payment_channels SET payer_pubkey_base64 = ? WHERE channel_id = ?')
      .run(stranger.pubkeyBase64, body.channelId)).toThrow('payer authority is immutable');
    expect(h.raw.prepare('SELECT payer_pubkey_base64 FROM payment_channels WHERE channel_id = ?').get(body.channelId))
      .toMatchObject({ payer_pubkey_base64: paymentTestKey.pubkeyBase64 });
  });

  it('fails closed when the viem rail secrets and vars are not configured', async () => {
    const { api, env, raw } = harness();
    const response = await api.request(
      '/commerce/payment-channels',
      bearerJson({
        channelId: 'unconfigured-channel',
        escrowMicros: 1,
        fundingSource: 'prepaid-credit',
      }),
      env,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: 'not-configured',
    });
    expect(
      raw.prepare('SELECT COUNT(*) AS n FROM payment_channels').get(),
    ).toMatchObject({ n: 0 });
  });

  it('opens prepaid escrow idempotently, reads it only as its principal, and closes with the unused amount refunded', async () => {
    const rail = fakeAdapter();
    const { api, db, env, raw } = harness(rail.adapter);
    await seedCredits(db);

    const request = {
      channelId: 'prepaid-channel',
      escrowMicros: 5_000_000,
      fundingSource: 'prepaid-credit',
    };
    const opened = await api.request(
      '/commerce/payment-channels',
      bearerJson(request),
      env,
    );
    expect(opened.status).toBe(201);
    expect(await opened.json()).toMatchObject({
      replayed: false,
      channel: {
        channelId: request.channelId,
        principalId: 'gh:42',
        state: 'open',
        fundingSource: {
          kind: 'prepaid-credit',
          reservationId: 'payment-channel:prepaid-channel',
        },
        escrowMicros: 5_000_000,
        openReceipt: {
          transactionHash: `0x${'a'.repeat(64)}`,
          blockNumber: '101',
        },
      },
    });
    expect(rail.openChannel).toHaveBeenCalledTimes(1);
    expect(rail.openChannel.mock.calls[0]?.[0]).toMatchObject({
      principalId: 'gh:42',
      channel: {
        channelId: request.channelId,
        rail: 'evm-x402',
        escrowMicros: 5_000_000n,
      },
      fundingSource: {
        kind: 'prepaid-credit',
        reservationId: 'payment-channel:prepaid-channel',
      },
    });
    expect(
      raw
        .prepare(
          `SELECT available_micros, reserved_micros
           FROM prepaid_credit_balances WHERE principal_id = 'gh:42'`,
        )
        .get(),
    ).toMatchObject({
      available_micros: CREDIT_GRANT - 5_000_000,
      reserved_micros: 5_000_000,
    });

    const replay = await api.request(
      '/commerce/payment-channels',
      bearerJson(request),
      env,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true });
    expect(rail.openChannel).toHaveBeenCalledTimes(1);

    const visible = await api.request(
      '/commerce/payment-channels/prepaid-channel',
      { headers: { Authorization: 'Bearer test-token' } },
      env,
    );
    expect(visible.status).toBe(200);
    expect(await visible.json()).toMatchObject({ channel: { channelId: request.channelId, principalId: 'gh:42' } });

    auth.resolveGithubBearer.mockResolvedValueOnce({
      id: 99,
      login: 'other-buyer',
    });
    const hidden = await api.request(
      '/commerce/payment-channels/prepaid-channel',
      { headers: { Authorization: 'Bearer test-token' } },
      env,
    );
    expect(hidden.status).toBe(404);

    const closed = await api.request(
      '/commerce/payment-channels/prepaid-channel/close',
      bearerJson({ committedMicros: 3_000_000 }),
      env,
    );
    expect(closed.status).toBe(200);
    expect(await closed.json()).toMatchObject({
      replayed: false,
      channel: {
        state: 'closed',
        committedMicros: 3_000_000,
        refundedMicros: 2_000_000,
        closeReceipt: {
          transactionHash: `0x${'b'.repeat(64)}`,
          blockNumber: '202',
        },
      },
    });
    expect(rail.closeChannel).toHaveBeenCalledTimes(1);
    expect(
      raw
        .prepare(
          `SELECT available_micros, reserved_micros, spent_micros
           FROM prepaid_credit_balances WHERE principal_id = 'gh:42'`,
        )
        .get(),
    ).toMatchObject({
      available_micros: CREDIT_GRANT - 3_000_000,
      reserved_micros: 0,
      spent_micros: 3_000_000,
    });

    const closeReplay = await api.request(
      '/commerce/payment-channels/prepaid-channel/close',
      bearerJson({ committedMicros: 3_000_000 }),
      env,
    );
    expect(closeReplay.status).toBe(200);
    expect(await closeReplay.json()).toMatchObject({ replayed: true });
    expect(rail.closeChannel).toHaveBeenCalledTimes(1);
  });

  it('releases prepaid credits when the rail open fails', async () => {
    const rail = fakeAdapter({ failOpen: true });
    const { api, db, env, raw } = harness(rail.adapter);
    await seedCredits(db);

    const response = await api.request(
      '/commerce/payment-channels',
      bearerJson({
        channelId: 'failed-prepaid-channel',
        escrowMicros: 4_000_000,
        fundingSource: 'prepaid-credit',
      }),
      env,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'rail_open_failed' });
    expect(
      raw
        .prepare(
          `SELECT state, failure_code
           FROM payment_channels WHERE channel_id = 'failed-prepaid-channel'`,
        )
        .get(),
    ).toMatchObject({
      state: 'failed',
      failure_code: 'rail-open-failed',
    });
    expect(
      raw
        .prepare(
          `SELECT available_micros, reserved_micros, spent_micros
           FROM prepaid_credit_balances WHERE principal_id = 'gh:42'`,
        )
        .get(),
    ).toMatchObject({
      available_micros: CREDIT_GRANT,
      reserved_micros: 0,
      spent_micros: 0,
    });
  });

  it('requires the configured signer to equal the authenticated bound wallet', async () => {
    const mismatchRail = fakeAdapter({ signer: OTHER_WALLET });
    const mismatch = harness(mismatchRail.adapter);
    await bindWallet(mismatch.db);
    const refused = await mismatch.api.request(
      '/commerce/payment-channels',
      bearerJson({
        channelId: 'wallet-channel-mismatch',
        escrowMicros: 1_000_000,
        fundingSource: 'bound-wallet',
      }),
      mismatch.env,
    );
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({
      error: 'wallet_signer_mismatch',
    });
    expect(mismatchRail.openChannel).not.toHaveBeenCalled();

    const matchingRail = fakeAdapter();
    const matching = harness(matchingRail.adapter);
    await bindWallet(matching.db);
    const opened = await matching.api.request(
      '/commerce/payment-channels',
      bearerJson({
        channelId: 'wallet-channel',
        escrowMicros: 1_000_000,
        fundingSource: 'bound-wallet',
      }),
      matching.env,
    );
    expect(opened.status).toBe(201);
    expect(await opened.json()).toMatchObject({
      channel: {
        state: 'open',
        fundingSource: {
          kind: 'bound-wallet',
          walletAddress: SIGNER,
        },
      },
    });
    expect(matchingRail.openChannel).toHaveBeenCalledTimes(1);
  });
});
