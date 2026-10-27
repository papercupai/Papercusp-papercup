/** Bounded, source-checked reads of the existing clone index.
 * Type-3 uses D-015's selected engine; Type-4 retains P012's score identity.
 */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import fg from 'fast-glob';
import { buildCloneIndex, cloneBlobSha, CLONE_MAX_SOURCE_BYTES, extractCloneFile, type CloneFunction, type CloneIndex } from './clone-index';
import { peekPushSnapshot } from './push-snapshot';
import { CLONE_NEAR_POLICY } from './clone-near';
import { SEMANTIC_HYBRID_MODEL } from './semantic-code-calibration';
import { SEMANTIC_RELEVANCE_CUTOFF } from './semantic-code';
import type { semanticSimilarQuery } from './semantic-code-runtime';

export type ReuseMatchKind = 'exact' | 'renamed' | 'near' | 'semantic';
export interface ReuseGraphArgs {
  op: 'similar' | 'clones'; name?: string; file_path?: string; line1?: number;
  snippet?: string; paths?: string[]; limit?: number;
}
const MAX_FILES = 200, MAX_BYTES = 4_000_000, MAX_RESULTS = 100;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const locationOrder = (a: CloneFunction, b: CloneFunction) => compare(a.path, b.path) || a.line - b.line || a.column - b.column;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const site = (fn: CloneFunction) => ({ id: fn.id, path: fn.path, line1: fn.line, column: fn.column,
  location: `${fn.path}:${fn.line}`, name: fn.name, signature: fn.signature, blobSha: fn.blobSha });
type SemanticResult = Awaited<ReturnType<typeof semanticSimilarQuery>>;
export type SemanticReuseProvider = (args: ReuseGraphArgs, signal?: AbortSignal) => Promise<SemanticResult>;
type ReuseMatch = ReturnType<typeof site> & { kind: ReuseMatchKind; score: number;
  candidateOnly?: true; scoreMethod?: string; cosineSimilarity?: number | null;
  rankScore?: number; crossEncoderRelevance?: number };
const matchOrder = (a: ReuseMatch, b: ReuseMatch) =>
  ['exact', 'renamed', 'near', 'semantic'].indexOf(a.kind) - ['exact', 'renamed', 'near', 'semantic'].indexOf(b.kind)
  || b.score - a.score || compare(a.path, b.path) || a.line1 - b.line1 || a.column - b.column;
const calibration = {
  exact: { method: 'exact AST body fingerprint equality', scoreMeaning: 'binary equality, not probability', score: 1 },
  renamed: { method: 'identifier/literal-normalized AST body fingerprint equality', scoreMeaning: 'binary equality, not probability', score: 1 },
  near: { status: 'calibrated', method: CLONE_NEAR_POLICY.version, threshold: CLONE_NEAR_POLICY.threshold,
    scoreMeaning: 'ordered AST subtree similarity, not probability or semantic equivalence',
    population: 'D-015 retained 15-pair benchmark; corpus-wide recall unknown',
    minhashSeeds: CLONE_NEAR_POLICY.seeds, rowsPerBand: CLONE_NEAR_POLICY.rowsPerBand, shingleWidth: CLONE_NEAR_POLICY.shingleWidth },
  semantic: { status: 'unknown', reason: 'Calibrated semantic provider not published' },
} as const;

/** Pure query seam also used by downstream adapters; no fabricated locations for
 * ambiguous input, and exact equality takes precedence over normalized equality.
 */
export function queryCloneIndex(index: CloneIndex, args: ReuseGraphArgs, sources: ReadonlyMap<string, string>) {
  const limit = Math.min(MAX_RESULTS, Math.max(1, Math.floor(args.limit ?? 20)));
  const files = index.getFiles();
  const eligible = files.flatMap(file => file.functions).filter(fn =>
    !fn.classification.test && !fn.classification.vendored && !fn.classification.retired);
  const metadata = { indexVersion: index.version, calibration, limit,
    unknown: files.filter(file => file.status !== 'indexed').map(file => ({ path: file.path, reason: file.status })) };
  if (args.op === 'clones') {
    let remaining = limit;
    const all = index.families('renamed', { crossFile: false });
    const families = [];
    for (const family of all) {
      if (remaining < 2) break;
      const kind = family.members.every(fn => fn.exact === family.members[0]!.exact) ? 'exact' : 'renamed';
      const members = family.members.slice(0, remaining);
      remaining -= members.length;
      families.push({ id: family.id, kind, score: 1, members: members.map(site),
        totalMembers: family.members.length, truncated: members.length < family.members.length });
    }
    return { ...metadata, status: 'ok' as const, families,
      truncation: { truncated: families.length < all.length || families.some(family => family.truncated),
        totalAvailable: all.length, unit: 'families', memberBudget: limit } };
  }
  let candidates: readonly CloneFunction[];
  if (args.snippet !== undefined) {
    if (args.name || args.file_path || args.line1) return { ...metadata, status: 'invalid' as const,
      error: 'Use snippet alone, or name/file_path/line1 selectors.', matches: [] };
    let parsed = extractCloneFile({ path: 'snippet.ts', source: args.snippet }, index.minMass);
    if (parsed.status === 'indexed' && !parsed.functions.length) {
      parsed = extractCloneFile({ path: 'snippet.ts', source: `function __snippet__() {\n${args.snippet}\n}` }, index.minMass);
    }
    if (parsed.status !== 'indexed' || parsed.functions.length !== 1) return { ...metadata, status: 'ambiguous' as const,
      error: 'Snippet must identify one eligible block-bodied function or its body.', matches: [] };
    candidates = parsed.functions;
  } else {
    if (!args.name && !(args.file_path && args.line1)) return { ...metadata, status: 'invalid' as const,
      error: 'similar requires name, file_path plus line1, or snippet.', matches: [] };
    if (args.line1 && !args.file_path) return { ...metadata, status: 'invalid' as const,
      error: 'line1 requires file_path.', matches: [] };
    candidates = eligible.filter(fn => (!args.name || fn.name === args.name) && (!args.file_path || fn.path === args.file_path));
    if (args.line1) {
      const starts = candidates.filter(fn => fn.line === args.line1);
      candidates = starts.length ? starts : candidates.filter(fn => {
        const source = sources.get(fn.path);
        return source !== undefined && fn.line <= args.line1! && args.line1! <= source.slice(0, fn.end).split('\n').length;
      });
    }
  }
  if (candidates.length !== 1) return { ...metadata, status: candidates.length ? 'ambiguous' as const : 'unknown' as const,
    error: candidates.length ? 'Multiple declarations; provide file_path and line1.' : 'No eligible source declaration in this bounded index.',
    candidates: [...candidates].sort(locationOrder).slice(0, limit).map(site), matches: [],
    truncation: { truncated: candidates.length > limit, totalAvailable: candidates.length } };
  const target = candidates[0]!;
  const matches = index.lookup('renamed', target.renamed).filter(fn => args.snippet !== undefined || fn.id !== target.id)
    .map(fn => ({ ...site(fn), kind: fn.exact === target.exact ? 'exact' as const : 'renamed' as const, score: 1 }));
  const near = index.near(target).map(({ member, score }) => ({ ...site(member), kind: 'near' as const, score }));
  const ranked: ReuseMatch[] = [...matches, ...near].sort(matchOrder);
  return { ...metadata, status: 'ok' as const, target: args.snippet !== undefined ? null : site(target),
    matches: ranked.slice(0, limit), truncation: { truncated: ranked.length > limit, totalAvailable: ranked.length } };
}

/** Existing push inventory supplies default candidates, never a freshness claim.
 * Explicit directories are bounded; an overflow fails closed instead of returning
 * a filesystem-order-dependent subset. Every captured source is rechecked.
 */
export async function reuseGraphQuery(rootPath: string, args: ReuseGraphArgs, signal?: AbortSignal,
  semanticProvider?: SemanticReuseProvider) {
  const paths = args.paths?.length ? args.paths : args.file_path ? [args.file_path] : undefined;
  const coverage = { basis: paths ? 'bounded-current-source' : 'push-inventory-current-source',
    sourceCompleteness: 'lower-bound', near: 'bounded-lsh-candidates', semantic: 'unknown' };
  try {
    signal?.throwIfAborted();
    const root = await realpath(rootPath);
    const inside = (path: string) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); };
    const safePath = (path: string) => {
      if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(part => part === '..' || part === ''))
        throw new Error('Reuse queries require repository-relative paths');
    };
    const files = new Set<string>();
    if (paths) {
      if (paths.length > 50) throw new Error('Reuse queries accept at most 50 paths');
      for (const path of [...paths].sort()) {
        signal?.throwIfAborted(); safePath(path);
        const absolute = await realpath(join(root, path));
        if (!inside(absolute)) throw new Error('Reuse source escapes the registered repository');
        if ((await stat(absolute)).isDirectory()) {
          const stream = fg.stream('**/*.{ts,tsx}', { cwd: absolute, onlyFiles: true, followSymbolicLinks: false,
            ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/coverage/**'], deep: 8 });
          for await (const match of stream) {
            signal?.throwIfAborted();
            files.add(relative(root, join(absolute, String(match))).replaceAll('\\', '/'));
            if (files.size > MAX_FILES) throw new Error('Reuse query exceeds 200-file budget; narrow paths');
          }
        } else files.add(relative(root, absolute).replaceAll('\\', '/'));
      }
    } else {
      const snapshot = peekPushSnapshot('papercusp');
      if (!snapshot) throw new Error('Push inventory unavailable; supply bounded paths');
      for (const path of snapshot.hashes.keys()) if (/\.tsx?$/.test(path)) { safePath(path); files.add(path); }
    }
    if (files.size > MAX_FILES) throw new Error('Reuse query exceeds 200-file budget; narrow paths');
    const sources = new Map<string, string>();
    const hashes: { path: string; sha256: string }[] = [];
    let bytes = 0;
    const captureSource = async (path: string) => {
      if (sources.has(path)) return sources.get(path)!;
      safePath(path);
      if (sources.size >= MAX_FILES) throw new Error('Reuse query exceeds 200-file budget; narrow paths');
      signal?.throwIfAborted();
      const absolute = await realpath(join(root, path));
      if (!inside(absolute)) throw new Error('Reuse source escapes the registered repository');
      const size = (await stat(absolute)).size;
      if (size > CLONE_MAX_SOURCE_BYTES || bytes + size > MAX_BYTES) throw new Error('Reuse source byte budget exceeded; narrow paths');
      const source = await readFile(absolute, { encoding: 'utf8', signal });
      bytes += Buffer.byteLength(source);
      if (Buffer.byteLength(source) > CLONE_MAX_SOURCE_BYTES || bytes > MAX_BYTES) throw new Error('Reuse source grew beyond byte budget');
      sources.set(path, source); hashes.push({ path, sha256: digest(source) });
      return source;
    };
    for (const path of [...files].sort()) await captureSource(path);
    const index = buildCloneIndex([...sources].map(([path, source]) => ({ path, source })));
    const answer = queryCloneIndex(index, args, sources);
    let integrated: { matches: ReuseMatch[]; semantic: SemanticResult; calibration: Record<string, unknown>;
      truncation: { truncated: boolean; totalAvailable: number }; coverage: typeof coverage } | undefined;
    if (args.op === 'similar' && answer.status === 'ok' && 'target' in answer && semanticProvider) {
      let semantic: SemanticResult;
      let additions: ReuseMatch[] = [];
      try {
        semantic = await semanticProvider({ ...args, limit: 10,
          ...(answer.target ? { file_path: answer.target.path, line1: answer.target.line1 } : {}) }, signal);
        if (semantic.status !== 'ok' || semantic.vectorStatus !== 'measured' || semantic.relevanceStatus !== 'measured'
          || semantic.calibration.status !== 'measured-within-profile' || semantic.relevanceMethod !== SEMANTIC_HYBRID_MODEL.id
          || semantic.relevanceCutoff !== SEMANTIC_RELEVANCE_CUTOFF) {
          throw new Error('Calibrated semantic provider unavailable for this profile');
        }
        if (semantic.matches.length > 10) throw new Error('Semantic provider exceeds ten-candidate budget');
        // Re-resolve every site from current source, including signatures. Never
        // turn a vector row, a stale blob or an inferred location into a site.
        const cloneMatches = queryCloneIndex(index, { ...args, limit: MAX_RESULTS }, sources);
        if (cloneMatches.status !== 'ok' || !('target' in cloneMatches)) throw new Error('Clone target unavailable');
        const known = new Set((cloneMatches.matches ?? []).map(row => row.id));
        if (answer.target) known.add(answer.target.id);
        for (const row of semantic.matches) {
          if (!Number.isFinite(row.relevanceScore) || row.relevanceScore! < SEMANTIC_RELEVANCE_CUTOFF
            || row.relevanceScore! > 1 || !Number.isFinite(row.rankScore)
            || !Number.isFinite(row.cosineSimilarity) || Math.abs(row.cosineSimilarity!) > 1.00001
            || !Number.isFinite(row.crossEncoderRelevance) || row.crossEncoderRelevance! < 0
            || row.crossEncoderRelevance! > 1) throw new Error('Invalid calibrated semantic score');
          const source = await captureSource(row.path);
          if (cloneBlobSha(source) !== row.blobSha) throw new Error(`Semantic source changed: ${row.path}`);
          const fn = extractCloneFile({ path: row.path, source }, 1).functions.find(fn => fn.id === row.id
            && fn.line === row.line && fn.column === row.column && fn.name === row.name);
          if (!fn || Object.values(fn.classification).some(Boolean)) throw new Error(`Semantic site unavailable: ${row.path}`);
          if (known.has(fn.id) || cloneMatches.truncation?.truncated) continue;
          known.add(fn.id);
          additions.push({ ...site(fn), kind: 'semantic', score: row.relevanceScore!, candidateOnly: true,
            scoreMethod: semantic.relevanceMethod, cosineSimilarity: row.cosineSimilarity,
            rankScore: row.rankScore, crossEncoderRelevance: row.crossEncoderRelevance });
        }
      } catch (error) {
        additions = [];
        semantic = { status: 'unknown', matches: [], kind: 'semantic', candidateOnly: true,
          error: error instanceof Error ? error.message : String(error) };
      }
      const matches = [...(answer.matches ?? []), ...additions].sort(matchOrder);
      integrated = { matches: matches.slice(0, answer.limit), semantic,
        calibration: { ...calibration, semantic: semantic.status === 'ok' ? {
          ...semantic.calibration, threshold: semantic.relevanceCutoff,
          scoreMeaning: 'calibrated hybrid relevance within profile, not probability or duplicate equivalence',
        } : { status: 'unknown', reason: semantic.error } },
        coverage: { ...coverage, semantic: semantic.status === 'ok' ? 'bounded-index-lower-bound' : 'unknown' },
        truncation: { truncated: !!answer.truncation?.truncated || matches.length > answer.limit
          || semantic.status === 'ok' && semantic.truncation.truncated,
          totalAvailable: (answer.truncation?.totalAvailable ?? 0) + additions.length } };
    }
    for (const source of hashes) {
      signal?.throwIfAborted();
      const absolute = await realpath(join(root, source.path));
      if (!inside(absolute) || digest(await readFile(absolute, { signal })) !== source.sha256)
        throw new Error(`Reuse source changed during capture: ${source.path}`);
    }
    hashes.sort((a, b) => compare(a.path, b.path));
    return { ...answer, coverage, ...integrated, freshness: { status: 'captured', staleVsDisk: false },
      sourceFingerprint: digest(JSON.stringify(hashes)), sourceFiles: hashes };
  } catch (error) {
    return { status: 'unknown' as const, error: error instanceof Error ? error.message : String(error),
      matches: [], families: [], coverage, freshness: { status: 'unknown', staleVsDisk: null }, calibration };
  }
}
