/** EVM/HTTP fixture tests need no Postgres; the unit runner owns their isolated lifecycle. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPublicClient, encodeFunctionData, http, recoverMessageAddress, stringToHex, type Hex } from 'viem';
import { startDaoHrTestChain } from '../../../../scripts/fixtures/dao-hr-test-chain';

let fixture: Awaited<ReturnType<typeof startDaoHrTestChain>>;
let client: ReturnType<typeof createPublicClient>;
async function request(method: string, params: unknown[] = []) {
  const response = await fetch(fixture.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const result = await response.json();
  if (result.error) throw new Error(result.error.message);
  return result.result;
}
beforeAll(async () => {
  vi.stubEnv('PAPERCUSP_VERIFY_TAURI_ISOLATED', '1');
  fixture = await startDaoHrTestChain();
  // The fixture deliberately mines several blocks immediately; use fresh head reads.
  client = createPublicClient({ cacheTime: 0, transport: http(fixture.url, { retryCount: 0 }) });
}, 120_000);
afterAll(async () => { await fixture?.stop(); vi.unstubAllEnvs(); });

describe('DAO HR isolated JSON-RPC test chain', () => {
  it('refuses boot without the isolated verification marker', async () => {
    vi.stubEnv('PAPERCUSP_VERIFY_TAURI_ISOLATED', '0');
    try { await expect(startDaoHrTestChain()).rejects.toThrow('requires explicit isolated verification'); }
    finally { vi.stubEnv('PAPERCUSP_VERIFY_TAURI_ISOLATED', '1'); }
  });

  it('exposes compiled V2 contracts and their actual genesis event through the production viem client', async () => {
    const blockNumber = await client.getBlockNumber();
    expect(await client.getChainId()).toBe(1);
    expect(await client.getCode({ address: fixture.equity.address, blockNumber })).not.toBe('0x');
    expect(await client.readContract({ ...fixture.equity, functionName: 'admin', blockNumber }))
      .toBe(fixture.accounts[fixture.admin]);
    expect(await client.readContract({ ...fixture.equity, functionName: 'totalSupply', blockNumber })).toBe(100_000n);
    const events = await client.getContractEvents({ ...fixture.equity, eventName: 'HolderRegistered',
      fromBlock: 0n, toBlock: blockNumber });
    expect(events).toHaveLength(1);
    expect(events[0]!.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('signs a real admin policy transaction and exposes canonical receipt, input, block and storage', async () => {
    const data = encodeFunctionData({ abi: fixture.equity.abi, functionName: 'setReturnPolicy', args: [500, 30 * 86400] });
    const hash = await request('eth_sendTransaction', [{ from: fixture.accounts[fixture.admin],
      to: fixture.equity.address, data, chainId: '0x1', value: '0x0' }]) as Hex;
    await request('evm_mine'); await request('evm_mine');
    const [transaction, receipt] = await Promise.all([
      client.getTransaction({ hash }), client.getTransactionReceipt({ hash }),
    ]);
    expect(transaction.from.toLowerCase()).toBe(fixture.accounts[fixture.admin]!.toLowerCase());
    expect(transaction.to?.toLowerCase()).toBe(fixture.equity.address.toLowerCase());
    expect(transaction.input).toBe(data);
    expect(transaction.chainId).toBe(1);
    expect(receipt.status).toBe('success');
    expect(receipt.transactionHash).toBe(hash);
    const rpcHead = BigInt(await request('eth_blockNumber'));
    expect(rpcHead).toBeGreaterThanOrEqual(receipt.blockNumber + 2n);
    expect(await client.getBlockNumber()).toBe(rpcHead);
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    expect(block.hash).toBe(receipt.blockHash);
    expect(block.timestamp).toBeGreaterThan(0n);
    expect(await client.readContract({ ...fixture.equity, functionName: 'returnRateBps' })).toBe(500);
    await expect(request('eth_sendTransaction', [{ from: fixture.accounts[1], to: fixture.equity.address, data }]))
      .rejects.toThrow('Forbidden');
    expect(await client.readContract({ ...fixture.equity, functionName: 'returnRateBps' })).toBe(500);
  });

  it('produces distinct recoverable wallet challenge signatures and refuses an unowned account', async () => {
    const message = 'Isolated DAO HR wallet challenge';
    for (const index of [0, 1]) {
      const signature = await request('personal_sign', [stringToHex(message), fixture.accounts[index]]) as Hex;
      expect(await recoverMessageAddress({ message, signature })).toBe(fixture.accounts[index]);
    }
    await expect(request('personal_sign', [stringToHex(message), '0x' + '9'.repeat(40)]))
      .rejects.toThrow('does not own');
  });

  it('retains actual receipt-block state after confirmations and later writes without changing the current head', async () => {
    const before = await client.getBlockNumber();
    const oldRate = await client.readContract({ ...fixture.equity, functionName: 'returnRateBps' });
    const data = encodeFunctionData({ abi: fixture.equity.abi, functionName: 'setReturnPolicy', args: [750, 30 * 86400] });
    const hash = await request('eth_sendTransaction', [{ from: fixture.accounts[fixture.admin], to: fixture.equity.address, data }]) as Hex;
    const receipt = await client.getTransactionReceipt({ hash });
    await request('evm_mine'); await request('evm_mine');
    expect(await client.readContract({ ...fixture.equity, functionName: 'returnRateBps', blockNumber: before })).toBe(oldRate);
    expect(await client.readContract({ ...fixture.equity, functionName: 'returnRateBps', blockNumber: receipt.blockNumber })).toBe(750);
    expect(await client.readContract({ ...fixture.equity, functionName: 'returnRateBps' })).toBe(750);
    expect(await client.getCode({ address: fixture.equity.address, blockNumber: receipt.blockNumber })).not.toBe('0x');
    expect((await client.getBlock({ blockNumber: before })).number).toBe(before);
    expect(await client.getBlockNumber()).toBeGreaterThanOrEqual(receipt.blockNumber + 2n);
  });

  it('fails closed on unrecorded historical storage and unsupported RPC methods', async () => {
    await expect(request('eth_getCode', [fixture.equity.address, '0x0'])).rejects.toThrow('Unknown historical EVM block');
    await expect(request('eth_sendRawTransaction', ['0x01'])).rejects.toThrow('Unsupported isolated test RPC');
  });

  it('restores state, nonce, time, blocks, receipts and logs between native calibration legs', async () => {
    const snapshotId = await request('evm_snapshot');
    const before = await request('eth_getBlockByNumber', ['latest', false]);
    const beforeNonce = await request('eth_getTransactionCount', [fixture.accounts[fixture.admin], 'latest']);
    const beforeRate = await client.readContract({ ...fixture.equity, functionName: 'returnRateBps' });
    const beforeLogs = await request('eth_getLogs', [{ address: fixture.equity.address, fromBlock: 'earliest' }]);
    const data = encodeFunctionData({ abi: fixture.equity.abi, functionName: 'setReturnPolicy', args: [900, 45 * 86400] });
    const send = () => request('eth_sendTransaction', [{ from: fixture.accounts[fixture.admin], to: fixture.equity.address, data }]);
    const hash = await send();
    const receipt = await request('eth_getTransactionReceipt', [hash]);
    await request('evm_increaseTime', [86400]);
    await request('evm_mine');
    expect(await client.readContract({ ...fixture.equity, functionName: 'returnRateBps' })).toBe(900);
    expect(await request('eth_getTransactionCount', [fixture.accounts[fixture.admin], 'latest'])).not.toBe(beforeNonce);
    expect(BigInt(await request('eth_blockNumber'))).toBeGreaterThan(BigInt(before.number));

    expect(await request('evm_revert', [snapshotId])).toBe(true);
    expect(await request('eth_getBlockByNumber', ['latest', false])).toEqual(before);
    expect(await request('eth_getTransactionCount', [fixture.accounts[fixture.admin], 'latest'])).toBe(beforeNonce);
    expect(await client.readContract({ ...fixture.equity, functionName: 'returnRateBps' })).toBe(beforeRate);
    expect(await request('eth_getTransactionByHash', [hash])).toBeNull();
    expect(await request('eth_getTransactionReceipt', [hash])).toBeNull();
    expect(await request('eth_getLogs', [{ address: fixture.equity.address, fromBlock: 'earliest' }])).toEqual(beforeLogs);
    await expect(request('eth_getBlockByNumber', [receipt.blockNumber, false])).rejects.toThrow('Unknown historical EVM block');
    await expect(client.readContract({ ...fixture.equity, functionName: 'returnRateBps', blockNumber: BigInt(receipt.blockNumber) }))
      .rejects.toThrow('Unknown historical EVM block');
    expect(await request('evm_revert', [snapshotId])).toBe(false);

    // Resetting nonce, block and time makes the next leg's signed transaction identical.
    const replaySnapshot = await request('evm_snapshot');
    expect(await send()).toBe(hash);
    expect(await request('eth_getTransactionReceipt', [hash])).toEqual(receipt);
    expect(await request('evm_revert', [replaySnapshot])).toBe(true);
  });

  it('invalidates reverted and newer snapshots while preserving an older checkpoint', async () => {
    const first = await request('evm_snapshot');
    const firstHead = await request('eth_blockNumber');
    await request('evm_mine');
    const second = await request('evm_snapshot');
    const secondHead = await request('eth_blockNumber');
    const third = await request('evm_snapshot');
    await request('evm_mine');
    expect(await request('evm_revert', [second])).toBe(true);
    expect(await request('eth_blockNumber')).toBe(secondHead);
    expect(await request('evm_revert', [second])).toBe(false);
    expect(await request('evm_revert', [third])).toBe(false);
    expect(await request('evm_revert', ['0xdead'])).toBe(false);
    expect(await request('evm_revert', [first])).toBe(true);
    expect(await request('eth_blockNumber')).toBe(firstHead);
    const next = await request('evm_snapshot');
    expect(BigInt(next)).toBeGreaterThan(BigInt(third));
    expect(await request('evm_revert', [next])).toBe(true);
  });

  it('returns a protocol error for malformed requests and continues serving the chain', async () => {
    for (const body of [null, 42, { jsonrpc: '2.0', id: 8, method: 'eth_chainId', params: 'invalid' }]) {
      const response = await fetch(fixture.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body) });
      expect((await response.json()).error.code).toBe(-32600);
      expect(await client.getChainId()).toBe(1);
    }
  });
});
