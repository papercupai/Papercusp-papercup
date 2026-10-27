import { describe, expect, it } from 'vitest';
import { callableSuggestion, calledTool, canCall, toolsetFromNames, UNKNOWN_TOOLSET } from './push-toolset';

describe('recipient toolset (P-006, SPEC-P-006-B)', () => {
  it('matches listed names in MCP, underscore and colon spellings', () => {
    const toolset = toolsetFromNames(['mcp__papercusp-su__testing_run', 'facts:list', 'TOOLS_INVOKE']);
    expect(canCall(toolset, 'testing:run')).toBe(true);
    expect(canCall(toolset, 'facts:list')).toBe(true);
    expect(canCall(toolset, 'tools:invoke')).toBe(true);
  });

  it('a partial listing names only the listed tools', () => {
    const toolset = toolsetFromNames(['testing:run']);
    expect(callableSuggestion('testing:run {"files":["a.test.ts"]}', toolset)).toBe('testing:run {"files":["a.test.ts"]}');
    expect(callableSuggestion('code:pack {"op":"pack","include":["a.ts"]}', toolset)).toBeUndefined();
  });

  it('an empty listing names no tool', () => {
    const toolset = toolsetFromNames([]);
    expect(toolset.status).toBe('measured');
    expect(callableSuggestion('testing:run {}', toolset)).toBeUndefined();
  });

  it('an unknown (unreadable) toolset names no tool', () => {
    expect(callableSuggestion('testing:run {}', UNKNOWN_TOOLSET)).toBeUndefined();
    expect(callableSuggestion('facts:list {}', { status: 'unknown', reason: 'read-failed' })).toBeUndefined();
  });

  it('reads the called tool from the first token only', () => {
    expect(calledTool('  graph:query {"op":"sql-lineage"}')).toBe('graph:query');
    expect(callableSuggestion(undefined, toolsetFromNames(['graph:query']))).toBeUndefined();
  });
});
