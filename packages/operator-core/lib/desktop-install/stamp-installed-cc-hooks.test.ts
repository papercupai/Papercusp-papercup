/**
 * WI-6554700010010534: install-standalone-mcp.sh copies the cc hooks itself; this stamp is
 * what lets the desktop installer's downgrade guard compare dates afterwards.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyDowngrade, readInstallStamp } from './install-provenance';
import { CC_HOOK_FILES } from './papercusp-files';
import { stampInstalledCcHooks } from './stamp-installed-cc-hooks';

const [HOOK_A, HOOK_B] = CC_HOOK_FILES;
const A_AT = '2026-10-01T10:00:00.000Z';
const B_AT = '2026-10-05T10:00:00.000Z';
const UNRELATED_AT = '2026-10-09T10:00:00.000Z';

let root: string;
let src: string;
let home: string;
let dest: string;

function commit(name: string, body: string, date: string) {
  writeFileSync(join(src, name), body);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
  execFileSync('git', ['-C', src, 'add', name], { stdio: 'ignore', env });
  execFileSync('git', ['-C', src, 'commit', '-q', '-m', name], { stdio: 'ignore', env });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stamp-cc-'));
  src = join(root, 'repo', 'hooks', 'cc');
  home = join(root, 'home');
  dest = join(home, '.papercusp', 'hooks', 'cc');
  mkdirSync(src, { recursive: true });
  mkdirSync(dest, { recursive: true });
  execFileSync('git', ['-C', src, 'init', '-q'], { stdio: 'ignore' });
  commit(HOOK_A, 'echo a\n', A_AT);
  commit(HOOK_B, 'echo b\n', B_AT);
  // Newer than both, but not a CC hook: it must not date the stamp.
  commit('unrelated-helper.sh', 'echo u\n', UNRELATED_AT);
  writeFileSync(join(dest, HOOK_A), 'echo a\n');
  writeFileSync(join(dest, HOOK_B), 'echo stale b\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('stampInstalledCcHooks', () => {
  it('needs at least two CC hooks to exercise the scoping', () => {
    expect(HOOK_A).toBeTruthy();
    expect(HOOK_B).toBeTruthy();
  });

  it('dates the stamp by the latest CC hook commit, not the directory', async () => {
    const stamp = await stampInstalledCcHooks(src, { home, installedBy: 'test', now: new Date('2026-10-13T00:00:00Z') });
    expect(stamp.sourceCommittedAt).toBe(B_AT);
    expect(stamp.sourceSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await readInstallStamp(dest)).toMatchObject({
      sourceDir: src,
      sourceCommittedAt: B_AT,
      installedAt: '2026-10-13T00:00:00.000Z',
      installedBy: 'test',
    });
  });

  it('lists only hooks whose installed bytes match the source', async () => {
    const stamp = await stampInstalledCcHooks(src, { home });
    expect(stamp.files).toEqual([HOOK_A]);
    expect(stamp.uncommittedFiles).toEqual([]);
  });

  it('replaces a stale undated record, so an older package is refused afterwards', async () => {
    writeFileSync(
      join(dest, '.installed-from'),
      JSON.stringify({ sourceDir: '/usr/lib/Papercusp Server/sidecar/apps/operator/scripts/hooks/cc', installedAt: 'x', pid: 1 }),
    );
    await stampInstalledCcHooks(src, { home });
    const olderPackage = { sourceCommittedAt: '2026-10-02T00:00:00.000Z' };
    expect(classifyDowngrade(await readInstallStamp(dest), olderPackage, 0)).toMatchObject({ downgrade: true });
  });
});
