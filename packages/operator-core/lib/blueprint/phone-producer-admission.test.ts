import { describe, expect, it, vi } from 'vitest';
import { admitAuthenticatedPhoneProducer, admitPhoneProducer, configuredPhoneProducerCompletionAttempt, createHttpsPhoneProducerAdmissionHost, type PhoneProducerAdmission } from './phone-producer-admission';
import { readFile } from 'node:fs/promises';
import type { Principal } from '@papercusp/agent-mcp';
import type { ExternalRuntimeProducerBinding } from './operation-worker-binding';
import type { AppScopeRow } from '../connected-apps/scope-policy';
import { resolveWorkItemPot } from '../pot-membership';

vi.mock('../pot-membership', () => ({ resolveWorkItemPot: vi.fn(async () => 'home') }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(async () => 'credential') }));

function fixture() {
  const snapshot: PhoneProducerAdmission = { workspaceId: 'workspace', harnessSlug: 'phone-app', storageHarnessSlug: 'home',
    executionOwnerId: 'voice-run-a', ownerId: 'owner-a', roomName: 'room-a', callKey: 'inbound:room-a', callId: 'call-a',
    runId: 'run-a', jobId: 'job-a', configFingerprint: 'llm=vendor/model', sessionStartedAt: '2026-10-07T13:00:00Z',
    workerAdmitted: true, contentDeleted: false, sessionEndedAt: null };
  let registration: ExternalRuntimeProducerBinding | null = null;
  let row: { id: string; harness: string; assignee: string; payload: unknown } | null = null;
  const host = {
    readAdmission: vi.fn(async () => ({ ...snapshot })),
    readRegistration: vi.fn(async () => registration && { ...registration }),
    reserveRegistration: vi.fn(async (_snapshot: PhoneProducerAdmission, proposed: ExternalRuntimeProducerBinding) => {
      registration ??= { ...proposed }; return { ...registration };
    }),
  };
  const store = {
    allocateId: vi.fn(async () => 'WI-voice'), read: vi.fn(async () => row),
    create: vi.fn(async (input: { id?: string; assignee?: string; payload?: unknown }) => {
      row = { id: input.id!, harness: 'home', assignee: input.assignee!, payload: input.payload }; return row;
    }),
  };
  return { snapshot, host, store, read: () => admitPhoneProducer(host, 'room-a', store),
    get registration() { return registration; }, get row() { return row; } };
}

describe('Phone producer configured completion', () => {
  const principal = (): Principal => ({ kind: 'service', trust: 'verified', authMethod: 'bearer-token',
    workspaceId: 'workspace', slug: 'voice-run-a', capabilities: new Set<string>() });
  const env = { PHONE_PRODUCER_ADMISSION_ENDPOINT: 'https://phone.test/admission', PHONE_PRODUCER_TOKEN_FILE: '/injected/token' };
  async function item() {
    const f = fixture(); await f.read();
    return { ...f.row!, updatedAt: '2026-10-07T13:01:00Z' };
  }
  it('constructs a detached host-read attempt with the current row epoch', async () => {
    const row = await item();
    const attempt = await configuredPhoneProducerCompletionAttempt(principal(), row, env);
    expect(readFile).toHaveBeenCalledWith('/injected/token', 'utf8');
    expect(attempt.updatedTs).toBe(Date.parse(row.updatedAt));
    expect(attempt.binding).toEqual((row.payload as any).externalRuntimeProducer);
    expect(attempt.binding).not.toBe((row.payload as any).externalRuntimeProducer);
    expect(typeof attempt.readStoredOutcome).toBe('function');
  });
  it.each(['slug', 'workspaceId', 'kind', 'trust', 'authMethod'] as const)
    ('refuses a different or unauthenticated principal %s before reading credentials', async (field) => {
      const row = await item(); vi.mocked(readFile).mockClear();
      await expect(configuredPhoneProducerCompletionAttempt({ ...principal(), [field]: 'foreign' } as Principal, row, env))
        .rejects.toThrow();
      expect(readFile).not.toHaveBeenCalled();
    });
  it.each(['assignee', 'id', 'harness'] as const)('refuses changed row %s', async (field) => {
    const row = await item();
    await expect(configuredPhoneProducerCompletionAttempt(principal(), { ...row, [field]: 'foreign' }, env))
      .rejects.toThrow('scope_mismatch');
  });
  it('requires explicit injected host configuration', async () => {
    await expect(configuredPhoneProducerCompletionAttempt(principal(), await item(), {}))
      .rejects.toThrow('not_configured');
  });
});

describe('Phone producer HTTPS bridge', () => {
  it('uses the same authenticated authority for owner-scoped retained registration and export', async () => {
    const f = fixture();
    const binding = await f.read();
    const retained = { binding, roomName: 'room-a', contentDeleted: false };
    const exported = { ok: true, content: { segments: [] } };
    const request = vi.fn().mockResolvedValueOnce(Response.json({ ok: true, data: retained }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: exported }));
    const host = createHttpsPhoneProducerAdmissionHost({ endpoint: 'https://phone.test/admission',
      token: 'credential', request }).retainedOutcomeHost;
    expect(await host.readRegistration('owner-a', 'inbound:room-a')).toEqual(retained);
    expect(await host.readExport('owner-a', 'room-a')).toEqual(exported);
    expect(request.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([
      { action: 'readRetainedRegistration', ownerId: 'owner-a', callKey: 'inbound:room-a' },
      { action: 'readExport', ownerId: 'owner-a', roomName: 'room-a' },
    ]);
    for (const [url, options] of request.mock.calls) {
      expect(url).toBe('https://phone.test/admission');
      expect(options.redirect).toBe('error');
      expect(options.headers.authorization).toBe('Bearer credential');
    }
  });
  it.each([null, { binding: {}, roomName: 'room-a', contentDeleted: false },
    { binding: {}, roomName: 'room-a' }])('rejects incomplete retained registration %j', async (data) => {
    const host = createHttpsPhoneProducerAdmissionHost({ endpoint: 'https://phone.test/admission',
      token: 'credential', request: vi.fn(async () => Response.json({ ok: true, data })) });
    await expect(host.retainedOutcomeHost.readRegistration('owner-a', 'call-key')).rejects.toThrow();
  });
  it.each(['http://phone.test/admission', 'https://user:secret@phone.test/admission',
    'https://phone.test/admission?authority=other', 'https://phone.test/admission#other'])
    ('refuses ambiguous or unauthenticated authority %s', (endpoint) => {
      expect(() => createHttpsPhoneProducerAdmissionHost({ endpoint, token: 'credential' }))
        .toThrow('https_authority_required');
    });
  it('reads trusted records through the fixed authority without allowing redirects', async () => {
    const snapshot = fixture().snapshot;
    const request = vi.fn(async () => Response.json({ ok: true, data: snapshot }));
    const host = createHttpsPhoneProducerAdmissionHost({ endpoint: 'https://phone.test/admission',
      token: 'credential', request });
    expect(await host.readAdmission('room-a')).toEqual(snapshot);
    expect(request).toHaveBeenCalledWith('https://phone.test/admission', expect.objectContaining({
      redirect: 'error', headers: expect.objectContaining({ authorization: 'Bearer credential' }),
      body: JSON.stringify({ action: 'readAdmission', roomName: 'room-a' }),
    }));
  });
  it('refuses successful HTTP responses carrying invalid admission or refused envelopes', async () => {
    for (const data of [{ ok: false, data: fixture().snapshot }, { ok: true, data: { ownerId: 'forged' } }]) {
      const host = createHttpsPhoneProducerAdmissionHost({ endpoint: 'https://phone.test/admission',
        token: 'credential', request: vi.fn(async () => Response.json(data)) });
      await expect(host.readAdmission('room-a')).rejects.toThrow();
    }
  });
});

describe('Phone producer canonical admission', () => {
  const principal = (): Principal => ({ kind: 'service', trust: 'verified', authMethod: 'bearer-token',
    workspaceId: 'workspace', slug: 'voice-run-a', capabilities: new Set<string>() });
  it('binds authenticated service identity to the canonical producer', async () => {
    const f = fixture();
    const result = await admitAuthenticatedPhoneProducer(principal(), f.host, 'room-a', f.store);
    expect(result.executionOwnerId).toBe('voice-run-a');
    expect(f.row!.assignee).toBe('voice-run-a');
    expect(resolveWorkItemPot).toHaveBeenCalledWith({ rawSlug: 'phone-app', workspaceId: 'workspace' });
  });
  it('refuses a sidecar-selected ledger partition before allocating a producer', async () => {
    const f = fixture(); f.snapshot.storageHarnessSlug = 'foreign';
    await expect(admitAuthenticatedPhoneProducer(principal(), f.host, 'room-a', f.store))
      .rejects.toThrow('storage_scope_mismatch');
    expect(f.store.allocateId).not.toHaveBeenCalled();
    expect(f.host.reserveRegistration).not.toHaveBeenCalled();
    expect(f.store.create).not.toHaveBeenCalled();
  });
  it('refuses unresolved canonical storage instead of accepting the sidecar value', async () => {
    const f = fixture();
    await expect(admitAuthenticatedPhoneProducer(principal(), f.host, 'room-a', f.store, undefined,
      async () => null)).rejects.toThrow('storage_scope_mismatch');
    expect(f.store.allocateId).not.toHaveBeenCalled();
  });
  it('rechecks canonical storage after allocation before sidecar reservation', async () => {
    const f = fixture();
    const resolve = vi.fn().mockResolvedValueOnce('home').mockResolvedValue('other-home');
    await expect(admitAuthenticatedPhoneProducer(principal(), f.host, 'room-a', f.store, undefined,
      resolve)).rejects.toThrow('storage_scope_mismatch');
    expect(f.store.allocateId).toHaveBeenCalledOnce();
    expect(f.host.reserveRegistration).not.toHaveBeenCalled();
    expect(f.store.create).not.toHaveBeenCalled();
  });
  function appFixture() {
    const f = fixture();
    f.snapshot.executionOwnerId = 'app:key-a/token-a';
    const row = (): AppScopeRow => ({ id: 'key-a', workspace_id: 'workspace',
      revoked_at: null, paused_at: null, expires_at: null,
      scopes: { tools: ['work_items:create'], harnesses: ['phone-app'] } });
    const parent = row(); const token = row();
    const grants = { loadRow: vi.fn(async () => parent), loadTokenRow: vi.fn(async () => token) };
    const read = () => admitAuthenticatedPhoneProducer({ ...principal(), slug: f.snapshot.executionOwnerId },
      f.host, 'room-a', f.store, grants);
    return { ...f, parent, token, grants, read };
  }
  it('checks both the parent and narrower access-token grant', async () => {
    const f = appFixture();
    expect((await f.read()).executionOwnerId).toBe('app:key-a/token-a');
    expect(f.grants.loadRow).toHaveBeenCalledWith('key-a');
    expect(f.grants.loadTokenRow).toHaveBeenCalledWith('token-a', 'key-a');
  });
  it.each(['parent', 'token'] as const)('refuses a foreign harness in the %s grant before allocation', async (which) => {
    const f = appFixture(); f[which].scopes = { tools: ['work_items:create'], harnesses: ['other'] };
    await expect(f.read()).rejects.toThrow('grant_harness_not_in_scope');
    expect(f.store.allocateId).not.toHaveBeenCalled();
  });
  it.each(['revoked', 'paused', 'expired', 'tools', 'workspace'] as const)('refuses a %s access-token grant', async (kind) => {
    const f = appFixture();
    if (kind === 'revoked') f.token.revoked_at = new Date();
    if (kind === 'paused') f.token.paused_at = new Date();
    if (kind === 'expired') f.token.expires_at = new Date(0);
    if (kind === 'tools') f.token.scopes = { tools: ['blueprint:submit'] };
    if (kind === 'workspace') f.token.workspace_id = 'foreign';
    await expect(f.read()).rejects.toThrow('phone_producer_grant_');
    expect(f.store.allocateId).not.toHaveBeenCalled();
  });
  it('refuses a missing token row rather than inheriting the parent grant', async () => {
    const f = appFixture(); f.grants.loadTokenRow.mockResolvedValue(null as unknown as AppScopeRow);
    await expect(f.read()).rejects.toThrow('grant_unavailable');
    expect(f.store.allocateId).not.toHaveBeenCalled();
  });
  it('rechecks revocation after reservation before canonical create', async () => {
    const f = appFixture(); const reserve = f.host.reserveRegistration.getMockImplementation()!;
    f.host.reserveRegistration.mockImplementation(async (snapshot, proposed) => {
      const binding = await reserve(snapshot, proposed); f.parent.revoked_at = new Date(); return binding;
    });
    await expect(f.read()).rejects.toThrow('grant_key_revoked');
    expect(f.store.create).not.toHaveBeenCalled();
  });
  it.each([null, { kind: 'human' }, { trust: 'unverified' }, { authMethod: 'loopback' },
    { workspaceId: '' }, { slug: 'su-loopback' }, { slug: 'mcp-call-123' }])(
    'rejects an unauthenticated service before reading Phone records (%j)', async (override) => {
      const f = fixture();
      const caller = override === null ? null : { ...principal(), ...override } as Principal;
      await expect(admitAuthenticatedPhoneProducer(caller, f.host, 'room-a', f.store))
        .rejects.toThrow('authenticated_service_required');
      expect(f.host.readAdmission).not.toHaveBeenCalled();
      expect(f.store.allocateId).not.toHaveBeenCalled();
    });
  it.each(['workspaceId', 'executionOwnerId'] as const)('rejects foreign authenticated %s before reserving', async (field) => {
    const f = fixture(); f.snapshot[field] = 'foreign';
    await expect(admitAuthenticatedPhoneProducer(principal(), f.host, 'room-a', f.store))
      .rejects.toThrow('authenticated_scope_mismatch');
    expect(f.store.allocateId).not.toHaveBeenCalled();
    expect(f.host.reserveRegistration).not.toHaveBeenCalled();
  });
  it('captures credential identity before asynchronous host I/O', async () => {
    const f = fixture(); const caller = principal();
    f.host.readAdmission.mockImplementation(async () => {
      caller.slug = 'foreign'; caller.workspaceId = 'foreign'; return { ...f.snapshot };
    });
    const result = await admitAuthenticatedPhoneProducer(caller, f.host, 'room-a', f.store);
    expect(result.executionOwnerId).toBe('voice-run-a');
    expect(result.workspaceId).toBe('workspace');
  });
  it.each(['system:phone', 'su-loopback', 'mcp-call-123'])('rejects unattributed executor %s before reserving', async (owner) => {
    const f = fixture(); f.snapshot.executionOwnerId = owner;
    await expect(f.read()).rejects.toThrow('attributed_executor_required');
    expect(f.host.reserveRegistration).not.toHaveBeenCalled(); expect(f.store.create).not.toHaveBeenCalled();
  });
  it('reserves before canonical create and reads back the rehomed holder/binding', async () => {
    const f = fixture(); const binding = await f.read();
    expect(f.host.reserveRegistration.mock.invocationCallOrder[0]).toBeLessThan(f.store.create.mock.invocationCallOrder[0]);
    expect(f.store.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'WI-voice', harness: 'phone-app',
      workspaceId: 'workspace', assignee: 'voice-run-a', payload: { externalRuntimeProducer: binding } }));
    expect(binding.configurationSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(f.store.read).toHaveBeenLastCalledWith('WI-voice', 'home');
  });
  it('recovers a reserved ID after canonical create fails', async () => {
    const f = fixture(); f.store.create.mockRejectedValueOnce(new Error('offline'));
    await expect(f.read()).rejects.toThrow('offline');
    await f.read();
    expect(f.store.allocateId).toHaveBeenCalledTimes(1);
    expect(f.host.reserveRegistration).toHaveBeenCalledTimes(1);
    expect(f.store.create.mock.calls.map(([input]) => input.id)).toEqual(['WI-voice', 'WI-voice']);
  });
  it('replays an existing binding after worker expiry/session end', async () => {
    const f = fixture(); const binding = await f.read();
    f.snapshot.workerAdmitted = false; f.snapshot.sessionEndedAt = '2026-10-07T13:05:00Z';
    expect(await f.read()).toEqual(binding);
    expect(f.store.create).toHaveBeenCalledTimes(1);
    expect(f.store.allocateId).toHaveBeenCalledTimes(1);
  });
  it.each(['worker', 'ended', 'deleted', 'room'] as const)('refuses fresh %s admission before allocation', async (kind) => {
    const f = fixture();
    if (kind === 'worker') f.snapshot.workerAdmitted = false;
    if (kind === 'ended') f.snapshot.sessionEndedAt = '2026-10-07T13:05:00Z';
    if (kind === 'deleted') f.snapshot.contentDeleted = true;
    if (kind === 'room') f.snapshot.roomName = 'foreign';
    await expect(f.read()).rejects.toThrow(/phone_producer_/);
    expect(f.store.allocateId).not.toHaveBeenCalled(); expect(f.store.create).not.toHaveBeenCalled();
  });
  it('uses the concurrent reservation winner ID', async () => {
    const f = fixture();
    f.host.reserveRegistration.mockImplementationOnce(async (_snapshot, proposed) => {
      const winner = { ...proposed, workItemId: 'WI-winner' };
      f.host.readRegistration.mockResolvedValue(winner); return winner;
    });
    expect((await f.read()).workItemId).toBe('WI-winner');
    expect(f.store.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'WI-winner' }));
  });
  it.each(['ownerId', 'runId', 'jobId', 'executionOwnerId', 'workspaceId', 'configFingerprint'] as const)(
    'refuses changed retained %s without a new create', async (field) => {
      const f = fixture(); await f.read(); f.snapshot[field] = 'foreign';
      await expect(f.read()).rejects.toThrow('registration_conflict');
      expect(f.store.create).toHaveBeenCalledTimes(1);
    });
  it.each(['holder', 'binding', 'harness'] as const)('refuses contradictory canonical %s', async (kind) => {
    const f = fixture(); await f.read();
    if (kind === 'holder') f.row!.assignee = 'foreign';
    if (kind === 'binding') f.row!.payload = {};
    if (kind === 'harness') f.row!.harness = 'foreign';
    await expect(f.read()).rejects.toThrow('canonical_binding_conflict');
  });
  it('recovers a lost create response only after canonical readback', async () => {
    const f = fixture(); const create = f.store.create.getMockImplementation()!;
    f.store.create.mockImplementationOnce(async (input) => { await create(input); throw new Error('lost response'); });
    expect((await f.read()).workItemId).toBe('WI-voice');
    expect(f.store.create).toHaveBeenCalledTimes(1);
  });
  it.each(['deleted', 'runtime', 'registration'] as const)('refuses %s changing during create', async (kind) => {
    const f = fixture(); const create = f.store.create.getMockImplementation()!;
    f.store.create.mockImplementationOnce(async (input) => {
      const row = await create(input);
      if (kind === 'deleted') f.snapshot.contentDeleted = true;
      if (kind === 'runtime') f.snapshot.jobId = 'replacement';
      if (kind === 'registration') f.host.readRegistration.mockResolvedValue(null);
      return row;
    });
    await expect(f.read()).rejects.toThrow('registration_changed');
  });
});
