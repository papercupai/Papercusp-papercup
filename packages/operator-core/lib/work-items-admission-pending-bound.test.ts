import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  ADMISSION_CREATE_BYPASSES,
  ADMISSION_DEGRADED_RESCREEN_ATTEMPTS,
  ADMISSION_FAIL_OPEN_EXCLUSIONS,
  ADMISSION_FAIL_OPEN_TICKS,
  asAdmissionFailOpenExclusion,
  DEFAULT_PROMOTER_TICK_MINUTES,
  admissionFailOpenSec,
  admissionFailOpenGuaranteedSec,
  admissionPendingCreateRemedy,
  admissionPendingExplanation,
  admissionPromoterTickSec,
  admissionPromoterStall,
  admissionStallBasis,
  classifyAdmissionPromoterStall,
} from './work-items-admission';

/**
 * EI-21973318733042066 — the `admission-pending` claim floor is a WAIT, and it has to say so
 * with a number.
 *
 * A launched independent reviewer was briefed to claim a review work-item created seconds
 * earlier as its first act. `work_items:claim` refused twice with `not_claimable /
 * admission-pending`, whose whole explanation was "wait for admitted/unreviewed" — no bound,
 * no remedy. MEASURED on this box: the promoter is a 30-minute durable cron, and across 289
 * items admitted in the 48h before the report, pending→admitted ran p50 978s / p95 2003s /
 * max 4531s. The reporter's own item sat pending 22.5 minutes, which outlived the entire
 * 9-minute lifetime of the agent it was created for — so "retry until it clears" was never
 * available to the one agent that would ever touch it.
 *
 * These tests pin the two properties that make the refusal actionable, and both are pinned
 * as DERIVATIONS rather than as text: a hand-written "30 minutes" in the explanation is a
 * second copy of a truth the routine owns, and would drift the first time the cadence moved.
 */
describe('admission-pending states a bound, derived from the promoter cadence', () => {
  it('the explanation derives BOTH numbers from the tick — it does not restate them', () => {
    // The parametrised call is the whole point: a hardcoded "30-minute" survives the default
    // assertion below and fails here, which is the only difference that matters.
    const sevenMinuteTick = admissionPendingExplanation(7);
    expect(sevenMinuteTick).toContain('7-minute');
    expect(sevenMinuteTick).toContain(`${ADMISSION_FAIL_OPEN_TICKS * 7} min`);
    expect(sevenMinuteTick).not.toContain('30-minute');

    const live = admissionPendingExplanation();
    expect(live).toContain(`${DEFAULT_PROMOTER_TICK_MINUTES}-minute`);
    expect(live).toContain(`${ADMISSION_FAIL_OPEN_TICKS * DEFAULT_PROMOTER_TICK_MINUTES} min`);
  });

  it('it says the floor CLEARS ON ITS OWN — the distinction the reporter could not make', () => {
    const live = admissionPendingExplanation();
    // "not yet" vs "never" is the actual decision a refused caller has to make. Every other
    // permanent floor (observation-lane, federation-detector, already-completed) reads the
    // same shape, so the temporal ones have to say which they are.
    expect(live).toMatch(/CLEARS ON ITS\s+OWN/);
    expect(live).toContain('not a permanent');
    // And it must not be silently reassuring: waiting out most of a tick is usually wrong for
    // a short-lived agent, which is exactly what the reporter discovered the expensive way.
    expect(live).toMatch(/outlives|wrong move/);
  });

  /**
   * WI-6554700010018098: the fail-open runner never admits a row carrying duplicate candidates
   * (work-queue-exclusion-alarm-duplicates-2026-10-16 P-002), so quoting its ceiling to such a
   * row was a false guarantee — rows sat pending 9-21h under a "60 min" promise. Candidate rows
   * get their own explanation, with NO fail-open ceiling in it; the row-agnostic sentence names
   * both exceptions instead of promising the ceiling unconditionally.
   */
  it('a candidate-carrying row is told the wait has no fixed bound, never the fail-open ceiling', () => {
    const candidate = admissionPendingExplanation(undefined, { failOpenExclusion: 'duplicate-candidates' });
    expect(candidate).toContain('DUPLICATE CANDIDATES');
    expect(candidate).toContain('NO fixed bound');
    expect(candidate).not.toContain(`${ADMISSION_FAIL_OPEN_TICKS * DEFAULT_PROMOTER_TICK_MINUTES} min`);
    expect(candidate).not.toMatch(/admits (anything|a row) still pending/);

    const generic = admissionPendingExplanation();
    expect(generic).not.toContain('admits anything still pending');
    expect(generic).toContain('re-screened');
    expect(generic).toContain('no fixed bound');
  });

  /**
   * EI-25209690807142935 / EI-26282407214531658 — the candidate leg was the only exclusion the
   * claim floor knew about. A degraded-coverage row (measured on EI-26277464744695494) and a
   * typed duplicate verdict were still promised the fail-open ceiling the runner never honours
   * for them. Every exclusion gets its own text, and none of them quotes the ceiling.
   */
  it('EVERY fail-open exclusion has its own explanation, and none quotes the fail-open ceiling', () => {
    const ceiling = `${ADMISSION_FAIL_OPEN_TICKS * DEFAULT_PROMOTER_TICK_MINUTES} min`;
    const generic = admissionPendingExplanation();
    // Positive control: the generic sentence DOES carry the ceiling, so the negative
    // assertions below cannot pass merely because the ceiling text never renders.
    expect(generic).toContain(ceiling);
    expect(ADMISSION_FAIL_OPEN_EXCLUSIONS.length).toBe(3);
    for (const failOpenExclusion of ADMISSION_FAIL_OPEN_EXCLUSIONS) {
      const text = admissionPendingExplanation(undefined, { failOpenExclusion, duplicateOf: 'EI-CANON' });
      expect(text, `${failOpenExclusion} fell through to the generic sentence`).not.toBe(generic);
      expect(text, `${failOpenExclusion} still promises the fail-open ceiling`).not.toContain(ceiling);
      expect(text).toMatch(/NO fixed\s+bound|does NOT clear on its own/);
    }
  });

  it('a degraded-coverage row is told about the re-screen, with the cadence derived from the tick', () => {
    const degraded = admissionPendingExplanation(7, { failOpenExclusion: 'degraded-dedup-coverage' });
    expect(degraded).toContain('could NOT RUN');
    expect(degraded).toContain(`every ${ADMISSION_FAIL_OPEN_TICKS} ticks of the 7-minute promoter`);
    expect(degraded).not.toContain('30-minute');
    // EI-26515695311006297: the re-screen budget is finite, and the text says what happens after it.
    expect(degraded).toContain(`After ${ADMISSION_DEGRADED_RESCREEN_ATTEMPTS} re-screens that still cannot run`);
    expect(degraded).toContain('CLEARS ON ITS OWN');
  });

  it('a duplicate-verdict row names its canonical row and is told it never clears on its own', () => {
    const verdict = admissionPendingExplanation(undefined, {
      failOpenExclusion: 'duplicate-verdict',
      duplicateOf: 'EI-26282407214531658',
    });
    expect(verdict).toContain('DUPLICATE VERDICT');
    expect(verdict).toContain('(EI-26282407214531658)');
    expect(verdict).toContain('does NOT clear on its own');
    expect(verdict).not.toMatch(/CLEARS ON ITS\s+OWN/);
    // Without an id the sentence still reads cleanly rather than printing "(null)".
    expect(admissionPendingExplanation(undefined, { failOpenExclusion: 'duplicate-verdict' })).not.toContain('(null)');
  });

  it('only a known exclusion label narrows; anything else from the DB means "no exclusion"', () => {
    for (const label of ADMISSION_FAIL_OPEN_EXCLUSIONS) expect(asAdmissionFailOpenExclusion(label)).toBe(label);
    for (const junk of [null, undefined, '', 'degraded', 'DUPLICATE-VERDICT', 1, true]) {
      expect(asAdmissionFailOpenExclusion(junk)).toBeNull();
    }
  });

  it('the runner, its re-screen selector and the claim floor all read the ONE exclusion record', () => {
    // Rung 2 (PIN): the behaviour is proven against real Postgres in
    // work-items-advertise-claim-floor-parity.integration.test.ts; this pins that no consumer
    // has gone back to a private copy of the predicates.
    const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
    const runner = read('./work-items-admission-promoter.ts');
    expect(runner).toContain('AND ${failOpenDedupEligibleWhereSql(sql)}');
    const rescreen = read('./work-items-admission-dedup-rescreen.ts');
    expect(rescreen).toContain('${failOpenExclusionSql(sql)}');
    const floor = read('./work-items.ts');
    expect(floor).toContain("failOpenExclusionSql(sql, 'wi')");
    expect(floor).not.toContain('admission_has_dedup_candidates');
    for (const [name, src] of [['runner', runner], ['rescreen', rescreen], ['floor', floor]] as const) {
      expect(src, `${name} re-derives the candidate predicate by hand`).not.toContain(
        "(payload -> 'dedupCandidates') IS NULL",
      );
    }
  });

  it('the two second-bounds agree with the constants they are derived from', () => {
    expect(admissionPromoterTickSec()).toBe(DEFAULT_PROMOTER_TICK_MINUTES * 60);
    expect(admissionFailOpenSec()).toBe(ADMISSION_FAIL_OPEN_TICKS * DEFAULT_PROMOTER_TICK_MINUTES * 60);
    // Parametrised, so a fixed return value cannot satisfy both rows.
    expect(admissionPromoterTickSec(7)).toBe(420);
    expect(admissionFailOpenSec(7)).toBe(ADMISSION_FAIL_OPEN_TICKS * 420);
  });

  /**
   * ADMISSION_FAIL_OPEN_TICKS is a claim ABOUT `runAdmissionFailOpen`, which computes its own
   * cutoff. Rung 2 of the derived-truth ladder: the honest bound we publish to a refused
   * caller cannot be a number someone remembered — if that runner starts admitting after a
   * different number of ticks, this fails and forces the constant to follow it.
   */
  it('the fail-open ceiling matches the cutoff the runner actually applies', () => {
    const runner = fs.readFileSync(new URL('./work-items-admission-promoter.ts', import.meta.url), 'utf8');
    expect(
      runner,
      'runAdmissionFailOpen must still cut off at ADMISSION_FAIL_OPEN_TICKS * tickMinutes — if it ' +
        'changed, update ADMISSION_FAIL_OPEN_TICKS rather than this assertion, because the claim ' +
        "path publishes that number to callers as the wait's ceiling",
    ).toContain(`${ADMISSION_FAIL_OPEN_TICKS} * tickMinutes * 60_000`);
  });

  /**
   * EI-24023740620851074 — the cutoff is not the guarantee. The runner only admits rows past
   * the cutoff at the moment it FIRES, so a row that just misses one fire waits a whole
   * cadence more. Both halves are pinned: the arithmetic, and that the seeded cron really
   * fires one tick apart (if its schedule changes, the published bound must follow it).
   */
  it('the guaranteed bound is the cutoff PLUS one fail-open cadence, and the seeded cron fires one tick apart', () => {
    expect(admissionFailOpenGuaranteedSec()).toBe(
      (ADMISSION_FAIL_OPEN_TICKS + 1) * DEFAULT_PROMOTER_TICK_MINUTES * 60,
    );
    expect(admissionFailOpenGuaranteedSec(7)).toBe((ADMISSION_FAIL_OPEN_TICKS + 1) * 420);
    expect(admissionFailOpenGuaranteedSec()).toBeGreaterThan(admissionFailOpenSec());

    const seed = fs.readFileSync(
      new URL('./harness/routines/seed-work-item-admission-fail-open-routine.ts', import.meta.url),
      'utf8',
    );
    const cron = /cron:\s*'([^']+)'/.exec(seed)?.[1];
    expect(cron, 'the fail-open seed must declare a literal cron').toBeTruthy();
    // 6-field cron (sec min hour dom mon dow): the minute field is index 1.
    const minutes = cron!.split(/\s+/)[1].split(',').map(Number).sort((a, b) => a - b);
    expect(minutes.every((m) => Number.isInteger(m) && m >= 0 && m < 60)).toBe(true);
    const gaps = minutes.map((m, i) => (i === 0 ? m + 60 - minutes[minutes.length - 1] : m - minutes[i - 1]));
    expect(
      Math.max(...gaps),
      'the fail-open runner must fire at most one promoter tick apart, or admissionFailOpenGuaranteedSec under-states the wait',
    ).toBe(DEFAULT_PROMOTER_TICK_MINUTES);
  });

  it('the claim floor publishes the GUARANTEED bound, never the bare cutoff, as guaranteedWithinSec', () => {
    const floorSource = fs.readFileSync(new URL('./work-items.ts', import.meta.url), 'utf8');
    expect(floorSource).not.toContain('guaranteedWithinSec: admissionFailOpenSec()');
    expect(floorSource.match(/guaranteedWithinSec: admissionFailOpenGuaranteedSec\(\)/g)?.length).toBe(2);
  });
});

describe('EI-22166155287498355: the retry bound is promoter-health-aware, and always fail-open', () => {
  it('an empty workspaceId short-circuits to not-stalled without touching the DB', async () => {
    await expect(admissionPromoterStall('')).resolves.toEqual({ stalled: false });
  });

  it('a DB/query problem never throws — it resolves not-stalled (fail-open, same posture as loadOwnAuthorPubkeys)', async () => {
    // No testcontainers DB is wired up in this plain unit file, so getOrgPg()/the query
    // itself is expected to fail here. The whole point of this test is that the failure
    // is swallowed rather than propagated: an unreadable health signal must never make
    // an admission-pending refusal look WORSE than the caller already sees.
    await expect(admissionPromoterStall('some-workspace-id')).resolves.toEqual({ stalled: false });
  });
});

/**
 * EI-23383710942512978 — the floor blamed a PAUSED promoter's stale `last_error`.
 *
 * "`last_error` is cleared on success and set on failure" is a statement about FIRES, so it
 * stops being informative the moment a routine stops firing: the value freezes at whatever
 * the final fire left. Measured on this box 2026-09-16 — `last_fired_at` 16:00:03Z, four
 * minutes BEFORE `metadata.pause.pausedAtMs` 16:04:03Z, with a live `last_error` from that
 * final fire. The floor rendered it as "the promoter's last fire errored", which reads as a
 * broken routine and invites re-arming an LLM-spending loop the owner deliberately paused.
 *
 * These pin the ORDERING RULE, not the prose. The DB half is a single indexed SELECT; the
 * misattribution lived entirely in this decision, which is why it is a pure function.
 */
describe('EI-23383710942512978: a deliberate pause is not a fault', () => {
  /** The exact production row shape, at the measured timestamps. */
  const PAUSED_AT = Date.parse('2026-09-15T16:04:03.721Z');
  const LAST_FIRED = Date.parse('2026-09-15T16:00:03.675Z');
  const OWNER_REASON =
    '[owner 2026-09-15] owner directed: pause ALL background LLM-spending loops ' +
    "(see WI-10001478 inventory). Re-arm only on the owner's word.";

  it('reports the PAUSE, not the stale error, when the error predates the pause', () => {
    const stall = classifyAdmissionPromoterStall({
      active: false,
      lastFiredAtMs: LAST_FIRED,
      pause: { reason: OWNER_REASON, pausedAtMs: PAUSED_AT },
      lastError: 'inference-gateway: codex OAuth upstream failed: terminated',
    });
    expect(stall).toEqual({ stalled: true, cause: 'paused', pauseReason: OWNER_REASON });
  });

  it("the basis carries the owner's recorded reason and tells the reader NOT to re-arm", () => {
    const basis = admissionStallBasis({ stalled: true, cause: 'paused', pauseReason: OWNER_REASON });
    expect(basis).toContain('PAUSED BY A DELIBERATE HOLD');
    expect(basis).toContain("Re-arm only on the owner's word");
    expect(basis).toMatch(/do NOT re-arm/i);
    // The bound never changed — only the blame did. The fail-open runner is still named.
    expect(basis).toContain('work-item-admission-fail-open');
    // The regression this file exists to prevent: the paused case must not claim a fire errored.
    expect(basis).not.toContain('last fire errored');
  });

  it('an error that POSTDATES the pause still wins — "prefer paused" is not "suppress every error"', () => {
    // The inverse case, so the fix cannot degrade into blanket error suppression on any
    // paused routine. If it somehow fired and failed after being paused, that is live news.
    const stall = classifyAdmissionPromoterStall({
      active: false,
      lastFiredAtMs: PAUSED_AT + 60_000,
      pause: { reason: OWNER_REASON, pausedAtMs: PAUSED_AT },
      lastError: 'boom',
    });
    expect(stall).toEqual({ stalled: true, cause: 'errored' });
  });

  it('an ARMED promoter whose last fire errored is still reported as errored (EI-22166155287498355 stands)', () => {
    const stall = classifyAdmissionPromoterStall({
      active: true,
      lastFiredAtMs: LAST_FIRED,
      pause: null,
      lastError: 'inference-gateway: codex OAuth upstream failed: terminated',
    });
    expect(stall).toEqual({ stalled: true, cause: 'errored' });
    expect(admissionStallBasis(stall)).toContain('last fire errored');
  });

  it('inactive with NO pause record is its own cause — routines:list calls this the one worth investigating', () => {
    const stall = classifyAdmissionPromoterStall({
      active: false,
      lastFiredAtMs: LAST_FIRED,
      pause: null,
      lastError: null,
    });
    expect(stall).toEqual({ stalled: true, cause: 'inactive' });
    expect(admissionStallBasis(stall)).toContain('nothing durable says why');
  });

  it('a healthy armed promoter is not stalled, and keeps the normal cadence basis', () => {
    const stall = classifyAdmissionPromoterStall({
      active: true,
      lastFiredAtMs: LAST_FIRED,
      pause: null,
      lastError: null,
    });
    expect(stall).toEqual({ stalled: false });
    expect(admissionStallBasis(stall)).toContain('cron tick');
  });

  it('a pause with no recorded reason still reads as paused rather than as a fault', () => {
    const stall = classifyAdmissionPromoterStall({
      active: false,
      lastFiredAtMs: LAST_FIRED,
      pause: { pausedAtMs: PAUSED_AT },
      lastError: 'stale boom',
    });
    expect(stall).toEqual({ stalled: true, cause: 'paused', pauseReason: null });
    expect(admissionStallBasis(stall)).toContain('no reason was recorded');
  });
});

describe('admission-pending names the create-time remedy that already existed', () => {
  it('scopes duplicate screening to the work-item claim instead of inventing an agent-launch delay', () => {
    const explanation = admissionPendingExplanation();
    expect(explanation).toContain('WORK-ITEM CLAIM');
    expect(explanation).toContain('does not block opening an agent or fleet process');
    expect(explanation).toContain('launch and queue admission are separate capabilities');
    expect(explanation).toContain('still needs claimable or validly pre-assigned work');
  });

  it('the remedy is rendered from the bypass record, so a new bypass cannot be left out', () => {
    const remedy = admissionPendingCreateRemedy();
    for (const bypass of ADMISSION_CREATE_BYPASSES) {
      expect(remedy, `${bypass.reason} is a live create-time bypass but the remedy omits it`).toContain(
        bypass.condition,
      );
    }
  });

  it('assign_to is in the record — the reporter proposed it as a NEW mechanism', () => {
    // The report's own suggested fix was "an item whose creator names a specific intended owner
    // could bypass screening". That is bypass:explicit-assignment, which already existed and was
    // the second most-used admission path on this box (235 uses in the 3 days before the report).
    // Nothing on the refusal path said so. This is the negative control for the loop above: with
    // an empty record every `for` assertion passes vacuously.
    expect(ADMISSION_CREATE_BYPASSES.length).toBeGreaterThanOrEqual(4);
    const reasons = ADMISSION_CREATE_BYPASSES.map((b) => b.reason);
    expect(reasons).toContain('bypass:explicit-assignment');
    expect(admissionPendingCreateRemedy()).toContain('assign_to');
  });

  it('routes plan fleets and fixed ad-hoc work without overstating assign_to authority', () => {
    const remedy = admissionPendingCreateRemedy();
    expect(remedy).toContain('plans:start then fleet:launch-on-plan');
    expect(remedy).toContain('capability:launch-agent');
    expect(remedy).toContain('create-time admission bypasses, not blanket authority');
    expect(remedy).toContain('live fleet scope');
    expect(remedy).toContain('files the item unassigned');
    expect(remedy).toContain('ALREADY-pending item');
    expect(remedy).not.toContain('re-file it');
  });

  it('every recorded reason is still minted by the create path', () => {
    // The `AdmissionBypassReason` type already fails compilation if _create-core drops a reason
    // the record declares. This catches the other direction — a reason RENAMED in the record
    // while the create path keeps writing the old durable `admitted_by` string.
    const createCore = fs.readFileSync(
      new URL('./agent-tools/work_items/_create-core.ts', import.meta.url),
      'utf8',
    );
    for (const bypass of ADMISSION_CREATE_BYPASSES) {
      expect(createCore, `${bypass.reason} is declared but never minted by the create path`).toContain(
        `'${bypass.reason}'`,
      );
    }
  });
});
