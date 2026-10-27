export interface PinnedNonWorkspacePathRoute {
  prefix: string;
  workspace: string;
}

export function pinnedNonWorkspacePathRoutes(source: string): PinnedNonWorkspacePathRoute[];
export function expandAffectedWorkspaceNames(
  seeds: Iterable<string>,
  reverseDeps: Map<string, Set<string>>,
  included?: Iterable<string>,
): Set<string>;
