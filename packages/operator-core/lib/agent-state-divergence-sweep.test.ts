/**
 * Tests for P-010's delivery half — the formatter and the sweep orchestration,
 * both without a database (the sweep's PG read is an injected seam).
 *
 * The behaviours that actually matter here are the ORDERINGS: agent before
 * leader, leader only on a repeat, and nothing at all delivered from a leg that
 * could not run. Each of those is a rule from the plan, not an implementation
 * detail, so each gets its own test.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  divergenceSweep,
  divergenceFireKey,
  formatDivergenceAlert,
  loadRecentCalls,
  loadTerminalGoalRefs,
  DIVERGENCE_REPEAT_LOOKBACK_HOURS,
  DIVERGENCE_DEBOUNCE_HOURS,
} from './agent-state-divergence-sweep';
import { RETRY_THRASH_THRESHOLD, type Divergence, type DivergenceCall } from './agent-state-divergence';

const T0 = Date.parse('2026-07-27T12:00:00.000Z');

/** A flail that the real detector will find: N same-tool failures, close together. */
function flailCalls(n = RETRY_THRASH_THRESHOLD, ownerId = 'su-a'): DivergenceCall[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    ownerId,
    toolName: 'work_items:claim',
    status: 'invalid-input',
    invokedAt: new Date(T0 + i * 1000).toISOString(),
    args: { a: i },
  }));
}

/** Stub deps; every test overrides only what it is about. */
function deps(over: Parameters<typeof divergenceSweep>[0] = {}) {
  return {
    loadRecentCalls: vi.fn(async () => flailCalls()),
    recentWatchdogFires: vi.fn(async () => 0),
    // Won the debounce slot. `claimWatchdogFire` replaced the old
    // recentWatchdogFires-then-recordFire pair, which was both racy and — because
    // the recorded reason never contained the scope key — a debounce that could
    // never match (EI-18824142520274965).
    claimWatchdogFire: vi.fn(async () => true),
    openEscalation: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    // P-010: stubbed so these tests never reach PG. Default "nothing is terminal"
    // keeps every pre-existing expectation meaning what it did before the filter.
    loadTerminalGoalRefs: vi.fn(async () => new Set<string>()),
    // Comfortably past CONVERGENCE_SETTLE_MS from the flail's last failure, so
    // these delivery-ordering tests exercise delivery rather than the settle
    // rule (which has its own tests below).
    now: T0 + 10 * 60_000,
    ...over,
  } as unknown as Parameters<typeof divergenceSweep>[0] & Record<string, ReturnType<typeof vi.fn>>;
}

function mockSqlTag(rows: unknown[] = []) {
  const calls: Array<{ strings: TemplateStringsArray; values: unknown[] }> = [];
  const originPredicate = { kind: 'agent-origin-predicate' };
  const sql = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ strings, values });
      return calls.length === 1 ? originPredicate : Promise.resolve(rows);
    }),
    {
      unsafe: (identifier: string) => identifier,
      array: (values: unknown[]) => values,
    },
  );
  return { sql, calls, originPredicate };
}

describe('loadRecentCalls', () => {
  it('excludes hook-origin activity:report rows before the retry threshold while retaining agent calls', async () => {
    const hookOriginFixture = { tool_name: 'activity:report', call_origin: 'hook' };
    const { sql, calls, originPredicate } = mockSqlTag();
    await loadRecentCalls({
      workspaceId: 'test-workspace',
      sinceMs: T0,
      limit: 10,
      sql: sql as never,
    });

    expect(sql).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(2);
    const [originCall, queryCall] = calls;
    const originSql = Array.from(originCall.strings).join(' ');
    const originValues = originCall.values.flatMap((value) =>
      Array.isArray(value) ? value : [value],
    );
    expect(originSql).toContain('= ANY');
    expect(originSql).toContain('IS NULL');
    expect(originSql).toContain('<> ALL');
    expect(originValues).toEqual(expect.arrayContaining([
      'i.call_origin',
      'i.tool_name',
      'agent',
      'unknown',
      'activity:report',
      'coord:glance',
      'coord:inbox',
    ]));
    // activity:report appears in the legacy-name fallback for NULL-origin
    // rows, but an explicit hook origin must never enter the agent population.
    expect(originValues).not.toContain(hookOriginFixture.call_origin);
    expect(queryCall.values).toContain(originPredicate);
    const query = Array.from(queryCall.strings).join(' ');
    expect(query).toContain('i.args_json, i.metadata_json, i.call_origin, i.error_code, i.error_message');
    expect(query).toContain("e.body->>'plan_slug' AS declared_plan_slug");
    expect(query).toContain("e.body->'declared_plan_items' AS declared_plan_items");
    expect(query).toContain("e.body->'declared_goal_refs' AS declared_goal_refs");
    expect(query).toContain("f.last_launch_transaction AS launch_transaction");
    expect(query).toContain("LEFT JOIN harness_shared.agent_fleets AS f");
    expect(query).toContain("i.metadata_json->'launchOutcome'->>'transactionId'");
    expect(query).toContain('LEFT JOIN harness_shared.coord_event_log AS e');
    // WI-38670 live falsifier: the lifecycle intent `coord:emit` carried the old
    // EI goal under the new intent event id, then the first real call carried the
    // new goal. `coord:emit` is system-authored by contract, so it cannot be one
    // side of an agent reasoning/action divergence. `coord:send` is the
    // contextual, agent-authored sibling and must remain in the population.
    expect(query).toContain("tool_name <> 'coord:emit'");
    // A declaration invocation settles before its lifecycle append updates the
    // pointer, so its retrospective intent_event_id belongs to the prior
    // declaration. Keeping it would manufacture drift when the goal changed
    // as part of a legitimate re-declaration.
    expect(query).toContain("tool_name <> 'coord:declare-intent'");
    // coord:orient is the outer declaration/bootstrap wrapper. Its telemetry can
    // retain the pre-declaration goal while folded contextual reads carry the new
    // goal; the wrapper itself is control-plane state, not action evidence.
    expect(query).toContain("tool_name <> 'coord:orient'");
    expect(query).not.toContain("tool_name <> 'coord:send'");
    expect(query).toContain("tool_name = 'pot:wake'");
    expect(query).toContain("call_origin IS NULL");
    expect(query).toContain("args_json->>'source' = 'event'");
    expect(query).toContain("args_json->>'reason' LIKE 'subscribed event (%'");
  });

  it('hydrates typed declared goal refs from the durable intent event', async () => {
    const { sql } = mockSqlTag([
      {
        id: '7',
        owner: 'su-a',
        tool_name: 'coord:orient',
        status: 'ok',
        invoked_at: new Date(T0).toISOString(),
        intent_event_id: '42',
        goal_ref: 'WI-1',
        declared_plan_slug: 'shared-plan',
        declared_plan_items: ['P-016'],
        declared_goal_refs: ['WI-1', 'WI-2'],
        args_json: { source: 'test' },
        metadata_json: { dispatchWrapper: true },
        call_origin: null,
      },
    ]);

    const [call] = await loadRecentCalls({
      workspaceId: 'test-workspace',
      sinceMs: T0,
      limit: 10,
      sql: sql as never,
    });

    expect(call).toMatchObject({
      id: 7,
      intentEventId: 42,
      goalRef: 'WI-1',
      declaredPlanSlug: 'shared-plan',
      declaredPlanItems: ['P-016'],
      declaredGoalRefs: ['WI-1', 'WI-2'],
      metadataJson: { dispatchWrapper: true },
    });
  });

  it('hydrates a launch outcome from the persisted transaction joined by telemetry identity', async () => {
    const { sql } = mockSqlTag([
      {
        id: '8',
        owner: 'su-a',
        tool_name: 'fleet:launch-on-plan',
        status: 'timeout',
        error_code: 'timeout',
        error_message: 'statement timeout (PostgreSQL 57014)',
        invoked_at: new Date(T0).toISOString(),
        intent_event_id: null,
        goal_ref: null,
        declared_plan_slug: null,
        declared_plan_items: null,
        declared_goal_refs: null,
        args_json: { count: 1 },
        metadata_json: null,
        call_origin: null,
        launch_fleet: 'fleet-a',
        launch_transaction: {
          transactionId: 'tx-1',
          state: 'partial',
          openedMemberIds: ['member-1'],
          verifiedMemberIds: [],
          failed: [{ ownerId: 'member-2', phase: 'spawn', reason: 'refused' }],
        },
      },
    ]);

    const [call] = await loadRecentCalls({
      workspaceId: 'test-workspace',
      sinceMs: T0,
      limit: 10,
      sql: sql as never,
    });

    expect(call.launchOutcome).toEqual({
      fleet: 'fleet-a',
      transactionId: 'tx-1',
      state: 'partial',
      openedMemberIds: ['member-1'],
      verifiedMemberIds: [],
      failedOwnerIds: ['member-2'],
    });
    expect(call).toMatchObject({
      errorCode: 'timeout',
      errorMessage: 'statement timeout (PostgreSQL 57014)',
    });
  });
});

describe('loadTerminalGoalRefs', () => {
  it('includes blocked goals in the non-actionable resolver query', async () => {
    const sql = vi.fn(async () => [{ feature_id: 'WI-blocked' }]);
    const refs = await loadTerminalGoalRefs({
      workspaceId: 'test-workspace',
      goalRefs: ['WI-live', 'WI-blocked'],
      sql: sql as never,
    });

    expect(refs).toEqual(new Set(['WI-blocked']));
    const [template, ...values] = sql.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(Array.from(template).join(' ')).toContain('status = ANY');
    const stateValues = values.filter((value): value is string[] => Array.isArray(value));
    expect(stateValues.some((states) => states.includes('blocked'))).toBe(true);
  });
});

describe('formatDivergenceAlert', () => {
  const loop: Divergence = {
    kind: 'unconverged-retry-loop',
    ownerId: 'su-a',
    intentEventId: null,
    detail: 'work_items:claim failed 4× within 10min (invalid-input) without converging',
    a: { callId: 1, toolName: 'work_items:claim', status: 'invalid-input', invokedAt: 'T1', goalRef: null },
    b: { callId: 4, toolName: 'work_items:claim', status: 'invalid-input', invokedAt: 'T4', goalRef: null },
    retryLoop: {
      attempts: 4,
      argsChangedTransitions: 1,
      identicalRetries: 2,
      fallbackObserved: true,
      statuses: ['invalid-input'],
    },
  };

  it('addresses the agent in the second person and leads with evidence', () => {
    const { summary, body } = formatDivergenceAlert(loop);
    expect(summary).toContain('You called work_items:claim 4×');
    expect(body).toContain('call 1');
    expect(body).toContain('call 4');
  });

  it('names identical retries explicitly — they cannot succeed', () => {
    const body = formatDivergenceAlert(loop).body;
    expect(body).toContain('BYTE-IDENTICAL');
    expect(body).toContain('after non-transient failures');
  });

  it('says the threshold was measured, so it does not read as an accusation', () => {
    const body = formatDivergenceAlert(loop).body;
    expect(body).toContain('measured');
    expect(body).toContain('not an accusation');
  });

  it('formats goal drift with the typed multi-goal re-declaration shape', () => {
    const { summary, body } = formatDivergenceAlert({
      kind: 'goal-drift-within-intent',
      ownerId: 'su-a',
      intentEventId: 77,
      detail: 'one intent declaration spans goals WI-1 and WI-2',
      a: { callId: 1, toolName: 't', status: 'ok', invokedAt: 'T1', goalRef: 'WI-1' },
      b: { callId: 2, toolName: 't', status: 'ok', invokedAt: 'T2', goalRef: 'WI-2' },
    });
    expect(summary).toContain('WI-1');
    expect(summary).toContain('WI-2');
    expect(body).toContain("declared_goal_refs: ['WI-…', 'EI-…']");
    expect(body).toContain('A prose-only spanning intent or items: []');
  });
});

describe('divergenceFireKey', () => {
  it('keys a retry loop per (owner, tool) so two flails page independently', () => {
    const base = {
      kind: 'unconverged-retry-loop' as const,
      ownerId: 'su-a',
      intentEventId: null,
      detail: '',
      b: { callId: 2, toolName: 'x', status: null, invokedAt: '', goalRef: null },
    };
    const k1 = divergenceFireKey({
      ...base,
      a: { callId: 1, toolName: 'work_items:claim', status: null, invokedAt: '', goalRef: null },
    });
    const k2 = divergenceFireKey({
      ...base,
      a: { callId: 1, toolName: 'plans:get', status: null, invokedAt: '', goalRef: null },
    });
    expect(k1).not.toBe(k2);
    expect(k1).toContain('su-a');
  });

  // ── the intent leg: keyed on the CONDITION, never on the declaration ───────
  //
  // Regression for the debounce that never engaged. `intentEventId` is rewritten
  // by every coord:orient / coord:declare-intent, so keying on it minted a fresh
  // debounce slot every few minutes for an UNCHANGED divergence — measured at 112
  // fires under 112 distinct keys for one owner in 12h.
  const drift = (intentEventId: number | null, goalA: string | null, goalB: string | null) => ({
    kind: 'goal-drift-within-intent' as const,
    ownerId: 'su-a',
    intentEventId,
    detail: '',
    a: { callId: 1, toolName: 't', status: null, invokedAt: '', goalRef: goalA },
    b: { callId: 2, toolName: 't', status: null, invokedAt: '', goalRef: goalB },
  });

  it('is STABLE across re-declarations while the divergence is unchanged', () => {
    // Same owner, same two goals, different declaration events. One condition.
    expect(divergenceFireKey(drift(1001, 'WI-1', 'WI-2'))).toBe(
      divergenceFireKey(drift(2002, 'WI-1', 'WI-2')),
    );
  });

  it('does NOT embed the declaration event id', () => {
    // Guards the specific dead-lookup shape rather than only its consequence.
    expect(divergenceFireKey(drift(1001, 'WI-1', 'WI-2'))).not.toContain('1001');
  });

  it('still pages independently when the goals genuinely change', () => {
    // State-change suppression must suppress UNCHANGED state only.
    expect(divergenceFireKey(drift(1001, 'WI-1', 'WI-2'))).not.toBe(
      divergenceFireKey(drift(1001, 'WI-1', 'WI-3')),
    );
  });

  it('treats (a,b) and (b,a) as one condition, not two', () => {
    expect(divergenceFireKey(drift(1001, 'WI-1', 'WI-2'))).toBe(
      divergenceFireKey(drift(1001, 'WI-2', 'WI-1')),
    );
  });
});

describe('divergenceSweep — the delivery orderings', () => {
  it('notifies THE AGENT ITSELF and does not escalate on first sight', async () => {
    const d = deps();
    const out = await divergenceSweep(d);
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
    expect(d.openEscalation).not.toHaveBeenCalled();
    expect(out.outcomes[0].outcome).toBe('notified');
    // Addressed to the agent, not broadcast.
    const [, opts] = (d.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.to).toEqual(['su-a']);
  });

  it('escalates to the leader ONLY on a repeat, and still tells the agent', async () => {
    // Nothing inside the debounce window, but something inside the repeat window.
    const recentWatchdogFires = vi.fn(async (_ws, _slug, hours: number) =>
      hours === DIVERGENCE_REPEAT_LOOKBACK_HOURS ? 1 : 0,
    );
    const d = deps({ recentWatchdogFires } as never);
    const out = await divergenceSweep(d);
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
    expect(d.openEscalation).toHaveBeenCalledTimes(1);
    expect(out.outcomes[0].outcome).toBe('escalated');
    const [, esc] = (d.openEscalation as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(esc.summary).toContain('REPEAT');
  });

  it('debounces when the fire slot is already claimed — no message, no escalation', async () => {
    const d = deps({ claimWatchdogFire: vi.fn(async () => false) } as never);
    const out = await divergenceSweep(d);
    expect(d.sendMessage).not.toHaveBeenCalled();
    expect(d.openEscalation).not.toHaveBeenCalled();
    expect(out.outcomes[0].outcome).toBe('debounced');
  });

  it('claims the fire BEFORE notifying, so a crash cannot re-page forever', async () => {
    const d = deps();
    await divergenceSweep(d);
    const fireOrder = (d.claimWatchdogFire as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const sendOrder = (d.sendMessage as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(fireOrder).toBeLessThan(sendOrder);
  });

  // ── EI-18824142520274965: the debounce that could never match ──────────────
  //
  // The regression that produced 113 fires across 2 conditions in 37 minutes.
  // `claimWatchdogFire`/`recentWatchdogFires` resolve a `scopeKey` as
  // `reason LIKE '%scopeKey%'`, so recording the bare summary — which never
  // contains `<ownerId>:<toolName>` — left the debounce structurally unable to
  // find its own prior fires. Asserting on the RECORDED REASON is what pins it:
  // a test that only checked "was it called" passed throughout the outage.
  it('records the fire under a reason CONTAINING the scope key, or the debounce cannot match', async () => {
    const d = deps();
    await divergenceSweep(d);
    const [claim] = (d.claimWatchdogFire as ReturnType<typeof vi.fn>).mock.calls[0];
    const key = `su-a:work_items:claim`;
    expect(claim.scopeKey).toBe(key);
    expect(claim.reason).toContain(key);
    expect(claim.windowHours).toBe(DIVERGENCE_DEBOUNCE_HOURS);
  });

  it('reads isRepeat BEFORE claiming, so its own fire cannot pin it to true', async () => {
    const d = deps();
    await divergenceSweep(d);
    const repeatRead = (d.recentWatchdogFires as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const claim = (d.claimWatchdogFire as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(repeatRead).toBeLessThan(claim);
  });
});

describe('divergenceSweep — what it refuses to deliver', () => {
  it('suppresses a clean window and says WHICH zero it was', async () => {
    const d = deps({ loadRecentCalls: vi.fn(async () => []) } as never);
    const out = await divergenceSweep(d);
    expect(d.sendMessage).not.toHaveBeenCalled();
    expect(out.outcomes[0].outcome).toBe('suppressed');
    expect(out.outcomes[0].reason).toContain('STRUCTURAL ZERO');
  });

  it('carries the coverage out so a caller can log the stamp fill rate', async () => {
    const out = await divergenceSweep(deps());
    expect(out.report?.coverage.stampFillRate).toBe(0);
    expect(out.report?.coverage.failuresSeen).toBe(RETRY_THRASH_THRESHOLD);
  });

  it('is fail-soft when the PG read throws', async () => {
    const d = deps({
      loadRecentCalls: vi.fn(async () => {
        throw new Error('pg down');
      }),
    } as never);
    const out = await divergenceSweep(d);
    expect(out.outcomes[0].outcome).toBe('error');
    expect(out.outcomes[0].reason).toContain('pg down');
    expect(out.report).toBeNull();
  });

  it('is fail-soft per finding when a notification throws', async () => {
    const d = deps({
      sendMessage: vi.fn(async () => {
        throw new Error('coord down');
      }),
    } as never);
    const out = await divergenceSweep(d);
    expect(out.outcomes[0].outcome).toBe('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P-010 — terminal-goal resolution, and what happens when it fails
// ─────────────────────────────────────────────────────────────────────────────

/** Two calls under one intent, drifting between two goals — the shape of the real alert. */
function goalDriftCalls(a = 'EI-1', b = 'EI-2'): DivergenceCall[] {
  return [
    { id: 1, ownerId: 'su-a', toolName: 'coord:orient', status: 'ok', invokedAt: new Date(T0).toISOString(), intentEventId: 42, goalRef: a },
    { id: 2, ownerId: 'su-a', toolName: 'coord:orient', status: 'ok', invokedAt: new Date(T0 + 1000).toISOString(), intentEventId: 42, goalRef: b },
  ];
}

describe('P-010 — the sweep resolves goal state before it pages anyone', () => {
  it('CAPABILITY: pages when both goals are live', async () => {
    const d = deps({ loadRecentCalls: vi.fn(async () => goalDriftCalls()) } as never);
    const out = await divergenceSweep(d);
    expect(out.outcomes.map((o) => o.outcome)).toEqual(['notified']);
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when both goals are already terminal — the live defect', async () => {
    const d = deps({
      loadRecentCalls: vi.fn(async () => goalDriftCalls()),
      loadTerminalGoalRefs: vi.fn(async () => new Set(['EI-1', 'EI-2'])),
    } as never);
    const out = await divergenceSweep(d);
    expect(d.sendMessage).not.toHaveBeenCalled();
    expect(out.report?.structuralZero).toBe('all-goals-terminal');
    expect(out.outcomes[0].reason).toMatch(/STRUCTURAL ZERO/);
  });

  it('sends nothing when the secondary goal is blocked — the held-dependency false positive', async () => {
    const d = deps({
      loadRecentCalls: vi.fn(async () => goalDriftCalls('WI-live', 'WI-blocked')),
      loadTerminalGoalRefs: vi.fn(async () => new Set(['WI-blocked'])),
    } as never);
    const out = await divergenceSweep(d);
    expect(d.sendMessage).not.toHaveBeenCalled();
    expect(out.report?.divergences).toEqual([]);
    expect(out.report?.coverage.terminalGoalCallsExcluded).toBe(1);
  });

  it('passes every cited goal ref to the resolver, deduped', async () => {
    const d = deps({ loadRecentCalls: vi.fn(async () => goalDriftCalls('EI-1', 'EI-1')) } as never);
    await divergenceSweep(d);
    expect(d.loadTerminalGoalRefs).toHaveBeenCalledWith(
      expect.objectContaining({ goalRefs: ['EI-1', 'EI-1'] }),
    );
  });

  /**
   * ⚠ FAIL CLOSED. The tempting fallback when goal state is unreadable is to run
   * the detector unfiltered — but unfiltered IS the bug, so that would reinstate it
   * at exactly the moment the database is least healthy, and the resulting page
   * would look identical to a legitimate one. The goal leg is withheld instead.
   */
  it('withholds the goal leg — and says why — when goal state cannot be resolved', async () => {
    const d = deps({
      loadRecentCalls: vi.fn(async () => goalDriftCalls()),
      loadTerminalGoalRefs: vi.fn(async () => {
        throw new Error('pg down');
      }),
    } as never);
    const out = await divergenceSweep(d);
    expect(d.sendMessage).not.toHaveBeenCalled();
    expect(out.outcomes[0].outcome).toBe('suppressed');
    expect(out.outcomes[0].reason).toMatch(/goal state unresolvable/);
    expect(out.outcomes[0].reason).toMatch(/pg down/);
  });

  /**
   * ...but the failure is SCOPED to the leg that depends on it. The retry-loop leg
   * reads no goal state, so a dead work_items read must not silence it — that would
   * turn one unreadable table into a fleet-wide blind spot.
   */
  it('still delivers the sampling leg when goal resolution failed', async () => {
    const d = deps({
      loadTerminalGoalRefs: vi.fn(async () => {
        throw new Error('pg down');
      }),
    } as never);
    const out = await divergenceSweep(d);
    expect(out.outcomes.map((o) => o.outcome)).toEqual(['notified']);
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
  });
});
