import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  send: vi.fn(async (_identity: unknown, _opts: unknown) => ({})),
  wake: vi.fn(async (_to: unknown, _opts: unknown) => ({})),
  launch: vi.fn(async (_args: unknown, _ctx: unknown) => ({ isError: false })),
}));
vi.mock('../agent-tools/coordination/messages', () => ({ sendMessage: mocks.send }));
vi.mock('../agent-tools/coordination/inbox-wake', () => ({ wakeRecipients: mocks.wake }));
vi.mock('../agent-tools/capability/launch-agent', () => ({ default: { handler: mocks.launch } }));

import {
  makeProdParkDeliveryDeps,
  parkDeliveryStateFromRow,
  parkResumeIdempotencyKey,
  sweepParkDeliveries,
  type ParkDeliveryRow,
} from './park-delivery-prod';
import { PARK_DELIVERY_GRACE_MS, type ParkDeliveryDeps } from './park-delivery';

const VERDICT_AT = '2026-10-13T01:00:00.000Z';
const AFTER_GRACE = new Date(Date.parse(VERDICT_AT) + PARK_DELIVERY_GRACE_MS + 1_000).toISOString();

const routing = {
  cascade: {
    flavor: 'decision-review',
    workItemId: 'WI-1',
    setterId: 'su-parker',
    defaultAction: 'ship it',
    deadlineAt: '2026-10-13T00:30:00.000Z',
    ownerAuthorityTopic: null,
  },
};

function row(parkState: unknown, over: Partial<ParkDeliveryRow> = {}): ParkDeliveryRow {
  return { workspace_id: 'ws-1', conversation_id: 'conv-1', routing, park_state: parkState as never, ...over };
}

const quiet = { lastTurnAt: null, sessionState: 'parked' as const };

describe('parkDeliveryStateFromRow', () => {
  it('maps a proceed verdict to the parker, work item and verdict time', () => {
    const s = parkDeliveryStateFromRow(row({ outcomes: [{ verdict: 'proceed', at: VERDICT_AT }] }), quiet);
    expect(s).toMatchObject({
      consultId: 'conv-1',
      workItemId: 'WI-1',
      parkerId: 'su-parker',
      verdict: 'proceed',
      emittedAt: VERDICT_AT,
      parkerSessionState: 'parked',
      rewakeAttemptedAt: null,
      resumeAttemptedAt: null,
      ownerNotifiedAt: null,
    });
  });

  it.each(['adopted', 'owner-deciding'])('skips a latest %s verdict (nothing for the parker to act on)', (verdict) => {
    expect(
      parkDeliveryStateFromRow(row({ outcomes: [{ verdict: 'proceed', at: '2026-10-12T00:00:00Z' }, { verdict, at: VERDICT_AT }] }), quiet),
    ).toBeNull();
  });

  it('skips a consult that is not a decision-review park', () => {
    expect(parkDeliveryStateFromRow(row({ outcomes: [{ verdict: 'proceed', at: VERDICT_AT }] }, { routing: {} }), quiet)).toBeNull();
  });

  it('ignores bookkeeping written for an earlier verdict', () => {
    const s = parkDeliveryStateFromRow(
      row({
        outcomes: [{ verdict: 'owner-decided', at: VERDICT_AT }],
        delivery: { verdictAt: '2026-10-12T00:00:00Z', rewakeAttemptedAt: '2026-10-12T00:11:00Z', ownerNotifiedAt: '2026-10-12T00:40:00Z' },
      }),
      quiet,
    );
    expect(s).toMatchObject({ verdict: 'owner-decided', rewakeAttemptedAt: null, ownerNotifiedAt: null });
  });

  it('carries bookkeeping for the current verdict and closes once delivered or notified', () => {
    const base = { outcomes: [{ verdict: 'consider-alternative', at: VERDICT_AT }] };
    expect(
      parkDeliveryStateFromRow(row({ ...base, delivery: { verdictAt: VERDICT_AT, rewakeAttemptedAt: AFTER_GRACE } }), quiet),
    ).toMatchObject({ rewakeAttemptedAt: AFTER_GRACE });
    expect(parkDeliveryStateFromRow(row({ ...base, delivery: { verdictAt: VERDICT_AT, deliveredAt: AFTER_GRACE } }), quiet)).toBeNull();
    expect(parkDeliveryStateFromRow(row({ ...base, delivery: { verdictAt: VERDICT_AT, ownerNotifiedAt: AFTER_GRACE } }), quiet)).toBeNull();
  });

  it('parses a park_state stored as a JSON string', () => {
    expect(parkDeliveryStateFromRow(row(JSON.stringify({ outcomes: [{ verdict: 'proceed', at: VERDICT_AT }] })), quiet)).not.toBeNull();
  });
});

/** A tagged-template stand-in for postgres.js: SELECTs return `rows`, every call is recorded. */
function fakeSql(rows: ParkDeliveryRow[]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    calls.push({ text, values });
    return Promise.resolve(/^\s*SELECT/.test(text) ? rows : []);
  }) as unknown as Record<string, unknown>;
  sql.unsafe = (s: string) => s;
  sql.json = (v: unknown) => v;
  return { sql: sql as never, calls };
}

type MockedDeps = { [K in keyof ParkDeliveryDeps]: ReturnType<typeof vi.fn> } & ParkDeliveryDeps;

function fakeDeps(): MockedDeps {
  return {
    rewake: vi.fn(async () => undefined),
    resume: vi.fn(async () => true),
    notifyOwner: vi.fn(async () => undefined),
    record: vi.fn(async () => undefined),
  } as never;
}

describe('sweepParkDeliveries', () => {
  it('re-wakes a live parker with no turn after the grace (R-7)', async () => {
    const { sql } = fakeSql([row({ outcomes: [{ verdict: 'proceed', at: VERDICT_AT }] })]);
    const deps = fakeDeps();
    const r = await sweepParkDeliveries({
      sql,
      depsFor: () => deps,
      lastTurnAt: async () => '2026-10-13T00:59:00.000Z',
      sessionState: async () => 'parked',
      now: AFTER_GRACE,
    });
    expect(r.checked).toEqual([{ consultId: 'conv-1', action: 'rewake' }]);
    expect(deps.rewake).toHaveBeenCalledOnce();
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({ consultId: 'conv-1' }), { rewakeAttemptedAt: AFTER_GRACE });
  });

  it('resumes an ended parker instead of waking it (R-20)', async () => {
    const { sql } = fakeSql([row({ outcomes: [{ verdict: 'proceed', at: VERDICT_AT }] })]);
    const deps = fakeDeps();
    const r = await sweepParkDeliveries({ sql, depsFor: () => deps, lastTurnAt: async () => null, sessionState: async () => 'ended', now: AFTER_GRACE });
    expect(r.checked).toEqual([{ consultId: 'conv-1', action: 'resume', resumeResult: 'ok' }]);
    expect(deps.rewake).not.toHaveBeenCalled();
  });

  it('closes the check with deliveredAt when the parker took a turn after the verdict', async () => {
    const { sql, calls } = fakeSql([row({ outcomes: [{ verdict: 'proceed', at: VERDICT_AT }] })]);
    const deps = fakeDeps();
    const r = await sweepParkDeliveries({ sql, depsFor: () => deps, lastTurnAt: async () => AFTER_GRACE, sessionState: async () => 'live', now: AFTER_GRACE });
    expect(r.checked).toEqual([{ consultId: 'conv-1', action: 'none', reason: 'delivered' }]);
    const update = calls.find((c) => /UPDATE harness_shared\.consult_state/.test(c.text));
    expect(update?.values).toContainEqual({ deliveredAt: AFTER_GRACE, verdictAt: VERDICT_AT });
  });

  it('isolates one park failure from the rest', async () => {
    const { sql } = fakeSql([
      row({ outcomes: [{ verdict: 'proceed', at: VERDICT_AT }] }, { conversation_id: 'conv-bad' }),
      row({ outcomes: [{ verdict: 'proceed', at: VERDICT_AT }] }, { conversation_id: 'conv-ok' }),
    ]);
    const deps = fakeDeps();
    deps.rewake.mockRejectedValueOnce(new Error('wake down'));
    const r = await sweepParkDeliveries({ sql, depsFor: () => deps, lastTurnAt: async () => null, sessionState: async () => 'parked', now: AFTER_GRACE });
    expect(r.failures).toEqual([{ conversationId: 'conv-bad', error: 'wake down' }]);
    expect(r.checked).toEqual([{ consultId: 'conv-ok', action: 'rewake' }]);
  });
});

describe('makeProdParkDeliveryDeps', () => {
  beforeEach(() => {
    mocks.send.mockClear();
    mocks.wake.mockClear();
    mocks.launch.mockClear();
  });
  const state = parkDeliveryStateFromRow(row({ outcomes: [{ verdict: 'proceed', at: VERDICT_AT }] }), quiet)!;

  it('re-wake writes the inbox row to the parker and then wakes it', async () => {
    const { sql } = fakeSql([]);
    await makeProdParkDeliveryDeps(sql, 'ws-1').rewake(state, 'note');
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-1' }), expect.objectContaining({ to: ['su-parker'] }));
    expect(mocks.wake).toHaveBeenCalledWith(['su-parker'], expect.objectContaining({ workspaceId: 'ws-1' }));
  });

  it('resume launches the parker by agent id with a per-verdict idempotency key', async () => {
    const { sql } = fakeSql([]);
    const deps = makeProdParkDeliveryDeps(sql, 'ws-1');
    expect(await deps.resume(state, 'note')).toBe(true);
    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({ resume: { agentId: 'su-parker' }, brief: 'note', idempotencyKey: parkResumeIdempotencyKey(state) }),
      expect.objectContaining({ workspaceId: 'ws-1' }),
    );
    mocks.launch.mockResolvedValueOnce({ isError: true });
    expect(await deps.resume(state, 'note')).toBe(false);
  });

  it('owner notification goes to the human inbox', async () => {
    const { sql } = fakeSql([]);
    await makeProdParkDeliveryDeps(sql, 'ws-1').notifyOwner(state, 'not delivered');
    expect(mocks.send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ to: ['human'], body: 'not delivered' }));
  });
});
