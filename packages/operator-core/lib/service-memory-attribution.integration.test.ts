/** P-011: matched resources and decoded-query evidence in the maintained private API route.
 * This measures one request-only host, not the production six-worker/background cohort.
 * Allocation samples and completed query bytes do not prove a retained-state owner.
 */
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterAll, describe, expect, it } from 'vitest';
import { HOST_MALLOC_ARENA_MAX } from '../../../apps/operator/bin/malloc-arena-reexec';
import { createCdpClient, readProcessMemory, withFunctionCallTrace } from '../../../scripts/cdp-inspector.mjs';
import { serializeIdentitySafeJson } from '../../../scripts/lib/identity-leak-patterns.mjs';
import type { PgResultDiagnostic } from '@papercusp/db-org';
import { createCache } from '@papercusp/cache';

const root = resolve(__dirname, '../../..');

// The canonical runner changes cwd to the test's package. Evidence paths are
// repository-relative; reject a missing parent before starting a private host.
function evidenceDestination(destination: string | undefined) {
  if (!destination) return null;
  const path = resolve(root, destination);
  if (!existsSync(dirname(path))) throw new Error('Evidence destination parent must exist: ' + dirname(path));
  return path;
}

// Reuse the focused runner's actual deadline resolver. Admit the whole test
// budget BEFORE allocating a bundle or private database, not after a partial
// comparison has already consumed the first arms.
async function assertCohortRunnerBudget(requiredMs: number, env: NodeJS.ProcessEnv = process.env) {
  const { testFileRunTimeoutMs } = await import(pathToFileURL(join(root, 'scripts/test-files.mjs')).href);
  const availableMs = testFileRunTimeoutMs(env, 1);
  if (availableMs < requiredMs) throw Error('Private cohort needs PAPERCUSP_TEST_FILE_TIMEOUT_MS >= ' + requiredMs +
    '; focused runner budget is ' + availableMs + '. Refusing before bundle/database launch.');
}

// Preserve the writer's bounded attribution tuple when available. A SQL family
// only names the first relation; it cannot substitute for operation context.
// This function is serialized into the inspector expression, so keep it closed.
function completedQuerySamples(rows: readonly PgResultDiagnostic[]) {
  return rows.map(row => ({
    source: { ...row.source }, queryFamily: row.queryFamily,
    connectionId: row.connectionId, queryId: row.queryId, backendPid: row.backendPid,
    command: row.command, rowCount: row.rowCount, wireBytes: row.wireBytes,
    elapsedMs: row.elapsedMs, status: row.status, errorCode: row.errorCode,
    recordedAt: row.recordedAt, correlationState: row.correlationState ?? 'unknown',
    ...(row.correlation ? { correlation: { ...row.correlation } } : {}),
  }));
}

// Exact server-generated HTTP IDs are the join. Counts/times only check the
// resulting observation's completeness; they cannot select another request.
// This function crosses the private probe boundary, so keep it closed.
function namedRequestQueryResults(
  pools: { pool: string; results: ReturnType<typeof completedQuerySamples> }[], requestIds: string[],
) {
  if (!requestIds.length || requestIds.length > 32 || new Set(requestIds).size !== requestIds.length ||
      requestIds.some(id => !/^[a-f0-9-]{36}$/i.test(id))) throw Error('Exact HTTP request IDs required');
  const results = pools.flatMap(pool => pool.results.filter(row =>
    row.correlationState === 'linked' && row.correlation?.operation === 'workItems.byHarness' &&
    requestIds.includes(row.correlation.requestId ?? '')).map(row => ({ pool: pool.pool, ...row })));
  const identities = results.map(row => JSON.stringify([row.correlation!.requestId, row.pool,
    row.source.processInstanceId, row.source.buildSha, row.source.poolInstanceId, row.connectionId, row.queryId]));
  if (requestIds.some(id => !results.some(row => row.correlation!.requestId === id)) ||
      new Set(identities).size !== results.length)
    throw Error('Named HTTP request diagnostic missing or ambiguous');
  return results;
}

// Conserve every exact query tuple before a costly request-linked snapshot.
function assertNamedQueryHeapSelection(
  records: { pool: string; source: PgResultDiagnostic['source']; connectionId: number; queryId: number; requestId: string }[],
  expected: ReturnType<typeof namedRequestQueryResults>,
) {
  const key = (row: typeof records[number]) => JSON.stringify([row.requestId, row.pool,
    row.source.processInstanceId, row.source.buildSha, row.source.poolInstanceId, row.connectionId, row.queryId]);
  const selected = records.map(key), wanted = expected.map(row => key({ ...row, requestId: row.correlation!.requestId! }));
  if (!wanted.length || selected.length !== wanted.length || new Set(selected).size !== selected.length ||
      new Set(wanted).size !== wanted.length || selected.some(value => !wanted.includes(value)))
    throw Error('HTTP/query/heap exact identity drift or incomplete query selection');
}

// Buffer complete startup lines: stderr chunks can split an endpoint, and an
// in-place exec keeps the PID while replacing its ephemeral inspector listener.
function inspectorEndpoints(output: string): string[] {
  return [...output.matchAll(/^Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+)\r?$/gm)]
    .map(match => match[1]);
}

function readCohortReport(path: string, result: {
  status: number | null; signal: string | null; stdout: string; stderr: string; error?: Error;
}) {
  const report = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {
    incomplete: true, phase: 'runner-before-report', samples: [], windows: [], error: 'Private report was not written',
  };
  report.runner = { status: result.status, signal: result.signal, error: result.error?.message,
    errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
    stdoutBytes: Buffer.byteLength(result.stdout ?? ''), stderrBytes: Buffer.byteLength(result.stderr ?? '') };
  return report;
}

async function readSourceRequest(chunks: AsyncIterable<Buffer>) {
  const parts: Buffer[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

// Independent of the cohort emitter: derive acceptance from raw PID-bound
// measurements and command timestamps, never its concurrency/reduction labels.
// This accepts a private entry comparison, not retained/native or live savings.
function auditSpawnerResourcePair(report: any) {
  const requireEvidence = (condition: unknown, reason: string) => {
    if (!condition) throw Error('P011 spawner acceptance: ' + reason);
  };
  const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0;
  requireEvidence(report.incomplete === false && report.runner.status === 0 && !report.error, 'incomplete run');
  requireEvidence(report.cohorts.length === 4 &&
    report.cohorts.map((row: any) => row.mode).join(',') === 'full,standalone,standalone,full', 'order-reversed arms');
  requireEvidence(report.sources.before.length > 0 &&
    JSON.stringify(report.sources.before) === JSON.stringify(report.sources.after), 'source drift');
  const phases = ['ready', 'warm', ...Array.from({ length: 3 }, (_, w) =>
    ['idle-' + w + '-start', 'idle-' + w + '-end', 'workload-' + w + '-end']).flat(), 'completion-idle'];
  const allocator = report.cohorts[0].bound.arena;
  const identities = new Set<string>();
  for (const [arm, cohort] of report.cohorts.entries()) {
    requireEvidence(cohort.arm === arm && /^[a-f0-9]{64}$/.test(cohort.bundleSha256), 'artifact identity');
    const identity = cohort.identity.pid + ':' + cohort.identity.startTicks;
    requireEvidence(positive(cohort.identity.pid) && /^\d+$/.test(cohort.identity.startTicks) &&
      !identities.has(identity) && cohort.bound.pid === cohort.identity.pid, 'process identity');
    identities.add(identity);
    requireEvidence(allocator === '2' && cohort.bound.arena === allocator, 'allocator mismatch');
    requireEvidence(cohort.fenceVerified === true && cohort.reaped === true &&
      cohort.forcedCleanup === false && cohort.socketRemoved === true && cohort.unreaped.length === 0, 'cleanup or capability');
    requireEvidence(cohort.descendants.length === 13 && cohort.descendants.every((row: any) =>
      row.ppid === cohort.identity.pid && positive(row.pid) && /^\d+$/.test(row.startTicks)), 'owned command population');
    requireEvidence(cohort.samples.map((row: any) => row.phase).join(',') === phases.join(','), 'matched phases');
    let lastAllocation = 0, lastAt = 0;
    for (const sample of cohort.samples) {
      requireEvidence(sample.pid === cohort.identity.pid && sample.os.pid === sample.pid &&
        sample.os.startTicks === cohort.identity.startTicks, 'sample identity');
      requireEvidence(positive(sample.os.pssBytes), 'PSS required; RSS cannot substitute');
      requireEvidence(positive(sample.heap.total_allocated_bytes) && sample.heap.total_allocated_bytes >= lastAllocation,
        'cumulative V8 allocation required');
      requireEvidence(positive(sample.at) && sample.at > lastAt, 'sample ordering');
      requireEvidence(sample.hostFacts.sidecarFlags.spawner === true &&
        sample.hostFacts.backgroundWorkersOverride === 'disabled', 'runtime role mismatch');
      lastAllocation = sample.heap.total_allocated_bytes; lastAt = sample.at;
    }
    requireEvidence(cohort.windows.length === 3, 'matched window population');
    for (const [w, window] of cohort.windows.entries()) {
      const outcomes = window.outcomes;
      requireEvidence(window.window === w && outcomes.length === 4 && outcomes.every((row: any, i: number) =>
        row.token === 'window-' + w + '-' + i && positive(row.start) && positive(row.end) && row.end - row.start >= 300),
      'equivalent command outcomes');
      requireEvidence(Math.max(...outcomes.map((row: any) => row.start)) < Math.min(...outcomes.map((row: any) => row.end)),
        'actual command concurrency');
    }
  }
  requireEvidence(report.cohorts[0].bundleSha256 === report.cohorts[3].bundleSha256 &&
    report.cohorts[1].bundleSha256 === report.cohorts[2].bundleSha256, 'within-mode artifact drift');
  return [[0, 1], [3, 2]].map(([baselineArm, candidateArm]) => {
    const baseline = report.cohorts[baselineArm].samples.at(-1), candidate = report.cohorts[candidateArm].samples.at(-1);
    const finalPssReductionBytes = baseline.os.pssBytes - candidate.os.pssBytes;
    const finalCumulativeV8AllocationReductionBytes = baseline.heap.total_allocated_bytes - candidate.heap.total_allocated_bytes;
    requireEvidence(finalPssReductionBytes > 0, 'both pairs must reduce PSS');
    requireEvidence(finalCumulativeV8AllocationReductionBytes > 0, 'both pairs must reduce cumulative V8 allocation');
    return { baselineArm, candidateArm, finalPssReductionBytes, finalCumulativeV8AllocationReductionBytes };
  });
}

// Saved-data oracles deliberately do not call the emitters or their summaries.
// Each returns only the conclusions its persisted counters can establish.
function auditSavedInboxPair(report: any) {
  const check = (condition: unknown, reason: string) => {
    if (!condition) throw Error('P011 inbox acceptance: ' + reason);
  };
  const positive = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0;
  check(report.incomplete === false && report.runner?.status === 0 && !report.error, 'incomplete run');
  check(report.cohorts.length === 2 && report.cohorts.map((c: any) => c.mode).join(',') === 'baseline,shared', 'paired hosts');
  check(Object.keys(report.sources.before).length > 0 && JSON.stringify(report.sources.before) === JSON.stringify(report.sources.after), 'source drift');
  const bodies = Array.from({ length: 256 }, (_, i) => ({ id: 'p011-' + (i + 1),
    body: ('useful-context-' + (i + 1) + ' ').repeat(32768).slice(0, 32768) }));
  bodies.sort((a, b) => a.id.localeCompare(b.id));
  const digest = createHash('sha256');
  for (const row of bodies) digest.update(JSON.stringify([row.id, row.body]));
  const expectedContent = { rows: 256, stringCodeUnits: 8388608, sha256: digest.digest('hex') };
  const phases = ['before', ...Array.from({ length: 3 }, (_, w) =>
    ['idle-' + w + '-start', 'idle-' + w + '-end', 'workload-' + w + '-end']).flat(), 'completion-idle'];
  check(report.variants.length === 8 && report.variants.every((v: any, i: number) =>
    v.directed === true && v.limit === i + 1 && v.include_ambient === Boolean(i % 2) &&
    v.include_intents === Boolean(Math.floor(i / 2) % 2) && v.max_body_chars === 1), 'display variant contract');
  check(report.cohorts[0].pid !== report.cohorts[1].pid, 'independent process identity');
  for (const [arm, c] of report.cohorts.entries()) {
    check(positive(c.pid) && c.pid === c.identity.pid && /^\d+$/.test(c.identity.startTicks), 'process identity');
    check(c.pauses === 0 && c.reaped === true && c.unreaped.length === 0 && c.descendants.length === 0, 'cleanup or debugger pause');
    check(c.cachePreflight.enabled === true && c.cachePreflight.entries === 0, 'cold cache');
    check(JSON.stringify(c.fixture) === JSON.stringify(expectedContent), 'independently regenerated raw context');
    check(c.content.length === (arm === 0 ? 8 : 1) && c.content.every((row: any) =>
      row.rows === expectedContent.rows && row.stringCodeUnits === expectedContent.stringCodeUnits &&
      row.sha256 === expectedContent.sha256), 'complete raw content and sharing');
    check(c.samples.map((s: any) => s.phase).join(',') === phases.join(','), 'matched phases');
    let at = 0, allocated = 0;
    for (const s of c.samples) {
      check(s.pid === c.pid && s.os.pid === c.pid && s.os.startTicks === c.identity.startTicks, 'sample identity');
      check(positive(s.os.pssBytes), 'PSS required');
      check(positive(s.heap.total_allocated_bytes) && s.heap.total_allocated_bytes >= allocated, 'cumulative V8 allocation required');
      check(positive(s.at) && s.at > at && s.descendants.length === 0 && s.cache.enabled === true, 'sample sequence');
      const copies = s.phase === 'before' || s.phase.startsWith('idle-0-') ? 0 : arm === 0 ? 8 : 1;
      check(s.cache.entries === copies && s.cache.rows.length === copies &&
        s.cache.rows.every((n: number) => n === 256), 'observed sharing population');
      at = s.at; allocated = s.heap.total_allocated_bytes;
    }
    check(c.windows.length === 3, 'window population');
    for (const [w, window] of c.windows.entries()) {
      check(window.window === w && window.outcomes.length === 8, 'response population');
      for (const [i, outcome] of window.outcomes.entries()) {
        const expected = Array.from({ length: i + 1 }, (_, j) => ({ id: 'p011-' + (256 - j), summary: 'P' }));
        check(outcome.variant === i && outcome.total === 256 && outcome.returned === i + 1 &&
          JSON.stringify(outcome.entries) === JSON.stringify(expected), 'useful response parity');
      }
    }
  }
  const growth = (c: any, key: 'pssBytes' | 'total_allocated_bytes') => key === 'pssBytes' ?
    c.samples.at(-1).os[key] - c.samples[0].os[key] : c.samples.at(-1).heap[key] - c.samples[0].heap[key];
  const pssGrowthDifferenceBytes = growth(report.cohorts[0], 'pssBytes') - growth(report.cohorts[1], 'pssBytes');
  const cumulativeV8AllocationGrowthDifferenceBytes = growth(report.cohorts[0], 'total_allocated_bytes') - growth(report.cohorts[1], 'total_allocated_bytes');
  check(pssGrowthDifferenceBytes > 0 && cumulativeV8AllocationGrowthDifferenceBytes > 0, 'paired resource observation');
  return { pssGrowthDifferenceBytes, cumulativeV8AllocationGrowthDifferenceBytes,
    rawCopies: [8, 1], preservedBodyCodeUnits: expectedContent.stringCodeUnits, responsesPerHost: 24,
    actualConcurrency: 'unmeasured: per-request start/end timestamps absent', productionSavings: 'unmeasured' };
}

// Client intervals establish requests in flight, not parallel server execution.
// Derive overlap from raw monotonic timestamps, never Promise.all or a headline.
function auditInboxOverlap(cohort: any) {
  const check = (condition: unknown, reason: string) => {
    if (!condition) throw Error('P011 inbox overlap: ' + reason);
  };
  const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  check(cohort.pid === cohort.identity.pid && /^\d+$/.test(cohort.identity.startTicks), 'target identity');
  check(cohort.windows.length === 3, 'window population');
  let previousEnd = 0;
  return cohort.windows.map((window: any, w: number) => {
    check(window.window === w && finite(window.startedAtMs) && finite(window.endedAtMs) &&
      window.startedAtMs >= previousEnd && window.endedAtMs > window.startedAtMs, 'window ordering');
    check(window.requests.length === 8 && new Set(window.requests.map((q: any) => q.variant)).size === 8 &&
      window.requests.every((q: any) => Number.isInteger(q.variant) && q.variant >= 0 && q.variant < 8), 'variant population');
    for (const q of window.requests) {
      check(q.pid === cohort.pid && q.startTicks === cohort.identity.startTicks, 'request identity');
      check(finite(q.startedAtMs) && finite(q.endedAtMs) && q.endedAtMs > q.startedAtMs &&
        q.startedAtMs >= window.startedAtMs && q.endedAtMs <= window.endedAtMs, 'request interval');
    }
    const overlapStartMs = Math.max(...window.requests.map((q: any) => q.startedAtMs));
    const overlapEndMs = Math.min(...window.requests.map((q: any) => q.endedAtMs));
    check(overlapEndMs > overlapStartMs, 'eight requests must actually overlap');
    previousEnd = window.endedAtMs;
    return { window: w, requestsInFlight: 8, overlapMs: overlapEndMs - overlapStartMs };
  });
}

function auditObservedInboxPair(report: any) {
  if (report.schemaVersion !== 2 || report.cohorts.length !== 4 ||
      report.cohorts.map((c: any) => c.mode).join(',') !== 'baseline,shared,shared,baseline' ||
      report.cohorts.some((c: any, i: number) => c.arm !== i) ||
      new Set(report.cohorts.map((c: any) => c.pid + ':' + c.identity.startTicks)).size !== 4)
    throw Error('P011 inbox acceptance: order-reversed independent arms');
  const overlap = report.cohorts.map(auditInboxOverlap);
  if (report.cohorts.some((c: any) => c.forcedCleanup !== false))
    throw Error('P011 inbox acceptance: graceful cleanup required');
  for (const [a, b] of [[0, 3], [1, 2]]) {
    if (report.cohorts[a].bundleSha256 !== report.cohorts[b].bundleSha256)
      throw Error('P011 inbox acceptance: within-mode artifact drift');
  }
  // The existing oracle regenerates useful input and verifies PID-bound PSS,
  // cumulative allocation, cache ownership, complete bodies, outcomes and exit.
  const pairs = [[0, 1], [3, 2]].map(([baselineArm, candidateArm]) => ({
    baselineArm, candidateArm,
    ...auditSavedInboxPair({ ...report, cohorts: [report.cohorts[baselineArm], report.cohorts[candidateArm]] }),
    actualConcurrency: 'Eight client requests in flight; server execution parallelism unmeasured',
  }));
  return { pairs, overlap, allocationDefinition: 'Cumulative V8 allocation, not unique retained or native bytes',
    productionSavings: 'unmeasured', historicalRecovery: 'unmeasured' };
}

function auditSavedExpiryPair(report: any) {
  const check = (condition: unknown, reason: string) => {
    if (!condition) throw Error('P011 expiry acceptance: ' + reason);
  };
  const { control, current } = report.measurements;
  check(report.fixture.entries === 1042 && report.fixture.hardExpired === 438 && report.fixture.useful === 604, 'fixture population');
  check(control.pid !== current.pid && control.node === current.node && control.control === true && current.control === false &&
    control.sourceHashes.generationStore === current.sourceHashes.generationStore, 'matched arms');
  for (const c of [control, current]) {
    check(c.expiredIdle.entries === 1042 && c.expiredIdle.reachable === 438 && c.reclamation.reads === 32, 'expiry and ordinary-read phases');
    check(c.cleared.entries === 0 && c.cleared.reachable === 0, 'cleanup roots');
    for (const m of [c.empty, c.populated, c.expiredIdle.memory, c.ordinary.memory]) {
      check(Number.isFinite(m.heapUsed) && m.heapUsed > 0 && Number.isFinite(m.pssBytes) && m.pssBytes > 0, 'separate heap and PSS counters');
    }
  }
  check(control.ordinary.entries === 1042 && control.ordinary.reachable === 438 &&
    current.ordinary.entries === 604 && current.ordinary.reachable === 0, 'expired roots removed; useful entry count preserved');
  check(control.stats.hits === current.stats.hits && control.stats.misses === current.stats.misses &&
    control.stats.builds === current.stats.builds && current.stats.staleServed === 0, 'cache outcomes');
  const heapUsedDifferenceBytes = control.ordinary.memory.heapUsed - current.ordinary.memory.heapUsed;
  check(heapUsedDifferenceBytes > 0, 'heap reclamation');
  const pssDifferenceBytes = control.ordinary.memory.pssBytes - current.ordinary.memory.pssBytes;
  return { expiredReachable: [control.ordinary.reachable, current.ordinary.reachable], usefulEntries: 604,
    heapUsedDifferenceBytes, pssDifferenceBytes, physicalPssReductionObserved: pssDifferenceBytes > 0,
    cumulativeV8Allocation: 'unmeasured', usefulContentParity: 'unmeasured: saved entry counts and cache statistics only',
    processStartTicks: 'unmeasured', productionSavings: 'unmeasured' };
}

function auditSavedCompilerCaller(report: any) {
  const check = (condition: unknown, reason: string) => {
    if (!condition) throw Error('P011 compiler acceptance: ' + reason);
  };
  const nativeSha = 'fd49340cbb5f7ca3ce6f313db78d056de21f07338135ec8dfad63294a304fd2c';
  check(report.incomplete === false && report.runner.status === 0 && !report.error, 'incomplete run');
  check(report.cohorts.length === 2 && report.cohorts.map((c: any) => c.mode).join(',') === 'control,compiler', 'paired caller arms');
  const [control, compiler] = report.cohorts;
  check(control.identity.pid !== compiler.identity.pid && control.identity.bundleSha256 === report.bundleSha256 &&
    compiler.identity.bundleSha256 === report.bundleSha256, 'serving artifact identity');
  const phases = ['preflight', 'window-0', 'window-1', 'window-2', 'bounded-idle'];
  for (const c of report.cohorts) {
    check(c.reaped === true && c.unreaped.length === 0 && c.pauses === 0 && c.leaseRelease.ok === true, 'cleanup or pause');
    check(c.samples.map((s: any) => s.phase).join(',') === phases.join(','), 'matched resource phases');
    let at = 0, allocated = 0;
    for (const s of c.samples) {
      check(s.pid === c.identity.pid && s.os.pid === s.pid && s.os.startTicks === c.identity.startTicks, 'sample identity');
      check(Number.isFinite(s.os.pssKiB) && s.os.pssKiB > 0 && Number.isFinite(s.heap.total_allocated_bytes) &&
        s.heap.total_allocated_bytes >= allocated, 'PSS and cumulative V8 counters');
      check(s.at > at, 'sample ordering'); at = s.at; allocated = s.heap.total_allocated_bytes;
    }
    check(c.samples.at(-1).descendants.length === 0, 'post-request descendants');
    check(c.requests.length === 3, 'request population');
    for (const [w, request] of c.requests.entries()) {
      check(request.window === w && request.value.ok === false && request.value.error === 'mutation_probe_active' &&
        request.value.testRunIds.length === 0 && request.value.phaseTimingsMs.routerExecutionMs === null, 'real refused preflight');
      check(request.requestSha256 === control.requests[w].requestSha256 && request.requestBytes === control.requests[w].requestBytes,
        'matched HTTP inputs');
      check(c.mode === 'compiler' ? request.value.hint.includes('may observe it: imports ') :
        request.value.hint.includes('not a code module'), 'distinguishing caller path');
    }
    check(c.trace.pid === c.identity.pid && c.trace.limited === false, 'trace identity and coverage');
  }
  check(control.trace.calls.fork.calls === 0 && compiler.trace.calls.fork.calls === 3 &&
    compiler.trace.calls.fork.stacks.some((s: string) => s.includes('at testImportClosures ')), 'actual compiler caller');
  const native = compiler.descendants.filter((d: any) => d.executableSha256 === nativeSha);
  check(control.descendants.every((d: any) => d.executableSha256 !== nativeSha) && native.length === 3, 'executable-identified population');
  const identities = new Set<string>();
  for (const d of native) {
    const parent = compiler.descendants.find((p: any) => p.pid === d.parent);
    const identity = d.pid + ':' + d.startTicks;
    check(/^\d+$/.test(d.startTicks) && !identities.has(identity) && parent && parent.parent === compiler.identity.pid &&
      parent.executableSha256 === compiler.samples[0].os.executableSha256, 'native descendant ancestry');
    check(d.samples > 0 && d.pssKiB > 0 && d.peakPssKiB >= d.pssKiB, 'native resource observation');
    identities.add(identity);
  }
  return { tracedForks: [0, 3], nativeDescendants: native.length, nativeExecutableSha256: nativeSha,
    nativeSampleCounts: native.map((d: any) => d.samples), hostResourceSamples: [5, 5],
    scope: 'Historical private refused preflight caller and final cleanup only',
    pairedPssReduction: 'unmeasured: these arms distinguish invocation, not an optimization',
    namedSourceCurrentness: 'unmeasured in raw receipt; separate historical qualification required',
    historicalGigabyteRecovery: 'unmeasured', productionSavings: 'unmeasured' };
}

// Database/runtime launchers can emit substantial output before the cohort
// publishes its first report. Do not buffer that output in spawnSync.
function runCohortWithLog(args: string[], options: { cwd: string; timeout: number; env: NodeJS.ProcessEnv }, logPath: string,
  archiveDirectory = join(root, '.papercusp', 'logs')) {
  const descriptor = openSync(logPath, 'w', 0o600);
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(process.execPath, args, { ...options, stdio: ['ignore', descriptor, descriptor] });
  } finally { closeSync(descriptor); }
  // Reuse the harness's private log archive. Cohort finally blocks remove the
  // working log; receipts must name retained, exact bytes instead. Hash-addressed
  // files avoid overwriting another run, and raw logs stay out of public JSON.
  const bytes = readFileSync(logPath), sha256 = createHash('sha256').update(bytes).digest('hex');
  mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
  const archived = join(archiveDirectory, 'cohort-' + sha256 + '.log');
  try { writeFileSync(archived, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!readFileSync(archived).equals(bytes)) throw Error('Cohort log archive bytes do not match');
  return { ...result, stdout: '', stderr: bytes.subarray(Math.max(0, bytes.length - 4000)).toString('utf8'),
    log: { path: relative(root, archived), bytes: bytes.length, sha256 } };
}

// Build both cohorts from one maintained bundle. The counterfactual restores
// only the old full-read key; reject drift before starting any runtime.
function restoreFullInboxKey(bundle: string) {
  const pattern = /\.\.\.\(?boundedInbox \? \{\s*(limit,\s*ambient: includeAmbient,\s*intents: !!args\d*\.include_intents)\s*\} : \{\}\)?/g;
  const matches = [...bundle.matchAll(pattern)];
  if (matches.length !== 1) throw Error('Expected exactly one normalized inbox key in bundle');
  const match = matches[0];
  const replacement = match[1];
  return { bundle: bundle.slice(0, match.index) + replacement + bundle.slice(match.index! + match[0].length),
    intervention: { offset: match.index, before: match[0], after: replacement } };
}

// Extend the compiler cohort's serving-generation copy seam. Freeze executable
// and data companions, not mutable build logs/locks; this is not a source graph.
function inboxArtifactManifest(directory: string) {
  const rows: { path: string; bytes: number; sha256: string }[] = [];
  const visit = (prefix: string) => {
    for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
      const path = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw Error('Serving inbox artifact symlink requires an explicit copy contract');
      if (entry.isDirectory()) { visit(path); continue; }
      if (!entry.isFile() || !/\.(?:mjs|json|sql)$/.test(path)) continue;
      if (rows.length >= 4096) throw Error('Serving inbox artifact manifest exceeded bound');
      const bytes = readFileSync(join(directory, path));
      rows.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  };
  visit('');
  for (const required of ['hono-host.mjs', 'mutation-probe-closure.worker.mjs', 'spawner-sidecar.mjs']) {
    if (!rows.some(row => row.path === required)) throw Error('Serving inbox companion missing: ' + required);
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

// Same PID/start-time/executable and socket fences as the maintained baseline.
// Resolve a relative argv entry in the serving process's cwd, not the test cwd.
function servingInboxProcess(pid: number, directory: string) {
  if (!Number.isInteger(pid) || pid <= 0) throw Error('Serving inbox requires a positive PID');
  const prefix = '/proc/' + pid;
  const stat = readFileSync(prefix + '/stat', 'utf8');
  const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const argv = readFileSync(prefix + '/cmdline', 'utf8').split('\0').filter(Boolean);
  const entry = realpathSync(join(directory, 'hono-host.mjs'));
  // Only the first non-option argument may identify the entry. This rejects
  // a script which merely passes the host bundle as a data argument.
  let index = 1;
  while (argv[index]?.startsWith('--inspect=')) index++;
  if (!argv[index] || realpathSync(resolve(readlinkSync(prefix + '/cwd'), argv[index])) !== entry)
    throw Error('Serving inbox PID entry does not identify the candidate');
  const inodes = new Set(readdirSync(prefix + '/fd').flatMap(fd => {
    try { return [readlinkSync(prefix + '/fd/' + fd).match(/^socket:\[(\d+)\]$/)?.[1]]; }
    catch { return []; }
  }).filter(Boolean));
  const ownsStagingSocket = ['tcp', 'tcp6'].some(kind => readFileSync(prefix + '/net/' + kind, 'utf8')
    .trim().split('\n').slice(1).some(line => {
      const fields = line.trim().split(/\s+/);
      return fields[3] === '0A' && inodes.has(fields[9]) && parseInt(fields[1].split(':').at(-1)!, 16) === 3170;
    }));
  if (!ownsStagingSocket) throw Error('Serving inbox PID does not own the staging socket');
  return { pid, startTicks, entry, executableSha256: createHash('sha256')
    .update(readFileSync(prefix + '/exe')).digest('hex'), ownsStagingSocket };
}

type ServingInboxPin = { health: { sha: string; version: string };
  process: Omit<ReturnType<typeof servingInboxProcess>, 'ownsStagingSocket'> & { ownsStagingSocket: boolean };
  artifacts: ReturnType<typeof inboxArtifactManifest> };

function servingInboxHealth(health: any, expectedBuild: string) {
  if (!/^[a-f0-9]{10,64}$/.test(expectedBuild) || health?.ok !== true || health.service !== 'papercusp-operator' ||
      health.sha !== expectedBuild || typeof health.version !== 'string' || health.bundleStale !== undefined)
    throw Error('Serving inbox loaded health identity mismatch');
  return { sha: health.sha as string, version: health.version as string };
}

function assertServingInboxPin(before: ServingInboxPin, after: ServingInboxPin) {
  if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('Serving inbox generation identity or artifact drift');
}

async function readServingInboxPin(directory: string, expectedBuild: string, pid: number): Promise<ServingInboxPin> {
  if (!/^[a-f0-9]{10,64}$/.test(expectedBuild)) throw Error('Serving inbox requires an explicit build SHA');
  const before = servingInboxProcess(pid, directory);
  const health = await readServingInboxHealth('http://127.0.0.1:3170/api/health', expectedBuild);
  const artifacts = inboxArtifactManifest(directory);
  if (JSON.stringify(before) !== JSON.stringify(servingInboxProcess(pid, directory)))
    throw Error('Serving inbox process changed during preflight');
  return { health, process: before, artifacts };
}

async function readServingInboxHealth(endpoint: string, expectedBuild: string) {
  // These identity reads straddle spawnSync. Client idle timers and close
  // callbacks cannot run while it blocks, so an independently retired pooled
  // socket can look reusable. Finish each pin on its own connection.
  const response = await fetch(endpoint, { headers: { connection: 'close' }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Error('Serving inbox health HTTP failure: ' + response.status);
  return servingInboxHealth(await response.json(), expectedBuild);
}

function assertInboxArtifactCopy(source: ReturnType<typeof inboxArtifactManifest>, candidate: ReturnType<typeof inboxArtifactManifest>,
  baseline: ReturnType<typeof inboxArtifactManifest>, restoredBundle: string) {
  if (JSON.stringify(source) !== JSON.stringify(candidate)) throw Error('Serving inbox candidate copy drift');
  const expected = candidate.map(row => row.path === 'hono-host.mjs' ? { ...row,
    bytes: Buffer.byteLength(restoredBundle), sha256: createHash('sha256').update(restoredBundle).digest('hex') } : row);
  if (JSON.stringify(expected) !== JSON.stringify(baseline)) throw Error('Serving inbox baseline companion or intervention drift');
}

// The maintained launcher owns this PG port. A test-runtime label alone must
// not authorize fixture writes through an inherited ambient database URL.
function privateInboxEndpoints(workspace: string, backgroundWorkers: string, databaseUrl: string, operatorUrl: string, pgPort: string) {
  const database = new URL(databaseUrl), operator = new URL(operatorUrl);
  const loopback = (host: string) => ['127.0.0.1', 'localhost', '[::1]'].includes(host);
  if (!workspace.startsWith('test-runtime-') || backgroundWorkers !== '0' ||
      !['postgres:', 'postgresql:'].includes(database.protocol) || !loopback(database.hostname) ||
      !/^\d+$/.test(pgPort) || Number(pgPort) <= 0 || Number(pgPort) > 65535 || database.port !== pgPort ||
      operator.protocol !== 'http:' || !loopback(operator.hostname) || !operator.port ||
      ['3070', '3170', pgPort].includes(operator.port)) throw Error('Private inbox database/runtime endpoint containment failed');
  return { workspace, backgroundWorkers: 0, loopbackDatabase: true, ownedPgPort: Number(pgPort), ambientOperatorPortsExcluded: true };
}

async function persistInboxBeforePostflight(report: any, destination: string, postflight: () => Promise<void>) {
  // Completed raw windows, source pins, intervention and runtime-log identity
  // must survive a failing final network read. The outer catch records failure.
  writeFileSync(destination, serializeIdentitySafeJson(report));
  await postflight();
  writeFileSync(destination, serializeIdentitySafeJson(report));
}

// Closed helper also runs in CDP. Validate the actual library shape before
// expensive preparation, then verify the private cache is empty after cold-bust.
function preparePairCache(state: any) {
  const cache = state?.cache;
  if (state?.cacheLayerOn !== true || typeof cache?.clearL1 !== 'function' ||
      !(cache?.l1?.map instanceof Map)) throw Error('Private pair cache API/owner shape mismatch');
  cache.clearL1();
  if (cache.l1.map.size !== 0) throw Error('Private pair cache did not cold-bust');
  return { enabled: state.cacheLayerOn, entries: cache.l1.map.size };
}

// cachedRead writes tool|args inside Cache's workspace + NUL envelope. Match
// that exact namespace, never a substring inside private argument payloads.
// The same closed selector runs in the real-cache guard and private inspector.
function inboxPairEntries(state: any, digestsOnly = false) {
  const map = state?.cache?.l1?.map;
  if (!(map instanceof Map)) throw Error('Private pair cache entry map missing');
  return [...map].filter(([key]) => {
    if (typeof key !== 'string') return false;
    const nul = key.indexOf('\u0000');
    const pipe = nul > 0 ? key.indexOf('|', nul + 1) : -1;
    return pipe > nul + 1 && key.slice(nul + 1, pipe) === 'coord:inbox';
  }).map(([key, entry]) => digestsOnly ? {
    keyDigest: process.getBuiltinModule('crypto').createHash('sha256').update(key).digest('hex'),
  } : entry);
}

// queryObjects triggers GC and enumerates survivors. Its aggregate sizes are
// container entries, not retained bytes; bound inspection and release the CDP
// handles so the diagnostic cannot become a new retainer itself.
async function retainedContainerCensus(client: any, kind: 'map' | 'array') {
  const group = 'p011-retained-' + kind;
  const startedAt = Date.now();
  try {
    const prototype = await client.evaluate(kind === 'map' ? 'Map.prototype' : 'Array.prototype', { objectGroup: group });
    const objects = await client.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId, objectGroup: group });
    const result = await client.send('Runtime.callFunctionOn', {
      objectId: objects.objects.objectId, returnByValue: true,
      arguments: [{ value: kind }, { value: 2000 }, { value: 200 }],
      // Literal JS stays independent of the test transform's lexical helpers.
      functionDeclaration: String.raw`function (type, limit, budgetMs) {
        const owners = new WeakMap();
        const register = (value, prefix) => {
          if (!value || typeof value !== 'object') return;
          if (value instanceof Map || Array.isArray(value)) { owners.set(value, prefix); return; }
          // Inspect data properties only: do not invoke application getters.
          let fields = 0;
          for (const key in value) {
            if (fields++ >= 64) break;
            const child = Object.getOwnPropertyDescriptor(value, key)?.value;
            if (child instanceof Map || Array.isArray(child)) owners.set(child, prefix + '.' + key);
          }
        };
        const slots = globalThis[Symbol.for('@papercusp/module-singleton.slots')];
        if (slots instanceof Map) {
          let count = 0;
          for (const [key, slot] of slots) {
            if (count++ >= 256) break;
            register(slot?.value, String(key));
          }
        }
        register(globalThis[Symbol.for('@papercusp/p011.retainer.fixture')], 'private-fixture');
        const start = Date.now();
        const top = [];
        const owned = [];
        const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
        let examined = 0, checked = 0, notApplicable = 0, totalEntries = 0;
        for (const value of this) {
          if (examined >= limit || Date.now() - start >= budgetMs) break;
          examined++;
          let entries;
          if (type === 'array') {
            if (!Array.isArray(value)) { notApplicable++; continue; }
            entries = value.length;
          } else {
            // Prototype descendants may lack the builtin's internal slots.
            try { entries = mapSize.call(value); }
            catch (error) {
              if (!(error instanceof TypeError)) throw error;
              notApplicable++; continue;
            }
          }
          const owner = owners.get(value) ?? null;
          checked++; totalEntries += entries;
          top.push({ entries, owner }); top.sort((a, b) => b.entries - a.entries); top.length = Math.min(top.length, 10);
          if (owner && owned.length < 32) owned.push({ entries, owner });
        }
        return { kind: type, population: this.length, checked, notApplicable, notChecked: this.length - examined,
          totalEntries, top, owned, inspectionMs: Date.now() - start,
          limits: { objects: limit, inspectionMs: budgetMs, owners: 32, slots: 256, fieldsPerSlot: 64 },
          definition: 'Surviving container entries; not retained bytes or a complete retainer graph.' };
      }`,
    });
    if (result.exceptionDetails) throw new Error('Retained-container aggregate failed: ' +
      (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text).slice(0, 500));
    return { ...result.result.value, elapsedMs: Date.now() - startedAt, intervention: 'queryObjects GC/enumeration' };
  } finally {
    await client.send('Runtime.releaseObjectGroup', { objectGroup: group });
  }
}

describe.skipIf(process.platform !== 'linux')('P-011 private request-host memory cohort', () => {
  it.skipIf(process.env.PAPERCUSP_P011_SPAWNER_PAIR !== '1')('compares full-host and standalone spawner boot with equivalent private IPC and cleanup', () => {
    const destination = evidenceDestination(process.env.PAPERCUSP_P011_SPAWNER_PAIR_REPORT);
    if (!destination) throw Error('Spawner pair evidence destination is required before building');
    const directory = mkdtempSync(join(tmpdir(), 'papercusp-spawner-pair-'));
    const full = join(directory, 'full', 'hono-host.mjs');
    const standalone = join(directory, 'standalone', 'spawner-sidecar.mjs');
    const raw = join(directory, 'report.json');
    const paths = ['apps/operator/bin/hono-host.ts', 'apps/operator/bin/spawner-sidecar.ts',
      'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/bundle-host-common.sh',
      'packages/operator-core/lib/fleet/spawner-sidecar-server.ts',
      'packages/operator-core/lib/fleet/sidecar-exec-process.ts',
      'packages/operator-core/lib/fleet/sidecar-exec-lifetime.ts',
      'packages/operator-core/lib/flag-override-store-boot-effect.ts',
      'scripts/cdp-inspector.mjs', 'scripts/with-test-pg.mjs'];
    const sources = () => paths.map(path => ({ path,
      sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex') }));
    const before = sources();
    const builds: any[] = [];
    const probe = String.raw`
      const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
      const { spawn } = require('node:child_process');
      const { pathToFileURL } = require('node:url');
      const { createHash } = require('node:crypto');
      const { performance } = require('node:perf_hooks');
      const e = process.env, wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const report = { schemaVersion: 'p011-spawner-boot-pair-v1', incomplete: true, cohorts: [],
        scope: 'Private emitted artifacts, same maintained spawner server, harmless process:exec only; no production routing or agent launch.',
        limitations: ['Unforced PSS/heap includes transient state; no GC events or retained-owner proof.',
          'V8 cumulative allocation is not a native allocation estimate. Full transitive source identity is unknown.'] };
      const publish = () => fs.writeFileSync(e.TEST_REPORT_PATH, JSON.stringify(report, null, 2));
      const fields = pid => { const value = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
        return value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/); };
      const identity = pid => ({ pid, ppid: Number(fields(pid)[1]), startTicks: fields(pid)[19] });
      const alive = row => { try { return fields(row.pid)[19] === row.startTicks; } catch { return false; } };
      const osMemory = pid => { const text = fs.readFileSync('/proc/' + pid + '/smaps_rollup', 'utf8');
        const pss = text.match(/^Pss:\s+(\d+) kB$/m); if (!pss) throw Error('PSS unavailable');
        return { ...identity(pid), pssBytes: Number(pss[1]) * 1024 }; };
      (async () => {
        if (!e.PAPERCUSP_WORKSPACE_ID.startsWith('test-runtime-') || !e.TMPDIR ||
            e.TMPDIR === require('node:os').tmpdir() && !e.TMPDIR.includes('papercusp-test-runtime-')) {
          throw Error('Disposable runtime identity/temp preflight failed');
        }
        const { createCdpClient, readProcessMemory } = await import(pathToFileURL(e.TEST_INSPECTOR_PATH).href);
        // Reverse the order in the second pair to expose a simple order effect.
        for (const [arm, mode] of ['full', 'standalone', 'standalone', 'full'].entries()) {
          const entry = mode === 'full' ? e.TEST_FULL_PATH : e.TEST_STANDALONE_PATH;
          const socketPath = path.join(e.TMPDIR, 'papercusp-spawner-' + process.pid + '.sock');
          const cohort = { arm, mode, bundleSha256: createHash('sha256').update(fs.readFileSync(entry)).digest('hex'),
            samples: [], windows: [], descendants: [], reaped: false, forcedCleanup: false, socketRemoved: false };
          report.cohorts.push(cohort); publish();
          let host, cdp, socket, startup = '', tail = '', pending = new Map();
          const observed = new Map();
          let nextId = 1, buffer = '';
          try {
            const started = performance.now();
            host = spawn(process.execPath, ['--inspect=127.0.0.1:0', entry], {
              cwd: path.join(process.cwd(), 'apps/operator'),
              env: { ...e, VITEST: '', MALLOC_ARENA_MAX: e.TEST_MALLOC_ARENA_MAX,
                PAPERCUSP_SPAWNER_SIDECAR_MODE: '1', PAPERCUSP_SPAWNER_IPC_SOCKET: socketPath,
                PAPERCUSP_HONO_PORT: '0', PORT: '0', PAPERCUSP_BACKGROUND_WORKERS: '0',
                PAPERCUSP_DB_POOL_MAX: '2' }, stdio: ['ignore', 'pipe', 'pipe'] });
            cohort.identity = identity(host.pid);
            for (const stream of [host.stdout, host.stderr]) stream.setEncoding('utf8').on('data', value => {
              startup += value; tail = (tail + value).slice(-2500); });
            const deadline = Date.now() + 90000;
            while (!startup.includes('PAPERCUSP_SPAWNER_READY socket=' + socketPath)) {
              if (host.exitCode !== null || host.signalCode !== null) throw Error('Spawner exited before ready: ' + tail);
              if (Date.now() >= deadline) throw Error('Spawner readiness timed out: ' + tail);
              await wait(100);
            }
            cohort.readyMs = performance.now() - started;
            const endpoint = [...startup.matchAll(/^Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+)\r?$/gm)].at(-1)?.[1];
            if (!endpoint) throw Error('Private inspector endpoint unavailable');
            cdp = createCdpClient(endpoint); await cdp.connect();
            const bound = (await cdp.evaluate('({pid:process.pid,entry:process.argv[1],arena:process.env.MALLOC_ARENA_MAX})',
              { returnByValue: true })).result.value;
            if (bound.pid !== host.pid || bound.entry !== entry || bound.arena !== e.TEST_MALLOC_ARENA_MAX)
              throw Error('Spawner inspector executable/allocator mismatch');
            cohort.bound = bound;
            socket = net.createConnection(socketPath);
            await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
            socket.setEncoding('utf8');
            socket.on('data', data => {
              buffer += data;
              for (;;) { const newline = buffer.indexOf('\n'); if (newline < 0) break;
                const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
                if (message.method === 'spawn:pid') {
                  const row = identity(message.params.pid);
                  if (row.ppid !== host.pid) throw Error('IPC child is not owned by private spawner');
                  observed.set(row.pid + ':' + row.startTicks, { ...row, requestId: message.params.requestId });
                } else if (message.id != null && pending.has(message.id)) {
                  const callback = pending.get(message.id); pending.delete(message.id);
                  message.error ? callback.reject(Error(JSON.stringify(message.error))) : callback.resolve(message.result);
                }
              }
            });
            socket.on('error', error => { for (const callback of pending.values()) callback.reject(error); pending.clear(); });
            const rpc = (method, params) => new Promise((resolve, reject) => {
              const id = nextId++, timer = setTimeout(() => { pending.delete(id); reject(Error('Private IPC deadline')); }, 20000);
              pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); },
                reject: error => { clearTimeout(timer); reject(error); } });
              socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
            });
            const control = await rpc('spawn:cancel', {});
            const fence = control.processExecFence;
            if (control.cancelled !== false || control.processExecCancellation !== true ||
                typeof fence?.serverGeneration !== 'string' || typeof fence?.connectionId !== 'string')
              throw Error('Execution capability/fence preflight failed: ' + JSON.stringify(control));
            cohort.fenceVerified = true;
            const run = async token => {
              const source = 'const start=Date.now();setTimeout(()=>process.stdout.write(JSON.stringify({token:' +
                JSON.stringify(token) + ',start,end:Date.now()})),350);';
              const result = await rpc('process:exec', { command: process.execPath, args: ['-e', source],
                cwd: e.TMPDIR, timeoutMs: 15000, workspaceId: e.PAPERCUSP_WORKSPACE_ID, ownerId: 'p011-private-spawner', fence });
              if (result.code !== 0 || result.stderr !== '') throw Error('Harmless command failed: ' + JSON.stringify(result));
              const value = JSON.parse(result.stdout);
              if (value.token !== token || value.end - value.start < 300) throw Error('Harmless output mismatch');
              return value;
            };
            // Warm IPC/governor before the idle/workload comparison, separately from boot.
            const sample = async phase => {
              const memory = await readProcessMemory(cdp, { expectedPid: host.pid, hostFacts: true, allocationDetails: true });
              const os = osMemory(host.pid);
              if (os.startTicks !== cohort.identity.startTicks) throw Error('Spawner PID identity changed');
              cohort.samples.push({ phase, ...memory, os }); publish();
            };
            await sample('ready'); await run('warm'); await sample('warm');
            for (let window = 0; window < 3; window++) {
              await sample('idle-' + window + '-start'); await wait(1000); await sample('idle-' + window + '-end');
              const started = performance.now();
              const outcomes = await Promise.all(Array.from({ length: 4 }, (_, i) => run('window-' + window + '-' + i)));
              const concurrent = Math.max(...outcomes.map(row => row.start)) < Math.min(...outcomes.map(row => row.end));
              if (!concurrent) throw Error('Four-command concurrency was not preserved');
              cohort.windows.push({ window, wallMs: performance.now() - started, concurrent, outcomes });
              await sample('workload-' + window + '-end');
            }
            await wait(1000); await sample('completion-idle');
          } finally {
            if (cdp) await cdp.close();
            if (socket) socket.destroy();
            for (const callback of pending.values()) callback.reject(Error('Cohort cleanup')); pending.clear();
            if (host && host.exitCode === null && host.signalCode === null) {
              const exited = new Promise(resolve => host.once('exit', resolve)); host.kill('SIGTERM');
              await Promise.race([exited, wait(5000)]);
              if (host.exitCode === null && host.signalCode === null) {
                cohort.forcedCleanup = true; host.kill('SIGKILL'); await exited;
              }
            }
            cohort.reaped = Boolean(host && (host.exitCode !== null || host.signalCode !== null));
            cohort.socketRemoved = !fs.existsSync(socketPath);
            cohort.descendants = [...observed.values()];
            cohort.unreaped = cohort.descendants.filter(alive);
            cohort.startupTail = tail;
            publish();
            if (!cohort.reaped || cohort.forcedCleanup || !cohort.socketRemoved || cohort.unreaped.length)
              throw Error('Spawner/descendant/socket cleanup failed');
          }
        }
        report.incomplete = false;
      })().catch(error => { report.error = String(error.stack || error); process.exitCode = 1; }).finally(publish);
    `;
    let phase = 'bundle-preflight';
    try {
      expect(() => new Function(probe)).not.toThrow();
      symlinkSync(resolve(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
      for (const [entry, output] of [['bin/hono-host.ts', full], ['bin/spawner-sidecar.ts', standalone]]) {
        const built = runCohortWithLog([resolve(root, 'scripts/npm-install-safe.mjs'), '--repo-root', root,
          '--exec-under-lock', '--', resolve(root, 'apps/operator/bin/bundle-host.sh'), entry, output],
        { cwd: root, env: process.env, timeout: 180000 }, join(directory, entry.includes('hono') ? 'full-build.log' : 'standalone-build.log'));
        builds.push({ entry, output, ...built.log, status: built.status, tail: built.stderr });
        expect(built.status, built.stderr).toBe(0);
      }
      phase = 'runtime-cohorts';
      const result = runCohortWithLog([resolve(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime=operator-api', '--',
        process.execPath, '-e', probe], { cwd: root, timeout: 360000, env: { ...process.env,
          TEST_FULL_PATH: full, TEST_STANDALONE_PATH: standalone, TEST_REPORT_PATH: raw,
          TEST_INSPECTOR_PATH: resolve(root, 'scripts/cdp-inspector.mjs'), TEST_MALLOC_ARENA_MAX: HOST_MALLOC_ARENA_MAX } },
      join(directory, 'runtime.log'));
      const report = readCohortReport(raw, result);
      report.builds = builds; report.sources = { before, after: sources(), fullGraph: 'unknown' };
      report.runtimeLog = result.log;
      writeFileSync(destination, serializeIdentitySafeJson(report));
      phase = 'report-verification';
      expect(result.status, report.error ?? result.stderr).toBe(0);
      expect(report.incomplete).toBe(false); expect(report.cohorts).toHaveLength(4);
      expect(report.sources.before).toEqual(report.sources.after);
      auditSpawnerResourcePair(report);
      for (const cohort of report.cohorts) {
        expect(cohort.fenceVerified).toBe(true); expect(cohort.reaped).toBe(true);
        expect(cohort.forcedCleanup).toBe(false); expect(cohort.socketRemoved).toBe(true);
        expect(cohort.unreaped).toEqual([]); expect(cohort.descendants).toHaveLength(13);
        expect(cohort.samples).toHaveLength(12); expect(cohort.windows).toHaveLength(3);
        for (const sample of cohort.samples) {
          expect(sample.os.pssBytes).toBeGreaterThan(0);
          expect(sample.heap.total_allocated_bytes).toBeGreaterThan(0);
          expect(sample.hostFacts.sidecarFlags.spawner).toBe(true);
          expect(sample.hostFacts.backgroundWorkersOverride).toBe('disabled');
        }
        expect(cohort.windows.flatMap((window: any) => window.outcomes.map((row: any) => row.token)))
          .toEqual(Array.from({ length: 3 }, (_, w) => Array.from({ length: 4 }, (_, i) => 'window-' + w + '-' + i)).flat());
      }
    } catch (error) {
      const report = existsSync(destination) ? JSON.parse(readFileSync(destination, 'utf8')) :
        { incomplete: true, phase, error: String(error), builds, sources: { before, after: sources(), fullGraph: 'unknown' } };
      report.verificationError = String(error); writeFileSync(destination, serializeIdentitySafeJson(report));
      throw error;
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 750000);

  describe('P-011 saved spawner acceptance counterexamples', () => {
    const fixturePath = 'docs/evidence/papercusp-oct1-p011-spawner-safe-boot-pair-r3-2026-10-02.json';
    const fixtureSha256 = 'a4650f459bd06d407650144d52d3716dce98e31a35cae7c5e7eb042b3a5981e9';
    const startedAt = new Date().toISOString();
    let accepted = false;
    const killed: { id: string; rejection: string }[] = [];
    const fixture = () => {
      const bytes = readFileSync(join(root, fixturePath));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixtureSha256);
      return JSON.parse(bytes.toString('utf8'));
    };
    const cases: [string, string, (report: any) => void][] = [
      ['rss-only', 'PSS required', r => { for (const c of r.cohorts) for (const s of c.samples) delete s.os.pssBytes; }],
      ['allocation-missing', 'cumulative V8 allocation required', r => { delete r.cohorts[1].samples[0].heap.total_allocated_bytes; }],
      ['allocation-reset', 'cumulative V8 allocation required', r => { r.cohorts[1].samples.at(-1).heap.total_allocated_bytes = 1; }],
      ['pid-reused', 'sample identity', r => { r.cohorts[1].samples.at(-1).os.startTicks = '1'; }],
      ['wrong-inspector', 'process identity', r => { r.cohorts[1].bound.pid++; }],
      ['allocator-changed', 'allocator mismatch', r => { r.cohorts[1].bound.arena = '8'; }],
      ['workload-omitted', 'equivalent command outcomes', r => { r.cohorts[1].windows[0].outcomes.pop(); }],
      ['outcome-changed', 'equivalent command outcomes', r => { r.cohorts[1].windows[0].outcomes[0].token = 'different'; }],
      ['concurrency-label-lies', 'actual command concurrency', r => {
        const rows = r.cohorts[1].windows[0].outcomes;
        rows[3].start = rows[0].end + 1; rows[3].end = rows[3].start + 350;
      }],
      ['idle-phase-omitted', 'matched phases', r => { r.cohorts[1].samples.splice(2, 1); }],
      ['source-drift', 'source drift', r => { r.sources.after[0].sha256 = '0'.repeat(64); }],
      ['artifact-drift', 'within-mode artifact drift', r => { r.cohorts[2].bundleSha256 = '0'.repeat(64); }],
      ['unreaped-child', 'cleanup or capability', r => { r.cohorts[1].unreaped.push(r.cohorts[1].descendants[0]); }],
      ['forced-cleanup', 'cleanup or capability', r => { r.cohorts[1].forcedCleanup = true; }],
      ['pss-only-one-pair', 'both pairs must reduce PSS', r => { r.cohorts[2].samples.at(-1).os.pssBytes = r.cohorts[3].samples.at(-1).os.pssBytes; }],
      ['allocation-only-one-pair', 'both pairs must reduce cumulative V8 allocation', r => {
        r.cohorts[2].samples.at(-1).heap.total_allocated_bytes = r.cohorts[3].samples.at(-1).heap.total_allocated_bytes;
      }],
    ];
    it('accepts the exact measured receipt using raw counters and outcomes', () => {
      const measured = auditSpawnerResourcePair(fixture());
      expect(measured).toEqual([
        { baselineArm: 0, candidateArm: 1, finalPssReductionBytes: 419844096, finalCumulativeV8AllocationReductionBytes: 1031421856 },
        { baselineArm: 3, candidateArm: 2, finalPssReductionBytes: 433133568, finalCumulativeV8AllocationReductionBytes: 1061171864 },
      ]);
      accepted = true;
    });
    it.each(cases)('rejects %s against the independently derived resource contract', (id, rejection, change) => {
      const report = fixture(); change(report);
      expect(() => auditSpawnerResourcePair(report)).toThrow(rejection);
      killed.push({ id, rejection });
    });
    afterAll(() => {
      const destination = evidenceDestination(process.env.PAPERCUSP_P011_SPAWNER_ORACLE_REPORT);
      if (!destination) return;
      writeFileSync(destination, serializeIdentitySafeJson({ schemaVersion: 'p011-spawner-resource-oracle-v1',
        spec: { id: 'PERF-OCT1-P011-MEMORY', revision: 2,
          fingerprint: '6059e251ea51a61458afd5075a8190a60e1f1139d28c55784b4ff12d2c624010' },
        startedAt, endedAt: new Date().toISOString(), incomplete: !accepted || killed.length !== cases.length,
        accepted, counterexamples: killed, expectedCounterexamples: cases.length,
        fixture: { path: fixturePath, sha256: fixtureSha256 },
        oracle: { path: 'packages/operator-core/lib/service-memory-attribution.integration.test.ts',
          sha256: createHash('sha256').update(readFileSync(__filename)).digest('hex'),
          independentOf: 'No cohort-writer import or reduction/concurrency headline used; raw OS/V8 counters and command timestamps determine acceptance.' },
        scope: 'Counterexample acceptance of the exact saved private spawner receipt only; no runtime cohort replay.',
        limits: ['Cumulative V8 allocation is not retained or native allocation.', 'Unforced counters include transient state; GC events were not recorded.',
          'Historical named-source scope and full executed graph unknown are preserved.',
          'Other selected sources, live paired savings, parent fulfillment, independent plan grading and shipment remain open.'] }));
    });
  });

  describe('P-011 selected saved-source acceptance counterexamples', () => {
    type Corruption = [string, string, (report: any) => void];
    const suites: { id: string; path: string; sha256: string; audit: (report: any) => any;
      expected: any; cases: Corruption[] }[] = [
      { id: 'inbox', path: 'docs/evidence/papercusp-oct1-p011-inbox-physical-pair-r4-2026-10-02.json',
        sha256: '8da0585c8cd1155c563aed2dc092a7413ff90b5a0fc7095873b7dcdde0c4ae58', audit: auditSavedInboxPair,
        expected: { pssGrowthDifferenceBytes: 210301952, cumulativeV8AllocationGrowthDifferenceBytes: 288349304,
          rawCopies: [8, 1], preservedBodyCodeUnits: 8388608, responsesPerHost: 24,
          actualConcurrency: 'unmeasured: per-request start/end timestamps absent', productionSavings: 'unmeasured' },
        cases: [
          ['incomplete', 'incomplete run', r => { r.incomplete = true; }],
          ['source-drift', 'source drift', r => { r.sources.after[Object.keys(r.sources.after)[0]] = '0'.repeat(64); }],
          ['pid-reused', 'sample identity', r => { r.cohorts[1].samples.at(-1).os.startTicks = '1'; }],
          ['rss-only', 'PSS required', r => { delete r.cohorts[1].samples[0].os.pssBytes; }],
          ['allocation-reset', 'cumulative V8 allocation required', r => { r.cohorts[1].samples.at(-1).heap.total_allocated_bytes = 1; }],
          ['missing-idle', 'matched phases', r => { r.cohorts[1].samples.splice(2, 1); }],
          ['paused', 'cleanup or debugger pause', r => { r.cohorts[1].pauses = 1; }],
          ['unreaped', 'cleanup or debugger pause', r => { r.cohorts[1].reaped = false; }],
          ['warm-cache', 'cold cache', r => { r.cohorts[1].cachePreflight.entries = 1; }],
          ['fixture-and-digest-forged', 'independently regenerated raw context', r => {
            for (const c of r.cohorts) { c.fixture.sha256 = '0'.repeat(64); for (const row of c.content) row.sha256 = c.fixture.sha256; }
          }],
          ['body-truncated', 'complete raw content and sharing', r => { r.cohorts[1].content[0].stringCodeUnits--; }],
          ['duplicate-raw-copy', 'complete raw content and sharing', r => { r.cohorts[1].content.push(r.cohorts[1].content[0]); }],
          ['observed-copy-mismatch', 'observed sharing population', r => { r.cohorts[1].samples.at(-1).cache.entries = 8; }],
          ['response-omitted', 'response population', r => { r.cohorts[1].windows[0].outcomes.pop(); }],
          ['both-arms-lose-context', 'useful response parity', r => {
            for (const c of r.cohorts) c.windows[0].outcomes[0].entries[0].id = 'p011-wrong';
          }],
          ['display-variant-changed', 'display variant contract', r => { r.variants[0].limit = 2; }],
          ['pss-no-reduction', 'paired resource observation', r => {
            const c = r.cohorts[1], b = r.cohorts[0];
            c.samples.at(-1).os.pssBytes = c.samples[0].os.pssBytes + b.samples.at(-1).os.pssBytes - b.samples[0].os.pssBytes;
          }],
          ['allocation-no-reduction', 'paired resource observation', r => {
            const c = r.cohorts[1], b = r.cohorts[0];
            c.samples.at(-1).heap.total_allocated_bytes = c.samples[0].heap.total_allocated_bytes +
              b.samples.at(-1).heap.total_allocated_bytes - b.samples[0].heap.total_allocated_bytes;
          }],
        ] },
      { id: 'expiry', path: 'docs/evidence/papercusp-oct1-p011-cache-resource-comparison-r10-2026-10-01.json',
        sha256: '07672507519848b146e761652372f82584222c4e9c20b05e8e607e5ca49d1df5', audit: auditSavedExpiryPair,
        expected: { expiredReachable: [438, 0], usefulEntries: 604, heapUsedDifferenceBytes: 163653752,
          pssDifferenceBytes: -17983488, physicalPssReductionObserved: false, cumulativeV8Allocation: 'unmeasured',
          usefulContentParity: 'unmeasured: saved entry counts and cache statistics only',
          processStartTicks: 'unmeasured', productionSavings: 'unmeasured' },
        cases: [
          ['fixture-count', 'fixture population', r => { r.fixture.useful--; }],
          ['same-process', 'matched arms', r => { r.measurements.current.pid = r.measurements.control.pid; }],
          ['different-node', 'matched arms', r => { r.measurements.current.node = 'different'; }],
          ['different-generation', 'matched arms', r => { r.measurements.current.sourceHashes.generationStore = '0'.repeat(64); }],
          ['wrong-expiry-phase', 'expiry and ordinary-read phases', r => { r.measurements.current.expiredIdle.reachable = 0; }],
          ['missing-ordinary-reads', 'expiry and ordinary-read phases', r => { r.measurements.current.reclamation.reads = 0; }],
          ['rss-only', 'separate heap and PSS counters', r => { delete r.measurements.current.ordinary.memory.pssBytes; }],
          ['expired-root-left', 'expired roots removed', r => { r.measurements.current.ordinary.reachable = 1; }],
          ['useful-entry-lost', 'expired roots removed', r => { r.measurements.current.ordinary.entries--; }],
          ['miss-regression', 'cache outcomes', r => { r.measurements.current.stats.misses++; }],
          ['heap-no-reclamation', 'heap reclamation', r => {
            r.measurements.current.ordinary.memory.heapUsed = r.measurements.control.ordinary.memory.heapUsed;
          }],
          ['cleanup-root-left', 'cleanup roots', r => { r.measurements.current.cleared.reachable = 1; }],
        ] },
      { id: 'compiler', path: 'docs/evidence/papercusp-oct1-p011-serving-compiler-r24-2026-10-02.json',
        sha256: 'd3929023e6b7586ff35b382989a266594cd0da41a6d201ab03bfb3a056ee3ead', audit: auditSavedCompilerCaller,
        expected: { tracedForks: [0, 3], nativeDescendants: 3,
          nativeExecutableSha256: 'fd49340cbb5f7ca3ce6f313db78d056de21f07338135ec8dfad63294a304fd2c',
          nativeSampleCounts: [3, 4, 4], hostResourceSamples: [5, 5],
          scope: 'Historical private refused preflight caller and final cleanup only',
          pairedPssReduction: 'unmeasured: these arms distinguish invocation, not an optimization',
          namedSourceCurrentness: 'unmeasured in raw receipt; separate historical qualification required',
          historicalGigabyteRecovery: 'unmeasured', productionSavings: 'unmeasured' },
        cases: [
          ['incomplete', 'incomplete run', r => { r.incomplete = true; }],
          ['bundle-drift', 'serving artifact identity', r => { r.cohorts[1].identity.bundleSha256 = '0'.repeat(64); }],
          ['pid-reused', 'sample identity', r => { r.cohorts[1].samples.at(-1).os.startTicks = '1'; }],
          ['rss-only', 'PSS and cumulative V8 counters', r => { delete r.cohorts[1].samples[0].os.pssKiB; }],
          ['allocation-reset', 'PSS and cumulative V8 counters', r => { r.cohorts[1].samples.at(-1).heap.total_allocated_bytes = 1; }],
          ['request-omitted', 'request population', r => { r.cohorts[1].requests.pop(); }],
          ['request-mismatch', 'matched HTTP inputs', r => { r.cohorts[1].requests[0].requestSha256 = '0'.repeat(64); }],
          ['test-process-started', 'real refused preflight', r => { r.cohorts[1].requests[0].value.testRunIds.push(1); }],
          ['wrong-caller-path', 'distinguishing caller path', r => { r.cohorts[1].requests[0].value.hint = 'not a code module'; }],
          ['wrong-trace-target', 'trace identity and coverage', r => { r.cohorts[1].trace.pid++; }],
          ['wrong-fork-caller', 'actual compiler caller', r => { r.cohorts[1].trace.calls.fork.stacks = ['different']; }],
          ['basename-only', 'executable-identified population', r => {
            for (const d of r.cohorts[1].descendants) if (d.executable.endsWith('/esbuild')) d.executableSha256 = '0'.repeat(64);
          }],
          ['wrong-parent', 'native descendant ancestry', r => {
            r.cohorts[1].descendants.find((d: any) => d.executable.endsWith('/esbuild')).parent = 1;
          }],
          ['native-no-samples', 'native resource observation', r => {
            r.cohorts[1].descendants.find((d: any) => d.executable.endsWith('/esbuild')).samples = 0;
          }],
          ['post-request-child', 'post-request descendants', r => { r.cohorts[1].samples.at(-1).descendants.push(r.cohorts[1].descendants[0]); }],
          ['unreaped-child', 'cleanup or pause', r => { r.cohorts[1].unreaped.push(r.cohorts[1].descendants[0]); }],
        ] },
    ];
    const startedAt = new Date().toISOString();
    const results: any[] = [];
    for (const suite of suites) {
      describe(suite.id, () => {
        const result = { id: suite.id, fixture: { path: suite.path, sha256: suite.sha256 }, accepted: false,
          headlineIgnored: false, measured: null as any, expectedCounterexamples: suite.cases.length,
          counterexamples: [] as { id: string; rejection: string }[] };
        results.push(result);
        const fixture = () => {
          const bytes = readFileSync(join(root, suite.path));
          expect(createHash('sha256').update(bytes).digest('hex')).toBe(suite.sha256);
          return JSON.parse(bytes.toString('utf8'));
        };
        it('accepts exact raw counters and preserves unmeasured conclusions', () => {
          result.measured = suite.audit(fixture());
          expect(result.measured).toEqual(suite.expected);
          result.accepted = true;
        });
        it('ignores a fabricated resource and acceptance headline', () => {
          const report = fixture();
          report.summary = { physicalPssReductionObserved: true, productionSavingsBytes: 1e12, acceptance: 'passed' };
          expect(suite.audit(report)).toEqual(suite.expected);
          result.headlineIgnored = true;
        });
        it.each(suite.cases)('rejects %s from raw evidence', (id, rejection, change) => {
          const report = fixture(); change(report);
          expect(() => suite.audit(report)).toThrow(rejection);
          result.counterexamples.push({ id, rejection });
        });
      });
    }
    afterAll(() => {
      const destination = evidenceDestination(process.env.PAPERCUSP_P011_SELECTED_ORACLE_REPORT);
      if (!destination) return;
      writeFileSync(destination, serializeIdentitySafeJson({ schemaVersion: 'p011-selected-resource-oracles-v1',
        spec: { id: 'PERF-OCT1-P011-MEMORY', revision: 2,
          fingerprint: '6059e251ea51a61458afd5075a8190a60e1f1139d28c55784b4ff12d2c624010' },
        startedAt, endedAt: new Date().toISOString(), results,
        incomplete: results.some(r => !r.accepted || !r.headlineIgnored || r.counterexamples.length !== r.expectedCounterexamples),
        oracle: { path: 'packages/operator-core/lib/service-memory-attribution.integration.test.ts',
          sha256: createHash('sha256').update(readFileSync(__filename)).digest('hex'),
          independentOf: 'No cohort emitter or summary used; raw counters, regenerated input and response expectations, caller/ancestry evidence determine scoped conclusions.' },
        scope: 'Saved historical private data acceptance and targeted data-corruption controls; no runtime cohort replay.',
        limits: ['Expiry heap reclamation does not establish PSS reduction or cumulative allocation.',
          'Inbox concurrent batch outcomes are preserved; actual overlap timestamps are absent.',
          'Compiler receipt distinguishes invocation and cleanup, not paired optimization or historical recovery.',
          'Named-source and executed-graph limits, live paired savings, parent acceptance and shipment remain open.'] }));
    });
  });

  it('refuses absent or ambiguous full-key counterfactuals before preparing a runtime', () => {
    const key = '...boundedInbox ? { limit, ambient: includeAmbient, intents: !!args.include_intents } : {}';
    const restored = restoreFullInboxKey('prefix ' + key + ' suffix');
    expect(restored.bundle).toBe('prefix limit, ambient: includeAmbient, intents: !!args.include_intents suffix');
    // esbuild renames colliding handler arguments in the actual host graph.
    expect(restoreFullInboxKey(key.replace('args.', 'args27.')).bundle)
      .toBe('limit, ambient: includeAmbient, intents: !!args27.include_intents');
    expect(() => restoreFullInboxKey('unrelated bundle')).toThrow('exactly one');
    expect(() => restoreFullInboxKey(key + key)).toThrow('exactly one');
  });

  it('checks the real cache cold-bust API before an expensive paired runtime', async () => {
    const cache = createCache();
    await cache.getOrSet('private', 'coord:inbox:guard', async () => ['useful'], { tags: ['coord_event_log'] });
    expect(preparePairCache({ cache, cacheLayerOn: true })).toEqual({ enabled: true, entries: 0 });
    expect(() => preparePairCache({ cache: { clear() {} }, cacheLayerOn: true })).toThrow('API/owner');
    expect(() => preparePairCache({ cache, cacheLayerOn: false })).toThrow('API/owner');
  });

  describe('P-011 serving inbox copy guards', () => {
    const fixture = () => ({ health: { sha: 'a'.repeat(10), version: '0.0.0' },
      process: { pid: 7, startTicks: '11', entry: '/private/hono-host.mjs', executableSha256: 'b'.repeat(64), ownsStagingSocket: true },
      artifacts: ['hono-host.mjs', 'mutation-probe-closure.worker.mjs', 'spawner-sidecar.mjs'].map(path =>
        ({ path, bytes: 3, sha256: 'c'.repeat(64) })) });
    it('keeps loaded health identity separate from artifact and process identity', () => {
      expect(() => assertServingInboxPin(fixture(), structuredClone(fixture()))).not.toThrow();
      expect(servingInboxHealth({ ok: true, service: 'papercusp-operator', sha: 'a'.repeat(10), version: '0.0.0' }, 'a'.repeat(10)))
        .toEqual(fixture().health);
    });
    it('rejects missing or failed runner provenance without inventing a resource verdict', () => {
      for (const runner of [undefined, { status: 1 }]) {
        expect(() => auditSavedInboxPair({ incomplete: false, runner })).toThrow('incomplete run');
      }
    });
    it('reads serving health on a fresh socket across synchronous runtime work', async () => {
      // The independent server can retire a socket while this test's event loop
      // is blocked, just as the real peer can during runCohortWithLog/spawnSync.
      // Shared counters prove a stable peer and distinguish a reused closed
      // socket from a new request; no production process or cohort is started.
      const run = async (read: (endpoint: string) => Promise<unknown>) => {
        const state = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
        const worker = new Worker(`
          const { parentPort, workerData } = require('node:worker_threads');
          const state = new Int32Array(workerData);
          const server = require('node:http').createServer((req, res) => {
            Atomics.add(state, 2, 1);
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Keep-Alive', 'timeout=60');
            res.end(JSON.stringify({ ok: true, service: 'papercusp-operator', sha: 'aaaaaaaaaa', version: '0.0.0' }));
            res.on('finish', () => setTimeout(() => req.socket.destroy(), 100));
          });
          server.on('connection', socket => {
            Atomics.add(state, 0, 1);
            socket.on('close', () => { Atomics.store(state, 1, 1); Atomics.notify(state, 1); });
          });
          server.keepAliveTimeout = 60000;
          server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
        `, { eval: true, workerData: state.buffer });
        try {
          const port = await new Promise<number>((resolvePort, reject) => {
            worker.once('message', resolvePort); worker.once('error', reject);
          });
          const endpoint = 'http://127.0.0.1:' + port + '/api/health';
          await read(endpoint);
          // Let response consumption release the socket into the idle pool.
          // The peer's delayed close still occurs only after we start blocking.
          await new Promise<void>(ready => setImmediate(ready));
          // Block until the peer has closed, without delivering the client's
          // queued socket-close or idle-timer callbacks before the next read.
          expect(Atomics.wait(state, 1, 0, 2000)).not.toBe('timed-out');
          let error: unknown, value: unknown;
          try { value = await read(endpoint); } catch (caught) { error = caught; }
          return { error, value, connections: Atomics.load(state, 0), requests: Atomics.load(state, 2) };
        } finally { await worker.terminate(); }
      };
      const pooled = await run(async endpoint => (await fetch(endpoint)).json());
      console.log('P011_HEALTH_POOLED_PROBE ' + JSON.stringify({ connections: pooled.connections, requests: pooled.requests,
        error: String(pooled.error), cause: (pooled.error as { cause?: { code?: string } })?.cause?.code }));
      expect((pooled.error as { cause?: { code?: string } })?.cause?.code).toBe('UND_ERR_SOCKET');
      expect(pooled.connections).toBe(1); expect(pooled.requests).toBe(1);
      const pinned = await run(endpoint => readServingInboxHealth(endpoint, 'a'.repeat(10)));
      expect(pinned.error).toBeUndefined();
      expect(pinned.value).toEqual({ sha: 'a'.repeat(10), version: '0.0.0' });
      expect(pinned.connections).toBe(2); expect(pinned.requests).toBe(2);
      console.log('P011_HEALTH_SOCKET_GUARD ' + JSON.stringify({ pooled: { error: 'UND_ERR_SOCKET', connections: pooled.connections,
        requests: pooled.requests }, pinned: { connections: pinned.connections, requests: pinned.requests },
        scope: 'Independent local peer; historical staging socket cause remains unproven' }));
    }, 15000);
    it.each([
      ['unknown SHA', { sha: null }], ['other SHA', { sha: 'd'.repeat(10) }],
      ['missing version', { version: undefined }], ['wrong service', { service: 'other' }],
      ['failed response', { ok: false }], ['stale bundle', { bundleStale: { reason: 'old' } }],
    ] as const)('rejects %s health before copy', (_name, change) => {
      expect(() => servingInboxHealth({ ok: true, service: 'papercusp-operator', sha: 'a'.repeat(10), version: '0.0.0', ...change }, 'a'.repeat(10)))
        .toThrow('loaded health identity');
    });
    it.each([
      ['build', (pin: ServingInboxPin) => { pin.health.sha = 'd'.repeat(10); }],
      ['version', (pin: ServingInboxPin) => { pin.health.version = 'next'; }],
      ['PID', (pin: ServingInboxPin) => { pin.process.pid++; }],
      ['start time', (pin: ServingInboxPin) => { pin.process.startTicks = '12'; }],
      ['executable', (pin: ServingInboxPin) => { pin.process.executableSha256 = 'd'.repeat(64); }],
      ['entry', (pin: ServingInboxPin) => { pin.process.entry = '/other/hono-host.mjs'; }],
      ['socket', (pin: ServingInboxPin) => { pin.process.ownsStagingSocket = false; }],
      ['candidate', (pin: ServingInboxPin) => { pin.artifacts[0].sha256 = 'd'.repeat(64); }],
      ['companion', (pin: ServingInboxPin) => { pin.artifacts[1].sha256 = 'd'.repeat(64); }],
      ['missing companion', (pin: ServingInboxPin) => { pin.artifacts.pop(); }],
    ] as const)('rejects %s drift before a resource cohort', (_name, change) => {
      const altered = fixture(); change(altered);
      expect(() => assertServingInboxPin(fixture(), altered)).toThrow('identity or artifact drift');
    });
    it('reads actual copied bytes and rejects a changed worker or extra intervention', () => {
      const directory = mkdtempSync(join(tmpdir(), 'papercusp-inbox-copy-guard-'));
      const candidate = join(directory, 'candidate'), baseline = join(directory, 'baseline');
      const key = '...boundedInbox ? { limit, ambient: includeAmbient, intents: !!args.include_intents } : {}';
      try {
        // cpSync materializes the directory through the same copy seam as a cohort.
        const seed = join(directory, 'seed');
        mkdirSync(seed);
        for (const name of ['hono-host.mjs', 'mutation-probe-closure.worker.mjs', 'spawner-sidecar.mjs'])
          writeFileSync(join(seed, name), name === 'hono-host.mjs' ? key : 'worker');
        cpSync(seed, candidate, { recursive: true }); cpSync(seed, baseline, { recursive: true });
        const source = inboxArtifactManifest(seed), restored = restoreFullInboxKey(key);
        writeFileSync(join(baseline, 'hono-host.mjs'), restored.bundle);
        expect(() => assertInboxArtifactCopy(source, inboxArtifactManifest(candidate), inboxArtifactManifest(baseline), restored.bundle)).not.toThrow();
        writeFileSync(join(baseline, 'mutation-probe-closure.worker.mjs'), 'changed');
        expect(() => assertInboxArtifactCopy(source, inboxArtifactManifest(candidate), inboxArtifactManifest(baseline), restored.bundle)).toThrow('companion or intervention');
        writeFileSync(join(baseline, 'mutation-probe-closure.worker.mjs'), 'worker');
        writeFileSync(join(baseline, 'hono-host.mjs'), restored.bundle + ';extraChange()');
        expect(() => assertInboxArtifactCopy(source, inboxArtifactManifest(candidate), inboxArtifactManifest(baseline), restored.bundle)).toThrow('companion or intervention');
        writeFileSync(join(candidate, 'spawner-sidecar.mjs'), 'changed');
        expect(() => assertInboxArtifactCopy(source, inboxArtifactManifest(candidate), inboxArtifactManifest(baseline), restored.bundle)).toThrow('candidate copy');
        rmSync(join(seed, 'spawner-sidecar.mjs'));
        expect(() => inboxArtifactManifest(seed)).toThrow('companion missing');
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });
    const endpoints = ['test-runtime-private', '0', 'postgresql://127.0.0.1:55555/private', 'http://127.0.0.1:55556', '55555'];
    it('preserves completed raw resources and provenance when the final health read fails', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'papercusp-inbox-postflight-guard-'));
      const destination = join(directory, 'report.json');
      const completed = { cohorts: [{ pid: 7, samples: [{ pssBytes: 8192, allocatedBytes: 4096 }], reaped: true }],
        sources: { before: { test: 'frozen-source' } }, runtimeLog: { bytes: 123, sha256: 'b'.repeat(64) },
        intervention: { offset: 1, before: 'old-key', after: 'shared-key' }, preflight: fixture() };
      try {
        await expect(persistInboxBeforePostflight(completed, destination, async () => {
          throw Error('injected final health socket failure');
        })).rejects.toThrow('final health socket failure');
        expect(JSON.parse(readFileSync(destination, 'utf8'))).toEqual(completed);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });
    it('requires the launcher-owned PG port before any private fixture write', () => {
      expect(privateInboxEndpoints(...endpoints as [string, string, string, string, string])).toMatchObject({ ownedPgPort: 55555 });
    });
    it.each([
      ['ambient identity', 0, 'papercusp-workspace'], ['background host', 1, '1'],
      ['remote database', 2, 'postgresql://remote:55555/private'],
      ['ambient database port', 2, 'postgresql://127.0.0.1:5432/private'],
      ['missing owned port', 4, ''], ['malformed owned port', 4, 'bad'],
      ['remote operator', 3, 'http://remote:55556'], ['live operator', 3, 'http://127.0.0.1:3070'],
      ['staging operator', 3, 'http://127.0.0.1:3170'], ['PG/operator collision', 3, 'http://127.0.0.1:55555'],
    ] as const)('rejects %s endpoints before fixtures', (_name, index, value) => {
      const changed = endpoints.slice(); changed[index] = value;
      expect(() => privateInboxEndpoints(...changed as [string, string, string, string, string])).toThrow('endpoint containment');
    });
  });

  it('selects only the real cachedRead inbox namespace before a paired runtime', async () => {
    const cache = createCache();
    const useful = [{ msg_id: 'useful', body: 'preserved context' }];
    await cache.getOrSet('private', 'coord:inbox|{"limit":1}', async () => useful);
    await cache.getOrSet('private', 'coord:inbox-other|{}', async () => ['other tool']);
    await cache.getOrSet('private', 'plans:get|{"arg":"coord:inbox:"}', async () => ['private decoy']);
    await cache.getOrSet('private', 'coord:inbox:direct', async () => ['different writer']);
    expect(inboxPairEntries({ cache }).map(entry => entry.value)).toEqual([useful]);
    const selected = inboxPairEntries({ cache }, true);
    expect(selected).toEqual([{ keyDigest: createHash('sha256')
      .update('private\u0000coord:inbox|{"limit":1}').digest('hex') }]);
    expect(JSON.stringify(selected)).not.toContain('private');
    expect(inboxPairEntries({ cache })[0].value).toBe(useful);
    expect(() => inboxPairEntries({ cache: {} })).toThrow('entry map');
    cache.clearL1();
    expect(inboxPairEntries({ cache })).toEqual([]);
  });

  describe('P-011 observed inbox overlap guards', () => {
    const fixture = () => ({ pid: 7, identity: { pid: 7, startTicks: '11' },
      windows: Array.from({ length: 3 }, (_, window) => ({ window,
        startedAtMs: window * 100, endedAtMs: window * 100 + 50,
        requests: Array.from({ length: 8 }, (_, variant) => ({ variant, pid: 7, startTicks: '11',
          startedAtMs: window * 100 + variant + 1, endedAtMs: window * 100 + variant + 20 })) })) });
    it('derives eight in-flight requests from intervals without trusting concurrency labels', () => {
      const raw = { ...fixture(), concurrency: 1, summary: { concurrency: 1000 } };
      expect(auditInboxOverlap(raw)).toEqual(Array.from({ length: 3 }, (_, window) =>
        ({ window, requestsInFlight: 8, overlapMs: 12 })));
    });
    it.each([
      ['sequential requests', 'actually overlap', (r: any) => {
        r.windows[0].requests.forEach((q: any, i: number) => { q.startedAtMs = i * 4; q.endedAtMs = i * 4 + 3; });
      }],
      ['wrong PID', 'request identity', (r: any) => { r.windows[0].requests[0].pid++; }],
      ['reused PID', 'request identity', (r: any) => { r.windows[0].requests[0].startTicks = '12'; }],
      ['missing variant', 'variant population', (r: any) => { r.windows[0].requests.pop(); }],
      ['duplicate variant', 'variant population', (r: any) => { r.windows[0].requests[0].variant = 1; }],
      ['cross-window interval', 'request interval', (r: any) => { r.windows[0].requests[0].endedAtMs = 101; }],
      ['reversed interval', 'request interval', (r: any) => { r.windows[0].requests[0].endedAtMs = 0; }],
      ['nonfinite interval', 'request interval', (r: any) => { r.windows[0].requests[0].startedAtMs = NaN; }],
      ['overlapping windows', 'window ordering', (r: any) => { r.windows[1].startedAtMs = 1; }],
    ] as const)('rejects %s', (_name, rejection, change) => {
      const raw = fixture(); change(raw);
      expect(() => auditInboxOverlap(raw)).toThrow(rejection);
    });
  });

  it.runIf(Boolean(process.env.PAPERCUSP_P011_INBOX_OBSERVED_REPORT))('audits new order-reversed inbox resources from raw rows', () => {
    const path = evidenceDestination(process.env.PAPERCUSP_P011_INBOX_OBSERVED_REPORT)!;
    const report = JSON.parse(readFileSync(path, 'utf8'));
    const observed = auditObservedInboxPair(report);
    expect(observed.pairs).toHaveLength(2);
    expect(observed.overlap.flat()).toHaveLength(12);
    report.summary = { reduction: 1e12, concurrency: 1000, productionSavings: 'passed' };
    expect(auditObservedInboxPair(report)).toEqual(observed);
    const corrupt = structuredClone(report);
    corrupt.cohorts[0].windows[0].requests[0].endedAtMs = corrupt.cohorts[0].windows[0].requests[0].startedAtMs;
    expect(() => auditObservedInboxPair(corrupt)).toThrow('request interval');
  });

  it.runIf(Boolean(process.env.PAPERCUSP_P011_INBOX_PAIR_REPORT))('compares order-reversed full inbox keys with observed HTTP overlap', async () => {
    const destination = evidenceDestination(process.env.PAPERCUSP_P011_INBOX_PAIR_REPORT)!;
    const cacheRetainers = process.env.PAPERCUSP_P011_INBOX_HEAP_RETAINERS === '1';
    const traceOnly = process.env.PAPERCUSP_P011_INBOX_ID_LIFETIME_TRACE === '1';
    if (traceOnly && !cacheRetainers) throw Error('Inspector lifetime trace requires the file-snapshot route');
    await assertCohortRunnerBudget(cacheRetainers && !traceOnly ? 1200000 : 570000);
    const nativeAdapter = process.env.PAPERCUSP_P011_NATIVE_HEAP_ADAPTER ?? '';
    const nativeDecoder = process.env.PAPERCUSP_P011_NATIVE_HEAP_DECODER ?? '';
    if (cacheRetainers && (!nativeAdapter || !nativeDecoder))
      throw Error('Inbox cache retainers require the maintained native adapter and decoder before building');
    if (cacheRetainers) for (const [executable, version] of [
      [nativeAdapter, 'papercusp-heap-retainers 0.1.0'], [nativeDecoder, 'v8-heap-cli 0.1.0'],
    ]) {
      const preflight = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000 });
      expect(preflight.status, preflight.stderr).toBe(0);
      expect(preflight.stdout.trim()).toBe(version);
    }
    const directory = mkdtempSync(join(tmpdir(), 'papercusp-inbox-pair-'));
    const current = join(directory, 'current/hono-host.mjs');
    const baseline = join(directory, 'baseline/hono-host.mjs');
    const rawReport = join(directory, 'report.json');
    const sourcePaths = [
      'packages/operator-core/lib/agent-tools/coordination/tools/inbox.ts',
      'packages/operator-core/lib/agent-tools/coordination/messages.ts',
      'packages/operator-core/lib/cache/cached-read.ts',
      'packages/operator-core/lib/cache/instance.ts',
      'libs/generic/cache/src/cache.ts', 'libs/generic/cache/src/l1.ts',
      'scripts/cdp-inspector.mjs', 'apps/operator/bin/bundle-host.sh',
      'scripts/test-files.mjs',
      'packages/operator-core/lib/service-memory-attribution.integration.test.ts',
      ...(traceOnly ? ['packages/operator-core/lib/event-loop-cpu-recorder.ts',
        'packages/operator-core/lib/event-loop-lag-monitor.ts'] : []),
      ...(cacheRetainers ? ['scripts/analyze-heap-snapshots.mjs',
        'scripts/heap-retainers-native/src/main.rs', 'scripts/heap-retainers-native/Cargo.lock'] : []),
    ];
    const sources = () => ({ ...Object.fromEntries(sourcePaths.map(path =>
      [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')])),
      ...(cacheRetainers ? {
        nativeAdapterExecutable: createHash('sha256').update(readFileSync(nativeAdapter)).digest('hex'),
        nativeDecoderExecutable: createHash('sha256').update(readFileSync(nativeDecoder)).digest('hex'),
      } : {}) });
    const beforeSources = sources();
    const probe = String.raw`
      const fs = require('node:fs'), path = require('node:path');
      const { spawn } = require('node:child_process');
      const { createHash } = require('node:crypto');
      const { pathToFileURL } = require('node:url');
      const postgres = require('postgres');
      const preparePairCache = ${preparePairCache.toString()};
      const inboxPairEntries = ${inboxPairEntries.toString()};
      const e = process.env, wait = ms => new Promise(r => setTimeout(r, ms));
      const hash = value => createHash('sha256').update(value).digest('hex');
      const report = { schemaVersion: 2, plane: e.TEST_SOURCE_DIRECTORY ? 'isolated-serving-generation-operator-api' : 'isolated-current-build-operator-api', incomplete: true,
        workload: { population: 256, bodyCodeUnits: 32768, variants: 8, windows: 3, idleMs: 1000, concurrency: 8 },
        cohorts: [], limitations: [
          'Independent private request-only hosts; no production worker, background or historical recovery claim.',
          'Baseline is the same candidate bundle with one guarded historical cache-key intervention.',
          'Unforced heap/PSS windows include transient allocations; no GC, profiler or total native residual estimate.',
          'Eight controlled full-read display variants are a counterexample workload, not measured production frequency.',
          'Exact raw-cache content fingerprints are inspected after the resource windows.'
        ] };
      const publish = () => { fs.writeFileSync(e.TEST_REPORT_PATH, JSON.stringify(report));
        console.error('P011_INBOX_PAIR_PROGRESS ' + JSON.stringify({ cohorts: report.cohorts.map(c =>
          ({ mode: c.mode, samples: c.samples.length, windows: c.windows.length, reaped: c.reaped })), incomplete: report.incomplete })); };
      const fields = pid => { const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' '); };
      const osMemory = pid => {
        const stat = fields(pid), rollup = fs.readFileSync('/proc/' + pid + '/smaps_rollup', 'utf8');
        const bytes = name => { const m = rollup.match(new RegExp('^' + name + ':\\s+(\\d+) kB$', 'm'));
          if (!m) throw Error('Missing process counter ' + name); return Number(m[1]) * 1024; };
        return { pid, startTicks: stat[19], parentPid: Number(stat[1]), executable: fs.readlinkSync('/proc/' + pid + '/exe'),
          executableSha256: hash(fs.readFileSync('/proc/' + pid + '/exe')), pssBytes: bytes('Pss'), rssBytes: bytes('Rss'), anonymousBytes: bytes('Anonymous') };
      };
      const descendants = pid => {
        const rows = [];
        const visit = p => { const text = fs.readFileSync('/proc/' + p + '/task/' + p + '/children', 'utf8').trim();
          for (const child of text ? text.split(/\s+/).map(Number) : []) { if (rows.length >= 64) throw Error('Descendant census exceeded bound');
            try { rows.push(osMemory(child)); visit(child); } catch (err) { if (err.code !== 'ENOENT' && err.code !== 'ESRCH') throw err; } } };
        visit(pid); return rows;
      };
      let sql;
      (async () => {
        if (!e.PAPERCUSP_WORKSPACE_ID.startsWith('test-runtime-') || e.PAPERCUSP_BACKGROUND_WORKERS !== '0')
          throw Error('Private request-only operator-api profile required');
        const { createCdpClient, readProcessMemory, capturePinnedHeapSnapshot, withFunctionCallTrace } = await import(pathToFileURL(e.TEST_INSPECTOR_PATH));
        const cacheRetainers = e.TEST_CACHE_HEAP_RETAINERS === '1';
        const traceOnly = e.TEST_ID_LIFETIME_TRACE === '1';
        report.traceOnly = traceOnly;
        if (traceOnly) report.limitations.push('One shared arm traces only snapshot/ID lifetime; no matched resource or retainer acceptance.');
        if (cacheRetainers) {
          report.limitations.push('Cache snapshots force GC after every unforced resource window; exact V8 nodes do not establish native physical ownership or production savings.');
          for (const [field, executable, version] of [
            ['nativeAdapterPreflight', e.TEST_NATIVE_HEAP_ADAPTER, 'papercusp-heap-retainers 0.1.0'],
            ['nativeDecoderPreflight', e.TEST_NATIVE_HEAP_DECODER, 'v8-heap-cli 0.1.0'],
          ]) {
            const receipt = require('node:child_process').spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000 });
            if (receipt.status !== 0 || receipt.stdout.trim() !== version) throw Error('Inbox native executable preflight failed');
            report[field] = { version, sha256: hash(fs.readFileSync(executable)) };
          }
        }
        const privateEndpoints = (${privateInboxEndpoints.toString()})(e.PAPERCUSP_WORKSPACE_ID,
          e.PAPERCUSP_BACKGROUND_WORKERS, e.HARNESS_ADMIN_DATABASE_URL, e.PAPERCUSP_OPERATOR_URL, e.PAPERCUSP_PG_PORT);
        const privateHome = fs.realpathSync(e.HOME);
        if (!privateHome.startsWith(fs.realpathSync(e.TEST_PRIVATE_PARENT) + path.sep) ||
            !path.basename(path.dirname(privateHome)).startsWith('papercusp-test-runtime-'))
          throw Error('Private inbox database/runtime containment failed');
        report.privateContainment = { ...privateEndpoints, disposableHome: true };
        sql = postgres(e.HARNESS_ADMIN_DATABASE_URL, { max: 1 });
        report.database = (await sql.unsafe('select current_database() as database'))[0].database;
        report.schema = (await sql.unsafe('select filename, sha256 from harness_shared.schema_migrations order by applied_at desc limit 1'))[0];
        const variants = Array.from({ length: 8 }, (_, i) => ({ directed: true, limit: i + 1,
          include_ambient: Boolean(i & 1), include_intents: Boolean(i & 2), max_body_chars: 1 }));
        report.variants = variants;
        for (const [arm, mode] of (traceOnly ? ['shared'] : ['baseline', 'shared', 'shared', 'baseline']).entries()) {
          const entry = mode === 'baseline' ? e.TEST_BASELINE_PATH : e.TEST_CURRENT_PATH;
          const cohort = { arm, mode, bundleSha256: hash(fs.readFileSync(entry)), samples: [], windows: [], pauses: 0,
            descendants: [], reaped: false, forcedCleanup: false };
          report.cohorts.push(cohort); publish();
          let host, client, startup = '', tail = '';
          const seen = new Map();
          const call = async (name, args) => {
            const response = await fetch(e.PAPERCUSP_OPERATOR_URL + '/api/agent-mcp/run-tool', { method: 'POST',
              headers: { 'content-type': 'application/json', 'x-papercusp-workspace': e.PAPERCUSP_WORKSPACE_ID },
              body: JSON.stringify({ name, args, harness: e.PAPERCUSP_POT_HOME_SLUG, confirmed: true }), signal: AbortSignal.timeout(30000) });
            const value = await response.json();
            if (!response.ok || !value.ok) throw Error(name + ' failed: ' + JSON.stringify(value));
            const body = value.result?.data ?? value.result;
            const text = body?.content?.find(row => row.type === 'text')?.text;
            return text ? JSON.parse(text) : body;
          };
          try {
            host = spawn(process.execPath, ['--inspect=127.0.0.1:0', entry], {
              cwd: path.join(process.cwd(), 'apps/operator'), detached: true,
              env: { ...e, VITEST: '', MALLOC_ARENA_MAX: e.TEST_MALLOC_ARENA_MAX }, stdio: ['ignore', 'pipe', 'pipe'] });
            cohort.pid = host.pid;
            for (const stream of [host.stdout, host.stderr]) stream.setEncoding('utf8').on('data', value => {
              tail = (tail + value).slice(-3000); if (stream === host.stderr) startup += value; });
            const deadline = Date.now() + 150000;
            let ready = false, endpoint;
            while (Date.now() < deadline) {
              if (host.exitCode !== null || host.signalCode !== null) throw Error('Host exited: ' + tail);
              endpoint = [...startup.matchAll(/^Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+)\r?$/gm)].at(-1)?.[1];
              try { const response = await fetch(e.PAPERCUSP_OPERATOR_URL + '/api/health/ready', { signal: AbortSignal.timeout(1000) });
                if ((await response.json()).ready && endpoint) { ready = true; break; } } catch {}
              await wait(250);
            }
            if (!ready || !endpoint) throw Error('Private host readiness/inspector failed: ' + tail);
            const healthResponse = await fetch(e.PAPERCUSP_OPERATOR_URL + '/api/health', { signal: AbortSignal.timeout(10000) });
            if (!healthResponse.ok) throw Error('Private copied host health HTTP failure');
            const loadedHealth = await healthResponse.json();
            if (e.TEST_EXPECTED_BUILD) (${servingInboxHealth.toString()})(loadedHealth, e.TEST_EXPECTED_BUILD);
            cohort.loadedHealth = { sha: loadedHealth.sha, version: loadedHealth.version };
            client = createCdpClient(endpoint); await client.connect();
            const identity = (await client.evaluate('({pid:process.pid,entry:process.argv[1]})', { returnByValue: true })).result.value;
            if (identity.pid !== host.pid || identity.entry !== entry) throw Error('Inspector serving identity mismatch');
            cohort.identity = { ...identity, ...osMemory(host.pid) };
            client.ws.on('message', raw => { try { if (JSON.parse(String(raw)).method === 'Debugger.paused') cohort.pauses++; } catch {} });
            const who = await call('coord:whoami', {});
            if (!who.ownerId || who.workspaceId !== e.PAPERCUSP_WORKSPACE_ID) throw Error('Private caller identity unobserved');
            cohort.ownerId = who.ownerId;
            await sql.unsafe('delete from harness_shared.coord_event_log where workspace_id=$1 and surface=$2', [e.PAPERCUSP_WORKSPACE_ID, 'messages']);
            await sql.unsafe('insert into harness_shared.coord_event_log (workspace_id,surface,writer_key,msg_id,body) ' +
              "select $1,'messages','p011-author','p011-'||g,jsonb_build_object('msg_id','p011-'||g,'kind','message','from','p011-author','to',jsonb_build_array($2::text),'ts',to_char(timestamp '2026-01-01'+g*interval '1 second','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),'summary','P011 useful context '||g,'body',left(repeat('useful-context-'||g||' ',32768),32768)) from generate_series(1,256) g",
              [e.PAPERCUSP_WORKSPACE_ID, who.ownerId]);
            const fixture = await sql.unsafe("select body->>'msg_id' as id, body->>'body' as content from harness_shared.coord_event_log where workspace_id=$1 and surface='messages' order by body->>'msg_id'", [e.PAPERCUSP_WORKSPACE_ID]);
            const digest = createHash('sha256'); for (const row of fixture) digest.update(JSON.stringify([row.id, row.content]));
            cohort.fixture = { rows: fixture.length, stringCodeUnits: fixture.reduce((n, row) => n + row.content.length, 0), sha256: digest.digest('hex') };
            // Warm dispatch/readiness before the resource baseline, then discard
            // that private cache. Counters/PSS are sampled before reading content.
            await call('coord:inbox', { directed: true, limit: 1, max_body_chars: 1 });
            const warmEntries = (await client.evaluate('(' + inboxPairEntries.toString() + ") (globalThis[Symbol.for('@papercusp/module-singleton.slots')].get('@papercusp/operator-core.operatorCache').value).length", { returnByValue: true })).result.value;
            if (warmEntries !== 1) throw Error('Private pair warm cache namespace preflight failed: ' + warmEntries);
            cohort.warmCacheEntries = warmEntries;
            cohort.cachePreflight = (await client.evaluate('(' + preparePairCache.toString() + ") (globalThis[Symbol.for('@papercusp/module-singleton.slots')].get('@papercusp/operator-core.operatorCache').value)", { returnByValue: true })).result.value;
            const sample = async phase => {
              const started = performance.now();
              const memory = await readProcessMemory(client, { expectedPid: host.pid });
              const os = osMemory(host.pid); if (os.startTicks !== cohort.identity.startTicks) throw Error('PID identity changed');
              const children = descendants(host.pid); for (const row of children) seen.set(row.pid + ':' + row.startTicks, row);
              const cache = (await client.evaluate("(() => { const s=globalThis[Symbol.for('@papercusp/module-singleton.slots')].get('@papercusp/operator-core.operatorCache').value; const select=(" + inboxPairEntries.toString() + "); const rows=select(s); return {enabled:s.cacheLayerOn, entries:rows.length, rows:rows.map(entry=>entry.value.length), " +
                (cacheRetainers ? "keyDigests:select(s,true).map(row=>row.keyDigest)" : "") + "}; })()", { returnByValue: true })).result.value;
              cohort.samples.push({ phase, ...memory, os, descendants: children, cache, observerMs: performance.now() - started }); publish();
            };
            await sample('before');
            for (let window = 0; window < 3; window++) {
              await sample('idle-' + window + '-start'); await wait(1000); await sample('idle-' + window + '-end');
              const started = performance.now();
              const observed = { window, startedAtMs: started, endedAtMs: null, requests: [], outcomes: [] };
              cohort.windows.push(observed);
              const results = await Promise.all(variants.map(async (args, variant) => {
                const interval = { variant, pid: host.pid, startTicks: cohort.identity.startTicks,
                  startedAtMs: performance.now(), endedAtMs: null };
                observed.requests.push(interval);
                try { return await call('coord:inbox', args); }
                finally { interval.endedAtMs = performance.now(); }
              }));
              observed.endedAtMs = performance.now();
              const outcomes = results.map((value, i) => ({ variant: i,
                entries: value.entries?.map(row => ({ id: row.msg_id, summary: row.summary })),
                total: value.summary?.total, returned: value.summary?.returned }));
              if (outcomes.some((v, i) => v.total !== 256 || v.returned !== i + 1 || v.entries?.length !== i + 1))
                throw Error('Concurrent useful response mismatch: ' + JSON.stringify(outcomes));
              Object.assign(observed, { wallMs: observed.endedAtMs - started, outcomes });
              await sample('workload-' + window + '-end');
            }
            await wait(1000); await sample('completion-idle');
            const contentExpression = "(() => { const s=globalThis[Symbol.for('@papercusp/module-singleton.slots')].get('@papercusp/operator-core.operatorCache').value; const select=(" + inboxPairEntries.toString() + "); const digests=" +
              (cacheRetainers ? "select(s,true)" : "[]") + "; return select(s).map((entry,index)=>{ const h=process.getBuiltinModule('crypto').createHash('sha256'); const rows=entry.value.slice().sort((a,b)=>a.msg_id.localeCompare(b.msg_id)); for(const row of rows) h.update(JSON.stringify([row.msg_id,row.body])); return {rows:rows.length,sha256:h.digest('hex'),stringCodeUnits:rows.reduce((n,row)=>n+row.body.length,0),...digests[index]}; }); })()";
            const content = (await client.evaluate(contentExpression, { returnByValue: true })).result.value;
            cohort.content = content;
            if (content.length !== (mode === 'baseline' ? 8 : 1) || content.some(row =>
                row.rows !== cohort.fixture.rows || row.sha256 !== cohort.fixture.sha256 || row.stringCodeUnits !== cohort.fixture.stringCodeUnits))
              throw Error('Full raw cache content or sharing mismatch: ' + JSON.stringify(content));
            if (cacheRetainers) {
              const heap = { pid: host.pid, inspector: { pid: host.pid }, profilerOperations: [],
                nativeAdapterPreflight: report.nativeAdapterPreflight, nativeDecoderPreflight: report.nativeDecoderPreflight };
              cohort.cacheHeap = heap;
              const keyDigests = content.map(row => row.keyDigest);
              if (keyDigests.length !== (mode === 'baseline' ? 8 : 1) || new Set(keyDigests).size !== keyDigests.length ||
                  keyDigests.some(digest => !/^[a-f0-9]{64}$/.test(digest)) ||
                  JSON.stringify(keyDigests) !== JSON.stringify(cohort.samples.at(-1).cache.keyDigests))
                throw Error('Exact inbox cache digest population changed before snapshot');
              const snapshotPath = path.join(path.dirname(e.TEST_REPORT_PATH), 'inbox-arm-' + arm + '.heapsnapshot');
              const started = Date.now();
              heap.snapshotStartedAt = started;
              try {
                const captureIds = async () => {
                  heap.profilerOperations.push('local HeapProfiler.enable + v8.writeHeapSnapshot + exact IDs in one target job');
                  const captured = await capturePinnedHeapSnapshot(client, { expectedPid: host.pid,
                    owners: ['@papercusp/operator-core.operatorCache'], cacheKeyDigests: keyDigests, snapshotPath });
                  heap.cacheBeforeSnapshot = captured.cacheBeforeSnapshot;
                  heap.heapSnapshotWriteMs = captured.writeMs;
                  heap.profilerOperations.push('local Session.disconnect after exact IDs captured');
                  publish();
                  return captured;
                };
                if (traceOnly) {
                  const measured = await withFunctionCallTrace(client, { expectedPid: host.pid,
                    durationMs: 30000, maxCalls: 64, maxStacks: 8, maxStackChars: 4096,
                    targets: [{ name: 'inspector.Session.disconnect',
                      expression: "process.getBuiltinModule('inspector').Session.prototype.disconnect" }],
                  }, captureIds);
                  heap.heapOwnerBinding = measured.value;
                  heap.sessionLifecycle = { trace: measured.trace, limits: measured.limits };
                  publish();
                } else heap.heapOwnerBinding = await captureIds();
                if (traceOnly) {
                  heap.postSnapshotRowsPreserved = JSON.stringify((await client.evaluate(contentExpression,
                    { returnByValue: true })).result.value) === JSON.stringify(content);
                  if (!heap.postSnapshotRowsPreserved) throw Error('Inbox useful cache content changed after snapshot');
                  continue;
                }
                const objectIds = [...new Set([
                  ...heap.heapOwnerBinding.roots.filter(row => row.status === 'found').map(row => row.id),
                  ...heap.heapOwnerBinding.cacheEntries.records.flatMap(row =>
                    row.objects.filter(object => object.status === 'found').map(object => object.id)),
                ])];
                if (!heap.heapOwnerBinding.roots.some(row => row.status === 'found') || !objectIds.length)
                  throw Error('Inbox cache root snapshot identity unobserved');
                publish();
                const { summarizeHeapSnapshotStream, summarizeHeapRetainers } = await import(pathToFileURL(e.TEST_HEAP_ANALYZER));
                const summaryStarted = Date.now();
                const summary = await summarizeHeapSnapshotStream(fs.createReadStream(snapshotPath));
                heap.heapSnapshot = { ...summary, pid: host.pid, writeMs: heap.heapSnapshotWriteMs,
                  summaryMs: Date.now() - summaryStarted, durationMs: Date.now() - started };
                publish();
                heap.heapRetainers = { ...(await summarizeHeapRetainers(fs.readFileSync(snapshotPath), {
                  top: 20, perClass: 3, retainerDepth: 1, maxRetainers: 32, objectIds,
                  nativeExecutable: e.TEST_NATIVE_HEAP_ADAPTER, decoderControl: e.TEST_NATIVE_HEAP_DECODER,
                })), pid: host.pid };
                if (heap.heapRetainers.requestedNodes.length !== objectIds.length ||
                    heap.heapRetainers.requestedNodes.some(row => row.status !== 'found' || row.node?.id !== row.id) ||
                    new Set(heap.heapRetainers.requestedNodes.map(row => row.id)).size !== objectIds.length ||
                    heap.heapRetainers.requestedNodes.some(row => !objectIds.includes(row.id)))
                  throw Error('Exact cache IDs missing from captured native graph');
                heap.postSnapshotRowsPreserved = JSON.stringify((await client.evaluate(contentExpression,
                  { returnByValue: true })).result.value) === JSON.stringify(content);
                if (!heap.postSnapshotRowsPreserved) throw Error('Inbox useful cache content changed after snapshot');
              } finally {
                fs.rmSync(snapshotPath, { force: true }); heap.snapshotRemoved = !fs.existsSync(snapshotPath); publish();
              }
            }
          } catch (err) { cohort.error = String(err); cohort.hostErrorTail = tail; throw err; }
          finally {
            client?.close();
            if (host && host.exitCode === null && host.signalCode === null) {
              const exited = new Promise(r => host.once('exit', r)); host.kill('SIGTERM'); await Promise.race([exited, wait(5000)]);
              if (host.exitCode === null && host.signalCode === null) {
                cohort.forcedCleanup = true; process.kill(-host.pid, 'SIGKILL'); await exited;
              }
            }
            if (host) { try { process.kill(-host.pid, 'SIGKILL'); cohort.forcedCleanup = true;
              } catch (err) { if (err.code !== 'ESRCH') throw err; } }
            cohort.reaped = Boolean(host && (host.exitCode !== null || host.signalCode !== null));
            cohort.descendants = [...seen.values()];
            cohort.unreaped = cohort.descendants.filter(row => { try { return fields(row.pid)[19] === row.startTicks; } catch { return false; } });
            publish();
          }
        }
        report.incomplete = false;
      })().catch(err => { report.error = String(err); process.exitCode = 1; })
      .finally(async () => { if (sql) await sql.end(); publish(); });
    `;
    let phase = 'bundle-preflight';
    const preflight: Record<string, unknown> = {};
    const sourceDirectory = process.env.PAPERCUSP_P011_SERVING_HOST_DIRECTORY;
    let servingPin: ServingInboxPin | undefined;
    try {
      expect(() => new Function(probe)).not.toThrow();
      expect(preparePairCache({ cache: createCache(), cacheLayerOn: true })).toEqual({ enabled: true, entries: 0 });
      symlinkSync(resolve(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
      let build: Record<string, unknown>;
      if (sourceDirectory) {
        const expectedBuild = process.env.PAPERCUSP_P011_SERVING_BUILD_SHA ?? '';
        servingPin = await readServingInboxPin(sourceDirectory, expectedBuild, Number(process.env.PAPERCUSP_P011_LIVE_PID));
        preflight.servingBefore = servingPin;
        cpSync(sourceDirectory, dirname(current), { recursive: true });
        assertServingInboxPin(servingPin, await readServingInboxPin(sourceDirectory, expectedBuild, servingPin.process.pid));
        build = { route: 'immutable-serving-generation-copy', loadedBuild: expectedBuild };
      } else {
        const built = runCohortWithLog([resolve(root, 'scripts/npm-install-safe.mjs'), '--repo-root', root,
          '--exec-under-lock', '--', resolve(root, 'apps/operator/bin/bundle-host.sh'), 'bin/hono-host.ts', current],
        { cwd: root, env: process.env, timeout: 180000 }, join(directory, 'build.log'));
        preflight.build = { ...built.log, tail: built.stderr };
        expect(built.status, built.stderr).toBe(0);
        build = built.log;
      }
      cpSync(dirname(current), dirname(baseline), { recursive: true });
      phase = 'counterfactual-preflight';
      const emitted = readFileSync(current, 'utf8');
      const keyOffset = emitted.indexOf('bounded: boundedInbox');
      preflight.currentBundleSha256 = createHash('sha256').update(emitted).digest('hex');
      preflight.emittedKey = keyOffset < 0 ? null : emitted.slice(keyOffset, keyOffset + 850);
      const restored = restoreFullInboxKey(emitted);
      writeFileSync(baseline, restored.bundle);
      const copiedArtifacts = inboxArtifactManifest(dirname(current));
      assertInboxArtifactCopy(servingPin?.artifacts ?? copiedArtifacts, copiedArtifacts,
        inboxArtifactManifest(dirname(baseline)), restored.bundle);
      preflight.artifacts = copiedArtifacts;
      phase = 'runtime-cohorts';
      const result = runCohortWithLog([resolve(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime=operator-api', '--', process.execPath, '-e', probe],
        { cwd: root, timeout: cacheRetainers ? 900000 : 360000, env: { ...process.env, TEST_CURRENT_PATH: current, TEST_BASELINE_PATH: baseline,
          TEST_REPORT_PATH: rawReport, TEST_INSPECTOR_PATH: resolve(root, 'scripts/cdp-inspector.mjs'), TEST_MALLOC_ARENA_MAX: HOST_MALLOC_ARENA_MAX,
          TEST_CACHE_HEAP_RETAINERS: cacheRetainers ? '1' : '0', TEST_NATIVE_HEAP_ADAPTER: nativeAdapter,
          TEST_ID_LIFETIME_TRACE: traceOnly ? '1' : '0',
          TEST_NATIVE_HEAP_DECODER: nativeDecoder, TEST_HEAP_ANALYZER: resolve(root, 'scripts/analyze-heap-snapshots.mjs'),
          TEST_SOURCE_DIRECTORY: sourceDirectory ?? '', TEST_PRIVATE_PARENT: tmpdir(), TEST_EXPECTED_BUILD: servingPin?.health.sha ?? '' } },
        join(directory, 'runtime.log'));
      const report = readCohortReport(rawReport, result);
      phase = 'report-verification';
      report.sources = { before: beforeSources, after: sources(), fullGraph: 'unknown' };
      report.build = build; report.runtimeLog = result.log; report.intervention = restored.intervention;
      report.preflight = preflight;
      await persistInboxBeforePostflight(report, destination, async () => {
        if (servingPin && sourceDirectory) {
          phase = 'serving-generation-postflight';
          const after = await readServingInboxPin(sourceDirectory, servingPin.health.sha, servingPin.process.pid);
          preflight.servingAfter = after;
          assertServingInboxPin(servingPin, after);
          assertInboxArtifactCopy(servingPin.artifacts, inboxArtifactManifest(dirname(current)),
            inboxArtifactManifest(dirname(baseline)), restored.bundle);
          report.limitations.push('Staging health/socket/build and read-only artifact identity are separate from the private resource cohorts; production request allocation and full source graph remain unknown.');
        }
      });
      expect(result.status, report.error ?? result.stderr).toBe(0);
      if (traceOnly) {
        expect(report.traceOnly).toBe(true); expect(report.incomplete).toBe(false);
        expect(report.cohorts).toHaveLength(1);
        const cohort = report.cohorts[0];
        expect(cohort.mode).toBe('shared'); expect(cohort.reaped).toBe(true);
        expect(cohort.unreaped).toEqual([]); expect(cohort.pauses).toBe(0);
        expect(cohort.cacheHeap.snapshotRemoved).toBe(true);
        expect(cohort.cacheHeap.postSnapshotRowsPreserved).toBe(true);
        expect(cohort.cacheHeap.heapOwnerBinding.cacheEntries.records[0].status).toBe('selected');
        expect(cohort.cacheHeap.sessionLifecycle.trace.pid).toBe(cohort.pid);
        expect(cohort.cacheHeap.sessionLifecycle.trace.limited).toBe(false);
        expect(report.sources.before).toEqual(report.sources.after);
        return;
      }
      expect(report.incomplete).toBe(false); expect(report.cohorts).toHaveLength(4);
      expect(report.sources.before).toEqual(report.sources.after);
      const [control, shared] = report.cohorts;
      expect(control.fixture).toEqual(shared.fixture);
      expect(control.windows.map((w: any) => w.outcomes)).toEqual(shared.windows.map((w: any) => w.outcomes));
      for (const cohort of report.cohorts) {
        expect(cohort.fixture).toEqual(control.fixture);
        expect(cohort.windows.map((w: any) => w.outcomes)).toEqual(control.windows.map((w: any) => w.outcomes));
        expect(auditInboxOverlap(cohort)).toHaveLength(3);
        expect(cohort.reaped).toBe(true); expect(cohort.unreaped).toEqual([]); expect(cohort.pauses).toBe(0);
        expect(cohort.windows).toHaveLength(3); expect(cohort.samples).toHaveLength(11);
        expect(cohort.content).toHaveLength(cohort.mode === 'baseline' ? 8 : 1);
        for (const sample of cohort.samples) {
          expect(sample.os.pssBytes).toBeGreaterThan(0); expect(sample.memory.heapUsed).toBeGreaterThan(0);
          expect(sample.cache.enabled).toBe(true); expect(sample.os.startTicks).toBe(cohort.identity.startTicks);
        }
      }
      // Independently reject a reduction claim unless both order-reversed pairs
      // preserve useful output and observe lower PSS and cumulative allocation.
      report.observedAcceptance = auditObservedInboxPair(report);
      writeFileSync(destination, serializeIdentitySafeJson(report));
      console.log('P011_INBOX_PAIR_SUMMARY ' + JSON.stringify(report.cohorts.map((c: any) => ({ mode: c.mode,
        pssBytes: c.samples.map((s: any) => s.os.pssBytes), heapUsed: c.samples.map((s: any) => s.memory.heapUsed) }))));
    } catch (error) {
      const failure = existsSync(destination) ? JSON.parse(readFileSync(destination, 'utf8'))
        : existsSync(rawReport) ? JSON.parse(readFileSync(rawReport, 'utf8')) : { incomplete: true, cohorts: [] };
      Object.assign(failure, { verificationError: String(error), verificationPhase: phase, preflight,
        sources: { before: beforeSources, after: sources(), fullGraph: 'unknown' } });
      writeFileSync(destination, serializeIdentitySafeJson(failure));
      throw error;
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, process.env.PAPERCUSP_P011_INBOX_HEAP_RETAINERS === '1' ? 1200000 : 570000);

  it.each([
    ['default budget', {}],
    ['short budget', { PAPERCUSP_TEST_FILE_TIMEOUT_MS: '600000' }],
    ['child-only budget', { PAPERCUSP_TEST_FILE_TIMEOUT_MS: '900000' }],
  ] as const)('rejects %s before a long retainer cohort can launch', async (_name, env) => {
    await expect(assertCohortRunnerBudget(1200000, env)).rejects.toThrow('Refusing before bundle/database launch');
  });

  it('admits the declared whole retainer budget and the ordinary short cohort', async () => {
    await expect(assertCohortRunnerBudget(1200000, { PAPERCUSP_TEST_FILE_TIMEOUT_MS: '1200000' })).resolves.toBeUndefined();
    await expect(assertCohortRunnerBudget(570000, {})).resolves.toBeUndefined();
  });

  it('preserves the runner validation instead of turning malformed budgets into admission', async () => {
    await expect(assertCohortRunnerBudget(1200000, { PAPERCUSP_TEST_FILE_TIMEOUT_MS: 'not-a-duration' })).rejects.toThrow('positive integer');
  });

  it.each(['linked', 'unobserved', 'unknown'] as const)('preserves completed query correlation %s across the inspector boundary', state => {
    const source = { processInstanceId: 'query-process', buildSha: 'abcdef123', poolInstanceId: 'query-pool' };
    const correlation = { processInstanceId: 'operation-process', buildSha: 'abcdef123', rowId: 'row-1',
      attemptId: 'attempt-1', hopId: 2, stage: 'scope-query', boundary: 'await' as const,
      requestId: '11111111-1111-4111-8111-111111111111', operation: 'workItems.byHarness' };
    const row = { pool: 'org-admin', source, connectionId: 5, queryId: 7, backendPid: 1234,
      queryFamily: 'select:harness_shared.spawned_agents', command: 'select', rowCount: 129,
      wireBytes: 21360, elapsedMs: 31, status: 'error' as const, errorCode: '57014', recordedAt: 123456,
      correlationState: state, ...(state === 'linked' ? { correlation } : {}),
      query: 'SELECT private_payload', parameters: ['private-value'], rows: [{ payload: 'private-body' }] };
    // Run the exact serialized helper without its lexical scope, as CDP does.
    const project = new Function('return (' + completedQuerySamples.toString() + ')')();
    const sampled = project([row]);
    source.poolInstanceId = 'later-pool'; correlation.attemptId = 'later-attempt';
    const result = JSON.parse(JSON.stringify(sampled))[0];
    expect(result.source).toEqual({ processInstanceId: 'query-process', buildSha: 'abcdef123', poolInstanceId: 'query-pool' });
    expect(result.correlationState).toBe(state);
    expect(result.backendPid).toBe(1234); expect(result.errorCode).toBe('57014');
    expect(result.rowCount).toBe(129); expect(result.wireBytes).toBe(21360);
    if (state === 'linked') expect(result.correlation).toEqual({ processInstanceId: 'operation-process',
      buildSha: 'abcdef123', rowId: 'row-1', attemptId: 'attempt-1', hopId: 2, stage: 'scope-query', boundary: 'await',
      requestId: '11111111-1111-4111-8111-111111111111', operation: 'workItems.byHarness' });
    else expect(result).not.toHaveProperty('correlation');
    expect(result).not.toHaveProperty('query'); expect(result).not.toHaveProperty('parameters');
    expect(result).not.toHaveProperty('rows');
  });

  it('joins named HTTP query diagnostics by exact IDs despite indistinguishable counts/times and reversed completion', () => {
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const row = (requestId: string, operation = 'workItems.byHarness') => ({
      source: { processInstanceId: 'process', buildSha: 'build', poolInstanceId: 'pool' },
      connectionId: 1, queryId: 2, rowCount: 129, wireBytes: 100, recordedAt: 10,
      correlationState: 'linked', correlation: { requestId, operation },
    });
    const exact = [row(ids[1]), row(ids[0])];
    const joinRequests = new Function('return (' + namedRequestQueryResults.toString() + ')')();
    const pools = [{ pool: 'org-app', results: [row('33333333-3333-4333-8333-333333333333'),
      row(ids[0], 'workItems.stats'), ...exact] }];
    expect(joinRequests(pools, ids)).toEqual(exact.map(value => ({ pool: 'org-app', ...value })));
    const dependencyQuery = { ...row(ids[0]), connectionId: 3, queryId: 4, rowCount: 0, wireBytes: 0 };
    expect(joinRequests([{ pool: 'org-app', results: [...exact, dependencyQuery] }], ids))
      .toEqual([...exact, dependencyQuery].map(value => ({ pool: 'org-app', ...value })));
    expect(() => joinRequests([{ pool: 'org-app', results: [row(ids[0], 'workItems.stats'), row(ids[1])] }], ids))
      .toThrow('missing or ambiguous');
    expect(() => joinRequests([{ pool: 'org-app', results: [...exact, row(ids[0])] }], ids))
      .toThrow('missing or ambiguous');
    expect(() => joinRequests([{ pool: 'org-app', results: [exact[0]] }], ids)).toThrow('missing or ambiguous');
    for (const invalid of [[], [ids[0], ids[0]], ['private-secret'], Array(33).fill(ids[0])])
      expect(() => joinRequests(pools, invalid)).toThrow('Exact HTTP request IDs');
  });

  it('checks every distinct query tuple before a request-linked snapshot, independent of completion order', () => {
    const requestId = '11111111-1111-4111-8111-111111111111';
    const source = { processInstanceId: 'process', buildSha: 'build', poolInstanceId: 'pool' };
    const records = [1, 2].map(queryId => ({ pool: 'org-app', source, connectionId: 1, queryId, requestId }));
    const expected = records.map(row => ({ ...row, correlation: { requestId }, rowCount: row.queryId === 1 ? 129 : 0 }));
    const check = new Function('return (' + assertNamedQueryHeapSelection.toString() + ')')();
    expect(() => check([...records].reverse(), expected)).not.toThrow();
    for (const selected of [[], records.slice(0, 1), [records[0], records[0]],
      [{ ...records[0], source: { ...source, poolInstanceId: 'other' } }, records[1]]])
      expect(() => check(selected, expected)).toThrow('exact identity');
  });

  it('resolves evidence destinations before runtime preparation independently of runner cwd', () => {
    expect(evidenceDestination('docs/evidence/p011-relative-report.json')).toBe(join(root, 'docs/evidence/p011-relative-report.json'));
    expect(evidenceDestination(join(tmpdir(), 'p011-absolute-report.json'))).toBe(join(tmpdir(), 'p011-absolute-report.json'));
    expect(evidenceDestination(undefined)).toBeNull();
    expect(() => evidenceDestination('missing-p011-evidence-parent/report.json')).toThrow('Evidence destination parent must exist');
  });

  it('preserves source bytes when request chunks split a UTF-8 character', async () => {
    const text = 'export const label = "A→🙂éZ";';
    const body = Buffer.from(JSON.stringify({ path: 'unicode.ts', text }));
    for (let split = 1; split < body.length; split++) {
      const chunks = async function* () { yield body.subarray(0, split); yield body.subarray(split); };
      expect(await readSourceRequest(chunks())).toEqual({ path: 'unicode.ts', text });
    }
  });

  it('keeps launcher output on disk before the first cohort report exists', () => {
    const directory = mkdtempSync(join(tmpdir(), 'papercusp-cohort-output-'));
    const archive = mkdtempSync(join(tmpdir(), 'papercusp-cohort-archive-'));
    try {
      const report = join(directory, 'report.json');
      const result = runCohortWithLog(['-e',
        "process.stdout.write('x'.repeat(1024*1024)); require('node:fs').writeFileSync(process.argv[1], JSON.stringify({incomplete:false}));", report],
      { cwd: root, env: process.env, timeout: 5000 }, join(directory, 'launcher.log'), archive);
      expect(result.status).toBe(0); expect(result.error).toBeUndefined();
      expect(result.log.bytes).toBe(1024 * 1024);
      expect(JSON.parse(readFileSync(report, 'utf8')).incomplete).toBe(false);
      rmSync(directory, { recursive: true, force: true });
      const retained = readFileSync(resolve(root, result.log.path));
      expect(retained).toEqual(Buffer.from('x'.repeat(1024 * 1024)));
      expect(createHash('sha256').update(retained).digest('hex')).toBe(result.log.sha256);
    } finally {
      rmSync(directory, { recursive: true, force: true }); rmSync(archive, { recursive: true, force: true });
    }
  });

  describe('P-011 cohort log retention guards', () => {
    it('records a resolvable repository-relative path in the maintained harness log archive', () => {
      const directory = mkdtempSync(join(tmpdir(), 'papercusp-log-default-'));
      try {
        const result = runCohortWithLog(['-e', "process.stdout.write('P011 default archive guard\\n')"],
          { cwd: root, env: process.env, timeout: 5000 }, join(directory, 'runtime.log'));
        rmSync(directory, { recursive: true, force: true });
        expect(result.log.path).toBe(join('.papercusp', 'logs', 'cohort-' + result.log.sha256 + '.log'));
        expect(readFileSync(resolve(root, result.log.path), 'utf8')).toBe('P011 default archive guard\n');
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });
    it.each(['success', 'runner-failure', 'postflight-failure'] as const)('retains exact runtime bytes after %s cleanup', async mode => {
      const directory = mkdtempSync(join(tmpdir(), 'papercusp-log-retention-'));
      const archive = mkdtempSync(join(tmpdir(), 'papercusp-log-archive-'));
      const destination = join(archive, 'report.json');
      const stdout = 'raw stdout →🙂\n', stderr = 'raw stderr é\n';
      const original = Buffer.from(stdout + stderr);
      try {
        try {
          const result = runCohortWithLog(['-e',
            'process.stdout.write(' + JSON.stringify(stdout) + ');process.stderr.write(' + JSON.stringify(stderr) +
            ');process.exitCode=' + (mode === 'runner-failure' ? '7' : '0')],
          { cwd: root, env: process.env, timeout: 5000 }, join(directory, 'runtime.log'), archive);
          const report = readCohortReport(join(directory, 'absent-report.json'), result);
          report.runtimeLog = result.log;
          await persistInboxBeforePostflight(report, destination, async () => {
            if (mode === 'postflight-failure') throw Error('injected final health failure');
          });
          if (mode === 'runner-failure') throw Error('injected runner status: ' + result.status);
        } catch (error) {
          if (mode === 'success') throw error;
          expect(String(error)).toContain(mode === 'runner-failure' ? 'runner status: 7' : 'final health failure');
          const report = JSON.parse(readFileSync(destination, 'utf8'));
          report.verificationError = String(error);
          writeFileSync(destination, serializeIdentitySafeJson(report));
        } finally { rmSync(directory, { recursive: true, force: true }); }
        const report = JSON.parse(readFileSync(destination, 'utf8'));
        const retained = readFileSync(resolve(root, report.runtimeLog.path));
        expect(existsSync(directory)).toBe(false);
        expect(retained).toEqual(original);
        expect(report.runtimeLog.bytes).toBe(original.length);
        expect(report.runtimeLog.sha256).toBe(createHash('sha256').update(original).digest('hex'));
        expect(report.runner.status).toBe(mode === 'runner-failure' ? 7 : 0);
        expect(Boolean(report.verificationError)).toBe(mode !== 'success');
      } finally {
        rmSync(directory, { recursive: true, force: true }); rmSync(archive, { recursive: true, force: true });
      }
    });
    it('reuses matching archived bytes and refuses a corrupted archive without overwriting it', () => {
      const directory = mkdtempSync(join(tmpdir(), 'papercusp-log-reuse-'));
      const archive = mkdtempSync(join(tmpdir(), 'papercusp-log-archive-'));
      const run = () => runCohortWithLog(['-e', "process.stdout.write('exact bytes')"],
        { cwd: root, env: process.env, timeout: 5000 }, join(directory, 'runtime.log'), archive);
      try {
        const first = run();
        expect(run().log).toEqual(first.log);
        const path = resolve(root, first.log.path);
        writeFileSync(path, 'corrupted archive');
        expect(run).toThrow('archive bytes do not match');
        expect(readFileSync(path, 'utf8')).toBe('corrupted archive');
      } finally {
        rmSync(directory, { recursive: true, force: true }); rmSync(archive, { recursive: true, force: true });
      }
    });
  });

  it('attributes exercised content-lint transforms to matched request-host and executable descendant samples', async () => {
    const reportPath = evidenceDestination(process.env.PAPERCUSP_P011_CALLER_REPORT);
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-content-lint-cohort-'));
    const sourcePath = 'packages/operator-core/lib/content-lint/esbuild-transform.ts';
    const sourceHash = createHash('sha256').update(readFileSync(join(root, sourcePath))).digest('hex');
    const entry = join(dir, 'request-host.ts'), bundle = join(dir, 'request-host.cjs');
    const meta = join(dir, 'metafile.json');
    // Dynamic import resolves from the private bundle, independently of NODE_PATH.
    symlinkSync(resolve(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
    const fixtureSources = [
      'packages/operator-core/lib/agent-tools/testing/mutation-probe-fence.ts',
      'packages/operator-core/lib/content-lint/esbuild-transform.ts',
      'packages/operator-core/lib/harness/improvements/watchdog.ts',
    ].map(path => ({ path, text: readFileSync(join(root, path), 'utf8') }));
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const buildSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const compilerPath = resolve(root, 'node_modules/@esbuild/linux-x64/bin/esbuild');
    const compilerHash = hash(readFileSync(compilerPath));
    const reports: any[] = [];
    let completeReport: any;
    let failure: unknown;
    writeFileSync(entry, `
      import { createServer } from 'node:http';
      import { findEsbuildTransformError } from ${JSON.stringify(join(root, sourcePath))};
      ${readSourceRequest.toString()}
      globalThis.p011Compiler = require('esbuild');
      const mode = process.env.P011_COHORT_MODE;
      createServer(async (request, response) => {
        try {
          const value = await readSourceRequest(request);
          const error = request.url === '/warm' || mode === 'transform'
            ? await findEsbuildTransformError(value.path, value.text) : null;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ error, sourceBytes: Buffer.byteLength(value.text) }));
        } catch (error) { response.statusCode = 500; response.end(String(error)); }
      }).listen(0, '127.0.0.1', function () {
        console.log(JSON.stringify({ pid: process.pid, port: this.address().port }));
      });
    `);
    try {
      // Compile the current application module into a private request fixture;
      // the metafile and exact bytes identify this plane, not a deployed host.
      const built = spawnSync(compilerPath, [entry, '--bundle', '--platform=node', '--format=cjs',
        '--packages=external', '--outfile=' + bundle, '--metafile=' + meta], {
        cwd: root, encoding: 'utf8', timeout: 20_000,
      });
      expect(built.status, built.stderr).toBe(0);
      const graph = Object.keys(JSON.parse(readFileSync(meta, 'utf8')).inputs).map(path => {
        const absolute = resolve(root, path);
        return { path: absolute === entry ? '<private-request-fixture>' : path, sha256: hash(readFileSync(absolute)) };
      });
      expect(graph.some(row => row.path === sourcePath && row.sha256 === sourceHash)).toBe(true);
      const sampleProcess = (pid: number) => {
        const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
        const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const executable = readlinkSync('/proc/' + pid + '/exe');
        const rollup = readFileSync('/proc/' + pid + '/smaps_rollup', 'utf8');
        const kb = (name: string) => Number(new RegExp('^' + name + ':\\s+(\\d+)', 'm').exec(rollup)?.[1]);
        return { pid, startTicks: tail[19], executable, executableSha256: hash(readFileSync('/proc/' + pid + '/exe')),
          pssKb: kb('Pss'), anonymousKb: kb('Anonymous'), privateDirtyKb: kb('Private_Dirty') };
      };
      for (const mode of ['control', 'transform']) {
        const host = spawn(process.execPath, ['--inspect=127.0.0.1:0', bundle], {
          cwd: root, env: { ...process.env, NODE_PATH: join(root, 'node_modules'), P011_COHORT_MODE: mode },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '', client: ReturnType<typeof createCdpClient> | undefined;
        let pauses = 0;
        const seen = new Map<number, string>();
        const report: any = { mode, samples: [], requests: [], windows: [], trace: null, reaped: false };
        reports.push(report);
        host.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
        host.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
        const exited = new Promise<void>(resolve => host.once('exit', () => resolve()));
        try {
          const readyDeadline = Date.now() + 10_000;
          while ((!stdout.includes('\n') || !inspectorEndpoints(stderr).length) && Date.now() < readyDeadline && host.exitCode === null) {
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          const ready = JSON.parse(stdout.trim().split('\n')[0]!);
          expect(ready.pid).toBe(host.pid);
          report.pid = ready.pid;
          client = createCdpClient(inspectorEndpoints(stderr).at(-1)!);
          await client.connect();
          client.ws.on?.('message', data => { if (JSON.parse(String(data)).method === 'Debugger.paused') pauses++; });
          let requestSequence = 0;
          const request = async (path: string, text: string, route = '/check') => {
            const requestId = requestSequence++;
            const started = performance.now();
            const response = await fetch('http://127.0.0.1:' + ready.port + route, {
              method: 'POST', body: JSON.stringify({ path, text }), signal: AbortSignal.timeout(10_000),
            });
            const responseText = await response.text();
            expect(response.status, responseText).toBe(200);
            const value = JSON.parse(responseText);
            expect(value.sourceBytes).toBe(Buffer.byteLength(text));
            report.requests.push({ requestId, path, route, sourceSha256: hash(text), sourceBytes: Buffer.byteLength(text),
              error: value.error, elapsedMs: performance.now() - started });
            return value;
          };
          const sample = async (phase: string) => {
            const memory = await readProcessMemory(client!, { expectedPid: ready.pid });
            const parent = sampleProcess(ready.pid);
            const children = readFileSync('/proc/' + ready.pid + '/task/' + ready.pid + '/children', 'utf8')
              .trim().split(/\s+/).filter(Boolean).map(Number).map(sampleProcess);
            for (const child of children) {
              expect(child.executableSha256, 'Classify the executable, not a cmdline substring.').toBe(compilerHash);
              seen.set(child.pid, child.startTicks);
            }
            expect(children).toHaveLength(1);
            expect(parent.pssKb).toBeGreaterThan(0);
            expect(memory.memory.heapUsed).toBeGreaterThan(0);
            report.samples.push({ phase, at: new Date().toISOString(), parent, memory, children });
          };
          await request('warm.ts', 'export const warm = 1', '/warm');
          await sample('warm-idle');
          const traced = await withFunctionCallTrace(client, { expectedPid: ready.pid,
            targets: [{ name: 'transform', expression: 'p011Compiler.transform' }],
            durationMs: 20_000, maxCalls: 64, maxStacks: 4, maxStackChars: 2000,
          }, async () => {
            for (let window = 0; window < 3; window++) {
              const start = performance.now();
              const results = await Promise.all(fixtureSources.map(source => request(source.path, source.text)));
              expect(results.every(value => value.error === null)).toBe(true);
              report.windows.push({ window, concurrency: 3, completed: results.length, elapsedMs: performance.now() - start });
              await sample('ordinary-' + window);
            }
          });
          report.trace = traced.trace; report.traceLimits = traced.limits;
          expect(traced.trace.calls.transform.calls).toBe(mode === 'transform' ? 9 : 0);
          expect(traced.trace.limited).toBe(false);
          if (mode === 'transform') expect(traced.trace.calls.transform.stacks.join('\n')).toContain('findEsbuildTransformError');
          await new Promise(resolve => setTimeout(resolve, 1000));
          await sample('one-second-idle');
          // The real syntax diagnostic remains functional after the concurrent
          // window. Its memory is deliberately outside the matched valid cohort.
          const invalid = await request('invalid.ts', 'export const broken = ;');
          expect(invalid.error === null).toBe(mode === 'control');
          const roots = await client.evaluate("Object.keys(globalThis).filter(key => key.startsWith('__papercuspCdpTrace_'))", { returnByValue: true });
          expect(roots.result.value).toEqual([]);
          expect(pauses).toBe(0); report.pauses = pauses;
        } catch (error) {
          report.error = String(error); throw error;
        } finally {
          client?.close();
          host.kill('SIGTERM');
          let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([exited, new Promise<void>((_, reject) => {
              cleanupTimer = setTimeout(() => { host.kill('SIGKILL'); reject(new Error('Private compiler host cleanup exceeded 3s')); }, 3000);
            })]);
          } finally { clearTimeout(cleanupTimer); }
          const deadline = Date.now() + 3000;
          const stillOwned = (pid: number, start: string) => {
            try { return sampleProcess(pid).startTicks === start; } catch { return false; }
          };
          while ([...seen].some(([pid, start]) => stillOwned(pid, start)) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          report.unreaped = [...seen].filter(([pid, start]) => stillOwned(pid, start));
          report.reaped = host.exitCode !== null || host.signalCode !== null;
          expect(report.unreaped).toEqual([]); expect(report.reaped).toBe(true);
        }
      }
      expect(hash(readFileSync(join(root, sourcePath)))).toBe(sourceHash);
      const scheduledInputs = (report: any) => [...report.requests].sort((a, b) => a.requestId - b.requestId)
        .map(row => [row.requestId, row.path, row.route, row.sourceSha256, row.sourceBytes]);
      // Concurrent completions may arrive in different orders. Match the
      // scheduled requests, preserving multiplicity and each window's order.
      expect(scheduledInputs(reports[0])).toEqual(scheduledInputs(reports[1]));
      completeReport = { schemaVersion: 1, incomplete: false, plane: 'current-source-private-content-lint-http-fixture', buildSha,
        bundleHash: hash(readFileSync(bundle)), graph, compiler: { path: compilerPath, sha256: compilerHash },
        workload: { windows: 3, requestsPerWindow: 3, concurrency: 3, inputFiles: fixtureSources.map(row => ({ path: row.path, sha256: hash(row.text) })) },
        reports, limitations: [
          'Current application source compiled into a private request fixture; not the deployed operator runtime.',
          'One-second idle is bounded fixture evidence, not an ordinary production idle baseline.',
          'V8 malloced/external counters and executable PSS are measured separately; no total native allocation estimate.',
          'Named exercised content-lint caller does not attribute the historical 4.2 GiB production census.',
          'Compiler trace adds bounded diagnostic overhead; control receives identical source bytes without transform work.',
        ] };
      console.log('P011_CONTENT_LINT_COHORT ' + JSON.stringify(reports.map(row => ({ mode: row.mode,
        calls: row.trace.calls.transform.calls, parentPssKb: row.samples.map((sample: any) => sample.parent.pssKb),
        compilerPssKb: row.samples.map((sample: any) => sample.children[0].pssKb), reaped: row.reaped }))));
    } catch (error) { failure = error; throw error; }
    finally {
      try {
        if (reportPath) writeFileSync(reportPath,
          serializeIdentitySafeJson(completeReport ?? { schemaVersion: 1, incomplete: true, buildSha, sourcePath, sourceHash,
            error: String(failure), reports }));
      } catch (error) {
        throw new AggregateError(failure ? [failure, error] : [error], 'Compiler cohort evidence write failed');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  }, 90_000);

  it('compares real closure and transform services in isolated processes and reaps their descendants', () => {
    const reportPath = evidenceDestination(process.env.PAPERCUSP_P011_ESBUILD_REPORT);
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-esbuild-census-'));
    const script = String.raw`
      import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      import { transform, stop, version } from 'esbuild';
      const mode = process.argv[1], dir = process.argv[2];
      const modules = 192, declarations = 128;
      const sources = Array.from({ length: modules }, (_, i) =>
        Array.from({ length: declarations }, (_, j) =>
          'export const v' + j + ' = ' + JSON.stringify(i + ':' + j + ':' + 'abcdef0123456789'.repeat(10)) + ';').join('\n'));
      mkdirSync(join(dir, mode), { recursive: true });
      const checkout = join(dir, mode);
      for (let i = 0; i < modules; i++) writeFileSync(join(checkout, 'm' + i + '.ts'), sources[i]);
      writeFileSync(join(checkout, 'entry.test.ts'), sources.map((_, i) => 'import * as m' + i + ' from "./m' + i + '";').join('\n') +
        '\nconsole.log(' + sources.map((_, i) => 'm' + i).join(',') + ');');
      writeFileSync(join(checkout, 'subject.ts'), 'export const unrelated = 1;');
      const { mutationProbeRefusal } = await import(pathToFileURL(join(process.cwd(),
        'packages/operator-core/lib/agent-tools/testing/mutation-probe-fence.ts')).href);
      const samples = [], servicePids = new Set();
      function sample(phase) {
        const children = readFileSync('/proc/' + process.pid + '/task/' + process.pid + '/children', 'utf8').trim().split(/\s+/).filter(Boolean);
        const services = children.flatMap(id => {
          try {
            const command = readFileSync('/proc/' + id + '/cmdline', 'utf8').split('\0');
            if (!command.some(arg => arg.startsWith('--service='))) return [];
            const rollup = readFileSync('/proc/' + id + '/smaps_rollup', 'utf8');
            servicePids.add(Number(id));
            return [{ pid: Number(id), pssKb: Number(/^Pss:\s+(\d+)/m.exec(rollup)?.[1]),
              anonymousKb: Number(/^Anonymous:\s+(\d+)/m.exec(rollup)?.[1]) }];
          } catch { return []; }
        });
        samples.push({ phase, at: new Date().toISOString(), services, parent: process.memoryUsage() });
      }
      try {
        await transform('export const warm = 1', { loader: 'ts' });
        sample('warm');
        for (let pass = 0; pass < 3; pass++) {
          if (mode === 'closure') {
            const result = await mutationProbeRefusal(checkout, ['entry.test.ts'], { probePaths: async () => ['subject.ts'] });
            if (result !== null) throw new Error('Closure comparison did not admit unrelated source: ' + JSON.stringify(result));
          } else {
            for (const source of sources) await transform(source, { loader: 'ts', target: 'node22', logLevel: 'silent' });
          }
          sample('pass-' + pass);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
        sample('one-second-idle');
      } finally { await stop(); }
      const deadline = Date.now() + 3000;
      while ([...servicePids].some(pid => existsSync('/proc/' + pid)) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const unreaped = [...servicePids].filter(pid => existsSync('/proc/' + pid));
      console.log(JSON.stringify({ mode, version, modules, declarations,
        sourceBytes: sources.reduce((n, source) => n + Buffer.byteLength(source), 0), samples, unreaped }));
      if (unreaped.length) process.exitCode = 1;
    `;
    try {
      const reports = ['closure', 'transform'].map(mode => {
        const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, mode, dir], {
          cwd: root, env: process.env, encoding: 'utf8', timeout: 45_000, maxBuffer: 128 * 1024,
        });
        expect(result.error?.message ?? result.stderr).toBe('');
        expect(result.status, result.stderr).toBe(0);
        const report = JSON.parse(result.stdout.trim());
        expect(report.unreaped).toEqual([]);
        expect(report.samples.map((sample: any) => sample.phase)).toEqual(['warm', 'pass-0', 'pass-1', 'pass-2', 'one-second-idle']);
        for (const sample of report.samples) {
          expect(sample.services).toHaveLength(1);
          expect(sample.services[0].pssKb).toBeGreaterThan(0);
        }
        return report;
      });
      expect(reports[0].sourceBytes).toBe(reports[1].sourceBytes);
      const closure = reports[0], warmService = closure.samples[0].services[0];
      for (const sample of closure.samples.slice(1)) {
        expect(sample.services[0].pid, 'A closure must preserve the caller transform service.').toBe(warmService.pid);
        // R12's inline implementation retained ~132 MiB above warm after this
        // exact 4.66 MB graph. The 32 MiB allowance tolerates native GC timing
        // while rejecting that retained ownership; it is not a leak threshold.
        expect(sample.services[0].pssKb - warmService.pssKb).toBeLessThan(32 * 1024);
      }
      // Report measured costs without turning fluctuating PSS into a leak assertion.
      const report = { schemaVersion: 1, definition: 'Isolated real closure versus transforms; one-second idle is not a production idle baseline.', reports };
      if (reportPath) writeFileSync(reportPath, serializeIdentitySafeJson(report));
      console.log('P011_ESBUILD_CENSUS ' + JSON.stringify(reports.map(r => ({ mode: r.mode,
        pssKb: r.samples.map((s: any) => s.services[0].pssKb), unreaped: r.unreaped }))));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 100_000);

  it('preserves the complete report when subprocess stdout exceeds its bound', () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-report-preflight-'));
    const path = join(dir, 'report.json');
    try {
      const result = spawnSync(process.execPath, ['-e',
        "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ incomplete: false, phase: 'samples-complete', samples: [1] })); process.stdout.write('x'.repeat(1024 * 1024));", path],
      { encoding: 'utf8', maxBuffer: 1024, timeout: 5000 });
      const report = readCohortReport(path, result);
      expect(report.runner.errorCode).toBe('ENOBUFS');
      expect(report.runner.stdoutBytes).toBeGreaterThan(0);
      expect(report).toMatchObject({ incomplete: false, phase: 'samples-complete', samples: [1] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('binds the replacement inspector after allocator re-exec, even across split startup chunks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-inspector-preflight-'));
    const entry = join(dir, 'serve.mjs');
    const env = { ...process.env };
    delete env.MALLOC_ARENA_MAX;
    delete env.GLIBC_TUNABLES;
    writeFileSync(entry, `import ${JSON.stringify(pathToFileURL(resolve(root, 'apps/operator/bin/boot-malloc-arena.ts')).href)};\n` +
      'console.log(JSON.stringify({ pid: process.pid, cap: process.env.MALLOC_ARENA_MAX }));\n' +
      'setInterval(() => {}, 1000);\n');
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--import', 'tsx', entry], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let startup = '', stdout = '', client: any;
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { startup += chunk; });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    try {
      const deadline = Date.now() + 20_000;
      while (!stdout.includes('\n') && Date.now() < deadline && child.exitCode === null) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(stdout.trim(), `Inspector child produced no identity (exit ${child.exitCode}):\n${startup}`).not.toBe('');
      const identity = JSON.parse(stdout.trim());
      expect(identity, startup).toEqual({ pid: child.pid, cap: HOST_MALLOC_ARENA_MAX });
      const endpoints = inspectorEndpoints(startup);
      expect(endpoints, startup).toHaveLength(2);
      expect(endpoints[0]).not.toBe(endpoints[1]);
      expect(inspectorEndpoints(startup.slice(0, startup.indexOf(endpoints[0]) + 12))).toEqual([]);
      const { createCdpClient, readProcessMemory } = await import('../../../scripts/cdp-inspector.mjs');
      const stale = createCdpClient(endpoints[0]);
      try { await expect(stale.connect()).rejects.toThrow(); } finally { stale.close(); }
      client = createCdpClient(endpoints.at(-1)!);
      await client.connect();
      const measured = await client.evaluate('({ pid: process.pid, cap: process.env.MALLOC_ARENA_MAX })', { returnByValue: true });
      expect(measured.result.value).toEqual(identity);
      // Exercise the maintained reader on a real inspector without an ESM
      // import callback. A wrong target must fail even when its counters look valid.
      const memory = await readProcessMemory(client, { expectedPid: child.pid });
      expect(memory.pid).toBe(child.pid);
      expect(memory.memory.heapUsed).toBeGreaterThan(0);
      expect(memory.memory.external).toBeGreaterThanOrEqual(0);
      expect(memory.heap.used_heap_size).toBeGreaterThan(0);
      expect(memory.heap.number_of_detached_contexts).toBeGreaterThanOrEqual(0);
      await expect(readProcessMemory(client, { expectedPid: child.pid! + 1 })).rejects.toThrow('Inspector PID mismatch');
      await expect(readProcessMemory(client, {})).rejects.toThrow('positive expectedPid');
      await client.evaluate("globalThis[Symbol.for('@papercusp/p011.retainer.fixture')] = { map: new Map(Array.from({length: 5}, (_, i) => [i, i])), array: Array(7).fill(1), fakeMap: Object.create(Map.prototype), fakeArray: Object.create(Array.prototype) }");
      const remoteIds: string[] = [];
      const observer = { evaluate: client.evaluate, send: async (method: string, args: object) => {
        const result = await client.send(method, args);
        if (method === 'Runtime.queryObjects') remoteIds.push(result.objects.objectId);
        return result;
      } };
      try {
        for (const kind of ['map', 'array'] as const) {
          const census = await retainedContainerCensus(observer, kind);
          expect(census.checked).toBeGreaterThan(0);
          expect(census.checked).toBeLessThanOrEqual(census.limits.objects);
          expect(census.checked + census.notApplicable + census.notChecked).toBe(census.population);
          expect(census.notApplicable).toBeGreaterThan(0);
          expect(census.owned).toContainEqual({ owner: 'private-fixture.' + kind, entries: kind === 'map' ? 5 : 7 });
        }
        for (const objectId of remoteIds) {
          await expect(client.send('Runtime.getProperties', { objectId })).rejects.toThrow('Runtime.getProperties failed');
        }
      } finally { await client.evaluate("delete globalThis[Symbol.for('@papercusp/p011.retainer.fixture')]"); }
      console.log('P011_INSPECTOR_PREFLIGHT ' + JSON.stringify({ pid: child.pid, endpoints,
        staleEndpointRejected: true, servingPidBound: true, arenaMax: identity.cap }));
    } finally {
      client?.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      }
      child.stdout.destroy(); child.stderr.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('attributes the serving HTTP mutation-fence compiler to independent preflight resource cohorts', async () => {
    const destination = evidenceDestination(process.env.PAPERCUSP_P011_SERVING_COMPILER_REPORT);
    const directory = mkdtempSync(join(tmpdir(), 'papercusp-serving-compiler-'));
    const hostDirectory = join(directory, 'host');
    const bundle = join(hostDirectory, 'hono-host.mjs');
    const reportPath = join(directory, 'report.json');
    const sourceDirectory = process.env.PAPERCUSP_P011_SERVING_HOST_DIRECTORY;
    const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    try {
      if (sourceDirectory) {
        // Read a serving generation; only its disposable copy is written.
        cpSync(sourceDirectory, hostDirectory, { recursive: true });
      } else {
        const built = spawnSync('bash', [resolve(root, 'apps/operator/bin/bundle-host.sh'), 'bin/hono-host.ts', bundle], {
          cwd: resolve(root, 'apps/operator'), encoding: 'utf8', timeout: 120_000,
        });
        expect(built.status, built.stderr.slice(-2000)).toBe(0);
      }
      symlinkSync(resolve(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
      const bundleHash = sha256(readFileSync(bundle));
      const worker = join(hostDirectory, 'mutation-probe-closure.worker.mjs');
      expect(existsSync(worker), 'The real host compiler worker must accompany its bundle.').toBe(true);
      const workerHash = sha256(readFileSync(worker));
      const inspectorPath = pathToFileURL(join(root, 'scripts/cdp-inspector.mjs')).href;
      const probe = String.raw`
        const fs = require('node:fs'), path = require('node:path');
        const { spawn, spawnSync } = require('node:child_process');
        const { createHash } = require('node:crypto');
        const e = process.env, wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const hash = value => createHash('sha256').update(value).digest('hex');
        const report = { schemaVersion: 1, incomplete: true, plane: 'serving-operator-http-preflight-private-cohorts',
          bundleSha256: e.TEST_BUNDLE_HASH, workerSha256: e.TEST_WORKER_HASH, sourceDirectory: e.TEST_SOURCE_DIRECTORY || null,
          cohorts: [], limitations: [
            'Actual maintained HTTP testing:run preflight; private request-only processes and data, not ambient production load.',
            'Control uses an unsupported-extension mutation lease; compiler uses a code-module lease. HTTP request and source bytes match.',
            'Compiler workload is a refused mutation preflight, not a completed test run or normal idle baseline.',
            'No historical gigabyte caller attribution or production memory reduction is claimed.',
            'Executable PSS and V8 native counters are separate measurements, not a total native allocation estimate.'
          ] };
        const publish = () => { fs.writeFileSync(e.TEST_REPORT_PATH, JSON.stringify(report, null, 2)); };
        const home = path.join(e.PAPERCUSP_WORKSPACES_ROOT, e.PAPERCUSP_WORKSPACE_ID, 'operator-home');
        // The lock authority requires a physical repository domain. Initialize
        // only this disposable fixture: no commit, branch switch or remote.
        if (!home.startsWith(e.PAPERCUSP_WORKSPACES_ROOT + path.sep)) throw Error('fixture root escaped private workspace');
        const initialized = spawnSync('git', ['init', '--quiet', home], { encoding: 'utf8', timeout: 5000 });
        const repository = spawnSync('git', ['-C', home, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000 });
        if (initialized.status !== 0 || repository.status !== 0 || repository.stdout.trim() !== home) {
          throw Error('Private mutation repository preflight failed: ' + initialized.stderr + repository.stderr);
        }
        report.repositoryPreflight = { root: repository.stdout.trim(), initialized: true, noCommit: true };
        publish();
        const source = 'export const values = [' + Array.from({length: 30000}, (_, i) => JSON.stringify('controlled-source-' + i)).join(',') + '];\n';
        const test = "import { values } from './subject'; export const observed = values.length;\n";
        fs.writeFileSync(path.join(home, 'subject.ts'), source);
        fs.writeFileSync(path.join(home, 'subject.txt'), source);
        fs.writeFileSync(path.join(home, 'caller.test.ts'), test);
        report.inputs = { sourceBytes: Buffer.byteLength(source), sourceSha256: hash(source), testSha256: hash(test) };
        const stat = pid => {
          const value = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
          return value.slice(value.lastIndexOf(')') + 2).split(' ');
        };
        const executableHashes = new Map();
        const resources = pid => {
          const row = stat(pid), executable = fs.readlinkSync('/proc/' + pid + '/exe');
          const executableStat = fs.statSync('/proc/' + pid + '/exe');
          const executableKey = [executableStat.dev, executableStat.ino, executableStat.size, executableStat.mtimeMs].join(':');
          let executableSha256 = executableHashes.get(executableKey);
          if (!executableSha256) {
            executableSha256 = hash(fs.readFileSync('/proc/' + pid + '/exe'));
            executableHashes.set(executableKey, executableSha256);
          }
          const memory = fs.readFileSync('/proc/' + pid + '/smaps_rollup', 'utf8');
          const kb = name => Number(new RegExp('^' + name + ':\\s+(\\d+)', 'm').exec(memory)?.[1]);
          return { pid, parent: Number(row[1]), startTicks: row[19], executable,
            executableSha256,
            pssKiB: kb('Pss'), anonymousKiB: kb('Anonymous'), privateDirtyKiB: kb('Private_Dirty') };
        };
        const descendants = pid => {
          const rows = [];
          const visit = parent => {
            let children;
            try { children = fs.readFileSync('/proc/' + parent + '/task/' + parent + '/children', 'utf8').trim(); }
            catch { return; }
            for (const child of children ? children.split(/\s+/).map(Number) : []) {
              try { rows.push(resources(child)); visit(child); } catch { /* exited between ancestry and sample */ }
            }
          };
          visit(pid); return rows;
        };
        (async () => {
          const { createCdpClient, readProcessMemory, withFunctionCallTrace } = await import(e.TEST_INSPECTOR_PATH);
          for (const mode of ['control', 'compiler']) {
            const cohort = { mode, samples: [], requests: [], descendants: [], pauses: 0, reaped: false };
            report.cohorts.push(cohort); publish();
            const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', e.TEST_BUNDLE_PATH], {
              cwd: path.join(process.cwd(), 'apps/operator'), env: { ...e, MALLOC_ARENA_MAX: e.TEST_MALLOC_ARENA_MAX,
                PAPERCUSP_INTEGRATION_ROOT: home, PAPERCUSP_CANONICAL_TREE: home },
              stdio: ['ignore', 'pipe', 'pipe'] });
            const exited = new Promise(resolve => child.once('exit', resolve));
            let startup = '', tail = '', client, lease, poll;
            const seen = new Map();
            child.stdout?.setEncoding('utf8');
            child.stderr?.setEncoding('utf8');
            for (const stream of [child.stdout, child.stderr]) stream?.on('data', (text) => {
              tail = (tail + text).slice(-2000);
              if (stream === child.stderr) startup += text;
            });
            const call = async (name, args) => {
              const body = JSON.stringify({ name, args, harness: e.PAPERCUSP_POT_HOME_SLUG, confirmed: true });
              const response = await fetch(e.PAPERCUSP_OPERATOR_URL + '/api/agent-mcp/run-tool', {
                method: 'POST', headers: { 'content-type': 'application/json', 'x-papercusp-workspace': e.PAPERCUSP_WORKSPACE_ID },
                body, signal: AbortSignal.timeout(30000) });
              const value = await response.json();
              if (!response.ok || !value.ok) throw Error(name + ': ' + JSON.stringify(value));
              // Tools use either data or text results; preserve the exact body too.
              const result = value.result?.data ?? value.result;
              const text = result?.content?.find(row => row.type === 'text')?.text;
              return { value: text ? JSON.parse(text) : result, requestSha256: hash(body), requestBytes: Buffer.byteLength(body) };
            };
            try {
              const deadline = Date.now() + 150000;
              let ready = false;
              let endpoint;
              while (Date.now() < deadline) {
                if (child.exitCode !== null || child.signalCode !== null) throw Error('host exited: ' + tail);
                endpoint = [...startup.matchAll(/^Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+)\r?$/gm)].at(-1)?.[1];
                try { const r = await fetch(e.PAPERCUSP_OPERATOR_URL + '/api/health/ready', { signal: AbortSignal.timeout(1000) });
                  if ((await r.json()).ready && endpoint) { ready = true; break; } } catch {}
                await wait(250);
              }
              if (!ready || !endpoint) throw Error('host inspector/readiness timeout: ' + tail);
              client = createCdpClient(endpoint, { requestTimeoutMs: 5000 }); await client.connect();
              const identity = (await client.evaluate('({pid:process.pid,entry:process.argv[1]})', { returnByValue: true })).result.value;
              if (identity.pid !== child.pid || identity.entry !== e.TEST_BUNDLE_PATH) throw Error('serving PID/entry mismatch');
              cohort.identity = { ...identity, startTicks: stat(child.pid)[19], bundleSha256: hash(fs.readFileSync(identity.entry)) };
              client.ws.on('message', raw => { try { if (JSON.parse(String(raw)).method === 'Debugger.paused') cohort.pauses++; } catch {} });
              const locked = await call('locks:acquire', { paths: [mode === 'compiler' ? 'subject.ts' : 'subject.txt'],
                coordination_domain: home, intent: 'mutation probe', ttl_sec: 120 });
              lease = locked.value;
              cohort.leaseReceipt = lease;
              if (!lease?.acquired && !lease?.ok) throw Error('private mutation lease not acquired: ' + JSON.stringify(lease));
              const sample = async phase => {
                const parent = await readProcessMemory(client, { expectedPid: child.pid });
                cohort.samples.push({ phase, ...parent, os: resources(child.pid), descendants: descendants(child.pid) }); publish();
              };
              await sample('preflight');
              cohort.poll = { intervalMs: 20, ticks: 0, totalMs: 0, maxMs: 0 };
              const collect = () => {
                const started = performance.now();
                for (const row of descendants(child.pid)) {
                const key = row.pid + ':' + row.startTicks, prior = seen.get(key);
                seen.set(key, { ...row, samples: (prior?.samples || 0) + 1,
                  peakPssKiB: Math.max(prior?.peakPssKiB || 0, row.pssKiB) });
                }
                const elapsed = performance.now() - started;
                cohort.poll.ticks++; cohort.poll.totalMs += elapsed; cohort.poll.maxMs = Math.max(cohort.poll.maxMs, elapsed);
              };
              poll = setInterval(collect, 20);
              const traced = await withFunctionCallTrace(client, { expectedPid: child.pid,
                targets: [{ name: 'fork', expression: "process.getBuiltinModule('child_process').fork" }],
                durationMs: 30000, maxCalls: 16, maxStacks: 4, maxStackChars: 3000 }, async () => {
                for (let window = 0; window < 3; window++) {
                  const response = await call('testing:run', { files: ['caller.test.ts'], timeoutMs: 1000 });
                  cohort.requests.push({ window, ...response });
                  if (response.value?.root !== home) throw Error('Testing request escaped the private repository: ' + response.value?.root);
                  if (response.value?.error !== 'mutation_probe_active') throw Error('Expected real mutation refusal: ' + JSON.stringify(response.value));
                  if (mode === 'compiler' && !response.value.hint?.includes('may observe it: imports ')) {
                    throw Error('Compiler closure was not established: ' + response.value.hint);
                  }
                  await sample('window-' + window);
                }
              });
              cohort.trace = traced.trace;
              clearInterval(poll); poll = undefined;
              await wait(1000); await sample('bounded-idle');
              cohort.descendants = [...seen.values()];
              cohort.unreaped = cohort.descendants.filter(row => { try { return stat(row.pid)[19] === row.startTicks; } catch { return false; } });
            } catch (error) { cohort.error = String(error); cohort.hostErrorTail = tail; throw error; }
            finally {
              clearInterval(poll);
              if (lease?.lock_id || lease?.lockId) {
                try { cohort.leaseRelease = (await call('locks:release', { lock_id: lease.lock_id || lease.lockId })).value; }
                catch (error) { cohort.leaseReleaseError = String(error); }
              }
              client?.close();
              if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGTERM'); await Promise.race([exited, wait(5000)]);
                if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
              }
              child.stdout.destroy(); child.stderr.destroy(); cohort.reaped = child.exitCode !== null || child.signalCode !== null;
              publish();
            }
          }
          report.incomplete = false; publish();
        })().catch(error => { report.error = String(error); publish(); process.exitCode = 1; });
      `;
      const logPath = process.env.PAPERCUSP_P011_SERVING_COMPILER_LOG || join(directory, 'launcher.log');
      const result = runCohortWithLog([join(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime=operator-api',
        '--', process.execPath, '-e', probe], { cwd: root, timeout: 360_000,
        env: { ...process.env, TEST_BUNDLE_PATH: bundle, TEST_BUNDLE_HASH: bundleHash, TEST_WORKER_HASH: workerHash,
          TEST_SOURCE_DIRECTORY: sourceDirectory ?? '', TEST_REPORT_PATH: reportPath, TEST_INSPECTOR_PATH: inspectorPath,
          TEST_MALLOC_ARENA_MAX: HOST_MALLOC_ARENA_MAX } }, logPath);
      const report = readCohortReport(reportPath, result);
      report.runner.log = result.log;
      if (destination) writeFileSync(resolve(root, destination), serializeIdentitySafeJson(report));
      expect(result.status, existsSync(reportPath) ? report.error : result.stderr.slice(-2000)).toBe(0);
      expect(report.incomplete).toBe(false);
      expect(report.cohorts).toHaveLength(2);
      const [control, compiler] = report.cohorts;
      expect(control.requests.map((row: any) => row.requestSha256)).toEqual(compiler.requests.map((row: any) => row.requestSha256));
      expect(control.trace.calls.fork.calls).toBe(0);
      expect(compiler.trace.calls.fork.calls).toBe(3);
      expect(compiler.trace.calls.fork.stacks.join('\n')).toContain('testImportClosures');
      expect(compiler.descendants.some((row: any) => row.executable.endsWith('/esbuild') && row.pssKiB > 0)).toBe(true);
      for (const cohort of report.cohorts) {
        expect(cohort.identity.bundleSha256).toBe(bundleHash);
        expect(cohort.samples.map((row: any) => row.phase)).toEqual(['preflight', 'window-0', 'window-1', 'window-2', 'bounded-idle']);
        expect(cohort.pauses).toBe(0); expect(cohort.unreaped).toEqual([]); expect(cohort.reaped).toBe(true);
        expect(cohort.leaseReleaseError).toBeUndefined();
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 500_000);

  it.skipIf(!process.env.PAPERCUSP_P011_NATIVE_HEAP_DECODER)('keeps the native decoder control across the maintained isolated runtime boundary', () => {
    const program = String.raw`
      const fs = require('node:fs'), path = require('node:path');
      const snapshot = path.join(process.env.TMPDIR, 'decoder-control.heapsnapshot');
      let phase = 'env-boundary';
      (async () => {
        if (process.env.PAPERCUSP_P011_NATIVE_HEAP_DECODER)
          throw Error('Ambient control must be stripped');
        if (process.env.PAPERCUSP_P011_NATIVE_HEAP_ADAPTER)
          throw Error('Ambient adapter control must be stripped');
        if (!process.env.TEST_NATIVE_HEAP_DECODER) throw Error('Explicit decoder input was lost');
        phase = 'import';
        const { checkNativeHeapDecode, summarizeHeapRetainers } = await import(require('node:url').pathToFileURL(process.env.TEST_HEAP_ANALYZER));
        phase = 'snapshot';
        fs.mkdirSync(process.env.TMPDIR, { recursive: true });
        require('node:v8').writeHeapSnapshot(snapshot);
        phase = 'native-decode';
        const result = await checkNativeHeapDecode(fs.readFileSync(snapshot), process.env.TEST_NATIVE_HEAP_DECODER);
        console.log('NATIVE_DECODER_CONTROL ' + JSON.stringify(result));
        if (process.env.TEST_NATIVE_HEAP_ADAPTER) {
          phase = 'native-retainers';
          const report = await summarizeHeapRetainers(fs.readFileSync(snapshot), {
            nativeExecutable: process.env.TEST_NATIVE_HEAP_ADAPTER, top: 2, perClass: 1, retainerDepth: 1,
          });
          console.log('NATIVE_ADAPTER_CONTROL ' + JSON.stringify({ native: report.native,
            groups: report.groups.length, inputMatches: report.native.inputSha256 === result.inputSha256 }));
        }
      })().catch(error => { console.error(JSON.stringify({ phase, errorClass: error.name, errorCode: error.code }));
        process.exitCode = 1; }).finally(() => fs.rmSync(snapshot, { force: true }));
    `;
    const directory = mkdtempSync(join(tmpdir(), 'native-decoder-boundary-'));
    const outPath = join(directory, 'stdout.log'), errPath = join(directory, 'stderr.log');
    const out = openSync(outPath, 'w'), err = openSync(errPath, 'w');
    let stdout: string;
    try {
      const result = spawnSync(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime=operator-api', '--', process.execPath, '-e', program], {
        cwd: root, timeout: 120_000, stdio: ['ignore', out, err],
        env: { ...process.env, TEST_NATIVE_HEAP_DECODER: process.env.PAPERCUSP_P011_NATIVE_HEAP_DECODER,
          TEST_NATIVE_HEAP_ADAPTER: process.env.PAPERCUSP_P011_NATIVE_HEAP_ADAPTER ?? '',
          TEST_HEAP_ANALYZER: resolve(root, 'scripts/analyze-heap-snapshots.mjs') },
      });
      stdout = readFileSync(outPath, 'utf8');
      if (result.status !== 0) throw new Error('Native decoder boundary guard failed: ' +
        JSON.stringify({ status: result.status, signal: result.signal,
          error: result.error && 'code' in result.error ? result.error.code : null,
          stdout: stdout.slice(-2000), stderr: readFileSync(errPath, 'utf8').slice(-2000) }));
    } finally { closeSync(out); closeSync(err); rmSync(directory, { recursive: true, force: true }); }
    const line = stdout.split('\n').find(line => line.startsWith('NATIVE_DECODER_CONTROL '));
    expect(line).toBeDefined();
    const report = JSON.parse(line!.slice('NATIVE_DECODER_CONTROL '.length));
    expect(report.decoded).toBe(true);
    expect(report.executableSha256).toBe(createHash('sha256')
      .update(readFileSync(process.env.PAPERCUSP_P011_NATIVE_HEAP_DECODER!)).digest('hex'));
    expect(report.inputBytes).toBeGreaterThan(0);
    expect(report.stdoutBytes).toBeLessThan(10);
    if (process.env.PAPERCUSP_P011_NATIVE_HEAP_ADAPTER) {
      const adapterLine = stdout.split('\n').find(line => line.startsWith('NATIVE_ADAPTER_CONTROL '));
      expect(adapterLine).toBeDefined();
      const adapter = JSON.parse(adapterLine!.slice('NATIVE_ADAPTER_CONTROL '.length));
      expect(adapter.inputMatches).toBe(true);
      expect(adapter.groups).toBe(2);
      expect(adapter.native.status).toBe(0);
      expect(adapter.native.stderrBytes).toBe(0);
      expect(adapter.native.executableSha256).toBe(createHash('sha256')
        .update(readFileSync(process.env.PAPERCUSP_P011_NATIVE_HEAP_ADAPTER)).digest('hex'));
    }
  }, 150_000);

  it.each(['diagnostic', 'ordinary', ...(process.env.PAPERCUSP_P011_HEAP_CENSUS === '1' ? ['snapshot'] : []),
    ...(process.env.PAPERCUSP_P011_HEAP_RETAINERS === '1' ? ['retainers'] : [])] as const)('binds %s PSS/heap/native samples and bounded query bytes to the serving PID, then reaps it', async mode => {
    const destination = evidenceDestination(process.env.PAPERCUSP_P011_REPORT);
    // Read the maintained desktop transport contract before bundle/DB work.
    // The separate device route supports only its curated mobile query names.
    const queryRoute = (await import('./endpoint-route/routes/zero-harness/rest-query')).default;
    expect(queryRoute.auth).toBe('loopback');
    const queryPath = '/api' + queryRoute.path;
    const nativeDecoder = mode === 'retainers' ? process.env.PAPERCUSP_P011_NATIVE_HEAP_DECODER : undefined;
    const nativeAdapter = mode === 'retainers' ? process.env.PAPERCUSP_P011_NATIVE_HEAP_ADAPTER : undefined;
    if (nativeAdapter) {
      const preflight = spawnSync(nativeAdapter, ['--version'], { encoding: 'utf8', timeout: 5000 });
      expect(preflight.status, 'Native adapter must be executable before runtime preparation').toBe(0);
      expect(preflight.stdout.trim()).toBe('papercusp-heap-retainers 0.1.0');
    }
    if (nativeDecoder) {
      const preflight = spawnSync(nativeDecoder, ['--version'], { encoding: 'utf8', timeout: 5000 });
      expect(preflight.status, 'Native decoder must be executable before runtime preparation').toBe(0);
      expect(preflight.stdout.trim()).toBe('v8-heap-cli 0.1.0');
    }
    const bundleRoot = mkdtempSync(join(tmpdir(), 'papercusp-memory-cohort-'));
    const bundle = join(bundleRoot, 'host/hono-host.mjs');
    const reportPath = join(bundleRoot, 'cohort-report.json');
    symlinkSync(resolve(root, 'node_modules'), join(bundleRoot, 'node_modules'), 'dir');
    const probe = String.raw`
      const { spawn } = require('node:child_process');
      const { readFileSync, writeFileSync, renameSync, readlinkSync } = require('node:fs');
      const { createHash } = require('node:crypto');
      const { pathToFileURL } = require('node:url');
      const path = require('node:path');
      const postgres = require('postgres');
      const inspectorEndpoints = ${inspectorEndpoints.toString()};
      const completedQuerySamples = ${completedQuerySamples.toString()};
      const namedRequestQueryResults = ${namedRequestQueryResults.toString()};
      const assertNamedQueryHeapSelection = ${assertNamedQueryHeapSelection.toString()};
      const retainedContainerCensus = ${retainedContainerCensus.toString()};
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const e = process.env, base = e.PAPERCUSP_OPERATOR_URL;
      const report = { schemaVersion: 1, plane: 'isolated-current-build-operator-api', incomplete: true,
        buildSha: e.TEST_BUILD_SHA, bundleHash: e.TEST_BUNDLE_HASH, sourceDirectory: e.TEST_SOURCE_DIRECTORY || null,
        mode: e.TEST_COHORT_MODE, startedAt: new Date().toISOString(), profilerOperations: [],
        workload: { population: 1024, pageLimit: 128, windows: 3, requestsPerWindow: 8, concurrency: 8 },
        samples: [], windows: [], retainedContainers: [], phases: [], limitations: [
          'One owned request-only process; background, production workers and fleet workloads are not measured.',
          'Sampling selfSize is live sampled allocation, not total heap or a retained-state owner.',
          'Completed-result diagnostic bytes are PostgreSQL wire bytes, not HTTP, payload storage or retained heap.',
          'Diagnostic/snapshot modes label profiler/GC interventions; ordinary mode performs neither profiler mutation nor forced GC.',
          'Snapshot census reports post-GC V8 node self sizes, not exclusive retained ownership or production savings.',
          'Idle windows are bounded private HTTP baseline windows, not ambient production idle or leak evidence.'
        ] };
      let host, cdp, sql, inspectorUrl, sampling = false;
      let errors = '', startup = '';
      const publish = () => {
        // Complete reports grow with samples. Persist atomically outside the
        // disposable runtime home; stdout is a progress channel, not storage.
        writeFileSync(e.TEST_REPORT_PATH + '.next', JSON.stringify(report));
        renameSync(e.TEST_REPORT_PATH + '.next', e.TEST_REPORT_PATH);
        console.error('P011_MEMORY_PROGRESS ' + JSON.stringify({ phase: report.phase,
          samples: report.samples.length, windows: report.windows.length, incomplete: report.incomplete }));
      };
      const phase = label => {
        report.phase = label; report.phases.push({ label, at: new Date().toISOString() });
        console.error('P011_PHASE ' + label); publish();
      };
      // The maintained isolated-runtime route intentionally strips PAPERCUSP_*
      // ambient controls. Test inputs cross that boundary explicitly as TEST_*.
      if (e.TEST_NATIVE_HEAP_ADAPTER) {
        const preflight = require('node:child_process').spawnSync(e.TEST_NATIVE_HEAP_ADAPTER,
          ['--version'], { encoding: 'utf8', timeout: 5000 });
        if (preflight.status !== 0 || preflight.stdout.trim() !== 'papercusp-heap-retainers 0.1.0')
          throw Error('Private native retainer adapter precondition failed');
        report.nativeAdapterPreflight = { version: preflight.stdout.trim(),
          sha256: createHash('sha256').update(readFileSync(e.TEST_NATIVE_HEAP_ADAPTER)).digest('hex') };
        publish();
      }
      if (e.TEST_NATIVE_HEAP_DECODER) {
        const preflight = require('node:child_process').spawnSync(e.TEST_NATIVE_HEAP_DECODER,
          ['--version'], { encoding: 'utf8', timeout: 5000 });
        if (preflight.status !== 0 || preflight.stdout.trim() !== 'v8-heap-cli 0.1.0')
          throw Error('Private native decoder precondition failed');
        report.nativeDecoderPreflight = { version: preflight.stdout.trim(),
          sha256: createHash('sha256').update(readFileSync(e.TEST_NATIVE_HEAP_DECODER)).digest('hex') };
        publish();
      }
      const call = async (route, method = 'GET', body) => {
        const response = await fetch(base + route, { method,
          headers: { 'content-type': 'application/json', 'x-papercusp-workspace': e.PAPERCUSP_WORKSPACE_ID },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
        const bytes = Buffer.from(await response.arrayBuffer());
        if (response.status !== 200) {
          let error;
          try { const value = JSON.parse(bytes.toString()); error = value.error?.code ?? value.error ?? value.code; }
          catch { error = 'non-JSON response'; }
          report.httpFailure = { route, method, status: response.status, error: String(error).slice(0, 500) };
          throw new Error(route + ' HTTP ' + response.status + ': ' + report.httpFailure.error);
        }
        return { body: JSON.parse(bytes.toString()), bytes: bytes.length,
          requestId: response.headers.get('x-papercusp-request-id') };
      };
      const descendants = pid => {
        const result = [];
        const visit = current => {
          const text = readFileSync('/proc/' + current + '/task/' + current + '/children', 'utf8').trim();
          for (const child of text ? text.split(/\s+/).map(Number) : []) { result.push(child); visit(child); }
        };
        visit(pid); return result;
      };
      const executableHashes = new Map();
      const osMemory = pid => {
        if (!Number.isInteger(pid) || pid <= 0) throw new Error('Positive serving PID required');
        const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
        const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
        const executable = readlinkSync('/proc/' + pid + '/exe');
        if (!executableHashes.has(executable)) executableHashes.set(executable,
          createHash('sha256').update(readFileSync('/proc/' + pid + '/exe')).digest('hex'));
        const rollup = readFileSync('/proc/' + pid + '/smaps_rollup', 'utf8');
        const kb = name => {
          const match = rollup.match(new RegExp('^' + name + ':\\s+(\\d+) kB$', 'm'));
          if (!match) throw new Error('Missing ' + name + ' for PID ' + pid);
          return Number(match[1]) * 1024;
        };
        return { pid, startTicks, executable, executableSha256: executableHashes.get(executable),
          pssBytes: kb('Pss'), rssBytes: kb('Rss'), anonymousBytes: kb('Anonymous') };
      };
      const sample = async label => {
        const started = Date.now();
        const result = await cdp.evaluate('(' + function inspectorSample(projectResults) {
          const slots = globalThis[Symbol.for('@papercusp/module-singleton.slots')];
          const state = slots?.get('@papercusp/db-org.acquire-registry')?.value;
          if (!state) throw new Error('Completed-query registry is unobserved');
          return { pid: process.pid, memory: process.memoryUsage(), uptime: process.uptime(),
            heap: process.getBuiltinModule('v8').getHeapStatistics(),
            pools: [...state.pools].map(([pool, value]) => ({ pool,
              totalRecorded: value.totalPgResults ?? 0,
              results: projectResults(value.pgResults ?? []) })) };
        }.toString() + ')(' + completedQuerySamples.toString() + ')', { returnByValue: true });
        const value = result.result.value;
        if (value.pid !== host.pid) throw new Error('Inspector PID mismatch');
        const pids = [host.pid, ...descendants(host.pid)];
        const measured = { label, at: new Date().toISOString(), observerMs: Date.now() - started,
          ...value, processes: pids.map(osMemory) };
        report.samples.push(measured); publish(); return measured;
      };
      const allocationSummary = profile => {
        const totals = new Map();
        const walk = node => {
          const frame = node.callFrame;
          const key = (frame.functionName || '(anonymous)') + '@' + path.basename(frame.url || '') + ':' + frame.lineNumber;
          totals.set(key, (totals.get(key) || 0) + node.selfSize);
          for (const child of node.children || []) walk(child);
        };
        walk(profile.head);
        return { sampledLiveBytes: [...totals.values()].reduce((a, b) => a + b, 0),
          top: [...totals].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([frame, bytes]) => ({ frame, bytes })) };
      };
      const profiler = async (method, args) => {
        if (report.mode !== 'diagnostic') throw new Error('Profiler operation in ordinary baseline');
        report.profilerOperations.push(method); return cdp.send(method, args);
      };
      (async () => {
        phase('private-profile-preflight');
        if (e.PAPERCUSP_BACKGROUND_WORKERS !== '0' || !e.PAPERCUSP_WORKSPACE_ID.startsWith('test-runtime-'))
          throw new Error('Private operator-api profile required');
        sql = postgres(e.HARNESS_ADMIN_DATABASE_URL, { max: 1 });
        const identity = (await sql.unsafe('select current_database() as database'))[0];
        const schema = (await sql.unsafe('select filename, sha256, applied_at from harness_shared.schema_migrations order by applied_at desc limit 1'))[0];
        report.database = identity.database; report.schema = schema;
        if (!schema?.filename || !/^[a-f0-9]{64}$/.test(schema.sha256)) throw new Error('Migration identity unmeasured');
        phase('fixture-preflight');
        await sql.unsafe('insert into harness_shared.work_items (workspace_id,harness_slug,feature_id,title,summary,status,kind,payload,created_ts,updated_ts) ' +
          "select $1,$2,'WI-P011-' || g,'P011 fixture ' || g,repeat('controlled-summary-',128),'open','issue'," +
          "jsonb_build_object('_ei',jsonb_build_object('severity','minor'),'controlled',repeat('payload-',512)),g,g from generate_series(1,1024) g",
          [e.PAPERCUSP_WORKSPACE_ID, e.PAPERCUSP_POT_HOME_SLUG]);
        const population = (await sql.unsafe('select count(*)::int as n from harness_shared.work_items where workspace_id=$1 and harness_slug=$2',
          [e.PAPERCUSP_WORKSPACE_ID, e.PAPERCUSP_POT_HOME_SLUG]))[0].n;
        if (population !== report.workload.population) throw new Error('Private fixture population mismatch');
        await sql.end(); sql = null;
        phase('host-launch');
        // Match the maintained launchers and avoid paying a second module load.
        // Latest-endpoint selection still protects callers that need a re-exec.
        report.arenaMax = e.MALLOC_ARENA_MAX || e.TEST_MALLOC_ARENA_MAX;
        host = spawn(process.execPath, ['--inspect=127.0.0.1:0', e.TEST_BUNDLE_PATH], {
          cwd: path.join(process.cwd(), 'apps/operator'), env: { ...e, MALLOC_ARENA_MAX: report.arenaMax },
          stdio: ['ignore', 'pipe', 'pipe'] });
        report.pid = host.pid;
        host.stdout?.setEncoding('utf8');
        host.stderr?.setEncoding('utf8');
        for (const stream of [host.stdout, host.stderr]) stream?.on('data', (text) => {
          errors = (errors + text).slice(-3000);
          if (stream === host.stderr) {
            startup = (startup + text).slice(-32768);
            const endpoints = inspectorEndpoints(startup);
            if (endpoints.length) {
              report.inspectorEndpoints = endpoints;
              inspectorUrl = endpoints[endpoints.length - 1];
            }
          }
        });
        const deadline = Date.now() + 150000;
        let ready = false;
        while (Date.now() < deadline) {
          if (host.exitCode !== null || host.signalCode !== null) throw new Error('Owned host exited');
          try { const response = await call('/api/health/ready'); if (response.body.ready && inspectorUrl) { ready = true; break; } }
          catch {} await wait(500);
        }
        if (!ready) throw new Error('Owned host readiness failed');
        phase('inspector-owner-preflight');
        const { createCdpClient } = await import(pathToFileURL(path.join(process.cwd(), 'scripts/cdp-inspector.mjs')));
        cdp = createCdpClient(inspectorUrl); await cdp.connect();
        report.pauses = 0;
        cdp.ws.on('message', raw => { try { if (JSON.parse(String(raw)).method === 'Debugger.paused') report.pauses++; } catch {} });
        const owner = (await cdp.evaluate('({ pid: process.pid, entry: process.argv[1], arenaMax: process.env.MALLOC_ARENA_MAX })',
          { returnByValue: true })).result.value;
        report.inspector = { endpoint: inspectorUrl, ...owner };
        if (owner.pid !== host.pid || owner.entry !== e.TEST_BUNDLE_PATH || owner.arenaMax !== report.arenaMax)
          throw new Error('Inspector serving-process identity mismatch');
        phase('named-query-preflight');
        report.transport = { route: e.TEST_QUERY_ROUTE, auth: 'loopback', workspaceId: e.PAPERCUSP_WORKSPACE_ID };
        const route = e.TEST_QUERY_ROUTE + '?name=workItems.byHarness&args=' + encodeURIComponent(JSON.stringify({ harnessSlug: e.PAPERCUSP_POT_HOME_SLUG, limit: 128 }));
        // Warm the same named route before the paired idle/ordinary windows.
        const warmStartedAt = Date.now();
        const warm = await call(route);
        if (warm.body.rows?.length !== 128) throw new Error('Fixture page did not return 128 rows');
        report.warmHttpBytes = warm.bytes;
        const warmRows = JSON.stringify(warm.body.rows);
        report.rowFingerprint = createHash('sha256').update(warmRows).digest('hex');
        const preflight = await sample('query-preflight');
        // readWorkItemsPageFromStore deliberately fetches limit+1 before slicing
        // the HTTP page. pgQueryFamily names the FIRST FROM (the spine CTE), not
        // every relation touched by a query, so do not infer its owner from it.
        const completedPage = row => row.status === 'ok' && row.rowCount === 129 && row.wireBytes > 0;
        report.namedQuery = { name: 'workItems.byHarness', requestId: warm.requestId, startedAt: warmStartedAt,
          httpRows: warm.body.rows.length, expectedDbRows: 129,
          results: namedRequestQueryResults(preflight.pools, [warm.requestId]) };
        if (!report.namedQuery.results.some(completedPage))
          throw new Error('Completed named-query diagnostic unobserved');
        for (let window = 0; window < 3; window++) {
          phase('matched-window-' + window);
          if (report.mode === 'diagnostic') { await profiler('HeapProfiler.startSampling', { samplingInterval: 32768 }); sampling = true; }
          const idleMs = report.mode === 'diagnostic' ? 750 : 2000;
          await sample('idle-' + window + '-start'); await wait(idleMs); await sample('idle-' + window + '-end');
          const idle = sampling ? await profiler('HeapProfiler.stopSampling') : null; sampling = false;
          if (report.mode === 'diagnostic') { await profiler('HeapProfiler.startSampling', { samplingInterval: 32768 }); sampling = true; }
          const start = await sample('ordinary-' + window + '-start');
          const requestStart = Date.now();
          const responses = await Promise.all(Array.from({ length: 8 }, () => call(route).then(({ body, bytes, requestId }) => {
            if (body.rows?.length !== 128) throw new Error('Concurrent fixture page mismatch');
            if (JSON.stringify(body.rows) !== warmRows) throw new Error('Useful fixture rows changed during concurrent reads');
            return { rows: body.rows.length, bytes, requestId, rowFingerprint: report.rowFingerprint };
          })));
          const end = await sample('ordinary-' + window + '-end');
          const ordinary = sampling ? await profiler('HeapProfiler.stopSampling') : null; sampling = false;
          report.windows.push({ window, idleMs, requestWallMs: Date.now() - requestStart,
            startAt: start.at, endAt: end.at, responses,
            completedPageResults: namedRequestQueryResults(end.pools, responses.map(row => row.requestId)),
            idleAllocation: idle ? allocationSummary(idle.profile) : null,
            ordinaryAllocation: ordinary ? allocationSummary(ordinary.profile) : null });
          if (report.mode === 'diagnostic') {
            // Keep GC/enumeration outside the measured request windows and
            // entirely outside the ordinary baseline mode.
            await profiler('HeapProfiler.collectGarbage'); await sample('post-gc-' + window);
            report.retainedContainers.push({ window, maps: await retainedContainerCensus(cdp, 'map'),
              arrays: await retainedContainerCensus(cdp, 'array') }); publish();
          }
        }
        if (report.mode === 'snapshot' || report.mode === 'retainers') {
          phase('private-heap-snapshot');
          const snapshotPath = e.TEST_REPORT_PATH + '.heapsnapshot';
          const started = Date.now();
          try {
            let objectIds;
            const captureSnapshot = async metadata => {
              if (metadata) {
                assertNamedQueryHeapSelection(metadata.records, report.windows.at(-1).completedPageResults);
                report.heapQueryRegistryBeforeSnapshot = metadata; publish();
                await cdp.send('HeapProfiler.enable'); report.profilerOperations.push('HeapProfiler.enable (object IDs)');
              }
              const writeStarted = Date.now();
              report.profilerOperations.push('v8.writeHeapSnapshot (forced GC/synchronous pause)');
              const captured = (await cdp.evaluate('process.getBuiltinModule("v8").writeHeapSnapshot(' +
                JSON.stringify(snapshotPath) + ')', { returnByValue: true }, 120000)).result.value;
              if (captured !== snapshotPath) throw Error('Private snapshot destination mismatch');
              report.heapSnapshotWriteMs = Date.now() - writeStarted; publish();
            };
            if (report.mode === 'retainers' && e.TEST_NATIVE_HEAP_ADAPTER) {
                const { readPinnedHeapObjectIds } = await import(pathToFileURL(path.join(process.cwd(), 'scripts/cdp-inspector.mjs')));
                report.heapOwnerBinding = await readPinnedHeapObjectIds(cdp, { expectedPid: host.pid, owners: [
                  '@papercusp/memory:host', '@papercusp/memory.local-embedder-worker',
                  '@papercusp/operator-core.harnessCoreCaches', '@papercusp/operator-core.operatorCache',
                  '@papercusp/operator-core.snapshot-fold-slots', '@papercusp/lexicon:host',
                  '@papercusp/operator-core.repoCitationTrackingCache', '@papercusp/operator-core.agentsAcrossWorkspaceCache',
                  '@papercusp/operator-core.midTurnMemoryAdmission',
                ], pgRequestIds: report.windows.at(-1).responses.map(row => row.requestId), captureSnapshot });
                const queries = report.heapOwnerBinding.queries;
                if (queries.unobservedRequestIds.length || queries.omitted || queries.omittedPools || queries.omittedRows)
                  throw Error('Exact request weak-object coverage is incomplete');
                assertNamedQueryHeapSelection(queries.records, report.windows.at(-1).completedPageResults);
                objectIds = [...new Set([
                  ...report.heapOwnerBinding.roots.filter(root => root.status === 'found').map(root => root.id),
                  ...queries.records.flatMap(row => row.objects.filter(object => object.status === 'found').map(object => object.id)),
                ])];
                if (!objectIds.length) throw Error('No singleton snapshot object IDs observed');
                if (!report.heapOwnerBinding.roots.some(root => root.owner === '@papercusp/operator-core.operatorCache' && root.status === 'found'))
                  throw Error('Operator cache snapshot binding unobserved');
                await cdp.send('HeapProfiler.disable'); report.profilerOperations.push('HeapProfiler.disable (object IDs)');
                publish();
            } else await captureSnapshot(null);
            const { summarizeHeapSnapshotStream, summarizeHeapRetainers } = await import(pathToFileURL(e.TEST_HEAP_ANALYZER));
            const summaryStarted = Date.now();
            const summary = await summarizeHeapSnapshotStream(require('node:fs').createReadStream(snapshotPath));
            report.heapSnapshot = { ...summary, durationMs: Date.now() - started,
              writeMs: report.heapSnapshotWriteMs, summaryMs: Date.now() - summaryStarted, pid: host.pid };
            publish();
            if (report.mode === 'retainers') {
              phase('private-heap-retainer-analysis');
              const analysisStarted = Date.now();
              report.heapRetainers = { ...(await summarizeHeapRetainers(readFileSync(snapshotPath),
                { top: 20, perClass: 3, retainerDepth: 1, maxRetainers: 32,
                  decoderControl: e.TEST_NATIVE_HEAP_DECODER || undefined,
                  nativeExecutable: e.TEST_NATIVE_HEAP_ADAPTER || undefined, objectIds })),
                durationMs: Date.now() - analysisStarted, pid: host.pid };
              if (objectIds && (report.heapRetainers.requestedNodes.length !== objectIds.length ||
                  report.heapRetainers.requestedNodes.some(row => row.status !== 'found') ||
                  report.heapRetainers.requestedNodes.some((row, index) => row.id !== objectIds[index])))
                throw Error('Exact singleton IDs missing from captured graph');
              publish();
            }
          } finally {
            require('node:fs').rmSync(snapshotPath, { force: true });
            report.snapshotRemoved = !require('node:fs').existsSync(snapshotPath); publish();
          }
          await sample('post-snapshot');
          const response = await call(route);
          report.postSnapshotRowsPreserved = JSON.stringify(response.body.rows) === warmRows;
          if (!report.postSnapshotRowsPreserved) throw Error('Useful rows changed after snapshot');
        }
        report.incomplete = false; phase('samples-complete');
      })().catch(error => { report.error = String(error); report.hostErrorTail = errors;
        if (error.diagnostic) report.heapRetainerFailure = error.diagnostic;
        report.startupTail = startup.slice(-3000); process.exitCode = 1; publish(); })
      .finally(async () => {
        if (sampling && cdp) { try { await cdp.send('HeapProfiler.stopSampling'); } catch {} }
        if (cdp && report.profilerOperations.includes('HeapProfiler.enable (object IDs)') &&
            !report.profilerOperations.includes('HeapProfiler.disable (object IDs)')) {
          try { await cdp.send('HeapProfiler.disable'); report.profilerOperations.push('HeapProfiler.disable (object IDs)'); } catch {}
        }
        cdp?.close();
        if (host && host.exitCode === null && host.signalCode === null) {
          const exited = new Promise(resolve => host.once('exit', resolve));
          host.kill('SIGTERM'); await Promise.race([exited, wait(5000)]);
          if (host.exitCode === null && host.signalCode === null) { host.kill('SIGKILL'); await exited; }
        }
        host?.stdout.destroy(); host?.stderr.destroy();
        if (sql) await sql.end();
        report.finishedAt = new Date().toISOString(); report.home = e.HOME;
        report.hostReaped = !host || host.exitCode !== null || host.signalCode !== null;
        publish(); console.log('P011_MEMORY_COHORT report=' + e.TEST_REPORT_PATH);
      });
    `;
    try {
      // Reject malformed embedded JS before the expensive runtime preparation.
      expect(() => new Function(probe)).not.toThrow();
      const sourceDirectory = process.env.PAPERCUSP_P011_SERVING_HOST_DIRECTORY;
      const testBuildSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
      const buildSha = sourceDirectory ? process.env.PAPERCUSP_P011_SERVING_BUILD_SHA : testBuildSha;
      expect(buildSha, 'Copied serving artifacts require an explicit serving build identity.').toMatch(/^[a-f0-9]{10,64}$/);
      if (sourceDirectory) {
        cpSync(sourceDirectory, dirname(bundle), { recursive: true });
      } else {
        const build = spawnSync('bash', [resolve(root, 'apps/operator/bin/bundle-host.sh'), 'bin/hono-host.ts', bundle], {
          cwd: resolve(root, 'apps/operator'), encoding: 'utf8', timeout: 120_000,
        });
        expect(build.status, build.stderr.slice(-3000)).toBe(0);
      }
      const bundleHash = createHash('sha256').update(readFileSync(bundle)).digest('hex');
      const result = spawnSync(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime=operator-api', '--', process.execPath, '-e', probe], {
        cwd: root, encoding: 'utf8', timeout: 300_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, TEST_BUNDLE_PATH: bundle, TEST_BUNDLE_HASH: bundleHash, TEST_BUILD_SHA: buildSha,
          TEST_COHORT_MODE: mode, TEST_SOURCE_DIRECTORY: sourceDirectory ?? '', TEST_TEST_BUILD_SHA: testBuildSha,
          TEST_MALLOC_ARENA_MAX: HOST_MALLOC_ARENA_MAX, TEST_QUERY_ROUTE: queryPath, TEST_REPORT_PATH: reportPath,
          TEST_HEAP_ANALYZER: resolve(root, 'scripts/analyze-heap-snapshots.mjs'),
          TEST_NATIVE_HEAP_DECODER: nativeDecoder ?? '', TEST_NATIVE_HEAP_ADAPTER: nativeAdapter ?? '' },
      });
      const report = readCohortReport(reportPath, result);
      if (destination) writeFileSync(destination, serializeIdentitySafeJson(report));
      expect(result.status, report.phase + ': ' + (report.error ?? report.runner.error ?? result.stderr.slice(-3000))).toBe(0);
      expect(report.incomplete).toBe(false);
      expect(report.mode).toBe(mode);
      expect(report.pauses).toBe(0);
      expect(report.hostReaped).toBe(true);
      expect(existsSync(report.home)).toBe(false);
      expect(report.windows).toHaveLength(3);
      expect(report.samples).toHaveLength(mode === 'ordinary' ? 13 : mode === 'diagnostic' ? 16 : 14);
      expect(report.retainedContainers).toHaveLength(mode === 'diagnostic' ? 3 : 0);
      expect(report.profilerOperations).toHaveLength(mode === 'ordinary' ? 0 : mode === 'diagnostic' ? 15 : nativeAdapter ? 3 : 1);
      if (mode === 'snapshot' || mode === 'retainers') {
        expect(report.snapshotRemoved).toBe(true); expect(report.postSnapshotRowsPreserved).toBe(true);
        expect(report.heapSnapshot.pid).toBe(report.pid);
        if (mode === 'retainers') {
          expect(report.heapRetainers.pid).toBe(report.pid);
          expect(report.heapRetainers.groups.length).toBeGreaterThan(0);
          expect(report.heapRetainers.groups.length).toBeLessThanOrEqual(20);
          expect(report.heapRetainers.definition).toContain('class retained sizes overlap');
          if (nativeAdapter) {
            expect(report.nativeAdapterPreflight.sha256).toBe(report.heapRetainers.native.executableSha256);
            expect(report.heapRetainers.native.inputSha256).toBe(report.heapSnapshot.sha256);
            expect(report.heapRetainers.native.inputBytes).toBe(report.heapSnapshot.bytes);
            expect(report.heapRetainers.limits.retainerDepth).toBe(1);
            expect(report.heapOwnerBinding.pid).toBe(report.pid);
            expect(report.heapOwnerBinding.roots).toHaveLength(9);
            const queryBindings = report.heapOwnerBinding.queries;
            expect(queryBindings.selection).toBe('pre-snapshot-metadata-and-weakrefs');
            expect(queryBindings.registryBeforeSnapshot).toEqual(report.heapQueryRegistryBeforeSnapshot);
            expect(queryBindings.registryAfterSnapshot.status).toBe('observed');
            expect(() => assertNamedQueryHeapSelection(queryBindings.records, report.windows.at(-1).completedPageResults)).not.toThrow();
            expect(queryBindings.unobservedRequestIds).toEqual([]);
            expect(queryBindings.records.length).toBeGreaterThanOrEqual(8);
            expect(new Set(queryBindings.records.map((row: any) => row.requestId))).toEqual(
              new Set(report.windows.at(-1).responses.map((row: any) => row.requestId)));
            for (const row of queryBindings.records) {
              expect(row.objects.map((object: any) => object.phase)).toEqual(['decodedResult', 'resolvedRows', 'responseValue']);
              expect(row.objects.every((object: any) => ['found', 'collected', 'not-in-snapshot'].includes(object.status))).toBe(true);
            }
            expect(report.heapRetainers.requestedNodes.length).toBeGreaterThan(0);
            expect(report.heapRetainers.requestedNodes.every((row: any) => row.status === 'found' && row.node.id === row.id)).toBe(true);
            const ids = new Set(report.heapRetainers.requestedNodes.map((row: any) => row.id));
            expect(report.heapOwnerBinding.roots.filter((row: any) => row.status === 'found').every((row: any) => ids.has(row.id))).toBe(true);
            expect(queryBindings.records.flatMap((row: any) => row.objects).filter((object: any) => object.status === 'found')
              .every((object: any) => ids.has(object.id))).toBe(true);
          }
        }
        expect(report.heapSnapshot.census.nodeCount).toBeGreaterThan(0);
        expect(report.heapSnapshot.census.totalSelfSizeBytes).toBeGreaterThan(0);
        expect(report.heapSnapshot.census.types.reduce((sum: number, row: any) => sum + row.count, 0))
          .toBe(report.heapSnapshot.census.nodeCount);
      }
      for (const window of report.windows) {
        expect(window.responses).toHaveLength(8);
        expect(window.responses.every((response: any) => response.rows === 128 &&
          response.rowFingerprint === report.rowFingerprint)).toBe(true);
        if (mode !== 'diagnostic') {
          expect(window.idleMs).toBe(2000);
          expect(window.idleAllocation).toBeNull(); expect(window.ordinaryAllocation).toBeNull();
        }
      }
      for (const census of report.retainedContainers.flatMap((row: any) => [row.maps, row.arrays])) {
        expect(census.checked + census.notApplicable + census.notChecked).toBe(census.population);
        expect(census.checked).toBeLessThanOrEqual(census.limits.objects);
      }
      expect(report.inspector.pid).toBe(report.pid);
      expect(report.inspector.entry).toBe(bundle);
      for (const sample of report.samples) {
        expect(sample.pid).toBe(report.pid);
        expect(sample.memory.heapUsed).toBeGreaterThan(0);
        expect(sample.memory.external).toBeGreaterThanOrEqual(0);
        expect(sample.memory.arrayBuffers).toBeGreaterThanOrEqual(0);
        expect(sample.heap.used_heap_size).toBeGreaterThan(0);
        expect(sample.processes[0].startTicks).toBe(report.samples[0].processes[0].startTicks);
        expect(sample.processes[0].executableSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(sample.processes[0].pssBytes).toBeGreaterThan(0);
        for (const pool of sample.pools) {
          expect(pool.results.length).toBeLessThanOrEqual(32);
          for (const row of pool.results) {
            expect(row.wireBytes).toBeGreaterThanOrEqual(0);
            expect(row.rowCount).toBeGreaterThanOrEqual(0);
          }
        }
      }
      const results = report.samples.flatMap((sample: any) => sample.pools.flatMap((pool: any) => pool.results));
      expect(report.namedQuery.httpRows).toBe(128);
      expect(report.namedQuery.results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((row: any) => row.rowCount === report.namedQuery.expectedDbRows && row.wireBytes > 0)).toBe(true);
      console.log('P011_COHORT_SUMMARY ' + JSON.stringify({ buildSha, bundleHash, pid: report.pid,
        windows: report.windows.length, samples: report.samples.length, database: report.database,
        pssBytes: report.samples.map((sample: any) => sample.processes[0].pssBytes),
        heapUsed: report.samples.map((sample: any) => sample.memory.heapUsed) }));
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true });
    }
  }, 435_000);
});
