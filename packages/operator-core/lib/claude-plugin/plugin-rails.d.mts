/** Types for plugin-rails.mjs (client-native-features-adoption-2026-10-21 P-004, D-012). */

export declare const PAPERCUSP_CLAUDE_PLUGIN_NAME: 'papercusp';
export declare const PAPERCUSP_CLAUDE_MARKETPLACE_NAME: 'papercusp-local';
export declare const PAPERCUSP_CLAUDE_PLUGIN_ID: 'papercusp@papercusp-local';
export declare const PAPERCUSP_CLAUDE_PLUGIN_SUBDIR: string;
export declare const PAPERCUSP_CLAUDE_PLUGIN_HOOKS_RELPATH: string;
export declare const REQUIRED_CLAUDE_HOOKS: Record<string, string[]>;

export type ClaudeHookCommand = { type: 'command'; command: string; timeout?: number };
export type ClaudeHookGroup = { matcher?: string; hooks: ClaudeHookCommand[] };
export type ClaudeHookMap = Record<string, ClaudeHookGroup[]>;

export type PapercuspPluginEnabledState = 'enabled' | 'disabled' | 'absent';
export type ClaudeHookCarrier = 'plugin' | 'inline' | 'double' | 'none';

export interface ClaudeHookCarrierInput {
  /** settings.json text, or an already-parsed settings object. */
  settings?: string | Record<string, unknown> | null;
  /** Returns a file's text, or null when it cannot be read. */
  readFile?: (path: string) => string | null;
}

export interface ClaudeHookCarrierVerdict {
  carrier: ClaudeHookCarrier;
  pluginState: PapercuspPluginEnabledState;
  marketplaceRoot: string | null;
  /** The enabled plugin's hooks map; null when the plugin is not live. */
  pluginHooks: ClaudeHookMap | null;
  /** `<event>:<script>` pairs enrolled both inline and by the plugin. */
  doubleEnrolled: string[];
  problems: string[];
}

export declare function papercuspMarketplaceRoot(cfg: unknown): string | null;
export declare function papercuspPluginEnabledState(cfg: unknown): PapercuspPluginEnabledState;
export declare function commandScriptNames(command: unknown): Set<string>;
export declare function enrollPapercuspClaudePlugin(cfg: Record<string, any>, root: string): Record<string, any>;
export declare function stripPluginCarriedInlineHooks(cfg: Record<string, any>, pluginHooks: ClaudeHookMap): number;
export declare function hookCommandsForEvent(hooks: unknown, event: string): string[];
export declare function claudeHookCarrierVerdict(input?: ClaudeHookCarrierInput): ClaudeHookCarrierVerdict;
export declare function effectiveClaudeHookCommands(input: ClaudeHookCarrierInput, event: string): string[];
