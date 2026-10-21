/**
 * improvements:bug-inflow — the read-only resolver behind the `work.bugInflow` state
 * cell (bug-inflow-one-problem-one-row-2026-10-18 P-007 / R-6, owner directive #1990).
 *
 * It answers "how many issue-family rows were filed per day, by source, against how
 * many were closed" from the STORED daily rollup (harness_shared.bug_inflow_daily,
 * migration 1535) that the improvement-watchdog tick writes. It never aggregates
 * work_items, so the read stays cheap on the fleet's hottest table. Freshness is
 * in-band: assessment 'stale' / 'unmeasured' says the writer has not kept up, and a
 * day with no stored row is listed in `missingDays`, never shown as a zero.
 *
 * Reuse note: work_items:burn_down is a live created/closed census with no reporter
 * dimension; this tool serves the stored per-source series instead. The
 * computation lives in harness/improvements/bug-inflow.ts; this file is the door.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import {
  BUG_INFLOW_DEFAULT_DAYS,
  BUG_INFLOW_MAX_DAYS,
  readBugInflowDaily,
  formatBugInflowLine,
  type BugInflowReading,
} from '../../harness/improvements/bug-inflow';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';

/** The payload shape the `work.bugInflow` cell's paths address. Exported for the test. */
export function bugInflowPayload(reading: BugInflowReading, now: Date) {
  return {
    inflow: reading,
    assessments: { bugInflow: reading.assessment },
    line: formatBugInflowLine(reading),
    measuredAt: now.toISOString(),
  };
}

export default defineTool({
  name: 'improvements:bug-inflow',
  profile: 'engineer',
  description:
    'Issue-family rows filed per UTC day by source vs closed per day by status, read from the stored daily rollup the improvement watchdog writes. Read-only; reports stale or missing days.',
  guidance: {
    when: 'To see whether bug inflow outpaces closes, and which source files most. Prefer state:read { cell:"work.bugInflow" }.',
    notWhen: 'You need the rows themselves — work_items:list or issues:list.',
  },
  // @cell-lens work.bugInflow
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    days: z.number().int().min(1).max(BUG_INFLOW_MAX_DAYS).optional()
      .describe(`UTC days to include, newest first (default ${BUG_INFLOW_DEFAULT_DAYS})`),
    workspace: z.string().min(1).max(120).optional().describe('workspace to read (default: the session workspace)'),
  }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const now = new Date();
    const reading = await readBugInflowDaily(workspaceId, { days: args.days, now });
    return { data: bugInflowPayload(reading, now) };
  },
});
