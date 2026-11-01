import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = vi.hoisted(() => ({ path: '', repositories: [] as string[] }));
vi.mock('./dependency-snapshot-path', () => ({ dependencySnapshotPath: (repository: string) => {
  fixture.repositories.push(repository);
  return fixture.path;
} }));
vi.mock('@papercusp/module-singleton', () => ({ pinModuleState: (_key: string, init: () => unknown) => init() }));

let root: string;
beforeEach(async () => {
  vi.resetModules();
  root = await mkdtemp(join(tmpdir(), 'native-caller-ready-'));
  fixture.path = join(root, 'serving', 'dependency-snapshot.json');
  fixture.repositories = [];
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('prepares the completion serving key and waits for its real cooperative symbol load', async () => {
  const { preparePrivateNativeCallerSnapshot } = await import('./native-cli.fixture');
  const { peekPushSnapshot } = await import('./push-snapshot');
  const generatedAt = new Date().toISOString();
  const contents = JSON.stringify({ schema: 'graph-dependency-snapshot-v1', generatedAt,
    index: { backend: 'first-party-imports', lastCommit: 'a'.repeat(40) },
    edges: [{ importer: 'consumer.ts', imported: 'target.ts', importerSha256: 'b'.repeat(64) }],
    symbols: { schema: 'code-intel-symbol-snapshot-v1', knowledge: 'syntax-bound', symbols: [{
      id: 'target', name: 'target', path: 'target.ts', line: 1, column: 17,
      sha256: 'c'.repeat(64), signature: 'target()', aliases: [], callers: [],
    }] } });

  await preparePrivateNativeCallerSnapshot('test-runtime-private', contents);

  expect(await readFile(fixture.path, 'utf8')).toBe(contents);
  expect(fixture.repositories.length).toBeGreaterThan(0);
  expect(new Set(fixture.repositories)).toEqual(new Set(['papercusp']));
  expect(peekPushSnapshot('papercusp')?.generatedAt).toBe(generatedAt);
  expect(peekPushSnapshot('papercusp')?.symbols?.get('target')).toHaveLength(1);
});

it('refuses a managed workspace before touching its serving snapshot', async () => {
  const { preparePrivateNativeCallerSnapshot } = await import('./native-cli.fixture');
  await expect(preparePrivateNativeCallerSnapshot('papercusp', '{}')).rejects.toThrow('private native workspace');
  expect(fixture.repositories).toEqual([]);
});
