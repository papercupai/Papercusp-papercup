import { signPaymentTestBytes, signPaymentTestVoucher, paymentTestVerifier } from './_payment-voucher-fixture';
/**
 * P-031 metering interception — the pure core and the BYOC honor-path leg.
 *
 * The four cases the plan item names by hand (through the doors, duplicate
 * nonce, cap exhaustion, cumulative regression) are covered here at the
 * interception point; the door-level halves live in the Worker route test and
 * the agent-tool door test.
 */
import { describe, expect, it } from 'vitest';
import {
  acceptMeteredVoucher,
  buildUsageVoucher,
  closeMeteredInvocation,
  declareMeter,
  openMeteredInvocation,
  quoteMicros,
  usageReceiptSigningBytes,
  LocalMeteredTurn,
  type LocalMeteredTurnState,
  type BillableUnit,
  type MeterDeclaration,
} from './metered-invocation';
import { createMicrochargeChannel, type MicrochargeChannel } from './microcharge';
import { emptyMeteringLedger, contributionOf, spentOn } from './metering-ledger';
import { createByocBudget, prepareByocExecution, settleByocExecution } from './byoc-execution';
import { identityPerUseOfferTerms } from '../cupboard/identity-per-use-offer';

const TERMS = {
  unitPriceMicros: 250,
  meterUnit: 'tool-call',
  priceVersion: 'v3',
  splitManifestHash: `sha256:${'a'.repeat(64)}`,
};

function meter(): MeterDeclaration {
  const declared = declareMeter(TERMS);
  if (!declared.ok) throw new Error(`fixture terms must declare: ${declared.detail}`);
  return declared.meter;
}

function unit(overrides: Partial<BillableUnit> = {}): BillableUnit {
  return {
    payer: 'org_buyer',
    seller: 'gh:4242',
    releaseRef: 'sku:sentiment-tool@1.4.0',
    usageNonce: 'nonce-1',
    quantity: 4n,
    expiresAtMs: 10_000,
    ...overrides,
  };
}

const signVoucher = signPaymentTestBytes;
const signReceipt = () => 'seller-signature';

function localTurn(overrides: Partial<LocalMeteredTurnState> = {}, deps: {
  nowMs?: () => number;
  signVoucher?: (bytes: Buffer) => Promise<string> | string;
  signReceipt?: (bytes: Buffer) => Promise<string> | string;
  persist?: (state: LocalMeteredTurnState) => Promise<void>;
} = {}) {
  let stored: LocalMeteredTurnState | null = null;
  const turn = new LocalMeteredTurn({
    state: { turnId: 'turn-1', payer: 'org_buyer', seller: 'gh:4242',
      releaseRef: 'sku:sentiment-tool@1.4.0', meter: meter(), ceilingMicros: 1_000n,
      expiresAtMs: 10_000, reservedMicros: 0n, channel: createMicrochargeChannel('channel-1', 2_000n),
      units: {}, ...overrides },
    nowMs: deps.nowMs ?? (() => 1_000),
    signVoucher: deps.signVoucher ?? signVoucher,
    signReceipt: deps.signReceipt ?? signReceipt,
    persist: async (state) => { await deps.persist?.(state); stored = structuredClone(state); },
  });
  return { turn, stored: () => stored };
}

describe('LocalMeteredTurn', () => {
  const call = (usageNonce: string, quantity = 1n) => ({ payer: 'org_buyer',
    releaseRef: 'sku:sentiment-tool@1.4.0', usageNonce, quantity });

  it('persists host withdrawal and refuses new calls after restoring the closed snapshot', async () => {
    const { turn, stored } = localTurn();
    await turn.stopAdmission();
    expect(stored()?.admissionClosed).toBe(true);
    const execute = () => { throw new Error('must not execute'); };
    await expect(turn.invoke(call('late'), execute)).rejects.toMatchObject({ code: 'turn-admission-closed' });
    await expect(localTurn(stored()!).turn.invoke(call('restart'), execute)).rejects.toMatchObject({ code: 'turn-admission-closed' });
  });

  it('persists a bound signed reservation before execution and an itemized settlement before returning', async () => {
    const { turn, stored } = localTurn();
    expect(await turn.invoke(call('one'), () => {
      expect(stored()?.channel.reservations.one).toBe(250n);
      expect(stored()?.units.one?.voucher).toMatchObject({ payer: 'org_buyer', seller: 'gh:4242',
        releaseRef: call('one').releaseRef, priceVersion: 'v3', splitManifestHash: TERMS.splitManifestHash });
      return 'served';
    })).toBe('served');
    expect(stored()?.channel.committedMicros).toBe(250n);
    expect(stored()?.channel.reservations).toEqual({});
    expect(stored()?.units.one?.receipt?.amountMicros).toBe(250n);
    expect(stored()?.reservedMicros).toBe(250n);
  });

  it('serializes async signing while concurrent handlers finish out of order, without losing charges', async () => {
    const { turn } = localTurn({}, { signVoucher: async () => { await Promise.resolve(); return 'payer'; },
      signReceipt: async () => { await Promise.resolve(); return 'seller'; } });
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    const first = turn.invoke(call('first'), async () => {
      firstEntered();
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return 'first';
    });
    await entered;
    expect(await turn.invoke(call('second'), () => 'second')).toBe('second');
    expect(turn.snapshot().channel.reservations.first).toBe(250n);
    expect(turn.snapshot().channel.committedMicros).toBe(250n);
    releaseFirst();
    await first;
    expect(turn.snapshot().channel.committedMicros).toBe(500n);
    expect(turn.snapshot().channel.lastCumulativeMicros).toBe(500n);
    expect(Object.keys(turn.snapshot().channel.receipts).sort()).toEqual(['first', 'second']);
  });

  it('refuses a fifth concurrent charge at the per-turn ceiling before execution', async () => {
    const { turn } = localTurn();
    let executed = 0;
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, (_, index) =>
      turn.invoke(call(`call-${index}`), () => { executed += 1; })));
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(4);
    expect(executed).toBe(4);
    const rejected = outcomes.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason.code).toBe('cap-exhausted');
    expect(turn.snapshot().channel.committedMicros).toBe(1_000n);
  });

  it.each([
    ['another payer', { payer: 'other-buyer' }],
    ['another release', { releaseRef: 'sku:another-tool@1' }],
    ['zero quantity', { quantity: 0n }],
  ] as const)('refuses %s before the handler', async (_label, change) => {
    const { turn } = localTurn();
    let executed = false;
    await expect(turn.invoke({ ...call('one'), ...change }, () => { executed = true; })).rejects.toThrow();
    expect(executed).toBe(false);
    expect(turn.snapshot().reservedMicros).toBe(0n);
  });

  it('refuses a voucher whose turn expires during asynchronous signing', async () => {
    let nowMs = 1_000;
    const { turn } = localTurn({}, { nowMs: () => nowMs, signVoucher: async () => {
      nowMs = 10_001;
      return 'payer';
    } });
    let executed = false;
    await expect(turn.invoke(call('late'), () => { executed = true; })).rejects.toMatchObject({ code: 'expired' });
    expect(executed).toBe(false);
    expect(turn.snapshot().reservedMicros).toBe(0n);
  });

  it('refuses empty signer output before execution without consuming turn capacity', async () => {
    const { turn } = localTurn({}, { signVoucher: () => '' });
    let executed = false;
    await expect(turn.invoke(call('unsigned'), () => { executed = true; }))
      .rejects.toMatchObject({ code: 'unsigned-voucher' });
    expect(executed).toBe(false);
    expect(turn.snapshot().channel.reservations).toEqual({});
  });

  it('refuses expired turns and escrow exhaustion independently of the turn ceiling', async () => {
    let executed = 0;
    await expect(localTurn({ expiresAtMs: 999 }).turn.invoke(call('expired'), () => { executed++; }))
      .rejects.toMatchObject({ code: 'expired' });
    await expect(localTurn({ channel: createMicrochargeChannel('channel-1', 200n) }).turn
      .invoke(call('unfunded'), () => { executed++; })).rejects.toMatchObject({ code: 'cap-exhausted' });
    expect(executed).toBe(0);
  });

  it('settles an entered handler that throws, preserves its error, and refuses nonce replay', async () => {
    const { turn } = localTurn();
    const failure = new Error('handler failed');
    await expect(turn.invoke(call('one'), () => { throw failure; })).rejects.toBe(failure);
    expect(turn.snapshot().channel.committedMicros).toBe(250n);
    let repeated = false;
    await expect(turn.invoke(call('one'), () => { repeated = true; })).rejects.toMatchObject({ code: 'duplicate-nonce' });
    expect(repeated).toBe(false);
  });

  it('recovers a failed receipt signer after restart without serving or charging the call twice', async () => {
    const { turn, stored } = localTurn({}, { signReceipt: () => { throw new Error('keychain unavailable'); } });
    let executions = 0;
    await expect(turn.invoke(call('one'), () => { executions++; })).rejects.toThrow('keychain unavailable');
    expect(stored()?.units.one?.completedAtMs).toBe(1_000);
    expect(stored()?.channel.reservations.one).toBe(250n);
    const restarted = localTurn(stored()!).turn;
    const receipt = await restarted.retrySettlement('one');
    expect(receipt.amountMicros).toBe(250n);
    expect(await restarted.retrySettlement('one')).toEqual(receipt);
    await expect(restarted.invoke(call('one'), () => { executions++; })).rejects.toMatchObject({ code: 'duplicate-nonce' });
    expect(executions).toBe(1);
    expect(restarted.snapshot().channel.committedMicros).toBe(250n);
  });

  it('blocks execution and further admission when reservation persistence has an unknown outcome', async () => {
    const { turn } = localTurn({}, { persist: async () => { throw new Error('local write failed'); } });
    let executions = 0;
    await expect(turn.invoke(call('one'), () => { executions++; })).rejects.toThrow('local write failed');
    await expect(turn.invoke(call('two'), () => { executions++; })).rejects.toMatchObject({ code: 'storage-unavailable' });
    expect(executions).toBe(0);
    expect(turn.snapshot().channel.reservations.one).toBe(250n);
  });

  it('keeps snapshots isolated and refuses inconsistent restored totals', async () => {
    const { turn } = localTurn();
    const snapshot = turn.snapshot();
    (snapshot.units as Record<string, unknown>).forged = {};
    expect(turn.snapshot().units).toEqual({});
    expect(() => localTurn({ reservedMicros: 250n })).toThrow('reservation total');
  });
});

function open(channel: MicrochargeChannel, u: BillableUnit = unit(), nowMs = 1_000) {
  return openMeteredInvocation({ channel, meter: meter(), unit: u, nowMs, signVoucher });
}

describe('exact identity closure', () => {
  function reserved() {
    const offer = identityPerUseOfferTerms({ identity: { id: 'analyst', version: '1.0.0' }, markupBps: 2500 });
    if (!offer.ok) throw new Error(offer.detail);
    const declared = declareMeter(offer.terms);
    if (!declared.ok) throw new Error(declared.detail);
    const opened = openMeteredInvocation({ channel: createMicrochargeChannel('identity-channel', 500n),
      meter: declared.meter, unit: unit({ releaseRef: offer.terms.skuRef, quantity: 1n }), nowMs: 1000, signVoucher });
    if (!opened.ok) throw new Error(opened.detail);
    return { opened, identityInference: { offer: offer.terms, billedInferenceMicros: 999n,
      inferenceCeilingMicros: 1000n, priorRemainderNumerator: 0n } };
  }
  it('signs exact billed micros and fixed time while retaining the reserved voucher quantity', () => {
    const { opened, identityInference } = reserved();
    let bytes = '';
    const closed = closeMeteredInvocation({ channel: opened.channel, voucher: opened.voucher,
      identityInference, occurredAtMs: 2000, signReceipt: (b) => { bytes = b.toString(); return 'signed'; } });
    expect(closed).toMatchObject({ ok: true, amountMicros: 249n, receipt: { meterQuantity: 1n, occurredAtMs: 2000 } });
    expect(JSON.parse(bytes)).toMatchObject({ amountMicros: '249', occurredAtMs: 2000, meterQuantity: '1' });
  });
  it('settles a verified zero-cost turn without quantizing it to a whole inference block', () => {
    const { opened, identityInference } = reserved();
    expect(closeMeteredInvocation({ channel: opened.channel, voucher: opened.voucher,
      identityInference: { ...identityInference, billedInferenceMicros: 0n }, occurredAtMs: 2000, signReceipt }))
      .toMatchObject({ ok: true, amountMicros: 0n });
  });
  it.each(['offer', 'ceiling', 'quantity', 'missing', 'cost', 'remainder'] as const)('refuses a changed %s binding', (change) => {
    const { opened, identityInference } = reserved();
    const exact = change === 'offer' ? { ...identityInference, offer: { ...identityInference.offer, skuRef: 'identity-release:other@1.0.0' } } :
      change === 'ceiling' ? { ...identityInference, inferenceCeilingMicros: 1001n } :
      change === 'cost' ? { ...identityInference, billedInferenceMicros: 1001n } :
      change === 'remainder' ? { ...identityInference, priorRemainderNumerator: 10000n } : identityInference;
    expect(closeMeteredInvocation({ channel: opened.channel, voucher: opened.voucher,
      ...(change === 'missing' ? {} : { identityInference: exact }),
      ...(change === 'quantity' ? { actualQuantity: 1n } : {}), occurredAtMs: 2000, signReceipt })).toMatchObject({ ok: false });
  });
});

describe('declareMeter', () => {
  it('accepts published per-use terms and converts the price to bigint micros', () => {
    const declared = declareMeter(TERMS);
    expect(declared.ok).toBe(true);
    if (!declared.ok) return;
    expect(declared.meter.unitPriceMicros).toBe(250n);
    expect(declared.meter.meterUnit).toBe('tool-call');
  });

  it.each([
    ['a non-sha256 split hash', { ...TERMS, splitManifestHash: 'deadbeef' }],
    ['a zero unit price', { ...TERMS, unitPriceMicros: 0 }],
    ['a blank meter unit', { ...TERMS, meterUnit: '  ' }],
    ['a blank price version', { ...TERMS, priceVersion: '' }],
    ['an unsafe integer price', { ...TERMS, unitPriceMicros: Number.MAX_SAFE_INTEGER + 2 }],
  ])('refuses %s so an unpriced unit can never be executed', (_label, terms) => {
    expect(declareMeter(terms)).toMatchObject({ ok: false, code: 'invalid-meter' });
  });
});

describe('metering interception on a billable unit', () => {
  it('binds payer, seller, release, nonce, quantity, price version and split hash into the reserved voucher', () => {
    const opened = open(createMicrochargeChannel('ch_1', 10_000n));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.voucher).toMatchObject({
      channelId: 'ch_1',
      payer: 'org_buyer',
      seller: 'gh:4242',
      releaseRef: 'sku:sentiment-tool@1.4.0',
      usageNonce: 'nonce-1',
      meterQuantity: 4n,
      pricePerUnitMicros: 250n,
      priceVersion: 'v3',
      splitManifestHash: TERMS.splitManifestHash,
      signature: expect.stringMatching(/^[A-Za-z0-9+/]{86}==$/),
    });
    // 4 units x 250 micros, reserved against a channel that had claimed nothing.
    expect(opened.voucher.cumulativeClaimMicros).toBe(1_000n);
    expect(opened.reservedMicros).toBe(1_000n);
    expect(opened.channel.reservations['nonce-1']).toBe(1_000n);
  });

  it('settles the served units into a signed usage receipt and commits the channel', () => {
    const opened = open(createMicrochargeChannel('ch_1', 10_000n));
    if (!opened.ok) throw new Error('reservation must open');
    const closed = closeMeteredInvocation({
      channel: opened.channel,
      voucher: opened.voucher,
      occurredAtMs: 2_000,
      signReceipt,
    });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.receipt).toMatchObject({
      channelId: 'ch_1',
      usageNonce: 'nonce-1',
      meterQuantity: 4n,
      amountMicros: 1_000n,
      occurredAtMs: 2_000,
      signature: 'seller-signature',
    });
    expect(closed.receipt.voucherDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(closed.channel.committedMicros).toBe(1_000n);
    expect(closed.channel.reservations['nonce-1']).toBeUndefined();
  });

  it('releases the unused reservation when fewer units were actually served', () => {
    const opened = open(createMicrochargeChannel('ch_1', 10_000n));
    if (!opened.ok) throw new Error('reservation must open');
    const closed = closeMeteredInvocation({
      channel: opened.channel,
      voucher: opened.voucher,
      actualQuantity: 1n,
      occurredAtMs: 2_000,
      signReceipt,
    });
    expect(closed).toMatchObject({ ok: true, amountMicros: 250n });
    if (!closed.ok) return;
    expect(closed.receipt.meterQuantity).toBe(1n);
    expect(closed.channel.committedMicros).toBe(250n);
  });

  it('signs a zero-served closure, releases the whole hold and prevents nonce reuse', () => {
    const opened = open(createMicrochargeChannel('ch_1', 10_000n));
    if (!opened.ok) throw new Error('reservation must open');
    const closed = closeMeteredInvocation({ channel: opened.channel, voucher: opened.voucher,
      actualQuantity: 0n, occurredAtMs: 2_000, signReceipt });
    expect(closed).toMatchObject({ ok: true, amountMicros: 0n,
      receipt: { meterQuantity: 0n, signature: 'seller-signature' },
      channel: { committedMicros: 0n, reservations: {} } });
    if (!closed.ok) throw new Error('zero closure must succeed');
    expect(open(closed.channel)).toMatchObject({ ok: false, code: 'duplicate-nonce' });
    expect(closeMeteredInvocation({ channel: opened.channel, voucher: opened.voucher,
      actualQuantity: -1n, occurredAtMs: 2_000, signReceipt })).toMatchObject({ ok: false, code: 'invalid-unit' });
  });

  it('refuses to settle more units than were reserved', () => {
    const opened = open(createMicrochargeChannel('ch_1', 10_000n));
    if (!opened.ok) throw new Error('reservation must open');
    expect(
      closeMeteredInvocation({
        channel: opened.channel,
        voucher: opened.voucher,
        actualQuantity: 5n,
        occurredAtMs: 2_000,
        signReceipt,
      }),
    ).toMatchObject({ ok: false, code: 'actual-exceeds-reservation' });
  });

  it('refuses a DUPLICATE NONCE on both the reserved and the settled path', () => {
    const opened = open(createMicrochargeChannel('ch_1', 10_000n));
    if (!opened.ok) throw new Error('reservation must open');
    // Still reserved.
    expect(open(opened.channel, unit({ usageNonce: 'nonce-1' }))).toMatchObject({
      ok: false,
      code: 'duplicate-nonce',
    });
    const closed = closeMeteredInvocation({
      channel: opened.channel,
      voucher: opened.voucher,
      occurredAtMs: 2_000,
      signReceipt,
    });
    if (!closed.ok) throw new Error('settlement must close');
    // Already settled — the receipt is the durable replay guard.
    expect(open(closed.channel, unit({ usageNonce: 'nonce-1' }))).toMatchObject({
      ok: false,
      code: 'duplicate-nonce',
    });
  });

  it('refuses when the channel CAP is exhausted rather than serving on credit', () => {
    // Escrow covers three units at 250; the unit asks for four.
    const refused = open(createMicrochargeChannel('ch_small', 750n));
    expect(refused).toMatchObject({ ok: false, code: 'cap-exhausted' });
  });

  it('refuses cap exhaustion cumulatively, after earlier units have committed', () => {
    let channel = createMicrochargeChannel('ch_small', 1_500n);
    const first = open(channel, unit({ usageNonce: 'n-1', quantity: 4n }));
    if (!first.ok) throw new Error('first unit must reserve');
    const settled = closeMeteredInvocation({
      channel: first.channel,
      voucher: first.voucher,
      occurredAtMs: 2_000,
      signReceipt,
    });
    if (!settled.ok) throw new Error('first unit must settle');
    channel = settled.channel;
    expect(channel.committedMicros).toBe(1_000n);
    // 500 micros of headroom left; two more units (500) fit, three do not.
    expect(open(channel, unit({ usageNonce: 'n-2', quantity: 3n }))).toMatchObject({
      ok: false,
      code: 'cap-exhausted',
    });
    expect(open(channel, unit({ usageNonce: 'n-3', quantity: 2n })).ok).toBe(true);
  });

  it('refuses a CUMULATIVE REGRESSION when a payer replays a claim built on a stale channel view', () => {
    const stale = createMicrochargeChannel('ch_1', 10_000n);
    const first = open(stale, unit({ usageNonce: 'n-1' }));
    if (!first.ok) throw new Error('first unit must reserve');

    // The payer signs a SECOND unit against its stale pre-reservation view, so
    // the claim repeats a cumulative total the channel has already advanced past.
    const replayed = signPaymentTestVoucher({
      ...buildUsageVoucher(stale, meter(), unit({ usageNonce: 'n-2' })),
      signature: '',
    });
    expect(replayed.cumulativeClaimMicros).toBe(first.voucher.cumulativeClaimMicros);

    expect(
      acceptMeteredVoucher({
        verifySignature: paymentTestVerifier('ch_1', 'org_buyer'),
        channel: first.channel,
        meter: meter(),
        unit: unit({ usageNonce: 'n-2' }),
        voucher: replayed,
        nowMs: 1_000,
      }),
    ).toMatchObject({ ok: false, code: 'cumulative-regression' });
  });

  it('settling a nonce that was never reserved is refused rather than minting a receipt', () => {
    const opened = open(createMicrochargeChannel('ch_1', 10_000n));
    if (!opened.ok) throw new Error('reservation must open');
    expect(
      closeMeteredInvocation({
        channel: opened.channel,
        voucher: { ...opened.voucher, usageNonce: 'never-reserved' },
        occurredAtMs: 2_000,
        signReceipt,
      }),
    ).toMatchObject({ ok: false, code: 'unknown-reservation' });
  });

  it('re-derives a wire voucher against the DECLARED meter and refuses forged terms', () => {
    const channel = createMicrochargeChannel('ch_1', 10_000n);
    const honest = signPaymentTestVoucher({ ...buildUsageVoucher(channel, meter(), unit()), signature: '' });
    expect(acceptMeteredVoucher({
        verifySignature: paymentTestVerifier('ch_1', 'org_buyer'), channel, meter: meter(), unit: unit(), voucher: honest, nowMs: 1_000 }).ok).toBe(true);

    for (const [label, forged] of [
      ['a discounted unit price', { ...honest, pricePerUnitMicros: 1n }],
      ['an older price version', { ...honest, priceVersion: 'v1' }],
      ['a different split manifest', { ...honest, splitManifestHash: `sha256:${'b'.repeat(64)}` }],
      ['an inflated quantity', { ...honest, meterQuantity: 40n }],
      ['a substituted seller', { ...honest, seller: 'gh:9999' }],
    ] as const) {
      expect(
        acceptMeteredVoucher({
        verifySignature: paymentTestVerifier('ch_1', 'org_buyer'), channel, meter: meter(), unit: unit(), voucher: forged, nowMs: 1_000 }),
        label,
      ).toMatchObject({ ok: false, code: 'terms-mismatch' });
    }

    expect(
      acceptMeteredVoucher({
        channel,
        meter: meter(),
        unit: unit(),
        voucher: honest,
        nowMs: 1_000,
        verifySignature: () => false,
      }),
    ).toMatchObject({ ok: false, code: 'invalid-voucher' });
  });

  it('refuses omitted and throwing authentication before reserving a real signed voucher', () => {
    const channel = createMicrochargeChannel('ch_1', 10_000n);
    const honest = signPaymentTestVoucher({ ...buildUsageVoucher(channel, meter(), unit()), signature: '' });
    const input = { channel, meter: meter(), unit: unit(), voucher: honest, nowMs: 1_000 };
    expect(acceptMeteredVoucher(input)).toMatchObject({ ok: false, code: 'invalid-voucher' });
    expect(acceptMeteredVoucher({ ...input, verifySignature: () => { throw new Error('unavailable authority'); } }))
      .toMatchObject({ ok: false, code: 'invalid-voucher' });
    expect(channel.reservations).toEqual({});
  });

  it('refuses an expired voucher at the interception point', () => {
    expect(open(createMicrochargeChannel('ch_1', 10_000n), unit(), 20_000)).toMatchObject({
      ok: false,
      code: 'expired',
    });
  });

  it.each([
    ['a blank payer', unit({ payer: ' ' })],
    ['a blank seller', unit({ seller: '' })],
    ['a blank release ref', unit({ releaseRef: '' })],
    ['a blank usage nonce', unit({ usageNonce: '' })],
    ['a non-positive quantity', unit({ quantity: 0n })],
  ])('refuses %s before any voucher is signed', (_label, u) => {
    expect(open(createMicrochargeChannel('ch_1', 10_000n), u)).toMatchObject({
      ok: false,
      code: 'invalid-unit',
    });
  });

  it('refuses when a signer returns nothing rather than emitting an unsigned voucher or receipt', () => {
    expect(
      openMeteredInvocation({
        channel: createMicrochargeChannel('ch_1', 10_000n),
        meter: meter(),
        unit: unit(),
        nowMs: 1_000,
        signVoucher: () => '   ',
      }),
    ).toMatchObject({ ok: false, code: 'unsigned-voucher' });

    const opened = open(createMicrochargeChannel('ch_1', 10_000n));
    if (!opened.ok) throw new Error('reservation must open');
    expect(
      closeMeteredInvocation({
        channel: opened.channel,
        voucher: opened.voucher,
        occurredAtMs: 2_000,
        signReceipt: () => '',
      }),
    ).toMatchObject({ ok: false, code: 'unsigned-receipt' });
  });

  it('signs the receipt over canonical bytes that carry the voucher digest', () => {
    const opened = open(createMicrochargeChannel('ch_1', 10_000n));
    if (!opened.ok) throw new Error('reservation must open');
    let signed: string | null = null;
    const closed = closeMeteredInvocation({
      channel: opened.channel,
      voucher: opened.voucher,
      occurredAtMs: 2_000,
      signReceipt: (bytes) => {
        signed = bytes.toString('utf8');
        return 'seller-signature';
      },
    });
    if (!closed.ok) throw new Error('settlement must close');
    expect(signed).not.toBeNull();
    expect(signed as unknown as string).toContain(closed.receipt.voucherDigest);
    expect(
      usageReceiptSigningBytes({
        channelId: closed.receipt.channelId,
        usageNonce: closed.receipt.usageNonce,
        meterQuantity: closed.receipt.meterQuantity,
        amountMicros: closed.receipt.amountMicros,
        voucherDigest: closed.receipt.voucherDigest,
        occurredAtMs: closed.receipt.occurredAtMs,
      }).toString('utf8'),
    ).toBe(signed as unknown as string);
  });

  it('records the served units on the metering ledger as part of settlement', () => {
    const opened = open(createMicrochargeChannel('ch_1', 10_000n));
    if (!opened.ok) throw new Error('reservation must open');
    const closed = closeMeteredInvocation({
      channel: opened.channel,
      voucher: opened.voucher,
      occurredAtMs: 2_000,
      signReceipt,
      metering: {
        ledger: emptyMeteringLedger(),
        served: {
          hostRef: 'host-a',
          fleetSlug: 'fleet-a',
          axis: 'remote',
          unit: 'tokens',
          attestedUserId: 'user-1',
          perUserContributionCap: 3,
        },
      },
    });
    expect(closed.ok).toBe(true);
    if (!closed.ok || !closed.metering) return;
    expect(spentOn(closed.metering, 'host-a', 'fleet-a', 'remote')).toBe(4);
    // M22: the per-user cap clamps the reciprocity credit, not the served spend.
    expect(contributionOf(closed.metering, 'user-1', 'remote')).toBe(3);
    expect(closed.contributionCredited).toBe(3);
  });

  it('refuses when the metering ledger refuses the served units (H14 unit discipline)', () => {
    const seeded = closeMeteredInvocation({
      channel: (() => {
        const o = open(createMicrochargeChannel('ch_1', 10_000n), unit({ usageNonce: 'n-1' }));
        if (!o.ok) throw new Error('reservation must open');
        return o.channel;
      })(),
      voucher: (() => {
        const o = open(createMicrochargeChannel('ch_1', 10_000n), unit({ usageNonce: 'n-1' }));
        if (!o.ok) throw new Error('reservation must open');
        return o.voucher;
      })(),
      occurredAtMs: 2_000,
      signReceipt,
      metering: {
        ledger: emptyMeteringLedger(),
        served: { hostRef: 'host-a', fleetSlug: 'fleet-a', axis: 'remote', unit: 'tokens' },
      },
    });
    if (!seeded.ok || !seeded.metering) throw new Error('seed settlement must close');

    const opened = open(createMicrochargeChannel('ch_2', 10_000n), unit({ usageNonce: 'n-2' }));
    if (!opened.ok) throw new Error('reservation must open');
    expect(
      closeMeteredInvocation({
        channel: opened.channel,
        voucher: opened.voucher,
        occurredAtMs: 2_000,
        signReceipt,
        metering: {
          ledger: seeded.metering,
          served: { hostRef: 'host-a', fleetSlug: 'fleet-a', axis: 'remote', unit: 'slots' },
        },
      }),
    ).toMatchObject({ ok: false, code: 'metering-refused' });
  });

  it('quotes a unit price without floating point', () => {
    expect(quoteMicros(meter(), 7n)).toBe(1_750n);
  });
});

describe('BYOC honor path (P-017) under a per-use meter', () => {
  const base = {
    hostRef: 'host-a',
    fleetSlug: 'fleet-a',
    axis: 'remote' as const,
    unit: 'usd-micros' as const,
    billedAmount: 10,
    reservationId: 'call-1',
    billingMode: 'host-pays' as const,
  };

  it('reserves the microcharge before execution and settles a receipt after it', () => {
    const budget = createByocBudget({ cap: 100, maxPerCall: 50, unit: 'usd-micros' });
    const prepared = prepareByocExecution({
      budget,
      context: base,
      microcharge: {
        channel: createMicrochargeChannel('ch_byoc', 10_000n),
        meter: meter(),
        unit: unit(),
        nowMs: 1_000,
        signVoucher,
      },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok || !prepared.microcharge) throw new Error('honor path must reserve a microcharge');
    expect(prepared.microcharge.reservedMicros).toBe(1_000n);

    const settled = settleByocExecution({
      budget: prepared.ledger,
      metering: emptyMeteringLedger(),
      context: base,
      actualAmount: 7,
      microcharge: {
        channel: prepared.microcharge.channel,
        voucher: prepared.microcharge.voucher,
        occurredAtMs: 2_000,
        signReceipt,
      },
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok || !settled.microcharge) throw new Error('honor path must settle a microcharge');
    expect(settled.microcharge.receipt).toMatchObject({ usageNonce: 'nonce-1', meterQuantity: 4n, amountMicros: 1_000n });
    expect(settled.microcharge.channel.committedMicros).toBe(1_000n);
    // The budget commit is what records the served units; the microcharge leg
    // must not double-count them.
    expect(spentOn(settled.metering, 'host-a', 'fleet-a', 'remote')).toBe(7);
  });

  it('refuses the whole call when the channel cap is exhausted, without drawing the local budget', () => {
    const budget = createByocBudget({ cap: 100, maxPerCall: 50, unit: 'usd-micros' });
    const refused = prepareByocExecution({
      budget,
      context: base,
      microcharge: {
        channel: createMicrochargeChannel('ch_byoc', 750n),
        meter: meter(),
        unit: unit(),
        nowMs: 1_000,
        signVoucher,
      },
    });
    expect(refused).toMatchObject({ ok: false, code: 'cap-exhausted' });
    // The pure reserve never mutates: the caller's budget is untouched.
    expect(budget).toEqual(createByocBudget({ cap: 100, maxPerCall: 50, unit: 'usd-micros' }));
  });

  it('is unchanged when no meter is declared — the free/allowance honor path keeps its shape', () => {
    const budget = createByocBudget({ cap: 100, maxPerCall: 50, unit: 'usd-micros' });
    const prepared = prepareByocExecution({ budget, context: base });
    expect(prepared).toMatchObject({ ok: true, relay: 'local-only' });
    if (!prepared.ok) return;
    expect(prepared.microcharge).toBeUndefined();
    const settled = settleByocExecution({
      budget: prepared.ledger,
      metering: emptyMeteringLedger(),
      context: base,
      actualAmount: 7,
    });
    expect(settled).toMatchObject({ ok: true, committedAmount: 7 });
    if (!settled.ok) return;
    expect(settled.microcharge).toBeUndefined();
  });
});
