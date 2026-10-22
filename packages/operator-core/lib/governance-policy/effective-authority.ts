/**
 * P-024 / D-024: the shared permission contract consumed by authority loaders and
 * resource adapters. This extends the existing governance rules and evaluator;
 * it does not store policy or install an alternative dispatch gate.
 *
 * The host must derive required authorities and the complete context vault set
 * from authoritative state. Agent arguments must never supply this snapshot.
 * An adapter must resolve its actual resource and recheck the revision vector
 * inside the transaction/lease guarding its first protected effect. The pure
 * functions here cannot provide that transaction or sandbox themselves.
 */
import {
  GOVERNED_CATEGORIES,
  evaluateInheritedPolicy,
  isWellFormedLayer,
  type CategoryRule,
  type GovernedCategory,
  type GovernedRequest,
  type PolicyLayer,
  type PolicyTraceStep,
} from './inherited-policy';

export const AUTHORITY_KINDS = [
  'identity', 'user', 'organization', 'department', 'workspace', 'vault', 'platform',
] as const;
export type AuthorityKind = typeof AUTHORITY_KINDS[number];
export interface AuthorityRef { kind: AuthorityKind; id: string }
export interface AuthorityPolicy extends AuthorityRef {
  /** Opaque revision pinned by the authority's canonical writer. */
  revision: string;
  /** Verified absence is explicit; unreadable is never the same as absent. */
  state: 'present' | 'not-applicable' | 'unavailable';
  rules?: Partial<Record<GovernedCategory, CategoryRule>>;
}
export interface AuthoritySnapshot {
  /** Complete, host-derived policy population, including absent optional levels. */
  required: readonly AuthorityRef[];
  policies: readonly AuthorityPolicy[];
  contextRevision: string;
  /** Exact retained-context vault IDs, derived before returning any vault data. */
  contextVaultIds: readonly string[];
}
export interface ScopedResource {
  kind: 'network' | 'filesystem' | 'store' | 'account' | 'recipient' | 'processing';
  operation: string;
  /** Canonical target resolved by the actual execution boundary. */
  target: string;
}
export interface PermissionRequest {
  tool: string;
  action: string;
  resource: ScopedResource;
  /** Additional scoped arguments expressed in the existing policy vocabulary. */
  constraints?: GovernedRequest;
}
export interface AuthorityRevision extends AuthorityRef { revision: string }
export interface AuthorityRevisionVector {
  contextRevision: string;
  authorities: readonly AuthorityRevision[];
}
export interface AuthorityTrace {
  authority: AuthorityRevision;
  category: GovernedCategory;
  value: string;
  outcome: PolicyTraceStep['outcome'];
  pattern?: string;
}
export type EffectivePermissionDecision = {
  allowed: boolean;
  code: 'allowed' | 'invalid-request' | 'authority-unavailable' | 'authority-malformed' | 'authority-stale' | 'denied';
  revisions: AuthorityRevisionVector | null;
  trace: AuthorityTrace[];
  decidingAuthority?: AuthorityRef;
  reason?: string;
};

const requiredKinds = AUTHORITY_KINDS.filter(kind => kind !== 'vault');
const keyOf = (ref: AuthorityRef) => JSON.stringify([ref.kind, ref.id]);
const validText = (value: unknown): value is string =>
  typeof value === 'string' && !!value.trim() && value === value.trim() && !/[\u0000-\u001f]/.test(value);
const unique = (values: readonly string[]) => new Set(values).size === values.length;

/** An unambiguous resource selector using the same policy pattern engine. */
export function resourcePermissionValue(resource: ScopedResource): string {
  return `${resource.kind}:${encodeURIComponent(resource.operation)}:${encodeURIComponent(resource.target)}`;
}

function policyLayer(policy: AuthorityPolicy): PolicyLayer {
  // PolicyLevel is the organization-store hierarchy, not a new authority type.
  // Use its leaf rule adapter; outward traces always identify the real authority.
  return { layerId: keyOf(policy), level: 'workspace', version: 1, rules: policy.rules! };
}

function snapshotProblem(snapshot: AuthoritySnapshot): { code: 'authority-unavailable' | 'authority-malformed'; reason: string } | null {
  const unavailable = (reason: string) => ({ code: 'authority-unavailable' as const, reason });
  const malformed = (reason: string) => ({ code: 'authority-malformed' as const, reason });
  if (!snapshot || !Array.isArray(snapshot.required) || !Array.isArray(snapshot.policies) ||
      !Array.isArray(snapshot.contextVaultIds)) return unavailable('authority snapshot is unavailable');
  if ([...snapshot.required, ...snapshot.policies].some(ref => !ref ||
      !AUTHORITY_KINDS.includes(ref.kind) || !validText(ref.id))) return malformed('invalid authority reference');
  if (!validText(snapshot.contextRevision)) return unavailable('context revision is unavailable');
  if (!unique(snapshot.required.map(keyOf)) || !unique(snapshot.policies.map(keyOf))) return malformed('duplicate authority');
  if (!unique(snapshot.contextVaultIds) || snapshot.contextVaultIds.some(id => !validText(id))) return malformed('invalid context vault set');
  for (const kind of requiredKinds) {
    if (!snapshot.required.some(ref => ref.kind === kind)) return unavailable(`missing ${kind} authority declaration`);
  }
  const required = new Set(snapshot.required.map(keyOf));
  if (snapshot.policies.some(policy => !required.has(keyOf(policy)))) return malformed('policy outside required authority population');
  const vaults = snapshot.required.filter(ref => ref.kind === 'vault').map(ref => ref.id);
  if (vaults.length !== snapshot.contextVaultIds.length || vaults.some(id => !snapshot.contextVaultIds.includes(id))) {
    return unavailable('retained vault and policy populations differ');
  }
  for (const ref of snapshot.required) {
    const policy = snapshot.policies.find(entry => keyOf(entry) === keyOf(ref));
    if (!policy || !validText(policy.revision) || policy.state === 'unavailable') return unavailable(`unreadable authority ${keyOf(ref)}`);
    if (policy.state === 'not-applicable') {
      if (['identity', 'user', 'vault', 'platform'].includes(ref.kind)) return unavailable(`required authority cannot be absent: ${keyOf(ref)}`);
      if (policy.rules !== undefined) return malformed('absent authority carries rules');
    } else if (policy.state !== 'present' || !isWellFormedLayer(policyLayer(policy))) {
      return malformed(`invalid authority policy ${keyOf(ref)}`);
    }
    if (policy.kind === 'identity' &&
        ['tools', 'actions', 'resources'].some(category =>
          policy.rules?.[category as GovernedCategory]?.allow === undefined)) {
      return unavailable('identity grant must explicitly cover tools, actions and resources');
    }
  }
  return null;
}

/** Every independent authority must permit the resolved action and resource. */
export function evaluateEffectivePermission(
  snapshot: AuthoritySnapshot,
  request: PermissionRequest,
  now: Date = new Date(),
): EffectivePermissionDecision {
  const resourceKinds: ScopedResource['kind'][] = ['network', 'filesystem', 'store', 'account', 'recipient', 'processing'];
  if (!request || !validText(request.tool) || !validText(request.action) || !request.resource ||
      !resourceKinds.includes(request.resource.kind) || !validText(request.resource.operation) || !validText(request.resource.target)) {
    return { allowed: false, code: 'invalid-request', revisions: null, trace: [] };
  }
  if (request.constraints !== undefined && (!request.constraints || typeof request.constraints !== 'object' ||
      Array.isArray(request.constraints) || Object.entries(request.constraints).some(([category, values]) =>
        !GOVERNED_CATEGORIES.includes(category as GovernedCategory) || !Array.isArray(values) ||
        values.some(value => !validText(value))))) {
    return { allowed: false, code: 'invalid-request', revisions: null, trace: [] };
  }
  const problem = snapshotProblem(snapshot);
  if (problem) return { allowed: false, ...problem, revisions: null, trace: [] };
  const governed: GovernedRequest = {
    ...request.constraints,
    tools: [...(request.constraints?.tools ?? []), request.tool],
    actions: [...(request.constraints?.actions ?? []), request.action],
    resources: [...(request.constraints?.resources ?? []), resourcePermissionValue(request.resource)],
  };
  for (const category of GOVERNED_CATEGORIES) {
    if (governed[category]) governed[category] = [...new Set(governed[category])].sort();
  }
  const policies = [...snapshot.policies].sort((a, b) =>
    AUTHORITY_KINDS.indexOf(a.kind) - AUTHORITY_KINDS.indexOf(b.kind) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const revisions: AuthorityRevisionVector = {
    contextRevision: snapshot.contextRevision,
    authorities: policies.map(({ kind, id, revision }) => ({ kind, id, revision })),
  };
  const trace: AuthorityTrace[] = [];
  let decidingAuthority: AuthorityRef | undefined;
  for (const policy of policies) {
    if (policy.state === 'not-applicable') continue;
    const verdict = evaluateInheritedPolicy([policyLayer(policy)], governed, now);
    trace.push(...verdict.trace.map(step => ({
      authority: { kind: policy.kind, id: policy.id, revision: policy.revision },
      category: step.category, value: step.value, outcome: step.outcome,
      ...(step.pattern ? { pattern: step.pattern } : {}),
    })));
    if (!verdict.allow && !decidingAuthority) decidingAuthority = { kind: policy.kind, id: policy.id };
  }
  return decidingAuthority
    ? { allowed: false, code: 'denied', revisions, trace, decidingAuthority }
    : { allowed: true, code: 'allowed', revisions, trace };
}

/** Queue/in-flight adapters must reject a token if any authority or context moved. */
export function authorityRevisionIsCurrent(token: AuthorityRevisionVector | null | undefined, snapshot: AuthoritySnapshot): boolean {
  if (!token || typeof token !== 'object' || !validText(token.contextRevision) ||
      !Array.isArray(token.authorities) || token.authorities.some(ref => !ref ||
        !AUTHORITY_KINDS.includes(ref.kind) || !validText(ref.id) || !validText(ref.revision)) ||
      snapshotProblem(snapshot) || token.contextRevision !== snapshot.contextRevision ||
      token.authorities.length !== snapshot.policies.length || !unique(token.authorities.map(keyOf))) return false;
  return snapshot.policies.every(policy => token.authorities.some(ref => keyOf(ref) === keyOf(policy) && ref.revision === policy.revision));
}

/**
 * Shared queue/in-flight contract: re-evaluate the actual resolved request and
 * reject a stale authorization even if the new policy happens to permit it.
 * Call inside the host's transaction/lease immediately before the protected
 * effect; a successful pure check does not itself acquire that lease.
 */
export function revalidateEffectivePermission(
  snapshot: AuthoritySnapshot,
  request: PermissionRequest,
  expected: AuthorityRevisionVector | null | undefined,
  now: Date = new Date(),
): EffectivePermissionDecision {
  const decision = evaluateEffectivePermission(snapshot, request, now);
  // Retain the current deciding authority and trace when revocation denies.
  if (!decision.allowed) return decision;
  if (!authorityRevisionIsCurrent(expected, snapshot)) {
    return { ...decision, allowed: false, code: 'authority-stale',
      reason: 'Authority or retained context changed; fresh authorization is required before effect' };
  }
  return decision;
}

/** Proof is over a pinned complete finite authority space, never sampled requests. */
export interface PermissionPopulationProof {
  populationRevision: string;
  complete: boolean;
  population: readonly string[];
  allowed: readonly string[];
}
export interface PermissionChangeComparison {
  kind: 'narrowing' | 'neutral' | 'widening' | 'unknown';
  added: readonly string[];
  removed: readonly string[];
  reason?: string;
}

export function comparePermissionPopulations(
  before: PermissionPopulationProof,
  after: PermissionPopulationProof,
): PermissionChangeComparison {
  const unknown = (reason: string): PermissionChangeComparison => ({ kind: 'unknown', added: [], removed: [], reason });
  for (const proof of [before, after]) {
    if (!proof || !Array.isArray(proof.population) || !Array.isArray(proof.allowed) ||
        !proof.complete || !validText(proof.populationRevision) || proof.population.length === 0 ||
        proof.population.some(atom => !validText(atom)) || !unique(proof.population) || !unique(proof.allowed) ||
        proof.allowed.some(atom => !proof.population.includes(atom))) return unknown('incomplete or invalid authority population');
  }
  if (before.populationRevision !== after.populationRevision || before.population.length !== after.population.length ||
      before.population.some(atom => !after.population.includes(atom))) return unknown('incomparable authority populations');
  const added = after.allowed.filter(atom => !before.allowed.includes(atom)).sort();
  const removed = before.allowed.filter(atom => !after.allowed.includes(atom)).sort();
  return { kind: added.length ? 'widening' : removed.length ? 'narrowing' : 'neutral', added, removed };
}
