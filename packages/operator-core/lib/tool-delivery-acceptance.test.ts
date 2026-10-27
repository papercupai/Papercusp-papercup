import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { findBoxIdentityPaths, findOwnerNameLeaks } from '../../../scripts/lib/identity-leak-patterns.mjs';
import candidatePreregistration from './llm-testing/fixtures/tool-delivery-full-after-use-20261021.json';
import diagnosticPreregistration from './llm-testing/fixtures/tool-delivery-diagnostic-candidate-20261023.json';
import { evaluateToolDeliveryRuns, measureToolDeliveryAcceptance, verifyToolDeliverySourceCustody, validateToolDeliveryBatchReceipt,
  toolDeliveryExperiment, toolDeliveryPreregistration, readToolDeliveryCommittedSource, TOOL_DELIVERY_ARMS, TOOL_DELIVERY_SCENARIOS,
  type ToolDeliveryRun, type ToolDeliveryExperiment } from './tool-delivery-acceptance';
import { rubricCriterionCheckSchema } from './agent-tools/plans/rubric-template';
import { getRegisteredInstrument } from './rubric-instrument-registry';
import { resolveScorecardInstrumentSnapshots } from './scorecards';
import type { Rubric } from './rubrics';

const ledger = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(), getOrgPg: () => ledger,
}));

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
  Object.assign(experiment, { executionContract: { registeredAt: '2026-10-21T15:00:00Z',
    ...candidatePreregistration.configuration } });
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
  const ordered = candidatePreregistration.configuration.armOrder.flatMap(block => block.arms.flatMap(arm =>
    rows.filter(row => row.scenario_id === block.scenario && row.variant === (arm === 'compact' ? arms.compactArm : arms.fullArm))));
  ordered.forEach((row, i) => Object.assign(row, { started_at: new Date(Date.parse('2026-10-22T19:00:00Z') + i * 2000),
    finished_at: new Date(Date.parse('2026-10-22T19:00:01Z') + i * 2000), matrix_index: i % 3,
    matrix_group_id: `${row.scenario_id}:${row.variant}` }));
  return { experiment, rows: ordered };
}
function custodyFixture(original: typeof candidatePreregistration | typeof diagnosticPreregistration = candidatePreregistration) {
  const registration = structuredClone(original) as unknown as ReturnType<typeof toolDeliveryPreregistration>;
  const sources = new Map<string, Buffer>();
  for (const path of Object.keys(registration.sourcePins.files)) {
    const bytes = Buffer.from(`pinned source: ${path}`); sources.set(path, bytes);
    (registration.sourcePins.files as Record<string, string>)[path] = createHash('sha256').update(bytes).digest('hex');
  }
  for (const [scenario, path] of Object.entries(registration.sourcePins.scenarioPaths)) {
    const bytes = Buffer.from(`scenario: ${scenario}`); sources.set(path, bytes);
    (registration.experiment.manifestContract.scenarioHashes as Record<string, string>)[scenario] = createHash('sha256').update(bytes).digest('hex');
  }
  const prompt = 'Synthetic private prompt';
  const promptSha = createHash('sha256').update(prompt).digest('hex');
  registration.experiment.manifestContract.systemSha256 = hash(prompt);
  registration.variants.compact.systemPromptTextSha256 = registration.variants.full.systemPromptTextSha256 = promptSha;
  const frozen = structuredClone(registration);
  for (const arm of ['compact', 'full'] as const) Object.assign(frozen.variants[arm].configDelta, { systemPromptText: prompt });
  const privateCapture = Buffer.from(JSON.stringify(frozen));
  registration.capture.privateCapture.originalSha256 = createHash('sha256').update(privateCapture).digest('hex');
  const oraclePath = 'packages/operator-core/lib/llm-testing/r6-malformed-call-oracle.ts';
  if (!sources.has(oraclePath)) sources.set(oraclePath, Buffer.from('pinned oracle'));
  const amendment = { decisionRef: 'deterministic-tool-definition-delivery-2026-09-21#D-999', registeredAt: '2026-10-22T18:00:00Z',
    sourceReplacements: { 'packages/operator-core/lib/tool-delivery-acceptance.ts': {
      originalSha256: registration.sourcePins.files['packages/operator-core/lib/tool-delivery-acceptance.ts'],
      sha256: registration.sourcePins.files['packages/operator-core/lib/tool-delivery-acceptance.ts'],
    } }, addedFiles: { [oraclePath]: createHash('sha256').update(sources.get(oraclePath)!).digest('hex') } };
  Object.assign(registration, { measurementAmendment: amendment });
  return { registration, privateCapture, buildSha: '0123456789abcdef', readSource: (path: string, _ref?: string) => sources.get(path)!, sources };
}
describe('tool-delivery acceptance instruments', () => {
  it('selects distinct candidate custody without changing historical defaults or the D062 contract', () => {
    const original = toolDeliveryPreregistration(candidatePreregistration.experiment.id);
    const diagnostic = toolDeliveryPreregistration(diagnosticPreregistration.experiment.id);
    expect(original).toEqual(candidatePreregistration);
    expect(diagnostic).toEqual(diagnosticPreregistration);
    expect(diagnostic.capture.privateCapture.originalSha256).not.toBe(original.capture.privateCapture.originalSha256);
    expect(diagnostic.custodyPaths?.receiptDirectory).toBe('diagnostic-candidate-once-20261023');
    expect(toolDeliveryExperiment(diagnostic.experiment.id).arms).toEqual(diagnostic.experiment.arms);
    expect(toolDeliveryExperiment().arms).toEqual(TOOL_DELIVERY_ARMS);
    expect(() => toolDeliveryPreregistration('unregistered')).toThrow('Unregistered');
    for (const registration of [candidatePreregistration, diagnosticPreregistration]) {
      expect(findBoxIdentityPaths(JSON.stringify(registration))).toEqual([]);
      expect(findOwnerNameLeaks(JSON.stringify(registration))).toEqual([]);
      for (const variant of Object.values(registration.variants)) expect(variant.configDelta).not.toHaveProperty('systemPromptText');
    }
  });
  it('requires the current candidate catalog and scenario bytes in the loaded build', () => {
    const input = custodyFixture(diagnosticPreregistration);
    expect(verifyToolDeliverySourceCustody(input).verified).toBe(true);
    const catalogPath = 'apps/operator/scripts/tool-delivery.generated.mjs';
    const scenarioPath = Object.values(input.registration.sourcePins.scenarioPaths)[0]!;
    for (const changedPath of [catalogPath, scenarioPath]) {
      const changed = custodyFixture(diagnosticPreregistration);
      changed.readSource = (path, ref) => path === changedPath && ref === changed.buildSha
        ? Buffer.from('wrong loaded source') : changed.sources.get(path)!;
      expect(verifyToolDeliverySourceCustody(changed).verified).toBe(false);
    }
    const old = custodyFixture();
    old.readSource = (path, ref) => path === catalogPath && ref === old.buildSha
      ? Buffer.from('current catalog is irrelevant to the frozen historical treatment') : old.sources.get(path)!;
    expect(verifyToolDeliverySourceCustody(old).verified).toBe(true);
    const mixed = custodyFixture(diagnosticPreregistration);
    mixed.registration.capture.privateCapture.originalSha256 = candidatePreregistration.capture.privateCapture.originalSha256;
    expect(verifyToolDeliverySourceCustody(mixed).verified).toBe(false);
  });
  it('reads nested runner source only from the loaded superproject gitlink and rejects a changed gitlink', () => {
    const pin = 'a'.repeat(40), path = 'libs/testing-shell/src/llm/runner.ts';
    const git = vi.fn((args: string[], directory?: string) => {
      if (args[0] === 'rev-parse') return Buffer.from(`${pin}\n`);
      expect(directory).toBe('libs/testing-shell');
      expect(args).toEqual(['show', `${pin}:src/llm/runner.ts`]);
      return Buffer.from('pinned nested runner');
    });
    expect(readToolDeliveryCommittedSource(path, 'loaded-build', { 'libs/testing-shell': pin }, git).toString()).toBe('pinned nested runner');
    expect(git).toHaveBeenCalledWith(['rev-parse', 'loaded-build:libs/testing-shell']);
    git.mockClear();
    expect(() => readToolDeliveryCommittedSource(path, 'loaded-build', { 'libs/testing-shell': 'b'.repeat(40) }, git)).toThrow('gitlink');
    expect(git).toHaveBeenCalledTimes(1);
  });
  it('binds the new candidate receipt independently and rejects the original candidate marker', () => {
    const registration = custodyFixture(diagnosticPreregistration).registration;
    const { rows, experiment } = candidateFixture();
    for (const row of rows) row.variant = row.variant === experiment.arms.compactArm
      ? registration.experiment.arms.compactArm : registration.experiment.arms.fullArm;
    const marker = { at: '2026-10-22T18:59:00Z', experimentId: registration.experiment.id,
      privateSha256: registration.capture.privateCapture.originalSha256 };
    const receipt = registration.configuration.armOrder.flatMap(block => block.arms.map(arm => {
      const variantId = arm === 'compact' ? registration.experiment.arms.compactArm : registration.experiment.arms.fullArm;
      const subset = rows.filter(row => row.scenario_id === block.scenario && row.variant === variantId);
      return { scenario: block.scenario, arm, variantId, ids: subset.map(row => row.id), statuses: subset.map(row => row.status) };
    }));
    expect(validateToolDeliveryBatchReceipt(rows, marker, receipt, registration)).toBeUndefined();
    expect(validateToolDeliveryBatchReceipt(rows, { ...marker, experimentId: candidatePreregistration.experiment.id }, receipt, registration)).toBeTypeOf('string');
    expect(validateToolDeliveryBatchReceipt(rows, marker, receipt, toolDeliveryPreregistration(candidatePreregistration.experiment.id))).toBeTypeOf('string');
  });
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
  it('reports current format support, catches malformed formats, and preserves historical measurement limits', () => {
    const formatSchemas = new Map([['work_items:list', {
      type: 'object', properties: { email: { type: 'string', format: 'email' } },
      required: ['email'], additionalProperties: false,
    }]]);
    const rows = fixture().map(row => ({ ...row,
      transcript_norm_json: [{ toolCalls: [{ name: 'work_items:list', input: { email: 'valid@example.com' } }] }],
    }));
    const baseline = evaluateToolDeliveryRuns(rows, formatSchemas);
    expect(baseline.invalidArguments.verdict).toBe('pass');
    expect(baseline.limits.join(' ')).toContain('ajv-formats validates registered formats');
    expect(baseline.limits.join(' ')).toContain('unknown custom formats/keywords are ignored');
    expect(baseline.limits.join(' ')).toContain('Historical measurements retain their recorded validator and limits');
    const malformed = rows.find(row => row.variant === TOOL_DELIVERY_ARMS.compactArm)!;
    malformed.transcript_norm_json[0]!.toolCalls[0]!.input.email = 'invalid-email';
    const result = evaluateToolDeliveryRuns(rows, formatSchemas);
    expect(result.invalidArguments.verdict).toBe('fail');
    expect(JSON.stringify(result.oracle)).toContain('format-violation');
    expect(baseline.invalidArguments.verdict).toBe('pass');
  });
  it('verifies immutable private treatment and fails closed on missing, altered or unregistered source custody', () => {
    expect(verifyToolDeliverySourceCustody(custodyFixture()).verified).toBe(true);
    const mutations: Array<(input: ReturnType<typeof custodyFixture>) => void> = [
      input => { input.privateCapture = Buffer.from('altered private original'); },
      input => { input.registration.experiment.manifestContract.systemSha256 = 'changed'; },
      input => { input.registration.configuration.armOrder = [...input.registration.configuration.armOrder].reverse(); },
      input => { input.registration.sourcePins.head = 'different'; },
      input => { input.sources.set('packages/operator-core/lib/tool-delivery-acceptance.ts', Buffer.from('unregistered repair')); },
      input => { input.readSource = (path, ref) => ref === input.buildSha ? Buffer.from('different loaded build') : input.sources.get(path)!; },
      input => { input.buildSha = ''; },
      input => { input.readSource = () => { throw new Error('missing'); }; },
      input => { delete (input.registration as any).measurementAmendment; },
      input => { (input.registration as any).measurementAmendment.sourceReplacements['packages/operator-core/lib/llm-testing/targets/su.ts'] = {
        originalSha256: input.registration.sourcePins.files['packages/operator-core/lib/llm-testing/targets/su.ts'], sha256: 'changed treatment' }; },
    ];
    for (const mutate of mutations) {
      const input = custodyFixture(); mutate(input);
      expect(verifyToolDeliverySourceCustody(input).verified).toBe(false);
    }
  });
  it('binds the complete first execution receipt and rejects earlier attempts, omissions and substituted rows', () => {
    const { rows } = candidateFixture();
    const registration = custodyFixture().registration;
    const candidateArms = { compactArm: 'preregistered-candidate', fullArm: 'preregistered-control' };
    rows.forEach(row => { row.variant = row.variant === candidateArms.compactArm ? registration.experiment.arms.compactArm : registration.experiment.arms.fullArm; });
    const started = { at: '2026-10-22T18:59:00Z', experimentId: registration.experiment.id,
      privateSha256: registration.capture.privateCapture.originalSha256 };
    const receipt = registration.configuration.armOrder.flatMap(block => block.arms.map(arm => {
      const variantId = arm === 'compact' ? registration.experiment.arms.compactArm : registration.experiment.arms.fullArm;
      const subset = rows.filter(row => row.scenario_id === block.scenario && row.variant === variantId);
      return { scenario: block.scenario, arm, variantId, ids: subset.map(row => row.id), statuses: subset.map(row => row.status) };
    }));
    expect(validateToolDeliveryBatchReceipt(rows, started, receipt, registration)).toBeUndefined();
    for (const [marker, records] of [
      [{ ...started, at: '2026-10-22T20:00:00Z' }, receipt],
      [{ ...started, at: '2026-10-22T17:00:00Z' }, receipt],
      [{ ...started, privateSha256: 'changed' }, receipt],
      [started, receipt.slice(1)],
      [started, [{ ...receipt[0]!, ids: ['replacement'] }, ...receipt.slice(1)]],
    ]) expect(validateToolDeliveryBatchReceipt(rows, marker, records, registration)).toBeTypeOf('string');
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
  it('accepts reordered argument keys while retaining ordered calls, arrays and exact argument values', () => {
    const sample = () => {
      const { rows, experiment } = candidateFixture();
      const row = rows[0]!;
      const raw = row.raw_events as any[];
      raw[1].data.input = { longKey: { nestedValue: 2, a: null }, ordered: [1, 2], a: true };
      row.transcript_norm_json = [{ toolCalls: [{ name: 'work_items:list',
        input: { a: true, ordered: [1, 2], longKey: { a: null, nestedValue: 2 } } }] }];
      return { rows, experiment, row };
    };
    const reordered = sample();
    expect(evaluateToolDeliveryRuns(reordered.rows, schemas, reordered.experiment).manifests).toHaveLength(30);
    const mutations: Array<(calls: any[]) => void> = [
      calls => { calls[0].input.longKey.nestedValue = 3; },
      calls => { calls[0].input.ordered.reverse(); },
      calls => { calls[0].input.a = 'true'; },
      calls => { delete calls[0].input.longKey.a; },
      calls => { calls[0].input.extra = null; },
      calls => { calls[0].name = 'coord:orient'; },
      calls => { calls.pop(); },
      calls => { calls.push(structuredClone(calls[0])); },
    ];
    for (const mutate of mutations) {
      const { rows, experiment, row } = sample();
      mutate((row.transcript_norm_json as any[])[0].toolCalls);
      const result = evaluateToolDeliveryRuns(rows, schemas, experiment);
      expect(result.comprehension.verdict, result.comprehension.reason).toBe('unknown');
      expect(result.comprehension.reason).toContain('raw/normalized');
    }
  });
  it('does not silently discard an extra scenario or an adverse candidate replication', () => {
    const { rows, experiment } = candidateFixture();
    expect(evaluateToolDeliveryRuns([...rows, { ...rows[0]!, id: 'extra', scenario_id: 'outside' }], schemas, experiment)
      .comprehension.verdict).toBe('unknown');
    rows[0]!.status = 'failed';
    expect(evaluateToolDeliveryRuns(rows, schemas, experiment).comprehension.verdict).toBe('fail');
  });
  it('rejects shifting calls between turns even when their global sequence and turn count match', () => {
    const sample = () => {
      const { rows, experiment } = candidateFixture();
      const row = rows.find(row => row.variant === experiment.arms.fullArm)!;
      const first = row.raw_events as any[];
      const second = structuredClone(first);
      second[0].data.usedCanonicalNames = ['work_items:list'];
      second[1].data.input.limit = 3;
      row.raw_events = [...first, ...second];
      row.transcript_norm_json = [
        { toolCalls: [{ name: 'work_items:list', input: { limit: 2 } }] },
        { toolCalls: [{ name: 'work_items:list', input: { limit: 3 } }] },
      ];
      return { rows, experiment, row };
    };
    const valid = sample();
    expect(evaluateToolDeliveryRuns(valid.rows, schemas, valid.experiment).manifests).toHaveLength(30);
    for (const direction of ['earlier', 'later', 'missing-calls', 'no-completed-turn'] as const) {
      const { rows, experiment, row } = sample();
      const turns = row.transcript_norm_json as any[];
      if (direction === 'earlier') turns[0].toolCalls.push(turns[1].toolCalls.shift());
      if (direction === 'later') turns[1].toolCalls.unshift(turns[0].toolCalls.pop());
      if (direction === 'missing-calls') delete turns[0].toolCalls;
      if (direction === 'no-completed-turn') {
        row.raw_events = [(row.raw_events as any[])[0]];
        row.transcript_norm_json = [];
      }
      const result = evaluateToolDeliveryRuns(rows, schemas, experiment);
      expect(result.comprehension.verdict).toBe('unknown');
      expect(result.comprehension.reason).toContain('raw/normalized');
    }
  });
  it('enforces the preregistered chronological blocks, registration anchor and unretried matrix indices', () => {
    const mutations: Array<(rows: ToolDeliveryRun[], experiment: ToolDeliveryExperiment) => void> = [
      rows => { Object.assign(rows[0]!, { started_at: '2026-10-20T00:00:00Z' }); },
      rows => { const first = { ...rows[0]! }; Object.assign(rows[0]!, { started_at: (rows[3] as any).started_at,
        finished_at: (rows[3] as any).finished_at }); Object.assign(rows[3]!, { started_at: (first as any).started_at,
        finished_at: (first as any).finished_at }); },
      rows => { Object.assign(rows[1]!, { matrix_index: 0 }); },
      rows => { Object.assign(rows[1]!, { matrix_group_id: 'retry-group' }); },
      rows => { Object.assign(rows[1]!, { started_at: (rows[0] as any).started_at }); },
      rows => { Object.assign(rows[1]!, { finished_at: null }); },
      (_rows, experiment) => { delete (experiment as any).executionContract; },
    ];
    for (const mutate of mutations) {
      const { rows, experiment } = candidateFixture(); mutate(rows, experiment);
      const result = evaluateToolDeliveryRuns(rows, schemas, experiment);
      expect(result.comprehension.verdict, result.comprehension.reason).toBe('unknown');
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
  it('refuses one judged call per arm across an otherwise complete thirty-run batch', () => {
    const rows = fixture();
    for (const row of rows) if (row.scenario_id !== TOOL_DELIVERY_SCENARIOS[0]) row.transcript_norm_json = [];
    for (const i of [1, 2, 4, 5]) rows[i]!.transcript_norm_json = [];
    const result = evaluateToolDeliveryRuns(rows, schemas);
    expect(result.comprehension.verdict).toBe('pass');
    expect(result.invalidArguments.verdict).toBe('unknown');
  });
  it('requires judged coverage in every scenario and arm, not merely calls with uncompilable schemas', () => {
    const rows = fixture();
    for (const row of rows.filter(r => r.scenario_id === TOOL_DELIVERY_SCENARIOS[4] && r.variant === TOOL_DELIVERY_ARMS.fullArm)) {
      row.transcript_norm_json = [{ toolCalls: [{ name: 'uncompilable', input: {} }] }];
    }
    const result = evaluateToolDeliveryRuns(rows, new Map<string, Record<string, unknown>>([...schemas, ['uncompilable', { $ref: 'missing-schema' }]]));
    expect(result.invalidArguments.verdict).toBe('unknown');
    expect(result.oracle?.scenarioCoverage).toContainEqual({ scenario: TOOL_DELIVERY_SCENARIOS[4], arm: TOOL_DELIVERY_ARMS.fullArm,
      calls: 3, judged: 0, unmeasured: 3 });
  });
  it('queries the entire candidate population so a narrow window cannot erase an earlier errored attempt', async () => {
    const extra = { ...fixture()[0]!, id: 'earlier-error', status: 'errored' };
    ledger.sql.mockImplementation(async (strings: TemplateStringsArray) => {
      // A time-constrained SQL query would hide this adverse attempt.
      return strings.join('').includes('started_at >=') ? [] : [extra];
    });
    const result = await measureToolDeliveryAcceptance({ workspaceId: 'papercusp-workspace',
      windowStart: '2026-10-22T20:00:00Z', windowEnd: '2026-10-22T21:00:00Z', experimentId: 'session-tool-delivery-full-after-use-20261021' });
    expect(ledger.sql.mock.calls.at(-1)![0].join('')).not.toContain('started_at >=');
    expect(result.unmeasuredRunIds).toContain('earlier-error');
    expect(result.comprehension.verdict).toBe('unknown');
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
