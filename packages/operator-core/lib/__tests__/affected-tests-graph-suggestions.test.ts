/**
 * affected-tests-graph-suggestions.test.ts — P-008 of plan
 * gitnexus-selective-hardening-and-comparison-2026-09-13.
 *
 * The affected-test selector may take SUGGESTIONS from a pre-computed code-graph snapshot. The
 * one invariant that makes that safe is SUPERSET-ONLY: the final selection contains every
 * workspace the baseline (package.json reverse-dependency closure) selected, for a positive
 * suggestion AND for every degraded input — stale, invalid, absent, too-old, uncorroborated,
 * unrelated change. These tests pin that invariant at two layers:
 *
 *   1. the pure module (`scripts/lib/graph-dependency-suggestions.mjs`) — parse/verify/walk/
 *      union, plus a deterministic fuzz that `unionSuperset` can never lose a baseline entry;
 *   2. the REAL selector (`scripts/affected-tests.mjs --changed-paths … --print-affected`) run
 *      as a subprocess against hermetic fixture snapshots, compared case-by-case with the same
 *      run with suggestions disabled. No live graph is started anywhere here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GRAPH_SNAPSHOT_SCHEMA,
  MAX_VISITED_FILES,
  MAX_DEPENDENCY_PATH_DEPTH,
  buildSnapshot,
  computeGraphSuggestions,
  extractSpecifiers,
  formatSnapshotAge,
  formatSuggestionLine,
  parseSnapshot,
  packageNameReader,
  relativeCandidates,
  resolveSnapshotPath,
  sha256Hex,
  sharedSnapshotPath,
  sourceCorroborates,
  suggestFromSnapshot,
  unionSuperset,
  verifyEdge,
} from '../../../../scripts/lib/graph-dependency-suggestions.mjs';
import { produceSnapshotFromSource } from '../../../../scripts/gen-graph-dependency-snapshot.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/** Overridable so `scripts/mutation-probe.sh` can aim the selector-level cases at a COPY. */
const SELECTOR = process.env.PROBE_SCRIPT
  ? resolve(process.env.PROBE_SCRIPT)
  : resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

const IMPORTED = 'apps/operator-docs/src/graph-fixture.ts';
// The importer fixture must live inside a REAL workspace dir (the selector maps a suggested file
// to its owner via the root `workspaces` globs) that is OUTSIDE the baseline reverse-dep closure
// of IMPORTED. `packages/search` is not a workspace here — it silently mapped to no owner.
const IMPORTER_DIR = 'packages/backup/__graph_fixture__';
const IMPORTER = `${IMPORTER_DIR}/importer.ts`;
const MID = `${IMPORTER_DIR}/mid.ts`;
const IMPORTER_SRC = `import { fixture } from '../../../apps/operator-docs/src/graph-fixture';\nexport const x = fixture;\n`;
const IMPORTER_WS = '@papercusp/backup';
const NOW = Date.parse('2026-10-02T00:00:00.000Z');
const INDEX = { lastCommit: '0ce3904e0d4f04f4d383e39d146d1321e73bd95f', indexedAt: '2026-10-01T22:53:00.475Z', backend: 'gitnexus', backendVersion: '1.6.9' };

function snapshotOf(edges: Array<{ importer: string; imported: string; importerSha256: string }>, generatedAt = new Date(NOW).toISOString()) {
  return { schema: GRAPH_SNAPSHOT_SCHEMA, index: INDEX, generatedAt, edges };
}
const goodEdge = { importer: IMPORTER, imported: IMPORTED, importerSha256: sha256Hex(IMPORTER_SRC) };

describe('snapshot location + status line (gitnexus-deterministic-integration P-001)', () => {
  const home = '/fixture-home';
  const root = '/repo';
  const shared = '/fixture-home/.papercusp/graph-snapshot/papercusp/dependency-snapshot.json';
  const legacy = '/repo/.papercusp/graph-snapshot/dependency-snapshot.json';

  it('the shared path lives under HOME, outside every checkout', () => {
    expect(sharedSnapshotPath('papercusp', home)).toBe(shared);
  });

  it('resolves env > shared > legacy checkout, and names the source', () => {
    const has = (...paths: string[]) => (p: string) => paths.includes(p);
    expect(resolveSnapshotPath({ env: { PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: '/x.json' }, root, home, exists: has(shared, legacy) })).toEqual({ path: '/x.json', source: 'env' });
    expect(resolveSnapshotPath({ env: {}, root, home, exists: has(shared, legacy) })).toEqual({ path: shared, source: 'shared' });
    expect(resolveSnapshotPath({ env: {}, root, home, exists: has(legacy) })).toEqual({ path: legacy, source: 'checkout' });
    // Nothing on disk: report the SHARED path, so the status line says where the routine writes.
    expect(resolveSnapshotPath({ env: {}, root, home, exists: has() })).toEqual({ path: shared, source: 'shared' });
  });

  it('under Vitest with no explicit path the lookup is off — a host snapshot must not make selection host-dependent', () => {
    expect(resolveSnapshotPath({ env: { VITEST: 'true' }, root, home, exists: () => true })).toEqual({ path: null, source: 'hermetic-test' });
    expect(resolveSnapshotPath({ env: { VITEST: 'true', PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: '/x.json' }, root, home, exists: () => false }).source).toBe('env');
  });

  it('a null snapshot path is unavailable/no-snapshot-path, never a read of some default file', () => {
    const r = computeGraphSuggestions({
      changed: [IMPORTED],
      snapshotPath: null,
      readFile: () => {
        throw new Error('must not read');
      },
      readSource: () => null,
      ownerOfPath: () => [],
      now: NOW,
    });
    expect(r).toMatchObject({ status: 'unavailable', reason: 'no-snapshot-path', workspaces: [], ageMs: null });
  });

  it('the line carries age and source on every outcome', () => {
    expect(formatSnapshotAge(null)).toBe('none');
    expect(formatSnapshotAge(90 * 60_000)).toBe('1.5h');
    const applied = { status: 'applied', reason: null, accepted: 2, rejected: 1, index: { lastCommit: INDEX.lastCommit }, ageMs: 3 * 3_600_000 };
    expect(formatSuggestionLine(applied, ['@papercusp/backup'], 'shared')).toBe(
      'GRAPH_SUGGESTIONS status=applied accepted=2 rejected=1 added=@papercusp/backup index=0ce3904e0d age=3.0h source=shared',
    );
    const absent = { status: 'unavailable', reason: 'absent', accepted: 0, rejected: 0, index: null, ageMs: null };
    expect(formatSuggestionLine(absent, [], 'shared')).toBe(
      'GRAPH_SUGGESTIONS status=unavailable reason=absent accepted=0 rejected=0 added=none index=none age=none source=shared',
    );
  });
});

describe('graph-dependency-suggestions — pure module', () => {
  it('retains only source-validated hop hashes and drops the path after a consumer edit', () => {
    const sources: Record<string, string> = {
      'target.ts': 'export const target = 1;',
      'middle.ts': 'import { target } from "./target"; export const middle = target;',
      'middle.test.ts': 'import { middle } from "./middle"; export const test = middle;',
    };
    const readSource = (path: string) => sources[path] ?? null;
    const { snapshot } = buildSnapshot({ index: INDEX, now: NOW, readSource, edges: [
      { importer: 'middle.ts', imported: 'target.ts' },
      { importer: 'middle.test.ts', imported: 'middle.ts' },
    ] });
    const input = { changed: ['target.ts'], snapshot, now: NOW, readSource };
    const positive = suggestFromSnapshot(input);
    expect(positive.dependencyPaths?.find(path => path.consumer === 'middle.test.ts')).toEqual({
      changed: 'target.ts', consumer: 'middle.test.ts', files: ['target.ts', 'middle.ts', 'middle.test.ts'],
      hops: ['middle.ts', 'middle.test.ts'].map(importer => snapshot.edges.find(edge => edge.importer === importer)),
    });
    sources['middle.ts'] = 'export const middle = 1;';
    const stale = suggestFromSnapshot(input);
    expect(stale.suggestedFiles).toEqual([]);
    expect(stale.dependencyPaths).toEqual([]);
    expect(unionSuperset(['baseline.test.ts'], stale.suggestedFiles).names).toContain('baseline.test.ts');
  });

  it('bounds path evidence without narrowing deep dependency selection', () => {
    const sources: Record<string, string> = {};
    const edges = [];
    for (let index = 1; index <= MAX_DEPENDENCY_PATH_DEPTH + 2; index++) {
      const importer = `file${index}.ts`, imported = `file${index - 1}.ts`;
      sources[importer] = `import "./file${index - 1}";`;
      edges.push({ importer, imported });
    }
    const readSource = (path: string) => sources[path] ?? null;
    const { snapshot } = buildSnapshot({ edges, index: INDEX, now: NOW, readSource });
    const walk = suggestFromSnapshot({ changed: ['file0.ts'], snapshot, now: NOW, readSource });
    expect(walk.suggestedFiles).toHaveLength(MAX_DEPENDENCY_PATH_DEPTH + 2);
    expect(walk.pathsTruncated).toBe(true);
    expect(walk.dependencyPaths?.every(path => path.hops.length <= MAX_DEPENDENCY_PATH_DEPTH)).toBe(true);
  });
  it('rejects a malformed snapshot as a whole, with a reason', () => {
    expect(parseSnapshot('not json')).toEqual({ ok: false, reason: 'unparseable' });
    expect(parseSnapshot(JSON.stringify({ schema: 'other' }))).toEqual({ ok: false, reason: 'schema-mismatch' });
    expect(parseSnapshot(JSON.stringify({ ...snapshotOf([]), index: {} }))).toEqual({ ok: false, reason: 'missing-index-identity' });
    expect(parseSnapshot(JSON.stringify({ ...snapshotOf([]), generatedAt: 'nope' }))).toEqual({ ok: false, reason: 'missing-generated-at' });
    expect(parseSnapshot(JSON.stringify({ ...snapshotOf([]), edges: {} }))).toEqual({ ok: false, reason: 'edges-not-array' });
  });

  it('drops malformed edges (adds nothing) but keeps the snapshot', () => {
    const parsed = parseSnapshot(
      JSON.stringify(
        snapshotOf([
          goodEdge,
          { importer: '/abs/path.ts', imported: IMPORTED, importerSha256: goodEdge.importerSha256 },
          { importer: '../escape.ts', imported: IMPORTED, importerSha256: goodEdge.importerSha256 },
          { importer: IMPORTER, imported: IMPORTED, importerSha256: 'short' },
        ]),
      ),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.snapshot?.edges).toHaveLength(1);
      expect(parsed.droppedMalformed).toBe(3);
    }
  });

  it('extracts import / export-from / require / dynamic-import specifiers', () => {
    const src = `import a from './a';\nexport * from "../b";\nconst c = require('./c.js');\nconst d = await import(\`./d\`);\nimport './side-effect';`;
    expect(extractSpecifiers(src).sort()).toEqual(['../b', './a', './c.js', './d', './side-effect'].sort());
  });

  it('resolves relative specifiers incl. index files and .js -> .ts rewrites', () => {
    expect(relativeCandidates('a/b/x.ts', '../c/y').has('a/c/y.ts')).toBe(true);
    expect(relativeCandidates('a/b/x.ts', '../c').has('a/c/index.ts')).toBe(true);
    expect(relativeCandidates('a/b/x.ts', './z.js').has('a/b/z.ts')).toBe(true);
    expect(relativeCandidates('a/b/x.ts', './z.js').has('a/c/z.ts')).toBe(false);
  });

  it('corroborates by source only: relative resolution, or alias path tail; never by name alone', () => {
    expect(sourceCorroborates(IMPORTER_SRC, IMPORTER, IMPORTED)).toBe(true);
    expect(sourceCorroborates(`import x from '@/src/graph-fixture';`, IMPORTER, IMPORTED)).toBe(true);
    expect(sourceCorroborates(`import x from '../../../apps/operator-docs/src/other';`, IMPORTER, IMPORTED)).toBe(false);
    expect(sourceCorroborates(`// graph-fixture mentioned only in a comment`, IMPORTER, IMPORTED)).toBe(false);
  });

  it('verifyEdge: importer-missing / stale-importer / uncorroborated / ok', () => {
    expect(verifyEdge(goodEdge, { readSource: () => null })).toEqual({ ok: false, reason: 'importer-missing' });
    expect(verifyEdge(goodEdge, { readSource: () => `${IMPORTER_SRC}// edited` })).toEqual({ ok: false, reason: 'stale-importer' });
    const noImport = 'export const y = 1;\n';
    expect(verifyEdge({ ...goodEdge, importerSha256: sha256Hex(noImport) }, { readSource: () => noImport })).toEqual({ ok: false, reason: 'uncorroborated' });
    expect(verifyEdge(goodEdge, { readSource: () => IMPORTER_SRC })).toEqual({ ok: true });
  });

  it('corroborates directory index aliases but refuses a different directory or a basename-only guess', () => {
    const src = `import x from '@/lib/widgets';`;
    expect(sourceCorroborates(src, IMPORTER, 'packages/ui/lib/widgets/index.ts')).toBe(true);
    expect(sourceCorroborates(src, IMPORTER, 'packages/ui/lib/other/index.ts')).toBe(false);
    expect(sourceCorroborates(`import x from 'widgets';`, IMPORTER, 'packages/ui/lib/widgets/index.ts')).toBe(false);
  });

  it('re-resolves package root and src subpaths from the target manifest, not its directory name', () => {
    const names = packageNameReader((p: string) => p === 'libs/core/package.json' ? '{"name":"@scope/api"}' : null);
    for (const [specifier, target] of [
      ['@scope/api', 'libs/core/src/index.ts'],
      ['@scope/api', 'libs/core/index.ts'],
      ['@scope/api/client', 'libs/core/src/client.ts'],
      ['@scope/api/widgets', 'libs/core/src/widgets/index.ts'],
      ['@scope/api/client.js', 'libs/core/src/client.ts'],
    ]) {
      expect(sourceCorroborates(`import x from '${specifier}';`, IMPORTER, target, names)).toBe(true);
    }
    for (const [specifier, target] of [
      ['@scope/api-other', 'libs/core/src/index.ts'],
      ['@scope/api/other', 'libs/core/src/client.ts'],
      ['@scope/api', 'libs/core/src/client.ts'],
      ['@scope/api', 'libs/unrelated/src/index.ts'],
    ]) {
      expect(sourceCorroborates(`import x from '${specifier}';`, IMPORTER, target, names)).toBe(false);
    }
    expect(sourceCorroborates(`import x from '@scope/api';`, IMPORTER, 'libs/core/src/index.ts')).toBe(false);
    expect(sourceCorroborates(`import x from '@scope/api';`, IMPORTER, 'libs/core/src/index.ts', packageNameReader(() => '{broken'))).toBe(false);
  });

  it('producer and consumer both use manifest corroboration, preserving hashes and the baseline superset', () => {
    const source = `import x from '@scope/api';`;
    const target = 'libs/core/src/index.ts';
    const sources: Record<string, string> = {
      [IMPORTER]: source,
      'libs/core/package.json': '{"name":"@scope/api"}',
    };
    const readSource = (p: string) => sources[p] ?? null;
    const built = buildSnapshot({
      edges: [{ importer: IMPORTER, imported: target }, { importer: IMPORTER, imported: 'libs/other/src/index.ts' }],
      index: INDEX, readSource, now: NOW,
    });
    expect(built.stats).toMatchObject({ kept: 1, skippedUncorroborated: 1 });
    const walk = () => suggestFromSnapshot({ changed: [target], snapshot: built.snapshot, now: NOW, readSource });
    expect(walk().suggestedFiles).toEqual([IMPORTER]);
    expect(unionSuperset(['baseline'], walk().suggestedFiles).names).toEqual(['baseline', IMPORTER]);
    sources['libs/core/package.json'] = '{"name":"@scope/renamed"}';
    expect(walk().rejected).toEqual([{ importer: IMPORTER, imported: target, reason: 'uncorroborated' }]);
    sources['libs/core/package.json'] = '{"name":"@scope/api"}';
    sources[IMPORTER] += '// changed';
    expect(walk().rejected[0].reason).toBe('stale-importer');
  });

  it.each(['@scope/coordination', 'coordination'])('refuses a %s package edge into another workspace with the same path tail', name => {
    const source = `import { presence } from '${name}/presence';`;
    const right = 'packages/coordination/src/presence/index.ts';
    const wrong = 'packages/operator-core/lib/coordination/presence.ts';
    const sources: Record<string, string> = {
      [IMPORTER]: source,
      'packages/coordination/package.json': JSON.stringify({ name }),
      'packages/operator-core/package.json': '{"name":"@scope/operator-core"}',
    };
    const readSource = (p: string) => sources[p] ?? null;
    const names = packageNameReader(readSource);
    expect(sourceCorroborates(source, IMPORTER, right, names)).toBe(true);
    expect(sourceCorroborates(source, IMPORTER, wrong, names)).toBe(false);
    expect(sourceCorroborates(source, IMPORTER, wrong)).toBe(false);
    const edge = { importer: IMPORTER, imported: wrong, importerSha256: sha256Hex(source) };
    expect(verifyEdge(edge, { readSource })).toEqual({ ok: false, reason: 'uncorroborated' });
    const built = buildSnapshot({ edges: [edge], index: INDEX, readSource, now: NOW });
    expect(built.stats).toMatchObject({ kept: 0, skippedUncorroborated: 1 });
    const walk = suggestFromSnapshot({ changed: [wrong], snapshot: snapshotOf([edge]), now: NOW, readSource });
    expect(walk.suggestedFiles).toEqual([]);
    expect(unionSuperset(['baseline'], walk.suggestedFiles).names).toEqual(['baseline']);
  });

  it('keeps explicit directory aliases separate from package manifest resolution', () => {
    const names = packageNameReader(() => '{"name":"@scope/unrelated"}');
    for (const specifier of ['@/coordination/presence', '~/coordination/presence']) {
      expect(sourceCorroborates(`import x from '${specifier}';`, IMPORTER,
        'packages/ui/coordination/presence/index.ts', names)).toBe(true);
    }
  });

  it('memoizes manifest reads during a snapshot build', () => {
    const sources: Record<string, string> = {
      'apps/a.ts': `import x from '@scope/api/client';`,
      'apps/b.ts': `export * from '@scope/api/client';`,
      'libs/core/package.json': '{"name":"@scope/api"}',
    };
    const reads: string[] = [];
    const built = buildSnapshot({
      edges: ['apps/a.ts', 'apps/b.ts'].map((importer) => ({ importer, imported: 'libs/core/src/client.ts' })),
      index: INDEX, now: NOW,
      readSource: (p: string) => { reads.push(p); return sources[p] ?? null; },
    });
    expect(built.stats.kept).toBe(2);
    expect(reads.filter((p) => p === 'libs/core/package.json')).toHaveLength(1);
  });

  it('walks verified importers transitively and records every rejection', () => {
    const mid = `import { x } from './importer';\nexport const m = x;\n`;
    const top = `import { m } from '../__graph_fixture__/mid';\n`;
    const sources: Record<string, string> = {
      [IMPORTER]: IMPORTER_SRC,
      [MID]: mid,
      'packages/other/top.ts': top, // wrong relative path => uncorroborated
    };
    const snap = snapshotOf([
      goodEdge,
      { importer: MID, imported: IMPORTER, importerSha256: sha256Hex(mid) },
      { importer: 'packages/other/top.ts', imported: MID, importerSha256: sha256Hex(top) },
    ]);
    const res = suggestFromSnapshot({ changed: [IMPORTED], snapshot: snap as never, now: NOW, readSource: (p: string) => sources[p] ?? null });
    expect(res.status).toBe('applied');
    expect(res.suggestedFiles.sort()).toEqual([IMPORTER, MID].sort());
    expect(res.rejected).toEqual([{ importer: 'packages/other/top.ts', imported: MID, reason: 'uncorroborated' }]);
  });

  it('bounds the traversal frontier including the initial changed-file seeds', () => {
    const changed = Array.from({ length: MAX_VISITED_FILES + 1 }, (_, i) => `packages/changed/${i}.ts`);
    const res = suggestFromSnapshot({ changed, snapshot: snapshotOf([]) as never, now: NOW, readSource: () => null });
    expect(res.status).toBe('applied');
    expect(res.truncated).toBe(true);
    expect(res.suggestedFiles).toEqual([]);
  });

  it('status is unavailable / stale / invalid — each suggests nothing', () => {
    const read = () => IMPORTER_SRC;
    expect(suggestFromSnapshot({ changed: [IMPORTED], snapshot: null as never, now: NOW, readSource: read }).status).toBe('unavailable');
    const old = snapshotOf([goodEdge], new Date(NOW - 48 * 3600 * 1000).toISOString());
    const stale = suggestFromSnapshot({ changed: [IMPORTED], snapshot: old as never, now: NOW, readSource: read });
    expect([stale.status, stale.suggestedFiles]).toEqual(['stale', []]);
    const future = snapshotOf([goodEdge], new Date(NOW + 3600 * 1000).toISOString());
    const inv = suggestFromSnapshot({ changed: [IMPORTED], snapshot: future as never, now: NOW, readSource: read });
    expect([inv.status, inv.suggestedFiles]).toEqual(['invalid', []]);
  });

  it('unionSuperset never loses a baseline entry (deterministic fuzz) and reports only additions', () => {
    let seed = 20261002;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const pool = Array.from({ length: 24 }, (_, i) => `ws-${i}`);
    for (let i = 0; i < 300; i += 1) {
      const baseline = pool.filter(() => rnd() < 0.4);
      const suggested = pool.filter(() => rnd() < 0.4);
      const out = unionSuperset(baseline, suggested);
      for (const b of baseline) expect(out.names).toContain(b);
      expect(out.added.every((n) => !baseline.includes(n))).toBe(true);
      expect(new Set(out.names)).toEqual(new Set([...baseline, ...suggested]));
    }
  });

  it('buildSnapshot keeps only source-corroborated, de-duplicated edges bound to the importer hash', () => {
    const { snapshot, stats } = buildSnapshot({
      edges: [
        { importer: IMPORTER, imported: IMPORTED },
        { importer: IMPORTER, imported: IMPORTED }, // duplicate
        { importer: 'packages/missing/file.ts', imported: IMPORTED }, // not readable
        { importer: IMPORTER, imported: 'apps/operator-docs/src/unrelated.ts' }, // not imported by source
        { importer: '/abs.ts', imported: IMPORTED }, // not repo-relative
      ],
      index: INDEX,
      readSource: (p: string) => (p === IMPORTER ? IMPORTER_SRC : null),
      now: NOW,
    });
    expect(snapshot.edges).toEqual([goodEdge]);
    expect(stats).toMatchObject({ input: 5, kept: 1, duplicates: 1, skippedMissing: 2, skippedUncorroborated: 1 });
    expect(parseSnapshot(JSON.stringify(snapshot)).ok).toBe(true);
  });
});

// ── the REAL selector, against hermetic fixture snapshots ────────────────────────────────────
let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'graph-suggestions-'));
  mkdirSync(join(tmp, 'src', IMPORTER_DIR), { recursive: true });
  writeFileSync(join(tmp, 'src', IMPORTER), IMPORTER_SRC);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function writeSnapshot(name: string, body: unknown): string {
  const p = join(tmp, name);
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
  return p;
}

function runSelector(changed: string, env: Record<string, string>) {
  const r = spawnSync(process.execPath, [SELECTOR, '--changed-paths', changed, '--print-affected'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PAPERCUSP_AFFECTED_GRAPH_SOURCE_ROOT: join(tmp, 'src'), ...env },
    timeout: 60_000,
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

describe('affected-tests selector — graph suggestions are SUPERSET-ONLY', () => {
  it('control: the baseline run selects the changed workspace and NOT the importer workspace', () => {
    const base = runSelector(IMPORTED, { PAPERCUSP_AFFECTED_GRAPH_SUGGESTIONS: '0' });
    expect(base.status, base.stderr.slice(0, 400)).toBe(0);
    expect(base.names.size).toBeGreaterThan(0);
    expect(base.names.has(IMPORTER_WS), 'precondition: the fixture importer workspace must be outside the baseline closure').toBe(false);
    // Printed on EVERY run since P-001 — a disabled path says so instead of staying silent.
    expect(base.line).toMatch(/^GRAPH_SUGGESTIONS status=unavailable reason=disabled .*added=none/);
  });

  it('positive: a verified edge ADDS the importer workspace and keeps the whole baseline', () => {
    const snap = writeSnapshot('positive.json', snapshotOf([goodEdge]));
    const base = runSelector(IMPORTED, { PAPERCUSP_AFFECTED_GRAPH_SUGGESTIONS: '0' });
    const withGraph = runSelector(IMPORTED, { PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: snap, PAPERCUSP_AFFECTED_GRAPH_MAX_AGE_MS: String(10 * 365 * 86400 * 1000) });
    for (const n of base.names) expect(withGraph.names.has(n), `baseline workspace ${n} lost`).toBe(true);
    expect(withGraph.names.has(IMPORTER_WS)).toBe(true);
    expect(withGraph.line).toMatch(/status=applied accepted=1 rejected=0 added=.*@papercusp\/backup/);
  });

  it('first-party handover keeps the reference consumer and baseline; stale source cannot add it', () => {
    const sources: Record<string, string> = { [IMPORTER]: IMPORTER_SRC, [IMPORTED]: 'export const fixture = 1;' };
    const produced = produceSnapshotFromSource({ files: Object.keys(sources), readSource: p => sources[p] ?? null, headCommit: INDEX.lastCommit, now: Date.now() });
    expect(produced.snapshot.index.backend).toBe('first-party-imports');
    expect(produced.snapshot.edges).toEqual([goodEdge]);
    const baseline = runSelector(IMPORTED, { PAPERCUSP_AFFECTED_GRAPH_SUGGESTIONS: '0' });
    const handover = runSelector(IMPORTED, { PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: writeSnapshot('first-party.json', produced.snapshot) });
    expect(handover.status).toBe(0);
    expect(handover.names.has(IMPORTER_WS)).toBe(true);
    for (const name of baseline.names) expect(handover.names.has(name), `baseline workspace ${name} lost`).toBe(true);
    const stale = { ...produced.snapshot, edges: produced.snapshot.edges.map(edge => ({ ...edge, importerSha256: sha256Hex('different source') })) };
    const rejected = runSelector(IMPORTED, { PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: writeSnapshot('first-party-stale.json', stale) });
    expect(rejected.status).toBe(0);
    expect(rejected.names).toEqual(baseline.names);
    expect(rejected.line).toMatch(/accepted=0 rejected=1/);
  });

  const degraded: Array<[string, () => string | null, RegExp]> = [
    ['stale importer (hash drift)', () => writeSnapshot('stale.json', snapshotOf([{ ...goodEdge, importerSha256: sha256Hex('different') }])), /status=applied accepted=0 rejected=1 added=none/],
    ['invalid snapshot', () => writeSnapshot('invalid.json', '{"schema":"wrong"}'), /status=invalid reason=schema-mismatch accepted=0 rejected=0 added=none/],
    ['unparseable snapshot', () => writeSnapshot('garbage.json', 'not json at all'), /status=invalid reason=unparseable/],
    // A reindex can SUCCEED while the snapshot file it leaves behind is empty or cut off
    // mid-write (rubric R-5's "empty or corrupt snapshot after a successful reindex"). The
    // producer refuses to write either (gen-graph-dependency-snapshot.test.ts), so these
    // pin the CONSUMER half: whatever is on disk, a non-snapshot never changes the selection.
    ['empty snapshot file (0 bytes)', () => writeSnapshot('empty.json', ''), /status=invalid reason=unparseable accepted=0 rejected=0 added=none/],
    ['truncated snapshot (write cut off mid-file)', () => writeSnapshot('truncated.json', JSON.stringify(snapshotOf([goodEdge])).slice(0, 60)), /status=invalid reason=unparseable accepted=0 rejected=0 added=none/],
    ['schema-valid snapshot with zero edges', () => writeSnapshot('zero-edges.json', snapshotOf([])), /status=applied accepted=0 rejected=0 added=none/],
    ['graph unavailable (no snapshot file)', () => join(tmp, 'does-not-exist.json'), /^GRAPH_SUGGESTIONS status=unavailable reason=absent .*added=none .*source=env$/],
    ['uncorroborated edge', () => writeSnapshot('uncorr.json', snapshotOf([{ importer: IMPORTER, imported: 'apps/operator-docs/src/never-imported.ts', importerSha256: sha256Hex(IMPORTER_SRC) }])), /status=applied accepted=0 rejected=1 added=none/],
  ];
  for (const [label, makeSnap, lineRe] of degraded) {
    it(`${label}: final selection === baseline (adds nothing, loses nothing)`, () => {
      const snap = makeSnap();
      const changed = label === 'uncorroborated edge' ? 'apps/operator-docs/src/never-imported.ts' : IMPORTED;
      const base = runSelector(changed, { PAPERCUSP_AFFECTED_GRAPH_SUGGESTIONS: '0' });
      const withGraph = runSelector(changed, { PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: snap as string, PAPERCUSP_AFFECTED_GRAPH_MAX_AGE_MS: String(10 * 365 * 86400 * 1000) });
      expect(withGraph.status).toBe(0);
      for (const n of base.names) expect(withGraph.names.has(n), `baseline workspace ${n} lost`).toBe(true);
      expect(withGraph.names).toEqual(base.names);
      expect(withGraph.line ?? '').toMatch(lineRe);
    });
  }

  it('too-old snapshot: status=stale, nothing added', () => {
    const snap = writeSnapshot('old.json', snapshotOf([goodEdge], '2020-01-01T00:00:00.000Z'));
    const base = runSelector(IMPORTED, { PAPERCUSP_AFFECTED_GRAPH_SUGGESTIONS: '0' });
    const withGraph = runSelector(IMPORTED, { PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: snap });
    expect(withGraph.names).toEqual(base.names);
    expect(withGraph.line).toMatch(/status=stale reason=snapshot-too-old/);
  });

  it('unrelated change (no edge touches it): selection === baseline', () => {
    const snap = writeSnapshot('unrelated.json', snapshotOf([goodEdge]));
    const changed = 'apps/operator-docs/src/something-else.ts';
    const base = runSelector(changed, { PAPERCUSP_AFFECTED_GRAPH_SUGGESTIONS: '0' });
    const withGraph = runSelector(changed, { PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: snap, PAPERCUSP_AFFECTED_GRAPH_MAX_AGE_MS: String(10 * 365 * 86400 * 1000) });
    expect(withGraph.names).toEqual(base.names);
    expect(withGraph.line).toMatch(/status=applied accepted=0 rejected=0 added=none/);
  });
});
