import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { expect, test } from 'vitest';
import { assertPuiBinaryUnchanged, resolvePuiWorkbenchZellij, snapshotCurrentPuiBinary } from './pui-binary';

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

test('current-build workbench and control commands retain the selected multiplexer generation', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pui-dependency-test-'));
  let snapshot: ReturnType<typeof snapshotCurrentPuiBinary> | undefined;
  try {
    const source = path.join(root, 'pui');
    const zellij = path.join(root, 'zellij');
    writeFileSync(source, 'pui build');
    writeFileSync(zellij, 'selected multiplexer');
    snapshot = snapshotCurrentPuiBinary(source, { zellijPath: zellij });
    writeFileSync(zellij, 'concurrent multiplexer replacement');
    expect(path.dirname(snapshot.zellij!.binary)).toBe(path.dirname(snapshot.binary));
    expect(readFileSync(snapshot.zellij!.binary, 'utf8')).toBe('selected multiplexer');
    expect(statSync(snapshot.zellij!.binary).mode & 0o777).toBe(0o555);
    expect(() => assertPuiBinaryUnchanged(snapshot!.zellij!.binary, snapshot!.zellij!.sha256)).not.toThrow();
    chmodSync(snapshot.zellij!.binary, 0o755);
    writeFileSync(snapshot.zellij!.binary, 'corrupted multiplexer');
    expect(() => assertPuiBinaryUnchanged(snapshot!.zellij!.binary, snapshot!.zellij!.sha256)).toThrow('binary changed');
  } finally {
    if (snapshot) rmSync(snapshot.directory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('workbench dependency selection uses PUI siblings before PATH and skips nonexecutables', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pui-dependency-path-'));
  try {
    const sibling = path.join(root, 'zellij');
    const fallback = path.join(root, 'fallback');
    mkdirSync(fallback);
    writeFileSync(sibling, 'not executable');
    writeFileSync(path.join(fallback, 'zellij'), 'PATH multiplexer', { mode: 0o755 });
    expect(resolvePuiWorkbenchZellij(path.join(root, 'pui'), fallback)).toBe(path.join(fallback, 'zellij'));
    chmodSync(sibling, 0o755);
    expect(resolvePuiWorkbenchZellij(path.join(root, 'pui'), fallback)).toBe(sibling);
    rmSync(sibling);
    rmSync(path.join(fallback, 'zellij'));
    expect(resolvePuiWorkbenchZellij(path.join(root, 'pui'), fallback)).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
