/** Read-only METHOD verification. The native e2e reporter measures the selected
 * runtimes before/after execution; this check never starts a learning cycle.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeOperationalRun } from '../agent-tools/testing/record-run';
import { dreamControlEditionDigest } from './dream-control-live-instrument';

const root = resolve(import.meta.dirname, '../../../..');
const enabled = process.env.PAPERCUSP_DREAM_CONTROL_OBSERVATIONS_LIVE === '1';
type Runtime = { host: string; processId: string; buildSha: string };
type Clause = { id: string; status: 'pass' | 'fail' | 'unknown'; healthy: boolean;
  reason: string; rawRefs: string[]; sourceRefs: string[] };
type Snapshot = {
  schemaVersion: string; status: string; reason?: string; runtime: Runtime;
  capturedAt: string; expiresAt: string;
  scope: { workspaceId: string; potSlug: string; since: string; until: string;
    expectedRuntime: Runtime; expectedActionRuntime?: Runtime; expectedGymRuntime?: Runtime };
  observations: Record<string, { status: string }> | null;
  r2Assertions: { healthy: boolean; clauses: Clause[] };
};
type SuccessfulRequestTiming = {
  origin: string; endpoint: string; requestTotalMs: number; headersElapsedMs: number;
  bodyElapsedMs: number; serverResolverMs: number | null;
};
type QueryResponse = {
  rows: Snapshot[];
  timing?: { unit?: string; resolverMs?: number };
};
const MAX_RETAINED_SUCCESS_TIMINGS = 16;
const clauseIds = ['r2:dream-action-decisions', 'r2:gym-admission-decisions',
  'r2:full-admission-and-spend', 'r2:scout-zero-route-lens-cap-provenance',
  'r2:actual-attempts-or-explicit-policy-skips'];

async function observe(
  origin: string,
  args: Record<string, unknown>,
  request: typeof fetch = fetch,
  onSuccessTiming?: (timing: SuccessfulRequestTiming) => void,
): Promise<Snapshot> {
  const url = new URL('/api/zero-harness/rest-query', origin);
  url.searchParams.set('name', 'learning.dream');
  url.searchParams.set('args', JSON.stringify(args));
  const startedAt = performance.now();
  let phase = 'fetch';
  try {
    const response = await request(url, { signal: AbortSignal.timeout(25_000) });
    const headersReceivedAt = performance.now();
    phase = 'http-status';
    expect(response.status, `Dream observation HTTP status from ${origin}`).toBe(200);
    phase = 'response-json';
    const body = await response.json() as QueryResponse;
    const bodyConsumedAt = performance.now();
    phase = 'row-count';
    expect(body.rows).toHaveLength(1);
    onSuccessTiming?.({
      origin,
      endpoint: url.pathname,
      requestTotalMs: Math.round(bodyConsumedAt - startedAt),
      headersElapsedMs: Math.round(headersReceivedAt - startedAt),
      bodyElapsedMs: Math.round(bodyConsumedAt - headersReceivedAt),
      serverResolverMs: body.timing?.unit === 'ms' && Number.isFinite(body.timing.resolverMs)
        ? Math.round(body.timing.resolverMs!) : null,
    });
    return body.rows[0];
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new Error(`Dream observation failed phase=${phase} origin=${origin} endpoint=${url.pathname} elapsedMs=${Math.round(performance.now() - startedAt)}: ${detail}`, { cause: error });
  }
}

// WI-6554700010030749: the decision lines come from the precomputed
// learning.dreamDecisionJournal snapshot, which answers only a window it fully
// covers. A window ending "now" is covered once a scan starts after it, and a
// read of a stale snapshot triggers that scan, so re-observe (bounded) until
// neither decision source reports the window as not yet covered. Every other
// outcome, including a real journal failure, is returned on the first read.
const NOT_YET_COVERED = 'journal-snapshot-does-not-cover-window';
function journalWindowNotYetCovered(row: Snapshot): boolean {
  const sources = row as unknown as Record<string, { value?: { journal?: { journalError?: string | null } } } | undefined>;
  return ['actionDecisions', 'gymDecisions'].some(key =>
    sources[key]?.value?.journal?.journalError?.startsWith(NOT_YET_COVERED) === true);
}
async function observeCoveredWindow(
  origin: string,
  args: Record<string, unknown>,
  onSuccessTiming?: (timing: SuccessfulRequestTiming) => void,
): Promise<Snapshot> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const row = await observe(origin, args, fetch, onSuccessTiming);
    if (!journalWindowNotYetCovered(row) || Date.now() > deadline) return row;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 15_000));
  }
}

describe('Dream observation request diagnostics', () => {
  it('retains endpoint, phase, and elapsed time when the request times out', async () => {
    const request: typeof fetch = async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    await expect(observe('http://127.0.0.1:3170', {}, request)).rejects.toThrow(
      /Dream observation failed phase=fetch origin=http:\/\/127\.0\.0\.1:3170 endpoint=\/api\/zero-harness\/rest-query elapsedMs=\d+: TimeoutError:/,
    );
  });

  it('identifies a timeout while consuming the response body separately from fetch', async () => {
    const response = new Response('{}', { status: 200 });
    response.json = async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    const request: typeof fetch = async () => response;
    await expect(observe('http://127.0.0.1:3170', {}, request)).rejects.toThrow(
      /Dream observation failed phase=response-json origin=http:\/\/127\.0\.0\.1:3170 endpoint=\/api\/zero-harness\/rest-query elapsedMs=\d+: TimeoutError:/,
    );
  });

  it('records bounded successful request, body, and server resolver timings', async () => {
    const row = { status: 'observed' } as Snapshot;
    const measurements: SuccessfulRequestTiming[] = [];
    const response = new Response(JSON.stringify({ rows: [row], timing: { unit: 'ms', resolverMs: 7 } }), { status: 200 });
    await expect(observe('http://127.0.0.1:3170', {}, async () => response,
      timing => measurements.push(timing))).resolves.toEqual(row);
    expect(measurements).toEqual([expect.objectContaining({
      origin: 'http://127.0.0.1:3170', endpoint: '/api/zero-harness/rest-query', serverResolverMs: 7,
    })]);
    expect(measurements[0].requestTotalMs).toBeGreaterThanOrEqual(measurements[0].headersElapsedMs);
    expect(measurements[0].bodyElapsedMs).toBeGreaterThanOrEqual(0);
  });
});

describe.skipIf(!enabled)('Dream control observation live METHOD', () => {
  it('retains coherent source/runtime/TTL and fail-closed clauses with native runtime witnesses', async () => {
    const successRequestTimings: SuccessfulRequestTiming[] = [];
    let omittedSuccessRequestTimings = 0;
    const retainSuccessTiming = (timing: SuccessfulRequestTiming) => {
      if (successRequestTimings.length < MAX_RETAINED_SUCCESS_TIMINGS) {
        successRequestTimings.push(timing);
        console.info('DREAM_CONTROL_SUCCESS_REQUEST_TIMING', JSON.stringify(timing));
      } else omittedSuccessRequestTimings++;
    };
    const profilePath = process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE;
    expect(profilePath, 'select a native reporter runtime profile').toBeTruthy();
    const profile = JSON.parse(readFileSync(resolve(root, profilePath!), 'utf8')) as {
      origin: string; backgroundOrigin: string; workspaceId: string; potSlug: string; runtimeUnits: string[];
    };
    expect(profile.origin).toBe('http://127.0.0.1:3170');
    expect(profile.backgroundOrigin).toBe('http://127.0.0.1:3271');
    expect(profile.workspaceId).toBe('papercusp-workspace');
    expect(profile.potSlug).toBe('papercusp');
    expect(profile.runtimeUnits).toEqual(['hono-host:3170', 'hono-host:3271']);
    // Record this fresh execution through the existing native operational
    // instrument. Its own source snapshots and runtime witnesses remain
    // distinct from the surrounding e2e reporter and historical receipts.
    const filePath = 'packages/operator-core/lib/dream/dream-control-observations.live.e2e.test.ts';
    const measured = await executeOperationalRun({
      filePath, name: 'Dream control observation fresh operational METHOD', framework: 'operational',
      command: ['env', 'PAPERCUSP_DREAM_CONTROL_OBSERVATIONS_LIVE=1',
        `PAPERCUSP_APP_OPERATION_LIVE_PROFILE=${profilePath}`, 'npm', 'run', 'test:file', '--', filePath],
      runtimeUnits: profile.runtimeUnits,
      run: async () => {
        const until = new Date().toISOString();
        const since = new Date(Date.parse(until) - 15 * 60_000).toISOString();
        const base = { potSlug: profile.potSlug, view: 'observations', since, until };
        const unverified = { host: 'unverified', processId: 'unverified', buildSha: 'unverified' };
        const discovery = await observe(profile.origin, { ...base, expectedRuntime: unverified }, fetch, retainSuccessTiming);
        const background = await observe(profile.backgroundOrigin, { ...base, expectedRuntime: unverified }, fetch, retainSuccessTiming);
        for (const [snapshot, host] of [[discovery, 'port-3170'], [background, 'port-3271']] as const) {
          expect(snapshot.status).toBe('unknown');
          expect(snapshot.reason).toBe('wrong-or-unproven-serving-runtime');
          expect(snapshot.runtime.host).toBe(host);
          expect(snapshot.runtime.processId).toMatch(/^linux:[0-9a-f-]+:\d+$/);
          expect(snapshot.runtime.buildSha).toMatch(/^[0-9a-f]{7,64}$/);
          expect(snapshot.r2Assertions.healthy).toBe(false);
          expect(snapshot.r2Assertions.clauses.map(c => c.id)).toEqual(clauseIds);
          expect(snapshot.r2Assertions.clauses.every(c => c.status === 'unknown' && !c.healthy)).toBe(true);
        }
        // Compare the actually loaded source objects, not merely branch distance.
        // The decision-journal producer (WI-6554700010030749) scans on the background
        // host and the API reads its snapshot, so those files are pinned on both builds.
        const decisionJournalPaths = ['packages/operator-core/lib/dream/dream-decision-journal.ts',
          'packages/operator-core/lib/derived-reads/producers.ts'];
        const sourcePaths = ['packages/operator-core/lib/dream/dream-control-observations.ts',
          'packages/operator-core/lib/sync-resolver/index.ts', ...decisionJournalPaths];
        const loadedChecks = [...sourcePaths.map(path => [path, discovery.runtime.buildSha] as const),
          ...decisionJournalPaths.map(path => [path, background.runtime.buildSha] as const)];
        for (const [path, buildSha] of loadedChecks) {
          const loaded = execFileSync('git', ['show', `${buildSha}:${path}`],
            { cwd: root, maxBuffer: 4 * 1024 * 1024 });
          expect(loaded.equals(readFileSync(resolve(root, path))), `${path} differs from loaded source at ${buildSha}`).toBe(true);
        }
        const observation = await observeCoveredWindow(profile.origin, { ...base, expectedRuntime: discovery.runtime,
          actionJournalUnit: 'papercusp-bg-host.service', expectedActionRuntime: background.runtime,
          gymJournalUnit: 'papercusp-bg-host.service', expectedGymRuntime: background.runtime }, retainSuccessTiming);
        const consumedAt = new Date().toISOString();
        expect(observation.schemaVersion).toBe('dream-control-observations-v1');
        expect(observation.status).toBe('observed');
        expect(observation.runtime).toEqual(discovery.runtime);
        expect(observation.scope).toMatchObject({ workspaceId: profile.workspaceId,
          potSlug: profile.potSlug, since, until, expectedRuntime: discovery.runtime,
          expectedActionRuntime: background.runtime, expectedGymRuntime: background.runtime });
        expect(Date.parse(consumedAt)).toBeGreaterThanOrEqual(Date.parse(observation.capturedAt));
        expect(Date.parse(consumedAt)).toBeLessThan(Date.parse(observation.expiresAt));
        expect(Date.parse(observation.expiresAt) - Date.parse(observation.capturedAt)).toBe(60_000);
        expect(Object.keys(observation.observations ?? {}).sort()).toEqual(
          ['activity', 'dream', 'flags', 'governors', 'gym', 'rollingSpend']);
        expect(observation.r2Assertions.clauses.map(c => c.id)).toEqual(clauseIds);
        for (const clause of observation.r2Assertions.clauses) {
          expect(['pass', 'fail', 'unknown']).toContain(clause.status);
          expect(clause.healthy).toBe(clause.status === 'pass');
          expect(clause.reason.length).toBeGreaterThan(0);
          expect(clause.sourceRefs.length).toBeGreaterThan(0);
          expect(clause.rawRefs.length).toBeGreaterThan(0);
          for (const ref of clause.rawRefs) {
            expect(ref.startsWith('/')).toBe(true);
            let raw: unknown = observation;
            for (const key of ref.slice(1).split('/')) {
              expect(raw !== null && typeof raw === 'object' && Object.hasOwn(raw, key), ref).toBe(true);
              raw = (raw as Record<string, unknown>)[key];
            }
          }
        }
        expect(observation.r2Assertions.healthy).toBe(observation.r2Assertions.clauses.every(c => c.healthy));
        const requestTimingEvidence = {
          limit: MAX_RETAINED_SUCCESS_TIMINGS,
          omitted: omittedSuccessRequestTimings,
          requests: successRequestTimings,
        };
        const requestTimingJson = JSON.stringify(requestTimingEvidence);
        console.info('DREAM_CONTROL_SUCCESS_REQUEST_TIMINGS', requestTimingJson);
        // Preserve the one raw edition in the test log for durable artifact capture.
        // A METHOD pass is not a product-health assertion or independent acceptance.
        console.info('DREAM_CONTROL_OBSERVATION_EDITION', JSON.stringify({ consumedAt, observation,
          productR2Healthy: observation.r2Assertions.healthy, sourcePaths, methodOnly: true }));
        return { exitCode: 0,
          summary: `Fresh read-only Dream observation METHOD passed; product health and acceptance remain separate. Request timings: ${requestTimingJson}`,
          assertions: [
            { id: 'method:success-request-timings-bounded',
              passed: successRequestTimings.length > 0 && omittedSuccessRequestTimings === 0,
              evidence: requestTimingJson },
            { id: 'method:server-resolver-timing-present',
              passed: successRequestTimings.length > 0 && successRequestTimings.every(timing => timing.serverResolverMs !== null),
              evidence: requestTimingJson },
            { id: `method:edition-sha256:${dreamControlEditionDigest({ consumedAt, observation })}`, passed: true,
              evidence: 'Native digest of the exact original consumer timestamp and raw observation edition.' },
            { id: 'method:wrong-runtime-refuses', passed: true,
              evidence: 'Both selected hosts refused the unproven runtime before observations were exposed.' },
            { id: 'method:containing-source', passed: true, evidence: JSON.stringify(sourcePaths) },
            { id: 'method:exact-runtime-and-scope', passed: true,
              evidence: JSON.stringify({ runtime: observation.runtime, scope: observation.scope }) },
            { id: 'method:consumer-within-ttl', passed: true,
              evidence: JSON.stringify({ consumedAt, capturedAt: observation.capturedAt, expiresAt: observation.expiresAt }) },
            ...observation.r2Assertions.clauses.map(clause => ({ id: `method:${clause.id}`, passed: true,
              evidence: JSON.stringify({ status: clause.status, healthy: clause.healthy,
                reason: clause.reason, rawRefs: clause.rawRefs, sourceRefs: clause.sourceRefs }) })),
            { id: 'method:unknown-is-unhealthy', passed: true,
              evidence: JSON.stringify({ productR2Healthy: observation.r2Assertions.healthy,
                statuses: observation.r2Assertions.clauses.map(clause => ({ id: clause.id, status: clause.status })) }) },
          ] };
      },
    }, { workspaceId: profile.workspaceId, harnessSlug: profile.potSlug, projectDir: root });
    expect(measured).toMatchObject({ ok: true, status: 'pass', runtimeEnvironmentMeasured: true });
    expect(measured.testRunIds).toHaveLength(1);
    console.info('DREAM_CONTROL_OPERATIONAL_RUN', JSON.stringify(measured));
  }, 300_000);
});
