import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../../..');
const inventory = JSON.parse(readFileSync(resolve(repo, 'docs/evidence/public-manual-refresh-20261003.json'), 'utf8'));
const source = resolve(repo, inventory.manual.sourceRoot);

describe('public manual inventory acceptance', () => {
  it('preserves the dated inventory and its new guides as the manual grows', () => {
    const pages = readdirSync(source).filter((name) => name.endsWith('.mdx'));
    // This receipt records the 2026-10-03 artifact, not the moving source tree.
    // Current completeness is enforced by public-docs-readiness.test.ts.
    expect(inventory.manual.articles).toBeLessThanOrEqual(pages.length);
    expect(new Set(inventory.newGuides).size).toBe(inventory.newGuides.length);
    expect(inventory.manual.existingArticlesReviewedAndAnchored + inventory.newGuides.length).toBe(inventory.manual.articles);
    for (const slug of inventory.newGuides) expect(pages).toContain(`${slug}.mdx`);
  });
  it('records a measured serving artifact and preserves unmet acceptance separately', () => {
    expect(inventory.publication.observedServingRelease).toMatch(/^[A-Za-z0-9_-]+-\d{17}-\d+-[a-f0-9]{8}$/);
    expect(inventory.verification.some((proof: {kind: string; origin?: string}) =>
      proof.kind === 'production-integration' && proof.origin === 'https://app.papercusp.com')).toBe(true);
    expect(inventory.remaining).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'formal plan acceptance' }),
    ]));
  });
});
