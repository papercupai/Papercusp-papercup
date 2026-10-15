import { describe, expect, it } from 'vitest';
import { newLspQueryEvidence, recordLspWireRequest, withLspQueryEvidence } from './lsp-query-evidence';

describe('real wire evidence attribution', () => {
  it('keeps concurrent request scopes distinct through a foreign queue drainer', async () => {
    const a = newLspQueryEvidence('a');
    const b = newLspQueryEvidence('b');
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const queued = () => withLspQueryEvidence(a, () => recordLspWireRequest(
      { method: 'textDocument/references', taskId: 'server-a', pid: 123 }, async () => { await gate; return 1; }));
    await withLspQueryEvidence(b, async () => {
      const first = queued();
      await recordLspWireRequest({ method: 'textDocument/definition', taskId: 'server-b', pid: 456 }, async () => 2);
      expect(a.wire[0].outcome).toBe('pending');
      expect(a.wire[0].endedAtMs).toBeNull();
      release();
      expect(await first).toBe(1);
    });
    expect(a.wire).toHaveLength(1);
    expect(b.wire).toHaveLength(1);
    expect(a.wire[0]).toMatchObject({ taskId: 'server-a', outcome: 'response' });
    expect(b.wire[0]).toMatchObject({ taskId: 'server-b', outcome: 'response' });
    expect(a.wire[0].endedAtMs!).toBeGreaterThanOrEqual(a.wire[0].startedAtMs);
  });
  it('records a wire rejection and preserves its error', async () => {
    const evidence = newLspQueryEvidence('failure');
    const error = new Error('wire died');
    await expect(withLspQueryEvidence(evidence, () => recordLspWireRequest(
      { method: 'textDocument/references', taskId: 'server', pid: null }, async () => { throw error; }))).rejects.toBe(error);
    expect(evidence.wire[0].outcome).toBe('error');
    expect(evidence.wire[0].endedAtMs).not.toBeNull();
    await withLspQueryEvidence(undefined, () => recordLspWireRequest(
      { method: 'outside', taskId: 'server', pid: null }, async () => 3));
    expect(evidence.wire).toHaveLength(1);
  });
});
