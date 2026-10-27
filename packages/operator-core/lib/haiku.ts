/**
 * runHaiku — a one-shot completion on the cheap haiku model.
 *
 * A generic, best-effort LLM primitive: feed it a self-contained
 * prompt, get back the text (or `null` on any failure). No MCP, no
 * tools, no session — just a bounded single turn. Used for background
 * summarisation where a full agent spawn would be overkill and a
 * failure must never surface to the user:
 *
 *   - delegate session titles + summaries (`delegate-summary.ts`);
 *   - plan-revision rationale auto-summary (`plans/revision-summary.ts`,
 *     plan-agent-launch P-007).
 *
 * Routes through `runAgentChat` with `backend: 'anthropic-direct'` — a stateless
 * Anthropic-format HTTP round-trip, no omp/claude-code subprocess. The
 * transport auto-resolves: claude-code users go DIRECT to Anthropic with
 * their Claude session.
 * Background summaries never need the agent loop (no MCP, no tools), so a
 * subprocess spawn would be pure overhead.
 */

import { runAgentChat } from './agent-chat-stream';

const HAIKU_MODEL = process.env.PAPERCUSP_HAIKU_MODEL ?? 'claude-haiku-4-5';

export interface HaikuTurnResult {
  text: string;
  /** Model id the call ran on (for provenance columns). */
  model: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

/** Unknown usage stays absent. Failed or interrupted summaries can still incur
 * liability, even though the compatibility text-only helper returns null. */
export interface HaikuAttempt {
  status: 'completed' | 'failed' | 'incomplete';
  text?: string;
  model: string;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
}

interface HaikuOptions {
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  attribution?: { role?: string; runId?: string; sessionId?: string; toolName?: string };
}

/**
 * Run the haiku model on a single prompt via the stateless anthropic-direct
 * backend, returning the text
 * AND the call's usage (cost + tokens) so callers that must meter spend —
 * e.g. the conversation compactor's `recordSpend` — can. Returns `null` on
 * any failure; never throws. Same bounds + transport as `runHaiku` (which
 * is now a thin wrapper). The stateless path already rides the shared
 * governor and reports usage telemetry; this just surfaces the numbers to
 * the caller too.
 *
 * `timeoutMs` is overridable: the default 15s suits one-line summaries;
 * the conversation compactor's bigger prompt/output gets more headroom.
 */
export async function runHaikuTurn(
  prompt: string,
  opts: HaikuOptions = {},
): Promise<HaikuTurnResult | null> {
  const result = await runHaikuAttempt(prompt, opts);
  return result.status === 'completed' && result.text ? {
    text: result.text, model: result.model, costUsd: result.costUsd ?? 0,
    tokensIn: result.tokensIn ?? 0, tokensOut: result.tokensOut ?? 0,
  } : null;
}

export async function runHaikuAttempt(prompt: string, opts: HaikuOptions = {}): Promise<HaikuAttempt> {
  const ac = new AbortController();
  const measured: Omit<HaikuAttempt, 'status' | 'text'> = { model: HAIKU_MODEL };
  const incomplete = (): HaikuAttempt => ({ ...measured, status: 'incomplete' });
  if (opts.signal?.aborted) return incomplete();
  // Cancellation is cooperative: an iterator can be waiting in admission or
  // setup before it observes the signal. The utility's deadline must still
  // settle its caller, so a release-note fallback cannot wait indefinitely.
  let killer: ReturnType<typeof setTimeout>;
  let onAbort: () => void;
  const deadline = new Promise<HaikuAttempt>((resolve) => {
    onAbort = () => { ac.abort(); resolve(incomplete()); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    killer = setTimeout(() => {
      onAbort();
    }, opts.timeoutMs ?? 15_000);
  });
  const collect = async (): Promise<HaikuAttempt> => {
    let out = '';
    let failed = false;
    try {
      for await (const ev of runAgentChat({
        backend: 'anthropic-direct',
        promptText: prompt,
        model: HAIKU_MODEL,
        maxTokens: opts.maxTokens ?? 200,
        signal: ac.signal,
        // Default attribution: every haiku utility call is at least labeled 'haiku'
        // on its usage row instead of anonymous; callers pass a feature-specific
        // role (+ toolName/runId) to refine.
        usageAttribution: opts.attribution ?? { role: 'haiku' },
      })) {
        // the stateless backend emits a single `delta` with the full final
        // text (non-streaming round-trip), then a `result` with the
        // same text. Overwrite — don't accumulate, or you'll double it.
        if (ev.type === 'delta') out = ev.text;
        else if (ev.type === 'result') {
          out = ev.finalText || out;
          for (const key of ['costUsd', 'tokensIn', 'tokensOut'] as const) {
            const value = ev[key];
            if (typeof value === 'number' && Number.isFinite(value) && value >= 0) measured[key] = value;
          }
        } else if (ev.type === 'error') {
          failed = true;
          console.warn(`[haiku] failed:`, (ev.stderr ?? ev.message).slice(0, 300));
        }
      }
    } catch (err) {
      console.warn('[haiku] threw:', (err as Error).message);
      return { ...measured, status: ac.signal.aborted ? 'incomplete' : 'failed' };
    }
    const text = out.trim();
    return { ...measured, status: ac.signal.aborted ? 'incomplete' : failed || !text ? 'failed' : 'completed',
      ...(!failed && text && !ac.signal.aborted ? { text } : {}) };
  };
  try {
    return await Promise.race([collect(), deadline]);
  } finally {
    clearTimeout(killer!);
    opts.signal?.removeEventListener('abort', onAbort!);
  }
}

/**
 * Run the haiku model on a single prompt via anthropic-direct. Returns the
 * trimmed text, or `null` on any failure — this is best-effort and
 * never throws. Bounded to ~15s: the callers are background
 * summarisers, not interactive turns. The bound is wide enough to
 * absorb the cold-cache first-call cost (~6-7s) plus one 529 retry
 * (2s backoff) without surfacing failure to callers.
 *
 * `maxTokens` flows through to the anthropic-direct backend as `max_tokens`
 * (omp/claude-code ignored it; anthropic-direct honors it).
 */
export async function runHaiku(prompt: string, maxTokens = 200): Promise<string | null> {
  const r = await runHaikuTurn(prompt, { maxTokens });
  return r ? r.text : null;
}
