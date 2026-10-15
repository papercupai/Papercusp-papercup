/**
 * P-005: Z3 integer safety obligations plus bounded production conformance.
 * These prove the stated abstract transitions, not arbitrary host/DB/crypto code.
 * The exact scope, induction assumptions and replay command live in the plan's
 * security matrix. This ordinary Vitest file is enrolled in test:affected.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { init, killThreads } from 'z3-solver';
import { reduceGovernanceVotes, type VotingEvent } from '../agent-tools/plans/governance-voting';
import { createGovernanceRound, finalizeGovernanceRound } from '../agent-tools/plans/governance-round';
import { DEFAULT_PLAN_ADMISSION_POLICY } from '../agent-tools/plans/plan-admission-policy';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../identity/ed25519';
import {
  createMicrochargeChannel, paymentVoucherSigningBytes, reserveMicrocharge,
  settleMicrocharge, verifyPaymentVoucherSignature, type CumulativePaymentVoucher,
} from './microcharge';
import { createPaymentChannel, settleVoucherBatch } from './payment-channel';

let api: Awaited<ReturnType<typeof init>>;
beforeAll(async () => {
  api = await init();
  console.info('Pinned z3-solver 5.2.0; embedded Z3', api.Z3.get_version());
}, 30_000);
afterAll(async () => { if (api) await killThreads(api.em); }, 10_000);

/** SAT and UNKNOWN both fail the proof; a counterexample is never a pass. */
async function assertUnreachable(solver: {
  check(): Promise<'sat' | 'unsat' | 'unknown'>;
  model(): { toString(): string };
}): Promise<void> {
  const result = await solver.check();
  if (result !== 'unsat') {
    throw new Error(`Safety obligation ${result}: ${result === 'sat' ? solver.model().toString() : 'no proof'}`);
  }
}

describe('machine-checked voting and P2P safety (Z3 5.2.0)', () => {
  it('proves conservation when each eligible weight enters exactly one bucket', async () => {
    const { Solver, Int, Or, If } = new api.Context('weight-conservation');
    const s = new Solver(); s.set('timeout', 10_000);
    const a = Int.const('approve'), r = Int.const('reject'), b = Int.const('abstain');
    const n = Int.const('unrepresented'), total = Int.const('total'), w = Int.const('weight');
    s.add(a.ge(0), r.ge(0), b.ge(0), n.ge(0), w.gt(0), total.eq(a.add(r).add(b).add(n)));
    // One arbitrary induction step. The initial state is all zero. A resolved
    // eligible member adds its weight to exactly one of the four buckets.
    const bucket = Int.const('bucket');
    s.add(bucket.ge(0), bucket.le(3));
    expect(await s.check()).toBe('sat');
    const next = [a, r, b, n].map((v, i) => v.add(If(bucket.eq(i), w, Int.val(0))));
    s.add(Or(next[0]!.add(next[1]!).add(next[2]!).add(next[3]!).neq(total.add(w)),
      next[0]!.add(next[1]!).add(next[2]!).gt(total.add(w))));
    await assertUnreachable(s);
  });

  it('proves a replacement moves weight without increasing participation', async () => {
    const { Solver, Int, Or } = new api.Context('replacement');
    const s = new Solver(); s.set('timeout', 10_000);
    const a = Int.const('approve'), r = Int.const('reject'), b = Int.const('abstain'), w = Int.const('weight');
    s.add(a.ge(0), b.ge(0), w.gt(0), r.ge(w));
    expect(await s.check()).toBe('sat');
    const nextA = a.add(w), nextR = r.sub(w);
    s.add(Or(nextA.add(nextR).add(b).neq(a.add(r).add(b)), nextR.lt(0)));
    await assertUnreachable(s);
  });

  it('proves admitted thresholds exclude ties, missing quorum and insufficient approval', async () => {
    const { Solver, Int, And, Or, Not } = new api.Context('thresholds');
    const s = new Solver(); s.set('timeout', 10_000);
    const a = Int.const('approve'), r = Int.const('reject'), b = Int.const('abstain');
    const e = Int.const('eligible'), q = Int.const('quorumBps'), p = Int.const('approvalBps');
    s.add(a.ge(0), r.ge(0), b.ge(0), e.gt(0), a.add(r).add(b).le(e),
      q.ge(0), q.le(10_000), p.ge(0), p.le(10_000));
    const participation = a.add(r).add(b), cast = a.add(r);
    const admitted = And(participation.mul(10_000).ge(e.mul(q)), cast.gt(0),
      a.gt(r), a.mul(10_000).ge(cast.mul(p)));
    s.add(admitted);
    expect(await s.check()).toBe('sat');
    s.add(Or(a.le(r), participation.mul(10_000).lt(e.mul(q)),
      a.mul(10_000).lt(cast.mul(p)), Not(cast.gt(0))));
    await assertUnreachable(s);
  });

  it('proves reserve and settle preserve escrow including outstanding reservations', async () => {
    const { Solver, Int, Or } = new api.Context('escrow-induction');
    const s = new Solver(); s.set('timeout', 10_000);
    const cap = Int.const('cap'), committed = Int.const('committed'), held = Int.const('held');
    const delta = Int.const('delta'), reserved = Int.const('reserved'), actual = Int.const('actual');
    s.add(cap.ge(0), committed.ge(0), held.ge(0), committed.add(held).le(cap));
    // Reserve precondition in reserveMicrocharge. Zero is the initial state.
    s.push();
    s.add(delta.gt(0), committed.add(held).add(delta).le(cap));
    expect(await s.check()).toBe('sat');
    s.add(Or(held.add(delta).lt(0), committed.add(held).add(delta).gt(cap)));
    await assertUnreachable(s); s.pop();
    // Settle transfers actual <= reserved and releases the unused remainder.
    s.add(reserved.ge(0), reserved.le(held), actual.ge(0), actual.le(reserved));
    expect(await s.check()).toBe('sat');
    s.add(Or(held.sub(reserved).lt(0), committed.add(actual).add(held.sub(reserved)).gt(cap)));
    await assertUnreachable(s);
  });

  it('rejects the known omitted-reservation counterexample and an unknown solver result', async () => {
    const { Solver, Int } = new api.Context('counterexample-control');
    const s = new Solver(); s.set('timeout', 10_000);
    const cap = Int.const('cap'), committed = Int.const('committed'), held = Int.const('held'), delta = Int.const('delta');
    // Historical defect: reserve checks committed alone, omitting held units.
    s.add(cap.eq(2), committed.eq(0), held.eq(2), delta.eq(1),
      committed.add(delta).le(cap), committed.add(held).add(delta).gt(cap));
    await expect(assertUnreachable(s)).rejects.toThrow('Safety obligation sat');
    await expect(assertUnreachable({ check: async () => 'unknown', model: () => ({ toString: () => '' }) }))
      .rejects.toThrow('Safety obligation unknown');
  });
});

describe('bounded production conformance (explicit finite domains)', () => {
  it('checks all 3-member delegation graphs and four terminal ballot choices with replacement', () => {
    const ids = ['a', 'b', 'c']; const weights = [2, 3, 5];
    const choices = ['approve', 'reject', 'abstain'] as const;
    for (let graph = 0; graph < 27; graph++) {
      const targets = ids.map((_, i) => Math.floor(graph / 3 ** i) % 3);
      const terminals = ids.map((_, start) => {
        let at = start; const seen = new Set<number>();
        while (targets[at] !== at) {
          if (seen.has(at)) return -1;
          seen.add(at); at = targets[at]!;
        }
        return at;
      });
      for (let ballots = 0; ballots < 64; ballots++) {
        const selected = ids.map((_, i) => Math.floor(ballots / 4 ** i) % 4);
        const events: VotingEvent[] = ids.flatMap((memberId, i) => selected[i] === 3 ? [] : [
          { memberId, choice: 'reject' as const, sequence: 1, keyEpoch: 1 },
          { memberId, choice: choices[selected[i]!]!, sequence: 2, keyEpoch: 1 },
        ]);
        const result = reduceGovernanceVotes({
          members: ids.map((memberId, i) => ({ memberId, weight: weights[i]!, keyEpoch: 1 })),
          delegations: ids.flatMap((from, i) => targets[i] === i ? [] : [{ from, to: ids[targets[i]!]!, epoch: 1 }]),
          events, nowMs: 0,
        });
        if (terminals.includes(-1)) {
          expect(result).toMatchObject({ ok: false, code: 'delegation-cycle' }); continue;
        }
        expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.detail);
        const buckets = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          const ballot = selected[terminals[i]!]!;
          if (ballot < 3) buckets[ballot] = buckets[ballot]! + weights[i]!;
        }
        expect(result.value).toEqual({ approveWeight: buckets[0], rejectWeight: buckets[1],
          abstainWeight: buckets[2], totalEligibleWeight: 10,
          participatingWeight: buckets.reduce((sum, w) => sum + w, 0),
          replacements: selected.filter(choice => choice < 3).length });
      }
    }
  });

  it('matches exact threshold arithmetic for weights 0..3 and five BPS boundaries', () => {
    const bps = [0, 3333, 5000, 6667, 10_000];
    for (let a = 0; a <= 3; a++) for (let r = 0; r <= 3; r++) for (let b = 0; b <= 3; b++) {
      const eligible = a + r + b; if (!eligible) continue;
      const members = [{ memberId: 'a', weight: a }, { memberId: 'r', weight: r }, { memberId: 'b', weight: b }]
        .filter(m => m.weight > 0);
      const round = createGovernanceRound({ roundId: 'round', planRevisionHash: 'revision', policyVersion: 1,
        eligibleMemberIds: members.map(m => m.memberId), createdAtMs: 0 });
      if (!round.ok) throw new Error(round.detail);
      for (const abstainVotes of [false, true]) {
      const events = members.filter(m => m.memberId !== 'b' || abstainVotes).map(m => ({ eventId: m.memberId,
        roundId: 'round', memberId: m.memberId, choice: m.memberId === 'a' ? 'approve' as const : 'reject' as const,
        sequence: 1, signature: 'already-authenticated-at-admission' }))
        .map(e => e.memberId === 'b' ? { ...e, choice: 'abstain' as const } : e);
      for (const q of bps) for (const p of bps) {
        const result = finalizeGovernanceRound({ round: round.value, members, events, nowMs: 1,
          policy: { ...DEFAULT_PLAN_ADMISSION_POLICY, quorumBps: q, approvalBps: p } });
        expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.detail);
        const cast = BigInt(a + r);
        const expected = BigInt(a + r + (abstainVotes ? b : 0)) * 10_000n >= BigInt(eligible) * BigInt(q) &&
          a > r && BigInt(a) * 10_000n >= cast * BigInt(p);
        expect(result.value.admitted).toBe(expected);
      }
      }
    }
  });

  it('checks reachable signed reserve/settle/replay traces to depth 4 with escrow 3', () => {
    const key = generateEd25519KeypairDer();
    const authority = { channelId: 'proof-channel', payer: 'payer', pubkeyBase64: key.pubkeyBase64 };
    const voucher = (nonce: string, cumulative: bigint): CumulativePaymentVoucher => {
      const unsigned = { channelId: authority.channelId, payer: authority.payer, seller: 'seller', releaseRef: 'release',
        usageNonce: nonce, meterQuantity: 1n, pricePerUnitMicros: 1n, priceVersion: 'v1',
        splitManifestHash: 'split', expiresAtMs: 100, cumulativeClaimMicros: cumulative };
      return { ...unsigned, signature: signWithPrivateKeyDer(key.privateKeyDer, paymentVoucherSigningBytes(unsigned)).toString('base64') };
    };
    type State = { channel: ReturnType<typeof createMicrochargeChannel>; vouchers: Record<string, CumulativePaymentVoucher> };
    let frontier: State[] = [{ channel: createMicrochargeChannel(authority.channelId, 3n), vouchers: {} }];
    for (let depth = 0; depth < 4; depth++) {
      const next: State[] = [];
      for (const state of frontier) {
        for (const delta of [1n, 2n]) {
          const v = voucher(`nonce-${depth}`, state.channel.lastCumulativeMicros + delta);
          expect(verifyPaymentVoucherSignature(v, authority)).toBe(true);
          const result = reserveMicrocharge(state.channel, v, 1);
          const held = Object.values(state.channel.reservations).reduce((sum, amount) => sum + amount, 0n);
          expect(result.ok).toBe(state.channel.committedMicros + held + delta <= 3n);
          if (result.ok) next.push({ channel: result.channel, vouchers: { ...state.vouchers, [v.usageNonce]: v } });
        }
        for (const [nonce, reserved] of Object.entries(state.channel.reservations)) {
          const v = state.vouchers[nonce]!;
          for (let actual = 0n; actual <= reserved; actual++) {
            const result = settleMicrocharge({ channel: state.channel, voucher: v, actualAmountMicros: actual,
              occurredAtMs: 1, receiptSignature: 'trusted-seller-receipt-precondition' });
            expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.detail);
            expect(reserveMicrocharge(result.channel, v, 1)).toMatchObject({ ok: false, code: 'duplicate-nonce' });
            expect(settleMicrocharge({ channel: result.channel, voucher: v, occurredAtMs: 1, receiptSignature: 'receipt' }))
              .toMatchObject({ ok: false, code: 'unknown-reservation' });
            next.push({ channel: result.channel, vouchers: state.vouchers });
          }
        }
      }
      for (const state of next) {
        const held = Object.values(state.channel.reservations).reduce((sum, amount) => sum + amount, 0n);
        expect(state.channel.committedMicros).toBeGreaterThanOrEqual(0n);
        expect(state.channel.committedMicros + held).toBeLessThanOrEqual(3n);
      }
      frontier = next;
    }
    const v = voucher('batch', 2n), channel = createPaymentChannel(authority.channelId, 'custom', 3n);
    const verifySignature = (candidate: CumulativePaymentVoucher) => verifyPaymentVoucherSignature(candidate, authority);
    const settled = settleVoucherBatch({ channel, vouchers: [v], nowMs: 1, verifySignature });
    expect(settled).toMatchObject({ ok: true, claimMicros: 2n });
    expect(settleVoucherBatch({ channel, vouchers: [v], nowMs: 1 })).toMatchObject({ ok: false, code: 'invalid-signature' });
    expect(settleVoucherBatch({ channel, vouchers: [{ ...v, cumulativeClaimMicros: 3n }], nowMs: 1, verifySignature }))
      .toMatchObject({ ok: false, code: 'invalid-signature' });
    if (!settled.ok) throw new Error(settled.detail);
    expect(settleVoucherBatch({ channel: settled.channel, vouchers: [v], nowMs: 1, verifySignature }))
      .toMatchObject({ ok: false, code: 'duplicate-claim' });
  });
});
