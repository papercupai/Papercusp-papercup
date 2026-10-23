import { describe, it, expect, beforeEach } from 'vitest';
import { lookupByMcpName } from '@papercusp/agent-mcp';
// The tool catalog populates by SIDE-EFFECT IMPORT, and the wiring module is the only honest
// way to fill it: importing just the doors the cells name today would make the WI-6528 walk
// below fail with a false positive the moment a cell adopts a door this file forgot to import.
// Same reason agent-tools/dev/pipeline_position.test.ts gives — "a test importing only the tool
// would see an" incomplete catalog — and the same idiom as trimmed-contract.test.ts.
import './agent-tools/index';
import {
  validateCellSpec,
  getCell,
  listCellsUnchecked,
  __resetCellRegistryForTests,
  type CellSpec,
} from './cell-registry';
import {
  GIT_PIPELINE_POSITION_CELL,
  GATE_VERDICT_CELL,
  GATE_CANDIDATE_CELL,
  GATE_CANDIDATE_FAILURES_CELL,
  GATE_OWNER_BRIEF_CELL,
  GATE_QUALIFICATION_CELL,
  GATE_RETRIAGE_CELL,
  GATE_OWNERSHIP_CELL,
  DEPLOYED_SHA_CELL,
  MAIN_BEHIND_STAGING_CELL,
  AGENT_GOAL_CELL,
  HOST_MEMORY_PRESSURE_CELL,
  MEMORY_CGROUP_ATTRIBUTION_CELL,
  GOAL_PORTFOLIO_THROUGHPUT_CELL,
  LSP_ADMISSION_CELL,
  BUILTIN_CELLS,
  registerBuiltinCells,
} from './cell-registrations';

const OPERATOR_PIPELINE_CELLS = [
  GIT_PIPELINE_POSITION_CELL,
  GATE_VERDICT_CELL,
  GATE_CANDIDATE_CELL,
  GATE_CANDIDATE_FAILURES_CELL,
  GATE_OWNER_BRIEF_CELL,
  GATE_QUALIFICATION_CELL,
  GATE_RETRIAGE_CELL,
  DEPLOYED_SHA_CELL,
  MAIN_BEHIND_STAGING_CELL,
];

describe('LSP admission registration under the D-038 contract', () => {
  beforeEach(() => __resetCellRegistryForTests());

  it('registers the real built-ins while preserving unknown daemon measurements', () => {
    expect(validateCellSpec(LSP_ADMISSION_CELL)).toEqual([]);
    expect(() => registerBuiltinCells()).not.toThrow();
    expect(getCell('lsp.admission', { ownerId: 'su-anyone', harnessSlug: 'papercusp' })?.unknownHoist).toBe(
      'unknown',
    );
  });

  it('rejects a nullable admission snapshot without its unknown hoist', () => {
    const invalid = { ...LSP_ADMISSION_CELL, unknownHoist: undefined };
    expect(validateCellSpec(invalid).map((rejection) => rejection.rule)).toContain('unknown-not-hoisted');
  });

  it('rejects pairing the unknown hoist as a measured subject', () => {
    const invalid = {
      ...LSP_ADMISSION_CELL,
      assessment: { ...LSP_ADMISSION_CELL.assessment!, measuredBy: { unknown: 'measurement' } },
    };
    expect(validateCellSpec(invalid).map((rejection) => rejection.rule)).toContain('measured-by-hoist-paired');
  });
});

/**
 * P-006. The value of this suite is not "a cell is registered" — it is that the
 * FLAGSHIP cell, the one the contract was partly derived from, passes the contract's
 * own gate honestly rather than by declaring its way around it.
 */
describe('P-006: git.pipelinePosition registers under the D-038 contract', () => {
  beforeEach(() => __resetCellRegistryForTests());

  it('validates with zero rejections', () => {
    expect(validateCellSpec(GIT_PIPELINE_POSITION_CELL)).toEqual([]);
  });

  it('registers and is retrievable', () => {
    registerBuiltinCells();
    // P-019: the cell describes the operator HOME Pot's checkout, not every
    // independently-managed harness that happens to share this workspace.
    expect(getCell('git.pipelinePosition', { ownerId: 'su-anyone', harnessSlug: 'papercusp' })?.resolver).toContain(
      'gitPipelinePosition()',
    );
  });

  it('is idempotent — registering the built-ins twice does not throw', () => {
    registerBuiltinCells();
    expect(() => registerBuiltinCells()).not.toThrow();
  });

  /**
   * THE REGRESSION THAT MATTERS. `nullable: true` is only honest because the resolver
   * now HOISTS its unreadable legs. If someone later removes `positionsUnknown` from
   * the result and drops the declaration with it, this cell silently reverts to
   * claiming a two-valued headline that is in fact three-valued — which is precisely
   * the state P-006 found it in.
   */
  it('declares the unknown hoist, and is REJECTED without it', () => {
    expect(GIT_PIPELINE_POSITION_CELL.nullable).toBe(true);
    expect(GIT_PIPELINE_POSITION_CELL.unknownHoist).toBe('positionsUnknown');

    const withoutHoist = { ...GIT_PIPELINE_POSITION_CELL, unknownHoist: undefined };
    const rejections = validateCellSpec(withoutHoist);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ axis: 2, rule: 'unknown-not-hoisted' });
  });

  /**
   * The independence INTENT, surviving P-006's deletion of the axis that used to
   * police it. The specific mistake it is locked against is unchanged: substantiating
   * the headline with `stages[].health`, which for the serving stage is COMPUTED FROM
   * the headline and therefore adds no new information.
   *
   * ⚠ This is now a claim about the SHIPPED REGISTRATION, not about a validator. P-006
   * deleted axis 1 along with the falsifier, so `validateCellSpec` no longer refuses a
   * self-substantiating cell — asserting that it does would pin a rule that is gone.
   * What still holds, and is worth pinning, is that this cell's declared evidence names
   * measurements the headline does not already contain.
   */
  it('substantiates its assessment from measurements independent of the headline', () => {
    const a = GIT_PIPELINE_POSITION_CELL.assessment;
    expect(a).not.toBeNull();
    expect(a!.evidence.length).toBeGreaterThan(0);
    for (const path of a!.evidence) expect(path).not.toBe(GIT_PIPELINE_POSITION_CELL.headline);
    // The assessment path is a third field, distinct from the headline it interprets.
    expect(a!.path).not.toBe(GIT_PIPELINE_POSITION_CELL.headline);
  });

  /** Axis 3: `parameter`, said out loud. Inference would have concluded `global`. */
  it('declares caller-relativity explicitly rather than leaving it inferred', () => {
    expect(GIT_PIPELINE_POSITION_CELL.callerRelativity).toEqual({ kind: 'parameter', param: 'path' });
  });
});

/**
 * P-007. Four sibling cells over the SAME resolver (#D-065). What is worth testing is
 * not that five specs validate — the constructor would have thrown at import time — but
 * the handful of properties that would silently regress into a confidently-wrong cell.
 */
describe('P-007: the four verdict cells', () => {
  beforeEach(() => __resetCellRegistryForTests());

  // gate-audit-hardening-2026-08-31 P-001: `ownerBrief` joins the family — it is a pure
  // lens over the same gitPipelinePosition() derivation. `candidateFailures` does NOT:
  // like `ownership` (see the census comment below), it owns real I/O and names its own
  // resolver, so the one-resolver family assertion would be false of it by design.
  const NEW_CELLS = [
    GATE_VERDICT_CELL,
    GATE_CANDIDATE_CELL,
    DEPLOYED_SHA_CELL,
    MAIN_BEHIND_STAGING_CELL,
    GATE_OWNER_BRIEF_CELL,
  ];

  it.each(OPERATOR_PIPELINE_CELLS.map((c) => [c.cell, c] as const))(
    '%s is visible only inside the operator home harness',
    (id, spec) => {
      expect(spec.visibility).toEqual({ kind: 'harness', ref: 'papercusp' });
      registerBuiltinCells();
      expect(getCell(id, { ownerId: 'su-inside', harnessSlug: 'papercusp' })).toBeDefined();
      expect(getCell(id, { ownerId: 'su-outside', harnessSlug: 'sidestage' })).toBeUndefined();
    },
  );

  it('allows a target-harness fixer to discover its scoped ownership cell', () => {
    registerBuiltinCells();
    expect(getCell(GATE_OWNERSHIP_CELL.cell, {
      ownerId: 'su-target-fixer', roles: ['operator'], harnessSlug: 'slack-asana-bug-drill',
    })?.changeSignal).toEqual(GATE_OWNERSHIP_CELL.changeSignal);
  });

  it.each(NEW_CELLS.map((c) => [c.cell, c] as const))('%s validates with zero rejections', (_id, spec) => {
    expect(validateCellSpec(spec)).toEqual([]);
  });

  it('registers every built-in, and does so idempotently', () => {
    registerBuiltinCells();
    expect(() => registerBuiltinCells()).not.toThrow();
    expect(listCellsUnchecked().map((c) => c.cell)).toEqual([
      // P-016. The first cell here that is about an AGENT rather than the tree.
      'agent.goal',
      // role-model-one-answer-2026-09-03 P-004: "what will each role launch as?",
      // headlined by the roles whose configured backend the model overrules.
      'agent.roleLaunch',
      // capacity-signal-clarity-and-fleet-capacity-repair-2026-09-01 P-004: the ONE canonical
      // "are we at capacity", whose `binding` names WHICH TERM holds the lane back.
      'capacity.verdict',
      'deploy.3070.sha',
      'gate.greenCheckpoint.candidate',
      // WI-1702869. Own resolver (readGateCandidateFailures) — excluded from
      // NEW_CELLS for the same reason as ownership below.
      'gate.greenCheckpoint.candidateFailures',
      // main-green-status-visible-2026-09-03 P-004, the two legs of "is the freeze WORKING":
      // `convergence` answers whether the failing set is shrinking (audit Q#17/#18), and
      // `freezeDisposition` whether the mechanism is acting at all and why (Q#19). They are
      // separate cells because they dissociate — `converging` + `no-attempts` was the live
      // reading on 2026-09-03, and that pair reads healthy while nothing has run.
      'gate.greenCheckpoint.convergence',
      'gate.greenCheckpoint.freezeDisposition',
      // gate-audit-hardening-2026-08-31 P-001: the composed owner brief — a pure
      // lens over gitPipelinePosition(), so it IS in NEW_CELLS.
      'gate.greenCheckpoint.ownerBrief',
      // D-014. Its own cell, and deliberately NOT part of the pipeline family
      // below: it resolves via readGateOwnership(), not gitPipelinePosition(),
      // because it derives WHO owns the red from lease + presence state rather
      // than from the tree. Registered here; excluded from NEW_CELLS on purpose.
      'gate.greenCheckpoint.ownership',
      'gate.greenCheckpoint.qualification',
      // main-green-status-visible-2026-09-03 P-009 (audit Q#21): "is an auto-refire in
      // flight — must I stand down?". A pure lens over gitPipelinePosition()'s already-mapped
      // checkpointRunInFlight leg, so it IS in the pipeline family below.
      'gate.greenCheckpoint.retriage',
      'gate.greenCheckpoint.verdict',
      'git.mainBehindStaging',
      'git.pipelinePosition',
      'goal.portfolioThroughput',
      'governor.admission',
      'governor.health',
      'governor.queue',
      'governor.recovery',
      'governor.resources',
      'host.memoryPressure',
      'lsp.admission',
      'lsp.readiness',
      'lsp.warmServers',
      'memory.cgroupAttribution',
      // directive-visibility-and-ownership-2026-09-22 P-007: "what is owed on directive N,
      // and by whom". Nullable on purpose — an id that does not exist in this workspace has
      // no status at all, which is why it is the one cell here carrying an `unknownHoist`.
      'owner.directive.status',
      // deterministic-coverage-census-2026-08-17 P-005. A PAIR, split along the line
      // between a count and a ratio: the population is never unknown (it is a row
      // count, so 0 is a measurement), while the ratio has no answer at all when that
      // population is 0. One cell could not state both truths.
      'testing.census.population',
      'testing.coverage.floor',
      // verification-system-improvements-2026-10-10 P-002: the requirement-contract health
      // read (contract coverage by cohort, evidence-bound share, triage gaps, stale
      // acceptance, VAL-* residue), resolved through plans:verification-health.
      'verification.health',
      // bug-inflow-one-problem-one-row-2026-10-18 P-007: issue-family rows filed per day by
      // source vs closed per day, read from the stored bug_inflow_daily rollup.
      'work.bugInflow',
      // workspace-work-scope-policy-2026-09-04 / WI-2145092: "is this workspace confined to
      // an allow-list of harnesses?" — the D-003 residue, resolved through the read-only
      // lens workspace:work_scope_status (the control tool is write-capable, which the cell
      // dispatcher refuses).
      'workspace.workScope',
    ]);
  });

  it('registers the routine-owned qualification cell with the durable typed projection', () => {
    expect(validateCellSpec(GATE_QUALIFICATION_CELL)).toEqual([]);
    expect(GATE_QUALIFICATION_CELL.headline).toBe('gate.qualification.attemptId');
    expect(GATE_QUALIFICATION_CELL.changeSignal).toEqual({
      kind: 'poll',
      tool: 'dev:pipeline_position',
      path: 'gate.qualification.attemptId',
    });
    expect(GATE_QUALIFICATION_CELL.assessment?.path).toBe('gate.qualification.safeNextAction.code');
    expect(Object.keys(GATE_QUALIFICATION_CELL.assessment?.codes ?? {})).toEqual([
      'launch-physical-run',
      'launch-preflight-runner',
      'await-blocker-events',
      'await-current-run',
      'inspect-runner-liveness',
      'recover-expired-runner',
      'repair-code',
      'inspect-terminal-evidence',
      'read-release-control',
    ]);
  });

  /**
   * EI-22089346495559937 — `goal.portfolioThroughput` shipped with every path declared
   * under a `data.` prefix, because `goals:get`'s HANDLER returns `{ data: { … } }`. A
   * cell read never sees the handler's return value: the projected-tool dispatch that
   * `readCell` goes through hands `valueAtPath` the unwrapped body
   * (`{ id, …, portfolioThroughput }`), so every read answered `insufficient-data`
   * ("declared path drifted") and every `state:subscribe` on the cell was un-fireable —
   * for a resolver that worked perfectly. The plan whose P-002 this cell IS ("make an
   * idle steward fail loudly") shipped with its instrument unreadable, and the goal it
   * was written for sat idle-past-threshold for 130 minutes while the cell read unknown.
   *
   * Two guards. The specific paths, and the registry-wide rule that no declared path
   * may begin with `data.` — the sibling cells on `data:`-returning tools
   * (gate.qualification on dev:pipeline_position) were already envelope-free, so the
   * rule describes the registry as it actually works rather than a new convention.
   */
  describe('EI-22089346495559937: declared paths address the DISPATCHER-unwrapped payload, never the handler envelope', () => {
    it('goal.portfolioThroughput declares every path envelope-free', () => {
      expect(validateCellSpec(GOAL_PORTFOLIO_THROUGHPUT_CELL)).toEqual([]);
      expect(GOAL_PORTFOLIO_THROUGHPUT_CELL.headline).toBe('portfolioThroughput.idleMinutes');
      expect(GOAL_PORTFOLIO_THROUGHPUT_CELL.changeSignal).toEqual({
        kind: 'poll',
        tool: 'goals:get',
        path: 'portfolioThroughput.idleMinutes',
      });
      expect(GOAL_PORTFOLIO_THROUGHPUT_CELL.assessment?.path).toBe('portfolioThroughput.assessment');
      expect(GOAL_PORTFOLIO_THROUGHPUT_CELL.assessment?.evidence).toEqual([
        'portfolioThroughput.actsInWindow',
        'portfolioThroughput.lastActAtMs',
        'portfolioThroughput.lastActTool',
        'portfolioThroughput.measuredOwnerIds',
      ]);
      expect(GOAL_PORTFOLIO_THROUGHPUT_CELL.unknownHoist).toBe('portfolioThroughput.unavailable');
      expect(GOAL_PORTFOLIO_THROUGHPUT_CELL.materiality?.path).toBe('portfolioThroughput.idle');
    });

    /** Every path a spec can declare, so a new path-bearing field cannot slip past the rule. */
    const declaredPaths = (spec: CellSpec): string[] =>
      [
        spec.headline,
        spec.changeSignal.kind === 'poll' ? spec.changeSignal.path : undefined,
        spec.assessment?.path,
        ...(spec.assessment?.evidence ?? []),
        spec.unknownHoist,
        spec.materiality?.path,
      ].filter((p): p is string => typeof p === 'string');

    const envelopePrefixed = (spec: CellSpec): string[] =>
      declaredPaths(spec).filter((p) => p === 'data' || p.startsWith('data.'));

    it('no built-in cell declares a path under the handler `data.` envelope', () => {
      // Non-vacuity: the walk must actually see the cell this rule was written for.
      expect(BUILTIN_CELLS.map((c) => c.cell)).toContain('goal.portfolioThroughput');
      const offenders = BUILTIN_CELLS.filter((c) => envelopePrefixed(c).length > 0).map((c) => ({
        cell: c.cell,
        paths: envelopePrefixed(c),
      }));
      expect(offenders).toEqual([]);
    });

    it('CONTROL: the rule fires on the exact shape that shipped', () => {
      const asShipped: CellSpec = {
        ...GOAL_PORTFOLIO_THROUGHPUT_CELL,
        headline: 'data.portfolioThroughput.idleMinutes',
        changeSignal: { kind: 'poll', tool: 'goals:get', path: 'data.portfolioThroughput.idleMinutes' },
      };
      expect(envelopePrefixed(asShipped)).toEqual([
        'data.portfolioThroughput.idleMinutes',
        'data.portfolioThroughput.idleMinutes',
      ]);
    });
  });

  /**
   * P-006 — THE CHECK REGISTRATION DELIBERATELY DOES NOT DO.
   *
   * `validateCellSpec` never resolves a pointer's target, because doing so would make a
   * same-module pointer depend on declaration order — and the order authors naturally
   * write (the general cell first, the specific one it points at second) is exactly the
   * one that would fail. The cost of that choice is that a TYPO registers silently. This
   * is what pays it: over the REAL registry, after every built-in is loaded, every
   * declared pointer must name a cell that exists.
   *
   * Without this, `pointers` degrades in the worst direction available to it — a door
   * that is confidently advertised and opens onto nothing, in the one situation (a red
   * gate) where the reader is least able to afford a wild goose chase.
   */
  it('every SHIPPED pointer resolves to a registered cell', () => {
    registerBuiltinCells();
    const cells = listCellsUnchecked();

    /**
     * Extracted so the CONTROL below drives the identical expression. A guard asserting
     * `[]` passes just as happily when it is looking at nothing — if `pointers` were
     * renamed or dropped, `c.pointers ?? []` would yield an empty set forever and this
     * test would keep printing green while measuring nothing. The control is what
     * separates "no dangling pointers" from "no pointers examined".
     */
    const danglingIn = (specs: readonly CellSpec[]) => {
      const registered = new Set(cells.map((c) => c.cell));
      return specs.flatMap((c) =>
        (c.pointers ?? []).filter((p) => !registered.has(p.cell)).map((p) => `${c.cell} -> ${p.cell}`),
      );
    };

    expect(danglingIn(cells)).toEqual([]);

    // CONTROL — the same detector, on a spec whose pointer names nothing. If this stops
    // failing, the assertion above has stopped being able to fail too.
    const planted: CellSpec = {
      ...GATE_VERDICT_CELL,
      cell: 'control.planted',
      pointers: [{ cell: 'no.such.cell', when: 'always', answers: 'nothing — this is a control' }],
    };
    expect(danglingIn([planted])).toEqual(['control.planted -> no.such.cell']);

    // CALIBRATION — and the control's own premise: the REAL pointers must be non-empty,
    // or the population under test is empty and the green above is vacuous.
    expect(cells.flatMap((c) => c.pointers ?? []).length).toBeGreaterThan(0);
  });

  /**
   * The POSITIVE assertion, kept separate from the integrity check above: that check
   * passes vacuously if the pointers are ever dropped, and a silently-dropped pointer is
   * indistinguishable from a working one at the call site. This names the specific route
   * P-006 exists to create — from the two cells an agent reads on a red gate, TO the cell
   * that says who owns it (owner directive 2026-08-08: "surface it where agents look").
   */
  it('both red-gate cells route to the ownership cell', () => {
    for (const cell of [GATE_VERDICT_CELL, GATE_CANDIDATE_CELL]) {
      expect(cell.pointers?.map((p) => p.cell)).toEqual(['gate.greenCheckpoint.ownership']);
    }
  });

  it('the candidate ownership pointer states its advisory condition as a conditional, never a fact', () => {
    const pointer = GATE_CANDIDATE_CELL.pointers?.[0];
    expect(pointer?.when).toMatch(/^IF `judgingContainsPath` is true/);
    expect(pointer?.when).not.toMatch(/^`judgingContainsPath` is true/);
  });

  it('projects release:trace target.sha through the candidate cell', () => {
    expect(GATE_CANDIDATE_CELL.doorProjections).toEqual([{ tool: 'release:trace', path: 'target.sha' }]);
  });

  it('does not require the deliberately omitted run-probe containment verdict as evidence', () => {
    expect(GATE_CANDIDATE_CELL.assessment?.evidence).not.toContain(
      'changeInCandidate.judgingContainsPath',
    );
    expect(GATE_CANDIDATE_CELL.assessment?.evidence).toEqual([
      'changeInCandidate.missingReason',
      'changeInCandidate.nextCandidateSha',
    ]);
  });

  /**
   * EI-22260078732220798. `repairs-outstanding` does not merely MENTION
   * `stillBrokenNeedsRunCount` — it tells the reader to compare it against the headline
   * ("when it equals `stillBrokenCount`, nothing here is confirmed work yet"). A qualifier
   * the assessment INSTRUCTS you to read, but does not declare as evidence, is unreachable
   * in practice: this cell's payload comes back force-trimmed, so the bare
   * `stillBrokenCount` headline was the only number that survived and read as a confirmed
   * repair queue — the exact misread the prose exists to prevent, and the one that costs
   * an agent a round of re-fixing files that were already fixed.
   *
   * Asserted as a PAIR so the pin cannot rot into a bare literal: if the prose stops
   * naming the qualifier the premise assertion fails and this test must be rewritten
   * deliberately, rather than silently guarding a sentence nobody says any more.
   */
  it('declares the qualifier its own repairs-outstanding prose tells the reader to compare', () => {
    registerBuiltinCells();
    const failures = listCellsUnchecked().find(
      (c) => c.cell === 'gate.greenCheckpoint.candidateFailures',
    );

    expect(failures).toBeDefined();
    // Premise: the prose really does direct the reader at this qualifier.
    expect(failures!.assessment!.codes['repairs-outstanding']!.meaning).toContain(
      'stillBrokenNeedsRunCount',
    );
    // The point: therefore it must be reachable as evidence, beside the headline it qualifies.
    expect(failures!.assessment!.evidence).toContain(
      'gate.candidateFailures.stillBrokenNeedsRunCount',
    );
    expect(failures!.headline).toBe('gate.candidateFailures.stillBrokenCount');
  });

  /**
   * D-014, asserted rather than trusted: ownership stays a CELL with its own declared
   * semantics, and the pointer is only a route to it. If someone ever "simplifies" this
   * by folding ownership into the verdict cell as extra evidence, this fails.
   */
  it('the pointer did NOT replace the ownership cell — it still owns its own assessment', () => {
    registerBuiltinCells();
    const ownership = listCellsUnchecked().find((c) => c.cell === 'gate.greenCheckpoint.ownership');

    expect(ownership).toBeDefined();
    expect(ownership!.assessment).not.toBeNull();
    expect(ownership!.assessment!.evidence).toContain('gate.ownership.eventKey');
    expect(ownership!.assessment!.evidence).toContain('gate.ownership.workItem');
    expect(ownership!.assessment!.evidence).toContain('gate.ownership.holderSessionState');
    expect(ownership!.assessment!.evidence).toContain('gate.ownership.takenBy');
    // ...and the cell pointing AT it substantiates its own, unrelated claim. THE INTENT
    // is "not the ownership cell's evidence" — the ancestry field it names is incidental
    // and was legitimately repointed to the polarity-correct projection
    // (EI-20046248345042252), so assert the intent explicitly rather than leaving a bare
    // literal that reads as a break the next time the sign is corrected.
    expect(GATE_VERDICT_CELL.assessment).not.toBeNull();
    expect(GATE_VERDICT_CELL.assessment!.evidence).not.toContain('gate.ownership.holderSessionState');
    expect(GATE_VERDICT_CELL.assessment!.evidence).toContain('verdictProvenance.mainBehindStaging');
  });

  it('the inconclusive verdict directs readers to abort vintage and current run liveness', () => {
    const assessment = GATE_VERDICT_CELL.assessment?.codes.inconclusive;

    expect(assessment?.meaning).toContain('not a live runner-status signal');
    expect(assessment?.safeAction).toContain('gate.inconclusive.observedAtMs');
    expect(assessment?.safeAction).toContain('gate.checkpointRunInFlight');
    expect(assessment?.safeAction).toContain('do NOT stop a currently active suite');
  });

  it('held-live stops only LIVE_GATE_OPS and does not reserve generic gate-system development', () => {
    const safeAction = GATE_OWNERSHIP_CELL.assessment?.codes['held-live']?.safeAction;

    expect(safeAction).toContain('Do not take over or duplicate `LIVE_GATE_OPS`');
    expect(safeAction).toContain('current-verdict reruns');
    expect(safeAction).toContain('does not reserve independently registered `GATE_SYSTEM_DEV`');
    expect(safeAction).toContain('under its own work-item/plan lane and file locks');
  });

  it('held-live tells the existing gate holder to continue before telling peers to stand down', () => {
    const safeAction = GATE_OWNERSHIP_CELL.assessment!.codes['held-live']!.safeAction!;

    expect(safeAction).toContain('gate.ownership.takenBy');
    expect(safeAction).toContain('your verified owner identity');
    expect(safeAction).toContain('If they match, you are the existing gate holder: continue `LIVE_GATE_OPS`');
    expect(safeAction).toContain('Do not stand down because your own claim is held-live');
    expect(safeAction).toContain('If a different live owner holds it');
    expect(safeAction.indexOf('If they match')).toBeLessThan(safeAction.indexOf('Do not take over'));
  });

  /**
   * #D-065 IS THE ASSERTION. Five cells naming one resolver is axis 5 satisfied (many
   * lenses over one derivation), and the thing that would break it is someone "fixing"
   * a cell by pointing it at a second resolver — or at a hand-rolled re-derivation of
   * the same values, which is the failure axis 5 exists to prevent.
   *
   * ⚠ SCOPED TO THE PIPELINE FAMILY, not to BUILTIN_CELLS. P-016's `agent.goal`
   * legitimately has its OWN resolver — it derives a different thing from
   * different tables. Asserting "the registry has exactly one resolver" would
   * therefore be asserting that no second SUBJECT may ever be registered, which is
   * not what D-065 said and would block the registry from growing at all. The
   * invariant that matters is that the pipeline cells do not sprout a second
   * derivation among THEMSELVES.
   */
  it('the pipeline family are all lenses over the ONE gitPipelinePosition resolver', () => {
    const family = [GIT_PIPELINE_POSITION_CELL, ...NEW_CELLS];
    const resolvers = new Set(family.map((c) => c.resolver));
    expect(resolvers.size).toBe(1);
    expect([...resolvers][0]).toContain('gitPipelinePosition()');
  });

  /** Every registered cell still names exactly one resolver of its own — the
   *  per-cell half of axis 5, which the family assertion above no longer covers. */
  it('no two cells share a cell id, and every cell names a resolver', () => {
    expect(new Set(BUILTIN_CELLS.map((c) => c.cell)).size).toBe(BUILTIN_CELLS.length);
    for (const c of BUILTIN_CELLS) expect(c.resolver.trim()).not.toBe('');
  });

  /**
   * THE REGRESSION THAT MATTERS MOST, and the one this item nearly shipped wrong.
   *
   * `gate.consecutiveReds` is typed `number`, so `nullable: false` is literally true of
   * the shipped type and passes this gate with zero rejections — the exact incentive the
   * P-006 note records ("the gate rewarded the weaker cell"). It is nullable because
   * `git-pipeline-stats` applies `?? 0` to an absent counter, making a `0` that reads as
   * a passing gate. If someone later removes the hoist because "the type says number",
   * this fails.
   */
  it('declares the reds counter NULLABLE despite its non-null type, and is rejected without the hoist', () => {
    expect(GATE_VERDICT_CELL.nullable).toBe(true);
    expect(GATE_VERDICT_CELL.unknownHoist).toBe('verdictUnknown');

    const rejections = validateCellSpec({ ...GATE_VERDICT_CELL, unknownHoist: undefined });
    // Two rejections, and the second is the P-012 invariant doing its job: the streak
    // counter is PAIRED with `verdictUnknown` as its measured-ness flag, so removing the
    // hoist also strands the pairing — a count would travel alone. Both name axis 2.
    expect(rejections.map((r) => [r.axis, r.rule])).toEqual([
      [2, 'unknown-not-hoisted'],
      [2, 'measured-by-flag-not-hoisted'],
    ]);
  });

  /** Every one of the four degrades into GOOD NEWS, so every one must hoist. */
  it.each(NEW_CELLS.map((c) => [c.cell, c] as const))('%s hoists its unknown', (_id, spec) => {
    expect(spec.nullable).toBe(true);
    expect(spec.unknownHoist).toBeTruthy();
  });

  /**
   * The gate tally CITES the ancestry check as evidence — each is different apparatus
   * (a test-verdict tally vs. a git ancestry walk), and the pairing is worth pinning
   * because it looks like a mistake to a later reader who might "fix" it into a
   * self-substantiating cell.
   *
   * ⚠ Post-P-006 this asserts the shipped DECLARATIONS, not a validator: axis 1 was
   * deleted with the falsifier, so `validateCellSpec` no longer refuses a cell that
   * substantiates itself. The per-cell loop below is what still catches that.
   */
  it('substantiates the gate tally with the ancestry check, and no cell with itself', () => {
    expect(GATE_VERDICT_CELL.assessment).not.toBeNull();
    expect(GATE_VERDICT_CELL.assessment!.evidence).toContain(MAIN_BEHIND_STAGING_CELL.headline);
    expect(MAIN_BEHIND_STAGING_CELL.assessment).not.toBeNull();
    expect(MAIN_BEHIND_STAGING_CELL.assessment!.evidence).not.toContain(GATE_VERDICT_CELL.headline);
    // Independence is per-cell: no cell may substantiate its own headline with itself.
    for (const spec of NEW_CELLS) {
      expect(spec.assessment).not.toBeNull();
      expect(spec.assessment!.path).not.toBe(spec.headline);
      expect(spec.assessment!.evidence).not.toContain(spec.headline);
    }
  });

  /**
   * EI-20046248345042252 — this cell answered its own NAME BACKWARDS. It headlined
   * `verdictProvenance.mainFastForwarded`, which is the same measurement in the opposite
   * polarity, so `state:read { cell: 'git.mainBehindStaging' }` returned `false` while
   * main sat 22 commits behind staging (measured 2026-08-10). Because
   * `greenPinAtStagingHead` is false in the fleet's normal steady state, the wrong answer
   * was the STANDING one rather than an edge case.
   *
   * This pins the PROPERTY — a reader who follows the headline path gets the answer the
   * cell's NAME asks for — rather than the spelling of a field, which is what a rename
   * would sail straight through. It carries its own CONTROL so it cannot pass vacuously.
   */
  it('headlines a field whose polarity matches the cell NAME (main behind => true)', () => {
    // The fleet's normal steady state: staging has outrun the green pin, so main IS
    // behind. That is exactly what `greenPinAtStagingHead === false` encodes.
    const mainIsBehind = {
      verdictProvenance: { mainFastForwarded: false, mainBehindStaging: true },
    };
    const read = (path: string): unknown =>
      path
        .split('.')
        .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], mainIsBehind);

    expect(MAIN_BEHIND_STAGING_CELL.cell).toBe('git.mainBehindStaging');
    // THE ASSERTION THAT MATTERS: follow the headline, get the name's answer.
    expect(read(MAIN_BEHIND_STAGING_CELL.headline)).toBe(true);

    // CONTROL — the field it used to headline yields the OPPOSITE from the same fixture.
    // If this ever stops holding, the fixture has gone vacuous and the check above is
    // no longer evidence of anything.
    expect(read('verdictProvenance.mainFastForwarded')).toBe(false);

    // A change-signal left on the old path would poll the opposite sign, so a watcher
    // would fire on exactly the wrong transition.
    expect(MAIN_BEHIND_STAGING_CELL.changeSignal).toMatchObject({
      path: MAIN_BEHIND_STAGING_CELL.headline,
    });
  });

  /**
   * Axis 3 differs ACROSS cells that share a resolver, which is the concrete evidence
   * that relativity belongs to the cell and not the derivation: the candidate cell is
   * per-path, the other three are global. An author copying a spec would get this wrong.
   */
  it('declares caller-relativity per CELL, not per resolver', () => {
    expect(GATE_CANDIDATE_CELL.callerRelativity).toEqual({ kind: 'parameter', param: 'path' });
    expect(GATE_VERDICT_CELL.callerRelativity).toEqual({ kind: 'global' });
    expect(DEPLOYED_SHA_CELL.callerRelativity).toEqual({ kind: 'global' });
    expect(MAIN_BEHIND_STAGING_CELL.callerRelativity).toEqual({ kind: 'global' });
  });

  /**
   * EI-11012 / why-chain.ts: a nonzero staging buffer is the NORMAL steady state, and
   * the naive "behind = broken" reading made the deploy stage report degraded
   * essentially always, shadowing every real cause. The assessment carries that
   * distinction as a positive code with an explicit safe action.
   */
  it('classifies normal lag without the naive "lag means stalled" misreading', () => {
    const assessment = MAIN_BEHIND_STAGING_CELL.assessment;
    expect(assessment).not.toBeNull();
    expect(assessment!.evidence).toContain('gate.fireStale');
    expect(assessment!.codes['normal-buffer'].meaning).toContain('ordinary steady state');
    expect(assessment!.codes['normal-buffer'].safeAction).toContain('Do NOT report this as a stalled pipeline');
    expect(assessment!.codes['gate-stalled'].meaning).toContain('gate is not firing');
  });

  it('P-005 keeps the whole owner answer in one cell, including promotion and measurement provenance', () => {
    const assessment = GATE_OWNER_BRIEF_CELL.assessment;
    expect(assessment).not.toBeNull();
    expect(Object.keys(assessment!.codes)).toEqual(
      expect.arrayContaining(['green', 'green-not-promoted', 'no-verdict', 'red-owned-stalled']),
    );
    expect(assessment!.codes['green-not-promoted'].safeAction).toContain('frozen-lineage');
    expect(assessment!.codes['no-verdict'].meaning).toContain('zero new reds is NOT evidence of green');
    expect(assessment!.evidence).toContain('gate.ownerBrief.whyNot.measured');
    expect(assessment!.evidence).toContain('gate.ownerBrief.whyNot.provenance');
    expect(assessment!.evidence).toContain('gate.ownerBrief.promotion.mainContainsJudgedSha');
    expect(assessment!.evidence).toContain('gate.ownerBrief.promotion.staging.bufferPresent');
    expect(assessment!.evidence).toContain('gate.ownerBrief.promotion.staging.relation');
    expect(assessment!.evidence).toContain('gate.ownerBrief.remediation.admissions');
    expect(assessment!.evidence).toContain('gate.ownerBrief.remediation.signature');
    expect(assessment!.evidence).toContain('gate.ownerBrief.remediation.legs');
    expect(assessment!.evidence).toContain('gate.ownerBrief.remediation.blockedReason');
    expect(assessment!.evidence).toContain('gate.ownerBrief.testProgress');
    expect(GATE_OWNER_BRIEF_CELL.shape).toContain('testProgress');
  });

  /** Axis 4 admits no fixture-only registration, and every one of these carries a
   *  verbatim live read rather than a promise that one happened. The date is the
   *  CELL'S OWN exercise date (the original four: 2026-07-27; ownerBrief: 2026-08-31)
   *  — asserted as "a dated read exists", not pinned to one day, so a new family
   *  member does not have to lie about when it was exercised. */
  it.each(NEW_CELLS.map((c) => [c.cell, c] as const))('%s cites a real live exercise', (_id, spec) => {
    expect(spec.provenance.liveExercised).toBe(true);
    expect(spec.provenance.evidence).toContain('dev:pipeline_position');
    expect(spec.provenance.evidence).toMatch(/\b2026-\d{2}-\d{2}/);
  });
});

describe('EI-20449419111876508: host.memoryPressure is a readable shared-writer cell', () => {
  beforeEach(() => __resetCellRegistryForTests());

  it('validates and registers under the workspace-visible global contract', () => {
    expect(validateCellSpec(HOST_MEMORY_PRESSURE_CELL)).toEqual([]);
    registerBuiltinCells();
    expect(getCell('host.memoryPressure', { ownerId: 'su-anyone' })).toEqual(
      HOST_MEMORY_PRESSURE_CELL,
    );
    expect(HOST_MEMORY_PRESSURE_CELL.callerRelativity).toEqual({ kind: 'global' });
    expect(HOST_MEMORY_PRESSURE_CELL.visibility).toEqual({ kind: 'workspace' });
  });

  it('routes through the canonical memory writer and hoists incomplete inputs', () => {
    expect(HOST_MEMORY_PRESSURE_CELL.changeSignal).toEqual({
      kind: 'poll',
      tool: 'host:memory_pressure',
      path: 'memory.pressure',
    });
    expect(HOST_MEMORY_PRESSURE_CELL.resolver).toContain('evaluateMemoryPressure');
    expect(HOST_MEMORY_PRESSURE_CELL.nullable).toBe(true);
    expect(HOST_MEMORY_PRESSURE_CELL.unknownHoist).toBe('memory.unknown');
  });

  it('declares the in-process free-memory measurement as independent assessment evidence', () => {
    const assessment = HOST_MEMORY_PRESSURE_CELL.assessment;
    expect(assessment).not.toBeNull();
    expect(assessment!.evidence).toContain('host.memFreePct');
    expect(assessment!.evidence).not.toContain(HOST_MEMORY_PRESSURE_CELL.headline);
    expect(assessment!.codes['stable-low-free'].meaning).toMatch(/free memory is below the declared capacity warning threshold/);
  });

  it('does not present cumulative cgroup reclaim counters as current-window causation', () => {
    const action = HOST_MEMORY_PRESSURE_CELL.assessment!.codes.critical.safeAction;
    expect(action).toMatch(/cumulative historical leads/);
    expect(action).toMatch(/current-window/);
    expect(action).not.toMatch(/remove the attributed pressure source/);

    const attribution = MEMORY_CGROUP_ATTRIBUTION_CELL.assessment!;
    expect(attribution.codes.crit.meaning).toMatch(/historical owner context/);
    expect(attribution.codes.crit.meaning).toMatch(/not current-window causal proof/);
  });
});

describe('EI-21572281184148497: memory.cgroupAttribution is a readable shared-writer lens', () => {
  beforeEach(() => __resetCellRegistryForTests());

  it('validates and registers as a workspace-visible nullable cell', () => {
    expect(validateCellSpec(MEMORY_CGROUP_ATTRIBUTION_CELL)).toEqual([]);
    registerBuiltinCells();
    expect(getCell('memory.cgroupAttribution', { ownerId: 'su-anyone' })).toEqual(
      MEMORY_CGROUP_ATTRIBUTION_CELL,
    );
    expect(MEMORY_CGROUP_ATTRIBUTION_CELL.callerRelativity).toEqual({ kind: 'global' });
    expect(MEMORY_CGROUP_ATTRIBUTION_CELL.visibility).toEqual({ kind: 'workspace' });
    expect(MEMORY_CGROUP_ATTRIBUTION_CELL.nullable).toBe(true);
    expect(MEMORY_CGROUP_ATTRIBUTION_CELL.unknownHoist).toBe('memory.unknown');
  });

  it('projects the existing host:memory_pressure attribution path without a second resolver', () => {
    expect(MEMORY_CGROUP_ATTRIBUTION_CELL.changeSignal).toEqual({
      kind: 'poll',
      tool: 'host:memory_pressure',
      path: 'memory.cgroupAttribution',
    });
    expect(MEMORY_CGROUP_ATTRIBUTION_CELL.resolver).toBe(HOST_MEMORY_PRESSURE_CELL.resolver);
    expect(MEMORY_CGROUP_ATTRIBUTION_CELL.assessment?.path).toBe('memory.pressure');
    expect(MEMORY_CGROUP_ATTRIBUTION_CELL.assessment?.evidence).toEqual(['memory.unknown']);
  });
});

/**
 * P-016 — the agent goal cell.
 *
 * The assertions worth making here are the ones that would go red if someone
 * "simplified" the cell back to the plan item's literal wording. The precedence
 * sentence is under-determined on the live fleet, and the assessment is what
 * carries that distinction to the next author.
 */
describe('P-016: agent.goal registers under the D-038 contract', () => {
  beforeEach(() => __resetCellRegistryForTests());

  it('validates with zero rejections', () => {
    expect(validateCellSpec(AGENT_GOAL_CELL)).toEqual([]);
  });

  it('registers and is retrievable by any reader — a blocked peer is the point', () => {
    registerBuiltinCells();
    expect(getCell('agent.goal', { ownerId: 'su-anyone' })?.resolver).toContain('resolveOwnerGoal()');
  });

  /**
   * Axis 3. The whole cell is "about WHICH agent", so a global or ambient
   * declaration would be a category error — and `cell-read.ts` names this cell as
   * the motivating example for the `subject` parameter.
   */
  it('is parameter-relative on ownerId, not global', () => {
    expect(AGENT_GOAL_CELL.callerRelativity).toEqual({ kind: 'parameter', param: 'ownerId' });
  });

  /**
   * The assessment must be supported by the LINK GRAPH, not staleness: staleness is
   * already carried by HolderContext rule (e), so reusing it would add
   * interpretation with no new information.
   */
  it('assesses goal support via the coord_links edge, not staleness', () => {
    const assessment = AGENT_GOAL_CELL.assessment;
    expect(assessment).not.toBeNull();
    expect(assessment!.evidence).toContain('goalAgreement');
    expect(assessment!.evidence).not.toContain('stale');
    // Competing claims are the load-bearing distinction: precedence alone is not enough.
    expect(assessment!.codes.divergent.safeAction).toContain('goalCompeting');
  });

  /** Axis 2. A held-nothing agent has no goal, and the competing claims must be
   *  hoisted to the RESULT so a caller who skips `agreement` still cannot miss them. */
  it('is nullable and hoists the reason there is no goal', () => {
    expect(AGENT_GOAL_CELL.nullable).toBe(true);
    expect(AGENT_GOAL_CELL.unknownHoist).toBe('goalUnknown');
  });

  /**
   * ⚠ THE REGRESSION THIS PINS, and it is not cosmetic. `valueAtPath` returns
   * `undefined` the moment ANY path segment is null, so a nested headline like
   * `goal.ref` would make `readCell` answer `insufficient-data` for every agent
   * holding nothing — and that code's message tells the reader the resolver's
   * shape has "drifted apart" from the cell. A confidently wrong diagnosis of the
   * most ordinary case there is. Flattened, the same case reads `value: null`.
   *
   * Anyone "tidying" this back under the `goal` object reintroduces it silently,
   * because every fixture with a goal still passes.
   */
  it('keeps the headline path FLAT so a goal-less agent reads null, not a fake drift error', () => {
    expect(AGENT_GOAL_CELL.headline).toBe('goalRef');
    expect(AGENT_GOAL_CELL.headline).not.toContain('.');
    if (AGENT_GOAL_CELL.changeSignal.kind !== 'poll') throw new Error('expected a poll cell');
    expect(AGENT_GOAL_CELL.changeSignal.path).toBe('goalRef');
    expect(AGENT_GOAL_CELL.changeSignal.path).not.toContain('.');
  });

  /**
   * P-019. Narrowing this cell would make it useless for the thing D-051 built it
   * for — a BLOCKED PEER reading the holder's goal — while promising a secrecy
   * the claim surfaces do not actually provide.
   */
  it('is workspace-visible and hive-local', () => {
    expect(AGENT_GOAL_CELL.visibility).toEqual({ kind: 'workspace' });
    expect(AGENT_GOAL_CELL.federation).toEqual({ kind: 'local' });
  });

  /**
   * A registered cell with no dispatchable poll tool is unreadable forever —
   * `readCell` would return insufficient-data — which is the "surface #29"
   * failure D-010's adoption gate exists to prevent.
   */
  it('names a poll resolver so the cell is actually readable', () => {
    expect(AGENT_GOAL_CELL.changeSignal).toEqual({
      kind: 'poll',
      tool: 'coord:goal',
      path: 'goalRef',
    });
  });

  /** Axis 6 absent: the four SOURCES are a precedence, not a sequence. Declaring
   *  them as stages would invite reading `fleet-mission` as "further along". */
  it('declares no stage order', () => {
    expect(AGENT_GOAL_CELL.ordered).toBeUndefined();
  });

  it('is in BUILTIN_CELLS and does not collide with an existing resolver', () => {
    expect(BUILTIN_CELLS).toContain(AGENT_GOAL_CELL);
    registerBuiltinCells();
    expect(() => registerBuiltinCells()).not.toThrow();
  });
});

/**
 * P-005 — REACH VERIFICATION over the REAL registry.
 *
 * Everything above validates cell DECLARATIONS. This asserts the property that
 * actually matters to an agent: that the audiences those cells declare are reachable
 * by the readers the documentation points at them. That is a different question, and
 * it was false in production for ten days with every declaration test green.
 *
 * WHAT WAS BROKEN. `CLAUDE.md` directs su agents at the six pipeline cells
 * (`gate.greenCheckpoint.*`, `git.*`, `deploy.3070.sha`) and tells them
 * `dev:pipeline_position` "HANDS YOU THE HANDLE" to re-read them. But an operator-scope
 * session presents `harnessSlug:'*'`, the harness check was a bare `===`, and so every
 * one of those cells read as `absent` — measured 418 distinct agents / 358,755 calls in
 * a 24h window. The plane block vanished with them, because `stampStatePlane` shares
 * this oracle. Both symptoms are pinned below, against the real specs rather than
 * fixtures, because a fixture is exactly what failed to catch this.
 */
describe('P-005 — declared audiences are actually reachable (real registry)', () => {
  beforeEach(() => {
    __resetCellRegistryForTests();
    registerBuiltinCells();
  });

  /** The identity a cross-harness su/superuser session really presents. Not invented:
   *  every `harnessSlug:'*'` caller in a measured 24h window carried role `operator`. */
  const operatorScope = { ownerId: 'su-p005', roles: ['operator'], harnessSlug: '*' };

  it('an operator-scope reader reaches EVERY registered cell', () => {
    // listCellsUnchecked is the sanctioned admin enumeration (P-005 names it): the probe
    // must see cells the reader cannot, or it could not detect one going unreachable.
    const unreachable = listCellsUnchecked()
      .filter((spec) => !getCell(spec.cell, operatorScope))
      .map((spec) => spec.cell);

    expect(
      unreachable,
      `these registered cells are UNREACHABLE by a normal operator-scope session ` +
        `(role=operator, harnessSlug='*'): ${unreachable.join(', ')}. Agents are pointed at ` +
        `these by name in CLAUDE.md and will get a bare "absent", which P-019 makes ` +
        `deliberately indistinguishable from "no such cell" — so the failure is silent.`,
    ).toEqual([]);
  });

  it('covers the pipeline cells specifically, by name', () => {
    // The regression itself. Named individually so a failure says WHICH cell went dark.
    for (const spec of OPERATOR_PIPELINE_CELLS) {
      expect(getCell(spec.cell, operatorScope), `${spec.cell} unreadable`).toBeTruthy();
    }
  });

  it('the probe can still FAIL — a foreign-harness agent is refused', () => {
    // Calibration. Without this, a canReadCell that returned true unconditionally would
    // pass every assertion above, and the probe would be measuring nothing.
    const sidestage = { ownerId: 'su-other', roles: ['operator'], harnessSlug: 'sidestage' };
    for (const spec of OPERATOR_PIPELINE_CELLS) {
      expect(getCell(spec.cell, sidestage), `${spec.cell} leaked to a foreign harness`).toBeFalsy();
    }
    // ...and it is a REFUSAL, not an empty registry: the same reader still sees the
    // workspace-visible cells, so the negative above is about audience, not registration.
    expect(getCell(AGENT_GOAL_CELL.cell, sidestage)).toBeTruthy();
  });
});

describe('P-009 / D-013: no registered cell declares a federation nobody transports', () => {
  beforeEach(() => {
    __resetCellRegistryForTests();
  });

  it('every builtin cell is `local`', () => {
    // THE DRIFT GUARD. The validator refuses `shareable` at registration, but this
    // asserts the property over the REAL population rather than over a hand-built
    // spec — so it fails if someone lands a shareable cell by any route (including
    // flipping CELL_FEDERATION_TRANSPORT_AVAILABLE) without wiring a transport that
    // actually consumes spec.federation.
    const notLocal = BUILTIN_CELLS.filter((c) => c.federation?.kind !== 'local').map((c) => c.cell);
    expect(notLocal, `cells declaring a federation nothing transports: ${notLocal.join(', ')}`).toEqual([]);
  });

  it('measures the population from the registry, so a new cell cannot slip past it', () => {
    // Calibration, and NOT redundant with the assertion above: a filter over an EMPTY
    // array also returns [], so without this the guard would pass vacuously if
    // BUILTIN_CELLS were ever emptied or renamed. Measured 2026-08-21: 10 cells — and
    // a string-literal grep of cell-registrations.ts finds only 9 of them, because
    // agent.goal registers its name through the AGENT_GOAL_CELL_ID constant. That 10%
    // silent undercount is exactly why this counts the registry, never the source text.
    expect(BUILTIN_CELLS.length).toBeGreaterThanOrEqual(10);
    registerBuiltinCells();
    expect(listCellsUnchecked().length).toBe(BUILTIN_CELLS.length);
  });
});

/**
 * WI-6528 — MAKE D-076 EXECUTABLE.
 *
 * D-076 (plan agent-state-plane-verification-2026-07-27) ruled that the cell layer is a
 * PARALLEL projection and never a required path: "every registered cell shares its resolver
 * with a NON-CELL surface agents already use, so state:read can never produce a behavioural
 * delta". It proved that by READING the registry by hand, over the 6 cells that existed on
 * 2026-07-28. The registry has since grown to 17. A hand-read proof does not survive growth.
 *
 * It is truer than D-076 argued, and for a better reason: `state:read` owns NO resolver of its
 * own. `readCell` DISPATCHES the sibling door — `dispatchReadOnlyTool(spec.changeSignal.tool)`
 * (cell-read.ts:749) — and projects `changeSignal.path` out of its reply. So the sibling
 * relation is not a property of the registrations; it is what the read door IS.
 *
 * That makes `changeSignal.tool` load-bearing in a way nothing checks. `dispatchReadOnlyTool`
 * throws `unknown_tool` for a name that does not resolve and `not_read_only` for a write-effect
 * tool (predicate-watch.ts:581-588) — but BOTH fire at read time, per read. A cell registered
 * with a typo'd, renamed, or write-effect tool therefore:
 *   - passes the type (`changeSignal.tool` is a bare `string`),
 *   - passes every `validateCellSpec` reject rule (none inspects the tool NAME), and
 *   - passes cell-access-parity's LEG E, which walks all BUILTIN_CELLS but asserts only the
 *     visibility gate — its own comment says "A poll cell would dispatch a real tool here, so
 *     only the GATE is asserted".
 * ...and then returns `unknown` at every read, forever. That failure is near-invisible:
 * EI-21544761852770720 records five consecutive `unknown` readings being misread as a wedged
 * resolver when the door was healthy. A cell that never worked looks identical.
 *
 * WHY A TEST RATHER THAN A REGISTRATION-TIME REFUSAL. The stronger fix is one line in
 * `validateCellSpec`, which is what this gap's original finder proposed a month ago. It is not
 * taken here because `cell-registry.ts` is imported broadly across operator-core while
 * `lookupByMcpName` lives in `@papercusp/agent-mcp`, which projects operator-core's own tools —
 * importing it into the registry core risks an import cycle for a check that a build-time test
 * pins just as firmly. If that cycle is ever shown not to exist, promote this to the gate.
 */
describe('WI-6528 / D-076: every cell projects a REAL, read-only, NON-CELL door', () => {
  /** The pulled projections themselves. A cell naming one of these is circular by definition. */
  const CELL_DOORS = new Set(['state:read', 'state:subscribe']);

  /**
   * The whole judgement, as ONE predicate over a tool name, so the controls below can feed it
   * inputs the real registry does not contain. Returns the DEFECT, or null when the door is
   * sound — naming which of the three ways it broke, so a control cannot pass for the wrong one.
   */
  function siblingDoorDefect(tool: string): 'circular' | 'unknown-tool' | 'not-read-only' | null {
    // Checked FIRST: state:read resolves and IS read-only, so the later checks would clear it.
    if (CELL_DOORS.has(tool)) return 'circular';
    const projected = lookupByMcpName(tool);
    if (!projected) return 'unknown-tool';
    // `effect` is not on the exported RoleToolDefinition surface (WI-38184 hit exactly this as a
    // type error), so read it through a narrow cast rather than widening the type.
    if ((projected as { effect?: string }).effect !== 'read') return 'not-read-only';
    return null;
  }

  /**
   * FALSIFIABILITY, permanently — not a one-shot mutation of the shared tree.
   *
   * CLAUDE.md's mutation-probe tiers put an imported PREDICATE at the top tier: keep a
   * deliberately-wrong input in the test file rather than mutating production code, because the
   * subject here is a pure function of a tool name and can simply be handed one. These three
   * inputs are the three ways a cell's sibling door can be wrong, and each must be caught for a
   * DISTINCT reason — asserting the specific defect is what stops one control from passing
   * because a different check fired.
   */
  it('CONTROL: the predicate catches all three defects (so a green walk below means something)', () => {
    expect(siblingDoorDefect('definitely:not-a-real-tool'), 'unresolvable door').toBe('unknown-tool');
    expect(siblingDoorDefect('state:read'), 'the cell door itself').toBe('circular');
    expect(siblingDoorDefect('state:subscribe'), 'the other cell door').toBe('circular');
    // A real WRITE tool: dispatchReadOnlyTool refuses anything but effect==='read'.
    expect(siblingDoorDefect('work_items:create'), 'a write-effect door').toBe('not-read-only');
  });

  it('CALIBRATION: the predicate CLEARS a door we know is good', () => {
    // The other half of the control: a predicate that returned a defect for everything would
    // make the walk below pass its controls and fail honestly on real cells — or vice versa.
    expect(siblingDoorDefect('dev:pipeline_position')).toBeNull();
  });

  it('NON-VACUOUS: there are poll cells to check', () => {
    const poll = BUILTIN_CELLS.filter((s) => s.changeSignal.kind === 'poll');
    expect(poll.length).toBeGreaterThan(0);
    // Measured 2026-08-30: all 17 built-in cells are poll-kind, zero event-kind. If an
    // event-kind cell is ever added it is SKIPPED by the walk below (it declares an event key,
    // not a door), so this records how much of the registry the walk actually covers.
    expect(poll.length).toBe(BUILTIN_CELLS.length);
  });

  for (const spec of BUILTIN_CELLS) {
    if (spec.changeSignal.kind !== 'poll') continue;
    const tool = spec.changeSignal.tool;

    it(`${spec.cell}: "${tool}" resolves, is read-only, and is not a cell door`, () => {
      expect(
        siblingDoorDefect(tool),
        `${spec.cell} declares changeSignal.tool "${tool}".\n` +
          '  unknown-tool  => readCell dispatches this name on EVERY read, so the cell is DEAD: it\n' +
          '                  returns unknown/resolver-failed forever, which reads exactly like a\n' +
          '                  slow or wedged resolver (EI-21544761852770720). Fix the name.\n' +
          '  not-read-only => dispatchReadOnlyTool refuses any effect but "read", so every read fails.\n' +
          '  circular      => the cell names a CELL DOOR as its own sibling. D-076 rules the cell\n' +
          '                  layer is a PARALLEL projection and never a required path; a cell whose\n' +
          '                  only door is state:read breaks that (and recurses through readCell).',
      ).toBeNull();
    });
  }
});
