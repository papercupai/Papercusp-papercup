/**
 * DAO HR work profile (dao-hr-people-2026-10-11 P-002, R-1; D-011).
 *
 * A work profile is the HR view of ONE person inside ONE DAO. The person is the shared
 * person record — the canonical PER- entity the relationship graph owns — and this module
 * adds only work facts (title, team, manager, level, start date, engagement type,
 * jurisdiction, lifecycle status, pay terms per D-005) plus two links:
 *
 *   - the DAO member identity: the GitHub principal hive memberships key a member by;
 *   - the verified wallet link: recorded ONLY from a hosted wallet-binding read
 *     (`readWalletBinding`, the signed-challenge door) whose principal is that member.
 *
 * It never stores a name, email, phone or postal address (R-1; the schema guard in
 * ./schema-guard.ts fails any dao-hr migration that tries). Every id written is the
 * merge SURVIVOR, resolved through `getCanonicalEntity`, and a profile cannot be saved for
 * an id that resolves to no person record (SPEC-P-002).
 *
 * Lifecycle: a candidate may lack both links (SPEC-P-002-D/-E); finishing onboarding
 * requires a verified wallet link (SPEC-P-002-A, also enforced by a table CHECK).
 * Offboarding belongs to the fire flow (P-008) and is not exposed here.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { normalizeEvmAddress } from '../cupboard/wallet-binding';
import type { WalletBindingHostedResult } from '../cupboard/wallet-binding-io';
import { PERSON_DATATYPE, getCanonicalEntity } from '../relationship-graph/resolver';

export const ENGAGEMENT_TYPES = ['employee', 'contractor'] as const;
export type EngagementType = (typeof ENGAGEMENT_TYPES)[number];

export const WORK_PROFILE_STATUSES = ['candidate', 'offered', 'onboarding', 'active', 'offboarded'] as const;
export type WorkProfileStatus = (typeof WORK_PROFILE_STATUSES)[number];

export const PAY_CADENCES = ['hourly', 'weekly', 'biweekly', 'monthly', 'annual', 'per-milestone'] as const;
export type PayCadence = (typeof PAY_CADENCES)[number];

/** Regular pay terms (D-005). `amount` is a decimal string so no float ever rounds pay. */
export interface PayTerms {
  amount: string;
  currency: string;
  cadence: PayCadence;
}

export interface VerifiedWalletLink {
  address: string;
  chainId: number;
  /** The hosted binding's challenge id — the signed proof the link was recorded from. */
  bindingRef: string;
  verifiedAt: string;
}

export interface WorkProfile {
  workspaceId: string;
  daoSlug: string;
  /** Canonical PER- person record id (the merge survivor). */
  personId: string;
  title: string;
  team: string | null;
  managerPersonId: string | null;
  level: string | null;
  /** ISO date `YYYY-MM-DD`. */
  startDate: string | null;
  engagementType: EngagementType;
  jurisdiction: string;
  status: WorkProfileStatus;
  pay: PayTerms | null;
  /** DAO member identity: the GitHub user id hive memberships key the member by. */
  memberGithubUserId: number | null;
  wallet: VerifiedWalletLink | null;
  onboardedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkProfileKey {
  workspaceId: string;
  daoSlug: string;
  personId: string;
}

export interface SaveWorkProfileInput extends WorkProfileKey {
  title: string;
  team?: string | null;
  managerPersonId?: string | null;
  level?: string | null;
  startDate?: string | null;
  engagementType: EngagementType;
  jurisdiction: string;
  pay?: PayTerms | null;
}

export type WorkProfileErrorCode =
  | 'invalid_input'
  | 'person_missing'
  | 'manager_missing'
  | 'profile_missing'
  | 'member_identity_missing'
  | 'member_identity_conflict'
  | 'wallet_unverified'
  | 'wallet_principal_mismatch'
  | 'invalid_transition';

export class WorkProfileError extends Error {
  readonly code: WorkProfileErrorCode;
  constructor(code: WorkProfileErrorCode, message: string) {
    super(message);
    this.name = 'WorkProfileError';
    this.code = code;
  }
}

export interface WorkProfileDeps {
  sql?: Sql;
  now?: () => Date;
}

function db(deps: WorkProfileDeps): Sql {
  return deps.sql ?? getOrgPg().sql;
}

function fail(code: WorkProfileErrorCode, message: string): never {
  throw new WorkProfileError(code, message);
}

function requiredText(field: string, value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail('invalid_input', `${field} is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) fail('invalid_input', `${field} exceeds ${max} characters`);
  return trimmed;
}

function optionalText(field: string, value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  return requiredText(field, value, max);
}

function validKey(key: WorkProfileKey): WorkProfileKey {
  return {
    workspaceId: requiredText('workspaceId', key.workspaceId, 200),
    daoSlug: requiredText('daoSlug', key.daoSlug, 200),
    personId: requiredText('personId', key.personId, 200),
  };
}

function validStartDate(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('invalid_input', 'startDate must be YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail('invalid_input', `startDate ${value} is not a calendar date`);
  }
  return value;
}

function validPay(pay: PayTerms | null | undefined): PayTerms | null {
  if (pay === undefined || pay === null) return null;
  if (typeof pay.amount !== 'string' || !/^\d{1,16}(?:\.\d{1,2})?$/.test(pay.amount)) {
    fail('invalid_input', 'pay.amount must be a non-negative decimal string with at most 2 decimal places');
  }
  if (typeof pay.currency !== 'string' || !/^[A-Z]{3}$/.test(pay.currency)) {
    fail('invalid_input', 'pay.currency must be an ISO-4217 code such as USD');
  }
  if (!PAY_CADENCES.includes(pay.cadence)) fail('invalid_input', `pay.cadence must be one of ${PAY_CADENCES.join(', ')}`);
  return { amount: pay.amount, currency: pay.currency, cadence: pay.cadence };
}

/** The canonical person id for `id`, or a `code` error when no shared person record exists. */
async function resolvePerson(sql: Sql, workspaceId: string, id: string, code: 'person_missing' | 'manager_missing'): Promise<string> {
  const person = await getCanonicalEntity(sql, workspaceId, PERSON_DATATYPE, id);
  if (!person) fail(code, `${id} has no shared person record in workspace ${workspaceId}`);
  return person.id;
}

interface ProfileRow {
  workspace_id: string;
  dao_slug: string;
  person_id: string;
  title: string;
  team: string | null;
  manager_person_id: string | null;
  level: string | null;
  start_date: string | null;
  engagement_type: EngagementType;
  jurisdiction: string;
  status: WorkProfileStatus;
  pay_amount: string | null;
  pay_currency: string | null;
  pay_cadence: PayCadence | null;
  member_github_user_id: number | string | null;
  wallet_address: string | null;
  wallet_chain_id: number | null;
  wallet_binding_ref: string | null;
  wallet_verified_at: Date | string | null;
  onboarded_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const PROFILE_COLUMNS = `workspace_id, dao_slug, person_id, title, team, manager_person_id, level,
  to_char(start_date, 'YYYY-MM-DD') AS start_date, engagement_type, jurisdiction, status,
  pay_amount::text AS pay_amount, pay_currency, pay_cadence, member_github_user_id,
  wallet_address, wallet_chain_id, wallet_binding_ref, wallet_verified_at, onboarded_at,
  created_at, updated_at`;

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toProfile(row: ProfileRow): WorkProfile {
  const wallet =
    row.wallet_address && row.wallet_chain_id !== null && row.wallet_binding_ref && row.wallet_verified_at
      ? {
          address: row.wallet_address,
          chainId: Number(row.wallet_chain_id),
          bindingRef: row.wallet_binding_ref,
          verifiedAt: iso(row.wallet_verified_at)!,
        }
      : null;
  return {
    workspaceId: row.workspace_id,
    daoSlug: row.dao_slug,
    personId: row.person_id,
    title: row.title,
    team: row.team,
    managerPersonId: row.manager_person_id,
    level: row.level,
    startDate: row.start_date,
    engagementType: row.engagement_type,
    jurisdiction: row.jurisdiction,
    status: row.status,
    pay:
      row.pay_amount !== null && row.pay_currency !== null && row.pay_cadence !== null
        ? { amount: row.pay_amount, currency: row.pay_currency, cadence: row.pay_cadence }
        : null,
    memberGithubUserId: row.member_github_user_id === null ? null : Number(row.member_github_user_id),
    wallet,
    onboardedAt: iso(row.onboarded_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

async function readRow(sql: Sql, key: WorkProfileKey): Promise<WorkProfile | null> {
  const [row] = await sql.unsafe<ProfileRow[]>(
    `SELECT ${PROFILE_COLUMNS} FROM harness_shared.dao_hr_work_profiles
      WHERE workspace_id = $1 AND dao_slug = $2 AND person_id = $3`,
    [key.workspaceId, key.daoSlug, key.personId],
  );
  return row ? toProfile(row) : null;
}

/** The profile for `key`, or a `profile_missing` error. Follows a merged person id to its survivor. */
async function requireProfile(sql: Sql, key: WorkProfileKey): Promise<WorkProfile> {
  const valid = validKey(key);
  const personId = await resolvePerson(sql, valid.workspaceId, valid.personId, 'person_missing');
  const profile = await readRow(sql, { ...valid, personId });
  if (!profile) fail('profile_missing', `${personId} has no work profile in DAO ${valid.daoSlug}`);
  return profile;
}

/**
 * Create or update a person's work facts in a DAO. Rejects a person id with no shared
 * person record (SPEC-P-002) and a manager who is not a person. A new profile starts as
 * `candidate` with no member identity and no wallet link (SPEC-P-002-D/-E); status and
 * links are changed only by their own functions below.
 */
export async function saveWorkProfile(input: SaveWorkProfileInput, deps: WorkProfileDeps = {}): Promise<WorkProfile> {
  const sql = db(deps);
  const key = validKey(input);
  const title = requiredText('title', input.title, 200);
  const team = optionalText('team', input.team, 200);
  const level = optionalText('level', input.level, 100);
  const jurisdiction = requiredText('jurisdiction', input.jurisdiction, 64);
  if (jurisdiction.length < 2) fail('invalid_input', 'jurisdiction must be at least 2 characters');
  if (!ENGAGEMENT_TYPES.includes(input.engagementType)) {
    fail('invalid_input', `engagementType must be one of ${ENGAGEMENT_TYPES.join(', ')}`);
  }
  const startDate = validStartDate(input.startDate);
  const pay = validPay(input.pay);

  const personId = await resolvePerson(sql, key.workspaceId, key.personId, 'person_missing');
  const managerRaw = optionalText('managerPersonId', input.managerPersonId, 200);
  const managerPersonId = managerRaw === null ? null : await resolvePerson(sql, key.workspaceId, managerRaw, 'manager_missing');
  if (managerPersonId === personId) fail('invalid_input', 'a person cannot be their own manager');

  const now = (deps.now ?? (() => new Date()))();
  const [row] = await sql.unsafe<ProfileRow[]>(
    `INSERT INTO harness_shared.dao_hr_work_profiles
       (workspace_id, dao_slug, person_id, title, team, manager_person_id, level, start_date,
        engagement_type, jurisdiction, pay_amount, pay_currency, pay_cadence, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, $11::numeric, $12, $13, $14, $14)
     ON CONFLICT (workspace_id, dao_slug, person_id) DO UPDATE SET
       title = EXCLUDED.title, team = EXCLUDED.team, manager_person_id = EXCLUDED.manager_person_id,
       level = EXCLUDED.level, start_date = EXCLUDED.start_date, engagement_type = EXCLUDED.engagement_type,
       jurisdiction = EXCLUDED.jurisdiction, pay_amount = EXCLUDED.pay_amount,
       pay_currency = EXCLUDED.pay_currency, pay_cadence = EXCLUDED.pay_cadence,
       updated_at = EXCLUDED.updated_at
     RETURNING ${PROFILE_COLUMNS}`,
    [
      key.workspaceId,
      key.daoSlug,
      personId,
      title,
      team,
      managerPersonId,
      level,
      startDate,
      input.engagementType,
      jurisdiction,
      pay?.amount ?? null,
      pay?.currency ?? null,
      pay?.cadence ?? null,
      now,
    ],
  );
  return toProfile(row!);
}

/** A person's work profile in a DAO (following a merged person id), or null. */
export async function getWorkProfile(key: WorkProfileKey, deps: WorkProfileDeps = {}): Promise<WorkProfile | null> {
  const sql = db(deps);
  const valid = validKey(key);
  const person = await getCanonicalEntity(sql, valid.workspaceId, PERSON_DATATYPE, valid.personId);
  if (!person) return null;
  return readRow(sql, { ...valid, personId: person.id });
}

/** Every work profile in one DAO, optionally filtered by status, ordered by person id. */
export async function listWorkProfiles(
  input: { workspaceId: string; daoSlug: string; status?: WorkProfileStatus },
  deps: WorkProfileDeps = {},
): Promise<WorkProfile[]> {
  const sql = db(deps);
  const workspaceId = requiredText('workspaceId', input.workspaceId, 200);
  const daoSlug = requiredText('daoSlug', input.daoSlug, 200);
  if (input.status !== undefined && !WORK_PROFILE_STATUSES.includes(input.status)) {
    fail('invalid_input', `status must be one of ${WORK_PROFILE_STATUSES.join(', ')}`);
  }
  const rows = await sql.unsafe<ProfileRow[]>(
    `SELECT ${PROFILE_COLUMNS} FROM harness_shared.dao_hr_work_profiles
      WHERE workspace_id = $1 AND dao_slug = $2 AND ($3::text IS NULL OR status = $3)
      ORDER BY person_id`,
    [workspaceId, daoSlug, input.status ?? null],
  );
  return rows.map(toProfile);
}

/**
 * Link the person to their DAO member identity (the GitHub principal a hive membership is
 * keyed by). One member identity maps to at most one profile per DAO; re-linking a
 * profile that already carries a verified wallet to a DIFFERENT member is refused, since the
 * wallet was verified for the previous principal.
 */
export async function linkMemberIdentity(
  input: WorkProfileKey & { member: { githubUserId: number } },
  deps: WorkProfileDeps = {},
): Promise<WorkProfile> {
  const sql = db(deps);
  const githubUserId = input.member?.githubUserId;
  if (!Number.isSafeInteger(githubUserId) || githubUserId <= 0) {
    fail('invalid_input', 'member.githubUserId must be a positive integer');
  }
  const profile = await requireProfile(sql, input);
  if (profile.wallet && profile.memberGithubUserId !== null && profile.memberGithubUserId !== githubUserId) {
    fail('member_identity_conflict', `${profile.personId} has a wallet verified for another member identity`);
  }
  const [holder] = await sql<Array<{ person_id: string }>>`
    SELECT person_id FROM harness_shared.dao_hr_work_profiles
     WHERE workspace_id = ${profile.workspaceId} AND dao_slug = ${profile.daoSlug}
       AND member_github_user_id = ${githubUserId} AND person_id <> ${profile.personId}`;
  if (holder) {
    fail('member_identity_conflict', `member ${githubUserId} is already linked to ${holder.person_id} in DAO ${profile.daoSlug}`);
  }
  const now = (deps.now ?? (() => new Date()))();
  const [row] = await sql.unsafe<ProfileRow[]>(
    `UPDATE harness_shared.dao_hr_work_profiles
        SET member_github_user_id = $4, updated_at = $5
      WHERE workspace_id = $1 AND dao_slug = $2 AND person_id = $3
      RETURNING ${PROFILE_COLUMNS}`,
    [profile.workspaceId, profile.daoSlug, profile.personId, githubUserId, now],
  );
  return toProfile(row!);
}

function bindingObject(result: WalletBindingHostedResult): Record<string, unknown> | null {
  if (!result.ok) return null;
  const binding = result.value.binding;
  return binding && typeof binding === 'object' && !Array.isArray(binding) ? (binding as Record<string, unknown>) : null;
}

/**
 * Record the person's verified wallet link from a hosted wallet-binding read.
 *
 * `binding` is the result of `readWalletBinding` made with the PERSON'S OWN authenticated
 * session, and `principalGithubUserId` is the GitHub user that session authenticated as. The
 * link is refused unless the profile already carries a member identity equal to that
 * principal, the hosted read reports a bound wallet with a signed challenge and a
 * verification time — so a wallet can never be attached by typing an address.
 */
export async function linkVerifiedWallet(
  input: WorkProfileKey & { principalGithubUserId: number; binding: WalletBindingHostedResult },
  deps: WorkProfileDeps = {},
): Promise<WorkProfile> {
  const sql = db(deps);
  const profile = await requireProfile(sql, input);
  if (profile.memberGithubUserId === null) {
    fail('member_identity_missing', `${profile.personId} has no DAO member identity; link it before the wallet`);
  }
  if (input.principalGithubUserId !== profile.memberGithubUserId) {
    fail('wallet_principal_mismatch', 'the wallet binding was read for a different principal than this member identity');
  }
  const binding = bindingObject(input.binding);
  const address = typeof binding?.walletAddress === 'string' ? normalizeEvmAddress(binding.walletAddress) : null;
  const chainId = binding?.chainId;
  const bindingRef = binding?.challengeId;
  const verifiedAtMs = binding?.verifiedAtMs;
  if (
    !address ||
    typeof chainId !== 'number' ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    typeof bindingRef !== 'string' ||
    bindingRef.length === 0 ||
    typeof verifiedAtMs !== 'number' ||
    !Number.isFinite(verifiedAtMs) ||
    verifiedAtMs <= 0
  ) {
    fail('wallet_unverified', 'the hosted wallet-binding read did not return a verified binding');
  }
  const now = (deps.now ?? (() => new Date()))();
  const [row] = await sql.unsafe<ProfileRow[]>(
    `UPDATE harness_shared.dao_hr_work_profiles
        SET wallet_address = $4, wallet_chain_id = $5, wallet_binding_ref = $6,
            wallet_verified_at = to_timestamp($7::double precision / 1000), updated_at = $8
      WHERE workspace_id = $1 AND dao_slug = $2 AND person_id = $3
      RETURNING ${PROFILE_COLUMNS}`,
    [profile.workspaceId, profile.daoSlug, profile.personId, address, chainId, bindingRef, verifiedAtMs, now],
  );
  return toProfile(row!);
}

/** Status moves this module owns. Onboarding → active goes through completeOnboarding; offboarding is P-008's. */
const ALLOWED_TRANSITIONS: Readonly<Record<WorkProfileStatus, readonly WorkProfileStatus[]>> = {
  candidate: ['offered'],
  offered: ['onboarding', 'candidate'],
  onboarding: [],
  active: [],
  offboarded: [],
};

/** Move a profile along candidate → offered → onboarding (or back to candidate when an offer is withdrawn). */
export async function setWorkProfileStatus(
  input: WorkProfileKey & { status: WorkProfileStatus },
  deps: WorkProfileDeps = {},
): Promise<WorkProfile> {
  const sql = db(deps);
  const profile = await requireProfile(sql, input);
  if (!ALLOWED_TRANSITIONS[profile.status].includes(input.status)) {
    fail('invalid_transition', `cannot move ${profile.personId} from ${profile.status} to ${input.status}`);
  }
  const now = (deps.now ?? (() => new Date()))();
  const [row] = await sql.unsafe<ProfileRow[]>(
    `UPDATE harness_shared.dao_hr_work_profiles SET status = $4, updated_at = $5
      WHERE workspace_id = $1 AND dao_slug = $2 AND person_id = $3 AND status = $6
      RETURNING ${PROFILE_COLUMNS}`,
    [profile.workspaceId, profile.daoSlug, profile.personId, input.status, now, profile.status],
  );
  if (!row) fail('invalid_transition', `${profile.personId} changed status concurrently; re-read and retry`);
  return toProfile(row);
}

/**
 * Finish onboarding: the person becomes `active`. Refused unless the profile is in
 * `onboarding` and carries a verified wallet link (SPEC-P-002-A) — the table's CHECK
 * constraint refuses the same state, so no other writer can bypass it.
 */
export async function completeOnboarding(key: WorkProfileKey, deps: WorkProfileDeps = {}): Promise<WorkProfile> {
  const sql = db(deps);
  const profile = await requireProfile(sql, key);
  if (profile.status !== 'onboarding') {
    fail('invalid_transition', `${profile.personId} is ${profile.status}, not onboarding`);
  }
  if (!profile.wallet) {
    fail('wallet_unverified', `${profile.personId} has no verified wallet link; onboarding cannot complete`);
  }
  const now = (deps.now ?? (() => new Date()))();
  const [row] = await sql.unsafe<ProfileRow[]>(
    `UPDATE harness_shared.dao_hr_work_profiles
        SET status = 'active', onboarded_at = $4, updated_at = $4
      WHERE workspace_id = $1 AND dao_slug = $2 AND person_id = $3 AND status = 'onboarding'
        AND wallet_verified_at IS NOT NULL
      RETURNING ${PROFILE_COLUMNS}`,
    [profile.workspaceId, profile.daoSlug, profile.personId, now],
  );
  if (!row) fail('invalid_transition', `${profile.personId} changed concurrently; re-read and retry`);
  return toProfile(row);
}
