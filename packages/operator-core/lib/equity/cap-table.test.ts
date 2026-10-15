import { describe, expect, it } from 'vitest';
import { bytesToHex, createAddressFromString } from '@ethereumjs/util';
import { inspectEquityCapTable, type CapTableChainReader } from './cap-table';
import { digest, equityEvm, equityV2Evm } from './evm-test-helpers';

function readerFor(chain: Awaited<ReturnType<typeof equityEvm>>, calls: bigint[] = []): CapTableChainReader {
  return {
    getChainId: async () => 1, getBlockNumber: async () => chain.blockNumber(),
    getCode: async input => { calls.push(input.blockNumber); return bytesToHex(await chain.vm.stateManager.getCode(createAddressFromString(input.address))); },
    readContract: async input => { calls.push(input.blockNumber); const contract = [chain.equity, chain.governor, chain.timelock].find(c => c.address.toLowerCase() === input.address.toLowerCase())!;
      return chain.read({ ...contract, abi: input.abi }, input.functionName, input.args); },
    getContractEvents: async input => { calls.push(input.toBlock); return chain.getContractEvents(input); },
  };
}
const binding = (chain: Awaited<ReturnType<typeof equityEvm>>) => ({ chainId: 1, equity: chain.equity.address, governor: chain.governor.address, timelock: chain.timelock.address });

describe('SPEC-P-011 — real-chain cap table', () => {
  it('reads V2 cliff/claim/stopped grants and return rights from storage at one block and detects omitted event keys', async () => {
    const chain = await equityV2Evm();
    await chain.register(1);
    const id = digest('cap-table-grant');
    const start = chain.now();
    await chain.callAs(chain.timelock.address, chain.equity, 'commitGrant', [id, chain.accounts[1], 1000n, start, start + 20n, start + 100n]);
    const calls: bigint[] = [];
    const reader = readerFor(chain, calls);
    let table = await inspectEquityCapTable(reader, binding(chain));
    expect(table.contractVersion).toBe('2');
    expect(table.positions.map(p => p.wallet)).toEqual([chain.accounts[0], chain.accounts[1]]);
    expect(table.positions[1]).toMatchObject({ shares: '0', committed: '1000', earned: '0', claimed: '0', unvested: '1000' });
    expect(new Set(calls)).toEqual(new Set([BigInt(table.blockNumber)]));
    const incomplete: CapTableChainReader = { ...reader, getContractEvents: async input => input.eventName === 'GrantCommitted' ? [] : reader.getContractEvents(input) };
    await expect(inspectEquityCapTable(incomplete, binding(chain))).rejects.toThrow('history does not reconcile');
    chain.advance(50);
    await chain.send(chain.equity, 'claimGrant', [id], 1);
    await chain.send(chain.equity, 'setReturnPolicy', [100n, 30n * 86400n], chain.admin);
    const payout = digest('cap-table-payout');
    await chain.send(chain.equity, 'triggerPayout', [payout], chain.admin);
    table = await inspectEquityCapTable(reader, binding(chain));
    const holder = table.positions[1];
    expect(holder.shares).toBe(String(await chain.read(chain.equity, 'balanceOf', [chain.accounts[1]])));
    expect(holder.earned).toBe(String(await chain.read(chain.equity, 'earnedGrant', [id])));
    expect(holder.returnEntitlements).toBe(String(await chain.read(chain.equity, 'returnEntitlement', [payout, 2n])));
    expect(holder.unclaimedReturns).toBe(holder.returnEntitlements);
    await chain.send(chain.equity, 'resignGrant', [id], 1);
    await chain.send(chain.equity, 'claimReturn', [payout], 0);
    table = await inspectEquityCapTable(reader, binding(chain));
    expect(table.positions[1].grants[0]).toMatchObject({ unvested: '0', stopped: true });
    expect(BigInt(table.positions[1].grants[0].forfeited)).toBeGreaterThan(0n);
    expect(table.positions[0].unclaimedReturns).toBe('0');
    expect(table.fullyDilutedShares).toBe(String(BigInt(table.issuedShares) + BigInt(table.reservedShares)));
  }, 90_000);
  it('keeps V1 deployment compatibility and uses its grant and return event ABI', async () => {
    const chain = await equityEvm();
    const id = digest('cap-table-v1');
    const start = chain.now();
    await chain.callAs(chain.timelock.address, chain.equity, 'commitGrant', [id, chain.accounts[0], 500n, start, start + 100n]);
    chain.advance(50);
    const table = await inspectEquityCapTable(readerFor(chain), binding(chain));
    expect(table.contractVersion).toBe('1');
    expect(table.positions[0].shares).toBe('100000');
    expect(table.positions[0].committed).toBe('500');
    expect(table.positions[0].earned).toBe(String(await chain.read(chain.equity, 'earnedGrant', [id])));
    expect(table.positions[0].fullyDilutedPercent).toBe('100.00');
  }, 90_000);
});
