/**
 * Tests for server.ts#dispatch() — the single in-process entry point both the
 * MCP stdio transport and Operator/Oracle call. It had no direct coverage (the
 * existing __tests__/dispatch.test.ts exercises tooldef's defineTool, not this).
 *
 * dispatch composes: lookup → resolveBearer → capability check → arg validate →
 * withWorkspace(principal.workspaceId, handler). The security-relevant invariant
 * (also the heart of plan P-005): the run is scoped to the PRINCIPAL's workspace,
 * and DispatchOptions has NO caller-supplied workspace channel — so a caller can
 * never steer a tool into another workspace. These tests pin every branch + that
 * invariant.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const FAKE_TX = { __fakeTx: true } as const;

// withWorkspace records the workspace id it was scoped to and runs the callback
// with a sentinel tx, so we can assert both the scope and what the handler got.
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  withWorkspace: vi.fn(async (_wsId: string, cb: (tx: unknown) => unknown) => cb(FAKE_TX)),
}));

vi.mock('./auth', () => ({ resolveBearer: vi.fn() }));

// Mock the tooldef surface server.ts imports. dispatch only uses lookup +
// standardValidate + formatIssues; the rest are imported for other (untested)
// functions and just need to exist so the module loads.
vi.mock('@papercusp/tooldef', () => ({
  lookup: vi.fn(),
  standardValidate: vi.fn(),
  formatIssues: (issues: unknown) => `issues:${JSON.stringify(issues)}`,
  getCatalog: vi.fn(() => []),
  getResourceCatalog: vi.fn(() => []),
  matchResource: vi.fn(() => null),
  getPromptCatalog: vi.fn(() => []),
  lookupPrompt: vi.fn(() => undefined),
  toArgsJsonSchema: vi.fn(() => ({ type: 'object', properties: {} })),
  applyEntityRefEnums: vi.fn(),
}));

import { dispatch, getPrompt, listPrompts, startServer, unwrapDoubleEncodedArgs } from './server';
import { resolveBearer } from './auth';
import { withWorkspace } from '@papercusp/db-org';
import { getCatalog, getPromptCatalog, lookup, lookupPrompt, standardValidate } from '@papercusp/tooldef';
import type { ToolDefinition } from '@papercusp/tooldef';

type AnyFn = ReturnType<typeof vi.fn>;

const principalA = {
  kind: 'system' as const,
  slug: 'system:operator',
  workspaceId: 'ws-A',
  capabilities: new Set(['test:read']),
  authMethod: 'bearer-token' as const,
  trust: 'trusted' as const,
};

let handler: AnyFn;
function makeTool(over: Partial<ToolDefinition> = {}): ToolDefinition {
  handler = vi.fn(async (value: unknown, ctx: { principal: { workspaceId: string }; tx: unknown }) => ({
    data: { echoed: value, ws: ctx.principal.workspaceId, tx: ctx.tx },
  }));
  return { name: 'test:echo', description: 'echo', capability: 'test:read', tier: 'low', args: z.object({}), handler: handler as ToolDefinition['handler'], ...over };
}

beforeEach(() => {
  vi.mocked(lookup).mockReset();
  vi.mocked(standardValidate).mockReset();
  vi.mocked(resolveBearer).mockReset();
  vi.mocked(withWorkspace).mockClear();
  vi.mocked(getCatalog).mockReturnValue([]);
  vi.mocked(getPromptCatalog).mockReturnValue([]);
  vi.mocked(lookupPrompt).mockReset();
  // Default: a known tool, a valid principal, args validate cleanly.
  vi.mocked(lookup).mockReturnValue(makeTool());
  vi.mocked(resolveBearer).mockResolvedValue(principalA);
  vi.mocked(standardValidate).mockResolvedValue({ ok: true, value: { x: 1 } } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('MCP capability discovery and prompts', () => {
  it.each([
    { label: 'explicit grant', capabilities: ['test:read'], allowedTools: undefined, visible: true },
    { label: 'wildcard grant', capabilities: ['*'], allowedTools: undefined, visible: true },
    { label: 'scoped wildcard', capabilities: ['*'], allowedTools: ['test:echo'], visible: true },
    { label: 'excluded scoped wildcard', capabilities: ['*'], allowedTools: ['test:other'], visible: false },
    { label: 'empty scoped wildcard', capabilities: ['*'], allowedTools: [], visible: false },
    { label: 'allowlist without capability', capabilities: [], allowedTools: ['test:echo'], visible: false },
  ])('tools/list respects $label', async ({ capabilities, allowedTools, visible }) => {
    vi.stubEnv('TEST_MCP_BEARER', 'b');
    vi.mocked(resolveBearer).mockResolvedValue({
      ...principalA,
      capabilities: new Set(capabilities),
      ...(allowedTools === undefined ? {} : { allowedTools: new Set(allowedTools) }),
    });
    vi.mocked(getCatalog).mockReturnValue([makeTool()]);
    const registration = vi.spyOn(Server.prototype, 'setRequestHandler');
    await startServer({ stdio: false, bearerEnv: 'TEST_MCP_BEARER' });
    const list = registration.mock.calls.find(([schema]) => schema === ListToolsRequestSchema)![1];
    const result = await list({ method: 'tools/list' } as never, {} as never);
    expect(result).toMatchObject({ tools: visible ? [{ name: 'test:echo' }] : [] });
    expect(resolveBearer).toHaveBeenCalledWith('b');
  });

  it.each([
    { label: 'explicit grant', capabilities: ['test:read'], allowed: true },
    { label: 'wildcard grant', capabilities: ['*'], allowed: true },
    { label: 'missing grant', capabilities: [], allowed: false },
  ])('prompt discovery and rendering respect $label', async ({ capabilities, allowed }) => {
    vi.mocked(resolveBearer).mockResolvedValue({ ...principalA, capabilities: new Set(capabilities) });
    const render = vi.fn(async () => ({ messages: [] }));
    const prompt = { name: 'test:prompt', description: 'test', capability: 'test:read', tier: 'low' as const, render };
    vi.mocked(getPromptCatalog).mockReturnValue([prompt]);
    vi.mocked(lookupPrompt).mockReturnValue(prompt);
    expect(await listPrompts('b')).toMatchObject({ ok: true, prompts: allowed ? [{ name: 'test:prompt' }] : [] });
    const result = await getPrompt({ name: 'test:prompt', args: {}, bearer: 'b' });
    if (allowed) {
      expect(result).toMatchObject({ ok: true, result: { messages: [] } });
      expect(withWorkspace).toHaveBeenCalledWith('ws-A', expect.any(Function));
      expect(render).toHaveBeenCalledTimes(1);
    } else {
      expect(result).toMatchObject({ ok: false, error: { code: 'missing_capability' } });
      expect(withWorkspace).not.toHaveBeenCalled();
      expect(render).not.toHaveBeenCalled();
    }
  });

  it('a scoped wildcard principal cannot discover or render prompts', async () => {
    vi.mocked(resolveBearer).mockResolvedValue({
      ...principalA,
      capabilities: new Set(['*']),
      allowedTools: new Set(['test:echo']),
    });
    const render = vi.fn();
    const prompt = { name: 'test:prompt', description: 'test', capability: 'test:read', tier: 'low' as const, render };
    vi.mocked(getPromptCatalog).mockReturnValue([prompt]);
    vi.mocked(lookupPrompt).mockReturnValue(prompt);
    expect(await listPrompts('b')).toEqual({ ok: true, prompts: [] });
    expect(await getPrompt({ name: 'test:prompt', args: {}, bearer: 'b' }))
      .toMatchObject({ ok: false, error: { code: 'tool_scope_only' } });
    expect(withWorkspace).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });
});

describe('dispatch — control flow', () => {
  it('unknown tool → unknown_tool, never resolves a bearer', async () => {
    vi.mocked(lookup).mockReturnValue(undefined);
    const res = await dispatch({ toolName: 'nope', args: {}, bearer: 'b' });
    expect(res).toMatchObject({ ok: false, error: { code: 'unknown_tool' } });
    expect(resolveBearer).not.toHaveBeenCalled();
  });

  it('unresolvable bearer → invalid_bearer, never runs the handler', async () => {
    vi.mocked(resolveBearer).mockResolvedValue(null);
    const res = await dispatch({ toolName: 'test:echo', args: {}, bearer: 'bad' });
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid_bearer' } });
    expect(handler).not.toHaveBeenCalled();
    expect(withWorkspace).not.toHaveBeenCalled();
  });

  it('principal lacking the capability → missing_capability, handler not run', async () => {
    vi.mocked(resolveBearer).mockResolvedValue({
      ...principalA,
      capabilities: new Set(['something:else']),
    });
    const res = await dispatch({ toolName: 'test:echo', args: {}, bearer: 'b' });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('missing_capability');
    expect(handler).not.toHaveBeenCalled();
  });

  it('enforces an exact PI tool allowlist even when capabilities include the wildcard', async () => {
    vi.mocked(resolveBearer).mockResolvedValue({
      ...principalA,
      capabilities: new Set(['*']),
      allowedTools: new Set(['test:other']),
    });
    const res = await dispatch({ toolName: 'test:echo', args: {}, bearer: 'b' });
    expect(res).toMatchObject({ ok: false, error: { code: 'authorization_denied' } });
    expect(res.error?.message).toContain('not allowed to call tool');
    expect(handler).not.toHaveBeenCalled();
    expect(withWorkspace).not.toHaveBeenCalled();
  });

  it('allows an exact PI-listed tool after the allowlist check', async () => {
    vi.mocked(resolveBearer).mockResolvedValue({
      ...principalA,
      capabilities: new Set(['*']),
      allowedTools: new Set(['test:echo']),
    });
    const res = await dispatch({ toolName: 'test:echo', args: {}, bearer: 'b' });
    expect(res.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('allows an exact PI-listed tool with an explicit capability', async () => {
    vi.mocked(resolveBearer).mockResolvedValue({
      ...principalA,
      allowedTools: new Set(['test:echo']),
    });
    const res = await dispatch({ toolName: 'test:echo', args: {}, bearer: 'b' });
    expect(res.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('an exact PI tool allowlist does not grant a missing capability', async () => {
    vi.mocked(resolveBearer).mockResolvedValue({
      ...principalA,
      capabilities: new Set(['something:else']),
      allowedTools: new Set(['test:echo']),
    });
    const res = await dispatch({ toolName: 'test:echo', args: {}, bearer: 'b' });
    expect(res).toMatchObject({ ok: false, error: { code: 'missing_capability' } });
    expect(handler).not.toHaveBeenCalled();
    expect(withWorkspace).not.toHaveBeenCalled();
  });

  it('an empty PI tool allowlist denies even a wildcard capability', async () => {
    vi.mocked(resolveBearer).mockResolvedValue({
      ...principalA,
      capabilities: new Set(['*']),
      allowedTools: new Set<string>(),
    });
    const res = await dispatch({ toolName: 'test:echo', args: {}, bearer: 'b' });
    expect(res).toMatchObject({ ok: false, error: { code: 'authorization_denied' } });
    expect(handler).not.toHaveBeenCalled();
    expect(withWorkspace).not.toHaveBeenCalled();
  });

  it('a wildcard grant runs an unscoped tool in the bearer workspace', async () => {
    vi.mocked(resolveBearer).mockResolvedValue({
      ...principalA,
      capabilities: new Set(['*']),
    });
    const res = await dispatch({ toolName: 'test:echo', args: {}, bearer: 'b' });
    expect(res.ok).toBe(true);
    expect(withWorkspace).toHaveBeenCalledWith('ws-A', expect.any(Function));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('invalid args → invalid_args, handler not run', async () => {
    vi.mocked(standardValidate).mockResolvedValue({ ok: false, issues: [{ message: 'bad' }] } as never);
    const res = await dispatch({ toolName: 'test:echo', args: { x: 'no' }, bearer: 'b' });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('invalid_args');
    expect(res.error?.message).toBe('bad');
    expect(handler).not.toHaveBeenCalled();
  });

  it('too_big string → message states how far over + the trim target (P-003)', async () => {
    // A Zod too_big issue carries { code, origin, maximum } at runtime; dispatch
    // pairs `maximum` with the actual input length so the agent trims in one retry
    // instead of blind-retrying the same over-length value.
    vi.mocked(standardValidate).mockResolvedValue({
      ok: false,
      issues: [
        {
          message: 'Too big: expected string to have <=500 characters',
          code: 'too_big',
          origin: 'string',
          maximum: 500,
          path: ['goal'],
        },
      ],
    } as never);
    const res = await dispatch({ toolName: 'test:echo', args: { goal: 'x'.repeat(912) }, bearer: 'b' });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('invalid_args');
    expect(res.error?.message).toBe('goal: too long — 412 chars over the 500-char limit; trim to 500.');
  });

  // EI-18889347809692710 — a failed union used to surface as a bare
  // `body: Invalid input`, naming neither the offending element nor the key. Zod
  // reports the union at its OWN path and buries every branch's real diagnosis in
  // `issue.errors`; dispatch now unwraps the branch that got FURTHEST into the
  // structure. Shapes below are the REAL zod v4 output captured from coord:send.
  describe('invalid_union unwrapping (EI-18889347809692710)', () => {
    const unionIssue = (branches: unknown[][]) => ({
      message: 'Invalid input',
      code: 'invalid_union',
      path: ['body'],
      errors: branches,
    });

    it('names the offending element AND key instead of "body: Invalid input"', async () => {
      vi.mocked(standardValidate).mockResolvedValue({
        ok: false,
        issues: [
          unionIssue([
            [{ message: 'Invalid input: expected string, received array', code: 'invalid_type', path: [] }],
            [
              {
                message: 'Invalid input: expected array, received string',
                code: 'invalid_type',
                path: [1, 'couldNotDetermine'],
              },
            ],
          ]),
        ],
      } as never);
      const res = await dispatch({ toolName: 'test:echo', args: {}, bearer: 'b' });
      expect(res.error?.message).toBe(
        'body.1.couldNotDetermine: Invalid input: expected array, received string',
      );
    });

    it('keeps the union\'s OWN message when no branch located a specific field', async () => {
      // The deliberate "string body is refused" teaching message (owner directive
      // 2026-07-28) lives at the union's own path with depth-0 branches — losing it
      // to a branch's terse "expected array, received string" would be a regression.
      vi.mocked(standardValidate).mockResolvedValue({
        ok: false,
        issues: [
          {
            message: '`body` must be an ARRAY of sections — a plain string is no longer accepted.',
            code: 'custom',
            path: ['body'],
            errors: [
              [{ message: 'Invalid input: expected string, received number', code: 'invalid_type', path: [] }],
              [{ message: 'Invalid input: expected array, received number', code: 'invalid_type', path: [] }],
            ],
          },
        ],
      } as never);
      const res = await dispatch({ toolName: 'test:echo', args: {}, bearer: 'b' });
      expect(res.error?.message).toBe(
        'body: `body` must be an ARRAY of sections — a plain string is no longer accepted.',
      );
    });

    it('recurses through a nested union without spinning', async () => {
      vi.mocked(standardValidate).mockResolvedValue({
        ok: false,
        issues: [
          unionIssue([
            [{ message: 'shallow', code: 'invalid_type', path: [] }],
            [
              {
                message: 'Invalid input',
                code: 'invalid_union',
                path: [0, 'premises'],
                errors: [[{ message: 'deep leaf', code: 'invalid_type', path: [2, 'ref'] }]],
              },
            ],
          ]),
        ],
      } as never);
      const res = await dispatch({ toolName: 'test:echo', args: {}, bearer: 'b' });
      expect(res.error?.message).toBe('body.0.premises.2.ref: deep leaf');
    });

    it('a non-union issue is unaffected', async () => {
      vi.mocked(standardValidate).mockResolvedValue({
        ok: false,
        issues: [{ message: 'Invalid input: expected string', code: 'invalid_type', path: ['summary'] }],
      } as never);
      const res = await dispatch({ toolName: 'test:echo', args: {}, bearer: 'b' });
      expect(res.error?.message).toBe('summary: Invalid input: expected string');
    });
  });

  it('handler throw → handler_error carrying the message', async () => {
    vi.mocked(lookup).mockReturnValue(
      makeTool({ handler: vi.fn(async () => { throw new Error('boom'); }) }),
    );
    const res = await dispatch({ toolName: 'test:echo', args: {}, bearer: 'b' });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('handler_error');
    expect(res.error?.message).toBe('boom');
  });

  it('handler SQLSTATE 42P10 → names the relation, conflict target, and deploy skew', async () => {
    const original =
      'there is no unique or exclusion constraint matching the ON CONFLICT specification';
    const pgError = new Error(original);
    Object.defineProperties(pgError, {
      code: { value: '42P10', enumerable: false },
      query: {
        value:
          'INSERT INTO harness_shared.agent_facts (owner_id, key, value) VALUES ($1, $2, $3) ' +
          'ON CONFLICT (owner_id, key) DO UPDATE SET value = excluded.value',
        enumerable: false,
      },
    });
    vi.mocked(lookup).mockReturnValue(
      makeTool({ handler: vi.fn(async () => { throw pgError; }) }),
    );

    const res = await dispatch({ toolName: 'test:echo', args: {}, bearer: 'b' });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('handler_error');
    expect(res.error?.message?.split('\n')[0]).toBe(original);
    expect(res.error?.message).toContain('harness_shared.agent_facts');
    expect(res.error?.message).toContain('(owner_id, key)');
    expect(res.error?.message).toContain('DEPLOY SKEW');
  });

  it('happy path → runs the handler with validated args + a ctx, returns the response', async () => {
    const res = await dispatch({ toolName: 'test:echo', args: { x: 1 }, bearer: 'b' });
    expect(res.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    // handler receives the VALIDATED value (standardValidate.value), not raw args.
    const [value, ctx] = handler.mock.calls[0];
    expect(value).toEqual({ x: 1 });
    expect(ctx.principal).toBe(principalA);
    expect(ctx.tx).toBe(FAKE_TX);
    expect(res.response).toMatchObject({ data: { ws: 'ws-A', tx: FAKE_TX } });
  });
});

describe('unwrapDoubleEncodedArgs — EI-7068 client double-encoding fix', () => {
  it('unwraps { args: "<json-object-string>" } to the parsed object', () => {
    expect(unwrapDoubleEncodedArgs({ args: '{"content":"hi","kind":"note"}' })).toEqual({
      content: 'hi',
      kind: 'note',
    });
  });

  it('passes through a normal args object unchanged', () => {
    const normal = { content: 'hi', kind: 'note' };
    expect(unwrapDoubleEncodedArgs(normal)).toBe(normal);
  });

  it('does NOT unwrap when there are sibling keys alongside "args" (not the degenerate shape)', () => {
    const withSibling = { args: '{"a":1}', other: 'field' };
    expect(unwrapDoubleEncodedArgs(withSibling)).toBe(withSibling);
  });

  it('does NOT unwrap a LEGITIMATE args:{...} object field (only a STRING value triggers it)', () => {
    const realArgsField = { args: { nested: true } };
    expect(unwrapDoubleEncodedArgs(realArgsField)).toBe(realArgsField);
  });

  it('does NOT unwrap when the args string is not valid JSON', () => {
    const bad = { args: 'not json {' };
    expect(unwrapDoubleEncodedArgs(bad)).toBe(bad);
  });

  it('does NOT unwrap when the parsed JSON is an array or a primitive', () => {
    expect(unwrapDoubleEncodedArgs({ args: '[1,2,3]' })).toEqual({ args: '[1,2,3]' });
    expect(unwrapDoubleEncodedArgs({ args: '"just a string"' })).toEqual({ args: '"just a string"' });
    expect(unwrapDoubleEncodedArgs({ args: '42' })).toEqual({ args: '42' });
  });

  it('passes through non-object input (null, array, primitive) unchanged', () => {
    expect(unwrapDoubleEncodedArgs(null)).toBeNull();
    expect(unwrapDoubleEncodedArgs(undefined)).toBeUndefined();
    expect(unwrapDoubleEncodedArgs([1, 2])).toEqual([1, 2]);
    expect(unwrapDoubleEncodedArgs('str')).toBe('str');
  });

  it('dispatch integration: a double-encoded call still reaches the handler with real fields', async () => {
    // standardValidate is mocked to just echo whatever object it receives as `.value`
    // (not literally what production Zod does, but sufficient to prove dispatch
    // handed the UNWRAPPED object to validation, not the degenerate wrapper).
    vi.mocked(standardValidate).mockImplementation(async (_schema: unknown, value: unknown) => ({
      ok: true,
      value,
    }) as never);
    const res = await dispatch({
      toolName: 'test:echo',
      args: { args: '{"x":1}' },
      bearer: 'b',
    });
    expect(res.ok).toBe(true);
    const [value] = handler.mock.calls[0];
    expect(value).toEqual({ x: 1 });
  });
});

describe('dispatch — workspace isolation', () => {
  it('scopes the run to the PRINCIPAL\'s workspace (no caller-supplied workspace channel exists)', async () => {
    await dispatch({ toolName: 'test:echo', args: { x: 1 }, bearer: 'b' });
    expect(withWorkspace).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withWorkspace).mock.calls[0][0]).toBe('ws-A');
  });

  it('a different principal moves the scope — proving it tracks the resolved principal, not the input', async () => {
    vi.mocked(resolveBearer).mockResolvedValue({ ...principalA, workspaceId: 'ws-OTHER' });
    await dispatch({ toolName: 'test:echo', args: { x: 1 }, bearer: 'b' });
    expect(vi.mocked(withWorkspace).mock.calls[0][0]).toBe('ws-OTHER');
  });
});
