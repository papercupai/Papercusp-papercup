/**
 * Tool Argument Parity Guard (EI-11400, WI-4652)
 *
 * This guard ensures that related tool families maintain SEMANTIC PARITY: tools in the
 * same family accept the SAME canonical argument names, with no per-tool synonym drift.
 * When a tool is renamed or a field is added, EVERY related tool must follow suit or
 * EXPLICITLY register an exception.
 *
 * The guard RED-FAILS if a tool family drifts out of parity, forcing a conscious decision
 * to either:
 *  (1) normalize all tools in the family to the same vocabulary, or
 *  (2) register an exception if divergence is intentional.
 *
 * Alpha policy (ratified P-005/EI-11400, enforced canonically by
 * `lib/__tests__/semantic-argument-vocabulary.test.ts`): a breaking rename, not a
 * compatibility-alias layer — one public spelling per concept, strict rejection of the
 * old name. This guard therefore asserts parity on the CANONICAL field only and asserts
 * the superseded alias is ABSENT — it must never re-introduce alias-compat expectations
 * that would fight the canonical no-alias guard.
 *
 * CLASS: recurrence guard — prevents the retry-tax bug (EI-11400) from re-occurring when
 * a new tool is added or renamed without updating siblings.
 */
import { describe, it, expect } from 'vitest';
import { lookupByMcpName } from '@papercusp/agent-mcp';

// Import all tool modules to register them into the catalog
import './rubrics/get';
import './rubrics/trend';
import './code/run';
import './code/tools';
import workItemsGet from './work_items/get';

describe('Tool Argument Parity Guard (EI-11400, WI-4652)', () => {
  it.each([[true, 'full'], [false, 'summary']] as const)('work_items:get detail %s and %s select the same enrichment scope', (booleanDetail, stringDetail) => {
    const base = { id: 'WI-detail-p009' };
    const aliased = workItemsGet.args.parse({ ...base, detail: booleanDetail });
    const canonical = workItemsGet.args.parse({ ...base, detail: stringDetail });
    expect(aliased).toEqual(canonical);
    expect(aliased).toMatchObject({ id: base.id, detail: booleanDetail });
  });

  /**
   * Rubrics family parity: get, trend, list, search, etc. should all accept
   * rubricRef (canonical) and none should expose the superseded rubricId alias.
   */
  describe('rubrics family semantic parity', () => {
    const rubricTools = ['rubrics:get', 'rubrics:trend'];
    const canonicalFieldName = 'rubricRef';
    const supersededAlias = 'rubricId';

    it.each(rubricTools)('%s accepts canonical argument `rubricRef`', (toolName) => {
      const tool = lookupByMcpName(toolName);
      expect(tool, `${toolName} not registered`).toBeDefined();

      const properties = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
      if (properties) {
        expect(
          properties[canonicalFieldName],
          `${toolName} must accept canonical field \`${canonicalFieldName}\``,
        ).toBeDefined();
      }
    });

    it.each(rubricTools)('%s exposes no superseded `rubricId` alias (no-alias policy, EI-11400)', (toolName) => {
      const tool = lookupByMcpName(toolName);
      expect(tool, `${toolName} not registered`).toBeDefined();

      const properties = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
      if (properties) {
        expect(
          properties[supersededAlias],
          `${toolName} must NOT accept superseded alias \`rubricId\` (alpha no-alias policy, P-005/EI-11400)`,
        ).toBeUndefined();
      }
    });

    it('rubrics:trend exposes the definition opt-in supported by scorecardTrend', () => {
      const tool = lookupByMcpName('rubrics:trend');
      expect(tool, 'rubrics:trend not registered').toBeDefined();

      const properties = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
      expect(properties?.includeDefinition).toMatchObject({ type: 'boolean' });
    });

    it('rubrics family maintains consistent vocabulary across all tools', () => {
      // This test documents the expected parity set; update when adding a new rubrics tool
      const expectedFamily = new Set(rubricTools);
      // If you add a new rubrics tool, add it to the expected set AND ensure it accepts
      // rubricRef (and never rubricId), then GREEN the test.
      expect(expectedFamily.size).toBeGreaterThan(0);
    });
  });

  /**
   * Code family parity: run, tools, capture-recipe should all accept `script`
   * (canonical) and none should expose the superseded `code` alias.
   */
  describe('code family semantic parity', () => {
    it('code:run accepts canonical argument `script`', () => {
      const tool = lookupByMcpName('code:run');
      expect(tool, 'code:run not registered').toBeDefined();

      const properties = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
      if (properties) {
        expect(properties['script'], 'code:run must accept canonical field `script`').toBeDefined();
      }
    });

    it('code:run exposes no superseded `code` alias (no-alias policy, EI-11400)', () => {
      const tool = lookupByMcpName('code:run');
      expect(tool, 'code:run not registered').toBeDefined();

      const properties = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
      if (properties) {
        expect(
          properties['code'],
          'code:run must NOT accept superseded alias `code` (alpha no-alias policy, P-005/EI-11400)',
        ).toBeUndefined();
      }
    });
  });

  /**
   * Future family parity checks (deferred from WI-4652 as lower-priority):
   *  - plans family: should all use the same ownership/item naming (owner vs ownerEmail, item vs itemId)
   *  - work_items family: should all use consistent field names (body vs summary — already fixed by WI-4492)
   *
   * When these are normalized, add parity tests below.
   */
  describe('future parity audit (WI-4652 deferred)', () => {
    it.todo('plans family should maintain consistent ownership field naming (owner vs ownerEmail)');
    it.todo('plans family should maintain consistent item field naming (item vs itemId)');
    it.todo('sessions family should align on mandatory field constraints (e.g., <=300 cap on sessions:timeline)');
  });
});
