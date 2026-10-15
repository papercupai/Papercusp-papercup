/**
 * agent-run-evidence-record.test.ts — unit coverage for the server-derived
 * evidence record stamped on agent-run scorecards (WI-10003539, plan
 * goal-agent-behavior-feedback-2026-09-06 R-1).
 *
 * The SQL seam is a fake that answers by relation name, so each case controls
 * exactly which durable source exists. The real queries run against migrated
 * Postgres in emit-agent-run-evidence-record.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveAgentRunEvidenceRecord,
  deriveAgentRunEvidenceRecordSafe,
  type EvidenceRecordSql,
} from './agent-run-evidence-record';

const SPEC = 'a'.repeat(64);
const STATE = '0d1ac02554663ebcf2401aed';

interface FakeRows {
  invocations?: Array<Record<string, unknown>>;
  goals?: Array<Record<string, unknown>>;
  modes?: Array<Record<string, unknown>>;
  sessions?: Array<Record<string, unknown>>;
  throwOn?: 'tool_invocations' | 'goals' | 'agent_modes' | 'adv_sessions';
}

type Relation = 'tool_invocations' | 'goals' | 'agent_modes' | 'adv_sessions' | 'unknown';

function relationOf(text: string): Relation {
  if (text.includes('harness_shared.tool_invocations')) return 'tool_invocations';
  if (text.includes('harness_shared.goals')) return 'goals';
  if (text.includes('harness_shared.agent_modes')) return 'agent_modes';
  if (text.includes('harness_shared.adv_sessions')) return 'adv_sessions';
  return 'unknown';
}

function fakeSql(rows: FakeRows): EvidenceRecordSql & { calls: Array<{ text: string; values: unknown[] }> } {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const fn = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    calls.push({ text, values });
    const table = relationOf(text);
    if (rows.throwOn === table) throw new Error(`relation "${table}" is unavailable`);
    if (table === 'tool_invocations') return rows.invocations ?? [];
    if (table === 'goals') return rows.goals ?? [];
    if (table === 'agent_modes') return rows.modes ?? [];
    if (table === 'adv_sessions') return rows.sessions ?? [];
    throw new Error(`unexpected query: ${text}`);
  }) as EvidenceRecordSql & { calls: Array<{ text: string; values: unknown[] }> };
  fn.calls = calls;
  return fn;
}

/** The goal-lookup relations in the order they were queried (the launch read runs alongside). */
function goalLookupOrder(sql: { calls: Array<{ text: string }> }): Relation[] {
  return sql.calls.map((c) => relationOf(c.text)).filter((r) => r !== 'adv_sessions');
}

const base = { workspaceId: 'ws-1', holder: 'su-holder-1', windowStart: '2026-09-26T10:00:00Z', windowEnd: '2026-09-26T12:00:00Z' };

describe('deriveAgentRunEvidenceRecord', () => {
  it('records goal, launch generation and instruction exposure when every durable source exists', async () => {
    const sql = fakeSql({
      goals: [{ id: 'goal-abc' }],
      sessions: [
        { id: 30725, started_at: new Date('2026-09-26T07:16:57Z'), specification_revision: SPEC, state_revision: STATE, model: 'opus' },
      ],
    });
    const rec = await deriveAgentRunEvidenceRecord({ sql, ...base });

    expect(rec).toEqual({
      schemaVersion: 1,
      derivedBy: 'server',
      holder: 'su-holder-1',
      window: { start: '2026-09-26T10:00:00.000Z', end: '2026-09-26T12:00:00.000Z' },
      goalId: 'goal-abc',
      goalSource: 'goals.agentOwnerId',
      sourceGeneration: { advSessionId: '30725', startedAt: '2026-09-26T07:16:57.000Z', model: 'opus' },
      instructionExposure: {
        status: 'recorded',
        generation: STATE,
        consumedPayloadHash: `sha256:${SPEC}`,
        source: 'adv_sessions.launch_spec',
        observedAt: 'launch',
      },
    });
    // The starter link answered only after both window-specific sources came back empty.
    expect(goalLookupOrder(sql)).toEqual(['tool_invocations', 'agent_modes', 'goals']);
    // Tenant + holder + window scope every lookup.
    for (const c of sql.calls) {
      expect(c.values).toContain('ws-1');
      expect(c.values).toContain('su-holder-1');
      expect(c.values).toContain('2026-09-26T12:00:00.000Z');
    }
  });

  it('records exposure as not-recorded (never fabricated) when the launch predates specification artifacts', async () => {
    const sql = fakeSql({
      goals: [{ id: 'goal-abc' }],
      sessions: [{ id: 22646, started_at: '2026-09-05T21:09:16Z', specification_revision: null, state_revision: null, model: null }],
    });
    const rec = await deriveAgentRunEvidenceRecord({ sql, ...base });

    expect(rec.instructionExposure.status).toBe('not-recorded');
    expect(rec.instructionExposure).not.toHaveProperty('consumedPayloadHash');
    expect((rec.instructionExposure as { reason: string }).reason).toContain('22646');
    expect(rec.sourceGeneration).toEqual({ advSessionId: '22646', startedAt: '2026-09-05T21:09:16Z', model: null });
  });

  it('refuses a malformed specificationRevision as a payload hash', async () => {
    const sql = fakeSql({
      sessions: [{ id: 1, started_at: '2026-09-26T07:00:00Z', specification_revision: 'NOT-A-HASH', state_revision: STATE, model: null }],
    });
    const rec = await deriveAgentRunEvidenceRecord({ sql, ...base });
    expect(rec.instructionExposure).toMatchObject({ status: 'not-recorded' });
  });

  it('records not-found goal and not-recorded exposure when the holder has no durable records', async () => {
    const rec = await deriveAgentRunEvidenceRecord({ sql: fakeSql({}), ...base });

    expect(rec.goalId).toBeNull();
    expect(rec.goalSource).toBe('not-found');
    expect(rec.sourceGeneration).toBeNull();
    expect(rec.instructionExposure).toMatchObject({ status: 'not-recorded' });
  });

  /**
   * The holder's own goal-stamped calls inside the window are the window-correct answer,
   * so they outrank both the lease row and the starter link — even when those name
   * different goals (plan goal-holder-plans-ideation-truthful-reports-2026-10-03 P-006).
   */
  it('takes the goal from the holder’s goal-stamped calls in the window before any other source', async () => {
    const sql = fakeSql({
      invocations: [{ goal_id: 'goal-from-calls' }],
      modes: [{ subject: 'goal-from-lease' }],
      goals: [{ id: 'goal-it-started' }],
    });
    const rec = await deriveAgentRunEvidenceRecord({ sql, ...base });

    expect(rec).toMatchObject({ goalId: 'goal-from-calls', goalSource: 'tool_invocations' });
    expect(goalLookupOrder(sql)).toEqual(['tool_invocations']);
    const call = sql.calls.find((c) => relationOf(c.text) === 'tool_invocations');
    expect(call?.values).toEqual(
      expect.arrayContaining(['su-holder-1', 'ws-1', '2026-09-26T10:00:00.000Z', '2026-09-26T12:00:00.000Z']),
    );
  });

  /**
   * The starter link is written once by goals/start.ts and never moved by lease
   * succession (D-003). A former holder that now leases another goal must map to the
   * lease, not to the goal it once started; that was the bug when metadata ran first.
   */
  it('prefers the goal-lease row over the goal the holder started', async () => {
    const sql = fakeSql({ modes: [{ subject: 'goal-from-lease' }], goals: [{ id: 'goal-it-started' }] });
    const rec = await deriveAgentRunEvidenceRecord({ sql, ...base });

    expect(rec).toMatchObject({ goalId: 'goal-from-lease', goalSource: 'agent_modes' });
    expect(goalLookupOrder(sql)).toEqual(['tool_invocations', 'agent_modes']);
    // A lease set after the window ended cannot describe it.
    const lease = sql.calls.find((c) => relationOf(c.text) === 'agent_modes');
    expect(lease?.text).toContain('set_at <=');
    expect(lease?.values).toContain('2026-09-26T12:00:00.000Z');
  });

  it('labels a lease successor from its lease row; goals.metadata never names a successor', async () => {
    const sql = fakeSql({ modes: [{ subject: 'goal-taken-over' }] });
    const rec = await deriveAgentRunEvidenceRecord({ sql, ...base });

    expect(rec).toMatchObject({ goalId: 'goal-taken-over', goalSource: 'agent_modes' });
  });

  it('ignores an unparseable window bound instead of querying with it', async () => {
    const sql = fakeSql({ goals: [{ id: 'goal-abc' }] });
    const rec = await deriveAgentRunEvidenceRecord({ sql, ...base, windowStart: 'yesterday-ish', windowEnd: 'not a date' });

    expect(rec.window).toEqual({ start: null, end: null });
    for (const c of sql.calls) expect(c.values).not.toContain('not a date');
    // No window, no window-scoped call ledger read: an unbounded owner scan answers nothing about a window.
    expect(goalLookupOrder(sql)).toEqual(['agent_modes', 'goals']);
    expect(rec).toMatchObject({ goalId: 'goal-abc', goalSource: 'goals.agentOwnerId' });
  });
});

describe('deriveAgentRunEvidenceRecordSafe', () => {
  it('turns a DB failure into an explicit derivation-failed record instead of throwing', async () => {
    const rec = await deriveAgentRunEvidenceRecordSafe({ getSql: () => fakeSql({ throwOn: 'adv_sessions' }), ...base });

    expect(rec.goalSource).toBe('derivation-failed');
    expect(rec.goalId).toBeNull();
    expect(rec.instructionExposure).toMatchObject({ status: 'derivation-failed' });
    expect((rec.instructionExposure as { reason: string }).reason).toContain('adv_sessions');
  });

  it('contains a failure to obtain the pool itself (the getSql thunk throws)', async () => {
    const rec = await deriveAgentRunEvidenceRecordSafe({
      getSql: () => {
        throw new Error('A UNIT test tried to open a REAL Postgres connection');
      },
      ...base,
    });
    expect(rec).toMatchObject({ goalSource: 'derivation-failed', instructionExposure: { status: 'derivation-failed' } });
    expect(rec.window).toEqual({ start: '2026-09-26T10:00:00.000Z', end: '2026-09-26T12:00:00.000Z' });
  });

  it('passes a healthy handle through to the same derivation', async () => {
    const rec = await deriveAgentRunEvidenceRecordSafe({ getSql: () => fakeSql({ goals: [{ id: 'goal-abc' }] }), ...base });
    expect(rec).toMatchObject({ goalId: 'goal-abc', goalSource: 'goals.agentOwnerId' });
  });

  it('control: the unsafe variant propagates the same failure', async () => {
    await expect(deriveAgentRunEvidenceRecord({ sql: fakeSql({ throwOn: 'goals' }), ...base })).rejects.toThrow('goals');
  });
});
