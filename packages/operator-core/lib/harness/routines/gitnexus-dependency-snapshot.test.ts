/**
 * gitnexus-dependency-snapshot.test.ts — gitnexus-deterministic-integration P-001 (WI-10006138).
 *
 * The test-selection dependency snapshot was produced once by hand and never again, so it aged
 * past the selector's 24h ceiling and every `test:affected` run since silently applied no graph
 * suggestion. The hourly `system:gitnexus-reindex` routine now owns it. These cases pin the pure
 * judgement, the producer invocation, the once-per-streak alert, and the WIRING (a refresh on the
 * analyze path AND on the idle path) — the last being exactly what was missing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEPENDENCY_SNAPSHOT_MAX_AGE_MS,
  DEPENDENCY_SNAPSHOT_PRODUCER_TIMEOUT_MS,
  DEPENDENCY_SNAPSHOT_REFRESH_AGE_MS,
  DEPENDENCY_SNAPSHOT_SCHEMA,
  decideDependencySnapshotHealth,
  dependencySnapshotBackend,
  dependencySnapshotNeedsRefresh,
  dependencySnapshotPath,
  dependencySnapshotProducerArgv,
  dependencySnapshotUsable,
  judgeDependencySnapshot,
  logDependencySnapshotCheck,
  parseProducerLine,
  refreshDependencySnapshot,
  runDependencySnapshotProducer,
  type DependencySnapshotProducerRun,
} from './gitnexus-reindex-action';
import {
  DEFAULT_MAX_AGE_MS,
  GRAPH_SNAPSHOT_SCHEMA,
  sharedSnapshotPath,
} from '../../../../../scripts/lib/graph-dependency-suggestions.mjs';

const NOW = Date.parse('2026-10-06T03:00:00.000Z');
const COMMIT = '98199607515f4d797784b5adb185a84590435c57';
const NEWER = 'aaaaaaaaaabbbbbbbbbbccccccccccdddddddddd';
const HOUR = 3_600_000;

const snapshotText = (o: { generatedAt?: string; lastCommit?: string; edges?: number; schema?: string } = {}) =>
  JSON.stringify({
    schema: o.schema ?? DEPENDENCY_SNAPSHOT_SCHEMA,
    index: { lastCommit: o.lastCommit ?? COMMIT, indexedAt: '2026-10-06T00:37:35.367Z', backend: 'gitnexus', backendVersion: '1.6.9' },
    // A fresh snapshot is younger than the refresh age, which is now under one hourly tick (P-040).
    generatedAt: o.generatedAt ?? new Date(NOW - HOUR / 4).toISOString(),
    edges: Array.from({ length: o.edges ?? 2 }, (_, i) => ({ importer: `a/${i}.ts`, imported: 'a/s.ts', importerSha256: 'x' })),
  });

describe('writer and reader agree (the routine writes what the selector reads)', () => {
  it('same path, schema and age ceiling as scripts/lib/graph-dependency-suggestions.mjs', () => {
    expect(dependencySnapshotPath('papercusp', '/fixture-home')).toBe(sharedSnapshotPath('papercusp', '/fixture-home'));
    expect(DEPENDENCY_SNAPSHOT_SCHEMA).toBe(GRAPH_SNAPSHOT_SCHEMA);
    expect(DEPENDENCY_SNAPSHOT_MAX_AGE_MS).toBe(DEFAULT_MAX_AGE_MS);
    expect(DEPENDENCY_SNAPSHOT_REFRESH_AGE_MS).toBeLessThan(DEPENDENCY_SNAPSHOT_MAX_AGE_MS - HOUR);
  });
});

describe('judgeDependencySnapshot', () => {
  it('absent / unparseable / wrong schema / no index / zero edges are each named', () => {
    expect(judgeDependencySnapshot(null, NOW)).toMatchObject({ status: 'absent', edges: null });
    expect(judgeDependencySnapshot('{nope', NOW)).toMatchObject({ status: 'invalid', reason: expect.stringMatching(/^unparseable/) });
    expect(judgeDependencySnapshot(snapshotText({ schema: 'v0' }), NOW)).toMatchObject({ status: 'invalid', reason: 'schema is "v0"' });
    expect(judgeDependencySnapshot(snapshotText({ lastCommit: '' }), NOW)).toMatchObject({ status: 'invalid', reason: 'no index.lastCommit' });
    expect(judgeDependencySnapshot(snapshotText({ edges: 0 }), NOW)).toMatchObject({ status: 'invalid', reason: 'zero edges', edges: 0 });
  });

  it('fresh when young and bound to the current index; reports age, edges and commit', () => {
    expect(judgeDependencySnapshot(snapshotText({ edges: 5 }), NOW, { currentIndexCommit: COMMIT })).toEqual({
      status: 'fresh',
      reason: null,
      generatedAt: new Date(NOW - HOUR / 4).toISOString(),
      ageMs: HOUR / 4,
      indexCommit: COMMIT,
      edges: 5,
    });
  });

  it('stale past the 24h selector ceiling — the state the snapshot sat in for days', () => {
    const j = judgeDependencySnapshot(snapshotText({ generatedAt: new Date(NOW - 25 * HOUR).toISOString() }), NOW, { currentIndexCommit: COMMIT });
    expect(j.status).toBe('stale');
    expect(dependencySnapshotUsable(j.status)).toBe(false);
  });

  it('behind-index when the graph was rebuilt at a newer commit — still usable, but due a refresh', () => {
    const j = judgeDependencySnapshot(snapshotText(), NOW, { currentIndexCommit: NEWER });
    expect(j).toMatchObject({ status: 'behind-index', reason: 'bound to 9819960751, index is at aaaaaaaaaa' });
    expect(dependencySnapshotUsable(j.status)).toBe(true);
    expect(dependencySnapshotNeedsRefresh(j)).toBe(true);
  });

  it('a fresh snapshot is refreshed BEFORE the ceiling, so an unchanged index never ages it out between hourly ticks', () => {
    const young = judgeDependencySnapshot(snapshotText(), NOW, { currentIndexCommit: COMMIT });
    const aging = judgeDependencySnapshot(snapshotText({ generatedAt: new Date(NOW - 21 * HOUR).toISOString() }), NOW, { currentIndexCommit: COMMIT });
    expect(young.status).toBe('fresh');
    expect(aging.status).toBe('fresh');
    expect(dependencySnapshotNeedsRefresh(young)).toBe(false);
    expect(dependencySnapshotNeedsRefresh(aging)).toBe(true);
  });

  it('every hourly tick regenerates the snapshot that native queries and pushes corroborate against (P-040)', () => {
    // The routine fires hourly; the previous tick's file is just under an hour old when the next one runs.
    const lastTick = judgeDependencySnapshot(snapshotText({ generatedAt: new Date(NOW - HOUR + 2 * 60_000).toISOString() }), NOW, { currentIndexCommit: COMMIT });
    expect(lastTick.status).toBe('fresh');
    expect(dependencySnapshotNeedsRefresh(lastTick)).toBe(true);
    expect(DEPENDENCY_SNAPSHOT_REFRESH_AGE_MS).toBeLessThan(HOUR - 5 * 60_000);
    expect(DEPENDENCY_SNAPSHOT_REFRESH_AGE_MS).toBeGreaterThan(DEPENDENCY_SNAPSHOT_PRODUCER_TIMEOUT_MS);
  });
});

describe('the producer invocation', () => {
  it('parseProducerLine takes the LAST status line and ignores progress lines', () => {
    const stderr = [
      'GRAPH_SNAPSHOT_PROGRESS pages=1 rows=5000/59067 pageSize=5000',
      'GRAPH_SNAPSHOT status=written edges=51644 input=59067 index=9819960751 out=/x',
      '',
    ].join('\n');
    expect(parseProducerLine(stderr)).toEqual({ status: 'written', line: 'GRAPH_SNAPSHOT status=written edges=51644 input=59067 index=9819960751 out=/x' });
    expect(parseProducerLine('GRAPH_SNAPSHOT_PROGRESS pages=1\n')).toBeNull();
  });

  it('argv runs the indexed tree\'s own script in DIRECT mode with the repo, source root and an explicit --out', () => {
    expect(dependencySnapshotProducerArgv('/repo', 'papercusp', '/bin/gitnexus', '/out.json', 'gitnexus')).toEqual([
      join('/repo', 'scripts', 'gen-graph-dependency-snapshot.mjs'),
      '--gitnexus-bin',
      '/bin/gitnexus',
      '--repo',
      'papercusp',
      '--source-root',
      '/repo',
      '--out',
      '/out.json',
    ]);
  });

  it('no gitnexus binary: not attempted, nothing spawned', async () => {
    let spawned = false;
    const r = await runDependencySnapshotProducer('/repo', 'papercusp', '/out.json', {
      backend: 'gitnexus',
      bin: '/missing/gitnexus',
      exists: () => false,
      exec: async () => {
        spawned = true;
        return { stdout: '', stderr: '' };
      },
      now: () => NOW,
    });
    expect(spawned).toBe(false);
    expect(r).toEqual({ exit: null, line: 'GRAPH_SNAPSHOT status=not-attempted reason=no gitnexus binary at /missing/gitnexus', at: NOW });
  });

  it('success: the node binary runs the argv in the indexed tree, bounded, through the sidecar seam', async () => {
    const seen: unknown[] = [];
    const r = await runDependencySnapshotProducer('/repo', 'papercusp', '/out.json', {
      bin: '/bin/gitnexus',
      nodeBin: '/bin/node',
      exists: () => true,
      exec: async (cmd, args, opts) => {
        seen.push({ cmd, args, opts });
        return { stdout: '', stderr: 'GRAPH_SNAPSHOT status=written edges=3 out=/out.json\n' };
      },
      now: () => NOW,
    });
    expect(r).toEqual({ exit: 0, line: 'GRAPH_SNAPSHOT status=written edges=3 out=/out.json', at: NOW });
    expect(seen).toEqual([
      {
        cmd: '/bin/node',
        args: dependencySnapshotProducerArgv('/repo', 'papercusp', '/bin/gitnexus', '/out.json'),
        opts: { cwd: '/repo', timeoutMs: DEPENDENCY_SNAPSHOT_PRODUCER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, subsystem: 'gitnexus-dependency-snapshot' },
      },
    ]);
  });

  it('uses the first-party producer without an installed graph binary, with explicit shared output', async () => {
    const seen: unknown[] = [];
    const r = await runDependencySnapshotProducer('/repo', 'papercusp', '/shared/snapshot.json', {
      bin: '/missing/gitnexus', exists: () => false, now: () => NOW,
      exec: async (_cmd, args) => { seen.push(args); return { stdout: '', stderr: 'GRAPH_SNAPSHOT status=written edges=1' }; },
    });
    expect(r.exit).toBe(0);
    expect(seen).toEqual([[join('/repo', 'scripts', 'gen-graph-dependency-snapshot.mjs'), '--first-party', '--repo', 'papercusp', '--source-root', '/repo', '--out', '/shared/snapshot.json']]);
    expect(dependencySnapshotBackend(undefined)).toBe('first-party-imports');
    expect(dependencySnapshotBackend('gitnexus')).toBe('gitnexus');
    expect(() => dependencySnapshotBackend('typo')).toThrow('Unsupported snapshot_backend');
  });

  it('a refusing producer resolves with its exit code and its own status line — never throws into the tick', async () => {
    const refusing = await runDependencySnapshotProducer('/repo', 'papercusp', '/out.json', {
      bin: '/bin/gitnexus',
      exists: () => true,
      exec: async () => {
        throw Object.assign(new Error('Command failed'), { code: 3, stderr: 'GRAPH_SNAPSHOT status=not-written reason=index-moved out=/out.json\n' });
      },
      now: () => NOW,
    });
    expect(refusing).toEqual({ exit: 3, line: 'GRAPH_SNAPSHOT status=not-written reason=index-moved out=/out.json', at: NOW });

    const unspawnable = await runDependencySnapshotProducer('/repo', 'papercusp', '/out.json', {
      bin: '/bin/gitnexus',
      exists: () => true,
      exec: async () => {
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      },
      now: () => NOW,
    });
    expect(unspawnable).toEqual({ exit: null, line: 'GRAPH_SNAPSHOT status=spawn-failed detail="spawn ENOENT"', at: NOW });
  });
});

describe('decideDependencySnapshotHealth — alert once per unusable streak', () => {
  const absent = judgeDependencySnapshot(null, NOW);
  const fresh = judgeDependencySnapshot(snapshotText(), NOW, { currentIndexCommit: COMMIT });
  const run: DependencySnapshotProducerRun = { exit: 3, line: 'GRAPH_SNAPSHOT status=not-written reason=empty', at: NOW };

  it('first unusable tick alerts, the next one does not, a usable tick resolves', () => {
    const first = decideDependencySnapshotHealth(null, absent, run, NOW, '/out.json');
    expect(first).toMatchObject({ shouldAlert: true, shouldResolve: false, next: { status: 'absent', alerted: true, lastProducerExit: 3 } });
    const second = decideDependencySnapshotHealth(first.next, absent, null, NOW + HOUR, '/out.json');
    expect(second).toMatchObject({ shouldAlert: false, shouldResolve: false, next: { alerted: true } });
    const recovered = decideDependencySnapshotHealth(second.next, fresh, { exit: 0, line: 'ok', at: NOW + 2 * HOUR }, NOW + 2 * HOUR, '/out.json');
    expect(recovered).toMatchObject({ shouldAlert: false, shouldResolve: true, next: { status: 'fresh', alerted: false, lastProducerExit: 0 } });
  });

  it('a tick that did not run the producer keeps the previous producer record', () => {
    const prev = decideDependencySnapshotHealth(null, fresh, { exit: 0, line: 'written', at: NOW - HOUR }, NOW - HOUR, '/out.json').next;
    const next = decideDependencySnapshotHealth(prev, fresh, null, NOW, '/out.json').next;
    expect(next).toMatchObject({ lastProducerAt: NOW - HOUR, lastProducerExit: 0, lastProducerLine: 'written', checkedAt: NOW });
  });
});

describe('refreshDependencySnapshot', () => {
  it('replaces a fresh legacy snapshot, then leaves first-party source identity independent of the graph index', async () => {
    let text = snapshotText();
    let produced = 0;
    const options = { out: '/out.json', now: () => NOW, readText: () => text,
      produce: async (_root: string, _repo: string, _out: string, deps?: { backend?: string }) => {
        expect(deps?.backend).toBe('first-party-imports'); produced++;
        const next = JSON.parse(snapshotText()); next.index.backend = 'first-party-imports'; next.index.lastCommit = NEWER;
        text = JSON.stringify(next); return { exit: 0, line: 'GRAPH_SNAPSHOT status=written', at: NOW };
      } };
    const input = { root: '/repo', repoName: 'papercusp', currentIndexCommit: COMMIT, prev: null };
    expect((await refreshDependencySnapshot(input, options)).next.status).toBe('fresh');
    expect((await refreshDependencySnapshot(input, options)).ran).toBe(false);
    expect(produced).toBe(1);
    expect(judgeDependencySnapshot(text, NOW, { expectedBackend: 'gitnexus' }).status).toBe('behind-index');
  });
  it('a fresh snapshot is left alone — no producer run', async () => {
    let produced = 0;
    const r = await refreshDependencySnapshot(
      { root: '/repo', repoName: 'papercusp', currentIndexCommit: COMMIT, prev: null, backend: 'gitnexus' },
      { out: '/out.json', now: () => NOW, readText: () => snapshotText(), produce: async () => ((produced += 1), { exit: 0, line: null, at: NOW }) },
    );
    expect(produced).toBe(0);
    expect(r).toMatchObject({ ran: false, shouldAlert: false, next: { status: 'fresh', path: '/out.json' } });
  });

  it('an absent snapshot is produced and RE-JUDGED from what the producer actually wrote', async () => {
    let onDisk: string | null = null;
    const r = await refreshDependencySnapshot(
      { root: '/repo', repoName: 'papercusp', currentIndexCommit: COMMIT, prev: null, backend: 'gitnexus' },
      {
        out: '/out.json',
        now: () => NOW,
        readText: () => onDisk,
        produce: async (root, repo, out) => {
          expect([root, repo, out]).toEqual(['/repo', 'papercusp', '/out.json']);
          onDisk = snapshotText({ generatedAt: new Date(NOW).toISOString(), edges: 7 });
          return { exit: 0, line: 'GRAPH_SNAPSHOT status=written edges=7', at: NOW };
        },
      },
    );
    expect(r).toMatchObject({ ran: true, shouldAlert: false, next: { status: 'fresh', edges: 7, lastProducerExit: 0 } });
  });

  it('a producer that writes nothing leaves the status unusable and alerts', async () => {
    const r = await refreshDependencySnapshot(
      { root: '/repo', repoName: 'papercusp', currentIndexCommit: COMMIT, prev: null, backend: 'gitnexus' },
      { out: '/out.json', now: () => NOW, readText: () => null, produce: async () => ({ exit: 3, line: 'GRAPH_SNAPSHOT status=not-written reason=empty', at: NOW }) },
    );
    expect(r).toMatchObject({ ran: true, shouldAlert: true, next: { status: 'absent', lastProducerLine: 'GRAPH_SNAPSHOT status=not-written reason=empty' } });
  });

  it('a refresh that fails keeps a still-usable older snapshot usable (no alert), and records the failure', async () => {
    const r = await refreshDependencySnapshot(
      { root: '/repo', repoName: 'papercusp', currentIndexCommit: NEWER, prev: null, backend: 'gitnexus' },
      { out: '/out.json', now: () => NOW, readText: () => snapshotText(), produce: async () => ({ exit: 3, line: 'GRAPH_SNAPSHOT status=not-written reason=index-moved', at: NOW }) },
    );
    expect(r).toMatchObject({ ran: true, shouldAlert: false, next: { status: 'behind-index', lastProducerExit: 3 } });
  });
});

describe('wiring — the routine refreshes on BOTH the analyze path and the idle path', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'gitnexus-reindex-action.ts'), 'utf8');
  const CALL = 'await trackDependencySnapshot(ctx, root, repoName);';

  it('records a healthy idle freshness check without requiring a producer run', async () => {
    const update = await refreshDependencySnapshot(
      { root: '/repo', repoName: 'papercusp', currentIndexCommit: COMMIT, prev: null, backend: 'gitnexus' },
      { out: '/out.json', now: () => NOW, readText: () => snapshotText(), produce: async () => { throw new Error('healthy snapshot must not regenerate'); } },
    );
    expect(update.ran).toBe(false);
    const lines: string[] = [];
    logDependencySnapshotCheck(update, { log: line => lines.push(line), warn: () => { throw new Error('healthy check must not warn'); } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('dependency snapshot fresh');
    expect(lines[0]).toContain(`checkedAt=${NOW}`);
    expect(lines[0]).not.toContain('after producer:');
    expect(src).toContain('logDependencySnapshotCheck(update);');
  });

  it('refreshes source-only snapshots before optional graph writer admission, while retaining legacy skip and finish paths', () => {
    expect(src.split(CALL).length - 1).toBe(3);
    const handler = src.indexOf("registerSystemAction('gitnexus-reindex'");
    const call = src.indexOf(CALL, handler);
    const writer = src.indexOf('detectLiveAnalyzeWriter(root)', handler);
    expect(call).toBeGreaterThan(handler);
    expect(call).toBeLessThan(writer);
    expect(src.slice(handler, call)).toContain("snapshotBackend === 'first-party-imports'");
  });

  it('one closes finishAnalyzeTick (the one finish path for same-host AND adopted runs), after the health write', () => {
    const fn = src.indexOf('async function finishAnalyzeTick(');
    const healthWrite = src.indexOf('JSON.stringify({ gitnexus_health: nextHealth })', fn);
    const call = src.indexOf(CALL, fn);
    expect(fn).toBeGreaterThan(0);
    expect(healthWrite).toBeGreaterThan(fn);
    expect(call).toBeGreaterThan(healthWrite);
  });

  it('the other sits on the no-analyze skip, before its return — an unchanged index still keeps the file fresh', () => {
    const handler = src.indexOf("registerSystemAction('gitnexus-reindex'");
    const skip = src.indexOf('if (!decision.run) {', handler);
    const call = src.indexOf(CALL, skip);
    const ret = src.indexOf('return;', skip);
    expect(skip).toBeGreaterThan(handler);
    expect(call).toBeGreaterThan(skip);
    expect(call).toBeLessThan(ret);
  });
});
