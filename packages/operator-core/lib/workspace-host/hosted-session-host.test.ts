import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SecretStream from '@hyperswarm/secret-stream';
import { ByocSealedChannel } from './byoc-sealed-channel';
import {
  HOSTED_HOST_MAX_FILE_BYTES,
  HOSTED_HOST_MAX_UPLOAD_CHUNK_BYTES,
  HOSTED_HOST_SESSION_IDLE_MS,
  HostedWorkspaceHostSessionAdapter,
  hostedWorkspacePtySpawnSpec,
  SafeRootFileService,
  type HostedDesktopBackend,
  type HostedDesktopDialInput,
  type HostedDesktopSocket,
  type HostedHostOutboundEnvelope,
  type HostedHostPty,
  type HostedHostPtyFactoryInput,
} from './hosted-session-host';
import {
  VIEWER_STREAM_TEARDOWN_CEILING_SEC,
  desktopViewerHeartbeatMs,
} from '../desktop/desktop-lifecycle';
import type { HostedConnectorBinding } from '../endpoint-route/hosted-workspace-connector';
import { HOSTED_WORKSPACE_MAX_MESSAGE_BYTES } from '../endpoint-route/hosted-workspace-session';
import {
  DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
  WORKSPACE_HOST_HOSTED_PTY_KNOWN_HOSTS,
  WORKSPACE_HOST_HOSTED_PTY_SSH_KEY,
} from '@papercusp/deployment-driver';

type RelayEnvelope = Extract<HostedHostOutboundEnvelope, { type: 'relay' }>;

/**
 * Outbound relay frames of one wire type, for counting acks and results.
 *
 * Narrowed on `type: 'relay'` first because the envelope is a union and
 * `relay.close` carries no `payload` at all.
 */
function sentOfType(sent: HostedHostOutboundEnvelope[], type: string): RelayEnvelope[] {
  return sent.filter(
    (message): message is RelayEnvelope =>
      message.type === 'relay' &&
      (message.payload as { type?: string } | undefined)?.type === type,
  );
}

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hosted-session-host-'));
  roots.push(root);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'index.ts'), 'export const value = 1;\n');
  return root;
}

class FakePty extends EventEmitter implements HostedHostPty {
  writes: Buffer[] = [];
  sizes: Array<[number, number]> = [];
  signals: string[] = [];
  killed = false;
  write(data: Buffer) {
    this.writes.push(data);
    return !this.killed;
  }
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows]);
    return !this.killed;
  }
  signal(signal: string) {
    this.signals.push(signal);
    return !this.killed;
  }
  kill() {
    this.killed = true;
  }
  snapshot() {
    return Promise.resolve('restored-screen');
  }
  onData(listener: (data: Buffer) => void) {
    this.on('data', listener);
    return () => this.off('data', listener);
  }
  onExit(listener: (code: number, signal: number) => void) {
    this.on('exit', listener);
    return () => this.off('exit', listener);
  }
  output(value: string) {
    this.emit('data', Buffer.from(value));
  }
}

const binding: HostedConnectorBinding = {
  controlPlaneWorkspaceId: 'control-1',
  organizationId: 'org-1',
  customerWorkspaceId: 'workspace-1',
  hostId: 'host-1',
  routeLabel: 'alpha',
  generation: 4,
  transport: 'websocket',
  state: 'active',
};

function harness(root: string, files?: SafeRootFileService) {
  const sent: HostedHostOutboundEnvelope[] = [];
  const ptys: FakePty[] = [];
  const audit = vi.fn();
  const adapter = new HostedWorkspaceHostSessionAdapter({
    binding,
    workspaceRoot: root,
    ...(files ? { files } : {}),
    send: (message) => sent.push(message),
    onAudit: audit,
    createPty: () => {
      const pty = new FakePty();
      ptys.push(pty);
      return pty;
    },
  });
  const open = (channelId: string, userId = 'user-1', hostedSessionId = 'session-1') =>
    adapter.accept({
      type: 'relay.open',
      channelId,
      userId,
      hostedSessionId,
      audience: 'workspace-operator',
      role: 'controller',
    });
  const relay = (channelId: string, payload: unknown) => adapter.accept({ type: 'relay', channelId, payload });
  return { adapter, sent, ptys, audit, open, relay };
}

describe('hosted customer PTY identity', () => {
  const authority = { userId: 'user-1', sessionId: 'session-1', sessionVersion: 2,
    controlPlaneWorkspaceId: 'control-1', organizationId: 'org-1', customerWorkspaceId: 'workspace-1',
    permissions: ['workspace:operate'] };
  async function authorityHarness() {
    const f = harness(await projectRoot());
    await f.adapter.accept({ type: 'relay.open', channelId: 'http', userId: 'user-1',
      hostedSessionId: 'session-1', audience: 'workspace-operator', role: 'controller', kind: 'operator-http' });
    return f;
  }

  it.each(['detach', 'release', 'close'])('aborts native invocations on channel %s', async action => {
    const f = await authorityHarness();
    const caller = new AbortController();
    const signal = f.adapter.customerInvocationSignal('http', caller.signal);
    expect(signal.aborted).toBe(false);
    if (action === 'detach') await f.adapter.accept({ type: 'relay.close', channelId: 'http' });
    else if (action === 'release') f.adapter.release();
    else f.adapter.close();
    expect(signal.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    expect(() => f.adapter.customerInvocationSignal('http')).toThrow('hosted_customer_execution_denied');
    f.adapter.close();
  });

  it('cannot revive an invocation by reopening the same channel id', async () => {
    const f = await authorityHarness();
    const old = f.adapter.customerInvocationSignal('http');
    await f.adapter.accept({ type: 'relay.close', channelId: 'http' });
    await f.adapter.accept({ type: 'relay.open', channelId: 'http', userId: 'user-1',
      hostedSessionId: 'session-1', audience: 'workspace-operator', role: 'controller', kind: 'operator-http' });
    const fresh = f.adapter.customerInvocationSignal('http');
    expect(old.aborted).toBe(true); expect(fresh.aborted).toBe(false); expect(fresh).not.toBe(old);
    f.adapter.close();
  });

  it('isolates native channel lifetimes and accepts caller cancellation', async () => {
    const f = await authorityHarness();
    await f.adapter.accept({ type: 'relay.open', channelId: 'other', userId: 'user-1',
      hostedSessionId: 'session-1', audience: 'workspace-operator', role: 'controller', kind: 'operator-http' });
    const caller = new AbortController();
    const first = f.adapter.customerInvocationSignal('http', caller.signal);
    const second = f.adapter.customerInvocationSignal('other');
    caller.abort(); expect(first.aborted).toBe(true); expect(second.aborted).toBe(false);
    await f.adapter.accept({ type: 'relay.close', channelId: 'http' });
    expect(second.aborted).toBe(false); f.adapter.close(); expect(second.aborted).toBe(true);
  });

  it('refuses missing and PTY channel labels as invocation authority', async () => {
    const f = harness(await projectRoot()); await f.open('pty');
    for (const channel of ['missing', 'pty']) {
      expect(() => f.adapter.customerInvocationSignal(channel)).toThrow('hosted_customer_execution_denied');
    }
    f.adapter.close();
  });

  it('derives customer authority only from a correlated private connector answer', async () => {
    const f = await authorityHarness();
    const pending = f.adapter.resolveCustomerPrincipal('http');
    const req = f.sent.find(m => m.type === 'session.authorize') as Extract<HostedHostOutboundEnvelope, { type: 'session.authorize' }>;
    await f.adapter.accept({ type: 'relay', channelId: 'http', payload: { ...req, type: 'session.authorized', authority } });
    await f.adapter.accept({ type: 'session.authorized', channelId: 'different', requestId: req.requestId, authority });
    await f.adapter.accept({ type: 'session.authorized', channelId: 'http', requestId: req.requestId, authority });
    expect(await pending).toMatchObject({ ok: true, principal: { userId: 'user-1', sessionVersion: 2,
      activeOrganizationId: 'org-1', selectedWorkspaceId: 'workspace-1' } });
    const next = f.adapter.resolveCustomerPrincipal('http');
    const fresh = f.sent.filter(m => m.type === 'session.authorize').at(-1)!;
    expect(fresh).not.toEqual(req);
    f.adapter.close(); expect(await next).toEqual({ ok: false });
  });
  it('requests diagnostics separately and returns only the correlated control-plane consent', async () => {
    const f = await authorityHarness();
    const pending = f.adapter.resolveCustomerPrincipal('http', undefined, true);
    const req = f.sent.find(m => m.type === 'session.authorize') as Extract<HostedHostOutboundEnvelope, { type: 'session.authorize' }>;
    expect(req.diagnostics).toBe(true);
    const monitoringConsent = { disclosure_version: '2026-10-13', diagnostics: { enabled: false, since: null }, analytics: { enabled: false, since: null } };
    await f.adapter.accept({ ...req, type: 'session.authorized', authority: { ...authority, monitoringConsent } });
    expect(await pending).toMatchObject({ ok: true, monitoringConsent });
    f.adapter.close();
  });

  it.each(['userId', 'sessionId', 'controlPlaneWorkspaceId', 'organizationId',
    'customerWorkspaceId', 'sessionVersion', 'permissions'])(
    'rejects mismatched/malformed %s authority', async key => {
      const f = await authorityHarness(); const pending = f.adapter.resolveCustomerPrincipal('http');
      const req = f.sent.find(m => m.type === 'session.authorize')!;
      await f.adapter.accept({ ...req, type: 'session.authorized', authority: {
        ...authority, [key]: key === 'permissions' ? ['*'] : 'foreign' } });
      expect(await pending).toEqual({ ok: false }); f.adapter.close();
    });

  it('bounds pending authority with cancellation, detach and release, ignoring late answers', async () => {
    for (const action of ['abort', 'detach', 'release']) {
      const f = await authorityHarness(); const controller = new AbortController();
      const pending = f.adapter.resolveCustomerPrincipal('http', controller.signal);
      const req = f.sent.find(m => m.type === 'session.authorize')!;
      if (action === 'abort') controller.abort();
      else if (action === 'detach') await f.adapter.accept({ type: 'relay.close', channelId: 'http' });
      else f.adapter.release();
      expect(await pending).toEqual({ ok: false });
      await f.adapter.accept({ ...req, type: 'session.authorized', authority });
      f.adapter.close();
    }
  });

  it('refuses labels on a PTY channel before sending an authority query', async () => {
    const f = harness(await projectRoot()); await f.open('pty');
    expect(await f.adapter.resolveCustomerPrincipal('pty')).toEqual({ ok: false });
    expect(f.sent).not.toContainEqual(expect.objectContaining({ type: 'session.authorize' })); f.adapter.close();
  });
  it('expires a stalled authority answer and bounds concurrent requests', async () => {
    const f = await authorityHarness();
    vi.useFakeTimers();
    try {
      const pending = Array.from({ length: 64 }, () => f.adapter.resolveCustomerPrincipal('http'));
      expect(await f.adapter.resolveCustomerPrincipal('http')).toEqual({ ok: false });
      expect(f.sent.filter(m => m.type === 'session.authorize')).toHaveLength(64);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await Promise.all(pending)).toEqual(Array.from({ length: 64 }, () => ({ ok: false })));
    } finally { f.adapter.close(); vi.useRealTimers(); }
  });

  it('uses pinned loopback SSH into the workspace account with a clean remote environment', () => {
    const spec = hostedWorkspacePtySpawnSpec({
      scope: {} as never,
      hostedSessionId: 'hosted-1',
      workspaceRoot: '/srv/papercusp/workspaces',
      cols: 80,
      rows: 24,
    });
    expect(spec.command).toBe('/usr/bin/ssh');
    expect(spec.args).toContain(WORKSPACE_HOST_HOSTED_PTY_SSH_KEY);
    expect(spec.args).toContain(`UserKnownHostsFile=${WORKSPACE_HOST_HOSTED_PTY_KNOWN_HOSTS}`);
    expect(spec.args).toContain('StrictHostKeyChecking=yes');
    expect(spec.args).toContain('127.0.0.1');
    expect(spec.args).toContain(DEFAULT_WORKSPACE_HOST_WORKSPACE_USER);
    expect(spec.args.at(-1)).toContain('exec env -i HOME=');
    expect(spec.args.at(-1)).toContain('PATH=/usr/local/bin:/usr/bin:/bin');
    expect(spec.args.at(-1)).not.toContain('/var/lib/papercusp');
    expect(spec.inheritEnv).toBe(false);
    expect(spec.env).toEqual({ HOME: '/', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'xterm-256color' });
  });
});

describe('membership.report frames (WI-10004257)', () => {
  function membershipHarness(onMembershipReport?: (report: unknown) => void) {
    const sent: HostedHostOutboundEnvelope[] = [];
    const warnings: string[] = [];
    const adapter = new HostedWorkspaceHostSessionAdapter({
      binding,
      workspaceRoot: tmpdir(),
      send: (message) => sent.push(message),
      onAudit: vi.fn(),
      onWarning: (message) => warnings.push(message),
      ...(onMembershipReport ? { onMembershipReport } : {}),
    });
    return { adapter, sent, warnings };
  }
  const frame = (organizationId: string) => ({
    type: 'membership.report',
    organizationId,
    removedEmails: ['gone@example.test'],
  });

  it("hands a report for the binding's organization to the sink, opening no channel", async () => {
    const reports: unknown[] = [];
    const { adapter, sent } = membershipHarness((report) => reports.push(report));
    await adapter.accept(frame('org-1'));
    expect(reports).toEqual([frame('org-1')]);
    expect(sent).toEqual([]);
  });

  it('drops a report naming another organization', async () => {
    const reports: unknown[] = [];
    const { adapter, warnings } = membershipHarness((report) => reports.push(report));
    await adapter.accept(frame('org-2'));
    await adapter.accept({ type: 'membership.report', removedEmails: [] });
    expect(reports).toEqual([]);
    expect(warnings).toEqual([
      'dropped a membership report for another organization',
      'dropped a membership report for another organization',
    ]);
  });

  it('survives a sink that throws, and ignores the frame without a sink', async () => {
    const throwing = membershipHarness(() => { throw new Error('store down'); });
    await expect(throwing.adapter.accept(frame('org-1'))).resolves.toBeUndefined();
    expect(throwing.warnings).toEqual(['membership_report_failed']);
    const none = membershipHarness();
    await expect(none.adapter.accept(frame('org-1'))).resolves.toBeUndefined();
    expect(none.warnings).toEqual([]);
  });
});

describe("hosted 'psu' terminal (D-002)", () => {
  function psuHarness(root: string) {
    const sent: HostedHostOutboundEnvelope[] = [];
    const inputs: HostedHostPtyFactoryInput[] = [];
    const ptys: FakePty[] = [];
    const audit = vi.fn();
    const adapter = new HostedWorkspaceHostSessionAdapter({
      binding,
      workspaceRoot: root,
      send: (message) => sent.push(message),
      onAudit: audit,
      createPty: (input) => {
        inputs.push(input);
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    });
    const open = (channelId: string, extra: Record<string, unknown> = {}) =>
      adapter.accept({
        type: 'relay.open',
        channelId,
        userId: 'user-1',
        hostedSessionId: 'cli.token-1.psu',
        audience: 'workspace-operator',
        role: 'controller',
        ...extra,
      });
    return { adapter, sent, inputs, ptys, audit, open };
  }

  it('starts psu with the checked argv and says so on pty.ready', async () => {
    const { sent, inputs, open } = psuHarness(await projectRoot());
    await open('psu-1', { kind: 'psu', argv: ['--agent', 'codex', '--model=gpt-5:high', '--no-picker'] });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.psu).toEqual({ argv: ['--agent=codex', '--model=gpt-5:high', '--no-picker'] });
    const ready = sentOfType(sent, 'pty.ready')[0]!.payload as { program?: string };
    expect(ready.program).toBe('psu');
  });

  it('refuses the open, and starts nothing, when one argument is outside the allowlist', async () => {
    const { sent, inputs, audit, open } = psuHarness(await projectRoot());
    await open('psu-1', { kind: 'psu', argv: ['--agent=claude', '--launch-context=/var/lib/papercusp/secret'] });
    expect(inputs).toHaveLength(0);
    expect(sent).toEqual([{ type: 'relay.close', channelId: 'psu-1', reason: 'psu_argv_refused' }]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'psu_argv_refused', detail: 'flag_not_allowed:--launch-context' }),
    );
  });

  it('ends the session when psu exits: no shell is started in its place', async () => {
    const { sent, inputs, ptys, open } = psuHarness(await projectRoot());
    await open('psu-1', { kind: 'psu' });
    ptys[0]!.emit('exit', 0, 0);
    expect(inputs).toHaveLength(1);
    expect(sentOfType(sent, 'pty.exit')).toHaveLength(1);
    // A second attach under the same session id starts a NEW psu, never a shell.
    await open('psu-2', { kind: 'psu' });
    expect(inputs).toHaveLength(2);
    expect(inputs[1]!.psu).toEqual({ argv: [] });
  });

  it('never lets a shell attach resume a psu session, or a psu attach resume a shell', async () => {
    const { sent, inputs, open } = psuHarness(await projectRoot());
    await open('psu-1', { kind: 'psu' });
    await open('shell-1');
    expect(inputs).toHaveLength(1);
    expect(sent).toContainEqual({ type: 'relay.close', channelId: 'shell-1', reason: 'session_program_mismatch' });

    const other = psuHarness(await projectRoot());
    await other.open('shell-1');
    await other.open('psu-1', { kind: 'psu' });
    expect(other.inputs).toHaveLength(1);
    expect(other.inputs[0]!.psu).toBeUndefined();
    expect(other.sent).toContainEqual({ type: 'relay.close', channelId: 'psu-1', reason: 'session_program_mismatch' });
  });
});

describe('HostedWorkspaceHostSessionAdapter', () => {
  it('binds one PTY to an exact browser principal/session and resumes it across channels', async () => {
    const root = await projectRoot();
    const { adapter, sent, ptys, open, relay } = harness(root);
    await open('channel-1');
    await relay('channel-1', { type: 'pty.input', data: Buffer.from('hello').toString('base64') });
    await relay('channel-1', { type: 'pty.resize', cols: 90, rows: 24 });
    await relay('channel-1', { type: 'pty.signal', signal: 'SIGINT' });
    ptys[0].output('world');
    await adapter.accept({ type: 'relay.close', channelId: 'channel-1', reason: 'tab_closed' });
    await open('channel-2');

    expect(ptys).toHaveLength(1);
    expect(ptys[0].writes.map((data) => data.toString())).toEqual(['hello']);
    expect(ptys[0].sizes).toEqual([[90, 24]]);
    expect(ptys[0].signals).toEqual(['SIGINT']);
    expect(sent).toContainEqual({
      type: 'relay',
      channelId: 'channel-1',
      payload: { type: 'pty.output', data: Buffer.from('world').toString('base64') },
    });
    expect(sent).toContainEqual({
      type: 'relay',
      channelId: 'channel-2',
      payload: {
        type: 'pty.ready',
        resumed: true,
        role: 'controller',
        program: 'shell',
        limits: {
          maxFileBytes: HOSTED_HOST_MAX_FILE_BYTES,
          maxUploadChunkBytes: HOSTED_HOST_MAX_UPLOAD_CHUNK_BYTES,
        },
      },
    });
    expect(sent).toContainEqual({
      type: 'relay',
      channelId: 'channel-2',
      payload: { type: 'pty.snapshot', data: Buffer.from('restored-screen').toString('base64') },
    });
  });

  it('isolates different users and hosted sessions even on one connector', async () => {
    const root = await projectRoot();
    const { ptys, open } = harness(root);
    await open('one', 'user-1', 'session');
    await open('two', 'user-2', 'session');
    await open('three', 'user-1', 'other-session');
    expect(ptys).toHaveLength(3);
  });

  it('expires a detached PTY while keeping audit free of terminal/file content', async () => {
    vi.useFakeTimers();
    const root = await projectRoot();
    const sent: HostedHostOutboundEnvelope[] = [];
    const pty = new FakePty();
    const audit = vi.fn();
    const adapter = new HostedWorkspaceHostSessionAdapter({
      binding,
      workspaceRoot: root,
      send: (message) => sent.push(message),
      createPty: () => pty,
      idleMs: 100,
      onAudit: audit,
    });
    await adapter.accept({
      type: 'relay.open',
      channelId: 'one',
      userId: 'user',
      hostedSessionId: 'session',
      audience: 'workspace-operator',
      role: 'controller',
    });
    await adapter.accept({
      type: 'relay',
      channelId: 'one',
      payload: { type: 'pty.input', data: Buffer.from('TERMINAL_CANARY').toString('base64') },
    });
    await adapter.accept({ type: 'relay.close', channelId: 'one' });
    vi.advanceTimersByTime(101);
    expect(pty.killed).toBe(true);
    expect(JSON.stringify(audit.mock.calls)).not.toContain('TERMINAL_CANARY');
  });

  it('serves idempotent file reads/writes and rejects a changed replay', async () => {
    const root = await projectRoot();
    const { sent, open, relay } = harness(root);
    await open('one');
    await relay('one', { type: 'file.read', requestId: 'read-1', path: 'src/index.ts' });
    await relay('one', {
      type: 'file.write',
      requestId: 'write-1',
      path: 'src/new.ts',
      encoding: 'utf8',
      data: 'hello\n',
    });
    await relay('one', {
      type: 'file.write',
      requestId: 'write-1',
      path: 'src/new.ts',
      encoding: 'utf8',
      data: 'hello\n',
    });
    await relay('one', {
      type: 'file.write',
      requestId: 'write-1',
      path: 'src/new.ts',
      encoding: 'utf8',
      data: 'changed\n',
    });

    expect(await readFile(join(root, 'src', 'new.ts'), 'utf8')).toBe('hello\n');
    expect(
      sent.filter((message) => message.type === 'relay' && (message.payload as any)?.requestId === 'write-1'),
    ).toHaveLength(3);
    expect(sent).toContainEqual({
      type: 'relay',
      channelId: 'one',
      payload: expect.objectContaining({ type: 'operation.error', code: 'idempotency_conflict' }),
    });
  });

  it('round-trips zero-byte uploads while rejecting a missing payload', async () => {
    const root = await projectRoot();
    const { sent, open, relay } = harness(root);
    await open('one');
    await relay('one', {
      type: 'file.upload',
      requestId: 'upload-empty',
      path: 'src/empty.txt',
      encoding: 'base64',
      data: '',
    });
    await relay('one', {
      type: 'file.upload',
      requestId: 'upload-missing',
      path: 'src/missing.txt',
      encoding: 'base64',
    });

    expect((await readFile(join(root, 'src', 'empty.txt'))).byteLength).toBe(0);
    expect(sent).toContainEqual({
      type: 'relay',
      channelId: 'one',
      payload: expect.objectContaining({
        type: 'file.result',
        requestId: 'upload-empty',
        operation: 'upload',
        bytes: 0,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    });
    expect(sent).toContainEqual({
      type: 'relay',
      channelId: 'one',
      payload: {
        type: 'operation.error',
        requestId: 'upload-missing',
        operation: 'file.upload',
        code: 'invalid_file_data',
      },
    });
  });

  it('assembles a chunked upload into the exact bytes and writes the file only once', async () => {
    const root = await projectRoot();
    const { sent, open, relay } = harness(root);
    await open('one');
    /* Deliberately NOT a multiple of the chunk size: a short FINAL chunk is the
     * case an off-by-one in the assembler truncates without failing. */
    const payload = Buffer.from('chunked-upload-payload-'.repeat(40));
    const chunkBytes = 64;
    const count = Math.ceil(payload.byteLength / chunkBytes);
    const target = join(root, 'src', 'chunked.txt');
    expect(payload.byteLength % chunkBytes).not.toBe(0);

    for (let index = 0; index < count; index += 1) {
      /* Nothing may exist on disk until the LAST chunk lands: a partial file is
       * indistinguishable from a complete one to whatever reads it next. */
      expect(existsSync(target)).toBe(false);
      await relay('one', {
        type: 'file.upload',
        requestId: 'upload-chunked',
        path: 'src/chunked.txt',
        encoding: 'base64',
        data: payload
          .subarray(index * chunkBytes, Math.min((index + 1) * chunkBytes, payload.byteLength))
          .toString('base64'),
        chunk: { uploadId: 'up-1', index, count },
      });
    }

    expect(await readFile(target)).toEqual(payload);
    expect(sent).toContainEqual({
      type: 'relay',
      channelId: 'one',
      payload: expect.objectContaining({
        type: 'file.result',
        requestId: 'upload-chunked',
        operation: 'upload',
        bytes: payload.byteLength,
      }),
    });
    /* One result, and one progress ack per NON-final chunk. The ack count is
     * load-bearing, not cosmetic: it is the client's backpressure signal, and a
     * missing one stalls the upload until its timeout. */
    expect(sentOfType(sent, 'file.result')).toHaveLength(1);
    expect(sentOfType(sent, 'file.progress')).toHaveLength(count - 1);
  });

  it('refuses an out-of-order chunk instead of assembling the wrong bytes', async () => {
    const root = await projectRoot();
    const { sent, open, relay } = harness(root);
    await open('one');
    const chunk = (index: number, body: string) =>
      relay('one', {
        type: 'file.upload',
        requestId: 'upload-gap',
        path: 'src/gap.txt',
        encoding: 'base64',
        data: Buffer.from(body).toString('base64'),
        chunk: { uploadId: 'up-gap', index, count: 3 },
      });
    await chunk(0, 'aaa');
    await chunk(2, 'ccc');

    expect(sent).toContainEqual({
      type: 'relay',
      channelId: 'one',
      payload: {
        type: 'operation.error',
        requestId: 'upload-gap',
        operation: 'file.upload',
        code: 'invalid_chunk_sequence',
      },
    });
    expect(existsSync(join(root, 'src', 'gap.txt'))).toBe(false);
  });

  it('refuses a malformed chunk descriptor rather than writing one chunk as the whole file', async () => {
    const root = await projectRoot();
    const { sent, open, relay } = harness(root);
    await open('one');
    await relay('one', {
      type: 'file.upload',
      requestId: 'upload-bad',
      path: 'src/bad.txt',
      encoding: 'base64',
      data: Buffer.from('first-chunk-only').toString('base64'),
      // `count` missing: a descriptor that cannot be understood.
      chunk: { uploadId: 'up-bad', index: 0 },
    });

    expect(sent).toContainEqual({
      type: 'relay',
      channelId: 'one',
      payload: {
        type: 'operation.error',
        requestId: 'upload-bad',
        operation: 'file.upload',
        code: 'invalid_chunk',
      },
    });
    /* The crux of this test. Reading a malformed descriptor as an ABSENT one
     * would take the whole-file path and persist this single chunk as the
     * complete file — succeeding loudly while truncating silently. */
    expect(existsSync(join(root, 'src', 'bad.txt'))).toBe(false);
  });

  it('refuses a chunk sequence that exceeds the file cap as it accumulates', async () => {
    const root = await projectRoot();
    const { sent, open, relay } = harness(root, new SafeRootFileService(root, 96));
    await open('one');
    const chunk = (index: number) =>
      relay('one', {
        type: 'file.upload',
        requestId: 'upload-big',
        path: 'src/big.txt',
        encoding: 'base64',
        data: Buffer.alloc(64, 0x61).toString('base64'),
        chunk: { uploadId: 'up-big', index, count: 4 },
      });
    await chunk(0);
    await chunk(1);

    expect(sent).toContainEqual({
      type: 'relay',
      channelId: 'one',
      payload: {
        type: 'operation.error',
        requestId: 'upload-big',
        operation: 'file.upload',
        code: 'file_too_large',
      },
    });
    expect(existsSync(join(root, 'src', 'big.txt'))).toBe(false);
  });

  it('advertises upload limits on pty.ready so a client knows chunking is understood', async () => {
    const root = await projectRoot();
    const { sent, open } = harness(root);
    await open('one');
    const ready = sentOfType(sent, 'pty.ready')[0];
    expect(ready?.payload).toMatchObject({
      limits: {
        maxFileBytes: HOSTED_HOST_MAX_FILE_BYTES,
        maxUploadChunkBytes: HOSTED_HOST_MAX_UPLOAD_CHUNK_BYTES,
      },
    });
    /* Chunk size must stay under the RELAY's envelope cap once base64 inflates
     * it, or the frame this advertisement invites the client to send is exactly
     * the one the relay kills the session for. */
    expect(Math.ceil((HOSTED_HOST_MAX_UPLOAD_CHUNK_BYTES * 4) / 3)).toBeLessThan(
      HOSTED_WORKSPACE_MAX_MESSAGE_BYTES,
    );
  });
});

describe('SafeRootFileService', () => {
  it('denies traversal, secret files, and symlinks that escape the selected root', async () => {
    const root = await projectRoot();
    const outside = await mkdtemp(join(tmpdir(), 'hosted-session-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'secret.txt'), 'outside');
    await symlink(join(outside, 'secret.txt'), join(root, 'src', 'escape'));
    await writeFile(join(root, '.env'), 'SECRET=canary');
    const files = new SafeRootFileService(root);

    await expect(files.read('../outside')).rejects.toMatchObject({ code: 'path_escape' });
    await expect(files.read('.env')).rejects.toMatchObject({ code: 'secret_path_denied' });
    await expect(files.read('src/escape')).rejects.toMatchObject({ code: 'symlink_denied' });
    await expect(files.write('src/escape', Buffer.from('overwrite'))).rejects.toMatchObject({ code: 'symlink_denied' });
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside');
  });

  it('filters secret and symlink entries from directory listings', async () => {
    const root = await projectRoot();
    await writeFile(join(root, 'src', '.env.local'), 'secret');
    await symlink(join(root, 'src', 'index.ts'), join(root, 'src', 'alias.ts'));
    const files = new SafeRootFileService(root);
    await expect(files.list('src')).resolves.toEqual([{ name: 'index.ts', kind: 'file', bytes: 24 }]);
  });
});

/**
 * P-013 tranche 2 — the desktop channel on the hosted relay (D-023).
 *
 * These pin the SEAM, not KasmVNC: the backend is a fake, so what is under test
 * is which credential gets dialled, what is refused, what is audited, and what
 * holds the desktop awake. The pure decisions they rest on (role→credential,
 * loopback assertion, heartbeat cadence) are pinned in hosted-desktop-channel.test.ts.
 */
class FakeDesktopSocket implements HostedDesktopSocket {
  sent: Buffer[] = [];
  closed = false;
  private readonly bus = new EventEmitter();
  send(data: Buffer) {
    this.sent.push(data);
    return !this.closed;
  }
  close() {
    this.closed = true;
  }
  onData(listener: (data: Buffer) => void) {
    this.bus.on('data', listener);
    return () => this.bus.off('data', listener);
  }
  onClose(listener: (reason: string) => void) {
    this.bus.on('close', listener);
    return () => this.bus.off('close', listener);
  }
  emitData(value: Buffer) {
    this.bus.emit('data', value);
  }
  emitClose(reason: string) {
    this.bus.emit('close', reason);
  }
}

const desktopCredentials = {
  view: { user: 'pc-view', secret: 'view-secret' },
  control: { user: 'pc-control', secret: 'control-secret' },
};

function desktopHarness(
  overrides: {
    endpoint?: { host: string; port: number } | null;
    dialError?: Error;
    roster?: Array<{ desktopSessionId: string; state: string }>;
    rosterError?: Error;
    thumbnail?: Buffer | null;
    started?: { desktopSessionId: string; state: string } | null;
    startError?: Error;
  } = {},
) {
  const sent: HostedHostOutboundEnvelope[] = [];
  const audit = vi.fn();
  const warnings = vi.fn();
  const sockets: FakeDesktopSocket[] = [];
  const dials: HostedDesktopDialInput[] = [];
  const beats: string[] = [];
  let starts = 0;
  const backend: HostedDesktopBackend = {
    lookup: async (desktopSessionId) =>
      desktopSessionId === 'missing-desktop'
        ? null
        : {
            endpoint: overrides.endpoint === undefined ? { host: '127.0.0.1', port: 6901 } : overrides.endpoint,
            credentials: desktopCredentials,
          },
    dial: async (input) => {
      dials.push(input);
      if (overrides.dialError) throw overrides.dialError;
      const socket = new FakeDesktopSocket();
      sockets.push(socket);
      return socket;
    },
    heartbeat: (desktopSessionId) => beats.push(desktopSessionId),
    roster: async () => {
      if (overrides.rosterError) throw overrides.rosterError;
      return overrides.roster ?? [{ desktopSessionId: 'desktop-1', state: 'ready' }];
    },
    thumbnail: async () => (overrides.thumbnail === undefined ? Buffer.from('jpeg-bytes') : overrides.thumbnail),
    start: async () => {
      starts += 1;
      if (overrides.startError) throw overrides.startError;
      return overrides.started === undefined ? { desktopSessionId: 'desktop-1', state: 'ready' } : overrides.started;
    },
  };
  const adapter = new HostedWorkspaceHostSessionAdapter({
    binding,
    workspaceRoot: '/nonexistent-desktop-root',
    send: (message) => sent.push(message),
    onAudit: audit,
    onWarning: warnings,
    createPty: () => new FakePty(),
    desktop: backend,
  });
  // `null` means OMIT the field. Passing `undefined` would silently re-trigger the
  // default parameter, which is exactly how the missing-id case can look like it
  // passes while actually testing the happy path.
  const openDesktop = (
    channelId: string,
    role: 'controller' | 'observer' = 'observer',
    desktopSessionId: string | null = 'desktop-1',
  ) =>
    adapter.accept({
      type: 'relay.open',
      channelId,
      userId: 'user-1',
      hostedSessionId: 'session-1',
      audience: 'workspace-operator',
      role,
      kind: 'desktop',
      ...(desktopSessionId === null ? {} : { desktopSessionId }),
    });
  const relay = (channelId: string, payload: unknown) => adapter.accept({ type: 'relay', channelId, payload });
  const payloads = (channelId: string) =>
    sent
      .filter((message) => message.type === 'relay' && message.channelId === channelId)
      .map((message) => (message as { payload: unknown }).payload);
  const auditActions = () => audit.mock.calls.map((call) => (call[0] as { action: string }).action);
  const openTerminal = (channelId: string, role: 'controller' | 'observer') =>
    adapter.accept({
      type: 'relay.open',
      channelId,
      userId: 'user-1',
      hostedSessionId: 'session-1',
      audience: 'workspace-operator',
      role,
    });
  const startCount = () => starts;
  return { adapter, sent, audit, warnings, auditActions, sockets, dials, beats, openDesktop, openTerminal, relay, payloads, startCount };
}

describe('HostedWorkspaceHostSessionAdapter — desktop channels (P-013)', () => {
  it('dials the view-only credential for a watcher and the control credential for a takeover', async () => {
    const { openDesktop, dials, payloads, auditActions } = desktopHarness();
    await openDesktop('watch-1', 'observer');
    await openDesktop('take-1', 'controller');

    expect(dials).toHaveLength(2);
    expect(dials[0].grant).toMatchObject({ action: 'watch', user: 'pc-view', inputAllowed: false });
    expect(dials[1].grant).toMatchObject({ action: 'takeover', user: 'pc-control', inputAllowed: true });
    // The whole privilege boundary: a watcher's dial never carries the control secret.
    expect(JSON.stringify(dials[0].grant)).not.toContain('control-secret');
    expect(payloads('watch-1')).toContainEqual({ type: 'desktop.ready', action: 'watch', inputAllowed: false });
    expect(payloads('take-1')).toContainEqual({ type: 'desktop.ready', action: 'takeover', inputAllowed: true });
    expect(auditActions()).toEqual(['desktop_watch_started', 'desktop_takeover_started']);
  });

  it('pumps bytes both ways and chunks a large sandbox update', async () => {
    const { openDesktop, relay, sockets, payloads } = desktopHarness();
    await openDesktop('channel-1', 'controller');
    await relay('channel-1', { type: 'desktop.data', data: Buffer.from('rfb-input').toString('base64') });
    sockets[0].emitData(Buffer.alloc(100 * 1024, 7));

    expect(sockets[0].sent.map((buffer) => buffer.toString())).toEqual(['rfb-input']);
    const frames = payloads('channel-1').filter(
      (payload): payload is { type: string; data: string } =>
        typeof payload === 'object' && payload !== null && (payload as { type?: unknown }).type === 'desktop.data',
    );
    // 100 KiB over a 48 KiB chunk = 3 frames, and they must reassemble byte-exactly.
    expect(frames).toHaveLength(3);
    expect(Buffer.concat(frames.map((frame) => Buffer.from(frame.data, 'base64')))).toEqual(
      Buffer.alloc(100 * 1024, 7),
    );
  });

  it('refuses a non-loopback endpoint without dialling it', async () => {
    const { openDesktop, dials, sent, auditActions } = desktopHarness({ endpoint: { host: '10.0.0.5', port: 6901 } });
    await openDesktop('channel-1');

    expect(dials).toHaveLength(0);
    expect(sent).toContainEqual({ type: 'relay.close', channelId: 'channel-1', reason: 'endpoint_not_loopback' });
    expect(auditActions()).toContain('desktop_denied');
  });

  it('refuses an endpoint-less session, an unknown session, and a missing desktopSessionId', async () => {
    const absent = desktopHarness({ endpoint: null });
    await absent.openDesktop('channel-1');
    expect(absent.sent).toContainEqual({ type: 'relay.close', channelId: 'channel-1', reason: 'endpoint_absent' });

    const unknown = desktopHarness();
    await unknown.openDesktop('channel-2', 'observer', 'missing-desktop');
    expect(unknown.sent).toContainEqual({
      type: 'relay.close',
      channelId: 'channel-2',
      reason: 'desktop_session_unknown',
    });

    const bare = desktopHarness();
    await bare.openDesktop('channel-3', 'observer', null);
    expect(bare.sent).toContainEqual({
      type: 'relay.close',
      channelId: 'channel-3',
      reason: 'desktop_session_required',
    });
    expect(bare.dials).toHaveLength(0);
  });

  it('refuses a desktop open on a host with no desktop backend installed', async () => {
    const sent: HostedHostOutboundEnvelope[] = [];
    const adapter = new HostedWorkspaceHostSessionAdapter({
      binding,
      workspaceRoot: '/nonexistent-desktop-root',
      send: (message) => sent.push(message),
      createPty: () => new FakePty(),
    });
    await adapter.accept({
      type: 'relay.open',
      channelId: 'channel-1',
      userId: 'user-1',
      hostedSessionId: 'session-1',
      audience: 'workspace-operator',
      role: 'observer',
      kind: 'desktop',
      desktopSessionId: 'desktop-1',
    });
    expect(sent).toEqual([{ type: 'relay.close', channelId: 'channel-1', reason: 'desktop_unsupported' }]);
  });

  it('keeps an absent kind opening a PTY and rejects an unrecognised one outright', async () => {
    const root = await projectRoot();
    const { adapter, ptys, sent } = harness(root);
    // The wire contract: a control plane predating `kind` still opens terminals.
    await adapter.accept({
      type: 'relay.open',
      channelId: 'legacy-1',
      userId: 'user-1',
      hostedSessionId: 'session-1',
      audience: 'workspace-operator',
      role: 'controller',
    });
    expect(ptys).toHaveLength(1);

    await adapter.accept({
      type: 'relay.open',
      channelId: 'future-1',
      userId: 'user-1',
      hostedSessionId: 'session-1',
      audience: 'workspace-operator',
      role: 'controller',
      kind: 'hologram',
    });
    // Rejected, not defaulted into a terminal — and SAID so, so a client asking for a kind this
    // host lacks can fall back instead of waiting (D-002 P-009).
    expect(ptys).toHaveLength(1);
    expect(sent.filter((message) => message.channelId === 'future-1')).toEqual([
      { type: 'relay.close', channelId: 'future-1', reason: 'channel_kind_unknown' },
    ]);
  });

  it('rejects a non-desktop operation on a desktop channel without killing the channel', async () => {
    const { openDesktop, relay, sockets, payloads } = desktopHarness();
    await openDesktop('channel-1', 'controller');
    await relay('channel-1', { type: 'pty.input', data: Buffer.from('x').toString('base64') });

    expect(payloads('channel-1')).toContainEqual({
      type: 'operation.error',
      operation: 'pty.input',
      code: 'invalid_desktop_operation',
    });
    expect(sockets[0].sent).toHaveLength(0);
    expect(sockets[0].closed).toBe(false);
  });

  it('tears the channel down when the sandbox socket closes, and tells the control plane', async () => {
    const { openDesktop, relay, sockets, sent, auditActions } = desktopHarness();
    await openDesktop('channel-1', 'controller');
    sockets[0].emitClose('sandbox_gone');

    expect(sent).toContainEqual({ type: 'relay.close', channelId: 'channel-1', reason: 'sandbox_gone' });
    expect(auditActions()).toContain('desktop_detached');
    // The channel is gone: a later write reaches no socket.
    await relay('channel-1', { type: 'desktop.data', data: Buffer.from('late').toString('base64') });
    expect(sockets[0].sent).toHaveLength(0);
  });

  it('closes the socket without echoing when the control plane initiates the close', async () => {
    const { adapter, openDesktop, sockets, sent } = desktopHarness();
    await openDesktop('channel-1', 'controller');
    const before = sent.length;
    await adapter.accept({ type: 'relay.close', channelId: 'channel-1', reason: 'tab_closed' });

    expect(sockets[0].closed).toBe(true);
    // No relay.close echoed back for a close the control plane asked for.
    expect(sent.slice(before).filter((message) => message.type === 'relay.close')).toEqual([]);
  });

  it('heartbeats the desktop while a viewer is attached, once per desktop, and stops on the last detach', async () => {
    vi.useFakeTimers();
    const { adapter, openDesktop, beats } = desktopHarness();
    // Two tabs on ONE desktop must produce ONE beat per tick, not two.
    await openDesktop('watch-1', 'observer');
    await openDesktop('take-1', 'controller');
    await vi.advanceTimersByTimeAsync(desktopViewerHeartbeatMs() * 2);
    expect(beats).toEqual(['desktop-1', 'desktop-1']);

    await adapter.accept({ type: 'relay.close', channelId: 'watch-1', reason: 'tab_closed' });
    await vi.advanceTimersByTimeAsync(desktopViewerHeartbeatMs());
    // Still one viewer attached: the desktop stays held.
    expect(beats).toHaveLength(3);

    await adapter.accept({ type: 'relay.close', channelId: 'take-1', reason: 'tab_closed' });
    await vi.advanceTimersByTimeAsync(desktopViewerHeartbeatMs() * 3);
    // Last viewer gone: no further beats, so the idle reaper may do its job.
    expect(beats).toHaveLength(3);
  });

  it('does not heartbeat a desktop whose dial failed', async () => {
    vi.useFakeTimers();
    const { openDesktop, beats } = desktopHarness({ dialError: new Error('connect ECONNREFUSED') });
    await openDesktop('channel-1', 'controller');
    await vi.advanceTimersByTimeAsync(desktopViewerHeartbeatMs() * 3);
    expect(beats).toEqual([]);
  });

  it('closes every desktop socket when the connector goes down', async () => {
    const { adapter, openDesktop, sockets } = desktopHarness();
    await openDesktop('channel-1', 'observer');
    await openDesktop('channel-2', 'controller');
    adapter.close('connector_closed');
    expect(sockets.map((socket) => socket.closed)).toEqual([true, true]);
  });
});

/**
 * P-013 tranche 3 — roster + thumbnails over the relay, NOT over SSH.
 *
 * The local lane pulls the capture loop's JPEGs over the SSH channel (D-003). A
 * hosted workspace host is outbound-only and has no such channel, so the same
 * artifacts must ride the authenticated relay. These pin that they are served,
 * bounded, and audited.
 */
describe('HostedWorkspaceHostSessionAdapter — desktop roster and thumbnails (P-013)', () => {
  it('serves the roster on a PTY channel, so a viewer can discover a desktop before opening one', async () => {
    const root = await projectRoot();
    const sent: HostedHostOutboundEnvelope[] = [];
    const audit = vi.fn();
    const adapter = new HostedWorkspaceHostSessionAdapter({
      binding,
      workspaceRoot: root,
      send: (message) => sent.push(message),
      onAudit: audit,
      createPty: () => new FakePty(),
      desktop: {
        lookup: async () => null,
        dial: async () => {
          throw new Error('not dialled in this test');
        },
        heartbeat: () => {},
        roster: async () => [
          { desktopSessionId: 'desktop-1', state: 'ready', displayNumber: 99 },
          { desktopSessionId: 'desktop-2', state: 'frozen' },
        ],
        thumbnail: async () => null,
        start: async () => null,
      },
    });
    await adapter.accept({
      type: 'relay.open',
      channelId: 'term-1',
      userId: 'user-1',
      hostedSessionId: 'session-1',
      audience: 'workspace-operator',
      role: 'controller',
    });
    await adapter.accept({
      type: 'relay',
      channelId: 'term-1',
      payload: { type: 'desktop.roster', requestId: 'req-1' },
    });

    expect(sent).toContainEqual({
      type: 'relay',
      channelId: 'term-1',
      payload: {
        type: 'desktop.roster.result',
        requestId: 'req-1',
        desktops: [
          { desktopSessionId: 'desktop-1', state: 'ready', displayNumber: 99 },
          { desktopSessionId: 'desktop-2', state: 'frozen' },
        ],
      },
    });
    expect(audit.mock.calls.map((call) => (call[0] as { action: string }).action)).toContain('desktop_roster');
  });

  it('serves a thumbnail as bytes over the relay and audits the screen access', async () => {
    const { openDesktop, relay, payloads, auditActions } = desktopHarness({ thumbnail: Buffer.from('jpeg-bytes') });
    await openDesktop('channel-1', 'observer');
    await relay('channel-1', { type: 'desktop.thumbnail', requestId: 'req-1', desktopSessionId: 'desktop-1' });

    expect(payloads('channel-1')).toContainEqual({
      type: 'desktop.thumbnail.result',
      requestId: 'req-1',
      desktopSessionId: 'desktop-1',
      data: Buffer.from('jpeg-bytes').toString('base64'),
      bytes: 10,
    });
    // A picture of somebody's screen leaves a record, unlike a stream frame.
    expect(auditActions()).toContain('desktop_thumbnail');
  });

  it('reports a desktop with no fresh capture as an empty result, not an error', async () => {
    const { openDesktop, relay, payloads } = desktopHarness({ thumbnail: null });
    await openDesktop('channel-1', 'observer');
    await relay('channel-1', { type: 'desktop.thumbnail', requestId: 'req-1', desktopSessionId: 'desktop-1' });

    // The capture loop skips a display with no active client on purpose, so the
    // picker must render "no recent frame" rather than a dead one or an error.
    expect(payloads('channel-1')).toContainEqual({
      type: 'desktop.thumbnail.result',
      requestId: 'req-1',
      desktopSessionId: 'desktop-1',
      data: null,
    });
  });

  it('refuses an oversized thumbnail rather than streaming it', async () => {
    const { openDesktop, relay, payloads, auditActions } = desktopHarness({
      thumbnail: Buffer.alloc(600 * 1024, 1),
    });
    await openDesktop('channel-1', 'observer');
    await relay('channel-1', { type: 'desktop.thumbnail', requestId: 'req-1', desktopSessionId: 'desktop-1' });

    expect(payloads('channel-1')).toContainEqual({
      type: 'operation.error',
      requestId: 'req-1',
      operation: 'desktop.thumbnail',
      code: 'thumbnail_too_large',
    });
    expect(auditActions()).toContain('operation_denied');
  });

  it('bounds the roster and requires a requestId and a desktopSessionId', async () => {
    const many = Array.from({ length: 100 }, (_, index) => ({
      desktopSessionId: `desktop-${index}`,
      state: 'ready',
    }));
    const big = desktopHarness({ roster: many });
    await big.openDesktop('channel-1', 'observer');
    await big.relay('channel-1', { type: 'desktop.roster', requestId: 'req-1' });
    const result = big
      .payloads('channel-1')
      .find(
        (payload): payload is { desktops: unknown[] } =>
          typeof payload === 'object' &&
          payload !== null &&
          (payload as { type?: unknown }).type === 'desktop.roster.result',
      );
    expect(result?.desktops).toHaveLength(64);

    const bare = desktopHarness();
    await bare.openDesktop('channel-2', 'observer');
    await bare.relay('channel-2', { type: 'desktop.roster' });
    expect(bare.payloads('channel-2')).toContainEqual({
      type: 'operation.error',
      operation: 'desktop.roster',
      code: 'request_id_required',
    });
    await bare.relay('channel-2', { type: 'desktop.thumbnail', requestId: 'req-9' });
    expect(bare.payloads('channel-2')).toContainEqual({
      type: 'operation.error',
      requestId: 'req-9',
      operation: 'desktop.thumbnail',
      code: 'desktop_session_required',
    });
  });

  it('turns a backend failure into a typed error instead of a dropped request', async () => {
    const { openDesktop, relay, payloads, warnings } = desktopHarness({ rosterError: new Error('registry unavailable') });
    await openDesktop('channel-1', 'observer');
    await relay('channel-1', { type: 'desktop.roster', requestId: 'req-1' });

    expect(payloads('channel-1')).toContainEqual({
      type: 'operation.error',
      requestId: 'req-1',
      operation: 'desktop.roster',
      code: 'desktop_query_failed',
    });
    // The wire carries only the code; the cause must reach the host journal (D-405).
    expect(warnings).toHaveBeenCalledWith('desktop_query_failed');
  });

  it('starts the workspace desktop for a controller on a terminal channel, before any desktop exists (D-405)', async () => {
    const { openTerminal, relay, payloads, auditActions, startCount } = desktopHarness({
      started: { desktopSessionId: 'desktop-new', state: 'ready' },
    });
    await openTerminal('term-1', 'controller');
    await relay('term-1', { type: 'desktop.start', requestId: 'req-1' });

    expect(startCount()).toBe(1);
    expect(payloads('term-1')).toContainEqual({
      type: 'desktop.start.result',
      requestId: 'req-1',
      desktop: { desktopSessionId: 'desktop-new', state: 'ready' },
    });
    expect(auditActions()).toContain('desktop_started');
  });

  it('refuses desktop.start from an observer without touching the backend — watching never starts a desktop', async () => {
    const terminal = desktopHarness();
    await terminal.openTerminal('term-1', 'observer');
    await terminal.relay('term-1', { type: 'desktop.start', requestId: 'req-1' });
    expect(terminal.payloads('term-1')).toContainEqual({
      type: 'operation.error',
      requestId: 'req-1',
      operation: 'desktop.start',
      code: 'controller_required',
    });

    const watcher = desktopHarness();
    await watcher.openDesktop('channel-1', 'observer');
    await watcher.relay('channel-1', { type: 'desktop.start', requestId: 'req-2' });
    expect(watcher.payloads('channel-1')).toContainEqual({
      type: 'operation.error',
      requestId: 'req-2',
      operation: 'desktop.start',
      code: 'controller_required',
    });

    expect(terminal.startCount() + watcher.startCount()).toBe(0);
    expect(terminal.auditActions()).toContain('operation_denied');
  });

  it('reports a started desktop the host cannot serve, a failed start, and a missing request id as typed errors', async () => {
    const unservable = desktopHarness({ started: null });
    await unservable.openTerminal('term-1', 'controller');
    await unservable.relay('term-1', { type: 'desktop.start', requestId: 'req-1' });
    expect(unservable.payloads('term-1')).toContainEqual({
      type: 'operation.error',
      requestId: 'req-1',
      operation: 'desktop.start',
      code: 'desktop_unavailable',
    });

    const failing = desktopHarness({ startError: new Error('desktop pack socket refused') });
    await failing.openTerminal('term-1', 'controller');
    await failing.relay('term-1', { type: 'desktop.start', requestId: 'req-1' });
    expect(failing.payloads('term-1')).toContainEqual({
      type: 'operation.error',
      requestId: 'req-1',
      operation: 'desktop.start',
      code: 'desktop_start_failed',
    });
    expect(failing.warnings).toHaveBeenCalledWith('desktop_start_failed');
    expect(JSON.stringify(failing.payloads('term-1'))).not.toContain('socket refused');

    const bare = desktopHarness();
    await bare.openTerminal('term-1', 'controller');
    await bare.relay('term-1', { type: 'desktop.start' });
    expect(bare.payloads('term-1')).toContainEqual({
      type: 'operation.error',
      operation: 'desktop.start',
      code: 'request_id_required',
    });
    expect(bare.startCount()).toBe(0);
  });

  it('reports desktop_unsupported on a host with no desktop backend', async () => {
    const root = await projectRoot();
    const { adapter, sent, open } = harness(root);
    await open('term-1');
    await adapter.accept({
      type: 'relay',
      channelId: 'term-1',
      payload: { type: 'desktop.roster', requestId: 'req-1' },
    });
    expect(sent).toContainEqual({
      type: 'relay',
      channelId: 'term-1',
      payload: { type: 'operation.error', requestId: 'req-1', operation: 'desktop.roster', code: 'desktop_unsupported' },
    });
    await adapter.accept({
      type: 'relay',
      channelId: 'term-1',
      payload: { type: 'desktop.start', requestId: 'req-2' },
    });
    expect(sent).toContainEqual({
      type: 'relay',
      channelId: 'term-1',
      payload: { type: 'operation.error', requestId: 'req-2', operation: 'desktop.start', code: 'desktop_unsupported' },
    });
  });
});

describe('hosted lane teardown window vs the governor hold (P-014)', () => {
  it('gives up a dead session inside the ceiling the viewer hold is derived from', () => {
    // `VIEWER_HOLD_SEC` is computed as this ceiling plus a margin, on the premise
    // that every lane clears its binding within it. That premise is only true if
    // each lane pins its own window — otherwise lengthening this constant would
    // shorten the hold RELATIVE to the lane by exactly the amount added, and the
    // governor would start freezing desktops this adapter had not yet released.
    // Nothing else in the tree connects these two numbers.
    expect(HOSTED_HOST_SESSION_IDLE_MS / 1000).toBeLessThanOrEqual(VIEWER_STREAM_TEARDOWN_CEILING_SEC);
  });
});

// android-public-release-2026-10-01 D-013 #6: a phone's device-http channel is Noise-sealed
// end to end; the handshake key names the device, and only that device's JWT is forwarded.
describe('sealed device-http channel (D-013 #6)', () => {
  const jwtFor = (sub: string) =>
    `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.c2ln`;
  const hostKey = SecretStream.keyPair(Buffer.alloc(32, 31));
  const phoneKey = SecretStream.keyPair(Buffer.alloc(32, 41));

  async function settle(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !predicate(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  function sealedDeviceHarness(resolveDeviceNoiseKey?: (key: string) => Promise<string | null>) {
    const sent: HostedHostOutboundEnvelope[] = [];
    const forwarded: Array<Record<string, string>> = [];
    const clientErrors: Error[] = [];
    const frames: Array<Record<string, unknown>> = [];
    const audit = vi.fn();
    let phone!: ByocSealedChannel;
    const adapter = new HostedWorkspaceHostSessionAdapter({
      binding,
      workspaceRoot: '/nonexistent',
      onAudit: audit,
      send: (message) => {
        sent.push(message);
        if (message.type === 'relay' && message.channelId === 'dev-ch') {
          // One relay message per event, as a websocket relay delivers them. A same-tick burst
          // trips ByocSealedChannel's single-slot content-type check (filed separately).
          setImmediate(() => phone.receive(message.payload as never));
        }
      },
      createPty: () => new FakePty(),
      operatorHttp: {
        origin: 'http://127.0.0.1:1',
        fetch: async (_url, init) => {
          forwarded.push({ ...(init.headers as Record<string, string>) });
          return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
        },
      },
      byocSealedChannel: {
        localKeyPair: hostKey,
        ...(resolveDeviceNoiseKey ? { resolveDeviceNoiseKey } : {}),
      },
    });
    phone = new ByocSealedChannel({
      initiator: true,
      localKeyPair: phoneKey,
      expectedRemotePublicKey: hostKey.publicKey,
      sendPacket: (packet) => { void adapter.accept({ type: 'relay', channelId: 'dev-ch', payload: packet }); },
      onFrame: (frame) => { frames.push(frame as Record<string, unknown>); },
      onError: (error) => clientErrors.push(error),
    });
    const open = () => adapter.accept({ type: 'relay.open', channelId: 'dev-ch', kind: 'device-http', audience: 'device', sealed: true });
    const request = async (requestId: string, token: string) => {
      const before = forwarded.length;
      await phone.send({ type: 'http.request', requestId, method: 'GET', path: '/api/device/runtime-config', headers: { authorization: `Bearer ${token}` } });
      await settle(() => forwarded.length > before);
      return forwarded[before];
    };
    return { adapter, sent, forwarded, frames, audit, clientErrors, phone, open, request };
  }

  it("forwards the JWT of the device the handshake key resolves to, and drops another device's", async () => {
    const resolve = vi.fn(async (key: string) => (key === phoneKey.publicKey.toString('base64') ? 'dev-a' : null));
    const h = sealedDeviceHarness(resolve);
    await h.open();
    await h.phone.opened;
    expect(resolve).toHaveBeenCalledWith(phoneKey.publicKey.toString('base64'));
    expect((await h.request('r1', jwtFor('dev-a')))?.authorization).toBe(`Bearer ${jwtFor('dev-a')}`);
    const other = await h.request('r2', jwtFor('dev-b'));
    expect(other).toBeDefined();
    expect(other.authorization).toBeUndefined();
    // Content never crosses the relay in the clear.
    expect(JSON.stringify(h.sent)).not.toContain(jwtFor('dev-a'));
  });

  it('admits an unregistered phone key unbound: the call still reaches the machine, with no JWT', async () => {
    const h = sealedDeviceHarness(async () => null);
    await h.open();
    await h.phone.opened;
    const headers = await h.request('r1', jwtFor('dev-a'));
    expect(headers).toBeDefined();
    expect(headers.authorization).toBeUndefined();
  });

  it('a pair redeemed over the sealed channel registers the handshake key, and a different body key is refused', async () => {
    const h = sealedDeviceHarness(async () => null);
    const frames = h.frames;
    await h.open();
    await h.phone.opened;
    const pair = (requestId: string, body: Record<string, unknown>) =>
      h.phone.send({ type: 'http.request', requestId, method: 'POST', path: '/api/device/pair', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)).toString('base64') });
    const other = Buffer.alloc(32, 5).toString('base64');
    await pair('p1', { pairToken: 'tok', noisePublicKey: other });
    await settle(() => frames.some((f) => f.requestId === 'p1'));
    expect(frames.find((f) => f.requestId === 'p1')).toMatchObject({ type: 'http.error', code: 'noise_key_mismatch', status: 403 });
    expect(h.forwarded).toEqual([]);
    await pair('p2', { pairToken: 'tok' });
    await settle(() => h.forwarded.length > 0);
    expect(h.forwarded).toHaveLength(1);
  });

  it('refuses a sealed device channel when the host has no device-key resolver', async () => {
    const h = sealedDeviceHarness();
    await h.open();
    expect(h.sent).toContainEqual({ type: 'relay.close', channelId: 'dev-ch', reason: 'sealed_channel_unavailable' });
  });

  it('refuses the handshake when the resolver fails, and forwards nothing', async () => {
    const h = sealedDeviceHarness(async () => { throw new Error('db down'); });
    await h.open();
    await settle(() => JSON.stringify(h.audit.mock.calls).includes('sealed_channel_failed') || h.clientErrors.length > 0);
    await h.phone.send({ type: 'http.request', requestId: 'r1', method: 'GET', path: '/api/device/runtime-config', headers: {} }).catch(() => {});
    await settle(() => false);
    expect(h.forwarded).toEqual([]);
  });
});
