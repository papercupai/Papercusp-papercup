/**
 * WI-10006543: one `graph:query` callers question, answered in its own process.
 *
 * Forked by first-party-callers-offthread.ts, one process per question. The
 * scoped TypeScript program takes seconds and 0.7-1.5 GB, so it runs here rather
 * than on the operator's event loop, and the memory goes back to the OS when the
 * process exits. A bundled host loads the esbuilt `first-party-callers.worker.mjs`
 * (bundle-host-common.sh); an unbundled host forks this file under Node's native
 * type stripping, which is why its import graph uses explicit `.ts` extensions.
 *
 * TypeScript itself is never bundled: it is loaded from the vendored LSP install
 * the host names, the same TypeScript typescript-language-server runs.
 */
import { failedCallersAnswer, firstPartyCallers, type FirstPartyCallersAnswer, type FirstPartyCallersQuery } from './first-party-callers.ts';
import { loadVendoredTypescript } from './typescript-service.ts';
import type { ReuseSourcePhase } from './reuse-source-population.ts';
import { isMainThread, parentPort, resourceLimits, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import { parseSymbolSnapshot, relativeSymbolModule } from '../../../../scripts/lib/code-intel-symbol-snapshot.mjs';

export interface FirstPartyCallersJob extends Omit<FirstPartyCallersQuery, 'ts' | 'now'> {
  readonly vendorDir: string;
  readonly root: string;
  readonly repositoryId?: string;
  readonly name: string;
  readonly limit?: number;
  /** Repository-relative search roots; absent = the whole repository. */
  readonly paths?: readonly string[];
  readonly rgPath?: string;
}

/** Progress extends the existing IPC exchange; it never counts as an answer. */
export interface FirstPartyCallersProgress {
  readonly kind: 'first-party-callers-progress';
  readonly phase: 'job-received' | 'typescript-load' | 'compiler-query' | ReuseSourcePhase;
  readonly elapsedMs: number;
}

if (!isMainThread && workerData?.kind === 'reuse-symbol-parse') {
  const sourceFiles = new Map<string, string>(workerData.sourceFiles), files = new Set(sourceFiles.keys());
  parentPort!.on('message', ({ index, files: batch }: { index: number; files: string[] }) => {
    try {
      const parsed = parseSymbolSnapshot({ files: batch, censusOnly: true,
        readSource: path => readFileSync(sourceFiles.get(path)!, 'utf8'),
        resolveModule: (path, specifier) => relativeSymbolModule(path, specifier, files) });
      parentPort!.postMessage({ index, parsed });
    } catch (error) { parentPort!.postMessage({ index, error: error instanceof Error ? error.message : String(error) }); }
  });
  parentPort!.postMessage({ kind: 'ready', oldSpaceMb: resourceLimits.maxOldGenerationSizeMb,
    heapLimitMb: getHeapStatistics().heap_size_limit / 1024 / 1024, execArgv: process.execArgv });
} else {
if (!process.send) throw new Error('first-party-callers.worker must be forked with an IPC channel');

interface ReuseSourceJob { kind: 'reuse-source-population'; root: string; start: string; end: string; captureRoot?: string; callCensusEncoding?: string }
const job = await new Promise<FirstPartyCallersJob | ReuseSourceJob>((resolve) => process.once('message', resolve));
const started = Date.now();
const progress = (phase: FirstPartyCallersProgress['phase'], parserLimits?: Record<string, unknown>) => process.send!({
  kind: 'first-party-callers-progress', phase, elapsedMs: Date.now() - started, ...(parserLimits ? { parserLimits } : {}),
});
progress('job-received');
let result: unknown;
if ('kind' in job && job.kind === 'reuse-source-population') {
  const sourceJob = job as ReuseSourceJob;
  try {
    const { collectReuseSourcePopulation, createReuseCallColumns, REUSE_CALL_COLUMNS } = await import('./reuse-source-population.ts');
    if (sourceJob.callCensusEncoding !== undefined && sourceJob.callCensusEncoding !== REUSE_CALL_COLUMNS)
      throw new Error('Unknown call census encoding');
    const columns = sourceJob.callCensusEncoding ? createReuseCallColumns() : null;
    const population = await collectReuseSourcePopulation(sourceJob.root, sourceJob.start, sourceJob.end,
      sourceJob.captureRoot, progress, columns?.sink, fileURLToPath(import.meta.url));
    result = { kind: job.kind, ok: true, population, ...(columns ? { packedCalls: columns.finish() } : {}) };
  } catch (error) {
    result = { kind: job.kind, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
} else {
  const callersJob = job as FirstPartyCallersJob;
  try {
  progress('typescript-load');
  const ts = loadVendoredTypescript(callersJob.vendorDir);
  progress('compiler-query');
  result = firstPartyCallers({ ...callersJob, ts });
} catch (error) {
  // Loading TypeScript is the one step firstPartyCallers does not guard itself.
  const why = error instanceof Error ? error.message : String(error);
  result = failedCallersAnswer(callersJob.name, `could not load the vendored TypeScript from ${callersJob.vendorDir}: ${why}`, started, Date.now(), callersJob);
  }
}
await new Promise<void>((resolve, reject) => process.send!(result, (error: Error | null) => (error ? reject(error) : resolve())));
process.disconnect();
}
