/**
 * Shared helpers for the plan-types:* integration tests: dispatch a projected tool the way an
 * MCP client does and unwrap its payload.
 */
import { expect } from 'vitest';
import { dispatchProjectedTool, lookupByMcpName } from '@papercusp/agent-mcp';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { runWithWorkspace } from '../../../workspace-als';

export type Dispatched = Awaited<ReturnType<typeof dispatchProjectedTool>>;
export type Called = { d: Dispatched; payload: Record<string, unknown> | null };

export function makeCaller(harness: string, runId: string) {
  const ctx = {
    workspaceId: DEFAULT_WORKSPACE_ID,
    harnessSlug: harness,
    runId,
    role: 'su',
    principal: { kind: 'agent', slug: `test:${runId}`, workspaceId: DEFAULT_WORKSPACE_ID },
    gateBypass: { role: true, capability: true, quota: true },
    transport: 'mcp',
    requestedFormat: 'json',
    requestedStructured: true,
  } as never;
  return async function call(tool: string, args: Record<string, unknown>): Promise<Called> {
    const projected = lookupByMcpName(tool);
    expect(projected, `${tool} must be registered in the projection registry`).toBeTruthy();
    // The MCP transport runs every call inside the caller's workspace ALS, and the plan gates
    // read activeWorkspaceId(), not ctx.workspaceId.
    const d = await runWithWorkspace(DEFAULT_WORKSPACE_ID, () =>
      dispatchProjectedTool(projected!, tool, { harness, ...args }, ctx, {}));
    const content = (d.result as { content?: Array<{ text?: string }> } | undefined)?.content;
    const structured = (d.result as { structuredContent?: unknown } | undefined)?.structuredContent;
    let payload: Record<string, unknown> | null = null;
    if (structured && typeof structured === 'object') payload = structured as Record<string, unknown>;
    else if (content?.[0]?.text) {
      try {
        payload = JSON.parse(content[0].text) as Record<string, unknown>;
      } catch {
        payload = { text: content[0].text };
      }
    }
    return { d, payload };
  };
}

export function brief(x: unknown): string {
  return JSON.stringify(x).slice(0, 900);
}

/** A key's value, wherever the dispatch envelope put it (depth <= 4). */
export function findKey(x: unknown, key: string, depth = 0): unknown {
  if (!x || typeof x !== 'object' || depth > 4) return undefined;
  const rec = x as Record<string, unknown>;
  if (key in rec) return rec[key];
  for (const v of Object.values(rec)) {
    const hit = findKey(v, key, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export function expectOk(res: Called): Record<string, unknown> {
  expect(res.payload?.ok, brief({ payload: res.payload, error: res.d.error })).toBe(true);
  return res.payload!;
}

export function expectRefusal(res: Called, code: string): Record<string, unknown> {
  expect(res.payload?.ok === true, brief(res.payload)).toBe(false);
  expect(findKey(res.payload, 'code'), brief(res.payload)).toBe(code);
  return res.payload!;
}
