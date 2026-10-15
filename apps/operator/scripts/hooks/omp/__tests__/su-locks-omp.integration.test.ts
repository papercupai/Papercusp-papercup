/**
 * su-locks-omp — two-agent OMP hook coordination test.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-029.
 * Migrated from apps/operator/scripts/su-locks-omp-smoke.ts.
 *
 * Verifies file-locking-improvements §14 system-level acceptance #1:
 *   - Two OMP agents targeting the same file; second is HARD-BLOCKED
 *   - Symlink aliasing sidestep is closed
 *   - Release frees the file
 *
 * No live operator required: tests the store + hook directly.
 * Skipped when embedded PG is not reachable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pgAvailable = false;
try {
  const { getTxPool } = await import('@papercusp/operator-core/lib/agent-tools/locks/su-lock-store');
  const sql = getTxPool();
  await sql`SELECT 1`;
  pgAvailable = true;
} catch { /* embedded PG not up */ }

// hookOwnerId() prefers the ambient PAPERCUSP_SID (a real psu-launch session id)
// over PAPERCUSP_AUTH_SESSION_ID — see coord-hook.ts. This suite simulates the
// bare/non-psu omp launch path (two distinct synthetic sessions), which only
// exercises the PAPERCUSP_AUTH_SESSION_ID branch when PAPERCUSP_SID is absent.
// Every su/psu-launched shell (including this fleet's) sets PAPERCUSP_SID
// globally, so without clearing it here both "sessions" collapse onto the
// SAME ambient owner and the suite spuriously fails outside a bare CI env.
const savedPapercuspSid = process.env.PAPERCUSP_SID;

const itLive = pgAvailable ? it : it.skip;

describe('su-locks OMP two-agent coordination', () => {
  let wsRoot: string;
  let repoRoot: string;
  let wsId: string;
  let ownerA: string;
  let ownerB: string;
  let lockIdA: string;
  let store: typeof import('@papercusp/operator-core/lib/agent-tools/locks/su-lock-store');
  let inWorkspaceTxn: typeof import('@papercusp/operator-core/lib/agent-tools/locks/in-workspace-txn')['inWorkspaceTxn'];
  let hook: typeof import('../coord-hook');

  beforeAll(async () => {
    if (!pgAvailable) return;

    store = await import('@papercusp/operator-core/lib/agent-tools/locks/su-lock-store');
    const txn = await import('@papercusp/operator-core/lib/agent-tools/locks/in-workspace-txn');
    inWorkspaceTxn = txn.inWorkspaceTxn;
    hook = await import('../coord-hook');

    // A papercusp-style workspace with one `.git` worktree: the hook keys
    // locks by walking up to `.git`, gated on the worktree being a direct
    // child of PAPERCUSP_WORKSPACE_ROOT (mirrors the cc hook). Named
    // "papercusp" (not the pre-D-007 "papercup") so it resolves as the
    // canonical staging tree under the worktree guard (coord-hook.ts) —
    // otherwise every onToolCall in this suite is refused before it even
    // reaches the symlink/lock logic.
    wsRoot = await realpath(await mkdtemp(join(tmpdir(), 'omp-smoke-ws-')));
    repoRoot = join(wsRoot, 'papercusp');
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    // validGitEntry() only recognizes a `.git` DIRECTORY that holds HEAD (an empty
    // `.git` must not change lock scope), so the fixture needs a real HEAD (WI-10004763).
    await writeFile(join(repoRoot, '.git', 'HEAD'), 'ref: refs/heads/staging\n');
    await mkdir(join(repoRoot, 'apps'), { recursive: true });
    await writeFile(join(repoRoot, 'apps', 'target.ts'), '// smoke\n');
    process.env.PAPERCUSP_WORKSPACE_ROOT = wsRoot;
    delete process.env.PAPERCUSP_BUNDLE_URL;
    delete process.env.PAPERCUSP_OPERATOR_URL;
    delete process.env.PAPERCUSP_SID;

    wsId = `omp-smoke-ws-${Date.now()}`;
    await store.ensureBootstrap();

    function ompOwner(sessionId: string): string {
      process.env.PAPERCUSP_AUTH_SESSION_ID = sessionId;
      store._resetForTests?.();
      hook._resetHookOwnerIdForTests?.();
      return hook.hookOwnerId();
    }
    ownerA = ompOwner('pus-omp-smoke-A');
    ownerB = ompOwner('pus-omp-smoke-B');
  });

  afterAll(async () => {
    if (!pgAvailable) return;
    if (wsRoot) await rm(wsRoot, { recursive: true, force: true }).catch(() => {});
    await store?._resetForTests?.().catch(() => {});
    if (savedPapercuspSid === undefined) delete process.env.PAPERCUSP_SID;
    else process.env.PAPERCUSP_SID = savedPapercuspSid;
    hook?._resetHookOwnerIdForTests?.();
  });

  itLive('two sessions produce distinct omp-prefixed owners', () => {
    expect(ownerA).not.toBe(ownerB);
    expect(ownerA).toMatch(/^omp-/);
    expect(ownerB).toMatch(/^omp-/);
  });

  itLive('hook extracts repo-relative claim path from write tool_call', () => {
    const writeInput = { path: join(repoRoot, 'apps', 'target.ts'), content: 'x' };
    const paths = hook.extractPathsFromToolInput('write', writeInput);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe('apps/target.ts');
  });

  itLive('agent A acquires apps/target.ts', async () => {
    const result = await inWorkspaceTxn(wsId, ownerA, (tx) =>
      store.tryAcquire(tx, {
        coordinationDomain: wsId,
        owner: ownerA,
        ownerLabel: 'omp:A',
        paths: store.normalizePaths(['apps/target.ts']),
        intent: 'omp smoke: agent A edits target.ts',
        ttlSec: 60,
      }),
    );
    expect(result.ok).toBe(true);
    lockIdA = (result as any).lock_id;
  });

  itLive('agent B is hard-blocked — busy entry names agent A', async () => {
    const result = await inWorkspaceTxn(wsId, ownerB, (tx) =>
      store.tryAcquire(tx, {
        coordinationDomain: wsId,
        owner: ownerB,
        ownerLabel: 'omp:B',
        paths: store.normalizePaths(['apps/target.ts']),
        intent: 'omp smoke: agent B wants target.ts',
        ttlSec: 60,
      }),
    );
    expect(result.ok).toBe(false);
    const holder = (result as any).busy?.find((e: any) => e.path === 'apps/target.ts');
    expect(holder).toBeDefined();
    expect(holder.owner).toBe(ownerA);
  });

  itLive('locks:queue shows the lock attributed to agent A', async () => {
    const sql = store.getTxPool();
    const q = await store.readQueue(sql, { coordinationDomain: wsId });
    const active = q.active_locks.find((l: any) => l.path === 'apps/target.ts');
    expect(active).toBeDefined();
    expect(active!.owner).toBe(ownerA);
  });

  itLive('hook detects symlink alias pointing at locked file', async () => {
    await symlink(join(repoRoot, 'apps', 'target.ts'), join(repoRoot, 'apps', 'alias.ts'));
    const hits = hook.detectSymlinkedPaths(['apps/alias.ts'], repoRoot);
    expect(hits).toHaveLength(1);
    expect((hits[0] as any).real).toBe('apps/target.ts');
  });

  itLive('onToolCall hard-blocks the symlinked edit', async () => {
    const result = await hook.onToolCall({
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'omp-smoke-symlink',
      input: { path: join(repoRoot, 'apps', 'alias.ts'), content: 'x' },
    });
    expect((result as any).block).toBe(true);
    expect((result as any).reason).toMatch(/symlink/i);
  });

  itLive('agent A releases — queue empties', async () => {
    const sql = store.getTxPool();
    const rel = await inWorkspaceTxn(wsId, ownerA, (tx) =>
      store.tryRelease(tx, { coordinationDomain: wsId, owner: ownerA, lockId: lockIdA }),
    );
    expect((rel as any).released).toHaveLength(1);
    const q2 = await store.readQueue(sql, { coordinationDomain: wsId });
    const remaining = q2.active_locks.filter((l: any) => l.path === 'apps/target.ts');
    expect(remaining).toHaveLength(0);
  });
});
