import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the host-level Papercusp home. Workspace-aware state must use the
 * operator-core papercuspRoot() seam; this helper only answers the host-home
 * question and preserves the PAPERCUSP_HOME isolation pin for scripts and
 * other host-bound code that cannot depend on operator-core.
 */
export function papercuspHome(env = process.env, fallbackHome = homedir()) {
  const scoped = typeof env?.PAPERCUSP_HOME === 'string'
    ? env.PAPERCUSP_HOME.trim()
    : '';
  return scoped || join(fallbackHome, '.papercusp');
}

/** Resolve a path below the host-level Papercusp home. */
export function papercuspPath(...parts) {
  return join(papercuspHome(), ...parts);
}

/**
 * Resolve the host-wide PTY discovery directory.
 *
 * Session processes may carry a workspace-scoped PAPERCUSP_HOME, while the
 * operator that discovers their local control sockets serves several
 * workspaces from one process. PTY discovery therefore has one host-level
 * default; isolated hosts and tests opt into their own directory through the
 * dedicated PAPERCUSP_PSU_PTY_DIR pin.
 */
export function papercuspPtyPath(env = process.env, fallbackHome = homedir()) {
  const override = typeof env?.PAPERCUSP_PSU_PTY_DIR === 'string'
    ? env.PAPERCUSP_PSU_PTY_DIR.trim()
    : '';
  return override || join(fallbackHome, '.papercusp', 'psu-pty');
}
