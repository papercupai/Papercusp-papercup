/**
 * Unit tests for work_items:complete (coord-lifecycle-automation-2026-06-04 D-004),
 * dual-arity keyed-array contract (bulk-endpoint-standardization-2026-06-21). The
 * engine (getWorkItem/setWorkItemStateWithAliasInfo) is mocked — this exercises the
 * tool's contract: existence check, optional terminal transition, the structured
 * completion record the lifecycle emits-rule reads, and per-item fan-out for items:[…].
 *
 * EI-7712: complete.ts calls the shared `setWorkItemStateWithAliasInfo` helper (not the
 * bare `setWorkItemState`) so every terminal transition also carries the fail-loud
 * aliased/requestedState/appliedState discriminator — see the dedicated describe block
 * near the end of this file.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { blankPng, contentPng } from '@papercusp/image-blankness/testing';
import { dispatchProjectedTool, lookupByMcpName } from '@papercusp/agent-mcp';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  planItemStatusRows: vi.fn(),
}));
const contentionMocks = vi.hoisted(() => ({
  acquireWithContentionRetry: vi.fn(),
}));
const hiveMocks = vi.hoisted(() => ({
  potHomeSlugForHarness: vi.fn(),
}));
const parkReachability = vi.hoisted(() => ({ read: vi.fn() }));
const directiveRecovery = vi.hoisted(() => ({ closureError: vi.fn(async (..._args: unknown[]): Promise<string | null> => null) }));
vi.mock('../../owner-directive-recovery', () => ({
  directiveRecoveryClosureError: (...args: unknown[]) => directiveRecovery.closureError(...args),
}));
const contentIdentityPreview = vi.hoisted(() => ({ stamp: vi.fn() }));
vi.mock('./completion-freshness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./completion-freshness')>();
  return {
    ...actual,
    completionTreeStampForEvidence: (...args: Parameters<typeof actual.completionTreeStampForEvidence>) =>
      contentIdentityPreview.stamp(...args) ?? actual.completionTreeStampForEvidence(...args),
  };
});
const conformanceClosure = vi.hoisted(() => ({
  read: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({
    applicable: true,
    mappedRequirements: ['R-1'],
    declaredRequirements: ['R-1'],
    declarationSatisfied: true,
    refusal: null,
  })),
}));
vi.mock('../../spec-conformance/closure-guard', () => ({
  conformanceClosureAssessment: (...args: unknown[]) => conformanceClosure.read(...args),
}));
// plan-verification-profiles P-005 (R-15): the close-time deliverable check reads PG through
// the real withWorkspace, so it is stubbed here (default: nothing to refuse). Its SQL and
// decision logic run against real PG in verification-profile-escape.integration.test.ts;
// this file pins the wiring into work_items:complete.
const nonCodeClose = vi.hoisted(() => ({
  read: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  nonCode: vi.fn(async (..._args: unknown[]): Promise<boolean> => false),
}));
vi.mock('../../plan-verification-escape', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../plan-verification-escape')>(),
  readNonCodeDeliverableCloseEvidence: (...args: unknown[]) => nonCodeClose.read(...args),
  // R-13: the linked-deliverable read is stubbed the same way (default: not positively
  // non-code, so the tests-run requirement holds). Real PG coverage lives in
  // complete-deliverable-fields.integration.test.ts.
  readCloseDeliverablesAreNonCode: (...args: unknown[]) => nonCodeClose.nonCode(...args),
}));
// plan-item-types-registry-cupboard P-004 (R-10): the item-type completion-fields read goes
// through withPinnedPlanTypes and real PG, so it is stubbed too (default: nothing to refuse).
// Real PG coverage lives in complete-item-type-fields.integration.test.ts.
const typeFieldsClose = vi.hoisted(() => ({
  read: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
}));
vi.mock('../../plan-types/item-type-contract', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../plan-types/item-type-contract')>(),
  readCloseItemTypeFieldsRefusal: (...args: unknown[]) => typeFieldsClose.read(...args),
}));
vi.mock('../../external-condition-reachability', () => ({
  readEventConditionReachability: (...args: unknown[]) => parkReachability.read(...args),
}));
vi.mock('../locks/contention-retry', () => ({
  acquireWithContentionRetry: (...args: unknown[]) => contentionMocks.acquireWithContentionRetry(...args),
}));
vi.mock('../../hive-federation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hive-federation')>();
  return {
    ...actual,
    potHomeSlugForHarness: (...args: unknown[]) => hiveMocks.potHomeSlugForHarness(...args),
  };
});
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    getOrgPg: () => {
      const sql = (strings: TemplateStringsArray, ...values: unknown[]) =>
        dbMocks.planItemStatusRows(strings, ...values);
      return {
        sql: Object.assign(sql, {
          begin: async <T>(callback: (tx: typeof sql) => Promise<T>): Promise<T> => callback(sql),
        }),
      };
    },
  };
});

const getWorkItem = vi.fn();
const getWorkItemsByIds = vi.fn();
const listWorkItems = vi.fn();
const setWorkItemStateWithAliasInfo = vi.fn();
const assessWorkItemHeldOpenTerminalTransition = vi.fn();
const workItemPlanLaneTransitionRefusal = vi.fn();
const setWorkItemClaimHold = vi.fn();
const mergeWorkItemOutputPayload = vi.fn();
const resolveWorkItemRef = vi.fn();
const linkWorkItem = vi.fn();
const subscribeWorkItem = vi.fn();
const resolveAdoptedName = vi.fn();
vi.mock('../../plan-items/agent-names', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../plan-items/agent-names')>(),
  resolveAdoptedName: (...a: unknown[]) => resolveAdoptedName(...a),
}));
// EI-19362441037986499: the record-only-completion-of-an-already-terminal-item writer. It
// MUST be in this wholesale mock — omitting it leaves the import `undefined`, and every
// existing record-only completion of a resolved/passed item then throws inside the arm that
// calls it, which complete.ts catches and reports as a stateError. That failure mode looks
// like a product bug, not a stale mock (the trap this file has hit before).
const attachCompletionEvidenceToSettledItem = vi.fn();
const commentWorkItem = vi.fn();
vi.mock('../../work-items', () => ({
  getWorkItem: (...a: unknown[]) => getWorkItem(...a),
  assessWorkItemHeldOpenTerminalTransition: (...a: unknown[]) => assessWorkItemHeldOpenTerminalTransition(...a),
  workItemPlanLaneTransitionRefusal: (...a: unknown[]) => workItemPlanLaneTransitionRefusal(...a),
  getWorkItemsByIds: (...a: unknown[]) => getWorkItemsByIds(...a),
  listWorkItems: (...a: unknown[]) => listWorkItems(...a),
  // The improvement-review module is imported through complete.ts's analysis
  // dependency graph and binds these references at import time.
  getWorkItemDetail: vi.fn(),
  mergeWorkItemPayload: vi.fn(),
  releaseWorkItem: vi.fn(),
  claimWorkItem: vi.fn(),
  depsBlockedExclusionSql: vi.fn(),
  explainIssueClaimFloors: vi.fn(),
  isClaimHoldParked: vi.fn(),
  observeWorkItem: vi.fn(),
  looksLikePolicyGate: vi.fn(),
  readWorkItemClaimHoldProvenance: vi.fn(),
  readUnresolvedDepBlockers: vi.fn(),
  ACTIVE_FEATURE_FAMILY_KINDS: ['feature'],
  ISSUE_FAMILY_KINDS: ['bug', 'change', 'task'],
  setWorkItemStateWithAliasInfo: (...a: unknown[]) => setWorkItemStateWithAliasInfo(...a),
  attachCompletionEvidenceToSettledItem: (...a: unknown[]) => attachCompletionEvidenceToSettledItem(...a),
  commentWorkItem: (...a: unknown[]) => commentWorkItem(...a),
  setWorkItemClaimHold: (...a: unknown[]) => setWorkItemClaimHold(...a),
  workItemObjectRef: (x: { id: string }) => `wi:${x.id}`,
  mergeWorkItemOutputPayload: (...a: unknown[]) => mergeWorkItemOutputPayload(...a),
  resolveWorkItemRef: (...a: unknown[]) => resolveWorkItemRef(...a),
  linkWorkItem: (...a: unknown[]) => linkWorkItem(...a),
  subscribeWorkItem: (...a: unknown[]) => subscribeWorkItem(...a),
  // D-035 agent-work door gate (work-nature/agent-work-door-gate): null = the row IS agent
  // work, so every existing completion case reaches its own write path unchanged.
  readNonAgentWorkCategory: vi.fn(async () => null),
  // Real constant (not a spy) — complete.ts sources its terminal-state check from this
  // single source of truth (EI-18127483322976472); mirrors work-items.ts's actual value.
  SETTLED_WORK_ITEM_STATES: ['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped'],
}));

const getWorkItemCheckpoint = vi.fn();
const setWorkItemCheckpoint = vi.fn();
// EI-23701433507513915: the holder-identity rules run for real, against an owner registry this
// file controls, instead of coord presence (db-org is mocked above).
const OWNER_REGISTRY = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('../../work-item-holder-identity', async (importOriginal) => {
  const { registryBackedHolderIdentity } = await import('../../work-item-holder-identity.testing');
  return registryBackedHolderIdentity(await importOriginal(), OWNER_REGISTRY);
});

vi.mock('../../work-item-checkpoint', () => ({
  getWorkItemCheckpoint: (...a: unknown[]) => getWorkItemCheckpoint(...a),
  setWorkItemCheckpoint: (...a: unknown[]) => setWorkItemCheckpoint(...a),
}));
const fireReactionInProcess = vi.fn();
vi.mock('../../events', () => ({
  fireReactionInProcess: (...a: unknown[]) => fireReactionInProcess(...a),
}));
// P-007 Phase C (D-028): complete.ts lazily imports the completion-verification store after a
// terminal close. Hermetic spies: by default nothing is spawned, applied or accepted, and an
// unset (reset) spy still resolves to that default so no other case grows a warning.
const cvStore = vi.hoisted(() => ({
  spawn: vi.fn(),
  applyVerdict: vi.fn(),
  acceptOnSettlement: vi.fn(),
}));
vi.mock('../../harness/improvements/completion-verification-store', () => ({
  spawnCompletionVerificationForClose: async (...a: unknown[]) => (await cvStore.spawn(...a)) ?? { outcome: 'no-dependents' },
  applyCompletionVerdictForClose: async (...a: unknown[]) => (await cvStore.applyVerdict(...a)) ?? null,
  acceptCompletionOnSettlementForSubject: async (...a: unknown[]) => (await cvStore.acceptOnSettlement(...a)) ?? null,
}));

// TEST-COMPLETION GATE (P-006): the flag + the gate helper are mocked so these unit tests
// exercise the gate WIRING in completeOne (flag-off skips, flag-on consults, refusal blocks)
// without PG. The default beforeEach state is flag OFF + gate OK (= today's behavior).
const getFlag = vi.fn();
const completionBriefPort = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../code-intelligence/task-brief', () => ({
  getCompletionTimeBrief: (...args: unknown[]) => completionBriefPort.read(...args),
}));
// `onFlagChange` is required even though this suite never exercises it: importing
// locks/configure.ts pulls in txn-timeouts-config.ts, which calls onFlagChange() at
// MODULE SCOPE (D-010 event-driven refresh). A mock omitting it fails the whole file
// at COLLECTION with `No "onFlagChange" export is defined`, i.e. 0 tests run.
vi.mock('@papercusp/flags/server', () => ({
  getFlag: (...a: unknown[]) => getFlag(...a),
  onFlagChange: () => {},
}));
const specTestAdequacyCompletionGate = vi.fn();
vi.mock('./spec-test-adequacy-gate', () => ({
  specTestAdequacyCompletionGate: (...a: unknown[]) => specTestAdequacyCompletionGate(...a),
}));
// P-008 (derived-status-not-hand-written-2026-10-12): the completion prefill reads the
// holder's read-time mechanics. Default null = no ledger evidence, so every other case in
// this file keeps the completion exactly as supplied.
const readWorkItemMechanicsMock = vi.hoisted(() => vi.fn(async (..._a: unknown[]): Promise<unknown> => null));
vi.mock('./_mechanics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_mechanics')>()),
  readWorkItemMechanics: (...a: unknown[]) => readWorkItemMechanicsMock(...a),
  pgMechanicsLedger: () => ({}),
}));
const dispatchPendingGradingAudits = vi.hoisted(() => vi.fn());
vi.mock('../../grading-integrity', () => ({
  dispatchPendingGradingAudits: (...a: unknown[]) => dispatchPendingGradingAudits(...a),
}));
// P-011 / R-10: the close-coverage READ is replaced (it queries Postgres); the warning TEXT
// builder stays real, so the door cases below assert the words a closer actually receives.
const closeCoverageRead = vi.hoisted(() => ({ compute: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) }));
vi.mock('../../work-item-close-coverage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../work-item-close-coverage')>()),
  computeCloseCoverage: (...a: unknown[]) => closeCoverageRead.compute(...a),
}));

import { z } from 'zod';

type JsonSchemaNode = {
  $ref?: string;
  [key: string]: unknown;
};

type JsonSchemaDocument = JsonSchemaNode & {
  $defs?: Record<string, JsonSchemaNode>;
};

function resolveLocalSchemaRef(root: { $defs?: Record<string, JsonSchemaNode> }, node: unknown): JsonSchemaNode {
  let current = (node ?? {}) as JsonSchemaNode;
  const seen = new Set<string>();

  while (typeof current.$ref === 'string') {
    const ref = current.$ref;
    const prefix = '#/$defs/';
    if (!ref.startsWith(prefix) || seen.has(ref)) return current;
    seen.add(ref);
    current = root.$defs?.[ref.slice(prefix.length)] ?? current;
  }

  return current;
}
import complete, {
  WORK_ITEMS_COMPLETE_TIMEOUT_SEC,
  WORK_ITEMS_COMPLETION_CONTRACT,
  claimsUniversalVerification,
  contentIdentityAdviceForOrigin,
  completionEphemeralDeliverableReferences,
  isVerificationWorkItem,
} from './complete';
import {
  COMPLETION_FIELDS,
  COMPLETION_OBJECT_EXAMPLE,
  COMPLETION_STRING_REJECTION,
  coerceCompletionShape,
  describeUnparseableCompletionJsonString,
  gatherFlatCompletion,
  hoistMisplacedCompletionFields,
} from './completion-coerce';
import { BUDGET, promptWeight } from '../tool-guidance-budget';
import { CHANGE_KIND_GATE_CUTOVER } from '../../change-kind-proof';
import {
  COMPLETION_SETTLEMENT_MANIFEST_CONTRACT,
  hasEnumeratedVerificationCoverage,
} from '../../coord-lifecycle/records';

vi.mock('../../blueprint/phone-producer-admission', () => ({
  configuredPhoneProducerCompletionAttempt: vi.fn(async () => ({ binding: { kind: 'external-runtime-producer' },
    updatedTs: 1, readStoredOutcome: async () => ({}) })),
}));

const ctxFields = { uiClientId: 'su-tester', isSuperuser: true, workspaceId: 'default' };
const ctx = ctxFields as never;

describe('work_items:complete — ambient workspace transaction safety (EI-20194230704550984)', () => {
  it('opts out because completion owns its workspace-scoped ledger operations', () => {
    expect((complete as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });
});

describe('work_items:complete — prompt budget (EI-20189722405308981)', () => {
  it('stays within the shared guidance budget', () => {
    expect(promptWeight(complete as Parameters<typeof promptWeight>[0])).toBeLessThanOrEqual(BUDGET);
    expect(complete.guidance?.seeAlso).toContain(COMPLETION_SETTLEMENT_MANIFEST_CONTRACT);
  });

  it('publishes closed→dropped semantics so successful work is not marked discarded', () => {
    expect(complete.description).toContain('terminal closes use `passed`/`deprecated` (feature/chunk)');
    expect(complete.description).toContain('`done`/`dropped` aliases are accepted');
    expect(complete.description).toContain('`closed`/`deprecated` discard work');
    expect(complete.guidance?.when).toContain('Use discard states only for discard/wontfix');
    expect(complete.guidance?.when).toContain('each entry exactly once across checked/notChecked/notApplicable');
    expect(complete.guidance?.when).toContain('residue is separate (`[]` or `["none"]` means zero)');
    expect(complete.guidance?.when).toContain('required `assumptions`');
    expect(complete.guidance?.when).toContain('`testsRun`, `testResult`, `verifiedHow`, and `filesChanged` at the root of `completion`');
    expect(complete.guidance?.when).toContain('single-item call also accepts those fields at the argument root as legacy aliases');
    expect(complete.guidance?.when).not.toContain('testFingerprint?');
  });
});

/**
 * P-017 (b) gate #2 / D-050: `assumptions` is REQUIRED for terminal close intent, but
 * not for D-004 record-only completions. These ~100 tests are about completion semantics,
 * not about the gate, so the helper supplies the field exactly as a real caller must for
 * close-shaped cases — keeping each test testing what it was written to test. The
 * conditional gate has dedicated raw-schema and handler tests which never go through
 * this helper.
 */
const ROOT_CAUSE_VERIFICATION_FIXTURE = {
  contractVersion: 2 as const,
  hypothesis: 'the stale cache supplied the wrong value',
  alternativeHypothesis: 'the database writer persisted the wrong value',
  distinguishingTest:
    'if the stale-cache hypothesis is true then a direct database read is correct; if the writer hypothesis is true then the direct database read is wrong',
  testResult: 'before the fix, the direct database read was correct while the cached read was stale',
  testProcedure: 'Read the value directly from the database, then through the cache, before applying the fix.',
  predictedObservations: {
    hypothesis: 'the direct database read is correct while the cached read is stale',
    alternativeHypothesis: 'both the direct database read and the cached read are wrong',
  },
  actualObservation: 'the direct database read was correct while the cached read was stale',
  evidenceRefs: ['test:complete.test.ts#root-cause-fixture'],
};

const withAssumptions = (x: unknown): unknown => {
  if (typeof x !== 'object' || x === null) return x;
  const o = { ...(x as Record<string, unknown>) };
  const withCompletionContract = (value: unknown, fallbackState?: unknown): unknown => {
    if (typeof value !== 'object' || value === null) return value;
    const item = { ...(value as Record<string, unknown>) };
    const completion = item.completion;
    const state = String(
      item.state ??
        fallbackState ??
        (typeof completion === 'object' && completion !== null && !Array.isArray(completion)
          ? (completion as Record<string, unknown>).status
          : '') ??
        '',
    )
      .trim()
      .toLowerCase();
    // A record-only fixture must stay record-only. Automatically adding the
    // terminal-close declaration to every test input masked omitted-state bugs.
    if (item.assumptions === undefined && state) item.assumptions = 'none';
    if (!state && item.recordOnly === undefined) item.recordOnly = true;
    if (completion === undefined && ['done', 'resolved', 'passed'].includes(state)) {
      item.rootCauseVerification = ROOT_CAUSE_VERIFICATION_FIXTURE;
      return item;
    }
    if (typeof completion !== 'object' || completion === null || Array.isArray(completion)) return item;
    const completionRecord = completion as Record<string, unknown>;
    if (['done', 'resolved', 'passed'].includes(state) && completionRecord.rootCauseVerification === undefined) {
      item.completion = { ...completionRecord, rootCauseVerification: ROOT_CAUSE_VERIFICATION_FIXTURE };
    }
    return item;
  };
  if (Array.isArray(o.items)) {
    o.items = o.items.map((it) => withCompletionContract(it, o.state));
  } else {
    return withCompletionContract(o);
  }
  return o;
};

const parse = (x: unknown) => (complete.args as { parse: (x: unknown) => unknown }).parse(withAssumptions(x));
type Out = { data: any };
/** Full envelope. */
const env = async (x: unknown) => {
  const res = (await complete.handler(parse(x) as never, ctx)) as Out;
  return res.data;
};
/** The single (n=1) result item — the dual-arity verb wraps it in the bulk envelope. */
const one = async (x: unknown) => (await env(x)).results[0];
const parseRaw = (x: unknown) => (complete.args as { parse: (x: unknown) => unknown }).parse(x);
const envRaw = async (x: unknown) => {
  const res = (await complete.handler(parseRaw(x) as never, ctx)) as Out;
  return res.data;
};
const oneRaw = async (x: unknown) => (await envRaw(x)).results[0];

const item = { id: 'F-12', kind: 'feature', family: 'feature', state: 'in_progress', harness: 'papercup' };

/** A clean (non-aliased) setWorkItemStateWithAliasInfo resolution: the item lands
 *  exactly on the state it already carries — mirrors the common "it worked" mock. */
function okState(workItem: Record<string, unknown>) {
  return {
    workItem,
    aliased: false,
    requestedState: workItem.state as string,
    appliedState: workItem.state as string,
  };
}

beforeEach(() => {
  directiveRecovery.closureError.mockReset().mockResolvedValue(null);
  contentIdentityPreview.stamp.mockReset();
  completionBriefPort.read.mockReset();
  completionBriefPort.read.mockResolvedValue(null);
  conformanceClosure.read.mockReset();
    conformanceClosure.read.mockResolvedValue({
      applicable: true,
      mappedRequirements: ['R-1'],
      declaredRequirements: ['R-1'],
      declarationSatisfied: true,
      refusal: null,
    });
  parkReachability.read.mockResolvedValue({
    verdict: 'reachable', basis: 'catalogued', evidence: 'catalogued unblocked producer is live',
  });
  resolveAdoptedName.mockReset();
  resolveAdoptedName.mockResolvedValue(null);
  dbMocks.planItemStatusRows.mockReset();
  dbMocks.planItemStatusRows.mockImplementation(async (strings: TemplateStringsArray) =>
    strings.join('').includes('SELECT 1 AS one FROM harness_shared.work_items wi') ? [] : [{ status: 'done' }],
  );
  contentionMocks.acquireWithContentionRetry.mockReset();
  contentionMocks.acquireWithContentionRetry.mockImplementation(async (run: () => Promise<unknown>) => run());
  hiveMocks.potHomeSlugForHarness.mockReset();
  hiveMocks.potHomeSlugForHarness.mockResolvedValue(null);
  getWorkItem.mockReset();
  assessWorkItemHeldOpenTerminalTransition.mockReset();
  assessWorkItemHeldOpenTerminalTransition.mockResolvedValue({ allowed: true, staleHoldOpen: false });
  workItemPlanLaneTransitionRefusal.mockReset();
  workItemPlanLaneTransitionRefusal.mockResolvedValue(null);
  listWorkItems.mockReset();
  listWorkItems.mockResolvedValue([]);
  setWorkItemStateWithAliasInfo.mockReset();
  setWorkItemClaimHold.mockReset();
  setWorkItemClaimHold.mockResolvedValue({ id: 'WI-1', harness: 'papercup', hold: true, applicable: true });
  mergeWorkItemOutputPayload.mockReset();
  // Default: gate flag OFF + (when consulted) gate OK — reproduces today's behavior. The
  // flag mock MUST resolve a promise so the `.catch(() => false)` guard in completeOne works.
  getFlag.mockReset();
  getFlag.mockResolvedValue(false);
  specTestAdequacyCompletionGate.mockReset();
  specTestAdequacyCompletionGate.mockResolvedValue({ ok: true, applicable: false, checked: [] });
  dispatchPendingGradingAudits.mockReset();
  dispatchPendingGradingAudits.mockResolvedValue({ requestedTargetIds: [], receipts: [] });
  resolveWorkItemRef.mockReset();
  linkWorkItem.mockReset();
  linkWorkItem.mockResolvedValue({ ok: true });
  subscribeWorkItem.mockReset();
  subscribeWorkItem.mockResolvedValue({ ok: true });
  setWorkItemCheckpoint.mockReset();
  setWorkItemCheckpoint.mockResolvedValue(null);
  getWorkItemCheckpoint.mockReset();
  getWorkItemCheckpoint.mockResolvedValue(null);
  fireReactionInProcess.mockReset();
  fireReactionInProcess.mockResolvedValue({ ok: true });
  attachCompletionEvidenceToSettledItem.mockReset();
  // Default: the row had no competing completion record, so the evidence was stored. Note
  // this is only REACHED when the item is already terminal AND no state was passed.
  attachCompletionEvidenceToSettledItem.mockResolvedValue({ outcome: 'recorded', workItem: null });
  commentWorkItem.mockReset();
  commentWorkItem.mockResolvedValue({ id: 'post-1' });
});

// ── EI-20286699547467039: unmet completion gates accumulate into ONE refusal ──────────
describe('P039 completion source brief delivery', () => {
  it('attaches the bounded pre-review brief after a successful close using declared changed files', async () => {
    const row = { id: 'WI-brief', kind: 'task', family: 'issue', state: 'open', harness: 'papercup' };
    getWorkItem.mockResolvedValue(row);
    setWorkItemStateWithAliasInfo.mockResolvedValue({ workItem: { ...row, state: 'done' }, appliedState: 'done', requestedState: 'done', aliased: false });
    getFlag.mockImplementation(async (name: string) => name === 'papercusp-code-intel-push-completion');
    const brief = { phase: 'pre-review', status: 'measured', testsWithoutRunEvidence: ['target.test.ts'], executionCoverage: 'unmeasured' };
    completionBriefPort.read.mockResolvedValue(brief);
    const result = await one({ id: 'WI-brief', state: 'done', completion: { summary: 'changed source',
      filesChanged: ['packages/operator-core/lib/code-intelligence/task-brief.ts'] } });
    expect(result.ok).toBe(true); expect(result.completionBrief).toEqual(brief);
    expect(completionBriefPort.read).toHaveBeenCalledWith(expect.objectContaining({
      harness: 'papercup', paths: ['packages/operator-core/lib/code-intelligence/task-brief.ts'],
    }), expect.objectContaining({ runs: expect.any(Function) }));
    const readRuns = completionBriefPort.read.mock.calls[0]![1].runs;
    // Telemetry stamps dispatch SETTLEMENT; the test finished before that stamp.
    // Model the real ledger's window predicate so a start/end mix-up cannot pass
    // by returning a matching row regardless of the SQL parameters.
    const settledAt = new Date();
    const invocation = { invoked_at: settledAt, duration_ms: 30_000, files: ['target.test.ts'], work_item_id: 'WI-brief' };
    const testFinishedAt = settledAt.getTime() - 250;
    dbMocks.planItemStatusRows.mockResolvedValueOnce([invocation]).mockImplementationOnce(
      (_sql: TemplateStringsArray, _paths: string[], from: Date, to: Date) => Promise.resolve(
        from.getTime() <= testFinishedAt && testFinishedAt <= to.getTime()
          ? [{ file_path: 'target.test.ts', status: 'pass', run_group_id: 'bound-run' }] : []));
    expect(await readRuns(['target.test.ts'])).toEqual([{ path: 'target.test.ts', status: 'pass', runGroupId: 'bound-run' }]);
    dbMocks.planItemStatusRows.mockResolvedValueOnce([invocation]).mockResolvedValueOnce([
      { file_path: 'target.test.ts', status: 'pass', run_group_id: 'bound-run' },
      { file_path: 'target.test.ts', status: 'pass', run_group_id: 'peer-run' },
    ]);
    expect(await readRuns(['target.test.ts'])).toBeNull();
    dbMocks.planItemStatusRows.mockResolvedValueOnce([{ ...invocation, work_item_id: 'WI-foreign' }]);
    expect(await readRuns(['target.test.ts'])).toBeNull();
    dbMocks.planItemStatusRows.mockRejectedValueOnce(new Error('ledger unavailable'));
    expect(await readRuns(['target.test.ts'])).toBeNull();
  });
  it('does not start source analysis on a record-only completion', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-brief', kind: 'task', family: 'issue', state: 'open', harness: 'papercup' });
    getFlag.mockResolvedValue(true);
    await one({ id: 'WI-brief', recordOnly: true, completion: { summary: 'record only', filesChanged: ['target.ts'] } });
    expect(completionBriefPort.read).not.toHaveBeenCalled();
  });
});

// The contract gates used to be sequential early-returns, so a caller violating three of
// them learned about them across three round-trips — one full model turn each. They now
// all evaluate and report together. The three tests below are a matched set and should
// stay that way: the accumulation test proves the feature, the CONTROL pins the
// byte-identical single-gate invariant that keeps every pre-existing caller valid, and the
// CALIBRATION proves the accumulator still lets a good completion through (without it, a
// gate that refused unconditionally would pass the first two tests).
describe('owner directive recovery must settle its directive before completing', () => {
  const recovery = { id: 'WI-recovery', kind: 'task', family: 'issue', state: 'open', harness: 'papercup',
    payload: { ownerDirectiveRecovery: { directiveId: 42 } } };
  it('refuses success before a directive disposition and writes no terminal transition', async () => {
    getWorkItem.mockResolvedValue(recovery);
    directiveRecovery.closureError.mockResolvedValue('Directive #42 is still open');
    const result = await one({ id: recovery.id, state: 'done', completion: { summary: 'Finished recovery' } });
    expect(result).toMatchObject({ ok: false, error: 'owner_directive_still_open' });
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });
  it('fails closed on an unreadable directive rather than treating it as settled', async () => {
    getWorkItem.mockResolvedValue(recovery);
    directiveRecovery.closureError.mockRejectedValue(new Error('database unavailable'));
    const result = await one({ id: recovery.id, state: 'done', completion: { summary: 'Finished recovery' } });
    expect(result).toMatchObject({ ok: false, error: 'owner_directive_verification_unavailable', retryable: true });
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });
  it('does not impose a directive check on ordinary work', async () => {
    getWorkItem.mockResolvedValue(item);
    await one({ id: item.id, completion: { summary: 'Ordinary progress' } });
    expect(directiveRecovery.closureError).not.toHaveBeenCalled();
  });
});

describe('EI-20286699547467039 — unmet completion gates accumulate into one refusal', () => {
  const bug = { id: 'WI-acc', kind: 'bug', family: 'issue', state: 'open', harness: 'papercup' };

  beforeEach(() => {
    getWorkItem.mockResolvedValue(bug);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...bug, state: 'done' }));
  });

  it('names BOTH unmet gates in one refusal instead of only the first', async () => {
    // `oneRaw` does not inject `assumptions` (unlike `one`), so this successful bug close
    // leaves TWO independent gates unmet on the same call: assumptions and the causal record.
    const r = await oneRaw({
      id: 'WI-acc',
      state: 'resolved',
      completion: { summary: 'fixed the cache', tests: '5 green' },
    });

    expect(r.ok).toBe(false);
    expect(r.unmetGateCount).toBe(2);
    // Each gate's message survives VERBATIM, so the caller learns the whole contract in one
    // turn and any consumer matching on a specific message still matches.
    expect(r.error).toMatch(/a terminal close requires `assumptions`/);
    expect(r.error).toMatch(/completion\.rootCauseVerification is missing/);
    // The complete-set header plus per-requirement evaluated marker distinguish listed
    // failures from later checks that were not reached on this call.
    expect(r.error).toMatch(/COMPLETE set as evaluated on this call/);
    expect(r.error).toMatch(/completionContract requirements with evaluated:false remain unassessed/);
    expect(r.completionContract.requirements.find((requirement: { key: string }) => requirement.key === 'change-kind-proof'))
      .toMatchObject({ evaluated: false, applicable: false, satisfied: null });
    // Typed side-fields still travel individually, so structured consumers are unaffected.
    expect(r.rootCauseVerificationError).toMatch(/completion\.rootCauseVerification is missing/);
    // Still atomic: accumulating must not push the refusal past the write boundary.
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    expect(r).not.toHaveProperty('completion');
    expect(r).not.toHaveProperty('workItem');
  });

  it('CONTROL — a single unmet gate refuses byte-identically to before accumulation', async () => {
    const r = await oneRaw({
      id: 'WI-acc',
      state: 'resolved',
      assumptions: 'none',
      completion: { summary: 'fixed the cache', tests: '5 green' },
    });

    expect(r.ok).toBe(false);
    // Exactly one gate unmet ⇒ `error` IS that gate's message, with no combined header and
    // no count field. This is what keeps every existing caller, test, and memorised
    // message valid; a regression here is a silent breaking change to the refusal contract.
    expect(r.error).toBe(r.rootCauseVerificationError);
    expect(r.unmetGateCount).toBeUndefined();
    expect(r.error).not.toMatch(/COMPLETE set as evaluated on this call/);
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('CALIBRATION — a completion meeting both gates still closes', async () => {
    const r = await oneRaw({
      id: 'WI-acc',
      state: 'resolved',
      assumptions: 'none',
      completion: {
        summary: 'fixed the cache',
        verifiedHow: 'automated-test',
        testsRun: 'vitest complete.test.ts',
        testResult: '5 green',
        rootCauseVerification: ROOT_CAUSE_VERIFICATION_FIXTURE,
      },
    });

    expect(r.ok).toBe(true);
    expect(r.unmetGateCount).toBeUndefined();
  });
});

describe('EI-18793465701838962 — contrastive root-cause verification gate', () => {
  const bug = { id: 'WI-root', kind: 'bug', family: 'issue', state: 'open', harness: 'papercup' };

  beforeEach(() => {
    getWorkItem.mockResolvedValue(bug);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...bug, state: 'done' }));
  });

  it('refuses a successful bug close without the causal record before any write', async () => {
    const r = await oneRaw({
      id: 'WI-root',
      state: 'resolved',
      assumptions: 'none',
      completion: { summary: 'fixed the cache', tests: '5 green' },
    });
    expect(r.ok).toBe(false);
    expect(r.rootCauseVerificationError).toMatch(/completion\.rootCauseVerification is missing/);
    expect(r.error).toMatch(/predictedObservations:\{hypothesis,alternativeHypothesis\}/);
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('distinguishes a top-level sibling from a missing nested required leaf', () => {
    const safeParse = (
      complete.args as { safeParse: (value: unknown) => { success: boolean; error?: unknown } }
    ).safeParse;
    const misplaced = safeParse({
      id: 'WI-root',
      state: 'resolved',
      assumptions: 'none',
      completion: { summary: 'fixed the cache' },
      rootCauseVerification: {
        hypothesis: 'the cache was stale',
        alternativeHypothesis: 'the writer stored a bad value',
        distinguishingTest: 'Compare a direct read with the cached read.',
        testResult: 'the direct read was correct',
      },
    });

    expect(misplaced.success).toBe(false);
    expect(String(misplaced.error)).toContain(
      'Move it inside completion.rootCauseVerification; the sibling placement is invalid.',
    );

    const missingLeaf = safeParse({
      id: 'WI-root',
      state: 'resolved',
      assumptions: 'none',
      completion: {
        summary: 'fixed the cache',
        rootCauseVerification: {
          hypothesis: 'the cache was stale',
          alternativeHypothesis: 'the writer stored a bad value',
          distinguishingTest: 'Compare a direct read with the cached read.',
        },
      },
    });

    expect(missingLeaf.success).toBe(false);
    expect(String(missingLeaf.error)).toContain('Missing required fields: testResult');
    expect(String(missingLeaf.error)).not.toContain('expected string, received undefined');
  });

  // EI-24866603915783845: a complete, well-formed close whose ONLY defect is a wrong-typed
  // completion field used to fall through to the generic close-shape message, which tells
  // the caller to pass `state` and `assumptions` they had already passed.
  it('names a wrong-typed completion field instead of the generic close-shape message', () => {
    const safeParse = (
      complete.args as { safeParse: (value: unknown) => { success: boolean; error?: unknown } }
    ).safeParse;
    const closeShape = /to CLOSE a work-item, pass \{ id, state, assumptions/;

    const single = safeParse({
      id: 'WI-typed',
      state: 'done',
      assumptions: 'none',
      completion: {
        summary: 'fixed the ramp printer',
        testsRun: 'p005-ramp.test.ts',
        addedTests: ['p005-ramp.test.ts: prints na for a null slowdown'],
      },
    });
    expect(single.success).toBe(false);
    expect(String(single.error)).toContain('completion.addedTests');
    expect(String(single.error)).toMatch(/boolean/);
    expect(String(single.error)).not.toMatch(closeShape);

    const bulk = safeParse({
      state: 'done',
      items: [
        {
          id: 'WI-typed',
          assumptions: 'none',
          completion: { summary: 'fixed it', addedTests: ['a.test.ts'] },
        },
      ],
    });
    expect(bulk.success).toBe(false);
    expect(String(bulk.error)).toContain('addedTests');
    expect(String(bulk.error)).not.toMatch(closeShape);

    // Calibration: a payload genuinely missing `completion` still gets the full close shape.
    const missingCompletion = safeParse({ id: 'WI-typed', state: 'done', assumptions: 'none' });
    expect(missingCompletion.success).toBe(false);
    expect(String(missingCompletion.error)).toMatch(closeShape);
  });

  it('names each historically wrong-typed nested verification field', () => {
    const safeParse = (
      complete.args as { safeParse: (value: unknown) => { success: boolean; error?: unknown } }
    ).safeParse;
    const closeShape = /to CLOSE a work-item, pass \{ id, state, assumptions/;
    const invalidFields = [
      ['testsRun', { suite: 'targeted real-PostgreSQL integration tests', runs: [] }],
      ['testResult', { total: 18, passed: 18, status: 'passed' }],
      ['verifiedHow', { method: 'recorded real-PostgreSQL runs' }],
    ] as const;

    for (const [field, value] of invalidFields) {
      const parsed = safeParse({
        id: 'WI-typed',
        state: 'done',
        assumptions: 'none',
        completion: { summary: 'recorded the verification result', [field]: value },
      });
      const diagnostic = String(parsed.error);

      expect(parsed.success).toBe(false);
      expect(diagnostic).toContain(`completion.${field}`);
      expect(diagnostic).not.toMatch(closeShape);
    }
  });

  it('names the wrong type on the legacy top-level verification alias', () => {
    const safeParse = (
      complete.args as { safeParse: (value: unknown) => { success: boolean; error?: unknown } }
    ).safeParse;
    const parsed = safeParse({
      id: 'WI-typed',
      state: 'done',
      assumptions: 'none',
      completion: { summary: 'fixed it' },
      verification: 'a plain string',
    });
    const diagnostic = String(parsed.error);

    expect(parsed.success).toBe(false);
    expect(diagnostic).toContain('completion.verification');
    expect(diagnostic).toMatch(/record|object/i);
    expect(diagnostic).not.toMatch(/to CLOSE a work-item, pass \{ id, state, assumptions/);
  });

  // EI-25240542476501298: the union message is lifted from a NESTED unrecognized-key issue
  // and the union node sits at the root, so without its path the refusal read like a stray
  // top-level arg (and the dispatcher listed top-level keys the caller had right).
  it('names WHERE a nested unrecognized key was rejected', () => {
    const safeParse = (
      complete.args as { safeParse: (value: unknown) => { success: boolean; error?: unknown } }
    ).safeParse;
    const entryKey = safeParse({
      id: 'WI-nested',
      state: 'done',
      assumptions: 'none',
      completion: {
        summary: 'did it',
        verification: {
          requirementDisposition: [
            { requirement: 'a verbatim requirement quote', disposition: 'implemented', citations: ['a.ts'], bogus: 1 },
          ],
        },
      },
    });
    expect(entryKey.success).toBe(false);
    expect(String(entryKey.error)).toContain('completion.verification.requirementDisposition.0: Unrecognized key: \\"bogus\\"');

    const misplaced = safeParse({
      id: 'WI-nested',
      state: 'done',
      assumptions: 'none',
      completion: {
        summary: 'did it',
        requirementDisposition: [{ requirement: 'a verbatim requirement quote', disposition: 'implemented' }],
      },
    });
    expect(misplaced.success).toBe(false);
    expect(String(misplaced.error)).toContain('completion: Unrecognized key: \\"requirementDisposition\\"');

    // Calibration: a stray TOP-LEVEL key keeps its pathless message.
    const top = safeParse({ id: 'WI-nested', state: 'done', assumptions: 'none', completion: { summary: 's' }, strayTop: 1 });
    expect(top.success).toBe(false);
    expect(String(top.error)).toContain('"message": "Unrecognized key: \\"strayTop\\""');
  });

  it('names the path and allowed values for an invalid requirement disposition', () => {
    const safeParse = (
      complete.args as { safeParse: (value: unknown) => { success: boolean; error?: unknown } }
    ).safeParse;
    const parsed = safeParse({
      id: 'WI-enum',
      state: 'done',
      assumptions: 'none',
      completion: {
        summary: 'did it',
        verification: {
          requirementDisposition: [
            { requirement: 'a verbatim requirement quote', disposition: 'delivered' },
          ],
        },
      },
    });
    const diagnostic = String(parsed.error);
    expect(parsed.success).toBe(false);
    expect(diagnostic).toContain('completion.verification.requirementDisposition.0.disposition');
    expect(diagnostic).toContain('implemented');
    expect(diagnostic).toContain('not-applicable');
    expect(diagnostic).toContain('deferred');
    expect(diagnostic).toContain('rejected');
    expect(diagnostic).not.toMatch(/to CLOSE a work-item, pass \\{ id, state, assumptions/);
  });

  // EI-25789682554301541: an unknown key and known fields with invalid types can
  // coexist in one completion. The matching union branch must still expose the
  // concrete schema failure instead of asking for state/assumptions already sent.
  it('keeps a useful diagnostic when unknown and mistyped completion fields coexist', () => {
    const safeParse = (
      complete.args as { safeParse: (value: unknown) => { success: boolean; error?: unknown } }
    ).safeParse;
    const parsed = safeParse({
      id: 'WI-mixed-shape',
      state: 'done',
      assumptions: 'none',
      completion: {
        summary: 'completed a mixed-shape close',
        testsRun: 'focused test passed',
        testResult: '1/1 passed',
        addedTests: ['this field must be boolean'],
        verification: { tests: 'this key is not part of verification evidence' },
        rootCauseVerification: 'this field must be a record',
        selfReview: 'this field must be a record',
      },
    });
    const typedOnly = safeParse({
      id: 'WI-typed-shape',
      state: 'done',
      assumptions: 'none',
      completion: {
        summary: 'completed with the recorded wrong-typed fields',
        status: 'resolved',
        rootCauseVerification: 'this field must be a record',
        selfReview: 'this field must be a record',
      },
    });
    const diagnostic = String(parsed.error);
    const typedDiagnostic = String(typedOnly.error);

    expect(parsed.success).toBe(false);
    expect(diagnostic).toContain('completion.verification');
    expect(diagnostic).toMatch(/Unrecognized key|not valid|invalid/i);
    expect(diagnostic).not.toContain('to CLOSE a work-item');
    expect(typedOnly.success).toBe(false);
    expect(typedDiagnostic).toContain('completion.rootCauseVerification');
    expect(typedDiagnostic).not.toContain('to CLOSE a work-item');
  });

  it('rejects a block whose structured predictions name the same observable', () => {
    const result = (
      complete.args as { safeParse: (value: unknown) => { success: boolean; error?: unknown } }
    ).safeParse({
      id: 'WI-root',
      state: 'resolved',
      assumptions: 'none',
      completion: {
        summary: 'fixed the cache',
        rootCauseVerification: {
          hypothesis: 'cache was stale',
          alternativeHypothesis: 'writer was stale',
          distinguishingTest: 'Compare the direct database read with the cached read.',
          testResult: 'value was wrong',
          predictedObservations: {
            hypothesis: 'the direct read is wrong',
            alternativeHypothesis: 'the direct read is wrong',
          },
        },
      },
    });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/predictedObservations.*must be meaningfully different/);
  });

  it('accepts a plain procedure description when typed predictions distinguish the hypotheses', async () => {
    const r = await oneRaw({
      id: 'WI-root',
      state: 'resolved',
      assumptions: 'none',
      completion: {
        summary: 'fixed the callback parser',
        tests: '4 green',
        rootCauseVerification: {
          hypothesis: 'the missing callback brace caused the parser failure',
          alternativeHypothesis: 'the callback writer supplied an invalid handler',
          distinguishingTest: 'Inspect the callback parser and compare both handlers with the same fixture.',
          testResult: 'the parser reported a syntax error before the fix',
          testProcedure: 'Parse the same callback once with the missing brace and once with a known-valid handler.',
          predictedObservations: {
            hypothesis: 'the parser reports a syntax error for the missing-brace callback',
            alternativeHypothesis: 'the parser invokes the known-valid callback successfully',
          },
          actualObservation: 'the missing-brace callback produced the syntax error and the control callback ran',
          evidenceRefs: ['test:complete.test.ts#conditional-prose'],
        },
      },
    });

    expect(r.ok).toBe(true);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'WI-root',
      'resolved',
      expect.objectContaining({
        completionEvidence: expect.objectContaining({
          rootCauseVerification: expect.objectContaining({
            distinguishingTest: expect.stringContaining('Inspect the callback parser'),
          }),
        }),
      }),
    );
  });

  it('accepts and persists a contrastive record on a successful bug close', async () => {
    const r = await oneRaw({
      id: 'WI-root',
      state: 'resolved',
      assumptions: 'none',
      completion: {
        summary: 'fixed the cache',
        tests: '5 green',
        rootCauseVerification: ROOT_CAUSE_VERIFICATION_FIXTURE,
      },
    });
    expect(r.ok).toBe(true);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'WI-root',
      'resolved',
      expect.objectContaining({
        completionEvidence: expect.objectContaining({
          rootCauseVerification: ROOT_CAUSE_VERIFICATION_FIXTURE,
        }),
      }),
    );
  });

  it('returns every missing causal-evidence v2 field together without writing', async () => {
    const r = await oneRaw({
      id: 'WI-root',
      state: 'resolved',
      assumptions: 'none',
      completion: {
        summary: 'fixed the cache',
        tests: '5 green',
        rootCauseVerification: {
          hypothesis: 'the cache was stale',
          alternativeHypothesis: 'the writer stored a bad value',
          distinguishingTest: 'if H1 then direct read is correct; if H2 then direct read is wrong',
          testResult: 'the direct read was correct',
        },
      },
    });

    expect(r.ok).toBe(false);
    expect(r.missingRootCauseVerificationFields).toEqual([
      'testProcedure',
      'predictedObservations.hypothesis',
      'predictedObservations.alternativeHypothesis',
      'actualObservation',
      'evidenceRefs',
    ]);
    expect(r.error).toMatch(/causal-evidence contract v2/);
    expect(r.completionContract.version).toBe(WORK_ITEMS_COMPLETION_CONTRACT.version);
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('keeps validateOnly isolated across projected dispatch and an interleaved close', async () => {
    const rows = new Map<string, Record<string, unknown>>([
      ['WI-preview-target', { ...item, id: 'WI-preview-target', kind: 'bug', family: 'issue', state: 'open' }],
      ['WI-preview-other', { ...item, id: 'WI-preview-other', kind: 'bug', family: 'issue', state: 'open' }],
    ]);
    const stateWrites: string[] = [];
    getWorkItem.mockImplementation(async (id: string) => rows.get(id) ?? null);
    setWorkItemStateWithAliasInfo.mockImplementation(async (id: string, requestedState: string) => {
      const previous = rows.get(id);
      if (!previous) throw new Error(`missing projected-dispatch fixture ${id}`);
      const appliedState = requestedState === 'resolved' ? 'done' : requestedState;
      const workItem = { ...previous, state: appliedState };
      rows.set(id, workItem);
      stateWrites.push(id);
      return {
        workItem,
        aliased: appliedState !== requestedState,
        requestedState,
        appliedState,
      };
    });

    const completion = {
      summary: 'Verify that a completion preview remains read-only across projected dispatch.',
      verifiedHow: 'unit',
      testsRun: 'complete.test.ts projected-dispatch regression',
      testResult: 'The preview preserved both open rows until their explicit close calls.',
      filesChanged: [],
      rootCauseVerification: ROOT_CAUSE_VERIFICATION_FIXTURE,
    };
    const args = (id: string, validateOnly?: boolean) => ({
      id,
      harness: 'papercusp',
      state: 'resolved',
      assumptions: 'none',
      changeKinds: ['no-code-change'],
      changeKindReason: 'The projected-dispatch fixture changes no source files.',
      ...(validateOnly === undefined ? {} : { validateOnly }),
      completion,
    });
    const projected = lookupByMcpName('work_items:complete');
    expect(projected).toBeTruthy();
    const dispatch = async (input: unknown, runId: string) => {
      const result = await dispatchProjectedTool(
        projected!,
        'work_items:complete',
        input,
        {
          ...ctxFields,
          log: vi.fn(),
          signal: new AbortController().signal,
          progress: vi.fn(),
          emit: vi.fn(),
          metadata: vi.fn(),
          workspaceId: 'default',
          harnessSlug: 'papercusp',
          runId,
          role: 'su',
          gateBypass: { role: true, capability: true, quota: true },
          transport: 'mcp',
          requestedFormat: 'json',
          requestedStructured: true,
        } as never,
        {},
      );
      expect(result.ok).toBe(true);
      const data = result.result?.structuredContent as { results?: Array<Record<string, unknown>> } | undefined;
      expect(data?.results).toHaveLength(1);
      return data!.results![0]!;
    };

    const otherPreview = await dispatch(args('WI-preview-other', true), 'complete-preview-other');
    const targetPreview = await dispatch(args('WI-preview-target', true), 'complete-preview-target');
    expect(otherPreview).toMatchObject({ ok: true, validationOnly: true, completionAuthority: 'committed' });
    expect(targetPreview).toMatchObject({ ok: true, validationOnly: true, completionAuthority: 'committed' });
    expect(rows.get('WI-preview-other')?.state).toBe('open');
    expect(rows.get('WI-preview-target')?.state).toBe('open');
    expect(stateWrites).toEqual([]);

    const otherClose = await dispatch(args('WI-preview-other'), 'complete-close-other');
    expect(otherClose.ok).toBe(true);
    expect(rows.get('WI-preview-other')?.state).toBe('done');
    expect(rows.get('WI-preview-target')?.state).toBe('open');
    expect(stateWrites).toEqual(['WI-preview-other']);

    const targetClose = await dispatch(args('WI-preview-target', false), 'complete-close-target');
    expect(targetClose).toMatchObject({ ok: true, finish: { complete: true, workItemState: 'done' } });
    expect(rows.get('WI-preview-target')?.state).toBe('done');
    expect(stateWrites).toEqual(['WI-preview-other', 'WI-preview-target']);
  });

  it('validates the full versioned contract without mutating or emitting a completion', async () => {
    const r = await oneRaw({
      id: 'WI-root',
      state: 'resolved',
      assumptions: 'none',
      validateOnly: true,
      completion: {
        summary: 'fixed the cache',
        verifiedHow: 'automated-test',
        testsRun: 'vitest complete.test.ts',
        testResult: '5 green',
        rootCauseVerification: ROOT_CAUSE_VERIFICATION_FIXTURE,
      },
    });

    expect(r).toMatchObject({
      ok: true,
      id: 'WI-root',
      validationOnly: true,
      completionContract: { version: WORK_ITEMS_COMPLETION_CONTRACT.version },
    });
    expect(r.completionContract.requirements).toHaveLength(WORK_ITEMS_COMPLETION_CONTRACT.requirements.length);
    expect(r.completionContract.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'assumptions', applicable: true, satisfied: true }),
        expect.objectContaining({ key: 'root-cause-verification', applicable: true, satisfied: true }),
      ]),
    );
    expect(r).not.toHaveProperty('completion');
    expect(r).not.toHaveProperty('workItem');
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    expect(mergeWorkItemOutputPayload).not.toHaveBeenCalled();
  });

  it.each([
    ['content-mismatch', { workingTreeBlobSha: 'b'.repeat(40), headBlobSha: 'c'.repeat(40) }],
    ['missing-from-commit', { workingTreeBlobSha: 'b'.repeat(40), headBlobSha: null, gitIgnoreStatus: 'not-ignored' }],
    ['object unavailable', { workingTreeBlobSha: 'b'.repeat(40), headBlobSha: null, headBlobUnresolvable: 'object unavailable' }],
  ])('EI-26592766858681844: preview explains %s without recording a close', async (reason, identity) => {
    const path = 'packages/operator-core/lib/agent-tools/work_items/complete.ts';
    const closeItem = { ...item, id: 'WI-content-preview', kind: 'change', family: 'issue', state: 'open' };
    getWorkItem.mockResolvedValue(closeItem);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...closeItem, state: 'resolved' }));
    contentIdentityPreview.stamp.mockResolvedValue({
      headSha: 'a'.repeat(40),
      contentIdentity: [{ path, ...identity }],
    });
    const args = {
      id: closeItem.id,
      state: 'resolved',
      assumptions: 'none',
      completion: { summary: 'Verified focused behavior', verifiedHow: 'unit', testResult: 'passed', filesChanged: [path] },
    };
    const preview = await oneRaw({ ...args, validateOnly: true });
    expect(preview).toMatchObject({ ok: true, validationOnly: true, completionAuthority: 'proposed', countsTowardBurnDown: false });
    expect(preview.authorityWarning).toContain(path);
    expect(preview.authorityWarning).toContain(reason);
    expect(preview.authorityWarning).toContain("would land authority:'proposed'");
    expect(preview.authorityWarning).toContain('has not recorded a close or a settlement manifest');
    expect(preview.authorityWarning).not.toMatch(/is CLOSED|WAITING SETTLES|evidence was accepted/);
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    expect(mergeWorkItemOutputPayload).not.toHaveBeenCalled();

    const closed = await oneRaw(args);
    expect(closed.completionAuthority).toBe(preview.completionAuthority);
    expect(closed.authorityWarning).toContain(path);
    expect(closed.authorityWarning).toContain(reason);
  });

  it('EI-26592766858681844: matching content has no preview authority warning', async () => {
    const path = 'packages/operator-core/lib/agent-tools/work_items/complete.ts';
    getWorkItem.mockResolvedValue({ ...item, id: 'WI-content-preview', kind: 'change', family: 'issue', state: 'open' });
    contentIdentityPreview.stamp.mockResolvedValue({
      headSha: 'a'.repeat(40),
      contentIdentity: [{ path, workingTreeBlobSha: 'b'.repeat(40), headBlobSha: 'b'.repeat(40) }],
    });
    const preview = await oneRaw({
      id: 'WI-content-preview', state: 'resolved', assumptions: 'none', validateOnly: true,
      completion: { summary: 'Verified focused behavior', verifiedHow: 'unit', testResult: 'passed', filesChanged: [path] },
    });
    expect(preview.completionAuthority).toBe('committed');
    expect(preview.authorityWarning).toBeUndefined();
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    expect(mergeWorkItemOutputPayload).not.toHaveBeenCalled();
  });

  it('refuses a nonholder held-open terminal preview with the shared writer reason', async () => {
    const closeItem = {
      ...item,
      id: 'WI-held-open-preview',
      kind: 'bug',
      family: 'issue',
      state: 'open',
      payload: { held_open_by: 'su-peer', held_open_reason: 'release criterion pending' },
    };
    const refusal = "work_item 'WI-held-open-preview' is HELD OPEN by su-peer — closing it into 'resolved' requires the holder.";
    getWorkItem.mockResolvedValue(closeItem);
    assessWorkItemHeldOpenTerminalTransition.mockResolvedValue({
      allowed: false,
      staleHoldOpen: false,
      refusal,
    });

    const preview = await one({
      id: closeItem.id,
      state: 'resolved',
      validateOnly: true,
      completion: { summary: 'verified', testsRun: 'complete.test.ts', testResult: 'passed' },
    });

    expect(preview).toMatchObject({
      ok: false,
      validationOnly: true,
      error: refusal,
      stateError: refusal,
    });
    expect(assessWorkItemHeldOpenTerminalTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        id: closeItem.id,
        payload: closeItem.payload,
        currentState: 'open',
        targetState: 'resolved',
        by: 'su-tester',
      }),
    );
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('settles validateOnly with the same authority as the identical real close', async () => {
    const closeItem = {
      ...item,
      id: 'WI-validate-settlement',
      kind: 'change',
      family: 'issue',
      state: 'open',
      title: 'Bind the test result to a real run and require that run to be a PASS before closing this change.',
      summary:
        'The close must account for deferred work against the originating requirement, preserve the exact requested behavior, and record a durable follow-up for anything still outstanding.',
    };
    const completion = {
      summary: 'implemented the change',
      verifiedHow: 'unit',
      testResult: 'focused test passed',
      filesChanged: ['packages/operator-core/lib/agent-tools/work_items/complete.ts'],
      deferred: ['live deployment remains pending'],
    };
    getWorkItem.mockResolvedValue(closeItem);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...closeItem, state: 'resolved' }));

    const validation = await oneRaw({
      id: closeItem.id,
      state: 'resolved',
      assumptions: 'none',
      validateOnly: true,
      completion,
    });

    expect(validation).toMatchObject({
      ok: true,
      validationOnly: true,
      completionAuthority: 'proposed',
      countsTowardBurnDown: false,
      completionEvidenceFindings: {
        requirementDispositionShortfall: { kind: 'absent' },
      },
    });
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();

    const realClose = await oneRaw({
      id: closeItem.id,
      state: 'resolved',
      assumptions: 'none',
      completion,
    });

    expect(realClose.completionAuthority).toBe(validation.completionAuthority);
    expect(realClose.countsTowardBurnDown).toBe(validation.countsTowardBurnDown);
    expect(realClose.authorityWarning).toMatch(/authority:'proposed'/);
    expect(realClose.requirementShortfallWarning).toContain(
      'each `implemented` entry passes `citations: ["repo/relative/path.ts"]`',
    );
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledTimes(1);
  });

  it('keeps discard/wontfix bug closes drainable without inventing a causal record', async () => {
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...bug, state: 'dropped' }));
    const r = await oneRaw({
      id: 'WI-root',
      state: 'dropped',
      assumptions: 'none',
      completion: { summary: 'obsolete duplicate', tests: 'n/a' },
    });
    expect(r.ok).toBe(true);
  });

  it('recognizes an explicit capability-gap tag without treating prose mentions as a type', async () => {
    getWorkItem.mockResolvedValue({ ...bug, id: 'WI-gap', kind: 'change', tags: ['capability-gap'] });
    const r = await oneRaw({
      id: 'WI-gap',
      state: 'resolved',
      assumptions: 'none',
      completion: { summary: 'filled the missing capability', tests: '4 green' },
    });
    expect(r.ok).toBe(false);
    expect(r.rootCauseVerificationError).toMatch(/successful capability-gap close/);
  });
});

// ── EI-11507: idempotent-completion opt-in (false-timeout fix) ───────────────────────────
// A completion whose wall-clock beat the 55s transport deadline STILL COMMITTED (the finish
// saga is documented retry-safe). Declaring `idempotent: true` opts the tool into the dispatch
// abort-race branch (dispatch-stack.ts) that surfaces the TRUTHFUL success instead of a spurious
// `timeout`, so the caller stops the mandatory *:get verify-read + partial-batch reconciliation.
// The abort-race branch itself is exercised in libs/generic/tooldef dispatch-projected.test.ts;
// this pins the missing link — that THIS mutation tool actually declares the flag, mirroring
// plans:set-status's own W6/P-007 remediation.
describe('work_items:complete idempotent-completion opt-in (EI-11507)', () => {
  it('declares idempotent:true so a committed-but-slow completion surfaces success, not a false timeout', () => {
    expect((complete as { idempotent?: boolean }).idempotent).toBe(true);
  });
});

describe('work_items:complete deadline budget (EI-22361433147291495)', () => {
  it('declares the 120s server budget that the MCP transport extends to 125s', () => {
    expect(WORK_ITEMS_COMPLETE_TIMEOUT_SEC).toBe(120);
    expect((complete as { timeoutSec?: number }).timeoutSec).toBe(WORK_ITEMS_COMPLETE_TIMEOUT_SEC);
  });
});

describe('work_items:complete (keyed-array)', () => {
  it('errors cleanly per item when the work-item does not exist', async () => {
    getWorkItem.mockResolvedValue(null);
    const out = await env({ id: 'F-404', completion: { workItem: 'F-404', summary: 'x' } });
    // EI-14676: for the single-item shorthand, top-level `ok` IS the item's own outcome —
    // a not-found is a real non-convergence, so the envelope-level `ok` must say so too,
    // not just the nested per-item result.
    expect(out).toMatchObject({ ok: false, counts: { ok: 0, failed: 1 } });
    expect(out.results[0]).toEqual({ ok: false, id: 'F-404', error: "work_item 'F-404' not found" });
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('EI-26068584723658382: names the exact open claim after a shortened id miss', async () => {
    getWorkItem.mockResolvedValue(null);
    listWorkItems.mockResolvedValue([
      { id: 'WI-6554700010013312', state: 'open', harness: 'papercusp' },
    ]);

    const out = await env({ id: 'WI-6554700013312', completion: { summary: 'x' } });

    expect(out.results[0].ok).toBe(false);
    expect(out.results[0].error).toContain("work_item 'WI-6554700013312' not found.");
    expect(out.results[0].error).toContain('WI-6554700010013312');
    expect(out.results[0].error).toContain('re-read the exact id');
    expect(listWorkItems).toHaveBeenCalledWith({
      assignee: 'su-tester',
      harness: undefined,
      notTerminal: true,
      limit: 20,
    });
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  // EI-19285045282744205: a DB-connection fault reading the item must surface as a
  // connection error, NEVER as the crafted "not found" text — the two are different
  // facts (unreachable vs authoritative absence) with different correct responses.
  // completeOne calls getWorkItem with no `.catch()` (unlike the swallowed sibling
  // sites WI-6746 fixed elsewhere — claim.ts/checkpoint.ts/hold_open.ts/etc.), so the
  // real `runBulk` (unmocked here) catches the throw and reports `error.message` — this
  // pins that the current code already does NOT collapse "could not ask" into "not found".
  it('EI-19285045282744205: a getWorkItem CONNECTION FAULT surfaces its own message, never "not found"', async () => {
    getWorkItem.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:19715'));
    const out = await env({ id: 'WI-6731', completion: { summary: 'x' } });
    expect(out).toMatchObject({ ok: false, counts: { ok: 0, failed: 1 } });
    expect(out.results[0].error).toBe('connect ECONNREFUSED 127.0.0.1:19715');
    expect(out.results[0].error).not.toMatch(/not found/);
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('EI-14676: single-item envelope-level `ok` mirrors the item outcome (false when the state write did not land)', async () => {
    getWorkItem.mockResolvedValue({ ...item, id: 'WI-9', kind: 'task', family: 'issue' });
    setWorkItemStateWithAliasInfo.mockRejectedValue(new Error('boom'));
    const out = await env({ id: 'WI-9', state: 'resolved', completion: { summary: 'landed' } });
    expect(out.ok).toBe(false); // envelope-level, not just results[0].ok
    expect(out.results[0].ok).toBe(false);
  });

  // EI-23737206446729041 (completing EI-14676): this case used to assert the OPPOSITE — that an
  // explicit items:[…] batch kept envelope `ok:true` over a failed item, on the reasoning that
  // `ok` meant "the batch ran". That is the defect EI-14676 asked to remove ("the caller-visible
  // `ok` must be false at the TOP level, not just buried per-item"); it was only ever rescued for
  // the single-item form, leaving the batch form truthy over a failure. runBulk now derives the
  // envelope's ok from results[].ok, so the batch form reports it too. The test's INTENT — a
  // partial failure must be detectable without opening results[] — is unchanged and now actually
  // holds for both forms.
  it('EI-14676: an explicit items:[…] batch reports envelope `ok:false` when any item fails', async () => {
    getWorkItem.mockImplementation(async (id: string) => (id === 'F-404' ? null : { ...item, id }));
    const out = await env({
      items: [
        { id: 'F-1', completion: { summary: 'a' } },
        { id: 'F-404', completion: { summary: 'b' } },
      ],
    });
    expect(out.ok).toBe(false); // derived from results[].ok — never truthy over a failed item
    expect(out.counts).toEqual({ ok: 1, failed: 1 });
    // counts still carries the PARTIAL-vs-TOTAL distinction the boolean cannot.
    expect(out.counts.ok).toBeGreaterThan(0);
  });

  it('EI-23737206446729041: an all-succeeding batch is still envelope `ok:true`', async () => {
    getWorkItem.mockImplementation(async (id: string) => ({ ...item, id }));
    const out = await env({
      items: [
        { id: 'F-1', completion: { summary: 'a' } },
        { id: 'F-2', completion: { summary: 'b' } },
      ],
    });
    expect(out.ok).toBe(true);
    expect(out.counts).toEqual({ ok: 2, failed: 0 });
  });

  it('records + returns the completion WITHOUT changing state when `state` omitted', async () => {
    getWorkItem.mockResolvedValue(item);
    const r = await one({
      id: 'F-12',
      completion: {
        workItem: 'F-12',
        summary: 'all phases done',
        tests: '40 green',
        migrations: ['137 add cols'],
        deferred: ['live smoke pending'],
      },
    });
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.id).toBe('F-12');
    expect(r.workItem).toMatchObject({ id: 'F-12' });
    expect(r.completion.summary).toBe('all phases done');
    expect(r.completion.deferred).toEqual(['live smoke pending']);
    expect(r.completion.status).toBe('done'); // defaulted
    expect(r.completion.agent).toBeTruthy(); // filled from identity
  });

  it('transitions to the terminal state when `state` provided', async () => {
    getWorkItem.mockResolvedValue(item);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
    const r = await one({ id: 'F-12', state: 'passed', completion: { workItem: 'F-12', summary: 'shipped' } });
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'F-12',
      'passed',
      expect.objectContaining({ by: expect.any(String) }),
    );
    expect(r.workItem.state).toBe('passed');
    expect(r.ok).toBe(true);
    expect(r.finish).toMatchObject({
      complete: true,
      checkpointCleared: true,
      planItem: 'not-linked',
      claimRelease: 'not-linked',
    });
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'papercup', workItemId: 'F-12' }),
      null,
    );
  });

  describe('boundaryNote — terminal-safe successor continuity', () => {
    const close = (boundaryNote?: string) =>
      one({
        id: 'F-12',
        state: 'passed',
        ...(boundaryNote === undefined ? {} : { boundaryNote }),
        completion: { workItem: 'F-12', summary: 'shipped', tests: '40 green' },
      });

    it('posts the note after finish cleanup and reports the durable post', async () => {
      getWorkItem.mockResolvedValue(item);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));

      const r = await close('successor: continue from the verified staging result');

      expect(r.ok).toBe(true);
      expect(r.boundaryNotePosted).toBe(true);
      expect(r.boundaryNoteError).toBeUndefined();
      expect(commentWorkItem).toHaveBeenCalledWith(
        'F-12',
        'successor: continue from the verified staging result',
        'su-tester',
        // P-012 / D-006: the closer's own note is sealed while it holds a restricted disclosure.
        { workspaceId: 'default', harness: 'papercup', writerOwnerId: 'su-tester' },
      );
      expect(commentWorkItem.mock.invocationCallOrder[0]).toBeGreaterThan(
        setWorkItemCheckpoint.mock.invocationCallOrder[0],
      );
    });

    it('reports a comment failure without undoing a successful terminal close', async () => {
      getWorkItem.mockResolvedValue(item);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
      commentWorkItem.mockRejectedValue(new Error('thread store unavailable'));

      const r = await close('successor: preserve this note if possible');

      expect(r.ok).toBe(true);
      expect(r.workItem.state).toBe('passed');
      expect(r.finish).toMatchObject({ complete: true, checkpointCleared: true });
      expect(r.boundaryNotePosted).toBe(false);
      expect(r.boundaryNoteError).toMatch(/thread store unavailable/);
    });

    it('does not post a boundary note for record-only or non-terminal calls', async () => {
      getWorkItem.mockResolvedValue(item);
      const recordOnly = await one({
        id: 'F-12',
        boundaryNote: 'record-only note must not become a post',
        completion: { summary: 'progress', tests: 'n/a' },
      });
      expect(recordOnly.ok).toBe(true);
      expect(commentWorkItem).not.toHaveBeenCalled();

      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'open' }));
      const nonTerminal = await one({
        id: 'F-12',
        state: 'needs_human',
        boundaryNote: 'non-terminal note must not become a post',
        completion: { summary: 'needs review', tests: 'n/a' },
      });
      expect(nonTerminal.ok).toBe(true);
      expect(commentWorkItem).not.toHaveBeenCalled();
    });

    it('accepts the bulk default and per-item override without crossing into completion evidence', async () => {
      getWorkItem.mockImplementation(async (id: string) => ({ ...item, id }));
      setWorkItemStateWithAliasInfo.mockImplementation(async (id: string) =>
        okState({ ...item, id, state: 'passed' }),
      );

      const out = await env({
        boundaryNote: 'default successor note',
        items: [
          { id: 'F-1', state: 'passed', completion: { summary: 'one', tests: 'green' } },
          {
            id: 'F-2',
            state: 'passed',
            boundaryNote: 'specific successor note',
            completion: { summary: 'two', tests: 'green' },
          },
        ],
      });

      expect(out.ok).toBe(true);
      expect(out.counts).toEqual({ ok: 2, failed: 0 });
      expect(commentWorkItem.mock.calls.map((call) => call[1])).toEqual([
        'default successor note',
        'specific successor note',
      ]);
    });
  });

  // EI-21462047954123123: a checkpoint holding checks is FOLDED into the persisted
  // `_completionEvidence` before the terminal clear wipes it — "see the checkpoint"
  // citations must land on a surface that survives the close.
  it('folds non-empty checkpoint checks into _completionEvidence before clearing', async () => {
    // The attach seam fires on the ALREADY-TERMINAL re-attestation path (no `state`
    // passed) — exactly the close shape whose evidence cites the checkpoint.
    const settled = { ...item, state: 'passed' };
    getWorkItem.mockResolvedValue(settled);
    getWorkItemCheckpoint.mockResolvedValue(
      [
        '## Did',
        'verification pass done',
        '',
        '## Checks',
        '- ✓ [#gate] gate is green — re-check: state:read',
        '  Verified 10:00Z: 30/30 passed',
        '- ? [#audit] audits are terminal — re-check: read audit state — evidence: audit remains pending',
        '- [ ] main is at abc123 — re-check: git rev-parse main',
      ].join('\n'),
    );
    const r = await one({ id: 'F-12', completion: { summary: 'shipped' } });
    expect(r.ok).toBe(true);
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ workItemId: 'F-12' }), null);
    const evidenceCall = attachCompletionEvidenceToSettledItem.mock.calls.find((c) =>
      JSON.stringify(c).includes('checkpointChecksCarried'),
    );
    expect(evidenceCall).toBeTruthy();
    const carried = JSON.stringify(evidenceCall);
    expect(carried).toContain('gate is green');
    expect(carried).toContain('"observed":"audit remains pending"');
    expect(carried).toContain('main is at abc123');
    expect(carried).toContain('verification pass done');
    expect(carried).toContain('checkpointProseSnapshot');
  });

  it('retains complete long checkpoint prose before terminal cleanup', async () => {
    const prose = `## Did\n${'x'.repeat(26_950)}\n\n## Rollback\nrestore from the verified backup\n\n## Final evidence\nsource sha=0123456789abcdef`;
    getWorkItem.mockResolvedValue({ ...item, state: 'passed' });
    getWorkItemCheckpoint.mockResolvedValue(prose);

    const r = await one({ id: 'F-12', completion: { summary: 'shipped' } });

    expect(r.ok).toBe(true);
    const [, options] = attachCompletionEvidenceToSettledItem.mock.calls[0] as [
      string,
      { completionEvidence?: Record<string, unknown> },
    ];
    const snapshot = options.completionEvidence?.checkpointProseSnapshot;
    expect(snapshot).toBe(prose);
    expect(snapshot).toEqual(expect.stringContaining('restore from the verified backup'));
    expect(snapshot).toEqual(expect.stringContaining('source sha=0123456789abcdef'));
  });

  it('writes no checkpointChecksCarried when the checkpoint is empty or absent', async () => {
    getWorkItem.mockResolvedValue({ ...item, state: 'passed' });
    await one({ id: 'F-12', completion: { summary: 'shipped' } });
    expect(attachCompletionEvidenceToSettledItem).toHaveBeenCalled();
    expect(JSON.stringify(attachCompletionEvidenceToSettledItem.mock.calls)).not.toContain('checkpointChecksCarried');
  });

  it('forwards linked requirements to conformance preflight and persists the declarations', async () => {
    const linked = { ...item, sourcePlanSlug: 'requirement-plan', sourcePlanItemIds: ['P-001'] };
    getWorkItem.mockResolvedValue(linked);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...linked, state: 'passed' }));
    const completion = { summary: 'R-1 delivered', discharges: ['R-1'], contributesTo: ['R-2'], tests: 'focused checks pass' };
    const r = await one({ id: 'F-12', state: 'passed', completion });
    expect(r.ok).toBe(true);
    expect(conformanceClosure.read).toHaveBeenCalledWith(expect.objectContaining({
      planSlug: 'requirement-plan', planItemIds: ['P-001'],
      completion: expect.objectContaining({ discharges: ['R-1'], contributesTo: ['R-2'] }),
    }));
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith('F-12', 'passed', expect.objectContaining({
      completionEvidence: expect.objectContaining({ discharges: ['R-1'], contributesTo: ['R-2'] }),
    }));
  });

  it('refuses conformance violations before writing or emitting a linked completion', async () => {
    getWorkItem.mockResolvedValue({ ...item, sourcePlanSlug: 'requirement-plan', sourcePlanItemIds: ['P-001'] });
    conformanceClosure.read.mockResolvedValue({
      applicable: true,
      mappedRequirements: ['R-1'],
      declaredRequirements: ['R-1'],
      declarationSatisfied: true,
      refusal: { code: 'conformance_done_when_not_passing', error: 'R-1 failed.', requirements: ['R-1'] },
    });
    const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 'R-1 delivered', discharges: ['R-1'] } });
    expect(r).toMatchObject({
      ok: false,
      specConformanceRefusal: { code: 'conformance_done_when_not_passing' },
      completionContract: {
        requirements: expect.arrayContaining([
          expect.objectContaining({
            key: 'spec-conformance-closure',
            applicable: true,
            satisfied: false,
            details: {
              mappedRequirements: ['R-1'],
              declaredRequirements: ['R-1'],
              declarationFields: ['completion.discharges', 'completion.contributesTo'],
              declarationSatisfied: true,
            },
          }),
        ]),
      },
    });
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    expect(fireReactionInProcess).not.toHaveBeenCalled();
  });

  it('shows the mapped declaration requirement in the same validateOnly refusal as other contract gates', async () => {
    getWorkItem.mockResolvedValue({ ...item, sourcePlanSlug: 'requirement-plan', sourcePlanItemIds: ['P-001'] });
    conformanceClosure.read.mockResolvedValue({
      applicable: true,
      mappedRequirements: ['R-1', 'R-3'],
      declaredRequirements: [],
      declarationSatisfied: false,
      refusal: {
        code: 'conformance_requirements_missing',
        error: 'Name a mapped requirement in completion.discharges or completion.contributesTo.',
        requirements: ['R-1', 'R-3'],
      },
    });

    const r = await one({
      id: 'F-12',
      state: 'passed',
      validateOnly: true,
      completion: { summary: 'R-1 and R-3 delivered', testsRun: 'focused tests', testResult: 'pass' },
    });

    expect(r).toMatchObject({
      ok: false,
      specConformanceRefusal: { code: 'conformance_requirements_missing', requirements: ['R-1', 'R-3'] },
      completionContract: {
        requirements: expect.arrayContaining([
          expect.objectContaining({
            key: 'spec-conformance-closure',
            applicable: true,
            satisfied: false,
            details: {
              mappedRequirements: ['R-1', 'R-3'],
              declaredRequirements: [],
              declarationFields: ['completion.discharges', 'completion.contributesTo'],
              declarationSatisfied: false,
            },
          }),
        ]),
      },
    });
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    expect(fireReactionInProcess).not.toHaveBeenCalled();
  });

  it('shows mapped and supplied requirement declarations on a successful validateOnly preview', async () => {
    const linked = { ...item, sourcePlanSlug: 'requirement-plan', sourcePlanItemIds: ['P-001'] };
    getWorkItem.mockResolvedValue(linked);
    conformanceClosure.read.mockResolvedValue({
      applicable: true,
      mappedRequirements: ['R-1', 'R-3'],
      declaredRequirements: ['R-1', 'R-3'],
      declarationSatisfied: true,
      refusal: null,
    });

    const r = await one({
      id: 'F-12',
      state: 'passed',
      validateOnly: true,
      completion: { summary: 'R-1 and R-3 delivered', discharges: ['R-1'], contributesTo: ['R-3'] },
    });

    expect(r).toMatchObject({
      ok: true,
      validationOnly: true,
      completionContract: {
        requirements: expect.arrayContaining([
          expect.objectContaining({
            key: 'spec-conformance-closure',
            applicable: true,
            satisfied: true,
            details: {
              mappedRequirements: ['R-1', 'R-3'],
              declaredRequirements: ['R-1', 'R-3'],
              declarationFields: ['completion.discharges', 'completion.contributesTo'],
              declarationSatisfied: true,
            },
          }),
        ]),
      },
    });
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    expect(mergeWorkItemOutputPayload).not.toHaveBeenCalled();
  });

  it('refuses an unavailable conformance read without writing a completion', async () => {
    getWorkItem.mockResolvedValue({ ...item, sourcePlanSlug: 'requirement-plan', sourcePlanItemIds: ['P-001'] });
    conformanceClosure.read.mockRejectedValue(new Error('ledger unavailable'));
    const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 'R-1 delivered', discharges: ['R-1'] } });
    expect(r).toMatchObject({ ok: false, specConformanceRefusal: { code: 'conformance_check_unavailable', retryable: true } });
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  // plan-verification-profiles P-005 (R-15, D-008): the close-time deliverable check is wired
  // into the real completion path, refuses before any write, and fails closed.
  it('refuses code evidence under a non-code deliverable before writing a linked completion (R-15)', async () => {
    getWorkItem.mockResolvedValue({ ...item, sourcePlanSlug: 'requirement-plan', sourcePlanItemIds: ['P-002'] });
    nonCodeClose.read.mockResolvedValueOnce({
      itemId: 'P-002',
      evidence: { signals: ['files-changed'], deliverable: 'doc', profile: 'general', filesChanged: ['packages/x/runbook-helper.ts'] },
    });
    const r = await one({
      id: 'F-12',
      state: 'passed',
      completion: { summary: 'runbook written', discharges: ['R-1'], filesChanged: ['packages/x/runbook-helper.ts'] },
    });
    expect(nonCodeClose.read).toHaveBeenCalledWith(expect.objectContaining({
      planSlug: 'requirement-plan',
      planItemIds: ['P-002'],
      filesChanged: ['packages/x/runbook-helper.ts'],
    }));
    expect(r).toMatchObject({
      ok: false,
      nonCodeDeliverableRefusal: {
        code: 'non_code_deliverable_code_evidence',
        planSlug: 'requirement-plan',
        itemId: 'P-002',
        deliverable: 'doc',
        signals: ['files-changed'],
      },
    });
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    expect(fireReactionInProcess).not.toHaveBeenCalled();
  });

  it('refuses an unreadable deliverable check without writing a completion (R-15 fails closed)', async () => {
    getWorkItem.mockResolvedValue({ ...item, sourcePlanSlug: 'requirement-plan', sourcePlanItemIds: ['P-002'] });
    nonCodeClose.read.mockRejectedValueOnce(new Error('plan_items unreadable'));
    const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 'runbook written', discharges: ['R-1'] } });
    expect(r).toMatchObject({ ok: false, nonCodeDeliverableRefusal: { code: 'deliverable_check_unavailable', retryable: true } });
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  // plan-item-types-registry-cupboard P-004 (R-10): the item type's completion fields are
  // checked on the real completion path, passed completion.typeFields, and refuse before any write.
  it('refuses a close whose typeFields violate the linked item type before writing (R-10)', async () => {
    getWorkItem.mockResolvedValue({ ...item, sourcePlanSlug: 'requirement-plan', sourcePlanItemIds: ['P-002'] });
    typeFieldsClose.read.mockResolvedValueOnce({
      code: 'item_type_fields_invalid',
      itemId: 'P-002',
      itemType: 'acme/clause',
      revision: 1,
      errors: ["must have required property 'clauseRef'"],
    });
    const r = await one({
      id: 'F-12',
      state: 'passed',
      completion: { summary: 'clause drafted', discharges: ['R-1'], typeFields: { memoRef: 'm-1' } },
    });
    expect(typeFieldsClose.read).toHaveBeenCalledWith(expect.objectContaining({
      planSlug: 'requirement-plan',
      planItemIds: ['P-002'],
      typeFields: { memoRef: 'm-1' },
    }));
    expect(r).toMatchObject({
      ok: false,
      itemTypeFieldsRefusal: { code: 'item_type_fields_invalid', planSlug: 'requirement-plan', itemId: 'P-002', itemType: 'acme/clause' },
    });
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    expect(fireReactionInProcess).not.toHaveBeenCalled();
  });

  it('refuses an unreadable item-type check without writing a completion (R-10 fails closed)', async () => {
    getWorkItem.mockResolvedValue({ ...item, sourcePlanSlug: 'requirement-plan', sourcePlanItemIds: ['P-002'] });
    typeFieldsClose.read.mockRejectedValueOnce(new Error('type registry unreadable'));
    const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 'clause drafted', discharges: ['R-1'] } });
    expect(r).toMatchObject({ ok: false, itemTypeFieldsRefusal: { code: 'item_type_fields_check_unavailable', retryable: true } });
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('keeps conformance preflight out of record-only and discard paths', async () => {
    const linked = { ...item, sourcePlanSlug: 'requirement-plan', sourcePlanItemIds: ['P-001'] };
    getWorkItem.mockResolvedValue(linked);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...linked, state: 'dropped' }));
    await one({ id: 'F-12', recordOnly: true, completion: { summary: 'progress' } });
    await one({ id: 'F-12', state: 'dropped', completion: { summary: 'Superseded work' } });
    expect(conformanceClosure.read).not.toHaveBeenCalled();
  });

  it('synchronously converges a linked plan item and claim release before reporting success', async () => {
    const linked = {
      ...item,
      payload: { plan_item: { plan_slug: 'release-plan', item_id: 'P-007', harness_slug: 'papercup' } },
    };
    getWorkItem.mockResolvedValue(linked);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...linked, state: 'passed' }));

    const r = await one({
      id: 'F-12',
      state: 'passed',
      completion: { summary: 'verified and shipped', tests: '12 green' },
    });

    expect(r.ok).toBe(true);
    expect(r.finish).toMatchObject({
      idempotent: true,
      complete: true,
      planItem: 'done',
      claimRelease: 'released-or-absent',
    });
    expect(fireReactionInProcess).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        fire: 'plans:set-status',
        args: expect.objectContaining({ slug: 'release-plan', item: 'P-007', status: 'done' }),
      }),
    );
    expect(fireReactionInProcess).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        fire: 'plan_items:release',
        args: { harness: 'papercup', plan: 'release-plan', item: 'P-007' },
      }),
    );
  });

  it('reports the linked plan item status that actually committed after a guarded no-op', async () => {
    const linked = {
      ...item,
      payload: { plan_item: { plan_slug: 'release-plan', item_id: 'P-007', harness_slug: 'papercup' } },
    };
    getWorkItem.mockResolvedValue(linked);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...linked, state: 'passed' }));
    // `plans:set-status` can deliberately return ok:true without flipping when a
    // coverage guard sees another open sibling. The canonical readback remains wip.
    // Answer the plan_items readback by its query text, not by call order: other reads on
    // the close path (e.g. the change-kind declaration read, P-002) share this mock and
    // would otherwise consume a one-shot value meant for the readback.
    const defaultRows = dbMocks.planItemStatusRows.getMockImplementation();
    dbMocks.planItemStatusRows.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.join('').includes('FROM harness_shared.plan_items') ? [{ status: 'wip' }] : defaultRows?.(strings, ...values),
    );

    const r = await one({
      id: 'F-12',
      state: 'passed',
      completion: { summary: 'this sibling is complete', tests: '12 green' },
    });

    expect(r.ok).toBe(true);
    expect(r.finish).toMatchObject({ complete: true, planItem: 'wip' });
    const planStatusReads = dbMocks.planItemStatusRows.mock.calls.filter(([strings]) =>
      strings.join('').includes('FROM harness_shared.plan_items'),
    );
    expect(planStatusReads).toHaveLength(1);
  });

  it('fails loudly after a partial finish and tells the caller the same call is retry-safe', async () => {
    const linked = {
      ...item,
      payload: { plan_item: { plan_slug: 'release-plan', item_id: 'P-007', harness_slug: 'papercup' } },
    };
    getWorkItem.mockResolvedValue(linked);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...linked, state: 'passed' }));
    fireReactionInProcess
      .mockResolvedValueOnce({ ok: false, error: 'plan lock unavailable' })
      .mockResolvedValueOnce({ ok: true });

    const r = await one({
      id: 'F-12',
      state: 'passed',
      completion: { summary: 'verified', tests: '12 green' },
    });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/FINISH DID NOT FULLY CONVERGE/);
    expect(r.error).toMatch(/Re-call the SAME completion/);
    expect(r.finish).toMatchObject({ complete: false, planItem: 'failed' });
  });

  it('refuses terminal completion of a remote-authored issue before emitting a false completion', async () => {
    // The shared DB stub defaults to a non-empty plan-item result. This early
    // remote-origin guard also asks whether this row is own-node authored, so
    // give that query an explicit non-match instead of letting the unrelated
    // default fixture bypass the refusal.
    dbMocks.planItemStatusRows.mockResolvedValueOnce([]);
    getWorkItem.mockResolvedValue({
      id: 'WI-remote',
      kind: 'bug',
      family: 'issue',
      state: 'todo',
      harness: 'papercup',
      origin: 'remote',
    });
    const r = await one({
      id: 'WI-remote',
      state: 'resolved',
      completion: { summary: 'verified elsewhere', tests: 'n/a' },
    });
    expect(r).toMatchObject({
      ok: false,
      id: 'WI-remote',
      error: expect.stringMatching(/remote-authored.*cannot be completed locally/),
    });
    expect(r).not.toHaveProperty('completion');
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('surfaces aliasNote when the requested state aliases instead of silently leaving the item open', async () => {
    const issue = { id: 'WI-1', kind: 'bug', family: 'issue', state: 'open', harness: 'papercup' };
    getWorkItem.mockResolvedValue(issue);
    setWorkItemStateWithAliasInfo.mockImplementation(async (_id: string, state: string) => ({
      workItem: { ...issue, state: 'open' },
      aliased: true,
      requestedState: state,
      appliedState: 'open',
      aliasNote: `requested state '${state}' has no distinct representation for this item's family — recorded as 'open' instead.`,
    }));
    const r = await one({ id: 'WI-1', state: 'needs_human', completion: { summary: 'requires owner decision' } });
    expect(r.ok).toBe(true);
    expect(r.workItem.state).toBe('open');
    expect(r.aliasNote).toMatch(/requested state 'needs_human'.*recorded as 'open'/);
    expect(r.stateWarning).toMatch(/still 'open'/);
    expect(r.aliased).toBe(true);
    expect(r.requestedState).toBe('needs_human');
    expect(r.appliedState).toBe('open');
  });

  // ── WI-4529: `ok` must reflect the STATE TRANSITION, not just "the record got written" ──
  // The silent-success class: a close that did NOT happen used to come back ok:true with the
  // failure buried in a sibling string, so every caller (they all check `ok`) walked away
  // believing the item closed while it stayed open and re-claimable.
  describe('WI-4529 — ok reflects whether the item actually CLOSED', () => {
    const issue = { id: 'WI-1', kind: 'bug', family: 'issue', state: 'open', harness: 'papercup' };

    it('previews the same plan-lane refusal as a real close without writing or claiming persistence', async () => {
      getWorkItem.mockResolvedValue(issue);
      const refusal = "work_item 'WI-1' is not settled, and its linked plan-item a-plan#P-001 is STILL effectively 'owner-gated'";
      workItemPlanLaneTransitionRefusal.mockResolvedValue(refusal);
      setWorkItemStateWithAliasInfo.mockRejectedValue(new Error(refusal));
      const args = { id: 'WI-1', state: 'resolved', completion: { summary: 'fixed it', tests: '5 green' } };
      const preview = await one({ ...args, validateOnly: true });
      expect(preview).toMatchObject({ ok: false, validationOnly: true, stateError: refusal });
      expect(workItemPlanLaneTransitionRefusal).toHaveBeenCalledWith(issue, 'resolved');
      expect(preview.completionContract.requirements).toContainEqual(expect.objectContaining({ key: 'plan-item-lane', applicable: true, satisfied: false }));
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(setWorkItemClaimHold).not.toHaveBeenCalled();
      const actual = await one(args);
      expect(actual).toMatchObject({ ok: false, stateError: refusal, completionEvidenceStored: false, completionReturnedOnly: true });
      expect(actual.stateWarning).toMatch(/returned.*completion.*not persisted/i);
      expect(actual.stateWarning).not.toMatch(/recorded a completion/i);
      expect(actual.completion).toMatchObject({ summary: 'fixed it' });
    });

    it('previews an actionable plan lane without persisting a completion', async () => {
      getWorkItem.mockResolvedValue(issue);
      const preview = await one({ id: 'WI-1', state: 'resolved', validateOnly: true,
        completion: { summary: 'fixed it', tests: '5 green' } });
      expect(preview).toMatchObject({ ok: true, validationOnly: true });
      expect(workItemPlanLaneTransitionRefusal).toHaveBeenCalledWith(issue, 'resolved');
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    it('reports an announced-event preflight failure as returned-only, not persisted evidence', async () => {
      getWorkItem.mockResolvedValue(issue);
      const refusal = "completion gate unavailable for work_item 'WI-1': could not verify announced event gates before closing (db-call-deadline); no terminal state transition was written.";
      setWorkItemStateWithAliasInfo.mockRejectedValue(new Error(refusal));

      const r = await one({ id: 'WI-1', state: 'resolved', completion: { summary: 'fixed it', tests: '5 green' } });

      expect(r).toMatchObject({
        ok: false,
        stateError: refusal,
        completionEvidenceStored: false,
        completionReturnedOnly: true,
      });
      expect(r.stateWarning).toMatch(/returned a completion, but it was not persisted/i);
      expect(r.stateWarning).not.toMatch(/recorded a completion/i);
      expect(r.completion).toMatchObject({ summary: 'fixed it' });
    });

    it('a state write that THROWS (peer HOLD-OPEN) returns ok:false — but still records + carries the completion (EI-24)', async () => {
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockRejectedValue(
        new Error(
          "work_item 'WI-1' is HELD OPEN by su-peer (\"blocked\") — closing it into 'resolved' requires the holder.",
        ),
      );
      const r = await one({ id: 'WI-1', state: 'resolved', completion: { summary: 'fixed it', tests: '5 green' } });

      expect(r.ok).toBe(false); // ← the whole point: the item did NOT close
      expect(r.error).toMatch(/DID NOT CLOSE/);
      expect(r.error).toMatch(/HELD OPEN by su-peer/); // the real cause is surfaced, not buried
      // EI-24 preserved: the completion record is NOT lost, and still rides the result so the
      // `emits` rule (which keys on result.completion) still broadcasts it.
      expect(r.completion).toMatchObject({ summary: 'fixed it' });
      expect(r.stateError).toMatch(/HELD OPEN/);
    });

    it('parks a plan-gated failed close out of scheduler:get_next (EI-20190168400283197)', async () => {
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockRejectedValue(
        new Error(
          "work_item 'WI-1' is not settled, and its linked plan-item a-plan#P-002 is STILL effectively 'blocked' (blocked-by: P-001) — completing it into 'resolved' now would race ahead of that plan gate.",
        ),
      );

      const r = await one({ id: 'WI-1', state: 'resolved', completion: { summary: 'fixed it', tests: '5 green' } });

      expect(r.ok).toBe(false);
      expect(setWorkItemClaimHold).toHaveBeenCalledWith(
        'WI-1',
        true,
        expect.objectContaining({
          harness: 'papercup',
          parkedBy: expect.any(String),
          parkedReason: 'terminal completion refused by the linked plan-item gate',
          releaseContract: {
            condition: 'the linked plan-item gate for WI-1 is no longer effectively blocked',
            trigger: 'work-item:unblocked:WI-1',
            owner: expect.any(String),
            reachability: 'reachable',
            evidence: 'catalogued unblocked producer is live',
          },
        }),
      );
      expect(parkReachability.read).toHaveBeenCalledWith('work-item:unblocked:WI-1', { requireSpecificCondition: true });
      expect(r.planGateParkWarning).toMatch(/DURABLY PARKED out of scheduler:get_next/);
      expect(r.stateWarning).toMatch(/durably parked out of scheduler:get_next/);
      expect(r.stateWarning).not.toMatch(/stays claimable/);
      expect(r.error).toMatch(/DID NOT CLOSE/);
      expect(r.completion).toMatchObject({ summary: 'fixed it' });
    });

    it('does not create an untracked park when the release-condition read fails', async () => {
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockRejectedValue(
        new Error("linked plan-item a-plan#P-002 is STILL effectively 'blocked'"),
      );
      parkReachability.read.mockRejectedValueOnce(new Error('event ledger unavailable'));

      const r = await one({ id: 'WI-1', state: 'resolved', completion: { summary: 'fixed it', tests: '5 green' } });

      expect(r.ok).toBe(false);
      expect(setWorkItemClaimHold).not.toHaveBeenCalled();
      expect(r.planGateParkWarning).toContain('event ledger unavailable');
      expect(r.planGateParkWarning).toContain('it remains claimable');
    });

    it('does not claim a plan-gated close was parked when the claim hold write fails', async () => {
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockRejectedValue(
        new Error(
          "work_item 'WI-1' is not settled, and its linked plan-item a-plan#P-002 is STILL effectively 'blocked'",
        ),
      );
      setWorkItemClaimHold.mockRejectedValue(new Error('claim hold database unavailable'));

      const r = await one({ id: 'WI-1', state: 'resolved', completion: { summary: 'fixed it', tests: '5 green' } });

      expect(r.ok).toBe(false);
      expect(r.planGateParkWarning).toMatch(/could not be durably parked/);
      expect(r.planGateParkWarning).toMatch(/remains claimable/);
      expect(r.stateWarning).toMatch(/stays claimable/);
    });

    it('the alias trap: a CLOSE-INTENT state that silently lands non-terminal (issue `done` -> `open`) returns ok:false', async () => {
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockImplementation(async (_id: string, state: string) => ({
        workItem: { ...issue, state: 'open' }, // issue-family stores only open|resolved|closed
        aliased: true,
        requestedState: state,
        appliedState: 'open',
        aliasNote: `requested state '${state}' has no distinct representation for this item's family — recorded as 'open' instead.`,
      }));
      const r = await one({ id: 'WI-1', state: 'done', completion: { summary: 'thought I closed it', tests: 'n/a' } });

      expect(r.ok).toBe(false); // said "done", item is still 'open' and claimable
      expect(r.error).toMatch(/DID NOT CLOSE/);
      expect(r.error).toMatch(/NOT terminal/);
      expect(r.completion).toMatchObject({ summary: 'thought I closed it' }); // record still kept
    });

    it('EI-18127483322976472: a change/issue-family close that lands on the UNIFIED terminal (`done`) is recognized as CLOSED — ok:true, no false "NOT terminal" warning', async () => {
      // Post work-item-status-full-unify (2026-07-19), the issue family's alias layer maps
      // resolved→'done' (not the old bare 'resolved'/'closed' spellings) — so the terminal
      // check here MUST recognize 'done' as terminal too, not just the pre-unify names.
      const changeItem = { id: 'WI-5517', kind: 'change', family: 'issue', state: 'open', harness: 'papercup' };
      getWorkItem.mockResolvedValue(changeItem);
      setWorkItemStateWithAliasInfo.mockImplementation(async (_id: string, state: string) => ({
        workItem: { ...changeItem, state: 'done' },
        aliased: true,
        requestedState: state,
        appliedState: 'done',
        aliasNote: `requested state '${state}' has no distinct representation for this family — recorded as 'done' instead.`,
      }));
      const r = await one({
        id: 'WI-5517',
        state: 'resolved',
        completion: { summary: 'fixed the root cause', tests: '5 green' },
      });

      expect(r.ok).toBe(true); // it DID close — must not be reported as a failed close
      expect(r.error).toBeUndefined();
      expect(r.stateWarning).toBeUndefined();
      expect(r.workItem.state).toBe('done');
    });

    it('EI-18129407319885561: a watchdog EI-* item with kind=null (item_kind stored separately as `bug`) still closes on resolved/closed — terminality is keyed on FAMILY, not `kind`', async () => {
      // Watchdog-authored engineer_issues rows (harness_slug='operator:<workspace>') can carry
      // a null `kind` column while the row is still issue-family (item_kind='bug' at the store
      // layer). The reporter theorized work_items:complete's terminal-state resolution keyed off
      // the (null) `kind` instead of `item_kind`/family and so silently misrouted these rows to a
      // non-terminal alias. It doesn't: `existing.family` (hardcoded 'issue' for every
      // engineer_issues row by issueToWorkItem, independent of `kind`) is the only discriminator
      // TERMINAL_WORK_ITEM_STATES/closeIntended/closeLanded ever consult — assert that holds for
      // BOTH the 'resolved' and 'closed' close-intents on a kind=null row.
      const watchdogItem = { id: 'EI-999', kind: null, family: 'issue', state: 'open', harness: null };
      getWorkItem.mockResolvedValue(watchdogItem);
      setWorkItemStateWithAliasInfo.mockImplementation(async (_id: string, state: string) => ({
        workItem: { ...watchdogItem, state: state === 'closed' ? 'dropped' : 'done' },
        aliased: true,
        requestedState: state,
        appliedState: state === 'closed' ? 'dropped' : 'done',
        aliasNote: `requested state '${state}' has no distinct representation for this item's family — recorded as '${state === 'closed' ? 'dropped' : 'done'}' instead.`,
      }));

      const resolved = await one({
        id: 'EI-999',
        state: 'resolved',
        completion: { summary: 'fixed', tests: '3 green' },
      });
      expect(resolved.ok).toBe(true);
      expect(resolved.error).toBeUndefined();
      expect(resolved.workItem.state).toBe('done');

      const closed = await one({ id: 'EI-999', state: 'closed', completion: { summary: 'wontfix', tests: 'n/a' } });
      expect(closed.ok).toBe(true);
      expect(closed.error).toBeUndefined();
      expect(closed.workItem.state).toBe('dropped');
    });

    it('a DELIBERATE non-terminal park (needs_human) is NOT a failure — stays ok:true', async () => {
      // The guard against over-correcting: `complete` with a non-close state is a legitimate
      // "I did the work, it now needs a human" call. It must not be reported as a failed close.
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockImplementation(async (_id: string, state: string) => ({
        workItem: { ...issue, state: 'open' },
        aliased: true,
        requestedState: state,
        appliedState: 'open',
        aliasNote: `requested state '${state}' aliased to 'open'.`,
      }));
      const r = await one({
        id: 'WI-1',
        state: 'needs_human',
        completion: { summary: 'needs an owner decision', tests: 'n/a' },
      });

      expect(r.ok).toBe(true);
      expect(r.error).toBeUndefined();
      expect(r.stateWarning).toMatch(/still 'open'/); // still loudly warned, just not a failure
    });

    it('a bare completion with NO state stays ok:true (record-only is a legitimate call)', async () => {
      getWorkItem.mockResolvedValue(issue);
      const r = await one({ id: 'WI-1', completion: { summary: 'progress note', tests: 'n/a' } });
      expect(r.ok).toBe(true);
      expect(r.error).toBeUndefined();
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    it('does not report success when terminal-close assumptions are supplied without state', async () => {
      getWorkItem.mockResolvedValue(issue);
      const r = await oneRaw({
        id: 'WI-1',
        assumptions: 'none',
        completion: { summary: 'fixed and verified', tests: '5 green' },
      });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('no top-level state was passed');
      expect(r.error).toContain('Re-call the SAME completion');
      expect(r.completion.summary).toBe('fixed and verified');
      expect(r.workItem.state).toBe('open');
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    it('does not report success for an ambiguous bare completion without state', async () => {
      getWorkItem.mockResolvedValue(issue);
      const r = await oneRaw({ id: 'WI-1', completion: { summary: 'fixed and verified', tests: '5 green' } });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('recordOnly:true was not requested');
      expect(r.workItem.state).toBe('open');
    });

    it('keeps an explicitly requested record-only completion successful', async () => {
      getWorkItem.mockResolvedValue(issue);
      const r = await oneRaw({ id: 'WI-1', recordOnly: true, completion: { summary: 'progress', tests: 'n/a' } });
      expect(r.ok).toBe(true);
      expect(r.workItem.state).toBe('open');
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    it('a successful terminal close is ok:true with no error', async () => {
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...issue, state: 'resolved' }));
      const r = await one({ id: 'WI-1', state: 'resolved', completion: { summary: 'done', tests: '5 green' } });
      expect(r.ok).toBe(true);
      expect(r.error).toBeUndefined();
      expect(r.workItem.state).toBe('resolved');
    });
  });

  it('retries a transient PG lock timeout before reporting completion success (EI-22726666602239861)', async () => {
    const issue = { id: 'EI-timeout', kind: 'bug', family: 'issue', state: 'open', harness: 'papercup' };
    const timeout = Object.assign(new Error('operator write timed out waiting for a row/advisory lock'), {
      name: 'OrgTxnTimeoutError',
      pgCode: '55P03',
    });
    getWorkItem.mockResolvedValue(issue);
    setWorkItemStateWithAliasInfo
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(okState({ ...issue, state: 'resolved' }));

    // The shared helper owns the production classifier/backoff policy. This seam test
    // models its retry contract without waiting on the production multi-second sleeps.
    contentionMocks.acquireWithContentionRetry.mockImplementation(async (run: () => Promise<unknown>) => {
      try {
        return await run();
      } catch (error) {
        expect(error).toMatchObject({ name: 'OrgTxnTimeoutError', pgCode: '55P03' });
        return run();
      }
    });

    const r = await one({
      id: 'EI-timeout',
      state: 'resolved',
      completion: { summary: 'closed after a transient lock timeout', tests: 'focused test green' },
    });

    expect(r.ok).toBe(true);
    expect(r.workItem).toMatchObject({ id: 'EI-timeout', state: 'resolved' });
    expect(r.stateError).toBeUndefined();
    // The close has two retryable finish legs: the terminal state write and the
    // checkpoint cleanup. Both must use the shared contention policy.
    expect(contentionMocks.acquireWithContentionRetry).toHaveBeenCalledTimes(2);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledTimes(2);
  });

  // ── EI-19312103118112942: fleet drain members were measured settling (holding zero
  // claims) after CLOSING an item, even with hundreds of claimable rows still in their own
  // spec — completion was treated as the end of the wake instead of its midpoint. Fire an
  // inline "pull next now" nudge on every real close for a fleet member (PAPERCUSP_FLEET_SLUG
  // set), gated on nothing else — a fleet drain member closes one item at a time, so this is
  // cheap and safe even on the rare multi-claim member (scheduler:get_next no-ops there).
  describe('fleetRepullNudge — inline "pull next" nudge on a fleet member\'s real close (EI-19312103118112942)', () => {
    const issue = { id: 'WI-1', kind: 'bug', family: 'issue', state: 'open', harness: 'papercup' };
    const prevSlug = process.env.PAPERCUSP_FLEET_SLUG;
    const prevRole = process.env.PAPERCUSP_FLEET_ROLE;
    afterEach(() => {
      if (prevSlug === undefined) delete process.env.PAPERCUSP_FLEET_SLUG;
      else process.env.PAPERCUSP_FLEET_SLUG = prevSlug;
      if (prevRole === undefined) delete process.env.PAPERCUSP_FLEET_ROLE;
      else process.env.PAPERCUSP_FLEET_ROLE = prevRole;
    });

    it('fires on a terminal close when PAPERCUSP_FLEET_SLUG is set (a fleet member)', async () => {
      process.env.PAPERCUSP_FLEET_SLUG = 'nonp2p-bug-drain-0801';
      process.env.PAPERCUSP_FLEET_ROLE = 'member';
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...issue, state: 'resolved' }));
      const r = await one({ id: 'WI-1', state: 'resolved', completion: { summary: 'done', tests: '5 green' } });
      expect(r.ok).toBe(true);
      expect(r.fleetSlug).toBe('nonp2p-bug-drain-0801');
      expect(r.fleetRepullNudge).toMatch(/scheduler:get_next/);
      expect(r.fleetRepullNudge).toMatch(/WI-1/);
    });

    it('does NOT fire outside a fleet (no PAPERCUSP_FLEET_SLUG)', async () => {
      delete process.env.PAPERCUSP_FLEET_SLUG;
      delete process.env.PAPERCUSP_FLEET_ROLE;
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...issue, state: 'resolved' }));
      const r = await one({ id: 'WI-1', state: 'resolved', completion: { summary: 'done', tests: '5 green' } });
      expect(r.ok).toBe(true);
      expect(r.fleetSlug).toBeUndefined();
      expect(r.fleetRepullNudge).toBeUndefined();
    });

    it('does NOT fire on a record-only completion (no `state` — nothing closed)', async () => {
      process.env.PAPERCUSP_FLEET_SLUG = 'nonp2p-bug-drain-0801';
      getWorkItem.mockResolvedValue(issue);
      const r = await one({ id: 'WI-1', completion: { summary: 'progress note', tests: 'n/a' } });
      expect(r.fleetRepullNudge).toBeUndefined();
    });

    it('does NOT fire when the state write FAILED (item did not actually close)', async () => {
      process.env.PAPERCUSP_FLEET_SLUG = 'nonp2p-bug-drain-0801';
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockRejectedValue(new Error('held by a peer'));
      const r = await one({ id: 'WI-1', state: 'resolved', completion: { summary: 'done', tests: '5 green' } });
      expect(r.ok).toBe(false);
      expect(r.fleetSlug).toBeUndefined();
      expect(r.fleetRepullNudge).toBeUndefined();
    });
  });

  // ── EI-20194762143976862: the completion emit IS the member→leader report ────────────────
  // A fleet member is told, in base/prompts/su.md and su.fleet-member/prompts/fleet-posture.md,
  // NOT to hand-author a second coord:send after work_items:complete — because the intrinsic
  // completion emit already carries the structured record to the member's CURRENT fleet leader.
  // That contract rests on ONE line in the emits render (`to.push('@fleet-leader:' + slug)`)
  // and nothing pinned it: the fix landed 26 minutes after the item was filed, and the
  // `fleetSlug` assertions above cover only HALF the chain — the value, never the address.
  // Drop the selector and every member's completion silently stops reaching its leader while
  // the prompt keeps instructing them not to send that report themselves. Silent by
  // construction: the member sees ok:true either way.
  //
  // Asserted by EXECUTING the render, never by grepping the source — a source regex cannot
  // tell a live contract from a comment, nor see whether the branch is reachable at all.
  describe('completion emit addresses the fleet leader (EI-20194762143976862)', () => {
    const issue = { id: 'WI-1', kind: 'bug', family: 'issue', state: 'open', harness: 'papercup' };
    const prevSlug = process.env.PAPERCUSP_FLEET_SLUG;
    afterEach(() => {
      if (prevSlug === undefined) delete process.env.PAPERCUSP_FLEET_SLUG;
      else process.env.PAPERCUSP_FLEET_SLUG = prevSlug;
    });

    type EmitRule = {
      when: (event: unknown) => boolean;
      render: (event: unknown) => { to?: string[]; summary?: string; body?: string };
    };
    const completionEmit = () => (complete as { emits?: EmitRule[] }).emits?.[0];

    it("addresses the member's CURRENT leader, carrying the report they are told not to re-send", async () => {
      process.env.PAPERCUSP_FLEET_SLUG = 'nonp2p-bug-drain-0801';
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...issue, state: 'resolved' }));

      const r = await one({
        id: 'WI-1',
        state: 'resolved',
        completion: {
          summary: 'fixed the thing',
          tests: '5 green',
          verifiedHow: 'unit',
          filesChanged: ['packages/operator-core/lib/x.ts'],
          deferred: ['the follow-up nobody has taken'],
        },
      });
      expect(r.ok).toBe(true);

      const rule = completionEmit();
      const event = { result: { data: r } };
      expect(rule?.when(event)).toBe(true);

      const rendered = rule!.render(event);
      // The leader seam itself — the whole reason a second manual report is redundant.
      expect(rendered.to).toContain('@fleet-leader:nonp2p-bug-drain-0801');
      // …and the projection that makes it a REPORT rather than a bare ping: item id and
      // terminal disposition on the headline, verification evidence and the deferred
      // caveats in the body. A leader who reads this needs nothing else from the member.
      expect(rendered.summary).toContain('WI-1');
      expect(rendered.summary).toMatch(/RESOLVED|DONE/);
      expect(rendered.summary).toContain('5 green');
      expect(rendered.body).toContain('packages/operator-core/lib/x.ts');
      expect(rendered.body).toContain('the follow-up nobody has taken');
    });

    it('addresses no fleet leader outside a fleet (no PAPERCUSP_FLEET_SLUG)', async () => {
      delete process.env.PAPERCUSP_FLEET_SLUG;
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...issue, state: 'resolved' }));

      const r = await one({ id: 'WI-1', state: 'resolved', completion: { summary: 'done', tests: '5 green' } });
      expect(r.ok).toBe(true);

      const rendered = completionEmit()!.render({ result: { data: r } });
      expect(rendered.to?.some((t) => t.startsWith('@fleet-leader:'))).toBe(false);
    });
  });

  // ── WI-5891 (leader audit follow-up to WI-5874/P-001) ────────────────────────────────────
  // A completion that claims `verifiedHow:'live-drove-ui'` to CLOSE the item must cite a real
  // artifact — the exact gap that let WI-5874/P-001 close on this label citing only two vitest
  // runs, with no screenshot anywhere on the host. Unlike every other check in this file (EI-24
  // record-and-warn), this ONE claim is a genuine hard reject: it must FAIL on a synthetic
  // unbacked close, not just pass on a well-evidenced one.
  describe("completion-boundary screenshot guard — unbacked verifiedHow:'live-drove-ui' REJECTS the close (WI-5891)", () => {
    // EI-18797014705631713: the guard now READS the artifact it was handed, so these
    // fixtures have to be real files. That is not test bookkeeping — it is the fix. The
    // two "a BACKED claim closes normally" cases below used to pass while citing paths
    // that existed nowhere on the host, which is precisely the hole: under the old
    // text-only check, the invented path and a real screenshot were indistinguishable.
    let artifactDir: string;

    beforeAll(async () => {
      artifactDir = await mkdtemp(join(tmpdir(), 'complete-live-drove-ui-'));
      await writeFile(join(artifactDir, 'hud-fix.png'), contentPng());
      await writeFile(join(artifactDir, 'blank.png'), blankPng());
    });

    afterAll(async () => {
      await rm(artifactDir, { recursive: true, force: true });
    });

    it('SYNTHETIC UNBACKED CLOSE FAILS — citing only vitest runs (the exact WI-5874/P-001 shape)', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 'fixed the layout bug',
          testsRun: 'npm run test:file -- hud.test.ts',
          testResult: '2/2 vitest green',
          verifiedHow: 'live-drove-ui',
          filesChanged: ['apps/operator/app/adv/hud/hud.css'],
        },
      });
      expect(r.ok).toBe(false); // ← the whole point: an unbacked claim must not close
      expect(r.error).toMatch(/REJECTED/);
      expect(r.error).toMatch(/live-drove-ui/);
      expect(r.stateError).toMatch(/REJECTED/);
      // The state write must never even be attempted — nothing to roll back.
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      // EI-24 preserved: the completion record itself is never lost.
      expect(r.completion).toMatchObject({ summary: 'fixed the layout bug' });
    });

    it('a claim citing NOTHING at all (no testsRun/testResult/filesChanged) also FAILS', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: { summary: 'looked fine', verifiedHow: 'live-drove-ui' },
      });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/REJECTED/);
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    it('a BACKED claim (screenshot path cited in testResult) closes normally', async () => {
      getWorkItem.mockResolvedValue(item);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 'fixed the layout bug',
          testResult: `confirmed via tauri-agent-tools capture, saved ${artifactDir}/hud-fix.png`,
          verifiedHow: 'live-drove-ui',
        },
      });
      expect(r.ok).toBe(true);
      expect(r.error).toBeUndefined();
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
      expect(r.workItem.state).toBe('passed');
    });

    it('rejects a live-UI close advertising a scratch screenshot as retained evidence', async () => {
      getWorkItem.mockResolvedValue(item);
      const scratchPath = join(artifactDir, '.papercusp/scratch/portal.png');
      await mkdir(join(artifactDir, '.papercusp/scratch'), { recursive: true });
      await writeFile(scratchPath, contentPng());

      const completion = {
        summary: `Durable captures: ${scratchPath}`,
        testResult: `Inspected screenshot ${scratchPath}`,
        verifiedHow: 'live-drove-ui',
      };
      const preview = await one({ id: 'F-12', state: 'passed', completion, validateOnly: true });
      expect(preview.completionAuthority).toBe('proposed');
      expect(preview.ephemeralDeliverableWarning).toContain(scratchPath);

      const result = await one({ id: 'F-12', state: 'passed', completion });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/retained live-UI evidence under session scratch/);
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(result.completion).toMatchObject({ summary: completion.summary });
    });

    it('canonical nested verification evidence wins over weaker legacy aliases', async () => {
      getWorkItem.mockResolvedValue(item);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 'fixed the layout bug',
          testResult: 'pass',
          verifiedHow: 'live-drove-ui',
          verification: {
            testResult: `PASS with inspected screenshot ${artifactDir}/hud-fix.png`,
            verifiedHow: 'live-drove-ui',
          },
        },
      });
      expect(r.ok).toBe(true);
      expect(r.error).toBeUndefined();
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
        'F-12',
        'passed',
        expect.objectContaining({
          completionEvidence: expect.objectContaining({
            testResult: `PASS with inspected screenshot ${artifactDir}/hud-fix.png`,
          }),
        }),
      );
    });

    it('a BACKED claim (screenshot path in filesChanged) closes normally', async () => {
      getWorkItem.mockResolvedValue(item);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 'fixed the layout bug',
          verifiedHow: 'live-drove-ui',
          filesChanged: ['apps/operator/app/adv/hud/hud.css', join(artifactDir, 'hud-fix.png')],
        },
      });
      expect(r.ok).toBe(true);
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
    });

    // EI-18797014705631713 — the laundering case. Everything here looks right: a real
    // capture command, a real path, a real PNG on disk. The window just never painted.
    it('A CITED-BUT-BLANK SCREENSHOT FAILS — an image path is not proof of pixels', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 'fixed the layout bug',
          testsRun: `tauri-agent-tools screenshot --pid 4242 --output ${artifactDir}/blank.png`,
          testResult: 'captured the fixed HUD',
          verifiedHow: 'live-drove-ui',
        },
      });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/REJECTED/);
      expect(r.error).toMatch(/BLANK/);
      // Same discipline as the unbacked case: refused BEFORE any state write…
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      // …and the narrative is still never lost (EI-24).
      expect(r.completion).toMatchObject({ summary: 'fixed the layout bug' });
      // The rejection has to leave the agent somewhere to go, not just say no.
      expect(r.error).toMatch(/tauri-agent-tools check/);
    });

    it('a falsifiable `check` run closes with no image on disk at all', async () => {
      getWorkItem.mockResolvedValue(item);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 'fixed the layout bug',
          testsRun: 'tauri-agent-tools check --pid 4242 --eval "getComputedStyle(el).gap" --json',
          testResult: '{"passed":true} exit 0',
          verifiedHow: 'live-drove-ui',
        },
      });
      expect(r.ok).toBe(true);
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
    });

    it('a falsifiable `check` cited in summary closes normally (EI-20008560598714546)', async () => {
      getWorkItem.mockResolvedValue(item);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary:
            'LIVE EVIDENCE — /tmp/wi37549-check.json (11/11 passed, exit 0), recorded via tauri-agent-tools check --pid 255538 --json',
          testResult: '11/11 passed',
          verifiedHow: 'live-drove-ui',
        },
      });
      expect(r.ok).toBe(true);
      expect(r.error).toBeUndefined();
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
    });

    // EI-18855312333744373 — WI-6553's actual shape: a deployed-web verification, cited
    // as URL paths + HTTP status codes, wrongly rejected as fabricated because the
    // extractor read `/me.jpg` as a local filesystem citation.
    it('a BACKED claim via deployed URL + HTTP status (a web-deploy verification) closes normally, citing NOTHING on local disk', async () => {
      getWorkItem.mockResolvedValue(item);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 'shipped the /about page to Cloudflare Pages',
          testResult:
            'https://papercusp.com/about -> 200 (5,214 B); /me.jpg -> 200 (121,060 B); ' +
            '/shots/shot-oddsmith.png -> 200 (89,004 B)',
          verifiedHow: 'live-drove-ui',
        },
      });
      expect(r.ok).toBe(true);
      expect(r.error).toBeUndefined();
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
      expect(r.workItem.state).toBe('passed');
    });

    it("does NOT touch a close whose verifiedHow is 'unit' (the gate is scoped to 'live-drove-ui' only)", async () => {
      getWorkItem.mockResolvedValue(item);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: { summary: 'fixed', testResult: '5/5 green', verifiedHow: 'unit' },
      });
      expect(r.ok).toBe(true);
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
    });

    it('does NOT fire on a record-only completion (no `state` — nothing is being closed)', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        completion: { summary: 'progress note', verifiedHow: 'live-drove-ui' },
      });
      expect(r.ok).toBe(true); // record-only stays legitimate regardless of this gate
      expect(r.error).toBeUndefined();
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });
  });

  describe("completion-boundary runtime guard — unbacked verifiedHow:'live-service' REJECTS the close (EI-20096763429995249)", () => {
    it.each([
      { name: 'unit tests only', testsRun: 'npm run test:file -- bundle-host.test.ts', testResult: '18/18 tests passed' },
      { name: 'runtime observations without a service', testsRun: 'dev:restart target staging', testResult: 'ActiveState=active; MainPID=4242; HTTP 200' },
      { name: 'named service without an observation', testsRun: 'systemctl --user restart papercup-staging-api.service', testResult: 'restart command completed' },
    ])('refuses the same preview and close for $name without preview writes', async ({ testsRun, testResult }) => {
      getWorkItem.mockResolvedValue(item);
      const args = {
        id: 'F-12',
        state: 'passed',
        completion: { summary: 'fixed the service startup path', testsRun, testResult, verifiedHow: 'live-service' },
      };

      const preview = await one({ ...args, validateOnly: true });

      expect(preview.ok).toBe(false);
      expect(preview.validationOnly).toBe(true);
      expect(preview.error).toMatch(/live-service/);
      expect(preview.stateError).toBe(preview.error);
      expect(preview.countsTowardBurnDown).toBe(false);
      expect(preview.completionContract.requirements).toContainEqual(expect.objectContaining({
        key: 'live-service-evidence', applicable: true, satisfied: false,
      }));
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(commentWorkItem).not.toHaveBeenCalled();
      expect(mergeWorkItemOutputPayload).not.toHaveBeenCalled();

      const close = await one(args);
      expect(close.ok).toBe(false);
      expect(close.stateError).toBe(preview.stateError);
      expect(close.error).toContain(preview.error);
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    it.each([false, true])('accepts backed preview and close with nested evidence=%s', async (nested) => {
      getWorkItem.mockResolvedValue(item);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
      const evidence = {
        testsRun: 'systemctl --user show papercup-staging-api.service',
        testResult: 'ActiveState=active; MainPID=4242; GET http://localhost:3170/api/health -> 200',
        verifiedHow: 'live-service',
      };
      const args = {
        id: 'F-12', state: 'passed',
        completion: { summary: 'fixed the service startup path', ...(nested ? { verification: evidence } : evidence) },
      };

      const preview = await one({ ...args, validateOnly: true });
      expect(preview.ok).toBe(true);
      expect(preview.completionContract.requirements).toContainEqual(expect.objectContaining({
        key: 'live-service-evidence', applicable: true, satisfied: true,
      }));
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(commentWorkItem).not.toHaveBeenCalled();
      expect(mergeWorkItemOutputPayload).not.toHaveBeenCalled();

      const close = await one(args);
      expect(close.ok).toBe(true);
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledOnce();
    });

    it('keeps record-only live-service previews outside the close requirement', async () => {
      getWorkItem.mockResolvedValue(item);
      const preview = await one({
        id: 'F-12', validateOnly: true,
        completion: { summary: 'progress note', verifiedHow: 'live-service' },
      });
      expect(preview.ok).toBe(true);
      expect(preview.completionContract.requirements).toContainEqual(expect.objectContaining({
        key: 'live-service-evidence', applicable: false, satisfied: null,
      }));
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(commentWorkItem).not.toHaveBeenCalled();
    });

    it('rejects a unit-test-only close and never attempts the state write', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 'fixed the service startup path',
          testsRun: 'npm run test:file -- bundle-host.test.ts',
          testResult: '18/18 tests passed',
          verifiedHow: 'live-service',
        },
      });

      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/REJECTED/);
      expect(r.error).toMatch(/live-service/);
      expect(r.error).toMatch(/MainPID/);
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(r.completion).toMatchObject({ summary: 'fixed the service startup path' });
    });

    it('accepts a named service and falsifiable runtime observations split across evidence fields', async () => {
      getWorkItem.mockResolvedValue(item);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 'fixed the service startup path',
          verification: {
            testsRun: 'dev:restart then systemctl --user show papercup-staging-api.service',
            testResult: 'ActiveState=active; NRestarts=0; MainPID=4242; GET http://localhost:3170/api/health -> 200',
            verifiedHow: 'live-service',
          },
        },
      });

      expect(r.ok).toBe(true);
      expect(r.error).toBeUndefined();
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
      expect(r.workItem.state).toBe('passed');
    });

    it('rejects runtime-looking observations that name no concrete service/unit/process', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 'restarted it',
          testsRun: 'dev:restart target staging',
          testResult: 'ActiveState=active; MainPID=4242; HTTP 200',
          verifiedHow: 'live-service',
        },
      });

      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/concrete service\/unit\/process/);
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    it('does not fire on record-only evidence because no close is being attempted', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        completion: { summary: 'progress note', verifiedHow: 'live-service' },
      });

      expect(r.ok).toBe(true);
      expect(r.error).toBeUndefined();
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });
  });

  it('passes structured verification evidence to the terminal state writer', async () => {
    getWorkItem.mockResolvedValue(item);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
    await one({
      id: 'F-12',
      state: 'passed',
      completion: {
        summary: 'shipped',
        tests: 'pnpm vitest complete.test.ts --run',
        testResult: '1/1 green',
        // EI-21973530107303854: a REAL path on purpose — `addedTests: true` requires one,
        // or the close is refused for `added-tests-without-path` and never reaches the
        // content-identity gate at all. Which real path does not matter: see the authority
        // assertion below for why this test no longer depends on its git state.
        filesChanged: ['packages/operator-core/vitest.config.ts'],
        verifiedHow: 'unit',
        addedTests: true,
      },
    });
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'F-12',
      'passed',
      expect.objectContaining({
        // P-004: this used to assert `completionRef: 'shipped'` — the auto-fill from
        // completion.summary. That auto-fill is DELETED (it made the completion-integrity
        // gate unfailable by construction for this tool), and the state writer is handed
        // the AUTHORITY JUDGEMENT instead. What this test owns is that the judgement RIDES
        // THROUGH to the writer; the two-comments-down reasoning about `treeStamp` —
        // "asserting strict equality here would couple this test both to the stamp's
        // presence AND to the real repo's current HEAD" — applies to this field too, and
        // was simply never extended to it.
        //
        // EI-21973530107303854: pinning `'committed'` DID couple it. The content-identity
        // floor only returns `committed` when every declared path's working-tree blob
        // equals its HEAD blob, so this assertion silently depended on package.json being
        // clean at that instant — and on a tree ~100 agents commit to, it periodically is
        // not, reddening a test with nothing wrong with the code (measured 2026-08-31:
        // working 853b934 vs HEAD 665d4d6). No deterministic route to `committed` exists
        // here: `addedTests: true` forces a non-empty filesChanged, and any real path can
        // be dirty while any fake one is unprovable. So this asserts a VALID JUDGEMENT was
        // handed over, and complete.content-identity-floor.test.ts — which controls
        // identity directly instead of reading the live tree — owns which value is correct.
        completionAuthority: expect.stringMatching(/^(?:committed|proposed)$/),
        // EI-19319623239777505: `summary` now rides alongside the structured fields
        // (previously silently dropped — see the dedicated tests below).
        // `objectContaining` rather than a strict object: EI-18682004530991057 adds a
        // SERVER-stamped `treeStamp` (the HEAD sha the evidence was observed against),
        // which is not caller-supplied and is deliberately absent when it cannot be
        // observed. Asserting strict equality here would couple this test both to the
        // stamp's presence AND to the real repo's current HEAD. What this test is FOR is
        // that every caller-supplied field rides through — which is what it still asserts.
        completionEvidence: expect.objectContaining({
          filesChanged: ['packages/operator-core/vitest.config.ts'],
          testsRun: 'pnpm vitest complete.test.ts --run',
          testResult: '1/1 green',
          verifiedHow: 'unit',
          addedTests: true,
          summary: 'shipped',
        }),
      }),
    );
    const persisted = setWorkItemStateWithAliasInfo.mock.calls[0][2].completionEvidence;
    expect(persisted?.settlementManifest).toMatchObject({
      version: 1,
      generation: 1,
      normalizedPaths: ['packages/operator-core/vitest.config.ts'],
    });
    expect(persisted?.settlementManifest?.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(setWorkItemStateWithAliasInfo.mock.calls[0][2]).not.toHaveProperty('completionRef');
  });

  // EI-19319623239777505: before this, `completion.summary` was echoed back in the
  // tool's RETURN value but never written to the row — work_items:complete deliberately
  // never passes `completionRef` (P-004, asserted above), and the structured
  // `completionEvidence` object built by `completionEvidenceFromRecord` never included
  // `summary` at all. A reader of `payload._completionEvidence` after the call had no way
  // to recover the caller's narrative, only the structured judgement.
  it('carries `completion.summary` through onto the persisted completionEvidence, alongside structured fields', async () => {
    getWorkItem.mockResolvedValue(item);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
    await one({
      id: 'F-12',
      state: 'passed',
      completion: {
        summary: 'A long free-text narrative describing exactly what changed and why.',
        testsRun: 'npm run test:file -- x.test.ts',
        verifiedHow: 'unit',
      },
    });
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'F-12',
      'passed',
      expect.objectContaining({
        completionEvidence: expect.objectContaining({
          summary: 'A long free-text narrative describing exactly what changed and why.',
          testsRun: 'npm run test:file -- x.test.ts',
          verifiedHow: 'unit',
        }),
      }),
    );
  });

  it('persists the canonical declared work outcome without interpreting authority as a new change', async () => {
    getWorkItem.mockResolvedValue(item);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
    await one({
      id: 'F-12',
      state: 'passed',
      completion: {
        summary: 'verified an existing repair',
        verification: {
          verifiedHow: 'unit',
          testsRun: 'npm test',
          testResult: 'passed',
          workOutcome: 'verified-existing',
        },
      },
    });
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'F-12',
      'passed',
      expect.objectContaining({
        completionEvidence: expect.objectContaining({ workOutcome: 'verified-existing' }),
      }),
    );
  });

  // EI-21478999218933285: these fields were accepted and rendered into the
  // completion broadcast, but silently disappeared from the work-item row. A
  // later audit reading work_items:get therefore treated a known-positive close
  // as if it had disclosed no deferrals or landed work at all.
  it('persists deferred, whatLanded, and coordNotes without treating narrative as verification authority', async () => {
    getWorkItem.mockResolvedValue(item);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
    await one({
      id: 'F-12',
      state: 'passed',
      completion: {
        summary: 'shipped the bounded slice',
        whatLanded: ['complete.ts now carries the narrative record'],
        deferred: ['live deploy verification remains on EI-42'],
        coordNotes: 'leader should read the deferred set before closing the plan',
      },
    });

    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'F-12',
      'passed',
      expect.objectContaining({
        completionAuthority: 'proposed',
        completionEvidence: expect.objectContaining({
          summary: 'shipped the bounded slice',
          whatLanded: ['complete.ts now carries the narrative record'],
          deferred: ['live deploy verification remains on EI-42'],
          coordNotes: 'leader should read the deferred set before closing the plan',
        }),
      }),
    );
    const persisted = setWorkItemStateWithAliasInfo.mock.calls[0][2].completionEvidence;
    for (const authorityBearingField of ['testsRun', 'testResult', 'verifiedHow']) {
      expect(persisted).not.toHaveProperty(authorityBearingField);
    }
  });

  // The summary-only case: NO structured fields at all. Before this fix
  // `completionEvidenceFromRecord` returned `undefined` here (nothing structured to
  // report) and the summary went with it. The summary must still land, even though
  // `completionAuthority` correctly stays 'proposed' (no verifiedHow/testsRun/testResult).
  it('still persists a bare summary with zero structured evidence — and does not thereby fake a `committed` authority', async () => {
    getWorkItem.mockResolvedValue(item);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
    await one({
      id: 'F-12',
      state: 'passed',
      completion: { summary: 'just a narrative, no structured evidence' },
    });
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'F-12',
      'passed',
      expect.objectContaining({
        completionAuthority: 'proposed',
        completionEvidence: expect.objectContaining({ summary: 'just a narrative, no structured evidence' }),
      }),
    );
    // The strict-equality assertion above was doing real work — it proved no structured
    // field was INVENTED for a caller who supplied none. EI-18682004530991057 adds a
    // server-stamped `treeStamp`, so strict equality is no longer available; the guarantee
    // is asserted directly instead, which states it more plainly than the old shape did.
    // (`treeStamp` is deliberately NOT in this list: it describes the evidence, it is
    // never evidence, and `authorityForCompletion` does not read it — hence 'proposed'.)
    const persisted = setWorkItemStateWithAliasInfo.mock.calls[0][2].completionEvidence;
    for (const invented of ['filesChanged', 'testsRun', 'testResult', 'verifiedHow', 'addedTests', 'coverage']) {
      expect(persisted).not.toHaveProperty(invented);
    }
  });

  it('fills completion.workItem from the id when the caller omits it (DRY)', async () => {
    getWorkItem.mockResolvedValue(item);
    const r = await one({ id: 'F-12', completion: { summary: 's' } });
    expect(r.completion.workItem).toBe('F-12');
  });

  it('persists outputPayload onto the work-item row for sidecar reads (EI-7214)', async () => {
    const outputPayload = { signalId: 'sig-1', score: 0.87 };
    getWorkItem.mockResolvedValue(item);
    const r = await one({
      id: 'F-12',
      harness: 'papercup',
      completion: { summary: 'analysis complete', tests: 'unit fixture' },
      outputPayload,
    });

    expect(mergeWorkItemOutputPayload).toHaveBeenCalledWith('F-12', outputPayload, { harness: 'papercup' });
    expect(r.outputPayload).toEqual(outputPayload);
  });

  it('passes terminal outputPayload to the canonical state writer before the sidecar merge', async () => {
    const outputPayload = { answer: 'done' };
    getWorkItem.mockResolvedValue(item);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'done' }));
    await one({
      id: 'F-12', harness: 'papercup', state: 'done',
      completion: { summary: 'typed result complete', tests: 'unit fixture' },
      outputPayload,
    });
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'F-12', 'done', expect.objectContaining({ outputPayload }),
    );
    expect(mergeWorkItemOutputPayload).toHaveBeenCalledWith('F-12', outputPayload, { harness: 'papercup' });
  });

  it('returns the completion-boundary reflect step (self-learning P-001/B)', async () => {
    getWorkItem.mockResolvedValue(item); // harness: 'papercup' → pipeline markers shown
    const r = await one({ id: 'F-12', completion: { summary: 'done' } });
    expect(typeof r.reflect).toBe('string');
    expect(r.reflect).toMatch(/improvements:capture/);
    expect(r.reflect).toMatch(/workaround/);
    expect(r.reflect).toMatch(/validator|reviewer/i);
  });

  it('reflect step omits the harness-pipeline markers for a harness-free unit of work', async () => {
    getWorkItem.mockResolvedValue({ ...item, harness: null });
    const r = await one({ id: 'F-12', completion: { summary: 'done' } });
    expect(r.reflect).toMatch(/workaround/);
    expect(r.reflect).not.toMatch(/validator|reviewer/i);
  });

  // EI-24 (never LOSE the completion) + WI-4529 (never LIE about whether it closed) — both hold
  // at once, and they are independent. This test previously asserted `ok:true` alongside the
  // EI-24 contract, which baked the silent-success in: the state write FAILED, the item never
  // moved, and the caller was told ok. EI-24 is about not DROPPING the record (completion +
  // stateError are still returned + emitted below) — it never required lying about the outcome.
  it('a FAILED state write never loses the completion (EI-24) AND reports ok:false (WI-4529)', async () => {
    getWorkItem.mockResolvedValue({ ...item, id: 'WI-8', kind: 'task', family: 'issue' });
    setWorkItemStateWithAliasInfo.mockRejectedValue(
      new Error(
        "work_item 'WI-8' (kind=task) cannot take state 'bogus' — valid: open, resolved, closed, done, dropped, todo",
      ),
    );
    const r = await one({ id: 'WI-8', state: 'bogus', completion: { summary: 'work landed; state vocab wrong' } });
    expect(r.ok).toBe(false); // WI-4529: the requested transition did NOT happen
    expect(r.error).toMatch(/DID NOT CLOSE/);
    expect(r.completion.summary).toBe('work landed; state vocab wrong'); // EI-24: record intact
    expect(r.stateError).toMatch(/valid: open, resolved, closed/);
    expect(r.workItem.id).toBe('WI-8'); // falls back to the pre-transition item
    expect(r.aliased).toBeUndefined(); // a failed write has nothing to compare — see EI-7712 block below
  });

  it('completes MANY via items:[…] — one self-describing result per item; a not-found never fails the rest', async () => {
    getWorkItem.mockImplementation(async (id: string) => (id === 'F-404' ? null : { ...item, id }));
    const out = await env({
      items: [
        { id: 'F-1', completion: { summary: 'a' } },
        { id: 'F-404', completion: { summary: 'b' } },
        { id: 'F-3', completion: { summary: 'c' } },
      ],
    });
    expect(out.counts).toEqual({ ok: 2, failed: 1 });
    expect(out.results.map((r: { id: string }) => r.id)).toEqual(['F-1', 'F-404', 'F-3']);
    expect(out.results[1]).toMatchObject({ ok: false, id: 'F-404' });
    expect(out.results[0]).toMatchObject({ ok: true, id: 'F-1', completion: { summary: 'a' } });
  });

  // ── RETIRED LEGACY VAL TEST-COMPLETION GATE (verification-system-improvements-2026-10-10 P-003) ──
  describe('retired VAL test-completion gate', () => {
    it('a terminal feature completion is not refused by any VAL/harness_tests rollup, even with every flag ON', async () => {
      getFlag.mockResolvedValue(true);
      getWorkItem.mockResolvedValue(item); // family:'feature', harness:'papercup'
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
      const out = await env({ id: 'F-12', state: 'passed', completion: { summary: 'shipped' } });
      expect(out.counts).toEqual({ ok: 1, failed: 0 });
      expect(String(out.results[0].error ?? '')).not.toMatch(/VAL/);
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
        'F-12',
        'passed',
        expect.objectContaining({ by: expect.any(String) }),
      );
    });
  });

  // ── FIRST-CLASS SPEC TEST-ADEQUACY GATE (P-007 / D-003..D-006) ──────────────────
  describe('spec-test-adequacy terminal gate', () => {
    const linkedIssue = {
      ...item,
      id: 'WI-101',
      kind: 'change',
      family: 'issue',
      state: 'wip',
      harness: 'papercusp',
      payload: {
        plan_item: {
          plan_slug: 'reconnect-plan',
          item_id: 'P-003',
          harness_slug: 'papercusp',
        },
      },
      sourcePlanSlug: 'reconnect-plan',
      sourcePlanItemIds: ['P-003'],
    };
    const linkedFeature = {
      ...item,
      id: 'F-101',
      kind: 'feature',
      family: 'feature',
      state: 'in_progress',
      harness: 'papercusp',
      payload: {
        plan_item: {
          plan_slug: 'reconnect-plan',
          item_id: 'P-004',
          harness_slug: 'papercusp',
        },
      },
      sourcePlanSlug: 'reconnect-plan',
      sourcePlanItemIds: ['P-004'],
    };
    const specAdequacy = {
      classRef: 'plan-class-feature-ship',
      evidenceRefs: ['test:reconnect'],
      current: [
        {
          evidenceKind: 'test',
          evidenceRef: 'test:reconnect',
          sourceFingerprint: 'git:abc',
          testFingerprint: 'sha256:test',
        },
      ],
    };
    const replaySpecAdequacy = {
      ...specAdequacy,
      specRevision: 1,
      specFingerprint: 'sha256:spec-v1',
      replaySnapshot: true,
    };
    const multiClauseReplaySpecAdequacy = {
      ...specAdequacy,
      replaySnapshot: true,
      current: [
        {
          planSlug: 'plan-one',
          specId: 'SPEC-001-01',
          specRevision: 1,
          specFingerprint: 'sha256:spec-v1',
          evidenceKind: 'test' as const,
          evidenceRef: 'test:reconnect',
          sourceFingerprint: 'git:abc',
          testFingerprint: 'sha256:test',
        },
        {
          planSlug: 'plan-two',
          specId: 'SPEC-002-01',
          specRevision: 4,
          specFingerprint: 'sha256:spec-v4',
          evidenceKind: 'test' as const,
          evidenceRef: 'test:reconnect-v2',
          sourceFingerprint: 'git:def',
          testFingerprint: 'sha256:test-v2',
        },
      ],
    };
    const behaviorChangePath = 'packages/operator-core/lib/agent-tools/work_items/complete.ts';

    it.each([
      { label: 'changed source without attestation', completion: { filesChanged: [behaviorChangePath] } },
      { label: 'deleted source without attestation', completion: { filesDeleted: [behaviorChangePath] } },
      { label: 'explicit attestation without paths', completion: {}, specAdequacy },
    ])('does not bypass the gate for a task claiming $label', async ({ completion, specAdequacy: proof }) => {
      const linkedTask = { ...linkedIssue, kind: 'task' };
      getWorkItem.mockResolvedValue(linkedTask);
      specTestAdequacyCompletionGate.mockResolvedValue({
        ok: false,
        applicable: true,
        retryable: true,
        reason: 'task-kind executable completion requires a code work-item kind',
        checked: [],
      });

      const r = await one({
        id: 'WI-101',
        state: 'done',
        completion: { summary: 'implemented', ...completion },
        ...(proof ? { specAdequacy: proof } : {}),
      });

      expect(specTestAdequacyCompletionGate).toHaveBeenCalledWith(
        expect.objectContaining({
          workItem: linkedTask,
          attestation: proof,
          workspaceId: 'default',
          completion: expect.objectContaining({ summary: 'implemented', ...completion }),
          changedPaths: [
            ...('filesChanged' in completion ? (completion.filesChanged ?? []) : []),
            ...('filesDeleted' in completion ? (completion.filesDeleted ?? []) : []),
          ],
        }),
      );
      expect(r).toMatchObject({ ok: false, specAdequacy: { applicable: true, retryable: true } });
      expect(mergeWorkItemOutputPayload).not.toHaveBeenCalled();
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    it('publishes a strict single and per-item bulk attestation shape', () => {
      expect(complete.args.safeParse({ id: 'WI-101', state: 'done', assumptions: 'none', completion: { summary: 'fixed' }, specAdequacy: {} }).success).toBe(true);
      expect(
        (complete.args as { safeParse: (x: unknown) => { success: boolean } }).safeParse({
          id: 'WI-101',
          state: 'resolved',
          assumptions: 'none',
          completion: { summary: 'fixed' },
          specAdequacy,
        }).success,
      ).toBe(true);
      expect(
        (complete.args as { safeParse: (x: unknown) => { success: boolean } }).safeParse({
          id: 'WI-101',
          state: 'resolved',
          assumptions: 'none',
          completion: { summary: 'fixed' },
          specAdequacy: replaySpecAdequacy,
        }).success,
      ).toBe(true);
      expect(
        (complete.args as { safeParse: (x: unknown) => { success: boolean } }).safeParse({
          id: 'WI-101',
          state: 'resolved',
          assumptions: 'none',
          completion: { summary: 'fixed' },
          specAdequacy: multiClauseReplaySpecAdequacy,
        }).success,
      ).toBe(true);
      expect(
        (complete.args as { safeParse: (x: unknown) => { success: boolean } }).safeParse({
          id: 'WI-101',
          state: 'resolved',
          assumptions: 'none',
          completion: { summary: 'fixed' },
          specAdequacy: {
            ...multiClauseReplaySpecAdequacy,
            specRevision: 1,
            specFingerprint: 'sha256:spec-v1',
          },
        }).success,
      ).toBe(false);
      expect(
        (complete.args as { safeParse: (x: unknown) => { success: boolean } }).safeParse({
          items: [
            {
              id: 'WI-101',
              state: 'resolved',
              assumptions: 'none',
              completion: { summary: 'fixed' },
              specAdequacy: replaySpecAdequacy,
            },
          ],
        }).success,
      ).toBe(true);
      expect(
        (complete.args as { safeParse: (x: unknown) => { success: boolean } }).safeParse({
          items: [
            {
              id: 'WI-101',
              state: 'resolved',
              assumptions: 'none',
              completion: { summary: 'fixed' },
              specAdequacy,
            },
          ],
        }).success,
      ).toBe(true);
      expect(
        (complete.args as { safeParse: (x: unknown) => { success: boolean } }).safeParse({
          id: 'WI-101',
          state: 'resolved',
          assumptions: 'none',
          completion: { summary: 'fixed' },
          specAdequacy: { ...specAdequacy, classRef: 'invented-parallel-rubric' },
        }).success,
      ).toBe(false);
      expect(
        (complete.args as { safeParse: (x: unknown) => { success: boolean } }).safeParse({
          id: 'WI-101',
          state: 'resolved',
          assumptions: 'none',
          completion: { summary: 'fixed' },
          specAdequacy: { ...specAdequacy, evidenceRefs: [] },
        }).success,
      ).toBe(false);
      expect(
        (complete.args as { safeParse: (x: unknown) => { success: boolean } }).safeParse({
          id: 'WI-101',
          state: 'resolved',
          assumptions: 'none',
          completion: { summary: 'fixed' },
          specAdequacy: { ...specAdequacy, specRevision: 1 },
        }).success,
      ).toBe(false);
      expect(
        (complete.args as { safeParse: (x: unknown) => { success: boolean } }).safeParse({
          id: 'WI-101',
          state: 'resolved',
          assumptions: 'none',
          completion: { summary: 'fixed' },
          specAdequacy: { ...specAdequacy, replaySnapshot: true },
        }).success,
      ).toBe(false);
    });

    it.each([
      {
        label: 'single-item',
        input: {
          id: 'WI-101',
          state: 'resolved',
          assumptions: 'none',
          completion: { summary: 'fixed' },
          specAdequacy: { ...specAdequacy, classRef: 'certify-spec-clauses' },
        },
      },
      {
        label: 'bulk-item',
        input: {
          items: [
            {
              id: 'WI-101',
              state: 'resolved',
              assumptions: 'none',
              completion: { summary: 'fixed' },
              specAdequacy: { ...specAdequacy, classRef: 'certify-spec-clauses' },
            },
          ],
        },
      },
    ])('reports invalid specAdequacy.classRef from the matching $label branch', ({ input }) => {
      const parsed = (
        complete.args as {
          safeParse: (
            value: unknown,
          ) => { success: true } | { success: false; error: { issues: Array<{ message: string }> } };
        }
      ).safeParse(input);
      expect(parsed.success).toBe(false);
      if (parsed.success) return;

      const message = parsed.error.issues.map((issue) => issue.message).join('\n');
      expect(message).toContain('specAdequacy.classRef');
      for (const ref of [
        'plan-class-feature-ship',
        'plan-class-bugfix',
        'plan-class-migration',
        'plan-class-investigation',
      ]) {
        expect(message).toContain(ref);
      }
      expect(message).not.toContain('Unrecognized key: "specAdequacy"');
    });

    it('documents specAdequacy/outputPayload as top-level siblings and auto-hoists a nested specAdequacy (EI-22073105984724419, was EI-21709695952126373)', () => {
      expect(complete.guidance?.when).toContain('top-level siblings of `completion`');
      expect(complete.guidance?.when).toContain('auto-hoisted');
      expect(complete.guidance?.when).toContain('results[].workItem.payload.out');
      expect(complete.guidance?.when).toContain('payloadTier:"full"');
      const parsed = (
        complete.args as {
          safeParse: (x: unknown) => {
            success: boolean;
            data?: { specAdequacy?: unknown; completion?: { specAdequacy?: unknown } };
          };
        }
      ).safeParse({
        id: 'WI-101',
        state: 'resolved',
        assumptions: 'none',
        completion: { summary: 'fixed', specAdequacy },
      });
      expect(parsed.success).toBe(true);
      expect(parsed.data?.specAdequacy).toEqual(specAdequacy);
      expect(parsed.data?.completion?.specAdequacy).toBeUndefined();
    });

    it('a top-level specAdequacy always wins over a nested one — a real conflict is preserved, not silently resolved', () => {
      expect(
        (complete.args as { safeParse: (x: unknown) => { success: boolean } }).safeParse({
          id: 'WI-101',
          state: 'resolved',
          assumptions: 'none',
          completion: { summary: 'fixed', specAdequacy },
          specAdequacy: { ...specAdequacy, classRef: 'invented-parallel-rubric' },
        }).success,
        // the nested specAdequacy is left in `completion` (untouched by the hoist,
        // since the top-level sibling already had a value) and CompletionRecordSchema
        // rejects it as an unrecognized key — the same "genuine disagreement" outcome
        // hoistMisplacedCompletionFields already gives a caller who sets both.
      ).toBe(false);
    });

    it('does not consult the gate for a record-only completion', async () => {
      getWorkItem.mockResolvedValue(linkedIssue);

      const r = await one({ id: 'WI-101', completion: { summary: 'progress' } });

      expect(r.ok).toBe(true);
      expect(specTestAdequacyCompletionGate).not.toHaveBeenCalled();
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    it.each([
      {
        label: 'a zero-path successful close',
        state: 'resolved',
        landedState: 'resolved',
        completion: { summary: 'no behavior change was needed' },
      },
      {
        label: 'a discard close',
        state: 'dropped',
        landedState: 'dropped',
        completion: { summary: 'wontfix; no behavior change', filesChanged: [behaviorChangePath] },
      },
      {
        label: 'a duplicate close',
        state: 'resolved',
        landedState: 'resolved',
        completion: { summary: 'superseded by the canonical item', duplicateOf: 'EI-survivor' },
      },
    ])('does not pass $label through the behavior gate', async ({ label, state, landedState, completion }) => {
      getWorkItem.mockResolvedValue(linkedIssue);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...linkedIssue, state: landedState }));
      if (label === 'a duplicate close') {
        resolveWorkItemRef.mockResolvedValue({ kind: 'bug', ref: 'papercup#EI-survivor' });
      }

      const r = await one({ id: 'WI-101', state, completion });

      expect(r.ok).toBe(true);
      expect(specTestAdequacyCompletionGate).not.toHaveBeenCalled();
      expect(r.specAdequacy).toBeUndefined();
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
    });

    it.each([
      {
        label: 'a changed path',
        completion: { summary: 'fixed', filesChanged: [behaviorChangePath] },
      },
      {
        label: 'a deleted path',
        completion: { summary: 'removed the obsolete behavior', filesDeleted: [behaviorChangePath] },
      },
    ])('keeps the behavior gate for an ordinary resolved close with $label', async ({ completion }) => {
      getWorkItem.mockResolvedValue(linkedIssue);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...linkedIssue, state: 'resolved' }));
      specTestAdequacyCompletionGate.mockResolvedValue({
        ok: true,
        applicable: true,
        checked: ['SPEC-003-01@1'],
      });

      const r = await one({ id: 'WI-101', state: 'resolved', completion, specAdequacy });

      expect(r.ok).toBe(true);
      expect(specTestAdequacyCompletionGate).toHaveBeenCalledWith(
        expect.objectContaining({
          workItem: linkedIssue,
          attestation: specAdequacy,
          workspaceId: 'default',
          completion: expect.objectContaining(completion),
        }),
      );
      expect(r.specAdequacy).toEqual({ applicable: true, checked: ['SPEC-003-01@1'] });
    });

    it('routes a successful feature close with changed paths through grading-audit reopen dispatch', async () => {
      getWorkItem.mockResolvedValue(linkedFeature);
      const pendingTargets = ['EI-feature-legacy-audit'];
      specTestAdequacyCompletionGate.mockResolvedValue({
        ok: false,
        applicable: true,
        retryable: true,
        reason: 'SPEC-004-01@1: no current terminal complete scorecard',
        checked: [],
        pendingGradingAuditTargetIds: pendingTargets,
      });
      const dispatchResult = {
        requestedTargetIds: pendingTargets,
        receipts: [{ issueId: pendingTargets[0], state: 'routed' as const, conversationId: 'audit-feature' }],
      };
      dispatchPendingGradingAudits.mockResolvedValue(dispatchResult);

      const r = await one({
        id: 'F-101',
        state: 'passed',
        completion: { summary: 'shipped', filesChanged: [behaviorChangePath] },
        specAdequacy,
      });

      expect(specTestAdequacyCompletionGate).toHaveBeenCalledWith(
        expect.objectContaining({
          workItem: linkedFeature,
          attestation: specAdequacy,
          workspaceId: 'default',
          completion: expect.objectContaining({ summary: 'shipped', filesChanged: [behaviorChangePath] }),
          changedPaths: [behaviorChangePath],
        }),
      );
      expect(dispatchPendingGradingAudits).toHaveBeenCalledWith({
        targetIds: pendingTargets,
        ctx,
        harness: 'papercusp',
      });
      expect(r).toMatchObject({
        ok: false,
        specAdequacy: { gradingAuditDispatch: dispatchResult },
      });
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    // WI-10002404: a pending-audit refusal that names no recovery lever is a closed loop —
    // the same defect WI-10002063 fixed for the FAILED branch one ternary down. Measured
    // 2026-09-22: 46 grading audits stranded (max 13.2d) while scorecards:repair, the
    // callable path behind this very dispatcher, appeared nowhere a caller could see it.
    it('names scorecards:repair as the recovery lever on a PENDING grading audit (WI-10002404)', async () => {
      getWorkItem.mockResolvedValue(linkedFeature);
      const pendingTargets = ['EI-pending-needs-a-lever'];
      specTestAdequacyCompletionGate.mockResolvedValue({
        ok: false,
        applicable: true,
        retryable: true,
        reason: 'SPEC-004-01@1: no current terminal complete scorecard',
        checked: [],
        pendingGradingAuditTargetIds: pendingTargets,
      });
      dispatchPendingGradingAudits.mockResolvedValue({
        requestedTargetIds: pendingTargets,
        receipts: [
          {
            issueId: pendingTargets[0],
            state: 'skipped' as const,
            reason: 'another dispatcher already reserved this scorecard',
          },
        ],
      });

      const r = await one({
        id: 'F-101',
        state: 'passed',
        completion: { summary: 'shipped', filesChanged: [behaviorChangePath] },
        specAdequacy,
      });

      expect(r.ok).toBe(false);
      const message = String(r.error ?? '');
      // The lever itself — the whole point of the fix.
      expect(message).toContain('scorecards:repair');
      // The two misreadings that stranded cards: re-emitting, and repairing too early.
      expect(message).toMatch(/DUPLICATE/i);
      expect(message).toMatch(/15-minute reservation lease/i);

      // Calibration + dead-weight guard. The PRE-FIX opening is deliberately kept here as a
      // permanent counterexample: it must FAIL the lever assertion while the real message
      // must still carry it verbatim. Without this pair a later "simplification" of the
      // guidance could satisfy the assertions above vacuously.
      //
      // WI-10002440: this anchor was TRIMMED to the still-true opening. It previously ran on
      // through "Declines and expiry advance the existing cascade.", which pinned a FALSE
      // claim into the contract — asserting the message must contain it meant correcting the
      // falsehood broke this test. Keep the calibration, not the error.
      const preFixStableOpening =
        'Retry after binding current proof, emitting terminal scorecards, and settling any pending grading audits. The existing router selects independent auditors automatically; the returned gradingAuditDispatch receipts identify routed conversations or bounded launch fallback.';
      expect(preFixStableOpening).not.toContain('scorecards:repair');
      expect(message).toContain(preFixStableOpening);

      // The cascade does NOT advance on its own: dispatch at emit and at completion is
      // one-shot, and the only periodic re-dispatcher (acceptance-grading-sweep) was paused
      // on 2026-09-15 — precisely the state that stranded 46 cards for up to 13.2d. The old
      // sentence also flatly contradicted the repair instruction that now follows it.
      expect(message).not.toContain('Declines and expiry advance the existing cascade');
      expect(message).toMatch(/only advances the cascade while a dispatcher actually RUNS/);
    });

    it('honors explicit spec adequacy on a successful feature close with no changed paths', async () => {
      getWorkItem.mockResolvedValue(linkedFeature);
      const pendingTargets = ['EI-feature-verification-audit'];
      specTestAdequacyCompletionGate.mockResolvedValue({
        ok: false,
        applicable: true,
        retryable: true,
        reason: 'SPEC-004-01@1: grading audit pending',
        checked: [],
        pendingGradingAuditTargetIds: pendingTargets,
      });
      const dispatchResult = {
        requestedTargetIds: pendingTargets,
        receipts: [{ issueId: pendingTargets[0], state: 'routed' as const, conversationId: 'audit-verification' }],
      };
      dispatchPendingGradingAudits.mockResolvedValue(dispatchResult);

      const r = await one({
        id: 'F-101',
        state: 'passed',
        completion: { summary: 'verification-only feature complete' },
        specAdequacy,
      });

      expect(specTestAdequacyCompletionGate).toHaveBeenCalledWith(
        expect.objectContaining({
          workItem: linkedFeature,
          attestation: specAdequacy,
          workspaceId: 'default',
          completion: expect.objectContaining({ summary: 'verification-only feature complete' }),
          changedPaths: [],
        }),
      );
      expect(dispatchPendingGradingAudits).toHaveBeenCalledWith({
        targetIds: pendingTargets,
        ctx,
        harness: 'papercusp',
      });
      expect(r).toMatchObject({
        ok: false,
        specAdequacy: { gradingAuditDispatch: dispatchResult },
      });
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    it('forwards documentation inventory paths and surfaces the registered exemption on feature close', async () => {
      getWorkItem.mockResolvedValue(linkedFeature);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...linkedFeature, state: 'passed' }));
      const exempted = [
        'AUTO-BAR-R-1-P-004@1 — exempt (registered non-code inventory scope INVENTORY-P-004@1; item completion only, final shipment BAR proof remains required)',
      ];
      specTestAdequacyCompletionGate.mockResolvedValue({
        ok: true,
        applicable: false,
        checked: [],
        exempted,
      });
      const inventoryPath = 'docs/evidence/inventory.json';

      const r = await one({
        id: 'F-101',
        state: 'passed',
        completion: { summary: 'read-only inventory complete', filesChanged: [inventoryPath] },
      });

      expect(specTestAdequacyCompletionGate).toHaveBeenCalledWith(
        expect.objectContaining({
          workItem: linkedFeature,
          attestation: undefined,
          workspaceId: 'default',
          completion: expect.objectContaining({ summary: 'read-only inventory complete', filesChanged: [inventoryPath] }),
          changedPaths: [inventoryPath],
        }),
      );
      expect(r).toMatchObject({
        ok: true,
        specAdequacy: { applicable: false, checked: [], exempted },
      });
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
    });

    it('keeps a deprecated feature close outside the spec-adequacy gate', async () => {
      getWorkItem.mockResolvedValue(linkedFeature);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...linkedFeature, state: 'deprecated' }));

      const r = await one({
        id: 'F-101',
        state: 'deprecated',
        completion: { summary: 'declined', filesChanged: [behaviorChangePath] },
      });

      expect(r.ok).toBe(true);
      expect(specTestAdequacyCompletionGate).not.toHaveBeenCalled();
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
    });

    it('passes the exact caller attestation and reports every checked clause on success', async () => {
      getWorkItem.mockResolvedValue(linkedIssue);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...linkedIssue, state: 'resolved' }));
      specTestAdequacyCompletionGate.mockResolvedValue({
        ok: true,
        applicable: true,
        checked: ['SPEC-003-01@1'],
      });

      const r = await one({
        id: 'WI-101',
        state: 'resolved',
        completion: { summary: 'fixed', filesChanged: [behaviorChangePath] },
        specAdequacy,
      });

      expect(specTestAdequacyCompletionGate).toHaveBeenCalledWith(
        expect.objectContaining({
          workItem: linkedIssue,
          attestation: specAdequacy,
          workspaceId: 'default',
          completion: expect.objectContaining({ summary: 'fixed', filesChanged: [behaviorChangePath] }),
        }),
      );
      expect(r.specAdequacy).toEqual({ applicable: true, checked: ['SPEC-003-01@1'] });
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
    });

    // P-016/D-013: the gate's advisory impact report has to REACH the caller — a report
    // nobody receives is indistinguishable from no report, which is the state P-016 was
    // in while the resolver had no production consumer. These two cases pin delivery on
    // both paths, and pin that a populated report is NOT itself a refusal.
    it('surfaces the advisory impact report on the success path without blocking the close', async () => {
      getWorkItem.mockResolvedValue(linkedIssue);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...linkedIssue, state: 'resolved' }));
      specTestAdequacyCompletionGate.mockResolvedValue({
        ok: true,
        applicable: false,
        checked: [],
        impactReport: 'other-plan/SPEC-900-01@1. Reported, not enforced.',
      });

      const r = await one({
        id: 'WI-101',
        state: 'resolved',
        completion: { summary: 'fixed', filesChanged: [behaviorChangePath] },
        specAdequacy,
      });

      expect(r.ok).toBe(true);
      expect(r.specAdequacy).toEqual({
        applicable: false,
        checked: [],
        impactReport: 'other-plan/SPEC-900-01@1. Reported, not enforced.',
      });
      // The close still happened — reporting must never become enforcement (P-013 owns that).
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
    });

    it('carries the advisory impact report onto a refusal too', async () => {
      getWorkItem.mockResolvedValue(linkedIssue);
      specTestAdequacyCompletionGate.mockResolvedValue({
        ok: false,
        applicable: true,
        retryable: true,
        reason: 'SPEC-003-01@1: fail [freshness]',
        checked: [],
        impactReport: 'other-plan/SPEC-900-01@1. Reported, not enforced.',
      });

      const r = await one({
        id: 'WI-101',
        state: 'resolved',
        completion: { summary: 'fixed', filesChanged: [behaviorChangePath] },
        specAdequacy,
      });

      expect(r.ok).toBe(false);
      expect(r.specAdequacy).toMatchObject({
        applicable: true,
        retryable: true,
        impactReport: 'other-plan/SPEC-900-01@1. Reported, not enforced.',
      });
    });

    it('refuses before every completion/state write when current proof is insufficient', async () => {
      getWorkItem.mockResolvedValue(linkedIssue);
      specTestAdequacyCompletionGate.mockResolvedValue({
        ok: false,
        applicable: true,
        retryable: true,
        reason: 'SPEC-003-01@1: fail [freshness, execution-integrity]',
        checked: [],
      });

      const r = await one({
        id: 'WI-101',
        state: 'resolved',
        completion: { summary: 'fixed', filesChanged: [behaviorChangePath] },
        specAdequacy,
      });

      expect(r).toMatchObject({
        ok: false,
        specAdequacy: { applicable: true, retryable: true, checked: [] },
      });
      expect(r.error).toContain('freshness, execution-integrity');
      expect(r.error).toContain('specAdequacy.current');
      expect(r.error).toContain('testFingerprint?');
      expect(r.error).toContain('fixtureFingerprint?');
      expect(r.error).toContain('every selected bound evidence ref');
      expect(r.error).toContain('specAdequacy.evidenceRefs');
      expect(r.error).toContain('omitted values remain unknown and cannot pass');
      expect(r.error).toContain('No completion record or state transition was written');
      expect(r.completion).toBeUndefined();
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(attachCompletionEvidenceToSettledItem).not.toHaveBeenCalled();
    });

    it('dispatches pending grading auditors and returns their receipts with the refusal', async () => {
      getWorkItem.mockResolvedValue(linkedIssue);
      const pendingTargets = ['EI-pending-1', 'EI-pending-2'];
      specTestAdequacyCompletionGate.mockResolvedValue({
        ok: false,
        applicable: true,
        retryable: true,
        reason: 'SPEC-003-01@1: no current terminal complete scorecard',
        checked: [],
        pendingGradingAuditTargetIds: pendingTargets,
      });
      const dispatchResult = {
        requestedTargetIds: pendingTargets,
        receipts: pendingTargets.map((issueId) => ({
          issueId,
          state: 'routed' as const,
          conversationId: `audit-${issueId}`,
        })),
      };
      dispatchPendingGradingAudits.mockResolvedValue(dispatchResult);

      const r = await one({
        id: 'WI-101',
        state: 'resolved',
        completion: { summary: 'fixed', filesChanged: [behaviorChangePath] },
        specAdequacy,
      });

      expect(dispatchPendingGradingAudits).toHaveBeenCalledWith({
        targetIds: pendingTargets,
        ctx,
        harness: 'papercusp',
      });
      expect(r).toMatchObject({
        ok: false,
        specAdequacy: {
          applicable: true,
          retryable: true,
          checked: [],
          gradingAuditDispatch: dispatchResult,
        },
      });
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(attachCompletionEvidenceToSettledItem).not.toHaveBeenCalled();
    });

    it('surfaces failed grading-audit targets with repair guidance instead of pending boilerplate', async () => {
      getWorkItem.mockResolvedValue(linkedIssue);
      const failedTargets = ['EI-failed-scorecard-1', 'EI-failed-scorecard-2'];
      specTestAdequacyCompletionGate.mockResolvedValue({
        ok: false,
        applicable: true,
        retryable: true,
        reason: 'SPEC-003-01@1: no current terminal complete scorecard matches the exact evaluator verdicts',
        checked: [],
        failedGradingAuditTargetIds: failedTargets,
      });

      const r = await one({
        id: 'WI-101',
        state: 'resolved',
        completion: { summary: 'fixed', filesChanged: [behaviorChangePath] },
        specAdequacy,
      });

      expect(dispatchPendingGradingAudits).not.toHaveBeenCalled();
      expect(r).toMatchObject({
        ok: false,
        specAdequacy: {
          applicable: true,
          retryable: true,
          checked: [],
          failedGradingAuditTargetIds: failedTargets,
        },
      });
      expect(r.error).toContain('repairing the failed grading-integrity findings');
      expect(r.error).toContain(failedTargets.join(', '));
      expect(r.error).not.toContain('pending grading audits');
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(attachCompletionEvidenceToSettledItem).not.toHaveBeenCalled();
    });

    it('fails closed and retryably when the gate read itself throws', async () => {
      getWorkItem.mockResolvedValue(linkedIssue);
      specTestAdequacyCompletionGate.mockRejectedValue(new Error('scorecard store unavailable'));

      const r = await one({
        id: 'WI-101',
        state: 'resolved',
        completion: { summary: 'fixed', filesChanged: [behaviorChangePath] },
        specAdequacy,
      });

      expect(r).toMatchObject({
        ok: false,
        specAdequacy: { applicable: true, retryable: true, checked: [] },
      });
      expect(r.error).toContain('scorecard store unavailable');
      expect(r.error).toContain('retryable');
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });
  });

  // ── stateWarning: complete-without-terminal-state footgun (EI-5269) ──────────────────────
  // `completion.status` (defaults to 'done') does NOT close the item — only a terminal top-level
  // `state` does. Completing without one records the completion but leaves the row claimable +
  // reclaimable → the auto-loop re-places bees on landed work. We surface that LOUDLY (do not
  // auto-close: state is optional by design, D-004).
  describe('stateWarning — recorded-but-not-closed footgun (EI-5269)', () => {
    it('warns when a completion leaves a feature non-terminal (no `state`)', async () => {
      getWorkItem.mockResolvedValue(item); // state: 'in_progress'
      const r = await one({ id: 'F-12', completion: { summary: 'all done', status: 'done' } });
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(r.completion.status).toBe('done'); // reads as done…
      expect(r.stateWarning).toMatch(/NOT closed/); // …but the item is not closed
      expect(r.stateWarning).toContain('F-12');
      // Points at the terminal states, split by intent (EI-25189121547866671).
      expect(r.stateWarning).toMatch(/success: 'passed', discard: 'deprecated'/);
    });

    it('does NOT warn when a terminal `state` closed the item', async () => {
      getWorkItem.mockResolvedValue(item);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
      const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 'shipped' } });
      expect(r.workItem.state).toBe('passed');
      expect(r.stateWarning).toBeUndefined();
    });

    it('does NOT nag "not closed" when the item was already terminal — it reports what became of the record', async () => {
      // EI-19362441037986499 CHANGED WHAT THIS ASSERTS, deliberately. The property this test
      // was defending — never tell a caller their CLOSED item is "NOT closed" — still holds
      // and is still asserted below. What it USED to also assert was that the terminal case
      // says NOTHING AT ALL, and that silence was the defect: it made "your evidence was
      // stored" indistinguishable from "your evidence was discarded", which is exactly what
      // was happening. So the nag stays suppressed; the outcome is now reported instead.
      getWorkItem.mockResolvedValue({ ...item, state: 'passed' });
      const r = await one({ id: 'F-12', completion: { summary: 'noting it again' } });
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(r.stateWarning).not.toMatch(/NOT closed/);
      expect(r.stateWarning).toContain('ALREADY terminal');
    });

    it('warns for an issue-family item left open (no `state`), not when resolved', async () => {
      const issue = { ...item, id: 'WI-7', kind: 'bug', family: 'issue', state: 'open' };
      getWorkItem.mockResolvedValue(issue);
      const open = await one({ id: 'WI-7', completion: { summary: 'fixed in tree' } });
      expect(open.stateWarning).toMatch(/success: 'resolved'\/'done', discard: 'closed'\/'dropped'/);

      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...issue, state: 'resolved' }));
      const resolved = await one({ id: 'WI-7', state: 'resolved', completion: { summary: 'fixed in tree' } });
      expect(resolved.stateWarning).toBeUndefined();
    });

    it('still warns (item stays claimable) when an explicit `state` write FAILED', async () => {
      getWorkItem.mockResolvedValue({ ...item, id: 'WI-8', kind: 'task', family: 'issue', state: 'open' });
      setWorkItemStateWithAliasInfo.mockRejectedValue(new Error("cannot take state 'bogus'"));
      const r = await one({ id: 'WI-8', state: 'bogus', completion: { summary: 'landed; bad vocab' } });
      expect(r.stateError).toBeTruthy();
      expect(r.stateWarning).toMatch(/NOT closed/); // the failed transition left it claimable
    });
  });

  // ── EI-18764241942332131: a raw NUL byte anywhere in the completion record used to
  // reach the terminal state write, where Postgres' jsonb text-input parser rejects it
  // with the opaque "unsupported Unicode escape sequence" — the completion RECORDED but
  // the state write silently failed, leaving the item open/claimable with no clue what
  // went wrong. Sanitizing at the tool boundary (completeOne) means the state write never
  // even sees the NUL, so a close that would previously have half-failed now succeeds
  // cleanly, with the caller told what was silently rewritten.
  //
  // NUL is built via String.fromCharCode(0) rather than a source literal — several
  // editors/terminals (and this test file, if edited carelessly) render an embedded raw
  // NUL byte as a plain space, which would make a hand-typed literal indistinguishable
  // from a real space and defeat the very thing this test is pinning.
  describe('nulBytesStrippedWarning — a raw NUL byte in completion evidence is sanitized, not left to fail the state write (EI-18764241942332131)', () => {
    const NUL = String.fromCharCode(0);

    it('strips an embedded NUL from testResult, closes the item cleanly, and warns', async () => {
      const issue = { ...item, id: 'WI-9', kind: 'bug', family: 'issue', state: 'open' };
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...issue, state: 'resolved' }));
      const dirty = `before${NUL}after`;
      const r = await one({
        id: 'WI-9',
        state: 'resolved',
        completion: { summary: 'fixed', testsRun: 'vitest', testResult: dirty, verifiedHow: 'unit' },
      });
      // The state write must never have SEEN the NUL — proves sanitization happens
      // before evidence extraction, not merely before the response is rendered.
      const passedEvidence = setWorkItemStateWithAliasInfo.mock.calls[0]?.[2]?.completionEvidence;
      expect(passedEvidence.testResult).toBe('beforeafter');
      expect(passedEvidence.testResult.includes(NUL)).toBe(false);
      // The close itself must succeed — this is the actual bug: previously the state
      // write could fail downstream on the very evidence this call supplies.
      expect(r.ok).not.toBe(false);
      expect(r.stateError).toBeUndefined();
      expect(r.workItem.state).toBe('resolved');
      // The echoed completion record itself is also clean, and the caller is told.
      expect(r.completion.testResult).toBe('beforeafter');
      expect(r.nulBytesStrippedWarning).toMatch(/NUL/);
      expect(r.nulBytesStrippedWarning).toContain('WI-9');
    });

    it('does not warn (or touch the text) when the completion carries no NUL byte', async () => {
      const issue = { ...item, id: 'WI-10', kind: 'bug', family: 'issue', state: 'open' };
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...issue, state: 'resolved' }));
      const r = await one({
        id: 'WI-10',
        state: 'resolved',
        completion: { summary: 'fixed', testsRun: 'vitest', testResult: 'clean text', verifiedHow: 'unit' },
      });
      expect(r.completion.testResult).toBe('clean text');
      expect(r.nulBytesStrippedWarning).toBeUndefined();
    });

    it('also strips a NUL from `summary` alone (record-only call, no state)', async () => {
      getWorkItem.mockResolvedValue(item); // state: 'in_progress'
      const r = await one({ id: 'F-12', completion: { summary: `dup${NUL}licate note` } });
      expect(r.completion.summary).toBe('duplicate note');
      expect(r.nulBytesStrippedWarning).toMatch(/NUL/);
    });
  });

  // ── EI-15982: `stateWarning` (and every other loud caller-facing signal) must serialize
  // BEFORE the bulky `workItem`/`completion`/`reflect` echoes. The per-result context door
  // (result-door.ts) truncates an oversized result's serialized JSON text from the FRONT of
  // the budget — i.e. it keeps a PREFIX and cuts the tail — so a warning key placed after the
  // two large echoed objects is exactly what gets silently sliced off on a big completion. A
  // real incident: an agent's `stateWarning` ("recorded but NOT closed") never reached it
  // because the response's `workItem`+`completion` echo alone pushed the JSON past the door,
  // and the warning — serialized last — was in the cut tail.
  describe('response field order — warnings precede bulky echoes so result-door truncation cannot hide them (EI-15982)', () => {
    it('places `stateWarning` before `workItem`/`completion`/`reflect` in key order', async () => {
      getWorkItem.mockResolvedValue(item); // state: 'in_progress', no terminal `state` passed below
      const r = await one({ id: 'F-12', completion: { summary: 'all done', status: 'done' } });
      expect(r.stateWarning).toMatch(/NOT closed/);
      const keys = Object.keys(r);
      const warningIdx = keys.indexOf('stateWarning');
      const workItemIdx = keys.indexOf('workItem');
      const completionIdx = keys.indexOf('completion');
      expect(warningIdx).toBeGreaterThanOrEqual(0);
      expect(workItemIdx).toBeGreaterThan(warningIdx);
      expect(completionIdx).toBeGreaterThan(warningIdx);
    });

    it('places `stateInferredFromCompletionStatus` before the bulky echoes too', async () => {
      const issue = { id: 'WI-7', kind: 'bug', family: 'issue', state: 'open', harness: 'papercup' };
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...issue, state: 'resolved' }));
      const r = await one({ id: 'WI-7', completion: { summary: 'fixed it', status: 'resolved', tests: '5 green' } });
      const keys = Object.keys(r);
      const inferredIdx = keys.indexOf('stateInferredFromCompletionStatus');
      expect(inferredIdx).toBeGreaterThanOrEqual(0);
      expect(keys.indexOf('workItem')).toBeGreaterThan(inferredIdx);
      expect(keys.indexOf('completion')).toBeGreaterThan(inferredIdx);
    });
  });

  // ── EI-12027: `completion.status: 'resolved'|'closed'` on an ISSUE-family item, with NO
  // top-level `state`, is unambiguous close-intent (the issue's own native terminal words,
  // never the schema's 'done' default) — infer + apply the close instead of only warning.
  describe('stateInferredFromCompletionStatus — issue-family completion.status auto-close (EI-12027)', () => {
    const issue = { id: 'WI-7', kind: 'bug', family: 'issue', state: 'open', harness: 'papercup' };

    it("infers + applies state:'resolved' from completion.status when top-level `state` is omitted", async () => {
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...issue, state: 'resolved' }));
      const r = await one({ id: 'WI-7', completion: { summary: 'fixed it', status: 'resolved', tests: '5 green' } });

      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
        'WI-7',
        'resolved',
        expect.objectContaining({ by: expect.any(String) }),
      );
      expect(r.ok).toBe(true);
      expect(r.workItem.state).toBe('resolved');
      expect(r.stateWarning).toBeUndefined(); // it DID close — no "not closed" footgun warning
      expect(r.stateInferredFromCompletionStatus).toMatch(/inferred state:'resolved'/);
    });

    it("infers + applies state:'closed' the same way", async () => {
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...issue, state: 'closed' }));
      const r = await one({ id: 'WI-7', completion: { summary: 'closing it', status: 'closed' } });
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
        'WI-7',
        'closed',
        expect.objectContaining({ by: expect.any(String) }),
      );
      expect(r.workItem.state).toBe('closed');
      expect(r.stateInferredFromCompletionStatus).toMatch(/inferred state:'closed'/);
    });

    it('is case/whitespace tolerant on the inferred status value', async () => {
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...issue, state: 'resolved' }));
      const r = await one({ id: 'WI-7', completion: { summary: 'fixed', status: '  Resolved  ' } });
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith('WI-7', 'resolved', expect.anything());
      expect(r.stateInferredFromCompletionStatus).toBeTruthy();
    });

    it('an explicit top-level `state` always wins — no inference, no double-write', async () => {
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...issue, state: 'resolved' }));
      const r = await one({ id: 'WI-7', state: 'resolved', completion: { summary: 'fixed', status: 'closed' } });
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledTimes(1);
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith('WI-7', 'resolved', expect.anything());
      expect(r.stateInferredFromCompletionStatus).toBeUndefined();
    });

    it("does NOT infer for a FEATURE-family item (would risk stepping on the pipeline's own status semantics)", async () => {
      getWorkItem.mockResolvedValue(item); // family: 'feature'
      const r = await one({ id: 'F-12', completion: { summary: 'all done', status: 'resolved' } });
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(r.stateInferredFromCompletionStatus).toBeUndefined();
      expect(r.stateWarning).toMatch(/NOT closed/); // stays the existing record-only behavior
    });

    it("does NOT infer on the DEFAULTED status ('done') — the exact landmine this stays clear of", async () => {
      getWorkItem.mockResolvedValue(issue);
      const r = await one({ id: 'WI-7', completion: { summary: 'progress note' } }); // status defaults to 'done'
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(r.stateInferredFromCompletionStatus).toBeUndefined();
      expect(r.stateWarning).toMatch(/NOT closed/);
    });

    // ── EI-15711: the reporter passed `completion: { status:'done' }`, got ok:true with a
    // full completion record, and moved on — while the row stayed open and CLAIMED. `done`
    // was excluded above only because the preprocess default made an explicit 'done'
    // indistinguishable from an omitted one; the provenance marker separates them.
    it("infers + applies state:'done' when the caller EXPLICITLY writes it (EI-15711)", async () => {
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...issue, state: 'done' }));
      const r = await one({ id: 'WI-7', completion: { summary: 'fixed it', status: 'done', tests: '5 green' } });

      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
        'WI-7',
        'done',
        expect.objectContaining({ by: expect.any(String) }),
      );
      expect(r.ok).toBe(true);
      expect(r.stateWarning).toBeUndefined(); // it DID close — no "not closed" footgun
      expect(r.stateInferredFromCompletionStatus).toMatch(/inferred state:'done'/);
    });

    // The CALIBRATION for the pair above: one status VALUE, two provenances, two outcomes.
    // Asserted in a single test so it cannot pass vacuously — if the marker stopped flowing,
    // both halves would collapse to the same behaviour and one of these two expectations
    // must fail, whichever direction the regression went.
    it("separates an EXPLICIT 'done' from the DEFAULTED one — same value, opposite outcomes", async () => {
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...issue, state: 'done' }));

      const explicit = await one({ id: 'WI-7', completion: { summary: 'fixed', status: 'done' } });
      expect(explicit.stateInferredFromCompletionStatus).toBeTruthy();
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledTimes(1);

      setWorkItemStateWithAliasInfo.mockClear();

      // Identical call with `status` OMITTED — the preprocess supplies the very same
      // 'done', so only the provenance marker can tell these two apart.
      const defaulted = await one({ id: 'WI-7', completion: { summary: 'fixed' } });
      expect(defaulted.stateInferredFromCompletionStatus).toBeUndefined();
      expect(defaulted.stateWarning).toMatch(/NOT closed/);
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    it('never leaks the internal `__statusDefaulted` marker into the result or the state write', async () => {
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...issue, state: 'done' }));
      const r = await one({ id: 'WI-7', completion: { summary: 'fixed', status: 'done' } });
      expect(JSON.stringify(r)).not.toContain('__statusDefaulted');
      expect(JSON.stringify(setWorkItemStateWithAliasInfo.mock.calls)).not.toContain('__statusDefaulted');
    });

    // EI-19362441037986499 boundary: the inference must not reach a settled item. Caught by
    // that block's own record-only tests when explicit-'done' inference was first added —
    // a terminal→same-terminal write re-fires `work-item:done:<id>` and wakes every awaiter.
    it("does NOT infer an explicit 'done' for an ALREADY-TERMINAL item — record-only must stay record-only", async () => {
      getWorkItem.mockResolvedValue({ ...issue, state: 'resolved' });
      const r = await one({ id: 'WI-7', completion: { summary: 'late evidence', status: 'done' } });
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(r.stateInferredFromCompletionStatus).toBeUndefined();
    });

    it("does NOT infer 'resolved' for an ALREADY-TERMINAL item either — the guard is per-item, not per-verb", async () => {
      getWorkItem.mockResolvedValue({ ...issue, state: 'resolved' });
      const r = await one({ id: 'WI-7', completion: { summary: 'late evidence', status: 'resolved' } });
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(r.stateInferredFromCompletionStatus).toBeUndefined();
    });

    it("does NOT infer an explicit 'done' for a FEATURE-family item — the family scope is unchanged", async () => {
      getWorkItem.mockResolvedValue(item); // family: 'feature'
      const r = await one({ id: 'F-12', completion: { summary: 'all done', status: 'done' } });
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(r.stateInferredFromCompletionStatus).toBeUndefined();
      expect(r.stateWarning).toMatch(/NOT closed/);
    });

    it("does NOT infer on other freeform status verbs ('built+tested', 'shipped', 'landed')", async () => {
      getWorkItem.mockResolvedValue(issue);
      const r = await one({ id: 'WI-7', completion: { summary: 'landed', status: 'built+tested' } });
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(r.stateInferredFromCompletionStatus).toBeUndefined();
    });

    it('a FAILED inferred-close write reports ok:false (WI-4529 semantics apply to inference too)', async () => {
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockRejectedValue(new Error("work_item 'WI-7' is HELD OPEN by su-peer"));
      const r = await one({ id: 'WI-7', completion: { summary: 'fixed it', status: 'resolved' } });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/DID NOT CLOSE/);
      expect(r.completion).toMatchObject({ summary: 'fixed it' }); // EI-24: record still kept
    });
  });

  // ── duplicateOfWarning: dup-close accountability (EI-8993) ───────────────────────────────
  describe('duplicateOfWarning — dup-close accountability (EI-8993)', () => {
    it('creates a `duplicates` link + subscribes the prior assignee when duplicateOf is set', async () => {
      getWorkItem.mockResolvedValue({ ...item, assignee: 'su-holder' });
      resolveWorkItemRef.mockResolvedValue({ kind: 'feature', ref: 'papercup#F-1' });
      const r = await one({ id: 'F-12', completion: { summary: 'closing this out', duplicateOf: 'F-1' } });
      expect(r.duplicateOfWarning).toBeUndefined();
      expect(resolveWorkItemRef).toHaveBeenCalledWith('F-1', undefined);
      expect(linkWorkItem).toHaveBeenCalledWith('F-12', { kind: 'feature', ref: 'papercup#F-1' }, 'duplicates', {
        harness: undefined,
        by: 'su-tester',
      });
      expect(subscribeWorkItem).toHaveBeenCalledWith('su-holder', 'F-12', 'full', { harness: undefined });
    });

    it('does NOT subscribe when the prior assignee IS the closer', async () => {
      getWorkItem.mockResolvedValue({ ...item, assignee: 'su-tester' });
      resolveWorkItemRef.mockResolvedValue({ kind: 'feature', ref: 'papercup#F-1' });
      await one({ id: 'F-12', completion: { summary: 'closing this out', duplicateOf: 'F-1' } });
      expect(subscribeWorkItem).not.toHaveBeenCalled();
    });

    it('warns (never blocks) a self-referential duplicateOf', async () => {
      getWorkItem.mockResolvedValue({ ...item });
      const r = await one({ id: 'F-12', completion: { summary: 'closing this out', duplicateOf: 'F-12' } });
      expect(r.duplicateOfWarning).toMatch(/same id/i);
      expect(linkWorkItem).not.toHaveBeenCalled();
    });

    it('warns (never blocks) when the duplicateOf target is not found', async () => {
      getWorkItem.mockResolvedValue({ ...item });
      resolveWorkItemRef.mockResolvedValue(null);
      const r = await one({ id: 'F-12', completion: { summary: 'closing this out', duplicateOf: 'F-999' } });
      expect(r.duplicateOfWarning).toMatch(/not found/i);
      expect(linkWorkItem).not.toHaveBeenCalled();
    });

    it("nudges toward duplicateOf when the summary says 'dup of X' but the field was omitted (the exact WI-3646 pattern)", async () => {
      getWorkItem.mockResolvedValue({ ...item });
      const r = await one({
        id: 'F-12',
        completion: { summary: 'Re-closing: dup of WI-3543, deferring to its investigation' },
      });
      expect(r.duplicateOfWarning).toMatch(/duplicateOf.*was not set/i);
      expect(linkWorkItem).not.toHaveBeenCalled();
    });

    it('does not nudge on an unrelated completion (no false positive)', async () => {
      getWorkItem.mockResolvedValue({ ...item });
      const r = await one({ id: 'F-12', completion: { summary: 'landed the feature, all tests green' } });
      expect(r.duplicateOfWarning).toBeUndefined();
    });
  });

  // ── assigneeMismatchWarning: wrong-id-grab footgun (EI-7264) ─────────────────────────────
  // A fast multi-wake loop's own tracking-task ids and peers' work-item ids flow through the
  // same coord broadcast stream — nothing visually distinguishes them. Record-only calls WARN
  // when the caller is not its current assignee; terminal calls refuse before they can mutate
  // someone else's active work.
  describe('assigneeMismatchWarning — wrong-id-grab footgun (EI-7264)', () => {
    it.each([
      ['spawn-url', 'trusted', true],
      ['bearer', 'trusted', false],
      ['spawn-url', 'untrusted', false],
    ])('checks a role session holder using authenticated %s/%s provenance', async (authMethod, trust, allowed) => {
      const session = 'su-851c1a7a-8ea6-4c70-afeb-472e957fd3d8';
      const roleCtx = { uiClientId: session, workspaceId: 'default',
        principal: { slug: 'system:judge', kind: 'system', authMethod, trust, workspaceId: 'default' } };
      getWorkItem.mockResolvedValue({ ...item, assignee: session });
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
      const result = ((await complete.handler(parse({ id: 'F-12', state: 'passed',
        completion: { summary: 'signed reviewer closes its own review', tests: 'holder guard' } }) as never,
      roleCtx as never)) as Out).data.results[0];
      expect(result.ok).toBe(allowed);
      if (allowed) expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
      else {
        expect(result.error).toMatch(/refusing terminal completion/);
        expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      }
    });

    it('warns when the item is currently assigned to someone else', async () => {
      getWorkItem.mockResolvedValue({ ...item, assignee: 'su-someone-else' });
      const r = await one({ id: 'F-12', completion: { summary: 'noting it' } });
      expect(r.assigneeMismatchWarning).toMatch(/su-someone-else/);
      expect(r.assigneeMismatchWarning).toMatch(/su-tester/); // the caller's own id
      expect(r.assigneeMismatchWarning).toContain('F-12');
    });

    it('refuses a terminal close before writing completion or state when another agent owns the item', async () => {
      getWorkItem.mockResolvedValue({ ...item, assignee: 'su-someone-else' });
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: { summary: 'must not close the peer item', tests: 'not run' },
      });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/refusing terminal completion/);
      expect(r.error).toContain('su-someone-else');
      expect(r.error).toContain('No completion record or state transition was written');
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
      expect(mergeWorkItemOutputPayload).not.toHaveBeenCalled();
    });

    it('also refuses issue terminal inference from completion.status when another agent owns the item', async () => {
      getWorkItem.mockResolvedValue({
        ...item,
        family: 'issue',
        kind: 'bug',
        state: 'open',
        assignee: 'su-someone-else',
      });
      const r = await one({
        id: 'F-12',
        completion: { summary: 'must not infer-close the peer item', status: 'resolved', tests: 'not run' },
      });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/refusing terminal completion/);
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    it('does NOT warn when the caller is the current assignee', async () => {
      getWorkItem.mockResolvedValue({ ...item, assignee: 'su-tester' });
      const r = await one({ id: 'F-12', completion: { summary: 'noting it' } });
      expect(r.assigneeMismatchWarning).toBeUndefined();
    });

    it("accepts the caller's adopted stable agent name as the current assignee", async () => {
      resolveAdoptedName.mockResolvedValue('calendar-ops');
      getWorkItem.mockResolvedValue({ ...item, assignee: 'calendar-ops' });
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));

      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: { summary: 'closed by the adopting session', tests: 'green' },
      });

      expect(resolveAdoptedName).toHaveBeenCalledWith('default', 'su-tester');
      expect(r.ok).toBe(true);
      expect(r.assigneeMismatchWarning).toBeUndefined();
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
    });

    it('does NOT warn when the item is unclaimed (assignee null)', async () => {
      getWorkItem.mockResolvedValue({ ...item, assignee: null });
      const r = await one({ id: 'F-12', completion: { summary: 'noting it' } });
      expect(r.assigneeMismatchWarning).toBeUndefined();
    });
  });

  // EI-23701433507513915: a leader assignment stored the SHORT-FORM id (`su-851c1a7a`) as the
  // holder, and the real holder's own terminal close was refused as a foreign assignee.
  describe('short-form stored holder (EI-23701433507513915)', () => {
    const ME = 'su-851c1a7a-8ea6-4c70-afeb-472e957fd3d8';
    const PEER_SAME_PREFIX = 'su-851c1a7a-0000-4000-8000-000000000001';
    const OTHER = 'su-00000000-1111-4222-8333-444444444444';
    const asMe = { uiClientId: ME, isSuperuser: true, workspaceId: 'default' } as never;
    const oneAsMe = async (x: unknown) =>
      ((await complete.handler(parse(x) as never, asMe)) as Out).data.results[0];
    afterEach(() => {
      OWNER_REGISTRY.ids = [];
    });

    it('lets the holder close an item whose stored assignee is its UNIQUE short-form prefix', async () => {
      OWNER_REGISTRY.ids = [ME, OTHER];
      getWorkItem.mockResolvedValue({ ...item, assignee: 'su-851c1a7a' });
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));

      const r = await oneAsMe({
        id: 'F-12',
        state: 'passed',
        completion: { summary: 'the holder closes its own item', tests: 'green' },
      });

      expect(r.ok).toBe(true);
      expect(r.assigneeMismatchWarning).toBeUndefined();
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
    });

    it('still refuses before any write when the short-form holder is AMBIGUOUS (a bare prefix is nobody)', async () => {
      OWNER_REGISTRY.ids = [ME, PEER_SAME_PREFIX];
      getWorkItem.mockResolvedValue({ ...item, assignee: 'su-851c1a7a' });

      const r = await oneAsMe({
        id: 'F-12',
        state: 'passed',
        completion: { summary: 'must not close on an ambiguous prefix', tests: 'not run' },
      });

      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/refusing terminal completion/);
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
    });
  });

  describe('claim-subject baseline — stale coalesced close protection (EI-23167326985120403)', () => {
    const baseline = {
      kind: 'bug',
      title: 'original watchdog subject',
      summary: 'original watchdog observation',
      body: 'original watchdog observation',
      watchdogKey: 'repeated-tool-error:original',
    };

    it('refuses a terminal close when coalescing changed the claimed issue subject', async () => {
      getWorkItem.mockResolvedValue({
        id: 'EI-claim-baseline',
        kind: 'bug',
        family: 'issue',
        state: 'open',
        harness: 'papercup',
        assignee: 'su-tester',
        title: 'new coalesced subject',
        summary: 'new coalesced observation',
        payload: {
          watchdogKey: 'repeated-tool-error:new',
          _claimSubjectBaseline: baseline,
        },
      });

      const r = await one({
        id: 'EI-claim-baseline',
        state: 'resolved',
        completion: { summary: 'stale proof for the original subject', tests: 'original test passed' },
      });

      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/claimed subject changed after claim/);
      expect(r.error).toContain('title');
      expect(r.error).toContain('watchdogKey');
      expect(r.error).toContain('No completion record or state transition was written');
      expect(r.claimSubjectMismatch.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'title', claimed: baseline.title, current: 'new coalesced subject' }),
          expect.objectContaining({ field: 'watchdogKey', claimed: baseline.watchdogKey, current: 'repeated-tool-error:new' }),
        ]),
      );
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(attachCompletionEvidenceToSettledItem).not.toHaveBeenCalled();
    });

    it('keeps record-only progress notes compatible when the subject changed', async () => {
      getWorkItem.mockResolvedValue({
        id: 'EI-claim-baseline-record',
        kind: 'bug',
        family: 'issue',
        state: 'open',
        harness: 'papercup',
        assignee: 'su-tester',
        title: 'new coalesced subject',
        summary: 'new coalesced observation',
        payload: { watchdogKey: 'repeated-tool-error:new', _claimSubjectBaseline: baseline },
      });

      const r = await one({ id: 'EI-claim-baseline-record', completion: { summary: 'progress note' } });

      expect(r.ok).toBe(true);
      expect(r.claimSubjectMismatch).toBeUndefined();
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    it('allows a close when the current issue still matches the claim baseline', async () => {
      const issue = {
        id: 'EI-claim-baseline-match',
        kind: 'bug',
        family: 'issue',
        state: 'open',
        harness: 'papercup',
        assignee: 'su-tester',
        title: baseline.title,
        summary: baseline.summary,
        payload: { watchdogKey: baseline.watchdogKey, _claimSubjectBaseline: baseline },
      };
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...issue, state: 'resolved' }));

      const r = await one({
        id: issue.id,
        state: 'resolved',
        completion: { summary: 'verified original subject', tests: 'original test passed' },
      });

      expect(r.ok).toBe(true);
      expect(r.claimSubjectMismatch).toBeUndefined();
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
    });
  });

  describe('harnessMismatchWarning — canonical member-to-home resolution', () => {
    const memberRow = {
      id: 'WI-harness-scope',
      kind: 'bug',
      family: 'issue',
      state: 'open',
      harness: 'oddsmith-hive',
      title: 'member-scoped item',
    };

    it('does not warn when the requested member harness resolves to the row home', async () => {
      hiveMocks.potHomeSlugForHarness.mockResolvedValue('oddsmith-hive');
      getWorkItem.mockResolvedValue(memberRow);

      const r = await one({ id: memberRow.id, harness: 'oddsmith', completion: { summary: 'noting it' } });

      expect(r.harnessMismatchWarning).toBeUndefined();
      expect(hiveMocks.potHomeSlugForHarness).toHaveBeenCalledWith('default', 'oddsmith');
    });

    it('keeps warning when the requested harness resolves to a different home', async () => {
      hiveMocks.potHomeSlugForHarness.mockResolvedValue('another-hive');
      getWorkItem.mockResolvedValue(memberRow);

      const r = await one({ id: memberRow.id, harness: 'oddsmith', completion: { summary: 'noting it' } });

      expect(r.harnessMismatchWarning).toMatch(/under harness 'oddsmith'/);
      expect(r.harnessMismatchWarning).toMatch(/belongs to harness 'oddsmith-hive'/);
    });
  });

  // ── typeEvidenceWarning: a test result is silent about TYPES (EI-19454554361062529) ──────
  // The helper itself is unit-tested in complete.type-evidence-gap.test.ts; THIS block
  // covers the wiring, which is the part a pure-function test cannot reach — the field
  // has to actually reach the caller's result or the guard may as well not exist.
  describe('typeEvidenceWarning — a passing suite says nothing about types', () => {
    beforeEach(() => {
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
    });

    it('surfaces the warning on a unit-verified close that changed .ts and cited no typecheck', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 'fixed the undefined-args crash',
          verifiedHow: 'unit',
          testsRun: 'testing:run cache_stats.test.ts',
          testResult: '8 passed / 0 failed',
          filesChanged: ['lib/agent-tools/dev/cache_stats.ts'],
        },
      });
      expect(r.ok).toBe(true); // warn-only: the completion is still recorded
      expect(r.typeEvidenceWarning).toMatch(/NEVER typechecks/);
      expect(r.typeEvidenceWarning).toContain('F-12');
      // It names the runnable command with the caller's OWN files substituted in, normalized
      // to the repo-relative form expected by the root lint gate.
      expect(r.typeEvidenceWarning).toContain('--files=packages/operator-core/lib/agent-tools/dev/cache_stats.ts');
    });

    it('resolves a unique bare basename to the owning lint:tsc gate', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 'fixed cache statistics collection',
          verifiedHow: 'unit',
          testsRun: 'testing:run cache_stats.test.ts',
          testResult: '8 passed / 0 failed',
          filesChanged: ['cache_stats.ts'],
        },
      });
      expect(r.typeEvidenceWarning).toContain(
        'npm run lint:tsc -- --files=packages/operator-core/lib/agent-tools/dev/cache_stats.ts',
      );
      expect(r.typeEvidenceWarning).not.toContain('no repository lint:tsc gate was resolved');
    });

    it('routes apps/operator files to the owning lint:tsc:operator gate', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 'fixed the proxy admission path',
          verifiedHow: 'unit',
          testsRun: 'testing:run proxy.test.ts',
          testResult: '112 passed / 0 failed',
          filesChanged: ['apps/operator/lib/mcp-proxy/proxy.ts', 'apps/operator/lib/mcp-proxy/proxy.test.ts'],
        },
      });
      expect(r.typeEvidenceWarning).toContain(
        'npm run lint:tsc:operator -- --files=apps/operator/lib/mcp-proxy/proxy.ts,apps/operator/lib/mcp-proxy/proxy.test.ts',
      );
      expect(r.typeEvidenceWarning).not.toContain('npm run lint:tsc -- --files=apps/operator/lib/mcp-proxy');
    });

    it('stays silent when the caller already cited a typecheck', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 's',
          verifiedHow: 'unit',
          testsRun: 'npm run lint:tsc -- --files=lib/a.ts ; vitest',
          testResult: 'tsc clean, 8 passed',
          filesChanged: ['lib/a.ts'],
        },
      });
      expect(r.typeEvidenceWarning).toBeUndefined();
    });

    it('stays silent when testsRun cites plural typechecks', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 's',
          verifiedHow: 'integration',
          testsRun: 'operator-vite and scoped operator-core typechecks',
          testResult: 'both checks clean',
          filesChanged: ['lib/a.ts'],
        },
      });
      expect(r.typeEvidenceWarning).toBeUndefined();
    });

    it('stays silent when testResult cites plural typechecks', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 's',
          verifiedHow: 'integration',
          testsRun: 'operator-vite integration tests',
          testResult: 'both scoped typechecks clean',
          filesChanged: ['lib/a.ts'],
        },
      });
      expect(r.typeEvidenceWarning).toBeUndefined();
    });

    it('stays silent when nothing TypeScript changed', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 's',
          verifiedHow: 'unit',
          testsRun: 'vitest',
          testResult: '3 passed',
          filesChanged: ['docs/readme.md'],
        },
      });
      expect(r.typeEvidenceWarning).toBeUndefined();
    });
  });

  // ── WI-37960: universal verification claims require population accounting ────────────────
  // A verification pass may say "every page" only when the completion carries an explicit
  // population and accounts for every entry as checked, not checked, or not applicable, with
  // residue stated. This is a narrow hard gate on the close: ordinary code completions that
  // merely say "all tests passed" remain unaffected.
  describe('WI-37960 — universal verification claims require enumerated coverage', () => {
    const verificationItem = {
      id: 'WI-verify',
      kind: 'change',
      family: 'issue',
      state: 'open',
      harness: 'papercup',
      title:
        'Independent verification pass — every page reachable, every stated fact traceable to its cited source, nothing invented',
      summary: 'Verify the rendered surface against its sources.',
    };
    const universalCompletion = {
      summary: 'Every stated fact on every page was checked against its cited source; nothing invented.',
      verifiedHow: 'manual' as const,
      testResult: 'manual source review completed',
    };

    it('rejects a universal verification close without enumerated coverage', async () => {
      getWorkItem.mockResolvedValue(verificationItem);
      const r = await one({ id: 'WI-verify', state: 'resolved', completion: universalCompletion });

      expect(r.ok).toBe(false);
      expect(r.verificationCoverageError).toMatch(/enumerated coverage/);
      expect(r.error).toMatch(/population/);
      expect(r.stateError).toBeUndefined();
      expect(r).not.toHaveProperty('completion');
      expect(r).not.toHaveProperty('workItem');
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      const completionEmit = (complete as { emits?: Array<{ when: (event: unknown) => boolean }> }).emits?.[0];
      expect(completionEmit?.when({ result: { data: r } })).toBe(false);
    });

    it('allows an evidence-backed non-self duplicate close without unrelated population coverage', async () => {
      getWorkItem.mockResolvedValue(verificationItem);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...verificationItem, state: 'resolved' }));
      resolveWorkItemRef.mockResolvedValue({ kind: 'bug', ref: 'papercup#EI-20252354779271625' });

      const r = await one({
        id: 'WI-verify',
        state: 'resolved',
        completion: {
          ...universalCompletion,
          duplicateOf: 'EI-20252354779271625',
          verifiedHow: 'integration',
          testsRun: 'focused completion regression suite',
          testResult: 'PASS: focused suite and live staging probe',
        },
      });

      expect(r.ok).toBe(true);
      expect(r.verificationCoverageError).toBeUndefined();
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
        'WI-verify',
        'resolved',
        expect.objectContaining({
          completionEvidence: expect.objectContaining({ summary: expect.any(String) }),
        }),
      );
      expect(linkWorkItem).toHaveBeenCalledWith(
        'WI-verify',
        { kind: 'bug', ref: 'papercup#EI-20252354779271625' },
        'duplicates',
        expect.objectContaining({ by: 'su-tester' }),
      );
    });

    it('keeps the coverage gate for a self-referential duplicate claim', async () => {
      getWorkItem.mockResolvedValue(verificationItem);
      const r = await one({
        id: 'WI-verify',
        state: 'resolved',
        completion: { ...universalCompletion, duplicateOf: 'WI-verify' },
      });

      expect(r.ok).toBe(false);
      expect(r.verificationCoverageError).toMatch(/enumerated coverage/);
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    // EI-20223460482316333 + 4 sibling filings on 2026-08-12: the refusal named the
    // CONCEPT but not the field path or the shape, so an agent who fully agreed with the
    // gate still could not comply without opening complete.ts. A refusal a caller cannot
    // act on is a wall, not a gate — this asserts the message stays actionable on its own.
    it('names the exact field path and BOTH enforced rules, so the refusal is actionable without reading this file', async () => {
      getWorkItem.mockResolvedValue(verificationItem);
      const r = await one({ id: 'WI-verify', state: 'resolved', completion: universalCompletion });

      const message = String(r.verificationCoverageError);
      // the path an agent must actually write to
      expect(message).toContain('completion.verification.coverage');
      // rule 1 — a partition, not a sample: every bucket named
      for (const bucket of ['population', 'checked', 'notChecked', 'notApplicable', 'residue']) {
        expect(message).toContain(bucket);
      }
      // rule 2 — the explicit zero-residue form, which omission never satisfies
      expect(message).toContain("residue:['none']");
    });

    // EI-22158326197204788: the refusal named ONLY the nested path, so a caller who
    // read the message and wrote a top-level `completion.coverage` instead (a fully
    // schema-accepted alias — CompletionRecordSchema declares `coverage` directly, and
    // completionEvidenceFromRecord falls back to it) had no way to learn that from the
    // rejection text alone. Assert the alias is now named alongside the canonical path.
    it('also names the top-level completion.coverage alias, not only the nested path', async () => {
      getWorkItem.mockResolvedValue(verificationItem);
      const r = await one({ id: 'WI-verify', state: 'resolved', completion: universalCompletion });

      const message = String(r.verificationCoverageError);
      expect(message).toContain('completion.verification.coverage');
      expect(message).toContain('completion.coverage');
    });

    it('reports the complete coverage contract for malformed nested bucket shapes in one rejection', () => {
      const result = (
        complete.args as {
          safeParse: (value: unknown) => {
            success: boolean;
            error?: { issues: Array<{ path: Array<string | number>; message: string }> };
          };
        }
      ).safeParse({
        id: 'WI-verify',
        state: 'resolved',
        assumptions: 'none',
        completion: {
          summary: 'Every page was checked.',
          verifiedHow: 'manual',
          testResult: 'source review completed',
          verification: {
            coverage: {
              population: 'all named items',
              checked: 'all named items',
              notChecked: 'none',
              notApplicable: 'none',
              residue: 'none',
            },
          },
        },
      });

      expect(result.success).toBe(false);
      const issues = result.error?.issues ?? [];
      const message = issues.map((issue) => issue.message).join(' ');
      expect(message).toContain('residue is a separate list, never a fifth bucket');
      expect(message).toContain('exactly one status bucket');
      expect(message).toContain("residue:['none']");
      expect(message).not.toContain('expected array, received string');
      expect(issues.some((issue) => issue.path.join('.') === 'completion.verification.coverage')).toBe(true);
    });

    it('names population entries misplaced in residue instead of reporting a misleading residue-size error', async () => {
      getWorkItem.mockResolvedValue(verificationItem);
      const r = await one({
        id: 'WI-verify',
        state: 'resolved',
        completion: {
          ...universalCompletion,
          coverage: {
            population: ['index pages', 'species pages'],
            checked: ['index pages'],
            residue: ['species pages', 'one untracked note'],
          },
        },
      });

      expect(r.ok).toBe(false);
      expect(r.verificationCoverageError).toContain('"species pages" are in residue');
      expect(r.verificationCoverageError).toContain('Residue is not a partition bucket');
      expect(r.verificationCoverageError).toContain('move those entries to checked, notChecked, or notApplicable');
      expect(r.verificationCoverageError).toContain("residue:['none']");
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    it('accepts a universal verification close when every population entry has a status and explicit empty residue', async () => {
      getWorkItem.mockResolvedValue(verificationItem);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...verificationItem, state: 'resolved' }));
      const completion = {
        ...universalCompletion,
        coverage: {
          population: ['index pages', 'species pages'],
          checked: ['index pages', 'species pages'],
          residue: [],
        },
      };
      const r = await one({ id: 'WI-verify', state: 'resolved', completion });

      expect(r.ok).toBe(true);
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
        'WI-verify',
        'resolved',
        expect.objectContaining({
          completionEvidence: expect.objectContaining({
            coverage: expect.objectContaining({ population: ['index pages', 'species pages'] }),
          }),
        }),
      );
    });

    it('does not gate an ordinary code completion that merely says all tests passed', async () => {
      const codeItem = {
        ...item,
        id: 'WI-code',
        kind: 'change',
        family: 'issue',
        state: 'open',
        title: 'Implement query fix',
        summary: 'code change',
      };
      getWorkItem.mockResolvedValue(codeItem);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...codeItem, state: 'resolved' }));
      const r = await one({
        id: 'WI-code',
        state: 'resolved',
        completion: { summary: 'All tests passed.', verifiedHow: 'unit', testResult: '8 passed' },
      });

      expect(r.ok).toBe(true);
      expect(r.verificationCoverageError).toBeUndefined();
    });

    it('does not classify an ordinary design task as verification when its prose is universal', async () => {
      const designTask = {
        ...item,
        id: 'WI-design-task',
        kind: 'task',
        family: 'issue',
        state: 'open',
        title: 'Explore completion UX design',
        summary: 'Sketch the proposed hand-edit flow.',
      };
      expect(isVerificationWorkItem(designTask)).toBe(false);
      getWorkItem.mockResolvedValue(designTask);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...designTask, state: 'resolved' }));

      const r = await one({
        id: 'WI-design-task',
        state: 'resolved',
        completion: {
          summary: 'The design covers every page and all content states in the proposed flow.',
          verifiedHow: 'manual',
          testResult: 'design sketch captured',
        },
      });

      expect(r.ok).toBe(true);
      expect(r.verificationCoverageError).toBeUndefined();
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
        'WI-design-task',
        'resolved',
        expect.objectContaining({ completionEvidence: expect.objectContaining({ summary: expect.any(String) }) }),
      );
    });

    it('accepts an explicit empty residue array for an ordinary close without universal-claim wording', async () => {
      const ordinaryVerification = {
        ...item,
        id: 'WI-ordinary-residue',
        kind: 'task',
        family: 'issue',
        state: 'open',
        title: 'Capture one browser baseline',
        summary: 'Record the current rendered state.',
      };
      getWorkItem.mockResolvedValue(ordinaryVerification);

      const input = {
        id: 'WI-ordinary-residue',
        state: 'resolved',
        assumptions: 'none',
        completion: {
          summary: 'Captured the baseline.',
          verifiedHow: 'manual',
          testResult: 'baseline recorded',
          coverage: {
            population: ['browser baseline'],
            checked: ['browser baseline'],
            residue: [],
          },
        },
      };
      const schema = complete.args as {
        safeParse: (value: unknown) => {
          success: boolean;
          error?: { issues: Array<{ path: Array<string | number>; message: string }> };
        };
      };
      const schemaResult = schema.safeParse(input);
      expect(schemaResult.success).toBe(true);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...ordinaryVerification, state: 'resolved' }));

      // Keep the handler-level guard covered independently of the public schema.
      const response = (await complete.handler(input as never, ctx)) as Out;
      const r = response.data.results[0];

      expect(r.ok).toBe(true);
      expect(r.verificationCoverageError).toBeUndefined();
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
        'WI-ordinary-residue',
        'resolved',
        expect.objectContaining({
          completionEvidence: expect.objectContaining({
            coverage: expect.objectContaining({ residue: [] }),
          }),
        }),
      );
    });

    it('keeps the helper contract explicit for verification markers and coverage accounting', () => {
      expect(isVerificationWorkItem(verificationItem)).toBe(true);
      expect(
        isVerificationWorkItem({
          kind: 'task',
          title: 'Verify every rendered page',
          summary: 'Run the source-backed verification pass.',
        }),
      ).toBe(true);
      expect(claimsUniversalVerification(universalCompletion)).toBe(true);
      expect(
        hasEnumeratedVerificationCoverage({
          population: ['a', 'b'],
          checked: ['a'],
          notApplicable: ['b'],
          residue: [],
        }),
      ).toBe(true);
      expect(hasEnumeratedVerificationCoverage({ population: ['a', 'b'], checked: ['a'], residue: ['none'] })).toBe(
        false,
      );
    });

    it('rejects duplicate or non-population status entries instead of treating them as a partition', () => {
      expect(
        hasEnumeratedVerificationCoverage({
          population: ['a', 'b'],
          checked: ['a'],
          notChecked: ['a', 'b'],
          residue: ['none'],
        }),
      ).toBe(false);
      expect(
        hasEnumeratedVerificationCoverage({
          population: ['a', 'b'],
          checked: ['a', 'b', 'descriptive replacement'],
          residue: ['none'],
        }),
      ).toBe(false);
      expect(
        hasEnumeratedVerificationCoverage({
          population: ['a', 'a'],
          checked: ['a'],
          residue: ['none'],
        }),
      ).toBe(false);
    });
  });

  // ── verificationWarning: settled-but-unverified lint (flush-to-proceed P-006) ────────────
  // A settled unit is VERIFIED (`tests`) or CONSCIOUSLY DEFERRED (`deferred`) — never silent.
  // SOFT warning, not a hard reject (D-005 / EI-24: a finished completion is never lost).
  describe('verificationWarning — settled-but-unverified lint (P-006)', () => {
    beforeEach(() => {
      // A closed item so stateWarning stays silent and these assertions isolate verificationWarning.
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
    });

    it('warns when a completion has NEITHER `tests` nor `deferred`', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 'shipped it' } });
      expect(r.ok).toBe(true); // NOT rejected — the completion is still recorded + emitted
      expect(r.completion.summary).toBe('shipped it');
      expect(r.verificationWarning).toMatch(/neither `tests` nor `deferred`/);
      expect(r.verificationWarning).toContain('F-12');
    });

    it('does NOT warn when `tests` is populated', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 's', tests: '18 vitest green' } });
      expect(r.verificationWarning).toBeUndefined();
    });

    it('does NOT warn when `deferred` is a non-empty list (conscious deferral)', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: { summary: 's', deferred: ['live smoke pending'] },
      });
      expect(r.verificationWarning).toBeUndefined();
    });

    it('treats an EMPTY `deferred` array + whitespace-only `tests` as absent (still warns)', async () => {
      getWorkItem.mockResolvedValue(item);
      // Note: the schema drops empty arrays / min(1) strings, but the lint is defensive about both.
      const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 's', deferred: [] } });
      expect(r.verificationWarning).toMatch(/neither `tests` nor `deferred`/);
    });

    it('does NOT warn when both are populated', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: { summary: 's', tests: '5 green', deferred: ['perf pass later'] },
      });
      expect(r.verificationWarning).toBeUndefined();
    });

    // EI-7316: `tests` is only ONE of several schema-blessed ways to record verification
    // evidence (testsRun / testResult / verifiedHow, each also under a nested `verification.*`
    // alias) — completionEvidenceFromRecord already treats them as equally valid for the
    // completionEvidence written on a terminal state transition. The lint used to check ONLY
    // the bare `tests` field, so a caller who verified via a sibling field got a FALSE warning.
    it('does NOT warn when only `testsRun` is populated (not the bare `tests` field)', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: { summary: 's', testsRun: 'npx vitest run foo.test.ts' },
      });
      expect(r.verificationWarning).toBeUndefined();
    });

    it('does NOT warn when only `testResult` is populated', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 's', testResult: '9/9 green' } });
      expect(r.verificationWarning).toBeUndefined();
    });

    it('does NOT warn when only `verifiedHow` is populated', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 's', verifiedHow: 'manual' } });
      expect(r.verificationWarning).toBeUndefined();
    });

    it('does NOT warn when only the nested `verification.testsRun` alias is populated', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: { summary: 's', verification: { testsRun: 'live-drove-ui' } },
      });
      expect(r.verificationWarning).toBeUndefined();
    });

    it('STILL warns when none of tests/testsRun/testResult/verifiedHow/deferred are populated', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 'shipped, trust me' } });
      expect(r.verificationWarning).toMatch(/neither `tests` nor `deferred`/);
    });

    // EI-13505: reporter's exact reproduction — testsRun + testResult + verifiedHow AND a
    // non-empty `deferred` array populated SIMULTANEOUSLY (both a stated verification AND a
    // conscious deferral in the same completion) still misfired the warning under a stale
    // build; lock the combined shape as a regression test on top of the individual-field cases
    // above.
    it('does NOT warn when testsRun + testResult + verifiedHow AND a non-empty `deferred` are all populated together', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 'shipped the fix',
          testsRun: 'npx vitest run foo.test.ts',
          testResult: '9/9 green',
          verifiedHow: 'unit',
          deferred: ['perf pass later'],
        },
      });
      expect(r.verificationWarning).toBeUndefined();
    });
  });

  // ── skippedTestsWarning: a skip inside a green-looking summary is surfaced loudly,
  // never silently accepted (EI-19380332459719944) ────────────────────────────────────
  describe('skippedTestsWarning — a skip in testsRun/testResult is surfaced, not silently accepted (EI-19380332459719944)', () => {
    beforeEach(() => {
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
    });

    it('warns when testResult reports a nonzero skip count ("N passed | M skipped")', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: { summary: 'fixed it', testResult: 'Tests  8 passed | 1 skipped (9)' },
      });
      expect(r.ok).toBe(true); // never hard-rejected — EI-24 record-and-warn
      expect(r.skippedTestsWarning).toMatch(/1 test\(s\) SKIPPED/);
      expect(r.skippedTestsWarning).toContain('F-12');
      expect(r.skippedTestsWarning).toContain('testResult');
    });

    it('warns when testsRun (not testResult) carries the skip mention', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 'fixed it',
          testsRun: 'npm run test:file -- foo.test.ts — 3 passed, 2 skipped',
        },
      });
      expect(r.skippedTestsWarning).toMatch(/2 test\(s\) SKIPPED/);
      expect(r.skippedTestsWarning).toContain('testsRun');
    });

    it('does NOT warn when testResult only contains skip-related prose, not a runner summary', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 'fixed it',
          verifiedHow: 'integration',
          testResult: 'the mirror refuses below a 40GB floor and alarms rather than skipping quietly',
        },
      });
      expect(r.skippedTestsWarning).toBeUndefined();
    });

    it('does NOT warn when testsRun prose says a run skipped something but names no test command', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 'fixed it',
          verifiedHow: 'integration',
          testsRun: 'run 3 skipped it, exited 0, raised no repeat alarm',
        },
      });
      expect(r.skippedTestsWarning).toBeUndefined();
    });

    it.each(['manual', 'live-drove-ui', 'live-service', 'already-passing'])(
      'does NOT inspect skip-like prose for non-test verification mode %s',
      async (verifiedHow) => {
        getWorkItem.mockResolvedValue(item);
        const r = await one({
          id: 'F-12',
          state: 'passed',
          completion: {
            summary: 'fixed it',
            verifiedHow,
            testResult: 'run 3 skipped it, exited 0, raised no repeat alarm',
          },
        });
        expect(r.skippedTestsWarning).toBeUndefined();
      },
    );

    it('still warns for an integration runner summary when testsRun names the test command', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 'fixed it',
          verifiedHow: 'integration',
          testsRun: 'npm run test:file -- foo.test.ts',
          testResult: 'Tests 8 passed | 1 skipped (9)',
        },
      });
      expect(r.skippedTestsWarning).toMatch(/1 test\(s\) SKIPPED/);
    });

    it('does NOT warn on a clean "N passed" with no skip', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: { summary: 'fixed it', testResult: 'Tests  9 passed (9)' },
      });
      expect(r.skippedTestsWarning).toBeUndefined();
    });

    it('does NOT warn on an explicit "0 skipped"', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: { summary: 'fixed it', testResult: 'Tests  9 passed | 0 skipped (9)' },
      });
      expect(r.skippedTestsWarning).toBeUndefined();
    });

    it('does NOT warn when neither testsRun nor testResult is populated', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 'fixed it', verifiedHow: 'unit' } });
      expect(r.skippedTestsWarning).toBeUndefined();
    });

    it('reads the nested `verification.testResult` alias too', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: { summary: 'fixed it', verification: { testResult: '4 passed | 1 skipped' } },
      });
      expect(r.skippedTestsWarning).toMatch(/1 test\(s\) SKIPPED/);
    });

    it('does NOT warn for the documented unfiltered + -t execution-proof pair', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 'fixed it',
          testsRun: 'npm run test:file -- packages/operator-core/lib/foo.test.ts',
          testResult:
            'UNFILTERED packages/operator-core/lib/foo.test.ts: 72 passed, 0 skipped; ' +
            'FILTERED packages/operator-core/lib/foo.test.ts -- -t EI-19447204017443244: 11 passed | 61 skipped',
        },
      });
      expect(r.skippedTestsWarning).toBeUndefined();
    });

    it('recognizes the long testNamePattern spelling for the same proof', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 'fixed it',
          testsRun: 'testing:run --testNamePattern=EI-12 foo.test.ts',
          testResult: 'full run: 9 passed, 0 skipped; filtered run: 1 passed | 8 skipped',
        },
      });
      expect(r.skippedTestsWarning).toBeUndefined();
    });

    it('does NOT warn for historical reproduction skips followed by a covering unfiltered command record (EI-26150517852473091)', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 'fixed it',
          testsRun: [
            {
              command: 'npm run test:file -- lib/foo.test.ts lib/bar.test.ts -- -t "request cancellation"',
              testRunIds: [21278811, 21278812],
              result: 'Before production change: 6 failed/26 skipped.',
            },
            {
              command: 'PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- lib/foo.test.ts lib/baz.test.ts lib/bar.test.ts',
              testRunIds: [21278828, 21278829, 21278830],
              result: '44 passed/0 failed/0 skipped; exec23901 drained exit0.',
            },
          ],
          testResult: '44/44 pass',
        },
      });
      expect(r.ok).toBe(true);
      expect(r.skippedTestsWarning).toBeUndefined();
    });

    it.each([
      ['an unrelated file', 'npm run test:file -- lib/other.test.ts', '44 passed/0 failed/0 skipped'],
      ['an incomplete file cohort', 'npm run test:file -- lib/foo.test.ts', '44 passed/0 failed/0 skipped'],
      ['another filtered run', 'npm run test:file -- lib/foo.test.ts lib/bar.test.ts -- -t "request cancellation"', '44 passed/0 failed/0 skipped'],
      ['a failing final run', 'npm run test:file -- lib/foo.test.ts lib/bar.test.ts', '44 passed/1 failed/0 skipped'],
      ['a final run with skips', 'npm run test:file -- lib/foo.test.ts lib/bar.test.ts', '43 passed/0 failed/1 skipped'],
      ['an unmeasured skip count', 'npm run test:file -- lib/foo.test.ts lib/bar.test.ts', '44 passed/0 failed'],
    ])('STILL warns when historical reproduction evidence is followed by %s (EI-26150517852473091)', async (_label, command, result) => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 'fixed it',
          testsRun: [
            {
              command: 'npm run test:file -- lib/foo.test.ts lib/bar.test.ts -- -t "request cancellation"',
              result: 'Before production change: 6 failed/26 skipped.',
            },
            { command, result },
          ],
          testResult: '44/44 pass',
        },
      });
      expect(r.skippedTestsWarning).toMatch(/26 test\(s\) SKIPPED/);
    });

    it('STILL warns when a name-filter run has no clean unfiltered counterpart', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({
        id: 'F-12',
        state: 'passed',
        completion: {
          summary: 'fixed it',
          testsRun: 'npm run test:file -- foo.test.ts -- -t EI-12',
          testResult: '11 passed | 61 skipped',
        },
      });
      expect(r.skippedTestsWarning).toMatch(/61 test\(s\) SKIPPED/);
    });
  });

  // ── WI-39573: a prose/string completion must fail before any record or state write. ─────
  describe('bare-string completion refusal (WI-39573)', () => {
    it('returns the exact structured-object repair shape from the schema', () => {
      const result = (
        complete.args as {
          safeParse: (x: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } };
        }
      ).safeParse({ id: 'F-12', state: 'passed', assumptions: 'none', completion: 'shipped it, all green' });
      expect(result.success).toBe(false);
      const message = result.error?.issues.map((issue) => issue.message).join(' ') ?? '';
      expect(message).toContain(COMPLETION_STRING_REJECTION);
      expect(message).toContain(COMPLETION_OBJECT_EXAMPLE);
    });

    // WI-10005684 (EI-24822105308825949): the caller's JSON-encoded completion carried one extra `}`;
    // the old rejection said "bare string" and sent them hunting a door bug that did not exist.
    describe('WI-10005684: a malformed JSON-encoded completion string', () => {
      type Safe = {
        success: boolean;
        data?: unknown;
        error?: { issues: Array<{ message: string }> };
      };
      const safeParse = (completion: unknown): Safe =>
        (complete.args as { safeParse: (x: unknown) => Safe }).safeParse({
          id: 'F-12',
          state: 'passed',
          assumptions: 'none',
          completion,
        });
      const evidence = {
        summary: 'closed with evidence',
        testsRun: 'npm run test:file -- complete.test.ts',
        testResult: 'passed',
        verifiedHow: 'unit',
        filesChanged: [] as string[],
      };

      it('an extra trailing } is repaired: the string validates exactly like the same object', () => {
        const fromObject = safeParse(evidence);
        const fromString = safeParse(`${JSON.stringify(evidence)}}`);
        expect(fromObject.success).toBe(true);
        expect(fromString.success).toBe(true);
        expect(fromString.data).toEqual(fromObject.data);
      });

      it('unrepairable brace-delimited junk is refused with the JSON-parse reason PREPENDED to the shared repair text', () => {
        const result = safeParse('{fixed the thing, verified it works}');
        expect(result.success).toBe(false);
        const messages = result.error?.issues.map((issue) => issue.message) ?? [];
        const rejection = messages.find((m) => m.endsWith(COMPLETION_STRING_REJECTION));
        expect(rejection).toBeDefined();
        expect(rejection).toMatch(/looks like a JSON object but is NOT valid JSON/);
        expect(rejection).toContain(COMPLETION_OBJECT_EXAMPLE);
      });

      it('genuine prose keeps the generic rejection with NO JSON-parse prefix', () => {
        const result = safeParse('shipped it, all green');
        expect(result.success).toBe(false);
        const messages = result.error?.issues.map((issue) => issue.message) ?? [];
        expect(messages).toContain(COMPLETION_STRING_REJECTION);
        expect(messages.join(' ')).not.toMatch(/NOT valid JSON/);
      });
    });

    it('does not invoke the work-item reader or state writer after refusal', () => {
      const result = (
        complete.args as {
          safeParse: (x: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } };
        }
      ).safeParse({ id: 'F-12', state: 'passed', assumptions: 'none', completion: 'shipped it' });
      expect(result.success).toBe(false);
      expect(getWorkItem).not.toHaveBeenCalled();
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });
  });

  // ── aliased/requestedState/appliedState on every result (EI-7712) ────────────────────────
  // complete's optional terminal `state` write goes through the SAME shared
  // setWorkItemStateWithAliasInfo helper as work_items:set_state, so a completion that
  // silently aliases — or, per the WI-2381 recurrence guard, silently diverges even
  // without the normalize-layer's onAlias ever firing — must surface it identically.
  describe('aliased/requestedState/appliedState on every result (EI-7712)', () => {
    it('a clean (non-aliased) terminal transition reports aliased:false with matching requested/applied state', async () => {
      getWorkItem.mockResolvedValue(item);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
      const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 'shipped' } });
      expect(r.aliased).toBe(false);
      expect(r.requestedState).toBe('passed');
      expect(r.appliedState).toBe('passed');
    });

    it('an aliased terminal transition reports aliased:true with DIVERGENT requested/applied state', async () => {
      const issue = { id: 'WI-2', kind: 'bug', family: 'issue', state: 'open', harness: 'papercup' };
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockImplementation(async (_id: string, state: string) => ({
        workItem: { ...issue, state: 'open' },
        aliased: true,
        requestedState: state,
        appliedState: 'open',
        aliasNote: `requested state '${state}' has no distinct representation for this item's family — recorded as 'open' instead.`,
      }));
      const r = await one({ id: 'WI-2', state: 'blocked', completion: { summary: 'blocked on X' } });
      expect(r.aliased).toBe(true);
      expect(r.requestedState).toBe('blocked');
      expect(r.appliedState).toBe('open');
      expect(r.requestedState).not.toBe(r.appliedState);
    });

    it('a bare completion (no `state` passed) leaves aliased/requestedState/appliedState unset — nothing was compared', async () => {
      getWorkItem.mockResolvedValue(item);
      const r = await one({ id: 'F-12', completion: { summary: 'progress note' } });
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(r.aliased).toBeUndefined();
      expect(r.requestedState).toBeUndefined();
      expect(r.appliedState).toBeUndefined();
    });

    it('a silent divergence with NO onAlias fire still surfaces as aliased:true — the WI-2381 recurrence guard', async () => {
      getWorkItem.mockResolvedValue({ ...item, id: 'WI-2381', family: 'issue', state: 'open' });
      setWorkItemStateWithAliasInfo.mockImplementation(async (_id: string, state: string) => ({
        workItem: { ...item, id: 'WI-2381', family: 'issue', state: 'open' }, // silently stayed 'open'
        aliased: true,
        requestedState: state,
        appliedState: 'open',
        aliasNote: `requested state '${state}' was not applied verbatim — recorded as 'open' instead.`,
      }));
      const r = await one({ id: 'WI-2381', state: 'blocked', completion: { summary: 'trying to block it' } });
      expect(r.ok).toBe(true); // the write itself succeeded — exactly why `ok` alone is not enough
      expect(r.aliased).toBe(true);
      expect(r.appliedState).not.toBe(r.requestedState);
    });
  });
});

describe('work_items:complete ephemeral terminal-deliverable warning (EI-20268156880922192)', () => {
  it('suppresses a scratch reference only when Git definitely tracks the repo-relative file', async () => {
    const isTracked = vi.fn(async (_root: string, relativePath: string) => relativePath.endsWith('/tracked-report.md'));
    const references = await completionEphemeralDeliverableReferences(
      {
        summary:
          'Tracked source .papercusp/scratch/tracked-report.md; untracked source .papercusp/scratch/untracked-report.md.',
      },
      undefined,
      { repoRoots: ['/repo'], isTracked },
    );

    expect(references).toEqual([
      { kind: 'scratch-path', reference: '.papercusp/scratch/untracked-report.md' },
    ]);
    expect(isTracked).toHaveBeenCalledWith('/repo', '.papercusp/scratch/tracked-report.md');
    expect(isTracked).toHaveBeenCalledWith('/repo', '.papercusp/scratch/untracked-report.md');
  });

  it.each(['untracked', 'ignored'])('keeps a definitely %s scratch path warning', async (ownership) => {
    const references = await completionEphemeralDeliverableReferences(
      { summary: `The ${ownership} report is at .papercusp/scratch/${ownership}-report.md.` },
      undefined,
      { repoRoot: '/repo', isTracked: () => false },
    );

    expect(references).toEqual([
      { kind: 'scratch-path', reference: `.papercusp/scratch/${ownership}-report.md` },
    ]);
  });

  it('keeps the warning when ownership is unknown or the trackedness probe throws', async () => {
    const unknown = await completionEphemeralDeliverableReferences(
      { summary: 'The report is at .papercusp/scratch/unknown-report.md.' },
      undefined,
      { repoRoots: ['/repo'], isTracked: () => undefined },
    );
    const throwing = await completionEphemeralDeliverableReferences(
      { summary: 'The report is at .papercusp/scratch/throwing-report.md.' },
      undefined,
      {
        repoRoots: ['/repo'],
        isTracked: () => {
          throw new Error('git unavailable');
        },
      },
    );

    expect(unknown).toEqual([{ kind: 'scratch-path', reference: '.papercusp/scratch/unknown-report.md' }]);
    expect(throwing).toEqual([{ kind: 'scratch-path', reference: '.papercusp/scratch/throwing-report.md' }]);
  });

  it('suppresses an artifact URL when a declared repository path has matching server blob identities', async () => {
    const blobSha = 'b'.repeat(40);
    const references = await completionEphemeralDeliverableReferences(
      {
        summary: 'Copied the report from https://claude.ai/artifacts/durable-source.',
        filesChanged: ['docs/report.md'],
      },
      undefined,
      {
        repoRoots: ['/repo'],
        treeStamp: {
          headSha: 'a'.repeat(40),
          contentIdentity: [
            {
              path: 'docs/report.md',
              workingTreeBlobSha: blobSha,
              headBlobSha: blobSha,
            },
          ],
        },
        isTracked: () => false,
      },
    );

    expect(references).toEqual([]);
  });

  it('keeps an artifact URL when the matching identity belongs to a different declared path', async () => {
    const blobSha = 'b'.repeat(40);
    const references = await completionEphemeralDeliverableReferences(
      {
        summary: 'The source artifact is https://claude.ai/artifacts/unrelated-source.',
        filesChanged: ['docs/report.md'],
      },
      undefined,
      {
        repoRoots: ['/repo'],
        treeStamp: {
          headSha: 'a'.repeat(40),
          contentIdentity: [
            {
              path: 'src/other.ts',
              workingTreeBlobSha: blobSha,
              headBlobSha: blobSha,
            },
          ],
        },
        isTracked: () => false,
      },
    );

    expect(references).toEqual([{ kind: 'artifact-url', reference: 'https://claude.ai/artifacts/unrelated-source' }]);
  });

  it('wires the persisted tree stamp into the handler warning decision', async () => {
    getWorkItem.mockResolvedValue({
      ...item,
      id: 'WI-ephemeral-durable',
      kind: 'task',
      family: 'issue',
      state: 'open',
    });

    const r = await one({
      id: 'WI-ephemeral-durable',
      completion: {
        summary: 'The source report was copied from https://claude.ai/artifacts/durable-handler-source.',
        filesChanged: ['packages/operator-core/vitest.config.ts'],
      },
    });

    expect(r.ok).toBe(true);
    expect(r.ephemeralDeliverableWarning).toBeUndefined();
  });

  it.each([
    ['mismatched blobs', { workingTreeBlobSha: 'b'.repeat(40), headBlobSha: 'c'.repeat(40) }],
    ['missing working-tree blob', { workingTreeBlobSha: null, headBlobSha: 'b'.repeat(40) }],
    ['deleted path', { workingTreeBlobSha: null, headBlobSha: null, deletion: true as const }],
  ])('keeps an artifact URL when the server cannot prove a durable changed path (%s)', async (_name, identity) => {
    const references = await completionEphemeralDeliverableReferences(
      {
        summary: 'The source artifact is https://claude.ai/artifacts/unproven-source.',
        filesChanged: ['docs/report.md'],
      },
      undefined,
      {
        repoRoots: ['/repo'],
        treeStamp: {
          headSha: 'a'.repeat(40),
          contentIdentity: [{ path: 'docs/report.md', ...identity }],
        },
        isTracked: () => false,
      },
    );

    expect(references).toEqual([{ kind: 'artifact-url', reference: 'https://claude.ai/artifacts/unproven-source' }]);
  });

  it('warns while still recording completion prose that cites scratch/artifact references', async () => {
    getWorkItem.mockResolvedValue({ ...item, id: 'WI-ephemeral', kind: 'task', family: 'issue', state: 'open' });

    const r = await one({
      id: 'WI-ephemeral',
      completion: {
        summary: 'The report is at .papercusp/scratch/readiness.md and https://claude.ai/artifacts/abc.',
      },
    });

    expect(r.ok).toBe(true);
    expect(r.ephemeralDeliverableWarning).toContain('.papercusp/scratch/readiness.md');
    expect(r.ephemeralDeliverableWarning).toContain('https://claude.ai/artifacts/abc');
    expect(r.ephemeralDeliverableWarning).toContain('write was recorded');
    expect(r.completion.summary).toContain('.papercusp/scratch/readiness.md');
  });

  it('ignores scratch/artifact references quoted only in verification and causal prose', async () => {
    getWorkItem.mockResolvedValue({ ...item, id: 'WI-ephemeral-prose', kind: 'task', family: 'issue', state: 'open' });

    const scratchPath = '/home/x/.papercusp/scratch/out.json';
    const artifactUrl = 'https://claude.ai/artifacts/quoted';
    const r = await one({
      id: 'WI-ephemeral-prose',
      completion: {
        summary: 'Fixed the completion evidence guard.',
        testsRun: `The regression fixture quotes ${scratchPath}.`,
        testResult: `The source fixture also quotes ${artifactUrl}.`,
        verifiedHow: 'unit',
        verification: {
          testResult: `Forensic verification cites ${scratchPath} and ${artifactUrl}.`,
        },
        rootCauseVerification: {
          ...ROOT_CAUSE_VERIFICATION_FIXTURE,
          testResult: `The causal record quotes ${artifactUrl} only as source evidence.`,
        },
        deferred: [`Follow-up prose also mentions ${scratchPath}.`],
        coordNotes: `Forensics cite ${artifactUrl}; no deliverable is stored there.`,
      },
    });

    expect(r.ok).toBe(true);
    expect(r.ephemeralDeliverableWarning).toBeUndefined();
  });

  it('does not treat a loopback URL in forensic verification as the deliverable', async () => {
    getWorkItem.mockResolvedValue({
      ...item,
      id: 'WI-loopback-forensics',
      kind: 'task',
      family: 'issue',
      state: 'open',
    });

    const r = await one({
      id: 'WI-loopback-forensics',
      completion: {
        summary: 'Fixed the automatic lock-release transport.',
        verifiedHow: 'Live evidence showed hook authority http://localhost:3170 during the restart window.',
      },
    });

    expect(r.ok).toBe(true);
    expect(r.ephemeralDeliverableWarning).toBeUndefined();
  });

  it('still warns when completion summary presents a loopback URL as the deliverable', async () => {
    getWorkItem.mockResolvedValue({
      ...item,
      id: 'WI-loopback-deliverable',
      kind: 'task',
      family: 'issue',
      state: 'open',
    });

    const r = await one({
      id: 'WI-loopback-deliverable',
      completion: {
        summary: 'Open the finished report at http://localhost:8765/report.',
        verifiedHow: 'manual',
      },
    });

    expect(r.ok).toBe(true);
    expect(r.ephemeralDeliverableWarning).toContain('http://localhost:8765/report');
  });
});

/**
 * EI-7031 — work_items:complete failed ~15% of calls, almost entirely on malformed
 * `completion` SHAPE from LLM callers (scalar↔array swaps, missing summary, flat
 * fields with no wrapper). Structured fields are normalised BEFORE validation; a
 * prose/bare-string completion is rejected instead of being silently turned into
 * summary-only evidence. These pin the coercion + the wiring + the published schema.
 */
describe('work_items:complete input coercion (EI-7031)', () => {
  describe('coerceCompletionShape (unit)', () => {
    it('leaves a prose/bare string unchanged so the schema can reject it with the object example', () => {
      expect(coerceCompletionShape('shipped the fix')).toBe('shipped the fix');
    });

    it('does not add a coercion marker to a bare string or a normal object', () => {
      const fromString = coerceCompletionShape('shipped it');
      expect(fromString).toBe('shipped it');
      const fromObject = coerceCompletionShape({ summary: 'shipped it' }) as { __shapeCoercedFrom?: unknown };
      expect(fromObject.__shapeCoercedFrom).toBeUndefined();
    });

    it('an empty/whitespace-only string is left for validation to reject (not silently accepted)', () => {
      expect(coerceCompletionShape('   ')).toBe('   ');
    });

    it('a scalar in an array-typed field is wrapped LOSSLESSLY (no comma-splitting)', () => {
      const out = coerceCompletionShape({ summary: 's', whatLanded: 'did A, B and C' }) as { whatLanded: unknown };
      expect(out.whatLanded).toEqual(['did A, B and C']);
    });

    it('coerces migrations + deferred scalars the same way', () => {
      const out = coerceCompletionShape({ summary: 's', migrations: '137 foo', deferred: 'timeout follow-up' }) as {
        migrations: unknown;
        deferred: unknown;
      };
      expect(out.migrations).toEqual(['137 foo']);
      expect(out.deferred).toEqual(['timeout follow-up']);
    });

    it('coerces scalar self-review findings and yielded changes losslessly', () => {
      const out = coerceCompletionShape({
        summary: 's',
        selfReview: {
          lookedAt: 'the diff',
          findings: 'the test missed a nested scalar',
          changedAsResult: 'added the regression guard',
        },
      }) as { selfReview: Record<string, unknown> };
      expect(out.selfReview).toEqual({
        lookedAt: 'the diff',
        findings: ['the test missed a nested scalar'],
        changedAsResult: ['added the regression guard'],
      });
    });

    it('wires self-review lookedAt array coercion through the public completion schema', () => {
      const result = (
        complete.args as {
          safeParse: (value: unknown) => { success: boolean; data?: unknown };
        }
      ).safeParse({
        id: 'WI-self-review-looked-at',
        completion: {
          summary: 's',
          selfReview: {
            lookedAt: ['completion-coerce.ts', 'completion-coerce.test.ts'],
            findings: [],
            changedAsResult: [],
          },
        },
      });

      expect(result.success).toBe(true);
      const completion = (result.data as { completion: { selfReview: { lookedAt: unknown } } }).completion;
      expect(completion.selfReview.lookedAt).toBe('completion-coerce.ts; completion-coerce.test.ts');
    });

    it('normalizes false self-review scalars to explicit empty arrays', () => {
      const out = coerceCompletionShape({
        summary: 's',
        selfReview: {
          lookedAt: 'the diff',
          findings: false,
          changedAsResult: false,
        },
      }) as { selfReview: Record<string, unknown> };

      expect(out.selfReview).toEqual({
        lookedAt: 'the diff',
        findings: [],
        changedAsResult: [],
      });
    });

    it('coerces structured verification aliases', () => {
      const out = coerceCompletionShape({
        summary: 's',
        filesChanged: 'packages/operator-core/lib/work-items.ts',
        addedTests: 'true',
      }) as { filesChanged: unknown; addedTests: unknown };
      expect(out.filesChanged).toEqual(['packages/operator-core/lib/work-items.ts']);
      expect(out.addedTests).toBe(true);
    });

    it.each(['', '   '])('EI-22691088505562531: treats blank optional duplicateOf %j as omission', (duplicateOf) => {
      const out = coerceCompletionShape({ summary: 's', duplicateOf }) as Record<string, unknown>;
      expect(out).not.toHaveProperty('duplicateOf');
    });

    it('EI-22691088505562531: preserves a non-empty duplicateOf target', () => {
      const out = coerceCompletionShape({ summary: 's', duplicateOf: 'EI-survivor' }) as Record<string, unknown>;
      expect(out.duplicateOf).toBe('EI-survivor');
    });

    it.each([
      'none',
      'None',
      'NONE',
      'n/a',
      'N/A',
      'na',
      'nil',
      'null',
      'nothing',
      'no files',
      'no files changed',
      'no changes',
      'no change',
      '-',
      '  none  ',
    ])(
      'EI-22166136861574482: normalizes the no-code-change sentinel %j to an empty filesChanged array, not a fabricated path',
      (sentinel) => {
        const out = coerceCompletionShape({ summary: 's', filesChanged: sentinel }) as { filesChanged: unknown };
        expect(out.filesChanged).toEqual([]);
      },
    );

    it('EI-22166136861574482: normalizes a sentinel wrapped in the documented array form the same way', () => {
      const out = coerceCompletionShape({ summary: 's', filesChanged: ['none'] }) as { filesChanged: unknown };
      expect(out.filesChanged).toEqual([]);
    });

    it('EI-22166136861574482: normalizes the sentinel under verification.filesChanged too', () => {
      const out = coerceCompletionShape({
        summary: 's',
        verification: { filesChanged: 'n/a', testsRun: 'unit', testResult: 'passed' },
      }) as { verification: { filesChanged: unknown } };
      expect(out.verification.filesChanged).toEqual([]);
    });

    it('EI-22166136861574482: a real path is never mistaken for a sentinel (only an exact whole-string match qualifies)', () => {
      const out = coerceCompletionShape({
        summary: 's',
        filesChanged: ['none.txt', 'src/na/config.ts', 'packages/operator-core/lib/none-of-the-above.ts'],
      }) as { filesChanged: unknown };
      expect(out.filesChanged).toEqual([
        'none.txt',
        'src/na/config.ts',
        'packages/operator-core/lib/none-of-the-above.ts',
      ]);
    });

    // WI-10005684 (EI-23774140426573307): the sentinel set only matches a WHOLE string, so a
    // truthful negation written as a SENTENCE was comma-split into fabricated "paths" and the
    // close landed authority:'proposed'. A negation LEAD with NO path-shaped token is the empty set.
    it.each([
      'None. This is a not-a-defect close, no source, test, or config file was modified.',
      'none - investigation only, nothing was edited',
      'No files changed; this was a verification-only close.',
      'No changes were needed, the item was already fixed at HEAD.',
      'N/A, read-only audit',
    ])('WI-10005684: a path-free negation sentence %j normalizes to an empty filesChanged array', (sentence) => {
      const out = coerceCompletionShape({ summary: 's', filesChanged: sentence }) as { filesChanged: unknown };
      expect(out.filesChanged).toEqual([]);
      const nested = coerceCompletionShape({
        summary: 's',
        verification: { filesChanged: sentence, testsRun: 'unit', testResult: 'passed' },
      }) as { verification: { filesChanged: unknown } };
      expect(nested.verification.filesChanged).toEqual([]);
    });

    it.each([
      // The control that stops the lead-word match from swallowing real evidence: it names a path.
      ['None, but I did edit src/a.ts', ['None', 'but I did edit src/a.ts']],
      ['no changes to docs, only packages/operator-core/lib/x.ts', ['no changes to docs', 'only packages/operator-core/lib/x.ts']],
      // No negation lead at all — an ordinary comma-separated path list is untouched.
      ['src/a.ts, src/b.ts', ['src/a.ts', 'src/b.ts']],
      // A dotted extension alone (no separator) is path-shaped.
      ['none, edited a.ts', ['none', 'edited a.ts']],
    ])('WI-10005684: %j names a path, so it is NOT a negation and keeps the list rescue', (value, expected) => {
      const out = coerceCompletionShape({ summary: 's', filesChanged: value }) as { filesChanged: unknown };
      expect(out.filesChanged).toEqual(expected);
    });

    it('WI-10005684: a negation lead that is only a PREFIX of a word is not a negation (nonexistent.ts-style paths survive)', () => {
      const out = coerceCompletionShape({ summary: 's', filesChanged: 'nothingness-config, notes' }) as {
        filesChanged: unknown;
      };
      expect(out.filesChanged).toEqual(['nothingness-config', 'notes']);
    });

    it('accepts server-generated root treeStamp and settlementManifest on a read→retry (EI-21599866958764530)', () => {
      const treeStamp = {
        repositoryRoot: '/repo',
        headSha: 'a'.repeat(40),
        contentIdentity: [
          {
            path: 'src/fix.ts',
            workingTreeBlobSha: 'b'.repeat(40),
            headBlobSha: 'b'.repeat(40),
          },
        ],
      };
      const settlementManifest = {
        version: 1,
        generation: 1,
        evidenceHash: 'c'.repeat(64),
        repositoryRoot: '/repo',
        headSha: treeStamp.headSha,
        normalizedPaths: ['src/fix.ts'],
        contentIdentity: treeStamp.contentIdentity,
      };
      const historyAttestation = {
        version: 1,
        generation: 1,
        evidenceHash: settlementManifest.evidenceHash,
        repositoryRoot: settlementManifest.repositoryRoot,
        closeHeadSha: settlementManifest.headSha,
        emittedCommitSha: 'd'.repeat(40),
        paths: [{
          path: 'src/fix.ts',
          workingTreeBlobSha: 'b'.repeat(40),
          fromHeadSha: settlementManifest.headSha,
          toCommitSha: 'd'.repeat(40),
          proof: 'exact-path-blob-history',
        }],
      };
      const result = (
        complete.args as {
          safeParse: (value: unknown) => { success: boolean; data?: any; error?: unknown };
        }
      ).safeParse({
        id: 'WI-21599866958764530',
        completion: {
          workItem: 'WI-21599866958764530',
          summary: 'retrying the recorded completion',
          testsRun: 'focused test',
          testResult: 'passed',
          verifiedHow: 'unit',
          treeStamp,
          settlementManifest,
        },
      });

      expect(result.success).toBe(true);
      expect(result.data?.completion).not.toHaveProperty('treeStamp');
      expect(result.data?.completion).not.toHaveProperty('settlementManifest');

      const nestedResult = (
        complete.args as {
          safeParse: (value: unknown) => { success: boolean; data?: any; error?: unknown };
        }
      ).safeParse({
        id: 'WI-21599866958764530',
        completion: {
          workItem: 'WI-21599866958764530',
          summary: 'retrying the recorded completion with nested evidence',
          verification: {
            filesChanged: ['src/fix.ts'],
            testsRun: 'focused test',
            testResult: 'passed',
            verifiedHow: 'unit',
            settlementManifest,
            historyAttestation,
          },
        },
      });

      expect(nestedResult.success).toBe(true);
      expect(nestedResult.data?.completion?.verification).not.toHaveProperty('settlementManifest');
      expect(nestedResult.data?.completion?.verification).not.toHaveProperty('historyAttestation');
    });

    it('rejects caller-supplied top-level historyAttestation', () => {
      const result = (
        complete.args as {
          safeParse: (value: unknown) => { success: boolean; data?: any; error?: unknown };
        }
      ).safeParse({
        id: 'WI-21599866958764530',
        completion: {
          summary: 'caller cannot author a settlement history proof',
          historyAttestation: {
            version: 1,
            generation: 1,
            evidenceHash: 'c'.repeat(64),
            repositoryRoot: '/repo',
            closeHeadSha: 'a'.repeat(40),
            emittedCommitSha: 'd'.repeat(40),
            paths: [{
              path: 'src/fix.ts',
              workingTreeBlobSha: 'b'.repeat(40),
              fromHeadSha: 'a'.repeat(40),
              toCommitSha: 'd'.repeat(40),
              proof: 'exact-path-blob-history',
            }],
          },
        },
      });

      expect(result.success).toBe(false);
    });

    it('accepts the server-stamped assumptions object on a read→retry (EI-22404076241784390)', () => {
      const result = (
        complete.args as {
          safeParse: (value: unknown) => { success: boolean; data?: any; error?: unknown };
        }
      ).safeParse({
        id: 'EI-22404076241784390',
        state: 'done',
        assumptions: {
          declared: 'none',
          resolvedAt: '2026-09-05T21:00:00.000Z',
        },
        completion: {
          workItem: 'EI-22404076241784390',
          summary: 'retrying the recorded completion',
          filesChanged: [],
          filesDeleted: [],
        },
      });

      expect(result.success).toBe(true);
      expect(result.data?.assumptions).toBe('none');
    });

    it('splits a scalar filesChanged path list on comma, semicolon, or newline', () => {
      const out = coerceCompletionShape({
        summary: 's',
        filesChanged:
          'packages/operator-core/lib/a.ts, packages/operator-core/lib/b.ts;\npackages/operator-core/lib/c.ts',
      }) as { filesChanged: unknown };

      expect(out.filesChanged).toEqual([
        'packages/operator-core/lib/a.ts',
        'packages/operator-core/lib/b.ts',
        'packages/operator-core/lib/c.ts',
      ]);
    });

    it('unwraps a one-element addedTests array and joins top-level testsRun arrays', () => {
      const out = coerceCompletionShape({
        summary: 's',
        addedTests: [true],
        testsRun: ['focused completion test', 'green'],
      }) as { addedTests: unknown; testsRun: unknown };
      expect(out.addedTests).toBe(true);
      expect(out.testsRun).toBe('focused completion test; green');
    });

    it('keeps multi-element addedTests arrays invalid instead of guessing a boolean', () => {
      const out = coerceCompletionShape({ summary: 's', addedTests: [true, false] }) as { addedTests: unknown };
      expect(out.addedTests).toEqual([true, false]);
    });

    it('coerces array-valued aliases nested under verification before schema validation', () => {
      const out = coerceCompletionShape({
        summary: 's',
        verification: {
          testsRun: ['67 green', 'vitest'],
          testResult: ['passed'],
          filesChanged:
            'packages/operator-core/lib/work-items.ts, packages/operator-core/lib/agent-tools/work_items/complete.ts',
          addedTests: 'true',
        },
      }) as { verification: Record<string, unknown> };
      expect(out.verification).toEqual({
        testsRun: '67 green; vitest',
        testResult: 'passed',
        filesChanged: [
          'packages/operator-core/lib/work-items.ts',
          'packages/operator-core/lib/agent-tools/work_items/complete.ts',
        ],
        addedTests: true,
      });
    });

    it('coerces structured filesChanged entries to their paths', () => {
      const out = coerceCompletionShape({
        summary: 'landed',
        filesChanged: [
          { path: 'packages/operator-core/lib/work-items.ts', change: 'updated completion handling' },
          'packages/operator-core/lib/agent-tools/work_items/complete.ts',
        ],
      }) as { filesChanged: unknown };

      expect(out.filesChanged).toEqual([
        'packages/operator-core/lib/work-items.ts',
        'packages/operator-core/lib/agent-tools/work_items/complete.ts',
      ]);
    });

    it('EI-21905322780107586: rejects a filesChanged entry that survived comma-splitting as prose, not a path', () => {
      // Reproduces the reported shape: a scalar filesChanged string DESCRIBING several
      // changes in one paragraph, comma-split by coerceFilesChanged's list rescue
      // (EI-21471221125941096) into fragments that are not path-shaped.
      const result = (
        complete.args as { safeParse: (value: unknown) => { success: boolean; error?: unknown } }
      ).safeParse({
        id: 'WI-1',
        completion: {
          summary: 'landed',
          filesChanged:
            'scripts/check-required-field-strands.mjs (collectExportedValueNames added, ' +
            'diffSignatureBreaks gained the before-map walk, ...)',
        },
      });

      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error)).toContain('bare repo-relative paths, not prose');
    });

    it('still accepts a genuine comma-separated filesChanged path list (EI-21471221125941096, unaffected)', () => {
      const result = (complete.args as { safeParse: (value: unknown) => { success: boolean; data?: any } }).safeParse({
        id: 'WI-2',
        completion: {
          summary: 'landed',
          filesChanged: 'packages/operator-core/lib/a.ts, packages/operator-core/lib/b.ts',
        },
      });

      expect(result.success).toBe(true);
      expect(result.data?.completion.filesChanged).toEqual([
        'packages/operator-core/lib/a.ts',
        'packages/operator-core/lib/b.ts',
      ]);
    });

    it('EI-22191579345441592: rejects a filesChanged entry that is a glob pattern with an annotation', () => {
      // The reported shape (WI-42227): a glob describing a population of files, plus a
      // trailing prose annotation, declared as one `filesChanged` entry — no downstream
      // blob-containment audit can resolve it, and its emptiness reads as "absent".
      const result = (
        complete.args as { safeParse: (value: unknown) => { success: boolean; error?: unknown } }
      ).safeParse({
        id: 'WI-1',
        completion: {
          summary: 'landed',
          filesChanged: ['packages/operator-core/lib/sync/hyperbee/projections/**/*.ts (writer contract sweep)'],
        },
      });

      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error)).toContain('not a glob pattern');
    });

    it('EI-22191579345441592: rejects a bare glob entry with no whitespace or prose punctuation', () => {
      // The whitespace+punctuation check above cannot see this shape at all: no space,
      // no parens, no comma — just a glob metacharacter.
      const result = (
        complete.args as { safeParse: (value: unknown) => { success: boolean; error?: unknown } }
      ).safeParse({
        id: 'WI-1',
        completion: {
          summary: 'landed',
          filesChanged: ['packages/operator-core/lib/sync/hyperbee/**/*.test.ts'],
        },
      });

      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error)).toContain('not a glob pattern');
    });

    it('EI-22191579345441592: rejects a brace-expansion glob entry', () => {
      const result = (
        complete.args as { safeParse: (value: unknown) => { success: boolean; error?: unknown } }
      ).safeParse({
        id: 'WI-1',
        completion: {
          summary: 'landed',
          filesChanged: ['packages/operator-core/lib/sync/hyperbee/**/*.{test,integration.test}.ts'],
        },
      });

      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error)).toContain('not a glob pattern');
    });

    it('EI-22191579345441592: still accepts a bracketed Next.js dynamic-route path (not a glob)', () => {
      // Regression guard: `[` / `]` are deliberately EXCLUDED from the glob detector
      // because this repo has real, legitimate filesChanged paths built from bracketed
      // dynamic-route segments (e.g. the WI-2142463 close named this exact path).
      const result = (complete.args as { safeParse: (value: unknown) => { success: boolean; data?: any } }).safeParse({
        id: 'WI-2',
        completion: {
          summary: 'landed',
          filesChanged: ['apps/web/app/api/zero-proxy/[...path]/route.ts'],
        },
      });

      expect(result.success).toBe(true);
      expect(result.data?.completion.filesChanged).toEqual(['apps/web/app/api/zero-proxy/[...path]/route.ts']);
    });

    it('an array in a string-typed field is joined (the "tests: expected string, received array")', () => {
      const out = coerceCompletionShape({ summary: 's', tests: ['67 green', 'vitest'] }) as { tests: unknown };
      expect(out.tests).toBe('67 green; vitest');
    });

    it('wires scalar↔array recovery through the published args schema', () => {
      const result = (
        complete.args as {
          safeParse: (value: unknown) => { success: boolean; data?: any };
        }
      ).safeParse({
        id: 'WI-21308742764698474',
        completion: {
          workItem: 'WI-21308742764698474',
          summary: 'shape recovery',
          addedTests: [true],
          testsRun: ['focused completion test', 'green'],
        },
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        completion: {
          addedTests: true,
          testsRun: 'focused completion test; green',
        },
      });
    });

    it('wires nested self-review scalar-to-array recovery through the published args schema', () => {
      const result = (
        complete.args as {
          safeParse: (value: unknown) => { success: boolean; data?: any };
        }
      ).safeParse({
        id: 'EI-21578247892962931',
        completion: {
          workItem: 'EI-21578247892962931',
          summary: 'nested self-review shape recovery',
          selfReview: {
            lookedAt: 'completion-coerce.ts',
            findings: 'scalar finding',
            changedAsResult: 'scalar change',
          },
        },
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        completion: {
          selfReview: {
            findings: ['scalar finding'],
            changedAsResult: ['scalar change'],
          },
        },
      });
    });

    it('accepts the reported false changedAsResult shape through the published args schema', () => {
      const result = (
        complete.args as {
          safeParse: (value: unknown) => { success: boolean; data?: any };
        }
      ).safeParse({
        id: 'EI-21887406150452962',
        completion: {
          workItem: 'EI-21887406150452962',
          summary: 'self-review shape recovery',
          selfReview: {
            lookedAt: 'the diff',
            findings: 'no additional findings',
            changedAsResult: false,
          },
        },
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        completion: {
          selfReview: {
            findings: ['no additional findings'],
            changedAsResult: [],
          },
        },
      });
    });

    it('derives a summary from title / whatLanded / status when omitted (the 2× missing summary)', () => {
      expect((coerceCompletionShape({ title: 'Fix loop guard' }) as { summary: string }).summary).toBe(
        'Fix loop guard',
      );
      expect((coerceCompletionShape({ whatLanded: 'guard.ts patched' }) as { summary: string }).summary).toBe(
        'guard.ts patched',
      );
      expect((coerceCompletionShape({ status: 'shipped' }) as { summary: string }).summary).toBe('shipped');
      expect((coerceCompletionShape({}) as { summary: string }).summary).toBe('done');
    });

    it('leaves a WELL-FORMED completion deep-equal (only rescues mis-shapes)', () => {
      const good = { summary: 'all green', whatLanded: ['a.ts', 'b.ts'], tests: '5 green', deferred: ['x'] };
      expect(coerceCompletionShape(good)).toEqual(good);
    });

    it('strips the known server-generated checkpoint metadata while preserving other fields', () => {
      const out = coerceCompletionShape({
        summary: 'retry stored evidence',
        testsRun: 'focused completion test',
        checkpointChecksCarried: [{ claim: 'the checkpoint was checked' }],
      }) as Record<string, unknown>;

      expect(out).toEqual({ summary: 'retry stored evidence', testsRun: 'focused completion test' });
      expect(out).not.toHaveProperty('checkpointChecksCarried');
    });

    it('does not strip an unrelated unknown completion field', () => {
      const out = coerceCompletionShape({ summary: 's', unrelatedField: 'keep for strict validation' }) as Record<
        string,
        unknown
      >;

      expect(out.unrelatedField).toBe('keep for strict validation');
    });

    it('passes a non-string, non-object value through untouched', () => {
      expect(coerceCompletionShape(42)).toBe(42);
      expect(coerceCompletionShape(null)).toBe(null);
    });
  });

  describe('EI-7311: a JSON-STRINGIFIED completion object is parsed back into an object, not swallowed as one giant summary', () => {
    it('a JSON-object-shaped string is parsed and every field survives (the exact EI-6516/EI-6528 shape)', () => {
      const jsonString = JSON.stringify({
        summary: 'Stale summary-lag observation — all 3 cited placements completed successfully.',
        status: 'resolved',
        whatLanded: ['WI-1088, WI-1502, WI-1503 all now state=passed'],
        tests: 'N/A — investigation only. Verified via work_items:get on all 3 cited ids.',
        coordNotes: 'closing as resolved',
      });
      const out = coerceCompletionShape(jsonString) as {
        summary: string;
        status: string;
        whatLanded: unknown;
        tests: string;
        coordNotes: string;
      };
      expect(out.summary).toBe('Stale summary-lag observation — all 3 cited placements completed successfully.');
      expect(out.tests).toBe('N/A — investigation only. Verified via work_items:get on all 3 cited ids.');
      expect(out.whatLanded).toEqual(['WI-1088, WI-1502, WI-1503 all now state=passed']);
      expect(out.coordNotes).toBe('closing as resolved');
    });

    it('a JSON-stringified completion with mis-shaped sub-fields still runs through the normal array/string coercion (recurses, not a one-shot parse)', () => {
      const jsonString = JSON.stringify({ summary: 's', tests: ['67 green', 'vitest'], whatLanded: 'one file' });
      const out = coerceCompletionShape(jsonString) as { tests: unknown; whatLanded: unknown };
      expect(out.tests).toBe('67 green; vitest');
      expect(out.whatLanded).toEqual(['one file']);
    });

    it('genuine prose that merely starts/ends with braces but is not valid JSON remains a rejected string', () => {
      const prose = '{fixed the thing, verified it works}';
      expect(coerceCompletionShape(prose)).toBe(prose);
    });

    it('a JSON ARRAY string (not an object) is not mistaken for the object shape', () => {
      const jsonArrayString = JSON.stringify(['a', 'b']);
      expect(coerceCompletionShape(jsonArrayString)).toBe(jsonArrayString);
    });

    it('a JSON-OBJECT-shaped string is recursed into the object path — NOT marked as truncation (fields survive, EI-7311)', () => {
      const jsonString = JSON.stringify({ summary: 's', tests: '5 green' });
      const out = coerceCompletionShape(jsonString) as { __shapeCoercedFrom?: unknown };
      expect(out.__shapeCoercedFrom).toBeUndefined();
    });

    // WI-10005684 (EI-24822105308825949): the measured ledger row (tool_invocations 30937604)
    // was a JSON string with ONE EXTRA trailing `}` — malformed by the caller, not mangled by
    // the door. Extra closers carry no data, so the peel is lossless and carries NO marker.
    it('WI-10005684: a JSON string with extra trailing closers is recovered LOSSLESSLY and is NOT marked truncated', () => {
      const body = { summary: 'closed', tests: '5 green', filesChanged: ['src/a.ts'] };
      for (const suffix of ['}', '}}', ' }\n', ']}']) {
        const out = coerceCompletionShape(JSON.stringify(body) + suffix) as Record<string, unknown>;
        expect(out.summary).toBe('closed');
        expect(out.tests).toBe('5 green');
        expect(out.filesChanged).toEqual(['src/a.ts']);
        expect(out.__shapeCoercedFrom).toBeUndefined();
      }
    });

    it('WI-10005684: peeling never turns a TRUNCATED object (a closer MISSING) into a clean one — that still takes the marked truncation repair', () => {
      const whole = JSON.stringify({ summary: 'closed', nested: { a: [1, 2] } });
      const truncated = whole.slice(0, -1); // drop the final `}` only
      const out = coerceCompletionShape(truncated) as Record<string, unknown>;
      expect(out.summary).toBe('closed');
      expect(out.__shapeCoercedFrom).toBe('truncated-json');
    });

    it('WI-10005684: excess closers on a string with NO completion key are not rescued (prose in braces stays a string)', () => {
      const notCompletion = '{"foo":"bar"}}';
      expect(coerceCompletionShape(notCompletion)).toBe(notCompletion);
    });

    it('WI-10005684: describeUnparseableCompletionJsonString names the parser reason for brace-delimited junk and stays silent for prose / valid JSON', () => {
      const reason = describeUnparseableCompletionJsonString('{fixed the thing, verified it works}');
      expect(reason).toMatch(/NOT valid JSON/);
      expect(reason).toMatch(/structured object value/);
      expect(describeUnparseableCompletionJsonString('shipped it, all green')).toBeUndefined();
      expect(describeUnparseableCompletionJsonString(JSON.stringify({ summary: 's' }))).toBeUndefined();
      expect(describeUnparseableCompletionJsonString({ summary: 's' })).toBeUndefined();
    });
  });

  describe('hoistMisplacedCompletionFields (unit, EI-21868028531788587 / EI-22073105984724419)', () => {
    it('hoists `assumptions` nested inside `completion` up to the top level (single-complete shorthand)', () => {
      expect(
        hoistMisplacedCompletionFields({
          id: 'WI-1',
          state: 'done',
          completion: { summary: 's', assumptions: ['my-fact-key'] },
        }),
      ).toEqual({
        id: 'WI-1',
        state: 'done',
        completion: { summary: 's' },
        assumptions: ['my-fact-key'],
      });
    });

    it('hoists the "none" sentinel too', () => {
      expect(hoistMisplacedCompletionFields({ id: 'WI-1', completion: { summary: 's', assumptions: 'none' } })).toEqual(
        { id: 'WI-1', completion: { summary: 's' }, assumptions: 'none' },
      );
    });

    it('hoists `specAdequacy` and `outputPayload` nested inside `completion`, together, up to the top level', () => {
      const specAdequacy = { classRef: 'plan-class-bugfix' };
      expect(
        hoistMisplacedCompletionFields({
          id: 'WI-1',
          completion: { summary: 's', specAdequacy, outputPayload: { signal: 'ok' } },
        }),
      ).toEqual({
        id: 'WI-1',
        completion: { summary: 's' },
        specAdequacy,
        outputPayload: { signal: 'ok' },
      });
    });

    it('hoists per-item in the bulk items:[…] form', () => {
      expect(
        hoistMisplacedCompletionFields({
          items: [
            { id: 'WI-1', completion: { summary: 'a', assumptions: ['k1'], outputPayload: { x: 1 } } },
            { id: 'WI-2', completion: { summary: 'b' } },
          ],
        }),
      ).toEqual({
        items: [
          { id: 'WI-1', completion: { summary: 'a' }, assumptions: ['k1'], outputPayload: { x: 1 } },
          { id: 'WI-2', completion: { summary: 'b' } },
        ],
      });
    });

    it('never overwrites an explicit top-level field (leaves both — a real conflict, not a shape fumble)', () => {
      const call = {
        id: 'WI-1',
        assumptions: 'none',
        completion: { summary: 's', assumptions: ['other-key'] },
      };
      expect(hoistMisplacedCompletionFields(call)).toEqual({
        id: 'WI-1',
        assumptions: 'none',
        completion: { summary: 's', assumptions: ['other-key'] },
      });
    });

    it('leaves a call with no misplaced sibling fields unchanged (same reference)', () => {
      const call = { id: 'WI-1', completion: { summary: 's' } };
      expect(hoistMisplacedCompletionFields(call)).toBe(call);
    });

    it('leaves a bare-string `completion` unchanged (nothing to hoist from a string)', () => {
      const call = { id: 'WI-1', completion: 'prose completion' };
      expect(hoistMisplacedCompletionFields(call)).toBe(call);
    });

    it('leaves a bulk call with no misplaced sibling fields unchanged (same reference)', () => {
      const call = { items: [{ id: 'WI-1', completion: { summary: 's' } }] };
      expect(hoistMisplacedCompletionFields(call)).toBe(call);
    });
  });

  describe('gatherFlatCompletion (unit)', () => {
    it('gathers flat completion fields under `completion` when there is no wrapper', () => {
      expect(gatherFlatCompletion({ id: 'WI-1', summary: 'done', whatLanded: ['a'] })).toEqual({
        id: 'WI-1',
        completion: { summary: 'done', whatLanded: ['a'] },
      });
    });

    it('gathers flat structured verification fields under `completion`', () => {
      expect(gatherFlatCompletion({ id: 'WI-1', summary: 'done', testsRun: 'vitest green', addedTests: true })).toEqual(
        {
          id: 'WI-1',
          completion: { summary: 'done', testsRun: 'vitest green', addedTests: true },
        },
      );
    });

    it('leaves a call that already has `completion` unchanged (same reference)', () => {
      const call = { id: 'WI-1', completion: { summary: 'x' } };
      expect(gatherFlatCompletion(call)).toBe(call);
    });

    it('leaves an items:[…] batch unchanged', () => {
      const call = { items: [{ id: 'WI-1', completion: { summary: 'x' } }] };
      expect(gatherFlatCompletion(call)).toBe(call);
    });

    it('does NOT gather id/harness/state — only completion fields', () => {
      expect(gatherFlatCompletion({ id: 'WI-1', harness: 'papercusp', state: 'resolved', summary: 's' })).toEqual({
        id: 'WI-1',
        harness: 'papercusp',
        state: 'resolved',
        completion: { summary: 's' },
      });
    });

    it('leaves a call with an id but no completion-ish fields unchanged', () => {
      const call = { id: 'WI-1', harness: 'papercusp' };
      expect(gatherFlatCompletion(call)).toBe(call);
    });

    describe('EI-9930: rescues flat sibling fields of an EXISTING `completion` object', () => {
      it('merges a flat top-level `tests` into an existing `completion` (the exact WI-4223 repro)', () => {
        expect(
          gatherFlatCompletion({
            id: 'WI-4223',
            state: 'done',
            completion: { summary: 'shipped' },
            tests: 'mac VM live verification passed',
          }),
        ).toEqual({
          id: 'WI-4223',
          state: 'done',
          completion: { summary: 'shipped', tests: 'mac VM live verification passed' },
        });
      });

      it('an explicit nested completion field always wins over a flat sibling (never clobbered)', () => {
        expect(
          gatherFlatCompletion({
            id: 'WI-1',
            completion: { summary: 's', tests: 'nested wins' },
            tests: 'flat loses',
          }),
        ).toEqual({
          id: 'WI-1',
          completion: { summary: 's', tests: 'nested wins' },
        });
      });

      it('a call that already has `completion` with NO flat siblings is still returned unchanged (same reference)', () => {
        const call = { id: 'WI-1', completion: { summary: 'x' } };
        expect(gatherFlatCompletion(call)).toBe(call);
      });

      // EI-13016: JSON-object strings remain objectifiable and may merge a flat sibling;
      // prose strings must stay untouched so the nested completion schema rejects them.
      it('coerces a raw JSON-string `completion` and MERGES a flat `tests` sibling into it (EI-13016)', () => {
        expect(
          gatherFlatCompletion({ id: 'WI-1', completion: JSON.stringify({ summary: 's' }), tests: 'flat' }),
        ).toEqual({
          id: 'WI-1',
          completion: { summary: 's', tests: 'flat' },
        });
      });

      it('does not rescue a prose-string `completion` with a flat `tests` sibling (WI-5069)', () => {
        const call = {
          id: 'WI-5069',
          state: 'done',
          completion: 'Completion audit prose',
          tests: '18 green',
        };
        expect(gatherFlatCompletion(call)).toBe(call);
      });

      it('an empty-string `completion` with a flat sibling is left for validation (no merge onto a non-object)', () => {
        const call = { id: 'WI-1', completion: '   ', tests: 'flat' };
        expect(gatherFlatCompletion(call)).toBe(call);
      });
    });
  });

  describe('end-to-end through the real tool schema + handler (the wire shapes that 400ed)', () => {
    beforeEach(() => {
      getWorkItem.mockResolvedValue({ ...item, id: 'WI-9', kind: 'bug', family: 'issue', state: 'open' });
      setWorkItemStateWithAliasInfo.mockResolvedValue(
        okState({ ...item, id: 'WI-9', kind: 'bug', family: 'issue', state: 'resolved' }),
      );
    });

    it('completion passed as a bare STRING is rejected with the exact structured-object example', () => {
      const result = (
        complete.args as {
          safeParse: (x: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } };
        }
      ).safeParse({
        id: 'WI-9',
        state: 'resolved',
        assumptions: 'none',
        completion: 'fixed the thing',
      });
      expect(result.success).toBe(false);
      const message = result.error?.issues.map((issue) => issue.message).join(' ') ?? '';
      expect(message).toContain(COMPLETION_STRING_REJECTION);
      expect(message).toContain(COMPLETION_OBJECT_EXAMPLE);
      expect(getWorkItem).not.toHaveBeenCalled();
    });

    it('scalar whatLanded + array tests now record', async () => {
      const r = await one({
        id: 'WI-9',
        state: 'resolved',
        completion: { summary: 's', whatLanded: 'one file', tests: ['5 green', 'vitest'] },
      });
      expect(r.completion.whatLanded).toEqual(['one file']);
      expect(r.completion.tests).toBe('5 green; vitest');
    });

    it.each(['', '   '])(
      'EI-22691088505562531: blank optional duplicateOf does not reject a non-duplicate close (%j)',
      async (duplicateOf) => {
        const r = await one({
          id: 'WI-9',
          state: 'resolved',
          completion: { summary: 's', duplicateOf },
        });
        expect(r.ok).toBe(true);
        expect(r.completion).not.toHaveProperty('duplicateOf');
        expect(resolveWorkItemRef).not.toHaveBeenCalled();
        expect(linkWorkItem).not.toHaveBeenCalled();
      },
    );

    it('a FLAT completion (fields on args, no wrapper) now records instead of tripping the refine', async () => {
      const r = await one({ id: 'WI-9', state: 'resolved', summary: 'landed flat', whatLanded: ['x.ts'] });
      expect(r.ok).toBe(true);
      expect(r.completion.summary).toBe('landed flat');
      expect(r.completion.whatLanded).toEqual(['x.ts']);
    });

    it('a completion with NO summary is derived, not rejected', async () => {
      const r = await one({ id: 'WI-9', state: 'resolved', completion: { title: 'Guard fix', whatLanded: ['g.ts'] } });
      expect(r.ok).toBe(true);
      expect(r.completion.summary).toBe('Guard fix');
    });

    it('a well-formed call is unaffected by the coercion path', async () => {
      const r = await one({ id: 'WI-9', state: 'resolved', completion: { summary: 'clean', whatLanded: ['a.ts'] } });
      expect(r.completion.summary).toBe('clean');
      expect(r.completion.whatLanded).toEqual(['a.ts']);
    });

    it('accepts a descriptive verifiedHow label in nested verification evidence', async () => {
      const r = await one({
        id: 'WI-9',
        state: 'resolved',
        completion: {
          summary: 'verified the desktop shell behavior',
          verification: {
            verifiedHow: 'macOS Tauri smoke observed in the running shell',
            testResult: 'the changed flow rendered and responded as expected',
          },
        },
      });
      expect(r.ok).toBe(true);
      expect(r.completion.verification.verifiedHow).toBe('macOS Tauri smoke observed in the running shell');
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
        'WI-9',
        'resolved',
        expect.objectContaining({
          completionEvidence: expect.objectContaining({
            verifiedHow: 'macOS Tauri smoke observed in the running shell',
            testResult: 'the changed flow rendered and responded as expected',
          }),
        }),
      );
    });

    it('accepts a descriptive verifiedHow label through the legacy top-level alias', async () => {
      const r = await one({
        id: 'WI-9',
        state: 'resolved',
        completion: {
          summary: 'verified the API behavior',
          verifiedHow: 'staging API replay with authenticated owner session',
          testResult: 'HTTP 200 and terminal state were observed on the replay',
        },
      });
      expect(r.ok).toBe(true);
      expect(r.completion.verifiedHow).toBe('staging API replay with authenticated owner session');
      expect(r.completionAuthority).toBe('committed');
    });

    // EI-9930: a flat `tests` sibling of an existing `completion` used to be silently
    // dropped by the schema's default key-stripping (no unknown-arg error), so the
    // completion recorded with neither `tests` nor `deferred` and tripped a false
    // verificationWarning even though the caller DID state how it was verified
    // (repro: WI-4223, 2026-07-12 — two consecutive `complete` calls, identical warning,
    // the second call had `tests` populated but outside the `completion` wrapper).
    it('a flat top-level `tests` sibling of `completion` is rescued — no false verificationWarning (EI-9930)', async () => {
      const r = await one({
        id: 'WI-9',
        state: 'resolved',
        completion: { summary: 'shipped' },
        tests: 'mac VM live verification passed',
      });
      expect(r.ok).toBe(true);
      expect(r.completion.tests).toBe('mac VM live verification passed');
      expect(r.verificationWarning).toBeUndefined();
    });

    // EI-13016 / WI-39573: a flat sibling must not turn a prose completion into a
    // structured record. gatherFlatCompletion leaves the original call intact, so
    // strict parsing reports both the invalid completion value and any misplaced sibling.
    it('a flat top-level `tests` sibling cannot rescue a bare-STRING `completion`', () => {
      const result = (
        complete.args as {
          safeParse: (x: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } };
        }
      ).safeParse({
        id: 'WI-9',
        state: 'resolved',
        assumptions: 'none',
        completion: 'Completion audit — everything verified in tree and deploy.',
        tests: 'npm run test:file — 154 green (exit 0)',
      });
      expect(result.success).toBe(false);
      const message = result.error?.issues.map((issue) => issue.message).join(' ') ?? '';
      expect(message).toContain(COMPLETION_STRING_REJECTION);
      expect(getWorkItem).not.toHaveBeenCalled();
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    // EI-6999: a shape with NEITHER `completion` NOR any recognizable flat
    // completion field (gatherFlatCompletion has nothing to rescue) must fail
    // with the FULL minimal closing shape up front — not just "you're missing
    // `completion`" — so a caller doesn't need 3+ round-trips to discover
    // `completion.summary` and `state` are both required to actually close.
    //
    // EI-18723223344390510: this case used to ALSO pass an unrecognized `note`
    // key alongside `id` — before the deep-strictify fix, the tool's top-level
    // schema (a `z.preprocess(gatherFlatCompletion, ...)` pipe) escaped
    // `strictArgs`'s (then shallow) `.strict()` entirely, since a pipe has no
    // `.strict()` method, so `note` was silently tolerated and only the
    // `.refine()` custom message ever surfaced. Now that the whole schema tree
    // is strictified, an unrecognized top-level key correctly fails FIRST
    // (Zod's built-in strict-mode check runs before an object's `.refine()`),
    // which is the right behavior but a DIFFERENT one from what this test was
    // isolating — so the stray key is dropped here (covered by its own test
    // below) and this case now tests the "no completion at all" shape in
    // isolation, with no unrecognized-key noise to compete with the assertion.
    it('a shape with no completion at all states the FULL minimal closing contract in ONE error', () => {
      const result = (
        complete.args as {
          safeParse: (x: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } };
        }
      ).safeParse({ id: 'WI-1' });
      expect(result.success).toBe(false);
      const message = result.error?.issues.map((i) => i.message).join(' ') ?? '';
      expect(message).toContain('{ id, state, assumptions: "none"|[fact keys], completion: { summary } }');
      expect(message).toContain('state');
      expect(message).toContain('REQUIRED');
      expect(message).toContain('assumptions');
      expect(message).toContain('"none"');
    });

    // EI-18723223344390510: the deep-strictify fix closes the SAME EI-10883
    // "unrecognized key silently dropped" gap for THIS tool's top-level schema —
    // it was escaping strictArgs' (then shallow) `.strict()` because its outer
    // schema is a `z.preprocess(...)` pipe, not a bare object. A confused
    // caller sending a free-text `note` instead of a real `completion` (the
    // exact EI-6999 scenario) now gets told the key is unrecognized, rather
    // than having it silently dropped and getting only the generic
    // missing-completion message.
    it('rejects an unrecognized top-level key instead of silently dropping it (EI-18723223344390510)', () => {
      const result = (
        complete.args as {
          safeParse: (x: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } };
        }
      ).safeParse({ id: 'WI-1', note: 'just a note, not a completion' });
      expect(result.success).toBe(false);
      const message = result.error?.issues.map((i) => i.message).join(' ') ?? '';
      expect(message.toLowerCase()).toContain('unrecognized');
      expect(message).toContain('note');
    });

    it('accepts persisted checkpoint metadata on retry but still rejects unrelated completion keys (EI-21582975345203826)', () => {
      const retry = (complete.args as { safeParse: (x: unknown) => { success: boolean; data?: any } }).safeParse({
        id: 'EI-21582975345203826',
        completion: {
          summary: 'retry stored evidence',
          testsRun: 'focused completion test',
          checkpointChecksCarried: [{ claim: 'the checkpoint was checked' }],
          checkpointProseSnapshot: '## Did\nserver-generated prose',
        },
      });
      expect(retry.success).toBe(true);
      expect(retry.data.completion).toMatchObject({
        summary: 'retry stored evidence',
        testsRun: 'focused completion test',
      });
      expect(retry.data.completion).not.toHaveProperty('checkpointChecksCarried');
      expect(retry.data.completion).not.toHaveProperty('checkpointProseSnapshot');

      const unrelated = (
        complete.args as {
          safeParse: (x: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } };
        }
      ).safeParse({
        id: 'EI-21582975345203826',
        completion: {
          summary: 'retry stored evidence',
          unrelatedField: 'must remain rejected',
        },
      });
      expect(unrelated.success).toBe(false);
      expect(
        unrelated.error?.issues
          .map((issue) => issue.message)
          .join(' ')
          .toLowerCase(),
      ).toContain('unrecognized');
      expect(unrelated.error?.issues.map((issue) => issue.message).join(' ')).toContain('unrelatedField');
    });
  });

  // ── EI-18661904412177717: the BATCH form must honour the top-level `state` ───────────────
  // The batch path defaulted `harness` from the top level but SILENTLY DROPPED `state`, so
  // `{ state:'resolved', items:[…] }` recorded every completion, returned ok:true, and left
  // every item `wip`/claimable — while each stateWarning instructed the caller to "pass
  // top-level `state`", the exact thing they had just passed (so the natural next move is to
  // re-send the identical call and get the identical result; the reporter did, twice). The
  // real cost is not the wasted round-trips: an agent that trusts ok:true and does not re-read
  // `state` believes a batch is closed when it is all still claimable, and the auto-loop
  // re-places finished work — a silent correctness failure in the completion-integrity path.
  //
  // Asserted on the RE-READ state (what actually landed), never on `ok` — the whole failure
  // mode was ok:true over unclosed items, so `ok` is precisely the signal that could not
  // detect it.
  describe('EI-18661904412177717 — batch items:[…] honours the top-level `state`', () => {
    const issue = { kind: 'bug', family: 'issue', state: 'wip', harness: 'papercup' };

    beforeEach(() => {
      getWorkItem.mockImplementation(async (id: string) => ({ ...issue, id }));
      // Mirrors the real issue-family alias layer: resolved → the unified terminal 'done'.
      setWorkItemStateWithAliasInfo.mockImplementation(async (id: string, state: string) => ({
        workItem: { ...issue, id, state: state === 'resolved' ? 'done' : state },
        aliased: state === 'resolved',
        requestedState: state,
        appliedState: state === 'resolved' ? 'done' : state,
      }));
    });

    it('applies the top-level terminal `state` to EVERY item that omits its own — items land terminal, not wip', async () => {
      const out = await env({
        harness: 'papercup',
        state: 'resolved',
        items: [
          { id: 'WI-5794', completion: { summary: 'a', tests: '3 green' } },
          { id: 'WI-5795', completion: { summary: 'b', tests: '3 green' } },
          { id: 'WI-5796', completion: { summary: 'c', tests: '3 green' } },
        ],
      });

      // The state write actually ran for each item, with the top-level state.
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledTimes(3);
      for (const id of ['WI-5794', 'WI-5795', 'WI-5796']) {
        expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
          id,
          'resolved',
          expect.objectContaining({ by: expect.any(String) }),
        );
      }
      // THE ASSERTION THAT MATTERS: the re-read state of every item is terminal.
      expect(out.results.map((r: { workItem: { state: string } }) => r.workItem.state)).toEqual([
        'done',
        'done',
        'done',
      ]);
      // …and no item is left telling the caller to pass the state they already passed.
      expect(out.results.map((r: { stateWarning?: string }) => r.stateWarning)).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
      expect(out.counts).toEqual({ ok: 3, failed: 0 });
    });

    it('a per-item `state` still WINS over the top-level default (the default never clobbers an explicit choice)', async () => {
      const out = await env({
        harness: 'papercup',
        state: 'resolved',
        items: [
          { id: 'WI-1', completion: { summary: 'a', tests: 'x' } },
          { id: 'WI-2', state: 'closed', completion: { summary: 'b', tests: 'x' } },
        ],
      });
      expect(setWorkItemStateWithAliasInfo).toHaveBeenNthCalledWith(1, 'WI-1', 'resolved', expect.anything());
      expect(setWorkItemStateWithAliasInfo).toHaveBeenNthCalledWith(2, 'WI-2', 'closed', expect.anything());
      expect(out.results.map((r: { workItem: { state: string } }) => r.workItem.state)).toEqual(['done', 'closed']);
    });

    it('a batch with NO state anywhere still records-only (unchanged) — the default is opt-in, not an auto-close', async () => {
      const out = await env({
        harness: 'papercup',
        items: [{ id: 'WI-1', completion: { summary: 'progress note' } }],
      });
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(out.results[0].workItem.state).toBe('wip');
      expect(out.results[0].stateWarning).toMatch(/No top-level `state` was passed/);
    });
  });

  // ── EI-18661904412177717 (second half): the warning must distinguish "you passed no state"
  // from "your state was not applied". A warning that prescribes the action the caller ALREADY
  // took routes them into a re-send loop instead of at the real cause.
  describe('EI-18661904412177717 — stateWarning distinguishes no-state from state-not-applied', () => {
    const issue = { id: 'WI-1', kind: 'bug', family: 'issue', state: 'open', harness: 'papercup' };

    it('NO state passed: says so explicitly and tells the caller to pass one', async () => {
      getWorkItem.mockResolvedValue(issue);
      const r = await one({ id: 'WI-1', completion: { summary: 'note' } });
      expect(r.stateWarning).toMatch(/No top-level `state` was passed/);
      expect(r.stateWarning).toMatch(/Pass top-level `state`/);
    });

    it('state passed but landed NON-TERMINAL: says it was received, and does NOT tell the caller to re-send it', async () => {
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockImplementation(async (_id: string, state: string) => ({
        workItem: { ...issue, state: 'open' },
        aliased: true,
        requestedState: state,
        appliedState: 'open',
        aliasNote: `requested state '${state}' aliased to 'open'.`,
      }));
      const r = await one({ id: 'WI-1', state: 'needs_human', completion: { summary: 'needs an owner call' } });
      expect(r.stateWarning).toMatch(/Your state 'needs_human' WAS received and applied as 'open'/);
      expect(r.stateWarning).toMatch(/Do NOT re-send the same value/);
      expect(r.stateWarning).not.toMatch(/No top-level `state` was passed/);
    });

    it('state passed but the write THREW: names the rejection instead of asking for the same state again', async () => {
      getWorkItem.mockResolvedValue(issue);
      setWorkItemStateWithAliasInfo.mockRejectedValue(new Error("cannot take state 'bogus'"));
      const r = await one({ id: 'WI-1', state: 'bogus', completion: { summary: 'landed; bad vocab' } });
      expect(r.stateWarning).toMatch(/was REJECTED by the state write: cannot take state 'bogus'/);
      expect(r.stateWarning).toMatch(/Re-sending the same state will fail the same way/);
      expect(r.stateWarning).not.toMatch(/No top-level `state` was passed/);
    });
  });

  describe('conditional assumptions gate (D-004 record-only vs terminal close)', () => {
    const openIssue = { ...item, id: 'WI-1', family: 'issue', state: 'open' };

    it('accepts a direct record-only completion without assumptions', async () => {
      getWorkItem.mockResolvedValue(openIssue);

      const r = await oneRaw({ id: 'WI-1', recordOnly: true, completion: { summary: 'progress note' } });

      expect(r.ok).toBe(true);
      expect(r.error).toBeUndefined();
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    it('rejects a direct terminal close without assumptions before writing state', async () => {
      getWorkItem.mockResolvedValue(openIssue);

      const r = await oneRaw({ id: 'WI-1', state: 'resolved', completion: { summary: 'closed' } });

      expect(r.ok).toBe(false);
      expect(r.error).toContain('a terminal close requires `assumptions`');
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    it('accepts the documented `assumptions: "none"` on the direct path just like items[]', async () => {
      getWorkItem.mockResolvedValue(openIssue);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...openIssue, state: 'resolved' }));

      const direct = await oneRaw({
        id: 'WI-1',
        state: 'resolved',
        assumptions: 'none',
        completion: { summary: 'closed' },
      });
      const bulk = await envRaw({
        items: [
          {
            id: 'WI-1',
            state: 'resolved',
            assumptions: 'none',
            completion: { summary: 'closed' },
          },
        ],
      });

      expect(direct.ok).toBe(true);
      expect(bulk.ok).toBe(true);
      expect(bulk.results[0].ok).toBe(true);
      expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledTimes(2);
    });

    it('applies the same gate to an inferred issue terminal close', async () => {
      getWorkItem.mockResolvedValue(openIssue);

      const r = await oneRaw({ id: 'WI-1', completion: { summary: 'closed', status: 'resolved' } });

      expect(r.ok).toBe(false);
      expect(r.error).toContain('a terminal close requires `assumptions`');
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });
  });

  describe('cross-phase assumptions hint (EI-19486111655110215)', () => {
    // The gate above is enforced at HANDLER time, one phase after the schema, because it is
    // conditional on a post-parse value (see the ⚠ block over `args` in complete.ts — the
    // conditionality must NOT be moved into the schema). The cost was a per-phase refusal
    // loop: fix the schema error, get refused again for `assumptions`. `argPreconditions`
    // lets the FIRST refusal also say what the second one would. It does not move the gate,
    // so every test in the describe above must keep passing unchanged.
    const preconditions = (raw: unknown): readonly string[] =>
      (complete as unknown as { argPreconditions: (raw: unknown) => readonly string[] }).argPreconditions(raw);

    it('is actually declared on the built tool — a dropped field type-checks and does nothing', () => {
      // EI-22172195473893352: `argReencodings` shipped inert exactly this way.
      expect(typeof (complete as unknown as { argPreconditions?: unknown }).argPreconditions).toBe('function');
    });

    it('names the assumptions requirement for a direct terminal close that omits it', () => {
      expect(preconditions({ id: 'WI-1', state: 'resolved', completion: { summary: 'x' } })).toEqual([
        expect.stringContaining('a terminal close requires `assumptions`'),
      ]);
    });

    it('names it for an inferred issue close carried by completion.status alone', () => {
      expect(preconditions({ id: 'WI-1', completion: { summary: 'x', status: 'resolved' } })).toHaveLength(1);
    });

    it('names it for a bulk items[] close, including one inheriting the top-level state', () => {
      expect(preconditions({ state: 'resolved', items: [{ id: 'WI-1', completion: { summary: 'x' } }] })).toHaveLength(
        1,
      );
      expect(preconditions({ items: [{ id: 'WI-1', state: 'done', completion: { summary: 'x' } }] })).toHaveLength(1);
    });

    // CONTROLS — a hook that fired unconditionally would pass every assertion above while
    // teaching a requirement the caller had already met, on calls that are not closes at all.
    it('stays silent when assumptions is present, at either level', () => {
      expect(preconditions({ id: 'WI-1', state: 'resolved', assumptions: 'none' })).toEqual([]);
      expect(preconditions({ state: 'resolved', assumptions: 'none', items: [{ id: 'WI-1' }] })).toEqual([]);
      expect(preconditions({ items: [{ id: 'WI-1', state: 'resolved', assumptions: ['k'] }] })).toEqual([]);
    });

    it('stays silent for a D-004 record-only completion — the case the gate must never touch', () => {
      expect(preconditions({ id: 'WI-1', completion: { summary: 'progress note' } })).toEqual([]);
      expect(preconditions({ id: 'WI-1', state: 'wip', completion: { summary: 'progress note' } })).toEqual([]);
    });

    it('is total: never throws on the unvalidated shapes it exists to see', () => {
      for (const raw of [null, undefined, 'string', 42, [], { items: 'not-an-array' }, { items: [null, 7] }, {}]) {
        expect(() => preconditions(raw)).not.toThrow();
      }
    });

    // EI-21314040234920121 + duplicate EI-21562711070130195: both read a treeStamp PATTERN
    // refusal and concluded the 40/64-hex rule should be loosened. It must not be — the stamp
    // anchors content identity for the committed-vs-proposed gate — but the caller was never
    // meant to send the field at all, and the refusal never said so.
    const treeStampHint = expect.stringContaining('SERVER-STAMPED');

    it('names the caller-omit rule when treeStamp is sent nested under verification', () => {
      expect(
        preconditions({
          id: 'WI-1',
          completion: { summary: 'x', verification: { treeStamp: { headSha: '6eb7137' } } },
        }),
      ).toEqual([treeStampHint]);
    });

    it('names it for a top-level completion.treeStamp and inside an items[] entry', () => {
      expect(preconditions({ id: 'WI-1', completion: { summary: 'x', treeStamp: { headSha: 'abc' } } })).toEqual([
        treeStampHint,
      ]);
      expect(
        preconditions({
          items: [
            { id: 'WI-1', completion: { summary: 'clean' } },
            { id: 'WI-2', completion: { summary: 'x', verification: { treeStamp: { headSha: 'abc' } } } },
          ],
        }),
      ).toEqual([treeStampHint]);
    });

    it('fires on PRESENCE, not on a malformed SHA — a well-formed stamp is overwritten just as silently', () => {
      // The whole defect is that the caller is sending a field the server discards. A stamp
      // that happens to parse is the case NO refusal would ever reach, so it must still warn.
      expect(
        preconditions({
          id: 'WI-1',
          completion: { summary: 'x', verification: { treeStamp: { headSha: 'a'.repeat(40) } } },
        }),
      ).toEqual([treeStampHint]);
    });

    it('emits BOTH lines when a terminal close also sends a stamp, assumptions first', () => {
      expect(
        preconditions({
          id: 'WI-1',
          state: 'resolved',
          completion: { summary: 'x', verification: { treeStamp: { headSha: '6eb7137' } } },
        }),
      ).toEqual([expect.stringContaining('a terminal close requires `assumptions`'), treeStampHint]);
    });

    const settlementManifestHint = expect.stringContaining('settlementManifest');

    it('names the caller-omit rule for direct completion.settlementManifest', () => {
      expect(
        preconditions({
          id: 'WI-1',
          completion: { summary: 'x', settlementManifest: { schemaVersion: 1 } },
        }),
      ).toEqual([settlementManifestHint]);
    });

    it('names it for nested verification.settlementManifest and an items[] entry', () => {
      expect(
        preconditions({
          id: 'WI-1',
          completion: { summary: 'x', verification: { settlementManifest: {} } },
        }),
      ).toEqual([settlementManifestHint]);
      expect(
        preconditions({
          items: [
            { id: 'WI-1', completion: { summary: 'clean' } },
            { id: 'WI-2', completion: { summary: 'x', verification: { settlementManifest: {} } } },
          ],
        }),
      ).toEqual([settlementManifestHint]);
    });

    it('warns on a well-formed settlement manifest too — presence, not schema shape, is the rule', () => {
      const manifest = {
        version: 1,
        generation: 1,
        evidenceHash: 'c'.repeat(64),
        repositoryRoot: '/repo',
        headSha: 'a'.repeat(40),
        normalizedPaths: ['src/fix.ts'],
        contentIdentity: [{ path: 'src/fix.ts', workingTreeBlobSha: 'b'.repeat(40), headBlobSha: 'b'.repeat(40) }],
      };
      expect(
        preconditions({
          id: 'WI-1',
          completion: { summary: 'x', verification: { settlementManifest: manifest } },
        }),
      ).toEqual([settlementManifestHint]);
    });

    it('emits BOTH lines when a terminal close also sends settlementManifest, assumptions first', () => {
      expect(
        preconditions({
          id: 'WI-1',
          state: 'resolved',
          completion: { summary: 'x', verification: { settlementManifest: {} } },
        }),
      ).toEqual([expect.stringContaining('a terminal close requires `assumptions`'), settlementManifestHint]);
    });

    // CONTROLS — these must not be rewritten to accommodate a future change. They are what
    // make the assertions above falsifiable: a detector that fired on any `completion` at all,
    // or on any key merely containing "treeStamp", would pass every test above and fail these.
    it('stays silent for completions that send no stamp at all', () => {
      expect(
        preconditions({ id: 'WI-1', completion: { summary: 'x', verification: { filesChanged: ['a.ts'] } } }),
      ).toEqual([]);
      expect(preconditions({ id: 'WI-1', completion: { summary: 'x', verification: {} } })).toEqual([]);
      expect(preconditions({ id: 'WI-1', completion: { summary: 'mentions treeStamp in prose only' } })).toEqual([]);
    });

    it('stays silent for settlementManifest prose and unrelated verification evidence', () => {
      expect(
        preconditions({ id: 'WI-1', completion: { summary: 'settlementManifest is server-generated' } }),
      ).toEqual([]);
      expect(
        preconditions({ id: 'WI-1', completion: { summary: 'x', verification: { filesChanged: ['a.ts'] } } }),
      ).toEqual([]);
    });

    it('is total against the malformed shapes this detector newly reaches into', () => {
      for (const raw of [
        { id: 'WI-1', completion: 'a bare string completion' },
        { id: 'WI-1', completion: ['array'] },
        { id: 'WI-1', completion: { verification: 'not-an-object' } },
        { id: 'WI-1', completion: { verification: ['array'] } },
        { id: 'WI-1', completion: null },
      ]) {
        expect(() => preconditions(raw)).not.toThrow();
        expect(preconditions(raw)).toEqual([]);
      }
    });
  });

  describe('published JSON schema (tools/list projection) preserves conditional assumptions', () => {
    it('still advertises id / completion / items in both single and bulk object branches', () => {
      const json = z.toJSONSchema(complete.args as never) as {
        anyOf?: Array<{ properties?: Record<string, unknown> }>;
        oneOf?: Array<{ properties?: Record<string, unknown> }>;
      };
      const branches = json.anyOf ?? json.oneOf ?? [];
      expect(branches).toHaveLength(2);
      for (const branch of branches) {
        expect(branch.properties).toHaveProperty('id');
        expect(branch.properties).toHaveProperty('completion');
        expect(branch.properties).toHaveProperty('items');
      }
    });

    // WI-10005648: this tool alone seats ~10 KB of the 100 KB tool-delivery floor. Four nested
    // records (verification, rootCauseVerification, coverage, selfReview) were published TWICE —
    // once inside the `completion` $defs record and again, in full, as flat root aliases —
    // which pushed the floor 3,428 B over budget and reded psu-launcher's budgetOverrun gate.
    // The root alias must stay a POINTER; the typed shape lives under `completion`.
    it('publishes the heavy nested completion records once, under completion, not again as root aliases (WI-10005648)', () => {
      const json = z.toJSONSchema(complete.args as never) as JsonSchemaDocument & {
        anyOf?: Array<{ properties?: Record<string, unknown> }>;
        oneOf?: Array<{ properties?: Record<string, unknown> }>;
      };
      const branches = json.anyOf ?? json.oneOf ?? [];
      const single = branches.find((branch) => Boolean(branch.properties?.id));
      expect(single).toBeDefined();

      const record = resolveLocalSchemaRef(json, single?.properties?.completion) as {
        properties?: Record<string, { properties?: unknown; $ref?: string }>;
      };
      for (const field of ['verification', 'rootCauseVerification', 'coverage', 'selfReview']) {
        const alias = resolveLocalSchemaRef(json, single?.properties?.[field]) as {
          type?: unknown;
          properties?: unknown;
        };
        // Still a published, object-typed key (the single-item flat-alias contract) ...
        expect(alias.type, `root alias ${field} must stay object-typed`).toBe('object');
        // ... but a pointer, never a second copy of the record.
        expect(alias.properties, `root alias ${field} must not re-publish its record`).toBeUndefined();
        expect(JSON.stringify(alias).length, `root alias ${field} grew past a pointer`).toBeLessThan(300);

        // The typed shape is still published exactly where the pointer says it is.
        const typed = resolveLocalSchemaRef(json, record.properties?.[field]) as { properties?: unknown };
        expect(typed.properties, `completion.${field} must carry the typed shape`).toBeDefined();
      }
    });

    it('publishes the single-item flat aliases that preprocessing accepts', () => {
      const json = z.toJSONSchema(complete.args as never) as {
        anyOf?: Array<{ properties?: Record<string, unknown> }>;
        oneOf?: Array<{ properties?: Record<string, unknown> }>;
      };
      const branches = json.anyOf ?? json.oneOf ?? [];
      const bulk = branches.find(
        (branch) => (branch.properties?.items as { type?: unknown } | undefined)?.type === 'array',
      );
      const single = branches.find((branch) => branch !== bulk);

      expect(single).toBeDefined();
      for (const field of COMPLETION_FIELDS) {
        expect(single?.properties).toHaveProperty(field);
      }
      expect(single?.properties).not.toHaveProperty('workOutcome');
      expect(bulk?.properties).not.toHaveProperty('tests');

      const invalid = (
        complete.args as {
          safeParse: (x: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } };
        }
      ).safeParse({
        id: 'WI-1',
        state: 'resolved',
        assumptions: 'none',
        completion: { summary: 'the completion was checked' },
        workOutcome: 'other-no-new-change',
        tests: 'the focused check passed',
      });
      expect(invalid.success).toBe(false);
      const message = invalid.error?.issues.map((issue) => issue.message).join(' ') ?? '';
      expect(message).toContain('workOutcome');
      expect(message).not.toContain('tests');

      const corrected = (
        complete.args as { safeParse: (x: unknown) => { success: boolean } }
      ).safeParse({
        id: 'WI-1',
        state: 'resolved',
        assumptions: 'none',
        completion: {
          summary: 'the completion was checked',
          verification: { workOutcome: 'other-no-new-change' },
        },
        tests: 'the focused check passed',
      });
      expect(corrected.success).toBe(true);
    });

    it('lists accepted flat aliases beside a corrected call at projected dispatch', async () => {
      const projected = lookupByMcpName('work_items:complete');
      expect(projected).toBeTruthy();
      const d = await dispatchProjectedTool(
        projected!,
        'work_items:complete',
        {
          id: 'WI-1',
          harness: 'papercusp',
          state: 'resolved',
          assumptions: 'none',
          completion: { summary: 'the completion was checked' },
          tests: 'the focused check passed',
          verifiedHow: 'focused local test run',
          workOutcome: 'other-no-new-change',
        },
        {
          log: vi.fn(),
          signal: new AbortController().signal,
          progress: vi.fn(),
          emit: vi.fn(),
          metadata: vi.fn(),
          workspaceId: 'default',
          harnessSlug: 'papercusp',
          runId: 'complete-alias-refusal',
          role: 'su',
          gateBypass: { role: true, capability: true, quota: true },
          transport: 'mcp',
          requestedFormat: 'json',
          requestedStructured: true,
        } as never,
        {},
      );

      expect(d.ok).toBe(false);
      expect(d.error?.code).toBe('invalid_input');
      const message = d.error?.message ?? '';
      expect(message).toMatch(/corrected call/i);
      const accepted = (message.split('this tool accepts ONLY:')[1] ?? '').split('. ')[0] ?? '';
      expect(accepted).toContain('tests');
      expect(accepted).toContain('verifiedHow');
      expect(accepted).not.toContain('workOutcome');
    });

    it('publishes the shared completion schema once via defs and refs (EI-23318249512516833)', () => {
      const json = z.toJSONSchema(complete.args as never, { io: 'input' }) as {
        $defs?: Record<string, JsonSchemaNode>;
        anyOf?: Array<{
          properties?: {
            completion?: { $ref?: string };
            items?: { items?: { properties?: { completion?: { $ref?: string } } } };
          };
        }>;
        oneOf?: Array<{
          properties?: {
            completion?: { $ref?: string };
            items?: { items?: { properties?: { completion?: { $ref?: string } } } };
          };
        }>;
      };
      const branches = json.anyOf ?? json.oneOf ?? [];
      const completionRef = '#/$defs/wi-completion';

      expect(json.$defs).toHaveProperty('wi-completion');
      expect(json.$defs).toHaveProperty('wi-coverage');
      expect(json.$defs!['wi-coverage']).toHaveProperty('x-papercusp-call-constraint');
      expect(json.$defs).toHaveProperty('wi-assumptions');
      const record = json.$defs!['wi-completion'] as {
        properties: { coverage: { $ref: string }; verification: { properties: { coverage: { $ref: string } } } };
      };
      const coverageRef = '#/$defs/wi-coverage';
      expect(record.properties.coverage.$ref).toBe(coverageRef);
      expect(record.properties.verification.properties.coverage.$ref).toBe(coverageRef);
      expect(branches).toHaveLength(2);
      for (const branch of branches) expect(branch.properties?.completion?.$ref).toBe(completionRef);
      const bulkBranch = branches.find(
        (branch) => (branch.properties?.items as { type?: unknown } | undefined)?.type === 'array',
      );
      expect(bulkBranch?.properties?.items?.items?.properties?.completion?.$ref).toBe(completionRef);
      for (const branch of branches) {
        expect((branch.properties as Record<string, { $ref?: string }>).assumptions.$ref).toBe('#/$defs/wi-assumptions');
      }
      expect((bulkBranch?.properties?.items?.items?.properties as Record<string, { $ref?: string }>).assumptions.$ref)
        .toBe('#/$defs/wi-assumptions');
    });

    it('documents that assumptions are required only for terminal closes', () => {
      const json = z.toJSONSchema(complete.args as never) as {
        $defs?: Record<string, JsonSchemaNode>;
        anyOf?: Array<{ required?: string[]; properties?: Record<string, { description?: string }> }>;
        oneOf?: Array<{ required?: string[]; properties?: Record<string, { description?: string }> }>;
      };
      const branches = json.anyOf ?? json.oneOf ?? [];
      const descriptions = branches.map((branch) => resolveLocalSchemaRef(json, branch.properties?.assumptions).description ?? '').join('\n');
      expect(descriptions).toContain('terminal close');
      expect(descriptions).toContain('record-only');
    });

    it('publishes completion.status as optional while retaining the runtime done default', () => {
      const json = z.toJSONSchema(complete.args as never) as {
        $defs?: Record<string, JsonSchemaNode>;
        anyOf?: Array<{ properties?: Record<string, { required?: string[] }> }>;
        oneOf?: Array<{ properties?: Record<string, { required?: string[] }> }>;
      };
      const branches = json.anyOf ?? json.oneOf ?? [];
      const completionSchemas = branches
        .map((branch) => resolveLocalSchemaRef(json, branch.properties?.completion))
        .filter(Boolean);

      expect(completionSchemas).toHaveLength(2);
      for (const schema of completionSchemas) {
        expect(schema?.required ?? []).not.toContain('status');
      }

      const parsed = (complete.args as { safeParse: (x: unknown) => { success: boolean; data?: any } }).safeParse({
        id: 'WI-1',
        completion: { summary: 'progress note' },
      });
      expect(parsed.success).toBe(true);
      expect(parsed.data?.completion?.status).toBe('done');
    });

    it('documents the live evidence requirements in both published branches', () => {
      const json = z.toJSONSchema(complete.args as never) as {
        $defs?: Record<string, JsonSchemaNode>;
        anyOf?: Array<{ properties?: Record<string, { description?: string }> }>;
        oneOf?: Array<{ properties?: Record<string, { description?: string }> }>;
      };
      const branches = json.anyOf ?? json.oneOf ?? [];
      const descriptions = branches.map(
        (branch) => String(resolveLocalSchemaRef(json, branch.properties?.completion).description ?? ''),
      );

      expect(descriptions).toHaveLength(2);
      for (const description of descriptions) {
        expect(description).toContain("verifiedHow:'live-drove-ui'");
        expect(description).toContain('real artifact citation');
        expect(description).toContain('summary');
        expect(description).toContain('testsRun');
        expect(description).toContain('testResult');
        expect(description).toContain('filesChanged');
        expect(description).toContain('tauri-agent-tools');
        expect(description).toContain("verifiedHow:'live-service'");
        expect(description).toContain('concrete service/unit/process');
        expect(description).toContain('MainPID');
        expect(description).toContain('NRestarts');
        expect(description).toContain('ActiveState');
        expect(description).toContain('HTTP status');
      }
    });

    it('accepts record-only single and bulk calls while retaining per-item close declarations', () => {
      const json = z.toJSONSchema(complete.args as never) as {
        anyOf?: Array<{ required?: string[]; properties?: Record<string, unknown> }>;
        oneOf?: Array<{ required?: string[]; properties?: Record<string, unknown> }>;
      };
      const branches = json.anyOf ?? json.oneOf ?? [];
      // The single branch retains an optional `items: never` discriminator so
      // the handler can keep a uniform parsed type. Distinguish it from the
      // bulk branch by the array shape, not by property presence.
      const isBulkBranch = (branch: (typeof branches)[number]) =>
        (branch.properties?.items as { type?: unknown } | undefined)?.type === 'array';
      const single = branches.find((branch) => !isBulkBranch(branch));
      const bulk = branches.find(isBulkBranch);

      expect(branches).toHaveLength(2);
      expect(single?.required ?? []).not.toContain('assumptions');
      expect(single?.properties).toHaveProperty('completion');
      expect(bulk?.required).toContain('items');

      const recordOnly = (complete.args as { safeParse: (x: unknown) => { success: boolean } }).safeParse({
        id: 'WI-1',
        completion: { summary: 'progress note' },
      });
      expect(recordOnly.success).toBe(true);

      // Presence is conditional on lifecycle intent, so the handler (not zod) owns
      // the terminal-close refusal after status inference and top-level state fallback.
      const terminalWithoutAssumptions = (
        complete.args as { safeParse: (x: unknown) => { success: boolean } }
      ).safeParse({
        id: 'WI-1',
        state: 'resolved',
        completion: { summary: 'fixed' },
      });
      expect(terminalWithoutAssumptions.success).toBe(true);

      const bulkRecordOnly = (complete.args as { safeParse: (x: unknown) => { success: boolean } }).safeParse({
        items: [{ id: 'WI-1', completion: { summary: 'progress note' } }],
      });
      expect(bulkRecordOnly.success).toBe(true);

      const bulkWithPerItemAssumptions = (
        complete.args as { safeParse: (x: unknown) => { success: boolean } }
      ).safeParse({
        items: [{ id: 'WI-1', state: 'resolved', assumptions: 'none', completion: { summary: 'fixed' } }],
      });
      expect(bulkWithPerItemAssumptions.success).toBe(true);
    });

    it('documents nested verification evidence and the legacy top-level aliases (EI-20224652919070419)', () => {
      const description = (complete as { description?: string }).description ?? '';
      const when = (complete as { guidance?: { when?: string } }).guidance?.when ?? '';
      const json = z.toJSONSchema(complete.args as never) as {
        $defs?: Record<string, JsonSchemaNode>;
        anyOf?: Array<{ properties?: { completion?: unknown } }>;
        oneOf?: Array<{ properties?: { completion?: unknown } }>;
      };
      const branches = json.anyOf ?? json.oneOf ?? [];
      const completionSchema = branches.map((branch) =>
        resolveLocalSchemaRef(json, branch.properties?.completion),
      );
      const text = `${description}\n${when}\n${JSON.stringify(completionSchema)}`;

      expect(text).toContain('completion.verification');
      expect(text).toContain('`testsRun`, `testResult`, `verifiedHow`, and `filesChanged` at the root of `completion`');
      expect(text).toContain('single-item call also accepts those fields at the argument root as legacy aliases');
      expect(text).toContain('verification.tests');
      expect(text).toContain('verification.typecheck');
      expect(text).toContain('verification.diff');
      expect(text).toContain('deferred');
      expect(text).toContain('coordNotes');
      expect(text).toContain('not inside');
    });

    it('publishes the flat coordNotes alias as a string and rejects object-shaped notes', () => {
      const json = z.toJSONSchema(complete.args as never) as JsonSchemaDocument & {
        anyOf?: Array<{ properties?: Record<string, unknown> }>;
        oneOf?: Array<{ properties?: Record<string, unknown> }>;
      };
      const branches = json.anyOf ?? json.oneOf ?? [];
      const single = branches.find((branch) => Boolean(branch.properties?.id));
      const coordNotes = resolveLocalSchemaRef(json, single?.properties?.coordNotes);

      expect(coordNotes.type).toBe('string');

      const parse = complete.args as { safeParse: (value: unknown) => { success: boolean } };
      const valid = parse.safeParse({
        id: 'WI-1',
        state: 'resolved',
        assumptions: 'none',
        summary: 'fixed',
        coordNotes: 'this alias is free text',
      });
      expect(valid.success).toBe(true);

      const invalid = parse.safeParse({
        id: 'WI-1',
        state: 'resolved',
        assumptions: 'none',
        summary: 'fixed',
        coordNotes: { note: 'this alias is free text' },
      });

      expect(invalid.success).toBe(false);
    });

    it('documents that treeStamp is server-stamped and requires a full SHA when persisted (EI-21310406381433990)', () => {
      const json = z.toJSONSchema(complete.args as never);
      const text = JSON.stringify(json);

      expect(text).toContain('Server-stamped verification metadata');
      expect(text).toContain('callers must omit `treeStamp`');
      expect(text).toContain('full lowercase 40- or 64-character commit SHA');
      expect(text).toContain('short hashes are invalid');
    });

    it('documents preserving assumptions when recovering a terminal close after timeout (EI-20234204782129196)', () => {
      const guidance = ((complete as { guidance?: { seeAlso?: string[] } }).guidance?.seeAlso ?? []).join('\n');
      expect(guidance).toContain('work_items:complete times out');
      expect(guidance).toContain('work_items:set_state as the fallback');
      expect(guidance).toContain('assumptions');
      expect(guidance).toContain('completionRef');
    });

    it('accepts the documented nested verification shape while keeping completion fields outside it', () => {
      const schema = complete.args as {
        safeParse: (x: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } };
      };
      const valid = schema.safeParse({
        id: 'WI-1',
        state: 'resolved',
        assumptions: 'none',
        completion: {
          summary: 'fixed',
          verification: {
            filesChanged: ['src/fix.ts'],
            testsRun: 'npm run test:file -- src/fix.test.ts',
            testResult: '9/9 green',
            verifiedHow: 'unit',
            addedTests: true,
            coverage: { population: ['src/fix.ts'], checked: ['src/fix.ts'], residue: ['none'] },
          },
          deferred: ['live smoke pending'],
          coordNotes: 'follow-up is tracked',
        },
      });
      expect(valid.success).toBe(true);

      const invalid = schema.safeParse({
        id: 'WI-1',
        state: 'resolved',
        assumptions: 'none',
        completion: { summary: 'fixed', verification: { deferred: ['live smoke pending'] } },
      });
      expect(invalid.success).toBe(false);
      expect(invalid.error?.issues.map((issue) => issue.message).join(' ')).toContain('Unrecognized key');
    });
  });

  // ── P-004: completion AUTHORITY ────────────────────────────────────────────────────
  // agent-protocol-authority-semantics-2026-07-26 P-004. Two things are pinned here, and
  // the second is the one that will rot first:
  //
  //  1. The JUDGEMENT — evidence decides `committed` vs `proposed`, and only `committed`
  //     counts toward burn-down.
  //  2. The DELETED AUTO-FILL — complete.ts must NOT pass `completionRef`. It used to pass
  //     `it.completion.summary`, and because `summary` is a required non-empty field that
  //     made the completion-integrity gate's "requires a completionRef" check unfailable BY
  //     CONSTRUCTION for every caller of this tool. Re-adding it would silently restore a
  //     gate that cannot reject, so the absence is asserted explicitly rather than implied.
  describe('completion authority (P-004)', () => {
    beforeEach(() => {
      getWorkItem.mockResolvedValue({ ...item, id: 'WI-1', state: 'open', family: 'issue' });
      setWorkItemStateWithAliasInfo.mockImplementation(async (_id: string, state: string) =>
        okState({ ...item, id: 'WI-1', family: 'issue', state }),
      );
    });

    /** The opts object complete.ts handed the state writer. */
    const stateOpts = () => setWorkItemStateWithAliasInfo.mock.calls[0]?.[2] as Record<string, unknown>;

    it('routes an external producer close through the host attempt without overriding writer authority', async () => {
      getWorkItem.mockResolvedValue({ ...item, id: 'WI-1', state: 'open', family: 'issue',
        payload: { externalRuntimeProducer: { kind: 'external-runtime-producer' } } });
      await one({ id: 'WI-1', state: 'resolved', completion: { summary: 'Retained runtime checked',
        verifiedHow: 'integration', testsRun: 'retained transcript probe', testResult: 'matched' } });
      expect(stateOpts().externalRuntimeAttempt).toEqual(expect.objectContaining({ updatedTs: 1 }));
      expect(stateOpts()).not.toHaveProperty('completionAuthority');
    });

    it('refuses an external producer close whose evidence verdict is only proposed', async () => {
      getWorkItem.mockResolvedValue({ ...item, id: 'WI-1', state: 'open', family: 'issue',
        payload: { externalRuntimeProducer: { kind: 'external-runtime-producer' } } });
      const result = await one({ id: 'WI-1', state: 'resolved', completion: { summary: 'finished' } });
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(result.stateError).toContain('completion evidence is not committed');
    });

    it('a summary-only completion lands `proposed` and does NOT count toward burn-down', async () => {
      const r = await one({ id: 'WI-1', state: 'resolved', completion: { summary: 'fixed it' } });
      expect(stateOpts().completionAuthority).toBe('proposed');
      expect(r.completionAuthority).toBe('proposed');
      expect(r.countsTowardBurnDown).toBe(false);
    });

    it('a summary-only completion TELLS the caller it landed proposed, and names the fields that fix it', async () => {
      // The change is worthless if it is silent: an agent must learn from the response to
      // the call that did it, not from a leader asking why burn-down did not move.
      const r = await one({ id: 'WI-1', state: 'resolved', completion: { summary: 'fixed it' } });
      expect(r.authorityWarning).toMatch(/authority:'proposed'/);
      expect(r.authorityWarning).toMatch(/NOT counted toward burn-down/);
      expect(r.authorityWarning).toMatch(/verifiedHow/);
      expect(r.authorityWarning).toMatch(/testsRun/);
    });

    it('EI-22166138797743784: remote-origin content advice names federation ownership instead of local retry', () => {
      const localAdvice =
        'WAITING SETTLES THIS — the git-sync completion-settlement reconciler upgrades this close automatically.';
      expect(contentIdentityAdviceForOrigin('local', 'su-local', localAdvice)).toBe(localAdvice);

      const remoteAdvice = contentIdentityAdviceForOrigin('remote', 'su-author', localAdvice)!;
      expect(remoteAdvice).toMatch(/REMOTE-AUTHORED/);
      expect(remoteAdvice).toContain("'su-author'");
      expect(remoteAdvice).toMatch(/originating authoring peer|federation writer/);
      expect(remoteAdvice).toMatch(/cannot upgrade it/);
      expect(remoteAdvice).not.toMatch(/WAITING SETTLES THIS/);
      expect(remoteAdvice).not.toMatch(/re-send this IDENTICAL completion/);
      expect(remoteAdvice).toContain('do not re-call `work_items:complete` locally');

      // EI-24814178215040083: the reconciler's candidate query keys on a persisted
      // settlementManifest, never on origin, so a remote-origin close that persisted one IS
      // settled here (WI-10004437: origin 'remote', settled proposed -> committed). Naming
      // a remote settler for it pointed the closer at nobody.
      expect(contentIdentityAdviceForOrigin('remote', 'su-author', localAdvice, true)).toBe(localAdvice);
      expect(contentIdentityAdviceForOrigin('remote', 'su-author', localAdvice, false)).toMatch(/REMOTE-AUTHORED/);
    });

    it('verifiedHow + testResult lands `committed` and DOES count toward burn-down', async () => {
      const r = await one({
        id: 'WI-1',
        state: 'resolved',
        completion: { summary: 'fixed it', verifiedHow: 'unit', testResult: '26/26 green' },
      });
      expect(stateOpts().completionAuthority).toBe('committed');
      expect(r.completionAuthority).toBe('committed');
      expect(r.countsTowardBurnDown).toBe(true);
      expect(r.authorityWarning).toBeUndefined();
    });

    it('binds the latest testing:run lookup to the exact closing work-item', async () => {
      const closingItemId = 'WI-test-run-attribution';
      const closingItem = {
        ...item,
        id: closingItemId,
        kind: 'change',
        family: 'issue',
        state: 'open',
        harness: 'papercup',
      };
      getWorkItem.mockResolvedValue(closingItem);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...closingItem, state: 'resolved' }));

      let invocationQuery: { text: string; values: unknown[] } | undefined;
      dbMocks.planItemStatusRows.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join('');
        if (text.includes('FROM harness_shared.tool_invocations')) {
          invocationQuery = { text, values };
          return [];
        }
        return text.includes('SELECT 1 AS one FROM harness_shared.work_items wi') ? [] : [{ status: 'done' }];
      });

      const result = await one({
        id: closingItemId,
        harness: 'papercup',
        state: 'resolved',
        completion: { summary: 'closed with focused verification', verifiedHow: 'unit', testResult: 'green' },
      });

      expect(result.completionAuthority).toBe('committed');
      expect(invocationQuery).toBeDefined();
      expect(invocationQuery?.text).toContain("args_json->>'work_item_id'");
      expect(invocationQuery?.text).toContain("args_json #>> '{evidence,workItemId}'");
      expect(invocationQuery?.values).toContain(closingItemId);
    });

    it('does not call an authority-changing replay idempotent', async () => {
      const replayed = { ...item, id: 'WI-1', family: 'issue', state: 'open', completionAuthority: 'committed' };
      getWorkItem.mockResolvedValue(replayed);
      setWorkItemStateWithAliasInfo.mockResolvedValue({
        ...okState({ ...replayed, state: 'done', completionAuthority: 'proposed' }),
        workItem: { ...replayed, state: 'done', completionAuthority: 'proposed' },
      });

      const r = await one({
        id: 'WI-1',
        state: 'resolved',
        completion: { summary: 'replayed the stored completion', verifiedHow: 'unit', testResult: '26/26 green' },
      });

      expect(r.completionAuthority).toBe('proposed');
      expect(r.authorityWarning).toMatch(/authority:'proposed'/);
      expect(r.finish).toMatchObject({
        complete: true,
        idempotent: false,
        retrySafe: true,
        authorityChanged: true,
      });
    });

    // WI-10005199 — handler-level pair for the consumerView attestation. The leaf and the
    // source-wiring pin live in complete-consumer-view.test.ts; THIS pair drives the real
    // handler end to end so a regression anywhere between `reconcileStampedAuthority` and the
    // response (a dropped spread, a wrong operand) fails here with the migration-972 shape:
    // the call computes `committed`, the BEFORE trigger stores `proposed` on the re-read row.
    it('WI-10005199: a floor-trigger downgrade surfaces as a consumerView on the close response', async () => {
      const row = { ...item, id: 'WI-1', family: 'issue', state: 'open' };
      getWorkItem.mockResolvedValue(row);
      setWorkItemStateWithAliasInfo.mockResolvedValue({
        ...okState({ ...row, state: 'done', completionAuthority: 'proposed' }),
        workItem: { ...row, state: 'done', completionAuthority: 'proposed' },
      });

      const r = await one({
        id: 'WI-1',
        state: 'resolved',
        completion: { summary: 'fixed it', verifiedHow: 'unit', testResult: '26/26 green' },
      });

      expect(stateOpts().completionAuthority).toBe('committed'); // what the call computed
      expect(r.completionAuthority).toBe('proposed'); // what a consumer reads back
      expect(r.consumerView).toMatchObject({
        divergedFromWrite: true,
        value: { completionAuthority: 'proposed' },
      });
    });

    it('WI-10005199: an ordinary close that agrees with its read-back carries NO consumerView (exception-only)', async () => {
      const r = await one({
        id: 'WI-1',
        state: 'resolved',
        completion: { summary: 'fixed it', verifiedHow: 'unit', testResult: '26/26 green' },
      });
      expect(r.completionAuthority).toBe('committed');
      expect(r).not.toHaveProperty('consumerView');
    });

    it('verifiedHow + testsRun also lands `committed` (either half of the test pair qualifies)', async () => {
      await one({
        id: 'WI-1',
        state: 'resolved',
        completion: { summary: 'fixed it', verifiedHow: 'integration', testsRun: 'npm run test:file -- x.test.ts' },
      });
      expect(stateOpts().completionAuthority).toBe('committed');
    });

    it.each([
      { label: 'a valid duplicate close', state: 'resolved', duplicateOf: 'EI-survivor' },
      { label: 'a discard/drop close', state: 'dropped', duplicateOf: undefined },
    ])('counts $label toward burn-down even when authority stays proposed', async ({ state, duplicateOf }) => {
      const duplicateItem = { ...item, id: 'WI-1', kind: 'change', family: 'issue', state: 'open' };
      getWorkItem.mockResolvedValue(duplicateItem);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...duplicateItem, state }));
      if (duplicateOf) resolveWorkItemRef.mockResolvedValue({ kind: 'bug', ref: `papercup#${duplicateOf}` });

      const r = await one({
        id: 'WI-1',
        state,
        completion: {
          summary: duplicateOf ? 'duplicate of the canonical work-item' : 'intentionally dropped',
          ...(duplicateOf ? { duplicateOf } : {}),
        },
      });

      expect(r.completionAuthority).toBe('proposed');
      expect(stateOpts().completionAuthority).toBe('proposed');
      expect(r.countsTowardBurnDown).toBe(true);
      expect(r.authorityWarning).toBeUndefined();
    });

    // P-002 measured this exact shape on the live store: 4.2% of evidence-bearing rows
    // carry a `_completionEvidence` object with NO `verifiedHow`. An "is the object
    // present?" check passes every one of them, which is why the partial case is rejected
    // explicitly instead of being assumed away.
    it('a PARTIAL evidence object (no verifiedHow) lands `proposed`, not committed', async () => {
      await one({
        id: 'WI-1',
        state: 'resolved',
        completion: { summary: 'fixed it', testResult: 'all green', filesChanged: ['a.ts'], addedTests: true },
      });
      expect(stateOpts().completionAuthority).toBe('proposed');
    });

    it('verifiedHow ALONE lands `proposed` — a label is not a verification', async () => {
      await one({ id: 'WI-1', state: 'resolved', completion: { summary: 'fixed it', verifiedHow: 'unit' } });
      expect(stateOpts().completionAuthority).toBe('proposed');
    });

    it('filesChanged + addedTests alone land `proposed` — both say what changed, neither that anything was checked', async () => {
      await one({
        id: 'WI-1',
        state: 'resolved',
        completion: { summary: 'fixed it', filesChanged: ['a.ts', 'b.ts'], addedTests: true },
      });
      expect(stateOpts().completionAuthority).toBe('proposed');
    });

    it('REGRESSION GUARD: complete.ts no longer auto-fills completionRef from completion.summary', async () => {
      await one({ id: 'WI-1', state: 'resolved', completion: { summary: 'fixed it' } });
      const opts = stateOpts();
      expect(opts.completionRef).toBeUndefined();
      // and specifically not the summary, which is what it used to be
      expect(opts.completionRef).not.toBe('fixed it');
    });

    it('stamps NO authority when no terminal state was requested — nothing was closed to judge', async () => {
      const r = await one({
        id: 'WI-1',
        completion: { summary: 'progress note', verifiedHow: 'unit', testResult: 'ok' },
      });
      expect(r.completionAuthority).toBeUndefined();
      expect(r.countsTowardBurnDown).toBeUndefined();
      expect(r.authorityWarning).toBeUndefined();
    });

    it('claims NO authority when the state write was REJECTED — a failed close was never graded', async () => {
      setWorkItemStateWithAliasInfo.mockRejectedValue(new Error('nope'));
      const r = await one({ id: 'WI-1', state: 'resolved', completion: { summary: 'fixed it' } });
      expect(r.stateError).toBeTruthy();
      expect(r.completionAuthority).toBeUndefined();
      expect(r.authorityWarning).toBeUndefined();
    });
  });

  // ── D-018: the terminal-criteria ENFORCEMENT kill-switch ────────────────────────────
  // Added because a vetting reviewer asked the question no criterion asked: this gate
  // changes close outcomes for ~6.1% of committed bug/change closes fleet-wide the moment
  // it deploys, and its only rollback was a revert.
  //
  // The subject is the DOWNGRADE, not the evaluator — `evaluateCloseTerminalCriteria` is
  // unit-tested in terminal-criteria.test.ts and is deliberately untouched by the flag, so
  // OFF stays measurable rather than becoming a blind spot. Each test therefore asserts the
  // recorded verdict is STILL PRESENT alongside whatever authority landed.
  describe('terminal-criteria enforcement kill-switch (D-018)', () => {
    beforeEach(() => {
      // `kind: 'change'` is load-bearing: claimsRemediation() gates on the item kind, so the
      // default `feature` fixture would make every criterion `not-applicable` and this whole
      // block would pass against a gate that never ran.
      getWorkItem.mockResolvedValue({ ...item, id: 'WI-1', kind: 'change', state: 'open', family: 'issue' });
      setWorkItemStateWithAliasInfo.mockImplementation(async (_id: string, state: string) =>
        okState({ ...item, id: 'WI-1', kind: 'change', family: 'issue', state }),
      );
    });

    const stateOpts = () => setWorkItemStateWithAliasInfo.mock.calls[0]?.[2] as Record<string, unknown>;

    /**
     * A close that WOULD otherwise land `committed` (verifiedHow + testResult is the
     * qualifying evidence pair) but whose sole stated verification is the one mode that
     * cannot distinguish a fix from no fix. Without the criteria stage this is `committed`.
     */
    const downgradingClose = {
      id: 'WI-1',
      state: 'resolved',
      completion: { summary: 'fixed it', verifiedHow: 'already-passing', testResult: '26/26 green' },
    };

    it('does not downgrade a valid duplicate close whose nested verification says already-passing', async () => {
      enforcement(true);
      const duplicateTarget = 'EI-22594958409566705';
      const duplicateItem = { ...item, id: 'WI-1', kind: 'change', family: 'issue', state: 'open' };
      getWorkItem.mockResolvedValue(duplicateItem);
      setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...duplicateItem, state: 'resolved' }));
      resolveWorkItemRef.mockResolvedValue({ kind: 'bug', ref: `papercup#${duplicateTarget}` });

      const r = await one({
        id: 'WI-1',
        state: 'resolved',
        completion: {
          summary: 'duplicate of the canonical work-item',
          duplicateOf: duplicateTarget,
          verification: {
            verifiedHow: 'already-passing',
            testsRun: 'npm run test:file -- packages/operator-core/lib/agent-tools/work_items/complete.test.ts',
            testResult: 'PASS: focused integration test',
          },
        },
      });

      expect(r.ok).toBe(true);
      expect(r.completionAuthority).toBe('committed');
      expect(stateOpts().completionAuthority).toBe('committed');
      expect(r.terminalCriteriaWarning).toBeUndefined();
    });

    /** Answer only for the enforcement flag, so other flag reads keep their own defaults. */
    const enforcement = (value: boolean) =>
      getFlag.mockImplementation(async (key: unknown) =>
        key === 'papercusp-terminal-criteria-enforcement' ? value : false,
      );

    // SPEC-BQL-P-009-RECEIPT: exercise the close handler and its persistence
    // boundary, including accepted/non-reviewed controls and the honest drop exit.
    it.each([
      ['pending reproduction', 'revision-requested', 'reproduction'],
      ['receipt accepted', 'accepted', undefined],
      ['not reviewed', undefined, undefined],
    ] as const)('records the right authority for %s across terminal dispositions', async (_label, reviewStatus, revisionKind) => {
      enforcement(true);
      const payload = reviewStatus ? {
        agentReview: { status: reviewStatus, revisionKind, submittedBy: 'su-filer', ledgerIdeaId: 'WI-1', round: 2 },
      } : {};
      const bug = { ...item, id: 'WI-1', kind: 'bug', family: 'issue', state: 'open', payload };
      getWorkItem.mockResolvedValue(bug);
      setWorkItemStateWithAliasInfo.mockImplementation(async (_id: string, state: string) => okState({ ...bug, state }));

      for (const state of ['done', 'resolved', 'dropped']) {
        setWorkItemStateWithAliasInfo.mockClear();
        const r = await one({
          id: 'WI-1', state,
          completion: {
            summary: state === 'dropped' ? 'Current-build attempt did not reproduce; retain the attempt.' : 'Validated intervention recorded.',
            verifiedHow: 'scripted reproduction on the current build; persisted request/response inspected',
            testResult: 'Observed the recorded terminal disposition and authority.',
          },
        });
        const pendingSuccessfulClose = reviewStatus === 'revision-requested' && state !== 'dropped';
        const authority = pendingSuccessfulClose ? 'proposed' : 'committed';
        expect(r.ok).toBe(true);
        expect(r.completionAuthority).toBe(authority);
        expect(stateOpts().completionAuthority).toBe(authority);
        expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledTimes(1);
        if (pendingSuccessfulClose) {
          expect(r.countsTowardBurnDown).toBe(false);
          expect(r.terminalCriteriaWarning).toContain('reproduction-receipt');
          expect(r.authorityWarning).toContain("Authority landed 'proposed'");
        } else {
          expect(r.terminalCriteriaWarning ?? '').not.toContain('reproduction-receipt');
        }
      }
    });

    it('ON (the shipped default): an unmet criterion downgrades the close to `proposed`', async () => {
      enforcement(true);
      const r = await one(downgradingClose);
      expect(stateOpts().completionAuthority).toBe('proposed');
      expect(r.completionAuthority).toBe('proposed');
      expect(r.countsTowardBurnDown).toBe(false);
      expect(r.authorityWarning).toContain(String(r.terminalCriteriaWarning));
      expect(r.authorityWarning).toMatch(/forbidden-evidence-mode.*already-passing/i);
      expect(r.authorityWarning).not.toMatch(/requires `verifiedHow`|with those fields filled/i);
    });

    it('preview explains the same terminal criterion without writing the close', async () => {
      enforcement(true);
      const r = await one({ ...downgradingClose, validateOnly: true });
      expect(r.validationOnly).toBe(true);
      expect(r.completionAuthority).toBe('proposed');
      expect(r.countsTowardBurnDown).toBe(false);
      expect(r.terminalCriteriaWarning).toMatch(/forbidden-evidence-mode.*already-passing/i);
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
      expect(attachCompletionEvidenceToSettledItem).not.toHaveBeenCalled();
      expect(commentWorkItem).not.toHaveBeenCalled();
    });

    it('keeps missing-field advice when a forbidden mode also omits its test evidence', async () => {
      enforcement(true);
      const r = await one({
        ...downgradingClose,
        completion: { summary: 'checked existing code', verifiedHow: 'already-passing' },
      });
      expect(r.completionAuthority).toBe('proposed');
      expect(r.terminalCriteriaWarning).toMatch(/forbidden-evidence-mode/i);
      expect(r.authorityWarning).toMatch(/requires `verifiedHow`.*testsRun/i);
      expect(r.authorityWarning).not.toContain('evidence fields are complete');
    });

    it('OFF: the SAME close lands `committed` — the switch actually switches something off', async () => {
      enforcement(false);
      const r = await one(downgradingClose);
      expect(stateOpts().completionAuthority).toBe('committed');
      expect(r.completionAuthority).toBe('committed');
    });

    it('OFF still RECORDS the verdict and says enforcement is disabled — OFF is not a blind spot', async () => {
      enforcement(false);
      const r = await one(downgradingClose);
      const warning = String(
        r.terminalCriteriaWarning ?? r.authorityWarning ?? stateOpts().terminalCriteriaWarning ?? '',
      );
      // The verdict survives the switch: a reader can still see WHAT the gate found.
      expect(warning).toMatch(/already-passing/i);
      // ...and that it was deliberately not applied, rather than silently absent.
      expect(warning).toMatch(/DISABLED|not applied/i);
      expect(warning).toContain('papercusp-terminal-criteria-enforcement');
    });

    // The direction that matters. A flag-store fault must NOT silently disable a fleet-wide
    // gate: the flag's own default is ON, so an unreadable flag resolves to the shipped
    // behaviour. This is deliberately the OPPOSITE of D-003's fail-open, which protects the
    // completion RECORD from an evaluator fault. Neither can lose a record.
    it('FAILS SAFE-ON: a flag-read fault keeps enforcing rather than disabling the gate', async () => {
      getFlag.mockRejectedValue(new Error('flag store unreachable'));
      const r = await one(downgradingClose);
      expect(stateOpts().completionAuthority).toBe('proposed');
      expect(r.completionAuthority).toBe('proposed');
    });

    // Guards the flag read against being hoisted out of its guard onto every close. A close
    // with nothing to downgrade must not consult the flag at all.
    it('does not consult the flag when there is no downgrade to suppress', async () => {
      enforcement(true);
      await one({
        id: 'WI-1',
        state: 'resolved',
        completion: { summary: 'fixed it', verifiedHow: 'unit', testResult: '26/26 green', filesChanged: ['a.ts'] },
      });
      const consulted = getFlag.mock.calls.some((c: unknown[]) => c[0] === 'papercusp-terminal-criteria-enforcement');
      expect(consulted).toBe(false);
    });
  });
});

// ── EI-19362441037986499: a record-only completion of an ALREADY-TERMINAL item ────────────
// Reported as a race (a watchdog auto-resolve beating the agent's own close) but measured
// with NO concurrency at all: the row had been terminal for 33 minutes. Nothing here is
// timing-dependent, because the defect never needed a race — a completion that passes no
// `state` takes no persistence branch, and `completion.status:'done'` can never infer one
// (it IS the schema default). So the evidence went nowhere, and the "it is NOT closed"
// warning was suppressed precisely because the item WAS closed: ok:true, a mutation count,
// and no stored record anywhere.
describe('record-only completion of an already-terminal item (EI-19362441037986499)', () => {
  const resolved = { ...item, id: 'EI-1', kind: 'bug', family: 'issue', state: 'resolved' };

  beforeEach(() => {
    getWorkItem.mockResolvedValue(resolved);
  });

  const recordOnly = () =>
    one({
      id: 'EI-1',
      completion: {
        summary: 'a partial vi.mock had gone stale for the third time',
        status: 'done',
        verifiedHow: 'unit',
        testsRun: 'testing:run complete.test.ts',
        testResult: '144 passed / 0 failed',
      },
    });

  it('ATTACHES the evidence instead of discarding it — and writes no state', async () => {
    const r = await recordOnly();
    expect(r.ok).toBe(true);
    expect(attachCompletionEvidenceToSettledItem).toHaveBeenCalledTimes(1);
    // The whole point of a separate writer: NO state write. A terminal→same-terminal
    // re-assert would re-fire `work-item:done:<id>` (that emit carries no state-changed
    // guard), waking everything parked on the item on every record-only completion.
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    const [id, opts] = attachCompletionEvidenceToSettledItem.mock.calls[0] as [string, Record<string, any>];
    expect(id).toBe('EI-1');
    expect(opts.by).toBe('su-tester');
    // The narrative rides in the evidence, exactly as it does on the state-write path.
    expect(opts.completionEvidence?.verifiedHow).toBe('unit');
    expect(opts.completionEvidence?.testResult).toBe('144 passed / 0 failed');
    expect(opts.completionRef).toBeUndefined();
  });

  it('TELLS the caller the record was stored — the terminal case no longer warns silently', async () => {
    attachCompletionEvidenceToSettledItem.mockResolvedValue({ outcome: 'recorded', workItem: { ...resolved } });
    const r = await recordOnly();
    // Before the fix this was `undefined` for EVERY terminal final state, which is exactly
    // why a discarded completion was indistinguishable from a successful one.
    expect(r.stateWarning).toBeTruthy();
    expect(r.stateWarning).toContain('ALREADY terminal');
    expect(r.stateWarning).toContain('EI-1');
  });

  it('surfaces the conflict note when a peer record stands and this one is only attested', async () => {
    attachCompletionEvidenceToSettledItem.mockImplementation(
      async (_id: string, opts: { onTerminalConflict?: (i: unknown) => void }) => {
        opts.onTerminalConflict?.({
          outcome: 'attested',
          existingOwner: 'watchdog-green-resolve',
          existingAuthority: null,
          existingEvidenceSufficient: true,
          incomingEvidenceSufficient: true,
          note: 'was ALREADY completed by watchdog-green-resolve … FILED AS A SECOND ATTESTATION',
        });
        return { outcome: 'attested', workItem: { ...resolved } };
      },
    );
    const r = await recordOnly();
    expect(r.ok).toBe(true);
    expect(r.stateWarning).toContain('second attestation');
    // Routed through the SAME result field the state-write path already uses, so a caller
    // reading one surface sees both kinds of terminal-completion conflict.
    expect(JSON.stringify(r)).toContain('watchdog-green-resolve');
  });

  it('reports an attach failure instead of claiming the record landed', async () => {
    attachCompletionEvidenceToSettledItem.mockRejectedValue(new Error('pg down'));
    const r = await recordOnly();
    expect(r.stateError).toContain('pg down');
    expect(r.stateWarning).toContain('could NOT be attached');
  });

  it('does NOT demand `assumptions` — the caller is closing nothing', async () => {
    // Routing this through the close-intent path would convert a silent no-op into a HARD
    // REFUSAL for callers who never asked to close anything.
    const r = await oneRaw({
      id: 'EI-1',
      completion: { summary: 'progress note', status: 'done', verifiedHow: 'unit', testResult: 'ok' },
    });
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('leaves a NON-terminal item on the ordinary record-only path, untouched', async () => {
    // The positive control for the arm's guard: same call shape, open item ⇒ the new writer
    // must not fire, and the pre-existing "it is NOT closed" warning must still appear. Without
    // this, every assertion above would also pass for an arm that fires unconditionally.
    getWorkItem.mockResolvedValue({ ...resolved, state: 'open' });
    const r = await recordOnly();
    expect(attachCompletionEvidenceToSettledItem).not.toHaveBeenCalled();
    expect(r.stateWarning).toContain('NOT closed');
  });
});

// D-041 (goal-agent-behavior-feedback-2026-09-06, R-18): the WIRING of the residue finding.
// The helper is tested in isolation beside the grade; this pins that complete.ts reads the
// cited ids off `deferred`, asks the store, and tells the closer, while an owned follow-up
// and an unanswerable store both stay silent.
describe('D-041 — a close citing an UNOWNED follow-up is told so', () => {
  const change = { id: 'WI-res', kind: 'change', family: 'issue', state: 'open', harness: 'papercup' };
  const followUp = (assignee: string | null, payload: Record<string, unknown> | null = null) => ({
    id: 'WI-95511', kind: 'bug', family: 'issue', state: 'open', harness: 'papercup',
    assignee, payload, createdBy: 'someone-else', createdAt: '2026-09-30T00:00:00Z',
  });
  const close = () => one({
    id: 'WI-res',
    state: 'done',
    completion: {
      summary: 'fixed the stale-cache read',
      deferred: ['widget-export defect filed as WI-95511'],
      verification: { verifiedHow: 'unit', testsRun: 'widget-sync.test.ts', testResult: '8 passed' },
    },
  });

  beforeEach(() => {
    getWorkItem.mockResolvedValue(change);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...change, state: 'done' }));
  });

  it('names the unowned ref and the repair', async () => {
    getWorkItemsByIds.mockResolvedValue([followUp(null)]);
    const r = await close();
    expect(getWorkItemsByIds).toHaveBeenCalledWith(['WI-95511']);
    expect(r.residueUnownedWarning).toContain('WI-95511');
    expect(r.residueUnownedWarning).toContain('work_items:claim');
  });

  it('calibration: an ASSIGNED follow-up is silent', async () => {
    getWorkItemsByIds.mockResolvedValue([followUp('su-owner')]);
    const r = await close();
    expect(getWorkItemsByIds).toHaveBeenCalled();
    expect(r.residueUnownedWarning).toBeUndefined();
  });

  it('an active structured human ask is owned even after set_blocker releases the agent assignee', async () => {
    getWorkItemsByIds.mockResolvedValue([followUp(null, {
      externalBlockers: [{
        kind: 'human',
        capability: 'physical-device',
        ref: 'device:camera',
        summary: 'Connect the physical camera for verification.',
        nextVerb: 'Run the camera verification again.',
        status: 'active',
        createdAt: '2026-09-30T00:00:00Z',
        createdBy: 'su-closer',
        updatedAt: '2026-09-30T00:00:00Z',
      }],
    })]);
    const r = await close();
    expect(r.residueUnownedWarning).toBeUndefined();
  });

  it('a cleared human blocker does not keep an unassigned follow-up owned', async () => {
    getWorkItemsByIds.mockResolvedValue([followUp(null, {
      externalBlockers: [{
        kind: 'human',
        capability: 'physical-device',
        ref: 'device:camera',
        summary: 'Connect the physical camera for verification.',
        nextVerb: 'Run the camera verification again.',
        status: 'cleared',
        createdAt: '2026-09-30T00:00:00Z',
        createdBy: 'su-closer',
        updatedAt: '2026-09-30T00:00:00Z',
      }],
    })]);
    const r = await close();
    expect(r.residueUnownedWarning).toContain('WI-95511');
  });

  it('a store that cannot answer is silence, never an accusation', async () => {
    getWorkItemsByIds.mockRejectedValue(new Error('pool exhausted'));
    const r = await close();
    expect(r.ok).toBe(true);
    expect(r.residueUnownedWarning).toBeUndefined();
  });
});

// P-007 Phase C (unified-bug-pipeline-and-honest-queue-2026-10-05, D-028): the call sites in
// completeOne, behind the hermetic store spies declared with the module mocks above. The
// store itself runs against real Postgres in
// harness/improvements/completion-verification.integration.test.ts.
describe('work_items:complete — completion verification wiring (P-007 Phase C, D-028)', () => {
  const subject = { ...item, id: 'WI-CV-1', kind: 'bug', family: 'issue', state: 'open', title: 'rotate the export key' };
  /** A completion task for WI-CV-1 whose verified completion was closed by `closer`. */
  async function completionTask(closer: string) {
    const { completionVerificationPayload } = await import('../../harness/improvements/completion-verification');
    const payload = completionVerificationPayload(
      { id: subject.id, title: subject.title, kind: 'bug', closer },
      '2026-10-06T00:00:00.000Z',
    );
    return { ...item, id: 'WI-CV-TASK', kind: 'task', family: 'issue', state: 'open', title: `Verify completion of ${subject.id}`, payload };
  }

  beforeEach(() => {
    cvStore.spawn.mockReset();
    cvStore.applyVerdict.mockReset();
    cvStore.acceptOnSettlement.mockReset();
    setWorkItemStateWithAliasInfo.mockClear();
  });

  it('a successful proposed close spawns the verification task, naming the landed terminal owner as closer', async () => {
    getWorkItem.mockResolvedValue(subject);
    setWorkItemStateWithAliasInfo.mockResolvedValue(
      okState({ ...subject, state: 'resolved', completionAuthority: 'proposed', terminalOwner: 'su-closer' }),
    );
    cvStore.spawn.mockResolvedValue({ outcome: 'created', taskId: 'WI-CV-TASK', gated: ['WI-CV-DEP'], notGated: [] });
    const r = await one({ id: subject.id, state: 'resolved', completion: { summary: 'rotated' } });
    expect(cvStore.spawn).toHaveBeenCalledTimes(1);
    expect(cvStore.spawn.mock.calls[0][0]).toMatchObject({ id: subject.id, closer: 'su-closer', kind: 'bug', title: subject.title });
    expect(r.completionVerification).toMatchObject({ spawned: { outcome: 'created', taskId: 'WI-CV-TASK' } });
    expect(r.completionVerificationWarning).toBeUndefined();
  });

  it('spawns nothing for a committed close or a discard close', async () => {
    getWorkItem.mockResolvedValue(subject);
    setWorkItemStateWithAliasInfo.mockResolvedValue(
      okState({ ...subject, state: 'resolved', completionAuthority: 'committed', terminalOwner: 'su-closer' }),
    );
    expect((await one({ id: subject.id, state: 'resolved', completion: { summary: 'rotated' } })).ok).toBe(true);
    getWorkItem.mockResolvedValue(subject);
    setWorkItemStateWithAliasInfo.mockResolvedValue(
      okState({ ...subject, state: 'dropped', completionAuthority: 'proposed', terminalOwner: 'su-closer' }),
    );
    expect((await one({ id: subject.id, state: 'closed', completion: { summary: 'wontfix', tests: 'n/a' } })).ok).toBe(true);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledTimes(2);
    expect(cvStore.spawn).not.toHaveBeenCalled();
  });

  it('a re-close that upgrades a stored proposed completion accepts the open task instead of spawning one', async () => {
    getWorkItem.mockResolvedValue({ ...subject, state: 'resolved', completionAuthority: 'proposed' });
    setWorkItemStateWithAliasInfo.mockResolvedValue(
      okState({ ...subject, state: 'resolved', completionAuthority: 'committed', terminalOwner: 'su-closer' }),
    );
    cvStore.acceptOnSettlement.mockResolvedValue({ accepted: 'WI-CV-TASK' });
    const r = await one({ id: subject.id, state: 'resolved', completion: { summary: 'rotated, evidence now committed' } });
    expect(cvStore.acceptOnSettlement).toHaveBeenCalledWith(subject.id, 'committed');
    expect(cvStore.spawn).not.toHaveBeenCalled();
    expect(r.completionVerification).toMatchObject({ acceptedBySettlement: { accepted: 'WI-CV-TASK' } });
  });

  it('a completion task refuses a terminal close without a verdict, and a reject without a reason', async () => {
    getWorkItem.mockResolvedValue(await completionTask('su-closer'));
    const bare = await one({ id: 'WI-CV-TASK', state: 'resolved', completion: { summary: 'looked at it' } });
    expect(bare.ok).toBe(false);
    expect(bare.error).toMatch(/requires completion\.verificationVerdict/);
    const noReason = await one({
      id: 'WI-CV-TASK',
      state: 'resolved',
      completion: { summary: 'not convinced', verificationVerdict: { verdict: 'reject' } },
    });
    expect(noReason.ok).toBe(false);
    expect(noReason.error).toMatch(/requires completion\.verificationVerdict\.reason/);
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    expect(cvStore.applyVerdict).not.toHaveBeenCalled();
  });

  it('the closer of the verified completion cannot record the verdict', async () => {
    getWorkItem.mockResolvedValue(await completionTask('su-tester'));
    const r = await one({
      id: 'WI-CV-TASK',
      state: 'resolved',
      completion: { summary: 'my own work is fine', verificationVerdict: { verdict: 'accept' } },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^verifier_conflict/);
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('an independent verifier closes it and the verdict is applied as that verifier', async () => {
    const task = await completionTask('su-closer');
    getWorkItem.mockResolvedValue(task);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...task, state: 'resolved', completionAuthority: 'committed' }));
    cvStore.applyVerdict.mockResolvedValue({ applied: 'accept', subject: subject.id });
    const r = await one({
      id: 'WI-CV-TASK',
      state: 'resolved',
      completion: { summary: 'completion matches the item', verificationVerdict: { verdict: 'accept' } },
    });
    expect(r.ok).toBe(true);
    expect(cvStore.applyVerdict).toHaveBeenCalledTimes(1);
    const input = cvStore.applyVerdict.mock.calls[0][0] as { verifier: string; taskPayload: unknown; completion: unknown };
    expect(input.verifier).toBe('su-tester');
    expect(input.taskPayload).toEqual(task.payload);
    expect(input.completion).toMatchObject({ verificationVerdict: { verdict: 'accept' } });
    expect(r.completionVerification).toMatchObject({ verdict: { applied: 'accept', subject: subject.id } });
  });
});

// P-008 / R-7 (derived-status-not-hand-written-2026-10-12): the call site in completeOne.
// The merge rules themselves are pinned in completion-prefill.test.ts; this block pins
// that a holder's successful close actually runs them, persists the result, discloses it,
// and that every skip condition (no claim window, ledger failure) leaves the input intact.
describe('work_items:complete — completion prefill wiring (P-008)', () => {
  const held = { ...item, id: 'F-PRE', assignee: 'su-tester', takenAt: '2026-10-12T16:00:00.000Z' };
  const mechanics = {
    derived: 'read-time',
    derivedAt: '2026-10-12T17:00:00.000Z',
    holder: { ownerId: 'su-tester', claimedAt: '2026-10-12T16:00:00.000Z' },
    filesWritten: {
      paths: ['packages/operator-core/vitest.config.ts', 'packages/operator-core/lib/x.test.ts'],
      total: 2,
      truncated: false,
      outsideRepo: 0,
    },
    tests: {
      attribution: 'path-and-claim-window',
      latest: [{
        file: 'packages/operator-core/lib/x.test.ts',
        status: 'pass',
        at: '2026-10-12T16:30:00.000Z',
        passed: 3,
        failed: 0,
        dirtyTree: false,
        commitSha: 'ec4366d0843c68dc1ad481a9b86ab476186b6ca8',
      }],
      verdict: 'all-pass',
    },
    openBlockers: [],
    sources: [],
  };
  const persistedEvidence = () =>
    (setWorkItemStateWithAliasInfo.mock.calls.at(-1)?.[2] as { completionEvidence?: Record<string, unknown> } | undefined)
      ?.completionEvidence;

  beforeEach(() => {
    readWorkItemMechanicsMock.mockReset();
    readWorkItemMechanicsMock.mockResolvedValue(mechanics);
    getWorkItem.mockResolvedValue(held);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...held, state: 'done' }));
  });

  it("a holder's close fills absent evidence from its claim window, persists it, and discloses it", async () => {
    const r = await one({
      id: 'F-PRE',
      state: 'done',
      completion: { summary: 'built the widget', verification: { verifiedHow: 'unit' } },
    });
    expect(r.ok).toBe(true);
    expect(readWorkItemMechanicsMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'F-PRE', assignee: 'su-tester', takenAt: '2026-10-12T16:00:00.000Z' }),
      expect.anything(),
    );
    expect(r.completionPrefill).toMatchObject({ fields: ['filesChanged', 'testsRun', 'testResult'] });
    expect(persistedEvidence()).toMatchObject({
      filesChanged: ['packages/operator-core/vitest.config.ts', 'packages/operator-core/lib/x.test.ts'],
      testsRun: expect.stringContaining('packages/operator-core/lib/x.test.ts'),
      testResult: expect.stringMatching(/^all passing/),
      summary: 'built the widget',
    });
  });

  it('a value the closer supplied is persisted unchanged; only the absent fields are filled', async () => {
    const r = await one({
      id: 'F-PRE',
      state: 'done',
      completion: { summary: 'built it', verification: { verifiedHow: 'unit', testResult: '12/12 green (my run)' } },
    });
    expect(r.ok).toBe(true);
    expect(r.completionPrefill?.fields).not.toContain('testResult');
    expect(persistedEvidence()).toMatchObject({ testResult: '12/12 green (my run)' });
  });

  it('an item with no claim window is never read and carries no prefill', async () => {
    getWorkItem.mockResolvedValue({ ...held, takenAt: null });
    const r = await one({
      id: 'F-PRE',
      state: 'done',
      completion: { summary: 'built it', verification: { verifiedHow: 'unit', testsRun: 'x.test.ts', testResult: '1/1' } },
    });
    expect(r.ok).toBe(true);
    expect(readWorkItemMechanicsMock).not.toHaveBeenCalled();
    expect(r.completionPrefill).toBeUndefined();
  });

  it('a ledger failure is fail-soft: the close succeeds with the completion as supplied', async () => {
    readWorkItemMechanicsMock.mockRejectedValue(new Error('pool exhausted'));
    const r = await one({
      id: 'F-PRE',
      state: 'done',
      completion: { summary: 'built it', verification: { verifiedHow: 'unit', testsRun: 'x.test.ts', testResult: '1/1' } },
    });
    expect(r.ok).toBe(true);
    expect(r.completionPrefill).toBeUndefined();
    expect(persistedEvidence()?.filesChanged).toBeUndefined();
  });
});

// ── change-kind-declared-proof-2026-10-15 P-002: the change-kind close gate, through the handler ──
describe('work_items:complete — change-kind proof gate (change-kind-declared-proof P-002)', () => {
  const AFTER_CUTOVER = new Date(Date.parse(CHANGE_KIND_GATE_CUTOVER) + 3_600_000).toISOString();
  const BEFORE_CUTOVER = new Date(Date.parse(CHANGE_KIND_GATE_CUTOVER) - 3_600_000).toISOString();
  const claimed = (takenAt: string) => ({ ...item, takenAt, assignee: 'su-tester' });
  /** The stored declaration rows readChangeKinds returns for F-12 (newest last). */
  let declarationRows: Array<Record<string, unknown>>;

  beforeEach(() => {
    declarationRows = [];
    const defaultRows = dbMocks.planItemStatusRows.getMockImplementation();
    dbMocks.planItemStatusRows.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('');
      if (text.includes('work_item_change_kind_declarations')) {
        return text.includes('SELECT feature_id, kinds') ? declarationRows : [];
      }
      return defaultRows?.(strings, ...values);
    });
  });

  const declaredAtClaim = (kinds: string[]) => {
    declarationRows = [
      { feature_id: 'F-12', kinds, step: 'claim', declared_by: 'su-tester', declared_at: AFTER_CUTOVER, reason: null },
    ];
  };

  it('refuses a ui-declared close that carries no recorded real-app run artifact; the record is kept and the item stays open', async () => {
    getWorkItem.mockResolvedValue(claimed(AFTER_CUTOVER));
    declaredAtClaim(['ui']);
    const r = await one({
      id: 'F-12',
      state: 'passed',
      completion: {
        summary: 'restyled the queue panel',
        testsRun: 'npm run test:file -- queue-panel.test.ts',
        testResult: '6/6 vitest green',
        filesChanged: ['apps/operator/app/queue/panel.css'],
      },
    });
    expect(r.ok).toBe(false);
    expect(r.stateError).toMatch(/^REJECTED — F-12 declares change kind\(s\) ui/);
    expect(r.error).toContain('a recorded run of the real app');
    expect(r.changeKindProof.kinds).toEqual(['ui']);
    expect(r.changeKindProof.missing.map((m: { kind: string }) => m.kind)).toEqual(['ui']);
    // D-002: the terminal transition is never attempted, and the completion record survives.
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    expect(r.completion).toMatchObject({ summary: 'restyled the queue panel' });
  });

  it('a validateOnly preview reports the change-kind-proof contract requirement as unsatisfied', async () => {
    getWorkItem.mockResolvedValue(claimed(AFTER_CUTOVER));
    declaredAtClaim(['logic']);
    const r = await one({
      id: 'F-12',
      state: 'passed',
      validateOnly: true,
      completion: { summary: 'changed the ranking', testsRun: 'eyeballed it', testResult: 'looks right' },
    });
    expect(r).toMatchObject({
      ok: false,
      validationOnly: true,
      stateError: expect.stringMatching(/^REJECTED — F-12 declares change kind\(s\) logic/),
      changeKindProof: { kinds: ['logic'], missing: expect.any(Array), problems: expect.any(Array) },
    });
    expect(r.validationOnly).toBe(true);
    expect(r.error).not.toContain('completion is recorded');
    expect(r).not.toHaveProperty('completion');
    expect(r.completionContract.requirements).toEqual(
      expect.arrayContaining([expect.objectContaining({
        key: 'change-kind-proof', evaluated: true, applicable: true, satisfied: false,
      })]),
    );
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('a validateOnly preview refuses a post-cutover close with no change-kind declaration', async () => {
    getWorkItem.mockResolvedValue(claimed(AFTER_CUTOVER));
    const r = await one({
      id: 'F-12',
      state: 'passed',
      validateOnly: true,
      completion: { summary: 'changed the ranking', testsRun: 'testing:run rank.test.ts', testResult: '12 passed' },
    });
    expect(r).toMatchObject({
      ok: false,
      validationOnly: true,
      stateError: expect.stringMatching(/^REJECTED — F-12 has no change-kind declaration/),
      changeKindProof: {
        kinds: null,
        missing: [],
        problems: expect.arrayContaining([expect.stringContaining('no change kind has been declared')]),
      },
    });
    expect(r.error).not.toContain('completion is recorded');
    expect(r).not.toHaveProperty('completion');
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('lands a logic-declared close that carries a passing test run', async () => {
    getWorkItem.mockResolvedValue(claimed(AFTER_CUTOVER));
    declaredAtClaim(['logic']);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
    const completion = {
      summary: 'changed the ranking',
      testsRun: 'testing:run { files: ["packages/operator-core/lib/rank.test.ts"] }',
      testResult: '12 passed',
    };
    const preview = await one({ id: 'F-12', state: 'passed', validateOnly: true, completion });
    expect(preview.completionContract.requirements).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'change-kind-proof', applicable: true, satisfied: true })]),
    );
    const r = await one({ id: 'F-12', state: 'passed', completion });
    expect(r.ok).toBe(true);
    expect(r.stateError).toBeUndefined();
    expect(r.changeKindProof).toBeUndefined();
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
    expect(r.workItem.state).toBe('passed');
  });

  it('lands a multi-kind close that carries one completion.kindEvidence entry per declared kind', async () => {
    getWorkItem.mockResolvedValue(claimed(AFTER_CUTOVER));
    declaredAtClaim(['config', 'docs']);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
    const r = await one({
      id: 'F-12',
      state: 'passed',
      completion: {
        summary: 'raised the default and documented it',
        kindEvidence: [
          { kind: 'config', readBack: 'config:get queue.limit returned 50' },
          { kind: 'docs', readBack: 'docs:get agent-insights/queue-limit shows the new default' },
        ],
      },
    });
    expect(r.ok).toBe(true);
    expect(r.workItem.state).toBe('passed');
  });

  it('refuses an undeclared close of a claim taken after the cutover', async () => {
    getWorkItem.mockResolvedValue(claimed(AFTER_CUTOVER));
    const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 'done', testsRun: 'npm test', testResult: 'pass' } });
    expect(r.ok).toBe(false);
    expect(r.stateError).toContain('has no change-kind declaration');
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('D-003: an undeclared close of a claim taken before the cutover lands with changeKindWarning', async () => {
    getWorkItem.mockResolvedValue(claimed(BEFORE_CUTOVER));
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
    const r = await one({ id: 'F-12', state: 'passed', completion: { summary: 'done', testsRun: 'npm test', testResult: 'pass' } });
    expect(r.ok).toBe(true);
    expect(r.workItem.state).toBe('passed');
    expect(r.changeKindWarning).toContain(`began ${BEFORE_CUTOVER}`);
  });

  it('D-001: a first declaration at close lands only with changeKindReason, and is then recorded', async () => {
    getWorkItem.mockResolvedValue(claimed(AFTER_CUTOVER));
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'passed' }));
    const completion = { summary: 'changed the ranking', testsRun: 'npx vitest run rank.test.ts', testResult: '12 passed' };

    const late = await one({ id: 'F-12', state: 'passed', changeKinds: ['logic'], completion });
    expect(late.ok).toBe(false);
    expect(late.stateError).toContain('`changeKindReason`');
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();

    const reasoned = await one({
      id: 'F-12',
      state: 'passed',
      changeKinds: ['logic'],
      changeKindReason: 'claimed through scheduler:get_next before the item was read',
      completion,
    });
    expect(reasoned.ok).toBe(true);
    expect(reasoned.changeKinds).toMatchObject({ recorded: true, current: ['logic'], step: 'complete' });
    const inserts = dbMocks.planItemStatusRows.mock.calls.filter(([strings]) =>
      (strings as TemplateStringsArray).join('').includes('INSERT INTO harness_shared.work_item_change_kind_declarations'),
    );
    expect(inserts.length).toBeGreaterThanOrEqual(1);
  });

  it('a dropped close is not gated', async () => {
    getWorkItem.mockResolvedValue(claimed(AFTER_CUTOVER));
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...item, state: 'dropped' }));
    const r = await one({ id: 'F-12', state: 'dropped', completion: { summary: 'superseded by F-13' } });
    expect(r.stateError ?? '').not.toContain('change-kind');
    expect(r.changeKindProof).toBeUndefined();
  });
});

// P-011 / R-10 (change-provenance-and-admission-throughput-2026-10-27): the close-coverage
// warning at the work_items:complete DOOR. work-item-close-coverage.test.ts pins the
// classifier with injected rows; these cases pin that the door CALLS it over the item's claim
// window, returns its words on the close response, and never lets it refuse or fail the close.
// Deleting the call in complete.ts turns the first case red (no warning, no read).
describe('work_items:complete — close-coverage warning at the door (P-011 / R-10)', () => {
  const TAKEN_AT = '2026-10-12T16:00:00.000Z';
  const held = { ...item, id: 'F-COV', assignee: 'su-tester', takenAt: TAKEN_AT };
  const completion = {
    summary: 'changed the classifier',
    verification: {
      verifiedHow: 'unit',
      testsRun: 'npm run test:file -- packages/operator-core/lib/b.test.ts',
      testResult: '3 passed, 0 failed',
      filesChanged: ['packages/operator-core/lib/a.ts', 'packages/operator-core/lib/b.ts'],
    },
  };
  const report = (over: Record<string, unknown> = {}) => ({
    windowStartMs: Date.parse(TAKEN_AT),
    windowEndMs: Date.parse(TAKEN_AT) + 3_600_000,
    editedFiles: ['packages/operator-core/lib/a.ts', 'packages/operator-core/lib/b.ts'],
    coveredFiles: ['packages/operator-core/lib/b.ts'],
    uncoveredFiles: ['packages/operator-core/lib/a.ts'],
    runsConsidered: 2,
    passingRuns: 2,
    anyCleanPass: false,
    cleanTree: 'dirty-only',
    dirtyOnlyFiles: ['packages/operator-core/lib/b.ts'],
    unknownTreeFiles: [],
    runsTruncated: false,
    ...over,
  });

  beforeEach(() => {
    closeCoverageRead.compute.mockReset();
    getWorkItem.mockResolvedValue(held);
    setWorkItemStateWithAliasInfo.mockResolvedValue(okState({ ...held, state: 'done' }));
  });
  afterEach(() => {
    closeCoverageRead.compute.mockReset();
    closeCoverageRead.compute.mockResolvedValue(null);
  });

  it('returns the uncovered file and the dirty-only file on the close response, and the close still advances', async () => {
    closeCoverageRead.compute.mockResolvedValue(report());
    const r = await one({ id: 'F-COV', state: 'done', completion });

    expect(r.ok).toBe(true);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
    expect(setWorkItemStateWithAliasInfo.mock.calls.at(-1)?.[1]).toBe('done');
    // The read is scoped to THIS item over ITS claim window.
    expect(closeCoverageRead.compute).toHaveBeenCalledTimes(1);
    expect(closeCoverageRead.compute.mock.calls[0]?.[0]).toMatchObject({
      workItemId: 'F-COV',
      windowStartMs: Date.parse(TAKEN_AT),
    });
    const warning = String(r.closeCoverageWarning ?? '');
    expect(warning).toContain('the close is not refused');
    expect(warning).toContain('exercised by no recorded test run in its claim window: packages/operator-core/lib/a.ts');
    expect(warning).toContain('passed only on a DIRTY tree');
    expect(warning).toMatch(/DIRTY tree[^;]*packages\/operator-core\/lib\/b\.ts/);
  });

  it('CONTROL — fully covered edits that passed on a clean tree carry no warning key', async () => {
    closeCoverageRead.compute.mockResolvedValue(
      report({
        coveredFiles: ['packages/operator-core/lib/a.ts', 'packages/operator-core/lib/b.ts'],
        uncoveredFiles: [],
        anyCleanPass: true,
        cleanTree: 'clean-pass',
        dirtyOnlyFiles: [],
      }),
    );
    const r = await one({ id: 'F-COV', state: 'done', completion });

    expect(r.ok).toBe(true);
    expect(closeCoverageRead.compute).toHaveBeenCalledTimes(1);
    expect(r).not.toHaveProperty('closeCoverageWarning');
  });

  it('a failing coverage read neither refuses nor fails the close', async () => {
    closeCoverageRead.compute.mockRejectedValue(new Error('test_runs read failed'));
    const r = await one({ id: 'F-COV', state: 'done', completion });

    expect(r.ok).toBe(true);
    expect(setWorkItemStateWithAliasInfo.mock.calls.at(-1)?.[1]).toBe('done');
    expect(r).not.toHaveProperty('closeCoverageWarning');
    expect(String(r.stateError ?? '')).not.toMatch(/coverage/i);
  });

  it('an item with no claim window is never read', async () => {
    getWorkItem.mockResolvedValue({ ...held, takenAt: null, createdAt: null });
    closeCoverageRead.compute.mockResolvedValue(report());
    const r = await one({ id: 'F-COV', state: 'done', completion });

    expect(r.ok).toBe(true);
    expect(closeCoverageRead.compute).not.toHaveBeenCalled();
    expect(r).not.toHaveProperty('closeCoverageWarning');
  });
});
