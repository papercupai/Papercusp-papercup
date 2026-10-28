/**
 * release:change-trail — who changed this file (or line), under which work-item, with what origin
 * and which test runs. Plan change-provenance-and-admission-throughput-2026-10-27 P-010 (R-9),
 * shaped by D-003 (red attribution for the eject rung + why-a-line-exists) and D-006 (a
 * file-centric read, not a work_items:get option). The join lives in ../../change-trail.ts.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { integrationRoot } from '../../release-deploy-launch';
import {
  buildChangeTrail,
  defaultChangeTrailDeps,
  CHANGE_TRAIL_DEFAULT_LIMIT,
  CHANGE_TRAIL_MAX_LIMIT,
} from '../../change-trail';

function concreteWorkspace(ctx: { workspaceId?: unknown }): string {
  const workspace = typeof ctx.workspaceId === 'string' ? ctx.workspaceId.trim() : '';
  return workspace && workspace !== '*' ? workspace : activeWorkspaceId();
}

export default defineTool({
  name: 'release:change-trail',
  profile: 'engineer',
  description:
    'Per-commit trail for one file in the canonical tree (or the commit that last touched one line): sha, the agent and work-items from its Papercusp-* trailers, each work-item’s origin (owner directive, plan item, or linked item), and test_runs of the file and its sibling test at that sha. Submodule paths resolve to the owning repo.',
  guidance: {
    when: 'A gate red needs attributing to the change and work-item that caused it (the eject rung), or you need to know why a line exists.',
    notWhen: 'Is my change live / in the candidate → dev:pipeline_position or state:read gate.greenCheckpoint.candidate.',
    chaining: 'release:change-trail → work_items:get on the named items → eject or fix.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'release-fixer', 'release-manager'],
  args: z.object({
    path: z.string().min(1).max(1024).describe('repo-relative path from the superproject root (submodule paths allowed)'),
    line: z.number().int().min(1).optional().describe('blame this 1-based line and return only the commit that last changed it'),
    since: z.string().max(64).optional().describe('git --since bound, e.g. "3 days ago" or an ISO date'),
    until: z.string().max(64).optional().describe('git --until bound'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(CHANGE_TRAIL_MAX_LIMIT)
      .optional()
      .describe(`max commits, newest first (default ${CHANGE_TRAIL_DEFAULT_LIMIT})`),
  }),
  async handler(args, ctx) {
    const workspaceId = concreteWorkspace(ctx);
    try {
      const trail = await buildChangeTrail(
        { repoRoot: integrationRoot(), ...args },
        defaultChangeTrailDeps(workspaceId),
      );
      return { data: { ok: true, ...trail } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { data: { ok: false, path: args.path, reason: message.split('\n')[0].slice(0, 400) } };
    }
  },
});
