import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchBundleManifestMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

vi.mock('./bundle-manifest-io', () => ({
  fetchBundleManifest: fetchBundleManifestMock,
  BundleManifestError: class BundleManifestError extends Error {
    readonly status = 422;
  },
}));

const { installOfflineContentBundleAppFromCupboard } = await import('./offline-content-bundle-install-io');

const roots: string[] = [];
const priorHome = process.env.PAPERCUSP_HOME;

afterEach(() => {
  fetchBundleManifestMock.mockReset();
  spawnMock.mockReset();
  if (priorHome === undefined) delete process.env.PAPERCUSP_HOME;
  else process.env.PAPERCUSP_HOME = priorHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('offline content bundle installer', () => {
  it('installs all content from the manifest snapshot when a second network clone would fail', async () => {
    const root = mkdtempSync(join(tmpdir(), 'offline-content-snapshot-'));
    roots.push(root);
    const repo = join(root, 'remote');
    const home = join(root, 'home');
    mkdirSync(home);
    process.env.PAPERCUSP_HOME = home;
    const url = 'https://github.com/Papercusp/templates';
    const write = (path: string, contents: string) => {
      const target = join(repo, path);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, contents);
    };
    write('bundle.yaml', [
      'name: snapshot-content',
      'blueprints:',
      '  - id: base',
      `    githubUrl: ${url}`,
      '    listingRef: base',
      'templates:',
      '  - id: papercusp-data-layer',
      `    githubUrl: ${url}.git/`,
      '    listingRef: papercusp-data-layer',
      'rubrics:',
      '  - id: checks',
      `    githubUrl: ${url.toLowerCase()}`,
      '    listingRef: checks',
    ].join('\n'));
    write('base/blueprint.yaml', 'id: base\n');
    write('papercusp-data-layer/template.yaml', 'id: papercusp-data-layer\nscope: aspect\n');
    write('papercusp-data-layer/GUIDE.md', 'content from the manifest snapshot\n');
    write('checks/rubric.json', JSON.stringify({
      rubricId: 'checks', title: 'Checks', characteristic: 'snapshot',
      ratingScale: ['pass', 'fail'], version: '1.0.0', criteria: [{
        key: 'same', title: 'Same snapshot', model: 'The content comes from the manifest snapshot.',
        method: 'Read the installed content.', driftMarkers: 'Content fetched from a later tip.',
      }],
    }));
    const actual = await vi.importActual<typeof import('./bundle-manifest-io')>('./bundle-manifest-io');
    fetchBundleManifestMock.mockImplementation(actual.fetchBundleManifest);
    const cloneDestinations: string[] = [];
    spawnMock.mockImplementation((_command, args: string[]) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
      cloneDestinations.push(args.at(-1)!);
      queueMicrotask(() => {
        if (cloneDestinations.length > 1) {
          child.stderr.end("Failed to connect to github.com port 443: Couldn't connect to server");
          child.emit('close', 128);
        } else {
          cpSync(repo, args.at(-1)!, { recursive: true });
          child.emit('close', 0);
        }
      });
      return child;
    });

    const outcome = await installOfflineContentBundleAppFromCupboard(
      { githubUrl: url }, { workspaceId: 'workspace-host', offlineContentOnly: true },
    );
    expect(outcome).toMatchObject({ ok: true, result: {
      ok: true, blueprints: [{ id: 'base', ok: true }],
      templates: [{ id: 'papercusp-data-layer', ok: true }], rubrics: [{ id: 'checks', ok: true }],
    } });
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(readFileSync(join(home, 'templates/papercusp-data-layer/GUIDE.md'), 'utf8'))
      .toBe('content from the manifest snapshot\n');
    expect(cloneDestinations.every((path) => !existsSync(path))).toBe(true);
  });

  it('fails closed and removes its snapshot when the initial repository fetch fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'offline-content-fetch-failure-'));
    roots.push(root);
    process.env.PAPERCUSP_HOME = root;
    const actual = await vi.importActual<typeof import('./bundle-manifest-io')>('./bundle-manifest-io');
    fetchBundleManifestMock.mockImplementation(actual.fetchBundleManifest);
    let cloneDestination = '';
    spawnMock.mockImplementation((_command, args: string[]) => {
      cloneDestination = args.at(-1)!;
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
      queueMicrotask(() => {
        child.stderr.end('initial repository unavailable');
        child.emit('close', 128);
      });
      return child;
    });

    await expect(installOfflineContentBundleAppFromCupboard(
      { githubUrl: 'https://github.com/Papercusp/templates' },
      { workspaceId: 'workspace-host', offlineContentOnly: true },
    )).resolves.toMatchObject({ ok: false, error: 'manifest fetch failed', detail: expect.stringContaining('initial repository unavailable') });
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(existsSync(join(cloneDestination, '..'))).toBe(false);
    expect(existsSync(join(root, 'templates'))).toBe(false);
  });

  it('fetches distinct repositories separately instead of substituting manifest content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'offline-content-distinct-repos-'));
    roots.push(root);
    const manifestRepo = join(root, 'manifest');
    const contentRepo = join(root, 'content');
    const home = join(root, 'home');
    mkdirSync(manifestRepo); mkdirSync(home);
    mkdirSync(join(contentRepo, 'other'), { recursive: true });
    process.env.PAPERCUSP_HOME = home;
    const manifestUrl = 'https://github.com/Papercusp/templates';
    const contentUrl = 'https://github.com/Other/templates';
    writeFileSync(join(manifestRepo, 'bundle.yaml'),
      `name: distinct\ntemplates:\n  - id: other\n    githubUrl: ${contentUrl}\n    listingRef: other\n`);
    writeFileSync(join(contentRepo, 'other/template.yaml'), 'id: other\nscope: aspect\n');
    writeFileSync(join(contentRepo, 'other/GUIDE.md'), 'other repository\n');
    const actual = await vi.importActual<typeof import('./bundle-manifest-io')>('./bundle-manifest-io');
    fetchBundleManifestMock.mockImplementation(actual.fetchBundleManifest);
    const cloneDestinations: string[] = [];
    spawnMock.mockImplementation((_command, args: string[]) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
      cloneDestinations.push(args.at(-1)!);
      queueMicrotask(() => {
        cpSync(args.at(-2) === manifestUrl ? manifestRepo : contentRepo, args.at(-1)!, { recursive: true });
        child.emit('close', 0);
      });
      return child;
    });

    await expect(installOfflineContentBundleAppFromCupboard(
      { githubUrl: manifestUrl }, { workspaceId: 'workspace-host', offlineContentOnly: true },
    )).resolves.toMatchObject({ ok: true, result: { ok: true } });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(home, 'templates/other/GUIDE.md'), 'utf8')).toBe('other repository\n');
    expect(cloneDestinations.every((path) => !existsSync(join(path, '..')))).toBe(true);
  });

  it('passes a working tmpDir to manifest and content installers before PG exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'offline-content-bundle-'));
    roots.push(root);
    process.env.PAPERCUSP_HOME = root;
    fetchBundleManifestMock.mockImplementation(async (_input, deps) => {
      expect(typeof deps.tmpDir).toBe('function');
      expect(deps.tmpDir()).toBe(tmpdir());
      return { name: 'empty offline bundle' };
    });

    await expect(
      installOfflineContentBundleAppFromCupboard(
        { githubUrl: 'https://github.com/Papercusp/templates' },
        { workspaceId: 'workspace-host', offlineContentOnly: true },
      ),
    ).resolves.toMatchObject({ ok: true, result: { ok: true } });
    expect(fetchBundleManifestMock).toHaveBeenCalledOnce();
  });
});
