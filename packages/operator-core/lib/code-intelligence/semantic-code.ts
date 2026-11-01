/** P012: incremental, off-hook pgvector function index. No scheduler or second query tool. */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type { Sql } from 'postgres';
import * as ts from 'typescript';
import { rrfCombine } from '../../../../libs/generic/rrf/src/index';
import { cloneBlobSha, extractCloneFile, type CloneSource } from './clone-index';
import { storedTsvectorLexicalLeg } from '../search/lexical/rank';

export const SEMANTIC_CODE_VERSION = `semantic-code-v2:typescript-${ts.version}`;
/** Preregistered floor in the identified scorer's relevance units. The
 * controlled legacy adapter uses cosine; production uses calibrated hybrid. */
export const SEMANTIC_RELEVANCE_CUTOFF = .70;
export interface SemanticCodeSpace {
  workspaceId: string;
  repositoryId: string;
  profile: string;
  dimensions: number;
}
export interface SemanticCodeEmbedder {
  profile: string;
  dimensions: number;
  document(text: string, signal?: AbortSignal): Promise<number[]>;
  query(text: string, signal?: AbortSignal): Promise<number[]>;
  summarize?(fn: SemanticCodeFunction, signal?: AbortSignal): Promise<string>;
  summaryVersion?: string;
  relevance?: { id: string; score(query: string, candidates: readonly SemanticCodeMatch[], signal?: AbortSignal):
    Promise<readonly { relevanceScore: number; crossEncoderRelevance: number }[]> };
}
export interface SemanticCodeFunction {
  id: string; path: string; blobSha: string; name: string; line: number; column: number;
  summary: string; normalizedBody: string;
}
export interface SemanticCodeMatch extends SemanticCodeFunction {
  /** RRF is a rank score, never a calibrated probability or a duplicate verdict. */
  rankScore: number;
  rankers: string[];
  cosineSimilarity: number | null;
  relevanceScore?: number;
  crossEncoderRelevance?: number;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const vector = (values: readonly number[], dimensions: number) => {
  if (values.length !== dimensions || !values.every(Number.isFinite) || !values.some(n => n !== 0)) {
    throw new Error('Semantic vector is non-finite, zero, or from a different dimension');
  }
  return `[${values.join(',')}]`;
};
const checkedRelativePath = (path: string) => {
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(x => !x || x === '.' || x === '..')) {
    throw new Error('Semantic source path must be repository-relative POSIX');
  }
  return path;
};

/** Existing compiler extractor supplies stable identity and exclusions. Printer
 * normalization removes trivia but retains identifiers/literals for the embedder. */
export function extractSemanticFunctions(input: CloneSource): SemanticCodeFunction[] {
  const file = extractCloneFile(input, 1);
  if (file.status !== 'indexed') throw new Error(`Semantic source ${file.status}: ${input.path}`);
  const tree = ts.createSourceFile(input.path, input.source, ts.ScriptTarget.Latest, true,
    input.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const bodies = new Map<number, ts.Node>();
  const visit = (node: ts.Node) => {
    if ('body' in node && node.body && typeof node.body === 'object' && 'kind' in node.body
      && ts.isBlock(node.body as ts.Node)) bodies.set(node.getStart(tree), node.body as ts.Node);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  return file.functions.filter(fn => !Object.values(fn.classification).some(Boolean)).map(fn => {
    const body = bodies.get(fn.start);
    if (!body) throw new Error(`Semantic body identity missing: ${fn.id}`);
    const normalizedBody = printer.printNode(ts.EmitHint.Unspecified, body, tree);
    if (normalizedBody.length > 12_000) throw new Error(`Semantic function exceeds embedding input budget: ${fn.id}`);
    return { id: fn.id, path: fn.path, blobSha: fn.blobSha, name: fn.name, line: fn.line,
      column: fn.column, summary: `${fn.name}: ${fn.signature}`, normalizedBody };
  });
}

/** Scope includes the canonical root, preventing two checkouts with equal paths
 * from reading/writing one another's vectors. */
export async function semanticRepositoryId(rootPath: string): Promise<string> {
  return `local-root:${hash(await realpath(rootPath))}`;
}
export class SemanticCodeIndex {
  readonly space: Readonly<SemanticCodeSpace>;
  readonly normalizationVersion: string;
  constructor(private readonly sql: Sql, space: SemanticCodeSpace, private readonly embedder: SemanticCodeEmbedder) {
    if (![space.workspaceId, space.repositoryId, space.profile].every(s => s.trim())
      || !Number.isSafeInteger(space.dimensions) || space.dimensions < 1
      || space.profile !== embedder.profile || space.dimensions !== embedder.dimensions) {
      throw new Error('Semantic index requires one exact workspace/repository/embedding profile');
    }
    this.space = Object.freeze({ ...space });
    this.normalizationVersion = `${SEMANTIC_CODE_VERSION}:${embedder.summaryVersion ?? 'controlled-signature-fixture'}`;
  }
  private async source(rootPath: string, path: string, signal?: AbortSignal): Promise<CloneSource> {
    checkedRelativePath(path);
    const root = await realpath(rootPath), absolute = await realpath(join(root, path));
    const rel = relative(root, absolute);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Semantic source escapes repository');
    const metadata = await stat(absolute);
    if (!metadata.isFile() || metadata.size > 1_500_000) throw new Error('Semantic source exceeds byte budget or is not a file');
    const source = await readFile(absolute, { encoding: 'utf8', signal });
    if (Buffer.byteLength(source) > 1_500_000) throw new Error('Semantic source exceeds byte budget');
    return { path, source, blobSha: cloneBlobSha(source) };
  }
  private async assertRoot(root: string) {
    if (await semanticRepositoryId(root) !== this.space.repositoryId) throw new Error('Semantic repository identity mismatch');
  }
  /** Invalidate old vectors BEFORE inference. An outage cannot leave stale rows
   * looking current. A failed parse/vector/source recheck leaves a failed marker. */
  async updateFile(root: string, path: string, signal?: AbortSignal) {
    await this.assertRoot(root);
    checkedRelativePath(path);
    const s = this.space;
    let input: CloneSource;
    try { input = await this.source(root, path, signal); }
    catch (error) {
      await this.removeFile(path);
      throw error;
    }
    const [old] = await this.sql`SELECT blob_sha, state, normalization_version, dimensions
      FROM harness_shared.semantic_code_files WHERE workspace_id=${s.workspaceId}
      AND repository_id=${s.repositoryId} AND embedding_profile=${s.profile} AND path=${path}`;
    if (old?.blob_sha === input.blobSha && old.state === 'ready'
      && old.normalization_version === this.normalizationVersion && old.dimensions === s.dimensions) {
      return { changed: false, blobSha: input.blobSha, status: 'ready' as const };
    }
    // Per-file lock also serializes replacement against a concurrent refresh.
    const lock = `${s.workspaceId}:${s.repositoryId}:${s.profile}:${path}`;
    await this.sql.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
      await tx`DELETE FROM harness_shared.semantic_code_files WHERE workspace_id=${s.workspaceId}
        AND repository_id=${s.repositoryId} AND embedding_profile=${s.profile} AND path=${path}`;
      await tx`INSERT INTO harness_shared.semantic_code_files
        (workspace_id,repository_id,embedding_profile,path,blob_sha,normalization_version,dimensions,state)
        VALUES (${s.workspaceId},${s.repositoryId},${s.profile},${path},${input.blobSha!},${this.normalizationVersion},${s.dimensions},'pending')`;
    });
    try {
      const functions = extractSemanticFunctions(input);
      if (functions.length > 500) throw new Error('Semantic function population exceeds 500-file-body budget');
      const rows: { fn: SemanticCodeFunction; embedding: string }[] = [];
      // Bounded parallel inference, using the injected shared sidecar adapters.
      for (let i = 0; i < functions.length; i += 4) {
        signal?.throwIfAborted();
        rows.push(...await Promise.all(functions.slice(i, i + 4).map(async source => {
          const fn = { ...source, summary: this.embedder.summarize ? await this.embedder.summarize(source, signal) : source.summary };
          if (!fn.summary.trim() || fn.summary.length > 2000 || /[\r\n]/.test(fn.summary)) throw new Error('Invalid semantic document summary');
          return { fn, embedding: vector(await this.embedder.document(`${fn.summary}\n${fn.normalizedBody}`, signal), s.dimensions) };
        })));
      }
      await this.sql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
        const [marker] = await tx`SELECT blob_sha FROM harness_shared.semantic_code_files
          WHERE workspace_id=${s.workspaceId} AND repository_id=${s.repositoryId}
          AND embedding_profile=${s.profile} AND path=${path} FOR UPDATE`;
        if (marker?.blob_sha !== input.blobSha || (await this.source(root, path, signal)).blobSha !== input.blobSha) {
          throw new Error('Semantic source changed during embedding');
        }
        for (const { fn, embedding } of rows) {
          await tx`INSERT INTO harness_shared.semantic_code_functions
            (workspace_id,repository_id,embedding_profile,path,function_id,blob_sha,name,line,column_number,summary,normalized_body,embedding)
            VALUES (${s.workspaceId},${s.repositoryId},${s.profile},${path},${fn.id},${fn.blobSha},${fn.name},${fn.line},${fn.column},
              ${fn.summary},${fn.normalizedBody},${embedding}::vector)
            ON CONFLICT (workspace_id,repository_id,embedding_profile,path,function_id) DO NOTHING`;
        }
        await tx`UPDATE harness_shared.semantic_code_files SET state='ready' WHERE workspace_id=${s.workspaceId}
          AND repository_id=${s.repositoryId} AND embedding_profile=${s.profile} AND path=${path}`;
      });
      return { changed: true, blobSha: input.blobSha, status: 'ready' as const, functions: rows.length };
    } catch (error) {
      await this.sql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
        await tx`UPDATE harness_shared.semantic_code_files SET state='failed' WHERE workspace_id=${s.workspaceId}
          AND repository_id=${s.repositoryId} AND embedding_profile=${s.profile} AND path=${path} AND blob_sha=${input.blobSha!}`;
      });
      throw error;
    }
  }
  async removeFile(path: string) {
    checkedRelativePath(path);
    const s = this.space;
    await this.sql`DELETE FROM harness_shared.semantic_code_files WHERE workspace_id=${s.workspaceId}
      AND repository_id=${s.repositoryId} AND embedding_profile=${s.profile} AND path=${path}`;
  }
  /** Lexical + optional compiler-ranked graph evidence + vector RRF. Every hit
   * is checked against the current file blob; incomplete scope stays explicit. */
  async search(root: string, query: string, options: {
    limit?: number; graphIds?: readonly string[]; paths?: readonly string[]; signal?: AbortSignal;
    /** Maintained off-hook calibration only; never changes eligibility. */
    diagnostics?: boolean;
  } = {}) {
    await this.assertRoot(root);
    if (!query.trim() || query.length > 12_500) throw new Error('Semantic query must contain 1–12500 characters');
    const limit = Math.min(50, Math.max(1, Math.floor(options.limit ?? 10)));
    if (!Number.isFinite(limit)) throw new Error('Semantic result limit must be finite');
    const s = this.space, allowed = options.paths ? [...new Set(options.paths.map(checkedRelativePath))] : null;
    if (allowed && (!allowed.length || allowed.length > 200)) throw new Error('Semantic path scope requires 1–200 files');
    const common = this.sql`workspace_id=${s.workspaceId} AND repository_id=${s.repositoryId}
      AND embedding_profile=${s.profile} AND vector_dims(embedding)=${s.dimensions}
      ${allowed ? this.sql`AND path IN ${this.sql(allowed)}` : this.sql``}
      AND EXISTS (SELECT 1 FROM harness_shared.semantic_code_files marker
        WHERE marker.workspace_id=semantic_code_functions.workspace_id
        AND marker.repository_id=semantic_code_functions.repository_id
        AND marker.embedding_profile=semantic_code_functions.embedding_profile
        AND marker.path=semantic_code_functions.path AND marker.blob_sha=semantic_code_functions.blob_sha
        AND marker.state='ready' AND marker.normalization_version=${this.normalizationVersion})`;
    const lexicalLeg = storedTsvectorLexicalLeg(this.sql, this.sql`search_text`, query, {
      textConfig: 'simple',
      querySyntax: 'plain',
      rankFunction: 'ts_rank',
    });
    const lexical = await this.sql`SELECT * FROM harness_shared.semantic_code_functions WHERE ${common}
      AND ${lexicalLeg.match}
      ORDER BY ${lexicalLeg.order},path,line,column_number LIMIT 100`;
    let semantic: Array<(typeof lexical)[number]> = [], vectorStatus: 'measured' | 'unknown' = 'unknown', vectorError: string | null = null;
    try {
      const embedded = vector(await this.embedder.query(query, options.signal), s.dimensions);
      semantic = await this.sql`SELECT *, 1 - (embedding <=> ${embedded}::vector) AS cosine_similarity
        FROM harness_shared.semantic_code_functions WHERE ${common}
        ORDER BY embedding <=> ${embedded}::vector,path,line,column_number LIMIT 100`;
      vectorStatus = 'measured';
    } catch (error) { vectorError = error instanceof Error ? error.message : String(error); }
    const toFunction = (row: (typeof lexical)[number]): SemanticCodeFunction => ({
      id: row.function_id, path: row.path, blobSha: row.blob_sha, name: row.name, line: row.line,
      column: row.column_number, summary: row.summary, normalizedBody: row.normalized_body,
    });
    const graphIds = [...new Set(options.graphIds ?? [])];
    if (graphIds.length > 200) throw new Error('Semantic graph candidate scope exceeds 200 functions');
    const graphRows = graphIds.length ? await this.sql`SELECT * FROM harness_shared.semantic_code_functions
      WHERE ${common} AND (function_id IN ${this.sql(graphIds)} OR path || ':' || line::text IN ${this.sql(graphIds)})` : [];
    const byId = new Map(graphRows.flatMap(row => [[row.function_id, row], [`${row.path}:${row.line}`, row]]));
    const graph = graphIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
    const eligibleVectors = this.embedder.relevance ? semantic
      : semantic.filter(row => Number(row.cosine_similarity) >= SEMANTIC_RELEVANCE_CUTOFF);
    const lists = [{ name: 'lexical', rows: lexical }, { name: 'graph', rows: graph }, { name: 'vector', rows: eligibleVectors }]
      .map(({ name, rows }) => ({ name, list: rows.map(row => ({ key: row.function_id, score: 0, row: toFunction(row) })) }));
    const stalePaths = new Set<string>(), blobs = new Map<string, string | null>();
    const similarities = new Map(semantic.map(row => [row.function_id, Number(row.cosine_similarity)]));
    let matches: SemanticCodeMatch[] = [];
    for (const hit of rrfCombine(lists)) {
      if (!blobs.has(hit.row.path)) {
        try { blobs.set(hit.row.path, (await this.source(root, hit.row.path, options.signal)).blobSha!); }
        catch { blobs.set(hit.row.path, null); }
      }
      if (blobs.get(hit.row.path) !== hit.row.blobSha) { stalePaths.add(hit.row.path); continue; }
      // On an embedding outage the lexical/graph fallback is explicitly
      // unmeasured; it cannot become a judged semantic duplicate candidate.
      if (!this.embedder.relevance && vectorStatus === 'measured'
        && !(similarities.get(hit.row.id)! >= SEMANTIC_RELEVANCE_CUTOFF)) continue;
      matches.push({ ...hit.row, rankScore: hit.score, rankers: hit.rankers,
        cosineSimilarity: similarities.get(hit.row.id) ?? null });
    }
    matches.sort((a, b) => b.rankScore - a.rankScore || a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
    let relevanceStatus: 'measured' | 'unknown' = vectorStatus, relevanceError = vectorError;
    let scoredCandidates: SemanticCodeMatch[] = [];
    if (this.embedder.relevance && vectorStatus === 'measured') {
      try {
        // Pool selection precedes scoring and is independent of score/label.
        // Calibration always sees ten candidates, even for a three-line brief.
        const pool = matches.filter(row => row.cosineSimilarity !== null).slice(0, 10);
        const scores = pool.length ? await this.embedder.relevance.score(query, pool, options.signal) : [];
        if (scores.length !== pool.length || scores.some(row => !Number.isFinite(row.relevanceScore)
          || row.relevanceScore < 0 || row.relevanceScore > 1 || !Number.isFinite(row.crossEncoderRelevance)
          || row.crossEncoderRelevance < 0 || row.crossEncoderRelevance > 1)) throw new Error('Invalid semantic relevance score population');
        scoredCandidates = pool.map((row, i) => ({ ...row, ...scores[i]! }));
        matches = [];
        // Scoring is inference: re-read current blobs after it completes so a
        // race cannot promote a stale body into a reuse/duplicate suggestion.
        const current = new Map<string, string | null>();
        for (const row of scoredCandidates) {
          if (!current.has(row.path)) {
            try { current.set(row.path, (await this.source(root, row.path, options.signal)).blobSha!); }
            catch { current.set(row.path, null); }
          }
          if (current.get(row.path) !== row.blobSha) { stalePaths.add(row.path); continue; }
          if (row.relevanceScore! >= SEMANTIC_RELEVANCE_CUTOFF) matches.push(row);
        }
      } catch (error) {
        relevanceStatus = 'unknown'; relevanceError = error instanceof Error ? error.message : String(error);
        matches = []; // no scored-looking passthrough and no automatic filing
      }
    }
    const rawTop10: (SemanticCodeFunction & { cosineSimilarity: number; eligible: boolean })[] = [];
    if (options.diagnostics) for (const row of semantic.slice(0, 10)) {
      if (!blobs.has(row.path)) {
        try { blobs.set(row.path, (await this.source(root, row.path, options.signal)).blobSha!); }
        catch { blobs.set(row.path, null); }
      }
      if (blobs.get(row.path) === row.blob_sha) rawTop10.push({ ...toFunction(row),
        cosineSimilarity: Number(row.cosine_similarity), eligible: Number(row.cosine_similarity) >= SEMANTIC_RELEVANCE_CUTOFF });
    }
    return { matches: matches.slice(0, limit), vectorStatus, vectorError, relevanceStatus, relevanceError,
      relevanceMethod: this.embedder.relevance?.id ?? 'legacy-raw-cosine-controlled-adapter', stalePaths: [...stalePaths].sort(),
      indexVersion: `${this.normalizationVersion}:${s.profile}:${this.embedder.relevance?.id ?? 'legacy-cosine'}`,
      completeness: 'bounded-index-lower-bound' as const,
      ranking: 'reciprocal-rank-fusion; not probability; not a duplicate verdict',
      relevanceCutoff: SEMANTIC_RELEVANCE_CUTOFF,
      ...(options.diagnostics ? { diagnostics: { rawTop10, scoredCandidates, basis: 'same-query-unfiltered-vector-order' as const } } : {}),
      truncation: { truncated: matches.length > limit || lexical.length === 100 || semantic.length === 100, totalAvailable: matches.length } };
  }
}
