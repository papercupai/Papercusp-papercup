import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { GATE_INVARIANT_NAMES, readGateInvariantWindow, evaluateGateInvariantWindow,
  GATE_INVARIANT_ACCEPTANCE_WINDOW_MS, GATE_INVARIANT_HEARTBEAT_MS, GATE_INVARIANT_LEASE_MS,
  recordGateLiveInvariants, evaluateGateInvariantAlarmWindow, type GateInvariantResult } from './gate-live-invariants';
import { readGreenMainRecoveryWindow, evaluateGreenMainRecoveryWindow, readGreenMainRepairRoundWindow, evaluateGreenMainRepairRoundWindow, evaluateGreenMainAdmissionWindow } from './green-main-slo';
import { buildGateRepairLatencyLedgerRow, deriveTickFreezeDisposition } from './freeze-disposition';

describe('historical invariant acceptance (real PG)', () => {
  let db: FreshPgDb;
  const start = Date.parse('2026-10-01T21:56:00Z');
  const window = { windowStartMs: start, windowEndMs: start + GATE_INVARIANT_ACCEPTANCE_WINDOW_MS };
  const scope = { workspaceId: 'acceptance-workspace', installSlug: 'acceptance-install' };
  beforeAll(async () => {
    db = await createFreshPgDb();
    await db.sql`CREATE TABLE harness_shared.pipeline_events (
      id bigserial PRIMARY KEY, workspace_id text NOT NULL, install_slug text NOT NULL,
      kind text NOT NULL, status text NOT NULL, detail jsonb NOT NULL, created_at timestamptz NOT NULL)`;
  }, 120_000);
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(async () => { await db.sql`DELETE FROM harness_shared.pipeline_events`; });

  async function insert(at: number, extra: { workspace?: string; install?: string; kind?: string; status?: string } = {}) {
    const detail = { results: GATE_INVARIANT_NAMES.map(name => ({ name, status: extra.status ?? 'pass', observed: 'original observation' })) };
    const rows = await db.sql`INSERT INTO harness_shared.pipeline_events
      (workspace_id, install_slug, kind, status, detail, created_at)
      VALUES (${extra.workspace ?? scope.workspaceId}, ${extra.install ?? scope.installSlug},
        ${extra.kind ?? 'gate_invariants'}, ${extra.status ?? 'pass'},
        ${JSON.stringify(detail)}::text::jsonb, ${new Date(at)}) RETURNING id::text`;
    return rows[0]!.id as string;
  }

  it('reads the exact predecessor and scoped window, preserving original identities', async () => {
    await insert(start - 2 * GATE_INVARIANT_HEARTBEAT_MS, { status: 'breach' });
    const expected = [];
    for (let i = 0; i <= 168; i++) expected.push(await insert(start + i * GATE_INVARIANT_HEARTBEAT_MS));
    await insert(start + 1, { workspace: 'foreign' });
    await insert(start + 1, { install: 'foreign' });
    await insert(start + 1, { kind: 'green_checkpoint' });
    await insert(window.windowEndMs + 1, { status: 'breach' });
    const history = await readGateInvariantWindow(db.sql, scope, window);
    expect(history).toMatchObject({ status: 'complete', total: 169 });
    expect(history.rows.map(row => row.id)).toEqual(expected);
    expect(evaluateGateInvariantWindow(history).assertions.every(assertion => assertion.passed)).toBe(true);
  });

  it('retains an interior unknown and reports a capped healthy prefix as incomplete', async () => {
    await insert(start);
    await insert(start + GATE_INVARIANT_HEARTBEAT_MS, { status: 'unknown' });
    await insert(start + 2 * GATE_INVARIANT_HEARTBEAT_MS);
    const all = await readGateInvariantWindow(db.sql, scope, window);
    expect(all.rows.map(row => row.status)).toEqual(['pass', 'unknown', 'pass']);
    expect(evaluateGateInvariantWindow(all).assertions.find(a => a.id === 'pass-only-invariant-history')!.passed).toBe(false);
    const capped = await readGateInvariantWindow(db.sql, scope, { ...window, maxRows: 1 });
    expect(capped).toMatchObject({ status: 'capped', total: 3 });
    expect(capped.rows).toHaveLength(1);
    expect(evaluateGateInvariantWindow(capped).assertions.every(assertion => assertion.passed)).toBe(false);
  });

  it('reads recovery from the preceding green, retaining boundary reds and exact scope (real PG)', async () => {
    const hour = GATE_INVARIANT_HEARTBEAT_MS;
    const recoveryWindow = { windowStartMs: start + 7 * hour, windowEndMs: start + 10 * hour };
    const add = async (at: number, status: string, workspace = scope.workspaceId) => {
      const detail = { gateFireId: `fire-${at}`, runId: `run-${at}`, candidate: 'a'.repeat(40) };
      const rows = await db.sql`INSERT INTO harness_shared.pipeline_events
        (workspace_id, install_slug, kind, status, detail, created_at)
        VALUES (${workspace}, ${scope.installSlug}, 'green_checkpoint', ${status},
          ${JSON.stringify(detail)}::text::jsonb, ${new Date(at)}) RETURNING id::text`;
      return rows[0]!.id as string;
    };
    await add(start - hour, 'advanced');
    const expected = [await add(start, 'advanced'), await add(start + hour, 'not-green'),
      await add(start + 6 * hour, 'not-green'), await add(start + 10 * hour, 'up-to-date')];
    await add(start + 8 * hour, 'advanced', 'foreign');
    await add(recoveryWindow.windowEndMs + 1, 'not-green');
    await insert(start + 8 * hour);
    const history = await readGreenMainRecoveryWindow(db.sql, scope, recoveryWindow);
    expect(history).toMatchObject({ status: 'complete', total: 4 });
    expect(history.rows.map(row => row.id)).toEqual(expected);
    const result = evaluateGreenMainRecoveryWindow(history, recoveryWindow.windowEndMs);
    expect(result.episodes[0]!.durationMs).toBe(9 * hour);
    expect(result.assertions.find(a => a.id === 'recovery-p90-at-most-8h')!.passed).toBe(false);
    expect(await readGreenMainRecoveryWindow(db.sql, scope, { ...recoveryWindow, maxRows: 1 }))
      .toMatchObject({ status: 'capped', total: 4 });
  });

  it('fails closed for an empty recovery ledger and invalid scope (real PG)', async () => {
    const history = await readGreenMainRecoveryWindow(db.sql, scope, window);
    expect(history).toMatchObject({ status: 'complete', total: 0, rows: [] });
    expect(evaluateGreenMainRecoveryWindow(history).assertions.every(a => a.passed)).toBe(false);
    expect(await readGreenMainRecoveryWindow(db.sql, { ...scope, workspaceId: '' }, window))
      .toMatchObject({ status: 'invalid', total: null });
  });

  it('retains a red written after the predecessor green at the same timestamp (real PG)', async () => {
    for (const [i, status] of ['advanced', 'not-green'].entries()) {
      await db.sql`INSERT INTO harness_shared.pipeline_events
        (workspace_id, install_slug, kind, status, detail, created_at)
        VALUES (${scope.workspaceId}, ${scope.installSlug}, 'green_checkpoint', ${status},
          ${JSON.stringify({ gateFireId: `same-clock-${i}` })}::text::jsonb, ${new Date(start)})`;
    }
    const history = await readGreenMainRecoveryWindow(db.sql, scope, window);
    expect(history.rows.map(row => row.status)).toEqual(['advanced', 'not-green']);
    expect(evaluateGreenMainRecoveryWindow(history).assertions.find(a => a.id === 'all-red-episodes-closed')!.passed).toBe(false);
  });

  it('reads original repair snapshots with exact scope, boundary, population and cap (real PG)', async () => {
    const add = async (at: number, workspace = scope.workspaceId, install = scope.installSlug, kind = 'green_checkpoint_repair_latency') => {
      const detail = { candidate: 'a'.repeat(40), observedAtMs: at,
        repairLatency: { stamps: { openedAtMs: start - 60_000 } },
        repairProgress: { phase: 'awaiting-fixer', rounds: [
          { round: 1, head: 'a'.repeat(40), atMs: start - 60_000 }, { round: 2, head: 'b'.repeat(40), atMs: start },
        ] } };
      const rows = await db.sql`INSERT INTO harness_shared.pipeline_events
        (workspace_id, install_slug, kind, status, detail, created_at)
        VALUES (${workspace}, ${install}, ${kind}, 'converging',
          ${JSON.stringify(detail)}::text::jsonb, ${new Date(at)}) RETURNING id::text`;
      return rows[0]!.id as string;
    };
    await add(start - 1);
    const expected = [await add(start), await add(start + 1)];
    await add(start + 1, 'foreign'); await add(start + 1, scope.workspaceId, 'foreign');
    await add(start + 1, scope.workspaceId, scope.installSlug, 'green_checkpoint');
    await add(window.windowEndMs + 1);
    const history = await readGreenMainRepairRoundWindow(db.sql, scope, window);
    expect(history).toMatchObject({ status: 'complete', total: 2 });
    expect(history.rows.map(row => row.id)).toEqual(expected);
    expect(evaluateGreenMainRepairRoundWindow(history, window.windowEndMs).assertions.every(a => a.passed)).toBe(true);
    const capped = await readGreenMainRepairRoundWindow(db.sql, scope, { ...window, maxRows: 1 });
    expect(capped).toMatchObject({ status: 'capped', total: 2 });
    expect(evaluateGreenMainRepairRoundWindow(capped, window.windowEndMs).assertions.every(a => a.passed)).toBe(false);
    expect(await readGreenMainRepairRoundWindow(db.sql, { ...scope, workspaceId: '' }, window)).toMatchObject({ status: 'invalid' });
  });

  it('retains the original admission population and pending work beyond queue retirement (real PG)', async () => {
    const end = start + 60 * 60_000;
    const heads = ['a', 'b', 'c', 'd', 'e', 'f'].map(c => c.repeat(40));
    const queue = { candidate: heads[0]!, repairHead: heads[5]!, openedAtMs: start, phase: 'awaiting-fixer' as const,
      convergenceRounds: heads.map((head, i) => ({ head, round: i + 1, atMs: start + i * 10 * 60_000, failingCount: 1 })),
      admissions: heads.slice(1).map((head, i) => ({ fromRepairHead: heads[i]!, toRepairHead: head,
        atMs: start + i * 10 * 60_000 + 60_000, actor: 'original-agent', source: { ref: 'staging', sha: head },
        paths: ['original.ts'], unchanged: [], blobs: { 'original.ts': 'original-blob' } })),
    };
    const add = async (row: NonNullable<ReturnType<typeof buildGateRepairLatencyLedgerRow>>, workspace = scope.workspaceId) => {
      const ids = await db.sql`INSERT INTO harness_shared.pipeline_events
        (workspace_id, install_slug, kind, status, detail, created_at)
        VALUES (${workspace}, ${scope.installSlug}, 'green_checkpoint_repair_latency', ${row.status},
          ${JSON.stringify(row.detail)}::text::jsonb, ${new Date(end)}) RETURNING id::text`;
      return ids[0]!.id as string;
    };
    const disposition = deriveTickFreezeDisposition({ flagEnabled: true, repairQueue: queue, nowMs: end });
    const snapshot = buildGateRepairLatencyLedgerRow(disposition, end)!;
    const expected = await add(snapshot);
    await add(snapshot, 'foreign');
    const w = { windowStartMs: start, windowEndMs: end };
    const history = await readGreenMainRepairRoundWindow(db.sql, scope, w);
    expect(history.rows.map(row => row.id)).toEqual([expected]);
    expect(evaluateGreenMainAdmissionWindow(history, end).assertions.every(a => a.passed)).toBe(true);
    await db.sql`DELETE FROM harness_shared.pipeline_events`;
    queue.convergenceRounds = queue.convergenceRounds.slice(0, 1);
    const pending = deriveTickFreezeDisposition({ flagEnabled: true, repairQueue: queue, nowMs: end });
    await add(buildGateRepairLatencyLedgerRow({ ...pending, state: 'retired' }, end)!);
    const retired = await readGreenMainRepairRoundWindow(db.sql, scope, w);
    const evaluation = evaluateGreenMainAdmissionWindow(retired, end);
    expect(evaluation.admissions).toHaveLength(5);
    expect(evaluation.admissions.every(a => a.pending)).toBe(true);
    expect(evaluation.assertions.find(a => a.id === 'admission-rounds-at-most-45min')!.passed).toBe(false);
    expect(evaluation.assertions.find(a => a.id === 'all-admission-rounds-have-verdicts')!.passed).toBe(false);
  });

  it('keeps absence and read failure distinct and refuses an invalid scope before querying', async () => {
    expect(await readGateInvariantWindow(db.sql, scope, window)).toMatchObject({ status: 'complete', total: 0, rows: [] });
    expect(await readGateInvariantWindow(db.sql, { ...scope, workspaceId: '' }, window)).toMatchObject({ status: 'invalid', total: null });
    await db.sql`DROP TABLE harness_shared.pipeline_events`;
    try {
      expect(await readGateInvariantWindow(db.sql, scope, window)).toMatchObject({ status: 'unavailable', total: null, rows: [] });
      expect(await readGreenMainRepairRoundWindow(db.sql, scope, window)).toMatchObject({ status: 'unavailable', total: null, rows: [] });
    } finally {
      await db.sql`CREATE TABLE harness_shared.pipeline_events (
        id bigserial PRIMARY KEY, workspace_id text NOT NULL, install_slug text NOT NULL,
        kind text NOT NULL, status text NOT NULL, detail jsonb NOT NULL, created_at timestamptz NOT NULL)`;
    }
  });
});

describe('invariant breach delivery (real PG)', () => {
  let db: FreshPgDb;
  const start = Date.parse('2026-10-01T21:56:00Z');
  const scope = { workspaceId: 'alarm-workspace', installSlug: 'alarm-install' };
  const breach: GateInvariantResult = { name: 'no-verdict-rate', status: 'breach', observed: 'three failed verdicts' };
  const pass: GateInvariantResult = { ...breach, status: 'pass', observed: 'verdicts recovered' };
  beforeAll(async () => {
    db = await createFreshPgDb();
    await db.sql`CREATE TABLE harness_shared.routines (
      workspace_id text NOT NULL, install_slug text NOT NULL, name text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}', PRIMARY KEY (workspace_id, install_slug, name))`;
    await db.sql`CREATE TABLE harness_shared.pipeline_events (
      id bigserial PRIMARY KEY, workspace_id text NOT NULL, install_slug text NOT NULL,
      kind text NOT NULL, status text NOT NULL, detail jsonb NOT NULL, created_at timestamptz NOT NULL)`;
  }, 120_000);
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(async () => {
    await db.sql`DELETE FROM harness_shared.routines`;
    await db.sql`DELETE FROM harness_shared.pipeline_events`;
    await db.sql`INSERT INTO harness_shared.routines (workspace_id, install_slug, name)
      VALUES (${scope.workspaceId}, ${scope.installSlug}, 'green-checkpoint')`;
  });
  const record = (nowMs: number, results: GateInvariantResult[], fileBreach: (result: GateInvariantResult) => Promise<string | null>) =>
    recordGateLiveInvariants({ sql: db.sql, ...scope, nowMs, results, fileBreach, appendEvent: async () => {} });
  const entry = async () => {
    const rows = await db.sql`SELECT metadata->'gate_invariants'->'invariants'->'no-verdict-rate' AS entry
      FROM harness_shared.routines WHERE workspace_id = ${scope.workspaceId} AND install_slug = ${scope.installSlug}`;
    return rows[0]!.entry;
  };

  it.each(['throw', 'null'] as const)('retries an unchanged breach after a %s filing failure, then deduplicates', async failure => {
    let calls = 0;
    const file = async () => {
      calls++;
      if (calls === 1) {
        if (failure === 'throw') throw new Error('condition store unavailable');
        return null;
      }
      return 'WI-alarm';
    };
    expect(await record(start, [breach], file)).toMatchObject({ recorded: true, filed: [] });
    expect(await entry()).toMatchObject({ status: 'breach', sinceMs: start, evaluations: 1 });
    expect(await record(start + GATE_INVARIANT_LEASE_MS - 1, [breach], file)).toMatchObject({ recorded: false });
    expect(calls).toBe(1);
    expect(await record(start + GATE_INVARIANT_LEASE_MS, [breach], file))
      .toMatchObject({ recorded: true, transitions: [], filed: [{ name: breach.name, id: 'WI-alarm' }] });
    expect(await entry()).toMatchObject({ status: 'breach', sinceMs: start, evaluations: 2, filedItemId: 'WI-alarm' });
    await record(start + 2 * GATE_INVARIANT_LEASE_MS, [breach], file);
    expect(calls).toBe(2);
  });

  it('does not file recovered or unknown results, and permits a new breach episode', async () => {
    let calls = 0;
    const file = async () => `WI-${++calls}`;
    await record(start, [breach], file);
    await record(start + GATE_INVARIANT_LEASE_MS, [pass], file);
    await record(start + 2 * GATE_INVARIANT_LEASE_MS, [{ ...pass, status: 'unknown' }], file);
    expect(calls).toBe(1);
    expect(await record(start + 3 * GATE_INVARIANT_LEASE_MS, [breach], file))
      .toMatchObject({ filed: [{ name: breach.name, id: 'WI-2' }] });
    expect(await entry()).toMatchObject({ sinceMs: start + 3 * GATE_INVARIANT_LEASE_MS, filedItemId: 'WI-2' });
  });

  it('appends the successful retry receipt even without a status transition or heartbeat', async () => {
    await record(start, [breach], async () => null);
    const events: { status: string; detail: Record<string, unknown> }[] = [];
    const outcome = await recordGateLiveInvariants({ sql: db.sql, ...scope,
      nowMs: start + GATE_INVARIANT_LEASE_MS, results: [breach], fileBreach: async () => 'WI-retry',
      appendEvent: async (status, detail) => { events.push({ status, detail }); } });
    expect(outcome).toMatchObject({ transitions: [], emitted: true });
    expect(events).toMatchObject([{ status: 'breach', detail: { evaluatedAtMs: start + GATE_INVARIANT_LEASE_MS, results: [breach], transitions: [],
      filed: [{ name: breach.name, id: 'WI-retry' }] } }]);
  });

  it('records the actual awaited filing clock while retaining the original breach tick (real PG)', async () => {
    let clock = start;
    const events: Record<string, unknown>[] = [];
    const appendEvent = async (_status: unknown, detail: Record<string, unknown>) => { events.push(detail); };
    await recordGateLiveInvariants({ sql: db.sql, ...scope, nowMs: start, alarmTickMs: GATE_INVARIANT_LEASE_MS,
      clockMs: () => clock, results: [breach], fileBreach: async () => null, appendEvent });
    clock = start + GATE_INVARIANT_LEASE_MS;
    await recordGateLiveInvariants({ sql: db.sql, ...scope, nowMs: clock, alarmTickMs: 10 * GATE_INVARIANT_LEASE_MS,
      clockMs: () => clock, results: [breach], fileBreach: async () => { clock += 7; return 'WI-timed'; }, appendEvent });
    expect(await entry()).toMatchObject({ sinceMs: start, alarmTickMs: GATE_INVARIANT_LEASE_MS,
      filedAtMs: start + GATE_INVARIANT_LEASE_MS + 7, filedItemId: 'WI-timed' });
    expect(events.at(-1)).toMatchObject({ alarmEpisodes: { version: 1, entries: [{ name: breach.name,
      sinceMs: start, tickMs: GATE_INVARIANT_LEASE_MS, filedAtMs: clock, filedItemId: 'WI-timed' }] } });
    expect(events[0]).toMatchObject({ alarmEpisodes: { entries: [{ filedItemId: null, filedAtMs: null }] } });
  });

  it.each([0, 1])('judges original persisted retry completion at deadline +%ims, rather than its start (real PG)', async delayMs => {
    let clock = start;
    const results = (breached: boolean): GateInvariantResult[] => GATE_INVARIANT_NAMES.map(name =>
      ({ name, status: name === breach.name && breached ? 'breach' : 'pass', observed: 'original evaluation' }));
    const appendEvent = async (status: string, detail: Record<string, unknown>, tx: typeof db.sql) => {
      await tx`INSERT INTO harness_shared.pipeline_events
        (workspace_id, install_slug, kind, status, detail, created_at)
        VALUES (${scope.workspaceId}, ${scope.installSlug}, 'gate_invariants', ${status},
          ${JSON.stringify(detail)}::text::jsonb, ${new Date(clock)})`;
    };
    await recordGateLiveInvariants({ sql: db.sql, ...scope, nowMs: clock, results: results(true),
      alarmTickMs: GATE_INVARIANT_LEASE_MS, clockMs: () => clock, fileBreach: async () => null, appendEvent });
    clock += GATE_INVARIANT_LEASE_MS;
    await recordGateLiveInvariants({ sql: db.sql, ...scope, nowMs: clock, results: results(true),
      alarmTickMs: 2 * GATE_INVARIANT_LEASE_MS, clockMs: () => clock,
      fileBreach: async () => { clock += delayMs; return 'WI-original-receipt'; }, appendEvent });
    clock += GATE_INVARIANT_LEASE_MS;
    await recordGateLiveInvariants({ sql: db.sql, ...scope, nowMs: clock, results: results(false),
      alarmTickMs: GATE_INVARIANT_LEASE_MS, clockMs: () => clock,
      fileBreach: async () => { throw new Error('pass must not file'); }, appendEvent });
    const history = await readGateInvariantWindow(db.sql, scope, { windowStartMs: start, windowEndMs: clock });
    expect(history).toMatchObject({ status: 'complete', total: 3 });
    const evaluation = evaluateGateInvariantAlarmWindow(history, clock);
    expect(evaluation.assertions.find(a => a.id === 'original-invariant-breach-filing-receipts')!.passed).toBe(true);
    expect(evaluation.assertions.find(a => a.id === 'invariant-breach-filings-within-one-tick')!.passed).toBe(delayMs === 0);
    expect(evaluation.episodes).toEqual([{ name: breach.name, sinceMs: start, tickMs: GATE_INVARIANT_LEASE_MS,
      filedAtMs: start + GATE_INVARIANT_LEASE_MS + delayMs, filedItemId: 'WI-original-receipt' }]);
  });

  it('rolls back a failed required history append so the next unchanged observation retries', async () => {
    const events: Record<string, unknown>[] = [];
    const appendEvent = async (_status: unknown, detail: Record<string, unknown>) => {
      throw new Error('history store unavailable');
    };
    const attempt = recordGateLiveInvariants({ sql: db.sql, ...scope, nowMs: start,
      results: [breach], fileBreach: async () => 'WI-history', appendEvent });
    await expect(attempt).rejects.toThrow('history store unavailable');
    expect(await entry()).toBeNull();
    const retry = await recordGateLiveInvariants({ sql: db.sql, ...scope, nowMs: start + GATE_INVARIANT_LEASE_MS,
      results: [breach], fileBreach: async () => 'WI-history',
      appendEvent: async (_status, detail) => { events.push(detail); } });
    expect(retry).toMatchObject({ recorded: true, emitted: true });
    expect(events[0]).toMatchObject({ transitions: [{ name: breach.name, from: null, to: 'breach' }] });
    expect(await entry()).toMatchObject({ status: 'breach', sinceMs: start + GATE_INVARIANT_LEASE_MS });
  });

  it('does not store a filed id when its delivery history receipt fails, then retries the same condition', async () => {
    await record(start, [breach], async () => null);
    let calls = 0;
    const fileBreach = async () => { calls++; return 'WI-existing-condition'; };
    await expect(recordGateLiveInvariants({ sql: db.sql, ...scope, nowMs: start + GATE_INVARIANT_LEASE_MS,
      results: [breach], fileBreach, appendEvent: async () => { throw new Error('receipt unavailable'); } }))
      .rejects.toThrow('receipt unavailable');
    expect(await entry()).toMatchObject({ status: 'breach', sinceMs: start });
    expect((await entry()).filedItemId).toBeUndefined();
    const retry = await record(start + 2 * GATE_INVARIANT_LEASE_MS, [breach], fileBreach);
    expect(retry).toMatchObject({ emitted: true, filed: [{ name: breach.name, id: 'WI-existing-condition' }] });
    expect(calls).toBe(2);
    expect(await entry()).toMatchObject({ sinceMs: start, filedItemId: 'WI-existing-condition' });
  });

  it('serializes two hosts at the same lease boundary into one retry', async () => {
    await record(start, [breach], async () => null);
    let calls = 0;
    const file = async () => { calls++; return 'WI-concurrent'; };
    const outcomes = await Promise.all([record(start + GATE_INVARIANT_LEASE_MS, [breach], file),
      record(start + GATE_INVARIANT_LEASE_MS, [breach], file)]);
    expect(outcomes.filter(outcome => outcome.recorded)).toHaveLength(1);
    expect(calls).toBe(1);
    expect(await entry()).toMatchObject({ sinceMs: start, filedItemId: 'WI-concurrent' });
  });

  it('a delayed filing receipt cannot overwrite a newer recovered state', async () => {
    let started!: () => void;
    const pending = new Promise<void>(resolve => { started = resolve; });
    let finish!: (id: string) => void;
    const receipt = new Promise<string>(resolve => { finish = resolve; });
    const first = record(start, [breach], async () => { started(); return receipt; });
    await pending;
    await record(start + GATE_INVARIANT_LEASE_MS, [pass], async () => { throw new Error('must not file pass'); });
    finish('WI-late');
    await first;
    expect(await entry()).toMatchObject({ status: 'pass', sinceMs: start + GATE_INVARIANT_LEASE_MS });
    expect((await entry()).filedItemId).toBeUndefined();
  });
});
