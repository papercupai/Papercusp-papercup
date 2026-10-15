/**
 * readBgHostActiveEnterMs — the IO edge behind the bg-host generation boundary
 * (EI-24748208098755918).
 *
 * It used to fork `systemctl` LOCALLY on every scorecard read that carried a
 * generation stamp. The fork is synchronous on the caller's event loop and scales
 * with the parent's RSS; a 3 h saturation-profile aggregate charged 6.3% of all
 * busy operator main-thread time to it. These tests pin the two halves of the fix:
 * the probe goes through the spawner-sidecar seam, and back-to-back readers share
 * one probe for a few seconds instead of forking once each.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileViaSidecarMock = vi.fn();
vi.mock('../fleet/git-via-sidecar', () => ({
  execFileViaSidecar: (...args: unknown[]) => execFileViaSidecarMock(...args),
}));

import {
  BG_HOST_ACTIVE_ENTER_MEMO_MS,
  BG_HOST_UNIT,
  GENERATION_WATERMARK_SIDECAR_VAR,
  __resetBgHostActiveEnterMemo,
  readBgHostActiveEnterMs,
} from './generation-watermark';

beforeEach(() => {
  __resetBgHostActiveEnterMemo();
  execFileViaSidecarMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('readBgHostActiveEnterMs (EI-24748208098755918)', () => {
  it('probes systemd through the spawner-sidecar seam, with TZ=UTC and the full env', async () => {
    execFileViaSidecarMock.mockResolvedValueOnce({ stdout: 'Tue 2026-07-14 18:08:24 UTC\n', stderr: '' });
    expect(await readBgHostActiveEnterMs()).toBe(Date.parse('2026-07-14T18:08:24Z'));

    expect(execFileViaSidecarMock).toHaveBeenCalledTimes(1);
    const [command, args, opts] = execFileViaSidecarMock.mock.calls[0];
    expect(command).toBe('systemctl');
    expect(args).toEqual(['--user', 'show', BG_HOST_UNIT, '-p', 'ActiveEnterTimestamp', '--value']);
    expect(opts.sidecarVar).toBe(GENERATION_WATERMARK_SIDECAR_VAR);
    expect(opts.env.TZ).toBe('UTC');
    // The local fallback REPLACES the child env; systemctl --user needs the session bus.
    expect(opts.env.PATH).toBe(process.env.PATH);
  });

  it('shares one probe across readers inside the memo window, and re-probes after it', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-01T23:00:00Z') });
    execFileViaSidecarMock.mockResolvedValue({ stdout: '2026-10-01 20:00:00 UTC', stderr: '' });

    const [a, b] = await Promise.all([readBgHostActiveEnterMs(), readBgHostActiveEnterMs()]);
    await readBgHostActiveEnterMs();
    expect(a).toBe(b);
    expect(execFileViaSidecarMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + BG_HOST_ACTIVE_ENTER_MEMO_MS);
    await readBgHostActiveEnterMs();
    expect(execFileViaSidecarMock).toHaveBeenCalledTimes(2);
  });

  it('keys the memo by unit, so a different unit is never answered from another unit’s probe', async () => {
    execFileViaSidecarMock
      .mockResolvedValueOnce({ stdout: '2026-10-01 20:00:00 UTC', stderr: '' })
      .mockResolvedValueOnce({ stdout: '2026-10-01 21:00:00 UTC', stderr: '' });
    expect(await readBgHostActiveEnterMs('a.service')).toBe(Date.parse('2026-10-01T20:00:00Z'));
    expect(await readBgHostActiveEnterMs('b.service')).toBe(Date.parse('2026-10-01T21:00:00Z'));
  });

  it('resolves null (never rejects) when the probe fails, so a scorecard read degrades to unknown', async () => {
    execFileViaSidecarMock.mockRejectedValueOnce(new Error('systemctl exited 1'));
    await expect(readBgHostActiveEnterMs()).resolves.toBeNull();
  });
});
