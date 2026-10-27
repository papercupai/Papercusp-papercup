/**
 * WI-10004559 guard: the PERIODIC sweeps over the shared psu-pty directory must never
 * touch it synchronously.
 *
 * Why this matters: every psu host on the box creates and renames files in that one
 * directory. When the ext4 journal stalls, a host holds the directory's inode lock while
 * it waits, and any thread that lists, stats or opens a path there waits in D-state
 * behind it. On the operator's main thread that froze the whole process for 20s+, and the
 * event-loop sentinel killed it, dropping every in-flight MCP request (46 of 66 :3070
 * kills in 24h were blocked in `iterate_dir` on this directory). The async forms move the
 * wait onto a libuv worker thread, so the event loop keeps serving.
 *
 * The spies below are pass-through: behaviour is the real implementation, they only
 * record which SYNC calls happened. The calibration case proves they see a sync scan, so
 * the zero-call assertions cannot pass vacuously.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
    statSync: vi.fn(actual.statSync),
    lstatSync: vi.fn(actual.lstatSync),
    existsSync: vi.fn(actual.existsSync),
    accessSync: vi.fn(actual.accessSync),
    readFileSync: vi.fn(actual.readFileSync),
    openSync: vi.fn(actual.openSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});

import {
  accessSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as discovery from './psu-pty-discovery';
import { stripCommentsAndStrings } from '../../../../../scripts/lib/strip-comments-and-strings.mjs';
import {
  listLiveHostsAsync,
  pruneDeadDiscoveryFilesAsync,
  readHostEventTailAsync,
} from './psu-pty-discovery';
import {
  listOrphanCandidateOwners,
  readRecentProductionCarryEvents,
} from '../../system-health/carry-drill-drop-watchdog';

const SYNC_SPIES = {
  readdirSync,
  statSync,
  lstatSync,
  existsSync,
  accessSync,
  readFileSync,
  openSync,
  unlinkSync,
} as unknown as Record<string, ReturnType<typeof vi.fn>>;

/** Every recorded sync fs call whose path argument lies inside `dir`. */
function syncCallsUnder(dir: string): string[] {
  const hits: string[] = [];
  for (const [name, spy] of Object.entries(SYNC_SPIES)) {
    for (const args of spy.mock.calls) {
      const p = args[0];
      if (typeof p === 'string' && p.startsWith(dir)) hits.push(`${name}(${p})`);
    }
  }
  return hits;
}

const verifyIdentity = () => true;
let dir: string;
const NOW = Date.now();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'psu-pty-async-'));
  const host = (ownerId: string, sockExists: boolean) => {
    const sock = join(dir, `${ownerId}.sock`);
    if (sockExists) writeFileSync(sock, '');
    writeFileSync(
      join(dir, `${ownerId}.json`),
      JSON.stringify({ ownerId, sock, pid: process.pid, startedAt: NOW, advSessionId: null }),
    );
  };
  host('su-live', true);
  host('su-dead', false); // socket gone → dead host, prunable
  writeFileSync(join(dir, 'su-corrupt.json'), '{not json');
  writeFileSync(join(dir, 'su-live.events.jsonl'), `${JSON.stringify({ ts: new Date(NOW).toISOString(), kind: 'respawned' })}\n`);
  const oldLedger = join(dir, 'su-old.events.jsonl');
  writeFileSync(oldLedger, `${JSON.stringify({ ts: new Date(NOW).toISOString(), kind: 'respawned' })}\n`);
  const old = new Date(NOW - 3 * 60 * 60_000);
  utimesSync(oldLedger, old, old);
  for (const spy of Object.values(SYNC_SPIES)) spy.mockClear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('psu-pty directory sweeps never touch the directory synchronously (WI-10004559)', () => {
  it('calibration: a synchronous read of the directory IS seen by the spies', async () => {
    expect(readdirSync(dir).filter((f) => f.endsWith('.json')).length).toBeGreaterThan(0);
    expect(syncCallsUnder(dir).length).toBeGreaterThan(0);
    expect((await listLiveHostsAsync(dir, { verifyIdentity })).map((h) => h.ownerId)).toEqual(['su-live']);
  });

  it('WI-10004587: the module offers NO synchronous directory lister for a main-thread caller to reach for', () => {
    // #1155: every sync listLiveHosts caller (session-end hook, idle reaper, desktop liveness,
    // session-dir-gc, disk census, pty wedge guard) blocked the operator main thread in
    // D-state (wchan iterate_dir) during journal stalls; the sentinel then SIGKILLed the
    // worker and every in-flight MCP call on it dropped. The sync forms were deleted so the
    // compiler refuses a new caller; this pins that they stay deleted.
    expect(discovery).toHaveProperty('listLiveHostsAsync'); // positive control: the probe reads real exports
    expect(discovery).toHaveProperty('pruneDeadDiscoveryFilesAsync');
    expect(discovery).not.toHaveProperty('listLiveHosts');
    expect(discovery).not.toHaveProperty('pruneDeadDiscoveryFiles');
  });

  it('WI-10004698: the module contains NO synchronous directory scan at all, exported or internal', () => {
    // The export check above cannot see a private helper. recordedOwnerIdForSock (the
    // inject owner-binding detector) kept a readdirSync of the whole discovery dir after
    // WI-10004587; it is now two named-record reads. Comments and strings are masked so
    // prose that names the old call cannot satisfy or trip this.
    const raw = readFileSync(join(__dirname, 'psu-pty-discovery.ts'), 'utf8');
    const live = stripCommentsAndStrings(raw, 'psu-pty-discovery.ts');
    expect(live).toMatch(/\breadFileSync\(/); // positive control: masking kept real calls
    expect(raw).toMatch(/readdirSync/); // the prose mention exists, so the mask is what hides it
    expect(live).not.toMatch(/\breaddirSync\b/);
    expect(live).not.toMatch(/\bopendirSync\b/);
  });

  it('listLiveHostsAsync', async () => {
    const hosts = await listLiveHostsAsync(dir, { verifyIdentity });
    expect(hosts.map((h) => h.ownerId)).toEqual(['su-live']);
    expect(syncCallsUnder(dir)).toEqual([]);
  });

  it('bounds concurrent per-host checks while preserving every live result', async () => {
    const owners = Array.from({ length: 24 }, (_, i) => `su-bulk-${i}`);
    for (const ownerId of owners) {
      const sock = join(dir, `${ownerId}.sock`);
      writeFileSync(sock, '');
      writeFileSync(
        join(dir, `${ownerId}.json`),
        JSON.stringify({ ownerId, sock, pid: process.pid, startedAt: NOW, advSessionId: null }),
      );
    }

    let activeChecks = 0;
    let maxActiveChecks = 0;
    const hosts = await listLiveHostsAsync(dir, {
      verifyIdentity: async () => {
        activeChecks += 1;
        maxActiveChecks = Math.max(maxActiveChecks, activeChecks);
        await new Promise<void>((resolve) => setImmediate(resolve));
        activeChecks -= 1;
        return true;
      },
    });

    expect(hosts.filter((host) => owners.includes(host.ownerId))).toHaveLength(owners.length);
    expect(maxActiveChecks).toBeGreaterThan(1);
    expect(maxActiveChecks).toBeLessThanOrEqual(8);
    expect(syncCallsUnder(dir)).toEqual([]);
  });

  it('pruneDeadDiscoveryFilesAsync (the janitor)', async () => {
    expect(await pruneDeadDiscoveryFilesAsync(dir, { verifyIdentity })).toBe(2); // su-dead + su-corrupt
    expect(syncCallsUnder(dir)).toEqual([]);
    // Real effect, checked AFTER the assertion so these sync reads are not counted.
    expect(existsSync(join(dir, 'su-dead.json'))).toBe(false);
    expect(existsSync(join(dir, 'su-corrupt.json'))).toBe(false);
    expect(existsSync(join(dir, 'su-live.json'))).toBe(true);
  });

  it('readHostEventTailAsync', async () => {
    expect(await readHostEventTailAsync('su-live', dir)).toEqual([expect.objectContaining({ kind: 'respawned' })]);
    expect(await readHostEventTailAsync('su-missing', dir)).toEqual([]);
    expect(syncCallsUnder(dir)).toEqual([]);
  });

  it('carry-drill-drop watchdog: production-delivery read (runs every 60s)', async () => {
    // The reader keeps only TERMINAL carry-respawn outcomes, so a bare `respawned` line
    // (what the shared fixture writes) is filtered out by design. Append one terminal
    // outcome to BOTH ledgers: su-old then carries a matching event too, so its absence
    // below is the window's doing, not the kind filter's.
    const outcome = `${JSON.stringify({ ts: new Date(NOW).toISOString(), kind: 'respawn-carry-delivered', mode: 'carry-respawn' })}\n`;
    writeFileSync(join(dir, 'su-live.events.jsonl'), outcome, { flag: 'a' });
    const oldLedger = join(dir, 'su-old.events.jsonl');
    writeFileSync(oldLedger, outcome, { flag: 'a' });
    const old = new Date(NOW - 3 * 60 * 60_000);
    utimesSync(oldLedger, old, old);

    const events = await readRecentProductionCarryEvents(dir, NOW);
    // su-live's terminal outcome only: its `respawned` line is not terminal, and su-old is outside the window.
    expect(events).toEqual([expect.objectContaining({ kind: 'respawn-carry-delivered', mode: 'carry-respawn' })]);
    expect(syncCallsUnder(dir)).toEqual([]);
  });

  it('carry-drill-drop watchdog: orphan candidate listing (runs every 60s)', async () => {
    expect(await listOrphanCandidateOwners(dir, NOW, 60 * 60_000)).toEqual(['su-live']);
    expect(syncCallsUnder(dir)).toEqual([]);
  });
});

describe('the janitor never reaps a host-code adoption handoff (WI-6554700010008431)', () => {
  // A handoff is `<key>.handoff.json`: it ends in `.json`, carries no pid/sock, and lives
  // in the discovery directory for ~1s between a predecessor writing it and the re-exec'd
  // launcher consuming it. Sweeping it as a "dead host" made the successor cold-boot
  // without its carry.
  let hdir: string;
  beforeEach(() => {
    hdir = mkdtempSync(join(tmpdir(), 'psu-pty-handoff-sweep-'));
  });
  afterEach(() => {
    rmSync(hdir, { recursive: true, force: true });
  });

  const handoffRecord = (ownerId: string) =>
    JSON.stringify({ ownerId, fromPid: 2 ** 22 + 7, parentPid: process.pid, createdAt: new Date().toISOString(), mode: 'carry-respawn', args: ['--x'] });

  it('leaves a parseable handoff AND a half-written one, while still pruning a dead discovery record', async () => {
    writeFileSync(join(hdir, 'su-adopting.handoff.json'), handoffRecord('su-adopting'));
    writeFileSync(join(hdir, 'su-midwrite.handoff.json'), '{"ownerId":"su-midwr'); // partial write
    // Control: a real dead discovery record IS still reaped, so the sweep is not a no-op.
    writeFileSync(
      join(hdir, 'su-dead.json'),
      JSON.stringify({ ownerId: 'su-dead', pid: 2 ** 22 + 9, sock: join(hdir, 'su-dead.sock'), startedAt: NOW }),
    );
    expect(await pruneDeadDiscoveryFilesAsync(hdir, { verifyIdentity: () => false })).toBe(1);
    expect(existsSync(join(hdir, 'su-dead.json'))).toBe(false);
    expect(existsSync(join(hdir, 'su-adopting.handoff.json'))).toBe(true);
    expect(existsSync(join(hdir, 'su-midwrite.handoff.json'))).toBe(true);
  });

  it('leaves any other parseable non-discovery JSON alone (shape rail, not just the name rail)', async () => {
    writeFileSync(join(hdir, 'su-future.sidecar.json'), JSON.stringify({ ownerId: 'su-future', note: 'not a host' }));
    expect(await pruneDeadDiscoveryFilesAsync(hdir, { verifyIdentity: () => false })).toBe(0);
    expect(existsSync(join(hdir, 'su-future.sidecar.json'))).toBe(true);
  });

  it('never lists a handoff as a host', async () => {
    writeFileSync(join(hdir, 'su-adopting.handoff.json'), handoffRecord('su-adopting'));
    expect(await listLiveHostsAsync(hdir, { verifyIdentity: () => true })).toEqual([]);
  });

  it('the predicate agrees with the host writer suffix (lockstep pin against psu-pty-host.mjs)', () => {
    const hostSrc = readFileSync(
      new URL('../../../../../apps/operator/scripts/psu-pty-host.mjs', import.meta.url),
      'utf8',
    );
    const m = hostSrc.match(/export const HOST_HANDOFF_FILE_SUFFIX = '([^']+)';/);
    expect(m?.[1]).toBe(discovery.HOST_HANDOFF_FILE_SUFFIX);
    // handoffPathFor must build its name FROM the constant, or the constant pins nothing.
    expect(hostSrc).toMatch(/\$\{sanitizeKey\(ownerId\)\}\$\{HOST_HANDOFF_FILE_SUFFIX\}/);
    expect(discovery.isDiscoveryRecordFileName('su-a.json')).toBe(true);
    expect(discovery.isDiscoveryRecordFileName(`su-a${discovery.HOST_HANDOFF_FILE_SUFFIX}`)).toBe(false);
    expect(discovery.isDiscoveryRecordFileName('su-a.events.jsonl')).toBe(false);
  });
});
