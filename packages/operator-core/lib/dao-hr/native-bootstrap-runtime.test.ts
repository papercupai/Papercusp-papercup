import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { nativeBootstrapEnvironment, runNativeVerifier } from './native-bootstrap-runtime';
import { verifierSourceFiles } from '../verifier-source';

const repo = resolve(import.meta.dirname, '../../../..');

describe('native bootstrap admission and lifecycle', () => {
  it('establishes one canonical group and preserves inherited attribution', () => {
    const env = nativeBootstrapEnvironment({ PAPERCUSP_WORKSPACE_ID: 'fixture' }, 'postgresql://fixture/ledger');
    expect(env.PAPERCUSP_TEST_RUN_GROUP).toMatch(/^dao-hr-native-[a-f0-9-]+$/);
    expect(env.PAPERCUSP_TEST_RUN_WORKSPACE).toBe('fixture');
    expect(nativeBootstrapEnvironment({ ...env, PAPERCUSP_WORKSPACE_ID: 'private-native-host' },
      env.PAPERCUSP_TEST_RUNS_DB_URL!)).toMatchObject({
      PAPERCUSP_TEST_RUN_GROUP: env.PAPERCUSP_TEST_RUN_GROUP,
      PAPERCUSP_TEST_RUN_WORKSPACE: 'fixture', PAPERCUSP_TEST_RUNS_DB_URL: env.PAPERCUSP_TEST_RUNS_DB_URL });
    expect(nativeBootstrapEnvironment({ ...env, PAPERCUSP_TEST_RUN_GROUP: 'outer-run' }, 'postgresql://fixture/ledger')
      .PAPERCUSP_TEST_RUN_GROUP).toBe('outer-run');
  });

  it('refuses missing ledger scope before allocation', () => {
    expect(() => nativeBootstrapEnvironment({}, 'postgresql://fixture/ledger')).toThrow('WORKSPACE');
    expect(() => nativeBootstrapEnvironment({ PAPERCUSP_WORKSPACE: 'fixture' }, '')).toThrow('DB_URL');
  });

  it('checks the DAO assertion run group before native preparation', () => {
    const assertion = join(repo, 'scripts/tauri-surface-verify-dao-hr.mts');
    const required = readFileSync(assertion, 'utf8').match(/REQUIRED_ENV=(.*)/)![1].split(',');
    const env = { ...process.env, ...Object.fromEntries(required.map(key => [key, 'fixture'])),
      PAPERCUSP_TEST_RUN_GROUP: '' };
    let failure: { status: number; stderr: Buffer } | undefined;
    try { execFileSync(process.execPath, [join(repo, 'scripts/lib/verify-tauri-assertion-env.mjs'),
      '--command', 'node', '--import', 'tsx', assertion], { env, stdio: 'pipe' }); }
    catch (error) { failure = error as typeof failure; }
    expect(failure?.status).toBe(2);
    expect(String(failure?.stderr)).toContain('PAPERCUSP_TEST_RUN_GROUP is required before verifier preparation');
  });

  it.each(['cancel', 'deadline'] as const)('joins a verifier and its grandchild on %s', async mode => {
    const dir = mkdtempSync(join(tmpdir(), 'daohr-verifier-lifecycle-'));
    const ready = join(dir, 'ready'), leaked = join(dir, 'late-effect');
    const controller = new AbortController();
    const grandchild = `process.on('SIGTERM', () => {
      setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(leaked)}, 'leaked'), 500);
    }); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid));
    setInterval(() => {}, 1000);`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}],
      { stdio: 'inherit' }); setInterval(() => {}, 1000);`;
    try {
      const running = runNativeVerifier(process.execPath, ['-e', parent], {
        signal: controller.signal, timeoutMs: 10_000,
        killGraceMs: 50, stdio: 'ignore' });
      // Attach immediately so a deadline cannot become an unhandled rejection.
      const outcome = running.catch(error => error as Error);
      const started = Date.now();
      while (!existsSync(ready) && Date.now() - started < 8000) await delay(25);
      expect(existsSync(ready)).toBe(true);
      if (mode === 'cancel') controller.abort();
      expect(await outcome).toMatchObject({ message: expect.stringMatching(mode === 'cancel' ? /cancelled/ : /budget/) });
      await delay(700);
      expect(existsSync(leaked), 'a descendant must not write after joined teardown').toBe(false);
    } finally {
      controller.abort();
      // The deliberately hostile fixture must also be cleaned when the guard regresses.
      if (existsSync(ready)) {
        const pid = Number(readFileSync(ready, 'utf8'));
        if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('refuses an already cancelled or exhausted launch without starting a child', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(runNativeVerifier('does-not-exist', [], { signal: controller.signal, timeoutMs: 10 }))
      .rejects.toThrow();
    await expect(runNativeVerifier('does-not-exist', [], { signal: new AbortController().signal, timeoutMs: 0 }))
      .rejects.toThrow('preparation budget');
  });

  it.each(['prepare', 'boot', 'assert'] as const)('enforces a separate %s phase budget and retains its output', async phase => {
    const dir = mkdtempSync(join(tmpdir(), 'daohr-verifier-phase-'));
    const log = join(dir, 'output.log'), fd = openSync(log, 'w');
    const controller = new AbortController();
    // Repeated markers simulate noisy progress; they must never renew a phase.
    const marker = phase === 'prepare' ? '' : `console.error('VH_BEGIN phase=${phase}');`;
    const program = marker + `setInterval(() => { ${marker} }, 10);`;
    try {
      await expect(runNativeVerifier(process.execPath, ['-e', program], {
        signal: controller.signal, timeoutMs: 10_000, killGraceMs: 25, logFd: fd,
        phaseBudgetsMs: { prepare: phase === 'prepare' ? 250 : 8000, boot: 150, assert: 150 },
      })).rejects.toThrow(`Native verifier ${phase} phase exceeded`);
      if (phase !== 'prepare') {
        const output = readFileSync(log, 'utf8');
        expect(output.match(new RegExp(`VH_BEGIN phase=${phase}`, 'g'))!.length).toBeGreaterThan(1);
      }
    } finally { controller.abort(); closeSync(fd); rmSync(dir, { recursive: true, force: true }); }
  }, 15_000);

  it.each(['disabled', 'retention-failed', 'missing'] as const)(
    'advances verifier deadlines when optional instrumentation is %s', async mode => {
      const dir = mkdtempSync(join(tmpdir(), 'daohr-verifier-uninstrumented-'));
      const log = join(dir, 'output.log'), fd = openSync(log, 'w');
      const controller = new AbortController();
      const shell = readFileSync(join(repo, 'scripts/verify-tauri-headless.sh'), 'utf8');
      // Execute the real initialization and section boundaries, including vh.sh's
      // fail-open path. A synthetic marker producer would miss this coupling.
      const start = shell.indexOf('# ── Verification-harness contract');
      const end = shell.indexOf("\ntrap 'handle_signal INT' INT", start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const section = (phase: string) => {
        const call = shell.match(new RegExp(`^(?:verifier_begin_phase|vh_begin) ${phase}$`, 'm'));
        expect(call, `real ${phase} section boundary`).not.toBeNull();
        return call![0];
      };
      const program = ['set -eu', shell.slice(start, end),
        'printf "OPTIONAL_DISABLED=%s\\n" "${VH_DISABLED:-missing}"',
        'sleep 2', section('boot'), 'sleep 2', section('assert'), 'sleep 2'].join('\n');
      try {
        await expect(runNativeVerifier('bash', ['-c', program], {
          signal: controller.signal, timeoutMs: 15_000, killGraceMs: 25, logFd: fd,
          phaseBudgetsMs: { prepare: 3000, boot: 3000, assert: 3000 },
          env: { ...process.env, REPO_DIR: mode === 'missing' ? dir : repo,
            VH_DISABLE: mode === 'disabled' ? '1' : '0', VH_FAIL_OPEN: '1',
            VH_TSX: '/bin/false', VERIFY_TAURI_EVIDENCE_ROOT: join(dir, 'evidence'),
            VERIFY_TAURI_SOURCE_REF: '' },
        })).resolves.toBe(0);
        const output = readFileSync(log, 'utf8');
        for (const phase of ['prepare', 'boot', 'assert']) expect(output).toContain(`VH_BEGIN phase=${phase}`);
        expect(output).toContain(`OPTIONAL_DISABLED=${mode === 'missing' ? 'missing' : '1'}`);
        expect(output).not.toMatch(/^HARNESS_RESULT(?:\s|$)/m);
        if (mode === 'retention-failed') expect(output).toContain('reason=retention-command-failed');
      } finally { controller.abort(); closeSync(fd); rmSync(dir, { recursive: true, force: true }); }
    }, 20_000);
});

describe('nested frozen verifier scratch boundary', () => {
  it.each(['hardlink', 'copy'])('keeps %s snapshots outside the attested donor archive', mode => {
    const dir = mkdtempSync(join(tmpdir(), 'daohr-snapshot-boundary-'));
    const sourceRoot = join(dir, 'source'), temporary = join(sourceRoot, 'temporary');
    mkdirSync(temporary, { recursive: true });
    writeFileSync(join(sourceRoot, 'helper.ts'), 'export const committed = true;\n');
    writeFileSync(join(sourceRoot, '.verifier-source.json'), '{}');
    const census = verifierSourceFiles(sourceRoot);
    const shell = readFileSync(join(repo, 'scripts/verify-tauri-headless.sh'), 'utf8');
    const select = shell.match(/select_verifier_snapshot_root\(\) \{[\s\S]*?\n\}/)![0];
    try {
      const parent = execFileSync('bash', ['-c', select + '\nselect_verifier_snapshot_root'], {
        encoding: 'utf8', env: { ...process.env, REPO_DIR: sourceRoot, TMPDIR: temporary,
          VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE: mode } }).trim();
      expect(parent).toBe(dir);
      const generated = mkdtempSync(join(parent, 'verify-tauri-headless.'));
      writeFileSync(join(generated, '.papercusp-run'), 'fixture');
      expect(verifierSourceFiles(sourceRoot)).toEqual(census);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('uses the sibling filesystem for cross-device hardlinks from a frozen source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daohr-snapshot-cross-device-'));
    const sourceRoot = join(dir, 'source'), temporary = join(dir, 'other-device');
    mkdirSync(sourceRoot); mkdirSync(temporary);
    writeFileSync(join(sourceRoot, '.verifier-source.json'), '{}');
    const shell = readFileSync(join(repo, 'scripts/verify-tauri-headless.sh'), 'utf8');
    const select = shell.match(/select_verifier_snapshot_root\(\) \{[\s\S]*?\n\}/)![0];
    try {
      const parent = execFileSync('bash', ['-c',
        'stat() { if [ "${@: -1}" = "$TMPDIR" ]; then echo 2; else echo 1; fi; }\n' + select + '\nselect_verifier_snapshot_root'], {
        encoding: 'utf8', env: { ...process.env, REPO_DIR: sourceRoot, TMPDIR: temporary,
          VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE: 'hardlink' } }).trim();
      expect(parent).toBe(dir);
      expect(existsSync(join(sourceRoot, '.papercusp'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
