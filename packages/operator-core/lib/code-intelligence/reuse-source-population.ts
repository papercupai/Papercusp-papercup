/** Pure Git/source collection shared with the finite code-intelligence worker.
 * Keep database, provider registration and operator initialization out of this graph.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { endianness, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { getHeapStatistics } from 'node:v8';
import { CloneIndex } from './clone-index';
import { buildSymbolSnapshot, isSymbolSnapshotSourcePath, parseSymbolSnapshot, relativeSymbolModule } from '../../../../scripts/lib/code-intel-symbol-snapshot.mjs';
import { eligibleHistoryPath } from './history-path';
import type { ReuseMetricPopulation } from './reuse-measurement';

const time = (value: string): number => {
  const n = Date.parse(value);
  if (!Number.isFinite(n)) throw new Error('Valid recorded timestamp required');
  return n;
};
const lowerBound = (values: readonly number[], value: number): number => {
  let low = 0, high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < value) low = middle + 1; else high = middle;
  }
  return low;
};

export type ReuseSourcePhase = 'source-tree' | 'source-capture' | 'source-diff' | 'source-clones' | 'source-calls';

type ParsedSymbols = ReturnType<typeof parseSymbolSnapshot>;
export const REUSE_PARSER_OLD_SPACE_MB = 1024;
export const REUSE_PARENT_OLD_SPACE_MB = 1024;

/** Fixed, finite parser pool inside the already supervised worker process.
 * A partition extracts syntax only; global resolution happens after ordered merge.
 */
export async function parseReuseSourceSymbols(sourceFiles: Map<string, string>, workerPath: string,
  observeLimits?: (limits: Record<string, unknown>) => void,
  capture?: { sizes: ReadonlyMap<string, number>; ready: (files: readonly string[]) => Promise<void> }): Promise<ParsedSymbols> {
  // V8 carries the parent's effective CLI heap flag into new isolates even
  // when execArgv is cleared. Equal 1024 MiB limits keep all three old spaces
  // within the existing 3072 MiB envelope. Young space is separate from it.
  if (!process.execArgv.includes(`--max-old-space-size=${REUSE_PARENT_OLD_SPACE_MB}`)
    || getHeapStatistics().heap_size_limit > (REUSE_PARENT_OLD_SPACE_MB + 192) * 1024 * 1024)
    throw new Error('Source parser parent exceeds its effective heap envelope');
  const files = [...sourceFiles.keys()];
  // Equal identity counts can put an entire large-source cohort on one parser.
  // Bound bytes as well, so a finite worker does not wait for an oversized tail
  // while its other parser has already drained the remaining small files.
  const batches: { files: string[]; bytes: number }[] = [];
  let batch: string[] = [], bytes = 0;
  for (const path of files) {
    const size = capture ? capture.sizes.get(path)! : statSync(sourceFiles.get(path)!).size;
    if (!Number.isSafeInteger(size) || size < 0 || size > 2_000_000)
      throw new Error('Incomplete bounded Git blob population');
    if (batch.length && (batch.length >= 512 || bytes + size > 4 * 1024 * 1024)) {
      batches.push({ files: batch, bytes }); batch = []; bytes = 0;
    }
    batch.push(path); bytes += size;
  }
  if (batch.length) batches.push({ files: batch, bytes });
  const parts: ParsedSymbols[] = [];
  const workers: Worker[] = [];
  const count = batches.length;
  let next = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(2, count) }, async () => {
      const worker = new Worker(workerPath, {
        workerData: { kind: 'reuse-symbol-parse', sourceFiles: [...sourceFiles] },
        // The effective inherited CLI cap equals this isolate's explicit cap.
        // Do not add a larger flag through execArgv or NODE_OPTIONS.
        execArgv: workerPath.endsWith('.ts') ? ['--import', 'tsx'] : [],
        env: { ...process.env, NODE_OPTIONS: '' },
        resourceLimits: { maxOldGenerationSizeMb: REUSE_PARSER_OLD_SPACE_MB, maxYoungGenerationSizeMb: 16 },
      });
      workers.push(worker);
      let pending: { resolve: (value: any) => void; reject: (error: Error) => void } | undefined;
      let failed: Error | undefined;
      const received = () => new Promise<any>((resolve, reject) => {
        if (failed) reject(failed); else pending = { resolve, reject };
      });
      worker.on('message', value => { const waiter = pending; pending = undefined; waiter?.resolve(value); });
      const fail = (error: Error) => { failed = error; pending?.reject(error); pending = undefined; };
      worker.on('error', fail);
      worker.on('exit', code => fail(new Error(`Source parser exited before completion (${code})`)));
      const ready = await received();
      if (ready?.kind !== 'ready' || ready.oldSpaceMb !== REUSE_PARSER_OLD_SPACE_MB
        || ready.heapLimitMb > REUSE_PARSER_OLD_SPACE_MB + 32 || ready.execArgv.some((x: string) => /max[-_]old[-_]space/i.test(x)))
        throw new Error('Source parser effective heap limit unavailable');
      observeLimits?.(ready);
      while (next < count) {
        const index = next++, { files: batch, bytes } = batches[index]!;
        // Import resolution uses the complete identity set, but syntax reads
        // only this partition. Later immutable blobs can still be in flight.
        await capture?.ready(batch);
        const response = received();
        worker.postMessage({ index, files: batch });
        const result = await response;
        if (result?.index !== index || !result.parsed || result.error) throw new Error(result?.error ?? 'Incomplete source parser partition');
        const parsed = result.parsed as ParsedSymbols;
        // Keep the complete source batch and resolver population. The serial
        // parser deliberately ignores maintained exclusions within that batch.
        const eligible = new Set(batch.filter(isSymbolSnapshotSourcePath));
        if (!(parsed.units instanceof Map) || !(parsed.symbols instanceof Map)
          || parsed.stats.files + parsed.stats.skippedFiles !== eligible.size
          || [...parsed.units.keys()].some(path => !eligible.has(path))) throw new Error('Invalid source parser partition');
        parts[index] = parsed;
        observeLimits?.({ kind: 'partition', index, files: batch.length, bytes });
      }
    }));
    const merged: ParsedSymbols = { units: new Map(), symbols: new Map(), immediateCalls: [],
      stats: { files: 0, skippedFiles: 0, unresolvedCalls: 0, resolvedCalls: 0, truncated: false } };
    for (let index = 0; index < count; index++) {
      const part = parts[index];
      if (!part) throw new Error('Missing source parser partition');
      for (const [path, unit] of part.units) {
        if (merged.units.has(path)) throw new Error('Duplicate source parser identity');
        merged.units.set(path, unit);
      }
      for (const [id, symbol] of part.symbols) {
        if (merged.symbols.has(id)) throw new Error('Duplicate source parser symbol');
        merged.symbols.set(id, symbol);
      }
      for (const call of part.immediateCalls) merged.immediateCalls.push(call);
      merged.stats.files += part.stats.files; merged.stats.skippedFiles += part.stats.skippedFiles;
      merged.stats.unresolvedCalls += part.stats.unresolvedCalls;
    }
    return merged;
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}

type CallCensusSink = (call: { path: string; line: number; column: number }, targetPath: string | null, index: number) => void;
export const REUSE_CALL_COLUMNS = 'reuse-call-columns-v1';
interface ReuseCallColumns {
  encoding: typeof REUSE_CALL_COLUMNS;
  paths: string[];
  blocks: Uint32Array[];
  count: number;
}

/** The ledger stores these same lossless rows as little-endian base64 blocks.
 * Repeating full paths in millions of JSON call objects exceeds V8's string
 * limit even when the finite source worker itself completed successfully.
 */
export function serializeReuseCallColumns(value: unknown) {
  const data = readReuseCallColumns(value);
  summarizeReuseCallColumns(data);
  return { encoding: data.encoding, paths: data.paths, count: data.count,
    blocks: data.blocks.map(block => {
      const bytes = Buffer.from(block.buffer, block.byteOffset, block.byteLength);
      return (endianness() === 'LE' ? bytes : Buffer.from(bytes).swap32()).toString('base64');
    }) };
}

function readReuseCallColumns(value: unknown): ReuseCallColumns {
  const data = value as ReuseCallColumns | null;
  const invalid = () => new Error('Invalid call census columns');
  if (!data || data.encoding !== REUSE_CALL_COLUMNS || !Array.isArray(data.paths)
    || data.paths.some(path => typeof path !== 'string' || !path)
    || new Set(data.paths).size !== data.paths.length || !Array.isArray(data.blocks)
    || !Number.isSafeInteger(data.count) || data.count < 0) throw invalid();
  let count = 0;
  const blocks = data.blocks.map((value: unknown) => {
    let block: Uint32Array;
    if (typeof value === 'string') {
      if (!value.length || value.length > 349_528) throw invalid();
      const bytes = Buffer.from(value, 'base64');
      if (bytes.toString('base64') !== value || bytes.byteLength % 16) throw invalid();
      if (endianness() !== 'LE') bytes.swap32();
      block = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    } else if (value instanceof Uint32Array) block = value;
    else throw invalid();
    if (block.length === 0 || block.length % 4 || block.length > 16_384 * 4) throw invalid();
    count += block.length / 4;
    return block;
  });
  if (count !== data.count) throw invalid();
  return { encoding: data.encoding, paths: data.paths, count, blocks };
}

/** Recompute counts from the retained sites, without expanding repeated paths
 * or trusting a saved score. Row order still supplies the exact call identity.
 */
export function summarizeReuseCallColumns(value: unknown) {
  const data = readReuseCallColumns(value);
  let resolved = 0, crossFile = 0;
  for (const block of data.blocks) for (let i = 0; i < block.length; i += 4) {
    const from = block[i]!, target = block[i + 1]!;
    if (from >= data.paths.length || target > data.paths.length || !block[i + 2] || !block[i + 3])
      throw new Error('Invalid call census columns');
    if (target) { resolved++; crossFile += Number(from !== target - 1); }
  }
  return { count: data.count, resolved, crossFile };
}

/** Lossless transport on the existing finite-worker IPC channel. Intern paths,
 * not call identities: each four-column row retains its exact site and target.
 */
export function createReuseCallColumns() {
  const paths: string[] = [], pathIds = new Map<string, number>(), blocks: Uint32Array[] = [];
  let count = 0, block = new Uint32Array(16_384 * 4), used = 0;
  const pathId = (path: string) => {
    if (!path) throw new Error('Invalid call census path');
    let id = pathIds.get(path);
    if (id === undefined) { id = paths.length; paths.push(path); pathIds.set(path, id); }
    return id;
  };
  const sink: CallCensusSink = (call, targetPath, index) => {
    if (index !== count || ![call.line, call.column].every(n => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff))
      throw new Error('Invalid call census site');
    if (used === block.length) { blocks.push(block); block = new Uint32Array(16_384 * 4); used = 0; }
    block[used++] = pathId(call.path);
    block[used++] = targetPath === null ? 0 : pathId(targetPath) + 1;
    block[used++] = call.line; block[used++] = call.column; count++;
  };
  return { sink, finish: (): ReuseCallColumns => ({ encoding: REUSE_CALL_COLUMNS, paths,
    blocks: used ? [...blocks, block.slice(0, used)] : blocks, count }) };
}

/** Decode in small yielding batches; syntax collection still runs exclusively
 * off-thread. A malformed or incomplete transport stays an error, never zero.
 */
export async function decodeReuseCallColumns(value: unknown): Promise<ReuseMetricPopulation['calls']> {
  const data = readReuseCallColumns(value);
  const invalid = () => new Error('Invalid call census columns');
  const calls: Array<ReuseMetricPopulation['calls'][number]> = [];
  for (const block of data.blocks) {
    for (let i = 0; i < block.length; i += 4) {
      const from = data.paths[block[i]!], target = block[i + 1]!, line = block[i + 2]!, column = block[i + 3]!;
      if (from === undefined || target > data.paths.length || !line || !column) throw invalid();
      calls.push({ id: `${from}:${line}:${column}:${calls.length}`, from,
        to: target ? data.paths[target - 1]! : null, resolved: target !== 0 });
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return calls;
}

/** Exact source population plus net added line identities, never a saved ratio.
 * Reuse the maintained clone floor/normalization and syntax-bound call resolver.
 * Non-JS/TS additions or unavailable clone sources keep redundancy unknown.
 */
export function buildReuseSourcePopulation(input: {
  addedLines: Readonly<Record<string, readonly number[]>>;
  complete: boolean;
  binaryChangedPaths?: readonly string[];
  onProgress?: (phase: ReuseSourcePhase) => void;
  callCensusSink?: CallCensusSink;
  parsedSymbols?: ParsedSymbols;
} & ({ sources: readonly { path: string; source: string }[] } | {
  sourcePaths: readonly string[];
  readSource: (path: string) => string;
})) {
  // The Git collector supplies an immutable, disk-backed reader. Keep only
  // per-file clone records and syntax units, rather than the whole source tree.
  const sources = 'sources' in input ? new Map(input.sources.map(s => [s.path, s.source])) : null;
  const paths = ('sources' in input ? input.sources.map(s => s.path) : input.sourcePaths).filter(eligibleHistoryPath);
  if (new Set(paths).size !== paths.length) throw new Error('Duplicate source identity');
  const readSource = 'sources' in input ? (path: string) => sources!.get(path)! : input.readSource;
  const added = new Map(Object.entries(input.addedLines).filter(([path]) => eligibleHistoryPath(path)).map(([path, lines]) => {
    if (lines.some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error('Positive added line identities required');
    return [path, [...new Set(lines)].sort((a, b) => a - b)] as const;
  }));
  // An actual binary diff makes both line counts unknowable. D035 permits
  // omitting this otherwise unused clone census; calls retain the full cohort.
  const binary = (input.binaryChangedPaths?.length ?? 0) > 0;
  const index = new CloneIndex({ includeNear: false });
  const addedByFunction = new Map<string, number[]>();
  if (!binary) input.onProgress?.('source-clones');
  for (const path of binary ? [] : paths.filter(path => /\.tsx?$/.test(path))) {
    const source = readSource(path);
    const { file } = index.update({ path, source });
    const lineStarts = [0], lines = added.get(path) ?? [];
    for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
    for (const fn of file.functions) {
      const first = lowerBound(lineStarts, fn.start + 1);
      const end = lowerBound(lineStarts, Math.max(fn.start, fn.end - 1) + 1);
      addedByFunction.set(fn.id, lines.slice(lowerBound(lines, first), lowerBound(lines, end + 1)));
    }
  }
  const duplicated = new Set<string>();
  const addedIn = (fn: { id: string }) => addedByFunction.get(fn.id)!;
  for (const family of index.families('renamed', { crossFile: false, includeTests: true })) {
    // Preserve an existing copy where possible. If every copy is added, the
    // lexicographically first location is the one necessary implementation.
    const members = [...family.members].sort((a, b) => Number(addedIn(a).length > 0) - Number(addedIn(b).length > 0)
      || a.path.localeCompare(b.path) || a.start - b.start);
    for (const member of members.slice(1)) for (const n of addedIn(member)) duplicated.add(`${member.path}:${n}`);
  }
  const files = paths.filter(path => /\.[cm]?[jt]sx?$/.test(path)), fileSet = new Set(files);
  input.onProgress?.('source-calls');
  const snapshot = buildSymbolSnapshot({ files, readSource,
    resolveModule: (path, specifier) => relativeSymbolModule(path, specifier, fileSet), censusOnly: true,
    callCensusSink: input.callCensusSink, parsed: input.parsedSymbols });
  return { addedNonGeneratedLines: binary ? null : [...added.values()].reduce((n, lines) => n + lines.length, 0),
    duplicateAddedLines: binary ? null : duplicated.size,
    lineCensusComplete: !binary && input.complete && index.getFiles().every(file => file.status === 'indexed' || file.status === 'excluded')
      && [...added.keys()].every(path => /\.tsx?$/.test(path)
      && index.getFile(path)?.status === 'indexed'),
    calls: (snapshot.callCensus ?? []) as ReuseMetricPopulation['calls'],
    callCensusComplete: input.complete && snapshot.stats.skippedFiles === 0 && !snapshot.stats.truncated,
    method: { cloneVersion: binary ? null : index.version,
      cloneCensus: binary ? { status: 'unknown', reason: 'binary-additions', computed: false }
        : { status: 'computed', computed: true }, callKnowledge: snapshot.knowledge,
      sourcePopulation: [...paths].sort(), addedLinePopulation: [...added].map(([path, lines]) => ({ path, lines: [...lines].sort((a,b) => a-b) })),
      limitations: snapshot.limitations } };
}

/** Bounded immutable Git capture. Reading working-tree bytes would silently mix
 * today's source with yesterday's scheduled measurement window. Gitlinks remain
 * explicit unknowns here; no submodule's mutable checkout is substituted.
 */
export async function collectReuseSourcePopulation(root: string, start: string, end: string, captureRoot = tmpdir(),
  onProgress?: (phase: ReuseSourcePhase, parserLimits?: Record<string, unknown>) => void, callCensusSink?: CallCensusSink,
  parserWorkerPath?: string) {
  if (time(start) >= time(end)) throw new Error('Valid half-open source window required');
  onProgress?.('source-tree');
  const gitBytes = (args: string[], input?: string) => new Promise<Buffer>((resolve, reject) => {
    const child = execFile('git', ['--literal-pathspecs', '-C', root, ...args], { encoding: 'buffer', timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
    (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin?.end(input);
  });
  const git = async (args: string[], input?: string) => (await gitBytes(args, input)).toString('utf8');
  const commitAt = async (at: string) => (await git(['rev-list', '--first-parent', '-1', `--before=${new Date(time(at) - 1).toISOString()}`, 'HEAD'])).trim();
  const [base, commit] = await Promise.all([commitAt(start), commitAt(end)]);
  if (!base || !commit || await git(['rev-parse', '--is-shallow-repository']).then(x => x.trim()) !== 'false')
    throw new Error('Complete source-window ancestry unavailable');
  const tree = (await git(['ls-tree', '-rlz', '--full-tree', commit])).split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t'), [mode, kind, blob, size] = line.slice(0, tab).trim().split(/\s+/);
    return { mode, kind, blob, size: Number(size), path: line.slice(tab + 1) };
  });
    const selected = tree.filter(s => s.kind === 'blob' && /^(100644|100755)$/.test(s.mode!)
      && eligibleHistoryPath(s.path) && /\.[cm]?[jt]sx?$/.test(s.path));
  if (selected.length > 25_000) throw new Error('Source population exceeds bounded collector');
  // Reuse the existing per-file parser bounds. A cumulative byte ceiling made
  // an otherwise supported repository permanently unmeasurable. Immutable
  // blobs spill to this invocation's private directory and are read one at a
  // time by both maintained indexes; no checkout or durable store is created.
  const capture = mkdtempSync(join(captureRoot, 'reuse-source-capture-'));
  const sourceFiles = new Map(selected.map(entry => [entry.path, join(capture, entry.blob!)]));
  const capturedBlobs = new Set<string>();
  const sourceSizes = new Map(selected.map(entry => [entry.path, entry.size]));
  const positions = new Map(selected.map((entry, index) => [entry.path, index + 1]));
  let capturedThrough = 0, captureError: Error | undefined;
  const waiting = new Set<{ end: number; resolve: () => void; reject: (error: Error) => void }>();
  const ready = async (files: readonly string[]) => {
    if (captureError) throw captureError;
    const end = positions.get(files[files.length - 1]!)!;
    if (end <= capturedThrough) return;
    await new Promise<void>((resolve, reject) => waiting.add({ end, resolve, reject }));
  };
  let capturePending: Promise<Error | null> | undefined;
  let parsePending: Promise<{ parsed?: ParsedSymbols; error?: Error }> | undefined;
  try {
    // Blob capture and immutable diff collection are independent. Settle the
    // capture before cleanup on either path; no writer may outlive its spill.
    capturePending = (async () => {
    onProgress?.('source-capture');
    // Bound bytes independently of the identity count: small-file repositories
    // otherwise spend the finite worker budget repeatedly starting Git. The
    // byte cap still bounds each reply when individual source files are large.
    for (let i = 0; i < selected.length;) {
      const batch: typeof selected = [];
      let bytes = 0;
      while (i < selected.length && batch.length < 4096) {
        const entry = selected[i]!;
        if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 2_000_000)
          throw new Error('Incomplete bounded Git blob population');
        if (batch.length && bytes + entry.size > 32 * 1024 * 1024) break;
        batch.push(entry); bytes += entry.size; i++;
      }
      const out = await gitBytes(['cat-file', '--batch'], batch.map(s => s.blob).join('\n') + '\n');
      let offset = 0;
      for (const entry of batch) {
        const endHeader = out.indexOf(10, offset), [blob, kind, rawSize] = out.subarray(offset, endHeader).toString().split(' '), size = Number(rawSize);
        if (blob !== entry.blob || kind !== 'blob' || !Number.isSafeInteger(size) || size < 0 || size > 2_000_000
          || out[endHeader + 1 + size] !== 10) throw new Error('Incomplete bounded Git blob population');
        const file = join(capture, blob!);
        // Multiple paths can name one immutable blob. A parser may already
        // read the first alias while a later capture batch reaches another;
        // never truncate/rewrite its shared backing file in that interval.
        if (!capturedBlobs.has(blob!)) {
          writeFileSync(file, out.subarray(endHeader + 1, endHeader + 1 + size));
          capturedBlobs.add(blob!);
        }
        offset = endHeader + 2 + size;
      }
      capturedThrough = i;
      for (const waiter of waiting) if (waiter.end <= capturedThrough) {
        waiting.delete(waiter); waiter.resolve();
      }
    }
    })().then(() => null, error => {
      captureError = error instanceof Error ? error : new Error(String(error));
      for (const waiter of waiting) waiter.reject(captureError);
      waiting.clear();
      return captureError;
    });
    // Start the existing finite pool against known Git identities immediately.
    // Each partition waits for its own bytes instead of serializing the full
    // repository capture before any parsing. Global resolution still waits for
    // complete capture, diff and syntax populations below.
    parsePending = (async () => {
      if (!parserWorkerPath || sourceFiles.size <= 512) return {};
      onProgress?.('source-calls');
      return { parsed: await parseReuseSourceSymbols(sourceFiles, parserWorkerPath,
        limits => onProgress?.('source-calls', limits), { sizes: sourceSizes, ready }) };
    })().catch(error => ({ error: error instanceof Error ? error : new Error(String(error)) }));
    onProgress?.('source-diff');
    const rawChanges = (await git(['diff', '--raw', '-z', '--no-abbrev', '--no-renames', base, commit])).split('\0');
    const changes = new Map<string, string>();
    const oldBlobs = new Map<string, string>();
    for (let i = 0; i < rawChanges.length - 1; i += 2) {
      const status = /^:(\d{6}) \d{6} ([0-9a-f]{40}) [0-9a-f]{40} ([A-Z])$/.exec(rawChanges[i]!);
      const path = rawChanges[i + 1]!;
      if (!status || !path) throw new Error('Incomplete Git diff identity population');
      if (eligibleHistoryPath(path)) {
        changes.set(path, status[3]!);
        if (/^100(?:644|755)$/.test(status[1]!)) oldBlobs.set(path, status[2]!);
      }
    }
    const paths = [...changes.keys()];
    const blobSizes = new Map<string, number>();
    const oldIds = [...new Set(oldBlobs.values())];
    if (oldIds.length) {
      const sizes = (await git(['cat-file', '--batch-check'], oldIds.join('\n') + '\n')).trim().split('\n');
      for (const line of sizes) {
        const [blob, kind, rawSize] = line.split(' '), size = Number(rawSize);
        if (kind !== 'blob' || !Number.isSafeInteger(size) || size < 0)
          throw new Error('Incomplete Git diff blob sizes');
        blobSizes.set(blob!, size);
      }
      if (blobSizes.size !== oldIds.length || oldIds.some(blob => !blobSizes.has(blob)))
        throw new Error('Incomplete Git diff blob sizes');
    }
    const newSizes = new Map(tree.filter(entry => entry.kind === 'blob').map(entry => [entry.path, entry.size]));
    const addedLines: Record<string, number[]> = {};
    const binaryChangedPaths: string[] = [];
    // NUL-delimited raw identities and their patches are emitted in the same
    // order. Never decode a path from a quoted patch heading. Bound each batch
    // and split only on output overflow, preserving the existing per-path cap.
    const readDiffs = async (batch: string[], expected: Map<string, number>): Promise<void> => {
      if (!batch.length) return;
      let result: { identities: string[]; hunks: number[][] };
      try {
        result = await new Promise((resolve, reject) => {
          const child = spawn('git', ['--literal-pathspecs', '-C', root, 'diff', '--no-ext-diff', '--no-textconv',
            '--no-renames', '--unified=0', '--raw', '-z', '--patch', base, commit, '--', ...batch],
          { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'ignore'] });
          const empty: Buffer = Buffer.alloc(0);
          let failure: Error | null = null, bytes = 0, prefix: Buffer | null = empty, line = empty, patch = -1, skipped = false;
          let identities: string[] = [];
          const hunks: number[][] = [];
          const fail = (error: Error) => { failure ??= error; child.kill('SIGKILL'); };
          const timer = setTimeout(() => fail(new Error('Git diff deadline exceeded')), 30_000);
          const finishLine = () => {
            if (line.subarray(0, 11).toString() === 'diff --git ') { patch++; hunks.push([]); }
            else if (line[0] === 64 && line[1] === 64) {
              const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line.toString());
              if (!match || patch < 0) throw new Error('Incomplete Git hunk identity');
              const first = Number(match[1]), count = match[2] === undefined ? 1 : Number(match[2]);
              for (let n = first; n < first + count; n++) hunks[patch]!.push(n);
            }
            line = empty;
          };
          child.stdout.on('data', (chunk: Buffer) => {
            if (failure) return;
            bytes += chunk.length;
            if (bytes > 64 * 1024 * 1024) {
              fail(Object.assign(new Error('Git diff output exceeds bound'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })); return;
            }
            try {
              let data = chunk;
              if (prefix !== null) {
                prefix = Buffer.concat([prefix, data]);
                const boundary = prefix.indexOf(Buffer.from([0, 0]));
                if (boundary < 0) return;
                const raw = prefix.subarray(0, boundary).toString().split('\0');
                identities = raw.filter((_, index) => index % 2 === 1);
                if (raw.length !== batch.length * 2 || new Set(identities).size !== batch.length
                  || identities.some(path => !batch.includes(path))) throw new Error('Incomplete Git diff identity population');
                data = prefix.subarray(boundary + 2); prefix = null;
              }
              // Only a bounded line prefix is needed to recognize a patch or
              // hunk heading. Discard payload bytes as they arrive, including
              // arbitrarily long source lines; the output bound still applies.
              for (let offset = 0; offset < data.length;) {
                const end = data.indexOf(10, offset), stop = end < 0 ? data.length : end;
                if (!line.length && data[offset] !== 100 && data[offset] !== 64) skipped = true;
                if (!skipped && line.length < 256) {
                  const part = data.subarray(offset, Math.min(stop, offset + 256 - line.length));
                  line = line.length ? Buffer.concat([line, part]) : part;
                }
                if (end < 0) break;
                if (!skipped) finishLine();
                skipped = false; offset = end + 1;
              }
            } catch (error) { fail(error as Error); }
          });
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('close', code => {
            clearTimeout(timer);
            if (failure) { reject(failure); return; }
            try {
              if (line.length) finishLine();
              if (code !== 0 || prefix !== null || hunks.length !== batch.length) throw new Error('Incomplete Git diff identity population');
              resolve({ identities, hunks });
            } catch (error) { reject(error); }
          });
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || batch.length < 2) throw error;
        const middle = Math.floor(batch.length / 2);
        await readDiffs(batch.slice(0, middle), expected); await readDiffs(batch.slice(middle), expected); return;
      }
      const { identities, hunks } = result;
      for (let i = 0; i < identities.length; i++) {
        const path = identities[i]!, lines = hunks[i]!;
        if (lines.length !== expected.get(path)) throw new Error('Incomplete Git added-line population');
        if (lines.length) addedLines[path] = lines;
      }
    };
    const readChanges = async (batch: string[]): Promise<void> => {
      // New files have one exact contiguous added-line population. Numstat
      // supplies its size (and binary unknowns) without transferring gigabytes
      // of report bodies merely to discard everything except hunk headers.
      const stats = (await git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames',
        '--unified=0', '--no-patch', '--numstat', '-z', base, commit, '--', ...batch])).split('\0').filter(Boolean);
      const seen = new Set<string>(), modified = new Map<string, number>();
      for (const stat of stats) {
        const first = stat.indexOf('\t'), second = stat.indexOf('\t', first + 1);
        const path = stat.slice(second + 1), added = stat.slice(0, first), removed = stat.slice(first + 1, second);
        if (first < 0 || second < 0 || seen.has(path))
          throw new Error('Incomplete Git diff identity population');
        if (!batch.includes(path)) throw new Error('Incomplete Git diff identity population');
        seen.add(path);
        if (added === '-' && removed === '-') { binaryChangedPaths.push(path); continue; }
        const count = Number(added);
        if (!/^\d+$/.test(added) || !/^\d+$/.test(removed) || !Number.isSafeInteger(count))
          throw new Error('Incomplete Git added-line population');
        if (!count) continue;
        if (changes.get(path) === 'A') addedLines[path] = Array.from({ length: count }, (_, i) => i + 1);
        else modified.set(path, count);
      }
      if (seen.size !== batch.length) throw new Error('Incomplete Git diff identity population');
      // Large modified report bodies repeatedly overflowed path-count-only
      // batches, paying for the same diff again at each recursive split. Size
      // batches with immutable old/new blobs; the actual output bound and its
      // split fallback still protect against patch-heading/line-prefix growth.
      const chunks: string[][] = [];
      let chunk: string[] = [], bytes = 0;
      for (const path of modified.keys()) {
        const estimate = (blobSizes.get(oldBlobs.get(path)!) ?? 0) + (newSizes.get(path) ?? 0) + 4096;
        if (chunk.length && (chunk.length >= 128 || bytes + estimate > 32 * 1024 * 1024)) {
          chunks.push(chunk); chunk = []; bytes = 0;
        }
        chunk.push(path); bytes += estimate;
      }
      if (chunk.length) chunks.push(chunk);
      for (const chunk of chunks) await readDiffs(chunk, modified);
    };
    // Preserve the exact eligible path set while avoiding both repeated tree
    // traversals for tiny chunks and diffing excluded large generated files.
    const chunks: string[][] = [];
    let batch: string[] = [], pathBytes = 0;
    for (const path of paths) {
      const bytes = Buffer.byteLength(path) + 1;
      if (batch.length && (batch.length >= 4096 || pathBytes + bytes > 256 * 1024)) {
        chunks.push(batch); batch = []; pathBytes = 0;
      }
      batch.push(path); pathBytes += bytes;
    }
    if (batch.length) chunks.push(batch);
    let nextChunk = 0;
    const diffs = await Promise.allSettled(Array.from({ length: Math.min(4, chunks.length) }, async () => {
      while (nextChunk < chunks.length) await readChanges(chunks[nextChunk++]!);
    }));
    const failed = diffs.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    // Concurrent completion order must not change the population identity.
    const orderedAddedLines = Object.fromEntries(paths.filter(path => addedLines[path]).map(path => [path, addedLines[path]!]));
    const captureFailure = await capturePending;
    if (captureFailure) throw captureFailure;
    const parsedResult = await parsePending;
    if (parsedResult.error) throw parsedResult.error;
    const parsedSymbols = parsedResult.parsed;
    const population = buildReuseSourcePopulation({ sourcePaths: [...sourceFiles.keys()],
      readSource: path => readFileSync(sourceFiles.get(path)!, 'utf8'),
      addedLines: orderedAddedLines, complete: !tree.some(s => s.kind === 'commit'), binaryChangedPaths, onProgress, callCensusSink, parsedSymbols });
    return { ...population,
      addedNonGeneratedLines: binaryChangedPaths.length ? null : population.addedNonGeneratedLines,
      duplicateAddedLines: binaryChangedPaths.length ? null : population.duplicateAddedLines,
      lineCensusComplete: population.lineCensusComplete && binaryChangedPaths.length === 0,
      method: { ...population.method,
        ...(binaryChangedPaths.length ? { binaryChangedPaths: binaryChangedPaths.sort() } : {}) },
      sourceRefs: [`git:${base}`, `git:${commit}`], base, commit };
  } finally {
    await capturePending;
    await parsePending;
    rmSync(capture, { recursive: true, force: true });
  }
}
