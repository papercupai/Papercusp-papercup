/** P012 adapters at the existing graph query and capped advisory seams. */
import { getOrgPg } from '@papercusp/db-org';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { cloneBlobSha, extractCloneFile, type CloneIndex } from './clone-index';
import { extractSemanticFunctions, SemanticCodeIndex, semanticRepositoryId, type SemanticCodeEmbedder } from './semantic-code';
import { judgeSemanticPair, summarizeSemanticFunction, SEMANTIC_SUMMARY_VERSION, type SemanticJudgment, type SemanticPair, type SemanticJudgeCall } from './semantic-code-judge';
import type { ReuseBriefProvider, ReuseProviderContext } from './reuse-brief-providers';
import type { Sql } from 'postgres';
import { CODEX_LLM_DEFAULT_MODEL } from '../llm-testing/codex-model-pricing';
import { SEMANTIC_HYBRID_MODEL, hybridFeatures, hybridRelevance } from './semantic-code-calibration';
import { scoreSemanticRelevance } from './semantic-code-relevance';

export function semanticHybridEnvironmentMatches(profile: string, dimensions: number, health: unknown): boolean {
  const row = health as { runtime?: string; rerankExecution?: { device?: string; dtype?: string } } | null;
  return profile === SEMANTIC_HYBRID_MODEL.profile && dimensions === SEMANTIC_HYBRID_MODEL.dimensions
    && row?.runtime === SEMANTIC_HYBRID_MODEL.runtime && row?.rerankExecution?.device === SEMANTIC_HYBRID_MODEL.device
    && row?.rerankExecution?.dtype === SEMANTIC_HYBRID_MODEL.dtype;
}

/** Both existing resolvers use the shared governed, sidecar-first embedding
 * path. Matching dimensions alone does not establish matching vector spaces. */
export async function openSemanticCodeIndex(root: string, workspaceId: string, sql: Sql = getOrgPg().sql,
  options: { background?: boolean; summaryModel?: string;
    /** Explicit off-hook receipt replay only. Every cached summary is bound
     * to the currently extracted path/blob, never a query or relevance label. */
    retainedSummaries?: readonly { path: string; blobSha: string; summary: string }[] } = {}) {
  if (options.retainedSummaries && (!options.background || options.retainedSummaries.length > 1000)) {
    throw new Error('Retained summaries require bounded off-hook replay');
  }
  const [{ resolveBackfillEmbedder }, { buildQueryEmbedderResolved }] = await Promise.all([
    import('../search/embed-backfill'), import('../agent-tools/search/embedder'),
  ]);
  const [document, query] = await Promise.all([
    resolveBackfillEmbedder(), buildQueryEmbedderResolved(options.background
      ? undefined : { acquireBudgetMs: 500, skipAcquisitionWhenCold: true }),
  ]);
  if (document.mode === 'disabled' || !query || document.profile.profileId !== query.profile.profileId
    || document.dims !== query.dims) throw new Error('Semantic document/query embedding profile unavailable or incompatible');
  const embedder: SemanticCodeEmbedder = { profile: document.profile.profileId, dimensions: document.dims,
    document: document.embed, query: query.embed, summaryVersion: SEMANTIC_SUMMARY_VERSION,
    relevance: { id: SEMANTIC_HYBRID_MODEL.id, async score(text, candidates, signal) {
      signal?.throwIfAborted();
      if (document.profile.profileId !== SEMANTIC_HYBRID_MODEL.profile || document.dims !== SEMANTIC_HYBRID_MODEL.dimensions) {
        throw new Error('Semantic hybrid calibration is unknown for this embedding profile');
      }
      const [{ buildSidecarAwareReranker, resolveProcessSidecarUrl }, { probeSidecarHealth }] = await Promise.all([
        import('../memory/embed-sidecar-wiring'), import('../memory/embed-sidecar-spawn'),
      ]);
      const scorer = await buildSidecarAwareReranker('rerank');
      const url = await resolveProcessSidecarUrl();
      const health = url ? await probeSidecarHealth(url) as { runtime?: string;
        rerankExecution?: { device?: string; dtype?: string } } | null : null;
      if (!semanticHybridEnvironmentMatches(document.profile.profileId, document.dims, health)) {
        throw new Error('Semantic hybrid calibration is unknown for this scorer runtime/device/dtype');
      }
      const result = await scoreSemanticRelevance(text, candidates.map(row => {
        if (row.cosineSimilarity === null) throw new Error('Semantic hybrid candidate has no vector measurement');
        return { ...row, cosineSimilarity: row.cosineSimilarity };
      }), scorer);
      signal?.throwIfAborted();
      if (result.status !== 'measured') throw new Error(result.error ?? 'Semantic relevance unknown');
      if (!semanticHybridEnvironmentMatches(document.profile.profileId, document.dims, url ? await probeSidecarHealth(url) : null)) {
        throw new Error('Semantic scorer environment changed during relevance inference');
      }
      const features = hybridFeatures(result.scored.map(row => row.cosineSimilarity), result.scored.map(row => row.relevanceScore));
      return result.scored.map((row, i) => ({ crossEncoderRelevance: row.relevanceScore,
        relevanceScore: hybridRelevance(SEMANTIC_HYBRID_MODEL.weights, features[i]!) }));
    } },
    summarize: async (fn, signal) => {
      if (options.retainedSummaries) {
        const cached = options.retainedSummaries.filter(row => row.path === fn.path && row.blobSha === fn.blobSha);
        if (cached.length !== 1) throw new Error('Exact retained semantic summary unavailable or ambiguous');
        return cached[0]!.summary;
      }
      const model = options.summaryModel ?? (await import('../agent-config')).readAgentConfig().then(config =>
        config.models['semantic-code-summary'] ?? config.models['llm-testing-judge'] ?? CODEX_LLM_DEFAULT_MODEL);
      return summarizeSemanticFunction(fn, { model: await model,
        harness: process.env.PAPERCUSP_HARNESS_SLUG ?? workspaceId, signal });
    } };
  return new SemanticCodeIndex(sql,
    { workspaceId, repositoryId: await semanticRepositoryId(root), profile: embedder.profile, dimensions: embedder.dimensions }, embedder);
}
export type SemanticCodeOpener = typeof openSemanticCodeIndex;
export async function semanticConceptQuery(root: string, workspaceId: string | undefined, query: string,
  options: { limit?: number; paths?: string[]; graphIds?: string[]; signal?: AbortSignal; diagnostics?: boolean } = {},
  open: SemanticCodeOpener = openSemanticCodeIndex) {
  try {
    if (!workspaceId) throw new Error('Semantic query requires an authorized workspace');
    return { status: 'ok' as const, ...await (await open(root, workspaceId)).search(root, query, options) };
  } catch (error) {
    return { status: 'unknown' as const, matches: [], vectorStatus: 'unknown' as const, relevanceStatus: 'unknown' as const,
      error: error instanceof Error ? error.message : String(error), indexVersion: null,
      completeness: 'bounded-index-lower-bound' as const };
  }
}

/** Called only by off-hook index refresh/sweep work; a query never launches
 * a repository scan or performs document inference. Failed files stay unknown. */
export async function refreshSemanticCode(root: string, workspaceId: string, paths: readonly string[],
  signal?: AbortSignal, open: SemanticCodeOpener = openSemanticCodeIndex) {
  if (!paths.length || paths.length > 10_000) throw new Error('Semantic refresh requires a bounded 1–10000-file manifest');
  const index = await open(root, workspaceId);
  const outcomes: { path: string; status: 'ready' | 'unknown'; changed?: boolean; reason?: string }[] = [];
  for (const path of [...new Set(paths)].sort()) {
    signal?.throwIfAborted();
    try { outcomes.push({ path, ...await index.updateFile(root, path, signal) }); }
    catch (error) { outcomes.push({ path, status: 'unknown', reason: error instanceof Error ? error.message : String(error) }); }
  }
  return { outcomes, profile: index.space.profile,
    complete: outcomes.every(row => row.status === 'ready'), basis: 'declared-file-manifest' as const };
}

/** One bounded producer used by the existing managed sweep. All inference is
 * off-hook. Bounds are disclosed; no truncated scan claims repo completeness. */
export async function collectSemanticSweepCandidates(root: string, clones: CloneIndex, store: SemanticCodeIndex,
  options: { model: string; harness: string; maxPairs: number; maxFiles: number; signal?: AbortSignal; call?: SemanticJudgeCall }) {
  const candidates: { pair: SemanticPair; judgment: SemanticJudgment }[] = [];
  if (!Number.isInteger(options.maxFiles) || options.maxFiles < 1 || options.maxFiles > 10000
    || !Number.isInteger(options.maxPairs) || options.maxPairs < 1 || options.maxPairs > 100) throw new Error('Unbounded semantic sweep');
  const files = clones.getFiles().filter(file => file.status === 'indexed'
    && file.functions.some(fn => !Object.values(fn.classification).some(Boolean)));
  const selected = files.slice(0, options.maxFiles), seen = new Set<string>();
  const functions = [];
  for (const file of selected) {
    options.signal?.throwIfAborted();
    try {
      await store.updateFile(root, file.path, options.signal);
      functions.push(...extractSemanticFunctions({ path: file.path, source: await readFile(join(root, file.path), 'utf8') }));
    } catch (error) {
      return { status: 'unknown' as const, candidates: [], examinedPairs: 0, bounded: true,
        reason: error instanceof Error ? error.message : String(error) };
    }
  }
  for (const source of functions) {
    const result = await store.search(root, `${source.summary}\n${source.normalizedBody}`, { limit: 10, signal: options.signal });
    if (result.vectorStatus !== 'measured' || result.relevanceStatus !== 'measured') return { status: 'unknown' as const, candidates: [],
      examinedPairs: seen.size, bounded: true, reason: result.relevanceError ?? result.vectorError ?? 'Semantic retrieval unavailable' };
    for (const target of result.matches) {
      if (target.id === source.id || target.cosineSimilarity === null) continue;
      const ids = [source.id, target.id].sort(), key = JSON.stringify(ids);
      if (seen.has(key)) continue;
      seen.add(key);
      // Strip query-only fields: provenance binds the stable function input.
      const { rankScore: _rank, rankers: _rankers, cosineSimilarity: _similarity,
        relevanceScore: _relevance, crossEncoderRelevance: _crossEncoder, ...fn } = target;
      const pair: SemanticPair = source.id < fn.id ? [source, fn] : [fn, source];
      candidates.push({ pair, judgment: await judgeSemanticPair(pair, options) });
      if (seen.size >= options.maxPairs) return { status: 'ok' as const, candidates, examinedPairs: seen.size,
        bounded: true, reason: 'Declared candidate budget reached; unchecked pairs remain' };
    }
  }
  return { status: 'ok' as const, candidates, examinedPairs: seen.size, bounded: true,
    reason: files.length > selected.length ? 'Declared file budget reached; unchecked files remain' : 'Bounded indexed top10 candidate population' };
}

export async function semanticSimilarQuery(root: string, workspaceId: string | undefined, args: {
  name?: string; file_path?: string; line1?: number; snippet?: string; paths?: string[]; limit?: number;
}, signal?: AbortSignal, open: SemanticCodeOpener = openSemanticCodeIndex) {
  // Preserve the existing ambiguity contract. A bare name cannot guess a source
  // declaration from a different bounded population.
  try {
    let source = args.snippet;
    let targetId: string | undefined;
    if (source === undefined) {
      if (!args.file_path) throw new Error('Semantic similar needs snippet or an unambiguous file_path selector');
      const rootReal = await realpath(root), file = await realpath(join(rootReal, args.file_path));
      const rel = relative(rootReal, file);
      if (isAbsolute(args.file_path) || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Semantic target escapes repository');
      const text = await readFile(file, { encoding: 'utf8', signal });
      const candidates = extractCloneFile({ path: args.file_path, source: text }, 1).functions
        .filter(fn => (!args.name || fn.name === args.name) && (!args.line1 || fn.line === args.line1));
      if (candidates.length !== 1) throw new Error('Semantic target missing or ambiguous');
      const target = candidates[0]!;
      source = text.slice(target.start, target.end); targetId = target.id;
    }
    const result = await semanticConceptQuery(root, workspaceId, source,
      { paths: args.paths, limit: args.limit, signal }, open);
    return { ...result, matches: result.matches.filter(row => row.id !== targetId), kind: 'semantic' as const,
      calibration: { status: result.status === 'ok' && result.relevanceStatus === 'measured'
        && result.relevanceMethod === SEMANTIC_HYBRID_MODEL.id ? 'measured-within-profile' as const : 'unknown' as const,
        method: result.status === 'ok' ? result.relevanceMethod : null, trainingSha256: SEMANTIC_HYBRID_MODEL.trainingSha256,
        reason: 'Hybrid calibration is bounded to its embedding/scorer profile; candidates require independent judge verification before sweep filing' },
      candidateOnly: true, targetBlob: cloneBlobSha(source) };
  } catch (error) {
    return { status: 'unknown' as const, matches: [], kind: 'semantic' as const, candidateOnly: true,
      error: error instanceof Error ? error.message : String(error) };
  }
}

export function semanticCodeProvider(open: SemanticCodeOpener = openSemanticCodeIndex): ReuseBriefProvider {
  return { id: 'semantic', async read(context: Readonly<ReuseProviderContext>, signal) {
    const unknown = { status: 'unknown' as const, lines: [], sourceVersion: context.sourceVersion, indexVersion: null };
    if (!context.repository || context.repository.workspaceId !== context.workspaceId || !context.sourceVersion
      || !context.itemText?.trim() || context.surface === 'completion'
      || context.surface === 'claim' && context.paths.length > 0) return unknown;
    if (context.sourceFiles) {
      const fingerprint = createHash('sha256').update(JSON.stringify(context.sourceFiles.map(row => [row.path, row.sha256]))).digest('hex');
      if (fingerprint !== context.sourceVersion) return unknown;
    }
    const result = await semanticConceptQuery(context.repository.rootPath, context.workspaceId, context.itemText,
      { limit: 3, signal }, open);
    if (result.status !== 'ok' || result.vectorStatus !== 'measured' || result.relevanceStatus !== 'measured' || signal.aborted) return unknown;
    const label = context.surface === 'authoring' ? 'Suggested anchor' : 'Related function (no anchors)';
    return { status: 'measured' as const, sourceVersion: context.sourceVersion, indexVersion: result.indexVersion,
      lines: result.matches.map(row => `${label}, semantic candidate: ${row.path}:${row.line} ${row.name}; verify before reuse`),
      citedPaths: result.matches.map(row => row.path) };
  } };
}
