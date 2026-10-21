/**
 * claim.test.ts — work_items:claim handler, dual-arity keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Engine fns mocked. Pins: inline single
 * success → one result with workItem; ids:[…] fan-out; a claim_conflict (EI-2197
 * classify) fails only that item and carries holder/hint; top-level ok stays true.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const stackRegistry = vi.hoisted(() => ({ projects: [] as Array<{ slug: string; path: string }> }));
vi.mock('../../harness-registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../harness-registry')>(),
  loadHarnessRegistry: async () => stackRegistry,
}));
// Keep declaration persistence out of this unit fixture; stack detection and
// claim-receipt rendering remain real. P-001 covers the declaration writer.
const stackDeclarations = vi.hoisted(() => ({ views: new Map<string, import('../../work-item-change-kinds').ChangeKindsView>() }));
vi.mock('../../work-item-change-kinds', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../work-item-change-kinds')>(),
  readChangeKinds: async () => stackDeclarations.views,
  attachChangeKindDeclarations: async (input: {
    results: Array<Record<string, unknown>>;
    declared: Map<string, { kinds: string[]; reason: string | null }>;
    step: 'claim';
  }) => input.results.map((result) => {
    const declaration = input.declared.get(String(result.id));
    if (!result.ok || !declaration) return result;
    const current = declaration.kinds as import('../../change-kind-catalog').ChangeKind[];
    stackDeclarations.views.set(String(result.id), {
      current,
      history: [{ kinds: current, step: 'claim', declaredBy: 'me', declaredAt: '2026-10-19T00:00:00Z', reason: declaration.reason }],
    });
    return { ...result, changeKinds: { recorded: true, current, step: input.step, previous: null } };
  }),
}));

const identity = vi.hoisted(() => ({ ownerId: 'me', workspaceId: 'ws-1' as string | null }));
const fleetAdmission = vi.hoisted(() => ({
  decision: { allowed: true, scoped: false } as any,
  notify: vi.fn(),
}));
const workScope = vi.hoisted(() => ({
  // Typed against the real gateWorkScope seam: the mock must accept the (site, subject)
  // it is called with, and may return either an allow (reason) or a deny (error) verdict.
  gate: vi.fn(
    async (
      _site: string,
      _subject: import('../../work-scope-policy').WorkScopeSubject,
    ): Promise<{ allowed: boolean; reason?: string; error?: string }> => ({
      allowed: true,
      reason: 'no-policy',
    }),
  ),
  refusal: vi.fn((verdict: unknown, extra?: Record<string, unknown>) => ({
    ok: false,
    ...(verdict as Record<string, unknown>),
    ...extra,
  })),
}));
const premisePort = vi.hoisted(() => ({ get: vi.fn() }));
const explicitAssigneeM = vi.hoisted(() => ({
  resolve: vi.fn(async (raw: string, callerOwnerId: string, _workspaceId?: string | null) =>
    ({ ok: true as const, ownerId: raw.trim() === 'self' ? callerOwnerId : raw.trim() }) as
      | { ok: true; ownerId: string }
      | { ok: false; code: string; message: string; candidates?: string[] },
  ),
}));
const forceGuard = vi.hoisted(() => ({
  verdict: { allowed: true, basis: 'holder-session-ended', holderLiveness: { live: false } } as any,
}));
const pilotReceipts = vi.hoisted(() => ({ persistBinding: vi.fn() }));
vi.mock('../coordination/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordination/identity')>()),
  SUPERUSER_FALLBACK_CLIENT_ID: 'su-loopback',
  isEphemeralMcpCallIdentity: (id: string) => /^mcp-call-\d+$/.test(id),
  resolveAgentIdentity: () => ({ ownerId: identity.ownerId, workspaceId: identity.workspaceId }),
}));
vi.mock('../coordination/recipient-resolve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordination/recipient-resolve')>()),
  resolveExplicitAgentOwnerId: explicitAssigneeM.resolve,
}));
//
// PARTIAL mock (importOriginal), deliberately — NOT a hand-listed factory. A hand-listed factory
// returns `undefined` for any export claim.ts imports but the list forgot, and the tool then
// crashes on it at runtime: runBulk converts the throw into ok:false, so EVERY test in this file
// fails with "expected ok:false to equal ok:true" — an assertion that names neither the missing
// export nor the mock. That is exactly what happened here when P-013 added the
// `readUnresolvedDepBlockers` import (11 of 19 red, all one root cause). claim.checkpoint-hint.ts
// had already been converted to this form for the same reason after WI-5946; this file was the
// remaining copy. Spreading the real module means a FUTURE import claim.ts adds resolves to the
// genuine implementation instead of undefined — only the fns stubbed below are replaced.
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  claimWorkItem: vi.fn(),
  classifyClaimFailure: vi.fn(),
  commentWorkItem: vi.fn(),
  explainIssueClaimFloors: vi.fn(),
  getWorkItem: vi.fn(),
}));
const releaseRequest = vi.hoisted(() => ({
  readWorkItemReleaseRequest: vi.fn(() => null as unknown),
  resolveWorkItemReleaseRequest: vi.fn(async () => null as unknown),
}));
vi.mock('../../work-items-release-request', () => releaseRequest);
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  admitWorkItemForFleetTarget: vi.fn(async () => fleetAdmission.decision),
  notifyFleetScopeRefusal: fleetAdmission.notify,
  fleetScopeLeaderRemedy: vi.fn(() => 'remedy: scheduler:set_claim_spec { … }'),
  renderFleetDependencyEscape: vi.fn((escape: { dependency: { id: string } }) =>
    `DEPENDENCY ESCAPE: ${escape.dependency.id}`),
}));
vi.mock('../../work-scope-policy', () => ({
  gateWorkScope: workScope.gate,
  workScopeRefusal: workScope.refusal,
}));
// Claim-time recall port (P-008) is exercised in its own memory/claim-port.test.ts;
// mock it here so the handler test stays a hermetic unit (no real memory backend).
// EI-23701433507513915: the holder-identity rules run for real, against an owner registry this
// file controls, instead of coord presence.
const OWNER_REGISTRY = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('../../work-item-holder-identity', async (importOriginal) => {
  const { registryBackedHolderIdentity } = await import('../../work-item-holder-identity.testing');
  return registryBackedHolderIdentity(await importOriginal(), OWNER_REGISTRY);
});
vi.mock('../../memory/claim-port', () => ({ buildClaimRecallBlock: vi.fn(async () => null) }));
vi.mock('../../premises-claim-port', () => ({ getClaimTimePremises: premisePort.get }));
// EI-20417350647749715: keep the force takeover handler tests hermetic while the
// release-force-guard unit suite covers the real liveness/authority classifier.
vi.mock('./release-force-guard', () => ({
  assessForceRelease: vi.fn(async () => forceGuard.verdict),
  forceRefusalHint: (holder: string) => `refused:${holder}`,
  notifyForceTransition: vi.fn(async () => {}),
  recordForceTransitionAudit: vi.fn(async () => {}),
}));
// green-main-cycle-time-2026-10-08 P-013 (D-028(4)): the real gate-singleton decision runs;
// only its two reads (condition_key, the claimant's re-wake verdict) are faked, so this file
// stays hermetic and pins the wiring — guard before mutation, keyed on the CLAIMANT.
const gateSingleton = vi.hoisted(() => ({
  conditionKey: null as string | null,
  rewake: { guaranteed: true, reason: null } as import('../loop/next-wake').LoopNextWakeVerdict,
  readRewake: vi.fn((_claimant: string) => undefined),
}));
vi.mock('./gate-singleton-claim-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./gate-singleton-claim-guard')>()),
  defaultGateSingletonClaimReader: () => ({
    readConditionKey: async () => gateSingleton.conditionKey,
    readRewake: async (claimant: string) => {
      gateSingleton.readRewake(claimant);
      return gateSingleton.rewake;
    },
  }),
}));
vi.mock('../../pilot-participant-receipts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  persistPilotParticipantBindingReceipt: (...args: unknown[]) => pilotReceipts.persistBinding(...args),
}));

import { claimWorkItem, classifyClaimFailure, commentWorkItem, explainIssueClaimFloors, getWorkItem, type WorkItem } from '../../work-items';
import { resolveWorkItemReleaseRequest } from '../../work-items-release-request';
import { assessForceRelease, notifyForceTransition, recordForceTransitionAudit } from './release-force-guard';
import { mockImplementationTyped, mockResolvedTyped, mockReturnTyped } from '../../testing/typed-mock';

/**
 * A COMPLETE `WorkItem` with a `Partial` override seam, so a fixture is checked against the
 * real interface instead of cast past it with `as never`. That cast is what defeats
 * `vi.mocked()`: it stops the fixture being typechecked, so when `WorkItem` gains a required
 * field the stale fixture fails at RUNTIME, in the fleet's green gate, in a file whose author
 * never touched it (`lint:mock-cast-escape`, baseline shrink-only). The 29 pre-existing casts
 * in this file are out of scope here; new tests should use this and the seam is here to adopt.
 */
const issueItem = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 'EI-FIXTURE', kind: 'bug', family: 'issue', harness: 'papercup',
  title: 'fixture', summary: '', state: 'open',
  assignee: null, takenAt: null, lastProgressAt: null, assignedBy: null, createdBy: null,
  severity: null, goalId: null, parent: null, payload: null, origin: 'local',
  auditVerdict: null, verifiedAuthorGithubUserId: null,
  rank: null, rankWriter: null, rankUpdatedAt: null, priority: null,
  terminalOwner: null, terminalCompletionRef: null, terminalCompletionEvidence: null,
  completionAuthority: null,
  createdAt: '2026-08-31T12:37:57.000Z', updatedAt: '2026-08-31T12:37:57.000Z', closedAt: null,
  ...over,
});

const claimM = vi.mocked(claimWorkItem);
const classifyM = vi.mocked(classifyClaimFailure);
const getM = vi.mocked(getWorkItem);
const commentM = vi.mocked(commentWorkItem);
const explainFloorsM = vi.mocked(explainIssueClaimFloors);
const resolveReleaseRequestM = vi.mocked(resolveWorkItemReleaseRequest);
const assessForceM = vi.mocked(assessForceRelease);
const forceNotifyM = vi.mocked(notifyForceTransition);
const forceAuditM = vi.mocked(recordForceTransitionAudit);
const tool = (await import('./claim')).default;

type Out = { data: any };
const body = async (args: unknown) => ((await tool.handler(args as never, {} as never)) as Out).data;

beforeEach(() => {
  vi.clearAllMocks();
  stackRegistry.projects = [];
  stackDeclarations.views.clear();
  explicitAssigneeM.resolve.mockImplementation(async (raw, callerOwnerId) => ({
    ok: true,
    ownerId: raw.trim() === 'self' ? callerOwnerId : raw.trim(),
  }));
  OWNER_REGISTRY.ids = [];
  identity.ownerId = 'me';
  identity.workspaceId = 'ws-1';
  forceGuard.verdict = { allowed: true, basis: 'holder-session-ended', holderLiveness: { live: false } };
  fleetAdmission.decision = { allowed: true, scoped: false };
  workScope.gate.mockResolvedValue({ allowed: true, reason: 'no-policy' });
  workScope.refusal.mockClear();
  claimM.mockImplementation(async (id: string) => ({ id, assignee: 'me' }) as never);
  // claim.ts pre-reads the item for the checked cross-holder CAS path; ordinary tests use a
  // zero-row read so the claimWorkItem mock remains the source of the result.
  getM.mockResolvedValue(null as never);
  commentM.mockResolvedValue({ id: 'post-1' } as never);
  explainFloorsM.mockResolvedValue([] as never);
  releaseRequest.readWorkItemReleaseRequest.mockReturnValue(null);
  releaseRequest.resolveWorkItemReleaseRequest.mockResolvedValue(null);
  premisePort.get.mockReset().mockResolvedValue(null);
  pilotReceipts.persistBinding.mockReset();
  gateSingleton.conditionKey = null;
  gateSingleton.rewake = { guaranteed: true, reason: null };
});

describe('R3 claim receipt stack defaults (independent P023 acceptance)', () => {
  it.each([
    { stack: 'Tauri', file: 'src-tauri/tauri.conf.json', manifest: { productName: 'Fixture' }, tool: /verify-tauri-headless\.sh|headless\s+Tauri\s+runner/i },
    { stack: 'web', file: 'package.json', manifest: { dependencies: { next: '15.0.0' } }, tool: /headless\s+browser|playwright|\bverdict\b/i },
    { stack: 'unknown', file: 'package.json', manifest: { name: 'unknown-fixture' }, tool: /(?:name|choose|specify).{0,80}tool|tool.{0,80}(?:name|choos|specif)/i },
  ])('names the default proof tool for an unconfigured $stack harness', async ({ file, manifest, tool: expectedTool }) => {
    const root = mkdtempSync(join(tmpdir(), 'r3-claim-stack-'));
    try {
      const path = join(root, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(manifest));
      stackRegistry.projects = [{ slug: 'r3-fixture', path: root }];
      claimM.mockResolvedValue(issueItem({ id: 'WI-R3-STACK', harness: 'r3-fixture', assignee: 'me' }));

      const receipt = await body({ id: 'WI-R3-STACK', harness: 'r3-fixture', changeKinds: ['ui'] });
      const result = receipt.results[0];
      expect(result).toMatchObject({ ok: true, changeKinds: { recorded: true, current: ['ui'] } });
      expect(JSON.stringify(result)).toMatch(expectedTool);
      expect(JSON.stringify(result)).toMatch(/artifact|recorded/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('work_items:claim gate-red singleton guard (green-main-cycle-time-2026-10-08 P-013, D-028(4))', () => {
  it('refuses a gate-red-streak singleton before mutation when the CLAIMANT has no guaranteed re-wake', async () => {
    gateSingleton.conditionKey = 'gate-red-streak:papercup';
    gateSingleton.rewake = { guaranteed: false, reason: 'no-active-loop' };
    const b = await body({ id: 'EI-red', assignee: 'bee-7' });
    expect(b.results[0]).toMatchObject({
      ok: false,
      id: 'EI-red',
      error: 'gate_singleton_requires_long_lived_owner',
      conditionKey: 'gate-red-streak:papercup',
      claimant: 'bee-7',
      rewakeReason: 'no-active-loop',
    });
    expect(b.results[0].hint).toMatch(/loop:arm/);
    expect(b.results[0].hint).toMatch(/frozen-repair-leg:/);
    // The verdict is read for the assignee the item would land on, not the caller ('me').
    expect(gateSingleton.readRewake).toHaveBeenCalledWith('bee-7');
    expect(claimM).not.toHaveBeenCalled();
    expect(fleetAdmission.notify).not.toHaveBeenCalled();
  });

  it('admits the frozen-repair-convergence singleton for a claimant with a guaranteed re-wake', async () => {
    gateSingleton.conditionKey = 'frozen-repair-convergence:papercup';
    gateSingleton.rewake = { guaranteed: true, reason: null };
    const b = await body({ id: 'EI-conv' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'EI-conv' });
    expect(gateSingleton.readRewake).toHaveBeenCalledWith('me');
    expect(claimM).toHaveBeenCalledOnce();
  });

  it('never guards a per-leg frozen-repair-leg item, even for a claimant with no loop (D-028(2))', async () => {
    gateSingleton.conditionKey = 'frozen-repair-leg:papercup:packages/x/a.test.ts';
    gateSingleton.rewake = { guaranteed: false, reason: 'no-active-loop' };
    const b = await body({ id: 'EI-leg' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'EI-leg' });
    expect(gateSingleton.readRewake).not.toHaveBeenCalled();
    expect(claimM).toHaveBeenCalledOnce();
  });
});

describe('work_items:claim idempotent-completion opt-in (EI-21593186656422114)', () => {
  it('declares idempotent:true so a committed-but-slow claim surfaces success, not a false timeout', () => {
    expect((tool as { idempotent?: boolean }).idempotent).toBe(true);
  });

  it('allows up to 120 seconds for a successful claim and its advisory reads (EI-25882027630574649)', () => {
    expect((tool as { timeoutSec?: number }).timeoutSec).toBe(120);
  });
});

describe('work_items:claim handler (keyed-array)', () => {
  it('refuses terminal state claims before mutation and names the explicit reopen path', async () => {
    getM.mockResolvedValue(issueItem({
      id: 'WI-terminal',
      state: 'done',
      terminalOwner: 'su-original-closer',
      terminalCompletionRef: 'completed by original owner',
    }));

    const b = await body({ id: 'WI-terminal' });

    expect(b.results[0]).toMatchObject({
      ok: false,
      id: 'WI-terminal',
      error: 'claim_terminal_item',
      terminalOwner: 'su-original-closer',
    });
    expect(b.results[0].hint).toContain('work_items:set_state');
    expect(b.results[0].hint).toContain('force: true');
    expect(b.results[0].hint).toContain('reason:');
    expect(claimM).not.toHaveBeenCalled();
  });

  it('claims one inline for the caller and returns the workItem', async () => {
    const b = await body({ id: 'WI-1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', workItem: { id: 'WI-1', assignee: 'me' } });
    expect(claimM).toHaveBeenCalledWith('WI-1', 'me', { harness: undefined, fromHolder: identity.ownerId });
  });

  it('reclaims a signed judge alias with the exact stored bare holder as its CAS predecessor', async () => {
    const session = 'su-851c1a7a-8ea6-4c70-afeb-472e957fd3d8';
    identity.ownerId = `system:judge/${session}`;
    getM.mockResolvedValue(issueItem({ assignee: session }));
    const ctx = { uiClientId: session, principal: { slug: 'system:judge', authMethod: 'spawn-url', trust: 'trusted' } };
    await tool.handler({ id: 'WI-1' } as never, ctx as never);
    expect(claimM).toHaveBeenCalledWith('WI-1', identity.ownerId, { harness: undefined, fromHolder: session });
    expect(assessForceM).not.toHaveBeenCalled();
  });

  it('does not widen a bearer client reclaim CAS to the bare session holder', async () => {
    const session = 'su-851c1a7a-8ea6-4c70-afeb-472e957fd3d8';
    identity.ownerId = `system:judge/${session}`;
    getM.mockResolvedValue(issueItem({ assignee: session }));
    const ctx = { uiClientId: session, principal: { slug: 'system:judge', authMethod: 'bearer', trust: 'trusted' } };
    await tool.handler({ id: 'WI-1' } as never, ctx as never);
    expect(claimM).toHaveBeenCalledWith('WI-1', identity.ownerId, { harness: undefined, fromHolder: identity.ownerId });
  });

  it('mints a canonical pilot binding only after a caller-owned claim lands', async () => {
    const claimVersion = '2026-08-27T07:15:00.000Z';
    claimM.mockResolvedValue({
      id: 'WI-PILOT', assignee: 'me', harness: 'papercusp', takenAt: claimVersion,
    } as never);
    pilotReceipts.persistBinding.mockResolvedValue({
      receiptId: 'binding-1', itemId: 'WI-PILOT', ownerId: 'me', sessionId: 'session-1',
      role: 'director', claimVersion, bindingIssuedAtMs: 100,
    });

    const b = await body({ id: 'WI-PILOT', harness: 'papercusp', pilotRole: 'director' });

    expect(b.results[0]).toMatchObject({
      ok: true,
      pilotBindingReceipt: { receiptId: 'binding-1', ownerId: 'me', sessionId: 'session-1' },
    });
    expect(pilotReceipts.persistBinding).toHaveBeenCalledWith({
      workspaceId: 'ws-1', harnessSlug: 'papercusp', itemId: 'WI-PILOT', ownerId: 'me',
      claimVersion, role: 'director',
    });
  });

  it('reports claimLanded when canonical pilot binding persistence fails', async () => {
    claimM.mockResolvedValue({
      id: 'WI-PILOT', assignee: 'me', harness: 'papercusp', takenAt: '2026-08-27T07:15:00.000Z',
    } as never);
    pilotReceipts.persistBinding.mockRejectedValue(new Error('claimVersion CAS changed'));

    const b = await body({ id: 'WI-PILOT', harness: 'papercusp', pilotRole: 'solo' });

    expect(b.results[0]).toMatchObject({
      ok: false, error: 'pilot_binding_receipt_failed', claimLanded: true,
    });
    expect(b.results[0].hint).toMatch(/claimVersion CAS changed/);
  });

  it('refuses caller-issued pilot identity for a named assignee before mutation', async () => {
    const b = await body({ id: 'WI-PILOT', assignee: 'peer', pilotRole: 'solo' });

    expect(b.results[0]).toMatchObject({ ok: false, error: 'pilot_binding_requires_self_claim' });
    expect(claimM).not.toHaveBeenCalled();
    expect(pilotReceipts.persistBinding).not.toHaveBeenCalled();
  });

  it('P-016 returns the ready await call when the claimed item has an active gate blocker', async () => {
    const now = '2026-08-21T00:00:00.000Z';
    claimM.mockResolvedValue({
      id: 'WI-GATED',
      assignee: 'me',
      externalBlockers: [
        {
          kind: 'gate',
          capability: 'live-dependency',
          capabilitySource: 'explicit',
          ref: 'release:green:papercusp',
          summary: 'green checkpoint must pass',
          status: 'active',
          createdAt: now,
          createdBy: 'su-leader',
          updatedAt: now,
        },
      ],
    } as never);

    const b = await body({ id: 'WI-GATED' });

    expect(b.results[0]).toMatchObject({
      ok: true,
      id: 'WI-GATED',
      suggestedWatches: [
        {
          tool: 'events:await',
          args: { event: 'release:green:papercusp' },
        },
      ],
    });
    expect(b.results[0].suggestedWatches[0].why).toMatch(/red gate/i);
  });

  it('passes the claimed id to premise citation hydration and surfaces its advisory', async () => {
    claimM.mockResolvedValue({
      id: 'EI-aged',
      title: 'Build a replacement gate',
      summary: 'EI-aged depends on WI-4329.',
      payload: { source: 'ideation' },
      harness: 'papercusp',
      assignee: 'me',
    } as never);
    premisePort.get.mockResolvedValue({
      rendered: ['- ? WI-4329 terminal evidence says the premise was invalid'],
      note: 'Re-check the invalidated premise before building.',
    });

    const b = await body({ id: 'EI-aged', harness: 'papercusp' });

    expect(b.results[0]).toMatchObject({
      workItem: { id: 'EI-aged' },
      premises: ['- ? WI-4329 terminal evidence says the premise was invalid'],
      premisesNote: 'Re-check the invalidated premise before building.',
    });
    expect(premisePort.get).toHaveBeenCalledWith({
      workItem: {
        id: 'EI-aged',
        title: 'Build a replacement gate',
        summary: 'EI-aged depends on WI-4329.',
        payload: { source: 'ideation' },
      },
      harness: 'papercusp',
      workspaceId: 'ws-1',
    });
  });

  it('claims MANY via ids:[…] for an explicit assignee', async () => {
    const b = await body({ ids: ['WI-1', 'WI-2'], assignee: 'bee-7' });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(claimM).toHaveBeenCalledWith('WI-2', 'bee-7', { harness: undefined, fromHolder: identity.ownerId });
  });

  it('P-016 refuses an out-of-scope named claim before mutation and alerts the leader', async () => {
    fleetAdmission.decision = {
      allowed: false,
      scoped: true,
      code: 'fleet_scope_violation',
      reason: 'WI-out is outside fleet-bugs@4',
      scope: {
        fleetSlug: 'bugs',
        ownerId: 'bee-7',
        fleetRole: 'member',
        record: { spec: { specId: 'fleet-bugs', revision: 4 } },
      },
    };
    const b = await body({ id: 'WI-out', assignee: 'bee-7' });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-out', error: 'fleet_scope_violation' });
    expect(claimM).not.toHaveBeenCalled();
    expect(fleetAdmission.notify).toHaveBeenCalledOnce();
    // EI-18673501896258575: the caller sees the SAME concrete remedy the leader was
    // notified with — not just a bare refusal reason, so a member acting on an
    // explicit leader directive knows the scheduler:set_claim_spec fix exists.
    expect(b.results[0].hint).toMatch(/remedy: scheduler:set_claim_spec/);
  });

  it('passes persisted plan provenance to the work-scope gate for exact plan exceptions', async () => {
    workScope.gate.mockImplementation(async (_site, subject) =>
      subject.plan === 'portal-session-search-parity-2026-09-14'
        ? { allowed: true, reason: 'exception' }
        : { allowed: false, error: 'scope_denied' },
    );
    getM.mockResolvedValue({
      id: 'WI-PLAN-EXCEPTION',
      harness: 'sidestage',
      sourcePlanSlug: 'portal-session-search-parity-2026-09-14',
      sourcePlanItemIds: ['P-002'],
      payload: null,
    } as never);

    const b = await body({ id: 'WI-PLAN-EXCEPTION', harness: 'sidestage' });

    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-PLAN-EXCEPTION' });
    expect(workScope.gate).toHaveBeenCalledWith('work_items:claim', {
      harness: 'sidestage',
      plan: 'portal-session-search-parity-2026-09-14',
      workItem: 'WI-PLAN-EXCEPTION',
      actor: 'me',
    });
    expect(claimM).toHaveBeenCalledWith('WI-PLAN-EXCEPTION', 'me', {
      harness: 'sidestage',
      fromHolder: identity.ownerId,
    });
  });

  it('returns the typed dependency escape produced by the refusal seam', async () => {
    fleetAdmission.decision = {
      allowed: false,
      scoped: true,
      code: 'fleet_scope_violation',
      reason: 'WI-blocker is outside fleet-bugs@4',
      scope: {
        fleetSlug: 'bugs', ownerId: 'bee-7', fleetRole: 'member',
        record: { spec: { specId: 'fleet-bugs', revision: 4 } },
      },
    };
    const dependencyEscape = {
      kind: 'dependency_escape',
      dependency: { id: 'WI-blocker', kind: 'issue' },
      blockedHeldItems: [{ id: 'WI-held', kind: 'change', harness: 'papercusp' }],
      blockedHeldItemIds: ['WI-held'],
      member: 'bee-7',
      ownershipPreserved: true,
      routes: [
        { kind: 'spec_widen', calls: [] },
        { kind: 'outside_lane_placement', calls: [] },
        { kind: 'leader_claim', calls: [] },
      ],
    };
    fleetAdmission.notify.mockResolvedValue({
      liveRouteTarget: true,
      classRefusal: null,
      dependencyEscape,
    });
    const b = await body({ id: 'WI-blocker', assignee: 'bee-7', harness: 'papercusp' });
    expect(b.results[0]).toMatchObject({
      ok: false,
      error: 'fleet_scope_violation',
      dependencyEscape: {
        dependency: { id: 'WI-blocker' },
        blockedHeldItemIds: ['WI-held'],
        ownershipPreserved: true,
      },
    });
    expect(b.results[0].hint).toMatch(/DEPENDENCY ESCAPE/);
  });

  it('refuses implicit claims as the shared su-loopback fallback', async () => {
    identity.ownerId = 'su-loopback';
    const b = await body({ id: 'WI-LOOPBACK' });
    expect(b).toMatchObject({ ok: false, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-LOOPBACK', error: 'missing_client_identity' });
    expect(b.results[0].hint).toMatch(/real per-session or spawn owner/);
    expect(claimM).not.toHaveBeenCalled();
  });

  it('still permits explicit assignee claims from a su-loopback caller', async () => {
    identity.ownerId = 'su-loopback';
    const b = await body({ id: 'WI-DIRECTED', assignee: 's-bee-1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(claimM).toHaveBeenCalledWith('WI-DIRECTED', 's-bee-1', { harness: undefined, fromHolder: identity.ownerId });
  });

  // EI-8509: scripts/mcp-call.mjs mints `mcp-call-<pid>` when invoked with no
  // --client — a one-shot process with no liveness/heartbeat and no fleet cup
  // behind it. An implicit claim under that identity must be refused the same
  // way the su-loopback fallback is, so "placed" work can no longer silently
  // rot with nothing ever executing it.
  it('refuses an implicit claim under the mcp-call.mjs auto-generated fallback identity', async () => {
    identity.ownerId = 'mcp-call-12345';
    const b = await body({ id: 'WI-EPHEMERAL' });
    expect(b).toMatchObject({ ok: false, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({
      ok: false,
      id: 'WI-EPHEMERAL',
      error: 'ephemeral_mcp_call_identity',
    });
    expect(b.results[0].hint).toMatch(/mcp-call\.mjs/);
    expect(claimM).not.toHaveBeenCalled();
  });

  it('still permits explicit assignee claims from an mcp-call.mjs fallback caller', async () => {
    identity.ownerId = 'mcp-call-12345';
    const b = await body({ id: 'WI-DIRECTED-2', assignee: 's-bee-2' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(claimM).toHaveBeenCalledWith('WI-DIRECTED-2', 's-bee-2', { harness: undefined, fromHolder: identity.ownerId });
  });

  it('a claim_conflict fails only that item (top-level ok stays true) with holder + hint', async () => {
    claimM.mockImplementation(async (id: string) => (id === 'WI-HELD' ? null : ({ id, assignee: 'me' } as never)));
    getM.mockResolvedValue({ id: 'WI-HELD', assignee: 'peer' } as never);
    classifyM.mockReturnValue({ reason: 'conflict', holder: 'peer' } as never);
    const b = await body({ ids: ['WI-1', 'WI-HELD'] });
    expect(b).toMatchObject({ ok: false, counts: { ok: 1, failed: 1 } });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'WI-HELD', error: 'claim_conflict', holder: 'peer' });
    expect(b.results[1].hint).toMatch(/Already claimed by peer/);
    expect(b.results[1].hint).toMatch(/force:true/);
    expect(b.results[1].hint).toMatch(/liveness-checked, audited/);
  });

  // EI-20731607691070897 — a HOLDER handing their own item to a named peer. Before this,
  // `claim { id, assignee: peer }` was refused as a claim_conflict against the caller
  // THEMSELVES, and the only path left (release → peer claims) drops the item to
  // UNASSIGNED and fleet-claimable in between — a real race on a fleet whose scheduler
  // hands out claimable work. There is no other transfer primitive: coord:handoff records
  // a transition note, work_items:request_release is the opposite direction, and
  // work_items:update has no assignee.
  describe('self-held transfer', () => {
    it('passes the CALLER as fromHolder, so the handoff lands in the same compare-and-claim', async () => {
      identity.ownerId = 'me';
      const b = await body({ id: 'WI-MINE', assignee: 'peer' });
      expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
      // fromHolder is the whole mechanism: it widens the CAS by the caller's OWN claim.
      // Without it the UPDATE matches only an unheld row and the transfer is refused.
      expect(claimM).toHaveBeenCalledWith('WI-MINE', 'peer', { harness: undefined, fromHolder: 'me' });
    });

    it('never offers a THIRD party as fromHolder — only ever the caller', async () => {
      identity.ownerId = 'me';
      await body({ id: 'WI-X', assignee: 'peer' });
      // The safety property: fromHolder is bound to identity, never to the assignee, so
      // this can only ever move a claim the CALLER already holds.
      expect(claimM).toHaveBeenCalledWith('WI-X', 'peer', expect.objectContaining({ fromHolder: 'me' }));
      expect(claimM).not.toHaveBeenCalledWith('WI-X', 'peer', expect.objectContaining({ fromHolder: 'peer' }));
    });

    it('a conflict whose holder IS the caller does not return the someone-else-holds-it hint', async () => {
      identity.ownerId = 'me';
      mockResolvedTyped(claimM, null);
      mockReturnTyped(classifyM, { reason: 'conflict', holder: 'me' });
      const b = await body({ id: 'WI-MINE', assignee: 'peer' });
      expect(b.results[0]).toMatchObject({ ok: false, error: 'claim_conflict', holder: 'me' });
      const hint = b.results[0].hint as string;
      expect(hint).toMatch(/already hold/i);
      // The two branches that actively misfire when the holder is the caller: being told
      // to coordinate with "the holder" (yourself), and to wait for the stale-claim lane
      // to free it (your own death).
      expect(hint).not.toMatch(/Already claimed by/);
      expect(hint).not.toMatch(/Coordinate with the holder via coord:send/);
      expect(hint).not.toMatch(/stale-claim reclaim lane/);
      // And it must steer AWAY from the release that opens the fleet-claimable window.
      expect(hint).toMatch(/Do NOT work_items:release/);
    });

    it('a conflict held by a PEER still returns the original hint', async () => {
      identity.ownerId = 'me';
      mockResolvedTyped(claimM, null);
      mockReturnTyped(classifyM, { reason: 'conflict', holder: 'peer' });
      const b = await body({ id: 'WI-HELD' });
      const hint = b.results[0].hint as string;
      expect(hint).toMatch(/Already claimed by peer/);
      expect(hint).toMatch(/Coordinate with the holder via coord:send/);
      expect(hint).not.toMatch(/already hold/i);
    });
  });

  // EI-20417350647749715 — force:true is a checked, atomic cross-holder takeover.
  // The handler owns the pre-read/guard/audit contract; release-force-guard.test.ts
  // owns the real liveness and authority classifier.
  describe('cross-holder force takeover', () => {
    it('authorizes a dead-holder takeover, passes expectedAssignee into the CAS, and reports/audits it', async () => {
      getM.mockResolvedValue({ id: 'WI-DEAD', assignee: 'peer', lastProgressAt: '2026-08-20T08:00:00.000Z' } as never);
      claimM.mockResolvedValue({ id: 'WI-DEAD', assignee: 'me', harness: 'papercusp' } as never);

      const b = await body({ id: 'WI-DEAD', force: true, reason: 'holder session ended; reclaiming for the drain' });

      expect(assessForceM).toHaveBeenCalledWith({
        callerOwnerId: 'me',
        holderOwnerId: 'peer',
        workspaceId: 'ws-1',
        itemLastProgressAt: '2026-08-20T08:00:00.000Z',
        releaseRequest: null,
      });
      expect(claimM).toHaveBeenCalledWith('WI-DEAD', 'me', {
        harness: undefined,
        fromHolder: 'me',
        expectedAssignee: 'peer',
        forceTakeoverAdmission: expect.objectContaining({
          itemId: 'WI-DEAD',
          target: 'me',
          expectedAssignee: 'peer',
          workspaceId: 'ws-1',
        }),
      });
      expect(b.results[0]).toMatchObject({
        ok: true,
        id: 'WI-DEAD',
        forced: {
          holder: 'peer',
          basis: 'holder-session-ended',
          reason: 'holder session ended; reclaiming for the drain',
        },
      });
      expect(forceAuditM).toHaveBeenCalledWith(
        'me',
        'WI-DEAD',
        'claim',
        expect.objectContaining({ holder: 'peer', replacementAssignee: 'me' }),
      );
      expect(forceNotifyM).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'me' }),
        expect.objectContaining({ itemId: 'WI-DEAD', holder: 'peer', operation: 'claim', replacementAssignee: 'me' }),
      );
    });

    it('executes an expired announced reclaim via the holder-CAS claim and resolves that exact request', async () => {
      const request = {
        by: 'me',
        holder: 'peer',
        reason: 'deadline elapsed',
        onSilence: 'reclaim' as const,
        deadlineAt: 123,
        requestedAt: 100,
        resolved: false,
        resolution: null,
        resolvedAt: null,
      };
      getM.mockResolvedValue({ id: 'WI-EXPIRED', assignee: 'peer', payload: { request: true } } as never);
      releaseRequest.readWorkItemReleaseRequest.mockReturnValue(request);
      forceGuard.verdict = {
        allowed: true,
        basis: 'announced-release-request-expired',
        holderLiveness: { live: true, oracleSessionState: 'recorded' },
      };
      claimM.mockResolvedValue({ id: 'WI-EXPIRED', assignee: 'me', harness: 'papercusp' } as never);
      releaseRequest.resolveWorkItemReleaseRequest.mockResolvedValue({
        ...request,
        resolved: true,
        resolution: 'consequence-reclaim',
        resolvedAt: 456,
      });

      const b = await body({ id: 'WI-EXPIRED', force: true, reason: 'executing announced deadline' });

      expect(assessForceM).toHaveBeenCalledWith(expect.objectContaining({ releaseRequest: request }));
      expect(claimM).toHaveBeenCalledWith('WI-EXPIRED', 'me', {
        harness: undefined,
        fromHolder: 'me',
        expectedAssignee: 'peer',
        forceTakeoverAdmission: expect.objectContaining({
          itemId: 'WI-EXPIRED',
          target: 'me',
          expectedAssignee: 'peer',
          workspaceId: 'ws-1',
        }),
      });
      expect(resolveReleaseRequestM).toHaveBeenCalledWith('WI-EXPIRED', {
        harness: 'papercusp',
        resolution: 'consequence-reclaim',
        expectedBy: 'me',
        expectedHolder: 'peer',
        expectedDeadlineAt: 123,
      });
      expect(commentM).toHaveBeenCalledWith('WI-EXPIRED', expect.stringContaining('EXPIRED unanswered'), 'me', {
        harness: 'papercusp',
      });
      expect(b.results[0].forced).toMatchObject({ basis: 'announced-release-request-expired' });
    });

    it('requires a reason before assessing or mutating another holder\'s claim', async () => {
      getM.mockResolvedValue({ id: 'WI-DEAD', assignee: 'peer' } as never);

      const b = await body({ id: 'WI-DEAD', force: true });

      expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-DEAD', error: 'force_requires_reason', holder: 'peer' });
      expect(assessForceM).not.toHaveBeenCalled();
      expect(claimM).not.toHaveBeenCalled();
      expect(forceAuditM).not.toHaveBeenCalled();
      expect(forceNotifyM).not.toHaveBeenCalled();
    });

    it('refuses an unauthorized takeover of a live peer and leaves the claim untouched', async () => {
      getM.mockResolvedValue({ id: 'WI-LIVE', assignee: 'peer', lastProgressAt: '2026-08-20T08:39:00.000Z' } as never);
      forceGuard.verdict = { allowed: false, holderLiveness: { live: true } };

      const b = await body({ id: 'WI-LIVE', force: true, reason: 'taking over for the drain' });

      expect(b.results[0]).toMatchObject({
        ok: false,
        id: 'WI-LIVE',
        error: 'force_unauthorized',
        holder: 'peer',
        holderLiveness: { live: true },
        hint: 'refused:peer',
      });
      expect(claimM).not.toHaveBeenCalled();
      expect(forceAuditM).not.toHaveBeenCalled();
      expect(forceNotifyM).not.toHaveBeenCalled();
    });

    it('applies a batch reason, with a per-item reason overriding it', async () => {
      getM.mockImplementation(async (id: string) => ({
        id,
        assignee: id === 'WI-A' ? 'peer-a' : 'peer-b',
        lastProgressAt: null,
      }) as never);
      claimM.mockImplementation(async (id: string, assignee: string, opts?: { expectedAssignee?: string }) => ({
        id,
        assignee,
        harness: 'papercusp',
        payload: { expectedAssignee: opts?.expectedAssignee },
      }) as never);

      const b = await body({
        items: [{ id: 'WI-A', force: true, reason: 'item-specific reason' }, { id: 'WI-B', force: true }],
        reason: 'batch takeover reason',
      });

      expect(b.counts).toEqual({ ok: 2, failed: 0 });
      expect(claimM).toHaveBeenNthCalledWith(1, 'WI-A', 'me', {
        harness: undefined,
        fromHolder: 'me',
        expectedAssignee: 'peer-a',
        forceTakeoverAdmission: expect.objectContaining({
          itemId: 'WI-A',
          target: 'me',
          expectedAssignee: 'peer-a',
          workspaceId: 'ws-1',
        }),
      });
      expect(claimM).toHaveBeenNthCalledWith(2, 'WI-B', 'me', {
        harness: undefined,
        fromHolder: 'me',
        expectedAssignee: 'peer-b',
        forceTakeoverAdmission: expect.objectContaining({
          itemId: 'WI-B',
          target: 'me',
          expectedAssignee: 'peer-b',
          workspaceId: 'ws-1',
        }),
      });
      const reasons = forceAuditM.mock.calls.map((call) => (call[3] as { reason: string }).reason).sort();
      expect(reasons).toEqual(['batch takeover reason', 'item-specific reason']);
      expect(b.results.map((result: { forced?: { reason: string } }) => result.forced?.reason).sort()).toEqual([
        'batch takeover reason',
        'item-specific reason',
      ]);
    });

    it('skips the cross-holder guard for an unclaimed or caller-held item', async () => {
      getM.mockResolvedValue({ id: 'WI-FREE', assignee: null } as never);

      const b = await body({ id: 'WI-FREE', force: true });

      expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-FREE' });
      expect(b.results[0].forced).toBeUndefined();
      expect(assessForceM).not.toHaveBeenCalled();
    });

    // EI-22345414208647835: keep the defensive diagnosis honest if a force-authorized
    // holder-CAS still matches 0 rows for an independent floor/race. The admission
    // capability is passed to the writer above; this branch must not relabel the
    // unchanged holder as a live peer conflict.
    it('reports force_blocked_by_claim_floor — not claim_conflict — when the authorized CAS still matches 0 rows', async () => {
      // `issueItem` is declared below (readiness-floor section) but in the SAME enclosing
      // describe scope; by the time this `it` body actually runs (test-execution phase,
      // strictly after the whole file's synchronous collection phase) it is fully assigned.
      mockResolvedTyped(
        getM,
        issueItem({
          id: 'EI-STUCK',
          assignee: 'dead-holder',
          harness: 'papercup',
          lastProgressAt: '2026-08-20T08:00:00.000Z',
        }),
      );
      mockResolvedTyped(claimM, null);
      mockResolvedTyped(explainFloorsM, [
        {
          id: 'EI-STUCK',
          admissible: false,
          refusedBy: 'admission-pending',
          detail: 'duplicate screening is pending',
          retry: {
            clearsOnItsOwn: true as const,
            expectedWithinSec: 300,
            guaranteedWithinSec: 900,
            basis: 'admission promoter tick',
          },
        },
      ]);

      const b = await body({ id: 'EI-STUCK', force: true, reason: 'holder session ended; reclaiming for the drain' });

      expect(explainFloorsM).toHaveBeenCalledWith('papercup', ['EI-STUCK'], { assignee: 'me' });
      expect(b.results[0]).toMatchObject({
        ok: false,
        id: 'EI-STUCK',
        error: 'force_blocked_by_claim_floor',
        holder: 'dead-holder',
        claimFloor: { refusedBy: 'admission-pending' },
      });
      expect(b.results[0].hint).toContain('AUTHORIZED');
      expect(b.results[0].hint).toContain('NOT a live peer conflict');
      expect(b.results[0].hint).toContain('The claim floor is admission-pending');
      expect(b.results[0].hint).toContain('~5m');
      expect(b.results[0].hint).toContain('~15m');
      // The honest diagnosis short-circuits before the generic path — it must never
      // relabel this as an ordinary claim_conflict against a live peer.
      expect(classifyM).not.toHaveBeenCalled();
    });
  });

  it('a not-found item is classified and reported per item', async () => {
    claimM.mockResolvedValue(null as never);
    getM.mockResolvedValue(null as never);
    classifyM.mockReturnValue({ reason: 'not_found' } as never);
    const b = await body({ id: 'WI-404' });
    expect(b.results[0]).toEqual({ ok: false, id: 'WI-404', error: "work_item 'WI-404' not found" });
  });

  it('surfaces the canonical issue claim floor when the named claim is refused (EI-21637135941119450 / EI-22486369985989805)', async () => {
    claimM.mockResolvedValue(null as never);
    getM.mockResolvedValue({
      id: 'EI-PENDING', kind: 'bug', family: 'issue', harness: 'papercup', assignee: null,
    } as never);
    mockReturnTyped(classifyM, { reason: 'gated', holder: null });
    explainFloorsM.mockResolvedValue([
      {
        id: 'EI-PENDING',
        admissible: false,
        refusedBy: 'admission-pending',
        detail: 'duplicate screening is pending',
      },
    ] as never);

    const b = await body({ id: 'EI-PENDING', harness: 'papercup' });

    expect(explainFloorsM).toHaveBeenCalledWith('papercup', ['EI-PENDING'], { assignee: 'me' });
    expect(b.results[0]).toMatchObject({
      ok: false,
      id: 'EI-PENDING',
      error: 'not_claimable',
      claimFloor: {
        id: 'EI-PENDING',
        admissible: false,
        refusedBy: 'admission-pending',
        detail: 'duplicate screening is pending',
      },
    });
    expect(b.results[0].hint).toMatch(/admission-pending.*duplicate screening is pending/);
    const contract = `${(tool as { description?: string }).description ?? ''}\n${
      (tool as { guidance?: { when?: string } }).guidance?.when ?? ''
    }`;
    expect(contract).toMatch(/not terminal state, fleet scope or born-pending admission\/trust/);
    expect(contract).toContain('server-derived dispatch\/force may bypass pending rows');
    // A floor that advertises no bound renders EXACTLY the pre-existing hint — the
    // EI-21973318733042066 clauses below are strictly additive.
    expect(b.results[0].hint).not.toMatch(/CLEARS ON ITS OWN/);
  });

  /**
   * EI-21973318733042066 — a launched independent reviewer was briefed to claim a review
   * work-item created seconds earlier as its first act, and `work_items:claim` refused twice
   * with this floor. MEASURED: the admission promoter is a 30-minute cron, and that item stayed
   * pending 22.5 minutes — longer than the entire 9-minute life of the agent it was created for.
   * The refusal said only "wait for admitted/unreviewed", so the reviewer had no basis to choose
   * between waiting and proceeding unclaimed. It chose right by judgment; nothing helped it.
   */
  it('EI-21973318733042066: a self-clearing floor renders its BOUND and its remedy', async () => {
    mockResolvedTyped(claimM, null);
    mockResolvedTyped(getM, issueItem({ id: 'EI-PENDING' }));
    mockReturnTyped(classifyM, { reason: 'gated', holder: null });
    mockResolvedTyped(explainFloorsM, [
      {
        id: 'EI-PENDING',
        admissible: false,
        refusedBy: 'admission-pending',
        detail: 'duplicate screening is pending',
        retry: {
          clearsOnItsOwn: true as const,
          expectedWithinSec: 1800,
          guaranteedWithinSec: 3600,
          basis: 'the work-item-admission-promoter cron tick',
        },
        remedy: 'assign_to names the intended owner',
      },
    ]);

    const hint = (await body({ id: 'EI-PENDING', harness: 'papercup' })).results[0].hint as string;

    // The two numbers are what turn "wait" into a decision the caller can actually make.
    expect(hint).toContain('~30m');
    expect(hint).toContain('~60m');
    expect(hint).toMatch(/CLEARS ON ITS OWN/);
    expect(hint).toContain('WAIT, not a permanent refusal');
    // And it must not read as blanket reassurance: waiting out most of a tick is the WRONG move
    // for a short-lived agent, which is precisely what the reporter discovered the hard way.
    expect(hint).toMatch(/outlive it/);
    expect(hint).toContain('proceed unclaimed');
    // The remedy the reporter proposed as new design already existed; the refusal now names it.
    expect(hint).toContain('assign_to names the intended owner');
  });

  it('EI-21973318733042066 negative control: a PERMANENT floor claims neither', async () => {
    // Without this, a bug that unconditionally appended the clauses would pass every assertion
    // above. `retry` absent must mean "advertises no bound", never "is permanent" — and a
    // permanent floor must not acquire a self-clearing promise it cannot keep.
    mockResolvedTyped(claimM, null);
    mockResolvedTyped(getM, issueItem({ id: 'EI-OBS' }));
    mockReturnTyped(classifyM, { reason: 'gated', holder: null });
    mockResolvedTyped(explainFloorsM, [
      {
        id: 'EI-OBS',
        admissible: false,
        refusedBy: 'observation-lane',
        detail: 'payload.lane = "observation" — a captured NOTE, never work-queue material (D-005)',
      },
    ]);

    const hint = (await body({ id: 'EI-OBS', harness: 'papercup' })).results[0].hint as string;

    expect(hint).toContain('observation-lane');
    expect(hint).not.toMatch(/CLEARS ON ITS OWN/);
    expect(hint).not.toMatch(/~\d+m/);
    expect(hint).not.toContain('assign_to');
  });

  // EI-9274: a literal `'self'` assignee must resolve to the caller, not be stored
  // verbatim (WI-3881 was permanently orphaned this way — no live agent is ever
  // actually named "self").
  it('EI-9274: assignee:"self" resolves to the caller ownerId, not the literal string', async () => {
    const b = await body({ id: 'WI-1', assignee: 'self' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(claimM).toHaveBeenCalledWith('WI-1', 'me', { harness: undefined, fromHolder: identity.ownerId });
  });

  it('EI-9274: assignee:"self" under the su-loopback fallback is refused the same as an omitted assignee', async () => {
    identity.ownerId = 'su-loopback';
    const b = await body({ id: 'WI-LOOPBACK-SELF', assignee: 'self' });
    expect(b).toMatchObject({ ok: false, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-LOOPBACK-SELF', error: 'missing_client_identity' });
    expect(claimM).not.toHaveBeenCalled();
  });

  it('a concrete assignee ownerId literally named "self-service-bot" is passed through unchanged', async () => {
    const b = await body({ id: 'WI-1', assignee: 'self-service-bot' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(claimM).toHaveBeenCalledWith('WI-1', 'self-service-bot', { harness: undefined, fromHolder: identity.ownerId });
  });

  describe('readiness-floor contract for named claims (D-008)', () => {
    it('fails closed when the pre-claim read throws (WI-6746)', async () => {
      getM.mockRejectedValue(new Error('connection terminated unexpectedly'));
      const b = await body({ id: 'WI-HELD' });
      expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-HELD', error: 'work_item_unreadable' });
      expect(b.results[0].hint).toMatch(/could not be read|read failed/i);
      expect(b.results[0].hint).toMatch(/connection terminated/);
      expect(claimM).not.toHaveBeenCalled();
    });

    it('does not report an unreadable pre-claim read as a missing item (WI-6746)', async () => {
      getM.mockRejectedValue(new Error('statement timeout'));
      const b = await body({ id: 'WI-HELD' });
      expect(b.results[0].error).not.toMatch(/not found/i);
    });

    it('a genuine zero-row pre-claim read still proceeds to claimWorkItem (WI-6746)', async () => {
      claimM.mockResolvedValue({ id: 'WI-NEW', assignee: 'me' } as never);
      const b = await body({ id: 'WI-NEW' });
      expect(claimM).toHaveBeenCalled();
      expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-NEW' });
    });

    it('allows the exact named owner to claim a policy-tier claim-hold by id without force', async () => {
      getM.mockResolvedValue({
        id: 'WI-UNPARK',
        assignee: null,
        payload: {
          _claimHold: true,
          claim_hold_by: 'su-leader',
          claim_hold_reason: 'D-003 explicit policy-tier gate — UNPARK when the named owner claims by id',
        },
      } as never);
      claimM.mockResolvedValue({ id: 'WI-UNPARK', assignee: 'me' } as never);

      const b = await body({ id: 'WI-UNPARK' });

      expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-UNPARK', workItem: { assignee: 'me' } });
      expect(claimM).toHaveBeenCalledWith('WI-UNPARK', 'me', {
        harness: undefined,
        fromHolder: identity.ownerId,
      });
    });
  });
});

// EI-23701433507513915: a leader assignment stored the SHORT-FORM id (`su-851c1a7a`) as the
// holder. Every exact holder check then treated the real holder as a stranger.
describe('work_items:claim short-form owner ids (EI-23701433507513915)', () => {
  const ME = 'su-851c1a7a-8ea6-4c70-afeb-472e957fd3d8';
  const PEER_SAME_PREFIX = 'su-851c1a7a-0000-4000-8000-000000000001';

  it("re-claims the caller's OWN legacy short-form hold, widening the CAS by the RAW stored string", async () => {
    identity.ownerId = ME;
    OWNER_REGISTRY.ids = [ME];
    mockResolvedTyped(getM, issueItem({ id: 'WI-LEGACY', assignee: 'su-851c1a7a' }));
    mockResolvedTyped(claimM, issueItem({ id: 'WI-LEGACY', assignee: ME }));

    const b = await body({ id: 'WI-LEGACY' });

    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    // taken_by holds the short string, so the CAS must match THAT, while the claim writes ME.
    expect(claimM).toHaveBeenCalledWith('WI-LEGACY', ME, { harness: undefined, fromHolder: 'su-851c1a7a' });
    expect(assessForceM).not.toHaveBeenCalled();
  });

  it("does NOT treat an AMBIGUOUS legacy short hold as the caller's own", async () => {
    identity.ownerId = ME;
    OWNER_REGISTRY.ids = [ME, PEER_SAME_PREFIX];
    mockResolvedTyped(getM, issueItem({ id: 'WI-AMB-HOLD', assignee: 'su-851c1a7a' }));

    await body({ id: 'WI-AMB-HOLD' });

    expect(claimM).not.toHaveBeenCalledWith('WI-AMB-HOLD', ME, expect.objectContaining({ fromHolder: 'su-851c1a7a' }));
  });

  it('expands a short-form assignee ARG to the unique full id before claiming', async () => {
    OWNER_REGISTRY.ids = [ME];
    mockImplementationTyped(claimM, async (id, who) => issueItem({ id, assignee: who }));

    const b = await body({ id: 'WI-SHORT', assignee: 'su-851c1a7a' });

    expect(b.results[0]).toMatchObject({ ok: true });
    expect(claimM).toHaveBeenCalledWith('WI-SHORT', ME, expect.objectContaining({ fromHolder: 'me' }));
  });

  it('refuses an AMBIGUOUS short-form assignee with a typed error naming the candidates, and never claims', async () => {
    OWNER_REGISTRY.ids = [ME, PEER_SAME_PREFIX];

    const b = await body({ id: 'WI-AMB', assignee: 'su-851c1a7a' });

    expect(b.results[0]).toMatchObject({ ok: false, error: 'assignee_short_form_ambiguous' });
    expect(b.results[0].hint).toContain(PEER_SAME_PREFIX);
    expect(claimM).not.toHaveBeenCalled();
  });

  it('refuses an UNRESOLVED short-form assignee with a typed error instead of a phantom conflict', async () => {
    const b = await body({ id: 'WI-GONE', assignee: 'su-deadbeef' });

    expect(b.results[0]).toMatchObject({ ok: false, error: 'assignee_short_form_unresolved' });
    expect(claimM).not.toHaveBeenCalled();
  });

  it('refuses an arbitrary unknown full assignee before claiming', async () => {
    explicitAssigneeM.resolve.mockResolvedValue({
      ok: false,
      code: 'assignee_unknown',
      message: 'No known owner matches noop-do-not-use.',
    });

    const b = await body({ id: 'WI-UNKNOWN-ASSIGNEE', assignee: 'noop-do-not-use' });

    expect(explicitAssigneeM.resolve).toHaveBeenCalledWith('noop-do-not-use', 'me', 'ws-1');
    expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-UNKNOWN-ASSIGNEE', error: 'assignee_unknown' });
    expect(claimM).not.toHaveBeenCalled();
  });
});
