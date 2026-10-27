import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  scanRepository, validateClassifications,
  type NotifyCensus, type NotifyClassification,
} from '../../../scripts/check-fire-and-forget-classification.mjs';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// Git mutations below are confined to disposable fixture repositories. The shared
// checkout and its index are never changed by these tests.
function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Census fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Census fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  }).trim();
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'notify-census-integration-'));
  roots.push(root);
  git(root, 'init', '-q');
  return root;
}

function put(root: string, path: string, source: string, tracked = true): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), source);
  if (tracked) git(root, 'add', '--', path);
}

// This supplies classification judgments only. It does not certify that the
// fixture's named terminal delivery is implemented or survives a restart.
function classifications(census: NotifyCensus): NotifyClassification[] {
  return census.sites.map(site => ({
    id: site.id, path: site.path, classification: 'durable',
    reason: 'This fixture requires the terminal owner notice to survive exit.',
    durablePath: 'src/delivery.ts#outbox',
  }));
}

describe('notification classification over real tracked repositories', () => {
  it.each([
    ['direct', 'void notifyOwner();'],
    ['alias', 'const quiet = notifyOwner; void quiet();'],
    ['wrapper', 'async function quiet(){ await notifyOwner(); } void quiet();'],
  ])('rejects a new %s site before accepting complete classifications', (_name, source) => {
    const root = repo();
    put(root, 'src/app.ts', 'export const ready = true;');
    expect(scanRepository(root).sites).toEqual([]);

    put(root, 'src/app.ts', source);
    const census = scanRepository(root);
    expect(census.gaps).toEqual([]);
    expect(census.sites.length).toBeGreaterThan(0);
    expect(validateClassifications(census, [])).toEqual(
      census.sites.map(site => `unclassified: ${site.id}`),
    );
    const records = classifications(census);
    expect(validateClassifications(census, records)).toEqual([]);
    expect(validateClassifications(census, records.map(record => ({
      ...record, classification: 'safe-to-lose',
    })))).toEqual(census.sites.map(site => `mandatory notice cannot be safe-to-lose: ${site.id}`));
  });

  it('fingerprints the tracked population and explicitly excludes tests, generated and untracked source', () => {
    const root = repo();
    const path = 'src/quoted "通知".ts';
    const source = 'void notifyOwner();';
    put(root, path, source);
    put(root, 'package.json', '{"name":"fixture"}');
    put(root, 'src/app.test.ts', 'void notifyHidden();');
    put(root, 'dist/generated.ts', 'void notifyHidden();');
    put(root, 'src/untracked.ts', 'void notifyHidden();', false);

    const census = scanRepository(root);
    expect(census.gaps).toEqual([]);
    expect(census.files.map(file => file.path)).toEqual(['package.json', path]);
    expect(census.sites.map(site => site.path)).toEqual([path]);
    expect(census.files.find(file => file.path === path)?.sha256).toBe(
      createHash('sha256').update(source).digest('hex'),
    );
    expect(census.sourceDigest).toBe(createHash('sha256').update(JSON.stringify(census.files)).digest('hex'));
  });

  it('resolves a package alias through a real initialized submodule and records resolution manifests', () => {
    const bus = repo();
    put(bus, 'package.json', '{"name":"@fixture/bus","exports":"./src/index.ts"}');
    put(bus, 'src/index.ts', 'export const relay = notifyOwner;');
    git(bus, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');

    const root = repo();
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', bus, 'libs/bus');
    put(root, 'apps/app/tsconfig.json', '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}');
    put(root, 'apps/app/src/bridge.ts', 'export {relay as quiet} from "@fixture/bus";');
    put(root, 'apps/app/main.ts', 'import {quiet} from "@/bridge"; void quiet();');

    const census = scanRepository(root);
    expect(census.gaps).toEqual([]);
    expect(census.coverage).toMatchObject({ declared: ['libs/bus'], scanned: ['libs/bus'], unscanned: [] });
    expect(census.files.map(file => file.path)).toEqual(expect.arrayContaining([
      'libs/bus/src/index.ts', 'libs/bus/package.json', 'apps/app/tsconfig.json',
    ]));
    expect(census.sites).toEqual([expect.objectContaining({
      path: 'apps/app/main.ts', expression: 'quiet ( )', roots: ['notifyOwner'],
    })]);
    expect(validateClassifications(census, [])).toEqual([`unclassified: ${census.sites[0].id}`]);
    expect(validateClassifications(census, classifications(census))).toEqual([]);

    // A resolution-only edit is part of the measured input even if no TS file changes.
    put(root, 'apps/app/tsconfig.json', '{"compilerOptions":{"paths":{"@/*":["./missing/*"]}}}');
    const changed = scanRepository(root);
    expect(changed.sourceDigest).not.toBe(census.sourceDigest);
    expect(changed.sites).toEqual([]);
  });

  it('refuses a present submodule subtree that tracked enumeration did not scan', () => {
    const root = repo();
    put(root, 'src/app.ts', 'export const ready = true;');
    put(root, '.gitmodules', '[submodule "bus"]\npath = libs/bus\nurl = https://example.invalid/bus.git\n');
    put(root, 'libs/bus/src/index.ts', 'void notifyOwner();', false);

    const census = scanRepository(root);
    expect(census.coverage).toMatchObject({ declared: ['libs/bus'], scanned: [], unscannedPresent: ['libs/bus'] });
    expect(census.gaps).toContainEqual({ path: 'libs/bus', kind: 'unscanned-present' });
    expect(validateClassifications(census, classifications(census))).toContain(
      'coverage gap: libs/bus: unscanned-present',
    );
  });
});
