import { describe, expect, it } from 'vitest';
import {
  reconcileSettlement,
  revenueSplitManifest,
  settleRevenue,
  validateRevenueSplit,
  type RevenueSplitManifest,
  type SettlementReceipt,
  type ComponentRevenueDependency,
} from './revenue-settlement';

const split: RevenueSplitManifest = { version: 'v1', manifestHash: 'sha256:split', sharesBps: { creator: 2_000, host: 2_000, component: 1_000, dao: 3_000, reserve: 500, tax: 500, operating: 500 } };

describe('identity dependency author split (P-019)', () => {
  const dependency = (ref: string, author: string): ComponentRevenueDependency => ({
    packageKind: 'blueprint', ref, revision: '1.0.0', contentHash: 'a'.repeat(64), author,
  });
  const dependencies = [dependency('base', 'alice'), dependency('reviewer', 'bob'), dependency('research', 'alice')];
  const manifest = revenueSplitManifest({ version: 'identity-v1',
    sharesBps: { creator: 0, host: 0, component: 9000, dao: 1000, reserve: 0, tax: 0, operating: 0 },
    componentDependencies: dependencies,
  });
  const settle = (grossMicros: bigint, splitManifest = manifest) => settleRevenue({
    settlementId: 'identity-payment', grossMicros, providerCostMicros: 0n, splitManifest, daoTreasury: 'dao',
  });

  it('coalesces dependency authors, preserves all component micros, and keeps the DAO share', () => {
    const result = settle(100n);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.componentAllocationsMicros).toEqual({ alice: 60n, bob: 30n });
    expect(result.receipt.allocationsMicros.dao).toBe(10n);
    expect(reconcileSettlement({ receipt: result.receipt, splitManifest: manifest }).ok).toBe(true);
  });

  it('allocates tiny and large amounts without losing integer micros', () => {
    for (const gross of [0n, 1n, 2n, 3n, 19n, 900719925474099399n]) {
      const result = settle(gross);
      if (!result.ok) throw new Error(result.detail);
      expect(Object.values(result.receipt.componentAllocationsMicros!).reduce((a, b) => a + b, 0n))
        .toBe(result.receipt.allocationsMicros.component);
      expect(Object.values(result.receipt.allocationsMicros).reduce((a, b) => a + b, 0n)).toBe(gross);
    }
  });

  it('assigns equal remainders by code-unit author order rather than locale or input order', () => {
    const componentDependencies = [dependency('accent', 'é'), dependency('lower', 'a'), dependency('upper', 'Z')];
    for (const pins of [componentDependencies, [...componentDependencies].reverse()]) {
      const tied = revenueSplitManifest({ ...manifest, componentDependencies: pins });
      for (const [gross, authors] of [
        [2n, { Z: 1n, a: 0n, é: 0n }],
        [3n, { Z: 1n, a: 1n, é: 0n }],
        [19n, { Z: 6n, a: 6n, é: 5n }],
      ] as const) {
        const result = settle(gross, tied);
        if (!result.ok) throw new Error(result.detail);
        expect(result.receipt.componentAllocationsMicros).toEqual(authors);
        expect(reconcileSettlement({ receipt: result.receipt, splitManifest: tied }).ok).toBe(true);
      }
    }
  });

  it('pins exact dependency versions and authors while ignoring enumeration order', () => {
    const reversed = revenueSplitManifest({ ...manifest, componentDependencies: [...dependencies].reverse() });
    expect(reversed.manifestHash).toBe(manifest.manifestHash);
    expect(settle(19n, reversed)).toEqual(settle(19n));
    for (const changed of [{ ...dependencies[0], packageKind: 'pack' }, { ...dependencies[0], ref: 'other-base' },
      { ...dependencies[0], revision: '2.0.0' },
      { ...dependencies[0], contentHash: 'b'.repeat(64) }, { ...dependencies[0], author: 'mallory' }]) {
      expect(revenueSplitManifest({ ...manifest, componentDependencies: [changed, ...dependencies.slice(1)] }).manifestHash)
        .not.toBe(manifest.manifestHash);
    }
  });

  it('refuses duplicate dependency paths and missing or invalid authorship pins', () => {
    for (const componentDependencies of [[...dependencies, dependencies[0]], [],
      [{ ...dependencies[0], author: '' }], [{ ...dependencies[0], contentHash: 'invalid' }]]) {
      expect(settle(100n, { ...manifest, componentDependencies })).toMatchObject({ ok: false, code: 'invalid-split' });
    }
  });

  it('refuses author tampering even when the component total is unchanged', () => {
    const result = settle(100n);
    if (!result.ok) throw new Error(result.detail);
    const tampered: Readonly<Record<string, bigint>>[] = [{ alice: 59n, bob: 31n }, { alice: 60n, mallory: 30n },
      { alice: 60n, bob: 30n, mallory: 0n },
      Object.assign(Object.create({ alice: 60n }), { bob: 30n, mallory: 0n })];
    for (const componentAllocationsMicros of tampered) {
      expect(reconcileSettlement({ receipt: { ...result.receipt, componentAllocationsMicros }, splitManifest: manifest }))
        .toMatchObject({ ok: false, code: 'allocation-mismatch' });
    }
    const { componentAllocationsMicros: _removed, ...missing } = result.receipt;
    expect(reconcileSettlement({ receipt: missing, splitManifest: manifest })).toMatchObject({ ok: false, code: 'allocation-mismatch' });
  });
});

describe('DAO revenue settlement', () => {
  it('preserves the legacy manifest digest and anonymous component allocation without dependency pins', () => {
    // Golden digest of the pre-components canonical body, independent of the
    // manifest writer. Adding an empty components field must change this test.
    const legacy = revenueSplitManifest({ version: 'legacy-v1', sharesBps: split.sharesBps });
    expect(legacy.manifestHash).toBe('sha256:81e487aa2aa09c698551f3c1fee3b731f94c870d8c2c0c798a63c4c07c50bfa3');
    expect(legacy).not.toHaveProperty('componentDependencies');
    const result = settleRevenue({ settlementId: 'legacy', grossMicros: 100n, providerCostMicros: 0n,
      splitManifest: legacy, daoTreasury: 'dao' });
    if (!result.ok) throw new Error(result.detail);
    expect(result.receipt).not.toHaveProperty('componentAllocationsMicros');
    expect(result.receipt.allocationsMicros.component).toBe(10n);
    expect(reconcileSettlement({ receipt: result.receipt, splitManifest: legacy }).ok).toBe(true);
  });

  it('allocates integer stablecoin micros after provider cost and assigns rounding remainder to DAO', () => {
    const result = settleRevenue({ settlementId: 's-1', grossMicros: 1_000_001n, providerCostMicros: 1n, splitManifest: split, daoTreasury: '0xdao' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const allocations = result.receipt.allocationsMicros;
      expect(Object.values(allocations).reduce((a, b) => a + b, 0n)).toBe(1_000_000n);
      expect(allocations.dao).toBeGreaterThan(0n);
      expect(result.receipt.receiptHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('rejects overflowed splits, missing treasury, and cost above gross', () => {
    expect(validateRevenueSplit({ ...split, sharesBps: { ...split.sharesBps, dao: 10_000 } }).ok).toBe(false);
    expect(settleRevenue({ settlementId: 's-2', grossMicros: 1n, providerCostMicros: 0n, splitManifest: split, daoTreasury: '' })).toMatchObject({ ok: false, code: 'missing-treasury' });
    expect(settleRevenue({ settlementId: 's-3', grossMicros: 1n, providerCostMicros: 2n, splitManifest: split, daoTreasury: '0xdao' })).toMatchObject({ ok: false, code: 'cost-exceeds-gross' });
  });
});

/**
 * P-034 reconciliation invariants.
 *
 * The manifest is DERIVED here rather than hand-written, because reconciliation
 * compares the receipt's committed hash against the deployment's manifest hash:
 * a hand-written `sha256:split` would make every case fail on the hash check
 * before reaching the arithmetic these tests are about.
 */
describe('settlement reconciliation (P-034)', () => {
  const manifest = revenueSplitManifest({ version: 'v1', sharesBps: split.sharesBps });

  function settled(gross = 1_000_001n, cost = 1n): SettlementReceipt {
    const result = settleRevenue({ settlementId: 's-r', grossMicros: gross, providerCostMicros: cost, splitManifest: manifest, daoTreasury: '0xdao' });
    if (!result.ok) throw new Error(`fixture did not settle: ${result.detail}`);
    return result.receipt;
  }

  it('reconciles a receipt this manifest actually produced', () => {
    const result = reconcileSettlement({ receipt: settled(), splitManifest: manifest });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reconciliation.receiptHash).toBe(settled().receiptHash);
      expect(result.reconciliation.distributableMicros).toBe(1_000_000n);
      // 3_000 bps of 1_000_000 is 300_000, and the DAO also carries everything
      // the split does not allocate: these shares sum to 9_500 bps, so the
      // remaining 500 bps (50_000) lands here too. Asserting the TOTAL rather
      // than the nominal share is deliberate — it is the value the treasury
      // door actually transfers, and it is exactly the number a reader would
      // get wrong by reading the bps alone.
      expect(result.reconciliation.allocationsMicros.dao).toBe(350_000n);
    }
  });

  it('refuses a receipt committed to a different split manifest', () => {
    const other = revenueSplitManifest({ version: 'v2', sharesBps: { ...split.sharesBps, dao: 2_000, reserve: 1_500 } });
    expect(reconcileSettlement({ receipt: settled(), splitManifest: other })).toMatchObject({ ok: false, code: 'split-manifest-mismatch' });
  });

  it('refuses a tampered allocation even when the shares still sum to the distributable', () => {
    const receipt = settled();
    // Move 1000 micros from the DAO to the host. The total is untouched, so a
    // reconciliation that only checked the sum would pay the DAO's money to the
    // host and report success.
    const tampered: SettlementReceipt = {
      ...receipt,
      allocationsMicros: {
        ...receipt.allocationsMicros,
        dao: receipt.allocationsMicros.dao - 1_000n,
        host: receipt.allocationsMicros.host + 1_000n,
      },
    };
    const sum = Object.values(tampered.allocationsMicros).reduce((a, b) => a + b, 0n);
    expect(sum).toBe(tampered.distributableMicros);
    expect(reconcileSettlement({ receipt: tampered, splitManifest: manifest })).toMatchObject({ ok: false, code: 'allocation-mismatch' });
  });

  it('refuses a distributable that is not gross minus provider cost', () => {
    const receipt = settled();
    expect(
      reconcileSettlement({ receipt: { ...receipt, providerCostMicros: receipt.providerCostMicros + 5n }, splitManifest: manifest }),
    ).toMatchObject({ ok: false, code: 'distributable-mismatch' });
  });

  it('refuses a negative allocation', () => {
    const receipt = settled();
    // Only `tax` is disturbed. Compensating in `dao` would trip the per-share
    // mismatch on `dao` first (it is checked earlier in REVENUE_SHARES order),
    // so the negative guard under test would never run.
    const negative: SettlementReceipt = { ...receipt, allocationsMicros: { ...receipt.allocationsMicros, tax: -1n } };
    expect(reconcileSettlement({ receipt: negative, splitManifest: manifest })).toMatchObject({ ok: false, code: 'negative-allocation' });
  });

  it('refuses a receipt whose hash does not recompute — the catch-all for fields it does not re-derive', () => {
    const receipt = settled();
    // The settlement id and the treasury address are not re-derived from the
    // manifest, so only the digest can catch them being edited under the row.
    expect(reconcileSettlement({ receipt: { ...receipt, daoTreasury: '0xattacker' }, splitManifest: manifest })).toMatchObject({
      ok: false,
      code: 'receipt-hash-mismatch',
    });
  });
});
