/**
 * psu-launcher-env-sanitize.test.ts (EI-8868/EI-8877/WI-37487) — the fleet-wide
 * recurrence guard for inherited launch-environment pollution that poisons every
 * psu-launched agent's vitest/npx resolution or routes unrelated work through an
 * operator-only sidecar (and, via harness_shared.test_runs, the fleet's "red-test"
 * watchdog signal — see EI-8828/EI-8840). Proves `sanitizeInheritedEnv` strips the
 * dangerous npm_* lifecycle vars, release-tree PATH segments, and operator-only
 * sidecar toggles while preserving ordinary session state.
 *
 * Run: cd apps/operator && npx vitest run scripts/psu-launcher-env-sanitize.test.ts
 */
import { describe, it, expect } from 'vitest';
import { buildResumeEnv, sanitizeInheritedEnv } from './psu-launcher.mjs';

const delimiter = process.platform === 'win32' ? ';' : ':';

describe('resume launch custody', () => {
  const session = { agent: 'codex', id: 42, coordOwnerId: 'su-resumed-agent' };

  it('preserves the explicit launcher without replacing the resumed identity', () => {
    const options = { launchedBy: 'su-recovery-coordinator' };
    const env = buildResumeEnv(session, options);
    expect(env.PAPERCUSP_LAUNCHED_BY).toBe('su-recovery-coordinator');
    expect(env.PAPERCUSP_SID).toBe('su-resumed-agent');
  });

  it('clears inherited custody for an interactive resume, including account overlays', () => {
    const env = buildResumeEnv(session, {
      accountEnv: { env: { PAPERCUSP_LAUNCHED_BY: 'su-unrelated-parent' } },
    });
    expect(env.PAPERCUSP_LAUNCHED_BY).toBe('');
    expect(env.PAPERCUSP_SID).toBe('su-resumed-agent');
  });
});

describe('sanitizeInheritedEnv (EI-8868/EI-8877)', () => {
  it('strips npm_config_local_prefix, npm_package_*, npm_lifecycle_*, and INIT_CWD', () => {
    const dirty = {
      npm_config_local_prefix: '/home/dev/papercupai-workspace/papercup-release',
      npm_package_json: '/home/dev/papercupai-workspace/papercup-release/apps/operator/package.json',
      npm_package_name: '@papercupai/papercusp-monorepo',
      npm_lifecycle_event: 'dev',
      npm_lifecycle_script: 'next dev',
      INIT_CWD: '/home/dev/papercupai-workspace/papercup-release/apps/operator',
      HOME: '/home/dev',
      PAPERCUSP_HARNESS_SLUG: 'papercusp',
    };
    const clean = sanitizeInheritedEnv(dirty);
    expect(clean.npm_config_local_prefix).toBeUndefined();
    expect(clean.npm_package_json).toBeUndefined();
    expect(clean.npm_package_name).toBeUndefined();
    expect(clean.npm_lifecycle_event).toBeUndefined();
    expect(clean.npm_lifecycle_script).toBeUndefined();
    expect(clean.INIT_CWD).toBeUndefined();
    // untouched
    expect(clean.HOME).toBe('/home/dev');
    expect(clean.PAPERCUSP_HARNESS_SLUG).toBe('papercusp');
  });

  it('filters ONLY papercup-release PATH segments, preserving order + everything else', () => {
    const dirty = {
      PATH: [
        '/home/dev/.local/bin',
        '/home/dev/papercupai-workspace/papercup-release/node_modules/.bin',
        '/home/dev/papercupai-workspace/papercup-release/apps/operator/node_modules/.bin',
        '/home/dev/papercupai-workspace/papercusp/node_modules/.bin',
        '/usr/bin',
      ].join(delimiter),
    };
    const clean = sanitizeInheritedEnv(dirty);
    const segs = clean.PATH.split(delimiter);
    expect(segs).toEqual([
      '/home/dev/.local/bin',
      '/home/dev/papercupai-workspace/papercusp/node_modules/.bin',
      '/usr/bin',
    ]);
  });

  it('is a no-op on an already-clean env (no PATH mutation, nothing dropped)', () => {
    const clean = {
      PATH: ['/usr/bin', '/bin'].join(delimiter),
      HOME: '/home/dev',
    };
    const out = sanitizeInheritedEnv(clean);
    expect(out).toEqual(clean);
  });

  it('never mutates the input object (pure)', () => {
    const dirty = { npm_config_local_prefix: '/x', PATH: `/a${delimiter}/papercup-release/node_modules/.bin` };
    const before = { ...dirty };
    sanitizeInheritedEnv(dirty);
    expect(dirty).toEqual(before);
  });

  it('handles a missing/undefined PATH without throwing', () => {
    const out = sanitizeInheritedEnv({ npm_config_local_prefix: '/x' });
    expect(out.PATH).toBeUndefined();
    expect(out.npm_config_local_prefix).toBeUndefined();
  });

  it('strips operator-only sidecar toggles before launching an independent agent (WI-37487)', () => {
    const clean = sanitizeInheritedEnv({
      PAPERCUSP_DEV_DEPLOY_SPAWN_SIDECAR: '1',
      PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR: '1',
      PAPERCUSP_HARNESS_SLUG: 'papercusp',
      HOME: '/home/dev',
    });
    expect(clean.PAPERCUSP_DEV_DEPLOY_SPAWN_SIDECAR).toBeUndefined();
    expect(clean.PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR).toBeUndefined();
    expect(clean.PAPERCUSP_HARNESS_SLUG).toBe('papercusp');
    expect(clean.HOME).toBe('/home/dev');
  });

  it('strips every inherited recovery marker before an ordinary launch or resume', () => {
    const clean = sanitizeInheritedEnv({
      PAPERCUSP_RECOVERY_MODE: '1',
      PAPERCUSP_RECOVERY_GRANT_ID: 'stale-grant',
      PAPERCUSP_RECOVERY_CAPABILITY: 'diagnostic-command',
      PAPERCUSP_RECOVERY_DEADLINE_MS: '9999999999999',
      PAPERCUSP_HARNESS_SLUG: 'papercusp',
      HOME: '/home/dev',
    });
    expect(Object.keys(clean).filter((key) => key.startsWith('PAPERCUSP_RECOVERY_'))).toEqual([]);
    expect(clean.PAPERCUSP_HARNESS_SLUG).toBe('papercusp');
    expect(clean.HOME).toBe('/home/dev');
  });

  it('strips inherited native-session selectors before an independent launch', () => {
    const clean = sanitizeInheritedEnv({
      CODEX_SESSION_ID: 'parent-codex-session',
      PAPERCUSP_NATIVE_SESSION_ID: 'parent-bound-native-session',
      PAPERCUSP_SID: 'su-parent',
      PAPERCUSP_HARNESS_SLUG: 'papercusp',
    });

    expect(clean.CODEX_SESSION_ID).toBeUndefined();
    expect(clean.PAPERCUSP_NATIVE_SESSION_ID).toBeUndefined();
    // Papercusp owner and harness values remain available for the envelope to
    // replace with this launch's values.
    expect(clean.PAPERCUSP_SID).toBe('su-parent');
    expect(clean.PAPERCUSP_HARNESS_SLUG).toBe('papercusp');
  });
});
