/**
 * EI-24169147687808911: the spawn-tree page must describe the current
 * depth boundary from intel:spawn_tree, not the future Phase 9 shape as live.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DOC = join(ROOT, 'apps/operator-docs/src/content/docs/agent-spawning/observability.mdx');
const TOOL = join(ROOT, 'packages/agent-mcp/src/tools/intel/spawn_tree.ts');

const compact = (source: string): string =>
  source.replace(/^\s*\*\s?/gm, '').replace(/\s+/g, ' ').trim();

describe('spawn-tree observability depth claims', () => {
  const doc = compact(readFileSync(DOC, 'utf8'));
  const tool = compact(readFileSync(TOOL, 'utf8'));

  it('keeps the page aligned with the current implementation boundary', () => {
    expect(tool).toContain(
      'Today every row is depth=0 (Phase 9 spawn-of-spawn not yet shipped).',
    );
    expect(tool).toContain(
      'FROM harness_shared.tool_invocations_spawn_tree_filtered(',
    );
    expect(doc).toContain(
      "**Today every row is `depth = 0`;** Phase 9's spawn-of-spawn work has not shipped, so child-agent tool calls do not yet appear at depth greater than 0.",
    );
    expect(doc).toContain(
      'The feed is built from `harness_shared.tool_invocations_spawn_tree_filtered` (Migration 460).',
    );
  });

  it('does not present child tool-call lineage as available before Phase 9', () => {
    expect(doc).not.toMatch(
      /depth>0 rows appear automatically when a spawned child agent makes its own tool calls/i,
    );
  });
});
