import { describe, it, expect } from 'vitest';
import { equityEvm, digest, TERMS } from './evm-test-helpers';

describe('actual equity ownership and equity-paid returns on Cancun EVM', () => {
  it('retains ownership ballots during a complete transfer freeze so governance can restore eligibility', async () => {
    const e = await equityEvm(); const t = e.equity;
    await e.govern([{ contract: t, name: 'setEligibility', args: [1n, false] }]);
    await expect(e.send(t, 'transfer', [e.accounts[1], 1n])).rejects.toThrow('Ineligible');
    await e.govern([{ contract: t, name: 'setEligibility', args: [1n, true] }]);
    expect((await e.read(t, 'holders', [1n]) as unknown[])[2]).toBe(true);
    expect(await e.read(t, 'totalSupply')).toBe(100_000n);
  }, 60_000);

  it('requires issuer documents, personal acceptance and eligible transfers; rejects bootstrap/admin mint and replay', async () => {
    const e = await equityEvm();
    const { equity: t, send, read, govern, accounts } = e;
    await expect(e.deploy('PapercuspEquity', [digest('x'), '', 1000n, 100n])).rejects.toThrow();
    await expect(send(t, 'activateGenesis', [digest('replay'), TERMS])).rejects.toThrow('Forbidden');
    await expect(send(t, 'bindGovernance', [e.governor.address, e.timelock.address])).rejects.toThrow('Forbidden');
    await expect(send(t, 'registerHolder', [accounts[1], digest('employee')])).rejects.toThrow('Forbidden');
    await expect(send(t, 'transfer', [accounts[1], 1n])).rejects.toThrow('Ineligible');
    await govern([{ contract: t, name: 'registerHolder', args: [accounts[1], digest('employee')] }]);
    await expect(send(t, 'transfer', [accounts[1], 1n])).rejects.toThrow('Ineligible');
    await expect(send(t, 'acceptTerms', [digest('wrong')], 1)).rejects.toThrow('Invalid');
    await send(t, 'acceptTerms', [TERMS], 1);
    const supply = await read(t, 'totalSupply');
    await send(t, 'transfer', [accounts[1], 1000n]);
    expect(await read(t, 'totalSupply')).toBe(supply);
    expect(await read(t, 'balanceOf', [accounts[1]])).toBe(1000n);
    const id = digest('employee-grant');
    await expect(send(t, 'commitGrant', [id, accounts[1], 1000n, e.now(), e.now() + 365n * 86400n], 1)).rejects.toThrow('Forbidden');
    await govern([{ contract: t, name: 'commitGrant', args: [id, accounts[1], 1000n, e.now(), e.now() + 365n * 86400n] }], [0, 1]);
    await expect(govern([{ contract: t, name: 'commitGrant', args: [id, accounts[1], 1000n, e.now(), e.now() + 365n * 86400n] }], [0, 1])).rejects.toThrow();
    await expect(send(t, 'claimGrant', [id], 2)).rejects.toThrow('Forbidden');
  }, 60_000);

  it('termination stops future accrual while preserving vested and already issued ownership', async () => {
    const e = await equityEvm(); const t = e.equity;
    const id = digest('vesting-grant');
    const start = e.now(); const end = start + 100n * 86400n;
    await e.govern([{ contract: t, name: 'commitGrant', args: [id, e.accounts[0], 10_000n, start, end] }]);
    e.advance(20 * 86400);
    await e.send(t, 'claimGrant', [id]);
    const issued = await e.read(t, 'balanceOf', [e.accounts[0]]) as bigint;
    expect(issued - 100_000n).toBe(10_000n * (e.now() - start) / (end - start));
    await e.govern([{ contract: t, name: 'stopGrant', args: [id] }]);
    const earned = await e.read(t, 'earnedGrant', [id]) as bigint;
    const stopped = BigInt((await e.read(t, 'grants', [id]) as readonly (bigint | number)[])[5]);
    expect(earned).toBe(10_000n * (stopped - start) / (end - start));
    expect(earned).toBeGreaterThan(2000n);
    e.advance(200 * 86400);
    expect(await e.read(t, 'earnedGrant', [id])).toBe(earned);
    await e.send(t, 'claimGrant', [id]);
    expect(await e.read(t, 'balanceOf', [e.accounts[0]])).toBe(100_000n + earned);
    expect(await e.read(t, 'balanceOf', [e.accounts[0]])).toBeGreaterThanOrEqual(issued);
    expect(await e.read(t, 'reservedSupply')).toBe(0n);
    await expect(e.send(t, 'claimGrant', [id])).rejects.toThrow('NothingEarned');
  }, 60_000);

  it('fixed-record bonus shares survive sales/recovery and cannot be captured twice or by new shares', async () => {
    const e = await equityEvm(); const t = e.equity;
    await e.register(1); await e.register(2);
    await e.send(t, 'transfer', [e.accounts[1], 20_000n]);
    const returnId = digest('return-1');
    await e.govern([{ contract: t, name: 'declareReturn', args: [returnId, 1000] }], [0, 1]);
    expect(await e.read(t, 'returnEntitlement', [returnId, 1n])).toBe(8000n);
    expect(await e.read(t, 'returnEntitlement', [returnId, 2n])).toBe(2000n);
    await e.send(t, 'transfer', [e.accounts[2], 20_000n], 1); // seller keeps record-date rights
    await expect(e.send(t, 'claimReturn', [returnId], 2)).rejects.toThrow('NothingEarned');
    const grantId = digest('post-record-grant');
    await e.govern([{ contract: t, name: 'commitGrant', args: [grantId, e.accounts[2], 1000n, e.now() - 1000n, e.now() - 1n] }], [0, 2]);
    await e.send(t, 'claimGrant', [grantId], 2);
    await expect(e.send(t, 'claimReturn', [returnId], 2)).rejects.toThrow('NothingEarned');
    await expect(e.send(t, 'requestRecovery', [2n, e.accounts[3]], 2)).rejects.toThrow('Forbidden');
    await e.send(t, 'setRecoveryAgent', [e.accounts[4]], 1);
    await e.send(t, 'requestRecovery', [2n, e.accounts[3]], 4);
    await expect(e.send(t, 'acceptRecovery', [2n, TERMS], 5)).rejects.toThrow('Forbidden');
    const pre = await e.read(t, 'totalSupply');
    await e.send(t, 'acceptRecovery', [2n, TERMS], 3);
    expect(await e.read(t, 'totalSupply')).toBe(pre);
    expect(await e.read(t, 'memberId', [e.accounts[1]])).toBe(0n);
    await expect(e.send(t, 'claimReturn', [returnId], 1)).rejects.toThrow('NothingEarned');
    await e.send(t, 'claimReturn', [returnId], 3);
    expect(await e.read(t, 'balanceOf', [e.accounts[3]])).toBe(2000n);
    await expect(e.send(t, 'claimReturn', [returnId], 3)).rejects.toThrow('NothingEarned');
    await e.send(t, 'claimReturn', [returnId]);
    expect(await e.read(t, 'totalSupply')).toBe(111_000n);
    expect(await e.read(t, 'reservedSupply')).toBe(0n);
    expect(await e.vm.stateManager.getAccount((await import('@ethereumjs/util')).createAddressFromString(t.address))).toMatchObject({ balance: 0n });
    await expect(e.govern([{ contract: t, name: 'declareReturn', args: [digest('overannualcap'), 1] }], [0, 2, 3])).rejects.toThrow();
  }, 60_000);

  it('recovery preserves all committed grants and supply; hostile sequences cannot mint beyond commitments', async () => {
    const e = await equityEvm(); const t = e.equity;
    const id = digest('recovered-grant');
    const start = e.now(); const end = start + 60n * 86400n;
    await e.govern([{ contract: t, name: 'commitGrant', args: [id, e.accounts[0], 6000n, start, end] }]);
    await e.send(t, 'requestRecovery', [1n, e.accounts[3]]);
    const before = [await e.read(t, 'totalSupply'), await e.read(t, 'reservedSupply'), await e.read(t, 'grants', [id])];
    await e.send(t, 'acceptRecovery', [1n, TERMS], 3);
    expect([await e.read(t, 'totalSupply'), await e.read(t, 'reservedSupply'), await e.read(t, 'grants', [id])]).toEqual(before);
    e.advance(100 * 86400);
    await expect(e.send(t, 'claimGrant', [id])).rejects.toThrow('Forbidden');
    await e.send(t, 'claimGrant', [id], 3);
    expect(await e.read(t, 'balanceOf', [e.accounts[3]])).toBe(106_000n);
    expect(await e.read(t, 'balanceOf', [e.accounts[0]])).toBe(0n);
    for (let i = 0; i < 12; i++) {
      await expect(e.send(t, i % 2 ? 'claimGrant' : 'claimReturn', [i % 2 ? id : digest('nonexistent-' + i)], i % 8)).rejects.toThrow();
      expect(await e.read(t, 'totalSupply')).toBe(106_000n);
      expect(await e.read(t, 'reservedSupply')).toBe(0n);
    }
  }, 60_000);

  it('counts every outstanding commitment against the cap and rejects an atomic over-cap grant batch', async () => {
    const e = await equityEvm(); const t = e.equity;
    const start = e.now() + 365n * 86400n;
    const actions = Array.from({ length: 10 }, (_, i) => ({ contract: t, name: 'commitGrant', args: [digest('cap-' + i), e.accounts[0], 100_000n, start, start + 86400n] }));
    await expect(e.govern(actions)).rejects.toThrow();
    expect(await e.read(t, 'reservedSupply')).toBe(0n); // whole failed batch rolls back
    await e.govern(actions.slice(0, 9));
    expect(await e.read(t, 'reservedSupply')).toBe(900_000n);
    await expect(e.govern([{ contract: t, name: 'declareReturn', args: [digest('cap-return'), 100] }])).rejects.toThrow();
    expect(await e.read(t, 'totalSupply')).toBe(100_000n);
    await e.govern([{ contract: t, name: 'stopGrant', args: [digest('cap-0')] }]);
    expect(await e.read(t, 'reservedSupply')).toBe(800_000n);
    await e.govern([{ contract: t, name: 'declareReturn', args: [digest('cap-return'), 100] }]);
    expect(await e.read(t, 'reservedSupply')).toBe(801_000n);
    await e.send(t, 'claimReturn', [digest('cap-return')]);
    expect(await e.read(t, 'totalSupply')).toBe(101_000n);
    expect(await e.read(t, 'reservedSupply')).toBe(800_000n);
  }, 60_000);

  it('record-ineligible positive balances cannot obtain prior bonus shares after eligibility is restored', async () => {
    const e = await equityEvm(); const t = e.equity;
    await e.register(1);
    await e.send(t, 'transfer', [e.accounts[1], 10_000n]);
    await e.govern([{ contract: t, name: 'setEligibility', args: [2n, false] }], [0, 1]);
    await expect(e.send(t, 'transfer', [e.accounts[0], 1n], 1)).rejects.toThrow('Ineligible');
    const id = digest('eligibility-record');
    await e.govern([{ contract: t, name: 'declareReturn', args: [id, 500] }], [0, 1]);
    expect(await e.read(t, 'returnEntitlement', [id, 2n])).toBe(0n);
    expect(await e.read(t, 'returnEntitlement', [id, 1n])).toBe(4500n);
    await e.govern([{ contract: t, name: 'setEligibility', args: [2n, true] }], [0, 1]);
    await expect(e.send(t, 'claimReturn', [id], 1)).rejects.toThrow('NothingEarned');
    expect(await e.read(t, 'balanceOf', [e.accounts[1]])).toBe(10_000n);
  }, 60_000);
});
