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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  writeFileSync(join(repo, '.gitignore'), 'dist-host/\n');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  outdir = join(repo, 'dist-host');
  mkdirSync(outdir);
  writeFileSync(join(outdir, 'hono-host.mjs'), 'console.log(1);\n');
  writeFileSync(join(outdir, 'worker.mjs'), 'console.log(2);\n');
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
