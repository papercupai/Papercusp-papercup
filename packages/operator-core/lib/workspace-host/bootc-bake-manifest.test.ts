import { describe, expect, it } from 'vitest';
import type { WorkspaceHostImageArtifact } from '@papercusp/deployment-driver';

import {
  WORKSPACE_HOST_BOOTC_BAKE_CONTRACT_VERSION,
  parseWorkspaceHostBootcBakeManifest,
  validateWorkspaceHostBootcBakeManifest,
  workspaceHostBootcBakeReleaseMismatch,
  workspaceHostBootcCloudArtifact,
  workspaceHostReleaseSubjectSha256,
  type WorkspaceHostBootcBakeManifest,
} from './bootc-bake-manifest';

function manifest(): WorkspaceHostBootcBakeManifest {
  const digest = `sha256:${'a'.repeat(64)}` as const;
  return {
    contractVersion: WORKSPACE_HOST_BOOTC_BAKE_CONTRACT_VERSION,
    image: 'registry.example.com/papercusp/workspace-host',
    tag: '2026.9.4-1',
    digest,
    pinnedRef: `registry.example.com/papercusp/workspace-host@${digest}`,
    registryNamespace: 'registry.example.com/papercusp',
    clouds: [
      { cloud: 'gcp', type: 'gce', artifact: 'gcp/image/disk.raw', sha256: 'b'.repeat(64), sizeBytes: 41 },
      { cloud: 'aws', type: 'ami', artifact: 'aws/image/disk.raw', sha256: 'c'.repeat(64), sizeBytes: 42 },
      { cloud: 'azure', type: 'vhd', artifact: 'azure/vhd/disk.vhd', sha256: 'd'.repeat(64), sizeBytes: 43 },
    ],
  };
}

describe('bootc bake manifest', () => {
  it('uses the OCI manifest digest as the provider release subject', () => {
    expect(
      workspaceHostReleaseSubjectSha256({
        hostModel: 'bootc-image',
        bootc: { imageDigest: `sha256:${'e'.repeat(64)}` },
        release: { bundleSha256: 'f'.repeat(64) },
      } as unknown as WorkspaceHostImageArtifact),
    ).toBe('e'.repeat(64));
  });

  it('accepts one digest-bound artifact for every provider and selects by provider', () => {
    const parsed = parseWorkspaceHostBootcBakeManifest(manifest());
    expect(validateWorkspaceHostBootcBakeManifest(parsed)).toEqual([]);
    expect(workspaceHostBootcCloudArtifact(parsed, 'azure')).toMatchObject({
      type: 'vhd',
      artifact: 'azure/vhd/disk.vhd',
    });
  });

  it('accepts GCP-only v1 and refuses selecting a provider that was not baked', () => {
    const candidate = manifest();
    const parsed = parseWorkspaceHostBootcBakeManifest({ ...candidate, clouds: [candidate.clouds[0]] });
    expect(workspaceHostBootcCloudArtifact(parsed, 'gcp')).toEqual(candidate.clouds[0]);
    expect(() => workspaceHostBootcCloudArtifact(parsed, 'aws')).toThrow("clouds is missing provider 'aws'");
    expect(validateWorkspaceHostBootcBakeManifest({ ...candidate, clouds: [] })).toContain(
      'clouds must contain at least one provider artifact',
    );
  });

  it('rejects unknown and inherited object properties as providers', () => {
    const candidate = manifest();
    for (const cloud of ['other', 'toString', '__proto__']) {
      expect(validateWorkspaceHostBootcBakeManifest({
        ...candidate, clouds: [{ ...candidate.clouds[0], cloud }],
      })).toContain('clouds[0].cloud must be gcp, aws, or azure');
    }
  });

  it('rejects duplicate providers, wrong formats, and movable refs', () => {
    const candidate = manifest();
    const errors = validateWorkspaceHostBootcBakeManifest({
      ...candidate,
      pinnedRef: `${candidate.image}:latest`,
      clouds: [
        candidate.clouds[0],
        { ...candidate.clouds[0], artifact: '../other.raw' },
        { ...candidate.clouds[2], type: 'ami', sha256: 'not-a-digest', sizeBytes: 0 },
      ],
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        'pinnedRef must equal image@digest',
        "clouds contains duplicate provider 'gcp'",
        "clouds[2].type must be 'vhd' for azure",
        'clouds[2].sha256 must be a lowercase SHA-256 digest',
        'clouds[2].sizeBytes must be a positive safe integer',
      ]),
    );
  });

  // WI-10005761: the bake records the release its image carries, derived from the image.
  it('accepts a recorded release, null for OS-only, or no key (pre-WI-10005761); refuses a malformed one', () => {
    const candidate = manifest();
    expect(validateWorkspaceHostBootcBakeManifest({ ...candidate, release: { version: '0.0.21-p318r62b' } })).toEqual([]);
    expect(validateWorkspaceHostBootcBakeManifest({ ...candidate, release: null })).toEqual([]);
    expect(validateWorkspaceHostBootcBakeManifest(candidate)).toEqual([]);
    expect(parseWorkspaceHostBootcBakeManifest({ ...candidate, release: { version: '1.2.3' } }).release).toEqual({ version: '1.2.3' });
    expect(validateWorkspaceHostBootcBakeManifest({ ...candidate, release: 'r62b' })).toContain('release must be an object or null');
    for (const version of ['', '../r62b', 'a b', '-lead', 'x'.repeat(129), 7]) {
      expect(validateWorkspaceHostBootcBakeManifest({ ...candidate, release: { version } })).toContain(
        'release.version must be a safe release version',
      );
    }
  });

  it('refuses a release that names a version the bake does not carry, naming both', () => {
    const candidate = manifest();
    // Calibration: the matching release is accepted.
    expect(workspaceHostBootcBakeReleaseMismatch({ ...candidate, release: { version: '0.0.21-p318r63' } }, '0.0.21-p318r63')).toBeUndefined();
    expect(workspaceHostBootcBakeReleaseMismatch({ ...candidate, release: null }, '0.0.21-p318r63')).toMatch(
      /^bake 2026\.9\.4-1 is OS-only \(it carries no release\), but the release names 0\.0\.21-p318r63; re-bake with .*--release-version 0\.0\.21-p318r63$/,
    );
    expect(workspaceHostBootcBakeReleaseMismatch(candidate, '0.0.21-p318r63')).toContain('records no baked release');
    expect(workspaceHostBootcBakeReleaseMismatch({ ...candidate, release: { version: '0.0.21-p318r62b' } }, '0.0.21-p318r63')).toContain(
      'carries release 0.0.21-p318r62b, but the release names 0.0.21-p318r63',
    );
  });
});
