import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectSiblingManagedTimers,
  describeProcessRole,
  listSiblingOperators,
  ownHonoPort,
  probeSibling,
  type SiblingOperator,
} from './schedule-federation';

const sibling = (over: Partial<SiblingOperator> = {}): SiblingOperator => ({
  port: 3271,
  pid: 4242,
  startedAt: 1_700_000_000_000,
  ...over,
});

/** A fetch stub answering the managed-timers probe with `timers`. */
const okFetch =
  (body: Record<string, unknown>) =>
  async () => ({ ok: true, status: 200, json: async () => body });

describe('describeProcessRole', () => {
  it('reports bg-host only when background workers are actually enabled', () => {
    expect(describeProcessRole({ PAPERCUSP_BACKGROUND_WORKERS: '1' })).toBe('bg-host');
    expect(describeProcessRole({ PAPERCUSP_BACKGROUND_WORKERS: 'true' })).toBe('bg-host');
    // The runtime's explicit disable value is `0`; unset ports other than :3170 use
    // the background-host default. A mislabelled row would send a reader to the wrong
    // process when explaining a stalled timer.
    expect(describeProcessRole({ PAPERCUSP_BACKGROUND_WORKERS: '0' })).toBe('operator');
    expect(describeProcessRole({ PAPERCUSP_HONO_PORT: '3170' })).toBe('operator');
    expect(describeProcessRole({ PAPERCUSP_BACKGROUND_WORKERS: 'false' })).toBe('bg-host');
    expect(describeProcessRole({ PAPERCUSP_BACKGROUND_WORKERS: '' })).toBe('bg-host');
    expect(describeProcessRole({})).toBe('bg-host');
  });
});

describe('ownHonoPort', () => {
  it('matches the expression the discovery-file WRITER uses', () => {
    // Load-bearing: endpoint-ipc-discovery.ts publishes under
    // `Number(PAPERCUSP_HONO_PORT) || 3070`. If this diverges, a process stops
    // recognising its OWN discovery file and federates itself, double-counting
    // every one of its timers.
    expect(ownHonoPort({ PAPERCUSP_HONO_PORT: '3271' })).toBe(3271);
    expect(ownHonoPort({})).toBe(3070);
    expect(ownHonoPort({ PAPERCUSP_HONO_PORT: '' })).toBe(3070);
    expect(ownHonoPort({ PAPERCUSP_HONO_PORT: 'nonsense' })).toBe(3070);
  });
});

describe('listSiblingOperators', () => {
  it('returns live per-port siblings, excluding self, dead pids, and the legacy singleton', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sched-fed-'));
    const write = (name: string, body: unknown) =>
      writeFile(join(dir, name), JSON.stringify(body), 'utf8');

    await write('endpoint-ipc.3070.json', { socketPath: '/s/a', pid: 111, startedAt: 1, port: 3070 });
    await write('endpoint-ipc.3271.json', { socketPath: '/s/b', pid: 222, startedAt: 2, port: 3271, processRole: 'bg-host' });
    await write('endpoint-ipc.3170.json', { socketPath: '/s/c', pid: 999, startedAt: 3, port: 3170 });
    // The legacy singleton is last-writer-wins across every operator on the box —
    // including it would duplicate a per-port sibling or point at a different process
    // than its filename implies.
    await write('endpoint-ipc.json', { socketPath: '/s/b', pid: 222, startedAt: 2, port: 3271 });
    await writeFile(join(dir, 'endpoint-ipc.4242.json'), '{ not json', 'utf8');
    await write('embedded-pg.json', { unrelated: true });

    const found = await listSiblingOperators({
      dir,
      selfPort: 3070,
      isAlive: (pid) => pid !== 999, // 3170's advertisement is stale
    });

    expect(found.map((s) => s.port)).toEqual([3271]);
    expect(found[0]).toMatchObject({ pid: 222, startedAt: 2, processRole: 'bg-host' });
  });

  it('returns [] when the discovery dir does not exist', async () => {
    expect(await listSiblingOperators({ dir: join(tmpdir(), 'sched-fed-absent-dir-xyz') })).toEqual([]);
  });
});

describe('probeSibling', () => {
  it('carries validated callback placement for worker and fresh primary without arbitrary payloads', async () => {
    const invocation = { workspaceId: 'workspace-a', featureId: `activity-${'a'.repeat(64)}`,
      source: 'event', running: true, stopStatus: 'draining', cancellable: false };
    const body = { process: 'bg-host', timers: [], backgroundActivities: [
      { ...invocation, credential: 'private-token', args: { secret: true } },
      { ...invocation, workspaceId: '*' }, { ...invocation, running: false },
    ], primary: { pid: 54321, role: 'bg-host', timers: [], staleMs: 1, backgroundActivities: [invocation] } };
    const rows = await probeSibling(sibling(), { fetchImpl: okFetch(body) });
    expect(rows.map(row => row.backgroundActivities)).toEqual([[invocation], [invocation]]);
    expect(JSON.stringify(rows)).not.toContain('private-token');
    expect(JSON.stringify(rows)).not.toContain('secret');
    for (const staleMs of [undefined, -1, 15_001]) {
      const stale = await probeSibling(sibling(), { fetchImpl: okFetch({ ...body, primary: { ...body.primary, staleMs } }) });
      expect(stale[1].backgroundActivities).toEqual([]);
    }
  });

  it('returns BOTH per-process registries and a self-identified label, as a single-element array', async () => {
    const got = await probeSibling(sibling(), {
      fetchImpl: okFetch({
        process: 'bg-host',
        timers: [{ name: 'memory-watchdog', intervalMs: 30_000 }],
        dbosSchedules: [
          { name: 'PeriodicWorkflows.attentionReconcileUnanswerable', crontab: '0 20 * * * *', mode: 'x', queueName: null },
        ],
      }),
    });
    expect(got).toHaveLength(1);
    expect(got[0].ok).toBe(true);
    expect(got[0].label).toBe('bg-host:3271');
    expect(got[0].timers).toHaveLength(1);
    // The durable slice is the one that carries the sweeps this whole change exists
    // for — a federation that returned only `timers` would miss its own case.
    expect(got[0].dbosSchedules).toHaveLength(1);
  });

  it('tolerates a sibling on an older build that omits the dbosSchedules slice', async () => {
    const got = await probeSibling(sibling(), {
      fetchImpl: okFetch({ process: 'bg-host', timers: [] }),
    });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ ok: true, dbosSchedules: [] });
  });

  /**
   * EI-19454206016477347: a worker's response can carry an optional `primary` field —
   * its true-cluster PRIMARY's own registries, relayed over the worker's cluster-IPC
   * cache because the primary never itself serves this route. When present, probeSibling
   * returns a SECOND row for it, labelled distinctly so a reader can tell it was reached
   * only via relay, not because that process itself listens on the probed port.
   */
  it('adds a SECOND row for a federated primary when the worker response carries one', async () => {
    const got = await probeSibling(sibling(), {
      fetchImpl: okFetch({
        process: 'operator',
        timers: [{ name: 'worker-own-timer' }],
        dbosSchedules: [],
        primary: {
          pid: 621668,
          role: 'operator',
          timers: [{ name: 'git-sync' }, { name: 'dbos-executor-reaper' }],
          dbosSchedules: [
            { name: 'PeriodicWorkflows.attentionReconcileUnanswerable', crontab: '0 20 * * * *', mode: 'x', queueName: null },
          ],
          sentAt: 123,
          staleMs: 456,
        },
      }),
    });
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ ok: true, label: 'operator:3271', timers: [{ name: 'worker-own-timer' }] });
    expect(got[1]).toMatchObject({
      ok: true,
      pid: 621668,
      port: 3271,
      label: 'operator(primary via :3271)',
      process: 'operator',
      timers: [{ name: 'git-sync' }, { name: 'dbos-executor-reaper' }],
      dbosSchedules: [
        { name: 'PeriodicWorkflows.attentionReconcileUnanswerable', crontab: '0 20 * * * *', mode: 'x', queueName: null },
      ],
    });
  });

  it('omits the primary row when `primary` is absent, empty-ish, or malformed', async () => {
    const absent = await probeSibling(sibling(), {
      fetchImpl: okFetch({ process: 'operator', timers: [] }),
    });
    expect(absent).toHaveLength(1);

    const malformed = await probeSibling(sibling(), {
      fetchImpl: okFetch({
        process: 'operator',
        timers: [],
        primary: { pid: 'not-a-number', role: 'operator', timers: [] },
      }),
    });
    expect(malformed).toHaveLength(1); // pid wrong type — never fabricated

    const missingTimers = await probeSibling(sibling(), {
      fetchImpl: okFetch({ process: 'operator', timers: [], primary: { pid: 1, role: 'operator' } }),
    });
    expect(missingTimers).toHaveLength(1); // timers not an array
  });

  it('NEVER rejects — a throwing/refusing/non-2xx probe degrades to a single ok:false row', async () => {
    const refused = await probeSibling(sibling(), {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(refused).toHaveLength(1);
    expect(refused[0].ok).toBe(false);
    expect(refused[0].error).toContain('ECONNREFUSED');
    // The label still identifies WHICH process is unknown, so a degraded row is
    // actionable rather than anonymous.
    expect(refused[0].label).toBe('operator:3271');

    const http500 = await probeSibling(sibling(), {
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    });
    expect(http500).toHaveLength(1);
    expect(http500[0]).toMatchObject({ ok: false, error: 'HTTP 500', timers: [], dbosSchedules: [] });

    const garbage = await probeSibling(sibling(), {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => 'not-an-object' }),
    });
    expect(garbage).toHaveLength(1);
    expect(garbage[0]).toMatchObject({ ok: true, timers: [] });
  });

  it('marks an aborted sibling probe as a timeout', async () => {
    const got = await probeSibling(sibling(), {
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return { ok: true, status: 200, json: async () => ({ process: 'bg-host' }) };
      },
    });

    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ ok: false, probeFailure: 'timeout' });
  });
});

describe('collectSiblingManagedTimers — a wedged sibling cannot block the inventory', () => {
  /*
   * THE RECURRENCE GUARD (EI-19445595198254637 / EI-19446421329946902).
   *
   * bg-host has been measured accepting a connection and then returning ZERO BYTES
   * for 45s while staying alive. A fan-out that waits on that would convert a
   * degraded sibling into a hung operator — trading a visibility bug for an
   * availability bug. This stub is deliberately WORSE than reality: it ignores its
   * AbortSignal entirely, so only the outer budget can save the call.
   */
  const neverAnswers = async () => new Promise<never>(() => {});

  it('resolves within the budget even when the sibling ignores its abort signal', async () => {
    const startedAt = Date.now();
    const rows = await collectSiblingManagedTimers({
      siblings: [sibling()],
      timeoutMs: 10_000, // deliberately longer than the budget: the budget must win
      budgetMs: 60,
      fetchImpl: neverAnswers,
    });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(2_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: false, port: 3271, timers: [], probeFailure: 'timeout' });
    expect(rows[0].error).toContain('budget');
  });

  it('degrades ONLY the wedged sibling — healthy siblings still report their timers', async () => {
    // A whole-set race would discard the healthy sibling's data to punish the wedged
    // one; that would hide exactly the timers this change exists to reveal.
    const rows = await collectSiblingManagedTimers({
      siblings: [sibling({ port: 3271 }), sibling({ port: 3170, pid: 77 })],
      timeoutMs: 10_000,
      budgetMs: 60,
      fetchImpl: (async (url: string) =>
        url.includes('3271')
          ? await neverAnswers()
          : { ok: true, status: 200, json: async () => ({ process: 'operator', timers: [{ name: 'poll-suspect' }] }) }) as never,
    });

    const byPort = Object.fromEntries(rows.map((r) => [r.port, r]));
    expect(byPort[3271]).toMatchObject({ ok: false, timers: [] });
    expect(byPort[3170]).toMatchObject({ ok: true });
    expect(byPort[3170].timers).toHaveLength(1);
  });

  it('short-circuits with no siblings and never probes', async () => {
    let called = 0;
    const rows = await collectSiblingManagedTimers({
      siblings: [],
      fetchImpl: (async () => {
        called += 1;
        return { ok: true, status: 200, json: async () => ({}) };
      }) as never,
    });
    expect(rows).toEqual([]);
    expect(called).toBe(0);
  });
});
