import { describe, expect, it } from 'vitest';

import { FLAGS, FLAG_DEFAULTS, flagEnvVarName } from '@papercusp/flags';
import { captureConfigurationSnapshot } from '@papercusp/test-config/configuration-snapshot';

import {
  DECLARED_CONFIGURATION_FINGERPRINT_PREFIX,
  declaredConfigurationFingerprint,
  evidenceConfigurationFingerprint,
  judgeDeclaredConfiguration,
  parseProductionConfiguration,
  readConfigurationSnapshot,
  resolvedRunFlag,
} from './declared-configuration';

// A declared flag value OPPOSITE to its compiled default, so only a run that actually set the
// override env var can satisfy it.
const VIDEO = FLAGS.VIDEO_CHANNELS;
const VIDEO_REQUIRED = !FLAG_DEFAULTS[VIDEO];
const VIDEO_ENV = flagEnvVarName(VIDEO);
const DECLARED = { flags: { [VIDEO]: VIDEO_REQUIRED }, env: { PAPERCUSP_SEARCH_MODE: 'hybrid' } };

function onOff(value: boolean): string {
  return value ? '1' : '0';
}

describe('declared configuration — parse (AUTO-BAR-R-11-P-011)', () => {
  it('treats an absent or empty declaration as no declaration', () => {
    expect(parseProductionConfiguration(undefined)).toBeNull();
    expect(parseProductionConfiguration(null)).toBeNull();
    expect(parseProductionConfiguration({ flags: {}, env: {} })).toBeNull();
  });

  it('accepts flags and env and refuses malformed declarations loudly', () => {
    expect(parseProductionConfiguration(DECLARED)).toEqual(DECLARED);
    expect(() => parseProductionConfiguration('on')).toThrow(/must be an object/);
    expect(() => parseProductionConfiguration({ flags: { [VIDEO]: 'yes' } })).toThrow(/must be a boolean/);
    expect(() => parseProductionConfiguration({ env: { PAPERCUSP_X: 1 } })).toThrow(/must be a string/);
    expect(() => parseProductionConfiguration({ env: { HOME: '/root' } })).toThrow(/not a recorded env var/);
    expect(() => parseProductionConfiguration({ flag: { x: true } })).toThrow(/unknown keys: flag/);
  });

  it('refuses a declared flag that is not registered, since no run could satisfy it', () => {
    expect(() => parseProductionConfiguration({ flags: { 'no-such-flag-key': true } })).toThrow(
      /not a registered feature flag/,
    );
  });
});

describe('declared configuration — snapshot reading (SPEC-P-011-RUNNER-CAPTURE)', () => {
  it('reads the stored column value and rejects a hand-edited snapshot', () => {
    const snapshot = captureConfigurationSnapshot({ [VIDEO_ENV]: '1', NODE_ENV: 'test' });
    expect(readConfigurationSnapshot(snapshot)).toEqual(snapshot);
    expect(readConfigurationSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(readConfigurationSnapshot(null)).toBeNull();
    expect(readConfigurationSnapshot({ ...snapshot, flagEnv: { [VIDEO_ENV]: '0' } })).toBeNull();
  });

  it('resolves a run flag from its recorded inputs with the getFlag precedence', () => {
    const PLATFORM = FLAGS.PLATFORM_IMPROVEMENT_LOOPS;
    expect(resolvedRunFlag(captureConfigurationSnapshot({}), VIDEO)).toBe(FLAG_DEFAULTS[VIDEO]);
    expect(resolvedRunFlag(captureConfigurationSnapshot({ [VIDEO_ENV]: onOff(VIDEO_REQUIRED) }), VIDEO)).toBe(
      VIDEO_REQUIRED,
    );
    const modeOff = captureConfigurationSnapshot({ PAPERCUSP_PLATFORM_MODE: 'off' });
    expect(resolvedRunFlag(modeOff, PLATFORM)).toBe(false);
    const modeOffOptIn = captureConfigurationSnapshot({ PAPERCUSP_PLATFORM_MODE: 'off', [flagEnvVarName(PLATFORM)]: '1' });
    expect(resolvedRunFlag(modeOffOptIn, PLATFORM)).toBe(true);
    expect(resolvedRunFlag(modeOff, 'no-such-flag-key')).toBeNull();
  });
});

describe('declared configuration — bind-time judgement (AUTO-BAR-R-11-P-011)', () => {
  it('accepts a run whose configuration matches every declared key, ignoring undeclared keys', () => {
    const snapshot = captureConfigurationSnapshot({
      [VIDEO_ENV]: onOff(VIDEO_REQUIRED),
      PAPERCUSP_SEARCH_MODE: 'hybrid',
      PAPERCUSP_UNRELATED: 'x',
      NODE_ENV: 'test',
    });
    const verdict = judgeDeclaredConfiguration(DECLARED, snapshot);
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.fingerprint).toBe(declaredConfigurationFingerprint(DECLARED));
    expect(declaredConfigurationFingerprint(DECLARED).startsWith(DECLARED_CONFIGURATION_FINGERPRINT_PREFIX)).toBe(true);
  });

  it('accepts a declared flag equal to its default when the run set no override', () => {
    const declared = { flags: { [VIDEO]: FLAG_DEFAULTS[VIDEO] } };
    expect(judgeDeclaredConfiguration(declared, captureConfigurationSnapshot({})).ok).toBe(true);
  });

  it('refuses a run with no snapshot as fingerprint-missing', () => {
    const verdict = judgeDeclaredConfiguration(DECLARED, null);
    expect(verdict).toMatchObject({ ok: false, code: 'declared_configuration_fingerprint_missing', fingerprint: null });
  });

  it('refuses a run whose flag resolved differently, naming the key and the resolved value', () => {
    const snapshot = captureConfigurationSnapshot({ PAPERCUSP_SEARCH_MODE: 'hybrid' });
    const verdict = judgeDeclaredConfiguration(DECLARED, snapshot);
    expect(verdict).toMatchObject({
      ok: false,
      code: 'declared_configuration_fingerprint_mismatch',
      differing: [`flag:${VIDEO}`],
    });
    expect(!verdict.ok && verdict.message).toContain(`run resolved ${FLAG_DEFAULTS[VIDEO]}`);
  });

  it('refuses a run whose env value differs or is absent', () => {
    const flagOk = { [VIDEO_ENV]: onOff(VIDEO_REQUIRED) };
    const differs = captureConfigurationSnapshot({ ...flagOk, PAPERCUSP_SEARCH_MODE: 'lexical' });
    const absent = captureConfigurationSnapshot(flagOk);
    for (const snapshot of [differs, absent]) {
      expect(judgeDeclaredConfiguration(DECLARED, snapshot)).toMatchObject({
        ok: false,
        code: 'declared_configuration_fingerprint_mismatch',
        differing: ['env:PAPERCUSP_SEARCH_MODE'],
      });
    }
  });

  it('honours platform-mode precedence when judging the platform-improvement flag', () => {
    const PLATFORM = FLAGS.PLATFORM_IMPROVEMENT_LOOPS;
    const declaredOff = { flags: { [PLATFORM]: false } };
    expect(judgeDeclaredConfiguration(declaredOff, captureConfigurationSnapshot({ PAPERCUSP_PLATFORM_MODE: 'off' })).ok).toBe(true);
    const optedIn = captureConfigurationSnapshot({ PAPERCUSP_PLATFORM_MODE: 'off', [flagEnvVarName(PLATFORM)]: '1' });
    expect(judgeDeclaredConfiguration(declaredOff, optedIn)).toMatchObject({ ok: false, differing: [`flag:${PLATFORM}`] });
  });

  it('never matches a declared flag the run cannot answer', () => {
    const declared = { flags: { 'no-such-flag-key': false } };
    const snapshot = captureConfigurationSnapshot({});
    expect(evidenceConfigurationFingerprint(snapshot, declared)).not.toBe(declaredConfigurationFingerprint(declared));
  });
});
