/**
 * client-native-features-adoption-2026-10-21 P-004 (R-4, decision D-012): the papercusp Claude
 * plugin is generated from the hook-enrollment source, a drift check fails when the two diverge,
 * no hook is enrolled twice, and a launch whose plugin rails are missing or disabled is detected.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CC_HOOK_FILES, mergeClaudeHookSettings, papercuspClaudePluginHooks } from '../desktop-install/papercusp-files';
import {
  PAPERCUSP_CLAUDE_MARKETPLACE_NAME,
  PAPERCUSP_CLAUDE_PLUGIN_HOOKS_RELPATH,
  PAPERCUSP_CLAUDE_PLUGIN_ID,
  applyPapercuspClaudePluginCarrier,
  buildPapercuspClaudePlugin,
  detectPapercuspClaudePluginDrift,
  papercuspClaudePluginRoot,
  writePapercuspClaudePlugin,
  type ClaudeHookMap,
} from './papercusp-claude-plugin';
import { claudeHookCarrierVerdict, commandScriptNames, effectiveClaudeHookCommands } from './plugin-rails.mjs';

const HOOK_DIR = '/home/u/.papercusp/hooks/cc';
const LOCK_HOOK = 'pretooluse-locks-acquire.sh';
const readText = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

const tmpDirs: string[] = [];
async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'papercusp-claude-plugin-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function allCommands(hooks: ClaudeHookMap): Array<[string, string]> {
  return Object.entries(hooks).flatMap(([event, groups]) =>
    groups.flatMap((g) => g.hooks.map((h) => [event, h.command] as [string, string])),
  );
}

/** A settings object as the installer leaves it: inline merge, then the plugin carrier. */
async function installedSettings(root: string, seed: Record<string, any> = {}) {
  const cfg = JSON.parse(JSON.stringify(seed));
  mergeClaudeHookSettings(cfg, HOOK_DIR, { isClaudeSettings: true });
  const result = await applyPapercuspClaudePluginCarrier({ cfg, hooks: papercuspClaudePluginHooks(HOOK_DIR), root });
  return { cfg, result };
}

describe('the plugin is generated from the hook-enrollment source', () => {
  it('carries exactly the hooks mergeClaudeHookSettings enrolls, including the file-lock rail', () => {
    const source = mergeClaudeHookSettings({}, HOOK_DIR, {}).hooks;
    const plugin = buildPapercuspClaudePlugin(papercuspClaudePluginHooks(HOOK_DIR));
    expect(plugin.hooks).toEqual(source);
    expect(JSON.parse(plugin.files[PAPERCUSP_CLAUDE_PLUGIN_HOOKS_RELPATH])).toEqual({ hooks: source });
    expect(allCommands(plugin.hooks)).toContainEqual(['PreToolUse', `${HOOK_DIR}/${LOCK_HOOK}`]);
  });

  it('follows the installed-script set, like the inline enrollment does', () => {
    const present = new Set(CC_HOOK_FILES.filter((f) => f !== 'posttooluse-activity-report.sh'));
    const hooks = papercuspClaudePluginHooks(HOOK_DIR, present);
    expect(hooks).toEqual(mergeClaudeHookSettings({}, HOOK_DIR, { present }).hooks);
    expect(allCommands(hooks).some(([, c]) => c.endsWith('posttooluse-activity-report.sh'))).toBe(false);
  });

  it('writes a marketplace and manifest Claude accepts', () => {
    const plugin = buildPapercuspClaudePlugin(papercuspClaudePluginHooks(HOOK_DIR));
    const marketplace = JSON.parse(plugin.files['.claude-plugin/marketplace.json']);
    expect(marketplace.name).toBe(PAPERCUSP_CLAUDE_MARKETPLACE_NAME);
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: 'papercusp', source: './plugins/papercusp' })]);
    const manifest = JSON.parse(plugin.files['plugins/papercusp/.claude-plugin/plugin.json']);
    expect(manifest).toEqual(expect.objectContaining({ name: 'papercusp', version: expect.any(String) }));
    expect(`${manifest.name}@${marketplace.name}`).toBe(PAPERCUSP_CLAUDE_PLUGIN_ID);
  });

  it('places the marketplace under ~/.papercusp/claude-plugins', () => {
    expect(papercuspClaudePluginRoot('/home/u')).toBe('/home/u/.papercusp/claude-plugins');
  });
});

describe('drift check', () => {
  it('reports in-sync, then drift when the enrollment source changes, then missing', async () => {
    const root = await tmpRoot();
    const plugin = buildPapercuspClaudePlugin(papercuspClaudePluginHooks(HOOK_DIR));
    expect((await detectPapercuspClaudePluginDrift(root, plugin)).status).toBe('missing');
    await writePapercuspClaudePlugin(root, plugin);
    expect(await detectPapercuspClaudePluginDrift(root, plugin)).toEqual({ status: 'in-sync', files: [] });

    // The source now enrolls one fewer hook: the installed plugin no longer matches it.
    const present = new Set(CC_HOOK_FILES.filter((f) => f !== 'posttooluse-activity-report.sh'));
    const changed = buildPapercuspClaudePlugin(papercuspClaudePluginHooks(HOOK_DIR, present));
    expect(await detectPapercuspClaudePluginDrift(root, changed)).toEqual({
      status: 'drift',
      files: [PAPERCUSP_CLAUDE_PLUGIN_HOOKS_RELPATH],
    });

    // A hand edit of the installed hooks.json is drift too.
    await writeFile(path.join(root, PAPERCUSP_CLAUDE_PLUGIN_HOOKS_RELPATH), '{"hooks":{}}\n');
    expect((await detectPapercuspClaudePluginDrift(root, plugin)).status).toBe('drift');
  });
});

describe('no hook is enrolled twice', () => {
  it('strips every inline copy the plugin carries, keeping foreign commands and the inline-only keys', async () => {
    const root = await tmpRoot();
    const foreign = { type: 'command', command: 'rtk hook claude' };
    const { cfg, result } = await installedSettings(root, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [foreign, { type: 'command', command: `PAPERCUSP_WORKSPACE_ROOT=/w ${HOOK_DIR}/pretooluse-bash-resource-gate.sh` }],
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.removedInline).toBeGreaterThan(0);

    const verdict = claudeHookCarrierVerdict({ settings: cfg, readFile: readText });
    expect(verdict).toEqual(expect.objectContaining({ carrier: 'plugin', pluginState: 'enabled', doubleEnrolled: [], problems: [] }));
    expect(cfg.enabledPlugins[PAPERCUSP_CLAUDE_PLUGIN_ID]).toBe(true);
    expect(cfg.extraKnownMarketplaces[PAPERCUSP_CLAUDE_MARKETPLACE_NAME]).toEqual({ source: { source: 'directory', path: root } });
    expect(cfg.hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [foreign] }]);
    expect(cfg.statusLine).toEqual(expect.objectContaining({ type: 'command' }));
    expect(cfg.enableAllProjectMcpServers).toBe(true);

    // Every enrolled command reaches the session exactly once.
    for (const [event, command] of allCommands(papercuspClaudePluginHooks(HOOK_DIR))) {
      const effective = effectiveClaudeHookCommands({ settings: cfg, readFile: readText }, event);
      expect(effective.filter((c) => c === command), `${event} ${command}`).toHaveLength(1);
    }
  });

  it('stays single when the installer runs again', async () => {
    const root = await tmpRoot();
    const { cfg } = await installedSettings(root);
    const again = await installedSettings(root, cfg);
    expect(again.result.ok).toBe(true);
    expect(claudeHookCarrierVerdict({ settings: again.cfg, readFile: readText }).carrier).toBe('plugin');
    expect(again.cfg).toEqual(cfg);
  });

  it('keeps the inline enrollment when the plugin cannot be written', async () => {
    const dir = await tmpRoot();
    const blocker = path.join(dir, 'a-file');
    await writeFile(blocker, 'x');
    const cfg: Record<string, any> = {};
    mergeClaudeHookSettings(cfg, HOOK_DIR, { isClaudeSettings: true });
    const before = JSON.parse(JSON.stringify(cfg));
    const result = await applyPapercuspClaudePluginCarrier({
      cfg,
      hooks: papercuspClaudePluginHooks(HOOK_DIR),
      root: path.join(blocker, 'claude-plugins'),
    });
    expect(result.ok).toBe(false);
    expect(cfg).toEqual(before);
    expect(claudeHookCarrierVerdict({ settings: cfg, readFile: readText }).carrier).toBe('inline');
  });
});

describe('launch-time detection of missing or disabled plugin rails', () => {
  it('reports a disabled plugin', async () => {
    const root = await tmpRoot();
    const { cfg } = await installedSettings(root);
    cfg.enabledPlugins[PAPERCUSP_CLAUDE_PLUGIN_ID] = false;
    const verdict = claudeHookCarrierVerdict({ settings: JSON.stringify(cfg), readFile: readText });
    expect(verdict.pluginState).toBe('disabled');
    expect(verdict.carrier).toBe('none');
    expect(verdict.problems.join('\n')).toMatch(/^plugin-disabled:/m);
    expect(effectiveClaudeHookCommands({ settings: cfg, readFile: readText }, 'PreToolUse')).not.toContain(
      `${HOOK_DIR}/${LOCK_HOOK}`,
    );
  });

  it('reports a declared marketplace whose plugin is not enabled', async () => {
    const root = await tmpRoot();
    const { cfg } = await installedSettings(root);
    delete cfg.enabledPlugins[PAPERCUSP_CLAUDE_PLUGIN_ID];
    const verdict = claudeHookCarrierVerdict({ settings: cfg, readFile: readText });
    expect(verdict.carrier).toBe('none');
    expect(verdict.problems.join('\n')).toMatch(/^plugin-disabled:/m);
  });

  it('reports a missing plugin folder', async () => {
    const root = await tmpRoot();
    const { cfg } = await installedSettings(root);
    await rm(root, { recursive: true, force: true });
    const verdict = claudeHookCarrierVerdict({ settings: cfg, readFile: readText });
    expect(verdict.carrier).toBe('none');
    expect(verdict.problems.join('\n')).toMatch(/^plugin-missing:/m);
  });

  it('reports a plugin enabled with no marketplace declared', () => {
    const verdict = claudeHookCarrierVerdict({
      settings: { enabledPlugins: { [PAPERCUSP_CLAUDE_PLUGIN_ID]: true } },
      readFile: readText,
    });
    expect(verdict.problems.join('\n')).toMatch(/^plugin-missing:/m);
  });

  it('reports a double enrollment when inline hooks come back beside the plugin', async () => {
    const root = await tmpRoot();
    const { cfg } = await installedSettings(root);
    mergeClaudeHookSettings(cfg, HOOK_DIR, { isClaudeSettings: true }); // e.g. an old installer re-merges
    const verdict = claudeHookCarrierVerdict({ settings: cfg, readFile: readText });
    expect(verdict.carrier).toBe('double');
    expect(verdict.doubleEnrolled).toContain(`PreToolUse:${LOCK_HOOK}`);
    expect(verdict.problems.join('\n')).toMatch(/^double-enrollment:/m);
  });

  it('reports hooks still carried inline with no plugin enrolled', () => {
    const cfg: Record<string, any> = {};
    mergeClaudeHookSettings(cfg, HOOK_DIR, { isClaudeSettings: true });
    const verdict = claudeHookCarrierVerdict({ settings: cfg, readFile: readText });
    expect(verdict.carrier).toBe('inline');
    expect(verdict.problems.join('\n')).toMatch(/^plugin-not-installed:/m);
    expect(effectiveClaudeHookCommands({ settings: cfg, readFile: readText }, 'PreToolUse')).toContain(
      `${HOOK_DIR}/${LOCK_HOOK}`,
    );
  });

  it('reports unparseable settings', () => {
    expect(claudeHookCarrierVerdict({ settings: '{not json', readFile: readText }).problems).toEqual([
      'settings.json missing or unparseable',
    ]);
  });
});

describe('commandScriptNames', () => {
  it('reads script basenames through env prefixes and quotes', () => {
    expect([...commandScriptNames('A=1 B=2 /x/y/pretooluse-locks-acquire.sh --flag')]).toEqual(['pretooluse-locks-acquire.sh']);
    expect([...commandScriptNames('"/usr/bin/node" "/h/.papercusp/hooks/cc/stop-failure-record.mjs"')]).toEqual([
      'node',
      'stop-failure-record.mjs',
    ]);
    expect([...commandScriptNames('rtk hook claude')]).toEqual([]);
  });
});
