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
const clauseIds = ['r2:dream-action-decisions', 'r2:gym-admission-decisions',
  'r2:full-admission-and-spend', 'r2:scout-zero-route-lens-cap-provenance',
  'r2:actual-attempts-or-explicit-policy-skips'];

async function observe(origin: string, args: Record<string, unknown>, request: typeof fetch = fetch): Promise<Snapshot> {
  const url = new URL('/api/zero-harness/rest-query', origin);
  url.searchParams.set('name', 'learning.dream');
  url.searchParams.set('args', JSON.stringify(args));
  const startedAt = Date.now();
  let phase = 'fetch';
  try {
    const response = await request(url, { signal: AbortSignal.timeout(25_000) });
    phase = 'http-status';
    expect(response.status, `Dream observation HTTP status from ${origin}`).toBe(200);
    phase = 'response-json';
    const body = await response.json() as { rows: Snapshot[] };
    phase = 'row-count';
    expect(body.rows).toHaveLength(1);
    return body.rows[0];
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new Error(`Dream observation failed phase=${phase} origin=${origin} endpoint=${url.pathname} elapsedMs=${Date.now() - startedAt}: ${detail}`, { cause: error });
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
});

describe.skipIf(!enabled)('Dream control observation live METHOD', () => {
  it('retains coherent source/runtime/TTL and fail-closed clauses with native runtime witnesses', async () => {
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
        const discovery = await observe(profile.origin, { ...base, expectedRuntime: unverified });
        const background = await observe(profile.backgroundOrigin, { ...base, expectedRuntime: unverified });
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
        const sourcePaths = ['packages/operator-core/lib/dream/dream-control-observations.ts',
          'packages/operator-core/lib/sync-resolver/index.ts'];
        for (const path of sourcePaths) {
          const loaded = execFileSync('git', ['show', `${discovery.runtime.buildSha}:${path}`],
            { cwd: root, maxBuffer: 4 * 1024 * 1024 });
          expect(loaded.equals(readFileSync(resolve(root, path))), `${path} differs from loaded source`).toBe(true);
        }
        const observation = await observe(profile.origin, { ...base, expectedRuntime: discovery.runtime,
          actionJournalUnit: 'papercusp-bg-host.service', expectedActionRuntime: background.runtime,
          gymJournalUnit: 'papercusp-bg-host.service', expectedGymRuntime: background.runtime });
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
        // Preserve the one raw edition in the test log for durable artifact capture.
        // A METHOD pass is not a product-health assertion or independent acceptance.
        console.info('DREAM_CONTROL_OBSERVATION_EDITION', JSON.stringify({ consumedAt, observation,
          productR2Healthy: observation.r2Assertions.healthy, sourcePaths, methodOnly: true }));
        return { exitCode: 0,
          summary: 'Fresh read-only Dream observation METHOD passed; product health and acceptance remain separate.',
          assertions: [
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
  }, 90_000);
});
