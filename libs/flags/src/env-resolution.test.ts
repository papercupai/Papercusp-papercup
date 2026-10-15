import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { flagEnvVarName, resolveFlagFromEnv, type EnvMap } from './env-resolution';
import { getFlag, initFlagBackend } from './server';
import { setFlagOverridesForTest } from './test';
import { ALL_FLAG_KEYS, FLAGS, FLAG_DEFAULTS } from './types';

// resolveFlagFromEnv is how a RECORDED test-run configuration snapshot is resolved after the
// fact (verification-system-improvements-2026-10-10 P-011). Its answer is only worth anything
// if it is the answer the running process gave, so the parity block below pins it against the
// real getFlag() for every flag, not against a copy of the precedence rules.

// Same isolation as server.test.ts (EI-7686): the invoking shell exports ambient overrides.
function ambientFlagEnvKeys(): string[] {
  return Object.keys(process.env).filter(
    (k) => k.startsWith('PAPERCUSP_FLAG_') || k === 'PAPERCUSP_PLATFORM_MODE',
  );
}
let savedFlagEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedFlagEnv = {};
  for (const k of ambientFlagEnvKeys()) {
    savedFlagEnv[k] = process.env[k];
    delete process.env[k];
  }
  initFlagBackend(null);
  setFlagOverridesForTest(null);
});
afterEach(() => {
  setFlagOverridesForTest(null);
  for (const k of ambientFlagEnvKeys()) delete process.env[k];
  for (const [k, v] of Object.entries(savedFlagEnv)) {
    if (v !== undefined) process.env[k] = v;
  }
});

describe('resolveFlagFromEnv precedence', () => {
  it('names the env var by uppercasing the key and replacing - with _', () => {
    expect(flagEnvVarName('papercusp-video-channels')).toBe('PAPERCUSP_FLAG_PAPERCUSP_VIDEO_CHANNELS');
  });

  it('falls back to the compiled default with no env', () => {
    const key = FLAGS.VIDEO_CHANNELS;
    expect(resolveFlagFromEnv(key, {})).toEqual({ value: FLAG_DEFAULTS[key], source: 'default' });
  });

  it('treats 1/true as on and any other set value as off', () => {
    const key = FLAGS.VIDEO_CHANNELS;
    const name = flagEnvVarName(key);
    expect(resolveFlagFromEnv(key, { [name]: '1' })).toEqual({ value: true, source: 'env' });
    expect(resolveFlagFromEnv(key, { [name]: 'TRUE' })).toEqual({ value: true, source: 'env' });
    expect(resolveFlagFromEnv(key, { [name]: '0' })).toEqual({ value: false, source: 'env' });
    expect(resolveFlagFromEnv(key, { [name]: 'yes' })).toEqual({ value: false, source: 'env' });
  });

  it('applies PAPERCUSP_PLATFORM_MODE only to the platform-improvement flag', () => {
    expect(resolveFlagFromEnv(FLAGS.PLATFORM_IMPROVEMENT_LOOPS, { PAPERCUSP_PLATFORM_MODE: 'off' })).toEqual({
      value: false,
      source: 'platform-mode',
    });
    expect(resolveFlagFromEnv(FLAGS.VIDEO_CHANNELS, { PAPERCUSP_PLATFORM_MODE: 'off' }).source).toBe('default');
  });

  it('lets the per-flag override beat PAPERCUSP_PLATFORM_MODE', () => {
    const key = FLAGS.PLATFORM_IMPROVEMENT_LOOPS;
    const env = { PAPERCUSP_PLATFORM_MODE: 'off', [flagEnvVarName(key)]: '1' };
    expect(resolveFlagFromEnv(key, env)).toEqual({ value: true, source: 'env' });
  });

  it('reports an unknown key as null, never as false', () => {
    expect(resolveFlagFromEnv('no-such-flag-key', {})).toEqual({ value: null, source: 'unknown-flag' });
  });
});

describe('resolveFlagFromEnv agrees with the live getFlag()', () => {
  const firstKey = ALL_FLAG_KEYS[0];
  const scenarios: Array<{ name: string; env: EnvMap }> = [
    { name: 'empty env', env: {} },
    { name: 'platform mode off', env: { PAPERCUSP_PLATFORM_MODE: 'off' } },
    {
      name: 'platform mode off plus per-flag opt-in',
      env: { PAPERCUSP_PLATFORM_MODE: 'off', [flagEnvVarName(FLAGS.PLATFORM_IMPROVEMENT_LOOPS)]: 'true' },
    },
    {
      name: 'per-flag overrides flipping two flags against their defaults',
      env: {
        [flagEnvVarName(FLAGS.VIDEO_CHANNELS)]: FLAG_DEFAULTS[FLAGS.VIDEO_CHANNELS] ? '0' : '1',
        [flagEnvVarName(firstKey)]: FLAG_DEFAULTS[firstKey] ? 'off' : '1',
      },
    },
  ];

  for (const scenario of scenarios) {
    it(`matches getFlag for every flag: ${scenario.name}`, async () => {
      for (const [k, v] of Object.entries(scenario.env)) {
        if (v !== undefined) process.env[k] = v;
      }
      const mismatches: string[] = [];
      for (const key of ALL_FLAG_KEYS) {
        const live = await getFlag(key, 'parity-check');
        const recorded = resolveFlagFromEnv(key, scenario.env).value;
        if (live !== recorded) mismatches.push(`${key}: live=${live} recorded=${recorded}`);
      }
      expect(mismatches).toEqual([]);
    });
  }
});
