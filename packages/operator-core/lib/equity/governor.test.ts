import { describe, it, expect } from 'vitest';
import { equityEvm, digest, TERMS } from './evm-test-helpers';
import { encodeFunctionData, zeroAddress } from 'viem';

describe('OpenZeppelin equity governance on real Cancun EVM', () => {
  it('requires both individual members and economic approval, snapshots prior policy, and enforces delay', async () => {
    const e = await equityEvm(); const t = e.equity; const g = e.governor;
    await e.register(1); await e.register(2);
    await e.send(t, 'transfer', [e.accounts[1], 1000n]);
    await e.send(t, 'transfer', [e.accounts[2], 1000n]);
    e.advance(2);
    const action = [{ contract: t, name: 'setEligibility', args: [3n, true] }];
    const memberFailure = await e.propose(action, 'Whale alone cannot approve');
    e.advance(61); await e.send(g, 'castVote', [memberFailure.id, 1]); e.advance(86401);
    expect(await e.read(g, 'state', [memberFailure.id])).toBe(3); // Defeated
    const economicFailure = await e.propose(action, 'Small members alone cannot approve', 1);
    e.advance(61); await e.send(g, 'castVote', [economicFailure.id, 1], 1); await e.send(g, 'castVote', [economicFailure.id, 1], 2); e.advance(86401);
    expect(await e.read(g, 'state', [economicFailure.id])).toBe(3);
    const successful = await e.propose(action, 'Dual approval');
    e.advance(61); await e.send(g, 'castVote', [successful.id, 1]); await e.send(g, 'castVote', [successful.id, 1], 1);
    await expect(e.send(g, 'castVote', [successful.id, 1], 1)).rejects.toThrow();
    e.advance(86401);
    await e.send(g, 'queue', [successful.targets, successful.values, successful.calldatas, successful.descriptionHash]);
    await expect(e.send(g, 'execute', [successful.targets, successful.values, successful.calldatas, successful.descriptionHash])).rejects.toThrow();
    e.advance(86401);
    await e.send(g, 'execute', [successful.targets, successful.values, successful.calldatas, successful.descriptionHash]);
    expect(await e.read(g, 'state', [successful.id])).toBe(7); // Executed
  }, 60_000);

  it('protects policy amendments/mixed batches under prior rules; closes role, relay and upgrade bypasses', async () => {
    const e = await equityEvm(); const t = e.equity; const g = e.governor; const lock = e.timelock;
    await e.register(1); await e.register(2);
    await e.send(t, 'transfer', [e.accounts[1], 1000n]); await e.send(t, 'transfer', [e.accounts[2], 1000n]); e.advance(2);
    const amendment = [{ contract: g, name: 'setPolicy', args: [5500, 7000, 60, 3600] }];
    const prior = await e.propose(amendment, 'Amendment freezes previous protected policy');
    expect((await e.read(g, 'proposalPolicy', [prior.id]) as unknown[])[0]).toBe(7500);
    e.advance(61); await e.send(g, 'castVote', [prior.id, 1]); await e.send(g, 'castVote', [prior.id, 1], 1); e.advance(86401);
    expect(await e.read(g, 'state', [prior.id])).toBe(3); // 2/3 below prior 75%
    await e.govern(amendment, [0, 1, 2]);
    expect(await e.read(g, 'normalApprovalBps')).toBe(5500);
    expect((await e.read(g, 'proposalPolicy', [prior.id]) as unknown[])[0]).toBe(7500);
    const mixed = await e.propose([{ contract: t, name: 'setEligibility', args: [2n, true] }, ...amendment], 'Mixed batch uses strongest policy');
    expect((await e.read(g, 'proposalPolicy', [mixed.id]) as unknown[])[0]).toBe(7000);
    await expect(e.send(g, 'setPolicy', [1, 1, 1, 1])).rejects.toThrow();
    await expect(e.govern([{ contract: g, name: 'setPolicy', args: [5000, 7000, 60, 3600] }], [0, 1, 2])).rejects.toThrow();
    await expect(e.govern([{ contract: lock, name: 'updateDelay', args: [1n] }], [0, 1, 2])).rejects.toThrow();
    await expect(e.send(lock, 'grantRole', [await e.read(lock, 'PROPOSER_ROLE'), e.accounts[0]])).rejects.toThrow('Sealed');
    await expect(e.send(lock, 'initializeGovernor', [g.address])).rejects.toThrow('Sealed');
    await expect(e.send(lock, 'schedule', [t.address, 0n, '0x', digest('x'), digest('y'), 86400n])).rejects.toThrow();
    for (const action of [
      { contract: g, name: 'relay', args: [t.address, 0n, '0x'] },
      { contract: g, name: 'updateTimelock', args: [e.accounts[0]] },
      { contract: lock, name: 'grantRole', args: [await e.read(lock, 'EXECUTOR_ROLE'), zeroAddress] },
      { contract: t, name: 'bindGovernance', args: [g.address, lock.address] },
    ]) await expect(e.propose([action], 'Unsupported action ' + action.name)).rejects.toThrow('UnsupportedAction');
    const data = encodeFunctionData({ abi: t.abi, functionName: 'setEligibility', args: [2n, true] });
    await expect(e.send(g, 'propose', [[t.address], [1n], [data], 'No arbitrary payments'])).rejects.toThrow('UnsupportedAction');
  }, 60_000);

  it('keeps one member ballot across recovery and prevents votes from newly acquired shares', async () => {
    const e = await equityEvm(); const t = e.equity; const g = e.governor;
    await e.register(1); await e.send(t, 'transfer', [e.accounts[1], 10_000n]); e.advance(2);
    const p = await e.propose([{ contract: t, name: 'setEligibility', args: [2n, true] }], 'Snapshot after transfer');
    e.advance(61); await e.send(g, 'castVote', [p.id, 1], 1);
    await e.send(t, 'requestRecovery', [2n, e.accounts[3]], 1);
    await e.send(t, 'acceptRecovery', [2n, TERMS], 3);
    await expect(e.send(g, 'castVote', [p.id, 1], 3)).rejects.toThrow('NotMember');
    await expect(e.send(g, 'castVote', [p.id, 1], 1)).rejects.toThrow();
    expect((await e.read(g, 'proposalPolicy', [p.id]) as unknown[])[1]).toBe(1n);
    await e.send(t, 'transfer', [e.accounts[3], 50_000n]);
    expect((await e.read(g, 'proposalVotes', [p.id]) as unknown[])[1]).toBe(10_000n);
  }, 60_000);
});
