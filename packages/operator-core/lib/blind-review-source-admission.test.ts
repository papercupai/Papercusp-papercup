import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifierSourceFiles, type VerifierSourceReceipt } from '@papercusp/test-config/verifier-source';
import { restrictedFrozenSourceRefusal } from './agent-tools/testing/restricted-hold-fence';
import { git, write } from './source-preview.fixture';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'broker-origin-')); roots.push(root);
  write(root, 'apps/tool.js', 'committed source');
  write(root, 'apps/run.sh', '#!/bin/sh\nexit 0\n'); chmodSync(join(root, 'apps/run.sh'), 0o755);
  symlinkSync('tool.js', join(root, 'apps/link.js'));
  git(root, ['init', '-q']); git(root, ['add', '.']); git(root, ['commit', '-qm', 'independent origin']);
  const source: VerifierSourceReceipt = { schemaVersion: 'verifier-source-v1',
    sourceCommit: git(root, ['rev-parse', 'HEAD']), testedInputs: [],
    files: verifierSourceFiles(root, { gitMetadataPaths: ['.git'] }) };
  return { root, source };
}

describe('sealed source independent Git origin', () => {
  it('qualifies regular files, executable modes and symlink targets without reading dirty working bytes', async () => {
    const f = fixture();
    expect(f.source.files.some(file => file.kind === 'symlink')).toBe(true);
    write(f.root, 'apps/tool.js', 'dirty canonical source');
    rmSync(join(f.root, 'apps/link.js')); symlinkSync('/etc/passwd', join(f.root, 'apps/link.js'));
    expect(await restrictedFrozenSourceRefusal(f.root, f.source)).toBeNull();
  });

  it.each(['content', 'executable', 'kind', 'symlink-target', 'missing-path', 'missing-commit'])(
    'refuses an internally consistent receipt that differs from committed origin (%s)', async defect => {
      const f = fixture();
      expect(await restrictedFrozenSourceRefusal(f.root, f.source)).toBeNull();
      const changed = structuredClone(f.source);
      const regular = changed.files.find(file => file.path === 'apps/tool.js')!;
      const link = changed.files.find(file => file.path === 'apps/link.js')!;
      if (defect === 'content') regular.sha256 = 'a'.repeat(64);
      if (defect === 'executable') regular.executable = true;
      if (defect === 'kind') { regular.kind = 'symlink'; regular.executable = true; }
      if (defect === 'symlink-target') link.sha256 = 'b'.repeat(64);
      if (defect === 'missing-path') regular.path = 'apps/absent.js';
      if (defect === 'missing-commit') changed.sourceCommit = '0'.repeat(40);
      expect(await restrictedFrozenSourceRefusal(f.root, changed)).toMatchObject({ error: 'restricted_hold_state_unknown' });
    });

  it('fails closed when independent Git origin disappears', async () => {
    const f = fixture(); rmSync(join(f.root, '.git'), { recursive: true });
    expect(await restrictedFrozenSourceRefusal(f.root, f.source)).toMatchObject({ error: 'restricted_hold_state_unknown' });
  });
});
