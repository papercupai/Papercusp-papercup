/**
 * desktop-session-registry — REAL-PG behaviour guard
 * (agent-virtual-desktops-2026-08-23 P-003 / WI-40829; D-004, D-005, D-006).
 *
 * WHY REAL PG. The registry's contract is mostly about what Postgres REFUSES and
 * what a partial index treats as live. A mocked client proves the module emitted
 * SQL; it cannot prove the database rejected a second live lease, and that
 * rejection IS the safety property D-005 asks the database to own.
 *
 * THE ASSERTION THAT EARNS ITS PLACE MOST is the reconciliation quartet. D-004's
 * invariant — "a row without a live handle in its owning process is DEAD" — is
 * easy to implement as an over-eager sweep that also reaps a SIBLING operator
 * process's live desktops. So the reap tests are paired with two NEGATIVE
 * controls (different pid, remote host_ref). A one-sided test passes just as
 * happily against a sweep that reaps everything, which would tear down working
 * desktops fleet-wide.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createFreshPgDb, applyMigrationForTest, type FreshPgDb } from '../../test/_pg-helpers';
// Registry mutations enqueue a UI invalidation. This suite uses a throwaway PG
// schema, so keep that detached signal from opening the protected live org DB.
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
import {
  registerDesktopSession,
  markDesktopReady,
  touchDesktopSession,
  closeDesktopSession,
  listDesktopSessions,
  resolveDesktopForScope,
  resolveLocalDesktopByDisplay,
  setDesktopViewer,
  reconcileLocalDesktopSessions,
  renewDesktopLease,
  setDesktopTaskId,
  markDesktopIdle,
  markDesktopFrozen,
  markDesktopThawed,
  listGovernableDesktopSessions,
  listReservedLocalDesktopDisplays,
  guestDisplayBackendError,
  DEFAULT_CAPTURE_GEOMETRY,
  TERMINAL_DESKTOP_STATES,
  isTerminalDesktopState,
} from './desktop-session-registry';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../libs/papercusp/libs/db/sql');
const MIGRATION_900 = join(SQL_DIR, '900-desktop-sessions-registry.sql');
/** P-005's lifecycle columns. Applied in order after 900, exactly as the runner
 *  would — a hand-rolled CREATE TABLE here would silently fall behind the real
 *  schema the first time either migration changes. */
const MIGRATION_905 = join(SQL_DIR, '905-desktop-session-lifecycle.sql');
/** agent-multi-desktops-grid P-002: the `name` column registerDesktopSession now writes. */
const MIGRATION_1386 = join(SQL_DIR, '1386-desktop-session-name.sql');

const WS = 'ws-registry-test';
let db: FreshPgDb | undefined;
let sql: FreshPgDb['sql'];

// Monotonic, never random. A random display number collides across tests often
// enough to look like a real uniqueness bug (it did), and a fixture that flakes
// against the very constraint under test is worse than no fixture at all.
let seq = 0;
const nextSeq = () => ++seq;

const base = (over: Partial<Parameters<typeof registerDesktopSession>[0]> = {}) => {
  const n = nextSeq();
  return {
    workspaceId: WS,
    harnessSlug: 'papercusp',
    kind: 'xvfb-local' as const,
    scope: 'pot' as const,
    scopeRef: `pot-seq-${n}`,
    display: `:${1000 + n}`,
    displayGeometry: { width: 1920, height: 1080 },
    ...over,
  };
};

beforeAll(async () => {
  db = await createFreshPgDb('desktopregistry');
  sql = db.sql;
  await applyMigrationForTest(sql, MIGRATION_900);
  await applyMigrationForTest(sql, MIGRATION_905);
  await applyMigrationForTest(sql, MIGRATION_1386);
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('registration + the D-006 geometry split', () => {
  it('registers as provisioning, never ready — a session nothing has proven works is not publishable', async () => {
    const s = await registerDesktopSession(base({ scopeRef: 'pot-reg' }), sql);
    expect(s.state).toBe('provisioning');
    expect(s.releasedAt).toBeNull();
  });

  it('defaults capture geometry to 1024x768 even when the DISPLAY runs at 1920x1080', async () => {
    const s = await registerDesktopSession(
      base({ scopeRef: 'pot-geo', displayGeometry: { width: 1920, height: 1080 } }),
      sql,
    );
    expect(s.displayGeometry).toEqual({ width: 1920, height: 1080, depth: 24 });
    expect(s.captureGeometry).toEqual({ ...DEFAULT_CAPTURE_GEOMETRY });
    // The whole point of D-006: the two are INDEPENDENT. A single-geometry
    // implementation passes an assertion on either one alone.
    expect(s.captureGeometry).not.toEqual({ width: s.displayGeometry.width, height: s.displayGeometry.height });
  });

  it('honours a deliberately larger capture geometry (it is a lease parameter, not a constant)', async () => {
    const s = await registerDesktopSession(
      base({ scopeRef: 'pot-bigcap', captureGeometry: { width: 1440, height: 900 } }),
      sql,
    );
    expect(s.captureGeometry).toEqual({ width: 1440, height: 900 });
  });

  it('stamps MEASURED capabilities on ready, not on register', async () => {
    const s = await registerDesktopSession(base({ scopeRef: 'pot-caps' }), sql);
    expect(s.capabilities).toEqual({});
    const ready = await markDesktopReady(s.id, { capabilities: { gl: true, kvm: false } }, sql);
    expect(ready?.state).toBe('ready');
    expect(ready?.capabilities).toEqual({ gl: true, kvm: false });
  });

  it('surfaces the DB uniqueness as a throw rather than silently double-leasing a scope', async () => {
    await registerDesktopSession(base({ scopeRef: 'pot-uniq', display: ':310' }), sql);
    await expect(
      registerDesktopSession(base({ scopeRef: 'pot-uniq', display: ':311' }), sql),
    ).rejects.toThrow();
  });
});

describe('resolution + enumeration', () => {
  it('resolves the live session for a scope and stops resolving it once closed', async () => {
    const s = await registerDesktopSession(base({ scopeRef: 'pot-resolve', display: ':320' }), sql);
    await markDesktopReady(s.id, {}, sql);

    const found = await resolveDesktopForScope({ workspaceId: WS, scope: 'pot', scopeRef: 'pot-resolve' }, sql);
    expect(found?.id).toBe(s.id);

    await closeDesktopSession(s.id, 'released', sql);
    const gone = await resolveDesktopForScope({ workspaceId: WS, scope: 'pot', scopeRef: 'pot-resolve' }, sql);
    expect(gone).toBeUndefined();
  });

  it('enumerates EVERY kind — the whole reason the registry exists', async () => {
    const ws = 'ws-kinds';
    for (const kind of ['xvfb-local', 'frame-slot', 'vm-guest', 'bwrap', 'microvm'] as const) {
      await registerDesktopSession(
        base({
          workspaceId: ws,
          kind,
          scopeRef: `sc-${kind}`,
          // P-005: guest kinds must declare a boot-time display backend
          // (EI-20504354859682877). Kept as a conditional rather than applied to
          // every kind, so this fixture keeps exercising the un-decorated path
          // for the kinds the constraint does not govern.
          ...(kind === 'vm-guest' || kind === 'microvm'
            ? { capabilities: { displayBackend: 'vnc' as const } }
            : {}),
        }),
        sql,
      );
    }
    const listed = await listDesktopSessions({ workspaceId: ws }, sql);
    expect(new Set(listed.map((s) => s.kind))).toEqual(
      new Set(['xvfb-local', 'frame-slot', 'vm-guest', 'bwrap', 'microvm']),
    );
  });

  it('excludes terminal rows by default and includes them on request', async () => {
    const ws = 'ws-terminal-filter';
    const a = await registerDesktopSession(base({ workspaceId: ws, scopeRef: 'sc-a' }), sql);
    await registerDesktopSession(base({ workspaceId: ws, scopeRef: 'sc-b' }), sql);
    await closeDesktopSession(a.id, 'released', sql);

    expect(await listDesktopSessions({ workspaceId: ws }, sql)).toHaveLength(1);
    expect(await listDesktopSessions({ workspaceId: ws, includeTerminal: true }, sql)).toHaveLength(2);
  });

  it('scopes enumeration per tenant', async () => {
    await registerDesktopSession(base({ workspaceId: 'ws-t1', scopeRef: 'shared-ref' }), sql);
    await registerDesktopSession(base({ workspaceId: 'ws-t2', scopeRef: 'shared-ref' }), sql);
    const t1 = await listDesktopSessions({ workspaceId: 'ws-t1' }, sql);
    expect(t1).toHaveLength(1);
    expect(t1[0].workspaceId).toBe('ws-t1');
  });

  it('D-005: the workspace scope is representable and does not collide with an agent scope', async () => {
    const ws = 'ws-scopes';
    await registerDesktopSession(base({ workspaceId: ws, scope: 'workspace', scopeRef: 'byoc' }), sql);
    await registerDesktopSession(base({ workspaceId: ws, scope: 'agent', scopeRef: 'byoc' }), sql);
    expect(await listDesktopSessions({ workspaceId: ws, scope: 'workspace' }, sql)).toHaveLength(1);
    expect(await listDesktopSessions({ workspaceId: ws, scope: 'agent' }, sql)).toHaveLength(1);
  });
});

describe('local display allocation reservations', () => {
  it('includes live sibling and cross-workspace local leases, but ignores remote and terminal rows', async () => {
    // A different pid on this boot may be a live sibling operator lease. The
    // allocator reads it as occupied and leaves its lifecycle entirely untouched.
    await registerDesktopSession(base({
      workspaceId: WS,
      scopeRef: 'sibling-local-lease',
      display: ':980',
      ownerPid: 987654,
    }), sql);
    await registerDesktopSession(base({
      workspaceId: 'ws-another-tenant',
      scopeRef: 'cross-workspace-local-lease',
      display: ':981',
      ownerPid: 876543,
    }), sql);
    await registerDesktopSession(base({
      workspaceId: WS,
      scopeRef: 'remote-lease',
      display: ':982',
      hostRef: 'frame-reservation-test',
    }), sql);
    const terminal = await registerDesktopSession(base({
      workspaceId: WS,
      scopeRef: 'terminal-lease',
      display: ':983',
    }), sql);
    await closeDesktopSession(terminal.id, 'released', sql);

    const displays = await listReservedLocalDesktopDisplays(sql);
    expect(displays).toContain(':980');
    expect(displays).toContain(':981');
    expect(displays).not.toContain(':982');
    expect(displays).not.toContain(':983');
    const sibling = await listDesktopSessions({
      workspaceId: WS,
      scope: 'pot',
      scopeRef: 'sibling-local-lease',
    }, sql);
    expect(sibling).toHaveLength(1);
    expect(sibling[0].ownerPid).toBe(987654);
    expect(sibling[0].state).toBe('provisioning');
  });
});

describe('lifecycle', () => {
  it('close is idempotent — a teardown race must not throw', async () => {
    const s = await registerDesktopSession(base({ scopeRef: 'pot-idem', display: ':330' }), sql);
    expect(await closeDesktopSession(s.id, 'released', sql)).toBe(true);
    expect(await closeDesktopSession(s.id, 'released', sql)).toBe(false);
  });

  it('does not resurrect a terminal session via markDesktopReady', async () => {
    const s = await registerDesktopSession(base({ scopeRef: 'pot-zombie', display: ':331' }), sql);
    await closeDesktopSession(s.id, 'dead', sql);
    expect(await markDesktopReady(s.id, {}, sql)).toBeUndefined();
  });

  it('advances last_active_at on touch', async () => {
    const s = await registerDesktopSession(base({ scopeRef: 'pot-touch', display: ':332' }), sql);
    await new Promise((r) => setTimeout(r, 15));
    await touchDesktopSession(s.id, sql);
    const [row] = await listDesktopSessions({ workspaceId: WS }, sql).then((rows) =>
      rows.filter((r) => r.id === s.id),
    );
    expect(row.lastActiveAt.getTime()).toBeGreaterThan(row.createdAt.getTime());
  });

  it('releasing a scope frees it for re-lease', async () => {
    const first = await registerDesktopSession(base({ scopeRef: 'pot-relet2', display: ':333' }), sql);
    await closeDesktopSession(first.id, 'released', sql);
    await expect(
      registerDesktopSession(base({ scopeRef: 'pot-relet2', display: ':334' }), sql),
    ).resolves.toBeDefined();
  });
});

describe('reconciliation (D-004: a row without a live handle is DEAD)', () => {
  const BOOT = 'boot-current';

  it('reaps a row from a PREVIOUS boot — the machine rebooted, so its X servers are gone', async () => {
    const ws = 'ws-recon-boot';
    const s = await registerDesktopSession(
      base({ workspaceId: ws, scopeRef: 'sc-oldboot', ownerBootId: 'boot-previous', ownerPid: 999 }),
      sql,
    );
    const out = await reconcileLocalDesktopSessions({ workspaceId: ws, liveIds: [], bootId: BOOT, pid: 1234 }, sql);
    expect(out.reapedIds).toContain(s.id);
  });

  it('reaps THIS process’s row when no live handle backs it', async () => {
    const ws = 'ws-recon-mine';
    const s = await registerDesktopSession(
      base({ workspaceId: ws, scopeRef: 'sc-mine', ownerBootId: BOOT, ownerPid: 1234 }),
      sql,
    );
    const out = await reconcileLocalDesktopSessions({ workspaceId: ws, liveIds: [], bootId: BOOT, pid: 1234 }, sql);
    expect(out.reapedIds).toContain(s.id);
  });

  it('KEEPS this process’s row when a live handle IS held', async () => {
    const ws = 'ws-recon-live';
    const s = await registerDesktopSession(
      base({ workspaceId: ws, scopeRef: 'sc-live', ownerBootId: BOOT, ownerPid: 1234 }),
      sql,
    );
    const out = await reconcileLocalDesktopSessions(
      { workspaceId: ws, liveIds: [s.id], bootId: BOOT, pid: 1234 },
      sql,
    );
    expect(out.reapedIds).not.toContain(s.id);
  });

  // NEGATIVE CONTROL 1. Without this, an over-eager sweep that reaps every local
  // row passes every assertion above — and tears down a live sibling operator's
  // desktops in production.
  it('does NOT reap a SIBLING process’s row on the same boot', async () => {
    const ws = 'ws-recon-sibling';
    const s = await registerDesktopSession(
      base({ workspaceId: ws, scopeRef: 'sc-sibling', ownerBootId: BOOT, ownerPid: 4321 }),
      sql,
    );
    const out = await reconcileLocalDesktopSessions({ workspaceId: ws, liveIds: [], bootId: BOOT, pid: 1234 }, sql);
    expect(out.reapedIds).not.toContain(s.id);
  });

  // NEGATIVE CONTROL 2. A remote-owned session is its owner's to reconcile.
  it('does NOT reap a REMOTE (host_ref set) row', async () => {
    const ws = 'ws-recon-remote';
    const s = await registerDesktopSession(
      base({
        workspaceId: ws,
        scopeRef: 'sc-remote',
        kind: 'frame-slot',
        hostRef: 'frame-7',
        ownerBootId: 'boot-elsewhere',
        ownerPid: 5,
      }),
      sql,
    );
    const out = await reconcileLocalDesktopSessions({ workspaceId: ws, liveIds: [], bootId: BOOT, pid: 1234 }, sql);
    expect(out.reapedIds).not.toContain(s.id);
  });

  // WI-10002797: on a workspace host the only other pid that ever registered a
  // desktop is a previous incarnation of the operator, whose desktop died with its
  // socket. Left `ready`, that row blocks the next lease on both unique indexes.
  it('as SOLE OWNER reaps a previous incarnation’s row on the same boot, so the scope and display can be leased again', async () => {
    const ws = 'ws-recon-sole';
    const stale = await registerDesktopSession(
      base({ workspaceId: ws, scopeRef: 'sc-sole', display: ':610', ownerBootId: BOOT, ownerPid: 4321 }),
      sql,
    );
    await expect(
      registerDesktopSession(base({ workspaceId: ws, scopeRef: 'sc-sole', display: ':610', ownerBootId: BOOT, ownerPid: 1234 }), sql),
    ).rejects.toThrow();

    const out = await reconcileLocalDesktopSessions(
      { workspaceId: ws, liveIds: [], bootId: BOOT, pid: 1234, soleOwner: true },
      sql,
    );
    // toContain, not toEqual: a sole owner sweeps every unvouched local row in this
    // shared schema, including other tests' leftovers (see the D-439 case below).
    expect(out.reapedIds).toContain(stale.id);
    await expect(
      registerDesktopSession(base({ workspaceId: ws, scopeRef: 'sc-sole', display: ':610', ownerBootId: BOOT, ownerPid: 1234 }), sql),
    ).resolves.toBeDefined();
  });

  // D-439: the live-display index has no workspace column, so residue stamped with the
  // workspace id an earlier release used still holds the display. Measured shape on
  // avi-test: desktop.start stayed desktop_unavailable across a full reboot.
  it('as SOLE OWNER reaps residue stamped with a DIFFERENT workspace id that still holds the display', async () => {
    const residue = await registerDesktopSession(
      base({ workspaceId: 'ws-recon-earlier-release', scopeRef: 'sc-residue', display: ':611', ownerBootId: 'boot-previous', ownerPid: 77 }),
      sql,
    );
    const ws = 'ws-recon-sole-cross';
    await expect(
      registerDesktopSession(base({ workspaceId: ws, scopeRef: 'sc-cross', display: ':611', ownerBootId: BOOT, ownerPid: 1234 }), sql),
    ).rejects.toThrow();

    const out = await reconcileLocalDesktopSessions(
      { workspaceId: ws, liveIds: [], bootId: BOOT, pid: 1234, soleOwner: true },
      sql,
    );
    expect(out.reapedIds).toContain(residue.id);
    await expect(
      registerDesktopSession(base({ workspaceId: ws, scopeRef: 'sc-cross', display: ':611', ownerBootId: BOOT, ownerPid: 1234 }), sql),
    ).resolves.toBeDefined();
  });

  // NEGATIVE CONTROL 3. Without sole ownership the sweep stays per-workspace: on a
  // shared machine another workspace's rows are not this process's to judge.
  it('without SOLE OWNER never reaps a row stamped with a different workspace id', async () => {
    const foreign = await registerDesktopSession(
      base({ workspaceId: 'ws-recon-foreign', scopeRef: 'sc-foreign', ownerBootId: 'boot-previous', ownerPid: 77 }),
      sql,
    );
    const out = await reconcileLocalDesktopSessions(
      { workspaceId: 'ws-recon-not-sole', liveIds: [], bootId: BOOT, pid: 1234 },
      sql,
    );
    expect(out.reapedIds).not.toContain(foreign.id);
  });

  it('as SOLE OWNER still keeps a row it holds a live handle for, and never touches a remote row', async () => {
    const ws = 'ws-recon-sole-keep';
    const held = await registerDesktopSession(
      base({ workspaceId: ws, scopeRef: 'sc-sole-held', ownerBootId: BOOT, ownerPid: 1234 }),
      sql,
    );
    const remote = await registerDesktopSession(
      base({ workspaceId: ws, scopeRef: 'sc-sole-remote', kind: 'frame-slot', hostRef: 'frame-9', ownerBootId: BOOT, ownerPid: 4321 }),
      sql,
    );
    const out = await reconcileLocalDesktopSessions(
      { workspaceId: ws, liveIds: [held.id], bootId: BOOT, pid: 1234, soleOwner: true },
      sql,
    );
    expect(out.reapedIds).not.toContain(held.id);
    expect(out.reapedIds).not.toContain(remote.id);
  });

  it('reaped rows are terminal and carry a released_at', async () => {
    const ws = 'ws-recon-stamp';
    await registerDesktopSession(
      base({ workspaceId: ws, scopeRef: 'sc-stamp', ownerBootId: 'boot-previous' }),
      sql,
    );
    await reconcileLocalDesktopSessions({ workspaceId: ws, liveIds: [], bootId: BOOT, pid: 1234 }, sql);
    const [row] = await listDesktopSessions({ workspaceId: ws, includeTerminal: true }, sql);
    expect(row.state).toBe('dead');
    expect(row.releasedAt).not.toBeNull();
  });
});

/**
 * DRIFT GUARD. `TERMINAL_DESKTOP_STATES` is a hand-written TypeScript copy of a
 * predicate the SQL owns in three places (the CHECK, and both partial indexes).
 * This repo has already had a hand-copied terminal-state set go stale and score
 * ~88% of finished units as failed placements, so the copy gets pinned to its
 * source rather than trusted.
 */
describe('local live-view admission gate (P-004)', () => {
  // Display numbers come from `base()`'s monotonic sequence, never hardcoded. A
  // display is a HOST-global resource — the live-display unique index is keyed on
  // (COALESCE(host_ref,''), display) with no workspace in it, deliberately, since
  // two tenants cannot both drive :110 on one machine. Hardcoding a number here
  // therefore collides with a sibling test and looks like a uniqueness bug.
  it('resolves a registered LOCAL display', async () => {
    const ws = 'ws-p004-admit';
    const s = await registerDesktopSession(base({ workspaceId: ws }), sql);
    const found = await resolveLocalDesktopByDisplay({ workspaceId: ws, display: s.display }, sql);
    expect(found?.id).toBe(s.id);
  });

  it('does NOT resolve a display nothing registered — this is what keeps :0 unviewable', async () => {
    const ws = 'ws-p004-unregistered';
    // POSITIVE CONTROL: the tenant HAS a desktop, so an empty answer for :0 is a
    // real refusal and not an empty-database artefact.
    const s = await registerDesktopSession(base({ workspaceId: ws }), sql);
    expect(await resolveLocalDesktopByDisplay({ workspaceId: ws, display: s.display }, sql)).toBeDefined();
    expect(await resolveLocalDesktopByDisplay({ workspaceId: ws, display: ':0' }, sql)).toBeUndefined();
  });

  it('stops resolving once the desktop is released — a dead lease is not viewable', async () => {
    const ws = 'ws-p004-released';
    const s = await registerDesktopSession(base({ workspaceId: ws }), sql);
    expect(await resolveLocalDesktopByDisplay({ workspaceId: ws, display: s.display }, sql)).toBeDefined();
    await closeDesktopSession(s.id, 'released', sql);
    expect(await resolveLocalDesktopByDisplay({ workspaceId: ws, display: s.display }, sql)).toBeUndefined();
  });

  it('never resolves a REMOTE row — a frame\'s display is not this host\'s display', async () => {
    const ws = 'ws-p004-remote';
    // Owned by another host: the local path must miss it (it belongs to the frame
    // path's SSH hop), or a viewer would spawn x11vnc against a local display
    // number that means something else entirely here.
    const s = await registerDesktopSession(
      base({ workspaceId: ws, hostRef: 'frame-lat-1', kind: 'frame-slot', scope: 'agent' }),
      sql,
    );
    expect(await resolveLocalDesktopByDisplay({ workspaceId: ws, display: s.display }, sql)).toBeUndefined();
    // CONTROL: the row really is there — resolvable by scope, just not locally.
    expect(
      await resolveDesktopForScope({ workspaceId: ws, scope: 'agent', scopeRef: s.scopeRef }, sql),
    ).toBeDefined();
  });

  it('scopes admission per tenant — another workspace cannot view this desktop', async () => {
    const s = await registerDesktopSession(base({ workspaceId: 'ws-p004-a' }), sql);
    expect(await resolveLocalDesktopByDisplay({ workspaceId: 'ws-p004-a', display: s.display }, sql)).toBeDefined();
    expect(await resolveLocalDesktopByDisplay({ workspaceId: 'ws-p004-b', display: s.display }, sql)).toBeUndefined();
  });
});

describe('viewer binding (P-004 cross-process indicator)', () => {
  it('publishes watcher + actor on the row, and clearing drops BOTH', async () => {
    const s = await registerDesktopSession(base(), sql);
    expect(s.viewerMode).toBe('none');

    expect(await setDesktopViewer(s.id, { mode: 'takeover', actor: 'user:a' }, sql)).toBe(true);
    const watched = await resolveDesktopForScope(
      { workspaceId: WS, scope: 'pot', scopeRef: s.scopeRef },
      sql,
    );
    expect(watched).toMatchObject({ viewerMode: 'takeover', viewerActor: 'user:a' });

    await setDesktopViewer(s.id, { mode: 'none' }, sql);
    const cleared = await resolveDesktopForScope(
      { workspaceId: WS, scope: 'pot', scopeRef: s.scopeRef },
      sql,
    );
    // The actor must go with the mode: a name left behind outlives the session
    // that earned it and reads as "this person is watching you" forever.
    expect(cleared).toMatchObject({ viewerMode: 'none', viewerActor: null });
  });

  it('clearing drops the actor even when a caller passes one', async () => {
    const s = await registerDesktopSession(base(), sql);
    await setDesktopViewer(s.id, { mode: 'none', actor: 'user:a' }, sql);
    const row = await resolveDesktopForScope({ workspaceId: WS, scope: 'pot', scopeRef: s.scopeRef }, sql);
    expect(row?.viewerActor).toBeNull();
  });

  it('returns false for a released row instead of throwing — teardown races are normal', async () => {
    const s = await registerDesktopSession(base(), sql);
    await closeDesktopSession(s.id, 'released', sql);
    expect(await setDesktopViewer(s.id, { mode: 'none' }, sql)).toBe(false);
  });

  it('returns false for a row that does not exist at all', async () => {
    expect(
      await setDesktopViewer('00000000-0000-0000-0000-000000000000', { mode: 'watch', actor: 'u' }, sql),
    ).toBe(false);
  });
});

describe('SQL/TS terminal-state drift guard', () => {
  const migrationSql = readFileSync(MIGRATION_900, 'utf8');

  it('the TS terminal set matches the partial-index predicate in migration 900', () => {
    const matches = [...migrationSql.matchAll(/state NOT IN \(([^)]*)\)/g)].map((m) =>
      m[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort(),
    );
    expect(matches.length).toBeGreaterThan(0);
    const expected = [...TERMINAL_DESKTOP_STATES].sort();
    for (const found of matches) {
      expect(found, 'a SQL predicate disagrees with TERMINAL_DESKTOP_STATES').toEqual(expected);
    }
  });

  it('every state the SQL CHECK allows is classified by isTerminalDesktopState', () => {
    const check = migrationSql.match(/desktop_sessions_state_ck[\s\S]*?state IN \(([^)]*)\)/);
    expect(check, 'could not locate the state CHECK constraint').not.toBeNull();
    const states = check![1].split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(states.length).toBeGreaterThan(0);
    const terminal = states.filter((s) => isTerminalDesktopState(s as never));
    expect(terminal.sort()).toEqual([...TERMINAL_DESKTOP_STATES].sort());
  });
});

/**
 * P-005 lifecycle surface (WI-40868) — the columns and transitions migration 905
 * adds, against real Postgres.
 *
 * Real PG matters here for the same reason it did for P-003: the guarantees are
 * things the DATABASE refuses. `markDesktopFrozen` is guarded to ready/idle by a
 * WHERE clause and `frozen_at` is required by a CHECK — a mocked client proves
 * the module emitted SQL, not that a frozen row can never lose its stamp.
 */
describe('P-005 — lease renewal', () => {
  it('bumps the activity clock and promotes idle back to ready', async () => {
    const s = await registerDesktopSession(base(), sql);
    await markDesktopReady(s.id, {}, sql);
    await sql`UPDATE harness_shared.desktop_sessions
                 SET state='idle', last_active_at = now() - interval '2 hours'
               WHERE id = ${s.id}`;

    const renewed = await renewDesktopLease(s.id, {}, sql);
    expect(renewed?.state).toBe('ready');
    expect(Date.now() - new Date(renewed!.lastActiveAt).getTime()).toBeLessThan(60_000);
  });

  it('an explicit ttlSec sets it; omitting ttlSec LEAVES IT ALONE', async () => {
    // The distinction that matters: collapsing "omitted" and "null" into one
    // nullable parameter is how a renewal silently turns a TTL'd lease immortal.
    const s = await registerDesktopSession(base({ ttlSec: 300 }), sql);
    expect((await renewDesktopLease(s.id, {}, sql))?.ttlSec).toBe(300);
    expect((await renewDesktopLease(s.id, { ttlSec: 900 }, sql))?.ttlSec).toBe(900);
    expect((await renewDesktopLease(s.id, { ttlSec: null }, sql))?.ttlSec).toBeNull();
  });

  it('returns undefined for a released session rather than reporting a false success', async () => {
    const s = await registerDesktopSession(base(), sql);
    await closeDesktopSession(s.id, 'released', sql);
    expect(await renewDesktopLease(s.id, { ttlSec: 60 }, sql)).toBeUndefined();
  });
});

describe('P-005 — the idle/freeze/thaw transitions', () => {
  const stateOf = async (scopeRef: string) =>
    (await resolveDesktopForScope({ workspaceId: WS, scope: 'pot', scopeRef }, sql)) ?? undefined;

  it('walks ready → idle → frozen → ready, stamping and clearing frozen_at', async () => {
    const s = await registerDesktopSession(base(), sql);
    await markDesktopReady(s.id, {}, sql);

    expect(await markDesktopIdle(s.id, sql)).toBe(true);
    expect(await markDesktopFrozen(s.id, sql)).toBe(true);
    const frozen = await stateOf(s.scopeRef);
    expect(frozen?.state).toBe('frozen');
    expect(frozen?.frozenAt).toBeInstanceOf(Date);

    expect(await markDesktopThawed(s.id, sql)).toBe(true);
    const thawed = await stateOf(s.scopeRef);
    expect(thawed?.state).toBe('ready');
    expect(thawed?.frozenAt).toBeNull();
  });

  it('markDesktopIdle refuses a frozen session — demoting it would drop frozen_at', async () => {
    const s = await registerDesktopSession(base(), sql);
    await markDesktopReady(s.id, {}, sql);
    await markDesktopFrozen(s.id, sql);
    expect(await markDesktopIdle(s.id, sql)).toBe(false);
  });

  it('touchDesktopSession promotes idle → ready but NEVER un-freezes a frozen session', async () => {
    // A row saying `ready` over a still-frozen cgroup hands an agent a desktop
    // whose X server cannot answer — the blank-screen class, by the back door.
    const s = await registerDesktopSession(base(), sql);
    await markDesktopReady(s.id, {}, sql);
    await markDesktopIdle(s.id, sql);
    await touchDesktopSession(s.id, sql);
    expect((await stateOf(s.scopeRef))?.state).toBe('ready');

    await markDesktopFrozen(s.id, sql);
    await touchDesktopSession(s.id, sql);
    expect((await stateOf(s.scopeRef))?.state).toBe('frozen');
  });

  it('touchDesktopSession reports the post-touch state, so a driver can see a freeze that beat it (WI-10006636)', async () => {
    const s = await registerDesktopSession(base(), sql);
    await markDesktopReady(s.id, {}, sql);
    expect(await touchDesktopSession(s.id, sql)).toBe('ready');
    await markDesktopFrozen(s.id, sql);
    expect(await touchDesktopSession(s.id, sql)).toBe('frozen');
    await closeDesktopSession(s.id, 'released', sql);
    expect(await touchDesktopSession(s.id, sql)).toBeUndefined();
  });

  it('a guarded freeze/idle REFUSES once the desktop was touched after the snapshot (WI-10006636)', async () => {
    const s = await registerDesktopSession(base(), sql);
    await markDesktopReady(s.id, {}, sql);
    await sql`UPDATE harness_shared.desktop_sessions
                 SET last_active_at = now() - interval '4 hours'
               WHERE id = ${s.id}`;
    const snapshot = (await stateOf(s.scopeRef))!.lastActiveAt;

    // A computer verb drives it after the sweep's scan.
    await touchDesktopSession(s.id, sql);
    expect(await markDesktopIdle(s.id, sql, { notActiveAfter: snapshot })).toBe(false);
    expect(await markDesktopFrozen(s.id, sql, { notActiveAfter: snapshot })).toBe(false);
    expect((await stateOf(s.scopeRef))?.state).toBe('ready');
  });

  it('a guarded write PASSES against its own snapshot despite Postgres keeping microseconds', async () => {
    // The snapshot crosses a JS Date (milliseconds). Pin a sub-millisecond clock
    // so an untruncated comparison would read the untouched row as touched.
    const s = await registerDesktopSession(base(), sql);
    await markDesktopReady(s.id, {}, sql);
    await sql`UPDATE harness_shared.desktop_sessions
                 SET last_active_at = date_trunc('second', now()) - interval '4 hours' + interval '123456 microseconds'
               WHERE id = ${s.id}`;
    const snapshot = (await stateOf(s.scopeRef))!.lastActiveAt;

    expect(await markDesktopIdle(s.id, sql, { notActiveAfter: snapshot })).toBe(true);
    expect(await markDesktopFrozen(s.id, sql, { notActiveAfter: snapshot })).toBe(true);
    expect((await stateOf(s.scopeRef))?.state).toBe('frozen');
  });

  it('the database itself refuses a frozen row with no frozen_at', async () => {
    const s = await registerDesktopSession(base(), sql);
    await markDesktopReady(s.id, {}, sql);
    await expect(
      sql`UPDATE harness_shared.desktop_sessions SET state='frozen' WHERE id = ${s.id}`,
    ).rejects.toThrow(/desktop_sessions_frozen_at_ck/);
  });
});

describe('P-005 — task-ledger binding', () => {
  it('round-trips a task id set at registration', async () => {
    const s = await registerDesktopSession(base({ taskId: 'task-abc', idleAfterSec: 42 }), sql);
    expect(s.taskId).toBe('task-abc');
    expect(s.idleAfterSec).toBe(42);
  });

  it('binds a task id after the fact, and reports honestly on a terminal row', async () => {
    const s = await registerDesktopSession(base(), sql);
    expect(s.taskId).toBeNull();
    expect(await setDesktopTaskId(s.id, 'task-late', sql)).toBe(true);
    await closeDesktopSession(s.id, 'released', sql);
    expect(await setDesktopTaskId(s.id, 'task-later', sql)).toBe(false);
  });
});

describe('P-005 — the governor read', () => {
  it('returns live LOCAL rows and excludes terminal and remote ones', async () => {
    const live = await registerDesktopSession(base(), sql);
    await markDesktopReady(live.id, {}, sql);
    const gone = await registerDesktopSession(base(), sql);
    await closeDesktopSession(gone.id, 'released', sql);
    const remote = await registerDesktopSession(base({ hostRef: 'frame-7' }), sql);

    const ids = (await listGovernableDesktopSessions({}, sql)).map((r) => r.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(gone.id);
    // The negative control that matters: a governor can only freeze cgroups on
    // its OWN host, so pulling a remote row in would "act" and change nothing
    // while marking the row frozen — misreporting a spinning guest as suspended.
    expect(ids).not.toContain(remote.id);

    const remoteIds = (await listGovernableDesktopSessions({ hostRef: 'frame-7' }, sql)).map((r) => r.id);
    expect(remoteIds).toContain(remote.id);
  });

  it('orders by least-recently-active first, so a capped run reaps the stalest', async () => {
    const fresh = await registerDesktopSession(base(), sql);
    const stale = await registerDesktopSession(base(), sql);
    await sql`UPDATE harness_shared.desktop_sessions
                 SET last_active_at = now() - interval '9 hours' WHERE id = ${stale.id}`;
    const rows = await listGovernableDesktopSessions({}, sql);
    expect(rows.findIndex((r) => r.id === stale.id)).toBeLessThan(
      rows.findIndex((r) => r.id === fresh.id),
    );
  });
});

describe('P-005 — a guest must declare its display backend at boot (EI-20504354859682877)', () => {
  it.each(['vm-guest', 'microvm'] as const)(
    'refuses a %s registered without capabilities.displayBackend',
    async (kind) => {
      // QMP display-update updates an EXISTING backend; it cannot create one. A
      // guest booted with none can never be viewed and cannot be repaired without
      // a reboot — so the constraint is enforced where it is still cheap.
      await expect(registerDesktopSession(base({ kind }), sql)).rejects.toThrow(
        /must declare capabilities\.displayBackend/,
      );
    },
  );

  it("refuses a guest that explicitly declares displayBackend 'none'", async () => {
    await expect(
      registerDesktopSession(base({ kind: 'vm-guest', capabilities: { displayBackend: 'none' } }), sql),
    ).rejects.toThrow(/cannot have one attached later/);
  });

  it('accepts a guest that declares a real backend', async () => {
    const s = await registerDesktopSession(
      base({ kind: 'vm-guest', capabilities: { displayBackend: 'vnc', kvm: true } }),
      sql,
    );
    expect(s.capabilities.displayBackend).toBe('vnc');
  });

  it('does NOT impose the constraint on non-guest kinds (the positive control)', async () => {
    // Without this, the refusals above would pass against a registry that
    // rejected every registration.
    for (const kind of ['xvfb-local', 'frame-slot', 'bwrap'] as const) {
      const s = await registerDesktopSession(base({ kind }), sql);
      expect(s.kind).toBe(kind);
    }
  });

  it('guestDisplayBackendError is a pure function P-011 can reuse without a database', () => {
    expect(guestDisplayBackendError('xvfb-local', undefined)).toBeNull();
    expect(guestDisplayBackendError('vm-guest', { displayBackend: 'egl-headless' })).toBeNull();
    expect(guestDisplayBackendError('vm-guest', undefined)).toMatch(/EI-20504354859682877/);
  });
});
