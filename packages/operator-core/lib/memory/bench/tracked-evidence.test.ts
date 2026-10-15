import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as current from './tracked-evidence';

// Copy-out mutation probes point PAPERCUSP_MUTATION_PROBE_SOURCE at the mutant.
const { assertTrackedEvidence, trackedEvidence }: typeof current = process.env.PAPERCUSP_MUTATION_PROBE_SOURCE
  ? await import(pathToFileURL(process.env.PAPERCUSP_MUTATION_PROBE_SOURCE).href)
  : current;

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const git = (cwd: string, ...args: string[]) => execFileSync('git',
  ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
  { cwd, env, stdio: 'ignore' });

const roots: string[] = [];
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tracked-evidence-')));
  roots.push(root);
  git(root, 'init', '-q');
  fs.mkdirSync(path.join(root, 'docs/evidence'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'docs/evidence/ignored.json\n');
  for (const name of ['tracked', 'untracked', 'ignored']) fs.writeFileSync(path.join(root, `docs/evidence/${name}.json`), '{}');
  git(root, 'add', '.gitignore', 'docs/evidence/tracked.json');
  git(root, 'commit', '-qm', 'seed');
  // A nested repository stands in for a submodule: its manifest is tracked
  // inside it and absent from the outer index.
  const sub = path.join(root, 'libs/sub');
  fs.mkdirSync(sub, { recursive: true });
  git(sub, 'init', '-q');
  fs.writeFileSync(path.join(sub, 'manifest.json'), '{}');
  git(sub, 'add', 'manifest.json');
  git(sub, 'commit', '-qm', 'sub');
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tracked-evidence-norepo-')));
  roots.push(outside);
  fs.writeFileSync(path.join(outside, 'loose.json'), '{}');
  return { root, sub, loose: path.join(outside, 'loose.json'), ev: (n: string) => path.join(root, `docs/evidence/${n}.json`) };
}

afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

describe('shipped evidence must be tracked in its owning repository (R-8)', () => {
  it('accepts committed manifests and resolves a submodule-internal manifest inside its own repository', () => {
    const f = fixture();
    expect(trackedEvidence(f.ev('tracked'))).toEqual({ path: f.ev('tracked'), repoRoot: f.root, repoRelative: 'docs/evidence/tracked.json' });
    expect(trackedEvidence(path.join(f.sub, 'manifest.json'))).toEqual({ path: path.join(f.sub, 'manifest.json'), repoRoot: f.sub, repoRelative: 'manifest.json' });
    // Calibration: a detector that refuses everything must fail here.
    expect(assertTrackedEvidence([f.ev('tracked'), path.join(f.sub, 'manifest.json')])).toHaveLength(2);
  });

  it('refuses untracked, ignored, missing and out-of-repo manifests, naming every one', () => {
    const f = fixture();
    for (const p of [f.ev('untracked'), f.ev('ignored'), f.ev('absent'), f.loose, path.join(f.root, 'docs/evidence')]) expect(trackedEvidence(p)).toBeNull();
    expect(() => assertTrackedEvidence([f.ev('tracked'), f.ev('untracked'), f.loose]))
      .toThrow(`untracked shipped evidence: ${f.ev('untracked')}, ${f.loose}`);
    expect(() => assertTrackedEvidence([])).toThrow('no evidence manifests cited');
  });

  it('answers about the file owner even when an inherited GIT_DIR points elsewhere', () => {
    const f = fixture();
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(f.sub, '.git');
    try {
      expect(trackedEvidence(f.ev('tracked'))?.repoRoot).toBe(f.root);
      expect(trackedEvidence(f.ev('untracked'))).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
    }
  });
});
