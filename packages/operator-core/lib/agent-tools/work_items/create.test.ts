/**
 * create.test.ts — work_items:create handler, dual-arity keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). The per-item core (`createOneWorkItem`)
 * is mocked — this exercises the tool's normalization (single spec OR items:[…] +
 * batch-level harness / workspace / assign_all_to_self) and the keyed-array envelope
 * that RETIRED work_items:create_batch. Each result self-describes; a mirror-duplicate
 * fails only that item.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fleetAdmission = vi.hoisted(() => ({
  decision: { allowed: true, scoped: false } as any,
  admit: vi.fn(async () => fleetAdmission.decision),
  notify: vi.fn(),
  remedy: vi.fn(() => 'remedy: scheduler:set_claim_spec { … }'),
}));
const workScope = vi.hoisted(() => ({
  decision: { allowed: true, reason: 'no-policy' } as any,
  gate: vi.fn(async () => workScope.decision),
}));
const modeState = vi.hoisted(() => ({
  rows: [] as Array<{ mode: string; setAt: string }>,
}));
const drainAdmission = vi.hoisted(() => ({
  blocked: false,
  gate: vi.fn(),
}));
// EI-20450339646861882: the caller's DECLARED plan lane, read through the same
// presence seam the coord send path uses. Null = "on no plan", which must never nudge.
const presenceState = vi.hoisted(() => ({
  currentPlanSlug: null as string | null,
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'me' }),
  resolveSelfLiteral: (value: string | undefined, callerOwnerId: string) => (value === 'self' ? callerOwnerId : value),
}));
vi.mock('./_create-core', () => ({ createOneWorkItem: vi.fn() }));
const phoneAdmission = vi.hoisted(() => ({ admit: vi.fn() }));
vi.mock('../../blueprint/phone-producer-admission', () => ({ admitConfiguredPhoneProducer: phoneAdmission.admit }));
vi.mock('../../modes/store', () => ({ getModes: vi.fn(async () => modeState.rows) }));
vi.mock('./drain-flow', () => ({ withDrainBugAdmission: drainAdmission.gate }));
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  admitSubjectForFleetTarget: fleetAdmission.admit,
  notifyFleetScopeRefusal: fleetAdmission.notify,
  fleetScopeLeaderRemedy: fleetAdmission.remedy,
}));
vi.mock('../../work-scope-policy', () => ({ gateWorkScope: workScope.gate }));
// Create-time dedup port (P-009) — mock so this handler test stays hermetic
// (the memory-pools leg is pinned in memory/claim-port.test.ts).
// EI-23701433507513915: the holder-identity rules run for real, against an owner registry this
// file controls, instead of coord presence.
const OWNER_REGISTRY = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('../../work-item-holder-identity', async (importOriginal) => {
  const { registryBackedHolderIdentity } = await import('../../work-item-holder-identity.testing');
  return registryBackedHolderIdentity(await importOriginal(), OWNER_REGISTRY);
});
vi.mock('../../memory/claim-port', () => ({ buildClaimRecallBlock: vi.fn(async () => null) }));
// EI-20450339646861882: create.ts reaches this module through a DYNAMIC import
// (EI-19281789650149592 — a static one makes partially-mocked suites fail at
// collection), so the mock is what the nudge's lane lookup resolves to.
vi.mock('../coordination/presence', () => ({
  getPresence: vi.fn(async () => ({ currentPlanSlug: presenceState.currentPlanSlug })),
}));

import { createOneWorkItem, type CreateOneWorkItemResult } from './_create-core';
import { mockResolvedOnceTyped } from '../../testing/typed-mock';
import type { WorkItem } from '../../work-items';
import { assessIssueAdmissionPressure } from '../../issue-occurrence-ledger';
const createM = vi.mocked(createOneWorkItem);

/**
 * COMPLETE typed fixtures, so the mocks below are checked against the real
 * `createOneWorkItem` signature instead of escaping through `as never`
 * (EI-19282401068515102 / lint:mock-cast-escape). A cast on a mock defeats the one
 * guarantee `vi.mocked()` exists to give: when the real result type gains a required
 * field, a cast fixture goes stale INVISIBLY and fails at runtime in some unrelated
 * peer's green-checkpoint hours later. With these, it is a compile error right here.
 */
const aWorkItem = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 'WI-1',
  kind: 'bug',
  family: 'issue',
  harness: 'papercup',
  title: 'a title',
  summary: '',
  state: 'open',
  assignee: null,
  takenAt: null,
  lastProgressAt: null,
  assignedBy: null,
  createdBy: null,
  severity: null,
  parent: null,
  payload: null,
  origin: null,
  auditVerdict: null,
  verifiedAuthorGithubUserId: null,
  rank: null,
  rankWriter: null,
  rankUpdatedAt: null,
  priority: null,
  terminalOwner: null,
  terminalCompletionRef: null,
  terminalCompletionEvidence: null,
  completionAuthority: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  closedAt: null,
  goalId: null,
  ...over,
});

/** The ok:true arm of a core create, keyed off the spec's title like the real thing. */
type OkCore = Extract<CreateOneWorkItemResult, { ok: true }>;
const okCore = (title: string, over: Partial<OkCore> = {}): CreateOneWorkItemResult => ({
  ok: true,
  workItem: aWorkItem({ id: `WI-${title}`, title }),
  ...over,
});
const createModule = await import('./create');
const tool = createModule.default;
const codeSmellsLikeCode = createModule.codeSmellsLikeCode;
const createMaxConcurrency = createModule.WORK_ITEMS_CREATE_MAX_CONCURRENCY;

const ctx = { workspaceId: 'default', harnessSlug: 'papercup' } as never;
const parse = (x: unknown) => (tool.args as { parse: (x: unknown) => unknown }).parse(x);
type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(parse(args) as never, ctx)) as Out).data);

beforeEach(() => {
  vi.clearAllMocks();
  OWNER_REGISTRY.ids = [];
  modeState.rows = [];
  drainAdmission.blocked = false;
  drainAdmission.gate.mockImplementation(async (_args, persist) => {
    const flow = {
      exact: true,
      totals: { opened: drainAdmission.blocked ? 1 : 0, terminaled: 0, net: drainAdmission.blocked ? 1 : 0 },
      breaker: { tripped: drainAdmission.blocked, blocksNewBugs: drainAdmission.blocked },
    };
    return drainAdmission.blocked
      ? { ok: true, allowed: false, code: 'drain_flow_circuit_open', message: 'terminal one first', flow }
      : { ok: true, allowed: true, flow, value: await persist(flow) };
  });
  fleetAdmission.decision = { allowed: true, scoped: false };
  workScope.decision = { allowed: true, reason: 'no-policy' };
  createM.mockImplementation(async (spec) => okCore(spec.title));
});

describe('Phone producer admission', () => {
  it('routes a room selector with the transport principal, without ordinary create', async () => {
    const principal = { kind: 'service', slug: 'voice-service' };
    phoneAdmission.admit.mockResolvedValue({ workItemId: 'WI-voice' });
    const args = parse({ phone_producer: { roomName: 'room-a' }, harness: 'phone-app' });
    const result = await tool.handler(args as never, { principal, workspaceId: 'workspace' } as never) as Out;
    expect(phoneAdmission.admit).toHaveBeenCalledWith(principal, 'room-a', { harness: 'phone-app', workspace: 'workspace' });
    expect(result.data.results[0].id).toBe('WI-voice');
    expect(createM).not.toHaveBeenCalled();
  });
  it("does not treat the operator '*' context as a requested harness", async () => {
    const principal = { kind: 'service', slug: 'voice-service' };
    phoneAdmission.admit.mockResolvedValue({ workItemId: 'WI-voice' });
    const args = parse({ phone_producer: { roomName: 'room-a' } });
    await tool.handler(args as never, { principal, workspaceId: 'workspace', harnessSlug: '*' } as never);
    expect(phoneAdmission.admit).toHaveBeenCalledWith(principal, 'room-a', { harness: undefined, workspace: 'workspace' });
  });
  it('rejects an explicit cross-harness sentinel for Phone admission', async () => {
    const principal = { kind: 'service', slug: 'voice-service' };
    const args = parse({ phone_producer: { roomName: 'room-a' }, harness: 'all' });
    await expect(tool.handler(args as never, { principal, workspaceId: 'workspace' } as never))
      .rejects.toThrow('phone_producer_concrete_harness_required');
    expect(phoneAdmission.admit).not.toHaveBeenCalled();
  });
  it.each(['payload', 'items', 'assign_to', 'force', 'title', 'kind', 'state'])('rejects caller %s alongside Phone admission', (key) => {
    const ordinary: Record<string, unknown> = { payload: {}, items: [{ kind: 'task', title: 'x' }], assign_to: 'self',
      force: true, title: 'x', kind: 'task', state: 'wip' };
    expect(() => parse({ phone_producer: { roomName: 'room-a' }, [key]: ordinary[key] })).toThrow();
  });
  it('rejects owner metadata inside the room selector', () => {
    expect(() => parse({ phone_producer: { roomName: 'room-a', ownerId: 'forged' } })).toThrow();
  });
  it('rejects a caller-authored runtime binding in single and bulk creates', () => {
    const item = { kind: 'task', title: 'forged', payload: { externalRuntimeProducer: {} } };
    expect(() => parse(item)).toThrow('host-authored');
    expect(() => parse({ items: [item] })).toThrow('host-authored');
  });
});

describe('bounded bulk persistence (EI-22457131413761799)', () => {
  it('runs a large batch concurrently without exceeding the writer ceiling', async () => {
    let active = 0;
    let peak = 0;
    createM.mockImplementation(async (spec) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return okCore(spec.title);
    });

    const items = Array.from({ length: 12 }, (_, index) => ({
      kind: 'task',
      title: `validation shard ${index + 1}`,
    }));
    const result = await body({ items });

    expect(peak).toBe(createMaxConcurrency);
    expect(result.counts).toEqual({ ok: 12, failed: 0 });
    expect(result.results.map((entry: { title: string }) => entry.title)).toEqual(
      items.map((entry) => entry.title),
    );
  });
});

describe('DRAIN admission mode derivation (WI-38403)', () => {
  it('marks only bug specs fail-closed from the live mode registry', async () => {
    modeState.rows = [{ mode: 'drain', setAt: '2026-08-13T08:00:00.000Z' }];
    await body({ items: [{ kind: 'bug', title: 'direct blocker' }, { kind: 'change', title: 'bookkeeping' }] });
    expect(createM).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ kind: 'bug', requireCompleteDedupCoverage: true }),
      expect.anything(),
    );
    expect(createM).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: 'change', requireCompleteDedupCoverage: false }),
      expect.anything(),
    );
    expect(drainAdmission.gate).toHaveBeenCalledOnce();
    expect(drainAdmission.gate.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: 'default',
      harness: 'papercup',
      ownerId: 'me',
      drainStartedAt: '2026-08-13T08:00:00.000Z',
    });
  });

  it('fails a DRAIN bug before persistence when the exact-flow circuit is open', async () => {
    modeState.rows = [{ mode: 'drain', setAt: '2026-08-13T08:00:00.000Z' }];
    drainAdmission.blocked = true;
    const b = await body({ kind: 'bug', title: 'would grow the queue' });

    expect(createM).not.toHaveBeenCalled();
    expect(b.results[0]).toMatchObject({
      ok: false,
      error: 'drain_flow_circuit_open',
      message: 'terminal one first',
      drainFlow: { exact: true, totals: { opened: 1, terminaled: 0, net: 1 } },
    });
  });

  it('does not apply the bug circuit to non-bug work during DRAIN', async () => {
    modeState.rows = [{ mode: 'drain', setAt: '2026-08-13T08:00:00.000Z' }];
    drainAdmission.blocked = true;
    const b = await body({ kind: 'change', title: 'repair existing code' });

    expect(b.results[0]).toMatchObject({ ok: true });
    expect(drainAdmission.gate).not.toHaveBeenCalled();
    expect(createM).toHaveBeenCalledOnce();
  });
});

describe('codeSmellsLikeCode + the task nudge (WI-2874)', () => {
  it('flags code work via structural signals (source path / file ext / backticked ident / edit verbs)', () => {
    expect(codeSmellsLikeCode('Fix packages/operator-core/lib/foo.ts race')).toBe(true);
    expect(codeSmellsLikeCode('Update the docs-qa.ts endpoint')).toBe(true);
    expect(codeSmellsLikeCode('Rename `myHelperFn` in the resolver')).toBe(true);
    expect(codeSmellsLikeCode('Refactor the claim path', 'implement the new guard')).toBe(true);
  });
  it('does NOT flag genuine non-code tasks (false positives would be harmless anyway — it never blocks)', () => {
    expect(codeSmellsLikeCode('Research the best charting library for the dashboard')).toBe(false);
    expect(codeSmellsLikeCode('Decide whether to sunset the classic lexicon')).toBe(false);
    expect(codeSmellsLikeCode('Manually verify the 2-box federation drill on the rig')).toBe(false);
  });
  it('a code-smelling TASK is still created, with a non-blocking warning', async () => {
    const b = await body({ kind: 'task', title: 'refactor packages/foo/bar.ts' });
    expect(b.results[0]).toMatchObject({ ok: true });
    expect(b.results[0].warning).toMatch(/NON-CODE only/);
  });
  it('a genuine non-code TASK gets NO warning', async () => {
    const b = await body({ kind: 'task', title: 'research the best date library' });
    expect(b.results[0].warning).toBeUndefined();
  });
  it('the nudge is task-only — a code-smelling change/bug is never warned', async () => {
    const b = await body({ kind: 'change', title: 'fix packages/foo/bar.ts' });
    expect(b.results[0].warning).toBeUndefined();
  });
});

describe('explicit payload.paths advisory (EI-20191260047847804)', () => {
  it('surfaces the core path warning without changing the successful create result', async () => {
    createM.mockResolvedValue(
      okCore('source path spelling drift', {
        explicitPathsWarning: 'work_items:create recorded explicit payload.paths that do NOT exist',
      }),
    );
    const b = await body({ kind: 'bug', title: 'source path spelling drift' });
    expect(b.results[0]).toMatchObject({
      ok: true,
      explicitPathsWarning: expect.stringContaining('do NOT exist'),
    });
  });

  it('does not invent a warning when the core has none', async () => {
    const b = await body({ kind: 'bug', title: 'ordinary filing' });
    expect(b.results[0].explicitPathsWarning).toBeUndefined();
  });
});

// EI-18655063958515097: "a residual split off a closing plan item silently leaves
// the lane — no plan link, not claimable, parent reads done while its acceptance
// ask is unmet". Non-blocking nudge (never refuses the create) when a residual-
// smelling item is filed with no plan_item/targetPlanItem link.
describe('residualLinkNudge (EI-18655063958515097)', () => {
  it('nudges when a residual-smelling item is created with no plan_item link', async () => {
    const b = await body({
      kind: 'bug',
      title: 'residual: the real second frame acceptance ask was not met, split off from P-413',
    });
    expect(b.results[0]).toMatchObject({ ok: true });
    expect(b.results[0].residualLinkNudge).toMatch(/plan_item/);
  });

  it('does NOT nudge when plan_item is already set (properly linked)', async () => {
    const b = await body({
      kind: 'bug',
      title: 'residual: split off from P-413, real second frame not met',
      plan_item: { slug: 'some-plan', item: 'P-413' },
    });
    expect(b.results[0].residualLinkNudge).toBeUndefined();
  });

  it('does NOT nudge on an ordinary (non-residual-smelling) item', async () => {
    const b = await body({ kind: 'bug', title: 'fix the login race condition' });
    expect(b.results[0].residualLinkNudge).toBeUndefined();
  });

  it('works in the bulk items:[…] path too', async () => {
    const b = await body({
      items: [
        { kind: 'bug', title: 'split off the remaining acceptance criteria' },
        { kind: 'bug', title: 'a totally unrelated fix' },
      ],
    });
    expect(b.results[0].residualLinkNudge).toMatch(/plan_item/);
    expect(b.results[1].residualLinkNudge).toBeUndefined();
  });
});

// staging-build-tool-routing-2026-10-21 R-5: a filing that defers non-final work behind the
// :3070 deploy is created AND told the staging route; an ordinary filing carries nothing.
describe('deployWaitAdvisory (staging-build-tool-routing-2026-10-21 R-5)', () => {
  it('creates the item and names build:staging when it waits on the :3070 deploy', async () => {
    const b = await body({
      kind: 'change',
      title: 'Accept the new rubric tool',
      summary: 'Blocked until the fix is deployed to :3070, then run the acceptance check.',
    });
    expect(b.results[0]).toMatchObject({ ok: true });
    expect(b.results[0].deployWaitAdvisory).toContain("build: 'staging'");
  });

  it('adds nothing to an ordinary filing', async () => {
    const b = await body({ kind: 'bug', title: 'fix the login race condition' });
    expect(b.results[0].deployWaitAdvisory).toBeUndefined();
  });
});

// EI-20450339646861882: "a high-severity bug filed while on a plan lane, with no
// plan-item edge, is invisible in BOTH directions at once — unclaimable by the
// plan-scoped spec AND missing from any enumeration of that plan's open blockers".
// The nudge must point at the `blocks` EDGE, never at the plan_item COVERAGE stamp:
// that stamp is one-live-row-per-lane (D-046) and flips its plan item done on
// completion, so steering a blocker there would collide and arm EI-20576535595925497.
describe('planItemBlockerNudge (EI-20450339646861882)', () => {
  beforeEach(() => {
    presenceState.currentPlanSlug = null;
  });

  it('nudges a critical issue filed on a declared lane with no plan-item edge', async () => {
    presenceState.currentPlanSlug = 'sidestage-public-release-testing-2026-08-14';
    const b = await body({ kind: 'bug', severity: 'critical', title: 'deploy.sh --help performs a real deploy' });
    expect(b.results[0]).toMatchObject({ ok: true });
    expect(b.results[0].planItemBlockerNudge).toContain('sidestage-public-release-testing-2026-08-14');
  });

  // The load-bearing assertion: this is what makes the nudge a FIX rather than a
  // restatement of the refuted proposal. Steering a blocker to plan_item is the bug.
  it("recommends the blocks EDGE and explicitly warns OFF the plan_item coverage stamp", async () => {
    presenceState.currentPlanSlug = 'some-plan';
    const b = await body({ kind: 'bug', severity: 'major', title: 'unauthenticated revenue endpoint' });
    const nudge = b.results[0].planItemBlockerNudge as string;
    expect(nudge).toMatch(/rel: 'blocks'/);
    expect(nudge).toMatch(/target_kind: 'plan_item'/);
    expect(nudge).toMatch(/Do NOT use plan_item/);
  });

  it('does NOT nudge when the caller is on no plan lane', async () => {
    presenceState.currentPlanSlug = null;
    const b = await body({ kind: 'bug', severity: 'critical', title: 'prod npm advisories' });
    expect(b.results[0].planItemBlockerNudge).toBeUndefined();
  });

  it('does NOT nudge when a plan_item is already set', async () => {
    presenceState.currentPlanSlug = 'some-plan';
    const b = await body({
      kind: 'bug',
      severity: 'critical',
      title: 'already linked',
      plan_item: { slug: 'some-plan', item: 'P-009' },
    });
    expect(b.results[0].planItemBlockerNudge).toBeUndefined();
  });

  it('does NOT nudge when an inline links[] entry already targets a plan_item', async () => {
    presenceState.currentPlanSlug = 'some-plan';
    const b = await body({
      kind: 'bug',
      severity: 'critical',
      title: 'linked via the blocks edge at birth',
      links: [{ rel: 'blocks', target_kind: 'plan_item', target_ref: 'some-plan#P-009' }],
    });
    expect(b.results[0].planItemBlockerNudge).toBeUndefined();
  });

  // Volume guard: severity is issue-family-only, and minor/nit are not the
  // "fix-loop / prod-surface blocker" population the rule was written for. Without
  // this the advisory would fire across the high-volume observation lane.
  it('does NOT nudge a minor issue, even on a declared lane', async () => {
    presenceState.currentPlanSlug = 'some-plan';
    const b = await body({ kind: 'bug', severity: 'minor', title: 'tidy a log line' });
    expect(b.results[0].planItemBlockerNudge).toBeUndefined();
  });
});

describe('work_items:create handler (keyed-array)', () => {
  it('creates one inline and returns { ok, id, title, workItem }', async () => {
    const b = await body({ kind: 'bug', title: 'boom' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-boom', title: 'boom', workItem: { id: 'WI-boom' } });
    expect(createM).toHaveBeenCalledTimes(1);
  });

  // EI-20075667133396690. This result row is REBUILT from an allowlist, not spread
  // from the core's result, so a core outcome field reaches the agent only if this
  // handler names it. `goalId` was returned by the core since P-002 and, because
  // nobody named it here, never once surfaced — the field existed and had no reader.
  // These two pin the wire, which is the half that silently rots: the core-level
  // tests in _create-core.goal-stamp-silence.test.ts can stay green forever while
  // the agent sees nothing.
  it('surfaces goalId from the core to the caller', async () => {
    createM.mockImplementation(async (spec) => okCore(spec.title, { goalId: 'goal-abc' }));
    const b = await body({ kind: 'bug', title: 'boom' });
    expect(b.results[0].goalId).toBe('goal-abc');
  });

  it('surfaces goalStampError — the item is filed, but its goal attribution was NOT recorded', async () => {
    createM.mockImplementation(async (spec) =>
      okCore(spec.title, { goalStampError: 'column "goal_id" does not exist' }),
    );
    const b = await body({ kind: 'bug', title: 'boom' });
    // Still ok:true — the stamp is a decoration and must never fail a creation.
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-boom' });
    // ...but the caller is told, and told what it COSTS, not just that it threw.
    expect(b.results[0].goalStampError).toMatch(/goal attribution was NOT recorded/);
    expect(b.results[0].goalStampError).toMatch(/column "goal_id" does not exist/);
  });

  it('surfaces queueAdmission on a successful pass-through create', async () => {
    const queueAdmission = assessIssueAdmissionPressure({
      rawOccurrences: 2_949,
      duplicateOccurrences: 455,
      canonicalStock: 2_494,
      canonicalClusterCounts: Array.from({ length: 140 }, () => 21),
      emitterCounts: Array.from({ length: 90 }, () => 33),
    });
    createM.mockImplementation(async (spec) => okCore(spec.title, { queueAdmission }));
    const b = await body({ kind: 'bug', title: 'broad cohort item' });
    expect(b.results[0].queueAdmission).toEqual(queueAdmission);
  });

  it('surfaces degraded dedup coverage as a visible warning on successful creates', async () => {
    createM.mockImplementation(async (spec) =>
      okCore(spec.title, {
        dedupCoverage: { lexical: 'unavailable', semantic: 'unavailable', degraded: true },
      }),
    );
    const b = await body({ kind: 'bug', title: 'embedder unavailable while filing' });

    expect(b.results[0]).toMatchObject({
      ok: true,
      dedupCoverage: { lexical: 'unavailable', semantic: 'unavailable', degraded: true },
      warning: expect.stringContaining('dedup coverage is degraded'),
    });
    expect(b.results[0].warning).toContain('lexical=unavailable');
    expect(b.results[0].warning).toContain('semantic=unavailable');
    expect(b.results[0].warning).toContain('differently-worded duplicate may not have been found');
  });

  it('does not add a dedup warning when coverage is healthy', async () => {
    createM.mockImplementation(async (spec) =>
      okCore(spec.title, {
        dedupCoverage: { lexical: 'ok', semantic: 'ok', degraded: false },
      }),
    );
    const b = await body({ kind: 'bug', title: 'healthy dedup coverage' });

    expect(b.results[0]).toMatchObject({
      ok: true,
      dedupCoverage: { lexical: 'ok', semantic: 'ok', degraded: false },
    });
    expect(b.results[0].warning).toBeUndefined();
  });

  it('preserves the task-kind warning while adding degraded coverage context', async () => {
    createM.mockImplementation(async (spec) =>
      okCore(spec.title, {
        dedupCoverage: { lexical: 'ok', semantic: 'unavailable', degraded: true },
      }),
    );
    const b = await body({ kind: 'task', title: 'refactor packages/foo/bar.ts' });

    expect(b.results[0].warning).toContain('task` is NON-CODE only');
    expect(b.results[0].warning).toContain('dedup coverage is degraded');
  });

  it('surfaces queueAdmission and canonical identity on a coalesced non-creation', async () => {
    const queueAdmission = assessIssueAdmissionPressure({
      rawOccurrences: 455,
      duplicateOccurrences: 455,
      canonicalStock: 2_494,
      canonicalClusterCounts: [455],
      emitterCounts: [455],
    });
    createM.mockResolvedValue({
      ok: false,
      error: 'coalesced',
      message: 'preserved as occurrence',
      existing: { id: 'EI-57', state: 'open' },
      similarOpen: [],
      admissionIdentity: { schemaVersion: 'admission-identity-v1', titleKey: 'title:burst report' },
      dedupCoverage: { lexical: 'ok', semantic: 'ok', degraded: false },
      queueAdmission,
    });
    const b = await body({ kind: 'bug', title: 'burst report' });
    expect(b.results[0]).toMatchObject({
      ok: false,
      error: 'coalesced',
      existing: { id: 'EI-57' },
      admissionIdentity: { titleKey: 'title:burst report' },
      dedupCoverage: { degraded: false },
      queueAdmission: { active: true, rawOccurrences: 455, canonicalStock: 2_494 },
    });
  });

  it('CONTROL: an ordinary create (no goal) carries neither goal field', async () => {
    const b = await body({ kind: 'bug', title: 'boom' });
    expect(b.results[0].goalId).toBeUndefined();
    expect(b.results[0].goalStampError).toBeUndefined();
  });

  it('creates MANY via items:[…] — one self-describing result per item', async () => {
    const b = await body({ items: [{ kind: 'bug', title: 'a' }, { kind: 'change', title: 'b' }] });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { id: string }) => r.id)).toEqual(['WI-a', 'WI-b']);
  });

  it('assign_all_to_self claims every item unless the item overrides via assign_to', async () => {
    await body({ items: [{ kind: 'bug', title: 'a' }, { kind: 'bug', title: 'b', assign_to: 'bee-7' }], assign_all_to_self: true });
    expect(createM).toHaveBeenNthCalledWith(1, expect.objectContaining({ title: 'a', assign_to: 'me' }), expect.anything());
    expect(createM).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: 'b', assign_to: 'bee-7' }), expect.anything());
  });

  it('EI-7766: assign_to:"self" resolves to the caller ownerId, not the literal string (single-create path)', async () => {
    await body({ kind: 'bug', title: 'a', assign_to: 'self' });
    expect(createM).toHaveBeenCalledWith(expect.objectContaining({ title: 'a', assign_to: 'me' }), expect.anything());
    expect(fleetAdmission.admit).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'me', createdBy: 'me', subject: expect.objectContaining({ kind: 'bug' }) }),
    );
  });

  it('EI-7766: assign_to:"self" resolves to the caller ownerId in the bulk items[] path too', async () => {
    await body({ items: [{ kind: 'bug', title: 'a', assign_to: 'self' }, { kind: 'bug', title: 'b', assign_to: 'bee-7' }] });
    expect(createM).toHaveBeenNthCalledWith(1, expect.objectContaining({ title: 'a', assign_to: 'me' }), expect.anything());
    expect(createM).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: 'b', assign_to: 'bee-7' }), expect.anything());
  });

  it('a concrete assign_to ownerId is passed through unchanged (not confused with "self")', async () => {
    await body({ kind: 'bug', title: 'a', assign_to: 'someone-else' });
    expect(createM).toHaveBeenCalledWith(expect.objectContaining({ title: 'a', assign_to: 'someone-else' }), expect.anything());
  });

  // EI-18784357226895330: an out-of-scope create+assign DOWNGRADES to an unassigned
  // FILE — it is never refused outright. A claim spec fences the PULL from the shared
  // pool, not the act of recording a finding. The prior behavior (refuse the create)
  // left a critical fleet-wide bug with no owner AND no durable record.
  describe('out-of-scope create+assign (fleet lane)', () => {
    const outOfScope = {
      allowed: false,
      scoped: true,
      code: 'fleet_scope_violation',
      reason: 'new item is outside fixed cohort',
      scope: { fleetSlug: 'fixed-wave', ownerId: 'bee-7', fleetRole: 'member', record: { spec: { specId: 'fixed', revision: 7 } } },
    };

    it('FILES the item unassigned rather than refusing the create', async () => {
      fleetAdmission.decision = { ...outOfScope };
      const b = await body({ kind: 'bug', title: 'outside', assign_to: 'bee-7' });
      // the finding survives...
      expect(b.results[0]).toMatchObject({ ok: true });
      expect(createM).toHaveBeenCalledOnce();
      // ...but NO out-of-scope claim was created.
      expect(createM.mock.calls[0][0]).toMatchObject({
        title: 'outside',
        assign_to: undefined,
        admissionBypass: 'bypass:explicit-assignment',
        payload: {
          fleetScopeDowngrade: {
            requestedAssignee: 'bee-7',
            reportedBy: 'me',
            fleet: 'fixed-wave',
            code: 'fleet_scope_violation',
          },
        },
      });
      // EI-22457572700056749: the refused assignment is stripped, but the
      // durable fallback must not also be claim-held; otherwise no lane can
      // adopt the filed finding without a second, hidden override.
      expect(createM.mock.calls[0][0].payload).not.toHaveProperty('_claimHold');
      expect(fleetAdmission.notify).toHaveBeenCalledOnce();
    });

    it('keeps a fleet_scope_missing downgrade born-admitted without granting the missing-scope claim', async () => {
      fleetAdmission.decision = {
        ...outOfScope,
        code: 'fleet_scope_missing',
        reason: 'member has no explicit per-member or inherited fleet claim spec',
      };
      const b = await body({ kind: 'task', title: 'plan ownership', assign_to: 'bee-7' });

      expect(b.results[0]).toMatchObject({ ok: true });
      expect(b.results[0].fleetScopeDowngrade).toMatch(/FILED UNASSIGNED/);
      expect(createM.mock.calls[0][0]).toMatchObject({
        assign_to: undefined,
        admissionBypass: 'bypass:explicit-assignment',
        payload: {
          fleetScopeDowngrade: { code: 'fleet_scope_missing', requestedAssignee: 'bee-7' },
        },
      });
      expect(createM.mock.calls[0][0].payload).not.toHaveProperty('_claimHold');
    });

    it('renders missing-scope repairs in the receipt and leader message with the persisted id', async () => {
      fleetAdmission.decision = { ...outOfScope, code: 'fleet_scope_missing' };
      const result = await body({ kind: 'task', title: 'append repair', harness: 'papercusp', assign_to: 'bee-7' });
      expect(result.results[0]).toMatchObject({ ok: true, id: 'WI-append repair' });
      expect(fleetAdmission.notify).toHaveBeenCalledWith(
        expect.anything(), fleetAdmission.decision,
        'work_items:create+assign WI-append repair → bee-7',
        { harness: 'papercusp', subject: { itemId: 'WI-append repair', member: 'bee-7' } },
      );
      expect(fleetAdmission.remedy).toHaveBeenCalledWith(
        fleetAdmission.decision, undefined, undefined, null, 'WI-append repair', 'papercusp',
      );
      expect(createM.mock.invocationCallOrder[0]).toBeLessThan(fleetAdmission.notify.mock.invocationCallOrder[0]);
    });

    it('does not notify the leader about an item that failed to persist', async () => {
      fleetAdmission.decision = { ...outOfScope, code: 'fleet_scope_missing' };
      mockResolvedOnceTyped(createM, { ok: false, error: 'invalid', message: 'fixture refusal' });
      const result = await body({ kind: 'task', title: 'append refused', assign_to: 'bee-7' });
      expect(result.results[0].ok).toBe(false);
      expect(fleetAdmission.notify).not.toHaveBeenCalled();
      expect(fleetAdmission.remedy).not.toHaveBeenCalled();
    });

    it('records the requester as reporter so the filing stays attributable', async () => {
      fleetAdmission.decision = { ...outOfScope };
      await body({ kind: 'bug', title: 'outside', assign_to: 'bee-7' });
      expect(createM.mock.calls[0][0].payload).toMatchObject({
        fleetScopeDowngrade: { requestedAssignee: 'bee-7', reportedBy: 'me', fleet: 'fixed-wave', code: 'fleet_scope_violation' },
      });
      expect(createM.mock.calls[0][0].payload).not.toHaveProperty('_claimHold');
    });

    it('tells the caller plainly they do NOT hold it, with the leader remedy', async () => {
      fleetAdmission.decision = { ...outOfScope };
      const b = await body({ kind: 'bug', title: 'outside', assign_to: 'bee-7' });
      expect(b.results[0].fleetScopeDowngrade).toMatch(/FILED UNASSIGNED/);
      expect(b.results[0].fleetScopeDowngrade).toMatch(/you do NOT hold it/);
      // EI-18673501896258575: the caller sees the SAME concrete remedy the leader was
      // notified with, not just a bare refusal reason.
      expect(b.results[0].fleetScopeDowngrade).toMatch(/remedy: scheduler:set_claim_spec/);
    });

    it('a WOUND-DOWN fleet also files: recording a finding is not acquiring work', async () => {
      fleetAdmission.decision = { ...outOfScope, code: 'fleet_winding_down', reason: 'fleet is paused' };
      const b = await body({ kind: 'bug', title: 'found during stand-down', assign_to: 'bee-7' });
      expect(b.results[0]).toMatchObject({ ok: true });
      expect(createM.mock.calls[0][0]).toMatchObject({ assign_to: undefined });
    });

    it('leaves an IN-scope create+assign completely untouched', async () => {
      fleetAdmission.decision = { allowed: true, scoped: true };
      const b = await body({ kind: 'bug', title: 'inside', assign_to: 'bee-7' });
      expect(b.results[0].fleetScopeDowngrade).toBeUndefined();
      expect(createM.mock.calls[0][0]).toMatchObject({ assign_to: 'bee-7' });
      expect(fleetAdmission.notify).not.toHaveBeenCalled();
    });

    // EI-23701433507513915: a short-form assignee (`su-851c1a7a`) was persisted verbatim as the
    // holder, and every exact holder check then refused the real holder.
    it('expands a short-form assign_to to the unique full id BEFORE admission and persistence', async () => {
      const full = 'su-851c1a7a-8ea6-4c70-afeb-472e957fd3d8';
      OWNER_REGISTRY.ids = [full];
      const b = await body({ kind: 'bug', title: 'short assignee', assign_to: 'su-851c1a7a' });
      expect(b.results[0].assigneeResolutionDowngrade).toBeUndefined();
      expect(createM.mock.calls[0][0]).toMatchObject({ assign_to: full });
    });

    it('files an UNRESOLVABLE short-form assign_to unassigned, with the reason on the ok:true result', async () => {
      const b = await body({ kind: 'bug', title: 'unknown assignee', assign_to: 'su-deadbeef' });
      expect(b.results[0].assigneeResolutionDowngrade).toMatch(/FILED UNASSIGNED/);
      const persisted = createM.mock.calls[0][0] as { assign_to?: string; admissionBypass?: string; payload?: unknown };
      expect(persisted.assign_to).toBeUndefined();
      expect(persisted.admissionBypass).toBe('bypass:explicit-assignment');
      expect(persisted.payload).toMatchObject({
        assigneeResolutionDowngrade: { requestedAssignee: 'su-deadbeef', code: 'assignee_short_form_unresolved' },
      });
    });
  });

  it('batch-level harness is the default for items that omit one', async () => {
    await body({ items: [{ kind: 'feature', title: 'a' }], harness: 'h-default' });
    expect(createM).toHaveBeenCalledWith(expect.objectContaining({ title: 'a', harness: 'h-default' }), expect.anything());
  });

  it('threads explicit routing intent + cadence through single and bulk creates', async () => {
    await body({
      kind: 'task',
      title: 'daily digest',
      routing_intent: 'schedule-recurrence',
      cadence: 'daily at 09:00',
    });
    expect(createM).toHaveBeenLastCalledWith(
      expect.objectContaining({
        routing_intent: 'schedule-recurrence',
        cadence: 'daily at 09:00',
      }),
      expect.anything(),
    );

    await body({
      items: [{
        kind: 'task',
        title: 'release alert',
        routing_intent: 'watch-alert',
      }],
    });
    expect(createM).toHaveBeenLastCalledWith(
      expect.objectContaining({ routing_intent: 'watch-alert' }),
      expect.anything(),
    );
  });

  it('a mirror-duplicate fails only that item (carries error + existing), batch still runs', async () => {
    createM.mockImplementation(async (spec) =>
      spec.title === 'dup'
        ? { ok: false, error: 'duplicate_mirror', message: 'references WI-9', existing: { id: 'WI-9', state: 'open' } }
        : okCore(spec.title),
    );
    const b = await body({ items: [{ kind: 'bug', title: 'ok' }, { kind: 'bug', title: 'dup' }] });
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toMatchObject({ ok: false, title: 'dup', error: 'duplicate_mirror', existing: { id: 'WI-9' } });
  });
});

describe('out-of-scope create+assign (workspace policy)', () => {
  it('files the finding pending and unassigned without creating a claim', async () => {
    workScope.decision = {
      allowed: false,
      code: 'scope_denied',
      harness: 'sb-devboard-hive',
      allowHarnesses: ['papercusp'],
      message: "scope_denied: harness 'sb-devboard-hive' is outside the workspace work-scope policy",
    };

    const b = await body({ kind: 'bug', title: 'workspace-outside', harness: 'sb-devboard-hive', assign_to: 'bee-7' });

    expect(b.results[0]).toMatchObject({
      ok: true,
      workScopeDowngrade: expect.stringContaining('FILED UNASSIGNED'),
    });
    expect(createM).toHaveBeenCalledOnce();
    expect(createM.mock.calls[0][0]).toMatchObject({
      title: 'workspace-outside',
      harness: 'sb-devboard-hive',
      assign_to: undefined,
      payload: {
        workScopeDowngrade: {
          requestedAssignee: 'bee-7',
          reportedBy: 'me',
          harness: 'sb-devboard-hive',
          code: 'scope_denied',
        },
      },
    });
    expect(createM.mock.calls[0][0]).not.toHaveProperty('admissionBypass');
    expect(fleetAdmission.admit).not.toHaveBeenCalled();
  });

  it('passes the create harness and implementing plan to the workspace gate', async () => {
    await body({
      kind: 'change',
      title: 'planned assignment',
      harness: 'sb-devboard-hive',
      assign_to: 'bee-7',
      plan_item: { slug: 'outside-plan', item: 'P-001' },
    });

    expect(workScope.gate).toHaveBeenCalledWith('work_items:create', {
      harness: 'sb-devboard-hive',
      plan: 'outside-plan',
      actor: 'me',
    });
  });
});

// WI-4492: create took `summary` and SILENTLY DROPPED a `body` arg (Zod stripped it), so a
// caller who learned the name `body` from work_items:update filed an EMPTY-BODIED item with
// a cheerful ok — proven live when WI-4491/WI-4492 themselves were filed as empty shells.
// create now ACCEPTS `body` as an alias for `summary`, is `.strict()` (unknown field → loud
// error), and rejects both-with-different-values.
describe('work_items:create — body/summary alias + strict (WI-4492)', () => {
  it('maps a `body` arg to `summary` when calling createOneWorkItem (no stray `body` leaks through)', async () => {
    await body({ kind: 'bug', title: 'boom', body: 'the real text' });
    expect(createM).toHaveBeenCalledWith(expect.objectContaining({ title: 'boom', summary: 'the real text' }), expect.anything());
    expect(createM.mock.calls[0][0]).not.toHaveProperty('body');
  });

  it('maps a per-item `body` alias to summary inside items:[…]', async () => {
    await body({ items: [{ kind: 'bug', title: 'a', body: 'aa' }, { kind: 'bug', title: 'b', summary: 'bb' }] });
    expect(createM).toHaveBeenNthCalledWith(1, expect.objectContaining({ title: 'a', summary: 'aa' }), expect.anything());
    expect(createM).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: 'b', summary: 'bb' }), expect.anything());
    expect(createM.mock.calls[0][0]).not.toHaveProperty('body');
  });

  describe('args schema', () => {
    it('ACCEPTS `body` as an alias for `summary`', () => {
      expect(() => parse({ kind: 'bug', title: 'x', body: 'text' })).not.toThrow();
    });

    it('REJECTS an unknown field loudly instead of silently stripping it (strict)', () => {
      expect(() => parse({ kind: 'bug', title: 'x', summry: 'a typo for summary' })).toThrow();
    });

    it('REJECTS both `body` and `summary` with DIFFERENT values (ambiguous)', () => {
      expect(() => parse({ kind: 'bug', title: 'x', body: 'a', summary: 'b' })).toThrow(/same field/i);
    });

    it('ACCEPTS both `body` and `summary` when EQUAL (no false positive)', () => {
      expect(() => parse({ kind: 'bug', title: 'x', body: 'same', summary: 'same' })).not.toThrow();
    });

    it('REJECTS an unknown field inside items:[…]', () => {
      expect(() => parse({ items: [{ kind: 'bug', title: 'x', bogus: 1 }] })).toThrow();
    });

    it('requires plan_item to be an object with slug/item in both arities', () => {
      expect(() => parse({ kind: 'bug', title: 'x', plan_item: 'some-plan#P-003' })).toThrow();
      expect(() =>
        parse({ items: [{ kind: 'bug', title: 'x', plan_item: 'some-plan#P-003' }] }),
      ).toThrow();
    });

    it('accepts the canonical plan_item object in both arities', () => {
      expect(() => parse({ kind: 'bug', title: 'x', plan_item: { slug: 'some-plan', item: 'P-003' } })).not.toThrow();
      expect(() =>
        parse({ items: [{ kind: 'bug', title: 'x', plan_item: { slug: 'some-plan', item: 'P-003' } }] }),
      ).not.toThrow();
    });

    it('REJECTS an explicit schedule intent without cadence in either arity', () => {
      expect(() => parse({
        kind: 'task',
        title: 'digest',
        routing_intent: 'schedule-recurrence',
      })).toThrow(/cadence is required/i);
      expect(() => parse({
        items: [{
          kind: 'task',
          title: 'digest',
          routing_intent: 'schedule-recurrence',
        }],
      })).toThrow(/cadence is required/i);
    });
  });
});

describe('state-on-create (EI-10897)', () => {
  const safeParse = (x: unknown) => (tool.args as { safeParse: (x: unknown) => { success: boolean; error?: unknown } }).safeParse(x);

  it("accepts `state` — the su persona already prescribes { title, assign_to:'self', state:'wip' }, and the tool used to REJECT it as an unrecognized key", async () => {
    await body({ kind: 'change', title: 'ad-hoc unit I am starting now', assign_to: 'self', state: 'wip' });
    expect(createM).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'ad-hoc unit I am starting now', state: 'wip', assign_to: 'me' }),
      expect.anything(),
    );
  });

  it('threads `state` through the BULK path too (the item spec, not just the single shorthand)', async () => {
    await body({ items: [{ kind: 'change', title: 'a', state: 'wip' }, { kind: 'bug', title: 'b' }] });
    expect(createM).toHaveBeenNthCalledWith(1, expect.objectContaining({ title: 'a', state: 'wip' }), expect.anything());
    expect(createM).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: 'b' }), expect.anything());
    expect((createM.mock.calls[1][0] as { state?: string }).state).toBeUndefined();
  });

  it('REFUSES a terminal state on create — that would manufacture a "done" item with no evidence (the EI-10867 laundering path)', () => {
    for (const s of ['done', 'resolved', 'closed', 'passed']) {
      const r = safeParse({ kind: 'change', title: 'sneaky', state: s });
      expect(r.success, `state '${s}' must be refused on create`).toBe(false);
    }
  });

  it('still accepts a create with NO state (the default entry state is untouched)', () => {
    expect(safeParse({ kind: 'bug', title: 'plain' }).success).toBe(true);
  });
});

describe('EI-19398967670466001: a SINGLE create hoists its id to the top level', () => {
  it('exposes `id` at the top level so a create→complete chain can read it', async () => {
    // The stranding bug: `const { id } = await work_items.create(...)` used to be undefined,
    // so the second half of a scripted chain silently no-opped and left the item in wip.
    const b = await body({ kind: 'bug', title: 'boom' });
    expect(b.id).toBe('WI-boom');
  });

  it('is ADDITIVE — the results envelope is untouched', async () => {
    const b = await body({ kind: 'bug', title: 'boom' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-boom', title: 'boom' });
    expect(b.counts).toEqual({ ok: 1, failed: 0 });
  });

  it('hoists NOTHING for a genuine batch — a top-level id would be ambiguous there', async () => {
    const b = await body({ items: [{ kind: 'bug', title: 'a' }, { kind: 'change', title: 'b' }] });
    expect(b.id).toBeUndefined();
    // …and the per-item ids are still the way to read a batch.
    expect(b.results.map((r: { id: string }) => r.id)).toEqual(['WI-a', 'WI-b']);
  });
});
