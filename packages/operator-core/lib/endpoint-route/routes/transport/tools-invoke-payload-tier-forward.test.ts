/**
 * tools:invoke must forward an outer `payloadTier` into the target's args.
 *
 * `tools:invoke` re-dispatches with `args.args` alone, so a framework-reserved
 * control left on the OUTER call never reaches the target tool. `projection` is
 * already rescued from that by forwardToolsInvokeProjection; `payloadTier` was
 * not, so the same outer position behaved oppositely for the two controls and a
 * caller asking for full detail silently got a trimmed read with ok:true.
 * EI-21245922047633177.
 *
 * The negative cases matter as much as the positive one: this helper runs on the
 * path of every MCP tool call, so "does nothing unless it is a tools:invoke
 * carrying an outer tier" is the property that keeps its blast radius at zero.
 */
import { describe, it, expect } from 'vitest';
import { projectBoundedPayload } from '@papercusp/tooldef';

import { forwardToolsInvokePayloadTier, resultDoorPreservePathsForDispatch } from './_mcp-host';

describe('forwardToolsInvokePayloadTier', () => {
  it('forwards an outer payloadTier into the target args', () => {
    const out = forwardToolsInvokePayloadTier('tools:invoke', {
      name: 'work_items:get',
      args: { id: 'EI-1', harness: 'papercusp' },
      payloadTier: 'full',
    }) as Record<string, unknown>;

    expect(out.args).toEqual({ id: 'EI-1', harness: 'papercusp', payloadTier: 'full' });
  });

  it('keeps the outer copy in place (it shapes the wrapper result and is read downstream)', () => {
    const out = forwardToolsInvokePayloadTier('tools:invoke', {
      name: 'work_items:get',
      args: { id: 'EI-1' },
      payloadTier: 'full',
    }) as Record<string, unknown>;

    expect(out.payloadTier).toBe('full');
  });

  it('materialises args when the caller omitted them entirely', () => {
    const out = forwardToolsInvokePayloadTier('tools:invoke', {
      name: 'coord:orient',
      payloadTier: 'full',
    }) as Record<string, unknown>;

    expect(out.args).toEqual({ payloadTier: 'full' });
  });

  it('forwards into JSON-stringified target args at the pre-validation boundary', () => {
    const out = forwardToolsInvokePayloadTier('tools:invoke', {
      name: 'work_items:get',
      args: JSON.stringify({ id: 'EI-1', harness: 'papercusp' }),
      payloadTier: 'full',
    }) as Record<string, unknown>;

    expect(out.args).toEqual({ id: 'EI-1', harness: 'papercusp', payloadTier: 'full' });
  });

  it('does NOT overwrite an explicitly nested payloadTier — the caller was specific about the target', () => {
    const input = {
      name: 'work_items:get',
      args: { id: 'EI-1', payloadTier: 'summary' },
      payloadTier: 'full',
    };
    const out = forwardToolsInvokePayloadTier('tools:invoke', input) as Record<string, unknown>;

    expect(out.args).toEqual({ id: 'EI-1', payloadTier: 'summary' });
    expect(out).toBe(input); // untouched, not a rebuilt copy
  });

  // --- guards: the helper sits on every MCP call, so it must be inert elsewhere ---

  it('is inert for a tool that is not tools:invoke', () => {
    const input = { id: 'EI-1', payloadTier: 'full' };
    const out = forwardToolsInvokePayloadTier('work_items:get', input);

    expect(out).toBe(input);
  });

  it('is inert when no outer payloadTier was supplied', () => {
    const input = { name: 'work_items:get', args: { id: 'EI-1' } };
    const out = forwardToolsInvokePayloadTier('tools:invoke', input);

    expect(out).toBe(input);
  });

  it('is inert for a non-object args value rather than clobbering it', () => {
    const input = { name: 'work_items:get', args: 'not-an-object', payloadTier: 'full' };
    const out = forwardToolsInvokePayloadTier('tools:invoke', input);

    expect(out).toBe(input);
  });

  it('is inert for a null or non-object dispatchArgs', () => {
    expect(forwardToolsInvokePayloadTier('tools:invoke', null)).toBeNull();
    expect(forwardToolsInvokePayloadTier('tools:invoke', 'nope')).toBe('nope');
  });

  it('does not mutate the caller-supplied object when it does forward', () => {
    const input = {
      name: 'work_items:get',
      args: { id: 'EI-1' },
      payloadTier: 'full',
    };
    forwardToolsInvokePayloadTier('tools:invoke', input);

    expect(input.args).toEqual({ id: 'EI-1' });
  });
});

describe('resultDoorPreservePathsForDispatch', () => {
  const pick = 'results[].threadWindow.posts[].body';
  const result = { content: [{ type: 'text' as const, text: '{}' }] };

  it('keeps a nested tools:invoke projection available to the outer result door', () => {
    const paths = resultDoorPreservePathsForDispatch(result, 'tools:invoke', {
      name: 'work_items:get',
      args: { id: 'WI-1', projection: { pick: [pick] } },
    }, undefined);

    expect(paths).toEqual([pick]);
  });

  it('decodes JSON-stringified nested args before reading projection picks', () => {
    const paths = resultDoorPreservePathsForDispatch(result, 'tools:invoke', {
      name: 'work_items:get',
      args: JSON.stringify({ id: 'WI-1', projection: { pick: [pick] } }),
    }, undefined);

    expect(paths).toEqual([pick]);
  });

  it('ignores an explicitly null nested projection without dereferencing its absent spec', () => {
    expect(resultDoorPreservePathsForDispatch(result, 'tools:invoke', {
      name: 'work_items:get',
      args: { id: 'WI-1', projection: null },
    }, undefined)).toBeUndefined();
  });

  it('keeps picked post bodies through the budgeted outer result-door projection', () => {
    const paths = resultDoorPreservePathsForDispatch(result, 'tools:invoke', {
      name: 'work_items:get',
      args: { id: 'WI-1', projection: { pick: [pick] } },
    }, undefined);
    const posts = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      author_id: `agent-${index}`,
      created_ts: `2026-10-16T12:00:${String(index).padStart(2, '0')}Z`,
      body: `thread body ${index} ${'x'.repeat(1800)}`,
    }));
    const projected = projectBoundedPayload({
      results: [{ id: 'WI-1', threadWindow: { posts } }],
    }, {
      toolName: 'tools:invoke',
      tier: 'trimmed',
      forced: true,
      targetChars: 5_000,
      preservePaths: paths,
    }) as {
      results?: Array<{ threadWindow?: { posts?: Array<Record<string, unknown>> } }>;
      _projection?: { forced?: boolean };
    };

    const projectedPosts = projected.results?.[0]?.threadWindow?.posts ?? [];
    expect(projected._projection?.forced).toBe(true);
    expect(projectedPosts.length).toBeGreaterThan(0);
    expect(projectedPosts.every(post => typeof post.body === 'string')).toBe(true);
  });

  it('forwards selected plans:get item fields to the outer result-door projection', () => {
    const picks = ['results[].items[].id', 'results[].items[].text', 'results[].items[].storedStatus'];
    const paths = resultDoorPreservePathsForDispatch(result, 'tools:invoke', {
      name: 'plans:get',
      args: { slug: 'plan-1', projection: { pick: picks } },
    }, undefined);
    const items = Array.from({ length: 3 }, (_, index) => ({
      id: `P-00${index + 1}`,
      text: `selected item ${index + 1} ${'x'.repeat(120)}`,
      storedStatus: 'todo',
    }));
    const projected = projectBoundedPayload({
      results: [{ items }],
      padding: 'P'.repeat(20_000),
    }, {
      toolName: 'tools:invoke',
      tier: 'trimmed',
      forced: true,
      targetChars: 5_000,
      preservePaths: paths,
    }) as {
      results?: Array<{ items?: Array<Record<string, unknown>> }>;
      _projection?: { forced?: boolean };
    };

    expect(paths).toEqual(picks);
    expect(projected._projection?.forced).toBe(true);
    expect(projected.results?.[0]?.items).toHaveLength(3);
    expect(projected.results?.[0]?.items?.map(item => [item.id, item.text, item.storedStatus])).toEqual(
      items.map(item => [item.id, item.text, item.storedStatus]),
    );
  });

  it('combines direct and nested picks while keeping other dispatches inert', () => {
    const direct = 'results[].id';
    expect(resultDoorPreservePathsForDispatch(result, 'tools:invoke', {
      name: 'work_items:get',
      args: { projection: { pick: [pick] } },
    }, [direct])).toEqual([direct, pick]);

    expect(resultDoorPreservePathsForDispatch(result, 'work_items:get', {
      projection: { pick: [pick] },
    }, [direct])).toEqual([direct]);
  });
});
