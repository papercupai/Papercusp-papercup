/**
 * WI-939561 — GOAL kickoff evidence must be a real, current-window dispatch
 * gate rather than a prompt-only request.
 */

import { readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import {
  GOAL_KICKOFF_GUARDED_TOOLS,
  GOAL_KICKOFF_REQUIRED_READS,
  goalKickoffRefusalPayload,
  isGoalKickoffGuardedTool,
  readGoalKickoffEvidence,
  type GoalKickoffRead,
} from './kickoff-evidence';
import { PORTFOLIO_CREATE_TOOLS, PORTFOLIO_PLACE_TOOLS } from './portfolio-acts';

const WINDOW = '2026-08-29T21:40:51.000Z';
const GOAL = 'work-on-everything-070565';
const OWNER = 'su-goal-holder';
const WS = 'papercusp-workspace';

interface Fixture {
  mode?:
    | false
    | {
        subject?: string | null;
        setAt?: string;
        goalExists?: boolean;
        standing?: boolean;
        killCriterion?: string | null;
      };
  // One timestamp per read, or several when a read was repeated in the window.
  reads?: Partial<Record<GoalKickoffRead, string | string[]>>;
  reportAt?: string | null;
  reportGoalId?: string;
  reportEnvelope?: Record<string, unknown>;
  modeError?: string;
  evidenceError?: string;
}

const completeReads = (): Record<GoalKickoffRead, string> => ({
  'goals:list': '2026-08-29T21:41:00.000Z',
  'pot:list': '2026-08-29T21:41:01.000Z',
  'plans:list': '2026-08-29T21:41:02.000Z',
  'search:semantic': '2026-08-29T21:41:03.000Z',
});

function mockSql(fixture: Fixture): Sql {
  const fn = (first: unknown, ...values: unknown[]): unknown => {
    // postgres.js also calls the Sql object as a normal function to build an IN
    // fragment. The fake need only preserve a placeholder for the tagged query.
    if (!Array.isArray(first) || !('raw' in (first as object))) return { values: first };
    const text = (first as string[]).join('¤').replace(/\s+/g, ' ');

    if (text.includes('FROM harness_shared.agent_modes')) {
      if (fixture.modeError) return Promise.reject(new Error(fixture.modeError));
      if (fixture.mode === false) return Promise.resolve([]);
      const mode = fixture.mode ?? {};
      const subject = mode.subject === undefined ? GOAL : mode.subject;
      return Promise.resolve([
        {
          workspace_id: WS,
          owner_id: OWNER,
          axis_key: 'overlay:goal',
          mode: 'goal',
          reason: 'test',
          set_by: OWNER,
          owner_directed: true,
          subject,
          set_at: mode.setAt ?? WINDOW,
        },
      ]);
    }

    if (text.includes('FROM harness_shared.goals')) {
      const mode = fixture.mode === false ? {} : (fixture.mode ?? {});
      if (mode.goalExists === false) return Promise.resolve([]);
      return Promise.resolve([
        {
          id: mode.subject === undefined ? GOAL : mode.subject,
          standing: mode.standing ?? false,
          kill_criterion: mode.killCriterion ?? null,
        },
      ]);
    }

    if (text.includes('FROM harness_shared.tool_invocations')) {
      if (fixture.evidenceError) return Promise.reject(new Error(fixture.evidenceError));
      // Emulate the query's per-tool aggregate over every recorded invocation,
      // so a repeated read exercises min() vs max() for real (WI-10004981).
      const aggregate = /\bmin\(invoked_at\)/i.test(text) ? 'min' : /\bmax\(invoked_at\)/i.test(text) ? 'max' : null;
      if (!aggregate) return Promise.reject(new Error('mockSql: reads query has no min/max(invoked_at) aggregate'));
      return Promise.resolve(
        Object.entries(fixture.reads ?? {}).map(([tool_name, at]) => {
          const all = (Array.isArray(at) ? at : [at]).slice().sort();
          return { tool_name, invoked_at: aggregate === 'min' ? all[0] : all[all.length - 1] };
        }),
      );
    }

    if (text.includes('FROM harness_shared.coord_event_log')) {
      if (fixture.evidenceError) return Promise.reject(new Error(fixture.evidenceError));
      const latestReadAt = String(values[2]);
      const reportGoal = fixture.reportGoalId ?? GOAL;
      const reportAt = fixture.reportAt ?? null;
      return Promise.resolve(
        reportAt && reportAt >= latestReadAt
          ? [
              {
                ts: reportAt,
                body: fixture.reportEnvelope ?? {
                  goalOwnerReport: {
                    schemaVersion: 'goal-owner-report-v1',
                    goalId: reportGoal,
                    moved: 'P-001 advanced',
                    cost: 'unknown (goal-pots source unavailable)',
                    ownerWalled: 'none',
                    killed: 'none',
                  },
                },
              },
            ]
          : [],
      );
    }

    return Promise.resolve([]);
  };
  return fn as unknown as Sql;
}

async function read(fixture: Fixture) {
  const flushTelemetry = vi.fn(async () => {});
  const evidence = await readGoalKickoffEvidence({
    workspaceId: WS,
    ownerId: OWNER,
    sql: mockSql(fixture),
    flushTelemetry,
  });
  return { evidence, flushTelemetry };
}

describe('GOAL kickoff required-leg gate', () => {
  for (const missing of GOAL_KICKOFF_REQUIRED_READS) {
    it(`refuses when ${missing} is absent from the current GOAL window`, async () => {
      const reads = completeReads();
      delete reads[missing];
      const { evidence } = await read({
        reads,
        reportAt: '2026-08-29T21:42:00.000Z',
      });

      expect(evidence.applies).toBe(true);
      expect(evidence.complete).toBe(false);
      expect(evidence.missing).toContain(missing);
      // A report cannot be valid until every required read precedes it.
      expect(evidence.missing).toContain('owner-report');
    });
  }

  it('refuses when all reads exist but no owner-facing report follows them', async () => {
    const { evidence } = await read({ reads: completeReads(), reportAt: null });
    expect(evidence.complete).toBe(false);
    expect(evidence.missing).toEqual(['owner-report']);
  });

  it('refuses a report that predates the last required read', async () => {
    const { evidence } = await read({
      reads: completeReads(),
      reportAt: '2026-08-29T21:41:02.500Z',
    });
    expect(evidence.complete).toBe(false);
    expect(evidence.missing).toEqual(['owner-report']);
  });

  it('keeps accepting a valid report after a later routine re-read of a required read (WI-10004981)', async () => {
    // Observed 2026-10-01: a four-heading report at 18:15:17Z, then a goals:list
    // re-read at 18:17:31Z, re-locked capability:launch-agent under max().
    const { evidence } = await read({
      reads: { ...completeReads(), 'goals:list': ['2026-08-29T21:41:00.000Z', '2026-08-29T21:50:00.000Z'] },
      reportAt: '2026-08-29T21:45:00.000Z',
    });
    expect(evidence.missing).toEqual([]);
    expect(evidence.complete).toBe(true);
    expect(evidence.ownerReportAt).toBe('2026-08-29T21:45:00.000Z');
  });

  it('refuses a report for a different goal subject', async () => {
    const { evidence } = await read({
      reads: completeReads(),
      reportAt: '2026-08-29T21:42:00.000Z',
      reportGoalId: 'some-other-goal',
    });
    expect(evidence.complete).toBe(false);
    expect(evidence.missing).toEqual(['owner-report']);
  });

  it('refuses an arbitrary to-human ping and a partial labeled body', async () => {
    const ping = await read({
      reads: completeReads(),
      reportAt: '2026-08-29T21:42:00.000Z',
      reportEnvelope: { body: `Status for ${GOAL}: still working.` },
    });
    expect(ping.evidence).toMatchObject({ complete: false, missing: ['owner-report'] });
    // The refusal must be able to say WHICH of the two it was.
    expect(ping.evidence.ownerReportDiagnosis).toEqual({ candidates: 1, closest: { kind: 'not-attempted' } });

    const partial = await read({
      reads: completeReads(),
      reportAt: '2026-08-29T21:42:00.000Z',
      reportEnvelope: { body: `Goal ${GOAL}\nMOVED: P-001\nCOST: 1c\nOWNER-WALLED: none` },
    });
    expect(partial.evidence).toMatchObject({ complete: false, missing: ['owner-report'] });
    expect(partial.evidence.ownerReportDiagnosis).toEqual({
      candidates: 1,
      closest: { kind: 'incomplete', missing: ['killed'], empty: [], duplicate: [] },
    });
  });

  it('compatibility control: accepts a complete legacy four-label body naming the exact goal', async () => {
    const { evidence } = await read({
      reads: completeReads(),
      reportAt: '2026-08-29T21:42:00.000Z',
      reportEnvelope: {
        body: `Goal ${GOAL}\nMOVED: P-001 advanced\nCOST: unknown (legacy)\n` + 'OWNER-WALLED: none\nKILLED: none',
      },
    });
    expect(evidence).toMatchObject({ complete: true, ownerReportAt: '2026-08-29T21:42:00.000Z' });
  });

  it('positive control: admits a STANDING goal with all evidence and no kill criterion', async () => {
    const { evidence, flushTelemetry } = await read({
      mode: { standing: true, killCriterion: null },
      reads: completeReads(),
      reportAt: '2026-08-29T21:42:00.000Z',
    });

    expect(flushTelemetry).toHaveBeenCalledTimes(1);
    expect(evidence).toMatchObject({
      applies: true,
      complete: true,
      goalId: GOAL,
      standing: true,
      killCriterion: null,
      missing: [],
      ownerReportAt: '2026-08-29T21:42:00.000Z',
    });
  });

  it('does not gate an ordinary caller or a goal-descendant without mode=goal', async () => {
    const { evidence, flushTelemetry } = await read({ mode: false });
    expect(evidence).toMatchObject({ applies: false, complete: false, missing: [] });
    expect(flushTelemetry).not.toHaveBeenCalled();
  });

  it('fails closed after a GOAL row is known when its evidence ledger is unavailable', async () => {
    const { evidence } = await read({ evidenceError: 'telemetry unavailable' });
    expect(evidence.applies).toBe(true);
    expect(evidence.complete).toBe(false);
    expect(evidence.missing).toEqual(['evidence-unavailable']);
    expect(evidence.degradedReason).toContain('telemetry unavailable');
  });

  it('names the exact recovery sequence and preserves standing-goal semantics in the refusal', async () => {
    const { evidence } = await read({ mode: { standing: true }, reads: completeReads() });
    const refusal = goalKickoffRefusalPayload('fleet:launch-on-plan', evidence);
    expect(refusal.error).toBe('goal_kickoff_incomplete');
    expect(refusal.message).toContain('goals:list, pot:list, plans:list, and search:semantic');
    expect(refusal.message).toContain('no kill criterion is required');
  });

  /**
   * EI-23742424491420721 — `missing:['owner-report']` read as "you have not
   * sent one" while the truth was "you sent four, and all four parsed as
   * non-attempts". Four delivered-but-rejected reports, a carry-respawn and
   * ~90 minutes later it also produced a WRONG durable conclusion (that the
   * coord:send CHANNEL was at fault). The refusal must name the schema.
   */
  describe('the owner-report refusal names the schema it actually requires', () => {
    it('always states the four required headings and that naming the goal id is not enough', async () => {
      const { evidence } = await read({ reads: completeReads(), reportAt: null });
      const refusal = goalKickoffRefusalPayload('plans:start', evidence);

      for (const heading of ['MOVED', 'COST', 'OWNER-WALLED', 'KILLED']) {
        expect(refusal.message).toContain(heading);
      }
      expect(refusal.message).toContain('exactly once and non-empty');
      // The precise sentence that contradicts the wrong conclusion the bare
      // token invited. Without it, "names the exact goal id" reads as the whole
      // contract — which is what sent four correct-channel reports into a loop.
      expect(refusal.message).toContain('merely names the goal id is NOT a report');
      expect(refusal.requiredOwnerReportHeadings).toEqual({
        moved: 'MOVED',
        cost: 'COST',
        ownerWalled: 'OWNER-WALLED',
        killed: 'KILLED',
        nextWake: 'NEXT WAKE',
      });
    });

    it('says "none was sent" only when none was actually sent', async () => {
      const { evidence } = await read({ reads: completeReads(), reportAt: null });
      expect(evidence.ownerReportDiagnosis).toEqual({ candidates: 0, closest: null });

      const refusal = goalKickoffRefusalPayload('plans:start', evidence);
      expect(refusal.message).toContain('No owner-facing message was found in this window');
      expect(refusal.observed.ownerReport).toEqual({ candidates: 0, closest: null });
    });

    it('reports a DELIVERED non-attempt as a shape failure, not as an absent report', async () => {
      const { evidence } = await read({
        reads: completeReads(),
        reportAt: '2026-08-29T21:42:00.000Z',
        reportEnvelope: { body: `Status for ${GOAL}: still working, three items advanced.` },
      });
      const refusal = goalKickoffRefusalPayload('fleet:launch-on-plan', evidence);

      expect(refusal.message).toContain('1 owner-facing message was delivered in this window');
      expect(refusal.message).toContain('report ATTEMPT');
      expect(refusal.message).toContain('The channel was right and the report SHAPE was wrong');
      // It must NOT claim nothing was sent — that is the false reading.
      expect(refusal.message).not.toContain('No owner-facing message was found');
      expect(refusal.observed.ownerReport).toEqual({ candidates: 1, closest: { kind: 'not-attempted' } });
    });

    it('names the specific unmet fields when the report was attempted', async () => {
      const { evidence } = await read({
        reads: completeReads(),
        reportAt: '2026-08-29T21:42:00.000Z',
        reportEnvelope: { body: `Goal ${GOAL}\nMOVED: P-001\nCOST: 1c\nOWNER-WALLED: none` },
      });
      const refusal = goalKickoffRefusalPayload('fleet:launch-on-plan', evidence);

      expect(refusal.message).toContain('missing: killed');
      expect(refusal.message).toContain('empty: none');
      expect(refusal.message).toContain('duplicate: none');
    });

    it('distinguishes a complete report stamped for another goal', async () => {
      const { evidence } = await read({
        reads: completeReads(),
        reportAt: '2026-08-29T21:42:00.000Z',
        reportGoalId: 'some-other-goal',
      });
      const refusal = goalKickoffRefusalPayload('fleet:launch-on-plan', evidence);

      expect(refusal.message).toContain('carried a COMPLETE report, but for goal some-other-goal');
      expect(refusal.observed.ownerReport).toEqual({
        candidates: 1,
        closest: { kind: 'wrong-goal', stampedGoalId: 'some-other-goal' },
      });
    });

    it('leaves the diagnosis null when the report leg was never evaluated', async () => {
      // Reads still missing: the report could not have been valid yet, so
      // claiming anything about owner-facing traffic would be manufactured.
      const { evidence } = await read({ reads: { 'goals:list': '2026-08-29T21:41:00.000Z' } });
      expect(evidence.missing).toContain('owner-report');
      expect(evidence.ownerReportDiagnosis).toBeNull();

      const refusal = goalKickoffRefusalPayload('plans:start', evidence);
      expect(refusal.message).not.toContain('No owner-facing message was found');
      expect(refusal.message).not.toContain('owner-facing message was delivered');
      // The schema itself is still stated — it is the contract, not a diagnosis.
      expect(refusal.message).toContain('MOVED / COST / OWNER-WALLED / KILLED');
    });

    it('reads as English for one candidate and for many', async () => {
      // The reported case was FOUR delivered reports, so the plural branch is
      // the one an agent actually hits; it is also the one a singular-only
      // fixture cannot reach.
      const { evidence } = await read({
        reads: completeReads(),
        reportAt: '2026-08-29T21:42:00.000Z',
        reportEnvelope: { body: `Status for ${GOAL}.` },
      });
      const plural = goalKickoffRefusalPayload('fleet:launch-on-plan', {
        ...evidence,
        ownerReportDiagnosis: { candidates: 4, closest: { kind: 'not-attempted' } },
      });

      expect(plural.message).toContain("4 owner-facing messages were delivered in this window, but none registered");
      expect(plural.message).toContain('report ATTEMPT');
      // Regression guard: the plural branch once read "but none did not
      // register", a double negative that inverts the sentence's meaning.
      expect(plural.message).not.toContain('none did not register');

      const singular = goalKickoffRefusalPayload('fleet:launch-on-plan', evidence);
      expect(singular.message).toContain('1 owner-facing message was delivered in this window, but it did not register');
      expect(singular.message).not.toContain('messages were delivered');
    });

    it('stays silent about owner-report when that leg is not what failed', async () => {
      const { evidence } = await read({ evidenceError: 'telemetry unavailable' });
      const refusal = goalKickoffRefusalPayload('plans:start', evidence);
      expect(refusal.missing).toEqual(['evidence-unavailable']);
      expect(refusal.message).not.toContain('owner-facing message was delivered');
      expect(refusal.message).not.toContain('No owner-facing message was found');
    });
  });
});

describe('shared dispatch coverage', () => {
  it('covers every create/launch/placement door named by WI-939561', () => {
    expect(GOAL_KICKOFF_GUARDED_TOOLS).toEqual(
      [...new Set([...PORTFOLIO_CREATE_TOOLS, ...PORTFOLIO_PLACE_TOOLS])].sort(),
    );
    for (const name of GOAL_KICKOFF_GUARDED_TOOLS) expect(isGoalKickoffGuardedTool(name)).toBe(true);
    expect(isGoalKickoffGuardedTool('goals:list')).toBe(false);
  });

  it('gates conditional create/place acts by arguments without blocking their read-only forms', () => {
    expect(isGoalKickoffGuardedTool('improvements:capture', { title: 'real filing' })).toBe(true);
    expect(
      isGoalKickoffGuardedTool('improvements:capture', { title: 'reflection', lane: 'observation' }),
    ).toBe(false);
    expect(
      isGoalKickoffGuardedTool('improvements:capture', { title: 'probe', checkDuplicatesOnly: true }),
    ).toBe(false);
    expect(isGoalKickoffGuardedTool('work_items:update', { id: 'WI-1', goal: 'goal-1' })).toBe(true);
    expect(isGoalKickoffGuardedTool('work_items:update', { id: 'WI-1', title: 'rename only' })).toBe(false);
  });

  it('wires the evaluator and telemetry flush at the one projected dispatch seam', () => {
    const source = readFileSync(new URL('../projected-tool-deps.ts', import.meta.url), 'utf8');
    expect(source).toContain('if (isGoalKickoffGuardedTool(toolName, args))');
    expect(source).toContain('readGoalKickoffEvidence({');
    expect(source).toContain('flushTelemetry: flushPendingTelemetry');
    expect(source).toContain('goalKickoffRefusalPayload(toolName, evidence)');
    expect(source).toContain('isError: true');
  });
});
