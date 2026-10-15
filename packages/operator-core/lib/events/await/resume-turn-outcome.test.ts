import { describe, it, expect } from 'vitest';
import { classifyResumeTurnExit, isRateLimitDeath, isUnavailableToolReferenceError, type ResumeTurnExitRaw } from './resume-turn-outcome';

const raw = (p: Partial<ResumeTurnExitRaw>): ResumeTurnExitRaw => ({
  exitCode: 0,
  signal: null,
  stdoutTail: '',
  stderrTail: '',
  ...p,
});

describe('classifyResumeTurnExit — survived vs died (P0a)', () => {
  it('a clean exit (code 0, no signal) is SUCCESS even with an empty output tail', () => {
    // The crux: a clean `claude --resume … -p` exit must NOT be misread as empty_output
    // just because we captured only a bounded tail (not the transcript).
    const out = classifyResumeTurnExit(raw({ exitCode: 0, stdoutTail: '' }));
    expect(out.ok).toBe(true);
  });

  it('a clean exit is success even if the tail merely MENTIONS a rate limit', () => {
    // A successful turn whose output happens to contain the words "rate limit" must
    // not be classified a death (the failed-exit gate in turn-error guards this too).
    const out = classifyResumeTurnExit(raw({ exitCode: 0, stdoutTail: 'discussed the rate limit fix' }));
    expect(out.ok).toBe(true);
  });

  it('classifies the canonical loop-death: exitCode=1 with a 429 on STDOUT as rate_limited', () => {
    // The exact storm signature from the insight doc: "the agent produced no turn
    // (exitCode=1)" because its first model call 429'd. The CLI prints the API error
    // to STDOUT, so the classifier must fold stdout in on a failed exit.
    const out = classifyResumeTurnExit(
      raw({ exitCode: 1, stdoutTail: 'API Error: 429 Too Many Requests · Rate limited', stderrTail: '' }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.class).toBe('rate_limited');
      expect(isRateLimitDeath(out)).toBe(true);
    }
  });

  it('classifies a subscription usage-cap death (usage_limit) and parses its reset', () => {
    const now = Date.UTC(2026, 5, 23, 10, 0, 0);
    const out = classifyResumeTurnExit(
      raw({ exitCode: 1, stdoutTail: "You've hit your usage limit · resets 4:20am" }),
      now,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.class).toBe('usage_limit');
      expect(isRateLimitDeath(out)).toBe(true);
      expect(out.error.resetAt).toBeGreaterThan(now);
    }
  });

  it('the transient-overload phrase ("temporarily limiting … not your usage limit") is rate_limited, not usage_limit', () => {
    const out = classifyResumeTurnExit(
      raw({ exitCode: 1, stdoutTail: 'Server is temporarily limiting requests (not your usage limit) · Rate limited' }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.class).toBe('rate_limited');
  });

  it('a generic non-zero exit with no API error is a crash (death, but not a rate-limit)', () => {
    const out = classifyResumeTurnExit(raw({ exitCode: 1, stderrTail: 'TypeError: boom' }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.class).toBe('agent_crash');
      expect(isRateLimitDeath(out)).toBe(false);
    }
  });

  it('classifies a missing native resume session as permanent, not a retryable crash', () => {
    const out = classifyResumeTurnExit(
      raw({ exitCode: 1, stderrTail: 'Error: Session "01a02f7b-b7be-7030-ad56-53149607c6cd" not found' }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.class).toBe('permanent');
      expect(out.error.retryable).toBe(false);
      expect(out.error.surfaceToUser).toBe(true);
    }
  });

  it('classifies a missing tool-reference API 400 as permanent even when the CLI exits cleanly', () => {
    const message = "API Error: 400 Tool reference 'Monitor' not found in available tools";
    const out = classifyResumeTurnExit(
      raw({
        exitCode: 0,
        stdoutTail: message,
        stderrTail: 'Permission deny rule "ToolSearch" matches no known tool — check for typos.',
      }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.class).toBe('permanent');
      expect(out.error.message).toBe(message);
      expect(out.error.retryable).toBe(false);
      expect(out.error.surfaceToUser).toBe(true);
    }
  });

  it('keeps an auth-like missing-tool identifier on the permanent tool-reference path', () => {
    const message = "API Error: 400 Tool reference 'mcp__tsenta__complete_authentication' not found in available tools";
    const out = classifyResumeTurnExit(
      raw({
        exitCode: 1,
        stdoutTail: message,
        stderrTail: 'Permission deny rule "ToolSearch" matches no known tool — check for typos.',
      }),
    );

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.class).toBe('permanent');
      expect(out.error.message).toBe(message);
      expect(out.error.retryable).toBe(false);
      expect(isUnavailableToolReferenceError(out)).toBe(true);
    }
  });

  it('does not treat an unmatched local permission-rule warning as a provider tool-reference rejection', () => {
    const out = classifyResumeTurnExit(
      raw({ exitCode: 1, stderrTail: 'Permission deny rule "ToolSearch" matches no known tool — check for typos.' }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.class).toBe('agent_crash');
  });

  it('classifies Codex stale rollout-path stderr as permanent, not a retryable crash', () => {
    const out = classifyResumeTurnExit(
      raw({
        outputProtocol: 'codex-jsonl',
        exitCode: 1,
        stderrTail:
          '2026-08-23T22:13:42.820382Z ERROR codex_rollout::list: state db returned stale rollout path for thread 01a02a0c-d02d-7023-a4f9-8303089f8092: /home/builduser/.papercusp/su-codex-homes/session-16773/\n',
      }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.class).toBe('permanent');
      expect(out.error.retryable).toBe(false);
      expect(out.error.surfaceToUser).toBe(true);
      expect(out.error.provider).toBe('openai');
    }
  });

  it('classifies Codex thread/resume no-rollout-found stderr as permanent, not a retryable crash', () => {
    // EI-21264970189305370 verbatim: the rollout ROW is gone (-32600), a different codex
    // message from the stale-rollout-PATH shape above. Before the third regex alternation
    // this classified agent_crash (retryable) and the owning loop re-armed into the same
    // wall for 7 consecutive fires.
    const out = classifyResumeTurnExit(
      raw({
        outputProtocol: 'codex-jsonl',
        exitCode: 1,
        stderrTail:
          'Error: thread/resume: thread/resume failed: no rollout found for thread id 01a02a91-496c-7590-a025-cf88426d6320 (code -32600)\n',
      }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.class).toBe('permanent');
      expect(out.error.retryable).toBe(false);
      expect(out.error.surfaceToUser).toBe(true);
      expect(out.error.provider).toBe('openai');
    }
  });

  it('classifies the claude no-conversation-found stderr as permanent, not a retryable crash', () => {
    // EI-21306279681556443 verbatim: `claude -r <id>` reports a reaped/never-archived
    // transcript as "No conversation found with session ID: <id>" — a FOURTH stale-target
    // shape whose word order is reversed ("found" precedes "session"), so the
    // `session <id> not found` alternation can never match it. Before the fourth
    // alternation this classified agent_crash (retryable) and the owning loop re-armed
    // into the same wall, alerting only via the chronic-backoff floor (15min re-arm).
    const out = classifyResumeTurnExit(
      raw({
        exitCode: 1,
        stderrTail: 'No conversation found with session ID: e57d91cd-07ea-4077-a84a-da1baa3c8337\n',
      }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.class).toBe('permanent');
      expect(out.error.retryable).toBe(false);
      expect(out.error.surfaceToUser).toBe(true);
    }
  });

  it('classifies a prompt-overflow death as context_overflow, not agent_crash', () => {
    const out = classifyResumeTurnExit(raw({ exitCode: 1, stdoutTail: 'Prompt is too long: 210000 tokens > 200000 maximum' }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.class).toBe('context_overflow');
      expect(out.error.retryable).toBe(false);
      expect(out.error.surfaceToUser).toBe(true);
    }
  });

  it('a signal kill is a death', () => {
    const out = classifyResumeTurnExit(raw({ exitCode: null, signal: 'SIGKILL' }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(isRateLimitDeath(out)).toBe(false);
  });

  it('a null/null exit (post-pid spawn error) is treated as a death, not a survival', () => {
    const out = classifyResumeTurnExit(raw({ exitCode: null, signal: null }));
    expect(out.ok).toBe(false);
  });

  it('isRateLimitDeath is false for a survived turn', () => {
    expect(isRateLimitDeath(classifyResumeTurnExit(raw({ exitCode: 0 })))).toBe(false);
  });

  describe('Codex JSONL completion contract', () => {
    it('accepts exit 0 only when the bounded tail contains turn.completed', () => {
      const out = classifyResumeTurnExit(
        raw({
          outputProtocol: 'codex-jsonl',
          stdoutTail: [
            '{"type":"thread.started","thread_id":"t-1"}',
            '{"type":"turn.started"}',
            '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}',
          ].join('\n'),
        }),
      );
      expect(out.ok).toBe(true);
    });

    it('rejects exit 0 when Codex stops after tool output without turn.completed', () => {
      const out = classifyResumeTurnExit(
        raw({
          outputProtocol: 'codex-jsonl',
          stdoutTail: [
            '{"type":"turn.started"}',
            '{"type":"item.completed","item":{"type":"command_execution","exit_code":0}}',
          ].join('\n'),
        }),
      );
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.class).toBe('malformed_output');
        expect(out.error.provider).toBe('openai');
        expect(out.error.message).toContain('without the required turn.completed');
      }
    });

    it('treats a turn.failed event as a death even if the Codex wrapper exits 0', () => {
      const out = classifyResumeTurnExit(
        raw({
          outputProtocol: 'codex-jsonl',
          stdoutTail: '{"type":"turn.failed","error":{"message":"429 Too Many Requests · Rate limited"}}',
        }),
      );
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.class).toBe('rate_limited');
        expect(out.error.provider).toBe('openai');
      }
    });

    it('ignores a partial first JSONL line when a complete terminal event follows it', () => {
      const out = classifyResumeTurnExit(
        raw({
          outputProtocol: 'codex-jsonl',
          stdoutTail: 'uncated-prefix"}\n{"type":"turn.completed","usage":{}}\n',
        }),
      );
      expect(out.ok).toBe(true);
    });
  });

  describe('EI-13818 — a CLEAN exit is not always success (the leaderless-fleet bug)', () => {
    it('a clean exit whose tail is the verbatim session-limit message is a DEATH, not ok:true', () => {
      // The exact incident: 4 consecutive resume turns each printed this and exited 0 —
      // previously always classified ok:true, so the loop never backed off.
      const now = Date.UTC(2026, 6, 17, 5, 31, 0);
      const out = classifyResumeTurnExit(
        raw({ exitCode: 0, signal: null, stdoutTail: "You've hit your session limit · resets 5:40am (America/New_York)" }),
        now,
      );
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.class).toBe('usage_limit');
        expect(out.error.surfaceToUser).toBe(true);
        expect(out.error.retryable).toBe(false);
        expect(isRateLimitDeath(out)).toBe(true);
        // The reset time is parsed from the evidence for the 429-aware re-arm (P1a).
        expect(out.error.resetAt).toBeGreaterThan(now);
      }
    });

    it('a clean exit whose tail is an org auth-wall message is a DEATH classified `auth`', () => {
      const out = classifyResumeTurnExit(
        raw({ exitCode: 0, signal: null, stdoutTail: 'Your organization has disabled Claude subscription access for Claude Code' }),
      );
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.class).toBe('auth');
        expect(out.error.surfaceToUser).toBe(true);
      }
    });

    it('a clean exit that merely DISCUSSES rate limits/context windows stays ok:true (no false positive)', () => {
      expect(classifyResumeTurnExit(raw({ exitCode: 0, stdoutTail: 'discussed the rate limit fix' })).ok).toBe(true);
      expect(
        classifyResumeTurnExit(raw({ exitCode: 0, stdoutTail: 'fixed the context window exceeded bug' })).ok,
      ).toBe(true);
    });

    it('a SIGNALLED or non-zero exit still goes through the normal subprocess classifier (unaffected)', () => {
      const out = classifyResumeTurnExit(
        raw({ exitCode: 1, stdoutTail: "You've hit your session limit · resets 5:40am" }),
      );
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.class).toBe('usage_limit');
    });
  });
});
