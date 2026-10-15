import { describe, expect, it, vi } from 'vitest';
import { operationCallerId, verifiedSpawnSessionAlias } from './agent-tools/coordination/identity';
import {
  canonicalizeAssigneeOwnerId,
  holderIsCaller,
  isTruncatedSuOwnerId,
  resolveHolderOwnerId,
  type OwnerIdPrefixLookup,
} from './work-item-holder-identity';

// EI-23701433507513915 — a truncated su- owner id stored as `taken_by` made every exact
// holder check refuse the real holder. These pin both halves of the shared resolver.

const ME = 'su-851c1a7a-8ea6-4c70-afeb-472e957fd3d8';
const PEER_SAME_5 = 'su-851c1ffe-0000-4000-8000-000000000001'; // shares the 5-char handle 851c1
const OTHER = 'su-3ee17ad9-e8f0-4145-bce5-732819d9ea4e';

function registry(ids: string[]): OwnerIdPrefixLookup & { calls: number } {
  const fn = vi.fn(async ({ prefix, limit }: { prefix: string; limit: number }) =>
    ids.filter((id) => id.startsWith(prefix)).slice(0, limit),
  );
  return Object.assign(fn, {
    get calls() {
      return fn.mock.calls.length;
    },
  }) as unknown as OwnerIdPrefixLookup & { calls: number };
}

describe('isTruncatedSuOwnerId', () => {
  it.each([
    ['su-851c1a7a', true],
    ['su-851c1', true],
    ['su-851c1a7a-8ea6', true],
    ['su-851c1a7a-', true],
  ])('treats %s as a truncated owner id', (v, want) => expect(isTruncatedSuOwnerId(v)).toBe(want));

  it.each([
    [ME, 'a FULL id is not truncated'],
    ['su-85', 'below the minimum body length'],
    ['human', 'a non-su identity'],
    ['s-1a2b3c4d', 'a spawn id'],
    ['su-851c1a7ag', 'a non-hex char in a hex slot'],
    ['su-851c1a7a8', 'a hex char where the template has a hyphen'],
    ['su-XYZW', 'uppercase / non-hex body'],
    ['', 'empty'],
  ])('passes %s through (%s)', (v) => expect(isTruncatedSuOwnerId(v)).toBe(false));

  it('is false for null / undefined', () => {
    expect(isTruncatedSuOwnerId(null)).toBe(false);
    expect(isTruncatedSuOwnerId(undefined)).toBe(false);
  });
});

describe('canonicalizeAssigneeOwnerId (WRITE half)', () => {
  it('expands the recorded incident (su-851c1a7a) to the unique full id', async () => {
    const lookup = registry([ME, OTHER]);
    await expect(canonicalizeAssigneeOwnerId('su-851c1a7a', { lookup })).resolves.toEqual({
      ok: true,
      ownerId: ME,
      expandedFrom: 'su-851c1a7a',
    });
  });

  it('passes a full id and a non-su identity through WITHOUT a lookup', async () => {
    const lookup = registry([ME]);
    await expect(canonicalizeAssigneeOwnerId(ME, { lookup })).resolves.toEqual({ ok: true, ownerId: ME, expandedFrom: null });
    await expect(canonicalizeAssigneeOwnerId('human', { lookup })).resolves.toEqual({
      ok: true,
      ownerId: 'human',
      expandedFrom: null,
    });
    expect(lookup.calls).toBe(0);
  });

  it('refuses an AMBIGUOUS prefix and names every candidate — never picks one', async () => {
    const res = await canonicalizeAssigneeOwnerId('su-851c1', { lookup: registry([ME, PEER_SAME_5]) });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('assignee_short_form_ambiguous');
    expect(res.candidates.sort()).toEqual([ME, PEER_SAME_5].sort());
  });

  it('refuses an UNRESOLVED prefix instead of persisting it', async () => {
    const res = await canonicalizeAssigneeOwnerId('su-deadbeef', { lookup: registry([ME, OTHER]) });
    expect(res).toMatchObject({ ok: false, code: 'assignee_short_form_unresolved', candidates: [] });
  });

  it('ignores lookup rows that are not full ids or do not share the prefix', async () => {
    const lookup: OwnerIdPrefixLookup = async () => ['su-851c1a7a', OTHER, ME];
    await expect(canonicalizeAssigneeOwnerId('su-851c1a7a', { lookup })).resolves.toMatchObject({ ok: true, ownerId: ME });
  });

  it('refuses (never throws) when the lookup itself fails', async () => {
    const lookup: OwnerIdPrefixLookup = async () => {
      throw new Error('pool exhausted');
    };
    const res = await canonicalizeAssigneeOwnerId('su-851c1a7a', { lookup });
    expect(res).toMatchObject({ ok: false, code: 'assignee_short_form_unresolved' });
    if (!res.ok) expect(res.message).toContain('pool exhausted');
  });

  it('passes the workspace scope through to the lookup', async () => {
    const lookup = vi.fn<OwnerIdPrefixLookup>(async () => [ME]);
    await canonicalizeAssigneeOwnerId(' su-851c1a7a ', { workspaceId: 'ws-1', lookup });
    expect(lookup).toHaveBeenCalledWith({ workspaceId: 'ws-1', prefix: 'su-851c1a7a', limit: 3 });
  });

  it("treats the unscoped '*' workspace sentinel as no scope, not a workspace named '*'", async () => {
    const lookup = vi.fn<OwnerIdPrefixLookup>(async () => [ME]);
    await expect(canonicalizeAssigneeOwnerId('su-851c1a7a', { workspaceId: '*', lookup })).resolves.toMatchObject({
      ok: true,
      ownerId: ME,
    });
    expect(lookup).toHaveBeenCalledWith({ workspaceId: null, prefix: 'su-851c1a7a', limit: 3 });
  });
});

describe('resolveHolderOwnerId / holderIsCaller (READ half)', () => {
  it('recognises a signed judge session holding its bare coordination identity', async () => {
    const ctx = { principal: { slug: 'system:judge', authMethod: 'spawn-url', trust: 'trusted' }, uiClientId: ME };
    const caller = operationCallerId(ctx.principal.slug, ME);
    const verifiedCallerAlias = verifiedSpawnSessionAlias(ctx, caller);
    await expect(holderIsCaller(ME, caller, { verifiedCallerAlias })).resolves.toBe(true);
    await expect(holderIsCaller(OTHER, caller, { verifiedCallerAlias })).resolves.toBe(false);
    await expect(holderIsCaller('su-851c1a7a', caller, { verifiedCallerAlias, lookup: registry([ME]) })).resolves.toBe(true);
    await expect(holderIsCaller('su-851c1', caller, { verifiedCallerAlias, lookup: registry([ME, PEER_SAME_5]) })).resolves.toBe(false);
  });

  it.each([
    { slug: 'system:judge', authMethod: 'bearer', trust: 'trusted' },
    { slug: 'system:judge', authMethod: 'spawn-url', trust: 'untrusted' },
    { slug: 'app:judge', authMethod: 'spawn-url', trust: 'trusted' },
  ])('does not grant a caller-chosen client alias under %j', async (principal) => {
    const caller = operationCallerId(principal.slug, ME);
    const verifiedCallerAlias = verifiedSpawnSessionAlias({ principal, uiClientId: ME }, caller);
    expect(verifiedCallerAlias).toBeNull();
    await expect(holderIsCaller(ME, caller, { verifiedCallerAlias })).resolves.toBe(false);
  });

  it('recognises the holder behind a legacy short-form taken_by (the refused-close incident)', async () => {
    const lookup = registry([ME, OTHER]);
    await expect(resolveHolderOwnerId('su-851c1a7a', { lookup })).resolves.toBe(ME);
    await expect(holderIsCaller('su-851c1a7a', ME, { lookup })).resolves.toBe(true);
  });

  it('does NOT grant a bare prefix match: an ambiguous short holder is nobody', async () => {
    const lookup = registry([ME, PEER_SAME_5]);
    await expect(holderIsCaller('su-851c1', ME, { lookup })).resolves.toBe(false);
    await expect(holderIsCaller('su-851c1', PEER_SAME_5, { lookup })).resolves.toBe(false);
    await expect(resolveHolderOwnerId('su-851c1', { lookup })).resolves.toBe('su-851c1');
  });

  it('never matches a caller the stored prefix does not prefix, and skips the lookup', async () => {
    const lookup = registry([ME, OTHER]);
    await expect(holderIsCaller('su-851c1a7a', OTHER, { lookup })).resolves.toBe(false);
    expect(lookup.calls).toBe(0);
  });

  it('keeps exact matching for full ids and returns false for an empty holder', async () => {
    const lookup = registry([]);
    await expect(holderIsCaller(ME, ME, { lookup })).resolves.toBe(true);
    await expect(holderIsCaller(OTHER, ME, { lookup })).resolves.toBe(false);
    await expect(holderIsCaller(null, ME, { lookup })).resolves.toBe(false);
    await expect(holderIsCaller('', ME, { lookup })).resolves.toBe(false);
  });

  it('degrades to the stored value when the lookup fails (no widening on error)', async () => {
    const lookup: OwnerIdPrefixLookup = async () => {
      throw new Error('down');
    };
    await expect(resolveHolderOwnerId('su-851c1a7a', { lookup })).resolves.toBe('su-851c1a7a');
    await expect(holderIsCaller('su-851c1a7a', ME, { lookup })).resolves.toBe(false);
  });
});
