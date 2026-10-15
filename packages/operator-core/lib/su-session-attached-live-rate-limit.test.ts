import { describe, expect, it } from 'vitest';
import {
  SU_SESSION_PROTOCOL_VERSION,
  SU_SESSION_SCHEMA,
  type SuSessionEvent,
  type SuSessionIdentity,
} from '@papercusp/chat-protocol';
import { confirmedProviderRateLimit, throwIfProviderRateLimited, throwIfProviderRefused } from './su-session-attached-live-rate-limit';
import { pollUntil } from './pui-e2e/poll-until';

const session: SuSessionIdentity<'claude'> = {
  agentChatId: 'fixture-chat',
  advSessionId: 1,
  backend: 'claude',
  nativeSessionId: 'fixture-native',
  ownerId: 'fixture-owner',
  workspaceId: 'fixture-ws',
  harnessSlug: null,
};
let sequence = 0;

function base() {
  sequence += 1;
  return {
    schema: SU_SESSION_SCHEMA,
    protocolVersion: SU_SESSION_PROTOCOL_VERSION,
    session,
    eventId: `evt-${sequence}`,
    sequence,
    at: new Date().toISOString(),
  };
}

function errorEvent(message: string): SuSessionEvent {
  return {
    ...base(),
    type: 'error',
    scope: 'turn',
    code: 'claude_runtime_error',
    message,
    recoverable: true,
  } as SuSessionEvent;
}

function transcript(role: 'system' | 'assistant', content: string): SuSessionEvent {
  return {
    ...base(),
    type: 'transcript',
    phase: 'delta',
    turnId: 'turn-1',
    role,
    channel: 'text',
    content,
  } as SuSessionEvent;
}

describe('attached live provider-limit classifier', () => {
  it('does not classify missing evidence as a provider limit', () => {
    expect(confirmedProviderRateLimit([]).confirmed).toBe(false);
  });

  it('confirms a structured 429', () => {
    expect(confirmedProviderRateLimit([errorEvent('API Error: 429')]).confirmed).toBe(true);
  });

  it('confirms an explicit weekly usage wall', () => {
    expect(confirmedProviderRateLimit([errorEvent("You've hit your weekly limit")]).confirmed).toBe(true);
  });

  it('confirms structured rate-limit prose', () => {
    expect(confirmedProviderRateLimit([errorEvent('temporarily limiting requests')]).confirmed).toBe(true);
  });

  it('does not confirm an unrelated structured error', () => {
    expect(confirmedProviderRateLimit([errorEvent('invalid model configuration')]).confirmed).toBe(false);
  });

  it('requires repeated system transcript mentions without a structured error', () => {
    expect(confirmedProviderRateLimit([transcript('system', 'upstream 429, retrying')]).confirmed).toBe(false);
    expect(confirmedProviderRateLimit([
      transcript('system', 'upstream 429, retrying'),
      transcript('system', 'still rate limited, retrying'),
    ]).confirmed).toBe(true);
  });

  it('does not count assistant explanations as provider evidence', () => {
    expect(confirmedProviderRateLimit([
      transcript('assistant', 'A 429 is a rate limit response.'),
      transcript('assistant', 'If we hit a rate limit again I will back off.'),
    ]).confirmed).toBe(false);
  });
});

describe('live acceptance provider-capacity guard', () => {
  it('disqualifies generic readiness even when the screen predicate would succeed', async () => {
    let checks = 0;
    await expect(pollUntil(() => { checks += 1; return true; }, {
      timeoutMs: 120_000,
      beforeCheck: () => throwIfProviderRateLimited([errorEvent('API Error: 429')], 'Waiting for send readiness'),
    })).rejects.toThrow('Waiting for send readiness cannot run: confirmed provider rate limit');
    expect(checks).toBe(0);
  });

  it('stops a question wait on refusal arriving after the first observation', async () => {
    const events: SuSessionEvent[] = [];
    let checks = 0;
    await expect(pollUntil(() => {
      checks += 1;
      events.push(errorEvent('429 request would exceed your rate limit'));
      return false;
    }, {
      timeoutMs: 120_000, intervalMs: 1,
      beforeCheck: () => throwIfProviderRateLimited(events, 'Waiting for question'),
    })).rejects.toThrow('Waiting for question cannot run: confirmed provider rate limit');
    expect(checks).toBe(1);
  });

  it('excludes an earlier pane refusal and still observes a new refusal', async () => {
    const events = [errorEvent('429 earlier pane')];
    const paneStart = events.length;
    const beforeCheck = () => throwIfProviderRateLimited(events.slice(paneStart), 'Current pane');
    expect((await pollUntil(() => true, { timeoutMs: 1_000, beforeCheck })).ok).toBe(true);
    events.push(errorEvent('429 current pane'));
    await expect(pollUntil(() => true, { timeoutMs: 1_000, beforeCheck })).rejects.toThrow('Current pane cannot run');
  });

  it('aborts an approval wait at the first confirmed refusal instead of consuming its timeout', async () => {
    let checks = 0;
    await expect(pollUntil(() => {
      checks += 1;
      throwIfProviderRateLimited([errorEvent('API Error: 429 request would exceed your rate limit')], 'Native tool approval');
      return false;
    }, { timeoutMs: 120_000, intervalMs: 100 })).rejects.toThrow(
      'Native tool approval cannot run: confirmed provider rate limit',
    );
    expect(checks).toBe(1);
  });

  it('allows a transient retry note to recover and reach the expected condition', async () => {
    let checks = 0;
    const outcome = await pollUntil(() => {
      checks += 1;
      throwIfProviderRateLimited([transcript('system', 'upstream 429, retrying')], 'P-005 greeting');
      return checks === 2;
    }, { timeoutMs: 1_000, intervalMs: 1 });
    expect(outcome.ok).toBe(true);
    expect(checks).toBe(2);
  });

  it('keeps assistant explanations and unrelated errors available to their own acceptance assertions', () => {
    expect(() => throwIfProviderRateLimited([
      transcript('assistant', 'A 429 is a rate limit response.'),
      errorEvent('invalid model configuration'),
    ], 'P-005 read-explain')).not.toThrow();
  });
});

describe('live acceptance native model refusal guard', () => {
  const refusal = JSON.stringify({ detail: "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account." });
  const rejected = (): SuSessionEvent => ({
    ...base(), type: 'lifecycle', previousState: 'running', state: 'waiting-for-owner', reason: refusal,
  } as SuSessionEvent);

  it('fails before evaluating a screen predicate on the retained native lifecycle refusal', async () => {
    let checks = 0;
    await expect(pollUntil(() => { checks += 1; return true; }, {
      timeoutMs: 120_000,
      beforeCheck: () => throwIfProviderRefused([rejected()], 'Native reply'),
    })).rejects.toThrow('Native reply cannot run: confirmed provider model rejection');
    expect(checks).toBe(0);
  });

  it('fails an approval wait when the provider rejects the model after its first observation', async () => {
    const events: SuSessionEvent[] = [];
    let checks = 0;
    await expect(pollUntil(() => {
      checks += 1;
      events.push(errorEvent(refusal));
      return false;
    }, {
      timeoutMs: 120_000, intervalMs: 1,
      beforeCheck: () => throwIfProviderRefused(events, 'Native tool approval'),
    })).rejects.toThrow('Native tool approval cannot run: confirmed provider model rejection');
    expect(checks).toBe(1);
  });

  it('does not treat assistant explanations, unrelated errors, or earlier panes as a current rejection', () => {
    const events = [rejected()];
    const paneStart = events.length;
    expect(() => throwIfProviderRefused([
      ...events.slice(paneStart), transcript('assistant', refusal), errorEvent('invalid model configuration'),
    ], 'Current pane')).not.toThrow();
    events.push(rejected());
    expect(() => throwIfProviderRefused(events.slice(paneStart), 'Current pane')).toThrow('provider model rejection');
  });

  it('preserves the existing rate-limit refusal', () => {
    expect(() => throwIfProviderRefused([errorEvent('API Error: 429')], 'Native reply'))
      .toThrow('confirmed provider rate limit');
  });
});
