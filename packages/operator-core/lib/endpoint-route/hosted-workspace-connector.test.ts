import { describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '@papercusp/agent-mcp';
import { createHostedPrincipal } from '../auth/hosted-principal';
const agentReservationCalls = vi.hoisted(() => ({ factory: vi.fn(), run: vi.fn() }));
vi.mock('../workspace-host/hosted-agent-admission', () => ({
  createHostedPoolAgentReservations: (...args: unknown[]) => {
    agentReservationCalls.factory(...args); return agentReservationCalls.run;
  },
}));
import {
  HOSTED_CONNECTOR_LIVENESS_FRESH_MS,
  HostedWorkspaceConnectorGateway,
  isHostedConnectorLive,
  type HostedConnectorLivenessBinding,
  type HostedConnectorBinding,
  type HostedConnectorTicketBinding,
  type HostedConnectorTicketKind,
  type HostedConnectorTransport,
  type HostedWorkspaceConnectorStore,
} from './hosted-workspace-connector';
import {
  authenticateHostedConnectorSocket,
  authenticateHostedConnectorTransport,
  createHostedWorkspaceConnectorRoutes,
} from './routes/hosted-workspace-connector';

describe('hosted connector route refusal identity', () => {
  it.each([0, 1, 2, 3])('refuses a foreign workspace after Response constructor replacement on route %i', async (index) => {
    const original = globalThis.Response;
    class AlternateResponse extends original {}
    vi.stubGlobal('Response', AlternateResponse);
    const gatewayCalls = {
      enroll: vi.fn(async () => null), rotate: vi.fn(async () => null),
      revoke: vi.fn(async () => null), issueSessionTicket: vi.fn(async () => null),
    };
    try {
      expect(Response.json({ denied: true })).not.toBeInstanceOf(AlternateResponse);
      const route = createHostedWorkspaceConnectorRoutes(gatewayCalls as unknown as HostedWorkspaceConnectorGateway)[index];
      const ctx: RouteContext = {
        principal: createHostedPrincipal({ workspaceId: 'control', userId: 'user-1', activeOrganizationId: 'org-1',
          selectedWorkspaceId: 'customer-1', sessionId: 'session-1', sessionVersion: 1, permissions: ['workspace:operate'] }),
        input: undefined, params: { workspaceId: 'foreign' }, log: () => {}, signal: new AbortController().signal,
      };
      const response = await route.handler(new Request('https://app.papercusp.com/api/hosted/workspaces/foreign/connectors/enroll', {
        method: 'POST', body: JSON.stringify({ hostId: 'foreign-host', routeLabel: 'foreign', transport: 'websocket' }),
      }), ctx);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'workspace_binding_mismatch' } });
      for (const call of Object.values(gatewayCalls)) expect(call).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal('Response', original);
    }
  });
});

class MemoryStore implements HostedWorkspaceConnectorStore {
  binding: HostedConnectorBinding | null = null;
  credentialHash: string | null = null;
  tickets = new Map<string, HostedConnectorTicketBinding>();
  createEnrollment(input: Omit<HostedConnectorBinding,'generation'|'state'> & {ticketHash:string;expiresAt:Date}) { this.binding={...input,generation:(this.binding?.generation??0)+1,state:'pending'};this.tickets.set(input.ticketHash,{...this.binding,kind:'enrollment',audience:'connector-register',expiresAt:input.expiresAt});return Promise.resolve(this.binding); }
  register(hash:string,credentialHash:string,now:Date){const ticket=this.take(hash,'enrollment',now);if(!ticket||!this.binding||ticket.generation!==this.binding.generation)return Promise.resolve(null);this.credentialHash=credentialHash;this.binding={...this.binding,state:'active'};return Promise.resolve(this.binding);}
  authenticate(hash:string){return Promise.resolve(this.binding?.state==='active'&&hash===this.credentialHash?this.binding:null);}
  heartbeat(hash:string,transport:HostedConnectorTransport){if(this.binding?.state!=='active'||hash!==this.credentialHash||transport!==this.binding.transport)return Promise.resolve(null);return Promise.resolve(this.binding);}
  heartbeatAt: Date | null = null;
  livenessCalls: [boolean, number][] = [];
  async recordLiveness(target: HostedConnectorLivenessBinding, alive: boolean, at: Date) {
    // A slow first write makes an out-of-order interleaving observable if the gateway ever stops serializing.
    if (this.livenessCalls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    this.livenessCalls.push([alive, at.getTime()]);
    if (!this.binding || this.binding.generation !== target.generation || this.binding.state !== 'active') return false;
    if (alive) {
      if (this.heartbeatAt && this.heartbeatAt >= at) return false;
      this.heartbeatAt = at;
      return true;
    }
    if (!this.heartbeatAt || this.heartbeatAt > at) return false;
    this.heartbeatAt = null;
    return true;
  }
  issueSessionTicket(input:HostedConnectorTicketBinding&{ticketHash:string;issuedAt:Date}){if(this.binding?.state!=='active')return Promise.resolve(null);const ticket={...input,...this.binding,expiresAt:input.expiresAt,issuedAt:input.issuedAt,ticketHash:input.ticketHash,kind:'session' as const};this.tickets.set(input.ticketHash,ticket);return Promise.resolve(ticket);}
  consumeTicket(hash:string,kind:HostedConnectorTicketKind,now:Date){return Promise.resolve(this.take(hash,kind,now));}
  rotate(input:Omit<HostedConnectorBinding,'generation'|'state'>&{ticketHash:string;expiresAt:Date;now:Date}){if(this.binding?.state!=='active')return Promise.resolve(null);this.binding={...input,generation:this.binding.generation+1,state:'pending'};this.credentialHash=null;this.tickets.set(input.ticketHash,{...this.binding,kind:'enrollment',audience:'connector-register',expiresAt:input.expiresAt});return Promise.resolve(this.binding);}
  revoke(){if(!this.binding)return Promise.resolve(null);this.binding={...this.binding,state:'revoked'};this.credentialHash=null;return Promise.resolve(this.binding);}
  private take(hash:string,kind:HostedConnectorTicketKind,now:Date){const value=this.tickets.get(hash);if(!value||value.kind!==kind||value.expiresAt<=now||value.generation!==this.binding?.generation||this.binding.state!==(kind==='enrollment'?'pending':'active'))return null;this.tickets.delete(hash);return value;}
}

const binding={controlPlaneWorkspaceId:'control',organizationId:'org-1',customerWorkspaceId:'workspace-1',hostId:'host-1',routeLabel:'alpha',transport:'websocket' as const};

describe('connector agent admission authentication', () => {
  it('derives the quota tenant from the bearer and rejects request-provided tenant authority', async () => {
    agentReservationCalls.factory.mockClear(); agentReservationCalls.run.mockReset();
    agentReservationCalls.run.mockResolvedValue({ receiptId: 'RG-server', state: 'queued' });
    const authenticated = { ...binding, state: 'active', generation: 2 };
    const gateway = { authenticate: vi.fn(async () => authenticated) } as unknown as HostedWorkspaceConnectorGateway;
    const route = createHostedWorkspaceConnectorRoutes(gateway)[8];
    const request = (input: unknown, authorization = `Bearer hc_${'a'.repeat(43)}`) => new Request(
      'https://app.papercusp.com/api/hosted/connectors/agent-admission', { method: 'POST',
        headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    expect((await route.handler(request({ action: 'reserve', processKey: 'p' }, ''), {} as RouteContext)).status).toBe(401);
    expect(agentReservationCalls.factory).not.toHaveBeenCalled();
    expect((await route.handler(request({ action: 'reserve', processKey: 'p', organizationId: 'forged' }), {} as RouteContext)).status).toBe(400);
    expect(agentReservationCalls.factory).not.toHaveBeenCalled();
    const response = await route.handler(request({ action: 'reserve', processKey: 'p' }), {} as RouteContext);
    expect(await response.json()).toMatchObject({ ok: true, receiptId: 'RG-server' });
    expect(agentReservationCalls.factory).toHaveBeenCalledWith(authenticated);
    expect(agentReservationCalls.run).toHaveBeenCalledWith('reserve', 'p');
    agentReservationCalls.run.mockRejectedValueOnce(new Error('postgres://private-credential'));
    const refused = await route.handler(request({ action: 'start', processKey: 'p' }), {} as RouteContext);
    expect(refused.status).toBe(409);
    expect(await refused.text()).not.toContain('private-credential');
  });
});
function entropy(){let byte=0;return(size:number)=>new Uint8Array(size).fill(++byte);}

async function activeGateway(clock: { now: Date }) {
  const gateway = new HostedWorkspaceConnectorGateway(new MemoryStore(), () => clock.now, entropy());
  await gateway.register((await gateway.enroll(binding)).ticket);
  return gateway;
}

function browserUpgrade(ticket: string) {
  return new Request(`https://alpha.workspaces.papercusp.com/api/hosted/connectors/socket?ticket=${ticket}`);
}

describe('HostedWorkspaceConnectorGateway',()=>{
  it('redeems enrollment once, authenticates the generation, and consumes session tickets once',async()=>{
    const gateway=new HostedWorkspaceConnectorGateway(new MemoryStore(),()=>new Date('2026-08-28T00:00:00Z'),entropy());
    const enrollment=await gateway.enroll(binding);
    const credential=await gateway.register(enrollment.ticket);
    expect(credential?.binding).toMatchObject({generation:1,state:'active'});
    expect(await gateway.register(enrollment.ticket)).toBeNull();
    expect(await gateway.authenticate(credential!.bearer)).toMatchObject({hostId:'host-1'});
    expect(await gateway.heartbeat(credential!.bearer,'sse')).toBeNull();
    expect(await gateway.heartbeat(credential!.bearer,'websocket')).toMatchObject({transport:'websocket'});
    const transportRequest=new Request('https://alpha.workspaces.papercusp.com/api/hosted/connectors/socket',{headers:{authorization:`Bearer ${credential!.bearer}`}});
    expect(await authenticateHostedConnectorTransport(gateway,transportRequest,'websocket')).toMatchObject({hostId:'host-1'});
    expect(await authenticateHostedConnectorTransport(gateway,transportRequest,'sse')).toBeNull();
    const session=await gateway.issueSessionTicket({...binding,generation:0,state:'pending',userId:'user-1',hostedSessionId:'session-1',audience:'workspace-operator'});
    expect(session?.binding).toMatchObject({generation:1,state:'active'});
    expect(await gateway.consumeSessionTicket(session!.ticket)).toMatchObject({userId:'user-1'});
    expect(await gateway.consumeSessionTicket(session!.ticket)).toBeNull();
  });

  it('closes old-generation streams on rotation and the current generation on revocation',async()=>{
    const gateway=new HostedWorkspaceConnectorGateway(new MemoryStore(),()=>new Date('2026-08-28T00:00:00Z'),entropy());
    const credential=await gateway.register((await gateway.enroll(binding)).ticket);
    const oldSession=await gateway.issueSessionTicket({...binding,generation:0,state:'pending',userId:'user-1',hostedSessionId:'session-1',audience:'workspace-operator'});
    const reasons:string[]=[]; gateway.track(credential!.binding,(reason)=>reasons.push(reason));
    const rotation=await gateway.rotate({...binding,routeLabel:'beta'});
    expect(reasons).toEqual(['connector_rotated']);
    expect(await gateway.consumeSessionTicket(oldSession!.ticket)).toBeNull();
    const next=await gateway.register(rotation!.ticket); gateway.track(next!.binding,(reason)=>reasons.push(reason));
    expect(await gateway.revoke(binding)).toBe(true);
    expect(reasons).toEqual(['connector_rotated','connector_revoked']);
    expect(await gateway.authenticate(next!.bearer)).toBeNull();
  });
});

describe('connector liveness (P-001, psu-cloud-connector-liveness-multi-signin-2026-09-29)', () => {
  const now = new Date('2026-09-29T17:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const active = { state: 'active', transport: 'websocket' };

  it('calls a connector reachable only while its heartbeat is fresh', () => {
    expect(isHostedConnectorLive({ ...active, heartbeatAt: ago(1_000) }, now)).toBe(true);
    expect(isHostedConnectorLive({ ...active, heartbeatAt: ago(HOSTED_CONNECTOR_LIVENESS_FRESH_MS) }, now)).toBe(true);
    // The avi-test failure: an active row whose link died hours ago.
    expect(isHostedConnectorLive({ ...active, heartbeatAt: ago(HOSTED_CONNECTOR_LIVENESS_FRESH_MS + 1) }, now)).toBe(false);
    expect(isHostedConnectorLive({ ...active, heartbeatAt: ago(2 * 60 * 60_000) }, now)).toBe(false);
    expect(isHostedConnectorLive({ ...active, heartbeatAt: null }, now)).toBe(false);
    expect(isHostedConnectorLive({ state: 'pending', transport: 'websocket', heartbeatAt: ago(0) }, now)).toBe(false);
    expect(isHostedConnectorLive({ state: 'active', transport: 'sse', heartbeatAt: ago(0) }, now)).toBe(false);
    expect(isHostedConnectorLive(null, now)).toBe(false);
  });

  it('persists liveness writes for one connector in call order, so a detach is never overtaken', async () => {
    const store = new MemoryStore();
    const clock = { now: new Date('2026-09-29T17:00:00Z') };
    const gateway = new HostedWorkspaceConnectorGateway(store, () => clock.now, entropy());
    const credential = await gateway.register((await gateway.enroll(binding)).ticket);
    const target = credential!.binding;

    clock.now = new Date('2026-09-29T17:00:30Z');
    const pong = gateway.recordLiveness(target, true);
    clock.now = new Date('2026-09-29T17:01:00Z');
    const detach = gateway.recordLiveness(target, false);
    await Promise.all([pong, detach]);

    expect(store.livenessCalls.map(([alive]) => alive)).toEqual([true, false]);
    expect(store.heartbeatAt).toBeNull();

    clock.now = new Date('2026-09-29T17:01:05Z');
    await gateway.recordLiveness(target, true);
    expect(store.heartbeatAt).toEqual(new Date('2026-09-29T17:01:05Z'));
  });

  it('reports a failed liveness write instead of throwing into the socket handler', async () => {
    const store = new MemoryStore();
    store.recordLiveness = () => Promise.reject(new Error('pg down'));
    const gateway = new HostedWorkspaceConnectorGateway(store, () => new Date(), entropy());
    const errors: unknown[] = [];
    await expect(
      gateway.recordLiveness({ ...binding, generation: 1 }, true, (error) => errors.push(error)),
    ).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});

describe('hosted WebSocket hostname admission', () => {
  it('distinguishes a valid registered bearer on loopback from an invalid bearer on an allowed host', async () => {
    const gateway = new HostedWorkspaceConnectorGateway(new MemoryStore(), () => new Date(), entropy());
    const credential = await gateway.register((await gateway.enroll(binding)).ticket);
    expect(await gateway.authenticate(credential!.bearer)).toMatchObject({ hostId: binding.hostId });
    const upgrade = (host: string, bearer = credential!.bearer) =>
      new Request(`https://${host}/api/hosted/connectors/socket`, {
        headers: { authorization: `Bearer ${bearer}` },
      });
    for (const host of ['localhost:14502', '127.0.0.1:14503', 'foreign.workspaces.papercusp.com']) {
      expect(await authenticateHostedConnectorSocket(gateway, upgrade(host))).toBeNull();
    }
    for (const host of ['app.papercusp.com', 'alpha.workspaces.papercusp.com']) {
      expect(await authenticateHostedConnectorSocket(gateway, upgrade(host))).toMatchObject({ role: 'connector' });
      expect(await authenticateHostedConnectorSocket(gateway, upgrade(host, `hc_${'Z'.repeat(43)}`))).toBeNull();
    }
    expect(await gateway.authenticate(credential!.bearer)).toMatchObject({ hostId: binding.hostId });
  });
});

describe('hosted browser WebSocket upgrade ticket rejection', () => {
  it('fails a syntactically valid but unknown ticket closed as unauthorized', async () => {
    const clock = { now: new Date('2026-08-28T00:00:00Z') };
    const gateway = await activeGateway(clock);

    await expect(
      authenticateHostedConnectorSocket(gateway, browserUpgrade(`ht_${'Z'.repeat(43)}`)),
    ).resolves.toBeNull();
  });

  it('fails an expired ticket closed as unauthorized without dereferencing it', async () => {
    const clock = { now: new Date('2026-08-28T00:00:00Z') };
    const gateway = await activeGateway(clock);
    const session = await gateway.issueSessionTicket({
      ...binding, generation: 0, state: 'pending', userId: 'user-1',
      hostedSessionId: 'session-expired', audience: 'workspace-operator',
    });
    clock.now = new Date('2026-08-28T00:01:01Z');

    await expect(
      authenticateHostedConnectorSocket(gateway, browserUpgrade(session!.ticket)),
    ).resolves.toBeNull();
  });

  it('fails a replayed one-time ticket closed as unauthorized', async () => {
    const clock = { now: new Date('2026-08-28T00:00:00Z') };
    const gateway = await activeGateway(clock);
    const session = await gateway.issueSessionTicket({
      ...binding, generation: 0, state: 'pending', userId: 'user-1',
      hostedSessionId: 'session-replay', audience: 'workspace-operator',
    });
    const request = browserUpgrade(session!.ticket);

    await expect(authenticateHostedConnectorSocket(gateway, request)).resolves.toMatchObject({
      role: 'browser',
      binding: { userId: 'user-1', hostedSessionId: 'session-replay' },
    });
    await expect(authenticateHostedConnectorSocket(gateway, request)).resolves.toBeNull();
  });

  it('fails a prior-generation ticket closed after connector rotation', async () => {
    const clock = { now: new Date('2026-08-28T00:00:00Z') };
    const gateway = await activeGateway(clock);
    const session = await gateway.issueSessionTicket({
      ...binding, generation: 0, state: 'pending', userId: 'user-1',
      hostedSessionId: 'session-stale-generation', audience: 'workspace-operator',
    });
    await gateway.rotate({ ...binding, routeLabel: 'beta' });

    await expect(
      authenticateHostedConnectorSocket(gateway, browserUpgrade(session!.ticket)),
    ).resolves.toBeNull();
  });
});
