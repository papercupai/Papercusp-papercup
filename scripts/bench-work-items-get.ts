/**
 * Live small-summary cohort for BYOC R-003. Uses the maintained, attributed MCP
 * recovery client; each sample includes process startup and complete response parsing.
 * This measures summary reads only, not stalled-write isolation or deployed acceptance.
 *
 * PAPERCUSP_SID and PAPERCUSP_WORKSPACE must identify the calling session.
 * Usage: npx tsx scripts/bench-work-items-get.ts --port=3170 --ids=WI-1,WI-2
 */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, open, readFile, readdir, realpath, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isCliEntry } from '../packages/operator-core/lib/util/cli-entry';
import { collectPerfWorkloadRun, type PerfWorkloadManifest, type PerfWorkloadRunDependencies, type PerfWorkloadRunPlan } from '../packages/operator-core/lib/system-health/perf-workload-run';
import { perfProtocolHash } from '../packages/operator-core/lib/system-health/perf-workload-protocol';
import { AgentMcpConnectionError, connectAgentMcp } from '../packages/operator-core/lib/agent-mcp-client';
import { linuxPgrpFromProcStat, linuxStartTicksFromProcStat, readProcessIdentity } from '../packages/operator-core/lib/process-identity';
import { readVerifierSourceReceiptSync } from '../packages/operator-core/lib/verifier-source';
import { buildMcpCallParams, buildMcpSessionQuery, resolveMcpCallOrigin, resolveMcpRole, superuserTokenPaths } from './mcp-call.mjs';
import { readNativeProcessTraceArtifacts } from './lib/budgeted-task-scheduler.mjs';
import { captureConfigurationSnapshot } from '../libs/test-config/src/configuration-snapshot';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let execMemo: typeof execFile.__promisify__ | null = null;
const exec = ((...args: unknown[]) =>
  Reflect.apply((execMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;
const SOURCE_PATHS = [
  'packages/operator-core/lib/agent-tools/work_items/get.ts',
  'packages/operator-core/lib/agent-tools/work_items/get-shape.ts',
  'scripts/mcp-call.mjs',
  'scripts/bench-work-items-get.ts',
  'packages/operator-core/lib/agent-mcp-client.ts',
  'packages/operator-core/lib/system-health/perf-workload-run.ts',
  'packages/operator-core/lib/system-health/perf-workload-protocol.ts',
  'packages/operator-core/lib/process-identity.ts',
  'packages/operator-core/test/private-http-workspace-preflight.ts',
] as const;
const PICK = ['ok', 'results[].id', 'results[].availability', 'results[].ok',
  'results[].workItem.id', 'results[].workItem.state', 'counts', 'read'];

export interface Sample {
  size: number;
  repeat: number;
  wallMs: number;
  valid: boolean;
  failures: string[];
  read: unknown;
}

export function validateSummary(result: any, ids: string[]): string[] {
  const failures: string[] = [];
  const rows = Array.isArray(result?.results) ? result.results : [];
  if (result?.ok !== true || result?.counts?.ok !== ids.length || result?.counts?.failed !== 0) {
    failures.push('successful authoritative counts missing');
  }
  if (rows.length !== ids.length || new Set(rows.map((row: any) => row.id)).size !== ids.length) {
    failures.push('requested row census differs');
  }
  for (const id of ids) {
    const row = rows.find((entry: any) => entry.id === id);
    if (row?.ok !== true || row?.availability !== 'available' || row?.workItem?.id !== id ||
        typeof row?.workItem?.state !== 'string' || !row.workItem.state) {
      failures.push(`missing or unavailable identity/state: ${id}`);
    }
  }
  const read = result?.read;
  if (read?.schemaVersion !== 'work-items-get-read-v1' || read?.mode !== 'projected' ||
      read?.requested !== ids.length || read?.available !== ids.length || read?.absent !== 0 ||
      read?.unavailable !== 0 || typeof read?.elapsedMs !== 'number' ||
      !Number.isFinite(read.elapsedMs) || read.elapsedMs < 0 || !read?.outerStageAttribution) {
    failures.push('top-level availability/timing disclosure missing');
  }
  return failures;
}

export function judgeSamples(samples: Sample[], sizes: number, repeats: number, limitMs = 2_000) {
  const complete = samples.length === sizes * repeats && Array.from({ length: sizes }, (_, i) => i + 1)
    .every(size => Array.from({ length: repeats }, (_, repeat) => repeat + 1)
      .every(repeat => samples.filter(sample => sample.size === size && sample.repeat === repeat).length === 1));
  const timings = samples.map(sample => sample.wallMs).sort((a, b) => a - b);
  const timingValid = timings.every(value => Number.isFinite(value) && value >= 0);
  const p95Ms = timings.length && timingValid ? timings[Math.ceil(timings.length * .95) - 1]! : null;
  return { complete, p95Ms, limitMs, passed: complete && timingValid && p95Ms !== null &&
    p95Ms <= limitMs && samples.every(sample => sample.valid && sample.failures.length === 0) };
}

function sourceHashes() {
  return Object.fromEntries(SOURCE_PATHS.map(path =>
    [path, createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex')]));
}

/** Reuse the independently selected archive's complete source verification.
 * This identifies source bytes only; it supplies no observed import, config,
 * dependency, schema or environment evidence for committed-reader preparation.
 */
export function identitySelectedSource(root: string, env: NodeJS.ProcessEnv,
  loadedSha?: unknown) {
  const receiptPath = env.VERIFY_TAURI_SOURCE_RECEIPT;
  if (!receiptPath) {
    if (env.VERIFY_TAURI_SOURCE_REF || existsSync(resolve(root, '.verifier-source.json')))
      throw new Error('independent selected source receipt required');
    return null;
  }
  if (!isAbsolute(receiptPath) || !/^[a-f0-9]{40}$/.test(env.VERIFY_TAURI_SOURCE_REF ?? ''))
    throw new Error('exact selected source reference required');
  const before = readFileSync(receiptPath);
  const source = readVerifierSourceReceiptSync(root, receiptPath);
  if (source.sourceCommit !== env.VERIFY_TAURI_SOURCE_REF)
    throw new Error('selected source reference differs');
  if (loadedSha !== undefined && (typeof loadedSha !== 'string' ||
      !/^[a-f0-9]{7,40}$/.test(loadedSha) || !source.sourceCommit.startsWith(loadedSha)))
    throw new Error('loaded source differs from selected archive');
  if (!before.equals(readFileSync(receiptPath))) throw new Error('selected source receipt changed');
  return { sourceCommit: source.sourceCommit,
    receipt: { path: realpathSync(receiptPath), sha256: createHash('sha256').update(before).digest('hex') },
    sourceFilesSha256: perfProtocolHash(source.files), testedInputs: source.testedInputs,
    scope: 'verified-source-archive-only' as const };
}

export async function runSummaryCohort(input: {
  ids: string[];
  repeats: number;
  call: (ids: string[]) => Promise<unknown>;
  now?: () => number;
}) {
  if (!input.ids.length || input.ids.length > 10 || new Set(input.ids).size !== input.ids.length ||
      !Number.isInteger(input.repeats) || input.repeats < 1 || input.repeats > 10) {
    throw new Error('Use 1–10 distinct item ids and 1–10 repeats');
  }
  const now = input.now ?? (() => performance.now());
  const samples: Sample[] = [];
  for (let repeat = 1; repeat <= input.repeats; repeat += 1) {
    for (let size = 1; size <= input.ids.length; size += 1) {
      const ids = input.ids.slice(0, size);
      const start = now();
      let result: any;
      let failures: string[];
      try {
        result = await input.call(ids);
        failures = validateSummary(result, ids);
      } catch {
        // Child errors can contain token paths or payloads: preserve the failed
        // sample without copying opaque transport diagnostics into the artifact.
        failures = ['MCP client failed; no successful authoritative response'];
      }
      samples.push({ size, repeat, wallMs: now() - start, valid: failures.length === 0,
        failures, read: result?.read ?? null });
    }
  }
  return { samples, verdict: judgeSamples(samples, input.ids.length, input.repeats) };
}

/** Independent identity oracle, read through coord:whoami before the trial. */
export interface McpIdentityFixture {
  ownerId: string; ownerLabel: string; source: string; workspaceId: string;
  userId: string | null; fleetSlug: string | null; fleetRole: string | null; inbox_wake_key: string;
}

export interface IdentityRuntime {
  kind: 'staging' | 'isolated-operator-api'; origin: string;
  mainPid?: number; processIdentity?: string; bundlePath?: string; bundleSha256?: string;
}

/** Private diagnostics may identify exact artifact bytes while their source
 * commit stays unknown. This does not qualify collection or a clean source pin. */
export function identityLoadedHealth(health: Record<string, unknown>, runtime: IdentityRuntime) {
  const sourceKnown = typeof health.sha === 'string' && /^[a-f0-9]{7,40}$/.test(health.sha);
  const privateArtifact = health.sha === null && runtime.kind === 'isolated-operator-api' &&
    Number.isSafeInteger(runtime.mainPid) && runtime.mainPid! > 0 && Boolean(runtime.processIdentity) &&
    Boolean(runtime.bundlePath && isAbsolute(runtime.bundlePath)) && /^[a-f0-9]{64}$/.test(runtime.bundleSha256 ?? '');
  if (health.ok !== true || health.service !== 'papercusp-operator' || health.bundleStale !== undefined ||
      (!sourceKnown && !privateArtifact)) throw new Error('loaded build identity unavailable');
  // Observation time is not loaded configuration; preserve every other field.
  const { ts: _observationTime, ...loadedHealth } = health;
  return loadedHealth;
}

/** Explicit opt-in only; an arbitrary port override must never select a live host. */
export function isolatedIdentityRuntimeContract(env: NodeJS.ProcessEnv) {
  const fail = () => { throw new Error('isolated operator-api contract required'); };
  const origin = env.PAPERCUSP_OPERATOR_URL;
  if (!origin || !env.HOME || !env.PAPERCUSP_HOME || !env.PAPERCUSP_WORKSPACES_ROOT ||
      !/^test-runtime-[a-z0-9-]+$/.test(env.PAPERCUSP_WORKSPACE ?? '') ||
      env.PAPERCUSP_WORKSPACE_ID !== env.PAPERCUSP_WORKSPACE ||
      env.PAPERCUSP_BACKGROUND_WORKERS !== '0' || env.PAPERCUSP_DBOS_ENABLE !== '0' ||
      env.PAPERCUSP_DBOS_ROUTINES !== '0' || env.PAPERCUSP_SKIP_PG_DISCOVERY !== '1') return fail();
  let url: URL;
  try { url = new URL(origin); } catch { return fail(); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== origin ||
      url.username || url.password || !url.port || ['3070', '3170', '3055', '3271'].includes(url.port) ||
      env.PAPERCUSP_HONO_PORT !== url.port || !isAbsolute(env.HOME)) return fail();
  const root = dirname(env.HOME);
  const inside = (path: string) => { const rel = relative(root, path); return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); };
  if (env.HOME !== resolve(root, 'home') || env.PAPERCUSP_HOME !== resolve(env.HOME, '.papercusp') ||
      !inside(env.PAPERCUSP_WORKSPACES_ROOT)) return fail();
  for (const key of ['HARNESS_ADMIN_DATABASE_URL', 'HARNESS_DATABASE_URL'] as const) {
    let db: URL;
    try { db = new URL(env[key]!); } catch { return fail(); }
    if (!['postgres:', 'postgresql:'].includes(db.protocol) || !['127.0.0.1', 'localhost'].includes(db.hostname) ||
        !db.port || db.port === '5432' || db.port !== env.PAPERCUSP_PG_PORT) return fail();
  }
  return { origin, root, workspace: env.PAPERCUSP_WORKSPACE! };
}

/** Kernel group membership, including every observed host descendant in that group. */
export async function identityProcessGroupCensus(group: number, proc = {
  list: () => readdir('/proc'), readStat: (name: string) => readFile(`/proc/${name}/stat`, 'utf8'),
}): Promise<number[]> {
  if (!Number.isSafeInteger(group) || group < 1) throw new Error('invalid isolated process group');
  const rows = await Promise.all((await proc.list()).filter(name => /^[0-9]+$/.test(name)).map(async name => {
    try {
      const stat = await proc.readStat(name);
      const processGroup = linuxPgrpFromProcStat(stat);
      // Kernel tasks use group zero; the signal-oriented helper accepts only
      // positive groups. A valid group zero cannot belong to our host.
      if (processGroup === null && stat.lastIndexOf(')') > 0 &&
          stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[2] === '0') return null;
      if (processGroup === null) throw new Error('invalid process group identity');
      return processGroup === group ? Number(name) : null;
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
      throw error;
    }
  }));
  return rows.filter((pid): pid is number => pid !== null).sort((a, b) => a - b);
}

/** Exact finite SSE fixture; this exercises identity routing, not SC-001 as a whole. */
export function mcpIdentityFixture(identity: McpIdentityFixture, query: string) {
  if (!identity.ownerId || !identity.workspaceId || !identity.ownerLabel || !identity.source ||
      identity.inbox_wake_key !== `coord:inbox-wake:${identity.ownerId}` ||
      [identity.userId, identity.fleetSlug, identity.fleetRole].some(value => value !== null && typeof value !== 'string')) throw new Error('verified identity fixture required');
  const parameters = new URLSearchParams(query);
  if (parameters.get('client') !== identity.ownerId || parameters.get('workspace') !== identity.workspaceId ||
      parameters.get('superuser') !== '1' || parameters.get('format') !== 'json') throw new Error('fixture attribution differs');
  const expected = { ownerId: identity.ownerId, ownerLabel: identity.ownerLabel, source: identity.source,
    workspaceId: identity.workspaceId, userId: identity.userId, fleetSlug: identity.fleetSlug,
    fleetRole: identity.fleetRole, inbox_wake_key: identity.inbox_wake_key };
  const expectedBody = ':stream-open\n\nevent: message\ndata: ' + JSON.stringify({
    result: { content: [{ type: 'text', text: JSON.stringify(expected) }] }, jsonrpc: '2.0', id: 1,
  }) + '\n\n';
  return { identity: expected, expectedBody, request: {
    id: 'identity', path: `/api/mcp?${parameters}`, method: 'POST' as const,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: buildMcpCallParams('coord:whoami', {}, { outputGroupId: randomUUID() }) }),
    contentType: 'application/json' as const, accept: 'application/json, text/event-stream' as const,
    atMs: 0, timeoutMs: 10_000, maximumResponseBytes: 64_000, expectedStatus: 200,
    expectedContentType: 'text/event-stream', expectedBodySha256: createHash('sha256').update(expectedBody).digest('hex'),
  } };
}

/** Prepare exact schedule bytes without credentials, a host, or a manifest.
 * Repeat identity namespaces output groups; it is not evidence of independence.
 */
export function identityWorkloadFixture(fixture: ReturnType<typeof mcpIdentityFixture>, count: number, repeatId: string) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) throw new Error('count must be 1–10000');
  if (!repeatId.trim()) throw new Error('explicit repeat-id required for fixture');
  const groups: PerfWorkloadRunPlan['groups'] = (['warm', 'burst'] as const).map(stratum => ({
    journey: 'attributed-mcp-identity-only', stratum, armOrder: ['a', 'b'],
    concurrency: stratum === 'burst' ? 4 : 1, exposureMs: count * 15_000 + 1_000, maximumStartLatenessMs: 1_000,
    requests: Array.from({ length: count }, (_, index) => {
      const hash = perfProtocolHash({ identity: fixture.identity, path: fixture.request.path, repeatId, stratum, index });
      const outputGroupId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      return { ...fixture.request, id: `identity-${index}`,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: buildMcpCallParams('coord:whoami', {}, { outputGroupId }) }),
        atMs: stratum === 'burst' ? Math.floor(index / 4) * 15_000 : index * 15_000 };
    }),
  }));
  return { kind: 'unqualified-identity-workload-fixture' as const, acceptance: 'unknown' as const,
    reason: 'identity-only;no-cold-reset;no-repeat-independence-or-runtime-qualification',
    independentRepeatId: repeatId, groups, fixtureHash: perfProtocolHash({ groups }) };
}

export interface IdentityWarmupClient {
  callTool(params: { name: string; arguments: Record<string, unknown>; _meta?: { outputGroupId: string } }): Promise<unknown>;
  close(): Promise<void>;
}

/** Allowlisted evidence only: transport errors may contain credentials or URLs. */
export function identityFailure(error: unknown): Record<string, unknown> {
  if (error instanceof AgentMcpConnectionError) return { code: error.message, connection: error.diagnostic };
  const known = ['warmup-tool-error', 'warmup-content-shape', 'warmup attribution differs',
    'staging health unavailable', 'loaded build identity unavailable', 'staging process identity unavailable',
    'unified staging cgroup unavailable', 'invalid staging census', 'invalid process start identity',
    'process changed during snapshot', 'staging census changed during snapshot',
    'isolated process identity differs', 'isolated loaded bundle pin differs', 'isolated launch identity differs'];
  const message = error instanceof Error ? error.message : '';
  if (known.includes(message)) return { code: message };
  if (error instanceof SyntaxError) return { code: 'invalid-json' };
  const code = (error as { code?: unknown } | null)?.code;
  return { code: 'unclassified-failure', ...(typeof code === 'number' && Number.isSafeInteger(code) ? { mcpCode: code } : {}) };
}

type IdentityRuntimePreparationStage = 'source-verification' | 'preparation-module' | 'credential' |
  'preparation-directory' | 'bundle' | 'runtime-configuration' | 'host-log';

/** Keep pre-host failures outside the fresh build directory. Never serialize an
 * assertion's actual/expected values, command output, stack or opaque message. */
export async function identityRuntimePreparation<T>(evidenceDir: string,
  prepare: (stage: (value: IdentityRuntimePreparationStage) => void) => Promise<T>): Promise<T> {
  let stage: IdentityRuntimePreparationStage = 'source-verification';
  try { return await prepare(value => { stage = value; }); }
  catch (error) {
    const message = error instanceof Error ? error.message : '';
    const known = [
      'independent selected source receipt required', 'exact selected source reference required',
      'selected source reference differs', 'selected source receipt changed',
      'PAPERCUSP_TEST_RUNS_DB_URL must not be blank',
      'PAPERCUSP_TEST_RUNS_DB_URL must be a valid PostgreSQL URL',
      'PAPERCUSP_TEST_RUNS_DB_URL is required for durable isolated test receipts',
      'isolated shared-ledger runs require a nonblank caller workspace (PAPERCUSP_TEST_RUN_WORKSPACE, PAPERCUSP_WORKSPACE_ID or PAPERCUSP_WORKSPACE)',
      'Observed build outputs must be independent of the source archive',
      'Observed build requires a fresh preparation directory', 'Pinned selected source receipt changed',
      'Observed selected source differs', 'Private operator dependencies violate their declared ranges:',
      // complete() checks run after the shell builder succeeds. Keep their
      // stable names without retaining assertion diffs or artifact contents.
      'Original source receipt changed during build', 'Retained source receipt changed during build',
      'Original build inputs changed during build', 'Materialized dependencies changed during build',
      'Observed build symlinks are not qualified',
    ];
    const code = known.find(value => message === value || message.startsWith(`${value}\n`) ||
      (value.endsWith(':') && message.startsWith(`${value} `)));
    const errno = (error as NodeJS.ErrnoException | null)?.code;
    const diagnostic = code ? { code } : identityFailure(error);
    if (typeof errno === 'string' && ['ENOENT', 'EACCES', 'EEXIST', 'ENOSPC', 'EPERM', 'EROFS', 'ENOTDIR', 'ETIMEDOUT'].includes(errno))
      diagnostic.fsCode = errno;
    const artifacts = ['verifier-source.json', 'operator-api-inputs.json', 'operator-api-preflight.json',
      'operator-api-build.log', 'operator-api-build-result.json', 'hono-host.mjs.build-steps.jsonl']
      .map(name => resolve(evidenceDir, 'prepare', name)).filter(path => existsSync(path));
    const failure = { kind: 'unqualified-identity-runtime-preparation-failure', acceptance: 'unknown',
      stage, diagnostic, artifacts, hostStarted: false };
    await writeFile(resolve(evidenceDir, 'preparation-failure.json'), JSON.stringify(failure, null, 2),
      { flag: 'wx', mode: 0o600 });
    throw error;
  }
}

export class IdentityPreparationError extends Error {
  constructor(readonly failures: Array<{ stage: 'connect' | 'call' | 'validate' | 'close'; diagnostic: Record<string, unknown> }>) {
    super('identity-preparation-failed');
  }
}

/** A failed later snapshot must never erase the primary preparation evidence. */
export async function identitySnapshot(capture: () => Promise<PerfWorkloadManifest>) {
  try {
    const manifest = structuredClone(await capture());
    return { manifest, hash: perfProtocolHash(manifest), failure: null };
  } catch (error) { return { manifest: null, hash: null, failure: identityFailure(error) }; }
}

export async function identityPreparationProbe(capture: () => Promise<PerfWorkloadManifest>,
  prepare: () => Promise<Record<string, unknown>>) {
  const initial = await identitySnapshot(capture);
  let preparation: Record<string, unknown> | null = null;
  let failures: IdentityPreparationError['failures'] = [];
  try { preparation = await prepare(); }
  catch (error) { failures = error instanceof IdentityPreparationError ? error.failures : [{ stage: 'call', diagnostic: identityFailure(error) }]; }
  const final = await identitySnapshot(capture);
  return { initial, preparation, failures, final,
    manifestStable: initial.hash !== null && final.hash !== null && initial.hash === final.hash };
}

/** Observed SDK warmup, with cold application reset explicitly unqualified. */
export function identityPreparation(fixture: ReturnType<typeof mcpIdentityFixture>, connect: () => Promise<IdentityWarmupClient>): PerfWorkloadRunDependencies['prepare'] {
  const expected = perfProtocolHash(fixture.identity);
  return async context => {
    if (context.stratum === 'cold' || context.requestId !== null) throw new Error('application cold reset is not qualified');
    const startedAtMs = Date.now();
    // These internal RPCs share one inference turn, even when transport is slow.
    // A subsequent preparation invocation gets a new turn identity.
    const outputGroupId = randomUUID();
    let client: IdentityWarmupClient;
    try { client = await connect(); }
    catch (error) { throw new IdentityPreparationError([{ stage: 'connect', diagnostic: identityFailure(error) }]); }
    const observations: Array<{ responseHash: string; matched: boolean }> = [];
    const failures: IdentityPreparationError['failures'] = [];
    let stage: 'call' | 'validate' = 'call';
    try {
      for (let i = 0; i < 3; i++) {
        stage = 'call';
        const value = await client.callTool({ name: 'coord:whoami', arguments: {}, _meta: { outputGroupId } }) as {
          isError?: boolean; content?: Array<{ type: string; text?: string }>;
        };
        stage = 'validate';
        if (value?.isError) throw new Error('warmup-tool-error');
        if (value?.content?.length !== 1 || value.content[0].type !== 'text' ||
            typeof value.content[0].text !== 'string') throw new Error('warmup-content-shape');
        const responseHash = perfProtocolHash(JSON.parse(value.content[0].text));
        if (responseHash !== expected) throw new Error('warmup attribution differs');
        observations.push({ responseHash, matched: true });
      }
    } catch (error) { failures.push({ stage, diagnostic: identityFailure(error) }); }
    try { await client.close(); }
    catch (error) { failures.push({ stage: 'close', diagnostic: identityFailure(error) }); }
    if (failures.length) throw new IdentityPreparationError(failures);
    return { method: 'maintained-agent-mcp-http-identity-warmup-v1', ...context, startedAtMs, endedAtMs: Date.now(),
      observations, applicationColdResetQualified: false,
      transport: 'separate-sdk-warmup-session;measurement-stateless-http' };
  };
}

/** Hash the opened executable, and reject replacement or mutation while reading.
 * A pathname alone does not identify the bytes a process is executing. Keep the
 * descriptor open across hashing and compare it with the current proc link.
 * This is executable evidence only, not complete native-library/import closure.
 */
export async function identityExecutableFingerprint(executableLink: string,
  openExecutable: (path: string) => Promise<FileHandle> = path => open(path, 'r')) {
  const path = await realpath(executableLink);
  const file = await openExecutable(executableLink);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new Error('executable is not a regular file');
    const hash = createHash('sha256');
    let bytes = 0n;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += BigInt(chunk.length);
      hash.update(chunk);
    }
    const after = await file.stat({ bigint: true });
    const current = await stat(executableLink, { bigint: true });
    const keys = ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'] as const;
    if (bytes !== before.size || await realpath(executableLink) !== path ||
        keys.some(key => before[key] !== after[key] || before[key] !== current[key])) {
      throw new Error('executable changed during snapshot');
    }
    return { path, sha256: hash.digest('hex'), bytes: bytes.toString(),
      dev: before.dev.toString(), ino: before.ino.toString(), mode: before.mode.toString(),
      mtimeNs: before.mtimeNs.toString(), ctimeNs: before.ctimeNs.toString() };
  } finally { await file.close(); }
}

/** File-backed mappings only: anonymous/JIT memory and private modified pages
 * are not identified by hashing the backing file. Keep those limits explicit.
 */
export function identityFileMappings(maps: string) {
  if (!maps.trim()) throw new Error('process maps unavailable');
  let end = 0n;
  return maps.trimEnd().split('\n').flatMap(line => {
    const row = /^([0-9a-f]+)-([0-9a-f]+) ([r-][w-][x-][ps]) ([0-9a-f]+) ([0-9a-f]+):([0-9a-f]+) ([0-9]+)(?:\s+(.*))?$/.exec(line);
    if (!row || BigInt(`0x${row[1]}`) < end || BigInt(`0x${row[2]}`) <= BigInt(`0x${row[1]}`))
      throw new Error('invalid process mapping');
    end = BigInt(`0x${row[2]}`);
    const path = row[8] ?? '';
    const inode = BigInt(row[7]).toString();
    if (inode === '0' && (!path || path.startsWith('['))) return [];
    const kernelAnonymous = path === 'anon_inode:[io_uring]';
    // The kernel's newline encoding is ambiguous with literal backslash digits.
    // Deleted/unknown backing identities cannot qualify a byte fingerprint.
    if ((!path.startsWith('/') && !kernelAnonymous) || inode === '0' || path.endsWith(' (deleted)') || /\\[0-7]{3}/.test(path))
      throw new Error('opaque file-backed process mapping');
    return [{ range: `${row[1]}-${row[2]}`, permissions: row[3], offset: row[4],
      major: BigInt(`0x${row[5]}`).toString(), minor: BigInt(`0x${row[6]}`).toString(), inode, path,
      backing: kernelAnonymous ? 'kernel-anonymous' as const : 'file' as const }];
  });
}

/** Use the process's mount namespace and require the opened file to match the
 * kernel mapping's device/inode. A replaced pathname is never a valid fallback.
 * Reuse the fd hashing/race guard already used for executable bytes.
 */
export async function identityMappedFileFingerprints(pid: number, proc = {
  maps: () => readFile(`/proc/${pid}/maps`, 'utf8'),
  start: async () => linuxStartTicksFromProcStat(await readFile(`/proc/${pid}/stat`, 'utf8')),
  fingerprint: (path: string) => identityExecutableFingerprint(`/proc/${pid}/root${path}`),
}) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('invalid mapped process identity');
  const startTicks = await proc.start();
  if (!startTicks || !/^[0-9]+$/.test(startTicks)) throw new Error('invalid mapped process start identity');
  const mappings = identityFileMappings(await proc.maps());
  const fileMappings = mappings.filter(row => row.backing === 'file');
  if (!fileMappings.length) throw new Error('file-backed process mappings unavailable');
  const files = [];
  for (const path of [...new Set(fileMappings.map(row => row.path))].sort()) {
    const fingerprint = await proc.fingerprint(path);
    const device = BigInt(fingerprint.dev);
    const major = (((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n)).toString();
    const minor = ((device & 0xffn) | ((device >> 12n) & 0xffffff00n)).toString();
    if (fileMappings.filter(row => row.path === path).some(row =>
      row.major !== major || row.minor !== minor || row.inode !== fingerprint.ino))
      throw new Error('mapped backing file identity differs');
    files.push({ path, fingerprint });
  }
  if (startTicks !== await proc.start() ||
      JSON.stringify(mappings) !== JSON.stringify(identityFileMappings(await proc.maps())))
    throw new Error('process mappings changed during snapshot');
  return { scope: 'observed-file-backed-mapping-bytes' as const, startTicks, mappings, files,
    notCovered: ['anonymous-and-jit-memory', 'kernel-anonymous-io-uring-buffers', 'modified-private-pages', 'unobserved-dynamic-imports'] };
}

/** Real process census and loaded health identity; never retain raw credentials/environment. */
export async function captureIdentityEnvironment(fixture: ReturnType<typeof mcpIdentityFixture>,
  runtime: IdentityRuntime = { kind: 'staging', origin: 'http://127.0.0.1:3170' }): Promise<PerfWorkloadManifest> {
  const response = await fetch(`${runtime.origin}/api/health`, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!response.ok) throw new Error('staging health unavailable');
  const health = await response.json() as Record<string, unknown>;
  const loadedHealth = identityLoadedHealth(health, runtime);
  const selectedSource = identitySelectedSource(ROOT, process.env, loadedHealth.sha);
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const mainPid = runtime.kind === 'staging' ? Number((await exec('systemctl', ['--user', 'show',
    'papercup-staging-api.service', '--property=MainPID', '--value'], { timeout: 10_000, maxBuffer: 16_384 })).stdout.trim()) : runtime.mainPid!;
  if (!Number.isSafeInteger(mainPid) || mainPid < 1) throw new Error('staging process identity unavailable');
  if (runtime.kind === 'isolated-operator-api' && (!runtime.processIdentity ||
      readProcessIdentity(mainPid) !== runtime.processIdentity ||
      linuxPgrpFromProcStat(await readFile(`/proc/${mainPid}/stat`, 'utf8')) !== mainPid)) throw new Error('isolated process identity differs');
  const cgroup = /^0::(\/[^\n]*)$/m.exec(await readFile(`/proc/${mainPid}/cgroup`, 'utf8'))?.[1];
  if (!cgroup || cgroup.split('/').includes('..')) throw new Error('unified staging cgroup unavailable');
  const census = runtime.kind === 'isolated-operator-api' ? () => identityProcessGroupCensus(mainPid) :
    async () => (await readFile(`/sys/fs/cgroup${cgroup}/cgroup.procs`, 'utf8')).trim().split(/\s+/).map(Number).sort((a, b) => a - b);
  const pids = await census();
  if (!pids.includes(mainPid) || pids.some(pid => !Number.isSafeInteger(pid) || pid < 1)) throw new Error('invalid staging census');
  const processes = await Promise.all(pids.map(async pid => {
    const stat = () => readFile(`/proc/${pid}/stat`, 'utf8');
    const before = linuxStartTicksFromProcStat(await stat());
    if (!before || !/^[0-9]+$/.test(before)) throw new Error('invalid process start identity');
    const environmentHash = createHash('sha256').update(await readFile(`/proc/${pid}/environ`)).digest('hex');
    const cwd = await realpath(`/proc/${pid}/cwd`);
    const executableFingerprint = await identityExecutableFingerprint(`/proc/${pid}/exe`);
    const mappedFiles = await identityMappedFileFingerprints(pid);
    if (before !== linuxStartTicksFromProcStat(await stat())) throw new Error('process changed during snapshot');
    return { pid, startTicks: before, environmentHash, cwd, executable: executableFingerprint.path, executableFingerprint, mappedFiles };
  }));
  if (JSON.stringify(pids) !== JSON.stringify(await census())) throw new Error('staging census changed during snapshot');
  let bundle: Record<string, unknown> = {};
  if (runtime.kind === 'isolated-operator-api') {
    const argv = (await readFile(`/proc/${mainPid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
    if (argv.length !== 2 || argv[1] !== runtime.bundlePath ||
        await realpath(argv[0]) !== await realpath(process.execPath)) throw new Error('isolated launch identity differs');
    const sha256 = createHash('sha256').update(await readFile(runtime.bundlePath!)).digest('hex');
    if (sha256 !== runtime.bundleSha256 || readProcessIdentity(mainPid) !== runtime.processIdentity) throw new Error('isolated loaded bundle pin differs');
    bundle = { path: runtime.bundlePath, sha256 };
  }
  return {
    source: { loadedBuild: loadedHealth, loadedSourceCommitKnown: loadedHealth.sha !== null, selectedSource, bundle, collectorFiles: sourceHashes() },
    configuration: { origin: runtime.origin, processEnvironments: processes.map(({ pid, startTicks, environmentHash }) => ({ pid, startTicks, environmentHash })),
      opaqueReasons: ['dynamic-runtime-configuration-and-dependency-closure-not-yet-qualified',
        ...(loadedHealth.sha === null ? ['loaded-source-commit-unavailable'] : [])] },
    runtime: { kind: runtime.kind, mainPid, cgroup, censusScope: runtime.kind === 'staging' ? 'service-cgroup' : 'owned-host-process-group;private-pg-and-sidecar-not-qualified',
      processes: processes.map(({ environmentHash: _environmentHash, ...identity }) => identity) },
    host: { bootId, platform: process.platform, architecture: process.arch },
    workload: { journey: 'attributed-mcp-identity-only', transport: 'stateless-http-finite-sse', coldResetQualified: false,
      notCovered: ['representative-api-mcp-mix', 'long-lived-stream-continuity', 'database', 'compiler', 'gpu', 'vm'] },
    fixture: { identity: fixture.identity, request: fixture.request, expectedBody: fixture.expectedBody },
  };
}

async function runMatchedIdentity(flags: Record<string, string>, runtime: IdentityRuntime = { kind: 'staging', origin: 'http://127.0.0.1:3170' }) {
  if (!flags['identity-file'] || flags.port && flags.port !== new URL(runtime.origin).port) throw new Error('matched identity requires --identity-file and exact runtime port');
  const stage = flags.stage ?? 'collect';
  if (!['fixture', 'manifest', 'preparation', 'collect'].includes(stage)) throw new Error('unknown identity stage');
  const identity = JSON.parse(await readFile(resolve(flags['identity-file']), 'utf8')) as McpIdentityFixture;
  if (identity.ownerId !== process.env.PAPERCUSP_SID || identity.workspaceId !== process.env.PAPERCUSP_WORKSPACE) throw new Error('fixture does not belong to this session');
  const query = buildMcpSessionQuery({ client: identity.ownerId, workspace: identity.workspaceId,
    harness: runtime.kind === 'staging' ? 'papercusp' : identity.workspaceId,
    role: resolveMcpRole(), origin: resolveMcpCallOrigin(identity.ownerId) });
  const fixture = mcpIdentityFixture(identity, query.toString());
  const schedule = identityWorkloadFixture(fixture, Number(flags.count ?? 1),
    flags['repeat-id'] ?? (stage === 'fixture' ? '' : `identity-smoke-${Date.now()}`));
  if (stage === 'fixture') {
    process.stdout.write(`${JSON.stringify(schedule, null, 2)}\n`);
    return;
  }
  const tokens = superuserTokenPaths().flatMap(path => { try { return path ? [readFileSync(path, 'utf8').trim()].filter(Boolean) : []; } catch { return []; } });
  if (!tokens.length) throw new Error('runtime credential unavailable');
  const headers = { authorization: `Bearer ${tokens[0]}` };
  const prepare = identityPreparation(fixture, async () => (await connectAgentMcp({
    url: `${runtime.origin}${fixture.request.path}`,
    headers: { ...headers, 'mcp-session-id': randomUUID() }, mode: 'http', timeoutMs: 10_000,
    name: 'host-memory-p001-identity-preparation',
  })).client);
  const capture = () => captureIdentityEnvironment(fixture, runtime);
  if (stage === 'preparation') {
    const probe = await identityPreparationProbe(capture, () => prepare({ arm: 'a', journey: 'attributed-mcp-identity-only', stratum: 'warm', requestId: null }));
    process.stdout.write(`${JSON.stringify({ kind: 'unqualified-identity-preparation', acceptance: 'unknown', probe }, null, 2)}\n`);
    if (!probe.preparation || !probe.manifestStable) process.exitCode = 1;
    return;
  }
  const initial = await identitySnapshot(capture);
  if (stage === 'manifest' || !initial.manifest) {
    const final = stage === 'manifest' ? await identitySnapshot(capture) : null;
    const manifestStable = initial.hash !== null && final?.hash === initial.hash;
    process.stdout.write(`${JSON.stringify({ kind: 'unqualified-identity-manifest', acceptance: 'unknown', initial, final, manifestStable }, null, 2)}\n`);
    if (!manifestStable) process.exitCode = 1;
    return;
  }
  const manifest = initial.manifest;
  const preparationFailures: Array<{ arm: string; stratum: string; failures: IdentityPreparationError['failures'] }> = [];
  const manifestFailures: Array<{ arm: string; diagnostic: Record<string, unknown> }> = [];
  const plan: PerfWorkloadRunPlan = { independentRepeatId: schedule.independentRepeatId,
    phase: 'baseline', origins: { a: runtime.origin, b: runtime.origin },
    expectedManifestHashes: { a: perfProtocolHash(manifest), b: perfProtocolHash(manifest) },
    groups: schedule.groups };
  const run = await collectPerfWorkloadRun(plan, { transportHeaders: { a: headers, b: headers }, prepare: async context => {
    try { return await prepare(context); } catch (error) {
      preparationFailures.push({ arm: context.arm, stratum: context.stratum,
        failures: error instanceof IdentityPreparationError ? error.failures : [{ stage: 'call', diagnostic: identityFailure(error) }] });
      throw error;
    }
  },
    captureManifest: async arm => {
      try { return await capture(); }
      catch (error) { manifestFailures.push({ arm, diagnostic: identityFailure(error) }); throw error; }
    } });
  process.stdout.write(`${JSON.stringify({ kind: 'unqualified-identity-workload-smoke', acceptance: 'unknown',
    reason: 'identity-only;no-application-cold-reset;no-independent-repeat-or-complete-runtime-closure', initial, preparationFailures, manifestFailures, run }, null, 2)}\n`);
  if (run.status !== 'collected' || run.groups.some(group => group.arms.some(arm => arm.requests.some(row => row.outcome !== 'success')))) process.exitCode = 1;
}

/** Run only inside with-test-pg's maintained private operator-api boundary. */
async function runIsolatedIdentity(flags: Record<string, string>) {
  const contract = isolatedIdentityRuntimeContract(process.env);
  if (!flags['evidence-dir'] || !isAbsolute(flags['evidence-dir']) || !/^su-[a-z0-9-]+$/.test(flags['client-id'] ?? '') ||
      flags['identity-file'] || flags.port || flags.stage === 'collect' || !['manifest', 'preparation'].includes(flags.stage ?? '')) {
    throw new Error('isolated identity requires explicit client-id, evidence-dir and diagnostic stage; collection is not qualified');
  }
  const evidenceDir = resolve(flags['evidence-dir']);
  await mkdir(evidenceDir, { recursive: true });
  const { selectedSource, preparationDir, bundle, traceOut, hostEnv, configuration, configurationBytes, configurationPath,
    log, observeCommittedReaderLoadedSources, waitForPrivateOperator, stopPrivateOperatorHost } =
    await identityRuntimePreparation(evidenceDir, async stage => {
      // Refuse mixed/mutated source before allocating credentials or compiling.
      const selectedSource = identitySelectedSource(ROOT, process.env);
      process.env.PAPERCUSP_SID = flags['client-id'];
      stage('preparation-module');
      const { preparePrivateOperatorApiBundle, observeCommittedReaderLoadedSources,
        privateBundleRuntimeEnv, waitForPrivateOperator, stopPrivateOperatorHost } =
        await import('../packages/operator-core/test/private-http-workspace-preflight');
      const { superuserTokenPath } = await import('../packages/operator-core/lib/superuser-token');
      stage('credential');
      await writeFile(superuserTokenPath(), randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
      console.error('IDENTITY_PRIVATE_PHASE build');
      stage('preparation-directory');
      const preparationDir = resolve(evidenceDir, 'prepare');
      await mkdir(preparationDir);
      stage('bundle');
      const bundle = await preparePrivateOperatorApiBundle(ROOT, preparationDir, {
        builder: { timeoutMs: 240_000, maxMs: 420_000 },
        ...(selectedSource ? { observedSource: { sourceReceiptPath: selectedSource.receipt.path,
          sourceReceiptSha256: selectedSource.receipt.sha256, selectedCommit: selectedSource.sourceCommit } } : {}),
      });
      stage('runtime-configuration');
      const traceOut = resolve(evidenceDir, 'identity-host-source.json');
      const hostEnv = privateBundleRuntimeEnv(process.env, { traceOut, pinnedSources: [{
        path: bundle.path, sha256: bundle.sha256, byteLength: (await stat(bundle.path)).size,
      }] });
      const configuration = captureConfigurationSnapshot(hostEnv);
      const configurationBytes = JSON.stringify(configuration);
      const configurationPath = resolve(evidenceDir, 'host-configuration-inputs.json');
      await writeFile(configurationPath, configurationBytes, { flag: 'wx', mode: 0o600 });
      // An existing/unwritable log must never strand a host outside cleanup.
      stage('host-log');
      const log = await open(resolve(evidenceDir, 'host.log'), 'wx', 0o600);
      return { selectedSource, preparationDir, bundle, traceOut, hostEnv, configuration, configurationBytes, configurationPath,
        log, observeCommittedReaderLoadedSources, waitForPrivateOperator, stopPrivateOperatorHost };
    });
  const hostStartedAtMs = Date.now();
  const host = spawn(process.execPath, [bundle.path], { cwd: ROOT, env: hostEnv, detached: true, stdio: ['ignore', log.fd, log.fd] });
  let hostError: Error | undefined;
  host.on('error', error => { hostError = error; });
  const processIdentity = host.pid ? readProcessIdentity(host.pid) : null;
  const lifecycle: Record<string, unknown> = { workspace: contract.workspace, origin: contract.origin, pid: host.pid,
    processIdentity, bundle, configurationInputs: { path: configurationPath,
      sha256: createHash('sha256').update(configurationBytes).digest('hex'),
      scope: 'prelaunch-configuration-inputs' }, acceptance: 'unknown', failures: [] };
  try {
    if (!processIdentity) throw new Error('isolated process identity unavailable');
    await waitForPrivateOperator({ host, base: contract.origin, evidenceDir, hostIdentity: processIdentity, environment: hostEnv });
    if (hostError) throw hostError;
    console.error('IDENTITY_PRIVATE_PHASE identity-registration');
    const child = await exec(process.execPath, [resolve(ROOT, 'scripts/mcp-call.mjs'), 'coord:whoami', '{}',
      '--client', flags['client-id'], '--workspace', contract.workspace, '--port', new URL(contract.origin).port],
    { cwd: ROOT, timeout: 35_000, maxBuffer: 1024 * 1024 });
    const identity = JSON.parse(child.stdout) as McpIdentityFixture;
    if (identity.ownerId !== flags['client-id'] || identity.workspaceId !== contract.workspace) throw new Error('isolated attribution differs');
    const identityFile = resolve(evidenceDir, 'registered-identity.json');
    await writeFile(identityFile, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
    console.error('IDENTITY_PRIVATE_PHASE diagnostic');
    await runMatchedIdentity({ ...flags, 'identity-file': identityFile }, { kind: 'isolated-operator-api', origin: contract.origin,
      mainPid: host.pid!, processIdentity, bundlePath: bundle.path, bundleSha256: bundle.sha256 });
  } catch (error) { (lifecycle.failures as unknown[]).push({ stage: 'diagnostic', diagnostic: identityFailure(error) }); process.exitCode = 1; }
  finally {
    lifecycle.diagnosticExitCode = process.exitCode ?? 0;
    try {
      await stopPrivateOperatorHost(host);
      lifecycle.remainingGroupPids = host.pid ? await identityProcessGroupCensus(host.pid) : [];
      lifecycle.hostStopped = readProcessIdentity(host.pid!) !== processIdentity;
      if (!(lifecycle.hostStopped) || (lifecycle.remainingGroupPids as number[]).length) throw new Error('isolated cleanup incomplete');
    } catch (error) { (lifecycle.failures as unknown[]).push({ stage: 'cleanup', diagnostic: identityFailure(error) }); process.exitCode = 1; }
    // Reuse the existing authenticated event reader. Retain actual event refs
    // after cleanup, including failed starts; this is not source/evaluation or
    // complete runtime qualification and must never supply an acceptance pass.
    const finishedAtMs = Date.now();
    try {
      if (selectedSource) {
        if (await readFile(configurationPath, 'utf8') !== configurationBytes)
          throw new Error('original host configuration inputs changed');
        lifecycle.loadedSources = observeCommittedReaderLoadedSources({ root: ROOT, bundle: bundle.path,
          receiptPath: resolve(preparationDir, 'operator-api-preflight.json'), receiptSha256: bundle.receiptSha256,
          sourceReceiptPath: resolve(preparationDir, 'verifier-source.json'),
          sourceReceiptSha256: selectedSource.receipt.sha256, selectedCommit: selectedSource.sourceCommit,
          preparationOnly: true, buildObservationOnly: true, traceOut, pid: host.pid!,
          kernelProcessIdentity: processIdentity ?? undefined, startedAtMs: hostStartedAtMs, finishedAtMs, configuration });
      }
      const trace = readNativeProcessTraceArtifacts(traceOut, hostStartedAtMs, finishedAtMs);
      lifecycle.nativeSourceTrace = { scope: 'authenticated-native-event-artifacts-only', acceptance: 'unknown',
        out: traceOut, sourceRoot: trace.sourceRoot, startedAtMs: hostStartedAtMs, finishedAtMs,
        population: trace.population,
        events: trace.rows.map(({ row, bytes }) => ({ event: row.event, pid: row.pid,
          processIdentity: row.processIdentity, kernelProcessIdentity: row.kernelProcessIdentity, atMs: row.atMs,
          ref: createHash('sha256').update(bytes).digest('hex') + '.json' })),
        pending: ['loader-source-pin-binding', 'module-evaluation', 'runtime-config', 'private-pg',
          'sidecars', 'complete-runtime-closure'] };
      if (!trace.population.complete) throw new Error('isolated native trace population incomplete');
    } catch (error) { (lifecycle.failures as unknown[]).push({ stage: 'native-source-trace', diagnostic: identityFailure(error) }); process.exitCode = 1; }
    await log.close();
    await writeFile(resolve(evidenceDir, 'lifecycle.json'), JSON.stringify(lifecycle, null, 2));
    console.error('IDENTITY_PRIVATE_PHASE stopped');
  }
}

async function main() {
  const flags = Object.fromEntries(process.argv.slice(2).map(arg => {
    const match = /^--(ids|port|repeats|mode|stage|identity-file|count|repeat-id|runtime|evidence-dir|client-id)=(.+)$/.exec(arg);
    if (!match) throw new Error('Unknown benchmark flag');
    return [match[1], match[2]];
  }));
  if (flags.runtime === 'isolated-operator-api' && flags.mode === 'matched-identity') return runIsolatedIdentity(flags);
  if (flags.runtime && flags.runtime !== 'staging') throw new Error('unknown benchmark runtime');
  const client = process.env.PAPERCUSP_SID;
  const workspace = process.env.PAPERCUSP_WORKSPACE;
  if (!client || !workspace) throw new Error('Verified session identity and workspace are required');
  if (flags.mode === 'matched-identity') return runMatchedIdentity(flags);
  if (flags.mode) throw new Error('Unknown benchmark mode');
  const ids = (flags.ids ?? '').split(',').filter(Boolean);
  const port = flags.port ?? '3170';
  if (port !== '3170') throw new Error('This pre-release probe is pinned to the staging operator on 3170');
  const repeats = Number(flags.repeats ?? 4);
  const startedAt = new Date().toISOString();
  const before = sourceHashes();
  const result = await runSummaryCohort({ ids, repeats, call: async requested => {
    const args = { ids: requested, harness: 'papercusp', detail: false, threadLimit: 0,
      projection: { pick: PICK } };
    const child = await exec(process.execPath, [resolve(ROOT, 'scripts/mcp-call.mjs'), 'work_items:get',
      JSON.stringify(args), '--client', client, '--workspace', workspace, '--harness', 'papercusp',
      '--port', port], { cwd: ROOT, timeout: 35_000, maxBuffer: 1024 * 1024 });
    return JSON.parse(child.stdout);
  } });
  const after = sourceHashes();
  const sourceStable = JSON.stringify(before) === JSON.stringify(after);
  const report = { schemaVersion: 1, kind: 'operational-test-evidence',
    name: 'BYOC P009 R003 current-build summary cohort', startedAt, finishedAt: new Date().toISOString(),
    endpoint: 'http://127.0.0.1:3170/api/mcp', client, workspace, ids, repeats,
    method: 'maintained mcp-call subprocess wall clock, including startup and response parsing; unique output group per call',
    sourceHashes: before, sourceStable, ...result,
    passed: sourceStable && result.verdict.passed,
    notExercised: ['stalled unrelated checkpoint/claim write', 'same-item ordering/conflict',
      'cancellation/drain', 'forwarding outcome ambiguity', 'deployed R006 acceptance'] };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (isCliEntry(import.meta.url)) void main().catch(() => {
  console.error('Summary probe failed before a complete report; inspect the maintained command inputs');
  process.exitCode = 1;
});
