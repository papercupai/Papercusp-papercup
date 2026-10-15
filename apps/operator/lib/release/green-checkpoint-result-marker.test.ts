import { describe, expect, it } from 'vitest';

import { GREEN_CHECKPOINT_RESULT_MARKER } from '@papercusp/operator-core/lib/release/checkpoint-log-tags';
import {
  buildTerminalFailureCheckpointResult,
  CHECKPOINT_RESULT_MARKER_ATOMIC_BYTES,
  CHECKPOINT_RESULT_MARKER_SUMMARY_MAX_CHARS,
  checkpointResultMarkerLine,
  emitTerminalCheckpointResult,
  writeStdioFlushed,
  type CheckpointResult,
} from './green-checkpoint';

// WI-10005994 — the scheduled launcher runs the CLI as `2>&1 | sed -u`, so the ~170 KB pretty
// result on stderr and the stdout result marker share ONE pipe. An unawaited dump interleaved
// with a 65 KB repair-queue marker in chunks and tore the marker JSON mid-line (3 of 392 markers
// over 400 logs, every one a repair-queue verdict). These guards pin both halves of the fix:
// the marker waits for the dump to flush, and it is small enough for one atomic pipe write.

const base = (): CheckpointResult =>
  buildTerminalFailureCheckpointResult({
    candidate: '6ca43115268a',
    error: new Error('result marker fixture'),
    runId: 'run-014f2801',
  });

/** Field sizes copied from the measured repair-queue markers (2026-10-03 logs 7e644/79859/4e610). */
const heavyRepairVerdict = (): CheckpointResult => ({
  ...base(),
  green: false,
  reason: 'not-green',
  summary: 'S'.repeat(39_517),
  failingTests: ['apps/a.test.ts', 'apps/b.test.ts', 'apps/c.test.ts', 'apps/d.test.ts'],
  repairQueue: {
    schemaVersion: 1,
    candidate: '6ca43115268af8a9cbdb6789c51d24177068adb9',
    base: 'bcd70769a1b2c3d4e5f60718293a4b5c6d7e8f90',
    repairHead: 'c697f73983428b8d0183209224bebd905b7dbba8',
    phase: 'ready-to-verify',
    qualificationAttemptId: '014f2801-0000-4000-8000-000000000000',
    retestRequested: 'r'.repeat(140),
    failingTests: Array.from({ length: 4 }, (_, i) => `packages/operator-core/lib/x/f${i}.test.ts`),
    convergenceRounds: Array.from({ length: 8 }, (_, i) => ({
      round: i + 1,
      head: 'c697f73983428b8d0183209224bebd905b7dbba8',
      failing: 4,
      atMs: 1_791_000_000_000 + i,
    })),
    admissions: Array.from({ length: 200 }, (_, i) => ({ path: `p/${i}.ts`, hunks: 'h'.repeat(250) })),
    manifest: { files: Array.from({ length: 60 }, (_, i) => `manifest/file-${i}.ts`) },
    signature: 'x'.repeat(1_083),
  } as unknown as CheckpointResult['repairQueue'],
  repairTickLegs: {
    head: 'c697f73983428b8d0183209224bebd905b7dbba8',
    atMs: 1,
    ok: false,
    failingSignatures: ['sig'.repeat(100), 'lint:tsc'],
    legs: [{ id: 'lint:tsc', status: 'fail', durationMs: 5, outputTail: 'o'.repeat(8_000) }],
  } as unknown as CheckpointResult['repairTickLegs'],
});

const parseMarker = (line: string): Record<string, unknown> => {
  expect(line.startsWith(`${GREEN_CHECKPOINT_RESULT_MARKER} `)).toBe(true);
  return JSON.parse(line.slice(GREEN_CHECKPOINT_RESULT_MARKER.length + 1)) as Record<string, unknown>;
};

describe('WI-10005994: the stdout result marker survives the shared 2>&1 pipe', () => {
  it('keeps a heavy repair-queue verdict within one atomic pipe write and keeps every field a reader uses', () => {
    const result = heavyRepairVerdict();
    const line = checkpointResultMarkerLine(result);
    expect(Buffer.byteLength(`${line}\n`)).toBeLessThanOrEqual(CHECKPOINT_RESULT_MARKER_ATOMIC_BYTES);

    const marker = parseMarker(line);
    expect(marker).toMatchObject({
      reason: 'not-green',
      green: false,
      candidate: result.candidate,
      runId: 'run-014f2801',
      failingTests: result.failingTests,
    });
    const queue = marker.repairQueue as Record<string, unknown>;
    expect(queue).toMatchObject({
      candidate: '6ca43115268af8a9cbdb6789c51d24177068adb9',
      repairHead: 'c697f73983428b8d0183209224bebd905b7dbba8',
      phase: 'ready-to-verify',
    });
    expect(queue.convergenceRounds).toHaveLength(8);
    expect(queue).not.toHaveProperty('admissions');
    expect(queue).not.toHaveProperty('manifest');
    expect(queue).not.toHaveProperty('signature');
    expect((marker.summary as string).length).toBeLessThan(CHECKPOINT_RESULT_MARKER_SUMMARY_MAX_CHARS + 100);
    expect((marker.repairTickLegs as { legs: unknown[] }).legs).toEqual([
      { id: 'lint:tsc', status: 'fail', durationMs: 5 },
    ]);
    expect((marker.markerCompacted as { omitted: string[] }).omitted).toEqual(
      expect.arrayContaining(['summary(tail)', 'repairQueue.admissions', 'repairQueue.manifest', 'repairQueue.signature']),
    );
  });

  it('WI-10006005: bounds 500 failure and flake paths while leaving them recoverable from the run log', () => {
    const result: CheckpointResult = {
      ...base(),
      failingTests: Array.from(
        { length: 500 },
        (_, i) => 'packages/operator-core/lib/test-fixtures/failures/failure-' + i + '.test.ts',
      ),
      flakeSuspects: Array.from(
        { length: 500 },
        (_, i) => 'packages/operator-core/lib/test-fixtures/flakes/flake-' + i + '.test.ts',
      ),
    };
    const line = checkpointResultMarkerLine(result);
    expect(Buffer.byteLength(line + '\n')).toBeLessThanOrEqual(CHECKPOINT_RESULT_MARKER_ATOMIC_BYTES);

    const marker = parseMarker(line);
    expect(marker).not.toHaveProperty('failingTests');
    expect(marker).not.toHaveProperty('flakeSuspects');
    expect((marker.markerCompacted as { omitted: string[] }).omitted).toEqual(
      expect.arrayContaining(['failingTests', 'flakeSuspects']),
    );
    expect(result.failingTests).toHaveLength(500);
    expect(result.flakeSuspects).toHaveLength(500);
  });

  it('leaves an ordinary marker byte-identical to the uncompacted result', () => {
    const result = { ...base(), summary: 'short summary' };
    expect(checkpointResultMarkerLine(result)).toBe(`${GREEN_CHECKPOINT_RESULT_MARKER} ${JSON.stringify(result)}`);
  });

  it('does not begin writing the marker until the stderr dump has flushed', async () => {
    const order: string[] = [];
    let releaseHuman!: () => void;
    const humanFlushed = new Promise<void>((resolve) => {
      releaseHuman = resolve;
    });
    const done = emitTerminalCheckpointResult(heavyRepairVerdict(), {
      writeHuman: async () => {
        order.push('human:start');
        await humanFlushed;
        order.push('human:flushed');
      },
      writeMarker: (line) => {
        order.push(`marker:${line.slice(0, GREEN_CHECKPOINT_RESULT_MARKER.length)}`);
      },
      emitInconclusive: async () => {},
      retire: async () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['human:start']);
    releaseHuman();
    await done;
    expect(order).toEqual(['human:start', 'human:flushed', `marker:${GREEN_CHECKPOINT_RESULT_MARKER}`]);
  });

  it('writeStdioFlushed resolves on the stream write callback, and never hangs on a throwing stream', async () => {
    let flush: (() => void) | undefined;
    const pending = { write: (_text: string, cb: () => void) => ((flush = cb), false) };
    let resolved = false;
    const write = writeStdioFlushed(pending as never, 'x').then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(resolved).toBe(false);
    flush?.();
    await write;
    expect(resolved).toBe(true);

    const broken = {
      write: () => {
        throw new Error('EPIPE');
      },
    };
    await expect(writeStdioFlushed(broken as never, 'x')).resolves.toBeUndefined();
  });
});
