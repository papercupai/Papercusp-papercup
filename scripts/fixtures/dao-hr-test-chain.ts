/** Loopback JSON-RPC transport for the maintained, signed EthereumJS equity fixture. */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createBlock } from '@ethereumjs/block';
import { bytesToHex, createAddressFromString, hexToBytes } from '@ethereumjs/util';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { artifacts, digest, evmChain, TERMS, V2_ADMIN } from '../../packages/operator-core/lib/equity/evm-test-helpers';

type RpcRequest = { jsonrpc: '2.0'; id: string | number | null; method: string; params?: unknown[] };
function isRpcRequest(value: unknown): value is RpcRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const call = value as Partial<RpcRequest>;
  return call.jsonrpc === '2.0' && typeof call.method === 'string' &&
    (call.id === null || typeof call.id === 'string' || typeof call.id === 'number') &&
    (call.params === undefined || Array.isArray(call.params));
}
const quantity = (value: number | bigint) => '0x' + BigInt(value).toString(16);
const zeroHash = '0x' + '0'.repeat(64);

export async function startDaoHrTestChain() {
  if (process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED !== '1')
    throw new Error('DAO HR test chain requires explicit isolated verification');
  // Reuse the existing actual EVM, compiler/artifacts, accounts and contract bootstrap.
  const chain = await evmChain();
  const snapshots = new Map<bigint, { root: Uint8Array; timestamp: bigint; hash: Hex }>();
  async function snapshot() {
    const blockNumber = chain.blockNumber(), block = await chain.getBlock({ blockNumber });
    snapshots.set(blockNumber, { root: (await chain.vm.stateManager.getStateRoot()).slice(), timestamp: chain.now(), hash: block.hash });
  }
  await snapshot();
  const transactions = new Map<Hex, Record<string, unknown>>();
  const receipts = new Map<Hex, Record<string, unknown>>();
  const logs: Array<Record<string, unknown>> = [];
  let checkpointSequence = 0n;
  const checkpoints = new Map<string, { sequence: bigint; restoreChain: () => Promise<void>;
    snapshots: typeof snapshots; transactions: typeof transactions; receipts: typeof receipts; logs: typeof logs }>();
  async function record(hash: Hex) {
    await snapshot();
    const [tx, receipt] = await Promise.all([chain.getTransaction({ hash }), chain.getTransactionReceipt({ hash })]);
    const account = await chain.vm.stateManager.getAccount(createAddressFromString(tx.from));
    const position = { blockHash: receipt.blockHash, blockNumber: quantity(receipt.blockNumber), transactionIndex: '0x0' };
    transactions.set(hash, { ...position, hash, from: tx.from, to: tx.to, input: tx.input,
      value: quantity(tx.value), chainId: quantity(tx.chainId), nonce: quantity(account!.nonce - 1n),
      gas: quantity(50_000_000), gasPrice: '0xa', type: '0x0' });
    const transactionLogs = receipt.logs.map((log, index) => ({ ...log, ...position,
      logIndex: quantity(index), transactionHash: hash, removed: false }));
    logs.push(...transactionLogs);
    receipts.set(hash, { ...position, transactionHash: hash, from: tx.from, to: tx.to,
      contractAddress: null, cumulativeGasUsed: '0x0', gasUsed: '0x0', effectiveGasPrice: '0xa',
      logsBloom: '0x' + '0'.repeat(512), logs: transactionLogs,
      status: receipt.status === 'success' ? '0x1' : '0x0', type: '0x0' });
  }
  async function saveLast() { await record(chain.lastTransactionHash()!); }
  const equity = await chain.deploy('PapercuspEquityV2', [TERMS, 'https://issuer.example/legal/register-v2', 1_000_000n, 100_000n]);
  await saveLast();
  await chain.send(equity, 'activateGenesis', [digest('founder-identity'), TERMS]); await saveLast();
  const timelock = await chain.deploy('EquityTimelock', [86400n]); await saveLast();
  const governor = await chain.deploy('EquityGovernorV2', [equity.address, timelock.address]); await saveLast();
  await chain.send(timelock, 'initializeGovernor', [governor.address]); await saveLast();
  await chain.send(equity, 'bindGovernance', [governor.address, timelock.address, chain.accounts[V2_ADMIN]]); await saveLast();
  chain.advance(2);
  await snapshot();

  const number = (tag: unknown) => tag === undefined || tag === 'latest' || tag === 'pending'
    ? chain.blockNumber() : tag === 'earliest' ? 0n : BigInt(String(tag));
  async function atBlock<T>(tag: unknown, read: (blockNumber: bigint, timestamp: bigint) => Promise<T>): Promise<T> {
    const blockNumber = number(tag), saved = snapshots.get(blockNumber);
    if (!saved) throw new Error('Unknown historical EVM block');
    const previousRoot = await chain.vm.stateManager.getStateRoot();
    try {
      await chain.vm.stateManager.setStateRoot(saved.root);
      return await read(blockNumber, saved.timestamp);
    } finally { await chain.vm.stateManager.setStateRoot(previousRoot); }
  }
  async function dispatch(method: string, params: unknown[] = []): Promise<unknown> {
    if (method === 'evm_snapshot') {
      const sequence = ++checkpointSequence, id = quantity(sequence);
      checkpoints.set(id, { sequence, restoreChain: await chain.snapshot(), snapshots: new Map(snapshots),
        transactions: new Map(transactions), receipts: new Map(receipts), logs: logs.slice() });
      return id;
    }
    if (method === 'evm_revert') {
      const saved = typeof params[0] === 'string' ? checkpoints.get(params[0]) : undefined;
      if (!saved) return false;
      await saved.restoreChain();
      snapshots.clear(); for (const [key, value] of saved.snapshots) snapshots.set(key, value);
      transactions.clear(); for (const [key, value] of saved.transactions) transactions.set(key, value);
      receipts.clear(); for (const [key, value] of saved.receipts) receipts.set(key, value);
      logs.splice(0, logs.length, ...saved.logs);
      // Match development-chain semantics: reverting consumes this and all later snapshots.
      for (const [id, checkpoint] of checkpoints) if (checkpoint.sequence >= saved.sequence) checkpoints.delete(id);
      return true;
    }
    if (method === 'eth_chainId') return '0x1';
    if (method === 'net_version') return '1';
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return chain.accounts;
    if (method === 'eth_blockNumber') return quantity(chain.blockNumber());
    if (method === 'eth_gasPrice') return '0xa';
    if (method === 'eth_getTransactionByHash') return transactions.get(params[0] as Hex) ?? null;
    if (method === 'eth_getTransactionReceipt') return receipts.get(params[0] as Hex) ?? null;
    if (method === 'eth_getCode') {
      return atBlock(params[1], async () => bytesToHex(await chain.vm.stateManager.getCode(createAddressFromString(params[0] as Address))));
    }
    if (method === 'eth_getBalance' || method === 'eth_getTransactionCount') {
      return atBlock(params[1], async () => {
        const account = await chain.vm.stateManager.getAccount(createAddressFromString(params[0] as Address));
        return quantity((method === 'eth_getBalance' ? account?.balance : account?.nonce) ?? 0n);
      });
    }
    if (method === 'eth_call') {
      return atBlock(params[1], async (blockNumber, timestamp) => {
      const input = params[0] as { to: Address; from?: Address; data?: Hex; value?: Hex };
      const block = createBlock({ header: { number: blockNumber, timestamp,
        gasLimit: 60_000_000n, baseFeePerGas: 1n } }, { common: chain.vm.common });
      const result = await chain.vm.evm.runCall({ to: createAddressFromString(input.to),
        caller: createAddressFromString(input.from ?? chain.accounts[0]!), data: hexToBytes(input.data ?? '0x'),
        value: BigInt(input.value ?? '0x0'), gasLimit: 50_000_000n, block, isStatic: true });
      if (result.execResult.exceptionError) throw new Error('EVM call reverted: ' + bytesToHex(result.execResult.returnValue));
      return bytesToHex(result.execResult.returnValue);
      });
    }
    if (method === 'eth_sendTransaction') {
      const input = params[0] as { from: Address; to?: Address; data?: Hex; value?: Hex; chainId?: Hex };
      const sender = chain.accounts.findIndex(account => account.toLowerCase() === input.from.toLowerCase());
      if (sender < 0) throw new Error('The test wallet does not own this account');
      if (BigInt(input.value ?? '0x0') !== 0n) throw new Error('This equity fixture supports zero-value transactions only');
      if (input.chainId !== undefined && BigInt(input.chainId) !== 1n) throw new Error('Wrong test chain');
      const abi = input.to?.toLowerCase() === equity.address.toLowerCase() ? equity.abi
        : input.to?.toLowerCase() === governor.address.toLowerCase() ? governor.abi : timelock.abi;
      // raw() signs the actual transaction with the matching maintained fixture account.
      try {
        const result = await chain.raw(input.data ?? '0x', input.to, sender, abi);
        await record(result.transactionHash); return result.transactionHash;
      } catch (error) {
        await saveLast(); throw error;
      }
    }
    if (method === 'personal_sign') {
      const [message, address] = params as [Hex, Address];
      const index = chain.accounts.findIndex(account => account.toLowerCase() === address.toLowerCase());
      if (index < 0) throw new Error('The test wallet does not own this account');
      // Derive the same test-only key convention as evmChain, never a host credential.
      const account = privateKeyToAccount(('0x' + (index + 1).toString(16).padStart(64, '0')) as Hex);
      return account.signMessage({ message: { raw: message } });
    }
    if (method === 'eth_getBlockByNumber') {
      const blockNumber = number(params[0]);
      const saved = snapshots.get(blockNumber);
      if (!saved) throw new Error('Unknown historical EVM block');
      return { number: quantity(blockNumber), hash: saved.hash, timestamp: quantity(saved.timestamp),
        parentHash: zeroHash, nonce: '0x0000000000000000', sha3Uncles: zeroHash,
        logsBloom: '0x' + '0'.repeat(512), transactionsRoot: zeroHash, stateRoot: bytesToHex(saved.root),
        receiptsRoot: zeroHash, miner: '0x' + '0'.repeat(40), difficulty: '0x0', totalDifficulty: '0x0',
        extraData: '0x', size: '0x0', gasLimit: quantity(60_000_000), gasUsed: '0x0',
        baseFeePerGas: '0x1', transactions: [], uncles: [] };
    }
    if (method === 'eth_getLogs') {
      const filter = params[0] as { address?: Address | Address[]; fromBlock?: Hex; toBlock?: Hex;
        topics?: Array<Hex | Hex[] | null> };
      const addresses = filter.address ? [filter.address].flat().map(address => address.toLowerCase()) : null;
      return logs.filter(log => (!addresses || addresses.includes(String(log.address).toLowerCase())) &&
        BigInt(String(log.blockNumber)) >= number(filter.fromBlock ?? 'earliest') &&
        BigInt(String(log.blockNumber)) <= number(filter.toBlock) &&
        (filter.topics ?? []).every((topic, index) => topic === null ||
          [topic].flat().some(value => value.toLowerCase() === String((log.topics as Hex[])[index]).toLowerCase())));
    }
    if (method === 'evm_increaseTime') { chain.advance(BigInt(String(params[0]))); await snapshot(); return params[0]; }
    if (method === 'evm_mine') { chain.advance(1); await snapshot(); return '0x0'; }
    throw new Error('Unsupported isolated test RPC method: ' + method);
  }
  // Serialize calls so concurrent product reads cannot race a signed state transition.
  let queue = Promise.resolve();
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    response.setHeader('Content-Type', 'application/json');
    let body = '';
    for await (const chunk of request) {
      body += String(chunk);
      if (body.length > 1_048_576) { response.writeHead(413).end(); return; }
    }
    let input: unknown;
    try { input = JSON.parse(body); }
    catch { response.writeHead(400).end(JSON.stringify({ error: { code: -32700, message: 'Invalid JSON' } })); return; }
    const calls = Array.isArray(input) && input.length ? input : [input];
    const operation = queue.then(async () => {
      const results = [];
      for (const call of calls) {
        if (!isRpcRequest(call)) {
          results.push({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC request' } });
          continue;
        }
        const id = call.id;
        try {
          results.push({ jsonrpc: '2.0', id, result: await dispatch(call.method, call.params) });
        } catch (error) {
          results.push({ jsonrpc: '2.0', id,
            error: { code: -32000, message: error instanceof Error ? error.message : 'Test RPC failed' } });
        }
      }
      response.end(JSON.stringify(Array.isArray(input) ? results : results[0]));
    });
    queue = operation.catch(error => { response.destroy(error instanceof Error ? error : undefined); });
    await queue;
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test RPC has no loopback address');
  return { url: 'http://127.0.0.1:' + address.port, accounts: chain.accounts, equity, governor, timelock,
    admin: V2_ADMIN, termsHash: TERMS, artifacts,
    async stop() { await queue; await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
