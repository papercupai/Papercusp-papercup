import { describe, expect, it, vi } from 'vitest';

import { syncSpawnProducer, type HotStackSummary } from './event-loop-stall-profile';
import {
  createSyncSpawnStallReporter,
  isSyncSpawnStallMessage,
  SYNC_SPAWN_REPORT_COOLDOWN_MS,
  syncSpawnCaptureInput,
  syncSpawnWatchdogKey,
  type SyncSpawnStallMessage,
} from './event-loop-sync-spawn-report';

const hot = (...stacks: Array<[number, string]>): HotStackSummary => ({
  samples: 1000,
  hot: stacks.map(([pct, stack]) => ({ pct, count: pct * 10, stack })),
});

// The real shape of the 02:28Z :3170 stall (WI-10005193): Node's own spawnSync frames under
// execFileSync, then the release:cut code that called it.
const CUT_STACK =
  'spawnSync@child_process:1:1 < spawnSync@node:child_process:870:16 < execFileSync@node:child_process:1001:15 < ' +
  'defaultWorktreeStatus@hono-host.mjs:4512:9 < resolveCutRoot@hono-host.mjs:4600:3';

describe('syncSpawnProducer (WI-10005253)', () => {
  it('names the first caller above the outermost sync primitive, without line/col', () => {
    expect(syncSpawnProducer(hot([30.9, CUT_STACK]))).toEqual({
      producer: 'defaultWorktreeStatus@hono-host.mjs',
      producerFn: 'defaultWorktreeStatus',
      pct: 30.9,
      stack: CUT_STACK,
    });
  });

  it('skips Node-internal and anonymous frames when picking the producer', () => {
    const stack = 'execSync@node:child_process:1:1 < (anonymous)@x.mjs:5:1 < realAdmissionGit@x.mjs:9:2';
    expect(syncSpawnProducer(hot([40, stack]))?.producerFn).toBe('realAdmissionGit');
  });

  it('reports depth truncation instead of guessing', () => {
    const r = syncSpawnProducer(hot([50, 'spawnSync@child_process:1:1 < execFileSync@node:child_process:2:2']));
    expect(r?.producer).toBe('(above profile depth)');
  });

  it('ignores stacks below minPct and stacks with no sync primitive; falls through to a hotter qualifying one', () => {
    expect(syncSpawnProducer(hot([60, 'renderMdx@hono-host.mjs:1:1 < docsSearch@hono-host.mjs:2:2']))).toBeNull();
    expect(syncSpawnProducer(hot([5, CUT_STACK]))).toBeNull();
    // hot1 is not a spawn; hot2 is, and clears the bar.
    expect(syncSpawnProducer(hot([50, 'renderMdx@a.mjs:1:1'], [23.6, CUT_STACK]))?.producerFn).toBe('defaultWorktreeStatus');
    // An async execFile is not a block.
    expect(syncSpawnProducer(hot([80, 'execFile@node:child_process:1:1 < runFileAsync@a.mjs:2:2']))).toBeNull();
  });
});

const msg = (over: Partial<SyncSpawnStallMessage> = {}): SyncSpawnStallMessage => ({
  kind: 'sync-spawn-stall',
  pid: 801964,
  file: '/home/x/.papercusp/stall-profiles/stall-1-pid801964.cpuprofile',
  stalenessAtStartMs: 4200,
  mainThreadActivity: 'spinning',
  producer: 'defaultWorktreeStatus@hono-host.mjs',
  producerFn: 'defaultWorktreeStatus',
  pct: 30.9,
  stack: CUT_STACK,
  ...over,
});

function deps(over: { open?: boolean; captureFails?: boolean } = {}) {
  let t = 1_000_000;
  const d = {
    hasOpenRow: vi.fn(async () => over.open ?? false),
    capture: vi.fn(async () => {
      if (over.captureFails) throw new Error('db down');
      return { ok: true };
    }),
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
  return d;
}

describe('sync-spawn stall reporter (WI-10005253)', () => {
  it('files once per producer, with a stable title and the producer watchdogKey', async () => {
    const d = deps();
    const report = createSyncSpawnStallReporter(d);
    expect(await report(msg())).toBe('filed');
    expect(d.hasOpenRow).toHaveBeenCalledWith('event-loop-sync-spawn:defaultWorktreeStatus');
    expect(d.capture).toHaveBeenCalledTimes(1);
    // The mock is declared with no parameter, so its call tuple is typed `[]`; widen before indexing.
    const input = (d.capture.mock.calls[0] as unknown[])[0] as ReturnType<typeof syncSpawnCaptureInput>;
    expect(input).toMatchObject({
      title: 'Synchronous child-process call blocked the operator event loop: defaultWorktreeStatus',
      kind: 'bug',
      watchdogKey: syncSpawnWatchdogKey('defaultWorktreeStatus'),
      sourceRole: 'system',
      dedupScope: 'open',
    });
    expect(input.body).toContain(CUT_STACK);
    expect(input.body).toContain('stall-1-pid801964.cpuprofile');
  });

  it('a repeat inside the cooldown files nothing; after it, the open-row check runs again', async () => {
    const d = deps();
    const report = createSyncSpawnStallReporter(d);
    await report(msg());
    expect(await report(msg())).toBe('cooldown');
    d.advance(SYNC_SPAWN_REPORT_COOLDOWN_MS + 1);
    expect(await report(msg())).toBe('filed');
    expect(d.capture).toHaveBeenCalledTimes(2);
  });

  it('a different producer is its own identity', async () => {
    const d = deps();
    const report = createSyncSpawnStallReporter(d);
    await report(msg());
    expect(await report(msg({ producerFn: 'realAdmissionGit', producer: 'realAdmissionGit@x.mjs' }))).toBe('filed');
    expect(d.capture).toHaveBeenCalledTimes(2);
  });

  it('an existing open row suppresses the capture', async () => {
    const d = deps({ open: true });
    expect(await createSyncSpawnStallReporter(d)(msg())).toBe('open-exists');
    expect(d.capture).not.toHaveBeenCalled();
  });

  it('overlapping stalls from one producer do not race two captures', async () => {
    const d = deps();
    const report = createSyncSpawnStallReporter(d);
    const [a, b] = await Promise.all([report(msg()), report(msg())]);
    expect([a, b].sort()).toEqual(['filed', 'in-flight']);
    expect(d.capture).toHaveBeenCalledTimes(1);
  });

  it('a failed capture sets no cooldown, so the next stall retries', async () => {
    const d = deps({ captureFails: true });
    const report = createSyncSpawnStallReporter(d);
    expect(await report(msg())).toBe('failed');
    expect(await report(msg())).toBe('failed');
    expect(d.capture).toHaveBeenCalledTimes(2);
  });

  it('the message guard accepts the worker shape and rejects everything else', () => {
    expect(isSyncSpawnStallMessage(msg())).toBe(true);
    expect(isSyncSpawnStallMessage({ kind: 'ready' })).toBe(false);
    expect(isSyncSpawnStallMessage({ ...msg(), producerFn: '' })).toBe(false);
    expect(isSyncSpawnStallMessage(null)).toBe(false);
  });
});
