import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  clock: 0, unchangedPath: '', unchangedSize: 0, failInsert: false,
  failOwners: false,
  ownerParams: [] as string[][],
  queries: [] as string[],
  statePaths: [] as string[][],
  flagWait: null as Promise<void> | null,
  ownerWait: null as Promise<void> | null,
  ownerEntered: null as (() => void) | null,
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  const sql = Object.assign((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
    if (!('raw' in strings)) return { rows: strings };
    const query = strings.join('?');
    probe.queries.push(query);
    probe.clock += 7; // deterministic completed-query wall cost
    if (query.includes('INSERT INTO harness_shared.session_turns ')) {
      if (probe.failInsert) return Promise.reject(new Error('injected turn insert failure'));
      return Promise.resolve(Object.assign([], { count: 1 }));
    }
    if (query.includes('UPDATE harness_shared.session_turns AS turns')) {
      probe.ownerParams = values.slice(0, 2) as string[][];
      if (probe.failOwners) return Promise.reject(new Error('injected owner backfill failure'));
      probe.ownerEntered?.();
      if (probe.ownerWait) return probe.ownerWait.then(() => Object.assign([], { count: 3 }));
      return Promise.resolve(Object.assign([], { count: 3 }));
    }
    if (query.includes('UPDATE harness_shared.adv_sessions AS sessions')) {
      return Promise.resolve([{ id: 4242 }]);
    }
    if (query.includes('FROM harness_shared.session_ingest_state') &&
        query.includes('last_inference_id') && !query.includes('LIMIT')) {
      if (query.includes('file_path = ANY')) probe.statePaths.push(values[1] as string[]);
      return Promise.resolve([{
        file_path: probe.unchangedPath, byte_offset: probe.unchangedSize,
        turn_count: 1, part_count: 1, prompt_count: 1, response_count: 0,
        tool_call_count: 0, last_inference_id: null,
        counts_backfill_offset: probe.unchangedSize,
        counts_backfill_last_inference_id: null, counts_backfilled_at: '2026-09-30',
      }]);
    }
    return Promise.resolve([]);
  }, {
    array: (values: unknown[]) => values,
    begin: async <T>(fn: (tx: unknown) => Promise<T>) => fn(sql),
  });
  return { ...actual, getOrgPg: () => ({ sql }) };
});
vi.mock('@papercusp/flags/server', () => ({
  getFlag: async () => { if (probe.flagWait) await probe.flagWait; probe.clock += 2; return true; },
}));
vi.mock('../bash-substitution/registry', () => ({
  getSubstitutionRows: async () => { probe.clock += 3; return []; },
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'phase-test' }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]).endsWith('config.toml')) probe.clock += 3;
    return fs.readFileSync(...args);
  } };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs,
    stat: async (...args: Parameters<typeof fs.stat>) => { probe.clock += 5; return fs.stat(...args); },
    open: async (...args: Parameters<typeof fs.open>) => { probe.clock += 11; return fs.open(...args); },
  };
});

import { FILE_ADAPTERS, runSessionIngestOnce, sessionIngestLogLine } from './session-ingest';

const adapters = [...FILE_ADAPTERS];
let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'session-ingest-phases-'));
  const home = join(root, 'su-codex-homes', 'session-4242');
  const day = join(home, 'sessions', '2026', '09', '30');
  await mkdir(day, { recursive: true });
  await writeFile(join(home, 'config.toml'), 'model = "gpt-6.1-sol"\n');
  await writeFile(join(home, 'papercusp-diagnostics.json'), '{"lockOwnerSid":"phase-owner"}');
  const line = JSON.stringify({ type: 'response_item', timestamp: '2026-09-30T00:00:00Z',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'measure this useful turn' }] },
  }) + '\n';
  const file = (id: string) => join(day, `rollout-2026-09-30T00-00-00-${id}.jsonl`);
  probe.unchangedPath = file('019f4fa9-4a09-78c0-8a35-d7e3382d1f8f');
  probe.unchangedSize = Buffer.byteLength(line);
  await writeFile(probe.unchangedPath, line);
  await writeFile(file('019f4fa9-4a09-78c0-8a35-d7e3382d1f80'), line);
  const codex = adapters.find((adapter) => adapter.sourceKind === 'codex')!;
  FILE_ADAPTERS.splice(0, FILE_ADAPTERS.length, { ...codex, roots: () => [{ root: day, dirDepth: 0 }] });
  probe.clock = 0;
  probe.queries = [];
  probe.statePaths = [];
  probe.failInsert = false;
  probe.failOwners = false;
  probe.ownerParams = [];
  probe.flagWait = null;
  probe.ownerWait = null;
  probe.ownerEntered = null;
  vi.spyOn(performance, 'now').mockImplementation(() => probe.clock);
});

afterEach(async () => {
  vi.restoreAllMocks();
  FILE_ADAPTERS.splice(0, FILE_ADAPTERS.length, ...adapters);
  await rm(root, { recursive: true, force: true });
});

describe('ingestion phase attribution', () => {
  it('reports a pending setup await through the existing single-flight tick without claiming ingestion progress', async () => {
    let release!: () => void;
    probe.flagWait = new Promise<void>((resolve) => { release = resolve; });
    const running = runSessionIngestOnce();
    try {
      probe.clock = 6500;
      const skipped = await runSessionIngestOnce();
      expect(skipped).toMatchObject({ skipped: 'already_running', filesIngested: 0, turnsInserted: 0,
        activeSweep: { phase: 'setup', elapsedMs: 6500, phaseElapsedMs: 6500 } });
      expect(sessionIngestLogLine(skipped)).toContain('still running');
      expect(sessionIngestLogLine(skipped)).toContain('"phase":"setup"');
      expect(sessionIngestLogLine(skipped)).not.toContain('+0 turn(s)');
      expect(sessionIngestLogLine({ ...skipped,
        activeSweep: { ...skipped.activeSweep!, elapsedMs: 4999 } })).toBeNull();
    } finally { release(); await running; probe.flagWait = null; }
    expect((await runSessionIngestOnce()).skipped).toBeUndefined();
  });

  it('identifies a blocked adapter repair and clears its phase when the sweep finishes', async () => {
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { probe.ownerEntered = resolve; });
    probe.ownerWait = new Promise<void>((resolve) => { release = resolve; });
    const running = runSessionIngestOnce();
    try {
      await entered;
      probe.clock += 6500;
      const skipped = await runSessionIngestOnce();
      expect(skipped.activeSweep).toMatchObject({ phase: 'metadataBackfill', sourceKind: 'codex',
        operation: 'sessionOwners', phaseElapsedMs: 6507 });
      const line = sessionIngestLogLine(skipped)!;
      expect(line).toContain('"sourceKind":"codex"');
      expect(line).toContain('"operation":"sessionOwners"');
      expect(line).not.toContain(root);
      expect(line).not.toContain('phase-owner');
    } finally { release(); await running; probe.ownerWait = null; probe.ownerEntered = null; }
    const next = await runSessionIngestOnce();
    expect(next.skipped).toBeUndefined();
    expect(next.activeSweep).toBeUndefined();
  });

  it('loads cursor state only for discovered files while preserving unchanged-file offsets', async () => {
    const stats = await runSessionIngestOnce();
    expect(probe.statePaths).toHaveLength(1);
    expect(new Set(probe.statePaths[0])).toEqual(new Set([
      probe.unchangedPath,
      probe.unchangedPath.replace('019f4fa9-4a09-78c0-8a35-d7e3382d1f8f', '019f4fa9-4a09-78c0-8a35-d7e3382d1f80'),
    ]));
    expect(stats.filesScanned).toBe(2);
    expect(stats.filesIngested).toBe(1);
    expect(stats.turnsInserted).toBe(1);
    expect(probe.queries.filter(q => q.includes('INSERT INTO harness_shared.session_ingest_state'))).toHaveLength(1);
  });

  it('does not fetch historical cursor state when an adapter discovers no files', async () => {
    const codex = FILE_ADAPTERS[0];
    FILE_ADAPTERS.splice(0, FILE_ADAPTERS.length, {
      ...codex, roots: () => [{ root: join(root, 'no-sessions'), dirDepth: 0 }],
    });
    const stats = await runSessionIngestOnce();
    expect(stats.errors).toBe(0);
    expect(stats.filesScanned).toBe(0);
    expect(stats.phaseMs!.state).toBe(0);
    expect(probe.queries.some(q => q.includes('FROM harness_shared.session_ingest_state') &&
      q.includes('last_inference_id') && !q.includes('LIMIT'))).toBe(false);
  });

  it('separates discovery, unchanged metadata, decoding and writes without rereading unchanged bytes', async () => {
    const stats = await runSessionIngestOnce();
    expect(stats.errors).toBe(0);
    expect(stats.filesScanned).toBe(2);
    expect(stats.filesIngested).toBe(1);
    expect(stats.turnsInserted).toBe(1);
    // The two distinct rollouts share one managed home: only the selected
    // rollout contributes config metadata, at the real reader's injected cost.
    expect(stats.phaseMs).toMatchObject({ setup: 5, discovery: 10, metadata: 3, decode: 11, state: 7 });
    expect(stats.phaseMs!.writes).toBeGreaterThanOrEqual(21);
    expect(stats.phaseMs!.metadataBackfill).toBeGreaterThan(0);
    expect(stats.metadataBackfills).toEqual([
      { sourceKind: 'codex', operation: 'sessionOwners', requested: 2, updated: 3,
        inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        startedAtMs: expect.any(Number), durationMs: 7, status: 'completed' },
      { sourceKind: 'codex', operation: 'codexAdvSessions', requested: 1, updated: 1,
        startedAtMs: expect.any(Number), durationMs: 7, status: 'completed' },
    ]);
    expect(Object.values(stats.phaseMs!).reduce((sum, ms) => sum + ms, 0)).toBe(stats.durationMs);
    expect(probe.queries.filter((q) => q.includes('INSERT INTO harness_shared.session_ingest_state'))).toHaveLength(1);
  });

  it('reports an owner repair failure without losing successful ingestion or preventing the next repair', async () => {
    probe.failOwners = true;
    const failed = await runSessionIngestOnce();
    expect(failed.errors).toBe(1);
    expect(failed.turnsInserted).toBe(1);
    expect(failed.filesIngested).toBe(1);
    expect(failed.errorSample).toContain('codex owner backfill: injected owner backfill failure');
    expect(failed.metadataBackfills).toEqual([
      { sourceKind: 'codex', operation: 'sessionOwners', requested: 2,
        inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        startedAtMs: expect.any(Number), durationMs: 7, status: 'failed' },
      { sourceKind: 'codex', operation: 'codexAdvSessions', requested: 1, updated: 1,
        startedAtMs: expect.any(Number), durationMs: 7, status: 'completed' },
    ]);
    expect(sessionIngestLogLine(failed)).toContain(`metadataBackfills=${JSON.stringify(failed.metadataBackfills)}`);
    probe.failOwners = false;
    const retried = await runSessionIngestOnce();
    expect(retried.skipped).toBeUndefined();
    expect(retried.errors).toBe(0);
    expect(retried.metadataBackfills?.[0]).toMatchObject({ updated: 3, status: 'completed' });
    expect(retried.metadataBackfills?.[0].inputSha256).toBe(failed.metadataBackfills?.[0].inputSha256);
  });

  it('fingerprints the exact bound owner inputs and distinguishes changed owners at equal cardinality', async () => {
    const fingerprint = () => createHash('sha256').update(JSON.stringify(probe.ownerParams)).digest('hex');
    const initial = await runSessionIngestOnce();
    const initialHash = initial.metadataBackfills![0].inputSha256;
    expect(initialHash).toBe(fingerprint());
    expect(probe.ownerParams[0]).toHaveLength(2);
    const queryCount = probe.queries.filter(q => q.includes('UPDATE harness_shared.session_turns AS turns')).length;
    expect(queryCount).toBe(1);
    const line = sessionIngestLogLine(initial)!;
    expect(line).toContain(initialHash);
    expect(line).not.toContain('phase-owner');
    for (const sessionId of probe.ownerParams[0]) expect(line).not.toContain(sessionId);

    await writeFile(join(root, 'su-codex-homes', 'session-4242', 'papercusp-diagnostics.json'),
      '{"lockOwnerSid":"changed-phase-owner"}');
    const changed = await runSessionIngestOnce();
    expect(changed.metadataBackfills![0].requested).toBe(initial.metadataBackfills![0].requested);
    expect(changed.metadataBackfills![0].inputSha256).toBe(fingerprint());
    expect(changed.metadataBackfills![0].inputSha256).not.toBe(initialHash);
    expect(changed.metadataBackfills![1]).not.toHaveProperty('inputSha256');
  });

  it('retains failed-write time while preserving the failed file offset and releasing the sweep latch', async () => {
    probe.failInsert = true;
    const failed = await runSessionIngestOnce();
    expect(failed.errors).toBe(1);
    expect(failed.filesIngested).toBe(0);
    expect(failed.phaseMs!.writes).toBe(21); // failed insert and both error-bookkeeping writes
    expect(probe.queries.some((q) => q.includes('INSERT INTO harness_shared.session_ingest_state'))).toBe(false);
    probe.failInsert = false;
    const retried = await runSessionIngestOnce();
    expect(retried.skipped).toBeUndefined();
    expect(retried.filesIngested).toBe(1);
    expect(retried.turnsInserted).toBe(1);
  });

  it('logs phase evidence for slow empty passes and faithful-parts-only progress, but suppresses skipped passes', async () => {
    const stats = await runSessionIngestOnce();
    const empty = { ...stats, turnsInserted: 0, partsInserted: 0, errors: 0, filesIngested: 0, durationMs: 5000 };
    expect(sessionIngestLogLine(empty)).toContain(`phases=${JSON.stringify(stats.phaseMs)}`);
    expect(sessionIngestLogLine(empty)).toContain(`metadataBackfills=${JSON.stringify(stats.metadataBackfills)}`);
    expect(sessionIngestLogLine({ ...empty, durationMs: 4999 })).toBeNull();
    expect(sessionIngestLogLine({ ...empty, durationMs: 1, partsInserted: 1 })).toContain('+1 part(s)');
    expect(sessionIngestLogLine({ ...empty, skipped: 'already_running' })).toBeNull();
  });
});
