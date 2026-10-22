/**
 * WI-10007018 — bin/bundle-host-freshness.mjs output-tree identity.
 *
 * bundle-host.sh stamps freshness while its build-private restricted-hold gate dirs
 * (`.restricted-gate-meta.$$` esbuild metafiles, `.restricted-lkg.$$` snapshot) still sit
 * inside OUTDIR, then its EXIT trap deletes them. A stamp that hashed them could never be
 * verified (papercup-rust-mobile CI run 37543418448: "freshness manifest output-tree mismatch").
 * These tests drive the real CLI against a throwaway git repo.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Overridable so scripts/mutation-probe.sh can point the suite at a mutated COPY.
const HELPER =
  process.env.PROBE_SCRIPT ?? resolve(fileURLToPath(new URL('.', import.meta.url)), '../bin/bundle-host-freshness.mjs');

let repo: string;
let outdir: string;

function run(op: 'stamp' | 'check') {
  return spawnSync(
    process.execPath,
    [
      HELPER,
      op,
      '--repo-root',
      repo,
      '--entry',
      join(repo, 'entry.ts'),
      '--outfile',
      join(outdir, 'hono-host.mjs'),
      '--manifest',
      join(outdir, '.bundle-fresh.json'),
    ],
    { encoding: 'utf8' },
  );
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'bundle-freshness-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(join(repo, 'entry.ts'), 'export {};\n');
  writeFileSync(join(repo, '.gitignore'), 'dist-host/\nnode_modules/\n');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  outdir = join(repo, 'dist-host');
  mkdirSync(outdir);
  writeFileSync(join(outdir, 'hono-host.mjs'), 'console.log(1);\n');
  writeFileSync(join(outdir, 'worker.mjs'), 'console.log(2);\n');
  mkdirSync(join(repo, 'node_modules'));
  writeFileSync(join(repo, 'node_modules/.package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('bundle-host-freshness output-tree identity', () => {
  it('verifies after bundle-host.sh EXIT trap deletes the build-private gate dirs', () => {
    const meta = join(outdir, '.restricted-gate-meta.4242');
    const lkg = join(outdir, '.restricted-lkg.4242');
    mkdirSync(meta);
    mkdirSync(join(lkg, 'files'), { recursive: true });
    writeFileSync(join(meta, 'hono-host.mjs.meta.json'), '{"inputs":{}}');
    writeFileSync(join(meta, 'copied-sources.txt'), 'a.ts\n');
    writeFileSync(join(lkg, 'files', 'old.mjs'), 'old');

    const stamp = run('stamp');
    expect(stamp.status, stamp.stderr).toBe(0);

    rmSync(meta, { recursive: true });
    rmSync(lkg, { recursive: true });

    const check = run('check');
    expect(check.stderr).not.toContain('output-tree mismatch');
    expect(check.status, check.stderr).toBe(0);
  });

  it('still refuses when a real runtime sibling changes after the stamp (control)', () => {
    expect(run('stamp').status).toBe(0);
    writeFileSync(join(outdir, 'worker.mjs'), 'console.log(3);\n');
    const check = run('check');
    expect(check.status).not.toBe(0);
    expect(check.stderr).toContain('output-tree mismatch');
  });
});

describe('bundle-host-freshness installed dependencies', () => {
  function install(path: string, version: string) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'sdk', version }));
  }

  it('rejects a changed installed lock with unchanged HEAD and output bytes', () => {
    expect(run('stamp').status).toBe(0);
    writeFileSync(join(repo, 'node_modules/.package-lock.json'), '{"lockfileVersion":3,"packages":{"sdk":{"version":"2.0.0"}}}\n');
    const check = run('check');
    expect(check.status).not.toBe(0);
    expect(check.stderr).toContain('installed-dependency mismatch');
  });

  it('rejects physical package drift even when the installed lock is unchanged', () => {
    const sdk = join(repo, 'node_modules/@vendor/sdk');
    install(sdk, '3.0.0');
    expect(run('stamp').status).toBe(0);
    install(sdk, '2.0.0');
    const check = run('check');
    expect(check.status).not.toBe(0);
    expect(check.stderr).toContain('installed-dependency mismatch');
  });

  it('rejects a newly shadowing nested package with unchanged root metadata', () => {
    const sdk = join(repo, 'node_modules/sdk');
    install(sdk, '3.0.0');
    expect(run('stamp').status).toBe(0);
    install(join(sdk, 'node_modules/core'), '2.0.0');
    const check = run('check');
    expect(check.status).not.toBe(0);
    expect(check.stderr).toContain('installed-dependency mismatch');
  });

  it('pins workspace symlink resolution and terminates dependency cycles', () => {
    const first = join(repo, 'workspace-a');
    const second = join(repo, 'workspace-b');
    install(first, '1.0.0');
    install(second, '1.0.0');
    mkdirSync(join(first, 'node_modules'));
    symlinkSync(first, join(first, 'node_modules/self'));
    const link = join(repo, 'node_modules/sdk');
    symlinkSync(first, link);
    expect(run('stamp').status).toBe(0);
    expect(run('check').status).toBe(0);
    rmSync(link);
    symlinkSync(second, link);
    const check = run('check');
    expect(check.status).not.toBe(0);
    expect(check.stderr).toContain('installed-dependency mismatch');
  });

  it('refuses reusable proof without an installed lock', () => {
    expect(run('stamp').status).toBe(0);
    rmSync(join(repo, 'node_modules/.package-lock.json'));
    expect(run('check').status).not.toBe(0);
    expect(run('stamp').stderr).toContain('installed dependency lock is missing');
  });

  it('invalidates legacy proofs that never pinned installed dependencies', () => {
    expect(run('stamp').status).toBe(0);
    const path = join(outdir, '.bundle-fresh.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.schemaVersion = 'bundle-host-freshness-v1';
    delete manifest.dependencies;
    writeFileSync(path, JSON.stringify(manifest));
    const check = run('check');
    expect(check.status).not.toBe(0);
    expect(check.stderr).toContain('schema mismatch');
  });
});
