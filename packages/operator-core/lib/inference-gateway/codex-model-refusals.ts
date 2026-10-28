/**
 * codex-model-refusals.ts — automatic per-(account, model) availability for the Codex
 * ChatGPT-subscription pool (WI-10003306).
 *
 * A ChatGPT account can refuse a model outright:
 *   400 {"detail":"The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account."}
 * On 2026-09-26 two of the pool's subscriptions (registered as three entries) refused EVERY
 * premium model while the other four served them. The gateway treated that 400 as final and
 * forwarded it, never rotated, and never remembered it, so every request was a coin flip on which
 * account the health-ranked pick landed on — the owner saw the error "intermittently, on all
 * models", and resending sometimes worked.
 *
 * This module is the memory half of the fix. It records a refusal for the exact (account, model)
 * pair, so selection can route AROUND that account for that model without removing the account
 * from the pool or parking it for models it still serves (owner directive #636: mark it not
 * available, never remove it, and do it automatically).
 *
 * Why per-MODEL rather than parking the whole account: the same 400 is what EVERY account returns
 * for a model id nobody serves (a typo, or a bare family name like `gpt-5.6`). Parking whole
 * accounts on that signal would let one bad request take the entire pool offline. Keyed by model,
 * a genuinely-unsupported id just marks every account for that id, and the request still gets the
 * truthful 400.
 *
 * Recovery is automatic: an entry expires after `ttlMs`, the next request for that model may land
 * on the account again, and a refusal there is failed over transparently and re-recorded. A 2xx
 * for the pair clears it immediately. Nothing here needs a manual flip in either direction.
 *
 * Two horizons, two questions (WI-6554700010030462). `ttlMs` answers "may selection RE-TRY this
 * account for this model yet?" — a short re-check window, because a re-try inside a live request
 * costs one transparently-failed-over 400. `reportHorizonMs` answers "do we still BELIEVE this
 * account refuses this model?" — what `/stats.codexServiceableByModel` publishes to the launch
 * preflights (psu, the consult router). Those preflights decide whether to start a whole agent
 * session; when the belief vanished with the 30-minute re-check window, a model the only healthy
 * account refuses read as "unknown", the launch went ahead and paid a session that 429-aborted
 * (measured 2026-10-27 for gpt-5.6-sol). The belief now persists until a 2xx for the pair clears
 * it, a fresh refusal re-confirms it, or the report horizon passes without either.
 */

/** Matches the ChatGPT codex backend's definitive model refusal. Shared with the launch-time
 *  preflight (`preflightCodexModel`) so the two detectors cannot drift apart. */
export const CODEX_MODEL_REFUSAL_RE = /model is not supported|unsupported model|unknown model/i;

/** How long a recorded refusal keeps the account out of selection for that model. After it lapses
 *  the account is eligible again; a still-refusing account costs one transparently-failed-over
 *  attempt per window. Env-tunable. */
export const DEFAULT_CODEX_MODEL_REFUSAL_TTL_MS =
  Number(process.env.PAPERCUSP_GATEWAY_CODEX_MODEL_REFUSAL_TTL_MS) || 30 * 60_000;

/** How long a refusal stays BELIEVED (reported to launch preflights) after its latest
 *  confirmation, absent a 2xx for the pair. Never shorter than the re-check TTL. A model refusal is
 *  a plan entitlement, which changes on the order of days, so a day bounds how long a recovered
 *  entitlement can go unnoticed when nothing else re-probes it. Env-tunable. */
export const DEFAULT_CODEX_MODEL_REFUSAL_REPORT_HORIZON_MS =
  Number(process.env.PAPERCUSP_GATEWAY_CODEX_MODEL_REFUSAL_REPORT_HORIZON_MS) || 24 * 60 * 60_000;

/** Upper bound on the error body read to classify a 4xx. Real refusal bodies are ~120 bytes. */
export const CODEX_REFUSAL_BODY_MAX_BYTES = 16 * 1024;

/**
 * Is this upstream response a definitive MODEL refusal (as opposed to an auth failure, a rate
 * limit, a server error, or a malformed request)? Only a 4xx other than 401/403/429 whose body
 * carries the refusal wording qualifies — the same rule the launch-time preflight applies.
 */
export function isCodexModelRefusal(status: number, body: string): boolean {
  if (status < 400 || status >= 500) return false;
  if (status === 401 || status === 403 || status === 429) return false;
  return CODEX_MODEL_REFUSAL_RE.test(body);
}

/** The backend's `detail` string when the body is the usual JSON envelope, else the trimmed body. */
export function codexModelRefusalDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; error?: { message?: unknown } };
    if (typeof parsed.detail === 'string') return parsed.detail.slice(0, 300);
    if (typeof parsed.error?.message === 'string') return parsed.error.message.slice(0, 300);
  } catch {
    /* not JSON */
  }
  return body.trim().slice(0, 300);
}

export interface CodexModelRefusalEntry {
  accountId: string;
  model: string;
  /** First refusal of the CURRENT belief episode (epoch ms) — kept across re-check windows until a
   *  2xx clears the pair or the report horizon lapses. */
  since: number;
  /** Most recent refusal (epoch ms). */
  lastAt: number;
  /** When selection may re-try the account for this model (epoch ms). */
  until: number;
  /** Until when the refusal is still believed and reported to launch preflights (epoch ms). */
  reportUntil: number;
  /** Refusals observed this episode. */
  hits: number;
  detail: string;
}

export interface CodexModelRefusalRegistry {
  /** Record a refusal. Returns true when this STARTS a selection exclusion (the pair was not
   *  already excluded), so callers can log/alert on the transition instead of on every request. */
  record(accountId: string, model: string, detail: string): boolean;
  /** Is `accountId` currently excluded from selection for `model`? (the short re-check window) */
  isRefused(accountId: string, model: string): boolean;
  /** Is `accountId` still believed to refuse `model`? True from a refusal until a 2xx clears it or
   *  the report horizon passes — what launch preflights are told (WI-6554700010030462). */
  isBelievedRefused(accountId: string, model: string): boolean;
  /** A 2xx for the pair — clear it now rather than waiting out the TTL. Returns true if it was marked. */
  clear(accountId: string, model: string): boolean;
  /** Entries currently excluded from selection, for /admin/stats. */
  snapshot(): CodexModelRefusalEntry[];
  /** Every still-believed entry, including those whose re-check window has lapsed. */
  believedSnapshot(): CodexModelRefusalEntry[];
  /** Seed from the durable store (WI-6554700010030570) — on gateway boot and each resync. Newer
   *  wins: a stored entry replaces the in-memory one only when its `lastAt` is later, and an entry
   *  no later than an in-memory CLEAR of the pair is ignored, so a resync that reads the store
   *  before the clear's write lands cannot resurrect it. Expired entries are skipped. Never fires
   *  `onChange`. Returns how many entries were applied. */
  hydrate(entries: ReadonlyArray<CodexModelRefusalEntry>): number;
}

/** A registry mutation, for write-through to the durable store (WI-6554700010030570). */
export type CodexModelRefusalChange =
  | { kind: 'record'; entry: CodexModelRefusalEntry }
  | { kind: 'clear'; accountId: string; model: string; at: number };

const keyOf = (accountId: string, model: string): string => `${accountId}\u0000${model.trim().toLowerCase()}`;

export function createCodexModelRefusalRegistry(
  opts: {
    ttlMs?: number;
    reportHorizonMs?: number;
    now?: () => number;
    maxEntries?: number;
    /** Write-through hook (WI-6554700010030570): fired after each record and each effective
     *  clear. Synchronous and fire-and-forget — a throw is swallowed so persistence can never
     *  break routing. */
    onChange?: (change: CodexModelRefusalChange) => void;
  } = {},
): CodexModelRefusalRegistry {
  const ttlMs = opts.ttlMs ?? DEFAULT_CODEX_MODEL_REFUSAL_TTL_MS;
  const reportHorizonMs = Math.max(ttlMs, opts.reportHorizonMs ?? DEFAULT_CODEX_MODEL_REFUSAL_REPORT_HORIZON_MS);
  const now = opts.now ?? (() => Date.now());
  const maxEntries = opts.maxEntries ?? 512;
  const entries = new Map<string, CodexModelRefusalEntry>();
  /** When each pair was last cleared by a 2xx — the hydrate guard against resurrecting it. */
  const clearedAt = new Map<string, number>();
  const notify = (change: CodexModelRefusalChange): void => {
    if (!opts.onChange) return;
    try {
      opts.onChange(change);
    } catch {
      /* persistence must never break routing */
    }
  };
  const evictIfFull = (map: Map<string, unknown>): void => {
    if (map.size < maxEntries) return;
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  };

  /** The entry while it is still believed; deleted once the report horizon has passed. */
  const believed = (key: string, at: number): CodexModelRefusalEntry | undefined => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.reportUntil <= at) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };
  /** The entry while selection still excludes the account for the model. */
  const excluded = (key: string, at: number): CodexModelRefusalEntry | undefined => {
    const entry = believed(key, at);
    return entry && entry.until > at ? entry : undefined;
  };
  const collect = (pick: (key: string, at: number) => CodexModelRefusalEntry | undefined): CodexModelRefusalEntry[] => {
    const at = now();
    const out: CodexModelRefusalEntry[] = [];
    for (const key of [...entries.keys()]) {
      const entry = pick(key, at);
      if (entry) out.push({ ...entry });
    }
    return out;
  };

  return {
    record(accountId, model, detail) {
      if (!accountId || !model) return false;
      const at = now();
      const key = keyOf(accountId, model);
      const existing = believed(key, at);
      if (existing) {
        // A re-confirmation: re-arm both horizons. Only a lapsed re-check window counts as a
        // new exclusion — the re-try just paid one refusal, so the caller logs it again.
        const startsExclusion = existing.until <= at;
        existing.lastAt = at;
        existing.until = at + ttlMs;
        existing.reportUntil = at + reportHorizonMs;
        existing.hits += 1;
        existing.detail = detail || existing.detail;
        notify({ kind: 'record', entry: { ...existing } });
        return startsExclusion;
      }
      evictIfFull(entries);
      const entry: CodexModelRefusalEntry = {
        accountId, model, since: at, lastAt: at, until: at + ttlMs, reportUntil: at + reportHorizonMs, hits: 1, detail,
      };
      entries.set(key, entry);
      clearedAt.delete(key);
      notify({ kind: 'record', entry: { ...entry } });
      return true;
    },
    isRefused(accountId, model) {
      if (!accountId || !model) return false;
      return excluded(keyOf(accountId, model), now()) !== undefined;
    },
    isBelievedRefused(accountId, model) {
      if (!accountId || !model) return false;
      return believed(keyOf(accountId, model), now()) !== undefined;
    },
    clear(accountId, model) {
      if (!accountId || !model) return false;
      const key = keyOf(accountId, model);
      if (!entries.delete(key)) return false;
      const at = now();
      clearedAt.delete(key);
      evictIfFull(clearedAt);
      clearedAt.set(key, at);
      notify({ kind: 'clear', accountId, model, at });
      return true;
    },
    snapshot: () => collect(excluded),
    believedSnapshot: () => collect(believed),
    hydrate(stored) {
      const at = now();
      let applied = 0;
      for (const e of stored) {
        if (!e?.accountId || !e.model || !(e.reportUntil > at)) continue;
        const key = keyOf(e.accountId, e.model);
        const cleared = clearedAt.get(key);
        if (cleared !== undefined && e.lastAt <= cleared) continue;
        const existing = entries.get(key);
        if (existing && existing.lastAt >= e.lastAt) continue;
        if (!existing) evictIfFull(entries);
        entries.set(key, { ...e });
        applied += 1;
      }
      return applied;
    },
  };
}
