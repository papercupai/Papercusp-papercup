import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExtractionAuthError } from '@papercusp/memory';
vi.mock('../agent-chat-stream', () => ({ runAgentChat: vi.fn() }));
import { runAgentChat } from '../agent-chat-stream';
import {
  SessionExtractionLlm,
  applyExtractionGatewayEgress,
  extractStrictJson,
  getSessionExtractionLlm,
  sessionExtractionUsage,
  isSessionExtractionDead,
  markSessionExtractionDead,
  _resetSessionExtractionDeadForTest,
  _resetSessionExtractionUsageForTest,
  _resetSessionProbeCacheForTest,
  type SessionTurnRunner,
} from './session-extraction-llm';

// mem0's OSS telemetry reads this at module load — keep tests offline.
process.env.MEM0_TELEMETRY = 'false';

const EXTRACT_MSGS = [
  { role: 'system', content: 'You are a memory extractor.' },
  { role: 'user', content: '## New Messages\nuser prefers tabs' },
];

function okTurn(text: string): SessionTurnRunner {
  return vi.fn(async () => ({ text, tokensIn: 100, tokensOut: 20, costUsd: 0.0001 }));
}

beforeEach(() => {
  _resetSessionExtractionDeadForTest();
  _resetSessionExtractionUsageForTest();
  _resetSessionProbeCacheForTest();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('extractStrictJson', () => {
  it('passes clean JSON through verbatim', () => {
    expect(extractStrictJson('{"memory":[]}')).toBe('{"memory":[]}');
  });
  it('strips code fences and surrounding prose', () => {
    expect(extractStrictJson('Sure! Here it is:\n```json\n{"a":1}\n```\nHope that helps.')).toBe(
      '{"a":1}',
    );
  });
  it('finds the first balanced object amid noise (braces in strings ok)', () => {
    expect(extractStrictJson('note } stray\n{"s":"has } brace","n":2} trailing')).toBe(
      '{"s":"has } brace","n":2}',
    );
  });
  it('handles arrays', () => {
    expect(extractStrictJson('[1,2,3]')).toBe('[1,2,3]');
  });
  it('returns null for non-JSON', () => {
    expect(extractStrictJson('I could not produce JSON, sorry.')).toBeNull();
    expect(extractStrictJson('')).toBeNull();
  });
});

describe('SessionExtractionLlm.generateResponse — strict JSON (D-005)', () => {
  it('happy path: json_object format returns the canonical JSON string', async () => {
    const runTurn = okTurn('```json\n{"memory":[{"id":"m1","text":"likes tabs"}]}\n```');
    const llm = new SessionExtractionLlm({ runTurn, warn: vi.fn() });
    const out = await llm.generateResponse(EXTRACT_MSGS, { type: 'json_object' });
    expect(out).toBe('{"memory":[{"id":"m1","text":"likes tabs"}]}');
    // The system message rode the system slot, not the user turns.
    expect(runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPromptText: 'You are a memory extractor.',
        messages: [{ role: 'user', content: '## New Messages\nuser prefers tabs' }],
      }),
    );
  });

  it('telemetry fields accumulate per call', async () => {
    const llm = new SessionExtractionLlm({ runTurn: okTurn('{"memory":[]}'), warn: vi.fn() });
    await llm.generateResponse(EXTRACT_MSGS, { type: 'json_object' });
    await llm.generateResponse(EXTRACT_MSGS, { type: 'json_object' });
    const u = sessionExtractionUsage();
    expect(u.calls).toBe(2);
    expect(u.tokensIn).toBe(200);
    expect(u.tokensOut).toBe(40);
    expect(u.costUsd).toBeCloseTo(0.0002);
    expect(u.failures).toBe(0);
    expect(u.model).toBeTruthy();
  });

  it('malformed output → ONE repair retry with a JSON-only nudge → success', async () => {
    const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const runTurn: SessionTurnRunner = vi.fn(async (args) => {
      calls.push(args);
      return calls.length === 1
        ? { text: 'Sorry, here are the facts in prose.', tokensIn: 10, tokensOut: 5, costUsd: 0 }
        : { text: '{"memory":[]}', tokensIn: 10, tokensOut: 5, costUsd: 0 };
    });
    const warn = vi.fn();
    const llm = new SessionExtractionLlm({ runTurn, warn });
    const out = await llm.generateResponse(EXTRACT_MSGS, { type: 'json_object' });
    expect(out).toBe('{"memory":[]}');
    expect(runTurn).toHaveBeenCalledTimes(2);
    // The repair turn carries the bad reply + the nudge.
    const repairMsgs = calls[1].messages;
    expect(repairMsgs.at(-1)?.content).toMatch(/ONLY the JSON/);
    expect(repairMsgs.at(-2)?.role).toBe('assistant');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('repair'));
    expect(sessionExtractionUsage().jsonRepairs).toBe(1);
  });

  it('malformed twice → throws to the cascade (never hands mem0 garbage)', async () => {
    const llm = new SessionExtractionLlm({ runTurn: okTurn('still prose, no json'), warn: vi.fn() });
    await expect(llm.generateResponse(EXTRACT_MSGS, { type: 'json_object' })).rejects.toThrow(
      /non-JSON/,
    );
    expect(sessionExtractionUsage().failures).toBe(1);
  });

  it('no responseFormat → raw text passthrough (no JSON enforcement)', async () => {
    const llm = new SessionExtractionLlm({ runTurn: okTurn('plain prose answer'), warn: vi.fn() });
    await expect(llm.generateResponse(EXTRACT_MSGS)).resolves.toBe('plain prose answer');
  });

  it('tool calls are refused (mem0 additive extraction never sends them)', async () => {
    const llm = new SessionExtractionLlm({ runTurn: okTurn('{}'), warn: vi.fn() });
    await expect(
      llm.generateResponse(EXTRACT_MSGS, { type: 'json_object' }, [{ name: 't' }]),
    ).rejects.toThrow(/tool/);
  });

  it('generateChat returns assistant content', async () => {
    const llm = new SessionExtractionLlm({ runTurn: okTurn('hello'), warn: vi.fn() });
    await expect(llm.generateChat(EXTRACT_MSGS)).resolves.toEqual({
      content: 'hello',
      role: 'assistant',
    });
  });

  it('default runner preserves only bounded transport and turn diagnostics on extraction failure', async () => {
    const rawTransportDiagnostic = {
      status: 404,
      providerRequestId: 'req.123',
      label: 'anthropic-direct',
      transportFailureCode: 'UND_ERR_HEADERS_TIMEOUT',
      url: 'https://provider.invalid/private-path',
      headers: { authorization: 'Bearer secret-token' },
      body: 'private provider response',
      account: 'private-account',
    };
    vi.mocked(runAgentChat).mockImplementation(async function* (options) {
      options.onTransportDiagnostic?.(rawTransportDiagnostic as never);
      yield {
        type: 'error',
        message: '404 status code (no body)',
        turn: { provider: 'anthropic', class: 'permanent' },
      } as never;
    });

    const llm = new SessionExtractionLlm({ warn: vi.fn() });
    let failure: unknown;
    try {
      await llm.generateResponse(EXTRACT_MSGS, { type: 'json_object' });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      message: '404 status code (no body)',
      diagnostics: {
        status: 404,
        requestId: 'req.123',
        type: 'anthropic',
        classification: 'permanent',
        transport: 'anthropic-direct',
        transportFailureCode: 'UND_ERR_HEADERS_TIMEOUT',
      },
    });
    const diagnostics = (failure as Error & { diagnostics: Record<string, unknown> }).diagnostics;
    expect(Object.keys(diagnostics).sort()).toEqual([
      'classification', 'requestId', 'status', 'transport', 'transportFailureCode', 'type',
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain('secret-token');
    expect(JSON.stringify(diagnostics)).not.toContain('private provider response');
  });
});

describe('SessionExtractionLlm — 401-driven OAuth refresh (P-004/D-004)', () => {
  const AUTH_ERR = 'anthropic-direct error: 401 {"type":"error","error":{"type":"authentication_error"}}';

  it('401 → invalidate cache → re-read → retry once → success', async () => {
    let attempts = 0;
    const runTurn: SessionTurnRunner = vi.fn(async () => {
      if (attempts++ === 0) throw new Error(AUTH_ERR);
      return { text: '{"memory":[]}', tokensIn: 5, tokensOut: 2, costUsd: 0 };
    });
    const invalidateTokenCache = vi.fn();
    const markDead = vi.fn();
    const warn = vi.fn();
    const llm = new SessionExtractionLlm({ runTurn, invalidateTokenCache, markDead, warn });

    const out = await llm.generateResponse(EXTRACT_MSGS, { type: 'json_object' });
    expect(out).toBe('{"memory":[]}');
    expect(invalidateTokenCache).toHaveBeenCalledTimes(1);
    expect(markDead).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('retrying once'));
    expect(sessionExtractionUsage().authRetries).toBe(1);
  });

  it('persistent 401 → marks the rung dead + throws ExtractionAuthError', async () => {
    const runTurn: SessionTurnRunner = vi.fn(async () => {
      throw new Error(AUTH_ERR);
    });
    const invalidateTokenCache = vi.fn();
    const markDead = vi.fn();
    const llm = new SessionExtractionLlm({ runTurn, invalidateTokenCache, markDead, warn: vi.fn() });

    await expect(llm.generateResponse(EXTRACT_MSGS, { type: 'json_object' })).rejects.toThrow(
      ExtractionAuthError,
    );
    expect(invalidateTokenCache).toHaveBeenCalledTimes(1); // once per protocol, not per attempt
    expect(markDead).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledTimes(2); // original + the single retry
  });

  it('non-auth failure → rethrown untouched, no cache invalidation', async () => {
    const runTurn: SessionTurnRunner = vi.fn(async () => {
      throw new Error('anthropic-direct error: 529 overloaded, exhausted retries');
    });
    const invalidateTokenCache = vi.fn();
    const llm = new SessionExtractionLlm({ runTurn, invalidateTokenCache, warn: vi.fn() });
    await expect(llm.generateResponse(EXTRACT_MSGS, { type: 'json_object' })).rejects.toThrow(
      /529/,
    );
    expect(invalidateTokenCache).not.toHaveBeenCalled();
  });
});

describe('getSessionExtractionLlm — the probe-gated factory (P-003)', () => {
  it('resolves the adapter when a token is present and the probe passes', async () => {
    const llm = await getSessionExtractionLlm({
      readToken: () => 'oauth-token-ok',
      probe: async () => true,
    });
    expect(llm).toBeInstanceOf(SessionExtractionLlm);
  });

  it('no Claude session → null (silent; the shipped-product case)', async () => {
    await expect(
      getSessionExtractionLlm({ readToken: () => null, probe: async () => true }),
    ).resolves.toBeNull();
  });

  it('probe auth-rejects → null (key rungs unchanged) + a loud once-warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        getSessionExtractionLlm({ readToken: () => 'oauth-stale', probe: async () => false }),
      ).resolves.toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('auth-rejected'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('PAPERCUSP_MEM0_SESSION_EXTRACTION=0 escape hatch → null', async () => {
    vi.stubEnv('PAPERCUSP_MEM0_SESSION_EXTRACTION', '0');
    await expect(
      getSessionExtractionLlm({ readToken: () => 'oauth-token-ok', probe: async () => true }),
    ).resolves.toBeNull();
  });

  it('rung marked dead earlier this process → null until next boot', async () => {
    markSessionExtractionDead();
    expect(isSessionExtractionDead()).toBe(true);
    await expect(
      getSessionExtractionLlm({ readToken: () => 'oauth-token-ok', probe: async () => true }),
    ).resolves.toBeNull();
  });

  it('applies the gateway-egress seam BEFORE resolving (so the fallback key rung is pooled too)', async () => {
    const ensureGatewayEgress = vi.fn(async () => {});
    // Session disabled: still must run the egress seam first (it precedes the
    // escape-hatch early-return), because the fallback key rung egresses too.
    vi.stubEnv('PAPERCUSP_MEM0_SESSION_EXTRACTION', '0');
    await getSessionExtractionLlm({ readToken: () => 'oauth-token-ok', probe: async () => true, ensureGatewayEgress });
    expect(ensureGatewayEgress).toHaveBeenCalledTimes(1);
  });
});

describe('applyExtractionGatewayEgress — anthropic-direct extraction egress via the gateway pool (EI-11042)', () => {
  const PATCH = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788', PAPERCUSP_ANTHROPIC_URL: 'http://127.0.0.1:8788' };

  it('flag OFF → sets nothing (unchanged direct egress)', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyExtractionGatewayEgress(false, PATCH, env)).toEqual([]);
    expect(env).toEqual({});
  });

  it('flag ON + unset env → points both egress vars at the gateway', () => {
    const env: NodeJS.ProcessEnv = {};
    const set = applyExtractionGatewayEgress(true, PATCH, env);
    expect(set.sort()).toEqual(['ANTHROPIC_BASE_URL', 'PAPERCUSP_ANTHROPIC_URL']);
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8788');
    expect(env.PAPERCUSP_ANTHROPIC_URL).toBe('http://127.0.0.1:8788');
  });

  it('flag ON but a var is ALREADY set → respects the pre-set override (no-op on it)', () => {
    // The live-operator case: scout/gym already pointed egress at the gateway,
    // so this must be a NO-OP there (zero live-extraction regression).
    const env: NodeJS.ProcessEnv = {
      ANTHROPIC_BASE_URL: 'http://preset.example:9999',
      PAPERCUSP_ANTHROPIC_URL: 'http://preset.example:9999',
    };
    expect(applyExtractionGatewayEgress(true, PATCH, env)).toEqual([]);
    expect(env.ANTHROPIC_BASE_URL).toBe('http://preset.example:9999');
    expect(env.PAPERCUSP_ANTHROPIC_URL).toBe('http://preset.example:9999');
  });

  it('flag ON + only ONE var preset → sets only the unset one', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_BASE_URL: 'http://preset.example:9999' };
    expect(applyExtractionGatewayEgress(true, PATCH, env)).toEqual(['PAPERCUSP_ANTHROPIC_URL']);
    expect(env.ANTHROPIC_BASE_URL).toBe('http://preset.example:9999');
    expect(env.PAPERCUSP_ANTHROPIC_URL).toBe('http://127.0.0.1:8788');
  });
});
