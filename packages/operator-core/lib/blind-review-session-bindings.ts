import { randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { readSessionConfinement } from './capability-envelope/session-confinement-store';
import type { SessionToolConfinement } from './capability-envelope/session-confinement';
import { isBlindReviewerBackendAgent } from './blind-reviewer-backends';

export const BLIND_GAP_REVIEW_ACTOR = 'system:blind-gap-review';
export const INTERNAL_BLIND_REVIEW_RESUME = Symbol('internal-blind-review-resume');

export type BlindReviewResumePermit = {
  bindingId: number;
  leaseId: string;
  workspaceId: string;
  planSlug: string;
  activationAuditSeq: number;
  reviewerOwnerId: string;
  advSessionId: number;
  nativeSessionId: string;
};

type Status = 'ready' | 'resuming' | 'posted' | 'closed' | 'failed';
type Row = {
  id: number | string; workspace_id: string; harness_slug: string; plan_slug: string;
  activation_audit_seq: number | string; reviewer_owner_id: string;
  adv_session_id: number | string; native_session_id: string; launch_parent_owner: string;
  account_route: string | null; model_spec: string | null; confinement_snapshot: unknown;
  status: Status; resume_lease_id: string | null; resume_lease_expires_at: Date | string | null;
  review_id: number | string | null;
};
type AdvRow = {
  id: number | string; workspace_id: string; coord_owner_id: string | null; session_id: string | null;
  agent: string | null; launch_spec: unknown; launch_argv: unknown;
};
type Sql = ReturnType<typeof getOrgPg>['sql'];

export type BlindReviewSessionBinding = {
  id: number; workspaceId: string; harnessSlug: string; planSlug: string;
  activationAuditSeq: number; reviewerOwnerId: string; advSessionId: number;
  nativeSessionId: string; launchParentOwner: string; accountRoute: string | null;
  modelSpec: string | null; confinementSnapshot: SessionToolConfinement;
  status: Status; resumeLeaseId: string | null; resumeLeaseExpiresAt: string | null;
  reviewId: number | null;
};

type FailureCode = 'adv_session_mismatch' | 'launch_profile_mismatch' | 'confinement_mismatch' |
  'binding_conflict' | 'binding_not_found' | 'binding_unavailable' | 'native_session_unresolved' |
  'resume_busy' | 'resume_lease_lost';
export type BlindReviewBindingResult =
  | { ok: true; created?: boolean; binding: BlindReviewSessionBinding }
  | { ok: false; code: FailureCode; message: string };

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) as unknown; } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return '{' + Object.keys(row).sort().map((key) => JSON.stringify(key) + ':' + stable(row[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function map(row: Row | undefined): BlindReviewSessionBinding | null {
  // Reservations have no native identity until the exact launch is reconciled.
  if (!row || !row.reviewer_owner_id || !row.adv_session_id || !row.native_session_id) return null;
  const confinement = object(row.confinement_snapshot);
  if (!confinement) return null;
  if (!Array.isArray(confinement.denyTools) || confinement.denyTools.some((name) => typeof name !== 'string') ||
      confinement.denyOutside !== undefined && (!Array.isArray(confinement.denyOutside) ||
        confinement.denyOutside.some((name) => typeof name !== 'string')) ||
      confinement.denyAmbientContext !== undefined && confinement.denyAmbientContext !== true ||
      typeof confinement.imposedBy !== 'string' || typeof confinement.reason !== 'string') return null;
  const expires = row.resume_lease_expires_at instanceof Date
    ? row.resume_lease_expires_at.toISOString() : row.resume_lease_expires_at;
  return {
    id: Number(row.id), workspaceId: row.workspace_id, harnessSlug: row.harness_slug,
    planSlug: row.plan_slug, activationAuditSeq: Number(row.activation_audit_seq),
    reviewerOwnerId: row.reviewer_owner_id, advSessionId: Number(row.adv_session_id),
    nativeSessionId: row.native_session_id, launchParentOwner: row.launch_parent_owner,
    accountRoute: row.account_route, modelSpec: row.model_spec,
    confinementSnapshot: confinement as unknown as SessionToolConfinement, status: row.status,
    resumeLeaseId: row.resume_lease_id, resumeLeaseExpiresAt: expires,
    reviewId: row.review_id == null ? null : Number(row.review_id),
  };
}

function argvValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  if (typeof value === 'string') {
    try { value = JSON.parse(value) as unknown; } catch { return []; }
  }
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  const parsed = object(value);
  return Array.isArray(parsed?.argv) ? parsed.argv.filter((entry): entry is string => typeof entry === 'string') : [];
}

function flag(argv: string[], name: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]?.startsWith(name + '=')) return argv[i]!.slice(name.length + 1);
    if (argv[i] === name && argv[i + 1]) return argv[i + 1]!;
  }
  return null;
}

async function readAdv(sql: Sql, workspaceId: string, advSessionId: number): Promise<AdvRow | null> {
  const [row] = await sql<AdvRow[]>`
    SELECT id, workspace_id, coord_owner_id, session_id, agent, launch_spec, launch_argv
      FROM harness_shared.adv_sessions
     WHERE workspace_id = ${workspaceId} AND id = ${advSessionId}
     LIMIT 1`;
  return row ?? null;
}

function inspectAdv(row: AdvRow | null, b: Pick<BlindReviewSessionBinding,
  'workspaceId' | 'reviewerOwnerId' | 'advSessionId' | 'nativeSessionId' | 'launchParentOwner'>):
  { ok: true; accountRoute: string; modelSpec: string | null } |
  { ok: false; code: 'adv_session_mismatch' | 'launch_profile_mismatch'; message: string } {
  if (!row || Number(row.id) !== b.advSessionId || row.workspace_id !== b.workspaceId ||
      row.coord_owner_id !== b.reviewerOwnerId || (row.session_id != null && row.session_id !== b.nativeSessionId)) {
    return { ok: false, code: 'adv_session_mismatch', message: 'The native reviewer identity does not match its ADV session row.' };
  }
  const spec = object(row.launch_spec);
  const argv = argvValue(row.launch_argv);
  const accountRoute = typeof spec?.account === 'string' ? spec.account : flag(argv, '--account');
  const modelSpec = typeof spec?.model === 'string' ? spec.model : flag(argv, '--model');
  const headless = spec?.headless === true || argv.includes('--headless');
  if (!isBlindReviewerBackendAgent(row.agent) || !headless || spec?.launchedBy !== b.launchParentOwner ||
      b.launchParentOwner !== BLIND_GAP_REVIEW_ACTOR || accountRoute !== 'auto') {
    return { ok: false, code: 'launch_profile_mismatch', message: 'The ADV row does not retain the blind-review recruiter and gateway launch profile.' };
  }
  return { ok: true, accountRoute, modelSpec };
}

function sameImmutable(a: BlindReviewSessionBinding, b: BlindReviewSessionBinding): boolean {
  return a.workspaceId === b.workspaceId && a.harnessSlug === b.harnessSlug &&
    a.planSlug === b.planSlug && a.activationAuditSeq === b.activationAuditSeq &&
    a.reviewerOwnerId === b.reviewerOwnerId && a.advSessionId === b.advSessionId &&
    a.nativeSessionId === b.nativeSessionId && a.launchParentOwner === b.launchParentOwner &&
    a.accountRoute === b.accountRoute && a.modelSpec === b.modelSpec &&
    stable(a.confinementSnapshot) === stable(b.confinementSnapshot);
}

export async function findBlindReviewSessionBinding(input: {
  workspaceId: string; planSlug: string; activationAuditSeq: number;
}, deps: { sql?: Sql } = {}): Promise<BlindReviewSessionBinding | null> {
  const sql = deps.sql ?? getOrgPg().sql;
  const [row] = await sql<Row[]>`
    SELECT * FROM harness_shared.plan_blind_review_sessions
     WHERE launch_parent_owner = ${BLIND_GAP_REVIEW_ACTOR}
       AND workspace_id = ${input.workspaceId} AND plan_slug = ${input.planSlug}
       AND activation_audit_seq = ${input.activationAuditSeq}
       AND reviewer_owner_id IS NOT NULL
     ORDER BY id DESC
     LIMIT 1`;
  return map(row);
}

export async function findBlindReviewSessionBindingByAdvSession(input: {
  workspaceId: string; reviewerOwnerId: string; advSessionId: number;
}, deps: { sql?: Sql } = {}): Promise<BlindReviewSessionBinding | null> {
  const sql = deps.sql ?? getOrgPg().sql;
  const [row] = await sql<Row[]>`
    SELECT * FROM harness_shared.plan_blind_review_sessions
     WHERE launch_parent_owner = ${BLIND_GAP_REVIEW_ACTOR}
       AND reviewer_owner_id = ${input.reviewerOwnerId}
       AND workspace_id = ${input.workspaceId} AND adv_session_id = ${input.advSessionId}
     LIMIT 1`;
  return map(row);
}

export async function inspectBlindReviewResumeTarget(input: {
  workspaceId: string; reviewerOwnerId: string; advSessionId: number;
}, deps: { sql?: Sql } = {}): Promise<{
  binding: BlindReviewSessionBinding | null;
  recruiterLaunch: boolean;
}> {
  const sql = deps.sql ?? getOrgPg().sql;
  const adv = await readAdv(sql, input.workspaceId, input.advSessionId);
  const [row] = await sql<Row[]>`
    SELECT * FROM harness_shared.plan_blind_review_sessions
     WHERE launch_parent_owner = ${BLIND_GAP_REVIEW_ACTOR}
       AND reviewer_owner_id = ${input.reviewerOwnerId}
       AND workspace_id = ${input.workspaceId} AND adv_session_id = ${input.advSessionId}
     LIMIT 1`;
  return {
    binding: map(row),
    recruiterLaunch: !!adv && adv.coord_owner_id === input.reviewerOwnerId &&
      object(adv.launch_spec)?.launchedBy === BLIND_GAP_REVIEW_ACTOR,
  };
}

export async function findBlindReviewSessionBindingByReviewer(input: {
  workspaceId: string; planSlug: string; activationAuditSeq: number; reviewerOwnerId: string;
}, deps: { sql?: Sql } = {}): Promise<BlindReviewSessionBinding | null> {
  const sql = deps.sql ?? getOrgPg().sql;
  const [row] = await sql<Row[]>`
    SELECT * FROM harness_shared.plan_blind_review_sessions
     WHERE workspace_id = ${input.workspaceId} AND plan_slug = ${input.planSlug}
       AND activation_audit_seq = ${input.activationAuditSeq}
       AND reviewer_owner_id = ${input.reviewerOwnerId}
       AND launch_parent_owner = ${BLIND_GAP_REVIEW_ACTOR} LIMIT 1`;
  return map(row);
}

export async function findLatestBlindReviewSessionBindingByReviewer(input: {
  workspaceId: string; planSlug: string; reviewerOwnerId: string;
}, deps: { sql?: Sql } = {}): Promise<BlindReviewSessionBinding | null> {
  const sql = deps.sql ?? getOrgPg().sql;
  const [row] = await sql<Row[]>`
    SELECT * FROM harness_shared.plan_blind_review_sessions
     WHERE launch_parent_owner = ${BLIND_GAP_REVIEW_ACTOR}
       AND workspace_id = ${input.workspaceId} AND plan_slug = ${input.planSlug}
       AND reviewer_owner_id = ${input.reviewerOwnerId}
     ORDER BY activation_audit_seq DESC
     LIMIT 1`;
  return map(row);
}

export async function createBlindReviewSessionBinding(input: {
  workspaceId: string; harnessSlug: string; planSlug: string; activationAuditSeq: number;
  reviewerOwnerId: string; advSessionId: number; nativeSessionId: string | null;
  launchParentOwner: string; confinement: SessionToolConfinement;
  replacementAttemptId?: number;
}, deps: { sql?: Sql } = {}): Promise<BlindReviewBindingResult> {
  const sql = deps.sql ?? getOrgPg().sql;
  try {
    const adv = await readAdv(sql, input.workspaceId, input.advSessionId);
    const nativeSessionId = input.nativeSessionId?.trim() ||
      (typeof adv?.session_id === 'string' && adv.session_id.trim() ? adv.session_id : null);
    if (!nativeSessionId) return { ok: false, code: 'native_session_unresolved',
      message: 'The exact ADV session is open, but its native session id has not been recorded yet.' };
    const bindingInput = { ...input, nativeSessionId };
    const profile = inspectAdv(adv, bindingInput);
    if (!profile.ok) return profile;
    const actualConfinement = await readSessionConfinement(input.reviewerOwnerId, input.workspaceId);
    if (!actualConfinement || stable(actualConfinement) !== stable(input.confinement)) {
      return { ok: false, code: 'confinement_mismatch', message: 'The authoritative reviewer confinement differs from its launch snapshot.' };
    }
    if (input.replacementAttemptId !== undefined) {
      const [row] = await sql<Row[]>`
        UPDATE harness_shared.plan_blind_review_sessions
           SET reviewer_owner_id = ${input.reviewerOwnerId}, adv_session_id = ${input.advSessionId},
              native_session_id = ${nativeSessionId}, account_route = ${profile.accountRoute},
               model_spec = ${profile.modelSpec}, status = 'ready', updated_at = now()
         WHERE id = ${input.replacementAttemptId} AND replacement_of IS NOT NULL
           AND workspace_id = ${input.workspaceId} AND harness_slug = ${input.harnessSlug}
           AND plan_slug = ${input.planSlug} AND activation_audit_seq = ${input.activationAuditSeq}
           AND launch_parent_owner = ${input.launchParentOwner}
           AND confinement_snapshot = ${sql.json(input.confinement as never)}
           AND reviewer_owner_id IS NULL AND status IN ('launching', 'uncertain')
        RETURNING *`;
      const binding = map(row);
      return binding ? { ok: true, created: true, binding }
        : { ok: false, code: 'binding_conflict', message: 'The replacement reservation no longer accepts this exact native receipt.' };
    }
    const [inserted] = await sql<Row[]>`
      INSERT INTO harness_shared.plan_blind_review_sessions
        (workspace_id, harness_slug, plan_slug, activation_audit_seq, reviewer_owner_id,
         adv_session_id, native_session_id, launch_parent_owner, account_route, model_spec, confinement_snapshot)
      VALUES (${input.workspaceId}, ${input.harnessSlug}, ${input.planSlug}, ${input.activationAuditSeq},
              ${input.reviewerOwnerId}, ${input.advSessionId}, ${nativeSessionId},
              ${input.launchParentOwner}, ${profile.accountRoute}, ${profile.modelSpec},
              ${sql.json(input.confinement as never)})
      ON CONFLICT DO NOTHING
      RETURNING *`;
    const created = map(inserted);
    if (created) return { ok: true, created: true, binding: created };
    const existing = await findBlindReviewSessionBinding(input, { sql });
    const expected: BlindReviewSessionBinding = {
      id: existing?.id ?? 0, workspaceId: input.workspaceId, harnessSlug: input.harnessSlug,
      planSlug: input.planSlug, activationAuditSeq: input.activationAuditSeq,
      reviewerOwnerId: input.reviewerOwnerId, advSessionId: input.advSessionId,
      nativeSessionId, launchParentOwner: input.launchParentOwner,
      accountRoute: profile.accountRoute, modelSpec: profile.modelSpec, confinementSnapshot: input.confinement,
      status: existing?.status ?? 'ready', resumeLeaseId: existing?.resumeLeaseId ?? null,
      resumeLeaseExpiresAt: existing?.resumeLeaseExpiresAt ?? null, reviewId: existing?.reviewId ?? null,
    };
    if (existing && sameImmutable(existing, expected)) return { ok: true, created: false, binding: existing };
    return { ok: false, code: 'binding_conflict', message: 'A different reviewer session is already bound to this plan activation.' };
  } catch (error) {
    return { ok: false, code: 'binding_unavailable', message: error instanceof Error ? error.message : String(error) };
  }
}

export async function verifyBlindReviewSessionBinding(binding: BlindReviewSessionBinding, deps: { sql?: Sql } = {}):
  Promise<{ ok: true } | { ok: false; code: 'adv_session_mismatch' | 'launch_profile_mismatch' | 'confinement_mismatch' | 'binding_unavailable'; message: string }> {
  try {
    const sql = deps.sql ?? getOrgPg().sql;
    const profile = inspectAdv(await readAdv(sql, binding.workspaceId, binding.advSessionId), binding);
    if (!profile.ok) return profile;
    if (profile.accountRoute !== binding.accountRoute || profile.modelSpec !== binding.modelSpec) {
      return { ok: false, code: 'launch_profile_mismatch', message: 'The saved ADV launch profile changed.' };
    }
    const current = await readSessionConfinement(binding.reviewerOwnerId, binding.workspaceId);
    if (!current || stable(current) !== stable(binding.confinementSnapshot)) {
      return { ok: false, code: 'confinement_mismatch', message: 'The authoritative reviewer confinement changed.' };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, code: 'binding_unavailable', message: error instanceof Error ? error.message : String(error) };
  }
}

export async function acquireBlindReviewSessionResume(input: {
  workspaceId: string; planSlug: string; activationAuditSeq: number; leaseSec?: number;
}, deps: { sql?: Sql; makeLeaseId?: () => string } = {}):
  Promise<{ ok: true; binding: BlindReviewSessionBinding; leaseId: string } |
    { ok: false; code: 'resume_busy' | 'binding_not_found' | 'binding_unavailable' | 'adv_session_mismatch' | 'launch_profile_mismatch' | 'confinement_mismatch'; message: string }> {
  const sql = deps.sql ?? getOrgPg().sql;
  const leaseId = (deps.makeLeaseId ?? randomUUID)();
  const leaseSec = Math.max(30, Math.min(3600, Math.trunc(input.leaseSec ?? 900)));
  try {
    const [row] = await sql<Row[]>`
      UPDATE harness_shared.plan_blind_review_sessions
         SET status = 'resuming', resume_lease_id = ${leaseId},
             resume_lease_expires_at = now() + (${leaseSec} * interval '1 second'), updated_at = now()
       WHERE workspace_id = ${input.workspaceId} AND plan_slug = ${input.planSlug}
         AND activation_audit_seq = ${input.activationAuditSeq}
         AND id = (SELECT max(id) FROM harness_shared.plan_blind_review_sessions
           WHERE workspace_id = ${input.workspaceId} AND plan_slug = ${input.planSlug}
             AND activation_audit_seq = ${input.activationAuditSeq})
         AND launch_parent_owner = ${BLIND_GAP_REVIEW_ACTOR}
         AND (status = 'ready' OR (status = 'resuming' AND resume_lease_expires_at <= now()))
       RETURNING *`;
    const binding = map(row);
    if (!binding) {
      const existing = await findBlindReviewSessionBinding(input, { sql });
      return existing
        ? { ok: false, code: 'resume_busy', message: 'A recruiter resume is active or this review is no longer resumable.' }
        : { ok: false, code: 'binding_not_found', message: 'No reviewer session is bound to this plan activation.' };
    }
    const verified = await verifyBlindReviewSessionBinding(binding, { sql });
    if (!verified.ok) {
      await releaseBlindReviewSessionResume(binding.id, leaseId, { sql });
      return verified;
    }
    return { ok: true, binding, leaseId };
  } catch (error) {
    return { ok: false, code: 'binding_unavailable', message: error instanceof Error ? error.message : String(error) };
  }
}

export async function releaseBlindReviewSessionResume(bindingId: number, leaseId: string, deps: { sql?: Sql } = {}): Promise<boolean> {
  const sql = deps.sql ?? getOrgPg().sql;
  const rows = await sql<Array<{ id: number | string }>>`
    UPDATE harness_shared.plan_blind_review_sessions
       SET status = 'ready', resume_lease_id = NULL, resume_lease_expires_at = NULL, updated_at = now()
     WHERE id = ${bindingId} AND resume_lease_id = ${leaseId} AND status = 'resuming'
    RETURNING id`;
  return rows.length > 0;
}

export async function recordBlindReviewSessionPost(input: {
  workspaceId: string; planSlug: string; activationAuditSeq: number; reviewerOwnerId: string; reviewId: number;
}, deps: { sql?: Sql } = {}): Promise<boolean> {
  const sql = deps.sql ?? getOrgPg().sql;
  const rows = await sql<Array<{ id: number | string }>>`
    UPDATE harness_shared.plan_blind_review_sessions
       SET status = 'posted', review_id = ${input.reviewId},
           resume_lease_id = NULL, resume_lease_expires_at = NULL, updated_at = now()
     WHERE workspace_id = ${input.workspaceId} AND plan_slug = ${input.planSlug}
       AND activation_audit_seq = ${input.activationAuditSeq}
       AND reviewer_owner_id = ${input.reviewerOwnerId}
       AND launch_parent_owner = ${BLIND_GAP_REVIEW_ACTOR}
       AND (status IN ('ready', 'resuming') OR (status = 'posted' AND review_id = ${input.reviewId}))
    RETURNING id`;
  if (rows.length) {
    // Canonical post commits before resource cleanup takes a lifecycle lock.
    try {
      const { retireRuntimeNamespacesForBinding } = await import('./blind-review-runtime-recovery');
      for (const row of rows) await retireRuntimeNamespacesForBinding({
        workspaceId: input.workspaceId, bindingId: Number(row.id), reason: 'review-posted',
      }, { sql });
    } catch {
      console.warn('[blind-review-runtime] post cleanup pending; canonical post already cuts off authority');
    }
  }
  return rows.length > 0;
}
