import { afterAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groupDirectVitestRoutes } from './run';

// Config ownership is a filesystem contract. Keep its recurrence guard free
// of the unrelated PostgreSQL integration substrate.
const selectorRoots: string[] = [];
afterAll(async () => { await Promise.all(selectorRoots.map(root => rm(root, { recursive: true, force: true }))); });

describe('external Vitest e2e config ownership', () => {
  it.each(['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'])('keeps root e2e browser adapters off the unit route with config extension %s', async extension => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-testing-run-direct-e2e-'));
    selectorRoots.push(root);
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'tests'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: [] }));
    await writeFile(join(root, 'vitest.config.ts'), 'export default {};\n');
    await writeFile(join(root, `vitest.e2e.config.${extension}`), 'export default {};\n');
    await writeFile(join(root, 'tests/tutorial.e2e.test.ts'), 'export {};\n');
    await writeFile(join(root, 'tests/unit.test.ts'), 'export {};\n');
    expect(groupDirectVitestRoutes(['tests/tutorial.e2e.test.ts', 'tests/unit.test.ts'], root)).toEqual([
      { cwd: root, config: `vitest.e2e.config.${extension}`, files: ['tests/tutorial.e2e.test.ts'] },
      { cwd: root, files: ['tests/unit.test.ts'] },
    ]);
  });

  it('finds a parent e2e config from an owning workspace and leaves other layers distinct', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-testing-run-direct-e2e-parent-'));
    selectorRoots.push(root);
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'packages/ui/tests'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
    await writeFile(join(root, 'packages/ui/package.json'), JSON.stringify({ name: '@example/ui' }));
    await writeFile(join(root, 'vitest.e2e.config.ts'), 'export default {};\n');
    await writeFile(join(root, 'packages/ui/vitest.browser.config.ts'), 'export default {};\n');
    await writeFile(join(root, 'packages/ui/vitest.integration.config.ts'), 'export default {};\n');
    expect(groupDirectVitestRoutes([
      'packages/ui/tests/tutorial.e2e.test.ts', 'packages/ui/tests/view.browser.test.tsx', 'packages/ui/tests/data.integration.test.ts',
    ], root)).toEqual([
      { cwd: join(root, 'packages/ui'), config: '../../vitest.e2e.config.ts', files: ['tests/tutorial.e2e.test.ts'] },
      { cwd: join(root, 'packages/ui'), config: 'vitest.browser.config.ts', files: ['tests/view.browser.test.tsx'] },
      { cwd: join(root, 'packages/ui'), config: 'vitest.integration.config.ts', files: ['tests/data.integration.test.ts'] },
    ]);
  });

});
