import { beforeEach, describe, expect, it, vi } from 'vitest';

const getLatestActiveAdvSessionByOwner = vi.fn();
vi.mock('../../../adv-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../adv-sessions')>()),
  getLatestActiveAdvSessionByOwner: (ownerId: string) => getLatestActiveAdvSessionByOwner(ownerId),
}));

const focusSessionWindow = vi.fn();
vi.mock('../../../adv-session-focus', () => ({
  focusSessionWindow: (...args: unknown[]) => focusSessionWindow(...args),
}));

const tool = (await import('./focus-window')).default;
const run = async (args: unknown) =>
  ((await tool.handler(args as never, {} as never)) as { data: Record<string, unknown> }).data;

beforeEach(() => vi.clearAllMocks());

describe('coord:focus-window', () => {
  it('focuses the newest active row for the exact coordination owner', async () => {
    const row = { id: 28143, windowId: '0x01e70b14' };
    getLatestActiveAdvSessionByOwner.mockResolvedValue(row);
    focusSessionWindow.mockResolvedValue({ focused: true, windowId: '0x01e70b14' });

    await expect(run({ ownerId: '  su-8ee55568  ' })).resolves.toEqual({
      ok: true,
      ownerId: 'su-8ee55568',
      focused: true,
      advSessionId: 28143,
      windowId: '0x01e70b14',
    });
    expect(getLatestActiveAdvSessionByOwner).toHaveBeenCalledWith('su-8ee55568');
    expect(focusSessionWindow).toHaveBeenCalledWith({ id: 28143, workspace: undefined }, row);
  });

  it('forwards a workspace choice without launching another session', async () => {
    const row = { id: 28143, windowId: '0x01e70b14' };
    getLatestActiveAdvSessionByOwner.mockResolvedValue(row);
    focusSessionWindow.mockResolvedValue({ focused: true, windowId: row.windowId });
    await run({ ownerId: 'su-live', workspace: 'window' });
    expect(focusSessionWindow).toHaveBeenCalledWith({ id: row.id, workspace: 'window' }, row);
  });

  it('returns a typed no_active_session result instead of launching anything', async () => {
    getLatestActiveAdvSessionByOwner.mockResolvedValue(null);
    const result = await run({ ownerId: 'su-ended' });
    expect(result).toMatchObject({
      ok: false,
      focused: false,
      advSessionId: null,
      code: 'no_active_session',
    });
    expect(focusSessionWindow).not.toHaveBeenCalled();
  });

  it('preserves the shared focus service failure code and window evidence', async () => {
    const row = { id: 7, windowId: null };
    getLatestActiveAdvSessionByOwner.mockResolvedValue(row);
    focusSessionWindow.mockResolvedValue({
      focused: false,
      windowId: '0xdead',
      code: 'focus_failed',
      reason: 'desktop refused activation',
    });

    await expect(run({ ownerId: 'su-live' })).resolves.toMatchObject({
      ok: false,
      focused: false,
      advSessionId: 7,
      windowId: '0xdead',
      code: 'focus_failed',
      reason: 'desktop refused activation',
    });
  });

  it('is discoverable as a real focus action, not a title marker', () => {
    expect(tool.name).toBe('coord:focus-window');
    expect(tool.description).toMatch(/focus.*foreground/i);
    expect(tool.description).toMatch(/never resumes, forks, terminates, or duplicates/i);
    expect(tool.guidance?.notWhen).toMatch(/coord:mark-terminal/);
    expect(tool.guidance?.notWhen).toMatch(/restoreVisible/);
  });
});
