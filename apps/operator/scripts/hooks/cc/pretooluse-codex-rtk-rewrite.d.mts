export declare const CODEX_SHELL_TOOL: string;

export declare const CODEX_RTK_MATCHER: string;

export declare const CODEX_RTK_REASON: string;

export declare const CODEX_CODE_MODE_CALL_PREFIX: string;

export declare function isCodeModeNestedCall(toolUseId: unknown): boolean;

export declare function decideCodexRtk(params: {
  toolName: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  rtk?: (command: string) => string | null;
}): {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow';
    permissionDecisionReason: string;
    updatedInput: Record<string, unknown>;
  };
} | null;
