// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { GNOME_SESSION_PROFILE_UUID, prepareGnomeTerminal } from './gnome-terminal-profile.mjs';

vi.mock('node:fs', () => ({ readFileSync: () => "#!/usr/bin/python3\nparser.add_argument('--disable-factory', action='store_true')" }));

describe('new GNOME window profile preparation', () => {
  it('keeps explicit profile selections and other emulators untouched', async () => {
    const run = vi.fn();
    for (const terminal of [
      { bin: 'xterm', args: ['-e'] },
      { bin: 'gnome-terminal', args: ['--profile=personal', '--'] },
      { bin: 'gnome-terminal', args: ['--profile', 'personal', '--'] },
    ]) {
      const prepared = await prepareGnomeTerminal(terminal, {}, run);
      if (terminal.bin === 'xterm') expect(prepared).toBe(terminal);
      else expect(prepared.args).toEqual(['--disable-factory', ...terminal.args]);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('selects the bounded copy only after verifying that the default was preserved', async () => {
    const run = vi.fn(async (_file: string, _args: string[], _options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }) => ({ stdout: JSON.stringify({ profileUuid: GNOME_SESSION_PROFILE_UUID,
      scrollbackLines: 10000, defaultProfileUuid: 'original', sourceProfileUuid: 'original', sourceUnlimited: true }) }));
    const terminal = { bin: '/usr/bin/gnome-terminal', args: ['--wait', '--window', '--'] };
    expect(await prepareGnomeTerminal(terminal, { DISPLAY: ':isolated' }, run)).toEqual({
      bin: terminal.bin, args: ['--profile=' + GNOME_SESSION_PROFILE_UUID, '--disable-factory', '--wait', '--window', '--'],
    });
    expect(terminal.args).toEqual(['--wait', '--window', '--']);
    expect(run.mock.calls[0][2].env).toEqual({ DISPLAY: ':isolated' });
  });

  it('refuses malformed receipts or a changed default instead of silently launching an unverified profile', async () => {
    const terminal = { bin: 'gnome-terminal', args: ['--'] };
    await expect(prepareGnomeTerminal(terminal, {}, async () => ({ stdout: '' }))).rejects.toThrow('valid receipt');
    await expect(prepareGnomeTerminal(terminal, {}, async () => ({ stdout: JSON.stringify({
      profileUuid: GNOME_SESSION_PROFILE_UUID, scrollbackLines: 10000,
      defaultProfileUuid: 'changed', sourceProfileUuid: 'original', sourceUnlimited: true,
    }) }))).rejects.toThrow('preserved default');
    const run = vi.fn(async () => ({ stdout: JSON.stringify({ profileUuid: null, created: false,
      sourceUnlimited: false, scrollbackLines: 10000, sourceProfileUuid: 'original', defaultProfileUuid: 'original' }) }));
    expect((await prepareGnomeTerminal(terminal, {}, run)).args).toEqual(['--disable-factory', '--']);
  });

  it('uses portable Python discovery and reports missing customer prerequisites', async () => {
    const run = vi.fn(async (..._args: unknown[]) => { throw Object.assign(new Error('python3 unavailable'), { code: 'ENOENT' }); });
    await expect(prepareGnomeTerminal({ bin: 'gnome-terminal', args: ['--'] }, { PATH: '/customer/bin' }, run))
      .rejects.toThrow('Install python3-gi and gnome-terminal');
    expect(run.mock.calls[0]?.[0]).toBe('python3');
  });

  it('accepts a verified finite source or explicit customization and rejects incomplete receipts', async () => {
    const terminal = { bin: 'gnome-terminal', args: ['--app-id=customer', '--'] };
    const receipt = { profileUuid: null, sourceUnlimited: false, scrollbackLines: 2000,
      sourceProfileUuid: 'personal', defaultProfileUuid: 'personal' };
    expect(await prepareGnomeTerminal(terminal, {}, async () => ({ stdout: JSON.stringify(receipt) }))).toEqual(terminal);
    expect(await prepareGnomeTerminal(terminal, {}, async () => ({ stdout: JSON.stringify({ profileUuid: null, customized: true }) }))).toEqual(terminal);
    for (const change of [{ scrollbackLines: 100000 }, { scrollbackLines: null }, { defaultProfileUuid: 'changed' }]) {
      await expect(prepareGnomeTerminal(terminal, {}, async () => ({ stdout: JSON.stringify({ ...receipt, ...change }) })))
        .rejects.toThrow('preserved default');
    }
    await expect(prepareGnomeTerminal(terminal, {}, async () => ({ stdout: '{"profileUuid":null}' }))).rejects.toThrow('preserved default');
  });

  it('protects large finite histories and retains explicit renderer grouping', async () => {
    const receipt = { profileUuid: GNOME_SESSION_PROFILE_UUID, scrollbackLines: 10000,
      sourceProfileUuid: 'original', defaultProfileUuid: 'original', sourceUnlimited: false };
    const terminal = { bin: 'gnome-terminal', args: ['--app-id=personal', '--window', '--'] };
    expect((await prepareGnomeTerminal(terminal, {}, async () => ({ stdout: JSON.stringify(receipt) }))).args)
      .toEqual(['--profile=' + GNOME_SESSION_PROFILE_UUID, ...terminal.args]);
  });

  it('uses system GI when another Python shadows it, without retrying a settings failure', async () => {
    const run = vi.fn().mockRejectedValueOnce(Object.assign(new Error('GI unavailable'), { stderr: "No module named 'gi'" }))
      .mockResolvedValueOnce({ stdout: JSON.stringify({ profileUuid: null, sourceUnlimited: false,
        scrollbackLines: 10000, sourceProfileUuid: 'original', defaultProfileUuid: 'original' }) });
    await prepareGnomeTerminal({ bin: 'gnome-terminal', args: ['--'] }, {}, run);
    expect(run.mock.calls.map((call) => call[0])).toEqual(['python3', '/usr/bin/python3']);
    const failed = vi.fn().mockRejectedValue(Object.assign(new Error('settings unavailable'), { stderr: 'reserved profile conflict' }));
    await expect(prepareGnomeTerminal({ bin: 'gnome-terminal', args: ['--'] }, {}, failed)).rejects.toThrow('reserved profile conflict');
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
