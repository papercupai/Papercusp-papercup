/**
 * presence-intent.ts — the dependency-free predicates that decide whether a declared
 * intent string carries a usable signal.
 *
 * Moved out of presence-payload.ts (where they were canonical) so presence-tier1.ts can
 * use them for the derived-intent rule (derived-status-not-hand-written-2026-10-12#D-006)
 * without an import cycle: presence-payload imports from presence-tier1, so tier1 cannot
 * import back from payload. presence-payload re-exports both names, so every existing
 * importer is unchanged. This module must stay import-free for the same reason.
 */

/**
 * The self-referential placeholder a presence declare writes when an agent is
 * live but has declared no real intent (see the coord-hook + locks/enrich-busy).
 * It is a NON-signal on the roster — "(active — see coord:presence…)" read AS an
 * intent is circular and misleads the Queen/peers into thinking a real intent
 * exists. `toStableRosterRow` normalizes it to `null` on the READ side (P-004) so
 * the roster shows an honest "no declared intent" without touching the write path
 * (enrich-busy still relies on the written sentinel to detect the no-intent case).
 * Canonical here so every reader shares ONE string (was duplicated in enrich-busy).
 */
export const PLACEHOLDER_INTENT = '(active — see coord:presence for current work)';

/**
 * True when an intent string is a LIFECYCLE LABEL — the name of the hook or dispatch step that
 * happened to take a lock ('PreToolUse:Edit', 'capability:write') — rather than a declaration of
 * WHAT the agent is changing. Blank and {@link PLACEHOLDER_INTENT} count too: all three mean the
 * same thing to a consumer, "no usable intent here, look elsewhere".
 *
 * Canonical here, beside PLACEHOLDER_INTENT and for the same reason (EI-20055604348536487). The
 * predicate had independently grown THREE copies that did not agree — `isUninformativeLockIntent`
 * (locks/enrich-busy.ts) covered `capability:` and the placeholder, `isGenericLockIntent`
 * (harness/git-sync/git-sync-action.ts) covered neither, and the lock hook has a third in Python.
 * Two surfaces resolving one projection two ways is the divergence D-038 axis 5 forbids, and this
 * is the union: the narrower copies each classified a real sentinel as usable intent.
 *
 * ⚠ The regexes are ANCHORED to the label's own prefix, never a substring search — an agent whose
 * DECLARED intent legitimately discusses the hook ("stop PreToolUse:Edit leaking into the ledger",
 * which is literally the intent that produced this function) must not be classified as a sentinel.
 */
export function isLifecycleIntent(intent: string | null | undefined): boolean {
  const s = (intent ?? '').trim();
  if (!s || s === PLACEHOLDER_INTENT) return true;
  return /^(?:Pre|Post)ToolUse:/i.test(s) || /^capability:/i.test(s);
}
