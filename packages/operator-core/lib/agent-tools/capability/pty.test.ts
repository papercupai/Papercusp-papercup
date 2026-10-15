import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

const mocks = vi.hoisted(() => {
  const state: {
    task: Record<string, unknown> | null;
    handle: Record<string, any> | null;
    writes: string[];
    resizes: Array<{ cols: number; rows: number }>;
  } = { task: null, handle: null, writes: [], resizes: [] };

  const beginSyncEnrolment = vi.fn(() => ({
    taskId: 'mptysession001',
    confined: true,
    unconfinedReason: null as string | null,
    unitKind: 'scope',
    scopeUnit: 'pc-mptysession001.scope' as string | null,
    enrolled: true,
    registrationReady: null as Promise<void> | null,
    wrap: vi.fn((binary: string, argv: string[]) => ({ binary: 'systemd-run', argv: ['--scope', binary, ...argv] })),
  }));
  const completeSyncEnrolment = vi.fn((enrolment: any, spec: any, pid: number, opts: any) => {
    state.task = {
      taskId: enrolment.taskId,
      class: spec.class,
      workspaceId: opts.workspaceId,
      harnessSlug: spec.harnessSlug,
      launchedBy: spec.launchedBy,
      detail: spec.detail,
      state: 'running',
    };
    enrolment.registrationReady = Promise.resolve();
  });
  const finishSyncEnrolment = vi.fn();
  const syncEnrolmentScopePath = vi.fn(() => '/user.slice/papercusp-pty.slice/pc-mptysession001.scope');
  const spawnPty = vi.fn((opts: any) => {
    const handle = {
      id: 'pty-local-1',
      taskId: opts.taskId,
      accessScope: opts.accessScope,
      pty: { pid: 4242 },
      headless: { cols: opts.cols, rows: opts.rows },
      onExit: new Set<(code: number, signal: number) => void>(),
      killed: false,
      exitCode: null,
    };
    state.handle = handle;
    return handle;
  });
  const getPtyByTaskId = vi.fn((taskId: string, scope: any) => {
    const handle = state.handle;
    if (!handle || handle.taskId !== taskId) return undefined;
    return JSON.stringify(handle.accessScope) === JSON.stringify(scope) ? handle : undefined;
  });
  const writePty = vi.fn((_id: string, data: Buffer) => {
    if (state.handle?.killed) return false;
    state.writes.push(data.toString('utf8'));
    return true;
  });
  const getScreenSerialization = vi.fn(async () => '\u001b[2JREADY>');
  const resizePty = vi.fn((_id: string, cols: number, rows: number) => {
    if (!state.handle || state.handle.killed) return false;
    state.handle.headless.cols = cols;
    state.handle.headless.rows = rows;
    state.resizes.push({ cols, rows });
    return true;
  });
  const killPty = vi.fn(() => true);
  const killTask = vi.fn();
  // WI-10003626: the owner-rpc seam. `ownerHandler` survives vi.clearAllMocks()
  // because it is captured into plain state at module import, not read back from
  // mock.calls (which beforeEach clears).
  const ownerRpc: { handler: ((payload: unknown) => Promise<unknown>) | null } = { handler: null };
  const callOwnerProcess = vi.fn();
  const registerOwnerRpcHandler = vi.fn((kind: string, handler: (payload: unknown) => Promise<unknown>) => {
    if (kind === 'capability-pty') ownerRpc.handler = handler;
  });

  return {
    state,
    ownerRpc,
    callOwnerProcess,
    registerOwnerRpcHandler,
    beginSyncEnrolment,
    completeSyncEnrolment,
    finishSyncEnrolment,
    syncEnrolmentScopePath,
    spawnPty,
    getPtyByTaskId,
    writePty,
    resizePty,
    getScreenSerialization,
    killPty,
    killTask,
    getTask: vi.fn(async () => state.task),
    scrubExecEnv: vi.fn(() => ({ PATH: '/usr/bin', HOME: '/home/test' })),
  };
});

vi.mock('../../task-manager/enroll-sync', () => ({
  beginSyncEnrolment: mocks.beginSyncEnrolment,
  completeSyncEnrolment: mocks.completeSyncEnrolment,
  finishSyncEnrolment: mocks.finishSyncEnrolment,
  syncEnrolmentScopePath: mocks.syncEnrolmentScopePath,
}));
vi.mock('../../task-manager/store', () => ({ getTask: mocks.getTask }));
vi.mock('../../task-manager/control', () => ({ killTask: mocks.killTask }));
vi.mock('../../pty-bridge', () => ({
  spawnPty: mocks.spawnPty,
  spawnGovernedPty: (opts: unknown) => mocks.spawnPty(opts),
  getPtyByTaskId: mocks.getPtyByTaskId,
  writePty: mocks.writePty,
  resizePty: mocks.resizePty,
  getScreenSerialization: mocks.getScreenSerialization,
  killPty: mocks.killPty,
}));
vi.mock('../../pty-ticket', () => ({ localPtyHostId: () => 'host-test' }));
vi.mock('../../cluster-owner-rpc', () => ({
  callOwnerProcess: mocks.callOwnerProcess,
  registerOwnerRpcHandler: mocks.registerOwnerRpcHandler,
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: (ctx: { uiClientId?: string; workspaceId?: string }) => ({
    ownerId: ctx.uiClientId ?? 'su-test',
    ownerLabel: 'su test',
    source: 'omp-hook-session',
    workspaceId: ctx.workspaceId ?? null,
    userId: null,
  }),
}));
vi.mock('../_harness-scope', () => ({
  resolveConcreteHarnessSlug: (_arg: unknown, ctx: { harnessSlug?: string }) =>
    ctx.harnessSlug && ctx.harnessSlug !== '*' ? ctx.harnessSlug : null,
}));
vi.mock('./base-dir', () => ({ resolveCapabilityBaseDir: () => '/repo' }));
vi.mock('./exec-sandbox', () => ({ scrubExecEnv: mocks.scrubExecEnv }));

import {
  ptyKillTool,
  ptyOpenTool,
  ptyReadScreenTool,
  ptyResizeTool,
  ptyWriteStdinTool,
} from './pty';

function ctx(ownerId = 'su-a', workspaceId = 'ws-a', harnessSlug = 'papercusp') {
  return {
    uiClientId: ownerId,
    isSuperuser: true,
    workspaceId,
    harnessSlug,
    projectDir: '/repo',
    principal: { slug: 'system:superuser', workspaceId },
  } as never;
}

function parseText(result: unknown): Record<string, any> {
  const typed = result as { content: Array<{ type: string; text?: string }> };
  return JSON.parse(typed.content[0]!.text!);
}

beforeEach(() => {
  mocks.state.task = null;
  mocks.state.handle = null;
  mocks.state.writes = [];
  mocks.state.resizes = [];
  vi.clearAllMocks();
  mocks.killTask.mockResolvedValue({
    ok: true,
    taskId: 'mptysession001',
    action: 'kill',
    detail: 'scope pc-mptysession001.scope signalled SIGTERM — verified empty',
  });
  mocks.beginSyncEnrolment.mockImplementation(() => ({
    taskId: 'mptysession001',
    confined: true,
    unconfinedReason: null,
    unitKind: 'scope',
    scopeUnit: 'pc-mptysession001.scope',
    enrolled: true,
    registrationReady: null,
    wrap: vi.fn((binary: string, argv: string[]) => ({ binary: 'systemd-run', argv: ['--scope', binary, ...argv] })),
  }));
});

describe('interactive PTY capability family', () => {
  it('opens a confined task-ledger session and exposes only its durable task id', async () => {
    const result = await ptyOpenTool.handler(
      { command: 'node', cwd: 'packages/operator-core', cols: 100, rows: 30 },
      ctx(),
    );
    const payload = parseText(result);

    expect(payload).toEqual({ ok: true, task_id: 'mptysession001', confined: true, cols: 100, rows: 30 });
    expect(JSON.stringify(result)).not.toContain('pty-local-1');
    expect(mocks.beginSyncEnrolment).toHaveBeenCalledWith({ class: 'pty' });
    expect(mocks.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'systemd-run',
        args: ['--scope', 'bash', '-lc', 'node'],
        cwd: '/repo/packages/operator-core',
        inheritEnv: false,
        taskId: 'mptysession001',
        accessScope: {
          tenantId: 'ws-a',
          workspaceId: 'ws-a',
          harnessSlug: 'papercusp',
          hostId: 'host-test',
          principalId: 'su-a',
        },
      }),
    );
    expect(mocks.completeSyncEnrolment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        class: 'pty',
        launchedBy: 'su-a',
        harnessSlug: 'papercusp',
        detail: expect.objectContaining({
          capabilityPty: true,
          ptyHandleId: 'pty-local-1',
          principalId: 'su-a',
        }),
      }),
      4242,
      { workspaceId: 'ws-a' },
    );
  });

  it('re-authorizes write, resize, screen-read, and kill by task id under the current caller', async () => {
    await ptyOpenTool.handler({ command: 'bash' }, ctx());

    const write = await ptyWriteStdinTool.handler(
      { task_id: 'mptysession001', data: 'echo ok\n' },
      ctx(),
    );
    expect(parseText(write)).toMatchObject({ ok: true, task_id: 'mptysession001', bytes_written: 8 });
    expect(mocks.state.writes).toEqual(['echo ok\n']);

    const resized = await ptyResizeTool.handler(
      { task_id: 'mptysession001', cols: 111, rows: 37 },
      ctx(),
    );
    expect(parseText(resized)).toEqual({
      ok: true,
      task_id: 'mptysession001',
      cols: 111,
      rows: 37,
    });
    expect(mocks.state.resizes).toEqual([{ cols: 111, rows: 37 }]);
    expect(mocks.resizePty).toHaveBeenCalledWith(
      'pty-local-1',
      111,
      37,
      expect.objectContaining({ principalId: 'su-a' }),
    );

    const read = (await ptyReadScreenTool.handler(
      { task_id: 'mptysession001' },
      ctx(),
    )) as unknown as {
      content: Array<Record<string, unknown>>;
      _meta: { pty: Record<string, unknown> };
    };
    expect(CallToolResultSchema.safeParse(read).success).toBe(true);
    expect(read.content).toEqual([
      {
        type: 'resource',
        resource: {
          uri: 'papercusp://pty/mptysession001/screen?cols=111&rows=37',
          mimeType: 'application/x-papercusp-pty-screen+ansi',
          text: '\u001b[2JREADY>',
        },
      },
    ]);
    expect(read._meta.pty).toEqual({
      task_id: 'mptysession001',
      encoding: 'utf-8',
      cols: 111,
      rows: 37,
    });

    const killed = await ptyKillTool.handler({ task_id: 'mptysession001' }, ctx());
    expect(parseText(killed)).toEqual({ ok: true, task_id: 'mptysession001', killed: true });
    expect(mocks.killPty).toHaveBeenLastCalledWith(
      'pty-local-1',
      expect.objectContaining({ principalId: 'su-a' }),
    );
    expect(mocks.getTask).toHaveBeenCalledTimes(4);
  });

  it('reattaches after a client carry-respawn and makes screen-read retries idempotent', async () => {
    await ptyOpenTool.handler({ command: 'bash' }, ctx('su-a'));
    const durableTask = { ...mocks.state.task };
    const durableHandle = mocks.state.handle;

    // A carry-respawn creates a fresh client context but leaves the server-side
    // ledger row and PTY bridge alive. The durable task id is the only state the
    // successor needs; no process-local PTY id crosses the model-facing seam.
    const resumedCtx = ctx('su-a');
    mocks.state.task = durableTask;
    mocks.state.handle = durableHandle;
    const first = await ptyReadScreenTool.handler({ task_id: 'mptysession001' }, resumedCtx);
    const retry = await ptyReadScreenTool.handler({ task_id: 'mptysession001' }, resumedCtx);

    expect(first).toEqual(retry);
    expect(mocks.spawnPty).toHaveBeenCalledTimes(1);
    expect(mocks.getTask).toHaveBeenCalledTimes(2);
    expect(mocks.getScreenSerialization).toHaveBeenCalledTimes(2);
    expect(mocks.getScreenSerialization).toHaveBeenNthCalledWith(
      1,
      'pty-local-1',
      expect.objectContaining({ principalId: 'su-a' }),
    );
    expect(JSON.stringify(first)).not.toContain('pty-local-1');
  });

  it('collapses cross-owner and malformed task rows to the same unknown_task_id result', async () => {
    await ptyOpenTool.handler({ command: 'bash' }, ctx('su-a'));

    const foreign = await ptyWriteStdinTool.handler(
      { task_id: 'mptysession001', data: 'stolen\n' },
      ctx('su-b'),
    );
    expect(parseText(foreign)).toEqual({ ok: false, reason: 'unknown_task_id', task_id: 'mptysession001' });
    expect((foreign as { isError?: boolean }).isError).toBe(true);

    mocks.state.task = { ...mocks.state.task, class: 'bash-job' };
    const malformed = await ptyKillTool.handler({ task_id: 'mptysession001' }, ctx('su-a'));
    expect(parseText(malformed)).toEqual({ ok: false, reason: 'unknown_task_id', task_id: 'mptysession001' });
    expect(mocks.writePty).not.toHaveBeenCalled();
    expect(mocks.killPty).not.toHaveBeenCalled();
  });

  it('distinguishes an ended PTY from an unrecoverable lost live handle without starting a replacement', async () => {
    await ptyOpenTool.handler({ command: 'bash' }, ctx('su-a'));
    mocks.state.handle = null;

    const lost = await ptyReadScreenTool.handler({ task_id: 'mptysession001' }, ctx('su-a'));
    expect(parseText(lost)).toMatchObject({
      ok: false,
      reason: 'pty_session_unavailable',
      state: 'running',
      reattachment: 'unrecoverable',
      restart_required: true,
      replacement_started: false,
    });
    expect(mocks.spawnPty).toHaveBeenCalledTimes(1);

    mocks.state.task = {
      ...mocks.state.task,
      state: 'exited',
      exitCode: 0,
      exitReason: null,
    };
    const ended = await ptyReadScreenTool.handler({ task_id: 'mptysession001' }, ctx('su-a'));
    expect(parseText(ended)).toMatchObject({
      ok: false,
      reason: 'pty_session_ended',
      state: 'exited',
      exit_code: 0,
      reattachment: 'not_applicable',
      replacement_started: false,
    });
    expect(mocks.spawnPty).toHaveBeenCalledTimes(1);
  });

  it('reports terminal truth for mutations while an exited handle is retained for its final screen', async () => {
    await ptyOpenTool.handler({ command: 'bash' }, ctx());
    mocks.state.task = { ...mocks.state.task, state: 'exited', exitCode: 0, exitReason: null };
    mocks.state.handle!.killed = true;
    mocks.state.handle!.exitCode = 0;
    for (const result of [
      await ptyWriteStdinTool.handler({ task_id: 'mptysession001', data: 'late\n' }, ctx()),
      await ptyResizeTool.handler({ task_id: 'mptysession001', cols: 100, rows: 30 }, ctx()),
    ]) {
      expect(parseText(result)).toMatchObject({ reason: 'pty_session_ended', state: 'exited', exit_code: 0, replacement_started: false });
    }
    expect(mocks.writePty).not.toHaveBeenCalled();
    expect(mocks.resizePty).not.toHaveBeenCalled();
    const final = await ptyReadScreenTool.handler({ task_id: 'mptysession001' }, ctx());
    expect((final as any).content[0].resource.text).toBe('\u001b[2JREADY>');
  });

  it('releases the environment transport when a governed PTY cannot spawn', async () => {
    const release = vi.fn();
    mocks.beginSyncEnrolment.mockImplementationOnce(() => ({
      taskId: 'mptysession001', confined: true, unconfinedReason: null,
      unitKind: 'scope', scopeUnit: 'pc-mptysession001.scope', enrolled: true,
      registrationReady: null, releaseEnvironmentTransport: release,
      wrap: vi.fn((binary: string, argv: string[]) => ({ binary, argv })),
    }));
    mocks.spawnPty.mockImplementationOnce(() => { throw new Error('governor refused spawn'); });
    const result = await ptyOpenTool.handler({ command: 'bash' }, ctx());
    expect(parseText(result)).toMatchObject({ reason: 'pty_spawn_failed' });
    expect(release).toHaveBeenCalledTimes(1);
    expect(mocks.completeSyncEnrolment).not.toHaveBeenCalled();
  });

  it('kills a live PTY through the durable task manager after its local handle is lost', async () => {
    await ptyOpenTool.handler({ command: 'bash' }, ctx('su-a'));
    mocks.state.handle = null;
    mocks.state.task = {
      ...mocks.state.task,
      confined: true,
      scopeUnit: 'pc-mptysession001.scope',
    };

    const result = await ptyKillTool.handler({ task_id: 'mptysession001' }, ctx('su-a'));

    expect(parseText(result)).toEqual({
      ok: true,
      task_id: 'mptysession001',
      killed: true,
      via: 'task-manager',
      detail: 'scope pc-mptysession001.scope signalled SIGTERM — verified empty',
    });
    expect(mocks.killTask).toHaveBeenCalledWith('mptysession001');
    expect(mocks.killPty).not.toHaveBeenCalled();
    expect(mocks.spawnPty).toHaveBeenCalledTimes(1);
  });

  it('records the owning process and host on the durable row at open', async () => {
    await ptyOpenTool.handler({ command: 'bash' }, ctx('su-a'));
    expect(mocks.state.task?.detail).toMatchObject({
      ptyOwnerPid: process.pid,
      ptyOwnerHostId: 'host-test',
    });
  });

  it('forwards a follow-up to the owning cluster worker and returns its result unchanged (WI-10003626)', async () => {
    await ptyOpenTool.handler({ command: 'bash' }, ctx('su-a'));
    // This worker does NOT hold the handle; a sibling worker (different pid) does.
    mocks.state.handle = null;
    const ownerPid = process.pid + 100_000;
    mocks.state.task = { ...mocks.state.task, detail: { ...(mocks.state.task!.detail as object), ptyOwnerPid: ownerPid } };
    const ownerResult = {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, task_id: 'mptysession001', bytes_written: 8 }) }],
    };
    mocks.callOwnerProcess.mockResolvedValue({ ok: true, result: ownerResult });

    const result = await ptyWriteStdinTool.handler({ task_id: 'mptysession001', data: 'echo ok\n' }, ctx('su-a'));

    expect(result).toEqual(ownerResult);
    expect(mocks.callOwnerProcess).toHaveBeenCalledWith({
      targetPid: ownerPid,
      kind: 'capability-pty',
      payload: {
        op: { op: 'write', task_id: 'mptysession001', data: 'echo ok\n' },
        caller: {
          ownerId: 'su-a',
          workspaceId: 'ws-a',
          harnessSlug: 'papercusp',
          accessScope: {
            tenantId: 'ws-a',
            workspaceId: 'ws-a',
            harnessSlug: 'papercusp',
            hostId: 'host-test',
            principalId: 'su-a',
          },
        },
      },
    });
    expect(mocks.killTask).not.toHaveBeenCalled();
    expect(mocks.writePty).not.toHaveBeenCalled();
  });

  it('owner side re-authorizes a forwarded request and executes it against its local handle', async () => {
    await ptyOpenTool.handler({ command: 'bash' }, ctx('su-a'));
    const handler = mocks.ownerRpc.handler;
    expect(handler).toBeTypeOf('function');
    const scope = (ownerId: string) => ({
      ownerId,
      workspaceId: 'ws-a',
      harnessSlug: 'papercusp',
      accessScope: { tenantId: 'ws-a', workspaceId: 'ws-a', harnessSlug: 'papercusp', hostId: 'host-test', principalId: ownerId },
    });

    const wrote = await handler!({ op: { op: 'write', task_id: 'mptysession001', data: 'ls\n' }, caller: scope('su-a') });
    expect(parseText(wrote)).toEqual({ ok: true, task_id: 'mptysession001', bytes_written: 3 });
    expect(mocks.state.writes).toEqual(['ls\n']);

    const resized = await handler!({ op: { op: 'resize', task_id: 'mptysession001', cols: 90, rows: 20 }, caller: scope('su-a') });
    expect(parseText(resized)).toEqual({ ok: true, task_id: 'mptysession001', cols: 90, rows: 20 });

    const read = (await handler!({ op: { op: 'read', task_id: 'mptysession001' }, caller: scope('su-a') })) as any;
    expect(read.content[0].resource.text).toBe('\u001b[2JREADY>');
    expect(read._meta.pty).toEqual({ task_id: 'mptysession001', encoding: 'utf-8', cols: 90, rows: 20 });

    // A forwarded request is authorized exactly like a direct call: a foreign
    // principal still collapses to unknown_task_id and nothing is written.
    const foreign = await handler!({ op: { op: 'write', task_id: 'mptysession001', data: 'x' }, caller: scope('su-b') });
    expect(parseText(foreign)).toEqual({ ok: false, reason: 'unknown_task_id', task_id: 'mptysession001' });
    expect(mocks.state.writes).toEqual(['ls\n']);

    const malformed = await handler!({ op: { op: 'write', task_id: 'mptysession001' }, caller: scope('su-a') });
    expect(parseText(malformed)).toMatchObject({ ok: false, reason: 'pty_owner_protocol_error' });
    const otherHost = await handler!({
      op: { op: 'read', task_id: 'mptysession001' },
      caller: { ...scope('su-a'), accessScope: { ...scope('su-a').accessScope, hostId: 'elsewhere:3170' } },
    });
    expect(parseText(otherHost)).toMatchObject({ ok: false, reason: 'pty_owner_protocol_error', cause: 'host_mismatch' });
  });

  it('settles the durable row when the owning worker is gone, and says so', async () => {
    await ptyOpenTool.handler({ command: 'bash' }, ctx('su-a'));
    mocks.state.handle = null;
    const ownerPid = process.pid + 100_000;
    mocks.state.task = { ...mocks.state.task, detail: { ...(mocks.state.task!.detail as object), ptyOwnerPid: ownerPid } };
    mocks.callOwnerProcess.mockResolvedValue({ ok: false, code: 'owner_gone', message: 'no live cluster worker' });

    const read = await ptyReadScreenTool.handler({ task_id: 'mptysession001' }, ctx('su-a'));
    expect(parseText(read)).toMatchObject({
      ok: false,
      reason: 'pty_session_unavailable',
      cause: 'owner_process_gone',
      owner_pid: ownerPid,
      reattachment: 'unrecoverable',
      ledger_settled: true,
      replacement_started: false,
    });
    expect(mocks.killTask).toHaveBeenCalledWith('mptysession001');

    mocks.killTask.mockClear();
    const killed = await ptyKillTool.handler({ task_id: 'mptysession001' }, ctx('su-a'));
    expect(parseText(killed)).toMatchObject({
      ok: true,
      killed: true,
      via: 'task-manager',
      cause: 'owner_process_gone',
      owner_pid: ownerPid,
    });
    expect(mocks.killTask).toHaveBeenCalledWith('mptysession001');
    expect(mocks.spawnPty).toHaveBeenCalledTimes(1);
  });

  it('reports a live-but-silent owner as retryable and leaves the session untouched', async () => {
    await ptyOpenTool.handler({ command: 'bash' }, ctx('su-a'));
    mocks.state.handle = null;
    mocks.state.task = {
      ...mocks.state.task,
      detail: { ...(mocks.state.task!.detail as object), ptyOwnerPid: process.pid + 100_000 },
    };
    mocks.callOwnerProcess.mockResolvedValue({ ok: false, code: 'timeout', message: 'no response within 15000ms' });

    const result = await ptyResizeTool.handler({ task_id: 'mptysession001', cols: 100, rows: 40 }, ctx('su-a'));
    expect(parseText(result)).toMatchObject({
      ok: false,
      reason: 'pty_owner_unreachable',
      cause: 'timeout',
      reattachment: 'retry',
      replacement_started: false,
    });
    expect(mocks.killTask).not.toHaveBeenCalled();
  });

  it('never forwards to or reaps a PTY owned by a different operator host', async () => {
    await ptyOpenTool.handler({ command: 'bash' }, ctx('su-a'));
    mocks.state.handle = null;
    mocks.state.task = {
      ...mocks.state.task,
      detail: { ...(mocks.state.task!.detail as object), ptyOwnerPid: process.pid + 100_000, ptyOwnerHostId: 'box:3170' },
    };

    const killed = await ptyKillTool.handler({ task_id: 'mptysession001' }, ctx('su-a'));
    expect(parseText(killed)).toMatchObject({
      ok: false,
      reason: 'pty_session_unavailable',
      cause: 'owned_by_other_host',
      owner_host: 'box:3170',
    });
    expect(mocks.callOwnerProcess).not.toHaveBeenCalled();
    expect(mocks.killTask).not.toHaveBeenCalled();
  });

  it('on an unclustered host, settles a row whose owner pid died (restart) but not one whose owner still runs', async () => {
    await ptyOpenTool.handler({ command: 'bash' }, ctx('su-a'));
    mocks.state.handle = null;
    mocks.callOwnerProcess.mockResolvedValue({ ok: false, code: 'not_clustered', message: 'no relay' });
    const withOwner = (pid: number) => {
      mocks.state.task = { ...mocks.state.task, detail: { ...(mocks.state.task!.detail as object), ptyOwnerPid: pid } };
    };

    // Beyond any Linux pid_max, so kill(pid, 0) is ESRCH: the previous incarnation is gone.
    withOwner(2_000_000_000);
    const gone = await ptyWriteStdinTool.handler({ task_id: 'mptysession001', data: 'x' }, ctx('su-a'));
    expect(parseText(gone)).toMatchObject({ reason: 'pty_session_unavailable', cause: 'owner_process_restarted' });
    expect(mocks.killTask).toHaveBeenCalledTimes(1);

    // The parent of this test process is certainly alive: never reap on a guess.
    withOwner(process.ppid);
    const alive = await ptyWriteStdinTool.handler({ task_id: 'mptysession001', data: 'x' }, ctx('su-a'));
    expect(parseText(alive)).toMatchObject({ reason: 'pty_owner_unreachable', cause: 'not_clustered' });
    expect(mocks.killTask).toHaveBeenCalledTimes(1);
  });

  it('fails closed before spawn when cgroup confinement is unavailable', async () => {
    mocks.beginSyncEnrolment.mockImplementationOnce(() => ({
      taskId: 'mptysession001',
      confined: false,
      unconfinedReason: 'probe-pending',
      unitKind: 'scope',
      scopeUnit: null,
      enrolled: true,
      registrationReady: null,
      wrap: vi.fn(),
    }));

    const result = await ptyOpenTool.handler({ command: 'bash' }, ctx());
    expect(parseText(result)).toMatchObject({
      ok: false,
      reason: 'pty_confinement_unavailable',
      unconfined_reason: 'probe-pending',
    });
    expect(mocks.spawnPty).not.toHaveBeenCalled();
  });
});
