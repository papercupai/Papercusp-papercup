/**
 * self-describing-store.test.ts — pins inRepoFallbackDir, the bundling-robust repo-root
 * walk that resolves the in-repo dev fallback for the bundled content layer.
 *
 * The regression it guards (WI-3398, 2026-07-08): the old fixed `../../../../<subdir>`
 * from `packages/operator-core/lib/cupboard/` overshot the repo root when this module
 * was esbuild-BUNDLED into `apps/operator/dist-host/hono-host.mjs` (a SHALLOWER dir),
 * so the store enumerated a non-existent `<workspace>/templates` and returned count:0
 * on the :3170 staging host. inRepoFallbackDir walks up to the monorepo root instead,
 * so BOTH the deep source layout and the shallow bundle resolve to the same dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inRepoFallbackDir } from './self-describing-store';

let root: string; // a fake monorepo root: package.json + packages/ + templates/

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sds-repo-'));
  writeFileSync(join(root, 'package.json'), '{"name":"fake-monorepo"}');
  mkdirSync(join(root, 'packages'), { recursive: true });
  mkdirSync(join(root, 'templates'), { recursive: true });
  // both the SOURCE and the BUNDLE module locations, at different depths
  mkdirSync(join(root, 'packages', 'operator-core', 'lib', 'cupboard'), { recursive: true });
  mkdirSync(join(root, 'apps', 'operator', 'dist-host'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const urlFor = (...seg: string[]) => pathToFileURL(join(root, ...seg)).href;

describe('inRepoFallbackDir', () => {
  it('resolves <repoRoot>/<subdir> from the DEEP source module location', () => {
    const moduleUrl = urlFor('packages', 'operator-core', 'lib', 'cupboard', 'template-store.ts');
    expect(inRepoFallbackDir('templates', moduleUrl)).toBe(join(root, 'templates'));
  });

  it('resolves the SAME dir from the SHALLOW bundled host location (the WI-3398 fix)', () => {
    // apps/operator/dist-host/ is one level shallower than lib/cupboard/, which is
    // exactly what broke the fixed `..×4` math. The walk-up lands on the same root.
    const bundledUrl = urlFor('apps', 'operator', 'dist-host', 'hono-host.mjs');
    expect(inRepoFallbackDir('templates', bundledUrl)).toBe(join(root, 'templates'));
  });

  it('stops at the NEAREST monorepo root (package.json + packages/), not a parent', () => {
    // The parent of `root` has neither marker, so the walk cannot overshoot past root.
    const moduleUrl = urlFor('apps', 'operator', 'dist-host', 'x.mjs');
    const out = inRepoFallbackDir('rubrics', moduleUrl);
    expect(out).toBe(join(root, 'rubrics'));
    expect(out.startsWith(root)).toBe(true);
  });

  it('does not crash a permission-confined import that cannot read the bundle ancestors (WI-6554700010029714)', async () => {
    // The packaged sidecar's import qualification runs serve.mjs under
    // `node --permission --allow-fs-read=<bundle>`. There, existsSync on an
    // ancestor THROWS ERR_ACCESS_DENIED rather than returning false, and nine
    // cupboard stores walk up at MODULE SCOPE, so the whole import died. Run the
    // REAL module, bundled the way the sidecar is, under the REAL permission model.
    const { build } = await import('esbuild');
    const side = join(root, 'papercusp-desktop', 'src-tauri', 'sidecar');
    mkdirSync(side, { recursive: true });
    await build({
      entryPoints: [join(import.meta.dirname, 'self-describing-store.ts')],
      outfile: join(side, 'store.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    });
    writeFileSync(join(side, 'probe.mjs'), [
      "import { pathToFileURL } from 'node:url';",
      "import { inRepoFallbackDir } from './store.mjs';",
      "const moduleUrl = pathToFileURL(process.argv[2]).href;",
      "process.stdout.write(JSON.stringify({ dir: inRepoFallbackDir('goal-packages', moduleUrl) }));",
    ].join('\n'));
    const run = (confined: boolean) => spawnSync(process.execPath, [
      ...(confined ? ['--permission', `--allow-fs-read=${side}`] : []),
      join(side, 'probe.mjs'), join(side, 'serve.mjs'),
    ], { cwd: side, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, timeout: 30_000 });

    // Control: unconfined, the walk climbs out of the bundle to the fake repo root.
    const open = run(false);
    expect(open.stderr).toBe('');
    expect(JSON.parse(open.stdout)).toEqual({ dir: join(root, 'goal-packages') });

    // Confined: the import survives and stays inside the bundle (cwd fallback).
    const confined = run(true);
    expect(confined.stderr).not.toMatch(/ERR_ACCESS_DENIED|Access to this API has been restricted/);
    expect(confined.status).toBe(0);
    expect(JSON.parse(confined.stdout)).toEqual({ dir: join(side, 'goal-packages') });
  }, 60_000);

  it('falls back to cwd/<subdir> when the module is outside any repo root', () => {
    // A module URL under a dir with no package.json+packages/ ancestor → cwd fallback.
    const orphan = mkdtempSync(join(tmpdir(), 'sds-orphan-'));
    try {
      const out = inRepoFallbackDir('templates', pathToFileURL(join(orphan, 'lone.mjs')).href);
      // cwd (the repo running the test) IS a monorepo root, so it resolves there;
      // the key invariant is it never throws and always ends with the subdir.
      expect(out.endsWith(join('', 'templates')) || out.endsWith('templates')).toBe(true);
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });
});
