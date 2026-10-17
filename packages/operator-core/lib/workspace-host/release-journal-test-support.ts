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
import { BYOC_RELEASE_MILESTONES } from '../byoc-release-carry';
import {
  ARTIFACT_TRUST_PIPELINE_VERSION,
  type ArtifactTrustReport,
} from './artifact-trust';
import {
  buildWorkspaceHostPublicationManifest,
  type WorkspaceHostPublicationManifest,
} from './publication-manifest';
/**
 * An in-memory release journal behind the real `ReleaseTaskLedger` seam, for tests of the
 * workspace-host release-stage writers. It enforces the two ledger rules the writers rely on:
 * compare-and-swap on the cursor, and intent -> settle transitions per request identity.
 */
import type { ReleaseTaskLedger } from '../../../../scripts/lib/release-task-journal.mjs';
import type {
  AppendTaskReleaseReceiptResult,
  TaskReleaseJournal,
  TaskReleaseReceipt,
} from '../task-manager/store';

export const TASK_ID = 'release-task-1';
export const OPERATION_ID = 'release-operation-1';
export const SOURCE_SHA = 'a'.repeat(40);
export const GITLINKS = { 'papercusp-desktop': 'b'.repeat(40) };
export const BUNDLE = 'c'.repeat(64);
export const OTHER_BUNDLE = 'd'.repeat(64);

export function receipt(
  stage: string,
  state: TaskReleaseReceipt['state'],
  evidenceRefs: string[],
  sequence: number,
): TaskReleaseReceipt {
  return {
    sequence,
    operationId: OPERATION_ID,
    requestIdentity: `request-${sequence}`,
    stage,
    state,
    inputHash: 'e'.repeat(64),
    inputIdentity: null,
    evidenceRefs,
    credentialGeneration: null,
    credentialExpiresAt: null,
    reuseSource: null,
    lookupElapsedMs: null,
    queueWaitMs: null,
    preparationElapsedMs: null,
    reuseExpiresAt: null,
    recordedAt: new Date(0).toISOString(),
  };
}

/** A publication-only task (how r37 was published): the digest is pinned in the artifact identity. */
export function digestJournal(receipts: TaskReleaseReceipt[] = []): TaskReleaseJournal {
  return {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    source: { sha: SOURCE_SHA, gitlinks: { ...GITLINKS } },
    artifactIdentity: { bundleSha256: BUNDLE },
    cursor: receipts.length,
    currentStage: receipts.at(-1)?.stage ?? null,
    currentState: receipts.at(-1)?.state ?? null,
    spentOperationIds: receipts.filter((entry) => entry.state === 'intent').map((entry) => entry.requestIdentity),
    receipts,
  };
}

/** A managed cut (D-394): seeded with a LABEL identity before its build; the build receipt names the digest. */
export function labelJournal(receipts: TaskReleaseReceipt[]): TaskReleaseJournal {
  return {
    ...digestJournal(receipts),
    artifactIdentity: {
      kind: 'papercusp-workspace-host-release',
      sourceSha: SOURCE_SHA,
      version: '0.0.21-p318',
      channel: 'workspace-host-stable',
    },
  };
}

/** Shared shipment fixtures; approval, trust and milestone assertions remain synthetic. */
export const IMAGE_ID = 'papercusp-workspace-host';
export const BUNDLE_BYTES = 42_000;
const SIGNATURE_BYTES = 512;
const SIGNATURE_KEY = 'untrusted comment: Papercusp workspace-host release key\nRWQpublickey';
const SIGNATURE_KEY_SHA = createHash('sha256').update(SIGNATURE_KEY, 'utf8').digest('hex');
const SBOM_SHA = 'b'.repeat(64);
const SIGNATURE_SHA = 'f'.repeat(64);
const ATTESTATION_SHA = 'e'.repeat(64);

export function bundleBytes(fill: string): Buffer {
  return Buffer.alloc(BUNDLE_BYTES, fill);
}

export function bundleDigest(bytes: Buffer): string {
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

export function publishedManifest(input: {
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

export function journalFor(input: { bundleSha256: string; sourceSha: string; version: string; omitMilestone?: string }): TaskReleaseJournal {
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


/** A committed managed build naming BUNDLE. */
export function builtReceipts(): TaskReleaseReceipt[] {
  return [
    receipt('release.build.workspace-host-linux-x86_64', 'intent', [], 0),
    receipt('release.build.workspace-host-linux-x86_64', 'committed', [`bundle:sha256:${BUNDLE}`], 1),
  ];
}

export function memoryReleaseLedger(initial: TaskReleaseJournal): ReleaseTaskLedger & { journal: TaskReleaseJournal } {
  const state = { journal: initial };
  return {
    get journal() {
      return state.journal;
    },
    async getTask(taskId) {
      return taskId === TASK_ID ? { detail: { release: state.journal } } : null;
    },
    taskReleaseJournalFromDetail(detail) {
      return detail?.release === state.journal ? state.journal : null;
    },
    async appendTaskReleaseReceipt(taskId, expectedCursor, input): Promise<AppendTaskReleaseReceiptResult> {
      if (taskId !== TASK_ID) return { ok: false, reason: 'task_not_found', journal: null };
      if (state.journal.cursor !== expectedCursor) return { ok: false, reason: 'cursor_mismatch', journal: state.journal };
      const prior = state.journal.receipts.filter((entry) => entry.requestIdentity === input.requestIdentity).at(-1);
      const valid = input.state === 'intent' ? !prior : prior?.state === 'intent' || prior?.state === 'unknown';
      if (!valid) return { ok: false, reason: 'invalid_transition', journal: state.journal };
      const appended: TaskReleaseReceipt = {
        ...receipt(input.stage, input.state, [...(input.evidenceRefs ?? [])], state.journal.cursor),
        requestIdentity: input.requestIdentity,
        inputHash: input.inputHash,
        inputIdentity: input.inputIdentity ?? null,
      };
      state.journal.receipts.push(appended);
      state.journal.cursor += 1;
      state.journal.currentStage = appended.stage;
      state.journal.currentState = appended.state;
      if (appended.state === 'intent') state.journal.spentOperationIds.push(appended.requestIdentity);
      return { ok: true, journal: state.journal, receipt: appended };
    },
  };
}
