/**
 * callPlansReadRaw contract pins (WI-5078).
 *
 * The in-process plans READ dispatch feeds the admin Plans routes and the
 * @papercusp/sync named-query resolvers — i.e. the operator UI. Those
 * consumers have no model-context budget and no MCP result cap, so the
 * dispatch must request the EXPLICIT full payload tier: without it, the
 * payload-tier HARD CEILING force-trims any >30KB shaper-tool result, and
 * plans:attention (~1.1MB) came back as item-less group summaries that
 * normalizeAttentionGroups dropped — blanking the Queue, the Overview
 * needs-you tiles, and the left-sidebar Inbox (EI-13037).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  calls: [] as Array<{ pathname: string; body: Record<string, unknown>; headers: Record<string, string> }>,
  /** When set, the mock returns this JSON as the tool's text envelope for the
   *  next call (else the default `{ ok: true }`). */
  nextResult: null as unknown,
  nextHttpFailure: null as { status: number; body: unknown } | null,
}));

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  handleHttpToolRequest: vi.fn(async (req: { pathname: string; body: Record<string, unknown>; headers: Record<string, string> }) => {
    H.calls.push({ pathname: req.pathname, body: req.body, headers: req.headers });
    if (H.nextHttpFailure) {
      const failure = H.nextHttpFailure;
      H.nextHttpFailure = null;
      return failure;
    }
    const payload = H.nextResult ?? { ok: true };
    H.nextResult = null;
    return {
      status: 200,
      body: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
    };
  }),
}));
// The real module side-effect-imports the whole first-party tool catalog —
// irrelevant to this contract and heavy; stub it.
vi.mock('../index', () => ({}));
vi.mock('../../projected-tool-deps', () => ({ PROJECTED_DEPS: {} }));

import { callPlansRead, callPlansReadRaw } from './read-dispatch';
import { runWithWorkspace } from '../../workspace-als';

beforeEach(() => {
  H.calls = [];
  H.nextResult = null;
  H.nextHttpFailure = null;
});

describe('nested UI workspace context', () => {
  it('forwards each request workspace without leaking it to another or an unscoped read', async () => {
    await runWithWorkspace('ws-a', () => callPlansReadRaw('attention', {}));
    await runWithWorkspace('ws-b', () => callPlansReadRaw('attention', {}));
    await callPlansReadRaw('attention', {});
    await runWithWorkspace('*', () => callPlansReadRaw('attention', {}));
    expect(H.calls.map(call => call.headers)).toEqual([
      { 'x-papercusp-workspace': 'ws-a' },
      { 'x-papercusp-workspace': 'ws-b' },
      {},
      {},
    ]);
  });
});

describe('plan document UI read cost', () => {
  it('omits unrendered descendant history by default and preserves explicit callers', async () => {
    await callPlansRead('get', { slug: 'p', mode: 'full', includeRaw: true });
    expect(H.calls[0].body).toMatchObject({ includeHistory: false, includeRaw: true, mode: 'full' });
    await callPlansRead('get', { slug: 'p', mode: 'full', includeHistory: true });
    expect(H.calls[1].body.includeHistory).toBe(true);
    await callPlansRead('list', {});
    expect(H.calls[2].body).not.toHaveProperty('includeHistory');
  });
});

describe('callPlansRead error propagation (WI-2147274)', () => {
  it('preserves the structured validation message from the HTTP tool dispatcher', async () => {
    H.nextHttpFailure = {
      status: 400,
      body: {
        ok: false,
        error: { code: 'invalid_args', message: 'Unrecognized key: "ownerAgentId"' },
      },
    };
    await expect(
      callPlansRead('attention', { ownerAgentId: 'su-mine', limit: 100, offset: 0 }),
    ).rejects.toThrow('Unrecognized key: "ownerAgentId"');
  });

  it('keeps legacy string errors intact', async () => {
    H.nextHttpFailure = { status: 403, body: { error: 'Access denied' } };
    await expect(callPlansRead('attention', {})).rejects.toThrow('Access denied');
  });

  it.each([null, {}, { error: { code: 'invalid_args' } }, { error: { message: 400 } }])(
    'retains the verb and HTTP status when the error has no message: %j',
    async (body) => {
      H.nextHttpFailure = { status: 400, body };
      await expect(callPlansRead('attention', {})).rejects.toThrow('plans:attention → 400');
    },
  );
});

describe('callPlansReadRaw payload-tier contract (WI-5078)', () => {
  it('requests the EXPLICIT full tier so the hard ceiling cannot trim UI reads', async () => {
    await callPlansReadRaw('attention', {});
    expect(H.calls).toHaveLength(1);
    expect(H.calls[0].pathname).toBe('/api/agent-tools/plans/attention');
    expect(H.calls[0].body.payloadTier).toBe('full');
  });

  it('keeps a caller-specified payloadTier (opt-in shaped reads stay possible)', async () => {
    await callPlansReadRaw('attention', { payloadTier: 'trimmed' });
    expect(H.calls[0].body.payloadTier).toBe('trimmed');
  });
});

describe('callPlansReadRaw UI display projection (P-005)', () => {
  it('applies the plans:items slim (clips item.text, drops coverage) to the returned data', async () => {
    H.nextResult = {
      items: [
        { plan: 'p', archived: false, coverage: { level: 'full' }, item: { id: 'P-1', text: 'y'.repeat(1000) } },
      ],
    };
    const r = await callPlansReadRaw('items', {});
    const data = r.data as { items: Array<{ coverage?: unknown; item: { text: string } }> };
    expect(data.items[0]).not.toHaveProperty('coverage');
    expect(data.items[0].item.text.length).toBe(280);
    expect(data.items[0].item.text).toMatch(/…$/);
  });

  it('applies the plans:attention slim by default (clips body, keeps actions)', async () => {
    // SUPERSEDES the old "attention is left unprojected" pin — attention got the
    // list/detail split in slim-plans-attention-sync-payload-2026-07-26 P-003.
    // Actions were later restored to the list row so its controls render before
    // the detail hydration round-trip; ui-read-projection.test.ts pins the full set.
    const att = {
      groups: [
        { key: 'g', items: [{ id: 'a', body: 'z'.repeat(2000), actions: [{ id: 'answer' }] }] },
      ],
    };
    H.nextResult = att;
    const r = await callPlansReadRaw('attention', {});
    const item = (r.data as { groups: Array<{ items: Array<Record<string, unknown>> }> }).groups[0]
      .items[0];
    expect((item.body as string).length).toBe(280);
    expect(item.bodyTruncated).toBe(true);
    expect(item.actions).toEqual([{ id: 'answer' }]);
  });

  it('uiProjection:false returns the FULL attention payload — the detail read (P-004)', async () => {
    // This is what plans.attentionItem relies on: the detail pane must get the
    // whole body + actions back. WI-5078 still applies underneath — the dispatch
    // must STILL request payloadTier:'full' on this path, or the hard ceiling
    // hands back item-less group summaries and the detail resolver finds nothing.
    const att = {
      groups: [
        { key: 'g', items: [{ id: 'a', body: 'z'.repeat(2000), actions: [{ id: 'answer' }] }] },
      ],
    };
    H.nextResult = att;
    const r = await callPlansReadRaw('attention', {}, { uiProjection: false });
    expect(r.data).toEqual(att);
    expect(H.calls[H.calls.length - 1].body.payloadTier).toBe('full');
  });
});
