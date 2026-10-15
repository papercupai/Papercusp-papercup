import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FullConfig } from '@playwright/test';

const rig = vi.hoisted(() => {
  const waitFor = vi.fn();
  const page = {
    route: vi.fn(), goto: vi.fn(), waitForFunction: vi.fn(), waitForLoadState: vi.fn(),
    locator: vi.fn(() => ({ waitFor })),
  };
  const browser = { newPage: vi.fn(() => page), close: vi.fn() };
  const api = { get: vi.fn(), dispose: vi.fn() };
  return { page, browser, waitFor, api, newContext: vi.fn(), launch: vi.fn(() => browser) };
});

vi.mock('@playwright/test', () => ({
  chromium: { launch: rig.launch }, request: { newContext: rig.newContext },
}));
vi.mock('@papercusp/test-config/admin-test-runs-reporter', () => ({
  resolveTestRunWorkspaceId: () => 'real workspace',
}));

import warmDevServer, { WARMUP_PATHS } from '../../e2e/_warm-dev-server';
import warmOngoingWork from '../../e2e/_warm-ongoing-work';

const config = { projects: [{ use: { baseURL: 'http://localhost:3427' } }] } as FullConfig;

describe('Playwright view preparation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rig.launch.mockImplementation(() => rig.browser);
    rig.browser.close.mockResolvedValue(undefined);
    rig.waitFor.mockResolvedValue(undefined);
    rig.page.waitForFunction.mockResolvedValue(undefined);
    rig.page.waitForLoadState.mockResolvedValue(undefined);
    vi.stubEnv('OPERATOR_E2E_SKIP_WARMUP', '0');
    vi.stubEnv('PAPERCUSP_ONGOING_ACCEPTANCE_SHA', '0123456789');
    rig.newContext.mockResolvedValue(rig.api);
    rig.api.get.mockResolvedValue({
      ok: () => true, status: () => 200, json: async () => ({ sha: '0123456789' }),
    });
    rig.api.dispose.mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('keeps default route preparation available to the ordinary suite', async () => {
    await warmDevServer(config);
    expect(rig.page.goto.mock.calls.map(([url]) => url)).toEqual(
      WARMUP_PATHS.map(path => new URL(path, 'http://localhost:3427').toString()),
    );
    expect(rig.page.waitForFunction).toHaveBeenCalledTimes(WARMUP_PATHS.length);
    expect(rig.browser.close).toHaveBeenCalledOnce();
  });

  it('prepares the actual scoped HUD and waits for its view instead of only the shell', async () => {
    await warmOngoingWork(config);
    expect(rig.newContext).toHaveBeenCalledWith({ baseURL: 'http://localhost:3427' });
    expect(rig.api.get).toHaveBeenCalledWith('/api/health', { timeout: 10_000 });
    expect(rig.api.dispose).toHaveBeenCalledOnce();
    expect(rig.page.goto).toHaveBeenCalledOnce();
    expect(rig.page.goto.mock.calls[0][0]).toBe(
      'http://localhost:3427/adv?tab=hud&scope=all&hudtab=goals&welcome=0&ws=real%20workspace',
    );
    expect(rig.page.locator).toHaveBeenCalledWith('[role="tablist"][aria-label="HUD board"]');
    expect(rig.waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 120_000 });
    expect(rig.page.waitForFunction).not.toHaveBeenCalled();
    expect(rig.browser.close).toHaveBeenCalledOnce();
  });

  it.each([
    { label: 'unhealthy HTTP response', ok: false, status: 503, health: {}, error: 'HTTP 503' },
    { label: 'a different artifact', ok: true, status: 200, health: { sha: '9876543210' }, error: 'SHA mismatch' },
    { label: 'a fallback bundle', ok: true, status: 200, health: { sha: '0123456789', bundleStale: true }, error: 'fallback bundle' },
  ])('refuses browser preparation for $label and disposes its preflight context', async ({ ok, status, health, error }) => {
    rig.api.get.mockResolvedValueOnce({ ok: () => ok, status: () => status, json: async () => health });
    await expect(warmOngoingWork(config)).rejects.toThrow(error);
    expect(rig.launch).not.toHaveBeenCalled();
    expect(rig.page.goto).not.toHaveBeenCalled();
    expect(rig.api.dispose).toHaveBeenCalledOnce();
  });

  it('refuses strict preparation when the required view never mounts and closes the browser', async () => {
    rig.waitFor.mockRejectedValue(new Error('HUD never mounted'));
    await expect(warmOngoingWork(config)).rejects.toThrow('HUD never mounted');
    expect(rig.browser.close).toHaveBeenCalledOnce();
  });

  it('retains fail-soft default preparation when ordinary shell readiness fails', async () => {
    rig.page.waitForFunction.mockRejectedValue(new Error('shell never mounted'));
    await expect(warmDevServer(config)).resolves.toBeUndefined();
    expect(rig.browser.close).toHaveBeenCalledOnce();
  });

  it('continues ordinary specs when the warm-up browser cannot launch', async () => {
    rig.launch.mockRejectedValueOnce(new Error('Executable does not exist'));
    await expect(warmDevServer(config)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Executable does not exist'));
    expect(rig.page.goto).not.toHaveBeenCalled();
    expect(rig.browser.close).not.toHaveBeenCalled();
  });

  it('still refuses strict preparation when the browser cannot launch', async () => {
    rig.launch.mockRejectedValueOnce(new Error('Executable does not exist'));
    await expect(warmDevServer(config, { strict: true })).rejects.toThrow('Executable does not exist');
    expect(rig.browser.close).not.toHaveBeenCalled();
  });

  it('uses the profile browser and launch options during preparation', async () => {
    const profile = { projects: [{ use: {
      baseURL: 'http://localhost:3427', channel: 'chrome', launchOptions: { timeout: 12_000 },
    } }] } as FullConfig;
    await warmDevServer(profile);
    expect(rig.launch).toHaveBeenCalledWith({ channel: 'chrome', timeout: 12_000 });
    expect(rig.page.goto).toHaveBeenCalledTimes(WARMUP_PATHS.length);
  });

  it('keeps browser cleanup failure fail-soft for ordinary specs', async () => {
    rig.browser.close.mockRejectedValueOnce(new Error('Browser already disconnected'));
    await expect(warmDevServer(config)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Browser already disconnected'));
  });
});
