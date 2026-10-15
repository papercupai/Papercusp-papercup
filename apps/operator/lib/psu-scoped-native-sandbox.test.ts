import { it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';
import { runWrapper } from '../scripts/psu-launcher.mjs';

const fixture = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'psu-required-boundary-'));
  const marker = join(cwd, 'unconfined-spawn');
  mkdirSync(join(cwd, 'codex'));
  return { cwd, marker, env: hermeticEnv({
    PAPERCUSP_AGENT: 'codex', CODEX_HOME: join(cwd, 'codex'),
    PAPERCUSP_SID: 'test-scoped-boundary', PAPERCUSP_PSU_HEADLESS: '1',
    PAPERCUSP_PSU_PTY: '1', PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071',
    PAPERCUSP_SCOPED_INFERENCE_GATEWAY: JSON.stringify({ baseURL: 'http://127.0.0.1:32001', token: 'a'.repeat(64) }),
  }) };
};

it.each(['disabled managed PTY', 'missing required SRT'])('refuses %s before a native or plain-fallback process starts', mode => {
  const f = fixture(); let failed = 0;
  const env: NodeJS.ProcessEnv = { ...f.env, ...(mode === 'disabled managed PTY' ? { PAPERCUSP_PSU_NO_PTY: '1' } : { PATH: f.cwd }) };
  try {
    expect(existsSync(env.CODEX_HOME!)).toBe(true);
    expect(() => runWrapper({
      wrapperBin: '/bin/sh', args: ['-c', 'touch "$1"', 'boundary-fixture', f.marker],
      cwd: f.cwd, preserveCwd: true, envelopeEnv: env,
      onSpawnFailure: () => { failed++; },
    })).toThrow(mode === 'disabled managed PTY' ? /managed PTY boundary/ : /requires SRT/);
    expect(failed).toBe(1);
    expect(existsSync(f.marker)).toBe(false);
  } finally { rmSync(f.cwd, { recursive: true, force: true }); }
});
