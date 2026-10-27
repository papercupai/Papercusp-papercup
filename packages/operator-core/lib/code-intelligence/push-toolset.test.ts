import { describe, expect, it, vi } from 'vitest';
import { callableSuggestion, calledTool, canCall, recordListedTools, toolsetFromNames, UNKNOWN_TOOLSET } from './push-toolset';

describe('recordListedTools — the tools/list hook never fails a listing (EI-27158841329142596)', () => {
  it('an unattributable caller (identity resolver throws) records nothing and does not throw', async () => {
    const remember = vi.fn(async () => true);
    const resolveOwner = () => { throw new Error('resolveAgentIdentity: context carries no power-user / superuser / principal identity'); };
    await expect(recordListedTools({ workspace: 'ws', resolveOwner, tools: ['testing:run'] }, remember)).resolves.toBe('unattributed');
    expect(remember).not.toHaveBeenCalled();
  });

  it('an empty owner records nothing', async () => {
    const remember = vi.fn(async () => true);
    await expect(recordListedTools({ workspace: 'ws', resolveOwner: () => '  ', tools: [] }, remember)).resolves.toBe('unattributed');
    expect(remember).not.toHaveBeenCalled();
  });

  it('an attributed caller records its listing under the resolved owner', async () => {
    const remember = vi.fn(async () => true);
    await expect(recordListedTools({ workspace: 'ws', resolveOwner: () => 'su-1', tools: ['testing:run'] }, remember)).resolves.toBe('recorded');
    expect(remember).toHaveBeenCalledWith({ workspace: 'ws', owner: 'su-1', tools: ['testing:run'] });
  });

  it('a failing writer is swallowed', async () => {
    const remember = vi.fn(async () => { throw new Error('pg down'); });
    await expect(recordListedTools({ workspace: 'ws', resolveOwner: () => 'su-1', tools: [] }, remember)).resolves.toBe('unchanged');
  });
});

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
