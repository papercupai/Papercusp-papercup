import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../voice-credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../voice-credentials')>();
  return {
    ...actual,
    readElevenLabsKey: vi.fn(async () => 'api_key_id_123'),
    readOpenAiKey: vi.fn(async () => null),
    readCartesiaKey: vi.fn(async () => null),
  };
});
vi.mock('./operator-voice-proxy-helpers', () => ({
  probeKokoroHealth: vi.fn(async () => true),
  probeVoicemodeHealth: vi.fn(async () => false),
}));
vi.mock('../../../voice-node/kokoro-local', () => ({
  isKokoroLocalProvisioned: vi.fn(async () => true),
}));
vi.mock('../../../voice-node/local-voice-provision', () => ({
  getLocalVoiceProvisionStatus: vi.fn(async () => ({
    whisperBinary: { done: true },
    whisperModel: { done: true },
  })),
}));
vi.mock('../../../voice-node/local-whisper-service', () => ({
  warmLocalWhisper: vi.fn(async () => ({ ok: true, source: 'managed' })),
}));

vi.mock('../../../voice-engines/elevenlabs', () => ({
  testElevenLabsConnection: vi.fn(async () => ({ ok: false, error: 'HTTP 401' })),
}));
vi.mock('../../../voice-engines/openai', () => ({
  testOpenAiConnection: vi.fn(async () => ({ ok: true, models: [] })),
}));
vi.mock('../../../voice-engines/cartesia', () => ({
  testCartesiaConnection: vi.fn(async () => ({ ok: true, voicesAvailable: 0 })),
}));

import route, { resetCloudKeyVerdictsForTests } from './operator-voice-engine-health';
import { readCartesiaKey, readElevenLabsKey, readOpenAiKey } from '../../../voice-credentials';
import { testElevenLabsConnection } from '../../../voice-engines/elevenlabs';
import { testOpenAiConnection } from '../../../voice-engines/openai';
import { testCartesiaConnection } from '../../../voice-engines/cartesia';

type Route = { handler: (req: Request, ctx: { params: Record<string, unknown> }) => Promise<Response> };

async function readHealth(): Promise<Record<string, unknown>> {
  const response = await (route as unknown as Route).handler(
    new Request('http://localhost/api/agent-mcp/operator-voice-engine-health'),
    { params: {} },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCloudKeyVerdictsForTests();
});

describe('operator voice engine health — cloud engines are provider-verified (WI-10006372)', () => {
  it('reports a well-formed ElevenLabs key the provider rejects as NOT usable', async () => {
    vi.mocked(readElevenLabsKey).mockResolvedValueOnce('sk_wellformed_but_revoked');

    expect(await readHealth()).toMatchObject({
      elevenlabs: false,
      elevenlabsConfigured: true,
      elevenlabsError: expect.stringMatching(/elevenlabs connection test failed: HTTP 401/),
    });
    expect(testElevenLabsConnection).toHaveBeenCalledWith('sk_wellformed_but_revoked');
  });

  it('reports each cloud engine usable only when its provider accepts the key', async () => {
    vi.mocked(readElevenLabsKey).mockResolvedValueOnce('sk_accepted');
    vi.mocked(testElevenLabsConnection).mockResolvedValueOnce({
      ok: true,
      tier: 'creator',
      characterCount: 0,
      characterLimit: 100,
      email: null,
    });
    vi.mocked(readOpenAiKey).mockResolvedValueOnce('sk-openai-revoked');
    vi.mocked(testOpenAiConnection).mockResolvedValueOnce({ ok: false, error: 'HTTP 401' });
    vi.mocked(readCartesiaKey).mockResolvedValueOnce('cartesia-accepted');

    expect(await readHealth()).toMatchObject({
      elevenlabs: true,
      elevenlabsError: null,
      openai: false,
      openaiConfigured: true,
      openaiError: expect.stringMatching(/openai connection test failed: HTTP 401/),
      cartesia: true,
      cartesiaConfigured: true,
      cartesiaError: null,
    });
    expect(testCartesiaConnection).toHaveBeenCalledWith('cartesia-accepted');
  });

  it('never calls a provider for an absent key and reports that engine unconfigured', async () => {
    expect(await readHealth()).toMatchObject({
      openai: false,
      openaiConfigured: false,
      openaiError: null,
      cartesia: false,
      cartesiaConfigured: false,
      cartesiaError: null,
    });
    expect(testOpenAiConnection).not.toHaveBeenCalled();
    expect(testCartesiaConnection).not.toHaveBeenCalled();
  });

  it('reuses a verdict for the same key within the TTL and re-tests a changed key at once', async () => {
    vi.mocked(readElevenLabsKey)
      .mockResolvedValueOnce('sk_same_key')
      .mockResolvedValueOnce('sk_same_key')
      .mockResolvedValueOnce('sk_rotated_key');

    await readHealth();
    await readHealth();
    expect(testElevenLabsConnection).toHaveBeenCalledTimes(1);

    await readHealth();
    expect(testElevenLabsConnection).toHaveBeenCalledTimes(2);
    expect(testElevenLabsConnection).toHaveBeenLastCalledWith('sk_rotated_key');
  });

  it('re-tests the same key once the cached verdict is older than the TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.mocked(readElevenLabsKey).mockResolvedValue('sk_aging_key');
      await readHealth();
      vi.setSystemTime(Date.now() + 61_000);
      await readHealth();
      expect(testElevenLabsConnection).toHaveBeenCalledTimes(2);
    } finally {
      vi.mocked(readElevenLabsKey).mockImplementation(async () => 'api_key_id_123');
      vi.useRealTimers();
    }
  });
});

describe('operator voice engine health', () => {
  it('keeps local voice healthy while flagging an invalid legacy cloud key', async () => {
    const response = await (route as unknown as Route).handler(
      new Request('http://localhost/api/agent-mcp/operator-voice-engine-health'),
      { params: {} },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kokoro: true,
      voicemode: true,
      localVoice: {
        kokoroProvisioned: true,
        whisperProvisioned: true,
        whisper: { ok: true, source: 'managed' },
      },
      elevenlabs: false,
      elevenlabsConfigured: true,
      elevenlabsError: expect.stringMatching(/begin with sk_/),
    });
    expect(readElevenLabsKey).toHaveBeenCalledWith({ allowInvalid: true });
    // A malformed key is reported by its shape error and never sent to the provider.
    expect(testElevenLabsConnection).not.toHaveBeenCalled();
  });

  it('does not call a provisioned Whisper capability healthy when its endpoint cannot warm', async () => {
    const { warmLocalWhisper } = await import('../../../voice-node/local-whisper-service');
    vi.mocked(warmLocalWhisper).mockResolvedValueOnce({
      ok: false,
      reason: 'unhealthy',
      detail: 'managed endpoint did not answer /health',
    });

    const response = await (route as unknown as Route).handler(
      new Request('http://localhost/api/agent-mcp/operator-voice-engine-health'),
      { params: {} },
    );
    expect(await response.json()).toMatchObject({
      voicemode: false,
      localVoice: {
        whisperProvisioned: true,
        whisper: { ok: false, reason: 'unhealthy' },
      },
    });
  });
});
