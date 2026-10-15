/**
 * P-010 matched read benchmark. Normal CI exercises the probe on private PG.
 * An explicit PAPERCUSP_P010_LIVE_PROBE=1 runs SELECTs only against the operator
 * store in ONE repeatable-read/read-only transaction. No production data changes,
 * cache eviction, profiler changes, or service restart are performed.
 *
 * The control is the previous consumer algorithm: full authoritative coverage,
 * then select the requested plan. Candidate narrows that same production reader.
 * SQL wall time includes pool/queue/transfer/decoding; it is NOT database CPU or
 * isolated JSON decoding time. Burst requests deliberately share the frozen
 * transaction's one connection, identically on both sides.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';
import { getHarnessAdminUrl } from './embedded-pg-discovery';

const live = process.env.PAPERCUSP_P010_LIVE_PROBE === '1';
const LIVE_BENCHMARK_TIMEOUT_MS = 7_100_000;
const LIVE_MATRIX_RUNNER_TIMEOUT_MS = LIVE_BENCHMARK_TIMEOUT_MS + 100_000;

function validateFullMatrixBudget(
  liveProbe: boolean, windows: number, requests: number,
  env: Record<string, string | undefined>,
): void {
  if (!liveProbe || windows !== 10 || requests !== 100) return;
  const budget = env.PAPERCUSP_TEST_FILE_TIMEOUT_MS?.trim() ?? '';
  if (!/^\d+$/.test(budget) || Number(budget) < LIVE_MATRIX_RUNNER_TIMEOUT_MS) {
    throw new Error(`Full live P010 matrix requires PAPERCUSP_TEST_FILE_TIMEOUT_MS=${LIVE_MATRIX_RUNNER_TIMEOUT_MS}; ` +
      'the default file-run deadline is shorter than the measured matrix.');
  }
}

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql,
  liveness: new Map<string, any>(), frozenLiveness: false, missingLiveness: new Set<string>(),
  privateFleet: [] as any[], privateSessionState: 'live' }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./fleet/assignments', async (original) => {
  const actual = await original<typeof import('./fleet/assignments')>();
  return { ...actual, listFleetAssignments: process.env.PAPERCUSP_P010_LIVE_PROBE === '1'
    ? actual.listFleetAssignments : async () => h.privateFleet };
});
vi.mock('./agent-tools/coordination/liveness-oracle', async (original) => {
  const actual = await original<typeof import('./agent-tools/coordination/liveness-oracle')>();
  return { ...actual, resolveSessionStates: async (...args: Parameters<typeof actual.resolveSessionStates>) => {
    if (h.frozenLiveness) {
      return new Map(args[0].map(subject => {
        if (!h.liveness.has(subject.ownerId)) h.missingLiveness.add(subject.ownerId);
        return [subject.ownerId, h.liveness.get(subject.ownerId)] as const;
      }));
    }
    const result = process.env.PAPERCUSP_P010_LIVE_PROBE === '1' ? await actual.resolveSessionStates(...args)
      : new Map(args[0].map(subject => [subject.ownerId,
        { ownerId: subject.ownerId, sessionState: h.privateSessionState }] as const));
    for (const [owner, verdict] of result) h.liveness.set(owner, verdict);
    return result;
  } };
});

const { getAllPlanItemCoverage } = await import('./plan-item-coverage');
type Phase = { sql: string; parameters?: unknown[]; wallMs: number; rows: number; ok: boolean; error?: string };
let phases: Phase[] = [];
let root: postgres.Sql | undefined;
let privateDb: { uri: string; name: string } | undefined;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fingerprintSources = () => Object.fromEntries(['plan-item-coverage.ts','fleet/assignments.ts']
  .map(path => [path, createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex')]));
function verifyServingSources(sha: unknown, fingerprints: Record<string, string>,
  readBlob = (revision: string, path: string) => execFileSync('git',
    ['show', `${revision}:packages/operator-core/lib/${path}`])) {
  if (typeof sha !== 'string' || !/^[a-f0-9]{7,64}$/.test(sha)) throw new Error('Invalid serving build SHA');
  const sourceHashes: Record<string, string> = {};
  for (const [path, expected] of Object.entries(fingerprints)) {
    sourceHashes[path] = createHash('sha256').update(readBlob(sha, path)).digest('hex');
    if (sourceHashes[path] !== expected) throw new Error(`Serving measured source changed: ${path}`);
  }
  return { sha, sourceHashes };
}
const confidenceMethod = { metric: 'per-window p95 reader wallMs, candidate minus control',
  method: 'percentile bootstrap of the mean paired difference', confidence: 0.95,
  seed: 0x10004889, resamples: 10_000, minimumCompletePairs: 10 };
function comparison(samples: any[], concurrency: number) {
  const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
  const differences: number[] = [];
  for (const window of [...new Set(samples.filter(s => s.concurrency === concurrency).map(s => s.window))]) {
    const outcomes = (arm: string) => samples.filter(s => s.concurrency === concurrency && s.window === window && s.arm === arm)
      .flatMap(s => s.batch);
    const control = outcomes('control'), candidate = outcomes('candidate');
    if (control.length && control.length === candidate.length && [...control, ...candidate].every(s => s.ok))
      differences.push(p95(candidate.map(s => s.wallMs)) - p95(control.map(s => s.wallMs)));
  }
  if (differences.length < confidenceMethod.minimumCompletePairs) return { differences, interval: null };
  let state = confidenceMethod.seed;
  const random = () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const means = Array.from({ length: confidenceMethod.resamples }, () =>
    differences.reduce(sum => sum + differences[Math.floor(random() * differences.length)], 0) / differences.length)
    .sort((a, b) => a - b);
  return { differences, interval: [means[250], means[9749]],
    meanDifference: differences.reduce((a, b) => a + b, 0) / differences.length };
}

// Preserve postgres-js Builder/Query identity so parameterised nested fragments
// still compose normally. Observe the actual lazy execution boundary, not when
// a SQL fragment is constructed. The query's own result supplies its population.
function observed(sql: postgres.Sql): postgres.Sql {
  const observe = (query: any) => {
    if (!query || typeof query.then !== 'function') return query;
    const originalThen = query.then.bind(query);
    let recorded = false;
    query.then = (resolve: any, reject: any) => {
      const started = performance.now();
      return originalThen((result: any) => {
        if (!recorded) {
          recorded = true;
          phases.push({ sql: result.statement?.string ?? query.statement?.string ?? query.strings?.join('?') ?? 'unknown',
            parameters: query.parameters,
            wallMs: performance.now() - started, rows: result.length, ok: true });
        }
        return resolve?.(result);
      }, (error: Error) => {
        if (!recorded) {
          recorded = true;
          phases.push({ sql: query.strings?.join('?') ?? 'unknown', wallMs: performance.now() - started,
            rows: 0, ok: false, error: error.message });
        }
        return reject?.(error);
      });
    };
    return query;
  };
  return new Proxy(sql, {
    apply: (target, self, args) => observe(Reflect.apply(target, self, args)),
    get: (target, property) => property === 'unsafe'
      ? (...args: any[]) => observe(Reflect.apply(target.unsafe, target, args))
      : Reflect.get(target, property),
  }) as postgres.Sql;
}

function normalized(map: Awaited<ReturnType<typeof getAllPlanItemCoverage>>, plan: string) {
  return [...map].filter(([ref]) => ref.startsWith(plan + '#'))
    .map(([ref, value]) => [ref, { ...value,
      links: [...value.links].sort((a, b) => a.workItemId.localeCompare(b.workItemId) || a.rel.localeCompare(b.rel)),
      workers: [...value.workers].sort(),
    }]).sort(([a], [b]) => String(a).localeCompare(String(b)));
}

// Keep enough evidence to distinguish field disagreement from a moving live
// input. Values such as human intent remain private; only paths/types/hashes
// enter the report, with an explicit bound and total mismatch count.
function changedFields(expected: unknown, actual: unknown) {
  const fields: { path: string; expectedType: string; actualType: string; expectedHash: string; actualHash: string }[] = [];
  let count = 0;
  const hash = (value: unknown) => digest({ type: typeof value, value });
  const walk = (a: any, b: any, path: string) => {
    if (hash(a) === hash(b)) return;
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], path + '.' + key);
      return;
    }
    count++;
    if (fields.length < 32) fields.push({ path, expectedType: typeof a, actualType: typeof b,
      expectedHash: hash(a), actualHash: hash(b) });
  };
  walk(expected, actual, 'selectedCoverage');
  return { count, fields, truncated: count > fields.length };
}

afterAll(async () => {
  await root?.end({ timeout: 5 });
  if (privateDb) {
    const admin = postgres(privateDb.uri, { max: 1, onnotice: () => {} });
    try { await admin.unsafe(`DROP DATABASE "${privateDb.name}" WITH (FORCE)`); }
    finally { await admin.end({ timeout: 5 }); }
  }
});

describe('matched plan coverage phase benchmark', () => {
  it('refuses an undersized full-matrix deadline before database work', () => {
    for (const budget of [undefined, '600000', '7199999', 'invalid']) {
      expect(() => validateFullMatrixBudget(true, 10, 100,
        { PAPERCUSP_TEST_FILE_TIMEOUT_MS: budget })).toThrow('PAPERCUSP_TEST_FILE_TIMEOUT_MS=7200000');
    }
    expect(() => validateFullMatrixBudget(true, 10, 100,
      { PAPERCUSP_TEST_FILE_TIMEOUT_MS: '7200000' })).not.toThrow();
    expect(() => validateFullMatrixBudget(true, 1, 2, {})).not.toThrow();
    expect(() => validateFullMatrixBudget(false, 10, 100, {})).not.toThrow();
  });
  it('accepts a different serving commit only when the measured source bytes match', () => {
    const files = { 'plan-item-coverage.ts': Buffer.from('reader'), 'fleet/assignments.ts': Buffer.from('assignments') };
    const fingerprints = Object.fromEntries(Object.entries(files)
      .map(([path, bytes]) => [path, createHash('sha256').update(bytes).digest('hex')]));
    const readBlob = vi.fn((_sha: string, path: string) => files[path as keyof typeof files]);
    const before = verifyServingSources('a'.repeat(40), fingerprints, readBlob);
    const after = verifyServingSources('b'.repeat(40), fingerprints, readBlob);
    expect(after.sha).not.toBe(before.sha);
    expect(after.sourceHashes).toEqual(before.sourceHashes);
    expect(readBlob.mock.calls.map(([sha]) => sha)).toEqual([before.sha, before.sha, after.sha, after.sha]);
    // Even an unchanged health SHA cannot excuse changed measured bytes.
    expect(() => verifyServingSources(before.sha, fingerprints, () => Buffer.from('changed')))
      .toThrow('Serving measured source changed: plan-item-coverage.ts');
  });
  it('refuses unresolvable or invalid serving builds instead of accepting unknown provenance', () => {
    expect(() => verifyServingSources('a'.repeat(40), { 'plan-item-coverage.ts': 'expected' }, () => {
      throw new Error('missing git blob');
    })).toThrow('missing git blob');
    const readBlob = vi.fn();
    for (const sha of [undefined, '', 'HEAD', 'a'.repeat(40) + ':other']) {
      expect(() => verifyServingSources(sha, {}, readBlob)).toThrow('Invalid serving build SHA');
    }
    expect(readBlob).not.toHaveBeenCalled();
  });
  it('reports changed fields without exposing their values', () => {
    const result = changedFields({ holder: { stale: false, goalText: 'private expected' } },
      { holder: { stale: true, goalText: 'private actual' } });
    expect(result.count).toBe(2);
    expect(result.fields.map(field => field.path)).toEqual(['selectedCoverage.holder.stale', 'selectedCoverage.holder.goalText']);
    expect(JSON.stringify(result)).not.toContain('private');
    expect(result.truncated).toBe(false);
    const many = changedFields(Array(40).fill(false), Array(40).fill(true));
    expect(many.count).toBe(40);
    expect(many.fields).toHaveLength(32);
    expect(many.truncated).toBe(true);
  });
  it('preserves exact scoped coverage and records the reduced hydrated population', async () => {
    const diagnostic = process.env.PAPERCUSP_P010_DIAGNOSTIC === '1';
    expect(!diagnostic || live).toBe(true);
    const plan = process.env.PAPERCUSP_P010_PLAN ?? 'p010-benchmark';
    // Validate the launch before opening a connection or starting measured work.
    // A bounded preflight retains its actual bounds and uses the normal runner budget.
    const windows = live ? Number(process.env.PAPERCUSP_P010_WINDOWS ?? 10) : 2;
    const requests = live ? Number(process.env.PAPERCUSP_P010_REQUESTS ?? 100) : 4;
    expect(Number.isInteger(windows) && windows >= 1 && windows <= 10).toBe(true);
    expect(Number.isInteger(requests) && requests >= 1 && requests <= 100).toBe(true);
    if (!diagnostic) validateFullMatrixBudget(live, windows, requests, process.env);
    if (live) {
      root = postgres(getHarnessAdminUrl(), { max: 1, onnotice: () => {} });
    } else {
      const uri = await getTestPg();
      const name = `plic_perf_${randomBytes(5).toString('hex')}`;
      const admin = postgres(uri, { max: 1, onnotice: () => {} });
      try {
        await admin.unsafe(`CREATE DATABASE "${name}"`);
        await markManagedTestDatabase(admin, name);
        privateDb = { uri, name };
      } finally { await admin.end(); }
      const url = new URL(uri); url.pathname = '/' + name;
      root = postgres(url.toString(), { max: 1, onnotice: () => {} });
      await root`CREATE SCHEMA harness_shared`;
      await root.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
      await root`CREATE TABLE harness_shared.coord_links (
        dst_ref text, rel text, src_kind text, src_ref text, dst_kind text)`;
      await root.unsafe(`CREATE INDEX work_items_plan_item_stamp_idx ON harness_shared.work_items
        ((payload->'plan_item'->>'plan_slug'), (payload->'plan_item'->>'item_id'))
        WHERE payload->'plan_item' IS NOT NULL`);
      await root`INSERT INTO harness_shared.work_items
        (workspace_id,harness_slug,feature_id,item_kind,status,payload,updated_ts)
        SELECT 'papercusp-workspace','web','WI-bench-' || n,'bug',
          CASE WHEN n % 3 = 0 THEN 'done' ELSE 'open' END,
          jsonb_build_object('plan_item',jsonb_build_object('plan_slug',
            CASE WHEN n <= 8 THEN ${plan} ELSE 'unrelated-benchmark' END,'item_id','P-' || n),
            '_claimHold', n % 5 = 0),100 FROM generate_series(1,128) n`;
    }
    const samples: any[] = [];
    const fingerprints = fingerprintSources();
    let fingerprintsAfter: Record<string, string> | undefined;
    const startedAt = new Date().toISOString();
    const sourceSha = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
    const testFingerprint = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
    let identity: any;
    let serving: any;
    let preflightError: string | undefined;
    let frozenClock: { mockRestore(): void; mockReturnValue(value: number): unknown } | undefined;
    let expected: ReturnType<typeof normalized> = [];
    const explain: Record<string, unknown> = {};
    const diagnostics: any[] = [];
    const progress = { expectedReads: 4 * windows * requests, completedReads: 0, completedArms: 0 };
    const report = () => ({ schemaVersion: 2, workItem: 'WI-10004889', startedAt, endedAt: new Date().toISOString(),
      mode: diagnostic ? 'live-read-only-diagnostic' : live ? 'live-read-only' : 'private-PG',
      host: hostname(), plan, identity, serving, fingerprints, fingerprintsAfter, diagnostics,
      incomplete: true, ...(preflightError ? { error: preflightError } : {}), progress: { ...progress },
      sourceSha, testFingerprint, confidenceMethod,
      control: 'full production coverage then exact plan selection', candidate: 'production planSlug restriction',
      profiles: { concurrency: [1,8], windows, requestsPerSideWindow: requests,
        cache: 'no coverage result cache; PostgreSQL cache uncontrolled and shared',
        connection: 'one read-only repeatable-read connection on both sides',
        inputs: diagnostic ? 'diagnostic interventions recorded individually'
          : 'JS clock pinned to transaction time; initial measured liveness replayed for both arms' },
      populationHash: digest(expected), samples, explain,
      comparisons: [1,8].map(concurrency => ({ concurrency, ...comparison(samples, concurrency) })),
      limitations: ['SQL wall includes queue/transfer/decoding; not database CPU or isolated JSON extraction.',
        'Shared PostgreSQL cache is not a cold-cache benchmark.',
        'This is the production reader on frozen data, not HTTP end-to-end timing.',
        'Replay fixes exogenous liveness inputs; matrix timings exclude repeated oracle IO.',
        'Serving source containment is checked at both endpoints; this does not freeze the HTTP runtime.'],
    });
    const persist = (complete = false) => {
      if (process.env.PAPERCUSP_P010_REPORT) writeFileSync(process.env.PAPERCUSP_P010_REPORT,
        JSON.stringify({ ...report(), incomplete: !complete }) + '\n');
    };
    try {
    if (live) {
      const response = await fetch('http://127.0.0.1:3170/api/health', { signal: AbortSignal.timeout(5000) });
      expect(response.ok).toBe(true);
      const health = await response.json();
      // Retain only build provenance, never the entire health payload.
      serving = { sha: health.sha, endpoint: 'http://127.0.0.1:3170/api/health' };
      serving.before = verifyServingSources(health.sha, fingerprints);
    }
    await root!.begin('isolation level repeatable read read only', async (tx) => {
      await tx`SET LOCAL statement_timeout = '30s'`;
      identity = (await tx`SELECT current_database() AS database, version() AS postgres,
        txid_current_snapshot()::text AS snapshot, now() AS transaction_time`)[0];
      if (live) {
        expect(identity.database).toBe('papercusp');
        identity.schema = await tx`SELECT filename, sha256, applied_at
          FROM harness_shared.schema_migrations ORDER BY applied_at DESC LIMIT 5`;
      }
      h.sql = observed(tx as unknown as postgres.Sql);
      h.liveness.clear();
      h.missingLiveness.clear();
      if (!live) h.privateFleet = [{ source: 'plan_item_claim', agentId: 'su-benchmark', planSlug: plan,
        itemId: 'P-1', holderAlive: true, orphaned: false, stalled: false, claimActive: true,
        lastProgressAt: identity.transaction_time, claimAcquiredTs: identity.transaction_time,
        lastActivityTs: identity.transaction_time, detail: 'benchmark fixture' }];
      if (!diagnostic) frozenClock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(identity.transaction_time));
      expected = normalized(await getAllPlanItemCoverage(), plan);
      expect(expected.length).toBeGreaterThan(0);
      if (!live) {
        // Real PG rows stay unchanged while these exogenous inputs move.
        // The normal suite must detect this trap and prove replay prevents it.
        const initial = new Map(h.liveness);
        frozenClock!.mockReturnValue(Date.parse(identity.transaction_time) + 31 * 60_000);
        h.privateSessionState = 'ended';
        const moved = normalized(await getAllPlanItemCoverage({ planSlug: plan }), plan);
        expect(digest(moved)).not.toBe(digest(expected));
        const movedItem = moved.find(([ref]) => ref === plan + '#P-1')?.[1] as any;
        expect(movedItem.holder.stale).toBe(true);
        expect(movedItem.directlyClaimed).toBe(false);
        h.liveness = initial;
        frozenClock!.mockReturnValue(Date.parse(identity.transaction_time));
      }
      if (!diagnostic) {
        h.frozenLiveness = true;
        expect(normalized(await getAllPlanItemCoverage({ planSlug: plan }), plan)).toEqual(expected);
        expect([...h.missingLiveness]).toEqual([]);
      }
      persist();
      if (diagnostic) {
        // Deliberately move ONLY the JS clock, then freeze clock + the oracle's
        // measured verdicts. This is causal diagnosis, never matrix acceptance.
        const initialLiveness = new Map(h.liveness);
        const fixedNow = Date.parse(identity.transaction_time);
        const clock = vi.spyOn(Date, 'now');
        const record = async (scenario: string, reference: typeof expected, arm: string) => {
          const result = normalized(await getAllPlanItemCoverage(arm === 'candidate' ? { planSlug: plan } : {}), plan);
          diagnostics.push({ scenario, arm, equal: digest(result) === digest(reference),
            changedFields: changedFields(reference, result), resultHash: digest(result),
            livenessHash: digest([...h.liveness].map(([owner, verdict]) => [owner, verdict.sessionState]).sort()) });
          persist();
          return result;
        };
        try {
          clock.mockReturnValue(fixedNow + 15 * 60_000);
          await record('clock-advanced-15-minutes', expected, 'control');
          await record('clock-advanced-15-minutes', expected, 'candidate');
          h.liveness = initialLiveness;
          h.frozenLiveness = true;
          clock.mockReturnValue(fixedNow);
          const frozen = await record('frozen-clock-and-measured-liveness', expected, 'control');
          for (const arm of ['control', 'candidate', 'control', 'candidate']) {
            const result = await record('frozen-clock-and-measured-liveness', frozen, arm);
            expect(result).toEqual(frozen);
            expect([...h.missingLiveness]).toEqual([]);
          }
        } finally {
          h.frozenLiveness = false;
          clock.mockRestore();
        }
        return;
      }
      for (const concurrency of [1, 8]) {
        for (let window = 0; window < windows; window++) {
          const arms = window % 2 === 0 ? ['control','candidate'] : ['candidate','control'];
          for (const arm of arms) {
            for (let offset = 0; offset < requests; offset += concurrency) {
              const batchSize = Math.min(concurrency, requests - offset);
              const phaseStart = phases.length;
              const batch = await Promise.all(Array.from({ length: batchSize }, async (_, index) => {
                const t0 = performance.now();
                try {
                  const coverage = await getAllPlanItemCoverage(arm === 'candidate' ? { planSlug: plan } : {});
                  const result = normalized(coverage, plan);
                  if (h.missingLiveness.size) throw new Error('unmeasured owner in frozen liveness population');
                  const equal = digest(result) === digest(expected);
                  return { index: offset + index, ok: equal, wallMs: performance.now() - t0,
                    resultHash: digest(result), totalCoverageRefs: coverage.size, selectedRefs: result.length,
                    ...(equal ? {} : { error: 'exact coverage differs from frozen control',
                      changedFields: changedFields(expected, result) }) };
                } catch (error) {
                  return { index: offset + index, ok: false, wallMs: performance.now() - t0,
                    error: error instanceof Error ? error.message : String(error) };
                }
              }));
              samples.push({ concurrency, window, arm, batch, phases: phases.slice(phaseStart).map(p => ({
                ...p, sql: undefined, parameters: undefined, sqlHash: digest(p.sql),
                kind: /work_item_id[\s\S]*FROM harness_shared\.work_items/.test(p.sql) ? 'stamp' : 'other',
              })) });
              progress.completedReads += batch.length;
            }
            progress.completedArms++;
            // Explain the actual generated stamp statement, never a separately
            // reconstructed query. Parameters remain in memory, outside reports.
            if (!explain[arm]) {
              const stamp = phases.find(p => /work_item_id[\s\S]*FROM harness_shared\.work_items/.test(p.sql)
                && (arm === 'candidate' ? (p.parameters?.length ?? 0) > 0 : (p.parameters?.length ?? 0) === 0));
              expect(stamp).toBeDefined();
              const result = await tx.unsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + stamp!.sql,
                stamp!.parameters as any[]);
              explain[arm] = { sqlHash: digest(stamp!.sql), plan: result[0]['QUERY PLAN'] };
            }
            persist();
            console.log(JSON.stringify({ kind: 'P010_PROGRESS', concurrency, window, arm, ...progress }));
            expect(samples.flatMap(s => s.batch).filter(s => !s.ok)).toEqual([]);
          }
        }
      }
      expect(normalized(await getAllPlanItemCoverage(), plan)).toEqual(expected);
    });
    if (live) {
      const response = await fetch(serving.endpoint, { signal: AbortSignal.timeout(5000) });
      expect(response.ok).toBe(true);
      const after = await response.json();
      serving.after = { sha: after.sha };
      // This probe executes the local reader, not HTTP requests on the serving
      // worker. Unrelated staging commits do not change its measured algorithm.
      serving.after = verifyServingSources(after.sha, fingerprints);
    }
    fingerprintsAfter = fingerprintSources();
    expect(fingerprintsAfter).toEqual(fingerprints);
    } catch (error) {
      // Incomplete/failed measurements remain visible in the report. Never
      // replace a failed window or manufacture a completed comparison.
      preflightError = error instanceof Error ? error.message : String(error);
    } finally {
      h.frozenLiveness = false;
      frozenClock?.mockRestore();
    }
    persist();
    expect(preflightError).toBeUndefined();
    if (diagnostic) {
      expect(diagnostics).toHaveLength(7);
      persist(true);
      console.log(JSON.stringify({ mode: report().mode, diagnostics: diagnostics.map(d => ({
        scenario: d.scenario, arm: d.arm, equal: d.equal, changedFieldCount: d.changedFields.count,
        changedPaths: d.changedFields.fields.map((field: { path: string }) => field.path),
        resultHash: d.resultHash, livenessHash: d.livenessHash,
      })) }));
      return;
    }
    const outcomes = samples.flatMap(s => s.batch);
    expect(outcomes.filter(s => !s.ok)).toEqual([]);
    const stampRows = (arm: string) => samples.filter(s => s.arm === arm)
      .flatMap(s => s.phases).filter(p => p.kind === 'stamp').reduce((sum, p) => sum + p.rows, 0);
    expect(stampRows('candidate')).toBeGreaterThan(0);
    expect(stampRows('candidate')).toBeLessThan(stampRows('control'));
    expect(progress.completedReads).toBe(progress.expectedReads);
    expect(Object.keys(explain).sort()).toEqual(['candidate','control']);
    persist(true);
    console.log(JSON.stringify({ mode: report().mode, samples: outcomes.length, failures: outcomes.filter(s => !s.ok).length,
      selectedRefs: expected!.length, stampRows: { control: stampRows('control'), candidate: stampRows('candidate') } }));
  }, live ? LIVE_BENCHMARK_TIMEOUT_MS : 120_000);
});
