import { describe, expect, it } from 'vitest';
import SecretStream from '@hyperswarm/secret-stream';
import {
  HostedWorkspaceConnectorGateway,
  type HostedConnectorBinding,
  type HostedConnectorLivenessBinding,
  type HostedConnectorTicketBinding,
  type HostedConnectorTicketKind,
  type HostedConnectorTransport,
  type HostedWorkspaceConnectorStore,
} from '../endpoint-route/hosted-workspace-connector';
import { ByocSealedChannel, type ByocSealedPacket } from './byoc-sealed-channel';

class MemoryConnectorStore implements HostedWorkspaceConnectorStore {
  binding: HostedConnectorBinding | null = null;
  credentialHash: string | null = null;
  tickets = new Map<string, HostedConnectorTicketBinding>();

  createEnrollment(input: Omit<HostedConnectorBinding, 'generation' | 'state'> & { ticketHash: string; expiresAt: Date }) {
    this.binding = { ...input, generation: (this.binding?.generation ?? 0) + 1, state: 'pending' };
    this.credentialHash = null;
    this.tickets.set(input.ticketHash, {
      ...this.binding, kind: 'enrollment', audience: 'connector-register', expiresAt: input.expiresAt,
    });
    return Promise.resolve(this.binding);
  }

  register(ticketHash: string, credentialHash: string, now: Date) {
    const ticket = this.take(ticketHash, 'enrollment', now);
    if (!ticket || !this.binding || ticket.generation !== this.binding.generation) return Promise.resolve(null);
    this.credentialHash = credentialHash;
    this.binding = { ...this.binding, state: 'active' };
    return Promise.resolve(this.binding);
  }

  authenticate(credentialHash: string) {
    return Promise.resolve(
      this.binding?.state === 'active' && credentialHash === this.credentialHash ? this.binding : null,
    );
  }

  heartbeat(credentialHash: string, transport: HostedConnectorTransport) {
    return Promise.resolve(
      this.binding?.state === 'active' && credentialHash === this.credentialHash && transport === this.binding.transport
        ? this.binding
        : null,
    );
  }

  recordLiveness(_binding: HostedConnectorLivenessBinding, _alive: boolean, _at: Date) {
    return Promise.resolve(true);
  }

  issueSessionTicket(input: HostedConnectorTicketBinding & { ticketHash: string; issuedAt: Date }) {
    if (this.binding?.state !== 'active') return Promise.resolve(null);
    const ticket = { ...input, ...this.binding, kind: 'session' as const };
    this.tickets.set(input.ticketHash, ticket);
    return Promise.resolve(ticket);
  }

  consumeTicket(ticketHash: string, kind: HostedConnectorTicketKind, now: Date) {
    return Promise.resolve(this.take(ticketHash, kind, now));
  }

  rotate(input: Omit<HostedConnectorBinding, 'generation' | 'state'> & { ticketHash: string; expiresAt: Date }) {
    if (this.binding?.state !== 'active') return Promise.resolve(null);
    this.binding = { ...input, generation: this.binding.generation + 1, state: 'pending' };
    this.credentialHash = null;
    this.tickets.set(input.ticketHash, {
      ...this.binding, kind: 'enrollment', audience: 'connector-register', expiresAt: input.expiresAt,
    });
    return Promise.resolve(this.binding);
  }

  revoke() {
    if (!this.binding) return Promise.resolve(null);
    this.binding = { ...this.binding, state: 'revoked' };
    this.credentialHash = null;
    return Promise.resolve(this.binding);
  }

  private take(ticketHash: string, kind: HostedConnectorTicketKind, now: Date) {
    const ticket = this.tickets.get(ticketHash);
    if (!ticket || ticket.kind !== kind || ticket.expiresAt <= now ||
        ticket.generation !== this.binding?.generation ||
        this.binding.state !== (kind === 'enrollment' ? 'pending' : 'active')) return null;
    this.tickets.delete(ticketHash);
    return ticket;
  }
}

const binding = {
  controlPlaneWorkspaceId: 'control',
  organizationId: 'org-1',
  customerWorkspaceId: 'workspace-1',
  hostId: 'host-1',
  routeLabel: 'alpha',
  transport: 'websocket' as const,
  hosting: 'byoc' as const,
};

function entropy() {
  let byte = 0;
  return (size: number) => new Uint8Array(size).fill(++byte);
}

async function openSealed(
  gateway: HostedWorkspaceConnectorGateway,
  connector: HostedConnectorBinding,
  clientKey: ReturnType<typeof SecretStream.keyPair>,
  hostKey: ReturnType<typeof SecretStream.keyPair>,
  hostExpectedClientKey = clientKey.publicKey,
) {
  const hostFrames: Record<string, unknown>[] = [];
  const closeReasons: string[] = [];
  let client!: ByocSealedChannel;
  let host!: ByocSealedChannel;
  client = new ByocSealedChannel({
    initiator: true,
    localKeyPair: clientKey,
    expectedRemotePublicKey: hostKey.publicKey,
    sendPacket: (packet: ByocSealedPacket) => queueMicrotask(() => host.receive(packet)),
    onFrame: () => {},
  });
  host = new ByocSealedChannel({
    initiator: false,
    localKeyPair: hostKey,
    expectedRemotePublicKey: hostExpectedClientKey,
    sendPacket: (packet: ByocSealedPacket) => queueMicrotask(() => client.receive(packet)),
    onFrame: (frame) => hostFrames.push(frame),
  });
  try {
    await Promise.all([client.opened, host.opened]);
  } catch (error) {
    client.close();
    host.close();
    throw error;
  }
  const untrack = gateway.track(connector, (reason) => {
    closeReasons.push(reason);
    client.close();
    host.close();
  });
  return {
    client,
    hostFrames,
    closeReasons,
    close: () => { untrack(); client.close(); host.close(); },
  };
}

describe('BYOC sealed-channel D-143 lifecycle (P-007)', () => {
  it('preserves connect/reconnect, fences stale generations and revocation, and refuses a substituted key', async () => {
    const gateway = new HostedWorkspaceConnectorGateway(
      new MemoryConnectorStore(),
      () => new Date('2026-10-02T00:00:00Z'),
      entropy(),
    );
    const clientKey = SecretStream.keyPair(Buffer.alloc(32, 81));
    const hostKey = SecretStream.keyPair(Buffer.alloc(32, 82));
    const first = await gateway.register((await gateway.enroll(binding)).ticket);
    expect(first?.binding).toMatchObject({ generation: 1, state: 'active' });

    const initial = await openSealed(gateway, first!.binding, clientKey, hostKey);
    await initial.client.send({ type: 'pty.input', data: 'initial' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(initial.hostFrames).toEqual([{ type: 'pty.input', data: 'initial' }]);
    initial.close();

    const reconnect = await openSealed(gateway, first!.binding, clientKey, hostKey);
    await reconnect.client.send({ type: 'file.read', path: '/workspace/reconnected.txt' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reconnect.hostFrames).toEqual([{ type: 'file.read', path: '/workspace/reconnected.txt' }]);

    const rotation = await gateway.rotate({ ...binding, routeLabel: 'beta' });
    expect(rotation?.binding.generation).toBe(2);
    expect(reconnect.closeReasons).toEqual(['connector_rotated']);
    await expect(reconnect.client.send({ type: 'pty.input', data: 'stale-live-generation' }))
      .rejects.toThrow(/closed/);
    expect(await gateway.authenticate(first!.bearer)).toBeNull();

    const current = await gateway.register(rotation!.ticket);
    expect(current?.binding).toMatchObject({ generation: 2, state: 'active' });
    const afterBump = await openSealed(gateway, current!.binding, clientKey, hostKey);
    await afterBump.client.send({ type: 'pty.input', data: 'current-generation' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(afterBump.hostFrames).toEqual([{ type: 'pty.input', data: 'current-generation' }]);

    const substituted = SecretStream.keyPair(Buffer.alloc(32, 83));
    await expect(openSealed(gateway, current!.binding, substituted, hostKey, clientKey.publicKey))
      .rejects.toThrow(/key|handshake|noise/i);

    expect(await gateway.revoke(binding)).toBe(true);
    expect(afterBump.closeReasons).toEqual(['connector_revoked']);
    await expect(afterBump.client.send({ type: 'pty.input', data: 'after-revocation' }))
      .rejects.toThrow(/closed/);
    expect(await gateway.authenticate(current!.bearer)).toBeNull();
  });
});
