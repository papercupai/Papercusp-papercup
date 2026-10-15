/**
 * Standalone tests for the MCP bridge primitives — import ONLY @papercusp/tooldef
 * + this package (no agent-mcp, no operator, no mcp-handler).
 */
import { describe, expect, it, vi } from 'vitest';
import type { ProjectedTool, UnifiedToolContext } from '@papercusp/tooldef';
import {
  bearerFromExtra,
  urlFromExtra,
  headersFromExtra,
  dispatchProjectedToolToMcp,
  isDispatchValidationFailure,
} from './index';

const ctx = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  ...over,
});

const tool = (over: Partial<ProjectedTool> = {}): ProjectedTool => ({
  pluginName: 'fixture',
  description: 'fixture',
  inputSchema: { type: 'object' },
  capabilities: [],
  expose: { mcp: { name: 'fix.tool' } },
  fn: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  ...over,
});

describe('RequestHandlerExtra extractors', () => {
  it('bearerFromExtra strips the Bearer prefix', () => {
    expect(bearerFromExtra({ requestInfo: { headers: { authorization: 'Bearer xyz' } } })).toBe('xyz');
    expect(bearerFromExtra({ requestInfo: { headers: { authorization: ['Bearer abc'] } } })).toBe('abc');
    expect(bearerFromExtra({})).toBe('');
  });
  it('urlFromExtra parses the request URL', () => {
    expect(urlFromExtra({ requestInfo: { url: 'http://h/p?role=worker' } })?.searchParams.get('role')).toBe('worker');
    expect(urlFromExtra({})).toBeNull();
    expect(urlFromExtra({ requestInfo: { url: 'not a url' } })).toBeNull();
  });
  it('headersFromExtra builds a Headers (arrays joined)', () => {
    const h = headersFromExtra({ requestInfo: { headers: { 'x-a': '1', 'x-b': ['2', '3'] } } });
    expect(h.get('x-a')).toBe('1');
    expect(h.get('x-b')).toBe('2, 3');
  });
});

describe('dispatchProjectedToolToMcp', () => {
  it('maps a successful dispatch to { content }', async () => {
    const r = await dispatchProjectedToolToMcp(tool(), 'fix.tool', {}, ctx(), {});
    expect(r.isError).toBeUndefined();
    expect(r.content[0]).toEqual({ type: 'text', text: 'ok' });
  });
  it('maps a gate denial to { isError, content:"<code>: <msg>" }', async () => {
    const r = await dispatchProjectedToolToMcp(tool({ agentRoles: ['architect'] }), 'fix.tool', {}, ctx({ role: 'worker' }), {});
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/^role_not_allowed: /);
  });

  it('preserves a dispatcher late-write receipt on the MCP error result', async () => {
    const receipt = {
      status: 'recorded',
      msg_id: 'm-late',
      diagnostics: { coordSendPhaseTimingsMs: [{ itemIndex: 0, prePersistMs: 8, persistMs: 12, postPersistMs: 5 }] },
    };
    const error = Object.assign(new Error('tool timed out after its handler returned'), {
      dispatchMetadata: { abortCompletionReceipt: receipt },
    });
    const r = await dispatchProjectedToolToMcp(
      tool({ fn: async () => { throw error; } }),
      'fix.tool',
      {},
      ctx(),
      {},
    );

    expect(r.isError).toBe(true);
    expect(r._meta).toEqual({ abortCompletionReceipt: receipt });
  });

  // EI-21903050648079438: a code:run script's unwrapToolResult prefers
  // structuredContent over the text body, so a dispatch-level failure with no
  // structuredContent handed the script a raw STRING while a success handed it
  // an OBJECT — an asymmetry that makes `result.ok` read as undefined on the
  // exact path a script most needs to detect failure on.
  it('carries structuredContent:{ok:false,error} on a gate denial when codeMode is set', async () => {
    const r = await dispatchProjectedToolToMcp(
      tool({ agentRoles: ['architect'] }),
      'fix.tool',
      {},
      ctx({ role: 'worker', codeMode: true }),
      {},
    );
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({
      ok: false,
      error: { code: 'role_not_allowed', message: expect.any(String) },
    });
  });

  it('omits structuredContent on a gate denial when codeMode is not set (no extra wire cost)', async () => {
    const r = await dispatchProjectedToolToMcp(tool({ agentRoles: ['architect'] }), 'fix.tool', {}, ctx({ role: 'worker' }), {});
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
  });

  it('marks only mapper-produced validation refusals, without exposing the marker on the wire', async () => {
    const invalid = await dispatchProjectedToolToMcp(
      tool({
        fn: async () => {
          const error = new Error('invalid_args: value: expected string');
          Object.defineProperty(error, 'name', { value: 'InvalidInputError' });
          throw error;
        },
      }),
      'fix.tool',
      {},
      ctx(),
      {},
    );
    expect(isDispatchValidationFailure(invalid)).toBe(true);
    expect(isDispatchValidationFailure({ ...invalid })).toBe(true);
    expect(JSON.stringify(invalid)).not.toContain('dispatch-validation');

    const handlerError = await dispatchProjectedToolToMcp(
      tool({ fn: async () => ({ content: [{ type: 'text', text: 'business failure' }], isError: true }) }),
      'fix.tool',
      {},
      ctx(),
      {},
    );
    expect(handlerError.isError).toBe(true);
    expect(isDispatchValidationFailure(handlerError)).toBe(false);
  });

  it('still prefers the target-supplied structuredContent on success (unchanged)', async () => {
    const r = await dispatchProjectedToolToMcp(
      tool({ fn: async () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true, n: 1 } }) }),
      'fix.tool',
      {},
      ctx({ codeMode: true }),
      {},
    );
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toEqual({ ok: true, n: 1 });
  });
});
