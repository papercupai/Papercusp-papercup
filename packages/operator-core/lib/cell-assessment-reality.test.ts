/**
 * cell-assessment-schema-and-falsifier-removal-2026-08-21 P-004 — ASSERT EVERY
 * REGISTERED CELL'S ASSESSMENT IS REAL.
 *
 * Replaces `cell-falsifier-reality.test.ts`, and inherits its premise wholesale: the
 * sibling declaration suite (`cell-registrations.test.ts`) compares a DECLARATION TO
 * ANOTHER DECLARATION and never calls a resolver, so it is satisfied by a spec whose
 * `assessment.path` names something NO RESOLVER PRODUCES. `validateCellSpec` cannot
 * close that gap either — it is deliberately domain-free and only normalises strings.
 *
 * ── WHAT THIS FILE ADDS OVER THE FALSIFIER SUITE IT REPLACES ───────────────────
 *
 * A falsifier could only ever be checked for EXISTENCE: it named a field and some
 * prose, and "did the field arrive" was the whole of what a machine could ask. An
 * assessment declares a CLOSED CODE MAP, which makes three further questions
 * decidable — and all three are failure modes the old suite structurally could not
 * see:
 *
 *   1. PRODUCIBILITY — can every declared code actually be emitted? A code declared
 *      but unreachable is a promise the resolver cannot keep, and the reader who
 *      branches on it waits forever for a state that never arrives.
 *   2. CLOSURE — can the resolver emit a code the spec does NOT declare? That read
 *      is refused at runtime (`assessmentFrom` downgrades it to `unavailable`), so
 *      the drift shows up as a cell that silently stops answering.
 *   3. CONSTANCY / SIGN — does the assessment actually MOVE with its inputs, in the
 *      declared direction? A constant assessment distinguishes nothing, and an
 *      inverted one is worse than none: `git.mainBehindStaging` shipped exactly that
 *      bug (EI-20046248345042252) and answered its own name backwards for weeks,
 *      with the WRONG answer as the STANDING one rather than an edge case.
 *
 * ── THE PAYLOAD THESE PATHS ARE WALKED AGAINST ─────────────────────────────────
 *
 * NOT the resolver function's return value — the RESULT OF THE POLL TOOL named in
 * `changeSignal.tool`, because that is what `readCell` dispatches. Confusing the two
 * produces a confident false alarm: `resolveOwnerGoal()` returns no `goalRef` and no
 * `goalUnknown` anywhere, so probing the raw resolver reports `agent.goal`'s declared
 * paths missing. They are not missing; `coord:goal` hoists them flat precisely so the
 * goal-less case reads as null instead of drift.
 *
 * ⚠ AND IT USES THE SHARED `pathExists` FROM `state-plane-stamp` — the SAME function
 * `assessmentFrom` calls. The old suite carried its own copy, which meant this guard
 * could disagree with the read it was guarding. Importing the real one makes "the
 * test says the path is there" and "the read can find the path" the same claim.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { CellSpec } from './cell-registry';
import { BUILTIN_CELLS } from './cell-registrations';
import { pathExists } from './state-plane-stamp';
import { formatMeasurednessViolations, hoistedPaths, isCountOrList, measurednessViolations } from './cell-measuredness';
import { CELL_UNKNOWN_CODES } from './cell-contract';
import { assessCandidateFailures } from './gate-candidate-failures';
import {
  gitPipelinePosition,
  assessPipelinePosition,
  assessGateVerdict,
  assessGateCandidate,
  assessDeployedSha,
  assessMainBehindStaging,
} from './git-pipeline-position';
import { assessGateOwnership } from './coord/gate-ownership';
import { CRITICAL_CLAIM_PROGRESS_LEASE_MS } from './agent-tools/work_items/release-force-guard';
import {
  assessFreezeDisposition,
  type FreezeAndConvergeGateHealth,
} from './release/freeze-disposition';
import {
  assessFrozenRepairConvergence,
  type StoredFrozenRepairConvergence,
} from './release/frozen-candidate-repair-queue';
import { assessRetriage, type RetriageRunReading } from './release/in-flight-retriage';
// ⚠ The REAL assessor, imported past the module mock below (which spreads the actual
// module for exactly this reason): it is the SUBJECT of the goal control rows, and a
// stubbed one would make every row assert against the mock instead of the code.
import { assessAgentGoal } from './agent-tools/coordination/agent-goal-sources';
import { assessHostMemoryPressure } from './agent-tools/state/host-memory';
import { assessTestingCensusPopulation, assessTestingCoverageFloor } from './agent-tools/testing/coverage';
import { deriveCapacityVerdict, type AdmissionTerms } from './fleet/capacity-verdict';
import type { ProviderPoolVerdict } from './deployment/account-pool-store';
import { roleLaunchVerdict } from './agent-tools/config/role-launch';
import type { RoleLaunch } from './fleet/role-launch';
import { assessWorkScope } from './work-scope-policy';
import { assessVerificationHealth } from './verification-health';
import { BUG_INFLOW_STALE_AFTER_MS, shapeBugInflow, type BugInflowRow } from './harness/improvements/bug-inflow';
import { bugInflowPayload } from './agent-tools/improvements/bug-inflow';
import {
  assessDirectiveStatus,
  deriveDirectiveStatus,
  type DirectiveLinkedWorkItem,
  type DirectiveStatusDirectiveInput,
} from './owner-directive-status';
import hostMemoryPressureTool from './agent-tools/state/host-memory';
import coverageTool from './agent-tools/testing/coverage';
import governorStateTool from './agent-tools/state/governor-state';
import { composeGateOwnerBrief, type GateOwnerBriefInput } from './gate-owner-brief';
import { portfolioAssessmentFor } from './goals/portfolio-throughput';
import { LspAdmissionController } from './code-intelligence/lsp-admission';
import { buildLspAdmissionStatePayload } from './agent-tools/state/lsp-admission';
import type { LspDaemonAnswer } from './code-intelligence/lsp-daemon-protocol';

/**
 * The no-real-PG rail's DOCUMENTED opt-out, taken for the same reason the falsifier
 * suite took it (EI-19316737896654304): this file's entire premise is that declared
 * paths are walked against a payload THIS BOX'S LIVE RESOLVER actually produced.
 * Renaming to `*.integration.test.ts` would build against a throwaway testcontainer
 * whose empty gate/deploy state produces a differently-shaped payload — silently
 * converting a reality check into a fixture check, which is the class of guard this
 * file exists to replace. Everything here asserts payload SHAPE and pivots off values
 * read from the same live run, so no live row's contents can make it pass or fail.
 */
let forbidRealPgBefore: string | undefined;
beforeAll(() => {
  forbidRealPgBefore = process.env.PAPERCUSP_FORBID_REAL_PG;
  delete process.env.PAPERCUSP_FORBID_REAL_PG;
});
afterAll(() => {
  if (forbidRealPgBefore === undefined) delete process.env.PAPERCUSP_FORBID_REAL_PG;
  else process.env.PAPERCUSP_FORBID_REAL_PG = forbidRealPgBefore;
});

/** Every path a cell's ASSESSMENT declares into its resolver's payload. */
function assessmentPaths(spec: CellSpec): Array<{ label: string; path: string }> {
  const a = spec.assessment;
  if (!a) return [];
  return [
    { label: 'assessment.path', path: a.path },
    ...a.evidence.map((path, i) => ({ label: `assessment.evidence[${i}]`, path })),
  ];
}

/**
 * THE PREDICATE every live check below shares — extracted so it can be FALSIFIED.
 *
 * A guard that has never failed is a guard nobody has tested, and this file passed
 * whole on its first run. Rather than mutate the shared tree to find out (a probe that
 * git-sync can commit mid-run), the controls at the bottom of this file feed this
 * function deliberately-broken specs against a REAL payload and assert it names the
 * break — permanently, on every future run, instead of once today.
 */
function missingAssessmentPaths(spec: CellSpec, payload: unknown): string[] {
  return assessmentPaths(spec)
    .filter(({ path }) => !pathExists(payload, path).exists)
    .map(({ path }) => path);
}

/** Same spec with ONE declared path replaced by a name no resolver produces. */
function withBrokenPath(spec: CellSpec, which: 'assessment.path' | 'evidence'): CellSpec {
  const a = spec.assessment!;
  return {
    ...spec,
    assessment:
      which === 'assessment.path'
        ? { ...a, path: `${a.path}__NO_SUCH_FIELD` }
        : { ...a, evidence: [`${a.evidence[0]}__NO_SUCH_FIELD`, ...a.evidence.slice(1)] },
  };
}

const PIPELINE_CELLS = BUILTIN_CELLS.filter(
  (c) => c.changeSignal.kind === 'poll' && c.changeSignal.tool === 'dev:pipeline_position',
);
const GOAL_CELLS = BUILTIN_CELLS.filter((c) => c.changeSignal.kind === 'poll' && c.changeSignal.tool === 'coord:goal');
const PORTFOLIO_CELLS = BUILTIN_CELLS.filter((c) => c.changeSignal.kind === 'poll' && c.changeSignal.tool === 'goals:get');
const HOST_MEMORY_CELLS = BUILTIN_CELLS.filter(
  (c) => c.changeSignal.kind === 'poll' && c.changeSignal.tool === 'host:memory_pressure',
);
const COVERAGE_CELLS = BUILTIN_CELLS.filter(
  (c) => c.changeSignal.kind === 'poll' && c.changeSignal.tool === 'testing:coverage',
);
const GOVERNOR_CELLS = BUILTIN_CELLS.filter(
  (c) => c.changeSignal.kind === 'poll' && c.changeSignal.tool === 'governor:state_snapshot',
);
const CAPACITY_CELLS = BUILTIN_CELLS.filter(
  (c) => c.changeSignal.kind === 'poll' && c.changeSignal.tool === 'fleet:capacity',
);
const ROLE_LAUNCH_CELLS = BUILTIN_CELLS.filter(
  (c) => c.changeSignal.kind === 'poll' && c.changeSignal.tool === 'config:role-launch',
);
const WORK_SCOPE_CELLS = BUILTIN_CELLS.filter(
  (c) => c.changeSignal.kind === 'poll' && c.changeSignal.tool === 'workspace:work_scope_status',
);
const DIRECTIVE_CELLS = BUILTIN_CELLS.filter(
  (c) => c.changeSignal.kind === 'poll' && c.changeSignal.tool === 'orders:get',
);
const GATE_OWNERSHIP_CELLS = BUILTIN_CELLS.filter(
  (c) => c.changeSignal.kind === 'poll' && c.changeSignal.tool === 'dev:gate_ownership',
);
const LSP_ADMISSION_CELLS = BUILTIN_CELLS.filter(
  (c) => c.changeSignal.kind === 'poll' && c.changeSignal.tool === 'lsp:admission_snapshot',
);
const VERIFICATION_HEALTH_CELLS = BUILTIN_CELLS.filter(
  (c) => c.changeSignal.kind === 'poll' && c.changeSignal.tool === 'plans:verification-health',
);
const WORK_BUG_INFLOW_CELLS = BUILTIN_CELLS.filter(
  (c) => c.changeSignal.kind === 'poll' && c.changeSignal.tool === 'improvements:bug-inflow',
);

// bug-inflow-one-problem-one-row-2026-10-18 P-007: work.bugInflow's real pure assessor
// (shapeBugInflow) over stored bug_inflow_daily rows, at a fixed clock so "today" and the
// newest row's age are exact rather than whatever the wall clock says.
const BUG_INFLOW_NOW = new Date('2026-10-20T12:00:00.000Z');
const bugInflowRow = (day: string, computedAgoMs: number): BugInflowRow => ({
  day,
  filed_total: 5,
  filed_by_source: { watchdog: 3, agent: 2 },
  closed_total: 2,
  closed_by_status: { done: 2 },
  computed_at: new Date(BUG_INFLOW_NOW.getTime() - computedAgoMs),
});
const BUG_INFLOW = (rows: readonly BugInflowRow[]) => shapeBugInflow(rows, { now: BUG_INFLOW_NOW, windowDays: 7 });
const BUG_INFLOW_FRESH = [bugInflowRow('2026-10-20', 10 * 60_000), bugInflowRow('2026-10-19', 10 * 60_000)];

// Exercise the actual daemon controller and state lens. A hand-authored code list
// cannot detect a constant/inverted snapshot or an unavailable read becoming idle.
type LspStatePayload = Awaited<ReturnType<typeof buildLspAdmissionStatePayload>>;
const lspPayloads: Record<string, LspStatePayload> = {};
const lspRuntimePayloads: Record<string, LspStatePayload> = {};
const lspPayloadsByCell: Record<string, Record<string, LspStatePayload>> = {
  'lsp.admission': lspPayloads,
  'lsp.warmServers': lspRuntimePayloads,
  'lsp.readiness': lspRuntimePayloads,
};
type LspRuntime = NonNullable<LspDaemonAnswer['daemonRuntime']>;
function lspRuntime(overrides: Partial<LspRuntime> = {}): LspRuntime {
  return {
    enabled: true, overall: 'healthy', pid: 42, node: 'v24', entry: 'daemon', sampledAtMs: Date.now(),
    provisioned: { typescript: true, rust: false, python: false, go: false },
    servers: [{
      language: 'typescript', rootPath: '/repo', taskId: 'server', health: 'healthy',
      coldStartMs: 10, openDocs: 1, pid: 43, everSettled: true, quiescent: true,
      pendingProgress: 0, progressGeneration: 1, certifiedReadiness: ['definition'], unprovenReadiness: [],
    }],
    ...overrides,
  };
}
beforeAll(async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let settlementRecovered = false;
  const controller = new LspAdmissionController({
    enqueue: async () => ({
      start: async () => {},
      finish: async () => {},
      cancel: async () => {
        if (!settlementRecovered) throw new Error('receipt store unavailable');
      },
    }),
  });
  const readRuntime = async () => lspRuntime();
  const read = () => buildLspAdmissionStatePayload('test-lsp-reality', async () => controller.snapshot(), readRuntime);
  const context = {
    workspaceId: 'test-lsp-reality', language: 'typescript', projectRoot: '/repo',
    op: 'references', deadlineAtMs: Date.now() + 10_000,
  };
  lspPayloads.idle = await read();
  const first = controller.run({ ...context, requestId: 'active' }, () => held);
  const abort = new AbortController();
  let queued: Promise<unknown> | undefined;
  try {
    lspPayloads.active = await read();
    queued = controller.run({ ...context, requestId: 'queued', signal: abort.signal }, async () => {});
    const rejected = expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    lspPayloads.pressure = await read();
    abort.abort();
    await rejected;
    await vi.waitFor(() => expect(controller.snapshot().settlementFailures).toHaveLength(1));
    lspPayloads['settlement-failed'] = await read();
    lspPayloads.unknown = await buildLspAdmissionStatePayload('test-lsp-reality', async () => {
      throw new Error('daemon socket unavailable');
    }, readRuntime);
    lspPayloads.stale = await buildLspAdmissionStatePayload('test-lsp-reality', async () => ({
      ...controller.snapshot(), sampledAtMs: Date.now() - 30_001,
    }), readRuntime);
    CONTROLS['lsp.admission'] = ['idle', 'active', 'pressure', 'settlement-failed', 'unknown', 'stale'].map(
      (label) => ({ label, expect: lspPayloads[label]!.assessment }),
    );
  } finally {
    settlementRecovered = true;
    abort.abort();
    release();
    await first;
    await queued?.catch(() => undefined);
    await vi.waitFor(() => expect(controller.snapshot().settlementFailures).toEqual([]), { timeout: 2_000 });
  }
  const runtimeReaders: Record<string, () => Promise<LspRuntime>> = {
    healthy: readRuntime,
    degraded: async () => lspRuntime({ overall: 'degraded' }),
    unhealthy: async () => lspRuntime({ overall: 'unhealthy' }),
    disabled: async () => lspRuntime({ enabled: false }),
    unknown: async () => { throw new Error('health socket unavailable'); },
    stale: async () => lspRuntime({ sampledAtMs: Date.now() - 30_001 }),
    empty: async () => lspRuntime({ servers: [] }),
    unproven: async () => lspRuntime({ servers: [{ ...lspRuntime().servers[0]!, unprovenReadiness: ['references'] }] }),
    pending: async () => lspRuntime({ servers: [{ ...lspRuntime().servers[0]!, pendingProgress: 1 }] }),
    indexing: async () => lspRuntime({ servers: [{ ...lspRuntime().servers[0]!, quiescent: false }] }),
  };
  for (const [label, runtimeReader] of Object.entries(runtimeReaders)) {
    lspRuntimePayloads[label] = await buildLspAdmissionStatePayload(
      'test-lsp-reality', async () => controller.snapshot(), runtimeReader,
    );
  }
  CONTROLS['lsp.warmServers'] = ['healthy', 'degraded', 'unhealthy', 'disabled', 'unknown', 'stale'].map(
    label => ({ label, expect: lspRuntimePayloads[label]!.runtimeAssessment }),
  );
  CONTROLS['lsp.readiness'] = ['healthy', 'unproven', 'pending', 'indexing', 'empty', 'disabled', 'unknown', 'stale'].map(
    label => ({ label, expect: lspRuntimePayloads[label]!.readinessAssessment }),
  );
}, 10_000);

/**
 * Drives the REAL pipeline end to end — deriveDirectiveStatus() then the exported
 * assessDirectiveStatus() — rather than hand-building a DirectiveStatus. Building the
 * status by hand would let a control assert a shape the derivation can no longer
 * produce, which is a truth table about nothing.
 */
const DIRSTAT = (
  directive: DirectiveStatusDirectiveInput,
  linked: readonly DirectiveLinkedWorkItem[] = [],
): string => assessDirectiveStatus(deriveDirectiveStatus(directive, linked));

// The pipeline resolver is deliberately live and comparatively expensive, but every
// row below only inspects a different declaration against one of TWO identical
// request shapes (global or one representative parameter). Re-running the same git
// and gate census for every cell made this file spend minutes in duplicate I/O and
// occasionally exceed an individual 20s row timeout under ordinary contention.
// Share one in-flight snapshot per request shape; evict a rejected read so a genuine
// resolver failure is still retryable by a later row instead of being memoized.
const livePipelinePayloads = new Map<string | undefined, Promise<unknown>>();
async function livePipelinePayload(path?: string) {
  const cached = livePipelinePayloads.get(path);
  if (cached) return cached;
  const pending = Promise.resolve(gitPipelinePosition(path === undefined ? {} : { path }));
  livePipelinePayloads.set(path, pending);
  try {
    return await pending;
  } catch (error) {
    if (livePipelinePayloads.get(path) === pending) livePipelinePayloads.delete(path);
    throw error;
  }
}

/** `limit: 1` — the ROW LIST is irrelevant to a path walk, and the aggregates these
 *  paths read are computed in SQL over the whole population regardless. */
async function liveCoveragePayload(): Promise<unknown> {
  // `.data` — the handler returns a `{ data }` envelope that `dispatchReadOnlyTool`
  // unwraps, and THAT unwrapped object is what readCell walks. Walking the envelope
  // would report every declared path missing at its first segment.
  const result = await (coverageTool as unknown as { handler: (args: unknown) => Promise<{ data: unknown }> }).handler({
    limit: 1,
  });
  return result.data;
}

async function liveHostMemoryPayload(): Promise<unknown> {
  const result = await (
    hostMemoryPressureTool as unknown as {
      handler: (args: unknown, context: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
    }
  ).handler({}, {});
  return JSON.parse(result.content[0].text);
}

async function liveGovernorPayload(): Promise<unknown> {
  const result = await (
    governorStateTool as unknown as {
      handler: (args: unknown, context: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
    }
  ).handler({}, {});
  return JSON.parse(result.content[0].text);
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * THE PERMANENT SYNTHETIC CONTROLS.
 *
 * One table per cell, driving the cell's REAL pure assessor. Each row states the
 * exact code that input must produce, so the table proves BOTH directions at once:
 * every declared code is reachable (producibility), and nothing outside the declared
 * set is emitted (closure).
 *
 * ⚠ THE ROWS ASSERT AN EXACT CODE, NEVER MERELY "some code". That is what makes this
 * a sign detector rather than a coverage checklist — an inverted comparison keeps
 * producing the same SET of codes while mapping them to the wrong inputs, so a table
 * asserting only reachability would stay green through exactly the bug that shipped
 * on `git.mainBehindStaging`.
 *
 * `null` rows are the unavailable branch, and they are not filler: each one is a
 * state the resolver must REFUSE to code, and refusing is what keeps an apparatus
 * failure from being reported as a finding about the subject.
 * ══════════════════════════════════════════════════════════════════════════════ */

type Control = { readonly label: string; readonly expect: string | null };

const LADDER = (committedLocal: boolean, onStaging: boolean, inMain: boolean, deployed: boolean) => ({
  committedLocal,
  onStaging,
  inMain,
  deployed,
});
const PIPE = (over: Partial<Parameters<typeof assessPipelinePosition>[0]>) =>
  assessPipelinePosition({
    targetSha: 'abc1234',
    dirtyUncommitted: false,
    positions: LADDER(true, true, true, true),
    positionsUnknown: [],
    positionsNewerCommit: [],
    servingStartedSinceCodeChange: true,
    ...over,
  });

const GOALOF = (agreement: string, competing: readonly string[] = []) =>
  ({
    ref: 'WI-1',
    source: 'work-item',
    agreement,
    competing,
    corroboratedBy: [],
    declaredAt: '2026-08-24T00:00:00.000Z',
  }) as never;

const OWNERSHIP_NOW_MS = 1_800_000_000_000;
const ownershipAtAge = (ageMs: number): string => new Date(OWNERSHIP_NOW_MS - ageMs).toISOString();

// ⚠ ANNOTATED, not `as const`. An `as const` base narrows every field to its own literal
// (`consecutiveReds: 0`, `repairQueue: null`, `fireStale: false`, `ownership: {…}`), so the
// `Partial<typeof OWNER_BRIEF_BASE>` below REJECTS the very overrides these controls exist to
// make — a RED gate could not be expressed at all, and every red/stalled/unowned control row
// was a type error. Annotating with the resolver's own input type widens the override surface
// to exactly what `composeGateOwnerBrief` accepts, so the rows stay typechecked against the
// real contract instead of against the green base's literals.
const OWNER_BRIEF_BASE: GateOwnerBriefInput = {
  nowMs: 1_000,
  consecutiveReds: 0,
  failingTests: [],
  failingTestsMeasured: true,
  failingTestsProvenance: 'measured',
  mainBehindStaging: false,
  lastGreenAtMs: 1_000,
  verdictObservedAtMs: 1_000,
  fireStale: false,
  verdictStale: false,
  inconclusive: null,
  repairQueue: null,
  ownership: { claimState: 'held', takenBy: 'su-holder', workItem: 'WI-1', assessment: 'held-live' },
};
const OWNER_BRIEF = (over: Partial<typeof OWNER_BRIEF_BASE> = {}) =>
  composeGateOwnerBrief({ ...OWNER_BRIEF_BASE, ...over }).answer;

const CAPACITY_ADMISSION: AdmissionTerms = {
  reachable: true,
  blind: false,
  dispatchBudget: 6,
  inFlight: 0,
};
const CAPACITY_POOL = (over: Partial<ProviderPoolVerdict> = {}): ProviderPoolVerdict => ({
  provider: 'claude',
  total: 7,
  serviceable: 7,
  walledFresh: 0,
  paused: 0,
  pacing: 0,
  unknown: 0,
  atCapacity: false,
  binding: 'none',
  reason: 'assessment reality control',
  ...over,
});
const CAPACITY = (
  pool: Partial<ProviderPoolVerdict> = {},
  admission: AdmissionTerms = CAPACITY_ADMISSION,
) =>
  deriveCapacityVerdict({
    provider: 'claude',
    pool: CAPACITY_POOL(pool),
    admission,
  }).binding;

const ROLE_LAUNCH_ROW = (over: Partial<RoleLaunch> = {}): RoleLaunch => ({
  role: 'worker',
  spawnModel: null,
  model: 'claude-opus-5:xhigh',
  source: 'per-role',
  backend: 'claude-code',
  backendSource: 'model-shape',
  why: 'assessment reality control',
  conflict: null,
  account: null,
  backups: [],
  ...over,
});
const ROLE_LAUNCH = (rows: readonly Partial<RoleLaunch>[]) => roleLaunchVerdict(rows.map((r) => ROLE_LAUNCH_ROW(r)));

/**
 * P-004 control builders. Both call the REAL exported assessor, so a declaration and its
 * resolver cannot drift apart without one of these rows changing — the point of this file.
 */
const CONV_BASE: StoredFrozenRepairConvergence = {
  openedAtMs: 1_000,
  ageMs: 60_000,
  attempts: 1,
  admissionRounds: 2,
  failingFirst: 5,
  failingNow: 2,
  shrinkTotal: 3,
  shrinkPerRound: [
    { round: 1, failingCount: 5, delta: null },
    { round: 2, failingCount: 2, delta: -3 },
  ],
  converging: true,
  candidate: 'c0ffee',
  repairHead: 'deadbeef',
  phase: 'awaiting-fixer',
  observedAtMs: 61_000,
};
const CONV = (over: Partial<StoredFrozenRepairConvergence> | null = {}) =>
  assessFrozenRepairConvergence(over === null ? null : { ...CONV_BASE, ...over });

/** Freshness window is 3h; `NOW` sits just inside it for a record stamped at OBSERVED. */
const FREEZE_OBSERVED = 10_000_000;
const FREEZE_NOW = FREEZE_OBSERVED + 60_000;
const FREEZE = (
  over: Partial<FreezeAndConvergeGateHealth['freezeAndConverge']> | null = {},
  nowMs: number = FREEZE_NOW,
) =>
  assessFreezeDisposition(
    over === null
      ? null
      : {
          enabled: true,
          state: 'held',
          reason: 'control-table reason',
          candidate: 'c0ffee',
          holdUntilMs: null,
          capacityRetryAtMs: null,
          observedAtMs: FREEZE_OBSERVED,
          ...over,
        },
    nowMs,
  );

/**
 * P-009 control builder. `null` is the UNMEASURED reading (both liveness reads failed),
 * distinct from an inactive run — that distinction is the whole point of the cell, so the
 * two must be separate rows rather than one defaulted case.
 */
const RETRIAGE = (over: Partial<RetriageRunReading> | null) =>
  assessRetriage(
    over === null
      ? null
      : {
          active: true,
          inRetriageWindow: true,
          fromCandidate: '79c50b5b7b78',
          candidate: 'd19af1bd60d8',
          refireAttempt: 0,
          maxRefires: 2,
          totalRefires: 1,
          absoluteCeiling: 6,
          asOfAgeMs: 1_000,
          ...over,
        },
  );

const CONTROLS: Record<string, readonly Control[]> = {
  'gate.greenCheckpoint.convergence': [
    { label: 'no readable convergence record', expect: CONV(null) },
    {
      label: 'no automated fixer has run and only the baseline round is recorded',
      expect: CONV({
        attempts: 0,
        admissionRounds: 1,
        failingFirst: 5,
        failingNow: 5,
        shrinkTotal: 0,
        shrinkPerRound: [{ round: 1, failingCount: 5, delta: null }],
        converging: null,
      }),
    },
    {
      label: 'manual repair rounds establish a shrinking trend before automated dispatch',
      expect: CONV({ attempts: 0, converging: true }),
    },
    {
      label: 'manual repair rounds establish a non-shrinking trend before automated dispatch',
      expect: CONV({ attempts: 0, converging: false }),
    },
    {
      label: 'one round only — no trend is knowable yet',
      expect: CONV({
        admissionRounds: 1,
        failingFirst: 5,
        failingNow: 5,
        shrinkTotal: 0,
        shrinkPerRound: [{ round: 1, failingCount: 5, delta: null }],
        converging: null,
      }),
    },
    { label: 'the failing set is shrinking round over round', expect: CONV({ converging: true }) },
    { label: 'rounds recorded but the set is not shrinking', expect: CONV({ converging: false }) },
  ],
  'gate.greenCheckpoint.freezeDisposition': [
    { label: 'no readable disposition', expect: FREEZE(null) },
    {
      label: 'a disposition older than the freshness window',
      expect: FREEZE({ state: 'retired' }, FREEZE_OBSERVED + 4 * 60 * 60 * 1_000),
    },
    { label: 'the owner switched the mechanism off', expect: FREEZE({ state: 'off', enabled: false }) },
    { label: 'on, but nothing was frozen this tick', expect: FREEZE({ state: 'none' }) },
    { label: 'a frozen candidate is being held', expect: FREEZE({ state: 'held' }) },
    { label: 'a frozen candidate was retired this tick', expect: FREEZE({ state: 'retired' }) },
    { label: 'a frozen candidate is being repaired', expect: FREEZE({ state: 'converging' }) },
  ],
  'gate.greenCheckpoint.retriage': [
    { label: 'neither liveness read answered', expect: RETRIAGE(null) },
    { label: 'no checkpoint run is active at all', expect: RETRIAGE({ active: false }) },
    {
      label: 'a run is active but no refire is in flight',
      expect: RETRIAGE({ inRetriageWindow: undefined }),
    },
    { label: 'a refire is in flight with budget remaining', expect: RETRIAGE({}) },
    {
      // Both bounds are checked, so the CEILING alone must reach the cap code: a run whose
      // rescues all SUCCEED holds refireAttempt at 0 forever while totalRefires climbs, and
      // reading the charged counter alone reports budget remaining when there is none.
      label: 'a refire is in flight and the absolute ceiling is spent',
      expect: RETRIAGE({ totalRefires: 6, absoluteCeiling: 6 }),
    },
  ],
  'git.pipelinePosition': [
    { label: 'deployed + process started after the code', expect: PIPE({}) },
    { label: 'deployed but the process predates the code', expect: PIPE({ servingStartedSinceCodeChange: false }) },
    {
      label: 'dirty working tree, nothing committed',
      expect: PIPE({ targetSha: null, dirtyUncommitted: true, positions: LADDER(false, false, false, false) }),
    },
    { label: 'committed, not pushed', expect: PIPE({ positions: LADDER(true, false, false, false) }) },
    { label: 'on staging, not promoted', expect: PIPE({ positions: LADDER(true, true, false, false) }) },
    { label: 'in main, not deployed', expect: PIPE({ positions: LADDER(true, true, true, false) }) },
    { label: 'an unreadable git leg refuses a code', expect: PIPE({ positionsUnknown: ['onStaging'] }) },
    {
      label: 'a broken ladder (deployed but not in main) refuses a code',
      expect: PIPE({ positions: LADDER(true, true, false, true) }),
    },
    { label: 'an unprobeable process refuses a code', expect: PIPE({ servingStartedSinceCodeChange: null }) },
  ],
  'gate.greenCheckpoint.verdict': [
    {
      label: 'a run ended with no verdict',
      expect: assessGateVerdict({
        inconclusive: { status: 'cancelled' },
        consecutiveReds: 9,
        verdictStale: false,
        fireStale: false,
        mainBehindStaging: false,
        verdictUnknownLegs: [],
      }),
    },
    {
      label: 'a repair hold whose current repair head was measured red',
      expect: assessGateVerdict({
        inconclusive: { status: 'repair-in-progress' },
        consecutiveReds: 1,
        verdictStale: false,
        fireStale: false,
        mainBehindStaging: true,
        verdictUnknownLegs: [],
        repairHeadVerdict: 'full-gate-red',
      }),
    },
    {
      label: 'reds, judged against a superseded candidate',
      expect: assessGateVerdict({
        inconclusive: null,
        consecutiveReds: 3,
        verdictStale: true,
        fireStale: false,
        mainBehindStaging: true,
        verdictUnknownLegs: [],
      }),
    },
    {
      label: 'reds about the current candidate',
      expect: assessGateVerdict({
        inconclusive: null,
        consecutiveReds: 3,
        verdictStale: false,
        fireStale: false,
        mainBehindStaging: true,
        verdictUnknownLegs: [],
      }),
    },
    {
      label: 'zero reds because the gate never fired',
      expect: assessGateVerdict({
        inconclusive: null,
        consecutiveReds: 0,
        verdictStale: false,
        fireStale: true,
        mainBehindStaging: true,
        verdictUnknownLegs: [],
      }),
    },
    {
      label: 'green, with the normal staging buffer',
      expect: assessGateVerdict({
        inconclusive: null,
        consecutiveReds: 0,
        verdictStale: false,
        fireStale: false,
        mainBehindStaging: true,
        verdictUnknownLegs: [],
      }),
    },
    {
      label: 'green and level with staging',
      expect: assessGateVerdict({
        inconclusive: null,
        consecutiveReds: 0,
        verdictStale: false,
        fireStale: false,
        mainBehindStaging: false,
        verdictUnknownLegs: [],
      }),
    },
    {
      label: 'an unmeasured red counter refuses a code',
      expect: assessGateVerdict({
        inconclusive: null,
        consecutiveReds: 0,
        verdictStale: false,
        fireStale: false,
        mainBehindStaging: false,
        verdictUnknownLegs: ['gate.consecutiveReds'],
      }),
    },
  ],
  'gate.greenCheckpoint.candidate': [
    {
      // EI-21862849770458561: EXPLICITLY measured absence (checkpointRunInFlight: { active:
      // false }) — distinct from the "unmeasured" control appended below, which omits the
      // field and used to fall through to this same 'no-active-run' code by mistake.
      label: 'no run in flight',
      expect: assessGateCandidate({
        judgingSha: null,
        verdictUnknownLegs: [],
        checkpointRunInFlight: { active: false },
      }),
    },
    {
      label: 'run active before its candidate is published',
      expect: assessGateCandidate({
        judgingSha: null,
        verdictUnknownLegs: [],
        checkpointRunInFlight: { active: true },
      }),
    },
    {
      label: 'a candidate read from a non-authoritative probe',
      expect: assessGateCandidate({ judgingSha: 'abc', judgingShaSource: 'run-probe', verdictUnknownLegs: [] }),
    },
    {
      label: 'a marker-backed candidate containing this path',
      expect: assessGateCandidate({
        judgingSha: 'abc',
        judgingShaSource: 'retriage-marker',
        judgingContainsPath: true,
        verdictUnknownLegs: [],
      }),
    },
    {
      label: 'a marker-backed candidate NOT containing this path',
      expect: assessGateCandidate({
        judgingSha: 'abc',
        judgingShaSource: 'retriage-marker',
        judgingContainsPath: false,
        verdictUnknownLegs: [],
      }),
    },
    {
      label: 'an unresolved containment verdict refuses a code',
      expect: assessGateCandidate({
        judgingSha: 'abc',
        judgingShaSource: 'retriage-marker',
        judgingContainsPath: null,
        verdictUnknownLegs: [],
      }),
    },
    {
      // EI-21862849770458561: checkpointRunInFlight is omitted (unmeasured — neither cache
      // nor live-lock answered), never a measured "not running". Must be `null`, not
      // 'no-active-run' — the exact conflation this fix closes.
      label: 'unmeasured checkpointRunInFlight is unknown, not a measured no-active-run',
      expect: assessGateCandidate({ judgingSha: null, verdictUnknownLegs: [] }),
    },
    // main-green-status-visible-2026-09-03 P-011 follow-up (grader card EI-22277841040474660
    // C5): between runs a FROZEN repair queue is the authoritative judged sha, so the
    // per-path containment verdict gets its own two codes instead of 'no-active-run'.
    {
      label: 'frozen repair queue between runs, candidate contains this path',
      expect: assessGateCandidate({
        judgingSha: 'abc',
        judgingShaSource: 'repair-queue',
        judgingContainsPath: true,
        verdictUnknownLegs: [],
        checkpointRunInFlight: { active: false },
      }),
    },
    {
      label: 'frozen repair queue between runs, candidate does NOT contain this path',
      expect: assessGateCandidate({
        judgingSha: 'abc',
        judgingShaSource: 'repair-queue',
        judgingContainsPath: false,
        verdictUnknownLegs: [],
        checkpointRunInFlight: { active: false },
      }),
    },
  ],
  'gate.greenCheckpoint.candidateFailures': [
    { label: 'no frozen candidate', expect: 'no-frozen-candidate' },
    { label: 'frozen candidate failures could not be measured', expect: 'unmeasured' },
    { label: 'all candidate fixes already contained', expect: 'all-fixes-contained' },
    { label: 'at least one repair remains outstanding', expect: 'repairs-outstanding' },
    { label: 'no failing files in the judged radius', expect: 'none-failing' },
    // main-green-status-visible-2026-09-03 P-007: `assessCandidateFailures` is the exported
    // pure rule, so this row is computed rather than quoted.
    {
      label: 'no test file broken but a non-test leg is red with no landed fix',
      expect: assessCandidateFailures({ fileCount: 0, stillBrokenCount: 0, alreadyFixedCount: 0, passedAtRepairHeadCount: 0, outstandingLegs: 1, fixedLegs: 0, staleUnadmittedLegs: 0 }),
    },
  ],
  'gate.greenCheckpoint.ownerBrief': [
    { label: 'green gate', expect: OWNER_BRIEF() },
    {
      label: 'green verdict with an ordinary post-absorption staging buffer',
      expect: OWNER_BRIEF({
        mainBehindStaging: true,
        promotion: {
          judgedSha: 'judged',
          mainPin: 'main',
          mainContainsJudgedSha: true,
          stagingHead: 'staging',
          stagingContainsMainPin: true,
          stagingContainsJudgedSha: true,
          stagingBufferPresent: true,
        },
      }),
    },
    {
      label: 'green verdict whose exact judged SHA is absent from the writer-owned main pin',
      expect: OWNER_BRIEF({
        mainBehindStaging: false,
        promotion: {
          judgedSha: 'judged',
          mainPin: 'main',
          mainContainsJudgedSha: false,
          stagingHead: 'main',
          stagingContainsMainPin: true,
          stagingContainsJudgedSha: false,
          stagingBufferPresent: false,
        },
      }),
    },
    { label: 'red with live remediation', expect: OWNER_BRIEF({ consecutiveReds: 1, repairQueue: { phase: 'awaiting-fixer', attempts: 1, updatedAtMs: 900, ageMs: 100, fixerSpawnId: 's-fixer', fixerAlive: true, zeroAttemptStalled: false } }) },
    { label: 'red with stalled remediation', expect: OWNER_BRIEF({ consecutiveReds: 1, repairQueue: { phase: 'awaiting-fixer', attempts: 1, updatedAtMs: 900, ageMs: 100, fixerSpawnId: 's-fixer', fixerAlive: false, zeroAttemptStalled: false } }) },
    { label: 'red with an unconfirmed holder and no fixer ever dispatched', expect: OWNER_BRIEF({ consecutiveReds: 1, ownership: { claimState: 'held', takenBy: 'su-stranded', workItem: 'WI-1', assessment: 'held-needs-confirmation' } as never, repairQueue: { phase: 'awaiting-fixer', attempts: 0, updatedAtMs: 900, ageMs: 100, fixerSpawnId: null, fixerAlive: null, zeroAttemptStalled: true } }) },
    { label: 'red with no owner', expect: OWNER_BRIEF({ consecutiveReds: 1, ownership: null }) },
    { label: 'inconclusive attempt rendered no verdict', expect: OWNER_BRIEF({ consecutiveReds: 0, failingTestsMeasured: false, failingTestsProvenance: 'not-measured', inconclusive: { status: 'migrations-pending', detail: 'preflight stopped before judgment', observedAtMs: 900 } }) },
    { label: 'gate not judging', expect: OWNER_BRIEF({ fireStale: true }) },
    { label: 'verdict unmeasured', expect: OWNER_BRIEF({ consecutiveReds: null }) },
  ],
  'gate.greenCheckpoint.ownership': [
    {
      label: 'two work-items claim the condition',
      expect: assessGateOwnership({ claimState: 'held', holderSessionState: 'live', duplicates: ['WI-1', 'WI-2'] }),
    },
    {
      label: 'no owning object exists',
      expect: assessGateOwnership({ claimState: 'no-object', holderSessionState: null, duplicates: [] }),
    },
    {
      label: 'an owning item nobody holds',
      expect: assessGateOwnership({ claimState: 'claimable', holderSessionState: null, duplicates: [] }),
    },
    {
      label: 'an owning item deliberately held out of claim',
      expect: assessGateOwnership({ claimState: 'hold-blocked', holderSessionState: null, duplicates: [] }),
    },
    {
      label: 'the lease lapsed',
      expect: assessGateOwnership({ claimState: 'lease-expired', holderSessionState: null, duplicates: [] }),
    },
    {
      label: 'held by a live session',
      expect: assessGateOwnership({ claimState: 'held', holderSessionState: 'live', duplicates: [] }),
    },
    {
      label: 'held by a live session whose item progress lease expired',
      expect: assessGateOwnership({
        claimState: 'held',
        holderSessionState: 'live',
        duplicates: [],
        takenAt: ownershipAtAge(CRITICAL_CLAIM_PROGRESS_LEASE_MS + 1),
        lastProgressAt: ownershipAtAge(CRITICAL_CLAIM_PROGRESS_LEASE_MS + 1),
        nowMs: OWNERSHIP_NOW_MS,
      }),
    },
    /**
     * D-018's sign-flip, pinned as its own row. `recorded` is authoritatively ALIVE
     * per the session log — the verdict helper that shipped in P-005 counted it as a
     * DEAD holder and therefore reported live holders as abandoned claims. A table
     * that only exercised `live` would pass through that bug unchanged.
     */
    {
      label: 'held by a `recorded` session — ALIVE, not abandoned (D-018)',
      expect: assessGateOwnership({ claimState: 'held', holderSessionState: 'recorded', duplicates: [] }),
    },
    {
      label: 'held by an ambiguous (draining) session',
      expect: assessGateOwnership({ claimState: 'held', holderSessionState: 'draining', duplicates: [] }),
    },
    {
      label: 'held by a session the oracle confirms ended',
      expect: assessGateOwnership({ claimState: 'held', holderSessionState: 'ended', duplicates: [] }),
    },
    {
      label: 'an unreadable claim store refuses a code',
      expect: assessGateOwnership({ claimState: null, holderSessionState: 'live', duplicates: [] }),
    },
  ],
  'gate.greenCheckpoint.qualification': [
    { label: 'ready logical attempt', expect: 'launch-physical-run' },
    { label: 'request-time clear with fail-closed candidate preflights pending', expect: 'launch-preflight-runner' },
    { label: 'typed infrastructure blocker', expect: 'await-blocker-events' },
    { label: 'live physical-run lease', expect: 'await-current-run' },
    { label: 'expired lease with unproven runner liveness', expect: 'inspect-runner-liveness' },
    { label: 'expired physical-run lease', expect: 'recover-expired-runner' },
    { label: 'terminal real red', expect: 'repair-code' },
    { label: 'terminal code-inconclusive', expect: 'inspect-terminal-evidence' },
    { label: 'no attempt or completed green', expect: 'read-release-control' },
  ],
  'deploy.3070.sha': [
    {
      label: 'a sha is deployed and the process started after it',
      expect: assessDeployedSha({ deployedSha: 'abc', servingStartedSinceCodeChange: true, verdictUnknownLegs: [] }),
    },
    {
      label: 'a sha is deployed but the process predates it',
      expect: assessDeployedSha({ deployedSha: 'abc', servingStartedSinceCodeChange: false, verdictUnknownLegs: [] }),
    },
    {
      label: 'the serving probe was attempted and did not answer',
      expect: assessDeployedSha({
        deployedSha: 'abc',
        servingStartedSinceCodeChange: null,
        servingUnknownCode: 'resolver-failed',
        verdictUnknownLegs: [],
      }),
    },
    /**
     * WI-2141716. The row above and this one both have a null serving boolean, and they
     * are NOT the same state: there the probe ran and failed, so retrying is the lever;
     * here no probe was attempted and none can be (a sha-only read names no path), so
     * retrying is futile forever. They earn separate codes because they earn separate
     * ACTIONS — collapsing them shipped a "re-probe" instruction for an unanswerable
     * question and cost one agent session a day of re-reads.
     */
    {
      label: 'no serving process can be identified, so no probe was attempted',
      expect: assessDeployedSha({
        deployedSha: 'abc',
        servingStartedSinceCodeChange: null,
        servingUnknownCode: 'not-applicable',
        verdictUnknownLegs: [],
      }),
    },
    /**
     * ⚠ A null sha is a FAILED READ of the release checkout's HEAD, never "nothing is
     * deployed" — the inference the resolver used to make and P-007 corrected.
     */
    {
      label: 'an unreadable release HEAD refuses a code (it is NOT "nothing deployed")',
      expect: assessDeployedSha({ deployedSha: null, servingStartedSinceCodeChange: true, verdictUnknownLegs: [] }),
    },
  ],
  'git.mainBehindStaging': [
    {
      label: 'main is level with staging',
      expect: assessMainBehindStaging({ mainBehindStaging: false, fireStale: false, verdictUnknownLegs: [] }),
    },
    {
      label: 'behind, gate still firing — the normal steady state',
      expect: assessMainBehindStaging({ mainBehindStaging: true, fireStale: false, verdictUnknownLegs: [] }),
    },
    {
      label: 'behind AND the gate is not firing',
      expect: assessMainBehindStaging({ mainBehindStaging: true, fireStale: true, verdictUnknownLegs: [] }),
    },
    {
      label: 'an unresolved branch tip refuses a code',
      expect: assessMainBehindStaging({ mainBehindStaging: null, fireStale: false, verdictUnknownLegs: [] }),
    },
  ],
  'goal.portfolioThroughput': [
    { label: 'placing', expect: portfolioAssessmentFor('placing') },
    { label: 'within grace', expect: portfolioAssessmentFor('within-grace') },
    { label: 'idle past threshold', expect: portfolioAssessmentFor('idle') },
    { label: 'not held', expect: portfolioAssessmentFor('not-held') },
    { label: 'ledger evidence unavailable', expect: portfolioAssessmentFor('not-measured') },
  ],
  'host.memoryPressure': [
    {
      label: 'PSI at the critical threshold',
      expect: assessHostMemoryPressure({ pressure: 'crit', stale: false, unknownCount: 0, memFreePct: 80 }),
    },
    {
      label: 'PSI at the warning threshold',
      expect: assessHostMemoryPressure({ pressure: 'warn', stale: false, unknownCount: 0, memFreePct: 80 }),
    },
    {
      label: 'reclaim stable, free capacity below the warning threshold',
      expect: assessHostMemoryPressure({ pressure: 'ok', stale: false, unknownCount: 0, memFreePct: 5 }),
    },
    {
      label: 'reclaim stable with ample free capacity',
      expect: assessHostMemoryPressure({ pressure: 'ok', stale: false, unknownCount: 0, memFreePct: 80 }),
    },
    {
      label: 'a stale capture refuses a code',
      expect: assessHostMemoryPressure({ pressure: 'ok', stale: true, unknownCount: 0, memFreePct: 80 }),
    },
    {
      label: 'a missing PSI leg refuses a code',
      expect: assessHostMemoryPressure({ pressure: 'ok', stale: false, unknownCount: 1, memFreePct: 80 }),
    },
  ],
  'memory.cgroupAttribution': [
    { label: 'critical pressure context', expect: 'crit' },
    { label: 'warning pressure context', expect: 'warn' },
    { label: 'stable pressure context', expect: 'ok' },
    { label: 'unmeasured pressure context', expect: null },
  ],
  'agent.goal': [
    { label: 'the agent holds nothing', expect: assessAgentGoal(null, []) },
    { label: 'a corroborated ref', expect: assessAgentGoal(GOALOF('corroborated'), []) },
    { label: 'a ref with a single source', expect: assessAgentGoal(GOALOF('sole'), []) },
    { label: 'sources disagree', expect: assessAgentGoal(GOALOF('divergent'), []) },
    /**
     * Competing claims OUTRANK a corroborating edge — the measured case (3 of 19
     * holders held two work-items at once) that the precedence rule alone cannot see.
     */
    {
      label: 'corroborated BUT competing claims exist — competing wins',
      expect: assessAgentGoal(GOALOF('corroborated', ['WI-2']), []),
    },
    {
      label: 'a failed resolver leg refuses a code',
      // A REAL diagnostic shape, not a bare `{}` — the assessor branches on
      // `diagnostics.length`, so a cast-away stub would pass while proving the wrong
      // thing if that ever narrows to inspect the leg.
      expect: assessAgentGoal(GOALOF('corroborated'), [
        { leg: 'store', status: 'unavailable', detail: 'the goal store was unreachable on this read' },
      ]),
    },
  ],
  'testing.census.population': [
    {
      label: 'no provider was ever registered',
      expect: assessTestingCensusPopulation({ surfaces: 0, providersRegistered: 0, lastCensusAt: null }),
    },
    {
      label: 'providers registered, census never ran',
      expect: assessTestingCensusPopulation({ surfaces: 0, providersRegistered: 1, lastCensusAt: null }),
    },
    {
      label: 'the census ran and honestly found nothing',
      expect: assessTestingCensusPopulation({
        surfaces: 0,
        providersRegistered: 1,
        lastCensusAt: '2026-08-24T00:00:00.000Z',
      }),
    },
    {
      label: 'a non-empty population',
      expect: assessTestingCensusPopulation({ surfaces: 12, providersRegistered: 1, lastCensusAt: null }),
    },
  ],
  'testing.coverage.floor': [
    {
      label: 'no denominator — the census enumerated zero surfaces',
      expect: assessTestingCoverageFloor({ verdict: 'measured', surfaces: 0, below: 0, belowUnwaived: 0, evidenced: 0 }),
    },
    {
      label: 'unwaived gaps below the floor',
      expect: assessTestingCoverageFloor({ verdict: 'measured', surfaces: 10, below: 2, belowUnwaived: 2, evidenced: 10 }),
    },
    {
      label: 'gaps exist but every one is waived',
      expect: assessTestingCoverageFloor({ verdict: 'measured', surfaces: 10, below: 2, belowUnwaived: 0, evidenced: 10 }),
    },
    {
      label: 'every surface meets the floor',
      expect: assessTestingCoverageFloor({ verdict: 'measured', surfaces: 10, below: 0, belowUnwaived: 0, evidenced: 10 }),
    },
    {
      label: 'gaps below the floor, but nothing was ever measured about them (P-008)',
      expect: assessTestingCoverageFloor({ verdict: 'measured', surfaces: 10, below: 10, belowUnwaived: 10, evidenced: 0 }),
    },
  ],
  'governor.health': [
    { label: 'healthy snapshot', expect: 'healthy' },
    { label: 'degraded snapshot', expect: 'degraded' },
    { label: 'unmeasured snapshot', expect: 'unknown' },
  ],
  'governor.admission': [
    { label: 'ordinary admission open', expect: 'open' },
    { label: 'one class constrained', expect: 'constrained' },
    { label: 'one class paused', expect: 'paused' },
    { label: 'unmeasured snapshot', expect: 'unknown' },
  ],
  'governor.queue': [
    { label: 'measured empty queue', expect: 'empty' },
    { label: 'drain rate meets arrivals', expect: 'draining' },
    { label: 'arrivals exceed drain', expect: 'growing' },
    { label: 'unmeasured snapshot', expect: 'unknown' },
  ],
  'governor.resources': [
    { label: 'no constrained resource', expect: 'unconstrained' },
    { label: 'one constrained resource', expect: 'constrained' },
    { label: 'unmeasured snapshot', expect: 'unknown' },
  ],
  'governor.recovery': [
    { label: 'stable state', expect: 'stable' },
    { label: 'active recovery', expect: 'recovering' },
    { label: 'stalled recovery', expect: 'stalled' },
    { label: 'unmeasured snapshot', expect: 'unknown' },
  ],
  'capacity.verdict': [
    {
      label: 'provider pool measurably usage-walled',
      expect: CAPACITY({
        serviceable: 0,
        walledFresh: 7,
        atCapacity: true,
        binding: 'usage-wall',
      }),
    },
    {
      label: 'gateway admission window has no spare slot',
      expect: CAPACITY({}, { reachable: true, blind: false, dispatchBudget: 0, inFlight: 12 }),
    },
    {
      label: 'burn governor is pacing an otherwise serviceable pool',
      expect: CAPACITY({ serviceable: 0, pacing: 7, atCapacity: true, binding: 'pacing-policy' }),
    },
    { label: 'both measured legs are clear', expect: CAPACITY() },
  ],
  'agent.roleLaunch': [
    { label: 'every reported role resolves without conflict', expect: ROLE_LAUNCH([{}]) },
    {
      label: "a role's configured roleBackends disagrees with its resolved backend",
      expect: ROLE_LAUNCH([
        { conflict: { configured: 'codex', effective: 'claude-code', note: 'assessment reality control' } },
      ]),
    },
    { label: 'a role has no determinable backend', expect: ROLE_LAUNCH([{ backend: null, backendSource: 'inherit' }]) },
  ],
  // WI-2145092. The third row is the one that matters: an ENFORCE row with an EMPTY allow-list
  // confines nothing (isWorkScopeEnforced is false, every gate is inert), so it must read `off`
  // — a reader who saw `enforce` there would believe a fence that is not standing.
  'workspace.workScope': [
    { label: 'no policy row is stored', expect: assessWorkScope(null) },
    { label: 'a row with mode off', expect: assessWorkScope({ mode: 'off', allowHarnesses: ['papercusp'] }) },
    { label: 'an enforce row whose allow-list is empty confines nothing', expect: assessWorkScope({ mode: 'enforce', allowHarnesses: [] }) },
    { label: 'an enforce row with an allow-list', expect: assessWorkScope({ mode: 'enforce', allowHarnesses: ['papercusp', 'papercusp/*'] }) },
  ],
  // directive-visibility-and-ownership-2026-09-22 P-007. Row 2 is the one that matters:
  // it is the measured D-007 shape — still `unclaimed`, but ONLY because every linked
  // item is terminal and nobody recorded a disposition. Reading that as `open-unworked`
  // is what made directives #86/#87 render "promote or dismiss" forever, so a control
  // that could not tell those two apart would re-admit exactly that bug.
  'owner.directive.status': [
    { label: 'never claimed, no linked work-item ever', expect: DIRSTAT({ dispositionStatus: null }) },
    {
      label: 'worked but never dispositioned — every linked item is terminal',
      expect: DIRSTAT({ dispositionStatus: null }, [{ id: 'WI-1', state: 'done' }]),
    },
    {
      label: 'a non-terminal linked item is held',
      expect: DIRSTAT({ dispositionStatus: null }, [{ id: 'WI-2', state: 'wip', assignee: 'su-a' }]),
    },
    { label: 'a done disposition was recorded', expect: DIRSTAT({ dispositionStatus: 'done', dispositionedAtMs: 1 }) },
    {
      label: 'a declined disposition is equally terminal',
      expect: DIRSTAT({ dispositionStatus: 'declined', dispositionedAtMs: 1 }),
    },
  ],
  // verification-system-improvements-2026-10-10 P-002. The real assessor over the two
  // readings it decides on; the breach-outranks-unmeasured row pins the precedence.
  'verification.health': [
    { label: 'a thresholded reading is breached', expect: assessVerificationHealth({ breaches: 1, unmeasuredCodes: [] }) },
    {
      label: 'a breach outranks an unmeasured reading',
      expect: assessVerificationHealth({ breaches: 1, unmeasuredCodes: ['triageGaps'] }),
    },
    {
      label: 'nothing breached, but a thresholded reading is unmeasured',
      expect: assessVerificationHealth({ breaches: 0, unmeasuredCodes: ['staleAcceptanceUndispositioned'] }),
    },
    {
      label: 'every thresholded reading measured and within threshold',
      expect: assessVerificationHealth({ breaches: 0, unmeasuredCodes: [] }),
    },
  ],
  // bug-inflow-one-problem-one-row-2026-10-18 P-007. Both stale reasons get a row: a missing
  // today and an over-age newest row are separate ways the writer falls behind.
  'work.bugInflow': [
    { label: 'today is stored and the newest row is fresh', expect: BUG_INFLOW(BUG_INFLOW_FRESH).assessment },
    {
      label: 'stored days exist but today has no row',
      expect: BUG_INFLOW([bugInflowRow('2026-10-19', 10 * 60_000)]).assessment,
    },
    {
      label: "today's row is older than the staleness bound",
      expect: BUG_INFLOW([bugInflowRow('2026-10-20', BUG_INFLOW_STALE_AFTER_MS + 60_000)]).assessment,
    },
    { label: 'no stored row anywhere in the window', expect: BUG_INFLOW([]).assessment },
  ],
};

/**
 * The code each control row is EXPECTED to produce, kept beside the table rather than
 * inside it so a reviewer can read the mapping without evaluating calls. Index-aligned
 * to CONTROLS; the partition test below proves the alignment rather than assuming it.
 */
const EXPECTED: Record<string, readonly (string | null)[]> = {
  // P-004 truth table. Zero automated attempts is a dispatch fact, not proof that no manual
  // measurement happened. `no-attempts` applies only while the recorded rounds have no trend;
  // once a manual lineage establishes one, the convergence result takes precedence.
  'gate.greenCheckpoint.convergence': [
    'no-cycle-recorded',
    'no-attempts',
    'converging',
    'not-converging',
    'not-yet-knowable',
    'converging',
    'not-converging',
  ],
  // Staleness OUTRANKS the state it qualifies — row 2 is a `retired` read 4h after it was
  // observed, and it must NOT surface as `retired`.
  'gate.greenCheckpoint.freezeDisposition': [
    'no-disposition-recorded',
    'stale',
    'off',
    'none',
    'held',
    'retired',
    'converging',
  ],
  // P-009 truth table. `no-run-reading` is FIRST and is NOT `no-run`: the unmeasured reading
  // is the one that must still hold a caller back, and collapsing it into the measured
  // negative is the destructive green-light this cell exists to withhold. (Named
  // `no-run-reading` rather than `not-measured` because the latter is reserved by the
  // read-health vocabulary — a produced code may not reuse one, per D-008.)
  'gate.greenCheckpoint.retriage': [
    'no-run-reading',
    'no-run',
    'no-refire',
    'in-flight',
    'in-flight-at-cap',
  ],
  'git.pipelinePosition': [
    'live',
    'restart-required',
    'uncommitted',
    'awaiting-push',
    'awaiting-gate',
    'awaiting-deploy',
    null,
    null,
    null,
  ],
  'gate.greenCheckpoint.verdict': [
    'inconclusive',
    'repair-head-red',
    'red-stale',
    'red-current',
    'not-firing',
    'passing-buffered',
    'passing-current',
    null,
  ],
  'gate.greenCheckpoint.candidate': [
    'no-active-run',
    'candidate-not-yet-published',
    'inferred-candidate',
    'judging-current-path',
    'judging-without-current-path',
    null,
    // EI-21862849770458561: the unmeasured-checkpointRunInFlight control appended above.
    null,
    // P-011 follow-up: the two frozen-repair-queue controls appended above.
    'frozen-candidate-contains-path',
    'frozen-candidate-without-path',
  ],
  // Index-aligned to the CONTROLS rows above. `readGateCandidateFailures` computes its
  // assessment inline (it is one branch of an async, git+PG-reading resolver rather than a
  // separately-exported pure function), so these rows name the codes that resolver emits —
  // gate-candidate-failures.ts:267 no-frozen-candidate, :315/:385 unmeasured, :377
  // none-failing, :379 repairs-outstanding, :381 all-fixes-contained.
  'gate.greenCheckpoint.candidateFailures': [
    'no-frozen-candidate',
    'unmeasured',
    'all-fixes-contained',
    'repairs-outstanding',
    'none-failing',
    // P-007: the leg-red code, computed by the exported rule above.
    'non-test-leg-failing',
  ],
  'gate.greenCheckpoint.ownerBrief': [
    'green',
    'green',
    'green-not-promoted',
    'red-owned-remediating',
    'red-owned-stalled',
    'red-owned-unconfirmed',
    'red-unowned',
    'no-verdict',
    'not-judging',
    'unknown',
  ],
  'gate.greenCheckpoint.ownership': [
    'duplicate-owners',
    'unowned',
    'claimable',
    'hold-blocked',
    'lease-expired',
    'held-live',
    'held-stalled',
    'held-live',
    'held-needs-confirmation',
    'held-by-ended-session',
    null,
  ],
  'gate.greenCheckpoint.qualification': [
    'launch-physical-run',
    'launch-preflight-runner',
    'await-blocker-events',
    'await-current-run',
    'inspect-runner-liveness',
    'recover-expired-runner',
    'repair-code',
    'inspect-terminal-evidence',
    'read-release-control',
  ],
  'deploy.3070.sha': [
    'executing',
    'restart-required',
    'process-unverified',
    'serving-not-probeable',
    null,
  ],
  'git.mainBehindStaging': ['caught-up', 'normal-buffer', 'gate-stalled', null],
  // `portfolioAssessmentFor` maps the resolver's verdict REASON onto the cell's code
  // vocabulary, and the two are deliberately not the same words: reason `idle` codes as
  // `idle-past-threshold` and reason `not-measured` codes as `evidence-unavailable` (the
  // latter on purpose — `not-measured` is a CellUnknownCode, so reusing it would collapse
  // "the ledger was unreadable" into "the apparatus failed").
  'goal.portfolioThroughput': [
    'placing',
    'within-grace',
    'idle-past-threshold',
    'not-held',
    'evidence-unavailable',
  ],
  'host.memoryPressure': ['critical', 'warning', 'stable-low-free', 'stable', null, null],
  'memory.cgroupAttribution': ['crit', 'warn', 'ok', null],
  'agent.goal': ['nothing-held', 'corroborated', 'sole', 'divergent', 'divergent', null],
  'testing.census.population': ['no-providers', 'census-not-run', 'empty-measured', 'populated'],
  'testing.coverage.floor': [
    'no-population',
    'below-floor',
    'measured-with-waivers',
    'meets-floor',
    'no-evidence',
  ],
  'governor.health': ['healthy', 'degraded', 'unknown'],
  'governor.admission': ['open', 'constrained', 'paused', 'unknown'],
  'governor.queue': ['empty', 'draining', 'growing', 'unknown'],
  'governor.resources': ['unconstrained', 'constrained', 'unknown'],
  'governor.recovery': ['stable', 'recovering', 'stalled', 'unknown'],
  'lsp.admission': ['idle', 'active', 'pressure', 'settlement-failed', 'unknown', 'unknown'],
  'lsp.warmServers': ['healthy', 'degraded', 'unhealthy', 'unknown', 'unknown', 'unknown'],
  'lsp.readiness': ['reported', 'unproven', 'unproven', 'unproven', 'unknown', 'unknown', 'unknown', 'unknown'],
  'capacity.verdict': ['usage-wall', 'admission-concurrency', 'pacing-policy', 'none'],
  'agent.roleLaunch': ['consistent', 'conflicted', 'undetermined'],
  'workspace.workScope': ['absent', 'off', 'off', 'enforce'],
  'owner.directive.status': [
    'open-unworked',
    'worked-awaiting-disposition',
    'in-flight',
    'settled',
    'settled',
  ],
  'verification.health': ['breached', 'breached', 'unmeasured', 'healthy'],
  'work.bugInflow': ['measured', 'stale', 'stale', 'unmeasured'],
};

describe('P-004: the built-in partition — every cell is assessed, with no residue', () => {
  /**
   * NON-VACUITY, and it is load-bearing rather than ceremony. P-009 found that every
   * scanning guard on this plane mutation-tested its predicate while asserting NOTHING
   * about the size of its corpus — so a filter that silently matched nothing left the
   * suite green with zero cells examined. The plan item demands an EXPLICIT ten-of-ten
   * partition with zero residue, and this is it.
   */
  // ⚠ The prose count in this title used to name a number and drifted the moment a cell was
  // added (it said "twenty-two" while asserting 24). The literals below are the tripwire —
  // they must stay hardcoded so adding a cell forces an author through this file — but the
  // TITLE must not carry a second copy of them.
  it('registers every built-in cell and routes every one to a resolver family', () => {
    expect(BUILTIN_CELLS).toHaveLength(32);
    expect(
      PIPELINE_CELLS.length +
        GOAL_CELLS.length +
        PORTFOLIO_CELLS.length +
        HOST_MEMORY_CELLS.length +
        COVERAGE_CELLS.length +
        GOVERNOR_CELLS.length +
        CAPACITY_CELLS.length +
        ROLE_LAUNCH_CELLS.length +
        WORK_SCOPE_CELLS.length +
        DIRECTIVE_CELLS.length +
        GATE_OWNERSHIP_CELLS.length +
        LSP_ADMISSION_CELLS.length +
        VERIFICATION_HEALTH_CELLS.length +
        WORK_BUG_INFLOW_CELLS.length,
    ).toBe(BUILTIN_CELLS.length);
    expect(PIPELINE_CELLS).toHaveLength(11);
    expect(GOAL_CELLS).toHaveLength(1);
    expect(PORTFOLIO_CELLS).toHaveLength(1);
    expect(HOST_MEMORY_CELLS).toHaveLength(2);
    expect(COVERAGE_CELLS).toHaveLength(2);
    expect(GOVERNOR_CELLS).toHaveLength(5);
    expect(CAPACITY_CELLS).toHaveLength(1);
    expect(ROLE_LAUNCH_CELLS).toHaveLength(1);
    expect(WORK_SCOPE_CELLS).toHaveLength(1);
    expect(DIRECTIVE_CELLS).toHaveLength(1);
    expect(GATE_OWNERSHIP_CELLS).toHaveLength(1);
    expect(LSP_ADMISSION_CELLS).toHaveLength(3);
    expect(VERIFICATION_HEALTH_CELLS).toHaveLength(1);
    expect(WORK_BUG_INFLOW_CELLS).toHaveLength(1);
  });

  /**
   * ⚠ THE RESIDUE CHECK, and it is what makes P-006 safe to attempt. `CellSpec.assessment`
   * is OPTIONAL until the cutover (D-011 rule 1), so a cell that never migrated would
   * register happily and answer `unavailable` forever — indistinguishable, to a reader,
   * from a cell that honestly could not assess itself. This is the only assertion that
   * separates "not migrated" from "measured and unavailable".
   */
  it('leaves NO cell without an assessment — a value-bearing cell without one is unfinished', () => {
    const missing = BUILTIN_CELLS.filter((c) => c.assessment === undefined).map((c) => c.cell);
    expect(missing, `these cells still carry no assessment declaration: ${missing.join(', ') || '(none)'}`).toEqual([]);
  });

  /** Every cell has a control table, and every table is aligned with its expectations. */
  it('gives every cell a permanent synthetic control table', () => {
    for (const spec of BUILTIN_CELLS) {
      const rows = CONTROLS[spec.cell];
      const expected = EXPECTED[spec.cell];
      expect(rows, `${spec.cell} has no control table — its codes are unproven`).toBeDefined();
      expect(expected, `${spec.cell} has no expectation list`).toBeDefined();
      expect(rows!.length, `${spec.cell}: control rows and expectations are misaligned`).toBe(expected!.length);
      expect(rows!.length, `${spec.cell}: a control table needs more than one row to show movement`).toBeGreaterThan(1);
    }
  });
});

describe('P-004: every declared assessment path exists in a LIVE resolver payload', () => {
  describe('dev:pipeline_position payloads', () => {
    // These rows prove schema paths, not request latency. Fetch the two REAL
    // request shapes once, concurrently, before their short assertion clocks
    // start. A single live resolver read can exceed 20s under gate activity;
    // timing out the first row used to turn every row sharing its promise red.
    beforeAll(async () => {
      await Promise.all([
        livePipelinePayload(),
        livePipelinePayload('packages/operator-core/lib/cell-registrations.ts'),
      ]);
    }, 120_000);

    it.each(PIPELINE_CELLS.map((c) => [c.cell, c] as const))(
      '%s — assessment + evidence paths arrive from dev:pipeline_position',
      async (_id, spec) => {
        // A `parameter`-relative cell is dispatched WITH its subject; a `global` one with
        // `{}`. Reproducing that split matters — the per-path legs are unmeasured on a
        // no-arg call.
        const payload = await livePipelinePayload(
          spec.callerRelativity.kind === 'parameter' ? 'packages/operator-core/lib/cell-registrations.ts' : undefined,
        );
        for (const { label, path } of assessmentPaths(spec)) {
          // Match production assessmentFrom: a child path below an explicitly
          // null optional leg is measured absence, not resolver/schema drift.
          // A genuinely missing key still has neither `exists` nor a null
          // terminator and therefore fails this reality check.
          const r = pathExists(payload, path, { reportNullTermination: true });
          expect(
            r.exists || r.nullTerminatedAt !== undefined,
            `${spec.cell}: declared ${label} "${path}" is ABSENT from the live resolver payload (missing at ` +
              `"${r.missingAt}"). assessmentFrom DOWNGRADES the whole assessment to \`unavailable\` when any ` +
              `declared evidence path does not arrive, so this cell would stop answering — silently, and on the ` +
              `ordinary path. Either the resolver's shape changed or the declaration has a typo.`,
          ).toBe(true);
        }
      },
      20_000,
    );
  });

  it.each(COVERAGE_CELLS.map((c) => [c.cell, c] as const))(
    '%s — assessment + evidence paths arrive from the real testing:coverage handler',
    async (_id, spec) => {
      const payload = await liveCoveragePayload();
      for (const { label, path } of assessmentPaths(spec)) {
        const r = pathExists(payload, path);
        expect(
          r.exists,
          `${spec.cell}: declared ${label} "${path}" is ABSENT (missing at "${r.missingAt}"). This asserts ` +
            `PRESENCE, not a non-null value: coverage.pct is null over an empty census by design.`,
        ).toBe(true);
      }
    },
    // A path walk, not a latency check: the live coverage handler measured ~5s idle
    // and 29.5s under gate load (verify 079f459e, 8c666117), past the old 20s clock.
    60_000,
  );

  it.each(HOST_MEMORY_CELLS.map((c) => [c.cell, c] as const))(
    '%s — assessment + evidence paths arrive from the real host:memory_pressure handler',
    async (_id, spec) => {
      const payload = await liveHostMemoryPayload();
      for (const { label, path } of assessmentPaths(spec)) {
        const r = pathExists(payload, path);
        expect(r.exists, `${spec.cell}: declared ${label} "${path}" is ABSENT (missing at "${r.missingAt}").`).toBe(
          true,
        );
      }
    },
    20_000,
  );

  it.each(GOVERNOR_CELLS.map((c) => [c.cell, c] as const))(
    '%s — assessment + evidence paths arrive from the real governor:state_snapshot handler',
    async (_id, spec) => {
      const payload = await liveGovernorPayload();
      for (const { label, path } of assessmentPaths(spec)) {
        const r = pathExists(payload, path);
        expect(r.exists, `${spec.cell}: declared ${label} "${path}" is ABSENT (missing at "${r.missingAt}").`).toBe(true);
      }
    },
    20_000,
  );

  it.each(LSP_ADMISSION_CELLS.map((c) => [c.cell, c] as const))(
    '%s — assessment and evidence paths survive measured, failed and stale daemon reads',
    (_id, spec) => {
      for (const payload of Object.values(lspPayloadsByCell[spec.cell]!)) {
        expect(missingAssessmentPaths(spec, payload)).toEqual([]);
        expect(pathExists(payload, spec.unknownHoist!).exists).toBe(true);
        expect(Object.keys(spec.assessment!.codes)).toContain(pathExists(payload, spec.assessment!.path).value);
      }
      expect(lspPayloads.pressure).toMatchObject({ measurement: 'measured', admission: { queued: 1, inFlight: 1 } });
      expect(lspPayloads.unknown).toMatchObject({ measurement: 'unknown', admission: null });
      expect(lspPayloads.stale).toMatchObject({ measurement: 'unknown', admission: null });
      expect(lspPayloads.unknown!.unknown).not.toEqual([]);
    },
  );

  /**
   * ⚠ THE LIVE CODE MUST BE A DECLARED ONE. This is drift in the direction the READ
   * refuses rather than the one it reports: `assessmentFrom` will not pass an
   * undeclared code through, so a resolver that ships a new verdict without adding it
   * to the registration makes the cell answer `unavailable` — a cell that stops
   * working, not one that answers wrongly. Nothing else in the suite would notice.
   */
  it.each(PIPELINE_CELLS.map((c) => [c.cell, c] as const))(
    '%s — the code the live resolver actually emitted is DECLARED',
    async (_id, spec) => {
      const payload = await livePipelinePayload(
        spec.callerRelativity.kind === 'parameter' ? 'packages/operator-core/lib/cell-registrations.ts' : undefined,
      );
      const live = pathExists(payload, spec.assessment!.path);
      // A null is legitimate — the resolver refusing to code an unresolved state.
      if (typeof live.value !== 'string') return;
      expect(
        Object.keys(spec.assessment!.codes),
        `${spec.cell}: the live resolver emitted "${live.value}", which the registration does not declare. ` +
          `readCell would refuse it and this cell would answer \`unavailable\`.`,
      ).toContain(live.value);
    },
    20_000,
  );
});

describe('P-004: every declared code is PRODUCIBLE, and nothing outside the declaration is emitted', () => {
  /**
   * The core claim of this file. Driven against each cell's REAL pure assessor, so a
   * declaration and a resolver cannot drift apart without one of these rows changing.
   */
  it.each(BUILTIN_CELLS.map((c) => [c.cell, c] as const))(
    '%s — each control input produces exactly the code the truth table names',
    (_id, spec) => {
      const rows = CONTROLS[spec.cell]!;
      const expected = EXPECTED[spec.cell]!;
      rows.forEach((row, i) => {
        expect(
          row.expect,
          `${spec.cell}: control "${row.label}" produced ${JSON.stringify(row.expect)} but the P-001 truth ` +
            `table says ${JSON.stringify(expected[i])}. Either the assessor's logic moved or its comparison ` +
            `was inverted — this row exists to make that impossible to ship silently.`,
        ).toBe(expected[i]);
      });
    },
  );

  it.each(BUILTIN_CELLS.map((c) => [c.cell, c] as const))(
    '%s — every DECLARED code is reachable from a real input',
    (_id, spec) => {
      const produced = new Set((EXPECTED[spec.cell] ?? []).filter((c): c is string => typeof c === 'string'));
      const declared = Object.keys(spec.assessment!.codes);
      const unreachable = declared.filter((c) => !produced.has(c));
      expect(
        unreachable,
        `${spec.cell}: declared code(s) ${unreachable.join(', ')} are produced by NO control input. A code a ` +
          `reader can branch on but the resolver can never emit is a promise it cannot keep.`,
      ).toEqual([]);
    },
  );

  it.each(BUILTIN_CELLS.map((c) => [c.cell, c] as const))(
    '%s — no control input produces a code the registration does not declare',
    (_id, spec) => {
      const declared = new Set(Object.keys(spec.assessment!.codes));
      const undeclared = (EXPECTED[spec.cell] ?? []).filter(
        (c): c is string => typeof c === 'string' && !declared.has(c),
      );
      expect(
        [...new Set(undeclared)],
        `${spec.cell}: the assessor can emit code(s) the registration does not declare. readCell refuses an ` +
          `undeclared code, so the cell would answer \`unavailable\` instead of reporting them.`,
      ).toEqual([]);
    },
  );

  /**
   * CLOSURE AGAINST THE READ-HEALTH VOCABULARY. D-008 keeps domain meaning and read
   * health as separate vocabularies so an apparatus failure can never masquerade as a
   * finding about the subject. The registry enforces this at registration — and this
   * asserts it against the codes the assessors actually PRODUCE, which is where the
   * collision was hiding: `testing.coverage.floor` emitted `not-measured`, a
   * CellUnknownCode, until D-012 renamed it `no-population`.
   */
  it.each(BUILTIN_CELLS.map((c) => [c.cell, c] as const))(
    '%s — no produced code collides with the read-health vocabulary',
    (_id, spec) => {
      const collisions = (EXPECTED[spec.cell] ?? []).filter(
        (c): c is string => typeof c === 'string' && (CELL_UNKNOWN_CODES as readonly string[]).includes(c),
      );
      expect(
        [...new Set(collisions)],
        `${spec.cell}: produces ${collisions.join(', ')}, which is ALSO a CellUnknownCode. "the apparatus ` +
          `failed" and "a verdict about the subject" would become one token.`,
      ).toEqual([]);
    },
  );
});

describe('P-004: assessments MOVE with their inputs, in the declared direction', () => {
  it('lsp.admission distinguishes no work, running work, pressure and failed settlement', () => {
    expect(lspPayloads.idle!.assessment).toBe('idle');
    expect(lspPayloads.active!.assessment).toBe('active');
    expect(lspPayloads.pressure!.assessment).toBe('pressure');
    expect(lspPayloads['settlement-failed']!.assessment).toBe('settlement-failed');
    expect(lspPayloads.unknown!.assessment).toBe('unknown');
    expect(lspPayloads.stale!.assessment).toBe('unknown');
  });
  /**
   * THE CONSTANCY DETECTOR. An assessment that answers the same code for every input
   * distinguishes nothing, and it is the failure a path-existence check cannot see:
   * the path is there, the code is a valid declared string, and the cell is useless.
   */
  it.each(BUILTIN_CELLS.map((c) => [c.cell, c] as const))(
    '%s — is not constant across its control inputs',
    (_id, spec) => {
      const codes = new Set((EXPECTED[spec.cell] ?? []).filter((c): c is string => typeof c === 'string'));
      expect(
        codes.size,
        `${spec.cell}: every control input produced the same code. A constant assessment carries no ` +
          `information — it is a field that always agrees with itself.`,
      ).toBeGreaterThan(1);
    },
  );

  /**
   * THE SIGN DETECTOR, stated as OPPOSING PAIRS.
   *
   * Each pair holds every input fixed but one — the field that DECIDES between two
   * codes — and names both outcomes. An inverted comparison keeps emitting the same
   * SET of codes (so a reachability check stays green) while attaching them to the
   * wrong inputs, which is precisely the shape of the bug `git.mainBehindStaging`
   * shipped: the cell answered its own name backwards, and because the normal steady
   * state is `behind`, the WRONG answer was the standing one.
   */
  const PAIRS: ReadonlyArray<readonly [string, string, string | (() => string), string | (() => string), string]> = [
    // [cell, decisive field, code when the field is "positive", code when negated, note]
    [
      'git.pipelinePosition',
      'serving.startedSinceCodeChange',
      PIPE({ servingStartedSinceCodeChange: true }) ?? '',
      PIPE({ servingStartedSinceCodeChange: false }) ?? '',
      'live vs restart-required',
    ],
    [
      'gate.greenCheckpoint.verdict',
      'gate.verdictStale',
      assessGateVerdict({
        inconclusive: null,
        consecutiveReds: 3,
        verdictStale: true,
        fireStale: false,
        mainBehindStaging: false,
        verdictUnknownLegs: [],
      }) ?? '',
      assessGateVerdict({
        inconclusive: null,
        consecutiveReds: 3,
        verdictStale: false,
        fireStale: false,
        mainBehindStaging: false,
        verdictUnknownLegs: [],
      }) ?? '',
      'a stale red must not read as a current one',
    ],
    [
      'gate.greenCheckpoint.verdict',
      'gate.repairQueue.verdictProvenance.repairHeadVerdict',
      assessGateVerdict({
        inconclusive: { status: 'repair-in-progress' },
        consecutiveReds: 1,
        verdictStale: false,
        fireStale: false,
        mainBehindStaging: false,
        verdictUnknownLegs: [],
        repairHeadVerdict: 'full-gate-red',
      }) ?? '',
      assessGateVerdict({
        inconclusive: { status: 'repair-in-progress' },
        consecutiveReds: 1,
        verdictStale: false,
        fireStale: false,
        mainBehindStaging: false,
        verdictUnknownLegs: [],
        repairHeadVerdict: 'not-judged',
      }) ?? '',
      'a measured repair-head red must not read as a no-verdict hold',
    ],
    [
      'gate.greenCheckpoint.candidate',
      'changeInCandidate.judgingContainsPath',
      assessGateCandidate({
        judgingSha: 'abc',
        judgingShaSource: 'retriage-marker',
        judgingContainsPath: true,
        verdictUnknownLegs: [],
      }) ?? '',
      assessGateCandidate({
        judgingSha: 'abc',
        judgingShaSource: 'retriage-marker',
        judgingContainsPath: false,
        verdictUnknownLegs: [],
      }) ?? '',
      'is the gate judging MY change',
    ],
    [
      // Literal codes (as for governor.* / memory.cgroupAttribution below): this cell's
      // assessment is one branch of the async git+PG resolver, not a separately-exported
      // pure function, so there is nothing to call here without a database.
      'gate.greenCheckpoint.candidateFailures',
      'candidateFailures.stillBrokenCount',
      'repairs-outstanding',
      'all-fixes-contained',
      'one genuinely unrepaired file must not read as "every fix already landed"',
    ],
    [
      'gate.greenCheckpoint.ownerBrief',
      'gate.ownerBrief.remediation.fixerAlive',
      OWNER_BRIEF({
        consecutiveReds: 1,
        repairQueue: {
          phase: 'awaiting-fixer',
          attempts: 1,
          updatedAtMs: 900,
          ageMs: 100,
          fixerSpawnId: 's-fixer',
          fixerAlive: false,
          zeroAttemptStalled: false,
        },
      }),
      OWNER_BRIEF({
        consecutiveReds: 1,
        repairQueue: {
          phase: 'awaiting-fixer',
          attempts: 1,
          updatedAtMs: 900,
          ageMs: 100,
          fixerSpawnId: 's-fixer',
          fixerAlive: true,
          zeroAttemptStalled: false,
        },
      }),
      'a DEAD fixer must not read as live remediation — the ~5h idle shape',
    ],
    // ── P-004's two freeze legs. They were registered without inversion probes, which left
    // this partition asserting 22 pairs against 24 cells — i.e. the file was RED, and its
    // own residue check is what caught it. Their decisive fields are the two conflations
    // each cell was built to end.
    [
      'gate.greenCheckpoint.convergence',
      'gate.convergence.converging',
      CONV({ converging: true }) ?? '',
      CONV({ converging: false }) ?? '',
      'a shrinking failing set must not read as the treadmill the freeze exists to prevent',
    ],
    [
      'gate.greenCheckpoint.freezeDisposition',
      'gate.freezeDisposition.state',
      FREEZE({ state: 'none' }) ?? '',
      FREEZE({ state: 'off', enabled: false }) ?? '',
      'a green gate with nothing frozen must not read as the owner having switched the mechanism off',
    ],
    // P-009. The decisive field is the one a caller acts on destructively.
    [
      'gate.greenCheckpoint.retriage',
      'gate.retriage.inFlight',
      RETRIAGE({}) ?? '',
      RETRIAGE({ inRetriageWindow: undefined }) ?? '',
      'a live auto-refire must not read as a run with no rescue to discard',
    ],
    [
      'gate.greenCheckpoint.ownership',
      'gate.ownership.lastProgressAt',
      assessGateOwnership({
        claimState: 'held',
        holderSessionState: 'live',
        duplicates: [],
        takenAt: ownershipAtAge(CRITICAL_CLAIM_PROGRESS_LEASE_MS + 1),
        lastProgressAt: ownershipAtAge(CRITICAL_CLAIM_PROGRESS_LEASE_MS + 1),
        nowMs: OWNERSHIP_NOW_MS,
      }) ?? '',
      assessGateOwnership({
        claimState: 'held',
        holderSessionState: 'live',
        duplicates: [],
        takenAt: ownershipAtAge(1),
        lastProgressAt: ownershipAtAge(1),
        nowMs: OWNERSHIP_NOW_MS,
      }) ?? '',
      'an expired item-progress lease must not read as a live hold',
    ],
    [
      'gate.greenCheckpoint.qualification',
      'gate.qualification.lease.expired',
      'recover-expired-runner',
      'await-current-run',
      'an expired physical runner must not retain the singleton lease',
    ],
    [
      'deploy.3070.sha',
      'serving.startedSinceCodeChange',
      assessDeployedSha({ deployedSha: 'abc', servingStartedSinceCodeChange: true, verdictUnknownLegs: [] }) ?? '',
      assessDeployedSha({ deployedSha: 'abc', servingStartedSinceCodeChange: false, verdictUnknownLegs: [] }) ?? '',
      'executing vs restart-required',
    ],
    [
      'git.mainBehindStaging',
      'gate.fireStale',
      assessMainBehindStaging({ mainBehindStaging: true, fireStale: true, verdictUnknownLegs: [] }) ?? '',
      assessMainBehindStaging({ mainBehindStaging: true, fireStale: false, verdictUnknownLegs: [] }) ?? '',
      'THE polarity bug this detector exists for (EI-20046248345042252)',
    ],
    [
      'host.memoryPressure',
      'host.memFreePct',
      assessHostMemoryPressure({ pressure: 'ok', stale: false, unknownCount: 0, memFreePct: 5 }) ?? '',
      assessHostMemoryPressure({ pressure: 'ok', stale: false, unknownCount: 0, memFreePct: 80 }) ?? '',
      'low free capacity must not be reported as PSI pressure',
    ],
    [
      'memory.cgroupAttribution',
      'memory.pressure',
      'crit',
      'ok',
      'attribution context must preserve the resolver pressure band',
    ],
    [
      'agent.goal',
      'goalCompeting',
      assessAgentGoal(GOALOF('corroborated', ['WI-2']), []) ?? '',
      assessAgentGoal(GOALOF('corroborated', []), []) ?? '',
      'competing claims must outrank a corroborating edge',
    ],
    [
      'goal.portfolioThroughput',
      'portfolioThroughput.reason',
      portfolioAssessmentFor('idle'),
      portfolioAssessmentFor('within-grace'),
      'a holder idle PAST the threshold must not read as one still inside its grace window',
    ],
    [
      'testing.census.population',
      'census.providersRegistered',
      assessTestingCensusPopulation({ surfaces: 0, providersRegistered: 0, lastCensusAt: null }),
      assessTestingCensusPopulation({ surfaces: 0, providersRegistered: 1, lastCensusAt: null }),
      'an unasked question must not read as a measured zero',
    ],
    [
      'testing.coverage.floor',
      'coverage.belowUnwaived',
      assessTestingCoverageFloor({ verdict: 'measured', surfaces: 10, below: 2, belowUnwaived: 2, evidenced: 10 }),
      assessTestingCoverageFloor({ verdict: 'measured', surfaces: 10, below: 2, belowUnwaived: 0, evidenced: 10 }),
      'a waived gap must not read as an unwaived one',
    ],
    [
      'lsp.admission',
      'admission.queued',
      () => lspPayloads.pressure!.assessment,
      () => lspPayloads.active!.assessment,
      'a queued query must read as pressure while the same running query alone reads active',
    ],
    [
      'lsp.warmServers',
      'runtime.overall',
      () => lspRuntimePayloads.healthy!.runtimeAssessment,
      () => lspRuntimePayloads.unhealthy!.runtimeAssessment,
      'healthy and unhealthy warm-server populations must not collapse',
    ],
    [
      'lsp.readiness',
      'readiness[0].unproven',
      () => lspRuntimePayloads.healthy!.readinessAssessment,
      () => lspRuntimePayloads.unproven!.readinessAssessment,
      'reported intent proofs must remain distinct from unproven intent readiness',
    ],
    ['governor.health', 'health.state', 'healthy', 'degraded', 'healthy and degraded must not collapse'],
    ['governor.admission', 'admission.state', 'open', 'paused', 'open and paused admission must not collapse'],
    ['governor.queue', 'queue.trend', 'growing', 'draining', 'queue growth direction must not invert'],
    ['governor.resources', 'resources.constrained', 'constrained', 'unconstrained', 'resource constraint polarity'],
    ['governor.recovery', 'recovery.state', 'recovering', 'stable', 'active recovery must not read stable'],
    [
      'capacity.verdict',
      'admission.dispatchBudget',
      CAPACITY({}, { reachable: true, blind: false, dispatchBudget: 0, inFlight: 12 }),
      CAPACITY({}, { reachable: true, blind: false, dispatchBudget: 1, inFlight: 12 }),
      'a self-imposed zero-slot admission clamp must not read as a measured clear lane',
    ],
    [
      'agent.roleLaunch',
      'roles[0].conflict',
      ROLE_LAUNCH([{ conflict: { configured: 'codex', effective: 'claude-code', note: 'assessment reality control' } }]) ?? '',
      ROLE_LAUNCH([{}]) ?? '',
      'a role in conflict must not read as consistent',
    ],
    [
      'workspace.workScope',
      'mode',
      assessWorkScope({ mode: 'enforce', allowHarnesses: ['papercusp'] }),
      assessWorkScope({ mode: 'off', allowHarnesses: ['papercusp'] }),
      'an enforced confinement must not read as off',
    ],
    [
      'owner.directive.status',
      'status.workedButUndispositioned',
      DIRSTAT({ dispositionStatus: null }, [{ id: 'WI-1', state: 'done' }]),
      DIRSTAT({ dispositionStatus: null }),
      'work that happened and was never dispositioned must not read as never started',
    ],
    [
      'verification.health',
      'health.breaches',
      assessVerificationHealth({ breaches: 1, unmeasuredCodes: [] }),
      assessVerificationHealth({ breaches: 0, unmeasuredCodes: [] }),
      'a breached threshold must not read as healthy',
    ],
    [
      'work.bugInflow',
      'inflow.days',
      BUG_INFLOW(BUG_INFLOW_FRESH).assessment,
      BUG_INFLOW([]).assessment,
      'a writer that never ran must not read as measured',
    ],
  ];

  /** Every cell gets an inversion probe — the same ten-of-ten partition, no residue. */
  it('probes all registered cells for sign inversion', () => {
    expect(new Set(PAIRS.map((p) => p[0])).size).toBe(BUILTIN_CELLS.length);
    for (const spec of BUILTIN_CELLS) {
      expect(
        PAIRS.some((p) => p[0] === spec.cell),
        `${spec.cell} has no sign-inversion probe`,
      ).toBe(true);
    }
  });

  it.each(PAIRS.map((p) => [p[0], p] as const))('%s — the decisive field actually decides', (_id, pair) => {
    const [cell, field, positiveReading, negatedReading, note] = pair;
    const positive = typeof positiveReading === 'function' ? positiveReading() : positiveReading;
    const negated = typeof negatedReading === 'function' ? negatedReading() : negatedReading;
    const spec = BUILTIN_CELLS.find((c) => c.cell === cell)!;

    expect(
      positive,
      `${cell}: the two states of "${field}" produced the SAME code ("${positive}"). The field does not decide ` +
        `anything, so ${note} cannot be read off this cell.`,
    ).not.toBe(negated);

    // Both sides must be codes the registration actually declares, or the pair proves
    // movement into a state no reader can branch on.
    for (const code of [positive, negated]) {
      expect(Object.keys(spec.assessment!.codes), `${cell}: "${code}" is not a declared code`).toContain(code);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════
 * `agent.goal` resolves through a DIFFERENT tool, so it gets its own describe rather
 * than a filtered-out row above — a cell quietly dropped from a generic loop is
 * exactly the un-exercised declaration this file exists to prevent.
 *
 * The resolver is mocked; the PAYLOAD BUILDER is not. The assertions run against the
 * real `coord:goal` handler's object construction, so a change to the flat hoisting it
 * performs reds this file. Mocking only the DB-backed leg keeps that real without
 * requiring Postgres.
 * ══════════════════════════════════════════════════════════════════════════════ */
vi.mock('./agent-tools/coordination/identity', () => ({
  resolveAgentIdentity: () => ({
    ownerId: 'su-p004',
    ownerLabel: 'su · p004',
    source: 'test',
    workspaceId: 'default',
    userId: null,
  }),
  SU_ROLES: ['operator'],
}));

const resolveOwnerGoalMock = vi.hoisted(() => vi.fn());
const resolveOwnerGoalWithAssessmentMock = vi.hoisted(() => vi.fn());
vi.mock('./agent-tools/coordination/agent-goal-sources', async (importOriginal) => {
  // ⚠ The REAL `assessAgentGoal` is kept — it is the subject of the control table
  // above, and stubbing it would make every goal row assert against the mock.
  const actual = await importOriginal<typeof import('./agent-tools/coordination/agent-goal-sources')>();
  return {
    ...actual,
    resolveOwnerGoal: resolveOwnerGoalMock,
    resolveOwnerGoalWithAssessment: resolveOwnerGoalWithAssessmentMock,
  };
});

describe('P-004: agent.goal declares assessment paths coord:goal ACTUALLY produces', () => {
  async function goalPayload(goal: unknown): Promise<unknown> {
    resolveOwnerGoalMock.mockResolvedValue(goal);
    resolveOwnerGoalWithAssessmentMock.mockResolvedValue({
      goal,
      assessment: assessAgentGoal(goal as never, []),
      diagnostics: [],
    });
    const { default: goalTool } = await import('./agent-tools/coordination/tools/goal');
    const res = await (
      goalTool as { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> }
    ).handler({ ownerId: 'su-p004' }, { workspaceId: 'default', harnessSlug: 'papercusp', uiClientId: 'su-p004' });
    return JSON.parse(res.content[0].text);
  }

  const HELD_GOAL = {
    ref: 'WI-6498',
    source: 'work-item',
    agreement: 'divergent',
    competing: ['WI-6497'],
    corroboratedBy: ['claim'],
    declaredAt: '2026-08-24T00:00:00.000Z',
  };

  /**
   * ⚠ THE CASE THAT WOULD ACTUALLY BREAK, and the reason both branches are exercised.
   * An agent holding NOTHING is the ordinary case, and it is the one where a nested
   * evidence path silently dies: `pathExists` stops at the first null segment, so
   * `goal.competing` against `goal: null` is ABSENT — and an absent evidence path
   * DOWNGRADES the whole assessment to `unavailable`. A fixture with a goal in it
   * passes either way, which is exactly how this would ship. It is P-011's bug with a
   * larger blast radius: there it broke one falsifier, here it would take the entire
   * assessment down with it.
   */
  it.each(GOAL_CELLS.map((c) => [c.cell, c] as const))(
    '%s — assessment + evidence paths exist whether or not the agent holds anything',
    async (_id, spec) => {
      for (const [caseName, goal] of [
        ['holds a goal', HELD_GOAL],
        ['holds NOTHING', null],
      ] as const) {
        const payload = await goalPayload(goal);
        for (const { label, path } of assessmentPaths(spec)) {
          const r = pathExists(payload, path);
          expect(
            r.exists,
            `${spec.cell} (${caseName}): declared ${label} "${path}" is ABSENT from the coord:goal payload ` +
              `(missing at "${r.missingAt}"). Evidence that vanishes when the agent holds nothing downgrades ` +
              `the assessment to \`unavailable\` in the most ordinary case there is.`,
          ).toBe(true);
        }
      }
    },
  );

  /** The assessment moves with the goal, and the goal-less case is a CODE, not a gap. */
  it('codes the goal-less agent as `nothing-held` rather than answering unavailable', async () => {
    const empty = await goalPayload(null);
    expect(pathExists(empty, 'assessment').value).toBe('nothing-held');
    expect(pathExists(empty, 'goalRef')).toEqual({ exists: true, value: null });
    expect(pathExists(empty, 'goalUnknown').value).toBe('nothing-held');

    const held = await goalPayload(HELD_GOAL);
    expect(pathExists(held, 'assessment').value).toBe('divergent');
    expect(pathExists(held, 'goalRef').value).toBe('WI-6498');
    expect(pathExists(held, 'goalUnknown').value).toBeNull();
  });

  /**
   * The evidence CONTRADICTS the naive reading, which is what a falsifier used to
   * assert in prose. Preserved as a behavioural check rather than dropped with the
   * field: the ref alone reads as a single confident answer, and `goalCompeting` is
   * what shows it stands among rivals.
   */
  it.each(GOAL_CELLS.map((c) => [c.cell, c] as const))(
    '%s — the declared evidence shows the ref is not the whole story',
    async (_id, spec) => {
      const payload = await goalPayload(HELD_GOAL);
      expect(pathExists(payload, spec.headline).value).toBe('WI-6498');
      expect(pathExists(payload, 'goalAgreement').value).toBe('divergent');
      expect(pathExists(payload, 'goalCompeting').value).toEqual(['WI-6497']);

      // A corroborated holder must NOT read as divergent, or the evidence would be a
      // constant — which fires on everything and therefore distinguishes nothing.
      const corroborated = await goalPayload({ ...HELD_GOAL, agreement: 'corroborated', competing: [] });
      expect(pathExists(corroborated, 'assessment').value).toBe('corroborated');
      expect(pathExists(corroborated, 'goalCompeting').value).toEqual([]);
    },
  );
});

/* ═══════════════════════════════════════════════════════════════════════════════
 * FALSIFIABILITY CONTROLS — PERMANENT, not a one-off probe.
 *
 * Every assertion above passed on this file's FIRST run, which is exactly when a guard
 * deserves the least trust: a path walk that silently matched nothing, a predicate that
 * cannot tell broken from healthy, and a correct guard all look identical from green.
 *
 * The repo's mutation-probe tiers put an IMPORTED subject in the "keep a deliberately
 * wrong implementation permanently in the test file" tier rather than the in-tree
 * mutation tier, and the reason bites here: an in-tree probe holds
 * `cell-registrations.ts` mutated for as long as the suite runs, and git-sync sweeps
 * the whole tree every few minutes — so the probe proving this guard works can commit a
 * broken registration. (Attempted 2026-08-24: git-sync held the exclusive sweep lock at
 * that moment. That is the race the tier exists to avoid, not bad luck.)
 *
 * Each control below breaks a COPY of a real spec and asserts the guard NAMES the
 * break, paired with a CALIBRATION — the unmodified spec against the same payload —
 * because a control that fails on both sides proves nothing about the subject and
 * everything about a broken instrument.
 * ══════════════════════════════════════════════════════════════════════════════ */
describe('P-004: the guards themselves are falsifiable', () => {
  it('the path walk NAMES a broken assessment.path, and passes the same spec unbroken', async () => {
    const spec = HOST_MEMORY_CELLS[0]!;
    const payload = await liveHostMemoryPayload();

    // CALIBRATION — if the REAL spec does not walk clean the instrument is broken and
    // the control below proves nothing.
    expect(missingAssessmentPaths(spec, payload), 'calibration: the REAL spec must walk clean').toEqual([]);

    expect(missingAssessmentPaths(withBrokenPath(spec, 'assessment.path'), payload)).toEqual([
      `${spec.assessment!.path}__NO_SUCH_FIELD`,
    ]);
  }, 20_000);

  it('the path walk NAMES a broken evidence path — the case that downgrades a live read', async () => {
    const spec = HOST_MEMORY_CELLS[0]!;
    const payload = await liveHostMemoryPayload();
    expect(missingAssessmentPaths(spec, payload), 'calibration: the REAL spec must walk clean').toEqual([]);

    expect(missingAssessmentPaths(withBrokenPath(spec, 'evidence'), payload)).toEqual([
      `${spec.assessment!.evidence[0]}__NO_SUCH_FIELD`,
    ]);
  }, 20_000);

  /**
   * ⚠ THE NULL-PARENT CONTROL — the specific bug P-011 shipped, now with a bigger blast
   * radius. `pathExists` stops at a null segment, so evidence nested under a nullable
   * parent is ABSENT in exactly the state it exists to explain, and an absent evidence
   * path downgrades the WHOLE assessment. A walker that confused MISSING with NULL
   * would call the nested declaration healthy.
   */
  it('reports evidence nested under a NULL parent as missing, not as present-and-null', () => {
    const spec = GOAL_CELLS[0]!;
    const payload = {
      assessment: 'nothing-held',
      goal: null,
      goalRef: null,
      goalUnknown: 'nothing-held',
      goalAgreement: null,
      goalCompeting: [],
    };

    // CALIBRATION — the shipped FLAT declaration walks clean even though the values are
    // null, which is the whole reason it is flat.
    expect(missingAssessmentPaths(spec, payload), 'calibration: the shipped flat evidence must walk clean').toEqual([]);

    // The same facts declared under the nullable parent: absent, and the guard says so.
    const nested: CellSpec = {
      ...spec,
      assessment: { ...spec.assessment!, evidence: ['goal.agreement', 'goal.competing'] },
    };
    expect(missingAssessmentPaths(nested, payload)).toEqual(['goal.agreement', 'goal.competing']);
  });

  /** The CONSTANCY detector, falsified against a stub that never moves. */
  it('the constancy detector flags an assessor that never moves', () => {
    const constant = ['stable', 'stable', 'stable', 'stable'];
    const real = EXPECTED['host.memoryPressure']!.filter((c): c is string => typeof c === 'string');

    expect(new Set(constant).size, 'a constant assessor must not look varied').toBe(1);
    expect(new Set(real).size, 'calibration: the REAL assessor must produce several codes').toBeGreaterThan(1);
  });

  /**
   * The SIGN detector, falsified. An inverted assessor emits the SAME SET of codes as a
   * correct one — which is why a reachability check cannot catch it, and why every pair
   * above asserts an exact code per side rather than merely that the two differ.
   */
  it('the sign detector flags an INVERTED assessor that a reachability check would pass', () => {
    const correct = (behind: boolean, fireStale: boolean) =>
      assessMainBehindStaging({ mainBehindStaging: behind, fireStale, verdictUnknownLegs: [] });
    // The bug shape: the decisive comparison negated. Same codes, wrong inputs.
    const inverted = (behind: boolean, fireStale: boolean) =>
      behind ? (!fireStale ? 'gate-stalled' : 'normal-buffer') : 'caught-up';

    const codesOf = (f: (b: boolean, s: boolean) => string | null) =>
      new Set([f(true, true), f(true, false), f(false, false)].filter(Boolean));

    // Pinned as an assertion rather than claimed in a comment: reachability alone
    // genuinely cannot separate the inverted assessor from the correct one.
    expect(codesOf(inverted)).toEqual(codesOf(correct));

    // The pair check can, because it reads the code for ONE named input state.
    expect(correct(true, true)).toBe('gate-stalled');
    expect(inverted(true, true)).toBe('normal-buffer');
  });

  /**
   * The READ-HEALTH collision detector, falsified. This is the check that would have
   * caught `testing.coverage.floor` emitting `not-measured` before D-012 renamed it —
   * worth keeping precisely because the collision stayed invisible for as long as no
   * cell declared an assessment at all.
   */
  it('the collision detector flags a domain code that reuses the read-health vocabulary', () => {
    const colliding = ['not-measured', 'meets-floor'];
    const shipped = EXPECTED['testing.coverage.floor']!.filter((c): c is string => typeof c === 'string');

    expect(colliding.filter((c) => (CELL_UNKNOWN_CODES as readonly string[]).includes(c))).toEqual(['not-measured']);
    expect(
      shipped.filter((c) => (CELL_UNKNOWN_CODES as readonly string[]).includes(c)),
      'calibration: the SHIPPED codes must be collision-free',
    ).toEqual([]);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * main-green-status-visible-2026-09-03 P-012 — "MEASURED EMPTY" NEVER RENDERS AS
 * "NOTHING FAILING", ENFORCED AGAINST THE LIVE PAYLOAD OF EVERY BUILT-IN CELL.
 *
 * The invariant (cell-measuredness.ts): a hoisted COUNT or LIST is never alone — it is
 * paired, in the cell's `assessment.measuredBy`, with the same-payload path that says
 * whether it was measured, and that flag is hoisted too. Which hoisted paths ARE counts
 * or lists is read off the live payload's types, so a new cell that hoists a count with
 * no pairing fails HERE, on the ordinary path, before a reader ever meets its zero.
 *
 * The controls that prove this guard can fail live in cell-measuredness.test.ts, against
 * the defect-shaped payload (`0 / [] / none-failing`), so no live state can make them
 * vacuous. This block is the sweep; that file is the falsifier.
 * ═══════════════════════════════════════════════════════════════════════════════════
 */
describe('P-012: every hoisted count/list travels with its measured-ness flag', () => {
  const PIPELINE_SUBJECT = 'packages/operator-core/lib/cell-registrations.ts';
  const withPayload: ReadonlyArray<readonly [string, CellSpec, () => Promise<unknown>]> = [
    ...PIPELINE_CELLS.map(
      (c) =>
        [c.cell, c, () => livePipelinePayload(c.callerRelativity.kind === 'parameter' ? PIPELINE_SUBJECT : undefined)] as const,
    ),
    ...COVERAGE_CELLS.map((c) => [c.cell, c, liveCoveragePayload] as const),
    ...HOST_MEMORY_CELLS.map((c) => [c.cell, c, liveHostMemoryPayload] as const),
    ...GOVERNOR_CELLS.map((c) => [c.cell, c, liveGovernorPayload] as const),
    ...LSP_ADMISSION_CELLS.map((c) => [c.cell, c, async () =>
      c.cell === 'lsp.admission' ? lspPayloads.pressure : lspRuntimePayloads.healthy] as const),
    // P-007: the payload builder is pure, so the sweep reads the real payload shape
    // (bugInflowPayload over shapeBugInflow) without a live bug_inflow_daily read.
    ...WORK_BUG_INFLOW_CELLS.map(
      (c) => [c.cell, c, async () => bugInflowPayload(BUG_INFLOW(BUG_INFLOW_FRESH), BUG_INFLOW_NOW)] as const,
    ),
  ];
  const PAYLOADLESS = [
    ...GOAL_CELLS,
    ...PORTFOLIO_CELLS,
    ...CAPACITY_CELLS,
    ...ROLE_LAUNCH_CELLS,
    ...WORK_SCOPE_CELLS,
    ...DIRECTIVE_CELLS,
    // The dedicated dev:gate_ownership handler test verifies its projected
    // shape with an injected ownership result. Keep this sweep off the live
    // single-fixer gate control plane; its pairing is checked structurally.
    ...GATE_OWNERSHIP_CELLS,
    // plans:verification-health measures live plan + work-item SQL; its declared probe
    // paths are run against a real read in verification-health-cell-probes.test.ts.
    ...VERIFICATION_HEALTH_CELLS,
  ];

  /**
   * THE TRIPWIRE. A cell the sweep cannot obtain a payload for is checked structurally
   * only, which is weaker — so the set of such cells is PINNED BY NAME. A new cell
   * outside the live families lands here and must either join a live family or be added
   * to this list deliberately, with its pairing declared by hand.
   */
  it('covers every built-in cell — live-payload families plus a pinned payload-less remainder', () => {
    expect(withPayload.length + PAYLOADLESS.length).toBe(BUILTIN_CELLS.length);
    expect(PAYLOADLESS.map((c) => c.cell).sort()).toEqual([
      'agent.goal',
      'agent.roleLaunch',
      'capacity.verdict',
      'gate.greenCheckpoint.ownership',
      'goal.portfolioThroughput',
      // P-007: assessDirectiveStatus is pure over a derived status and needs no live store;
      // the sweep cannot obtain a payload for it because orders:get is per-directive-id.
      'owner.directive.status',
      // Live resolver needs Postgres; probe paths are covered by verification-health-cell-probes.test.ts.
      'verification.health',
      // WI-2145092: its payload builder is pure (buildWorkScopeStatusPayload) and needs no
      // live store, and its hoisted list (`allowHarnesses`) is a plain projection of the row.
      'workspace.workScope',
    ]);
  });

  it.each(withPayload)(
    '%s — no hoisted count or list is unpaired, and every flag is hoisted and flag-shaped (live payload)',
    async (_id, spec, payload) => {
      const v = measurednessViolations(spec, await payload());
      expect(v, formatMeasurednessViolations(v)).toEqual([]);
    },
    20_000,
  );

  it.each(PAYLOADLESS.map((c) => [c.cell, c] as const))(
    '%s — the pairing is structurally sound (payload-less: the type half is not decidable here)',
    (_id, spec) => {
      const v = measurednessViolations(spec, undefined);
      expect(v, formatMeasurednessViolations(v)).toEqual([]);
    },
  );

  /**
   * NON-VACUITY (the P-009 lesson, again). A sweep whose classifier silently matched
   * nothing would pass green having examined no count at all. The gate's streak counter
   * and the coverage census are numbers on every read, so the live sweep must classify
   * a non-trivial population — and the population is printed, so a shrinking one is
   * visible rather than silently tolerated.
   */
  it('the live sweep actually classified counts and lists — the guard is not vacuously green', async () => {
    let classified = 0;
    const seen: string[] = [];
    for (const [, spec, payload] of withPayload) {
      const p = await payload();
      for (const path of hoistedPaths(spec)) {
        if (spec.unknownHoist === path) continue;
        const r = pathExists(p, path);
        if (r.exists && isCountOrList(path, r.value)) {
          classified += 1;
          seen.push(`${spec.cell}:${path}`);
        }
      }
    }
    expect(classified, `classified: ${seen.join(', ')}`).toBeGreaterThanOrEqual(8);
    expect(seen).toContain('gate.greenCheckpoint.verdict:gate.consecutiveReds');
    expect(seen).toContain('testing.coverage.floor:coverage.pct');
  }, 60_000);
});
