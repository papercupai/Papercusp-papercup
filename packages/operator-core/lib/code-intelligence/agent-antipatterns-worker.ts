/** Short-lived preparation process used by the shared native injection collector. */
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { agentAntipatterns } from './agent-antipatterns.ts';

// Promisified lazily on first call, never at module scope (EI-10161): an eager
// promisify(execFile) throws at import time under a narrow node:child_process test mock.
let cachedRun: typeof execFile.__promisify__ | undefined;
const run = ((...args: Parameters<typeof execFile.__promisify__>) =>
  (cachedRun ??= promisify(execFile))(...args)) as typeof execFile.__promisify__;
async function main() {
  const root = process.cwd(), file = resolve(process.argv[2] ?? '');
  const path = relative(root, file).replaceAll('\\', '/');
  if (path.startsWith('../') || !/\.tsx?$/.test(path) || /(?:^|\/)(?:node_modules|dist|build)\//.test(path)
    || (await stat(file)).size > 100_000) return;
  const { stdout: base } = await run('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 1000 });
  let before: string | null = null;
  try { before = (await run('git', ['show', `${base.trim()}:${path}`], { cwd: root, timeout: 1000, maxBuffer: 100_001 })).stdout; }
  catch { /* An unavailable base is unknown, never an empty historical file. */ }
  const after = await readFile(file, 'utf8');
  if (before === after) return;
  const result = await agentAntipatterns(before, after, path.endsWith('.tsx') ? 'tsx' : 'ts');
  if (result.status === 'measured' && result.hits.length) process.stdout.write(JSON.stringify({ path, base: base.trim(), ...result }));
}
main().catch(() => {});
