import { homedir } from 'node:os';
import path from 'node:path';

/**
 * `$VH_EVIDENCE_ROOT_BASE/<harness>`, else the XDG state dir (`$XDG_STATE_HOME`,
 * default `~/.local/state`) `/verification-harness/<harness>`.
 * Keep this resolver dependency-free so plain Node harness launchers reuse it.
 */
export function defaultEvidenceRoot(harness: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.VH_EVIDENCE_ROOT_BASE?.trim();
  if (explicit) return path.join(explicit, harness);
  const state = env.XDG_STATE_HOME?.trim() || path.join(env.HOME?.trim() || homedir(), '.local', 'state');
  return path.join(state, 'verification-harness', harness);
}
