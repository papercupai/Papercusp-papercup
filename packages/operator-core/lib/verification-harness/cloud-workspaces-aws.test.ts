import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const SCRIPT = path.join(REPO, 'scripts/verify-cloud-workspaces-aws.mjs');

describe('AWS native UI verification contract', () => {
  it('records the cheap selector phase and refuses native work without its isolated runtime', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cloud-aws-contract-'));
    const run = (args: string[], vars: Record<string, string> = {}) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        const env: NodeJS.ProcessEnv = { ...process.env, VH_EVIDENCE_ROOT_BASE: root, VH_GUARD_RAIL_SOURCE: '' };
        for (const name of Object.keys(env)) if (name.startsWith('VERIFY_TAURI_')) delete env[name];
        Object.assign(env, vars);
        execFile(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
          cwd: REPO, env, timeout: 30_000,
        }, (error, stdout, stderr) => {
          const code = error ? error.code : 0;
          if (typeof code !== 'number') return reject(error);
          resolve({ code, stdout, stderr });
        });
      });
    const evidence = async () => JSON.parse(await readFile(path.join(root, 'cloud-workspaces-aws/latest/result.json'), 'utf8'));
    try {
      const cheap = await run(['--preflight']);
      expect(cheap.code, cheap.stderr).toBe(0);
      expect(cheap.stdout).toContain('CW_AWS_NATIVE_PREFLIGHT passed: lifecycle label contract');
      expect(cheap.stdout).not.toContain('CW_AWS_NATIVE_RESULT');
      const first = await evidence();
      expect(first.verdict).toBe('pass');
      expect(first.phases).toEqual([
        expect.objectContaining({ phase: 'selectors', status: 'passed', step: 'lifecycle-label-contract' }),
        expect.objectContaining({ phase: 'native', status: 'skipped' }),
      ]);

      const refused = await run([]);
      expect(refused.code).toBe(1);
      expect(refused.stdout).not.toContain('CW_AWS_NATIVE_RESULT');
      const second = await evidence();
      expect(second.runId).not.toBe(first.runId);
      expect(second.verdict).toBe('fail');
      expect(second.firstFailure).toMatchObject({ phase: 'native', step: 'isolated-runtime-preconditions' });
      expect(second.phases).toEqual([
        expect.objectContaining({ phase: 'selectors', status: 'passed' }),
        expect.objectContaining({ phase: 'native', status: 'failed', detail: expect.stringContaining('Missing VERIFY_TAURI_PID') }),
      ]);
      const retained = JSON.parse(await readFile(path.join(first.evidenceDir, 'result.json'), 'utf8'));
      expect(retained.verdict).toBe('pass');

      const sharedDisplay = await run(['--from', 'native', '--reuse', first.evidenceDir], {
        VERIFY_TAURI_PID: '0', VERIFY_TAURI_DISPLAY: ':0', PAPERCUSP_VERIFY_TAURI_ISOLATED: '1',
      });
      expect(sharedDisplay.code).toBe(1);
      const third = await evidence();
      expect(third.phases).toEqual([
        expect.objectContaining({ phase: 'selectors', status: 'passed' }),
        expect.objectContaining({ phase: 'native', status: 'failed', detail: expect.stringContaining('Refusing a shared database or desktop display') }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
