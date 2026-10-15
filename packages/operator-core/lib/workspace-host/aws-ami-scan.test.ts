/**
 * papercusp-aws-ami-scan (WI-10005587): the pure measurement / provenance rules, the binding
 * between the scanner's evidence and the AWS release contract, and a guard that every
 * in-tree executable the AWS AMI release names actually exists.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AWS_AMI_DESCRIPTION_PATTERN,
  AWS_AMI_SCAN_BUDGETS,
  AWS_AMI_SCAN_WORK_TIMEOUT_MS,
  AWS_AMI_SCAN_RUNNER_TIMEOUT_MS,
  boundAwsAmiScanCommandTimeoutMs,
  GUEST_PACKAGE_PROBES,
  assertAwsAmiProvenance,
  buildAwsAmiScanEvidence,
  measureAwsAmiScan,
  parseAwsAmiScanInput,
  selectCandidateRoot,
} from '../../bin/aws-ami-scan-measure.mjs';
import { AWS_AMI_RELEASE_EXECUTABLES } from './aws-ami-production';
import {
  AWS_AMI_REQUIRED_GUEST_TOOLS,
  awsAmiReleaseDescription,
  parseAwsAmiReleaseDescription,
} from './aws-ami-release';
import { AWS_IMAGE_SCAN_POLICY, evaluateImageScanPolicy } from './image-scan-policy';

const BIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin');
const RELEASE_SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'aws-ami-release.ts');
const BOOTC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'infra', 'images', 'bootc');
const CONTAINERFILE = join(BOOTC_DIR, 'workspace-host.Containerfile');

const SHA = 'a'.repeat(64);
const MANIFEST = `sha256:${'b'.repeat(64)}`;
const REQUEST = { region: 'us-east-1', imageId: 'ami-0123456789abcdef0', buildManifestIdentity: MANIFEST, releaseSha256: SHA };

describe('AWS scanner parent and phase deadline contract', () => {
  it('allows a complete download and all three scans while preserving cleanup headroom', () => {
    expect(AWS_AMI_SCAN_WORK_TIMEOUT_MS).toBe(
      AWS_AMI_SCAN_BUDGETS.downloadMs + 3 * AWS_AMI_SCAN_BUDGETS.scanMs + AWS_AMI_SCAN_BUDGETS.hostWorkMs,
    );
    expect(AWS_AMI_SCAN_RUNNER_TIMEOUT_MS - AWS_AMI_SCAN_WORK_TIMEOUT_MS)
      .toBe(AWS_AMI_SCAN_BUDGETS.teardownMs + AWS_AMI_SCAN_BUDGETS.runnerMarginMs);
    // Old parent killed even a valid 46-minute download; the maintained boundary admits it.
    expect(boundAwsAmiScanCommandTimeoutMs(AWS_AMI_SCAN_WORK_TIMEOUT_MS, AWS_AMI_SCAN_BUDGETS.downloadMs, 46 * 60_000))
      .toBe(AWS_AMI_SCAN_BUDGETS.downloadMs);
  });

  it('shrinks successive commands against one absolute phase clock and refuses an expired phase', () => {
    expect(boundAwsAmiScanCommandTimeoutMs(10000, 8000, 1000)).toBe(8000);
    expect(boundAwsAmiScanCommandTimeoutMs(10000, 8000, 3000)).toBe(7000);
    expect(() => boundAwsAmiScanCommandTimeoutMs(10000, 8000, 10000)).toThrow(/execution budget exhausted/);
  });
});

function image(overrides: Record<string, unknown> = {}) {
  return {
    ImageId: REQUEST.imageId,
    State: 'available',
    Description: awsAmiReleaseDescription('2026.10.02', SHA),
    RootDeviceName: '/dev/xvda',
    BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { SnapshotId: 'snap-0abc', VolumeSize: 20, Encrypted: true } }],
    Tags: [
      { Key: 'papercusp:build-manifest', Value: MANIFEST },
      { Key: 'papercusp:release-sha256', Value: SHA },
      { Key: 'papercusp:image-version', Value: '2026.10.02' },
      { Key: 'papercusp:managed', Value: 'true' },
    ],
    ...overrides,
  };
}

const SBOM = JSON.stringify({
  artifacts: [
    { type: 'rpm', name: 'curl', version: '7.76.1-31.el9' },
    { type: 'rpm', name: 'nftables', version: '1.0.9-3.el9' },
    { type: 'npm', name: 'axios', version: '1.7.9', locations: [{ path: '/opt/papercusp/node_modules/axios/package.json' }] },
  ],
});
const VULN = JSON.stringify({
  matches: [
    { vulnerability: { severity: 'Low', fix: { state: 'fixed' } }, artifact: { type: 'rpm', locations: [{ path: '/usr/lib/x' }] } },
    { vulnerability: { severity: 'Negligible', fix: { state: 'not-fixed' } }, artifact: { type: 'npm', locations: [{ path: '/opt/papercusp/node_modules/a/package.json' }] } },
  ],
});
const CLEAN = { sbomText: SBOM, vulnText: VULN, secretsText: '[]', mountedFilesystems: 3, candidateRootProof: '/candidate/loop0p4/etc/os-release', npmManifestsPresent: true };

describe('papercusp-aws-ami-scan input and provenance', () => {
  it('accepts the adapter payload and rejects every malformed identity field', () => {
    expect(parseAwsAmiScanInput(REQUEST)).toEqual(REQUEST);
    expect(() => parseAwsAmiScanInput({ ...REQUEST, region: 'useast1' })).toThrow(/region/);
    expect(() => parseAwsAmiScanInput({ ...REQUEST, imageId: 'snap-0abc' })).toThrow(/AMI id/);
    expect(() => parseAwsAmiScanInput({ ...REQUEST, buildManifestIdentity: 'b'.repeat(64) })).toThrow(/sha256:/);
    expect(() => parseAwsAmiScanInput({ ...REQUEST, releaseSha256: `sha256:${SHA}` })).toThrow(/64 lowercase hex/);
  });

  it('probes exactly the RPM guest tools the release contract requires, and the image installs them (WI-10005605)', () => {
    expect([...GUEST_PACKAGE_PROBES].sort()).toEqual([...AWS_AMI_REQUIRED_GUEST_TOOLS].sort());
    const containerfile = readFileSync(CONTAINERFILE, 'utf8');
    // Every required tool is installed by name in the bootc image (ufw/unattended-upgrades
    // were Ubuntu names that never existed there).
    for (const tool of AWS_AMI_REQUIRED_GUEST_TOOLS) {
      if (tool === 'amazon-ssm-agent') continue;
      expect(containerfile).toMatch(new RegExp(`^\\s+${tool.replace(/[-+.]/g, '\\$&')}\\b`, 'm'));
    }
    // amazon-ssm-agent comes from AWS's standalone RPM: digest-pinned, enabled, EC2-gated.
    expect(containerfile).toMatch(/^ARG AMAZON_SSM_AGENT_RPM_SHA256=[a-f0-9]{64}$/m);
    expect(containerfile).toContain('sha256sum -c -');
    expect(containerfile).toContain('systemctl enable amazon-ssm-agent.service');
    expect(containerfile).toContain('/usr/lib/systemd/system/amazon-ssm-agent.service.d/papercusp-ec2-only.conf');
    expect(readFileSync(join(BOOTC_DIR, 'papercusp-amazon-ssm-agent-ec2-only.conf'), 'utf8')).toMatch(
      /^ConditionFirmware=smbios-field\(sys_vendor = "Amazon EC2"\)$/m,
    );
  });

  it('mirrors the release Description pattern and tag keys written by aws-ami-release.ts', () => {
    const description = awsAmiReleaseDescription('2026.10.02', SHA);
    expect(AWS_AMI_DESCRIPTION_PATTERN.exec(description)?.slice(1)).toEqual(['2026.10.02', SHA]);
    expect(parseAwsAmiReleaseDescription(description)).toEqual({ releaseVersion: '2026.10.02', releaseSha256: SHA });
    const source = readFileSync(RELEASE_SOURCE, 'utf8');
    for (const key of ['papercusp:build-manifest', 'papercusp:release-sha256', 'papercusp:image-version', 'papercusp:managed']) {
      expect(source).toContain(`'${key}'`);
    }
  });

  it('binds the AMI to the requested release before any download', () => {
    expect(assertAwsAmiProvenance(image(), REQUEST)).toEqual({ snapshotId: 'snap-0abc', releaseVersion: '2026.10.02', encrypted: true });
    expect(() => assertAwsAmiProvenance(image({ State: 'pending' }), REQUEST)).toThrow(/not available/);
    expect(() => assertAwsAmiProvenance(image({ Description: awsAmiReleaseDescription('2026.10.02', 'c'.repeat(64)) }), REQUEST)).toThrow(
      /Description binds/,
    );
    const wrongTag = image({ Tags: image().Tags.map((tag) => (tag.Key === 'papercusp:build-manifest' ? { ...tag, Value: `sha256:${'d'.repeat(64)}` } : tag)) });
    expect(() => assertAwsAmiProvenance(wrongTag, REQUEST)).toThrow(/papercusp:build-manifest/);
  });

  it('refuses an AMI whose content would be under-scanned', () => {
    const twoVolumes = image({
      BlockDeviceMappings: [...image().BlockDeviceMappings, { DeviceName: '/dev/xvdb', Ebs: { SnapshotId: 'snap-0def' } }],
    });
    expect(() => assertAwsAmiProvenance(twoVolumes, REQUEST)).toThrow(/exactly one EBS snapshot; found 2/);
    const offRoot = image({ BlockDeviceMappings: [{ DeviceName: '/dev/xvdb', Ebs: { SnapshotId: 'snap-0abc' } }] });
    expect(() => assertAwsAmiProvenance(offRoot, REQUEST)).toThrow(/not the root device/);
  });
});

describe('papercusp-aws-ami-scan candidate-root proof', () => {
  const MOUNT = '/tmp/pc-ami-scan-x/candidate';

  it('finds the bootc OS seven levels down inside the ostree deployment', () => {
    const deployment = `${MOUNT}/loop0p4/ostree/deploy/default/deploy/1f2e3d.0`;
    expect(selectCandidateRoot([`${MOUNT}/loop0p3/etc/os-release`, `${deployment}/usr/lib/os-release`], MOUNT)).toEqual({
      proof: '/candidate/loop0p4/ostree/deploy/default/deploy/1f2e3d.0/usr/lib/os-release',
      osRoot: deployment,
    });
  });

  it('accepts a plain partition root and ignores os-release files that prove no mounted userland', () => {
    expect(selectCandidateRoot([`${MOUNT}/loop0p1/etc/os-release`], MOUNT)?.osRoot).toBe(`${MOUNT}/loop0p1`);
    const decoys = [
      `${MOUNT}/loop0p4/ostree/repo/objects/ab/etc/os-release`,
      `${MOUNT}/loop0p4/srv/backup/etc/os-release`,
      `${MOUNT}/loop0p4/etc/os-release.d/x`,
      '/elsewhere/etc/os-release',
    ];
    expect(selectCandidateRoot(decoys, MOUNT)).toBeNull();
  });
});

describe('papercusp-aws-ami-scan measurement', () => {
  it('counts findings with a per-severity breakdown that reconciles to the total', () => {
    const measurement = measureAwsAmiScan(CLEAN);
    expect(measurement.vulnerabilityFindings).toBe(2);
    expect(measurement.vulnerabilityBySeverity).toEqual({ Low: 1, Negligible: 1 });
    expect(Object.values(measurement.vulnerabilityBySeverity).reduce((sum, count) => sum + count, 0)).toBe(2);
    expect(measurement.vulnerabilityByScope).toEqual({ 'inherited-base-image': 1, 'papercusp-bundled': 1 });
    expect(measurement.vulnerabilityCriticalHighByScope).toEqual({});
    expect(measurement.bundleCatalogedArtifacts).toBe(1);
    expect(measurement.secretFindings).toBe(0);
    expect(measurement.secretsByScope).toEqual({});
    expect(measurement.secretBundledSample).toEqual([]);
    expect(measurement.secretBundledSampleComplete).toBe(true);
    expect(measurement.sbomSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(measurement.guestPackages).toMatchObject({ curl: '7.76.1-31.el9', nftables: '1.0.9-3.el9', 'amazon-ssm-agent': null });
    // Ubuntu-era names are no longer probed: they never existed on the bootc image (WI-10005605).
    expect(measurement.guestPackages).not.toHaveProperty('ufw');
    expect(measurement.guestPackages).not.toHaveProperty('unattended-upgrades');
  });

  it('reports secrets by rule and file without echoing the secret', () => {
    const secretsText = JSON.stringify([{ RuleID: 'aws-access-token', File: '/x/etc/key', StartLine: 3, Secret: 'AKIAEXAMPLE', Match: 'AKIAEXAMPLE' }]);
    const measurement = measureAwsAmiScan({ ...CLEAN, secretsText });
    expect(measurement.secretFindings).toBe(1);
    expect(measurement.secretSample).toEqual([{ rule: 'aws-access-token', file: '/x/etc/key', line: 3 }]);
    expect(JSON.stringify(measurement)).not.toContain('AKIAEXAMPLE');
  });

  it('fails closed instead of reporting zero when a stage measured nothing', () => {
    expect(() => measureAwsAmiScan({ ...CLEAN, secretsText: '' })).toThrow(/gitleaks report is missing/);
    expect(() => measureAwsAmiScan({ ...CLEAN, vulnText: '{"results":[]}' })).toThrow(/matches\[\]/);
    expect(() => measureAwsAmiScan({ ...CLEAN, mountedFilesystems: 0 })).toThrow(/no candidate filesystem/);
    expect(() => measureAwsAmiScan({ ...CLEAN, candidateRootProof: '' })).toThrow(/candidateRootProof/);
    const noNpm = JSON.stringify({ artifacts: [{ type: 'rpm', name: 'curl', version: '1' }] });
    expect(() => measureAwsAmiScan({ ...CLEAN, sbomText: noNpm })).toThrow(/sbom-npm-coverage-zero/);
    const noOs = JSON.stringify({ artifacts: [{ type: 'npm', name: 'axios', version: '1' }] });
    expect(() => measureAwsAmiScan({ ...CLEAN, sbomText: noOs })).toThrow(/sbom-os-coverage-zero/);
  });

  it('produces evidence the AWS release scan policy evaluates on its coverage proof', () => {
    const provenance = assertAwsAmiProvenance(image(), REQUEST);
    const evidence = buildAwsAmiScanEvidence(REQUEST, provenance, measureAwsAmiScan(CLEAN), { syft: 'syft 1.51.0' });
    expect(evidence).toMatchObject({ ...REQUEST, trusted: true, snapshotId: 'snap-0abc' });
    expect(evidence.evidenceRef).toMatch(/^aws-ami-scan:us-east-1\/ami-0123456789abcdef0\/snap-0abc:sha256:[a-f0-9]{64}$/);
    expect(evaluateImageScanPolicy(evidence, AWS_IMAGE_SCAN_POLICY).accepted).toBe(true);
    const unproven = { ...evidence, candidateRootProof: '' };
    expect(evaluateImageScanPolicy(unproven, AWS_IMAGE_SCAN_POLICY).accepted).toBe(false);
  });
});

/**
 * WI-10006421: the first bootc candidate to reach the AWS gate (A-r62b) carried 1073 at/above-high
 * findings, 1066 of them CentOS Stream base packages and none in the bundle, plus 44 secrets of
 * which 34 were bundled false positives. These cases pin the scoped verdict against that shape.
 */
describe('papercusp-aws-ami-scan scope attribution at the AWS release gate', () => {
  const BASE = '/candidate/loop6p4/ostree/deploy/default/deploy/abc.0';
  const RELEASE = `${BASE}/opt/papercusp/releases/0.0.21`;
  const highIn = (path: string) => ({
    vulnerability: { severity: 'High', fix: { state: 'not-fixed' } },
    artifact: { type: 'rpm', locations: [{ path }] },
  });
  const secret = (RuleID: string, File: string) => ({ RuleID, File, StartLine: 1, Secret: 'x', Match: 'x' });

  function evidenceFor(input: { matches: unknown[]; secrets: unknown[]; sbomArtifacts?: unknown[] }) {
    const sbomText = JSON.stringify({
      artifacts: input.sbomArtifacts ?? [
        { type: 'rpm', name: 'kernel', version: '6.12.0', locations: [{ path: `${BASE}/usr/lib/sysimage/rpm/rpmdb.sqlite` }] },
        { type: 'npm', name: 'hono', version: '4.6.0', locations: [{ path: `${RELEASE}/node_modules/hono/package.json` }] },
      ],
    });
    const measurement = measureAwsAmiScan({
      ...CLEAN,
      sbomText,
      vulnText: JSON.stringify({ matches: input.matches }),
      secretsText: JSON.stringify(input.secrets),
    });
    return buildAwsAmiScanEvidence(REQUEST, assertAwsAmiProvenance(image(), REQUEST), measurement, {});
  }

  it('attributes every finding to exactly one scope, partitioning each total', () => {
    const evidence = evidenceFor({
      matches: [highIn(`${BASE}/usr/lib/sysimage/rpm/rpmdb.sqlite`), highIn(`${RELEASE}/node_modules/x/package.json`)],
      secrets: [secret('generic-api-key', `${RELEASE}/serve.mjs`), secret('private-key', `${BASE}/usr/share/misc/magic.mgc`)],
    });
    expect(evidence.vulnerabilityCriticalHighByScope).toEqual({ 'inherited-base-image': 1, 'papercusp-bundled': 1 });
    expect(evidence.secretsByScope).toEqual({ 'inherited-base-image': 1, 'papercusp-bundled': 1 });
    expect(evidence.secretBundledSample).toEqual([{ rule: 'generic-api-key', file: `${RELEASE}/serve.mjs`, line: 1 }]);
    expect(JSON.stringify(evidence)).not.toContain('"Match"');
  });

  it('accepts unfixable base-image findings and justified bundled secrets, judging only the bundle', () => {
    const evidence = evidenceFor({
      matches: Array.from({ length: 840 }, () => highIn(`${BASE}/usr/lib/sysimage/rpm/rpmdb.sqlite`)),
      secrets: [
        ...Array.from({ length: 31 }, () => secret('generic-api-key', `${RELEASE}/serve.mjs`)),
        secret('generic-api-key', `${RELEASE}/spa/monaco/vs/editor-KLE6jdfb.js`),
        secret('private-key', `${BASE}/usr/share/misc/magic.mgc`),
      ],
    });
    const verdict = evaluateImageScanPolicy(evidence, AWS_IMAGE_SCAN_POLICY);
    expect(verdict.failures).toEqual([]);
    expect(verdict).toMatchObject({ accepted: true, evaluatedScope: 'papercusp-bundled', policyViolatingVulnerabilities: 0 });
  });

  it('still denies a high finding inside the bundle, and an unjustified bundled secret', () => {
    const vulnerable = evidenceFor({ matches: [highIn(`${RELEASE}/bin/kopia`)], secrets: [] });
    expect(evaluateImageScanPolicy(vulnerable, AWS_IMAGE_SCAN_POLICY).failures.map((f) => f.code)).toContain(
      'vulnerability-threshold',
    );
    const leaked = evidenceFor({ matches: [], secrets: [secret('aws-access-token', `${RELEASE}/config/credentials`)] });
    expect(evaluateImageScanPolicy(leaked, AWS_IMAGE_SCAN_POLICY).accepted).toBe(false);
  });

  it('denies when the bundle was never cataloged, instead of reading silence as clean', () => {
    const evidence = evidenceFor({
      matches: [],
      secrets: [],
      sbomArtifacts: [
        { type: 'rpm', name: 'kernel', version: '6.12.0', locations: [{ path: `${BASE}/usr/lib/sysimage/rpm/rpmdb.sqlite` }] },
        { type: 'npm', name: 'npm', version: '10.0.0', locations: [{ path: `${BASE}/usr/lib/node_modules/npm/package.json` }] },
      ],
    });
    expect(evidence.bundleCatalogedArtifacts).toBe(0);
    expect(evaluateImageScanPolicy(evidence, AWS_IMAGE_SCAN_POLICY).accepted).toBe(false);
  });
});

describe('papercusp-aws-ami-scan executable', () => {
  const scanner = join(BIN_DIR, 'papercusp-aws-ami-scan.mjs');

  it('rejects a malformed payload with a structured error before touching AWS', () => {
    const result = spawnSync(process.execPath, [scanner], { input: JSON.stringify({ ...REQUEST, imageId: 'nope' }), encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr.trim())).toMatchObject({ tool: 'papercusp-aws-ami-scan', error: expect.stringMatching(/AMI id/) });
  });

  it('refuses before any spend when a scanner tool is missing', () => {
    const result = spawnSync(process.execPath, [scanner], {
      input: JSON.stringify(REQUEST),
      encoding: 'utf8',
      env: { ...process.env, PAPERCUSP_AWS_AMI_SCAN_COLDSNAP: '/nonexistent/coldsnap', AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('coldsnap executable');
  });
});

/**
 * Every Papercusp-authored executable the AWS AMI release invokes must exist in-tree, so a
 * named-but-unimplemented executable fails here instead of at live-release time.
 * `coldsnap` is a third-party tool, probed at runtime by probeAwsAmiExecutables.
 * PENDING is SHRINK-ONLY: an entry must still be missing, so implementing one forces its removal.
 */
const PENDING: Readonly<Record<string, string>> = {};

describe('AWS AMI release executables exist in-tree', () => {
  const inTree = Object.values(AWS_AMI_RELEASE_EXECUTABLES).filter((name) => name.startsWith('papercusp-'));

  it.each(inTree)('%s', (name) => {
    const path = join(BIN_DIR, `${name}.mjs`);
    if (PENDING[name]) {
      expect(existsSync(path), `${name} now exists: remove it from PENDING (${PENDING[name]})`).toBe(false);
      return;
    }
    expect(existsSync(path), `${path} is named by AWS_AMI_RELEASE_EXECUTABLES but not implemented`).toBe(true);
    expect(readFileSync(path, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(() => accessSync(path, fsConstants.X_OK)).not.toThrow();
  });
});
