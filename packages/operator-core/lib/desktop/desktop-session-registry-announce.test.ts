/**
 * The local desktop grid's live-update contract (agent-multi-desktops-grid D-015).
 *
 * `desktop_sessions` carries no change-notify trigger, so the grid only hears about
 * a new, released, frozen or watched desktop because the registry announces
 * `desktops.local` itself. Both failure directions are silent: a write that stops
 * announcing leaves a stale tile until the next visible tick, and a heartbeat that
 * starts announcing churns every viewer's cache every few seconds. Pinned here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const notifySyncInvalidate = vi.fn(async () => undefined);
vi.mock('../sync-sse', () => ({ notifySyncInvalidate }));

import { drainDetached } from '../detached-imports';
import {
  LOCAL_DESKTOPS_QUERY,
  closeDesktopSession,
  markDesktopFrozen,
  markDesktopIdle,
  markDesktopThawed,
  reconcileLocalDesktopSessions,
  setDesktopViewer,
  touchDesktopSession,
  renewDesktopLease,
} from './desktop-session-registry';

/** A tagged-template stand-in that answers every statement with `rows`. */
function fakeSql(rows: Record<string, unknown>[]): Sql {
  const tag = (() => Promise.resolve(rows)) as unknown as Sql;
  return tag;
}

async function announced(): Promise<string[]> {
  await drainDetached();
  return notifySyncInvalidate.mock.calls.map((c) => (c as unknown[])[0] as string);
}

afterEach(() => notifySyncInvalidate.mockClear());

describe('desktop registry announces desktops.local on roster-visible writes', () => {
  it('the query name is the one the grid subscribes to', () => {
    expect(LOCAL_DESKTOPS_QUERY).toBe('desktops.local');
  });

  it.each([
    ['closeDesktopSession', (sql: Sql) => closeDesktopSession('d1', 'released', sql)],
    ['markDesktopIdle', (sql: Sql) => markDesktopIdle('d1', sql)],
    ['markDesktopFrozen', (sql: Sql) => markDesktopFrozen('d1', sql)],
    ['markDesktopThawed', (sql: Sql) => markDesktopThawed('d1', sql)],
    ['setDesktopViewer', (sql: Sql) => setDesktopViewer('d1', { mode: 'watch', actor: 'u' }, sql)],
    [
      'reconcileLocalDesktopSessions',
      (sql: Sql) => reconcileLocalDesktopSessions({ workspaceId: 'ws', liveIds: [] }, sql),
    ],
  ])('%s announces when a row changed', async (_name, write) => {
    await write(fakeSql([{ id: 'd1' }]));
    expect(await announced()).toEqual(['desktops.local']);
  });

  it('a write that changed no row announces nothing', async () => {
    await closeDesktopSession('d1', 'released', fakeSql([]));
    await setDesktopViewer('d1', { mode: 'none' }, fakeSql([]));
    expect(await announced()).toEqual([]);
  });

  it('activity-clock writes (touch, renew) never announce', async () => {
    // Positive control first: the same fake + drain DOES observe an announcement,
    // so the empty result below is a real absence, not a broken instrument.
    await markDesktopIdle('d1', fakeSql([{ id: 'd1' }]));
    expect(await announced()).toEqual(['desktops.local']);
    notifySyncInvalidate.mockClear();

    await touchDesktopSession('d1', fakeSql([{ id: 'd1' }]));
    await renewDesktopLease('d1', {}, fakeSql([{ id: 'd1' }]));
    expect(await announced()).toEqual([]);
  });

  it('a failed announcement never fails the write', async () => {
    notifySyncInvalidate.mockRejectedValueOnce(new Error('pg_notify failed'));
    await expect(closeDesktopSession('d1', 'released', fakeSql([{ id: 'd1' }]))).resolves.toBe(true);
    await drainDetached();
  });
});
