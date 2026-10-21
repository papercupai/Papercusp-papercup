/**
 * install-standalone-mcp.sh's half of P-004 (client-native-features-adoption-2026-10-21, D-012):
 * after the bash installer merges the papercusp hooks inline into ~/.claude/settings.json, make the
 * generated `papercusp` Claude plugin their carrier and strip the inline copies, exactly as the
 * desktop installer (installClaudeHooks) does. Without this step the bash installer would re-create
 * a double enrollment on every run: the plugin and the inline entries would both fire.
 *
 * Usage: tsx install-claude-plugin-cli.ts <settings.json> <installed hook dir> <marketplace root>
 * Exit 0 = plugin is the carrier; 1 = not installed (settings.json untouched, hooks stay inline);
 * 2 = usage error.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { CC_HOOK_FILES, papercuspClaudePluginHooks } from '../desktop-install/papercusp-files';
import { applyPapercuspClaudePluginCarrier } from './papercusp-claude-plugin';

async function installedHookNames(hookDir: string): Promise<Set<string>> {
  const present = new Set<string>();
  for (const name of CC_HOOK_FILES) {
    const stat = await fs.stat(path.join(hookDir, name)).catch(() => null);
    if (stat?.isFile()) present.add(name);
  }
  return present;
}

export async function runInstallClaudePluginCli(argv: string[]): Promise<number> {
  const [settingsPath, hookDir, root] = argv;
  if (!settingsPath || !hookDir || !root) {
    console.error('usage: install-claude-plugin-cli.ts <settings.json> <installed hook dir> <marketplace root>');
    return 2;
  }
  let cfg: Record<string, any>;
  try {
    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
    cfg = parsed;
  } catch (e) {
    console.error(`! papercusp Claude plugin not installed: cannot read ${settingsPath} (${(e as Error).message})`);
    return 1;
  }
  const result = await applyPapercuspClaudePluginCarrier({
    cfg,
    hooks: papercuspClaudePluginHooks(hookDir, await installedHookNames(hookDir)),
    root,
  });
  if (!result.ok) {
    console.error(`! papercusp Claude plugin not installed (${result.error}); hooks stay inline in ${settingsPath}`);
    return 1;
  }
  const tmp = `${settingsPath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, settingsPath);
  console.log(
    `✓ papercusp Claude plugin carries the hooks (${root}); removed ${result.removedInline} inline duplicate(s) from ${settingsPath}`,
  );
  return 0;
}

// Same direct-invocation test as stamp-installed-cc-hooks.ts (this package is ESM: no __filename).
const invokedDirectly = process.argv[1]?.endsWith('install-claude-plugin-cli.ts');
if (invokedDirectly) {
  runInstallClaudePluginCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`! papercusp Claude plugin install failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
