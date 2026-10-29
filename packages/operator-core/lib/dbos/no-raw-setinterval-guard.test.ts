/**
 * no-raw-setinterval-guard.test.ts — the no-raw-setInterval CI guard's detection
 * predicate (schedule-inventory-and-ephemeral-tier-2026-06-26, P-007).
 *
 * The guard (`scripts/check-no-raw-setinterval.mjs`) runs green on the clean tree
 * (no-false-positive direction). This locks the direction P-007 actually asks for —
 * that it FLAGS a NEW bare setInterval() while NOT flagging managedSetInterval, the
 * injectable timer seam, type references, or prose mentions in comments.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicate only.
import { findOffenders, usesRawSetInterval } from '../../../../scripts/check-no-raw-setinterval.mjs';
// @ts-ignore — maintained bare-node guard.
import { findFetchTimers, ROOTS, SEED_HASH } from '../../../../scripts/check-client-fetch-in-timer.mjs';
// @ts-ignore — shared bare-node policy validator.
import { fingerprint, judgeSites, validatePolicy } from '../../../../scripts/lib/shrink-only-guard.mjs';

const timerPolicy = () => JSON.parse(readFileSync(new URL('../../../../scripts/client-fetch-in-timer-baseline.json', import.meta.url), 'utf8'));

it('rules events reuse R-2 rejects a fetch timer in every declared UI source root', () => {
  for (const root of ROOTS) {
    for (const source of [
      "setInterval(() => fetch('/api/work'), 1000)",
      "const read = () => fetch('/api/work'); const poll = () => read(); window.setInterval(poll, 1000)",
      "function poll() { fetch('/api/work'); setTimeout(poll, 1000); } poll()",
    ]) {
      const sites = findFetchTimers(source, root + 'NewPoller.tsx');
      expect(sites.length).toBeGreaterThan(0);
      expect(judgeSites(sites, timerPolicy(), SEED_HASH).offenders).toEqual(sites);
    }
    expect(findFetchTimers("// setInterval(() => fetch('/api'), 1)\nconst prose = `setInterval(() => fetch('/api'), 1)`;", root + 'Prose.tsx')).toEqual([]);
    expect(findFetchTimers("setTimeout(() => fetch('/api/work'), 1000)", root + 'OneShot.tsx')).toEqual([]);
  }
  expect(findFetchTimers("setInterval(() => fetch('/api'), 1)", 'packages/operator-core/lib/host.ts')).toEqual([]);
});

it('rules events reuse R-17 refuses growth of the measured client polling baseline', () => {
  const policy = timerPolicy();
  expect(SEED_HASH).toBe('f8d2fa050fe3e411e8acb42ac362d85f225e62a377466c0deaba59c0ed54631a');
  expect(validatePolicy(policy, SEED_HASH)).toEqual([]);
  const reduced = { ...policy, baseline: policy.baseline.slice(1) };
  expect(validatePolicy(reduced, SEED_HASH)).toEqual([]);
  expect(judgeSites([{ key: policy.baseline[0] }], reduced, SEED_HASH).offenders).toHaveLength(1);
  const added = 'apps/operator-vite/src/NewPoller.tsx#new';
  expect(validatePolicy({ ...policy, baseline: [...policy.baseline, added] }, SEED_HASH)).toContain(`baseline growth: ${added}`);
  expect(validatePolicy({ ...policy, initial: [...policy.initial, added], baseline: [...policy.baseline, added] }, SEED_HASH)).toContain('measured initial list changed');
  // A new callback in an old file is not grandfathered by the filename.
  const file = policy.baseline[0].split('#')[0];
  expect(judgeSites(findFetchTimers("setInterval(() => fetch('/api/brand-new'), 17)", file), policy, SEED_HASH).offenders).toHaveLength(1);
  expect(fingerprint(JSON.stringify(policy.initial))).toBe(SEED_HASH);
});

it('rules events reuse R-18 requires a reason for each retained clock lease and transport timer', () => {
  const policy = timerPolicy();
  expect(Object.values(policy.allowlist).length).toBeGreaterThan(0);
  for (const reason of Object.values(policy.allowlist)) expect(String(reason).trim().length).toBeGreaterThanOrEqual(24);
  for (const [kind, source] of Object.entries({
    clock: 'setInterval(() => setNow(Date.now()), 1000)',
    lease: 'setInterval(() => channel.postMessage({ heartbeat: Date.now() }), 1000)',
    external: "setInterval(() => fetch('/api/external-process'), 1000)",
    fallback: "setInterval(() => fetch('/api/transport-fallback'), 1000)",
  })) {
    const sites = findFetchTimers(source, ROOTS[0] + kind + '.tsx');
    if (sites.length) {
      const key = sites[0].key;
      const allowed = { ...policy, allowlist: { ...policy.allowlist, [key]: `${kind}: real clock, lease, external process or degraded transport requires sampling.` } };
      expect(judgeSites(sites, allowed, SEED_HASH).offenders).toEqual([]);
      expect(validatePolicy({ ...allowed, allowlist: { [key]: '' } }, SEED_HASH)).toContain(`exception requires a reason: ${key}`);
    } else expect(['clock', 'lease']).toContain(kind);
  }
});

describe('no-raw-setinterval guard predicate (P-007)', () => {
  it('classifies the actual killed-owner fixture as a separate test process', () => {
    const path = 'scripts/lib/runtime-compatibility-admission.mjs';
    const source = readFileSync(new URL('../../../../' + path, import.meta.url), 'utf8');
    // The real raw timer remains detectable; only its process classification differs.
    expect(usesRawSetInterval(source, path)).toBe(true);
    expect(findOffenders().offenders).not.toContain(path);
  });

  it('FLAGS a bare setInterval(...) call', () => {
    expect(usesRawSetInterval('const t = setInterval(() => tick(), 1000);')).toBe(true);
  });

  it('FLAGS window./global.setInterval(...) forms', () => {
    expect(usesRawSetInterval('const t = window.setInterval(poll, 500);')).toBe(true);
    expect(usesRawSetInterval('globalThis.setInterval(beat, 2000);')).toBe(true);
  });

  it('does NOT flag managedSetInterval(...) (the registry wrapper)', () => {
    expect(
      usesRawSetInterval("managedSetInterval('x', 1000, fn, { category: 'global-sweep' });"),
    ).toBe(false);
  });

  it('does NOT flag the injectable timer seam (setIntervalImpl / setIntervalFn)', () => {
    expect(usesRawSetInterval('const h = opts.setIntervalImpl(cb, ms);')).toBe(false);
    expect(usesRawSetInterval('const setIv = deps.setIntervalFn ?? setInterval;')).toBe(false); // bare ref, no call
  });

  it('does NOT flag a type-level reference (typeof setInterval)', () => {
    expect(usesRawSetInterval('let timer: ReturnType<typeof setInterval> | null = null;')).toBe(false);
  });

  it('does NOT flag a setInterval() mentioned only in a comment (comments are stripped)', () => {
    const codeWithComment = [
      '// the legacy setInterval() worker stood down once DBOS owned the schedule',
      '/** Replaces the setInterval(...) ticker. */',
      "managedSetInterval('y', 2000, fn, { category: 'watchdog' });",
    ].join('\n');
    expect(usesRawSetInterval(codeWithComment)).toBe(false);
  });
});
