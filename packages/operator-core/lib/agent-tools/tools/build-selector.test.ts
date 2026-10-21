/**
 * Operator side of per-call build routing (plan staging-build-tool-routing-2026-10-21,
 * R-2 / P-002): tools:invoke and tools:find declare `build`; an operator refuses a call
 * whose requested build is not the one it serves (`build_mismatch`) BEFORE the target
 * runs; a matching call's result names the serving build.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('../../telemetry-dispatch-wrapper', () => ({
  dispatchWrapperMarkEnabled: vi.fn(async () => false),
}));

import toolInvoke from './invoke';
import toolFind from './find';
import {
  _resetServingBuildForTest,
  annotateServingBuild,
  assertServingBuild,
  getServingBuild,
  MCP_BUILD_META_KEY,
  MCP_SERVING_BUILD_META_KEY,
  requestedBuildOf,
  resolveServingBuild,
  withMcpBuildFence,
} from '../../serving-build';

type ToolDef = {
  args: { safeParse: (v: unknown) => { success: boolean; data?: Record<string, unknown> } };
  handler: (a: unknown, c?: unknown) => Promise<{ content: Array<{ text: string }>; _meta?: Record<string, unknown> }>;
};
const invokeDef = toolInvoke as unknown as ToolDef;
const findDef = toolFind as unknown as ToolDef;

const savedServingBuild = process.env.PAPERCUSP_SERVING_BUILD;
function serveAs(build: 'main' | 'staging'): void {
  process.env.PAPERCUSP_SERVING_BUILD = build;
  _resetServingBuildForTest();
}
beforeEach(() => serveAs('main'));
afterEach(() => {
  if (savedServingBuild === undefined) delete process.env.PAPERCUSP_SERVING_BUILD;
  else process.env.PAPERCUSP_SERVING_BUILD = savedServingBuild;
  _resetServingBuildForTest();
});

describe('resolveServingBuild — the same port source serving_host uses', () => {
  it('serves staging on the staging port and main everywhere else', () => {
    expect(resolveServingBuild({ PAPERCUSP_HONO_PORT: '3170' })).toBe('staging');
    expect(resolveServingBuild({ PAPERCUSP_HONO_PORT: '3070' })).toBe('main');
    expect(resolveServingBuild({ PORT: '41234' })).toBe('main');
    expect(resolveServingBuild({})).toBe('main');
  });
  it('honours an explicit PAPERCUSP_SERVING_BUILD declaration', () => {
    expect(resolveServingBuild({ PAPERCUSP_SERVING_BUILD: 'staging', PAPERCUSP_HONO_PORT: '3070' })).toBe('staging');
    expect(resolveServingBuild({ PAPERCUSP_SERVING_BUILD: 'bogus', PAPERCUSP_HONO_PORT: '3170' })).toBe('staging');
  });
});

describe('tools:invoke and tools:find declare build', () => {
  it('accepts build on both schemas and rejects an unknown build value', () => {
    expect(invokeDef.args.safeParse({ name: 'coord:presence', build: 'staging' }).success).toBe(true);
    expect(invokeDef.args.safeParse({ name: 'coord:presence', build: 'main' }).success).toBe(true);
    expect(invokeDef.args.safeParse({ name: 'coord:presence', build: 'prod' }).success).toBe(false);
    expect(findDef.args.safeParse({ query: 'set a flag', build: 'staging' }).success).toBe(true);
    expect(findDef.args.safeParse({ query: 'set a flag', build: 'prod' }).success).toBe(false);
  });
});

describe('tools:invoke refuses build_mismatch before the target runs', () => {
  it('a build:staging call on a main operator never dispatches', async () => {
    const dispatchTool = vi.fn();
    await expect(
      invokeDef.handler({ name: 'coord:presence', args: {}, build: 'staging' }, { dispatchTool }),
    ).rejects.toThrow(/^build_mismatch: .*'staging'.*serves 'main'/);
    expect(dispatchTool).not.toHaveBeenCalled();
  });

  it('a matching call dispatches and its result names the serving build', async () => {
    serveAs('staging');
    const dispatchTool = vi.fn(async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }));
    const r = await invokeDef.handler({ name: 'coord:presence', args: {}, build: 'staging' }, { dispatchTool });
    expect(dispatchTool).toHaveBeenCalledWith('coord:presence', {});
    expect(r._meta?.[MCP_SERVING_BUILD_META_KEY]).toBe('staging');
  });

  it('a call without build behaves exactly as before', async () => {
    const dispatchTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'x' }] }));
    const r = await invokeDef.handler({ name: 'coord:presence', args: {} }, { dispatchTool });
    expect(dispatchTool).toHaveBeenCalledOnce();
    expect(r._meta?.[MCP_SERVING_BUILD_META_KEY]).toBeUndefined();
  });
});

describe('tools:find refuses build_mismatch', () => {
  it('a build:staging search on a main operator is refused before the catalog is read', async () => {
    await expect(findDef.handler({ query: 'set a flag', build: 'staging' }, {})).rejects.toThrow(/^build_mismatch:/);
  });
});

describe('withMcpBuildFence — the tools/call fence for every tool', () => {
  const req = (name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) => ({
    params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
  });

  it('refuses a _meta-stamped staging call on main without running the handler', async () => {
    const handler = vi.fn(async () => ({ content: [] }));
    const fenced = withMcpBuildFence(handler, () => 'main');
    await expect(fenced(req('coord:presence', {}, { [MCP_BUILD_META_KEY]: 'staging' }), {})).rejects.toThrow(
      /^build_mismatch:/,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses an argument/_meta disagreement', async () => {
    const handler = vi.fn(async () => ({ content: [] }));
    const fenced = withMcpBuildFence(handler, () => 'staging');
    await expect(
      fenced(req('coord:presence', { build: 'main' }, { [MCP_BUILD_META_KEY]: 'staging' }), {}),
    ).rejects.toThrow(/^build_selector_conflict:/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('strips build from a tool that does not declare it, keeps it on tools:invoke, and names the build', async () => {
    const seen: unknown[] = [];
    const handler = vi.fn(async (r: { params: { arguments: unknown } }) => {
      seen.push(structuredClone(r.params.arguments));
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    const fenced = withMcpBuildFence(handler, () => 'staging');
    const direct = (await fenced(req('coord:presence', { scope: 'hive', build: 'staging' }), {})) as unknown as {
      content: Array<{ text: string }>;
      _meta: Record<string, unknown>;
    };
    expect(seen[0]).toEqual({ scope: 'hive' });
    expect(direct.content.at(-1)!.text).toMatch(/^⟦build⟧ served by build 'staging'/);
    expect(direct._meta[MCP_SERVING_BUILD_META_KEY]).toBe('staging');
    await fenced(req('tools:invoke', { name: 'a:b', build: 'staging' }), {});
    expect(seen[1]).toEqual({ name: 'a:b', build: 'staging' });
  });

  it('passes a call that names no build through untouched', async () => {
    const result = { content: [{ type: 'text', text: 'ok' }] };
    const handler = vi.fn(async () => result);
    const fenced = withMcpBuildFence(handler, () => 'main');
    expect(await fenced(req('coord:presence', { scope: 'hive' }), {})).toBe(result);
  });
});

describe('serving-build helpers', () => {
  it('reads the _meta stamp first, then the argument', () => {
    expect(requestedBuildOf({ params: { arguments: { build: 'staging' } } })).toEqual({ build: 'staging', conflict: false });
    expect(requestedBuildOf({ params: { _meta: { [MCP_BUILD_META_KEY]: 'main' } } })).toEqual({ build: 'main', conflict: false });
    expect(requestedBuildOf({ params: {} })).toEqual({ build: null, conflict: false });
  });
  it('assertServingBuild returns the build, refuses a mismatch, and passes undefined', () => {
    expect(getServingBuild()).toBe('main');
    expect(assertServingBuild('main')).toBe('main');
    expect(assertServingBuild(undefined)).toBeNull();
    expect(() => assertServingBuild('staging')).toThrow(/^build_mismatch:/);
    expect(() => assertServingBuild('prod')).toThrow(/^invalid_build:/);
  });
  it('annotateServingBuild leaves non-content results alone', () => {
    const odd = { notContent: true };
    expect(annotateServingBuild(odd, 'main')).toBe(odd);
  });
});
