import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { directedImplementerConfinement } from './session-confinement';
import {
  checkSessionConfinement,
  hasSessionConfinementResolver,
  setSessionConfinementResolver,
  sessionAllowsAmbientContext,
  sessionPromptPolicy,
} from './session-confinement-port';

const CONFINEMENT = directedImplementerConfinement({
  directorSid: 'su-director-1',
  scope: 'WI-1234',
});

/** A ctx at maximum privilege — the case every other rail exempts. */
const SUPERUSER_CTX = {
  isSuperuser: true,
  isPowerUser: true,
  role: 'cup',
} as unknown as UnifiedToolContext;

const PLAIN_CTX = { isSuperuser: false } as unknown as UnifiedToolContext;

afterEach(() => setSessionConfinementResolver(undefined));

describe('ambient context uses the same authoritative session policy', () => {
  it('derives workflow ownership from the immutable exact-item ceiling without caller options', async () => {
    const confinement = { denyTools: [], denyOutside: ['coord:whoami'], denyAmbientContext: true as const,
      denyWorkItemsOutside: { id: 'F-own', harness: 'bench', checkout: '/private/assignment' },
      imposedBy: 'host', reason: 'frozen assignment' };
    const resolver = vi.fn(() => confinement);
    setSessionConfinementResolver(resolver);
    const input = { ownerId: 'su-private', workspaceId: 'private' };
    expect(await sessionPromptPolicy(input)).toEqual({ ambientContextAllowed: false, workItemWorkflow: 'host-managed' });
    expect(resolver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ uiClientId: input.ownerId, workspaceId: input.workspaceId }));
    for (const tool of ['work_items:get', 'work_items:checkpoint', 'work_items:complete', 'plans:get']) {
      setSessionConfinementResolver(() => ({ ...confinement, denyOutside: [...confinement.denyOutside, tool] }));
      expect((await sessionPromptPolicy(input)).workItemWorkflow).toBe('agent-managed');
    }
    setSessionConfinementResolver(() => ({ ...confinement, denyWorkItemsOutside: undefined }));
    expect((await sessionPromptPolicy(input)).workItemWorkflow).toBe('agent-managed');
    setSessionConfinementResolver(() => ({ ...confinement, denyWorkItemsOutside: { ...confinement.denyWorkItemsOutside, harness: '../escape' } }));
    await expect(sessionPromptPolicy(input)).rejects.toThrow(/workflow/);
  });
  it('refuses bound prompt policy when authority is unreadable, while unbound launches retain normal guidance', async () => {
    expect(await sessionPromptPolicy({ workspaceId: 'private' })).toEqual({ ambientContextAllowed: true, workItemWorkflow: 'agent-managed' });
    await expect(sessionPromptPolicy({ ownerId: 'su-private', workspaceId: 'private' })).rejects.toThrow(/policy/);
    setSessionConfinementResolver(() => { throw new Error('unreadable'); });
    await expect(sessionPromptPolicy({ ownerId: 'su-private', workspaceId: 'private' })).rejects.toThrow(/unreadable/);
  });
  it('uses caller arguments only as the target, with the scope resolved from host state', async () => {
    setSessionConfinementResolver(() => ({ denyTools: [], denyOutside: ['work_items:get'],
      denyWorkItemsOutside: { id: 'F-own', harness: 'bench', checkout: '/private/assignment' }, imposedBy: 'host', reason: 'assignment' }));
    expect(await checkSessionConfinement({ toolName: 'work_items:get', ctx: SUPERUSER_CTX,
      args: { id: 'F-own', harness: 'bench' } })).toBeNull();
    expect(await checkSessionConfinement({ toolName: 'work_items:get', ctx: SUPERUSER_CTX,
      args: { id: 'F-other', harness: 'bench', confinement: { denyWorkItemsOutside: { id: 'F-other', harness: 'bench' } } } }))
      .toMatchObject({ decision: 'deny' });
  });
  it('permits checkout proof and missing local files but refuses symlink proof outside it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'confined-proof-'));
    const outside = mkdtempSync(join(tmpdir(), 'neighbor-proof-'));
    writeFileSync(join(root, 'local.ts'), 'local'); writeFileSync(join(outside, 'secret.ts'), 'neighbor');
    symlinkSync(outside, join(root, 'escape'));
    setSessionConfinementResolver(() => ({ denyTools: [], denyOutside: ['work_items:complete'],
      denyWorkItemsOutside: { id: 'F-own', harness: 'bench', checkout: root }, imposedBy: 'host', reason: 'assignment' }));
    const check = (filesChanged: string[]) => checkSessionConfinement({ toolName: 'work_items:complete', ctx: SUPERUSER_CTX,
      args: { id: 'F-own', harness: 'bench', state: 'done', assumptions: 'none', completion: { summary: 'implemented', filesChanged } } });
    try {
      expect(await check(['local.ts', 'missing.ts'])).toBeNull();
      expect(await check(['escape/secret.ts'])).toMatchObject({ decision: 'deny' });
      expect(await check(['escape/missing.ts'])).toMatchObject({ decision: 'deny' });
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });
  it('suppresses pinned native context without a host resolver while preserving unbound conversations', async () => {
    setSessionConfinementResolver(undefined);
    expect(await sessionAllowsAmbientContext({ ownerId: 'su-frozen', workspaceId: 'private' })).toBe(false);
    expect(await sessionAllowsAmbientContext({ workspaceId: 'private' })).toBe(true);
  });
  it('suppresses frozen-only context and identifies the exact workspace/session', async () => {
    const resolver = vi.fn(() => ({ ...CONFINEMENT, denyAmbientContext: true as const }));
    setSessionConfinementResolver(resolver);
    expect(await sessionAllowsAmbientContext({ ownerId: 'su-frozen', workspaceId: 'private' })).toBe(false);
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ uiClientId: 'su-frozen', workspaceId: 'private' }));
  });
  it('suppresses context if readiness or the authoritative read fails', async () => {
    setSessionConfinementResolver(() => { throw new Error('read unavailable'); });
    expect(await sessionAllowsAmbientContext({ ownerId: 'su-frozen', workspaceId: 'private' })).toBe(false);
    setSessionConfinementResolver(() => null, { ensureReady: async () => { throw new Error('not ready'); } });
    expect(await sessionAllowsAmbientContext({ ownerId: 'su-frozen', workspaceId: 'private' })).toBe(false);
  });
  it('reads policy again rather than trusting an earlier unconfined result', async () => {
    const resolver = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ ...CONFINEMENT, denyAmbientContext: true });
    setSessionConfinementResolver(resolver);
    const input = { ownerId: 'su-frozen', workspaceId: 'private' };
    expect(await sessionAllowsAmbientContext(input)).toBe(true);
    expect(await sessionAllowsAmbientContext(input)).toBe(false);
  });
});

describe('session-confinement port — inertness when nothing is declared', () => {
  it('is null with no resolver installed', async () => {
    // Explicit, not assumed: the port's state is pinned to globalThis (pinModuleState), so it
    // is per-PROCESS, and a sibling test file that imports the store installs a resolver into
    // the same pin. Asserting a clean slate here would make this test pass or fail on file
    // ORDER. The invariant under test is "no resolver ⇒ null", so establish that precondition.
    setSessionConfinementResolver(undefined);
    expect(hasSessionConfinementResolver()).toBe(false);
    await expect(
      checkSessionConfinement({ toolName: 'work_items:complete', ctx: PLAIN_CTX }),
    ).resolves.toBeNull();
  });

  it('is null when the resolver reports an unconfined session', async () => {
    setSessionConfinementResolver(() => null);
    await expect(
      checkSessionConfinement({ toolName: 'work_items:complete', ctx: PLAIN_CTX }),
    ).resolves.toBeNull();
  });

  it('is null for a permitted tool in a confined session', async () => {
    setSessionConfinementResolver(() => CONFINEMENT);
    await expect(
      checkSessionConfinement({ toolName: 'work_items:checkpoint', ctx: PLAIN_CTX }),
    ).resolves.toBeNull();
  });
});

describe('session-confinement port — the deny', () => {
  it('returns a deny verdict the dispatcher can short-circuit on', async () => {
    setSessionConfinementResolver(() => CONFINEMENT);
    const v = await checkSessionConfinement({ toolName: 'work_items:complete', ctx: PLAIN_CTX });
    expect(v).not.toBeNull();
    expect(v?.decision).toBe('deny');
    expect(v?.posture).toBe('rejected');
    expect(v?.applied).toBe(true);
    expect(v?.reason).toContain('su-director-1');
  });

  // ── THE POINT OF THE WHOLE EXERCISE ─────────────────────────────────────────
  // evaluateCapabilityEnvelope returns { applied:false } on isSuperuser||isPowerUser
  // BEFORE it reads the role, which is why ROLE_ENVELOPES cannot bind a directed
  // implementer (D-015 ¶2). If this test ever goes green-by-exemption, the rail is
  // theatre again and P-003 has silently regressed.
  it('DENIES a full superuser + power-user session — privilege does not exempt', async () => {
    setSessionConfinementResolver(() => CONFINEMENT);
    const v = await checkSessionConfinement({ toolName: 'work_items:complete', ctx: SUPERUSER_CTX });
    expect(v?.decision).toBe('deny');
  });

  it('denies the mangled MCP spelling at maximum privilege too', async () => {
    setSessionConfinementResolver(() => CONFINEMENT);
    const v = await checkSessionConfinement({
      toolName: 'mcp__papercusp-su__work_items_complete',
      ctx: SUPERUSER_CTX,
    });
    expect(v?.decision).toBe('deny');
  });

  it('admits only the declared hook origin to the released-operation continuation handler', async () => {
    setSessionConfinementResolver(() => ({ ...CONFINEMENT, denyOutside: ['work_items:get'] }));
    const toolName = 'sessions:continue-released-operation';
    const hookCtx = { ...SUPERUSER_CTX,
      requestOrigin: { transport: 'mcp', query: { origin: 'hook' } } } as UnifiedToolContext;
    const modelCtx = { ...SUPERUSER_CTX,
      requestOrigin: { transport: 'mcp', query: { origin: 'agent' } } } as UnifiedToolContext;
    await expect(checkSessionConfinement({ toolName, ctx: hookCtx })).resolves.toBeNull();
    await expect(checkSessionConfinement({ toolName, ctx: modelCtx })).resolves.toMatchObject({ decision: 'deny' });
  });

  it('passes the ctx to the resolver so it can key on the calling session', async () => {
    const resolver = vi.fn(() => CONFINEMENT);
    setSessionConfinementResolver(resolver);
    await checkSessionConfinement({ toolName: 'work_items:complete', ctx: SUPERUSER_CTX });
    expect(resolver).toHaveBeenCalledWith(SUPERUSER_CTX);
  });
});

describe('session-confinement port — a broken resolver', () => {
  it('does not take down dispatch, and says so loudly rather than silently', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    setSessionConfinementResolver(() => {
      throw new Error('resolver exploded');
    });
    await expect(
      checkSessionConfinement({ toolName: 'work_items:complete', ctx: PLAIN_CTX }),
    ).resolves.toMatchObject({ decision: 'deny', posture: 'rejected' });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

// ── The priming hook (D-017 §4) ───────────────────────────────────────────────
// Launch ORDERING closes the cold-cache window for a normal pair launch, but not for an
// operator RESTART with a confined session already live. `ensureReady` is what covers that
// case, so these pin that it actually runs before the verdict — and that a broken one
// degrades to unconfined rather than taking every dispatch on the box down.
describe('session-confinement port — priming', () => {
  it('denies an async authoritative read failure even when no policy was cached', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    setSessionConfinementResolver(async () => { throw new Error('unavailable'); });
    await expect(checkSessionConfinement({ toolName: 'capability:bash', ctx: SUPERUSER_CTX }))
      .resolves.toMatchObject({ decision: 'deny', applied: true });
    log.mockRestore();
  });
  it('denies a cold priming failure before consulting an empty cache', async () => {
    const resolve = vi.fn(() => null);
    setSessionConfinementResolver(resolve, { ensureReady: async () => { throw new Error('unavailable'); } });
    await expect(checkSessionConfinement({ toolName: 'capability:bash', ctx: SUPERUSER_CTX }))
      .resolves.toMatchObject({ decision: 'deny', applied: true });
    expect(resolve).not.toHaveBeenCalled();
  });
  it('awaits ensureReady BEFORE consulting the resolver', async () => {
    const order: string[] = [];
    setSessionConfinementResolver(
      () => {
        order.push('resolve');
        return CONFINEMENT;
      },
      {
        ensureReady: async () => {
          order.push('prime');
        },
      },
    );
    const v = await checkSessionConfinement({ toolName: 'work_items:complete', ctx: PLAIN_CTX });
    expect(v?.decision).toBe('deny');
    expect(order).toEqual(['prime', 'resolve']);
  });

  it('still evaluates when priming fails — a broken store must not deny every dispatch', async () => {
    setSessionConfinementResolver(() => CONFINEMENT, {
      ensureReady: async () => {
        throw new Error('pg down');
      },
    });
    const v = await checkSessionConfinement({ toolName: 'work_items:complete', ctx: PLAIN_CTX });
    expect(v?.decision).toBe('deny');
  });

  it('clears the priming hook when the resolver is cleared', async () => {
    const ensureReady = vi.fn(async () => {});
    setSessionConfinementResolver(() => CONFINEMENT, { ensureReady });
    await checkSessionConfinement({ toolName: 'work_items:complete', ctx: PLAIN_CTX });
    expect(ensureReady).toHaveBeenCalledTimes(1);

    setSessionConfinementResolver(() => CONFINEMENT);
    await checkSessionConfinement({ toolName: 'work_items:complete', ctx: PLAIN_CTX });
    expect(ensureReady).toHaveBeenCalledTimes(1);
  });
});
