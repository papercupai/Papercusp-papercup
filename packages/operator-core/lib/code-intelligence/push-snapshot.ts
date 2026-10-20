/** P-034: read the maintained first-party dependency snapshot, never a live compiler. */
import { open, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative } from 'node:path';
import { realpath } from 'node:fs/promises';
import { addAbortSignal, Readable } from 'node:stream';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { chain } from 'stream-chain';
import fun from 'stream-chain/fun.js';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/pick.js';
import { streamValues } from 'stream-json/streamers/stream-values.js';
import { pinModuleState } from '@papercusp/module-singleton';
import { dependencySnapshotPath } from './dependency-snapshot-path';
import { withBoundedTimeout } from '../bounded-timeout';
import { versionedSymbolIdentity, type CodeIntelAnswer, type CodeIntelSourceFile, type SymbolSite } from './contracts';

export const PUSH_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60_000;
const REFRESH_MS = 60_000;
/** Hook-path pushes verify at most this many files inside their tight per-turn budget. */
export const PUSH_PROOF_MAX_SOURCES = 64;
/** Read queries keep their 250 ms wall bound but may verify a widely used symbol's full proof;
 * the producer already caps captured callers per symbol at 500 (P-040). */
export const QUERY_PROOF_MAX_SOURCES = 512;
export const safeSnapshotPath = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 4096 && !value.startsWith('/')
  && !/[\\\r\n\0]/.test(value) && !value.split('/').some(part => part === '..' || part === '.');

export interface PushSnapshot {
  commit: string;
  generatedAt: string;
  generatedMs: number;
  /** Static file imports, not symbol callers or proof of runtime execution. */
  importers: ReadonlyMap<string, readonly string[]>;
  hashes: ReadonlyMap<string, string>;
  symbols?: ReadonlyMap<string, readonly SnapshotSymbol[]>;
  /** Exact captured token positions; never infer a cursor from a name on the same line. */
  cursorSites?: ReadonlyMap<string, readonly { symbol: SnapshotSymbol; column: number; spelling: string }[]>;
}

export interface SnapshotSymbol {
  id: string; name: string; path: string; line: number; column: number; sha256: string;
  signature: string; aliases: string[];
  /** Definition, forwarding modules and callers that underpin the snapshot answer. */
  sources?: { path: string; sha256: string }[];
  callers: { path: string; line: number; column: number; sha256: string; spelling: string; workspace?: string | null }[];
}

function snapshotBuilder() {
  const reverse = new Map<string, Set<string>>();
  const hashes = new Map<string, string>();
  const byName = new Map<string, SnapshotSymbol[]>();
  const cursorSites = new Map<string, { symbol: SnapshotSymbol; column: number; spelling: string }[]>();
  const addEdge = (edge: any) => {
    if (!safeSnapshotPath(edge?.importer) || !safeSnapshotPath(edge?.imported)
      || !/^[a-f0-9]{64}$/i.test(edge.importerSha256 ?? '')) return;
    const consumers = reverse.get(edge.imported) ?? new Set<string>();
    consumers.add(edge.importer); reverse.set(edge.imported, consumers);
    hashes.set(edge.importer, edge.importerSha256);
  };
  const site = (value: any) => safeSnapshotPath(value?.path) && Number.isSafeInteger(value.line) && value.line > 0
    && Number.isSafeInteger(value.column) && value.column > 0 && /^[a-f0-9]{64}$/i.test(value.sha256 ?? '');
  const addSymbol = (row: any) => {
    if (!site(row) || typeof row.id !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(row.name)
      || typeof row.signature !== 'string' || !Array.isArray(row.aliases) || !Array.isArray(row.callers)) return;
    const symbol: SnapshotSymbol = { ...row, signature: row.signature.slice(0, 300),
      sources: Array.isArray(row.sources) && row.sources.length <= 512 && row.sources.every((source: any) =>
        safeSnapshotPath(source?.path) && /^[a-f0-9]{64}$/i.test(source.sha256 ?? '')) ? row.sources : undefined,
      aliases: row.aliases.filter((name: unknown) => typeof name === 'string' && /^[A-Za-z_$][\w$]*$/.test(name)),
      callers: row.callers.filter((caller: any) => site(caller) && typeof caller.spelling === 'string').slice(0, 500) };
    for (const name of new Set([symbol.name, ...symbol.aliases])) {
      const rows = byName.get(name) ?? []; rows.push(symbol); byName.set(name, rows);
    }
    for (const location of [{ ...symbol, spelling: symbol.name }, ...symbol.callers]) {
      const key = `${location.path}:${location.line}`;
      const rows = cursorSites.get(key) ?? [];
      rows.push({ symbol, column: location.column, spelling: location.spelling });
      cursorSites.set(key, rows);
    }
  };
  return { reverse, hashes, byName, cursorSites, addEdge, addSymbol };
}

function snapshotHeader(raw: any, now: number): { commit: string; generatedAt: string; generatedMs: number } | null {
  if (raw?.schema !== 'graph-dependency-snapshot-v1' || raw.index?.backend !== 'first-party-imports'
    || !/^[a-f0-9]{40,64}$/i.test(raw.index?.lastCommit ?? '') || !Array.isArray(raw.edges)) return null;
  const generatedMs = Date.parse(raw.generatedAt);
  if (!Number.isFinite(generatedMs) || now - generatedMs > PUSH_SNAPSHOT_MAX_AGE_MS || generatedMs - now > 300_000) return null;
  return { commit: raw.index.lastCommit, generatedAt: raw.generatedAt, generatedMs };
}

/** Small in-memory fixtures only; the serving loader below never parses a whole document. */
export function parsePushSnapshot(text: string, now = Date.now()): PushSnapshot | null {
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  const header = snapshotHeader(raw, now);
  if (!header) return null;
  const builder = snapshotBuilder();
  for (const edge of raw.edges) builder.addEdge(edge);
  if (!builder.reverse.size) return null;
  if (raw.symbols?.schema === 'code-intel-symbol-snapshot-v1' && raw.symbols.knowledge === 'syntax-bound'
    && Array.isArray(raw.symbols.symbols)) {
    for (const row of raw.symbols.symbols) builder.addSymbol(row);
  }
  return { ...header, importers: new Map([...builder.reverse].map(([path, paths]) => [path, [...paths].sort()])),
    hashes: builder.hashes, symbols: builder.byName, cursorSites: builder.cursorSites };
}

/** Row-wise assembly and bounded input chunks keep parsing AND indexing cooperative.
 * Only publish after EOF validates the complete JSON and metadata; partial/corrupt loads
 * never escape. Reuses the maintained stream-json parser rather than JSON.parse.
 */
export async function parsePushSnapshotStream(input: AsyncIterable<string>, now = Date.now(), signal?: AbortSignal): Promise<PushSnapshot | null> {
  const builder = snapshotBuilder();
  const metadata: any = {};
  let selected = '';
  let sawSymbols = false;
  let sliceStarted = performance.now();
  const cooperate = async () => {
    if (performance.now() - sliceStarted >= 4) {
      await yieldToLoop();
      sliceStarted = performance.now();
    }
  };
  async function* chunks() {
    for await (const chunk of input) {
      for (let offset = 0; offset < chunk.length; offset += 8192) {
        signal?.throwIfAborted();
        yield chunk.slice(offset, offset + 8192);
        await cooperate();
      }
    }
  }
  const pipeline = chain([
    Readable.from(chunks()),
    // Fuse synchronous token stages per bounded chunk. The default chain/gen
    // composition awaits each token; fun avoids millions of microtask hops.
    fun(
    parser({ streamValues: false }),
    pick({ filter: (path, token) => {
      const key = path.join('.');
      if (key === 'edges') metadata.edges = token?.name === 'startArray' ? [] : null;
      if (key === 'symbols.symbols') sawSymbols = token?.name === 'startArray';
      if (/^(schema|generatedAt|index|symbols\.schema|symbols\.knowledge|edges\.\d+|symbols\.symbols\.\d+)$/.test(key)) {
        selected = key;
        return true;
      }
      return false;
    } }),
    streamValues(),
    // Keep tagging synchronous with pick; async iteration may buffer multiple rows.
    (item: { value: unknown }) => ({ key: selected, value: item.value }),
    ),
  ]);
  if (signal) addAbortSignal(signal, pipeline);
  try {
    for await (const { key, value } of pipeline) {
      if (key.startsWith('edges.')) builder.addEdge(value);
      else if (key.startsWith('symbols.symbols.')) builder.addSymbol(value);
      else metadata[key] = value;
      await cooperate();
    }
    const header = snapshotHeader(metadata, now);
    if (!header || !builder.reverse.size) return null;
    if (!sawSymbols || metadata['symbols.schema'] !== 'code-intel-symbol-snapshot-v1'
      || metadata['symbols.knowledge'] !== 'syntax-bound') { builder.byName.clear(); builder.cursorSites.clear(); }
    const importers = new Map<string, string[]>();
    for (const [path, paths] of builder.reverse) {
      signal?.throwIfAborted();
      importers.set(path, [...paths].sort());
      await cooperate();
    }
    return { ...header, importers, hashes: builder.hashes, symbols: builder.byName, cursorSites: builder.cursorSites };
  } catch {
    return null;
  } finally {
    pipeline.destroy();
  }
}

/** Bounded content checks, never a compiler or a synchronous read on the hook path.
 * A large proof, changed forwarding module or unreadable source suppresses the answer.
 */
export async function corroboratePushSources(root: string | undefined,
  sources: readonly { path: string; sha256: string }[], signal: AbortSignal,
  maxSources = PUSH_PROOF_MAX_SOURCES): Promise<boolean> {
  if (!root || !sources.length || sources.length > maxSources || signal.aborted) return false;
  let cursor = 0;
  let valid = true;
  await Promise.all(Array.from({ length: Math.min(8, sources.length) }, async () => {
    while (valid && !signal.aborted && cursor < sources.length) {
      const source = sources[cursor++]!;
      if (!safeSnapshotPath(source.path)) { valid = false; break; }
      try {
        const file = join(root, source.path);
        if ((await stat(file)).size > 2_000_000) { valid = false; break; }
        const bytes = await readFile(file, { signal });
        valid &&= createHash('sha256').update(bytes).digest('hex') === source.sha256;
      } catch { valid = false; }
    }
  }));
  return valid && !signal.aborted;
}

type Entry = { snapshot: PushSnapshot | null; checkedAt: number; loading: Promise<void> | null; fileIdentity: string | null };
const state = pinModuleState('@papercusp/operator-core.code-intel-push-snapshots', () => ({ entries: new Map<string, Entry>() }));

/** Identity of the opened snapshot file. The producer replaces it by atomic rename, so a
 * regeneration always changes the inode; an in-place rewrite changes size or mtime. */
const snapshotFileIdentity = (st: { dev: number; ino: number; size: number; mtimeMs: number }) =>
  `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;

/** Re-read the snapshot only when the file changed. The serving file is ~185 MB, so an
 * unconditional re-parse every REFRESH_MS kept a full stream parse running whenever
 * queries arrived (WI-6554700010018175). The warm snapshot keeps serving meanwhile. */
async function refreshPushSnapshot(entry: Entry, path: string): Promise<void> {
  const handle = await open(path, 'r');
  let streaming = false;
  try {
    const identity = snapshotFileIdentity(await handle.stat());
    if (entry.snapshot && entry.fileIdentity === identity) return;
    // The stream owns the handle from here (autoClose on end, error or destroy).
    const stream = handle.createReadStream({ encoding: 'utf8', highWaterMark: 8192 });
    streaming = true;
    const snapshot = await parsePushSnapshotStream(stream);
    entry.snapshot = snapshot;
    entry.fileIdentity = snapshot ? identity : null;
  } finally {
    if (!streaming) await handle.close().catch(() => {});
  }
}

/** Cold reads return immediately. One async load per repository; no timer or polling service. */
export function peekPushSnapshot(repo: string, now = Date.now()): PushSnapshot | null {
  let entry = state.entries.get(repo);
  if (!entry) {
    if (state.entries.size >= 8) state.entries.delete(state.entries.keys().next().value!);
    entry = { snapshot: null, checkedAt: -Infinity, loading: null, fileIdentity: null }; state.entries.set(repo, entry);
  }
  if (!entry.loading && now - entry.checkedAt >= REFRESH_MS) {
    entry.checkedAt = now;
    const current = entry;
    current.loading = refreshPushSnapshot(current, dependencySnapshotPath(repo))
      .catch(error => { current.snapshot = null; current.fileIdentity = null; if (error?.code !== 'ENOENT') console.warn('[code-intel-push] snapshot unavailable:', String(error).slice(0, 200)); })
      .finally(() => { current.loading = null; });
  }
  return entry.snapshot && now - entry.snapshot.generatedMs <= PUSH_SNAPSHOT_MAX_AGE_MS ? entry.snapshot : null;
}

/** Reuse the push index for positive read queries. A miss is a compiler fallback,
 * never evidence of absence. Registry/root checks and source corroboration share
 * one wall budget; a cold index starts its existing cooperative loader only.
 */
export async function queryPushSnapshot(query: {
  op: 'definition' | 'callers'; root: string; workspaceId?: string;
  name?: string; file?: string; line1?: number; character?: number; paths?: string[]; limit?: number;
}): Promise<CodeIntelAnswer | null> {
  const started = Date.now();
  const result = await withBoundedTimeout<CodeIntelAnswer | null>(async signal => {
    const [{ loadHarnessRegistry }, { operatorHomeHarnessSlug }, { activeWorkspaceId }] = await Promise.all([
      import('../harness-registry'), import('../harness/operator-home-harness'), import('../workspace-registry'),
    ]);
    const workspace = activeWorkspaceId();
    if (query.workspaceId && query.workspaceId !== workspace) return null;
    const registry = await loadHarnessRegistry(workspace);
    const project = registry.projects.find(project => project.slug === operatorHomeHarnessSlug() && project.path);
    if (!project) return null;
    const [root, registeredRoot] = await Promise.all([realpath(query.root), realpath(project.path)]);
    if (root !== registeredRoot || signal.aborted) return null;
    const snapshot = peekPushSnapshot('papercusp');
    if (!snapshot?.symbols?.size) return null;
    const paths = query.paths?.length ? query.paths : ['.'];
    if (paths.some(path => path !== '.' && !safeSnapshotPath(path))) return null;
    const inScope = (path: string) => paths.some(scope => scope === '.' || path === scope || path.startsWith(scope.replace(/\/$/, '') + '/'));
    let candidates: readonly SnapshotSymbol[];
    let cursorPath: string | undefined;
    if (query.op === 'definition' && query.file === undefined && query.name) {
      // P-040 (native-code-intelligence-ecosystem-and-dream-2026-10-09): a name-only
      // definition lookup (lsp:query workspace_symbols) is served from the snapshot when
      // exactly one in-scope declaration carries the name or a captured alias. An
      // ambiguous, absent or out-of-scope name returns null so the compiler answers.
      candidates = (snapshot.symbols.get(query.name) ?? []).filter(symbol => inScope(symbol.path));
    } else if (query.op === 'definition') {
      if (!query.file || !Number.isSafeInteger(query.line1) || query.line1! < 1
        || !Number.isSafeInteger(query.character) || query.character! < 0) return null;
      cursorPath = isAbsolute(query.file) ? relative(root, query.file) : query.file;
      if (!safeSnapshotPath(cursorPath)) return null;
      const column = query.character! + 1;
      candidates = (snapshot.cursorSites?.get(`${cursorPath}:${query.line1}`) ?? [])
        .filter(site => column >= site.column && column < site.column + site.spelling.length).map(site => site.symbol);
    } else candidates = snapshot.symbols.get(query.name ?? '') ?? [];
    const unique = [...new Map(candidates.map(symbol => [symbol.id, symbol])).values()];
    if (unique.length !== 1) return null;
    const symbol = unique[0]!;
    if (!symbol.sources?.length) return null;
    const callers = symbol.callers.filter(site => inScope(site.path));
    if (query.op === 'callers' && callers.length === 0) return null;
    const limit = Math.min(500, Math.max(1, query.limit ?? 100));
    const reported = query.op === 'definition' ? [symbol] : callers.slice(0, limit);
    // P-040: a name-only definition that matched the declaration's OWN name rests on the
    // declaration file alone — no caller edit or forwarding module can move it. Requiring
    // every caller file to be unchanged refused those answers whenever any caller anywhere
    // was edited, and always for symbols with more than 64 source files. Alias, cursor and
    // callers answers keep the full forwarding + caller proof.
    const declarationOnly = query.op === 'definition' && !cursorPath && symbol.name === query.name;
    const proofInputs = declarationOnly ? [{ path: symbol.path, sha256: symbol.sha256 }]
      : [...symbol.sources, { path: symbol.path, sha256: symbol.sha256 },
        ...symbol.callers.map(site => ({ path: site.path, sha256: site.sha256 }))];
    const sourceMap = new Map<string, string>();
    for (const source of proofInputs) {
      if (sourceMap.has(source.path) && sourceMap.get(source.path) !== source.sha256) return null;
      sourceMap.set(source.path, source.sha256);
    }
    if (cursorPath && !sourceMap.has(cursorPath)) return null;
    const proof = [...sourceMap].map(([path, sha256]) => ({ path, sha256 }));
    if (!await corroboratePushSources(root, proof, signal, QUERY_PROOF_MAX_SOURCES)) return null;
    const sources: CodeIntelSourceFile[] = proof.sort((a, b) => a.path.localeCompare(b.path)).map(source => ({
      path: source.path, contentHash: source.sha256, representation: 'full-source',
      language: /\.[cm]?jsx?$/.test(source.path) ? 'javascript' : /\.[cm]?tsx?$/.test(source.path) ? 'typescript' : 'json',
    }));
    const repositoryId = `local-root:${createHash('sha256').update(root).digest('hex')}`;
    const sourceByPath = new Map(sources.map(source => [source.path, source]));
    const definition: SymbolSite = { path: symbol.path, line1: symbol.line, kind: null, name: symbol.name, detail: symbol.signature };
    const sites: SymbolSite[] = query.op === 'definition' ? [definition] : reported.map(site => ({
      path: site.path, line1: site.line, kind: null, name: 'spelling' in site ? site.spelling : symbol.name,
      detail: `Syntax-bound call to ${symbol.name}; compiler binding and runtime execution are unmeasured.`,
    }));
    const limitations = [
      'Positive syntax-bound snapshot matches only; compiler binding, dynamic dispatch, shadowed/unresolved calls and current resolver configuration remain unmeasured.',
      declarationOnly
        ? 'The declaration source hash matches current disk; forwarding modules and callers do not affect this answer and were not checked. Other source files and repository-wide completeness are unverified.'
        : 'Definition, forwarding and captured caller source hashes match current disk. Other source files and repository-wide completeness are unverified.',
      'Caller sites are a lower bound; an empty snapshot never establishes absence. Runtime execution is unknown.',
    ];
    const coverage = { basis: 'syntax' as const, sourceCompleteness: 'unverified' as const, limitations };
    return {
      backend: 'first-party-snapshot', intent: query.op, query: query.name ?? `${cursorPath}:${query.line1}:${query.character}`, sites,
      truncation: { truncated: query.op === 'callers' && callers.length > limit, totalAvailable: null, continuation: null },
      freshness: { health: 'healthy', indexedAt: snapshot.generatedAt, indexedCommit: snapshot.commit, staleVsDisk: null },
      coverage, latencyMs: Date.now() - started, error: null,
      evidence: { schemaVersion: 1,
        sourceScope: { repositoryId, identityKind: 'local-root', paths: query.op === 'definition' ? [cursorPath ?? symbol.path] : paths,
          sourceFingerprint: createHash('sha256').update(JSON.stringify(sources)).digest('hex'), supportingFiles: sources },
        graphScope: coverage,
        languageCapabilities: [...new Set(sources.filter(source => source.language !== 'json').map(source => source.language))]
          .map(language => ({ language, intent: query.op, status: 'syntax-only' })),
        siteIdentities: sites.map((site, siteIndex) => ({ siteIndex, sourcePath: site.path,
          contentHash: sourceByPath.get(site.path)!.contentHash,
          versionedSymbolId: versionedSymbolIdentity(repositoryId, site, sourceByPath.get(site.path)) })),
        relationships: sites.map((site, siteIndex) => ({ siteIndex, kind: query.op, origin: 'syntax', knowledge: 'inferred',
          runtimeExecution: 'unknown', ...(query.op === 'callers' ? { binding: 'direct', target: {
            site: definition, contentHash: symbol.sha256,
            versionedSymbolId: versionedSymbolIdentity(repositoryId, definition, sourceByPath.get(symbol.path)),
          } } : {}) })),
      },
    };
  }, { fallback: null, timeoutMs: 250, label: 'code-intel-snapshot-query',
    // A snapshot miss or slow registry read is an expected best-effort fallback
    // to the compiler path. The fallback ledger remains the machine-readable
    // signal; console warnings make valid unsupported/temporary fixture roots
    // fail under vitest-fail-on-console.
    warn: false });
  return result.value;
}
