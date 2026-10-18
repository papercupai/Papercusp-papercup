import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the host checkout workspace root shared by Papercusp's sibling
 * repositories. `PAPERCUSP_WORKSPACE_ROOT` is the parent of the canonical
 * checkout, not the checkout itself.
 *
 * Keep this resolver dependency-free: storage and filesystem guards import it
 * during startup, so it must not pull in the database-backed operator graph.
 */
export function resolveHostWorkspaceRoot(
  env: Partial<Pick<NodeJS.ProcessEnv, 'PAPERCUSP_WORKSPACE_ROOT' | 'HOME'>> = process.env,
  fallbackHome = homedir(),
): string {
  const configured = env.PAPERCUSP_WORKSPACE_ROOT?.trim();
  if (configured) return configured.replace(/\/+$/, '') || '/';
  const home = env.HOME?.trim() || fallbackHome;
  return join(home, 'papercupai-workspace');
}

/**
 * Return a retention-policy-safe root pattern. The tilde fallback is
 * intentional: the retention matcher expands it against its caller-supplied
 * home, which keeps policy tests and isolated homes deterministic.
 */
export function hostWorkspaceRootPattern(
  env: Partial<Pick<NodeJS.ProcessEnv, 'PAPERCUSP_WORKSPACE_ROOT'>> = process.env,
): string {
  const configured = env.PAPERCUSP_WORKSPACE_ROOT?.trim();
  return configured ? configured.replace(/\/+$/, '') || '/' : '~/papercupai-workspace';
}
