/**
 * WI-10008187 / WI-10006055: a detached manual checkpoint (`systemd-run --user`) does not inherit
 * the launcher's environment, so the launcher's DSN has to be forwarded explicitly. Without it the
 * gate resolves the embedded-pg discovery file, which on this host belongs to another install, and
 * the run cannot see its own frozen repair queue (logged as `database: <unset> (source=none)`).
 *
 * These tests pin both halves: which vars count as the DB target, and that the systemd-run argv
 * builder actually carries them into the unit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCheckpointSystemdArgv } from '../release-checkpoint-launch';
import {
  GREEN_CHECKPOINT_DB_TARGET_ENV_VARS,
  greenCheckpointDbTargetEnv,
  greenCheckpointDbTargetSetenvArgs,
} from './checkpoint-db-pool';

const DSN = 'postgresql://harness_admin:pw@localhost:5432/papercusp';

function stubAllDbTargets(value: string): void {
  for (const key of GREEN_CHECKPOINT_DB_TARGET_ENV_VARS) vi.stubEnv(key, value);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('greenCheckpointDbTargetEnv', () => {
  it('forwards exactly the DSN vars the launcher holds', () => {
    const env = {
      HARNESS_ADMIN_DATABASE_URL: DSN,
      DATABASE_URL: `${DSN}-app`,
      UNRELATED: 'x',
    } as NodeJS.ProcessEnv;
    expect(greenCheckpointDbTargetEnv(env)).toEqual({
      HARNESS_ADMIN_DATABASE_URL: DSN,
      DATABASE_URL: `${DSN}-app`,
    });
  });

  it('drops empty and whitespace-only values instead of forwarding a blank DSN', () => {
    const env = { HARNESS_ADMIN_DATABASE_URL: '', HARNESS_DATABASE_URL: '   ' } as NodeJS.ProcessEnv;
    expect(greenCheckpointDbTargetEnv(env)).toEqual({});
    expect(greenCheckpointDbTargetSetenvArgs(env)).toEqual([]);
  });

  it('renders one --setenv per held var', () => {
    const env = { HARNESS_ADMIN_DATABASE_URL: DSN } as NodeJS.ProcessEnv;
    expect(greenCheckpointDbTargetSetenvArgs(env)).toEqual([`--setenv=HARNESS_ADMIN_DATABASE_URL=${DSN}`]);
  });
});

describe('buildCheckpointSystemdArgv forwards the launcher DSN into the detached unit', () => {
  it('carries the launcher DSN as a systemd-run --setenv before the inner command', () => {
    stubAllDbTargets('');
    vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', DSN);
    const argv = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin');
    const setenv = `--setenv=HARNESS_ADMIN_DATABASE_URL=${DSN}`;
    expect(argv).toContain(setenv);
    // systemd-run options must precede the command; after `bash` they would be bash argv.
    expect(argv.indexOf(setenv)).toBeLessThan(argv.indexOf('bash'));
  });

  it('forwards no DSN when the launcher holds none (the run then reports source=none itself)', () => {
    stubAllDbTargets('');
    const argv = buildCheckpointSystemdArgv('/tree', '/tmp/cp.log', '/usr/bin');
    for (const key of GREEN_CHECKPOINT_DB_TARGET_ENV_VARS) {
      expect(argv.some((arg) => arg.startsWith(`--setenv=${key}=`))).toBe(false);
    }
  });
});
