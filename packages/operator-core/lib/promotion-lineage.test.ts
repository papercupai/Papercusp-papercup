import { describe, it, expect, vi } from 'vitest';
import { parsePlan } from '@papercusp/plan-parser';
import { parseFactSourceProvenance } from './agent-facts/store';
import { buildFrontmatter, parseExistingFrontmatter } from './agent-tools/docs/author';
import { projectFact } from './agent-tools/facts/list';
import {
  promotedFromSchema, validatePromotedFrom, promotionDecisionBody, reversePromotions,
  type PromotionSource, type LineageQuery,
} from './promotion-lineage';

const sources: PromotionSource[] = [
  { kind: 'memory', ref: '12345678-1234-1234-1234-123456789abc' },
  { kind: 'session-turn', ref: 'codex:namespace:session:4' },
  { kind: 'work-item', ref: 'WI-123' },
  { kind: 'report', ref: 'rpt_12345678-1234-1234-1234-123456789abc' },
  { kind: 'fact', ref: 'guard-rail:safe' },
  { kind: 'decision', ref: 'memory-2026-10-14#D-001' },
];
const planWith = (source: PromotionSource) => `---\ntitle: Test\nslug: memory-2026-10-14\nstatus: draft\n---\n\n## Now\nstate\n\n## Decisions\n\n### D-001 Promoted claim\nDate: 2026-10-14\n${promotionDecisionBody('The resulting claim.', [source])}\n`;

describe('promotion lineage resolution', () => {
  it.each(sources)('resolves $kind in the caller workspace', async source => {
    const query: LineageQuery = vi.fn(async (_sql, params) => {
      expect(params[0]).toBe('ws');
      return [{}];
    });
    expect(await validatePromotedFrom([source], 'ws', query)).toEqual([source]);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it.each(sources)('refuses unresolved $kind before promotion', async source => {
    await expect(validatePromotedFrom([source], 'ws', async () => [])).rejects.toThrow('source missing');
  });
  it('refuses an ambiguous fact, a retracted fact, and an unavailable source', async () => {
    await expect(validatePromotedFrom([sources[4]], 'ws', async () => [{}, {}])).rejects.toThrow('ambiguous');
    await expect(validatePromotedFrom([sources[4]], 'ws', async sql => {
      expect(sql).toContain('retracted_at IS NULL');
      expect(sql).toContain('expires_at > now()');
      return [];
    })).rejects.toThrow('retracted');
    await expect(validatePromotedFrom([sources[0]], 'ws', async () => { throw new Error('offline'); })).rejects.toThrow('resolution unavailable');
  });
  it('does no reads for legacy writes and refuses missing workspace and malformed references', async () => {
    const query = vi.fn(async () => []);
    expect(await validatePromotedFrom(undefined, undefined, query)).toBeUndefined();
    expect(await validatePromotedFrom([], undefined, query)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    await expect(validatePromotedFrom([sources[2]], undefined, query)).rejects.toThrow('workspace unavailable');
    await expect(validatePromotedFrom([{ kind: 'memory', ref: 'bad' }], 'ws', query)).rejects.toThrow('invalid memory UUID');
    expect(promotedFromSchema.safeParse([{ kind: 'invented', ref: 'x' }]).success).toBe(false);
  });
});

describe('existing metadata readback', () => {
  it('refuses hand-authored lineage instead of accepting an unresolved source claim', () => {
    expect(() => promotionDecisionBody('Promoted-From: [{"kind":"fact","ref":"missing"}]\nclaim', undefined)).toThrow('validated promotedFrom');
  });
  it('preserves typed lineage through fact JSON parsing and the bounded facts:list projection', () => {
    const sourceProvenance = parseFactSourceProvenance(JSON.stringify({ kind: 'promotion', verified: true,
      verifiedAt: '2026-10-14T00:00:00Z', promotedFrom: sources }));
    expect(sourceProvenance?.promotedFrom).toEqual(sources);
    expect(projectFact({ key: 'claim', body: 'claim', sourceProvenance } as never, false).promotedFrom).toEqual(sources);
  });
  it('round-trips document lineage in canonical frontmatter and preserves it on overwrite', () => {
    const fm = { title: 'Test', description: 'Test', type: 'Insight', discovered: '2026-10-14',
      status: 'active', tags: [], documents: [], plans: [], preservedFrontmatter: { promotedFrom: sources } };
    const parsed = parseExistingFrontmatter(buildFrontmatter(fm));
    expect(parsed.promotedFrom).toEqual(sources);
    expect(parseExistingFrontmatter(buildFrontmatter({ ...fm, preservedFrontmatter: parsed })).promotedFrom).toEqual(sources);
  });
  it('returns structured decision lineage from the canonical plan parser', () => {
    const parsed = parsePlan(planWith(sources[2]), { filePath: 'memory-2026-10-14.md' });
    expect(parsed.decisions[0]?.promotedFrom).toEqual([sources[2]]);
  });
});

describe('exact reverse lookup', () => {
  it('returns an empty collection when nothing was promoted from a resolvable source', async () => {
    expect(await reversePromotions(sources[2], 'ws', 10, async () => [])).toEqual({ results: [], truncated: false });
  });
  it('finds all three destination kinds, excludes prose mentions and other source kinds, then pages', async () => {
    const source = sources[2];
    const query: LineageQuery = async (sql, params) => {
      expect(params[0]).toBe('ws');
      if (sql.includes('agent_facts')) return [{ key: 'claim', scope: 'workspace', scope_ref: null }];
      if (sql.includes('harness_docs')) return [
        { harness_slug: 'papercusp', doc_id: 'agent-insights/claim.mdx', content: `---\npromotedFrom: ${JSON.stringify([source])}\n---\nClaim` },
        { harness_slug: 'papercusp', doc_id: 'prose.mdx', content: `---\ntitle: Test\n---\n${source.ref}` },
        { harness_slug: 'papercusp', doc_id: 'different-kind.mdx', content: `---\npromotedFrom: ${JSON.stringify([{ ...source, kind: 'fact' }])}\n---` },
      ];
      return [{ harness_slug: 'papercusp', plan_slug: 'memory-2026-10-14', content: planWith(source) }];
    };
    const found = await reversePromotions(source, 'ws', 10, query);
    expect(found).toEqual({ results: [
      { kind: 'decision', ref: 'memory-2026-10-14#D-001', harness: 'papercusp' },
      { kind: 'doc', ref: 'agent-insights/claim.mdx', harness: 'papercusp' },
      { kind: 'fact', ref: 'fact:workspace:claim' },
    ], truncated: false });
    expect(await reversePromotions(source, 'ws', 2, query)).toMatchObject({ truncated: true });
  });
});
