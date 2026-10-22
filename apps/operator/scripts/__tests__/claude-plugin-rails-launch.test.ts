/**
 * client-native-features-adoption-2026-10-21 P-004 (D-012) — the launch-time half of the
 * papercusp Claude plugin: psu-launcher.mjs must count a hook the enabled plugin carries
 * as enrolled, and must detect (and repair once, then report) a launch whose plugin rails
 * are missing, disabled, or doubled up with inline settings.json entries.
 *
 * Pure: the settings file, the plugin hooks.json and the install-route repair are all fakes.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ccHookEnrollment, ensureCcHookEnrollment, ensureClaudePluginRails, repairCcHooksViaInstallRoute } from '../psu-launcher.mjs';
import { papercuspClaudePluginHooks } from '../../../../packages/operator-core/lib/desktop-install/papercusp-files';
import { claudeHookCarrierVerdict, REQUIRED_CLAUDE_HOOKS } from '../../../../packages/operator-core/lib/claude-plugin/plugin-rails.mjs';

const SETTINGS = '/home/u/.claude/settings.json';
const ROOT = '/home/u/.papercusp/claude-plugins';
const PLUGIN_HOOKS_PATH = `${ROOT}/plugins/papercusp/hooks/hooks.json`;
const LOCKS = '/home/u/.papercusp/hooks/cc/pretooluse-locks-acquire.sh';
const OPERATOR_URL = 'http://127.0.0.1:54321';

// The degraded banner includes a repair URL. Keep its lazy target resolver off
// the host's live proxy/discovery path, just like the fake repair and filesystem.
beforeEach(() => {
  vi.stubEnv('PAPERCUSP_OPERATOR_URL', OPERATOR_URL);
  vi.stubEnv('PAPERCUSP_MCP_PROXY', '0');
});
afterEach(() => vi.unstubAllEnvs());

const pluginHooks = papercuspClaudePluginHooks('/home/u/.papercusp/hooks/cc');
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

  for (const settings of [{}, { hooks: {} }]) {
    it(`repairs and reports an absent carrier: ${JSON.stringify(settings)}`, () => {
      const fs = fakeFs(settings, false);
      const repair = vi.fn();
      const log = vi.fn();
      const v = ensureClaudePluginRails(claudeEnv, { settingsPath: SETTINGS, readFile: fs.readFile, repair, log });
      expect(v?.problems).toContain('hook-missing: StopFailure:stop-failure-record.mjs');
      expect(repair).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledOnce();
    });
  }

  for (const missing of ['empty', 'StopFailure', 'PostToolUseFailure']) {
    it(`detects incomplete enabled plugin coverage: ${missing}`, () => {
      const fs = fakeFs({ ...enrollment(), hooks: {} });
      const hooks = missing === 'empty' ? {} : { ...pluginHooks };
      delete hooks[missing];
      fs.files[PLUGIN_HOOKS_PATH] = JSON.stringify({ hooks });
      const repair = vi.fn();
      const log = vi.fn();
      const v = ensureClaudePluginRails(claudeEnv, { settingsPath: SETTINGS, readFile: fs.readFile, repair, log });
      expect(v?.problems.some((p: string) => p.startsWith('hook-missing:'))).toBe(true);
      expect(repair).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledOnce();
    });
  }

  it('inspects and re-verifies the child copy even when the global carrier is healthy', () => {
    const child = '/isolated/session/settings.json';
    const fs = fakeFs({ ...enrollment(), hooks: {} });
    fs.files[child] = JSON.stringify({ ...enrollment(false), model: 'session-model' });
    const read = vi.fn(fs.readFile);
    const repair = vi.fn((path: string) => {
      expect(path).toBe(child);
      fs.files[path] = JSON.stringify({ ...enrollment(), model: 'session-model' });
    });
    const v = ensureClaudePluginRails({ ...claudeEnv, CLAUDE_CONFIG_DIR: '/isolated/session' },
      { readFile: read, repair, log: vi.fn() });
    expect(v?.problems).toEqual([]);
    expect(repair).toHaveBeenCalledOnce();
    expect(read.mock.calls.some(([path]) => path === SETTINGS)).toBe(false);
    expect(read.mock.calls.filter(([path]) => path === child)).toHaveLength(2);
  });

  it('the individual enrollment guard repairs the effective child file', () => {
    const child = '/isolated/session/settings.json';
    const fs = fakeFs({ ...enrollment(), hooks: {} });
    fs.files[child] = '{}';
    const repair = vi.fn((path: string) => { fs.files[path] = JSON.stringify(enrollment()); });
    const log = vi.fn();
    ensureCcHookEnrollment({ ...claudeEnv, CLAUDE_CONFIG_DIR: '/isolated/session' }, {
      event: 'PreToolUse', hookName: 'pretooluse-locks-acquire.sh', label: 'LOCKS', degradedNote: 'missing',
      readFile: fs.readFile, scriptExists: () => true, repair, log,
    });
    expect(repair.mock.calls[0]?.[0]).toBe(child);
    expect(log.mock.calls[0]?.[0]).toContain(`missing from ${child} — repaired`);
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

  it('the required contract is present in the maintained installer enrollment map', () => {
    for (const [event, scripts] of Object.entries(REQUIRED_CLAUDE_HOOKS)) {
      const commands = JSON.stringify(pluginHooks[event]);
      for (const script of scripts) expect(commands).toContain(script);
    }
  });

  it('repairs the materialized child with shared enrollment and stripping while preserving session and foreign settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'effective-claude-repair-'));
    try {
      const owner = join(dir, 'owner');
      const child = join(dir, 'child');
      const root = join(dir, 'marketplace');
      mkdirSync(owner); mkdirSync(child);
      mkdirSync(join(root, 'plugins/papercusp/hooks'), { recursive: true });
      writeFileSync(join(root, 'plugins/papercusp/hooks/hooks.json'), JSON.stringify({ hooks: pluginHooks }));
      const globalPath = join(owner, 'settings.json');
      const settingsPath = join(child, 'settings.json');
      const global = { ...enrollment(), extraKnownMarketplaces: {
        'papercusp-local': { source: { source: 'directory', path: root } },
      } };
      writeFileSync(globalPath, JSON.stringify(global));
      const foreign = { type: 'command', command: '/foreign/keep.sh' };
      writeFileSync(settingsPath, JSON.stringify({ ...enrollment(false), idleCompaction: false,
        model: 'session-model', disableAllHooks: true, enabledPlugins: { 'other@market': true },
        hooks: { PreToolUse: [{ hooks: [...pluginHooks.PreToolUse![0]!.hooks, foreign] }] },
      }));
      const before = readFileSync(globalPath, 'utf8');
      const install = vi.fn();
      repairCcHooksViaInstallRoute(settingsPath, {}, { globalPath, install });
      const repaired = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(install).toHaveBeenCalledOnce();
      expect(readFileSync(globalPath, 'utf8')).toBe(before);
      expect(repaired).toMatchObject({ idleCompaction: false, model: 'session-model', disableAllHooks: false,
        enabledPlugins: { 'other@market': true, 'papercusp@papercusp-local': true } });
      expect(repaired.hooks.PreToolUse).toEqual([{ hooks: [foreign] }]);
      expect(claudeHookCarrierVerdict({ settings: repaired,
        readFile: (p: string) => readFileSync(p, 'utf8') }).problems).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
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
    expect(banner).toContain(`Fix: curl -X POST ${OPERATOR_URL}/api/desktop/install/papercusp-files`);
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
    expect(v?.doubleEnrolled).toContain('PreToolUse:pretooluse-locks-acquire.sh');
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
