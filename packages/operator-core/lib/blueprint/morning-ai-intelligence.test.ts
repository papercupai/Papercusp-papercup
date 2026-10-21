import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadBlueprintFromFile } from '@papercusp/orchestrator/blueprint';
import { checkAgainstJsonSchema } from '../json-schema-validation';
import { selectAcceptedOperationWorkerModel } from './operation-worker-binding';
import { computeNextFire } from '../harness/routines/schedule-next';

// Exercise the schemas through the same validator used at operation submission
// and completion, with the actual inherited blueprint rather than a copy.
const blueprintPath = fileURLToPath(new URL(
  '../../../../libs/papercusp/packages/harness/blueprints/morning-ai-intelligence/blueprint.yaml',
  import.meta.url,
));
const blueprint = loadBlueprintFromFile(blueprintPath).blueprint;
const operation = blueprint.operations!.find((entry) => entry.id === 'daily-ai-brief')!;
const inputSchema = operation.inputSchema as Record<string, any>;
const input = Object.fromEntries(Object.entries(inputSchema.properties).map(([key, schema]) => {
  const property = schema as Record<string, unknown>;
  return [key, property.const ?? property.default];
}));
const output = {
  reportId: 'rpt_fixture', reportPath: '/reports?sel=rpt_fixture', editionDate: '2026-10-07',
  itemCount: 3, sourceCount: 20, unavailableSources: [], status: 'published',
};

describe('morning AI operation admission and completion contracts', () => {
  it.each([
    ['2026-10-07T19:00:00Z', '2026-10-08T13:00:00.000Z'],
    ['2026-10-31T19:00:00Z', '2026-11-01T14:00:00.000Z'],
    ['2027-03-13T19:00:00Z', '2027-03-14T13:00:00.000Z'],
  ])('keeps the daily09:00New York occurrence after %s', (from, next) => {
    expect(computeNextFire({
      kind: 'rrule', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
      dtstart: '2026-10-08T09:00:00.000Z', tzid: 'America/New_York',
    }, new Date(from))?.toISOString()).toBe(next);
  });

  it('selects the pinned Codex model and refuses an incompatible backend', () => {
    const binding = { modelPolicy: operation.policy.model };
    expect(selectAcceptedOperationWorkerModel(binding, null, 'codex')).toMatchObject({
      model: 'gpt-6.1-sol:medium', backend: 'codex', source: 'operation-policy',
    });
    expect(() => selectAcceptedOperationWorkerModel(binding, null, 'claude'))
      .toThrow('not supported by the Claude backend');
    expect(() => selectAcceptedOperationWorkerModel(binding, 'gpt-6-astra', 'codex'))
      .toThrow('outside the accepted exact model policy');
    expect(() => selectAcceptedOperationWorkerModel(binding, 'gpt-6.1-sol:high', 'codex'))
      .toThrow('reasoning effort differs');
  });

  it('loads the research spine and admits the explicit approved input', () => {
    expect(blueprint.knobs.requiresRepo).toBe(false);
    expect(blueprint.spine.decider).toBe('research-director');
    expect(checkAgainstJsonSchema(inputSchema, input)).toEqual({ ok: true });
  });

  it('requires opportunities analysis and an explicit quiet or partial-day disposition', () => {
    const instructions = inputSchema.properties.instructions.const;
    expect(instructions).toContain('dedicated Papercusp opportunities section');
    expect(instructions).toContain('fit or existing seam, confidence and limits, and a recommended next action');
    expect(instructions).toContain('no actionable Papercusp idea was found');
    expect(instructions).toContain('coverage limits prevent a recommendation');
  });

  it.each([
    ['oversized lookback', { lookbackHours: 73 }],
    ['zero lookback', { lookbackHours: 0 }],
    ['too many items', { maxItems: 11 }],
    ['fractional item count', { maxItems: 1.5 }],
    ['changed instructions', { instructions: 'Edit code and send email.' }],
    ['changed timezone', { timezone: 'UTC' }],
    ['changed report series', { seriesTag: 'series:other' }],
    ['empty sources', { sources: [] }],
    ['non-HTTPS source', { sources: [{ id: 'x', url: 'http://example.test', kind: 'primary', cadence: 'daily' }] }],
    ['unknown source kind', { sources: [{ id: 'x', url: 'https://example.test', kind: 'advert', cadence: 'daily' }] }],
    ['unexpected authority knob', { allowShell: true }],
  ])('refuses %s before dispatch', (_label, patch) => {
    expect(checkAgainstJsonSchema(inputSchema, { ...input, ...patch })).toMatchObject({
      ok: false, code: 'invalid_data',
    });
  });

  it('does not silently supply missing source input from JSON Schema defaults', () => {
    const { sources: _sources, ...missing } = input;
    expect(checkAgainstJsonSchema(inputSchema, missing)).toMatchObject({ ok: false });
    expect(missing).not.toHaveProperty('sources');
  });

  it.each(['published', 'partial', 'no-material-updates'])('accepts a durable %s report result', (status) => {
    const result = {
      ...output, status,
      itemCount: status === 'no-material-updates' ? 0 : 3,
      unavailableSources: status === 'partial' ? ['alphasignal'] : [],
    };
    expect(checkAgainstJsonSchema(operation.acceptance.resultSchema, result)).toEqual({ ok: true });
  });

  it.each([
    ['missing report reference', { reportId: undefined }],
    ['invalid report reference', { reportId: 'other' }],
    ['external viewer path', { reportPath: 'https://example.test' }],
    ['unrouted viewer path', { reportPath: '/reports/rpt_fixture' }],
    ['missing edition', { editionDate: undefined }],
    ['missing source coverage', { unavailableSources: undefined }],
    ['excess report items', { itemCount: 11 }],
    ['negative source count', { sourceCount: -1 }],
    ['no source attempts', { sourceCount: 0 }],
    ['unbounded source count', { sourceCount: 31 }],
    ['duplicate failed feed', { status: 'partial', unavailableSources: ['openai', 'openai'] }],
    ['empty failed feed id', { status: 'partial', unavailableSources: [''] }],
    ['quiet day with material items', { status: 'no-material-updates', itemCount: 3 }],
    ['quiet day hiding source outage', { status: 'no-material-updates', itemCount: 0, unavailableSources: ['openai'] }],
    ['complete status hiding source outage', { unavailableSources: ['openai'] }],
    ['material status on quiet day', { itemCount: 0 }],
    ['partial status without coverage gap', { status: 'partial', unavailableSources: [] }],
    ['fabricated success status', { status: 'shipped' }],
    ['unexpected output', { secret: 'unapproved output' }],
  ])('refuses %s at completion', (_label, patch) => {
    expect(checkAgainstJsonSchema(operation.acceptance.resultSchema, { ...output, ...patch }))
      .toMatchObject({ ok: false, code: 'invalid_data' });
  });

  it('admits an explicitly partial quiet day after failed feeds', () => {
    expect(checkAgainstJsonSchema(operation.acceptance.resultSchema, {
      ...output, status: 'partial', itemCount: 0, unavailableSources: ['last-week-in-ai'],
    })).toEqual({ ok: true });
  });
});
