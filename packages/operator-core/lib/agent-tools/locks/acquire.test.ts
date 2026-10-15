/**
 * acquire.test.ts — the locks:acquire HANDLER, the fleet's hot file-claim path. The
 * blocking WAIT loop (timers + the grant cascade) is integration-tier and not covered
 * here; this pins the unit-testable branches that decide the OUTCOME:
 *   • normalizePaths rejection → { ok:false, error } (no acquire attempted);
 *   • fast-path success → the ok() projection (lock_id, echoed owner, ISO expiry, held);
 *   • fast-path busy with no wait/wake → busy();
 *   • a WorkspaceContendedError from the routing layer → a structured empty busy (never a
 *     raw PG error leaked to the agent);
 *   • wake_on_grant: queued_for_wake (ticket + await registered), self_granted → ok, and
 *     a failed waiter insert → the reason.
 * Everything is mocked so the handler is isolated to its own control flow.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/acquire.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

// WI-38252: file-lock surfaces resolve their default domain via
// readFileLockIdentity (the tree agents EDIT); readIdentity stays exported for
// the resource-lock surfaces. Both names resolve to one fn here.
vi.mock('./identity', () => {
  const identity = vi.fn(() => ({ ownerId: 'me', ownerLabel: 'Me', coordinationDomain: 'dom' }));
  return { readIdentity: identity, readFileLockIdentity: identity };
});
vi.mock('./coordination-domain', () => ({ resolveExplicitFileLockDomain: vi.fn((requested: string | undefined, fallback: string) => requested ?? fallback) }));
vi.mock('./enrich-busy', () => ({ enrichBusy: vi.fn(async (b: unknown) => b) }));
vi.mock('./in-workspace-txn', () => {
  class WorkspaceContendedError extends Error {}
  return {
    WorkspaceContendedError,
    inWorkspaceTxn: vi.fn(async (_d: string, _o: string, fn: (tx: unknown) => unknown) => fn({})),
  };
});
vi.mock('./su-lock-store', () => ({
  normalizePaths: vi.fn((p: string[]) => p),
  tryAcquire: vi.fn(),
  tryInsertWaiter: vi.fn(),
  getTxPool: vi.fn(() => ({})),
  readQueue: vi.fn(),
  readWaiterStatus: vi.fn(),
  expireWaiter: vi.fn(),
  pokeWorkspace: vi.fn(),
}));
vi.mock('./workspace-listener', () => {
  class TooManyActiveWorkspacesError extends Error {}
  return { subscribeWorkspace: vi.fn(), TooManyActiveWorkspacesError };
});
vi.mock('./lock-grant-bridge', () => ({ ensureGrantListener: vi.fn(), lockGrantKey: vi.fn((t: string) => `grant:${t}`) }));
vi.mock('../../events/await/handle', () => ({ captureWakeHandleForOwner: vi.fn(async () => ({ handle: {}, note: 'wake-note' })) }));
vi.mock('../../events/await/store', () => ({ registerAwait: vi.fn(async () => ({ id: 'A1' })) }));
vi.mock('../../events/await/engine', () => ({ startAwaitSweeper: vi.fn() }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ workspaceId: 'ws-1' })) }));
vi.mock('../../agent-state-stamp', () => ({
  readAgentStateStamp: vi.fn(() => ({ intentEventId: null, assumptionSetId: null, goalRef: 'WI-current' })),
}));
vi.mock('../../authority/file-lock-routing', () => ({ routeFileLockOp: vi.fn() }));
vi.mock('../../authority/file-lock-authority-ops', async () => ({
  ...(await vi.importActual<typeof import('../../authority/file-lock-authority-ops')>('../../authority/file-lock-authority-ops')),
  FILE_LOCK_OP_KINDS: { acquire: 'acquire' },
  // Real (not stubbed) fan-out so WI-1550 coverage below can assert on the
  // resulting recordLockEvent calls, not just that some mock fired.
  emitAcquireLockEvents: vi.fn((emit: (e: unknown) => void, p: { scope: string; owner: string; paths: string[]; expiresAtMs: number; ts: number }) => {
    for (const path of p.paths) emit({ kind: 'acquire', scope: p.scope, path, owner: p.owner, expiresAtMs: p.expiresAtMs, ts: p.ts });
  }),
}));
vi.mock('../../authority/lock-event-stream', () => ({ recordLockEvent: vi.fn() }));

import { normalizePaths, tryInsertWaiter, readWaiterStatus, pokeWorkspace, expireWaiter, tryAcquire } from './su-lock-store';
import { inWorkspaceTxn, WorkspaceContendedError } from './in-workspace-txn';
import { routeFileLockOp } from '../../authority/file-lock-routing';
import { recordLockEvent } from '../../authority/lock-event-stream';
import { resolveExplicitFileLockDomain } from './coordination-domain';
import { readAgentStateStamp } from '../../agent-state-stamp';
import { MAX_LOCK_TTL_SEC } from './lock-config';
import { registerAwait } from '../../events/await/store';
import type { AwaitRow } from '../../events/await/types';
const normM = vi.mocked(normalizePaths);
const insertM = vi.mocked(tryInsertWaiter);
const txnM = vi.mocked(inWorkspaceTxn);
const routeM = vi.mocked(routeFileLockOp);
const recordEventM = vi.mocked(recordLockEvent);
const statusM = vi.mocked(readWaiterStatus);
const pokeM = vi.mocked(pokeWorkspace);
const expireM = vi.mocked(expireWaiter);
const tryAcquireM = vi.mocked(tryAcquire);
const resolveDomainM = vi.mocked(resolveExplicitFileLockDomain);
const readStampM = vi.mocked(readAgentStateStamp);
const tool = (await import('./acquire')).default;
const warningRoot = mkdtempSync(join(tmpdir(), 'locks-acquire-warning-'));

describe('hook operation acquire API', () => {
  const operation = { id: '71d933be-413a-48b0-83af-8856650a917b', deadline: '2026-06-05T00:30:00Z', authority: 'original' };
  const request = { paths: ['a.ts'], intent: 'PreToolUse:Edit', hook_operation: operation };

  it('never falls back to a local grant after an operation route fails', async () => {
    routeM.mockRejectedValue(new Error('lost reply'));
    const result = body(await call(request));
    expect(result).toMatchObject({ ok: false, reason: 'operation_authority_unknown', operation_id: operation.id });
    expect(tryAcquireM).not.toHaveBeenCalled();
    expect(insertM).not.toHaveBeenCalled();
  });

  it('returns authority preparation without entering the ordinary waiter queue', async () => {
    routeM.mockImplementation(async (_domain, op) => ({ value: op.authorityFence!.prepare('pinned') , via: 'local-authority' }));
    expect(body(await call({ ...request, hook_operation: { ...operation, authority: undefined } })))
      .toMatchObject({ ok: false, reason: 'operation_authority_required', operation_authority: 'pinned' });
    expect(tryAcquireM).not.toHaveBeenCalled();
    expect(insertM).not.toHaveBeenCalled();
  });

  it('preserves operation expiry and terminal refusal instead of creating a legacy waiter', async () => {
    routeM.mockResolvedValue({ value: { ok: false, reason: 'operation_finished', operation_id: operation.id }, via: 'remote-authority' });
    expect(body(await call({ ...request, wait: { max_sec: 30 } }))).toMatchObject({ ok: false, reason: 'operation_finished' });
    expect(insertM).not.toHaveBeenCalled();
  });

  it('refuses hook operations on deliberate acquires and asynchronous wake queues', async () => {
    for (const args of [{ ...request, intent: 'deliberate edit' }, { ...request, wake_on_grant: true }]) {
      expect(body(await call(args))).toMatchObject({ ok: false, reason: 'operation_conflict' });
    }
    expect(routeM).not.toHaveBeenCalled();
  });
});

beforeAll(() => {
  writeFileSync(join(warningRoot, 'existing.ts'), 'export const existing = true;\n');
});

afterAll(() => {
  rmSync(warningRoot, { recursive: true, force: true });
});

/** postgres-js's own shape for a connection drop mid-query (EI-19324204900062056). */
const connectionClosedError = () =>
  Object.assign(new Error('write CONNECTION_CLOSED 127.0.0.1:6432'), { code: 'CONNECTION_CLOSED' });

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown>) =>
  tool.handler({ paths: ['a.ts'], intent: 'edit', ...args } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  normM.mockImplementation((p) => p);
});

describe('locks:acquire — outcome branches', () => {
  it('opts out of the ambient workspace transaction because the handler owns its DB scopes', () => {
    expect((tool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('guidance describes managed Codex hook support plus explicit-lock fallback', () => {
    const guidance = `${tool.guidance?.when ?? ''}\n${tool.guidance?.notWhen ?? ''}`;
    expect(guidance).toMatch(/managed Codex\/Claude\/OMP homes hook apply_patch\/Edit\/Write/);
    expect(guidance).toMatch(/lacks lock hooks/);
    expect(guidance).not.toMatch(/automatic on every client/);
    expect(guidance).not.toMatch(/single incidental edit needs no manual call/);
  });

  it('documents that goal_ref is server-derived rather than a caller argument', () => {
    expect(tool.description).toMatch(/Do not pass a top-level `goal_ref`/);
    expect(tool.description).toMatch(/server derives lock attribution from the caller's current agent-state stamp/);
    expect(tool.args.shape).not.toHaveProperty('goal_ref');
  });

  it('documents the required intent argument for blocked peers', () => {
    expect(tool.description).toMatch(/required short `intent`/);
    expect(tool.args.shape).toHaveProperty('intent');
  });

  it('keeps the README smoke-test payloads aligned with the required intent argument', () => {
    const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
    expect(readme).toContain(
      "paths: ['apps/operator/lib/foo.ts'], ttl_sec: 60, intent: 'hold foo.ts for smoke test'",
    );
    expect(readme).toContain("paths: ['apps/operator/lib/foo.ts'], intent: 'contend for foo.ts'");
  });

  it('documents that harness/workspace slugs are not acquire arguments', () => {
    expect(tool.description).toMatch(/workspace-global file-lock surface/);
    expect(tool.description).toMatch(/omit `harness` and `workspace`/);
    expect(tool.description).toMatch(/use `coordination_domain` only when the physical checkout differs/);
    expect(tool.args.shape).not.toHaveProperty('harness');
    expect(tool.args.shape).not.toHaveProperty('workspace');
  });

  it('does not expose the named-resource `mode` argument', () => {
    // `mode` belongs to locks:acquire_resource; accepting it here would let a
    // caller mistake a file-lock request for a named-resource lock request.
    expect(tool.args.shape).not.toHaveProperty('mode');
  });

  it('guidance omits published_sha for uncommitted edits and reserves it for a published SHA', () => {
    expect(tool.guidance?.chaining).toMatch(/still uncommitted, omit published_sha/);
    expect(tool.guidance?.chaining).toMatch(/actually published a lowercase 40–64-character hexadecimal commit SHA/);
  });

  it('releases explicit edit locks before git-sync so protected paths remain committable', () => {
    const guidance = `${tool.guidance?.when ?? ''}\n${tool.guidance?.chaining ?? ''}`;
    expect(guidance).toMatch(/release after the edits so git-sync can commit them/);
    expect(guidance).toMatch(/git-sync excludes live-locked paths/);
    expect(guidance).not.toMatch(/held across several edits AND the commit|release after committing|edit → commit → locks:release/);
  });

  it('publishes coordination_domain as an absolute canonical checkout root, not a workspace slug', () => {
    const description = tool.args.shape.coordination_domain.description ?? '';
    expect(description).toMatch(/absolute canonical repository checkout root/i);
    expect(description).toMatch(/not a harness\/workspace slug/i);
    expect(description).toMatch(/e\.g\. \/workspace\/papercusp/i);

    const published = z.toJSONSchema(tool.args as never) as {
      properties?: { coordination_domain?: { description?: string } };
    };
    expect(published.properties?.coordination_domain?.description).toBe(description);
  });

  it('rejects malformed paths before attempting acquire', async () => {
    normM.mockImplementation(() => { throw new Error('absolute path not allowed'); });
    const b = body(await call({ paths: ['/etc/x'] }));
    expect(b).toMatchObject({ ok: false });
    expect(String(b.error)).toMatch(/absolute path/);
    expect(routeM).not.toHaveBeenCalled();
  });

  it('fast-path success → ok projection (echoes owner, ISO expiry, held)', async () => {
    routeM.mockResolvedValue({ value: { ok: true, lock_id: 'L1', expires_ts: new Date('2026-02-01T00:00:00Z'), held: ['a.ts'] }, via: 'local-authority' });
    const b = body(await call({}));
    expect(b).toMatchObject({
      ok: true, lock_id: 'L1', owner: 'me', owner_label: 'Me',
      expires_ts: '2026-02-01T00:00:00.000Z', held: ['a.ts'],
    });
    expect(readStampM).toHaveBeenCalledWith('me');
  });

  it('fast-path success keeps missing repo-relative paths acquirable and adds a precise advisory warning', async () => {
    routeM.mockResolvedValue({
      value: {
        ok: true,
        lock_id: 'L-missing',
        expires_ts: new Date('2026-02-01T00:00:00Z'),
        held: ['existing.ts', 'new-file.ts'],
      },
      via: 'local-authority',
    });
    const b = body(await call({
      paths: ['existing.ts', 'new-file.ts'],
      coordination_domain: warningRoot,
    }));
    expect(b).toMatchObject({ ok: true, lock_id: 'L-missing', held: ['existing.ts', 'new-file.ts'] });
    expect(b.path_warning).toContain('new-file.ts');
    expect(b.path_warning).toContain(warningRoot);
    expect(b.path_warning).toMatch(/advisory only/);
    expect(b.path_warning).not.toContain('existing.ts');
  });

  it('does not probe logical external-home keys as repository paths', async () => {
    routeM.mockResolvedValue({
      value: {
        ok: true,
        lock_id: 'L-home-warning',
        expires_ts: new Date('2026-02-01T00:00:00Z'),
        held: ['@external/home/.config/mimeapps.list'],
      },
      via: 'local-authority',
    });
    const b = body(await call({
      paths: ['@external/home/.config/mimeapps.list'],
      coordination_domain: warningRoot,
    }));
    expect(b).toMatchObject({ ok: true, lock_id: 'L-home-warning' });
    expect(b.path_warning).toBeUndefined();
  });

  it('does not probe logical XDG-runtime keys as repository paths', async () => {
    routeM.mockResolvedValue({
      value: {
        ok: true,
        lock_id: 'L-runtime-warning',
        expires_ts: new Date('2026-02-01T00:00:00Z'),
        held: ['@external/runtime/papercusp-p029/storage-state.json'],
      },
      via: 'local-authority',
    });
    const b = body(await call({
      paths: ['@external/runtime/papercusp-p029/storage-state.json'],
      coordination_domain: warningRoot,
    }));
    expect(b).toMatchObject({ ok: true, lock_id: 'L-runtime-warning' });
    expect(b.path_warning).toBeUndefined();
  });

  it('uses the client edit hook domain when supplied, so a release-tree operator cannot split the lock namespace', async () => {
    routeM.mockResolvedValue({ value: { ok: true, lock_id: 'L1', expires_ts: new Date('2026-02-01T00:00:00Z'), held: ['a.ts'] }, via: 'local-authority' });
    await call({ coordination_domain: '/canonical/staging' });
    expect(resolveDomainM).toHaveBeenCalledWith('/canonical/staging', 'dom');
    expect(routeM.mock.calls[0]?.[0]).toBe('/canonical/staging');
  });

  it('maps absolute home configuration files to the hook-compatible reserved key', async () => {
    routeM.mockResolvedValue({
      value: {
        ok: true,
        lock_id: 'L-home',
        expires_ts: new Date('2026-02-01T00:00:00Z'),
        held: ['@external/home/.config/mimeapps.list'],
      },
      via: 'local-authority',
    });
    const out = await tool.handler({
      external_paths: [join(homedir(), '.config', 'mimeapps.list')],
      intent: 'edit desktop defaults',
    } as never, {} as never) as Out;
    expect(normM).toHaveBeenCalledWith(['@external/home/.config/mimeapps.list']);
    expect(body(out)).toMatchObject({ ok: true, lock_id: 'L-home' });
  });

  it('maps absolute XDG runtime files to the hook-compatible reserved key', async () => {
    const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    routeM.mockResolvedValue({
      value: {
        ok: true,
        lock_id: 'L-runtime',
        expires_ts: new Date('2026-02-01T00:00:00Z'),
        held: ['@external/runtime/papercusp-p029/storage-state.json'],
      },
      via: 'local-authority',
    });
    try {
      const out = await tool.handler({
        external_paths: ['/run/user/1000/papercusp-p029/storage-state.json'],
        intent: 'refresh runtime credential',
      } as never, {} as never) as Out;
      expect(normM).toHaveBeenCalledWith([
        '@external/runtime/papercusp-p029/storage-state.json',
      ]);
      expect(body(out)).toMatchObject({ ok: true, lock_id: 'L-runtime' });
    } finally {
      if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    }
  });

  it('maps a managed suite-app absolute path to its repository domain and relative key', async () => {
    const workspaces = mkdtempSync(join(tmpdir(), 'locks-acquire-suite-app-'));
    const portal = join(workspaces, 'papercusp-workspace', '.papercusp', 'apps', 'portal');
    const target = join(portal, 'packages', 'contracts', 'src', 'index.ts');
    const previousWorkspaceRoot = process.env.PAPERCUSP_WORKSPACE_ROOT;
    const previousWorkspacesRoot = process.env.PAPERCUSP_WORKSPACES_ROOT;
    const previousCanonicalTree = process.env.PAPERCUSP_CANONICAL_TREE;
    process.env.PAPERCUSP_WORKSPACE_ROOT = workspaces;
    process.env.PAPERCUSP_WORKSPACES_ROOT = workspaces;
    process.env.PAPERCUSP_CANONICAL_TREE = join(workspaces, 'missing-canonical-tree');
    mkdirSync(join(portal, '.git'), { recursive: true });
    writeFileSync(join(portal, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'export {};\n');
    routeM.mockResolvedValue({
      value: {
        ok: true,
        lock_id: 'L-suite-app',
        expires_ts: new Date('2026-02-01T00:00:00Z'),
        held: ['packages/contracts/src/index.ts'],
      },
      via: 'local-authority',
    });
    try {
      const out = await tool.handler({
        external_paths: [target],
        intent: 'edit portal contract',
      } as never, {} as never) as Out;
      expect(resolveDomainM).toHaveBeenCalledWith(undefined, 'dom');
      expect(routeM.mock.calls.at(-1)?.[0]).toBe(realpathSync(portal));
      expect(normM).toHaveBeenCalledWith(['packages/contracts/src/index.ts']);
      expect(body(out)).toMatchObject({ ok: true, lock_id: 'L-suite-app' });
    } finally {
      if (previousWorkspaceRoot === undefined) delete process.env.PAPERCUSP_WORKSPACE_ROOT;
      else process.env.PAPERCUSP_WORKSPACE_ROOT = previousWorkspaceRoot;
      if (previousWorkspacesRoot === undefined) delete process.env.PAPERCUSP_WORKSPACES_ROOT;
      else process.env.PAPERCUSP_WORKSPACES_ROOT = previousWorkspacesRoot;
      if (previousCanonicalTree === undefined) delete process.env.PAPERCUSP_CANONICAL_TREE;
      else process.env.PAPERCUSP_CANONICAL_TREE = previousCanonicalTree;
      rmSync(workspaces, { recursive: true, force: true });
    }
  });

  it('fast-path busy with no wait/wake → busy()', async () => {
    routeM.mockResolvedValue({ value: { ok: false, busy: [{ path: 'a.ts', owner: 'o2' }] }, via: 'local-authority' });
    const b = body(await call({}));
    expect(b).toMatchObject({ ok: false, busy: [{ path: 'a.ts', owner: 'o2' }] });
  });

  it('fast-path upsert race stays explicit and retryable even when busy is empty', async () => {
    routeM.mockResolvedValue({
      value: { ok: false, busy: [], reason: 'upsert_race', retryable: true },
      via: 'local-authority',
    });
    const b = body(await call({}));
    expect(b).toMatchObject({
      ok: false,
      reason: 'upsert_race',
      transient: true,
      retryable: true,
      holder: 'unknown',
      busy: [],
    });
    expect(String(b.advice)).toMatch(/retry/i);
    expect(String(b.advice)).toMatch(/do NOT queue wake_on_grant/i);
  });

  it('identifies the queued waiter on the fast path', async () => {
    const holderExpires = new Date(Date.now() + 60_000);
    routeM.mockResolvedValue({
      value: {
        ok: false,
        reason: 'queued_waiter',
        busy: [{ path: 'a.ts', owner: 'holder', owner_label: 'HOLDER', intent: 'write file', expires_ts: holderExpires }],
      },
      via: 'local-authority',
    });
    const b = body(await call({}));
    expect(b).toMatchObject({
      ok: false,
      reason: 'queued_waiter',
      busy: [{ path: 'a.ts', owner: 'holder', expires_ts: holderExpires.toISOString() }],
    });
    expect(String(b.advice)).toMatch(/earlier lock-wait ticket/);
    expect(String(b.advice)).toMatch(/active holders only/);
  });

  it('a WorkspaceContendedError degrades to a structured TRANSIENT workspace_contended (never a false holder, never a raw PG leak) — EI-9478', async () => {
    // Mirrors the real WorkspaceContendedError shape (`.name` set) so this
    // exercises the EI-13189 contention-retry path (below) before degrading —
    // not just an immediate instanceof-check bypass.
    routeM.mockRejectedValue(
      Object.assign(new WorkspaceContendedError('ws', '55P03', new Error('advisory lock timeout')), {
        name: 'WorkspaceContendedError',
        pgCode: '55P03',
      }),
    );
    vi.useFakeTimers();
    try {
      const p = call({});
      await vi.runAllTimersAsync(); // advance both contention-retry backoff windows (routed + local-fallback)
      const b = body(await p);
      // EI-9478: an EXPLICIT transient reason with an EMPTY busy list — so no
      // downstream reader (esp. the edit hook) can render it as "held by another
      // agent" with a fabricated holder. The pre-fix code returned a bare busy:[],
      // which the hook then printed under a "file(s) held by another agent:" header
      // with zero holders.
      expect(b).toMatchObject({
        ok: false,
        reason: 'workspace_contended',
        transient: true,
        holder: 'unknown',
        busy: [],
      });
      // The advice steers to a plain RETRY and explicitly AWAY from wake_on_grant
      // (there is no holder to wait on).
      expect(String(b.advice)).toMatch(/retry/i);
      expect(String(b.advice)).toMatch(/do NOT queue wake_on_grant/i);
      expect(String(b.advice)).toMatch(/holder identity is unknown/i);
      expect(String(b.advice)).not.toMatch(/NO holder|starved PG pool/i);
      // EI-13189: contention is retried (LOCK_CONTENTION_BACKOFFS_MS = 3 backoffs,
      // i.e. 4 attempts) before degrading to workspace_contended — not surfaced on
      // the very first timeout.
      expect(routeM.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a raw PostgreSQL 57014 after contention retries also degrades structurally — EI-22355580114287046', async () => {
    // A raw postgres-js error can cross a package/transport boundary without
    // the @papercusp/locks class identity. The handler must classify its SQLSTATE
    // structurally after the shared retry budget, not leak handler_error.
    routeM.mockRejectedValue(
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    );
    vi.useFakeTimers();
    try {
      const p = call({});
      await vi.runAllTimersAsync();
      const b = body(await p);

      expect(b).toMatchObject({
        ok: false,
        reason: 'workspace_contended',
        transient: true,
        holder: 'unknown',
        busy: [],
      });
      expect(String(b.advice)).toMatch(/retry/i);
      expect(String(b.advice)).toMatch(/do NOT queue wake_on_grant/i);
      expect(routeM).toHaveBeenCalledTimes(4); // initial attempt + 3 backoffs
    } finally {
      vi.useRealTimers();
    }
  });

  it('EI-13189: a TRANSIENT contention that clears on retry acquires normally (no user-visible failure)', async () => {
    let n = 0;
    routeM.mockImplementation(async () => {
      if (n++ < 1) {
        throw Object.assign(new Error('workspace contended'), { name: 'WorkspaceContendedError', pgCode: '55P03' });
      }
      // `via` is genuinely required by RouteResult<T>, and acquire.ts:271 branches on it
      // (`routed.via !== 'remote-authority'` decides whether a P-015 lock-event is
      // emitted) — so omitting it did not make the fixture neutral, it made it silently
      // take the local-authority path with `undefined`. Supplying it is what this test
      // meant all along (EI-19452618085391226).
      return { value: { ok: true, lock_id: 'L1', expires_ts: new Date('2026-02-01T00:00:00Z'), held: ['a.ts'] }, via: 'local-authority' as const };
    });
    vi.useFakeTimers();
    try {
      const p = call({});
      await vi.runAllTimersAsync();
      const b = body(await p);
      expect(b).toMatchObject({ ok: true, lock_id: 'L1', held: ['a.ts'] });
      expect(routeM.mock.calls.length).toBe(2); // one transient miss, then a clean grant
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a postgres-js CONNECT_TIMEOUT before the workspace transaction starts, then acquires once', async () => {
    const connectTimeout = Object.assign(new Error('write CONNECT_TIMEOUT localhost:5432'), {
      code: 'CONNECT_TIMEOUT',
    });
    txnM.mockRejectedValueOnce(connectTimeout);
    tryAcquireM.mockResolvedValueOnce({
      ok: true,
      lock_id: 'L-connect-retry',
      expires_ts: new Date('2026-02-01T00:00:00Z'),
      held: ['a.ts'],
    } as never);
    routeM.mockImplementation(async (_domain, op) => ({
      value: await op.local(),
      via: 'local-authority',
    }));

    vi.useFakeTimers();
    try {
      const p = call({});
      await vi.runAllTimersAsync();
      const b = body(await p);

      expect(b).toMatchObject({ ok: true, lock_id: 'L-connect-retry', held: ['a.ts'] });
      expect(txnM).toHaveBeenCalledTimes(2);
      expect(tryAcquireM).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('wake_on_grant queues a waiter for at least the maximum legal holder TTL', async () => {
    routeM.mockResolvedValue({ value: { ok: false, busy: [{ path: 'a.ts', owner: 'o2' }] }, via: 'local-authority' });
    insertM.mockResolvedValue({ ok: true, ticket_id: 'T1', wait_until: new Date(Date.now() - 1000) });
    const b = body(await call({ wake_on_grant: true }));
    expect(insertM).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxWaitSec: MAX_LOCK_TTL_SEC }),
    );
    expect(b).toMatchObject({
      ok: false,
      queued_for_wake: true,
      ticket_id: 'T1',
      await_id: 'A1',
      queue_window_sec: MAX_LOCK_TTL_SEC,
    });
  });

  it('P-010: a queued wake_on_grant wait carries a lock-wait operational brief built from the real waiter + await rows', async () => {
    const waitUntil = new Date(Date.now() + 30 * 60_000);
    routeM.mockResolvedValue({
      value: { ok: false, busy: [{ path: 'a.ts', owner: 'o2', owner_label: 'O2', intent: 'refactor', expires_ts: '2099-01-01T00:00:00.000Z' }] },
      via: 'local-authority',
    });
    insertM.mockResolvedValue({ ok: true, ticket_id: 'T-brief', wait_until: waitUntil });
    const wakeRow: AwaitRow = {
      id: 501,
      workspaceId: 'ws-1',
      subscriberId: 'me',
      eventKey: 'grant:T-brief',
      policy: 'wake',
      note: 'lock wait: a.ts — edit',
      wakeHandle: null,
      timeoutBehavior: 'wake',
      expiresTs: '2099-01-01T00:02:00.000Z',
      createdAt: '2026-09-22T00:00:00.000Z',
      firedAt: null,
      firedReason: null,
      cancelledAt: null,
      cancelReason: null,
      once: true,
      minSleepSec: null,
      urgency: false,
      payloadFilter: null,
      scopeKind: null,
      scopeRef: null,
    };
    vi.mocked(registerAwait).mockResolvedValueOnce(wakeRow);
    const b = body(await call({ wake_on_grant: true }));
    expect(b.operational_brief).toMatchObject({
      schemaVersion: 'operational-brief-v1',
      surface: 'lock-wait',
      subject: 'lock a.ts (ticket T-brief)',
      owner: { status: 'known', value: 'o2' },
      deadline: { status: 'known', value: waitUntil.toISOString() },
      facts: { ticketId: 'T-brief', awaitId: { status: 'known', value: 501 }, grantEventKey: { status: 'known', value: 'grant:T-brief' } },
    });
    expect(b.operational_brief.nextAction.value).toMatch(/^END YOUR TURN\./);
  });

  it('P-010: synchronous outcomes (instant grant, busy without a queued wait) carry NO operational brief', async () => {
    routeM.mockResolvedValue({ value: { ok: true, lock_id: 'L1', expires_ts: new Date('2026-02-01T00:00:00Z'), held: ['a.ts'] }, via: 'local-authority' });
    expect(body(await call({}))).not.toHaveProperty('operational_brief');
    routeM.mockResolvedValue({ value: { ok: false, busy: [{ path: 'a.ts', owner: 'o2' }] }, via: 'local-authority' });
    expect(body(await call({}))).not.toHaveProperty('operational_brief');
  });

  it('wake_on_grant self-grant (path freed during insert) → ok', async () => {
    routeM.mockResolvedValue({ value: { ok: false, busy: [] }, via: 'local-authority' });
    insertM.mockResolvedValue({ ok: true, self_granted: true, lock_id: 'L2', expires_ts: new Date('2026-03-01T00:00:00Z'), held: ['a.ts'] });
    const b = body(await call({ wake_on_grant: true }));
    expect(b).toMatchObject({ ok: true, lock_id: 'L2', held: ['a.ts'] });
  });

  it('wake_on_grant with a failed waiter insert surfaces the reason', async () => {
    routeM.mockResolvedValue({ value: { ok: false, busy: [] }, via: 'local-authority' });
    insertM.mockResolvedValue({ ok: false, reason: 'waiter_cap_exceeded' });
    const b = body(await call({ wake_on_grant: true }));
    expect(b).toMatchObject({ ok: false, reason: 'waiter_cap_exceeded' });
  });

  it('wake_on_grant retries transient workspace contention around the waiter insert', async () => {
    routeM.mockResolvedValue({ value: { ok: false, busy: [{ path: 'a.ts', owner: 'o2' }] }, via: 'local-authority' });
    insertM.mockResolvedValue({ ok: true, ticket_id: 'T-retry', wait_until: new Date(Date.now() - 1000) });
    txnM.mockRejectedValueOnce(
      Object.assign(new WorkspaceContendedError('dom', '57014', new Error('advisory lock timeout')), {
        name: 'WorkspaceContendedError',
        pgCode: '57014',
      }),
    );

    vi.useFakeTimers();
    try {
      const p = call({ wake_on_grant: true });
      await vi.runAllTimersAsync();
      const b = body(await p);

      expect(b).toMatchObject({
        ok: false,
        queued_for_wake: true,
        ticket_id: 'T-retry',
      });
      expect(txnM).toHaveBeenCalledTimes(2);
      expect(insertM).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('locks:acquire — EI-19324204900062056 blocking-wait connection resilience', () => {
  // Contention path so the tool proceeds past the fast-path to the wait
  // subsystem (LISTEN + INSERT waiter + poll loop).
  beforeEach(() => {
    routeM.mockResolvedValue({ value: { ok: false, busy: [{ path: 'a.ts', owner: 'o2' }] }, via: 'local-authority' });
  });

  it('a transient CONNECTION_CLOSED error while polling status mid-wait is swallowed — the wait continues instead of crashing the call', async () => {
    // wait_until is far enough in the future that the loop is entered (and
    // the ceiling setTimeout below fires) at least once, but short enough
    // that a single real ~50ms tick carries it past waitUntilMs — avoids
    // fake-timer choreography of the internal ceiling Promise/setTimeout
    // while keeping the test's wall-clock cost negligible.
    insertM.mockResolvedValue({ ok: true, ticket_id: 'T-A', wait_until: new Date(Date.now() + 50) });
    // Pre-loop immediate re-check: not yet granted, so the loop is entered.
    statusM.mockResolvedValueOnce({ status: 'waiting' });
    // Inside the loop: poking the workspace hits the transient connection drop.
    pokeM.mockRejectedValueOnce(connectionClosedError());
    // Step 6 (after the loop exits on wait_until elapsing): both calls
    // succeed normally on the reconnected pool — proves the mid-loop error
    // didn't abort the call, it was swallowed and control reached here.
    expireM.mockResolvedValueOnce(undefined);
    tryAcquireM.mockResolvedValueOnce({ ok: false, busy: [{ path: 'a.ts', owner: 'o2', owner_label: null, intent: 'edit', expires_ts: new Date(Date.now() + 60_000) }] });

    const b = body(await call({ wait: { max_sec: 1 } }));

    // A normal timeout/busy result — NOT a thrown error, NOT wait_connection_unstable.
    expect(b).toMatchObject({ ok: false, ticket_id: 'T-A', busy: [{ path: 'a.ts', owner: 'o2' }] });
    expect(b.reason).not.toBe('wait_connection_unstable');
    expect(pokeM).toHaveBeenCalled();
  });

  it('retains queued_waiter and the active holder snapshot after a blocking timeout', async () => {
    const holderExpires = new Date('2026-10-02T03:59:29.604Z');
    insertM.mockResolvedValue({ ok: true, ticket_id: 'T-Q', wait_until: new Date(Date.now() - 1000) });
    statusM.mockResolvedValueOnce({ status: 'waiting' });
    expireM.mockResolvedValueOnce(undefined);
    tryAcquireM.mockResolvedValueOnce({
      ok: false,
      reason: 'queued_waiter',
      busy: [{ path: 'a.ts', owner: 'holder', owner_label: 'Holder', intent: 'write file', expires_ts: holderExpires }],
    });

    const b = body(await call({ wait: { max_sec: 1 } }));

    expect(b).toMatchObject({
      ok: false,
      reason: 'queued_waiter',
      ticket_id: 'T-Q',
      busy: [{ path: 'a.ts', owner: 'holder', expires_ts: holderExpires.toISOString() }],
    });
  });

  it('a transient CONNECTION_CLOSED error at the tail (step 6 expireWaiter) degrades to a structured wait_connection_unstable — never a raw thrown/MCP-fatal error', async () => {
    insertM.mockResolvedValue({ ok: true, ticket_id: 'T-B', wait_until: new Date(Date.now() - 1000) }); // already elapsed → 0 loop iterations
    statusM.mockResolvedValueOnce({ status: 'waiting' });
    expireM.mockRejectedValueOnce(connectionClosedError());

    const b = body(await call({ wait: { max_sec: 1 } }));

    expect(b).toMatchObject({
      ok: false,
      reason: 'wait_connection_unstable',
      transient: true,
      ticket_id: 'T-B',
      busy: [],
    });
    expect(String(b.advice)).toMatch(/wake_on_grant/);
    // Never reached tryAcquire — expireWaiter's failure short-circuited to the degrade.
    expect(tryAcquireM).not.toHaveBeenCalled();
  });

  it('a NON-transient error mid-wait still propagates (this fix must not mask genuine bugs)', async () => {
    insertM.mockResolvedValue({ ok: true, ticket_id: 'T-C', wait_until: new Date(Date.now() + 50) });
    statusM.mockResolvedValueOnce({ status: 'waiting' });
    pokeM.mockRejectedValueOnce(new Error('boom: not a connection error'));

    await expect(call({ wait: { max_sec: 1 } })).rejects.toThrow('boom: not a connection error');
  });
});

describe('locks:acquire — EI-19382183884861720: the two gaps EI-19324204900062056 missed (INSERT + the immediate post-insert re-check)', () => {
  // Contention path so the tool proceeds past the fast-path to the wait
  // subsystem (LISTEN + INSERT waiter + poll loop) — same setup as the
  // EI-19324204900062056 suite above.
  beforeEach(() => {
    routeM.mockResolvedValue({ value: { ok: false, busy: [{ path: 'a.ts', owner: 'o2' }] }, via: 'local-authority' });
  });

  it('a transient CONNECTION_CLOSED error on the IMMEDIATE post-insert re-check is swallowed — falls through to the wait loop instead of crashing the call', async () => {
    insertM.mockResolvedValue({ ok: true, ticket_id: 'T-D', wait_until: new Date(Date.now() + 50) });
    // Immediate post-insert re-check (BEFORE the step 4-5 loop): connection drop.
    statusM.mockRejectedValueOnce(connectionClosedError());
    // Inside the loop the connection has reconnected — resolves normally.
    pokeM.mockResolvedValue(undefined);
    // PERSISTENT, not ...Once: the step 4-5 loop's iteration count is not
    // fixed. It re-polls until `wait_until` elapses, and an iteration can be
    // cut short by a pending LISTEN wake (the `pendingWake` short-circuit)
    // instead of running the full ceiling await — so the loop legitimately
    // polls status one *or more* times before the deadline. A ...Once here
    // under-provisions that: once the queue drains, the mock returns
    // `undefined` and the production `status.status` read throws
    // `TypeError: Cannot read properties of undefined` — a test-only artifact
    // that reads exactly like a real crash. (`readWaiterStatus` cannot return
    // undefined in production: it is typed `Promise<WaiterStatus>` and yields
    // `{ status: 'missing' }` for a vanished row.) A persistent mock says the
    // real thing — "every poll after the blip reports waiting" — and keeps the
    // test coupled to the behaviour it asserts rather than to loop timing.
    // The mockRejectedValueOnce above still wins the FIRST call (the Once
    // queue drains before this default), so the immediate post-insert
    // re-check still gets the transient error this test is about.
    statusM.mockResolvedValue({ status: 'waiting' });
    // Step 6 after the loop exits on wait_until elapsing.
    expireM.mockResolvedValueOnce(undefined);
    tryAcquireM.mockResolvedValueOnce({ ok: false, busy: [{ path: 'a.ts', owner: 'o2', owner_label: null, intent: 'edit', expires_ts: new Date(Date.now() + 60_000) }] });

    const b = body(await call({ wait: { max_sec: 1 } }));

    // A normal timeout/busy result — NOT a thrown error, NOT wait_connection_unstable.
    expect(b).toMatchObject({ ok: false, ticket_id: 'T-D', busy: [{ path: 'a.ts', owner: 'o2' }] });
    expect(b.reason).not.toBe('wait_connection_unstable');
  });

  it('a NON-transient error on the immediate post-insert re-check still propagates (never masked)', async () => {
    insertM.mockResolvedValue({ ok: true, ticket_id: 'T-E', wait_until: new Date(Date.now() + 50) });
    statusM.mockRejectedValueOnce(new Error('boom: not a connection error'));

    await expect(call({ wait: { max_sec: 1 } })).rejects.toThrow('boom: not a connection error');
  });

  it('a transient CONNECTION_CLOSED error on the waiter INSERT (step 3) is retried once and the call proceeds normally', async () => {
    insertM
      .mockRejectedValueOnce(connectionClosedError())
      .mockResolvedValueOnce({ ok: true, ticket_id: 'T-F', wait_until: new Date(Date.now() - 1000) }); // already elapsed → 0 loop iterations
    statusM.mockResolvedValueOnce({ status: 'waiting' });
    expireM.mockResolvedValueOnce(undefined);
    tryAcquireM.mockResolvedValueOnce({ ok: false, busy: [{ path: 'a.ts', owner: 'o2', owner_label: null, intent: 'edit', expires_ts: new Date(Date.now() + 60_000) }] });

    const b = body(await call({ wait: { max_sec: 1 } }));

    expect(b).toMatchObject({ ok: false, ticket_id: 'T-F' });
    expect(insertM).toHaveBeenCalledTimes(2);
  });

  it('a NON-transient error on the waiter INSERT propagates immediately, with no retry', async () => {
    insertM.mockRejectedValueOnce(new Error('boom: not a connection error'));

    await expect(call({ wait: { max_sec: 1 } })).rejects.toThrow('boom: not a connection error');
    expect(insertM).toHaveBeenCalledTimes(1);
  });
});

describe('locks:acquire — EI-19921385348146413: a VANISHED waiter row is terminal, not "keep waiting"', () => {
  beforeEach(() => {
    routeM.mockResolvedValue({ value: { ok: false, busy: [{ path: 'a.ts', owner: 'o2' }] }, via: 'local-authority' });
  });

  it("readWaiterStatus returning {status:'missing'} inside the poll loop bails on the FIRST sighting — reason:'waiter_vanished', not spun until the deadline", async () => {
    insertM.mockResolvedValue({ ok: true, ticket_id: 'T-G', wait_until: new Date(Date.now() + 50) });
    statusM.mockResolvedValueOnce({ status: 'waiting' }); // immediate post-insert re-check
    statusM.mockResolvedValueOnce({ status: 'missing' }); // first (and only) loop iteration
    expireM.mockResolvedValueOnce(undefined);
    tryAcquireM.mockResolvedValueOnce({ ok: false, busy: [] });

    const b = body(await call({ wait: { max_sec: 1 } }));

    expect(b).toMatchObject({ ok: false, ticket_id: 'T-G', reason: 'waiter_vanished' });
    expect(String(b.reason_detail)).toMatch(/waiter row disappeared/);
    // Broke on the first loop poll — never re-entered readWaiterStatus a third time.
    expect(statusM).toHaveBeenCalledTimes(2);
  });

  it("'cancelled' still reports its own reason (regression coverage for the pre-existing terminal arm)", async () => {
    insertM.mockResolvedValue({ ok: true, ticket_id: 'T-H', wait_until: new Date(Date.now() + 50) });
    statusM.mockResolvedValueOnce({ status: 'waiting' });
    statusM.mockResolvedValueOnce({ status: 'cancelled' });
    expireM.mockResolvedValueOnce(undefined);
    tryAcquireM.mockResolvedValueOnce({ ok: false, busy: [] });

    const b = body(await call({ wait: { max_sec: 1 } }));
    expect(b).toMatchObject({ ok: false, ticket_id: 'T-H', reason: 'cancelled' });
  });

  it("a genuine deadline timeout (status stays 'waiting' throughout) reports reason:'timeout'", async () => {
    insertM.mockResolvedValue({ ok: true, ticket_id: 'T-I', wait_until: new Date(Date.now() + 50) });
    statusM.mockResolvedValue({ status: 'waiting' }); // persistent — never resolves, never vanishes
    expireM.mockResolvedValueOnce(undefined);
    tryAcquireM.mockResolvedValueOnce({ ok: false, busy: [] });

    const b = body(await call({ wait: { max_sec: 1 } }));
    expect(b).toMatchObject({ ok: false, ticket_id: 'T-I', reason: 'timeout' });
  });
});

describe('locks:acquire — EI-9033 pending_edit (apply-on-grant) guardrails', () => {
  it('rejects pending_edit without wake_on_grant (it runs on the wake queue)', async () => {
    const b = body(await call({ pending_edit: { file: 'a.ts', old_string: 'X', new_string: 'Y' } }));
    expect(b).toMatchObject({ ok: false });
    expect(String(b.error)).toMatch(/requires wake_on_grant/);
    expect(routeM).not.toHaveBeenCalled();
  });

  it('rejects pending_edit when paths is not exactly [pending_edit.file]', async () => {
    const b = body(
      await call({
        paths: ['a.ts', 'b.ts'],
        wake_on_grant: true,
        pending_edit: { file: 'a.ts', old_string: 'X', new_string: 'Y' },
      }),
    );
    expect(b).toMatchObject({ ok: false });
    expect(String(b.error)).toMatch(/single-file only/);
    expect(routeM).not.toHaveBeenCalled();
  });

  it('threads a valid pending_edit into the waiter and flags apply_on_grant', async () => {
    routeM.mockResolvedValue({ value: { ok: false, busy: [{ path: 'a.ts', owner: 'o2' }] }, via: 'local-authority' });
    insertM.mockResolvedValue({ ok: true, ticket_id: 'T9', wait_until: new Date(Date.now() - 1000) });
    const b = body(
      await call({
        wake_on_grant: true,
        pending_edit: { file: 'a.ts', old_string: 'OLD', new_string: 'NEW' },
      }),
    );
    expect(b).toMatchObject({ ok: false, queued_for_wake: true, apply_on_grant: true, ticket_id: 'T9' });
    expect(insertM).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        pendingEdit: { file: 'a.ts', old_string: 'OLD', new_string: 'NEW', goal_ref: 'WI-current' },
      }),
    );
  });
});

describe('locks:acquire — WI-1550 P-015 lock-event emission on a LOCALLY-decided grant', () => {
  it('emits a lock-event when the grant was decided local-authority with a resolved scope', async () => {
    routeM.mockResolvedValue({
      value: { ok: true, lock_id: 'L1', expires_ts: new Date('2026-02-01T00:00:00Z'), held: ['a.ts'] },
      via: 'local-authority',
      scope: 'harness-x',
    });
    const b = body(await call({}));
    expect(b).toMatchObject({ ok: true, lock_id: 'L1' });
    expect(recordEventM).toHaveBeenCalledTimes(1);
    expect(recordEventM).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'acquire', scope: 'harness-x', path: 'a.ts', owner: 'me', expiresAtMs: Date.parse('2026-02-01T00:00:00Z') }),
    );
  });

  it('emits on a fail-open grant too (a remote authority was unreachable)', async () => {
    routeM.mockResolvedValue({
      value: { ok: true, lock_id: 'L1', expires_ts: new Date('2026-02-01T00:00:00Z'), held: ['a.ts'] },
      via: 'fail-open',
      scope: 'harness-x',
      warning: 'authority unreachable',
    });
    await call({});
    expect(recordEventM).toHaveBeenCalledTimes(1);
  });

  it('does NOT emit locally when the grant was relayed to a remote authority (it already recorded its own)', async () => {
    routeM.mockResolvedValue({
      value: { ok: true, lock_id: 'L1', expires_ts: new Date('2026-02-01T00:00:00Z'), held: ['a.ts'] },
      via: 'remote-authority',
      scope: 'harness-x',
    });
    await call({});
    expect(recordEventM).not.toHaveBeenCalled();
  });

  it('does NOT emit when the domain is unmanaged (no federated scope to record against)', async () => {
    routeM.mockResolvedValue({
      value: { ok: true, lock_id: 'L1', expires_ts: new Date('2026-02-01T00:00:00Z'), held: ['a.ts'] },
      via: 'local-authority',
      // scope omitted — unmanaged/unfederated domain
    });
    await call({});
    expect(recordEventM).not.toHaveBeenCalled();
  });

  it('emits one event per held path on a multi-path grant', async () => {
    routeM.mockResolvedValue({
      value: { ok: true, lock_id: 'L1', expires_ts: new Date('2026-02-01T00:00:00Z'), held: ['a.ts', 'b.ts'] },
      via: 'local-authority',
      scope: 'harness-x',
    });
    await call({ paths: ['a.ts', 'b.ts'] });
    expect(recordEventM).toHaveBeenCalledTimes(2);
    expect(recordEventM.mock.calls.map((c) => (c[0] as { path: string }).path).sort()).toEqual(['a.ts', 'b.ts']);
  });
});

describe('structuredContent twin (EI-22077619752041149)', () => {
  // The tool declares an object-rooted `result` schema, which tool-projection
  // advertises to MCP clients as `outputSchema`; the MCP spec then requires
  // `structuredContent` on every response, and strict clients (codex-rs) fail
  // the whole envelope when it is missing — even though the acquire already
  // executed server-side. Every response path must therefore carry a
  // structured twin that is WIRE-EQUAL to the JSON text (Date instances
  // serialize to the same ISO strings on the transport, so equality is
  // asserted after a JSON round-trip).
  const structured = (o: Out) => (o as { structuredContent?: unknown }).structuredContent;
  const expectWireEqual = (o: Out) => {
    expect(structured(o)).toBeDefined();
    expect(JSON.parse(JSON.stringify(structured(o)))).toEqual(body(o));
  };

  it('fast-path success (multi-path) carries a wire-equal structuredContent', async () => {
    routeM.mockResolvedValue({
      value: { ok: true, lock_id: 'L1', expires_ts: new Date('2026-02-01T00:00:00Z'), held: ['a.ts', 'b.ts'] },
      via: 'local-authority',
    });
    expectWireEqual(await call({ paths: ['a.ts', 'b.ts'] }));
  });

  it('fast-path busy carries a wire-equal structuredContent', async () => {
    routeM.mockResolvedValue({
      value: {
        ok: false,
        busy: [{ path: 'a.ts', owner: 'other', owner_label: 'Other', intent: 'edit', expires_ts: new Date('2026-02-01T00:00:00Z') }],
      },
      via: 'local-authority',
    });
    expectWireEqual(await call({}));
  });

  it('malformed-path error carries a wire-equal structuredContent', async () => {
    normM.mockImplementation(() => { throw new Error('absolute path not allowed'); });
    expectWireEqual(await call({ paths: ['/etc/x'] }));
  });
});
