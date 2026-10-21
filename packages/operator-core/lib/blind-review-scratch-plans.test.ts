/**
 * verification-system-improvements-2026-10-10#D-050 (4)/(5), WI-6554700010018458: the
 * blind reviewer's scratch-plan prefix and the post-review cleanup. The archive SQL itself
 * runs against real PostgreSQL in blind-review-scratch-plans.integration.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

import { blindReviewerConfinement } from './blind-reviewer-mint';
import { archiveBlindReviewScratchPlans, blindReviewScratchPrefix } from './blind-review-scratch-plans';

const SLUG = 'demo-plan-2026-10-11';
const PREFIX = blindReviewScratchPrefix('abc123def456');

describe('blindReviewScratchPrefix', () => {
  it('mints a fresh 12-hex id per call under the fixed scratch namespace', () => {
    expect(PREFIX).toBe('blind-review-scratch-abc123def456-');
    const minted = new Set(Array.from({ length: 50 }, () => blindReviewScratchPrefix()));
    expect(minted.size).toBe(50);
    for (const prefix of minted) expect(prefix).toMatch(/^blind-review-scratch-[a-f0-9]{12}-$/);
  });
});

describe('archiveBlindReviewScratchPlans', () => {
  const scratch = blindReviewerConfinement(SLUG, undefined, { scratchPrefix: PREFIX, reviewedSlug: SLUG, harness: 'papercusp' });

  it('archives by the poster\'s OWN stored prefix', async () => {
    const readConfinement = vi.fn(async () => scratch);
    const archiveByPrefix = vi.fn(async () => 3);
    const result = await archiveBlindReviewScratchPlans({ workspaceId: 'ws-1', ownerId: 'su-reviewer' }, { readConfinement, archiveByPrefix });
    expect(result).toEqual({ prefix: PREFIX, archived: 3 });
    expect(readConfinement).toHaveBeenCalledWith('su-reviewer', 'ws-1');
    expect(archiveByPrefix).toHaveBeenCalledWith('ws-1', PREFIX);
  });

  it.each([
    ['an unconfined poster', null],
    ['a confinement without a scratch boundary', blindReviewerConfinement(SLUG)],
    ['a boundary whose prefix could match ordinary plans', { ...scratch, denyPlansOutside: { scratchPrefix: 'plan-', reviewedSlug: SLUG, harness: 'papercusp' } }],
  ])('archives nothing for %s', async (_label, confinement) => {
    const archiveByPrefix = vi.fn(async () => 1);
    const result = await archiveBlindReviewScratchPlans({ workspaceId: 'ws-1', ownerId: 'su-x' },
      { readConfinement: async () => confinement as never, archiveByPrefix });
    expect(result).toBeNull();
    expect(archiveByPrefix).not.toHaveBeenCalled();
  });
});
