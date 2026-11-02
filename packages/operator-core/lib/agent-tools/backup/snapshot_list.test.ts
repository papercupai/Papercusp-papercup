import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  list: vi.fn(),
  liveBackupSessions: vi.fn(),
  readHostDumpInProgress: vi.fn(),
}));

vi.mock('../../backup', () => ({
  workspaceBackupFor: vi.fn(() => ({
    list: h.list,
    liveBackupSessions: h.liveBackupSessions,
  })),
  readHostDumpInProgress: h.readHostDumpInProgress,
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-1') }));

const mod = await import('./snapshot_list');
const tool = mod.default;

type Out = {
  data: {
    snapshots: unknown[];
    liveBackupSessions: unknown[];
    hostDumpInProgress: unknown;
  };
};
const call = (args: Record<string, unknown> = { limit: 50 }) =>
  tool.handler(args as never, {} as never) as Promise<Out>;

beforeEach(() => {
  vi.clearAllMocks();
  h.list.mockResolvedValue([]);
  h.liveBackupSessions.mockResolvedValue([]);
  h.readHostDumpInProgress.mockResolvedValue(null);
});

describe('backup:snapshot_list host producer status', () => {
  it('keeps a live host dump visible when there are no backup PostgreSQL sessions', async () => {
    const marker = {
      pid: 2098456,
      processStartTicks: '48239102',
      startedAtEpoch: 1793510000,
      phase: 'host-backup',
      source: 'host-backup',
    };
    h.readHostDumpInProgress.mockResolvedValue(marker);

    const out = await call();

    expect(out).toEqual({
      data: {
        snapshots: [],
        liveBackupSessions: [],
        hostDumpInProgress: marker,
      },
    });
  });

  it('reports a null host marker when no dump producer is active', async () => {
    const out = await call();

    expect(out).toEqual({
      data: {
        snapshots: [],
        liveBackupSessions: [],
        hostDumpInProgress: null,
      },
    });
  });
});
