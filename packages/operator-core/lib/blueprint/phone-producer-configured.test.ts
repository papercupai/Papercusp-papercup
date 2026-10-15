import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@papercusp/agent-mcp';
import { admitConfiguredPhoneProducer } from './phone-producer-admission';
import type { CreateWorkItemInput } from '../work-items';
import type { ExternalRuntimeProducerBinding } from './operation-worker-binding';

type ProducerRow = CreateWorkItemInput & { harness: string };

const state = vi.hoisted(() => ({
  row: null as ProducerRow | null, binding: null as ExternalRuntimeProducerBinding | null, allowed: true,
  allocate: vi.fn(async () => 'WI-123'),
  readToken: vi.fn(async () => 'bridge-secret'),
  create: vi.fn(async (input: CreateWorkItemInput) => (state.row = { ...input, harness: 'home' })),
}));
vi.mock('node:fs/promises', () => ({ readFile: state.readToken }));
vi.mock('../work-items', () => ({ nextWorkItemId: state.allocate, createWorkItem: state.create,
  getWorkItem: vi.fn(async () => state.row) }));
vi.mock('../pot-membership', () => ({ resolveWorkItemPot: vi.fn(async () => 'home') }));
vi.mock('../work-scope-policy', () => ({ gateWorkScope: vi.fn(async () => ({ allowed: state.allowed })) }));

const principal = { kind: 'service', trust: 'verified', authMethod: 'bearer-token',
  workspaceId: 'workspace', slug: 'voice-service' } as Principal;
const env = { PHONE_PRODUCER_ADMISSION_ENDPOINT: 'https://phone.test/platform/producer-admission',
  PHONE_PRODUCER_TOKEN_FILE: '/injected/phone-token' };
const snapshot = { workspaceId: 'workspace', harnessSlug: 'phone-app', storageHarnessSlug: 'home',
  executionOwnerId: 'voice-service', ownerId: 'speaker', roomName: 'room-a', callKey: 'inbound:room-a',
  callId: 'call-a', runId: 'run-a', jobId: 'job-a', configFingerprint: 'llm=vendor/model',
  sessionStartedAt: '2026-10-07T13:00:00Z', workerAdmitted: true, contentDeleted: false, sessionEndedAt: null };

beforeEach(() => {
  vi.clearAllMocks(); state.row = null; state.binding = null; state.allowed = true;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
    expect(options.redirect).toBe('error');
    expect(options.headers).toMatchObject({ authorization: 'Bearer bridge-secret' });
    const args = JSON.parse(options.body as string);
    const data = args.action === 'readAdmission' ? snapshot : args.action === 'readRegistration'
      ? state.binding : (state.binding ??= args.proposed);
    return Response.json({ ok: true, data });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('configured Phone producer entry', () => {
  it('reads injected credentials and creates/replays the canonical host-bound producer', async () => {
    const first = await admitConfiguredPhoneProducer(principal, 'room-a', { harness: 'phone-app' }, env);
    const replay = await admitConfiguredPhoneProducer(principal, 'room-a', { harness: 'phone-app' }, env);
    expect(first).toEqual(replay);
    expect(state.readToken).toHaveBeenCalledWith('/injected/phone-token', 'utf8');
    expect(state.allocate).toHaveBeenCalledTimes(1);
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.row?.payload).toMatchObject({ externalRuntimeProducer: { ownerId: 'speaker', executionOwnerId: 'voice-service' } });
  });
  it('refuses an unauthenticated caller before reading credentials', async () => {
    await expect(admitConfiguredPhoneProducer(null, 'room-a', {}, env)).rejects.toThrow('authenticated_service_required');
    expect(state.readToken).not.toHaveBeenCalled();
  });
  it('has no secret fallback when not configured', async () => {
    await expect(admitConfiguredPhoneProducer(principal, 'room-a', {}, {})).rejects.toThrow('bridge_not_configured');
    expect(state.readToken).not.toHaveBeenCalled();
  });
  it.each([{ workspace: 'foreign' }, { harness: 'foreign' }])('refuses requested scope %j before allocation', async (scope) => {
    await expect(admitConfiguredPhoneProducer(principal, 'room-a', scope, env)).rejects.toThrow('authenticated_scope_mismatch');
    expect(state.allocate).not.toHaveBeenCalled();
  });
  it('enforces the maintained work scope before allocation', async () => {
    state.allowed = false;
    await expect(admitConfiguredPhoneProducer(principal, 'room-a', {}, env)).rejects.toThrow('work_scope_refused');
    expect(state.allocate).not.toHaveBeenCalled();
  });
});
