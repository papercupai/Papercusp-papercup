import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { expect, test } from 'vitest';
import { assertPuiBinaryUnchanged, snapshotCurrentPuiBinary } from './pui-binary';

test('current-build panes keep one private executable when the shared cargo output is replaced', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pui-build-test-'));
  let snapshot: ReturnType<typeof snapshotCurrentPuiBinary> | undefined;
  try {
    const source = path.join(root, 'pui');
    writeFileSync(source, 'first build');
    snapshot = snapshotCurrentPuiBinary(source);
    writeFileSync(source, 'concurrent build');
    expect(snapshot.binary).not.toBe(source);
    expect(path.basename(snapshot.binary)).toBe('pui');
    expect(readFileSync(snapshot.binary, 'utf8')).toBe('first build');
    expect(statSync(snapshot.binary).mode & 0o777).toBe(0o555);
    expect(() => assertPuiBinaryUnchanged(snapshot!.binary, snapshot!.sha256)).not.toThrow();
    expect(() => assertPuiBinaryUnchanged(source, snapshot!.sha256)).toThrow('binary changed');
    chmodSync(snapshot.binary, 0o755);
    writeFileSync(snapshot.binary, 'corrupted private build');
    expect(() => assertPuiBinaryUnchanged(snapshot!.binary, snapshot!.sha256)).toThrow('binary changed');
  } finally {
    if (snapshot) rmSync(snapshot.directory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
