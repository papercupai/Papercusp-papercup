import { describe, it, expect } from 'vitest';
import { zeroAddress, zeroHash, type Hex } from 'viem';
import { equityV2Evm, artifacts, digest, TERMS, V2_ADMIN } from './evm-test-helpers';
import { EQUITY_V2_FUNCTION_CLASSES } from './v2-function-classes';
import { prepareEquityTransaction } from './runtime';

// dao-hr-people-2026-10-11 P-004 (bar R-3, D-004, D-008): real signed Cancun EVM transactions.
const DAY = 86_400n;
const UNRELATED = 5;
type GrantRow = readonly [bigint, bigint, bigint, number, number, number, number];

async function hired() {
  const e = await equityV2Evm(); const t = e.equity;
  await e.register(1); await e.register(2);
  const g1 = digest('grant-1'); const g2 = digest('grant-2');
  const start = e.now();
  await e.govern([
    { contract: t, name: 'commitGrant', args: [g1, e.accounts[1], 10_000n, start, start, start + 100n * DAY] },
    { contract: t, name: 'commitGrant', args: [g2, e.accounts[2], 20_000n, start, start, start + 200n * DAY] },
  ]);
  const grant = async (id: Hex) => await e.read(t, 'grants', [id]) as GrantRow;
  const earned = async (id: Hex) => await e.read(t, 'earnedGrant', [id]) as bigint;
  return { e, t, g1, g2, start, grant, earned };
}

describe('SPEC-P-004 — the bounded admin functions refuse every non-admin caller', () => {
  it('admin functions revert for the issuer, a holder, an unrelated account and the governance executor', async () => {
    const { e, t, g1, grant } = await hired();
    const calls: Array<[string, unknown[]]> = [['setGrantLimit', [50_000n]], ['setReturnPolicy', [500, 30 * 86400]],
      ['raiseGrant', [g1, 11_000n]], ['triggerPayout', [digest('p')]], ['transferAdmin', [e.accounts[6]]]];
    for (const [name, args] of calls) {
      for (const sender of [0, 1, UNRELATED]) await expect(e.send(t, name, args, sender)).rejects.toThrow('Forbidden');
      await expect(e.callAs(e.timelock.address, t, name, args)).rejects.toThrow('Forbidden');
    }
    expect(await e.read(t, 'grantLimit')).toBe(100_000n);
    expect(await e.read(t, 'returnRateBps')).toBe(0);
    expect((await grant(g1))[1]).toBe(10_000n);
    expect(await e.read(t, 'admin')).toBe(e.accounts[V2_ADMIN]);
  }, 120_000);

  it('the governor refuses a proposal for any admin function, so routine operations never go to a vote', async () => {
    const { e, t, g1 } = await hired();
    for (const [name, args] of [['setGrantLimit', [50_000n]], ['setReturnPolicy', [500, 30 * 86400]], ['raiseGrant', [g1, 11_000n]],
      ['triggerPayout', [digest('p')]], ['resignGrant', [g1]]] as Array<[string, unknown[]]>) {
      await expect(e.propose([{ contract: t, name, args }], 'vote on ' + name)).rejects.toThrow('UnsupportedAction');
    }
  }, 120_000);
});

describe('SPEC-P-004-A — only the governance executor stops a grant', () => {
  it('admin-account: an admin stopGrant is reverted and the grant keeps vesting', async () => {
    const { e, t, g1, grant, earned } = await hired();
    await expect(e.send(t, 'stopGrant', [g1], V2_ADMIN)).rejects.toThrow('Forbidden');
    const before = await earned(g1); e.advance(5 * 86400);
    expect((await grant(g1))[6]).toBe(0);
    expect(await earned(g1)).toBeGreaterThan(before);
  }, 120_000);
  it('unrelated-account: an unrelated stopGrant is reverted and the grant keeps vesting', async () => {
    const { e, t, g1, grant } = await hired();
    for (const sender of [UNRELATED, 2]) await expect(e.send(t, 'stopGrant', [g1], sender)).rejects.toThrow('Forbidden');
    expect((await grant(g1))[6]).toBe(0);
  }, 120_000);
  it('governance executor: a fire proposal stops the grant and earned equity stays', async () => {
    const { e, t, g1, grant, earned } = await hired();
    e.advance(30 * 86400);
    await e.govern([{ contract: t, name: 'stopGrant', args: [g1] }]);
    const row = await grant(g1); const kept = await earned(g1);
    expect(row[6]).toBeGreaterThan(0);
    expect(kept).toBe(10_000n * (BigInt(row[6]) - BigInt(row[3])) / (100n * DAY));
    e.advance(200 * 86400);
    expect(await earned(g1)).toBe(kept);
  }, 120_000);
});

describe('SPEC-P-004-B — only the governance executor registers a holder', () => {
  it('admin-account: an admin registerHolder is reverted', async () => {
    const { e, t } = await hired();
    await expect(e.send(t, 'registerHolder', [e.accounts[3], digest('h3')], V2_ADMIN)).rejects.toThrow('Forbidden');
    expect(await e.read(t, 'memberId', [e.accounts[3]])).toBe(0n);
    expect(await e.read(t, 'holderCount')).toBe(3n);
  }, 120_000);
  it('unrelated-account: an unrelated registerHolder is reverted', async () => {
    const { e, t } = await hired();
    for (const sender of [UNRELATED, 1]) await expect(e.send(t, 'registerHolder', [e.accounts[3], digest('h3')], sender)).rejects.toThrow('Forbidden');
    expect(await e.read(t, 'holderCount')).toBe(3n);
  }, 120_000);
  it('governance executor: a hire proposal registers the holder', async () => {
    const { e, t } = await hired();
    await e.govern([{ contract: t, name: 'registerHolder', args: [e.accounts[3], digest('h3')] }]);
    expect(await e.read(t, 'memberId', [e.accounts[3]])).toBe(4n);
  }, 120_000);
});

describe('SPEC-P-004-C — only the governance executor creates a grant', () => {
  const args = (e: Awaited<ReturnType<typeof hired>>['e']) => [digest('new-grant'), e.accounts[1], 1_000n, e.now(), e.now(), e.now() + 100n * DAY];
  it('admin-account: an admin commitGrant is reverted', async () => {
    const { e, t, grant } = await hired();
    await expect(e.send(t, 'commitGrant', args(e), V2_ADMIN)).rejects.toThrow('Forbidden');
    expect((await grant(digest('new-grant')))[0]).toBe(0n);
  }, 120_000);
  it('unrelated-account: an unrelated commitGrant is reverted', async () => {
    const { e, t, grant } = await hired();
    for (const sender of [UNRELATED, 1]) await expect(e.send(t, 'commitGrant', args(e), sender)).rejects.toThrow('Forbidden');
    expect((await grant(digest('new-grant')))[0]).toBe(0n);
  }, 120_000);
  it('governance executor: a hire proposal commits the grant', async () => {
    const { e, t, grant } = await hired();
    await e.govern([{ contract: t, name: 'commitGrant', args: args(e) }]);
    expect((await grant(digest('new-grant')))[1]).toBe(1_000n);
  }, 120_000);
});

describe('P007 — a hire reserves the grant before candidate acceptance', () => {
  it('one member proposal registers and commits; only the candidate acceptance enables claiming', async () => {
    const e = await equityV2Evm(), t = e.equity, id = digest('signed-hire-document');
    const start = e.now();
    await e.govern([
      { contract: t, name: 'registerHolder', args: [e.accounts[1], digest('candidate-identity')] },
      { contract: t, name: 'commitGrant', args: [id, e.accounts[1], 10_000n, start, start, start + 100n * DAY] },
    ]);
    expect((await e.read(t, 'holders', [2n]) as readonly unknown[])[3]).toBe(false);
    expect((await e.read(t, 'grants', [id]) as GrantRow)[0]).toBe(2n);
    expect(await e.read(t, 'reservedSupply')).toBe(10_000n);
    e.advance(10 * 86400);
    await expect(e.send(t, 'claimGrant', [id], 1)).rejects.toThrow('Ineligible');
    await expect(e.send(t, 'acceptTerms', [zeroHash], 1)).rejects.toThrow('Invalid');
    await e.send(t, 'acceptTerms', [TERMS], 1);
    await e.send(t, 'claimGrant', [id], 1);
    expect(await e.read(t, 'balanceOf', [e.accounts[1]])).toBeGreaterThan(0n);
  }, 120_000);

  it('a legal eligibility freeze still refuses reservation even after terms acceptance', async () => {
    const e = await equityV2Evm(), t = e.equity, id = digest('frozen-holder-grant');
    await e.register(1);
    await e.govern([{ contract: t, name: 'setEligibility', args: [2n, false] }]);
    await expect(e.callAs(e.timelock.address, t, 'commitGrant', [id, e.accounts[1], 10_000n, 0n, 0n, 100n * DAY])).rejects.toThrow('Ineligible');
    expect(await e.read(t, 'reservedSupply')).toBe(0n);
    expect((await e.read(t, 'grants', [id]) as GrantRow)[0]).toBe(0n);
  }, 120_000);
});

describe('P007 — hire-execution vesting start', () => {
  it('starts at the execution block after a delayed vote and keeps exact cliff and vesting durations', async () => {
    const e = await equityV2Evm(), t = e.equity, id = digest('execution-timed-grant');
    await e.register(1);
    const proposedAt = e.now();
    const proposal = await e.propose([{ contract: t, name: 'commitGrant', args: [id, e.accounts[1], 10_000n, 0n, 30n * DAY, 100n * DAY] }], 'Hire with execution-time vesting');
    e.advance(61);
    await e.send(e.governor, 'castVote', [proposal.id, 1]);
    e.advance(Number(await e.read(e.governor, 'votingPeriod')) + 1);
    await e.send(e.governor, 'queue', [proposal.targets, proposal.values, proposal.calldatas, proposal.descriptionHash]);
    e.advance(7 * 86400 + Number(await e.read(e.timelock, 'getMinDelay')) + 1);
    await e.send(e.governor, 'execute', [proposal.targets, proposal.values, proposal.calldatas, proposal.descriptionHash]);
    const grant = await e.read(t, 'grants', [id]) as GrantRow;
    expect(BigInt(grant[3])).toBe(e.now());
    expect(BigInt(grant[3])).toBeGreaterThan(proposedAt + 7n * DAY);
    expect(BigInt(grant[4]) - BigInt(grant[3])).toBe(30n * DAY);
    expect(BigInt(grant[5]) - BigInt(grant[3])).toBe(100n * DAY);
    expect(await e.read(t, 'earnedGrant', [id])).toBe(0n);
    e.advance(30 * 86400);
    expect(await e.read(t, 'earnedGrant', [id])).toBe(3_000n);
  }, 120_000);

  it.each([[101n * DAY, 100n * DAY], [0n, 3651n * DAY], [0n, 0n]])('rejects invalid relative cliff/end %s/%s without a reserve', async (cliff, end) => {
    const e = await equityV2Evm(), t = e.equity, id = digest('invalid-relative-grant');
    await e.register(1);
    await expect(e.callAs(e.timelock.address, t, 'commitGrant', [id, e.accounts[1], 10_000n, 0n, cliff, end])).rejects.toThrow('Invalid');
    expect(await e.read(t, 'reservedSupply')).toBe(0n);
    expect((await e.read(t, 'grants', [id]) as GrantRow)[0]).toBe(0n);
  }, 120_000);
});

describe('SPEC-P-004-D — an admin raise above the per-grant limit is reverted', () => {
  it('a raise above the immutable maximum reverts even after the admin sets the limit to that maximum', async () => {
    const { e, t, g1, grant } = await hired();
    expect(await e.read(t, 'maxGrantLimit')).toBe(100_000n);
    await expect(e.send(t, 'setGrantLimit', [100_001n], V2_ADMIN)).rejects.toThrow('Capacity');
    await e.send(t, 'setGrantLimit', [100_000n], V2_ADMIN);
    const reserved = await e.read(t, 'reservedSupply');
    await expect(e.send(t, 'raiseGrant', [g1, 100_001n], V2_ADMIN)).rejects.toThrow('Capacity');
    expect((await grant(g1))[1]).toBe(10_000n);
    expect(await e.read(t, 'reservedSupply')).toBe(reserved);
  }, 120_000);
  it('a raise above a lowered per-grant limit reverts', async () => {
    const { e, t, g1, grant } = await hired();
    await e.send(t, 'setGrantLimit', [15_000n], V2_ADMIN);
    await expect(e.send(t, 'raiseGrant', [g1, 15_001n], V2_ADMIN)).rejects.toThrow('Capacity');
    expect((await grant(g1))[1]).toBe(10_000n);
  }, 120_000);
});

describe('SPEC-P-004-E — an admin raise within the limit succeeds without a proposal', () => {
  it('the admin raises an unvested grant directly and the earned equity grows with it', async () => {
    const { e, t, g1, grant, earned } = await hired();
    e.advance(10 * 86400);
    const before = await earned(g1); const reserved = await e.read(t, 'reservedSupply') as bigint;
    await e.send(t, 'raiseGrant', [g1, 12_000n], V2_ADMIN);
    expect((await grant(g1))[1]).toBe(12_000n);
    expect(await e.read(t, 'reservedSupply')).toBe(reserved + 2_000n);
    expect(await earned(g1)).toBeGreaterThan(before);
    await expect(e.send(t, 'raiseGrant', [g1, 11_000n], V2_ADMIN)).rejects.toThrow('Invalid');
  }, 120_000);
});

describe('SPEC-P-004-F — a payout before its cadence interval is reverted', () => {
  it('a payout before the configured 45-day interval reverts NotDue and lands once it is due', async () => {
    const { e, t } = await hired();
    await e.send(t, 'setReturnPolicy', [300, 45 * 86400], V2_ADMIN);
    await e.send(t, 'triggerPayout', [digest('p1')], V2_ADMIN);
    e.advance(44 * 86400);
    await expect(e.send(t, 'triggerPayout', [digest('p2')], V2_ADMIN)).rejects.toThrow('NotDue');
    expect((await e.read(t, 'shareReturns', [digest('p2')]) as readonly unknown[])[3]).toBe(false);
    e.advance(86400);
    await e.send(t, 'triggerPayout', [digest('p2')], V2_ADMIN);
    expect((await e.read(t, 'shareReturns', [digest('p2')]) as readonly unknown[])[3]).toBe(true);
  }, 120_000);
  it('the admin cannot set a cadence shorter than the immutable 30-day minimum', async () => {
    const { e, t } = await hired();
    await expect(e.send(t, 'setReturnPolicy', [300, 30 * 86400 - 1], V2_ADMIN)).rejects.toThrow('Invalid');
    expect(await e.read(t, 'returnInterval')).toBe(0);
  }, 120_000);
});

describe('SPEC-P-004-G — a payout above the immutable return ceiling is reverted', () => {
  it('a payout that would take the 365-day total above 10% reverts Capacity', async () => {
    const { e, t } = await hired();
    await e.send(t, 'setReturnPolicy', [600, 30 * 86400], V2_ADMIN);
    await e.send(t, 'triggerPayout', [digest('p1')], V2_ADMIN);
    const [supply, reserved] = [await e.read(t, 'totalSupply'), await e.read(t, 'reservedSupply')];
    e.advance(31 * 86400);
    await expect(e.send(t, 'triggerPayout', [digest('p2')], V2_ADMIN)).rejects.toThrow('Capacity');
    expect([await e.read(t, 'totalSupply'), await e.read(t, 'reservedSupply')]).toEqual([supply, reserved]);
    expect(await e.read(t, 'returnWindowBps')).toBe(600);
  }, 120_000);
  it('the admin cannot set a payout rate above the ceiling', async () => {
    const { e, t } = await hired();
    await expect(e.send(t, 'setReturnPolicy', [1001, 30 * 86400], V2_ADMIN)).rejects.toThrow('Invalid');
    expect(await e.read(t, 'returnRateBps')).toBe(0);
  }, 120_000);
});

describe('SPEC-P-004-H — the product admin payout action lands a due payout without a proposal', () => {
  it('pot:equity prepare output signed by the admin wallet lands the payout on chain', async () => {
    const { e, t } = await hired();
    const prepare = (functionName: string, args: unknown[]) => prepareEquityTransaction({ chainId: 1, from: e.accounts[V2_ADMIN],
      contract: 'PapercuspEquityV2', to: t.address, functionName, args });
    for (const tx of [prepare('setReturnPolicy', [500, 30 * 86400]), prepare('triggerPayout', [digest('payout-1')])]) {
      expect(tx.requiresWalletSignature).toBe(true);
      await e.raw(tx.data, tx.to, V2_ADMIN, t.abi);
    }
    expect((await e.read(t, 'shareReturns', [digest('payout-1')]) as readonly unknown[])[3]).toBe(true);
    expect(await e.read(t, 'returnEntitlement', [digest('payout-1'), 1n])).toBe(5_000n);
    await e.send(t, 'claimReturn', [digest('payout-1')]);
    expect(await e.read(t, 'balanceOf', [e.accounts[0]])).toBe(105_000n);
  }, 120_000);
});

describe('SPEC-P-004-I — a cliffed grant releases nothing before its cliff', () => {
  async function cliffed() {
    const h = await hired(); const { e, t } = h;
    const s = e.now(); const id = digest('cliff-grant');
    await e.govern([{ contract: t, name: 'commitGrant', args: [id, e.accounts[1], 36_000n, s, s + 90n * DAY, s + 360n * DAY] }]);
    return { ...h, s, id };
  }
  it('no equity is earned or claimable before the cliff; vesting from the start applies after it', async () => {
    const { e, t, s, id, earned } = await cliffed();
    e.advance(Number(s + 89n * DAY - e.now()));
    expect(await earned(id)).toBe(0n);
    await expect(e.send(t, 'claimGrant', [id], 1)).rejects.toThrow('NothingEarned');
    e.advance(2 * 86400);
    const after = await earned(id);
    expect(after).toBeGreaterThanOrEqual(36_000n * 90n / 360n);
    await e.send(t, 'claimGrant', [id], 1);
    expect(await e.read(t, 'balanceOf', [e.accounts[1]])).toBeGreaterThanOrEqual(after);
  }, 120_000);
  it('a grant fired before its cliff keeps zero earned equity and releases its reservation', async () => {
    const { e, t, id, earned } = await cliffed();
    const reserved = await e.read(t, 'reservedSupply') as bigint;
    await e.govern([{ contract: t, name: 'stopGrant', args: [id] }]);
    e.advance(400 * 86400);
    expect(await earned(id)).toBe(0n);
    expect(await e.read(t, 'reservedSupply')).toBe(reserved - 36_000n);
  }, 120_000);
});

describe('SPEC-P-004-J — no call sequence reduces earned equity', () => {
  it("fuzzed call sequences over every external function never lower any grant's earned or claimed shares", async () => {
    const { e, t, g1, g2, grant, earned } = await hired();
    const s = e.now(); const g3 = digest('grant-3');
    await e.govern([{ contract: t, name: 'commitGrant', args: [g3, e.accounts[2], 9_000n, s, s + 20n * DAY, s + 150n * DAY] }]);
    await e.send(t, 'setReturnPolicy', [400, 30 * 86400], V2_ADMIN);
    let seed = 0x5eed1234;
    const r = () => { seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
    const grantIds = [g1, g2, g3]; const payouts = [0, 1, 2, 3].map(i => digest('fuzz-payout-' + i));
    const SCRIPTED_PAYOUT = digest('scripted-payout'); // never offered to the fuzz picker, so it cannot be pre-used
    const fns = t.abi.filter(f => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability)) as Array<{ name: string; inputs: readonly { type: string }[] }>;
    const amounts = async () => [0n, 1n, 999n, 5_000n, 15_000n, 100_000n, 100_001n, 2n ** 200n,
      ...(await Promise.all(grantIds.map(grant))).flatMap(g => [g[1] - 1n, g[1] + 1n])];
    const argFor = async (type: string): Promise<unknown> => {
      if (type === 'address') return pick([...e.accounts, t.address, e.timelock.address, zeroAddress]);
      if (type === 'bytes32') return pick([...grantIds, ...grantIds, ...payouts, TERMS, zeroHash, digest('noise-' + r())]);
      if (type === 'bool') return r() < 0.5;
      if (type === 'uint8') return Math.floor(r() * 256);
      if (type === 'uint16') return pick([0, 1, 300, 500, 1000, 1001, 65535]);
      if (type === 'uint48') return pick([0n, e.now() - DAY, e.now(), e.now() + DAY, e.now() + 100n * DAY, 2n ** 47n]);
      if (type.startsWith('uint')) return pick([...(await amounts()), 0n, 1n, 2n, 3n, 4n]);
      if (type === 'string') return 'x';
      return '0x';
    };
    const adminIndex = async () => e.accounts.indexOf(await e.read(t, 'admin') as `0x${string}`);
    const member = async () => { for (const i of [0, 1, 2, 3]) if (await e.read(t, 'memberId', [e.accounts[i]]) !== 0n && (await e.read(t, 'balanceOf', [e.accounts[i]]) as bigint) > 0n) return i; return 0; };
    const fire = async (id: Hex) => {
      const p = await e.propose([{ contract: t, name: 'stopGrant', args: [id] }], 'fuzz fire ' + id, await member());
      e.advance(61); for (let i = 0; i < 7; i++) await e.send(e.governor, 'castVote', [p.id, 1], i).catch(() => undefined);
      e.advance(86_401); await e.send(e.governor, 'queue', [p.targets, p.values, p.calldatas, p.descriptionHash]);
      e.advance(86_401); await e.send(e.governor, 'execute', [p.targets, p.values, p.calldatas, p.descriptionHash]);
    };
    const scripted: Record<number, () => Promise<unknown>> = {
      10: async () => e.send(t, 'raiseGrant', [g1, 11_000n], await adminIndex()),
      25: () => e.send(t, 'claimGrant', [g1], 1),
      40: () => e.send(t, 'resignGrant', [g2], 2),
      // The fuzz may already have paid out, retuned the policy or handed the admin role to a
      // non-account; the scripted payout re-establishes its own preconditions (an account-held
      // admin, a valid policy, the interval elapsed, window capacity) so it lands deterministically.
      55: async () => {
        if (await adminIndex() < 0) await e.govern([{ contract: t, name: 'replaceAdmin', args: [e.accounts[V2_ADMIN]] }]);
        await e.send(t, 'setReturnPolicy', [400, 30 * 86400], await adminIndex());
        const [last, windowStart, windowBps] = await Promise.all(['lastReturnAt', 'returnWindowStart', 'returnWindowBps'].map(n => e.read(t, n)));
        let due = BigInt(last as bigint) === 0n ? e.now() : BigInt(last as bigint) + 30n * DAY;
        if (Number(windowBps) + 400 > 1000) due = due > BigInt(windowStart as bigint) + 365n * DAY ? due : BigInt(windowStart as bigint) + 365n * DAY;
        if (due > e.now()) e.advance(Number(due - e.now()) + 1);
        return e.send(t, 'triggerPayout', [SCRIPTED_PAYOUT], await adminIndex());
      },
      70: () => fire(g3),
      85: () => e.send(t, 'claimReturn', [SCRIPTED_PAYOUT]),
      100: () => e.send(t, 'claimGrant', [g2], 2),
    };
    const landed: Record<string, number> = {};
    const reverted: Record<string, string> = {};
    let prev = await Promise.all(grantIds.map(async id => ({ earned: await earned(id), claimed: (await grant(id))[2] })));
    for (let step = 0; step < 160; step++) {
      let label: string;
      if (scripted[step]) {
        label = 'scripted-' + step;
        await scripted[step]().then(() => { landed[label] = 1; }, (err: unknown) => { reverted[label] = String((err as Error)?.message ?? err).slice(0, 400); });
      } else {
        const fn = pick(fns); label = fn.name;
        const args = []; for (const input of fn.inputs) args.push(await argFor(input.type));
        const sender = pick([0, 1, 2, 3, UNRELATED, V2_ADMIN, V2_ADMIN, await adminIndex()]);
        await e.send(t, fn.name, args, sender).then(() => { landed[label] = (landed[label] ?? 0) + 1; }, () => undefined);
      }
      e.advance(Math.floor(r() * 6 * 86400));
      const now = await Promise.all(grantIds.map(async id => ({ earned: await earned(id), claimed: (await grant(id))[2] })));
      now.forEach((n, i) => {
        if (n.earned < prev[i].earned || n.claimed < prev[i].claimed) throw new Error(`step ${step} (${label}) lowered grant ${i + 1}: ${prev[i].earned}/${prev[i].claimed} -> ${n.earned}/${n.claimed}`);
      });
      prev = now;
    }
    // Coverage: the sequence really exercised raises, claims, resignation, a fire and a payout.
    for (const step of [10, 25, 40, 55, 70, 85, 100]) expect(landed['scripted-' + step], `scripted step ${step} reverted: ${reverted['scripted-' + step]}`).toBe(1);
    expect((await grant(g2))[6]).toBeGreaterThan(0);
    expect((await grant(g3))[6]).toBeGreaterThan(0);
  }, 300_000);
});

describe('SPEC-P-004-K — every external function is classified', () => {
  const abiNames = () => (artifacts.contracts.PapercuspEquityV2.abi as Array<{ type: string; name?: string; stateMutability?: string }>)
    .filter(f => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability ?? '')).map(f => f.name!).sort();
  it('the compiled ABI and the classification table name exactly the same state-changing functions', () => {
    expect(abiNames()).toEqual(Object.keys(EQUITY_V2_FUNCTION_CLASSES).sort());
  });
  it('every governance and admin entry refuses a caller outside its class', async () => {
    const { e, t, g1 } = await hired();
    const args: Record<string, unknown[]> = {
      registerHolder: [e.accounts[3], digest('k-holder')], commitGrant: [digest('k-grant'), e.accounts[1], 1_000n, e.now(), e.now(), e.now() + 100n * DAY],
      stopGrant: [g1], setEligibility: [2n, false], replaceAdmin: [e.accounts[6]], transferAdmin: [e.accounts[6]], setGrantLimit: [50_000n],
      setReturnPolicy: [500, 30 * 86400], raiseGrant: [g1, 11_000n], triggerPayout: [digest('k-payout')],
    };
    for (const [name, entry] of Object.entries(EQUITY_V2_FUNCTION_CLASSES)) {
      if (entry.class === 'anyone') continue;
      expect(args[name], name).toBeDefined();
      const outsiders = entry.class === 'governance' ? [V2_ADMIN, UNRELATED, 1] : [0, 1, UNRELATED];
      for (const sender of outsiders) await expect(e.send(t, name, args[name], sender)).rejects.toThrow('Forbidden');
      if (entry.class === 'admin') await expect(e.callAs(e.timelock.address, t, name, args[name])).rejects.toThrow('Forbidden');
    }
  }, 120_000);
});

describe('SPEC-P-004-L — no setter for the return ceiling or minimum payout interval', () => {
  it('the ceiling and minimum interval are compile-time constants with no state-changing writer', async () => {
    const abi = artifacts.contracts.PapercuspEquityV2.abi as Array<{ type: string; name?: string; stateMutability?: string; inputs?: unknown[] }>;
    for (const name of ['ANNUAL_RETURN_CAP_BPS', 'MIN_RETURN_INTERVAL']) {
      const getter = abi.find(f => f.type === 'function' && f.name === name);
      expect(getter?.stateMutability).toBe('view');
      expect(getter?.inputs).toEqual([]);
    }
    const writers = abi.filter(f => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability ?? '')).map(f => f.name!);
    expect(writers.filter(n => /cap|ceiling|minimum|min_?return/i.test(n))).toEqual([]);
    const { e, t } = await hired();
    await e.send(t, 'setReturnPolicy', [1000, 30 * 86400], V2_ADMIN);
    await e.send(t, 'setGrantLimit', [100_000n], V2_ADMIN);
    expect(await e.read(t, 'ANNUAL_RETURN_CAP_BPS')).toBe(1000);
    expect(await e.read(t, 'MIN_RETURN_INTERVAL')).toBe(30 * 86400);
  }, 120_000);
});

describe('SPEC-P-004-M — only the grant holder can self-stop', () => {
  it('admin-account: a self-stop from the admin is reverted', async () => {
    const { e, t, g1, grant } = await hired();
    await expect(e.send(t, 'resignGrant', [g1], V2_ADMIN)).rejects.toThrow('Forbidden');
    expect((await grant(g1))[6]).toBe(0);
  }, 120_000);
  it("another-holder: a self-stop of someone else's grant is reverted", async () => {
    const { e, t, g1, grant } = await hired();
    for (const sender of [2, 0]) await expect(e.send(t, 'resignGrant', [g1], sender)).rejects.toThrow('Forbidden');
    expect((await grant(g1))[6]).toBe(0);
  }, 120_000);
  it('governance-executor: a self-stop from the timelock is reverted and cannot be proposed', async () => {
    const { e, t, g1, grant } = await hired();
    await expect(e.callAs(e.timelock.address, t, 'resignGrant', [g1])).rejects.toThrow('Forbidden');
    await expect(e.propose([{ contract: t, name: 'resignGrant', args: [g1] }], 'resign by vote')).rejects.toThrow('UnsupportedAction');
    expect((await grant(g1))[6]).toBe(0);
  }, 120_000);
});

describe("SPEC-P-004-N — a self-stop ends only the caller's grant", () => {
  it("a holder's resignation stops their own grant and leaves every other grant vesting", async () => {
    const { e, t, g1, g2, grant, earned } = await hired();
    e.advance(20 * 86400);
    await e.send(t, 'resignGrant', [g1], 1);
    expect((await grant(g1))[6]).toBeGreaterThan(0);
    const other = await earned(g2);
    e.advance(20 * 86400);
    expect((await grant(g2))[6]).toBe(0);
    expect(await earned(g2)).toBeGreaterThan(other);
  }, 120_000);
});

describe("SPEC-P-004-O — a self-stop keeps the caller's earned equity", () => {
  it('earned equity at the resignation stays claimable and the unearned rest is released', async () => {
    const { e, t, g1, grant, earned } = await hired();
    e.advance(50 * 86400);
    const before = await earned(g1); const reserved = await e.read(t, 'reservedSupply') as bigint;
    await e.send(t, 'resignGrant', [g1], 1);
    const row = await grant(g1); const kept = await earned(g1);
    expect(kept).toBe(10_000n * (BigInt(row[6]) - BigInt(row[3])) / (100n * DAY));
    expect(kept).toBeGreaterThanOrEqual(before);
    expect(await e.read(t, 'reservedSupply')).toBe(reserved - (10_000n - kept));
    e.advance(100 * 86400);
    expect(await earned(g1)).toBe(kept);
    await e.send(t, 'claimGrant', [g1], 1);
    expect(await e.read(t, 'balanceOf', [e.accounts[1]])).toBe(kept);
  }, 120_000);
});
