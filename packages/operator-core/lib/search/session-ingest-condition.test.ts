import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as org from '@papercusp/db-org';
import {
  evaluatePartsWriter, observeAdapterLag, readIngestBacklogRecovery, sessionIngestConditionKey,
  sessionIngestLagSweep, sessionPartsWriterSweep,
  type AdapterLagObservation, type PartsWriterObservation,
} from './session-ingest-lag-watchdog';
import { evaluateInteractiveUsageFreshness } from '../interactive-usage/freshness';
import { mockOrgPgSql } from '../testing/mock-org-pg';

const filesystem = vi.hoisted(() => ({ stat: vi.fn(), open: vi.fn() }));
// Native ESM namespaces are immutable; mock this boundary before the producer
// imports it rather than attempting to redefine node:fs exports at runtime.
vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()), ...filesystem,
}));
vi.mock('./session-ingest', () => ({ FILE_ADAPTERS: [{ sourceKind: 'claude', parseParts: () => [] }] }));

const hour = 3600_000, now = Date.parse('2026-10-12T12:00:00Z');
const opts = { workspaceId: 'fixture:workspace', installSlug: 'fixture:install' };
const progressMigrationBase = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../libs/papercusp/libs/db/sql/1616-session-ingest-byte-offset-progress.sql',
);
const progressMigrationPath = existsSync(progressMigrationBase)
  ? progressMigrationBase
  : progressMigrationBase + '.DRAFT';
const backlog = (over: Partial<AdapterLagObservation> = {}): AdapterLagObservation => ({
  sourceKind: 'codex', behindFiles: 1, backlogBytes: 9e6, oldestBacklogAgeMs: 6 * hour,
  worstPath: '/fixture/rollout', ...over,
});
const parts = (over: Partial<PartsWriterObservation> = {}): PartsWriterObservation => ({
  sourceKind: 'claude', expectsParts: true, turnsInWindow: 10, partsInWindow: 0, ...over,
});
/** Spy getOrgPg() onto a `{ sql }` stand-in via the sanctioned partial-client helper. */
function stubOrgSql(sql: unknown): void {
  vi.spyOn(org, 'getOrgPg');
  mockOrgPgSql(vi.mocked(org.getOrgPg), sql);
}
function fixture() {
  const open = new Set<string>();
  const rail = {
    broadcast: vi.fn(async (event: { conditionKey?: string; oneShot?: boolean }) => {
      expect(event.oneShot).toBe(true); open.add(event.conditionKey!); return true;
    }),
    resolve: vi.fn(async (event: { conditionKey: string }) => open.delete(event.conditionKey)),
  };
  const deps = { rail, now,
    readOpenConditionKeys: async () => [...open],
    readBacklogRecovery: vi.fn(async (_source: string, _path: string, _threshold: number,
      _now: number): Promise<boolean | null> => null),
    observeInteractiveUsageFreshness: async () => evaluateInteractiveUsageFreshness(now, now, undefined, 0),
    recentWatchdogFires: vi.fn(async () => 1),
    recordFire: vi.fn(async () => undefined as never),
    openEscalation: vi.fn(async () => undefined as never),
  };
  return { open, rail, deps };
}

beforeEach(() => {
  filesystem.stat.mockReset(); filesystem.open.mockReset();
  vi.stubEnv('PAPERCUSP_INGEST_LAG_THRESHOLD_SEC', '3600');
  vi.stubEnv('PAPERCUSP_PARTS_WRITER_WINDOW_SEC', '3600');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('original ingest condition lifecycle', () => {
  it('opens before legacy debounce and preserves missing candidates until exact file recovery', async () => {
    const f = fixture();
    const key = sessionIngestConditionKey('backlog', opts.workspaceId, opts.installSlug, 'codex', '/fixture/rollout');
    const first = await sessionIngestLagSweep(opts, { ...f.deps, observe: async () => [backlog()] });
    expect(first[0].outcome).toBe('debounced'); expect(f.open.has(key)).toBe(true);
    expect(f.deps.recordFire).not.toHaveBeenCalled();
    await sessionIngestLagSweep(opts, { ...f.deps, observe: async () => [] });
    expect(f.open.has(key)).toBe(true);
    expect(f.deps.readBacklogRecovery).toHaveBeenCalledWith('codex', '/fixture/rollout', hour, now);
    f.deps.readBacklogRecovery.mockRejectedValueOnce(new Error('exact read unavailable'));
    await sessionIngestLagSweep(opts, { ...f.deps, observe: async () => [] });
    expect(f.open.has(key)).toBe(true);
    f.deps.readBacklogRecovery.mockResolvedValue(false);
    await sessionIngestLagSweep(opts, { ...f.deps, observe: async () => [] });
    expect(f.open.has(key)).toBe(true);
    f.deps.readBacklogRecovery.mockResolvedValue(true);
    await sessionIngestLagSweep(opts, { ...f.deps, observe: async () => [] });
    expect(f.open.has(key)).toBe(false);
  });

  it('does not confuse source, file, workspace or install episodes', async () => {
    const f = fixture();
    const own = sessionIngestConditionKey('backlog', opts.workspaceId, opts.installSlug, 'codex', '/a');
    const foreign = [sessionIngestConditionKey('backlog', 'other', opts.installSlug, 'codex', '/a'),
      sessionIngestConditionKey('backlog', opts.workspaceId, 'other', 'codex', '/a'),
      'alarm:session-ingest:backlog:broken'];
    f.open.add(own); foreign.forEach(key => f.open.add(key));
    f.deps.readBacklogRecovery.mockResolvedValue(true);
    await sessionIngestLagSweep(opts, { ...f.deps, observe: async () => [backlog({ worstPath: '/b' })] });
    expect(f.open.has(own)).toBe(false);
    foreign.forEach(key => expect(f.open.has(key)).toBe(true));
    expect(f.deps.readBacklogRecovery.mock.calls.every(call => call[0] === 'codex')).toBe(true);
  });

  it('keeps legacy escalation usable when the condition sink refuses', async () => {
    const f = fixture(); f.rail.broadcast.mockRejectedValue(new Error('rail unavailable'));
    f.deps.recentWatchdogFires.mockResolvedValue(0);
    const results = await sessionIngestLagSweep(opts, { ...f.deps, observe: async () => [backlog()] });
    expect(results[0].outcome).toBe('alerted'); expect(f.deps.openEscalation).toHaveBeenCalledOnce();
  });

  it.each([NaN, Infinity, -1, 1.5, true, '0'])('rejects malformed backlog count %s', async value => {
    const f = fixture();
    const results = await sessionIngestLagSweep(opts, { ...f.deps,
      observe: async () => [backlog({ behindFiles: value as number })] });
    expect(results[0].outcome).toBe('error'); expect(f.rail.broadcast).not.toHaveBeenCalled();
  });

  it('preserves usage episodes when freshness is unavailable or recent lag is unmeasured', async () => {
    const f = fixture();
    const key = sessionIngestConditionKey('usage', opts.workspaceId, opts.installSlug, 'interactive');
    const sweep = (stamp: number | null, lag: number | null = null) => sessionIngestLagSweep(opts,
      { ...f.deps, observe: async () => [],
        observeInteractiveUsageFreshness: async () => evaluateInteractiveUsageFreshness(stamp, now, undefined, lag) });
    await sweep(now - hour); expect(f.open.has(key)).toBe(true);
    await sweep(null); expect(f.open.has(key)).toBe(true);
    await sweep(now); expect(f.open.has(key)).toBe(true);
    await sweep(now, 0); expect(f.open.has(key)).toBe(false);
  });

  it('disabled ticks preserve durable episodes without reading or clearing', async () => {
    const f = fixture(); f.open.add('existing');
    vi.stubEnv('PAPERCUSP_INGEST_LAG_THRESHOLD_SEC', '0');
    await sessionIngestLagSweep(opts, { ...f.deps, observe: async () => { throw new Error('must not read'); } });
    expect(f.open.has('existing')).toBe(true); expect(f.rail.resolve).not.toHaveBeenCalled();
  });
});

describe('original parts verdict producer', () => {
  it.each([true, false, '', ' ', '1.5', '-1'])('production SQL counts reject %s before recovery', async value => {
    const f = fixture(); const key = sessionIngestConditionKey('parts', opts.workspaceId, opts.installSlug, 'claude');
    f.open.add(key);
    stubOrgSql(async () => [{ source_kind: 'claude', turns: '10', parts: value }]);
    const result = await sessionPartsWriterSweep(opts, f.deps);
    expect(result[0].outcome).toBe('error'); expect(f.open.has(key)).toBe(true);
    expect(f.rail.broadcast).not.toHaveBeenCalled(); expect(f.rail.resolve).not.toHaveBeenCalled();
  });

  it('valid decimal PostgreSQL counts measure actual parts recovery', async () => {
    const f = fixture(); const key = sessionIngestConditionKey('parts', opts.workspaceId, opts.installSlug, 'claude');
    f.open.add(key);
    stubOrgSql(async () => [{ source_kind: 'claude', turns: '10', parts: '1' }]);
    await sessionPartsWriterSweep(opts, f.deps); expect(f.open.has(key)).toBe(false);
  });
  it('retains its pure synchronous API and publishes in the awaited production mode', async () => {
    const f = fixture(); const input = parts();
    expect(evaluatePartsWriter(input).degraded).toBe(true);
    expect((await evaluatePartsWriter(input, { ...opts, rail: f.rail })).degraded).toBe(true);
    const key = sessionIngestConditionKey('parts', opts.workspaceId, opts.installSlug, 'claude');
    expect(f.open.has(key)).toBe(true);
    for (const input of [parts({ turnsInWindow: 0 }), parts({ expectsParts: false }),
      parts({ sourceKind: 'codex', partsInWindow: 10 })]) {
      await sessionPartsWriterSweep(opts, { ...f.deps, observe: async () => [input] });
      expect(f.open.has(key)).toBe(true);
    }
    await sessionPartsWriterSweep(opts, { ...f.deps, observe: async () => [] });
    expect(f.open.has(key)).toBe(true);
    await sessionPartsWriterSweep(opts, { ...f.deps, observe: async () => [parts({ partsInWindow: 1 })] });
    expect(f.open.has(key)).toBe(false);
  });

  it.each([NaN, Infinity, -1, 1.5, true, '0'])('invalid parts counts %s cannot recover', async value => {
    const f = fixture(); const key = sessionIngestConditionKey('parts', opts.workspaceId, opts.installSlug, 'claude');
    f.open.add(key);
    const result = await sessionPartsWriterSweep(opts, { ...f.deps,
      observe: async () => [parts({ partsInWindow: value as number })] });
    expect(result[0].outcome).toBe('error'); expect(f.open.has(key)).toBe(true);
  });

  it('rail failure cannot prevent legacy escalation', async () => {
    const f = fixture(); f.rail.broadcast.mockRejectedValue(new Error('rail unavailable'));
    f.deps.recentWatchdogFires.mockResolvedValue(0);
    const results = await sessionPartsWriterSweep(opts, { ...f.deps, observe: async () => [parts()] });
    expect(results[0].outcome).toBe('alerted'); expect(f.deps.openEscalation).toHaveBeenCalledOnce();
  });
});

describe('exact affected-file production reader', () => {
  function readerFixture() {
    const row = { source_kind: 'codex', file_path: '/fixture/rollout', byte_offset: '0',
      byte_offset_changed_at: new Date(now - 6 * hour).toISOString(),
      updated_at: new Date(now - 6 * hour).toISOString() };
    const sql = vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => [row]);
    stubOrgSql(sql);
    const stat = filesystem.stat.mockResolvedValue({ isFile: () => true, size: 2e6 });
    filesystem.open.mockResolvedValue({
      read: async (buffer: Buffer, _offset: number, length: number) => {
        buffer.fill(0x0a, 0, length);
        return { bytesRead: length };
      },
      close: async () => {},
    } as never);
    return { row, sql, stat, read: () => readIngestBacklogRecovery('codex', '/fixture/rollout', hour, now) };
  }
  it('reads the exact source/file without the candidate limit and distinguishes stale from caught up', async () => {
    const f = readerFixture(); expect(await f.read()).toBe(false);
    expect(f.sql.mock.calls[0].slice(1)).toEqual(['codex', '/fixture/rollout']);
    const query = (f.sql.mock.calls[0][0] as unknown as TemplateStringsArray).join(' ');
    expect(query).not.toMatch(/LIMIT|45 days/); expect(query).toContain('source_kind =');
    expect(query).toContain('byte_offset_changed_at');
    expect(query).not.toContain('updated_at');
    f.row.byte_offset = '2000000'; expect(await f.read()).toBe(true);
  });
  it('does not clear a large consumable backlog after an auxiliary state-row write', async () => {
    const f = readerFixture();
    f.row.updated_at = new Date(now - 5 * 60_000).toISOString();
    expect(await f.read()).toBe(false);
    f.row.byte_offset_changed_at = new Date(now - 5 * 60_000).toISOString();
    expect(await f.read()).toBe(true);
  });
  it('missing or foreign rows preserve instead of clearing', async () => {
    const f = readerFixture(); f.sql.mockResolvedValueOnce([]); expect(await f.read()).toBe(null);
    f.row.source_kind = 'claude'; expect(await f.read()).toBe(null);
  });
  it.each(['', ' ', '-1', '1.5', 'NaN', true])('malformed offsets %s are unknown', async value => {
    const f = readerFixture(); f.row.byte_offset = value as string; expect(await f.read()).toBe(null);
    expect(f.stat).not.toHaveBeenCalled();
  });
  it('truncated files and invalid clocks are unknown', async () => {
    const f = readerFixture(); f.row.byte_offset = '3000000'; expect(await f.read()).toBe(null);
    f.row.byte_offset = '0'; f.row.byte_offset_changed_at = 'invalid'; expect(await f.read()).toBe(null);
  });
  it('ages backlog from primary cursor change even when updated_at is fresh', async () => {
    const f = readerFixture();
    const nowMs = Date.now();
    f.row.updated_at = new Date(nowMs).toISOString();
    f.row.byte_offset_changed_at = new Date(nowMs - 6 * hour).toISOString();
    const [observation] = await observeAdapterLag();
    expect(observation.oldestBacklogAgeMs).toBeGreaterThanOrEqual(6 * hour);
    const query = (f.sql.mock.calls[0][0] as unknown as TemplateStringsArray).join(' ');
    expect(query).toContain('byte_offset_changed_at');
    expect(query).toContain('ORDER BY updated_at DESC');
  });
  it('keeps the migration marker tied to primary byte_offset changes', async () => {
    const migration = await readFile(progressMigrationPath, 'utf8');
    expect(migration).toContain('SET byte_offset_changed_at = updated_at');
    expect(migration).toContain('NEW.byte_offset IS DISTINCT FROM OLD.byte_offset');
    expect(migration).toContain('NEW.byte_offset_changed_at := OLD.byte_offset_changed_at');
    expect(migration).toContain('NEW.byte_offset_changed_at := now()');
  });
  it('file read failure and short reads are unknown', async () => {
    const f = readerFixture(); f.stat.mockResolvedValue({ isFile: () => true, size: 128 * 1024 });
    const open = filesystem.open.mockRejectedValueOnce(new Error('unreadable'));
    expect(await f.read()).toBe(null);
    const close = vi.fn(async () => {});
    open.mockResolvedValue({ read: async () => ({ bytesRead: 0 }), close });
    expect(await f.read()).toBe(null); expect(close).toHaveBeenCalledOnce();
  });
});
