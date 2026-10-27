import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultBlobBatchReader, type BlobBatchReader } from './committed-tree-reader';
import { scanRepository } from '../../../../../scripts/check-fire-and-forget-classification.mjs';
import {
  __resetTreeInstrumentMemoForTest,
  foldTreeInstrumentFingerprint,
  measureTreeInstrumentAtCommit,
} from './tree-instruments';

let root: string;
const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Tree test',
  '-c', 'user.email=tree-test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();

async function put(files: Record<string, string>): Promise<string> {
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), body);
  }
  git('add', '-A');
  git('commit', '-qm', 'step', '--allow-empty');
  return git('rev-parse', 'HEAD');
}

beforeEach(async () => {
  __resetTreeInstrumentMemoForTest();
  root = await realpath(await mkdtemp(join(tmpdir(), 'tree-instrument-')));
  git('init', '-q');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('provider-specific-census tree instrument', () => {
  it('reports the census of the committed tree, not of the working tree', async () => {
    const commit = await put({
      'packages/operator-core/lib/integrations/provider-options.ts': 'export {};\n',
      'packages/operator-core/lib/integrations/discord-bridge.ts': 'export {};\n',
      'packages/operator-core/lib/chat/thread-poster.ts': "await fetch('https://slack.com/api/chat.postMessage');\n",
      'packages/operator-core/lib/chat/thread-poster.test.ts': "fetch('https://slack.com/api/chat.postMessage');\n",
      'packages/operator-core/node_modules/slack/index.js': 'export {};\n',
      'libs/papercusp/plugins/slack/provider.mjs': "fetch('https://slack.com/api/chat.postMessage');\n",
    });
    // Uncommitted planted module: not in the committed tree, so not in the census.
    await writeFile(join(root, 'packages/operator-core/lib/integrations/asana-sync.ts'), 'export {};\n');
    expect(await measureTreeInstrumentAtCommit('provider-specific-census', root, commit)).toEqual({
      providerSpecificPaths: ['packages/operator-core/lib/integrations/discord-bridge.ts'],
      strictViolations: ['packages/operator-core/lib/chat/thread-poster.ts: slack'],
    });
  });

  it('stays current across an unrelated commit and goes stale when a provider module is planted', async () => {
    const base = await put({
      'packages/operator-core/lib/integrations/provider-options.ts': 'export const a = 1;\n',
      'apps/operator/app/page.tsx': 'export {};\n',
    });
    const before = await measureTreeInstrumentAtCommit('provider-specific-census', root, base);
    const unrelated = await put({
      'packages/operator-core/lib/integrations/provider-options.ts': 'export const a = 2;\n',
      'packages/operator-core/lib/integrations/new-helper.ts': 'export const helper = 1;\n',
      'docs/notes.md': 'slack discord\n',
    });
    const afterUnrelated = await measureTreeInstrumentAtCommit('provider-specific-census', root, unrelated);
    expect(afterUnrelated).toEqual(before);
    const fp = (output: unknown) => foldTreeInstrumentFingerprint('sha256-file-set-v1:x', 'provider-specific-census', output);
    expect(fp(afterUnrelated)).toBe(fp(before));

    const planted = await put({ 'apps/operator/app/settings/TelegramCard.tsx': 'export {};\n' });
    const afterPlant = await measureTreeInstrumentAtCommit('provider-specific-census', root, planted);
    expect(afterPlant).toEqual({ providerSpecificPaths: ['apps/operator/app/settings/TelegramCard.tsx'], strictViolations: [] });
    expect(fp(afterPlant)).not.toBe(fp(before));
  });

  it('goes stale when a neutral path starts speaking a strict protocol, and honours allowances', async () => {
    const base = await put({
      'packages/operator-core/lib/intake/message-classifier.ts': 'export const classify = () => null;\n',
      'packages/operator-core/lib/data-governance/pilot-processing-map.ts': "export const t = ['harness_shared.chat_bug_suggestions'];\n",
    });
    expect(await measureTreeInstrumentAtCommit('provider-specific-census', root, base))
      .toEqual({ providerSpecificPaths: [], strictViolations: [] });
    const changed = await put({
      'packages/operator-core/lib/intake/message-classifier.ts': "if (payload.callback_id === 'report_bug') file();\n",
      'packages/operator-core/lib/data-governance/pilot-processing-map.ts':
        "export const t = ['harness_shared.chat_bug_suggestions'];\nexport const r = ':bug:';\n",
    });
    expect(await measureTreeInstrumentAtCommit('provider-specific-census', root, changed)).toEqual({
      providerSpecificPaths: [],
      strictViolations: [
        'packages/operator-core/lib/data-governance/pilot-processing-map.ts: bug-workflow',
        'packages/operator-core/lib/intake/message-classifier.ts: bug-workflow',
      ],
    });
  });

  it('re-reads only the blobs a new commit changed', async () => {
    const read: string[] = [];
    const counting: BlobBatchReader = async (dir, blobs) => { read.push(...blobs); return defaultBlobBatchReader(dir, blobs); };
    const first = await put({
      'packages/operator-core/lib/a.ts': 'export const a = 1;\n',
      'packages/operator-core/lib/b.ts': 'export const b = 1;\n',
      'bin/c.mjs': 'export const c = 1;\n',
    });
    await measureTreeInstrumentAtCommit('provider-specific-census', root, first, { readBlobs: counting });
    expect(read).toHaveLength(3);
    read.length = 0;
    const second = await put({ 'packages/operator-core/lib/b.ts': 'export const b = 2;\n' });
    await measureTreeInstrumentAtCommit('provider-specific-census', root, second, { readBlobs: counting });
    expect(read).toEqual([git('rev-parse', `${second}:packages/operator-core/lib/b.ts`)]);
    read.length = 0;
    await measureTreeInstrumentAtCommit('provider-specific-census', root, second, { readBlobs: counting });
    expect(read).toEqual([]);
  });

  it('refuses a submodule the walk would descend into instead of silently dropping it', async () => {
    await put({ 'packages/operator-core/lib/a.ts': 'export {};\n' });
    const head = git('rev-parse', 'HEAD');
    git('update-index', '--add', '--cacheinfo', `160000,${head},packages/operator-core/lib/vendored`);
    git('commit', '-qm', 'gitlink');
    await expect(measureTreeInstrumentAtCommit('provider-specific-census', root, git('rev-parse', 'HEAD')))
      .rejects.toThrow('tree_instrument_nested_submodule_unsupported:packages/operator-core/lib/vendored');
  });

  it('lists nothing for an app root absent at the commit (the walk skips a missing root too)', async () => {
    const commit = await put({ 'bin/tool.mjs': 'export {};\n' });
    expect(await measureTreeInstrumentAtCommit('provider-specific-census', root, commit))
      .toEqual({ providerSpecificPaths: [], strictViolations: [] });
  });
});

describe('notification-classification-census tree instrument', () => {
  const key = 'notification-classification-census' as const;

  it('matches the tracked detector inputs at the pin and ignores uncommitted source', async () => {
    const commit = await put({
      'src/quoted "通知".ts': 'void notifyOwner();',
      'src/app.test.ts': 'void notifyHidden();',
      'dist/generated.ts': 'void notifyHidden();',
      'package.json': '{"name":"fixture"}',
    });
    const expected = scanRepository(root);
    await writeFile(join(root, 'src/quoted "通知".ts'), 'export const quiet = true;');
    await writeFile(join(root, 'src/untracked.ts'), 'void notifyNew();');
    expect(await measureTreeInstrumentAtCommit(key, root, commit)).toMatchObject({
      files: expected.files.length, sites: expected.sites.length,
      sourceDigest: expected.sourceDigest, gaps: [], submodules: [],
    });
  });

  it('ignores excluded edits but changes for new tracked calls and resolution-only edits', async () => {
    const base = await put({ 'src/app.ts': 'export const ready = true;', 'tsconfig.json': '{}' });
    const before = await measureTreeInstrumentAtCommit(key, root, base);
    const docs = await put({ 'docs/note.md': 'void notifyOwner();' });
    expect(await measureTreeInstrumentAtCommit(key, root, docs)).toEqual(before);
    const call = await put({ 'src/app.ts': 'void notifyOwner();' });
    const withCall = await measureTreeInstrumentAtCommit(key, root, call);
    expect(withCall).not.toEqual(before);
    expect(withCall).toMatchObject({ sites: 1 });
    const resolution = await put({ 'tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}' });
    expect(await measureTreeInstrumentAtCommit(key, root, resolution)).not.toEqual(withCall);
  });

  it('descends actual submodules at the parent pin and refuses an unavailable pinned repository', async () => {
    const bus = await realpath(await mkdtemp(join(tmpdir(), 'notify-tree-submodule-')));
    const busGit = (...args: string[]) => execFileSync('git', ['-C', bus, '-c', 'user.name=Tree test',
      '-c', 'user.email=tree-test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
    try {
      busGit('init', '-q');
      await mkdir(join(bus, 'src'));
      await writeFile(join(bus, 'src/index.ts'), 'export const relay = notifyOwner;');
      await writeFile(join(bus, 'package.json'), '{"name":"@fixture/bus","exports":"./src/index.ts"}');
      busGit('add', '-A'); busGit('commit', '-qm', 'bus');
      git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', bus, 'libs/bus');
      const base = await put({ 'src/app.ts': 'import {relay} from "@fixture/bus"; void relay();' });
      const expected = scanRepository(root);
      const pinned = await measureTreeInstrumentAtCommit(key, root, base);
      expect(pinned).toMatchObject({ sites: 1, sourceDigest: expected.sourceDigest, submodules: ['libs/bus'], gaps: [] });

      await writeFile(join(root, 'libs/bus/src/index.ts'), 'export const relay = () => null;');
      git('-C', join(root, 'libs/bus'), 'add', '-A');
      git('-C', join(root, 'libs/bus'), 'commit', '-qm', 'new bus head');
      __resetTreeInstrumentMemoForTest();
      expect(await measureTreeInstrumentAtCommit(key, root, base)).toEqual(pinned);
      const movedPin = await put({});
      expect(await measureTreeInstrumentAtCommit(key, root, movedPin)).toMatchObject({ sites: 0, submodules: ['libs/bus'] });

      await rm(join(root, 'libs/bus'), { recursive: true, force: true });
      await mkdir(join(root, 'libs/bus'));
      __resetTreeInstrumentMemoForTest();
      await expect(measureTreeInstrumentAtCommit(key, root, base)).rejects.toThrow('tree_instrument_submodule_unavailable:libs/bus');
    } finally {
      await rm(bus, { recursive: true, force: true });
    }
  });

  it('reports a declared submodule without a committed gitlink as a population gap', async () => {
    const commit = await put({
      'src/app.ts': 'void notifyOwner();',
      '.gitmodules': '[submodule "bus"]\npath = libs/bus\nurl = https://example.invalid/bus.git\n',
    });
    expect(await measureTreeInstrumentAtCommit(key, root, commit)).toMatchObject({
      declaredSubmodules: ['libs/bus'], submodules: [],
      gaps: [{ path: 'libs/bus', kind: 'declared-submodule-without-gitlink' }],
    });
  });

  it('refuses a reachable symlink or an empty committed population', async () => {
    const empty = await put({ 'docs/note.md': 'No product source.' });
    await expect(measureTreeInstrumentAtCommit(key, root, empty)).rejects.toThrow('tree_instrument_empty_notification_population');
    await symlink('../docs/note.md', join(root, 'linked.ts'));
    const linked = await put({});
    await expect(measureTreeInstrumentAtCommit(key, root, linked)).rejects.toThrow('tree_instrument_symlink_unsupported:linked.ts');
  });
});
