/**
 * plan-admission-gate.test — P-004, plan shared-pot-dao-cupboard-v1-2026-09-04.
 *
 * Three jobs, in descending order of how much they matter in six months:
 *
 *   1. THE DOOR-COVERAGE GUARD. P-004's first delivery shipped `assertPlanAdmission`
 *      with zero callers and read as complete; the leader's code-truth audit caught
 *      it, a build could not. This guard is the recurrence guard for exactly that:
 *      every door in PLAN_ADMISSION_DOORS must be registered in
 *      PLAN_ADMISSION_DOOR_SITES, and every registered file must still reach an
 *      admission entrypoint. Reading source text is blunt on purpose — it survives
 *      refactors a mock would not, and it fails loudly in the one case that matters
 *      (a door quietly stops consulting the gate).
 *
 *   2. THE ACTIVATION MODEL. A pot with no `governance.planAdmission` section passes
 *      through; the moment the section exists the gate fails CLOSED. Both halves are
 *      asserted, because either one alone is a plausible-looking bug: pass-always is
 *      the gate doing nothing, refuse-always breaks every existing pot.
 *
 *   3. RACE AND IDEMPOTENCY. Concurrent door calls on one certificate must agree,
 *      a replayed certificate must be admitted identically, and a revision that moves
 *      between ratification and the door must refuse.
 *
 * All of it runs against the two configure* seams — no database, no plan rows.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkPlanAdmission,
  configurePlanAdmissionCertificateSource,
  configurePlanAdmissionPolicySource,
  configurePlanAdmissionShadowSink,
  PLAN_ADMISSION_DOOR_SITES,
  PLAN_ADMISSION_GATE_ENTRYPOINTS,
  type PlanAdmissionCertificateSource,
  type PlanAdmissionShadowObservation,
} from './plan-admission-gate';
import { PLAN_ADMISSION_DOORS, type AdmissionCertificate, type PlanAdmissionDoor } from './plan-admission-enforcement';
import { resolvePlanAdmissionMode, type PlanAdmissionPolicy } from './plan-admission-policy';
import type { PlanGovernanceControls, RoundStatus } from './governance-federation';
import type { PlanRow } from './source';

// lib/agent-tools/plans/ → the package root (operator-core), which the registry
// paths are relative to.
const PKG_ROOT = join(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(PKG_ROOT, rel), 'utf8');

/**
 * The guard, expressed over an injected reader so the SAME logic can be run against
 * a deliberately-broken file set. That control is what makes the guard falsifiable
 * without ever mutating the shared tree — the tree-mutation form of this proof races
 * git-sync, which commits the whole checkout every few minutes and has committed a
 * probe's mutant before now.
 *
 * Returns one human-readable problem per unwired door; an empty array is "wired".
 */
function auditDoorWiring(readOrNull: (rel: string) => string | null): string[] {
  const problems: string[] = [];
  for (const site of PLAN_ADMISSION_DOOR_SITES) {
    for (const file of site.files) {
      const src = readOrNull(file);
      if (src === null) {
        problems.push(`${site.door}: registered file ${file} does not exist — the registry is stale`);
        continue;
      }
      if (!PLAN_ADMISSION_GATE_ENTRYPOINTS.some((entry) => src.includes(entry))) {
        problems.push(
          `${site.door}: ${file} is registered as this admission door but calls none of ` +
            `${PLAN_ADMISSION_GATE_ENTRYPOINTS.join(', ')}. Re-wire it, or remove it from ` +
            `PLAN_ADMISSION_DOOR_SITES if it genuinely cannot act on a plan.`,
        );
      }
    }
    // A site that relies on the default door argument is indistinguishable from one
    // that was never wired, so the door must be named literally somewhere it is used.
    if (!site.files.some((file) => (readOrNull(file) ?? '').includes(`'${site.door}'`))) {
      problems.push(`${site.door}: no registered file names the literal '${site.door}'`);
    }
  }
  return problems;
}

const realReader = (rel: string): string | null => (existsSync(join(PKG_ROOT, rel)) ? read(rel) : null);

describe('P-004 DOOR COVERAGE GUARD — every admission door is wired', () => {
  it('registers every door in PLAN_ADMISSION_DOORS, and nothing else', () => {
    const registered = PLAN_ADMISSION_DOOR_SITES.map((s) => s.door).sort();
    expect(registered).toEqual([...PLAN_ADMISSION_DOORS].sort());
  });

  it('every registered door reaches an admission entrypoint and names itself', () => {
    expect(auditDoorWiring(realReader)).toEqual([]);
  });

  // ---- FALSIFIABILITY CONTROLS -------------------------------------------
  // A guard that has never failed is a guard nobody has tested, and this one's whole
  // job is to fail on a defect that already shipped once. These run the real audit
  // against readers that simulate each way a door goes unwired.

  it('CONTROL: a door whose file stops calling any entrypoint is CAUGHT', () => {
    const stripped = (rel: string) => {
      const src = realReader(rel);
      if (src === null) return null;
      return rel === 'lib/scout/ready-plan-autostart.ts'
        ? src.replaceAll('checkPlanAdmission', 'someOtherThing')
        : src;
    };
    const problems = auditDoorWiring(stripped);
    expect(problems.some((p) => p.startsWith('autostart:'))).toBe(true);
  });

  it('CONTROL: a door left on the DEFAULT argument — wired-looking but unnamed — is CAUGHT', () => {
    // The subtle one. The file still calls checkPlanStartable, so an
    // entrypoint-only guard passes it; only the name check notices the door was
    // never actually selected.
    const unnamed = (rel: string) => {
      const src = realReader(rel);
      if (src === null) return null;
      return rel === 'lib/agent-tools/plans/run-now.ts' ? src.replaceAll("'run-now'", '') : src;
    };
    const problems = auditDoorWiring(unnamed);
    expect(problems).toContain("run-now: no registered file names the literal 'run-now'");
  });

  it('CONTROL: a registry row pointing at a file that no longer exists is CAUGHT', () => {
    const moved = (rel: string) => (rel === 'lib/agent-tools/plans/set-plan-status.ts' ? null : realReader(rel));
    const problems = auditDoorWiring(moved);
    expect(problems.some((p) => p.includes('does not exist — the registry is stale'))).toBe(true);
  });

  it('the three chokepoint-free doors each hold their OWN checkPlanAdmission call', () => {
    // The scheduled fire, the status flips, and the scout autostart sweep reach no
    // plan-start-gate entrypoint — they run their own SQL. If any of them were to
    // satisfy the guard above only via `checkPlanStartable`, that would mean the
    // wiring moved somewhere it cannot actually run. Pin the direct call.
    for (const file of [
      'lib/harness/routines/plan-run-action.ts',
      'lib/agent-tools/plans/set-plan-status.ts',
      'lib/scout/ready-plan-autostart.ts',
    ]) {
      expect(read(file).includes('checkPlanAdmission'), `${file} must call checkPlanAdmission directly`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Behaviour. Every case drives both seams, so nothing below touches a database.
// ---------------------------------------------------------------------------

const POLICY: PlanAdmissionPolicy = Object.freeze({
  policyVersion: 7,
  quorumBps: 5_000,
  approvalBps: 6_667,
  ratificationWindowSec: 3_600,
  materiality: Object.freeze({ maxChangedLines: 200, maxChangedItems: 3 }),
});

const NOW = 1_700_000_000_000;

const certificateFor = (planRevisionHash: string, over: Partial<AdmissionCertificate> = {}): AdmissionCertificate => ({
  planRevisionHash,
  policyVersion: POLICY.policyVersion,
  admitted: true,
  expiresAtMs: NOW + 60_000,
  certificateHash: `cert-${planRevisionHash}`,
  ...over,
});

/** A plan row carrying just the fields the gate reads. */
const rowWith = (contentHash: string) => ({ contentHash }) as unknown as PlanRow;

const sourceReturning = (certificate: AdmissionCertificate | null): PlanAdmissionCertificateSource => ({
  resolve: async () => ({ certificate }),
});

afterEach(() => {
  configurePlanAdmissionPolicySource(null);
  configurePlanAdmissionCertificateSource(null);
  // The sink is module state like the other two seams. Leaving one installed would
  // let a later test's observations land in an earlier test's array, which reads as
  // "shadow recorded nothing" — the exact false negative these tests exist to catch.
  configurePlanAdmissionShadowSink(null);
});

describe('activation is policy-driven, not a flag', () => {
  it('a pot with no planAdmission policy is PASSED THROUGH, and says so', async () => {
    configurePlanAdmissionPolicySource(async () => null);
    // Deliberately no certificate source: an un-opted-in pot must not need one.
    const verdict = await checkPlanAdmission({ slug: 'p', door: 'start', row: rowWith('rev-1'), nowMs: NOW });
    expect(verdict).toEqual({ admitted: true, skipped: 'no-admission-policy' });
  });

  it('policy PRESENT but no certificate source ⇒ REFUSED, never passed', async () => {
    // The fail-closed rule. "Governance is switched on but nothing can answer for it"
    // is the one state where guessing in the caller's favour defeats the whole gate.
    configurePlanAdmissionPolicySource(async () => POLICY);
    const verdict = await checkPlanAdmission({ slug: 'p', door: 'start', row: rowWith('rev-1'), nowMs: NOW });
    expect(verdict.admitted).toBe(false);
    if (verdict.admitted) return;
    expect(verdict.refusal.code).toBe('missing-certificate');
    expect(verdict.refusal.error).toBe('plan_admission_refused');
    expect(verdict.refusal.hint).toBeTruthy();
  });

  it('an absent plan is not this gate’s error to report', async () => {
    configurePlanAdmissionPolicySource(async () => POLICY);
    configurePlanAdmissionCertificateSource(sourceReturning(null));
    const verdict = await checkPlanAdmission({ slug: 'p', door: 'start', row: null, nowMs: NOW });
    expect(verdict).toEqual({ admitted: true, skipped: 'plan-not-found' });
  });

  it('the refusal reports the POLICY EPOCH, not the pot_policy row version', async () => {
    // The trap this codebase already stepped in once: ResolvedHivePolicy.policyVersion
    // (the row's monotone version) and PlanAdmissionPolicy.policyVersion (the
    // governance epoch) are different numbers, and admission compares the LATTER.
    configurePlanAdmissionPolicySource(async () => POLICY);
    configurePlanAdmissionCertificateSource(sourceReturning(null));
    const verdict = await checkPlanAdmission({ slug: 'p', door: 'start', row: rowWith('rev-1'), nowMs: NOW });
    expect(verdict.admitted).toBe(false);
    if (verdict.admitted) return;
    expect(verdict.refusal.policyVersion).toBe(POLICY.policyVersion);
  });
});

describe('idempotency — a replayed certificate yields the same verdict', () => {
  it('the same certificate admitted twice returns an identical verdict', async () => {
    configurePlanAdmissionPolicySource(async () => POLICY);
    const cert = certificateFor('rev-1');
    configurePlanAdmissionCertificateSource(sourceReturning(cert));
    const subject = { slug: 'p', door: 'start' as const, row: rowWith('rev-1'), nowMs: NOW };

    const first = await checkPlanAdmission(subject);
    const second = await checkPlanAdmission(subject);

    expect(first).toEqual({ admitted: true, certificate: cert, planRevisionHash: 'rev-1', policyVersion: 7 });
    expect(second).toEqual(first);
  });

  it('a refusal is equally stable across replays — the same code, not a drifting one', async () => {
    configurePlanAdmissionPolicySource(async () => POLICY);
    configurePlanAdmissionCertificateSource(sourceReturning(certificateFor('rev-1', { admitted: false })));
    const subject = { slug: 'p', door: 'start' as const, row: rowWith('rev-1'), nowMs: NOW };
    const first = await checkPlanAdmission(subject);
    const second = await checkPlanAdmission(subject);
    expect(first).toEqual(second);
    expect(first.admitted).toBe(false);
    if (first.admitted) return;
    expect(first.refusal.code).toBe('certificate-rejected');
  });
});

describe('race — concurrent doors on one certificate agree', () => {
  it('every door evaluated concurrently on one certificate admits, and names its own door', async () => {
    configurePlanAdmissionPolicySource(async () => POLICY);
    configurePlanAdmissionCertificateSource({
      // Interleave deliberately: resolution yields to the event loop, so the seven
      // calls genuinely overlap rather than running to completion one at a time.
      resolve: async () => {
        await new Promise((r) => setTimeout(r, 0));
        return { certificate: certificateFor('rev-1') };
      },
    });

    const verdicts = await Promise.all(
      PLAN_ADMISSION_DOORS.map((door) =>
        checkPlanAdmission({ slug: 'p', door, row: rowWith('rev-1'), nowMs: NOW }),
      ),
    );

    expect(verdicts.every((v) => v.admitted)).toBe(true);
    // Shared module state (the two pinned seams) must not let one call's door leak
    // into another's verdict — the specific corruption a module-scoped cache invites.
    for (const v of verdicts) {
      expect(v.admitted && v.skipped === undefined && v.planRevisionHash).toBe('rev-1');
    }
  });

  it('a revision that moves between ratification and the door REFUSES revision-mismatch', async () => {
    // The race that matters: the certificate was issued for rev-1, the door is acting
    // on rev-2 because the plan was edited in between. Admitting here would run a
    // revision nobody approved.
    configurePlanAdmissionPolicySource(async () => POLICY);
    configurePlanAdmissionCertificateSource(sourceReturning(certificateFor('rev-1')));

    const verdict = await checkPlanAdmission({ slug: 'p', door: 'start', row: rowWith('rev-2'), nowMs: NOW });
    expect(verdict.admitted).toBe(false);
    if (verdict.admitted) return;
    expect(verdict.refusal.code).toBe('revision-mismatch');
    // The refusal reports the revision the DOOR is acting on, not the certificate's —
    // otherwise it would tell the reader the plan is at a revision it is not.
    expect(verdict.refusal.planRevisionHash).toBe('rev-2');
  });

  it('a concurrent edit refuses the moved door while the unmoved one still admits', async () => {
    configurePlanAdmissionPolicySource(async () => POLICY);
    configurePlanAdmissionCertificateSource(sourceReturning(certificateFor('rev-1')));

    const [unmoved, moved] = await Promise.all([
      checkPlanAdmission({ slug: 'p', door: 'start', row: rowWith('rev-1'), nowMs: NOW }),
      checkPlanAdmission({ slug: 'p', door: 'scheduled', planRevisionHash: 'rev-2', nowMs: NOW }),
    ]);

    expect(unmoved.admitted).toBe(true);
    expect(moved.admitted).toBe(false);
    if (moved.admitted) return;
    expect(moved.refusal.door).toBe('scheduled');
    expect(moved.refusal.code).toBe('revision-mismatch');
  });
});

describe('the door acts on the revision it HOLDS, not one it re-reads', () => {
  it('an explicit planRevisionHash suppresses the row read entirely', async () => {
    // The scheduled fire holds a hash, not a PlanRow. Re-reading the plan there could
    // return a NEWER revision than the fire is about to execute — so an explicit hash
    // must win, and no row lookup may happen at all.
    configurePlanAdmissionPolicySource(async () => POLICY);
    configurePlanAdmissionCertificateSource(sourceReturning(certificateFor('rev-held')));

    const verdict = await checkPlanAdmission({
      slug: 'p',
      door: 'scheduled',
      // A row is supplied AND contradicts the explicit hash: the explicit one wins.
      row: rowWith('rev-newer'),
      planRevisionHash: 'rev-held',
      nowMs: NOW,
    });

    expect(verdict.admitted).toBe(true);
    expect(verdict.admitted && verdict.skipped === undefined && verdict.planRevisionHash).toBe('rev-held');
  });

  it('a plan with no content hash refuses rather than being admitted on an empty revision', async () => {
    configurePlanAdmissionPolicySource(async () => POLICY);
    configurePlanAdmissionCertificateSource(sourceReturning(certificateFor('')));
    const verdict = await checkPlanAdmission({ slug: 'p', door: 'start', row: rowWith(''), nowMs: NOW });
    expect(verdict.admitted).toBe(false);
    if (verdict.admitted) return;
    expect(verdict.refusal.code).toBe('missing-plan-revision');
  });
});

describe('expiry is evaluated at the instant the door passes in', () => {
  it('a certificate past its window refuses, at the door’s clock not the module’s', async () => {
    configurePlanAdmissionPolicySource(async () => POLICY);
    configurePlanAdmissionCertificateSource(sourceReturning(certificateFor('rev-1', { expiresAtMs: NOW - 1 })));
    const verdict = await checkPlanAdmission({ slug: 'p', door: 'start', row: rowWith('rev-1'), nowMs: NOW });
    expect(verdict.admitted).toBe(false);
    if (verdict.admitted) return;
    expect(verdict.refusal.code).toBe('certificate-expired');
  });
});

// ---------------------------------------------------------------------------
// SHADOW MODE — P-013, plan shared-pot-dao-cupboard-v1-2026-09-04.
//
// P-013 is "activate enforcement only after evidence", and before shadow mode that
// was unsatisfiable: the gate had exactly two states, no-policy (evaluate nothing)
// and policy (enforce on the whole fleet), so the only way to learn what a policy
// would refuse was to switch it on and let it refuse.
//
// The tests below are written as a DIFFERENTIAL, not as a list of expected codes.
// Every scenario runs twice against one fixture — once with the mode absent, once
// with `mode: 'shadow'` — and the shadow observation is compared against whatever
// the enforcing run ACTUALLY returned. Hard-coding the codes here would let the two
// paths drift apart in exactly the way that makes shadow evidence worthless: an
// observation that predicts a refusal enforcement would not produce, or misses one
// it would, is worse than no evidence, because it will be believed.
// ---------------------------------------------------------------------------

const withGovernance = (
  certificate: AdmissionCertificate | null,
  governance: PlanGovernanceControls | null = null,
): PlanAdmissionCertificateSource => ({ resolve: async () => ({ certificate, governance }) });

const controls = (status: RoundStatus, over: Partial<PlanGovernanceControls> = {}): PlanGovernanceControls => ({
  roundId: 'round-1',
  status,
  quarantineReason: null,
  revokedReason: null,
  ...over,
});

interface ShadowScenario {
  readonly name: string;
  readonly door: PlanAdmissionDoor;
  readonly source: PlanAdmissionCertificateSource;
  readonly row: PlanRow;
}

/**
 * One scenario per outcome the enforcement layer can produce, including the admit.
 * The coverage guard below pins this table to the declared refusal-code union, so a
 * code added later fails here until shadow is proven to record it too.
 */
const SHADOW_SCENARIOS: readonly ShadowScenario[] = [
  { name: 'a clean admit (the denominator)', door: 'start', source: withGovernance(certificateFor('rev-1')), row: rowWith('rev-1') },
  { name: 'no certificate at all', door: 'start', source: withGovernance(null), row: rowWith('rev-1') },
  { name: 'a certificate that does not authorize', door: 'start', source: withGovernance(certificateFor('rev-1', { admitted: false })), row: rowWith('rev-1') },
  { name: 'the plan moved under the certificate', door: 'start', source: withGovernance(certificateFor('rev-1')), row: rowWith('rev-2') },
  {
    name: 'a certificate from a superseded policy epoch',
    door: 'start',
    source: withGovernance(certificateFor('rev-1', { policyVersion: POLICY.policyVersion + 1 })),
    row: rowWith('rev-1'),
  },
  { name: 'a certificate past its window', door: 'start', source: withGovernance(certificateFor('rev-1', { expiresAtMs: NOW - 1 })), row: rowWith('rev-1') },
  { name: 'a plan carrying no revision hash', door: 'start', source: withGovernance(certificateFor('')), row: rowWith('') },
  { name: 'an owner-signed pause', door: 'promotion', source: withGovernance(certificateFor('rev-1'), controls('paused')), row: rowWith('rev-1') },
  {
    name: 'a revoked round',
    door: 'scheduled',
    source: withGovernance(certificateFor('rev-1'), controls('revoked', { revokedReason: 'owner revoked' })),
    row: rowWith('rev-1'),
  },
  {
    name: 'a quarantined round',
    door: 'status',
    source: withGovernance(certificateFor('rev-1'), controls('quarantined', { quarantineReason: 'conflicting finalizations' })),
    row: rowWith('rev-1'),
  },
  {
    // Cast on purpose. A door outside PLAN_ADMISSION_DOORS cannot be produced through
    // the typed surface, and leaving it unexercised would drop the one refusal a
    // CALLER bug produces out of the shadow evidence — the population most worth
    // measuring before enforcement is switched on.
    name: 'a door the enforcement layer does not know',
    door: 'not-a-door' as PlanAdmissionDoor,
    source: withGovernance(certificateFor('rev-1')),
    row: rowWith('rev-1'),
  },
];

const runScenario = async (scenario: ShadowScenario, policy: PlanAdmissionPolicy) => {
  configurePlanAdmissionPolicySource(async () => policy);
  configurePlanAdmissionCertificateSource(scenario.source);
  return checkPlanAdmission({ slug: 'pilot-pot-plan', door: scenario.door, row: scenario.row, nowMs: NOW });
};

const SHADOW_POLICY: PlanAdmissionPolicy = Object.freeze({ ...POLICY, mode: 'shadow' as const });

describe('P-013 SHADOW MODE — an absent or explicit `enforce` mode still enforces', () => {
  it('the shared fixture states NO mode, so every other test here already runs the default', () => {
    // Pins the premise the next assertion rests on. If POLICY ever gains a mode, the
    // "absent mode enforces" proof below would silently become a proof about an
    // explicit one, and the default would go untested while looking covered.
    expect('mode' in POLICY).toBe(false);
    expect(resolvePlanAdmissionMode(POLICY)).toBe('enforce');
  });

  it('a policy with no mode REFUSES — the default is never the permissive one', async () => {
    const verdict = await runScenario(SHADOW_SCENARIOS[1], POLICY);
    expect(verdict.admitted).toBe(false);
    if (verdict.admitted) return;
    expect(verdict.refusal.code).toBe('missing-certificate');
  });

  it('an explicit `enforce` is indistinguishable from an absent mode', async () => {
    // Absent and explicit-enforce must be ONE state, not two that happen to agree
    // today: the canonical policy bytes hash the resolved mode for the same reason.
    for (const scenario of SHADOW_SCENARIOS) {
      const absent = await runScenario(scenario, POLICY);
      const explicit = await runScenario(scenario, { ...POLICY, mode: 'enforce' });
      expect(explicit, `${scenario.name}: explicit enforce diverged from the default`).toEqual(absent);
    }
  });

  it('a sink installed while the policy ENFORCES receives nothing', async () => {
    // Shadow is the only producer of observations. If an enforcing gate also emitted
    // them, every "would this policy refuse?" count would be doubled by the refusals
    // that already happened for real.
    const observations: PlanAdmissionShadowObservation[] = [];
    configurePlanAdmissionShadowSink({ record: (o) => void observations.push(o) });
    for (const scenario of SHADOW_SCENARIOS) await runScenario(scenario, POLICY);
    expect(observations).toEqual([]);
  });
});

describe('P-013 SHADOW MODE — never refuses, and records what enforcement would have done', () => {
  it('a read-only promotion preflight returns the same shadow verdict without emitting it', async () => {
    const observations: PlanAdmissionShadowObservation[] = [];
    configurePlanAdmissionShadowSink({ record: (o) => void observations.push(o) });
    configurePlanAdmissionPolicySource(async () => SHADOW_POLICY);
    configurePlanAdmissionCertificateSource(withGovernance(null));
    const subject = { slug: 'pilot-pot-plan', door: 'promotion' as const, row: rowWith('rev-1'), nowMs: NOW };
    const preflight = await checkPlanAdmission({ ...subject, readOnly: true });
    expect(observations).toEqual([]);
    const actual = await checkPlanAdmission(subject);
    expect(preflight).toEqual(actual);
    expect(observations).toHaveLength(1);
  });
  for (const scenario of SHADOW_SCENARIOS) {
    it(`${scenario.name}: admits, and reports the enforcing verdict verbatim`, async () => {
      const enforced = await runScenario(scenario, POLICY);

      const observations: PlanAdmissionShadowObservation[] = [];
      configurePlanAdmissionShadowSink({ record: (o) => void observations.push(o) });
      const shadowed = await runScenario(scenario, SHADOW_POLICY);

      // 1. Shadow admits. Unconditionally — this is the half that makes it safe to
      //    switch on for a live pot, so it is asserted for the refusing scenarios too.
      expect(shadowed.admitted, `${scenario.name} must be admitted under shadow`).toBe(true);
      if (!shadowed.admitted) return;
      // 2. And says WHY it admitted. `shadow-mode` must stay distinguishable from
      //    `no-admission-policy`: the first is a policy that evaluated and declined to
      //    apply, the second is no policy at all, and collapsing them would let a
      //    reader conclude a shadowing pot has no governance configured.
      expect(shadowed.skipped).toBe('shadow-mode');
      // Narrows to the skipped variant, which is the only one carrying `shadow` — an
      // admitted verdict WITHOUT a skip reason is the enforcing shape, and reading a
      // shadow observation off it would be reading a field that cannot be there.
      if (shadowed.skipped === undefined) return;

      // 3. Exactly one observation per door call — not zero (silently unmeasured) and
      //    not several (the same door counted twice inflates every refusal rate).
      expect(observations).toHaveLength(1);
      const observed = observations[0];
      expect(shadowed.shadow).toEqual(observed);
      expect(observed.slug).toBe('pilot-pot-plan');
      expect(observed.door).toBe(scenario.door);
      expect(observed.policyVersion).toBe(POLICY.policyVersion);
      expect(observed.nowMs).toBe(NOW);

      // 4. The differential itself: the recorded verdict IS the enforcing verdict.
      if (enforced.admitted) {
        expect(observed.wouldAdmit).toBe(true);
        expect(observed.code).toBeUndefined();
      } else {
        expect(observed.wouldAdmit).toBe(false);
        expect(observed.code).toBe(enforced.refusal.code);
        expect(observed.detail).toBe(enforced.refusal.detail);
      }
    });
  }

  it('records every refusal code the enforcement layer declares — none goes unmeasured', async () => {
    // Blunt source read, for the same reason the door-coverage guard above uses one:
    // the union is a type and erases at runtime, and a hand-copied list is exactly the
    // second copy of a truth the code owns that goes stale without failing.
    const src = read('lib/agent-tools/plans/plan-admission-enforcement.ts');
    const union = /export type AdmissionRefusalCode =([\s\S]*?);/.exec(src);
    // Throwing beats an empty expectation: a regex that stopped matching would
    // otherwise compare [] to [] and report full coverage of nothing.
    if (!union) throw new Error('could not locate the AdmissionRefusalCode union — update this guard, do not delete it');
    const declared = [...union[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort();
    expect(declared.length).toBeGreaterThan(1);

    // Collected from what SHADOW actually recorded, never from the enforcing run:
    // this guard's whole claim is that the shadow evidence is complete, so reading it
    // from the enforcing path would prove something else entirely.
    const covered = new Set<string>();
    for (const scenario of SHADOW_SCENARIOS) {
      const observations: PlanAdmissionShadowObservation[] = [];
      configurePlanAdmissionShadowSink({ record: (o) => void observations.push(o) });
      await runScenario(scenario, SHADOW_POLICY);
      for (const o of observations) if (o.code) covered.add(o.code);
    }
    expect([...covered].sort()).toEqual(declared);
  });
});
