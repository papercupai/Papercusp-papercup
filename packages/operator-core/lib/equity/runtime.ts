/** ABI adapter only: no signer, private-key handling, broadcasting or custody. */
import { createHash } from 'node:crypto';
import { encodeDeployData, encodeFunctionData, getAddress, isAddress } from 'viem/utils';
import type { Abi, AbiParameter, Address, Hex } from 'viem';
import artifactsJson from './artifacts.json';
import type { EquityArtifacts, EquityContractName } from './compile';

export const equityArtifacts = artifactsJson as unknown as EquityArtifacts;
const hash = (data: string) => createHash('sha256').update(data).digest('hex');
function address(value: string): Address {
  if (!isAddress(value) || /^0x0{40}$/i.test(value)) throw new Error('A nonzero EVM address is required');
  return getAddress(value);
}
function argsFor(parameters: readonly AbiParameter[], values: unknown[]): unknown[] {
  if (values.length !== parameters.length) throw new Error('ABI argument count mismatch');
  const convert = (p: AbiParameter, v: unknown): unknown => {
    const array = /^(.*)\[([0-9]*)\]$/.exec(p.type);
    if (array) {
      if (!Array.isArray(v) || v.length > 256 || (array[2] && v.length !== Number(array[2]))) throw new Error('Invalid ABI array');
      return v.map(item => convert({ ...p, type: array[1] } as AbiParameter, item));
    }
    if (/^u?int/.test(p.type)) {
      if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new Error('Use a decimal string for large integers');
      if (!['string', 'bigint', 'number'].includes(typeof v) || !/^-?[0-9]+$/.test(String(v))) throw new Error('Invalid ABI integer');
      return BigInt(String(v));
    }
    if (p.type === 'address') return address(String(v));
    if (p.type === 'tuple' && 'components' in p) {
      if (!Array.isArray(v)) throw new Error('ABI tuples require arrays');
      return argsFor(p.components, v);
    }
    if (p.type === 'bool' && typeof v !== 'boolean') throw new Error('Invalid ABI boolean');
    if ((p.type === 'string' || p.type.startsWith('bytes')) && typeof v !== 'string') throw new Error('Invalid ABI string');
    return v;
  };
  return parameters.map((p, i) => convert(p, values[i]));
}
export interface UnsignedEquityTransaction { chainId: number; from: Address; to?: Address; value: '0'; data: Hex; requiresWalletSignature: true }
export function prepareEquityTransaction(input: { chainId: number; from: string; contract: EquityContractName; to?: string; functionName?: string; args: unknown[] }): UnsignedEquityTransaction {
  if (!Number.isSafeInteger(input.chainId) || input.chainId < 1) throw new Error('Invalid chain id');
  const artifact = equityArtifacts.contracts[input.contract];
  if (!artifact) throw new Error('Unknown equity contract');
  const from = address(input.from);
  let data: Hex;
  if (!input.to) {
    if (input.functionName) throw new Error('Deployment cannot name a function');
    const constructor = artifact.abi.find(f => f.type === 'constructor');
    data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: argsFor(constructor?.inputs ?? [], input.args) });
  } else {
    const fn = artifact.abi.find(f => f.type === 'function' && f.name === input.functionName);
    if (!fn || fn.type !== 'function' || ['view', 'pure'].includes(fn.stateMutability)) throw new Error('Unknown or read-only action');
    data = encodeFunctionData({ abi: artifact.abi, functionName: fn.name, args: argsFor(fn.inputs, input.args) });
  }
  return { chainId: input.chainId, from, ...(input.to ? { to: address(input.to) } : {}), value: '0', data, requiresWalletSignature: true };
}

/** Hex pages are bounded before the result door. Concatenate pages at nextOffset,
 * verify sha256, then sign the complete transaction; a page is never signable. */
export function transactionPage(tx: UnsignedEquityTransaction, offset = 0, limit = 2048) {
  if (!Number.isInteger(offset) || offset < 0 || offset > tx.data.length || !Number.isInteger(limit) || limit < 2 || limit > 2048) throw new Error('Invalid transaction page');
  const { data, ...transaction } = tx;
  const end = Math.min(data.length, offset + limit);
  return { transaction, payload: { encoding: 'hex-text', chunk: data.slice(offset, end), offset, nextOffset: end < data.length ? end : null,
    totalChars: data.length, sha256: hash(data), complete: offset === 0 && end === data.length },
    ...(offset === 0 && end === data.length ? { unsignedTransaction: tx } : {}) };
}
export function equityArtifactPage(contract: EquityContractName, component: 'abi' | 'bytecode' = 'abi', offset = 0, limit = 2048) {
  const a = equityArtifacts.contracts[contract];
  if (!a || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 2 || limit > 2048) throw new Error('Invalid artifact page');
  const value = component === 'abi' ? JSON.stringify(a.abi) : a.bytecode;
  if (offset > value.length) throw new Error('Invalid artifact offset');
  const end = Math.min(value.length, offset + limit);
  return { contract, component, chunk: value.slice(offset, end), offset, nextOffset: end < value.length ? end : null, totalChars: value.length, sha256: hash(value), sourceFingerprint: equityArtifacts.sourceFingerprint };
}

export interface EquityChainReader {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getCode(input: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>;
  readContract(input: { address: Address; abi: Abi; functionName: string; args?: unknown[]; blockNumber: bigint }): Promise<unknown>;
}
export async function inspectEquity(reader: EquityChainReader, input: { chainId: number; equity: string; governor: string; timelock: string; holder?: string; blockNumber?: bigint }) {
  const chainId = await reader.getChainId();
  if (chainId !== input.chainId) throw new Error('RPC chain id differs from requested chain');
  const blockNumber = input.blockNumber ?? await reader.getBlockNumber();
  const addresses = { PapercuspEquity: address(input.equity), EquityGovernor: address(input.governor), EquityTimelock: address(input.timelock) };
  const code = await Promise.all(Object.values(addresses).map(addr => reader.getCode({ address: addr, blockNumber })));
  if (code.some(v => !v || v === '0x')) throw new Error('One or more equity contracts are not deployed');
  // ERC-5267 reports the deployed token version; never infer it from the local artifact.
  const domain = await reader.readContract({ address: addresses.PapercuspEquity, abi: equityArtifacts.contracts.PapercuspEquity.abi, functionName: 'eip712Domain', blockNumber }) as readonly unknown[];
  const version = String(domain[2]);
  if (version !== '1' && version !== '2') throw new Error('Unsupported equity deployment version');
  const abiNames = { PapercuspEquity: version === '2' ? 'PapercuspEquityV2' : 'PapercuspEquity', EquityGovernor: version === '2' ? 'EquityGovernorV2' : 'EquityGovernor', EquityTimelock: 'EquityTimelock' } as const;
  const read = (contract: keyof typeof addresses, functionName: string, args?: unknown[]) => reader.readContract({ address: addresses[contract], abi: equityArtifacts.contracts[abiNames[contract]].abi, functionName, args, blockNumber });
  const [issuerCommitment, legalRegisterURI, genesisActivated, supply, reserved, cap, authority, boundEquity, boundLock, boundGovernor, delay] = await Promise.all([
    read('PapercuspEquity', 'issuerCommitment'), read('PapercuspEquity', 'legalRegisterURI'), read('PapercuspEquity', 'genesisActivated'),
    read('PapercuspEquity', 'totalSupply'), read('PapercuspEquity', 'reservedSupply'), read('PapercuspEquity', 'supplyCap'), read('PapercuspEquity', 'authority'),
    read('EquityGovernor', 'equity'), read('EquityGovernor', 'timelock'), read('EquityTimelock', 'governor'), read('EquityTimelock', 'getMinDelay'),
  ]);
  const governanceBound = String(authority).toLowerCase() === addresses.EquityTimelock.toLowerCase() &&
    String(boundEquity).toLowerCase() === addresses.PapercuspEquity.toLowerCase() && String(boundLock).toLowerCase() === addresses.EquityTimelock.toLowerCase() &&
    String(boundGovernor).toLowerCase() === addresses.EquityGovernor.toLowerCase();
  let holder;
  if (input.holder) {
    const wallet = address(input.holder);
    const id = await read('PapercuspEquity', 'memberId', [wallet]);
    holder = { wallet, id: String(id), balance: String(await read('PapercuspEquity', 'balanceOf', [wallet])), register: id === 0n ? null : await read('PapercuspEquity', 'holders', [id]) };
  }
  return { chainId, version, blockNumber: String(blockNumber), addresses, issuer: { commitment: issuerCommitment, legalRegisterURI, issuerAttested: genesisActivated === true,
    legalEffectiveness: 'requires-verification-against-issuer-documents', publicTrading: 'not-established' },
    issuedShares: String(supply), reservedShares: String(reserved), supplyCap: String(cap), supplyInvariant: BigInt(String(supply)) + BigInt(String(reserved)) <= BigInt(String(cap)),
    governanceBound, timelockDelaySeconds: String(delay), ...(holder ? { holder } : {}),
    codeEvidence: { present: true, hashes: code.map(v => hash(v!)), sourceAuthenticity: 'not-established-by-presence-or-ABI-reads' },
    sourceFingerprint: equityArtifacts.sourceFingerprint, returns: 'additional-equity' };
}
