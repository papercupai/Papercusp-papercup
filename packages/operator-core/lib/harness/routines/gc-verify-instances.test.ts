/**
 * gc-verify-instances — the REFUSAL conditions are the point of these tests.
 *
 * This sweep kills processes and deletes directories, unattended, on a timer, on a box
 * that also runs the owner's real desktop and a live agent fleet. The 2026-07-27
 * near-miss (su-709bb0d6: `pkill -f "papercusp-desktop" --older-than 0`, which means
 * "older than 0 seconds" = every match, including the owner's desktop) is the failure
 * this file exists to make impossible to reintroduce silently.
 *
 * Everything runs against a real temp dir with an injected clock and an injected
 * teardown, so no test ever execs a stop.sh or touches a real display.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { utimesSync, existsSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { createRetentionPin } from '../../storage/retention-pins';
import {
  defaultVerifyScanRoots,
  gcVerifyInstances as collectVerifyInstances,
  parseStopScriptDisplay,
  PROTECTED_DISPLAYS,
  runMarkerIsLive,
  runMarkerTaskId,
  VERIFY_TERMINAL_TASK_GRACE_MS,
  VERIFY_INSTANCE_TTL_HOURS_DEFAULT,
} from './gc-verify-instances';

// Every process census is injected here; tests never inspect or signal peers.
const emptyHolders = async () => ({ complete: true, byPath: new Map<string, string[]>() });
const gcVerifyInstances = (opts: Parameters<typeof collectVerifyInstances>[0] = {}) =>
  collectVerifyInstances({ scanHolders: emptyHolders, retentionDir: join(root, 'retention'), ...opts });

let root: string;
const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000);

/** Build a work dir that looks like a real one, aged to `ageHours`. */
async function makeInstance(
  name: string,
  opts: { ageHours: number; display?: string | null; bytes?: number; withStop?: boolean },
): Promise<string> {
  const dir = join(root, `verify-tauri-headless.${name}`);
  await mkdir(dir, { recursive: true });
  if (opts.withStop !== false) {
    const display = opts.display === undefined ? ':144' : opts.display;
    if (display === null) await writeFile(join(dir, 'stop.sh'), '#!/usr/bin/env bash\necho "stopped"\n');
    else writeNativeScripts(dir, display.slice(1));
  }
  if (opts.bytes) await writeFile(join(dir, 'spa'), 'x'.repeat(opts.bytes));
  const t = hoursAgo(opts.ageHours);
  utimesSync(dir, t, t);
  return dir;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gc-verify-test-'));
  vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(root, 'locks'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

/** Run only the real script emitters, never the verifier or generated teardown. */
async function makeNativeInstance(display = '144', ageHours = 200, targets: Record<string, string> = {}): Promise<string> {
  const dir = join(root, 'verify-tauri-headless.native');
  await mkdir(dir);
  writeNativeScripts(dir, display, targets);
  utimesSync(dir, hoursAgo(ageHours), hoursAgo(ageHours));
  return dir;
}

function writeNativeScripts(dir: string, display: string, targets: Record<string, string> = {}): void {
  const source = readFileSync(resolve(__dirname, '../../../../../scripts/verify-tauri-headless.sh'), 'utf8');
  const start = source.indexOf('write_xvfb_stop_script() {');
  const end = source.indexOf('\n# ── EI-11559:', source.indexOf('write_stop_script() {', start));
  const reaperStart = source.indexOf('frozen_source_path_is_inside() {');
  const reaperEnd = source.indexOf('\nwrite_frozen_source_reaper_script || {', reaperStart);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  execFileSync('bash', ['-c', `${source.slice(reaperStart, reaperEnd)}\n${source.slice(start, end)}\nwrite_frozen_source_reaper_script\nwrite_stop_script`], {
    env: {
      ...process.env,
      WORK: dir,
      DISPLAY_NUM: display,
      DEV_PORT: '33144',
      TAURI_LAUNCH_PROVENANCE: 'agent:gc-test:run:123-456',
      TAURI_PID: '',
      OPENBOX_PID: '',
      ISOLATED_PG_PID: '',
      ...targets,
    },
  });
}

describe('gc-verify-instances — native producer protocol', () => {
  async function makeLegacyInstance(display = '144'): Promise<string> {
    const dir = await makeNativeInstance(display);
    await rm(join(dir, 'frozen-source-reaper.sh'));
    await writeFile(join(dir, 'stop.sh'), `#!/usr/bin/env bash
kill -TERM -- -12345 2>/dev/null
grep -qxF "PAPERCUSP_TAURI_LAUNCH_PROVENANCE=agent:gc-test:run:123-456" <<<"$_env_p" || continue
"${dir}/stop-xvfb.sh" || true
echo "stopped (display :${display}, port 33144)"
`);
    utimesSync(dir, hoursAgo(200), hoursAgo(200));
    return dir;
  }

  describe.each([false, true])('retention protection (dryRun=%s)', (dryRun) => {
    it.each(['native', 'legacy', 'source'])('preserves a pinned %s directory before teardown or census', async (kind) => {
      const dir = kind === 'legacy' ? await makeLegacyInstance() : kind === 'native' ? await makeNativeInstance() :
        await makeInstance('source', { ageHours: 200, withStop: false });
      createRetentionPin({ path: dir, owner: 'test-owner', reason: 'retained verifier evidence',
        expiresAt: new Date(NOW + 3_600_000).toISOString() }, { dir: join(root, 'retention'), nowMs: NOW });
      const stop = vi.fn(async () => {});
      const scan = vi.fn(emptyHolders);
      const result = await gcVerifyInstances({ roots: [root], now: NOW, dryRun, runStopScript: stop, scanHolders: scan });
      expect(result.reaped).toBe(0);
      expect(result.bytesFreed).toBe(0);
      expect(result.instances[0].skipped).toMatch(/live retention pin/);
      expect(stop).not.toHaveBeenCalled();
      expect(scan).not.toHaveBeenCalled();
      expect(existsSync(dir)).toBe(true);
    });
  });

  it('protects a pinned descendant of the separate snapshot removed by generated stop.sh', async () => {
    const snapshot = join(root, 'snapshot');
    await mkdir(snapshot);
    const evidence = join(snapshot, 'evidence.json');
    await writeFile(evidence, 'retained');
    const dir = await makeNativeInstance('144', 200, { OPERATOR_SOURCE_WORK: snapshot });
    createRetentionPin({ path: evidence, owner: 'test-owner', reason: 'retained source evidence',
      expiresAt: new Date(NOW + 3_600_000).toISOString() }, { dir: join(root, 'retention'), nowMs: NOW });
    const stop = vi.fn(async () => { await rm(snapshot, { recursive: true }); });
    const result = await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: stop });
    expect(result.reaped).toBe(0);
    expect(result.instances[0].skipped).toMatch(/live retention pin/);
    expect(stop).not.toHaveBeenCalled();
    expect(existsSync(dir)).toBe(true);
    expect(readFileSync(evidence, 'utf8')).toBe('retained');
  });

  it('preserves candidates when the retention store is malformed', async () => {
    const dir = await makeNativeInstance();
    await mkdir(join(root, 'retention'));
    await writeFile(join(root, 'retention', 'lease-broken.tsv'), 'broken');
    const stop = vi.fn(async () => {});
    const result = await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: stop });
    expect(result.reaped).toBe(0);
    expect(result.instances[0].skipped).toMatch(/retention pins unreadable/);
    expect(stop).not.toHaveBeenCalled();
    expect(existsSync(dir)).toBe(true);
  });

  it('does not let an expired pin prevent safe collection', async () => {
    const dir = await makeNativeInstance();
    createRetentionPin({ path: dir, owner: 'test-owner', reason: 'expired evidence',
      expiresAt: new Date(NOW - 1).toISOString() }, { dir: join(root, 'retention'), nowMs: NOW - 1000 });
    const result = await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: async () => {} });
    expect(result.reaped).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  it('preserves a source snapshot when its streaming size census exhausts the entry budget', async () => {
    const dir = await makeInstance('large', { ageHours: 200, withStop: false, bytes: 20 });
    await writeFile(join(dir, 'more'), 'more');
    utimesSync(dir, hoursAgo(200), hoursAgo(200));
    const scan = vi.fn(emptyHolders);
    const result = await gcVerifyInstances({ roots: [root], now: NOW, maxCensusEntries: 2, scanHolders: scan });
    expect(result.reaped).toBe(0);
    expect(result.bytesFreed).toBe(0);
    expect(result.instances[0].skipped).toMatch(/census budget exhausted/);
    expect(scan).not.toHaveBeenCalled();
    expect(existsSync(dir)).toBe(true);
  });

  it('preserves a source snapshot if the time budget expires during its holder scan', async () => {
    const dir = await makeInstance('deadline', { ageHours: 200, withStop: false, bytes: 20 });
    let wallNow = 100;
    const scan = vi.fn(async () => { wallNow = 201; return emptyHolders(); });
    const result = await gcVerifyInstances({ roots: [root], now: NOW, clock: () => wallNow, budgetMs: 100, scanHolders: scan });
    expect(result.reaped).toBe(0);
    expect(result.bytesFreed).toBe(0);
    expect(result.instances[0].skipped).toMatch(/census budget exhausted/);
    expect(scan).toHaveBeenCalledOnce();
    expect(existsSync(dir)).toBe(true);
  });

  it.each([false, true])('collects only quiescent validated legacy metadata without executing old signals (dryRun=%s)', async (dryRun) => {
    const dir = await makeLegacyInstance();
    const stop = vi.fn(async () => {});
    const scan = vi.fn(emptyHolders);
    const result = await gcVerifyInstances({ roots: [root], now: NOW, dryRun, runStopScript: stop, scanHolders: scan });
    expect(result.reaped).toBe(1);
    expect(result.instances[0]).toMatchObject({ dir, display: ':144', cleanup: 'quiescent-legacy' });
    expect(stop).not.toHaveBeenCalled();
    expect(scan).toHaveBeenCalledWith([dir], {
      isolate: true, includeProcessLinks: true, includeMappedFiles: true,
      environmentByPath: { [dir]: 'PAPERCUSP_TAURI_LAUNCH_PROVENANCE=agent:gc-test:run:123-456' },
    });
    expect(existsSync(dir)).toBe(dryRun);
  });

  it.each(['holder', 'partial', 'error', 'changed', 'live-marker', 'helper-symlink'])('preserves legacy WORK when %s evidence prevents quiescence', async (variant) => {
    const dir = await makeLegacyInstance();
    const scan = vi.fn(async () => {
      if (variant === 'error') throw new Error('census unavailable');
      if (variant === 'changed') await writeFile(join(dir, 'stop.sh'), '# replaced');
      if (variant === 'live-marker') await writeFile(join(dir, '.papercusp-run'), `pid=${process.pid}\n`);
      return { complete: variant !== 'partial', byPath: new Map(variant === 'holder' ? [[dir, ['999']]] : []) };
    });
    if (variant === 'helper-symlink') {
      const path = join(dir, 'stop-xvfb.sh');
      await writeFile(join(root, 'foreign.sh'), readFileSync(path));
      await rm(path);
      symlinkSync(join(root, 'foreign.sh'), path);
      utimesSync(dir, hoursAgo(200), hoursAgo(200));
    }
    const stop = vi.fn(async () => {});
    const result = await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: stop, scanHolders: scan });
    expect(result.reaped).toBe(0);
    expect(stop).not.toHaveBeenCalled();
    expect(existsSync(dir)).toBe(true);
  });

  it('preserves a legacy protected display before consulting quiescence', async () => {
    const dir = await makeLegacyInstance('01');
    const scan = vi.fn(emptyHolders);
    const result = await gcVerifyInstances({ roots: [root], now: NOW, scanHolders: scan });
    expect(result.instances[0].skipped).toMatch(/protected display :1/);
    expect(scan).not.toHaveBeenCalled();
    expect(existsSync(dir)).toBe(true);
  });

  it.each(['holder', 'partial'])('preserves an orphan source snapshot on %s evidence after its marker exits', async (variant) => {
    const dir = await makeInstance('source-snapshot', { ageHours: 200, withStop: false });
    const result = await gcVerifyInstances({ roots: [root], now: NOW,
      scanHolders: async () => ({ complete: variant !== 'partial', byPath: new Map(variant === 'holder' ? [[dir, ['999']]] : []) }),
    });
    expect(result.reaped).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it('reaps an abandoned directory using the current generated helper-based stop script', async () => {
    const dir = await makeNativeInstance();
    const stop = vi.fn(async (_path: string) => {});
    const result = await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: stop });
    expect(result.instances[0]).toMatchObject({ dir, display: ':144' });
    expect(result.reaped).toBe(1);
    expect(stop).toHaveBeenCalledWith(join(dir, 'stop.sh'));
    expect(existsSync(dir)).toBe(false);
  });

  it.each([...PROTECTED_DISPLAYS])('refuses the native helper for protected display %s', async (display) => {
    const dir = await makeNativeInstance(display.slice(1));
    const stop = vi.fn(async () => {});
    const result = await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: stop });
    expect(result.instances[0].skipped).toMatch(/protected display/);
    expect(result.reaped).toBe(0);
    expect(stop).not.toHaveBeenCalled();
    expect(existsSync(dir)).toBe(true);
  });

  it.each(['missing', 'symlink', 'wrong-display', 'wrong-provenance', 'unguarded', 'foreign-helper', 'footer-only',
    'missing-reaper', 'symlink-reaper', 'unguarded-reaper', 'foreign-reaper'])
    ('refuses a native stop script with %s helper evidence', async (variant) => {
      const dir = await makeNativeInstance();
      const path = join(dir, 'stop-xvfb.sh');
      const helper = readFileSync(path, 'utf8');
      const stopPath = join(dir, 'stop.sh');
      if (variant === 'missing' || variant === 'symlink') {
        await rm(path);
        if (variant === 'symlink') {
          await writeFile(join(root, 'foreign-helper.sh'), helper);
          symlinkSync(join(root, 'foreign-helper.sh'), path);
        }
      } else if (variant === 'wrong-display') {
        await writeFile(path, helper.replace('EXPECTED_DISPLAY=:144', 'EXPECTED_DISPLAY=:1'));
      } else if (variant === 'wrong-provenance') {
        await writeFile(path, helper.replace('agent:gc-test:run:123-456', 'agent:another-run'));
      } else if (variant === 'unguarded') {
        await writeFile(path, helper.replace('PAPERCUSP_VERIFY_XVFB_DISPLAY=$EXPECTED_DISPLAY', 'IGNORED=$EXPECTED_DISPLAY'));
      } else if (variant === 'foreign-helper') {
        await writeFile(stopPath, readFileSync(stopPath, 'utf8').replace(`${dir}/stop-xvfb.sh`, `${root}/stop-xvfb.sh`));
      } else if (variant.endsWith('-reaper')) {
        const reaperPath = join(dir, 'frozen-source-reaper.sh');
        const reaper = readFileSync(reaperPath, 'utf8');
        if (variant === 'missing-reaper' || variant === 'symlink-reaper') {
          await rm(reaperPath);
          if (variant === 'symlink-reaper') {
            await writeFile(join(root, 'foreign-reaper.sh'), reaper);
            symlinkSync(join(root, 'foreign-reaper.sh'), reaperPath);
          }
        } else if (variant === 'unguarded-reaper') {
          await writeFile(reaperPath, reaper.replaceAll('PAPERCUSP_TAURI_LAUNCH_PROVENANCE=$provenance', 'IGNORED=$provenance'));
        } else {
          await writeFile(stopPath, readFileSync(stopPath, 'utf8').replace(`source "${reaperPath}"`, `source "${root}/foreign-reaper.sh"`));
        }
      } else {
        await writeFile(stopPath, '#!/usr/bin/env bash\necho "stopped (display :144, port 33144)"\n');
      }
      utimesSync(dir, hoursAgo(200), hoursAgo(200));
      const stop = vi.fn(async () => {});
      const result = await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: stop });
      expect(result.reaped).toBe(0);
      expect(stop).not.toHaveBeenCalled();
      expect(existsSync(dir)).toBe(true);
    });

  it('retains a young native run and honors dry-run without executing teardown', async () => {
    const dir = await makeNativeInstance('144', 1);
    const stop = vi.fn(async () => {});
    expect((await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: stop })).reaped).toBe(0);
    utimesSync(dir, hoursAgo(200), hoursAgo(200));
    const result = await gcVerifyInstances({ roots: [root], now: NOW, dryRun: true, runStopScript: stop });
    expect(result.reaped).toBe(1);
    expect(stop).not.toHaveBeenCalled();
    expect(existsSync(dir)).toBe(true);
  });

  it.each(['TAURI_PID', 'OPENBOX_PID', 'ISOLATED_PG_PID'])
    ('refuses unverified saved %s signals even when the Xvfb helper has valid provenance', async (target) => {
      const dir = await makeNativeInstance('144', 200, { [target]: String(process.pid) });
      // Model the pre-identity native emitter. Current emitters delegate these
      // hints to a nonce/start-time checked helper rather than signalling them.
      const path = join(dir, 'stop.sh');
      await writeFile(path, `${readFileSync(path, 'utf8')}\nkill -9 ${process.pid} 2>/dev/null\n`);
      utimesSync(dir, hoursAgo(200), hoursAgo(200));
      const stop = vi.fn(async () => {});
      const result = await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: stop });
      expect(result.reaped).toBe(0);
      expect(stop).not.toHaveBeenCalled();
      expect(existsSync(dir)).toBe(true);
    });
});

describe('parseStopScriptDisplay', () => {
  it('reads the display out of a real generated stop.sh line', () => {
    expect(parseStopScriptDisplay('pkill -9 -f "Xvfb :144 " 2>/dev/null')).toBe(':144');
  });
  it('returns null when no display is present', () => {
    expect(parseStopScriptDisplay('echo nothing here')).toBeNull();
  });
});

describe('gc-verify-instances — refusals (the safety surface)', () => {
  it.each([false, true])('refuses pre-helper pattern scripts without signalling or deleting (dryRun=%s)', async (dryRun) => {
    for (const display of [':144', ':0', ':01']) {
      const dir = await makeInstance(`pre-helper${display.slice(1)}`, { ageHours: 500 });
      await writeFile(join(dir, 'stop.sh'), `#!/usr/bin/env bash\nkill -9 123 2>/dev/null\npkill -9 -f "Xvfb ${display} " 2>/dev/null\n`);
      utimesSync(dir, hoursAgo(500), hoursAgo(500));
      const stop = vi.fn(async () => {});
      const scan = vi.fn(emptyHolders);
      const result = await gcVerifyInstances({ roots: [root], now: NOW, dryRun, runStopScript: stop, scanHolders: scan });
      expect(result.reaped).toBe(0);
      expect(stop).not.toHaveBeenCalled();
      expect(scan).not.toHaveBeenCalled();
      expect(existsSync(dir)).toBe(true);
    }
  });

  it('REFUSES to touch the owner\'s real desktop display', async () => {
    // The load-bearing guard. A stop.sh targeting :0 would log the owner out.
    for (const display of PROTECTED_DISPLAYS) {
      const dir = await makeInstance(`prot${display.slice(1)}`, { ageHours: 500, display });
      const stop = vi.fn(async () => {});
      const res = await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: stop });
      expect(stop, `${display} must never be torn down`).not.toHaveBeenCalled();
      expect(res.reaped).toBe(0);
      expect(res.skipped).toBe(1);
      expect(res.instances[0].skipped).toMatch(/protected display/);
      expect(existsSync(dir)).toBe(true);
      await import('node:fs/promises').then((m) => m.rm(dir, { recursive: true, force: true }));
    }
  });

  it('REFUSES a stop.sh it cannot parse a display out of', async () => {
    const dir = await makeInstance('opaque', { ageHours: 500, display: null });
    const stop = vi.fn(async () => {});
    const res = await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: stop });
    expect(stop).not.toHaveBeenCalled();
    expect(res.reaped).toBe(0);
    expect(res.instances[0].skipped).toMatch(/no display/);
    expect(existsSync(dir)).toBe(true);
  });

  it('REFUSES anything younger than the TTL — a live run is never reaped', async () => {
    const dir = await makeInstance('fresh', { ageHours: 1 });
    const stop = vi.fn(async () => {});
    const res = await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: stop });
    expect(stop).not.toHaveBeenCalled();
    expect(res.reaped).toBe(0);
    expect(res.instances[0].skipped).toMatch(/younger than ttl/);
    expect(existsSync(dir)).toBe(true);
  });

  it('treats the TTL boundary as exclusive — exactly-TTL is still protected', async () => {
    await makeInstance('edge', { ageHours: VERIFY_INSTANCE_TTL_HOURS_DEFAULT - 0.01 });
    const res = await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: async () => {} });
    expect(res.reaped).toBe(0);
  });

  it('ignores directories that are not verify work dirs', async () => {
    await mkdir(join(root, 'something-else'), { recursive: true });
    await mkdir(join(root, 'verify-tauri-headlessNOTADOT'), { recursive: true });
    const res = await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: async () => {} });
    expect(res.scanned).toBe(0);
    expect(res.reaped).toBe(0);
    expect(existsSync(join(root, 'something-else'))).toBe(true);
  });
});

describe('gc-verify-instances — reaping', () => {
  it('reclaims a deadline-killed managed task after its ledger closes and the grace passes', async () => {
    const dir = await makeInstance('deadline', { ageHours: 1, bytes: 1000 });
    await writeFile(join(dir, '.papercusp-run'), 'pid=999999999\ntask_id=0muiljsj1vqd0otcqcr\n');
    utimesSync(dir, hoursAgo(1), hoursAgo(1));
    const stop = vi.fn(async () => {});
    const terminal = vi.fn(async (taskId: string) => taskId === '0muiljsj1vqd0otcqcr');
    const result = await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: stop, isTaskTerminal: terminal });
    expect(terminal).toHaveBeenCalledWith('0muiljsj1vqd0otcqcr');
    expect(stop).toHaveBeenCalledOnce();
    expect(result.reaped).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  it('keeps young managed scratch while the task is live, unknown, or inside teardown grace', async () => {
    const dir = await makeInstance('live-task', { ageHours: 1 });
    await writeFile(join(dir, '.papercusp-run'), 'pid=999999999\ntask_id=abcd1234\n');
    utimesSync(dir, hoursAgo(1), hoursAgo(1));
    const stop = vi.fn(async () => {});
    const live = await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: stop, isTaskTerminal: async () => false });
    const unknown = await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: stop, isTaskTerminal: async () => { throw new Error('ledger unavailable'); } });
    const grace = await gcVerifyInstances({ roots: [root], now: NOW - 3_600_000 + VERIFY_TERMINAL_TASK_GRACE_MS - 1, runStopScript: stop, isTaskTerminal: async () => true });
    expect([live.reaped, unknown.reaped, grace.reaped]).toEqual([0, 0, 0]);
    expect(stop).not.toHaveBeenCalled();
    expect(existsSync(dir)).toBe(true);
    expect(await runMarkerTaskId(dir)).toBe('abcd1234');
  });

  it('keeps a young tree when its marker owner is alive even if the ledger says terminal', async () => {
    const dir = await makeInstance('owner-alive', { ageHours: 1 });
    await writeFile(join(dir, '.papercusp-run'), `pid=${process.pid}\nstart_ticks=${ownStartTicks()}\ntask_id=abcd1234\n`);
    utimesSync(dir, hoursAgo(1), hoursAgo(1));
    const terminal = vi.fn(async () => true);
    const result = await gcVerifyInstances({ roots: [root], now: NOW, isTaskTerminal: terminal });
    expect(result.reaped).toBe(0);
    expect(terminal).not.toHaveBeenCalled();
    expect(existsSync(dir)).toBe(true);
  });

  it('runs the dir\'s OWN stop.sh and then removes it', async () => {
    const dir = await makeInstance('stale', { ageHours: 200, bytes: 1000 });
    const stop = vi.fn(async () => {});
    const res = await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: stop });
    // Reuse-first: teardown is delegated to the script that already encodes
    // EI-11559 / EI-18745117818375852 / EI-18816386093046558.
    expect(stop).toHaveBeenCalledTimes(1);
    // `vi.fn(async () => {})` infers a ZERO-arg signature, so mock.calls is typed `[][]`
    // and indexing [0][0] is a tuple-out-of-range type error even though the call is made
    // WITH an argument at runtime. Read the recorded arg through the actual call tuple.
    expect((stop.mock.calls[0] as unknown as [string] | undefined)?.[0]).toBe(join(dir, 'stop.sh'));
    expect(res.reaped).toBe(1);
    expect(res.bytesFreed).toBeGreaterThanOrEqual(1000);
    expect(existsSync(dir)).toBe(false);
  });

  it('removes a partially-created dir that has no stop.sh at all', async () => {
    const dir = await makeInstance('nostop', { ageHours: 200, withStop: false, bytes: 10 });
    const stop = vi.fn(async () => {});
    const res = await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: stop });
    expect(stop).not.toHaveBeenCalled(); // nothing to tear down
    expect(res.reaped).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  it.each(['unverified process survivor', 'teardown timeout', 'kill: no such process'])
    ('preserves the directory and its teardown evidence after %s', async (failure) => {
    const dir = await makeNativeInstance();
    await writeFile(join(dir, 'survivor-evidence.log'), failure);
    utimesSync(dir, hoursAgo(200), hoursAgo(200));
    const stop = vi.fn(async () => {
      throw new Error(failure);
    });
    const res = await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: stop });
    expect(stop).toHaveBeenCalledWith(join(dir, 'stop.sh'));
    expect(res.reaped).toBe(0);
    expect(res.bytesFreed).toBe(0);
    expect(res.instances[0]).toMatchObject({ dir, display: ':144', skipped: 'teardown failed — preserving directory' });
    expect(readFileSync(join(dir, 'survivor-evidence.log'), 'utf8')).toBe(failure);
  });

  it('dryRun names what it WOULD reap and deletes nothing', async () => {
    // A bare count hides destruction — the run must be auditable by name.
    const dir = await makeInstance('dry', { ageHours: 200, bytes: 500 });
    const stop = vi.fn(async () => {});
    const res = await gcVerifyInstances({ roots: [root], now: NOW, dryRun: true, runStopScript: stop });
    expect(stop).not.toHaveBeenCalled();
    expect(res.reaped).toBe(1);
    expect(res.dryRun).toBe(true);
    expect(res.bytesFreed).toBeGreaterThanOrEqual(500);
    expect(res.instances[0].dir).toBe(dir);
    expect(existsSync(dir)).toBe(true);
  });

  it('caps a run and takes the OLDEST first, so a capped sweep still makes progress', async () => {
    await makeInstance('young-stale', { ageHours: 100 });
    await makeInstance('ancient', { ageHours: 900 });
    await makeInstance('middle', { ageHours: 400 });
    const res = await gcVerifyInstances({
      roots: [root],
      now: NOW,
      maxPerRun: 1,
      runStopScript: async () => {},
    });
    expect(res.reaped).toBe(1);
    expect(res.instances.find((i) => !i.skipped)?.dir).toMatch(/ancient/);
    expect(existsSync(join(root, 'verify-tauri-headless.ancient'))).toBe(false);
    expect(existsSync(join(root, 'verify-tauri-headless.middle'))).toBe(true);
  });

  it('is idempotent — a second pass over a swept tree finds nothing', async () => {
    await makeInstance('once', { ageHours: 200 });
    const opts = { roots: [root], now: NOW, runStopScript: async () => {} };
    expect((await gcVerifyInstances(opts)).reaped).toBe(1);
    expect((await gcVerifyInstances(opts)).reaped).toBe(0);
  });

  it('survives a missing tmp root rather than throwing into the routine tick', async () => {
    const res = await gcVerifyInstances({ roots: [join(root, 'nope')], now: NOW });
    expect(res.reaped).toBe(0);
    expect(res.scanned).toBe(0);
  });

  it('reaps a mixed tree correctly, protecting exactly the right dirs', async () => {
    await makeInstance('a-old', { ageHours: 300 });
    await makeInstance('b-fresh', { ageHours: 1 });
    await makeInstance('c-desktop', { ageHours: 300, display: ':0' });
    await makeInstance('d-old', { ageHours: 300 });
    const stop = vi.fn(async () => {});
    const res = await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: stop });
    expect(res.reaped).toBe(2);
    expect(res.skipped).toBe(2);
    expect(stop).toHaveBeenCalledTimes(2);
    const left = (await readdir(root)).filter((name) => name.startsWith('verify-tauri-headless.')).sort();
    expect(left).toEqual(['verify-tauri-headless.b-fresh', 'verify-tauri-headless.c-desktop']);
  });
});

/** This process's own start ticks: a marker built from them is provably LIVE. */
function ownStartTicks(): string {
  const raw = readFileSync('/proc/self/stat', 'utf8');
  return raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
}

/**
 * The verifier's cross-device operator source snapshot, as it sat on 2026-09-23:
 * `<checkout>/.papercusp/tmp/verify-tauri-headless.XXXX` with an `operator-source`
 * tree and a `.papercusp-run` marker, and NO stop.sh (that lives in the /tmp WORK dir).
 */
async function makeSourceSnapshot(
  parent: string,
  name: string,
  opts: { ageHours: number; marker?: string },
): Promise<string> {
  const dir = join(parent, `verify-tauri-headless.${name}`);
  await mkdir(join(dir, 'operator-source'), { recursive: true });
  await writeFile(join(dir, 'operator-source', 'bundle.mjs'), 'x'.repeat(64));
  if (opts.marker !== undefined) await writeFile(join(dir, '.papercusp-run'), opts.marker);
  const t = hoursAgo(opts.ageHours);
  utimesSync(dir, t, t);
  return dir;
}

describe('gc-verify-instances — the root SET (WI-10002867: 20GB leaked outside /tmp)', () => {
  it('discovers every checkout .papercusp/tmp and the base dirs, deduplicated by realpath', async () => {
    const base = join(root, 'base');
    const ws = join(root, 'ws');
    const hives = join(root, 'hives');
    await mkdir(base, { recursive: true });
    await mkdir(join(ws, 'papercusp', '.papercusp', 'tmp'), { recursive: true });
    await mkdir(join(ws, 'no-scratch'), { recursive: true }); // a checkout without .papercusp/tmp
    await mkdir(join(hives, 'sidestage', '.papercusp', 'tmp'), { recursive: true });
    // A workspace entry that is a symlink into the hives (sidestage's real shape).
    symlinkSync(join(hives, 'sidestage'), join(ws, 'sidestage'));

    const roots = await defaultVerifyScanRoots({
      baseDirs: [base, base, join(root, 'missing')],
      workspaceRoot: ws,
      hivesRoot: hives,
    });

    const real = (p: string) => realpathSync(p);
    expect(roots.sort()).toEqual(
      [real(base), real(join(ws, 'papercusp', '.papercusp', 'tmp')), real(join(hives, 'sidestage', '.papercusp', 'tmp'))].sort(),
    );
  });

  it('reaps an abandoned source snapshot in a checkout .papercusp/tmp that the /tmp-only sweep never saw', async () => {
    // The 2026-09-23 regression, end to end through the default root discovery.
    const ws = join(root, 'ws');
    const scratch = join(ws, 'papercusp', '.papercusp', 'tmp');
    await mkdir(scratch, { recursive: true });
    const leaked = await makeSourceSnapshot(scratch, 'F4FEWG', {
      ageHours: 360,
      marker: 'pid=2147483646\nstart_ticks=1\n', // a pid that cannot exist
    });
    const stop = vi.fn(async () => {});

    const roots = await defaultVerifyScanRoots({ baseDirs: [], workspaceRoot: ws, hivesRoot: join(root, 'no-hives') });
    const res = await gcVerifyInstances({ roots, now: NOW, runStopScript: stop });

    expect(res.roots).toEqual([realpathSync(scratch)]);
    expect(stop).not.toHaveBeenCalled(); // no stop.sh — nothing to tear down
    expect(res.reaped).toBe(1);
    expect(res.bytesFreed).toBeGreaterThanOrEqual(64);
    expect(existsSync(leaked)).toBe(false);
  });

  it('reaps an abandoned source snapshot in the verifier data-temp root (WI-6554700010019500)', async () => {
    // Copy-mode verifier snapshots use /mnt/data/tmp when the repository is on the root
    // filesystem. Keep that root in the default discovery set so SIGKILLed runs cannot
    // accumulate outside /tmp.
    const dataTemp = join(root, 'data-tmp');
    await mkdir(dataTemp, { recursive: true });
    const leaked = await makeSourceSnapshot(dataTemp, 'DATA123', {
      ageHours: 360,
      marker: 'pid=2147483646\nstart_ticks=1\n',
    });
    const stop = vi.fn(async () => {});

    const roots = await defaultVerifyScanRoots({
      baseDirs: [],
      dataTempDir: dataTemp,
      workspaceRoot: join(root, 'no-workspace'),
      hivesRoot: join(root, 'no-hives'),
    });
    const res = await gcVerifyInstances({ roots, now: NOW, runStopScript: stop });

    expect(res.roots).toEqual([realpathSync(dataTemp)]);
    expect(stop).not.toHaveBeenCalled();
    expect(res.reaped).toBe(1);
    expect(existsSync(leaked)).toBe(false);
  });

  it('includes the production verifier data-temp root in default discovery when present', async () => {
    if (!existsSync('/mnt/data/tmp')) return;

    const roots = await defaultVerifyScanRoots({
      workspaceRoot: join(root, 'no-workspace'),
      hivesRoot: join(root, 'no-hives'),
    });

    expect(roots).toContain(realpathSync('/mnt/data/tmp'));
  });

  it('REFUSES a stop.sh-less snapshot whose owner run is still alive, however old', async () => {
    const dir = await makeSourceSnapshot(root, 'live', {
      ageHours: 500,
      marker: `pid=${process.pid}\nstart_ticks=${ownStartTicks()}\n`,
    });
    const res = await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: async () => {} });
    expect(res.reaped).toBe(0);
    expect(res.instances[0].skipped).toMatch(/owner run still alive/);
    expect(existsSync(dir)).toBe(true);
  });

  it('a recycled pid (same pid, different start ticks) does not keep a dead snapshot alive', async () => {
    const dir = await makeSourceSnapshot(root, 'recycled', {
      ageHours: 500,
      marker: `pid=${process.pid}\nstart_ticks=${Number(ownStartTicks()) + 1}\n`,
    });
    const res = await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: async () => {} });
    expect(res.reaped).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  it('keeps the TTL-only rule for a dir WITH stop.sh even when its marker is live', async () => {
    // A forgotten --boot-only rig's marker names its port-lock keeper, alive for as
    // long as the rig; honouring it here would make such rigs immortal.
    const dir = await makeInstance('bootonly', { ageHours: 200 });
    await writeFile(join(dir, '.papercusp-run'), `pid=${process.pid}\nstart_ticks=${ownStartTicks()}\n`);
    utimesSync(dir, hoursAgo(200), hoursAgo(200)); // the write bumped the dir mtime to now
    const stop = vi.fn(async () => {});
    const res = await gcVerifyInstances({ roots: [root], now: NOW, runStopScript: stop });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(res.reaped).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  it('orders oldest-first ACROSS roots, so a capped run takes the global worst offender', async () => {
    const a = join(root, 'a');
    const b = join(root, 'b');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await makeSourceSnapshot(a, 'newer', { ageHours: 100 });
    const oldest = await makeSourceSnapshot(b, 'oldest', { ageHours: 900 });
    const res = await gcVerifyInstances({ roots: [a, b], now: NOW, maxPerRun: 1, runStopScript: async () => {} });
    expect(res.reaped).toBe(1);
    expect(res.instances.find((i) => !i.skipped)?.dir).toBe(oldest);
    expect(existsSync(join(a, 'verify-tauri-headless.newer'))).toBe(true);
  });

  it('runMarkerIsLive: no marker and a garbage marker are both not-live', async () => {
    const bare = join(root, 'bare');
    await mkdir(bare, { recursive: true });
    expect(await runMarkerIsLive(bare)).toBe(false);
    await writeFile(join(bare, '.papercusp-run'), 'pid=notanumber\n');
    expect(await runMarkerIsLive(bare)).toBe(false);
  });
});
