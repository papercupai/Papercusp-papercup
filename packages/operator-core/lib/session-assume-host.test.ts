import { describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManagedAssumeHost } from './session-assume-host';
import { injectIntoHostWithConfirmation } from './events/await/psu-pty-discovery';
import type { AssumePreparation, AssumeCallerRecovery } from './session-assume';
import type { InjectHostResult, PsuPtyHost } from './events/await/psu-pty-discovery';

function fixture() {
  const caller = { ownerId: 'su-caller', workspaceId: 'fixture', backend: 'codex' as const,
    nativeSessionId: 'caller-native', nativePid: 123, incarnation: 'start', hostId: 'host', attachmentId: 'surface' };
  const now = Date.now();
  const plan: AssumePreparation = { version: 1, requestId: 'fixture', authorizationRef: 'admin', preparedAt: now,
    expiresAt: now + 120_000, caller, target: { ownerId: 'su-target', workspaceId: caller.workspaceId,
      harnessSlug: 'fixture', advSessionId: 42, role: 'su', nativeSessionId: 'target-native',
      executionNativeSessionId: 'target-native', backend: 'codex',
      binding: { coordOwnerId: 'su-target', sessionId: 'target-native', startedAt: 'target-start' },
      writerGeneration: 'free', writer: 'free', ended: true, liveHost: false,
      context: { mode: 'native-resume', ref: 'target-native', sha256: 'a'.repeat(64), revision: 'fixture' } } };
  const recovery: AssumeCallerRecovery = { checkpointRef: 'carry-note:caller', checkpointSha256: 'b'.repeat(64),
    returnRef: { ownerId: caller.ownerId, workspaceId: caller.workspaceId, nativeSessionId: caller.nativeSessionId,
      incarnation: caller.incarnation } };
  const host = { ownerId: caller.ownerId, nativeSessionId: caller.nativeSessionId, ptyPid: caller.nativePid,
    childGeneration: 2, sock: '/fixture.sock', identityAssume: { version: 1, hostId: caller.hostId, attachmentId: caller.attachmentId } };
  const ports = { findHost: vi.fn(async () => host as unknown as PsuPtyHost | null),
    send: vi.fn(async () => ({ ok: true, confirmation: 'acked' } as InjectHostResult)) };
  return { plan, recovery, host, ports, adapter: createManagedAssumeHost(plan, ports) };
}

describe('managed assume server host adapter', () => {
  it('forwards the exact action and request over a real Unix socket and requires its ACK', async () => {
    const f = fixture();
    const dir = await mkdtemp(join(tmpdir(), 'assume-socket-'));
    f.host.sock = join(dir, f.plan.caller.ownerId + '.sock');
    const messages: Array<Record<string, any>> = [];
    const server = net.createServer({ allowHalfOpen: true }, conn => {
      let bytes = '';
      conn.on('data', data => { bytes += data.toString(); });
      conn.on('end', () => {
        messages.push(JSON.parse(bytes));
        conn.end(JSON.stringify({ v: 1, ok: true, phase: 'queued' }) + '\n');
      });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(f.host.sock, resolve); });
    try {
      const adapter = createManagedAssumeHost(f.plan, { findHost: f.ports.findHost, send: injectIntoHostWithConfirmation });
      expect(await adapter.freeze(f.plan, f.recovery)).toBe(true);
      expect(await adapter.handoff(f.plan, f.recovery)).toBe('accepted');
      expect(await adapter.thaw(f.plan, f.recovery)).toBe(true);
      expect(messages.map(message => message.action)).toEqual(['freeze', 'queue', 'thaw']);
      expect(messages[0]).toMatchObject({ v: 1, mode: 'identity-assume', ownerId: f.plan.caller.ownerId,
        request: { recoveryRef: f.recovery.checkpointRef, recoveryHash: f.recovery.checkpointSha256,
          caller: { nativePid: f.plan.caller.nativePid, childGeneration: f.host.childGeneration } } });
      expect(messages[1].request).toEqual(messages[0].request);
      expect(messages[2].request).toEqual(messages[0].request);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('pins the same child and sends only custody references through the existing socket', async () => {
    const f = fixture();
    expect(await f.adapter.freeze(f.plan, f.recovery)).toBe(true);
    expect(await f.adapter.handoff(f.plan, f.recovery)).toBe('accepted');
    expect(await f.adapter.thaw(f.plan, f.recovery)).toBe(true);
    expect(f.ports.send.mock.calls.map(args => (args as unknown as [string, { action: string }])[1].action))
      .toEqual(['freeze', 'queue', 'thaw']);
    const payload = (f.ports.send.mock.calls[0] as unknown as [string, Record<string, any>])[1];
    expect(payload).toMatchObject({ mode: 'identity-assume', ownerId: f.plan.caller.ownerId,
      request: { caller: { childGeneration: 2, nativePid: 123 }, recoveryRef: f.recovery.checkpointRef } });
    expect(JSON.stringify(payload)).not.toContain(f.plan.target.nativeSessionId);
  });

  it.each(['assumed-close', 'timeout', 'error', 'oversize'] as const)(
    'never treats %s as a successful freeze or a definite handoff refusal', async confirmation => {
      const f = fixture(); f.ports.send.mockResolvedValue({ ok: true, confirmation });
      expect(await f.adapter.freeze(f.plan, f.recovery)).toBe(false);
      await expect(f.adapter.handoff(f.plan, f.recovery)).rejects.toThrow('assume-host-ack-unknown');
      expect(await f.adapter.thaw(f.plan, f.recovery)).toBe(false);
    });

  it('distinguishes a confirmed refusal from transport uncertainty', async () => {
    const f = fixture(); f.ports.send.mockResolvedValue({ ok: false, confirmation: 'acked', reason: 'assume-input-busy' });
    expect(await f.adapter.handoff(f.plan, f.recovery)).toBe('refused');
  });

  it.each(['childGeneration', 'nativePid', 'nativeSessionId', 'hostId', 'attachmentId', 'ownerId', 'missing'])(
    'refuses changed %s before queueing replacement', async field => {
      const f = fixture(); expect(await f.adapter.freeze(f.plan, f.recovery)).toBe(true);
      if (field === 'missing') f.ports.findHost.mockResolvedValue(null);
      else if (field === 'nativePid') f.host.ptyPid++;
      else if (field === 'hostId' || field === 'attachmentId') f.host.identityAssume[field] = 'changed';
      else if (field === 'childGeneration') f.host.childGeneration++;
      else Object.assign(f.host, { [field]: 'changed' });
      await expect(f.adapter.handoff(f.plan, f.recovery)).rejects.toThrow('assume-host-caller-changed');
      expect(f.ports.send).toHaveBeenCalledOnce();
    });

  it('refuses changed preparation and recovery while allowing exact expired thaw', async () => {
    const f = fixture(); expect(await f.adapter.freeze(f.plan, f.recovery)).toBe(true);
    await expect(f.adapter.handoff({ ...f.plan, requestId: 'changed' }, f.recovery)).rejects.toThrow('preparation-changed');
    expect(await f.adapter.thaw(f.plan, { ...f.recovery, checkpointSha256: 'c'.repeat(64) })).toBe(false);
    expect(await f.adapter.thaw(f.plan, { ...f.recovery, returnRef: { ...f.recovery.returnRef, incarnation: 'new' } })).toBe(false);
    // Expiry is governed by the host's thaw path, not a fresh grant from here.
    const past = { ...f.plan, expiresAt: Date.now() - 1 };
    const exact = createManagedAssumeHost(past, f.ports);
    expect(await exact.thaw(past, f.recovery)).toBe(true);
  });
});
