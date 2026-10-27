import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('attaches the official Proximus ToolExecutor through the actual pinned Harbor BaseEnvironment', async () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const project = resolve(root, 'packages/operator-core/vendor/proximus');
  const lock = createHash('sha256').update(readFileSync(join(project, 'uv.lock'))).digest('hex').slice(0, 16);
  const { stdout, stderr } = await promisify(execFile)('uv', ['run', '--frozen', '--no-dev', '--python', '3.12',
    '--project', project, 'python', resolve(root, 'packages/operator-core/test/proximus_environment_test.py')], {
    timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, UV_PROJECT_ENVIRONMENT: join(tmpdir(), `papercusp-proximus-${lock}`) },
  });
  expect(stdout + stderr).toContain('Ran 10 tests');
  expect(stderr).toMatch(/\bOK\b/);
}, 130_000);
