import { describe, expect, it } from 'vitest';
import type { AutomationCatalog, AutomationRoutine } from '@papercusp/operator-core/lib/automation/catalog';
import type { ExternalTriggerAdminSnapshot } from '@papercusp/operator-core/lib/external-triggers/admin';
import {
  buildAutomationActivity,
  buildAutomationFlows,
  buildAutomationItems,
  buildAutomationSources,
  filterAutomationItems,
  nextFutureAutomationAt,
  type BuildAutomationModelInput,
} from './workflows-model';
import { dispatcherDependentWorkflows } from './workflows-ledger-model';

const NOW = Date.parse('2026-08-22T20:00:00.000Z');

function routine(overrides: Partial<AutomationRoutine> = {}): AutomationRoutine {
  return {
    name: 'git-sync',
    installSlug: 'papercusp',
    group: 'git-sync',
    category: 'infra',
    cron: '0 */2 * * * *',
    cadence: 'every 2m',
    active: true,
    spend: 'none',
    spendWhy: 'Runs inline',
    spawnsAgent: false,
    kind: 'scheduled',
    family: 'git-release',
    liveness: 'running',
    armedState: 'armed',
    control: 'routine',
    controlWhy: 'Pause from routines:set',
    flagKey: null,
    needsAttention: false,
    installs: ['papercusp'],
    ownerId: null,
    ownerLastActiveAt: null,
    triggerLabel: null,
    lastFiredAt: '2026-08-22T19:58:00.000Z',
    nextFireAt: '2026-08-22T20:02:00.000Z',
    source: 'routines',
    controllable: true,
    ...overrides,
  };
}

function fixture(): BuildAutomationModelInput {
  const catalog: AutomationCatalog = {
    routines: [
      routine(),
      routine({
        name: 'doc-steward',
        spend: 'llm',
        spendWhy: 'Spawns a doc agent',
        spawnsAgent: true,
        family: 'docs',
        category: 'docs',
        nextFireAt: '2026-08-22T20:10:00.000Z',
      }),
    ],
    categories: [],
    spend7d: [],
    spend7dTotalUsd: 12.5,
    // potScope null = the scope read did not happen for this fixture. NOT an empty
    // scope, which would assert "every pot is learning" (learning-pot-scope-gate).
    arming: { gymPots: [], lanes: [], scoutCeiling: null, potScope: null },
    generatedAt: '2026-08-22T20:00:00.000Z',
  };
  const external: ExternalTriggerAdminSnapshot = {
    enabled: true,
    counts: { sources: 2, bindings: 2, armed: 2, recentFailures: 0 },
    sources: [
      { id: 'source-slack', kind: 'slack', status: 'connected', scope: 'pot', scopeRef: 'papercusp', permissionMode: 'source-acl', backfillStatus: 'not-requested', lastSyncAt: null, nextAttemptAt: null, failureCount: 0, config: {}, credentialRef: null, cursor: {}, lastConnectedAt: '2026-08-22T19:00:00.000Z', lastError: null, bindingCount: 1, armedBindingCount: 1, failedDeliveries24h: 0, social: null },
      { id: 'source-gmail', kind: 'gmail', status: 'connected', scope: 'pot', scopeRef: 'papercusp', permissionMode: 'source-acl', backfillStatus: 'not-requested', lastSyncAt: null, nextAttemptAt: null, failureCount: 0, config: {}, credentialRef: null, cursor: {}, lastConnectedAt: '2026-08-22T19:00:00.000Z', lastError: null, bindingCount: 1, armedBindingCount: 1, failedDeliveries24h: 0, social: null },
    ],
    bindings: [
      {
        id: '11111111-1111-4111-8111-111111111111', sourceId: 'source-slack', sourceKind: 'slack', sourceStatus: 'connected', planHarnessSlug: 'papercusp', planSlug: 'customer-digest', goalId: null, workItemHarnessSlug: null, workItemKind: null, eventPattern: 'ext:slack:message', eventFilter: {}, action: {}, armed: true, stormPolicy: {}, createdBy: null, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', lastRun: { id: 'run-1', status: 'done', triggeredAt: '2026-08-22T19:00:00.000Z', completedAt: '2026-08-22T19:01:00.000Z', error: null },
      },
      {
        id: '22222222-2222-4222-8222-222222222222', sourceId: 'source-gmail', sourceKind: 'gmail', sourceStatus: 'connected', planHarnessSlug: 'papercusp', planSlug: 'customer-digest', goalId: null, workItemHarnessSlug: null, workItemKind: null, eventPattern: 'ext:gmail:label', eventFilter: {}, action: {}, armed: true, stormPolicy: {}, createdBy: null, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', lastRun: null,
      },
    ],
    recentRuns: [
      {
        id: 'run-1', bindingId: '11111111-1111-4111-8111-111111111111', sourceKind: 'slack', eventPattern: 'ext:slack:message', planHarnessSlug: 'papercusp', planSlug: 'customer-digest', goalId: null, workItemHarnessSlug: null, workItemKind: null, status: 'done', attempts: 1,
        dedupeKey: 'slack:run-1', triggeredAt: '2026-08-22T19:00:00.000Z', startedAt: '2026-08-22T19:00:00.000Z', completedAt: '2026-08-22T19:01:00.000Z', planRunRef: 'customer-digest-run-1', error: null,
        causeSummary: 'Slack message matched', policyDisposition: 'ran', policyDetail: 'ran', eventFilter: {}, stormPolicy: {}, redactedPayload: {}, action: {}, blueprintOperation: null, outcomeLinks: [], timeline: [], planRun: null,
      },
    ],
  };
  return {
    catalog,
    plans: [{
      slug: 'customer-digest',
      title: 'Customer feedback digest',
      harness: 'papercusp',
      status: 'ready',
      nextAction: 'Turns feedback into a prioritized brief',
      triggered: true,
      triggerSources: ['schedule', 'external', 'manual'],
      scheduleActive: true,
    }],
    schedules: [{
      templateSlug: 'customer-digest',
      title: 'Customer feedback digest',
      harnessSlug: 'papercusp',
      schedule: { rrule: 'RRULE:FREQ=DAILY;BYHOUR=9', tzid: 'America/New_York' },
      scheduledAt: null,
      expiresAt: null,
      tzid: 'America/New_York',
      scheduleActive: true,
    }],
    occurrences: [{
      templateSlug: 'customer-digest',
      title: 'Customer feedback digest',
      harnessSlug: 'papercusp',
      occurrenceMs: NOW + 18 * 60_000,
      kind: 'recurring',
      scheduleActive: true,
      lastOutcome: 'success',
    }],
    external,
    nowMs: NOW,
  };
}

describe('automations model', () => {
  it('joins one triggered plan across its automatic schedule, Slack, and Gmail triggers', () => {
    const items = buildAutomationItems(fixture());
    const plan = items.find((item) => item.kind === 'triggered-plan');
    expect(plan?.label).toBe('Customer feedback digest');
    expect(plan?.triggers.map((trigger) => trigger.provider)).toEqual(['schedule', 'slack', 'gmail']);
    expect(plan?.nextAt).toBe(NOW + 18 * 60_000);
    expect(plan?.timingLabel).toBe('Next in 18m');
    expect(plan?.spendLabel).toContain('Run-linked');
    expect(plan?.flow).toMatchObject({
      sourceLabel: 'Schedule + Slack + Gmail',
      sourceDetail: '3/3 automatic armed',
      planDetail: 'papercusp · Ready',
      outcomeLabel: 'Turns feedback into a prioritized brief',
      outcomeDetail: 'Last observed outcome · Done',
      outcomeState: 'completed',
    });
  });

  it('excludes manual-only plans from Trigger Flows', () => {
    const input = fixture();
    input.plans = [
      ...input.plans,
      {
        slug: 'manual-review',
        title: 'Manual review',
        harness: 'papercusp',
        status: 'ready',
        triggered: true,
        triggerSources: ['manual'],
      },
    ];
    const items = buildAutomationItems(input);
    const flows = buildAutomationFlows(items);
    expect(flows).toHaveLength(1);
    expect(flows.every((item) => item.kind === 'triggered-plan')).toBe(true);
    expect(items.some((item) => item.planSlug === 'manual-review')).toBe(false);
    expect(flows.some((item) => item.label === 'git-sync')).toBe(false);
  });

  it('counts only automatic triggers when no future run is scheduled', () => {
    const input = fixture();
    input.occurrences = [];
    const plan = buildAutomationItems(input).find((item) => item.kind === 'triggered-plan');
    expect(plan?.triggers).toHaveLength(3);
    expect(plan?.timingLabel).toBe('3 installed triggers');
  });

  it('keeps AI routines, deterministic tasks, and spend truth separate', () => {
    const items = buildAutomationItems(fixture());
    const ai = items.find((item) => item.kind === 'ai-routine');
    const system = items.find((item) => item.kind === 'system-task');
    expect(ai?.spendLabel).toBe('Model spend possible');
    expect(system?.spendLabel).toBe('$0 model spend');
    expect(filterAutomationItems(items, 'ai', '')).toEqual([ai]);
    expect(filterAutomationItems(items, 'system', 'git')).toEqual([system]);
  });

  it('uses only future timestamps for the workspace next-run metric', () => {
    const items = buildAutomationItems(fixture()).map((item) => item.label === 'git-sync'
      ? { ...item, nextAt: NOW - 79 * 24 * 60 * 60 * 1000 }
      : item);
    expect(nextFutureAutomationAt(items, NOW)).toBe(NOW + 10 * 60_000);
    expect(nextFutureAutomationAt(items.map((item) => ({ ...item, nextAt: null })), NOW)).toBeNull();
  });

  it('builds Activity and Sources from the same joined data', () => {
    const input = fixture();
    const activity = buildAutomationActivity(input);
    expect(activity.some((row) => row.automationId?.includes('customer-digest'))).toBe(true);
    expect(activity.map((row) => row.label)).toContain('git-sync');
    const sources = buildAutomationSources(input);
    expect(sources.map((source) => source.label)).toEqual(['Schedule', 'slack', 'gmail']);
    expect(sources.find((source) => source.label === 'slack')?.armedCount).toBe(1);
  });

  it("groups operation bindings and joins their canonical work-item target outcome", () => {
    const input = fixture();
    const operationBinding = {
      ...input.external!.bindings[0]!,
      id: "33333333-3333-4333-8333-333333333333",
      planHarnessSlug: null,
      planSlug: null,
      action: {
        type: "blueprint-operation",
        operationHarnessSlug: "papercusp",
        operationId: "triage-message",
      },
      lastRun: {
        id: "run-operation",
        status: "succeeded",
        triggeredAt: "2026-08-22T19:30:00.000Z",
        completedAt: "2026-08-22T19:30:01.000Z",
        error: null,
      },
    };
    input.external!.bindings.push(operationBinding);
    input.external!.recentRuns.push({
      ...input.external!.recentRuns[0]!,
      id: "run-operation",
      bindingId: operationBinding.id,
      planHarnessSlug: null,
      planSlug: null,
      triggeredAt: operationBinding.lastRun.triggeredAt,
      blueprintOperation: {
        workspaceId: "papercusp-workspace",
        harnessSlug: "papercusp",
        receiptId: 41,
        operationId: "triage-message",
        specificationRevision: "a".repeat(64),
        target: { kind: "work-item", id: "WI-41", status: "done" },
      },
    });

    const operation = buildAutomationItems(input).find(
      (item) => item.kind === "triggered-operation",
    );
    expect(operation).toMatchObject({
      id: "operation:papercusp:triage-message",
      label: "triage-message",
      planSlug: null,
      operation: {
        harnessSlug: "papercusp",
        operationId: "triage-message",
        specificationRevision: "a".repeat(64),
        target: { kind: "work-item", id: "WI-41", status: "done" },
      },
      flow: {
        sourceLabel: "Slack",
        planDetail: "papercusp · blueprint operation",
        outcomeLabel: "Work item WI-41",
        outcomeDetail: "Done · spec aaaaaaaa",
        outcomeState: "completed",
      },
    });
    expect(operation?.operation?.handle).toEqual({
      workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', receiptId: 41,
      operationId: 'triage-message', specificationRevision: 'a'.repeat(64),
      target: { kind: 'work-item', id: 'WI-41' },
    });
    expect(
      buildAutomationActivity(input).find(
        (row) => row.id === "external-run:run-operation",
      ),
    ).toMatchObject({
      automationId: "operation:papercusp:triage-message",
      label: "papercusp#triage-message · slack",
    });
  });

  it("renders an operation plan target from its actual run status and outcome", () => {
    const input = fixture();
    const binding = {
      ...input.external!.bindings[0]!,
      id: "44444444-4444-4444-8444-444444444444",
      planHarnessSlug: null,
      planSlug: null,
      action: {
        type: "blueprint-operation",
        operationHarnessSlug: "papercusp",
        operationId: "daily-triage",
      },
    };
    input.external!.bindings = [binding];
    input.external!.recentRuns = [
      {
        ...input.external!.recentRuns[0]!,
        id: "run-plan-operation",
        bindingId: binding.id,
        planHarnessSlug: null,
        planSlug: null,
        blueprintOperation: {
          workspaceId: "papercusp-workspace",
          harnessSlug: "papercusp",
          receiptId: 42,
          operationId: "daily-triage",
          specificationRevision: "b".repeat(64),
          target: {
            kind: "plan",
            runId: 88,
            instanceSlug: "daily-triage@run-88",
            status: "failed",
            outcome: "failed",
          },
        },
      },
    ];
    const operation = buildAutomationItems(input).find(
      (item) => item.kind === "triggered-operation",
    );
    expect(operation).toMatchObject({
      needsAttention: true,
      flow: {
        outcomeLabel: "Plan daily-triage@run-88",
        outcomeDetail: "Failed · Failed · spec bbbbbbbb",
        outcomeState: "failed",
      },
    });
    expect(operation?.operation?.handle).toEqual({
      workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', receiptId: 42,
      operationId: 'daily-triage', specificationRevision: 'b'.repeat(64),
      target: { kind: 'plan', runId: 88, instanceSlug: 'daily-triage@run-88' },
    });
  });
});

describe('trigger dispatcher hold count through the real builders (WI-10004955)', () => {
  // A sync-triggered sweep (SYNC_TRIGGERED_SWEEPS in schedule-inventory.ts) fires as a
  // function call at the end of every git-sync. It never passes through
  // `external-trigger-dispatch`, which drains only binding-created trigger_runs, so a
  // dispatcher pause does not hold it.
  const syncSweep = () =>
    routine({
      name: 'doc-freshness-sweep',
      group: 'docs',
      category: 'docs',
      cron: null,
      cadence: null,
      kind: 'triggered',
      family: 'docs',
      armedState: 'armed',
      triggerLabel: 'after every git-sync',
      nextFireAt: null,
    });

  it('counts one held workflow per armed binding target, not per binding', () => {
    // Two armed bindings, both on plan customer-digest: one workflow is held.
    const items = buildAutomationItems(fixture());
    expect(dispatcherDependentWorkflows(items)).toBe(1);
  });

  it('does not count an armed sync-triggered routine as held by a dispatcher pause', () => {
    const input = fixture();
    input.catalog = { ...input.catalog!, routines: [...input.catalog!.routines, syncSweep()] };
    const items = buildAutomationItems(input);
    // The routine still renders as an event-driven row; it just is not dispatcher-held.
    expect(items.find((item) => item.label === 'doc-freshness-sweep')?.triggers[0]).toMatchObject({
      kind: 'external',
      armed: true,
    });
    expect(dispatcherDependentWorkflows(items)).toBe(1);
  });

  it('counts an armed blueprint-operation binding as held', () => {
    const input = fixture();
    input.external!.bindings = [
      ...input.external!.bindings,
      {
        ...input.external!.bindings[0]!,
        id: '55555555-5555-4555-8555-555555555555',
        planHarnessSlug: null,
        planSlug: null,
        action: { type: 'blueprint-operation', operationHarnessSlug: 'papercusp', operationId: 'daily-triage' },
      },
    ];
    expect(dispatcherDependentWorkflows(buildAutomationItems(input))).toBe(2);
  });
});
