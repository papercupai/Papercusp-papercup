/**
 * locks:queue tool — metadata + the read-and-serialize handler contract.
 *
 * The store query (readQueue) is mocked; the tool's job is to call it with the
 * cross-domain diagnostic scope + filters and serialize the Date fields to ISO
 * strings inside the MCP text-content envelope.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => {
  const state: { queue: unknown } = { queue: { active_locks: [], waiting: [] } };
  return {
    state,
    ensureBootstrap: vi.fn(async () => {}),
    getTxPool: vi.fn(() => ({})),
    readQueue: vi.fn(async () => state.queue),
  };
});

vi.mock('../su-lock-store', () => ({
  ensureBootstrap: H.ensureBootstrap,
  getTxPool: H.getTxPool,
  readQueue: H.readQueue,
}));

import tool from '../queue';

const ctx = {} as never;
const payload = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

beforeEach(() => {
  H.readQueue.mockClear();
  H.state.queue = { active_locks: [], waiting: [] };
});

describe('locks:queue tool metadata', () => {
  it('has the expected name, capability, args, and guidance.when', () => {
    expect(tool.name).toBe('locks:queue');
    expect(tool.capability).toBe('locks:read');
    expect((tool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
    expect((tool.guidance?.when ?? '').length).toBeGreaterThan(0);
    expect(tool.description).toContain('workspace-global diagnostic: omit harness');
    expect(tool.description).toContain('paths:[] matches nothing');
    expect(tool.description).toContain('coordination_domain');
    expect(tool.guidance?.chaining).toContain('omit harness');
    expect(tool.guidance?.chaining).toContain('paths:[] matches none');
    expect(tool.args.safeParse({}).success).toBe(true);
    expect(tool.args.safeParse({ coordination_domain: '/repo' }).success).toBe(true);
    expect(tool.args.safeParse({ coordination_domain: '' }).success).toBe(false);
    expect(tool.args.safeParse({ paths: ['a.ts'], owner: 'su-1', include_completed: true }).success).toBe(true);
    expect(tool.args.safeParse({ paths: 'a.ts' }).success).toBe(false);
  });

  it('EI-22075918402561858: accepts external_paths in the args schema', () => {
    expect(tool.args.safeParse({ external_paths: ['/home/x/.config/y.list'] }).success).toBe(true);
    expect(tool.description).toContain('external_paths');
    expect(tool.guidance?.chaining).toContain('external_paths');
    expect(tool.description).toContain('at most one managed repository per request');
    expect(tool.guidance?.chaining).toContain('query one managed repository per request');
    const shape = (tool.args as unknown as { shape: { external_paths: { description?: string } } }).shape;
    expect(shape.external_paths.description).toContain('at most one managed repository per request');
  });

  it('keeps ptool JSON responses parseable when the queue snapshot exceeds the result door', () => {
    expect((tool as { skipResultDoor?: string }).skipResultDoor).toBe('programmatic-caller');
  });
});

describe('locks:queue handler', () => {
  it('uses the cross-domain diagnostic scope + passes filters to readQueue', async () => {
    await tool.handler({ paths: ['x.ts'], owner: 'su-9', include_completed: true }, ctx);
    expect(H.ensureBootstrap).toHaveBeenCalled();
    expect(H.readQueue).toHaveBeenCalledWith(expect.anything(), {
      // A serving operator can run from a different checkout than the path's
      // lock holder; diagnostics must not silently filter that holder out.
      coordinationDomain: null,
      paths: ['x.ts'],
      owner: 'su-9',
      includeCompleted: true,
    });
  });

  it('EI-22019812538150428: accepts and forwards an explicit coordination_domain scope', async () => {
    await tool.handler({ coordination_domain: '/external/checkout', paths: ['x.ts'] }, ctx);
    expect(H.readQueue).toHaveBeenCalledWith(expect.anything(), {
      coordinationDomain: '/external/checkout',
      paths: ['x.ts'],
      owner: undefined,
      includeCompleted: undefined,
    });
  });

  it('preserves an explicit empty paths filter for the store to fail closed', async () => {
    await tool.handler({ paths: [] }, ctx);
    expect(H.readQueue).toHaveBeenCalledWith(expect.anything(), {
      coordinationDomain: null,
      paths: [],
      owner: undefined,
      includeCompleted: undefined,
    });
  });

  it('EI-22075918402561858: maps external_paths to @external/home/* keys and merges with paths', async () => {
    await tool.handler({ paths: ['x.ts'], external_paths: [join(homedir(), '.config', 'mimeapps.list')] }, ctx);
    expect(H.readQueue).toHaveBeenCalledWith(expect.anything(), {
      coordinationDomain: null,
      paths: ['x.ts', '@external/home/.config/mimeapps.list'],
      owner: undefined,
      includeCompleted: undefined,
    });
  });

  it('EI-22439115152462582: maps XDG_RUNTIME_DIR paths to @external/runtime/* keys', async () => {
    const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    try {
      await tool.handler(
        { external_paths: ['/run/user/1000/papercusp-p029-acceptance/storage-state.json'] },
        ctx,
      );
      expect(H.readQueue).toHaveBeenCalledWith(expect.anything(), {
        coordinationDomain: null,
        paths: ['@external/runtime/papercusp-p029-acceptance/storage-state.json'],
        owner: undefined,
        includeCompleted: undefined,
      });
    } finally {
      if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    }
  });

  it('maps a managed suite-app absolute path to the same repository domain and relative key as the edit hook', async () => {
    const workspaces = mkdtempSync(join(tmpdir(), 'locks-queue-suite-app-'));
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
    try {
      await tool.handler({ external_paths: [target] }, ctx);
      expect(H.readQueue).toHaveBeenCalledWith(expect.anything(), {
        coordinationDomain: realpathSync(portal),
        paths: ['packages/contracts/src/index.ts'],
        owner: undefined,
        includeCompleted: undefined,
      });
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

  it('EI-22075918402561858: external_paths alone (paths omitted) filters by the mapped key only', async () => {
    await tool.handler({ external_paths: [join(homedir(), '.config', 'mimeapps.list')] }, ctx);
    expect(H.readQueue).toHaveBeenCalledWith(expect.anything(), {
      coordinationDomain: null,
      paths: ['@external/home/.config/mimeapps.list'],
      owner: undefined,
      includeCompleted: undefined,
    });
  });

  it('EI-22075918402561858: an explicit empty external_paths (paths omitted) still fails closed', async () => {
    await tool.handler({ external_paths: [] }, ctx);
    expect(H.readQueue).toHaveBeenCalledWith(expect.anything(), {
      coordinationDomain: null,
      paths: [],
      owner: undefined,
      includeCompleted: undefined,
    });
  });

  it('EI-22075918402561858: an external_paths entry outside home returns a validation error, not a throw', async () => {
    const out = payload((await tool.handler({ external_paths: ['/etc/hosts'] }, ctx)) as never);
    expect(out).toMatchObject({ ok: false });
    expect(out.error).toMatch(/below/);
    expect(H.readQueue).not.toHaveBeenCalled();
  });

  it('omitting both paths and external_paths stays an unfiltered scan', async () => {
    await tool.handler({}, ctx);
    expect(H.readQueue).toHaveBeenCalledWith(expect.anything(), {
      coordinationDomain: null,
      paths: undefined,
      owner: undefined,
      includeCompleted: undefined,
    });
  });

  it('serializes Date fields on active_locks + waiting to ISO strings', async () => {
    const acquired = new Date('2026-06-01T00:00:00.000Z');
    const expires = new Date('2026-06-01T00:20:00.000Z');
    const queued = new Date('2026-06-01T00:05:00.000Z');
    const waitUntil = new Date('2026-06-01T00:10:00.000Z');
    H.state.queue = {
      active_locks: [{ lock_id: 'l1', path: 'a.ts', acquired_ts: acquired, expires_ts: expires }],
      waiting: [{ waiter_id: 'w1', path: 'a.ts', queued_ts: queued, wait_until: waitUntil }],
    };
    const out = payload((await tool.handler({}, ctx)) as never);
    expect(out.active_locks[0]).toMatchObject({ lock_id: 'l1', acquired_ts: acquired.toISOString(), expires_ts: expires.toISOString() });
    expect(out.waiting[0]).toMatchObject({ waiter_id: 'w1', queued_ts: queued.toISOString(), wait_until: waitUntil.toISOString() });
  });

  it('serializes an empty completed list when terminal waiters were not requested', async () => {
    const out = payload((await tool.handler({}, ctx)) as never);
    expect(out).toMatchObject({ active_locks: [], waiting: [], completed: [] });
  });

  it('maps the optional completed list when present', async () => {
    const queued = new Date('2026-06-01T00:00:00.000Z');
    const waitUntil = new Date('2026-06-01T00:01:00.000Z');
    H.state.queue = {
      active_locks: [],
      waiting: [],
      completed: [{ waiter_id: 'c1', queued_ts: queued, wait_until: waitUntil }],
    };
    const out = payload((await tool.handler({ include_completed: true }, ctx)) as never);
    expect(out.completed[0]).toMatchObject({ waiter_id: 'c1', queued_ts: queued.toISOString(), wait_until: waitUntil.toISOString() });
  });

  it('EI-7454: a transient statement_timeout (57014) on readQueue is retried, not surfaced', async () => {
    let calls = 0;
    H.readQueue.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        const e = new Error('canceling statement due to statement timeout') as Error & { code: string };
        e.code = '57014';
        throw e;
      }
      return { active_locks: [], waiting: [] };
    });
    const out = payload((await tool.handler({}, ctx)) as never);
    expect(calls).toBe(2);
    expect(out).toMatchObject({ active_locks: [], waiting: [] });
  });

  it('a non-contention error is NOT retried — propagates immediately', async () => {
    let calls = 0;
    H.readQueue.mockImplementation(async () => {
      calls += 1;
      throw new Error('boom: unrelated failure');
    });
    await expect(tool.handler({}, ctx)).rejects.toThrow('boom: unrelated failure');
    expect(calls).toBe(1);
  });
});
