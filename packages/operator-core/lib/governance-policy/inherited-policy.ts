/**
 * Inherited organization → department → workspace governance policy
 * (papercusp-enterprise-readiness-roadmap-2026-10-09 P-005, spec ENT-P-005-OUTCOME:
 * "A workspace action forbidden by its inherited organization policy is rejected
 * through every selected execution path").
 *
 * PURE: no I/O. The store (./store.ts) loads a chain; the kernel seat
 * (./enforce.ts, called from operatorKernelEnforcement) maps one dispatch into a
 * request and asks `evaluateInheritedPolicy`.
 *
 * SEMANTICS — FAIL-CLOSED INTERSECTION:
 *  - A value passes ONE layer iff it is not matched by that layer's `deny` AND
 *    (the layer has no `allow` list for the category, OR the value matches it).
 *  - A value must pass EVERY layer of the chain. A descendant can therefore only
 *    NARROW what an ancestor permits: no workspace or department setting can widen
 *    an organization refusal. That is the spec falsifier made unrepresentable.
 *  - An exception lifts only the refusal of the layer that DECLARES it, never an
 *    ancestor's. An exception without a valid, future `expiresAt` grants nothing.
 *  - A malformed layer refuses everything (it cannot be read, so it cannot be
 *    proven permissive).
 *
 * Reuses the work-scope glob matcher and exception-expiry schema
 * (work-scope-policy.ts) so both policies read patterns and expiry identically.
 */
import { matchHarnessPattern, workScopeExceptionExpirySchema } from '../work-scope-policy';

/**
 * `providers` and `regions` (P-016a) judge WHO processes organization content and WHERE. They are
 * derived from the provider API host by ./processing-route.ts; residency must be an allow list,
 * because a global endpoint's region is unresolved and matches no deny pattern.
 */
export const GOVERNED_CATEGORIES = ['models', 'providers', 'regions', 'tools', 'plugins', 'egress', 'dataUse', 'actions', 'resources'] as const;
export type GovernedCategory = (typeof GOVERNED_CATEGORIES)[number];

export const POLICY_LEVELS = ['organization', 'department', 'workspace'] as const;
export type PolicyLevel = (typeof POLICY_LEVELS)[number];

export interface CategoryRule {
  /** When present, ONLY matching values pass this layer. */
  allow?: string[];
  /** Matching values never pass this layer. Deny beats allow within a layer. */
  deny?: string[];
}

export interface PolicyException {
  category: GovernedCategory;
  pattern: string;
  reason: string;
  approvedBy?: string;
  /** REQUIRED absolute expiry. Missing, malformed or past ⇒ the exception grants nothing. */
  expiresAt?: string;
}

export interface PolicyLayer {
  layerId: string;
  level: PolicyLevel;
  version: number;
  rules: Partial<Record<GovernedCategory, CategoryRule>>;
  exceptions?: PolicyException[];
}

/** The values one dispatch asks to use, per category. Empty / absent categories are not judged. */
export type GovernedRequest = Partial<Record<GovernedCategory, readonly string[]>>;

export type InheritedPolicyCode = 'org_policy:denied' | 'org_policy:malformed' | 'org_policy:unavailable';

export interface PolicyTraceStep {
  layerId: string;
  level: PolicyLevel;
  version: number;
  category: GovernedCategory;
  value: string;
  outcome: 'pass' | 'deny-rule' | 'not-allowed' | 'excepted' | 'malformed';
  /** The matching pattern (deny/allow/exception), when one decided the step. */
  pattern?: string;
  /** For `excepted`: the exception's expiry. */
  expiresAt?: string;
}

export type InheritedPolicyVerdict =
  | { allow: true; trace: PolicyTraceStep[] }
  | {
      allow: false;
      code: InheritedPolicyCode;
      decidedBy: PolicyTraceStep;
      reason: string;
      trace: PolicyTraceStep[];
    };

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Structural validation. A layer that fails it is treated as refusing everything. */
export function isWellFormedLayer(layer: unknown): layer is PolicyLayer {
  if (!layer || typeof layer !== 'object') return false;
  const l = layer as Partial<PolicyLayer>;
  if (typeof l.layerId !== 'string' || !l.layerId) return false;
  if (!POLICY_LEVELS.includes(l.level as PolicyLevel)) return false;
  if (typeof l.version !== 'number' || !Number.isInteger(l.version) || l.version < 1) return false;
  if (!l.rules || typeof l.rules !== 'object' || Array.isArray(l.rules)) return false;
  for (const [cat, rule] of Object.entries(l.rules)) {
    if (!GOVERNED_CATEGORIES.includes(cat as GovernedCategory)) return false;
    if (!rule || typeof rule !== 'object') return false;
    if (rule.allow !== undefined && !isStringArray(rule.allow)) return false;
    if (rule.deny !== undefined && !isStringArray(rule.deny)) return false;
  }
  if (l.exceptions !== undefined && !Array.isArray(l.exceptions)) return false;
  return true;
}

/** True when the exception is currently granting: well-formed, known category, valid future expiry. */
export function isActiveException(e: unknown, nowMs: number): e is PolicyException & { expiresAt: string } {
  if (!e || typeof e !== 'object') return false;
  const x = e as Partial<PolicyException>;
  if (!GOVERNED_CATEGORIES.includes(x.category as GovernedCategory)) return false;
  if (typeof x.pattern !== 'string' || !x.pattern.trim()) return false;
  if (typeof x.reason !== 'string' || !x.reason.trim()) return false;
  const expiry = workScopeExceptionExpirySchema.safeParse(x.expiresAt);
  return expiry.success && Date.parse(expiry.data) > nowMs;
}

/**
 * The work-scope matcher (exact, `*`, `prefix*`, `root/*`) plus a LEADING-`*` suffix form so an
 * egress host list can say `*.acme.example` (matches `docs.acme.example`, not `acme.example`).
 * Kept local: widening the shared matcher would change work-scope semantics.
 */
export function matchPolicyPattern(pattern: string, value: string): boolean {
  const p = (pattern ?? '').trim();
  const v = (value ?? '').trim();
  if (p.length > 1 && p.startsWith('*') && !p.endsWith('*')) return !!v && v.endsWith(p.slice(1));
  return matchHarnessPattern(p, v);
}

function firstMatch(patterns: readonly string[] | undefined, value: string): string | undefined {
  return patterns?.find((p) => matchPolicyPattern(p, value));
}

function judgeLayer(layer: unknown, category: GovernedCategory, value: string, nowMs: number): PolicyTraceStep {
  if (!isWellFormedLayer(layer)) {
    const l = (layer ?? {}) as Partial<PolicyLayer>;
    return {
      layerId: typeof l.layerId === 'string' ? l.layerId : '?',
      level: POLICY_LEVELS.includes(l.level as PolicyLevel) ? (l.level as PolicyLevel) : 'organization',
      version: typeof l.version === 'number' ? l.version : 0,
      category,
      value,
      outcome: 'malformed',
    };
  }
  const base = { layerId: layer.layerId, level: layer.level, version: layer.version, category, value };
  const rule = layer.rules[category];
  const denied = firstMatch(rule?.deny, value);
  const notAllowed = !denied && rule?.allow !== undefined && !firstMatch(rule.allow, value);
  if (!denied && !notAllowed) {
    const allowedBy = rule?.allow ? firstMatch(rule.allow, value) : undefined;
    return { ...base, outcome: 'pass', ...(allowedBy ? { pattern: allowedBy } : {}) };
  }
  // Only THIS layer's own exceptions can lift THIS layer's refusal.
  const exception = (layer.exceptions ?? []).find(
    (e) => isActiveException(e, nowMs) && e.category === category && matchPolicyPattern(e.pattern, value),
  ) as (PolicyException & { expiresAt: string }) | undefined;
  if (exception) return { ...base, outcome: 'excepted', pattern: exception.pattern, expiresAt: exception.expiresAt };
  return denied ? { ...base, outcome: 'deny-rule', pattern: denied } : { ...base, outcome: 'not-allowed' };
}

/**
 * Judge every requested value against every layer, root first. The first refusal
 * decides; the full trace is returned either way so a caller can EXPLAIN the verdict.
 */
export function evaluateInheritedPolicy(
  chain: readonly unknown[],
  request: GovernedRequest,
  now: Date = new Date(),
): InheritedPolicyVerdict {
  const nowMs = now.getTime();
  const trace: PolicyTraceStep[] = [];
  let refusal: PolicyTraceStep | undefined;
  for (const category of GOVERNED_CATEGORIES) {
    for (const raw of request[category] ?? []) {
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value) continue;
      for (const layer of chain) {
        const step = judgeLayer(layer, category, value, nowMs);
        trace.push(step);
        if (!refusal && (step.outcome === 'deny-rule' || step.outcome === 'not-allowed' || step.outcome === 'malformed')) {
          refusal = step;
        }
      }
    }
  }
  if (!refusal) return { allow: true, trace };
  const code: InheritedPolicyCode = refusal.outcome === 'malformed' ? 'org_policy:malformed' : 'org_policy:denied';
  return { allow: false, code, decidedBy: refusal, reason: describeRefusal(refusal), trace };
}

export function describeRefusal(step: PolicyTraceStep): string {
  const where = `${step.level} policy ${step.layerId} v${step.version}`;
  if (step.outcome === 'malformed') return `${where} is malformed and cannot be proven to permit ${step.category} '${step.value}'`;
  if (step.outcome === 'deny-rule') return `${where} denies ${step.category} '${step.value}' (rule '${step.pattern}')`;
  return `${where} does not allow ${step.category} '${step.value}' (not on its allow list)`;
}

export interface SimulationCase {
  request: GovernedRequest;
  before: InheritedPolicyVerdict;
  after: InheritedPolicyVerdict;
  changed: boolean;
}

/**
 * Policy simulation: judge each request against the CURRENT chain and against the
 * chain with `proposed` substituted for the layer of the same id (or appended as
 * the leaf when no layer has that id). Nothing is written.
 */
export function simulateInheritedPolicy(
  chain: readonly PolicyLayer[],
  proposed: PolicyLayer,
  requests: readonly GovernedRequest[],
  now: Date = new Date(),
): { proposedChain: PolicyLayer[]; cases: SimulationCase[] } {
  const idx = chain.findIndex((l) => l.layerId === proposed.layerId);
  const proposedChain = idx === -1 ? [...chain, proposed] : chain.map((l, i) => (i === idx ? proposed : l));
  const cases = requests.map((request) => {
    const before = evaluateInheritedPolicy(chain, request, now);
    const after = evaluateInheritedPolicy(proposedChain, request, now);
    return { request, before, after, changed: before.allow !== after.allow };
  });
  return { proposedChain, cases };
}
