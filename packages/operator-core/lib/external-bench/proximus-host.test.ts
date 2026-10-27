import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { measureProximusRuntime, prepareProximusRuntime } from './proximus-runtime';

it('prepares the frozen official runtime through the maintained uv installer and measures its actual bytes', async () => {
  const prepared = await prepareProximusRuntime();
  expect(prepared.pythonBin).toMatch(/\/papercusp-proximus-[a-f0-9]{16}\/bin\/python(?:3(?:\.12)?)?$/);
  expect(prepared.runtime).toMatchObject({ schemaVersion: 1,
    sourceRevision: 'a989f7b35c95c0fd30603290da3c923b7898cba8',
    clientVersion: 'harbor-proximus@0.1.0a1', harborVersion: '0.23.0' });
  expect(prepared.runtime.runtimeRevision).toMatch(/^[a-f0-9]{64}$/);
  expect(prepared.runtime.fileCount).toBeGreaterThan(100);
}, 130_000);

it('verifies and runs the unchanged official Proximus host through the pinned Harbor contracts offline', async () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const project = resolve(root, 'packages/operator-core/vendor/proximus');
  const lock = createHash('sha256').update(readFileSync(join(project, 'uv.lock'))).digest('hex').slice(0, 16);
  const { stdout, stderr } = await promisify(execFile)('uv', ['run', '--frozen', '--no-dev', '--python', '3.12',
    '--project', project, 'python', resolve(root, 'packages/operator-core/test/proximus_host_test.py')], {
    timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', LITELLM_LOCAL_MODEL_COST_MAP: 'True',
      UV_PROJECT_ENVIRONMENT: join(tmpdir(), `papercusp-proximus-${lock}`) },
  });
  expect(stdout + stderr).toContain('Ran 7 tests');
  expect(stderr).toMatch(/\bOK\b/);
  const interpreter = await promisify(execFile)('uv', ['run', '--frozen', '--no-dev', '--python', '3.12',
    '--project', project, 'python', '-c', 'import sys;print(sys.executable)'], {
    timeout: 30_000, env: { ...process.env, UV_PROJECT_ENVIRONMENT: join(tmpdir(), `papercusp-proximus-${lock}`) },
  });
  const measured = await measureProximusRuntime({ pythonBin: interpreter.stdout.trim() });
  expect(measured).toMatchObject({ schemaVersion: 1, sourceRevision: 'a989f7b35c95c0fd30603290da3c923b7898cba8',
    clientVersion: 'harbor-proximus@0.1.0a1', harborVersion: '0.23.0' });
  expect(measured.runtimeRevision).toMatch(/^[a-f0-9]{64}$/);
  expect(measured.fileCount).toBeGreaterThan(100);
}, 130_000);
