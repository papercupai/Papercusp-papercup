/** Verifier/corpus controls only. No model, worker, report publication or schedule
 * is executed; passing this file is not actual-producer quality acceptance. */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadBlueprintFromFile } from '@papercusp/orchestrator/blueprint';
import { evaluateAsserts, type RunSummary, type ToolCallEvent } from '@papercusp/testing-shell/llm';
import { checkAgainstJsonSchema } from '../json-schema-validation';
import { MORNING_AI_QUALITY_CASES, MORNING_AI_QUALITY_WINDOW } from './morning-ai-intelligence.quality-fixtures';

const blueprint = loadBlueprintFromFile(fileURLToPath(new URL(
  '../../../../libs/papercusp/packages/harness/blueprints/morning-ai-intelligence/blueprint.yaml', import.meta.url))).blueprint;
const operation = blueprint.operations!.find(entry => entry.id === 'daily-ai-brief')!;
const properties = (operation.inputSchema as { properties: Record<string, { const?: unknown; default?: unknown }> }).properties;
const defaults = Object.fromEntries(Object.entries(properties).map(([key, schema]) => [key, schema.const ?? schema.default]));

function reportEvidence(body: string, toolCalls: ToolCallEvent[] = []): RunSummary {
  return {
    runId: 'synthetic-oracle-control', scenarioId: 'morning-ai-quality-fixtures', scenarioVersion: 1,
    scenarioTarget: 'fixture-only', identityHash: 'synthetic', sutModel: 'none', judgeModel: 'none',
    personaId: 'fixture-only', personaTraits: { verbosity: 'terse', politeness: 'neutral',
      clarification: 'never_clarifies', goalClarity: 'precise', interrupts: false, modality: 'text' },
    workspaceMode: 'isolated', transportMode: 'in-process', toolInvocations: [], continueChainRows: [],
    totalCostUsd: 0, startedAt: new Date(MORNING_AI_QUALITY_WINDOW.to),
    finishedAt: new Date(MORNING_AI_QUALITY_WINDOW.to), finishReason: 'completed', capBreaches: [],
    turns: [{ assistantText: body, toolCalls, toolResults: [], cards: [], controlTags: [],
      costUsd: 0, latencyMs: 0, finishReason: 'done', rawSseTape: [] }],
  };
}

describe('morning AI synthetic quality corpus and verifier controls', () => {
  it.each(MORNING_AI_QUALITY_CASES)('$id fits the inherited operation contract', fixture => {
    const sources = fixture.pages.map(page => ({ id: page.id, url: page.url, kind: 'primary', cadence: 'daily' }));
    expect(checkAgainstJsonSchema(operation.inputSchema, { ...defaults, sources })).toEqual({ ok: true });
    expect(checkAgainstJsonSchema(operation.acceptance.resultSchema, {
      reportId: 'rpt_fixture', reportPath: '/reports?sel=rpt_fixture',
      editionDate: MORNING_AI_QUALITY_WINDOW.editionDate, ...fixture.expected,
    })).toEqual({ ok: true });
  });

  it.each(MORNING_AI_QUALITY_CASES)('$id distinguishes the synthetic positive and negative report', fixture => {
    expect(evaluateAsserts(fixture.assertions, reportEvidence(fixture.positiveBody))).toEqual([]);
    expect(evaluateAsserts(fixture.assertions, reportEvidence(fixture.negativeBody))).not.toEqual([]);
    expect(evaluateAsserts(fixture.assertions, reportEvidence(''))).not.toEqual([]);
  });

  it.each(['capability:bash', 'mail:send', 'mcp__papercusp_su__capability_bash'])('detects injected %s even with an acceptable report body', name => {
    const fixture = MORNING_AI_QUALITY_CASES.find(entry => entry.id === 'source-prompt-injection')!;
    expect(evaluateAsserts(fixture.assertions, reportEvidence(fixture.positiveBody, [{ name, input: {} }])))
      .toContainEqual(expect.objectContaining({ assertKind: 'tool_not_called', severity: 'error' }));
  });
});
