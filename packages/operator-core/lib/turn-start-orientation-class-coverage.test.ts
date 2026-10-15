/**
 * turn-start-orientation-class-coverage.test.ts — P-001 of plan
 * `turn-start-memory-two-class-2026-09-21`: the COVERAGE GUARD.
 *
 * WHAT THIS EXISTS TO CATCH. The measured hole (0 renders across 334 sampled
 * turns) was not a bug in any one class — it was a class that was DECLARED on
 * `OrientationState`, populated by a resolver, and then never reached a rendered
 * prompt. Nothing failed. The state had the field, the read worked, and the line
 * simply never appeared, so the only way to notice was a periodic human audit of
 * real turns.
 *
 * This turns that audit into a BUILD-TIME INVARIANT: for every declared
 * orientation class, populating it alone on an otherwise-baseline state must add
 * at least one line to `renderOrientationLines`.
 *
 * WHY THE DECLARED SET IS PARSED, NOT LISTED (derived-truth ladder, rung 1).
 * A hand-maintained list of classes is a second copy of a truth
 * `OrientationState` already owns, and it WILL drift — the next agent adds a
 * field, forgets the list, and the guard reports full coverage of a set that no
 * longer describes the interface. So the declared set is read from the interface
 * itself with the TypeScript parser. Add a field to `OrientationState` and this
 * file goes RED until that field is either given a probe below or explicitly
 * excluded with a reason. A dropped class is then a DECISION, not a gap.
 *
 * REGISTERING A NEW CLASS (every later item of this plan does this): add one
 * entry to `CLASS_PROBES` whose `patch` populates only that field and whose
 * `marker` matches the line it is supposed to produce.
 *
 * FALSIFIABILITY. `it('fails when a declared class never renders')` is a
 * PERMANENT control: a class declared but deliberately left unrendered must make
 * `assertClassReachesRenderedPrompt` throw. If someone ever weakens that helper
 * into something that cannot fail, that test goes red — which is the only reason
 * the green of every other test here means anything.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  defineAgentObligation,
  evaluateAgentObligations,
  type AgentObligation,
  type AgentObligationFamily,
} from './agent-obligations';
import {
  fleetStaffingObligations,
  strandedGoalWorkObligations,
  ownerDirectiveObligations,
  waitingOnObligations,
} from './agent-obligation-providers';
import {
  projectAgentTurnStartObligationBrief,
  type AgentObligationBrief,
} from './agent-obligation-reader';
import {
  projectOrientationRows,
  renderOrientationLines,
  type OrientationState,
} from './turn-start-orientation';
// P-024 — the sink axis. The registry is imported through its sink-NEUTRAL seam
// (see orientation-class-registry.ts): this guard is no longer a turn-start-only
// instrument, so reaching into the turn-start sink's own module for the shared
// declaration would be the layering inversion that seam exists to prevent.
import {
  ORIENTATION_CLASS_REGISTRY,
  type RegisteredOrientationClass,
} from './orientation-class-registry';
import { readLeaderNeverDropFacts, readLeaderAnnouncedGates } from './agent-tools/fleet/leader-brief';
// P-029: the carry-document sink's REAL consumer, so its cell is probed
// end-to-end rather than by re-reading the declaration it is supposed to obey.
import { readCarryNeverDropFacts } from './carry-brief';
import type { AgentFact } from './agent-facts/store';

const ORIENTATION_SOURCE = fileURLToPath(new URL('./turn-start-orientation.ts', import.meta.url));
const OBLIGATIONS_SOURCE = fileURLToPath(new URL('./agent-obligations.ts', import.meta.url));

/**
 * PROVENANCE OF THE PARSED INPUT — a diagnostic, never a failure.
 *
 * Every coverage assertion below derives its DECLARED set by reading
 * `turn-start-orientation.ts` / `agent-obligations.ts` off disk at test time.
 * That is deliberate (a hand-listed copy of a union the code owns drifts), but
 * it makes the declared set an input that can MOVE: on the shared checkout a
 * peer can be mid-edit in exactly those files.
 *
 * Measured 2026-09-22T00:45Z, while plan item P-023 was re-homing the
 * orientation classes into a shared declaration: this file reported 20 of 32
 * assertions failing, then 32 of 32 passing four minutes later, with no edit of
 * my own in between and `turn-start-orientation.ts` carrying an uncommitted
 * change throughout. A moving declared set fails the render probes with
 * ORDINARY assertion text, so that transient red is indistinguishable from the
 * real coverage regression this guard exists to catch — and the natural next
 * move is to go "fix" render paths that were never broken.
 *
 * So the failure message says which input was moving. This NEVER changes a
 * verdict: the note is EMPTY when every parsed source is committed-clean, which
 * is the only state the green-checkpoint gate ever runs in (an isolated checkout
 * at a frozen candidate). It buys nothing there and everything for an ad-hoc
 * local run on a tree ~100 agents are mutating.
 */
type ParsedSourceProvenance =
  | { status: 'clean' }
  | { status: 'uncommitted'; paths: string[] }
  | { status: 'unknown'; reason: string };

function readParsedSourceProvenance(absolutePaths: string[]): ParsedSourceProvenance {
  try {
    const stdout = execFileSync('git', ['status', '--porcelain', '--', ...absolutePaths], {
      cwd: dirname(ORIENTATION_SOURCE),
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Porcelain v1 is `XY <path>`; a diagnostic does not need rename parsing.
    const paths = stdout
      .split('\n')
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3).trim());
    return paths.length === 0 ? { status: 'clean' } : { status: 'uncommitted', paths };
  } catch (error) {
    return { status: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
}

const PARSED_SOURCE_PROVENANCE = readParsedSourceProvenance([ORIENTATION_SOURCE, OBLIGATIONS_SOURCE]);

/**
 * '' exactly when every parsed source is committed-clean, so a genuine failure
 * on a clean tree reads precisely as it did before this diagnostic existed.
 *
 * Takes its reading as a PARAMETER so the control test below can exercise all
 * three branches without depending on the state of the tree it runs on.
 */
function parsedSourceNote(provenance: ParsedSourceProvenance): string {
  if (provenance.status === 'clean') return '';
  if (provenance.status === 'unknown') {
    return (
      ` [parsed-source provenance UNKNOWN (${provenance.reason}) — could not establish whether the` +
      ` declared set above was read from a committed blob]`
    );
  }
  return (
    ` [⚠ the declared set above was parsed from UNCOMMITTED source: ${provenance.paths.join(', ')} —` +
    ` a peer may be mid-edit, so this failure can be a MOVING INPUT rather than a coverage` +
    ` regression. Re-run against a clean tree before believing it]`
  );
}

/**
 * The DECLARED set, read from the interface rather than restated here.
 *
 * Throws instead of returning `[]` when it cannot find the interface or its
 * members: an empty declared set would make every coverage assertion below pass
 * vacuously, which is the precise failure this guard exists to prevent.
 */
function declaredOrientationClasses(): string[] {
  const text = readFileSync(ORIENTATION_SOURCE, 'utf8');
  const source = ts.createSourceFile(ORIENTATION_SOURCE, text, ts.ScriptTarget.Latest, true);
  let members: string[] | null = null;
  source.forEachChild((node) => {
    if (!ts.isInterfaceDeclaration(node) || node.name.text !== 'OrientationState') return;
    members = node.members
      .filter(ts.isPropertySignature)
      .map((member) => (ts.isIdentifier(member.name) ? member.name.text : null))
      .filter((name): name is string => Boolean(name));
  });
  if (!members) throw new Error('coverage guard is broken: interface OrientationState was not found');
  if ((members as string[]).length === 0) {
    throw new Error('coverage guard is broken: OrientationState parsed to zero property signatures');
  }
  return members;
}

/**
 * Classes that are deliberately NOT expected to reach a rendered prompt.
 *
 * Empty today, and that is the point: removing a class from the per-turn block
 * (plan P-017 does exactly that to the improvement-triage line) means moving its
 * name HERE with a reason, so the drop is recorded rather than silently
 * indistinguishable from the regression this file detects.
 */
const DELIBERATELY_UNRENDERED: Record<string, string> = {
  improvementTriage:
    'P-017 (plan turn-start-memory-two-class-2026-09-21, rationale D-003): withdrawn from the ' +
    'per-turn block after rendering on every turn with zero observed action — the canonical ' +
    'signal-decay case. The field and its provider REMAIN on OrientationState so the full ' +
    'coord:orient payload still serves it on demand; only the unconditional per-turn line is ' +
    'gone. This entry is what makes that a recorded DECISION rather than a coverage gap.',
  obligationsWithheldBy:
    'R-4 / D-032 (WI-10003799): a MODIFIER of `obligations`, not a class of its own (folded into it via ' +
    'FIELDS_RENDERED_BY_CLASS). It is set only when a goal experiment arm withholds the per-turn agenda, ' +
    'and then `obligations` is null, so the per-turn block renders nothing for either field. Its one ' +
    'consumer is the su.mode-goal receipt, which reads it to stamp the omission reason experiment-arm ' +
    'instead of ineligible. Rendering a per-turn line for it would defeat the arm, whose whole point is ' +
    'that the agent does NOT see the agenda.',
};

interface ClassProbe {
  /** Populates ONLY this class, over the baseline below. */
  patch: Partial<OrientationState>;
  /** The line this class is supposed to put on the rendered prompt. */
  marker: RegExp;
}

/**
 * A live-shaped, deliberately QUIET session: every class empty/false/null, so
 * any line a probe adds is attributable to the class that probe populated.
 * `loopArmed: true` because an armed loop is the healthy live shape — the
 * `loopArmed` probe flips it OFF, which is the direction that renders a warning.
 */
const BASELINE: OrientationState = {
  planDecisions: undefined,
  // Empty ARRAYS, not `undefined` — the same distinction `modes: []` records
  // below. `undefined` would also render nothing, but it means UNREADABLE, so
  // a baseline built on it would be silent for the wrong reason and would keep
  // passing if the lock reader were entirely broken. `observed: []` is the
  // measured-empty identity set: this owner holds nothing and waits on nothing.
  lockTransitions: { held: [], blocked: [], observed: [] },
  coupledPeers: [],
  held: [],
  unansweredDirected: 0,
  unansweredStale: 0,
  inboxRecent: [],
  openAsks: null,
  announcedGates: [],
  // `[]` — READABLE and empty, the quiet shape. `null` would also render
  // nothing, but it means UNREADABLE, so using it here would make the baseline
  // silent for the wrong reason and hide a genuinely broken reader.
  modes: [],
  // `null` — UNREADABLE, which is the only quiet shape this class HAS: there is
  // no empty AuthorityVerdict (three required strings), and a blank-valued one
  // would render `- authority: exec  · mission  · …` on a cursorless baseline.
  // The probe below is what proves the class still reaches the prompt.
  authorityVerdict: null,
  loopArmed: true,
  loopFireWithheld: false,
  improvementTriage: null,
  executableFrontier: null,
  neverDropFacts: [],
  toolSurface: null,
  carryBlindWindow: null,
};

const OBLIGATION_BRIEF = {
  schemaVersion: 'agent-obligation-agenda-v1',
  evaluatedAt: '2026-09-21T16:00:00.000Z',
  sourceGeneration: '12',
  evaluations: [],
  primary: null,
  detailRef: "coord:orient { afterCompaction: true }",
  projection: {
    text: '- obligation: settle the pending owner directive',
    receipt: { entriesOmitted: 0 },
  },
} as unknown as AgentObligationBrief;

const CLASS_PROBES: Record<string, ClassProbe> = {
  held: {
    patch: { held: [{ id: 'WI-10002196', status: 'wip', checkpoint: 'coverage guard in progress' }] },
    marker: /holding: WI-10002196/,
  },
  // A failed held-item read must render as UNAVAILABLE, never as "holds nothing".
  heldReadFailed: {
    patch: { heldReadFailed: true },
    marker: /held work-items: unavailable/,
  },
  ownerDirectives: {
    // recordedBy + capturedByHook are REQUIRED on OrientationOwnerDirective since
    // P-007 (directive-visibility-and-ownership-2026-09-22). This probe predated
    // them and was never updated — a required-field strand — so the render threw
    // `Cannot read properties of undefined (reading 'length')` and, because
    // projectOrientationRows has no per-segment isolation, took the whole banner
    // with it. recordedBy is set to a session id that is NOT the probe's owner so
    // this stays a FOREIGN-directive fixture, which is the D-004 case worth
    // pinning: the row must still RENDER (label, never filter).
    patch: {
      ownerDirectives: [
        {
          id: 17,
          verbatimText: 'implement hybrid capture',
          recordedBy: 'su-probe-other-session',
          capturedByHook: true,
        },
      ],
    },
    marker: /owner directive #17/,
  },
  historyUpdates: {
    patch: { historyUpdates: [{ workItemId: 'WI-10002196', harness: 'papercusp', count: 2, newestPostId: 9 }] },
    marker: /post-claim history update/,
  },
  effortUpdates: {
    patch: { effortUpdates: [{ level: 'plan', ref: 'turn-start-memory-two-class-2026-09-21', count: 1, newestPostId: 4 }] },
    marker: /post-claim plan\/goal revision/,
  },
  unansweredDirected: {
    patch: { unansweredDirected: 3 },
    marker: /directed msg\(s\) awaiting YOUR reply/,
  },
  unansweredStale: {
    patch: { unansweredStale: 2 },
    marker: /from ENDED senders/,
  },
  inboxRecent: {
    patch: { inboxRecent: [{ msgId: 'm-1', from: 'su-091ad703', summary: 'identity wedge answered in-thread' }] },
    marker: /^- inbox /,
  },
  openAsks: {
    patch: { openAsks: { count: 2, oldestAgeMs: 3_600_000, oldestTo: 'su-bb42b259' } },
    marker: /open ask\(s\) sent/,
  },
  announcedGates: {
    patch: { announcedGates: [{ event: 'fleet:demo:phase1-green' }] },
    marker: /announced gates:/,
  },
  authorityVerdict: {
    // Against a null committed cursor there is no previous verdict to diff, so
    // all three decisions render (D-073 ruling 3). The changed-only transition
    // shape is pinned separately; this probe only has to prove the class
    // reaches the rendered prompt at all.
    patch: {
      authorityVerdict: {
        executionAuthorization: 'act-with-disclosure',
        mission: 'execute-fleet-plan-only',
        ideation: 'direct-improvements-only',
      },
    },
    marker: /authority: exec act-with-disclosure/,
  },
  planDecisions: {
    // Against a null committed cursor NOTHING has been seen yet, so every
    // decision is fresh and renders — the same diff shape as `authorityVerdict`
    // above. The seen/fresh transition and the two incompleteness disclosures
    // are pinned separately; this probe only has to prove the class reaches the
    // rendered prompt at all.
    patch: {
      planDecisions: {
        decisions: [
          {
            ref: 'demo-plan#D-001',
            planSlug: 'demo-plan',
            id: 'D-001',
            title: 'The ruling a claimed lane must read before acting',
          },
        ],
        omitted: 0,
        authorityReadFailed: false,
      },
    },
    marker: /plan demo-plan D-001:/,
  },
  lockTransitions: {
    // A BLOCKED row, not a granted one, because this probe has to render
    // against a null committed cursor and only the blocked half can. `granted`
    // requires the `b:` token to be IN the committed cursor (the agent queued
    // last turn) — cursorless, that conjunct is false by construction, so a
    // granted probe here would pass vacuously by rendering nothing whether or
    // not the class were wired up at all. The granted transition needs a real
    // prior cursor and is pinned in the dedicated lock-transition suite.
    patch: {
      lockTransitions: {
        held: [],
        blocked: [
          {
            kind: 'blocked',
            path: 'packages/operator-core/lib/demo-contested.ts',
            // Path-shaped but deliberately NOT under `/home/<user>` — a
            // hardcoded home path in shipped source reds the identity-lint leg
            // of the green checkpoint. The value only has to be a stable
            // opaque domain key; nothing here reads it as a real checkout.
            coordinationDomain: '/srv/demo-checkout/papercusp',
            holder: {
              owner: 'su-demo0000-0000-0000-0000-000000000000',
              ownerLabel: 'su · su-demo0',
              intent: 'rewriting the demo resolver',
              expiresTs: '2026-09-21T16:30:00.000Z',
            },
          },
        ],
        observed: ['b:/srv/demo-checkout/papercusp:packages/operator-core/lib/demo-contested.ts'],
      },
    },
    marker: /blocked on packages\/operator-core\/lib\/demo-contested\.ts — held by su · su-demo0/,
  },
  coupledPeers: {
    // P-016. Against a null committed cursor every coupled peer is a NEW
    // intent, so this renders. The steady-state-silent and change-once halves
    // need a real prior cursor and are pinned in
    // turn-start-orientation-coupled-peers.test.ts; this probe only has to
    // prove the class reaches the rendered prompt at all.
    patch: {
      coupledPeers: [
        {
          ownerId: 'su-demo1111-1111-1111-1111-111111111111',
          ownerLabel: 'su · su-demo1',
          intent: 'rewiring the demo coupling reader',
        },
      ],
    },
    marker: /coupled su · su-demo1 → rewiring the demo coupling reader/,
  },
  modes: {
    // Against a null committed cursor every row is NEW, so this renders. The
    // three attribution shapes are pinned individually in turn-start-orientation.test.ts;
    // this probe only has to prove the class reaches the rendered prompt at all.
    patch: {
      modes: [
        {
          axisKey: 'autonomy',
          mode: 'auto',
          reason: 'owner said run autonomously',
          setBy: 'su-c03852cb',
          setBySelf: false,
          ownerDirected: true,
          impliedBy: null,
        },
      ],
    },
    marker: /mode auto ON — owner-directed/,
  },
  loopArmed: {
    patch: { loopArmed: false },
    marker: /engine loop: not armed/,
  },
  loopFireWithheld: {
    patch: { loopFireWithheld: true },
    marker: /withheld for interactive turn/,
  },
  executableFrontier: {
    patch: { executableFrontier: { planSlug: 'turn-start-memory-two-class-2026-09-21', executableWidth: 3 } },
    marker: /frontier: 3 executable/,
  },
  obligations: {
    patch: { obligations: OBLIGATION_BRIEF },
    marker: /obligation/,
  },
  neverDropFacts: {
    patch: { neverDropFacts: ['dead-end:gate-lastfiredat-not-evidence'] },
    marker: /never-drop facts:/,
  },
  toolSurface: {
    patch: { toolSurface: { hookCalls: 24, windowMinutes: 31 } },
    marker: /No agent-origin MCP calls recorded in 31m/,
  },
  carryBlindWindow: {
    patch: {
      carryBlindWindow: {
        snapshotAtMs: Date.parse('2026-09-21T16:10:38.858Z'),
        cutAtMs: Date.parse('2026-09-21T16:11:01.000Z'),
        windowMs: 22_142,
        callsAfter: 4,
        lastCallAtMs: Date.parse('2026-09-21T16:10:59.000Z'),
        lastToolName: 'loop:checkpoint',
      },
    },
    marker: /carry blind window:/,
  },
  // P-010 (WI-10002221, su-6b1151ea): registered here by su-c03852cb because the
  // class landed without its per-sink classification while that session was
  // MCP-dark, which reds this guard for the whole fleet. The author is welcome
  // to re-word the omission reason below — the CLASSIFICATION is what the
  // matrix requires, not any particular wording.
  openChecks: {
    patch: {
      openChecks: [
        {
          id: 'coverage-probe-1',
          claim: 'a carried claim that has not been re-verified',
          recheck: 'run the recorded probe',
          pointer: 'loop:status',
          kind: 'check',
        },
      ],
    },
    marker: /🔎 \? UNVERIFIED/,
  },
};

/**
 * A POPULATING patch for every DELIBERATELY_UNRENDERED class. Without one the
 * withdrawal is only asserted in prose: the class would be excused from the
 * coverage test and nothing would notice if its line came back, or if it had
 * never actually been removed. With one, "deliberately unrendered" becomes a
 * measured claim — populate the class, and the renderer must stay silent.
 */
const UNRENDERED_PROBES: Record<string, Partial<OrientationState>> = {
  improvementTriage: {
    improvementTriage: {
      pending: 100,
      considered: 100,
      lowerBound: true,
      top: { id: 'EI-23817792409764138', title: 'live SMTP rejection contradicts cached OK', lane: 'human' },
    },
  },
  // The only value the field can take. Populated alone over the quiet baseline, so any
  // line it adds is attributable to it and trips the silence requirement.
  obligationsWithheldBy: { obligationsWithheldBy: 'experiment-arm' },
};

/**
 * The permanent CONTROL: a class that IS declared to this guard but that the
 * renderer has no path for. It must make the assertion below throw.
 */
const CONTROL_CLASS = '__control_declared_but_unrendered';
const CONTROL_PROBE: ClassProbe = {
  // Not a member of OrientationState, so renderOrientationLines cannot read it —
  // which is exactly the shape of a class that was declared and never wired.
  patch: { [CONTROL_CLASS]: ['present but unrendered'] } as unknown as Partial<OrientationState>,
  marker: /control-marker-that-is-never-rendered/,
};

function linesAddedBy(probe: ClassProbe): string[] {
  const baseline = renderOrientationLines(BASELINE);
  const populated = renderOrientationLines({ ...BASELINE, ...probe.patch });
  return populated.filter((line) => !baseline.includes(line));
}

/** THROWS when a declared class does not reach the rendered prompt. */
function assertClassReachesRenderedPrompt(
  name: string,
  probe: ClassProbe,
  note = parsedSourceNote(PARSED_SOURCE_PROVENANCE),
): void {
  const added = linesAddedBy(probe);
  if (added.length === 0) {
    throw new Error(`declared orientation class '${name}' produced no rendered line` + note);
  }
  if (!added.some((line) => probe.marker.test(line))) {
    throw new Error(
      `declared orientation class '${name}' rendered ${added.length} line(s) but none matched ${probe.marker}: ` +
        JSON.stringify(added) +
        note,
    );
  }
}

// ── Obligation-family coverage (P-006 registers `owner-directive` here) ───────
//
// `obligations` is ONE OrientationState field carrying a whole SUB-TAXONOMY:
// every provider family funnels through it. So the probe above ("populating
// `obligations` adds a line") cannot distinguish a family that renders from one
// that is built, evaluated, and then silently dropped before the prompt — the
// 0/334 failure mode, one level down. A new family is a new CLASS, and this is
// where every later item of this plan registers it.
//
// The declared set is PARSED from the `AgentObligationFamily` union for the same
// reason the orientation classes are: a hand-listed copy of a union the code
// already owns drifts the moment someone adds a member and forgets the list.

/** The declared family set, read from the union rather than restated here. */
function declaredObligationFamilies(): string[] {
  const text = readFileSync(OBLIGATIONS_SOURCE, 'utf8');
  const source = ts.createSourceFile(OBLIGATIONS_SOURCE, text, ts.ScriptTarget.Latest, true);
  let members: string[] | null = null;
  source.forEachChild((node) => {
    if (!ts.isTypeAliasDeclaration(node) || node.name.text !== 'AgentObligationFamily') return;
    if (!ts.isUnionTypeNode(node.type)) return;
    members = node.type.types
      .map((member) =>
        ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal) ? member.literal.text : null,
      )
      .filter((name): name is string => Boolean(name));
  });
  if (!members) throw new Error('coverage guard is broken: type AgentObligationFamily was not found');
  if ((members as string[]).length === 0) {
    throw new Error('coverage guard is broken: AgentObligationFamily parsed to zero string members');
  }
  return members;
}

const FAMILY_OBSERVED_AT = '2026-09-21T16:00:00.000Z';

/**
 * A minimal ACTIONABLE obligation of one family.
 *
 * Synthetic for families whose own providers are already covered by their own
 * suites: what this registry measures is the RENDER path per family, not the
 * provider's arithmetic. `owner-directive` below deliberately uses its REAL
 * provider instead, because that path is what P-006 adds and an end-to-end
 * probe is strictly stronger where it is cheap.
 */
function syntheticFamilyObligation(family: AgentObligationFamily, marker: string): AgentObligation {
  return defineAgentObligation({
    ruleId: `coverage-probe-${family}`,
    ruleRevision: 'coverage-probe-v1',
    family,
    title: marker,
    scope: { workspaceId: 'papercusp-workspace', ownerId: 'su-coverage-probe' },
    responsibleOwnerId: 'su-coverage-probe',
    episode: `probe:${family}`,
    status: 'due',
    authority: { kind: 'policy', sourceRef: `coverage-probe:${family}`, revision: 'coverage-probe-v1' },
    reason: `coverage probe for the ${family} family`,
    priority: 'high',
    causalRank: 0,
    applicableDemand: 1,
    sourceGeneration: 'coverage-probe',
    evidence: [],
    action: { kind: 'inspect', summary: `probe action for ${family}` },
    clearsWhen: {
      id: `coverage-probe-${family}`,
      summary: 'the probe is removed',
      evidenceKind: 'state',
      sourceRef: `coverage-probe:${family}`,
    },
  });
}

interface FamilyProbe {
  /** Obligations of exactly this family, as a real agenda would carry them. */
  build: () => AgentObligation[];
  /** The text this family is supposed to put on the rendered prompt. */
  marker: RegExp;
}

const FAMILY_PROBES: Record<string, FamilyProbe> = {
  'plan-placement': {
    build: () => [syntheticFamilyObligation('plan-placement', 'plan-placement coverage probe')],
    marker: /plan-placement coverage probe/,
  },
  'planning-needed': {
    build: () => [syntheticFamilyObligation('planning-needed', 'planning-needed coverage probe')],
    marker: /planning-needed coverage probe/,
  },
  'owner-report': {
    build: () => [syntheticFamilyObligation('owner-report', 'owner-report coverage probe')],
    marker: /owner-report coverage probe/,
  },
  'independent-verification': {
    build: () => [
      syntheticFamilyObligation('independent-verification', 'independent-verification coverage probe'),
    ],
    marker: /independent-verification coverage probe/,
  },
  // P-006: the real provider, on a real pending row. This asserts the whole
  // chain the item specifies — a pending directive becomes a class-B row whose
  // disposition verb and `orders:get` recovery pointer reach the prompt.
  'owner-directive': {
    build: () =>
      ownerDirectiveObligations({
        workspaceId: 'papercusp-workspace',
        ownerId: 'su-coverage-probe',
        observedAt: FAMILY_OBSERVED_AT,
        sourceGeneration: 'coverage-probe',
        read: {
          status: 'known',
          value: [
            {
              id: 17,
              state: 'open',
              displayText: '"Implement owner-directive capture as HYBRID"',
              recordedAt: '2026-09-21T15:27:44.000Z',
              recordedBy: 'su-c03852cb',
              capturedByHook: true,
            },
          ],
        },
      }),
    marker: /owner directive .*#17|#17/,
  },
  // P-011: the real provider, on real row shapes. The probe carries BOTH row
  // kinds because they render through different branches, and uses an `expire`
  // await deliberately — that is the row whose absence from the prompt is
  // unrecoverable (it lapses with no turn, so nothing else ever mentions it).
  'waiting-on': {
    build: () =>
      waitingOnObligations({
        workspaceId: 'papercusp-workspace',
        ownerId: 'su-coverage-probe',
        observedAt: FAMILY_OBSERVED_AT,
        sourceGeneration: 'coverage-probe',
        read: {
          status: 'known',
          value: [
            {
              kind: 'event-await',
              key: 'gate:coverage-probe',
              timeoutAt: '2026-09-21T16:00:00.000Z',
              onTimeout: 'expire',
            },
            {
              kind: 'lock-queue',
              path: 'packages/operator-core/lib/coverage-probe.ts',
              holder: 'su-probe-holder',
              holderIntent: 'coverage probe holder intent',
              holderExpiresAt: '2026-09-21T16:05:00.000Z',
            },
          ],
        },
      }),
    marker: /gate:coverage-probe/,
  },
  // P-005 / D-030: the real provider, on the row whose absence is the failure this
  // family exists for — a led fleet at zero workers that nothing will restore.
  'fleet-staffing': {
    build: () =>
      fleetStaffingObligations({
        workspaceId: 'papercusp-workspace',
        ownerId: 'su-coverage-probe',
        observedAt: FAMILY_OBSERVED_AT,
        sourceGeneration: 'coverage-probe',
        read: {
          status: 'known',
          value: [
            {
              fleetSlug: 'fleet-coverage-probe',
              evaluation: {
                alert: true,
                current: 0,
                target: 3,
                shortfall: 3,
                held: false,
                notHeldBecause: 'supervise-not-granted',
                topUpRule: null,
                repair: 'fleet:headcount-target { target, supervise:true }',
                reason: '0 of 3 target worker(s) are productive (short 3).',
              },
            },
          ],
        },
      }),
    marker: /fleet-coverage-probe/,
  },
  // P-005 / R-5: the real provider, on the row the measured incident needed — a
  // goal-created item left unassigned by a refused launch.
  'stranded-goal-work': {
    build: () =>
      strandedGoalWorkObligations({
        workspaceId: 'papercusp-workspace',
        ownerId: 'su-coverage-probe',
        goalId: 'goal-coverage-probe',
        observedAt: FAMILY_OBSERVED_AT,
        sourceGeneration: 'coverage-probe',
        read: {
          status: 'known',
          value: {
            goalId: 'goal-coverage-probe',
            thresholdMs: 4 * 60 * 60_000,
            total: 1,
            refusedCount: 1,
            sample: [
              {
                id: 'WI-stranded-coverage-probe',
                title: 'coverage probe item',
                createdAt: FAMILY_OBSERVED_AT,
                placementRefusal: {
                  at: FAMILY_OBSERVED_AT,
                  reason: 'goal_max_agents',
                  goalId: 'goal-coverage-probe',
                  launcherOwnerId: 'su-coverage-probe',
                  message: 'probe refusal',
                  source: 'capability:launch-agent',
                },
              },
            ],
            truncatedByLimit: false,
          },
        },
      }),
    marker: /stranded unassigned/,
  },
};

function obligationBriefFor(obligations: AgentObligation[]): AgentObligationBrief {
  return projectAgentTurnStartObligationBrief(evaluateAgentObligations(obligations, FAMILY_OBSERVED_AT));
}

function linesAddedByFamily(probe: FamilyProbe): string[] {
  const baseline = renderOrientationLines(BASELINE);
  const populated = renderOrientationLines({ ...BASELINE, obligations: obligationBriefFor(probe.build()) });
  return populated.filter((line) => !baseline.includes(line));
}

/** THROWS when a declared obligation family does not reach the rendered prompt. */
function assertFamilyReachesRenderedPrompt(
  name: string,
  probe: FamilyProbe,
  note = parsedSourceNote(PARSED_SOURCE_PROVENANCE),
): void {
  const added = linesAddedByFamily(probe);
  if (added.length === 0) {
    throw new Error(`declared obligation family '${name}' produced no rendered line` + note);
  }
  if (!added.some((line) => probe.marker.test(line))) {
    throw new Error(
      `declared obligation family '${name}' rendered ${added.length} line(s) but none matched ${probe.marker}: ` +
        JSON.stringify(added) +
        note,
    );
  }
}

/**
 * The permanent CONTROL for the family registry: a family whose only obligation
 * is `not-applicable` is never actionable, so it never enters `agenda.primary`
 * and the turn-start projection has nothing to render. If the helper above is
 * ever weakened into something that cannot fail, this goes red.
 */
const FAMILY_CONTROL_PROBE: FamilyProbe = {
  build: () => [
    defineAgentObligation({
      ruleId: 'coverage-probe-control',
      ruleRevision: 'coverage-probe-v1',
      family: 'owner-directive',
      title: 'control-family-that-is-never-rendered',
      scope: { workspaceId: 'papercusp-workspace', ownerId: 'su-coverage-probe' },
      responsibleOwnerId: 'su-coverage-probe',
      episode: 'probe:control',
      status: 'not-applicable',
      authority: { kind: 'policy', sourceRef: 'coverage-probe:control', revision: 'coverage-probe-v1' },
      reason: 'the permanent non-actionable control',
      priority: 'low',
      causalRank: 0,
      applicableDemand: 0,
      sourceGeneration: 'coverage-probe',
      evidence: [],
      clearsWhen: {
        id: 'coverage-probe-control',
        summary: 'the probe is removed',
        evidenceKind: 'state',
        sourceRef: 'coverage-probe:control',
      },
    }),
  ],
  marker: /control-family-that-is-never-rendered/,
};

describe('turn-start orientation obligation-family coverage', () => {
  const families = declaredObligationFamilies();

  it('reads a non-trivial declared family set from AgentObligationFamily (instrument calibration)', () => {
    expect(families.length).toBeGreaterThanOrEqual(4);
    expect(families).toContain('owner-directive');
  });

  it('has a probe for every declared obligation family', () => {
    const unregistered = families.filter((name) => !FAMILY_PROBES[name]);
    expect(
      unregistered,
      'a new AgentObligationFamily must register a probe in FAMILY_PROBES, or nothing notices when it never renders',
    ).toEqual([]);
  });

  it('has no probe for a family AgentObligationFamily no longer declares', () => {
    const declaredSet = new Set(families);
    const orphaned = Object.keys(FAMILY_PROBES).filter((name) => !declaredSet.has(name));
    expect(orphaned, 'a probe outlived its family — delete it rather than testing a family nothing emits').toEqual([]);
  });

  it.each(Object.keys(FAMILY_PROBES))('declared obligation family %s reaches a rendered prompt', (name) => {
    expect(() => assertFamilyReachesRenderedPrompt(name, FAMILY_PROBES[name]!)).not.toThrow();
  });

  it('fails when a declared family never renders (permanent falsifiability control)', () => {
    expect(() => assertFamilyReachesRenderedPrompt('__control', FAMILY_CONTROL_PROBE)).toThrow(
      /produced no rendered line/,
    );
  });

  it('carries the owner-directive disposition verb and recovery pointer into the agenda', () => {
    // The class-B row contract: id, the disposition verb, and the `orders:get`
    // recovery pointer; the uncut D-004 text rides in `reason` (P-004). The turn-start
    // sink is budgeted to the ACTION line, so the pointer is asserted on the
    // agenda entry the recovery reader retains, not on the 400-char slice.
    const [open] = FAMILY_PROBES['owner-directive']!.build();
    expect(open!.status).toBe('due');
    // D-001: an open directive closes only by disposition — no triage verb.
    expect(open!.action?.tool).toBe('orders:disposition');
    expect(open!.action?.targetRef).toBe('orders:get #17');
    expect(open!.reason).toContain('Implement owner-directive capture as HYBRID');
  });
});

describe('turn-start orientation class coverage', () => {
  const declared = declaredOrientationClasses();

  it('reads a non-trivial declared set from OrientationState (instrument calibration)', () => {
    // Without this, a parser that silently returns a short list would make every
    // assertion below pass while measuring almost nothing.
    expect(declared.length).toBeGreaterThanOrEqual(17);
    expect(declared).toContain('held');
    expect(declared).toContain('neverDropFacts');
    expect(declared).toContain('obligations');
  });

  it('has a probe or an explicit exclusion for every declared class', () => {
    const covered = new Set([...Object.keys(CLASS_PROBES), ...Object.keys(DELIBERATELY_UNRENDERED)]);
    const unregistered = declared.filter((name) => !covered.has(name));
    expect(
      unregistered,
      'a new OrientationState field must get a probe in CLASS_PROBES, or a reason in DELIBERATELY_UNRENDERED',
    ).toEqual([]);
  });

  it('has no probe for a class that OrientationState no longer declares', () => {
    const declaredSet = new Set(declared);
    const orphaned = Object.keys(CLASS_PROBES).filter((name) => !declaredSet.has(name));
    expect(orphaned, 'a probe outlived its class — delete it rather than testing a field nothing populates').toEqual([]);
  });

  it('has a populating patch for every deliberately-unrendered class', () => {
    // Calibration: without a patch, the assertion below would trivially pass on
    // an empty state and "deliberately unrendered" would measure nothing.
    const unmeasured = Object.keys(DELIBERATELY_UNRENDERED).filter((name) => !UNRENDERED_PROBES[name]);
    expect(
      unmeasured,
      'a DELIBERATELY_UNRENDERED entry needs a patch in UNRENDERED_PROBES, or its withdrawal is never measured',
    ).toEqual([]);
  });

  it.each(Object.keys(DELIBERATELY_UNRENDERED))(
    'deliberately-unrendered class %s adds no line to the per-turn block',
    (name) => {
      const added = linesAddedBy({ patch: UNRENDERED_PROBES[name]!, marker: /(?!)/ });
      expect(
        added,
        `'${name}' is recorded as deliberately unrendered, but populating it still produced a line`,
      ).toEqual([]);
    },
  );

  it.each(Object.keys(CLASS_PROBES))('declared class %s reaches a rendered prompt', (name) => {
    expect(() => assertClassReachesRenderedPrompt(name, CLASS_PROBES[name]!)).not.toThrow();
  });

  it('fails when a declared class never renders (permanent falsifiability control)', () => {
    expect(() => assertClassReachesRenderedPrompt(CONTROL_CLASS, CONTROL_PROBE)).toThrow(
      /produced no rendered line/,
    );
  });

  it('labels a failure with its parsed-source provenance, and stays silent when clean (permanent control)', () => {
    // All three branches, driven by synthetic readings so this control cannot go
    // vacuous on a clean tree (or on a dirty one). Weaken `parsedSourceNote`
    // into something that always returns '' and three of these fail.
    expect(parsedSourceNote({ status: 'clean' })).toBe('');
    const dirty = parsedSourceNote({ status: 'uncommitted', paths: ['lib/turn-start-orientation.ts'] });
    expect(dirty).toContain('UNCOMMITTED source');
    expect(dirty).toContain('lib/turn-start-orientation.ts');
    expect(parsedSourceNote({ status: 'unknown', reason: 'git missing' })).toContain('UNKNOWN');

    // Calibration: the LIVE reading resolves to one of the three and never throws,
    // so the diagnostic cannot itself become the reason this file goes red.
    expect(['clean', 'uncommitted', 'unknown']).toContain(PARSED_SOURCE_PROVENANCE.status);
  });

  it('carries the parsed-source note into the message of a real coverage failure', () => {
    // Reuses the permanent control probe, so the wiring under test is the same
    // path an actual regression takes — not a parallel message built for a test.
    const note = parsedSourceNote({ status: 'uncommitted', paths: ['lib/agent-obligations.ts'] });
    expect(() => assertClassReachesRenderedPrompt(CONTROL_CLASS, CONTROL_PROBE, note)).toThrow(
      /parsed from UNCOMMITTED source: lib\/agent-obligations\.ts/,
    );
    expect(() => assertFamilyReachesRenderedPrompt('control', FAMILY_CONTROL_PROBE, note)).toThrow(
      /parsed from UNCOMMITTED source: lib\/agent-obligations\.ts/,
    );
  });

  it('fails when a declared class renders something other than its own line', () => {
    // The second half of the assertion: reaching SOME line is not enough, or a
    // class could be credited for a neighbour's output.
    expect(() =>
      assertClassReachesRenderedPrompt('held', { patch: CLASS_PROBES.held!.patch, marker: /never-drop facts:/ }),
    ).toThrow(/none matched/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P-024 — THE (CLASS × SINK) COVERAGE MATRIX
// ═══════════════════════════════════════════════════════════════════════════
//
// WHAT CHANGED AND WHY. Everything above asserts that a declared class reaches
// A rendered prompt — ONE sink, turn-start, via `renderOrientationLines`. Once
// classes became sink-scoped (P-023 / D-015: one declaration, several surfaces
// selecting from it at their own budget), that single-sink assertion stopped
// describing coverage. A class can reach turn-start perfectly and be silently
// absent from the leader brief — which is EXACTLY the hole P-025 measured:
// `neverDropFacts` rendered on every turn-start block while the fleet leader,
// who has the widest blast radius on the pot, received zero never-drop facts
// and nothing anywhere went red. Coverage is a MATRIX, so the guard is a matrix.
//
// ⚠ THE TRAP THIS SECTION IS BUILT AROUND — `unrenderedReason` MEANS TWO
// OPPOSITE THINGS, and a derivation that misses it breaks the guard while
// looking like a cleanup. Two registry entries carry `segments: []` plus an
// `unrenderedReason`, and they behave in OPPOSITE directions at the prompt:
//
//   • `loopFireWithheld` — "rendered as a VARIANT of the loopArmed line".
//     Populating it DOES add a line. It REACHES the sink; it just does not own
//     a segment of its own.
//   • `improvementTriage` — "deliberately not rendered" (P-017/D-003).
//     Populating it adds NOTHING. It does not reach the sink at all.
//
// So `segments.length === 0 && unrenderedReason != null` is TRUE for both and
// cannot tell reaching from silent. That is why the tables below key expected
// EMISSION off the guard's own `DELIBERATELY_UNRENDERED` rather than deriving
// it from the registry: the registry does not currently carry a discriminator
// that would make the derivation sound. Deriving it anyway — the obvious
// "rung 1" cleanup — turns the `loopFireWithheld` cell into a demand that the
// renderer stay silent, and this file goes red for a class that is working
// correctly. Recorded here because it is a cleanup a future author WILL reach
// for (this one did, and measured it instead).

/**
 * The declared SINK set, parsed from the `OrientationSink` union rather than
 * restated — the same derived-truth rung as the class and family sets above,
 * for the same reason: a hand-listed copy of a union the code owns drifts the
 * moment someone adds a member, and the matrix would then report full coverage
 * of a sink set that no longer describes the interface.
 *
 * Throws instead of returning `[]`, because an empty sink set would make every
 * matrix assertion below iterate nothing and pass vacuously.
 */
function declaredOrientationSinks(): string[] {
  const text = readFileSync(ORIENTATION_SOURCE, 'utf8');
  const source = ts.createSourceFile(ORIENTATION_SOURCE, text, ts.ScriptTarget.Latest, true);
  let members: string[] | null = null;
  source.forEachChild((node) => {
    if (!ts.isTypeAliasDeclaration(node) || node.name.text !== 'OrientationSink') return;
    if (!ts.isUnionTypeNode(node.type)) return;
    members = node.type.types
      .map((member) =>
        ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal) ? member.literal.text : null,
      )
      .filter((name): name is string => Boolean(name));
  });
  if (!members) throw new Error('coverage guard is broken: type OrientationSink was not found');
  if ((members as string[]).length === 0) {
    throw new Error('coverage guard is broken: OrientationSink parsed to zero string members');
  }
  return members;
}

/** What a probe observed when it populated one class and looked at one sink. */
interface CellReach {
  reached: boolean;
  /** What was actually observed, quoted into the failure message. */
  detail: string;
}

/** Populate ONE class, observe ONE sink. */
type CellProbe = () => CellReach | Promise<CellReach>;

/**
 * WHY A CLASS IS NOT CLAIMED BY A SINK. The three kinds are not cosmetic — they
 * carry OPPOSITE follow-up actions, and collapsing them into one "deliberately
 * omitted" bucket is what lets real drift hide behind a recorded decision:
 *
 *   `not-applicable`        — the sink's question genuinely does not want this
 *                             class. Nothing to do; this is a finished decision.
 *   `second-derivation`     — the class DOES reach this sink, but from a
 *                             SEPARATE re-derivation of the same truth. This is
 *                             DEBT, it is drift-prone by the derived-truth
 *                             ladder, and it MUST name the item that collapses
 *                             it. An omission recorded this way is a promise.
 *   `other-shared-mechanism`— the class DOES reach this sink, from the SAME
 *                             canonical derivation, through a different
 *                             single-source registry. Not drift-prone, so no
 *                             collapse is owed — but it must name the mechanism,
 *                             because "reaches by some other route" with no
 *                             route named is indistinguishable from a guess.
 */
interface SinkOmission {
  kind: 'not-applicable' | 'second-derivation' | 'other-shared-mechanism';
  reason: string;
  /** REQUIRED for `second-derivation`: the plan item that collapses the copy. */
  collapsedBy?: string;
  /** REQUIRED for `other-shared-mechanism`: the registry that carries it there. */
  mechanism?: string;
}

type SinkCoverage =
  | {
      status: 'pending';
      /** The plan item that will register this sink. */
      registeredBy: string;
      reason: string;
    }
  | {
      status: 'consuming';
      /** What this sink is FOR — the standard each omission below is judged against. */
      scope: string;
      /** Probe per class this sink CLAIMS. */
      probes: Record<string, CellProbe>;
      /** Classes this sink CLAIMS but that deliberately emit nothing here. */
      silent: Record<string, string>;
      /** Classes this sink does NOT claim — each a recorded DECISION. */
      omitted: Record<string, SinkOmission>;
    };

/** A turn-start cell probe: populate the class, look for its own line. */
function turnStartProbe(name: string): CellProbe {
  return () => {
    const probe = CLASS_PROBES[name];
    if (probe) {
      const added = linesAddedBy(probe);
      const matched = added.some((line) => probe.marker.test(line));
      return { reached: matched, detail: JSON.stringify(added) };
    }
    // A DELIBERATELY_UNRENDERED class: populate it and require silence. Without
    // the patch this measures nothing, which is the calibration the single-sink
    // section already established for UNRENDERED_PROBES.
    const patch = UNRENDERED_PROBES[name];
    if (!patch) return { reached: false, detail: 'no probe and no unrendered patch registered' };
    const added = linesAddedBy({ patch, marker: /(?!)/ });
    return { reached: added.length > 0, detail: JSON.stringify(added) };
  };
}

const neverDropFactProbe = (key: string): AgentFact =>
  ({ scope: 'workspace', scopeRef: null, key, body: 'b', sourceRef: null, audienceScope: null }) as AgentFact;

/**
 * The leader-brief cell probe for `neverDropFacts`, driven through the REAL
 * consumer (`readLeaderNeverDropFacts`) with only the fact store stubbed.
 *
 * This is deliberately an end-to-end probe rather than an assertion about the
 * registry row: the failure P-025 fixed was not a missing declaration, it was a
 * declaration nothing consumed. A probe that only re-read `applicableSinks`
 * would pass against a consumer that ignores the registry entirely.
 */
const leaderBriefNeverDropProbe: CellProbe = async () => {
  const out = await readLeaderNeverDropFacts(
    { ownerId: 'su-coverage-probe', workspaceId: 'papercusp-workspace' },
    { fold: async () => [neverDropFactProbe('dead-end:coverage-probe')] },
  );
  return { reached: out !== undefined && out.length > 0, detail: JSON.stringify(out) };
};

/**
 * The carry-brief cell probe for `neverDropFacts` (P-029), driven through the
 * REAL consumer (`readCarryNeverDropFacts`) with only the fact store stubbed.
 *
 * End-to-end for the same reason as the leader-brief probe above: a probe that
 * re-read `applicableSinks` would pass against a consumer that ignores the
 * registry entirely, which is the precise failure this sink was registered to
 * make impossible.
 *
 * ⚠ IT ALSO ASSERTS THE SELECTOR SET, which is the substantive part of P-029.
 * The document already folded owner-scoped facts before this item; what it
 * lacked was the WORKSPACE leg, so a consumer that quietly dropped back to
 * owner-only would still return facts and still look like it worked. The stub
 * therefore captures the selectors it is called with and the cell fails unless
 * a `workspace` selector is among them.
 */
const carryBriefNeverDropProbe: CellProbe = async () => {
  let seenSelectors: readonly { scope: string }[] = [];
  const out = await readCarryNeverDropFacts(
    { ownerId: 'su-coverage-probe', workspaceId: 'papercusp-workspace' },
    {
      fold: (async (selectors: readonly { scope: string }[]) => {
        seenSelectors = selectors;
        return [neverDropFactProbe('dead-end:coverage-probe')];
      }) as never,
    },
  );
  const foldedWorkspaceScope = seenSelectors.some((selector) => selector.scope === 'workspace');
  return {
    reached: out !== undefined && out.length > 0 && foldedWorkspaceScope,
    detail: JSON.stringify({ out, selectors: seenSelectors, foldedWorkspaceScope }),
  };
};

/**
 * The leader-brief cell probe for `announcedGates` (P-027), driven through the
 * REAL consumer with only the announcement store and the waiter count stubbed.
 *
 * The announcement is scoped to the probe's own fleet, so it exercises the
 * shared `selectVisibleAnnouncements` scoping rather than a bare pass-through:
 * a scoping regression that stopped matching `fleet` would empty this and the
 * cell would fail.
 */
const leaderBriefAnnouncedGatesProbe: CellProbe = async () => {
  const out = await readLeaderAnnouncedGates(
    { fleetSlug: 'coverage-probe-fleet', planSlug: null, harnessSlug: null },
    {
      listAnnouncements: async () =>
        [
          {
            id: 1,
            eventKey: 'fleet:coverage-probe:green',
            logicalGateKey: null,
            note: 'coverage probe gate',
            scopeKind: 'fleet',
            scopeRef: 'coverage-probe-fleet',
            subscriberId: 'su-coverage-probe',
            firedAt: null,
            firedReason: null,
          },
        ] as never,
      listAwaits: async () => [] as never,
    },
  );
  return { reached: Array.isArray(out) && out.length > 0, detail: JSON.stringify(out) };
};

/**
 * THE PER-SINK COVERAGE REGISTRY (P-024).
 *
 * One entry per declared `OrientationSink`. For a `consuming` sink every
 * declared class lands in exactly one of `probes` / `silent` / `omitted`, so a
 * class omitted from a sink is a RECORDED DECISION rather than a gap that
 * nothing notices — the matrix generalisation of `DELIBERATELY_UNRENDERED`.
 */
/**
 * The `agent-orders` cell probe (P-018), driven through the REAL shared
 * projection at the REAL sink.
 *
 * Mirrors {@link linesAddedBy} exactly — same BASELINE, same patch, same
 * marker — but projects at `'agent-orders'` instead of rendering turn-start.
 * That parallel is the point: a class whose rows differ between the two sinks
 * fails HERE, which is the P-018 guarantee stated as a coverage cell rather
 * than as a comment.
 *
 * Deliberately NOT an assertion about `applicableSinks`. Re-reading the
 * declaration would pass against a consumer that ignores the registry — the
 * same trap `leaderBriefNeverDropProbe` above documents.
 */
function agentOrdersProbe(name: string): CellProbe {
  return () => {
    const probe = CLASS_PROBES[name];
    if (!probe) return { reached: false, detail: `no CLASS_PROBES entry for ${name}` };
    const baseline = projectOrientationRows(BASELINE, 'agent-orders', null).map((r) => r.text);
    const populated = projectOrientationRows(
      { ...BASELINE, ...probe.patch },
      'agent-orders',
      null,
    ).map((r) => r.text);
    const added = populated.filter((line) => !baseline.includes(line));
    return { reached: added.some((line) => probe.marker.test(line)), detail: JSON.stringify(added) };
  };
}

/** `obligations` renders from a built agenda rather than a flat patch, so its
 *  probe mirrors {@link linesAddedByFamily} instead of {@link linesAddedBy}. */
const agentOrdersObligationsProbe: CellProbe = () => {
  const baseline = projectOrientationRows(BASELINE, 'agent-orders', null).map((r) => r.text);
  const populated = projectOrientationRows(
    { ...BASELINE, obligations: OBLIGATION_BRIEF },
    'agent-orders',
    null,
  ).map((r) => r.text);
  const added = populated.filter((line) => !baseline.includes(line));
  return { reached: added.length > 0, detail: JSON.stringify(added) };
};

/** One reason shared by every class this sink does not claim. The Orders rail
 *  answers "what standing obligation, and what changed, was this agent told
 *  about" — see TURN_START_AND_AGENT_ORDERS. A class outside that question is
 *  omitted for the same structural reason, stated per class below so
 *  withdrawing any single one stays a visible edit. */
const AGENT_ORDERS_NOT_AN_OBLIGATION = (what: string, why: string): SinkOmission => ({
  kind: 'not-applicable',
  reason:
    `${what} ${why} The HUD popup may still render it as OBSERVER DETAIL from its own ` +
    'sources (liveness, locks, the dossier rail) — this omission is about the shared ' +
    'obligation object, not about what the screen is allowed to show.',
});

const SINK_COVERAGE: Record<string, SinkCoverage> = {
  'agent-orders': {
    status: 'consuming',
    scope:
      "The HUD conversation popup's Orders rail (SessionChatModal → agentOrders.byOwner → getAgentOrders). " +
      'It answers ONE question for an observer: what standing obligation, and what changed, was this agent ' +
      'told about? Narrower than turn-start on purpose — the popup renders MORE overall, but its obligation ' +
      'section must be the rows turn-start rendered, character for character (P-018). A class belongs here ' +
      'only if it is part of that question; observer embellishment stays outside the shared object.',
    probes: {
      ownerDirectives: agentOrdersProbe('ownerDirectives'),
      openChecks: agentOrdersProbe('openChecks'),
      unansweredDirected: agentOrdersProbe('unansweredDirected'),
      neverDropFacts: agentOrdersProbe('neverDropFacts'),
      obligations: agentOrdersObligationsProbe,
    },
    silent: {
      obligationsWithheldBy:
        'Folded into `obligations`, so it is claimed here, but it never adds a row: an arm-withheld agenda ' +
        'is `obligations: null`, which is what an empty agenda looks like on this rail too. The popup must ' +
        'show exactly the rows turn-start rendered, and turn-start renders none (DELIBERATELY_UNRENDERED).',
    },
    omitted: {
      toolSurface: AGENT_ORDERS_NOT_AN_OBLIGATION(
        'An MCP-registration alarm about the reader\'s OWN session.',
        'It is an instrument fault, not something the agent was told to do, and the popup shows session ' +
          'health from live presence rather than from a turn-start warning.',
      ),
      carryBlindWindow: AGENT_ORDERS_NOT_AN_OBLIGATION(
        "A warning about the reader's own carry gap.",
        'It describes a property of the delivery channel, not an obligation standing against the agent.',
      ),
      historyUpdates: AGENT_ORDERS_NOT_AN_OBLIGATION(
        'Post-claim history movement on items the reader holds.',
        'A delta about work state rather than about what the agent was told; the popup already renders ' +
          'held-item state from the carry brief, where it is richer.',
      ),
      effortUpdates: AGENT_ORDERS_NOT_AN_OBLIGATION(
        'Post-claim plan/goal revisions.',
        'Same reading as historyUpdates — a work-state delta, and the popup carries plan context separately.',
      ),
      unansweredStale: AGENT_ORDERS_NOT_AN_OBLIGATION(
        "The reader's stale-sender backlog.",
        'A nudge about correspondence hygiene, not a standing obligation; `unansweredDirected` is the ' +
          'obligation half and IS claimed.',
      ),
      openAsks: AGENT_ORDERS_NOT_AN_OBLIGATION(
        'Asks the reader has OUTSTANDING against others.',
        'The direction is inverted: these are obligations the agent placed on someone else, so they do not ' +
          'answer what this agent was told.',
      ),
      modes: AGENT_ORDERS_NOT_AN_OBLIGATION(
        'The reader\'s active modes.',
        'The popup renders modes from `getAgentOrders.modes` WITH attribution the registry line does not ' +
          'carry (who set it, whether the owner directed it) — a strictly richer read from the mode ' +
          'registry itself, so importing the line would add a second, poorer copy.',
      ),
      authorityVerdict: AGENT_ORDERS_NOT_AN_OBLIGATION(
        'The reader\'s effective execution-authorization / mission / ideation verdict.',
        'It is DERIVED from the mode registry and the fleet route, not an instruction anyone placed on this ' +
          'agent — so it answers "what does that posture COMPUTE to", not "what was this agent told". The ' +
          'rail already renders the modes it derives from, with attribution this line does not carry, so ' +
          'importing the verdict would add a poorer second copy of its own input (same argument as `modes`).',
      ),
      planDecisions: AGENT_ORDERS_NOT_AN_OBLIGATION(
        'New governing decisions on plans the reader holds claimed items on.',
        'A plan Decision is a CONSTRAINT on how claimed work may be done, not an instruction placed on this ' +
          'agent: there is nothing to promote, dismiss, or drive to a terminal state, so it carries no ' +
          'disposition for this rail to track. The popup lists obligations the reader must CLOSE OUT, and a ' +
          'standing ruling never closes — it would sit there permanently unactioned, training the reader to ' +
          'ignore the list. The turn-start class delivers it as a diff instead, which is the right shape.',
      ),
      lockTransitions: AGENT_ORDERS_NOT_AN_OBLIGATION(
        'Locks newly granted to, or newly blocking, the reader.',
        'Nobody PLACED a lock transition on this agent: it is a fact about the environment its work runs in, ' +
          'not an instruction, so there is nothing to promote, dismiss, or drive to a terminal state. It is ' +
          'also SELF-CLOSING in a way no obligation is — a block clears when the holder releases, without ' +
          'the reader ever acting — so listing it on a close-out rail would show an entry that resolves ' +
          'itself, which is the same "permanently unactioned row" failure `planDecisions` records directly ' +
          'above, one step worse. The turn-start diff is the right shape: it is news exactly once.',
      ),
      coupledPeers: AGENT_ORDERS_NOT_AN_OBLIGATION(
        "A coupled peer's newly declared intent (P-016).",
        'Nobody PLACED it on this agent: it is a fact about a peer the reader opted to watch, not an ' +
          'instruction, so there is nothing to promote, dismiss, or drive to a terminal state. Like ' +
          '`lockTransitions` directly above it is superseded without the reader acting — the peer simply ' +
          'declares its next intent — so a close-out rail would accumulate rows that can never be closed. ' +
          'The turn-start diff is the right shape: each intent change is news exactly once.',
      ),
      loopArmed: AGENT_ORDERS_NOT_AN_OBLIGATION(
        'Whether the reader has a wake source armed.',
        'The popup reads loop state live from the carry brief (`carry.loopActive`, `loopIntervalSec`), ' +
          'which is current rather than as-of-last-turn.',
      ),
      loopFireWithheld: AGENT_ORDERS_NOT_AN_OBLIGATION(
        'A withheld loop fire.',
        'Scheduler mechanics about the reader\'s own loop, not an instruction it received.',
      ),
      held: AGENT_ORDERS_NOT_AN_OBLIGATION(
        "The reader's held work-items and checkpoints.",
        'The popup renders these from `carry.heldItems` with checkpoint ages and staleness verdicts the ' +
          'turn-start line deliberately compresses away; that richer read is the dossier\'s job.',
      ),
      heldReadFailed: AGENT_ORDERS_NOT_AN_OBLIGATION(
        'The held-item read failed (the unavailable variant of `held`).',
        'A read-health signal about the reader\'s own state, not an instruction it received. Same reasoning ' +
          'as `held`: the dossier reads held items itself and reports its own read failure.',
      ),
      executableFrontier: AGENT_ORDERS_NOT_AN_OBLIGATION(
        'What the reader could work on NEXT.',
        'A suggestion, not an obligation — nobody told the agent to take it.',
      ),
      announcedGates: AGENT_ORDERS_NOT_AN_OBLIGATION(
        'Gates declared in the reader\'s scope.',
        'An availability signal about what it MAY await, not a standing instruction.',
      ),
      inboxRecent: AGENT_ORDERS_NOT_AN_OBLIGATION(
        'Recent inbox excerpts.',
        'The popup IS a conversation view — it renders the real messages beside this rail, so an excerpt ' +
          'line would restate on screen what the screen already shows in full.',
      ),
      improvementTriage: AGENT_ORDERS_NOT_AN_OBLIGATION(
        'The withdrawn improvement-triage line.',
        'DELIBERATELY_UNRENDERED at turn-start since P-017 (signal decay: it rendered every turn and was ' +
          'acted on by nobody), so there is no row for this sink to share.',
      ),
    },
  },
  'turn-start': {
    status: 'consuming',
    scope:
      'The automatic per-turn block every agent receives. It is the widest sink by design: it answers ' +
      '"what does this agent need in front of it THIS turn", so every declared class claims it and the ' +
      'omitted table below is empty. A class that stops claiming turn-start is a withdrawal that needs ' +
      'the same recorded reason as any other omission.',
    // Derived from the single-sink tables above: every CLASS_PROBES entry is a
    // turn-start cell expected to reach, every DELIBERATELY_UNRENDERED entry is
    // a turn-start cell expected to stay silent. No second copy of either list.
    probes: Object.fromEntries(Object.keys(CLASS_PROBES).map((name) => [name, turnStartProbe(name)])),
    silent: DELIBERATELY_UNRENDERED,
    omitted: {},
  },

  'leader-brief': {
    status: 'consuming',
    scope:
      'Read ON DEMAND by a fleet leader, and budgeted to answer "what is my FLEET doing". A class about ' +
      'the READER\'s own session state is therefore not automatically wanted here — it reaches the same ' +
      'agent through their own turn-start block, and duplicating it would spend fleet budget on ' +
      'non-fleet information. ⚠ That principle has a KNOWN LIMIT, and `neverDropFacts` is the exception ' +
      'that establishes it: a leader on a COLD wake rebuilds from briefs rather than from a turn-start ' +
      'block it never sees (EI-18725816532600240), so a safety class whose absence is unrecoverable is ' +
      'worth carrying here anyway. Every `not-applicable` below is judged against that standard, not ' +
      'against "the leader can get it elsewhere" alone.',
    probes: {
      neverDropFacts: leaderBriefNeverDropProbe,
      // P-027: announced gates now reach this sink FROM THE DECLARATION. Before
      // P-027 this cell sat in `omitted` as kind 'second-derivation' with
      // collapsedBy: 'P-027' — the entry below is what that promise being kept
      // looks like, and moving it here is forced by the matrix rather than
      // optional (a claimed cell with no probe fails `classifies EVERY declared
      // class`). That coupling is the instrument working.
      announcedGates: leaderBriefAnnouncedGatesProbe,
    },
    silent: {},
    omitted: {
      held: {
        kind: 'not-applicable',
        reason:
          'DIFFERENT SUBJECT, not a missing copy. This class is the READER\'s own held work-items; the ' +
          'leader brief renders its MEMBERS\' holdings (LeaderBriefMember.workItemIds / checkpointProgress). ' +
          'A leader\'s own held items reach them through their own turn-start block. P-028 owns the question ' +
          'of whether ONE assembler can serve both subjects — note leader-brief.ts already documents using ' +
          '"the same canonical held-item checkpoint reader as carry" — but that is an assembler question, ' +
          'not an `applicableSinks` change, and this entry deliberately does not pre-decide it.',
      },
      heldReadFailed: {
        kind: 'not-applicable',
        reason:
          'The failure variant of `held`, so the same DIFFERENT-SUBJECT reasoning applies: it reports that the ' +
          'READER\'s own held-item read failed. A leader learns that through their own turn-start block.',
      },
      obligations: {
        kind: 'other-shared-mechanism',
        mechanism: "projectAgentObligationBrief({ sink: 'fleet:leader-brief' })",
        reason:
          'Reaches this sink from the SAME canonical evaluation turn-start uses — leader-brief.ts states it ' +
          'verbatim: "the SAME evaluation path used by automatic turn-start orientation, projected to the ' +
          'leader sink\'s wider budget". So this is one derivation with two sinks already; it simply routes ' +
          'through the obligation system\'s OWN sink parameter rather than through `applicableSinks`. Not ' +
          'drift-prone, so no collapse is owed. ⚠ Worth knowing that two parallel sink vocabularies exist.',
      },
      ownerDirectives: {
        kind: 'other-shared-mechanism',
        mechanism: "projectAgentObligationBrief({ sink: 'fleet:leader-brief:owner-directives' })",
        reason:
          'Same single derivation as `obligations` above — projected from the same obligation agenda under ' +
          'its own sink key and a wider entry budget. Recorded separately because it is a distinct sink key ' +
          'with a distinct budget, so a future withdrawal of one does not silently imply the other.',
      },
      // ── The reader's-own-session classes ────────────────────────────────
      // Each measured absent from leader-brief.ts (0 occurrences) and omitted
      // under the sink scope above. Stated per class rather than as one bulk
      // exemption, so withdrawing any single one is a visible edit.
      unansweredDirected: {
        kind: 'not-applicable',
        reason:
          "The reader's own unanswered directed messages. The leader's equivalent FLEET-scoped signal is " +
          'already carried per member (`unanswered`), so importing this class would answer a question this ' +
          'sink is not asking.',
      },
      unansweredStale: {
        kind: 'not-applicable',
        reason: "The reader's own stale-sender backlog — a turn-start concern, with no fleet-scoped reading.",
      },
      inboxRecent: {
        kind: 'not-applicable',
        reason:
          "The reader's own recent inbox lines. A leader's cross-agent view is coord:feed / catch-up, not a " +
          'replay of their personal inbox inside a fleet brief.',
      },
      openAsks: {
        kind: 'not-applicable',
        reason: "The reader's own outstanding asks. Fleet-scoped blocking is carried by the member rows instead.",
      },
      modes: {
        kind: 'not-applicable',
        reason:
          "DIFFERENT SUBJECT, not a missing copy. This class populates from the READER's own mode registry " +
          '(`getModes(ownerId)`), so on a leader brief it would report the leader\'s own posture — which their ' +
          'own turn-start block already delivers. The fleet-scoped question a leader actually acts on is a ' +
          "MEMBER's posture, which is per-member data and belongs on the member rows, not on this class.",
      },
      authorityVerdict: {
        kind: 'not-applicable',
        reason:
          'DIFFERENT SUBJECT, for the same reason as `modes` directly above — and one hop stronger, because ' +
          "this class is DERIVED from that one. It resolves from the READER's own control-anchor state, so on " +
          "a leader brief it would report the LEADER's own execution-authorization/mission/ideation verdict, " +
          'which their own turn-start block already delivers. The fleet-scoped question a leader acts on is ' +
          "whether a MEMBER's authority differs from what the leader believes they granted — per-member data " +
          'that belongs on the member rows, not on this reader-scoped class.',
      },
      planDecisions: {
        kind: 'not-applicable',
        reason:
          'DIFFERENT SUBJECT, by the same reader-scoped argument as `authorityVerdict` directly above. This ' +
          'class resolves from the plans on which the READER holds claimed items, so on a leader brief it ' +
          "would report the LEADER's own claimed-plan decisions — which their own turn-start block already " +
          'delivers. The fleet-scoped question a leader acts on is whether a MEMBER has yet been SHOWN a ' +
          'governing ruling, which is per-member cursor data belonging on the member rows, not on this ' +
          'reader-scoped class.',
      },
      lockTransitions: {
        kind: 'not-applicable',
        reason:
          'DIFFERENT SUBJECT, by the same reader-scoped argument as `planDecisions` and `authorityVerdict` ' +
          "above. This class resolves from the READER's own lock position, so on a leader brief it would " +
          "report the LEADER's own grants and blocks — which their own turn-start block already delivers. " +
          'The fleet-scoped question a leader acts on is whether a MEMBER is stalled behind a lock, and that ' +
          'is per-member data belonging on the member rows (alongside `throttled` and the liveness verdicts), ' +
          'not on this reader-scoped class.',
      },
      coupledPeers: {
        kind: 'not-applicable',
        reason:
          'DIFFERENT SUBJECT, by the same reader-scoped argument as `lockTransitions` directly above. This ' +
          "class resolves from the READER's own `coord:couple` edges, so on a leader brief it would report " +
          "the LEADER's own coupled peers — which their own turn-start block already delivers. What each " +
          'MEMBER is currently doing is per-member data belonging on the member rows, not on this ' +
          'reader-scoped class, and a leader need not be coupled to a member to supervise it.',
      },
      loopArmed: {
        kind: 'not-applicable',
        reason:
          "The reader's own wake source. The fleet-scoped equivalent — a MEMBER with no wake source — is " +
          'already a member-row concern (`throttled`, liveness verdicts), which is the reading a leader acts on.',
      },
      loopFireWithheld: {
        kind: 'not-applicable',
        reason:
          'A variant of the reader\'s own loop state (see the `unrenderedReason` trap noted at the top of ' +
          'this section). Same reasoning as `loopArmed`.',
      },
      improvementTriage: {
        kind: 'not-applicable',
        reason:
          'Withdrawn from the per-turn block entirely (P-017 / D-003, signal decay). Registering it on a ' +
          'SECOND sink would re-introduce exactly the always-present row that decision removed.',
      },
      obligationsWithheldBy: {
        kind: 'not-applicable',
        reason:
          'A modifier of `obligations` (FIELDS_RENDERED_BY_CLASS), which this sink does not claim. It only ' +
          'distinguishes an experiment-arm-withheld agenda from an empty one on the su.mode-goal receipt; a ' +
          'leader has nothing to act on in that distinction.',
      },
      executableFrontier: {
        kind: 'not-applicable',
        reason:
          "The reader's own executable frontier on their current plan. A leader's placement view is the " +
          'fleet assignment/bottleneck tables, which are computed fleet-wide rather than for the reader.',
      },
      toolSurface: {
        kind: 'not-applicable',
        reason:
          "A diagnostic about the READER's own MCP tool surface being unregistered. It is self-scoped by " +
          'construction — a leader cannot act on it for anyone but themselves, and they receive it per turn.',
      },
      carryBlindWindow: {
        kind: 'not-applicable',
        reason:
          'Describes the gap between a carry document being built and the session dying — a SUCCESSOR\'s ' +
          'concern. P-029 registers the carry-brief sink and decides this class there, which is where it ' +
          'belongs; the leader brief is not read by a successor reconstructing a cut.',
      },
      historyUpdates: {
        kind: 'not-applicable',
        reason:
          "Post-claim comment activity on the READER's own held items. The fleet-scoped reading is per-member " +
          'claim health (`claimHealth`, `stalled`), which the brief already carries from its own measurement.',
      },
      effortUpdates: {
        kind: 'not-applicable',
        reason: "Post-claim revisions to the READER's own plan/goal. Same reasoning as `historyUpdates`.",
      },
      openChecks: {
        kind: 'not-applicable',
        reason:
          "P-010's unverified-claims / open-blocker rows, and they are self-scoped by construction: they come " +
          "from the READER's own loop carry-note and its own held work-items, so a leader cannot act on another " +
          "agent's carried claims from this payload. The fleet-scoped equivalent a leader DOES act on is already " +
          'carried per member (claimHealth, stalled, intentStale). Recorded by su-c03852cb while the authoring ' +
          'session was MCP-dark; su-6b1151ea should revisit if P-010 intended a leader-facing reading.',
      },
    },
  },

  'carry-brief': {
    status: 'consuming',
    scope:
      'The CARRY DOCUMENT, assembled at a compaction/respawn cut and read by the COLDEST reader in the ' +
      'system: a successor process that rebuilds from this document alone, with no memory of the turns ' +
      'that produced it. That single property decides every cell below, and it cuts BOTH ways.\n\n' +
      'It ARGUES FOR a class when the successor cannot re-derive it — the antidote must be present where ' +
      'the poison is strongest (EI-18725816532600240). It ARGUES AGAINST a class that is LIVE SESSION ' +
      'STATE, and that is the majority verdict here: this document is built at the cut and read minutes ' +
      'later by a session whose OWN turn-start block re-derives that state authoritatively at wake. ' +
      'Embedding a build-time snapshot would not merely be redundant, it would be a STALE ASSERTION ' +
      'competing with a live one — and a successor cannot tell which of two disagreeing sources it should ' +
      'believe. So "the successor gets it from its own turn-start" is a sufficient reason to omit here in ' +
      'a way it is NOT for the leader brief (a cold leader may never see a turn-start block).\n\n' +
      '⚠ A THIRD, sharper test applies to this sink alone: TEMPORAL REACHABILITY. The document is ' +
      'assembled AT the snapshot, so a class measuring anything about the cut itself, or about the window ' +
      'between the snapshot and the cut, has no value to read at build time (see `carryBlindWindow`).',
    probes: {
      // The one claimed class. P-029 registered this sink BY giving it a real
      // consumer — `readCarryNeverDropFacts` in carry-brief.ts — rather than by
      // adding a row here, per the registry's "declaration and consumption land
      // in the SAME change" rule.
      neverDropFacts: carryBriefNeverDropProbe,
    },
    silent: {},
    omitted: {
      // ── Reaches this sink already, from the SAME canonical derivation ──────
      held: {
        kind: 'other-shared-mechanism',
        mechanism: 'readHeldWorkItems (carry-brief.ts) — turn-start imports it for its own `held` dep',
        reason:
          'Already ONE assembler, and this module is its HOME: turn-start\'s `held` dep dynamically imports ' +
          '`readHeldWorkItems` from carry-brief.ts rather than assembling its own. So the class reaches this ' +
          'sink from the single canonical read, not a copy, and no collapse is owed. P-028 measured this ' +
          'directly and found the item text\'s "three independent assemblers" premise already false.',
      },
      heldReadFailed: {
        kind: 'not-applicable',
        reason:
          'LIVE SESSION STATE about one read at one moment: whether the turn-start held-item read failed. A ' +
          'build-time copy would be a stale assertion competing with the successor\'s own turn-start read, ' +
          'which re-derives it at wake. The carry document reports its own held-item read directly.',
      },
      ownerDirectives: {
        kind: 'other-shared-mechanism',
        mechanism: 'listOpenOwnerDirectives (owner-directives.ts), rendered via renderOwnerDirectivesBlock',
        reason:
          'Both sinks call the SAME reader: turn-start\'s `ownerDirectives` dep and carry-brief\'s ' +
          '`directivesPromise` each import `listOpenOwnerDirectives` from owner-directives.ts, differing only ' +
          'in row budget. Not drift-prone, so no collapse is owed. The carry read is workspace-scoped on ' +
          'purpose — a directive must survive the recording session\'s death, which is exactly this sink\'s case.',
      },
      openChecks: {
        kind: 'other-shared-mechanism',
        mechanism: 'splitCarryNoteChecks (carry-note.ts) — the same parser turn-start\'s openChecks dep uses',
        reason:
          'The carried-claims half reaches this document from the SAME canonical parser: turn-start\'s ' +
          '`openChecks` dep calls `carryNote.splitCarryNoteChecks`, and carry-brief populates `checks` from ' +
          'that identical function. ⚠ SCOPE NOTE, deliberately recorded rather than glossed: turn-start\'s ' +
          'class ALSO folds a second half (open `work_items:set_blocker` rows) that this document does not ' +
          'carry; those reach the successor through its own turn-start block and through each held item\'s ' +
          're-injected checkpoint. So this entry covers the carry-note half only, and says so.',
      },

      // ── Reaches this sink from the shared owner-scoped loop reader ─────────
      loopArmed: {
        kind: 'other-shared-mechanism',
        mechanism: 'getLoopStatus (harness/routines/loop.ts) — shared with carry-brief.ts',
        reason:
          'Turn-start reads one getLoopStatus(ownerId) promise per owner and derives both loopArmed and ' +
          'loopFireWithheld from that same snapshot. Carry-brief also uses getLoopStatus(ownerId), so these ' +
          'sinks now share the per-owner authority instead of comparing the roster-wide activeLoopOwners set ' +
          'with an owner row. This closes the derivation drift recorded by WI-10002403.',
      },

      // ── LIVE SESSION STATE: the successor's own turn-start re-derives it ───
      // Each measured absent from carry-brief.ts (0 occurrences; positive
      // control on the same instrument: neverDropFacts 16, facts 91, heldItems
      // 36, loop 89 — so these zeros are measurements, not a broken grep).
      toolSurface: {
        kind: 'not-applicable',
        reason:
          'Measures whether THIS session\'s MCP tool list loaded empty — a property of a live process, and the ' +
          'successor is a DIFFERENT process whose tool surface is its own. The predecessor\'s value is not ' +
          'merely stale here, it is about someone else. Its only remedy (restart the session) is also something ' +
          'the successor has already done by existing.',
      },
      unansweredDirected: {
        kind: 'not-applicable',
        reason:
          'A directed message awaiting an answer is live inbox state that the successor\'s own turn-start block ' +
          'derives authoritatively at wake — including messages that arrived AFTER this cut, which this document ' +
          'cannot know about. A build-time snapshot would compete with that live read while being strictly ' +
          'older. The document instead carries the narrower `postNoteInbox` delta, which is a different subject.',
      },
      unansweredStale: {
        kind: 'not-applicable',
        reason:
          'Same family and same reasoning as `unansweredDirected`: staleness is measured against NOW, so a value ' +
          'computed at the cut is wrong by construction by the time the successor reads it. Age-derived classes ' +
          'are the worst possible fit for a document whose defining property is that it is read later.',
      },
      openAsks: {
        kind: 'not-applicable',
        reason:
          'Open asks awaiting a human are live state re-derived by the successor\'s turn-start, and their status ' +
          'can change between the cut and the read. ⚠ Recorded with a caveat rather than silently: the OWNER-' +
          'FACING half of this (a question this session promised to answer) is genuinely carry-worthy, and it ' +
          'already reaches the document through the loop carry-note\'s own `left` / owner-facing-threads ' +
          'discipline — a prose carrier, not this class. If that proves insufficient, the fix is to claim this ' +
          'class here deliberately, not to widen the note.',
      },
      modes: {
        kind: 'other-shared-mechanism',
        mechanism: 'the carry document\'s control-anchor state block + its `## Session mode` section',
        reason:
          'The carry document ALREADY carries active modes verbatim — the control-anchor state block ' +
          '(`control generation N: {"modes":[…]}`) and the `## Session mode` section both render them, and a ' +
          'successor re-reads that state rather than inheriting a cursor. Registering this class here would ' +
          'add a THIRD copy of the same posture. ⚠ And the TRANSITION half is not merely redundant but ' +
          'temporally unavailable: the diff is against the committed cursor of the turn the line renders on, ' +
          'and a carry document is assembled for a session that has taken no turn — so there is no prior ' +
          'cursor to diff against. Same shape as `carryBlindWindow` under D-069. What a successor needs is ' +
          'the CURRENT posture, which it already gets.',
      },
      authorityVerdict: {
        kind: 'other-shared-mechanism',
        mechanism: "the carry document's `## Effective instruction precedence` block",
        reason:
          'MEASURED, not inferred: the carry document already renders this verdict VERBATIM as its own ' +
          '`⟦INSTRUCTION-PRECEDENCE⟧` payload, carrying all three decisions plus their suppressed ' +
          'alternatives and provenance — strictly richer than this one-line class. Registering it here would ' +
          'add a second, poorer copy. ⚠ And the TRANSITION half is temporally unavailable for exactly the ' +
          'reason `modes` records directly above: the line diffs against the committed cursor of the turn it ' +
          'renders on, and a carry document is assembled for a session that has taken no turn, so there is no ' +
          'prior cursor to diff against. Same shape as `carryBlindWindow` under D-069 and `modes` under D-071.',
      },
      planDecisions: {
        kind: 'other-shared-mechanism',
        mechanism: "the carry document's plan-authority block (`latest governing decisions`)",
        reason:
          'MEASURED, not inferred: carry-doc.ts already emits `- latest governing decisions (+N older):` and ' +
          'then each decision with its id, title and a `plans:get { slug, decisionId }` recovery call — ' +
          'strictly richer than this one-line class, so registering it here would add a second, poorer copy. ' +
          '⚠ And the TRANSITION half is temporally unavailable for exactly the reason `modes` and ' +
          '`authorityVerdict` record above: this class diffs FRESH-vs-SEEN against the committed cursor of ' +
          'the turn it renders on, and a carry document is assembled for a session that has taken no turn, so ' +
          'there is no prior cursor to diff against.',
      },
      lockTransitions: {
        kind: 'not-applicable',
        reason:
          'TEMPORALLY UNAVAILABLE, the same reason `modes` (D-071) and `carryBlindWindow` (D-069) record — ' +
          'and here it is the WHOLE class, not half of it. `planDecisions` directly above still has a ' +
          'full-list form the carry document can emit without a cursor; this class has none, because a lock ' +
          'TRANSITION is definitionally a diff: GRANTED requires the `b:` token to have been SEEN last turn ' +
          'and BLOCKED requires its token NOT to have been. A carry document is assembled for a session that ' +
          'has taken no turn, so both conjuncts are unevaluable and every row would be suppressed — the ' +
          'class would register as applicable and then render nothing, forever. The one thing a cursorless ' +
          'sink COULD emit is the full current lock table, which is exactly what P-015 forbids.',
      },
      coupledPeers: {
        kind: 'not-applicable',
        reason:
          'TEMPORALLY UNAVAILABLE, the same reason as `lockTransitions` directly above: the class is ' +
          'definitionally a diff — a peer renders only when its intent token is ABSENT from the committed ' +
          'cursor of the turn it renders on. A carry document is assembled for a session that has taken no ' +
          'turn, so that conjunct is unevaluable. The one thing a cursorless sink could emit is every coupled ' +
          "peer's STANDING intent, which is live state (`coord:presence`) rather than a change, and a " +
          'snapshot of it in a carry document is stale by the time the successor reads it.',
      },
      inboxRecent: {
        kind: 'not-applicable',
        reason:
          'DIFFERENT SUBJECT, not a missing copy. This class is the recent-inbox VIEW; the document carries ' +
          '`postNoteInbox`, a bounded delta of pending interrupts arriving strictly AFTER the carry note was ' +
          'written. That delta exists to tell a successor "your note may already be superseded", which the ' +
          'recent-inbox view does not answer. Both read `readInbox`, but for different questions and windows.',
      },
      loopFireWithheld: {
        kind: 'not-applicable',
        reason:
          'A per-fire condition of the engine loop, evaluated when a fire is withheld and re-derived at the ' +
          'successor\'s next wake. It describes the scheduler\'s decision about a fire that has already ' +
          'happened or been skipped, so carrying it past a cut informs no decision the successor can still make.',
      },
      obligations: {
        kind: 'not-applicable',
        reason:
          'The obligation agenda is a live evaluation with its own sink vocabulary ' +
          '(projectAgentObligationBrief), re-projected for the successor at its own turn-start and reachable ' +
          'on demand via coord:orient. Measured absent from carry-brief.ts (0 occurrences). Recorded as ' +
          'not-applicable rather than shared-mechanism precisely BECAUSE it does not reach this sink at all ' +
          'today — naming a mechanism that does not run here would be the guess this kind exists to forbid.',
      },
      executableFrontier: {
        kind: 'not-applicable',
        reason:
          'The claimable/next-executable queue is the most volatile state in the system — peers claim from it ' +
          'continuously — so a snapshot taken at the cut is very likely wrong when read, and wrong in the ' +
          'specific direction that causes harm: it would point a successor at work another agent already holds, ' +
          'producing a claim conflict the document itself caused.',
      },
      announcedGates: {
        kind: 'not-applicable',
        reason:
          'Gate announcements are live and LATCHING: a gate can fire between the cut and the read, so a carried ' +
          'list can name a gate that has already opened. The successor\'s own ARMED AWAITS — which genuinely ' +
          'survive the boundary and will wake it — are carried by this document separately and are the ' +
          'actionable half; the announcement view is re-derived at turn-start and via events:catalog.',
      },
      historyUpdates: {
        kind: 'not-applicable',
        reason:
          'A per-turn delta describing changes since the reader\'s last turn-start cursor. The successor has no ' +
          'such cursor continuity across a respawn — its first turn-start establishes a fresh one — so the ' +
          'class has no meaningful value to carry across the very boundary that resets its baseline.',
      },
      effortUpdates: {
        kind: 'not-applicable',
        reason:
          'Same cursor-delta property as `historyUpdates`: it reports movement since a watermark the successor ' +
          'does not inherit. Recorded as its own entry rather than folded into that one so withdrawing either ' +
          'decision stays a visible, separate edit.',
      },
      improvementTriage: {
        kind: 'not-applicable',
        reason:
          'Its turn-start LINE was withdrawn outright by P-017 (it sits in DELIBERATELY_UNRENDERED for the sink ' +
          'that does claim it), so there is no rendered signal for this document to carry. Claiming it here ' +
          'would re-introduce for the coldest reader a line the system already decided was not worth its budget ' +
          'for the warmest one.',
      },
      obligationsWithheldBy: {
        kind: 'not-applicable',
        reason:
          'A modifier of `obligations` (FIELDS_RENDERED_BY_CLASS), which this document does not claim. It is ' +
          'recomputed from the goal binding on every turn, so a successor reads it fresh rather than inheriting it.',
      },

      // ── TEMPORALLY UNREACHABLE at this sink ───────────────────────────────
      carryBlindWindow: {
        kind: 'not-applicable',
        reason:
          'TEMPORALLY IMPOSSIBLE here, which INVERTS P-029\'s own item text (it names this class an "obvious ' +
          'candidate" for this sink). The class counts tool calls between the carry SNAPSHOT and the CUT; this ' +
          'document is ASSEMBLED at the snapshot, with the cut still in the future, so at build time the count ' +
          'is necessarily 0 and its endpoint does not exist yet. A consumer wired here would return null on ' +
          'every single call — and a null-returning dependency reads as broken plumbing to whoever audits it ' +
          'next, so the omission would look like a bug to fix rather than a category error. Recorded ' +
          'not-applicable (finished, nothing owed) and NOT second-derivation: labelling it debt would promise a ' +
          'collapse that can never happen. Full measurement in plan decision D-069. ⚠ Do not "collapse" this ' +
          'with carry-brief.ts\'s "CARRY-NOTE SUPERSEDED" warning — that measures a DIFFERENT subject (loop ' +
          'carry-NOTE write time vs later session activity, EI-22436560948423011), and merging them would ' +
          'destroy one of two real signals. The blind window is instead stated to the successor as PROSE in ' +
          'the document\'s own header, which is the truthful carrier for something that cannot be measured yet.',
      },
    },
  },
};

interface MatrixCell {
  sink: string;
  className: string;
  claimed: boolean;
  expectation: 'reaches' | 'silent';
  probe: CellProbe | null;
}

/**
 * OrientationState fields that are NOT classes of their own: each is a variant read by
 * another registered class's segments, so it reaches exactly the sinks that class claims.
 * Keyed field → owning class id. Kept honest by the "folded fields" guard below: the field
 * must be declared, must not be a registry id itself, and its owner must be one.
 */
const FIELDS_RENDERED_BY_CLASS: Record<string, string> = {
  // The `held` class's order-150 segment renders "held work-items: unavailable" from it, and
  // the `held` watermark token encodes it ('!unavailable'), so it travels with `held`.
  heldReadFailed: 'held',
  // R-4 / D-032: set only beside `obligations: null` when a goal experiment arm withholds the
  // agenda; the su.mode-goal receipt reads it to stamp the omission reason. It travels with
  // `obligations` and is recorded silent (DELIBERATELY_UNRENDERED) on every sink that claims it.
  obligationsWithheldBy: 'obligations',
};

/**
 * The classes a sink CLAIMS, read from the live registry (never hand-listed), plus any
 * field folded into a claimed class via FIELDS_RENDERED_BY_CLASS.
 */
function classesClaimedBy(
  sink: string,
  registry: readonly RegisteredOrientationClass[] = ORIENTATION_CLASS_REGISTRY,
): string[] {
  const claimed = registry
    .filter((entry) => entry.applicableSinks.includes(sink as never))
    .map((entry) => String(entry.id));
  const folded = Object.entries(FIELDS_RENDERED_BY_CLASS)
    .filter(([, owner]) => claimed.includes(owner))
    .map(([field]) => field);
  return [...claimed, ...folded];
}

/**
 * Every (class × sink) cell for the CONSUMING sinks, with what the guard expects
 * of it. A `pending` sink contributes no cells — its whole column is asserted
 * empty instead.
 */
function buildMatrixCells(declared: string[], sinks: string[]): MatrixCell[] {
  const cells: MatrixCell[] = [];
  for (const sink of sinks) {
    const coverage = SINK_COVERAGE[sink];
    if (!coverage || coverage.status !== 'consuming') continue;
    const claimedSet = new Set(classesClaimedBy(sink));
    for (const className of declared) {
      const claimed = claimedSet.has(className);
      if (!claimed) continue;
      const silent = coverage.silent[className] !== undefined;
      cells.push({
        sink,
        className,
        claimed,
        expectation: silent ? 'silent' : 'reaches',
        probe: coverage.probes[className] ?? (silent ? turnStartProbe(className) : null),
      });
    }
  }
  return cells;
}

/**
 * THROWS when a cell does not behave as the matrix records it.
 *
 * Takes the probe result as a PARAMETER rather than running it, so the
 * falsifiability controls below can drive every branch without needing a
 * renderer that is actually broken.
 */
function assertCellMatchesExpectation(cell: MatrixCell, observed: CellReach, note = ''): void {
  if (cell.expectation === 'reaches' && !observed.reached) {
    throw new Error(
      `orientation class '${cell.className}' claims sink '${cell.sink}' but did not reach it: ${observed.detail}` +
        note,
    );
  }
  if (cell.expectation === 'silent' && observed.reached) {
    throw new Error(
      `orientation class '${cell.className}' is recorded as deliberately silent at sink '${cell.sink}', ` +
        `but populating it emitted: ${observed.detail}` +
        note,
    );
  }
}

describe('P-024 — orientation class × sink coverage matrix', () => {
  const declared = declaredOrientationClasses();
  const sinks = declaredOrientationSinks();
  const cells = buildMatrixCells(declared, sinks);

  it('reads a non-trivial declared sink set from OrientationSink (instrument calibration)', () => {
    // Without this, a parser that silently returned a short list would make the
    // whole matrix iterate almost nothing while reporting full coverage.
    expect(sinks.length).toBeGreaterThanOrEqual(3);
    expect(sinks).toContain('turn-start');
    expect(sinks).toContain('leader-brief');
    expect(sinks).toContain('carry-brief');
  });

  it('has a coverage entry for every declared sink, and none for an undeclared one', () => {
    const missing = sinks.filter((sink) => !SINK_COVERAGE[sink]);
    expect(
      missing,
      'a new OrientationSink must get an entry in SINK_COVERAGE, or nothing asserts what it carries',
    ).toEqual([]);
    const declaredSet = new Set(sinks);
    const orphaned = Object.keys(SINK_COVERAGE).filter((sink) => !declaredSet.has(sink));
    expect(orphaned, 'a coverage entry outlived its sink — delete it rather than describing a sink nothing renders').toEqual(
      [],
    );
  });

  it('classifies EVERY declared class for every consuming sink', () => {
    // The matrix generalisation of "a probe or an explicit exclusion for every
    // declared class": each cell is exactly one of claimed-and-probed,
    // claimed-and-silent, or omitted-with-a-reason.
    const unclassified: string[] = [];
    for (const sink of sinks) {
      const coverage = SINK_COVERAGE[sink];
      if (!coverage || coverage.status !== 'consuming') continue;
      const claimedSet = new Set(classesClaimedBy(sink));
      for (const className of declared) {
        const claimed = claimedSet.has(className);
        const hasProbe = coverage.probes[className] !== undefined;
        const isSilent = coverage.silent[className] !== undefined;
        const isOmitted = coverage.omitted[className] !== undefined;
        if (claimed && !hasProbe && !isSilent) unclassified.push(`${sink}/${className}: claimed but no probe`);
        if (!claimed && !isOmitted) unclassified.push(`${sink}/${className}: not claimed and not recorded`);
      }
    }
    expect(
      unclassified,
      'every (class × sink) cell must be claimed-and-probed, claimed-and-silent, or omitted with a recorded reason',
    ).toEqual([]);
  });

  it('never records a cell as both claimed and omitted', () => {
    // The contradiction that would let a class look decided in both directions.
    const contradictions: string[] = [];
    for (const sink of sinks) {
      const coverage = SINK_COVERAGE[sink];
      if (!coverage || coverage.status !== 'consuming') continue;
      const claimedSet = new Set(classesClaimedBy(sink));
      for (const className of Object.keys(coverage.omitted)) {
        if (claimedSet.has(className)) contradictions.push(`${sink}/${className}`);
      }
      for (const className of Object.keys(coverage.probes)) {
        if (!claimedSet.has(className)) contradictions.push(`${sink}/${className}: probe without a claim`);
      }
    }
    expect(contradictions, 'a cell recorded as omitted while the registry claims it (or vice versa)').toEqual([]);
  });

  it('requires a second-derivation omission to name the item that collapses it', () => {
    // The whole point of the `second-derivation` kind: it is DEBT, and debt with
    // no owner is indistinguishable from a finished decision.
    const unowned: string[] = [];
    for (const [sink, coverage] of Object.entries(SINK_COVERAGE)) {
      if (coverage.status !== 'consuming') continue;
      for (const [className, omission] of Object.entries(coverage.omitted)) {
        if (omission.kind === 'second-derivation' && !omission.collapsedBy) {
          unowned.push(`${sink}/${className}`);
        }
        if (omission.kind === 'other-shared-mechanism' && !omission.mechanism) {
          unowned.push(`${sink}/${className}: no mechanism named`);
        }
        if (!omission.reason || omission.reason.length < 40) {
          unowned.push(`${sink}/${className}: reason too thin to be a decision`);
        }
      }
    }
    expect(unowned, 'a second-derivation omission must name collapsedBy; a shared-mechanism one must name it').toEqual(
      [],
    );
  });

  it('keeps every folded field honest (declared, not a class itself, owned by a registered class)', () => {
    // FIELDS_RENDERED_BY_CLASS widens what a sink claims, so a rotten entry would silently
    // mark a cell as covered. Each entry must still describe the live registry.
    const registryIds = new Set(ORIENTATION_CLASS_REGISTRY.map((entry) => String(entry.id)));
    const declaredSet = new Set(declared);
    const rotten = Object.entries(FIELDS_RENDERED_BY_CLASS).flatMap(([field, owner]) => [
      ...(declaredSet.has(field) ? [] : [`${field}: not declared by OrientationState`]),
      ...(registryIds.has(field) ? [`${field}: is itself a registered class — delete the fold`] : []),
      ...(registryIds.has(owner) ? [] : [`${field}: owner '${owner}' is not a registered class`]),
    ]);
    expect(rotten).toEqual([]);
    // Calibration: the fold must actually reach through the claim helper.
    expect(classesClaimedBy('turn-start')).toContain('heldReadFailed');
  });

  it('keeps a PENDING sink claimed by exactly zero classes', () => {
    // A pending sink is recorded once instead of per class. That is only honest
    // while it consumes nothing: the moment a class claims it, the column must
    // be filled in properly rather than riding on the pending note.
    for (const [sink, coverage] of Object.entries(SINK_COVERAGE)) {
      if (coverage.status !== 'pending') continue;
      expect(
        classesClaimedBy(sink),
        `sink '${sink}' is recorded as PENDING (${coverage.registeredBy}) but classes already claim it — ` +
          'flip it to `consuming` and record a decision for every declared class',
      ).toEqual([]);
      expect(coverage.registeredBy, `pending sink '${sink}' must name the item that registers it`).toMatch(/^P-\d+$/);
    }
  });

  it('builds a non-vacuous matrix (instrument calibration)', () => {
    // Guards the whole section against the failure mode it exists to prevent:
    // a matrix that iterates nothing passes every assertion above.
    expect(cells.length).toBeGreaterThanOrEqual(declared.length);
    expect(cells.some((cell) => cell.sink === 'leader-brief')).toBe(true);
    expect(cells.some((cell) => cell.expectation === 'silent')).toBe(true);
    // Every cell must be runnable, or the `it.each` below would silently skip.
    expect(cells.filter((cell) => !cell.probe).map((cell) => `${cell.sink}/${cell.className}`)).toEqual([]);
  });

  it.each(cells.map((cell) => [`${cell.sink} / ${cell.className} (${cell.expectation})`, cell] as const))(
    'cell %s behaves as recorded',
    async (_label, cell) => {
      const observed = await cell.probe!();
      expect(() => assertCellMatchesExpectation(cell, observed)).not.toThrow();
    },
  );

  // ── Falsifiability controls on the SINK axis (P-024) ────────────────────
  //
  // The single-sink section has one permanent control (a class declared but
  // never rendered must throw). The matrix adds an axis, so it needs controls
  // that fail for SINK-shaped reasons — otherwise the green above means only
  // that turn-start still works.

  it('fails when a class CLAIMS a sink it does not reach (permanent falsifiability control)', () => {
    const cell: MatrixCell = {
      sink: 'leader-brief',
      className: 'neverDropFacts',
      claimed: true,
      expectation: 'reaches',
      probe: null,
    };
    expect(() =>
      assertCellMatchesExpectation(cell, { reached: false, detail: 'undefined' }),
    ).toThrow(/claims sink 'leader-brief' but did not reach it/);
  });

  it('fails when a class recorded SILENT at a sink emits there (permanent falsifiability control)', () => {
    const cell: MatrixCell = {
      sink: 'turn-start',
      className: 'improvementTriage',
      claimed: true,
      expectation: 'silent',
      probe: null,
    };
    expect(() =>
      assertCellMatchesExpectation(cell, { reached: true, detail: '["- improvement triage: 100 pending"]' }),
    ).toThrow(/recorded as deliberately silent/);
  });

  it('the leader-brief probe really can return false (control: it reads the declaration)', async () => {
    // The strongest control available here: drive the REAL consumer with the
    // leader-brief sink withdrawn from the registry row. If the consumer ever
    // stops reading `applicableSinks` and hardcodes the class, this goes red —
    // which is the only reason the live cell's green means anything.
    const withdrawn = ORIENTATION_CLASS_REGISTRY.map((entry) =>
      entry.id === 'neverDropFacts'
        ? { ...entry, applicableSinks: entry.applicableSinks.filter((sink) => sink !== 'leader-brief') }
        : entry,
    );
    const out = await readLeaderNeverDropFacts(
      { ownerId: 'su-coverage-probe', workspaceId: 'papercusp-workspace' },
      { fold: async () => [neverDropFactProbe('dead-end:coverage-probe')], registry: withdrawn },
    );
    expect(out, 'withdrawing the sink must turn the field off, with no second edit in the consumer').toBeUndefined();
  });

  it('the carry-brief probe really can return false (control: it reads the declaration)', async () => {
    // P-029's counterpart to the leader-brief control above, and the reason the
    // live carry-brief cell's green means anything: drive the REAL consumer with
    // the carry-brief sink withdrawn from the registry row. A consumer that
    // hardcoded the class instead of reading `applicableSinks` turns this red.
    const withdrawn = ORIENTATION_CLASS_REGISTRY.map((entry) =>
      entry.id === 'neverDropFacts'
        ? { ...entry, applicableSinks: entry.applicableSinks.filter((sink) => sink !== 'carry-brief') }
        : entry,
    );
    const out = await readCarryNeverDropFacts(
      { ownerId: 'su-coverage-probe', workspaceId: 'papercusp-workspace' },
      { fold: (async () => [neverDropFactProbe('dead-end:coverage-probe')]) as never, registry: withdrawn },
    );
    expect(out, 'withdrawing the sink must turn the section off, with no second edit in carry-brief').toBeUndefined();
  });

  it('carry-brief folds never-drop facts at WORKSPACE scope, not owner-only (control: the P-029 gap)', async () => {
    // THE SUBSTANTIVE REGRESSION GUARD. The carry document already folded
    // OWNER-scoped facts before P-029; what it lacked was the WORKSPACE leg, so
    // a consumer that quietly dropped back to owner-only would still return
    // facts and still look like it worked — the live cell would stay green while
    // the exact gap P-029 closed had reopened. Assert the selector set itself.
    const seen: { scope: string; scopeRef?: string | null }[] = [];
    await readCarryNeverDropFacts(
      { ownerId: 'su-coverage-probe', workspaceId: 'papercusp-workspace' },
      {
        fold: (async (selectors: readonly { scope: string; scopeRef?: string | null }[]) => {
          seen.push(...selectors);
          return [neverDropFactProbe('dead-end:coverage-probe')];
        }) as never,
      },
    );
    expect(
      seen.map((selector) => selector.scope).sort(),
      'a workspace-scoped guard rail must reach the coldest reader in the system (EI-18725816532600240)',
    ).toEqual(['owner', 'workspace']);
  });

  it('detects a PENDING sink that silently gained a claim (permanent falsifiability control)', () => {
    // ⚠ REBUILT ON A SYNTHETIC SINK NAME (P-029), and the reason is the point.
    //
    // This control previously asserted that the REAL 'carry-brief' sink claimed
    // ZERO classes. That made it die the moment carry-brief was legitimately
    // registered — i.e. exactly when the mechanism it guards did its job. A
    // control that a CORRECT change turns red is a control that the next author
    // deletes or weakens rather than repairs, so its lifetime was capped at the
    // first success of the thing it protects. It is now anchored to a sink name
    // no registry row will ever claim, so it survives every future sink
    // graduating from `pending` to `consuming`.
    const SYNTHETIC_PENDING_SINK = 'probe-only-never-registered-sink';

    // Half 1 — reads EMPTY for a sink nothing claims. True by construction
    // rather than by the current state of the tree, so it cannot rot; it is
    // what makes half 2 a measured DIFFERENCE instead of an always-true.
    expect(classesClaimedBy(SYNTHETIC_PENDING_SINK)).toEqual([]);

    // Half 2 — and DETECTS the claim the instant a registry row adds that sink.
    const halfRegistered = ORIENTATION_CLASS_REGISTRY.map((entry) =>
      entry.id === 'neverDropFacts'
        ? { ...entry, applicableSinks: [...entry.applicableSinks, SYNTHETIC_PENDING_SINK as never] }
        : entry,
    );
    expect(classesClaimedBy(SYNTHETIC_PENDING_SINK, halfRegistered)).toEqual(['neverDropFacts']);

    // Half 3 — THE VACUITY GUARD, new with P-029. `keeps a PENDING sink claimed
    // by exactly zero classes` iterates SINK_COVERAGE and skips every non-pending
    // entry; with all three sinks now registered it iterates NOTHING and passes
    // vacuously. A vacuous invariant is indistinguishable from a working one, so
    // this asserts the underlying detector still discriminates: the zero-claim
    // expectation MUST fail against a sink that has gained a claim. If that ever
    // stops throwing, the pending-sink invariant has become permanently unable
    // to fail and the next `pending` sink would be registered in silence.
    expect(() => expect(classesClaimedBy(SYNTHETIC_PENDING_SINK, halfRegistered)).toEqual([])).toThrow();
  });

  it('carries the parsed-source note into a matrix failure', () => {
    const note = parsedSourceNote({ status: 'uncommitted', paths: ['lib/turn-start-orientation.ts'] });
    const cell: MatrixCell = {
      sink: 'leader-brief',
      className: 'neverDropFacts',
      claimed: true,
      expectation: 'reaches',
      probe: null,
    };
    expect(() => assertCellMatchesExpectation(cell, { reached: false, detail: 'undefined' }, note)).toThrow(
      /parsed from UNCOMMITTED source: lib\/turn-start-orientation\.ts/,
    );
  });
});
