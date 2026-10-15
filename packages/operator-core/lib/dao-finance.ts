/** Workbench adapter over the signed policy, equity ABI, wallet binding and commerce doors.
 * No second account store, signer, broadcast path or synthetic organization roster. */
import { z } from 'zod';
import type { HivePolicy } from './hive-policy-schema';
import { coerceHivePolicyInput } from './hive-policy-schema';
import { equityArtifacts, inspectEquity, prepareEquityTransaction } from './equity/runtime';
import type { EquityChainReader } from './equity/runtime';
import { EQUITY_CONTRACT_NAMES, type EquityContractName } from './equity/compile';
import { inspectEquityCapTable, type CapTableChainReader } from './equity/cap-table';
import { readWalletBinding, requestWalletBindingChallenge, submitWalletBinding } from './cupboard/wallet-binding-io';
import { commerceDashboardsDoor } from './cupboard/commerce-door-gate-io';

export const daoFinanceAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('inspect') }).strict(),
  z.object({ op: z.literal('wallet-challenge'), walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/), chainId: z.number().int().positive().safe() }).strict(),
  z.object({ op: z.literal('wallet-verify'), challengeId: z.string().min(1).max(100), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).strict(),
  z.object({ op: z.literal('prepare-equity'), expectedPolicyVersion: z.number().int().nonnegative().safe(), contract: z.enum(EQUITY_CONTRACT_NAMES), functionName: z.string().min(1).max(80), args: z.array(z.unknown()).max(16) }).strict(),
]);
type Action = z.infer<typeof daoFinanceAction>;
export interface DaoFinanceDeps {
  wallet: typeof readWalletBinding;
  challenge: typeof requestWalletBindingChallenge;
  verify: typeof submitWalletBinding;
  commerce: typeof commerceDashboardsDoor;
  equity: (binding: NonNullable<NonNullable<HivePolicy['finance']>['equity']>, holder?: string) => Promise<unknown>;
  treasury: (binding: NonNullable<NonNullable<HivePolicy['finance']>['treasury']>) => Promise<unknown>;
}
async function publicClient() {
  const rpc = process.env.PAPERCUSP_RECONCILIATION_CHAIN_RPC_URL?.trim();
  if (!rpc) throw new Error('Organization chain reads require the configured chain RPC.');
  const { createPublicClient, http } = await import('viem');
  return createPublicClient({ transport: http(rpc, { timeout: 10_000, retryCount: 0 }) });
}
const production: DaoFinanceDeps = {
  wallet: readWalletBinding, challenge: requestWalletBindingChallenge, verify: submitWalletBinding, commerce: commerceDashboardsDoor,
  equity: async (binding, holder) => inspectEquity(await publicClient() as unknown as EquityChainReader, { ...binding, ...(holder ? { holder } : {}) }),
  treasury: async binding => {
    const client = await publicClient();
    if (await client.getChainId() !== binding.chainId) throw new Error('RPC chain differs from treasury policy binding.');
    const blockNumber = await client.getBlockNumber();
    const address = binding.address as `0x${string}`;
    const balance = await client.getBalance({ address, blockNumber });
    return { chainId: binding.chainId, address, blockNumber: String(blockNumber), nativeBalanceWei: String(balance), signerAuthority: 'requires-treasury-signatures' };
  },
};
/** Reuse the owner-signed deployment and existing chain reader for a member profile. */
export async function readDaoMemberEquity(policy: HivePolicy, holder: string): Promise<unknown> {
  const valid = coerceHivePolicyInput(policy);
  if (!valid.ok) throw new Error(valid.error);
  if (!policy.finance?.equity) throw new Error('No owner-signed equity deployment is bound.');
  return production.equity(policy.finance.equity, holder);
}
/** Whole-holder view over the same signed deployment, with event-key enumeration. */
export async function readDaoEquityCapTable(policy: HivePolicy) {
  const valid = coerceHivePolicyInput(policy);
  if (!valid.ok) throw new Error(valid.error);
  if (!policy.finance?.equity) throw new Error('No owner-signed equity deployment is bound.');
  return inspectEquityCapTable(await publicClient() as unknown as CapTableChainReader, policy.finance.equity);
}
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
/** The measured ERC-5267 version selects both the offered ABI and the signed destination. */
function deploymentContracts(version: unknown, binding: NonNullable<NonNullable<HivePolicy['finance']>['equity']>): Partial<Record<EquityContractName, string>> {
  if (version === '1') return { PapercuspEquity: binding.equity, EquityGovernor: binding.governor, EquityTimelock: binding.timelock };
  if (version === '2') return { PapercuspEquityV2: binding.equity, EquityGovernorV2: binding.governor, EquityTimelock: binding.timelock };
  return {};
}
async function measured(operation: () => Promise<unknown>) {
  try { return { status: 'ready', value: await operation() }; }
  catch (cause) { return { status: 'error', message: cause instanceof Error ? cause.message : 'Account records could not be read.' }; }
}

export async function runDaoFinance(input: { policy: HivePolicy; policyVersion: number; actorId: string; action: Action }, deps: DaoFinanceDeps = production) {
  const valid = coerceHivePolicyInput(input.policy);
  if (!valid.ok) throw new Error(valid.error);
  const finance = input.policy.finance ?? {};
  const action = input.action;
  if (action.op === 'wallet-challenge') return deps.challenge({ walletAddress: action.walletAddress, chainId: action.chainId });
  if (action.op === 'wallet-verify') return deps.verify({ challengeId: action.challengeId, signature: action.signature });
  if (action.op === 'prepare-equity' && input.policyVersion !== action.expectedPolicyVersion) throw new Error('Policy changed since review. Refresh account records.');
  const walletResult = await deps.wallet();
  const wallet = walletResult.ok ? object(walletResult.value.binding) : {};
  if (action.op === 'prepare-equity') {
    if (!finance.equity) throw new Error('No owner-signed equity deployment is bound.');
    if (!walletResult.ok || typeof wallet.walletAddress !== 'string' || wallet.chainId !== finance.equity.chainId) throw new Error('A verified wallet on the bound equity chain is required.');
    const inspection = object(await deps.equity(finance.equity, wallet.walletAddress));
    if (inspection.governanceBound !== true || inspection.supplyInvariant !== true) throw new Error('Equity governance or supply integrity checks failed.');
    const to = deploymentContracts(inspection.version, finance.equity)[action.contract];
    if (!to) throw new Error('Selected contract does not match the measured equity deployment version. Refresh account records.');
    return { ok: true, unsignedTransaction: prepareEquityTransaction({ chainId: finance.equity.chainId, from: wallet.walletAddress, to, contract: action.contract, functionName: action.functionName, args: action.args }) };
  }
  const [equity, treasury, commerce] = await Promise.all([
    finance.equity ? measured(() => deps.equity(finance.equity!, typeof wallet.walletAddress === 'string' && wallet.chainId === finance.equity!.chainId ? wallet.walletAddress : undefined)) : { status: 'not-bound' },
    finance.treasury ? measured(() => deps.treasury(finance.treasury!)) : { status: 'not-bound' },
    finance.commerce ? measured(async () => {
      const result = await deps.commerce({ buyerOrgId: finance.commerce!.buyerOrgId, actingUserId: input.actorId });
      if (!result.ok) throw new Error(result.detail || result.code);
      return result.result;
    }) : { status: 'not-bound' },
  ]);
  const contracts = finance.equity && equity.status === 'ready'
    ? deploymentContracts(object('value' in equity ? equity.value : undefined).version, finance.equity) : {};
  return { ok: true, policyVersion: input.policyVersion, bindings: finance, wallet: walletResult, equity, treasury, commerce,
    actions: (Object.keys(contracts) as EquityContractName[]).flatMap(contract => equityArtifacts.contracts[contract].abi.flatMap(fn => fn.type === 'function' && !['view', 'pure'].includes(fn.stateMutability) ? [{ contract, name: fn.name, inputs: fn.inputs }] : [])) };
}
