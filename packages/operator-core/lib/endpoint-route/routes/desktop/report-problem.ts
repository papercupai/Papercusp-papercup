/**
 * POST /api/desktop/report-problem — the desktop "Report a problem" door
 * (unified-bug-pipeline-and-honest-queue-2026-10-05 P-014, D-048, D-013).
 *
 * Body: { payload, previewDigest }. `payload` is exactly the object the dialog
 * rendered in its Review step (problem-report.ts), and `previewDigest` is
 * sha256 of its canonical JSON. The route:
 *   1. parses with a STRICT schema: an unknown key anywhere is refused (400);
 *   2. recomputes the digest and refuses a mismatch (409 preview-mismatch);
 *   3. refuses a payload `buildProblemReport` would not have produced, such as
 *      unredacted text or an over-long field (422 not-as-previewed);
 *   4. files through the ONE intake (`intakeEndUserReport`, reporterKind
 *      'end-user'), so the P-013 quoting and redaction run again server-side;
 *   5. stores a ticked log excerpt in the consented-attachment store, door
 *      'desktop', idempotent per digest.
 * Response: { routed: 'work-item' | 'memory', id, attachments }.
 *
 * Anonymous: no reporter identity is taken from the request.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { PLATFORM_POT_SLUG } from '../../../platform-pot-slug';
import { contributeUpstream, type ContributeUpstreamResult } from '../../../pot/contribute-upstream';
import { forwardReportAttachment } from '../../../harness/improvements/report-attachment-rpc';
import {
  intakeEndUserReport,
  type EndUserReportInput,
  type EndUserReportResult,
} from '../../../harness/improvements/end-user-intake';
import {
  putReportAttachment,
  type PutReportAttachmentInput,
  type PutReportAttachmentResult,
} from '../../../harness/improvements/report-attachments';
import {
  PROBLEM_REPORT_APP,
  PROBLEM_REPORT_LIMITS as L,
  PROBLEM_REPORT_SCHEMA_VERSION,
  isNormalizedProblemReport,
  decodeProblemScreenshot,
  previewDigest,
  type ProblemReportPayload,
} from '../../../harness/improvements/problem-report';

/** The attachment-store door name for this dialog (D-048 pt 4). */
export const REPORT_PROBLEM_DOOR = 'desktop';

const errorSchema = z
  .object({
    at: z.string().max(40).nullable(),
    source: z.string().max(L.errorSource).nullable(),
    message: z.string().min(1).max(L.errorMessage),
  })
  .strict();

const payloadSchema = z
  .object({
    schemaVersion: z.literal(PROBLEM_REPORT_SCHEMA_VERSION),
    text: z.string().min(1).max(L.text),
    context: z
      .object({
        app: z.literal(PROBLEM_REPORT_APP),
        appVersion: z.string().max(L.appVersion).nullable(),
        screen: z
          .object({
            route: z.string().min(1).max(L.route),
            state: z.record(z.string().max(L.stateKey), z.string().max(L.stateValue)).nullable(),
          })
          .strict()
          .nullable(),
        recentErrors: z.array(errorSchema).max(L.recentErrors),
      })
      .strict(),
    attachments: z
      .array(
        z.union([z
          .object({
            kind: z.literal('log'),
            mime: z.literal('text/plain'),
            lineCount: z.number().int().min(1).max(L.logLines),
            content: z.string().min(1).max(L.logLines * (L.logLine + 1)),
          })
          .strict(), z.object({
            kind: z.literal('screenshot'),
            mime: z.literal('image/png'),
            content: z.string().min(1).max(Math.ceil(L.screenshotBytes / 3) * 4),
          }).strict()]),
      )
      .max(2),
  })
  .strict();

export const reportProblemBodySchema = z
  .object({
    payload: payloadSchema,
    previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

export interface ReportProblemDeps {
  intake: (input: EndUserReportInput) => Promise<EndUserReportResult>;
  /** P-015: production uses the existing contribution core, not a second capture. */
  contribute?: (input: EndUserReportInput) => Promise<ContributeUpstreamResult>;
  putAttachment: (input: PutReportAttachmentInput) => Promise<PutReportAttachmentResult>;
  forwardAttachment?: typeof forwardReportAttachment;
  workspaceId: () => string;
}

export function defaultReportProblemDeps(): ReportProblemDeps {
  return {
    intake: (input) => intakeEndUserReport(input),
    contribute: (input) => contributeUpstream({
      kind: 'report', confirm: true, workspaceId: input.workspaceId,
      report: { text: input.text, title: input.title, reportContext: input.reportContext },
    }),
    putAttachment: (input) => putReportAttachment(input),
    forwardAttachment: (workspaceId, id) => forwardReportAttachment(workspaceId, id),
    workspaceId: activeWorkspaceId,
  };
}

export type ReportProblemAttachmentOutcome =
  | { kind: 'log' | 'screenshot'; ok: true; id: string; deduplicated: boolean; delivery?: 'local-only' | 'upstream-received' }
  | { kind: 'log' | 'screenshot'; ok: false; reason: string };

export type ReportProblemOutcome =
  | {
      status: 200;
      body: { routed: 'work-item' | 'memory'; id: string | null; attachments: ReportProblemAttachmentOutcome[]; delivery?: 'queued-for-federation' };
    }
  | { status: 400 | 409 | 422 | 503; body: { error: string; detail?: unknown } };

function workItemIdOf(result: Extract<EndUserReportResult, { routed: 'work-item' }>): string | null {
  return result.capture.issue?.id ?? result.capture.coalescedOnto?.id ?? null;
}

/** The whole door, minus HTTP. Exported for tests. */
export async function handleReportProblem(
  body: unknown,
  deps: ReportProblemDeps = defaultReportProblemDeps(),
): Promise<ReportProblemOutcome> {
  const parsed = reportProblemBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: 'invalid report', detail: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })) },
    };
  }
  const payload = parsed.data.payload as ProblemReportPayload;
  const digest = await previewDigest(payload);
  if (digest !== parsed.data.previewDigest) {
    return { status: 409, body: { error: 'preview-mismatch', detail: 'the payload differs from the one the preview showed' } };
  }
  if (!isNormalizedProblemReport(payload)) {
    return { status: 422, body: { error: 'not-as-previewed', detail: 'the payload is not what the Report a problem dialog builds' } };
  }

  const workspaceId = deps.workspaceId();
  const { context } = payload;
  const input: EndUserReportInput = {
    text: payload.text,
    workspaceId,
    // A note about the app is kept in the platform Pot's pool, where its bugs go too.
    noteScope: `harness:${PLATFORM_POT_SLUG}`,
    reportContext: {
      app: context.app,
      appVersion: context.appVersion,
      screen: context.screen ? { url: null, route: context.screen.route, state: context.screen.state } : null,
      recentErrors: context.recentErrors,
    },
  };
  let result: EndUserReportResult;
  let delivery: 'queued-for-federation' | undefined;
  if (deps.contribute) {
    // Reached only after strict parsing, exact preview digest and normalization:
    // this Send is the explicit consent consumed by the contribution core.
    const submission = await deps.contribute(input);
    if (!submission.ok || !('queued' in submission || 'localOnly' in submission)) {
      return { status: 503, body: {
        error: 'report-not-submitted',
        detail: !submission.ok ? submission.error : 'needs' in submission ? submission.needs : 'missing local receipt',
      } };
    }
    result = submission.result;
    if ('queued' in submission) delivery = 'queued-for-federation';
  } else {
    result = await deps.intake(input);
  }

  if (result.routed === 'memory') {
    return { status: 200, body: { routed: 'memory', id: result.memoryIds[0] ?? null, attachments: [] } };
  }

  const id = workItemIdOf(result);
  const attachments: ReportProblemAttachmentOutcome[] = [];
  for (const [index, attachment] of payload.attachments.entries()) {
    if (!id) {
      attachments.push({ kind: attachment.kind, ok: false, reason: 'no work item id to attach to' });
      continue;
    }
    // A failed attachment never fails the report: the text is already filed.
    const stored = await deps
      .putAttachment({
        workspaceId,
        workItemId: id,
        door: REPORT_PROBLEM_DOOR,
        kind: attachment.kind,
        mime: attachment.mime,
        content: attachment.kind === 'screenshot' ? decodeProblemScreenshot(attachment.content) : attachment.content,
        externalId: `${digest}:${index}`,
      })
      .catch((err: unknown): PutReportAttachmentResult => ({
        ok: false,
        reason: 'invalid',
        detail: err instanceof Error ? err.message : String(err),
      }));
    const forwarded = stored.ok && delivery && deps.forwardAttachment
      ? await deps.forwardAttachment(workspaceId, stored.id).catch(() => ({ delivered: false })) : null;
    attachments.push(
      stored.ok
        ? { kind: attachment.kind, ok: true, id: stored.id, deduplicated: stored.deduplicated,
          ...(delivery ? { delivery: forwarded?.delivered ? 'upstream-received' as const : 'local-only' as const } : {}) }
        : { kind: attachment.kind, ok: false, reason: `${stored.reason}: ${stored.detail}` },
    );
  }
  return { status: 200, body: { routed: 'work-item', id, attachments, ...(delivery ? { delivery } : {}) } };
}

/** Follow-up stays on the existing report door and reporter-owned source payload. */
export async function answerReportFollowUp(body: unknown) {
  const parsed = z.object({ operation: z.literal('answer-follow-up'), id: z.string().min(1), harness: z.string().min(1),
    questionId: z.string().min(1), text: z.string().trim().min(1).max(4000) }).strict().safeParse(body);
  if (!parsed.success) return { status: 400, body: { error: 'invalid-follow-up' } };
  const [{ getIssue, mergeIssuePayload, healOwnNodeIssueOrigin }, { readReporterStatus }, { redactSensitiveText }, { defaultIntakePromotionDeps }] = await Promise.all([
    import('../../../issues-engineer'), import('../../../harness/improvements/reporter-status'), import('../../../sensitive-text'),
    import('../../../attention/intake-promotion'),
  ]);
  const input = parsed.data;
  return defaultIntakePromotionDeps().withLocks([input.id], async () => {
  // A reporter can answer only the source owned by this install, never a foreign
  // canonical target. The existing payload writer repeats the authorship guard.
  // `origin` records how a row ARRIVED, not who wrote it (WI-10003565): heal our own
  // report stranded at origin='remote' first, or its reporter could never answer it.
  let source = await getIssue(input.id);
  if (source?.origin === 'remote' && await healOwnNodeIssueOrigin(input.id)) source = await getIssue(input.id);
  if (!source || source.origin !== 'local' || source.scope !== `harness:${input.harness}`) {
    return { status: 404, body: { error: 'report-not-owned-by-install' } };
  }
  const status = await readReporterStatus({ id: input.id, harness: input.harness });
  if (!status?.followUp || status.followUp.question.id !== input.questionId) return { status: 409, body: { error: 'question-not-current' } };
  if (status.followUp.answer) return { status: 409, body: { error: 'question-already-answered' } };
  const text = redactSensitiveText(input.text);
  // Preview IS payload: require the caller to display the redacted text first.
  if (text !== input.text) return { status: 400, body: { error: 'answer-needs-redacted-preview' } };
  const stored = await mergeIssuePayload(input.id, { reporterAnswer: { questionId: input.questionId, text, answeredAt: new Date().toISOString() } }, { harnessSlug: input.harness });
  return stored ? { status: 200, body: { ok: true } } : { status: 409, body: { error: 'report-no-longer-writable' } };
  });
}

const post = defineTool({
  method: 'POST',
  path: '/desktop/report-problem',
  auth: {},
  async handler(req) {
    const body = await req.json().catch(() => null);
    if (body?.operation === 'answer-follow-up') {
      const outcome = await answerReportFollowUp(body);
      return Response.json(outcome.body, { status: outcome.status });
    }
    const outcome = await handleReportProblem(body);
    return Response.json(outcome.body, { status: outcome.status });
  },
});

export default post;
