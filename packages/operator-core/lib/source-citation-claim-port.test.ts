import { describe, expect, it, vi } from 'vitest';

import {
  getClaimTimeSourceCitation,
  sourceCitationWarning,
  type ClaimTimeSourceCitationHint,
} from './source-citation-claim-port';

/**
 * EI-19418245218824265 — the eleventh claim-time trap guard, and the first that reads
 * the TREE rather than the ROW.
 *
 * Every test here injects `deps`, so none of them greps. That is not only for speed:
 * the leg's whole subject is repo content, so a test that let it reach the real tree
 * would assert against a corpus ~100 agents are mutating, and its verdict would change
 * without anyone touching this module.
 */
const searcher = (hits: string[]) => ({ search: vi.fn(async () => hits) });

describe('getClaimTimeSourceCitation', () => {
  it('returns null for a blank id WITHOUT consulting the search backend', async () => {
    const deps = searcher(['some/file.ts']);

    expect(await getClaimTimeSourceCitation({ workItemId: '   ', deps })).toBeNull();
    // Not merely "returns null": a blank id must not spend a search at all. An
    // unbounded substring grep for the empty string matches the entire tree.
    expect(deps.search).not.toHaveBeenCalled();
  });

  it('returns null when nothing in the tree cites the id', async () => {
    const deps = searcher([]);

    expect(await getClaimTimeSourceCitation({ workItemId: 'WI-6007', deps })).toBeNull();
    expect(deps.search).toHaveBeenCalledWith('WI-6007');
  });

  it('reports the citations and a summary when the tree names the id', async () => {
    const deps = searcher(['packages/operator-core/lib/scheduler/claim-spec-store.ts']);

    const hint = await getClaimTimeSourceCitation({ workItemId: 'WI-6007', deps });

    expect(hint?.workItemId).toBe('WI-6007');
    expect(hint?.citations).toContain('packages/operator-core/lib/scheduler/claim-spec-store.ts');
    // The wording comes from `summariseCodeExistence` so this leg and the Scout screen
    // cannot drift into two phrasings of the same verdict.
    expect(hint?.summary).toContain('cites this item');
  });

  it('reports bounded link-read and tree-grep timings without changing the hint', async () => {
    const deps = searcher(['packages/operator-core/lib/scheduler/claim-spec-store.ts']);
    const timings: Array<{ phase: string; elapsedMs: number; outcome: string }> = [];

    const hint = await getClaimTimeSourceCitation({
      workItemId: 'WI-6007',
      family: 'issue',
      deps,
      resolveEquivalentIds: vi.fn(async () => ['WI-canonical']),
      onTiming: (timing) => timings.push(timing),
    });

    expect(hint?.citations).toContain('packages/operator-core/lib/scheduler/claim-spec-store.ts');
    expect(timings.map(({ phase }) => phase)).toEqual(['duplicate-link-read', 'tree-grep']);
    expect(timings).toEqual([
      expect.objectContaining({ outcome: 'ok', elapsedMs: expect.any(Number) }),
      expect.objectContaining({ outcome: 'ok', elapsedMs: expect.any(Number) }),
    ]);
    expect(timings.every(({ elapsedMs }) => Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= 300_000)).toBe(true);
  });

  it('probes a bounded canonical duplicate equivalent while retaining the direct id', async () => {
    const deps = { search: vi.fn(async (term: string) => (term === 'WI-canonical' ? ['canonical.ts'] : [])) };
    const resolveEquivalentIds = vi.fn(async (ref: { workItemId: string; workspaceId?: string | null; harness?: string | null; family?: string | null }) => {
      expect(ref).toMatchObject({
        workItemId: 'WI-loser',
        workspaceId: 'papercusp-workspace',
        harness: 'papercusp',
        family: 'issue',
      });
      return ['WI-canonical'];
    });

    const hint = await getClaimTimeSourceCitation({
      workItemId: 'WI-loser',
      workspaceId: 'papercusp-workspace',
      harness: 'papercusp',
      family: 'issue',
      deps,
      resolveEquivalentIds,
    });

    expect(resolveEquivalentIds).toHaveBeenCalledTimes(1);
    expect(deps.search).toHaveBeenCalledWith('WI-loser');
    expect(deps.search).toHaveBeenCalledWith('WI-canonical');
    expect(hint?.matchedWorkItemIds).toEqual(['WI-canonical']);
    expect(hint?.citations).toEqual(['canonical.ts']);
    expect(hint?.summary).toContain('cites this item or a canonical equivalent');
  });

  it('fails open to the direct-id probe when duplicate relation lookup fails', async () => {
    const deps = searcher(['direct.ts']);

    const hint = await getClaimTimeSourceCitation({
      workItemId: 'WI-loser',
      family: 'issue',
      deps,
      resolveEquivalentIds: vi.fn(async () => {
        throw new Error('coord_links unavailable');
      }),
    });

    expect(hint?.workItemId).toBe('WI-loser');
    expect(hint?.citations).toEqual(['direct.ts']);
    expect(deps.search).toHaveBeenCalledWith('WI-loser');
  });

  it('spends exactly ONE search — the affordability claim that makes it viable on a claim', async () => {
    const deps = searcher(['a.ts']);

    await getClaimTimeSourceCitation({ workItemId: 'WI-6007', deps });

    // `maxTerms: 0` empties the distinctive-term candidate list so the probe's
    // expensive lexical loop never runs. If that argument were dropped, this leg
    // would silently become N greps on every claim rather than one.
    expect(deps.search).toHaveBeenCalledTimes(1);
  });

  it('is FAIL-OPEN: a broken search backend yields no hint, never "nothing cites this"', async () => {
    const deps = { search: vi.fn(async () => { throw new Error('search backend down'); }) };

    // The WI-6737 lesson, and the single most important property of this module: a
    // probe OUTAGE and a probe finding NOTHING both render as silence, so an
    // unavailable backend can never be read as evidence that the item is unbuilt —
    // which is the exact false negative this leg exists to prevent.
    //
    // ⚠ The guard that catches THIS is `probeCodeExistence`'s own internal try/catch
    // around `deps.search` (it sets `selfIdHits = undefined`), NOT this module's outer
    // catch — a rejecting searcher never reaches the latter. Asserted here anyway
    // because the property a caller depends on is the OBSERVABLE one, and this fails
    // if either layer regresses. The outer catch guards the paths injected deps
    // bypass entirely (`createGitGrepDeps` construction, `summariseCodeExistence`),
    // so no test here can reach it; do not read its absence as dead code.
    await expect(getClaimTimeSourceCitation({ workItemId: 'WI-6007', deps })).resolves.toBeNull();
  });
});

describe('sourceCitationWarning', () => {
  const hint: ClaimTimeSourceCitationHint = {
    workItemId: 'WI-6007',
    citations: ['packages/operator-core/lib/scheduler/claim-spec-store.ts'],
    summary: "LIKELY ALREADY IMPLEMENTED — source cites this item's own id: a.ts",
  };

  it('renders nothing when there is nothing to say', () => {
    expect(sourceCitationWarning(null, 'WI-6007')).toBeNull();
    expect(sourceCitationWarning({ ...hint, citations: [] }, 'WI-6007')).toBeNull();
  });

  it('names the item and tells the claimant to READ the cited paths before building', () => {
    const warning = sourceCitationWarning(hint, 'WI-6007');

    expect(warning).toContain(hint.summary);
    expect(warning).toContain('WI-6007');
    expect(warning).toMatch(/read the cited path/i);
  });

  it('states it is ADVISORY — the clause that keeps a reference from reading as an implementation', () => {
    const warning = sourceCitationWarning(hint, 'WI-6007') ?? '';

    // Without this, an agent told only "already implemented" would be wrong in the
    // other direction: a citation can be a reference to related work. The leg never
    // blocks or reorders a claim, and the text has to say so.
    expect(warning).toMatch(/advisory/i);
    expect(warning).toMatch(/never blocks or reorders/i);
  });
});
