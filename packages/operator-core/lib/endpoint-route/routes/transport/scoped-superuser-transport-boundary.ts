/**
 * Shared transport boundary for profile gating and scoped-superuser calls to
 * cross-workspace tools. Both the MCP host and nested orchestration dispatch
 * use this before a projected handler can run; keep this module independent of
 * the MCP host so handler bundles can reuse the same decision.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import type { ToolResult } from '@papercusp/tooldef';
import { authSafeToolsRemoveSet } from '../../../auth-config-overrides';

export type ScopedSuperuserTransportTool = {
  name?: string;
  crossWorkspace?: boolean;
  profile?: string;
};

export type ScopedSuperuserTransportContext = {
  workspaceId: string;
  isSuperuser?: boolean;
  profile?: string;
};

export type ScopedSuperuserTransportBoundaryResult =
  | { ok: true; scopedSuperuserClamp: boolean }
  | { ok: false; result: ToolResult };

/**
 * Reviewed exceptions to the scoped-superuser cross-workspace denial. Every
 * entry self-confines to the caller's own workspace (or accesses global config
 * rather than tenant data); tool metadata cannot grant this exception.
 *
 * The `safeToolsRemove` runtime dial may only subtract entries, so it can
 * tighten this boundary but never widen it.
 */
const SCOPED_SAFE_CROSSWORKSPACE: ReadonlySet<string> = new Set([
  'autonomy:decide',
  'autonomy:record_disposition',
  'memory:search',
  'memory:list',
  'memory:remember',
  'memory:update',
  'memory:forget',
  'memory:get',
  'search:fulltext',
  'search:semantic',
  'sessions:search',
  'sessions:read',
  'sessions:list',
  'sessions:timeline',
  'sessions:digest',
  'pot_git:secrets_exemptions',
  'pot_git:integration_requests',
]);

/** Global flags contain no per-workspace tenant data and govern this clamp. */
const SUPERUSER_GLOBAL_FLAG_ADMIN: ReadonlySet<string> = new Set(['flags:get', 'flags:set', 'flags:list']);

/**
 * Apply the profile and cross-workspace boundary shared by direct and nested
 * dispatch. The host's higher-level harness and hive checks remain in its
 * transport clamp; this leaf owns the decision that must also guard
 * `code:run` and recipe nested dispatch.
 */
export async function applyScopedSuperuserTransportBoundary(
  tool: ScopedSuperuserTransportTool,
  caller: ScopedSuperuserTransportContext,
  options: { readForAllTools?: boolean } = {},
): Promise<ScopedSuperuserTransportBoundaryResult> {
  const toolName = tool.name ?? '<unnamed tool>';
  if (caller.profile === 'power' && tool.profile === 'engineer') {
    return {
      ok: false,
      result: {
        isError: true,
        content: [
          {
            type: 'text',
            text: `tool_not_available_for_profile: "${toolName}" is not available in the power-engineer profile`,
          },
        ],
      },
    };
  }

  const scopedSuperuserClamp =
    caller.isSuperuser === true &&
    caller.workspaceId !== '*' &&
    (options.readForAllTools === true || tool.crossWorkspace === true) &&
    (await getFlag(FLAGS.SCOPED_SUPERUSER_CLAMP, 'system'));
  if (
    scopedSuperuserClamp &&
    tool.crossWorkspace === true &&
    !(SCOPED_SAFE_CROSSWORKSPACE.has(toolName) && !authSafeToolsRemoveSet().has(toolName)) &&
    !SUPERUSER_GLOBAL_FLAG_ADMIN.has(toolName)
  ) {
    return {
      ok: false,
      result: {
        isError: true,
        content: [
          {
            type: 'text',
            text: `workspace_forbidden: "${toolName}" spans workspaces, but this session is scoped to workspace "${caller.workspaceId}". Use an unscoped (--all-workspaces) superuser session to span workspaces.`,
          },
        ],
      },
    };
  }

  return { ok: true, scopedSuperuserClamp };
}
