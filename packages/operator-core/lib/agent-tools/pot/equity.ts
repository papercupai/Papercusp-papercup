/** Extends pot tools; uses existing authentication, reconciliation RPC and wallet rails. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { equityArtifacts, equityArtifactPage, prepareEquityTransaction, transactionPage, inspectEquity, type EquityChainReader } from '../../equity/runtime';
import { EQUITY_CONTRACT_NAMES } from '../../equity/compile';

const contract = z.enum(EQUITY_CONTRACT_NAMES);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const page = { offset: z.number().int().min(0).default(0), limit: z.number().int().min(2).max(2048).default(2048) };
export default defineTool({
  name: 'pot:equity',
  capability: 'harness:read',
  // Principal authentication is defineTool's default; do not opt out.
  description: 'OpenZeppelin actual-equity software: manifest, paged ABI/bytecode, unsigned wallet transaction preparation and pinned-block chain inspection. No signing or broadcasting. Issuer documents and holder consent remain required; returns are additional shares. Large payloads are paged with hashes and must be assembled before wallet signing.',
  guidance: {
    when: 'Prepare deployment or ownership/governance/grant/return actions, or inspect an existing equity deployment.',
    notWhen: 'Cash dividends, securities/legal validation, private-key custody, ordinary plan admission or authorizing DAO treasury spending.',
    chaining: 'manifest → artifact/prepare pages → concatenate and verify payload hash → the authorized wallet reviews/signs → inspect. Reuse cupboard:bind-wallet for principal binding. inspect uses the existing PAPERCUSP_RECONCILIATION_CHAIN_RPC_URL operator configuration.',
    seeAlso: ['cupboard:bind-wallet', 'cupboard:reconciliation'],
  },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('manifest') }).strict(),
    z.object({ op: z.literal('artifact'), contract, component: z.enum(['abi', 'bytecode']).default('abi'), ...page }).strict(),
    z.object({ op: z.literal('prepare'), contract, chainId: z.number().int().positive().safe(), from: address, to: address.optional(), functionName: z.string().max(80).optional(), args: z.array(z.unknown()).max(16), ...page }).strict(),
    z.object({ op: z.literal('inspect'), chainId: z.number().int().positive().safe(), equity: address, governor: address, timelock: address, holder: address.optional() }).strict(),
  ]),
  async handler(input) {
    try {
      if (input.op === 'manifest') return { data: { ok: true, sourceFingerprint: equityArtifacts.sourceFingerprint, compilerVersion: equityArtifacts.compilerVersion,
        openzeppelinVersion: equityArtifacts.openzeppelinVersion, evmVersion: 'cancun', contracts: Object.keys(equityArtifacts.contracts),
        signing: 'external-wallet-required', economicInstrument: 'issuer-attested-equity', returns: 'additional-equity', legalEffectiveness: 'requires-issuer-and-binding-documents', publicTrading: 'not-established' } };
      if (input.op === 'artifact') return { data: { ok: true, ...equityArtifactPage(input.contract, input.component, input.offset, input.limit) } };
      if (input.op === 'prepare') return { data: { ok: true, ...transactionPage(prepareEquityTransaction(input), input.offset, input.limit) } };
      const rpcUrl = process.env.PAPERCUSP_RECONCILIATION_CHAIN_RPC_URL?.trim();
      if (!rpcUrl) return { data: { ok: false, error: 'chain-rpc-not-configured', detail: 'Configure the existing PAPERCUSP_RECONCILIATION_CHAIN_RPC_URL outside the source tree.' } };
      const { createPublicClient, http } = await import('viem');
      const reader = createPublicClient({ transport: http(rpcUrl, { timeout: 10_000, retryCount: 0 }) });
      return { data: { ok: true, ...await inspectEquity(reader as unknown as EquityChainReader, input) } };
    } catch (error) { return { data: { ok: false, error: 'equity-request-rejected', detail: error instanceof Error ? error.message : String(error) } }; }
  },
});
