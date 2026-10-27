import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const script = process.env.DEPENDENCY_GENERATION_SCRIPT
  ?? resolve(__dirname, '../../bin/release/dependency-generation.sh');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture(run: (env: NodeJS.ProcessEnv, root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'immutable-clone-admission-'));
  roots.push(root);
  const source = join(root, 'generation/tree/node_modules');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'value'), 'immutable\n');
  chmodSync(join(source, 'value'), 0o444);
  writeFileSync(join(root, 'generation/.tree-bytes'), 'node_modules\t5000\n');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  // Model a CoW-capable filesystem on portable test filesystems. Ordinary
  // copying still uses the real copier/lock; a strict clone makes independent
  // inodes. The production command must explicitly forbid a full-copy fallback.
  writeFileSync(join(bin, 'cp'), [
    '#!/usr/bin/env bash',
    'if [ "$1" = -a ] && [ "$2" = --reflink=always ]; then',
    '  printf "clone\\n" >> "$CLONE_CALLS"',
    '  [ "$CLONE_SUPPORTED" = 1 ] || exit 1',
    '  shift 2',
    '  exec /bin/cp -a "$@"',
    'fi',
    'exec /bin/cp "$@"',
  ].join('\n') + '\n', { mode: 0o755 });
  const lock = join(root, 'copy.lock');
  const holder = spawn('bash', ['-c', 'exec 9>>"$1"; flock 9; echo locked; exec sleep 60', 'holder', lock],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise<void>(done => holder.once('exit', () => done()));
  try {
    await new Promise<void>((ready, reject) => {
      const timer = setTimeout(() => reject(new Error('copy lock holder did not become ready')), 10_000);
      holder.once('error', error => { clearTimeout(timer); reject(error); });
      holder.stdout.once('data', chunk => {
        clearTimeout(timer);
        String(chunk).includes('locked') ? ready() : reject(new Error('unexpected lock control output'));
      });
    });
    run({ ...process.env, SCRIPT: script, SOURCE: source,
      DEST: join(root, 'out/node_modules'), PATH: bin + ':' + process.env.PATH,
      CLONE_SUPPORTED: '1', CLONE_CALLS: join(root, 'clone.calls'),
      DEPENDENCY_GENERATION_ALLOW_HARDLINK: '0', DEPENDENCY_GENERATION_FORCE_COPY: '1',
      DEPENDENCY_GENERATION_COPY_LOCK_FILE: lock,
      DEPENDENCY_GENERATION_COPY_LOCK_TIMEOUT_SEC: '1', DEPENDENCY_GENERATION_COPY_LOCK_MAX_SEC: '1',
      DEPENDENCY_GENERATION_HEADROOM_AVAIL_BYTES: '10000',
      DEPENDENCY_GENERATION_HEADROOM_TOTAL_BYTES: '100000',
      DEPENDENCY_GENERATION_HEADROOM_RESERVE_PCT: '2',
      DEPENDENCY_GENERATION_HEADROOM_MARGIN_BYTES: '1000',
      DEPENDENCY_GENERATION_RESERVE_FS_PATH: '', DEPENDENCY_GENERATION_HEADROOM_SAME_FS: '1',
    }, root);
  } finally {
    if (holder.pid && holder.exitCode === null && holder.signalCode === null)
      process.kill(-holder.pid, 'SIGKILL');
    await exited;
  }
}

function materialize(env: NodeJS.ProcessEnv) {
  mkdirSync(dirname(env.DEST!), { recursive: true });
  return spawnSync('bash', ['-c', 'set -euo pipefail; source "$SCRIPT"; dependency_generation_materialize_tree "$SOURCE" "$DEST"'],
    { env, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
}

it('materializes an independent immutable clone while a peer holds physical copy capacity', async () => {
  await fixture((env, root) => {
    const result = materialize(env);
    expect(result.status, result.stderr).toBe(0);
    const copied = join(env.DEST!, 'value'), original = join(env.SOURCE!, 'value');
    expect(readFileSync(join(root, 'clone.calls'), 'utf8')).toBe('clone\n');
    expect(statSync(copied).ino).not.toBe(statSync(original).ino);
    chmodSync(copied, 0o644);
    writeFileSync(copied, 'private mutation\n');
    expect(readFileSync(original, 'utf8')).toBe('immutable\n');
  });
}, 30_000);

it('keeps ordinary copy admission when strict immutable cloning is unsupported', async () => {
  await fixture((env, root) => {
    const result = materialize({ ...env, CLONE_SUPPORTED: '0' });
    expect(result.status, result.stderr).toBe(76);
    expect(result.stderr).toContain('DEPENDENCY_GENERATION_LOCK_TIMEOUT');
    expect(existsSync(env.DEST!)).toBe(false);
    expect(readFileSync(join(root, 'clone.calls'), 'utf8')).toBe('clone\n');
  });
}, 30_000);

it('preserves headroom refusal before cloning even when physical copy capacity is busy', async () => {
  await fixture((env, root) => {
    const result = materialize({ ...env, DEPENDENCY_GENERATION_HEADROOM_AVAIL_BYTES: '7999' });
    expect(result.status, result.stderr).toBe(77);
    expect(result.stderr).toContain('DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT');
    expect(existsSync(env.DEST!)).toBe(false);
    expect(existsSync(join(root, 'clone.calls'))).toBe(false);
  });
}, 30_000);
