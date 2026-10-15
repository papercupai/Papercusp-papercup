import type { Sql } from 'postgres';
import { z } from 'zod';
import { CLOUD_TUTORIAL_ID, CLOUD_TUTORIAL_VERSION, sameTutorialScope, type SavedTutorialProgress, type TutorialScope, type TutorialVersion } from './cloud-tutorial-lesson';
import { PRODUCT_TUTORIAL_VERSION, productTutorialLessonIds } from './product-tutorial-lesson';
export { PRODUCT_TUTORIAL_VERSION } from './product-tutorial-lesson';

const receipt = z.object({ sessionId: z.string().min(1).max(160), taskId: z.string().min(1).max(160), resultId: z.string().min(1).max(160) }).strict();
export const tutorialProgressUpdateSchema = z.object({
  /** A consistency check against the verified principal, never authority. */
  expectedScope: z.object({ tenantId: z.string().min(1).max(256), userId: z.string().min(1).max(256), workspaceId: z.string().min(1).max(256) }).strict(),
  expectedRevision: z.number().int().nonnegative().safe(),
  mutationId: z.string().min(1).max(120).regex(/^[a-zA-Z0-9._:-]+$/),
  disposition: z.enum(['active', 'paused', 'skipped', 'closed']),
  inspectedResult: receipt.optional(),
  version: z.union([z.literal(1), z.literal(2)]).optional(),
  inspectedRevision: receipt.optional(), inspectedPractice: receipt.optional(),
}).strict();
export type TutorialProgressUpdate = z.infer<typeof tutorialProgressUpdateSchema>;
export interface TutorialProgressRecord { revision: number; mutationId: string | null; progress: SavedTutorialProgress }
export class TutorialProgressConflict extends Error {
  constructor(readonly current: TutorialProgressRecord) { super('tutorial_progress_conflict'); }
}
function progressKey(scope: TutorialScope, version: TutorialVersion): string {
  return JSON.stringify([scope.workspaceId, CLOUD_TUTORIAL_ID, version]);
}
function empty(scope: TutorialScope, version: TutorialVersion): TutorialProgressRecord {
  return { revision: 0, mutationId: null, progress: { scope, lessonId: CLOUD_TUTORIAL_ID, version, disposition: 'active' } };
}
function assertLockTransaction(tx: Sql, lock: boolean | undefined): void {
  // A pool's FOR UPDATE commits before returning; its lock cannot protect
  // the subsequent voice reservation. Match the hosted identity readers.
  if (lock && typeof (tx as { begin?: unknown }).begin === 'function') {
    throw new Error('tutorial_lock_requires_transaction');
  }
}
/** Never use the ambient workspace or an admin connection. A verified hosted
 * tenant transaction supplies these GUCs and the hosted_app RLS role. */
async function assertTransactionScope(tx: Sql, scope: TutorialScope): Promise<void> {
  const [binding] = await tx<{ organization: string; user: string; workspace: string }[]>`
    SELECT current_setting('app.organization_id', true) AS organization,
           current_setting('app.user_id', true) AS "user",
           current_setting('app.workspace_id', true) AS workspace`;
  if (!binding || binding.organization !== scope.tenantId || binding.user !== scope.userId || binding.workspace !== scope.workspaceId) throw new Error('tutorial_scope_mismatch');
}
function decode(scope: TutorialScope, value: unknown, version: TutorialVersion): TutorialProgressRecord {
  if (value === undefined || value === null) return empty(scope, version);
  const schema = z.object({ revision: z.number().int().positive().safe(), mutationId: z.string(), progress: z.object({
    lessonId: z.literal(CLOUD_TUTORIAL_ID), version: z.literal(version),
    scope: z.object({ tenantId: z.literal(scope.tenantId), userId: z.literal(scope.userId), workspaceId: z.literal(scope.workspaceId) }).strict(),
    disposition: tutorialProgressUpdateSchema.shape.disposition, inspectedResult: receipt.optional(),
    // Version 1 must not carry the version-2 receipts. A conditional spread here infers
    // those keys as `unknown`; an optional never keeps the field typed and still rejects it.
    inspectedRevision: version === 2 ? receipt.optional() : z.never().optional(),
    inspectedPractice: version === 2 ? receipt.optional() : z.never().optional(),
  }).strict() }).strict();
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('tutorial_progress_invalid');
  return parsed.data;
}
export async function readTutorialProgress(tx: Sql, scope: TutorialScope, version: TutorialVersion = CLOUD_TUTORIAL_VERSION, options: { lock?: boolean; requirePersisted?: boolean } = {}): Promise<TutorialProgressRecord> {
  assertLockTransaction(tx, options.lock);
  await assertTransactionScope(tx, scope);
  const [row] = await tx<{ record: unknown }[]>`
    SELECT profile #> ARRAY['cloudTutorial', ${progressKey(scope, version)}]::text[] AS record
    FROM papercusp_auth.hosted_user_preferences
    WHERE organization_id = ${scope.tenantId}::uuid AND user_id = ${scope.userId}::uuid
    ${options.lock ? tx`FOR UPDATE` : tx``}`;
  // Legacy UI reads may offer an implicit guide. Paid admission must prove
  // enrollment in this exact workspace and version from a persisted record.
  if (options.requirePersisted && row?.record == null) throw new Error('tutorial_not_enrolled');
  return decode(scope, row?.record, version);
}
/** Caller must hold the surrounding tenant transaction: the row lock makes
 * CAS atomic across tabs and preserves unrelated profile keys/workspaces. */
export async function updateTutorialProgress(tx: Sql, scope: TutorialScope, input: TutorialProgressUpdate): Promise<TutorialProgressRecord> {
  const patch = tutorialProgressUpdateSchema.parse(input);
  const version = patch.version ?? CLOUD_TUTORIAL_VERSION;
  if (version === 1 && (patch.inspectedRevision || patch.inspectedPractice)) throw new Error('tutorial_version_mismatch');
  if (!sameTutorialScope(scope, patch.expectedScope)) throw new Error('tutorial_scope_changed');
  await assertTransactionScope(tx, scope);
  await tx`INSERT INTO papercusp_auth.hosted_user_preferences (organization_id, user_id)
    VALUES (${scope.tenantId}::uuid, ${scope.userId}::uuid) ON CONFLICT (organization_id, user_id) DO NOTHING`;
  const [row] = await tx<{ profile: Record<string, unknown> }[]>`
    SELECT profile FROM papercusp_auth.hosted_user_preferences
    WHERE organization_id = ${scope.tenantId}::uuid AND user_id = ${scope.userId}::uuid FOR UPDATE`;
  if (!row) throw new Error('tutorial_progress_denied');
  const blob = row.profile.cloudTutorial ?? {};
  if (typeof blob !== 'object' || blob === null || Array.isArray(blob)) throw new Error('tutorial_progress_invalid');
  const records = blob as Record<string, unknown>;
  const key = progressKey(scope, version);
  const current = decode(scope, records[key], version);
  if (current.mutationId === patch.mutationId) {
    // An idempotency key cannot be reused for a different write.
    if (current.progress.disposition !== patch.disposition || ['inspectedResult', 'inspectedRevision', 'inspectedPractice'].some(key => JSON.stringify(current.progress[key as keyof SavedTutorialProgress] ?? null) !== JSON.stringify(patch[key as keyof TutorialProgressUpdate] ?? null))) throw new Error('tutorial_mutation_reused');
    return current;
  }
  if (current.revision !== patch.expectedRevision) throw new TutorialProgressConflict(current);
  if (current.revision >= Number.MAX_SAFE_INTEGER) throw new Error('tutorial_revision_exhausted');
  const next: TutorialProgressRecord = { revision: current.revision + 1, mutationId: patch.mutationId,
    progress: { scope, lessonId: CLOUD_TUTORIAL_ID, version, disposition: patch.disposition,
      ...(patch.inspectedResult ? { inspectedResult: patch.inspectedResult } : {}),
      ...(version === 2 ? { inspectedRevision: patch.inspectedRevision, inspectedPractice: patch.inspectedPractice } : {}) } };
  await tx`UPDATE papercusp_auth.hosted_user_preferences
    SET profile = jsonb_set(profile, '{cloudTutorial}', COALESCE(profile->'cloudTutorial', '{}'::jsonb) || ${JSON.stringify({ [key]: next })}::jsonb), updated_at = now()
    WHERE organization_id = ${scope.tenantId}::uuid AND user_id = ${scope.userId}::uuid`;
  return next;
}

/** Orientation is account/organization scoped. It reuses the preference row
 * and its lock; Cloud task receipts keep their existing workspace scope. */
export interface AccountTutorialScope { tenantId: string; userId: string }
const accountScopeSchema = z.object({ tenantId: z.string().min(1).max(256), userId: z.string().min(1).max(256) }).strict();
const lessonKey = z.string().min(1).max(120).regex(/^[a-z0-9-]+$/).refine(id => productTutorialLessonIds.has(id));
export const accountTutorialProgressUpdateSchema = z.object({
  expectedScope: accountScopeSchema,
  expectedRevision: z.number().int().nonnegative().safe(),
  mutationId: z.string().min(1).max(120).regex(/^[a-zA-Z0-9._:-]+$/),
  version: z.literal(PRODUCT_TUTORIAL_VERSION),
  disposition: tutorialProgressUpdateSchema.shape.disposition,
  currentLessonId: lessonKey,
  // These are explanations reviewed, never domain work completed.
  reviewedLessonIds: z.array(lessonKey).max(100).refine(ids => new Set(ids).size === ids.length),
  restart: z.literal(true).optional(),
}).strict().refine(patch => !patch.restart || (patch.disposition === 'active' && patch.currentLessonId === 'welcome' && patch.reviewedLessonIds.length === 0), 'A restarted guide must begin at Welcome');
export type AccountTutorialProgressUpdate = z.infer<typeof accountTutorialProgressUpdateSchema>;
export interface AccountTutorialProgressRecord {
  scope: AccountTutorialScope; version: typeof PRODUCT_TUTORIAL_VERSION;
  revision: number; mutationId: string | null;
  disposition: AccountTutorialProgressUpdate['disposition'];
  currentLessonId: string; reviewedLessonIds: string[];
}
export class AccountTutorialProgressConflict extends Error {
  constructor(readonly current: AccountTutorialProgressRecord) { super('tutorial_progress_conflict'); }
}
function decodeAccountProgress(scope: AccountTutorialScope, value: unknown): AccountTutorialProgressRecord | null {
  if (value == null) return null; // A returning account is not a new signup.
  const parsed = z.object({
    scope: z.object({ tenantId: z.literal(scope.tenantId), userId: z.literal(scope.userId) }).strict(),
    version: z.literal(PRODUCT_TUTORIAL_VERSION), revision: z.number().int().nonnegative().safe(),
    mutationId: accountTutorialProgressUpdateSchema.shape.mutationId.nullable(),
    disposition: accountTutorialProgressUpdateSchema.shape.disposition,
    currentLessonId: lessonKey, reviewedLessonIds: accountTutorialProgressUpdateSchema.shape.reviewedLessonIds,
  }).strict().safeParse(value);
  if (!parsed.success) throw new Error('tutorial_progress_invalid');
  return parsed.data;
}
async function assertAccountTransactionScope(tx: Sql, scope: AccountTutorialScope): Promise<void> {
  const [binding] = await tx<{ organization: string; user: string }[]>`
    SELECT current_setting('app.organization_id', true) AS organization,
           current_setting('app.user_id', true) AS "user"`;
  if (!binding || binding.organization !== scope.tenantId || binding.user !== scope.userId) throw new Error('tutorial_scope_mismatch');
}
/** Admission calls this inside the same transaction that creates membership
 * and session. Replays never overwrite a user's paused/completed orientation. */
export async function enrollAccountTutorial(tx: Sql, scope: AccountTutorialScope): Promise<void> {
  accountScopeSchema.parse(scope);
  const record: AccountTutorialProgressRecord = { scope, version: PRODUCT_TUTORIAL_VERSION,
    revision: 0, mutationId: null, disposition: 'active', currentLessonId: 'welcome', reviewedLessonIds: [] };
  const blob = JSON.stringify({ [PRODUCT_TUTORIAL_VERSION]: record });
  await tx`INSERT INTO papercusp_auth.hosted_user_preferences (organization_id, user_id, profile)
    VALUES (${scope.tenantId}::uuid, ${scope.userId}::uuid, jsonb_build_object('productTutorial', ${blob}::jsonb))
    ON CONFLICT (organization_id, user_id) DO UPDATE
      SET profile = jsonb_set(papercusp_auth.hosted_user_preferences.profile, '{productTutorial}',
        COALESCE(papercusp_auth.hosted_user_preferences.profile->'productTutorial', '{}'::jsonb) || ${blob}::jsonb), updated_at = now()
      WHERE papercusp_auth.hosted_user_preferences.profile #> ARRAY['productTutorial', ${String(PRODUCT_TUTORIAL_VERSION)}]::text[] IS NULL`;
}
/** Admission may lock an existing preference row through commit. Missing rows
 * remain unenrolled; this read never creates paid-voice authority. */
export async function readAccountTutorialProgress(tx: Sql, scope: AccountTutorialScope, options: { lock?: boolean } = {}): Promise<AccountTutorialProgressRecord | null> {
  assertLockTransaction(tx, options.lock);
  await assertAccountTransactionScope(tx, scope);
  const [row] = await tx<{ record: unknown }[]>`
    SELECT profile #> ARRAY['productTutorial', ${String(PRODUCT_TUTORIAL_VERSION)}]::text[] AS record
    FROM papercusp_auth.hosted_user_preferences
    WHERE organization_id = ${scope.tenantId}::uuid AND user_id = ${scope.userId}::uuid
    ${options.lock ? tx`FOR UPDATE` : tx``}`;
  return decodeAccountProgress(scope, row?.record);
}
export async function updateAccountTutorialProgress(tx: Sql, scope: AccountTutorialScope, input: AccountTutorialProgressUpdate): Promise<AccountTutorialProgressRecord> {
  const patch = accountTutorialProgressUpdateSchema.parse(input);
  if (scope.tenantId !== patch.expectedScope.tenantId || scope.userId !== patch.expectedScope.userId) throw new Error('tutorial_scope_changed');
  await assertAccountTransactionScope(tx, scope);
  // Enrollment is explicit here. Ordinary reads still leave returning accounts
  // alone, and the admission upsert never overwrites an existing guide.
  if (patch.restart) await enrollAccountTutorial(tx, scope);
  const [row] = await tx<{ record: unknown }[]>`
    SELECT profile #> ARRAY['productTutorial', ${String(PRODUCT_TUTORIAL_VERSION)}]::text[] AS record
    FROM papercusp_auth.hosted_user_preferences
    WHERE organization_id = ${scope.tenantId}::uuid AND user_id = ${scope.userId}::uuid FOR UPDATE`;
  const current = decodeAccountProgress(scope, row?.record);
  if (!current) throw new Error('tutorial_not_enrolled');
  if (current.mutationId === patch.mutationId) {
    if (current.disposition !== patch.disposition || current.currentLessonId !== patch.currentLessonId ||
      JSON.stringify(current.reviewedLessonIds) !== JSON.stringify(patch.reviewedLessonIds)) throw new Error('tutorial_mutation_reused');
    return current;
  }
  if (current.revision !== patch.expectedRevision) throw new AccountTutorialProgressConflict(current);
  if (current.revision >= Number.MAX_SAFE_INTEGER) throw new Error('tutorial_revision_exhausted');
  const next: AccountTutorialProgressRecord = { scope, version: PRODUCT_TUTORIAL_VERSION,
    revision: current.revision + 1, mutationId: patch.mutationId, disposition: patch.disposition,
    currentLessonId: patch.currentLessonId, reviewedLessonIds: patch.reviewedLessonIds };
  await tx`UPDATE papercusp_auth.hosted_user_preferences
    SET profile = jsonb_set(profile, ARRAY['productTutorial', ${String(PRODUCT_TUTORIAL_VERSION)}]::text[], ${JSON.stringify(next)}::jsonb), updated_at = now()
    WHERE organization_id = ${scope.tenantId}::uuid AND user_id = ${scope.userId}::uuid`;
  return next;
}
