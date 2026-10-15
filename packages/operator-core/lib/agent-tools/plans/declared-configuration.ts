/**
 * Declared production configuration (P-011, plan verification-system-improvements-2026-10-10).
 *
 * A configuration-sensitive acceptance bar declares the configuration its proof must run
 * under, in `verification.productionConfiguration` ({ flags, env }). Every recorded test run
 * carries a CONFIGURATION SNAPSHOT (column `test_runs.configuration_snapshot`, written by
 * `@papercusp/test-config/configuration-snapshot`): the RAW flag-override env vars plus a
 * SHA-256 of every in-scope env value (raw values of other vars never leave the process).
 *
 * The snapshot records flag INPUTS, not resolved values, because the reporter that writes it
 * cannot depend on `@papercusp/flags`. This module resolves a declared flag from those inputs
 * with `resolveFlagFromEnv`, the same function the running process's getFlag() uses for its
 * env precedence, so the judge and the run cannot disagree on what a flag was.
 *
 * The two meet at bind time and at currentness classification:
 *  - `declaredConfigurationFingerprint(declared)` fingerprints what the bar requires;
 *  - `evidenceConfigurationFingerprint(snapshot, declared)` projects the run's snapshot onto
 *    the DECLARED keys and fingerprints that projection with the same canonical encoding.
 * Equal fingerprints mean the run executed under the declared configuration. A run with no
 * snapshot has NO fingerprint: it is refused at bind time and never counts as current.
 *
 * Pure module: no I/O, no flag store, no process.env reads. Callers supply the inputs.
 */
import { createHash } from 'node:crypto';

import { FLAG_DEFAULTS, resolveFlagFromEnv } from '@papercusp/flags';
import {
  CONFIGURATION_SNAPSHOT_ENV_KEY,
  type ConfigurationSnapshot,
  readConfigurationSnapshot,
} from '@papercusp/test-config/configuration-snapshot';

export { type ConfigurationSnapshot, readConfigurationSnapshot };

export interface ProductionConfiguration {
  /** Registered feature-flag key -> the value the proof must run with. */
  flags?: Record<string, boolean>;
  /** Environment variable -> the exact value the proof must run with. */
  env?: Record<string, string>;
}

export const DECLARED_CONFIGURATION_FINGERPRINT_PREFIX = 'sha256-declared-config-v1:';

export type DeclaredConfigurationRefusalCode =
  | 'declared_configuration_fingerprint_missing'
  | 'declared_configuration_fingerprint_mismatch';

export type DeclaredConfigurationVerdict =
  | { ok: true; fingerprint: string; declaredFingerprint: string }
  | {
      ok: false;
      code: DeclaredConfigurationRefusalCode;
      declaredFingerprint: string;
      fingerprint: string | null;
      /** Declared keys whose run value differs (`flag:<key>` / `env:<key>`). */
      differing: string[];
      message: string;
    };

/** Env vars a snapshot records (hashed). Product configuration lives under these prefixes. */
export const SNAPSHOT_ENV_KEY = CONFIGURATION_SNAPSHOT_ENV_KEY;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRegisteredFlag(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(FLAG_DEFAULTS, key);
}

/**
 * Validate a declared production configuration. Returns null when nothing is declared
 * (absent, or both maps empty). Throws on a malformed declaration: a bar that tries to
 * declare a configuration but cannot be read must not silently become "no declaration",
 * and a declared flag that is not registered could never be satisfied by any run.
 */
export function parseProductionConfiguration(value: unknown): ProductionConfiguration | null {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) throw new Error('productionConfiguration must be an object with flags and/or env');
  const unknownKeys = Object.keys(value).filter((key) => key !== 'flags' && key !== 'env');
  if (unknownKeys.length) throw new Error(`productionConfiguration has unknown keys: ${unknownKeys.join(', ')}`);
  const out: ProductionConfiguration = {};
  if (value.flags !== undefined) {
    if (!isPlainObject(value.flags)) throw new Error('productionConfiguration.flags must map flag keys to booleans');
    for (const [key, flag] of Object.entries(value.flags)) {
      if (typeof flag !== 'boolean') throw new Error(`productionConfiguration.flags.${key} must be a boolean`);
      if (!isRegisteredFlag(key)) {
        throw new Error(`productionConfiguration.flags.${key} is not a registered feature flag (libs/flags/src/types.ts)`);
      }
    }
    if (Object.keys(value.flags).length) out.flags = { ...(value.flags as Record<string, boolean>) };
  }
  if (value.env !== undefined) {
    if (!isPlainObject(value.env)) throw new Error('productionConfiguration.env must map env var names to strings');
    for (const [key, envValue] of Object.entries(value.env)) {
      if (typeof envValue !== 'string') throw new Error(`productionConfiguration.env.${key} must be a string`);
      if (!SNAPSHOT_ENV_KEY.test(key)) {
        throw new Error(`productionConfiguration.env.${key} is not a recorded env var (allowed: ${SNAPSHOT_ENV_KEY.source})`);
      }
    }
    if (Object.keys(value.env).length) out.env = { ...(value.env as Record<string, string>) };
  }
  return out.flags || out.env ? out : null;
}

/** The value a run resolved for a flag, from its recorded flag inputs. Null for an unknown key. */
export function resolvedRunFlag(snapshot: ConfigurationSnapshot, key: string): boolean | null {
  return resolveFlagFromEnv(key, snapshot.flagEnv).value;
}

/** Canonical projection: sorted keys; a declared key the run cannot answer is `null`. */
function fingerprintProjection(flags: Record<string, boolean | null>, envSha256: Record<string, string | null>): string {
  const canonical = JSON.stringify({
    flags: Object.keys(flags).sort().map((key) => [key, flags[key]]),
    env: Object.keys(envSha256).sort().map((key) => [key, envSha256[key]]),
  });
  return `${DECLARED_CONFIGURATION_FINGERPRINT_PREFIX}${sha256Hex(canonical)}`;
}

/** Fingerprint of what a bar declares. */
export function declaredConfigurationFingerprint(declared: ProductionConfiguration): string {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(declared.env ?? {})) env[key] = sha256Hex(value);
  return fingerprintProjection({ ...(declared.flags ?? {}) }, env);
}

/** Fingerprint of a run's snapshot projected onto the declared keys. */
export function evidenceConfigurationFingerprint(
  snapshot: ConfigurationSnapshot,
  declared: ProductionConfiguration,
): string {
  const flags: Record<string, boolean | null> = {};
  for (const key of Object.keys(declared.flags ?? {})) flags[key] = resolvedRunFlag(snapshot, key);
  const env: Record<string, string | null> = {};
  for (const key of Object.keys(declared.env ?? {})) env[key] = snapshot.envSha256[key] ?? null;
  return fingerprintProjection(flags, env);
}

/** Bind-time judgement: does this run's snapshot match the bar's declared configuration? */
export function judgeDeclaredConfiguration(
  declared: ProductionConfiguration,
  snapshot: ConfigurationSnapshot | null,
): DeclaredConfigurationVerdict {
  const declaredFingerprint = declaredConfigurationFingerprint(declared);
  if (!snapshot) {
    return {
      ok: false,
      code: 'declared_configuration_fingerprint_missing',
      declaredFingerprint,
      fingerprint: null,
      differing: [],
      message:
        'the bar declares verification.productionConfiguration, but this evidence carries no configuration '
        + 'snapshot (no declared-configuration fingerprint). Re-run it through testing:run or '
        + 'scripts/mutation-probe.sh, which record the snapshot, and bind that run.',
    };
  }
  const fingerprint = evidenceConfigurationFingerprint(snapshot, declared);
  if (fingerprint === declaredFingerprint) return { ok: true, fingerprint, declaredFingerprint };
  const flagDiffs = Object.entries(declared.flags ?? {})
    .map(([key, value]) => ({ key, value, observed: resolvedRunFlag(snapshot, key) }))
    .filter((d) => d.observed !== d.value);
  const envDiffs = Object.entries(declared.env ?? {})
    .filter(([key, value]) => snapshot.envSha256[key] !== sha256Hex(value))
    .map(([key]) => key);
  const differing = [...flagDiffs.map((d) => `flag:${d.key}`), ...envDiffs.map((key) => `env:${key}`)].sort();
  const detail = [
    ...flagDiffs.map((d) => `flag ${d.key} declared ${d.value}, run resolved ${d.observed}`),
    ...envDiffs.map((key) => `env ${key} ${snapshot.envSha256[key] ? 'had a different value' : 'was unset'}`),
  ].join('; ');
  return {
    ok: false,
    code: 'declared_configuration_fingerprint_mismatch',
    declaredFingerprint,
    fingerprint,
    differing,
    message:
      `the run's configuration differs from the bar's declared verification.productionConfiguration (${detail}). `
      + 'Re-run under the declared configuration and bind that run.',
  };
}
