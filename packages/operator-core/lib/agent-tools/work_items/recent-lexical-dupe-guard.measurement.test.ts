/**
 * R-1 / R-5 of plan duplicate-screening-keys-on-authored-prose-and-its-normalize-2026-09-05.
 *
 * Replays the MEASURED true-duplicate pair through the recent-lexical admission leg:
 * EI-22393887492211068 was filed first; WI-2145269 followed 56s later and was
 * admitted beside it. This leg reads no embeddings, so the first row has none by
 * construction — exactly the fresh-row gap D-002 names for the semantic leg.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  __classifyRecentForTest,
  findRecentLexicalDupes,
  jaccardSimilarity,
  titleTokens,
  type RecentDupeCandidateRow,
  type RecentLexicalDupeDeps,
} from './recent-lexical-dupe-guard';
import {
  FIRST_FILED_EI_22393887492211068 as FIRST,
  SECOND_FILED_WI_2145269 as SECOND,
} from '../../harness/improvements/measurement-tuples.fixture';

const firstAsRecentOpenRow: RecentDupeCandidateRow = {
  id: FIRST.id,
  title: FIRST.title,
  summary: FIRST.summary,
  state: 'open',
  harness: 'papercusp',
  hasEmbedding: true,
};

const depsWith = (rows: RecentDupeCandidateRow[]): RecentLexicalDupeDeps => ({
  queryRecentOpenItems: async () => ({ rows, truncated: false }),
});

afterEach(() => {
  delete process.env.PAPERCUSP_WI_RECENT_DUPE;
});

describe('recent-lexical leg × measurement overlap — R-1 replay of the measured pair', () => {
  it('title-only Jaccard is below the 0.5 threshold, so the old leg missed this pair', () => {
    const j = jaccardSimilarity(titleTokens(SECOND.title), titleTokens(FIRST.title));
    expect(j).toBeLessThan(0.5);
  });

  it("flags EI-22393887492211068 on WI-2145269's admission with source 'measurement-overlap'", async () => {
    const out = await findRecentLexicalDupes(
      { title: SECOND.title, summary: SECOND.summary, harness: 'papercusp' },
      depsWith([firstAsRecentOpenRow]),
    );
    expect(out?.candidates).toEqual([
      expect.objectContaining({ id: FIRST.id, source: 'measurement-overlap', state: 'open', harness: 'papercusp' }),
    ]);
    // 8 distinct shared anchors -> 8/9.
    expect(out?.candidates[0].similarity).toBe(0.89);
  });

  it('without the summary (title-only admission) the pair is NOT flagged — one shared anchor is not enough', async () => {
    const out = await findRecentLexicalDupes(
      { title: SECOND.title, harness: 'papercusp' },
      depsWith([firstAsRecentOpenRow]),
    );
    expect(out?.candidates).toEqual([]);
  });

  it('an unrelated recent row that shares only bare numbers is not flagged', async () => {
    const unrelated: RecentDupeCandidateRow = {
      id: 'EI-1',
      title: 'Disk is at 243 GiB free',
      summary: 'freed 33 GiB, floor 120 GiB',
      state: 'open',
      harness: 'papercusp',
      hasEmbedding: true,
    };
    const out = await findRecentLexicalDupes(
      { title: SECOND.title, summary: SECOND.summary },
      depsWith([unrelated]),
    );
    expect(out?.candidates).toEqual([]);
  });

  it('a Jaccard hit keeps its lexical-recent source and is not double-reported', async () => {
    const titleTwin: RecentDupeCandidateRow = { ...firstAsRecentOpenRow, id: 'EI-2', title: SECOND.title };
    const out = await findRecentLexicalDupes(
      { title: SECOND.title, summary: SECOND.summary },
      depsWith([titleTwin, firstAsRecentOpenRow]),
    );
    expect(out?.candidates.map((c) => [c.id, c.source])).toEqual([
      ['EI-2', 'lexical-recent'],
      [FIRST.id, 'measurement-overlap'],
    ]);
  });

  it('excludeId still suppresses the item itself', async () => {
    const out = await findRecentLexicalDupes(
      { title: SECOND.title, summary: SECOND.summary, excludeId: FIRST.id },
      depsWith([firstAsRecentOpenRow]),
    );
    expect(out?.candidates).toEqual([]);
  });
});

describe('recent-lexical leg × measurement overlap — R-5 fail-open', () => {
  it('a throwing overlap function drops ONLY the measurement signal; Jaccard hits survive', async () => {
    const titleTwin: RecentDupeCandidateRow = { ...firstAsRecentOpenRow, id: 'EI-2', title: SECOND.title };
    const out = await __classifyRecentForTest(
      depsWith([titleTwin, firstAsRecentOpenRow]),
      { title: SECOND.title, summary: SECOND.summary },
      () => {
        throw new Error('extractor exploded');
      },
    );
    expect(out.candidates.map((c) => [c.id, c.source])).toEqual([['EI-2', 'lexical-recent']]);
  });

  it('a >=100 KB summary returns within the leg budget', async () => {
    const huge = `${SECOND.summary}\n${'noise_token 5 GB and more words\n'.repeat(3_500)}`;
    expect(huge.length).toBeGreaterThanOrEqual(100_000);
    const t0 = performance.now();
    const out = await findRecentLexicalDupes({ title: SECOND.title, summary: huge }, depsWith([firstAsRecentOpenRow]));
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(out?.candidates[0]?.id).toBe(FIRST.id);
  });
});
