/**
 * GET /api/harness/:slug/community — the shared harness's community badge data (P-005, D-035).
 *
 * A harness is "shared" when `.papercusp/shared.json` exists in its repo root. The community
 * itself (server, invite, online count) comes from an installed provider package that offers
 * `community.presence`, configured on the Integrations page. This route names no provider.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { defineTool } from '@papercusp/agent-mcp';
import { loadHarnessRegistry } from '../../../harness-registry';
import { activeWorkspaceId } from '../../../workspace-registry';
import { getSessionUserOrDefault } from '../../../auth';
import { readCommunityPresence } from '../../../capability-verbs/community';

const HARNESS_SHARED_JSON = '.papercusp/shared.json';

const getCommunity = defineTool({
  method: 'GET',
  path: '/harness/:slug/community',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const reg = await loadHarnessRegistry();
    const harnessPath = reg.projects.find((p) => p.slug === slug)?.path ?? null;
    if (!harnessPath) return Response.json({ error: 'unknown harness' }, { status: 404 });
    const isShared = existsSync(join(harnessPath, HARNESS_SHARED_JSON));
    if (!isShared) return Response.json({ isShared, community: null });
    const user = await getSessionUserOrDefault();
    const community = await readCommunityPresence(getOrgPg().sql as unknown as postgres.Sql, {
      workspaceId: activeWorkspaceId(), userId: String(user.id), harnessSlug: slug,
    }).catch(() => null);
    return Response.json({ isShared, community });
  },
});

export default [getCommunity];
