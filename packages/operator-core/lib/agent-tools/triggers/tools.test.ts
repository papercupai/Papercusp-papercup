import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadSnapshot = vi.fn();
const createSource = vi.fn();
const createBinding = vi.fn();
const migrateBinding = vi.fn();
const setArmed = vi.fn();
const queueLastEvent = vi.fn();
const invalidate = vi.fn();

vi.mock('../../external-triggers/admin', () => ({
  loadExternalTriggerAdminSnapshot: (...args: unknown[]) => loadSnapshot(...args),
  createExternalTriggerSource: (...args: unknown[]) => createSource(...args),
  createExternalTriggerBinding: (...args: unknown[]) => createBinding(...args),
  migrateExternalTriggerPlanBindingToOperation: (...args: unknown[]) => migrateBinding(...args),
  setExternalTriggerBindingArmed: (...args: unknown[]) => setArmed(...args),
  queueExternalTriggerLastEventTestRun: (...args: unknown[]) => queueLastEvent(...args),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: { test: true } }),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-fallback' }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-test', workspaceId: 'ws-1' }),
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: (...args: unknown[]) => invalidate(...args) }));

import listTool from './list';
import createTool from './create';
import bindTool from './bind';
import armTool from './arm';
import disarmTool from './disarm';
import runWithLastEventTool from './run-with-last-event';
import statusTool from './status';

const ctx = { workspaceId: 'ws-1', role: 'operator' } as never;
const body = (out: unknown) => (out as { data: unknown }).data as any;
const snapshot = {
  enabled: true,
  counts: { sources: 2, bindings: 2, armed: 1, recentFailures: 1 },
  sources: [
    { id: '00000000-0000-4000-8000-000000000001', kind: 'gmail' },
    { id: '00000000-0000-4000-8000-000000000002', kind: 'slack' },
  ],
  bindings: [
    {
      id: '10000000-0000-4000-8000-000000000001',
      sourceId: '00000000-0000-4000-8000-000000000001',
      planSlug: 'email',
      armed: true,
    },
    {
      id: '10000000-0000-4000-8000-000000000002',
      sourceId: '00000000-0000-4000-8000-000000000002',
      planSlug: 'thread',
      armed: false,
    },
  ],
  recentRuns: [{ id: 'run-1', bindingId: '10000000-0000-4000-8000-000000000001', status: 'failed' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  loadSnapshot.mockResolvedValue(snapshot);
  createSource.mockResolvedValue({ id: '00000000-0000-4000-8000-000000000003', kind: 'slack' });
  createBinding.mockResolvedValue({ id: '10000000-0000-4000-8000-000000000003', armed: false });
  migrateBinding.mockResolvedValue({
    legacyBindingId: '10000000-0000-4000-8000-000000000001',
    replacement: { id: '10000000-0000-4000-8000-000000000004', armed: false },
    replayed: false,
    parity: { sourceId: '00000000-0000-4000-8000-000000000001' },
  });
  setArmed.mockImplementation(async (_sql, _ws, id, armed) => ({ id, armed }));
  queueLastEvent.mockResolvedValue({
    ok: true,
    run: {
      id: '30000000-0000-4000-8000-000000000001',
      bindingId: '10000000-0000-4000-8000-000000000001',
      sourceTriggerRunId: '30000000-0000-4000-8000-000000000000',
      sourceDeliveryId: '40000000-0000-4000-8000-000000000001',
      providerDedupeKey: 'gmail:message-1',
      status: 'pending',
      triggeredAt: '2026-08-24T00:00:00.000Z',
      requestedBy: 'su-test',
      providerWritePossible: true,
    },
  });
  invalidate.mockResolvedValue(undefined);
});

describe('triggers:* tool surface', () => {
  it('registers all seven tools with routing guidance', () => {
    const tools = [listTool, createTool, bindTool, armTool, disarmTool, runWithLastEventTool, statusTool];
    expect(tools.map((tool) => tool.name)).toEqual([
      'triggers:list',
      'triggers:create',
      'triggers:bind',
      'triggers:arm',
      'triggers:disarm',
      'triggers:run-with-last-event',
      'triggers:status',
    ]);
    for (const tool of tools) {
      expect(tool.guidance?.when).toBeTruthy();
      expect(tool.guidance?.notWhen).toBeTruthy();
    }
  });

  it('lists and filters sources plus bindings together', async () => {
    const out = body(await listTool.handler({ sourceKind: 'slack', plan: 'thread', limit: 100 } as never, ctx));
    expect(out).toMatchObject({ ok: true, counts: { sources: 1, bindings: 1 } });
    expect(out.sources[0].kind).toBe('slack');
    expect(out.bindings[0].planSlug).toBe('thread');
  });

  it('creates a source with server-authored attribution and invalidates sync', async () => {
    const out = body(await createTool.handler({ kind: 'slack', config: { teamId: 'T1' } } as never, ctx));
    expect(out.ok).toBe(true);
    expect(createSource).toHaveBeenCalledWith(expect.anything(), 'ws-1', {
      kind: 'slack',
      config: { teamId: 'T1' },
      createdBy: 'su-test',
    });
    expect(invalidate).toHaveBeenCalledWith('externalTriggers.admin', { workspaceId: 'ws-1' });
  });

  it('installs a binding disarmed through the shared seam', async () => {
    const out = body(
      await bindTool.handler(
        {
          sourceId: '00000000-0000-4000-8000-000000000002',
          harness: 'papercusp',
          plan: 'thread',
          eventPattern: 'ext:slack:mention',
        } as never,
        ctx,
      ),
    );
    expect(out.binding.armed).toBe(false);
    expect(createBinding).toHaveBeenCalledWith(
      expect.anything(),
      'ws-1',
      expect.objectContaining({
        planHarnessSlug: 'papercusp',
        planSlug: 'thread',
        createdBy: 'su-test',
      }),
    );
  });

  it('accepts and forwards explicit coalescing mode and refuses an unknown mode', async () => {
    const input = {
      sourceId: '00000000-0000-4000-8000-000000000002', harness: 'papercusp', plan: 'thread',
      eventPattern: 'ext:slack:mention', stormPolicy: { mode: 'coalesce-with-cap' },
    };
    const parsed = bindTool.args.parse(input);
    await bindTool.handler(parsed, ctx);
    expect(createBinding).toHaveBeenCalledWith(expect.anything(), 'ws-1', expect.objectContaining({
      stormPolicy: { mode: 'coalesce-with-cap' },
    }));
    expect(() => bindTool.args.parse({ ...input, stormPolicy: { mode: 'invented' } })).toThrow();
  });

  it('maps the standard operation target and literal input through the shared bind seam', async () => {
    await bindTool.handler({
      sourceId: '00000000-0000-4000-8000-000000000002',
      operationHarnessSlug: 'papercusp',
      operationId: 'triage-message',
      input: { priority: 'normal' },
      eventPattern: 'ext:slack:mention',
    } as never, ctx);
    expect(createBinding).toHaveBeenCalledWith(expect.anything(), 'ws-1', expect.objectContaining({
      operationHarnessSlug: 'papercusp',
      operationId: 'triage-message',
      operationInput: { priority: 'normal' },
      planHarnessSlug: null,
      planSlug: null,
    }));
  });

  it('copies a legacy plan binding into one disarmed operation replacement', async () => {
    const out = body(
      await bindTool.handler(
        {
          migrateFromBindingId: '10000000-0000-4000-8000-000000000001',
          operationHarnessSlug: 'papercusp',
          operationId: 'triage-message',
          input: { priority: 'normal' },
        } as never,
        ctx,
      ),
    );
    expect(out).toMatchObject({
      ok: true,
      migration: {
        legacyBindingId: '10000000-0000-4000-8000-000000000001',
        replacement: { id: '10000000-0000-4000-8000-000000000004', armed: false },
        replayed: false,
      },
    });
    expect(migrateBinding).toHaveBeenCalledWith(expect.anything(), 'ws-1', {
      bindingId: '10000000-0000-4000-8000-000000000001',
      operationHarnessSlug: 'papercusp',
      operationId: 'triage-message',
      operationInput: { priority: 'normal' },
      createdBy: 'su-test',
    });
    expect(createBinding).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith('externalTriggers.admin', { workspaceId: 'ws-1' });
  });

  it('arms and disarms only the named binding', async () => {
    const bindingId = '10000000-0000-4000-8000-000000000002';
    expect(body(await armTool.handler({ bindingId, confirm: true } as never, ctx))).toMatchObject({
      binding: { armed: true },
    });
    expect(body(await disarmTool.handler({ bindingId, confirm: true } as never, ctx))).toMatchObject({
      binding: { armed: false },
    });
    expect(setArmed.mock.calls.map((call) => call.slice(1))).toEqual([
      ['ws-1', bindingId, true],
      ['ws-1', bindingId, false],
    ]);
  });

  it('queues a confirmed last-event test through the shared audited seam', async () => {
    const bindingId = '10000000-0000-4000-8000-000000000001';
    const out = body(await runWithLastEventTool.handler({ bindingId, confirm: true } as never, ctx));
    expect(out).toMatchObject({
      ok: true,
      run: { bindingId, status: 'pending', providerWritePossible: true },
    });
    expect(queueLastEvent).toHaveBeenCalledWith(expect.anything(), 'ws-1', {
      bindingId,
      requestedBy: 'su-test',
    });
    expect(invalidate).toHaveBeenCalledWith('externalTriggers.admin', { workspaceId: 'ws-1' });
  });

  it('returns scoped status and a typed not-found result', async () => {
    const bindingId = '10000000-0000-4000-8000-000000000001';
    const ok = body(await statusTool.handler({ bindingId } as never, ctx));
    expect(ok).toMatchObject({ ok: true, bindings: [{ id: bindingId }], recentRuns: [{ id: 'run-1' }] });
    const missing = body(await statusTool.handler({ sourceId: '00000000-0000-4000-8000-000000000099' } as never, ctx));
    expect(missing).toMatchObject({ ok: false, error: 'source_not_found' });
  });
});
