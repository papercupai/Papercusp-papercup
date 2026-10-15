import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repository = resolve(import.meta.dirname, '../../..');
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function execute(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(resolveResult => {
    execFile(process.execPath, args, { timeout: 15000 }, (error, stdout, stderr) => {
      resolveResult({ code: error ? Number(error.code) : 0, stdout, stderr });
    });
  });
}

describe('heap snapshot analyzer CLI lifecycle', () => {
  it('keeps an inlined library import inert in the desktop sidecar', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'heap-cli-bundle-'));
    directories.push(directory);
    const bundle = join(directory, 'sidecar.mjs');
    symlinkSync(join(repository, 'node_modules'), join(directory, 'node_modules'), 'dir');
    await build({
      stdin: { contents: `import { summarizeHeapSnapshot } from ${JSON.stringify(join(repository, 'scripts/analyze-heap-snapshots.mjs'))}; console.log(typeof summarizeHeapSnapshot);`, resolveDir: repository },
      outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external',
      define: { __PAPERCUSP_BUNDLED_SIDECAR__: 'true' },
      plugins: [{ name: 'include-maintained-cli-entry', setup(builder) {
        builder.onResolve({ filter: /^@papercusp\/operator-core\/lib\/util\/cli-entry$/ }, () => ({
          path: join(repository, 'packages/operator-core/lib/util/cli-entry.ts'),
        }));
      } }],
    });
    const result = await execute([bundle, directory]);
    expect(result).toEqual({ code: 0, stdout: 'function\n', stderr: '' });
  });

  it('still executes main when invoked directly with an empty snapshot directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'heap-cli-direct-'));
    directories.push(directory);
    const result = await execute([join(repository, 'scripts/analyze-heap-snapshots.mjs'), directory]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No *.heapsnapshot in ');
  });
});
