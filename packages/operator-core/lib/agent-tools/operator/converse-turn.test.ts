import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const mocks = vi.hoisted(() => ({ begin: vi.fn(), finish: vi.fn(), authority: vi.fn(), mint: vi.fn(), options: vi.fn(),
  readBinding: vi.fn(), verifyBinding: vi.fn(), associate: vi.fn(), cas: vi.fn(), append: vi.fn(),
  parentAuthority: vi.fn(), read: vi.fn() }));
vi.mock('../../operator-chat-store', () => ({
  OperatorChatStore: class {
    constructor(options: unknown) { mocks.options(options); }
    beginTurn = mocks.begin;
    finalizeTurn = mocks.finish;
    associateInteractionCall = mocks.associate;
    compareAndSwap = mocks.cas;
    appendEvent = mocks.append;
    read = mocks.read;
  },
  operatorChatSessionAuthority: mocks.authority,
  operatorChatParentAuthority: mocks.parentAuthority,
  operatorChatTurnChannel: () => 'test-turn-channel',
}));
vi.mock('./converse-chat-binding', () => ({ mintConverseChatBinding: mocks.mint,
  readConverseCardBinding: mocks.readBinding, verifyConverseCardBinding: mocks.verifyBinding }));
import { admitConverseTurn, converseToolResultBlocks, findConverseTurn, watchConverseTurn } from './converse-turn';

describe('P010 native report result references', () => {
  const receipt = { ok: true, workspace_id: 'ws-a', report_id: 'report-a', body_md: 'private body', title: 'private title' };
  const result = (value: unknown) => ({ name: 'reports:publish', output: JSON.stringify(value), isError: false });
  it('extracts stable scoped references from direct and native MCP receipts without copying private content', () => {
    for (const value of [receipt, { content: [{ type: 'text', text: JSON.stringify(receipt) }] },
      [{ type: 'text', text: JSON.stringify(receipt) }], { structuredContent: receipt }]) {
      const blocks = converseToolResultBlocks(result(value), 'ws-a');
      expect(blocks).toEqual([{ id: 'report:report-a', kind: 'report', title: 'Report',
        sources: [{ ref: 'report:report-a' }], actions: [{ id: 'open', kind: 'open', label: 'Open report', ref: 'report:report-a' }] }]);
      expect(JSON.stringify(blocks)).not.toContain('private');
    }
  });
  it('refuses foreign, failed, ambiguous, malformed and unrelated tool output', () => {
    for (const value of [{ ...receipt, workspace_id: 'ws-b' }, { ...receipt, ok: false },
      { ...receipt, error: 'denied' }, { isError: true, structuredContent: receipt },
      { content: [{ type: 'text', text: JSON.stringify(receipt) }, { type: 'text', text: JSON.stringify(receipt) }] },
      { ...receipt, report_id: '' }]) expect(converseToolResultBlocks(result(value), 'ws-a')).toEqual([]);
    expect(converseToolResultBlocks({ ...result(receipt), isError: true }, 'ws-a')).toEqual([]);
    expect(converseToolResultBlocks({ ...result(receipt), name: 'docs:get' }, 'ws-a')).toEqual([]);
    expect(converseToolResultBlocks({ ...result(receipt), output: 'x'.repeat(65537) }, 'ws-a')).toEqual([]);
  });
});

const input = () => ({
  options: { sql: {} as never, workspaceId: 'ws-a', turn: { conversationId: 'conv-a', turnId: 'turn-a' },
    scope: { principalId: 'system:operator', tenantId: 'ws-a', customerId: 'ws-a', publicOwnerId: 'system:operator' } },
  credential: { kind: 'system' as const, name: 'operator', bearer: 'original-parent' },
  capability: 'operator:converse', toolName: 'operator:converse', runId: 'parent-run', source: 'text_typed' as const,
});

describe('P010 existing turn recovery', () => {
  it('checks original parent before the current responder on every recovered store operation', async () => {
    const order: string[] = [];
    const original = vi.fn(async () => { order.push('parent'); return true; });
    const responder = vi.fn(async () => { order.push('responder'); return true; });
    mocks.parentAuthority.mockReturnValue(original);
    mocks.read.mockResolvedValue({ state: { capabilities: {} } });
    const tx = { unsafe: vi.fn(async () => [{ seq: 4, chat_state: { execution: {
      runId: 'run-a', parentAuthority: { kind: 'system', principalId: 'system:operator' },
    } } }]) };
    const sql = { begin: async (fn: (value: unknown) => unknown) => fn(tx) } as never;
    await findConverseTurn({ sql, workspaceId: 'ws-a', identity: input().options.turn, authorizeAdditional: responder });
    // Initial identity lookup authenticates the responder in a separate
    // transaction; the retained store must use the shared mutation order.
    order.length = 0;
    const authorize = mocks.options.mock.calls[0][0].authorize;
    expect(await authorize(tx)).toBe(true);
    expect(order).toEqual(['parent', 'responder']);
    order.length = 0;
    original.mockImplementationOnce(async () => { order.push('parent'); return false; });
    expect(await authorize(tx)).toBe(false);
    expect(order).toEqual(['parent']);
  });

  it('subscribes before reading, coalesces hints during a read, rereads on reconnect and stops delivery', async () => {
    let nudge!: () => void;
    let reconnect!: () => void;
    let release!: () => void;
    const order: string[] = [];
    const checkpoint = { state: { phase: 'running' } } as never;
    const read = vi.fn(async () => checkpoint);
    read.mockImplementationOnce(() => new Promise(resolve => {
      order.push('read'); release = () => resolve(checkpoint);
    }));
    const stop = vi.fn();
    const onChange = vi.fn();
    const onError = vi.fn();
    const starting = watchConverseTurn({ store: { read }, workspaceId: 'ws-a', identity: input().options.turn,
      onChange, onError }, async (_channel, hint, onListen) => {
      order.push('listen'); nudge = () => hint('changed'); reconnect = onListen!; return stop;
    });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    nudge(); nudge();
    expect(read).toHaveBeenCalledOnce();
    release();
    const watch = await starting;
    expect(order).toEqual(['listen', 'read']);
    expect(read).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledTimes(2);
    reconnect();
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(3));
    watch.stop(); nudge(); reconnect();
    await watch.refresh();
    expect(stop).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(3);
    expect(onError).not.toHaveBeenCalled();
  });

  it('releases its listener when the initial authorized read fails', async () => {
    const stop = vi.fn();
    const onChange = vi.fn();
    await expect(watchConverseTurn({ store: { read: vi.fn(async () => { throw new Error('unauthorized'); }) },
      workspaceId: 'ws-a', identity: input().options.turn, onChange, onError: vi.fn() },
    async () => stop)).rejects.toThrow('unauthorized');
    expect(stop).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.begin.mockResolvedValue(true); mocks.finish.mockResolvedValue(undefined);
  mocks.authority.mockReturnValue('current-authority-fence'); mocks.mint.mockResolvedValue('signed-association');
  mocks.readBinding.mockReturnValue(null); mocks.verifyBinding.mockResolvedValue(null); mocks.associate.mockResolvedValue(true);
  mocks.cas.mockResolvedValue(true); mocks.append.mockImplementation(async event => event);
});
describe('P010 scoped converse lifecycle admission adapter', () => {
  const result = { name: 'mcp__agentmcp__chat_ask_choice', output: 'native-result', isError: false, callId: 'native-a' };
  const binding = { dispatchCallId: 'dispatch-a', childRunId: 'child-a', credentialSha256: 'b'.repeat(64), correlationId: 'card-a' };

  it('persists ordered native events before publication and finalization without widening recovery capabilities', async () => {
    const turn = await admitConverseTurn(input());
    expect(mocks.cas).toHaveBeenCalledWith(turn.identity, null, expect.objectContaining({
      state: expect.objectContaining({ phase: 'running', lastSequence: 0, capabilities: {
        connectionReplay: true, persistedHistory: true, persistedInteractionDecisions: true,
        completedToolCheckpoints: false, interruptedTurnRecovery: false,
      } }), effects: {},
    }));
    let commit!: () => void;
    mocks.append.mockImplementationOnce(event => new Promise(resolve => { commit = () => resolve(event); }));
    const publish = vi.fn();
    const delta = { type: 'delta' as const, text: 'Original' };
    const first = turn.publish(delta, publish);
    delta.text = 'Mutated';
    const second = turn.publish({ type: 'tool_call', name: 'read', callId: 'native-call', input: { safe: true } }, publish);
    const final = turn.finalize({ status: 'completed', text: 'Original' });
    await vi.waitFor(() => expect(mocks.append).toHaveBeenCalledOnce());
    expect(publish).not.toHaveBeenCalled(); expect(mocks.finish).not.toHaveBeenCalled();
    commit(); await Promise.all([first, second, final]);
    expect(mocks.append.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ schemaVersion: 1, ...turn.identity, sequence: 1,
        event: { type: 'delta', text: 'Original' } }),
      expect.objectContaining({ schemaVersion: 1, ...turn.identity, sequence: 2,
        event: { type: 'tool_call', name: 'read', callId: 'native-call', input: { safe: true } } }),
    ]);
    expect(new Set(mocks.append.mock.calls.map(([event]) => event.eventId)).size).toBe(2);
    expect(publish).toHaveBeenCalledTimes(2); expect(mocks.finish).toHaveBeenCalledOnce();
  });

  it('keeps an uncertain event write unacknowledged and never retries it or publishes later events', async () => {
    const turn = await admitConverseTurn(input());
    mocks.append.mockRejectedValueOnce(new Error('event-ack-lost'));
    const publish = vi.fn();
    await expect(turn.publish({ type: 'delta', text: 'Partial' }, publish)).rejects.toThrow('event-ack-lost');
    await expect(turn.publish({ type: 'delta', text: 'Later' }, publish)).rejects.toThrow('event-ack-lost');
    // Failure can preserve already assembled partial text, but cannot attest
    // successful replay coverage or write an optimistic completed result.
    await expect(turn.finalize({ status: 'completed', text: 'Partial' })).rejects.toThrow('event-ack-lost');
    expect(publish).not.toHaveBeenCalled(); expect(mocks.append).toHaveBeenCalledOnce();
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it('refuses an invalid native identity before any event write, and never persists state-channel cards', async () => {
    const turn = await admitConverseTurn(input());
    const publish = vi.fn();
    await expect(turn.publish({ type: 'tool_call', name: 'read' } as never, publish)).rejects.toThrow('invalid-frame');
    expect(mocks.append).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
    await expect(turn.publish({ type: 'state', version: 1, snapshot: {} } as never, publish)).rejects.toThrow('invalid-frame');
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it('refuses the provider mount when initial replay checkpoint admission is uncertain', async () => {
    mocks.cas.mockResolvedValue(false);
    await expect(admitConverseTurn(input())).rejects.toThrow('needs-reconciliation');
    expect(mocks.mint).not.toHaveBeenCalled();
    mocks.cas.mockRejectedValue(new Error('checkpoint-ack-lost'));
    await expect(admitConverseTurn(input())).rejects.toThrow('checkpoint-ack-lost');
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it('awaits the exact signed native result association before finalizing canonical raw arguments', async () => {
    const turn = await admitConverseTurn(input());
    await turn.bindMount({ url: 'https://host/api/mcp', bearer: 'child-bearer' });
    mocks.readBinding.mockReturnValue('signed-receipt'); mocks.verifyBinding.mockResolvedValue(binding);
    let finish!: () => void;
    mocks.associate.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    turn.observeToolResult(result);
    const running = turn.finalize({ status: 'completed', text: 'Done', tools: [{ name: 'chat:ask_choice', callId: 'native-a',
      input: { question: 'Choose', options: '[{"id":"YES","label":"Proceed","ignored":true}]', ignored: true } }] });
    await vi.waitFor(() => expect(mocks.associate).toHaveBeenCalledOnce());
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(mocks.associate).toHaveBeenCalledWith({ ...binding, parent: expect.objectContaining({ runId: 'parent-run' }), nativeCallId: 'native-a' });
    expect(mocks.verifyBinding).toHaveBeenCalledWith('signed-receipt', { parent: expect.objectContaining({ turnId: 'turn-a' }), childBearer: 'child-bearer' });
    finish(); await running;
    expect(mocks.finish.mock.calls[0][0].tools[0].input).toEqual({ question: 'Choose', options: [{ id: 'yes', label: 'Proceed' }] });
  });

  it.each(['missing-native', 'invalid-signature', 'association-ack-lost'])('refuses final success after %s without replaying a write', async failure => {
    const turn = await admitConverseTurn(input());
    await turn.bindMount({ url: 'https://host/api/mcp', bearer: 'child-bearer' });
    mocks.readBinding.mockReturnValue('signed-receipt'); mocks.verifyBinding.mockResolvedValue(binding);
    if (failure === 'invalid-signature') mocks.verifyBinding.mockResolvedValue(null);
    if (failure === 'association-ack-lost') mocks.associate.mockRejectedValue(new Error(failure));
    turn.observeToolResult({ ...result, ...(failure === 'missing-native' ? { callId: undefined } : {}) });
    await expect(turn.finalize({ status: 'completed', text: 'Done' })).rejects.toThrow(
      failure === 'association-ack-lost' ? failure : 'invalid-card-binding');
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(mocks.associate).toHaveBeenCalledTimes(failure === 'association-ack-lost' ? 1 : 0);
  });

  it('ignores unrelated tool results and does not invent an association from name or arguments', async () => {
    const turn = await admitConverseTurn(input());
    turn.observeToolResult({ ...result, name: 'reports:get' });
    turn.observeToolResult(result);
    await turn.finalize({ status: 'completed', text: 'Done' });
    expect(mocks.readBinding).toHaveBeenCalledOnce();
    expect(mocks.verifyBinding).not.toHaveBeenCalled();
    expect(mocks.associate).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledOnce();
  });

  it('reserves before binding and keeps the original parent separate from a child PI bearer', async () => {
    const turn = await admitConverseTurn(input());
    expect(mocks.begin).toHaveBeenCalledWith('parent-run', 'text_typed', {
      kind: 'system', principalId: 'system:operator',
      credentialSha256: createHash('sha256').update('original-parent').digest('hex'),
    });
    expect(mocks.mint).not.toHaveBeenCalled();
    const mount = await turn.bindMount({ url: 'https://host/api/mcp?principal=pi&run=child-run', bearer: 'child-bearer' });
    const url = new URL(mount.url);
    expect(url.searchParams.get('run')).toBe('child-run');
    expect(url.searchParams.get('chat_binding')).toBe('signed-association');
    expect(mocks.mint).toHaveBeenCalledWith({ workspaceId: 'ws-a', conversationId: 'conv-a', turnId: 'turn-a', runId: 'parent-run',
      authority: { kind: 'system', principalId: 'system:operator', credentialSha256: createHash('sha256').update('original-parent').digest('hex') } }, 'child-bearer');
    expect(mount.bearer).toBe('child-bearer'); expect(mount.url).not.toContain('original-parent');
    expect(mocks.options.mock.calls[0][0].authorize).toBe('current-authority-fence');
  });
  it.each([false, new Error('storage-unavailable')])('never grants a mount after duplicate or failed admission (%s)', async result => {
    if (result === false) mocks.begin.mockResolvedValue(false); else mocks.begin.mockRejectedValue(result);
    await expect(admitConverseTurn(input())).rejects.toThrow(result === false ? 'needs-reconciliation' : 'storage-unavailable');
    expect(mocks.mint).not.toHaveBeenCalled(); expect(mocks.finish).not.toHaveBeenCalled();
  });
  it('rejects a mismatched authenticated principal before storage', async () => {
    const args = input(); args.options.scope.principalId = 'pi:another';
    await expect(admitConverseTurn(args)).rejects.toThrow('unauthorized');
    expect(mocks.begin).not.toHaveBeenCalled();
  });
  it('pins admission identity and run despite later caller mutation and propagates a failed final write', async () => {
    const args = input(); const turn = await admitConverseTurn(args);
    args.options.turn.turnId = 'replacement'; args.runId = 'replacement'; args.credential.bearer = 'replacement';
    expect(turn.identity).toEqual({ conversationId: 'conv-a', turnId: 'turn-a' });
    await turn.finalize({ status: 'cancelled', text: 'Partial', tools: [{ name: 'read', callId: 'call-a' }] });
    expect(mocks.finish).toHaveBeenCalledWith({ runId: 'parent-run', status: 'cancelled', text: 'Partial', tools: [{ name: 'read', callId: 'call-a' }] });
    mocks.finish.mockRejectedValue(new Error('ack-lost'));
    await expect(turn.finalize({ status: 'completed', text: 'Done' })).rejects.toThrow('ack-lost');
  });
  it('uses the exact public PI identity and credential at the existing authority fence', async () => {
    const args = input();
    const turn = await admitConverseTurn({ ...args, credential: { kind: 'pi', sessionId: 'public-a', bearer: 'public-parent' },
      options: { ...args.options, scope: { ...args.options.scope, principalId: 'pi:public-a' } } });
    await turn.bindMount({ url: 'https://host/api/mcp?principal=pi', bearer: 'public-child' });
    expect(mocks.authority).toHaveBeenCalledWith(expect.objectContaining({ principalId: 'pi:public-a',
      credential: { kind: 'pi', sessionId: 'public-a', bearer: 'public-parent' } }));
    expect(mocks.mint.mock.calls[0][0].authority).toMatchObject({ kind: 'pi', principalId: 'pi:public-a' });
  });
});
