import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPhaseTracker } from '@papercusp/tooldef';

const ports = vi.hoisted(() => ({
  plan: vi.fn(),
  alarms: vi.fn(),
  tests: vi.fn(),
  checks: vi.fn(),
  runtime: vi.fn(),
}));
vi.mock('../agent-tools/plans/source', () => ({ readPlanBySlug: ports.plan }));
vi.mock('../check-results-ledger', () => ({ readLatestRubricCheckResults: ports.checks }));
vi.mock('./conformance-run-deps', () => ({
  productionConformanceDeps: ports.runtime,
}));

import { conformanceClosureRefusal } from './closure-guard';

function content(kind: 'tests' | 'instrument' = 'tests', count = 1, cases?: Array<{ file: string; testName: string }>): string {
  const requirements = Array.from({ length: count }, (_, i) => {
    const key = `R-${i + 1}`;
    return `**${key} — Verified closure.**\n\`\`\`requirement\n${JSON.stringify({
      intent: { request: `Deliver ${key}.`, sourceRefs: ['P-001'] },
      acceptance: { condition: `${key} passes.`, falsifier: `${key} fails.` },
      verification: {
        method: 'Read the canonical result.',
        check: kind === 'tests'
          ? { kind: 'tests', files: ['packages/operator-core/lib/spec-conformance/closure-guard.test.ts'], ...(cases ? { cases } : {}) }
          : { kind: 'instrument', instrumentKey: 'closure-adapter-health' },
      },
    })}\n\`\`\``;
  }).join('\n');
  const mappings = Array.from({ length: count }, (_, i) => `| R-${i + 1} | P-001 | tree |`).join('\n');
  return `---\nslug: adapter-fixture\nstatus: active\n---\n## Requirements\n${requirements}
## Design
### Bar-to-work map for this plan
| bar | implementing plan items | evidence plane |
|---|---|---|
${mappings}
## Build
- **P-001** \`todo\` Verify closure
`;
}

const input = {
  workspaceId: 'workspace-adapter-test', harnessSlug: 'harness-adapter-test',
  planSlug: 'adapter-fixture', planItemIds: ['P-001'], completion: { discharges: ['R-1'] },
};

beforeEach(() => {
  vi.resetAllMocks();
  ports.plan.mockResolvedValue({ row: { content: content() } });
  ports.alarms.mockResolvedValue([]);
  ports.tests.mockResolvedValue({ verdict: 'pass' });
  ports.checks.mockResolvedValue(new Map());
  ports.runtime.mockReturnValue({ listOpenDriftAlarms: ports.alarms, evaluateCheck: ports.tests });
});

describe('production conformance closure adapter', () => {
  it('refuses a mapped close with no requirement declaration', async () => {
    expect(await conformanceClosureRefusal({ ...input, completion: {} })).toMatchObject({
      code: 'conformance_requirements_missing', requirements: ['R-1'],
    });
    expect(ports.tests).not.toHaveBeenCalled();
    expect(ports.checks).not.toHaveBeenCalled();
  });
  it('accepts a contribution without reading the requirement done-when result', async () => {
    ports.tests.mockResolvedValue({ verdict: 'fail' });
    expect(await conformanceClosureRefusal({
      ...input, completion: { contributesTo: ['R-1'] },
    })).toBeNull();
    expect(ports.tests).not.toHaveBeenCalled();
    expect(ports.checks).not.toHaveBeenCalled();
  });
  it('keeps mapped drift blocking a contribution-only close', async () => {
    ports.alarms.mockResolvedValue([{ id: 'EI-adapter-drift', barKey: 'R-1', doneWhenRegressed: true }]);
    expect(await conformanceClosureRefusal({
      ...input, completion: { contributesTo: ['R-1'] },
    })).toMatchObject({ code: 'conformance_drift_alarm_open', alarmIds: ['EI-adapter-drift'] });
    expect(ports.tests).not.toHaveBeenCalled();
  });
  it('reads the linked plan and canonical test ledger in the caller workspace', async () => {
    expect(await conformanceClosureRefusal(input)).toBeNull();
    expect(ports.plan).toHaveBeenCalledWith(input.planSlug, {
      workspaceId: input.workspaceId, harnessSlug: input.harnessSlug,
    });
    expect(ports.runtime).toHaveBeenCalledWith(input);
    expect(ports.tests).toHaveBeenCalledWith({
      barKey: 'R-1', role: 'done-when', checkId: 'R-1:done-when',
      check: { kind: 'tests', files: ['packages/operator-core/lib/spec-conformance/closure-guard.test.ts'] },
    });
    expect(ports.checks).not.toHaveBeenCalled();
  });
  it.each(['fail', 'error'])('refuses a canonical test verdict of %s', async (verdict) => {
    ports.tests.mockResolvedValue({ verdict });
    expect(await conformanceClosureRefusal(input)).toMatchObject({
      code: 'conformance_done_when_not_passing', requirements: ['R-1'],
    });
  });
  it('refuses a missing linked plan before reading result ledgers', async () => {
    ports.plan.mockResolvedValue(null);
    expect(await conformanceClosureRefusal(input)).toMatchObject({ code: 'conformance_mapping_unavailable' });
    expect(ports.tests).not.toHaveBeenCalled();
    expect(ports.checks).not.toHaveBeenCalled();
  });
  it('blocks mapped drift before accepting a passing test', async () => {
    ports.alarms.mockResolvedValue([{ id: 'EI-adapter-drift', barKey: 'R-1', doneWhenRegressed: true }]);
    expect(await conformanceClosureRefusal(input)).toMatchObject({
      code: 'conformance_drift_alarm_open', alarmIds: ['EI-adapter-drift'],
    });
    expect(ports.tests).not.toHaveBeenCalled();
  });
  it('uses exact plan-scoped check ids and reads the instrument ledger once', async () => {
    ports.plan.mockResolvedValue({ row: { content: content('instrument', 2) } });
    ports.checks.mockResolvedValue(new Map([
      ['R-1:done-when', { status: 'pass' }], ['R-2:done-when', { status: 'pass' }],
    ]));
    expect(await conformanceClosureRefusal({ ...input, completion: { discharges: ['R-1', 'R-2'] } })).toBeNull();
    expect(ports.checks).toHaveBeenCalledExactlyOnceWith({
      rubricRef: 'conformance:harness-adapter-test/adapter-fixture', workspaceId: input.workspaceId,
    });
    expect(ports.tests).not.toHaveBeenCalled();
  });
  it('refuses an instrument with no canonical done-when result', async () => {
    ports.plan.mockResolvedValue({ row: { content: content('instrument') } });
    expect(await conformanceClosureRefusal(input)).toMatchObject({ code: 'conformance_done_when_not_passing' });
  });
  it('propagates ledger read failures so an outage cannot allow closure', async () => {
    ports.tests.mockRejectedValue(new Error('ledger unavailable'));
    await expect(conformanceClosureRefusal(input)).rejects.toThrow('ledger unavailable');
  });
  it('shares one production evaluator across requirements and retains named-case failures', async () => {
    const cases = [{ file: 'packages/operator-core/lib/spec-conformance/closure-guard.test.ts', testName: 'exact producer case' }];
    ports.plan.mockResolvedValue({ row: { content: content('tests', 2, cases) } });
    ports.tests.mockResolvedValueOnce({ verdict: 'pass' }).mockResolvedValueOnce({ verdict: 'fail' });
    expect(await conformanceClosureRefusal({ ...input, completion: { discharges: ['R-1', 'R-2'] } })).toMatchObject({
      code: 'conformance_done_when_not_passing', requirements: ['R-2'],
    });
    expect(ports.runtime).toHaveBeenCalledTimes(1);
    expect(ports.tests.mock.calls.map(([request]) => request)).toEqual(['R-1', 'R-2'].map(barKey => ({
      barKey, role: 'done-when', checkId: `${barKey}:done-when`,
      check: { kind: 'tests', files: [cases[0]!.file], cases },
    })));
  });
  it('keeps a delayed test read visible in the enclosing completion tracker', async () => {
    const phases = createPhaseTracker();
    let release!: (value: { verdict: string }) => void;
    ports.tests.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = conformanceClosureRefusal({ ...input, phases });
    await vi.waitFor(() => expect(ports.tests).toHaveBeenCalledTimes(1));
    expect(ports.runtime).toHaveBeenCalledWith(expect.objectContaining({ phases }));
    expect(phases.snapshot().activePhase).toBe('conformance:closure:tests:R-1');
    release({ verdict: 'pass' });
    expect(await pending).toBeNull();
    expect(phases.snapshot().activePhases).toEqual([]);
    expect(phases.intervals().map(row => row.phase)).toContain('conformance:closure:tests:R-1');
  });
});
