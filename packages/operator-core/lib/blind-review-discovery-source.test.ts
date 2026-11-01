import { describe, expect, it } from 'vitest';
import { discoverySourceHash, loadBlindReviewDiscoveries, type DiscoveryOccurrence } from './blind-review-discovery-source';
import { briefTurnCount, buildBlindReviewBrief } from './blind-review-brief';
import { loadBlindReviewBrief } from './blind-review-gate';
import { buildBlindReviewerKickoff } from './blind-reviewer-mint';

const occurrence: DiscoveryOccurrence = {
  occurrence_id: '17', canonical_work_item_id: 'EI-123', reporter: 'su-discoverer',
  source_tool: 'improvements:capture', report_kind: 'canonical-created',
  reported_title: 'Retain the source receipt after cleanup',
  body: 'A fresh consumer cannot retrieve the complete source receipt after the source session retires. Preserve it in durable private storage.',
  occurred_at: '2026-10-25T10:00:00.000Z',
};
const pin = () => ({ ref: 'issue-occurrence:17', sha256: discoverySourceHash(occurrence) });
const declaration = () => ({ itemId: 'P-001', kind: 'agent-added' as const,
  reason: 'PLAN-FRAMING-MUST-NOT-LEAK', discoverySources: [pin()] });

function sqlFor(row: DiscoveryOccurrence | null) {
  return (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join('?');
    expect(query).toContain('workspace_id =');
    expect(query).toContain('canonical_harness_slug =');
    expect(values).toContain('ws');
    expect(values).toContain('papercusp');
    return row ? [row] : [];
  }) as unknown as Parameters<typeof loadBlindReviewDiscoveries>[1];
}
const load = (row: DiscoveryOccurrence | null = occurrence, overrides = {}) => loadBlindReviewDiscoveries({
  workspaceId: 'ws', harnessSlug: 'papercusp', planCreatedAt: '2026-10-25T11:00:00.000Z',
  declarations: [declaration()], ...overrides,
}, sqlFor(row));

describe('original agent discovery blind source', () => {
  it('briefs a zero-owner plan from an immutable pre-plan capture without relabeling it owner speech', async () => {
    const discoveries = await load();
    const brief = buildBlindReviewBrief({ planSlug: 'repair', activation: { auditSeq: 8, mappings: [] },
      turns: new Map(), discoveries });
    expect(briefTurnCount(brief)).toBe(1);
    expect(brief.ownerTurns).toEqual([]);
    expect(brief.unverifiedTurns).toEqual([]);
    expect(brief.agentDiscoveries).toHaveLength(1);
    expect(brief.text).toContain(occurrence.body);
    expect(brief.text).toContain('agent discovery');
    expect(brief.text).toContain('su-discoverer');
    expect(brief.text).toContain(pin().sha256);
    expect(brief.text).not.toContain('PLAN-FRAMING-MUST-NOT-LEAK');
    expect(brief.text).not.toContain('the owner\'s own words that asked for this work');
    const kickoff = buildBlindReviewerKickoff(brief);
    expect(kickoff).toContain('## Original sources');
    expect(kickoff).not.toContain('## The owner\'s words');
    expect(kickoff).not.toContain('Below are the owner\'s own words');
  });

  it.each([
    ['missing or cross-scope capture', null],
    ['changed body', { ...occurrence, body: 'PLAN-TEXT-INJECTED-LATER' }],
    ['changed reporter', { ...occurrence, reporter: 'su-other' }],
    ['later capture', { ...occurrence, occurred_at: '2026-10-25T12:00:00.000Z' }],
    ['non-original occurrence', { ...occurrence, report_kind: 'coalesced' }],
    ['non-capture source', { ...occurrence, source_tool: 'work_items:update' }],
    ['missing attribution', { ...occurrence, reporter: '' }],
    ['empty source', { ...occurrence, body: '' }],
  ])('refuses %s', async (_name, row) => {
    await expect(load(row as DiscoveryOccurrence | null)).rejects.toThrow('blind_discovery_source_invalid');
  });

  it('requires a measured plan creation time and source pin; does not truncate a source', async () => {
    await expect(load(occurrence, { planCreatedAt: null })).rejects.toThrow('blind_discovery_source_invalid');
    const oversized = { ...occurrence, body: 'x'.repeat(20_001) };
    await expect(load(oversized, { declarations: [{ ...declaration(), discoverySources: [
      { ref: 'issue-occurrence:17', sha256: discoverySourceHash(oversized) },
    ] }] })).rejects.toThrow('blind_discovery_source_invalid');
  });

  it('reads no discovery for owner-backed or merely derived declarations', async () => {
    expect(await load(null, { declarations: [{ itemId: 'P-001', kind: 'derived', from: ['P-002'] }] })).toEqual([]);
    expect(await load(null, { declarations: [] })).toEqual([]);
  });

  it('deduplicates equal pins and refuses conflicting pins for one source', async () => {
    expect(await load(occurrence, { declarations: [declaration(), { ...declaration(), itemId: 'P-002' }] })).toHaveLength(1);
    await expect(load(occurrence, { declarations: [declaration(), { ...declaration(), itemId: 'P-002',
      discoverySources: [{ ...pin(), sha256: 'a'.repeat(64) }] }] })).rejects.toThrow('blind_discovery_source_invalid');
  });

  it('loads explicit source pins through the real brief loader and excludes audit framing', async () => {
    const sql = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = parts.join('?');
      if (query.includes('harness_plans')) return [{ harness_slug: 'papercusp',
        created_at: '2026-10-25T11:00:00Z', owner: 'su-author', content: 'PLAN-BODY-MUST-NOT-LEAK' }];
      if (query.includes('plan_audits')) return [{ audit_seq: 8,
        activation: { mappings: [], itemProvenance: [declaration()] } }];
      if (query.includes('plan_blind_reviews')) return [];
      if (query.includes('work_item_occurrences')) return sqlFor(occurrence)(parts, ...values);
      throw new Error(`unexpected query ${query}`);
    }) as unknown as Parameters<typeof loadBlindReviewDiscoveries>[1];
    const brief = await loadBlindReviewBrief({ workspaceId: 'ws', planSlug: 'repair', harnessSlug: 'papercusp' }, { sql });
    expect(brief?.agentDiscoveries?.[0].sha256).toBe(pin().sha256);
    expect(brief?.text).not.toContain('PLAN-BODY-MUST-NOT-LEAK');
    expect(brief?.text).not.toContain('PLAN-FRAMING-MUST-NOT-LEAK');
  });
});
