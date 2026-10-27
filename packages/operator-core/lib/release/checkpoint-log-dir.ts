import { papercuspPath } from '@papercusp/host-platform/home';

/** The checkpoint log directory env key shared by release config and operator-core readers. */
export const CHECKPOINT_LOG_DIR_ENV = 'PAPERCUSP_CHECKPOINT_LOG_DIR';

/** Keep this in the operator-core ESM package so ESM-only tools need not import apps/operator. */
export function checkpointLogDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env[CHECKPOINT_LOG_DIR_ENV] ?? papercuspPath('checkpoint-logs');
}
