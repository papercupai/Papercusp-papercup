/**
 * WI-10002031 — the installed-vs-canonical agent-hook drift detector.
 *
 * These tests use FIXTURE directories, never the real `~/.papercusp/hooks/cc`.
 * Two independent reasons, both measured on this repo:
 *
 * 1. A test that reads live machine state measures the RUNNER, not the contract
 *    (WI-10002057, same day: three tests read an ambient env var and so failed
 *    for every psu-launched agent while passing in CI).
 * 2. The real installed copy is LEGITIMATELY divergent until the
 *    EI-23749662191699491 fix reaches `:3070` and that operator restarts, so a
 *    test calibrated against it right now would be calibrated against a
 *    transient — the explicit ordering trap named on the work item.
 *
 * The behaviour that matters most is the REFUSAL: this guard's predecessor was
 * silently inert for ~6 weeks, and the reason a quiet guard survives that long
 * is that "measured nothing" and "found nothing" render identically. Several
 * assertions below exist specifically to keep those two outcomes distinguishable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  detectInstalledHookDrift,
  formatHookDriftSummary,
} from './installed-hook-drift';

describe('detectInstalledHookDrift (WI-10002031)', () => {
  let root = '';
  let canonicalDir = '';
  let installedDir = '';

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'hook-drift-'));
    canonicalDir = path.join(root, 'canonical');
    installedDir = path.join(root, 'installed');
    mkdirSync(canonicalDir, { recursive: true });
    mkdirSync(installedDir, { recursive: true });
  });

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const writeBoth = (name: string, canonical: string, installed = canonical) => {
    writeFileSync(path.join(canonicalDir, name), canonical);
    writeFileSync(path.join(installedDir, name), installed);
  };

  it('reports clean when every installed hook matches its canonical source', () => {
    writeBoth('ask-gate-mirror.sh', '#!/bin/bash\necho gate\n');
    writeBoth('pretooluse-secrets-guard.mjs', 'export const guard = 1;\n');

    const report = detectInstalledHookDrift({ canonicalDir, installedDir });

    expect(report.clean).toBe(true);
    expect(report.drifted).toEqual([]);
    expect(report.checked).toEqual(['ask-gate-mirror.sh', 'pretooluse-secrets-guard.mjs']);
  });

  // The recurring failure, twice over: same file, same shape, both times found
  // only because an agent hand-md5'd two files while debugging something else.
  it('catches a byte-divergent installed hook and reports BOTH hashes', () => {
    writeBoth(
      'ask-gate-mirror.sh',
      '#!/bin/bash\ntools_invoke_supported=1\n', // canonical (staging)
      '#!/bin/bash\n', // installed (the stale release copy)
    );

    const report = detectInstalledHookDrift({ canonicalDir, installedDir });

    expect(report.clean).toBe(false);
    expect(report.drifted).toHaveLength(1);
    const [drift] = report.drifted;
    expect(drift.name).toBe('ask-gate-mirror.sh');
    expect(drift.status).toBe('divergent');
    // Both sides are reported so the finding is actionable without re-deriving
    // them by hand — which is precisely how this class was found the slow way.
    expect(drift.canonicalSha256).toBeTruthy();
    expect(drift.installedSha256).toBeTruthy();
    expect(drift.canonicalSha256).not.toBe(drift.installedSha256);
  });

  it('flags a canonical hook that is missing from the install — an unarmed rail', () => {
    writeFileSync(path.join(canonicalDir, 'pretooluse-locks-acquire.sh'), 'lock\n');

    const report = detectInstalledHookDrift({ canonicalDir, installedDir });

    expect(report.clean).toBe(false);
    expect(report.drifted[0]).toMatchObject({
      name: 'pretooluse-locks-acquire.sh',
      status: 'missing-from-install',
      installedSha256: null,
    });
  });

  it('flags an installed hook with no canonical counterpart — a retired rail still firing', () => {
    writeFileSync(path.join(installedDir, 'retired-hook.sh'), 'still running\n');

    const report = detectInstalledHookDrift({ canonicalDir, installedDir });

    expect(report.clean).toBe(false);
    expect(report.drifted[0]).toMatchObject({
      name: 'retired-hook.sh',
      status: 'orphaned-in-install',
      canonicalSha256: null,
    });
  });

  it('ignores directory residue outside an explicit managed hook set', () => {
    writeBoth('managed-hook.sh', 'same\n');
    writeBoth('generated.d.mts', 'canonical declaration\n', 'stale declaration\n');
    writeFileSync(path.join(installedDir, 'retired-hook.sh'), 'unregistered legacy hook\n');

    const report = detectInstalledHookDrift({
      canonicalDir,
      installedDir,
      managedNames: ['managed-hook.sh'],
    });

    expect(report.checked).toEqual(['managed-hook.sh']);
    expect(report.drifted).toEqual([]);
    expect(report.clean).toBe(true);
  });

  it('ignores subdirectories rather than descending or comparing them', () => {
    writeBoth('ask-gate-mirror.sh', 'same\n');
    mkdirSync(path.join(canonicalDir, 'nested'), { recursive: true });
    writeFileSync(path.join(canonicalDir, 'nested', 'inner.sh'), 'inner\n');

    const report = detectInstalledHookDrift({ canonicalDir, installedDir });

    expect(report.checked).toEqual(['ask-gate-mirror.sh']);
    expect(report.clean).toBe(true);
  });

  describe('fail-closed: a failed measurement must never render as a clean machine', () => {
    it('REFUSES an explicit empty managed set instead of reporting a clean machine', () => {
      const report = detectInstalledHookDrift({ canonicalDir, installedDir, managedNames: [] });

      expect(report.refused).toBe('managed-set-empty');
      expect(report.clean).toBe(false);
      expect(report.checked).toEqual([]);
    });

    // This is the guard-on-the-guard. The predecessor went quiet for ~6 weeks
    // because it read an env var nothing set, and nothing distinguished that
    // silence from a healthy box.
    it('REFUSES when the canonical dir is unreadable, instead of reporting no drift', () => {
      const report = detectInstalledHookDrift({
        canonicalDir: path.join(root, 'does-not-exist'),
        installedDir,
      });

      expect(report.refused).toBe('canonical-dir-unreadable');
      // The three assertions that matter: not clean, nothing measured, and an
      // empty `drifted` list that cannot be mistaken for a passing verdict.
      expect(report.clean).toBe(false);
      expect(report.checked).toEqual([]);
      expect(report.drifted).toEqual([]);
    });

    it('REFUSES when the installed dir is unreadable', () => {
      writeFileSync(path.join(canonicalDir, 'ask-gate-mirror.sh'), 'x\n');

      const report = detectInstalledHookDrift({
        canonicalDir,
        installedDir: path.join(root, 'no-install-here'),
      });

      expect(report.refused).toBe('installed-dir-unreadable');
      expect(report.clean).toBe(false);
      expect(report.checked).toEqual([]);
    });

    it('reports an unreadable FILE as drift rather than silently treating it as equal', () => {
      writeBoth('ask-gate-mirror.sh', 'same\n');

      const report = detectInstalledHookDrift({
        canonicalDir,
        installedDir,
        readFileFn: (filePath: string) => {
          if (filePath.startsWith(installedDir)) throw new Error('EACCES');
          return Buffer.from('same\n');
        },
      });

      expect(report.clean).toBe(false);
      expect(report.drifted[0].status).toBe('unreadable');
      expect(report.drifted[0].detail).toContain('EACCES');
    });

    it('formats a refusal as NOT MEASURED, never as a zero-drift count', () => {
      const report = detectInstalledHookDrift({
        canonicalDir: path.join(root, 'missing'),
        installedDir,
      });

      const summary = formatHookDriftSummary(report);
      expect(summary).toContain('NOT MEASURED');
      expect(summary).toContain('canonical-dir-unreadable');
      // The whole point: a human skimming a sweep log must not read this as a
      // pass. Assert the absence of the clean VERDICT specifically — the refusal
      // text legitimately contains the word ("not a clean machine"), so matching
      // on the bare word tests the wording instead of the contract.
      expect(summary).not.toContain('hook-drift clean');
      expect(formatHookDriftSummary({
        canonicalDir: 'c', installedDir: 'i', checked: ['a.sh'], drifted: [], clean: true,
      })).toContain('hook-drift clean');
    });
  });

  it('names the drifted hooks in its summary so a sweep line is actionable', () => {
    writeBoth('ask-gate-mirror.sh', 'canonical\n', 'stale\n');

    const summary = formatHookDriftSummary(
      detectInstalledHookDrift({ canonicalDir, installedDir }),
    );

    expect(summary).toContain('DIVERGENT');
    expect(summary).toContain('ask-gate-mirror.sh:divergent');
  });
});
