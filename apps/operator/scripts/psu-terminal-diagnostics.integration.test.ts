// @vitest-environment node
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import * as pty from '@lydell/node-pty';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const launcher = fileURLToPath(new URL('./psu-launcher.mjs', import.meta.url));
// --import resolves relative to child cwd; Local startup deliberately uses HOME.
const tsxLoader = createRequire(import.meta.url).resolve('tsx');
const env = {
  PATH: process.env.PATH ?? '',
  VTE_VERSION: '7600',
  PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9',
};

describe('psu --terminal-check offline CLI', () => {
  it('prints guidance and exits without a control-plane connection', async () => {
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', tsxLoader, launcher, '--terminal-check'], {
        cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let error = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('offline diagnostic did not exit')); }, 8000);
      child.stdout.on('data', (data) => { output += data; });
      child.stderr.on('data', (data) => { error += data; });
      child.on('error', (failure) => { clearTimeout(timer); reject(failure); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`diagnostic exited ${code}: ${error}`));
        else resolve(output);
      });
    });
    expect(result).toContain('local, read-only');
    expect(result).toContain('alacritty -e psu');
    expect(result).toContain('No interactive stdin');
  }, 10_000);

  it.skipIf(process.platform === 'win32')('measures software flow control in the affected real terminal', async () => {
    const result = await new Promise<string>((resolve, reject) => {
      const child = pty.spawn('/bin/bash', [
        '-c', 'stty ixon; exec "$@"', 'terminal-check',
        process.execPath, '--import', tsxLoader, launcher, '--terminal-check',
      ], { cwd: root, env, cols: 80, rows: 24 });
      let output = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('interactive diagnostic did not exit')); }, 8000);
      child.onData((data) => { output += data; });
      child.onExit(({ exitCode }) => {
        clearTimeout(timer);
        if (exitCode !== 0) reject(new Error(`interactive diagnostic exited ${exitCode}: ${output}`));
        else resolve(output);
      });
    });
    expect(result).toContain('Software flow control: enabled');
    expect(result).toContain('press Ctrl-Q');
    expect(result).toContain('stty -ixon');
  }, 10_000);
});

// WI-6554700010008755: exercise the actual Local-to-first-menu wiring, rather
// than only the timing helpers. This checks the detector, not the reported stall.
describe('plain Local startup trace', () => {
  it.skipIf(process.platform === 'win32')('skips handoff discovery on a managed first launch and records the first menu', async () => {
    const home = mkdtempSync(join(tmpdir(), 'psu-local-startup-'));
    try {
      const ptyDir = join(home, '.papercusp', 'psu-pty');
      mkdirSync(ptyDir, { recursive: true });
      // Reading this handoff blocks until another process writes it. An
      // accidental full-directory scan therefore cannot reach the first menu.
      execFileSync('mkfifo', [join(ptyDir, 'scan-guard.handoff.json')]);
      const result = await new Promise<{ output: string; exitCode: number }>((resolve, reject) => {
        const child = pty.spawn(process.execPath, ['--import', tsxLoader, launcher], {
          cwd: home, env: {
            ...env, HOME: home,
            PAPERCUSP_PSU_REEXEC: '87',
            PAPERCUSP_PSU_REEXEC_PPID: String(process.pid),
            PAPERCUSP_PSU_REEXEC_COUNT: '0',
          }, cols: 120, rows: 30,
        });
        let output = '';
        let selectedLocal = false;
        let sawMenu = false;
        const diagnostics = () => {
          let trace = '';
          try {
            const logs = join(home, '.papercusp', 'psu-launch-logs');
            trace = readdirSync(logs).filter((file) => file.startsWith('startup-'))
              .map((file) => readFileSync(join(logs, file), 'utf8')).join('\n').slice(-8192);
          } catch { /* no startup records exist before Local is selected */ }
          return `${stripVTControlCharacters(output)}\nStartup records:\n${trace || '(none)'}`;
        };
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Local startup did not complete first-menu observation: ${diagnostics()}`));
        }, 8000);
        child.onData((data) => {
          output = (output + data).slice(-8192);
          const visible = stripVTControlCharacters(output);
          if (!selectedLocal && visible.includes('Local — this computer')) {
            selectedLocal = true;
            child.write('\r');
          }
          if (!sawMenu && visible.includes('? Subagents')) {
            sawMenu = true;
            // Stop while the first prompt is awaiting input; no backend runs.
            child.write('\x03');
          }
        });
        child.onExit(({ exitCode }) => {
          clearTimeout(timer);
          if (!sawMenu) reject(new Error(`Local startup exited without observing the first menu (${exitCode}): ${diagnostics()}`));
          else resolve({ output, exitCode });
        });
      });
      expect(result.exitCode).toBe(130);
      expect(result.output).toContain('GNOME/VTE terminal detected');
      const logs = join(home, '.papercusp', 'psu-launch-logs');
      const files = readdirSync(logs);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^startup-.+\.log$/);
      const text = readFileSync(join(logs, files[0]), 'utf8');
      const rows = text.split('\n').filter((line) => line.startsWith('# startup '))
        .map((line) => JSON.parse(line.slice('# startup '.length)));
      const finished = rows.filter((row) => row.phase === 'finished');
      expect(finished.map((row) => row.step)).toEqual([
        'terminal-notice', 'host-handoff-lookup', 'recovery-audit-reconciliation',
        'default-role', 'subagents-picker-import', 'menu-render:Subagents',
      ]);
      expect(new Set(rows.map((row) => row.pid)).size).toBe(1);
      expect(rows.every((row) => Number.isInteger(row.pid) && row.pid > 0)).toBe(true);
      expect(finished.every((row) => row.elapsedMs >= 0)).toBe(true);
      expect(text).not.toContain('GNOME/VTE terminal detected');
      expect(text).not.toContain('Local — this computer');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);
});
