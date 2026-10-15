/**
 * P-002 (voice-two-tier-elevenlabs-agent-2026-10-06): the ElevenLabs agent
 * sync converges on the definition, creates the agent when the stored id is
 * missing or gone, never duplicates tools, and never leaks the key.
 */
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { ASK_PAPERCUP_TOOL_NAME, VOICE_BRAIN_TIMEOUT_MS } from '@papercusp/chat-protocol';
import {
  ASK_PAPERCUP_TOOL,
  ElevenLabsAgentSyncError,
  PAPERCUP_FRONT_AGENT,
  buildAgentConfig,
  syncElevenLabsAgent,
  readElevenLabsAgentDuration,
  readElevenLabsImmutableProfile,
  readElevenLabsRestrictedCredential,
  captureElevenLabsCredentialReceipt,
  provisionElevenLabsRestrictedCredential,
  type ElevenLabsAgentSyncDeps,
} from './elevenlabs-agent-sync';

const KEY = 'sk_test_secret_key_value_1234';

describe('authenticated restricted credential provisioning', () => {
  const metadata = { key_id: 'created-key', service_account_user_id: 'service-account',
    is_disabled: false, disable_reason: null, permissions: ['convai_read'], character_limit: 1000, character_count: 0 };
  const options = () => ({ secretRef: 'integration:TUTORIAL_KEY', serviceAccountUserId: 'service-account',
    name: 'Tutorial', metadataApiKey: 'metadata-secret', allowedPermissions: ['convai_read'], maximumCredits: 1000,
    signal: new AbortController().signal, persist: vi.fn(async () => {}),
    fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ 'xi-api-key': KEY, key_id: 'created-key' }))
      .mockResolvedValueOnce(Response.json({ 'api-keys': [metadata] })) });
  it('authenticates creation, verifies restrictions and persists before returning only the id', async () => {
    const opts = options();
    expect(await provisionElevenLabsRestrictedCredential(opts)).toEqual({ keyId: 'created-key' });
    expect(opts.fetch.mock.calls[0]).toEqual(['https://api.elevenlabs.io/v1/service-accounts/service-account/api-keys',
      expect.objectContaining({ method: 'POST', redirect: 'error', headers: {
        'xi-api-key': 'metadata-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Tutorial', permissions: ['convai_read'], character_limit: 1000 }) })]);
    expect(opts.persist).toHaveBeenCalledWith(expect.objectContaining({ apiKey: KEY,
      receipt: expect.objectContaining({ keyId: 'created-key', secretRef: opts.secretRef }) }));
  });
  it('does not persist rejected creation, list metadata, broadened permissions or transport errors', async () => {
    for (const response of [new Response(KEY, { status: 401 }), Response.json(metadata),
      Response.json({ 'xi-api-key': KEY, key_id: 'created-key' })]) {
      const opts = options();
      opts.fetch.mockReset().mockResolvedValueOnce(response).mockResolvedValueOnce(Response.json({
        'api-keys': [{ ...metadata, permissions: ['convai_read', 'convai_write'] }] }));
      expect(await provisionElevenLabsRestrictedCredential(opts)).toBeNull();
      expect(opts.persist).not.toHaveBeenCalled();
    }
    const opts = options(); opts.fetch.mockReset().mockRejectedValue(new Error(KEY));
    expect(await provisionElevenLabsRestrictedCredential(opts)).toBeNull();
    expect(opts.persist).not.toHaveBeenCalled();
  });
  it('refuses invalid policy before POST and snapshots policy during creation', async () => {
    const opts = options();
    expect(await provisionElevenLabsRestrictedCredential({ ...opts, allowedPermissions: ['all'] })).toBeNull();
    expect(opts.fetch).not.toHaveBeenCalled();
    opts.fetch.mockReset().mockImplementationOnce(async () => {
      opts.allowedPermissions.push('convai_write'); opts.maximumCredits = 5000;
      return Response.json({ 'xi-api-key': KEY, key_id: 'created-key' });
    }).mockResolvedValueOnce(Response.json({ 'api-keys': [metadata] }));
    expect(await provisionElevenLabsRestrictedCredential(opts)).toEqual({ keyId: 'created-key' });
    expect(opts.persist).toHaveBeenCalledTimes(1);
  });
  it('refuses cancellation before persistence and hides persistence errors without retrying creation', async () => {
    const opts = options(); const controller = new AbortController();
    opts.signal = controller.signal;
    opts.fetch.mockReset().mockImplementationOnce(async () => { controller.abort();
      return Response.json({ 'xi-api-key': KEY, key_id: 'created-key' }); });
    expect(await provisionElevenLabsRestrictedCredential(opts)).toBeNull();
    expect(opts.persist).not.toHaveBeenCalled();
    const failure = options(); failure.persist.mockRejectedValueOnce(new Error(KEY));
    expect(await provisionElevenLabsRestrictedCredential(failure)).toBeNull();
    expect(failure.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('server provisioning receipt capture', () => {
  const capture = (createResponse: unknown, secretRef = 'integration:TUTORIAL_KEY') =>
    captureElevenLabsCredentialReceipt({ secretRef, serviceAccountUserId: 'service-account', createResponse });
  it('binds the same create response key and id without putting the secret in the receipt', () => {
    const response = { 'xi-api-key': KEY, key_id: 'created-key' };
    const result = capture(response)!;
    expect(result.apiKey).toBe(KEY);
    expect(result.receipt).toEqual({ secretRef: 'integration:TUTORIAL_KEY', keyId: 'created-key',
      serviceAccountUserId: 'service-account', secretSha256: createHash('sha256').update(KEY).digest('hex') });
    expect(JSON.stringify(result.receipt)).not.toContain(KEY);
    response.key_id = 'mutated';
    expect(result.receipt.keyId).toBe('created-key');
  });
  it('refuses list metadata and malformed creation responses instead of inferring a secret', () => {
    for (const response of [null, [], {}, { key_id: 'created-key', hashed_xi_api_key: KEY },
      { 'xi-api-key': KEY }, { 'xi-api-key': '', key_id: 'created-key' },
      { 'xi-api-key': KEY, key_id: ' padded ' }, { 'xi-api-key': KEY + '\n', key_id: 'created-key' }]) {
      expect(capture(response)).toBeNull();
    }
    expect(capture({ 'xi-api-key': KEY, key_id: 'created-key' }, '')).toBeNull();
  });
});

describe('restricted credential creation-receipt binding', () => {
  const receipt = () => ({ secretRef: 'integration:TUTORIAL_KEY', keyId: 'created-key',
    serviceAccountUserId: 'service-account', secretSha256: createHash('sha256').update(KEY).digest('hex') });
  const metadata = () => ({ key_id: 'created-key', service_account_user_id: 'service-account',
    is_disabled: false, disable_reason: null, permissions: ['convai_read'], character_limit: 1000,
    character_count: 0, hashed_xi_api_key: 'opaque-provider-hash' });
  const options = (fetchImpl: typeof fetch) => ({ receipt: receipt(), secretRef: 'integration:TUTORIAL_KEY',
    apiKey: KEY, metadataApiKey: 'metadata-only-secret', allowedPermissions: ['convai_read'],
    maximumCredits: 1000, fetch: fetchImpl, signal: new AbortController().signal });
  const read = (keys: unknown[]) => readElevenLabsRestrictedCredential(options(
    vi.fn<typeof fetch>().mockResolvedValue(Response.json({ 'api-keys': keys }))));

  it('binds live restrictions to the created key and uses only the metadata credential for the read', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ 'api-keys': [metadata()] }));
    expect(await readElevenLabsRestrictedCredential(options(fetchImpl))).toEqual({ keyId: 'created-key',
      serviceAccountUserId: 'service-account', maximumCredits: 1000 });
    expect(fetchImpl.mock.calls[0]).toEqual(['https://api.elevenlabs.io/v1/service-accounts/service-account/api-keys',
      expect.objectContaining({ headers: { 'xi-api-key': 'metadata-only-secret' }, redirect: 'error' })]);
  });
  it('refuses rotated secrets or another reference before any metadata request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const override of [{ apiKey: 'rotated' }, { secretRef: 'integration:OTHER_KEY' },
      { receipt: { ...receipt(), secretSha256: 'opaque-provider-hash' } }]) {
      expect(await readElevenLabsRestrictedCredential({ ...options(fetchImpl), ...override })).toBeNull();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('refuses missing, duplicated, disabled, unrestricted, exhausted and wrong-account metadata', async () => {
    expect(await read([])).toBeNull();
    expect(await read([metadata(), metadata()])).toBeNull();
    for (const change of [{ key_id: 'other' }, { service_account_user_id: 'other' },
      { is_disabled: true }, { is_disabled: undefined }, { disable_reason: 'locked' },
      { permissions: null }, { permissions: ['convai_read', 'convai_write'] },
      { permissions: ['convai_read', 'convai_read'] }, { character_limit: null },
      { character_limit: 1001 }, { character_limit: 0 }, { character_count: 1000 },
      { character_count: -1 }, { character_count: null }]) {
      expect(await read([{ ...metadata(), ...change }]), JSON.stringify(change)).toBeNull();
    }
  });
  it('re-reads revocation every time and suppresses private transport errors', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ 'api-keys': [metadata()] }))
      .mockResolvedValueOnce(Response.json({ 'api-keys': [{ ...metadata(), is_disabled: true }] }))
      .mockRejectedValueOnce(new Error(KEY));
    expect(await readElevenLabsRestrictedCredential(options(fetchImpl))).not.toBeNull();
    expect(await readElevenLabsRestrictedCredential(options(fetchImpl))).toBeNull();
    expect(await readElevenLabsRestrictedCredential(options(fetchImpl))).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('refuses cancellation and does not adopt receipt or policy mutation during a read', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>();
    controller.abort();
    expect(await readElevenLabsRestrictedCredential({ ...options(fetchImpl), signal: controller.signal })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    const opts = options(fetchImpl);
    fetchImpl.mockImplementation(async () => {
      opts.receipt.keyId = 'other'; opts.maximumCredits = 5000; opts.allowedPermissions.push('convai_write');
      return Response.json({ 'api-keys': [{ ...metadata(), key_id: 'other', character_limit: 5000,
        permissions: ['convai_read', 'convai_write'] }] });
    });
    expect(await readElevenLabsRestrictedCredential(opts)).toBeNull();
  });
});

describe('provider duration evidence for tutorial admission', () => {
  const valid = () => ({ agent_id: 'tutorial', conversation_config: { conversation: { max_duration_seconds: 60 } },
    platform_settings: { auth: { enable_auth: true, allowlist: [], shareable_token: null } } });
  const read = (fetchImpl: typeof fetch, signal = new AbortController().signal, maximum = 180) =>
    readElevenLabsAgentDuration({ maxDurationSeconds: maximum }, { apiKey: KEY, agentId: 'tutorial', fetch: fetchImpl, signal });

  it('reads the current bound with the issuance key, no redirects, and no cache', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(valid()))
      .mockResolvedValueOnce(Response.json({ ...valid(), conversation_config: { conversation: { max_duration_seconds: 600 } } }));
    expect(await read(fetchImpl)).toEqual({ agentId: 'tutorial', maximumSeconds: 60 });
    expect(await read(fetchImpl)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.elevenlabs.io/v1/convai/agents/tutorial');
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ headers: { 'xi-api-key': KEY }, redirect: 'error' });
  });

  it.each([0, -1, 1.5, 181, '60', null])('refuses an unverified provider duration %s', async duration => {
    const body = valid();
    const response = { ...body, conversation_config: { conversation: { max_duration_seconds: duration } } };
    expect(await read(vi.fn<typeof fetch>().mockResolvedValue(Response.json(response)))).toBeNull();
  });

  it.each([
    { enable_auth: false, allowlist: [] }, { enable_auth: true },
    { enable_auth: true, allowlist: [{ hostname: 'example.com' }] },
    { enable_auth: true, allowlist: [], shareable_token: 'public-token' },
  ])('refuses public or conflicting authentication %#', async auth => {
    expect(await read(vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...valid(), platform_settings: { auth } })))).toBeNull();
  });

  it('refuses another agent, malformed JSON and unsuccessful or leaking transport responses', async () => {
    for (const response of [Response.json({ ...valid(), agent_id: 'other' }),
      new Response('{'), Response.json({ detail: KEY }, { status: 403 })]) {
      expect(await read(vi.fn<typeof fetch>().mockResolvedValue(response))).toBeNull();
    }
    expect(await read(vi.fn<typeof fetch>().mockRejectedValue(new Error(KEY)))).toBeNull();
  });

  it('refuses cancellation before and during the read, and invalid configured bounds', async () => {
    const abort = new AbortController();
    abort.abort();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(valid()));
    expect(await read(fetchImpl, abort.signal)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await read(fetchImpl, undefined, 0)).toBeNull();
    const during = new AbortController();
    expect(await read(vi.fn<typeof fetch>().mockImplementation(async () => {
      during.abort(); return Response.json(valid());
    }), during.signal)).toBeNull();
  });

  it('requires explicit provider immutability for a tutorial definition on every read', async () => {
    const response = () => ({ ...valid(), platform_settings: {
      ...(buildAgentConfig({ ...PAPERCUP_FRONT_AGENT, allowSessionOverrides: false }, []).platform_settings as object),
      auth: valid().platform_settings.auth } });
    const readImmutable = (payload: unknown) => readElevenLabsAgentDuration(
      { maxDurationSeconds: 180, allowSessionOverrides: false },
      { apiKey: KEY, agentId: 'tutorial', fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload)),
        signal: new AbortController().signal });
    expect(await readImmutable(response())).toEqual({ agentId: 'tutorial', maximumSeconds: 60 });
    expect(await readImmutable(valid())).toBeNull();
    for (const path of [['agent', 'prompt', 'prompt'], ['agent', 'first_message'],
      ['agent', 'language'], ['tts', 'voice_id']]) {
      for (const value of [true, undefined, 'false', null]) {
        const payload = response();
        const switches = (payload.platform_settings as any).overrides.conversation_config_override;
        let target = switches;
        for (const part of path.slice(0, -1)) target = target[part!];
        target[path.at(-1)!] = value;
        expect(await readImmutable(payload)).toBeNull();
      }
    }
  });
});

interface FakeOpts { failToolCreate?: boolean; failAgentPatch?: number }

describe('immutable provider profile evidence', () => {
  const definition = { ...PAPERCUP_FRONT_AGENT, allowSessionOverrides: false };
  const profile = () => ({ ...buildAgentConfig(definition, ['trusted-tool']), agent_id: 'tutorial',
    platform_settings: { ...(buildAgentConfig(definition, []).platform_settings as object),
      auth: { enable_auth: true, allowlist: [], shareable_token: null } } });
  const read = (body: unknown, tool: unknown = { id: 'trusted-tool', tool_config: ASK_PAPERCUP_TOOL }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(body))
      .mockResolvedValueOnce(Response.json(tool));
    return readElevenLabsImmutableProfile(definition, ['trusted-tool'], {
      apiKey: KEY, agentId: 'tutorial', fetch: fetchImpl, signal: new AbortController().signal });
  };
  it('accepts the current definition and exact tool from its trusted sync receipt', async () => {
    expect(await read(profile())).toEqual({ agentId: 'tutorial', maximumSeconds: 1800 });
  });
  it('does not let policy mutation during a provider read authorize drift', async () => {
    const owned = structuredClone(definition);
    const ids = ['trusted-tool'];
    const body: any = profile();
    body.conversation_config.agent.prompt.prompt = 'unreviewed prompt';
    body.conversation_config.agent.prompt.tool_ids = ['unreviewed-tool'];
    body.conversation_config.tts.voice_id = 'unreviewed-voice';
    const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      owned.prompt = 'unreviewed prompt';
      owned.tts.voiceId = 'unreviewed-voice';
      ids[0] = 'unreviewed-tool';
      return Response.json(body);
    });
    expect(await readElevenLabsImmutableProfile(owned, ids, {
      apiKey: KEY, agentId: 'tutorial', fetch: fetchImpl, signal: new AbortController().signal,
    })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('refuses independent prompt, tool, voice and alternate workflow drift', async () => {
    const paths = [['conversation_config', 'agent', 'prompt', 'prompt'],
      ['conversation_config', 'agent', 'first_message'], ['conversation_config', 'agent', 'language'],
      ['conversation_config', 'agent', 'prompt', 'tool_ids'],
      ['conversation_config', 'agent', 'prompt', 'tools'],
      ['conversation_config', 'agent', 'prompt', 'knowledge_base'],
      ...['voice_id', 'model_id', 'stability', 'similarity_boost', 'speed'].map(key => ['conversation_config', 'tts', key]),
      ['workflow'], ['conversation_config', 'language_presets']];
    for (const path of paths) {
      const body: any = profile();
      let target = body;
      for (const key of path.slice(0, -1)) target = target[key!];
      target[path.at(-1)!] = 'changed';
      expect(await read(body), path.join('.')).toBeNull();
    }
    expect(await read(profile(), { id: 'other', tool_config: ASK_PAPERCUP_TOOL })).toBeNull();
    expect(await read(profile(), { id: 'trusted-tool', tool_config: { ...ASK_PAPERCUP_TOOL, type: 'webhook' } })).toBeNull();
    expect(await read(profile(), { id: 'trusted-tool', tool_config: { ...ASK_PAPERCUP_TOOL, unreviewed: true } })).toBeNull();
  });
});

/** In-memory ElevenLabs ConvAI API covering the endpoints the sync uses. */
function fakeElevenLabs(opts: FakeOpts = {}) {
  const tools = new Map<string, { id: string; tool_config: { name: string } & Record<string, unknown> }>();
  const agents = new Map<string, Record<string, unknown>>();
  const calls: Array<{ method: string; path: string; key: string | null }> = [];
  let seq = 0;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const path = url.pathname.replace('/v1/convai', '');
    calls.push({ method, path, key: headers.get('xi-api-key') });
    if (headers.get('xi-api-key') !== KEY) return json(401, { detail: 'invalid key' });
    const body = init?.body ? JSON.parse(String(init.body)) : null;

    if (path === '/tools' && method === 'GET') return json(200, { tools: [...tools.values()] });
    if (path === '/tools' && method === 'POST') {
      if (opts.failToolCreate) return json(500, { detail: 'tool create exploded' });
      const id = `tool_${++seq}`;
      tools.set(id, { id, tool_config: body.tool_config });
      return json(200, { id });
    }
    const toolMatch = path.match(/^\/tools\/(.+)$/);
    if (toolMatch && method === 'PATCH') {
      const t = tools.get(toolMatch[1]!);
      if (!t) return json(404, { detail: 'tool not found' });
      t.tool_config = body.tool_config;
      return json(200, t);
    }
    if (path === '/agents/create' && method === 'POST') {
      const id = `agent_${++seq}`;
      agents.set(id, body);
      return json(200, { agent_id: id });
    }
    const agentMatch = path.match(/^\/agents\/(.+)$/);
    if (agentMatch && method === 'PATCH') {
      if (opts.failAgentPatch) return json(opts.failAgentPatch, { detail: 'agent patch refused' });
      if (!agents.has(agentMatch[1]!)) return json(404, { detail: { status: 'document_not_found' } });
      agents.set(agentMatch[1]!, body);
      return json(200, { agent_id: agentMatch[1] });
    }
    return json(400, { detail: `unhandled ${method} ${path}` });
  }) as typeof fetch;

  return { fetchImpl, tools, agents, calls };
}

function deps(fake: ReturnType<typeof fakeElevenLabs>, initialId: string | null) {
  const store = { id: initialId, writes: 0 };
  const d: ElevenLabsAgentSyncDeps = {
    apiKey: KEY,
    fetch: fake.fetchImpl,
    readAgentId: async () => store.id,
    writeAgentId: async (id) => { store.id = id; store.writes += 1; },
  };
  return { d, store };
}

describe('syncElevenLabsAgent', () => {
  it('creates the tool and the agent when no agent id is stored, and saves the new id', async () => {
    const fake = fakeElevenLabs();
    const { d, store } = deps(fake, null);
    const r = await syncElevenLabsAgent(PAPERCUP_FRONT_AGENT, d);

    expect(r.action).toBe('created');
    expect(r.createdBecause).toBe('no-stored-id');
    expect(store.id).toBe(r.agentId);
    expect(store.writes).toBe(1);
    expect(fake.agents.size).toBe(1);
    expect(fake.tools.size).toBe(1);
    const agent = fake.agents.get(r.agentId)! as { conversation_config: { agent: { prompt: { tool_ids: string[]; prompt: string } } } };
    expect(agent.conversation_config.agent.prompt.tool_ids).toEqual([r.toolIds.ask_papercup]);
    expect(agent.conversation_config.agent.prompt.prompt).toContain('ask_papercup');
  });

  it('is idempotent: a second run updates the same agent and tool instead of creating new ones', async () => {
    const fake = fakeElevenLabs();
    const { d, store } = deps(fake, null);
    const first = await syncElevenLabsAgent(PAPERCUP_FRONT_AGENT, d);
    const second = await syncElevenLabsAgent(PAPERCUP_FRONT_AGENT, d);

    expect(second.action).toBe('updated');
    expect(second.agentId).toBe(first.agentId);
    expect(second.toolIds).toEqual(first.toolIds);
    expect(fake.agents.size).toBe(1);
    expect(fake.tools.size).toBe(1);
    expect(store.writes).toBe(1);
    expect(fake.calls.filter((c) => c.path === '/agents/create')).toHaveLength(1);
  });

  it('creates a replacement agent when the stored id no longer exists (404), and saves the new id', async () => {
    const fake = fakeElevenLabs();
    const { d, store } = deps(fake, 'agent_deleted_long_ago');
    const r = await syncElevenLabsAgent(PAPERCUP_FRONT_AGENT, d);

    expect(r.action).toBe('created');
    expect(r.createdBecause).toBe('stored-id-not-found');
    expect(r.agentId).not.toBe('agent_deleted_long_ago');
    expect(store.id).toBe(r.agentId);
  });

  it('does not create a new agent or overwrite the stored id when the update fails for another reason', async () => {
    const fake = fakeElevenLabs({ failAgentPatch: 422 });
    const { d, store } = deps(fake, 'agent_existing');
    await expect(syncElevenLabsAgent(PAPERCUP_FRONT_AGENT, d)).rejects.toMatchObject({ step: 'update-agent', status: 422 });
    expect(fake.calls.some((c) => c.path === '/agents/create')).toBe(false);
    expect(store.id).toBe('agent_existing');
    expect(store.writes).toBe(0);
  });

  it('never touches the agent when a tool fails to register', async () => {
    const fake = fakeElevenLabs({ failToolCreate: true });
    const { d, store } = deps(fake, null);
    const err = await syncElevenLabsAgent(PAPERCUP_FRONT_AGENT, d).catch((e) => e);
    expect(err).toBeInstanceOf(ElevenLabsAgentSyncError);
    expect(err.step).toBe('create-tool:ask_papercup');
    expect(fake.calls.some((c) => c.path.startsWith('/agents'))).toBe(false);
    expect(store.writes).toBe(0);
  });

  it('checks the agent voice before any agent write and stops when the voice is unavailable', async () => {
    const fake = fakeElevenLabs();
    const { d, store } = deps(fake, null);
    const asked: string[] = [];
    d.ensureVoice = async (voiceId) => { asked.push(voiceId); return { ok: false, status: 404, error: 'voice not in library' }; };
    await expect(syncElevenLabsAgent(PAPERCUP_FRONT_AGENT, d)).rejects.toMatchObject({ step: 'ensure-voice', status: 404 });
    expect(asked).toEqual([PAPERCUP_FRONT_AGENT.tts.voiceId]);
    expect(fake.calls.some((c) => c.path.startsWith('/agents'))).toBe(false);
    expect(store.writes).toBe(0);

    d.ensureVoice = async () => ({ ok: true });
    const r = await syncElevenLabsAgent(PAPERCUP_FRONT_AGENT, d);
    expect(r.action).toBe('created');
  });

  it('sends the key only in the request header and never returns or reports it', async () => {
    const fake = fakeElevenLabs({ failAgentPatch: 500 });
    const { d } = deps(fake, null);
    const ok = await syncElevenLabsAgent(PAPERCUP_FRONT_AGENT, d);
    expect(JSON.stringify(ok)).not.toContain(KEY);
    expect(fake.calls.every((c) => c.key === KEY)).toBe(true);

    const { d: d2 } = deps(fake, ok.agentId);
    const err = await syncElevenLabsAgent(PAPERCUP_FRONT_AGENT, d2).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(KEY);
  });
});

describe('buildAgentConfig', () => {
  it('persists an immutable tutorial profile through the actual agent sync', async () => {
    const fake = fakeElevenLabs();
    const { d } = deps(fake, null);
    const result = await syncElevenLabsAgent({ ...PAPERCUP_FRONT_AGENT,
      name: 'Papercup tutorial', allowSessionOverrides: false, maxDurationSeconds: 180,
    }, d);
    const agent = fake.agents.get(result.agentId)! as {
      platform_settings: { overrides: { conversation_config_override: Record<string, unknown> } };
      conversation_config: { conversation: { max_duration_seconds: number } };
    };
    expect(agent.platform_settings.overrides.conversation_config_override).toEqual({
      agent: { prompt: { prompt: false }, first_message: false, language: false },
      tts: { voice_id: false },
    });
    expect(agent.conversation_config.conversation.max_duration_seconds).toBe(180);
  });
  it('attaches tools by id only and lets sessions override the prompt and first message but not tools or voice', () => {
    const cfg = buildAgentConfig(PAPERCUP_FRONT_AGENT, ['tool_x']) as {
      conversation_config: { agent: { prompt: Record<string, unknown> }; conversation: { max_duration_seconds: number } };
      platform_settings: { overrides: { conversation_config_override: { agent: { prompt: Record<string, unknown>; first_message: boolean }; tts: { voice_id: boolean } } } };
    };
    expect(cfg.conversation_config.agent.prompt.tool_ids).toEqual(['tool_x']);
    expect(cfg.conversation_config.agent.prompt).not.toHaveProperty('tools');
    expect(cfg.conversation_config.conversation.max_duration_seconds).toBe(PAPERCUP_FRONT_AGENT.maxDurationSeconds);
    const ovr = cfg.platform_settings.overrides.conversation_config_override;
    expect(ovr.agent.prompt.prompt).toBe(true);
    expect(ovr.agent.prompt).not.toHaveProperty('tool_ids', true);
    expect(ovr.agent.first_message).toBe(true);
    expect(ovr.tts.voice_id).toBe(false);
  });

  it('defines ask_papercup as a client tool that takes the question, forces a holding line, and outwaits the client deadline', () => {
    expect(ASK_PAPERCUP_TOOL.type).toBe('client');
    expect(ASK_PAPERCUP_TOOL.name).toBe(ASK_PAPERCUP_TOOL_NAME);
    expect(ASK_PAPERCUP_TOOL.expects_response).toBe(true);
    expect(ASK_PAPERCUP_TOOL.parameters.required).toEqual(['question']);
    expect(ASK_PAPERCUP_TOOL.pre_tool_speech).toBe('force');
    // ElevenLabs must not time out before the client returns its own spoken failure line.
    expect(ASK_PAPERCUP_TOOL.response_timeout_secs * 1000).toBeGreaterThan(VOICE_BRAIN_TIMEOUT_MS);
    // ElevenLabs accepts client-tool timeouts up to at least 60 s (measured live 2026-10-06).
    expect(ASK_PAPERCUP_TOOL.response_timeout_secs).toBeLessThanOrEqual(60);
  });
});
