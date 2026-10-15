import { describe, expect, it } from 'vitest';
import type { AutomationItem, AutomationSourceItem, AutomationTrigger } from './workflows-model';
import {
  buildFacetCounts,
  buildLedgerRows,
  buildNeedsYou,
  dispatcherDependentWorkflows,
  TRIGGER_DISPATCH_ROUTINE,
  triggerDispatcherState,
  buildPopulationSummary,
  buildSourceHealth,
  buildSuggestionChips,
  collapseNeedsYou,
  filterLedgerRows,
  sortLedgerRows,
  spendToken,
  type LedgerRow,
  type LedgerSourceInput,
} from './workflows-ledger-model';

const NOW = Date.parse('2026-08-28T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function trigger(over: Partial<AutomationTrigger> = {}): AutomationTrigger {
  return {
    id: 'schedule:papercusp:nightly',
    kind: 'schedule',
    provider: 'schedule',
    label: 'FREQ=DAILY · BYHOUR=9',
    detail: 'America/New_York',
    armed: true,
    ...over,
  };
}

function item(over: Partial<AutomationItem> = {}): AutomationItem {
  return {
    id: "plan:papercusp:nightly-audit",
    kind: "triggered-plan",
    label: "Nightly release audit",
    description: "Audits yesterday’s releases",
    harness: "papercusp",
    planSlug: "nightly-audit",
    operation: null,
    routine: null,
    triggers: [trigger()],
    running: false,
    paused: false,
    needsAttention: false,
    nextAt: NOW + 6 * HOUR,
    lastAt: NOW - 9 * HOUR,
    timingLabel: "Next in 6h",
    spendLabel: "Run-linked cost available in details",
    flow: {
      sourceLabel: "Schedule",
      sourceDetail: "1/1 automatic armed",
      sourceState: "ready",
      planDetail: "papercusp · Ready",
      outcomeLabel: "Audit report",
      outcomeDetail: "Last observed outcome · Completed",
      outcomeState: "completed",
    },
    ...over,
  };
}

function routineItem(over: Partial<AutomationItem> = {}): AutomationItem {
  return item({
    id: 'routine:git-sync:papercusp',
    kind: 'system-task',
    label: 'git-sync',
    planSlug: null,
    flow: null,
    spendLabel: '$0 model spend',
    // Only the fields the model reads are needed; the cast keeps the fixture honest about
    // that rather than fabricating a whole AutomationRoutine.
    routine: { spend: 'none' } as AutomationItem['routine'],
    triggers: [trigger({ id: 'routine-trigger:git-sync', provider: 'routines', armed: true })],
    ...over,
  });
}

function source(over: Partial<LedgerSourceInput> = {}): LedgerSourceInput {
  return {
    id: 'source-slack',
    kind: 'slack',
    status: 'connected',
    lastError: null,
    failedDeliveries24h: 0,
    bindingCount: 2,
    ...over,
  };
}

describe('buildLedgerRows', () => {
  it("maps plan and operation workflows onto triggered, beside routine and system facets", () => {
    const rows = buildLedgerRows(
      [
        item(),
        item({ id: "op", kind: "triggered-operation" }),
        routineItem({ id: "r1", kind: "ai-routine" }),
        routineItem({ id: "r2", kind: "system-task" }),
      ],
      { nowMs: NOW },
    );
    expect(rows.map((row) => row.kind)).toEqual([
      "triggered",
      "triggered",
      "routine",
      "system",
    ]);
  });

  it('reports one state word, attention outranking running and paused', () => {
    const state = (over: Partial<AutomationItem>) =>
      buildLedgerRows([item(over)], { nowMs: NOW })[0].state;
    expect(state({ needsAttention: true, running: true, paused: true })).toBe('attention');
    expect(state({ running: true, paused: true })).toBe('running');
    expect(state({ paused: true })).toBe('paused');
    expect(state({})).toBe('ready');
  });

  it('renders a never-fired workflow as null rather than a fabricated time', () => {
    const [row] = buildLedgerRows([item({ lastAt: null })], { nowMs: NOW });
    expect(row.lastLabel).toBeNull();
  });

  it('says paused rather than promising a next fire a disarmed trigger will not honour', () => {
    // A stale occurrence can outlive the disarm, so the paused check must come FIRST.
    const [row] = buildLedgerRows([item({ paused: true, nextAt: NOW + 6 * HOUR })], { nowMs: NOW });
    expect(row.nextLabel).toBe('paused');
  });

  it('says "on event" for an event-driven trigger and an em dash when nothing is knowable', () => {
    const [eventRow] = buildLedgerRows(
      [item({ nextAt: null, triggers: [trigger({ kind: 'external', provider: 'slack' })] })],
      { nowMs: NOW },
    );
    expect(eventRow.nextLabel).toBe('on event');

    const [unknownRow] = buildLedgerRows([item({ nextAt: null, triggers: [] })], { nowMs: NOW });
    expect(unknownRow.nextLabel).toBe('—');
  });

  it('ignores an occurrence that has already passed', () => {
    const [row] = buildLedgerRows([item({ nextAt: NOW - HOUR, triggers: [] })], { nowMs: NOW });
    expect(row.nextLabel).toBe('—');
  });

  it('summarises armed state across triggers and reports unknown as null', () => {
    const armedRow = buildLedgerRows([item({
      triggers: [trigger({ armed: true }), trigger({ id: 't2', armed: false })],
    })], { nowMs: NOW })[0];
    expect(armedRow).toMatchObject({ armed: true, armedCount: 1, triggerCount: 2 });

    const unknownRow = buildLedgerRows([item({
      triggers: [trigger({ armed: null })],
    })], { nowMs: NOW })[0];
    expect(unknownRow.armed).toBeNull();

    const untriggeredRow = buildLedgerRows([item({ triggers: [] })], { nowMs: NOW })[0];
    expect(untriggeredRow).toMatchObject({ armed: null, armedCount: 0, triggerCount: 0 });
  });

  it('builds the chain from the flow when there is one and from the triggers when there is not', () => {
    const [planRow] = buildLedgerRows([item()], { nowMs: NOW });
    expect(planRow.chain).toEqual({ trigger: 'Schedule', plan: 'nightly-audit', outcome: 'Audit report' });

    const [systemRow] = buildLedgerRows([routineItem()], { nowMs: NOW });
    expect(systemRow.chain).toEqual({ trigger: 'Routines', plan: 'system task', outcome: null });

    const [aiRow] = buildLedgerRows([routineItem({ kind: 'ai-routine' })], { nowMs: NOW });
    expect(aiRow.chain.plan).toBe('routine');

    const [operationRow] = buildLedgerRows(
      [
        item({
          kind: "triggered-operation",
          planSlug: null,
          operation: {
            harnessSlug: "papercusp",
            operationId: "triage-message",
            specificationRevision: null,
            target: null,
            handle: null,
          },
        }),
      ],
      { nowMs: NOW },
    );
    expect(operationRow.chain.plan).toBe("papercusp#triage-message");
  });

  it('collects distinct trigger providers as the source facet tokens', () => {
    const [row] = buildLedgerRows([item({
      triggers: [
        trigger({ provider: 'slack' }),
        trigger({ id: 't2', provider: 'slack' }),
        trigger({ id: 't3', provider: 'schedule' }),
      ],
    })], { nowMs: NOW });
    expect(row.sourceKinds).toEqual(['slack', 'schedule']);
  });
});

describe('spendToken (D-005)', () => {
  it('never invents dollars for a triggered plan', () => {
    expect(spendToken(item())).toBe('per run');
    expect(spendToken(item({ kind: "triggered-operation" }))).toBe("per run");
  });

  it('renders the routine classification the producer actually asserts', () => {
    expect(spendToken(routineItem())).toBe('$0');
    expect(spendToken(routineItem({ routine: { spend: 'unknown' } as AutomationItem['routine'] }))).toBe('unknown');
    // 'llm' is the producer's own token for a routine that dispatches an agent.
    expect(spendToken(routineItem({ routine: { spend: 'llm' } as AutomationItem['routine'] }))).toBe('possible');
  });
});

describe('buildFacetCounts', () => {
  it('counts the whole population, not the filtered view', () => {
    const rows = buildLedgerRows([
      item({ id: 'a', needsAttention: true }),
      item({ id: 'b', running: true }),
      item({ id: 'c', paused: true }),
      routineItem({ id: 'd', kind: 'ai-routine' }),
      routineItem({ id: 'e' }),
    ], { nowMs: NOW });
    expect(buildFacetCounts(rows)).toEqual({
      all: 5, attention: 1, running: 1, paused: 1, triggered: 3, routine: 1, system: 1,
    });
  });
});

describe('filterLedgerRows', () => {
  const rows = buildLedgerRows([
    item({ id: 'attention', label: 'Invoice filing', needsAttention: true, triggers: [trigger({ provider: 'gmail' })] }),
    item({ id: 'running', label: 'Client reply', running: true, triggers: [trigger({ provider: 'gmail' })] }),
    item({ id: 'paused', label: 'Stale PR nudge', paused: true }),
    routineItem({ id: 'system', label: 'git-sync' }),
  ], { nowMs: NOW });

  it('filters by state facet', () => {
    expect(filterLedgerRows(rows, { state: 'attention' }).map((r) => r.id)).toEqual(['attention']);
    expect(filterLedgerRows(rows, { state: 'running' }).map((r) => r.id)).toEqual(['running']);
    expect(filterLedgerRows(rows, { state: 'paused' }).map((r) => r.id)).toEqual(['paused']);
    expect(filterLedgerRows(rows, { state: 'all' })).toHaveLength(4);
  });

  it('filters by kind facet', () => {
    expect(filterLedgerRows(rows, { kind: 'system' }).map((r) => r.id)).toEqual(['system']);
    expect(filterLedgerRows(rows, { kind: 'triggered' })).toHaveLength(3);
  });

  it('filters by source token', () => {
    expect(filterLedgerRows(rows, { source: 'gmail' }).map((r) => r.id)).toEqual(['attention', 'running']);
  });

  it('searches label, plan slug and chain', () => {
    expect(filterLedgerRows(rows, { query: 'invoice' }).map((r) => r.id)).toEqual(['attention']);
    expect(filterLedgerRows(rows, { query: 'nightly-audit' })).toHaveLength(3);
    expect(filterLedgerRows(rows, { query: '   ' })).toHaveLength(4);
  });

  it('intersects facets rather than widening', () => {
    expect(filterLedgerRows(rows, { state: 'attention', kind: 'system' })).toEqual([]);
  });
});

describe('sortLedgerRows', () => {
  const rows = buildLedgerRows([
    item({ id: 'ready-late', label: 'Zulu', nextAt: NOW + 9 * HOUR, lastAt: NOW - 2 * HOUR }),
    item({ id: 'paused', label: 'Alpha', paused: true, nextAt: null, lastAt: NOW - HOUR }),
    item({ id: 'attention', label: 'Mike', needsAttention: true, nextAt: NOW + 8 * HOUR, lastAt: NOW - 30 * MINUTE }),
    item({ id: 'running', label: 'Bravo', running: true, nextAt: NOW + HOUR, lastAt: null }),
    item({ id: 'ready-soon', label: 'Yankee', nextAt: NOW + 2 * HOUR, lastAt: NOW - 3 * HOUR }),
  ], { nowMs: NOW });

  it('puts what needs a human first, then running, then soonest, with paused last', () => {
    expect(sortLedgerRows(rows, 'attention').map((r) => r.id))
      .toEqual(['attention', 'running', 'ready-soon', 'ready-late', 'paused']);
  });

  it('sorts by name, most recent, and soonest on request', () => {
    expect(sortLedgerRows(rows, 'name').map((r) => r.label))
      .toEqual(['Alpha', 'Bravo', 'Mike', 'Yankee', 'Zulu']);
    expect(sortLedgerRows(rows, 'last')[0].id).toBe('attention');
    // A never-fired row sorts last under `last`, not first.
    expect(sortLedgerRows(rows, 'last').at(-1)?.id).toBe('running');
    expect(sortLedgerRows(rows, 'next')[0].id).toBe('running');
    // A row with no next occurrence sorts last under `next`.
    expect(sortLedgerRows(rows, 'next').at(-1)?.id).toBe('paused');
  });

  it('does not mutate its input', () => {
    const before = rows.map((row) => row.id);
    sortLedgerRows(rows, 'name');
    expect(rows.map((row) => row.id)).toEqual(before);
  });

  it('is a total order — equal rows fall through to the label', () => {
    const tied = buildLedgerRows([
      item({ id: 'b', label: 'Beta', nextAt: NOW + HOUR }),
      item({ id: 'a', label: 'Alpha', nextAt: NOW + HOUR }),
    ], { nowMs: NOW });
    expect(sortLedgerRows(tied, 'attention').map((r) => r.label)).toEqual(['Alpha', 'Beta']);
  });
});

describe('buildSourceHealth', () => {
  const sources: AutomationSourceItem[] = [
    { id: 'source:schedule', kind: 'schedule', label: 'Schedule', status: '4 armed', detail: '', bindingCount: 5, armedCount: 4 },
    { id: 'source:slack', kind: 'external', label: 'slack', status: 'connected', detail: '', bindingCount: 2, armedCount: 1 },
    { id: 'source:webhook', kind: 'external', label: 'webhook', status: 'token expired', detail: '', bindingCount: 1, armedCount: 0 },
  ];

  it('emits a token that matches the trigger provider on the rows it filters', () => {
    const health = buildSourceHealth(sources);
    expect(health.map((entry) => entry.token)).toEqual(['schedule', 'slack', 'webhook']);

    // The pill is a legend AND a filter, so its token must actually select rows.
    const rows = buildLedgerRows([item({ triggers: [trigger({ provider: 'slack' })] })], { nowMs: NOW });
    expect(filterLedgerRows(rows, { source: health[1].token })).toHaveLength(1);
  });

  it('reads bad only for a disconnected external source', () => {
    expect(buildSourceHealth(sources).map((entry) => entry.tone)).toEqual(['ok', 'ok', 'bad']);
  });

  it('emits ONE pill per kind, summing several accounts of that kind', () => {
    // Observed live: two Gmail source rows rendered "Gmail 0/1" beside "Gmail 0/2" — two
    // controls with the same name that filter identically, because the token is the kind.
    const health = buildSourceHealth([
      ...sources,
      { id: 'source:gmail-a', kind: 'external', label: 'gmail', status: 'connected', detail: '', bindingCount: 1, armedCount: 1 },
      { id: 'source:gmail-b', kind: 'external', label: 'gmail', status: 'connected', detail: '', bindingCount: 2, armedCount: 0 },
    ]);
    const gmail = health.filter((entry) => entry.token === 'gmail');
    expect(gmail).toHaveLength(1);
    expect(gmail[0]).toMatchObject({ armedCount: 1, bindingCount: 3, tone: 'ok' });
  });

  it('degrades a kind to bad when ANY account of that kind is unhealthy', () => {
    // A legend reading "ok" while one of its two accounts is dead is the failure to avoid.
    const health = buildSourceHealth([
      { id: 'source:gmail-a', kind: 'external', label: 'gmail', status: 'connected', detail: '', bindingCount: 1, armedCount: 1 },
      { id: 'source:gmail-b', kind: 'external', label: 'gmail', status: 'token expired', detail: '', bindingCount: 1, armedCount: 0 },
    ]);
    expect(health).toHaveLength(1);
    expect(health[0]).toMatchObject({ tone: 'bad', status: 'token expired', armedCount: 1, bindingCount: 2 });
  });
});

describe('trigger dispatcher pause (WI-10004922)', () => {
  const healthyRow = { id: 'a', label: 'Nightly release audit', needsAttention: false };

  it('reads the dispatcher from the catalog, and treats a missing row as UNKNOWN, never paused', () => {
    expect(triggerDispatcherState(undefined)).toBeNull();
    expect(triggerDispatcherState([{ name: 'git-sync', active: false }])).toBeNull();
    expect(triggerDispatcherState([{ name: TRIGGER_DISPATCH_ROUTINE, active: false }])).toEqual({ active: false });
    // Active in any install means runs drain somewhere.
    expect(
      triggerDispatcherState([
        { name: TRIGGER_DISPATCH_ROUTINE, active: false },
        { name: TRIGGER_DISPATCH_ROUTINE, active: true },
      ]),
    ).toEqual({ active: true });
  });

  it('raises a leading bad item when armed triggered workflows cannot fire', () => {
    const items = buildNeedsYou({
      sources: [source({ status: 'token expired', bindingCount: 1 })],
      rows: [healthyRow],
      dispatcher: { active: false, heldWorkflows: 2 },
    });
    expect(items[0]).toMatchObject({ kind: 'dispatch-paused', severity: 'bad' });
    expect(items[0].message).toContain('2 armed workflows');
    // It stays first after collapsing, ahead of the reconnect item.
    expect(collapseNeedsYou(items).rows[0].kind).toBe('dispatch-paused');
  });

  it('counts only workflows with an ARMED event trigger as held, never schedule-only plans', () => {
    const external = (armed: boolean | null): AutomationTrigger =>
      trigger({
        id: `external:b-${String(armed)}`,
        kind: 'external',
        provider: 'google calendar',
        armed,
        bindingId: `b-${String(armed)}`,
      });
    const scheduleOnly = item({ id: 'plan:papercusp:nightly', triggers: [trigger({ armed: true })] });
    const armedEvent = item({ id: 'plan:papercusp:on-meeting', triggers: [external(true)] });
    const disarmedEvent = item({ id: 'plan:papercusp:on-mail', triggers: [external(false)] });
    const unknownEvent = item({ id: 'plan:papercusp:on-post', triggers: [external(null)] });
    const mixed = item({ id: 'plan:papercusp:both', triggers: [trigger({ armed: true }), external(true)] });

    // The false alarm this guards: an armed schedule is a `triggered` ledger row, but a
    // dispatcher pause does not stop it.
    expect(buildLedgerRows([scheduleOnly], { nowMs: NOW })[0]).toMatchObject({ kind: 'triggered', paused: false });
    expect(dispatcherDependentWorkflows([scheduleOnly])).toBe(0);
    expect(dispatcherDependentWorkflows([armedEvent, mixed])).toBe(2);
    // Disarmed or unknown-armed event triggers are not counted as held.
    expect(dispatcherDependentWorkflows([disarmedEvent, unknownEvent])).toBe(0);
    // WI-10004955: an armed event trigger with no binding (a sync-triggered routine such as
    // doc-freshness-sweep) never passes through the dispatcher, so a pause does not hold it.
    const syncSweep = item({
      id: 'routine:doc-freshness-sweep:papercusp',
      kind: 'system-task',
      triggers: [trigger({ id: 'routine-trigger:doc-freshness-sweep:papercusp', kind: 'external', provider: 'sync triggered', armed: true })],
    });
    expect(dispatcherDependentWorkflows([syncSweep])).toBe(0);
    expect(dispatcherDependentWorkflows([syncSweep, armedEvent])).toBe(1);
    expect(
      buildNeedsYou({
        sources: [],
        rows: [],
        dispatcher: { active: false, heldWorkflows: dispatcherDependentWorkflows([scheduleOnly, disarmedEvent]) },
      }),
    ).toEqual([]);
  });

  it('stays silent when the dispatcher runs, is unknown, or nothing armed depends on it', () => {
    expect(buildNeedsYou({ sources: [], rows: [healthyRow], dispatcher: { active: true, heldWorkflows: 3 } })).toEqual([]);
    expect(buildNeedsYou({ sources: [], rows: [healthyRow], dispatcher: null })).toEqual([]);
    expect(buildNeedsYou({ sources: [], rows: [healthyRow], dispatcher: { active: false, heldWorkflows: 0 } })).toEqual([]);
  });
});

describe('buildNeedsYou (D-018, preserved by D-004)', () => {
  const healthyRow = { id: 'a', label: 'Nightly release audit', needsAttention: false };

  it('renders NOTHING when nothing needs the operator — no "all clear" item', () => {
    expect(buildNeedsYou({ sources: [source()], rows: [healthyRow] })).toEqual([]);
  });

  it('escalates a disconnected source that something actually depends on', () => {
    const [entry] = buildNeedsYou({
      sources: [source({ status: 'token expired', bindingCount: 1 })],
      rows: [healthyRow],
    });
    expect(entry).toMatchObject({ kind: 'reconnect', severity: 'bad', actionLabel: 'Reconnect' });
    expect(entry.message).toBe('Slack is token expired');
  });

  it('stays quiet about a disconnected source with no bindings', () => {
    expect(buildNeedsYou({
      sources: [source({ status: 'token expired', bindingCount: 0 })],
      rows: [healthyRow],
    })).toEqual([]);
  });

  it('reports the source error verbatim when it has one', () => {
    const [entry] = buildNeedsYou({
      sources: [source({ status: 'error', lastError: 'refresh token revoked', bindingCount: 3 })],
      rows: [healthyRow],
    });
    expect(entry.message).toBe('Slack is failing: refresh token revoked');
  });

  it('counts failed deliveries with correct singular and plural', () => {
    const one = buildNeedsYou({ sources: [source({ failedDeliveries24h: 1 })], rows: [] });
    expect(one[0].message).toContain('1 failed delivery in the last 24h');
    const many = buildNeedsYou({ sources: [source({ failedDeliveries24h: 4 })], rows: [] });
    expect(many[0].message).toContain('4 failed deliveries in the last 24h');
  });

  it('escalates a workflow that needs attention', () => {
    const [entry] = buildNeedsYou({
      sources: [source()],
      rows: [{ id: 'plan:x', label: 'Invoice filing', needsAttention: true }],
    });
    expect(entry).toMatchObject({
      id: 'needs-you:workflow:plan:x',
      message: 'Invoice filing needs attention',
      severity: 'warn',
    });
  });
});

describe('collapseNeedsYou', () => {
  const workflowItem = (n: number) => ({
    id: `needs-you:workflow:plan:${n}`,
    kind: 'review-runs' as const,
    message: `Workflow ${n} needs attention`,
    actionLabel: 'Review runs',
    severity: 'warn' as const,
  });
  const sourceItem = (id: string, severity: 'bad' | 'warn' = 'bad') => ({
    id: `needs-you:source:${id}`,
    kind: 'reconnect' as const,
    message: `${id} is disconnected`,
    actionLabel: 'Reconnect',
    severity,
  });

  it('keeps the empty case empty — collapsing must not manufacture a row', () => {
    expect(collapseNeedsYou([])).toEqual({ rows: [], hiddenCount: 0 });
  });

  it('collapses many per-workflow items into one counted row', () => {
    // The measured real workspace raised 55 items; 55 stacked lines is not an interrupt.
    const { rows, hiddenCount } = collapseNeedsYou(
      Array.from({ length: 12 }, (_, i) => workflowItem(i)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'needs-you:workflows-attention',
      message: '12 workflows need attention',
      severity: 'warn',
    });
    expect(hiddenCount).toBe(0);
  });

  it('leaves a lone workflow item as itself rather than counting it', () => {
    const { rows } = collapseNeedsYou([workflowItem(1)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe('Workflow 1 needs attention');
  });

  it('keeps source problems individual and orders a dead connection first', () => {
    const { rows } = collapseNeedsYou([
      { ...sourceItem('slack', 'warn'), id: 'needs-you:dead-letter:slack', kind: 'review-runs' },
      sourceItem('webhook'),
    ]);
    expect(rows.map((row) => row.severity)).toEqual(['bad', 'warn']);
  });

  it('caps the rows and reports what it held back', () => {
    const { rows, hiddenCount } = collapseNeedsYou(
      [sourceItem('a'), sourceItem('b'), sourceItem('c'), sourceItem('d'), sourceItem('e')],
      { maxRows: 3 },
    );
    expect(rows).toHaveLength(3);
    expect(hiddenCount).toBe(2);
  });

  it('counts the ITEMS a dropped aggregate stood for, not the row', () => {
    // A strip hiding "one row" must not be hiding fifty problems silently.
    const items = [
      sourceItem('a'), sourceItem('b'), sourceItem('c'),
      ...Array.from({ length: 9 }, (_, i) => workflowItem(i)),
    ];
    const { rows, hiddenCount } = collapseNeedsYou(items, { maxRows: 3 });
    expect(rows).toHaveLength(3);
    expect(hiddenCount).toBe(9);
  });
});

describe('buildSuggestionChips', () => {
  it('suggests only what a connected source could actually wire', () => {
    const chips = buildSuggestionChips([
      source({ kind: 'slack' }),
      source({ id: 'gmail', kind: 'gmail' }),
      source({ id: 'dead', kind: 'google-calendar', status: 'token expired' }),
    ]);
    expect(chips.map((chip) => chip.sourceKind)).toEqual(['slack', 'gmail']);
  });

  it('skips a source kind it has no operator-language prompt for', () => {
    expect(buildSuggestionChips([source({ kind: 'google-pubsub' })])).toEqual([]);
  });

  it('emits one chip per kind even with several sources of that kind', () => {
    expect(buildSuggestionChips([source({ kind: 'slack' }), source({ id: 'two', kind: 'slack' })])).toHaveLength(1);
  });
});

describe('buildPopulationSummary', () => {
  it('names only the populations that exist', () => {
    const counts = buildFacetCounts(buildLedgerRows([item(), routineItem()], { nowMs: NOW }));
    expect(buildPopulationSummary(counts)).toBe('1 triggered · 1 system task');
  });

  it('pluralises and omits empty populations', () => {
    const rows: LedgerRow[] = buildLedgerRows([item({ id: 'a' }), item({ id: 'b' })], { nowMs: NOW });
    expect(buildPopulationSummary(buildFacetCounts(rows))).toBe('2 triggered');
  });
});
