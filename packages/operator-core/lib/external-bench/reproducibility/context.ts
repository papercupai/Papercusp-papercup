/** Physical restoration of the existing frozen CorpusEntry snapshot format. */
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { canonicalJson } from './canonical-json';
import type { CurrentBenchmarkProtocol } from './schema';

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const snapshotSchema = z.object({
  entries: z.array(z.object({ key: z.string().min(1), text: z.string(),
    kind: z.string().optional(), description: z.string().optional() }).strict()),
  version: z.string().optional(), source: z.string().optional(), snapshotAt: z.string().optional(),
  schemaVersion: z.literal(1).optional(),
}).strict().refine(value => new Set(value.entries.map(entry => entry.key)).size === value.entries.length,
  'Snapshot keys must be unique.');

export interface BenchmarkContextBinding {
  workspaceId: string; runId: string; preregHash: string; assignmentId: string; harnessSlug: string;
}
export interface BenchmarkContextReceipt extends BenchmarkContextBinding {
  schemaVersion: 1; worktreePath: string; corpusHash: string; memoryHash: string;
  corpusPath: string; memoryPath: string; receiptPath: string; receiptRef: string;
  contextText: string; contextTextSha256: string;
}
export interface BenchmarkContextInput {
  binding: BenchmarkContextBinding; context: CurrentBenchmarkProtocol['context'];
  checkout: string; snapshotRoot: string;
}

/** Refuse links at every component, including the final opened file. */
function containedPath(root: string, ref: string): string {
  if (!ref || isAbsolute(ref) || ref.includes('\\') || ref.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error('Benchmark context reference must be a normalized repository-relative path.');
  const file = resolve(root, ref);
  if (!relative(root, file) || relative(root, file).startsWith(`..${sep}`)) throw new Error('Benchmark context escapes its root.');
  let current = root;
  for (const component of ref.split('/')) {
    current = join(current, component);
    if (lstatSync(current).isSymbolicLink()) throw new Error('Benchmark context cannot traverse a symbolic link.');
  }
  return file;
}
function readRegularFile(file: string, maxBytes?: number): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error('Benchmark context snapshot is not a regular file.');
    if (maxBytes !== undefined && (before.size < 1 || before.size > maxBytes))
      throw new Error('Benchmark file size is outside its allocated bound.');
    // Resolve the opened descriptor: a swapped parent must not redirect this
    // read outside the private root checked before open.
    if (maxBytes !== undefined && realpathSync(`/proc/self/fd/${fd}`) !== file)
      throw new Error('Benchmark file descriptor differs from its allocated path.');
    const bytes = maxBytes === undefined ? readFileSync(fd) : Buffer.alloc(before.size);
    if (maxBytes !== undefined) {
      let offset = 0;
      while (offset < bytes.length) {
        const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!read) throw new Error('Benchmark file ended during its evidence read.');
        offset += read;
      }
    }
    if (maxBytes !== undefined) {
      const after = lstatSync(file);
      if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino ||
          before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
          bytes.length !== before.size || realpathSync(`/proc/self/fd/${fd}`) !== file)
        throw new Error('Benchmark file changed during its evidence read.');
    }
    return bytes;
  } finally { closeSync(fd); }
}

/** Reuse the frozen-context path boundary for host-allocated output artifacts.
 * Linux descriptor resolution refuses parent swaps; unavailable proof fails
 * closed. This reads bytes only and does not establish workload completion. */
export function readContainedBenchmarkFile(root: string, ref: string, maxBytes: number): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024 || realpathSync(root) !== root)
    throw new Error('Benchmark artifact requires a canonical private root and bounded size.');
  return readRegularFile(containedPath(root, ref), maxBytes);
}
function readSnapshot(file: string, expected: string, forbidden: readonly string[]): Buffer {
  const bytes = readRegularFile(file);
  if (digest(bytes) !== expected) throw new Error('Benchmark context snapshot bytes differ from the frozen protocol.');
  const value = snapshotSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (value.entries.some(entry => forbidden.some(ref => entry.key === ref || entry.key.startsWith(`${ref}:`))))
    throw new Error('Benchmark context contains a forbidden source.');
  return bytes;
}
function roots(input: BenchmarkContextInput) {
  if (Object.values(input.binding).some(value => typeof value !== 'string' || !value.trim()) ||
      !/^[a-f0-9]{64}$/.test(input.binding.preregHash) || !input.binding.assignmentId.startsWith('bench-assignment:') ||
      input.context.isolation !== 'fresh-per-assignment' ||
      !input.context.forbiddenSources.includes('other-arm-solutions') || !input.context.forbiddenSources.includes('hidden-grader-answers'))
    throw new Error('Benchmark context needs an exact assignment binding.');
  const checkout = realpathSync(input.checkout), source = realpathSync(input.snapshotRoot);
  if (source === checkout || source.startsWith(`${checkout}${sep}`)) throw new Error('Frozen snapshots must be outside the assignment checkout.');
  const papercusp = join(checkout, '.papercusp');
  mkdirSync(papercusp, { recursive: true });
  if (lstatSync(papercusp).isSymbolicLink()) throw new Error('Benchmark context destination cannot be a symbolic link.');
  return { checkout, source, directory: join(papercusp, 'benchmark-context') };
}
function contextText(corpus: Buffer, memory: Buffer): string {
  // Both arms receive the complete same frozen bytes. No live backend/query,
  // previous-arm solution or grader path participates in this rendering.
  return `\n\nPermitted frozen initial corpus (JSON):\n${corpus.toString('utf8')}\n\nPermitted frozen initial memory (JSON):\n${memory.toString('utf8')}`;
}

/** Exclusive creation refuses a reused/contaminated assignment context. */
export function restoreBenchmarkContext(input: BenchmarkContextInput): BenchmarkContextReceipt {
  const { checkout, source, directory } = roots(input);
  const corpus = readSnapshot(containedPath(source, input.context.corpusRef), input.context.corpusHash, input.context.forbiddenSources);
  const memory = readSnapshot(containedPath(source, input.context.memoryRef), input.context.memoryHash, input.context.forbiddenSources);
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, 'corpus.json'), corpus, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(directory, 'memory.json'), memory, { flag: 'wx', mode: 0o600 });
  const text = contextText(corpus, memory);
  const record = { schemaVersion: 1, ...input.binding, worktreePath: checkout,
    corpusHash: input.context.corpusHash, memoryHash: input.context.memoryHash,
    contextTextSha256: digest(text) };
  writeFileSync(join(directory, 'receipt.json'), canonicalJson(record), { flag: 'wx', mode: 0o600 });
  return readRestoredBenchmarkContext(input);
}

/** Independently re-read physical state immediately before native generation. */
export function readRestoredBenchmarkContext(input: BenchmarkContextInput): BenchmarkContextReceipt {
  const { checkout, directory } = roots(input);
  const corpusPath = containedPath(checkout, '.papercusp/benchmark-context/corpus.json');
  const memoryPath = containedPath(checkout, '.papercusp/benchmark-context/memory.json');
  const receiptPath = containedPath(checkout, '.papercusp/benchmark-context/receipt.json');
  const corpus = readSnapshot(corpusPath, input.context.corpusHash, input.context.forbiddenSources);
  const memory = readSnapshot(memoryPath, input.context.memoryHash, input.context.forbiddenSources);
  const text = contextText(corpus, memory);
  const record = { schemaVersion: 1 as const, ...input.binding, worktreePath: checkout,
    corpusHash: input.context.corpusHash, memoryHash: input.context.memoryHash, contextTextSha256: digest(text) };
  const receiptBytes = readRegularFile(receiptPath).toString('utf8');
  if (receiptBytes !== canonicalJson(record)) throw new Error('Benchmark context restoration receipt differs from this assignment.');
  const members = readdirSync(directory).sort();
  if (canonicalJson(members) !== canonicalJson(['corpus.json', 'memory.json', 'receipt.json']))
    throw new Error('Benchmark context contains unexpected assignment files.');
  return { ...record, corpusPath, memoryPath, receiptPath,
    receiptRef: `sha256:${digest(receiptBytes)}`, contextText: text };
}

