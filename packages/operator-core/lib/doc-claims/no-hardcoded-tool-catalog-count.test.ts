import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * EI-26237859802317262 — agent-facing prompt and tool-description text hand-maintained a
 * "~550-tool catalog" count while the generated catalog held 932 (d740fc3802) and then 977.
 * A tool count is code-describing metadata (CLAUDE.md "derive, pin, or attest"): the number
 * belongs to `.papercusp/tool-catalog.json`, never to prose that ships into every launch.
 * These runtime-facing sources must stay count-free ("the full tool catalog").
 */
const RUNTIME_FACING = [
  '../agent-tools/tools/find.ts',
  '../agent-tools/tools/invoke.ts',
  '../bash-substitution/routing-table.ts',
  '../../../../apps/operator/scripts/hooks/omp/coord-hook.ts',
  '../../../../apps/operator/prompts/papercusp-su.claude.md',
  '../../../../apps/operator/prompts/papercusp-su.codex.md',
] as const;

/**
 * WI-6554700010016871 — code comments that DESCRIBE the catalog (its size against the
 * prompt-weight budget, the bundle it drags in, a past full-surface incident) carried the same
 * stale "~550" figure. They are not shipped as instructions, but they are read as fact by the
 * next agent sizing a change, so they are pinned count-free too.
 */
const CATALOG_COMMENT_SITES = [
  '../../../../.github/workflows/test.yml',
  '../../../../apps/operator-vite/src/shims/delegated-tasks-browser.ts',
  '../../../../apps/operator-vite/vite.config.ts',
  '../../../../scripts/check-bundle-budget.mjs',
  '../agent-tools/agent_tools/list-shape.ts',
  '../desktop-install/splice-tooling-overlay.ts',
  '../fleet/invoke-outcome.test.ts',
  '../harness/improvements/tool-latency-budget.ts',
  '../result-door-prompt.ts',
  '../result-door.ts',
  '../result-projection/parse.ts',
  '../result-projection/types.ts',
  '../../../../libs/papercusp/packages/orchestrator/src/invoke.ts',
  '../../../../libs/papercusp/packages/orchestrator/src/invoke.test.ts',
  '../../../../libs/papercusp/packages/orchestrator/src/native-tool-search-deny.ts',
] as const;

/** "~550-tool", "~ 550 tools", "(~550 tools)", or a bare "550-tool catalog/registry/surface". */
const HARDCODED_TOOL_COUNT = /~\s?\d{3,4}(?:-tool|\s+tools)\b|\b\d{3,4}-tool (?:catalog|registry|surface)\b/;

describe('runtime-facing prompt text carries no hand-maintained tool-catalog count', () => {
  it('the pattern catches every phrasing that drifted (positive control)', () => {
    expect(HARDCODED_TOOL_COUNT.test('Find tools by INTENT across the full ~550-tool catalog')).toBe(true);
    expect(HARDCODED_TOOL_COUNT.test('the superuser MCP catalog is large (~550 tools).')).toBe(true);
    expect(HARDCODED_TOOL_COUNT.test('a seed of the 977-tool catalog')).toBe(true);
    expect(HARDCODED_TOOL_COUNT.test('without a database or the 550-tool registry.')).toBe(true);
    expect(HARDCODED_TOOL_COUNT.test('rendered truncated at ~550 chars;')).toBe(false);
    expect(HARDCODED_TOOL_COUNT.test('the full tool catalog (hybrid lexical + semantic)')).toBe(false);
    expect(HARDCODED_TOOL_COUNT.test('the superuser MCP catalog is large (hundreds of tools).')).toBe(false);
  });

  for (const rel of [...RUNTIME_FACING, ...CATALOG_COMMENT_SITES]) {
    it(`${rel.split('/').pop()} states no tool count`, () => {
      const text = readFileSync(new URL(rel, import.meta.url), 'utf8');
      expect(text.length).toBeGreaterThan(0);
      const hits = text.split('\n').filter((line) => HARDCODED_TOOL_COUNT.test(line));
      expect(hits).toEqual([]);
    });
  }
});
