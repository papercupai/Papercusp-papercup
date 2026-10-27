import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// This profile consumes retained, already-qualified native artifacts. Missing
// artifacts are a fixture prerequisite; a configured run must execute both tests.
// It does not rebuild, install packages on the host, or publish anything.
const manifestPath = process.env.PAPERCUSP_DESKTOP_COEXISTENCE_MANIFEST;
test.skip(!manifestPath, 'Requires the retained normal-build native artifact manifest');
test.skip(process.platform !== 'linux', 'Packaged Linux GUI launch requires Linux');
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const run = promisify(execFile);
type Artifact = { path: string; size: number; sha256: string };

async function sha256(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function normalArtifacts() {
  const manifest = JSON.parse(await readFile(manifestPath!, 'utf8')) as { files: Artifact[] };
  const debs = manifest.files.filter(file => /^Papercusp GUI_.+_amd64\.deb$/.test(basename(file.path)));
  const images = manifest.files.filter(file => /^Papercusp_GUI_.+_amd64\.AppImage$/.test(basename(file.path)));
  expect(debs, 'one exact normal GUI installer').toHaveLength(1);
  expect(images, 'one exact normal GUI AppImage').toHaveLength(1);
  const version = basename(debs[0].path).slice('Papercusp GUI_'.length, -'_amd64.deb'.length);
  expect(basename(images[0].path)).toBe(`Papercusp_GUI_${version}_amd64.AppImage`);
  const artifacts = [...debs, ...images];
  for (const artifact of artifacts) {
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await sha256(artifact.path), 'retained installer bytes must match the qualification manifest').toBe(artifact.sha256);
  }
  return { artifacts, version };
}

test('normal packaged GUI launches with the measured legacy SPA identity', async ({}, info) => {
  test.setTimeout(300_000);
  const { artifacts, version } = await normalArtifacts();
  const work = await mkdtemp(join(tmpdir(), 'desktop-interface-coexistence-'));
  const inputs = join(work, 'inputs');
  await mkdir(inputs);
  for (const artifact of artifacts) await symlink(artifact.path, join(inputs, basename(artifact.path)));

  const launch = await run('bash', [join(repo, 'papercusp-desktop/bin/linux-fresh-install-e2e.sh')], {
    cwd: repo, timeout: 240_000, maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env, PC_L_SOURCE: 'local', PC_L_LOCAL_DIR: inputs,
      PC_L_VERSION: version, PC_L_WORK: join(work, 'launch'), PC_L_KEEP: '1',
      PC_L_OBSERVE_SECONDS: '2', PC_L_PRISTINE: '0',
    },
  }).then(value => ({ ...value, code: 0 }), (error: Error & { code?: unknown; stdout?: string; stderr?: string }) => ({
    code: typeof error.code === 'number' ? error.code : -1,
    stdout: error.stdout ?? '', stderr: (error.stderr ?? '') + '\n' + error.message,
  }));
  const { stdout, stderr } = launch;
  await info.attach('native-normal-artifact-launch', { body: JSON.stringify({ work, exitCode: launch.code }) + '\n' + stdout + stderr, contentType: 'text/plain' });
  expect(launch.code, `native launcher failed; retained work=${work}\n${stdout}\n${stderr}`).toBe(0);
  expect(stdout).toContain('VERDICT: PASS');
  expect(stdout).toContain('GUI provenance bound to extracted artifact:');
  expect(stdout).toMatch(/GUI remained alive for \d+s with no Server available/);
  expect(stdout).toContain('GUI opened no artifact-owned /api/health endpoint');

  const runs = (await readdir(join(work, 'launch'))).filter(name => name.startsWith('run.'));
  expect(runs).toHaveLength(1);
  const extracted = join(work, 'launch', runs[0], 'squashfs-root');
  const indexes = (await readdir(extracted, { recursive: true }))
    .filter(name => name.endsWith('/sidecar/spa/index.html'));
  expect(indexes, 'inspect the SPA in the executable image that actually launched').toHaveLength(1);
  const index = join(extracted, indexes[0]);
  const html = await readFile(index, 'utf8');
  const markers = [...html.matchAll(/<meta\s+name="papercusp-desktop-interface"\s+content="([^"]+)"\s*\/?\s*>/g)];
  expect(markers.map(match => match[1])).toEqual(['legacy']);
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
  expect(scripts.length).toBeGreaterThan(0);
  for (const source of scripts) {
    expect(source).toMatch(/^\/assets\/[A-Za-z0-9._-]+\.js$/);
    expect((await readFile(join(index.slice(0, -'index.html'.length), source.slice(1)))).length).toBeGreaterThan(0);
  }
  await info.attach('normal-packaged-interface', {
    body: JSON.stringify({ version, artifacts, extracted, spaIndexSha256: await sha256(index),
      interface: 'legacy', scripts, scope: 'Exact GUI-only native launch and packaged identity; installed product pair, portal parity and public publication are separate evidence.' }, null, 2),
    contentType: 'application/json',
  });
});

test('explicit portal candidate cannot enter ordinary build or publication paths', async ({}, info) => {
  const { artifacts } = await normalArtifacts();
  const observations: Array<{ entry: string; exitCode: number; stderr: string }> = [];
  for (const entry of ['build-desktop-sidecar.sh', 'build-mac-cross.sh', 'build-windows-cross.sh', 'publish-release-history.sh']) {
    const home = await mkdtemp(join(tmpdir(), 'desktop-candidate-no-write-'));
    const result = await run('bash', [join(repo, 'papercusp-desktop/bin', entry), '999.0.0'], {
      cwd: repo, timeout: 30_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, HOME: home, PAPERCUSP_DESKTOP_INTERFACE: 'portal-candidate', DRY_RUN: '1' },
    }).then(value => ({ ...value, code: 0 }), (error: NodeJS.ErrnoException & { stdout: string; stderr: string }) => {
      if (typeof error.code !== 'number') throw error;
      return { stdout: error.stdout, stderr: error.stderr, code: error.code };
    });
    expect(result.code, `${entry} must refuse before outward work`).toBe(4);
    expect(result.stderr).toContain('PUBLIC DESKTOP INTERFACE HOLD');
    expect(await readdir(home), `${entry} must leave its output namespace empty`).toEqual([]);
    observations.push({ entry, exitCode: result.code, stderr: result.stderr });
  }
  for (const artifact of artifacts) expect(await sha256(artifact.path)).toBe(artifact.sha256);
  await info.attach('candidate-no-write-controls', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' });
});
