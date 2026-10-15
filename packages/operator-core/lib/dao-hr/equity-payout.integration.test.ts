/** SPEC-P-004-H: the production pot:equity action reaches the real V2 EVM. */
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import equityTool from '../agent-tools/pot/equity';
import { digest, equityV2Evm, V2_ADMIN } from '../equity/evm-test-helpers';
import type { UnsignedEquityTransaction } from '../equity/runtime';

async function prepare(input: unknown): Promise<UnsignedEquityTransaction> {
  const parsed = equityTool.args.parse(input);
  const result = await equityTool.handler(parsed, {
    workspaceId: 'ws-dao-hr-payout',
    harnessSlug: 'papercusp',
  } as Parameters<typeof equityTool.handler>[1]);
  if (!('data' in result)) throw new Error('Missing typed equity action result');
  const out = result.data as { ok: boolean; unsignedTransaction?: UnsignedEquityTransaction };
  expect(out.ok).toBe(true);
  expect(out.unsignedTransaction?.requiresWalletSignature).toBe(true);
  if (!out.unsignedTransaction) throw new Error('Missing complete wallet transaction');
  return out.unsignedTransaction;
}

describe('SPEC-P-004-H — the product admin payout action lands a due payout without a proposal', () => {
  it('schema-parsed pot:equity output signed by the admin creates a claimable on-chain payout immediately', async () => {
    const e = await equityV2Evm();
    const payoutId = digest('product-admin-payout');
    const action = (functionName: string, args: unknown[]) => prepare({
      op: 'prepare', contract: 'PapercuspEquityV2', chainId: 1,
      from: e.accounts[V2_ADMIN], to: e.equity.address, functionName, args,
    });
    const before = e.now();
    for (const tx of [await action('setReturnPolicy', [500, 30 * 86_400]), await action('triggerPayout', [payoutId])]) {
      await e.raw(tx.data as Hex, tx.to, V2_ADMIN, e.equity.abi);
    }
    expect((await e.read(e.equity, 'shareReturns', [payoutId]) as readonly unknown[])[3]).toBe(true);
    expect(await e.read(e.equity, 'returnEntitlement', [payoutId, 1n])).toBe(5_000n);
    expect(e.now() - before).toBeLessThan(BigInt(await e.read(e.timelock, 'getMinDelay') as bigint));
    await e.send(e.equity, 'claimReturn', [payoutId]);
    expect(await e.read(e.equity, 'balanceOf', [e.accounts[0]])).toBe(105_000n);
  }, 120_000);

  it('a prepared payout signed by a different wallet is refused by the contract', async () => {
    const e = await equityV2Evm();
    await e.send(e.equity, 'setReturnPolicy', [500, 30 * 86_400], V2_ADMIN);
    const payoutId = digest('product-unauthorized-payout');
    const tx = await prepare({
      op: 'prepare', contract: 'PapercuspEquityV2', chainId: 1,
      from: e.accounts[1], to: e.equity.address, functionName: 'triggerPayout', args: [payoutId],
    });
    await expect(e.raw(tx.data as Hex, tx.to, 1, e.equity.abi)).rejects.toThrow('Forbidden');
    expect((await e.read(e.equity, 'shareReturns', [payoutId]) as readonly unknown[])[3]).toBe(false);
  }, 120_000);
});
