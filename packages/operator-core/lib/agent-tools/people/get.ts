/**
 * people:get — canonical persons by PER- id, following merges to the surviving person
 * (crm-agent-sales-onboarding-apps-2026-10-06 P-003, D-016 / D-017). Read-only.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { isCodingAgentRole } from '../../personal-vault/coding-roles';
import { getPeople, readPersonQualificationEvidence } from '../../relationship-graph/people';
import { mergeIds, runBulk, bulkContent } from '../_bulk';

export default defineTool({
  name: 'people:get',
  description:
    'Fetch canonical persons by PER- id from the workspace relationship graph. A merged-away id resolves to its survivor ' +
    '(the returned person.id is the survivor). Pass `id` or `ids`. Optional includeQualificationEvidence adds bounded cited source observations ' +
    'for a collector; these are not a score, verified product identity or communication consent. ' +
    'Returns { ok, results:[{ ok, id, person?, qualificationEvidence? | error }], counts }. Read-only.',
  guidance: {
    when: 'You hold PER- ids (stored by an app, or from people:search) and need the current person.',
    notWhen: 'To find persons by name, address or number, use people:search.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('one PER- id'),
      ids: z.array(z.string().min(1)).min(1).max(100).optional().describe('PER- ids (1-100)'),
      includeQualificationEvidence: z.boolean().optional().describe('Include cited graph source inputs; missing or stale membership remains unknown. Does not authorize telemetry reads.'),
      qualificationWindow: z.object({ windowStart: z.string().datetime({ offset: true }), windowEnd: z.string().datetime({ offset: true }) })
        .refine(window => Date.parse(window.windowStart) < Date.parse(window.windowEnd), 'windowStart must precede windowEnd')
        .optional().describe('Half-open source observation window; missing source dates remain unknown.'),
    })
    .refine(a => !a.qualificationWindow || a.includeQualificationEvidence === true, { message: 'qualificationWindow requires includeQualificationEvidence' })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, { message: 'pass `id` (one) or `ids` (many)' }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId?.trim() ?? '';
    const ids = mergeIds(args.id, args.ids);
    const denied = isCodingAgentRole((ctx as { role?: string | null }).role)
      ? 'coding_agent_denied'
      : !workspaceId || workspaceId === '*' ? 'workspace_required' : null;
    const people = denied ? new Map() : await getPeople(getOrgPg().sql, workspaceId, ids);
    const env = await runBulk(
      ids,
      async (id) => {
        if (denied) return { ok: false as const, id, error: denied };
        const person = people.get(id);
        if (!person) return { ok: false as const, id, error: 'not_found' };
        return { ok: true as const, id, person, ...(args.includeQualificationEvidence ? {
          qualificationEvidence: await readPersonQualificationEvidence(getOrgPg().sql, workspaceId, person.id, ...(args.qualificationWindow ? [args.qualificationWindow] as const : [])),
        } : {}) };
      },
      { keyOf: (id) => ({ id }) },
    );
    return bulkContent(env);
  },
});
