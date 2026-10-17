/**
 * reports:publish — publish a report into the owner-facing Reports library
 * (plan reports-library-2026-09-15, P-003; satisfies R-1, R-2, R-3).
 *
 * The write path's three load-bearing properties:
 *   * ORIGIN IS NOT AN ARGUMENT. The args schema has no author/pot/session field;
 *     `stampOrigin(ctx)` is the only producer, so a caller payload structurally
 *     cannot forge provenance (R-2).
 *   * AN OVER-CAP BODY IS REFUSED WITH ITS OVERAGE, never stored truncated (R-1) —
 *     a reader cannot tell a truncated audit from one that simply ended.
 *   * A REDONE REPORT PUBLISHES A NEW ROW carrying `supersedes`, inheriting its
 *     predecessor's lineage; nothing is edited in place (R-3).
 *
 * Server-only.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { publishReportWithEffects } from '../../report-publication';
import { readActiveOperationWorkerClaimBinding, matchOperationWorkerClaim } from '../../blueprint/operation-worker-binding';
import { getWorkItem } from '../../work-items';
import {
  reportsLibraryDisabled,
  resolveWorkspaceId,
  stampOrigin,
  toRefusal,
  toReportWire,
  zReportKind,
  zReportWire,
  zReportSubject,
  zReportVisibility,
  zGoalOwnerReportSnapshot,
} from './_shared';

export default defineTool({
  name: 'reports:publish',
  description:
    'Publish a finished owner-facing Markdown report (audit, review, analysis, postmortem, status digest, proposal) to the Reports library. The server stamps author, pot, and session. Over-cap bodies are refused, not truncated; corrections use `supersedes` and preserve the prior body. Returns a stable `report_id` and UI path. After publish, call `reports:get { id: report_id }` (or pass the receipt value as `report_id`) and verify the complete body and visibility. Cite a descriptive Markdown link to the GUI report page, using the returned same-origin path directly as its Markdown target. Use an absolute HTTP(S) URL only when a verified GUI origin is available; never guess or ask the owner for an origin solely to format the link.',
  guidance: {
    when: 'For completed audits, reviews, analyses, postmortems, status digests, or proposals.',
    notWhen:
      'Use `work_items:checkpoint` for in-flight state, `facts:assert` for standing conclusions, `plans:add-decision` for cross-lane rulings, `coord:send` for agent messages, and `docs:author` for reusable procedures.',
    chaining:
      // The link rules live once, in `description`; this carries the sequence (prompt-weight cap).
      'reports:publish → reports:get { id: report_id } → verify. Claim saved or delivered only after readback succeeds. Corrections: read the original, publish with `supersedes`, then new report_id → verify the correction → cite it. The Papercusp/Tauri Reports reader route is `/reports?sel=<report_id>`; never cite a bare id. Link procedures via `docs:author`/`docs:get`, not private incident details.',
    returns:
      '{ ok:true, report_id, workspace_id, title, summary, kind, subject, origin, visibility, ' +
      'supersedes_report_id, lineage_id, source, tags, published_at, updated_at, retired_at, path, ' +
      'body_bytes, event_emitted }. Refusals are structured { ok:false, error, message }: ' +
      '`body_too_large` also carries { bytes, limitBytes, overageBytes } so you know how much to cut; ' +
      '`supersedes_not_found` means the id you are replacing does not exist in this workspace (nothing ' +
      'was published — fix the id rather than dropping `supersedes`, which would orphan the history); ' +
      '`subject_ref_required` means every subject.kind except `none` needs a ref; `invalid_field` names ' +
      'the rejected enum value. `event_emitted:false` means the row IS published but the ' +
      '`report:published:<id>` wake did not fire — the publish stands, only the notification was lost.',
    seeAlso: [
      'reports:list (browse the library)',
      'reports:get (read one back, with its lineage)',
      'reports:retire (soft-retire one you authored)',
    ],
  },
  // The success envelope is the wire record spread flat, plus `ok` and the
  // best-effort `event_emitted`. Refusals are returned as a separate structured
  // shape and are described in `returns` prose rather than unioned in here.
  result: zReportWire.extend({ ok: z.literal(true), event_emitted: z.boolean() }),
  capability: 'reports:write',
  requirePrincipal: false,
  // Any agent session may publish — the library is the fleet's shared output surface.
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    request_key: z.string().trim().min(1).max(200).optional().describe('Retry key within your workspace and author identity, or your host-verified accepted operation across worker retries. Identical retries return the original report; changed content is request_key_conflict.'),
    title: z.string().min(1).max(500).describe('one line; this is what the library list shows'),
    summary: z.string().max(4000).optional().describe('a short abstract shown under the title'),
    body_md: z.string().optional().describe('the report itself, markdown; mermaid fences allowed; ≤512KB'),
    goal_owner_report: zGoalOwnerReportSnapshot.optional().describe('Pinned GOAL snapshot. Workspace must match this session; derives the exact five-section body and GOAL subject.'),
    kind: zReportKind.optional().describe('what kind of report this is (default `audit`)'),
    subject: zReportSubject.optional().describe('what it is ABOUT — use `external` for subjects outside this workspace'),
    visibility: zReportVisibility
      .optional()
      .describe('who may READ it: `owner` (default) | `pot` | `workspace`'),
    supersedes: z
      .string()
      .min(1)
      .optional()
      .describe('the report_id this replaces; its lineage is inherited and its body stays resolvable'),
    tags: z.array(z.string().min(1).max(60)).max(20).optional(),
  }),
  async handler(args, ctx) {
    const disabled = await reportsLibraryDisabled();
    if (disabled) return { data: disabled };
    const sql = getOrgPg().sql;
    const workspaceId = resolveWorkspaceId(ctx);

    let publication;
    try {
      const origin = stampOrigin(ctx);
      if (args.request_key !== undefined && origin.authorOwnerId) {
        const active = await readActiveOperationWorkerClaimBinding(workspaceId, origin.authorOwnerId);
        if (active.status === 'unavailable') {
          return { data: { ok: false, error: 'operation_binding_unavailable', message: active.reason } };
        }
        if (active.status === 'bound') {
          const item = await getWorkItem(active.binding.workItemId, active.binding.storageHarnessSlug);
          const match = item ? matchOperationWorkerClaim(active, item) : null;
          if (!match?.allowed || item?.assignee !== origin.authorOwnerId) {
            return { data: { ok: false, error: 'operation_binding_mismatch',
              message: match && !match.allowed ? match.reason : 'operation worker must hold its accepted work item' } };
          }
          // The canonical work-item plus immutable accepted pin survives worker
          // retries. The returned report retains the FIRST author's provenance.
          origin.requestScope = `operation:${createHash('sha256').update(JSON.stringify([
            active.binding.harnessSlug, active.binding.workItemId, active.binding.operationId,
            active.binding.specificationRevision, active.binding.pin,
          ])).digest('hex')}`;
        }
      }
      publication = await publishReportWithEffects(
        sql,
        {
          workspaceId,
          requestKey: args.request_key,
          title: args.title,
          summary: args.summary,
          bodyMd: args.body_md,
          goalOwnerReport: args.goal_owner_report,
          kind: args.kind,
          subject: args.subject,
          visibility: args.visibility,
          supersedes: args.supersedes,
          tags: args.tags,
        },
        // Axis 1, server-side. Never from `args` — see stampOrigin.
        origin,
        message => ctx.log(message),
      );
    } catch (err) {
      // A refusal rides the same `{ data }` envelope as a success: the handler
      // contract is `ToolResult | ToolResponse`, and a bare object would not be
      // assignable on either branch.
      return { data: toRefusal(err) };
    }

    // One shared wire projection, so publish and list name every field identically.
    return { data: { ok: true as const, ...toReportWire(publication.report), event_emitted: publication.eventEmitted } };
  },
});
