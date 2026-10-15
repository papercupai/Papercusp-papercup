/**
 * voice:say push-time chat persistence (WI-4838 / multi-window-chat-coherence
 * P-006): the spoken line lands in the shared conversation AT PUSH — the one
 * seam every drain path shares — tagged source 'voice_tts', and the chat pane
 * is invalidated so it live-renders. A persist failure must never fail the
 * speak itself (the FIFO push already happened).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../sentinel-output-buffer', () => ({
  pushSentinelSay: vi.fn(async () => {}),
}));
vi.mock('../../operator-conversations', () => ({
  getOrCreateActiveConversation: vi.fn(),
  appendTurn: vi.fn(),
}));
vi.mock('../../sync-sse', () => ({
  notifySyncInvalidate: vi.fn(async () => {}),
}));
const destination = vi.hoisted(() => ({ workspace: 'reading-workspace' as string | null }));
vi.mock('@papercusp/db-org', async importOriginal => ({ ...await importOriginal<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: vi.fn(async () => destination.workspace ? [{ workspace_id: destination.workspace }] : []) }) }));
vi.mock('../ui/dispatch', () => ({ default: { handler: vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify({ status: 'done', result: { readingId: 'reading-1', status: 'starting' } }) }] })) } }));

import sayTool from './say';
import { pushSentinelSay } from '../../sentinel-output-buffer';
import { getOrCreateActiveConversation, appendTurn } from '../../operator-conversations';
import { notifySyncInvalidate } from '../../sync-sse';
import uiDispatch from '../ui/dispatch';

const push = vi.mocked(pushSentinelSay);
const getConv = vi.mocked(getOrCreateActiveConversation);
const append = vi.mocked(appendTurn);
const invalidate = vi.mocked(notifySyncInvalidate);

const handler = (sayTool as unknown as { handler: (a: never, c: never) => Promise<unknown> }).handler;

beforeEach(() => {
  vi.clearAllMocks();
  destination.workspace = 'reading-workspace';
  getConv.mockResolvedValue({ id: 'conv-9' } as never);
  append.mockResolvedValue({ seq: 3 } as never);
});

describe('voice:say', () => {
  const ctx = { workspaceId: 'reading-workspace', uiClientId: 'requesting-tab', role: 'operator', principal: { slug: 'reading-agent', workspaceId: 'reading-workspace', capabilities: new Set(['operator:read']) }, signal: new AbortController().signal };

  it('documents the discoverable original-reading operation for ordinary agents', () => {
    expect(sayTool.agentRoles).toContain('papercup');
    expect(sayTool.agentRoles).toContain('papercup-deep');
    expect(sayTool.description).toContain('read original authorized content');
    expect(sayTool.guidance?.when).toContain("operation:'read'");
    expect(sayTool.guidance?.when).toContain('content from an authorized reader');
    expect(sayTool.guidance?.when).toContain('Read is lossless, not summarize');
    expect(sayTool.guidance?.when).toContain("operation:'control'");
    expect(sayTool.guidance?.notWhen).toContain('documents:read operation:summarize');
  });

  it('reads authorized HTML into only the requesting output tab and reports source coverage', async () => {
    const result = await handler({ operation: 'read', content: { kind: 'html', html: '<p>FIRST</p><p>FINAL TAIL</p>', ref: 'provided:article', partial: true } } as never, ctx as never) as { structuredContent: unknown };
    expect(uiDispatch.handler).toHaveBeenCalledWith(expect.objectContaining({ client_id: 'requesting-tab', intent: 'voice_read', args: expect.objectContaining({ text: 'FIRST\n\nFINAL TAIL', allowCloud: false, sourceRefs: ['provided:article'], coverage: { complete: false, warnings: ['source-partial'] } }) }), ctx);
    expect(result.structuredContent).toMatchObject({ destination: 'requesting-tab', source: { coverage: { complete: false } } });
    expect(push).not.toHaveBeenCalled();
  });

  it('refuses absent or cross-workspace destinations before dispatching speech', async () => {
    for (const workspace of [null, 'other-workspace']) {
      destination.workspace = workspace;
      const result = await handler({ operation: 'read', content: { kind: 'text', text: 'secret' } } as never, ctx as never) as { data: unknown };
      expect(result.data).toMatchObject({ ok: false, error: 'destination_unavailable' });
    }
    expect(uiDispatch.handler).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('preserves the requesting tab starting receipt without claiming audible completion', async () => {
    const receipt = { status: 'done', result: { readingId: 'reading-1', status: 'starting' } };
    vi.mocked(uiDispatch.handler).mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify(receipt) }],
    });
    const result = await handler({ operation: 'read', content: { kind: 'text', text: 'Authorized source.' } } as never, ctx as never) as {
      content: Array<{ type: string; text: string }>;
      structuredContent: { destination: string };
    };
    expect(JSON.parse(result.content[0]!.text)).toEqual(receipt);
    expect(result.structuredContent.destination).toBe('requesting-tab');
    expect(uiDispatch.handler).toHaveBeenCalledWith(expect.objectContaining({ client_id: 'requesting-tab', intent: 'voice_read' }), ctx);
    expect(push).not.toHaveBeenCalled();
  });

  it('needs a requesting tab and sends controls only to that tab', async () => {
    const missing = await handler({ operation: 'control', readingId: 'reading-1', action: 'stop' } as never, {} as never) as { data: unknown };
    expect(missing.data).toMatchObject({ ok: false, error: 'requesting_destination_required' });
    await handler({ operation: 'control', readingId: 'reading-1', action: 'pause' } as never, ctx as never);
    expect(uiDispatch.handler).toHaveBeenCalledWith(expect.objectContaining({ client_id: 'requesting-tab', intent: 'voice_read_control', args: { readingId: 'reading-1', action: 'pause' } }), ctx);
  });

  it('pushes the line AND persists it as an assistant voice_tts turn', async () => {
    await handler({ text: 'Paris.' } as never, {} as never);
    expect(push).toHaveBeenCalledWith('Paris.');
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][0]).toMatchObject({
      conversationId: 'conv-9',
      role: 'assistant',
      text: 'Paris.',
      source: 'voice_tts',
    });
    expect(invalidate).toHaveBeenCalledWith('operatorTurns.page', {
      conversationId: 'conv-9',
    });
  });

  it('still succeeds (line was pushed) when the chat persist fails', async () => {
    append.mockRejectedValueOnce(new Error('pg down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = (await handler({ text: 'hello' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    expect(push).toHaveBeenCalledWith('hello');
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
