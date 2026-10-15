import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

describe('PG-canonical plan storage guidance', () => {
  const reader = readFileSync(join(ROOT, 'packages/operator-core/lib/agent-tools/plans/get.ts'), 'utf8');
  const powerPrompt = readFileSync(join(ROOT, 'apps/operator/prompts/papercusp-su-power.tools.md'), 'utf8');
  const newPlanPrompt = readFileSync(join(ROOT, 'apps/operator/prompts/kickoffs/new-plan.md'), 'utf8');
  const claudeGuide = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
  const agentGuide = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');

  it('describes plan lookup and authoring as PG-backed while keeping Markdown as content format', () => {
    expect(reader).toContain('Plans are resolved from the PG-canonical store, not from a filename.');
    expect(reader).not.toContain('Resolves both docs/plans/ and docs/plans/archive/');

    expect(powerPrompt).toContain('are stored in PG and their canonical content is Markdown.');
    expect(powerPrompt).toContain('Any on-disk mirror is optional and never the');
    expect(powerPrompt).not.toContain("are markdown under the harness's `docs/plans/`.");

    expect(newPlanPrompt).toContain('A plan is a PG-canonical record in `harness_plans`.');
    expect(newPlanPrompt).not.toContain('The on-disk format is the source of truth');

    expect(claudeGuide).toContain('Plan Markdown is stored in PG and can be exported on demand');
    expect(claudeGuide).toContain('any on-disk mirror is optional, generated from PG, and may be absent');
    expect(claudeGuide).not.toContain('docs/plans/*.md files are projections');

    expect(agentGuide).toContain('Plan Markdown is stored in PG and can be exported on demand');
    expect(agentGuide).toContain('any on-disk mirror is optional, generated from PG, and may be absent');
    expect(agentGuide).not.toContain('docs/plans/*.md files are projections');
  });
});
