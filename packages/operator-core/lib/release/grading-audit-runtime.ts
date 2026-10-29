import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { adminUrl, appUrl } from '@papercusp/db-org/connection';
import { papercuspPath } from '@papercusp/host-platform/home';
import { getBuildInfo, type BuildInfo } from '../build-info';
import { requestOnlyIdentityGuardMarker } from '../harness/env-operator-launcher';
import { SPAWNER_SOCKET_ENV } from '../fleet/spawner-socket-path';
import { SPAWNER_SCOPE_ENV } from '../fleet/sidecar-exec-lifetime';
import { SUBSTRATE_SOCKET_ENV } from '../sync/hyperbee/substrate-socket-path';
import { acquireGradingAuditSubjectMutex } from '../scorecards';
import { killTask } from '../task-manager/control';
import { managedSpawn } from '../task-manager/managed-spawn';
import { listTasks } from '../task-manager/store';
import type { TaskRow } from '../task-manager/types';
import { runWithWorkspaceIfConcrete } from '../workspace-als';
import { measureBootOperatorArtifact, operatorArtifactSource, writeOperatorArtifactManifest } from './operator-artifact';
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
  acceptanceRefs?: string[];
  sourceRecovery?: {
    sourceSha: string;
    artifactManifestSha256: string;
    previousTaskId: string;
    previousSourceRoot: string;
    previousBundleSha256: string;
  };
}

export interface GradingAuditRuntimeBinding {
  taskId: string;
  baseUrl: string;
  evaluatorBuild: BuildInfo;
  bundleSha256: string;
  expiresAtSec: number;
  sourceRecovery?: GradingAuditRuntimeLocator['sourceRecovery'];
}

/** A maintained exact-ref rebuild is a NEW artifact, never the old digest. */
export function qualifyRematerializedGradingAuditSource(sourceRoot: string, build: BuildInfo) {
  sourceRoot = realpathSync(sourceRoot);
  if (basename(sourceRoot) !== 'checkout' || !basename(dirname(sourceRoot)).startsWith('.candidate-')) {
    throw new Error('Exact source recovery requires an immutable candidate checkout');
  }
  const sourceSha = operatorArtifactSource(sourceRoot);
  if (!build.sha || !/^[a-f0-9]{7,40}$/.test(build.sha) || !sourceSha.startsWith(build.sha)) {
    throw new Error('Rematerialized audit source differs from the recorded evaluator');
  }
  const bundlePath = join(sourceRoot, 'apps/operator/dist-host/hono-host.mjs');
  if (!readFileSync(bundlePath).includes(requestOnlyIdentityGuardMarker())) {
    throw new Error('Audit runtime bundle lacks request-only identity support');
  }
  // Require the builder's existing manifest BEFORE rechecking its compiler
  // inputs against Git objects. A directory name or caller-supplied SHA is
  // insufficient provenance, and recovery must never manufacture a manifest.
  const artifact = measureBootOperatorArtifact(bundlePath, build.sha, Date.now());
  if (artifact.status !== 'measured' || artifact.sourceSha !== sourceSha) {
    throw new Error('Rematerialized audit bundle has no exact source artifact proof');
  }
  const checked = writeOperatorArtifactManifest({ root: sourceRoot, entry: bundlePath, sourceSha });
  if (checked.status !== 'measured' || checked.manifestSha256 !== artifact.manifestSha256) {
    throw new Error('Rematerialized audit compiler provenance differs');
  }
  return { sourceSha, artifactManifestSha256: artifact.manifestSha256,
    source: { schemaVersion: 1 as const, sourceRoot, bundlePath, evaluatorBuild: build,
      bundleSha256: artifact.bundleSha256, ownerRef: '' } };
}

export interface GradingAuditRuntimeDeps {
  now?: () => number;
  list?: (workspaceId: string, label: string) => Promise<TaskRow[]>;
  mutex?: <T>(workspaceId: string, key: string, fn: () => Promise<T>) => Promise<T>;
  currentSource?: (build: BuildInfo) => Omit<GradingAuditRuntimeLocator, 'baseUrl' | 'issueIds' | 'expiresAtSec'>;
  recoverSource?: (workspaceId: string, build: BuildInfo, nowSec: number) => GradingAuditRuntimeLocator | null;
  freePort?: () => Promise<number>;
  logDir?: string;
  spawn?: (workspaceId: string, locator: GradingAuditRuntimeLocator) => Promise<string>;
  probe?: (baseUrl: string) => Promise<BuildInfo | null>;
  attach?: (taskId: string, workspaceId: string, issueIds: string[], acceptanceRefs?: string[]) => Promise<void>;
  pendingAcceptanceRefs?: (workspaceId: string, refs: string[]) => Promise<string[]>;
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
  // The parent may resolve these from its operator env file, which is absent
  // from the immutable source clone. Resolve before changing root/cwd so the
  // child cannot silently discover a different local database.
  const admin = adminUrl();
  const app = appUrl();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: admin, HARNESS_ADMIN_DATABASE_URL: admin,
    HARNESS_DATABASE_URL: app, PAPERCUSP_DATABASE_URL: admin,
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
  // These handles identify the launching host, which can exit while this
  // retained sibling is still serving. Let its sidecars resolve their own
  // owner instead of repeatedly exiting against a dead parent's socket.
  delete env[SPAWNER_SOCKET_ENV];
  delete env[SPAWNER_SCOPE_ENV];
  delete env[SUBSTRATE_SOCKET_ENV];
  return env;
}

/**
 * The confined task owns this small supervisor AND its exact-bundle child.
 * A host's intentional watchdog self-SIGKILL cannot restart a transient scope.
 * Keep the supervisor inline so recovery never loads code from a mutable alias
 * or asks an old immutable candidate to contain a newer supervisor module.
 */
export function gradingAuditRuntimeSupervisorArgs(locator: GradingAuditRuntimeLocator): string[] {
  const script = String.raw`
const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const config = JSON.parse(process.argv[1]);
let child = null, retry = null, escalation = null, stopping = false, shortExits = 0;
const log = message => console.error('[grading-audit-supervisor] ' + message);
const finish = code => {
  clearTimeout(retry); clearTimeout(escalation); clearTimeout(deadline);
  process.exit(code);
};
const stop = reason => {
  if (stopping) return;
  stopping = true;
  clearTimeout(retry);
  log('stopping: ' + reason);
  if (!child) return finish(0);
  child.kill('SIGTERM');
  escalation = setTimeout(() => { if (child) child.kill('SIGKILL'); }, 5000);
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
const deadline = setTimeout(() => stop('absolute deadline'), Math.max(0, config.expiresAtSec * 1000 - Date.now()));
const start = () => {
  if (stopping) return;
  if (Date.now() >= config.expiresAtSec * 1000) return stop('absolute deadline');
  try {
    if (createHash('sha256').update(readFileSync(config.bundlePath)).digest('hex') !== config.bundleSha256) {
      log('bundle digest changed; refusing launch'); return finish(1);
    }
  } catch (error) { log('bundle read failed: ' + error.message); return finish(1); }
  const started = Date.now();
  child = spawn(process.execPath, [config.bundlePath], { stdio: 'inherit' });
  log('started child pid=' + child.pid);
  child.once('error', error => { log('child spawn failed: ' + error.message); finish(1); });
  child.once('exit', (code, signal) => {
    child = null;
    if (stopping) return finish(0);
    if (Date.now() >= config.expiresAtSec * 1000) return stop('absolute deadline');
    shortExits = Date.now() - started < 30000 ? shortExits + 1 : 0;
    log('child exited code=' + code + ' signal=' + signal + ' shortExits=' + shortExits);
    if (shortExits >= 5) { log('restart budget exhausted'); return finish(1); }
    retry = setTimeout(start, Math.min(5000, 100 * 2 ** shortExits));
  });
};
start();
`;
  return ['--eval', script, JSON.stringify({ bundlePath: locator.bundlePath,
    bundleSha256: locator.bundleSha256, expiresAtSec: locator.expiresAtSec })];
}

async function spawnRuntime(workspaceId: string, locator: GradingAuditRuntimeLocator,
  logDir = papercuspPath('checkpoint-logs')): Promise<string> {
  // The task ledger owns this durable log; a candidate generation may be pruned while its row remains.
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logName = createHash('sha256').update(locator.ownerRef).digest('hex');
  const logPath = join(logDir, `grading-audit-runtime-${logName}.log`);
  const fd = openSync(logPath, 'a', 0o600);
  try {
    const args = gradingAuditRuntimeSupervisorArgs(locator);
    const spawned = await managedSpawn(process.execPath, args, {
      class: 'sidecar', title: locator.ownerRef, argv: [process.execPath, ...args],
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

async function attach(taskId: string, workspaceId: string, issueIds: string[], acceptanceRefs: string[] = []): Promise<void> {
  const { sql } = getOrgPg();
  const rows = await sql`UPDATE harness_shared.task_ledger
    SET detail = jsonb_set(jsonb_set(detail, '{gradingAuditRuntime,issueIds}', ${sql.json(issueIds)}),
      '{gradingAuditRuntime,acceptanceRefs}', ${sql.json(acceptanceRefs)})
    WHERE task_id = ${taskId} AND workspace_id = ${workspaceId} AND state IN ('pending','running')
    RETURNING task_id`;
  if (!rows.length) throw new Error('Audit runtime ownership changed before attachment');
}

async function pendingAcceptanceRefs(workspaceId: string, refs: string[]): Promise<string[]> {
  if (!refs.length) return [];
  const { getWorkItemsByIds, TERMINAL_WORK_ITEM_STATES } = await import('../work-items');
  const items = await runWithWorkspaceIfConcrete(workspaceId, () => getWorkItemsByIds(refs));
  // Missing/ambiguous reads are unknown, so the hard deadline remains the backstop.
  if (items.length !== refs.length) return refs;
  return items.filter(item => item.assignee && !TERMINAL_WORK_ITEM_STATES.includes(item.state)).map(item => item.id);
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
      (raw.acceptanceRefs !== undefined && (!Array.isArray(raw.acceptanceRefs) || raw.acceptanceRefs.some(id => typeof id !== 'string'))) ||
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
  /** Explicit recovery after exact-ref materialization with the maintained builder. */
  recoverySourceRoot?: string;
  /** A claimed source work-item may still need conformance after its audit settles. */
  acceptanceRef?: string;
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
      const previous = ordered.map(row => ({ row, locator: locatorFrom(row) }))
        .find(entry => entry.locator && sameBuild(entry.locator.evaluatorBuild, input.evaluatorBuild));
      if (input.recoverySourceRoot && !previous?.locator) {
        throw new Error('Exact source recovery requires a registered prior runtime locator');
      }
      if (!input.recoverySourceRoot && input.allowSeed === false) throw new Error('No retained exact audit runtime source is available');
      const rebuilt = input.recoverySourceRoot
        ? qualifyRematerializedGradingAuditSource(input.recoverySourceRoot, input.evaluatorBuild) : null;
      const source = rebuilt?.source ?? (deps.currentSource ?? currentSource)(input.evaluatorBuild);
      locator = { ...source, ownerRef: label, issueIds: previous?.locator?.issueIds ?? [],
        ...(rebuilt && previous?.locator ? { sourceRecovery: {
          sourceSha: rebuilt.sourceSha, artifactManifestSha256: rebuilt.artifactManifestSha256,
          previousTaskId: previous.row.taskId, previousSourceRoot: previous.locator.sourceRoot,
          previousBundleSha256: previous.locator.bundleSha256,
        } } : {}), expiresAtSec: now + GRADING_AUDIT_SOURCE_PIN_MAX_SEC,
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
    const acceptanceRefs = [...new Set([...(locator.acceptanceRefs ?? []), ...exact.flatMap(row =>
      locatorFrom(row)?.acceptanceRefs ?? []), ...(input.acceptanceRef ? [input.acceptanceRef] : [])])];
    if (issueIds.length + acceptanceRefs.length > 200) throw new Error('Audit runtime reference budget exhausted');
    locator = { ...locator, issueIds, acceptanceRefs };
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
    const liveBuild = isLive ? await readBuild(locator.baseUrl) : null;
    if (isLive && !liveBuild) {
      // HTTP readiness is not process-lifetime evidence. Preserve the enrolled
      // task and every audit reference so the existing repair sweep can reuse
      // it after startup or a missed probe, rather than restarting its warmup.
      await (deps.attach ?? attach)(taskId, input.workspaceId, issueIds, acceptanceRefs);
      throw new Error('Audit runtime readiness is unknown');
    }
    if (isLive && sameBuild(liveBuild!, input.evaluatorBuild)) {
      await (deps.attach ?? attach)(taskId, input.workspaceId, issueIds, acceptanceRefs);
    } else {
      if (isLive) await (deps.stop ?? stopRuntime)(taskId);
      taskId = await (deps.spawn ?? ((workspaceId, current) => spawnRuntime(workspaceId, current, deps.logDir)))(
        input.workspaceId, locator);
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const actual = await readBuild(locator.baseUrl);
        if (actual && !sameBuild(actual, input.evaluatorBuild)) {
          await (deps.stop ?? stopRuntime)(taskId);
          throw new Error('Audit runtime evaluator identity mismatch');
        }
        if (actual) { ready = true; break; }
        await (deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(1000);
      }
      // Keep an unready task under its existing confined deadline. Its locator
      // and pin let the next canonical repair retry the same exact evaluator;
      // expiry and authoritative task termination still govern replacement.
      if (!ready) throw new Error('Audit runtime readiness is unknown');
    }
    return { taskId, baseUrl: locator.baseUrl, evaluatorBuild: input.evaluatorBuild,
      bundleSha256: locator.bundleSha256, expiresAtSec: locator.expiresAtSec,
      ...(locator.sourceRecovery ? { sourceRecovery: locator.sourceRecovery } : {}) };
  });
}

/** Called by the existing audit repair sweep, never a separate monitor/routine. */
export async function retireUnusedGradingAuditRuntimes(
  workspaceId: string,
  pendingIssueIds: (ids: string[]) => Promise<string[]>,
  deps: GradingAuditRuntimeDeps = {},
  targetIssueIds?: readonly string[],
): Promise<void> {
  const rows = await (deps.list ?? listRuntimeTasks)(workspaceId, LABEL);
  // A targeted repair must not wait for another build's cleanup mutex. Select
  // labels by the requested refs, then keep the full sibling reread below so a
  // shared endpoint or pin cannot be retired while another audit still needs it.
  const targets = targetIssueIds?.length ? new Set(targetIssueIds) : undefined;
  const scopedRows = targets
    ? rows.filter(row => { const locator = locatorFrom(row);
      return [...(locator?.issueIds ?? []), ...(locator?.acceptanceRefs ?? [])].some(id => targets.has(id)); })
    : rows;
  const labels = [...new Set(scopedRows.map(row => row.detail.label).filter((label): label is string =>
    typeof label === 'string' && label.startsWith(LABEL)))];
  for (const label of labels) await (deps.mutex ?? mutex)(workspaceId, label, async () => {
    // Re-read under the same mutex used by acquisition; never kill from a stale ref set.
    const current = await (deps.list ?? listRuntimeTasks)(workspaceId, label);
    for (const row of current.filter(row => row.detail.label === label)) {
      const locator = locatorFrom(row);
      if (!locator) continue;
      const now = Math.floor((deps.now?.() ?? Date.now()) / 1000);
      const needed = locator.expiresAtSec > now ? await pendingIssueIds(locator.issueIds) : [];
      const acceptance = locator.expiresAtSec > now
        ? await (deps.pendingAcceptanceRefs ?? pendingAcceptanceRefs)(workspaceId, locator.acceptanceRefs ?? []) : [];
      if (needed.length || acceptance.length) {
        if ((needed.length < locator.issueIds.length || acceptance.length < (locator.acceptanceRefs?.length ?? 0)) &&
            (row.state === 'running' || row.state === 'pending')) {
          await (deps.attach ?? attach)(row.taskId, workspaceId, needed, acceptance);
          writeGradingAuditSourcePin({ ...locator, issueIds: needed, acceptanceRefs: acceptance } as GradingAuditRuntimeLocator, now);
        }
        continue;
      }
      if (row.state === 'running' || row.state === 'pending') await (deps.stop ?? stopRuntime)(row.taskId);
      // A newer task may share the same pin. Release only after EVERY sibling is unused.
      const siblings = current.map(locatorFrom).filter((item): item is GradingAuditRuntimeLocator => item !== null);
      if ((await Promise.all(siblings.map(async item => item.expiresAtSec > now
        ? [...await pendingIssueIds(item.issueIds),
          ...await (deps.pendingAcceptanceRefs ?? pendingAcceptanceRefs)(workspaceId, item.acceptanceRefs ?? [])] : [])))
        .every(ids => ids.length === 0)) {
        releaseGradingAuditSourcePin(locator.sourceRoot, label);
      }
    }
  });
}
