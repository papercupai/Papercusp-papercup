/**
 * client-native-features-adoption-2026-10-21 P-004 (D-012) — the launch-time half of the
 * papercusp Claude plugin: psu-launcher.mjs must count a hook the enabled plugin carries
 * as enrolled, and must detect (and repair once, then report) a launch whose plugin rails
 * are missing, disabled, or doubled up with inline settings.json entries.
 *
 * Pure: the settings file, the plugin hooks.json and the install-route repair are all fakes.
 */
import { describe, it, expect, vi } from 'vitest';
import { ccHookEnrollment, ensureClaudePluginRails } from '../psu-launcher.mjs';

const SETTINGS = '/home/u/.claude/settings.json';
const ROOT = '/home/u/.papercusp/claude-plugins';
const PLUGIN_HOOKS_PATH = `${ROOT}/plugins/papercusp/hooks/hooks.json`;
const LOCKS = '/home/u/.papercusp/hooks/cc/pretooluse-locks-acquire.sh';

const pluginHooks = { PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: LOCKS }] }] };
const enrollment = (enabled: boolean | undefined = true) => ({
  ...(enabled === undefined ? {} : { enabledPlugins: { 'papercusp@papercusp-local': enabled } }),
  extraKnownMarketplaces: { 'papercusp-local': { source: { source: 'directory', path: ROOT } } },
});

/** A fake filesystem: path → text. Mutable so a fake repair can rewrite it. */
function fakeFs(settings: unknown, withPluginHooks = true) {
  const files: Record<string, string> = { [SETTINGS]: JSON.stringify(settings) };
  if (withPluginHooks) files[PLUGIN_HOOKS_PATH] = JSON.stringify({ hooks: pluginHooks });
  return { files, readFile: (p: string) => files[p] ?? null };
}

describe('ccHookEnrollment — plugin-carried hooks (P-004)', () => {
  const settings = JSON.stringify({ ...enrollment(), hooks: {} });
  const fs = fakeFs({});

  it('counts a hook the ENABLED plugin carries as enrolled when readFile can reach its hooks.json', () => {
    const v = ccHookEnrollment(settings, {
      event: 'PreToolUse',
      hookName: 'pretooluse-locks-acquire.sh',
      readFile: fs.readFile,
      scriptExists: (p: string) => p === LOCKS,
    });
    expect(v).toEqual({ enrolled: true, misses: [] });
  });

  it('without readFile only inline entries count (the pre-P-004 behaviour)', () => {
    const v = ccHookEnrollment(settings, { event: 'PreToolUse', hookName: 'pretooluse-locks-acquire.sh' });
    expect(v.enrolled).toBe(false);
    expect(v.misses).toEqual(['no PreToolUse entry runs pretooluse-locks-acquire.sh']);
  });

  it('a DISABLED plugin carries nothing', () => {
    const v = ccHookEnrollment(JSON.stringify({ ...enrollment(false), hooks: {} }), {
      event: 'PreToolUse',
      hookName: 'pretooluse-locks-acquire.sh',
      readFile: fs.readFile,
    });
    expect(v.enrolled).toBe(false);
  });
});

describe('ensureClaudePluginRails (P-004 launch guard)', () => {
  const claudeEnv = { PAPERCUSP_AGENT: 'claude' };

  it('is a no-op for a non-Claude launch — reads nothing, repairs nothing', () => {
    const readFile = vi.fn();
    const repair = vi.fn();
    expect(ensureClaudePluginRails({ PAPERCUSP_AGENT: 'codex' }, { settingsPath: SETTINGS, readFile, repair })).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
  });

  it('healthy plugin carrier: no repair, no log', () => {
    const fs = fakeFs({ ...enrollment(), hooks: {} });
    const repair = vi.fn();
    const log = vi.fn();
    const v = ensureClaudePluginRails(claudeEnv, { settingsPath: SETTINGS, readFile: fs.readFile, repair, log });
    expect(v?.carrier).toBe('plugin');
    expect(v?.problems).toEqual([]);
    expect(repair).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('a disabled plugin is repaired ONCE through the install route, then logged as repaired', () => {
    const fs = fakeFs({ ...enrollment(false), hooks: {} });
    const repair = vi.fn(() => {
      fs.files[SETTINGS] = JSON.stringify({ ...enrollment(), hooks: {} });
    });
    const log = vi.fn();
    const v = ensureClaudePluginRails(claudeEnv, { settingsPath: SETTINGS, readFile: fs.readFile, repair, log });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(v?.carrier).toBe('plugin');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/repaired via the operator install route.*plugin-disabled/);
  });

  it('missing plugin that the repair cannot fix: one repair attempt, then a LOUD banner naming the problem', () => {
    const fs = fakeFs({ ...enrollment(), hooks: {} }, false);
    const repair = vi.fn();
    const log = vi.fn();
    const v = ensureClaudePluginRails(claudeEnv, { settingsPath: SETTINGS, readFile: fs.readFile, repair, log });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(v?.carrier).toBe('none');
    const banner = String(log.mock.calls[0][0]);
    expect(banner).toMatch(/PAPERCUSP CLAUDE PLUGIN RAILS: MISSING OR DISABLED/);
    expect(banner).toContain(`plugin-missing: ${PLUGIN_HOOKS_PATH}`);
    expect(banner).toMatch(/NO papercusp hooks/);
    expect(banner).toMatch(/Launching anyway/);
  });

  it('a hook enrolled inline AND by the plugin is reported as HOOKS ENROLLED TWICE', () => {
    const fs = fakeFs({ ...enrollment(), hooks: pluginHooks });
    const log = vi.fn();
    const v = ensureClaudePluginRails(claudeEnv, {
      settingsPath: SETTINGS,
      readFile: fs.readFile,
      repair: () => {},
      log,
    });
    expect(v?.carrier).toBe('double');
    expect(v?.doubleEnrolled).toEqual(['PreToolUse:pretooluse-locks-acquire.sh']);
    expect(String(log.mock.calls[0][0])).toMatch(/HOOKS ENROLLED TWICE[\s\S]*fires twice/);
  });

  it('hooks only inline (pre-plugin install) are reported as PLUGIN NOT INSTALLED but still running', () => {
    const fs = fakeFs({ hooks: pluginHooks }, false);
    const log = vi.fn();
    const v = ensureClaudePluginRails(claudeEnv, { settingsPath: SETTINGS, readFile: fs.readFile, repair: () => {}, log });
    expect(v?.carrier).toBe('inline');
    expect(String(log.mock.calls[0][0])).toMatch(/PLUGIN NOT INSTALLED[\s\S]*Hooks still run, from settings\.json/);
  });
});
