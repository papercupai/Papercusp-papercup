/** R12 detector integration: real isolated PostgreSQL receipt persistence and
 * streamed HTTP artifact bytes. Prior approval/milestone receipts, pipeline
 * ancestry/serving state, trust reports and host installation are FIXTURES.
 * This suite does not prove a deployed release, rollout/rollback or owner acceptance.
 */
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { deriveWorkspaceHostCanonicalArtifactUrls } from '@papercusp/deployment-driver';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import type { ReleaseTaskLedger } from '../../../../scripts/lib/release-task-journal.mjs';
import type { PipelinePosition } from '../git-pipeline-position';
import {
  appendTaskReleaseReceipt, getTask, registerTask, taskReleaseJournalFromDetail,
} from '../task-manager/store';
import {
  IMAGE_ID, SOURCE_SHA, bundleBytes, bundleDigest, journalFor, publishedManifest,
} from './release-journal-test-support';
import {
  WORKSPACE_HOST_RELEASE_SHIPMENT_STAGE, recordWorkspaceHostReleaseShipment,
} from './release-shipment-green-receipt';

const WORKSPACE = 'r12-shipment-integration';
const CURRENT_VERSION = '2026.9.24-1';
const PRIOR_VERSION = '2026.8.22-1';
let db: OrgTestDb;
let server: Server;
let origin: string;
const resources = new Map<string, string | Buffer>();
const requests: string[] = [];
const pathOf = (url: string) => new URL(url).pathname;

const ledger: ReleaseTaskLedger = {
  getTask: id => getTask(id, db.adminSql),
  taskReleaseJournalFromDetail,
  appendTaskReleaseReceipt: (id, cursor, receipt) => appendTaskReleaseReceipt(id, cursor, receipt, db.adminSql),
};

/** Explicit input fixture: never query the live gate or infer actual promotion. */
function pipelineFixture(): PipelinePosition {
  return {
    positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
    positionsUnknown: [],
    deployedSha: SOURCE_SHA,
    serving: {
      host: 'isolated-fixture', unit: 'r12-fixture', pid: 123,
      startedAtMs: 200, codeAsOfMs: 100, codeAsOfSource: 'deploy',
      startedSinceCodeChange: true, evidence: 'health-sha', reportedSha: SOURCE_SHA,
      behindMin: null, restartLever: null, restartSupersededBy: null, unknownReason: null,
    },
  } as unknown as PipelinePosition;
}

async function fixture(options: { missingMilestone?: string; rollbackWorkspace?: string; priorImageId?: string } = {}) {
  const releaseTaskId = 'r12-' + randomUUID();
  const rollbackReleaseTaskId = 'r12-' + randomUUID();
  const currentBytes = bundleBytes('c');
  const priorBytes = bundleBytes('r');
  const currentSha = bundleDigest(currentBytes);
  const priorSha = bundleDigest(priorBytes);
  const currentUrls = deriveWorkspaceHostCanonicalArtifactUrls(currentSha);
  const priorUrls = deriveWorkspaceHostCanonicalArtifactUrls(priorSha);
  resources.set(pathOf(currentUrls.manifestUrl), JSON.stringify(publishedManifest({
    bundleSha256: currentSha, sourceSha: SOURCE_SHA, version: CURRENT_VERSION,
    rollbackTarget: { id: IMAGE_ID, version: PRIOR_VERSION },
  })));
  resources.set(pathOf(currentUrls.bundleUrl), currentBytes);
  resources.set(pathOf(priorUrls.manifestUrl), JSON.stringify(publishedManifest({
    bundleSha256: priorSha, sourceSha: 'b'.repeat(40), version: PRIOR_VERSION,
    imageId: options.priorImageId,
  })));
  resources.set(pathOf(priorUrls.bundleUrl), priorBytes);

  for (const row of [
    { taskId: releaseTaskId, workspaceId: WORKSPACE, sha: currentSha, source: SOURCE_SHA,
      version: CURRENT_VERSION, omitMilestone: options.missingMilestone },
    { taskId: rollbackReleaseTaskId, workspaceId: options.rollbackWorkspace ?? WORKSPACE,
      sha: priorSha, source: 'b'.repeat(40), version: PRIOR_VERSION, omitMilestone: undefined },
  ]) {
    await registerTask({
      class: 'deploy', title: 'R12 isolated detector fixture', argv: [],
      launchedBy: 'r12-integration', harnessSlug: 'papercusp',
      detail: { release: journalFor({ bundleSha256: row.sha, sourceSha: row.source,
        version: row.version, omitMilestone: row.omitMilestone }) },
    }, { workspaceId: row.workspaceId, taskId: row.taskId }, db.adminSql);
  }

  const fetchArtifact: typeof fetch = async (resource, init) => {
    const url = new URL(resource instanceof Request ? resource.url : String(resource));
    if (url.origin !== new URL(currentUrls.bundleUrl).origin) throw new Error('unexpected artifact origin');
    // Preserve the production content-addressed path; transport only to our owned server.
    return fetch(new URL(url.pathname + url.search, origin), init);
  };
  const input: Parameters<typeof recordWorkspaceHostReleaseShipment>[0] = {
    workspaceId: WORKSPACE, hostId: 'r12-isolated-host', releaseTaskId, rollbackReleaseTaskId,
    ledger, fetchArtifact, readPipelinePosition: async () => pipelineFixture(),
    readHostRuntimeRelease: async () => ({ bundleSha256: currentSha, version: CURRENT_VERSION }),
  };
  return { input, currentSha, priorSha, currentUrls, priorUrls };
}

async function savedJournal(taskId: string) {
  const task = await getTask(taskId, db.adminSql);
  const journal = taskReleaseJournalFromDetail(task?.detail);
  expect(journal).not.toBeNull();
  return journal!;
}

describe('green-shipment detector with PostgreSQL and HTTP', () => {
  beforeAll(async () => {
    db = await createOrgTestDb();
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      requests.push(path);
      const body = resources.get(path);
      if (body === undefined) { response.writeHead(404); response.end(); return; }
      response.setHeader('content-type', typeof body === 'string' ? 'application/json' : 'application/octet-stream');
      response.end(body);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('local HTTP listener missing');
    origin = 'http://127.0.0.1:' + address.port;
  }, 180_000);

  beforeEach(() => { resources.clear(); requests.length = 0; });
  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await db?.cleanup();
  }, 120_000);

  it('persists a verified control and reuses its committed receipt without another HTTP request', async () => {
    const test = await fixture();
    const result = await recordWorkspaceHostReleaseShipment(test.input);
    expect(result).toMatchObject({ outcome: 'committed', bundleSha256: test.currentSha, sourceSha: SOURCE_SHA });
    expect(requests).toEqual(expect.arrayContaining([
      pathOf(test.currentUrls.manifestUrl), pathOf(test.currentUrls.bundleUrl),
      pathOf(test.priorUrls.manifestUrl), pathOf(test.priorUrls.bundleUrl),
    ]));
    const saved = await savedJournal(test.input.releaseTaskId);
    expect(saved.receipts.slice(-2).map(receipt => [receipt.stage, receipt.state]))
      .toEqual([[WORKSPACE_HOST_RELEASE_SHIPMENT_STAGE, 'intent'], [WORKSPACE_HOST_RELEASE_SHIPMENT_STAGE, 'committed']]);
    expect(saved.receipts.at(-1)?.evidenceRefs).toContain('shipment-current-bundle:' + test.currentSha + ':' + bundleBytes('c').length);
    const requestCount = requests.length;
    expect((await recordWorkspaceHostReleaseShipment(test.input)).outcome).toBe('committed');
    expect((await savedJournal(test.input.releaseTaskId)).cursor).toBe(saved.cursor);
    expect(requests).toHaveLength(requestCount);
  });

  it('refuses same-sized wrong bytes actually served at the expected content address', async () => {
    const test = await fixture();
    resources.set(pathOf(test.currentUrls.bundleUrl), bundleBytes('x'));
    const result = await recordWorkspaceHostReleaseShipment(test.input);
    expect(result.outcome).toBe('refused');
    expect(result.evidenceRefs).toContainEqual(expect.stringContaining('shipment-failed:bundle-digest-mismatch:'));
    expect((await savedJournal(test.input.releaseTaskId)).receipts.at(-1)?.state).toBe('refused');
    expect(requests).toContain(pathOf(test.currentUrls.bundleUrl));
  });

  it('refuses an HTTP rollback manifest whose image differs from the declared target', async () => {
    const test = await fixture({ priorImageId: 'different-fixture-image' });
    const result = await recordWorkspaceHostReleaseShipment(test.input);
    expect(result.outcome).toBe('refused');
    expect(result.evidenceRefs).toContain('shipment-failed:rollback-image-does-not-match-manifest-target');
    expect((await savedJournal(test.input.releaseTaskId)).receipts.at(-1)?.state).toBe('refused');
  });

  it('persists refusal for a missing prerequisite before requesting artifact bytes', async () => {
    const test = await fixture({ missingMilestone: 'cleanup' });
    const result = await recordWorkspaceHostReleaseShipment(test.input);
    expect(result.outcome).toBe('refused');
    expect(result.evidenceRefs).toContain('shipment-failed:prior-milestones-unverified:cleanup:pending');
    expect((await savedJournal(test.input.releaseTaskId)).receipts.at(-1)?.state).toBe('refused');
    expect(requests).toEqual([]);
  });

  it('refuses a rollback task from a different workspace before artifact reads', async () => {
    const test = await fixture({ rollbackWorkspace: 'r12-other-workspace' });
    const result = await recordWorkspaceHostReleaseShipment(test.input);
    expect(result.outcome).toBe('refused');
    expect(result.evidenceRefs).toContain('shipment-failed:rollback-release-task-scope-mismatch');
    expect((await savedJournal(test.input.releaseTaskId)).receipts.at(-1)?.state).toBe('refused');
    expect(requests).toEqual([]);
  });
});
