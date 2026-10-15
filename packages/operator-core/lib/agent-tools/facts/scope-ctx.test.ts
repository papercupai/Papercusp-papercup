/**
 * scope-ctx — unit tests for resolveScopeRefAlias (EI-7371).
 *
 * Evidenced by harness_shared.tool_invocations: 13 identical
 * "facts:assert — scope 'X' requires scope_ref" structural errors
 * (2026-07-02..04), every one caused by a caller supplying the ref under a
 * misnamed key (`scope_ref` snake_case, bare `ref`, or `harness`) that zod
 * silently stripped before the handler ever saw it. All 13 predate the
 * EI-7517 ctx-defaulting fix (landed 2026-07-05 02:40); zero recurrences
 * since — but the wrong-key-name class is independent of ctx defaulting
 * (an EXPLICIT ref was supplied, just under the wrong name) and will recur
 * the moment an agent types `scope_ref` again. This closes that class.
 */
import { describe, expect, it } from 'vitest';
import { resolveScopeRefAlias, resolveScopeRefFromCtx } from './scope-ctx';

describe('resolveScopeRefAlias (EI-7371)', () => {
  it('passes an explicit canonical scopeRef through untouched', () => {
    expect(resolveScopeRefAlias('harness', { scopeRef: 'papercusp' })).toBe('papercusp');
  });

  it('falls back to snake_case scope_ref (observed prod shape)', () => {
    expect(resolveScopeRefAlias('harness', { scope_ref: 'papercusp' })).toBe('papercusp');
  });

  it('falls back to bare ref (observed prod shape)', () => {
    expect(resolveScopeRefAlias('harness', { ref: 'papercusp' })).toBe('papercusp');
  });

  it('falls back to `harness` ONLY when scope is "harness" (observed prod shape)', () => {
    expect(resolveScopeRefAlias('harness', { harness: 'oddsmith' })).toBe('oddsmith');
    // a `harness` arg is meaningless for a non-harness scope — must not leak in.
    expect(resolveScopeRefAlias('owner', { harness: 'oddsmith' })).toBeUndefined();
  });

  it('precedence: scopeRef > scope_ref > ref > harness', () => {
    expect(
      resolveScopeRefAlias('harness', {
        scopeRef: 'canonical',
        scope_ref: 'snake',
        ref: 'bare',
        harness: 'alias',
      }),
    ).toBe('canonical');
    expect(resolveScopeRefAlias('harness', { scope_ref: 'snake', ref: 'bare', harness: 'alias' })).toBe('snake');
    expect(resolveScopeRefAlias('harness', { ref: 'bare', harness: 'alias' })).toBe('bare');
  });

  it('blank/whitespace-only aliases count as omitted, not a value', () => {
    expect(resolveScopeRefAlias('harness', { scopeRef: '  ', scope_ref: 'real' })).toBe('real');
    expect(resolveScopeRefAlias('harness', { scope_ref: '   ', ref: 'real' })).toBe('real');
  });

  it('no alias present: returns the (possibly undefined/null) scopeRef unchanged', () => {
    expect(resolveScopeRefAlias('harness', {})).toBeUndefined();
    expect(resolveScopeRefAlias('harness', { scopeRef: null })).toBeNull();
  });
});

describe('resolveScopeRefFromCtx verified owner alias', () => {
  const sessionId = 'su-f2770245-ddd7-4871-b62c-dd357a505aea';
  const trustedSpawnCtx = {
    principal: {
      kind: 'judge',
      slug: 'system:judge',
      workspaceId: 'papercusp-workspace',
      authMethod: 'spawn-url',
      trust: 'trusted',
    },
    uiClientId: sessionId,
    harnessSlug: 'papercusp',
  };

  it('maps a verified signed system spawn to its bare owner fact scope', async () => {
    await expect(resolveScopeRefFromCtx('owner', undefined, trustedSpawnCtx)).resolves.toBe(sessionId);
  });

  it('keeps an untrusted principal client namespaced', async () => {
    const untrustedCtx = {
      ...trustedSpawnCtx,
      principal: { ...trustedSpawnCtx.principal, authMethod: 'bearer', trust: 'untrusted' },
    };
    await expect(resolveScopeRefFromCtx('owner', undefined, untrustedCtx)).resolves.toBe(`system:judge/${sessionId}`);
  });

  it('preserves explicit owner refs and leaves other scopes unchanged', async () => {
    await expect(resolveScopeRefFromCtx('owner', 'explicit-owner', trustedSpawnCtx)).resolves.toBe('explicit-owner');
    await expect(resolveScopeRefFromCtx('harness', undefined, trustedSpawnCtx)).resolves.toBe('papercusp');
  });
});
