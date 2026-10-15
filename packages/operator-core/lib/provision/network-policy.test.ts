import { describe, expect, it } from 'vitest';
import { buildNetworkPolicy, isHostAllowed } from './network-policy';

describe('buildNetworkPolicy', () => {
  it('returns empty allowlist + floor denies when no cloudProvider', () => {
    const p = buildNetworkPolicy({});
    expect(p.preset).toBe('none');
    expect(p.allowedHosts).toEqual([]);
    expect(p.deniedCidrs).toContain('169.254.169.254/32');
    expect(p.deniedCidrs).toContain('10.0.0.0/8');
  });

  it('expands AWS preset with region templating', () => {
    const p = buildNetworkPolicy({
      cloudProvider: { id: 'aws', region: 'us-east-1' },
    });
    expect(p.preset).toBe('aws');
    expect(p.regions).toEqual(['us-east-1']);
    expect(p.allowedHosts).toContain('lambda.us-east-1.amazonaws.com');
    expect(p.allowedHosts).toContain('s3.us-east-1.amazonaws.com');
  });

  it('multi-region expansion produces all combinations', () => {
    const p = buildNetworkPolicy({
      cloudProvider: { id: 'aws', regions: ['us-east-1', 'eu-west-1'] },
    });
    expect(p.allowedHosts).toContain('lambda.us-east-1.amazonaws.com');
    expect(p.allowedHosts).toContain('lambda.eu-west-1.amazonaws.com');
  });

  it('appends manifest-declared allowedHosts', () => {
    const p = buildNetworkPolicy({
      cloudProvider: { id: 'aws', region: 'us-east-1' },
      allowedHosts: ['custom-vendor.com'],
    });
    expect(p.allowedHosts).toContain('custom-vendor.com');
  });

  it('deduplicates', () => {
    const p = buildNetworkPolicy({
      cloudProvider: { id: 'aws', regions: ['us-east-1', 'us-east-1'] },
    });
    const dupes = p.allowedHosts.filter((h) => h === 'lambda.us-east-1.amazonaws.com');
    expect(dupes).toHaveLength(1);
  });

  it('keeps templates verbatim when no region supplied', () => {
    const p = buildNetworkPolicy({ cloudProvider: { id: 'aws' } });
    expect(p.allowedHosts).toContain('lambda.${region}.amazonaws.com');
  });
});

describe('isHostAllowed', () => {
  const allowed = ['lambda.us-east-1.amazonaws.com', '*.googleapis.com', 'api.cloudflare.com'];

  it('exact match', () => {
    expect(isHostAllowed('lambda.us-east-1.amazonaws.com', allowed)).toBe(true);
  });

  it('subdomain wildcard match', () => {
    expect(isHostAllowed('iam.googleapis.com', allowed)).toBe(true);
    expect(isHostAllowed('compute.googleapis.com', allowed)).toBe(true);
  });

  it('rejects non-matching hosts', () => {
    expect(isHostAllowed('evil.com', allowed)).toBe(false);
    expect(isHostAllowed('googleapis.com', allowed)).toBe(false); // no subdomain
  });

  it('rejects deeper-than-one-level subdomains for `*.x.y` patterns', () => {
    // `*.googleapis.com` should match `iam.googleapis.com` but not deeper.
    expect(isHostAllowed('iam.googleapis.com', ['*.googleapis.com'])).toBe(true);
    expect(isHostAllowed('nested.iam.googleapis.com', ['*.googleapis.com'])).toBe(false);
    expect(isHostAllowed('deep.nested.iam.googleapis.com', ['*.googleapis.com'])).toBe(false);
    expect(isHostAllowed('.googleapis.com', ['*.googleapis.com'])).toBe(false);
  });

  it('does not treat a multi-label wildcard as a single-label wildcard', () => {
    expect(isHostAllowed('nested.iam.googleapis.com', ['**.googleapis.com'])).toBe(true);
    expect(isHostAllowed('googleapis.com', ['**.googleapis.com'])).toBe(false);
    expect(isHostAllowed('nested..googleapis.com', ['**.googleapis.com'])).toBe(false);
    expect(isHostAllowed('iam.googleapis.com.evil.example', ['**.googleapis.com'])).toBe(false);
  });
});
