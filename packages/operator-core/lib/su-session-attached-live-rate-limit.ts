import type { SuSessionEvent } from '@papercusp/chat-protocol';

const CONFIRMED_PROVIDER_RATE_LIMIT_RE =
  /(\b429\b|rate.?limit|too many requests|slow down|temporarily limiting|weekly limit)/i;

function systemTranscriptMatches(events: readonly SuSessionEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'transcript' &&
    event.phase === 'delta' &&
    event.role === 'system' &&
    event.content &&
    CONFIRMED_PROVIDER_RATE_LIMIT_RE.test(event.content)
      ? [event.content]
      : [],
  );
}

/** Distinguish provider-capacity evidence from an attached-engine regression. */
export function confirmedProviderRateLimit(
  events: readonly SuSessionEvent[],
): { confirmed: boolean; signals: string[] } {
  const structured = events.flatMap((event) =>
    event.type === 'error' && CONFIRMED_PROVIDER_RATE_LIMIT_RE.test(event.message) ? [event.message] : [],
  );
  const prose = systemTranscriptMatches(events);
  return { confirmed: structured.length > 0 || prose.length >= 2, signals: [...structured, ...prose] };
}

/** Abort a live acceptance wait when the provider has already refused the turn. */
export function throwIfProviderRateLimited(events: readonly SuSessionEvent[], stage: string): void {
  const limit = confirmedProviderRateLimit(events);
  if (limit.confirmed) {
    throw new Error(`${stage} cannot run: confirmed provider rate limit (${limit.signals.join('; ')})`);
  }
}

/** A rejected native model cannot produce the reply or approval being awaited.
 * Read only structured runtime evidence; assistant prose is not a refusal. */
export function throwIfProviderRefused(events: readonly SuSessionEvent[], stage: string): void {
  throwIfProviderRateLimited(events, stage);
  const rejection = events.find((event) => {
    const message = event.type === 'error' ? event.message
      : event.type === 'lifecycle' && event.state === 'waiting-for-owner' ? event.reason : undefined;
    return message && /The '[^']+' model is not supported when using Codex with a ChatGPT account\./.test(message);
  });
  if (rejection) {
    const reason = rejection.type === 'error' ? rejection.message
      : rejection.type === 'lifecycle' ? rejection.reason : undefined;
    throw new Error(`${stage} cannot run: confirmed provider model rejection (${reason})`);
  }
}
