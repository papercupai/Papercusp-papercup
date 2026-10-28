import { hermeticSpawnEnv } from './__tests__/hermetic-spawn-env';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const ASSERTS = resolve(__dirname, '../../../papercusp-desktop/bin/lib/federation-asserts.sh');
const src = readFileSync(SCRIPT, 'utf8');
const lockRootAssignment = src.match(/^TAURI_VERIFIER_LOCK_ROOT=.*$/m)?.[0];
const displayLockAssignment = src.match(/^DISPLAY_LOCK_DIR=.*$/m)?.[0];
const portLockAssignment = src.match(/^PORT_LOCK_DIR=.*$/m)?.[0];
// pick_and_lock_ports is lifted out of the script and run on its own, so the
// snippet must also carry every script-local helper it calls, transitively.
// Lifting only the one function went red with `verify_reserved_port_pair:
// command not found` (exit 127) as soon as the bind probe was factored out
// beside it; deriving the helper set from the script keeps the snippet in step
// instead of relying on a hand-maintained list.
const scriptFunctionNames = [...src.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\(\) \{/gm)].map(match => match[1]);

function extractScriptFunction(name: string): string | undefined {
  // A one-line body (`log() { ...; }`) closes on its own line; a multi-line body
  // closes at the next column-0 `}` (heredoc lines inside it stay indented).
  return src.match(new RegExp(`^${name}\\(\\) \\{.*\\}[ \\t]*$`, 'm'))?.[0]
    ?? src.match(new RegExp(`^${name}\\(\\) \\{[ \\t]*\\n[\\s\\S]*?^\\}`, 'm'))?.[0];
}

function extractFunctionWithLocalHelpers(root: string): string | undefined {
  const bodies: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string): boolean => {
    if (seen.has(name)) return true;
    seen.add(name);
    const body = extractScriptFunction(name);
    if (!body) return false;
    for (const helper of scriptFunctionNames) {
      if (helper !== name && new RegExp(`\\b${helper}\\b`).test(body) && !visit(helper)) return false;
    }
    bodies.push(body);
    return true;
  };
  return visit(root) ? bodies.join('\n') : undefined;
}

const pickAndLockPortsFunction = extractFunctionWithLocalHelpers('pick_and_lock_ports');

function commonEnv(root: string, privateTmpdir: string, runtimeDir: string, home: string) {
  return {
    ...hermeticSpawnEnv(),
    FEDERATION_ASSERTS: ASSERTS,
    PRIVATE_TMPDIR: privateTmpdir,
    XDG_RUNTIME_DIR: runtimeDir,
    HOME: home,
    VERIFY_TAURI_PORT_LOCK_DIR: '',
    VERIFY_TAURI_DISPLAY_LOCK_DIR: '',
    LOCK_READY: join(root, 'ready'),
    LOCK_RELEASE: join(root, 'release'),
    LOCK_PORT: '49399',
  };
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected an IPv4 address from an ephemeral TCP listener');
  }
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
  });
  return port;
}

describe('verify-tauri-headless shares reservation locks across isolated TMPDIRs', () => {
  it('keeps the actual port flock shared between two concurrent launchers', async () => {
    expect(lockRootAssignment).toBeTruthy();
    expect(displayLockAssignment).toBeTruthy();
    expect(portLockAssignment).toBeTruthy();

    const root = mkdtempSync(join(tmpdir(), 'verify-tauri-shared-locks-'));
    const tmpA = join(root, 'private-a');
    const tmpB = join(root, 'private-b');
    const runtimeDir = join(root, 'runtime');
    const home = join(root, 'home');
    mkdirSync(tmpA);
    mkdirSync(tmpB);
    mkdirSync(runtimeDir);
    mkdirSync(home);

    const firstScript = [
      'set -euo pipefail',
      'source "$FEDERATION_ASSERTS"',
      'TMPDIR="$PRIVATE_TMPDIR"',
      lockRootAssignment!,
      displayLockAssignment!,
      portLockAssignment!,
      'fed_acquire_port_lock "$LOCK_PORT" "$PORT_LOCK_DIR"',
      'printf "%s\\n%s\\n" "$PORT_LOCK_DIR" "$DISPLAY_LOCK_DIR" > "$LOCK_READY"',
      'while [ ! -e "$LOCK_RELEASE" ]; do sleep 0.01; done',
      'fed_release_port_locks',
    ].join('\n');

    const secondScript = [
      'set -euo pipefail',
      'source "$FEDERATION_ASSERTS"',
      'TMPDIR="$PRIVATE_TMPDIR"',
      lockRootAssignment!,
      displayLockAssignment!,
      portLockAssignment!,
      'printf "PORT_LOCK_DIR=%s\\nDISPLAY_LOCK_DIR=%s\\n" "$PORT_LOCK_DIR" "$DISPLAY_LOCK_DIR"',
      'if fed_acquire_port_lock "$LOCK_PORT" "$PORT_LOCK_DIR"; then',
      '  echo "second launcher unexpectedly acquired the reserved port" >&2',
      '  exit 9',
      'fi',
      'echo "second launcher was blocked by the shared flock"',
    ].join('\n');

    const first = spawn('bash', ['-c', firstScript], {
      env: commonEnv(root, tmpA, runtimeDir, home),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const firstDone = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveDone) => {
      first.once('close', (code, signal) => resolveDone({ code, signal }));
    });

    let firstStdout = '';
    let firstStderr = '';
    first.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      firstStdout += chunk;
    });
    first.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      firstStderr += chunk;
    });

    try {
      const deadline = Date.now() + 3000;
      while (!existsSync(join(root, 'ready')) && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      expect(existsSync(join(root, 'ready')), firstStderr).toBe(true);

      const [firstPortDir, firstDisplayDir] = readFileSync(join(root, 'ready'), 'utf8').trim().split('\n');
      const second = spawnSync('bash', ['-c', secondScript], {
        env: commonEnv(root, tmpB, runtimeDir, home),
        encoding: 'utf8',
      });

      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain('PORT_LOCK_DIR=' + firstPortDir);
      expect(second.stdout).toContain('DISPLAY_LOCK_DIR=' + firstDisplayDir);
      expect(second.stdout).toContain('second launcher was blocked by the shared flock');
      expect(firstPortDir).toBe(join(runtimeDir, 'papercusp-tauri-verifier', 'port-locks'));
      expect(firstDisplayDir).toBe(join(runtimeDir, 'papercusp-tauri-verifier', 'display-locks'));
    } finally {
      writeFileSync(join(root, 'release'), 'release');
      const result = await firstDone;
      expect(result.code, firstStderr || firstStdout).toBe(0);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('walks to another port pair when isolated TMPDIRs share XDG_RUNTIME_DIR', async () => {
    expect(lockRootAssignment).toBeTruthy();
    expect(portLockAssignment).toBeTruthy();
    expect(pickAndLockPortsFunction).toBeTruthy();

    const root = mkdtempSync(join(tmpdir(), 'verify-tauri-port-picker-locks-'));
    const tmpA = join(root, 'private-a');
    const tmpB = join(root, 'private-b');
    const runtimeDir = join(root, 'runtime');
    const home = join(root, 'home');
    mkdirSync(tmpA);
    mkdirSync(tmpB);
    mkdirSync(runtimeDir);
    mkdirSync(home);
    const portBase = await getFreePort();

    const pickScript = [
      'set -euo pipefail',
      'source "$FEDERATION_ASSERTS"',
      'TMPDIR="$PRIVATE_TMPDIR"',
      lockRootAssignment!,
      portLockAssignment!,
      'PORT_BASE="$LOCK_PORT"',
      pickAndLockPortsFunction!,
      'pick_and_lock_ports',
    ];
    const firstScript = [
      ...pickScript,
      'printf "%s\\n%s\\n%s\\n" "$PORT_LOCK_DIR" "$DEV_PORT" "$PTY_PORT" > "$LOCK_READY"',
      'while [ ! -e "$LOCK_RELEASE" ]; do sleep 0.01; done',
      'fed_release_port_locks',
    ].join('\n');
    const secondScript = [
      ...pickScript,
      'printf "%s\\n%s\\n%s\\n" "$PORT_LOCK_DIR" "$DEV_PORT" "$PTY_PORT"',
      'fed_release_port_locks',
    ].join('\n');

    const first = spawn('bash', ['-c', firstScript], {
      env: { ...commonEnv(root, tmpA, runtimeDir, home), LOCK_PORT: String(portBase) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const firstDone = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveDone) => {
      first.once('close', (code, signal) => resolveDone({ code, signal }));
    });

    let firstStdout = '';
    let firstStderr = '';
    first.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      firstStdout += chunk;
    });
    first.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      firstStderr += chunk;
    });

    try {
      // Each launcher runs the script's real loopback bind probe (a node child)
      // before it accepts a pair, so allow for node startup on a loaded host.
      const deadline = Date.now() + 15_000;
      while (!existsSync(join(root, 'ready')) && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      expect(existsSync(join(root, 'ready')), firstStderr).toBe(true);

      const [firstPortDir, firstDevPort, firstPtyPort] = readFileSync(join(root, 'ready'), 'utf8').trim().split('\n');
      const second = spawnSync('bash', ['-c', secondScript], {
        env: { ...commonEnv(root, tmpB, runtimeDir, home), LOCK_PORT: String(portBase) },
        encoding: 'utf8',
      });
      const [secondPortDir, secondDevPort, secondPtyPort] = second.stdout.trim().split('\n');

      expect(second.status, second.stderr).toBe(0);
      expect(secondPortDir).toBe(firstPortDir);
      expect(firstPortDir).toBe(join(runtimeDir, 'papercusp-tauri-verifier', 'port-locks'));
      expect(Number(secondDevPort)).toBeGreaterThan(Number(firstDevPort));
      expect(Number(secondPtyPort)).not.toBe(Number(firstPtyPort));
    } finally {
      writeFileSync(join(root, 'release'), 'release');
      const result = await firstDone;
      expect(result.code, firstStderr || firstStdout).toBe(0);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('falls back to the same home cache when XDG_RUNTIME_DIR is unset', () => {
    expect(lockRootAssignment).toBeTruthy();
    expect(displayLockAssignment).toBeTruthy();
    expect(portLockAssignment).toBeTruthy();

    const root = mkdtempSync(join(tmpdir(), 'verify-tauri-lock-fallback-'));
    const tmpA = join(root, 'private-a');
    const tmpB = join(root, 'private-b');
    const home = join(root, 'home');
    mkdirSync(tmpA);
    mkdirSync(tmpB);
    mkdirSync(home);

    const script = [
      'set -euo pipefail',
      'TMPDIR="$TMP_A"',
      lockRootAssignment!,
      displayLockAssignment!,
      portLockAssignment!,
      'PORT_LOCK_A="$PORT_LOCK_DIR"',
      'DISPLAY_LOCK_A="$DISPLAY_LOCK_DIR"',
      'TMPDIR="$TMP_B"',
      lockRootAssignment!,
      displayLockAssignment!,
      portLockAssignment!,
      '[ "$PORT_LOCK_A" = "$PORT_LOCK_DIR" ]',
      '[ "$DISPLAY_LOCK_A" = "$DISPLAY_LOCK_DIR" ]',
      'printf "%s\\n%s\\n" "$PORT_LOCK_DIR" "$DISPLAY_LOCK_DIR"',
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], {
      env: {
        ...hermeticSpawnEnv(),
        TMP_A: tmpA,
        TMP_B: tmpB,
        XDG_RUNTIME_DIR: '',
        HOME: home,
        VERIFY_TAURI_PORT_LOCK_DIR: '',
        VERIFY_TAURI_DISPLAY_LOCK_DIR: '',
      },
      encoding: 'utf8',
    });

    try {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim().split('\n')).toEqual([
        join(home, '.cache', 'papercusp-tauri-verifier', 'port-locks'),
        join(home, '.cache', 'papercusp-tauri-verifier', 'display-locks'),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
