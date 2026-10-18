/**
 * The `pui` binary under test, for installed-binary e2e suites.
 *
 * PUI_BIN explicitly selects an installed artifact; otherwise ALWAYS build
 * (incremental — a no-op when current). Reusing whatever binary already exists
 * measured stale code while reporting a current pass, which then bound as
 * evidence for source it never ran.
 *
 * agent-chat-pty and context-pane-cockpit-pty still carry their own copies of
 * this contract; they are bound release evidence, so they move here only with
 * their next evidence refresh.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
export const TUI_DIR = path.join(REPO_ROOT, 'apps', 'tui');

export function assertPuiBinaryUnchanged(binary: string, sha256: string): string {
  const actual = createHash('sha256').update(readFileSync(binary)).digest('hex');
  if (actual !== sha256) throw new Error(`PUI binary changed during acceptance: ${binary}; expected ${sha256}, got ${actual}`);
  return actual;
}

/** Cargo's shared output may be replaced by another build while panes start. */
export function snapshotCurrentPuiBinary(source: string) {
  const sha256 = createHash('sha256').update(readFileSync(source)).digest('hex');
  const directory = mkdtempSync(path.join(tmpdir(), 'pui-current-binary-'));
  const binary = path.join(directory, 'pui');
  try {
    copyFileSync(source, binary);
    assertPuiBinaryUnchanged(source, sha256);
    assertPuiBinaryUnchanged(binary, sha256);
    chmodSync(binary, 0o555);
    return { binary, directory, source, sha256 };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function cargoTargetDir(): string | null {
  const probe = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], {
    cwd: TUI_DIR,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (probe.status !== 0 || !probe.stdout) return null;
  try {
    return (JSON.parse(probe.stdout) as { target_directory?: string }).target_directory ?? null;
  } catch {
    return null;
  }
}

/** The debug build `cargo build --bin pui` just produced. */
function builtPuiBinary(): string | null {
  const targetDir = cargoTargetDir();
  const candidates: Array<string | null> = [
    targetDir ? path.join(targetDir, 'debug', 'pui') : null,
    path.join(TUI_DIR, 'target', 'debug', 'pui'),
  ];
  return candidates.find((c): c is string => Boolean(c && existsSync(c))) ?? null;
}

export function ensurePuiBinary(): string {
  if (process.env.PUI_BIN) {
    if (!existsSync(process.env.PUI_BIN)) throw new Error('The explicit PUI_BIN artifact does not exist');
    return process.env.PUI_BIN;
  }
  const build = spawnSync('cargo', ['build', '--locked', '--bin', 'pui'], {
    cwd: TUI_DIR,
    encoding: 'utf8',
    timeout: 840_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (build.status !== 0) {
    throw new Error(`cargo build --locked --bin pui failed:\n${build.stderr?.slice(-4000)}`);
  }
  const built = builtPuiBinary();
  if (!built) throw new Error('pui binary is absent after a successful cargo build');
  return built;
}
