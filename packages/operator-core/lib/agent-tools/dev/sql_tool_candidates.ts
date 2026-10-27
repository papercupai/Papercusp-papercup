/** Passive, scoped opportunity discovery. Never executes SQL or creates a tool. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { harnessArg } from '../_harness-scope';
import { pullSqlToolCandidates } from '../../sql-tool-candidate-pull';

export default defineTool({
  name: 'dev:sql_tool_candidates',
  profile: 'engineer',
  description: 'Bounded typed SQL tool opportunity worklist: scores, corpus coverage, decision history and source evidence references. Read-time source authority is mandatory; unavailable authority returns content-free UNKNOWN.',
  capability: 'intel:read',
  guidance: {
    when: 'Discover repeated SQL demand in one harness for reviewed tool proposals. Coverage and unsupported residue accompany scores; candidates are advisory.',
    notWhen: 'To execute SQL, assert substitution equivalence, or deploy a proposed tool. For recipe opportunities use recipes:candidates.',
    seeAlso: ['curation:state-of-pot (optional scoped SQL opportunity pull)', 'recipes:candidates (recipe demand)'],
  },
  args: z.object({ harness: harnessArg, limit: z.number().int().min(1).max(100).optional(),
    ranOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict(),
  async handler(args, ctx) {
    return { data: await pullSqlToolCandidates(ctx, args) };
  },
});
