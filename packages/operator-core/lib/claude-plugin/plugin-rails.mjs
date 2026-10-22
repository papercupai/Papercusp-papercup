/**
 * Where a Claude session's papercusp hooks come from — pure verdicts shared by
 * the launcher (psu-launcher.mjs) and the plugin generator
 * (papercusp-claude-plugin.ts). client-native-features-adoption-2026-10-21 P-004,
 * decision D-012.
 *
 * The papercusp Claude hooks ship as one Claude Code plugin, `papercusp`, in a
 * directory marketplace `papercusp-local` (~/.papercusp/claude-plugins). It is
 * enrolled through settings.json alone:
 *
 *   extraKnownMarketplaces["papercusp-local"] = { source: { source: "directory", path } }
 *   enabledPlugins["papercusp@papercusp-local"] = true
 *
 * Measured on claude 2.1.293 (D-012): that enrollment loads the plugin on the
 * first launch with no `claude plugin install`; the plugin is read from its
 * source folder, not a cache copy; and one command enrolled both inline in
 * settings.json `hooks` and in the plugin fires TWICE. So a hook the plugin
 * carries must not also be enrolled inline, and a launch has to be able to tell
 * which of the two carriers is live.
 *
 * Every function here is pure apart from the injected `readFile`.
 */
import { join } from "node:path";

// Minimum managed-session contract. The installer tests this against its full
// enrollment map; optional advisory hooks do not weaken these safety rails.
export const REQUIRED_CLAUDE_HOOKS = {
  PreToolUse: ["pretooluse-locks-acquire.sh"],
  PostToolUse: ["posttooluse-locks-release.sh", "posttooluse-activity-report.sh"],
  SessionStart: ["lifecycle-report.sh"],
  SessionEnd: ["lifecycle-report.sh"],
  UserPromptSubmit: ["userpromptsubmit-memory.sh"],
  StopFailure: ["stop-failure-record.mjs"],
  PostToolUseFailure: ["posttooluse-failure-record.mjs"],
};

export const PAPERCUSP_CLAUDE_PLUGIN_NAME = "papercusp";
export const PAPERCUSP_CLAUDE_MARKETPLACE_NAME = "papercusp-local";
export const PAPERCUSP_CLAUDE_PLUGIN_ID = `${PAPERCUSP_CLAUDE_PLUGIN_NAME}@${PAPERCUSP_CLAUDE_MARKETPLACE_NAME}`;
/** Plugin directory, relative to the marketplace root. */
export const PAPERCUSP_CLAUDE_PLUGIN_SUBDIR = `plugins/${PAPERCUSP_CLAUDE_PLUGIN_NAME}`;
/** The plugin's hooks file, relative to the marketplace root. */
export const PAPERCUSP_CLAUDE_PLUGIN_HOOKS_RELPATH = `${PAPERCUSP_CLAUDE_PLUGIN_SUBDIR}/hooks/hooks.json`;

function parseObject(text) {
  if (typeof text !== "string") return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** The directory-marketplace root declared for `papercusp-local`, or null. */
export function papercuspMarketplaceRoot(cfg) {
  const source = asObject(cfg)?.extraKnownMarketplaces?.[PAPERCUSP_CLAUDE_MARKETPLACE_NAME]?.source;
  return source && source.source === "directory" && typeof source.path === "string" && source.path
    ? source.path
    : null;
}

/** `enabled` / `disabled` (explicit false) / `absent` for papercusp@papercusp-local. */
export function papercuspPluginEnabledState(cfg) {
  const value = asObject(cfg)?.enabledPlugins?.[PAPERCUSP_CLAUDE_PLUGIN_ID];
  if (value === true) return "enabled";
  if (value === false) return "disabled";
  return "absent";
}

/**
 * Script basenames a hook command runs: every whitespace token that contains a
 * `/`, quotes stripped, reduced to its last segment. Handles env-prefixed
 * commands (`PAPERCUSP_WORKSPACE_ROOT=… /…/pretooluse-locks-acquire.sh`).
 */
export function commandScriptNames(command) {
  const names = new Set();
  for (const raw of String(command ?? "").split(/\s+/)) {
    const token = raw.replace(/^['"]+|['"]+$/g, "");
    if (!token.includes("/")) continue;
    const base = token.slice(token.lastIndexOf("/") + 1);
    if (base) names.add(base);
  }
  return names;
}

/** Enroll the generated plugin, preserving other plugins and marketplaces. */
export function enrollPapercuspClaudePlugin(cfg, root) {
  for (const key of ["extraKnownMarketplaces", "enabledPlugins"]) {
    if (!asObject(cfg[key])) cfg[key] = {};
  }
  cfg.extraKnownMarketplaces[PAPERCUSP_CLAUDE_MARKETPLACE_NAME] = {
    source: { source: "directory", path: root },
  };
  cfg.enabledPlugins[PAPERCUSP_CLAUDE_PLUGIN_ID] = true;
  return cfg;
}

/** Strip only commands the plugin carries under the same event, preserving
 * foreign commands even when they share a group. Shared by install + preflight. */
export function stripPluginCarriedInlineHooks(cfg, pluginHooks) {
  const inline = asObject(cfg.hooks);
  if (!inline) return 0;
  let removed = 0;
  for (const event of Object.keys(pluginHooks)) {
    const carried = scriptNamesForEvent(pluginHooks, event);
    if (!carried.size || !Array.isArray(inline[event])) continue;
    const kept = [];
    for (const group of inline[event]) {
      if (!Array.isArray(group?.hooks)) { kept.push(group); continue; }
      const hooks = group.hooks.filter((hook) => {
        const ours = [...commandScriptNames(hook?.command)].some((name) => carried.has(name));
        if (ours) removed += 1;
        return !ours;
      });
      if (hooks.length) kept.push({ ...group, hooks });
    }
    if (kept.length) inline[event] = kept;
    else delete inline[event];
  }
  if (!Object.keys(inline).length) delete cfg.hooks;
  return removed;
}

/** Every hook command string registered under `event` in a hooks map. */
export function hookCommandsForEvent(hooks, event) {
  const groups = Array.isArray(asObject(hooks)?.[event]) ? hooks[event] : [];
  return groups
    .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
    .map((hook) => (hook?.type === "command" && typeof hook.command === "string" ? hook.command : ""))
    .filter(Boolean);
}

function scriptNamesForEvent(hooks, event) {
  const names = new Set();
  for (const command of hookCommandsForEvent(hooks, event)) {
    for (const name of commandScriptNames(command)) names.add(name);
  }
  return names;
}

/**
 * Which carrier delivers this settings document's papercusp hooks.
 *
 * `settings` is the settings.json text or an already-parsed object; `readFile`
 * returns a file's text or null. Returns:
 * - `carrier`: `plugin` (enabled plugin, no inline duplicate), `inline` (hooks
 *   only in settings.json), `double` (the same script enrolled inline AND by the
 *   enabled plugin under one event — it fires twice), or `none`;
 * - `pluginState`, `marketplaceRoot`, `pluginHooks` (the enabled plugin's hooks
 *   map, null when the plugin is not live);
 * - `doubleEnrolled`: `<event>:<script>` pairs enrolled twice;
 * - `problems`: every condition a launch should report.
 */
export function claudeHookCarrierVerdict({ settings, readFile } = {}) {
  const cfg = typeof settings === "string" ? parseObject(settings) : asObject(settings);
  if (!cfg) {
    return {
      carrier: "none",
      pluginState: "absent",
      marketplaceRoot: null,
      pluginHooks: null,
      doubleEnrolled: [],
      problems: ["settings.json missing or unparseable"],
    };
  }
  const pluginState = papercuspPluginEnabledState(cfg);
  const marketplaceRoot = papercuspMarketplaceRoot(cfg);
  const problems = [];
  let pluginHooks = null;

  if (marketplaceRoot) {
    const hooksPath = join(marketplaceRoot, PAPERCUSP_CLAUDE_PLUGIN_HOOKS_RELPATH);
    const doc = parseObject(typeof readFile === "function" ? readFile(hooksPath) : null);
    if (doc && asObject(doc.hooks)) pluginHooks = doc.hooks;
    else problems.push(`plugin-missing: ${hooksPath} is absent or unparseable`);
  } else if (pluginState !== "absent") {
    problems.push(
      `plugin-missing: enabledPlugins names ${PAPERCUSP_CLAUDE_PLUGIN_ID} but no directory marketplace ` +
        `"${PAPERCUSP_CLAUDE_MARKETPLACE_NAME}" is declared in extraKnownMarketplaces`,
    );
  }
  if (pluginState === "disabled") {
    problems.push(`plugin-disabled: enabledPlugins["${PAPERCUSP_CLAUDE_PLUGIN_ID}"] is false`);
  } else if (pluginState === "absent" && marketplaceRoot) {
    problems.push(
      `plugin-disabled: marketplace "${PAPERCUSP_CLAUDE_MARKETPLACE_NAME}" is declared but ` +
        `enabledPlugins does not enable ${PAPERCUSP_CLAUDE_PLUGIN_ID}`,
    );
  }

  const livePluginHooks = pluginState === "enabled" && pluginHooks ? pluginHooks : null;
  const inlineHooks = asObject(cfg.hooks) ?? {};
  if (cfg.disableAllHooks === true) problems.push("hooks-disabled: disableAllHooks is true");
  for (const [event, required] of Object.entries(REQUIRED_CLAUDE_HOOKS)) {
    const names = scriptNamesForEvent(livePluginHooks ?? inlineHooks, event);
    for (const name of required) {
      if (!names.has(name)) problems.push(`hook-missing: ${event}:${name}`);
    }
    // Failure hooks must cover every error/tool, as the enrollment source does.
    if (event === "StopFailure" || event === "PostToolUseFailure") {
      const entries = (livePluginHooks ?? inlineHooks)[event];
      const groups = Array.isArray(entries) ? entries : [];
      for (const name of required) {
        if (names.has(name) && !groups.some((g) => !g.matcher &&
          (g.hooks ?? []).some((h) => h.type === "command" && commandScriptNames(h.command).has(name)))) {
          problems.push(`hook-incomplete: ${event}:${name} must have no matcher`);
        }
      }
    }
  }
  const doubleEnrolled = [];
  if (livePluginHooks) {
    for (const event of Object.keys(livePluginHooks).sort()) {
      const inlineNames = scriptNamesForEvent(inlineHooks, event);
      for (const name of [...scriptNamesForEvent(livePluginHooks, event)].sort()) {
        if (inlineNames.has(name)) doubleEnrolled.push(`${event}:${name}`);
      }
    }
  }
  if (doubleEnrolled.length > 0) {
    problems.push(
      `double-enrollment: ${doubleEnrolled.length} hook(s) enrolled both inline in settings.json and by ` +
        `${PAPERCUSP_CLAUDE_PLUGIN_ID} (each fires twice): ${doubleEnrolled.join(", ")}`,
    );
  }
  const hasInline = Object.keys(inlineHooks).some((event) => hookCommandsForEvent(inlineHooks, event).length > 0);
  if (!livePluginHooks && pluginState === "absent" && !marketplaceRoot && hasInline) {
    problems.push(
      `plugin-not-installed: hooks are carried inline in settings.json; ${PAPERCUSP_CLAUDE_PLUGIN_ID} is not enrolled`,
    );
  }

  const carrier = livePluginHooks
    ? doubleEnrolled.length > 0
      ? "double"
      : "plugin"
    : hasInline
      ? "inline"
      : "none";
  return { carrier, pluginState, marketplaceRoot, pluginHooks: livePluginHooks, doubleEnrolled, problems };
}

/**
 * Every command `event` will run in a session with these settings: the inline
 * entries plus the enabled papercusp plugin's entries.
 */
export function effectiveClaudeHookCommands({ settings, readFile } = {}, event) {
  const cfg = typeof settings === "string" ? parseObject(settings) : asObject(settings);
  if (!cfg) return [];
  const { pluginHooks } = claudeHookCarrierVerdict({ settings: cfg, readFile });
  return [...hookCommandsForEvent(cfg.hooks, event), ...hookCommandsForEvent(pluginHooks, event)];
}
