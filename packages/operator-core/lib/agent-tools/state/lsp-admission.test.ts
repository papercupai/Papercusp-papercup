import { describe, expect, it, vi } from 'vitest';
vi.mock('../../code-intelligence/lsp-daemon-client', () => ({ readLspDaemonAdmission: vi.fn(),
  readLspDaemonHealth: vi.fn(async () => { throw new Error('runtime not measured in queue-only test'); }) }));
import { buildLspAdmissionStatePayload, buildLspRuntimeStatePayload } from './lsp-admission';
import { LspAdmissionController } from '../../code-intelligence/lsp-admission';
import { LSP_ADMISSION_CELL, LSP_READINESS_CELL, LSP_WARM_SERVERS_CELL } from '../../cell-registrations';
import { validateCellSpec } from '../../cell-registry';
import type { LspDaemonAnswer } from '../../code-intelligence/lsp-daemon-protocol';

function runtime(): NonNullable<LspDaemonAnswer['daemonRuntime']> {
  return { enabled: true, overall: 'healthy', pid: 42, node: 'v24', entry: 'daemon', sampledAtMs: Date.now(),
    provisioned: { typescript: true, rust: false, python: false, go: false }, servers: [{ language: 'typescript', rootPath: '/repo', taskId: 'server',
      health: 'healthy', coldStartMs: 10, openDocs: 1, pid: 43, everSettled: true, quiescent: null,
      pendingProgress: 0, progressGeneration: 1, certifiedReadiness: ['definition'], unprovenReadiness: ['references'] }] };
}

describe('daemon LSP admission state lens', () => {
  it('registers a valid cell and reads actual pressure from the owning controller', async () => {
    let done!: () => void;
    const held = new Promise<void>(resolve => { done = resolve; });
    const controller = new LspAdmissionController({ enqueue: async () => ({ start: async () => {}, finish: async () => {}, cancel: async () => {} }) });
    const context = { workspaceId: 'ws', language: 'typescript', projectRoot: '/repo', op: 'references', deadlineAtMs: Date.now() + 10_000 };
    const first = controller.run({ ...context, requestId: 'first' }, () => held);
    const second = controller.run({ ...context, requestId: 'second' }, async () => {});
    expect(validateCellSpec(LSP_ADMISSION_CELL)).toEqual([]);
    const read = vi.fn(async () => controller.snapshot());
    const payload = await buildLspAdmissionStatePayload('ws', read);
    expect(read).toHaveBeenCalledWith('ws');
    expect(payload).toMatchObject({ assessment: 'pressure', measurement: 'measured', unknown: [], admission: { queued: 1, inFlight: 1, measured: true } });
    done(); await Promise.all([first, second]);
    expect(await buildLspAdmissionStatePayload('ws', read)).toMatchObject({ assessment: 'idle', admission: { queued: 0, inFlight: 0 } });
  });

  it('exposes unknown on transport failure or stale state rather than a false empty queue', async () => {
    const failed = await buildLspAdmissionStatePayload('ws', async () => { throw new Error('socket unavailable'); });
    expect(failed).toMatchObject({ admission: null, assessment: 'unknown', measurement: 'unknown' });
    expect(failed.unknown[0]).toContain('socket unavailable');
    const controller = new LspAdmissionController({ enqueue: vi.fn() });
    const stale = await buildLspAdmissionStatePayload('ws', async () => ({ ...controller.snapshot(), sampledAtMs: Date.now() - 30_001 }));
    expect(stale).toMatchObject({ admission: null, assessment: 'unknown' });
  });

  it('reads the owning inventory and keeps healthy processes separate from unproven reference readiness', async () => {
    for (const cell of [LSP_WARM_SERVERS_CELL, LSP_READINESS_CELL]) expect(validateCellSpec(cell)).toEqual([]);
    const read = vi.fn(async () => runtime());
    const payload = await buildLspRuntimeStatePayload('ws', read);
    expect(read).toHaveBeenCalledWith('ws');
    expect(payload).toMatchObject({ runtimeAssessment: 'healthy', runtimeMeasurement: 'measured', runtimeUnknown: [],
      readiness: [{ certified: ['definition'], unproven: ['references'], quiescent: null, progressGeneration: 1 }] });
    expect(payload.runtime!.servers[0].pid).toBe(43);
  });

  it('does not turn failed or stale runtime reads into zero servers, or destroy an independently measured queue', async () => {
    const controller = new LspAdmissionController({ enqueue: vi.fn() });
    const failed = await buildLspAdmissionStatePayload('ws', async () => controller.snapshot(), async () => { throw new Error('health socket failed'); });
    expect(failed).toMatchObject({ assessment: 'idle', measurement: 'measured', unknown: [],
      runtime: null, readiness: null, runtimeAssessment: 'unknown', runtimeMeasurement: 'unknown' });
    expect(failed.runtimeUnknown[0]).toContain('health socket failed');
    const stale = await buildLspRuntimeStatePayload('ws', async () => ({ ...runtime(), sampledAtMs: Date.now() - 30_001 }));
    expect(stale).toMatchObject({ runtime: null, readiness: null, runtimeMeasurement: 'unknown' });
  });
});
