import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../cell-registrations-wiring';

const { sqlMock, controlMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  controlMock: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));
vi.mock('../../workspace-registry', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  activeWorkspaceId: () => 'ws-default',
}));
vi.mock('../../gateway-control/control-harness', () => ({ runControlMutation: controlMock }));

const tool = (await import('./revert')).default;
const { reconcileRoutineRestore } = await import('./revert');

const previous = {
  triggerConfig: { cron: '0 */30 * * * *', throttle_min: 2 },
  payloadTemplate: { payload: { budget: { maxIdeators: 1 } } },
  active: true,
  nextFireAtIso: '2030-01-01T00:00:00.000Z',
  groupSlug: null,
  metadata: { source: 'before' },
};
const next = {
  triggerConfig: { cron: '0 */10 * * * *', throttle_min: 4 },
  payloadTemplate: { payload: { budget: { maxIdeators: 4 } } },
  active: true,
  nextFireAtIso: '2030-01-01T00:10:00.000Z',
  groupSlug: null,
  metadata: { source: 'after' },
};

// `readRoutineSnap` is the production boundary from the Postgres row shape into
// the serializable audit snapshot shape. Keep the mock rows in the same shape as
// the real SELECT so these tests exercise that conversion instead of bypassing it.
function rowFor(snap: typeof previous) {
  return {
    trigger_config: snap.triggerConfig,
    payload_template: snap.payloadTemplate,
    active: snap.active,
    next_fire_at: snap.nextFireAtIso === null ? null : new Date(snap.nextFireAtIso),
    group_slug: snap.groupSlug,
    metadata: snap.metadata,
  };
}

function body(result: unknown): Record<string, unknown> {
  const out = result as { content: Array<{ text: string }> };
  return JSON.parse(out.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  controlMock.mockImplementation(async (spec: any, opts: any = {}) => {
    const prev = await spec.capturePrev();
    if (opts.dryRun) return { dryRun: true, applied: false, prev, preview: spec.describe?.(prev) };
    const applied = await spec.apply();
    const verify = spec.verify ? await spec.verify(applied) : undefined;
    return { dryRun: false, applied: true, prev, next: applied, verify, auditId: 'gwc-revert-1' };
  });
});

describe('routines:revert MCP boundary', () => {
  it('restores a Git routine whose install slug contains a managed submodule path', async () => {
    sqlMock
      .mockResolvedValueOnce([{ action: 'gateway-control.routines:set', subject: 'papercusp/libs/generic/cache/git-sync', details: { prev: previous, next } }])
      .mockResolvedValueOnce([rowFor(next)])
      .mockResolvedValueOnce([rowFor(next)])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([rowFor(previous)]);
    expect(body(await tool.handler({ auditId: 'gwc-nested' } as never, { role: 'operator' } as never))).toMatchObject({ applied: true });
    expect(sqlMock.mock.calls.flat()).toContain('papercusp/libs/generic/cache');
    expect(sqlMock.mock.calls.flat()).toContain('git-sync');
    expect(sqlMock.mock.calls.flat()).not.toContain('libs/generic/cache/git-sync');
  });
  it('finishes a partial safety restore and keeps the completed trial metadata', () => {
    const before = { ...previous, active: false, payloadTemplate: { mode: 'manual' }, metadata: {} };
    const configured = { ...next, active: true, payloadTemplate: { mode: 'manual', pilot: { pin: 'frozen' } }, metadata: {} };
    const current = { ...configured, active: false, metadata: { dreamLastCycle: { cycleId: 'completed' }, pause: { reason: 'safety' } } };
    const expected = { ...before, metadata: current.metadata };
    expect(reconcileRoutineRestore(current, before, configured)).toEqual(expected);
    // A lost response must be safely reconcilable without erasing newer metadata.
    expect(reconcileRoutineRestore(expected, before, configured)).toEqual(expected);
    expect(current.payloadTemplate).toEqual(configured.payloadTemplate);
  });

  it('refuses later edits on an owned nested setting even after a safety pause', () => {
    const before = { ...previous, active: false };
    const current = { ...next, active: false, payloadTemplate: { payload: { budget: { maxIdeators: 9 } } } };
    expect(() => reconcileRoutineRestore(current, before, next)).toThrow(/refusing.*newer state/);
  });

  it('removes study-owned nested fields while retaining a later sibling', () => {
    const before = { ...previous, payloadTemplate: { mode: 'manual' } };
    const configured = { ...before, payloadTemplate: { ...before.payloadTemplate, cycle: { maxCostUsd: 10 } } };
    const current = { ...configured, payloadTemplate: { ...configured.payloadTemplate, cycle: { maxCostUsd: 10, maxDreamsPerCycle: 2 } } };
    expect(reconcileRoutineRestore(current, before, configured).payloadTemplate)
      .toEqual({ mode: 'manual', cycle: { maxDreamsPerCycle: 2 } });
  });

  it('loads audited snapshots, restores the exact prior state, and tags the new audit with source id', async () => {
    sqlMock
      .mockResolvedValueOnce([
        {
          action: 'gateway-control.routines:set',
          subject: 'calendar/cross-hive-outbox-drain',
          details: { prev: previous, next },
        },
      ])
      .mockResolvedValueOnce([rowFor(next)])
      .mockResolvedValueOnce([rowFor(next)])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([rowFor(previous)]);

    const result = body(
      await tool.handler({ auditId: 'gwc-source-1' } as never, { role: 'operator' } as never),
    );

    expect(result).toMatchObject({
      ok: true,
      routine: 'calendar/cross-hive-outbox-drain',
      sourceAuditId: 'gwc-source-1',
      applied: true,
      auditId: 'gwc-revert-1',
      verify: { ok: true },
    });
    expect(controlMock).toHaveBeenCalledOnce();
    expect(controlMock.mock.calls[0]![0]).toMatchObject({
      action: 'routines:set:revert',
      subject: 'calendar/cross-hive-outbox-drain',
      revertOf: 'gwc-source-1',
    });
    expect(sqlMock).toHaveBeenCalledTimes(5);
  });

  it('refuses to overwrite a routine changed after the source audit', async () => {
    sqlMock
      .mockResolvedValueOnce([
        {
          action: 'gateway-control.routines:set',
          subject: 'calendar/cross-hive-outbox-drain',
          details: { prev: previous, next },
        },
      ])
      .mockResolvedValueOnce([
        rowFor({
          ...next,
          triggerConfig: { ...next.triggerConfig, throttle_min: 99 },
        }),
      ])
      .mockResolvedValueOnce([
        rowFor({
          ...next,
          triggerConfig: { ...next.triggerConfig, throttle_min: 99 },
        }),
      ]);

    await expect(
      tool.handler({ auditId: 'gwc-source-1' } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/changed after audit.*refusing/i);
    expect(sqlMock).toHaveBeenCalledTimes(3);
  });

  it('restores owned fields while preserving health-metadata churn', async () => {
    const pausePrevious = {
      ...previous,
      metadata: {
        source: 'before',
        gate_health: { lastFireAtMs: 100, status: 'idle' },
      },
    };
    const pauseNext = {
      ...pausePrevious,
      active: false,
      metadata: {
        ...pausePrevious.metadata,
        pause: { reason: 'bounded restart', pausedBy: 'su-test', pausedAtMs: 1 },
      },
    };
    const current = {
      ...pauseNext,
      metadata: {
        ...pauseNext.metadata,
        gate_health: { lastFireAtMs: 200, status: 'healthy' },
      },
    };
    const expected = {
      ...pausePrevious,
      metadata: {
        ...pausePrevious.metadata,
        gate_health: current.metadata.gate_health,
      },
    };

    sqlMock
      .mockResolvedValueOnce([
        {
          action: 'gateway-control.routines:set',
          subject: 'papercusp/git-sync',
          details: { prev: pausePrevious, next: pauseNext },
        },
      ])
      .mockResolvedValueOnce([rowFor(current)])
      .mockResolvedValueOnce([rowFor(current)])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([rowFor(expected)]);

    const result = body(
      await tool.handler({ auditId: 'gwc-source-1' } as never, { role: 'operator' } as never),
    );

    expect(result).toMatchObject({
      ok: true,
      routine: 'papercusp/git-sync',
      applied: true,
      verify: { ok: true },
    });
    const metadataJson = sqlMock.mock.calls
      .flat()
      .find((value) => typeof value === 'string' && value.includes('"gate_health"')) as string | undefined;
    expect(metadataJson).toBeDefined();
    expect(JSON.parse(metadataJson!)).toEqual(expected.metadata);
    expect(sqlMock.mock.calls.flat()).toContain(true);
  });

  it('rejects an audit id from another control action', async () => {
    sqlMock.mockResolvedValueOnce([
      { action: 'gateway-control.quota:set_tool', subject: 'thing', details: { prev: {}, next: {} } },
    ]);

    await expect(
      tool.handler({ auditId: 'gwc-not-routines' } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/not a routines:set mutation/i);
    expect(controlMock).not.toHaveBeenCalled();
  });
});
