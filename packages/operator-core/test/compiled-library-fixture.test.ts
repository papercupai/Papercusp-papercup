import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { compileLibraryFixture } from './compiled-library-fixture';

const root = resolve(import.meta.dirname, '../../..');

it('keeps the real workspace test launcher inert inside a compiled library fixture', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'compiled-library-fixture-'));
  try {
    const output = join(temporary, 'consumer.mjs');
    const guard = join(temporary, 'guard.mjs');
    // A missing bundle marker used to start a whole Vitest suite. Exercise that
    // real launcher, but intercept its spawn before it can start any process.
    writeFileSync(guard, [
      "import childProcess from 'node:child_process';",
      "import { syncBuiltinESMExports } from 'node:module';",
      'childProcess.spawnSync = (command, args) => {',
      '  console.log(JSON.stringify({ unexpectedChild: { command, args } }));',
      '  return { status: 7 };',
      '};',
      'syncBuiltinESMExports();',
    ].join('\n'));
    await compileLibraryFixture(root, join(root, 'scripts/workspace-test.mjs'), output);
    const result = spawnSync(process.execPath, ['--import', guard, output], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}, 60_000);
