import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { findBoxIdentityPaths, findOwnerNameLeaks } from '../../../scripts/lib/identity-leak-patterns.mjs';
import candidatePreregistration from './llm-testing/fixtures/tool-delivery-full-after-use-20261021.json';
import { evaluateToolDeliveryRuns, toolDeliveryExperiment, TOOL_DELIVERY_ARMS, TOOL_DELIVERY_SCENARIOS,
  type ToolDeliveryRun, type ToolDeliveryExperiment } from './tool-delivery-acceptance';
import { rubricCriterionCheckSchema } from './agent-tools/plans/rubric-template';
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
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function candidateFixture() {
  const arms = { compactArm: 'preregistered-candidate', fullArm: 'preregistered-control' };
  const full = [{ type: 'function', name: 'work_items__list', description: 'Full guidance',
    parameters: schemas.get('work_items:list') }];
  const compact = [{ ...full[0]!, description: 'Short' }];
  const experiment: ToolDeliveryExperiment = { id: 'test-only-explicit-experiment', arms, scenarios: TOOL_DELIVERY_SCENARIOS,
    manifestContract: { provider: 'codex', systemSha256: hash('same prompt'), sutModel: 'sut', judgeModel: 'judge',
      scenarioHashes: Object.fromEntries(TOOL_DELIVERY_SCENARIOS.map(scenario => [scenario, `hash-${scenario}`])),
      canonicalBySanitized: [['work_items__list', 'work_items:list']], fullDefinitions: full, compactDefinitions: compact } };
  const rows = fixture().map(row => {
    const candidate = row.variant === TOOL_DELIVERY_ARMS.compactArm;
    const manifest = (responseIndex: number) => {
      const definitions = candidate && responseIndex === 0 ? compact : full;
      return { name: 'tool_definition_manifest', data: { schemaVersion: 'su-tool-definitions-v1', provider: 'codex',
        systemSha256: hash('same prompt'), responseIndex, fullDefinitionsAfterUse: candidate,
        canonicalBySanitized: experiment.manifestContract!.canonicalBySanitized,
        usedCanonicalNames: responseIndex === 0 ? [] : ['work_items:list'], definitions,
        sha256: hash(definitions), bytes: Buffer.byteLength(JSON.stringify(definitions)) } };
    };
    return { ...row, variant: candidate ? arms.compactArm : arms.fullArm,
      raw_events: [manifest(0), { name: 'tool_call', data: { name: 'work_items:list', input: { limit: 2 } } },
        manifest(1), { name: 'done', data: {} }] };
  });
  return { experiment, rows };
}
describe('tool-delivery acceptance instruments', () => {
  it('ships a portable preregistration while retaining the exact private prompt hash', () => {
    const serialized = JSON.stringify(candidatePreregistration);
    expect(findBoxIdentityPaths(serialized)).toEqual([]);
    expect(findOwnerNameLeaks(serialized)).toEqual([]);
    for (const variant of Object.values(candidatePreregistration.variants)) {
      expect(variant.configDelta).not.toHaveProperty('systemPromptText');
      expect(variant.systemPromptTextSha256).toBe(candidatePreregistration.capture.privateCapture.systemPromptTextSha256);
    }
    for (const path of Object.values(candidatePreregistration.sourcePins.scenarioPaths)) {
      expect(path).toMatch(/^packages\/operator-core\/lib\/llm-testing\/scenarios\/su\//);
    }
  });
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
  it('keeps the historical default and requires an explicit registered candidate selection', () => {
    expect(toolDeliveryExperiment().arms).toEqual(TOOL_DELIVERY_ARMS);
    const registered = toolDeliveryExperiment('session-tool-delivery-full-after-use-20261021');
    expect(registered.scenarios).toEqual(TOOL_DELIVERY_SCENARIOS);
    expect(registered.manifestContract?.systemSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(registered.manifestContract?.fullDefinitions).toHaveLength(65);
    expect(Object.values(registered.arms).some(arm => Object.values(TOOL_DELIVERY_ARMS).includes(arm))).toBe(false);
    expect(() => toolDeliveryExperiment('test-only-explicit-experiment')).toThrow('Unregistered');
    const { rows, experiment } = candidateFixture();
    expect(evaluateToolDeliveryRuns(rows, schemas).comprehension.verdict).toBe('unknown');
    const result = evaluateToolDeliveryRuns(rows, schemas, experiment);
    expect(result.comprehension.verdict).toBe('pass');
    expect(result.invalidArguments.verdict).toBe('pass');
    expect(result.manifests).toHaveLength(30);
    expect(result.manifests![0]!.maxBytes).toBeGreaterThan(result.manifests![0]!.initialBytes!);
    expect(rubricCriterionCheckSchema.parse({ kind: 'instrument', instrumentKey: 'llm-test-su-tool-definition-tier-ab',
      experimentId: experiment.id })).toHaveProperty('experimentId', experiment.id);
  });
  it('refuses missing, corrupted, confounded, prematurely full or unpromoted request manifests', () => {
    const mutations: Array<(row: ToolDeliveryRun) => void> = [
      row => { row.raw_events = undefined; },
      row => { row.sut_model = 'different'; },
      row => { row.scenario_hash = 'different'; },
      row => { (row.raw_events as any[])[0].data.systemSha256 = 'different'; },
      row => { (row.raw_events as any[])[0].data.bytes++; },
      row => { (row.raw_events as any[])[0].data.provider = 'anthropic'; },
      row => { delete (row.raw_events as any[])[0].data.canonicalBySanitized; },
      row => { (row.raw_events as any[])[0].data.fullDefinitionsAfterUse = false; },
      row => { (row.raw_events as any[])[0].data.usedCanonicalNames = ['work_items:list']; },
      row => { (row.raw_events as any[])[2].data.usedCanonicalNames = []; },
      row => { (row.raw_events as any[])[2].data.responseIndex = 2; },
      row => { (row.raw_events as any[]).splice(2, 1); },
      row => { (row.raw_events as any[]).pop(); },
      row => { row.transcript_norm_json = []; },
      row => { const e = row.raw_events as any[]; e[0].data.definitions = e[2].data.definitions;
        e[0].data.sha256 = hash(e[0].data.definitions); e[0].data.bytes = Buffer.byteLength(JSON.stringify(e[0].data.definitions)); },
      row => { const e = row.raw_events as any[]; e[2].data.definitions = e[0].data.definitions;
        e[2].data.sha256 = hash(e[2].data.definitions); e[2].data.bytes = Buffer.byteLength(JSON.stringify(e[2].data.definitions)); },
    ];
    for (const mutate of mutations) {
      const { rows, experiment } = candidateFixture(); mutate(rows[0]!);
      const result = evaluateToolDeliveryRuns(rows, schemas, experiment);
      expect(result.comprehension.verdict, result.comprehension.reason).toBe('unknown');
      expect(result.invalidArguments.verdict).toBe('unknown');
    }
  });
  it('does not silently discard an extra scenario or an adverse candidate replication', () => {
    const { rows, experiment } = candidateFixture();
    expect(evaluateToolDeliveryRuns([...rows, { ...rows[0]!, id: 'extra', scenario_id: 'outside' }], schemas, experiment)
      .comprehension.verdict).toBe('unknown');
    rows[0]!.status = 'failed';
    expect(evaluateToolDeliveryRuns(rows, schemas, experiment).comprehension.verdict).toBe('fail');
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
  it('the scorecard consumer refuses unregistered or inconsistent experiment selections', async () => {
    for (const selections of [['unknown-candidate', 'unknown-candidate'], ['session-tool-delivery-ab-20261021', 'unknown-candidate']]) {
      let reads = 0;
      const keys = ['llm-test-su-tool-definition-tier-ab', 'tool-delivery-invalid-arg-evidence-ladder'];
      const rubric = { workspaceId: 'papercusp-workspace', subjectPlan: 'deterministic-tool-definition-delivery-2026-09-21',
        criteria: keys.map((key, i) => ({ key, check: { kind: 'instrument', instrumentKey: key, experimentId: selections[i] } })) } as unknown as Rubric;
      const snapshots = await resolveScorecardInstrumentSnapshots({ rubric,
        subject: { kind: 'plan', ref: rubric.subjectPlan!, windowStart: '2026-10-21T05:00:00Z', windowEnd: '2026-10-21T06:00:00Z' } },
      { now: () => Date.parse('2026-10-21T06:01:00Z'), toolDelivery: async () => { reads++; return evaluateToolDeliveryRuns(fixture(), schemas); } });
      expect(reads).toBe(0);
      for (const key of keys) expect(snapshots?.[key]!.verdict).toBe('unknown');
    }
  });
});
