/** Trusted host seam shared by the tool and Scout. No saved grants or derived results. */
import type { UnifiedToolContext } from '@papercusp/tooldef';
import type { SqlCandidateReadOptions } from './bash-substitution/sql-tool-candidates';
import { readSqlToolCandidateWorklist, type SqlCandidateWorklist } from './sql-tool-candidate-worklist';
import { resolveConcreteHarnessSlug } from './agent-tools/_harness-scope';

export type SqlCandidatePullContext = Pick<UnifiedToolContext, 'principal' | 'workspaceId' | 'harnessSlug' | 'uiClientId'>;
export interface SqlCandidateAuthorityRequest {
  workspaceId: string;
  harnessSlug: string;
  principal: NonNullable<UnifiedToolContext['principal']>;
  ownerId?: string | null;
}
/** The host supplies the key/epoch and fresh source ACL lookup outside tool arguments.
 * Workspace/harness visibility alone is not a per-source authorization grant. */
export type SqlCandidateAuthorityResolver = (request: SqlCandidateAuthorityRequest) => Promise<SqlCandidateReadOptions | null>;
let authorityResolver: SqlCandidateAuthorityResolver | null = null;

/** Host composition only. Until a real source authority is bound the feature stays UNKNOWN. */
export function bindSqlCandidateAuthorityResolver(resolver: SqlCandidateAuthorityResolver | null): void {
  authorityResolver = resolver;
}
export const unknownSqlCandidateWorklist = (): SqlCandidateWorklist => ({ status: 'UNKNOWN', candidates: [],
  snapshots: [], population: { candidates: 0, returned: 0, omitted: 0, snapshotCap: 120 } });

export async function pullSqlToolCandidates(ctx: SqlCandidatePullContext,
  args: { harness?: string; limit?: number; ranOn?: string } = {}): Promise<SqlCandidateWorklist> {
  try {
    const harnessSlug = resolveConcreteHarnessSlug(args.harness, ctx);
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId;
    if (!authorityResolver || !harnessSlug || !workspaceId || workspaceId === '*' || !ctx.principal
      || (ctx.principal.workspaceId !== '*' && ctx.principal.workspaceId !== workspaceId)
      || (ctx.harnessSlug && ctx.harnessSlug !== '*' && ctx.harnessSlug !== harnessSlug)) return unknownSqlCandidateWorklist();
    // Resolve anew on EVERY pull, including repeated requests from the same session.
    const opts = await authorityResolver({ workspaceId, harnessSlug, principal: ctx.principal, ownerId: ctx.uiClientId });
    if (!opts || opts.workspaceId !== workspaceId || opts.harnessSlug !== harnessSlug
      || opts.scope.workspaceId !== workspaceId || typeof opts.authorize !== 'function'
      || typeof opts.authorizeSource !== 'function') return unknownSqlCandidateWorklist();
    return await readSqlToolCandidateWorklist({ ...opts, limit: args.limit, ranOn: args.ranOn });
  } catch { return unknownSqlCandidateWorklist(); }
}
