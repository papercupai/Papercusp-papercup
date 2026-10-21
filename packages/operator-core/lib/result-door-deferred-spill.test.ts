/**
 * WI-10004533 — the result-door spill write must not block the request worker's main thread.
 *
 * The synchronous mkdirSync + writeFileSync in writeScratchReference sat in D-state under
 * ext4/jbd2 contention long enough for the event-loop sentinel to SIGKILL the operator with
 * every in-flight MCP call. Request handlers now use applyResultDoorAsync: the spill is
 * written with fs.promises and awaited before the result is returned, so the cursor is
 * still valid when the client sees it, but the event loop is free while the disk is slow.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, mkdirSync: vi.fn(actual.mkdirSync), writeFileSync: vi.fn(actual.writeFileSync) };
});
import { CHARS_PER_TOKEN_ESTIMATE } from './context-doors';
import {
  applyResultDoor,
  applyResultDoorAsync,
  beginResultDoorAggregate,
  resetResultDoorAggregatesForTests,
  RESULT_DOOR_TOKENS,
  type DoorableResult,
} from './result-door';
import readTool from './agent-tools/capability/read';
import * as scratchGc from './scratch-gc';
import { _resetScratchUsageForTests, _setScratchUsageForTests, refreshScratchUsage, WORKSPACE_QUOTA_BYTES, writeWithScratchQuota } from './scratch-gc';
import * as scratchReference from './scratch-reference';
import type { ScratchWriteTimings } from './scratch-gc';

const { parseScratchReference, readVolatileScratchReference, writeScratchReference } = scratchReference;

const BUDGET_CHARS = RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE;
const RUN_ID = '11111111-2222-4333-8444-555555555555';
const OPTS = { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID } as const;

let sandbox: string;
let prevScratchRoot: string | undefined;
let prevKillSwitch: string | undefined;

function oversized() {
  const text = Array.from({ length: Math.ceil((BUDGET_CHARS * 3) / 40) }, (_, i) => `line ${i} of a very long tool result`)
    .join('\n');
  return { content: [{ type: 'text' as const, text }] };
}

function spillDir(toolName = 'plans:get'): string {
  return join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-1', toolName, RUN_ID);
}

function spillFiles(toolName = 'plans:get'): string[] {
  return existsSync(spillDir(toolName)) ? readdirSync(spillDir(toolName)) : [];
}

function volatileCursorFrom(out: DoorableResult): Record<string, unknown> {
  const metaCursor = (out as DoorableResult & {
    _meta?: { resultDoor?: { recoveryCursor?: Record<string, unknown> } };
  })._meta?.resultDoor?.recoveryCursor;
  if (metaCursor) return metaCursor;

  const item = out.content.find((candidate) => candidate.type === 'text');
  if (!item || item.type !== 'text' || typeof item.text !== 'string') {
    throw new Error('result has no text recovery envelope');
  }
  const envelope = JSON.parse(item.text) as {
    _projection?: { cursor?: Record<string, unknown> };
    content?: Array<{ kind?: unknown; uri?: unknown }>;
  };
  const cursor = envelope._projection?.cursor;
  if (cursor) return cursor;
  const reference = envelope.content?.find((entry) =>
    entry.kind === 'reference' && typeof entry.uri === 'string',
  );
  if (typeof reference?.uri === 'string') {
    return {
      kind: 'volatile-scratch-page',
      tool: 'capability:read',
      uri: reference.uri,
      args: { uri: reference.uri, byte_offset: 0, byte_limit: 3_072 },
    };
  }
  throw new Error('result has no recovery cursor');
}

function readVolatileText(cursor: Record<string, unknown>, workspaceId = 'ws-1', ownerId?: string): string {
  const args = cursor.args && typeof cursor.args === 'object'
    ? cursor.args as Record<string, unknown>
    : undefined;
  const uri = typeof cursor.uri === 'string'
    ? cursor.uri
    : typeof args?.uri === 'string'
      ? args.uri
      : undefined;
  if (!uri) throw new Error('volatile recovery cursor has no URI');

  const reference = readVolatileScratchReference(uri, { workspaceId, ownerId });
  const bodyOffset = reference.manifest.bodyOffsetInPayload ?? 0;
  const pageText = reference.payload.subarray(bodyOffset).toString('utf8');
  try {
    const envelope = JSON.parse(pageText) as { content?: Array<{ type?: unknown; text?: unknown }> };
    const text = envelope.content?.find((entry) => entry.type === 'text')?.text;
    if (typeof text === 'string') return text;
  } catch {
    // Plain-text spills have a framing prefix and are checked by substring.
  }
  return pageText;
}

beforeEach(() => {
  resetResultDoorAggregatesForTests();
  _resetScratchUsageForTests();
  sandbox = mkdtempSync(join(tmpdir(), 'papercusp-deferred-spill-test-'));
  prevScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
  process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, 'scratch');
  prevKillSwitch = process.env.PAPERCUSP_RESULT_DOOR_OFF;
  delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
});

afterEach(() => {
  if (prevScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
  else process.env.PAPERCUSP_SCRATCH_ROOT = prevScratchRoot;
  if (prevKillSwitch === undefined) delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
  else process.env.PAPERCUSP_RESULT_DOOR_OFF = prevKillSwitch;
  rmSync(sandbox, { recursive: true, force: true });
});

describe('result-door deferred spill (WI-10004533)', () => {
  it.each(['text', 'media'])('reports a persisted %s spill phase without allowing observer failure to lose the original payload', async (kind) => {
    const observed = vi.fn((_timings: ScratchWriteTimings) => { throw new Error('diagnostic observer failed'); });
    const original = kind === 'text' ? oversized().content[0].text : 'A'.repeat(BUDGET_CHARS * 3);
    const input = kind === 'text' ? { content: [{ type: 'text', text: original }] }
      : { content: [{ type: 'image', mimeType: 'image/png', data: original }] };
    const result = await applyResultDoorAsync<DoorableResult>(input, { ...OPTS, onScratchWriteTiming: observed });
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed.mock.calls[0][0]).toMatchObject({
      quotaWaitMs: expect.any(Number), refreshWaitMs: expect.any(Number),
      quotaRecoveryMs: expect.any(Number), writeMs: expect.any(Number), totalMs: expect.any(Number),
    });
    const path = (result._meta?.resultDoor as { spillPath?: string })?.spillPath;
    expect(parseScratchReference(readFileSync(path!))!.payload.toString()).toContain(original);
  });
  it('gives scratch-quota admission the full bounded spill-write budget', async () => {
    const writer = vi.spyOn(scratchGc, 'writeWithScratchQuota');
    try {
      await applyResultDoorAsync(oversized(), OPTS);

      expect(writer).toHaveBeenCalledWith(
        expect.objectContaining({ mutexTimeoutMs: 30_000 }),
        expect.any(Function),
      );
    } finally {
      // An unrestored spy leaks its call history into every later spyOn of the same export.
      writer.mockRestore();
    }
  });
  it('with a collector, the synchronous door performs NO filesystem write — the spill lands only when awaited', async () => {
    const deferred: Promise<void>[] = [];
    const out = applyResultDoor(oversized(), { ...OPTS, deferredScratchWrites: deferred });

    // The door already produced its bounded, spill-referencing result...
    expect(JSON.stringify(out)).toContain(RUN_ID);
    // ...but nothing was written on the synchronous path: the write is queued, not done.
    expect(deferred).toHaveLength(1);
    expect(spillFiles()).toHaveLength(0);

    await Promise.all(deferred);
    const files = spillFiles();
    expect(files).toHaveLength(1);
    const ref = parseScratchReference(readFileSync(join(spillDir(), files[0])));
    expect(ref).not.toBeNull();
    expect(ref!.payload.toString('utf8')).toContain('line 0 of a very long tool result');
  });

  it('applyResultDoorAsync resolves only after the spill exists, with the same result shape as the sync door', async () => {
    const asyncOut = await applyResultDoorAsync(oversized(), OPTS);
    const files = spillFiles();
    expect(files).toHaveLength(1);
    const ref = parseScratchReference(readFileSync(join(spillDir(), files[0])));
    expect(ref).not.toBeNull();
    // The cursor the client receives names the file that is now on disk.
    expect(JSON.stringify(asyncOut)).toContain(files[0]);

    resetResultDoorAggregatesForTests();
    const syncOut = applyResultDoor(oversized(), OPTS);
    expect(Object.keys(asyncOut).sort()).toEqual(Object.keys(syncOut).sort());
    expect(asyncOut.content.length).toBe(syncOut.content.length);
  });

  it('a result that fits writes nothing and resolves unchanged', async () => {
    const small = { content: [{ type: 'text' as const, text: 'short result' }] };
    const out = await applyResultDoorAsync(small, OPTS);
    expect(out.content).toEqual(small.content);
    expect(spillFiles()).toHaveLength(0);
  });

  it('a failed deferred write never yields a dangling cursor, and never surfaces as an unhandled rejection', async () => {
    // Scratch root UNDER A REGULAR FILE: every mkdir fails with ENOTDIR, async and sync alike.
    const blocker = join(sandbox, 'not-a-dir');
    writeFileSync(blocker, 'x');
    process.env.PAPERCUSP_SCRATCH_ROOT = join(blocker, 'scratch');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      vi.mocked(mkdirSync).mockClear();
      vi.mocked(writeFileSync).mockClear();
      const out = await applyResultDoorAsync(oversized(), OPTS);
      expect(vi.mocked(mkdirSync)).not.toHaveBeenCalled();
      expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
      // Still bounded (the cap applies even when the spill cannot be written, WI-36047)...
      expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(oversized()).length);
      // ...and it carries the honest spill-failure shape: no cursor/path, flagged failed.
      // (`_meta.resultDoor.spillError` legitimately names the failing path for operators;
      // the MODEL-FACING content must not advertise a file that is not there.)
      const meta = (out as { _meta?: { resultDoor?: {
        spillPath?: unknown;
        spillUri?: unknown;
        spillFailed?: unknown;
        spillPending?: unknown;
      } } })._meta
        ?.resultDoor;
      expect(meta?.spillFailed).toBe(true);
      expect(meta?.spillPending).not.toBe(true);
      expect(meta?.spillPath ?? null).toBeNull();
      expect(meta?.spillUri ?? null).toBeNull();
      expect(JSON.stringify(out.content)).not.toContain(blocker);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('keeps a pending cursor for nested coord:send without promising lossless recovery', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    let releaseWrite!: () => void;
    let signalStarted!: () => void;
    let resolveLateSettlement!: (settlement: {
      status: 'persisted' | 'failed';
      spillPath: string;
      spillUri: string;
      originalBytes: number;
      returnedContextBytes: number;
      reason: string;
      aggregateOutputEscape: boolean;
      errorCode?: string;
    }) => void;
    const writeStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const stalledWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const lateSettlement = new Promise<{
      status: 'persisted' | 'failed';
      spillPath: string;
      spillUri: string;
      originalBytes: number;
      returnedContextBytes: number;
      reason: string;
      aggregateOutputEscape: boolean;
      errorCode?: string;
    }>((resolve) => { resolveLateSettlement = resolve; });
    const writer = vi.spyOn(scratchGc, 'writeWithScratchQuota').mockImplementation((_opts, write) => {
      signalStarted();
      return stalledWrite.then(() => write(async (_phase, _subphase, operation) => operation()));
    });
    let resultPromise: Promise<DoorableResult> | undefined;
    try {
      resultPromise = applyResultDoorAsync({
        ...oversized(),
        _meta: { explicitFullRequest: true },
      }, {
        ...OPTS,
        toolName: 'tools:invoke',
        nestedTargetToolName: 'coord:send',
        onLateScratchWriteSettled: resolveLateSettlement,
      });
      await writeStarted;
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await resultPromise;
      const meta = (result._meta?.resultDoor as {
        spillFailed?: unknown;
        spillPending?: unknown;
        spillPath?: unknown;
        spillUri?: unknown;
        spillErrorCode?: unknown;
        recoveryCursor?: Record<string, unknown>;
      } | undefined);

      expect(writer).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('result-door scratch spill write exceeded 30000ms'));
      expect(meta).toMatchObject({ spillPending: true, spillFailed: false, spillErrorCode: 'ETIMEDOUT' });
      expect(meta?.spillPath).toEqual(expect.any(String));
      expect(meta?.spillUri).toEqual(expect.any(String));
      expect(meta?.recoveryCursor).toMatchObject({
        kind: 'pending-spill',
        path: meta?.spillPath,
        uri: meta?.spillUri,
        args: {
          uri: meta?.spillUri,
          byte_offset: 0,
          byte_limit: 3_072,
        },
      });
      expect(meta?.recoveryCursor?.args).not.toHaveProperty('file_path');
      expect(Object.keys(meta ?? {})).not.toContain('fallbackUri');
      const bodyItem = result.content.find((item) => item.type === 'text');
      if (typeof bodyItem?.text !== 'string') throw new Error('result has no text recovery envelope');
      const body = JSON.parse(bodyItem.text) as {
        incomplete?: { note?: string };
        _projection?: { cursor?: Record<string, unknown>; next?: string };
      };
      const recoveryNote = body.incomplete?.note ?? body._projection?.next;
      expect(typeof recoveryNote).toBe('string');
      if (typeof recoveryNote !== 'string') throw new Error('result has no text recovery note');
      expect(recoveryNote).toContain('not a durable recovery guarantee');
      expect(body._projection?.cursor).toMatchObject({ kind: 'pending-spill', uri: meta?.spillUri });
      expect(body._projection?.next).toContain('if late settlement reports failed, the overflow is unavailable');
      expect(body._projection?.next).toContain('delivery outcome may be unknown');
      expect(body._projection?.next).toContain('do NOT repeat the send');
      expect(body._projection?.next).toContain('coord:feed');
      expect(body._projection?.next).toContain('coord:inbox');
      expect(body._projection?.next).not.toContain('Do NOT repeat tools:invoke');
      expect(spillFiles('tools:invoke')).toHaveLength(0);

      releaseWrite();
      await expect(lateSettlement).resolves.toMatchObject({
        status: 'persisted',
        spillPath: meta?.spillPath,
        spillUri: meta?.spillUri,
        originalBytes: expect.any(Number),
        returnedContextBytes: expect.any(Number),
        reason: expect.any(String),
        aggregateOutputEscape: false,
      });
      expect(spillFiles('tools:invoke')).toHaveLength(1);

      // The pending cursor must remain directly executable after settlement. Using
      // its URI avoids the long absolute scratch path that can make a file_path
      // byte-page envelope itself exceed the result-door budget.
      const pageResult = await readTool.handler(meta!.recoveryCursor!.args as never, {
        projectDir: sandbox,
        workspaceId: 'ws-1',
      } as never) as { content: Array<{ type: 'text'; text: string }> };
      expect(JSON.parse(pageResult.content[0].text)).toMatchObject({ ok: true, eof: false });
    } finally {
      releaseWrite();
      await resultPromise?.catch(() => undefined);
      writer.mockRestore();
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('promotes a timed-out volatile fallback only after the primary scratch deadline', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    let rejectWrite!: (error: Error) => void;
    let signalStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const stalledWrite = new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
    const writer = vi.spyOn(scratchGc, 'writeWithScratchQuota').mockImplementation((_opts, write) => {
      signalStarted();
      return stalledWrite.then(() => write(async (_phase, _subphase, operation) => operation()));
    });
    const durableUri = scratchReference.DURABLE_SCRATCH_REFERENCE_SCHEME + '/' + 'a'.repeat(64);
    let persistedFallbackText: string | undefined;
    const durablePersist = vi.spyOn(
      scratchReference,
      'persistVolatileScratchReference',
    ).mockImplementation(async (uri, caller) => {
      persistedFallbackText = readVolatileText(
        { uri },
        caller.workspaceId ?? 'ws-1',
        caller.ownerId ?? undefined,
      );
      return { uri: durableUri, manifest: readVolatileScratchReference(uri, caller).manifest };
    });
    const original = oversized();
    let resultPromise: Promise<DoorableResult> | undefined;

    try {
      resultPromise = applyResultDoorAsync(original, { ...OPTS, ownerId: 'su-1' });
      await writeStarted;
      await vi.advanceTimersByTimeAsync(29_999);
      expect(durablePersist).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;
      expect(durablePersist).toHaveBeenCalledTimes(1);
      expect(durablePersist).toHaveBeenCalledWith(expect.stringMatching(/^papercusp:\/\/scratch-memory\//), {
        workspaceId: 'ws-1',
        ownerId: 'su-1',
      });

      const text = (result.content.find((item) => item.type === 'text') as { text: string }).text;
      const body = JSON.parse(text) as { _projection?: { cursor?: Record<string, unknown> } };
      const meta = result._meta?.resultDoor as {
        spillPending?: boolean;
        spillErrorCode?: string;
        durableFallbackUri?: string;
        recoveryCursor?: Record<string, unknown>;
        pendingSpill?: { cursor?: Record<string, unknown> };
      };
      expect(meta).toMatchObject({
        spillPending: true,
        spillErrorCode: 'ETIMEDOUT',
        durableFallbackUri: durableUri,
        recoveryCursor: { kind: 'durable-scratch-page', uri: durableUri },
        pendingSpill: { cursor: { kind: 'pending-spill', errorCode: 'ETIMEDOUT' } },
      });
      expect(body._projection?.cursor).toMatchObject({ kind: 'durable-scratch-page', uri: durableUri });
      expect(text).toContain('exact workspace-scoped durable copy');
      expect(text).not.toContain('papercusp://scratch-memory/');
      expect(persistedFallbackText).toContain(original.content[0].text);
    } finally {
      rejectWrite(new Error('test cleanup'));
      await resultPromise?.catch(() => undefined);
      writer.mockRestore();
      durablePersist.mockRestore();
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('keeps a structural scorecards:get fallback when the primary spill times out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    let releaseWrite!: () => void;
    let signalStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const stalledWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const writer = vi.spyOn(scratchGc, 'writeWithScratchQuota').mockImplementation((_opts, write) => {
      signalStarted();
      return stalledWrite.then(() => write(async (_phase, _subphase, operation) => operation()));
    });
    const durablePersist = vi.spyOn(
      scratchReference,
      'persistVolatileScratchReference',
    ).mockRejectedValue(new Error('test spool unavailable'));
    const evidence = 'e'.repeat(BUDGET_CHARS * 2);
    const originalText = JSON.stringify({
      ok: true,
      scorecard: {
        issueId: 'EI-structural-timeout',
        criteria: [{ key: 'traceability', rating: 'pass', evidence }],
      },
      evidenceRead: { complete: true, scope: 'selected-criterion', offset: 0, totalChars: evidence.length },
    });
    let resultPromise: Promise<DoorableResult> | undefined;

    try {
      resultPromise = applyResultDoorAsync(
        { content: [{ type: 'text' as const, text: originalText }], _meta: { explicitFullRequest: true } },
        {
          ...OPTS,
          toolName: 'tools:invoke',
          nestedTargetToolName: 'scorecards:get',
          ownerId: 'su-1',
        },
      );
      await writeStarted;
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await resultPromise;
      const cursor = volatileCursorFrom(result);
      const text = (result.content.find((item) => item.type === 'text') as { text: string }).text;
      const body = JSON.parse(text) as { _projection?: { cursor?: Record<string, unknown> } };
      const meta = result._meta?.resultDoor as {
        spillPending?: boolean;
        spillFailed?: boolean;
        pendingSpill?: { cursor?: Record<string, unknown> };
      };

      // Before fallbackRecoveryCursor(), the old code returned pendingResult here because
      // scorecards:get stores its recovery cursor in the model-facing _projection.
      expect(cursor).toMatchObject({ kind: 'volatile-scratch-page', tool: 'capability:read' });
      expect(body._projection?.cursor).toMatchObject({ kind: 'volatile-scratch-page' });
      expect(meta).toMatchObject({
        spillPending: true,
        spillFailed: false,
        pendingSpill: { cursor: { kind: 'pending-spill', errorCode: 'ETIMEDOUT' } },
      });
      expect(readVolatileText(cursor, 'ws-1', 'su-1')).toContain(evidence);
      expect(durablePersist).toHaveBeenCalledTimes(1);
    } finally {
      releaseWrite();
      await resultPromise?.catch(() => undefined);
      writer.mockRestore();
      durablePersist.mockRestore();
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('keeps work_items:get checkpoint and comment recovery when the primary spill times out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    let rejectWrite!: (error: Error) => void;
    let signalStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const stalledWrite = new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
    const writer = vi.spyOn(scratchGc, 'writeWithScratchQuota').mockImplementation((_opts, write) => {
      signalStarted();
      return stalledWrite.then(() => write(async (_phase, _subphase, operation) => operation()));
    });
    const durablePersist = vi.spyOn(
      scratchReference,
      'persistVolatileScratchReference',
    ).mockRejectedValue(new Error('test spool unavailable'));
    const checkpoint = 'RETAINED-CHECKPOINT-BEGIN\n' + 'next step: verify the current work-item receipt.\n'.repeat(500);
    const comment = 'RETAINED-COMMENT: reviewer requested a current-build reproduction.';
    const originalText = JSON.stringify({
      ok: true,
      results: [{
        id: 'EI-checkpoint-timeout',
        ok: true,
        workItem: {
          id: 'EI-checkpoint-timeout',
          kind: 'bug',
          state: 'open',
          title: 'large work item read',
          summary: 'S'.repeat(1_200),
        },
        checkpoint,
        checkpointContentHash: 'checkpoint-hash-timeout',
        threadWindow: {
          total: 1,
          shown: 1,
          posts: [{ id: 42, author_id: 'su-reviewer', body: comment }],
        },
      }],
      counts: { ok: 1, failed: 0 },
    });
    expect(originalText.length).toBeGreaterThan(BUDGET_CHARS);
    let resultPromise: Promise<DoorableResult> | undefined;

    try {
      resultPromise = applyResultDoorAsync(
        { content: [{ type: 'text' as const, text: originalText }] },
        {
          ...OPTS,
          toolName: 'work_items:get',
          ownerId: 'su-1',
          preservePaths: ['results[].checkpoint', 'results[].threadWindow.posts[].body'],
        },
      );
      await writeStarted;
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await resultPromise;
      const cursor = volatileCursorFrom(result);
      const meta = result._meta?.resultDoor as {
        spillPending?: boolean;
        spillFailed?: boolean;
        spillErrorCode?: string;
        recoveryCursor?: Record<string, unknown>;
        pendingSpill?: { cursor?: Record<string, unknown> };
      };

      expect(meta).toMatchObject({
        spillPending: true,
        spillFailed: false,
        spillErrorCode: 'ETIMEDOUT',
        pendingSpill: { cursor: { kind: 'pending-spill', errorCode: 'ETIMEDOUT' } },
      });
      expect(cursor).toMatchObject({ kind: 'volatile-scratch-page', tool: 'capability:read' });
      expect(meta.recoveryCursor).toMatchObject(cursor);
      const recovered = readVolatileText(cursor, 'ws-1', 'su-1');
      expect(recovered).toContain('RETAINED-CHECKPOINT-BEGIN');
      expect(recovered).toContain(comment);
      expect(durablePersist).toHaveBeenCalledTimes(1);
    } finally {
      rejectWrite(new Error('test cleanup'));
      await resultPromise?.catch(() => undefined);
      writer.mockRestore();
      durablePersist.mockRestore();
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('attaches the pending spill cursor to a durable reference-envelope fallback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    let rejectWrite!: (error: Error) => void;
    let signalStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const stalledWrite = new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
    const writer = vi.spyOn(scratchGc, 'writeWithScratchQuota').mockImplementation((_opts, write) => {
      signalStarted();
      return stalledWrite.then(() => write(async (_phase, _subphase, operation) => operation()));
    });
    const durableUri = scratchReference.DURABLE_SCRATCH_REFERENCE_SCHEME + '/' + 'b'.repeat(64);
    const durablePersist = vi.spyOn(
      scratchReference,
      'persistVolatileScratchReference',
    ).mockImplementation(async (uri, caller) => ({
      uri: durableUri,
      manifest: readVolatileScratchReference(uri, caller).manifest,
    }));
    const original: DoorableResult = {
      content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(BUDGET_CHARS * 3) }],
    };
    let resultPromise: Promise<DoorableResult> | undefined;

    try {
      resultPromise = applyResultDoorAsync(original, { ...OPTS, ownerId: 'su-1' });
      await writeStarted;
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await resultPromise;
      const meta = result._meta?.resultDoor as {
        durableFallbackUri?: string;
        pendingSpill?: { cursor?: Record<string, unknown> };
        recoveryCursor?: Record<string, unknown>;
        spillFailed?: boolean;
        spillPending?: boolean;
      };
      const envelope = JSON.parse((result.content.find((item) => item.type === 'text') as { text: string }).text);

      expect(durablePersist).toHaveBeenCalledTimes(1);
      expect(meta).toMatchObject({
        durableFallbackUri: durableUri,
        spillFailed: false,
        spillPending: true,
        recoveryCursor: {
          kind: 'durable-scratch-page',
          tool: 'capability:read',
          uri: durableUri,
          args: { uri: durableUri, byte_offset: 0, byte_limit: 3_072 },
        },
        pendingSpill: { cursor: { kind: 'pending-spill', errorCode: 'ETIMEDOUT' } },
      });
      expect(envelope.content).toContainEqual(expect.objectContaining({ kind: 'reference', uri: durableUri }));
      expect(JSON.stringify(envelope)).not.toContain('papercusp://scratch-memory/');
    } finally {
      rejectWrite(new Error('test cleanup'));
      await resultPromise?.catch(() => undefined);
      writer.mockRestore();
      durablePersist.mockRestore();
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('keeps a durable fallback on an under-budget partial conversations:get envelope after spill timeout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    let rejectWrite!: (error: Error) => void;
    let signalStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const stalledWrite = new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
    const writer = vi.spyOn(scratchGc, 'writeWithScratchQuota').mockImplementation((_opts, write) => {
      signalStarted();
      return stalledWrite.then(() => write(async (_phase, _subphase, operation) => operation()));
    });
    const durableUri = scratchReference.DURABLE_SCRATCH_REFERENCE_SCHEME + '/' + 'c'.repeat(64);
    let persistedFallbackText: string | undefined;
    const durablePersist = vi.spyOn(
      scratchReference,
      'persistVolatileScratchReference',
    ).mockImplementation(async (uri, caller) => {
      persistedFallbackText = readVolatileText({ uri }, caller.workspaceId ?? 'ws-1', caller.ownerId ?? undefined);
      return { uri: durableUri, manifest: readVolatileScratchReference(uri, caller).manifest };
    });
    const sourceText = JSON.stringify({ results: [{ id: 'thread-post:1182706', post: { body: 'review evidence' } }] });
    const original: DoorableResult = {
      content: [{ type: 'text', text: sourceText }],
      _meta: { payloadProjection: { truncated: true, originalChars: 4_000, returnedChars: sourceText.length, omittedCount: 1 } },
    };
    expect(Buffer.byteLength(sourceText, 'utf8')).toBeLessThan(BUDGET_CHARS);
    let resultPromise: Promise<DoorableResult> | undefined;

    try {
      resultPromise = applyResultDoorAsync(original, {
        ...OPTS,
        toolName: 'tools:invoke',
        nestedTargetToolName: 'conversations:get',
        effect: 'read',
        ownerId: 'su-1',
      });
      await writeStarted;
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await resultPromise;
      const envelope = JSON.parse((result.content.find((item) => item.type === 'text') as { text: string }).text) as {
        state: string;
        content: Array<{ uri?: string }>;
        incomplete: { reason: string; recoverable: boolean; note: string };
      };
      const meta = result._meta?.resultDoor as {
        spillUri?: string;
        durableFallbackUri?: string;
        recoveryCursor?: Record<string, unknown>;
        pendingSpill?: { uri?: string; cursor?: Record<string, unknown> };
      };
      const referenceUris = envelope.content.map((item) => item.uri).filter((uri): uri is string => Boolean(uri));

      expect(envelope).toMatchObject({
        state: 'incomplete',
        incomplete: { reason: 'under-budget-partial-result', recoverable: false },
      });
      expect(envelope.incomplete.note).toContain('exact workspace-scoped durable copy');
      expect(durablePersist).toHaveBeenCalledTimes(1);
      expect(meta).toMatchObject({
        durableFallbackUri: durableUri,
        recoveryCursor: { kind: 'durable-scratch-page', uri: durableUri },
        pendingSpill: { cursor: { kind: 'pending-spill', errorCode: 'ETIMEDOUT' } },
      });
      expect(referenceUris).toContain(durableUri);
      expect(referenceUris).not.toContain(meta.spillUri);
      expect(meta.pendingSpill?.uri).toBe(meta.spillUri);
      expect(persistedFallbackText).toContain(sourceText);
    } finally {
      rejectWrite(new Error('test cleanup'));
      await resultPromise?.catch(() => undefined);
      writer.mockRestore();
      durablePersist.mockRestore();
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('keeps volatile recovery when durable timeout persistence exceeds its separate bound', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    let rejectWrite!: (error: Error) => void;
    let signalStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const stalledWrite = new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
    const writer = vi.spyOn(scratchGc, 'writeWithScratchQuota').mockImplementation((_opts, write) => {
      signalStarted();
      return stalledWrite.then(() => write(async (_phase, _subphase, operation) => operation()));
    });
    const durablePersist = vi.spyOn(
      scratchReference,
      'persistVolatileScratchReference',
    ).mockImplementation(() => new Promise(() => {}));
    const original = oversized();
    let settled = false;
    let resultPromise: Promise<DoorableResult> | undefined;

    try {
      resultPromise = applyResultDoorAsync(original, { ...OPTS, ownerId: 'su-1' }).then((result) => {
        settled = true;
        return result;
      });
      await writeStarted;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(durablePersist).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;
      const meta = result._meta?.resultDoor as { spillPending?: boolean; recoveryCursor?: Record<string, unknown> };
      expect(settled).toBe(true);
      expect(meta.spillPending).toBe(true);
      expect(meta.recoveryCursor).toMatchObject({
        kind: 'volatile-scratch-page',
        tool: 'capability:read',
      });
      expect(readVolatileText(meta.recoveryCursor!, 'ws-1', 'su-1')).toContain(original.content[0].text);
    } finally {
      rejectWrite(new Error('test cleanup'));
      await resultPromise?.catch(() => undefined);
      writer.mockRestore();
      durablePersist.mockRestore();
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it.each(['plans:get', 'events:status', 'work_items:list', 'coord:read'] as const)(
    'preserves the full volatile recovery for nested tools:invoke %s when a timed-out spill later fails',
    async (nestedTargetToolName) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    let rejectWrite!: (error: Error) => void;
    let signalStarted!: () => void;
    let resolveLateSettlement!: (settlement: {
      status: 'persisted' | 'failed';
      spillPath: string;
      spillUri: string;
      originalBytes: number;
      returnedContextBytes: number;
      reason: string;
      aggregateOutputEscape: boolean;
      errorCode?: string;
    }) => void;
    const writeStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const stalledWrite = new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
    const lateSettlement = new Promise<{
      status: 'persisted' | 'failed';
      spillPath: string;
      spillUri: string;
      originalBytes: number;
      returnedContextBytes: number;
      reason: string;
      aggregateOutputEscape: boolean;
      errorCode?: string;
    }>((resolve) => { resolveLateSettlement = resolve; });
    const writer = vi.spyOn(scratchGc, 'writeWithScratchQuota').mockImplementation((_opts, write) => {
      signalStarted();
      return stalledWrite.then(() => write(async (_phase, _subphase, operation) => operation()));
    });
    const durablePersist = vi.spyOn(
      scratchReference,
      'persistVolatileScratchReference',
    ).mockRejectedValue(new Error('test spool unavailable'));
    let resultPromise: Promise<DoorableResult> | undefined;
    const original = oversized();
    try {
      resultPromise = applyResultDoorAsync(original, {
        ...OPTS,
        toolName: 'tools:invoke',
        nestedTargetToolName,
        onLateScratchWriteSettled: resolveLateSettlement,
      });
      await writeStarted;
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await resultPromise;
      const meta = result._meta?.resultDoor as {
        spillPending?: boolean;
        spillFailed?: boolean;
        spillErrorCode?: string;
        pendingSpill?: { path?: string; uri?: string; cursor?: Record<string, unknown> };
      } | undefined;
      const volatileCursor = volatileCursorFrom(result);
      expect(meta).toMatchObject({
        spillPending: true,
        spillFailed: false,
        spillErrorCode: 'ETIMEDOUT',
        pendingSpill: {
          path: expect.any(String),
          uri: expect.any(String),
          cursor: { kind: 'pending-spill', errorCode: 'ETIMEDOUT' },
        },
      });
      expect(volatileCursor).toMatchObject({
        kind: 'volatile-scratch-page',
        tool: 'capability:read',
        reason: 'spill-write-failed',
        errorCode: 'ETIMEDOUT',
      });
      // Text spill pages carry the documented result-door framing before the
      // original body; the entire source text must still be present byte-for-byte.
      expect(readVolatileText(volatileCursor)).toContain(original.content[0].text);
      expect(JSON.stringify(result.content)).toContain('exact in-process copy is available');

      const failure = Object.assign(new Error('disk write rejected'), { code: 'EIO' });
      rejectWrite(failure);
      await expect(lateSettlement).resolves.toMatchObject({
        status: 'failed',
        spillPath: meta?.pendingSpill?.path,
        spillUri: meta?.pendingSpill?.uri,
        errorCode: 'EIO',
      });
      expect(readVolatileText(volatileCursor)).toContain(original.content[0].text);
      expect(JSON.stringify(result.content)).not.toContain('if late settlement reports failed, the overflow is unavailable');
      expect(spillFiles()).toHaveLength(0);
    } finally {
      rejectWrite(new Error('test cleanup'));
      await resultPromise?.catch(() => undefined);
      writer.mockRestore();
      durablePersist.mockRestore();
      vi.useRealTimers();
      warn.mockRestore();
    }
    },
  );

  it('keeps a selected nested tools:invoke string recoverable when scratch spilling fails', async () => {
    const selectedBody = 'conversation detail line\n'.repeat(Math.ceil((BUDGET_CHARS * 1.5) / 24));
    const originalText = JSON.stringify({ results: [{ post: { body: selectedBody } }] });
    expect(originalText.length).toBeGreaterThan(BUDGET_CHARS);
    writeFileSync(process.env.PAPERCUSP_SCRATCH_ROOT!, 'not a directory');

    const result: DoorableResult = await applyResultDoorAsync(
      { content: [{ type: 'text' as const, text: originalText }] },
      {
        ...OPTS,
        toolName: 'tools:invoke',
        nestedTargetToolName: 'conversations:get',
        preservePaths: ['results[].post.body'],
      },
    );
    const text = (result.content.find((item) => item.type === 'text') as { text: string }).text;
    const body = JSON.parse(text) as {
      _projection?: { cursor?: Record<string, unknown> };
    };
    const cursor = volatileCursorFrom(result);

    expect(cursor).toMatchObject({
      kind: 'volatile-scratch-page',
      tool: 'capability:read',
      reason: 'spill-write-failed',
      errorCode: 'ENOTDIR',
    });
    expect(body._projection?.cursor).toMatchObject({ kind: 'volatile-scratch-page' });
    const recovered = JSON.parse(readVolatileText(cursor)) as {
      results: Array<{ post: { body: string } }>;
    };
    expect(recovered.results[0]?.post.body).toBe(selectedBody);
    expect(text.length).toBeLessThan(originalText.length);
    expect(result._meta?.resultDoor).toMatchObject({ spillFailed: true, spillPath: null, spillUri: null });
  });

  it('preserves a work_items:release outcome when its timed-out spill has no volatile fallback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    let rejectWrite!: (error: Error) => void;
    let signalStarted!: () => void;
    let resolveLateSettlement!: (settlement: {
      status: 'persisted' | 'failed';
      spillPath: string;
      spillUri: string;
      originalBytes: number;
      returnedContextBytes: number;
      reason: string;
      aggregateOutputEscape: boolean;
      errorCode?: string;
    }) => void;
    const writeStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const stalledWrite = new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
    const lateSettlement = new Promise<{
      status: 'persisted' | 'failed';
      spillPath: string;
      spillUri: string;
      originalBytes: number;
      returnedContextBytes: number;
      reason: string;
      aggregateOutputEscape: boolean;
      errorCode?: string;
    }>((resolve) => { resolveLateSettlement = resolve; });
    const writer = vi.spyOn(scratchGc, 'writeWithScratchQuota').mockImplementation((_opts, write) => {
      signalStarted();
      return stalledWrite.then(() => write(async (_phase, _subphase, operation) => operation()));
    });
    const volatileStore = vi.spyOn(scratchReference, 'storeVolatileScratchReference').mockReturnValue(null);
    const id = 'EI-release-spill-receipt-1';
    const receipt = {
      ok: true,
      results: [{
        ok: true,
        id,
        released: true,
        previousAssignee: 'su-prior-holder',
        claimHold: false,
        workItem: {
          id,
          state: 'open',
          assignee: null,
          harness: 'papercusp',
          checkpoint: 'release response detail '.repeat(BUDGET_CHARS),
        },
      }],
      counts: { ok: 1, failed: 0 },
    };
    const originalText = JSON.stringify(receipt);
    const original = { content: [{ type: 'text' as const, text: originalText }] };
    let resultPromise: Promise<DoorableResult> | undefined;
    try {
      expect(originalText.length).toBeGreaterThan(BUDGET_CHARS);
      resultPromise = applyResultDoorAsync(original, {
        ...OPTS,
        toolName: 'tools:invoke',
        nestedTargetToolName: 'work_items:release',
        onLateScratchWriteSettled: resolveLateSettlement,
      });
      await writeStarted;
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await resultPromise;
      const text = (result.content.find((item) => item.type === 'text') as { text: string }).text;
      const body = JSON.parse(text) as {
        results: Array<Record<string, any>>;
        _projection: { cursor: Record<string, any>; next: string; truncated: boolean };
      };

      expect(body.results[0]).toMatchObject({
        ok: true,
        id,
        released: true,
        previousAssignee: 'su-prior-holder',
        claimHold: false,
        workItem: { id, state: 'open', assignee: null, harness: 'papercusp' },
      });
      expect(body._projection).toMatchObject({
        truncated: true,
        cursor: {
          kind: 'release-outcome-check',
          tool: 'work_items:get',
          args: { ids: [id], harness: 'papercusp' },
        },
      });
      expect(body._projection.next).toContain('Do NOT repeat this call');
      expect(body._projection.next).toContain('work_items:get');
      expect(result._meta?.resultDoor).toMatchObject({
        spillPending: true,
        spillErrorCode: 'ETIMEDOUT',
        pendingSpill: {
          path: expect.any(String),
          uri: expect.any(String),
          cursor: { kind: 'pending-spill', errorCode: 'ETIMEDOUT' },
        },
      });
      expect(text.length).toBeLessThan(originalText.length);

      rejectWrite(Object.assign(new Error('disk write rejected'), { code: 'EIO' }));
      await expect(lateSettlement).resolves.toMatchObject({ status: 'failed', errorCode: 'EIO' });
    } finally {
      rejectWrite(new Error('test cleanup'));
      await resultPromise?.catch(() => undefined);
      writer.mockRestore();
      volatileStore.mockRestore();
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('keeps a no-code spill failure diagnosable in the model-facing cursor without exposing the scratch path', () => {
    const scratchRunDir = spillDir();
    const failure = new Error(`writer rejected directory '${scratchRunDir}'`);
    failure.name = 'ScratchWriteError';
    const out = applyResultDoor(oversized(), {
      ...OPTS,
      scratchWriteFailure: { error: failure },
    });
    const text = (out.content.find((item) => item.type === 'text') as { text: string }).text;
    const body = JSON.parse(text) as { _projection?: { cursor?: Record<string, unknown>; next?: string } };
    const cursor = volatileCursorFrom(out);

    expect(body._projection?.cursor).toMatchObject({
      kind: 'volatile-scratch-page',
      tool: 'capability:read',
      reason: 'spill-write-failed',
      errorDetail: 'ScratchWriteError: writer rejected directory \'<scratch path>\'',
    });
    expect(body._projection?.next).toContain('ScratchWriteError: writer rejected directory');
    expect(body._projection?.next).not.toContain(scratchRunDir);
    expect(text).not.toContain(scratchRunDir);
    expect(readVolatileText(cursor)).toContain(oversized().content[0].text);
  });

  it('keeps an explicit-full result bounded and diagnosable when its asynchronous spill rejects without an error code', async () => {
    const scratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT!;
    const failure = new Error(`writer rejected directory '${scratchRoot}'`);
    failure.name = 'ScratchWriteError';
    const writer = vi.spyOn(scratchGc, 'writeWithScratchQuota').mockRejectedValue(failure);
    try {
      const original = JSON.stringify({
        ok: true,
        results: [{
          id: 'EI-checkpoint-1',
          ok: true,
          availability: 'available',
          checkpoint: 'resume this exact checkpoint',
          workItem: { id: 'EI-checkpoint-1', title: 'Large record', state: 'open', summary: 's'.repeat(BUDGET_CHARS * 2) },
        }],
        counts: { ok: 1, failed: 0 },
      });
      expect(original.length).toBeGreaterThan(BUDGET_CHARS);
      const out: DoorableResult = await applyResultDoorAsync({
        content: [{ type: 'text' as const, text: original }],
        _meta: { explicitFullRequest: true },
      }, { ...OPTS, toolName: 'work_items:get' });
      const text = (out.content[0] as { text: string }).text;
      const cursor = volatileCursorFrom(out);
      const envelope = JSON.parse(text) as {
        results: Array<{ id: string; checkpoint: string }>;
        _projection: { truncated: boolean; cursor: Record<string, unknown>; next: string };
      };

      expect(writer).toHaveBeenCalledTimes(1);
      expect(envelope._projection).toMatchObject({
        truncated: true,
        cursor: {
          kind: 'volatile-scratch-page',
          tool: 'capability:read',
          reason: 'spill-write-failed',
          errorDetail: "ScratchWriteError: writer rejected directory '<scratch path>'",
        },
      });
      expect(envelope.results[0]).toMatchObject({
        id: 'EI-checkpoint-1',
        checkpoint: 'resume this exact checkpoint',
      });
      expect(text.length).toBeLessThan(original.length);
      expect(envelope._projection.next).toContain('work_items:get');
      expect(envelope._projection.next).toContain('ScratchWriteError: writer rejected directory');
      expect(readVolatileText(cursor)).toBe(original);
      expect(text).not.toContain(scratchRoot);
      expect(out._meta?.resultDoor).toMatchObject({
        spillFailed: true,
        spillPath: null,
        spillUri: null,
      });
      expect(spillFiles()).toHaveLength(0);
    } finally {
      writer.mockRestore();
    }
  });

  it('recovers quota pressure before returning a readable asynchronous spill cursor', async () => {
    const old = join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-1', 'history', 'old');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'data'), '');
    truncateSync(join(old, 'data'), WORKSPACE_QUOTA_BYTES);
    const past = (Date.now() - 10_000) / 1000;
    utimesSync(old, past, past);
    await refreshScratchUsage('ws-1');
    const out = await applyResultDoorAsync(oversized(), OPTS);
    expect(existsSync(old)).toBe(false);
    const files = spillFiles();
    expect(files).toHaveLength(1);
    expect(JSON.stringify(out)).toContain(files[0]);
    expect(parseScratchReference(readFileSync(join(spillDir(), files[0])))!.payload.toString()).toContain('line 0');
  });

  it('returns a readable spill after an active reservation releases the workspace mutex', async () => {
    const writerDir = join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-1', 'writers', RUN_ID);
    mkdirSync(writerDir, { recursive: true });
    _setScratchUsageForTests('ws-1', 0);
    let finish!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const heldPath = join(writerDir, 'held');
    const held = writeWithScratchQuota({ workspaceId: 'ws-1', filePath: heldPath, bytes: 512 }, async () => {
      started();
      await new Promise<void>((resolve) => { finish = resolve; });
      await writeFile(heldPath, Buffer.alloc(512));
    });
    await began;
    _setScratchUsageForTests('ws-1', 5_400_804_525);
    let signalSpillWriter!: () => void;
    const spillWriterStarted = new Promise<void>((resolve) => { signalSpillWriter = resolve; });
    const originalWriteWithScratchQuota = scratchGc.writeWithScratchQuota;
    const spillWriter = vi.spyOn(scratchGc, 'writeWithScratchQuota').mockImplementation((opts, write) => {
      const pending = originalWriteWithScratchQuota(opts, write);
      if (opts.filePath !== heldPath) signalSpillWriter();
      return pending;
    });
    let spill: Promise<DoorableResult> | undefined;
    try {
      spill = applyResultDoorAsync(oversized(), OPTS);
      await spillWriterStarted;
      finish();
      const out = await spill;
      const files = spillFiles();
      expect(files).toHaveLength(1);
      expect(JSON.stringify(out)).toContain(files[0]);
      expect(JSON.stringify(out)).not.toContain('SCRATCH_QUOTA_EXCEEDED');
      expect(parseScratchReference(readFileSync(join(spillDir(), files[0])))!.payload.toString()).toContain('line 0');
    } finally {
      finish();
      await held;
      await spill?.catch(() => undefined);
      spillWriter.mockRestore();
    }
    await refreshScratchUsage('ws-1');
  });

  it('reports the quota cause without a dangling cursor when no FIFO run can be reclaimed', async () => {
    const root = join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-1');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'unmanaged'), '');
    truncateSync(join(root, 'unmanaged'), WORKSPACE_QUOTA_BYTES);
    await refreshScratchUsage('ws-1');
    const out = await applyResultDoorAsync(oversized(), OPTS);
    const meta = (out as { _meta?: { resultDoor?: { spillFailed?: boolean; spillErrorCode?: string; spillError?: string; spillPath?: string } } })._meta?.resultDoor;
    const cursor = volatileCursorFrom(out);
    expect(meta?.spillFailed).toBe(true);
    expect(meta?.spillErrorCode).toBe('SCRATCH_QUOTA_EXCEEDED');
    expect(meta?.spillError).toMatch(/^scratch reservation: workspace ws-1 used \d+ \+ \d+ > quota 5368709120$/);
    expect(meta?.spillPath ?? null).toBeNull();
    expect(JSON.stringify(out.content)).toContain('SCRATCH_QUOTA_EXCEEDED');
    expect(readVolatileText(cursor)).toContain(oversized().content[0].text);
    expect(spillFiles()).toHaveLength(0);

    const completionPayload = {
      ok: true,
      results: [{
        ok: true,
        id: 'EI-completion-quota-1',
        completionAuthority: 'committed',
        countsTowardBurnDown: true,
        workItem: { id: 'EI-completion-quota-1', state: 'resolved' },
        completion: { summary: 'C'.repeat(BUDGET_CHARS * 3) },
      }],
      counts: { ok: 1, failed: 0 },
    };
    const completionOriginal = JSON.stringify(completionPayload);
    const completionOut = await applyResultDoorAsync(
      { content: [{ type: 'text' as const, text: completionOriginal }] },
      { ...OPTS, toolName: 'work_items:complete' },
    );
    const completionMeta = (completionOut as { _meta?: { resultDoor?: Record<string, unknown> } })._meta?.resultDoor;
    const completionReceipt = JSON.parse((completionOut.content[0] as { text: string }).text) as {
      results: Array<Record<string, any>>;
      _projection: { truncated: boolean; cursor: Record<string, unknown>; next: string };
    };
    const completionCursor = volatileCursorFrom(completionOut);
    expect(completionMeta).toMatchObject({
      spillFailed: true,
      spillErrorCode: 'SCRATCH_QUOTA_EXCEEDED',
      spillPath: null,
      spillUri: null,
    });
    expect(completionReceipt.results[0]).toMatchObject({
      ok: true,
      id: 'EI-completion-quota-1',
      completionAuthority: 'committed',
      countsTowardBurnDown: true,
      workItem: { id: 'EI-completion-quota-1', state: 'resolved' },
    });
    expect(completionReceipt.results[0].completion.summary).toContain('TRUNCATED');
    expect(completionReceipt.results[0].completion.summary.length).toBeLessThan(1_200);
    expect(completionReceipt._projection).toMatchObject({
      truncated: true,
      cursor: { kind: 'volatile-scratch-page', tool: 'capability:read', reason: 'spill-write-failed', errorCode: 'SCRATCH_QUOTA_EXCEEDED' },
    });
    expect(completionReceipt._projection.next).toContain('Do NOT repeat this call');
    expect(completionReceipt._projection.next).toContain('work_items:get');
    expect(readVolatileText(completionCursor)).toBe(completionOriginal);
    expect(JSON.stringify(completionOut.content).length).toBeLessThan(completionOriginal.length);
    expect(spillFiles()).toHaveLength(0);

    // Non-text overflow uses the hard-envelope branch; its error must retain the same cause.
    const hard = await applyResultDoorAsync({ content: [{ type: 'image' as const,
      mimeType: 'image/png', data: 'A'.repeat(BUDGET_CHARS * 3) }] }, OPTS);
    const hardMeta = (hard as { _meta?: { resultDoor?: { spillErrorCode?: string } } })._meta?.resultDoor;
    const hardCursor = volatileCursorFrom(hard);
    expect(hardMeta?.spillErrorCode).toBe('SCRATCH_QUOTA_EXCEEDED');
    expect(hardCursor).toMatchObject({ kind: 'volatile-scratch-page', tool: 'capability:read' });
    expect(readVolatileText(hardCursor)).toContain('A'.repeat(BUDGET_CHARS * 3));
    expect(spillFiles()).toHaveLength(0);
  });

  it('preserves a committed peer-review claim receipt when scratch quota prevents paging', async () => {
    const root = join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-1');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'unmanaged'), '');
    truncateSync(join(root, 'unmanaged'), WORKSPACE_QUOTA_BYTES);
    await refreshScratchUsage('ws-1');

    const claim = {
      ok: true,
      mode: 'claim-next',
      claimed: true,
      workItem: {
        id: 'WI-review-claim-1',
        title: 'review a large submission',
        harness: 'papercusp',
        payload: { largeSubmission: 'P'.repeat(BUDGET_CHARS * 3) },
      },
      ledgerIdeaId: 'agent-review:WI-review-claim-1',
      gradeWith: { ideaId: 'agent-review:WI-review-claim-1' },
    };
    const out: DoorableResult = await applyResultDoorAsync({
      content: [{ type: 'text' as const, text: JSON.stringify(claim) }],
    }, {
      ...OPTS,
      toolName: 'tools:invoke',
      nestedTargetToolName: 'improvements:agent-review',
    });
    const receipt = JSON.parse((out.content[0] as { text: string }).text) as {
      claimed: boolean;
      workItem: { id: string; title: string; payload?: { largeSubmission?: string } };
      ledgerIdeaId: string;
      gradeWith: { ideaId: string };
      _projection: { cursor: Record<string, unknown>; next: string };
    };

    const cursor = volatileCursorFrom(out);
    expect((out._meta?.resultDoor as { spillFailed?: boolean; spillErrorCode?: string }) ?? {})
      .toMatchObject({ spillFailed: true, spillErrorCode: 'SCRATCH_QUOTA_EXCEEDED' });
    expect(receipt).toMatchObject({
      claimed: true,
      workItem: { id: 'WI-review-claim-1', title: 'review a large submission' },
      ledgerIdeaId: 'agent-review:WI-review-claim-1',
      gradeWith: { ideaId: 'agent-review:WI-review-claim-1' },
      _projection: {
        cursor: {
          kind: 'volatile-scratch-page',
          tool: 'capability:read',
        },
      },
    });
    expect(readVolatileText(cursor)).toBe(JSON.stringify(claim));
    expect(receipt.workItem.payload?.largeSubmission).toContain('TRUNCATED');
    expect(receipt._projection.next).toContain('Do not retry improvements:agent-review');
    expect(receipt._projection.next).toContain('blender:grade-idea');
  });

  it('writeScratchReference with deferredWrites reserves and writes through the asynchronous path', async () => {
    const filePath = join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-1', 'x:y', RUN_ID, 'ref.spill');
    const deferred: Promise<void>[] = [];
    const manifest = writeScratchReference({
      filePath,
      payload: 'hello deferred',
      workspaceId: 'ws-1',
      mediaType: 'text/plain',
      deferredWrites: deferred,
    });
    expect(manifest.byteCount).toBe(Buffer.byteLength('hello deferred'));
    expect(existsSync(filePath)).toBe(false);
    await Promise.all(deferred);
    const ref = parseScratchReference(readFileSync(filePath));
    expect(ref!.payload.toString('utf8')).toBe('hello deferred');
    expect(ref!.manifest.sha256).toBe(manifest.sha256);
  });

  describe('read-surface spill failures', () => {
    function breakScratchRoot(): void {
      const blocker = join(sandbox, 'scratch-is-a-file');
      writeFileSync(blocker, 'x');
      process.env.PAPERCUSP_SCRATCH_ROOT = join(blocker, 'scratch');
    }

    it.each(['coord:feed', 'work_items:list', 'work_items:get'] as const)(
      '%s returns a readable volatile cursor when the shared writer fails',
      async (toolName) => {
        breakScratchRoot();
        const rows = Array.from({ length: 12 }, (_, index) => ({
          id: `WI-${index}`,
          summary: 's'.repeat(900),
          ...(toolName === 'work_items:get'
            ? { comments: [{ body: 'newer comment body ' + index }] }
            : {}),
        }));
        const body = toolName === 'work_items:list'
          ? rows
          : toolName === 'coord:feed'
            ? { messages: rows }
            : {
                ok: true,
                results: rows.map((row) => ({ id: row.id, ok: true, workItem: row })),
                counts: { ok: rows.length, failed: 0 },
              };
        const original = JSON.stringify(body);
        expect(original.length).toBeGreaterThan(BUDGET_CHARS);

        const out = await applyResultDoorAsync(
          { content: [{ type: 'text' as const, text: original }] },
          { ...OPTS, toolName },
        );
        const resultText = (out.content.find((item) => item.type === 'text') as { text: string }).text;
        const meta = (out as {
          _meta?: {
            resultDoor?: {
              recoveryCursor?: Record<string, unknown>;
              [key: string]: unknown;
            };
          };
        })._meta?.resultDoor;

        expect(resultText.length).toBeLessThan(original.length);
        expect(meta?.recoveryCursor).toMatchObject({
          kind: 'volatile-scratch-page',
          tool: 'capability:read',
          reason: 'spill-write-failed',
        });
        expect(resultText).not.toContain(sandbox);
        expect(meta).toMatchObject({ spillFailed: true, spillPath: null, spillUri: null, spillErrorCode: 'ENOTDIR' });
        if (!meta?.recoveryCursor) throw new Error('missing volatile recovery cursor');
        expect(readVolatileText(meta.recoveryCursor)).toBe(original);
      },
    );

    it.each(['plans:get', 'events:status'] as const)(
      'nested tools:invoke %s keeps a readable volatile page when the shared writer fails',
      async (nestedTargetToolName) => {
        breakScratchRoot();
        const rows = Array.from({ length: 12 }, (_, index) => ({
          id: `${nestedTargetToolName}-${index}`,
          details: 'd'.repeat(900),
        }));
        const body = nestedTargetToolName === 'plans:get'
          ? {
              ok: true,
              results: [{ id: 'plan-1', title: 'Plan with nested spill output', items: rows }],
              counts: { ok: 1, failed: 0 },
            }
          : {
              event_inspection: {
                event: 'work-item:done:EI-1',
                current_generation: 7,
                current_state: 'fired',
                active_awaits: rows,
              },
              history: rows,
            };
        const original = JSON.stringify(body);
        expect(original.length).toBeGreaterThan(BUDGET_CHARS);

        const out = await applyResultDoorAsync(
          { content: [{ type: 'text' as const, text: original }] },
          { ...OPTS, toolName: 'tools:invoke', nestedTargetToolName },
        );
        const resultText = (out.content.find((item) => item.type === 'text') as { text: string }).text;
        const meta = (out as {
          _meta?: {
            resultDoor?: {
              recoveryCursor?: Record<string, unknown>;
              [key: string]: unknown;
            };
          };
        })._meta?.resultDoor;

        expect(resultText.length).toBeLessThan(original.length);
        expect(resultText).not.toContain(sandbox);
        expect(meta).toMatchObject({ spillFailed: true, spillPath: null, spillUri: null, spillErrorCode: 'ENOTDIR' });
        expect(meta?.recoveryCursor).toMatchObject({
          kind: 'volatile-scratch-page',
          tool: 'capability:read',
          reason: 'spill-write-failed',
        });
        if (!meta?.recoveryCursor) throw new Error('missing volatile recovery cursor');
        expect(readVolatileText(meta.recoveryCursor)).toBe(original);
      },
    );

    it('coord:feed returns a readable volatile page with accounting when aggregate spill cannot persist', async () => {
      breakScratchRoot();
      const aggregateScope = beginResultDoorAggregate({ sessionKey: 'read-surface-test', outputGroupId: 'turn-1' });
      const fill = { content: [{ type: 'text' as const, text: 'f'.repeat(BUDGET_CHARS) }] };
      await applyResultDoorAsync(fill, { ...OPTS, toolName: 'coord:feed', aggregateScope });
      await applyResultDoorAsync(fill, { ...OPTS, toolName: 'coord:feed', aggregateScope });

      const original = JSON.stringify({ messages: 'm'.repeat(BUDGET_CHARS) });
      const out = await applyResultDoorAsync(
        { content: [{ type: 'text' as const, text: original }] },
        { ...OPTS, toolName: 'coord:feed', aggregateScope },
      );
      const envelope = JSON.parse((out.content[0] as { text: string }).text) as {
        state?: string;
        error?: { code?: string; message?: string; retryable?: boolean };
      };
      const meta = (out as { _meta?: { resultDoor?: Record<string, unknown> } })._meta?.resultDoor;
      const cursor = volatileCursorFrom(out);

      expect(envelope).toMatchObject({ state: 'incomplete' });
      expect(meta).toMatchObject({
        spillFailed: true,
        spillPath: null,
        spillUri: null,
        spillErrorCode: 'ENOTDIR',
        originalBytes: Buffer.byteLength(original),
      });
      expect(readVolatileText(cursor)).toContain(original);
      expect(JSON.stringify(out.content)).not.toContain(sandbox);
    });
  });
});
