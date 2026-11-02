import { describe, expect, it, vi } from 'vitest';

const execFileResultMock = vi.hoisted(() => vi.fn());
const resolveLinuxDesktopEnvMock = vi.hoisted(() => vi.fn());

vi.mock('./sync-exec-replay', () => ({ execFileResult: execFileResultMock }));
vi.mock('./console-spawn', () => ({ resolveLinuxDesktopEnv: resolveLinuxDesktopEnvMock }));

describe('X11 command environment', () => {
  it('resolves the desktop environment once and passes it to window enumeration', async () => {
    const desktopEnv = {
      DISPLAY: ':91',
      XAUTHORITY: '/run/user/1000/gdm/Xauthority',
    };
    resolveLinuxDesktopEnvMock.mockReturnValue({ env: desktopEnv });
    execFileResultMock.mockResolvedValue({
      status: 0,
      stdout: '0x123 0 1234 host Papercup — native-session',
      stderr: '',
    });

    const { resolveWindowIdForPid } = await import('./adv-session-windows');
    await expect(resolveWindowIdForPid(1234)).resolves.toBe('0x123');

    expect(resolveLinuxDesktopEnvMock).toHaveBeenCalledTimes(1);
    expect(resolveLinuxDesktopEnvMock).toHaveBeenCalledWith(process.env);
    expect(execFileResultMock).toHaveBeenCalledTimes(1);
    const options = execFileResultMock.mock.calls[0]?.[2] as {
      timeout: number;
      env: NodeJS.ProcessEnv;
    };
    expect(options.timeout).toBe(2_000);
    expect(options.env).toMatchObject({ ...desktopEnv, PATH: process.env.PATH });
  });
});
