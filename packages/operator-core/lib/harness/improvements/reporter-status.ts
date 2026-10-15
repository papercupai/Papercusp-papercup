/** P-016: reporter-facing interpretation of the existing work-item lifecycle. */
import { deriveWorkItemPresentationStage, type WorkItemPresentationInput } from './agent-review-policy';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { randomUUID } from 'node:crypto';
import { redactSensitiveText } from '../../sensitive-text';
import { isPersonReporterKind } from './provenance';

export type ReporterStatus = 'received' | 'being-verified' | 'awaiting-fix' | 'being-fixed' | 'awaiting-release' | 'fixed' | 'closed';
export interface ReporterReleaseReceipt {
  schemaVersion: 'reporter-release-v1';
  version: string;
  channel: string;
  publishedAt: string;
  artifactCommit: string;
  completionRef: string;
  /** Server-checked fix identities, not a caller's inclusion assertion. */
  contentIdentity: Array<{ path: string; blobSha: string }>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readReporterRelease(payload: unknown): ReporterReleaseReceipt | null {
  const value = record(record(payload).reporterRelease);
  const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
  if (value.schemaVersion !== 'reporter-release-v1' || typeof value.version !== 'string' || !value.version.trim()
    || typeof value.channel !== 'string' || !value.channel.trim()
    || typeof value.publishedAt !== 'string' || !Number.isFinite(Date.parse(value.publishedAt))
    || typeof value.artifactCommit !== 'string' || !sha.test(value.artifactCommit)
    || typeof value.completionRef !== 'string' || !value.completionRef
    || !Array.isArray(value.contentIdentity) || value.contentIdentity.length === 0
    || value.contentIdentity.some((entry) => {
      const row = record(entry);
      return typeof row.path !== 'string' || !row.path || typeof row.blobSha !== 'string' || !sha.test(row.blobSha);
    })) return null;
  return value as unknown as ReporterReleaseReceipt;
}

export interface ReporterStatusInput extends WorkItemPresentationInput {
  /** Existing investigation task state, read by the scoped report reader. */
  verificationActive?: boolean;
}

export function deriveReporterStatus(input: ReporterStatusInput): {
  status: ReporterStatus;
  label: string;
  release: ReporterReleaseReceipt | null;
} {
  const stage = deriveWorkItemPresentationStage(input).stage;
  const release = readReporterRelease(input.payload);
  // A reopened item or replaced completion invalidates an old publication receipt.
  if (stage === 'verified-completion' && release && release.completionRef === input.terminalCompletionRef) {
    return { status: 'fixed', label: `Fixed in v${release.version}`, release };
  }
  if (stage === 'verified-completion') return { status: 'awaiting-release', label: 'Fix verified; awaiting release', release: null };
  if (stage === 'terminal-other') return { status: 'closed', label: 'Closed without a verified released fix', release: null };
  if (stage === 'accepted-active') return { status: 'being-fixed', label: 'Being fixed', release: null };
  if (stage === 'accepted-ready' || stage === 'accepted-blocked') return { status: 'awaiting-fix', label: 'Verified; awaiting fix', release: null };
  if (input.verificationActive) return { status: 'being-verified', label: 'Being verified', release: null };
  return { status: 'received', label: 'Received', release: null };
}

/** One question from the fixer, one answer from the install owning the source. */
export interface ReporterFollowUp {
  question: { id: string; text: string; askedBy: string; askedAt: string };
  answer?: { questionId: string; text: string; answeredAt: string };
}

export function readReporterFollowUp(canonicalPayload: unknown, sourcePayload: unknown): ReporterFollowUp | null {
  const question = record(record(canonicalPayload).reporterQuestion);
  const answer = record(record(sourcePayload).reporterAnswer);
  if (typeof question.id !== 'string' || !question.id || typeof question.text !== 'string' || !question.text.trim()
    || typeof question.askedBy !== 'string' || !question.askedBy || typeof question.askedAt !== 'string'
    || !Number.isFinite(Date.parse(question.askedAt))) return null;
  const out: ReporterFollowUp = { question: question as unknown as ReporterFollowUp['question'] };
  if (answer.questionId === question.id && typeof answer.text === 'string' && answer.text.trim()
    && typeof answer.answeredAt === 'string' && Number.isFinite(Date.parse(answer.answeredAt))) {
    out.answer = answer as unknown as NonNullable<ReporterFollowUp['answer']>;
  }
  return out;
}

export interface ReporterStatusView {
  sourceId: string;
  canonicalId: string | null;
  status: ReporterStatus;
  label: string;
  release: ReporterReleaseReceipt | null;
  followUp: ReporterFollowUp | null;
}

export async function readReporterStatus(input: { id: string; harness: string; workspaceId?: string }, sql = getOrgPg().sql): Promise<ReporterStatusView | null> {
  const workspaceId = input.workspaceId ?? activeWorkspaceId();
  const sources = await sql<{ payload: unknown }[]>`
    SELECT payload FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${input.harness} AND feature_id = ${input.id}`;
  const source = sources[0];
  if (!source || !isPersonReporterKind(record(record(source.payload).reporter).kind)) return null;
  const promotedFrom = record(record(source.payload).intakeSource);
  if (promotedFrom.mode === 'distinct' && promotedFrom.id !== input.id) return null;
  const targets = await sql<Array<{
    feature_id: string; item_kind: string; status: string; payload: unknown; title: string; summary: string;
    taken_by: string | null; authority: string | null; terminal_completion_ref: string | null; admission: string | null;
  }>>`
    SELECT feature_id, item_kind, status, payload, title, summary, taken_by, authority, terminal_completion_ref, admission
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${input.harness}
       AND (feature_id = ${input.id} OR (
         payload -> 'intakeSource' ->> 'mode' = 'distinct' AND payload -> 'intakeSource' ->> 'id' = ${input.id}))
       AND item_kind <> 'task'
     ORDER BY (feature_id <> ${input.id}) DESC, created_ts DESC
     LIMIT 3`;
  const distinct = targets.filter((row) => row.feature_id !== input.id && !['dropped', 'closed'].includes(row.status));
  if (distinct.length > 1) return { sourceId: input.id, canonicalId: null, status: 'received' as const, label: 'Received; fix mapping unconfirmed', release: null, followUp: null };
  const target = distinct[0] ?? targets.find((row) => row.feature_id === input.id);
  if (!target) return null;
  const tasks = await sql<{ active: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${input.harness}
         AND payload -> 'verification' ->> 'subject' IN (${input.id}, ${target.feature_id})
         AND status IN ('open', 'wip', 'in_progress', 'active', 'running')
         AND taken_by IS NOT NULL) AS active`;
  return {
    sourceId: input.id, canonicalId: target.feature_id,
    ...deriveReporterStatus({ kind: target.item_kind, status: target.status, title: target.title, summary: target.summary,
      payload: target.payload, assignee: target.taken_by, completionAuthority: target.authority,
      terminalCompletionRef: target.terminal_completion_ref, admission: target.admission, verificationActive: tasks[0]?.active === true }),
    followUp: readReporterFollowUp(target.payload, source.payload),
  };
}

/** Purpose-shaped case on work_items:update: only the current fixer asks once. */
export async function askReporterQuestion(input: { id: string; harness?: string; actor: string; text: string }) {
  const [{ getWorkItem, mergeWorkItemPayload }, { defaultIntakePromotionDeps }, { healOwnNodeIssueOrigin }] = await Promise.all([
    import('../../work-items'), import('../../attention/intake-promotion'), import('../../issues-engineer'),
  ]);
  const text = redactSensitiveText(input.text.trim());
  if (!text || text.length > 4000) return { ok: false as const, id: input.id, error: 'question-must-be-1-to-4000-characters' };
  return defaultIntakePromotionDeps().withLocks([input.id], async () => {
    // `origin` records how a row ARRIVED, not who wrote it (WI-10003565): heal our own
    // item stranded at origin='remote' before the local-only check refuses its fixer.
    let item = await getWorkItem(input.id, input.harness);
    if (item?.origin === 'remote' && await healOwnNodeIssueOrigin(input.id, input.harness)) {
      item = await getWorkItem(input.id, input.harness);
    }
    if (!item || item.origin !== 'local' || item.assignee !== input.actor || !isPersonReporterKind(objectReporterKind(item.payload))) {
      return { ok: false as const, id: input.id, error: 'only-current-fixer-may-ask-reporter' };
    }
    const existing = record(record(item.payload).reporterQuestion);
    if (typeof existing.id === 'string') {
      return existing.text === text && existing.askedBy === input.actor
        ? { ok: true as const, id: input.id, item }
        : { ok: false as const, id: input.id, error: 'report-already-has-follow-up-question' };
    }
    const merged = await mergeWorkItemPayload(input.id, { reporterQuestion: { id: randomUUID(), text, askedBy: input.actor, askedAt: new Date().toISOString() } }, { harness: input.harness });
    return merged ? { ok: true as const, id: input.id, item: merged } : { ok: false as const, id: input.id, error: 'report-no-longer-writable' };
  });
}

function objectReporterKind(payload: unknown): unknown { return record(record(payload).reporter).kind; }
