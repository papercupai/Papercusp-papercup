/**
 * Carried-check probe evaluation at DELIVERY time (plan carry-recheck-and-governed-memory-2026-10-14,
 * P-001 / R-1 / R-10).
 *
 * coord:orient already replays executable carried-check probes (WI-42290, D-004). The automatic
 * delivery paths did not: the loop wake's LIVE RE-CHECK block and the post-compaction recovery
 * printed each stored check's claim and probe text but never ran the probe, so a waking agent had
 * to re-run every re-check by hand (or, worse, trust the carried claim).
 *
 * This module is the delivery-side adapter over the EXISTING runner — no second runner, no new
 * store (D-003):
 *   - `carriedProbeSources` turns already-read check rows into runner sources;
 *   - `runCarriedProbesForDelivery` runs them through `runContinuityProbeBatch`, which already
 *     refuses any probe that is not provably read-only WITHOUT dispatching it, caps the probe count
 *     per wake and bounds each probe's time;
 *   - `renderCarriedProbeBlock` renders one line per probe that changed (with the observed value)
 *     or could not run (with the reason), plus a line for probes left un-run by the cap. A probe
 *     that still matches prints nothing, and a delivery where every probe matched prints no block
 *     at all (D-001 'prints nothing when nothing changed'; bars R-1/R-25). The header still counts
 *     the matching probes whenever a block is printed.
 *
 * Deterministic only (D-001): read-only tool dispatch and string formatting, no model call.
 * Fail-soft but never falsely green: a runner failure renders an explicit "could not run" line, it
 * never disappears into silence that a reader would take for "everything holds".
 */
import type { CheckEntry } from './carry-note';
import {
  CONTINUITY_PROBE_CONCURRENCY,
  CONTINUITY_PROBE_MAX_PER_WAKE,
  CONTINUITY_PROBE_TIMEOUT_MS,
  runContinuityProbeBatch,
  type ContinuityProbeDispatchContext,
  type ContinuityProbeResult,
  type ContinuityProbeSource,
} from './continuity-probes';
import { withBoundedTimeout } from './bounded-timeout';

export type CarriedProbeBatch = Awaited<ReturnType<typeof runContinuityProbeBatch>>;

/** What a delivery-time probe run produced: a batch, or an explicit failure to run at all. */
export type CarriedProbeOutcome = { kind: 'batch'; batch: CarriedProbeBatch } | { kind: 'failed'; reason: string };

/** Longest claim text rendered per line; the full claim stays in the checkpoint. */
export const CARRIED_PROBE_CLAIM_CHARS = 160;
/** Longest diagnostic message rendered per could-not-run line. */
export const CARRIED_PROBE_REASON_CHARS = 220;
/** Longest observed-value rendering per changed line. */
export const CARRIED_PROBE_OBSERVED_CHARS = 120;

/**
 * Whole-run ceiling for the delivery path: the runner bounds each probe, and the batch runs at most
 * CONTINUITY_PROBE_MAX_PER_WAKE probes CONTINUITY_PROBE_CONCURRENCY at a time, so this is the
 * worst case of those bounds plus one probe's slack. A delivery never waits longer than this.
 */
export function carriedProbeRunCeilingMs(timeoutMs: number = CONTINUITY_PROBE_TIMEOUT_MS): number {
  const waves = Math.ceil(CONTINUITY_PROBE_MAX_PER_WAKE / CONTINUITY_PROBE_CONCURRENCY);
  return (waves + 1) * timeoutMs;
}

export interface CarriedProbeSourceInput {
  /** The loop carry-note's checks, already split from the note the caller read. */
  loop?: { ownerId: string; checks: readonly CheckEntry[] } | null;
  /** Held work-items' checks, already split from their checkpoints. */
  workItems?: ReadonlyArray<{ id: string; harness?: string | null; checks: readonly CheckEntry[] }>;
}

/** Build runner sources from already-read check rows (loop first, then held items, in order). */
export function carriedProbeSources(input: CarriedProbeSourceInput): ContinuityProbeSource[] {
  const out: ContinuityProbeSource[] = [];
  if (input.loop) {
    for (const [checkIndex, check] of input.loop.checks.entries()) {
      out.push({ source: { kind: 'loop', ownerId: input.loop.ownerId }, checkIndex, check });
    }
  }
  for (const item of input.workItems ?? []) {
    for (const [checkIndex, check] of item.checks.entries()) {
      out.push({ source: { kind: 'work-item', id: item.id, harness: item.harness ?? null }, checkIndex, check });
    }
  }
  return out;
}

export interface CarriedProbeDeliveryDeps {
  /** Read-only dispatcher. Defaults to the harness-scoped palette dispatcher re-score uses. */
  dispatchTool?: ContinuityProbeDispatchContext['dispatchTool'];
  /** Harness the default dispatcher scopes to. */
  harness?: string | null;
  /** Trusted delivery workspace; background dispatch must not use the desktop's current workspace. */
  workspaceId?: string | null;
  /** Per-probe budget (defaults to the runner's wake budget). */
  timeoutMs?: number;
  /** Injectable runner (tests). */
  runBatch?: typeof runContinuityProbeBatch;
}

/**
 * Run every carried probe in `sources` through the existing bounded read-only runner.
 * Returns null when no source carries a probe (nothing to say, no dispatcher is loaded).
 * Never throws: a runner failure or overrun becomes `{ kind: 'failed', reason }`.
 */
export async function runCarriedProbesForDelivery(
  sources: readonly ContinuityProbeSource[],
  deps: CarriedProbeDeliveryDeps = {},
): Promise<CarriedProbeOutcome | null> {
  if (!sources.some((source) => source.check.probe !== undefined)) return null;
  try {
    let dispatchTool = deps.dispatchTool;
    if (!dispatchTool) {
      const { rescoreProbeDispatcher } = await import('./harness/routines/rubric-rescore-action');
      dispatchTool = rescoreProbeDispatcher(deps.harness ?? undefined, undefined, deps.workspaceId ?? undefined);
    }
    const run = deps.runBatch ?? runContinuityProbeBatch;
    const timeoutMs = deps.timeoutMs ?? CONTINUITY_PROBE_TIMEOUT_MS;
    const ceilingMs = carriedProbeRunCeilingMs(timeoutMs);
    const bounded = await withBoundedTimeout<CarriedProbeBatch | null>(
      () => run(sources, { dispatchTool, timeoutMs }),
      { fallback: null, timeoutMs: ceilingMs, label: 'carry-probe-eval:delivery' },
    );
    if (bounded.degraded || bounded.value === null) {
      const why =
        bounded.reason === 'timeout'
          ? `the probe run exceeded its ${ceilingMs}ms delivery ceiling`
          : bounded.errorMessage ?? bounded.reason ?? 'the probe runner returned nothing';
      return { kind: 'failed', reason: why };
    }
    return { kind: 'batch', batch: bounded.value };
  } catch (err) {
    return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function sourceLabel(result: ContinuityProbeResult): string {
  const where = result.source.kind === 'loop' ? 'loop' : result.source.id;
  const which = result.checkId ? `#${result.checkId}` : `check ${result.checkIndex + 1}`;
  return `${where} ${which}`;
}

function renderObserved(value: unknown): string {
  if (value === undefined) return '(not a scalar — re-run the check to see it)';
  let text: string;
  try {
    text = typeof value === 'string' ? JSON.stringify(value) : String(JSON.stringify(value));
  } catch {
    text = String(value);
  }
  return clip(text, CARRIED_PROBE_OBSERVED_CHARS);
}

function renderReason(result: ContinuityProbeResult): string {
  const d = result.diagnostic;
  if (!d) return 'no diagnostic was returned';
  return clip(`${d.code} — ${d.message}`, CARRIED_PROBE_REASON_CHARS);
}

/**
 * Render a delivery-time probe outcome. Every evaluated probe gets exactly one line:
 *   ✗ CHANGED        — the probe ran and its expect no longer matches (observed value shown);
 *   ? COULD NOT RUN  — refused (not read-only, drifted contract, invalid args) or failed to read;
 *   ✓ HOLDS          — the probe ran and its expect still matches.
 * Probes beyond the per-wake cap get one count line. Returns null when there was nothing to run.
 */
export function renderCarriedProbeBlock(
  outcome: CarriedProbeOutcome | null | undefined,
  opts: { readAtIso?: string } = {},
): string | null {
  if (!outcome) return null;
  const at = opts.readAtIso ? ` (readAt=${opts.readAtIso})` : '';
  if (outcome.kind === 'failed') {
    return (
      `🧪 CARRIED PROBES — COULD NOT RUN at delivery${at}: ${clip(outcome.reason, CARRIED_PROBE_REASON_CHARS)}. ` +
      `This is NOT evidence the carried checks hold; run their re-checks before relying on them.`
    );
  }
  const { batch } = outcome;
  if (batch.total === 0) return null;
  const changed = batch.results.filter((r) => r.status === 'stale');
  const couldNotRun = batch.results.filter((r) => r.status === 'error' || r.status === 'unknown');
  const holds = batch.results.filter((r) => r.status === 'fresh');
  // D-001 / R-25: a probe that still matches prints nothing, and a delivery where every probe
  // matched (none changed, none failed, none left un-run by the cap) prints no block at all.
  if (changed.length === 0 && couldNotRun.length === 0 && batch.truncated === 0) return null;
  const counts = [
    `${holds.length} hold`,
    `${changed.length} changed`,
    `${couldNotRun.length} could not run`,
    ...(batch.truncated > 0 ? [`${batch.truncated} not run`] : []),
  ].join(' · ');
  const lines = [
    `🧪 CARRIED PROBES re-run at delivery${at} — ${counts} (read-only, deterministic; a changed probe means its carried claim no longer holds):`,
    ...changed.map(
      (r) => `  ✗ CHANGED — ${clip(r.claim, CARRIED_PROBE_CLAIM_CHARS)} [${sourceLabel(r)}]: observed ${renderObserved(r.observed)}`,
    ),
    ...couldNotRun.map(
      (r) => `  ? COULD NOT RUN — ${clip(r.claim, CARRIED_PROBE_CLAIM_CHARS)} [${sourceLabel(r)}]: ${renderReason(r)}`,
    ),
  ];
  if (batch.truncated > 0) {
    lines.push(
      `  … ${batch.truncated} more carried probe(s) were NOT run (per-delivery cap ${batch.limits.maxProbes} probes / result budget) — run their re-checks by hand before relying on them.`,
    );
  }
  return lines.join('\n');
}

/** Run + render in one call: the shape both delivery seams use. Never throws. */
export async function carriedProbeBlockForDelivery(
  sources: readonly ContinuityProbeSource[],
  deps: CarriedProbeDeliveryDeps & { readAtIso?: string } = {},
): Promise<string | null> {
  const outcome = await runCarriedProbesForDelivery(sources, deps);
  return renderCarriedProbeBlock(outcome, { readAtIso: deps.readAtIso });
}
