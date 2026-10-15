/**
 * substrate:revoke_contributor tool — metadata, args schema, and the
 * delegate-and-wrap handler contract.
 *
 * The GitHub branch-delete logic lives in
 * `@/lib/sync/hyperbee/revoke-contributor` (covered by `revoke-contributor.test.ts`
 * there). This tests only the MCP surface.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VALID = { workspaceId: 'ws1', harnessSlug: 'papercup', githubUserId: 12345 };

const VALID_HIVE = { workspaceId: 'ws1', potSlug: 'acme-hive', githubUserId: 12345 };

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.doUnmock('../../../sync/hyperbee/revoke-contributor');
  vi.doUnmock('../../../hive-revoke-contributor');
});

async function loadTool(revokeContributorViaGithub = vi.fn(), revokeHiveContributor = vi.fn()) {
  vi.doMock('../../../sync/hyperbee/revoke-contributor', () => ({ revokeContributorViaGithub }));
  vi.doMock('../../../hive-revoke-contributor', () => ({ revokeHiveContributor }));
  const { default: tool } = await import('../revoke-contributor');
  return tool;
}

describe('substrate:revoke_contributor tool', () => {
  it('exposes the expected metadata + a non-empty guidance.when (tools-md-sync gate)', async () => {
    const tool = await loadTool();
    expect(tool.name).toBe('substrate:revoke_contributor');
    expect(tool.capability).toBe('intel:write');
    expect(typeof tool.guidance?.when).toBe('string');
    expect((tool.guidance?.when ?? '').length).toBeGreaterThan(0);
    expect(tool.agentRoles).toContain('operator');
  });

  it('args schema accepts a valid numeric githubUserId', async () => {
    const tool = await loadTool();
    expect(tool.args.safeParse(VALID).success).toBe(true);
  });

  it('args schema rejects non-numeric / non-positive / non-integer github user ids', async () => {
    const tool = await loadTool();
    expect(tool.args.safeParse({ ...VALID, githubUserId: 'alice' }).success).toBe(false);
    expect(tool.args.safeParse({ ...VALID, githubUserId: -1 }).success).toBe(false);
    expect(tool.args.safeParse({ ...VALID, githubUserId: 1.5 }).success).toBe(false);
    expect(tool.args.safeParse({ workspaceId: 'ws1', harnessSlug: 'papercup' }).success).toBe(false);
  });

  it('handler delegates to revokeContributorViaGithub and wraps the result', async () => {
    const result = { ok: true, deleted: true, branch: 'user/12345' };
    const revoke = vi.fn(async () => result);
    const tool = await loadTool(revoke);
    const res = await tool.handler(VALID, {} as never);
    expect(revoke).toHaveBeenCalledWith(VALID);
    expect(res).toEqual({ content: [{ type: 'text', text: JSON.stringify(result) }] });
  });

  it('passes a not_admin failure through verbatim', async () => {
    const result = { ok: false, code: 'not_admin' };
    const tool = await loadTool(vi.fn(async () => result));
    const res = (await tool.handler(VALID, {} as never)) as { content: { text: string }[] };
    expect(JSON.parse(res.content[0].text)).toEqual(result);
  });

  // ── P-006: Hive-scope generalization ──────────────────────────────────────
  it('args schema accepts a Hive-scoped invocation (potSlug instead of harnessSlug)', async () => {
    const tool = await loadTool();
    expect(tool.args.safeParse(VALID_HIVE).success).toBe(true);
  });

  it('args schema rejects BOTH harnessSlug and potSlug (exactly one scope)', async () => {
    const tool = await loadTool();
    expect(
      tool.args.safeParse({ ...VALID, potSlug: 'acme-hive' }).success,
    ).toBe(false);
  });

  it('args schema rejects NEITHER harnessSlug nor potSlug (a scope is required)', async () => {
    const tool = await loadTool();
    expect(tool.args.safeParse({ workspaceId: 'ws1', githubUserId: 12345 }).success).toBe(false);
  });

  it('Hive scope delegates to revokeHiveContributor (NOT the harness revoke)', async () => {
    const harnessRevoke = vi.fn();
    const hiveResult = { ok: true, revokedPubkeys: ['pk1', 'pk2'], live: false };
    const hiveRevoke = vi.fn(async () => hiveResult);
    const tool = await loadTool(harnessRevoke, hiveRevoke);
    const res = (await tool.handler(VALID_HIVE, {} as never)) as { content: { text: string }[] };
    expect(hiveRevoke).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      potHomeSlug: 'acme-hive',
      githubUserId: 12345,
    });
    expect(harnessRevoke).not.toHaveBeenCalled();
    expect(JSON.parse(res.content[0].text)).toEqual(hiveResult);
  });

  // WI-10006415: a single-device revoke is Hive-scoped and forwarded verbatim.
  it('accepts devicePubkey with potSlug and refuses it with harnessSlug', async () => {
    const tool = await loadTool();
    expect(tool.args.safeParse({ ...VALID_HIVE, devicePubkey: 'vm-pk' }).success).toBe(true);
    expect(tool.args.safeParse({ ...VALID, devicePubkey: 'vm-pk' }).success).toBe(false);
    expect(tool.args.safeParse({ ...VALID_HIVE, devicePubkey: '' }).success).toBe(false);
  });

  it('Hive scope forwards devicePubkey to revokeHiveContributor', async () => {
    const hiveRevoke = vi.fn(async () => ({ ok: true, revokedPubkeys: ['vm-pk'], live: false }));
    const tool = await loadTool(vi.fn(), hiveRevoke);
    await tool.handler({ ...VALID_HIVE, devicePubkey: 'vm-pk' }, {} as never);
    expect(hiveRevoke).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      potHomeSlug: 'acme-hive',
      githubUserId: 12345,
      devicePubkey: 'vm-pk',
    });
  });
});
