/**
 * RTK liveness alarm (WI-6554700010009291). Both RTK seams fail open, so a lost
 * binary is otherwise silent — this is what makes removal visible. Pins:
 *  - probeRtk finds an executable rtk via the override and proves it runs;
 *  - a missing or non-running binary OPENS the per-host condition;
 *  - a healthy binary RESOLVES it;
 *  - a throwing probe or a failing broadcast never throws out of the check.
 * Fully injected: nothing reads the host's real rtk.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  probeRtk,
  readRtkLastRecordedDate,
  RTK_RECORDING_MIN_SHELL_CALLS,
  rtkLivenessConditionKey,
  rtkRecordingConditionKey,
  runRtkLivenessCheckOnce,
  type RtkLedgerRead,
  type RtkLiveness,
} from './rtk-liveness';

/** 2026-10-12T12:00Z; with a 48 h window the oldest fresh ledger day is 2026-10-10. */
const NOW = Date.parse('2026-10-12T12:00:00Z');

function recordingDeps(o: { lastDate?: string | null; ledger?: RtkLedgerRead; calls?: number; flag?: boolean } = {}) {
  return {
    readLedger: vi.fn((_bin: string): RtkLedgerRead => o.ledger ?? { ok: true, lastDate: o.lastDate ?? null }),
    shellCalls: vi.fn(async () => o.calls ?? 0),
    flagEnabled: vi.fn(async () => o.flag ?? true),
    now: () => NOW,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rtk-liveness-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function script(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

describe('probeRtk', () => {
  it('reports the version of a runnable rtk', () => {
    const bin = script('rtk', 'echo "rtk 0.51.0"');
    expect(probeRtk({ PAPERCUSP_RTK_BIN: bin })).toEqual({ ok: true, bin, version: '0.51.0' });
  });

  it('reports missing when no executable rtk exists', () => {
    expect(probeRtk({ PAPERCUSP_RTK_BIN: join(dir, 'nope') })).toMatchObject({ ok: false, reason: 'missing' });
  });

  it('reports not-runnable when rtk exits non-zero or prints no version', () => {
    const broken = script('rtk', 'exit 7');
    expect(probeRtk({ PAPERCUSP_RTK_BIN: broken })).toMatchObject({ ok: false, reason: 'not-runnable', bin: broken });
    const garbled = script('rtk2', 'echo "segfault"');
    expect(probeRtk({ PAPERCUSP_RTK_BIN: garbled })).toMatchObject({ ok: false, reason: 'not-runnable' });
  });
});

describe('runRtkLivenessCheckOnce', () => {
  function rail() {
    return {
      broadcast: vi.fn(async (_e: { conditionKey?: string; summary: string; oneShot?: boolean }) => true),
      resolve: vi.fn(async (_r: { conditionKey: string }) => true),
    };
  }
  const host = () => 'box-1';
  const key = rtkLivenessConditionKey('box-1');

  it('resolves the condition when rtk is healthy', async () => {
    const r = rail();
    const out = await runRtkLivenessCheckOnce({
      host,
      rail: r,
      probe: () => ({ ok: true, bin: '/x/rtk', version: '0.51.0' }),
      ...recordingDeps({ lastDate: '2026-10-12' }),
    });
    expect(out).toEqual({ verdict: 'ok', version: '0.51.0', recording: { recording: 'ok', lastDate: '2026-10-12' } });
    expect(r.broadcast).not.toHaveBeenCalled();
    expect(r.resolve).toHaveBeenCalledWith(expect.objectContaining({ conditionKey: key }));
  });

  it.each<RtkLiveness>([
    { ok: false, reason: 'missing', detail: 'no executable rtk' },
    { ok: false, reason: 'not-runnable', bin: '/x/rtk', detail: 'exited 7' },
  ])('opens the per-host condition when rtk is $reason', async (liveness) => {
    const r = rail();
    const out = await runRtkLivenessCheckOnce({ host, rail: r, probe: () => liveness });
    expect(out.verdict).toBe(liveness.ok ? 'ok' : liveness.reason);
    expect(r.resolve).not.toHaveBeenCalled();
    expect(r.broadcast).toHaveBeenCalledTimes(1);
    const event = r.broadcast.mock.calls[0]![0];
    expect(event.conditionKey).toBe(key);
    expect(event.oneShot).toBe(true);
    expect(event.summary).toMatch(/RTK output compression is OFF on box-1/);
  });

  it('treats a throwing probe as not-runnable instead of throwing', async () => {
    const r = rail();
    const out = await runRtkLivenessCheckOnce({ host, rail: r, probe: () => { throw new Error('boom'); } });
    expect(out).toMatchObject({ verdict: 'not-runnable' });
    expect(r.broadcast).toHaveBeenCalledTimes(1);
  });

  it('survives a failing broadcast, and says so on the console', async () => {
    const r = rail();
    r.broadcast.mockRejectedValueOnce(new Error('rail down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        runRtkLivenessCheckOnce({ host, rail: r, probe: () => ({ ok: false, reason: 'missing', detail: 'x' }) }),
      ).resolves.toMatchObject({ verdict: 'missing' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[rtk-liveness] condition broadcast failed'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('readRtkLastRecordedDate', () => {
  /** A fake rtk whose `gain --daily --format json` prints `json` and exits `code`. */
  function gain(json: string, code = 0): string {
    const out = join(dir, `gain-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(out, json);
    return script(`rtk-${Math.random().toString(36).slice(2)}`, `cat '${out}'\nexit ${code}`);
  }

  it('returns the newest day that recorded at least one command', () => {
    const bin = gain(JSON.stringify({
      summary: { total_commands: 9 },
      daily: [
        { date: '2026-10-09', commands: 4 },
        { date: '2026-10-12', commands: 0 },
        { date: '2026-10-11', commands: 5 },
        { date: 'not-a-day', commands: 3 },
      ],
    }));
    expect(readRtkLastRecordedDate(bin)).toEqual({ ok: true, lastDate: '2026-10-11' });
  });

  it('reads an empty ledger as recorded nothing, with or without a daily array', () => {
    expect(readRtkLastRecordedDate(gain(JSON.stringify({ summary: { total_commands: 0 } })))).toEqual({ ok: true, lastDate: null });
    expect(readRtkLastRecordedDate(gain(JSON.stringify({ summary: { total_commands: 0 }, daily: [] })))).toEqual({ ok: true, lastDate: null });
  });

  it('reports NOT MEASURED for a failing rtk, non-JSON output, or a JSON shape it does not know', () => {
    expect(readRtkLastRecordedDate(gain('{}', 2))).toMatchObject({ ok: false });
    expect(readRtkLastRecordedDate(gain('RTK Token Savings'))).toMatchObject({ ok: false, detail: expect.stringContaining('non-JSON') });
    expect(readRtkLastRecordedDate(gain(JSON.stringify({ summary: { total_commands: 7 } })))).toMatchObject({ ok: false });
  });
});

describe('runRtkLivenessCheckOnce — is rtk still being reached?', () => {
  function rail() {
    return {
      broadcast: vi.fn(async (_e: { conditionKey?: string; summary: string; body?: string; oneShot?: boolean }) => true),
      resolve: vi.fn(async (_r: { conditionKey: string }) => true),
    };
  }
  const host = () => 'box-1';
  const recordingKey = rtkRecordingConditionKey('box-1');
  const healthy = () => ({ ok: true as const, bin: '/x/rtk', version: '0.51.0' });
  const busy = RTK_RECORDING_MIN_SHELL_CALLS;

  function resolvedKeys(r: ReturnType<typeof rail>): string[] {
    return r.resolve.mock.calls.map((c) => c[0].conditionKey);
  }

  it('opens the recording condition when the ledger is stale while agents are busy', async () => {
    const r = rail();
    const deps = recordingDeps({ lastDate: '2026-10-09', calls: busy });
    const out = await runRtkLivenessCheckOnce({ host, rail: r, probe: healthy, ...deps });
    expect(out).toMatchObject({ verdict: 'ok', recording: { recording: 'stale', lastDate: '2026-10-09', shellCalls: busy } });
    expect(deps.readLedger).toHaveBeenCalledWith('/x/rtk');
    expect(r.broadcast).toHaveBeenCalledTimes(1);
    const event = r.broadcast.mock.calls[0]![0];
    expect(event.conditionKey).toBe(recordingKey);
    expect(event.oneShot).toBe(true);
    expect(event.summary).toMatch(/installed on box-1 but no shell command reaches it/);
    expect(resolvedKeys(r)).not.toContain(recordingKey);
  });

  it('opens it for a ledger that never recorded anything, too', async () => {
    const r = rail();
    const out = await runRtkLivenessCheckOnce({ host, rail: r, probe: healthy, ...recordingDeps({ lastDate: null, calls: busy + 1 }) });
    expect(out).toMatchObject({ recording: { recording: 'stale', lastDate: null } });
    expect(r.broadcast).toHaveBeenCalledTimes(1);
  });

  it('treats the window edge as fresh: a ledger day exactly 48 h back resolves', async () => {
    const r = rail();
    const deps = recordingDeps({ lastDate: '2026-10-10', calls: busy });
    const out = await runRtkLivenessCheckOnce({ host, rail: r, probe: healthy, ...deps });
    expect(out).toMatchObject({ recording: { recording: 'ok', lastDate: '2026-10-10' } });
    expect(deps.shellCalls).not.toHaveBeenCalled();
    expect(r.broadcast).not.toHaveBeenCalled();
    expect(resolvedKeys(r)).toContain(recordingKey);
  });

  it('a quiet host never alarms, however old the ledger', async () => {
    const r = rail();
    const out = await runRtkLivenessCheckOnce({ host, rail: r, probe: healthy, ...recordingDeps({ lastDate: '2026-09-01', calls: busy - 1 }) });
    expect(out).toMatchObject({ recording: { recording: 'quiet', shellCalls: busy - 1 } });
    expect(r.broadcast).not.toHaveBeenCalled();
    expect(resolvedKeys(r)).toContain(recordingKey);
  });

  it('the kill-switch flag OFF is deliberate: no alarm, and activity is not even counted', async () => {
    const r = rail();
    const deps = recordingDeps({ lastDate: '2026-09-01', calls: 10_000, flag: false });
    const out = await runRtkLivenessCheckOnce({ host, rail: r, probe: healthy, ...deps });
    expect(out).toMatchObject({ recording: { recording: 'flag-off' } });
    expect(deps.shellCalls).not.toHaveBeenCalled();
    expect(r.broadcast).not.toHaveBeenCalled();
  });

  it('NOT MEASURED (ledger or activity read fails) neither alarms nor resolves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const deps of [
        recordingDeps({ ledger: { ok: false, detail: 'rtk gain exited 2' } }),
        { ...recordingDeps({ lastDate: '2026-09-01' }), shellCalls: vi.fn(async () => Promise.reject(new Error('pg down'))) },
        { ...recordingDeps(), readLedger: vi.fn(() => { throw new Error('spawn EACCES'); }) },
      ]) {
        const r = rail();
        const out = await runRtkLivenessCheckOnce({ host, rail: r, probe: healthy, ...deps });
        expect(out).toMatchObject({ verdict: 'ok', recording: { recording: 'unknown' } });
        expect(r.broadcast).not.toHaveBeenCalled();
        expect(resolvedKeys(r)).not.toContain(recordingKey);
      }
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not measured'));
    } finally {
      warn.mockRestore();
    }
  });

  it('a missing binary raises only the liveness alarm, never the recording one', async () => {
    const r = rail();
    const deps = recordingDeps({ lastDate: null, calls: busy });
    await runRtkLivenessCheckOnce({ host, rail: r, probe: () => ({ ok: false, reason: 'missing', detail: 'gone' }), ...deps });
    expect(deps.readLedger).not.toHaveBeenCalled();
    expect(r.broadcast.mock.calls.map((c) => c[0].conditionKey)).toEqual([rtkLivenessConditionKey('box-1')]);
  });
});
