/**
 * DAO HR equity + hiring policy settings (dao-hr-people-2026-10-11 P-003; R-2, D-001, D-004, D-013).
 *
 * One org-level policy per DAO, saved as append-only versions (migration 1460):
 *   - every save inserts version N+1 and one audit row naming the acting admin, so earlier
 *     versions stay readable and no change rewrites the terms something was issued under;
 *   - values are validated against the immutable maxima of the V2 equity contract
 *     (PapercuspEquityV2: 10%/yr return ceiling, 30–365 day payout interval, 3650-day grants,
 *     and the deployment's own maxGrantLimit when the caller supplies it);
 *   - per-offer overrides are validated against the policy's offer bounds;
 *   - a change to a chain-enforced value (per-grant limit, return rate, payout cadence) is carried
 *     on chain by ADMIN-class contract calls only (D-013), never by a governance proposal (D-004).
 *
 * There is deliberately no setting that controls who can see equity or pay terms: D-001 makes
 * everyone's equity visible to everyone, so visibility is not a policy knob (SPEC-P-003-D).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { PERSON_DATATYPE, getCanonicalEntity } from '../relationship-graph/resolver';
import { EQUITY_V2_FUNCTION_CLASSES, type EquityV2FunctionName } from '../equity/v2-function-classes';
import { prepareEquityTransaction, type UnsignedEquityTransaction } from '../equity/runtime';
import { isDaoHrAdmin, type DaoKey } from './contract-templates';

export const DAY_SECONDS = 86_400;

/** Immutable maxima of PapercuspEquityV2 (pinned to the contract constants by equity-policy.integration.test.ts). */
export const EQUITY_V2_CEILINGS = Object.freeze({
  annualReturnCapBps: 1000,
  minReturnIntervalDays: 30,
  maxReturnIntervalDays: 365,
  maxGrantDurationDays: 3650,
});

export const START_RULES = ['start_date', 'contract_signed', 'hire_passed'] as const;
export type StartRule = (typeof START_RULES)[number];

export interface DefaultGrant {
  role: string;
  level: string;
  shares: number;
}

export interface OfferBounds {
  sharesMin: number;
  sharesMax: number;
  vestingDaysMin: number;
  vestingDaysMax: number;
  cliffDaysMin: number;
  cliffDaysMax: number;
}

export interface EquityPolicySettings {
  /** Default equity grant per role and level. */
  defaultGrants: DefaultGrant[];
  /** Vesting length for new grants, in days. */
  vestingDays: number;
  /** Cliff for new grants, in days (never longer than the vesting length). */
  cliffDays: number;
  /** What starts vesting for a new grant. */
  startRule: StartRule;
  /** Chain-enforced: prospective per-grant limit (setGrantLimit). Existing grants are untouched. */
  perGrantLimitShares: number;
  /** Chain-enforced: payout rate per year in basis points (setReturnPolicy). */
  returnRateBps: number;
  /** Chain-enforced: days between payouts (setReturnPolicy). */
  returnIntervalDays: number;
  /** How far a single offer may depart from the defaults. */
  offerBounds: OfferBounds;
  /** Hiring: admins (other than the offer's author) who must approve an offer (D-007). */
  offerApprovalsRequired: number;
}

/** The complete, closed set of policy fields. Anything else is refused (`unknown_field`). */
export const POLICY_SETTING_KEYS = Object.freeze([
  'defaultGrants',
  'vestingDays',
  'cliffDays',
  'startRule',
  'perGrantLimitShares',
  'returnRateBps',
  'returnIntervalDays',
  'offerBounds',
  'offerApprovalsRequired',
] as const satisfies readonly (keyof EquityPolicySettings)[]);

const OFFER_BOUND_KEYS = Object.freeze([
  'sharesMin',
  'sharesMax',
  'vestingDaysMin',
  'vestingDaysMax',
  'cliffDaysMin',
  'cliffDaysMax',
] as const satisfies readonly (keyof OfferBounds)[]);

/** Fields whose value the V2 contract enforces; changing one produces admin-class calls. */
export const CHAIN_ENFORCED_KEYS = Object.freeze(['perGrantLimitShares', 'returnRateBps', 'returnIntervalDays'] as const);

/** The policy in force before an admin saves the first version. */
export const DEFAULT_EQUITY_POLICY: Readonly<EquityPolicySettings> = Object.freeze({
  defaultGrants: [],
  vestingDays: 1460,
  cliffDays: 365,
  startRule: 'start_date',
  perGrantLimitShares: 10_000,
  returnRateBps: 0,
  returnIntervalDays: 90,
  offerBounds: {
    sharesMin: 0,
    sharesMax: 10_000,
    vestingDaysMin: 365,
    vestingDaysMax: 1460,
    cliffDaysMin: 0,
    cliffDaysMax: 365,
  },
  offerApprovalsRequired: 1,
});

export type EquityPolicyErrorCode =
  | 'invalid_input'
  | 'invalid_settings'
  | 'unknown_field'
  | 'above_immutable_max'
  | 'override_out_of_bounds'
  | 'not_admin'
  | 'no_change'
  | 'no_such_version';

export class EquityPolicyError extends Error {
  readonly code: EquityPolicyErrorCode;
  constructor(code: EquityPolicyErrorCode, message: string) {
    super(message);
    this.name = 'EquityPolicyError';
    this.code = code;
  }
}

function fail(code: EquityPolicyErrorCode, message: string): never {
  throw new EquityPolicyError(code, message);
}

function text(name: string, value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    fail('invalid_input', `${name} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

function int(name: string, value: unknown, min: number, max: number, code: EquityPolicyErrorCode = 'invalid_settings'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail('invalid_settings', `${name} must be an integer`);
  if (value < min) fail('invalid_settings', `${name} must be at least ${min}`);
  if (value > max) fail(code, `${name} is ${value}, above its maximum of ${max}`);
  return value;
}

function record(name: string, value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid_settings', `${name} must be an object`);
  return value as Record<string, unknown>;
}

function closedKeys(name: string, value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('unknown_field', `${name} has no field "${key}"`);
  }
}

/** Immutable maxima for one deployment; `maxGrantLimit` is the contract's own immutable cap when known. */
export interface ChainMaxima {
  maxGrantLimit?: number | bigint;
}

/**
 * Validate a complete policy document. Refuses unknown fields, out-of-range values, values above
 * the V2 contract's immutable maxima (`above_immutable_max`) and inconsistent bounds.
 */
export function validatePolicySettings(input: unknown, maxima: ChainMaxima = {}): EquityPolicySettings {
  const raw = record('policy settings', input);
  closedKeys('policy settings', raw, POLICY_SETTING_KEYS);
  for (const key of POLICY_SETTING_KEYS) {
    if (!(key in raw)) fail('invalid_settings', `policy settings are missing "${key}"`);
  }
  const maxDays = EQUITY_V2_CEILINGS.maxGrantDurationDays;
  const grantCap = maxima.maxGrantLimit === undefined ? Number.MAX_SAFE_INTEGER : Number(maxima.maxGrantLimit);

  const vestingDays = int('vestingDays', raw.vestingDays, 1, maxDays, 'above_immutable_max');
  const cliffDays = int('cliffDays', raw.cliffDays, 0, maxDays, 'above_immutable_max');
  if (cliffDays > vestingDays) fail('invalid_settings', 'cliffDays cannot exceed vestingDays');
  if (typeof raw.startRule !== 'string' || !(START_RULES as readonly string[]).includes(raw.startRule)) {
    fail('invalid_settings', `startRule must be one of ${START_RULES.join(', ')}`);
  }
  const perGrantLimitShares = int('perGrantLimitShares', raw.perGrantLimitShares, 0, grantCap, 'above_immutable_max');
  const returnRateBps = int('returnRateBps', raw.returnRateBps, 0, EQUITY_V2_CEILINGS.annualReturnCapBps, 'above_immutable_max');
  if (typeof raw.returnIntervalDays === 'number' && raw.returnIntervalDays < EQUITY_V2_CEILINGS.minReturnIntervalDays) {
    fail('above_immutable_max', `returnIntervalDays is ${raw.returnIntervalDays}, below the immutable minimum of ${EQUITY_V2_CEILINGS.minReturnIntervalDays}`);
  }
  const returnIntervalDays = int(
    'returnIntervalDays',
    raw.returnIntervalDays,
    EQUITY_V2_CEILINGS.minReturnIntervalDays,
    EQUITY_V2_CEILINGS.maxReturnIntervalDays,
    'above_immutable_max',
  );

  const b = record('offerBounds', raw.offerBounds);
  closedKeys('offerBounds', b, OFFER_BOUND_KEYS);
  const offerBounds: OfferBounds = {
    sharesMin: int('offerBounds.sharesMin', b.sharesMin, 0, perGrantLimitShares),
    sharesMax: int('offerBounds.sharesMax', b.sharesMax, 0, perGrantLimitShares, 'above_immutable_max'),
    vestingDaysMin: int('offerBounds.vestingDaysMin', b.vestingDaysMin, 1, maxDays),
    vestingDaysMax: int('offerBounds.vestingDaysMax', b.vestingDaysMax, 1, maxDays, 'above_immutable_max'),
    cliffDaysMin: int('offerBounds.cliffDaysMin', b.cliffDaysMin, 0, maxDays),
    cliffDaysMax: int('offerBounds.cliffDaysMax', b.cliffDaysMax, 0, maxDays, 'above_immutable_max'),
  };
  if (offerBounds.sharesMin > offerBounds.sharesMax) fail('invalid_settings', 'offerBounds.sharesMin exceeds sharesMax');
  if (offerBounds.vestingDaysMin > offerBounds.vestingDaysMax) fail('invalid_settings', 'offerBounds.vestingDaysMin exceeds vestingDaysMax');
  if (offerBounds.cliffDaysMin > offerBounds.cliffDaysMax) fail('invalid_settings', 'offerBounds.cliffDaysMin exceeds cliffDaysMax');
  if (vestingDays < offerBounds.vestingDaysMin || vestingDays > offerBounds.vestingDaysMax) {
    fail('invalid_settings', 'vestingDays must lie within offerBounds');
  }
  if (cliffDays < offerBounds.cliffDaysMin || cliffDays > offerBounds.cliffDaysMax) {
    fail('invalid_settings', 'cliffDays must lie within offerBounds');
  }

  if (!Array.isArray(raw.defaultGrants) || raw.defaultGrants.length > 200) {
    fail('invalid_settings', 'defaultGrants must be an array of at most 200 entries');
  }
  const seen = new Set<string>();
  const defaultGrants = raw.defaultGrants.map((entry, i): DefaultGrant => {
    const g = record(`defaultGrants[${i}]`, entry);
    closedKeys(`defaultGrants[${i}]`, g, ['role', 'level', 'shares']);
    const role = text(`defaultGrants[${i}].role`, g.role, 120);
    const level = text(`defaultGrants[${i}].level`, g.level, 60);
    const shares = int(`defaultGrants[${i}].shares`, g.shares, offerBounds.sharesMin, offerBounds.sharesMax, 'override_out_of_bounds');
    const key = `${role.toLowerCase()}\u0000${level.toLowerCase()}`;
    if (seen.has(key)) fail('invalid_settings', `defaultGrants lists ${role}/${level} twice`);
    seen.add(key);
    return { role, level, shares };
  });

  const offerApprovalsRequired = int('offerApprovalsRequired', raw.offerApprovalsRequired, 1, 10);
  return {
    defaultGrants,
    vestingDays,
    cliffDays,
    startRule: raw.startRule as StartRule,
    perGrantLimitShares,
    returnRateBps,
    returnIntervalDays,
    offerBounds,
    offerApprovalsRequired,
  };
}

/** Key-order-independent JSON: a document read back from jsonb has its object keys reordered. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Policy fields whose values differ between two documents, in POLICY_SETTING_KEYS order. */
export function changedPolicyFields(prev: EquityPolicySettings, next: EquityPolicySettings): string[] {
  return POLICY_SETTING_KEYS.filter(k => canonicalJson(prev[k]) !== canonicalJson(next[k]));
}

/** One admin-class V2 contract call that carries a chain-enforced policy value on chain. */
export interface EquityPolicyChainCall {
  functionName: EquityV2FunctionName;
  args: string[];
}

/**
 * The contract calls a policy change needs. Every call is an ADMIN-class V2 function (D-013), so a
 * chain-enforced policy change executes without a governance proposal (D-004). Throws if a call
 * would ever route through a non-admin function.
 */
export function planChainPolicyCalls(prev: EquityPolicySettings, next: EquityPolicySettings): EquityPolicyChainCall[] {
  const calls: EquityPolicyChainCall[] = [];
  if (prev.perGrantLimitShares !== next.perGrantLimitShares) {
    calls.push({ functionName: 'setGrantLimit', args: [String(next.perGrantLimitShares)] });
  }
  if (prev.returnRateBps !== next.returnRateBps || prev.returnIntervalDays !== next.returnIntervalDays) {
    calls.push({ functionName: 'setReturnPolicy', args: [String(next.returnRateBps), String(next.returnIntervalDays * DAY_SECONDS)] });
  }
  for (const call of calls) {
    if (EQUITY_V2_FUNCTION_CLASSES[call.functionName].class !== 'admin') {
      throw new Error(`policy call ${call.functionName} is not an admin-class function`);
    }
  }
  return calls;
}

/** Unsigned transactions for the DAO admin's wallet: one per planned call, sent straight to the equity contract. */
export function prepareChainPolicyTransactions(input: {
  chainId: number;
  adminAddress: string;
  equityAddress: string;
  calls: readonly EquityPolicyChainCall[];
}): UnsignedEquityTransaction[] {
  return input.calls.map(call =>
    prepareEquityTransaction({
      chainId: input.chainId,
      from: input.adminAddress,
      contract: 'PapercuspEquityV2',
      to: input.equityAddress,
      functionName: call.functionName,
      args: call.args,
    }),
  );
}

export interface OfferOverrides {
  shares?: number;
  vestingDays?: number;
  cliffDays?: number;
}

export interface OfferEquityTerms {
  shares: number;
  vestingDays: number;
  cliffDays: number;
  startRule: StartRule;
  policyVersion: number | null;
}

/**
 * Effective equity terms for one offer: the role/level default (or the offer's shares) and the
 * policy's vesting, each override checked against the policy's offer bounds.
 */
export function resolveOfferTermsFrom(
  policy: EquityPolicySettings,
  policyVersion: number | null,
  input: { role: string; level: string; overrides?: unknown; amendmentBase?: OfferEquityTerms },
): OfferEquityTerms {
  const role = text('role', input.role, 120);
  const level = text('level', input.level, 60);
  const overrides = input.overrides === undefined ? {} : record('overrides', input.overrides);
  closedKeys('overrides', overrides, ['shares', 'vestingDays', 'cliffDays']);
  const b = policy.offerBounds;
  const within = (name: string, value: unknown, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail('invalid_input', `${name} must be an integer`);
    if (value < min || value > max) fail('override_out_of_bounds', `${name} ${value} is outside the policy bounds ${min}–${max}`);
    return value;
  };
  const fallback = policy.defaultGrants.find(g => g.role.toLowerCase() === role.toLowerCase() && g.level.toLowerCase() === level.toLowerCase());
  const base = input.amendmentBase;
  // Prospective hiring defaults do not rewrite an existing signed engagement.
  // Only a changed share amount is subject to today's offer bounds.
  const shares = overrides.shares === undefined ? base?.shares ?? fallback?.shares :
    base && overrides.shares === base.shares ? base.shares : within('shares', overrides.shares, b.sharesMin, b.sharesMax);
  if (shares === undefined) fail('invalid_input', `no default grant for ${role}/${level}; the offer must set shares`);
  if (base) {
    if ((overrides.vestingDays !== undefined && overrides.vestingDays !== base.vestingDays) ||
      (overrides.cliffDays !== undefined && overrides.cliffDays !== base.cliffDays))
      fail('invalid_input', 'An amendment preserves the signed vesting schedule.');
    return { ...base, shares, policyVersion };
  }
  const vestingDays = overrides.vestingDays === undefined ? policy.vestingDays : within('vestingDays', overrides.vestingDays, b.vestingDaysMin, b.vestingDaysMax);
  const cliffDays = overrides.cliffDays === undefined ? policy.cliffDays : within('cliffDays', overrides.cliffDays, b.cliffDaysMin, b.cliffDaysMax);
  if (cliffDays > vestingDays) fail('override_out_of_bounds', 'the cliff cannot be longer than the vesting length');
  return { shares, vestingDays, cliffDays, startRule: policy.startRule, policyVersion };
}

// ── Persistence ───────────────────────────────────────────────────────────────────────────────

export interface EquityPolicyDeps {
  sql?: Sql;
}

function db(deps: EquityPolicyDeps): Sql {
  return deps.sql ?? getOrgPg().sql;
}

function validDao(key: DaoKey): DaoKey {
  return { workspaceId: text('workspaceId', key.workspaceId, 200), daoSlug: text('daoSlug', key.daoSlug, 200) };
}

export interface EquityPolicyVersion {
  version: number;
  settings: EquityPolicySettings;
  createdBy: string;
  createdAt: Date;
}

interface VersionRow {
  version: number;
  settings: EquityPolicySettings;
  created_by: string;
  created_at: Date;
}

const toVersion = (r: VersionRow): EquityPolicyVersion => ({ version: r.version, settings: r.settings, createdBy: r.created_by, createdAt: r.created_at });

/** The latest saved policy version, or null while the DAO still runs on DEFAULT_EQUITY_POLICY. */
export async function getCurrentEquityPolicy(key: DaoKey, deps: EquityPolicyDeps = {}): Promise<EquityPolicyVersion | null> {
  const dao = validDao(key);
  const [row] = await db(deps)<VersionRow[]>`
    SELECT version, settings, created_by, created_at FROM harness_shared.dao_hr_policy_versions
     WHERE workspace_id = ${dao.workspaceId} AND dao_slug = ${dao.daoSlug}
     ORDER BY version DESC LIMIT 1`;
  return row ? toVersion(row) : null;
}

/** One saved version; refuses a version that was never saved. */
export async function getEquityPolicyVersion(key: DaoKey & { version: number }, deps: EquityPolicyDeps = {}): Promise<EquityPolicyVersion> {
  const dao = validDao(key);
  const [row] = await db(deps)<VersionRow[]>`
    SELECT version, settings, created_by, created_at FROM harness_shared.dao_hr_policy_versions
     WHERE workspace_id = ${dao.workspaceId} AND dao_slug = ${dao.daoSlug} AND version = ${key.version}`;
  if (!row) fail('no_such_version', `DAO ${dao.daoSlug} has no policy version ${key.version}`);
  return toVersion(row);
}

/** Every saved version, oldest first. */
export async function listEquityPolicyVersions(key: DaoKey, deps: EquityPolicyDeps = {}): Promise<EquityPolicyVersion[]> {
  const dao = validDao(key);
  const rows = await db(deps)<VersionRow[]>`
    SELECT version, settings, created_by, created_at FROM harness_shared.dao_hr_policy_versions
     WHERE workspace_id = ${dao.workspaceId} AND dao_slug = ${dao.daoSlug}
     ORDER BY version`;
  return rows.map(toVersion);
}

export interface EquityPolicyAuditEntry {
  id: number;
  version: number;
  actorPersonId: string;
  changedFields: string[];
  chainCalls: EquityPolicyChainCall[];
  /** NULL only for history written before audit snapshots were introduced. */
  beforeSettings: EquityPolicySettings | null;
  afterSettings: EquityPolicySettings | null;
  createdAt: Date;
}

/** The policy audit trail, oldest first. */
export async function listEquityPolicyAudit(key: DaoKey, deps: EquityPolicyDeps = {}): Promise<EquityPolicyAuditEntry[]> {
  const dao = validDao(key);
  const rows = await db(deps)<Array<{ id: string; version: number; actor_person_id: string; changed_fields: string[]; chain_calls: EquityPolicyChainCall[]; before_settings: EquityPolicySettings | null; after_settings: EquityPolicySettings | null; created_at: Date }>>`
    SELECT id, version, actor_person_id, changed_fields, chain_calls, before_settings, after_settings, created_at FROM harness_shared.dao_hr_policy_audit
     WHERE workspace_id = ${dao.workspaceId} AND dao_slug = ${dao.daoSlug}
     ORDER BY id`;
  return rows.map(r => ({
    id: Number(r.id),
    version: r.version,
    actorPersonId: r.actor_person_id,
    changedFields: r.changed_fields,
    chainCalls: r.chain_calls,
    beforeSettings: r.before_settings,
    afterSettings: r.after_settings,
    createdAt: r.created_at,
  }));
}

export interface UpdateEquityPolicyInput extends DaoKey {
  actorPersonId: string;
  /** Fields to change; unchanged fields carry over from the current version. */
  changes: Partial<Record<(typeof POLICY_SETTING_KEYS)[number], unknown>>;
  maxima?: ChainMaxima;
}

export interface UpdateEquityPolicyResult {
  version: number;
  settings: EquityPolicySettings;
  changedFields: string[];
  /** Admin-class contract calls to send from the DAO admin wallet; no governance proposal. */
  chainCalls: EquityPolicyChainCall[];
}

/**
 * Save a policy change as a new version (admin only, D-012 roster). Refuses a non-admin, unknown
 * fields, values above an immutable maximum and a change that changes nothing; on success writes
 * the new version and its audit row in one transaction and returns the admin calls that carry any
 * chain-enforced value on chain.
 */
export async function updateEquityPolicy(input: UpdateEquityPolicyInput, deps: EquityPolicyDeps = {}): Promise<UpdateEquityPolicyResult> {
  const sql = db(deps);
  const dao = validDao(input);
  const rawActor = text('actorPersonId', input.actorPersonId, 200);
  const person = await getCanonicalEntity(sql, dao.workspaceId, PERSON_DATATYPE, rawActor);
  if (!person || !(await isDaoHrAdmin({ ...dao, personId: person.id }, { sql }))) {
    fail('not_admin', `${rawActor} is not an HR admin of DAO ${dao.daoSlug}`);
  }
  const changes = record('changes', input.changes);
  closedKeys('policy settings', changes, POLICY_SETTING_KEYS);

  return await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`dao_hr_policy:${dao.workspaceId}:${dao.daoSlug}`}, 0))`;
    const [latest] = await tx<VersionRow[]>`
      SELECT version, settings, created_by, created_at FROM harness_shared.dao_hr_policy_versions
       WHERE workspace_id = ${dao.workspaceId} AND dao_slug = ${dao.daoSlug}
       ORDER BY version DESC LIMIT 1`;
    const current = latest ? latest.settings : DEFAULT_EQUITY_POLICY;
    const next = validatePolicySettings({ ...current, ...changes }, input.maxima);
    const changedFields = changedPolicyFields(current, next);
    if (changedFields.length === 0) fail('no_change', 'the policy change changes nothing');
    const chainCalls = planChainPolicyCalls(current, next);
    const version = (latest?.version ?? 0) + 1;
    await tx`
      INSERT INTO harness_shared.dao_hr_policy_versions (workspace_id, dao_slug, version, settings, created_by)
      VALUES (${dao.workspaceId}, ${dao.daoSlug}, ${version}, ${tx.json(next as never)}, ${person.id})`;
    await tx`
      INSERT INTO harness_shared.dao_hr_policy_audit (workspace_id, dao_slug, version, actor_person_id, changed_fields, chain_calls, before_settings, after_settings)
      VALUES (${dao.workspaceId}, ${dao.daoSlug}, ${version}, ${person.id}, ${changedFields}, ${tx.json(chainCalls as never)}, ${tx.json(current as never)}, ${tx.json(next as never)})`;
    return { version, settings: next, changedFields, chainCalls };
  });
}

/** Effective equity terms for an offer under the DAO's current policy (P-005 offers call this). */
export async function resolveOfferTerms(
  input: DaoKey & { role: string; level: string; overrides?: unknown },
  deps: EquityPolicyDeps = {},
): Promise<OfferEquityTerms> {
  const current = await getCurrentEquityPolicy(input, deps);
  return resolveOfferTermsFrom(current?.settings ?? DEFAULT_EQUITY_POLICY, current?.version ?? null, input);
}
