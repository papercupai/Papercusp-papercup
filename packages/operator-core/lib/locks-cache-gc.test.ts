import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCKS_CACHE_RETENTION_MS, locksCacheDir, runLocksCacheGc } from './locks-cache-gc';

const NOW = Date.parse('2026-10-02T03:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const dirs: string[] = [];

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'locks-cache-gc-'));
  dirs.push(dir);
  return dir;
}

function file(dir: string, name: string, ageMs: number): string {
  const path = join(dir, name);
  writeFileSync(path, '{}');
  const t = new Date(NOW - ageMs);
  utimesSync(path, t, t);
  return path;
}

afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('runLocksCacheGc (WI-10005187)', () => {
  it('removes only regular files older than the retention window', async () => {
    const dir = temp();
    file(dir, 'owner-su-dead-last-acquire.json', 40 * DAY);
    file(dir, 'activity-hook-bundle-su-dead.json', LOCKS_CACHE_RETENTION_MS + 60_000);
    file(dir, 'coord-cursor-su-live.json', 2 * DAY);
    file(dir, 'tip-notice-su-live.json', LOCKS_CACHE_RETENTION_MS - 60_000);
    mkdirSync(join(dir, 'a-subdir'));
    const subdirFile = file(join(dir, 'a-subdir'), 'inner.json', 40 * DAY);
    const target = file(temp(), 'target.json', 40 * DAY);
    symlinkSync(target, join(dir, 'old-link.json'));

    const r = await runLocksCacheGc({ dir, now: () => NOW });

    expect(r).toMatchObject({ dir, scanned: 6, removed: 2, kept: 4, skipped: 0, error: null });
    expect(readdirSync(dir).sort()).toEqual([
      'a-subdir',
      'coord-cursor-su-live.json',
      'old-link.json',
      'tip-notice-su-live.json',
    ]);
    // Never recurses, never follows a symlink to its target.
    expect(readFileSync(subdirFile, 'utf8')).toBe('{}');
    expect(readFileSync(target, 'utf8')).toBe('{}');
  });

  it('treats an absent directory as a no-op, not an error', async () => {
    const r = await runLocksCacheGc({ dir: join(temp(), 'missing'), now: () => NOW });
    expect(r).toMatchObject({ scanned: 0, removed: 0, error: null });
  });

  it('honours the hooks’ PAPERCUSP_LOCKS_CACHE_DIR override', () => {
    const saved = process.env.PAPERCUSP_LOCKS_CACHE_DIR;
    process.env.PAPERCUSP_LOCKS_CACHE_DIR = '/tmp/x-locks-cache';
    try {
      expect(locksCacheDir()).toBe('/tmp/x-locks-cache');
    } finally {
      if (saved === undefined) delete process.env.PAPERCUSP_LOCKS_CACHE_DIR;
      else process.env.PAPERCUSP_LOCKS_CACHE_DIR = saved;
    }
  });

  it('is driven by the daily scratch GC workflow, async and without a sync directory read', () => {
    const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    const workflows = src('./dbos/periodic-workflows.ts');
    const tick = workflows.slice(workflows.indexOf('async function scratchGcTick'), workflows.indexOf('const scratchGcWorkflow'));
    expect(tick).toContain('await runLocksCacheGc()');
    expect(tick).toContain("name: 'locks-cache-gc'");

    const gc = src('./locks-cache-gc.ts');
    expect(gc).not.toMatch(/\b\w+Sync\(/);
    expect(gc).toMatch(/from 'node:fs\/promises'/);
  });
});
