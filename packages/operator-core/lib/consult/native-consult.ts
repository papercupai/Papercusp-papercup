/** Internal native acceptance constraints; ordinary consults keep their policy. */
import { z } from 'zod';
import type { RouteResult, RoutingCandidate } from './relevance-router';
import type { ResumeTarget } from '../agent-launch-core';
import type { AdvSessionRow } from '../adv-sessions';
import type { StableSource } from '../session-port/source';
import type { CarryBriefHeldItem } from '../carry-brief';
import type { PlanItemClaim } from '../plan-items/claims';
import { concreteWorkspaceIdOrNull } from '../workspace-registry';

export const nativeConsultConstraintsSchema = z.object({
  sourceBackend: z.enum(['claude', 'codex', 'omp']),
  targetBackend: z.enum(['claude', 'codex', 'omp']),
  sourceState: z.enum(['live', 'ended']),
  requireSourcePlanClaims: z.boolean().optional().describe(
    'Internal acceptance case: require a canonical nonexpired source-owner plan lease before retrieval and dispatch; does not change ranking floors.',
  ),
}).strict();
export type NativeConsultConstraints = z.infer<typeof nativeConsultConstraintsSchema>;

type NativePlanClaimEndpoint = Pick<PlanItemClaim, 'workspaceId' | 'harnessSlug' | 'planSlug' | 'itemId'
  | 'claimId' | 'owner' | 'livenessMode' | 'ttlSec' | 'acquiredTs' | 'expiresTs' | 'lastActivityTs' | 'expired'>;

export type NativeConsultBoundary = {
  status: 'measured'; capturedAt: string; completedAt: string; readScope: string; sourceAdvSessionId: number;
  sourceNativeSessionId: string; sourceOwnerId: string;
  snapshot: { kind: StableSource['source']; highWaterBytes: number; completeBytes: number;
    sha256: string; archiveRelpath: string | null; fileIdentity: StableSource['fileIdentity'] | null };
  claims: { checked: Array<{ id: string; harness: string | null; plan: string | null; items: string[] }>;
    truncated: false; scope: string };
  planClaims: { checked: NativePlanClaimEndpoint[]; truncated: false; scope: string };
} | { status: 'unknown'; reason: string };

interface NativeConsultBoundaryDeps {
  readSession: (id: number, workspaceId: string) => Promise<AdvSessionRow | null>;
  readSource: (source: AdvSessionRow) => Promise<StableSource>;
  readClaims: (ownerId: string, workspaceId: string) => Promise<CarryBriefHeldItem[]>;
  readPlanClaims: (ownerId: string, workspaceId: string) => Promise<PlanItemClaim[]>;
  now: () => string;
}

/** Persist a before observation on the existing routing snapshot, before any
 * dispatch. Endpoint equality later is corroboration; actor attribution is separate. */
export async function captureNativeConsultBoundary(
  target: ResumeTarget, workspaceId: string, injected?: NativeConsultBoundaryDeps,
): Promise<NativeConsultBoundary> {
  try {
    const ws = concreteWorkspaceIdOrNull(workspaceId);
    if (!ws) throw new Error('exact source workspace identity missing');
    const deps = injected ?? await (async () => {
      const [{ getAdvSessionInWorkspace }, { acquireTrackedSessionSource }, { readHeldWorkItems }, { listClaimsForOwner }] = await Promise.all([
        import('../adv-sessions'), import('../session-port/service'), import('../carry-brief'), import('../plan-items/claims'),
      ]);
      return { readSession: getAdvSessionInWorkspace, readSource: acquireTrackedSessionSource,
        readClaims: (ownerId: string, ws: string) => readHeldWorkItems(ownerId, ws,
          { limit: 201, getWorkItemCheckpointFn: async () => null }),
        readPlanClaims: (ownerId: string, ws: string) => listClaimsForOwner(ws, ownerId, 201),
        now: () => new Date().toISOString() };
    })();
    if (!target.sessionId || !target.ownerId) throw new Error('exact source native/owner identity missing');
    const row = await deps.readSession(target.advSessionId, ws);
    const backend = target.agent === 'claude-code' ? 'claude' : target.agent;
    if (!row || row.coordOwnerId !== target.ownerId || row.agent !== backend || row.role != null) {
      throw new Error('source row/backend/owner binding changed');
    }
    const currentNative = row.agent === 'omp' ? row.ompThreadId ?? row.sessionId : row.sessionId;
    if (target.live && (row.endedAt || currentNative !== target.sessionId)) {
      throw new Error('live native incarnation changed before boundary observation');
    }
    // The resolver has already validated exact historical incarnation ownership.
    const exactRow = { ...row, sessionId: target.sessionId,
      ...(row.agent === 'omp' ? { ompThreadId: target.sessionId } : {}), endedAt: target.endedAt };
    const capturedAt = deps.now();
    const source = await deps.readSource(exactRow);
    if (target.live && (source.source !== 'live-jsonl' || !source.fileIdentity)) {
      throw new Error('live source was not read from its canonical descriptor');
    }
    if (!source.completeBytes) throw new Error('source complete prefix is empty');
    const held = await deps.readClaims(target.ownerId, ws);
    if (held.length > 200) throw new Error('claim census exceeds the 200-item observation bound');
    const planClaims = await deps.readPlanClaims(target.ownerId, ws);
    if (planClaims.length > 200) throw new Error('plan claim census exceeds the 200-item observation bound');
    if (planClaims.some(claim => claim.owner !== target.ownerId || claim.workspaceId !== ws)) {
      throw new Error('plan claim owner/workspace binding changed');
    }
    const planEndpoints = planClaims.map(claim => ({ workspaceId: claim.workspaceId, harnessSlug: claim.harnessSlug,
      planSlug: claim.planSlug, itemId: claim.itemId, claimId: claim.claimId, owner: claim.owner,
      livenessMode: claim.livenessMode, ttlSec: claim.ttlSec, acquiredTs: new Date(claim.acquiredTs).toISOString(),
      expiresTs: new Date(claim.expiresTs).toISOString(), lastActivityTs: new Date(claim.lastActivityTs).toISOString(),
      expired: claim.expired })).sort((a, b) => a.harnessSlug.localeCompare(b.harnessSlug)
        || a.planSlug.localeCompare(b.planSlug) || a.itemId.localeCompare(b.itemId));
    return { status: 'measured', capturedAt, completedAt: deps.now(),
      readScope: 'sequential source and claim endpoint reads; not an atomic snapshot or transition/actor/wake history',
      sourceAdvSessionId: row.id,
      sourceNativeSessionId: target.sessionId, sourceOwnerId: target.ownerId,
      snapshot: { kind: source.source, highWaterBytes: source.highWaterBytes,
        completeBytes: source.completeBytes, sha256: source.sha256, archiveRelpath: source.relpath,
        fileIdentity: source.fileIdentity ?? null },
      claims: { checked: held.map(item => ({ id: item.id, harness: item.harness,
        plan: item.sourcePlanSlug ?? null, items: item.sourcePlanItemIds ?? [] })).sort((a, b) => a.id.localeCompare(b.id)),
        truncated: false, scope: 'canonical nonterminal held work-item references; plan claims are recorded separately' },
      planClaims: { checked: planEndpoints, truncated: false,
        scope: 'exact-workspace owner plan-claim endpoints across harnesses, including lapsed leases; equality does not exclude mutate-then-revert or attribute actors' } };
  } catch (error) {
    return { status: 'unknown', reason: String(error) };
  }
}

export interface NativeConsultSourceObservation {
  ownerId: string;
  evidenceSessions: string[];
  sessionId: string | null;
  backend: string | null;
  state: 'live' | 'ended' | 'unknown';
  eligible: boolean;
  reason: string;
  before?: NativeConsultBoundary;
}

/** A preliminary registry predicate cannot certify the later dispatch boundary. */
export function nativePlanClaimRequirementMismatch(
  before: NativeConsultBoundary, constraint: NativeConsultConstraints,
): string | null {
  if (!constraint.requireSourcePlanClaims) return null;
  if (before.status !== 'measured') return 'required source plan leases were not measured';
  const completedAt = Date.parse(before.completedAt);
  if (!Number.isFinite(completedAt) || !before.planClaims.checked.some(claim =>
    claim.owner === before.sourceOwnerId && !claim.expired && Date.parse(claim.expiresTs) > completedAt)) {
    return 'required nonexpired source plan lease missing at dispatch boundary';
  }
  return null;
}

/** Filter the real ranked pool without changing its scores, order or floors.
 * Exclusions remain on the same persisted snapshot, outside the selection pool. */
export async function filterNativeConsultRoute(
  route: RouteResult,
  constraint: NativeConsultConstraints,
  resolve: (candidate: RoutingCandidate) => Promise<NativeConsultSourceObservation>,
): Promise<RouteResult> {
  const observations: NativeConsultSourceObservation[] = [];
  const eligible = new Set<string>();
  for (const candidate of route.snapshot.candidates) {
    const observation = await resolve(candidate);
    observations.push(observation);
    if (observation.eligible) eligible.add(candidate.ownerId);
  }
  const retain = (candidate: RoutingCandidate): RoutingCandidate => {
    const source = observations.find(row => row.ownerId === candidate.ownerId)!;
    return { ...candidate, evidence: candidate.evidence.filter(ref => ref.session_id === source.sessionId) };
  };
  const qualified = route.qualified.filter(candidate => eligible.has(candidate.ownerId)).map(retain);
  return {
    ...route,
    qualified,
    verdict: route.verdict === 'relevance_unmeasured' ? route.verdict : qualified.length ? 'routed' : 'no_qualified_responder',
    snapshot: { ...route.snapshot,
      candidates: route.snapshot.candidates.filter(candidate => eligible.has(candidate.ownerId)).map(retain),
      nativeConsultPool: route.snapshot.candidates,
      nativeConsult: constraint,
      nativeConsultSources: observations,
    },
  };
}
