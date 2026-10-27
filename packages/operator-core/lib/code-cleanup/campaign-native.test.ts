/**
 * code-cleanup-campaigns-2026-10-26 P-009 (D-016): the campaign throttle store over the runner
 * work-item payload, and the repo file reader the runner plans extractions with.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_ID_PAYLOAD_KEY, CAMPAIGN_THROTTLE_PAYLOAD_KEY, editPathAcquire, gateRedsFromRows, landedBatchesFromRows,
  nativeCampaignRoundDeps, parseThrottleState, repoFileReader, resetCampaignThrottle, serializeThrottleState, workItemThrottleStore,
  type RunnerItemRows,
} from './campaign-native';
import { initialThrottleState, type CampaignThrottleState } from './throttle';

const TRIPPED: CampaignThrottleState = {
  throttled: true, review: 'required', reviewBeforeTrip: 'off',
  trippedAt: new Date('2026-10-27T08:00:00.000Z'), resetAt: null, resetBy: null,
};

function memoryRows(payload: Record<string, unknown> | null): RunnerItemRows & { writes: Array<[string, string, unknown]> } {
  const writes: Array<[string, string, unknown]> = [];
  return {
    writes,
    async read(id) { return id === 'WI-RUN' && payload ? { payload } : null; },
    async merge(id, key, value) {
      writes.push([id, key, value]);
      if (id !== 'WI-RUN' || !payload) return 0;
      payload[key] = value;
      return 1;
    },
  };
}
const scope = { workspaceId: 'ws', harness: 'papercusp', runnerItemId: 'WI-RUN', defaultReview: 'off' as const };

describe('throttle state serialization', () => {
  it('round-trips a tripped state through its JSON form', () => {
    const json = JSON.parse(JSON.stringify(serializeThrottleState(TRIPPED)));
    expect(json.trippedAt).toBe('2026-10-27T08:00:00.000Z');
    expect(parseThrottleState(json, 'off')).toEqual(TRIPPED);
  });

  it('reads a never-stored state as the initial one with the campaign default review', () => {
    expect(parseThrottleState(undefined, 'required')).toEqual(initialThrottleState('required'));
    expect(parseThrottleState(null, 'off')).toEqual(initialThrottleState('off'));
  });

  it('refuses a malformed stored state instead of reading it as not throttled', () => {
    expect(() => parseThrottleState({ review: 'off' }, 'off')).toThrow(/throttled flag/);
    expect(() => parseThrottleState({ throttled: true, review: 'maybe' }, 'off')).toThrow(/review setting/);
    expect(() => parseThrottleState({ throttled: true, review: 'off', trippedAt: 'not a date' }, 'off')).toThrow(/trippedAt/);
    expect(() => parseThrottleState('tripped', 'off')).toThrow(/not an object/);
  });
});

describe('workItemThrottleStore', () => {
  it('loads the initial state when the runner item has none, and saves under codeCleanupThrottle', async () => {
    const payload: Record<string, unknown> = { [CAMPAIGN_ID_PAYLOAD_KEY]: 'papercusp-1' };
    const rows = memoryRows(payload);
    const store = workItemThrottleStore(scope, { rows });
    expect(await store.load('papercusp-1')).toEqual(initialThrottleState('off'));
    await store.save('papercusp-1', TRIPPED);
    expect(rows.writes).toEqual([['WI-RUN', CAMPAIGN_THROTTLE_PAYLOAD_KEY, serializeThrottleState(TRIPPED)]]);
    expect(await store.load('papercusp-1')).toEqual(TRIPPED);
  });

  it('refuses a runner item that runs a different campaign', async () => {
    const store = workItemThrottleStore(scope, { rows: memoryRows({ [CAMPAIGN_ID_PAYLOAD_KEY]: 'other' }) });
    await expect(store.load('papercusp-1')).rejects.toThrow(/runs campaign other/);
    await expect(store.save('papercusp-1', TRIPPED)).rejects.toThrow(/runs campaign other/);
  });

  it('fails loudly when the runner item is missing or the save touches no row', async () => {
    await expect(workItemThrottleStore(scope, { rows: memoryRows(null) }).load('c')).rejects.toThrow(/not found/);
    const rows = memoryRows({});
    rows.merge = async () => 0;
    await expect(workItemThrottleStore(scope, { rows }).save('c', TRIPPED)).rejects.toThrow(/updated 0 rows/);
  });
});

describe('resetCampaignThrottle', () => {
  const tripped = () => ({ [CAMPAIGN_ID_PAYLOAD_KEY]: 'papercusp-1',
    [CAMPAIGN_THROTTLE_PAYLOAD_KEY]: serializeThrottleState(TRIPPED) } as Record<string, unknown>);
  const NOW = new Date('2026-10-27T10:00:00.000Z');

  it('refuses an agent principal and writes nothing', async () => {
    const rows = memoryRows(tripped());
    const out = await resetCampaignThrottle({ store: workItemThrottleStore(scope, { rows }), campaignId: 'papercusp-1',
      principal: 'su-4dec493b', now: NOW });
    expect(out).toMatchObject({ ok: false, code: 'not-owner' });
    expect(rows.writes).toEqual([]);
  });

  it('refuses a campaign that is not throttled and writes nothing', async () => {
    const rows = memoryRows({ [CAMPAIGN_ID_PAYLOAD_KEY]: 'papercusp-1' });
    const out = await resetCampaignThrottle({ store: workItemThrottleStore(scope, { rows }), campaignId: 'papercusp-1',
      principal: 'admin:avi', now: NOW });
    expect(out).toMatchObject({ ok: false, code: 'not-throttled' });
    expect(rows.writes).toEqual([]);
  });

  it('lets an owner reset, restores the pre-trip review, and saves who reset it and when', async () => {
    const rows = memoryRows(tripped());
    const store = workItemThrottleStore(scope, { rows });
    const out = await resetCampaignThrottle({ store, campaignId: 'papercusp-1', principal: 'admin:avi', now: NOW });
    const expected: CampaignThrottleState = { throttled: false, review: 'off', reviewBeforeTrip: null,
      trippedAt: null, resetAt: NOW, resetBy: 'admin:avi' };
    expect(out).toEqual({ ok: true, state: expected });
    expect(rows.writes).toEqual([['WI-RUN', CAMPAIGN_THROTTLE_PAYLOAD_KEY, serializeThrottleState(expected)]]);
    expect(await store.load('papercusp-1')).toEqual(expected);
  });
});

describe('repoFileReader', () => {
  it('reads files under the root and refuses paths outside it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanup-native-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\n');
    const read = repoFileReader(root);
    expect(await read('src/a.ts')).toBe('export const a = 1;\n');
    expect(await read('src/missing.ts')).toBeNull();
    expect(await read('../outside.ts')).toBeNull();
    expect(await read('/etc/hostname')).toBeNull();
  });
});

describe('nativeCampaignRoundDeps', () => {
  it('refuses every live admission when no lock acquirer is wired', async () => {
    const deps = nativeCampaignRoundDeps({ ...scope, root: tmpdir() });
    const out = await deps.admission.acquire({ id: 'b1', targetFiles: ['src/a.ts'] }, 'cleanup');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.detail).toMatch(/no lock acquirer/);
  });

  it('admits on the edit path with a lock id that names it, when the edit-path acquirer is injected', async () => {
    const deps = nativeCampaignRoundDeps({ ...scope, root: tmpdir(), acquire: editPathAcquire });
    expect(await deps.admission.acquire({ id: 'pkg#1', targetFiles: ['src/a.ts'] }, 'cleanup'))
      .toEqual({ ok: true, lockId: 'edit-path:pkg#1' });
  });
});

describe('landedBatchesFromRows', () => {
  const record = (campaign: string, batchId: string, linesRemoved: number) =>
    ({ campaign, batchId, linesRemoved, attributedRedIds: [] });

  it('keeps only this campaign\'s well-formed records and attaches the ledger\'s edited files', () => {
    const rows = [
      { workItemId: 'WI-1', closedTs: 1, record: record('camp', 'pkg#1', 12) },
      { workItemId: 'WI-2', closedTs: 2, record: record('other', 'pkg#2', 5) },
      { workItemId: 'WI-3', closedTs: 3, record: { campaign: 'camp' } },
      { workItemId: 'WI-4', closedTs: 4, record: record('camp', 'pkg#4', 3) },
    ];
    const edited = new Map([['WI-1', ['b.ts', 'a.ts', 'a.ts']]]);
    expect(landedBatchesFromRows(rows, 'camp', edited)).toEqual([
      { batchId: 'pkg#1', workItemId: 'WI-1', linesRemoved: 12, editedFiles: ['a.ts', 'b.ts'] },
      { batchId: 'pkg#4', workItemId: 'WI-4', linesRemoved: 3, editedFiles: [] },
    ]);
  });
});

describe('gateRedsFromRows', () => {
  it('gives each red the files its coverage snapshots executed, plus the test file itself', () => {
    const reds = gateRedsFromRows(
      [{ id: 7, filePath: 't/a.test.ts', finishedAt: '2026-10-27T08:00:00.000Z' },
        { id: '8', filePath: 't/b.test.ts', finishedAt: new Date('2026-10-27T09:00:00.000Z') }],
      [{ testFile: 't/a.test.ts', sources: [{ path: 'src/x.ts' }, { path: 'src/y.ts' }] as never },
        { testFile: 't/a.test.ts', sources: [{ path: 'src/x.ts' }] as never }]);
    expect(reds).toEqual([
      { id: '7', testFile: 't/a.test.ts', at: new Date('2026-10-27T08:00:00.000Z'),
        affectedRadius: ['src/x.ts', 'src/y.ts', 't/a.test.ts'] },
      { id: '8', testFile: 't/b.test.ts', at: new Date('2026-10-27T09:00:00.000Z'), affectedRadius: ['t/b.test.ts'] },
    ]);
  });

  it('refuses a red with an unreadable finish time rather than dating it now', () => {
    expect(() => gateRedsFromRows([{ id: 1, filePath: 't.test.ts', finishedAt: 'not a date' }], [])).toThrow(/invalid finish time/);
  });
});
