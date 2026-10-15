/** P-011: public equity positions, derived from contract views at one block.
 * Events enumerate mapping keys only; all amounts come from current contract storage.
 * Missing event history cannot produce a plausible partial table: reserved shares
 * must reconcile exactly to the enumerated grants and return entitlements. */
import type { Abi, Address, Hex } from 'viem';
import { equityArtifacts, inspectEquity, type EquityChainReader } from './runtime';

export interface CapTableChainReader extends EquityChainReader {
  getContractEvents(input: { address: Address; abi: Abi; eventName: string; fromBlock: bigint; toBlock: bigint; strict: true }): Promise<Array<{ args: unknown }>>;
}
export interface EquityPosition {
  holderId: string; wallet: string; shares: string;
  grants: Array<{ id: string; committed: string; earned: string; claimed: string; unvested: string; forfeited: string; stopped: boolean }>;
  returns: Array<{ id: string; entitled: string; claimed: boolean }>;
  committed: string; earned: string; claimed: string; unvested: string;
  returnEntitlements: string; unclaimedReturns: string;
  ownershipPercent: string; fullyDilutedPercent: string;
}
export interface EquityCapTable {
  chainId: number; blockNumber: string; contractVersion: '1' | '2';
  issuedShares: string; reservedShares: string; fullyDilutedShares: string;
  positions: EquityPosition[];
}
export function sharePercentage(shares: bigint, total: bigint): string {
  const bps = total === 0n ? 0n : shares * 10_000n / total;
  return `${bps / 100n}.${String(bps % 100n).padStart(2, '0')}`;
}
function integer(value: unknown): bigint {
  if (!/^\d+$/.test(String(value))) throw new Error('Invalid equity amount');
  return BigInt(String(value));
}
function tuple(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid equity contract tuple');
  return value;
}
function keys(logs: Array<{ args: unknown }>, key: string): Hex[] {
  if (logs.length > 10_000) throw new Error('Equity history exceeds the bounded reader');
  return [...new Set(logs.map(log => {
    const value = (log.args as Record<string, unknown>)?.[key];
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('Invalid equity event key');
    return value as Hex;
  }))];
}
export async function inspectEquityCapTable(reader: CapTableChainReader, input: { chainId: number; equity: string; governor: string; timelock: string }): Promise<EquityCapTable> {
  const blockNumber = await reader.getBlockNumber();
  const inspection = await inspectEquity(reader, { ...input, blockNumber });
  if (!inspection.governanceBound || !inspection.supplyInvariant) throw new Error('Equity integrity checks failed');
  const address = inspection.addresses.PapercuspEquity;
  // Both maintained versions expose ERC-5267. Reject an unknown version rather
  // than decoding a grant with the wrong tuple (V2 adds the vesting cliff).
  const domain = tuple(await reader.readContract({ address, abi: equityArtifacts.contracts.PapercuspEquity.abi, functionName: 'eip712Domain', blockNumber }));
  const version = domain[2];
  if (version !== '1' && version !== '2') throw new Error('Unsupported equity contract version');
  const abi = equityArtifacts.contracts[version === '2' ? 'PapercuspEquityV2' : 'PapercuspEquity'].abi;
  const read = (functionName: string, args?: unknown[]) => reader.readContract({ address, abi, functionName, args, blockNumber });
  const [countValue, grantEvents, returnEvents] = await Promise.all([
    read('holderCount'),
    reader.getContractEvents({ address, abi, eventName: 'GrantCommitted', fromBlock: 0n, toBlock: blockNumber, strict: true }),
    reader.getContractEvents({ address, abi, eventName: version === '2' ? 'PayoutTriggered' : 'ReturnDeclared', fromBlock: 0n, toBlock: blockNumber, strict: true }),
  ]);
  const count = integer(countValue);
  if (count > 256n) throw new Error('Equity holder limit exceeded');
  const grantIds = keys(grantEvents, 'grantId');
  const returnIds = keys(returnEvents, version === '2' ? 'payoutId' : 'returnId');
  const grants = await Promise.all(grantIds.map(async id => {
    const [stored, earnedValue] = await Promise.all([read('grants', [id]), read('earnedGrant', [id])]);
    const g = tuple(stored);
    const committed = integer(g[1]), earned = integer(earnedValue), claimed = integer(g[2]);
    if (earned > committed || claimed > earned) throw new Error('Equity grant amounts do not reconcile');
    const stopped = integer(g[version === '2' ? 6 : 5]) !== 0n;
    return { holderId: String(integer(g[0])), id, committed: String(committed), earned: String(earned), claimed: String(claimed),
      unvested: String(stopped ? 0n : committed - earned), forfeited: String(stopped ? committed - earned : 0n), stopped };
  }));
  const issued = integer(inspection.issuedShares), reserved = integer(inspection.reservedShares);
  const diluted = issued + reserved;
  const positions: EquityPosition[] = [];
  let measuredReserved = 0n;
  for (let id = 1n; id <= count; ++id) {
    const register = tuple(await read('holders', [id]));
    if (typeof register[0] !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(register[0])) throw new Error('Invalid holder wallet');
    const wallet = register[0];
    const shares = integer(await read('balanceOf', [wallet]));
    const holderGrants = grants.filter(g => g.holderId === String(id)).map(({ holderId: _, ...grant }) => grant);
    const sum = (field: 'committed' | 'earned' | 'claimed' | 'unvested') => holderGrants.reduce((total, g) => total + integer(g[field]), 0n);
    const returns = await Promise.all(returnIds.map(async returnId => {
      const [amount, claimed] = await Promise.all([read('returnEntitlement', [returnId, id]), read('returnClaimed', [returnId, id])]);
      if (typeof claimed !== 'boolean') throw new Error('Invalid return claim state');
      return { id: returnId, entitled: String(integer(amount)), claimed };
    }));
    const entitlement = returns.reduce((total, r) => total + integer(r.entitled), 0n);
    const unclaimedReturns = returns.reduce((total, r) => total + (r.claimed ? 0n : integer(r.entitled)), 0n);
    const pending = sum('earned') - sum('claimed') + sum('unvested') + unclaimedReturns;
    measuredReserved += pending;
    positions.push({ holderId: String(id), wallet, shares: String(shares), grants: holderGrants, returns,
      committed: String(sum('committed')), earned: String(sum('earned')), claimed: String(sum('claimed')), unvested: String(sum('unvested')),
      returnEntitlements: String(entitlement), unclaimedReturns: String(unclaimedReturns),
      ownershipPercent: sharePercentage(shares, issued), fullyDilutedPercent: sharePercentage(shares + pending, diluted) });
  }
  if (measuredReserved !== reserved || positions.reduce((total, p) => total + integer(p.shares), 0n) !== issued) throw new Error('Equity history does not reconcile to contract supply');
  return { chainId: input.chainId, blockNumber: String(blockNumber), contractVersion: version, issuedShares: String(issued), reservedShares: String(reserved), fullyDilutedShares: String(diluted), positions };
}
