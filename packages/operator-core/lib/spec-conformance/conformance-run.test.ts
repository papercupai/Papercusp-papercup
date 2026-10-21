import { describe, expect, it } from 'vitest';
import { buildRubricCheckLedgerRow, type RubricCheckResult } from '../check-results-ledger';
import {
  conformanceLedgerRef,
  doneWhenCheckId,
  falsifierCheckId,
  planDriftAlarmKey,
  runPlanConformance,
  type ConformanceCheckRequest,
  type ConformanceCheckVerdict,
  type ConformanceRunDeps,
  type DriftAlarmFiling,
  type EvaluatedConformanceCheck,
  type PlanDriftAlarmPayload,
} from './conformance-run';

// Local copy of the activation-gate fixture builders: editing that test file would change
// the test fingerprint P-017's bound spec evidence was measured against.
const TESTS_CHECK = { kind: 'tests', files: ['packages/operator-core/lib/spec-conformance/conformance-run.test.ts'] };
// The falsifier's kind does not change the drift rules; a second tests check keeps the fixture
// independent of the probe DSL.
const FALSIFIER_CHECK = { kind: 'tests', files: ['packages/operator-core/lib/spec-conformance/activation-gate.test.ts'] };

function requirement(key: string, title: string, check?: Record<string, unknown>): string {
  const block = {
    intent: { request: `${title} request`, sourceRefs: ['owner directive #1'] },
    acceptance: {
      condition: `${title} holds.`,
      falsifier: `${title} does not hold.`,
      ...(check && check.kind === 'tests' ? { requiredTestLayers: ['unit'] } : {}),
      passRatings: ['healthy'],
    },
    verification: { method: `Check ${title}.`, ...(check ? { check } : {}) },
  };
  return `**${key} — ${title}.**\n\`\`\`requirement\n${JSON.stringify(block)}\n\`\`\``;
}

function plan(opts: { requirements: string[]; conformance?: unknown | string }): string {
  const conformance =
    opts.conformance === undefined
      ? ''
      : typeof opts.conformance === 'string'
        ? `## Conformance\n\n${opts.conformance}\n`
        : `## Conformance\n\n\`\`\`conformance\n${JSON.stringify(opts.conformance)}\n\`\`\`\n`;
  return `---
title: Conformance run fixture
slug: conformance-run-fixture
status: active
created: 2026-10-14
updated: 2026-10-14
---

## Requirements

${opts.requirements.join('\n\n')}

${conformance}
## Phase 1

- **P-001** \`todo\` Build it.

## Decisions
`;
}

const SLUG = 'conformance-run-fixture';
const HARNESS = 'papercusp';
const LEDGER = conformanceLedgerRef(HARNESS, SLUG);

/** R-1 has a runnable falsifier (probe) and a tests done-when; R-2 only a pending falsifier. */
function fixturePlan(): string {
  return plan({
    requirements: [
      requirement('R-1', 'Alarms are deduplicated', TESTS_CHECK),
      requirement('R-2', 'Directives need evidence', { kind: 'instrument', instrumentKey: 'none' }),
    ],
    conformance: {
      footprint: { paths: ['packages/operator-core/lib/spec-conformance/**'] },
      requirements: {
        'R-1': {
          violatedWhen: [{ id: 'duplicate-alarm', failureMode: 'two open alarms for one requirement', stage: 'operation', check: FALSIFIER_CHECK }],
        },
        'R-2': {
          violatedWhen: [{
            id: 'url-only-close',
            failureMode: 'closed on a bare URL',
            stage: 'delivery',
            pendingBinding: { observation: 'a done disposition whose note is only URLs', bindWhen: 'P-021 lands' },
          }],
        },
      },
    },
  });
}

interface Alarm { id: string; barKey: string; conditionKey: string; doneWhenRegressed: boolean; paths: string[]; open: boolean; closeReason?: string }

/**
 * An in-memory world: a scripted verdict per check id, an append-only ledger, a work-item
 * store whose condition key enforces one OPEN alarm per requirement (as the unique index
 * behind upsertConditionWorkItem does), blocks links and emitted events.
 */
function world(
  opts: {
    mapped?: Record<string, Array<{ id: string; terminal: boolean }>>;
    deviations?: string[];
    /** Work-item id -> the dependency store's refusal reason for a `blocks` edge onto it. */
    refuseBlocks?: Record<string, string>;
  } = {},
) {
  const verdicts = new Map<string, ConformanceCheckVerdict | null>();
  const ledger: RubricCheckResult[] = [];
  const alarms: Alarm[] = [];
  const blocks = new Set<string>();
  const events: PlanDriftAlarmPayload[] = [];
  const requests: ConformanceCheckRequest[] = [];
  const filings: DriftAlarmFiling[] = [];
  let nextId = 1;
  const deps: ConformanceRunDeps = {
    async evaluateCheck(request): Promise<EvaluatedConformanceCheck | null> {
      requests.push(request);
      const verdict = verdicts.has(request.checkId) ? verdicts.get(request.checkId)! : 'pass';
      if (verdict === null) return null;
      return {
        kind: request.check.kind === 'probe' ? 'probe' : request.check.kind === 'instrument' ? 'instrument' : 'tests',
        verdict,
        value: verdict === 'error' ? null : verdict === 'pass' ? 1 : 0,
        unit: request.check.kind === 'tests' ? 'files' : null,
        measuredAt: '2026-10-14T08:00:00.000Z',
        ...(verdict === 'pass' ? {} : { detail: `scripted ${verdict}` }),
      };
    },
    async readLatestVerdicts(ledgerRef) {
      const latest = new Map<string, ConformanceCheckVerdict>();
      for (const row of ledger) if (row.check.rubricRef === ledgerRef) latest.set(row.check.id, row.verdict);
      return latest;
    },
    async recordResults(results) {
      ledger.push(...results);
      return results.map((_, i) => 1000 + ledger.length - results.length + i);
    },
    async listOpenDriftAlarms() {
      return alarms.filter((a) => a.open).map((a) => ({ id: a.id, barKey: a.barKey, doneWhenRegressed: a.doneWhenRegressed }));
    },
    async openDriftAlarm(filing: DriftAlarmFiling) {
      filings.push(filing);
      const incumbent = alarms.find((a) => a.open && a.conditionKey === filing.conditionKey);
      if (incumbent) {
        incumbent.doneWhenRegressed = filing.doneWhenRegressed;
        incumbent.paths = filing.paths ?? [];
        return { id: incumbent.id, created: false };
      }
      const alarm: Alarm = { id: `EI-ALARM-${nextId++}`, barKey: filing.barKey, conditionKey: filing.conditionKey, doneWhenRegressed: filing.doneWhenRegressed, paths: filing.paths ?? [], open: true };
      alarms.push(alarm);
      return { id: alarm.id, created: true };
    },
    async closeDriftAlarm(id, reason) {
      const alarm = alarms.find((a) => a.id === id)!;
      alarm.open = false;
      alarm.closeReason = reason;
    },
    async listMappedWorkItems(barKey) {
      return opts.mapped?.[barKey] ?? [];
    },
    async linkBlocks(alarmId, workItemId) {
      const refused = opts.refuseBlocks?.[workItemId];
      if (refused !== undefined) return { linked: false, reason: refused };
      blocks.add(`${alarmId}->${workItemId}`);
      return { linked: true };
    },
    async emitDriftAlarm(payload) {
      events.push(payload);
    },
    async approvedDeviations() {
      return new Set(opts.deviations ?? []);
    },
  };
  const run = () => runPlanConformance({ planSlug: SLUG, harnessSlug: HARNESS, planContent: fixturePlan() }, deps);
  return { deps, verdicts, ledger, alarms, blocks, events, requests, filings, run, openAlarms: () => alarms.filter((a) => a.open) };
}

const R1_FALSIFIER = falsifierCheckId('R-1', 'duplicate-alarm');
const R1_DONE = doneWhenCheckId('R-1');

describe('runPlanConformance — falsifiers raise one deduplicated drift alarm (R-2)', () => {
  it('opens exactly one alarm for a firing violated-when check and emits plan:drift-alarm once', async () => {
    const w = world();
    w.verdicts.set(R1_FALSIFIER, 'fail');
    const first = await w.run();
    expect(first.alarmsOpened).toHaveLength(1);
    expect(first.requirements.find((r) => r.barKey === 'R-1')).toMatchObject({
      drifting: true,
      firedFalsifiers: ['duplicate-alarm'],
      alarm: { action: 'opened' },
    });
    expect(w.filings[0]?.paths).toEqual(expect.arrayContaining(TESTS_CHECK.files.concat(FALSIFIER_CHECK.files)));

    const second = await w.run();
    expect(second.alarmsOpened).toEqual([]);
    expect(second.requirements.find((r) => r.barKey === 'R-1')!.alarm.action).toBe('kept');
    expect(w.openAlarms()).toHaveLength(1);
    expect(w.events).toHaveLength(1);
    expect(w.events[0]).toMatchObject({ planSlug: SLUG, barKey: 'R-1', firedFalsifiers: ['duplicate-alarm'] });
    expect(planDriftAlarmKey(SLUG)).toBe(`plan:drift-alarm:${SLUG}`);
  });

  it('records every executed verdict under the plan conformance ledger namespace, and lists pending falsifiers as unbound', async () => {
    const w = world();
    w.verdicts.set(R1_FALSIFIER, 'fail');
    const outcome = await w.run();
    expect(outcome.ledgerRef).toBe(`conformance:${HARNESS}/${SLUG}`);
    expect(w.ledger.map((row) => [row.check.rubricRef, row.check.id, row.check.criterionKey, row.verdict])).toEqual([
      [LEDGER, R1_FALSIFIER, 'R-1', 'fail'],
      [LEDGER, R1_DONE, 'R-1', 'pass'],
    ]);
    expect(outcome.executed).toBe(2);
    expect(outcome.testRunIds).toHaveLength(2);
    expect(outcome.unbound).toEqual([{ barKey: 'R-2', falsifierId: 'url-only-close', bindWhen: 'P-021 lands' }]);
    // The manual R-2 done-when is never executed.
    expect(w.requests.map((r) => r.checkId)).toEqual([R1_FALSIFIER, R1_DONE]);
  });

  it('builds a readable results-ledger row for a tests-judged verdict', () => {
    const row = buildRubricCheckLedgerRow(
      {
        check: { id: R1_DONE, rubricRef: LEDGER, criterionKey: 'R-1', kind: 'tests', value: 1, unit: 'files' },
        verdict: 'pass',
        measuredAt: '2026-10-14T08:00:00.000Z',
        durationMs: null,
      },
      { workspaceId: 'papercusp-workspace', harnessSlug: HARNESS, root: '/repo' },
    );
    expect(row.filePath).toBe(`rubric-check/${LEDGER}/${R1_DONE}`);
    expect(row.executionDetails.check).toMatchObject({ kind: 'tests', criterionKey: 'R-1' });
  });

  it('refuses to run a malformed contract rather than enforcing part of it', async () => {
    const w = world();
    const outcome = await runPlanConformance(
      { planSlug: SLUG, harnessSlug: HARNESS, planContent: plan({ requirements: [requirement('R-1', 'X', TESTS_CHECK)], conformance: '```conformance\n{not json\n```' }) },
      w.deps,
    );
    expect(outcome.contractProblems.length).toBeGreaterThan(0);
    expect(outcome.executed).toBe(0);
    expect(w.requests).toEqual([]);
  });
});

describe('runPlanConformance — a drift alarm blocks dependent work (R-3)', () => {
  it('links blocks from the alarm to every non-terminal work-item mapped to the requirement', async () => {
    const w = world({
      mapped: {
        'R-1': [
          { id: 'WI-1', terminal: false },
          { id: 'WI-2', terminal: true },
          { id: 'WI-3', terminal: false },
        ],
      },
    });
    w.verdicts.set(R1_FALSIFIER, 'fail');
    const outcome = await w.run();
    const alarmId = outcome.alarmsOpened[0]!;
    expect([...w.blocks].sort()).toEqual([`${alarmId}->WI-1`, `${alarmId}->WI-3`]);
    expect(outcome.requirements.find((r) => r.barKey === 'R-1')!.blocked).toEqual(['WI-1', 'WI-3']);
    expect(w.events[0]!.blocked).toEqual(['WI-1', 'WI-3']);
    expect(w.events[0]!.blockRefused).toEqual([]);
  });

  it('records the alarm, reports a policy-refused blocks edge, and still emits and reconciles the rest', async () => {
    const reason = 'work_item_deps candidate rejected: cannot add unresolved blocker behind active dependant WI-1';
    const w = world({
      mapped: {
        'R-1': [
          { id: 'WI-1', terminal: false },
          { id: 'WI-3', terminal: false },
        ],
      },
      refuseBlocks: { 'WI-1': reason },
    });
    w.verdicts.set(R1_FALSIFIER, 'fail');
    const outcome = await w.run();
    const alarmId = outcome.alarmsOpened[0]!;
    expect(alarmId).toBeDefined();
    const row = outcome.requirements.find((r) => r.barKey === 'R-1')!;
    expect(row).toMatchObject({ drifting: true, alarm: { action: 'opened', id: alarmId } });
    expect(row.blocked).toEqual(['WI-3']);
    expect(row.blockRefused).toEqual([{ workItemId: 'WI-1', reason }]);
    expect([...w.blocks]).toEqual([`${alarmId}->WI-3`]);
    // The event that announces the alarm still fires, and names the refusal.
    expect(w.events).toHaveLength(1);
    expect(w.events[0]).toMatchObject({ alarmId, blocked: ['WI-3'], blockRefused: [{ workItemId: 'WI-1', reason }] });
    // Every requirement after R-1 is still reconciled (the refusal did not abort the run).
    expect(outcome.requirements.map((r) => r.barKey)).toEqual(expect.arrayContaining(['R-1', 'R-2']));
  });

  it('closes the alarm (releasing its blocks) once every check it rests on is measured green', async () => {
    const w = world({ mapped: { 'R-1': [{ id: 'WI-1', terminal: false }] } });
    w.verdicts.set(R1_FALSIFIER, 'fail');
    const opened = await w.run();
    w.verdicts.set(R1_FALSIFIER, 'pass');
    const closed = await w.run();
    expect(closed.alarmsClosed).toEqual(opened.alarmsOpened);
    expect(w.openAlarms()).toEqual([]);
    expect(w.alarms[0]!.closeReason).toContain('measured green');
  });

  it('keeps the alarm open when the falsifier stops firing but a check measured nothing', async () => {
    const w = world();
    w.verdicts.set(R1_FALSIFIER, 'fail');
    await w.run();
    w.verdicts.set(R1_FALSIFIER, 'pass');
    w.verdicts.set(R1_DONE, 'error');
    const outcome = await w.run();
    expect(outcome.alarmsClosed).toEqual([]);
    expect(outcome.requirements.find((r) => r.barKey === 'R-1')).toMatchObject({ unmeasured: true, alarm: { action: 'kept' } });
    expect(w.openAlarms()).toHaveLength(1);
  });

  it('keeps the alarm open when a check kind cannot be evaluated by the run', async () => {
    const w = world();
    w.verdicts.set(R1_FALSIFIER, 'fail');
    await w.run();
    w.verdicts.set(R1_FALSIFIER, null);
    const outcome = await w.run();
    expect(outcome.unevaluable).toEqual([{ barKey: 'R-1', checkId: R1_FALSIFIER, kind: 'tests' }]);
    expect(w.openAlarms()).toHaveLength(1);
  });

  it('suppresses the alarm for a requirement with an approved deviation, closing an open one', async () => {
    const w = world();
    w.verdicts.set(R1_FALSIFIER, 'fail');
    await w.run();
    w.deps.approvedDeviations = async () => new Set(['R-1']);
    const outcome = await w.run();
    expect(outcome.requirements.find((r) => r.barKey === 'R-1')!.alarm.action).toBe('suppressed');
    expect(w.openAlarms()).toEqual([]);
    expect(w.events).toHaveLength(1);
  });
});

describe('runPlanConformance — done-when regressions are drift, never-green is progress (R-4)', () => {
  it('opens a drift alarm when the done-when check moves from pass to fail', async () => {
    const w = world();
    await w.run(); // done-when passes: recorded as the prior verdict
    w.verdicts.set(R1_DONE, 'fail');
    const outcome = await w.run();
    expect(outcome.requirements.find((r) => r.barKey === 'R-1')).toMatchObject({
      doneWhen: { before: 'pass', after: 'fail' },
      doneWhenRegressed: true,
      drifting: true,
      alarm: { action: 'opened' },
    });
    expect(w.events[0]).toMatchObject({ barKey: 'R-1', doneWhenRegressed: true, firedFalsifiers: [] });
  });

  it('opens no alarm for a done-when check that has never passed', async () => {
    const w = world();
    w.verdicts.set(R1_DONE, 'fail');
    const first = await w.run();
    const second = await w.run();
    for (const outcome of [first, second]) {
      expect(outcome.requirements.find((r) => r.barKey === 'R-1')).toMatchObject({ doneWhenRegressed: false, drifting: false, alarm: { action: 'none' } });
      expect(outcome.alarmsOpened).toEqual([]);
    }
    expect(w.events).toEqual([]);
  });

  it('keeps a regression alarm open while the done-when check stays red, and closes it when it recovers', async () => {
    const w = world();
    await w.run();
    w.verdicts.set(R1_DONE, 'fail');
    await w.run();
    const stillRed = await w.run();
    expect(stillRed.requirements.find((r) => r.barKey === 'R-1')).toMatchObject({ doneWhen: { before: 'fail', after: 'fail' }, alarm: { action: 'kept' } });
    w.verdicts.set(R1_DONE, 'pass');
    const recovered = await w.run();
    expect(recovered.alarmsClosed).toHaveLength(1);
    expect(w.openAlarms()).toEqual([]);
  });
});
