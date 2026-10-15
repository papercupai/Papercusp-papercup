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
