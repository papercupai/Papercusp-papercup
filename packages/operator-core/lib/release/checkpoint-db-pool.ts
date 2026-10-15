/**
 * Shared DB-pool sizing for green-checkpoint runners.
 *
 * The periodic routine and the detached manual launcher both run the same
 * suite, but they have different process-environment boundaries. Keep the
 * resolver and the two forms of env injection here so the suite cannot inherit
 * the host operator's larger pool on one launch path and not the other.
 */

export const DEFAULT_GREEN_CHECKPOINT_DB_POOL_MAX = 2;

export function resolveGreenCheckpointDbPoolMax(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.PAPERCUSP_CHECKPOINT_DB_POOL_MAX);
  return Number.isFinite(configured) && configured > 0
    ? Math.max(1, Math.floor(configured))
    : DEFAULT_GREEN_CHECKPOINT_DB_POOL_MAX;
}

/** The standard db package env override for a checkpoint child process. */
export function greenCheckpointDbPoolEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { PAPERCUSP_DB_POOL_MAX: String(resolveGreenCheckpointDbPoolMax(env)) };
}

/** The equivalent `systemd-run` arguments for a detached checkpoint unit. */
export function greenCheckpointDbPoolSetenvArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(greenCheckpointDbPoolEnv(env)).map(([key, value]) => `--setenv=${key}=${value}`);
}

/**
 * The env vars that pin WHICH database a process connects to, in the db package's own
 * precedence order (`libs/papercusp/libs/db/src/connection.ts` `adminUrl()`/`appUrl()`):
 * an explicit DSN beats the `$PAPERCUSP_HOME/embedded-pg.json` discovery file.
 */
export const GREEN_CHECKPOINT_DB_TARGET_ENV_VARS = [
  'HARNESS_ADMIN_DATABASE_URL',
  'HARNESS_DATABASE_URL',
  'DATABASE_URL',
] as const;

/**
 * WI-10006055: the launcher's DB target, for a detached checkpoint unit.
 *
 * The periodic routine spawns the suite with `{ ...process.env }`, so it inherits the
 * operator's DSN. A manual/detached launch goes through `systemd-run --user`, which does NOT
 * inherit the launcher's env. Without a forwarded DSN the gate falls through to the discovery
 * file, and on this host that file is written by the installed Papercusp Server sidecar
 * (:24680). That database has no `system:green-checkpoint` routine row, so the run cannot see
 * the frozen repair queue: it cut a fresh candidate and then crashed on a 0-row queue write
 * ("expected row version ABSENT, found absent", measured 2026-10-10T16:39Z). Forward exactly
 * the vars the launcher holds, so the gate and every leg judge against the launcher's DB.
 */
export function greenCheckpointDbTargetEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of GREEN_CHECKPOINT_DB_TARGET_ENV_VARS) {
    const value = env[key];
    if (typeof value === 'string' && value.trim() !== '') out[key] = value;
  }
  return out;
}

/** The equivalent `systemd-run` arguments for a detached checkpoint unit. */
export function greenCheckpointDbTargetSetenvArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(greenCheckpointDbTargetEnv(env)).map(([key, value]) => `--setenv=${key}=${value}`);
}
