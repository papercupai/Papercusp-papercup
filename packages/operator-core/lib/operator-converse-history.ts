/**
 * Token-budgeted history selection for the operator-converse brain.
 *
 * Replaces the legacy `HISTORY_KEEP = 30` fixed-count truncation with
 * a token-budgeted walker. Walks newest → oldest, accumulating until
 * `budgetTokens` is exhausted, then returns the kept window in
 * chronological order.
 *
 * The 4-chars-per-token heuristic is a conventional approximation —
 * exact tokenization would require an embedded tokenizer, which is
 * overkill for a budget gate. Off by ~10-15% on English prose, well
 * within the slack of a 5k-150k user-configurable budget.
 *
 * Per-turn-char cap (default 8000) mirrors the existing
 * MAX_USER_TURN_CHARS guard so a single pasted-dump turn can't single-
 * handedly burn the whole budget.
 */

export const DEFAULT_MAX_TURN_CHARS = 8000;
/** Approximate tokens added per kept message for role labels / framing. */
const PER_TURN_OVERHEAD = 8;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export interface HistoryMessage {
  role: string;
  content: string;
}

/** The exact history sections the converse prompt sends, including summary framing. */
export function renderOperatorHistorySections(messages: ReadonlyArray<HistoryMessage>, summary: string | null): string[] {
  const sections: string[] = [];
  if (summary) {
    sections.push(
      `## Earlier conversation (compacted)\n\n` +
        `The verbatim transcript below covers only recent turns. Everything ` +
        `earlier was compacted into this rolling summary — treat it as your ` +
        `memory of the older conversation (decisions, preferences, named ` +
        `artifacts, open threads):\n\n${summary}`,
    );
  }
  if (messages.length) {
    const transcript = messages.map(m => `[${m.role}]\n${m.content}`).join('\n\n');
    sections.push(`## Conversation history (oldest first; last ${messages.length} turns)\n\n${transcript}`);
  }
  return sections;
}

/**
 * Return the most recent messages whose total estimated token cost
 * fits within `budgetTokens`. Each message is pre-truncated to
 * `maxTurnChars`. Order in the returned array is chronological
 * (oldest first within the kept window) — same order the brain
 * expects.
 *
 * Edge cases:
 *   - budgetTokens <= 0      → []
 *   - messages empty / nullish → []
 *   - newest message or reserved context cannot fit → explicit refusal,
 *     before a provider can receive a prompt without the current utterance.
 * `estimate` lets the host charge its actual rendered summary and framing;
 * its cost must be nondecreasing as older messages are added.
 */
export function selectHistoryWithinBudget<M extends HistoryMessage>(
  messages: ReadonlyArray<M> | null | undefined,
  budgetTokens: number,
  maxTurnChars: number = DEFAULT_MAX_TURN_CHARS,
  estimate?: (selected: ReadonlyArray<M>) => number,
): M[] {
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens <= 0) return [];
  if (!Number.isSafeInteger(maxTurnChars) || maxTurnChars < 0) throw new RangeError('invalid-history-limit');
  const cost = (selected: ReadonlyArray<M>): number => {
    const value = estimate ? estimate(selected)
      : selected.reduce((sum, message) => sum + estimateTokens(message.content) + PER_TURN_OVERHEAD, 0);
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('invalid-history-estimate');
    return value;
  };
  if (cost([]) > budgetTokens) throw new RangeError('history-budget-exceeded');
  if (!messages || messages.length === 0) return [];
  const views = messages.map(m => {
    const content = m.content ?? '';
    return { ...m, content: content.length > maxTurnChars ? content.slice(0, maxTurnChars) + '…' : content };
  });
  if (estimate) {
    if (cost(views.slice(-1)) > budgetTokens) throw new RangeError('history-budget-exceeded');
    // Render only logarithmically many suffixes; long or empty-message histories must not
    // turn a hard-budget check into a quadratic amount of formatting work.
    let low = 1;
    let high = views.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (cost(views.slice(-mid)) <= budgetTokens) low = mid;
      else high = mid - 1;
    }
    return views.slice(-low);
  }
  const kept: M[] = [];
  let used = 0;
  for (let i = views.length - 1; i >= 0; i--) {
    const m = views[i];
    const next = used + estimateTokens(m.content) + PER_TURN_OVERHEAD;
    if (next > budgetTokens) {
      if (!kept.length) throw new RangeError('history-budget-exceeded');
      break;
    }
    used = next;
    kept.push(m);
  }
  return kept.reverse();
}
