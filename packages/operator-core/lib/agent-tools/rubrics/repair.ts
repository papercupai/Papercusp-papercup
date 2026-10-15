/**
 * rubrics:repair — conservative repair for pre-enriched rubric revision rows.
 *
 * This is intentionally a targeted maintenance door, not a general historical
 * reconstruction tool. The current-version path admits only an exact current
 * standard, non-delegated rubric; acceptance rubrics and older versions remain
 * excluded. Run the default dry-run first; pass `dryRun:false` only after the
 * candidate is visible.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolvePlanWriteScope } from '../plans/_write-scope';
import { repairLegacyRubricRevisionSnapshots } from '../../rubrics';

const argsSchema = z.object({
  harness: harnessArg,
  rubricRef: z.string().trim().min(1).max(200).describe('Exact rubric slug whose eligible legacy revision snapshot is being repaired.'),
  rubricRevision: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Backfill only this exact current standard rubric version when its immutable snapshot is missing. Historical versions are never reconstructed from current template_data.'),
  dryRun: z
    .boolean()
    .optional()
    .describe('Preview the exact eligible rows without changing snapshots. Defaults to true; pass false to apply the repair.'),
});

export default defineTool({
  name: 'rubrics:repair',
  description:
    'Repair rubric revision snapshots. Without rubricRevision, only repairs a first-party standard rubric chain whose every row is the exact current body, preserving each row identity and provenance. With rubricRevision, appends one explicit snapshot only for that exact current standard, non-delegated rubric version; acceptance rubrics and older versions remain fail-closed. The append is CAS-guarded and never reconstructs historical versions from current data. Dry-run by default; pass dryRun:false to apply.',
  guidance: {
    when: 'rubrics:get reports an immutable rubric revision cannot be projected. For a missing current standard version, pass rubricRevision; for a whole legacy chain repair, omit it and require every revision to be the exact current body.',
    notWhen: 'The requested rubricRevision is not the live plan version, a snapshot already claims that version inconsistently, or the rubric is acceptance/delegated-class history. Those cases remain fail-closed.',
    chaining: 'Current-version path: rubrics:repair { rubricRef, rubricRevision, dryRun:true } → inspect the candidate → snapshot_create if a persistent backfill will be applied → rubrics:repair { rubricRef, rubricRevision, dryRun:false } → rubrics:get { rubricRef, revision: rubricRevision }. Legacy whole-chain path: omit rubricRevision and apply only when the complete history is exact-current-body.',
    seeAlso: ['rubrics:get (verify an exact immutable revision after repair)', 'plans:revisions (inspect the revision chain)'],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const { workspaceId, harnessSlug } = await resolvePlanWriteScope(sctx);
    const identity = args.rubricRevision !== undefined && args.dryRun === false
      ? resolveAgentIdentity(ctx)
      : undefined;
    const result = await repairLegacyRubricRevisionSnapshots(
      args.rubricRef,
      { workspaceId, harnessSlug },
      {
        dryRun: args.dryRun,
        ...(args.rubricRevision !== undefined ? { rubricRevision: args.rubricRevision } : {}),
        ...(identity ? { identity } : {}),
      },
    );
    const ctxAny = ctx as { metadata?: (data: Record<string, unknown>) => void };
    ctxAny.metadata?.({
      rubricId: result.rubricId,
      status: result.status,
      revisionsInspected: result.revisionsInspected,
      revisionsToRepair: result.revisionsToRepair,
      revisionsRepaired: result.revisionsRepaired,
      ...(result.revisionSeq !== undefined ? { revisionSeq: result.revisionSeq } : {}),
    });
    return { data: { ok: true, workspaceId, harnessSlug, ...result } };
  },
});
