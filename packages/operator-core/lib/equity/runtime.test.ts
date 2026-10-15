import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { decodeFunctionData, encodeDeployData, zeroAddress } from 'viem';
import { createAddressFromString, bytesToHex } from '@ethereumjs/util';
import { equityArtifacts, prepareEquityTransaction, transactionPage, equityArtifactPage, inspectEquity } from './runtime';
import { equityEvm, TERMS } from './evm-test-helpers';
import tool from '../agent-tools/pot/equity';
import { dispatchProjectedTool, lookupByMcpName } from '@papercusp/tooldef';

describe('unsigned equity ABI and authenticated tool integration', () => {
  it('prepares source-derived constructors/actions without signing; pages assemble exact calldata', async () => {
    const e = await equityEvm();
    const input = { chainId: 1, from: e.accounts[0], contract: 'PapercuspEquity' as const, args: [TERMS, 'https://issuer.example/legal', '1000000', '100000'] };
    const tx = prepareEquityTransaction(input);
    expect(tx.data).toBe(encodeDeployData({ abi: equityArtifacts.contracts.PapercuspEquity.abi, bytecode: equityArtifacts.contracts.PapercuspEquity.bytecode, args: [TERMS, 'https://issuer.example/legal', 1_000_000n, 100_000n] }));
    const chunks: string[] = []; let offset = 0;
    for (;;) { const p = transactionPage(tx, offset); chunks.push(p.payload.chunk); if (p.payload.nextOffset === null) break; offset = p.payload.nextOffset; }
    expect(chunks.join('')).toBe(tx.data);
    expect(createHash('sha256').update(chunks.join('')).digest('hex')).toBe(transactionPage(tx).payload.sha256);
    expect(transactionPage(tx).unsignedTransaction).toBeUndefined();
    const action = prepareEquityTransaction({ chainId: 1, from: e.accounts[0], to: e.equity.address, contract: 'PapercuspEquity', functionName: 'requestRecovery', args: ['1', e.accounts[3]] });
    expect(decodeFunctionData({ abi: e.equity.abi, data: action.data })).toMatchObject({ functionName: 'requestRecovery', args: [1n, e.accounts[3]] });
    expect(action).toMatchObject({ value: '0', requiresWalletSignature: true });
    await e.raw(action.data, e.equity.address);
    expect((await e.read(e.equity, 'holders', [1n]) as unknown[])[5]).toBe(e.accounts[3]);
  }, 60_000);
  it('rejects wrong ABI, zero addresses, unsafe numbers and private-key arguments', async () => {
    const e = await equityEvm();
    const base = { chainId: 1, from: e.accounts[0], to: e.equity.address, contract: 'PapercuspEquity' as const, functionName: 'transfer', args: [e.accounts[1], '1'] };
    expect(() => prepareEquityTransaction({ ...base, functionName: 'mint' })).toThrow();
    expect(() => prepareEquityTransaction({ ...base, from: zeroAddress })).toThrow();
    expect(() => prepareEquityTransaction({ ...base, args: [e.accounts[1], Number.MAX_SAFE_INTEGER + 1] })).toThrow();
    expect(tool.args.safeParse({ op: 'prepare', ...base, privateKey: '0xsecret' }).success).toBe(false);
    const projected = lookupByMcpName('pot:equity')!;
    expect(projected.requirePrincipal).not.toBe(false);
    const denied = await dispatchProjectedTool(projected, 'pot:equity', { op: 'manifest' }, {
      role: 'operator', workspaceId: 'equity-auth-fixture', runId: 'equity-auth-fixture',
      signal: new AbortController().signal, log: () => {}, progress: () => {}, emit: () => {},
    }, {});
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('unauthorized');
    const context = { role: 'operator', workspaceId: 'equity-auth-fixture', runId: 'equity-auth-fixture',
      signal: new AbortController().signal, log: () => {}, progress: () => {}, emit: () => {},
      principal: { kind: 'system' as const, slug: 'equity-fixture', workspaceId: 'equity-auth-fixture', authMethod: 'process-internal' as const,
        trust: 'trusted' as const, capabilities: new Set(['harness:read']) } };
    const allowed = await dispatchProjectedTool(projected, 'pot:equity', { op: 'manifest' }, context, {});
    expect(allowed.ok).toBe(true);
    const forbidden = await dispatchProjectedTool(projected, 'pot:equity', { op: 'manifest' },
      { ...context, principal: { ...context.principal, capabilities: new Set<string>() } }, {});
    expect(forbidden.error?.code).toBe('missing_capability');
    const manifest = await tool.handler({ op: 'manifest' }, {} as never) as { data: Record<string, unknown> };
    expect(manifest.data).toMatchObject({ ok: true, returns: 'additional-equity', publicTrading: 'not-established' });
    const page = equityArtifactPage('PapercuspEquity', 'abi');
    expect(page.chunk.length).toBeLessThanOrEqual(2048);
  }, 60_000);
  it('inspects actual contracts at one block and separates on-chain attestation from legal effectiveness', async () => {
    const e = await equityEvm();
    const known = [e.equity, e.governor, e.timelock];
    const blocks: bigint[] = [];
    const reader = { getChainId: async () => 1, getBlockNumber: async () => 42n,
      getCode: async (input: { address: `0x${string}`; blockNumber: bigint }) => { blocks.push(input.blockNumber); return bytesToHex(await e.vm.stateManager.getCode(createAddressFromString(input.address))); },
      readContract: async (input: { address: `0x${string}`; functionName: string; args?: unknown[]; blockNumber: bigint }) => { blocks.push(input.blockNumber); const c = known.find(c => c.address.toLowerCase() === input.address.toLowerCase())!; return e.read(c, input.functionName, input.args); } };
    const status = await inspectEquity(reader, { chainId: 1, equity: e.equity.address, governor: e.governor.address, timelock: e.timelock.address, holder: e.accounts[0] });
    expect(status).toMatchObject({ governanceBound: true, supplyInvariant: true, issuedShares: '100000', reservedShares: '0', returns: 'additional-equity', issuer: { issuerAttested: true, publicTrading: 'not-established', legalEffectiveness: 'requires-verification-against-issuer-documents' } });
    expect(blocks.every(b => b === 42n)).toBe(true);
    await expect(inspectEquity({ ...reader, getChainId: async () => 2 }, { chainId: 1, equity: e.equity.address, governor: e.governor.address, timelock: e.timelock.address })).rejects.toThrow('chain id');
    await expect(inspectEquity({ ...reader, getCode: vi.fn(async () => '0x' as const) }, { chainId: 1, equity: e.equity.address, governor: e.governor.address, timelock: e.timelock.address })).rejects.toThrow('not deployed');
  }, 60_000);
});
