import { describe, expect, it } from 'vitest';
import {
  authorizeTreasuryTransfer,
  buildTreasuryTransferEvent,
  planTreasuryRouting,
  validateSafeDeployment,
  validateTreasuryConfig,
  type SafeDeploymentRecord,
  type SafeTreasuryConfig,
} from './treasury-controls';
import { revenueSplitManifest, settleRevenue, type SettlementReconciliation } from './revenue-settlement';

const token = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const AUTOMATION = '0x7777777777777777777777777777777777777777';
const config: SafeTreasuryConfig = { chainId: 42161, safeAddress: '0x3333333333333333333333333333333333333333', owners: ['0x4444444444444444444444444444444444444444', '0x5555555555555555555555555555555555555555'], threshold: 2, automationSigner: AUTOMATION, roles: {
  settlement: { enabled: true, maxAmountMicros: 1_000n, allowedRecipients: [recipient], allowedTokens: [token] },
  'host-payout': { enabled: false, maxAmountMicros: 100n, allowedRecipients: [recipient], allowedTokens: [token] },
  'reserve-transfer': { enabled: false, maxAmountMicros: 100n, allowedRecipients: [recipient], allowedTokens: [token] },
  'emergency-pause': { enabled: true, maxAmountMicros: 0n, allowedRecipients: [recipient], allowedTokens: [token] },
} };

describe('Safe/Zodiac treasury controls', () => {
  it('validates config and authorizes policy-approved bounded settlement', () => {
    expect(validateTreasuryConfig(config)).toEqual({ ok: true });
    const result = authorizeTreasuryTransfer(config, { role: 'settlement', token, recipient, amountMicros: 7n, settlementReceiptHash: 'receipt-hash', policyApproved: true });
    expect(result).toMatchObject({ ok: true });
  });

  it('fails closed for missing policy approval, allowlist violations, disabled roles, and caps', () => {
    expect(authorizeTreasuryTransfer(config, { role: 'settlement', token, recipient, amountMicros: 7n, settlementReceiptHash: 'r', policyApproved: false })).toMatchObject({ ok: false, code: 'policy-not-approved' });
    expect(authorizeTreasuryTransfer(config, { role: 'settlement', token, recipient: '0x6666666666666666666666666666666666666666', amountMicros: 7n, settlementReceiptHash: 'r', policyApproved: true })).toMatchObject({ ok: false, code: 'recipient-not-allowed' });
    expect(authorizeTreasuryTransfer(config, { role: 'host-payout', token, recipient, amountMicros: 7n, settlementReceiptHash: 'r', policyApproved: true })).toMatchObject({ ok: false, code: 'role-disabled' });
    expect(authorizeTreasuryTransfer(config, { role: 'settlement', token, recipient, amountMicros: 1_001n, settlementReceiptHash: 'r', policyApproved: true })).toMatchObject({ ok: false, code: 'amount-exceeds-role-cap' });
  });

  it('refuses a configuration whose automation signer is also a Safe owner', () => {
    // The separation invariant. An automation key that counts toward the owner
    // threshold would let a compromise of the always-online signer erode the
    // offline owner control the Zodiac role is supposed to sit beneath.
    const merged: SafeTreasuryConfig = { ...config, automationSigner: config.owners[0]! };
    expect(validateTreasuryConfig(merged)).toMatchObject({ ok: false, code: 'invalid-config' });
    // Case-insensitively, too: an address is the same address in either case.
    expect(validateTreasuryConfig({ ...config, automationSigner: config.owners[0]!.toUpperCase().replace('0X', '0x') })).toMatchObject({
      ok: false,
      code: 'invalid-config',
    });
    // And every transfer through it refuses, not merely the config check.
    expect(authorizeTreasuryTransfer(merged, { role: 'settlement', token, recipient, amountMicros: 7n, settlementReceiptHash: 'r', policyApproved: true })).toMatchObject({
      ok: false,
      code: 'config-invalid',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P-034 — deployment records and reconciled routing
// ─────────────────────────────────────────────────────────────────────────────

const ROLES_MODULE = '0x8888888888888888888888888888888888888888';
const DEPLOY_TX = `0x${'a'.repeat(64)}`;

function deployment(overrides: Partial<SafeDeploymentRecord> = {}): SafeDeploymentRecord {
  return {
    chainId: config.chainId,
    safeAddress: config.safeAddress,
    rolesModuleAddress: ROLES_MODULE,
    rolesVersion: 'v2',
    deploymentTxHash: DEPLOY_TX,
    network: 'testnet',
    deployedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

/** A real reconciliation, produced by settling and reconciling for real. */
function reconciliation(): SettlementReconciliation {
  const manifest = revenueSplitManifest({
    version: 'v1',
    sharesBps: { creator: 6_000, host: 2_000, component: 500, dao: 1_000, reserve: 300, tax: 100, operating: 100 },
  });
  const settled = settleRevenue({ settlementId: 's-1', grossMicros: 10_000n, providerCostMicros: 0n, splitManifest: manifest, daoTreasury: recipient });
  if (!settled.ok) throw new Error('fixture did not settle');
  return {
    settlementId: settled.receipt.settlementId,
    receiptHash: settled.receipt.receiptHash,
    splitManifestHash: settled.receipt.splitManifestHash,
    grossMicros: settled.receipt.grossMicros,
    providerCostMicros: settled.receipt.providerCostMicros,
    distributableMicros: settled.receipt.distributableMicros,
    allocationsMicros: settled.receipt.allocationsMicros,
    daoTreasury: settled.receipt.daoTreasury,
  };
}

describe('Safe deployment records', () => {
  it('accepts a well-formed Roles v2 testnet deployment', () => {
    expect(validateSafeDeployment(deployment())).toEqual({ ok: true });
  });

  it('refuses a malformed deployment', () => {
    expect(validateSafeDeployment(deployment({ deploymentTxHash: '0xshort' }))).toMatchObject({ ok: false, code: 'invalid-deployment' });
    expect(validateSafeDeployment(deployment({ rolesModuleAddress: config.safeAddress }))).toMatchObject({ ok: false, code: 'invalid-deployment' });
    expect(validateSafeDeployment(deployment({ chainId: 0 }))).toMatchObject({ ok: false, code: 'invalid-deployment' });
    // Roles v1 has a weaker scoping model, so accepting it would mean the
    // bounds asserted off chain are not the bounds enforced on chain.
    expect(validateSafeDeployment({ ...deployment(), rolesVersion: 'v1' as unknown as 'v2' })).toMatchObject({ ok: false, code: 'invalid-deployment' });
  });
});

describe('reconciled treasury routing', () => {
  it('binds component author identity in transfer digests and refuses missing, wrong-chain or inconsistent payees', () => {
    const recon: SettlementReconciliation = { ...reconciliation(), componentAllocationsMicros: { alice: 250n, bob: 250n } };
    const input = { config, deployment: deployment(), reconciliation: recon, token, role: 'settlement' as const,
      routedShares: ['component'] as const, mainnetCapitalApproved: false,
      componentPayees: { alice: { walletAddress: recipient, chainId: config.chainId }, bob: { walletAddress: recipient, chainId: config.chainId } } };
    const result = planTreasuryRouting(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    expect(result.transfers.map((t) => [t.payeeId, t.amountMicros])).toEqual([['alice', 250n], ['bob', 250n]]);
    expect(new Set(result.transfers.map((t) => t.safeTxHash)).size).toBe(2);
    const events = result.transfers.map((transfer, sequence) => buildTreasuryTransferEvent({
      streamId: 'treasury:channel', issuer: AUTOMATION, sequence, occurredAtMs: 1,
      reconciliation: recon, transfer, deployment: deployment(),
      transaction: { transactionHash: `0x${'b'.repeat(64)}`, blockNumber: 42n },
    }));
    expect(new Set(events.map((e) => e.idempotencyKey)).size).toBe(2);
    expect(events.map((e) => e.payload.payeeId)).toEqual(['alice', 'bob']);
    expect(planTreasuryRouting({ ...input, componentPayees: { alice: input.componentPayees.alice } }).ok).toBe(false);
    expect(planTreasuryRouting({ ...input, componentPayees: { ...input.componentPayees, bob: { walletAddress: recipient, chainId: 1 } } }).ok).toBe(false);
    expect(planTreasuryRouting({ ...input, reconciliation: { ...recon, componentAllocationsMicros: { alice: 251n, bob: 250n } } }).ok).toBe(false);
    expect(planTreasuryRouting({ ...input, reconciliation: { ...recon, componentAllocationsMicros: { alice: -1n, bob: 501n } } }).ok).toBe(false);
  });

  it('plans a bounded transfer of the DAO share, bound to the settlement receipt', () => {
    const recon = reconciliation();
    const plan = planTreasuryRouting({
      config,
      deployment: deployment(),
      reconciliation: recon,
      token,
      role: 'settlement',
      routedShares: ['dao'],
      mainnetCapitalApproved: false,
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.transfers).toHaveLength(1);
      expect(plan.transfers[0]).toMatchObject({
        share: 'dao',
        role: 'settlement',
        recipient,
        amountMicros: recon.allocationsMicros.dao,
        settlementReceiptHash: recon.receiptHash,
      });
      expect(plan.transfers[0]!.safeTxHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('refuses a deployment on the wrong chain or for a different Safe', () => {
    const recon = reconciliation();
    const base = { config, reconciliation: recon, token, role: 'settlement' as const, routedShares: ['dao' as const], mainnetCapitalApproved: false };
    expect(planTreasuryRouting({ ...base, deployment: deployment({ chainId: config.chainId + 1 }) })).toMatchObject({ ok: false, code: 'deployment-chain-mismatch' });
    expect(planTreasuryRouting({ ...base, deployment: deployment({ safeAddress: '0x9999999999999999999999999999999999999999' }) })).toMatchObject({
      ok: false,
      code: 'deployment-safe-mismatch',
    });
  });

  it('gates mainnet capital on explicit owner approval', () => {
    const recon = reconciliation();
    const base = { config, deployment: deployment({ network: 'mainnet' as const }), reconciliation: recon, token, role: 'settlement' as const, routedShares: ['dao' as const] };
    expect(planTreasuryRouting({ ...base, mainnetCapitalApproved: false })).toMatchObject({ ok: false, code: 'mainnet-capital-not-approved' });
    expect(planTreasuryRouting({ ...base, mainnetCapitalApproved: true })).toMatchObject({ ok: true });
  });

  it('refuses when a share exceeds the automated role cap rather than trimming it', () => {
    const recon = reconciliation();
    // The DAO share here is 1_000 micros; the role cap is 1_000, so a share one
    // micro larger must refuse. Trimming to the cap would silently under-pay
    // the treasury and leave the remainder unaccounted for.
    const overCap: SettlementReconciliation = {
      ...recon,
      allocationsMicros: { ...recon.allocationsMicros, dao: recon.allocationsMicros.dao + 1_000n },
    };
    expect(
      planTreasuryRouting({ config, deployment: deployment(), reconciliation: overCap, token, role: 'settlement', routedShares: ['dao'], mainnetCapitalApproved: false }),
    ).toMatchObject({ ok: false, code: 'transfer-not-authorized' });
  });

  it('refuses a plan that would move nothing rather than reporting a successful no-op', () => {
    const recon = reconciliation();
    const zeroed: SettlementReconciliation = { ...recon, allocationsMicros: { ...recon.allocationsMicros, reserve: 0n } };
    expect(
      planTreasuryRouting({ config, deployment: deployment(), reconciliation: zeroed, token, role: 'settlement', routedShares: ['reserve'], mainnetCapitalApproved: false }),
    ).toMatchObject({ ok: false, code: 'no-routable-share' });
  });

  it('builds an auditable receipt event bound to the receipt hash and the share', () => {
    const recon = reconciliation();
    const plan = planTreasuryRouting({ config, deployment: deployment(), reconciliation: recon, token, role: 'settlement', routedShares: ['dao'], mainnetCapitalApproved: false });
    if (!plan.ok) throw new Error('fixture did not plan');
    const event = buildTreasuryTransferEvent({
      streamId: 'treasury:chan-1',
      issuer: AUTOMATION,
      sequence: 0,
      occurredAtMs: 5,
      transfer: plan.transfers[0]!,
      reconciliation: recon,
      deployment: deployment(),
      transaction: { transactionHash: `0x${'b'.repeat(64)}`, blockNumber: 42n },
    });
    expect(event.kind).toBe('revenue-split');
    // The idempotency key is (receipt hash, share), matching the durable unique
    // index on treasury_transfers, so a replay collides on both surfaces.
    expect(event.idempotencyKey).toBe(`treasury:${recon.receiptHash}:dao`);
    expect(event.payload).toMatchObject({
      splitManifestHash: recon.splitManifestHash,
      share: 'dao',
      amountMicros: recon.allocationsMicros.dao.toString(),
      rolesVersion: 'v2',
      network: 'testnet',
      blockNumber: '42',
    });
  });
});
