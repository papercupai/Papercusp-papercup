import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

it('the native shared-memory importer can load the operator’s installed local embedder', async () => {
  // Operator-core declares this dependency. A host-local installation must also
  // be reachable by the shared memory library, whose import has a different base.
  expect(require.resolve('@huggingface/transformers')).toBeTruthy();
  const { stdout } = await execFileAsync(process.execPath, [require.resolve('tsx/cli'), '--eval',
    'import { localAvailable } from "./packages/operator-core/lib/memory/configure.ts"; ' +
    'localAvailable().then(available => { console.log(JSON.stringify({ available })); process.exit(0); })' +
    '.catch(error => { console.error(error.message); process.exit(1); });',
  ], { cwd: repoRoot, timeout: 30_000 });
  expect(JSON.parse(stdout.trim())).toEqual({ available: true });
}, 40_000);
