/**
 * replaceFileContents (WI-10006772): the capability mutation doors replace a file by renaming a
 * temp file over it, so a bash process already executing that file keeps reading its original
 * bytes. The first test is the guarantee itself, with an in-place write as the calibration
 * control: if the control stops reproducing the hazard, the test says so instead of passing
 * vacuously.
 */

import { spawn } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTextCollector } from '../../child-output';
import { replaceFileContents } from './replace-file';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'replace-file-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// The edit inserts 8 bytes ABOVE the point where the running shell will resume. After an in-place
// write, the resume offset lands on `echo SHIFTED`; after a rename, the shell still holds the
// original inode and resumes at `echo ORIGINAL`.
const ORIGINAL = 'echo STARTED\nsleep 1\necho ORIGINAL\n';
const EDITED = 'echo STARTED\n#pad123\necho SHIFTED\nsleep 1\necho ORIGINAL\n';

function runWhileEditing(script: string, edit: () => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = createTextCollector(child.stdout);
    let edited = false;
    child.stdout.on('data', () => {
      // STARTED is printed just before `sleep 1`, so the edit lands while bash waits on it.
      if (!edited && out.peek().includes('STARTED\n')) {
        edited = true;
        edit();
      }
    });
    child.on('error', reject);
    child.on('close', () => resolve(out.text()));
  });
}

describe('replaceFileContents', () => {
  it('a running bash script keeps executing its original bytes (in-place write is the control)', async () => {
    const control = join(dir, 'control.sh');
    writeFileSync(control, ORIGINAL, 'utf8');
    const controlOut = await runWhileEditing(control, () => writeFileSync(control, EDITED, 'utf8'));
    // Calibration: an in-place write really does shift the running shell's next read.
    expect(controlOut).toContain('SHIFTED');

    const subject = join(dir, 'subject.sh');
    writeFileSync(subject, ORIGINAL, 'utf8');
    const subjectOut = await runWhileEditing(subject, () => replaceFileContents(subject, EDITED));
    expect(subjectOut).toBe('STARTED\nORIGINAL\n');
    expect(readFileSync(subject, 'utf8')).toBe(EDITED);
  }, 15_000);

  it('gives an existing path a new inode with the new contents', () => {
    const p = join(dir, 'a.txt');
    writeFileSync(p, 'old\n', 'utf8');
    const before = statSync(p).ino;
    replaceFileContents(p, 'new\n');
    expect(readFileSync(p, 'utf8')).toBe('new\n');
    expect(statSync(p).ino).not.toBe(before);
  });

  it('keeps the permission bits, so an executable script stays executable', () => {
    const p = join(dir, 'run.sh');
    writeFileSync(p, '#!/bin/sh\n', 'utf8');
    chmodSync(p, 0o751);
    replaceFileContents(p, '#!/bin/sh\necho hi\n');
    expect(statSync(p).mode & 0o7777).toBe(0o751);
  });

  it('replaces the target of a symlinked path and leaves the link in place', () => {
    const target = join(dir, 'real.txt');
    const link = join(dir, 'link.txt');
    writeFileSync(target, 'old\n', 'utf8');
    symlinkSync(target, link);
    replaceFileContents(link, 'new\n');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe('new\n');
  });

  it('creates a path that does not exist yet', () => {
    const p = join(dir, 'fresh.txt');
    replaceFileContents(p, 'hello\n');
    expect(readFileSync(p, 'utf8')).toBe('hello\n');
  });

  it.skipIf(process.getuid?.() === 0)('refuses a file the caller may not write, like an in-place write would', () => {
    const p = join(dir, 'ro.txt');
    writeFileSync(p, 'keep\n', 'utf8');
    chmodSync(p, 0o444);
    expect(() => replaceFileContents(p, 'clobber\n')).toThrow(/EACCES/);
    expect(readFileSync(p, 'utf8')).toBe('keep\n');
  });

  it('leaves no temp file behind, on success or when the rename fails', () => {
    const p = join(dir, 'b.txt');
    writeFileSync(p, 'old\n', 'utf8');
    replaceFileContents(p, 'new\n');
    expect(readdirSync(dir).sort()).toEqual(['b.txt']);

    // A directory at the path passes realpath, access and stat, then the rename fails.
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    expect(() => replaceFileContents(sub, 'x\n')).toThrow();
    expect(readdirSync(dir).sort()).toEqual(['b.txt', 'sub']);
  });
});

describe('capability mutation doors', () => {
  // Every door that rewrites an existing file must go through replaceFileContents. A bare
  // writeFileSync here is the in-place write that broke the c1008s soak.
  const doors = ['edit.ts', 'write.ts', 'patch.ts', 'notebook.ts'];
  it.each(doors)('%s writes through replaceFileContents, never writeFileSync', (door) => {
    const src = readFileSync(join(__dirname, door), 'utf8');
    expect(src).toMatch(/\breplaceFileContents\(/);
    expect(src).not.toMatch(/\bwriteFileSync\(/);
  });
});
