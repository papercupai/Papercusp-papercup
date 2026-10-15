import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock, enqueueMock, workspaceMock, homeMock, workflowImportMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  enqueueMock: vi.fn(),
  workspaceMock: vi.fn(() => 'workspace-1'),
  homeMock: vi.fn(() => 'home'),
  workflowImportMock: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: workspaceMock }));
vi.mock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: homeMock }));
vi.mock('../../dbos/routines-workflow', () => {
  workflowImportMock();
  return { enqueueRoutineFire: enqueueMock };
});

const tool = (await import('./fire')).default;
const workflowLoadsDuringRegistration = workflowImportMock.mock.calls.length;

const row = {
  id: 'rt_home_git_sync',
  workspaceId: 'workspace-1',
  installSlug: 'home',
  name: 'git-sync',
  targetRole: 'system:git-sync',
  triggerConfig: { cron: '*/3 * * * * *' },
  payloadTemplate: null,
  rescheduleIntervalSec: null,
  targetOwnerId: null,
};

function body(value: unknown): Record<string, unknown> {
  const result = value as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockResolvedValue([row]);
  enqueueMock.mockResolvedValue({
    ok: true,
    status: 'enqueued',
    routineId: row.id,
    deduplicationId: `routine:${row.id}`,
    queueName: 'routines-critical',
    timeoutMs: 7_200_000,
  });
});

describe('routines:fire', () => {
  it('registers the tool without loading the workflow engine', () => {
    // Capture collection-time loading before beforeEach clears mock history.
    // A metadata-only boot must not initialize worker queues/system actions.
    expect(workflowLoadsDuringRegistration).toBe(0);
  });

  it('looks up the live workspace row and delegates its full dispatch payload', async () => {
    const result = await tool.handler({ name: 'git-sync', installSlug: 'home', reason: 'verify recovery' } as never, {
      role: 'operator',
      metadata: vi.fn(),
    } as never);

    expect(workspaceMock).toHaveBeenCalledOnce();
    expect(sqlMock).toHaveBeenCalledOnce();
    expect(enqueueMock).toHaveBeenCalledWith(row);
    expect(body(result)).toMatchObject({ ok: true, status: 'enqueued', routine: 'home/git-sync' });
  });

  it('keeps a reserved harness-less routine fire scoped to the active workspace and exact install', async () => {
    const singleton = {
      ...row,
      id: 'rt_singleton_precision',
      installSlug: '@singleton',
      name: 'bp-singleton-memory-precision-0',
    };
    sqlMock.mockResolvedValue([singleton]);

    const result = await tool.handler(
      { name: singleton.name, installSlug: singleton.installSlug } as never,
      { role: 'operator' } as never,
    );

    const queryArgs = sqlMock.mock.calls[0] as unknown[];
    expect(queryArgs).toContain('workspace-1');
    expect(queryArgs).toContain('@singleton');
    expect(queryArgs).toContain('bp-singleton-memory-precision-0');
    expect(enqueueMock).toHaveBeenCalledWith(singleton);
    expect(body(result)).toMatchObject({ ok: true, routine: '@singleton/bp-singleton-memory-precision-0' });
  });

  it('supports exact row-id lookup and preserves a deduplicated result', async () => {
    enqueueMock.mockResolvedValue({
      ok: true,
      status: 'deduplicated',
      routineId: row.id,
      deduplicationId: `routine:${row.id}`,
      queueName: 'routines-critical',
      timeoutMs: 7_200_000,
    });
    const result = await tool.handler({ id: row.id } as never, { role: 'operator' } as never);
    expect(enqueueMock).toHaveBeenCalledWith(row);
    expect(body(result)).toMatchObject({ ok: true, status: 'deduplicated' });
  });

  it('explains DBOS-primary unavailability and keeps release promotion on release:deploy', async () => {
    enqueueMock.mockResolvedValue({
      ok: false,
      status: 'unavailable',
      reason: 'dbos-not-started',
      routineId: row.id,
      deduplicationId: `routine:${row.id}`,
      queueName: 'routines-critical',
      timeoutMs: 7_200_000,
    });

    const result = await tool.handler({ name: 'release-trigger', installSlug: 'home' } as never, {
      role: 'operator',
    } as never);

    expect(body(result)).toMatchObject({
      status: 'unavailable',
      reason: 'dbos-not-started',
      nextStep: expect.stringContaining('background-worker MCP host'),
    });
    expect(tool.guidance?.notWhen).toContain('request-only operator host');
    expect(tool.guidance?.notWhen).toContain('release:deploy');
  });

  it('returns a truthful not-found error without enqueueing', async () => {
    sqlMock.mockResolvedValue([]);
    const result = await tool.handler({ name: 'missing', installSlug: 'home' } as never, { role: 'operator' } as never);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(body(result)).toMatchObject({ ok: false, error: 'not_found' });
  });
});
