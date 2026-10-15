import { describe, expect, it, vi } from 'vitest';
import { captureNativeConsultBoundary, filterNativeConsultRoute, nativePlanClaimRequirementMismatch, type NativeConsultConstraints } from './native-consult';
import { observeNativeConsultSource } from './consult-dispatch';
import type { RouteResult } from './relevance-router';
import type { resolveResumeTarget } from '../agent-launch-core';
import type { AdvSessionRow } from '../adv-sessions';
import type { PlanItemClaim } from '../plan-items/claims';

const constraint: NativeConsultConstraints = { sourceBackend: 'claude', targetBackend: 'codex', sourceState: 'ended' };
const candidate = { ownerId: 'owner-exact', evidence: [
  { session_id: 'foreign-native', turn_idx: 8, sim: 0.99 },
  { session_id: 'wrong-backend-native', turn_idx: 6, sim: 0.95 },
  { session_id: 'exact-native', turn_idx: 4, sim: 0.9 },
] };
const resolve: typeof resolveResumeTarget = async args => ({ ok: true,
  sessionId: args.sessionId!, resumeId: args.sessionId!, ownerId: args.sessionId === 'foreign-native' ? 'owner-foreign' : 'owner-exact',
  agent: args.sessionId === 'wrong-backend-native' ? 'codex' : 'claude', live: false,
  endedAt: '2026-10-01T00:00:00Z', advSessionId: 7,
} as never);

describe('native consult source evidence filter', () => {
  it('walks exact evidence past a foreign identity and wrong backend without owner fallback', async () => {
    expect(await observeNativeConsultSource(candidate, constraint, { resolveResumeTarget: resolve })).toMatchObject({
      ownerId: 'owner-exact', sessionId: 'exact-native', backend: 'claude', state: 'ended', eligible: true,
      evidenceSessions: ['foreign-native', 'wrong-backend-native', 'exact-native'],
    });
  });
  it('retains excluded evidence and unchanged ranks, and narrows delivery to the resolved exact session', async () => {
    const keep = { ...candidate, relevance: 0.8, score: 0.7 };
    const excluded = { ...keep, ownerId: 'owner-missing', score: 0.9, evidence: [] };
    const route = { verdict: 'routed', qualified: [excluded, keep], snapshot: { candidates: [excluded, keep] } } as unknown as RouteResult;
    const filtered = await filterNativeConsultRoute(route, constraint,
      row => observeNativeConsultSource(row, constraint, { resolveResumeTarget: resolve }));
    expect(filtered.qualified).toMatchObject([{ ownerId: 'owner-exact', relevance: 0.8, score: 0.7,
      evidence: [{ session_id: 'exact-native', turn_idx: 4, sim: 0.9 }] }]);
    expect(filtered.snapshot.candidates).toEqual(filtered.qualified);
    expect(filtered.snapshot.nativeConsultPool).toEqual([excluded, keep]);
    expect(filtered.snapshot.nativeConsultSources?.[0]).toMatchObject({ eligible: false,
      reason: expect.stringContaining('exact evidence') });
    expect(route.qualified).toEqual([excluded, keep]);
  });
  it('keeps instrument degradation unmeasured instead of declaring a negative result', async () => {
    const route = { verdict: 'relevance_unmeasured', qualified: [], snapshot: { candidates: [] } } as unknown as RouteResult;
    expect(await filterNativeConsultRoute(route, constraint, async () => { throw new Error('unreachable'); }))
      .toMatchObject({ verdict: 'relevance_unmeasured', qualified: [] });
  });
});

describe('native consult pre-dispatch boundary', () => {
  const target = { ownerId: 'owner-exact', sessionId: 'exact-native', agent: 'claude',
    live: true, endedAt: null, advSessionId: 7 } as never;
  const source = { id: 7, coordOwnerId: 'owner-exact', sessionId: 'exact-native', agent: 'claude',
    endedAt: null, role: null, cwd: '/repo' } as AdvSessionRow;
  const planClaim: PlanItemClaim = { workspaceId: 'workspace-native', harnessSlug: 'papercusp',
    planSlug: 'plan-only', itemId: 'P-009', claimId: 'incarnation-before', owner: 'owner-exact',
    ownerLabel: null, ownerName: null, intent: 'independent source work', livenessMode: 'activity',
    ttlSec: 1800, acquiredTs: '2026-10-12T01:00:00Z', expiresTs: '2026-10-12T01:30:00Z',
    lastActivityTs: '2026-10-12T01:00:00Z', expired: true };
  const makeDeps = () => ({
    readSession: async () => source,
    readSource: async () => ({ bytes: Buffer.from('{}\n'), sha256: 'a'.repeat(64), highWaterBytes: 3,
      completeBytes: 3, source: 'live-jsonl' as const, relpath: null,
      fileIdentity: { path: '/canonical/native.jsonl', device: 2, inode: 8, links: 1 } }),
    readClaims: async () => [{ id: 'WI-held', harness: 'papercusp', sourcePlanSlug: 'plan-native',
      sourcePlanItemIds: ['P-002'] }] as never,
    readPlanClaims: async () => [planClaim],
    now: () => '2026-10-12T02:00:00Z',
  });

  it('records exact canonical prefix, descriptor identity and canonical held references before dispatch', async () => {
    expect(await captureNativeConsultBoundary(target, 'workspace-native', makeDeps())).toMatchObject({
      status: 'measured', capturedAt: '2026-10-12T02:00:00Z', sourceAdvSessionId: 7,
      sourceNativeSessionId: 'exact-native', sourceOwnerId: 'owner-exact',
      snapshot: { kind: 'live-jsonl', completeBytes: 3, sha256: 'a'.repeat(64),
        fileIdentity: { device: 2, inode: 8, links: 1 } },
      claims: { checked: [{ id: 'WI-held', harness: 'papercusp', plan: 'plan-native', items: ['P-002'] }], truncated: false },
    });
  });

  it('refuses a live owner whose exact selected native incarnation is no longer current', async () => {
    const deps = makeDeps();
    deps.readSession = async () => ({ ...source, sessionId: 'newer-native' });
    const readSource = vi.spyOn(deps, 'readSource');
    expect(await captureNativeConsultBoundary(target, 'workspace-native', deps)).toMatchObject({
      status: 'unknown', reason: expect.stringContaining('live native incarnation changed'),
    });
    expect(readSource).not.toHaveBeenCalled();
  });

  it('records plan-only claim incarnations and leases, including expired rows, in an explicit read window', async () => {
    const deps = makeDeps();
    const readPlans = vi.spyOn(deps, 'readPlanClaims');
    deps.now = vi.fn().mockReturnValueOnce('2026-10-12T02:00:00Z').mockReturnValue('2026-10-12T02:00:01Z');
    const observation = await captureNativeConsultBoundary(target, 'workspace-native', deps);
    expect(readPlans).toHaveBeenCalledWith('owner-exact', 'workspace-native');
    expect(observation).toMatchObject({ status: 'measured', capturedAt: '2026-10-12T02:00:00Z',
      completedAt: '2026-10-12T02:00:01Z', planClaims: { truncated: false, checked: [{
        workspaceId: 'workspace-native', harnessSlug: 'papercusp', planSlug: 'plan-only', itemId: 'P-009',
        claimId: 'incarnation-before', owner: 'owner-exact', livenessMode: 'activity', ttlSec: 1800,
        acquiredTs: '2026-10-12T01:00:00.000Z', expiresTs: '2026-10-12T01:30:00.000Z',
        lastActivityTs: '2026-10-12T01:00:00.000Z', expired: true,
      }], scope: expect.stringContaining('endpoint') } });
  });

  it('distinguishes a replacement incarnation and a lease renewal under the same owner and plan item', async () => {
    const before = await captureNativeConsultBoundary(target, 'workspace-native', makeDeps());
    const deps = makeDeps();
    deps.readPlanClaims = async () => [{ ...planClaim, claimId: 'incarnation-after',
      acquiredTs: '2026-10-12T02:00:00Z', expiresTs: '2026-10-12T02:30:00Z', expired: false }];
    const replaced = await captureNativeConsultBoundary(target, 'workspace-native', deps);
    deps.readPlanClaims = async () => [{ ...planClaim, expiresTs: '2026-10-12T02:30:00Z', expired: false }];
    const renewed = await captureNativeConsultBoundary(target, 'workspace-native', deps);
    expect(before.status).toBe('measured');
    expect(replaced.status).toBe('measured');
    expect(renewed.status).toBe('measured');
    if (before.status !== 'measured' || replaced.status !== 'measured' || renewed.status !== 'measured') return;
    expect(replaced.planClaims.checked[0].claimId).not.toBe(before.planClaims.checked[0].claimId);
    expect(renewed.planClaims.checked[0].claimId).toBe(before.planClaims.checked[0].claimId);
    expect(renewed.planClaims.checked[0].expiresTs).not.toBe(before.planClaims.checked[0].expiresTs);
    expect(replaced.claims).toEqual(before.claims);
  });

  it('revalidates nonempty source plan leases after retrieval and refuses unknown or expired endpoints', async () => {
    const required = { ...constraint, requireSourcePlanClaims: true };
    const deps = makeDeps();
    deps.readPlanClaims = async () => [{ ...planClaim, expired: false, expiresTs: '2026-10-12T03:00:00Z' }];
    const held = await captureNativeConsultBoundary(target, 'workspace-native', deps);
    expect(nativePlanClaimRequirementMismatch(held, required)).toBeNull();
    deps.readPlanClaims = async () => [];
    expect(nativePlanClaimRequirementMismatch(await captureNativeConsultBoundary(target, 'workspace-native', deps), required))
      .toContain('missing');
    deps.readPlanClaims = async () => [{ ...planClaim, expired: false }];
    expect(nativePlanClaimRequirementMismatch(await captureNativeConsultBoundary(target, 'workspace-native', deps), required))
      .toContain('missing');
    expect(nativePlanClaimRequirementMismatch({ status: 'unknown', reason: 'unreadable' }, required))
      .toContain('not measured');
    expect(nativePlanClaimRequirementMismatch({ status: 'unknown', reason: 'unreadable' }, constraint)).toBeNull();
  });

  it('keeps unreadable, overflowing or misbound plan claims unknown rather than certifying an empty endpoint', async () => {
    const deps = makeDeps();
    deps.readPlanClaims = async () => { throw new Error('plan claims unavailable'); };
    expect(await captureNativeConsultBoundary(target, 'workspace-native', deps)).toMatchObject({
      status: 'unknown', reason: expect.stringContaining('plan claims unavailable'),
    });
    deps.readPlanClaims = async () => Array.from({ length: 201 }, (_, n) => ({ ...planClaim, itemId: `P-${n}` }));
    expect(await captureNativeConsultBoundary(target, 'workspace-native', deps)).toMatchObject({
      status: 'unknown', reason: expect.stringContaining('plan claim census exceeds'),
    });
    for (const change of [{ owner: 'foreign-owner' }, { workspaceId: 'foreign-workspace' }]) {
      deps.readPlanClaims = async () => [{ ...planClaim, ...change }];
      expect(await captureNativeConsultBoundary(target, 'workspace-native', deps)).toMatchObject({
        status: 'unknown', reason: expect.stringContaining('plan claim owner/workspace binding'),
      });
    }
  });

  it('records a measured empty plan endpoint and sorts disjoint plan/harness keys without merging them', async () => {
    const deps = makeDeps();
    deps.readPlanClaims = async () => [];
    expect(await captureNativeConsultBoundary(target, 'workspace-native', deps)).toMatchObject({
      status: 'measured', planClaims: { checked: [], truncated: false },
    });
    deps.readPlanClaims = async () => [planClaim,
      { ...planClaim, harnessSlug: 'aaa', claimId: 'another-harness' },
      { ...planClaim, planSlug: 'aaa', claimId: 'another-plan' }];
    const observation = await captureNativeConsultBoundary(target, 'workspace-native', deps);
    expect(observation.status).toBe('measured');
    if (observation.status !== 'measured') return;
    expect(observation.planClaims.checked.map(row => row.claimId))
      .toEqual(['another-harness', 'another-plan', 'incarnation-before']);
  });

  it('refuses an unspecified workspace before reading source or claims', async () => {
    const deps = makeDeps();
    const readSession = vi.spyOn(deps, 'readSession');
    for (const workspace of ['*', '', '   ']) {
      expect(await captureNativeConsultBoundary(target, workspace, deps)).toMatchObject({
        status: 'unknown', reason: expect.stringContaining('workspace identity missing'),
      });
    }
    expect(readSession).not.toHaveBeenCalled();
  });

  it('keeps an invalid lease timestamp unknown rather than storing an incomplete signature', async () => {
    const deps = makeDeps();
    deps.readPlanClaims = async () => [{ ...planClaim, expiresTs: 'unreadable' }];
    expect(await captureNativeConsultBoundary(target, 'workspace-native', deps)).toMatchObject({ status: 'unknown' });
  });

  it('keeps unreadable or truncated claims unknown instead of recording an empty census', async () => {
    const deps = makeDeps();
    deps.readClaims = async () => { throw new Error('claims unavailable'); };
    expect(await captureNativeConsultBoundary(target, 'workspace-native', deps)).toMatchObject({
      status: 'unknown', reason: expect.stringContaining('claims unavailable'),
    });
    deps.readClaims = async () => Array.from({ length: 201 }, (_, n) => ({ id: `WI-${n}` })) as never;
    expect(await captureNativeConsultBoundary(target, 'workspace-native', deps)).toMatchObject({
      status: 'unknown', reason: expect.stringContaining('claim census exceeds'),
    });
  });

  it('does not count an archive fallback as a measured live prefix', async () => {
    const deps = makeDeps();
    deps.readSource = async () => ({ ...await makeDeps().readSource(), source: 'archive-manifest' }) as never;
    expect(await captureNativeConsultBoundary(target, 'workspace-native', deps)).toMatchObject({
      status: 'unknown', reason: expect.stringContaining('live source was not read'),
    });
  });
});
