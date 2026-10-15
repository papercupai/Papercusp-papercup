import { describe, expect, it, vi } from 'vitest';
import {
  defaultGetRegisteredSchedules,
  listDbosScheduledWorkflows,
  type FireState,
  type RegisteredSchedule,
} from './dbos-schedule-introspect';

const reg = (name: string, crontab: string, extra: Partial<RegisteredSchedule> = {}): RegisteredSchedule => ({
  name,
  crontab,
  mode: 'ExactlyOncePerIntervalWhenActive',
  queueName: null,
  ...extra,
});

describe('listDbosScheduledWorkflows', () => {
  it('returns [] when no schedules are registered (DBOS not loaded in this process)', async () => {
    const out = await listDbosScheduledWorkflows({ getRegisteredSchedules: () => [] });
    expect(out).toEqual([]);
  });

  it('merges the registry with fire-state and sorts by name', async () => {
    const fireState: FireState = new Map([
      ['telemetryFlush', { lastFireMs: 1_700_000_000_000, lastStatus: 'SUCCESS' }],
      // backupCadence intentionally has no fire-state row (never fired / not tracked)
    ]);
    const out = await listDbosScheduledWorkflows({
      getRegisteredSchedules: () => [
        reg('telemetryFlush', '0 0 * * * *', { queueName: 'maint' }),
        reg('backupCadence', '0 * * * * *'),
      ],
      getFireState: async () => fireState,
    });

    expect(out.map((e) => e.name)).toEqual(['backupCadence', 'telemetryFlush']); // alpha-sorted
    const telem = out.find((e) => e.name === 'telemetryFlush')!;
    expect(telem).toMatchObject({
      crontab: '0 0 * * * *',
      mode: 'ExactlyOncePerIntervalWhenActive',
      queueName: 'maint',
      lastFireMs: 1_700_000_000_000,
      lastStatus: 'SUCCESS',
    });
    const backup = out.find((e) => e.name === 'backupCadence')!;
    expect(backup.lastFireMs).toBeNull();
    expect(backup.lastStatus).toBeNull();
  });

  it('degrades to null fire-state (never throws) when the enrichment leg fails', async () => {
    const out = await listDbosScheduledWorkflows({
      getRegisteredSchedules: () => [reg('scratchGc', '0 0 3 * * *')],
      getFireState: async () => {
        throw new Error('pg down');
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'scratchGc', crontab: '0 0 3 * * *', lastFireMs: null, lastStatus: null });
  });

  it('passes the registered names to the fire-state query', async () => {
    let seen: string[] | null = null;
    await listDbosScheduledWorkflows({
      getRegisteredSchedules: () => [reg('a.x', '* * * * * *'), reg('b.y', '* * * * * *')],
      getFireState: async (names) => {
        seen = names;
        return new Map();
      },
    });
    expect(seen).toEqual(['a.x', 'b.y']);
  });

  it('applies a name filter before reading fire-state for unrelated schedules', async () => {
    let seen: string[] | null = null;
    const out = await listDbosScheduledWorkflows({
      nameFilter: 'sessionSearchIndexBuild',
      getRegisteredSchedules: () => [
        reg('.sessionSearchIndexBuild', '0 7,22,37,52 * * * *'),
        reg('routinesTick', '0 */2 * * * *'),
      ],
      getFireState: async (names) => {
        seen = names;
        return new Map();
      },
    });

    expect(seen).toEqual(['.sessionSearchIndexBuild']);
    expect(out.map((entry) => entry.name)).toEqual(['.sessionSearchIndexBuild']);
  });
});

describe('defaultGetRegisteredSchedules', () => {
  it('preserves the SDK leading-dot key for empty className and joins its finite last fire', async () => {
    const sdk = await import('@dbos-inc/dbos-sdk');
    const getAssociatedInfo = vi.spyOn(sdk.DBOS, 'getAssociatedInfo').mockReturnValue([
      {
        methodReg: { className: '', name: 'scratchGc' },
        methodConfig: { crontab: '0 * * * * *' },
      },
      {
        methodReg: { className: 'Worker', name: 'tick' },
        methodConfig: { crontab: '*/5 * * * * *', queueName: 'maint' },
      },
    ] as unknown as ReturnType<typeof sdk.DBOS.getAssociatedInfo>);

    try {
      const registered = await defaultGetRegisteredSchedules();
      expect(registered.map((entry) => entry.name)).toEqual(['.scratchGc', 'Worker.tick']);

      const out = await listDbosScheduledWorkflows({
        getRegisteredSchedules: () => registered,
        getFireState: async (names) => {
          expect(names).toEqual(['.scratchGc', 'Worker.tick']);
          return new Map([
            ['.scratchGc', { lastFireMs: 1_700_000_000_000, lastStatus: 'SUCCESS' }],
          ]);
        },
      });
      expect(out.find((entry) => entry.name === '.scratchGc')).toMatchObject({
        lastFireMs: 1_700_000_000_000,
        lastStatus: 'SUCCESS',
      });
    } finally {
      getAssociatedInfo.mockRestore();
    }
  });
});
