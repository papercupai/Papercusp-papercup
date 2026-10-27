import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { processMonotonicClock } from './process-monotonic-clock';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));

// Use the recorder's real TSX loader: Vitest unifies these paths. Capture the
// exact source as a test fixture so TSX's CJS transform does not conflict with
// the inherited committed-source guard, which remains enabled in the child.
async function readMixedLoaderClock() {
  const source = await readFile(new URL('./process-monotonic-clock.ts', import.meta.url));
  // Outside the checkout, so the guard never sees these files. The clock's
  // bare '@papercusp/module-singleton' import resolves to a vendored copy in
  // the fixture's own node_modules. The checkout copy would load through
  // TSX's CJS transform and the guard would refuse it as differs-from-head.
  const fixture = await mkdtemp(path.join(tmpdir(), 'process-clock-loader-'));
  const singletonSrc = path.join(root, 'libs/generic/module-singleton');
  const singletonDir = path.join(fixture, 'node_modules/@papercusp/module-singleton');
  await mkdir(path.join(singletonDir, 'src'), { recursive: true });
  await copyFile(path.join(singletonSrc, 'package.json'), path.join(singletonDir, 'package.json'));
  await copyFile(path.join(singletonSrc, 'src/index.ts'), path.join(singletonDir, 'src/index.ts'));
  const clockFile = path.join(fixture, 'clock.ts');
  // operator-core is ESM while tsx -e uses CJS, as in the recorder's imports.
  await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(clockFile, source);
  const script = `
    import { processMonotonicClock as direct } from ${JSON.stringify(clockFile)};
    import { readFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    (async () => {
      const module = await import(${JSON.stringify(clockFile)});
      const dynamic = module.processMonotonicClock ?? module.default.processMonotonicClock;
      console.log(JSON.stringify({ directId: direct.id, dynamicId: dynamic.id,
        sameObject: direct === dynamic, frozen: Object.isFrozen(direct),
        sourceSha256: createHash('sha256').update(readFileSync(${JSON.stringify(clockFile)})).digest('hex'),
        directNow: direct.now(), dynamicNow: dynamic.now() }));
    })();
  `;
  try {
    const { stdout } = await run(path.join(root, 'node_modules/.bin/tsx'), ['-e', script], {
      cwd: root, timeout: 15_000,
    });
    const result = JSON.parse(stdout.trim());
    expect(result.sourceSha256).toBe(createHash('sha256').update(source).digest('hex'));
    return result;
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

describe('process monotonic clock runtime identity', () => {
  it('shares the immutable clock across static CommonJS and dynamic ESM imports', async () => {
    const result = await readMixedLoaderClock();
    expect(result.sameObject).toBe(true);
    expect(result.dynamicId).toBe(result.directId);
    expect(result.frozen).toBe(true);
    expect(result.directNow).toBeGreaterThanOrEqual(0);
    expect(result.dynamicNow).toBeGreaterThanOrEqual(result.directNow);
  });

  it('keeps separately launched processes in distinct clock domains', async () => {
    const [first, second] = await Promise.all([readMixedLoaderClock(), readMixedLoaderClock()]);
    expect(first.directId).not.toBe(second.directId);
    expect(first.directId).not.toBe(processMonotonicClock.id);
    expect(second.directId).not.toBe(processMonotonicClock.id);
  });
});
