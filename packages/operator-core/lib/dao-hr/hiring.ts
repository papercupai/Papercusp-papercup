/** P005: immutable offer terms, separate admin approval and actor history.
 * All people are shared PER references; signing/hire execution belongs to P006/P007. */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { getOrgPg } from '@papercusp/db-org';
import { PERSON_DATATYPE, getCanonicalEntity } from '../relationship-graph/resolver';
import { isDaoHrAdmin } from './contract-templates';
import { DEFAULT_EQUITY_POLICY, getCurrentEquityPolicy, resolveOfferTermsFrom, type OfferEquityTerms } from './equity-policy';
import { PAY_CADENCES, type EngagementType, type PayTerms } from './work-profile';
import { sharePercentage } from '../equity/cap-table';
import type { HivePolicy } from '../hive-policy-schema';
import { readDaoEquityCapTable } from '../dao-finance';
import { getIssuingEntity } from './contract-templates';
import { listWorkProfiles } from './work-profile';
import { listHiveMembersForLocalPot } from '../federated-pot-scope';
import { resolveLocalGithubIdentity } from '../identity/resolve-local-github-identity';
import type { PeopleDeps } from './people';
import type { EquityCapTable } from '../equity/cap-table';

interface DaoKey { workspaceId: string; daoSlug: string }
interface Deps { sql?: Sql }
export type OfferState = 'offered' | 'approved' | 'contract-generated' | 'signed' | 'hire-proposed' | 'hired' | 'rejected' | 'lapsed';
export interface HiringTerms { engagementType: EngagementType; jurisdiction: string; pay: PayTerms; equity: OfferEquityTerms; employmentLike: boolean }
export interface HiringOffer extends DaoKey { offerId: string; roleId: string; personId: string; authoredBy: string; terms: HiringTerms; approvalsRequired: number; state: OfferState; amendsOfferId?: string }
export class HiringError extends Error {
  constructor(readonly code: 'invalid_input' | 'not_admin' | 'person_missing' | 'role_missing' | 'candidate_missing' | 'offer_missing' | 'self_approval' | 'invalid_transition', message: string) { super(message); this.name = 'HiringError'; }
}
const text = z.string().trim().min(1).max(200);
const keySchema = z.object({ workspaceId: text, daoSlug: text });
const paySchema = z.object({ amount: z.string().regex(/^\d{1,16}(?:\.\d{1,2})?$/), currency: z.string().regex(/^[A-Z]{3}$/), cadence: z.enum(PAY_CADENCES) }).strict();
function valid<T>(schema: z.ZodType<T>, input: unknown): T {
  const value = schema.safeParse(input);
  if (!value.success) throw new HiringError('invalid_input', 'Hiring fields are missing or invalid: ' + value.error.issues.map(i => i.path.join('.')).join(', '));
  return value.data;
}
async function person(sql: Sql, workspace: string, id: string): Promise<string> {
  const record = await getCanonicalEntity(sql, workspace, PERSON_DATATYPE, valid(text, id));
  if (!record) throw new HiringError('person_missing', 'A shared person record is required.');
  return record.id;
}
async function admin(sql: Sql, key: DaoKey, id: string): Promise<string> {
  const actor = await person(sql, key.workspaceId, id);
  if (!await isDaoHrAdmin({ ...key, personId: actor }, { sql })) throw new HiringError('not_admin', 'A DAO HR admin is required.');
  return actor;
}
async function history(sql: Sql, key: DaoKey, kind: 'role' | 'candidate' | 'offer', subject: string, state: string, actor: string) {
  await sql`INSERT INTO harness_shared.dao_hr_hiring_history (workspace_id,dao_slug,subject_kind,subject_id,state,actor_person_id)
    VALUES (${key.workspaceId},${key.daoSlug},${kind},${subject},${state},${actor})`;
}
export function looksLikeEmployment(input: { engagementType: EngagementType; pay: PayTerms; managerPersonId: string | null; exclusive: boolean }): boolean {
  return input.engagementType === 'contractor' && input.pay.cadence !== 'per-milestone' && input.managerPersonId !== null && input.exclusive;
}
export function offerPreview(terms: HiringTerms, totals: { issuedShares: string; reservedShares: string }) {
  if (!/^\d+$/.test(totals.issuedShares) || !/^\d+$/.test(totals.reservedShares)) throw new HiringError('invalid_input', 'Chain share totals are required.');
  const shares = BigInt(terms.equity.shares);
  const existing = BigInt(totals.issuedShares) + BigInt(totals.reservedShares);
  const proposed = existing + shares;
  return { offeredShares: String(shares), existingFullyDilutedShares: String(existing), proposedFullyDilutedShares: String(proposed),
    fullyDilutedPercent: sharePercentage(shares, proposed) };
}
export async function createHiringRole(input: DaoKey & { actorPersonId: string; title: string; level: string; managerPersonId?: string | null; exclusive?: boolean }, deps: Deps = {}) {
  const key = valid(keySchema, input), sql = deps.sql ?? getOrgPg().sql;
  const actor = await admin(sql, key, input.actorPersonId);
  const title = valid(z.string().trim().min(1).max(120), input.title), level = valid(z.string().trim().min(1).max(60), input.level);
  const manager = input.managerPersonId ? await person(sql, key.workspaceId, input.managerPersonId) : null;
  const exclusive = valid(z.boolean(), input.exclusive ?? false), roleId = randomUUID();
  await sql.begin(async tx => {
    await tx`INSERT INTO harness_shared.dao_hr_roles (workspace_id,dao_slug,role_id,title,level,manager_person_id,exclusive,created_by)
      VALUES (${key.workspaceId},${key.daoSlug},${roleId},${title},${level},${manager},${exclusive},${actor})`;
    await history(tx as unknown as Sql, key, 'role', roleId, 'open', actor);
  });
  return { ...key, roleId, title, level, managerPersonId: manager, exclusive };
}
export async function addHiringCandidate(input: DaoKey & { roleId: string; personId: string; actorPersonId: string }, deps: Deps = {}) {
  const key = valid(keySchema, input), sql = deps.sql ?? getOrgPg().sql;
  const roleId = valid(text, input.roleId), actor = await admin(sql, key, input.actorPersonId), candidate = await person(sql, key.workspaceId, input.personId);
  await sql.begin(async tx => {
    const [role] = await tx`SELECT role_id FROM harness_shared.dao_hr_roles WHERE workspace_id=${key.workspaceId} AND dao_slug=${key.daoSlug} AND role_id=${roleId}`;
    if (!role) throw new HiringError('role_missing', 'Create a role before adding a candidate.');
    const added = await tx`INSERT INTO harness_shared.dao_hr_candidates (workspace_id,dao_slug,role_id,person_id,created_by)
      VALUES (${key.workspaceId},${key.daoSlug},${roleId},${candidate},${actor}) ON CONFLICT DO NOTHING RETURNING person_id`;
    if (added.length) await history(tx as unknown as Sql, key, 'candidate', roleId + ':' + candidate, 'candidate', actor);
  });
  return { ...key, roleId, personId: candidate };
}
interface OfferRow { workspace_id: string; dao_slug: string; offer_id: string; role_id: string; person_id: string; authored_by: string; terms: HiringTerms; approvals_required: number; state: OfferState; amends_offer_id?: string | null }
const project = (r: OfferRow): HiringOffer => ({ workspaceId: r.workspace_id, daoSlug: r.dao_slug, offerId: r.offer_id, roleId: r.role_id,
  personId: r.person_id, authoredBy: r.authored_by, terms: r.terms, approvalsRequired: r.approvals_required, state: r.state, ...(r.amends_offer_id ? {amendsOfferId:r.amends_offer_id} : {}) });
export async function createHiringOffer(input: DaoKey & { roleId: string; personId: string; actorPersonId: string; engagementType: EngagementType; jurisdiction: string; pay: PayTerms; overrides?: unknown; amendsOfferId?: string }, deps: Deps = {}): Promise<HiringOffer> {
  const key = valid(keySchema, input), sql = deps.sql ?? getOrgPg().sql;
  const pay = valid(paySchema, input.pay), engagementType = valid(z.enum(['employee', 'contractor']), input.engagementType), jurisdiction = valid(text, input.jurisdiction);
  const actor = await admin(sql, key, input.actorPersonId), candidate = await person(sql, key.workspaceId, input.personId), roleId = valid(text, input.roleId);
  return sql.begin(async tx => {
    const connection = tx as unknown as Sql;
    const amends = input.amendsOfferId ? valid(text,input.amendsOfferId) : null;
    let amendmentBase: OfferEquityTerms | undefined;
    if (amends) {
      const [parent] = await tx<Array<{person_id:string;admitted_at:string|null;offboarding_proof:unknown;original_terms:HiringTerms;effective_terms:HiringTerms}>>`
        SELECT o.person_id,c.admitted_at,c.offboarding_proof,o.terms AS original_terms,
          COALESCE((SELECT a.terms FROM harness_shared.dao_hr_offers a
            JOIN harness_shared.dao_hr_contracts ac USING (workspace_id,dao_slug,offer_id)
            WHERE a.workspace_id=o.workspace_id AND a.dao_slug=o.dao_slug AND a.amends_offer_id=o.offer_id
              AND ac.amendment_execution_proof IS NOT NULL
            ORDER BY ac.amendment_execution_proof->>'executedAt' DESC,ac.contract_id DESC LIMIT 1),o.terms) AS effective_terms
        FROM harness_shared.dao_hr_offers o
        JOIN harness_shared.dao_hr_contracts c USING (workspace_id,dao_slug,offer_id)
        WHERE o.workspace_id=${key.workspaceId} AND o.dao_slug=${key.daoSlug} AND o.offer_id=${amends} AND o.state='hired' FOR UPDATE OF c`;
      if (!parent?.admitted_at || parent.offboarding_proof || await person(connection,key.workspaceId,parent.person_id) !== candidate)
        throw new HiringError('invalid_transition','An amendment must reference this person\'s active admitted engagement.');
      amendmentBase = {...parent.original_terms.equity,shares:parent.effective_terms.equity.shares};
    }
    const [role] = await tx<Array<{ title: string; level: string; manager_person_id: string | null; exclusive: boolean }>>`
      SELECT r.title,r.level,r.manager_person_id,r.exclusive FROM harness_shared.dao_hr_candidates c
      JOIN harness_shared.dao_hr_roles r USING (workspace_id,dao_slug,role_id)
      WHERE c.workspace_id=${key.workspaceId} AND c.dao_slug=${key.daoSlug} AND c.role_id=${roleId} AND c.person_id=${candidate}`;
    if (!role) throw new HiringError('candidate_missing', 'Add this candidate to the role before making an offer.');
    const policy = await getCurrentEquityPolicy(key, { sql: connection });
    const settings = policy?.settings ?? DEFAULT_EQUITY_POLICY;
    const equity = resolveOfferTermsFrom(settings, policy?.version ?? null, { role: role.title, level: role.level, overrides: input.overrides, amendmentBase });
    const terms: HiringTerms = { engagementType, jurisdiction, pay, equity, employmentLike: looksLikeEmployment({ engagementType, pay, managerPersonId: role.manager_person_id, exclusive: role.exclusive }) };
    const offerId = randomUUID();
    const encodedTerms = connection.json({ ...terms, pay: { ...terms.pay }, equity: { ...terms.equity } });
    // Standard hires retain their pre1465 SQL surface. The new column is used
    // only by amendments, after their own schema prerequisite is installed.
    const rows = amends ? await tx<OfferRow[]>`INSERT INTO harness_shared.dao_hr_offers (workspace_id,dao_slug,offer_id,role_id,person_id,authored_by,terms,approvals_required,amends_offer_id)
      VALUES (${key.workspaceId},${key.daoSlug},${offerId},${roleId},${candidate},${actor},${encodedTerms},${settings.offerApprovalsRequired},${amends}) RETURNING *` :
      await tx<OfferRow[]>`INSERT INTO harness_shared.dao_hr_offers (workspace_id,dao_slug,offer_id,role_id,person_id,authored_by,terms,approvals_required)
      VALUES (${key.workspaceId},${key.daoSlug},${offerId},${roleId},${candidate},${actor},${encodedTerms},${settings.offerApprovalsRequired}) RETURNING *`;
    await history(connection, key, 'offer', offerId, 'offered', actor);
    return project(rows[0]!);
  }) as Promise<HiringOffer>;
}
export async function getHiringOffer(input: DaoKey & { offerId: string }, deps: Deps = {}): Promise<HiringOffer> {
  const key = valid(keySchema, input), sql = deps.sql ?? getOrgPg().sql, offerId = valid(text, input.offerId);
  const [row] = await sql<OfferRow[]>`SELECT * FROM harness_shared.dao_hr_offers WHERE workspace_id=${key.workspaceId} AND dao_slug=${key.daoSlug} AND offer_id=${offerId}`;
  if (!row) throw new HiringError('offer_missing', 'Offer does not exist in this DAO.');
  return project(row);
}
export async function approveHiringOffer(input: DaoKey & { offerId: string; actorPersonId: string }, deps: Deps = {}): Promise<HiringOffer> {
  const key = valid(keySchema, input), sql = deps.sql ?? getOrgPg().sql, offerId = valid(text, input.offerId);
  const actor = await admin(sql, key, input.actorPersonId);
  return sql.begin(async tx => {
    const connection = tx as unknown as Sql;
    const [row] = await tx<OfferRow[]>`SELECT * FROM harness_shared.dao_hr_offers WHERE workspace_id=${key.workspaceId} AND dao_slug=${key.daoSlug} AND offer_id=${offerId} FOR UPDATE`;
    if (!row) throw new HiringError('offer_missing', 'Offer does not exist in this DAO.');
    const author = await person(connection, key.workspaceId, row.authored_by);
    if (actor === author) throw new HiringError('self_approval', 'The author cannot approve their own offer.');
    if (row.state !== 'offered' && row.state !== 'approved') throw new HiringError('invalid_transition', 'This offer is past internal approval.');
    const approvals = await tx<Array<{ actor_person_id: string }>>`SELECT actor_person_id FROM harness_shared.dao_hr_offer_approvals WHERE workspace_id=${key.workspaceId} AND dao_slug=${key.daoSlug} AND offer_id=${offerId}`;
    const approvedPeople = new Set(await Promise.all(approvals.map(a => person(connection, key.workspaceId, a.actor_person_id))));
    approvedPeople.delete(author);
    if (!approvedPeople.has(actor)) {
      await tx`INSERT INTO harness_shared.dao_hr_offer_approvals (workspace_id,dao_slug,offer_id,actor_person_id)
        VALUES (${key.workspaceId},${key.daoSlug},${offerId},${actor})`;
      await history(connection, key, 'offer', offerId, 'approval-recorded', actor);
      approvedPeople.add(actor);
    }
    if (row.state === 'offered' && approvedPeople.size >= row.approvals_required) {
      await tx`UPDATE harness_shared.dao_hr_offers SET state='approved' WHERE workspace_id=${key.workspaceId} AND dao_slug=${key.daoSlug} AND offer_id=${offerId}`;
      await history(connection, key, 'offer', offerId, 'approved', actor);
      row.state = 'approved';
    }
    return project(row);
  }) as Promise<HiringOffer>;
}
/** Consumers must use this gate before generating a contract or submitting a hire.
 * There is deliberately no client-facing setter for signed/proposed/hired states. */
export async function requireHiringStage(input: DaoKey & { offerId: string; stage: 'contract' | 'hire' }, deps: Deps = {}): Promise<HiringOffer> {
  const offer = await getHiringOffer(input, deps);
  const allowed = input.stage === 'contract' ? offer.state === 'approved' : offer.state === 'signed';
  if (!allowed) throw new HiringError('invalid_transition', input.stage === 'contract' ? 'Internal approval is required before contract generation.' : 'A fully signed contract is required before the hire proposal.');
  return offer;
}
export async function listHiringHistory(input: DaoKey & { subjectKind: 'role' | 'candidate' | 'offer'; subjectId: string }, deps: Deps = {}) {
  const key = valid(keySchema, input), sql = deps.sql ?? getOrgPg().sql;
  const kind = valid(z.enum(['role','candidate','offer']), input.subjectKind), subject = valid(z.string().min(1).max(450), input.subjectId);
  return sql<Array<{ id: string; state: string; actor_person_id: string }>>`SELECT id::text,state,actor_person_id FROM harness_shared.dao_hr_hiring_history
    WHERE workspace_id=${key.workspaceId} AND dao_slug=${key.daoSlug} AND subject_kind=${kind} AND subject_id=${subject} ORDER BY id`;
}

/** The desktop actor comes from a current member's server-resolved identity.
 * Neither a body-supplied PER id nor a roster entry alone establishes identity. */
export async function resolveHiringActor(input: DaoKey, deps: PeopleDeps = {}): Promise<string> {
  const key = valid(keySchema, input), sql = deps.sql ?? getOrgPg().sql;
  const [members, profiles, viewer] = await Promise.all([
    (deps.members ?? listHiveMembersForLocalPot)(key.workspaceId, key.daoSlug),
    listWorkProfiles(key, { sql }),
    deps.viewerGithubId ? deps.viewerGithubId() : resolveLocalGithubIdentity().then(id => id.kind === 'ok' ? id.githubUserId : null),
  ]);
  if (viewer === null || !members.some(m => m.githubUserId === viewer)) throw new HiringError('not_admin', 'A current DAO HR admin must sign in.');
  const profile = profiles.find(p => p.memberGithubUserId === viewer);
  if (!profile) throw new HiringError('not_admin', 'Link your member identity to a person before managing hiring.');
  return admin(sql, key, profile.personId);
}

export interface HiringView {
  actorPersonId: string;
  nonBinding: boolean;
  people: Array<{ personId: string; displayName: string; isHrAdmin: boolean }>;
  roles: Array<{ roleId: string; title: string; level: string; managerPersonId: string | null; exclusive: boolean; candidates: string[] }>;
  offers: Array<HiringOffer & { approvedBy: string[]; preview: ReturnType<typeof offerPreview> | null }>;
  chain: { blockNumber: string; issuedShares: string; reservedShares: string } | null;
  chainError: string | null;
  history: Array<{ id: string; subjectKind: string; subjectId: string; state: string; actorPersonId: string; at: string }>;
}

/** Private HR read. Authorization happens before any offer/pay rows are loaded. */
export async function readHiringView(input: DaoKey & { policy: HivePolicy | null },
  deps: PeopleDeps & { inspectCapTable?: (policy: HivePolicy) => Promise<EquityCapTable> } = {}): Promise<HiringView> {
  const key = valid(keySchema, input), sql = deps.sql ?? getOrgPg().sql;
  const actorPersonId = await resolveHiringActor(key, deps);
  const [roles, candidates, offers, approvals, events, people, entity, chainRead] = await Promise.all([
    sql<Array<{ role_id: string; title: string; level: string; manager_person_id: string | null; exclusive: boolean }>>`SELECT role_id,title,level,manager_person_id,exclusive FROM harness_shared.dao_hr_roles WHERE workspace_id=${key.workspaceId} AND dao_slug=${key.daoSlug} ORDER BY created_at,role_id`,
    sql<Array<{ role_id: string; person_id: string }>>`SELECT role_id,person_id FROM harness_shared.dao_hr_candidates WHERE workspace_id=${key.workspaceId} AND dao_slug=${key.daoSlug} ORDER BY created_at`,
    sql<OfferRow[]>`SELECT * FROM harness_shared.dao_hr_offers WHERE workspace_id=${key.workspaceId} AND dao_slug=${key.daoSlug} ORDER BY created_at,offer_id`,
    sql<Array<{ offer_id: string; actor_person_id: string }>>`SELECT offer_id,actor_person_id FROM harness_shared.dao_hr_offer_approvals WHERE workspace_id=${key.workspaceId} AND dao_slug=${key.daoSlug} ORDER BY created_at`,
    sql<Array<{ id: string; subject_kind: string; subject_id: string; state: string; actor_person_id: string; at: string }>>`SELECT id::text,subject_kind,subject_id,state,actor_person_id,created_at::text AS at FROM harness_shared.dao_hr_hiring_history WHERE workspace_id=${key.workspaceId} AND dao_slug=${key.daoSlug} ORDER BY id DESC LIMIT 200`,
    sql<Array<{ person_id: string; title: string; is_hr_admin: boolean }>>`SELECT p.feature_id AS person_id,p.title,
      EXISTS (SELECT 1 FROM harness_shared.dao_hr_admins a WHERE a.workspace_id=p.workspace_id AND a.dao_slug=${key.daoSlug} AND a.person_id=p.feature_id) AS is_hr_admin
      FROM harness_shared.work_items p WHERE p.workspace_id=${key.workspaceId} AND p.item_kind='person' AND p.feature_id LIKE 'PER-%' AND COALESCE(p.payload->>'mergedInto','')='' ORDER BY p.title,p.feature_id`,
    getIssuingEntity(key, { sql }),
    (async () => {
      try {
        if (!input.policy?.finance?.equity) throw new Error('No signed equity deployment');
        const table = await (deps.inspectCapTable ?? readDaoEquityCapTable)(input.policy);
        if (table.chainId !== input.policy.finance.equity.chainId) throw new Error('Wrong chain');
        return { table, error: null };
      } catch { return { table: null, error: 'Chain totals are unavailable. Refresh before relying on an offer percentage.' }; }
    })(),
  ]);
  const chain = chainRead.table ? { blockNumber: chainRead.table.blockNumber, issuedShares: chainRead.table.issuedShares, reservedShares: chainRead.table.reservedShares } : null;
  return { actorPersonId, nonBinding: !entity, people: people.map(p => ({ personId: p.person_id, displayName: p.title, isHrAdmin: p.is_hr_admin })),
    roles: roles.map(r => ({ roleId: r.role_id, title: r.title, level: r.level, managerPersonId: r.manager_person_id, exclusive: r.exclusive,
      candidates: candidates.filter(c => c.role_id === r.role_id).map(c => c.person_id) })),
    offers: offers.map(r => ({ ...project(r), approvedBy: approvals.filter(a => a.offer_id === r.offer_id).map(a => a.actor_person_id), preview: chain ? offerPreview(r.terms, chain) : null })),
    chain, chainError: chainRead.error,
    history: events.map(e => ({ id: e.id, subjectKind: e.subject_kind, subjectId: e.subject_id, state: e.state, actorPersonId: e.actor_person_id, at: e.at })) };
}

export const hiringActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('role'), title: text, level: text, managerPersonId: text.nullable().optional(), exclusive: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('candidate'), roleId: text, personId: text }).strict(),
  z.object({ action: z.literal('offer'), roleId: text, personId: text, engagementType: z.enum(['employee','contractor']), jurisdiction: text, pay: paySchema, overrides: z.unknown().optional(), amendsOfferId: text.optional() }).strict(),
  z.object({ action: z.literal('approve'), offerId: text }).strict(),
]);
export async function runHiringAction(key: DaoKey, raw: unknown, deps: PeopleDeps = {}) {
  const action = valid(hiringActionSchema, raw), actorPersonId = await resolveHiringActor(key, deps);
  const input = { ...key, ...action, actorPersonId };
  switch (input.action) {
    case 'role': return createHiringRole(input, deps);
    case 'candidate': return addHiringCandidate(input, deps);
    case 'offer': return createHiringOffer(input, deps);
    case 'approve': return approveHiringOffer(input, deps);
  }
}
