/**
 * Step A (Tier-1 follow-up arc): mem0 dual-scope memory injection in
 * composeOraclePrompt.
 *
 * Verifies the memory block lands when buildMemoryContextBlock returns
 * a non-null string, AND that graceful degradation works (empty hits,
 * client throw → unchanged prompt).
 *
 * MOCK SHAPE (2026-06-06 de-flake): the old per-test `vi.resetModules()` +
 * `vi.doMock` + fresh `import('./prompts')` re-paid the heavy cold-ESM
 * import of prompts.ts's dependency graph (agent-mcp, memory/injection,
 * system-principal, agents-list) on EVERY test — under box load each
 * re-import could exceed the test timeout, making all five tests flake
 * together at exactly the ceiling (seen 2026-06-05/06 gating
 * test:affected). Now the deps are mocked ONCE with hoisted `vi.mock` +
 * swappable mock fns, the module graph loads once, and per-test behavior
 * is set via `mockResolvedValue`/`mockRejectedValue`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const buildMemoryContextBlockMock = vi.fn<(opts: unknown) => Promise<string | null>>();
const { loadPersonaMock } = vi.hoisted(() => ({ loadPersonaMock: vi.fn<() => string>() }));

// This suite owns memory placement, not the independently-covered tool catalog.
// Keep the real playbook reader while simulating pruned persona assets and isolating catalog registration
// from the deliberately narrow dependency graph below.
vi.mock('../../prompt-assembly', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../prompt-assembly')>()),
  loadRolePersona: loadPersonaMock,
  renderToolsCatalog: vi.fn(() => ''),
}));

vi.mock('../../operator-state-pg', () => ({
  readOperatorState: vi.fn(async (key: string) => {
    if (key === 'operator_oracle_prompt') return { content: 'You are the Oracle.' };
    if (key === 'operator_oracle_memory') return { content: '' };
    return null;
  }),
  writeOperatorState: vi.fn(),
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => 'default',
}));
vi.mock('../../system-principal', () => ({
  readSystemPrincipal: vi.fn(async () => null),
}));
vi.mock('../../agents-list', () => ({
  listAgentsAcrossWorkspace: vi.fn(async () => []),
}));
vi.mock('../../memory/injection', () => ({
  buildMemoryContextBlock: (opts: unknown) => buildMemoryContextBlockMock(opts),
}));

import { composeOraclePrompt, readOracleConfig } from './prompts';
import { readOperatorState, writeOperatorState } from '../../operator-state-pg';
import { RolePromptUnavailableError } from '../../prompt-assembly';
const personaCallsDuringImport = loadPersonaMock.mock.calls.length;

beforeEach(() => {
  loadPersonaMock.mockClear();
  loadPersonaMock.mockImplementation(() => { throw new RolePromptUnavailableError('oracle', 'persona'); });
  vi.mocked(readOperatorState).mockImplementation(async (key: string) => {
    if (key === 'operator_oracle_prompt') return { content: 'You are the Oracle.' };
    if (key === 'operator_oracle_memory') return { content: '' };
    return null;
  });
  vi.mocked(writeOperatorState).mockClear();
  buildMemoryContextBlockMock.mockReset();
  buildMemoryContextBlockMock.mockResolvedValue(null);
});

describe('runtime-only Oracle boot asset closure', () => {
  it('imports the registry module without reading missing persona assets', () => {
    expect(personaCallsDuringImport).toBe(0);
  });
  it('uses persisted configuration without consulting the pruned default persona', async () => {
    expect((await readOracleConfig()).prompt).toBe('You are the Oracle.');
    expect(loadPersonaMock).not.toHaveBeenCalled();
    expect(writeOperatorState).not.toHaveBeenCalled();
  });
  it('fails explicitly only when an unconfigured Oracle actually needs the missing persona', async () => {
    vi.mocked(readOperatorState).mockResolvedValue(null);
    await expect(readOracleConfig()).rejects.toMatchObject({ code: 'ROLE_PROMPT_UNAVAILABLE', role: 'oracle', document: 'persona' });
    expect(loadPersonaMock).toHaveBeenCalledWith('oracle');
    expect(writeOperatorState).not.toHaveBeenCalled();
  });
  it('enables the default after content is installed, without a negative config cache', async () => {
    const state = new Map<string, { content: string }>();
    vi.mocked(readOperatorState).mockImplementation(async (key: string) => state.get(key) ?? null);
    vi.mocked(writeOperatorState).mockImplementation(async (key, value) => { state.set(key, value as { content: string }); });
    await expect(readOracleConfig()).rejects.toBeInstanceOf(RolePromptUnavailableError);
    loadPersonaMock.mockReturnValue('SYNTHETIC INSTALLED ORACLE');
    expect((await readOracleConfig()).prompt).toBe('SYNTHETIC INSTALLED ORACLE');
    expect(writeOperatorState).toHaveBeenCalledWith('operator_oracle_prompt', { content: 'SYNTHETIC INSTALLED ORACLE' });
  });
});

describe('composeOraclePrompt — memory injection', () => {
  it('includes the memory heading + body when buildMemoryContextBlock returns a block', async () => {
    buildMemoryContextBlockMock.mockResolvedValue(
      '## Oracle memory (relevant entries)\n\n- [preference] User prefers dark mode\n- [preference [shared]] Operator favors terse replies',
    );
    const { promptText } = await composeOraclePrompt(
      [{ role: 'user', content: 'switch to light mode?' }],
      { currentPath: '/', tutorialMode: false, userId: 'user-abc' },
    );
    expect(promptText).toContain('## Oracle memory (relevant entries)');
    expect(promptText).toContain('User prefers dark mode');
    expect(promptText).toContain('Operator favors terse replies');
  });

  it('omits the memory section when buildMemoryContextBlock returns null', async () => {
    const { promptText } = await composeOraclePrompt(
      [{ role: 'user', content: 'hi' }],
      { currentPath: '/', tutorialMode: false, userId: 'user-abc' },
    );
    expect(promptText).not.toContain('Oracle memory (relevant entries)');
    // Verify no orphan separators are emitted — the prompt should not have
    // back-to-back '---' separators where the memory block would have been.
    expect(promptText).not.toMatch(/---\s*\n\s*\n---/);
  });

  it('degrades silently when buildMemoryContextBlock throws', async () => {
    buildMemoryContextBlockMock.mockRejectedValue(new Error('mem0 connection refused'));
    // Must not throw — the .catch(() => null) wrapper absorbs the error.
    const { promptText } = await composeOraclePrompt(
      [{ role: 'user', content: 'hi' }],
      { currentPath: '/', tutorialMode: false, userId: 'user-abc' },
    );
    expect(promptText).not.toContain('Oracle memory');
  });

  it('passes the userId through to buildMemoryContextBlock', async () => {
    await composeOraclePrompt(
      [{ role: 'user', content: 'q' }],
      { currentPath: '/', tutorialMode: false, userId: 'user-xyz' },
    );
    expect(buildMemoryContextBlockMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-xyz',
        workspaceId: 'default',
        queryContext: 'q',
        heading: 'Oracle memory (relevant entries)',
      }),
    );
  });

  it('passes userId=null when caller omits userId (workspace-shared only)', async () => {
    await composeOraclePrompt(
      [{ role: 'user', content: 'q' }],
      { currentPath: '/', tutorialMode: false },
    );
    expect(buildMemoryContextBlockMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: null }),
    );
  });
});
