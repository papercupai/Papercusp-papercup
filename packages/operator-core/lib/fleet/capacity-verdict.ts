/**
 * capacity-verdict.ts — THE ONE canonical answer to "are we at capacity right now?"
 * (capacity-signal-clarity-and-fleet-capacity-repair-2026-09-01 P-004).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────
 *
 * The audit this plan came from found the question answered in four places that
 * could not agree, because each saw only one leg:
 *
 *   • `accounts:status`  — the ACCOUNT POOL. Sees quota walls and rate pauses; blind
 *                          to the gateway clamping concurrency at the door.
 *   • `gateway:status`   — ADMISSION. Sees the window/in-flight/queue; blind to quota.
 *   • `fleet:capacity`   — merged both, but published `poolExhausted` / `verdict`,
 *                          which say THAT you are stuck, never WHICH TERM binds.
 *   • the burn governor  — a PACING PROJECTION, which reads exactly like a wall in
 *                          prose and is not one (P-001 / `BurnDisposition`).
 *
 * A reader who got "at capacity" from any of them could not tell whether to WAIT for a
 * provider reset, RAISE a self-imposed clamp, CHANGE a pacing policy, or look at the
 * box. Those are four different actions, and three of them are wasted on the wrong one.
 *
 * So this module derives ONE verdict from BOTH legs, and its whole point is the
 * `binding` field: the term that ACTUALLY holds the lane back, with the evidence that
 * produced it stamped with the WRITER that measured it. `atCapacity` says whether you
 * can dispatch; `binding` says what to do about it. They are separate on purpose.
 *
 * ── ⚠ THE TWO RULES THAT ARE LOAD-BEARING ──────────────────────────────────────
 *
 * 1. A PACING PROJECTION IS NEVER A WALL. `binding: 'pacing-policy'` means this system
 *    is pacing ITSELF off a projection — nothing is walled and no reset is coming.
 *    Waiting for one is the specific error the plan's P-001 and P-006 were written
 *    against. The `safeAction` on that code says so in the imperative.
 *
 * 2. UNMEASURED IS NEVER `atCapacity`. A gateway we could not reach, or a pool whose
 *    readings are all stale, is UNKNOWN — not walled. Every such leg is named in
 *    `unknown[]` so a caller who reads only the boolean still cannot mistake a blind
 *    read for a measured green. This is the same fail-safe direction `poolVerdictByProvider`
 *    takes, and it is why `atCapacity: false` alone is never sufficient evidence to launch.
 *
 * ── WHY `host` IS NOT DERIVED HERE ─────────────────────────────────────────────
 *
 * `CapacityBinding` includes `host` (the box, not the provider), and this resolver
 * CANNOT observe it: neither leg measures CPU/memory/PSI. Emitting it would be the
 * registry deriving a verdict it has no measurement for. So this function never
 * returns `host`, the cell's assessment declares only the four codes it can actually
 * emit, and the host question is carried by a POINTER to `host.memoryPressure`.
 * Answering "not this one" honestly beats answering "host" confidently.
 */

import type { AccountProvider } from '../deployment/account-pool';
import type { CapacityBinding, ProviderPoolVerdict } from '../deployment/account-pool-store';

/**
 * One measurement that SUBSTANTIATES the verdict, stamped with the writer that produced
 * it (P-004's "evidence (writer-stamped)").
 *
 * ⚠ `writer` is required and is the point of the type. The audit's recurring failure was
 * a number whose PROVENANCE was lost by the time a reader acted on it — a pacing
 * projection and a measured wall are indistinguishable once both are rendered as
 * "at capacity". A caller who distrusts a value here can go straight to the code that
 * wrote it instead of re-deriving which surface it came from.
 */
export interface CapacityEvidence {
  /** Dotted signal name, scoped by leg — e.g. `pool.walledFresh`, `admission.dispatchBudget`. */
  signal: string;
  /** The measured value, or `null` when that leg was not measured. */
  value: string | number | boolean | null;
  /** The code that PRODUCED this number — a file/function, not a surface. */
  writer: string;
  /** What this value says, in one sentence. Never a restatement of the verdict. */
  means: string;
}

/** The canonical capacity verdict for ONE provider. */
export interface CanonicalCapacityVerdict {
  provider: AccountProvider;
  /**
   * Can we dispatch right now? TRUE only on a MEASUREMENT that we cannot.
   *
   * ⚠ `false` is NOT "we are fine" when `unknown` is non-empty — it is "no measured
   * blocker", which includes "we could not measure". Read `unknown` before acting.
   */
  atCapacity: boolean;
  /**
   * WHICH TERM binds — the remedy, not the symptom. Never `host` (see the module
   * docblock); the `host.memoryPressure` cell answers that.
   */
  binding: CapacityBinding;
  /** The measurements behind the verdict, each stamped with its writer. Never empty. */
  evidence: CapacityEvidence[];
  /** The WHY, naming the provider, the binding term, and what to do about it. */
  reason: string;
  /** Legs that could NOT be measured. Empty means both legs answered. */
  unknown: string[];
}

/** The admission leg, structurally — a subset of `CapacityReport` so this module does
 *  not import the gateway's whole read-model (and cannot cycle back into it). */
export interface AdmissionTerms {
  /** Did the gateway answer at all? `false` ⇒ admission is UNMEASURED, not open. */
  reachable: boolean;
  /** The reading is blind/stale (a probe got no answer) ⇒ treat as unmeasured. */
  blind: boolean;
  /** Spare dispatch slots (cap − inFlight − queued). `null` ⇒ not measured. */
  dispatchBudget: number | null;
  /** Requests in flight right now. `null` ⇒ not measured. */
  inFlight: number | null;
}

/**
 * The gateway OUTCOME leg: what the gateway actually did with requests over a recent
 * window (WI-6554700010029776). The pool and admission legs are both point-in-time
 * readings of capacity; neither sees the gateway refusing requests — the gateway can
 * shed hundreds an hour while every pool row reads serviceable and admission has
 * spare slots. This leg is the only one that measures refusals that already happened.
 */
export interface GatewayOutcomeTerms {
  windowMinutes: number;
  /** `shed` + `upstream-429` in the window. */
  refused: number;
  /** `ok` in the window. Client cancellations count in neither. */
  served: number;
  /** Distinct callers that saw at least one refusal. */
  refusedOwners: number;
  /** The caller with the most refusals, or null when nothing was refused. */
  topRefusedOwner: { ownerId: string | null; refused: number } | null;
}

/** Refusals below this count are noise, whatever their share. */
export const GATEWAY_REFUSAL_MIN_COUNT = 10;
/** Refused share of (refused + served) at or above which refusals bind. */
export const GATEWAY_REFUSAL_MIN_SHARE = 0.05;
/** A caller holding at least this share of the refusals makes them caller-concentrated. */
export const GATEWAY_REFUSAL_CONCENTRATED_SHARE = 0.8;

const POOL_WRITER = 'poolVerdictByProvider() @ lib/deployment/account-pool-store.ts';
const ADMISSION_WRITER = 'buildCapacityReport() @ lib/fleet/capacity-dispatch.ts (gateway /stats)';
const OUTCOME_WRITER = 'summarizeGatewayProviderOutcomes() @ lib/inference-gateway/gateway-request-outcome-store.ts';

function refusalShare(o: GatewayOutcomeTerms): number {
  const total = o.refused + o.served;
  return total > 0 ? o.refused / total : 0;
}

/** Are refusals in the window frequent enough to bind? */
export function gatewayRefusalsBinding(o: GatewayOutcomeTerms): boolean {
  return o.refused >= GATEWAY_REFUSAL_MIN_COUNT && refusalShare(o) >= GATEWAY_REFUSAL_MIN_SHARE;
}

function describeRefusals(provider: AccountProvider, o: GatewayOutcomeTerms): string {
  const pct = Math.round(refusalShare(o) * 1000) / 10;
  const base =
    `the gateway refused ${o.refused} '${provider}' request(s) and served ${o.served} in the last ` +
    `${o.windowMinutes}m (${pct}% refused) across ${o.refusedOwners} caller(s)`;
  const top = o.topRefusedOwner;
  if (top && o.refused > 0 && top.refused / o.refused >= GATEWAY_REFUSAL_CONCENTRATED_SHARE) {
    return (
      `${base}; ${top.refused} of them came from ONE caller (${top.ownerId ?? 'unattributed'}), so the ` +
      `refusals are concentrated in that caller's routing (e.g. pinned to walled accounts), not a ` +
      `fleet-wide lack of headroom — fix that caller's account routing`
    );
  }
  return base;
}

/**
 * Merge the account-pool rollup (P-002) with the gateway admission snapshot into the ONE
 * canonical verdict.
 *
 * PRECEDENCE, and why it is this order:
 *   1. `usage-wall`            — a MEASURED provider wall. Beats everything because
 *                                retrying is futile until the window resets; no local
 *                                change to admission or pacing can relieve it.
 *   2. `admission-concurrency` — the accounts CAN serve and we are refusing at our own
 *                                door. Ranked below a wall (raising a self-imposed clamp
 *                                cannot help a walled pool) and above pacing (it is a
 *                                hard zero right now, where pacing still passes traffic).
 *   3. `pacing-policy`         — this system pacing itself off a projection. NOTHING is
 *                                walled; see rule 1 in the module docblock.
 *   3b. `gateway-shed`         — no point-in-time leg binds, yet the gateway measurably
 *                                refused requests in the recent window (shed + upstream 429
 *                                over GATEWAY_REFUSAL_MIN_COUNT and _MIN_SHARE).
 *   4. `none`                  — no measured blocker. Check `unknown` before believing it.
 *
 * Pure over its inputs, so the cell, the tool surface and any future panel derive from
 * ONE implementation and can never disagree.
 */
export function deriveCapacityVerdict(input: {
  provider: AccountProvider;
  /** The P-002 rollup for THIS provider, or `null` when no rows / the read failed. */
  pool: ProviderPoolVerdict | null;
  admission: AdmissionTerms;
  /**
   * The gateway outcome window for THIS provider, or `null` when it could not be read.
   * Required on purpose: an omitted leg must be an explicit `null` (⇒ UNMEASURED), never
   * a silently-absent one that lets the verdict read as a measured green.
   */
  outcomes: GatewayOutcomeTerms | null;
}): CanonicalCapacityVerdict {
  const { provider, pool, admission, outcomes } = input;
  const unknown: string[] = [];
  const evidence: CapacityEvidence[] = [];

  // ── The gateway OUTCOME leg. Unreadable is UNMEASURED, never "no refusals".
  if (!outcomes) {
    unknown.push(
      `gateway outcomes: the '${provider}' refusal rate could not be read, so refusals are UNMEASURED — not zero`,
    );
  }
  evidence.push({
    signal: 'gateway.refusedRecent',
    value: outcomes ? outcomes.refused : null,
    writer: OUTCOME_WRITER,
    means: outcomes
      ? `${describeRefusals(provider, outcomes)}`
      : "the gateway's refusals (its own and upstream 429s) were not measured on this read",
  });

  // ── The POOL leg.
  if (!pool) {
    unknown.push(
      `account pool: no '${provider}' rows were readable, so quota/pause state is UNMEASURED — not clear`,
    );
    evidence.push({
      signal: 'pool.rows',
      value: null,
      writer: POOL_WRITER,
      means: `no '${provider}' account rows were readable; this leg contributed no measurement`,
    });
  } else {
    if (pool.unknown > 0) {
      unknown.push(
        `account pool: ${pool.unknown} of ${pool.total} '${provider}' reading(s) are stale or never-observed ` +
          `— refresh with accounts:probe-capacity before treating this pool as measured`,
      );
    }
    evidence.push(
      {
        signal: 'pool.serviceable',
        value: pool.serviceable,
        writer: POOL_WRITER,
        means: `${pool.serviceable} of ${pool.total} account(s) can serve right now on a FRESH reading`,
      },
      {
        signal: 'pool.walledFresh',
        value: pool.walledFresh,
        writer: POOL_WRITER,
        means: `${pool.walledFresh} account(s) are measurably usage-walled (an exhausted usage window)`,
      },
      {
        signal: 'pool.paused',
        value: pool.paused,
        writer: POOL_WRITER,
        means: `${pool.paused} account(s) are inside a local rate-limit pause window right now`,
      },
      {
        signal: 'pool.pacing',
        value: pool.pacing,
        writer: POOL_WRITER,
        means:
          `${pool.pacing} account(s) are under a burn PACING PROJECTION — they still SERVE; ` +
          `never add these to the walls`,
      },
      {
        signal: 'pool.unknown',
        value: pool.unknown,
        writer: POOL_WRITER,
        means: `${pool.unknown} reading(s) carry no measurement (stale / never-observed / last probe got no answer)`,
      },
    );
  }

  // ── The ADMISSION leg. Unreachable or blind is UNMEASURED, never "open".
  const admissionMeasured = admission.reachable && !admission.blind && admission.dispatchBudget != null;
  if (!admission.reachable) {
    unknown.push('admission: the gateway did not answer, so the concurrency window is UNMEASURED — not open');
  } else if (admission.blind) {
    unknown.push('admission: the gateway reading is blind/stale, so the concurrency window is UNMEASURED — not open');
  } else if (admission.dispatchBudget == null) {
    unknown.push('admission: the gateway answered but reported no dispatchBudget, so spare slots are UNMEASURED');
  }
  evidence.push(
    {
      signal: 'admission.dispatchBudget',
      value: admissionMeasured ? admission.dispatchBudget : null,
      writer: ADMISSION_WRITER,
      means: admissionMeasured
        ? `${admission.dispatchBudget} spare dispatch slot(s) at the door (cap − inFlight − queued)`
        : 'spare dispatch slots were not measured on this read',
    },
    {
      signal: 'admission.inFlight',
      value: admission.reachable ? admission.inFlight : null,
      writer: ADMISSION_WRITER,
      means:
        admission.reachable && admission.inFlight != null
          ? `${admission.inFlight} request(s) in flight right now (traffic IS passing)`
          : 'in-flight traffic was not measured on this read',
    },
  );

  const at = (binding: CapacityBinding, atCapacity: boolean, reason: string): CanonicalCapacityVerdict => ({
    provider,
    atCapacity,
    binding,
    evidence,
    reason,
    unknown,
  });

  // 1. A PROVIDER WALL.
  //
  // ⚠ GATED ON THE POOL'S `binding`, NOT ON ITS `atCapacity` — the two answer different
  // questions and conflating them produced a live false-green. Measured against the real
  // pool 2026-09-01: serviceable 0, walledFresh 6, unknown 1 of 7. `atCapacity` was FALSE
  // (correctly — one stale reading could still serve), so an `atCapacity &&` guard fell
  // through every branch to `binding: 'none'` — "no term is measurably binding" — with six
  // accounts measurably walled. That is the exact confident-wrong direction this plan exists
  // to remove.
  //
  // So: `binding` reports WHICH TERM the pool measured (the remedy), and `atCapacity` carries
  // whether the pool is FULLY measured (the confidence). Propagate the pool's own `atCapacity`
  // rather than asserting one — it is already fail-safe about the unmeasured rows.
  if (pool && pool.binding === 'usage-wall') {
    return at(
      'usage-wall',
      pool.atCapacity,
      pool.atCapacity
        ? `'${provider}' is MEASURABLY at capacity: no account can serve on a fresh reading ` +
            `(${pool.walledFresh} usage-walled, ${pool.paused} rate-paused of ${pool.total}), and every reading ` +
            `is fresh. This is a provider wall — retrying is futile until a usage window resets. Do NOT raise ` +
            `admission or change pacing; neither can relieve it.`
        : `'${provider}' is PROBABLY walled but NOT measurably at capacity: no account can serve on a fresh ` +
            `reading (${pool.walledFresh} usage-walled, ${pool.paused} rate-paused of ${pool.total}), yet ` +
            `${pool.unknown} reading(s) are stale/never-observed and could still serve. The binding term IS a ` +
            `provider wall — do not treat this as clear — but refresh with accounts:probe-capacity before ` +
            `declaring the pool exhausted or escalating.`,
    );
  }

  // 2. OUR OWN DOOR. Admission is measurably refusing — a self-imposed clamp, a different
  //    remedy from every other branch and one no previous surface named. Reached only when the
  //    pool did NOT name a wall above, so this cannot mask a provider wall.
  if (admissionMeasured && admission.dispatchBudget === 0) {
    const serving = pool ? `${pool.serviceable} of ${pool.total} account(s) can serve` : 'the account pool was not measured';
    return at(
      'admission-concurrency',
      true,
      `'${provider}' cannot dispatch right now and the binding term is OUR OWN admission clamp, not the ` +
        `provider: the gateway is holding the lane at 0 spare slots while ${serving}. Raise the window or wait ` +
        `for in-flight work to drain. Do NOT wait for a provider reset and do NOT escalate to the owner.`,
    );
  }

  const refusing = outcomes != null && gatewayRefusalsBinding(outcomes);

  // 3. PACING. Reported as a policy, never as a wall — the plan's whole thesis.
  if (pool && pool.binding === 'pacing-policy') {
    return at(
      'pacing-policy',
      pool.atCapacity,
      `'${provider}' is under a burn PACING PROJECTION, not a provider wall — ${pool.pacing} account(s) are ` +
        `paced by this system's own burn governor off a projected exhaustion, and NOTHING is measurably walled. ` +
        `No provider reset is coming, because there is nothing to reset. Relieve it by changing the pacing ` +
        `policy (or accepting the burn), never by waiting.` +
        (refusing ? ` Meanwhile ${describeRefusals(provider, outcomes!)}.` : ''),
    );
  }

  // 3b. GATEWAY REFUSALS. Neither point-in-time leg names a blocker, yet the gateway
  //     measurably turned requests away in the window. Ranked below pacing (pacing names
  //     its own remedy and already carries the refusal note) and above `none`, because
  //     reporting `none` here is the measured-green-while-shedding this leg exists to stop.
  //     `atCapacity` only when NOTHING was served: refusals alongside served traffic mean
  //     the lane still dispatches, just not for every caller.
  if (refusing) {
    return at(
      'gateway-shed',
      outcomes!.served === 0,
      `'${provider}' has no point-in-time blocker (no wall, admission open, no pacing), but ` +
        `${describeRefusals(provider, outcomes!)}. Do NOT read this lane as a measured green. Look at which ` +
        `accounts the refused requests were routed to (gateway_request_outcomes.selected_account_id) before ` +
        `launching more work on it.`,
    );
  }

  // 4. NO MEASURED BLOCKER. Says so without claiming the unmeasured legs are clear.
  const clear =
    unknown.length === 0
      ? `every leg was measured, so this is a measured green`
      : `⚠ but ${unknown.length} leg(s) were NOT measured (see unknown[]) — this is "no measured blocker", ` +
        `NOT a measured green; do not treat it as proof a launch will succeed`;
  return at(
    'none',
    false,
    `no term is measurably binding '${provider}' — ${clear}.`,
  );
}
