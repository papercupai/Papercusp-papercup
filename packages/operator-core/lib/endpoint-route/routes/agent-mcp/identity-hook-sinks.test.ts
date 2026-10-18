/**
 * identity-hook-sinks.test.ts — the three identity hook ports
 * (portable-identity-packages-2026-09-26 P-011; D-023 §3, D-024 §3).
 *
 * What each port must never do is the load-bearing part: the guard must fail
 * OPEN when the applied artifact is unreadable (closing there denies every tool
 * call fleet-wide) while a guard that cannot evaluate still refuses by name; the
 * context ports must answer inside their wall even when the wearer read hangs.
 * The guard predicate is the real `evaluatePreToolGuards`; only the reads are seams.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  evaluateHookContextSinkMock, readAppliedWornRulesMock, turnsExistMock, turnEndHeldWorkMock, turnReadMock, turnChargeMock,
} = vi.hoisted(() => ({
  evaluateHookContextSinkMock: vi.fn(),
  readAppliedWornRulesMock: vi.fn(),
  turnsExistMock: vi.fn(),
  turnEndHeldWorkMock: vi.fn(),
  turnReadMock: vi.fn(),
  turnChargeMock: vi.fn(),
}));

// The stop port's second leg (WI-6554700010015550) reads modes/claims/awaits from PG; keep it a seam.
vi.mock('../../../events/await/turn-end-held-work-guard', () => ({
  evaluateTurnEndHeldWorkStop: turnEndHeldWorkMock,
}));

vi.mock('../../../agent-identities/sync-hook-rules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../agent-identities/sync-hook-rules')>()),
  evaluateHookContextSink: evaluateHookContextSinkMock,
  readAppliedWornRules: readAppliedWornRulesMock,
  pgHookTurnStore: () => ({ exists: turnsExistMock, begin: turnReadMock, current: turnReadMock, charge: turnChargeMock }),
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-active' }));

import { wornSyncRules, type WornSyncRules } from '../../../agent-identities/sync-hook-rules';
import routes, { compactionSinkDue, guardRefusalText, toolGuardText } from './identity-hook-sinks';

type Route = { path: string; handler: (req: Request) => Promise<Response> };
const route = (path: string): Route => {
  const found = (routes as unknown as Route[]).find((entry) => entry.path === path);
  if (!found) throw new Error(`no route ${path}`);
  return found;
};
const post = async (path: string, body: unknown): Promise<{ ok: boolean; text: string }> => {
  const res = await route(path).handler(new Request(`http://localhost/api${path}`, { method: 'POST', body: JSON.stringify(body) }));
  return (await res.json()) as { ok: boolean; text: string };
};

const meta = (id: string) => ({ id, title: id, description: `${id} rule`, version: '1.0.0', ref: id });
const noRmRules = (): WornSyncRules => wornSyncRules({
  inputs: [
    {
      kind: 'package', packageKind: 'blueprint', ref: 'safe-coder', revision: '1', contentHash: 'h-coder', value: {},
      dependencies: [{ packageKind: 'rule', ref: 'no-rm', revision: '1.0.0', contentHash: 'h-no-rm' }],
    },
    {
      kind: 'package', packageKind: 'rule', ref: 'no-rm', revision: '1.0.0', contentHash: 'h-no-rm',
      value: { ...meta('no-rm'), delivery: 'sync', sink: 'pre-tool',
        guard: { deny: { 'input.command': { matches: 'rm -rf' } }, reason: 'no recursive deletes' } },
    },
  ],
} as never);
const call = (command: string) => ({ tool: 'Bash', input: { command }, client: 'claude' });

beforeEach(() => {
  evaluateHookContextSinkMock.mockReset().mockResolvedValue({ text: '', result: null });
  readAppliedWornRulesMock.mockReset().mockResolvedValue(null);
  turnsExistMock.mockReset().mockResolvedValue(false);
  turnEndHeldWorkMock.mockReset().mockResolvedValue('');
  // A turn that has already spent far past every sink budget.
  turnReadMock.mockReset().mockResolvedValue({ turnId: 'turn-spent', tokensSpent: 10_000_000, msSpent: 10_000_000 });
  turnChargeMock.mockReset().mockResolvedValue(undefined);
});

describe('guardRefusalText', () => {
  it('names the identity and rule for a deny, and is empty for no verdict', () => {
    expect(guardRefusalText({ decision: 'deny', identityId: 'safe-coder', ruleId: 'no-rm', reason: 'no recursive deletes' }))
      .toBe('Refused by identity safe-coder rule no-rm: no recursive deletes');
    expect(guardRefusalText({ decision: 'none' })).toBe('');
  });
});

describe('toolGuardText (deny-only; unreadable fails open, unevaluable fails closed)', () => {
  const input = (command: string) => ({ ownerId: 'o', workspaceId: 'w', call: call(command) });

  it('refuses a matching call, naming the identity and rule', async () => {
    expect(await toolGuardText(input('rm -rf /'), async () => noRmRules()))
      .toBe('Refused by identity safe-coder rule no-rm: no recursive deletes');
    expect(await toolGuardText(input('ls'), async () => noRmRules())).toBe('');
  });

  it('fails OPEN when the applied artifact cannot be read, or nothing is applied', async () => {
    expect(await toolGuardText(input('rm -rf /'), async () => { throw new Error('artifact unreadable'); })).toBe('');
    expect(await toolGuardText(input('rm -rf /'), async () => null)).toBe('');
  });

  it('fails CLOSED when a worn guard cannot see the whole input', async () => {
    // A tool no kernel rail reads, so the worn guard is the one that answers.
    const text = await toolGuardText(
      { ownerId: 'o', workspaceId: 'w', call: { tool: 'Write', input: null, client: 'claude', inputTruncated: true } },
      async () => noRmRules(),
    );
    expect(text).toMatch(/^Refused by identity safe-coder rule no-rm: tool input exceeds/);
  });
});

describe('compactionSinkDue (D-024 §3)', () => {
  const store = (exists: () => Promise<boolean>) => ({ exists: vi.fn(exists) });

  it('re-seeds on compact and clear without reading the turn store', async () => {
    for (const source of ['compact', 'clear']) {
      const turns = store(async () => false);
      expect(await compactionSinkDue({ ownerId: 'o', workspaceId: 'w', source }, turns)).toBe(true);
      expect(turns.exists).not.toHaveBeenCalled();
    }
  });

  it('re-seeds a startup only for an owner that has taken a hook turn before', async () => {
    expect(await compactionSinkDue({ ownerId: 'o', workspaceId: 'w', source: 'startup' }, store(async () => true))).toBe(true);
    expect(await compactionSinkDue({ ownerId: 'o', workspaceId: 'w', source: 'startup' }, store(async () => false))).toBe(false);
  });

  it('treats an unreadable turn store as no signal', async () => {
    const turns = store(async () => { throw new Error('store down'); });
    expect(await compactionSinkDue({ ownerId: 'o', workspaceId: 'w', source: 'startup' }, turns)).toBe(false);
  });

  it('never fires on any other source', async () => {
    const turns = store(async () => true);
    expect(await compactionSinkDue({ ownerId: 'o', workspaceId: 'w', source: 'resume' }, turns)).toBe(false);
    expect(turns.exists).not.toHaveBeenCalled();
  });
});

describe('POST /agent-mcp/tool-guard', () => {
  it('reads nothing for a request without an owner or a tool', async () => {
    expect(await post('/agent-mcp/tool-guard', { tool: 'Bash' })).toEqual({ ok: true, text: '' });
    expect(await post('/agent-mcp/tool-guard', { owner: 'o' })).toEqual({ ok: true, text: '' });
    expect(readAppliedWornRulesMock).not.toHaveBeenCalled();
  });

  it("refuses from the wearer's worn rules, in the resolved workspace", async () => {
    readAppliedWornRulesMock.mockResolvedValue(noRmRules());
    const out = await post('/agent-mcp/tool-guard', { owner: 'o', workspace: '*', tool: 'Bash', input: { command: 'rm -rf /' } });
    expect(readAppliedWornRulesMock).toHaveBeenCalledWith('o', 'ws-active');
    expect(out.text).toBe('Refused by identity safe-coder rule no-rm: no recursive deletes');
  });

  it('gives a Codex call the verdict a Claude call gets: the client is recorded, never read', async () => {
    readAppliedWornRulesMock.mockResolvedValue(noRmRules());
    for (const [client, tool] of [['claude', 'Bash'], ['codex', 'shell']] as const) {
      const denied = await post('/agent-mcp/tool-guard', { owner: 'o', workspace: 'w', client, tool, input: { command: 'rm -rf /' } });
      expect(denied.text).toBe('Refused by identity safe-coder rule no-rm: no recursive deletes');
      expect(await post('/agent-mcp/tool-guard', { owner: 'o', workspace: 'w', client, tool, input: { command: 'ls' } }))
        .toEqual({ ok: true, text: '' });
    }
  });

  it('drops a cut input rather than evaluating a partial one', async () => {
    readAppliedWornRulesMock.mockResolvedValue(noRmRules());
    const out = await post('/agent-mcp/tool-guard', {
      owner: 'o', workspace: 'w', tool: 'Bash', input: { command: 'ls' }, inputTruncated: true,
    });
    expect(out.text).toMatch(/tool input exceeds/);
  });

  /*
   * R-11 (identity-system-everything-migration-2026-10-18 P-004): no budget
   * drops a kernel safety rail. The port charges nothing to the session's hook
   * turn, so a turn that has spent its whole sink budget still gets the rail;
   * and a shell input over the guard input bound is refused, never passed unread.
   */
  it('a kernel rail refuses through the port after the hook turn has exhausted its sink budget', async () => {
    readAppliedWornRulesMock.mockResolvedValue(noRmRules());
    const out = await post('/agent-mcp/tool-guard', { owner: 'o', workspace: 'w', tool: 'Bash', input: { command: 'git reset --hard' } });
    expect(out.text).toMatch(/^Refused by identity kernel rule kernel:git-reset-hard: /);
    expect(turnReadMock).not.toHaveBeenCalled();
    expect(turnChargeMock).not.toHaveBeenCalled();
    expect(readAppliedWornRulesMock).not.toHaveBeenCalled();
  });

  it('a shell input over the guard input bound is refused by the kernel with no identity package worn', async () => {
    for (const tool of ['Bash', 'shell', 'capability:bash']) {
      const out = await post('/agent-mcp/tool-guard', { owner: 'o', workspace: 'w', tool, input: { command: 'git reset --hard' }, inputTruncated: true });
      expect(out.text, tool).toMatch(/^Refused by identity kernel rule kernel:guard-input-bound: tool input exceeds the guard input bound/);
    }
    expect(readAppliedWornRulesMock).not.toHaveBeenCalled();
  });
});

describe('POST /agent-mcp/stop-context and /agent-mcp/compaction-context', () => {
  it('evaluates the stop sink and returns its text', async () => {
    evaluateHookContextSinkMock.mockResolvedValue({ text: 'STOP CONTEXT', result: null });
    const out = await post('/agent-mcp/stop-context', { owner: 'o', workspace: 'w' });
    expect(evaluateHookContextSinkMock.mock.calls[0]![0]).toMatchObject({ ownerId: 'o', workspaceId: 'w', sink: 'stop' });
    expect(evaluateHookContextSinkMock.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
    expect(out.text).toBe('STOP CONTEXT');
  });

  it('leads with the held-work refusal and keeps the identity text (WI-6554700010015550)', async () => {
    evaluateHookContextSinkMock.mockResolvedValue({ text: 'STOP CONTEXT', result: null });
    turnEndHeldWorkMock.mockResolvedValue('TURN-END REFUSED');
    const out = await post('/agent-mcp/stop-context', { owner: 'o', workspace: 'w' });
    expect(turnEndHeldWorkMock).toHaveBeenCalledWith({ ownerId: 'o', workspaceId: 'w' });
    expect(out.text).toBe('TURN-END REFUSED\n\nSTOP CONTEXT');
  });

  it('answers inside the wall when the held-work read never settles', async () => {
    turnEndHeldWorkMock.mockReturnValue(new Promise(() => undefined));
    evaluateHookContextSinkMock.mockResolvedValue({ text: 'STOP CONTEXT', result: null });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const started = Date.now();
    expect(await post('/agent-mcp/stop-context', { owner: 'o', workspace: 'w' })).toEqual({ ok: true, text: 'STOP CONTEXT' });
    expect(Date.now() - started).toBeLessThan(2400);
    warn.mockRestore();
  });

  it('answers inside the wall when the sink never settles', async () => {
    evaluateHookContextSinkMock.mockReturnValue(new Promise(() => undefined));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const started = Date.now();
    expect(await post('/agent-mcp/stop-context', { owner: 'o', workspace: 'w' })).toEqual({ ok: true, text: '' });
    expect(Date.now() - started).toBeLessThan(2400);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('identity-hook:stop exceeded 2000ms'));
    warn.mockRestore();
  });

  it('evaluates the compaction sink only when a fresh context is due', async () => {
    evaluateHookContextSinkMock.mockResolvedValue({ text: 'RESEED', result: null });
    expect((await post('/agent-mcp/compaction-context', { owner: 'o', workspace: 'w', source: 'resume' })).text).toBe('');
    expect((await post('/agent-mcp/compaction-context', { owner: 'o', workspace: 'w', source: 'startup' })).text).toBe('');
    expect(evaluateHookContextSinkMock).not.toHaveBeenCalled();

    expect((await post('/agent-mcp/compaction-context', { owner: 'o', workspace: 'w', source: 'compact' })).text).toBe('RESEED');
    expect(evaluateHookContextSinkMock.mock.calls[0]![0]).toMatchObject({ sink: 'compaction' });

    turnsExistMock.mockResolvedValue(true);
    expect((await post('/agent-mcp/compaction-context', { owner: 'o', workspace: 'w', source: 'startup' })).text).toBe('RESEED');
  });
});
