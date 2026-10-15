/**
 * Postgres store for inherited governance policy layers
 * (papercusp-enterprise-readiness-roadmap-2026-10-09 P-005, migration 1497).
 *
 * A workspace is GOVERNED once it has a level='workspace' layer (scope_ref = the
 * workspace id). Its evaluation chain is the walk from that layer up its
 * parent_layer_id links to the organization root, returned ROOT FIRST.
 *
 * Every write bumps the layer's version and appends the full content, its hash,
 * the actor and a mandatory reason to governance_policy_layer_versions in the
 * SAME transaction — the version table is the policy's change evidence.
 *
 * The evaluator (./inherited-policy.ts) is pure; this file only reads and writes rows.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { workScopeExceptionExpirySchema } from '../work-scope-policy';
import { CUSTOMER_DATA_CLASSES, DATA_CLASS_USE_PREFIX, dataClassUseLabel, isCustomerDataClass } from '../auth/hosted/customer-data-map';
import {
  GOVERNED_CATEGORIES,
  POLICY_LEVELS,
  isWellFormedLayer,
  type CategoryRule,
  type GovernedCategory,
  type PolicyException,
  type PolicyLayer,
  type PolicyLevel,
} from './inherited-policy';

/** Deepest chain walked. organization → departments → workspace never needs more. */
export const MAX_CHAIN_DEPTH = 8;

export interface StoredPolicyLayer extends PolicyLayer {
  scopeRef: string;
  parentLayerId: string | null;
  contentHash: string;
  updatedBy: string;
  updatedAt: string;
}

export type ChainLoad =
  /** The workspace has no workspace layer: no inherited policy governs it. */
  | { status: 'none' }
  | { status: 'ok'; chain: StoredPolicyLayer[] }
  /** The rows exist but do not form a valid organization-rooted chain. Callers refuse. */
  | { status: 'malformed'; reason: string; chain: StoredPolicyLayer[] };

interface RawLayerRow {
  layer_id: string;
  level: string;
  scope_ref: string;
  parent_layer_id: string | null;
  version: number;
  rules: unknown;
  exceptions: unknown;
  content_hash: string;
  updated_by: string;
  updated_at: Date | string;
}

function sqlOf(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

function layerOf(row: RawLayerRow): StoredPolicyLayer {
  return {
    layerId: row.layer_id,
    level: row.level as PolicyLevel,
    version: Number(row.version),
    rules: (row.rules ?? {}) as PolicyLayer['rules'],
    exceptions: (Array.isArray(row.exceptions) ? row.exceptions : []) as PolicyException[],
    scopeRef: row.scope_ref,
    parentLayerId: row.parent_layer_id,
    contentHash: row.content_hash,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

const LAYER_COLUMNS = 'layer_id, level, scope_ref, parent_layer_id, version, rules, exceptions, content_hash, updated_by, updated_at';

/**
 * Structural check of a loaded chain (root first). Pure, exported for tests.
 * Shape required: organization root (no parent) → zero or more departments → the workspace leaf,
 * each layer's parent being the previous one.
 */
export function chainShapeProblem(chain: readonly StoredPolicyLayer[]): string | null {
  if (chain.length === 0) return 'empty chain';
  const root = chain[0];
  if (root.level !== 'organization' || root.parentLayerId !== null) {
    return `chain does not reach an organization root within ${MAX_CHAIN_DEPTH} layers (cycle or dangling parent at ${root.layerId})`;
  }
  const leaf = chain[chain.length - 1];
  if (leaf.level !== 'workspace') return `chain leaf ${leaf.layerId} is ${leaf.level}, not workspace`;
  for (let i = 1; i < chain.length; i += 1) {
    if (chain[i].parentLayerId !== chain[i - 1].layerId) return `layer ${chain[i].layerId} is not a child of ${chain[i - 1].layerId}`;
    if (i < chain.length - 1 && chain[i].level !== 'department') {
      return `intermediate layer ${chain[i].layerId} is ${chain[i].level}; only departments sit between organization and workspace`;
    }
  }
  return null;
}

/** The evaluation chain governing `workspaceId`, root first. */
export async function loadChainForWorkspace(workspaceId: string, sql?: Sql): Promise<ChainLoad> {
  const db = sqlOf(sql);
  const rows = await db<Array<RawLayerRow & { depth: number }>>`
    WITH RECURSIVE chain AS (
      SELECT l.layer_id, l.level, l.scope_ref, l.parent_layer_id, l.version, l.rules, l.exceptions,
             l.content_hash, l.updated_by, l.updated_at, 1 AS depth, ARRAY[l.layer_id] AS path
        FROM harness_shared.governance_policy_layers l
       WHERE l.level = 'workspace' AND l.scope_ref = ${workspaceId}
      UNION ALL
      SELECT p.layer_id, p.level, p.scope_ref, p.parent_layer_id, p.version, p.rules, p.exceptions,
             p.content_hash, p.updated_by, p.updated_at, c.depth + 1, c.path || p.layer_id
        FROM chain c
        JOIN harness_shared.governance_policy_layers p ON p.layer_id = c.parent_layer_id
       WHERE c.depth < ${MAX_CHAIN_DEPTH} AND NOT (p.layer_id = ANY (c.path))
    )
    SELECT ${db.unsafe(LAYER_COLUMNS)}, depth FROM chain ORDER BY depth DESC
  `;
  if (rows.length === 0) return { status: 'none' };
  const chain = rows.map(layerOf);
  const problem = chainShapeProblem(chain);
  if (problem) return { status: 'malformed', reason: problem, chain };
  // `: boolean` stops TS 5.5 inferring `l is never` from the negated type guard, which would
  // type `bad` as never and hide the layerId/version it is about to report.
  const bad = chain.find((l): boolean => !isWellFormedLayer(l));
  if (bad) return { status: 'malformed', reason: `layer ${bad.layerId} v${bad.version} has malformed rules or exceptions`, chain };
  return { status: 'ok', chain };
}

export async function loadLayer(layerId: string, sql?: Sql): Promise<StoredPolicyLayer | null> {
  const db = sqlOf(sql);
  const rows = await db<RawLayerRow[]>`
    SELECT ${db.unsafe(LAYER_COLUMNS)} FROM harness_shared.governance_policy_layers WHERE layer_id = ${layerId}
  `;
  return rows[0] ? layerOf(rows[0]) : null;
}

export async function listLayers(sql?: Sql): Promise<StoredPolicyLayer[]> {
  const db = sqlOf(sql);
  const rows = await db<RawLayerRow[]>`
    SELECT ${db.unsafe(LAYER_COLUMNS)} FROM harness_shared.governance_policy_layers
     ORDER BY CASE level WHEN 'organization' THEN 0 WHEN 'department' THEN 1 ELSE 2 END, layer_id
  `;
  return rows.map(layerOf);
}

export interface PolicyLayerVersion {
  layerId: string;
  version: number;
  level: PolicyLevel;
  scopeRef: string;
  parentLayerId: string | null;
  rules: PolicyLayer['rules'];
  exceptions: PolicyException[];
  contentHash: string;
  actor: string;
  reason: string;
  recordedAt: string;
}

export async function listVersions(layerId: string, limit = 50, sql?: Sql): Promise<PolicyLayerVersion[]> {
  const db = sqlOf(sql);
  const rows = await db<Array<Record<string, unknown>>>`
    SELECT layer_id, version, level, scope_ref, parent_layer_id, rules, exceptions, content_hash, actor, reason, recorded_at
      FROM harness_shared.governance_policy_layer_versions
     WHERE layer_id = ${layerId}
     ORDER BY version DESC
     LIMIT ${Math.max(1, Math.min(500, Math.trunc(limit)))}
  `;
  return rows.map((r) => ({
    layerId: String(r.layer_id),
    version: Number(r.version),
    level: r.level as PolicyLevel,
    scopeRef: String(r.scope_ref),
    parentLayerId: (r.parent_layer_id as string | null) ?? null,
    rules: (r.rules ?? {}) as PolicyLayer['rules'],
    exceptions: (Array.isArray(r.exceptions) ? r.exceptions : []) as PolicyException[],
    contentHash: String(r.content_hash),
    actor: String(r.actor),
    reason: String(r.reason),
    recordedAt: r.recorded_at instanceof Date ? r.recorded_at.toISOString() : String(r.recorded_at),
  }));
}

/** Deterministic JSON (sorted object keys) so the content hash is stable across writers. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function policyContentHash(content: {
  level: PolicyLevel;
  scopeRef: string;
  parentLayerId: string | null;
  rules: PolicyLayer['rules'];
  exceptions: readonly PolicyException[];
}): string {
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

export class GovernancePolicyWriteError extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'parent', message: string) {
    super(message);
    this.name = 'GovernancePolicyWriteError';
  }
}

export interface UpsertLayerInput {
  layerId: string;
  level: PolicyLevel;
  scopeRef: string;
  parentLayerId: string | null;
  rules: Partial<Record<GovernedCategory, CategoryRule>>;
  exceptions?: PolicyException[];
  actor: string;
  reason: string;
  /** Optimistic concurrency: refuse when the stored version differs (0 = must not exist yet). */
  expectedVersion?: number;
}

/** Write-time validation. Everything the evaluator would treat as malformed is refused here first. */
export function validateLayerInput(input: UpsertLayerInput): string | null {
  if (typeof input.layerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(input.layerId)) {
    return 'layerId must be 1-128 chars of [A-Za-z0-9:._-]';
  }
  if (!POLICY_LEVELS.includes(input.level)) return `level must be one of ${POLICY_LEVELS.join(', ')}`;
  if (typeof input.scopeRef !== 'string' || !input.scopeRef.trim()) return 'scopeRef is required';
  if ((input.level === 'organization') !== (input.parentLayerId === null)) {
    return 'an organization layer has no parent; every other layer must name one';
  }
  if (input.parentLayerId === input.layerId) return 'a layer cannot be its own parent';
  if (typeof input.actor !== 'string' || !input.actor.trim()) return 'actor is required';
  if (typeof input.reason !== 'string' || !input.reason.trim()) return 'reason is required (it is the change evidence)';
  const candidate = { layerId: input.layerId, level: input.level, version: 1, rules: input.rules, exceptions: input.exceptions ?? [] };
  if (!isWellFormedLayer(candidate)) {
    return `rules must map only ${GOVERNED_CATEGORIES.join('/')} to { allow?: string[], deny?: string[] }`;
  }
  const dataUseRule = input.rules?.dataUse;
  for (const side of ['allow', 'deny'] as const) {
    for (const value of dataUseRule?.[side] ?? []) {
      const problem = unknownDataClassLabel(value);
      if (problem) return `rules.dataUse.${side}: ${problem}`;
    }
  }
  for (const [i, e] of (input.exceptions ?? []).entries()) {
    if (!GOVERNED_CATEGORIES.includes(e?.category)) return `exceptions[${i}].category is not a governed category`;
    if (typeof e.pattern !== 'string' || !e.pattern.trim()) return `exceptions[${i}].pattern is required`;
    if (typeof e.reason !== 'string' || !e.reason.trim()) return `exceptions[${i}].reason is required`;
    if (!workScopeExceptionExpirySchema.safeParse(e.expiresAt).success) {
      return `exceptions[${i}].expiresAt must be an absolute ISO-8601 time; exceptions always expire`;
    }
    if (e.category === 'dataUse') {
      const problem = unknownDataClassLabel(e.pattern);
      if (problem) return `exceptions[${i}].pattern: ${problem}`;
    }
  }
  return null;
}

/**
 * A `class:<cls>` dataUse value must name a customer data class (P-016a DLP), so a typo such as
 * `class:pll` cannot silently govern nothing. A wildcard pattern (`class:*`) is a deliberate
 * family match and is left to the evaluator. Returns the refusal text, else null.
 */
export function unknownDataClassLabel(value: string): string | null {
  if (typeof value !== 'string' || !value.startsWith(DATA_CLASS_USE_PREFIX) || value.includes('*')) return null;
  const cls = value.slice(DATA_CLASS_USE_PREFIX.length);
  if (isCustomerDataClass(cls)) return null;
  return `'${value}' names no customer data class; use one of ${CUSTOMER_DATA_CLASSES.map(dataClassUseLabel).join(', ')}`;
}

/** Create or replace one layer, bumping its version and recording the change, atomically. */
export async function upsertLayer(input: UpsertLayerInput, sql?: Sql): Promise<StoredPolicyLayer> {
  const problem = validateLayerInput(input);
  if (problem) throw new GovernancePolicyWriteError('invalid', problem);
  return (await sqlOf(sql).begin((tx) => upsertLayerInTx(tx as unknown as Sql, input))) as StoredPolicyLayer;
}

/**
 * The upsert body inside the CALLER's transaction, so a sensitive action (P-006, D-015) commits
 * the layer write and its one-time execution mark atomically. Validates again: it is a public seam.
 */
export async function upsertLayerInTx(tx: Sql, input: UpsertLayerInput): Promise<StoredPolicyLayer> {
  const problem = validateLayerInput(input);
  if (problem) throw new GovernancePolicyWriteError('invalid', problem);
  const exceptions = input.exceptions ?? [];
  {
    const current = await tx<Array<{ version: number }>>`
      SELECT version FROM harness_shared.governance_policy_layers WHERE layer_id = ${input.layerId} FOR UPDATE
    `;
    const currentVersion = current[0] ? Number(current[0].version) : 0;
    if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
      throw new GovernancePolicyWriteError('conflict', `layer ${input.layerId} is at v${currentVersion}, not v${input.expectedVersion}`);
    }
    if (input.parentLayerId) {
      // The parent must exist, sit above this level, and not descend from this layer (no cycles).
      const ancestors = await tx<Array<{ layer_id: string; level: string }>>`
        WITH RECURSIVE up AS (
          SELECT layer_id, level, parent_layer_id, 1 AS depth
            FROM harness_shared.governance_policy_layers WHERE layer_id = ${input.parentLayerId}
          UNION ALL
          SELECT p.layer_id, p.level, p.parent_layer_id, u.depth + 1
            FROM up u JOIN harness_shared.governance_policy_layers p ON p.layer_id = u.parent_layer_id
           WHERE u.depth < ${MAX_CHAIN_DEPTH}
        )
        SELECT layer_id, level FROM up
      `;
      if (ancestors.length === 0) throw new GovernancePolicyWriteError('parent', `parent layer ${input.parentLayerId} does not exist`);
      const parentLevel = ancestors[0].level;
      if (parentLevel === 'workspace') throw new GovernancePolicyWriteError('parent', 'a workspace layer cannot be a parent');
      if (input.level === 'department' && parentLevel !== 'organization' && parentLevel !== 'department') {
        throw new GovernancePolicyWriteError('parent', 'a department must sit under an organization or department');
      }
      if (ancestors.some((a) => a.layer_id === input.layerId)) {
        throw new GovernancePolicyWriteError('parent', `parent ${input.parentLayerId} descends from ${input.layerId}; that would be a cycle`);
      }
    }
    const version = currentVersion + 1;
    const contentHash = policyContentHash({
      level: input.level,
      scopeRef: input.scopeRef,
      parentLayerId: input.parentLayerId,
      rules: input.rules,
      exceptions,
    });
    // jsonb binds as JSON.stringify + ::text::jsonb: the only form correct on BOTH the getOrgPg
    // client and a default postgres() pool (a bare ::jsonb double-encodes on the latter, storing a
    // jsonb string that every later load reports malformed). agent-insights/postgres-js-jsonb-binding.
    const rows = await tx<RawLayerRow[]>`
      INSERT INTO harness_shared.governance_policy_layers
        (layer_id, level, scope_ref, parent_layer_id, version, rules, exceptions, content_hash, updated_by, updated_at)
      VALUES (${input.layerId}, ${input.level}, ${input.scopeRef}, ${input.parentLayerId}, ${version},
              ${JSON.stringify(input.rules)}::text::jsonb, ${JSON.stringify(exceptions)}::text::jsonb, ${contentHash}, ${input.actor}, now())
      ON CONFLICT (layer_id) DO UPDATE SET
        level = EXCLUDED.level, scope_ref = EXCLUDED.scope_ref, parent_layer_id = EXCLUDED.parent_layer_id,
        version = EXCLUDED.version, rules = EXCLUDED.rules, exceptions = EXCLUDED.exceptions,
        content_hash = EXCLUDED.content_hash, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
      RETURNING ${tx.unsafe(LAYER_COLUMNS)}
    `;
    await tx`
      INSERT INTO harness_shared.governance_policy_layer_versions
        (layer_id, version, level, scope_ref, parent_layer_id, rules, exceptions, content_hash, actor, reason)
      VALUES (${input.layerId}, ${version}, ${input.level}, ${input.scopeRef}, ${input.parentLayerId},
              ${JSON.stringify(input.rules)}::text::jsonb, ${JSON.stringify(exceptions)}::text::jsonb, ${contentHash}, ${input.actor}, ${input.reason})
    `;
    return layerOf(rows[0] as RawLayerRow);
  }
}
