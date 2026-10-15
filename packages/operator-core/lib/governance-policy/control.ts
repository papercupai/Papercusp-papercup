/**
 * Governance policy CONTROL operations (plan papercusp-enterprise-readiness-roadmap-2026-10-09
 * P-005, admin-UX half WI-6554700010011434; backend WI-10007900).
 *
 * ONE implementation of get / explain / simulate / set / add-exception, shared by every door:
 *  - the MCP tool `governance:policy` (agent-tools/governance/policy.ts),
 *  - the admin pane's write doors POST /api/governance-policy/* (endpoint-route/routes/governance-policy),
 *  - the admin pane's read, the `governancePolicy.state` sync query.
 * A pane click and a tool call therefore take the same path and record the same version row.
 * This mirrors work-scope-control.ts.
 *
 * EXPLAIN IS ENFORCEMENT. `explainFromLoad` maps a chain load to a verdict exactly as
 * enforce.ts#enforceInheritedPolicy does: `none` is not governed, `malformed` refuses, and
 * `ok` is `evaluateInheritedPolicy`. control.test.ts pins that parity, so the pane cannot
 * explain a decision the kernel would not make.
 *
 * NO WIDENING FROM THE UI. Writes go through store.ts#upsertLayer, and the evaluator is a
 * fail-closed intersection. A workspace layer that "allows" what an organization layer denies
 * is stored, but it does not change the verdict. `simulate` reports that case with
 * `decidedByAncestor`, so the pane can say so before the admin saves.
 */
import { z } from 'zod';
import type { RefusalContract } from '../capability-envelope/refusal-contract-types';
import {
  CUSTOMER_DATA_CLASSES,
  CUSTOMER_DATA_CLASS_DESCRIPTIONS,
  dataClassUseLabel,
  type CustomerDataClass,
} from '../auth/hosted/customer-data-map';
import {
  describeRefusal,
  evaluateInheritedPolicy,
  GOVERNED_CATEGORIES,
  POLICY_LEVELS,
  type CategoryRule,
  type GovernedCategory,
  type GovernedRequest,
  type InheritedPolicyCode,
  type PolicyException,
  type PolicyLayer,
  type PolicyLevel,
  type PolicyTraceStep,
} from './inherited-policy';
import {
  GovernancePolicyWriteError,
  listLayers,
  listVersions,
  loadChainForWorkspace,
  loadLayer,
  MAX_CHAIN_DEPTH,
  upsertLayer,
  upsertLayerInTx,
  validateLayerInput,
  type ChainLoad,
  type PolicyLayerVersion,
  type StoredPolicyLayer,
  type UpsertLayerInput,
} from './store';
import type { Sql } from 'postgres';
import {
  authorize as authorizeGovernance,
  createOrganizationLayer,
  grantDelegation,
  GovernanceAuthorityError,
  listDelegations,
  principalKindOf,
  revokeDelegation,
  type GovernanceAuthorityErrorCode,
  type GovernanceCapability,
  type GovernanceDelegation,
} from './authority';
import {
  decideSensitiveAction,
  executeSensitiveAction,
  listSensitiveActions,
  prepareSensitiveAction,
  SensitiveActionError,
  type DecideSensitiveActionInput,
  type ExecuteSensitiveActionInput,
  type PrepareSensitiveActionInput,
  type SensitiveActionErrorCode,
  type SensitiveActionRequest,
} from './sensitive-action';

/** The admin pane's sync query. Every successful write invalidates it. */
export const GOVERNANCE_POLICY_SYNC_QUERY = 'governancePolicy.state';
/** Version history is read for at most this many layers per state read (bounded fan-out). */
export const MAX_LAYERS_WITH_HISTORY = 50;
export const DEFAULT_VERSION_LIMIT = 20;

// ── wire schemas (shared by the MCP tool and the HTTP routes) ──────────────────────────────

const ruleSchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
});
const exceptionSchema = z.object({
  category: z.string(),
  pattern: z.string(),
  reason: z.string(),
  approvedBy: z.string().optional(),
  expiresAt: z.string(),
});
/** Category keys are validated by validateLayerInput, which names the governed set in its error. */
const rulesSchema = z.record(z.string(), ruleSchema);
const requestSchema = z.record(z.string(), z.array(z.string()));

const layerShape = {
  layerId: z.string().min(1),
  level: z.enum(POLICY_LEVELS),
  scopeRef: z.string().min(1),
  parentLayerId: z.string().min(1).nullable(),
  rules: rulesSchema,
  exceptions: z.array(exceptionSchema).optional(),
};

export const governancePolicyGetSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  versionLimit: z.number().int().min(1).max(100).optional(),
});
export const governancePolicyExplainSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  request: requestSchema,
});
export const governancePolicySimulateSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  proposed: z.object(layerShape),
  requests: z.array(requestSchema).min(1).max(50),
});
export const governancePolicySetSchema = z.object({
  ...layerShape,
  reason: z.string().min(1),
  expectedVersion: z.number().int().min(0).optional(),
});
export const governancePolicyAddExceptionSchema = z.object({
  layerId: z.string().min(1),
  exception: exceptionSchema,
  reason: z.string().min(1),
  expectedVersion: z.number().int().min(1).optional(),
});

// ── deps (injectable so the operations are unit-testable without Postgres) ─────────────────

export interface GovernancePolicyControlDeps {
  loadChain: (workspaceId: string) => Promise<ChainLoad>;
  listLayers: () => Promise<StoredPolicyLayer[]>;
  listVersions: (layerId: string, limit: number) => Promise<PolicyLayerVersion[]>;
  loadLayer: (layerId: string) => Promise<StoredPolicyLayer | null>;
  upsertLayer: (input: UpsertLayerInput) => Promise<StoredPolicyLayer>;
  /** Drop the enforcement seat's cached chains (undefined = every workspace). */
  invalidateCache: (workspaceId?: string) => void;
  /** Tell open panes to re-read. Best-effort: a failed notify never fails a committed write. */
  notify: (queryName: string) => Promise<void>;
  now: () => Date;
  /** Does `principal` hold `capability` over `layerId`? (authority.ts, P-006 / D-015) */
  authorize: (principal: string, layerId: string, capability: GovernanceCapability) => Promise<boolean>;
  /** Create a brand-new organization layer and its creator's bootstrap delegation, atomically. */
  createOrganization: (input: UpsertLayerInput) => Promise<StoredPolicyLayer>;
  prepareAction: (input: PrepareSensitiveActionInput) => Promise<SensitiveActionRequest>;
  decideAction: (input: DecideSensitiveActionInput) => Promise<SensitiveActionRequest>;
  executeAction: <T>(
    input: ExecuteSensitiveActionInput,
    run: (tx: Sql, request: SensitiveActionRequest) => Promise<T>,
  ) => Promise<{ request: SensitiveActionRequest; result: T }>;
}

const defaultDeps: GovernancePolicyControlDeps = {
  loadChain: (workspaceId) => loadChainForWorkspace(workspaceId),
  listLayers: () => listLayers(),
  listVersions: (layerId, limit) => listVersions(layerId, limit),
  loadLayer: (layerId) => loadLayer(layerId),
  upsertLayer: (input) => upsertLayer(input),
  invalidateCache: (workspaceId) => {
    void import('./enforce').then((m) => m.invalidateGovernancePolicyCache(workspaceId));
  },
  notify: async (queryName) => {
    const { notifySyncInvalidate } = await import('../sync-sse');
    await notifySyncInvalidate(queryName);
  },
  now: () => new Date(),
  authorize: (principal, layerId, capability) => authorizeGovernance(principal, layerId, capability),
  createOrganization: async (input) => (await createOrganizationLayer(input)).layer,
  prepareAction: (input) => prepareSensitiveAction(input),
  decideAction: (input) => decideSensitiveAction(input),
  executeAction: (input, run) => executeSensitiveAction(input, run),
};

function resolveDeps(deps?: Partial<GovernancePolicyControlDeps>): GovernancePolicyControlDeps {
  return { ...defaultDeps, ...deps };
}

// ── get ─────────────────────────────────────────────────────────────────────────────────────

export interface GovernancePolicyState {
  workspaceId: string;
  /** `none`: the workspace has no workspace layer, so no inherited policy governs it. */
  load: 'none' | 'ok' | 'malformed';
  reason: string | null;
  /** Root first: organization → department… → workspace. Empty when `load` is `none`. */
  chain: StoredPolicyLayer[];
  /** `layerId@vN>…`, the same revision string the enforcement seat stamps on a refusal. */
  revision: string | null;
  /** Every stored layer, so an admin can manage layers outside this workspace's chain. */
  layers: StoredPolicyLayer[];
  /** Newest first, per layer. Read for chain layers first, then others, up to MAX_LAYERS_WITH_HISTORY. */
  versions: Record<string, PolicyLayerVersion[]>;
  historyTruncated: boolean;
  categories: readonly GovernedCategory[];
  levels: readonly PolicyLevel[];
  /**
   * The customer data classes a `dataUse` rule can govern (P-016a DLP): `label` is the value a
   * rule names (`class:pii`); the store refuses any other `class:` value.
   */
  dataClasses: readonly GovernedDataClass[];
  generatedAt: string;
}

export interface GovernedDataClass {
  label: string;
  class: CustomerDataClass;
  description: string;
}

/** The data-class vocabulary, in CUSTOMER_DATA_CLASSES order. */
export function governedDataClasses(): GovernedDataClass[] {
  return CUSTOMER_DATA_CLASSES.map((cls) => ({
    label: dataClassUseLabel(cls),
    class: cls,
    description: CUSTOMER_DATA_CLASS_DESCRIPTIONS[cls],
  }));
}

export function chainRevision(chain: readonly Pick<PolicyLayer, 'layerId' | 'version'>[]): string | null {
  return chain.length ? chain.map((l) => `${l.layerId}@v${l.version}`).join('>') : null;
}

export async function getGovernancePolicyState(
  workspaceId: string,
  opts: { versionLimit?: number } = {},
  deps?: Partial<GovernancePolicyControlDeps>,
): Promise<GovernancePolicyState> {
  const d = resolveDeps(deps);
  const [load, layers] = await Promise.all([d.loadChain(workspaceId), d.listLayers()]);
  const chain = load.status === 'none' ? [] : load.chain;
  const chainIds = new Set(chain.map((l) => l.layerId));
  const ordered = [...chain, ...layers.filter((l) => !chainIds.has(l.layerId))];
  const withHistory = ordered.slice(0, MAX_LAYERS_WITH_HISTORY);
  const limit = opts.versionLimit ?? DEFAULT_VERSION_LIMIT;
  const histories = await Promise.all(withHistory.map((l) => d.listVersions(l.layerId, limit)));
  const versions: Record<string, PolicyLayerVersion[]> = {};
  withHistory.forEach((l, i) => {
    versions[l.layerId] = histories[i] ?? [];
  });
  return {
    workspaceId,
    load: load.status,
    reason: load.status === 'malformed' ? load.reason : null,
    chain,
    revision: chainRevision(chain),
    layers,
    versions,
    historyTruncated: ordered.length > withHistory.length,
    categories: GOVERNED_CATEGORIES,
    levels: POLICY_LEVELS,
    dataClasses: governedDataClasses(),
    generatedAt: d.now().toISOString(),
  };
}

// ── explain ─────────────────────────────────────────────────────────────────────────────────

export type ExplainedVerdict =
  | { allow: true; trace: PolicyTraceStep[] }
  | {
      allow: false;
      code: InheritedPolicyCode;
      reason: string;
      /** The step that refused. Null only for a malformed CHAIN, which refuses before any step. */
      decidedBy: PolicyTraceStep | null;
      trace: PolicyTraceStep[];
    };

export interface GovernancePolicyExplanation {
  workspaceId: string;
  governed: boolean;
  verdict: ExplainedVerdict;
  /** One sentence for the admin: why this was allowed or refused. */
  explanation: string;
  revision: string | null;
}

/** Normalize an untyped request: governed categories only, trimmed non-empty strings. */
export function parseGovernedRequest(
  raw: unknown,
): { ok: true; request: GovernedRequest } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `request must map ${GOVERNED_CATEGORIES.join('/')} to string arrays` };
  }
  const out: Partial<Record<GovernedCategory, string[]>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!GOVERNED_CATEGORIES.includes(key as GovernedCategory)) {
      return { ok: false, error: `unknown category '${key}' (expected one of ${GOVERNED_CATEGORIES.join(', ')})` };
    }
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
      return { ok: false, error: `${key} must be an array of strings` };
    }
    const values = value.map((v) => v.trim()).filter(Boolean);
    if (values.length) out[key as GovernedCategory] = values;
  }
  if (!Object.keys(out).length) return { ok: false, error: 'the request names no value to judge' };
  return { ok: true, request: out };
}

/**
 * The verdict the enforcement seat would reach for this load and request. Pure. Kept in
 * lock-step with enforce.ts#enforceInheritedPolicy (parity pinned in control.test.ts).
 */
export function explainFromLoad(
  workspaceId: string,
  load: ChainLoad,
  request: GovernedRequest,
  now: Date,
): GovernancePolicyExplanation {
  if (load.status === 'none') {
    return {
      workspaceId,
      governed: false,
      verdict: { allow: true, trace: [] },
      explanation: `No inherited policy governs workspace ${workspaceId} (it has no workspace layer), so policy refuses nothing.`,
      revision: null,
    };
  }
  const revision = chainRevision(load.chain);
  if (load.status === 'malformed') {
    const reason = `the governing policy chain for workspace ${workspaceId} is malformed (${load.reason})`;
    return {
      workspaceId,
      governed: true,
      verdict: { allow: false, code: 'org_policy:malformed', reason, decidedBy: null, trace: [] },
      explanation: `Refused: ${reason}. A chain that cannot be read cannot be proven to permit anything.`,
      revision,
    };
  }
  const verdict = evaluateInheritedPolicy(load.chain, request, now);
  if (verdict.allow) {
    return {
      workspaceId,
      governed: true,
      verdict,
      explanation: `Allowed: every layer of ${revision} permits each requested value.`,
      revision,
    };
  }
  return {
    workspaceId,
    governed: true,
    verdict: { allow: false, code: verdict.code, reason: verdict.reason, decidedBy: verdict.decidedBy, trace: verdict.trace },
    explanation: `Refused: ${describeRefusal(verdict.decidedBy)}.`,
    revision,
  };
}

export async function explainGovernancePolicy(
  workspaceId: string,
  request: GovernedRequest,
  deps?: Partial<GovernancePolicyControlDeps>,
): Promise<GovernancePolicyExplanation> {
  const d = resolveDeps(deps);
  return explainFromLoad(workspaceId, await d.loadChain(workspaceId), request, d.now());
}

// ── simulate ────────────────────────────────────────────────────────────────────────────────

export interface ProposedLayer {
  layerId: string;
  level: PolicyLevel;
  scopeRef: string;
  parentLayerId: string | null;
  rules: Partial<Record<GovernedCategory, CategoryRule>>;
  exceptions?: PolicyException[];
}

export interface GovernancePolicySimulationCase {
  request: GovernedRequest;
  before: ExplainedVerdict;
  after: ExplainedVerdict;
  changed: boolean;
  /**
   * After the change the request is still refused, and by a layer OTHER than the proposed one.
   * This is how the pane shows that a lower layer cannot widen an ancestor's refusal.
   */
  decidedByAncestor: boolean;
}

export interface GovernancePolicySimulation {
  workspaceId: string;
  /** validateLayerInput's verdict on the proposal. Non-null means `set` would refuse it. */
  validation: string | null;
  /** False when the proposed layer is not in this workspace's chain, so it cannot change its decisions. */
  affectsWorkspace: boolean;
  note: string | null;
  proposedVersion: number;
  proposedRevision: string | null;
  cases: GovernancePolicySimulationCase[];
  changedCount: number;
}

function verdictOfChain(chain: readonly PolicyLayer[], request: GovernedRequest, now: Date): ExplainedVerdict {
  const v = evaluateInheritedPolicy(chain, request, now);
  return v.allow ? v : { allow: false, code: v.code, reason: v.reason, decidedBy: v.decidedBy, trace: v.trace };
}

/** Walk parent links from `layerId` to the root. Returns root-first, or null on a broken/cyclic chain. */
async function ancestryOf(
  layerId: string | null,
  d: GovernancePolicyControlDeps,
): Promise<StoredPolicyLayer[] | null> {
  const out: StoredPolicyLayer[] = [];
  const seen = new Set<string>();
  let cursor = layerId;
  while (cursor) {
    if (seen.has(cursor) || out.length >= MAX_CHAIN_DEPTH) return null;
    seen.add(cursor);
    const layer = await d.loadLayer(cursor);
    if (!layer) return null;
    out.unshift(layer);
    cursor = layer.parentLayerId;
  }
  return out;
}

/** Judge each request before and after `proposed` is saved. Writes nothing. */
export async function simulateGovernancePolicy(
  workspaceId: string,
  proposed: ProposedLayer,
  requests: readonly GovernedRequest[],
  deps?: Partial<GovernancePolicyControlDeps>,
): Promise<GovernancePolicySimulation> {
  const d = resolveDeps(deps);
  const now = d.now();
  const load = await d.loadChain(workspaceId);
  const current = load.status === 'none' ? [] : load.chain;
  const existing = current.find((l) => l.layerId === proposed.layerId) ?? (await d.loadLayer(proposed.layerId));
  const proposedVersion = (existing?.version ?? 0) + 1;
  const proposedLayer: PolicyLayer = {
    layerId: proposed.layerId,
    level: proposed.level,
    version: proposedVersion,
    rules: proposed.rules,
    exceptions: proposed.exceptions ?? [],
  };
  const validation = validateLayerInput({ ...proposed, actor: 'simulate', reason: 'simulate' });

  let proposedChain: PolicyLayer[] | null = null;
  let note: string | null = null;
  const idx = current.findIndex((l) => l.layerId === proposed.layerId);
  if (idx !== -1) {
    proposedChain = current.map((l, i) => (i === idx ? proposedLayer : l));
  } else if (proposed.level === 'workspace' && proposed.scopeRef === workspaceId && load.status === 'none') {
    const ancestors = await ancestryOf(proposed.parentLayerId, d);
    if (ancestors) proposedChain = [...ancestors, proposedLayer];
    else note = `parent ${proposed.parentLayerId ?? '(none)'} does not resolve to an organization-rooted chain; saving would be refused`;
  } else {
    note = `layer ${proposed.layerId} is not in workspace ${workspaceId}'s chain (${chainRevision(current) ?? 'none'}), so it does not change this workspace's decisions`;
  }

  const cases = requests.map((request) => {
    const before = explainFromLoad(workspaceId, load, request, now).verdict;
    const after = proposedChain ? verdictOfChain(proposedChain, request, now) : before;
    const decidedByAncestor =
      proposedChain !== null && !after.allow && after.decidedBy !== null && after.decidedBy.layerId !== proposed.layerId;
    return { request, before, after, changed: before.allow !== after.allow, decidedByAncestor };
  });
  return {
    workspaceId,
    validation,
    affectsWorkspace: proposedChain !== null,
    note,
    proposedVersion,
    proposedRevision: proposedChain ? chainRevision(proposedChain) : null,
    cases,
    changedCount: cases.filter((c) => c.changed).length,
  };
}

// ── set / add-exception ─────────────────────────────────────────────────────────────────────

export type GovernancePolicyWriteCode =
  | 'invalid'
  | 'conflict'
  | 'parent'
  | 'unavailable'
  /** An organization/department change is a sensitive action: prepare, approve, apply (P-006). */
  | 'approval-required'
  /** The actor holds no authority over that scope (P-006 delegated administration). */
  | 'forbidden';

type PolicyFailure<Code extends string> = Code extends 'forbidden'
  ? { ok: false; code: Code; error: string; refusal: RefusalContract }
  : { ok: false; code: Code; error: string };

export type GovernancePolicyWriteResult =
  | { ok: true; layer: StoredPolicyLayer; revision: string }
  | PolicyFailure<GovernancePolicyWriteCode>;

export interface SetLayerRequest extends ProposedLayer {
  reason: string;
  /** Optimistic concurrency: the version the admin edited (0 = the layer must not exist yet). */
  expectedVersion?: number;
}

/** Create or replace one layer: validate, write a new version with actor + reason, invalidate. */
export async function setGovernancePolicyLayer(
  req: SetLayerRequest,
  actor: string,
  deps?: Partial<GovernancePolicyControlDeps>,
): Promise<GovernancePolicyWriteResult> {
  const d = resolveDeps(deps);
  const input: UpsertLayerInput = {
    layerId: req.layerId,
    level: req.level,
    scopeRef: req.scopeRef,
    parentLayerId: req.parentLayerId,
    rules: req.rules,
    exceptions: req.exceptions ?? [],
    actor,
    reason: req.reason,
    expectedVersion: req.expectedVersion,
  };
  const invalid = validateLayerInput(input);
  if (invalid) return { ok: false, code: 'invalid', error: invalid };
  let layer: StoredPolicyLayer;
  try {
    const gate = await directWriteGate(req, actor, d);
    if (gate !== 'write' && gate !== 'bootstrap') return gate;
    layer = gate === 'bootstrap' ? await d.createOrganization(input) : await d.upsertLayer(input);
  } catch (err) {
    if (err instanceof GovernanceAuthorityError) return governanceAuthorityFailure(err);
    if (err instanceof GovernancePolicyWriteError) return policyFailure(err.code, err.message);
    return policyFailure('unavailable', err instanceof Error ? err.message : String(err));
  }
  // An organization or department layer governs every workspace beneath it: drop every cached chain.
  d.invalidateCache();
  await d.notify(GOVERNANCE_POLICY_SYNC_QUERY).catch(() => undefined);
  return { ok: true, layer, revision: `${layer.layerId}@v${layer.version}` };
}

/** Append one expiring exception to a layer as a new version (expiresAt is required). */
export async function addGovernancePolicyException(
  req: { layerId: string; exception: PolicyException; reason: string; expectedVersion?: number },
  actor: string,
  deps?: Partial<GovernancePolicyControlDeps>,
): Promise<GovernancePolicyWriteResult> {
  const d = resolveDeps(deps);
  let layer: StoredPolicyLayer | null;
  try {
    layer = await d.loadLayer(req.layerId);
  } catch (err) {
    return { ok: false, code: 'unavailable', error: err instanceof Error ? err.message : String(err) };
  }
  if (!layer) return { ok: false, code: 'invalid', error: `no policy layer '${req.layerId}'` };
  if (req.expectedVersion !== undefined && req.expectedVersion !== layer.version) {
    return {
      ok: false,
      code: 'conflict',
      error: `layer ${req.layerId} is at v${layer.version}, not the v${req.expectedVersion} you edited; reload and retry`,
    };
  }
  return setGovernancePolicyLayer(
    {
      layerId: layer.layerId,
      level: layer.level,
      scopeRef: layer.scopeRef,
      parentLayerId: layer.parentLayerId,
      rules: layer.rules,
      exceptions: [...(layer.exceptions ?? []), req.exception],
      reason: req.reason,
      expectedVersion: layer.version,
    },
    actor,
    d,
  );
}

// ── P-006 (D-015): sensitive policy changes and delegated authority ─────────────

/** The sensitive action kind for an organization/department governance policy change. */
export const GOVERNANCE_POLICY_CHANGE_ACTION = 'governance-policy:set-layer';

const SENSITIVE_LEVELS: readonly PolicyLevel[] = ['organization', 'department'];

function authorityCode(code: GovernanceAuthorityErrorCode): GovernancePolicyWriteCode {
  return code === 'not-found' ? 'invalid' : code;
}

/**
 * Who may write `req` directly. An organization or department layer change is a sensitive action
 * (prepare, distinct approval, apply), except the bootstrap creation of a brand-new organization by
 * a human. A workspace layer needs `prepare` over its existing layer (or, when new, its parent) and
 * over any new parent, so a department administrator writes only inside its delegated subtree.
 */
async function directWriteGate(
  req: SetLayerRequest,
  actor: string,
  d: GovernancePolicyControlDeps,
): Promise<'write' | 'bootstrap' | GovernancePolicyWriteResult> {
  const existing = await d.loadLayer(req.layerId);
  if (req.level === 'organization' && !existing) {
    if (principalKindOf(actor) !== 'human') {
      return {
        ok: false,
        code: 'forbidden',
        error: `${actor} is a service identity; only a human administrator can create an organization`,
        refusal: governanceAuthorityRefusal({ actorKind: 'service', operation: 'organization-bootstrap' }),
      };
    }
    return 'bootstrap';
  }
  if (SENSITIVE_LEVELS.includes(req.level) || (existing && SENSITIVE_LEVELS.includes(existing.level))) {
    return {
      ok: false,
      code: 'approval-required',
      error:
        `changing ${req.level} layer ${req.layerId} is a sensitive action: prepare it (op=prepare, which simulates it), ` +
        'have a distinct authorized administrator approve it (op=decide), then apply it (op=apply)',
    };
  }
  const scopes = new Set<string>();
  if (existing) scopes.add(existing.layerId);
  if (req.parentLayerId && req.parentLayerId !== existing?.parentLayerId) scopes.add(req.parentLayerId);
  for (const scope of scopes) {
    if (!(await d.authorize(actor, scope, 'prepare'))) {
      return {
        ok: false,
        code: 'forbidden',
        error: `${actor} holds no prepare authority over ${scope}; an administrator writes only within its delegated scope`,
        refusal: governanceAuthorityRefusal({ capability: 'prepare', scope, authority: 'not-granted' }),
      };
    }
  }
  return 'write';
}

export const governancePolicyPrepareSchema = z.object({
  ...layerShape,
  /** The workspace the server simulates the change against (it must sit under the layer). */
  workspaceId: z.string().min(1),
  reason: z.string().min(1),
  expectedVersion: z.number().int().min(0).optional(),
  requests: z.array(requestSchema).max(50).optional(),
  requiredApprovals: z.number().int().min(1).max(5).optional(),
});
export const governancePolicyDecideSchema = z.object({
  requestId: z.string().min(1),
  decision: z.enum(['approve', 'deny']),
  reason: z.string().min(1),
});
export const governancePolicyApplySchema = z.object({
  requestId: z.string().min(1),
  expectedPayloadHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export const governancePolicyDelegateSchema = z.object({
  principal: z.string().min(1),
  layerId: z.string().min(1),
  capabilities: z.array(z.enum(['prepare', 'approve', 'delegate'])).min(1),
  reason: z.string().min(1),
  expiresAt: z.string().min(1),
});
export const governancePolicyRevokeDelegationSchema = z.object({
  delegationId: z.string().min(1),
  reason: z.string().min(1),
});
export const governancePolicyAuthoritySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  layerIds: z.array(z.string().min(1)).max(50).optional(),
  status: z.enum(['open', 'all']).optional(),
});

export interface PrepareChangeRequest extends SetLayerRequest {
  workspaceId: string;
  requests?: GovernedRequest[];
  requiredApprovals?: number;
}

export type GovernancePolicyChangeCode = GovernancePolicyWriteCode | SensitiveActionErrorCode;
export type GovernancePolicyFailure = PolicyFailure<GovernancePolicyChangeCode>;
export type GovernancePolicyChangeResult = { ok: true; request: SensitiveActionRequest } | GovernancePolicyFailure;
export type GovernancePolicyApplyResult =
  | { ok: true; request: SensitiveActionRequest; layer: { layerId: string; version: number }; revision: string }
  | GovernancePolicyFailure;
export type GovernanceDelegationResult = { ok: true; delegation: GovernanceDelegation } | GovernancePolicyFailure;

function changeFailure(err: unknown): GovernancePolicyFailure {
  if (err instanceof SensitiveActionError) return policyFailure(err.code, err.message);
  if (err instanceof GovernanceAuthorityError) return governanceAuthorityFailure(err);
  if (err instanceof GovernancePolicyWriteError) return policyFailure(err.code, err.message);
  return policyFailure('unavailable', err instanceof Error ? err.message : String(err));
}

function governanceAuthorityRefusal(observed: RefusalContract['observed']): RefusalContract {
  return {
    observed,
    liftsWhen:
      'the operation is submitted by an actor with the required governance capability on the target layer; use a different authorized grantor for self-grant refusals or the prepare/approve/apply flow for an existing organization layer',
    whoCanMakeItTrue: ['owner', 'host'],
  };
}

function policyFailure<Code extends string>(
  code: Code,
  error: string,
  observed: RefusalContract['observed'] = {},
): PolicyFailure<Code> {
  if (code === 'forbidden') {
    return { ok: false, code, error, refusal: governanceAuthorityRefusal(observed) } as PolicyFailure<Code>;
  }
  return { ok: false, code, error } as PolicyFailure<Code>;
}

function governanceAuthorityFailure(error: GovernanceAuthorityError): PolicyFailure<GovernancePolicyWriteCode> {
  const code = authorityCode(error.code);
  return policyFailure(code, error.message, { authorityFailure: error.message.slice(0, 160) });
}

/**
 * Prepare an organization/department change: validate, refuse a stale edit, SIMULATE it on the
 * server against `workspaceId`, and record the request with the simulated chain revision and the
 * target's base version. Apply later refuses if either has moved (enforced simulate-before-apply).
 */
export async function prepareGovernancePolicyChange(
  req: PrepareChangeRequest,
  actor: string,
  deps?: Partial<GovernancePolicyControlDeps>,
): Promise<GovernancePolicyChangeResult> {
  const d = resolveDeps(deps);
  const proposed: ProposedLayer = {
    layerId: req.layerId,
    level: req.level,
    scopeRef: req.scopeRef,
    parentLayerId: req.parentLayerId,
    rules: req.rules,
    exceptions: req.exceptions ?? [],
  };
  const invalid = validateLayerInput({ ...proposed, actor, reason: req.reason, expectedVersion: req.expectedVersion });
  if (invalid) return { ok: false, code: 'invalid', error: invalid };
  try {
    const existing = await d.loadLayer(req.layerId);
    const baseVersion = existing?.version ?? 0;
    if (req.expectedVersion !== undefined && req.expectedVersion !== baseVersion) {
      return { ok: false, code: 'conflict', error: `layer ${req.layerId} is at v${baseVersion}, not the v${req.expectedVersion} you edited; reload and retry` };
    }
    if (!existing && req.level === 'organization') {
      return { ok: false, code: 'invalid', error: 'a new organization layer is created directly by its human administrator (op=set), not prepared' };
    }
    if (existing && existing.parentLayerId !== req.parentLayerId) {
      return { ok: false, code: 'invalid', error: `re-parenting ${req.layerId} is not supported; create a new layer under the new parent` };
    }
    const simulation = await simulateGovernancePolicy(req.workspaceId, proposed, req.requests ?? [], d);
    if (simulation.validation) return { ok: false, code: 'invalid', error: simulation.validation };
    if (existing && !simulation.affectsWorkspace) {
      return { ok: false, code: 'invalid', error: `workspace ${req.workspaceId} is not governed by ${req.layerId}; simulate against a workspace beneath it` };
    }
    const load = await d.loadChain(req.workspaceId);
    const request = await d.prepareAction({
      workspaceId: req.workspaceId,
      actionKind: GOVERNANCE_POLICY_CHANGE_ACTION,
      targetLayerId: req.layerId,
      authorityLayerId: existing ? existing.layerId : (req.parentLayerId as string),
      payload: { ...proposed, reason: req.reason },
      chainRevision: chainRevision(load.status === 'none' ? [] : load.chain),
      baseVersion,
      simulation,
      preparedBy: actor,
      reason: req.reason,
      requiredApprovals: req.requiredApprovals,
      now: d.now(),
    });
    await d.notify(GOVERNANCE_POLICY_SYNC_QUERY).catch(() => undefined);
    return { ok: true, request };
  } catch (err) {
    return changeFailure(err);
  }
}

/** Approve or deny a prepared change. The decider must be a distinct human with approve authority. */
export async function decideGovernancePolicyChange(
  req: { requestId: string; decision: 'approve' | 'deny'; reason: string },
  actor: string,
  deps?: Partial<GovernancePolicyControlDeps>,
): Promise<GovernancePolicyChangeResult> {
  const d = resolveDeps(deps);
  try {
    const request = await d.decideAction({ requestId: req.requestId, approver: actor, decision: req.decision, reason: req.reason, now: d.now() });
    await d.notify(GOVERNANCE_POLICY_SYNC_QUERY).catch(() => undefined);
    return { ok: true, request };
  } catch (err) {
    return changeFailure(err);
  }
}

/** Apply an approved change exactly once, inside its execution window. */
export async function applyGovernancePolicyChange(
  req: { requestId: string; expectedPayloadHash?: string },
  actor: string,
  deps?: Partial<GovernancePolicyControlDeps>,
): Promise<GovernancePolicyApplyResult> {
  const d = resolveDeps(deps);
  try {
    const { request, result } = await d.executeAction(
      { requestId: req.requestId, executor: actor, expectedPayloadHash: req.expectedPayloadHash, now: d.now() },
      (tx, prepared) => applyPreparedLayer(tx, prepared, actor),
    );
    d.invalidateCache();
    await d.notify(GOVERNANCE_POLICY_SYNC_QUERY).catch(() => undefined);
    return { ok: true, request, layer: { layerId: result.layerId, version: result.version }, revision: result.revision };
  } catch (err) {
    return changeFailure(err);
  }
}

/** The effect of an approved governance change, inside the execution transaction. */
async function applyPreparedLayer(
  tx: Sql,
  request: SensitiveActionRequest,
  actor: string,
): Promise<{ layerId: string; version: number; revision: string }> {
  if (request.actionKind !== GOVERNANCE_POLICY_CHANGE_ACTION) {
    throw new SensitiveActionError('invalid', `request ${request.requestId} is a ${request.actionKind}, not a governance policy change`);
  }
  const payload = request.payload as ProposedLayer & { reason: string };
  const current = await loadLayer(payload.layerId, tx);
  const currentVersion = current?.version ?? 0;
  if (currentVersion !== request.baseVersion) {
    throw new SensitiveActionError(
      'stale',
      `layer ${payload.layerId} moved from v${request.baseVersion} to v${currentVersion} after the simulation; simulate and prepare again`,
    );
  }
  const load = await loadChainForWorkspace(request.workspaceId, tx);
  if (chainRevision(load.status === 'none' ? [] : load.chain) !== request.chainRevision) {
    throw new SensitiveActionError('stale', `the policy chain for ${request.workspaceId} changed after the simulation; simulate and prepare again`);
  }
  const approvers = request.approvals.filter((a) => a.decision === 'approve').map((a) => a.approver);
  const layer = await upsertLayerInTx(tx, {
    layerId: payload.layerId,
    level: payload.level,
    scopeRef: payload.scopeRef,
    parentLayerId: payload.parentLayerId,
    rules: payload.rules,
    exceptions: payload.exceptions ?? [],
    actor: request.preparedBy,
    reason: `${request.reason} [sensitive action ${request.requestId}; approved by ${approvers.join(', ')}; applied by ${actor}]`,
    expectedVersion: request.baseVersion,
  });
  return { layerId: layer.layerId, version: layer.version, revision: `${layer.layerId}@v${layer.version}` };
}

/** Grant delegated authority over a layer subtree (the actor must hold delegate there). */
export async function delegateGovernanceAuthority(
  req: { principal: string; layerId: string; capabilities: string[]; reason: string; expiresAt: string },
  actor: string,
  deps?: Partial<GovernancePolicyControlDeps>,
): Promise<GovernanceDelegationResult> {
  const d = resolveDeps(deps);
  try {
    const delegation = await grantDelegation({ grantor: actor, ...req, now: d.now() });
    await d.notify(GOVERNANCE_POLICY_SYNC_QUERY).catch(() => undefined);
    return { ok: true, delegation };
  } catch (err) {
    return changeFailure(err);
  }
}

/** Revoke a delegation (its holder, or anyone with delegate over its layer). */
export async function revokeGovernanceAuthority(
  req: { delegationId: string; reason: string },
  actor: string,
  deps?: Partial<GovernancePolicyControlDeps>,
): Promise<GovernanceDelegationResult> {
  const d = resolveDeps(deps);
  try {
    const delegation = await revokeDelegation({ delegationId: req.delegationId, revoker: actor, reason: req.reason, now: d.now() });
    await d.notify(GOVERNANCE_POLICY_SYNC_QUERY).catch(() => undefined);
    return { ok: true, delegation };
  } catch (err) {
    return changeFailure(err);
  }
}

/** Delegations and sensitive change requests, for the admin pane and the tool's read op. */
export async function readGovernanceAuthority(req: {
  workspaceId?: string;
  layerIds?: string[];
  status?: 'open' | 'all';
}): Promise<{ delegations: GovernanceDelegation[]; requests: SensitiveActionRequest[] }> {
  const [delegations, requests] = await Promise.all([
    listDelegations({ layerIds: req.layerIds }),
    listSensitiveActions({ workspaceId: req.workspaceId, actionKind: GOVERNANCE_POLICY_CHANGE_ACTION, status: req.status ?? 'open' }),
  ]);
  return { delegations, requests };
}
