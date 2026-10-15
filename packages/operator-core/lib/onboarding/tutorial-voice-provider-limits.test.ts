import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../integration-credentials', () => ({ readAdmittedElevenLabsIntegrationCredential: vi.fn() }));
import { readAdmittedElevenLabsIntegrationCredential } from '../integration-credentials';
import { createElevenLabsTutorialVoiceLimitVerifier, readReservedElevenLabsTutorialCredential,
  createElevenLabsTutorialVoiceTokenProvider } from './tutorial-voice-reservation-store';
import { PAPERCUP_FRONT_AGENT } from '../voice-engines/elevenlabs-agent-sync';

const read = vi.mocked(readAdmittedElevenLabsIntegrationCredential);
const admitted = { apiKey: 'synthetic-secret', keyId: 'restricted', agentId: 'tutorial', maximumSeconds: 120 };
function options() {
  return { credential: { integrationName: 'TUTORIAL_KEY', metadataApiKey: 'synthetic-metadata',
    allowedPermissions: ['convai_read'], maximumCredits: 1000,
    definition: structuredClone(PAPERCUP_FRONT_AGENT), toolIds: ['tutorial-help'], agentId: 'tutorial',
    fetch, signal: new AbortController().signal },
  dailySeconds: { global: 1200, user: 240, organization: 600, workspace: 600 } };
}
const verify = (reader: ReturnType<typeof createElevenLabsTutorialVoiceLimitVerifier>) =>
  reader(null as never, null as never);
beforeEach(() => { read.mockReset(); read.mockResolvedValue(admitted); });
afterEach(() => { vi.restoreAllMocks(); });
describe('server tutorial signed URL issuer', () => {
  const reservation = { ok: true as const, reservationId: '11111111-1111-4111-8111-111111111111',
    maximumSeconds: 120, providerLimitRef: 'elevenlabs:restricted:tutorial' };
  const signedUrl = 'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=tutorial&conversation_id=conv-one&conversation_signature=synthetic';
  function setup() {
    const events: string[] = [];
    const store = { reserve: vi.fn(async () => { events.push('reserve'); return reservation; }),
      beginIssuance: vi.fn(async (): Promise<string | null> => { events.push('attempt'); return 'attempt-one'; }),
      recordProviderConversation: vi.fn(async () => { events.push('receipt'); return true; }) };
    const transport = vi.fn(async () => { events.push('mint'); return Response.json({ signed_url: signedUrl }); });
    const disabled = vi.fn(async () => false);
    const credential = { ...options().credential, fetch: transport as unknown as typeof fetch };
    const provider = createElevenLabsTutorialVoiceTokenProvider({ store, credential, disabled });
    const controller = new AbortController();
    const issue = () => provider.issue({} as never, controller.signal);
    return { events, store, transport, disabled, controller, issue };
  }
  it('commits attempt before mint and immutable receipt before delivering a bounded secret-free response', async () => {
    const s = setup(); const result = await s.issue();
    expect(s.events).toEqual(['reserve', 'attempt', 'mint', 'receipt']);
    expect(result).toMatchObject({ ok: true, connectionType: 'websocket', signedUrl,
      sessionId: reservation.reservationId, maximumSeconds: 120 });
    expect(JSON.stringify(result)).not.toContain(admitted.apiKey);
    const [endpoint, init] = s.transport.mock.calls[0] as unknown as [URL, RequestInit];
    expect(endpoint.searchParams.get('include_conversation_id')).toBe('true');
    expect(endpoint.searchParams.get('agent_id')).toBe('tutorial');
    expect(init.redirect).toBe('error');
    expect(s.store.recordProviderConversation).toHaveBeenCalledWith(reservation.reservationId, 'attempt-one', 'conv-one');
  });
  it('makes no provider request when admission or the attempt refuses', async () => {
    const s = setup(); read.mockResolvedValueOnce(null);
    expect(await s.issue()).toEqual({ ok: false, reason: 'unavailable' });
    expect(s.store.beginIssuance).not.toHaveBeenCalled(); expect(s.transport).not.toHaveBeenCalled();
    const t = setup(); t.store.beginIssuance.mockResolvedValueOnce(null);
    expect(await t.issue()).toEqual({ ok: false, reason: 'unavailable' }); expect(t.transport).not.toHaveBeenCalled();
  });
  it('retains the trusted receipt when cancellation arrives with the provider response', async () => {
    const s = setup(); s.transport.mockImplementationOnce(async () => {
      s.controller.abort(); return Response.json({ signed_url: signedUrl });
    });
    expect(await s.issue()).toEqual({ ok: false, reason: 'unavailable' });
    expect(s.store.recordProviderConversation).toHaveBeenCalledOnce();
  });
  it('refuses delivery on failed persistence and never retries a lost remote response', async () => {
    const s = setup(); s.store.recordProviderConversation.mockResolvedValueOnce(false);
    expect(await s.issue()).toEqual({ ok: false, reason: 'unavailable' });
    const t = setup(); t.transport.mockRejectedValueOnce(new Error('synthetic transport failure'));
    expect(await t.issue()).toEqual({ ok: false, reason: 'unavailable' });
    expect(t.transport).toHaveBeenCalledOnce(); expect(t.store.recordProviderConversation).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3])('honors kill-switch transition at check %i without losing remote exposure', async check => {
    const s = setup();
    let calls = 0;
    s.disabled.mockImplementation(async () => ++calls === check);
    expect(await s.issue()).toEqual({ ok: false, reason: 'disabled' });
    expect(s.store.reserve).toHaveBeenCalledTimes(check === 1 ? 0 : 1);
    expect(s.store.beginIssuance).toHaveBeenCalledTimes(check === 3 ? 1 : 0);
    expect(s.transport).toHaveBeenCalledTimes(check === 3 ? 1 : 0);
    expect(s.store.recordProviderConversation).toHaveBeenCalledTimes(check === 3 ? 1 : 0);
  });
  it('does not reserve or attempt provider issuance for an already cancelled request', async () => {
    const s = setup(); s.controller.abort();
    expect(await s.issue()).toEqual({ ok: false, reason: 'unavailable' });
    expect(s.events).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
  it.each(['response', 'receipt', 'kill-switch'] as const)(
    'retains remote identity but never delivers a URL expired during %s', async stage => {
      let now = 1_800_000_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const s = setup();
      const expire = () => { now += 15 * 60 * 1000; };
      if (stage === 'response') s.transport.mockImplementationOnce(async () => {
        expire(); return Response.json({ signed_url: signedUrl });
      });
      if (stage === 'receipt') s.store.recordProviderConversation.mockImplementationOnce(async () => {
        expire(); return true;
      });
      if (stage === 'kill-switch') {
        let calls = 0;
        s.disabled.mockImplementation(async () => { if (++calls === 3) expire(); return false; });
      }
      expect(await s.issue()).toEqual({ ok: false, reason: 'unavailable' });
      expect(s.transport).toHaveBeenCalledOnce();
      expect(s.store.recordProviderConversation).toHaveBeenCalledWith(reservation.reservationId, 'attempt-one', 'conv-one');
    });
  it.each([
    signedUrl.replace('api.elevenlabs.io', 'untrusted.test'),
    signedUrl.replace('agent_id=tutorial', 'agent_id=other'),
    signedUrl.replace('&conversation_id=conv-one', ''),
    signedUrl + '&conversation_id=conv-two',
    signedUrl + '&conversation_signature=other',
  ])('refuses malformed or mismatched trusted receipt %s', async url => {
    const s = setup(); s.transport.mockResolvedValueOnce(Response.json({ signed_url: url }));
    expect(await s.issue()).toEqual({ ok: false, reason: 'unavailable' });
    expect(s.store.recordProviderConversation).not.toHaveBeenCalled();
  });
});
describe('host-owned tutorial provider limits', () => {
  it('rechecks the exact reserved credential and refuses rotation or duration growth', async () => {
    const reservation = { ok: true as const, reservationId: '11111111-1111-4111-8111-111111111111',
      maximumSeconds: 120, providerLimitRef: 'elevenlabs:restricted:tutorial' };
    expect(await readReservedElevenLabsTutorialCredential(reservation, options().credential)).toEqual(admitted);
    for (const changed of [{ ...admitted, keyId: 'rotated' }, { ...admitted, agentId: 'other' },
      { ...admitted, maximumSeconds: 121 }, { ...admitted, maximumSeconds: 0 }, null]) {
      read.mockResolvedValueOnce(changed);
      expect(await readReservedElevenLabsTutorialCredential(reservation, options().credential)).toBeNull();
    }
  });
  it('snapshots the committed reservation and retains cancellation checks after re-admission', async () => {
    const reservation = { ok: true as const, reservationId: '11111111-1111-4111-8111-111111111111',
      maximumSeconds: 120, providerLimitRef: 'elevenlabs:restricted:tutorial' };
    read.mockImplementationOnce(async () => { reservation.maximumSeconds = 999; return { ...admitted, maximumSeconds: 121 }; });
    expect(await readReservedElevenLabsTutorialCredential(reservation, options().credential)).toBeNull();
    const controller = new AbortController(); const policy = options(); policy.credential.signal = controller.signal;
    read.mockImplementationOnce(async () => { controller.abort(); return admitted; });
    expect(await readReservedElevenLabsTutorialCredential(reservation, policy.credential)).toBeNull();
    read.mockClear();
    expect(await readReservedElevenLabsTutorialCredential(reservation, policy.credential)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
  it('freshly admits each reservation and returns no credential', async () => {
    const reader = createElevenLabsTutorialVoiceLimitVerifier(options());
    const result = await verify(reader);
    expect(result).toEqual({ maximumSeconds: 120, providerLimitRef: 'elevenlabs:restricted:tutorial',
      dailySeconds: options().dailySeconds });
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    read.mockResolvedValueOnce(null);
    expect(await verify(reader)).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('snapshots host policy and isolates returned quota mutations', async () => {
    const policy = options(); const reader = createElevenLabsTutorialVoiceLimitVerifier(policy);
    policy.dailySeconds.global = 9999; policy.credential.allowedPermissions.push('write');
    policy.credential.toolIds.push('other'); policy.credential.definition.name = 'changed';
    const first = await verify(reader); first!.dailySeconds.global = 1;
    expect((await verify(reader))?.dailySeconds.global).toBe(1200);
    expect(read.mock.calls[0][0]).toMatchObject({ allowedPermissions: ['convai_read'], toolIds: ['tutorial-help'],
      definition: { name: PAPERCUP_FRONT_AGENT.name } });
  });
  it('refuses cancellation before or during remote admission', async () => {
    const controller = new AbortController(); const policy = options(); policy.credential.signal = controller.signal;
    const reader = createElevenLabsTutorialVoiceLimitVerifier(policy);
    read.mockImplementationOnce(async () => { controller.abort(); return admitted; });
    expect(await verify(reader)).toBeNull();
    expect(await verify(reader)).toBeNull(); expect(read).toHaveBeenCalledTimes(1);
  });
  it('refuses invalid host quotas before provider calls and excessive remote duration', async () => {
    const policy = options(); policy.dailySeconds.user = 0;
    expect(await verify(createElevenLabsTutorialVoiceLimitVerifier(policy))).toBeNull();
    expect(read).not.toHaveBeenCalled();
    const missing = options(); delete (missing.dailySeconds as Partial<typeof missing.dailySeconds>).workspace;
    expect(await verify(createElevenLabsTutorialVoiceLimitVerifier(missing))).toBeNull();
    expect(read).not.toHaveBeenCalled();
    read.mockResolvedValueOnce({ ...admitted, maximumSeconds: 7201 });
    expect(await verify(createElevenLabsTutorialVoiceLimitVerifier(options()))).toBeNull();
  });
});
