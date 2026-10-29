import { describe, expect, it } from 'vitest';
import { readWorkItemDefinition, WorkItemDefinitionSchema } from './work-item-definition';

describe('structured work-item fields (P-022 / R-13)', () => {
  it('reads only structured fields, ignoring conflicting body headings', () => {
    const definition = { acceptanceCriteria: ['roundtrip succeeds'], firstUnit: 'create a fixture' };
    expect(readWorkItemDefinition({ workDefinition: definition, body: '## Acceptance\nWrong criterion' }))
      .toEqual(definition);
    expect(readWorkItemDefinition({ body: '## Acceptance\nProse only' })).toBeNull();
  });

  it.each([
    {}, { acceptanceCriteria: [] }, { acceptanceCriteria: [' '] },
    { scope: { inScope: ['one surface'] } }, { verificationTarget: { target: '' } },
    { firstUnit: '' }, { acceptanceCriteria: ['valid'], unexpected: true },
    { verificationTarget: { target: 'staging', testResult: 'already green' } },
  ])('refuses malformed or completion-shaped definitions: %j', (definition) => {
    expect(WorkItemDefinitionSchema.safeParse(definition).success).toBe(false);
    expect(readWorkItemDefinition({ workDefinition: definition })).toBeNull();
  });

  it('retains explicit scope exclusions and the existing verification mode', () => {
    const definition = {
      acceptanceCriteria: ['read returns the saved fields'],
      scope: { inScope: ['create/update/read'], outOfScope: ['legacy conversion'] },
      verificationTarget: { target: 'isolated Postgres', verifiedHow: 'integration' },
      firstUnit: 'create and read one work-item',
    };
    expect(WorkItemDefinitionSchema.parse(definition)).toEqual(definition);
  });
});
