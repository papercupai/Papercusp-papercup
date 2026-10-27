// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { identityAssumeResponseFromRows, makeIdentityAssumeFence, nativeExecutionFromRows } from '../scripts/psu-pty-host.mjs';

const caller = { ownerId: 'disposable-caller', workspaceId: 'test-workspace', nativeSessionId: 'native-caller',
  nativePid: 42, hostId: 'host-one', attachmentId: 'terminal-one', childGeneration: 1 };
const request = () => ({ transitionKey: `session-assume:${'a'.repeat(64)}`, preparationHash: 'b'.repeat(64),
  recoveryRef: 'carry-note:disposable-caller', recoveryHash: 'c'.repeat(64), expiresAt: 100_000,
  caller: structuredClone(caller) });
function setup() {
  let now = 1_000;
  let current = structuredClone(caller);
  let available = true;
  const fence = makeIdentityAssumeFence({ identity: () => current, canFreeze: () => available, now: () => now });
  const r = request();
  const proof = () => ({ response: { caller: structuredClone(caller), transitionKey: r.transitionKey,
    preparationHash: r.preparationHash, state: 'handoff-accepted', durable: true, atMs: 1_100 },
    execution: { caller: structuredClone(caller), phase: 'settled', pendingTools: 0, lastProgressAt: 1_200 } });
  return { fence, r, proof, now: (value: number) => { now = value; },
    current: (value: typeof caller) => { current = value; }, busy: () => { available = false; } };
}

describe('identity takeover host custody and response boundary', () => {
  it('fences input without replacing a native child before its matching response and completion', () => {
    const s = setup();
    expect(s.fence.freeze(s.r)).toEqual({ ok: true, phase: 'frozen' });
    expect(s.fence.blocksInput()).toBe(true);
    expect(s.fence.begin(s.r, s.proof()).ok).toBe(false);
    expect(s.fence.queue(s.r)).toEqual({ ok: true, phase: 'queued' });
    expect(s.fence.begin(s.r, null).ok).toBe(false);
    s.now(1_300);
    expect(s.fence.begin(s.r, s.proof())).toMatchObject({ ok: true, phase: 'starting', request: s.r });
    expect(s.fence.begin(s.r, s.proof()).ok).toBe(false);
    expect(s.fence.thaw(s.r)).toEqual({ ok: false, reason: 'assume-replacement-started' });
    expect(s.fence.blocksInput()).toBe(true);
  });

  it.each(['ownerId', 'workspaceId', 'nativeSessionId', 'hostId', 'attachmentId', 'nativePid', 'childGeneration'] as const)(
    'refuses a changed %s at freeze and immediately before replacement', key => {
      const s = setup();
      const changed = { ...caller, [key]: typeof caller[key] === 'number' ? 99 : 'different' };
      s.current(changed);
      expect(s.fence.freeze(s.r).ok).toBe(false);
      s.current(caller);
      expect(s.fence.freeze(s.r).ok).toBe(true);
      s.fence.queue(s.r); s.now(1_300); s.current(changed);
      expect(s.fence.begin(s.r, s.proof()).ok).toBe(false);
      expect(s.fence.thaw(s.r).ok).toBe(false);
    });

  it('serializes contenders, pins recovery, owns an immutable copy and refuses stale replays after thaw', () => {
    const s = setup();
    const original = structuredClone(s.r);
    expect(s.fence.freeze(s.r).ok).toBe(true);
    s.r.recoveryRef = 'mutated';
    expect(s.fence.queue(s.r).ok).toBe(false);
    expect(s.fence.freeze({ ...original, preparationHash: 'd'.repeat(64) }).ok).toBe(false);
    expect(s.fence.freeze({ ...original, transitionKey: `session-assume:${'d'.repeat(64)}` }).ok).toBe(false);
    expect(s.fence.freeze(original)).toEqual({ ok: true, phase: 'frozen' });
    expect(s.fence.thaw(original).ok).toBe(true);
    expect(s.fence.blocksInput()).toBe(false);
    expect(s.fence.freeze(original)).toEqual({ ok: false, reason: 'assume-replayed-transition' });
  });

  it('keeps an expired fence closed but permits exact caller recovery before replacement starts', () => {
    const s = setup();
    s.fence.freeze(s.r); s.fence.queue(s.r); s.now(s.r.expiresAt);
    expect(s.fence.state()).toEqual({ phase: 'queued', expired: true });
    expect(s.fence.begin(s.r, s.proof()).ok).toBe(false);
    expect(s.fence.blocksInput()).toBe(true);
    expect(s.fence.thaw({ ...s.r, recoveryHash: 'e'.repeat(64) }).ok).toBe(false);
    expect(s.fence.thaw(null).ok).toBe(false);
    expect(s.fence.thaw(s.r).ok).toBe(true);
  });

  it('replays only the exact thaw ACK after response loss without reopening takeover', () => {
    const s = setup();
    expect(s.fence.freeze(s.r).ok).toBe(true);
    expect(s.fence.thaw(s.r)).toEqual({ ok: true, phase: 'released' });
    s.now(s.r.expiresAt + 1);
    expect(s.fence.thaw(s.r)).toEqual({ ok: true, phase: 'released' });
    expect(s.fence.thaw({ ...s.r, recoveryHash: 'd'.repeat(64) }).ok).toBe(false);
    s.current({ ...caller, childGeneration: caller.childGeneration + 1 });
    expect(s.fence.thaw(s.r).ok).toBe(false);
    s.current(caller); s.now(1_000);
    expect(s.fence.freeze(s.r)).toEqual({ ok: false, reason: 'assume-replayed-transition' });
    const next = { ...s.r, transitionKey: `session-assume:${'e'.repeat(64)}` };
    expect(s.fence.freeze(next).ok).toBe(true);
    expect(s.fence.thaw(s.r).ok).toBe(false);
    expect(s.fence.blocksInput()).toBe(true);
  });

  it('refuses a busy host and malformed or excessive lease durations', () => {
    const s = setup(); s.busy();
    expect(s.fence.freeze(s.r)).toEqual({ ok: false, reason: 'assume-input-busy' });
    for (const override of [{ transitionKey: 'anything' }, { preparationHash: '' }, { recoveryHash: '' },
      { recoveryRef: '' }, { expiresAt: 1_000 }, { expiresAt: 121_001 }, { caller: {} }]) {
      expect(setup().fence.freeze({ ...s.r, ...override }).ok).toBe(false);
    }
  });

  it.each(['transition', 'preparation', 'caller', 'undurable', 'wrong-state', 'old-response', 'future-response',
    'running', 'failed', 'pending-tool', 'old-completion', 'future-completion', 'reader-clock']) (
    'does not replace on %s evidence', scenario => {
      const s = setup(); s.fence.freeze(s.r); s.fence.queue(s.r); s.now(1_300);
      const p = s.proof();
      if (scenario === 'transition') p.response.transitionKey = 'other';
      if (scenario === 'preparation') p.response.preparationHash = 'other';
      if (scenario === 'caller') p.response.caller.nativePid++;
      if (scenario === 'undurable') p.response.durable = false;
      if (scenario === 'wrong-state') p.response.state = 'handoff-requested';
      if (scenario === 'old-response') p.response.atMs = 999;
      if (scenario === 'future-response') p.response.atMs = 1_301;
      if (scenario === 'running' || scenario === 'failed') p.execution.phase = scenario;
      if (scenario === 'pending-tool') p.execution.pendingTools = 1;
      if (scenario === 'old-completion') p.execution.lastProgressAt = 1_099;
      if (scenario === 'future-completion') p.execution.lastProgressAt = 1_301;
      if (scenario === 'reader-clock') {
        Object.assign(p.execution, { lastProgressAt: null, observedAt: 1_300 });
      }
      expect(s.fence.begin(s.r, p)).toEqual({ ok: false, reason: 'assume-response-not-observed' });
      expect(s.fence.state()?.phase).toBe('queued');
    });

  it('uses the native terminal-event clock, rather than a fresh read of an old completed turn', () => {
    const s = setup(); s.fence.freeze(s.r); s.fence.queue(s.r); s.now(1_300);
    const p = s.proof();
    const oldExecution = nativeExecutionFromRows([{ timestamp: new Date(900).toISOString(),
      type: 'event_msg', payload: { type: 'task_complete', turn_id: 'old-turn' } }], { agent: 'codex', nowMs: 1_300 });
    Object.assign(p.execution, oldExecution, { observedAt: 1_300 });
    expect(p.execution.phase).toBe('settled');
    expect(p.execution.lastProgressAt).toBe(900);
    expect(s.fence.begin(s.r, p).ok).toBe(false);
  });

  it('reads the installed Codex code executor input_text envelope without admitting image, error or user content', () => {
    const s = setup();
    const receipt = { transitionKey: s.r.transitionKey, preparationFingerprint: s.r.preparationHash,
      preparation: { caller: { ...caller, backend: 'codex' } }, state: 'handoff-accepted', durable: true,
      recovery: { checkpointRef: s.r.recoveryRef, checkpointSha256: s.r.recoveryHash } };
    const content = [{ type: 'text', text: JSON.stringify(receipt) }];
    const output = [{ type: 'input_text', text: 'Script completed\nOutput:\n' },
      { type: 'input_text', text: JSON.stringify({ content }) }];
    const row = { timestamp: new Date(1_100).toISOString(), type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: 'native-assume', output } };
    const observe = (rows: unknown[]) => identityAssumeResponseFromRows(rows,
      { agent: 'codex', request: s.r, sinceMs: 1_000, nowMs: 1_300 });
    expect(observe([row])).toMatchObject({ transitionKey: s.r.transitionKey, atMs: 1_100 });
    expect(observe([{ ...row, payload: { ...row.payload,
      output: [{ type: 'input_image', text: JSON.stringify({ content }) }] } }])).toBeNull();
    expect(observe([{ ...row, payload: { ...row.payload,
      output: [{ type: 'input_text', isError: true, text: JSON.stringify({ content }) }] } }])).toBeNull();
    expect(observe([{ ...row, payload: { ...row.payload, type: 'message', role: 'user', content: output } }])).toBeNull();
  });

  it.each(['codex', 'claude', 'omp'])('requires a matching persisted %s tool result and rejects prose or changed recovery', agent => {
    const s = setup();
    const receipt = { transitionKey: s.r.transitionKey, preparationFingerprint: s.r.preparationHash,
      preparation: { caller: { ...caller, backend: agent } }, state: 'handoff-accepted', durable: true,
      recovery: { checkpointRef: s.r.recoveryRef, checkpointSha256: s.r.recoveryHash } };
    const row = (value: unknown) => {
      const content = [{ type: 'text', text: JSON.stringify(value) }];
      return { timestamp: new Date(1_100).toISOString(), ...(agent === 'codex'
        ? { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-one',
          output: JSON.stringify({ content }) } }
        : agent === 'claude' ? { type: 'user', message: { role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-one', content }] } }
          : { type: 'message', message: { role: 'toolResult', toolCallId: 'call-one', content } }) };
    };
    const observe = (rows: unknown[]) => identityAssumeResponseFromRows(rows, { agent, request: s.r, sinceMs: 1_000, nowMs: 1_300 });
    expect(observe([row(receipt)])).toMatchObject({ transitionKey: s.r.transitionKey, atMs: 1_100 });
    expect(observe([row({ ...receipt, state: 'handoff-requested' })])).toBeNull();
    expect(observe([row({ ...receipt, preparationFingerprint: 'wrong' })])).toBeNull();
    expect(observe([row({ ...receipt, durable: false })])).toBeNull();
    expect(observe([row({ ...receipt, isError: true })])).toBeNull();
    expect(observe([row({ ...receipt, recovery: { ...receipt.recovery, checkpointSha256: 'wrong' } })])).toBeNull();
    expect(observe([row({ ...receipt, preparation: { caller: { ...receipt.preparation.caller, nativePid: 99 } } })])).toBeNull();
    expect(observe([row({ note: JSON.stringify(receipt) })])).toBeNull();
    expect(observe([row({ isError: true, content: JSON.stringify(receipt) })])).toBeNull();
    expect(observe([{ timestamp: new Date(1_100).toISOString(), type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(receipt) }] } }])).toBeNull();
    expect(observe([{ timestamp: new Date(1_100).toISOString(), type: 'user',
      message: { role: 'user', content: JSON.stringify(receipt) } }])).toBeNull();
    expect(observe([{ ...row(receipt), timestamp: new Date(999).toISOString() }])).toBeNull();
    expect(observe([{ ...row(receipt), timestamp: new Date(1_301).toISOString() }])).toBeNull();
  });
});
