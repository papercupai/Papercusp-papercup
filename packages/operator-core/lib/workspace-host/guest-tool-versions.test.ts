import { describe, expect, it } from 'vitest';

import { resolveSbomGuestToolVersions } from './guest-tool-versions';

describe('resolveSbomGuestToolVersions (WI-10006386 AWS, WI-10006408 GCP)', () => {
  const derived = { curl: '8.12.1-6.el10', nftables: '1:1.1.5-6.el10' };

  it('uses the SBOM-derived set when no override is given', () => {
    expect(resolveSbomGuestToolVersions(derived, undefined)).toEqual(derived);
  });

  it('uses the operator file when the request carries no derived set', () => {
    expect(resolveSbomGuestToolVersions(undefined, { curl: '1' })).toEqual({ curl: '1' });
    expect(resolveSbomGuestToolVersions(undefined, undefined)).toBeUndefined();
  });

  it('accepts an override that restates the SBOM, whitespace aside', () => {
    expect(resolveSbomGuestToolVersions(derived, { curl: ' 8.12.1-6.el10 ' })).toEqual(derived);
  });

  it('refuses an override that contradicts the SBOM, epoch included', () => {
    expect(() => resolveSbomGuestToolVersions(derived, { nftables: '1.1.5-6.el10' })).toThrow(
      /disagrees with the bake SBOM: nftables \(override 1\.1\.5-6\.el10; SBOM 1:1\.1\.5-6\.el10\)/,
    );
  });

  it('refuses an override naming a tool the SBOM does not record', () => {
    expect(() => resolveSbomGuestToolVersions(derived, { jq: '1.7' })).toThrow(
      /jq \(override 1\.7; the SBOM records no version\)/,
    );
  });
});
