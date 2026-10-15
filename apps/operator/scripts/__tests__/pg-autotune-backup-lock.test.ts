import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../..');
const AUTOTUNE = join(ROOT, 'scripts/pg-autotune.ts');

describe('pg-autotune host-backup exclusion', () => {
  it('refuses --apply before touching PostgreSQL while the host dump owns its lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-pg-autotune-lock-'));
    const bin = join(dir, 'bin');
    const lock = join(dir, 'db-backup.lock');
    const innerRan = join(dir, 'inner-apply-ran');
    mkdirSync(bin);
    // If the guard ever acquires the lock, the re-exec it spawns is `npx tsx …`.
    // This stub stands in for that child, so a bypassed guard can never run a
    // real PostgreSQL apply from a unit test, and it fails with a distinct
    // status (97) instead of the real script's no-op `exit 0`.
    const fakeNpx = join(bin, 'npx');
    writeFileSync(fakeNpx, '#!/usr/bin/env bash\nprintf ran >"$AUTOTUNE_INNER_RAN"\nexit 97\n');
    chmodSync(fakeNpx, 0o755);
    // The holder keeps the lock until `finally` kills its process group. A
    // fixed short hold (it was `sleep 3`) expired before the guarded re-exec
    // reached `flock -n` under gate load, so the guard acquired the lock and
    // the inner apply ran (WI-10005450, CI run 20605217: status 0, 11.9s).
    const holder = spawn('flock', ['-o', '-x', lock, 'sleep', '300'], {
      stdio: 'ignore',
      detached: true,
    });
    try {
      let held = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (existsSync(lock) && spawnSync('flock', ['-n', lock, 'true']).status === 1) {
          held = true;
          break;
        }
        await delay(20);
      }
      expect(held).toBe(true);

      const result = spawnSync(process.execPath, ['--import', 'tsx', AUTOTUNE, '--apply'], {
        cwd: ROOT,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          PC_BACKUP_LOCK: lock,
          AUTOTUNE_INNER_RAN: innerRan,
          PAPERCUSP_PG_AUTOTUNE_BACKUP_LOCK_HELD: '',
        },
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(existsSync(innerRan), 'the guard acquired the held lock and ran the apply child').toBe(false);
      expect(result.status).toBe(75);
      expect(result.stderr).toContain('PostgreSQL apply deferred: host backup holds');
      expect(result.stdout).not.toContain('writing /etc/postgresql');
    } finally {
      try {
        if (holder.pid) process.kill(-holder.pid, 'SIGKILL');
      } catch {
        // already exited
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 45_000);

  it('holds the producer lock for the entire apply child', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-pg-autotune-hold-'));
    const bin = join(dir, 'bin');
    const lock = join(dir, 'db-backup.lock');
    const entered = join(dir, 'apply-entered');
    const release = join(dir, 'release-apply');
    mkdirSync(bin);
    const fakeNpx = join(bin, 'npx');
    writeFileSync(
      fakeNpx,
      '#!/usr/bin/env bash\nprintf ready >"$AUTOTUNE_ENTERED"\nwhile [[ ! -e "$AUTOTUNE_RELEASE" ]]; do sleep 0.01; done\n',
    );
    chmodSync(fakeNpx, 0o755);
    const apply = spawn(process.execPath, ['--import', 'tsx', AUTOTUNE, '--apply'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        PC_BACKUP_LOCK: lock,
        AUTOTUNE_ENTERED: entered,
        AUTOTUNE_RELEASE: release,
        PAPERCUSP_PG_AUTOTUNE_BACKUP_LOCK_HELD: '',
      },
      stdio: 'ignore',
      detached: true,
    });
    const closed = new Promise<number | null>((resolveExit) => apply.on('close', resolveExit));
    let childClosed = false;
    void closed.then(() => {
      childClosed = true;
    });
    try {
      // Wait on an OBSERVED signal — the apply child reaching the fake npx — not a
      // fixed wall-clock window. The old 100×20ms (2s) window expired before
      // `node --import tsx` + the flock re-exec reached npx under gate load, so
      // `held` stayed false without the lock ever being checked (WI-10008220:
      // gate red at 33144c00 after exactly 2048ms). The deadline only bounds a
      // child that never starts; it stays well inside the test timeout.
      const deadline = Date.now() + 25_000;
      while (!existsSync(entered) && !childClosed && Date.now() < deadline) {
        await delay(20);
      }
      expect(existsSync(entered), 'the apply child never reached the guarded npx re-exec').toBe(true);
      // Keep the child alive until this assertion has observed the producer lock.
      expect(spawnSync('flock', ['-n', lock, 'true']).status, 'producer lock not held while the apply child runs').toBe(1);
      writeFileSync(release, 'continue');
      const exited = await closed;
      expect(exited).toBe(0);
      expect(spawnSync('flock', ['-n', lock, 'true']).status).toBe(0);
    } finally {
      if (apply.exitCode === null && apply.pid) {
        try {
          process.kill(-apply.pid, 'SIGKILL');
        } catch {
          // already exited
        }
        await closed;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 45_000);
});
