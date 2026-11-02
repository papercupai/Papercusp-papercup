/**
 * schedule:inventory — the central read-only view of EVERY scheduled/recurring
 * thing in the operator host, regardless of cadence
 * (plan schedule-inventory-and-ephemeral-tier-2026-06-26, P-002).
 *
 * Unions DBOS scheduled workflows (durable) + harness_shared.routines (durable) +
 * in-process-periodic sweeps (ephemeral) into one row shape. The aggregation logic
 * lives in ../../schedule-inventory so the /admin/schedules data path (P-003) shares
 * it. The managedSetInterval registry (P-006) and per-process registries (P-014)
 * plug in as additional sources without touching this tool.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { collectScheduleInventory, summarizeInventory, SCHEDULE_SOURCES } from '../../schedule-inventory';
import { collectCurrentStartupActivity } from '../../startup-activity';

export default defineTool({
  name: 'schedule:inventory',
  profile: 'engineer',
  description:
      'Central read-only inventory of scheduled/recurring work. Default view=schedules returns existing schedule rows and summary; view=startup adds current-user native service/login/boot observations, feature purpose/scope, separate desired versus observed state, unavailable sources and writer coverage. Unknown measurements remain null; registered does not mean running. Schedule filters apply only to view=schedules.',
  capability: 'operator:read',
  guidance: {
    when: 'See ALL cadences in one place — what runs on a schedule and how often (DBOS crons, system routines, in-process sweeps) — before tuning/pausing one or diagnosing a missing tick. Pass group to narrow to one routines group instead of the flat cross-source list.',
    notWhen:
      'To CHANGE a routine use routines:set; for DBOS execution rows (status counts/recent runs) use the /admin/dbos view; for routine-only detail (incl. group filter/rollup) use routines:list.',
    chaining: 'routines:set to retune a routine row you find here; routines:list for routine-only detail (incl. { rollup:true } for the group view).',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 30 } },
  args: z.object({
    view: z.enum(['schedules', 'startup']).optional().describe('Default schedules. Startup includes device observations and complete coverage diagnostics; does not accept schedule filters.'),
    source: z
      .enum(SCHEDULE_SOURCES)
      .optional()
      .describe('Filter to one source (dbos | routines | in-process | managed | external-process).'),
    tier: z
      .enum(['durable', 'ephemeral'])
      .optional()
      .describe('Filter to one execution tier (durable = DBOS-backed; ephemeral = in-process).'),
    name: z
      .string()
      .optional()
      .describe('Case-insensitive substring filter on `name` — bound a single-routine lookup instead of pulling every row (e.g. every harness_shared.routines row) into context.'),
    installSlug: z
      .string()
      .optional()
      .describe('Case-insensitive substring filter on `installSlug` (routines only; other sources have installSlug=null and never match).'),
    group: z
      .string()
      .optional()
      .describe('Filter to one routine group slug (WI-5018; routines source only — other sources have groupSlug=null and never match). Pass "" for ungrouped-only.'),
  }).superRefine((args, ctx) => {
    if (args.view === 'startup' && [args.source, args.tier, args.name, args.installSlug, args.group].some(value => value !== undefined))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Schedule filters require view=schedules; startup coverage requires the full inventory.' });
  }),
  async handler(args) {
    if (args.view === 'startup') return { data: await collectCurrentStartupActivity() };
    const rows = await collectScheduleInventory({}, args);
    const summary = summarizeInventory(rows);
    return { data: { summary, rows } };
  },
});
