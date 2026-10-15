import { describe, expect, it } from 'vitest';
import { compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { supportToEngineeringOperation } from './support-workflow-operation';

describe('support operation declaration transport', () => {
  it.each([undefined, { mode: 'exact' as const, models: ['gpt-6.1-sol'] as [string], onUnavailable: 'fail' as const }])(
    'compiles the same revision before and after JSON transport (model: %j)', (model) => {
      const operation = supportToEngineeringOperation({ id: 'support-to-engineering', version: '1',
        role: 'support-worker', identity: { kind: 'identity', ref: 'support-worker', revision: '1', contentHash: 'b'.repeat(64) },
        accountableOwner: 'engineering-owner', reviewerPrincipals: ['engineering-reviewer'],
        allowedSources: ['slack'], allowedActions: ['prepare-handoff'], maximumCostMicros: 100_000, model });
      const source = { id: 'support-operation', workItem: { kind: 'task' }, roles: [{ id: 'support-worker' }],
        spine: { edges: { DONE: { to: 'done' } } }, dependencies: { tools: ['blueprint:read-private-input'] },
        operations: [operation] };
      const original = compileAgentSpecification({ source });
      const transported = compileAgentSpecification({ source: JSON.parse(JSON.stringify(source)) });
      expect(original.specificationRevision).toBe(transported.specificationRevision);
    },
  );
});
