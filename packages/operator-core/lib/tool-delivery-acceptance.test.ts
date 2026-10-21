import { describe, expect, it } from 'vitest';
import { evaluateToolDeliveryRuns, TOOL_DELIVERY_ARMS, TOOL_DELIVERY_SCENARIOS, type ToolDeliveryRun } from './tool-delivery-acceptance';
import { getRegisteredInstrument } from './rubric-instrument-registry';
import { resolveScorecardInstrumentSnapshots } from './scorecards';
import type { Rubric } from './rubrics';

const schemas = new Map([['work_items:list', { type: 'object', properties: { limit: { type: 'integer', minimum: 1 } }, additionalProperties: false }]]);
function fixture(): ToolDeliveryRun[] {
  return TOOL_DELIVERY_SCENARIOS.flatMap(scenario => Object.values(TOOL_DELIVERY_ARMS).flatMap(variant =>
    [0, 1, 2].map(i => ({ id: `${scenario}:${variant}:${i}`, scenario_id: scenario, scenario_hash: `hash-${scenario}`,
      sut_model: 'sut', judge_model: 'judge', status: 'passed', variant,
      transcript_norm_json: [{ toolCalls: [{ name: 'work_items:list', input: { limit: 2 } }] }] }))));
}
describe('tool-delivery acceptance instruments', () => {
  it('reports paired power, absolute compact passes and separately validated calls', () => {
    const result = evaluateToolDeliveryRuns(fixture(), schemas);
    expect(result.comprehension.verdict).toBe('pass');
    expect(result.invalidArguments.verdict).toBe('pass');
    expect(result.powered).toEqual(TOOL_DELIVERY_SCENARIOS);
    expect(result.compactAllPassed).toEqual(TOOL_DELIVERY_SCENARIOS);
    expect(result.runIds).toHaveLength(30);
  });
  it('cannot pass a short, errored, asymmetric, duplicated, or model-confounded batch', () => {
    const errored = fixture(); errored[0]!.status = 'errored';
    const changed = fixture(); changed[0]!.sut_model = 'different';
    const changedScenario = fixture(); changedScenario[0]!.scenario_hash = 'new-source';
    for (const rows of [[], fixture().slice(1), errored, [...fixture(), fixture()[0]!], changed, changedScenario]) {
      const result = evaluateToolDeliveryRuns(rows, schemas);
      expect(result.comprehension.verdict).toBe('unknown');
      expect(result.invalidArguments.verdict).toBe('unknown');
    }
  });
  it('detects a compact deficit even when the strict all-replications rule cannot fire', () => {
    const rows = fixture(); rows[0]!.status = 'failed'; rows[3]!.status = 'failed'; rows[1]!.status = 'failed';
    const result = evaluateToolDeliveryRuns(rows, schemas);
    expect(result.comprehension.verdict).toBe('fail');
    expect(result.deficits).toEqual([TOOL_DELIVERY_SCENARIOS[0]]);
  });
  it('refuses a vacuous common failure and does not count omitted calls as clean calls', () => {
    expect(evaluateToolDeliveryRuns(fixture().map(r => ({ ...r, status: 'failed' })), schemas).comprehension.verdict).toBe('unknown');
    expect(evaluateToolDeliveryRuns(fixture().map(r => ({ ...r, transcript_norm_json: [] })), schemas).invalidArguments.verdict).toBe('unknown');
    expect(evaluateToolDeliveryRuns(fixture(), new Map()).invalidArguments.verdict).toBe('unknown');
  });
  it('fails a compact-only malformed-call class while retaining a clean comprehension reading', () => {
    const rows = fixture(); rows[0]!.transcript_norm_json = [{ toolCalls: [{ name: 'work_items:list', input: { limit: -1 } }] }];
    const result = evaluateToolDeliveryRuns(rows, schemas);
    expect(result.comprehension.verdict).toBe('pass');
    expect(result.invalidArguments.verdict).toBe('fail');
    expect(result.oracle!.onlyInCompact).toHaveLength(1);
  });
  it('registers both keys and derives their snapshot verdicts through the real scorecard consumer', async () => {
    const keys = ['llm-test-su-tool-definition-tier-ab', 'tool-delivery-invalid-arg-evidence-ladder'];
    for (const key of keys) expect(getRegisteredInstrument(key)?.evaluator).toBe('platform');
    const measurement = evaluateToolDeliveryRuns(fixture(), schemas);
    measurement.comprehension = { verdict: 'fail', reason: 'controlled compact deficit' };
    const rubric = { workspaceId: 'papercusp-workspace', subjectPlan: 'deterministic-tool-definition-delivery-2026-09-21',
      criteria: keys.map(key => ({ key, check: { kind: 'instrument', instrumentKey: key } })) } as unknown as Rubric;
    let reads = 0;
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric,
      subject: { kind: 'plan', ref: rubric.subjectPlan!, windowStart: '2026-10-21T05:00:00Z', windowEnd: '2026-10-21T06:00:00Z' } },
    { now: () => Date.parse('2026-10-21T06:01:00Z'), toolDelivery: async () => { reads++; return measurement; } });
    expect(reads).toBe(1);
    expect(snapshots?.[keys[0]!]!.verdict).toBe('fail');
    expect(snapshots?.[keys[1]!]!.verdict).toBe('pass');
    expect(snapshots?.[keys[0]!]!.provenance).toBe('platform-computed');
  });
});
