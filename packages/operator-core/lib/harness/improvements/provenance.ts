/**
 * provenance.ts — signal-origin provenance for learning-signal rows
 * (self-learning-frontier-2026-06-12 P-002 / D-002, brief FB-03).
 *
 * Every learning-signal row (improvements captures — agent-filed and
 * watchdog-filed alike — and everything the loop derives from them) carries an
 * origin so synthetic signals from the frontier loops can coexist with the live
 * loop without polluting organic learners:
 *
 *   - organic — a real signal from live operation (the default, and the only
 *     origin any consumer sees unless it explicitly opts in);
 *   - drill   — a vaccination-planted synthetic friction (Red Queen, P-031);
 *   - replay  — output of a counterfactual replay run (P-020/P-021);
 *   - shadow  — output of a shadow ablation (P-023).
 *
 * Storage: `engineer_issues.signal_origin` (migration 241 — NOT `origin`, which
 * is the federation local/remote column from migration 108). The read-side
 * default is enforced at the ONE repointable read seam (read-items.ts), so
 * every loop consumer — digest, triage, decay, hygiene, recurrence escalation,
 * gym routed ideas, scout corpus/cadence, the implement loop, the Learning tab
 * resolver — inherits organic-only without per-consumer code.
 *
 * Filtering is EXACT-match allowlisting: a row reaches a consumer only when its
 * stored origin is in the allowed set, so a junk/unknown value fails CLOSED
 * (excluded everywhere) rather than leaking into organic learners. The one
 * deliberate exception: a row with NO stored origin (pre-migration legacy rows,
 * unit-test fakes that predate the column) reads as organic — that is exactly
 * what the migration's DEFAULT backfills, not a guess.
 */

/** Provenance of a learning-signal row (D-002). */
export type SignalOrigin = 'organic' | 'drill' | 'replay' | 'shadow';

export const SIGNAL_ORIGINS: readonly SignalOrigin[] = ['organic', 'drill', 'replay', 'shadow'];

/** The write-path default: every capture that does not say otherwise is organic. */
export const DEFAULT_SIGNAL_ORIGIN: SignalOrigin = 'organic';

/** The read-path default allowlist (D-002): organic only. */
export const ORGANIC_ONLY: readonly SignalOrigin[] = ['organic'];

export function isSignalOrigin(v: unknown): v is SignalOrigin {
  return typeof v === 'string' && (SIGNAL_ORIGINS as readonly string[]).includes(v);
}

/**
 * Resolve a row's effective origin: a missing value (legacy row / pre-column
 * fake) is organic by the migration-DEFAULT argument above; anything else is
 * the raw stored value, NOT normalized — junk stays junk so it matches no
 * allowlist.
 */
export function effectiveOrigin(stored: unknown): string {
  return stored == null ? DEFAULT_SIGNAL_ORIGIN : String(stored);
}

/** Exact-match allowlist check over the EFFECTIVE origin (fail-closed on junk). */
export function originAllowed(stored: unknown, allowed: readonly SignalOrigin[] = ORGANIC_ONLY): boolean {
  return (allowed as readonly string[]).includes(effectiveOrigin(stored));
}

// ─── Reporter provenance (unified-bug-pipeline-and-honest-queue-2026-10-05 P-010, D-001) ───
//
// A SECOND axis, independent of SignalOrigin above: origin says whether a signal
// is real or synthetic; the reporter says WHO filed it. A person's report is the
// same bug work item agents file, distinguished only by this stamp and its
// captured context (D-001), so every issue-family row carries one.
//
// Stored at `payload.reporter` on mint. `payload.reporterKinds` is the
// corroboration record's per-kind tally: the distinct reporter kinds that have
// filed the same condition (folds append to it; it never shrinks).

/**
 * Who filed a work item. 'end-user' is a person reporting through a Papercusp
 * door (the in-app reporter, a rule-admitted ticket); 'chat' is a person
 * reporting from a chat workspace such as Slack
 * (slack-messages-to-bug-reports-2026-10-05 P-005, D-012).
 */
export type ReporterKind = 'agent' | 'watchdog' | 'end-user' | 'chat';

export const REPORTER_KINDS: readonly ReporterKind[] = ['agent', 'watchdog', 'end-user', 'chat'];

/** The reporter kinds a PERSON files under. */
export const PERSON_REPORTER_KINDS: readonly ReporterKind[] = ['end-user', 'chat'];

/**
 * True when a person filed the report, so its text is untrusted evidence
 * (quoted at intake, unified D-003) and it is never a stranded tool failure.
 * Every rule about "a person's report" keys on this, never on one kind.
 */
export function isPersonReporterKind(kind: unknown): kind is 'end-user' | 'chat' {
  return typeof kind === 'string' && (PERSON_REPORTER_KINDS as readonly string[]).includes(kind);
}

/**
 * Why the stored kind is what it is, so a wrong inference is diagnosable from
 * the row itself:
 *   - explicit        — the filing door named the kind (the in-app reporter
 *                       passes 'end-user'; a watchdog may pass 'watchdog');
 *   - system-identity — `createdBy` is a `system:<emitter>` identity or the
 *                       caller declared sourceRole 'system';
 *   - no-session      — no filing identity at all. Measured 2026-10-06 (7 days,
 *                       88 of 4,843 bug rows): every such row was a machine
 *                       condition (LEARNING LOOP, LOOP WEDGED, green-stall), so
 *                       it reads as a watchdog — but says it was inferred;
 *   - agent-session   — a session identity filed it.
 * NOTE sourceRole 'human' is deliberately NOT an end-user signal: capture
 * defaults an omitted sourceRole to 'human', so every agent filing carries it.
 */
export type ReporterBasis = 'explicit' | 'system-identity' | 'no-session' | 'agent-session';

export interface ReporterProvenance {
  kind: ReporterKind;
  /** The filing identity (session id, `system:<emitter>`, install id), or null. */
  id: string | null;
  basis: ReporterBasis;
  /** ISO timestamp of the filing. */
  at: string;
}

export function isReporterKind(v: unknown): v is ReporterKind {
  return typeof v === 'string' && (REPORTER_KINDS as readonly string[]).includes(v);
}

/** Derive the reporter stamp for a filing. Pure; never throws. */
export function deriveReporterProvenance(args: {
  explicitKind?: unknown;
  createdBy?: string | null;
  /** The RAW caller-declared sourceRole — never capture's 'human' default. */
  sourceRole?: unknown;
  at: string;
}): ReporterProvenance {
  const id = typeof args.createdBy === 'string' && args.createdBy.trim() ? args.createdBy.trim() : null;
  if (isReporterKind(args.explicitKind)) return { kind: args.explicitKind, id, basis: 'explicit', at: args.at };
  if ((id && id.startsWith('system:')) || args.sourceRole === 'system') {
    return { kind: 'watchdog', id, basis: 'system-identity', at: args.at };
  }
  if (!id) return { kind: 'watchdog', id: null, basis: 'no-session', at: args.at };
  return { kind: 'agent', id, basis: 'agent-session', at: args.at };
}

/** Read a stored reporter stamp, or null when the row has none (legacy row) or it is malformed. */
export function storedReporter(payload: unknown): ReporterProvenance | null {
  const raw = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).reporter : null;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isReporterKind(r.kind)) return null;
  const basis = r.basis;
  return {
    kind: r.kind,
    id: typeof r.id === 'string' ? r.id : null,
    basis:
      basis === 'explicit' || basis === 'system-identity' || basis === 'no-session' || basis === 'agent-session'
        ? basis
        : 'explicit',
    at: typeof r.at === 'string' ? r.at : '',
  };
}

/**
 * The effective reporter of a row: its stored stamp, or — for a legacy row
 * minted before P-010 — the same derivation the writer would have applied.
 */
export function effectiveReporter(row: { payload?: unknown; createdBy?: string | null; createdAt?: string | null }): ReporterProvenance {
  const stored = storedReporter(row.payload);
  if (stored) return stored;
  const sourceRole = row.payload && typeof row.payload === 'object'
    ? (row.payload as Record<string, unknown>).sourceRole
    : undefined;
  return deriveReporterProvenance({ createdBy: row.createdBy ?? null, sourceRole, at: row.createdAt ?? '' });
}

/**
 * The corroboration record's reporter-kind tally after one more filing folds in:
 * the prior `reporterKinds` (or the prior stamp's kind for a row that predates
 * the tally), plus the incoming kind, de-duplicated in canonical order.
 */
export function mergeReporterKinds(priorPayload: unknown, incoming: ReporterKind): ReporterKind[] {
  const p = priorPayload && typeof priorPayload === 'object' ? (priorPayload as Record<string, unknown>) : {};
  const seen = new Set<ReporterKind>();
  if (Array.isArray(p.reporterKinds)) for (const k of p.reporterKinds) if (isReporterKind(k)) seen.add(k);
  const priorStamp = storedReporter(p);
  if (priorStamp) seen.add(priorStamp.kind);
  seen.add(incoming);
  return REPORTER_KINDS.filter((k) => seen.has(k));
}
