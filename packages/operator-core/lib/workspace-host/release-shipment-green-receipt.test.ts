import { createHash } from 'node:crypto';
import {
  WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
  WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
  WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
  WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
  WORKSPACE_HOST_SHARED_BUILDER_KIND,
  buildWorkspaceHostBuildManifest,
  deriveWorkspaceHostCanonicalArtifactUrls,
  workspaceHostRequiredReleaseMaterialFixtures,
  type WorkspaceHostImageArtifact,
} from '@papercusp/deployment-driver';
import { describe, expect, it, vi } from 'vitest';

import { BYOC_RELEASE_MILESTONES, projectByocReleaseMilestones } from '../byoc-release-carry';
import type { PipelinePosition } from '../git-pipeline-position';
import type { TaskReleaseJournal } from '../task-manager/store';
import type { ReleaseTaskLedger } from '../../../../scripts/lib/release-task-journal.mjs';
import {
  ARTIFACT_TRUST_PIPELINE_VERSION,
  type ArtifactTrustReport,
} from './artifact-trust';
import {
  buildWorkspaceHostPublicationManifest,
  type WorkspaceHostPublicationManifest,
} from './publication-manifest';
import {
  OPERATION_ID,
  TASK_ID,
  labelJournal,
  memoryReleaseLedger,
  receipt,
} from './release-journal-test-support';
import type { Sql } from 'postgres';
import {
  WORKSPACE_HOST_RELEASE_SHIPMENT_STAGE,
  latestGreenShippedReleaseInScope,
  recordWorkspaceHostReleaseShipment,
} from './release-shipment-green-receipt';

const ROLLBACK_TASK_ID = 'rollback-task-1';
const WORKSPACE_ID = 'workspace-1';
const HOST_ID = 'host-1';
const SOURCE_SHA = 'a'.repeat(40);
const ROLLBACK_SOURCE_SHA = 'b'.repeat(40);
const CURRENT_VERSION = '2026.9.24-1';
const ROLLBACK_VERSION = '2026.8.22-1';
const IMAGE_ID = 'papercusp-workspace-host';
const BUNDLE_BYTES = 42_000;
const SIGNATURE_BYTES = 512;
const SIGNATURE_KEY = 'untrusted comment: Papercusp workspace-host release key\nRWQpublickey';
const SIGNATURE_KEY_SHA = createHash('sha256').update(SIGNATURE_KEY, 'utf8').digest('hex');
const SBOM_SHA = 'b'.repeat(64);
const SIGNATURE_SHA = 'f'.repeat(64);
const ATTESTATION_SHA = 'e'.repeat(64);

function bundleBytes(fill: string): Buffer {
  return Buffer.alloc(BUNDLE_BYTES, fill);
}

function bundleDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function artifactTrustReport(bundleSha256: string, version: string): ArtifactTrustReport {
  const path = 'dist/papercusp-server-' + version + '.tgz';
  return {
    version: ARTIFACT_TRUST_PIPELINE_VERSION,
    subject: { path, name: 'papercusp-server-' + version + '.tgz', bytes: BUNDLE_BYTES, sha256: bundleSha256, signed: true },
    policy: {
      denyVulnerabilitiesAtOrAbove: 'high',
      maxSecretFindings: 0,
      maxAttestationAgeMs: 86_400_000,
    },
    trusted: true,
    evidence: [
      {
        kind: 'signature',
        subjectSha256: bundleSha256,
        tool: { name: 'minisign', version: '0.11' },
        valid: true,
        signatureSha256: SIGNATURE_SHA,
        signingKeySha256: SIGNATURE_KEY_SHA,
      },
      {
        kind: 'sbom',
        subjectSha256: bundleSha256,
        tool: { name: 'syft', version: '1.4.1' },
        format: 'spdx-json',
        documentSha256: SBOM_SHA,
        componentCount: 128,
      },
      {
        kind: 'vulnerability-scan',
        subjectSha256: bundleSha256,
        tool: { name: 'grype', version: '0.79.0' },
        sbomSha256: SBOM_SHA,
        findings: [],
      },
      {
        kind: 'secret-scan',
        subjectSha256: bundleSha256,
        tool: { name: 'gitleaks', version: '8.18.0' },
        findings: [],
      },
      {
        kind: 'provenance-attestation',
        subjectSha256: bundleSha256,
        tool: { name: 'cosign', version: '2.2.4' },
        valid: true,
        predicateType: 'https://slsa.dev/provenance/v1',
        issuedAt: '2026-09-24T00:00:00Z',
        attestationSha256: ATTESTATION_SHA,
      },
    ],
    failures: [],
  };
}

function publishedManifest(input: {
  bundleSha256: string;
  sourceSha: string;
  version: string;
  imageId?: string;
  rollbackTarget?: { id: string; version: string };
}): WorkspaceHostPublicationManifest {
  const urls = deriveWorkspaceHostCanonicalArtifactUrls(input.bundleSha256);
  const name = 'papercusp-server-' + input.version + '.tgz';
  const artifact: WorkspaceHostImageArtifact = {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    image: { id: input.imageId ?? IMAGE_ID, version: input.version },
    buildManifest: buildWorkspaceHostBuildManifest({
      contractVersion: WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
      distributionProfile: 'vm-release',
      source: {
        repository: 'https://github.com/Papercusp/papercusp.git',
        revision: input.sourceSha,
      },
      releaseArtifact: {
        name,
        version: input.version,
        sha256: input.bundleSha256,
        sizeBytes: BUNDLE_BYTES,
      },
      baseImage: {
        reference: 'projects/papercusp-images-123/global/images/ubuntu-2404-minimal',
        architecture: 'x86_64',
        sha256: 'c'.repeat(64),
      },
      builder: {
        strategy: 'shared',
        kind: WORKSPACE_HOST_SHARED_BUILDER_KIND,
        version: '1.14.2',
        templatePath: 'infra/images/workspace-host.pkr.hcl',
        templateSha256: 'd'.repeat(64),
      },
      materials: [
        { path: 'dist/papercusp-server.tgz', sha256: input.bundleSha256, sizeBytes: BUNDLE_BYTES },
        ...workspaceHostRequiredReleaseMaterialFixtures(),
      ],
      parameters: [{ name: 'distribution_profile', value: 'vm-release' }],
      targets: [{ provider: 'gcp', locations: ['us-central1'] }],
    }),
    release: {
      version: input.version,
      bundleUrl: urls.bundleUrl,
      bundleSha256: input.bundleSha256,
      signatureUrl: urls.signatureUrl,
      signingPublicKey: SIGNATURE_KEY,
      signingKeySha256: SIGNATURE_KEY_SHA,
    },
    lifecycle: {
      state: 'active',
      publishedAt: '2026-09-24T00:00:00Z',
      ...(input.rollbackTarget ? { rollbackTarget: input.rollbackTarget } : {}),
    },
    compatibility: [
      {
        provider: 'gcp',
        architecture: 'x86_64',
        ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
        bootstrapContractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
        actions: ['install'],
        maximumArtifactAgeDays: 30,
      },
    ],
  };
  return buildWorkspaceHostPublicationManifest({
    artifact,
    trustReport: artifactTrustReport(input.bundleSha256, input.version),
    bundle: { sha256: input.bundleSha256, bytes: BUNDLE_BYTES },
    signature: { sha256: SIGNATURE_SHA, bytes: SIGNATURE_BYTES },
  });
}

function journalFor(input: { bundleSha256: string; sourceSha: string; version: string; omitMilestone?: string }): TaskReleaseJournal {
  const stages = BYOC_RELEASE_MILESTONES.slice(0, -1)
    .filter((milestone) => milestone.key !== input.omitMilestone)
    .map((milestone) => {
      const first = milestone.stages[0]!;
      return first.endsWith('.') ? first + 'workspace-host-linux-x86_64' : first;
    });
  const receipts = stages.map((stage, sequence) => {
    const refs = stage.startsWith('release.build.')
      ? ['bundle:sha256:' + input.bundleSha256]
      : stage === 'publish.finalize'
        ? ['provider:bundle:' + input.bundleSha256]
        : ['milestone:' + stage];
    return receipt(stage, 'committed', refs, sequence);
  });
  const journal = labelJournal(receipts);
  return {
    ...journal,
    operationId: OPERATION_ID,
    source: { sha: input.sourceSha, gitlinks: {} },
    artifactIdentity: {
      kind: 'papercusp-workspace-host-release',
      sourceSha: input.sourceSha,
      version: input.version,
      channel: 'workspace-host-stable',
    },
  };
}

function releaseLedger(
  currentJournal: TaskReleaseJournal,
  rollbackJournal: TaskReleaseJournal,
): ReleaseTaskLedger & { currentJournal: TaskReleaseJournal } {
  const currentStore = memoryReleaseLedger(currentJournal);
  const rollbackStore = memoryReleaseLedger(rollbackJournal);
  const task = (taskId: string, journal: ReturnType<typeof journalFor>) => ({
    taskId,
    workspaceId: WORKSPACE_ID,
    harnessSlug: 'papercusp',
    class: 'deploy',
    endedAt: null,
    detail: { release: journal },
  });
  return {
    async getTask(taskId: string) {
      if (taskId === TASK_ID) return task(TASK_ID, currentStore.journal);
      if (taskId === ROLLBACK_TASK_ID) return task(ROLLBACK_TASK_ID, rollbackStore.journal);
      return null;
    },
    taskReleaseJournalFromDetail(detail: Record<string, unknown> | null | undefined) {
      const release = detail?.release;
      if (release === currentStore.journal) return currentStore.taskReleaseJournalFromDetail(detail);
      if (release === rollbackStore.journal) return rollbackStore.taskReleaseJournalFromDetail(detail);
      return null;
    },
    appendTaskReleaseReceipt: currentStore.appendTaskReleaseReceipt.bind(currentStore),
    get currentJournal() {
      return currentStore.journal;
    },
  } as ReleaseTaskLedger & { currentJournal: TaskReleaseJournal };
}

function pipelinePosition(overrides: Record<string, unknown> = {}): PipelinePosition {
  return {
    positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
    positionsUnknown: [],
    deployedSha: 'f'.repeat(40),
    serving: {
      host: 'operator-release',
      unit: 'papercup-dev-api',
      pid: 123,
      startedAtMs: 200,
      codeAsOfMs: 100,
      codeAsOfSource: 'deploy',
      startedSinceCodeChange: true,
      behindMin: null,
      restartLever: null,
      restartSupersededBy: null,
      evidence: 'health-sha',
      reportedSha: 'f'.repeat(12),
      unknownReason: null,
    },
    ...overrides,
  } as unknown as PipelinePosition;
}

function fixture(
  options: { missingMilestone?: string; priorImageId?: string; priorImageVersion?: string; undeclaredTarget?: boolean } = {},
) {
  const currentBytes = bundleBytes('c');
  const rollbackBytes = bundleBytes('r');
  const currentSha = bundleDigest(currentBytes);
  const rollbackSha = bundleDigest(rollbackBytes);
  const currentJournal = journalFor({
    bundleSha256: currentSha,
    sourceSha: SOURCE_SHA,
    version: CURRENT_VERSION,
    ...(options.missingMilestone ? { omitMilestone: options.missingMilestone } : {}),
  });
  const rollbackJournal = journalFor({
    bundleSha256: rollbackSha,
    sourceSha: ROLLBACK_SOURCE_SHA,
    version: ROLLBACK_VERSION,
  });
  const currentManifest = publishedManifest({
    bundleSha256: currentSha,
    sourceSha: SOURCE_SHA,
    version: CURRENT_VERSION,
    ...(options.undeclaredTarget ? {} : { rollbackTarget: { id: IMAGE_ID, version: ROLLBACK_VERSION } }),
  });
  const rollbackManifest = publishedManifest({
    bundleSha256: rollbackSha,
    sourceSha: ROLLBACK_SOURCE_SHA,
    version: ROLLBACK_VERSION,
    imageId: options.priorImageId ?? IMAGE_ID,
  });
  const responses = new Map<string, Response>();
  const currentUrls = deriveWorkspaceHostCanonicalArtifactUrls(currentSha);
  const rollbackUrls = deriveWorkspaceHostCanonicalArtifactUrls(rollbackSha);
  responses.set(currentUrls.manifestUrl, new Response(JSON.stringify(currentManifest)));
  responses.set(currentUrls.bundleUrl, new Response(new Uint8Array(currentBytes)));
  responses.set(rollbackUrls.manifestUrl, new Response(JSON.stringify(rollbackManifest)));
  responses.set(rollbackUrls.bundleUrl, new Response(new Uint8Array(rollbackBytes)));
  const fetchArtifact = vi.fn(async (url: string) => responses.get(url)?.clone() ?? new Response(null, { status: 404 }));
  const readPipelinePosition = vi.fn(async () => pipelinePosition());
  const ledger = releaseLedger(currentJournal, rollbackJournal);
  const input: Parameters<typeof recordWorkspaceHostReleaseShipment>[0] = {
    workspaceId: WORKSPACE_ID,
    hostId: HOST_ID,
    releaseTaskId: TASK_ID,
    rollbackReleaseTaskId: ROLLBACK_TASK_ID,
    ledger,
    readHostRuntimeRelease: async () => ({ bundleSha256: currentSha, version: CURRENT_VERSION }),
    readPipelinePosition,
    fetchArtifact: fetchArtifact as unknown as typeof fetch,
  };
  return { input, currentSha, rollbackSha, fetchArtifact, readPipelinePosition, ledger };
}

describe('release.shipment.green', () => {
  it('commits only after the prior milestones, main/deployed health, both public bundles, and rollback image agree', async () => {
    const test = fixture();

    const result = await recordWorkspaceHostReleaseShipment(test.input);

    expect(result).toMatchObject({
      outcome: 'committed',
      stage: WORKSPACE_HOST_RELEASE_SHIPMENT_STAGE,
      releaseTaskId: TASK_ID,
      rollbackReleaseTaskId: ROLLBACK_TASK_ID,
      hostId: HOST_ID,
      bundleSha256: test.currentSha,
      sourceSha: SOURCE_SHA,
    });
    expect(result.evidenceRefs).toEqual(
      expect.arrayContaining([
        'shipment-source-in-main:' + SOURCE_SHA,
        'shipment-deployed-sha:' + 'f'.repeat(40),
        'shipment-rollback-bundle:' + test.rollbackSha + ':' + BUNDLE_BYTES,
        'shipment-rollback-target:' + IMAGE_ID + '@' + ROLLBACK_VERSION,
      ]),
    );
    expect(test.ledger.currentJournal.receipts.at(-1)).toMatchObject({
      stage: WORKSPACE_HOST_RELEASE_SHIPMENT_STAGE,
      state: 'committed',
    });
    expect(projectByocReleaseMilestones(test.ledger.currentJournal).shipped).toBe(true);

    const priorCount = test.ledger.currentJournal.receipts.length;
    const repeated = await recordWorkspaceHostReleaseShipment(test.input);
    expect(repeated.outcome).toBe('committed');
    expect(test.ledger.currentJournal.receipts).toHaveLength(priorCount);
  });

  it('settles a refused receipt before making release-plane reads when an earlier milestone is missing', async () => {
    const test = fixture({ missingMilestone: 'cleanup' });

    const result = await recordWorkspaceHostReleaseShipment(test.input);

    expect(result.outcome).toBe('refused');
    expect(result.evidenceRefs).toContain('shipment-failed:prior-milestones-unverified:cleanup:pending');
    expect(test.readPipelinePosition).not.toHaveBeenCalled();
    expect(test.fetchArtifact).not.toHaveBeenCalled();
    expect(test.ledger.currentJournal.receipts.at(-1)).toMatchObject({
      stage: WORKSPACE_HOST_RELEASE_SHIPMENT_STAGE,
      state: 'refused',
    });
  });

  it('refuses an unmeasured main ancestry and a serving process that predates the release trigger', async () => {
    const test = fixture();
    test.readPipelinePosition.mockResolvedValueOnce(
      pipelinePosition({
        positions: { committedLocal: true, onStaging: true, inMain: false, deployed: true },
        positionsUnknown: ['inMain'],
        serving: {
          ...pipelinePosition().serving,
          startedAtMs: 50,
          startedSinceCodeChange: false,
        },
      }),
    );

    const result = await recordWorkspaceHostReleaseShipment(test.input);

    expect(result.outcome).toBe('refused');
    expect(result.evidenceRefs).toEqual(
      expect.arrayContaining([
        'shipment-failed:main-ancestry-unmeasured',
        'shipment-failed:normal-release-trigger-not-observed',
      ]),
    );
  });

  it.each([
    {
      label: 'source that is not promoted to main',
      position: pipelinePosition({
        positions: { committedLocal: true, onStaging: true, inMain: false, deployed: true },
      }),
      failure: 'shipment-failed:source-not-in-main',
    },
    {
      label: 'source that is not the deployed artifact',
      position: pipelinePosition({
        positions: { committedLocal: true, onStaging: true, inMain: true, deployed: false },
        deployedSha: null,
      }),
      failure: 'shipment-failed:source-not-deployed',
    },
    {
      label: 'serving health identity that disagrees with the deployed artifact',
      position: pipelinePosition({
        serving: { ...pipelinePosition().serving, reportedSha: 'e'.repeat(40) },
      }),
      failure: 'shipment-failed:serving-health-sha-not-bound-to-deploy',
    },
  ])('refuses $label', async ({ position, failure }) => {
    const test = fixture();
    test.readPipelinePosition.mockResolvedValueOnce(position);

    const result = await recordWorkspaceHostReleaseShipment(test.input);

    expect(result.outcome).toBe('refused');
    expect(result.evidenceRefs).toContain(failure);
  });

  it('refuses when the rollback bundle image does not match the current manifest target', async () => {
    const test = fixture({ priorImageId: 'different-workspace-host-image' });

    const result = await recordWorkspaceHostReleaseShipment(test.input);

    expect(result.outcome).toBe('refused');
    expect(result.evidenceRefs).toContain('shipment-failed:rollback-image-does-not-match-manifest-target');
  });

  describe('D-437 first green shipment (manifest declares no rollback edge)', () => {
    it('commits with no rollback release when nothing in scope has shipped green', async () => {
      const test = fixture({ undeclaredTarget: true });
      const hasPriorGreenShipment = vi.fn(async () => false);

      const result = await recordWorkspaceHostReleaseShipment({
        ...test.input,
        rollbackReleaseTaskId: undefined,
        hasPriorGreenShipment,
      });

      expect(result.outcome).toBe('committed');
      expect(result.rollbackReleaseTaskId).toBeNull();
      expect(result.evidenceRefs).toContain('shipment-rollback-target:none-first-shipment');
      expect(hasPriorGreenShipment).toHaveBeenCalledWith(TASK_ID);
      const rollbackUrls = deriveWorkspaceHostCanonicalArtifactUrls(test.rollbackSha);
      expect(test.fetchArtifact).not.toHaveBeenCalledWith(rollbackUrls.manifestUrl, expect.anything());
    });

    it('refuses an undeclared rollback edge once any release in scope has shipped green', async () => {
      const test = fixture({ undeclaredTarget: true });

      const result = await recordWorkspaceHostReleaseShipment({
        ...test.input,
        rollbackReleaseTaskId: undefined,
        hasPriorGreenShipment: async () => true,
      });

      expect(result.outcome).toBe('refused');
      expect(result.evidenceRefs).toContain('shipment-failed:rollback-target-undeclared');
    });

    it('refuses a declared rollback edge when no rollback release task is named', async () => {
      const test = fixture();
      const hasPriorGreenShipment = vi.fn(async () => false);

      const result = await recordWorkspaceHostReleaseShipment({
        ...test.input,
        rollbackReleaseTaskId: undefined,
        hasPriorGreenShipment,
      });

      expect(result.outcome).toBe('refused');
      expect(result.evidenceRefs).toContain('shipment-failed:rollback-release-task-required');
      expect(hasPriorGreenShipment).not.toHaveBeenCalled();
    });

    it('still refuses a named rollback release when the manifest declares no edge', async () => {
      const test = fixture({ undeclaredTarget: true });

      const result = await recordWorkspaceHostReleaseShipment({ ...test.input, hasPriorGreenShipment: async () => false });

      expect(result.outcome).toBe('refused');
      expect(result.evidenceRefs).toContain('shipment-failed:rollback-image-does-not-match-manifest-target');
    });
  });

  it('refuses when bytes served from a content address do not match its digest', async () => {
    const test = fixture();
    const currentUrls = deriveWorkspaceHostCanonicalArtifactUrls(test.currentSha);
    const badBytes = bundleBytes('x');
    const wrongResponse = new Response(new Uint8Array(badBytes));
    const original = test.fetchArtifact.getMockImplementation()!;
    test.fetchArtifact.mockImplementation(async (url: string) => {
      if (url === currentUrls.bundleUrl) return wrongResponse.clone();
      return original(url);
    });

    const result = await recordWorkspaceHostReleaseShipment(test.input);

    expect(result.outcome).toBe('refused');
    expect(result.evidenceRefs.some((ref) => ref.startsWith('shipment-failed:bundle-digest-mismatch'))).toBe(true);
  });
});

// WI-10003878 / D-437: the publisher's rollback edge reader. The SQL scope is shared with the
// first-shipment EXISTS check; these pin the parameters it binds and how it reads the row.
describe('latestGreenShippedReleaseInScope', () => {
  function fakeSql(rows: unknown[]) {
    const values: unknown[][] = [];
    const sql = (async (_strings: TemplateStringsArray, ...bound: unknown[]) => {
      values.push(bound);
      return rows;
    }) as unknown as Sql;
    return { sql, values };
  }

  it('returns the green-shipped task and its version, scoped from this cut task and the shipment stage', async () => {
    const { sql, values } = fakeSql([{ taskId: 'prior-green', version: '0.0.21-p318r60' }]);
    await expect(latestGreenShippedReleaseInScope('cut-task', sql)).resolves.toEqual({
      taskId: 'prior-green',
      version: '0.0.21-p318r60',
    });
    expect(values).toEqual([['cut-task', WORKSPACE_HOST_RELEASE_SHIPMENT_STAGE]]);
  });

  it('returns null when nothing in scope has shipped green (the first shipment)', async () => {
    await expect(latestGreenShippedReleaseInScope('cut-task', fakeSql([]).sql)).resolves.toBeNull();
  });

  it('refuses a green shipment whose task records no version rather than publishing without an edge', async () => {
    await expect(
      latestGreenShippedReleaseInScope('cut-task', fakeSql([{ taskId: 'prior-green', version: null }]).sql),
    ).rejects.toThrow(/records no artifactIdentity\.version/);
  });
});
