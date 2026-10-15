/**
 * The registry's UI display helpers.
 *
 * These exist because two GUI surfaces (the HUD session card, the Sessions
 * roster) each used to spell their own mode label and hover text, so only the
 * three modes someone remembered to write copy for were ever explained —
 * `cold-auto` and `grade` rendered a bare "Standing mode: grade". Deriving from
 * this registry means adding a mode explains it everywhere; these tests are what
 * keeps that true as MODES grows.
 */
import { describe, it, expect } from 'vitest';
import { BUILTIN_MODE_COMPONENTS } from '@papercusp/orchestrator/mode-catalog';
// WI-37711: imported rather than re-typed so the drain-fleet contract assertion below is
// pinned to the REAL claim-spec grammar — if `goal` ever leaves ITEM_FIELDS while the
// contract still prescribes a goal leaf, this test fails instead of the fleet discovering it.
import { FILTERABLE_ITEM_FIELDS } from '../scheduler/claim-spec';
import {
  MODES,
  modeChipLabel,
  modeChipTitle,
  modeById,
  modeImpliesAutonomy,
  autonomousModeIds,
  modeRequiresSubject,
  subjectRequiringModeIds,
  resolveImpliedModes,
  modeIndexMarkdown,
  LAUNCHABLE_MODE_IDS,
  isLaunchableMode,
  launchableModes,
} from './registry';

describe('generated mode identity catalog view', () => {
  it('derives activation metadata from the same trusted catalog as discovery text', () => {
    for (const component of BUILTIN_MODE_COMPONENTS) {
      const mode = modeById(component.id)!;
      const metadata = component as unknown as {
        implies: readonly string[]; requiresSubject: boolean; launchable: boolean;
      };
      expect(mode.implies ?? [], `${component.id} implications`).toEqual(metadata.implies);
      expect(mode.requiresSubject ?? false, `${component.id} subject`).toBe(metadata.requiresSubject);
      expect(mode.launchable ?? false, `${component.id} launch`).toBe(metadata.launchable);
      expect(mode.axis).toBe(component.slot === 'autonomy' ? 'autonomy' : 'overlay');
      for (const alias of component.aliases) {
        const variant = modeById(alias.id)!;
        expect(variant.title).toBe(alias.title);
        expect(variant.oneLiner).toBe(alias.oneLiner);
        expect(variant.implies ?? []).toEqual(alias.implies);
        expect(variant.requiresSubject ?? false).toBe(alias.requiresSubject);
        expect(variant.launchable ?? false).toBe(alias.launchable);
        expect(variant.contract).toBe(component.definitionText.slice(
          component.definitionText.indexOf(alias.definitionHeading)).trimEnd());
      }
    }
  });

  it('serves titles and index text from authored manifests while retaining host policy fields', () => {
    for (const component of BUILTIN_MODE_COMPONENTS) {
      const mode = modeById(component.id)!;
      expect(mode.title).toBe(component.title);
      expect(mode.oneLiner).toBe(component.oneLiner);
      expect(modeIndexMarkdown()).toContain(component.oneLiner);
    }
    expect(modeById('goal')?.implies).toEqual(['auto', 'ideate']);
    expect(modeById('goal')?.requiresSubject).toBe(true);
    expect(modeById('cold-auto')?.axis).toBe('autonomy');
    const autoText = BUILTIN_MODE_COMPONENTS.find((entry) => entry.id === 'auto')!.definitionText;
    const coldHeading = '## COLD AUTO — the same autonomy component across fresh-context wakes';
    expect(modeById('cold-auto')?.contract).toBe(autoText.slice(autoText.indexOf(coldHeading)).trimEnd());
    expect(modeById('cold-auto')?.contract).toContain('loop:checkpoint { did, left, insight, next }');
  });

  it('reads GOAL/GRADE/TEST definition text from the generated authored components', () => {
    for (const id of ['goal', 'grade', 'test']) {
      const component = BUILTIN_MODE_COMPONENTS.find((entry) => entry.id === id)!;
      expect(modeById(id)?.contract).toBe(component.definitionText);
    }
  });
});

/**
 * THE `implies` DECLARATION (D-003) — the field the cascade writes from and the
 * autonomy predicate now derives from.
 *
 * The population is PINNED, not merely spot-checked. A guard that only asserts
 * "goal implies auto" keeps passing after someone deletes `implies` from drain,
 * and a guard that iterates whatever it finds passes vacuously over an empty
 * set. Both failures look identical to a green run.
 */
describe('mode implications', () => {
  const declaring = MODES.filter((m) => m.implies?.length);

  it('pins the known-good population — the whole set, not a sample', () => {
    expect(declaring.map((m) => m.id).sort()).toEqual(['drain', 'goal', 'grade']);
    expect(resolveImpliedModes('goal')).toEqual(['auto', 'ideate']);
    expect(resolveImpliedModes('drain')).toEqual(['auto']);
    expect(resolveImpliedModes('grade')).toEqual(['auto']);
    expect(resolveImpliedModes('auto')).toEqual([]);
    expect(resolveImpliedModes('nonexistent')).toEqual([]);
  });

  it('only ever names modes that exist', () => {
    for (const m of declaring) {
      for (const id of m.implies!) expect(modeById(id), `${m.id} implies '${id}'`).not.toBeNull();
    }
  });

  /**
   * A mode that is ABOUT something cannot be implied — the cascade has no
   * subject to give it, and entering it unattributed silently zeroes the goal
   * stamping and attribution paths (EI-20015592992797890). The store refuses at
   * runtime; this is what stops the declaration existing at all.
   */
  it('never implies a mode that requires a subject', () => {
    for (const m of declaring) {
      for (const id of m.implies!) {
        expect(modeRequiresSubject(id), `${m.id} implies subject-requiring '${id}'`).toBe(false);
      }
    }
  });

  it('is acyclic — the closure terminates and never contains the mode itself', () => {
    for (const m of MODES) {
      const closure = resolveImpliedModes(m.id);
      expect(closure, m.id).not.toContain(m.id);
      expect(new Set(closure).size, `${m.id} closure has duplicates`).toBe(closure.length);
    }
  });

  it('uses the scoped goal-review duty when IDEATE is combined with GOAL', () => {
    const text = modeById('ideate')!.contract.replace(/\s+/g, ' ');
    expect(text.includes('GOAL-LOCAL GAP REVIEW fulfills this IDEATE duty')).toBe(true);
    expect(text.includes('goalReview')).toBe(true);
    expect(text.includes('the goal-day must yield at least one evaluated new candidate')).toBe(true);
    expect(text.includes('justified zero-idea result')).toBe(false);
    expect(text.includes('does not authorize the goal holder to implement')).toBe(true);
    expect(text.includes('Standalone IDEATE keeps the ordinary grounded proposal loop')).toBe(true);
  });

  /**
   * D-003's OTHER half: the contract states the implication as a FACT about the
   * agent's posture. The old wording — "if the autonomy axis is empty, also
   * mode:set auto" — instructed the agent to perform the write, which is exactly
   * the directive a compaction drops. If that phrasing comes back, the cascade
   * and the prose disagree about who is responsible, and the prose loses.
   */
  it('states each implication in the contract as done, never as an instruction to go do it', () => {
    for (const m of declaring) {
      expect(m.contract, `${m.id} tells the agent to set the mode itself`).not.toMatch(/also mode:set/i);
      for (const id of m.implies!) {
        expect(m.contract.toLowerCase(), `${m.id} contract never mentions '${id}'`).toContain(id);
      }
    }
  });

  /**
   * The derivation that makes drift impossible: `modeImpliesAutonomy` reads the
   * same field the cascade writes from, so "guards treat this session as
   * autonomous" and "this session actually holds an autonomy row" cannot be
   * separately true — which they were, for every GOAL session, until D-003.
   */
  it('derives modeImpliesAutonomy from implies, for every overlay that declares one', () => {
    for (const m of declaring) {
      const impliesAnAutonomyMode = m.implies!.some((id) => modeById(id)?.axis === 'autonomy');
      expect(modeImpliesAutonomy(m.id), m.id).toBe(impliesAnAutonomyMode);
    }
    // and the derived set still matches the standalone accessor
    expect([...autonomousModeIds()].sort()).toEqual(['auto', 'cold-auto', 'drain', 'goal', 'grade']);
  });
});

describe('DRAIN mode defect-filing contract (WI-38401)', () => {
  const drain = modeById('drain');

  it('suppresses incidental suspected-defect rows and preserves only direct blockers', () => {
    expect(drain).not.toBeNull();
    expect(drain!.contract).toMatch(/Defect-filing exception/i);
    expect(drain!.contract).toMatch(/DRAIN overrides the general file-every-suspected-bug\s+rule/);
    expect(drain!.contract).toMatch(/do\s+\*\*not\*\*\s+mint an\s+`improvements:capture`, issue, work-item, or observation/i);
    expect(drain!.contract).toMatch(/directly blocks the scoped drain/i);
    expect(drain!.contract).toMatch(/exactly one blocker linked to the active drain item\/plan/);
  });
});

describe('GRADE mode corrective-loop contract (WI-243572)', () => {
  const grade = modeById('grade');

  it('is a stackable overlay that structurally enters AUTO', () => {
    expect(grade).not.toBeNull();
    expect(grade!.axis).toBe('overlay');
    expect(grade!.implies).toEqual(['auto']);
    expect(resolveImpliedModes('grade')).toEqual(['auto']);
    expect(modeImpliesAutonomy('grade')).toBe(true);
    expect(grade!.contract).toContain('GRADE implies AUTO');
    expect(grade!.contract).toMatch(/ALREADY hold/);
  });

  it('owns confirmed findings through root-cause repair, recurrence guard, verification, and re-grade', () => {
    const c = grade!.contract;
    expect(c).toContain('BASELINE BEFORE REPAIR');
    expect(c).toContain('FIX WHAT GRADING CONFIRMS');
    expect(c).toMatch(/confirmed defect or material improvement is\s+YOUR implementation work/);
    expect(c).toMatch(/Dedup first/);
    expect(c).toMatch(/claim the existing remediation\s+item or create \+ claim one before editing/);
    expect(c).toMatch(/root cause/);
    expect(c).toMatch(/recurrence guard/);
    expect(c).toMatch(/re-grade the original target/);
    expect(c).toMatch(/independent-\s+acceptance rule/);
    expect(c).toMatch(/never self-accept/);
  });

  it('routes complete verdicts through scorecards:evaluate → scorecards:emit, never mutable capture', () => {
    const c = grade!.contract;
    const loop = c.slice(c.indexOf('2. LOOP:'), c.indexOf('3. CHEAP EVIDENCE:'));

    expect(loop).toContain('scorecards:evaluate { rubricRef }');
    expect(loop).toContain('scorecards:emit');
    expect(loop).toMatch(/complete per-run or terminal scorecard NEVER goes through improvements:capture/);
    expect(loop).toMatch(/improvements:capture[\s\S]*recurring MUTABLE health observations/);
    expect(loop).not.toMatch(/emits a scorecard\s+\(improvements:capture/);
  });
});

describe('GOAL mode STANDING clause (work-on-everything-goal-2026-08-23 P-008)', () => {
  const goal = modeById('goal');

  it('carries the standing-goal addendum with posture, scope, placement and routing', () => {
    expect(goal).not.toBeNull();
    // The clause exists and names the real door — goals:start { standing: true }.
    expect(goal!.contract).toContain('STANDING GOALS');
    expect(goal!.contract).toContain('goals:start { standing: true }');
    // P-008: posture unchanged — create/place/arbitrate/kill, never implement.
    expect(goal!.contract).toMatch(/posture above is UNCHANGED/);
    expect(goal!.contract).toMatch(/standing changes what you steward, not how/);
    // D-003 coherence: the criterion's absence is definitional — never invented,
    // never "corrected" (mirrors STANDING_GOAL_KILL_POLARITY in goals/kill-criterion.ts).
    expect(goal!.contract).toMatch(/do NOT invent a kill criterion/);
    expect(goal!.contract).toMatch(/ends only when the owner stops it or a tripwire fires/);
    // P-004 coherence: the spend rail is the rolling window, not a lifetime ceiling.
    expect(goal!.contract).toContain('budgetCents over budgetWindowSec');
    expect(goal!.contract).toMatch(/scheduled auto-kill/);
    // P-008: scope = the workspace's unowned frontier + platform self-improvement.
    expect(goal!.contract).toMatch(/UNOWNED frontier/);
    expect(goal!.contract).toContain('platform self-improvement');
    // P-008: never a second silent placer; cross-goal findings go to their goal's agent.
    expect(goal!.contract).toMatch(/NEVER place work into another ACTIVE goal's pots/);
    expect(goal!.contract).toMatch(/ROUTE it\s+to that goal's agent/);
  });
});

describe('GOAL mode ALREADY-ACHIEVED branch (EI-20185531758694925)', () => {
  const goal = modeById('goal');

  it('gives the arrive-at-a-terminal-goal case an explicit three-step branch', () => {
    expect(goal).not.toBeNull();
    const c = goal!.contract;

    expect(c).toContain('ALREADY ACHIEVED');
    // The check is ordered BEFORE the kickoff, because running the kickoff
    // contract over a closed goal is the failure the clause prevents.
    expect(c).toMatch(/read goals:get BEFORE the kickoff\s+question/);
    // The three steps, each named as an action rather than a sentiment.
    expect(c).toMatch(/\(1\) RE-VERIFY/);
    expect(c).toMatch(/\(2\) CORRECT/);
    expect(c).toMatch(/\(3\) REPORT[\s\S]*?and STOP/);
    // Re-verification uses evidence measured now, not inherited from the record.
    expect(c).toMatch(/evidence you MEASURE now/);
    // A FAILED re-verification is a regression, not a licence to rebuild — this
    // is the branch that stops step (1) collapsing into step (2).
    expect(c).toMatch(/If re-verification FAILS the outcome has REGRESSED/);
    expect(c).toMatch(/do not quietly rebuild it/);
    // Anything further is new scope and routes through the existing door.
    expect(c).toMatch(/ANYTHING BEYOND THOSE THREE IS A NEW OUTCOME/);
    expect(c).toContain('goals:propose');
  });

  it('settles the AUTO tension toward asking, and says why the premise fails', () => {
    const c = goal!.contract;
    // The item this clause closes asked for the tension to be RESOLVED in the
    // contract rather than re-decided per agent, so assert the resolution and
    // its reasoning, not merely that the words "AUTO" and "ask" co-occur.
    expect(c).toMatch(/THE QUESTION BEATS THE DISCLOSURE/);
    expect(c).toMatch(/at an achieved goal that premise is GONE/);
    expect(c).toMatch(/every further hour is spend nobody agreed to/);
    expect(c).toMatch(/So ASK\./);
  });

  it('places the branch ahead of the portfolio-creating clauses it guards', () => {
    const c = goal!.contract;
    // Ordering is load-bearing: an agent reading top-down must meet this branch
    // BEFORE the clauses that tell it to file a goal and spawn pots/plans. A
    // correct clause appended below those would read as guidance it already
    // walked past.
    expect(c.indexOf('ALREADY ACHIEVED')).toBeGreaterThan(-1);
    expect(c.indexOf('Then FILE THE GOAL')).toBeGreaterThan(-1);
    expect(c.indexOf('ALREADY ACHIEVED')).toBeLessThan(c.indexOf('Then FILE THE GOAL'));
  });
});

describe('GOAL mode owner-report floor (WI-2140700) — the obligation lives in the every-wake contract', () => {
  const goal = modeById('goal');

  it('names the concrete floor, the orient field, and the every-wake-first ordering', () => {
    expect(goal).not.toBeNull();
    // The floor is stated as a number the holder can act on, not "a standing cadence".
    expect(goal!.contract).toMatch(/standing goal may not go 60 minutes without an\s+owner-facing report/);
    expect(goal!.contract).toMatch(/an outcome goal: 4 hours/);
    // The per-wake read is the orient field the watchdog's own arithmetic projects.
    expect(goal!.contract).toContain('modes.ownerReport');
    expect(goal!.contract).toMatch(/EVERY WAKE,\s+FIRST, before any other work/);
    expect(goal!.contract).toMatch(/`overdue` or `due-now`/);
    // The four elements are the ones the rail measures and the skeleton hands back.
    expect(goal!.contract).toMatch(/MOVED \/ COST \/ OWNER-WALLED \/ KILLED/);
    // coord:send to ['human'] is named as a measured rail (WI-2091959 made it one).
    expect(goal!.contract).toMatch(/coord:send\s+to \['human'\]/);
  });
});

describe('GOAL mode DAG addendum (goal-dag-shared-substrate-2026-08-18 P-006)', () => {
  const goal = modeById('goal');

  it('teaches edges-as-prerequisites, stub-then-arm, and the activation gate', () => {
    expect(goal).not.toBeNull();
    // D-005 — the waterfall hazard: phases of one outcome are never chained goals.
    expect(goal!.contract).toContain('PREREQUISITES ARE EDGES, NOT PHASES');
    expect(goal!.contract).toMatch(/NEVER phases of one outcome/);
    expect(goal!.contract).toContain('build->market->monetize');
    // D-004 — recorded ≠ armed; the kickoff contract runs at activation.
    expect(goal!.contract).toContain('stub-then-arm');
    expect(goal!.contract).toMatch(/full kickoff contract at ACTIVATION/);
    // D-003 — readiness is visibility, never dispatch; the override is named.
    expect(goal!.contract).toMatch(/ACTIVATION GATE, never\s+dispatch/);
    expect(goal!.contract).toMatch(/never enter a claim queue/);
    expect(goal!.contract).toContain('startBlocked');
    // D-002 — a killed blocker flags, never silently unblocks.
    expect(goal!.contract).toMatch(/KILLED blocker never silently unblocks/);
    expect(goal!.contract).toContain('premiseInvalidated');
  });
});

describe('modeChipLabel', () => {
  it('renders a mode id as a chip label, hyphens as spaces', () => {
    expect(modeChipLabel('auto')).toBe('AUTO');
    expect(modeChipLabel('cold-auto')).toBe('COLD AUTO');
  });

  it('passes an unknown id through rather than rendering an empty chip', () => {
    expect(modeChipLabel('sideways')).toBe('SIDEWAYS');
  });
});

describe('modeChipTitle', () => {
  it('explains every registered mode with its title and one-liner', () => {
    for (const def of MODES) {
      const title = modeChipTitle(def.id);
      expect(title, def.id).toContain(def.title);
      expect(title, def.id).toContain(def.oneLiner);
    }
  });

  it('adds provenance when the caller knows it — the half that makes it actionable', () => {
    expect(modeChipTitle('auto', { ownerDirected: true })).toContain('Set by the owner');
    expect(modeChipTitle('auto', { ownerDirected: false })).toContain('set this itself');
  });

  it('omits the provenance line entirely when it is unknown', () => {
    const t = modeChipTitle('auto');
    expect(t).not.toContain('Set by the owner');
    expect(t).not.toContain('set this itself');
  });

  it('degrades to a named fallback for an unregistered mode instead of throwing', () => {
    expect(modeChipTitle('sideways')).toContain('Standing mode: sideways');
  });
});

/**
 * The autonomy predicate (goal-mode-2026-08-07 P-012).
 *
 * This question — "is this session in a posture meant to outlive an owner
 * sitting there?" — was hardcoded at six call sites, and three had already
 * drifted apart, each omitting `cold-auto` with no comment saying why. One of
 * them was the unguarded-halt sweep, so the most autonomy-dependent posture in
 * the system was the one it did not sweep. These tests are what keeps the
 * derived predicate derived.
 */
describe('modeImpliesAutonomy', () => {
  it('counts the autonomy axis AND the overlays that declare they imply it', () => {
    expect(modeImpliesAutonomy('auto')).toBe(true);
    expect(modeImpliesAutonomy('cold-auto')).toBe(true);
    expect(modeImpliesAutonomy('drain')).toBe(true);
    expect(modeImpliesAutonomy('goal')).toBe(true);
    expect(modeImpliesAutonomy('grade')).toBe(true);
  });

  it('does not sweep in overlays that are merely stackable', () => {
    expect(modeImpliesAutonomy('ideate')).toBe(false);
    expect(modeImpliesAutonomy('test')).toBe(false);
  });

  it('returns false for an unregistered id rather than throwing', () => {
    expect(modeImpliesAutonomy('sideways')).toBe(false);
  });

  it('holds for EVERY autonomy-axis mode, so a new one is counted on arrival', () => {
    for (const def of MODES.filter((m) => m.axis === 'autonomy')) {
      expect(modeImpliesAutonomy(def.id), def.id).toBe(true);
    }
  });

  it('agrees with autonomousModeIds', () => {
    expect([...autonomousModeIds()].sort()).toEqual(
      MODES.filter((m) => modeImpliesAutonomy(m.id))
        .map((m) => m.id)
        .sort(),
    );
  });

  /**
   * CONTROL — a deliberately-wrong implementation kept here permanently.
   *
   * This is the exact list the six call sites used to spell. It must DISAGREE
   * with the registry predicate, which is what proves the predicate is derived
   * rather than a re-spelling of the same list. If someone reverts
   * modeImpliesAutonomy to a hardcoded set, this fails.
   */
  it('disagrees with the legacy hardcoded list it replaced (the drift it fixes)', () => {
    const legacyHardcoded = (id: string) => id === 'auto' || id === 'drain';
    const disagreements = MODES.map((m) => m.id).filter((id) => legacyHardcoded(id) !== modeImpliesAutonomy(id));
    // cold-auto, goal, and grade are exactly the postures the old list silently dropped.
    expect(disagreements.sort()).toEqual(['cold-auto', 'goal', 'grade']);
  });
});

/**
 * GOAL mode (goal-mode-2026-08-07 P-004/P-005/P-006/P-012).
 *
 * The contract is the whole deliverable — it is the only thing injected when an
 * agent enters GOAL — so the clauses that cost the most when absent are pinned
 * here by content. Each assertion below maps to a plan item, and dropping one
 * in a future edit should red this file rather than silently weaken the mode.
 */
describe('GOAL mode', () => {
  const goal = modeById('goal');

  it('is registered as a stackable overlay that implies AUTO', () => {
    expect(goal).not.toBeNull();
    expect(goal!.axis).toBe('overlay');
    expect(modeImpliesAutonomy('goal')).toBe(true);
    // D-003: the autonomy reading is DERIVED from the same `implies` the cascade
    // writes from, so a session guards treat as autonomous is one that actually
    // holds the row. The old boolean `impliesAutonomy` could disagree with the
    // contract's "also mode:set auto" sentence; one field cannot.
    expect(goal!.implies).toEqual(['auto', 'ideate']);
    // P-012: the implication is STATED in the contract too — but as a FACT about
    // the agent's current posture (D-003), never as a step for it to perform.
    expect(goal!.contract).toContain('GOAL implies AUTO');
  });

  it('keeps its index one-liner to a single line (P-008)', () => {
    expect(goal!.oneLiner).not.toContain('\n');
  });

  it('requires a scoped gap review that yields one evaluated candidate per goal-day (D-001)', () => {
    const c = goal!.contract;
    const text = c.replace(/\s+/g, ' ');
    expect(text.includes('SCOPE-AWARE GOAL PLANNING')).toBe(true);
    expect(text.includes('STAFF EXECUTABLE PLANS FIRST')).toBe(true);
    expect(text.includes('GOAL-LOCAL GAP REVIEW')).toBe(true);
    expect(text.includes('goalReview')).toBe(true);
    expect(text.includes('existing-plans-sufficient')).toBe(true);
    // D-001 (owner #1300/#1301) superseded the no-quota stance: 18 of 24 reviews concluded
    // existing-plans-sufficient with nothing produced.
    expect(/no minimum new-idea or feature count/i.test(text)).toBe(false);
    expect(/manufactur\w* an idea to satisfy a quota/i.test(text)).toBe(false);
    expect(text.includes('at least one evaluated new candidate per goal per goal-day')).toBe(true);
    expect(text.includes('A single pass may file zero; the goal-day may not.')).toBe(true);
    expect(text.includes('rubrics:trend')).toBe(true);
    expect(text.includes('coverage map')).toBe(true);
    expect(text.includes('ideationYield')).toBe(true);
    expect(/at least once per reporting cycle/i.test(text)).toBe(true);
    expect(text.includes('and FILE the result as improvements:capture')).toBe(false);
    expect(text.includes('on any wake that would otherwise be a near-noop')).toBe(false);
    expect(text.includes('GOAL implies AUTO and IDEATE')).toBe(true);
  });

  it('keeps goal-local planning alongside Blender while preserving execution evidence', () => {
    const text = goal!.contract.replace(/\s+/g, ' ');
    expect(/Blender.*workspace-level/.test(text)).toBe(true);
    expect(text.includes('Both may originate plans')).toBe(true);
    expect(text.includes('adopt or revise a suitable existing plan')).toBe(true);
    expect(text.includes('an evidenced uncovered need')).toBe(true);
    expect(text.includes('a review is not a worker claim')).toBe(true);
  });

  // ── goal-mode-hardening-2026-08-10 P-007: the decisions this contract applies ──
  //
  // Each `it` below pins ONE decision by content. The contract IS the deliverable
  // for this mode, so a clause silently dropped by a later edit is the whole
  // regression — there is no runtime that fails without it, which is exactly why
  // it is pinned here rather than left to review.

  // D-001. The owner removed "project" from the vocabulary outright ("We dont have
  // the concept of projects so why use that verbiage instead of pots?" → "do the
  // full rename"), with no aliases. A contract that reintroduces the word is
  // teaching every goal agent a surface that does not exist.
  it('speaks POT, never PROJECT (D-001)', () => {
    expect(goal!.contract).not.toMatch(/\bprojects?\b/i);
    expect(goal!.contract).toMatch(/\bpots?\b/i);
    expect(goal!.oneLiner).not.toMatch(/\bprojects?\b/i);
  });

  // The Mug / Overwatch / cup tier is RETIRED (owner, 2026-08-10: "we retired the
  // mug and overwatch so remove those refrences from the prompt"; "we want them to
  // be launching su agents, not cups, we are retiring the cup system"). The Blender
  // SURVIVES, so this asserts a targeted absence rather than a blanket one — a
  // guard that also killed Blender would quietly delete a live clause.
  it('names no retired tier — Mug, Overwatch and cup are gone; Blender stays', () => {
    const c = goal!.contract;
    expect(c).not.toMatch(/\bmug\b/i);
    expect(c).not.toMatch(/\boverwatch\b/i);
    expect(c).not.toMatch(/\bcups?\b/i);
    expect(c).not.toContain('mug.base.md');
    expect(c).not.toContain("adv_sessions.role = 'cup'");
    expect(c).toContain('Blender');
  });

  // D-002, and the owner tightened it mid-review ("they should launch an agent for
  // this as well"): the draft carved out an exception letting the goal agent fix
  // shared infrastructure stalling its own fleets. There is no exception. This is
  // the clause most likely to be softened back by a well-meaning edit, because the
  // infra case genuinely feels different from the outside.
  it('forbids implementing ANYTHING, infrastructure included (D-002)', () => {
    const c = goal!.contract;
    expect(c).toContain('YOUR HANDS');
    expect(c).toMatch(/never IMPLEMENT/i);
    expect(c).toMatch(/NOT INFRASTRUCTURE/i);
    expect(c).toMatch(/no\s+exception/i);
    // the concrete case the exception used to be written for
    expect(c).toMatch(/red release gate|wedged service/i);
  });

  // D-004. The owner cut "CAPACITY PREFLIGHT, RAMP ONE AT A TIME" ("we want multiple
  // projects to be worked on simultaneously"). Asserting the absence of the PHRASE
  // would be wrong — the contract now mentions it precisely to say there is none —
  // so this pins the absence of the INSTRUCTION and the presence of its replacement.
  it('tells the agent to parallelize hard, with no ramp-one-at-a-time rule (D-004)', () => {
    const c = goal!.contract;
    expect(c).not.toMatch(/RAMP ONE AT A TIME/i);
    expect(c).not.toMatch(/drive ONE (project|pot) end-to-end/i);
    expect(c).toContain('PARALLELIZE HARD');
    expect(c).toMatch(/under-parallelizing is the named failure/i);
    // only the goal agent sees the whole portfolio, so the width has to travel DOWN
    expect(c).toMatch(/state the intended parallelism in the brief/i);
  });

  // D-005 — the two ceilings are what make D-004's "parallelize hard" safe, so they
  // are pinned together with the composition rule the owner spelled out: "so a plan
  // agents contributes both to the plan max and this total max".
  it('carries both ceilings and states that they compose (D-005)', () => {
    const c = goal!.contract;
    expect(c).toContain('TWO CEILINGS');
    expect(c).toMatch(/MAX AGENTS/);
    expect(c).toMatch(/counts against both/i);
  });

  // D-006 + D-009. Numbers live on the goal record as owner-editable data, not in
  // prose — so the contract must NOT hardcode any. A literal count here is the
  // failure: it silently overrides a value the owner set in the UI.
  it('treats launch numbers as settings on the goal record, never as prose (D-006/D-009)', () => {
    const c = goal!.contract;
    expect(c).toContain('SETTINGS ARE DATA');
    expect(c).toMatch(/editable by\s*\n?the owner|goal's detail popup/i);
    expect(c).toMatch(/never hardcode a number/i);
    expect(c).toMatch(/YOU choose each launch's count and role models/i);
    expect(c).toMatch(/profiles are the current policy\/default layer/i);
    expect(c).toMatch(/pass any deliberate override/i);
    expect(c).toMatch(/Never delegate that choice to the child fleet\s*\n?leader/i);
    // a value remembered from an earlier wake is stale by construction
    expect(c).toMatch(/may have changed it while/i);
  });

  // Owner directive 4: "launch a new agent and give provide instructions to the
  // newly launched agent to launch a headless fleet with the newly launched agent
  // themselves as the fleet leader". The goal agent must NOT lead the plan fleet.
  it('has plan fleets led by a launched agent, not by the goal agent (owner directive 4)', () => {
    const c = goal!.contract;
    expect(c).toMatch(/LAUNCH AN AGENT AND HAVE IT LEAD/i);
    expect(c).toContain('headless');
    expect(c).toContain('coord:couple');
    // goal-mode-hardening P-009 / D-013: the contract must name the ONE-CALL route.
    // Before P-009, `leader:'spawn'` did not exist, so the contract deliberately taught
    // the two-hop relay (launch an agent, brief IT to call this tool, since the CALLER
    // becomes the leader) and this guard asserted THAT phrasing. D-012 bound P-009 to
    // replace the argument and the clause together; this is the tightened form.
    expect(c).toMatch(/leader:\s*'spawn'/);
    expect(c).toMatch(/select the plan,\s*\n?\s*fleet width, and leader\/member model/i);
    expect(c).toMatch(/spawned leader executes and\s*\n?\s*supervises.*does not choose/i);
    // The two-hop route must be GONE, not merely supplemented. A contract is re-injected
    // on every wake, so a superseded route left standing beside the current one is not
    // harmless redundancy — it is a second, WRONG answer carrying equal authority, and a
    // reader has no way to tell which is live. This is the half that actually rots.
    expect(c).not.toMatch(/makes\s*\n?\s*the CALLER the leader/i);
  });

  // Owner directive 5: a standing per-goal drain fleet, always maintained. The
  // "re-establish it when it dies" half is the one that matters — a drain fleet
  // that quietly ended is indistinguishable from a queue with nothing in it.
  it('keeps one standing drain fleet per goal (owner directive 5)', () => {
    const c = goal!.contract;
    expect(c).toContain('STANDING DRAIN FLEET');
    expect(c).toMatch(/always maintained/i);
    expect(c).toMatch(/re-establish it/i);
    // WI-37711 LANDED: `goal` is now a filterable claim-spec field (ITEM_FIELDS +
    // the SQL compiler's FIELD_MAP + the JS evaluator), so the contract no longer
    // warns the leaf is refused — it PRESCRIBES it. This assertion is the forward
    // guard inverted: it now fails if the contract ever drifts back to telling
    // agents the lane cannot be goal-scoped.
    expect(c).toMatch(/field:'goal'/);
    expect(c).not.toMatch(/cannot yet filter on the goal itself/i);
    // The nullable-column hazard (WI-5181) must travel WITH the prescription: a
    // positive leaf on a mostly-unstamped column silently drops every row, while
    // the NULL-safe negative form admits the unowned frontier.
    expect(c).toMatch(/POSITIVE\s+form/);
    expect(c).toMatch(/verify the\s+provenance before fencing/i);
    expect(c).toMatch(/newly-created or otherwise unpopulated goal it matches\s+ZERO/i);
    expect(c).toMatch(/NULL-safe negative\s+form/i);
    expect(c).toMatch(/confirmGoalFenceDrop:true/);
    expect(c).toMatch(/goal is filter-only, not\s+rankable/i);
    expect(c).not.toMatch(/negative leaf silently drops them all/i);
    // The field the contract now tells agents to author must actually BE filterable —
    // derived from the grammar rather than hand-asserted, so this test fails if `goal`
    // is ever removed from ITEM_FIELDS while the contract still prescribes it.
    expect(FILTERABLE_ITEM_FIELDS).toContain('goal');
  });

  // Owner directives 6 + 7 — grading and testing are OUTSOURCED like everything
  // else. Derived from MODES rather than hand-spelled (D-011): if the contract
  // names a mode as an outsourcing target, that mode has to exist in the registry.
  it('outsources grading and testing to launched agents in registered modes (owner directives 6/7)', () => {
    const c = goal!.contract;
    expect(c).toMatch(/GRADE NON-DETERMINISTIC BEHAVIOUR/i);
    for (const id of ['grade', 'test']) {
      expect(modeById(id), `contract names ${id.toUpperCase()} mode, so it must be registered`).not.toBeNull();
      expect(c).toMatch(new RegExp(`${id}-mode agent`, 'i'));
    }
    // the point of a separate test agent: not the builder re-marking its own work
    expect(c).toMatch(/re-marking\s*\n?\s*its own homework/i);
  });

  // Owner directive 9 — the goal agent is the Blender's reviewer, and the escape
  // hatch for "the Blender wants a new goal" is goals:propose (owner-confirmed),
  // never a silent adopt-or-discard.
  it('makes the agent the Blender’s reviewer, with goals:propose as the escape hatch (owner directive 9)', () => {
    const c = goal!.contract;
    expect(c).toContain('KEEP THE BLENDER HONEST');
    expect(c).toContain('goals:propose');
    expect(c).toMatch(/never silently adopt it, and never silently discard it/i);
  });

  // Replaces the retired cup-role proof. "Spawned" still is not "working" — only
  // the subject changed (a launched su agent, not a cup), so the failure it
  // prevents is unchanged: N children that look busy while executing nothing.
  it('requires proof that a launched agent EXECUTES, not merely that it spawned', () => {
    const c = goal!.contract;
    expect(c).toMatch(/PROVE A LAUNCHED AGENT ACTUALLY EXECUTES/i);
    expect(c).toMatch(/"Spawned" is not\s*\n?"working"/i);
    expect(c).toContain('coord:presence');
    expect(c).toMatch(/look\s*\n?busy while executing nothing/i);
  });

  // ONE MAIN OWNER PER POT survives the removal of ONE PLACER PER POT above: the
  // placer clause was Mug arbitration (retired), while this one is the goal_pots
  // schema constraint, which is still enforced.
  it('keeps the schema-enforced one-main-owner-per-pot rule', () => {
    const c = goal!.contract;
    expect(c).toContain('ONE MAIN OWNER PER POT');
    expect(c).toContain('goal_pots_one_owner_per_pot');
    expect(c).toMatch(/do not sum/i);
    // the retired arbitration clause must NOT come back with it
    expect(c).not.toContain('ONE PLACER PER POT');
  });

  it('carries a mandatory kickoff question with a kill criterion and a spend ceiling', () => {
    expect(goal!.contract).toContain('KICKOFF QUESTION (mandatory)');
    expect(goal!.contract).toContain('KILL CRITERION');
    expect(goal!.contract).toContain('SPEND CEILING');
  });

  it('carries the durability clause that keeps a weeks-long goal off the transcript (P-007)', () => {
    expect(goal!.contract).toContain('DURABILITY');
    expect(goal!.contract).toContain('loop:checkpoint');
    expect(goal!.contract).toContain('work_items:checkpoint');
  });

  it('points at the goal RECORD, not a pot, for the kill criterion and spend (P-009)', () => {
    // The goals:* table is the only place a MULTI-project goal's kill criterion
    // and ceiling can live — one goal spawns many pots, so no single pot can
    // hold them. The contract has to say so, or the agent files neither.
    expect(goal!.contract).toContain('goals:create');
    expect(goal!.contract).toContain('goals:update');
    expect(goal!.contract).toMatch(/goal record is NOT a pot/i);
    // and a cold wake must be told to re-read it rather than reconstruct
    expect(goal!.contract).toContain('goals:get');
  });

  it('reports only measurable fleet spend and never invents interactive-session actuals', () => {
    const c = goal!.contract;
    expect(c).toContain('SPEND ACCOUNTING HAS A HARD');
    expect(c).toContain('goals:pots { goalId }');
    expect(c).toMatch(/measured child-fleet spend/i);
    expect(c).toMatch(/no reliable per-session\s+attribution source/i);
    expect(c).toMatch(/do\s+not invent\s+spentCents/i);
    expect(c).toMatch(/exactly matches the measured goals:pots rollup/i);
    expect(c).toMatch(/missing, partial, or mismatched\s+measurements are refused/i);
    expect(c).not.toContain('Plus declared expected spend and reported actuals');
  });

  it('carries the standing owner-report cadence (P-008 of the plan)', () => {
    expect(goal!.contract).toContain('coord:escalate');
  });

  it('keeps the remaining guidance clauses that have no other home', () => {
    const c = goal!.contract;
    // NOTE: the CAPACITY PREFLIGHT assertion that used to head this list was
    // removed by owner directive (D-004) — see the parallelize-hard test above,
    // which pins its absence. The rest are unchanged.
    expect(c).toContain('DEDUP BEFORE CREATING');
    expect(c).toContain('TEMPLATES MANDATE');
    expect(c).toContain('RUBRIC REUSE');
    expect(c).toMatch(/SHIPPED, NOT GREEN/); // flags ship ON
  });
});

/**
 * TEST mode (goal-mode-hardening-2026-08-10 P-006).
 *
 * Same reasoning as the GOAL block above: the contract IS the deliverable, so
 * the clauses that cost the most when absent are pinned by content and dropping
 * one reds this file. Each maps to a failure shape observed on this box rather
 * than to a testing platitude — see the per-assertion notes.
 */
describe('TEST mode', () => {
  const testMode = modeById('test');

  it('is registered as a stackable overlay', () => {
    expect(testMode).not.toBeNull();
    expect(testMode!.axis).toBe('overlay');
  });

  /**
   * D-010. TEST declares NO implications, and that is a decision, not an
   * omission: testing is not an autonomy posture. A future edit that "helpfully"
   * adds implies:['auto'] would silently make every TEST session autonomous —
   * including ones an owner is sitting in front of — so it must red here.
   */
  it('implies nothing, so entering it never changes the autonomy posture', () => {
    expect(testMode!.implies).toBeUndefined();
    expect(resolveImpliedModes('test')).toEqual([]);
    expect(modeImpliesAutonomy('test')).toBe(false);
    expect(autonomousModeIds()).not.toContain('test');
  });

  /**
   * D-010's other half. `subject` exists because downstream consumers JOIN on it
   * (work_items.goal_id is stamped FROM it); nothing joins on a test's subject,
   * so requiring one would gate the door on a value no consumer reads. Scope
   * belongs in mode:set's own instructions instead.
   */
  it('requires no subject — nothing downstream joins on a test subject', () => {
    expect(testMode!.requiresSubject).toBeUndefined();
    expect(modeRequiresSubject('test')).toBe(false);
    expect(subjectRequiringModeIds()).not.toContain('test');
  });

  it('keeps its index one-liner to a single line (P-008)', () => {
    expect(testMode!.oneLiner).not.toContain('\n');
  });

  it('carries INDEPENDENCE — test the contract, not the implementation', () => {
    const c = testMode!.contract;
    expect(c).toContain('INDEPENDENCE');
    // the specific trap: a test derived from the code ratifies the bug
    expect(c).toMatch(/restates the bug as the expectation/i);
  });

  /**
   * RED BEFORE GREEN has a repo-specific hazard attached, and the hazard is the
   * half that matters: the obvious way to prove falsifiability (mutate the file,
   * run, restore) races git-sync's whole-tree sweep and has already committed a
   * mutant. A clause that drifted back to bare "prove it can fail" would leave
   * the agent reaching for exactly that, so the sweep warning is pinned too.
   */
  it('carries RED BEFORE GREEN with the shared-tree mutation hazard attached', () => {
    const c = testMode!.contract;
    expect(c).toContain('RED BEFORE GREEN');
    expect(c).toMatch(/never by\s+mutating the shared tree/i);
    expect(c).toMatch(/git-sync sweeps/i);
    // and it must offer the safe alternative, not just forbid the unsafe one
    expect(c).toMatch(/in memory|scratch copy/i);
  });

  /**
   * The most-repeated local failure: a well-formed answer to a question nobody
   * asked — a suite that selected no files, a mock that dropped the column under
   * test, a grep whose pattern never appeared. Each reads as a pass.
   */
  it('carries ZERO WORK IS NOT A PASS with the population assertion', () => {
    const c = testMode!.contract;
    expect(c).toContain('ZERO WORK IS NOT A PASS');
    expect(c).toMatch(/POPULATION/);
    expect(c).toMatch(/matched no files|empty set/i);
  });

  it('carries REPORT, DON’T FIX — a defect is filed, not silently repaired', () => {
    const c = testMode!.contract;
    expect(c).toMatch(/REPORT, DON’T FIX|REPORT, DON'T FIX/);
    expect(c).toMatch(/destroys the evidence/i);
  });

  it('carries VERDICT WITH EVIDENCE including what could NOT be determined', () => {
    const c = testMode!.contract;
    expect(c).toContain('VERDICT WITH EVIDENCE');
    expect(c).toMatch(/could NOT determine/);
    expect(c).toMatch(/bounded measurement/i);
  });

  it('carries LEAVE THE TESTS BEHIND — committed tests, not a transcript', () => {
    const c = testMode!.contract;
    expect(c).toContain('LEAVE THE TESTS BEHIND');
    expect(c).toMatch(/committed tests/i);
  });
});

/**
 * AUDIT mode (audit-mode-2026-09-01 P-002).
 *
 * Distilled from the p2p program audit and ratified by the owner 2026-09-01:
 * "how can we turn the kind of work did into a mode so taht I can tell an agent,
 * 'go into audit mode' on such and such and have them do a thorough look at not
 * individual items, but look at the whole picture like you just did".
 *
 * The assertions below are not a restatement of the prose — each pins a property
 * whose loss is SILENT. An audit that quietly drops the lifecycle census, or the
 * read-only rail, or the route-don't-remediate rail still produces a confident
 * report; it is just a worse one, and nothing errors.
 */
describe('AUDIT mode', () => {
  const audit = modeById('audit');

  it('is registered as a stackable overlay', () => {
    expect(audit).not.toBeNull();
    expect(audit!.axis).toBe('overlay');
  });

  /**
   * Deliberate, and the direction of the mistake matters: AUDIT is the one mode
   * whose whole discipline is to OBSERVE rather than act, and it is routinely run
   * with the owner watching. An edit that "helpfully" added implies:['auto'] would
   * turn "come look at this program" into a standing act-don't-ask grant on
   * exactly the posture that must not have one.
   */
  it('implies nothing — being asked to look at something is not a grant to act on it', () => {
    expect(audit!.implies).toBeUndefined();
    expect(resolveImpliedModes('audit')).toEqual([]);
    expect(modeImpliesAutonomy('audit')).toBe(false);
    expect(autonomousModeIds()).not.toContain('audit');
  });

  /**
   * Same reasoning as TEST's: `requiresSubject` exists for modes something
   * downstream JOINS on, and both consumers are goal-scoped — goal provenance
   * reads `agent_modes.subject WHERE mode='goal'`, and the edit guard fires on
   * `agent_modes.mode='goal'`. Setting it here would also route audit users into
   * mode:set's hardcoded goal-flavoured "use goals:start / subject:'<goals.id>'"
   * error, which has nothing to do with auditing. Scope rides in `instructions`.
   */
  it('requires no subject — the scope rides in mode:set instructions', () => {
    expect(audit!.requiresSubject).toBeUndefined();
    expect(modeRequiresSubject('audit')).toBe(false);
    expect(subjectRequiringModeIds()).not.toContain('audit');
    expect(audit!.contract).toContain('instructions');
  });

  it('is not launchable — there is no psu flag for it', () => {
    expect(audit!.launchable).toBeUndefined();
    expect(isLaunchableMode('audit')).toBe(false);
  });

  it('keeps its index one-liner to a single line (P-008)', () => {
    expect(audit!.oneLiner).not.toContain('\n');
  });

  /**
   * The census is the load-bearing half of the mode. A census restricted to OPEN
   * plans cannot distinguish a program that is converging from one that is
   * churning — which is the exact question the owner asked ("are they making good
   * progress or are they just spinning in circles?"). Dropping "shipped" and
   * "superseded" would leave the loop looking correct while answering a different
   * question, so the lifecycle words are pinned individually.
   */
  it('censuses the FULL lifecycle, not just the open plans', () => {
    const c = audit!.contract;
    expect(c).toContain('CENSUS');
    expect(c).toContain('shipped');
    expect(c).toContain('superseded');
    expect(c).toContain('archived');
  });

  it('cross-checks the ## Now block against the ledger and records contradictions', () => {
    const c = audit!.contract;
    expect(c).toContain('## Now');
    expect(c).toContain('the ledger wins');
  });

  /** Separating real progress from re-validation churn is the churn half. */
  it('carries the churn markers and separates progress from re-validation', () => {
    const c = audit!.contract;
    expect(c).toContain('CHURN');
    expect(c).toContain('re-validation');
    expect(c).toContain('prior-worker');
  });

  it('checks holder LIVENESS rather than trusting a claim', () => {
    const c = audit!.contract;
    expect(c).toContain('coord:presence');
    expect(c).toContain('A claim is not a worker');
  });

  /**
   * The verify rail. "Read the writer behind every number" is the repo's standing
   * corrective for reporting a metric by its NAME, and an audit is where that
   * error is most expensive — a wrong number in an audit becomes the owner's
   * mental model of the whole program.
   */
  it('demands the writer behind every number, and forbids manufacturing an owner wall', () => {
    const c = audit!.contract;
    expect(c).toContain('VERIFY BEFORE ASSERTING');
    expect(c).toContain('Read the writer');
    expect(c).toContain('[self-imposed]');
    expect(c).toContain('sudo -n');
  });

  it('diagnoses mechanisms rather than symptoms', () => {
    const c = audit!.contract;
    expect(c).toContain('MECHANISMS, NOT SYMPTOMS');
    expect(c).toContain('citations');
  });

  /**
   * The two rails that keep an audit an audit. Without the first it becomes a
   * work session that also wrote a report; without the second it starts executing
   * remediation the owner never chose — which is precisely the drift the owner
   * was reacting to when they asked for the mode.
   */
  it('is read-only toward its subject and never remediates un-routed', () => {
    const c = audit!.contract;
    expect(c).toContain('Read-only toward the subject');
    expect(c).toContain('no drive-by fixes');
    expect(c).toContain('AUDIT never executes remediation un-routed');
  });

  it('requires an explicit mode exit after delivery and before routed remediation', () => {
    const c = audit!.contract;
    expect(c).toContain("mode:set { mode:'audit', enabled:false");
    expect(c).toMatch(/Delivery does\s+not clear the durable mode row/i);
    expect(c).toMatch(/that (explicit )?exit call is your FIRST action/);
    expect(c).toMatch(/never\s+begins until that exit call succeeds/);
    expect(c).toContain('standalone tool call');
    expect(c).toContain('never batch it with any subject mutation');
  });

  it('keeps the anti-false-verdict rails a report is most likely to violate', () => {
    const c = audit!.contract;
    expect(c).toContain('"All items terminal" is NOT a finished plan');
    expect(c).toMatch(/A\s+single grep is not an absence proof/);
    expect(c).toMatch(/bounded\s+count is never quoted as a total/);
  });
});

/**
 * The everything-goal audit step (audit-mode-2026-09-01 P-007).
 *
 * Owner directive 2026-09-01, verbatim: "the everything goal should include an
 * audit mode step when it seems like items are not progressing". The standing
 * "Work on everything" goal runs under GOAL mode, so the durable home for the
 * rule is this contract — the goal ROW's body is data that any future re-creation
 * of that goal would lose.
 *
 * This guard exists because the rule is the kind that gets edited away by
 * accident: every other route in the GOAL contract answers "nothing is moving"
 * with more work (another plan, another fleet), so the one clause that says STOP
 * AND DIAGNOSE reads like an interruption to the flow around it.
 */
describe('GOAL mode — the audit step when a lane stops progressing', () => {
  const goal = modeById('goal');

  it('tells the goal agent to AUDIT a stalled lane before placing more work', () => {
    const c = goal!.contract;
    expect(c).toContain('WHEN A LANE STOPS PROGRESSING, AUDIT IT BEFORE PLACING MORE WORK');
  });

  /**
   * Naming the mode is what makes the step executable. A clause that said only
   * "investigate why it is stuck" would pass a looser assertion while leaving the
   * agent to invent an ad-hoc investigation — the exact thing AUDIT mode replaces.
   */
  it('names the concrete mechanism, not a vague "investigate"', () => {
    const c = goal!.contract;
    expect(c).toContain("mode:set { mode:'audit'");
    expect(c).toContain('instructions');
  });

  /** The signals must be listed, or "seems like items are not progressing" stays a vibe. */
  it('lists the not-progressing signals the agent is expected to read', () => {
    const c = goal!.contract;
    expect(c).toContain('re-claimed by successive');
    expect(c).toContain('re-validation items');
    expect(c).toContain('dead holders');
  });

  it('forbids answering a stalled lane with more work instead of a diagnosis', () => {
    const c = goal!.contract;
    expect(c).toContain('STOP\nplacing');
    expect(c).toContain('instead of a diagnosis');
  });

  /**
   * The step must reference a mode that actually exists. If AUDIT were ever
   * removed from MODES this contract would be instructing every goal agent to
   * call mode:set with an id the z.enum rejects — a runtime failure the prose
   * alone cannot catch.
   */
  it('references a mode id that is really registered', () => {
    expect(modeById('audit')).not.toBeNull();
  });
});

/**
 * Index completeness (P-008).
 *
 * The su playbooks' hand-written mode index had drifted to 5 entries against a
 * registry of 6, so two real modes were invisible to every agent that only ever
 * reads the index. modeIndexMarkdown() derives from MODES precisely so that
 * cannot happen — this is what keeps the derivation honest as MODES grows.
 */
describe('modeIndexMarkdown', () => {
  it('lists EVERY registered mode — no mode can be invisible to the index', () => {
    const md = modeIndexMarkdown();
    for (const def of MODES) {
      expect(md, `${def.id} missing from the index`).toContain(`**${def.id}**`);
      expect(md, `${def.id} one-liner missing`).toContain(def.oneLiner);
    }
    // the population is asserted, not just iterated: an empty MODES would pass
    // every loop above while listing nothing at all.
    expect(MODES.length).toBeGreaterThanOrEqual(7);
    expect(md.split('\n').filter((l) => l.startsWith('- **'))).toHaveLength(MODES.length);
  });
});

/**
 * THE `launchable` DECLARATION (retire-mug-kettle-su-only-2026-08-09 D-067) —
 * which modes a caller may request BEFORE the session exists.
 *
 * Why the flag exists at all: this vocabulary was hardcoded in two places that
 * cannot see each other (psu-launcher.mjs's argv parser and bootstrap-su.ts's
 * body validator), and wiring the GUI path was about to make it four. The
 * population is PINNED here for the same reason the `implies` suite above pins
 * its own: a guard that iterates whatever it finds passes vacuously, and one
 * that spot-checks a single id keeps passing after the set changes underneath
 * it.
 */
describe('launchable modes', () => {
  it('includes the named verifier postures psu can bind before turn one', () => {
    expect([...LAUNCHABLE_MODE_IDS].sort()).toEqual(['auto', 'drain', 'grade', 'test']);
  });

  it('every launchable id is a real registered mode', () => {
    for (const id of LAUNCHABLE_MODE_IDS) expect(modeById(id)).not.toBeNull();
  });

  it('isLaunchableMode agrees with the list, in both directions', () => {
    for (const m of MODES) {
      expect(isLaunchableMode(m.id)).toBe(LAUNCHABLE_MODE_IDS.includes(m.id));
    }
  });

  it('an unregistered id is not launchable (no crash, no accidental true)', () => {
    expect(isLaunchableMode('definitely-not-a-mode')).toBe(false);
    expect(isLaunchableMode('')).toBe(false);
  });

  /**
   * The constraint that keeps the GUI honest. A launchable mode is entered by a
   * flag alone, with nothing to attach a subject to — so a subject-REQUIRING
   * mode can never be launchable. Violating this does not throw: it writes a
   * subject-less row that silently zeroes work_items.goal_id and the goal stop,
   * which is precisely why `goal` is excluded despite being the mode a launcher
   * would most plausibly want to offer.
   */
  it('no launchable mode requires a subject', () => {
    for (const id of LAUNCHABLE_MODE_IDS) expect(modeRequiresSubject(id)).toBe(false);
  });

  it('GOAL is registered but NOT launchable — it requires a subject', () => {
    expect(modeById('goal')).not.toBeNull();
    expect(modeRequiresSubject('goal')).toBe(true);
    expect(isLaunchableMode('goal')).toBe(false);
  });

  it('launchableModes() returns the matching defs, in registry order', () => {
    const defs = launchableModes();
    expect(defs.map((m) => m.id)).toEqual([...LAUNCHABLE_MODE_IDS]);
    // Every def carries what a picker renders from — an empty title or oneLiner
    // would produce a blank, unpickable row rather than a visible failure.
    for (const d of defs) {
      expect(d.title.trim().length).toBeGreaterThan(0);
      expect(d.oneLiner.trim().length).toBeGreaterThan(0);
    }
  });
});
