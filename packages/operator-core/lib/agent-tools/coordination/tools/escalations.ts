/**
 * coord:escalations — list open / resolved escalation records.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getEscalation, listEscalationsPaginated } from '../escalations';
import { COORD_ROLES } from '../roles';

export default defineTool({
  name: 'coord:escalations',
  description:
    "List escalations addressed to the human — newest-first, bounded at the storage layer (EI-1548: never loads the whole backlog into memory). Default page 50, max 500. Filter by status=open / status=resolved. ⚠ `total`/`count` is JUST this page's size, NOT the backlog size — a small maxRecords can make it look like ground truth (EI-16170). For status=open, use `trueOpenTotal` (an unbounded exact count) as the real backlog size, and page the WHOLE backlog with `offset` (0, then +maxRecords, …) until `truncated:false` (sum of pages == trueOpenTotal; EI-18712273081050373 — offset does REAL backward pagination for status=open, unlike a bare maxRecords bump which only widens the recency window and can miss old escalations). `truncated:true` means older escalations exist beyond the window. A `body` over 500 chars is truncated in list mode (`bodyTruncated:true` + `bodyLength`). Pass `msg_id` to read and fold one known record. Judge callers must use that exact-ID form; unfiltered and windowed reads are refused. EI-15377: `conditionKey`/`q` re-check one known escalation without dumping the whole backlog — see returns for match-completeness caveats. Full detail + examples: /internal/docs/agent-insights/coord-escalations-pagination-semantics.",
  guidance: {
    when: 'Showing the human inbox; diagnostics; checking your own past escalations.',
    notWhen: 'For judge evidence, do not use a broad SQL read: pass the known msg_id for one exact read. Other callers may use the bounded list and filters.',
    returns:
      'EI-15377: `conditionKey` is an exact match against the record subjectSignature (the dedup key a caller supplies as meta.subjectSignature when opening); `q` is a case-insensitive substring match over summary+body. For status=open the filter runs against the COMPLETE open set, so a miss proves absence. Otherwise it runs against a recency-bounded window and the result carries `filterWindowCaveat:true` — a miss there does NOT prove absence, only that no match fell inside the window scanned.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES, 'judge'],
  args: z.object({
    msg_id: z.string().min(1).optional().describe('Read exactly one known escalation by msg_id. Required for judge callers; cannot be combined with list filters.'),
    status: z.enum(['open', 'resolved']).optional(),
    maxRecords: z.number().int().min(1).max(500).optional().describe('Max records per call (default 50, max 500)'),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Page offset into the true open set (status=open only) — 0 for the first page, then +maxRecords each call, until truncated:false. No effect for status=resolved / unfiltered reads.',
      ),
    conditionKey: z
      .string()
      .min(1)
      .optional()
      .describe('EI-15377: exact match against the record subjectSignature. See returns for match-completeness caveats.'),
    q: z
      .string()
      .min(1)
      .optional()
      .describe('EI-15377: case-insensitive substring match over summary+body. See returns for match-completeness caveats.'),
  }),
  result: z
    .object({
      escalations: z.array(z.unknown()),
      count: z.number(),
      total: z.number().optional(),
      trueOpenTotal: z.number().optional(),
      truncated: z.boolean().optional(),
      offset: z.number().optional(),
      filterWindowCaveat: z.boolean().optional(),
      note: z.string().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const hasListFilters = args.status !== undefined || args.maxRecords !== undefined ||
      args.offset !== undefined || args.conditionKey !== undefined || args.q !== undefined;
    if (ctx.role === 'judge') {
      if (!args.msg_id || hasListFilters) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({
            ok: false,
            error: 'judge_requires_exact_msg_id',
            message: 'Judge callers may read one known escalation by msg_id only; list and search reads are not available.',
          }) }],
        };
      }
    }

    if (args.msg_id !== undefined) {
      if (hasListFilters) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({
            ok: false,
            error: 'msg_id_cannot_combine_with_filters',
            message: 'Pass msg_id alone for an exact single-record read.',
          }) }],
        };
      }
      const escalation = await getEscalation(args.msg_id);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            escalations: escalation ? [escalation] : [],
            count: escalation ? 1 : 0,
            total: escalation ? 1 : 0,
            truncated: false,
            msg_id: args.msg_id,
          }),
        }],
      };
    }

    const result = await listEscalationsPaginated({
      status: args.status,
      maxRecords: args.maxRecords,
      offset: args.offset,
      conditionKey: args.conditionKey,
      q: args.q,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            escalations: result.escalations,
            count: result.escalations.length,
            total: result.total,
            trueOpenTotal: result.trueOpenTotal,
            truncated: result.truncated,
            offset: result.offset,
            filterWindowCaveat: result.filterWindowCaveat,
            note: result.truncated
              ? result.offset !== undefined && result.trueOpenTotal !== undefined
                ? `Page [${result.offset}, ${result.offset + result.escalations.length}) of the true open backlog (trueOpenTotal:${result.trueOpenTotal}). Pass offset:${result.offset + result.escalations.length} to page further — do NOT just raise maxRecords, it will not reach older rows.`
                : `Bounded to a window of up to ${args.maxRecords ?? 50} most-recent escalation events (older ones exist beyond this window). Raise maxRecords (max 500) or filter by status to page further.${result.trueOpenTotal !== undefined ? ` The TRUE open backlog size is trueOpenTotal:${result.trueOpenTotal} — use that, not total/count, as ground truth.` : ''}`
              : undefined,
          }),
        },
      ],
    };
  },
});
