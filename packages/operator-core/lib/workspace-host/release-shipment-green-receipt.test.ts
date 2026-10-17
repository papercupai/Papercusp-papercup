import { deriveWorkspaceHostCanonicalArtifactUrls } from '@papercusp/deployment-driver';
import { describe, expect, it, vi } from 'vitest';

import { projectByocReleaseMilestones } from '../byoc-release-carry';
import type { PipelinePosition } from '../git-pipeline-position';
import type { TaskReleaseJournal } from '../task-manager/store';
import type { ReleaseTaskLedger } from '../../../../scripts/lib/release-task-journal.mjs';
import {
  TASK_ID,
  IMAGE_ID,
  BUNDLE_BYTES,
  bundleBytes,
  bundleDigest,
  publishedManifest,
  journalFor,
  memoryReleaseLedger,
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
