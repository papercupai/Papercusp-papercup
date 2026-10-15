/** P-011 live baseline. Reuses the maintained counter reader; no profiler or GC.
 * This observes the staging service's main process and ambient workload, not a
 * paired intervention or a census of every HTTP worker/retained-memory owner.
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { closeInspector, createCdpClient, readPinnedState, readProcessMemory, validatePinnedStateOptions } from '../../../scripts/cdp-inspector.mjs';
import { serializeIdentitySafeJson } from '../../../scripts/lib/identity-leak-patterns.mjs';
import { requestOnlyHost } from './background-workers';
import { SpawnerIpcClient } from './fleet/spawner-ipc-client';
import { pgDiagnosticIdentity, recordPgResult, setBuildStampResolver } from '@papercusp/db-org';

const root = resolve(__dirname, '../../..');
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const executableHashes = new Map<string, string>();
type WorkloadRequestDiagnostic = {
  window: number;
  pair: number;
  index: number;
  status: number;
  rows?: number;
  requestId: string | null;
  responseBytes: number;
  responseSha256: string;
  elapsedMs: number;
};
async function captureWorkloadRequestPair({
  report, window, pair, fetchRequest, publish, observe,
}: {
  report: { requests: WorkloadRequestDiagnostic[] };
  window: number;
  pair: number;
  fetchRequest: (index: number) => Promise<Response>;
  publish: () => void;
  observe?: (requestIds: string[]) => Promise<void>;
}): Promise<string[]> {
  const captured = await Promise.all([0, 1].map(async index => {
    const started = performance.now();
    const response = await fetchRequest(index);
    const bytes = Buffer.from(await response.arrayBuffer());
    const request: WorkloadRequestDiagnostic = {
      window, pair, index, status: response.status,
      requestId: response.headers.get('x-papercusp-request-id'),
      responseBytes: bytes.length, responseSha256: hash(bytes),
      elapsedMs: performance.now() - started,
    };
    return { response, bytes, request };
  }));

  // Persist both responses and expose their IDs to the frozen reader before
  // validating either status. A 500 must remain diagnosable in the partial
  // report instead of escaping before its final-window query ID is recorded.
  report.requests.push(...captured.map(row => row.request));
  publish();
  const requestIds = captured.map(row => row.request.requestId)
    .filter((id): id is string => typeof id === 'string');
  if (observe) await observe(requestIds);

  for (const row of captured) {
    expect(row.response.status,
      'workItems.byHarness request ' + (row.request.requestId ?? 'missing request id') +
      ' elapsedMs=' + Math.round(row.request.elapsedMs)).toBe(200);
    const body = JSON.parse(row.bytes.toString());
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows.length).toBeLessThanOrEqual(32);
    row.request.rows = body.rows.length;
  }
  publish();
  return requestIds;
}
type PinnedLimits = Omit<Parameters<typeof readPinnedState>[1], 'expectedPid' | 'owners' | 'operatorCacheEntries'>;
function parsePinnedLimits(raw?: string): PinnedLimits | undefined {
  if (!raw) return undefined;
  const value = JSON.parse(raw);
  const allowed = ['maxSlots', 'maxObjects', 'maxEntries', 'maxFields', 'maxDepth', 'budgetMs',
    'maxCacheEntries', 'maxEntryEntries', 'maxEntryObjects', 'maxKeyCodeUnits', 'cacheEntryOffset', 'cacheKeyDigests'];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key) ||
        (key === 'cacheKeyDigests' ? !Array.isArray(value[key]) || value[key].length < 1 ||
          value[key].some((digest: unknown) => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) :
          !Number.isInteger(value[key]) || value[key] < (key === 'cacheEntryOffset' ? 0 : 1)))) {
    throw Error('Pinned limits must contain only positive integer reader limits');
  }
  // Reuse the reader's exact bounds before acquiring/opening a target inspector.
  // Selection is structurally checked here; the caller's actual opt-in is checked
  // with the full options below before any process observation.
  validatePinnedStateOptions({ ...value, expectedPid: 1, operatorCacheEntries: true });
  return value;
}
function processSample(pid: number) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
  const bytes = (name: string) => {
    const match = rollup.match(new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm'));
    if (!match) throw Error(`Missing ${name} for ${pid}`);
    return Number(match[1]) * 1024;
  };
  const executable = readlinkSync(`/proc/${pid}/exe`);
  const metadata = statSync(`/proc/${pid}/exe`);
  const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  const command = processCommand(argv, readlinkSync(`/proc/${pid}/cwd`), executable);
  const key = `${executable}:${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
  if (!executableHashes.has(key)) executableHashes.set(key, hash(readFileSync(`/proc/${pid}/exe`)));
  const afterStat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const after = afterStat.slice(afterStat.lastIndexOf(')') + 2).split(' ');
  const afterExe = statSync(`/proc/${pid}/exe`);
  if (after[19] !== fields[19] || after[1] !== fields[1] ||
      afterExe.dev !== metadata.dev || afterExe.ino !== metadata.ino) {
    throw Error('Process changed during resource sample');
  }
  return { pid, startTicks: fields[19], parentPid: Number(fields[1]), executable,
    executableSha256: executableHashes.get(key)!,
    command,
    pssBytes: bytes('Pss'), rssBytes: bytes('Rss'), anonymousBytes: bytes('Anonymous') };
}

// Parse only the executable entry, not an argument which happens to name the
// host. Unknown option forms fail closed. Never persist arbitrary argv/env.
function nodeEntry(argv: string[], cwd: string): string | null {
  const takesValue = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader',
    '--conditions', '--title', '--inspect-port']);
  const switches = /^(?:--inspect(?:-brk)?(?:=.*)?|--enable-source-maps|--no-warnings|--expose-gc|--max-old-space-size=\d+)$/;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') return argv[i + 1] ? resolve(cwd, argv[i + 1]) : null;
    if (takesValue.has(arg)) { if (!argv[++i]) return null; continue; }
    if (switches.test(arg) || /^(?:--require|--import|--loader|--conditions|--title|--inspect-port)=/.test(arg)) continue;
    if (arg.startsWith('-')) return null;
    return resolve(cwd, arg);
  }
  return null;
}

function processCommand(argv: string[], cwd: string, executable: string) {
  return { sha256: hash(argv.join('\0')), script: nodeEntry(argv, cwd),
    esbuildService: executable.endsWith('/esbuild') &&
      argv.slice(1).some(arg => /^--service=\d+\.\d+\.\d+$/.test(arg)) };
}

type ResourceRow = ReturnType<typeof processSample>;
function descendantEntryRole(main: ResourceRow, row: ResourceRow) {
  const entry = main.command.script;
  if (!entry?.endsWith('/hono-host.mjs') || row.executableSha256 !== main.executableSha256) return 'other-descendant';
  if (row.command.script === entry) return 'same-entry-operator-descendant';
  // The production resolver opts only the spawner into this exact sibling.
  // A similarly named file elsewhere is not an identified serving artifact.
  if (row.command.script === join(dirname(entry), 'spawner-sidecar.mjs')) return 'maintained-spawner-descendant';
  return 'other-descendant';
}

function processInventory(main: ResourceRow, children: ResourceRow[],
  missed: { pid: number; parentPid: number; reason: string }[], previous: ResourceRow[] = []) {
  const rows = [main, ...children];
  const byPid = new Map(rows.map(row => [row.pid, row]));
  if (byPid.size !== rows.length) throw Error('Duplicate process identity in census');
  for (const child of children) {
    const seen = new Set([child.pid]);
    let parent = child.parentPid;
    while (parent !== main.pid) {
      if (seen.has(parent) || !byPid.has(parent)) throw Error('Unverified descendant ancestry');
      seen.add(parent); parent = byPid.get(parent)!.parentPid;
    }
  }
  const identities = new Set(rows.map(row => `${row.pid}:${row.startTicks}:${row.executableSha256}`));
  const priorIdentities = new Set(previous.map(row => `${row.pid}:${row.startTicks}:${row.executableSha256}`));
  const classified = rows.map(row => ({ pid: row.pid, startTicks: row.startTicks,
    executableSha256: row.executableSha256,
    role: row.pid === main.pid ? 'named-main' : row.command.esbuildService ? 'native-esbuild-service' :
      descendantEntryRole(main, row),
    pssBytes: row.pssBytes }));
  return { observed: classified, notChecked: missed,
    censusComplete: missed.length === 0,
    observedPssBytes: rows.reduce((sum, row) => sum + row.pssBytes, 0),
    appeared: rows.filter(row => !priorIdentities.has(`${row.pid}:${row.startTicks}:${row.executableSha256}`))
      .map(row => ({ pid: row.pid, startTicks: row.startTicks })),
    notObservedSincePrevious: previous.filter(row => !identities.has(`${row.pid}:${row.startTicks}:${row.executableSha256}`))
      .map(row => ({ pid: row.pid, startTicks: row.startTicks })),
    definition: 'Serial PSS observations of the named process and bounded descendant tree; not cgroup memory or an atomic service total.',
    allocationOwner: 'unknown',
    compilerCaller: 'unknown',
    workerRequestAssignment: 'unknown',
    lifetimeDefinition: 'Not observed is not proof of exit. Roles identify executable/entry only, not retained allocation owners or HTTP routing.' };
}

function assertIdentity(before: { pid: number; startTicks: string; executableSha256: string }, after: typeof before) {
  if (before.pid !== after.pid || before.startTicks !== after.startTicks ||
      before.executableSha256 !== after.executableSha256) throw Error('Serving process identity changed');
}

function counterTarget(main: ResourceRow, rows: ResourceRow[], pid: number) {
  const inventory = processInventory(main, rows, []);
  const target = pid === main.pid ? main : rows.find(row => row.pid === pid);
  const role = inventory.observed.find(row => row.pid === pid)?.role;
  if (!target || (pid !== main.pid && role !== 'same-entry-operator-descendant' &&
      role !== 'maintained-spawner-descendant')) throw Error('Counter target must be the main or exact maintained descendant');
  return target;
}

function assertCounterRole(main: ResourceRow, target: ResourceRow, facts: any) {
  const role = configuredHostRole(facts);
  if (target.pid !== main.pid && descendantEntryRole(main, target) === 'maintained-spawner-descendant' &&
      role.configuredSidecar !== 'spawner') throw Error('Maintained spawner entry did not report the configured spawner role');
  return role;
}

function spawnerLoadedIdentity(pid: number, capability: any) {
  const identity = capability?.processExecIdentity;
  if (identity == null) return { status: 'unknown', reason: 'Loaded server does not advertise build identity' };
  if (identity.pid !== pid) throw Error('Spawner build identity PID mismatch');
  const build = identity.buildInfo;
  const fence = capability.processExecFence;
  if (!build || !(build.sha === null || (typeof build.sha === 'string' && build.sha.trim())) ||
      typeof build.version !== 'string' || !build.version.trim() ||
      typeof fence?.serverGeneration !== 'string' || !fence.serverGeneration ||
      typeof fence.connectionId !== 'string' || !fence.connectionId) {
    throw Error('Malformed advertised spawner build identity');
  }
  return { status: build.sha === null ? 'unknown' : 'known',
    reason: build.sha === null ? 'Loaded bundle has no source identity' : null,
    source: 'Loaded server cancellation capability', pid, buildInfo: build,
    serverGeneration: fence.serverGeneration, connectionId: fence.connectionId };
}

function assertSpawnerIdentity(before: any, after: any) {
  if (before.status !== after.status || before.pid !== after.pid ||
      JSON.stringify(before.buildInfo) !== JSON.stringify(after.buildInfo) ||
      before.serverGeneration !== after.serverGeneration || before.connectionId !== after.connectionId) {
    throw Error('Loaded spawner identity or socket generation changed');
  }
}

function configuredHostRole(facts: any) {
  if (!facts || typeof facts.cluster?.isPrimary !== 'boolean' ||
      typeof facts.cluster?.isWorker !== 'boolean' || facts.cluster.isPrimary === facts.cluster.isWorker ||
      !['unset', 'disabled', 'enabled'].includes(facts.backgroundWorkersOverride) ||
      typeof facts.stagingPort !== 'boolean' ||
      ['substrate', 'spawner', 'gateway', 'embed', 'resourceHealth'].some(key => typeof facts.sidecarFlags?.[key] !== 'boolean')) {
    throw Error('Incomplete host configuration facts');
  }
  const requestOnly = requestOnlyHost({
    PAPERCUSP_BACKGROUND_WORKERS: facts.backgroundWorkersOverride === 'unset' ? undefined :
      facts.backgroundWorkersOverride === 'disabled' ? '0' : '1',
    PAPERCUSP_HONO_PORT: facts.stagingPort ? '3170' : undefined,
  });
  // Priority is the observed hono-host entry's boot divert, not inferred from
  // argv, port inheritance or the presence of another host in its ancestry.
  const sidecar = ['substrate', 'spawner', 'gateway', 'embed', 'resourceHealth']
    .find(key => facts.sidecarFlags[key]);
  return { clusterRole: facts.cluster.isWorker ? 'worker' : 'primary',
    requestOnly, configuredSidecar: sidecar ?? null,
    requestAssignment: 'unknown', allocationOwner: 'unknown' };
}

function parseDiscoveryNamespace(raw?: string, limits?: PinnedLimits): string | undefined {
  if (raw === undefined) return undefined;
  if (raw.length > 120 || raw.startsWith('jev-memory:') || !/^[a-z][a-z0-9_.-]*:[a-z][a-z0-9_.-]*$/.test(raw) ||
      limits?.cacheKeyDigests !== undefined || (limits?.cacheEntryOffset ?? 0) !== 0) {
    throw Error('Cache discovery requires one exact tool namespace and no prior selection');
  }
  return raw;
}

function selectDiscoveredDigests(pages: any[], namespace: string): string[] {
  if (pages.length < 1 || pages.length > 2 || pages.some(page => page.status !== 'map' ||
      page.selection.selectedNotChecked !== 0 || page.undigestibleKeys !== 0) ||
      pages.at(-1).selection.nextOffset !== null) throw Error('Incomplete bounded cache discovery');
  const candidates = new Map<string, number>();
  for (const page of pages) for (const value of page.values) {
    if (value.toolNamespace !== namespace) continue;
    if (!/^[a-f0-9]{64}$/.test(value.keyDigest)) throw Error('Undigestible cache discovery candidate');
    candidates.set(value.keyDigest, Math.max(candidates.get(value.keyDigest) ?? 0, value.stringCodeUnits));
  }
  // This ranks visited logical strings, including partially traversed values.
  // It neither ranks physical memory nor proves a single atomic cache census.
  const selected = [...candidates].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(([key]) => key);
  if (selected.length === 0) throw Error('No matching current cache discovery values');
  return selected;
}

function assertCacheSelection(cache: any, digests: string[]) {
  if (cache.status !== 'map' || cache.checked !== digests.length ||
      cache.selection.selectedNotChecked !== 0 || cache.selection.unresolvedKeyDigests.length !== 0 ||
      new Set(cache.values.map((value: any) => value.keyDigest)).size !== digests.length ||
      cache.values.some((value: any) => !digests.includes(value.keyDigest))) {
    throw Error('Current cache digest selection did not match exactly');
  }
}

// Closed over no observer state: execute the same metadata-only reader in the
// selected target. Never dereference diagnostic WeakRefs or copy query bodies.
function requestWorkerSnapshot(requestIds: string[]) {
  const slots = (globalThis as any)[Symbol.for('@papercusp/module-singleton.slots')];
  const registry = slots?.get('@papercusp/db-org.acquire-registry')?.value;
  const processInstanceId = slots?.get('@papercusp/db-org.diagnostic-identity')?.value;
  const resolver = slots?.get('@papercusp/db-org.build-stamp')?.value?.resolver;
  const buildSha = typeof resolver === 'function' ? resolver() : null;
  if (!(registry?.pools instanceof Map) || typeof processInstanceId !== 'string' ||
      typeof buildSha !== 'string' || !/^[a-f0-9]{7,64}$/i.test(buildSha)) {
    return { status: 'unknown' as const, pid: process.pid, reason: 'Loaded diagnostic identity, registry or build unavailable',
      processInstanceId: undefined, buildSha: undefined, results: undefined, pools: undefined };
  }
  if (registry.pools.size > 64) throw Error('Request-worker pool observation cap');
  const results: any[] = [];
  const pools: { pool: string; capacity: number; retained: number; totalRecorded: number; dropped: number }[] = [];
  for (const [pool, state] of registry.pools) {
    const rows = state.pgResults ?? [];
    if (!Array.isArray(rows) || rows.length > 32) throw Error('Request-worker diagnostic ring cap');
    const totalRecorded = state.totalPgResults ?? 0;
    if (!Number.isSafeInteger(totalRecorded) || totalRecorded < rows.length)
      throw Error('Request-worker diagnostic ring accounting');
    pools.push({ pool, capacity: 32, retained: rows.length, totalRecorded,
      dropped: totalRecorded - rows.length });
    for (const row of rows) {
      if (row.correlationState !== 'linked' || row.correlation?.operation !== 'workItems.byHarness' ||
          !requestIds.includes(row.correlation.requestId)) continue;
      results.push({ pool, source: { processInstanceId: row.source.processInstanceId,
        buildSha: row.source.buildSha, poolInstanceId: row.source.poolInstanceId },
      connectionId: row.connectionId, queryId: row.queryId, queryFamily: row.queryFamily,
      elapsedMs: row.elapsedMs, preBuildMs: row.preBuildMs, status: row.status, errorCode: row.errorCode,
      correlation: { processInstanceId: row.correlation.processInstanceId,
        buildSha: row.correlation.buildSha, requestId: row.correlation.requestId,
        operation: row.correlation.operation } });
      if (results.length > 64) throw Error('Request-worker selected relation cap');
    }
  }
  return { status: 'observed' as const, pid: process.pid, processInstanceId, buildSha, results,
    ...({ pools } as { pools?: typeof pools }) };
}

// The inspector PID and OS lifetime fence join the writer's pinned process UUID
// to the server-created HTTP UUID. Missing bounded-ring rows remain unknown.
function auditRequestWorkerAssignments(requestIds: (string | null)[], observations: {
  before: ResourceRow; after: ResourceRow; role: ReturnType<typeof configuredHostRole>;
  snapshot: ReturnType<typeof requestWorkerSnapshot>;
}[], expectedBuild: string) {
  const uuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
  if (!requestIds.length || requestIds.length > 32)
    throw Error('Request-worker request population');
  if (requestIds.some(id => !uuid(id))) return { status: 'unknown', reason: 'Server HTTP request identity unavailable',
    requested: requestIds.length, assignments: [], unresolvedRequestIds: requestIds };
  if (new Set(requestIds).size !== requestIds.length) throw Error('Request-worker duplicate HTTP identity');
  const matched = new Map<string, { pid: number; startTicks: string; processInstanceId: string;
    queryTuples: string[]; querySamples: Array<{ pool: string; poolInstanceId: string; connectionId: number;
      queryId: number; queryFamily: string; elapsedMs: number | null; preBuildMs: number | null;
      status: 'ok' | 'error'; errorCode: string | null }> }>();
  const processes = new Set<string>();
  const pids = new Set<number>();
  for (const observation of observations) {
    const { before, after, role, snapshot } = observation;
    assertIdentity(before, after);
    if (snapshot.pid !== before.pid || pids.has(before.pid)) throw Error('Request-worker inspector PID or duplicate observation');
    pids.add(before.pid);
    if (role.configuredSidecar !== null || !role.requestOnly) throw Error('Request-worker serving role');
    if (snapshot.status === 'unknown') continue;
    if (!uuid(snapshot.processInstanceId) || processes.has(snapshot.processInstanceId) ||
        snapshot.buildSha !== expectedBuild) throw Error('Request-worker loaded process/build identity');
    processes.add(snapshot.processInstanceId);
    const tuples = new Set<string>();
    for (const row of snapshot.results) {
      if (!requestIds.includes(row.correlation.requestId) || row.correlation.operation !== 'workItems.byHarness' ||
          row.source.processInstanceId !== snapshot.processInstanceId ||
          row.correlation.processInstanceId !== snapshot.processInstanceId ||
          row.source.buildSha !== expectedBuild || row.correlation.buildSha !== expectedBuild ||
          !uuid(row.source.poolInstanceId) || typeof row.pool !== 'string' || !row.pool ||
          (row.status !== 'ok' && row.status !== 'error') ||
          !Number.isSafeInteger(row.connectionId) || row.connectionId < 0 ||
          !Number.isSafeInteger(row.queryId) || row.queryId < 0 || typeof row.queryFamily !== 'string' ||
          !row.queryFamily || (row.elapsedMs !== null && (!Number.isFinite(row.elapsedMs) || row.elapsedMs < 0)) ||
          (row.preBuildMs !== null && (!Number.isFinite(row.preBuildMs) || row.preBuildMs < 0)) ||
          (row.errorCode !== null && typeof row.errorCode !== 'string')) throw Error('Request-worker query identity');
      const tuple = JSON.stringify([row.correlation.requestId, row.pool, row.source.processInstanceId,
        row.source.buildSha, row.source.poolInstanceId, row.connectionId, row.queryId]);
      if (tuples.has(tuple)) throw Error('Request-worker duplicate query tuple');
      tuples.add(tuple);
      const prior = matched.get(row.correlation.requestId);
      if (prior && prior.processInstanceId !== snapshot.processInstanceId) throw Error('Request-worker cross-process assignment');
      const assignment = prior ?? { pid: before.pid, startTicks: before.startTicks,
        processInstanceId: snapshot.processInstanceId, queryTuples: [], querySamples: [] };
      assignment.queryTuples.push(tuple);
      assignment.querySamples.push({ pool: row.pool, poolInstanceId: row.source.poolInstanceId,
        connectionId: row.connectionId, queryId: row.queryId, queryFamily: row.queryFamily,
        elapsedMs: row.elapsedMs, preBuildMs: row.preBuildMs, status: row.status, errorCode: row.errorCode });
      matched.set(row.correlation.requestId, assignment);
    }
  }
  const unresolvedRequestIds = requestIds.filter(id => !matched.has(id!));
  return { status: unresolvedRequestIds.length ? 'partial' : 'observed', requested: requestIds.length,
    assignments: requestIds.flatMap(requestId => matched.has(requestId!) ? [{ requestId, ...matched.get(requestId!)! }] : []),
    unresolvedRequestIds,
    definition: 'Exact HTTP/query/process joins within observed terminal rings; missing rows do not identify another worker.',
    queryRelationCoverage: 'Bounded terminal records, not a complete query census or retained/native ownership proof' };
}

type WorkerCensus = { main: ResourceRow; descendants: ResourceRow[];
  notChecked: { pid: number; parentPid: number; reason: string }[] };
type WorkerWindowReader = {
  census: () => WorkerCensus;
  record?: (stage: string, value: unknown) => void;
  read: (pid: number, requestIds: string[]) => Promise<{
    counters: Awaited<ReturnType<typeof readProcessMemory>>;
    snapshot: ReturnType<typeof requestWorkerSnapshot>;
  }>;
};

async function readRequestWorkerResources(client: Pick<ReturnType<typeof createCdpClient>, 'evaluate'>,
  pid: number, requestIds: string[]) {
  const counters = await readProcessMemory(client, { expectedPid: pid, hostFacts: true, allocationDetails: true });
  const result = await client.evaluate('(' + requestWorkerSnapshot.toString() + ')(' +
    JSON.stringify(requestIds) + ')', { returnByValue: true });
  if (!result?.result?.value) throw Error('Request-worker inspector snapshot unavailable');
  return { counters, snapshot: result.result.value as ReturnType<typeof requestWorkerSnapshot> };
}

// The same bounded reader can bracket several selected workers. Inspector
// ownership stays with the caller; this collector never opens a profiler,
// forces GC, changes a worker count, or infers an unsampled worker's resources.
async function collectRequestWorkerWindow(targets: ResourceRow[], expectedBuild: string,
  reader: WorkerWindowReader, workload: (observe: (ids: string[]) => Promise<void>) => Promise<(string | null)[]>) {
  if (!targets.length || targets.length > 8 || new Set(targets.map(row => row.pid)).size !== targets.length ||
      targets.some(row => !Number.isSafeInteger(row.pid) || row.pid <= 0) ||
      !/^[a-f0-9]{7,64}$/i.test(expectedBuild)) throw Error('Worker-window target selection');
  const savedCensus = () => {
    const census = structuredClone(reader.census());
    if (census.descendants.length > 64) throw Error('Worker-window bounded census cap');
    processInventory(census.main, census.descendants, census.notChecked);
    return census;
  };
  const initial = savedCensus();
  const stablePath = (census: WorkerCensus, target: ResourceRow) => {
    assertIdentity(initial.main, census.main);
    let row = counterTarget(census.main, census.descendants, target.pid);
    assertIdentity(target, row);
    if (target.parentPid !== row.parentPid || target.command.sha256 !== row.command.sha256 ||
        target.command.script !== row.command.script) throw Error('Worker-window selected ancestry pin changed');
    while (true) {
      const prior = [initial.main, ...initial.descendants].find(value => value.pid === row.pid);
      if (!prior) throw Error('Worker-window ancestry unavailable');
      assertIdentity(prior, row);
      if (prior.parentPid !== row.parentPid || prior.command.sha256 !== row.command.sha256 ||
          prior.command.script !== row.command.script) throw Error('Worker-window ancestry changed');
      if (row.pid === census.main.pid) break;
      row = census.descendants.find(value => value.pid === row.parentPid) ?? census.main;
    }
    return counterTarget(census.main, census.descendants, target.pid);
  };
  // Reject a foreign/reused selection before reading any target or workload.
  for (const target of targets) stablePath(initial, target);
  const lastAllocations = new Map<number, number>();
  const sample = async (requestIds: string[]) => {
    const startedAt = Date.now();
    const before = savedCensus();
    for (const target of targets) stablePath(before, target);
    const readings = [];
    for (const target of targets) {
      const value = await reader.read(target.pid, requestIds);
      const role = configuredHostRole(value.counters.hostFacts);
      if (value.counters.pid !== target.pid || value.snapshot.pid !== target.pid ||
          value.snapshot.status !== 'observed' || value.snapshot.buildSha !== expectedBuild ||
          !/^[a-f0-9-]{36}$/i.test(value.snapshot.processInstanceId) ||
          role.configuredSidecar !== null || !role.requestOnly) throw Error('Worker-window loaded target identity or role');
      if (!Number.isFinite(value.counters.heap?.total_allocated_bytes) ||
          value.counters.heap.total_allocated_bytes < (lastAllocations.get(target.pid) ?? 0))
        throw Error('Worker-window cumulative allocation unavailable or regressed');
      lastAllocations.set(target.pid, value.counters.heap.total_allocated_bytes);
      readings.push({ ...value, role, before: stablePath(before, target) });
    }
    const after = savedCensus();
    const observations = readings.map((value, index) => {
      const os = stablePath(after, targets[index]);
      if (!Number.isFinite(os.pssBytes) || os.pssBytes <= 0 ||
          !Number.isFinite(value.before.pssBytes) || value.before.pssBytes <= 0) throw Error('Worker-window PSS unavailable');
      return { ...value, after: os };
    });
    if (new Set(observations.map(row => row.snapshot.processInstanceId)).size !== observations.length)
      throw Error('Worker-window duplicate process instance');
    const selected = new Set(targets.map(row => row.pid));
    return { startedAt, endedAt: Date.now(), observations,
      census: { before, after },
      coverage: { selectedPids: targets.map(row => row.pid),
        unsampledPids: [after.main, ...after.descendants].filter(row => !selected.has(row.pid)).map(row => row.pid),
        notCheckedBefore: before.notChecked, notCheckedAfter: after.notChecked,
        population: 'Selected PID lifetime fences within a bounded descendant census; serving-worker population remains unknown' } };
  };
  const before = await sample([]);
  reader.record?.('before', structuredClone(before));
  const during: (Awaited<ReturnType<typeof sample>> & { requestIds: string[] })[] = [];
  const requestIds = await workload(async ids => {
    const prior = during.at(-1)?.requestIds ?? [];
    if (!ids.length || ids.length > 32 || during.length >= 32 || new Set(ids).size !== ids.length ||
        ids.some(id => !/^[a-f0-9-]{36}$/i.test(id)) || ids.length <= prior.length ||
        prior.some(id => !ids.includes(id))) throw Error('Worker-window checkpoint request population');
    const checkpoint = { requestIds: [...ids], ...await sample(ids) };
    during.push(checkpoint);
    reader.record?.('during', structuredClone(during));
    auditRequestWorkerAssignments(ids, checkpoint.observations, expectedBuild);
  });
  const knownIds = requestIds.filter((id): id is string => typeof id === 'string');
  if (during.length && (during.at(-1)!.requestIds.length !== knownIds.length ||
      knownIds.some(id => !during.at(-1)!.requestIds.includes(id))))
    throw Error('Worker-window final checkpoint population');
  reader.record?.('requestIds', [...requestIds]);
  const after = await sample(knownIds);
  reader.record?.('after', structuredClone(after));
  const resources = after.observations.map((row, index) => {
    const prior = before.observations[index];
    if (prior.snapshot.processInstanceId !== row.snapshot.processInstanceId ||
        JSON.stringify(prior.role) !== JSON.stringify(row.role)) throw Error('Worker-window process instance or role changed');
    const allocatedBytes = row.counters.heap.total_allocated_bytes - prior.counters.heap.total_allocated_bytes;
    if (allocatedBytes < 0) throw Error('Worker-window cumulative allocation regressed');
    return { pid: row.after.pid, startTicks: row.after.startTicks, executableSha256: row.after.executableSha256,
      processInstanceId: row.snapshot.processInstanceId, buildSha: expectedBuild, role: row.role,
      pssBytesBefore: prior.after.pssBytes, pssBytesAfter: row.after.pssBytes,
      pssChangeBytes: row.after.pssBytes - prior.after.pssBytes, allocatedBytes,
      countersBefore: prior.counters, countersAfter: row.counters };
  });
  reader.record?.('resources', structuredClone(resources));
  auditRequestWorkerAssignments(requestIds, after.observations, expectedBuild);
  // Preserve exact metadata observed before a later bounded-ring overwrite.
  // Every raw checkpoint remains available to the independent reader; no rows
  // or WeakRefs cross this seam, and an unseen request remains unknown.
  const merged = after.observations.map((row, index) => {
    if (row.snapshot.status !== 'observed') return row;
    const queries = new Map<string, any>();
    for (const point of [...during, after]) {
      const observation = point.observations[index];
      if (observation.snapshot.status !== 'observed' ||
          observation.snapshot.processInstanceId !== row.snapshot.processInstanceId ||
          JSON.stringify(observation.role) !== JSON.stringify(row.role))
        throw Error('Worker-window checkpoint loaded identity changed');
      for (const q of observation.snapshot.results) {
        const key = JSON.stringify([q.correlation.requestId, q.pool, q.source.processInstanceId,
          q.source.buildSha, q.source.poolInstanceId, q.connectionId, q.queryId]);
        if (queries.has(key) && JSON.stringify(queries.get(key)) !== JSON.stringify(q))
          throw Error('Worker-window checkpoint query tuple changed');
        queries.set(key, q);
      }
    }
    if (queries.size > 64) throw Error('Worker-window checkpoint relation cap');
    return { ...row, snapshot: { ...row.snapshot, results: [...queries.values()] } };
  });
  const assignment = auditRequestWorkerAssignments(requestIds, merged, expectedBuild);
  reader.record?.('assignment', structuredClone(assignment));
  return { before, ...(during.length ? { during } : {}), after, resources, assignment,
    definition: 'Unforced serial per-worker PSS and cumulative V8 allocation bracketing one exact request window, including observer work; no native ownership, intervention saving, or complete worker/query census' };
}

function listenerPorts(pid: number) {
  const inodes = new Set(readdirSync(`/proc/${pid}/fd`).flatMap(fd => {
    try { return [readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/)?.[1]]; }
    catch { return []; }
  }).filter(Boolean));
  return [...new Set(['tcp', 'tcp6'].flatMap(kind =>
    readFileSync(`/proc/${pid}/net/${kind}`, 'utf8').trim().split('\n').slice(1).flatMap(line => {
      const fields = line.trim().split(/\s+/);
      return fields[3] === '0A' && inodes.has(fields[9]) ? [parseInt(fields[1].split(':').at(-1)!, 16)] : [];
    })))];
}

// Extend the existing counter selector: a scalar keeps its historical meaning;
// an explicit bounded list selects several targets without changing the fleet.
function parseCounterPids(raw: string | undefined, mainPid: number): number[] {
  const parsed = raw?.trim().startsWith('[') ? JSON.parse(raw) : [Number(raw ?? mainPid)];
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8 ||
      parsed.some(pid => !Number.isSafeInteger(pid) || pid <= 0) || new Set(parsed).size !== parsed.length) {
    throw Error('Counter selection requires one scalar PID or at most eight distinct integer PIDs');
  }
  return parsed;
}

function selectCounterTargets(main: ResourceRow, pids: number[], sample = processSample) {
  const ancestry = new Map<number, ResourceRow>();
  for (const pid of pids) {
    const seen = new Set<number>();
    let ancestor = pid;
    while (ancestor !== main.pid) {
      if (ancestor <= 1 || seen.size >= 16 || seen.has(ancestor)) throw Error('Initial counter-target ancestry cap or unrelated target');
      seen.add(ancestor);
      const row = ancestry.get(ancestor) ?? sample(ancestor);
      ancestry.set(ancestor, row); ancestor = row.parentPid;
    }
  }
  return pids.map(pid => counterTarget(main, [...ancestry.values()], pid));
}

type InspectorConnection = { client: ReturnType<typeof createCdpClient>; port: number };
type InspectorLease = { target: ResourceRow; connection?: InspectorConnection; openedByProbe: boolean };
type InspectorEffects = {
  sample: typeof processSample;
  attach: (pid: number) => Promise<InspectorConnection | undefined>;
  open: (pid: number) => void;
  wait: () => Promise<unknown>;
  close: (connection: InspectorConnection) => Promise<unknown>;
};
const inspectorEffects: InspectorEffects = {
  sample: processSample,
  attach: async pid => {
    for (const port of listenerPorts(pid).filter(value => value !== 3170)) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) });
        if (!response.ok) continue;
        const target = (await response.json()).find((row: any) => row.type === 'node' && row.webSocketDebuggerUrl);
        if (!target) continue;
        const client = createCdpClient(target.webSocketDebuggerUrl);
        try { await client.connect(); await readProcessMemory(client, { expectedPid: pid }); }
        catch (error) { client.close(); throw error; }
        return { client, port };
      } catch { /* A different PID-bound listener is not a Node inspector. */ }
    }
    return undefined;
  },
  open: pid => process.kill(pid, 'SIGUSR1'),
  wait: () => wait(250),
  close: connection => closeInspector(connection.client, connection.port),
};

function assertInspectorTarget(target: ResourceRow, current: ResourceRow) {
  assertIdentity(target, current);
  if (target.parentPid !== current.parentPid || target.command.sha256 !== current.command.sha256 ||
      target.command.script !== current.command.script) throw Error('Inspector target entry or ancestry changed');
}

// Record ownership before acquisition can fail, so finally can recover a
// partially opened set. Never close an inspector which existed before us.
async function acquireTargetInspectors(targets: ResourceRow[], leases: InspectorLease[], effects = inspectorEffects) {
  for (const target of targets) {
    assertInspectorTarget(target, effects.sample(target.pid));
    const lease: InspectorLease = { target, openedByProbe: false };
    leases.push(lease);
    lease.connection = await effects.attach(target.pid);
    assertInspectorTarget(target, effects.sample(target.pid));
    if (!lease.connection) {
      effects.open(target.pid); lease.openedByProbe = true;
      for (let attempt = 0; attempt < 20 && !lease.connection; attempt++) {
        await effects.wait();
        assertInspectorTarget(target, effects.sample(target.pid));
        lease.connection = await effects.attach(target.pid);
      }
    }
    if (!lease.connection) throw Error('PID-bound inspector unavailable for selected target ' + target.pid);
    assertInspectorTarget(target, effects.sample(target.pid));
  }
}

async function releaseTargetInspectors(leases: InspectorLease[], effects = inspectorEffects) {
  const results: { pid: number; openedByProbe: boolean; result?: unknown; error?: string }[] = [];
  for (const lease of [...leases].reverse()) {
    const row: typeof results[number] = { pid: lease.target.pid, openedByProbe: lease.openedByProbe };
    try {
      assertInspectorTarget(lease.target, effects.sample(lease.target.pid));
      // Retry discovery after a partial acquisition, without signalling again.
      if (!lease.connection && lease.openedByProbe) lease.connection = await effects.attach(lease.target.pid);
      assertInspectorTarget(lease.target, effects.sample(lease.target.pid));
      if (lease.openedByProbe) {
        if (!lease.connection) throw Error('Probe-opened inspector cleanup remains unobserved');
        row.result = await effects.close(lease.connection);
      } else row.result = { preservedPreexisting: true };
      assertInspectorTarget(lease.target, effects.sample(lease.target.pid));
    } catch (error) { row.error = String(error); }
    finally {
      try { lease.connection?.client.close(); }
      catch (error) { row.error = (row.error ? row.error + '; ' : '') + 'Detach failed: ' + String(error); }
      results.push(row);
    }
  }
  return results;
}

describe('workload request diagnostics', () => {
  it('records both response IDs and observes them before rejecting an HTTP failure', async () => {
    const report = { requests: [] as WorkloadRequestDiagnostic[] };
    const published: WorkloadRequestDiagnostic[][] = [];
    const observed: string[][] = [];
    const responses = [
      new Response(JSON.stringify({ rows: [] }), {
        status: 200, headers: { 'x-papercusp-request-id': '11111111-1111-4111-8111-111111111111' },
      }),
      new Response(JSON.stringify({ error: 'row read deadline' }), {
        status: 500, headers: { 'x-papercusp-request-id': '22222222-2222-4222-8222-222222222222' },
      }),
    ];

    await expect(captureWorkloadRequestPair({
      report,
      window: 1,
      pair: 2,
      fetchRequest: async index => responses[index]!,
      publish: () => published.push(report.requests.map(row => ({ ...row }))),
      observe: async requestIds => { observed.push(requestIds); },
    })).rejects.toThrow();

    expect(report.requests).toMatchObject([
      { status: 200, requestId: '11111111-1111-4111-8111-111111111111', window: 1, pair: 2 },
      { status: 500, requestId: '22222222-2222-4222-8222-222222222222', window: 1, pair: 2 },
    ]);
    expect(published[0]).toMatchObject([
      { status: 200, requestId: '11111111-1111-4111-8111-111111111111' },
      { status: 500, requestId: '22222222-2222-4222-8222-222222222222' },
    ]);
    expect(observed).toEqual([[
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]]);
  });
});

describe('actual current-build operator memory baseline', () => {
  describe('sampler target inspector lifecycle', () => {
    const target = (pid: number): ResourceRow => ({ pid, parentPid: 1, startTicks: String(pid),
      executable: '/node', executableSha256: 'a'.repeat(64),
      command: { script: '/runtime/hono-host.mjs', sha256: 'x', esbuildService: false },
      pssBytes: 1000, rssBytes: 2000, anonymousBytes: 800 });
    const setup = () => {
      const targets = [target(11), target(12)], leases: InspectorLease[] = [];
      const signalled: number[] = [], closed: number[] = [], detached: number[] = [];
      const connection = (pid: number) => ({ port: 9000 + pid,
        client: { close: () => { detached.push(pid); } } as unknown as ReturnType<typeof createCdpClient> });
      const effects: InspectorEffects = { sample: pid => ({ ...targets.find(row => row.pid === pid)! }),
        attach: async pid => pid === 11 || signalled.includes(pid) ? connection(pid) : undefined,
        open: pid => { signalled.push(pid); }, wait: async () => {},
        close: async c => { closed.push(c.port - 9000); return { closed: true }; } };
      return { targets, leases, effects, signalled, closed, detached };
    };
    it('keeps scalar selection and explicit list order without accepting ambiguous or duplicate targets', () => {
      expect(parseCounterPids(undefined, 10)).toEqual([10]); expect(parseCounterPids('11', 10)).toEqual([11]);
      expect(parseCounterPids('[12,11]', 10)).toEqual([12, 11]);
      for (const raw of ['[]', '[11,11]', '["11"]', '[0]', '[1.5]', 'NaN', '[1,2,3,4,5,6,7,8,9]'])
        expect(() => parseCounterPids(raw, 10)).toThrow();
      const main = target(10), children = [target(11), target(12)].map(row => ({ ...row, parentPid: 10 }));
      expect(selectCounterTargets(main, [12, 11], pid => children.find(row => row.pid === pid)!).map(row => row.pid)).toEqual([12, 11]);
      expect(() => selectCounterTargets(main, [11], pid => ({ ...children[0], parentPid: pid }))).toThrow('ancestry');
    });
    it('preserves preexisting inspectors and closes only the target it signalled', async () => {
      const f = setup(); await acquireTargetInspectors(f.targets, f.leases, f.effects);
      expect(f.signalled).toEqual([12]);
      expect((await releaseTargetInspectors(f.leases, f.effects)).every(row => !row.error)).toBe(true);
      expect(f.closed).toEqual([12]); expect(f.detached).toEqual([12, 11]);
    });
    it('recovers a partial acquisition and releases the first target after a later attach error', async () => {
      const f = setup(), attach = f.effects.attach;
      f.effects.attach = async pid => {
        if (pid === 12 && f.signalled.includes(pid)) throw Error('second target disconnected');
        return attach(pid);
      };
      await expect(acquireTargetInspectors(f.targets, f.leases, f.effects)).rejects.toThrow('second target disconnected');
      f.effects.attach = attach;
      expect((await releaseTargetInspectors(f.leases, f.effects)).every(row => !row.error)).toBe(true);
      expect(f.closed).toEqual([12]); expect(f.detached).toContain(11);
    });
    it('continues cleanup after one failure and never closes a reused PID', async () => {
      const f = setup(); await acquireTargetInspectors(f.targets, f.leases, f.effects);
      f.effects.sample = pid => ({ ...f.targets.find(row => row.pid === pid)!, startTicks: pid === 12 ? 'reused' : '11' });
      const result = await releaseTargetInspectors(f.leases, f.effects);
      expect(result[0].error).toContain('identity changed'); expect(result[1].error).toBeUndefined();
      expect(f.closed).toEqual([]); expect(f.detached).toEqual([12, 11]);
    });
    it('reports an unobserved probe-opened endpoint while still detaching other targets', async () => {
      const f = setup(); f.effects.attach = async pid => pid === 11 ? setup().effects.attach(pid) : undefined;
      await expect(acquireTargetInspectors(f.targets, f.leases, f.effects)).rejects.toThrow('unavailable');
      const result = await releaseTargetInspectors(f.leases, f.effects);
      expect(result[0].error).toContain('unobserved'); expect(result[1].result).toEqual({ preservedPreexisting: true });
    });
    it('does not abandon earlier targets when closing or detaching a later target fails', async () => {
      const f = setup(); await acquireTargetInspectors(f.targets, f.leases, f.effects);
      f.effects.close = async () => { throw Error('close failed'); };
      f.leases[1].connection!.client.close = () => { throw Error('detach failed'); };
      const result = await releaseTargetInspectors(f.leases, f.effects);
      expect(result[0].error).toContain('close failed'); expect(result[0].error).toContain('detach failed');
      expect(result[1].error).toBeUndefined(); expect(f.detached).toContain(11);
    });
    it('opens and closes only its own inspector across two real isolated Node processes', async () => {
      const children: ReturnType<typeof spawn>[] = [], leases: InspectorLease[] = [];
      let failure: unknown;
      try {
        for (const preexisting of [true, false]) {
          const child = spawn(process.execPath, [preexisting ? '--inspect=127.0.0.1:0' : '--inspect-port=127.0.0.1:0',
            '-e', 'console.log("P011_INSPECTOR_READY");setInterval(()=>{},1000)'],
          { stdio: ['ignore', 'pipe', 'pipe'] });
          children.push(child);
          let output = '';
          for (const stream of [child.stdout!, child.stderr!]) stream.setEncoding('utf8').on('data', data => { output = (output + data).slice(-4000); });
          const deadline = Date.now() + 10000;
          while (!output.includes('P011_INSPECTOR_READY')) {
            if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline)
              throw Error('Private inspector readiness failed: ' + output);
            await wait(25);
          }
        }
        await acquireTargetInspectors(children.map(child => processSample(child.pid!)), leases);
        expect(leases.map(lease => lease.openedByProbe)).toEqual([false, true]);
        for (const lease of leases) expect((await readProcessMemory(lease.connection!.client,
          { expectedPid: lease.target.pid })).pid).toBe(lease.target.pid);
        const cleanup = await releaseTargetInspectors(leases);
        expect(cleanup.every(row => !row.error)).toBe(true);
        expect(cleanup.find(row => row.openedByProbe)?.result).toEqual({ closed: true });
        const preexisting = await inspectorEffects.attach(children[0].pid!);
        expect(preexisting).toBeDefined(); preexisting!.client.close();
        expect(await inspectorEffects.attach(children[1].pid!)).toBeUndefined();
      } catch (error) { failure = error; throw error; }
      finally {
        const cleanup = await releaseTargetInspectors(leases.filter(lease => lease.connection &&
          children.some(child => child.pid === lease.target.pid && child.exitCode === null && child.signalCode === null)));
        const cleanupErrors = cleanup.filter(row => row.error);
        // Process teardown is unconditional, including partial inspector acquisition.
        for (const child of children) {
          if (child.exitCode !== null || child.signalCode !== null) continue;
          const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
          child.kill('SIGTERM'); await Promise.race([exited, wait(2000)]);
          if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
        }
        for (const child of children) expect(existsSync('/proc/' + child.pid)).toBe(false);
        if (cleanupErrors.length && !failure) throw Error('Private inspector cleanup failed: ' + JSON.stringify(cleanupErrors));
      }
    }, 30000);
  });
  describe('multi-target request-resource window', () => {
    const build = 'abcdef1234';
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const setup = () => {
      const main: ResourceRow = { pid: 10, parentPid: 1, startTicks: '1', executable: '/node',
        executableSha256: 'a'.repeat(64), command: { script: '/runtime/hono-host.mjs', sha256: 'x', esbuildService: false },
        pssBytes: 1000, rssBytes: 2000, anonymousBytes: 800 };
      const children = [11, 12, 13].map(pid => ({ ...main, pid, parentPid: main.pid, startTicks: String(pid) }));
      const targets = children.slice(0, 2).map(row => ({ ...row }));
      let reads = 0, workloads = 0, censuses = 0;
      const census = () => { censuses++; return { main: { ...main }, descendants: children.map(row => ({ ...row })),
        notChecked: [] as WorkerCensus['notChecked'] }; };
      const read: WorkerWindowReader['read'] = async (pid, requestIds) => {
        const phase = Math.floor(reads++ / 2);
        const requestId = ids[pid - 11];
        const processInstanceId = (pid === 11 ? '33333333' : '44444444') + '-3333-4333-8333-333333333333';
        const poolInstanceId = '55555555-5555-4555-8555-555555555555';
        return { counters: { pid, heap: { total_allocated_bytes: 10000 + phase * 200 },
          memory: { heapUsed: 100 }, hostFacts: { cluster: { isPrimary: false, isWorker: true },
            backgroundWorkersOverride: 'disabled', stagingPort: false,
            sidecarFlags: { substrate: false, spawner: false, gateway: false, embed: false, resourceHealth: false } } },
        snapshot: { status: 'observed', pid, processInstanceId, buildSha: build,
          results: requestIds.includes(requestId) ? [1, 2].map(queryId => ({ pool: 'test',
            source: { processInstanceId, buildSha: build, poolInstanceId }, connectionId: 1, queryId,
            queryFamily: 'select:harness_shared.work_items', elapsedMs: 100 + queryId,
            preBuildMs: 50 + queryId, status: 'ok', errorCode: null,
            correlation: { requestId, processInstanceId, buildSha: build, operation: 'workItems.byHarness' } })) : [] } };
      };
      const reader = { census, read };
      const workload = async () => { workloads++; children[0].pssBytes -= 25; return ids; };
      return { main, children, targets, reader, workload, counts: () => ({ reads, workloads, censuses }) };
    };
    it('brackets both worker resources and conserves exact requests without calling a PSS decline a saving', async () => {
      const f = setup(), result = await collectRequestWorkerWindow(f.targets, build, f.reader, f.workload);
      expect(result.resources.map(row => [row.pid, row.allocatedBytes, row.pssChangeBytes])).toEqual([[11, 200, -25], [12, 200, 0]]);
      expect(result.assignment.status).toBe('observed');
      expect(result.assignment.assignments.map(row => [row.pid, row.queryTuples.length])).toEqual([[11, 2], [12, 2]]);
      expect(result.assignment.assignments.map(row => row.querySamples.map(sample =>
        [sample.queryFamily, sample.elapsedMs, sample.preBuildMs]))).toEqual([
        [['select:harness_shared.work_items', 101, 51], ['select:harness_shared.work_items', 102, 52]],
        [['select:harness_shared.work_items', 101, 51], ['select:harness_shared.work_items', 102, 52]],
      ]);
      expect(result.after.coverage.unsampledPids).toEqual([10, 13]);
      expect(result.before.census.before.descendants.map(row => row.pid)).toEqual([11, 12, 13]);
      expect(result.before.census.after.descendants[0].pssBytes).toBe(1000);
      expect(result.after.census.before.descendants[0].pssBytes).toBe(975);
      expect(result.after.census.after.descendants[0].pssBytes).toBe(975);
      expect(result.before.observations[0].before).toEqual(result.before.census.before.descendants[0]);
      expect(result.after.observations[0].after).toEqual(result.after.census.after.descendants[0]);
      expect(result.definition).toContain('no native ownership'); expect(f.counts().workloads).toBe(1);
    });
    it('keeps evicted requests and raced census residue explicit beside successful resource rows', async () => {
      const f = setup(), read = f.reader.read;
      f.reader.read = async (pid, ids) => { const value = await read(pid, ids); if (pid === 12) value.snapshot.results = []; return value; };
      const census = f.reader.census;
      f.reader.census = () => ({ ...census(), notChecked: [{ pid: 99, parentPid: 10, reason: 'cap' }] });
      const result = await collectRequestWorkerWindow(f.targets, build, f.reader, f.workload);
      expect(result.resources).toHaveLength(2); expect(result.assignment.status).toBe('partial');
      expect(result.assignment.unresolvedRequestIds).toEqual([ids[1]]);
      expect(result.after.coverage.notCheckedAfter).toEqual([{ pid: 99, parentPid: 10, reason: 'cap' }]);
      expect(result.after.census.after.notChecked).toEqual(result.after.coverage.notCheckedAfter);
    });
    it('preserves observed response-checkpoint tuples after terminal ring turnover', async () => {
      const f = setup(), read = f.reader.read;
      let selectedReads = 0;
      f.reader.read = async (pid, requested) => {
        const value = await read(pid, requested);
        if (requested.length && selectedReads++ >= 2) value.snapshot.results = [];
        return value;
      };
      const recorded: string[] = [];
      (f.reader as WorkerWindowReader).record = stage => { recorded.push(stage); };
      const result = await collectRequestWorkerWindow(f.targets, build, f.reader, async observe => {
        await observe(ids); return f.workload();
      });
      expect(result.after.observations.every(row => row.snapshot.status === 'observed' && row.snapshot.results.length === 0)).toBe(true);
      expect(result.during).toHaveLength(1);
      expect(result.assignment.status).toBe('observed');
      expect(result.assignment.assignments.map(row => row.queryTuples.length)).toEqual([2, 2]);
      expect(recorded).toEqual(['before', 'during', 'requestIds', 'after', 'resources', 'assignment']);
    });
    it.each(['duplicate', 'missing final', 'changed tuple'])('rejects response-checkpoint %s', async kind => {
      const f = setup(), read = f.reader.read;
      let selectedReads = 0;
      if (kind === 'changed tuple') f.reader.read = async (pid, requested) => {
        const value = await read(pid, requested);
        if (value.snapshot.status === 'observed' && requested.length && selectedReads++ >= 2)
          value.snapshot.results[0].metadataDrift = true;
        return value;
      };
      await expect(collectRequestWorkerWindow(f.targets, build, f.reader, async observe => {
        await observe(kind === 'duplicate' ? [ids[0], ids[0]] : kind === 'missing final' ? [ids[0]] : ids);
        return f.workload();
      })).rejects.toThrow();
    });
    it('persists census ancestry independently of later changes to reader-owned rows', async () => {
      const f = setup();
      const wrapper = { ...f.main, pid: 20, parentPid: f.main.pid, startTicks: '20',
        command: { ...f.main.command, script: '/runtime/wrapper.mjs' } };
      f.children.push(wrapper); f.children[0].parentPid = 20; f.targets[0].parentPid = 20;
      const result = await collectRequestWorkerWindow(f.targets, build, f.reader, f.workload);
      wrapper.command.script = '/changed/wrapper.mjs'; wrapper.startTicks = 'reused';
      expect(result.before.census.before.descendants.find(row => row.pid === 20)?.command.script)
        .toBe('/runtime/wrapper.mjs');
      expect(result.after.census.after.descendants.find(row => row.pid === 20)?.startTicks).toBe('20');
      expect(result.after.observations[0].after.parentPid).toBe(20);
    });
    it('rejects an oversized raw census before reading targets or running workload', async () => {
      const f = setup();
      f.children.push(...Array.from({ length: 62 }, (_, i) => ({ ...f.main, pid: 100 + i,
        parentPid: f.main.pid, startTicks: String(100 + i) })));
      await expect(collectRequestWorkerWindow(f.targets, build, f.reader, f.workload)).rejects.toThrow('census cap');
      expect(f.counts().reads).toBe(0); expect(f.counts().workloads).toBe(0);
    });
    it('preserves raw failed brackets before deriving request assignment', async () => {
      const f = setup(), read = f.reader.read;
      const recorded: { stage: string; value: any }[] = [];
      f.reader.read = async (pid, ids) => {
        const value = await read(pid, ids);
        if (value.snapshot.status === 'observed' && ids.length && pid === 11)
          Object.assign(value.snapshot.results[0], { status: 'error', errorCode: '57014' });
        return value;
      };
      const result = await collectRequestWorkerWindow(f.targets, build,
        { ...f.reader, record: (stage, value) => { recorded.push({ stage, value }); } }, f.workload);
      expect(recorded.map(row => row.stage)).toEqual(['before', 'requestIds', 'after', 'resources', 'assignment']);
      expect(recorded.find(row => row.stage === 'after')!.value.observations[0].snapshot.results[0].status)
        .toBe('error');
      expect(recorded.find(row => row.stage === 'after')!.value.observations[0].snapshot.results[0])
        .toMatchObject({ queryFamily: 'select:harness_shared.work_items', elapsedMs: 101,
          preBuildMs: 51, status: 'error', errorCode: '57014' });
      const failedSamples = result.assignment.assignments.flatMap(row => row.querySamples)
        .filter(sample => sample.status === 'error');
      expect(result.assignment.status).toBe('observed');
      expect(failedSamples).toHaveLength(1);
      expect(failedSamples[0]).toMatchObject({ queryFamily: 'select:harness_shared.work_items',
        elapsedMs: 101, preBuildMs: 51, status: 'error', errorCode: '57014' });
      const savedSamples = recorded.find(row => row.stage === 'assignment')!.value.assignments
        .flatMap((row: any) => row.querySamples).filter((sample: any) => sample.status === 'error');
      expect(savedSamples).toHaveLength(1);
      expect(savedSamples[0]).toMatchObject({ queryFamily: 'select:harness_shared.work_items',
        elapsedMs: 101, preBuildMs: 51, status: 'error', errorCode: '57014' });
      expect(recorded.find(row => row.stage === 'after')!.value.census.after.main.pid).toBe(10);
      expect(recorded.find(row => row.stage === 'resources')!.value).toHaveLength(2);
    });
    it.each(['duplicate', 'foreign', 'reused', 'parent pin', 'entry pin'] as const)('rejects %s target selection before observing workload', async kind => {
      const f = setup();
      if (kind === 'duplicate') f.targets[1] = f.targets[0];
      if (kind === 'foreign') f.targets[0].parentPid = 98;
      if (kind === 'reused') f.targets[0].startTicks = 'reused';
      if (kind === 'parent pin') f.targets[0].parentPid = 98;
      if (kind === 'entry pin') f.targets[0].command = { ...f.targets[0].command, script: '/other/hono-host.mjs' };
      // The selected record's ancestry itself is also part of the pin.
      if (kind === 'foreign') f.children[0].parentPid = 98;
      await expect(collectRequestWorkerWindow(f.targets, build, f.reader, f.workload)).rejects.toThrow();
      expect(f.counts().reads).toBe(0); expect(f.counts().workloads).toBe(0);
    });
    it.each(['build', 'role', 'allocation', 'counter PID', 'instance'] as const)('rejects changed %s within a measured window', async kind => {
      const f = setup(), read = f.reader.read;
      f.reader.read = async (pid, ids) => {
        const value = await read(pid, ids);
        if (ids.length && pid === 11) {
          if (kind === 'build') value.snapshot.buildSha = '0123456789';
          if (kind === 'role') value.counters.hostFacts.cluster = { isPrimary: true, isWorker: false };
          if (kind === 'allocation') value.counters.heap.total_allocated_bytes = 9999;
          if (kind === 'counter PID') value.counters.pid = 99;
          if (kind === 'instance') value.snapshot.processInstanceId = '66666666-6666-4666-8666-666666666666';
        }
        return value;
      };
      await expect(collectRequestWorkerWindow(f.targets, build, f.reader, f.workload)).rejects.toThrow();
    });
    it('rejects ancestor PID reuse even when the selected worker PID and executable stay the same', async () => {
      const f = setup();
      const wrapper = { ...f.main, pid: 20, parentPid: f.main.pid, startTicks: '20',
        command: { ...f.main.command, script: '/runtime/wrapper.mjs' } };
      f.children.push(wrapper); f.children[0].parentPid = 20; f.targets[0].parentPid = 20;
      const read = f.reader.read;
      f.reader.read = async (pid, ids) => { const value = await read(pid, ids); wrapper.startTicks = 'reused'; return value; };
      await expect(collectRequestWorkerWindow(f.targets, build, f.reader, f.workload)).rejects.toThrow('identity changed');
      expect(f.counts().workloads).toBe(0);
    });
    it('propagates a failed worker read before running workload instead of silently dropping its resources', async () => {
      const f = setup(); f.reader.read = async () => { throw Error('target disconnected'); };
      await expect(collectRequestWorkerWindow(f.targets, build, f.reader, f.workload)).rejects.toThrow('target disconnected');
      expect(f.counts().workloads).toBe(0);
    });
    it('collects actual unforced counters and HTTP relations across an isolated same-entry process tree', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'p011-worker-window-'));
      const fixturePath = join(directory, 'hono-host.mjs');
      const registryModule = pathToFileURL(join(root, 'libs/papercusp/libs/db/src/acquire-registry.ts')).href;
      const stampModule = pathToFileURL(join(root, 'libs/papercusp/libs/db/src/build-stamp.ts')).href;
      writeFileSync(fixturePath, `
        import { createServer } from 'node:http';
        import { spawn } from 'node:child_process';
        import { fileURLToPath } from 'node:url';
        import { randomUUID } from 'node:crypto';
        import { recordPgResult, pgDiagnosticIdentity } from ${JSON.stringify(registryModule)};
        import { setBuildStampResolver } from ${JSON.stringify(stampModule)};
        setBuildStampResolver(() => ${JSON.stringify(build)});
        if (process.env.P011_PRIVATE_WORKER === '1') {
          const identity = pgDiagnosticIdentity(), poolInstanceId = randomUUID();
          let sequence = 0;
          const server = createServer((_request, response) => {
            const requestId = randomUUID();
            recordPgResult('p011-window', { connectionId: 1, queryId: ++sequence,
              backendPid: null, query: 'select 1', rowCount: 1, wireBytes: 1, status: 'ok',
              result: [{ value: 1 }], context: { state: 'linked', correlation: { ...identity,
                requestId, operation: 'workItems.byHarness', attemptId: randomUUID(),
                rowId: null, hopId: null, stage: null, boundary: 'await' } }
            }, { ...identity, poolInstanceId });
            response.setHeader('x-papercusp-request-id', requestId);
            response.end(JSON.stringify({ rows: [{ value: 1 }] }));
          });
          server.listen(0, '127.0.0.1', () => console.log('P011_WORKER_READY ' + process.pid + ' ' + server.address().port));
          process.on('SIGTERM', () => server.close(() => process.exit(0)));
        } else {
          const children = [0, 1].map(() => spawn(process.execPath,
            ['--inspect=127.0.0.1:0', '--import', 'tsx', fileURLToPath(import.meta.url)],
            { env: { ...process.env, P011_PRIVATE_WORKER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }));
          for (const child of children) {
            child.stdout.on('data', data => process.stdout.write(data));
            child.stderr.on('data', data => {
              const endpoint = String(data).match(new RegExp('Debugger listening on (ws://[a-zA-Z0-9:./-]+)'));
              if (endpoint) console.log('P011_WORKER_DEBUG ' + child.pid + ' ' + endpoint[1]);
            });
          }
          process.on('SIGTERM', async () => {
            await Promise.all(children.map(child => new Promise(resolve => {
              if (child.exitCode !== null || child.signalCode !== null) return resolve();
              child.once('exit', resolve); child.kill('SIGTERM');
            })));
            process.exit(0);
          });
        }
      `);
      const clients = new Map<number, ReturnType<typeof createCdpClient>>();
      let fixture: ReturnType<typeof spawn> | undefined;
      let output = '';
      let workerPids: number[] = [];
      let failed = false;
      try {
        const parsed = spawnSync(process.execPath, ['--check', fixturePath], { encoding: 'utf8', timeout: 5000 });
        if (parsed.status !== 0) throw Error('Private worker source parser preflight failed: ' +
          (parsed.error?.message ?? parsed.stderr));
        fixture = spawn(process.execPath, ['--import', 'tsx', fixturePath], { cwd: root,
          env: { ...process.env, PAPERCUSP_BACKGROUND_WORKERS: '0', PAPERCUSP_SUBSTRATE_SIDECAR_MODE: '0',
            PAPERCUSP_SPAWNER_SIDECAR_MODE: '0', PAPERCUSP_GATEWAY_SIDECAR_MODE: '0',
            PAPERCUSP_EMBED_SIDECAR_MODE: '0', PAPERCUSP_RESOURCE_GOVERNOR_MONITOR_MODE: '0' },
          stdio: ['ignore', 'pipe', 'pipe'] });
        for (const stream of [fixture.stdout!, fixture.stderr!]) stream.setEncoding('utf8').on('data', data => {
          output = (output + data).slice(-16000);
        });
        const deadline = Date.now() + 20000;
        while ([...output.matchAll(/P011_WORKER_READY (\d+) (\d+)/g)].length < 2 ||
            [...output.matchAll(/P011_WORKER_DEBUG (\d+) (ws:\/\/\S+)/g)].length < 2) {
          if (fixture.exitCode !== null || fixture.signalCode !== null || Date.now() > deadline)
            throw Error('Private worker tree readiness failed: ' + output);
          await wait(50);
        }
        const ready = [...output.matchAll(/P011_WORKER_READY (\d+) (\d+)/g)]
          .map(row => ({ pid: Number(row[1]), port: Number(row[2]) }));
        workerPids = ready.map(row => row.pid);
        for (const row of output.matchAll(/P011_WORKER_DEBUG (\d+) (ws:\/\/\S+)/g)) {
          const client = createCdpClient(row[2]); clients.set(Number(row[1]), client); await client.connect();
        }
        const targets = workerPids.map(processSample);
        const result = await collectRequestWorkerWindow(targets, build, {
          census: () => ({ main: processSample(fixture!.pid!), descendants: workerPids.map(processSample), notChecked: [] }),
          read: (pid, ids) => readRequestWorkerResources(clients.get(pid)!, pid, ids),
        }, async () => Promise.all(ready.map(async target => {
          const response = await fetch('http://127.0.0.1:' + target.port, { signal: AbortSignal.timeout(5000) });
          expect(response.status).toBe(200); expect(await response.json()).toEqual({ rows: [{ value: 1 }] });
          return response.headers.get('x-papercusp-request-id');
        })));
        expect(result.assignment.status).toBe('observed');
        expect(result.assignment.assignments.map(row => row.pid)).toEqual(workerPids);
        expect(result.resources).toHaveLength(2);
        expect(result.resources.every(row => row.allocatedBytes > 0 && row.pssBytesBefore > 0 && row.pssBytesAfter > 0)).toBe(true);
        expect(result.resources.every(row => row.countersBefore.heapSpaces.length > 0 && row.countersAfter.heapSpaces.length > 0)).toBe(true);
        expect(result.before.coverage.unsampledPids).toEqual([fixture.pid]);
        expect(result.after.coverage.population).toContain('population remains unknown');
      } catch (error) {
        failed = true;
        throw new Error('Private worker-window failed: ' + (error instanceof Error ? error.message : String(error)) +
          '\nBounded fixture output: ' + output, { cause: error });
      } finally {
        for (const client of clients.values()) client.close();
        // Include partial readiness: a failed second child must not strand the first.
        workerPids = [...new Set([...workerPids, ...[...output.matchAll(/P011_WORKER_(?:READY|DEBUG) (\d+)/g)].map(row => Number(row[1]))])];
        if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
          const exited = new Promise<void>(resolve => fixture!.once('exit', () => resolve()));
          fixture.kill('SIGTERM'); await Promise.race([exited, wait(3000)]);
          if (fixture.exitCode === null && fixture.signalCode === null) {
            for (const pid of workerPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ } }
            fixture.kill('SIGKILL'); await exited;
          }
        }
        try {
          for (const pid of workerPids) expect(existsSync('/proc/' + pid)).toBe(false);
          if (fixture && !failed) expect(fixture.exitCode === 0 || fixture.signalCode === 'SIGKILL').toBe(true);
        } finally { rmSync(directory, { recursive: true, force: true }); }
      }
    }, 60000);
  });
  describe('exact request-worker assignment', () => {
    const build = 'abcdef1234';
    const request = '11111111-1111-4111-8111-111111111111';
    const other = '22222222-2222-4222-8222-222222222222';
    const processId = '33333333-3333-4333-8333-333333333333';
    const poolId = '44444444-4444-4444-8444-444444444444';
    const fixture = () => {
      const os = { pid: 71, startTicks: '123', executableSha256: 'a'.repeat(64) } as ResourceRow;
      return { before: os, after: { ...os }, role: { clusterRole: 'worker', requestOnly: true,
        configuredSidecar: null, requestAssignment: 'unknown', allocationOwner: 'unknown' },
      snapshot: { status: 'observed' as const, pid: 71, processInstanceId: processId, buildSha: build,
        results: [1, 2].map(queryId => ({ pool: 'org-app', source: { processInstanceId: processId,
          buildSha: build, poolInstanceId: poolId }, connectionId: 1, queryId,
          queryFamily: 'select:harness_shared.work_items', elapsedMs: 200 + queryId,
          preBuildMs: 75 + queryId, status: 'ok', errorCode: null,
          correlation: { processInstanceId: processId, buildSha: build, requestId: request, operation: 'workItems.byHarness' } })) } };
    };
    it('conserves one-to-many tuples and remains independent of observation and query order', () => {
      const a = fixture(), b = fixture();
      b.before = { ...b.before, pid: 72 }; b.after = { ...b.before }; b.snapshot.pid = 72;
      b.snapshot.processInstanceId = other;
      for (const row of b.snapshot.results) {
        row.source.processInstanceId = other; row.correlation.processInstanceId = other; row.correlation.requestId = other;
      }
      const result = auditRequestWorkerAssignments([request, other], [a, b], build);
      expect(result.status).toBe('observed'); expect(result.assignments.map(row => row.pid)).toEqual([71, 72]);
      expect(result.assignments.map(row => row.queryTuples.length)).toEqual([2, 2]);
      for (const row of [a, b]) row.snapshot.results.reverse();
      const normalize = (rows: any[]) => rows.map(row => ({ ...row,
        queryTuples: [...row.queryTuples].sort(),
        querySamples: [...row.querySamples].sort((left, right) => left.queryId - right.queryId) }));
      expect(normalize(auditRequestWorkerAssignments([request, other], [b, a], build).assignments))
        .toEqual(normalize(result.assignments));
    });
    it('marks evicted or unsampled requests partial rather than assigning them by count or time', () => {
      const result = auditRequestWorkerAssignments([request, other], [fixture()], build);
      expect(result.status).toBe('partial'); expect(result.unresolvedRequestIds).toEqual([other]);
      expect(result.assignments).toHaveLength(1);
      expect(auditRequestWorkerAssignments([null, null], [fixture()], build).status).toBe('unknown');
    });
    const corruptions: [string, (value: ReturnType<typeof fixture>) => void][] = [
      ['PID reuse', r => { r.after.startTicks = '124'; }],
      ['inspector PID', r => { r.snapshot.pid++; }],
      ['loaded build', r => { r.snapshot.buildSha = '0123456789'; }],
      ['query build', r => { r.snapshot.results[0].source.buildSha = '0123456789'; }],
      ['operation build', r => { r.snapshot.results[0].correlation.buildSha = '0123456789'; }],
      ['query process', r => { r.snapshot.results[0].source.processInstanceId = other; }],
      ['operation process', r => { r.snapshot.results[0].correlation.processInstanceId = other; }],
      ['pool identity', r => { r.snapshot.results[0].source.poolInstanceId = 'unknown'; }],
      ['duplicate tuple', r => { r.snapshot.results.push(r.snapshot.results[0]); }],
      ['unrequested UUID', r => { r.snapshot.results[0].correlation.requestId = other; }],
      ['wrong operation', r => { r.snapshot.results[0].correlation.operation = 'workItems.other'; }],
      ['invalid query ID', r => { r.snapshot.results[0].queryId = -1; }],
      ['changed executable', r => { r.after.executableSha256 = 'b'.repeat(64); }],
      ['sidecar role', r => { r.role.configuredSidecar = 'spawner' as any; }],
    ];
    it.each(corruptions)('rejects %s before attributing measured workload', (_name, corrupt) => {
      const value = fixture(); corrupt(value);
      expect(() => auditRequestWorkerAssignments([request], [value], build)).toThrow();
    });
    it('accepts failed terminal queries and retains bounded diagnostics without SQL text', () => {
      const value = fixture();
      Object.assign(value.snapshot.results[0], { status: 'error', elapsedMs: 201, preBuildMs: 76,
        errorCode: '57014', query: 'SELECT private error query text' });
      const result = auditRequestWorkerAssignments([request], [value], build);
      expect(result.status).toBe('observed');
      expect(result.assignments).toHaveLength(1);
      expect(result.assignments[0].queryTuples).toHaveLength(2);
      expect(result.assignments[0].querySamples[0]).toEqual({ pool: 'org-app', poolInstanceId: poolId,
        connectionId: 1, queryId: 1, queryFamily: 'select:harness_shared.work_items', elapsedMs: 201,
        preBuildMs: 76, status: 'error', errorCode: '57014' });
      expect(JSON.stringify(result)).not.toContain('SELECT private error query text');
    });
    it('rejects the same HTTP UUID appearing under two independently observed processes', () => {
      const a = fixture(), b = fixture();
      b.before = { ...b.before, pid: 72 }; b.after = { ...b.before }; b.snapshot.pid = 72;
      b.snapshot.processInstanceId = other;
      for (const row of b.snapshot.results) { row.source.processInstanceId = other; row.correlation.processInstanceId = other; }
      expect(() => auditRequestWorkerAssignments([request], [a, b], build)).toThrow('cross-process');
    });
    it('reads the actual bounded PG writer without retaining rows or copying unrelated diagnostics', () => {
      const pool = 'p011-worker-assignment-' + request;
      const state = (globalThis as any)[Symbol.for('@papercusp/module-singleton.slots')];
      const previousResolver = state.get('@papercusp/db-org.build-stamp').value.resolver;
      try {
        setBuildStampResolver(() => build);
        const identity = pgDiagnosticIdentity();
        for (const queryId of [1, 2]) recordPgResult(pool, { connectionId: 1, queryId, backendPid: null,
          query: 'select * from harness_shared.spawned_agents', rowCount: 1, wireBytes: 1, status: 'ok',
          elapsedMs: 100 + queryId, preBuildMs: 50 + queryId,
          result: [{ privateBody: 'must not cross the inspector boundary' }], context: { state: 'linked', correlation: {
            ...identity, attemptId: other, rowId: null, hopId: null, stage: null, boundary: 'await',
            requestId: request, operation: 'workItems.byHarness' } } }, { ...identity, poolInstanceId: poolId });
        const snapshot = requestWorkerSnapshot([request]);
        expect(snapshot.status).toBe('observed');
        if (snapshot.status !== 'observed') throw Error('Actual writer identity unavailable');
        expect(snapshot.pid).toBe(process.pid); expect(snapshot.processInstanceId).toBe(identity.processInstanceId);
        expect(snapshot.results.filter(row => row.pool === pool)).toHaveLength(2);
        expect(snapshot.results.filter(row => row.pool === pool).map(({ queryFamily, elapsedMs, preBuildMs }) =>
          [queryFamily, elapsedMs, preBuildMs])).toEqual([
          ['select:harness_shared.spawned_agents', 101, 51], ['select:harness_shared.spawned_agents', 102, 52],
        ]);
        expect(JSON.stringify(snapshot)).not.toContain('privateBody');
        expect(JSON.stringify(snapshot)).not.toContain('select * from harness_shared.spawned_agents');
        expect(requestWorkerSnapshot([other]).status).toBe('observed');
        expect((requestWorkerSnapshot([other]) as any).results).toEqual([]);
        // Exercise the real FIFO writer, rather than attributing a saved
        // missing request to eviction from a plausible traffic story.
        for (let queryId = 3; queryId <= 34; queryId++) recordPgResult(pool, {
          connectionId: 1, queryId, backendPid: null, query: 'select 1', rowCount: 0,
          wireBytes: 0, status: 'ok',
        }, { ...identity, poolInstanceId: poolId });
        const turned = requestWorkerSnapshot([request]);
        if (turned.status !== 'observed') throw Error('Actual writer identity unavailable');
        expect(turned.results.filter(row => row.pool === pool)).toEqual([]);
        expect(turned.pools!.find(row => row.pool === pool)).toEqual({ pool, capacity: 32,
          retained: 32, totalRecorded: 34, dropped: 2 });
      } finally {
        state.get('@papercusp/db-org.acquire-registry').value.pools.delete(pool);
        setBuildStampResolver(previousResolver);
      }
    });
    it('joins real HTTP identities through serialized inspector readers in two independent request targets', async () => {
      const registryModule = pathToFileURL(join(root, 'libs/papercusp/libs/db/src/acquire-registry.ts')).href;
      const stampModule = pathToFileURL(join(root, 'libs/papercusp/libs/db/src/build-stamp.ts')).href;
      const source = `
        import { createServer } from 'node:http';
        import { randomUUID } from 'node:crypto';
        import { recordPgResult, pgDiagnosticIdentity } from ${JSON.stringify(registryModule)};
        import { setBuildStampResolver } from ${JSON.stringify(stampModule)};
        setBuildStampResolver(() => ${JSON.stringify(build)});
        const identity = pgDiagnosticIdentity(), poolInstanceId = randomUUID();
        let sequence = 0;
        const server = createServer((_request, response) => {
          const requestId = randomUUID();
          for (let i = 0; i < 2; i++) recordPgResult('p011-fixture', {
            connectionId: 1, queryId: ++sequence, backendPid: null,
            query: 'select * from harness_shared.spawned_agents', rowCount: 1, wireBytes: 1, status: 'ok',
            result: [{ privateBody: 'fixture-only' }],
            context: { state: 'linked', correlation: { ...identity, requestId,
              operation: 'workItems.byHarness', attemptId: randomUUID(), rowId: null,
              hopId: null, stage: null, boundary: 'await' } }
          }, { ...identity, poolInstanceId });
          response.setHeader('x-papercusp-request-id', requestId);
          response.end(JSON.stringify({ rows: [{ id: 'fixture' }] }));
        });
        server.listen(0, '127.0.0.1', () => console.log('P011_FIXTURE_PORT ' + server.address().port));
        process.on('SIGTERM', () => server.close(() => process.exit(0)));
      `;
      const targets: { child: ReturnType<typeof spawn>; output: string; client?: ReturnType<typeof createCdpClient> }[] = [];
      try {
        for (let i = 0; i < 2; i++) {
          const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--import', 'tsx', '--input-type=module', '-e', source],
            { cwd: root, env: { ...process.env, PAPERCUSP_BACKGROUND_WORKERS: '0',
              PAPERCUSP_SUBSTRATE_SIDECAR_MODE: '0', PAPERCUSP_SPAWNER_SIDECAR_MODE: '0',
              PAPERCUSP_GATEWAY_SIDECAR_MODE: '0', PAPERCUSP_EMBED_SIDECAR_MODE: '0',
              PAPERCUSP_RESOURCE_GOVERNOR_MONITOR_MODE: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
          const target = { child, output: '' } as typeof targets[number]; targets.push(target);
          for (const stream of [child.stdout!, child.stderr!]) stream.setEncoding('utf8').on('data', value => {
            target.output = (target.output + value).slice(-8000);
          });
        }
        const observations = [];
        const requestIds: string[] = [];
        for (const target of targets) {
          const deadline = Date.now() + 20000;
          while (!target.output.includes('P011_FIXTURE_PORT ') ||
              !target.output.includes('Debugger listening on ws://')) {
            if (target.child.exitCode !== null || target.child.signalCode !== null || Date.now() > deadline)
              throw Error('Independent request target did not become ready: ' + target.output);
            await wait(50);
          }
          const port = Number(target.output.match(/P011_FIXTURE_PORT (\d+)/)![1]);
          const endpoint = target.output.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+)/)![1];
          target.client = createCdpClient(endpoint); await target.client.connect();
          const before = processSample(target.child.pid!);
          const response = await fetch('http://127.0.0.1:' + port);
          expect(await response.json()).toEqual({ rows: [{ id: 'fixture' }] });
          const requestId = response.headers.get('x-papercusp-request-id')!; requestIds.push(requestId);
          const snapshot = (await target.client.evaluate('(' + requestWorkerSnapshot.toString() + ')(' +
            JSON.stringify([requestId]) + ')', { returnByValue: true })).result.value;
          const counters = await readProcessMemory(target.client, { expectedPid: target.child.pid!, hostFacts: true });
          observations.push({ before, after: processSample(target.child.pid!),
            role: configuredHostRole(counters.hostFacts), snapshot });
          expect(JSON.stringify(snapshot)).not.toContain('privateBody');
        }
        const accepted = auditRequestWorkerAssignments(requestIds, observations.reverse(), build);
        expect(accepted.status).toBe('observed');
        expect(accepted.assignments.map(row => row.pid)).toEqual(targets.map(target => target.child.pid));
        expect(accepted.assignments.map(row => row.queryTuples.length)).toEqual([2, 2]);
        expect(new Set(accepted.assignments.map(row => row.processInstanceId)).size).toBe(2);
      } finally {
        await Promise.all(targets.map(async target => {
          target.client?.close();
          if (target.child.exitCode === null && target.child.signalCode === null) {
            const exited = new Promise<void>(resolve => target.child.once('exit', () => resolve()));
            target.child.kill('SIGTERM'); await Promise.race([exited, wait(3000)]);
            if (target.child.exitCode === null && target.child.signalCode === null) {
              target.child.kill('SIGKILL'); await exited;
            }
          }
          expect(target.child.exitCode === 0 || target.child.signalCode === 'SIGKILL').toBe(true);
        }));
      }
    }, 60000);
  });
  it('binds advertised spawner build to its PID and connection without borrowing disk or main identity', () => {
    const capability = { processExecIdentity: { pid: 7, buildInfo: { sha: 'loaded-source', version: '1.0.0' } },
      processExecFence: { serverGeneration: 'server', connectionId: 'connection' } };
    expect(spawnerLoadedIdentity(7, capability)).toMatchObject({ status: 'known', pid: 7,
      buildInfo: { sha: 'loaded-source' }, serverGeneration: 'server', connectionId: 'connection' });
    expect(spawnerLoadedIdentity(7, {})).toMatchObject({ status: 'unknown' });
    expect(spawnerLoadedIdentity(7, { ...capability,
      processExecIdentity: { pid: 7, buildInfo: { sha: null, version: '1.0.0' } } })).toMatchObject({ status: 'unknown' });
    expect(() => spawnerLoadedIdentity(8, capability)).toThrow('PID mismatch');
    expect(() => spawnerLoadedIdentity(7, { ...capability, processExecFence: {} })).toThrow('Malformed');
    expect(() => spawnerLoadedIdentity(7, { ...capability,
      processExecIdentity: { pid: 7, buildInfo: { sha: ' ', version: '1.0.0' } } })).toThrow('Malformed');
    const before = spawnerLoadedIdentity(7, capability);
    expect(() => assertSpawnerIdentity(before, structuredClone(before))).not.toThrow();
    for (const field of ['pid', 'serverGeneration', 'connectionId', 'status']) {
      expect(() => assertSpawnerIdentity(before, { ...before, [field]: 'changed' })).toThrow('generation changed');
    }
    expect(() => assertSpawnerIdentity(before, { ...before,
      buildInfo: { ...before.buildInfo, sha: 'different' } })).toThrow('generation changed');
  });
  it('keeps PID and exact owner selection outside configurable traversal limits', () => {
    expect(parsePinnedLimits('{"maxDepth":8,"maxEntries":32768,"budgetMs":200}'))
      .toEqual({ maxDepth: 8, maxEntries: 32768, budgetMs: 200 });
    expect(parsePinnedLimits('{"cacheEntryOffset":0,"cacheKeyDigests":["' + 'a'.repeat(64) + '"]}'))
      .toEqual({ cacheEntryOffset: 0, cacheKeyDigests: ['a'.repeat(64)] });
    for (const raw of ['{"expectedPid":7}', '{"owners":["other"]}', '[]', 'null',
      '{"operatorCacheEntries":true}', '{"maxDepth":0}', '{"budgetMs":"200"}',
      '{"cacheEntryOffset":-1}', '{"cacheKeyDigests":["private-key"]}']) {
      expect(() => parsePinnedLimits(raw)).toThrow('only positive integer reader limits');
    }
  });

  it('rejects reader caps and incompatible selection in preflight before any target interaction', () => {
    const caps = { maxSlots: 512, maxObjects: 16384, maxEntries: 32768, maxFields: 64,
      maxDepth: 8, budgetMs: 200, maxCacheEntries: 256, maxEntryEntries: 32768,
      maxEntryObjects: 16384, maxKeyCodeUnits: 65536, cacheEntryOffset: 32768 };
    for (const [name, cap] of Object.entries(caps)) {
      expect(() => parsePinnedLimits(JSON.stringify({ [name]: cap }))).not.toThrow();
      expect(() => parsePinnedLimits(JSON.stringify({ [name]: cap + 1 }))).toThrow('invalid pinned-state');
    }
    expect(() => parsePinnedLimits(JSON.stringify({ maxFields: 256 }))).toThrow('invalid pinned-state');
    expect(() => validatePinnedStateOptions({ expectedPid: 7, cacheEntryOffset: 1 })).toThrow('invalid pinned-state');
    expect(() => parsePinnedLimits(JSON.stringify({ cacheKeyDigests: ['a'.repeat(64)], cacheEntryOffset: 1 })))
      .toThrow('invalid pinned-state');
  });

  it('rejects PID reuse and changed executable before accepting a resource comparison', () => {
    const before = { pid: 7, startTicks: '12', executableSha256: 'a' };
    expect(() => assertIdentity(before, { ...before, startTicks: '13' })).toThrow('identity changed');
    expect(() => assertIdentity(before, { ...before, executableSha256: 'b' })).toThrow('identity changed');
  });

  it('parses the Node entry without accepting host paths hidden in options or application arguments', () => {
    expect(nodeEntry(['/node', '--inspect=127.0.0.1:0', '--require', '/hook.mjs',
      '--enable-source-maps', './hono-host.mjs', '--user-arg'], '/runtime')).toBe('/runtime/hono-host.mjs');
    expect(nodeEntry(['/node', './other.mjs', '/runtime/hono-host.mjs'], '/runtime')).toBe('/runtime/other.mjs');
    expect(nodeEntry(['/node', '--', './hono-host.mjs'], '/runtime')).toBe('/runtime/hono-host.mjs');
    for (const argv of [['/node', '--eval', '/runtime/hono-host.mjs'], ['/node', '--require'],
      ['/node', '--unknown-option', '/runtime/hono-host.mjs'], ['/node', '--']]) {
      expect(nodeEntry(argv, '/runtime')).toBeNull();
    }
  });

  it('requires both native executable identity and an exact esbuild service argument', () => {
    expect(processCommand(['/native/esbuild', '--service=0.27.3', '--ping'], '/runtime',
      '/native/esbuild').esbuildService).toBe(true);
    for (const [exe, args] of [
      ['/native/node', ['--service=0.27.3']],
      ['/native/esbuild', ['--service=unverified']],
      ['/native/esbuild', ['--other=--service=0.27.3']],
      ['/native/esbuild', ['--service=0.27.3-suffix']],
      ['/native/esbuild-helper', ['--service=0.27.3']],
    ] as [string, string[]][]) {
      expect(processCommand([exe, ...args], '/runtime', exe).esbuildService).toBe(false);
    }
  });

  it('requires exact entry, executable and ancestry for a descendant role and keeps native ownership unknown', () => {
    const main = { pid: 1, parentPid: 0, startTicks: '1', executable: '/node',
      executableSha256: 'a', command: { script: '/runtime/hono-host.mjs', sha256: 'x', esbuildService: false },
      pssBytes: 100, rssBytes: 200, anonymousBytes: 80 };
    const child = { ...main, pid: 2, parentPid: 1, startTicks: '2', pssBytes: 50 };
    const compiler = { ...child, pid: 3, parentPid: 2, executableSha256: 'b',
      command: { ...child.command, script: null, esbuildService: true }, pssBytes: 25 };
    const inventory = processInventory(main, [child, compiler], []);
    expect(inventory.observed.map(row => row.role))
      .toEqual(['named-main', 'same-entry-operator-descendant', 'native-esbuild-service']);
    expect(inventory.observedPssBytes).toBe(175);
    expect(inventory.allocationOwner).toBe('unknown');
    expect(inventory.compilerCaller).toBe('unknown');
    expect(inventory.workerRequestAssignment).toBe('unknown');
    for (const decoy of [{ ...child, executableSha256: 'different' },
      { ...child, command: { ...child.command, script: '/other/hono-host.mjs' } }]) {
      expect(processInventory(main, [decoy], []).observed[1].role).toBe('other-descendant');
    }
    expect(() => processInventory(main, [{ ...child, parentPid: 99 }], [])).toThrow('ancestry');
    expect(() => processInventory(main, [child, { ...compiler, parentPid: 3 }], [])).toThrow('ancestry');
    expect(() => processInventory(main, [child, child], [])).toThrow('Duplicate');
  });

  it('preserves capped or raced census residue and distinguishes PID reuse from proven exit', () => {
    const main = { pid: 1, parentPid: 0, startTicks: '1', executable: '/node',
      executableSha256: 'a', command: { script: '/runtime/hono-host.mjs', sha256: 'x', esbuildService: false },
      pssBytes: 100, rssBytes: 200, anonymousBytes: 80 };
    const oldChild = { ...main, pid: 2, parentPid: 1, startTicks: '2' };
    const newChild = { ...oldChild, startTicks: '3' };
    const missed = [{ pid: 4, parentPid: 1, reason: 'cap' }, { pid: 5, parentPid: 1, reason: 'read-race-or-unavailable' }];
    const inventory = processInventory(main, [newChild], missed, [main, oldChild]);
    expect(inventory.censusComplete).toBe(false);
    expect(inventory.notChecked).toEqual(missed);
    expect(inventory.appeared).toEqual([{ pid: 2, startTicks: '3' }]);
    expect(inventory.notObservedSincePrevious).toEqual([{ pid: 2, startTicks: '2' }]);
    expect(inventory.lifetimeDefinition).toContain('not proof of exit');
  });

  it('selects counter targets only through checked exact-entry ancestry', () => {
    const main = { pid: 1, parentPid: 0, startTicks: '1', executable: '/node', executableSha256: 'a',
      command: { script: '/runtime/hono-host.mjs', sha256: 'x', esbuildService: false },
      pssBytes: 100, rssBytes: 200, anonymousBytes: 80 };
    const wrapper = { ...main, pid: 2, parentPid: 1, command: { ...main.command, script: '/wrapper.mjs' } };
    const child = { ...main, pid: 3, parentPid: 2 };
    expect(counterTarget(main, [wrapper, child], 3)).toBe(child);
    expect(counterTarget(main, [], 1)).toBe(main);
    for (const rows of [[wrapper], [wrapper, { ...child, executableSha256: 'b' }],
      [wrapper, { ...child, command: { ...child.command, script: '/other/hono-host.mjs' } }]]) {
      expect(() => counterTarget(main, rows, 3)).toThrow('Counter target');
    }
    expect(() => counterTarget(main, [child], 3)).toThrow('ancestry');
  });

  it('binds standalone counters to the exact maintained sibling, executable, ancestry and configured role', () => {
    const main = { pid: 1, parentPid: 0, startTicks: '1', executable: '/node', executableSha256: 'a',
      command: { script: '/runtime/hono-host.mjs', sha256: 'x', esbuildService: false },
      pssBytes: 100, rssBytes: 200, anonymousBytes: 80 };
    const spawner = { ...main, pid: 2, parentPid: 1, startTicks: '2',
      command: { ...main.command, script: '/runtime/spawner-sidecar.mjs' } };
    const child = { ...spawner, pid: 3, parentPid: 2, startTicks: '3' };
    const facts = { cluster: { isPrimary: true, isWorker: false }, backgroundWorkersOverride: 'disabled',
      stagingPort: false, sidecarFlags: { substrate: false, spawner: true, gateway: false, embed: false, resourceHealth: false } };
    expect(counterTarget(main, [spawner, child], 3)).toBe(child);
    expect(processInventory(main, [spawner, child], []).observed.map(row => row.role))
      .toEqual(['named-main', 'maintained-spawner-descendant', 'maintained-spawner-descendant']);
    expect(assertCounterRole(main, child, facts)).toMatchObject({ configuredSidecar: 'spawner', allocationOwner: 'unknown' });
    expect(() => assertCounterRole(main, child, { ...facts, sidecarFlags: { ...facts.sidecarFlags, spawner: false } }))
      .toThrow('configured spawner role');
    for (const decoy of [{ ...child, executableSha256: 'other' },
      { ...child, command: { ...child.command, script: '/other/spawner-sidecar.mjs' } },
      { ...child, command: { ...child.command, script: '/runtime/spawner-sidecar.mjs.backup' } }]) {
      expect(() => counterTarget(main, [spawner, decoy], 3)).toThrow('Counter target');
    }
    expect(() => counterTarget(main, [child], 3)).toThrow('ancestry');
    expect(() => assertIdentity(child, { ...child, startTicks: 'reused' })).toThrow('identity changed');
  });

  it('distinguishes request-only primaries, actual cluster workers and configured sidecars without assigning requests', () => {
    const facts = { cluster: { isPrimary: true, isWorker: false }, backgroundWorkersOverride: 'unset',
      stagingPort: true, sidecarFlags: { substrate: false, spawner: false, gateway: false, embed: false, resourceHealth: false } };
    expect(configuredHostRole(facts)).toEqual({ clusterRole: 'primary', requestOnly: true,
      configuredSidecar: null, requestAssignment: 'unknown', allocationOwner: 'unknown' });
    expect(configuredHostRole({ ...facts, backgroundWorkersOverride: 'enabled' }).requestOnly).toBe(false);
    expect(configuredHostRole({ ...facts, stagingPort: false }).requestOnly).toBe(false);
    expect(configuredHostRole({ ...facts, stagingPort: false, backgroundWorkersOverride: 'disabled',
      cluster: { isPrimary: false, isWorker: true } })).toMatchObject({ clusterRole: 'worker', requestOnly: true });
    expect(configuredHostRole({ ...facts, sidecarFlags: { ...facts.sidecarFlags, spawner: true } }))
      .toMatchObject({ configuredSidecar: 'spawner', clusterRole: 'primary', requestAssignment: 'unknown' });
    expect(() => configuredHostRole({ ...facts, cluster: { isPrimary: true, isWorker: true } })).toThrow('Incomplete');
    expect(() => configuredHostRole({ ...facts, sidecarFlags: {} })).toThrow('Incomplete');
  });

  it('rejects stale, incomplete and private discovery selections before claiming payload coverage', () => {
    const a = 'a'.repeat(64), b = 'b'.repeat(64), other = 'c'.repeat(64);
    const page = { status: 'map', undigestibleKeys: 0,
      selection: { selectedNotChecked: 0, nextOffset: null },
      values: [{ toolNamespace: 'coord:inbox', keyDigest: a, stringCodeUnits: 20 },
        { toolNamespace: 'coord:inbox', keyDigest: b, stringCodeUnits: 30 },
        { toolNamespace: 'plans:get', keyDigest: other, stringCodeUnits: 100 }] };
    expect(parseDiscoveryNamespace('coord:inbox')).toBe('coord:inbox');
    for (const raw of ['private|argument', '', 'jev-memory:' + a]) {
      expect(() => parseDiscoveryNamespace(raw)).toThrow('exact tool namespace');
    }
    expect(() => parseDiscoveryNamespace('coord:inbox', { cacheKeyDigests: [a] })).toThrow('no prior selection');
    expect(selectDiscoveredDigests([page], 'coord:inbox')).toEqual([b, a]);
    expect(() => selectDiscoveredDigests([page], 'work_items:list')).toThrow('No matching');
    expect(() => selectDiscoveredDigests([{ ...page, undigestibleKeys: 1 }], 'coord:inbox')).toThrow('Incomplete');
    expect(() => selectDiscoveredDigests([{ ...page, selection: { ...page.selection, nextOffset: 256 } }],
      'coord:inbox')).toThrow('Incomplete');
    expect(() => selectDiscoveredDigests([{ ...page, values: [{ ...page.values[0], keyDigest: 'private' }] }],
      'coord:inbox')).toThrow('Undigestible');
    const matched = { status: 'map', checked: 2,
      selection: { selectedNotChecked: 0, unresolvedKeyDigests: [] }, values: [{ keyDigest: a }, { keyDigest: b }] };
    expect(() => assertCacheSelection(matched, [a, b])).not.toThrow();
    expect(() => assertCacheSelection({ ...matched, checked: 0, values: [] }, [a, b])).toThrow('match exactly');
    expect(() => assertCacheSelection({ ...matched, values: [{ keyDigest: a }, { keyDigest: other }] },
      [a, b])).toThrow('match exactly');
  });

  it.runIf(Boolean(process.env.PAPERCUSP_P011_LIVE_PID))('measures unforced live idle and ordinary HTTP windows on the named staging process', async () => {
    const pid = Number(process.env.PAPERCUSP_P011_LIVE_PID);
    const counterPids = parseCounterPids(process.env.PAPERCUSP_P011_COUNTER_PID, pid);
    const counterPid = counterPids[0];
    const base = process.env.PAPERCUSP_P011_LIVE_URL;
    const expectedBuild = process.env.PAPERCUSP_P011_LIVE_BUILD;
    const destination = process.env.PAPERCUSP_P011_REPORT;
    const pinnedOwners = process.env.PAPERCUSP_P011_PINNED_OWNERS
      ? JSON.parse(process.env.PAPERCUSP_P011_PINNED_OWNERS) : undefined;
    const pinnedLimits = parsePinnedLimits(process.env.PAPERCUSP_P011_PINNED_LIMITS);
    const discoveryNamespace = parseDiscoveryNamespace(process.env.PAPERCUSP_P011_CACHE_DISCOVERY_NAMESPACE, pinnedLimits);
    const operatorCacheEntries = process.env.PAPERCUSP_P011_CACHE_ENTRIES === '1';
    if (discoveryNamespace && !operatorCacheEntries) throw Error('Cache discovery requires cache-entry attribution');
    if (operatorCacheEntries && (!process.env.PAPERCUSP_P011_PINNED_STATE ||
        pinnedOwners?.length !== 1 || pinnedOwners[0] !== '@papercusp/operator-core.operatorCache')) {
      throw Error('Cache-entry attribution requires the exact operator-cache owner');
    }
    if (pinnedOwners !== undefined && (!Array.isArray(pinnedOwners) || pinnedOwners.length < 1 ||
        pinnedOwners.some(owner => typeof owner !== 'string'))) throw Error('Exact pinned owners must be a nonempty string array');
    if (process.env.PAPERCUSP_P011_PINNED_STATE) validatePinnedStateOptions({
      ...pinnedLimits, expectedPid: pid, owners: pinnedOwners, operatorCacheEntries,
    });
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(Number.isInteger(counterPid) && counterPid > 0).toBe(true);
    expect(base).toBe('http://127.0.0.1:3170');
    expect(expectedBuild).toMatch(/^[a-f0-9]{7,40}$/);
    if (!destination || !existsSync(dirname(resolve(root, destination)))) throw Error('Canonical evidence parent required');
    const path = resolve(root, destination);
    const before = processSample(pid);
    // Check only the selected target's ancestry before opening its inspector;
    // unrelated deep utility subtrees cannot turn valid selection into a cap.
    const counterTargets = selectCounterTargets(before, counterPids);
    const counterBefore = counterTargets[0];
    const report: any = { schemaVersion: 1, plane: 'live-current-build-operator-api',
      incomplete: true, pid, counterPid, counterPids, buildSha: expectedBuild, startedAt: new Date().toISOString(),
      samples: [], windows: [], requests: [], operations: [], cleanup: {},
      metricDefinitions: { pssBytes: 'smaps_rollup Pss kernel kB times 1024',
        heapAndNative: 'V8/Node counters, overlapping with PSS; no additive native-residual estimate',
        heapSpaces: 'V8 getHeapSpaceStatistics per-space bytes; space membership can change across GC',
        heapCode: 'V8 getHeapCodeStatistics bytes; code/source counters overlap heap/external and do not identify retainers',
        pinnedState: 'Reachable logical payloads under named roots; not total retained heap/native bytes',
        observerMs: 'wall time for inspector counter read and proc descendant census' },
      limits: { windows: 3, idleMs: 2000, requestsPerWindow: 8, concurrency: 2, descendantsPerSample: 64 },
      pinnedOwners, pinnedLimits, operatorCacheEntries,
      limitations: ['Legacy samples cover the first explicitly selected PID; requestWorkerWindows bracket each selected request-only PID. Unsampled workers remain unknown.',
        'Ambient workload is uncontrolled; idle means no probe HTTP requests.',
        'No paired intervention, allocation profiler, retainer graph or physical-savings claim.',
        'Sibling build identity is read from its PID-bound server capability when available; missing advertisements stay unknown.',
        'Current disk bundle hash is recorded separately from the health-reported loaded build.'] };
    const publish = () => writeFileSync(path, serializeIdentitySafeJson(report));
    let client: ReturnType<typeof createCdpClient> | undefined;
    const inspectorLeases: InspectorLease[] = [];
    let spawnerIpc: SpawnerIpcClient | undefined;
    let spawnerSocket: string | undefined;
    const health = async () => {
      const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(10000) });
      expect(response.status).toBe(200);
      const value = await response.json();
      expect(value.sha).toBe(expectedBuild);
      expect(value.bundleStale).toBeUndefined();
      assertIdentity(before, processSample(pid));
      for (const target of counterTargets) assertInspectorTarget(target, processSample(target.pid));
      return { sha: value.sha, version: value.version, at: new Date().toISOString() };
    };
    publish();
    try {
      report.healthBefore = await health();
      expect(listenerPorts(pid)).toContain(3170);
      const entry = before.command.script;
      if (!entry) throw Error('Serving bundle entry unobserved');
      const bundlePath = entry;
      report.bundle = { path: bundlePath, argvEntry: entry, diskSha256: hash(readFileSync(bundlePath)) };
      const counterEntry = counterBefore.command.script;
      if (!counterEntry) throw Error('Counter bundle entry unobserved');
      report.counterBundle = { path: counterEntry, argvEntry: counterEntry,
        diskSha256: hash(readFileSync(counterEntry)), loadedBuild: 'unknown',
        role: counterPid === pid ? 'named-main' : descendantEntryRole(before, counterBefore) };
      await acquireTargetInspectors(counterTargets, inspectorLeases);
      client = inspectorLeases[0].connection!.client;
      report.inspectors = inspectorLeases.map(lease => ({ pid: lease.target.pid,
        port: lease.connection!.port, openedByProbe: lease.openedByProbe }));
      report.inspector = report.inspectors[0]; report.inspectorWasOpen = !inspectorLeases[0].openedByProbe;
      report.targetBundles = counterTargets.map(target => ({ pid: target.pid, startTicks: target.startTicks,
        executableSha256: target.executableSha256, path: target.command.script,
        diskSha256: hash(readFileSync(target.command.script!)) }));
      if (descendantEntryRole(before, counterBefore) === 'maintained-spawner-descendant') {
        // Read only the loaded process's configured socket. Import the IPC
        // client into this observer, never build-info into the inspected target.
        const configured = await client.evaluate('process.env.PAPERCUSP_SPAWNER_IPC_SOCKET ?? null', { returnByValue: true });
        const socketPath = configured?.result?.value;
        if (typeof socketPath !== 'string' || !socketPath.startsWith('/')) throw Error('Loaded spawner socket unavailable');
        spawnerSocket = socketPath;
        const socket = statSync(socketPath);
        if (!socket.isSocket()) throw Error('Loaded spawner endpoint is not a socket');
        report.counterBundle.socketBefore = { dev: socket.dev, ino: socket.ino };
        spawnerIpc = new SpawnerIpcClient(socketPath);
        const capability = await spawnerIpc.call('spawn:cancel', {}, { timeoutMs: 5000 });
        report.counterBundle.loadedBuild = spawnerLoadedIdentity(counterPid, capability);
        assertIdentity(counterBefore, processSample(counterPid));
        if (process.env.PAPERCUSP_P011_SPAWNER_BUILD) {
          expect(report.counterBundle.loadedBuild.status).toBe('known');
          expect(report.counterBundle.loadedBuild.buildInfo.sha).toBe(process.env.PAPERCUSP_P011_SPAWNER_BUILD);
        }
        publish();
      }
      let effectivePinnedLimits = pinnedLimits;
      if (discoveryNamespace) {
        const pages: any[] = [];
        let offset = 0;
        for (let page = 0; page < 2; page++) {
          const discovery = await readPinnedState(client, { ...pinnedLimits, expectedPid: counterPid,
            owners: pinnedOwners, operatorCacheEntries, maxCacheEntries: 256,
            maxEntryEntries: 128, maxEntryObjects: 64, cacheEntryOffset: offset });
          assertIdentity(before, processSample(pid));
          const cache = discovery.roots[0]?.cacheEntries;
          if (!cache) throw Error('Cache discovery root unavailable');
          pages.push(cache);
          report.cacheDiscovery = { namespace: discoveryNamespace, pages,
            definition: 'At most two bounded insertion-order pages on the same PID; membership can change between pages. Ranking uses visited logical strings, not physical bytes.' };
          publish();
          if (cache.selection.nextOffset === null) break;
          offset = cache.selection.nextOffset;
        }
        const selectedKeyDigests = selectDiscoveredDigests(pages, discoveryNamespace);
        effectivePinnedLimits = { ...pinnedLimits, maxCacheEntries: selectedKeyDigests.length, cacheKeyDigests: selectedKeyDigests };
        report.cacheDiscovery.selectedKeyDigests = selectedKeyDigests;
        report.effectivePinnedLimits = effectivePinnedLimits;
        publish();
      }
      let remainingDescendants = 64;
      let missedDescendants: { pid: number; parentPid: number; reason: string }[] = [];
      let previousProcesses: ResourceRow[] = [];
      const descendants = (parent: number): ReturnType<typeof processSample>[] => {
        const children = readFileSync(`/proc/${parent}/task/${parent}/children`, 'utf8').trim();
        return (children ? children.split(/\s+/).map(Number) : []).flatMap(child => {
          if (remainingDescendants <= 0) {
            report.descendantCappedSamples = (report.descendantCappedSamples || 0) + 1;
            missedDescendants.push({ pid: child, parentPid: parent, reason: 'cap' }); return [];
          }
          remainingDescendants--;
          let row: ResourceRow;
          try {
            row = processSample(child);
            if (row.parentPid !== parent) throw Error('Descendant parent changed');
          } catch {
            report.descendantExitRaces = (report.descendantExitRaces || 0) + 1;
            missedDescendants.push({ pid: child, parentPid: parent, reason: 'read-race-or-unavailable' }); return [];
          }
          // Preserve a checked parent's resource row even if listing its own
          // children races; otherwise the aggregate silently drops known PSS.
          let nested: ResourceRow[] = [];
          try { nested = descendants(child); }
          catch { missedDescendants.push({ pid: child, parentPid: parent, reason: 'children-list-unavailable' }); }
          return [row, ...nested];
        });
      };
      const workerReader: WorkerWindowReader = {
        census: () => {
          remainingDescendants = 64; missedDescendants = [];
          const main = processSample(pid); assertIdentity(before, main);
          return { main, descendants: descendants(pid), notChecked: missedDescendants };
        },
        read: (pid, ids) => readRequestWorkerResources(inspectorLeases.find(lease => lease.target.pid === pid)!.connection!.client, pid, ids),
      };
      const targetRoles = await Promise.all(inspectorLeases.map(async lease => {
        assertInspectorTarget(lease.target, processSample(lease.target.pid));
        const counters = await readProcessMemory(lease.connection!.client, { expectedPid: lease.target.pid, hostFacts: true });
        assertInspectorTarget(lease.target, processSample(lease.target.pid));
        return assertCounterRole(before, lease.target, counters.hostFacts);
      }));
      const workerWindowEnabled = targetRoles.every(role => role.configuredSidecar === null && role.requestOnly);
      if (counterTargets.length > 1 && !workerWindowEnabled) throw Error('Multiple counter targets require identified request-only workers');
      const sample = async (label: string) => {
        const started = performance.now();
        const memory = await readProcessMemory(client!, { expectedPid: counterPid, hostFacts: true, allocationDetails: true });
        const pinnedState = process.env.PAPERCUSP_P011_PINNED_STATE ? await readPinnedState(client!, {
          ...effectivePinnedLimits,
          expectedPid: counterPid, owners: pinnedOwners, operatorCacheEntries,
        }) : undefined;
        if (effectivePinnedLimits?.cacheKeyDigests) assertCacheSelection(pinnedState!.roots[0].cacheEntries,
          effectivePinnedLimits!.cacheKeyDigests!);
        const os = processSample(pid); assertIdentity(before, os);
        remainingDescendants = 64;
        missedDescendants = [];
        const childRows = descendants(pid);
        const inventory = processInventory(os, childRows, missedDescendants, previousProcesses);
        const counterOs = counterTarget(os, childRows, counterPid);
        assertIdentity(counterBefore, counterOs);
        previousProcesses = [os, ...childRows];
        report.samples.push({ label, at: new Date().toISOString(), ...memory, os, counterOs,
          configuredHostRole: assertCounterRole(before, counterOs, memory.hostFacts), pinnedState,
          descendants: childRows, inventory, observerMs: performance.now() - started }); publish();
        expect(memory.heapSpaces.length).toBeGreaterThan(0);
        expect(memory.heapSpaces.every((space: any) => typeof space.space_name === 'string' &&
          Number.isFinite(space.space_used_size) && space.space_used_size >= 0)).toBe(true);
        expect(Number.isFinite(memory.heapCode.code_and_metadata_size)).toBe(true);
      };
      const query = '/api/zero-harness/rest-query?name=workItems.byHarness&args=' +
        encodeURIComponent(JSON.stringify({ harnessSlug: 'papercusp', limit: 32 }));
      for (let window = 0; window < 3; window++) {
        await sample(`idle-${window}-start`); await wait(2000); await sample(`idle-${window}-end`);
        const startedAt = new Date().toISOString();
        const workload = async (observe?: (ids: string[]) => Promise<void>) => {
          for (let pair = 0; pair < 4; pair++) {
            await captureWorkloadRequestPair({
              report, window, pair, observe, publish,
              fetchRequest: () => fetch(base + query, {
                headers: { 'x-papercusp-workspace': 'papercusp-workspace' },
                signal: AbortSignal.timeout(15000),
              }),
            });
          }
          return report.requests.filter((row: any) => row.window === window).map((row: any) => row.requestId);
        };
        const workerWindow = workerWindowEnabled
          ? await collectRequestWorkerWindow(counterTargets, expectedBuild!, { ...workerReader,
            record: (stage, value) => {
              const attempts = (report.requestWorkerWindowAttempts ??= []);
              const attempt = (attempts[window] ??= { window, incomplete: true });
              attempt[stage] = value; attempt.stage = stage;
              if (stage === 'assignment') attempt.incomplete = false;
              publish();
            } }, workload) : undefined;
        if (!workerWindow) await workload();
        else (report.requestWorkerWindows ??= []).push({ window, ...workerWindow });
        await sample(`ordinary-${window}-end`);
        const requestIds = report.requests.filter((row: any) => row.window === window).map((row: any) => row.requestId);
        const ordinary = report.samples.at(-1);
        const assignmentStarted = performance.now();
        let assignment;
        if (workerWindow) assignment = workerWindow.assignment;
        else if (ordinary.configuredHostRole.configuredSidecar !== null) {
          assignment = { status: 'unknown', reason: 'Selected counter target is a sidecar, not a request worker',
            requested: requestIds.length, assignments: [], unresolvedRequestIds: requestIds };
        } else {
          const assignmentBefore = processSample(counterPid); assertIdentity(counterBefore, assignmentBefore);
          const assignmentRead = await client!.evaluate('(' + requestWorkerSnapshot.toString() + ')(' +
            JSON.stringify(requestIds.filter((id: unknown) => typeof id === 'string')) + ')', { returnByValue: true });
          if (!assignmentRead?.result?.value) throw Error('Request-worker inspector snapshot unavailable');
          assignment = auditRequestWorkerAssignments(requestIds, [{ before: assignmentBefore,
            after: processSample(counterPid), role: ordinary.configuredHostRole,
            snapshot: assignmentRead.result.value }], expectedBuild!);
        }
        (report.requestWorkerAssignments ??= []).push({ window, ...assignment,
          observerMs: performance.now() - assignmentStarted });
        report.windows.push({ window, startedAt, endedAt: new Date().toISOString() }); publish();
        await health();
      }
      report.healthAfter = await health();
      report.bundle.diskSha256After = hash(readFileSync(bundlePath));
      expect(report.bundle.diskSha256After).toBe(report.bundle.diskSha256);
      report.counterBundle.diskSha256After = hash(readFileSync(counterEntry));
      expect(report.counterBundle.diskSha256After).toBe(report.counterBundle.diskSha256);
      for (const target of report.targetBundles) {
        target.diskSha256After = hash(readFileSync(target.path));
        expect(target.diskSha256After).toBe(target.diskSha256);
      }
      if (spawnerIpc && spawnerSocket) {
        const capability = await spawnerIpc.call('spawn:cancel', {}, { timeoutMs: 5000 });
        report.counterBundle.loadedBuildAfter = spawnerLoadedIdentity(counterPid, capability);
        assertSpawnerIdentity(report.counterBundle.loadedBuild, report.counterBundle.loadedBuildAfter);
        const socket = statSync(spawnerSocket);
        report.counterBundle.socketAfter = { dev: socket.dev, ino: socket.ino };
        expect(socket.isSocket()).toBe(true);
        expect(report.counterBundle.socketAfter).toEqual(report.counterBundle.socketBefore);
      }
      expect(report.samples).toHaveLength(9); expect(report.requests).toHaveLength(24);
      expect(report.samples.every((row: any) => row.os.pssBytes > 0 && row.memory.heapUsed > 0)).toBe(true);
      if (process.env.PAPERCUSP_P011_PINNED_STATE) expect(report.samples.every((row: any) =>
        row.pinnedState.pid === counterPid && row.pinnedState.registryPresent &&
        row.pinnedState.population >= row.pinnedState.checked && row.pinnedState.checked > 0)).toBe(true);
      if (pinnedOwners) expect(report.samples.every((row: any) =>
        row.pinnedState.selection?.missingOwners.length === 0 &&
        row.pinnedState.selection?.selectedNotChecked === 0 &&
        row.pinnedState.checked === pinnedOwners.length)).toBe(true);
      if (operatorCacheEntries) expect(report.samples.every((row: any) => {
        const cache = row.pinnedState.roots[0].cacheEntries;
        return cache?.status === 'map' && cache.population === cache.checked + cache.notChecked &&
          cache.values.every((value: any) => (value.keyDigest === null || /^[a-f0-9]{64}$/.test(value.keyDigest)) &&
            value.entries <= row.pinnedState.limits.maxEntryEntries &&
            value.objects <= row.pinnedState.limits.maxEntryObjects);
      })).toBe(true);
      report.incomplete = false;
    } catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error; }
    finally {
      spawnerIpc?.close();
      try {
        report.cleanup.inspectors = await releaseTargetInspectors(inspectorLeases);
        report.cleanup.inspector = report.cleanup.inspectors.find((row: any) => row.pid === counterPid)?.result;
        const errors = report.cleanup.inspectors.filter((row: any) => row.error);
        if (errors.length) throw Error(errors.map((row: any) => `${row.pid}: ${row.error}`).join('; '));
        assertIdentity(before, processSample(pid)); report.cleanup.processIdentityPreserved = true;
        assertIdentity(counterBefore, processSample(counterPid)); report.cleanup.counterIdentityPreserved = true;
      } catch (error) {
        report.cleanup.error = String(error); report.incomplete = true;
        throw Error((report.error ? 'Original sampler error: ' + report.error + '; ' : '') + 'Cleanup error: ' + String(error));
      }
      finally { report.endedAt = new Date().toISOString(); publish(); }
    }
    expect(report.cleanup.processIdentityPreserved).toBe(true);
    expect(report.cleanup.counterIdentityPreserved).toBe(true);
    expect(report.operations).toEqual([]);
  }, 100_000);
});
