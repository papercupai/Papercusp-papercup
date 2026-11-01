/** P016 query/advisory adapter. A static edge never becomes execution evidence. */
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import fg from 'fast-glob';
import { coverageHash, COVERAGE_MAX_FILES, COVERAGE_RETENTION_MS, parseTestCoverage,
  type TestCoverageSnapshot } from '@papercusp/test-config/test-coverage-map';
import type { ReuseBriefProvider, ReuseProviderContext } from './reuse-brief-providers';

export interface CoverageQuestion { path: string; line1?: number; endLine1?: number; changedLines?: readonly number[] }
export interface CoverageAnswer {
  basis: 'execution' | 'static';
  tests: string[];
  noTestExecutes: boolean | null;
  uncoveredChangedLines: number[];
  unknownChangedLines: number[];
  reason: string;
}
export interface CoverageScopeData {
  snapshots: TestCoverageSnapshot[];
  currentHashes: Map<string, string>;
  population: string[] | null;
}

/** The same qualification feeds negative coverage claims and SQL checked scope. */
export function sourceBoundCoverageSnapshots(root: string, snapshots: readonly unknown[],
  hashes: ReadonlyMap<string, string>, now = Date.now()): TestCoverageSnapshot[] {
  return snapshots.flatMap(value => {
    const s = parseTestCoverage(value);
    if (!s || s.root !== root || now - Date.parse(s.observedAt) > COVERAGE_RETENTION_MS
      || Date.parse(s.observedAt) > now || hashes.get(s.testFile) !== s.testSha256
      || s.sources.some(source => hashes.get(source.path) !== source.sha256)
      || s.population.some(test => hashes.get(test.path) !== test.sha256)) return [];
    return [s];
  });
}
export function queryTestCoverage(input: { root: string; question: CoverageQuestion; snapshots: readonly unknown[];
  currentHashes: ReadonlyMap<string, string>; currentPopulation: readonly string[] | null;
  staticTests?: readonly string[]; now?: number }): CoverageAnswer {
  const now = input.now ?? Date.now(), q = input.question;
  const fallback = (reason: string): CoverageAnswer => ({ basis: 'static', tests: [...(input.staticTests ?? [])],
    noTestExecutes: null, uncoveredChangedLines: [], unknownChangedLines: [...(q.changedLines ?? [])], reason });
  const rows = sourceBoundCoverageSnapshots(input.root, input.snapshots, input.currentHashes, now)
    .filter(s => s.sources.some(source => source.path === q.path));
  if (!rows.length) return fallback('Missing, stale or source-mismatched coverage; static reach only.');
  // One capture/population only: never manufacture a complete run by merging historical partial runs.
  rows.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  const newest = rows[0]!;
  const batch = rows.filter(s => s.scopeRoot === newest.scopeRoot && s.observedAt === newest.observedAt);
  const population = newest.population.map(s => s.path).sort();
  const current = input.currentPopulation ? [...input.currentPopulation].sort() : null;
  const complete = newest.populationComplete && current !== null && JSON.stringify(current) === JSON.stringify(population)
    && batch.length === population.length && population.every(path => batch.some(s => s.testFile === path))
    && batch.every(s => s.populationComplete && JSON.stringify(s.population) === JSON.stringify(newest.population));
  const within = (line: number) => line >= (q.line1 ?? 1) && line <= (q.endLine1 ?? Infinity);
  // Completeness and absence come from the newest capture only (above). Positive evidence does not:
  // every row here is still bound to the current test, source and population hashes, so an older
  // capture remains proof that ITS test executes these lines. test:file runs unit and integration
  // configs as separate captures; reading only the newest one discarded the other's evidence.
  const tests = rows.filter(s => s.sources.find(source => source.path === q.path)!.covered.some(within)).map(s => s.testFile);
  const covered = new Set(rows.flatMap(s => s.sources.find(source => source.path === q.path)!.covered));
  const executable = new Set(batch.flatMap(s => s.sources.find(source => source.path === q.path)!.executable));
  const changed = [...new Set(q.changedLines ?? [])].filter(n => Number.isSafeInteger(n) && n > 0);
  return { basis: 'execution', tests: [...new Set(tests)].sort(),
    noTestExecutes: complete && [...executable].some(within) ? tests.length === 0 : null,
    uncoveredChangedLines: complete ? changed.filter(line => executable.has(line) && !covered.has(line)) : [],
    unknownChangedLines: changed.filter(line => !covered.has(line) && (!complete || !executable.has(line))),
    reason: complete ? 'Complete source-bound test-file population.' : 'Partial test-file execution; absence remains unknown.' };
}

export function coverageBriefProvider(load: (context: Readonly<ReuseProviderContext>, signal: AbortSignal) => Promise<{
  snapshots: TestCoverageSnapshot[]; currentHashes: Map<string, string>; population: string[] | null;
} | null>): ReuseBriefProvider {
  return { id: 'coverage', async read(context, signal) {
    if (!context.repository || !context.sourceVersion) return { status: 'unknown', lines: [], sourceVersion: null, indexVersion: null };
    const data = await load(context, signal);
    const lines = context.paths.slice(0, 3).map(path => {
      const answer = queryTestCoverage({ root: context.repository!.rootPath, question: { path,
        changedLines: context.changedLines?.[path] }, snapshots: data?.snapshots ?? [],
        currentHashes: data?.currentHashes ?? new Map(), currentPopulation: data?.population ?? null,
        staticTests: context.staticTests });
      if (answer.basis === 'static') return `${path}: static reach fallback; execution unknown.`;
      if (context.surface === 'completion' && answer.uncoveredChangedLines.length) {
        return `${path}: no recorded test executed changed lines ${answer.uncoveredChangedLines.join(',')}.`;
      }
      return `${path}: ${answer.tests.length ? `executed by ${answer.tests.join(', ')}`
        : answer.noTestExecutes === true ? 'no test executes this in the complete recorded population'
          : 'execution absence unknown (partial coverage)'}.`;
    });
    return { status: 'measured', lines, sourceVersion: context.sourceVersion,
      indexVersion: coverageHash(JSON.stringify(data?.snapshots.map(s => [s.testFile, s.observedAt]) ?? ['static'])),
      citedPaths: context.paths.slice(0, 3) };
  } };
}

/** Scope/registry + test-run DB are the same authorities as mandatory task briefs. */
export async function readNativeCoverageScope(context: Readonly<ReuseProviderContext>, signal: AbortSignal,
  binding?: { runGroupId: string; testFiles: readonly string[] }): Promise<CoverageScopeData | null> {
  if (!context.repository || !context.sourceFiles?.length) return null;
  const root = await realpath(context.repository.rootPath);
  if (root !== context.repository.rootPath) return null;
  const [{ getOrgPg }, { loadHarnessRegistry }, { readTestCoverage }] = await Promise.all([
    import('@papercusp/db-org'), import('../harness-registry'), import('@papercusp/test-config/test-coverage-store'),
  ]);
  const projects = (await loadHarnessRegistry(context.workspaceId)).projects;
  let harness = projects.find(p => p.path === root)?.slug;
  if (!harness) {
    // Maintained historical verifiers have their own physical coverage roots. The
    // existing committed-tree verifier binds them to a registered dependency donor;
    // never register a scratch checkout or re-label another root's snapshots.
    try {
      const { committedWorkRootDependencyDonor } = await import('../../../../scripts/lint-as-committed.mjs');
      const donor = committedWorkRootDependencyDonor(root);
      if (donor === root) return null;
      harness = projects.find(p => p.path === donor)?.slug;
      if (!harness) return null;
      const git = promisify((await import('node:child_process')).execFile);
      const options = { timeout: 10_000, signal, maxBuffer: 1024 * 1024 };
      const { stdout } = await git('git', ['-C', root, 'rev-parse', 'HEAD'], options);
      await git('git', ['-C', donor, 'cat-file', '-e', `${stdout.trim()}^{commit}`], options);
      await git('git', ['-C', root, 'diff', '--quiet', 'HEAD', '--'], options);
    } catch {
      return null;
    }
  }
  if (context.repository.harness && context.repository.harness !== harness) return null;
  signal.throwIfAborted();
  const snapshots = await readTestCoverage(getOrgPg().sql, context.workspaceId, harness, root, context.paths, binding?.runGroupId);
  if (binding && (snapshots.some(s => !binding.testFiles.includes(s.testFile))
    || new Set(snapshots.map(s => `${s.scopeRoot}\0${s.observedAt}`)).size !== 1)) return null;
  const paths = [...new Set([...context.sourceFiles.map(s => s.path),
    ...snapshots.flatMap(s => [...s.sources.map(f => f.path), ...s.population.map(f => f.path)])])];
  if (paths.length > COVERAGE_MAX_FILES * 2) return null;
  const hashes = await Promise.all(paths.map(async path => {
    const absolute = await realpath(join(root, path));
    if (!absolute.startsWith(`${root}/`)) throw new Error('Coverage source escapes repository');
    return [path, coverageHash(await readFile(absolute, { signal }))] as const;
  }));
  const currentHashes = new Map(hashes);
  if (context.sourceFiles.some(s => currentHashes.get(s.path) !== s.sha256)
    || coverageHash(JSON.stringify(context.sourceFiles.map(s => [s.path, s.sha256]))) !== context.sourceVersion) return null;
  const scopes = [...new Set(snapshots.map(s => s.scopeRoot))];
  let population: string[] | null = null;
  if (scopes.length === 1 && (scopes[0] === root || scopes[0]!.startsWith(`${root}/`))) {
    // Conservative superset: differing config excludes deny a negative conclusion.
    const found: string[] = [];
    for await (const path of fg.stream('**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}', {
      cwd: scopes[0], absolute: true, followSymbolicLinks: false,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.papercusp/**', '**/coverage/**'],
    })) {
      found.push(String(path).slice(root.length + 1));
      if (found.length > COVERAGE_MAX_FILES) break;
    }
    if (found.length <= COVERAGE_MAX_FILES) population = found;
  }
  const qualified = sourceBoundCoverageSnapshots(root, snapshots, currentHashes);
  if (binding && (qualified.length !== snapshots.length || !qualified.length)) return null;
  return { snapshots: qualified, currentHashes, population };
}
export const nativeCoverageBriefProvider = coverageBriefProvider(readNativeCoverageScope);
