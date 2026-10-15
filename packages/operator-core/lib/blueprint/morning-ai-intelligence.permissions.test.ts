/** Regression guard for the administrator's least-privilege researcher ceiling. */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadBlueprintFromFile } from '@papercusp/orchestrator/blueprint';
import { identityGrantToolFailure } from '../capability-envelope/blueprint-envelopes';

const administratorBlueprint = loadBlueprintFromFile(fileURLToPath(new URL(
  '../../../../.papercusp/blueprint.yaml', import.meta.url,
))).blueprint;
const blueprint = loadBlueprintFromFile(fileURLToPath(new URL(
  '../../../../libs/papercusp/packages/harness/blueprints/morning-ai-intelligence/blueprint.yaml',
  import.meta.url,
))).blueprint;
const operation = blueprint.operations!.find(entry => entry.id === 'daily-ai-brief')!;

// Pin the exact proposal separately from the producer's declaration: a new
// required verb must trigger review instead of silently widening this ceiling.
const proposedTools = [
  'capability:fetch', 'capability:read',
  'work_items:get', 'work_items:claim', 'work_items:complete', 'plans:get',
  'reports:publish', 'reports:get', 'reports:list', 'coord:send',
];
const administratorResearcherTools = administratorBlueprint.fleet?.workerRoles
  ?.find(entry => entry.id === 'researcher')?.capabilities ?? [];
const capabilities = new Map<string, readonly string[]>([
  ['capability:fetch', ['capability:net']],
  ['capability:read', ['capability:fs-read']],
  ['work_items:get', ['work_items:read']],
  ['work_items:claim', ['work_items:write']],
  ['work_items:complete', ['work_items:write']],
  ['plans:get', ['plans:read']],
  ['reports:publish', ['reports:write']],
  ['reports:get', ['reports:read']],
  ['reports:list', ['reports:read']],
  ['coord:send', ['coord:write']],
  ['capability:bash', ['capability:bash']],
  ['capability:write', ['capability:fs-write']],
  ['code:run', ['code:execute']],
  ['mail:send', ['mail:send']],
  ['social:post', ['social:write']],
  ['plans:set-plan-status', ['plans:write']],
  // Shared capability names must not admit a sibling concrete verb.
  ['reports:retire', ['reports:write']],
  ['work_items:create', ['work_items:write']],
  ['features:get', ['work_items:read']],
  ['plans:items', ['plans:read']],
]);
const researcherCeiling = { allowCapabilities: administratorResearcherTools };
const operationCeiling = { allowCapabilities: operation.policy.requiredTools };

describe('morning AI researcher permission boundary', () => {
  it('keeps the producer and administrator ceiling on the same exact ten verbs', () => {
    expect([...operation.policy.requiredTools].sort()).toEqual([...proposedTools].sort());
    expect([...administratorResearcherTools].sort()).toEqual([...proposedTools].sort());
    for (const tool of proposedTools) expect(blueprint.dependencies!.tools).toContain(tool);
  });

  it.each(proposedTools)('admits %s inside both researcher and operation ceilings', toolName => {
    expect(identityGrantToolFailure({
      toolName, tools: capabilities, ceilings: [researcherCeiling, operationCeiling],
    })).toBeNull();
  });

  it.each([
    'capability:bash', 'capability:write', 'code:run', 'mail:send',
    'social:post', 'plans:set-plan-status', 'reports:retire', 'work_items:create',
    'features:get', 'plans:items',
  ])('denies %s even when a broader role or operation would allow it', toolName => {
    const broad = { allowCapabilities: ['*'] };
    for (const ceilings of [[researcherCeiling, broad], [broad, operationCeiling]]) {
      expect(identityGrantToolFailure({ toolName, tools: capabilities, ceilings }))
        .toBe('outside-ceiling');
    }
  });

  it('fails closed without a measurable policy or with an empty role ceiling', () => {
    for (const ceilings of [null, []]) {
      expect(identityGrantToolFailure({ toolName: 'reports:publish', tools: capabilities, ceilings }))
        .toBe('policy-unavailable');
    }
    expect(identityGrantToolFailure({
      toolName: 'reports:publish', tools: capabilities,
      ceilings: [{ allowCapabilities: [] }, operationCeiling],
    })).toBe('outside-ceiling');
  });

  it('honors an administrator revocation despite the unchanged accepted operation', () => {
    expect(identityGrantToolFailure({
      toolName: 'reports:publish', tools: capabilities,
      ceilings: [{ allowCapabilities: proposedTools.filter(tool => tool !== 'reports:publish') }, operationCeiling],
    })).toBe('outside-ceiling');
  });
});
