import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, getAddress } from 'viem';
import { bytesToHex, createAddressFromString } from '@ethereumjs/util';
import { daoFinanceAction, runDaoFinance, type DaoFinanceDeps } from './dao-finance';
import { equityArtifacts, inspectEquity } from './equity/runtime';
import { equityV2Evm, V2_ADMIN } from './equity/evm-test-helpers';
const address = (n: string) => '0x' + n.repeat(40);
const equity = { chainId: 1, equity: address('1'), governor: address('2'), timelock: address('3') };
function deps(): DaoFinanceDeps {
  return { wallet: vi.fn().mockResolvedValue({ ok: true, value: { binding: { walletAddress: address('4'), chainId: 1 } } }),
    challenge: vi.fn(), verify: vi.fn(), commerce: vi.fn().mockResolvedValue({ ok: false, code: 'unknown-org', detail: 'Organization is not in the commerce roster.' }),
    equity: vi.fn().mockResolvedValue({ version: '1', governanceBound: true, supplyInvariant: true, issuedShares: '42' }), treasury: vi.fn().mockResolvedValue({ nativeBalanceWei: '123' }) };
}
function offeredActions(result: Awaited<ReturnType<typeof runDaoFinance>>) {
  if (!('actions' in result) || !result.actions) throw new Error('Expected finance inspection');
  return result.actions;
}
describe('Workbench finance maintained boundaries', () => {
  it.each(['1', '2'])('offers only actions for measured deployment version %s and refuses a stale ABI selection', async version => {
    const d = deps(); d.equity = vi.fn().mockResolvedValue({ version, governanceBound: true, supplyInvariant: true });
    const input = { policy: { finance: { equity } }, policyVersion: 7, actorId: 'gh:42' };
    const result = await runDaoFinance({ ...input, action: { op: 'inspect' } }, d);
    const contracts = version === '2' ? ['PapercuspEquityV2', 'EquityGovernorV2', 'EquityTimelock'] : ['PapercuspEquity', 'EquityGovernor', 'EquityTimelock'];
    expect(new Set(offeredActions(result).map(action => action.contract))).toEqual(new Set(contracts));
    for (const action of offeredActions(result)) expect(daoFinanceAction.safeParse({ op: 'prepare-equity', expectedPolicyVersion: 7, contract: action.contract, functionName: action.name, args: [] }).success).toBe(true);
    await expect(runDaoFinance({ ...input, action: { op: 'prepare-equity', expectedPolicyVersion: 7, contract: version === '2' ? 'PapercuspEquity' : 'PapercuspEquityV2', functionName: 'requestRecovery', args: ['1', address('5')] } }, d)).rejects.toThrow('deployment version');
  });
  it('offers no signable contract actions without a measured supported deployment', async () => {
    const input = { policyVersion: 7, actorId: 'gh:42', action: { op: 'inspect' as const } };
    expect(offeredActions(await runDaoFinance({ ...input, policy: {} }, deps()))).toEqual([]);
    for (const version of [undefined, '3']) {
      const d = deps(); d.equity = vi.fn().mockResolvedValue({ version, governanceBound: true, supplyInvariant: true });
      expect(offeredActions(await runDaoFinance({ ...input, policy: { finance: { equity } } }, d))).toEqual([]);
    }
  });
  it('prepares V2 admin and governor transactions against an actual V2 deployment', async () => {
    const chain = await equityV2Evm();
    const binding = { chainId: 1, equity: chain.equity.address, governor: chain.governor.address, timelock: chain.timelock.address };
    const reader = { getChainId: async () => 1, getBlockNumber: async () => chain.blockNumber(),
      getCode: async ({ address: target }: { address: `0x${string}` }) => bytesToHex(await chain.vm.stateManager.getCode(createAddressFromString(target))),
      readContract: async ({ address: target, functionName, args }: { address: string; functionName: string; args?: unknown[] }) => {
        const contract = [chain.equity, chain.governor, chain.timelock].find(value => value.address.toLowerCase() === target.toLowerCase());
        if (!contract) throw new Error('Unexpected deployment address');
        return chain.read(contract, functionName, args);
      } };
    const d = deps(); d.wallet = vi.fn().mockResolvedValue({ ok: true, value: { binding: { walletAddress: chain.accounts[V2_ADMIN], chainId: 1 } } });
    d.equity = (deployment, holder) => inspectEquity(reader, { ...deployment, holder });
    const input = { policy: { finance: { equity: binding } }, policyVersion: 7, actorId: 'gh:42' };
    const adminAction = daoFinanceAction.parse({ op: 'prepare-equity', expectedPolicyVersion: 7, contract: 'PapercuspEquityV2', functionName: 'setReturnPolicy', args: ['500', '2592000'] });
    const admin = await runDaoFinance({ ...input, action: adminAction }, d) as { unsignedTransaction: { data: `0x${string}` } };
    expect(admin).toMatchObject({ ok: true, unsignedTransaction: { to: getAddress(binding.equity), from: chain.accounts[V2_ADMIN], requiresWalletSignature: true } });
    expect(decodeFunctionData({ abi: chain.equity.abi, data: admin.unsignedTransaction.data })).toMatchObject({ functionName: 'setReturnPolicy', args: [500, 2592000] });
    await chain.raw(admin.unsignedTransaction.data, chain.equity.address, V2_ADMIN, chain.equity.abi);
    expect(await chain.read(chain.equity, 'returnRateBps')).toBe(500);
    const governorAction = daoFinanceAction.parse({ op: 'prepare-equity', expectedPolicyVersion: 7, contract: 'EquityGovernorV2', functionName: 'castVote', args: ['123', '1'] });
    const governor = await runDaoFinance({ ...input, action: governorAction }, d) as { unsignedTransaction: { data: `0x${string}` } };
    expect(governor).toMatchObject({ unsignedTransaction: { to: getAddress(binding.governor) } });
    expect(decodeFunctionData({ abi: chain.governor.abi, data: governor.unsignedTransaction.data })).toMatchObject({ functionName: 'castVote', args: [123n, 1] });
  });
  it('never invents organization accounts from a DAO directory id and distinguishes unbound/error reads', async () => {
    const d = deps(); const result = await runDaoFinance({ policy: {}, policyVersion: 0, actorId: 'gh:42', action: { op: 'inspect' } }, d);
    expect(result).toMatchObject({ treasury: { status: 'not-bound' }, commerce: { status: 'not-bound' }, equity: { status: 'not-bound' } });
    expect(d.commerce).not.toHaveBeenCalled();
    const bound = await runDaoFinance({ policy: { finance: { commerce: { buyerOrgId: 'actual-org' } } }, policyVersion: 1, actorId: 'gh:42', action: { op: 'inspect' } }, d);
    expect(d.commerce).toHaveBeenCalledWith({ buyerOrgId: 'actual-org', actingUserId: 'gh:42' });
    expect(bound).toMatchObject({ commerce: { status: 'error', message: 'Organization is not in the commerce roster.' } });
  });
  it('prepares exact contract calldata from the verified wallet and signed deployment only', async () => {
    const d = deps(); const input = { policy: { finance: { equity } }, policyVersion: 7, actorId: 'gh:42', action: { op: 'prepare-equity' as const, expectedPolicyVersion: 7, contract: 'PapercuspEquity' as const, functionName: 'requestRecovery', args: ['1', address('5')] } };
    const result = await runDaoFinance(input, d) as { unsignedTransaction: { data: `0x${string}` } };
    expect(result).toMatchObject({ ok: true, unsignedTransaction: { from: address('4'), to: equity.equity, requiresWalletSignature: true, value: '0' } });
    expect(decodeFunctionData({ abi: equityArtifacts.contracts.PapercuspEquity.abi, data: result.unsignedTransaction.data })).toMatchObject({ functionName: 'requestRecovery', args: [1n, address('5')] });
    await expect(runDaoFinance({ ...input, policyVersion: 8 }, d)).rejects.toThrow('Policy changed');
    d.wallet = vi.fn().mockResolvedValue({ ok: true, value: { binding: { walletAddress: address('4'), chainId: 2 } } });
    await expect(runDaoFinance(input, d)).rejects.toThrow('verified wallet');
  });
  it('refuses an integrity failure before preparing a wallet transaction', async () => {
    const d = deps(); d.equity = vi.fn().mockResolvedValue({ governanceBound: false, supplyInvariant: true });
    await expect(runDaoFinance({ policy: { finance: { equity } }, policyVersion: 7, actorId: 'gh:42', action: { op: 'prepare-equity', expectedPolicyVersion: 7, contract: 'PapercuspEquity', functionName: 'requestRecovery', args: ['1', address('5')] } }, d)).rejects.toThrow('integrity');
  });
});
