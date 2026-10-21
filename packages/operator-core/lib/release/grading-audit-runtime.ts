import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { getBuildInfo, type BuildInfo } from '../build-info';
import { requestOnlyIdentityGuardMarker } from '../harness/env-operator-launcher';
import { acquireGradingAuditSubjectMutex } from '../scorecards';
import { killTask } from '../task-manager/control';
import { managedSpawn } from '../task-manager/managed-spawn';
import { listTasks } from '../task-manager/store';
import type { TaskRow } from '../task-manager/types';
import {
  GRADING_AUDIT_SOURCE_PIN_MAX_SEC,
  readGradingAuditSourcePin,
  releaseGradingAuditSourcePin,
  writeGradingAuditSourcePin,
  type GradingAuditSourcePin,
} from './grading-audit-source-pin';

const LABEL = 'grading-audit-runtime:';

/** Persisted before spawn; sufficient to recover without the staging alias. */
export interface GradingAuditRuntimeLocator extends GradingAuditSourcePin {
  bundlePath: string;
  baseUrl: string;
  issueIds: string[];
}

export interface GradingAuditRuntimeBinding {
  taskId: string;
  baseUrl: string;
  evaluatorBuild: BuildInfo;
  bundleSha256: string;
  expiresAtSec: number;
}

export interface GradingAuditRuntimeDeps {
  now?: () => number;
  list?: (workspaceId: string, label: string) => Promise<TaskRow[]>;
  mutex?: <T>(workspaceId: string, key: string, fn: () => Promise<T>) => Promise<T>;
  currentSource?: (build: BuildInfo) => Omit<GradingAuditRuntimeLocator, 'baseUrl' | 'issueIds' | 'expiresAtSec'>;
  recoverSource?: (workspaceId: string, build: BuildInfo, nowSec: number) => GradingAuditRuntimeLocator | null;
  freePort?: () => Promise<number>;
  spawn?: (workspaceId: string, locator: GradingAuditRuntimeLocator) => Promise<string>;
  probe?: (baseUrl: string) => Promise<BuildInfo | null>;
  attach?: (taskId: string, workspaceId: string, issueIds: string[]) => Promise<void>;
  stop?: (taskId: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

function sameBuild(a: BuildInfo, b: BuildInfo): boolean {
  return Boolean(a.sha && a.sha !== 'unknown' && a.version && a.sha === b.sha && a.version === b.version);
}

function labelFor(build: BuildInfo, workspaceId: string): string {
  if (!build.sha || build.sha === 'unknown' || !build.version) throw new Error('Exact audit evaluator identity is unknown');
  return LABEL + createHash('sha256').update(JSON.stringify([workspaceId, build.sha, build.version])).digest('hex');
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function listRuntimeTasks(workspaceId: string, labelPrefix: string): Promise<TaskRow[]> {
  // History must never consume the window that proves which endpoints are live.
  const [live, history] = await Promise.all([
    listTasks({ workspaceId, labelPrefix, states: ['pending', 'running', 'unaccounted'], limit: 2000 }),
    listTasks({ workspaceId, labelPrefix, includeEnded: true,
      states: ['exited', 'killed', 'timed_out', 'stranded', 'ended_unobserved'], limit: 100 }),
  ]);
  if (live.length === 2000) throw new Error('Audit runtime live-task census is incomplete');
  return [...live, ...history];
}

/** Only a running, immutable, maintained host bundle may seed a new locator. */
function currentSource(build: BuildInfo): ReturnType<NonNullable<GradingAuditRuntimeDeps['currentSource']>> {
  if (!sameBuild(getBuildInfo(), build)) throw new Error('This host cannot seed a different evaluator build');
  const bundlePath = realpathSync(process.argv[1] ?? '');
  const sourceRoot = realpathSync(resolve(dirname(bundlePath), '../../..'));
  if (bundlePath !== join(sourceRoot, 'apps/operator/dist-host/hono-host.mjs')) {
    throw new Error('Exact audit retention requires the maintained immutable host bundle');
  }
  // This marker is emitted only by the actual load-only identity implementation.
  if (!readFileSync(bundlePath).includes(requestOnlyIdentityGuardMarker())) {
    throw new Error('Audit runtime bundle lacks request-only identity support');
  }
  return { schemaVersion: 1, sourceRoot, bundlePath, evaluatorBuild: build,
    bundleSha256: digest(bundlePath), ownerRef: '' };
}

export function gradingAuditRuntimeChildEnv(locator: GradingAuditRuntimeLocator): NodeJS.ProcessEnv {
  const port = new URL(locator.baseUrl).port;
  return {
    ...process.env,
    PAPERCUSP_INTEGRATION_ROOT: locator.sourceRoot,
    PAPERCUSP_HONO_PORT: port, PORT: port, PAPERCUSP_BIND_HOST: '127.0.0.1',
    PAPERCUSP_BACKGROUND_WORKERS: '0', PAPERCUSP_USE_EMBEDDED_PG: '0',
    PAPERCUSP_DBOS_ENABLE: '0', PAPERCUSP_DBOS_ROUTINES: '0', PAPERCUSP_DBOS_ORCHESTRATOR: '0',
    PAPERCUSP_PROVISION_ENV_OPERATORS: '0', PAPERCUSP_IPC_ENABLE: '0',
    PAPERCUSP_IDENTITY_MODE: 'load-only', PAPERCUSP_ENV_OPERATOR_ID: locator.ownerRef,
    PAPERCUSP_BUILD_SHA: locator.evaluatorBuild.sha!, PAPERCUSP_BUILD_VERSION: locator.evaluatorBuild.version,
    DBOS__VMID: locator.ownerRef,
    // A sibling must not inherit another sidecar's entry-mode selector.
    PAPERCUSP_SUBSTRATE_SIDECAR_MODE: '0', PAPERCUSP_SPAWNER_SIDECAR_MODE: '0',
    PAPERCUSP_GATEWAY_SIDECAR_MODE: '0', PAPERCUSP_EMBED_SIDECAR_MODE: '0',
    PAPERCUSP_LSP_DAEMON_MODE: '0', PAPERCUSP_RESOURCE_GOVERNOR_MONITOR_MODE: '0',
    PAPERCUSP_REPAIR_PRECHECK_WORKER_MODE: '0',
  };
}

async function spawnRuntime(workspaceId: string, locator: GradingAuditRuntimeLocator): Promise<string> {
  const logPath = join(dirname(locator.sourceRoot), 'grading-audit-runtime.log');
  const fd = openSync(logPath, 'a', 0o600);
  try {
    const spawned = await managedSpawn(process.execPath, [locator.bundlePath], {
      class: 'sidecar', title: locator.ownerRef, argv: [process.execPath, locator.bundlePath],
      launchedBy: 'system:grading-audit-dispatch', cwd: locator.sourceRoot, logPath,
      runtimeMaxSec: Math.max(1, locator.expiresAtSec - Math.floor(Date.now() / 1000)),
      detail: { label: locator.ownerRef, gradingAuditRuntime: locator },
    }, { workspaceId, requireRegistration: true,
      spawnOptions: { cwd: locator.sourceRoot, env: gradingAuditRuntimeChildEnv(locator), detached: true, stdio: ['ignore', fd, fd] } });
    if (!spawned.confined) {
      await stopRuntime(spawned.taskId);
      throw new Error('Exact audit runtime requires confined lifetime enforcement');
    }
    spawned.child.unref();
    return spawned.taskId;
  } finally { closeSync(fd); }
}

async function stopRuntime(taskId: string): Promise<void> {
  const result = await killTask(taskId, { includeSubtree: true, escalateAfterMs: 5000 });
  if (!result.ok && !['not_live', 'task_not_found', 'already_gone'].includes(result.error ?? '')) {
    throw new Error(`Audit runtime retirement failed: ${result.error}`);
  }
}

async function attach(taskId: string, workspaceId: string, issueIds: string[]): Promise<void> {
  const { sql } = getOrgPg();
  const rows = await sql`UPDATE harness_shared.task_ledger
    SET detail = jsonb_set(detail, '{gradingAuditRuntime,issueIds}', ${sql.json(issueIds)})
    WHERE task_id = ${taskId} AND workspace_id = ${workspaceId} AND state IN ('pending','running')
    RETURNING task_id`;
  if (!rows.length) throw new Error('Audit runtime ownership changed before attachment');
}

async function freePort(): Promise<number> {
  return new Promise((done, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : typeof address === 'object' && address
        ? done(address.port) : reject(new Error('No audit runtime port')));
    });
  });
}

async function probe(baseUrl: string): Promise<BuildInfo | null> {
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    const body = await response.json() as Partial<BuildInfo>;
    return typeof body.sha === 'string' && typeof body.version === 'string'
      ? { sha: body.sha, version: body.version } : null;
  } catch { return null; }
}

async function mutex<T>(workspaceId: string, key: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireGradingAuditSubjectMutex({ workspaceId, subjectIssueId: key });
  try { return await fn(); } finally { await release(); }
}

function locatorFrom(row: Pick<TaskRow, 'detail'>): GradingAuditRuntimeLocator | null {
  const raw = row.detail.gradingAuditRuntime as GradingAuditRuntimeLocator | undefined;
  if (!raw || raw.schemaVersion !== 1 || typeof raw.sourceRoot !== 'string' ||
      typeof raw.bundlePath !== 'string' || typeof raw.ownerRef !== 'string' ||
      !Array.isArray(raw.issueIds) || raw.issueIds.some(id => typeof id !== 'string') ||
      !raw.evaluatorBuild?.sha || !raw.evaluatorBuild.version || !Number.isSafeInteger(raw.expiresAtSec)) return null;
  try {
    const url = new URL(raw.baseUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' ||
        url.username || url.password || url.search || url.hash) return null;
    if (row.detail.label !== raw.ownerRef || !raw.ownerRef.startsWith(LABEL) ||
        raw.bundlePath !== join(raw.sourceRoot, 'apps/operator/dist-host/hono-host.mjs')) return null;
    return raw;
  } catch { return null; }
}

/** Recover the pin→ledger crash window without following the mutable alias. */
export function recoverGradingAuditRuntimeSource(
  generationsRoot: string, workspaceId: string, build: BuildInfo, nowSec: number,
): GradingAuditRuntimeLocator | null {
  const label = labelFor(build, workspaceId);
  let candidates: string[];
  try { candidates = readdirSync(generationsRoot).filter(name => name.startsWith('.candidate-')); }
  catch { return null; }
  for (const name of candidates) {
    const sourceRoot = join(generationsRoot, name, 'checkout');
    const pin = readGradingAuditSourcePin(sourceRoot, label, nowSec);
    if (!pin || !sameBuild(pin.evaluatorBuild, build)) continue;
    const locator = locatorFrom({ detail: { label, gradingAuditRuntime: pin } });
    if (locator) return locator;
  }
  return null;
}

function recoverSource(workspaceId: string, build: BuildInfo, nowSec: number): GradingAuditRuntimeLocator | null {
  const ownSource = resolve(dirname(process.argv[1] ?? process.cwd()), '../../..');
  const roots = [dirname(dirname(ownSource))];
  const legacy = process.env.PAPERCUSP_STAGING_ROOT;
  if (legacy) roots.push(`${legacy}.generations`);
  if (process.env.PAPERCUSP_INTEGRATION_ROOT) {
    roots.push(join(dirname(process.env.PAPERCUSP_INTEGRATION_ROOT), 'papercusp-staging.generations'));
  }
  for (const root of new Set(roots)) {
    const locator = recoverGradingAuditRuntimeSource(root, workspaceId, build, nowSec);
    if (locator) return locator;
  }
  return null;
}

/**
 * One build mutex serializes acquisition across dispatchers. Task detail owns the
 * endpoint, source pins bridge a dead process, and the existing sweep rehydrates.
 * A mismatch/unknown is never permission to launch on the mutable host.
 */
export async function ensureGradingAuditRuntime(input: {
  workspaceId: string; issueId: string; evaluatorBuild: BuildInfo; allowSeed?: boolean;
}, deps: GradingAuditRuntimeDeps = {}): Promise<GradingAuditRuntimeBinding> {
  const label = labelFor(input.evaluatorBuild, input.workspaceId);
  return (deps.mutex ?? mutex)(input.workspaceId, label, async () => {
    const now = Math.floor((deps.now?.() ?? Date.now()) / 1000);
    const rows = await (deps.list ?? listRuntimeTasks)(input.workspaceId, label);
    const exact = rows.filter(row => row.detail.label === label);
    if (exact.some(row => row.state === 'unaccounted')) throw new Error('Audit runtime ownership is unaccounted');
    const ordered = [...exact.filter(row => row.state === 'running' || row.state === 'pending'),
      ...exact.filter(row => row.state !== 'running' && row.state !== 'pending')];
    const existing = ordered.map(row => ({ row, locator: locatorFrom(row) }))
      .find(entry => entry.locator && entry.locator.expiresAtSec > now + 60 &&
        sameBuild(entry.locator.evaluatorBuild, input.evaluatorBuild) &&
        readGradingAuditSourcePin(entry.locator.sourceRoot, label, now));
    const recovered = existing?.locator ?? (deps.recoverSource ?? recoverSource)(input.workspaceId, input.evaluatorBuild, now);
    let locator = recovered;
    if (!locator) {
      // Never create a second endpoint while an unproven task may still serve.
      if (exact.some(row => row.state === 'running' || row.state === 'pending')) {
        throw new Error('Existing audit runtime has no valid recovery locator');
      }
      if (input.allowSeed === false) throw new Error('No retained exact audit runtime source is available');
      const source = (deps.currentSource ?? currentSource)(input.evaluatorBuild);
      locator = { ...source, ownerRef: label, issueIds: [], expiresAtSec: now + GRADING_AUDIT_SOURCE_PIN_MAX_SEC,
        baseUrl: `http://127.0.0.1:${await (deps.freePort ?? freePort)()}` };
    }
    const pin = readGradingAuditSourcePin(locator.sourceRoot, label, now);
    if (recovered && (!pin || pin.bundleSha256 !== locator.bundleSha256 ||
        !sameBuild(pin.evaluatorBuild, input.evaluatorBuild) || pin.expiresAtSec !== locator.expiresAtSec)) {
      throw new Error('Audit runtime recovery pin does not match its task locator');
    }
    if (digest(locator.bundlePath) !== locator.bundleSha256) throw new Error('Retained audit bundle digest changed');
    const liveRefs = exact.filter(row => row.state === 'pending' || row.state === 'running')
      .flatMap(row => locatorFrom(row)?.issueIds ?? []);
    const issueIds = [...new Set([...locator.issueIds, ...liveRefs, input.issueId])];
    if (issueIds.length > 200) throw new Error('Audit runtime reference budget exhausted');
    locator = { ...locator, issueIds };
    writeGradingAuditSourcePin(locator, now);
    const isLive = existing && (existing.row.state === 'running' || existing.row.state === 'pending');
    let taskId = isLive ? existing.row.taskId : '';
    for (const sibling of exact.filter(row => (row.state === 'running' || row.state === 'pending') && row.taskId !== taskId)) {
      // Preserve every old reference while converging duplicate owned endpoints.
      const previous = locatorFrom(sibling);
      if (previous && previous.baseUrl !== locator.baseUrl) {
        throw new Error('Duplicate audit runtimes have divergent endpoint ownership');
      }
      await (deps.stop ?? stopRuntime)(sibling.taskId);
    }
    const readBuild = deps.probe ?? probe;
    if (isLive && sameBuild(await readBuild(locator.baseUrl) ?? { sha: null, version: '' }, input.evaluatorBuild)) {
      await (deps.attach ?? attach)(taskId, input.workspaceId, issueIds);
    } else {
      if (isLive) await (deps.stop ?? stopRuntime)(taskId);
      taskId = await (deps.spawn ?? spawnRuntime)(input.workspaceId, locator);
      let ready = false;
      try {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const actual = await readBuild(locator.baseUrl);
          if (actual && !sameBuild(actual, input.evaluatorBuild)) throw new Error('Audit runtime evaluator identity mismatch');
          if (actual) { ready = true; break; }
          await (deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(1000);
        }
        if (!ready) throw new Error('Audit runtime readiness is unknown');
      } catch (error) {
        await (deps.stop ?? stopRuntime)(taskId);
        throw error;
      }
    }
    return { taskId, baseUrl: locator.baseUrl, evaluatorBuild: input.evaluatorBuild,
      bundleSha256: locator.bundleSha256, expiresAtSec: locator.expiresAtSec };
  });
}

/** Called by the existing audit repair sweep, never a separate monitor/routine. */
export async function retireUnusedGradingAuditRuntimes(
  workspaceId: string,
  pendingIssueIds: (ids: string[]) => Promise<string[]>,
  deps: GradingAuditRuntimeDeps = {},
): Promise<void> {
  const rows = await (deps.list ?? listRuntimeTasks)(workspaceId, LABEL);
  const labels = [...new Set(rows.map(row => row.detail.label).filter((label): label is string =>
    typeof label === 'string' && label.startsWith(LABEL)))];
  for (const label of labels) await (deps.mutex ?? mutex)(workspaceId, label, async () => {
    // Re-read under the same mutex used by acquisition; never kill from a stale ref set.
    const current = await (deps.list ?? listRuntimeTasks)(workspaceId, label);
    for (const row of current.filter(row => row.detail.label === label)) {
      const locator = locatorFrom(row);
      if (!locator) continue;
      const now = Math.floor((deps.now?.() ?? Date.now()) / 1000);
      const needed = locator.expiresAtSec > now ? await pendingIssueIds(locator.issueIds) : [];
      if (needed.length) {
        if (needed.length < locator.issueIds.length && (row.state === 'running' || row.state === 'pending')) {
          await (deps.attach ?? attach)(row.taskId, workspaceId, needed);
          writeGradingAuditSourcePin({ ...locator, issueIds: needed } as GradingAuditRuntimeLocator, now);
        }
        continue;
      }
      if (row.state === 'running' || row.state === 'pending') await (deps.stop ?? stopRuntime)(row.taskId);
      // A newer task may share the same pin. Release only after EVERY sibling is unused.
      const siblings = current.map(locatorFrom).filter((item): item is GradingAuditRuntimeLocator => item !== null);
      if ((await Promise.all(siblings.map(item => item.expiresAtSec > now
        ? pendingIssueIds(item.issueIds) : Promise.resolve([])))).every(ids => ids.length === 0)) {
        releaseGradingAuditSourcePin(locator.sourceRoot, label);
      }
    }
  });
}
