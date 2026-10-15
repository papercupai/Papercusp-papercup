/** Adapt existing persisted verdicts/cards to the same immutable publisher. */
import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { canonicalJson } from '@papercusp/hash-chain';
import type { ReportBlock } from '@papercusp/chat-protocol';
import type { ReportKind, ReportSubject } from './report-library';
import { listReports, ReportRequestConflictError } from './report-library';
import { publishReportWithEffects } from './report-publication';
import { reportsLibraryDisabled } from './agent-tools/reports/_shared';

interface CaptureOrigin {
  workspaceId: string;
  ownerId: string;
  harnessSlug?: string | null;
  sessionRef?: string | null;
}

// Only the generated final JSON block may vary in member order when a
// persisted verdict is rehydrated. Prose and the exact source citation remain
// byte identities; this never loosens the ordinary immutable publisher.
function structuredCaptureIdentity(bodyMd: string, ref: string): string | null {
  const opening = '\n```json\n';
  const closing = `\n\`\`\`\n\nSource reference: ${ref}\n`;
  const start = bodyMd.lastIndexOf(opening);
  if (start < 0 || !bodyMd.endsWith(closing)) return null;
  try {
    return bodyMd.slice(0, start + opening.length)
      + canonicalJson(JSON.parse(bodyMd.slice(start + opening.length, -closing.length))) + closing;
  } catch { return null; }
}

async function capture(origin: CaptureOrigin, source: string, ref: string, title: string,
  bodyMd: string, kind: ReportKind, subject: ReportSubject = { kind: 'none' }) {
  if (!origin.workspaceId || origin.workspaceId === '*' || !origin.ownerId || await reportsLibraryDisabled()) return null;
  try {
    const sql = getOrgPg().sql;
    const input = {
      workspaceId: origin.workspaceId, title, bodyMd: `${bodyMd}\n\nSource reference: ${ref}\n`, kind,
      subject, source: `capture:${source}`, visibility: 'owner', tags: [`capture:${source}`],
      requestKey: `capture:${source}:${createHash('sha256').update(ref).digest('hex')}`,
    } as const;
    const stamped = { authorOwnerId: origin.ownerId, harnessSlug: origin.harnessSlug,
      authorSessionRef: origin.sessionRef ?? ref };
    // `input` is `as const`, so without the annotation the default would narrow
    // this parameter to input.bodyMd's template-literal type and refuse the
    // stored historical body passed on the conflict-retry path below.
    const publish = (storedBody: string = input.bodyMd) => publishReportWithEffects(sql,
      { ...input, bodyMd: storedBody, tags: [...input.tags] }, stamped, message => console.warn(message));
    let result;
    try { result = await publish(); }
    catch (error) {
      if (!(error instanceof ReportRequestConflictError) || !['acceptance', 'audit'].includes(source)) throw error;
      const [saved] = await sql<Array<{ body_md: string }>>`
        SELECT body_md FROM harness_shared.report_library
        WHERE workspace_id = ${origin.workspaceId} AND author_owner_id = ${origin.ownerId}
          AND COALESCE(request_scope, 'author:' || COALESCE(author_owner_id, '')) = ${`author:${origin.ownerId}`}
          AND request_key = ${input.requestKey} AND source = ${input.source}`;
      const identity = structuredCaptureIdentity(input.bodyMd, ref);
      if (!saved || identity === null || structuredCaptureIdentity(saved.body_md, ref) !== identity) throw error;
      // Keep the historical bytes and citation. The publisher still verifies
      // title, subject, visibility, source, tags and origin on this retry.
      result = await publish(saved.body_md);
    }
    const { report } = result;
    return report.reportId;
  } catch (error) {
    // The original card/verdict already exists. Preserve its control-plane
    // success and file a source-addressable failure for retry instead of losing it.
    const { captureImprovement } = await import('./harness/improvements/capture-core');
    await captureImprovement({ title: 'Reports automatic capture failed', kind: 'bug',
      body: `Capture ${source} failed for ${ref}: ${String(error)}. The source remains persisted; retry the adapter with this exact source reference.`,
      createdBy: origin.ownerId, filedByRole: 'su',
    });
    return null;
  }
}

export async function captureCoordReport(options: CaptureOrigin & { msgId: string; summary: string; report: ReportBlock }) {
  // A GOAL reference already points at a published exact snapshot; retain that
  // citation instead of manufacturing a second report from its notification.
  if (options.report.goalReport) return options.report.goalReport.reportId;
  const lines = options.report.plans.flatMap(plan => [
    `## ${plan.title}${plan.status ? ` (${plan.status})` : ''}`,
    ...(plan.summary ? [plan.summary] : []),
    ...(plan.items ?? []).map(item => `- ${item.id ? `${item.id}: ` : ''}${item.text}${item.status ? ` (${item.status})` : ''}${item.ref ? ` — ${item.ref}` : ''}`), '',
  ]);
  const plan = options.report.plans.length === 1 ? options.report.plans[0] : undefined;
  return capture(options, 'coord', options.msgId, options.report.title || options.summary,
    lines.join('\n'), 'status-digest', plan?.slug ? { kind: 'plan', ref: plan.slug, label: plan.title } : { kind: 'none' });
}

export async function captureAcceptanceVerdict(options: CaptureOrigin & {
  issueId: string; rubricRef: string; title: string; planSlug?: string | null;
  body?: string; ratings: unknown; acceptance?: unknown;
}) {
  const body = [options.body || '', `Rubric: ${options.rubricRef}`, '```json',
    JSON.stringify({ ratings: options.ratings, acceptance: options.acceptance ?? null }, null, 2), '```'].join('\n');
  return capture(options, 'acceptance', options.issueId, options.title, body, 'review',
    options.planSlug ? { kind: 'plan', ref: options.planSlug } : { kind: 'none' });
}

export async function captureAuditCompletion(options: CaptureOrigin & {
  itemId: string; completionRef?: string | null; title: string; completion: { summary: string };
}) {
  // Public dispatch correctly refuses terminal subject mutations during AUDIT.
  // Delivery precedes its standalone exit, then completion records the result.
  // Identify that audit from durable publication rather than a mode row already
  // cleared by the required exit. Never infer it from a title or caller origin.
  if (!options.workspaceId || options.workspaceId === '*' || !options.ownerId || await reportsLibraryDisabled()) return null;
  const audits = await listReports(getOrgPg().sql, {
    workspaceId: options.workspaceId, viewer: { ownerId: options.ownerId },
    kind: 'audit', subject: { kind: 'work_item', ref: options.itemId },
    originOwnerId: options.ownerId, originHarnessSlug: options.harnessSlug ?? undefined,
    source: 'agent', limit: 1,
  });
  if (!audits.length) return null;
  return capture(options, 'audit', options.completionRef ?? options.itemId, options.title,
    `${options.completion.summary}\n\n\`\`\`json\n${JSON.stringify(options.completion, null, 2)}\n\`\`\``,
    'audit', { kind: 'work_item', ref: options.itemId });
}
