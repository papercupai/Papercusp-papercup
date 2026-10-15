/**
 * LIVE: the ElevenLabs agent sync against the real ElevenLabs API.
 *
 * Plan voice-two-tier-elevenlabs-agent-2026-10-06 — SPEC-P-001 (a create call
 * made with the current key returns an agent id) and SPEC-P-002 (a second sync
 * updates the stored agent instead of creating another), proved on the real
 * path rather than a fake.
 *
 * Why a live test at all: the mocked suite (elevenlabs-agent-sync.test.ts)
 * cannot see API-side rejections. The first real sync failed with
 * `400 voice_not_found` for a voice missing from the account, which no fake
 * reproduced (EI-25260769019608054). This file runs the full cycle once on a
 * throwaway agent and tool — create, read back, update, mint a conversation
 * token — and deletes both afterwards. It never touches the production agent
 * or the stored voice preference.
 *
 * Opt in with PAPERCUSP_ELEVENLABS_LIVE=1 and pass the key as
 * ELEVENLABS_API_KEY (the integration lane's pools may point at a throwaway
 * test database, so the workspace credential store is only a fallback). The key
 * is sent only in the request header and is never logged or asserted on.
 *
 * Run it through the package's test:file wrapper; the inline opt-in reaches
 * the worker through this wrapper chain:
 *   PAPERCUSP_ELEVENLABS_LIVE=1 ELEVENLABS_API_KEY=… PAPERCUSP_TEST_RUN_HARNESS=papercusp \
 *     npm run test:file -- packages/operator-core/lib/voice-engines/elevenlabs-agent-sync.live.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ASK_PAPERCUP_TOOL,
  PAPERCUP_FRONT_AGENT,
  syncElevenLabsAgent,
  type ElevenLabsAgentDefinition,
  type ElevenLabsAgentSyncDeps,
  type ElevenLabsAgentSyncResult,
} from './elevenlabs-agent-sync';

const LIVE = process.env.PAPERCUSP_ELEVENLABS_LIVE === '1';
const CONVAI = 'https://api.elevenlabs.io/v1/convai';
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A throwaway copy of the real definition: same prompt, voice and tool shape, unique names. */
const LIVE_DEF: ElevenLabsAgentDefinition = {
  ...PAPERCUP_FRONT_AGENT,
  name: `Papercup voice live test ${STAMP}`,
  tools: [{ ...ASK_PAPERCUP_TOOL, name: `ask_papercup_livetest_${STAMP}` }],
};

interface RecordedCall {
  method: string;
  url: string;
}

describe.skipIf(!LIVE)('LIVE: ElevenLabs agent sync against the real API', () => {
  let apiKey = '';
  let stored: string | null = null;
  let first: ElevenLabsAgentSyncResult | null = null;
  const calls: RecordedCall[] = [];

  const recordingFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ method: (init?.method ?? 'GET').toUpperCase(), url });
    return fetch(input, init);
  };

  const deps = (): ElevenLabsAgentSyncDeps => ({
    apiKey,
    fetch: recordingFetch,
    readAgentId: async () => stored,
    writeAgentId: async (agentId) => {
      stored = agentId;
    },
    ensureVoice: async (voiceId) => {
      const { ensureVoiceInLibrary } = await import('../conv-voice');
      const r = await ensureVoiceInLibrary(apiKey, voiceId);
      return r.ok ? { ok: true } : r;
    },
  });

  const el = (path: string, init: RequestInit = {}) =>
    fetch(`${CONVAI}${path}`, { ...init, headers: { 'xi-api-key': apiKey, ...(init.headers ?? {}) } });

  beforeAll(async () => {
    const fromEnv = process.env.ELEVENLABS_API_KEY?.trim();
    if (fromEnv) {
      apiKey = fromEnv;
    } else {
      const { readElevenLabsKey } = await import('../voice-credentials');
      apiKey = (await readElevenLabsKey()) ?? '';
    }
    if (!apiKey) throw new Error('PAPERCUSP_ELEVENLABS_LIVE=1 but no ElevenLabs key is configured (set ELEVENLABS_API_KEY)');
  }, 30_000);

  afterAll(async () => {
    if (!apiKey) return;
    // Best-effort cleanup of the throwaway agent and tool; never the production ones.
    if (stored) await el(`/agents/${encodeURIComponent(stored)}`, { method: 'DELETE' }).catch(() => undefined);
    const toolId = first?.toolIds[LIVE_DEF.tools[0]!.name];
    if (toolId) await el(`/tools/${encodeURIComponent(toolId)}`, { method: 'DELETE' }).catch(() => undefined);
  }, 30_000);

  it('creates an agent with the current key and returns an agent id the API can read back (SPEC-P-001)', async () => {
    first = await syncElevenLabsAgent(LIVE_DEF, deps());

    expect(first.action).toBe('created');
    expect(first.createdBecause).toBe('no-stored-id');
    expect(first.agentId).toMatch(/^agent_[A-Za-z0-9]+$/);
    expect(stored).toBe(first.agentId);
    expect(first.toolIds[LIVE_DEF.tools[0]!.name]).toMatch(/^tool_[A-Za-z0-9]+$/);

    const res = await el(`/agents/${encodeURIComponent(first.agentId)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agent_id?: string; name?: string };
    expect(body.agent_id).toBe(first.agentId);
    expect(body.name).toBe(LIVE_DEF.name);
  }, 60_000);

  it('a second sync updates the stored agent and tool instead of creating new ones (SPEC-P-002)', async () => {
    expect(first).not.toBeNull();
    calls.length = 0;

    const second = await syncElevenLabsAgent(LIVE_DEF, deps());

    expect(second.action).toBe('updated');
    expect(second.createdBecause).toBeNull();
    expect(second.agentId).toBe(first!.agentId);
    expect(second.toolIds).toEqual(first!.toolIds);
    expect(stored).toBe(first!.agentId);
    const creates = calls.filter((c) => c.method === 'POST' && /\/(agents\/create|tools)$/.test(new URL(c.url).pathname));
    expect(creates).toEqual([]);
  }, 60_000);

  it('mints a conversation token for the synced agent', async () => {
    expect(first).not.toBeNull();
    const res = await el(`/conversation/token?agent_id=${encodeURIComponent(first!.agentId)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token?: string };
    expect(typeof body.token).toBe('string');
    expect(body.token!.length).toBeGreaterThan(20);
  }, 30_000);
});
