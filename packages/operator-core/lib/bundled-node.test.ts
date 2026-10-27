/**
 * bundled-node.test.ts — resolveBundledNode, the absolute-path node resolver
 * used wherever a bare `node` would be resolved from a PATH we do not control
 * (EI-20078551747038927: git's `ext::` transport command).
 *
 * The load-bearing case is `EI-2114`: in a packaged Tauri build
 * `process.execPath` is the Tauri/sidecar binary, NOT node. A resolver that
 * returned it would hand a non-interpreter to git on exactly the packaged
 * installs this exists to serve, so that guard is pinned explicitly below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveBundledNode } from './bundled-node';

let tmp: string;
let origExecPath: string;

/** A real Node fixture proves interpreter identity rather than mere file existence. */
async function touch(p: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.symlink(origExecPath, p);
}
/** process.execPath is a writable string; override it (restored in afterEach). */
function setExecPath(p: string): void {
  process.execPath = p;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bundled-node-'));
  origExecPath = process.execPath;
});
afterEach(async () => {
  setExecPath(origExecPath);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('resolveBundledNode', () => {
  it('normalizes a relative sidecar anchor before the child can change working directory', async () => {
    const bundled = path.join(tmp, 'sidecar', 'bin', 'node');
    await touch(bundled);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', path.relative(process.cwd(), path.dirname(bundled)));
    expect(await resolveBundledNode()).toBe(bundled);
  });

  it('refuses a Bun or invalid executable named node instead of inferring its interpreter from the filename', async () => {
    const bin = path.join(tmp, 'retained', 'bin');
    const executable = path.join(bin, 'node');
    await fs.mkdir(bin, { recursive: true });
    if (process.env.PAPERCUSP_RUNTIME_TEST_BUN) {
      await fs.symlink(process.env.PAPERCUSP_RUNTIME_TEST_BUN, executable);
    } else await fs.writeFile(executable, '');
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', bin);
    setExecPath(path.join(tmp, 'Papercusp'));
    expect(await resolveBundledNode()).toBeNull();
  });

  it('anchor 1: uses $PAPERCUSP_SIDECAR_BIN/node — including an install path containing a space', async () => {
    // The real macOS layout: /Applications/Papercusp GUI.app/Contents/Resources/sidecar/bin/node
    const sidecarBin = path.join(tmp, 'Papercusp GUI.app', 'Contents', 'Resources', 'sidecar', 'bin');
    const bundled = path.join(sidecarBin, 'node');
    await touch(bundled);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', sidecarBin);
    setExecPath(path.join(tmp, 'other', 'node')); // does not exist; env anchor wins regardless

    expect(await resolveBundledNode()).toBe(bundled);
  });

  it('anchor 2: falls to process.execPath when it really is a node binary and SIDECAR_BIN is unset', async () => {
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', '');
    const bundled = path.join(tmp, 'sidecar', 'bin', 'node');
    await touch(bundled);
    setExecPath(bundled);

    expect(await resolveBundledNode()).toBe(bundled);
  });

  it('accepts a node.exe execPath (Windows)', async () => {
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', '');
    const bundled = path.join(tmp, 'sidecar', 'node.exe');
    await touch(bundled);
    setExecPath(bundled);

    expect(await resolveBundledNode()).toBe(bundled);
  });

  it('finds packaged node.exe when the application runs under a different interpreter', async () => {
    const bundled = path.join(tmp, 'Papercusp GUI', 'sidecar', 'bin', 'node.exe');
    await touch(bundled);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', path.dirname(bundled));
    setExecPath(path.join(tmp, 'Papercusp GUI', 'sidecar', 'bin', 'bun.exe'));

    expect(await resolveBundledNode()).toBe(bundled);
  });

  it('validates interpreter identity for the packaged node.exe candidate too', async () => {
    const bin = path.join(tmp, 'sidecar', 'bin');
    const executable = path.join(bin, 'node.exe');
    await fs.mkdir(bin, { recursive: true });
    if (process.env.PAPERCUSP_RUNTIME_TEST_BUN) {
      await fs.symlink(process.env.PAPERCUSP_RUNTIME_TEST_BUN, executable);
    } else await fs.writeFile(executable, '');
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', bin);
    setExecPath(path.join(tmp, 'Papercusp'));

    expect(await resolveBundledNode()).toBeNull();
  });

  it('prefers $PAPERCUSP_SIDECAR_BIN/node over process.execPath when both exist', async () => {
    const envNode = path.join(tmp, 'sidecar', 'bin', 'node');
    const execNode = path.join(tmp, 'other-node', 'node');
    await touch(envNode);
    await touch(execNode);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', path.dirname(envNode));
    setExecPath(execNode);

    expect(await resolveBundledNode()).toBe(envNode);
  });

  it('EI-2114: NEVER returns a packaged Tauri execPath, even though that binary exists', async () => {
    // A packaged build with no SIDECAR_BIN exported: execPath is the app binary.
    // Returning it would hand git a non-interpreter — the whole point of the
    // basename gate. `null` is the correct answer here, not a plausible path.
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', '');
    const tauriBinary = path.join(tmp, 'Papercusp GUI.app', 'Contents', 'MacOS', 'papercusp-desktop');
    await touch(tauriBinary);
    setExecPath(tauriBinary);

    expect(await resolveBundledNode()).toBeNull();
  });

  it('EI-2114: a tsx wrapper execPath is refused the same way', async () => {
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', '');
    const tsxWrapper = path.join(tmp, 'bin', 'tsx');
    await touch(tsxWrapper);
    setExecPath(tsxWrapper);

    expect(await resolveBundledNode()).toBeNull();
  });

  it('returns null when the sidecar anchor is set but the binary is absent (no phantom path)', async () => {
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', path.join(tmp, 'sidecar', 'bin')); // nothing written there
    setExecPath(path.join(tmp, 'nope', 'notnode'));

    expect(await resolveBundledNode()).toBeNull();
  });
});
