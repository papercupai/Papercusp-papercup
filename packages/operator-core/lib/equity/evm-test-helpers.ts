/** Actual signed Cancun EVM transactions; no mocked contract storage or behavior. */
import { Common, Mainnet, Hardfork } from '@ethereumjs/common';
import { createBlock } from '@ethereumjs/block';
import { createLegacyTx } from '@ethereumjs/tx';
import { createAccount, createAddressFromPrivateKey, createAddressFromString, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { createVM, runTx } from '@ethereumjs/vm';
import { encodeDeployData, encodeFunctionData, decodeFunctionResult, decodeErrorResult, decodeEventLog, keccak256, stringToHex, getAddress, type Abi, type Address, type Hex } from 'viem';
import { readFileSync } from 'node:fs';
import { compileEquityContracts, type EquityArtifacts, type EquityContractName } from './compile';

// The suites run the committed, reproducible artifacts. PAPERCUSP_EQUITY_COMPILE_FROM_SOURCE=1 compiles
// the .sol sources in memory instead (never writing artifacts.json), so scripts/mutation-probe.sh can show
// a mutated contract to the EVM tests: its overlay bind-mounts the mutant over the source path, and a
// test that read only artifacts.json would never see it and every contract probe would falsely survive.
export const artifacts: EquityArtifacts = process.env.PAPERCUSP_EQUITY_COMPILE_FROM_SOURCE === '1'
  ? compileEquityContracts()
  : JSON.parse(readFileSync(new URL('./artifacts.json', import.meta.url), 'utf8')) as EquityArtifacts;
export const digest = (s: string) => keccak256(stringToHex(s));
export const TERMS = digest('Fixture issuer signed ownership-register documents');
export type Contract = { address: Address; abi: Abi };
export type Action = { contract: Contract; name: string; args?: unknown[] };

/** One in-memory Cancun chain with eight funded signing accounts. */
export async function evmChain() {
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun });
  const vm = await createVM({ common });
  const keys = Array.from({ length: 8 }, (_, i) => hexToBytes(('0x' + (i + 1).toString(16).padStart(64, '0')) as Hex));
  const accounts = keys.map(k => getAddress(createAddressFromPrivateKey(k).toString()));
  for (const address of accounts) await vm.stateManager.putAccount(createAddressFromString(address), createAccount({ balance: 10n ** 26n }));
  let time = 1_800_000_000n;
  let number = 1n;
  const logs: Array<{ address: Address; data: Hex; topics: Hex[]; blockNumber: bigint }> = [];
  const block = () => createBlock({ header: { number, timestamp: time, gasLimit: 60_000_000n, baseFeePerGas: 1n } }, { common });
  const transactions = new Map<Hex, { from: Address; to: Address | null; input: Hex; value: bigint; chainId: number }>();
  const receipts = new Map<Hex, { status: string; blockNumber: bigint; blockHash: Hex; transactionHash: Hex; logs: Array<{ address: Address; data: Hex; topics: Hex[] }> }>();
  const blocks = new Map<bigint, { hash: Hex; timestamp: bigint }>();
  let lastTransactionHash: Hex | null = null;
  const error = (abi: Abi, data: Hex) => {
    try { return decodeErrorResult({ abi, data }).errorName; } catch { return data; }
  };
  async function raw(data: Hex, to?: Address, sender = 0, abi: Abi = []) {
    ++time; ++number;
    const account = await vm.stateManager.getAccount(createAddressFromString(accounts[sender]));
    const tx = createLegacyTx({ nonce: account!.nonce, gasLimit: 50_000_000n, gasPrice: 10n, data, ...(to ? { to } : {}) }, { common }).sign(keys[sender]);
    const executedBlock = block();
    const result = await runTx(vm, { tx, block: executedBlock });
    const transactionHash = bytesToHex(tx.hash()) as Hex, blockHash = bytesToHex(executedBlock.hash()) as Hex;
    lastTransactionHash = transactionHash;
    transactions.set(transactionHash, { from: accounts[sender]!, to: to ?? null, input: data, value: 0n, chainId: 1 });
    blocks.set(number, { hash: blockHash, timestamp: time });
    receipts.set(transactionHash, { status: result.execResult.exceptionError ? 'reverted' : 'success', blockNumber: number, blockHash, transactionHash,
      logs: (result.execResult.logs ?? []).map(([address,topics,data]) => ({ address: bytesToHex(address) as Address, data: bytesToHex(data) as Hex, topics: topics.map(topic => bytesToHex(topic) as Hex) })) });
    const output = bytesToHex(result.execResult.returnValue) as Hex;
    if (result.execResult.exceptionError) throw new Error('EVM reverted: ' + error(abi, output) + ' (' + result.execResult.exceptionError.error + ')');
    for (const [address, topics, data] of result.execResult.logs ?? []) logs.push({ address: bytesToHex(address) as Address,
      data: bytesToHex(data) as Hex, topics: topics.map(topic => bytesToHex(topic) as Hex), blockNumber: number });
    return { result, output, transactionHash };
  }
  async function deploy(name: EquityContractName, args: unknown[] = []): Promise<Contract> {
    const artifact = artifacts.contracts[name];
    const { result } = await raw(encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args }));
    if (!result.createdAddress) throw new Error('No deployed address');
    return { address: result.createdAddress.toString() as Address, abi: artifact.abi };
  }
  async function send(c: Contract, name: string, args: unknown[] = [], sender = 0) {
    const { output } = await raw(encodeFunctionData({ abi: c.abi, functionName: name, args }), c.address, sender, c.abi);
    const fn = c.abi.find(f => f.type === 'function' && f.name === name);
    return fn && 'outputs' in fn && fn.outputs.length ? decodeFunctionResult({ abi: c.abi, functionName: name, data: output }) : undefined;
  }
  /** A state-changing message call whose sender is any address (e.g. the timelock executor). */
  async function callAs(caller: Address, c: Contract, name: string, args: unknown[] = []) {
    ++time; ++number;
    const result = await vm.evm.runCall({ to: createAddressFromString(c.address), caller: createAddressFromString(caller),
      data: hexToBytes(encodeFunctionData({ abi: c.abi, functionName: name, args })), gasLimit: 50_000_000n, block: block() });
    const output = bytesToHex(result.execResult.returnValue) as Hex;
    if (result.execResult.exceptionError) throw new Error('EVM reverted: ' + error(c.abi, output) + ' (' + result.execResult.exceptionError.error + ')');
    for (const [address, topics, data] of result.execResult.logs ?? []) logs.push({ address: bytesToHex(address) as Address,
      data: bytesToHex(data) as Hex, topics: topics.map(topic => bytesToHex(topic) as Hex), blockNumber: number });
  }
  async function read(c: Contract, name: string, args: unknown[] = []) {
    const result = await vm.evm.runCall({ to: createAddressFromString(c.address), caller: createAddressFromString(accounts[0]),
      data: hexToBytes(encodeFunctionData({ abi: c.abi, functionName: name, args })), gasLimit: 50_000_000n, block: block(), isStatic: true });
    const output = bytesToHex(result.execResult.returnValue) as Hex;
    if (result.execResult.exceptionError) throw new Error('EVM read reverted: ' + error(c.abi, output));
    return decodeFunctionResult({ abi: c.abi, functionName: name, data: output });
  }
  const advance = (seconds: bigint | number) => { time += BigInt(seconds); ++number; };
  const now = () => time;
  const blockNumber = () => number;
  async function getContractEvents(input: { address: Address; abi: Abi; eventName: string; fromBlock: bigint; toBlock: bigint }) {
    return logs.filter(log => log.address.toLowerCase() === input.address.toLowerCase() && log.blockNumber >= input.fromBlock && log.blockNumber <= input.toBlock)
      .flatMap(log => {
        try {
          const decoded = decodeEventLog({ abi: input.abi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
          return decoded.eventName === input.eventName ? [{ args: decoded.args }] : [];
        } catch { return []; } // unrelated events use a different ABI; amounts still read from storage
      });
  }
  const getTransaction = async ({ hash }: { hash: Hex }) => { const tx = transactions.get(hash); if (!tx) throw new Error('Unknown fixture transaction'); return tx; };
  const getTransactionReceipt = async ({ hash }: { hash: Hex }) => { const receipt = receipts.get(hash); if (!receipt) throw new Error('Unknown fixture receipt'); return receipt; };
  const getBlock = async ({ blockNumber }: { blockNumber: bigint }) => {
    const saved = blocks.get(blockNumber); if (saved) return saved;
    if (blockNumber === number) return { hash: bytesToHex(block().hash()) as Hex, timestamp: time };
    throw new Error('Unknown fixture block');
  };
  return { vm, accounts, raw, deploy, send, callAs, read, advance, now, blockNumber, getContractEvents,
    getTransaction, getTransactionReceipt, getBlock, lastTransactionHash: () => lastTransactionHash };
}
type Chain = Awaited<ReturnType<typeof evmChain>>;

/** Propose → vote → queue → execute through a bound governor and timelock. */
function governanceOf(c: Chain, equity: Contract, governor: Contract, timelock: Contract) {
  const actionData = (actions: Action[]) => ({ targets: actions.map(a => a.contract.address), values: actions.map(() => 0n),
    calldatas: actions.map(a => encodeFunctionData({ abi: a.contract.abi, functionName: a.name, args: a.args ?? [] })) });
  async function propose(actions: Action[], description: string, sender = 0) {
    const data = actionData(actions);
    const id = await c.send(governor, 'propose', [data.targets, data.values, data.calldatas, description], sender) as bigint;
    return { ...data, descriptionHash: digest(description), id };
  }
  async function finish(proposal: Awaited<ReturnType<typeof propose>>, voters = [0]) {
    c.advance(61);
    for (const voter of voters) await c.send(governor, 'castVote', [proposal.id, 1], voter);
    c.advance(Number(await c.read(governor, 'votingPeriod')) + 1);
    await c.send(governor, 'queue', [proposal.targets, proposal.values, proposal.calldatas, proposal.descriptionHash]);
    c.advance(Number(await c.read(timelock, 'getMinDelay')) + 1);
    await c.send(governor, 'execute', [proposal.targets, proposal.values, proposal.calldatas, proposal.descriptionHash]);
  }
  let sequence = 0;
  async function govern(actions: Action[], voters = [0]) { const p = await propose(actions, 'Fixture governance action ' + ++sequence); await finish(p, voters); return p; }
  async function register(sender: number, voters = [0]) {
    await govern([{ contract: equity, name: 'registerHolder', args: [c.accounts[sender], digest('holder-' + sender)] }], voters);
    await c.send(equity, 'acceptTerms', [TERMS], sender);
  }
  return { propose, finish, govern, register, actionData };
}

export async function equityEvm() {
  const c = await evmChain();
  const equity = await c.deploy('PapercuspEquity', [TERMS, 'https://issuer.example/legal/register-v1', 1_000_000n, 100_000n]);
  await c.send(equity, 'activateGenesis', [digest('founder-identity'), TERMS]);
  const timelock = await c.deploy('EquityTimelock', [86400n]);
  const governor = await c.deploy('EquityGovernor', [equity.address, timelock.address]);
  await c.send(timelock, 'initializeGovernor', [governor.address]);
  await c.send(equity, 'bindGovernance', [governor.address, timelock.address]);
  c.advance(2);
  return { ...c, equity, governor, timelock, ...governanceOf(c, equity, governor, timelock) };
}

/** Account index of the bounded admin in the version-2 fixture (never a holder). */
export const V2_ADMIN = 7;
export async function equityV2Evm() {
  const c = await evmChain();
  const equity = await c.deploy('PapercuspEquityV2', [TERMS, 'https://issuer.example/legal/register-v2', 1_000_000n, 100_000n]);
  await c.send(equity, 'activateGenesis', [digest('founder-identity'), TERMS]);
  const timelock = await c.deploy('EquityTimelock', [86400n]);
  const governor = await c.deploy('EquityGovernorV2', [equity.address, timelock.address]);
  await c.send(timelock, 'initializeGovernor', [governor.address]);
  await c.send(equity, 'bindGovernance', [governor.address, timelock.address, c.accounts[V2_ADMIN]]);
  c.advance(2);
  return { ...c, equity, governor, timelock, admin: V2_ADMIN, ...governanceOf(c, equity, governor, timelock) };
}
