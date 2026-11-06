/**
 * R-8 / R-10 (plan idea-to-spec-product-shaping-2026-10-09): the su plan
 * guidance must (a) put product shaping before requirements and requirements
 * before tasks, and (b) lead the owner's plan-approval ask with the rendered
 * ownerWalkthrough rather than the requirement list.
 *
 * Reads the CANONICAL prompt sources (never a rendered/materialized copy): the
 * domain-neutral su base + kernel in the libs/papercusp submodule, and the two
 * psu playbooks. A source that loses either instruction fails here.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRODUCT_SHAPING_GUIDANCE } from './product-shaping';
import { renderSuPlaybook } from '../../desktop-install/papercusp-files';
import { composeSuStackSource } from '@papercusp/orchestrator/blueprint';

const REPO_ROOT = resolve(__dirname, '../../../../..');
const CANONICAL_SU_PLAN_GUIDANCE = [
  'libs/papercusp/packages/harness/blueprints/base/prompts/su.kernel.md',
  'libs/papercusp/packages/harness/blueprints/base/prompts/su.md',
  'apps/operator/prompts/papercusp-su-engineer.tools.md',
  'apps/operator/prompts/papercusp-su-power.tools.md',
] as const;

/** The guidance bullet, joined across its wrapped lines. */
function shapingBullet(source: string): string | null {
  const start = source.indexOf('- **Shape, then specify;');
  if (start === -1) return null;
  const rest = source.slice(start + 2);
  const end = rest.search(/\n- \*\*|\n#/);
  return (end === -1 ? rest : rest.slice(0, end)).replace(/\s+/g, ' ');
}

describe('su plan guidance puts shaping first and leads approval with the walkthrough', () => {
  it.each(CANONICAL_SU_PLAN_GUIDANCE)('%s', path => {
    const bullet = shapingBullet(readFileSync(resolve(REPO_ROOT, path), 'utf8'));
    expect(bullet, `${path} lacks the shape-then-specify bullet`).not.toBeNull();
    // R-10: shaping → requirements → tasks, in that order.
    expect(bullet).toMatch(/Product shaping.*BEFORE requirements, and requirements before tasks/);
    // R-8: the approval ask leads with the walkthrough, not the requirements.
    expect(bullet).toMatch(/approve with the `ownerWalkthrough`.*first/);
    expect(bullet).toContain("plans:audit { slug, phase:'shaping' }");
    expect(bullet).toMatch(/not the requirement list/);
  });

  it('the shaping-tool guidance names the walkthrough-first approval too', () => {
    expect(PRODUCT_SHAPING_GUIDANCE).toMatch(/Shape the product before requirements\/tasks/);
    expect(PRODUCT_SHAPING_GUIDANCE).toMatch(/lead the owner's approval ask with the ownerWalkthrough, not the requirements/);
  });

  it('calibration: the extractor rejects a source without the bullet and one with the order reversed', () => {
    expect(shapingBullet('- **Plan before non-trivial work.** plans:new')).toBeNull();
    const reversed = shapingBullet('- **Shape, then specify; x.** Write requirements BEFORE Product shaping.\n- **Next.**');
    expect(reversed).not.toBeNull();
    expect(reversed).not.toMatch(/Product shaping.*BEFORE requirements, and requirements before tasks/);
  });
});

describe('discovery phase guidance reaches launch rendering', () => {
  it.each(['claude', 'codex', 'omp'] as const)('%s renders both supported su profiles from canonical sources', async agent => {
    for (const profile of ['engineer', 'power'] as const) {
      const rendered = await renderSuPlaybook({ agent, profile, tier: 'full',
        baseSource: resolve(REPO_ROOT, 'libs/papercusp/packages/harness/blueprints/base/prompts/su.md'),
        baseText: composeSuStackSource({ harnessDir: resolve(REPO_ROOT, 'libs/papercusp/packages/harness') }).text,
        overlayDir: resolve(REPO_ROOT, 'apps/operator/prompts') });
      const instruction = rendered.text.replace(/\s+/g, ' ');
      expect(instruction).toContain('Brief → scoped discovery → findings incorporated → implementation review → execution.');
      expect(instruction).toContain('provisional discovery brief');
      expect(instruction).toContain("plans:audit { slug, phase:'discovery' }");
      expect(instruction).toContain('proof-warming P-001');
      expect(instruction).toContain('historical terminal records');
    }
  });

  it.each(['scoper', 'reviewer', 'worker'])('%s receives its phase and authority boundary', role => {
    const prompt = readFileSync(resolve(REPO_ROOT, `apps/operator/prompts/${role}.tools.md`), 'utf8');
    expect(prompt).toContain('Brief → scoped discovery → findings incorporated → implementation review → execution.');
    expect(prompt.replace(/\s+/g, ' ')).toContain('provisional discovery brief');
  });
});
