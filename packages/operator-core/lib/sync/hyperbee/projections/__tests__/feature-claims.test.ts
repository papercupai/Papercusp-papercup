import { describe, expect, it } from 'vitest';
import { buildFeatureClaimsProjection, _testing, type FeatureClaimRow } from '../feature-claims';

function claim(over: Partial<FeatureClaimRow> = {}): FeatureClaimRow {
  return {
    harness_slug: 'sheets',
    feature_id: 'F-001',
    seq: 7,
    claimer_pubkey: 'a'.repeat(64),
    claimer_github_user_id: 12345,
    claimed_at: 1700000000000,
    outcome: 'won',
    schema_version: 1,
    ...over,
  };
}

describe('feature_claims projection', () => {
  it('composeKey qualifies a per-log sequence with its original author', () => {
    expect(_testing.composeKey(claim())).toBe(`F-001/${'a'.repeat(64)}/7`);
  });

  it('decodeValue accepts valid row, rejects malformed', () => {
    expect(_testing.decodeValue(claim())).toEqual(claim());
    expect(_testing.decodeValue({})).toBeNull();
    expect(_testing.decodeValue(null)).toBeNull();
    expect(_testing.decodeValue({ ...claim(), seq: -1 })).toBeNull();
    expect(_testing.decodeValue({ ...claim(), seq: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
    expect(_testing.decodeValue({ ...claim(), claimer_pubkey: 'not-a-core-key' })).toBeNull();
    expect(_testing.decodeValue({ ...claim(), feature_id: 42 })).toBeNull();
  });

  it('decodeValue accepts outcome=null', () => {
    expect(_testing.decodeValue(claim({ outcome: null }))).not.toBeNull();
  });

  it('buildFeatureClaimsProjection exposes the claims tableTag', () => {
    const p = buildFeatureClaimsProjection({ workspaceId: 'w', harnessSlug: 'sheets' });
    expect(p.tableTag).toBe('claims');
  });

  it('deleteFromPg is a silent no-op (append-only)', async () => {
    const p = buildFeatureClaimsProjection({ workspaceId: 'w', harnessSlug: 'sheets' });
    // Should not throw even on bogus key — append-only contract.
    await expect(p.deleteFromPg('not-a-real-key')).resolves.toBeUndefined();
  });
});
