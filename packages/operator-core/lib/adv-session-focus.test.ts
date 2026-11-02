import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { AdvSessionRow } from './adv-sessions';
import { focusSessionWindow, resolveSessionWindowId } from './adv-session-focus';

const GUI_FOCUS_ROUTE_SOURCE = readFileSync(
  new URL('./endpoint-route/routes/adv/sessions.ts', import.meta.url),
  'utf8',
);
const AGENT_FOCUS_TOOL_SOURCE = readFileSync(
  new URL('./agent-tools/coordination/tools/focus-window.ts', import.meta.url),
  'utf8',
);

function row(overrides: Partial<AdvSessionRow> = {}): AdvSessionRow {
  return {
    id: 42,
    workspaceId: 'papercusp-workspace',
    planSlug: null,
    agent: 'codex',
    role: null,
    feature: null,
    mode: 'console',
    terminalBin: null,
    pid: null,
    windowId: null,
    ompThreadId: null,
    label: null,
    cwd: null,
    coordOwnerId: 'su-8ee55568-a37b-4b6b-84f3-e02e11c10d86',
    sessionId: '01a09697-7bd2-78f1-9e1b-f8592b50a23c',
    display: null,
    launchArgv: null,
    launchedAt: null,
    startedAt: '2026-09-12T23:18:15.000Z',
    endedAt: null,
    exitCode: null,
    endedBy: null,
    endedSignal: null,
    ...overrides,
  };
}

describe('shared adv-session focus service', () => {
  it('keeps both GUI and agent entry points on this one focus implementation', () => {
    expect(GUI_FOCUS_ROUTE_SOURCE).toMatch(
      /import\s*\{[^}]*\bfocusSessionWindow\b[^}]*\}\s*from\s*['"]\.\.\/\.\.\/\.\.\/adv-session-focus['"]/,
    );
    expect(GUI_FOCUS_ROUTE_SOURCE).toMatch(/await focusSessionWindow\(body,\s*latestRow\)/);
    expect(GUI_FOCUS_ROUTE_SOURCE.match(/\bfocusSessionWindow\b/g)).toHaveLength(2);

    expect(AGENT_FOCUS_TOOL_SOURCE).toMatch(
      /import\s*\{[^}]*\bfocusSessionWindow\b[^}]*\}\s*from\s*['"]\.\.\/\.\.\/\.\.\/adv-session-focus['"]/,
    );
    expect(AGENT_FOCUS_TOOL_SOURCE).toMatch(
      /await focusSessionWindow\(\{\s*id:\s*row\.id,\s*workspace:\s*args\.workspace\s*\},\s*row\)/,
    );
    expect(AGENT_FOCUS_TOOL_SOURCE.match(/\bfocusSessionWindow\b/g)).toHaveLength(2);
  });

  it('uses the explicit window id and reports observed focus success', async () => {
    const focus = vi.fn(async () => true);
    await expect(focusSessionWindow({ windowId: '0xabc' }, null, { focus })).resolves.toEqual({
      focused: true,
      windowId: '0xabc',
    });
    expect(focus).toHaveBeenCalledWith('0xabc', { workspace: undefined });
  });

  it('passes the same workspace option from GUI and agent callers to the shared backend', async () => {
    const focus = vi.fn(async () => true);
    await focusSessionWindow({ windowId: '0xabc', workspace: 'window' }, null, { focus });
    expect(focus).toHaveBeenCalledWith('0xabc', { workspace: 'window' });
  });

  it('resolves a psu window by owner-title fallback and remembers the hit', async () => {
    const resolveByTitle = vi
      .fn<(fragment: string) => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('0x01e70b14');
    const rememberWindowId = vi.fn(async () => {});

    await expect(
      resolveSessionWindowId({}, row(), { resolveByTitle, rememberWindowId }),
    ).resolves.toBe('0x01e70b14');
    expect(resolveByTitle.mock.calls).toEqual([['[adv:42]'], [row().sessionId], ['su-8ee55']]);
    expect(rememberWindowId).toHaveBeenCalledWith(42, '0x01e70b14');
  });

  it('resolves a restored window by its native session UUID before the owner-title fallback', async () => {
    const sessionId = row().sessionId!;
    const resolveByTitle = vi
      .fn<(fragment: string) => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('0x01e70b14');
    const rememberWindowId = vi.fn(async () => {});

    await expect(
      resolveSessionWindowId({}, row(), { resolveByTitle, rememberWindowId }),
    ).resolves.toBe('0x01e70b14');
    expect(resolveByTitle.mock.calls).toEqual([['[adv:42]'], [sessionId]]);
    expect(rememberWindowId).toHaveBeenCalledWith(42, '0x01e70b14');
  });

  it('returns a typed no_window result when nothing resolves', async () => {
    const resolveByTitle = vi.fn(async () => null);
    const result = await focusSessionWindow({}, row(), { resolveByTitle });
    expect(result).toMatchObject({ focused: false, code: 'no_window', windowId: null });
  });

  it('does not call an exit-zero activation success when the desktop observation is false', async () => {
    const result = await focusSessionWindow(
      { windowId: '0xabc' },
      row(),
      { focus: vi.fn(async () => false) },
    );
    expect(result).toMatchObject({ focused: false, code: 'focus_failed', windowId: '0xabc' });
    expect(result.focused || result.reason).toBeTruthy();
  });
});
