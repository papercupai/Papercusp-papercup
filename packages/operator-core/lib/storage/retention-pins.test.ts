import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pruneRunsWithReport, pruneStaleForeign } from '../../../../libs/generic/verification-harness/src/runner';
import { isLeaseLive, readRetentionLeases } from '../release-cut-reclaim';
import { createRetentionPin, pinProtectsPath, readRetentionPins, readRetentionPinsAsync, removeRetentionPin } from './retention-pins';
import { withRetentionPinProtection as withPortablePinProtection } from '../../../../scripts/lib/retention-pins.mjs';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'retention-pin-')); roots.push(root);
  const dir = join(root, 'leases'); const target = join(root, 'agent-output'); mkdirSync(target);
  const nowMs = Date.UTC(2026, 9, 15);
  return { root, dir, target, nowMs, expiresAt: new Date(nowMs + 3600_000).toISOString() };
}

describe('agent retention pins in the existing lease store', () => {
  it('keeps caller-registry descendant pins when a privileged reader resolves the store alias', async () => {
    const f = fixture();
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(f.root, 'mutex'));
    const child = join(f.target, 'review'); mkdirSync(child);
    createRetentionPin({ path: child, owner: 'a', reason: 'retained rootful artifact', expiresAt: f.expiresAt }, f);
    const alias = join(f.root, 'rootful-store');
    const resolvePath = vi.fn((path: string) => path === alias ? f.target : path);
    await withPortablePinProtection(isPinned => {
      expect(isPinned(alias)).toBe(true);
      expect(isPinned(`${alias}-other`)).toBe(false);
    }, { dir: f.dir, nowMs: f.nowMs, resolvePath });
    expect(resolvePath).toHaveBeenCalledWith(alias);
  });

  it('fails closed when the privileged path reader is refused', async () => {
    const f = fixture();
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(f.root, 'mutex'));
    await expect(withPortablePinProtection(isPinned => isPinned(f.target), {
      dir: f.dir, nowMs: f.nowMs,
      resolvePath: () => { throw Object.assign(new Error('privileged read refused'), { code: 'EACCES' }); },
    })).rejects.toThrow('privileged read refused');
  });

  it('refuses corrupt caller pins before admitting a privileged path reader', async () => {
    const f = fixture();
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(f.root, 'mutex'));
    mkdirSync(f.dir); writeFileSync(join(f.dir, 'lease-agent-pin-broken.tsv'), 'broken');
    const resolvePath = vi.fn((path: string) => path);
    await expect(withPortablePinProtection(isPinned => isPinned(f.target), {
      dir: f.dir, nowMs: f.nowMs, resolvePath,
    })).rejects.toThrow('retention pins unreadable');
    expect(resolvePath).not.toHaveBeenCalled();
  });

  it('VH count and pressure passes retain pinned runs through a physical alias and expiry restores eligibility', async () => {
    const f = fixture();
    vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', f.dir);
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(f.root, 'mutex'));
    const names = ['20261001T000000Z-1', '20261002T000000Z-2', '20261003T000000Z-3'];
    for (const name of names) {
      const dir = join(f.target, name); mkdirSync(dir);
      writeFileSync(join(dir, 'result.json'), JSON.stringify({ schemaVersion: 1, runId: name, endedAt: new Date(f.nowMs).toISOString(), verdict: 'pass' }));
    }
    const held = join(f.target, names[0]!); const child = join(held, 'review'); mkdirSync(child);
    createRetentionPin({ path: child, owner: 'a', reason: 'review', expiresAt: f.expiresAt }, f);
    const alias = join(f.root, 'alias'); symlinkSync(f.target, alias);
    const options = { measureDisk: async () => ({ totalBytes: 100, availableBytes: 0 }), reserveBytes: () => 1 };
    const preview = await pruneRunsWithReport(alias, 1, f.nowMs, { ...options, dryRun: true });
    expect(preview.preview?.kept).toContainEqual({ path: join(alias, names[0]!), reason: 'retention-pin' });
    const report = await pruneRunsWithReport(alias, 1, f.nowMs, options);
    expect(report.removed).toContain(names[1]);
    expect(report.removed).not.toContain(names[0]); expect(existsSync(held)).toBe(true);
    expect((await pruneRunsWithReport(alias, 1, Date.parse(f.expiresAt), options)).removed).toContain(names[0]);
  });

  it('VH foreign retention honors descendant pins, expiry, and corrupt-store refusal', async () => {
    const f = fixture();
    vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', f.dir);
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(f.root, 'mutex'));
    const held = join(f.target, 'held'); const other = join(f.target, 'other');
    mkdirSync(held); mkdirSync(other); const child = join(held, 'review'); writeFileSync(child, 'evidence');
    for (const path of [child, held, other]) utimesSync(path, new Date(0), new Date(0));
    createRetentionPin({ path: child, owner: 'a', reason: 'review', expiresAt: f.expiresAt }, f);
    expect((await pruneStaleForeign(f.target, { maxAgeHours: 72, now: f.nowMs })).removed).toEqual(['other']);
    expect(existsSync(held)).toBe(true);
    writeFileSync(join(f.dir, 'lease-broken.tsv'), 'broken');
    await expect(pruneStaleForeign(f.target, { maxAgeHours: 72, now: f.nowMs })).rejects.toThrow(/retention pins unreadable/);
    await expect(pruneRunsWithReport(f.target, 1, f.nowMs)).rejects.toThrow(/retention pins unreadable/);
    expect(existsSync(held)).toBe(true);
    rmSync(join(f.dir, 'lease-broken.tsv'));
    expect((await pruneStaleForeign(f.target, { maxAgeHours: 72, now: Date.parse(f.expiresAt) })).removed).toEqual(['held']);
  });

  it('async reads share sync metadata validation, expiry and malformed-store protection', async () => {
    const f = fixture();
    expect(await readRetentionPinsAsync(f)).toEqual(readRetentionPins(f));
    createRetentionPin({ path: f.target, owner: 'a', reason: 'review', expiresAt: f.expiresAt }, f);
    expect(await readRetentionPinsAsync(f)).toEqual(readRetentionPins(f));
    const expired = { ...f, nowMs: Date.parse(f.expiresAt) };
    expect(await readRetentionPinsAsync(expired)).toEqual({ pins: [], errors: [] });
    writeFileSync(join(f.dir, 'lease-agent-pin-corrupt.tsv'), 'broken');
    expect((await readRetentionPinsAsync(f)).errors).toHaveLength(1);
  });

  it('round-trips owner, reason and finite expiry while existing deleters recognize the same lease', () => {
    const f = fixture();
    const pin = createRetentionPin({ path: f.target, owner: 'agent-a', reason: 'Avi’s review\nretain evidence', expiresAt: f.expiresAt }, f);
    expect(readRetentionPins(f)).toEqual({ pins: [pin], errors: [] });
    const leases = readRetentionLeases(f.dir);
    expect(leases.errors).toEqual([]); expect(leases.leases).toHaveLength(1);
    expect(isLeaseLive(leases.leases[0]!, f.nowMs)).toBe(true);
    expect(leases.leases[0]!.paths).toEqual([f.target]);
    expect(readdirSync(f.dir)).toEqual([`lease-agent-pin-${pin.id}.tsv`]);
  });

  it('protects ancestors and descendants, with no sibling-prefix collision, and stops exactly at expiry', () => {
    const f = fixture(); const pin = createRetentionPin({ path: f.target, owner: 'a', reason: 'review', expiresAt: f.expiresAt }, f);
    expect(pinProtectsPath(join(f.target, 'report.json'), [pin], f.nowMs)).toBe(true);
    expect(pinProtectsPath(f.root, [pin], f.nowMs)).toBe(true);
    expect(pinProtectsPath(`${f.target}-other`, [pin], f.nowMs)).toBe(false);
    expect(pinProtectsPath(f.target, [pin], Date.parse(f.expiresAt))).toBe(false);
    expect(readRetentionPins({ ...f, nowMs: Date.parse(f.expiresAt) }).pins).toEqual([]);
    expect(readRetentionPins({ ...f, nowMs: Date.parse(f.expiresAt), includeExpired: true }).pins).toEqual([pin]);
  });

  it('protects both the logical alias and the physical offloaded path', () => {
    const f = fixture(); const alias = join(f.root, 'alias'); symlinkSync(f.target, alias);
    const pin = createRetentionPin({ path: alias, owner: 'a', reason: 'offloaded evidence', expiresAt: f.expiresAt }, f);
    expect(pin.paths).toEqual([alias, f.target]);
    expect(pinProtectsPath(join(alias, 'x'), [pin], f.nowMs)).toBe(true);
    expect(pinProtectsPath(join(f.target, 'x'), [pin], f.nowMs)).toBe(true);
  });

  it('refuses missing paths, nonfinite/past expiries and newline injection without creating a lease', () => {
    const f = fixture(); const base = { path: f.target, owner: 'a', reason: 'review', expiresAt: f.expiresAt };
    for (const input of [{ ...base, path: join(f.root, 'missing') }, { ...base, path: `${f.target}\npath=/` },
      { ...base, expiresAt: 'never' }, { ...base, expiresAt: new Date(f.nowMs).toISOString() }, { ...base, reason: ' ' }]) {
      expect(() => createRetentionPin(input, f)).toThrow();
    }
    expect(readRetentionPins(f)).toEqual({ pins: [], errors: [] });
  });

  it('reports corrupt pin metadata instead of silently dropping protection', () => {
    const f = fixture(); const pin = createRetentionPin({ path: f.target, owner: 'a', reason: 'review', expiresAt: f.expiresAt }, f);
    const file = join(f.dir, `lease-agent-pin-${pin.id}.tsv`);
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^tag=.*$/m, 'tag=agent-pin-invalid'));
    expect(readRetentionPins(f).errors).toHaveLength(1);
    // The existing lease reader still protects its path: damaged descriptive metadata cannot enable deletion.
    expect(readRetentionLeases(f.dir).leases[0]!.paths).toEqual([f.target]);
  });

  it('permits only the pin owner to release an exact id', () => {
    const f = fixture(); const pin = createRetentionPin({ path: f.target, owner: 'agent-a', reason: 'review', expiresAt: f.expiresAt }, f);
    expect(() => removeRetentionPin(pin.id, 'agent-b', f)).toThrow(/only the pin owner/);
    expect(readRetentionPins(f).pins).toEqual([pin]);
    expect(removeRetentionPin(pin.id, 'agent-a', f)).toBe(true);
    expect(removeRetentionPin(pin.id, 'agent-a', f)).toBe(false);
    expect(readRetentionPins(f)).toEqual({ pins: [], errors: [] });
  });
});
