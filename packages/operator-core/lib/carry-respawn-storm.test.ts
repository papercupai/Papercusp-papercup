/**
 * carry-respawn-storm.test.ts — WI-10002530: the managed carry-respawn storm
 * breaker. The classifier is replayed against the measured su-cfa16b20 storm
 * (2026-09-23: 14 queued cuts, 00:14:38Z→00:25:15Z, zero agent-origin calls in
 * between) so the rule is pinned to the incident it exists to catch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openEscalation = vi.hoisted(() => vi.fn());
const readOwnerHostEvents = vi.hoisted(() => vi.fn(async (): Promise<Array<{
  ts: string; kind: string; mode?: string;
}>> => []));
vi.mock('./cold-boot-drill-live', () => ({ readOwnerHostEvents }));
vi.mock('./agent-tools/coordination/escalations', () => ({
  openEscalation: (...a: unknown[]) => openEscalation(...a),
}));

import {
  classifyRespawnStorm,
  detectRespawnStorm,
  escalateRespawnStorm,
  respawnStormAlertText,
  REQUEST_COMPACTION_TOOL,
  RESPAWN_STORM_DEDUP_KIND,
  RESPAWN_STORM_ERROR,
  RESPAWN_STORM_WINDOW_MS,
  type StormLedgerRow,
} from './carry-respawn-storm';

const at = (hms: string) => Date.parse(`2026-09-23T${hms}Z`);
const cut = (hms: string, status = 'ok', errorCode: string | null = null): StormLedgerRow => ({
  invokedAtMs: at(hms),
  toolName: REQUEST_COMPACTION_TOOL,
  status,
  callOrigin: 'agent',
  errorCode,
});
const call = (hms: string, toolName: string, callOrigin: string | null): StormLedgerRow => ({
  invokedAtMs: at(hms),
  toolName,
  status: 'ok',
  callOrigin,
  errorCode: null,
});

// The measured prefix of the su-cfa16b20 storm (tool_invocations, coord_owner_id).
const STORM_PREFIX: StormLedgerRow[] = [
  call('00:14:22', 'tools:find', 'agent'),
  call('00:14:23', 'activity:report', 'hook'),
  call('00:14:36', 'work_items:release', 'agent'), // the last REAL turn
  call('00:14:36', 'plan_items:release', 'unknown'),
  call('00:14:37', 'plans:set-status', 'unknown'),
  cut('00:14:38'),
  cut('00:15:19'),
];

describe('classifyRespawnStorm', () => {
  const host = (hms: string, kind: string, reason?: string, mode = 'carry-respawn') => ({
    ts: new Date(at(hms)).toISOString(), kind, mode, reason,
  });

  it('does not turn failed route provisioning into a respawn storm or retain its false latch', () => {
    const rows = [...STORM_PREFIX, cut('00:16:04', 'refused', RESPAWN_STORM_ERROR)];
    const hostEvents = [
      host('00:14:42', 'respawn-failed', 'codex-route-unavailable'),
      host('00:15:23', 'respawn-failed', 'codex-route-unavailable'),
    ];
    expect(classifyRespawnStorm(rows, at('00:16:30'), { hostEvents })).toMatchObject({
      storm: false, reason: null, cutsSinceRealTurn: 0, cutTimes: [],
    });
  });

  it('excludes a superseded request but preserves a successor whose continuation later fails', () => {
    const hostEvents = [
      host('00:14:42', 'respawn-carry-dropped', 'superseded'),
      host('00:15:23', 'respawned'),
      host('00:15:30', 'respawn-carry-dropped', 'turn-start-unverified'),
    ];
    expect(classifyRespawnStorm(STORM_PREFIX, at('00:16:04'), { hostEvents })).toMatchObject({
      storm: false, cutsSinceRealTurn: 1, cutTimes: ['2026-09-23T00:15:19.000Z'],
    });
  });

  it('still breaks a real storm even when both successors drop their first continuation', () => {
    const hostEvents = [
      host('00:14:39', 'respawned'),
      host('00:14:42', 'respawn-carry-dropped', 'turn-start-unverified'),
      host('00:15:20', 'respawned'),
      host('00:15:23', 'respawn-failed', 'spawn-failed'),
    ];
    expect(classifyRespawnStorm(STORM_PREFIX, at('00:16:04'), { hostEvents })).toMatchObject({
      storm: true, reason: 'dense-cuts', cutsSinceRealTurn: 2,
    });
  });

  it('requires an in-window carry failure and does not borrow unrelated lifecycle events', () => {
    const hostEvents = [
      host('00:14:37', 'respawn-failed', 'codex-route-unavailable'),
      host('00:14:42', 'respawn-failed', 'quota-recovery-failed', 'quota-recovery'),
      host('00:16:10', 'respawn-failed', 'codex-route-unavailable'),
    ];
    expect(classifyRespawnStorm(STORM_PREFIX, at('00:16:04'), { hostEvents })).toMatchObject({
      storm: true, cutsSinceRealTurn: 2,
    });
  });

  it('replays su-cfa16b20: the 2nd cut is allowed, the 3rd (00:16:04) is refused as a dense storm', () => {
    const second = classifyRespawnStorm(STORM_PREFIX.slice(0, 6), at('00:15:19'));
    expect(second.storm).toBe(false);
    expect(second.cutsSinceRealTurn).toBe(1);

    const third = classifyRespawnStorm(STORM_PREFIX, at('00:16:04'));
    expect(third).toMatchObject({
      storm: true,
      reason: 'dense-cuts',
      cutsSinceRealTurn: 2,
      lastRealTurnAt: '2026-09-23T00:14:36.000Z',
    });
    expect(third.cutTimes).toEqual(['2026-09-23T00:15:19.000Z', '2026-09-23T00:14:38.000Z']);
  });

  it('a single prior cut — the ordinary compaction — is never a storm', () => {
    expect(classifyRespawnStorm([cut('00:14:38')], at('00:14:50')).storm).toBe(false);
    expect(classifyRespawnStorm([], at('00:14:50')).storm).toBe(false);
  });

  it('a real agent-origin call between cuts resets the streak', () => {
    const rows = [cut('00:14:38'), call('00:15:00', 'coord:orient', 'agent'), cut('00:15:19')];
    const verdict = classifyRespawnStorm(rows, at('00:16:04'));
    expect(verdict.storm).toBe(false);
    expect(verdict.cutsSinceRealTurn).toBe(1);
    expect(verdict.lastRealTurnAt).toBe('2026-09-23T00:15:00.000Z');
  });

  it('hook-origin and in-process (unknown) rows are NOT real turns', () => {
    const rows = [
      cut('00:14:38'),
      call('00:14:50', 'activity:report', 'hook'),
      call('00:15:00', 'plan_items:release', 'unknown'),
      call('00:15:05', 'locks:acquire', null),
      cut('00:15:19'),
    ];
    expect(classifyRespawnStorm(rows, at('00:16:04'))).toMatchObject({ storm: true, reason: 'dense-cuts' });
  });

  it('refused cuts (flush-required etc.) are not queued cuts', () => {
    const rows = [cut('00:14:38'), cut('00:15:00', 'refused', 'flush-required'), cut('00:15:10', 'refused', 'flush-required')];
    expect(classifyRespawnStorm(rows, at('00:16:04'))).toMatchObject({ storm: false, cutsSinceRealTurn: 1 });
  });

  it('cuts spread wider than the window are not dense', () => {
    const olderThanWindow = new Date(at('00:30:00') - RESPAWN_STORM_WINDOW_MS - 1_000).toISOString().slice(11, 19);
    const rows = [cut(olderThanWindow), cut('00:28:00')];
    expect(classifyRespawnStorm(rows, at('00:30:00')).storm).toBe(false);
  });

  it('a prior respawn-storm refusal LATCHES past the window until a real turn clears it', () => {
    const latched = [cut('00:14:38'), cut('00:15:19'), cut('00:16:04', 'refused', RESPAWN_STORM_ERROR)];
    expect(classifyRespawnStorm(latched, at('00:50:00'))).toMatchObject({ storm: true, reason: 'latched' });

    const cleared = [...latched, call('00:20:00', 'coord:orient', 'agent')];
    expect(classifyRespawnStorm(cleared, at('00:50:00')).storm).toBe(false);
  });
});

describe('detectRespawnStorm (ledger read)', () => {
  const dbRow = (r: StormLedgerRow) => ({
    invoked_at: new Date(r.invokedAtMs),
    tool_name: r.toolName,
    status: r.status,
    call_origin: r.callOrigin,
    error_code: r.errorCode,
  });

  it('reads the owner-scoped ledger and classifies it', async () => {
    const seen: unknown[][] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      seen.push(values);
      expect(strings.join('?')).toContain('harness_shared.tool_invocations');
      return Promise.resolve([...STORM_PREFIX].reverse().map(dbRow));
    }) as never;
    const verdict = await detectRespawnStorm('su-cfa16b20', { sql, nowMs: at('00:16:04') });
    expect(verdict).toMatchObject({ storm: true, reason: 'dense-cuts' });
    expect(seen[0]).toContain('su-cfa16b20');
    expect(seen[0]).toContain(REQUEST_COMPACTION_TOOL);
  });

  it('reconciles the invocation ledger with the same owner host log before refusing', async () => {
    readOwnerHostEvents.mockResolvedValueOnce([
      { ts: new Date(at('00:14:42')).toISOString(), kind: 'respawn-failed', mode: 'carry-respawn' },
      { ts: new Date(at('00:15:23')).toISOString(), kind: 'respawn-failed', mode: 'carry-respawn' },
    ]);
    const sql = (() => Promise.resolve(STORM_PREFIX.map(dbRow))) as never;
    await expect(detectRespawnStorm('su-failed-carry', { sql, nowMs: at('00:16:04') }))
      .resolves.toMatchObject({ storm: false, cutsSinceRealTurn: 0 });
    expect(readOwnerHostEvents).toHaveBeenCalledWith('su-failed-carry');
  });

  it('fails OPEN when the ledger read throws', async () => {
    const sql = (() => {
      throw new Error('pool exhausted');
    }) as never;
    await expect(detectRespawnStorm('su-x', { sql })).resolves.toMatchObject({ storm: false });
  });

  it('fails OPEN when the ledger read hangs past its budget', async () => {
    const sql = (() => new Promise(() => {})) as never;
    await expect(detectRespawnStorm('su-x', { sql, timeoutMs: 20 })).resolves.toMatchObject({ storm: false });
  });

  it('an empty owner id never reads', async () => {
    const sql = vi.fn() as never;
    await expect(detectRespawnStorm('  ', { sql })).resolves.toMatchObject({ storm: false });
    expect(sql).not.toHaveBeenCalled();
  });
});

describe('escalateRespawnStorm', () => {
  // Block body on purpose: vitest runs a FUNCTION returned from beforeEach as that
  // test's teardown, and mockReset() returns the mock — an expression body would
  // invoke the (rejecting) mock after every test as an unhandled rejection.
  beforeEach(() => {
    openEscalation.mockReset();
  });

  const verdict = classifyRespawnStorm(STORM_PREFIX, at('00:16:04'));
  const input = {
    ownerId: 'su-cfa16b20',
    workspaceId: 'papercusp-workspace',
    verdict,
    heldItems: [{ id: 'WI-31', title: 'green the gate' }],
  };

  it('opens ONE coalescing escalation per storming owner, naming the held items', async () => {
    openEscalation.mockResolvedValue({});
    await escalateRespawnStorm(input);
    expect(openEscalation).toHaveBeenCalledTimes(1);
    const [identity, payload] = openEscalation.mock.calls[0]! as [
      { workspaceId: string },
      { severity: string; summary: string; body: string; meta: Record<string, unknown> },
    ];
    expect(identity.workspaceId).toBe('papercusp-workspace');
    expect(payload.meta).toMatchObject({
      dedupKind: RESPAWN_STORM_DEDUP_KIND,
      subjectSignature: 'su-cfa16b20',
      heldWorkItemIds: ['WI-31'],
    });
    expect(payload.summary).toContain('su-cfa16b20');
    expect(payload.body).toContain('WI-31 — green the gate');
  });

  it('never throws when the escalation write fails', async () => {
    openEscalation.mockImplementation(async () => {
      throw new Error('coord log down');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let thrown: unknown = null;
    try {
      await escalateRespawnStorm(input);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeNull();
    expect(openEscalation).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('alert text says when nothing is held', () => {
    expect(respawnStormAlertText({ ...input, heldItems: [] }).body).toContain('(none held)');
  });
});
