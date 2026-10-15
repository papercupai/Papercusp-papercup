/**
 * WI-6554700010008923 (oversized-tool-results-reduction-2026-10-12#P-004): `readCell`
 * shares IDENTICAL CONCURRENT resolver dispatches and caches nothing after they settle.
 *
 * Measured 2026-10-12: the TUI status bar reads three cells that all poll
 * `dev:pipeline_position {}`, and each read started its own ~228 KB, ~1.3 s pipeline
 * computation. These tests pin both halves of the fix. Concurrent identical reads collapse
 * to one dispatch. Reads that differ in anything the result depends on (reader, args,
 * role) stay separate, as do reads that arrive after the first one settled.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchReadOnlyTool = vi.fn();

vi.mock('./events/await/predicate-watch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./events/await/predicate-watch')>();
  return {
    ...actual,
    dispatchReadOnlyTool: (...args: unknown[]) => dispatchReadOnlyTool(...args),
  };
});

import { readCell, resolverDispatchKey, __resolverInflightCountForTests } from './cell-read';
import { registerCell, __resetCellRegistryForTests, type CellSpec } from './cell-registry';

const ENV = { workspaceId: 'default', harnessSlug: 'papercusp', role: 'su' };
const READER = { ownerId: 'su-me', roles: ['su'], harnessSlug: 'papercusp', workItems: ['WI-1'] };
const OTHER_READER = { ...READER, ownerId: 'su-other' };

function spec(over: Partial<CellSpec> = {}): CellSpec {
  return {
    cell: 'test.a',
    owner: 'test',
    headline: 'positions.deployed',
    assessment: {
      path: 'assessments.deployedSha',
      codes: {
        serving: { meaning: 'The running process is executing this sha.', safeAction: 'Treat the deploy as live.' },
        stale: {
          meaning: 'The sha is deployed on disk but the process predates it.',
          safeAction: 'Restart the unit before trusting the deploy.',
        },
      },
      evidence: ['serving.startedSinceCodeChange'],
    },
    nullable: false,
    whyTotal: 'test fixture — the stub resolver returns a value or throws; no read can fail into a default.',
    callerRelativity: { kind: 'global' },
    provenance: { obtainedBy: 'git rev-list', liveExercised: true, evidence: 'run live 2026-07-27' },
    resolver: 'git-pipeline-position.ts',
    visibility: { kind: 'workspace' },
    federation: { kind: 'local' },
    changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'positions.deployed' },
    shape: '{ positions, serving }',
    ...over,
  };
}

const PAYLOAD = {
  positions: { deployed: true, onStaging: true },
  serving: { startedSinceCodeChange: true },
  assessments: { deployedSha: 'serving', stagingState: 'serving' },
};

/** A dispatch the test settles by hand, so "concurrent" is deterministic. */
function deferredDispatch() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  __resetCellRegistryForTests();
  dispatchReadOnlyTool.mockReset();
  // Two cells that share ONE resolver, the shape that caused the measured waste. D-038
  // requires each cell on a shared payload to own a distinct assessment path.
  registerCell(spec({ cell: 'test.a' }));
  const a = spec().assessment!;
  registerCell(
    spec({
      cell: 'test.b',
      headline: 'positions.onStaging',
      assessment: { ...a, path: 'assessments.stagingState' },
    }),
  );
});

describe('readCell — concurrent identical resolver dispatches are shared', () => {
  it('two cells on the same resolver, read together by one reader, dispatch ONCE', async () => {
    const d = deferredDispatch();
    dispatchReadOnlyTool.mockReturnValue(d.promise);

    const reads = Promise.all([readCell('test.a', READER, ENV), readCell('test.b', READER, ENV)]);
    // Both reads have reached the dispatch before it settles.
    await vi.waitFor(() => expect(__resolverInflightCountForTests()).toBe(1));
    d.resolve(PAYLOAD);
    const [a, b] = await reads;

    expect(dispatchReadOnlyTool).toHaveBeenCalledTimes(1);
    expect(a.status).toBe('value');
    expect(b.status).toBe('value');
    // Settled, so nothing is left to share.
    expect(__resolverInflightCountForTests()).toBe(0);
  });

  it('caches nothing after settling: a read that starts later dispatches again', async () => {
    dispatchReadOnlyTool.mockResolvedValue(PAYLOAD);
    await readCell('test.a', READER, ENV);
    await readCell('test.a', READER, ENV);
    expect(dispatchReadOnlyTool).toHaveBeenCalledTimes(2);
  });

  it('never shares across READERS: each reader gets its own dispatch', async () => {
    const d = deferredDispatch();
    dispatchReadOnlyTool.mockReturnValue(d.promise);
    const reads = Promise.all([readCell('test.a', READER, ENV), readCell('test.a', OTHER_READER, ENV)]);
    await vi.waitFor(() => expect(__resolverInflightCountForTests()).toBe(2));
    d.resolve(PAYLOAD);
    await reads;
    expect(dispatchReadOnlyTool).toHaveBeenCalledTimes(2);
    const onBehalfOf = dispatchReadOnlyTool.mock.calls.map((c) => (c[2] as { onBehalfOf: string }).onBehalfOf);
    expect(onBehalfOf.sort()).toEqual(['su-me', 'su-other']);
  });

  it('a rejected shared dispatch fails every waiter the same way and leaves nothing behind', async () => {
    const d = deferredDispatch();
    dispatchReadOnlyTool.mockReturnValue(d.promise.then(() => Promise.reject(new Error('resolver blew up'))));
    const reads = Promise.all([readCell('test.a', READER, ENV), readCell('test.b', READER, ENV)]);
    await vi.waitFor(() => expect(__resolverInflightCountForTests()).toBe(1));
    d.resolve(undefined);
    const [a, b] = await reads;
    expect(dispatchReadOnlyTool).toHaveBeenCalledTimes(1);
    expect(a.status).toBe('unknown');
    expect(b.status).toBe('unknown');
    expect(__resolverInflightCountForTests()).toBe(0);
  });
});

describe('resolverDispatchKey — the key separates everything the result depends on', () => {
  const base = resolverDispatchKey('dev:pipeline_position', {}, ENV, 'su-me');

  it('is stable for identical inputs', () => {
    expect(resolverDispatchKey('dev:pipeline_position', {}, ENV, 'su-me')).toBe(base);
  });

  it.each([
    ['tool', resolverDispatchKey('state:other', {}, ENV, 'su-me')],
    ['args', resolverDispatchKey('dev:pipeline_position', { path: 'a.ts' }, ENV, 'su-me')],
    ['reader', resolverDispatchKey('dev:pipeline_position', {}, ENV, 'su-other')],
    ['role', resolverDispatchKey('dev:pipeline_position', {}, { ...ENV, role: 'worker' }, 'su-me')],
    ['harness', resolverDispatchKey('dev:pipeline_position', {}, { ...ENV, harnessSlug: null }, 'su-me')],
    ['workspace', resolverDispatchKey('dev:pipeline_position', {}, { ...ENV, workspaceId: 'w2' }, 'su-me')],
  ])('differs when the %s differs', (_label, key) => {
    expect(key).not.toBeNull();
    expect(key).not.toBe(base);
  });

  it('refuses to share a call that carries an AbortSignal', () => {
    const signal = new AbortController().signal;
    expect(resolverDispatchKey('dev:pipeline_position', {}, { ...ENV, signal }, 'su-me')).toBeNull();
  });
});
