/** Current-build reclaim acceptance through the maintained private background
 * runtime. Fixture effects and receipt writes never use the shared host state. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, type TestContext } from 'vitest';
import { resolveExecutedMapPgUrl } from '../../../../scripts/lib/executed-source-map.mjs';
import { captureIsolatedWorker, isolatedTestFileWorkerOptions, isolatedWorkerFailureDetail,
  recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const filePath = 'packages/operator-core/lib/storage/disk-reclaim-background-runtime.integration.test.ts';
const assertion = 'packages/operator-core/lib/storage/disk-reclaim.integration.test.ts';
const releaseAssertion = 'packages/operator-core/lib/release-cut-reclaim.test.ts';
const releaseSource = 'packages/operator-core/lib/release-cut-reclaim.ts';
const usageSource = 'packages/operator-core/lib/storage/disk-census-detached-walk.ts';
const censusAssertion = 'packages/operator-core/lib/storage/disk-consumer-census.test.ts';
const reclaimSource = 'packages/operator-core/lib/storage/disk-reclaim.ts';
const censusSource = 'packages/operator-core/lib/storage/disk-consumer-census.ts';
const censusSelected = [
  'accepts the real native directory-descent disappearance',
  'refuses unproven or incomplete disappearance evidence',
  'compacts capped native file metadata',
];
const selected = [
  'waits for first mutex admission within the whole run deadline',
  'refuses effects when first mutex admission exhausts the whole run deadline',
  'stops waiting for first mutex admission when the run deadline expires',
  'runs the native cargo delegate repeatedly with captured receipts and no missed completion',
  'starts effects without an all-candidate holder census',
  'starts the next pass after a root whose census spent the preceding deadline',
  'runs independent owners when a whole-root census exhausts the run deadline',
  'finishes an advancing root beyond its inspection allowance',
  'reaps an elevated census worker at its native deadline',
  'uses bounded privileged census and fd-safe removal',
  'native census handles delimiter-looking names',
  'native census retains a new write between planning',
  'persists start, exact removal intent, removed path and final receipt',
  'finishes an admitted removal, yields the real mutex, then resumes the same pass',
  'refreshes a new pin after a FIFO handoff without repeating the census',
  'refreshes a new lease after a FIFO handoff without repeating the census',
];
// The advancing-root assertion covers four deadline modes under one title.
const selectedCount = selected.length + 3;
const buildSelected = [
  'expires build directories',
  'protected build sources',
  'build source written',
  'native build removal',
  'removed build bytes',
];
// The first two are parameterized over local and native metadata walks.
const buildSelectedCount = 7;
const specialSelected = ['preserves old live Unix sockets and FIFOs when path holder evidence is empty'];
const specialSelectedCount = 2;
const receiptSelected = ['persists protected census summaries without private allocation metadata'];
const receiptSelectedCount = 2;
const hardlinkSelected = [
  'keeps a hardlinked population already within its cap',
  'keeps shared bytes after removing a link beside a',
  'subtracts a shared allocation only at its last planned link',
  'refuses effects on a hardlink cap when a sibling census fails',
  'releases shared bytes after removing both build directories',
  'accounts shared build-only removals with source and sibling links',
];
const hardlinkSelectedCount = 21;
const options = isolatedTestFileWorkerOptions(process.env, 1);

type RuntimeSelection = {
  reclaimTitles: string[]; expectedReclaimCases: number; census: boolean;
  assertion?: string; source?: string;
  observedSources?: string[];
};
const runSelection = async (selection: RuntimeSelection, context: TestContext) => {
  const selectedAssertion = selection.assertion ?? assertion;
  const selectedSource = selection.source ?? reclaimSource;
  let environmentObserved = false;
  let environmentError: unknown;
  const runId = await recordIsolatedIntegrationProof({
    root, filePath,
    sourcePaths: [...new Set([assertion, selectedAssertion, censusAssertion, reclaimSource, censusSource,
      releaseSource, usageSource,
      'packages/operator-core/lib/native-bg-task-ledger.ts',
      'packages/operator-core/lib/storage/retention-policy.ts',
      'packages/operator-core/lib/storage/retention-pins.ts',
      'scripts/lib/retention-pins.mjs', 'scripts/lib/fs-mutex.mjs',
      'libs/generic/verification-harness/src/runner.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'scripts/with-test-pg.mjs', 'scripts/test-files.mjs'])],
    retainedArtifacts: ['phases/execute/worker.log', 'phases/execute/worker-result.json',
      'phases/execute/reclaim-test-receipts.ndjson',
      'phases/execute/executed-source-map.json',
      ...(selection.census ? ['phases/execute/executed-source-map.1.json'] : [])],
    execute: async (observe, evidenceDir) => {
      const receipts = join(evidenceDir, 'reclaim-test-receipts.ndjson');
      const child = spawn(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime', '--', process.execPath, join(root, 'scripts/test-files.mjs'),
        selectedAssertion, ...(selection.census ? [censusAssertion] : []), '--', '-t',
        [...selection.reclaimTitles, ...(selection.census ? censusSelected : [])].join('|')], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1',
          // The parent router expects only this wrapper in its run group.
          // Inner assertion receipts belong to a separate native execution.
          PAPERCUSP_TEST_RUN_GROUP: randomUUID(),
          // Each runner owns its map. Inheriting the outer path loses the
          // native worker's original sources when the outer reporter finishes.
          PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'papercusp-workspace',
          PC_EXECUTED_SOURCE_MAP_OUT: join(evidenceDir, 'executed-source-map.json'),
          PAPERCUSP_TEST_RUNS_DB_URL: resolveExecutedMapPgUrl().url,
          PAPERCUSP_TEST_RUN_HARNESS: 'papercusp', PAPERCUSP_TEST_RUN_WORKSPACE: 'papercusp-workspace',
          PAPERCUSP_TEST_RUN_RECEIPT_FILE: receipts,
          OPENAI_API_KEY: 'forbidden-private-reclaim-canary',
          PAPERCUSP_SUBSTRATE_IPC_SOCKET: '/forbidden-private-reclaim-canary.sock',
        },
      });
      observe(child);
      child.on('message', (message: any) => {
        if (message.kind !== 'isolated-runtime-start') return;
        try {
          const env = Object.fromEntries(readFileSync(`/proc/${message.childPid}/environ`, 'utf8')
            .split('\0').filter(Boolean).map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
          expect(env).not.toHaveProperty('OPENAI_API_KEY');
          expect(env).not.toHaveProperty('PAPERCUSP_SUBSTRATE_IPC_SOCKET');
          expect(env.HOME).not.toBe(process.env.HOME);
          expect(env.PAPERCUSP_HOME).toBe(join(env.HOME!, '.papercusp'));
          expect(env.PAPERCUSP_BACKGROUND_WORKERS).toBe('1');
          expect(env.PAPERCUSP_DBOS_ROUTINES).toBe('0');
          expect(env.PAPERCUSP_TEST_RUN_GROUP).toMatch(/^[0-9a-f-]{36}$/);
          expect(env.PAPERCUSP_TEST_RUN_GROUP).not.toBe(process.env.PAPERCUSP_TEST_RUN_GROUP);
          expect(new URL(env.HARNESS_ADMIN_DATABASE_URL!).port).toBe(String(message.pgPort));
          expect(env.PAPERCUSP_WORKSPACE_ID).toMatch(/^test-runtime-/);
          environmentObserved = true;
        } catch (error) { environmentError = error; }
      });
      try {
        const result = await captureIsolatedWorker(child, evidenceDir, options);
        expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
          timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
        expect(environmentError).toBeUndefined();
        expect(environmentObserved).toBe(true);
        const sourceMaps = [
          ['executed-source-map.json', selectedAssertion, selectedSource],
          ...(selection.census ? [['executed-source-map.1.json', censusAssertion, censusSource]] : []),
        ];
        for (const [mapFile, testFile, sourceFile] of sourceMaps) {
          const map = JSON.parse(readFileSync(join(evidenceDir, mapFile), 'utf8'));
          const original = map.rows.find((value: any) => value.testFile === testFile)?.sourceEvidence;
          expect(original?.status, mapFile).toBe('stable');
          expect(original.sources.find((value: any) => value.path === sourceFile), mapFile)
            .toMatchObject({ basis: 'vite-pre-transform',
              sha256: createHash('sha256').update(readFileSync(join(root, sourceFile))).digest('hex') });
          for (const observedSource of selection.observedSources ?? []) {
            expect(original.sources.find((value: any) => value.path === observedSource), mapFile)
              .toMatchObject({ basis: 'vite-pre-transform',
                sha256: createHash('sha256').update(readFileSync(join(root, observedSource))).digest('hex') });
          }
          if (sourceFile === reclaimSource) {
            expect(original.sources.find((value: any) => value.path === censusSource), mapFile)
              .toMatchObject({ basis: 'vite-pre-transform',
                sha256: createHash('sha256').update(readFileSync(join(root, censusSource))).digest('hex') });
          }
        }
        const rows = readFileSync(receipts, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const row = rows.find(value => value.filePath === selectedAssertion);
        expect(row).toMatchObject({ outcome: 'inserted', row: { status: 'pass', executionDetails: {
          passed: selection.expectedReclaimCases, failed: 0, collectionFailed: false,
        } } });
        for (const title of selection.reclaimTitles) expect(row.row.executionDetails.passedCaseTitles.some(
          (passed: string) => passed.includes(title))).toBe(true);
        if (selection.census) {
          const census = rows.find(value => value.filePath === censusAssertion);
          expect(census).toMatchObject({ outcome: 'inserted', row: { status: 'pass', executionDetails: {
            passed: 7, failed: 0, collectionFailed: false,
          } } });
          for (const title of censusSelected) expect(census.row.executionDetails.passedCaseTitles.some(
            (passed: string) => passed.includes(title))).toBe(true);
        }
        expect(result.output).toMatch(/TEST_FILE_RESULT[^\n]*status=passed[^\n]*childSubstituted=0/);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }
    },
  });
  // The maintained proof helper independently checks child identity, private
  // state writes, and runtimeRemoved/pgDataRemoved before returning this id.
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
};
it('reclaims private fixtures and reads back the exact durable receipt in the observed background runtime',
  context => runSelection({ reclaimTitles: [...selected, ...buildSelected, ...specialSelected, ...receiptSelected],
    expectedReclaimCases: selectedCount + buildSelectedCount + specialSelectedCount + receiptSelectedCount, census: true }, context),
  options.testTimeoutMs);
it('persists bounded delegate diagnostics in the observed private background runtime',
  context => runSelection({ reclaimTitles: ['persists delegate phases before the delegate ends', 'bounds delegate phase receipts and persisted writes'], expectedReclaimCases: 2, census: false }, context),
  options.testTimeoutMs);
it('retains open acceptance evidence through the observed private background runtime',
  context => runSelection({ reclaimTitles: ['retains old evidence bound to an open acceptance item'],
    expectedReclaimCases: 1, census: false,
    observedSources: ['packages/operator-core/lib/storage/retention-pins.ts'] }, context), options.testTimeoutMs);
it('accounts hardlinks and retained siblings in the observed private background runtime',
  context => runSelection({ reclaimTitles: hardlinkSelected, expectedReclaimCases: hardlinkSelectedCount, census: false }, context),
  options.testTimeoutMs);
it('accepts the real isolated privileged release holder scanner in the observed private background runtime',
  context => runSelection({ reclaimTitles: ['finds cwd executable and deleted fd holders through the real isolated privileged release scanner'], expectedReclaimCases: 1, census: false }, context),
  options.testTimeoutMs);
it('checkpoints productive scheduled effects and preserves standalone fairness in the observed private background runtime',
  context => runSelection({ reclaimTitles: [
    'checkpoints the first productive effect batch before a slow independent census',
    'bounds effect work per root, records the remainder and resumes from a fresh policy census',
  ], expectedReclaimCases: 2, census: false }, context), options.testTimeoutMs);
it('supervises release usage progress and refuses incomplete measurement in the observed private background runtime',
  context => runSelection({ assertion: releaseAssertion, source: releaseSource, reclaimTitles: [
    'finishes a productive usage walk past ten seconds',
    ...['missing-root', 'duplicate-root', 'malformed', 'outside-root', 'partial'].map(kind => `refuses ${kind} usage evidence before any removal`),
    'stops a still-productive usage walk at the existing shared run deadline',
    'does not let partial records or stderr noise renew an idle usage walk',
    'measures allocated bytes for descendant paths containing tabs and newlines',
    'charges shared hardlink allocation to pins before unpinned cuts',
    'waits for a pin writer before its final protection read',
  ], expectedReclaimCases: 11, census: false }, context), options.testTimeoutMs);
it('adopts scheduled release usage without overlapping workers and refreshes guards in the observed private background runtime',
  context => runSelection({ assertion: releaseAssertion, source: releaseSource, observedSources: [usageSource], reclaimTitles: [
    'adopts the same scheduled usage worker after a bounded wait and refuses a live changed population',
    ...['authored', 'published', 'lease', 'holder'].map(kind => `rechecks ${kind} protection after scheduled measurement before any removal`),
    'retires a terminal obsolete population before launching its replacement',
    'keeps a failed terminal measurement unknown and permits a fresh worker on the next call',
    'invalidates adopted usage before effects and measures the remaining pinned hardlinks in a fresh worker',
    'refuses a stale scheduled terminal receipt instead of assigning cap totals',
    'retains every cut when its execution deadline has already expired',
    ...['holder', 'archive'].map(phase => `rechecks its execution deadline after the ${phase} phase before admitting a removal`),
    'finishes an admitted cut removal but leaves the next cut for a fresh guarded plan after the shared deadline',
  ], expectedReclaimCases: 13, census: false }, context), options.testTimeoutMs);
