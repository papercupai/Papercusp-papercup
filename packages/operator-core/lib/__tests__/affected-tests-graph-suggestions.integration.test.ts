/**
 * affected-tests-graph-suggestions.integration.test.ts — P-008 of plan
 * gitnexus-selective-hardening-and-comparison-2026-09-13 (spec GN-TEST-SELECTION-SUPERSET).
 *
 * INTEGRATION layer for the graph-suggestion path. The sibling `.test.ts` pins the pure module and
 * the selector against HAND-WRITTEN fixture snapshots; this file crosses the module boundary the
 * way production does:
 *
 *   graph edges ──buildSnapshot (the real producer library)──▶ snapshot FILE on disk
 *                                  └──▶ the REAL `scripts/affected-tests.mjs` subprocess ──▶ selection
 *
 * so a producer/consumer contract drift (field rename, hash scheme, schema string) fails here even
 * when each side's own unit tests stay green. The one invariant under test is SUPERSET-ONLY: the
 * final workspace selection always contains every baseline workspace, whatever the graph says.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSnapshot } from '../../../../scripts/lib/graph-dependency-suggestions.mjs';
import { produceSnapshotFromSource, writeSnapshotAtomic } from '../../../../scripts/gen-graph-dependency-snapshot.mjs';
import { refreshDependencySnapshot, type RefreshDependencySnapshotDeps } from '../harness/routines/gitnexus-reindex-action';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/** Overridable so `scripts/mutation-probe.sh` can aim the selector-level cases at a COPY. */
const SELECTOR = process.env.PROBE_SCRIPT
  ? resolve(process.env.PROBE_SCRIPT)
  : resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

const IMPORTED = 'apps/operator-docs/src/graph-fixture.ts';
// A REAL workspace dir OUTSIDE the baseline reverse-dependency closure of IMPORTED, so a graph
// suggestion is the ONLY way the importer workspace can be selected.
const IMPORTER_DIR = 'packages/backup/__graph_fixture__';
const IMPORTER = `${IMPORTER_DIR}/importer.ts`;
const IMPORTER_SRC = `import { fixture } from '../../../apps/operator-docs/src/graph-fixture';\nexport const x = fixture;\n`;
const IMPORTER_WS = '@papercusp/backup';
const NOW = Date.parse('2026-10-02T00:00:00.000Z');
const INDEX = { lastCommit: '0ce3904e0d4f04f4d383e39d146d1321e73bd95f', indexedAt: '2026-10-01T22:53:00.475Z', backend: 'gitnexus', backendVersion: '1.6.9' };
const TEN_YEARS_MS = String(10 * 365 * 86400 * 1000);

let tmp: string;
let srcRoot: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'graph-suggestions-int-'));
  srcRoot = join(tmp, 'src');
  mkdirSync(join(srcRoot, IMPORTER_DIR), { recursive: true });
  writeFileSync(join(srcRoot, IMPORTER), IMPORTER_SRC);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** PRODUCE a snapshot file with the real producer library, reading importer source from `srcRoot`. */
function produce(name: string, edges: Array<{ importer: string; imported: string }>) {
  const readSource = (p: string) => (p === IMPORTER ? IMPORTER_SRC : null);
  const { snapshot, stats } = buildSnapshot({ edges, index: INDEX, readSource, now: NOW });
  const file = join(tmp, name);
  writeFileSync(file, JSON.stringify(snapshot));
  return { file, snapshot, stats };
}

function runSelector(env: Record<string, string>) {
  const r = spawnSync(process.execPath, [SELECTOR, '--changed-paths', IMPORTED, '--print-affected'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PAPERCUSP_AFFECTED_GRAPH_SOURCE_ROOT: srcRoot, ...env },
    timeout: 90_000,
  });
  const names = new Set(
    r.stdout
      .split('\n')
      .filter((l) => l.startsWith('AFFECTED_WS\t'))
      .map((l) => l.slice('AFFECTED_WS\t'.length).trim()),
  );
  const line = r.stderr.split('\n').find((l) => l.startsWith('GRAPH_SUGGESTIONS ')) ?? null;
  return { names, line, status: r.status, stderr: r.stderr };
}

const baseline = () => runSelector({ PAPERCUSP_AFFECTED_GRAPH_SUGGESTIONS: '0' });
const withSnapshot = (file: string) =>
  runSelector({ PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: file, PAPERCUSP_AFFECTED_GRAPH_MAX_AGE_MS: TEN_YEARS_MS });
const expectEqualToBaseline = (got: Set<string>, base: Set<string>) => {
  for (const n of base) expect(got.has(n), `baseline workspace ${n} lost`).toBe(true);
  for (const n of got) expect(base.has(n), `unexpected extra workspace ${n}`).toBe(true);
};

/** Real source files and producer, with only the tracked-file census and clock fixed. */
function firstPartyFixture(name: string) {
  const root = join(tmp, name);
  mkdirSync(join(root, IMPORTER_DIR), { recursive: true });
  mkdirSync(dirname(join(root, IMPORTED)), { recursive: true });
  writeFileSync(join(root, IMPORTER), IMPORTER_SRC);
  writeFileSync(join(root, IMPORTED), 'export const fixture = 1;\n');
  return root;
}

function sourceProducer(now: number): NonNullable<RefreshDependencySnapshotDeps['produce']> {
  return async (root, repoName, out, deps) => {
    expect(repoName).toBe('papercusp');
    expect(deps?.backend).toBe('first-party-imports');
    const { snapshot } = produceSnapshotFromSource({
      files: [IMPORTED, IMPORTER], headCommit: INDEX.lastCommit, now,
      readSource: (path: string) => {
        try { return readFileSync(join(root, path), 'utf8'); } catch { return null; }
      },
    });
    writeSnapshotAtomic(out, snapshot);
    return { exit: 0, line: `GRAPH_SNAPSHOT status=written edges=${snapshot.edges.length}`, at: now };
  };
}

describe('native P-009 regular snapshot handover (source producer → refresh → real selector)', () => {
  it('replaces a fresh legacy snapshot with the source-derived reference consumer and preserves baseline selection across an idle refresh', async () => {
    const root = firstPartyFixture('native-positive');
    const out = join(tmp, 'native-positive.json');
    const now = Date.now();
    const legacy = buildSnapshot({
      edges: [{ importer: IMPORTER, imported: IMPORTED }], index: INDEX,
      readSource: (path: string) => readFileSync(join(root, path), 'utf8'), now,
    }).snapshot;
    writeSnapshotAtomic(out, legacy);
    let producerRuns = 0;
    const nativeProducer = sourceProducer(now);
    const deps = { out, now: () => now, produce: async (...args: Parameters<typeof nativeProducer>) => {
      producerRuns++;
      return nativeProducer(...args);
    } };
    const input = { root, repoName: 'papercusp', currentIndexCommit: INDEX.lastCommit, prev: null };
    const refreshed = await refreshDependencySnapshot(input, deps);
    expect(refreshed).toMatchObject({ ran: true, shouldAlert: false, next: { status: 'fresh', edges: 1 } });
    const snapshot = JSON.parse(readFileSync(out, 'utf8'));
    expect(snapshot.index).toMatchObject({ backend: 'first-party-imports', lastCommit: INDEX.lastCommit });
    expect(snapshot.edges).toEqual([expect.objectContaining({ importer: IMPORTER, imported: IMPORTED })]);
    const base = baseline();
    expect(base.status, base.stderr).toBe(0);
    expect(base.names.has(IMPORTER_WS), 'reference consumer must be outside the baseline').toBe(false);
    const got = runSelector({
      PAPERCUSP_AFFECTED_GRAPH_SOURCE_ROOT: root,
      PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: out,
      PAPERCUSP_AFFECTED_GRAPH_SUGGESTIONS: '1',
    });
    expect(got.status, got.stderr).toBe(0);
    for (const name of base.names) expect(got.names.has(name), `baseline workspace ${name} lost`).toBe(true);
    expect(got.names.has(IMPORTER_WS)).toBe(true);
    expect(got.line).toMatch(/status=applied accepted=1 rejected=0 added=.*@papercusp\/backup/);
    const pathLines = got.stderr.split('\n').filter(line => line.startsWith('GRAPH_DEPENDENCY_PATH '));
    expect(pathLines).toHaveLength(1);
    const evidence = JSON.parse(pathLines[0]!.slice('GRAPH_DEPENDENCY_PATH '.length));
    expect(evidence).toMatchObject({ changed: IMPORTED, consumer: IMPORTER, files: [IMPORTED, IMPORTER],
      hops: [{ imported: IMPORTED, importer: IMPORTER, importerSha256: snapshot.edges[0].importerSha256 }] });
    // A newer optional graph index cannot invalidate the source producer's own identity.
    const idle = await refreshDependencySnapshot({ ...input, currentIndexCommit: 'a'.repeat(40), prev: refreshed.next }, deps);
    expect(idle).toMatchObject({ ran: false, next: { status: 'fresh' } });
    expect(producerRuns).toBe(1);
  });

  it('rejects the reference consumer after importer drift without losing a baseline workspace', async () => {
    const root = firstPartyFixture('native-drift');
    const out = join(tmp, 'native-drift.json');
    const now = Date.now();
    const refreshed = await refreshDependencySnapshot(
      { root, repoName: 'papercusp', currentIndexCommit: null, prev: null },
      { out, now: () => now, produce: sourceProducer(now) },
    );
    expect(refreshed.next.status).toBe('fresh');
    writeFileSync(join(root, IMPORTER), 'export const x = 0;\n');
    const got = runSelector({
      PAPERCUSP_AFFECTED_GRAPH_SOURCE_ROOT: root,
      PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: out,
      PAPERCUSP_AFFECTED_GRAPH_SUGGESTIONS: '1',
    });
    expect(got.status, got.stderr).toBe(0);
    expectEqualToBaseline(got.names, baseline().names);
    expect(got.names.has(IMPORTER_WS)).toBe(false);
    expect(got.line).toMatch(/status=applied accepted=0 rejected=1 added=none/);
  });

  it('keeps the previous regular snapshot when source production refuses an empty corroborated set', async () => {
    const root = firstPartyFixture('native-refusal');
    const out = join(tmp, 'native-refusal.json');
    const now = Date.now();
    const nativeProducer = sourceProducer(now);
    const first = await refreshDependencySnapshot(
      { root, repoName: 'papercusp', currentIndexCommit: null, prev: null },
      { out, now: () => now, produce: nativeProducer },
    );
    const previous = readFileSync(out, 'utf8');
    writeFileSync(join(root, IMPORTER), 'export const x = 0;\n');
    const refreshAt = now + 21 * 3_600_000;
    const failed = await refreshDependencySnapshot(
      { root, repoName: 'papercusp', currentIndexCommit: null, prev: first.next },
      { out, now: () => refreshAt, produce: async (...args) => {
        await expect(nativeProducer(...args)).rejects.toThrow(/empty|corroborated/);
        return { exit: 3, line: 'GRAPH_SNAPSHOT status=not-written reason=empty', at: refreshAt };
      } },
    );
    expect(failed).toMatchObject({ ran: true, next: { status: 'fresh', lastProducerExit: 3 } });
    expect(readFileSync(out, 'utf8')).toBe(previous);
    const got = runSelector({
      PAPERCUSP_AFFECTED_GRAPH_SOURCE_ROOT: root,
      PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: out,
      PAPERCUSP_AFFECTED_GRAPH_SUGGESTIONS: '1',
    });
    expect(got.status, got.stderr).toBe(0);
    expectEqualToBaseline(got.names, baseline().names);
    expect(got.line).toMatch(/status=applied accepted=0 rejected=1 added=none/);
  });
});

describe('affected-tests selector ⟷ graph snapshot producer (integration, SUPERSET-ONLY)', () => {
  it('control: the baseline selects the changed workspace and NOT the importer workspace', () => {
    const base = baseline();
    expect(base.status, base.stderr.slice(0, 400)).toBe(0);
    expect(base.names.size).toBeGreaterThan(0);
    expect(base.names.has(IMPORTER_WS), 'precondition: importer workspace must be outside the baseline closure').toBe(false);
    // The status line prints on EVERY run (gitnexus-deterministic-integration P-001): a disabled or
    // dormant snapshot must say so instead of staying silent for days.
    expect(base.line).toMatch(/^GRAPH_SUGGESTIONS status=unavailable reason=disabled accepted=0 rejected=0 added=none index=none age=none$/);
  });

  it('positive: a PRODUCED snapshot ADDS exactly the importer workspace and keeps the whole baseline', () => {
    const { file, stats } = produce('produced-positive.json', [
      { importer: IMPORTER, imported: IMPORTED },
      { importer: IMPORTER, imported: 'apps/operator-docs/src/never-imported.ts' }, // uncorroborated by source
      { importer: 'packages/backup/__graph_fixture__/missing.ts', imported: IMPORTED }, // importer unreadable
    ]);
    // The producer itself must have dropped the junk edges: only the corroborated one is shipped.
    expect(stats).toMatchObject({ input: 3, kept: 1 });
    const base = baseline();
    const got = withSnapshot(file);
    expect(got.status, got.stderr.slice(0, 400)).toBe(0);
    for (const n of base.names) expect(got.names.has(n), `baseline workspace ${n} lost`).toBe(true);
    expect(got.names.has(IMPORTER_WS)).toBe(true);
    // Additions are the importer workspace PLUS its reverse-dependency closure (seeds grow the
    // closure) — so assert the importer is the added SEED and that nothing outside {importer}∪closure
    // is invented: every added workspace was absent from the baseline.
    const added = [...got.names].filter((n) => !base.names.has(n));
    expect(added).toContain(IMPORTER_WS);
    expect(added.length).toBeGreaterThanOrEqual(1);
    expect(got.line).toContain(`added=${IMPORTER_WS}`);
    expect(got.line).toMatch(/status=applied accepted=1 rejected=0 added=.*@papercusp\/backup/);
  });

  it('stale: the importer changed after the snapshot was produced => nothing added, nothing lost', () => {
    const { file } = produce('produced-stale.json', [{ importer: IMPORTER, imported: IMPORTED }]);
    // The consumer reads importer SOURCE from a different root: its content hash no longer matches.
    const driftRoot = join(tmp, 'drift-src');
    mkdirSync(join(driftRoot, IMPORTER_DIR), { recursive: true });
    writeFileSync(join(driftRoot, IMPORTER), `${IMPORTER_SRC}// edited after the snapshot\n`);
    const got = runSelector({
      PAPERCUSP_AFFECTED_GRAPH_SOURCE_ROOT: driftRoot,
      PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: file,
      PAPERCUSP_AFFECTED_GRAPH_MAX_AGE_MS: TEN_YEARS_MS,
    });
    expect(got.status, got.stderr.slice(0, 400)).toBe(0);
    expectEqualToBaseline(got.names, baseline().names);
    expect(got.line).toMatch(/status=applied accepted=0 rejected=1 added=none/);
  });

  it('graph unavailable (no snapshot file): selection === baseline, no live graph needed', () => {
    const got = runSelector({
      PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: join(tmp, 'does-not-exist.json'),
      PAPERCUSP_AFFECTED_GRAPH_MAX_AGE_MS: TEN_YEARS_MS,
    });
    expect(got.status, got.stderr.slice(0, 400)).toBe(0);
    expectEqualToBaseline(got.names, baseline().names);
    expect(got.line).toMatch(/^GRAPH_SUGGESTIONS status=unavailable reason=absent .*added=none .*source=env$/);
  });

  it('under Vitest with no explicit path the default lookup is OFF (hermetic-test), so host snapshots never leak in', () => {
    const got = runSelector({ PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: '' });
    expect(got.status, got.stderr.slice(0, 400)).toBe(0);
    expectEqualToBaseline(got.names, baseline().names);
    expect(got.line).toMatch(/status=unavailable reason=no-snapshot-path .*source=hermetic-test$/);
  });

  it('gate-shaped env (no Vitest, no explicit path, HOME admitted) reads the SHARED routine-written snapshot', () => {
    // The green-checkpoint gate forwards HOME but not PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT, and its
    // isolated checkout holds no `.papercusp/` snapshot — so the shared file under HOME is the
    // ONLY one it can read. Before P-001 this path did not exist and the gate applied nothing.
    const { snapshot } = produce('unused-shared-source.json', [{ importer: IMPORTER, imported: IMPORTED }]);
    const home = join(tmp, 'home');
    const shared = join(home, '.papercusp', 'graph-snapshot', 'papercusp', 'dependency-snapshot.json');
    mkdirSync(dirname(shared), { recursive: true });
    writeFileSync(shared, JSON.stringify(snapshot));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== 'VITEST' && k !== 'PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT') env[k] = v;
    }
    const r = spawnSync(process.execPath, [SELECTOR, '--changed-paths', IMPORTED, '--print-affected'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...env, HOME: home, PAPERCUSP_AFFECTED_GRAPH_SOURCE_ROOT: srcRoot, PAPERCUSP_AFFECTED_GRAPH_MAX_AGE_MS: TEN_YEARS_MS },
      timeout: 90_000,
    });
    expect(r.status, r.stderr.slice(0, 400)).toBe(0);
    const line = r.stderr.split('\n').find((l) => l.startsWith('GRAPH_SUGGESTIONS ')) ?? '';
    expect(line).toMatch(/status=applied accepted=1 rejected=0 added=.*@papercusp\/backup.* source=shared$/);
    expect(r.stdout.split('\n')).toContain(`AFFECTED_WS\t${IMPORTER_WS}`);
  });

  it('suggestions disabled (PAPERCUSP_AFFECTED_GRAPH_SUGGESTIONS=0) ignores even a valid produced snapshot', () => {
    const { file } = produce('produced-disabled.json', [{ importer: IMPORTER, imported: IMPORTED }]);
    const got = runSelector({
      PAPERCUSP_AFFECTED_GRAPH_SUGGESTIONS: '0',
      PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: file,
      PAPERCUSP_AFFECTED_GRAPH_MAX_AGE_MS: TEN_YEARS_MS,
    });
    expectEqualToBaseline(got.names, baseline().names);
    expect(got.names.has(IMPORTER_WS)).toBe(false);
  });
});
