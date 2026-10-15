/**
 * resolvePapercupChatModel — the chat papercup role's quick-model pin ladder
 * (papercup-chat-one-component-one-contract-2026-09-06 P-005, D-007 §3).
 * Pure: env/config injected.
 */
import { describe, expect, it, vi } from 'vitest';
import { PAPERCUP_CHAT_MODEL_PIN } from '../agent-config-constants';
import { classifyChatModelFailure } from '../chat-model-failure';
import { papercupChatFailover, resolvePapercupChatModel } from './papercup-chat-model';

describe('resolvePapercupChatModel', () => {
  it('pins gpt-5.6-luna:low ON codex when nothing overrides (backend travels with the pin)', () => {
    const r = resolvePapercupChatModel({ env: {}, config: { models: {}, roleBackends: {} }, fallbackBackend: 'claude-code' });
    expect(r).toEqual({ model: 'gpt-5.6-luna:low', backend: 'codex', modelSource: 'pin', backendSource: 'pin' });
    expect(PAPERCUP_CHAT_MODEL_PIN).toEqual({ model: 'gpt-5.6-luna:low', backend: 'codex' });
  });

  it('a PG-unreachable config (null) still resolves the pin', () => {
    const r = resolvePapercupChatModel({ env: {}, config: null });
    expect(r.model).toBe('gpt-5.6-luna:low');
    expect(r.backend).toBe('codex');
  });

  it('env PAPERCUP_CHAT_MODEL wins over agent-config models.papercup, which wins over the pin', () => {
    const cfg = { models: { papercup: 'sonnet[1m]:high' }, roleBackends: {} };
    expect(resolvePapercupChatModel({ env: {}, config: cfg }).modelSource).toBe('agent-config');
    expect(resolvePapercupChatModel({ env: {}, config: cfg }).model).toBe('sonnet[1m]:high');
    const r = resolvePapercupChatModel({ env: { PAPERCUP_CHAT_MODEL: ' opus:high ' }, config: cfg });
    expect(r.model).toBe('opus:high');
    expect(r.modelSource).toBe('env');
  });

  it('an INFORMED model override does NOT drag the codex pin along — it runs on the operator surface backend', () => {
    // WI-4623 in reverse: an owner who sets a Claude model must not have it
    // handed to the codex CLI just because the pin's backend was codex.
    const r = resolvePapercupChatModel({
      env: { PAPERCUP_CHAT_MODEL: 'sonnet[1m]:high' },
      config: { models: {}, roleBackends: {} },
      fallbackBackend: 'claude-code',
    });
    expect(r.backend).toBe('claude-code');
    expect(r.backendSource).toBe('surface');
    // ...and inherits the process-global backend when there is no surface override.
    const inherit = resolvePapercupChatModel({ env: { PAPERCUP_CHAT_MODEL: 'sonnet[1m]:high' }, config: null });
    expect(inherit.backend).toBeUndefined();
    expect(inherit.backendSource).toBe('inherit');
  });

  it('env PAPERCUP_CHAT_BACKEND > agent-config roleBackends.papercup > pin; an unknown backend is ignored', () => {
    const cfg = { models: {}, roleBackends: { papercup: 'omp' as const } };
    expect(resolvePapercupChatModel({ env: {}, config: cfg }).backend).toBe('omp');
    expect(resolvePapercupChatModel({ env: {}, config: cfg }).backendSource).toBe('agent-config');
    const env = resolvePapercupChatModel({ env: { PAPERCUP_CHAT_BACKEND: 'claude-code' }, config: cfg });
    expect(env.backend).toBe('claude-code');
    expect(env.backendSource).toBe('env');
    const bogus = resolvePapercupChatModel({ env: { PAPERCUP_CHAT_BACKEND: 'gemini' }, config: { models: {}, roleBackends: {} } });
    expect(bogus.backend).toBe('codex');
    expect(bogus.backendSource).toBe('pin');
  });
});

// WI-10003608: the failures measured on hosted workspace avi-test, verbatim in shape.
const NOW = Date.UTC(2026, 8, 28, 6, 0, 0);
const CODEX_CAP =
  'codex exited 1: You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase ' +
  'more credits or try again at Oct 3rd, 2026 5:30 PM.';
const CLAUDE_REVOKED =
  'claude-code exited 1: API Error: 401 {"type":"error","error":{"type":"authentication_error",' +
  '"message":"OAuth access token has been revoked."}}';
const CODEX_RATE = 'codex exited 1: 429 Too Many Requests — retry after 30s';

describe('papercupChatFailover (WI-10003608)', () => {
  it('fixtures classify as the classes they stand for (calibration)', () => {
    expect(classifyChatModelFailure(CODEX_CAP, NOW)?.code).toBe('model_usage_limited');
    expect(classifyChatModelFailure(CLAUDE_REVOKED, NOW)?.code).toBe('model_auth_required');
    expect(classifyChatModelFailure(CODEX_RATE, NOW)?.code).toBe('model_rate_limited');
  });

  it('a capped codex account moves the retry to claude-code', () => {
    expect(papercupChatFailover({ engine: 'codex', failure: classifyChatModelFailure(CODEX_CAP, NOW) })).toEqual({
      kind: 'failover',
      model: 'sonnet:low',
      backend: 'claude-code',
      cause: 'model_usage_limited',
    });
  });

  it('a revoked claude credential moves the retry to the codex pin', () => {
    expect(
      papercupChatFailover({ engine: 'claude-code', failure: classifyChatModelFailure(CLAUDE_REVOKED, NOW) }),
    ).toEqual({ kind: 'failover', ...PAPERCUP_CHAT_MODEL_PIN, cause: 'model_auth_required' });
  });

  // WI-10004897: avi-test's claude token capped and the failover ran a codex copy whose
  // refresh token was blanked (D-311) and whose access token had expired: a 401.
  it('an alternate whose login is known dead yields `unavailable` with the reason, not a doomed failover', () => {
    const credentialOf = vi.fn(() => ({ usable: false as const, reason: 'expired-no-refresh' as const }));
    expect(
      papercupChatFailover({ engine: 'codex', failure: classifyChatModelFailure(CODEX_CAP, NOW), credentialOf }),
    ).toEqual({
      kind: 'unavailable',
      credential: 'expired-no-refresh',
      model: 'sonnet:low',
      backend: 'claude-code',
      cause: 'model_usage_limited',
    });
    // The verdict is asked about the ALTERNATE, never the backend that just failed.
    expect(credentialOf).toHaveBeenCalledWith('claude-code');
  });

  it('a usable or unjudgeable alternate still fails over', () => {
    const cap = classifyChatModelFailure(CODEX_CAP, NOW);
    expect(
      papercupChatFailover({ engine: 'codex', failure: cap, credentialOf: () => ({ usable: true, basis: 'refreshable' }) })
        ?.kind,
    ).toBe('failover');
    expect(papercupChatFailover({ engine: 'codex', failure: cap, credentialOf: () => null })?.kind).toBe('failover');
  });

  it('no failover cause means the credential is never probed', () => {
    const credentialOf = vi.fn(() => null);
    expect(
      papercupChatFailover({ engine: 'codex', failure: classifyChatModelFailure(CODEX_RATE, NOW), credentialOf }),
    ).toBeNull();
    expect(credentialOf).not.toHaveBeenCalled();
  });

  it('a transient rate limit or an unclassified failure keeps the same-backend retry', () => {
    expect(papercupChatFailover({ engine: 'codex', failure: classifyChatModelFailure(CODEX_RATE, NOW) })).toBeNull();
    expect(papercupChatFailover({ engine: 'codex', failure: null })).toBeNull();
  });

  it('a backend with no known alternate account (omp) or an unknown engine does not fail over', () => {
    const cap = classifyChatModelFailure(CODEX_CAP, NOW);
    expect(papercupChatFailover({ engine: 'omp', failure: cap })).toBeNull();
    expect(papercupChatFailover({ engine: 'anthropic-direct', failure: cap })).toBeNull();
    expect(papercupChatFailover({ engine: undefined, failure: cap })).toBeNull();
  });
});
