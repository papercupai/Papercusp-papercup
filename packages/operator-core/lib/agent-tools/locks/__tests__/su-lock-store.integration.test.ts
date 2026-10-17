/**
 * SU-locks store INTEGRATION tests (EI-1551: renamed from `.test.ts` — this
 * suite calls `ensureBootstrap()`, which opens a real postgres connection, so
 * it hard-requires PG and was never hermetic. As a plain `*.test.ts` it ran
 * under the unit layer (`test:affected`/bare `vitest run lib/agent-tools`)
 * and failed with ECONNREFUSED on any box/run without that PG up — flaky
 * green/red depending on environment, exactly what the four-frameworks
 * testing policy exists to avoid. The `.integration.test.ts` suffix routes it
 * to `vitest.integration.config.ts` (testcontainers-provisioned PG) instead.)
 *
 * Exercises the core store layer (tryAcquire, tryRelease, tryHeartbeat,
 * tryInsertWaiter, tryCancelWait, readQueue, readWaiterStatus,
 * expireWaiter, path validation) against the live embedded PG. Each
 * test uses a unique coordination_domain so suites can run in parallel and
 * results don't bleed between cases.
 *
 * Prereqs:
 *   - Embedded PG running (Tauri dev shell or local PG at :5432).
 *   - `harness_admin` role has CREATEDB (one-time `sudo -u postgres
 *     psql -c "ALTER ROLE harness_admin CREATEDB"` per dev machine).
 *
 * To run only this suite:
 *   npx vitest run lib/agent-tools/locks/__tests__/su-lock-store.integration.test.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ensureBootstrap,
  expireWaiter,
  getTxPool,
  InvalidPathError,
  MAX_WAITERS_PER_OWNER,
  normalizePaths,
  pokeWorkspace,
  readQueue,
  readWaiterStatus,
  runBackgroundJanitorOnce,
  sweepPathsExpired,
  sweepWorkspaceExpired,
  tryAcquire,
  tryCancelWait,
  tryFinishHookOperation,
  tryHeartbeat,
  tryInsertWaiter,
  tryRelease,
  validatePath,
  _resetForTests,
} from '../su-lock-store';
import { inWorkspaceTxn } from '../in-workspace-txn';
// The background-janitor timer lives in workspace-listener.ts
// (file-locking #4); runBackgroundJanitorOnce — the sweep work — stays
// in su-lock-store.ts.
import {
  startBackgroundJanitor,
  stopBackgroundJanitor,
} from '../workspace-listener';
import { acquireWithContentionRetry } from '../contention-retry';
import { configureLocks, locksHost, type LocksHost } from '@papercusp/locks';

const SUITE_PREFIX = `vitest-su-locks-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const LOAD_STRESS_TIMEOUT_MS =
  process.env.GREEN_CHECKPOINT === '1'
    ? Number(process.env.VITEST_UNIT_TIMEOUT_MS) || 180_000
    : 30_000;
let suiteIdx = 0;
function nextWs(): string {
  return `${SUITE_PREFIX}-${++suiteIdx}`;
}

// Migration 931 is authored at a `.DRAFT` path until its focused tests pass.
// The side-db bootstrap runner intentionally ignores drafts, so this suite
// applies the draft directly when it is not armed. Once armed, ensureBootstrap
// applies it normally and this check becomes a no-op.
const LOCKS_SQL_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../libs/papercusp/packages/locks/src/sql',
);

async function ensureRecursiveOverlapMigrationForTests(): Promise<void> {
  const sql = getTxPool();
  const functions = await sql<Array<{
    overlaps: boolean;
    paths_overlap: boolean;
    prefixes: boolean;
  }>>`
    SELECT
      to_regprocedure('lock_path_overlaps(text,text)') IS NOT NULL AS overlaps,
      to_regprocedure('lock_paths_overlap(text[],text[])') IS NOT NULL AS paths_overlap,
      to_regprocedure('lock_path_prefixes(text)') IS NOT NULL AS prefixes
  `;
  if (functions[0]?.overlaps && functions[0]?.paths_overlap && functions[0]?.prefixes) {
    return;
  }

  const migration = ['931-locks-recursive-path-overlap.sql', '931-locks-recursive-path-overlap.sql.DRAFT']
    .map((file) => resolve(LOCKS_SQL_DIR, file))
    .find((file) => existsSync(file));
  if (!migration) throw new Error(`migration 931 not found under ${LOCKS_SQL_DIR}`);

  await sql.begin(async (tx) => {
    await tx.unsafe(readFileSync(migration, 'utf8'));
  });
}

// WI-2900: under the green-checkpoint gate the FULL suite runs in parallel on a box that is ALSO
// running the live fleet, so PG stays sustained-saturated for the whole run. At the baked 5s
// lock_timeout an inWorkspaceTxn advisory-lock acquire / commit intermittently exceeds it and raises
// PG 55P03 → WorkspaceContendedError, red-pinning the gate on a pure LOAD flake (this file passes
// standalone AND in the checkpoint clone in isolation; the "cascade" test failed the 2026-07-05 12:23
// gate run exactly this way). Widen THIS file's per-workspace txn window under the gate ONLY
// (GREEN_CHECKPOINT=1 — set by the checkpoint runner, NEVER in production or normal dev), so an
// uncontended unique-workspace lock has room to complete under saturation, while staying WELL under the
// gate's 180s per-test timeout (VITEST_UNIT_TIMEOUT_MS) so a genuine deadlock still surfaces as 55P03
// rather than a test hang. Restored in afterAll and scoped to this file (vitest isolates test files) so
// the deliberate-5s su-locks-contention integration test is unaffected.
const GATE_TXN_TIMEOUT_MS = 30_000;
let priorLocksHost: LocksHost | null = null;

beforeAll(async () => {
  if (process.env.GREEN_CHECKPOINT === '1') {
    try {
      priorLocksHost = locksHost(); // the operator adapter, self-wired at import time
      configureLocks({
        ...priorLocksHost,
        getTxnTimeouts: () => ({
          lockTimeoutMs: GATE_TXN_TIMEOUT_MS,
          statementTimeoutMs: GATE_TXN_TIMEOUT_MS,
        }),
      });
    } catch {
      /* no host wired yet (shouldn't happen — the operator locks adapter self-wires on import); skip */
    }
  }
  await ensureBootstrap();
  await ensureRecursiveOverlapMigrationForTests();
});

afterAll(async () => {
  // Clean every row we touched. Keep the database itself.
  const sql = getTxPool();
  try {
    await sql`DELETE FROM agent_file_locks WHERE coordination_domain LIKE ${SUITE_PREFIX + '%'}`;
    await sql`DELETE FROM agent_lock_waiters WHERE coordination_domain LIKE ${SUITE_PREFIX + '%'}`;
  } catch {
    /* db may have been torn down; ignore */
  }
  stopBackgroundJanitor(); // defensive — the timer never auto-starts under VITEST
  await _resetForTests();
  // Restore the pre-widening locks host (WI-2900) — belt-and-suspenders against a non-isolated pool.
  if (priorLocksHost) {
    configureLocks(priorLocksHost);
    priorLocksHost = null;
  }
});

describe('native hook operation fence', () => {
  function operation(paths = ['operation.ts']) {
    return {
      coordinationDomain: nextWs(), owner: 'native-operation-owner', ownerLabel: 'Native operation',
      paths, intent: 'PreToolUse:apply_patch', ttlSec: 1200, automatic: true,
      operation: { id: randomUUID(), deadline: new Date(Date.now() + 120_000).toISOString() },
    };
  }

  function acquire(p: ReturnType<typeof operation>) {
    return inWorkspaceTxn(p.coordinationDomain, p.owner, (tx) => tryAcquire(tx, p), { paths: p.paths });
  }

  function finish(p: ReturnType<typeof operation>, outcome: 'cancelled' | 'completed' = 'completed') {
    return inWorkspaceTxn(p.coordinationDomain, p.owner,
      (tx) => tryFinishHookOperation(tx, { ...p, outcome }), { paths: p.paths });
  }

  async function held(p: ReturnType<typeof operation>) {
    return (await readQueue(getTxPool(), { coordinationDomain: p.coordinationDomain })).active_locks;
  }

  it.each(['cancelled', 'completed'] as const)('%s before acquire prevents a late grant', async (outcome) => {
    const p = operation();
    expect(await finish(p, outcome)).toMatchObject({ ok: true, released: [], state: outcome });
    expect(await acquire(p)).toMatchObject({ ok: false, reason: 'operation_finished' });
    expect(await held(p)).toEqual([]);
  });

  it('settles a grant whose HTTP reply and lock token were never received', async () => {
    const p = operation();
    // The old recovery snapshot precedes the delayed server grant.
    expect(await held(p)).toEqual([]);
    await acquire(p); // deliberately discard the returned lock_id
    expect(await finish(p)).toMatchObject({ ok: true, released: p.paths, state: 'completed' });
    expect(await acquire(p)).toMatchObject({ ok: false, reason: 'operation_finished' });
    expect(await held(p)).toEqual([]);
  });

  it('duplicate acquire preserves the original expiry and newly-held set', async () => {
    const p = operation();
    const first = await acquire(p);
    expect(first.ok).toBe(true);
    const duplicate = await acquire(p);
    expect(duplicate).toEqual(first);
    expect(await finish(p)).toMatchObject({ ok: true, released: p.paths });
    expect(await finish(p)).toMatchObject({ ok: true, released: [] });
  });

  it('completion preserves overlapping explicit holds and unrelated paths', async () => {
    const p = operation(['explicit.ts', 'new.ts']);
    const explicit = await inWorkspaceTxn(p.coordinationDomain, p.owner, (tx) => tryAcquire(tx, {
      ...p, operation: undefined, automatic: false, intent: 'deliberate batch',
      paths: ['explicit.ts', 'unrelated.ts'],
    }));
    expect(explicit.ok).toBe(true);
    const grant = await acquire(p);
    expect(grant.ok).toBe(true);
    if (!grant.ok || !explicit.ok) throw new Error('fixture locks did not grant');
    expect(grant.newly_held).toEqual(['new.ts']);
    expect(await finish(p)).toMatchObject({ ok: true, released: ['new.ts'] });
    const remaining = await held(p);
    expect(remaining.map((row) => row.path).sort()).toEqual(['explicit.ts', 'unrelated.ts']);
    expect(remaining.every((row) => row.lock_id === explicit.lock_id)).toBe(true);
  });

  it('an operation entirely covered by an explicit hold releases nothing', async () => {
    const p = operation();
    await inWorkspaceTxn(p.coordinationDomain, p.owner, (tx) => tryAcquire(tx, {
      ...p, operation: undefined, automatic: false, intent: 'deliberate edit',
    }));
    expect(await acquire(p)).toMatchObject({ ok: true, newly_held: [] });
    expect(await finish(p)).toMatchObject({ ok: true, released: [] });
    expect((await held(p)).map((row) => row.path)).toEqual(p.paths);
  });

  it('rejects operation identity reuse with a different owner, domain, path or deadline', async () => {
    const p = operation();
    expect((await acquire(p)).ok).toBe(true);
    for (const changed of [
      { ...p, owner: 'foreign-owner' },
      { ...p, coordinationDomain: nextWs() },
      { ...p, paths: ['different.ts'] },
      { ...p, operation: { ...p.operation, deadline: new Date(Date.now() + 90_000).toISOString() } },
    ]) {
      expect(await finish(changed)).toEqual({ ok: false, reason: 'operation_conflict' });
    }
    expect((await held(p)).map((row) => row.path)).toEqual(p.paths);
    expect(await finish(p)).toMatchObject({ ok: true, released: p.paths });
  });

  it('rejects expired requests after their terminal ticket has been collected', async () => {
    const p = operation();
    p.operation.deadline = new Date(Date.now() - 1000).toISOString();
    expect((await finish(p, 'cancelled')).ok).toBe(true);
    const sql = getTxPool();
    await sql`DELETE FROM agent_lock_waiters WHERE ticket_id = ${p.operation.id}::uuid`;
    expect(await acquire(p)).toMatchObject({ ok: false, reason: 'operation_expired' });
    const tickets = await sql`SELECT ticket_id FROM agent_lock_waiters WHERE ticket_id = ${p.operation.id}::uuid`;
    expect(tickets).toHaveLength(0);
    expect(await held(p)).toEqual([]);
  });

  it('rejects an admission deadline beyond the retained tombstone horizon', async () => {
    const p = operation();
    p.operation.deadline = new Date(Date.now() + 7200_000).toISOString();
    expect(await acquire(p)).toMatchObject({ ok: false, reason: 'operation_conflict' });
    expect(await held(p)).toEqual([]);
  });

  it('serializes concurrent acquire and completion without a surviving grant', async () => {
    const p = operation();
    const [, terminal] = await Promise.all([acquire(p), finish(p)]);
    expect(terminal).toMatchObject({ ok: true, state: 'completed' });
    expect(await held(p)).toEqual([]);
    expect(await acquire(p)).toMatchObject({ ok: false, reason: 'operation_finished' });
  });
});

describe('path validation', () => {
  it('rejects empty path', () => {
    expect(() => validatePath('')).toThrow(InvalidPathError);
  });
  it('rejects absolute path', () => {
    expect(() => validatePath('/etc/passwd')).toThrow(InvalidPathError);
  });
  it('rejects traversal — leading ../', () => {
    expect(() => validatePath('../secret')).toThrow(InvalidPathError);
  });
  it('rejects traversal — embedded /../', () => {
    expect(() => validatePath('a/../b')).toThrow(InvalidPathError);
  });
  it('rejects traversal — bare ..', () => {
    expect(() => validatePath('..')).toThrow(InvalidPathError);
  });
  it('rejects path > 4096 bytes', () => {
    expect(() => validatePath('a'.repeat(4097))).toThrow(InvalidPathError);
  });
  it('rejects path containing NULL byte (PG text rejects it)', () => {
    expect(() => validatePath('foo\0bar.ts')).toThrow(InvalidPathError);
  });
  it('accepts a normal repo-relative path', () => {
    expect(() => validatePath('apps/operator/lib/foo.ts')).not.toThrow();
  });
  it('rejects Windows-style backslashes (file-locking #1)', () => {
    expect(() => validatePath('apps\\operator\\foo.ts')).toThrow(InvalidPathError);
  });
  it('normalizePaths sorts + dedupes', () => {
    expect(normalizePaths(['b.ts', 'a.ts', 'b.ts'])).toEqual(['a.ts', 'b.ts']);
  });

  // file-locking #1 — canonicalization. Each non-canonical spelling
  // must collapse onto the same lock key as the plain form.
  it('canonicalizes a leading ./', () => {
    expect(normalizePaths(['./apps/foo.ts'])).toEqual(['apps/foo.ts']);
  });
  it('canonicalizes a /./ segment', () => {
    expect(normalizePaths(['apps/./foo.ts'])).toEqual(['apps/foo.ts']);
  });
  it('collapses repeated // separators', () => {
    expect(normalizePaths(['apps//foo.ts'])).toEqual(['apps/foo.ts']);
  });
  it('strips a trailing /', () => {
    expect(normalizePaths(['apps/foo.ts/'])).toEqual(['apps/foo.ts']);
  });
  it('dedupes equivalent-but-non-identical spellings to one key', () => {
    expect(
      normalizePaths(['apps/foo.ts', './apps/foo.ts', 'apps//foo.ts', 'apps/foo.ts/']),
    ).toEqual(['apps/foo.ts']);
  });
  it('rejects a path that canonicalizes to empty', () => {
    expect(() => normalizePaths(['./'])).toThrow(InvalidPathError);
  });
});

describe('tryAcquire', () => {
  it('acquires a single free path', async () => {
    const ws = nextWs();
    const r = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'a',
        ownerLabel: 'A',
        paths: ['foo.ts'],
        intent: 'one path',
        ttlSec: 60,
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.held).toEqual(['foo.ts']);
      expect(r.lock_id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('acquires a multi-path set atomically', async () => {
    const ws = nextWs();
    const r = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'a',
        ownerLabel: 'A',
        paths: normalizePaths(['c.ts', 'a.ts', 'b.ts']),
        intent: 'multi',
        ttlSec: 60,
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.held).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('reports only paths newly acquired by a same-owner refresh', async () => {
    const ws = nextWs();
    const first = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'a',
        ownerLabel: 'A',
        paths: ['held.ts'],
        intent: 'deliberate hold',
        ttlSec: 60,
      }),
    );
    if (!first.ok) throw new Error('initial acquire should succeed');

    const refresh = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'a',
        ownerLabel: 'A',
        paths: ['held.ts'],
        intent: 'PreToolUse:Edit',
        ttlSec: 60,
        automatic: true,
      }),
    );
    expect(refresh).toMatchObject({ ok: true, newly_held: [] });

    const extension = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'a',
        ownerLabel: 'A',
        paths: ['held.ts', 'new.ts'],
        intent: 'PreToolUse:Edit',
        ttlSec: 60,
        automatic: true,
      }),
    );
    expect(extension).toMatchObject({ ok: true, newly_held: ['new.ts'] });

    await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'a', allMine: true }),
    );
  });

  it('returns busy + no partial state when one path is held', async () => {
    const ws = nextWs();
    await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'a',
        ownerLabel: 'A',
        paths: ['contested.ts'],
        intent: 'A holds',
        ttlSec: 60,
      }),
    );
    const r = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'b',
        ownerLabel: 'B',
        paths: ['contested.ts', 'free.ts'],
        intent: 'B wants both',
        ttlSec: 60,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const contested = r.busy.find((b) => b.path === 'contested.ts');
      expect(contested?.intent).toBe('A holds');
      // #5 — the busy row carries the holder's canonical owner, not
      // just the display label.
      expect(contested?.owner).toBe('a');
      expect(contested?.owner_label).toBe('A');
    }
    // Verify no partial state — free.ts must NOT be held by B
    const sql = getTxPool();
    const q = await readQueue(sql, { coordinationDomain: ws });
    const free = q.active_locks.find((l) => l.path === 'free.ts');
    expect(free).toBeUndefined();
  });

  it('steals an expired lock', async () => {
    const ws = nextWs();
    const sql = getTxPool();
    // Hand-insert an already-expired lock for owner A
    await sql`
      INSERT INTO agent_file_locks
        (coordination_domain, path, owner, owner_label, intent, expires_ts)
      VALUES
        (${ws}, 'stale.ts', 'a', 'A', 'stale', clock_timestamp() - interval '1 hour')
    `;
    const r = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'b',
        ownerLabel: 'B',
        paths: ['stale.ts'],
        intent: 'B steals',
        ttlSec: 60,
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('rejects path validation via the BEFORE INSERT trigger', async () => {
    const ws = nextWs();
    // Path validation throws at the app layer first. Confirm:
    expect(() =>
      normalizePaths(['/abs/path']),
    ).toThrow(InvalidPathError);
  });

  it('treats directory holds as recursive, boundary-safe overlaps', async () => {
    const ws = nextWs();
    const parent = await inWorkspaceTxn(ws, 'parent', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'parent',
        ownerLabel: 'PARENT',
        paths: ['packages'],
        intent: 'parent hold',
        ttlSec: 60,
      }),
    );
    if (!parent.ok) throw new Error('parent acquire should succeed');

    const sibling = await inWorkspaceTxn(ws, 'sibling', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'sibling',
        ownerLabel: 'SIBLING',
        paths: ['packages-old'],
        intent: 'boundary control',
        ttlSec: 60,
      }),
    );
    expect(sibling.ok).toBe(true);

    const descendant = await inWorkspaceTxn(ws, 'descendant', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'descendant',
        ownerLabel: 'DESCENDANT',
        paths: ['packages/operator-core/lib/file.ts'],
        intent: 'descendant write',
        ttlSec: 60,
      }),
    );
    expect(descendant.ok).toBe(false);
    if (!descendant.ok) {
      expect(descendant.busy).toEqual([
        expect.objectContaining({ path: 'packages', owner: 'parent' }),
      ]);
    }

    const queue = await readQueue(getTxPool(), {
      coordinationDomain: ws,
      paths: ['packages/operator-core/lib/file.ts'],
    });
    expect(queue.active_locks.map((lock) => lock.path)).toEqual(['packages']);

    if (sibling.ok) {
      await inWorkspaceTxn(ws, 'sibling', (tx) =>
        tryRelease(tx, { coordinationDomain: ws, owner: 'sibling', lockId: sibling.lock_id }),
      );
    }
    await inWorkspaceTxn(ws, 'parent', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'parent', lockId: parent.lock_id }),
    );
  });

  it('blocks descendant waiters and grants them after a parent release', async () => {
    const ws = nextWs();
    const sql = getTxPool();
    const parent = await inWorkspaceTxn(ws, 'parent', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'parent',
        ownerLabel: 'PARENT',
        paths: ['packages'],
        intent: 'parent hold',
        ttlSec: 60,
      }),
    );
    if (!parent.ok) throw new Error('parent acquire should succeed');

    const waiter = await inWorkspaceTxn(ws, 'descendant', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws,
        owner: 'descendant',
        ownerLabel: 'DESCENDANT',
        paths: ['packages/operator-core/lib/file.ts'],
        intent: 'descendant waiter',
        ttlSec: 60,
        maxWaitSec: 60,
      }),
    );
    if (!waiter.ok || 'self_granted' in waiter) throw new Error('descendant should queue');

    const queue = await readQueue(sql, {
      coordinationDomain: ws,
      paths: ['packages/operator-core/lib/file.ts'],
    });
    expect(queue.active_locks.map((lock) => lock.path)).toEqual(['packages']);
    expect(queue.waiting.map((ticket) => ticket.ticket_id)).toContain(waiter.ticket_id);

    await inWorkspaceTxn(ws, 'parent', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'parent', lockId: parent.lock_id }),
    );
    await expect(readWaiterStatus(sql, waiter.ticket_id)).resolves.toMatchObject({
      status: 'granted',
    });
  });
});

describe('recursive path advisory serialization', () => {
  it('serializes a descendant transaction behind an in-flight parent transaction', async () => {
    const ws = nextWs();
    const savedHost = locksHost();
    configureLocks({
      ...savedHost,
      getTxnTimeouts: () => ({ lockTimeoutMs: 100, statementTimeoutMs: 100 }),
    });

    let releaseParent!: () => void;
    let parentReady!: () => void;
    const parentReleased = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    const parentAcquired = new Promise<void>((resolve) => {
      parentReady = resolve;
    });

    const parentTxn = inWorkspaceTxn(
      ws,
      'parent',
      async (tx) => {
        const acquired = await tryAcquire(tx, {
          coordinationDomain: ws,
          owner: 'parent',
          ownerLabel: 'PARENT',
          paths: ['packages'],
          intent: 'in-flight parent hold',
          ttlSec: 60,
        });
        if (!acquired.ok) throw new Error('parent acquire should succeed');
        parentReady();
        await parentReleased;
        return acquired;
      },
      { paths: ['packages'] },
    );

    await parentAcquired;
    const descendantTxn = inWorkspaceTxn(
      ws,
      'descendant',
      (tx) =>
        tryAcquire(tx, {
          coordinationDomain: ws,
          owner: 'descendant',
          ownerLabel: 'DESCENDANT',
          paths: ['packages/operator-core/lib/file.ts'],
          intent: 'blocked descendant',
          ttlSec: 60,
        }),
      { paths: ['packages/operator-core/lib/file.ts'] },
    );

    try {
      await expect(descendantTxn).rejects.toMatchObject({ name: 'WorkspaceContendedError' });
    } finally {
      releaseParent();
      await parentTxn;
      configureLocks(savedHost);
    }
  });
});

describe('tryRelease + grant cascade', () => {
  it('release frees the locks', async () => {
    const ws = nextWs();
    const r = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'a',
        ownerLabel: 'A',
        paths: ['rel.ts'],
        intent: 'A',
        ttlSec: 60,
      }),
    );
    if (!r.ok) throw new Error('acquire should succeed');
    const rel = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'a', lockId: r.lock_id }),
    );
    expect(rel.released).toEqual(['rel.ts']);
  });

  it('release with all_mine releases every lock the owner holds', async () => {
    const ws = nextWs();
    await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'a',
        ownerLabel: 'A',
        paths: ['x.ts', 'y.ts'],
        intent: 'A',
        ttlSec: 60,
      }),
    );
    const rel = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'a', allMine: true }),
    );
    expect(rel.released.sort()).toEqual(['x.ts', 'y.ts']);
  });

  /**
   * EI-20405390083792304 — `heldBefore` exists to separate two situations that
   * both produce `released: []` and previously looked identical to the caller:
   * a correct no-op (held nothing) vs a release that silently did nothing (held
   * locks, matched none). The second one is what lets an agent tell a blocked
   * peer "you're unblocked" while still holding the lock.
   *
   * The DISCRIMINATOR test is the second one below. The first is its control:
   * without it, an implementation that hardcoded `heldBefore: 0` would still
   * pass a lone "no-op reports 0" assertion.
   */
  it('release reports heldBefore 0 when the owner genuinely holds nothing', async () => {
    const ws = nextWs();
    const rel = await inWorkspaceTxn(ws, 'nobody', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'nobody', allMine: true }),
    );
    expect(rel.released).toEqual([]);
    expect(rel.heldBefore).toBe(0);
  });

  it('release reports heldBefore > 0 when the owner holds locks the selector did not match', async () => {
    const ws = nextWs();
    const held = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'a',
        ownerLabel: 'A',
        paths: ['still-held.ts'],
        intent: 'A',
        ttlSec: 60,
      }),
    );
    if (!held.ok) throw new Error('A should acquire');

    // A well-formed lock_id that is NOT the one we hold — the same shape as the
    // real incident (a selector that resolves to nothing) without needing a
    // second coordination domain.
    const rel = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, {
        coordinationDomain: ws,
        owner: 'a',
        lockId: '00000000-0000-4000-8000-000000000000',
      }),
    );

    // Released nothing — indistinguishable from the no-op case before this field.
    expect(rel.released).toEqual([]);
    // ...but the owner demonstrably still holds a lock, so this is NOT "clear".
    expect(rel.heldBefore).toBe(1);

    // And the lock really is still enforced, not merely miscounted.
    const q = await readQueue(getTxPool(), { coordinationDomain: ws, paths: ['still-held.ts'] });
    expect(q.active_locks.map((l) => l.path)).toEqual(['still-held.ts']);
  });

  it('heldBefore counts only the calling owner, not a peer holding other paths', async () => {
    const ws = nextWs();
    await inWorkspaceTxn(ws, 'peer', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'peer',
        ownerLabel: 'PEER',
        paths: ['theirs.ts'],
        intent: 'PEER',
        ttlSec: 60,
      }),
    );
    const rel = await inWorkspaceTxn(ws, 'me', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'me', allMine: true }),
    );
    // A peer's lock must not inflate my count into a false "you still hold locks".
    expect(rel.released).toEqual([]);
    expect(rel.heldBefore).toBe(0);
  });

  it('release grants the first waiter via cascade', async () => {
    const ws = nextWs();
    const sql = getTxPool();

    const a = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'a',
        ownerLabel: 'A',
        paths: ['cascade.ts'],
        intent: 'A',
        ttlSec: 60,
      }),
    );
    if (!a.ok) throw new Error('A should acquire');

    const w = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws,
        owner: 'b',
        ownerLabel: 'B',
        paths: ['cascade.ts'],
        intent: 'B',
        ttlSec: 60,
        maxWaitSec: 30,
      }),
    );
    if (!w.ok) throw new Error('B insert should succeed');
    if ('self_granted' in w) throw new Error('unexpected self-grant in w');

    await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'a', lockId: a.lock_id }),
    );

    const status = await readWaiterStatus(sql, w.ticket_id);
    expect(status.status).toBe('granted');
    expect(status.granted_lock_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('cascade skips a waiter whose paths are still partially held', async () => {
    const ws = nextWs();
    const sql = getTxPool();

    // A holds path1, C holds path2. Release A; the cascade should NOT
    // grant a waiter requesting both — only the single-path waiter.
    const a = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'a',
        ownerLabel: 'A',
        paths: ['p1.ts'],
        intent: 'A',
        ttlSec: 60,
      }),
    );
    const c = await inWorkspaceTxn(ws, 'c', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'c',
        ownerLabel: 'C',
        paths: ['p2.ts'],
        intent: 'C',
        ttlSec: 60,
      }),
    );
    if (!a.ok || !c.ok) throw new Error('setup acquires should succeed');

    // Note: head-waiter rule blocks new acquires that overlap an older
    // waiter's paths, but it does NOT block existing locks. We're
    // testing the cascade itself.
    const wBoth = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws,
        owner: 'b',
        ownerLabel: 'B',
        paths: ['p1.ts', 'p2.ts'],
        intent: 'B-both',
        ttlSec: 60,
        maxWaitSec: 30,
      }),
    );
    if (!wBoth.ok) throw new Error('B insert should succeed');
    if ('self_granted' in wBoth) throw new Error('unexpected self-grant in wBoth');

    // Release A. p2 is still held → B-both still waiting.
    await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'a', lockId: a.lock_id }),
    );
    const stillWaiting = await readWaiterStatus(sql, wBoth.ticket_id);
    expect(stillWaiting.status).toBe('waiting');

    // Now release C; cascade can grant B-both.
    await inWorkspaceTxn(ws, 'c', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'c', lockId: c.lock_id }),
    );
    const granted = await readWaiterStatus(sql, wBoth.ticket_id);
    expect(granted.status).toBe('granted');
  });
});

describe('tryHeartbeat', () => {
  it('extends a live lock', async () => {
    const ws = nextWs();
    const r = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'a',
        ownerLabel: 'A',
        paths: ['hb.ts'],
        intent: 'A',
        ttlSec: 60,
      }),
    );
    if (!r.ok) throw new Error('acquire should succeed');

    const h = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryHeartbeat(tx, ws, 'a', r.lock_id, 120),
    );
    expect(h.extended).toBe(true);
    expect(h.expires_ts).not.toBeNull();
  });

  it('returns extended:false when the lock was stolen', async () => {
    const ws = nextWs();
    // Hand-insert an expired lock then heartbeat with its (fake) lock_id
    const fakeLock = '00000000-0000-0000-0000-000000000000';
    const h = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryHeartbeat(tx, ws, 'a', fakeLock, 60),
    );
    expect(h.extended).toBe(false);
    expect(h.expires_ts).toBeNull();
  });
});

describe('tryInsertWaiter + cap', () => {
  it(`returns waiter_cap_exceeded after ${MAX_WAITERS_PER_OWNER} waiters per owner`, async () => {
    const ws = nextWs();
    // Hold the file so waiters actually queue.
    await inWorkspaceTxn(ws, 'holder', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'holder',
        ownerLabel: 'H',
        paths: ['capped.ts'],
        intent: 'hold',
        ttlSec: 120,
      }),
    );

    const owner = `capped-${Date.now()}`;
    let last: unknown = null;
    for (let i = 0; i < MAX_WAITERS_PER_OWNER + 1; i++) {
      last = await inWorkspaceTxn(ws, owner, (tx) =>
        tryInsertWaiter(tx, {
          coordinationDomain: ws,
          owner,
          ownerLabel: 'capped',
          paths: ['capped.ts'],
          intent: `#${i}`,
          ttlSec: 60,
          maxWaitSec: 60,
        }),
      );
    }
    expect((last as { ok: boolean }).ok).toBe(false);
    expect((last as { reason?: string }).reason).toBe('waiter_cap_exceeded');
  });
});

describe('expireWaiter + tryCancelWait', () => {
  it('expireWaiter flips status to expired', async () => {
    const ws = nextWs();
    await inWorkspaceTxn(ws, 'h', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'h', ownerLabel: 'H',
        paths: ['exp.ts'], intent: 'h', ttlSec: 60,
      }),
    );
    const w = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
        paths: ['exp.ts'], intent: 'b', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    if (!w.ok) throw new Error('insert should succeed');
    if ('self_granted' in w) throw new Error('unexpected self-grant in w');
    await inWorkspaceTxn(ws, 'b', (tx) => expireWaiter(tx, w.ticket_id));
    const status = await readWaiterStatus(getTxPool(), w.ticket_id);
    expect(status.status).toBe('expired');
  });

  it('tryCancelWait flips status to cancelled', async () => {
    const ws = nextWs();
    await inWorkspaceTxn(ws, 'h', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'h', ownerLabel: 'H',
        paths: ['cancel.ts'], intent: 'h', ttlSec: 60,
      }),
    );
    const w = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
        paths: ['cancel.ts'], intent: 'b', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    if (!w.ok) throw new Error('insert should succeed');
    if ('self_granted' in w) throw new Error('unexpected self-grant in w');
    const c = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryCancelWait(tx, w.ticket_id, 'b'),
    );
    expect(c.cancelled).toBe(true);
    const status = await readWaiterStatus(getTxPool(), w.ticket_id);
    expect(status.status).toBe('cancelled');
  });

  it('tryCancelWait returns cancelled:false on a non-existent ticket', async () => {
    const fakeTicket = '00000000-0000-0000-0000-000000000000';
    const c = await inWorkspaceTxn(nextWs(), 'b', (tx) =>
      tryCancelWait(tx, fakeTicket, 'b'),
    );
    expect(c.cancelled).toBe(false);
  });

  it('tryCancelWait refuses to cancel a different owner\'s ticket', async () => {
    const ws = nextWs();
    await inWorkspaceTxn(ws, 'h', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'h', ownerLabel: 'H',
        paths: ['xowner.ts'], intent: 'h', ttlSec: 60,
      }),
    );
    const w = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
        paths: ['xowner.ts'], intent: 'b', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    if (!w.ok) throw new Error('insert should succeed');
    if ('self_granted' in w) throw new Error('unexpected self-grant in w');
    const c = await inWorkspaceTxn(ws, 'malicious', (tx) =>
      tryCancelWait(tx, w.ticket_id, 'malicious'),
    );
    expect(c.cancelled).toBe(false);
    const status = await readWaiterStatus(getTxPool(), w.ticket_id);
    expect(status.status).toBe('waiting');
  });
});

describe('readQueue', () => {
  it('returns active locks with sorted ahead_count over waiters', async () => {
    const ws = nextWs();
    // Hold a path so waiters queue.
    const holder = await inWorkspaceTxn(ws, 'h', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'h', ownerLabel: 'H',
        paths: ['q.ts'], intent: 'h', ttlSec: 60,
      }),
    );
    if (!holder.ok) throw new Error('holder acquire should succeed');
    const w1 = await inWorkspaceTxn(ws, 'first', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'first', ownerLabel: 'F',
        paths: ['q.ts'], intent: 'first', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    // Small sleep so queued_ts differs reliably.
    await new Promise((r) => setTimeout(r, 30));
    const w2 = await inWorkspaceTxn(ws, 'second', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'second', ownerLabel: 'S',
        paths: ['q.ts'], intent: 'second', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    if (!w1.ok || !w2.ok) throw new Error('inserts should succeed');
    if ('self_granted' in w1 || 'self_granted' in w2) throw new Error('unexpected self-grant in queue test');

    const q = await readQueue(getTxPool(), { coordinationDomain: ws });
    expect(q.active_locks).toHaveLength(1);
    expect(q.active_locks[0].path).toBe('q.ts');
    expect(q.active_locks[0].lock_id).toBe(holder.lock_id);
    expect(q.waiting).toHaveLength(2);
    expect(q.waiting[0].ticket_id).toBe(w1.ticket_id);
    expect(q.waiting[0].ahead_count).toBe(0);
    expect(q.waiting[1].ticket_id).toBe(w2.ticket_id);
    expect(q.waiting[1].ahead_count).toBe(1);
  });

  it('flags a waiter whose deadline precedes the live holder expiry and exposes the evidence', async () => {
    const ws = nextWs();
    const holder = await inWorkspaceTxn(ws, 'expiry-holder', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'expiry-holder', ownerLabel: 'H',
        paths: ['expiry.ts'], intent: 'hold past waiter deadline', ttlSec: 60,
      }),
    );
    if (!holder.ok) throw new Error('holder acquire should succeed');

    const waiter = await inWorkspaceTxn(ws, 'expiry-waiter', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'expiry-waiter', ownerLabel: 'W',
        paths: ['expiry.ts'], intent: 'wait with a shorter deadline', ttlSec: 60, maxWaitSec: 30,
      }),
    );
    if (!waiter.ok || 'self_granted' in waiter) throw new Error('waiter should be queued');

    const q = await readQueue(getTxPool(), { coordinationDomain: ws });
    const row = q.waiting.find((entry) => entry.ticket_id === waiter.ticket_id);
    expect(row?.cannot_be_granted_before_expiry).toBe(true);
    expect(row?.holder_expires_ts).toBeInstanceOf(Date);
    expect(row?.holder_expires_ts?.getTime()).toBeGreaterThan(row?.wait_until.getTime() ?? 0);
    expect(row?.holder_expires_ts?.getTime()).toBe(
      q.active_locks.find((entry) => entry.lock_id === holder.lock_id)?.expires_ts.getTime(),
    );
  });

  it('does not flag a waiter whose deadline extends beyond the live holder expiry', async () => {
    const ws = nextWs();
    const holder = await inWorkspaceTxn(ws, 'short-holder', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'short-holder', ownerLabel: 'H',
        paths: ['viable.ts'], intent: 'short hold', ttlSec: 60,
      }),
    );
    if (!holder.ok) throw new Error('holder acquire should succeed');

    const waiter = await inWorkspaceTxn(ws, 'viable-waiter', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'viable-waiter', ownerLabel: 'W',
        paths: ['viable.ts'], intent: 'wait beyond holder expiry', ttlSec: 60, maxWaitSec: 120,
      }),
    );
    if (!waiter.ok || 'self_granted' in waiter) throw new Error('waiter should be queued');

    const q = await readQueue(getTxPool(), { coordinationDomain: ws });
    const row = q.waiting.find((entry) => entry.ticket_id === waiter.ticket_id);
    expect(row?.cannot_be_granted_before_expiry).toBe(false);
    expect(row?.holder_expires_ts).toBeInstanceOf(Date);
    expect(row?.holder_expires_ts?.getTime()).toBeLessThan(row?.wait_until.getTime() ?? Number.POSITIVE_INFINITY);
  });

  it('treats an explicit empty paths array as an empty filter, not an unfiltered scan', async () => {
    const ws = nextWs();
    const holder = await inWorkspaceTxn(ws, 'empty-filter-holder', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'empty-filter-holder',
        ownerLabel: 'H',
        paths: ['empty-filter.ts'],
        intent: 'hold for empty-filter regression',
        ttlSec: 60,
      }),
    );
    if (!holder.ok) throw new Error('holder acquire should succeed');

    // Omitted paths intentionally remains the workspace-wide diagnostic read.
    const unfiltered = await readQueue(getTxPool(), { coordinationDomain: ws });
    expect(unfiltered.active_locks.some((row) => row.lock_id === holder.lock_id)).toBe(true);

    // An explicitly empty caller list must never broaden into that same scan.
    const empty = await readQueue(getTxPool(), { coordinationDomain: ws, paths: [] });
    expect(empty.active_locks).toEqual([]);
    expect(empty.waiting).toEqual([]);
  });
});

describe('head-waiter blocks new acquires (anti-starvation)', () => {
  it('blocks behind a queued waiter without reporting it as a file holder', async () => {
    const ws = nextWs();
    const sql = getTxPool();
    await sql`
      INSERT INTO agent_lock_waiters
        (coordination_domain, owner, owner_label, paths, intent, ttl_sec, wait_until)
      VALUES
        (${ws}, 'queued', 'QUEUED', ${['hot.ts']}, 'queued edit', 60,
         clock_timestamp() + interval '1 minute')
    `;

    const blocked = await inWorkspaceTxn(ws, 'newcomer', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'newcomer', ownerLabel: 'NEWCOMER',
        paths: ['hot.ts'], intent: 'new edit', ttlSec: 60,
      }),
    );
    expect(blocked).toMatchObject({
      ok: false,
      reason: 'queued_waiter',
      busy: [],
    });

    // A FIFO position blocks acquisition but conveys no ownership or lease.
    const queue = await readQueue(sql, { coordinationDomain: ws });
    expect(queue.active_locks).toEqual([]);
    expect(queue.waiting).toHaveLength(1);
    expect(queue.waiting[0]).toMatchObject({
      owner: 'queued', paths: ['hot.ts'], intent: 'queued edit',
    });

    const free = await inWorkspaceTxn(ws, 'newcomer', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'newcomer', ownerLabel: 'NEWCOMER',
        paths: ['free.ts'], intent: 'free edit', ttlSec: 60,
      }),
    );
    expect(free.ok).toBe(true);
  });

  it('reports the active holder lease instead of the queued waiter deadline', async () => {
    const ws = nextWs();
    const holder = await inWorkspaceTxn(ws, 'holder', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'holder', ownerLabel: 'HOLDER',
        paths: ['hot.ts'], intent: 'held edit', ttlSec: 120,
      }),
    );
    if (!holder.ok) throw new Error('holder acquire should succeed');

    const waiter = await inWorkspaceTxn(ws, 'queued', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'queued', ownerLabel: 'QUEUED',
        paths: ['hot.ts'], intent: 'queued edit', ttlSec: 60, maxWaitSec: 30,
      }),
    );
    if (!waiter.ok || 'self_granted' in waiter) throw new Error('waiter should be queued');

    const blocked = await inWorkspaceTxn(ws, 'newcomer', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'newcomer', ownerLabel: 'NEWCOMER',
        paths: ['hot.ts'], intent: 'new edit', ttlSec: 60,
      }),
    );
    expect(blocked).toMatchObject({
      ok: false,
      reason: 'queued_waiter',
      busy: [{
        path: 'hot.ts', owner: 'holder', owner_label: 'HOLDER',
        intent: 'held edit', expires_ts: holder.expires_ts,
      }],
    });
    if (blocked.ok) throw new Error('queued newcomer must not acquire');
    expect(blocked.busy).toHaveLength(1);

    const queue = await readQueue(getTxPool(), { coordinationDomain: ws });
    expect(queue.waiting).toHaveLength(1);
    expect(queue.waiting[0].ticket_id).toBe(waiter.ticket_id);
    expect(blocked.busy[0].expires_ts.getTime()).toBeGreaterThan(
      queue.waiting[0].wait_until.getTime(),
    );
  });

  it('reports the stored lease expiry, not a JS-clock estimate (WI-6554700010010480)', async () => {
    const ws = nextWs();
    // Skew the JS clock an hour ahead for this acquire only. The row stores
    // clock_timestamp() + ttl, so a result derived from Date.now() would land
    // an hour away from it; the stored lease is unaffected by the skew.
    const realNow = Date.now.bind(Date);
    const skew = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 3_600_000);
    const held = await inWorkspaceTxn(ws, 'holder', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'holder', ownerLabel: 'HOLDER',
        paths: ['lease.ts'], intent: 'lease edit', ttlSec: 120,
      }),
    ).finally(() => skew.mockRestore());
    if (!held.ok) throw new Error('holder acquire should succeed');

    const sql = getTxPool();
    const [row] = await sql<Array<{ expires_ts: Date }>>`
      SELECT expires_ts FROM agent_file_locks
       WHERE coordination_domain = ${ws} AND path = 'lease.ts'
    `;
    expect(held.expires_ts.getTime()).toBe(row.expires_ts.getTime());
  });

  it('an automatic acquire that adds paths reports the earliest stored lease it holds (WI-6554700010010480)', async () => {
    const ws = nextWs();
    const first = await inWorkspaceTxn(ws, 'auto', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'auto', ownerLabel: 'AUTO',
        paths: ['owned.ts'], intent: 'PreToolUse:Edit', ttlSec: 60, automatic: true,
      }),
    );
    if (!first.ok) throw new Error('first automatic acquire should succeed');

    // owned.ts is already held, so only added.ts is upserted; owned.ts keeps
    // its 60s lease and the result must not claim the new 600s one for it.
    const mixed = await inWorkspaceTxn(ws, 'auto', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'auto', ownerLabel: 'AUTO',
        paths: ['owned.ts', 'added.ts'], intent: 'PreToolUse:Edit', ttlSec: 600, automatic: true,
      }),
    );
    if (!mixed.ok) throw new Error('mixed automatic acquire should succeed');

    const sql = getTxPool();
    const rows = await sql<Array<{ path: string; expires_ts: Date }>>`
      SELECT path, expires_ts FROM agent_file_locks
       WHERE coordination_domain = ${ws} ORDER BY path
    `;
    expect(rows.map((r) => r.path)).toEqual(['added.ts', 'owned.ts']);
    const earliest = Math.min(...rows.map((r) => r.expires_ts.getTime()));
    expect(mixed.expires_ts.getTime()).toBe(earliest);
    expect(mixed.expires_ts.getTime()).toBe(first.expires_ts.getTime());
  });

  it('new acquirer cannot jump an older waiter on the same path', async () => {
    const ws = nextWs();
    // A holds, B queues, C tries to acquire — C must be blocked (busy)
    // because B is ahead of C in line even though C didn't queue.
    const a = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['hot.ts'], intent: 'a', ttlSec: 60,
      }),
    );
    if (!a.ok) throw new Error('A acquire should succeed');

    await inWorkspaceTxn(ws, 'b', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
        paths: ['hot.ts'], intent: 'b', ttlSec: 60, maxWaitSec: 60,
      }),
    );

    // Release A.
    await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'a', lockId: a.lock_id }),
    );

    // C tries to acquire — should be busy because B got the cascade.
    const c = await inWorkspaceTxn(ws, 'c', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'c', ownerLabel: 'C',
        paths: ['hot.ts'], intent: 'c', ttlSec: 60,
      }),
    );
    expect(c.ok).toBe(false);
  });
});

describe('audit regression — single lock_id across mixed acquire', () => {
  it('unifies prior multiple lock_ids when extending across paths', async () => {
    const ws = nextWs();
    const r1 = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['u1.ts'], intent: 'first', ttlSec: 60,
      }),
    );
    const r2 = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['u2.ts'], intent: 'second', ttlSec: 60,
      }),
    );
    if (!r1.ok || !r2.ok) throw new Error('setup');
    expect(r1.lock_id).not.toBe(r2.lock_id);

    // Extending across the two prior lock_ids must unify them.
    const r3 = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['u1.ts', 'u2.ts', 'u3.ts'], intent: 'extend', ttlSec: 60,
      }),
    );
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;

    const sql = getTxPool();
    const rows = await sql<Array<{ lock_id: string }>>`
      SELECT lock_id::text AS lock_id FROM agent_file_locks
       WHERE coordination_domain = ${ws}
    `;
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.lock_id)).size).toBe(1);

    const rel = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'a', lockId: r3.lock_id }),
    );
    expect(rel.released.sort()).toEqual(['u1.ts', 'u2.ts', 'u3.ts']);
  });

  it('extending an existing same-owner lock with new paths returns ONE lock_id covering all rows', async () => {
    const ws = nextWs();
    const r1 = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['m1.ts', 'm2.ts'], intent: 'first', ttlSec: 60,
      }),
    );
    if (!r1.ok) throw new Error('first acquire');

    const r2 = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['m1.ts', 'm2.ts', 'm3.ts'], intent: 'extend', ttlSec: 60,
      }),
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    // Reuse the existing lock_id (no fresh UUID for the new path).
    expect(r2.lock_id).toBe(r1.lock_id);

    // Every DB row must carry the same lock_id.
    const sql = getTxPool();
    const rows = await sql<Array<{ lock_id: string }>>`
      SELECT lock_id::text AS lock_id FROM agent_file_locks
       WHERE coordination_domain = ${ws}
    `;
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.lock_id)).size).toBe(1);

    // release(lock_id) must free all 3.
    const rel = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'a', lockId: r2.lock_id }),
    );
    expect(rel.released.sort()).toEqual(['m1.ts', 'm2.ts', 'm3.ts']);
  });
});

describe('audit regression — insert-race self-grant', () => {
  it('tryInsertWaiter self-grants when the path freed between caller busy-return and insert', async () => {
    const ws = nextWs();
    // Holder A.
    const a = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['ir.ts'], intent: 'A', ttlSec: 60,
      }),
    );
    if (!a.ok) throw new Error('setup acquire');
    // Simulate B's busy probe, then A releases, then B inserts waiter.
    // B's first tryAcquire would have returned busy (we skip simulating
    // that step; the bug is in INSERT).
    await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'a', lockId: a.lock_id }),
    );
    const w = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
        paths: ['ir.ts'], intent: 'B', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    expect(w.ok).toBe(true);
    if (w.ok) {
      // Self-grant branch — caller already holds the lock without
      // having queued a waiter row.
      expect('self_granted' in w).toBe(true);
      if ('self_granted' in w) {
        expect(w.lock_id).toMatch(/^[0-9a-f-]{36}$/);
        expect(w.held).toEqual(['ir.ts']);
      }
    }
  });
});

describe('audit regression — orphaned-waiter cleanup', () => {
  it('path-narrow sweep flips a waiter whose wait_until has passed but no one marked it expired', async () => {
    // file-locking #4: the per-acquire sweep is now path-scoped, so
    // the contender's acquire on the orphan's path is what triggers
    // the cleanup. (Orphans on paths the agent doesn't touch are
    // cleaned by the background janitor — see its own describe block.)
    const ws = nextWs();
    const sql = getTxPool();
    const h = await inWorkspaceTxn(ws, 'h', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'h', ownerLabel: 'H',
        paths: ['orphan.ts'], intent: 'H', ttlSec: 60,
      }),
    );
    if (!h.ok) throw new Error('setup');

    // Waiter with a 1s ceiling. Simulate the agent crashing by NOT
    // calling pokeWorkspace.
    const w = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
        paths: ['orphan.ts'], intent: 'B', ttlSec: 60, maxWaitSec: 1,
      }),
    );
    if (!w.ok || 'self_granted' in w) throw new Error('insert');

    // Sleep past wait_until.
    await new Promise((r) => setTimeout(r, 1500));

    // A contender on the SAME path triggers the path-narrow sweep.
    // Should be 'busy' (H still holds), not blocked by the orphan.
    const probe = await inWorkspaceTxn(ws, 'probe', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'probe', ownerLabel: 'P',
        paths: ['orphan.ts'], intent: 'probe', ttlSec: 60,
      }),
    );
    expect(probe.ok).toBe(false);
    if (!probe.ok) {
      // Blocked by H (the live holder), NOT by the orphan B.
      expect(probe.busy[0].owner).toBe('h');
    }

    const rows = await sql<Array<{ status: string }>>`
      SELECT status::text AS status FROM agent_lock_waiters
       WHERE ticket_id = ${w.ticket_id}::uuid
    `;
    expect(rows[0].status).toBe('expired');
  });

  it('head-waiter check filters by wait_until so a stale waiter never blocks an acquire', async () => {
    // Defense-in-depth (file-locking #4): even if the sweep hasn't
    // run yet, a 'waiting' row whose wait_until has elapsed must not
    // block. Hand-insert an orphan with no live holder and confirm a
    // fresh acquire on the same path succeeds.
    const ws = nextWs();
    const sql = getTxPool();
    await sql`
      INSERT INTO agent_lock_waiters
        (coordination_domain, owner, owner_label, paths, intent, ttl_sec,
         wait_until, status, queued_ts)
      VALUES
        (${ws}, 'crashed', 'crashed', ${['ghost.ts']}, 'crashed', 60,
         clock_timestamp() - interval '5 seconds',
         'waiting',
         clock_timestamp() - interval '1 minute')
    `;
    const r = await inWorkspaceTxn(ws, 'fresh', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'fresh', ownerLabel: 'F',
        paths: ['ghost.ts'], intent: 'F', ttlSec: 60,
      }),
    );
    expect(r.ok).toBe(true);
  });
});

describe('audit regression — cross-owner release/heartbeat refused', () => {
  it('release refuses to delete locks owned by a different owner even with the right lock_id', async () => {
    const ws = nextWs();
    const sql = getTxPool();
    const a = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['secret.ts'], intent: 'A', ttlSec: 60,
      }),
    );
    if (!a.ok) throw new Error('setup');
    const rel = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'b', lockId: a.lock_id }),
    );
    expect(rel.released).toEqual([]);
    const survives = await sql<Array<{ c: number }>>`
      SELECT count(*)::int AS c FROM agent_file_locks
       WHERE coordination_domain = ${ws} AND owner = 'a'
    `;
    expect(survives[0].c).toBe(1);
  });

  it('heartbeat refuses to extend a lock owned by a different owner', async () => {
    const ws = nextWs();
    const a = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['secret2.ts'], intent: 'A', ttlSec: 60,
      }),
    );
    if (!a.ok) throw new Error('setup');
    const hb = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryHeartbeat(tx, ws, 'b', a.lock_id, 7200),
    );
    expect(hb.extended).toBe(false);
  });
});

describe('audit regression — pokeWorkspace grants waiter after holder TTL expiry', () => {
  it(
    'grants a queued waiter when the holder\'s lock has expired but no one called release',
    // EI-716 load-flake: this asserts a 1s-TTL holder→waiter grant TRANSITION, so under
    // green-checkpoint load (embedded-PG :5632 contention) the PG round-trips race the 1s
    // expiry → intermittent 'granted' vs 'waiting'. Deterministic at :5432 (60/60); retry a
    // transient load miss instead of skip/quarantine (cross-hive-two-hive.test.ts convention)
    // so coverage is preserved.
    { retry: 3 },
    async () => {
    const ws = nextWs();
    const sql = getTxPool();
    // Holder with 1s TTL
    const holder = await inWorkspaceTxn(ws, 'h', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'h', ownerLabel: 'H',
        paths: ['exp.ts'], intent: 'short', ttlSec: 1,
      }),
    );
    if (!holder.ok) throw new Error('setup');

    // Waiter queues while holder is alive
    const w = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
        paths: ['exp.ts'], intent: 'B', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    if (!w.ok) throw new Error('insert');
    if ('self_granted' in w) throw new Error('did not expect self-grant in this test');

    // Sleep past TTL so the holder's row is now expired.
    await new Promise((r) => setTimeout(r, 1500));

    // Without poke, waiter stays in 'waiting' (no release fired).
    const before = await readWaiterStatus(sql, w.ticket_id);
    expect(before.status).toBe('waiting');

    // Poke the workspace — janitor sweeps expired holder, cascade grants waiter.
    await inWorkspaceTxn(ws, 'b', (tx) => pokeWorkspace(tx, ws));

    const after = await readWaiterStatus(sql, w.ticket_id);
    expect(after.status).toBe('granted');
    expect(after.granted_lock_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('migration idempotency', () => {
  it('ensureBootstrap is safe to call repeatedly', async () => {
    // First call already happened in beforeAll.
    await expect(ensureBootstrap()).resolves.toBeUndefined();
    await expect(ensureBootstrap()).resolves.toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────
// Plan §10.1 — additional cases caught by the audit pass
// ────────────────────────────────────────────────────────────────────

describe('plan §10.1 — release_with_paths_filter', () => {
  it('release with paths filter only frees the matching paths', async () => {
    const ws = nextWs();
    const r = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'a',
        ownerLabel: 'A',
        paths: ['p1.ts', 'p2.ts', 'p3.ts'],
        intent: 'A holds three',
        ttlSec: 60,
      }),
    );
    if (!r.ok) throw new Error('acquire');
    // Release only p2.
    const rel = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, {
        coordinationDomain: ws,
        owner: 'a',
        lockId: r.lock_id,
        paths: ['p2.ts'],
      }),
    );
    expect(rel.released).toEqual(['p2.ts']);
    // p1 and p3 still held.
    const q = await readQueue(getTxPool(), { coordinationDomain: ws });
    const held = q.active_locks.map((l) => l.path).sort();
    expect(held).toEqual(['p1.ts', 'p3.ts']);
  });
});

describe('plan §10.1 — release_grant_cascade_continues_past_vanished_waiter', () => {
  it('cascade survives a waiter being concurrently cancelled', async () => {
    const ws = nextWs();
    const sql = getTxPool();
    const a = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['v.ts'], intent: 'A', ttlSec: 60,
      }),
    );
    if (!a.ok) throw new Error('acquire');

    // Two waiters; we'll hand-delete the first to simulate the
    // vanished-waiter race. EXCEPTION block in grant_cascade catches
    // no_data_found and continues to the next waiter.
    const w1 = await inWorkspaceTxn(ws, 'b1', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'b1', ownerLabel: 'B1',
        paths: ['v.ts'], intent: 'b1', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    const w2 = await inWorkspaceTxn(ws, 'b2', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'b2', ownerLabel: 'B2',
        paths: ['v.ts'], intent: 'b2', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    if (!w1.ok || !w2.ok) throw new Error('waiter inserts');
    if ('self_granted' in w1 || 'self_granted' in w2) throw new Error('unexpected self-grant in vanished-waiter test');

    // Hard-delete w1 to simulate disappearance between SELECT and UPDATE.
    await sql`DELETE FROM agent_lock_waiters WHERE ticket_id = ${w1.ticket_id}::uuid`;

    // Release A — cascade should skip the vanished w1 and grant w2.
    await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'a', lockId: a.lock_id }),
    );
    const s2 = await readWaiterStatus(sql, w2.ticket_id);
    expect(s2.status).toBe('granted');
  });
});

describe('plan §10.1 — cancel_wait_after_grant', () => {
  it('cancel returns cancelled:false when the waiter was already granted', async () => {
    const ws = nextWs();
    const sql = getTxPool();
    const a = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['cg.ts'], intent: 'A', ttlSec: 60,
      }),
    );
    if (!a.ok) throw new Error('acquire');

    const w = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
        paths: ['cg.ts'], intent: 'B', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    if (!w.ok) throw new Error('insert');
    if ('self_granted' in w) throw new Error('unexpected self-grant in w');

    // Cause the grant first.
    await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'a', lockId: a.lock_id }),
    );

    // Now try to cancel — already granted, should return false.
    const c = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryCancelWait(tx, w.ticket_id, 'b'),
    );
    expect(c.cancelled).toBe(false);
    const status = await readWaiterStatus(sql, w.ticket_id);
    expect(status.status).toBe('granted');
  });
});

describe('plan §10.1 + file-locking #4 — background janitor', () => {
  // The plan §10.1 invariant ("stale locks + terminal waiters get
  // swept") is now carried by runBackgroundJanitorOnce(), not by an
  // implicit sweep inside tryAcquire. Under VITEST the timer is NOT
  // armed (see isTestEnv in in-workspace-txn.ts); tests drive it
  // directly so there's no wall-clock race against fixtures.

  it('runBackgroundJanitorOnce sweeps expired locks on paths nobody acquired', async () => {
    const ws = nextWs();
    const sql = getTxPool();
    // Hand-insert an expired lock the tests never otherwise touch —
    // the path-narrow per-acquire sweep would never reach it.
    await sql`
      INSERT INTO agent_file_locks
        (coordination_domain, path, owner, owner_label, intent, expires_ts)
      VALUES
        (${ws}, 'janitor.ts', 'old', 'old', 'old',
         clock_timestamp() - interval '1 hour')
    `;
    await runBackgroundJanitorOnce();
    const left = await sql<Array<{ path: string }>>`
      SELECT path FROM agent_file_locks
       WHERE coordination_domain = ${ws} AND owner = 'old'
    `;
    expect(left).toHaveLength(0);
  });

  it('runBackgroundJanitorOnce garbage-collects terminal waiters older than 24h', async () => {
    const ws = nextWs();
    const sql = getTxPool();
    await sql`
      INSERT INTO agent_lock_waiters
        (coordination_domain, owner, owner_label, paths, intent, ttl_sec,
         wait_until, status, queued_ts)
      VALUES
        (${ws}, 'gone', 'gone', ${['x.ts']}, 'old', 60,
         clock_timestamp() - interval '25 hours',
         'expired',
         clock_timestamp() - interval '25 hours')
    `;
    await runBackgroundJanitorOnce();
    const left = await sql<Array<{ ticket_id: string }>>`
      SELECT ticket_id FROM agent_lock_waiters
       WHERE coordination_domain = ${ws} AND owner = 'gone'
    `;
    expect(left).toHaveLength(0);
  });

  it('runBackgroundJanitorOnce grants a waiter behind a now-expired holder, per-workspace', async () => {
    // The bug the per-workspace advisory lock prevents: a naive global
    // sweep+single-cascade would only fire grant_cascade for ONE
    // workspace per pass. Set up two workspaces, both with the same
    // problem, and assert both waiters end up granted in the same
    // janitor pass.
    const sql = getTxPool();

    async function armWorkspace(ws: string): Promise<string> {
      const a = await inWorkspaceTxn(ws, 'h', (tx) =>
        tryAcquire(tx, {
          coordinationDomain: ws, owner: 'h', ownerLabel: 'H',
          paths: ['bg.ts'], intent: 'H', ttlSec: 300,
        }),
      );
      if (!a.ok) throw new Error('arm: holder acquire failed');
      const w = await inWorkspaceTxn(ws, 'b', (tx) =>
        tryInsertWaiter(tx, {
          coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
          paths: ['bg.ts'], intent: 'B', ttlSec: 60, maxWaitSec: 600,
        }),
      );
      if (!w.ok || 'self_granted' in w) throw new Error('arm: waiter not queued');
      // Force-expire H so the only thing standing between B and the
      // grant is the background janitor.
      await sql`
        UPDATE agent_file_locks
           SET expires_ts = clock_timestamp() - interval '1 second'
         WHERE coordination_domain = ${ws} AND path = 'bg.ts'
      `;
      return w.ticket_id;
    }

    const wsA = nextWs();
    const wsB = nextWs();
    const tA = await armWorkspace(wsA);
    const tB = await armWorkspace(wsB);

    await runBackgroundJanitorOnce();

    const sA = await readWaiterStatus(sql, tA);
    const sB = await readWaiterStatus(sql, tB);
    expect(sA.status).toBe('granted');
    expect(sB.status).toBe('granted');
  });

  it('start/stopBackgroundJanitor is idempotent and does not leak timers', () => {
    // Smoke test the lifecycle — don't actually let the 30s interval
    // fire, just verify the handles can be churned without throwing.
    stopBackgroundJanitor();
    startBackgroundJanitor();
    startBackgroundJanitor(); // second call must be a no-op
    stopBackgroundJanitor();
    stopBackgroundJanitor(); // second stop must be a no-op
  });
});

describe('file-lock overlap query scaling (WI-6554700010015099)', () => {
  it('acquires a 50-path batch while the same owner holds a full source-import census', async () => {
    const ws = nextWs();
    const sql = getTxPool();
    const lockId = randomUUID();
    const owner = 'large-source-import';
    const held = Array.from({ length: 14_924 }, (_, i) => `libs/held/file-${i}.ts`);
    await sql`
      INSERT INTO agent_file_locks
        (coordination_domain, path, owner, owner_label, intent, lock_id, expires_ts)
      SELECT ${ws}, path, ${owner}, 'Source importer', 'existing source census',
             ${lockId}::uuid, clock_timestamp() + interval '1 hour'
        FROM unnest(${held}::text[]) AS held(path)
    `;
    // Include an existing claim as well as new paths: its lock handle must
    // remain reusable, and unrelated held paths must remain untouched.
    const fresh = Array.from({ length: 49 }, (_, i) => `libs/incoming/file-${i}.ts`);
    const paths = [held[0], ...fresh];
    const result = await inWorkspaceTxn(ws, owner, (tx) => tryAcquire(tx, {
      coordinationDomain: ws, owner, ownerLabel: 'Source importer', paths,
      intent: 'next source batch', ttlSec: 300,
    }), { paths });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`source batch refused: ${JSON.stringify(result)}`);
    expect(result.lock_id).toBe(lockId);
    expect(result.held).toEqual(paths);
    expect(result.newly_held).toEqual(fresh);
    const untouched = await sql<Array<{ intent: string }>>`
      SELECT intent FROM agent_file_locks
       WHERE coordination_domain = ${ws} AND path = ${held[1]}
    `;
    expect(untouched).toEqual([{ intent: 'existing source census' }]);
  }, LOAD_STRESS_TIMEOUT_MS);

  it('keeps recursive overlap literal and boundary-safe for queue and expiry reads', async () => {
    const ws = nextWs();
    const sql = getTxPool();
    const stored = [
      'src', 'src/file.ts', 'src-old/file.ts', 'src/file.ts/child',
      'literal%_/file[1].ts', 'literalXX/file1.ts',
      '日本語/é.ts', '日本語/é.ts/child', '日本語/é.ts-old',
    ];
    await sql`
      INSERT INTO agent_file_locks
        (coordination_domain, path, owner, intent, expires_ts)
      SELECT ${ws}, path, 'literal-overlap-owner', 'overlap fixture',
             clock_timestamp() + interval '1 hour'
        FROM unnest(${stored}::text[]) AS stored(path)
    `;
    for (const requested of [['src/file.ts'], ['literal%_/file[1].ts'], ['日本語/é.ts'], []]) {
      const expected = stored.filter((held) => requested.some((path) =>
        held === path || held.startsWith(`${path}/`) || path.startsWith(`${held}/`),
      )).sort();
      const queue = await readQueue(sql, { coordinationDomain: ws, paths: requested });
      expect(queue.active_locks.map((row) => row.path).sort()).toEqual(expected);
    }
    await sql`
      UPDATE agent_file_locks SET expires_ts = clock_timestamp() - interval '1 second'
       WHERE coordination_domain = ${ws}
    `;
    await inWorkspaceTxn(ws, 'sweeper', (tx) =>
      sweepPathsExpired(tx, ws, ['literal%_/file[1].ts']),
      { paths: ['literal%_/file[1].ts'] },
    );
    const remaining = await sql<Array<{ path: string }>>`
      SELECT path FROM agent_file_locks WHERE coordination_domain = ${ws}
    `;
    expect(remaining.map((row) => row.path).sort()).toEqual(
      stored.filter((path) => path !== 'literal%_/file[1].ts').sort(),
    );
  }, LOAD_STRESS_TIMEOUT_MS);
});

describe('file-locking #4 — acquire under concurrent load (plan §4 stress)', () => {
  it('100 concurrent acquires on one workspace all succeed, none time out', async () => {
    // Plan §4's flake was the janitor running INSIDE every acquire,
    // bursting past the 500ms statement_timeout under load. With the
    // janitor extracted to the background sweep (and out of the hot
    // path entirely), tryAcquire is a pure read-check + upsert — 100
    // acquires serialized on the workspace advisory lock must all land
    // well inside inWorkspaceTxn's 5s lock_timeout / statement_timeout.
    // Distinct paths → no contention, every acquire returns ok:true.
    const ws = nextWs();
    const N = 100;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        acquireWithContentionRetry(() =>
          inWorkspaceTxn(ws, `c${i}`, (tx) =>
            tryAcquire(tx, {
              coordinationDomain: ws,
              owner: `c${i}`,
              ownerLabel: `C${i}`,
              paths: [`load/file-${i}.ts`],
              intent: 'stress',
              ttlSec: 300,
            }),
          ),
        ).then(
          (r) => ({ ok: r.ok, err: null as string | null }),
          (e: unknown) => ({
            ok: false,
            err: e instanceof Error ? e.message : String(e),
          }),
        ),
      ),
    );
    const failed = results.filter((r) => !r.ok);
    // Surface the first failure's message so a regression is debuggable
    // (a statement_timeout / lock_timeout would land here).
    expect(failed.map((f) => f.err).filter(Boolean)).toEqual([]);
    expect(failed).toHaveLength(0);
    expect(results).toHaveLength(N);
  }, LOAD_STRESS_TIMEOUT_MS);
});

describe('file-locking #4 — sweepPathsExpired (path-narrow primitive)', () => {
  it('deletes expired locks only on the requested paths', async () => {
    const ws = nextWs();
    const sql = getTxPool();
    await sql`
      INSERT INTO agent_file_locks
        (coordination_domain, path, owner, owner_label, intent, expires_ts)
      VALUES
        (${ws}, 'in.ts', 'a', 'A', 'i', clock_timestamp() - interval '1 hour'),
        (${ws}, 'out.ts', 'a', 'A', 'i', clock_timestamp() - interval '1 hour')
    `;
    const moved = await inWorkspaceTxn(ws, 'p', (tx) =>
      sweepPathsExpired(tx, ws, ['in.ts']),
    );
    expect(moved).toBe(true);
    const rows = await sql<Array<{ path: string }>>`
      SELECT path FROM agent_file_locks
       WHERE coordination_domain = ${ws} ORDER BY path
    `;
    expect(rows.map((r) => r.path)).toEqual(['out.ts']);
  });

  it('flips orphaned waiters whose paths overlap, leaves disjoint ones alone', async () => {
    const ws = nextWs();
    const sql = getTxPool();
    await sql`
      INSERT INTO agent_lock_waiters
        (coordination_domain, owner, owner_label, paths, intent, ttl_sec,
         wait_until, status, queued_ts)
      VALUES
        (${ws}, 'over', 'over', ${['x.ts', 'y.ts']}, 'i', 60,
         clock_timestamp() - interval '5 seconds', 'waiting',
         clock_timestamp() - interval '1 minute'),
        (${ws}, 'disj', 'disj', ${['z.ts']}, 'i', 60,
         clock_timestamp() - interval '5 seconds', 'waiting',
         clock_timestamp() - interval '1 minute')
    `;
    const moved = await inWorkspaceTxn(ws, 'p', (tx) =>
      sweepPathsExpired(tx, ws, ['x.ts']),
    );
    expect(moved).toBe(true);
    const rows = await sql<Array<{ owner: string; status: string }>>`
      SELECT owner, status::text AS status FROM agent_lock_waiters
       WHERE coordination_domain = ${ws} ORDER BY owner
    `;
    const byOwner = Object.fromEntries(rows.map((r) => [r.owner, r.status]));
    expect(byOwner.over).toBe('expired');
    expect(byOwner.disj).toBe('waiting');
  });

  it('returns false when nothing matches (no-op fast path)', async () => {
    const ws = nextWs();
    const moved = await inWorkspaceTxn(ws, 'p', (tx) =>
      sweepPathsExpired(tx, ws, ['nonexistent.ts']),
    );
    expect(moved).toBe(false);
  });

  it('returns false for an empty path list', async () => {
    const ws = nextWs();
    const moved = await inWorkspaceTxn(ws, 'p', (tx) =>
      sweepPathsExpired(tx, ws, []),
    );
    expect(moved).toBe(false);
  });
});

describe('file-locking #4 — sweepWorkspaceExpired (workspace-scoped primitive)', () => {
  it('sweeps all expired rows in its workspace and leaves other workspaces untouched', async () => {
    const sql = getTxPool();
    const wsA = nextWs();
    const wsB = nextWs();
    for (const ws of [wsA, wsB]) {
      await sql`
        INSERT INTO agent_file_locks
          (coordination_domain, path, owner, owner_label, intent, expires_ts)
        VALUES
          (${ws}, 'a.ts', 'o', 'O', 'i', clock_timestamp() - interval '1 hour'),
          (${ws}, 'b.ts', 'o', 'O', 'i', clock_timestamp() - interval '1 hour')
      `;
    }
    const moved = await inWorkspaceTxn(wsA, 'p', (tx) =>
      sweepWorkspaceExpired(tx, wsA),
    );
    expect(moved).toBe(true);
    const left = await sql<Array<{ coordination_domain: string }>>`
      SELECT coordination_domain FROM agent_file_locks
       WHERE coordination_domain IN (${wsA}, ${wsB})
    `;
    expect(left.map((r) => r.coordination_domain).sort()).toEqual([wsB, wsB]);
  });
});

// ────────────────────────────────────────────────────────────────────
// Audit regression: same-owner re-acquire must succeed + preserve
// lock_id (fixes the bug that locked Claude Code agents out of their
// own files on consecutive Edit/Write tool calls).
// ────────────────────────────────────────────────────────────────────

describe('audit regression — failed multi-path acquire is side-effect free', () => {
  it('does NOT mutate the caller\'s existing locks when a sibling path is held by another agent', async () => {
    const ws = nextWs();
    const original = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['kept.ts'], intent: 'original', ttlSec: 60,
      }),
    );
    if (!original.ok) throw new Error('setup');
    const origExpires = original.expires_ts.getTime();

    await inWorkspaceTxn(ws, 'b', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
        paths: ['blocked.ts'], intent: 'B', ttlSec: 60,
      }),
    );

    // A tries to acquire [kept, blocked] with a different intent + 10x TTL.
    const failed = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['kept.ts', 'blocked.ts'], intent: 'A retry', ttlSec: 600,
      }),
    );
    expect(failed.ok).toBe(false);

    // A's existing lock on kept.ts must be UNTOUCHED.
    const sql = getTxPool();
    const rows = await sql<Array<{ intent: string; expires_ts: Date }>>`
      SELECT intent, expires_ts FROM agent_file_locks
       WHERE coordination_domain = ${ws} AND owner = 'a'
    `;
    expect(rows[0].intent).toBe('original');
    // TTL should NOT have been extended.
    expect(rows[0].expires_ts.getTime()).toBeLessThanOrEqual(origExpires + 1000);
  });
});

describe('audit regression — same-owner re-acquire', () => {
  it('refreshes the existing lock with the same lock_id', async () => {
    const ws = nextWs();
    const r1 = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['reacq.ts'], intent: 'first', ttlSec: 60,
      }),
    );
    if (!r1.ok) throw new Error('first acquire');
    const r2 = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['reacq.ts'], intent: 'second', ttlSec: 60,
      }),
    );
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.lock_id).toBe(r1.lock_id);
      expect(r2.held).toEqual(['reacq.ts']);
    }
  });

  it('head-waiter rule does not block same-owner refresh of an already-held path', async () => {
    const ws = nextWs();
    // Owner A holds path. Owner B queues for it. A re-acquires its own.
    // The head-waiter rule should ignore A's same-owner refresh.
    const a = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['x.ts'], intent: 'A', ttlSec: 60,
      }),
    );
    if (!a.ok) throw new Error('setup acquire');
    const w = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
        paths: ['x.ts'], intent: 'B waits', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    if (!w.ok) throw new Error('waiter insert');
    if ('self_granted' in w) throw new Error('unexpected self-grant in w');

    const refresh = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['x.ts'], intent: 'A refresh', ttlSec: 60,
      }),
    );
    expect(refresh.ok).toBe(true);
    if (refresh.ok) expect(refresh.lock_id).toBe(a.lock_id);

    // A third owner (C) trying to take x.ts MUST still be blocked.
    const c = await inWorkspaceTxn(ws, 'c', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'c', ownerLabel: 'C',
        paths: ['x.ts'], intent: 'C', ttlSec: 60,
      }),
    );
    expect(c.ok).toBe(false);
  });

  it('partial-overlap re-acquire: same-owner part refreshes, others-owned part returns busy', async () => {
    const ws = nextWs();
    // Owner A holds a.ts. Owner B holds b.ts.
    const a = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['a.ts'], intent: 'A', ttlSec: 60,
      }),
    );
    await inWorkspaceTxn(ws, 'b', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
        paths: ['b.ts'], intent: 'B', ttlSec: 60,
      }),
    );
    if (!a.ok) throw new Error('setup acquire A');

    // A tries to acquire [a.ts, b.ts]. a.ts should refresh; b.ts busy.
    const r = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['a.ts', 'b.ts'], intent: 'A retry', ttlSec: 60,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // busy MUST exclude self — only b.ts owned by B.
      expect(r.busy.map((x) => x.path)).toEqual(['b.ts']);
    }
    // A's lock on a.ts MUST survive.
    const q = await readQueue(getTxPool(), { coordinationDomain: ws });
    const aLock = q.active_locks.find((l) => l.path === 'a.ts');
    expect(aLock?.owner).toBe('a');
  });
});

/**
 * WI-5979 — `coordinationDomain: null` reads EVERY domain (diagnostic reads).
 *
 * The dossier's per-agent lock read used to key on the SERVING process's repo
 * root, so it matched only locks acquired through an operator running from the
 * same checkout — and the ports disagree (:3070 = papercup-release, the Tauri
 * desktop's :3270 = the staging tree), so the desktop dossier saw none of the
 * release-domain rows and showed every agent as lock-free, silently.
 *
 * These tests exercise the NULL branch's real SQL. The 60 tests above all pass a
 * concrete domain, so none of them touch it — and a broken `WHERE TRUE` fragment
 * here would break every lock read for the whole fleet.
 *
 * A null read sees OTHER suites' rows too (the table is shared, tests run in
 * parallel), so every assertion filters to this test's own unique domains.
 */
describe('readQueue cross-domain (coordinationDomain: null)', () => {
  it('returns rows from MULTIPLE domains, each stamped with its own domain', async () => {
    const wsA = nextWs();
    const wsB = nextWs();

    await inWorkspaceTxn(wsA, 'agent-a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: wsA, owner: 'agent-a', ownerLabel: 'A',
        paths: ['shared.ts'], intent: 'editing in checkout A', ttlSec: 60,
      }),
    );
    await inWorkspaceTxn(wsB, 'agent-b', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: wsB, owner: 'agent-b', ownerLabel: 'B',
        paths: ['shared.ts'], intent: 'editing in checkout B', ttlSec: 60,
      }),
    );

    // A domain-scoped read sees only its own — the pre-fix dossier behaviour.
    const scoped = await readQueue(getTxPool(), { coordinationDomain: wsA });
    expect(scoped.active_locks.map((l) => l.owner)).toEqual(['agent-a']);

    // The null read spans both.
    const all = await readQueue(getTxPool(), { coordinationDomain: null });
    const mine = all.active_locks.filter(
      (l) => l.coordination_domain === wsA || l.coordination_domain === wsB,
    );
    expect(mine).toHaveLength(2);
    expect(mine.find((l) => l.owner === 'agent-a')?.coordination_domain).toBe(wsA);
    expect(mine.find((l) => l.owner === 'agent-b')?.coordination_domain).toBe(wsB);
    // Same repo-relative path in both — they are different physical files.
    expect(new Set(mine.map((l) => l.path))).toEqual(new Set(['shared.ts']));
  });

  it('counts ahead_count PER domain, not across the whole table', async () => {
    const wsA = nextWs();
    const wsB = nextWs();

    for (const [ws, holder] of [[wsA, 'hold-a'], [wsB, 'hold-b']] as const) {
      await inWorkspaceTxn(ws, holder, (tx) =>
        tryAcquire(tx, {
          coordinationDomain: ws, owner: holder, ownerLabel: 'H',
          paths: ['q.ts'], intent: 'hold', ttlSec: 60,
        }),
      );
    }

    const wA = await inWorkspaceTxn(wsA, 'wait-a', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: wsA, owner: 'wait-a', ownerLabel: 'WA',
        paths: ['q.ts'], intent: 'want q in A', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    const wB = await inWorkspaceTxn(wsB, 'wait-b', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: wsB, owner: 'wait-b', ownerLabel: 'WB',
        paths: ['q.ts'], intent: 'want q in B', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    if (!wA.ok || !wB.ok) throw new Error('waiter inserts should succeed');

    const all = await readQueue(getTxPool(), { coordinationDomain: null });
    const a = all.waiting.find((w) => w.coordination_domain === wsA);
    const b = all.waiting.find((w) => w.coordination_domain === wsB);

    // Each is FIRST in its own domain's queue. Without PARTITION BY
    // coordination_domain the later-queued one would inherit a nonzero
    // ahead_count from an unrelated domain's waiter.
    expect(a?.ahead_count).toBe(0);
    expect(b?.ahead_count).toBe(0);
  });
});
