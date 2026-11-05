import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertRecordedReleaseScopeApproved,
  resolveReleaseBaseUrl,
  verifyReleasePublication,
  type HeadProbe,
  type HeadProbeResult,
} from './finalize-release-publication';
import type { ReleaseRow } from './release-registry';
import type { OwnerDirectiveRow } from '@papercusp/operator-core/lib/owner-directives';

const BASE = 'https://downloads.example.test/permanent-secret';
const ARTIFACT_URL = 'desktop-v0.0.16-alpha/Papercusp_GUI_0.0.16.AppImage';

function releaseRow(): ReleaseRow {
  return {
    version: '0.0.16',
    channel: 'alpha',
    cutAt: new Date('2026-08-13T07:45:45Z'),
    publishedAt: null,
    changelogMd: null,
    workItemIds: [],
    planSlugs: [],
    artifacts: [
      {
        product: 'gui',
        platform: 'linux-x86_64',
        name: 'Papercusp_GUI_0.0.16.AppImage',
        url: ARTIFACT_URL,
        size: 1234,
        sha256: 'a'.repeat(64),
      },
    ],
    gitSha: null,
    cutBy: null,
    notes: null,
  };
}

function fakeHead(
  results: Record<string, HeadProbeResult>,
): { head: HeadProbe; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    head: async (url) => {
      calls.push(url);
      return results[url] ?? { status: 404, contentLength: null };
    },
  };
}

describe('verifyReleasePublication', () => {
  it('accepts a live manifest and every artifact at its recorded size', async () => {
    const manifestUrl = `${BASE}/latest.json`;
    const artifactUrl = `${BASE}/${ARTIFACT_URL}`;
    const fake = fakeHead({
      [manifestUrl]: { status: 200, contentLength: 456 },
      [artifactUrl]: { status: 200, contentLength: 1234 },
    });

    await expect(verifyReleasePublication(releaseRow(), BASE, fake.head)).resolves.toEqual({
      manifestStatus: 200,
      artifactCount: 1,
    });
    expect(fake.calls).toEqual([manifestUrl, artifactUrl]);
  });

  it('refuses a missing public manifest before marking anything live', async () => {
    const fake = fakeHead({ [`${BASE}/latest.json`]: { status: 404, contentLength: null } });

    await expect(verifyReleasePublication(releaseRow(), BASE, fake.head)).rejects.toThrow(
      'latest.json',
    );
    expect(fake.calls).toHaveLength(1);
  });

  it('refuses a missing or failed artifact even when the manifest is live', async () => {
    const artifactUrl = `${BASE}/${ARTIFACT_URL}`;
    const fake = fakeHead({
      [`${BASE}/latest.json`]: { status: 200, contentLength: 456 },
      [artifactUrl]: { status: 404, contentLength: null },
    });

    await expect(verifyReleasePublication(releaseRow(), BASE, fake.head)).rejects.toThrow(
      'artifact Papercusp_GUI_0.0.16.AppImage',
    );
  });

  it('refuses an artifact whose public Content-Length differs from the registry', async () => {
    const artifactUrl = `${BASE}/${ARTIFACT_URL}`;
    const fake = fakeHead({
      [`${BASE}/latest.json`]: { status: 200, contentLength: 456 },
      [artifactUrl]: { status: 200, contentLength: 1235 },
    });

    await expect(verifyReleasePublication(releaseRow(), BASE, fake.head)).rejects.toThrow(
      'does not match recorded size 1234',
    );
  });

  it('requires a successful HTTP response for an artifact, not just a size header', async () => {
    const artifactUrl = `${BASE}/${ARTIFACT_URL}`;
    const fake = fakeHead({
      [`${BASE}/latest.json`]: { status: 200, contentLength: 456 },
      [artifactUrl]: { status: 503, contentLength: 1234 },
    });

    await expect(verifyReleasePublication(releaseRow(), BASE, fake.head)).rejects.toThrow(
      'HTTP 503',
    );
  });
});

describe('assertRecordedReleaseScopeApproved', () => {
  const ownerApproval: OwnerDirectiveRow = {
    id: 123,
    workspaceId: 'papercusp-workspace',
    ownerId: 'owner',
    sessionRef: 'owner-session',
    sourceTurnRef: 'owner-turn',
    verbatimText: 'I explicitly approve the partial desktop scope for 0.0.16 alpha; omit macOS and Windows.',
    recordedBy: 'owner-session',
    createdAtMs: 1,
    dispositionedAtMs: null,
    dispositionStatus: null,
    dispositionNote: null,
    dispositionedBy: null,
    capturedByHook: true,
  };

  function incompleteRow(notes: string | null): ReleaseRow {
    const row = releaseRow();
    row.notes = notes;
    row.artifacts.push({
      product: 'server',
      platform: 'linux-x86_64',
      name: 'Papercusp_Server_0.0.16.deb',
      url: 'desktop-v0.0.16-alpha/Papercusp_Server_0.0.16.deb',
      size: 1234,
      sha256: 'b'.repeat(64),
    });
    return row;
  }

  it('rejects a partial registry row without owner approval provenance', async () => {
    await expect(
      assertRecordedReleaseScopeApproved(incompleteRow(null), 'papercusp-workspace'),
    ).rejects.toThrow(/explicit owner approval/u);
  });

  it('rechecks the captured owner directive in the target workspace', async () => {
    await expect(
      assertRecordedReleaseScopeApproved(
        incompleteRow('owner-approved partial desktop scope by directive #123'),
        'papercusp-workspace',
        async (id) => (id === 123 ? ownerApproval : null),
      ),
    ).resolves.toBe(123);
    await expect(
      assertRecordedReleaseScopeApproved(
        incompleteRow('owner-approved partial desktop scope by directive #123'),
        'other-workspace',
        async () => ownerApproval,
      ),
    ).rejects.toThrow(/captured owner directive/u);
  });
});

describe('release publication configuration and wiring', () => {
  it('prefers the manifest base and removes only trailing slashes', () => {
    expect(
      resolveReleaseBaseUrl({
        PAPERCUSP_UPDATE_BASE_URL: `${BASE}///`,
        PAPERCUSP_RELEASE_HOST: 'https://other.example.test',
      }),
    ).toBe(BASE);
  });

  it('runs the registry finalizer after the uploader public URL probe', () => {
    const upload = fs.readFileSync(
      path.resolve(__dirname, '../../../../papercusp-desktop/bin/upload-release.sh'),
      'utf8',
    );
    // The public range-GET probe is `probe_public_manifest_artifacts` (defined once, called
    // on the served manifest); pin its CALL SITE so "after the probe" means after the probe
    // actually ran, not after the function body happened to be declared.
    const publicProbe = upload.indexOf('probe_public_manifest_artifacts "$tmp_manifest"');
    const finalizer = upload.lastIndexOf('finalize-release-publication.ts');
    expect(publicProbe).toBeGreaterThanOrEqual(0);
    expect(finalizer).toBeGreaterThan(publicProbe);
    const scopePreflight = upload.indexOf('--preflight');
    const preflightCommand = upload.lastIndexOf('if ! npx tsx', scopePreflight);
    const firstArtifactUpload = upload.indexOf('release_storage_put "$f"');
    const manifestUpload = upload.indexOf('upload_manifest "$LATEST_JSON"');
    expect(scopePreflight).toBeGreaterThanOrEqual(0);
    expect(firstArtifactUpload).toBeGreaterThanOrEqual(0);
    expect(manifestUpload).toBeGreaterThanOrEqual(0);
    expect(scopePreflight).toBeLessThan(firstArtifactUpload);
    expect(scopePreflight).toBeLessThan(manifestUpload);
    expect(preflightCommand).toBeGreaterThanOrEqual(0);
    expect(preflightCommand).toBeLessThan(publicProbe);
    expect(upload.slice(preflightCommand, firstArtifactUpload)).toMatch(/--preflight/u);
    expect(upload.slice(preflightCommand, firstArtifactUpload)).toMatch(/exit 1/u);
    expect(upload).toContain('PAPERCUSP_UPDATE_BASE_URL="$BASE"');
    expect(upload).toContain('--workspace "${PAPERCUSP_WORKSPACE_ID:-papercusp-workspace}"');
  });
});
