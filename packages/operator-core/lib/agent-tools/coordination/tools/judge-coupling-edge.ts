/**
 * coord:judge-coupling-edge — record whether a SHADOW code-dependency coupling edge was
 * relevant, the precision input of R-12 (code-intel-delivery-and-outcomes-2026-10-26
 * P-012; WI-6554700010030879 part b).
 *
 * Why its own verb and not an argument on coord:couple / coord:decouple: those mutate
 * live coupling (a declared edge, a suppression mask). A shadow-edge judgment must not:
 * the edges are logged-only until R-12 grades the window, so a judgment writes one
 * audit_log row and nothing else. A distinct side effect gets its own verb.
 *
 * The rules live in code-intelligence/coupling-shadow-window.ts (judgeShadowEdge,
 * listJudgeableShadowEdges), which share windowEdges with the scorer: the write refuses
 * every judgment the scorer would drop, so an accepted judgment is a counted one.
 */
import type { Sql } from 'postgres';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { judgeShadowEdge, listJudgeableShadowEdges } from '../../../code-intelligence/coupling-shadow-window';

export default defineTool({
  name: 'coord:judge-coupling-edge',
  description:
    'Judge whether a SHADOW code-dependency coupling edge between two agents was relevant (R-12 precision). op:"list" returns the current window\'s judgeable edges, unjudged first; op:"judge" records { a, b, path, symbol, relevant }. Refused for a judge in the plan\'s implementer lineage and for an edge the scorer excludes. Writes one audit row; never couples or surfaces anything.',
  guidance: {
    when: 'You are outside the code-intel-delivery implementer lineage and can say whether one agent\'s edit to a symbol really mattered to the peer holding a dependent file.',
    notWhen: 'You want to couple or decouple agents now: that is coord:couple / coord:decouple.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    op: z.enum(['list', 'judge']).describe('list = judgeable edges of the current window; judge = record one judgment.'),
    a: z.string().min(1).max(200).optional().describe('judge: one endpoint ownerId, as listed.'),
    b: z.string().min(1).max(200).optional().describe('judge: the other endpoint ownerId, as listed.'),
    path: z.string().min(1).max(1000).optional().describe('judge: the edge\'s file path, as listed.'),
    symbol: z.string().max(500).optional().describe('judge: the edge\'s symbol, as listed.'),
    relevant: z.boolean().optional().describe('judge: true if surfacing this edge would have helped.'),
    note: z.string().max(500).optional().describe('judge: why, for a later reader.'),
    limit: z.number().int().positive().max(200).optional().describe('list: page size (default 25).'),
  }),
  async handler(args, ctx) {
    const me = resolveAgentIdentity(ctx);
    const workspaceId = me.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') {
      return { data: { ok: false, error: 'workspace_required', detail: 'the shadow window is per workspace; call from a session bound to one workspace' } };
    }
    const { getOrgPg } = await import('@papercusp/db-org');
    const sql = getOrgPg().sql as unknown as Sql;
    const now = Date.now();
    if (args.op === 'list') {
      return { data: { ok: true, ...await listJudgeableShadowEdges(sql, { workspaceId, now, limit: args.limit ?? 25 }) } };
    }
    if (!args.a || !args.b || !args.path || args.symbol === undefined || typeof args.relevant !== 'boolean') {
      return { data: { ok: false, error: 'missing_args', detail: 'op:"judge" needs a, b, path, symbol and relevant (copy a, b, path, symbol from op:"list")' } };
    }
    const result = await judgeShadowEdge(sql, {
      workspaceId, judgeOwnerId: me.ownerId, a: args.a, b: args.b, path: args.path,
      symbol: args.symbol, relevant: args.relevant, note: args.note ?? null, now,
    });
    return { data: result };
  },
});
