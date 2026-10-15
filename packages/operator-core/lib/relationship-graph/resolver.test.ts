/**
 * Canonical id assignment of the relationship-graph resolver (crm-agent-sales-onboarding-apps-
 * 2026-10-06 P-002, D-001): CRM objects key to canonical ids, so a merge keeps the oldest id and
 * a split leaves it with the side that kept most of its members.
 */
import { describe, expect, it } from 'vitest';
import { assignCanonicalIds, canonicalEntityId, type CanonicalCandidate, isCanonicalEntityId } from './resolver';

interface M {
  id: string;
  createdTs: number;
  stamp?: string;
}
const m = (id: string, createdTs: number, stamp?: string): M => ({ id, createdTs, stamp });
const stampOf = (member: M) => member.stamp ?? null;
const mint = (anchor: string) => `PER-minted-${anchor}`;

function canon(id: string, createdTs: number, memberRecordIds: string[], retired = false): CanonicalCandidate {
  return { id, createdTs, retired, memberRecordIds };
}

describe('assignCanonicalIds', () => {
  it('mints from the oldest member when a cluster has no canonical row', () => {
    const out = assignCanonicalIds([[m('DSR-b', 2), m('DSR-a', 5)]], [], stampOf, mint);
    expect(out).toEqual([{ id: 'PER-minted-DSR-b', members: [m('DSR-b', 2), m('DSR-a', 5)], candidateIds: [] }]);
  });

  it('a MERGE keeps the oldest canonical id and lists the younger one as absorbed', () => {
    const clusters = [[m('DSR-1', 1, 'PER-young'), m('DSR-2', 1, 'PER-old')]];
    const out = assignCanonicalIds(clusters, [canon('PER-young', 20, ['DSR-1']), canon('PER-old', 10, ['DSR-2'])], stampOf, mint);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('PER-old');
    expect(out[0]!.candidateIds).toEqual(['PER-old', 'PER-young']);
  });

  it('a SPLIT leaves the id with the side that kept most former members; the other side mints', () => {
    const big = [m('DSR-x', 3, 'PER-c'), m('DSR-y', 4, 'PER-c')];
    const small = [m('DSR-a', 1, 'PER-c')];
    const out = assignCanonicalIds([small, big], [canon('PER-c', 5, ['DSR-a', 'DSR-x', 'DSR-y'])], stampOf, mint);
    expect(out.find((a) => a.members.includes(big[0]!))!.id).toBe('PER-c');
    expect(out.find((a) => a.members.includes(small[0]!))!.id).toBe('PER-minted-DSR-a');
  });

  it('a SPLIT tie goes to the cluster with the oldest member', () => {
    const younger = [m('DSR-a', 9, 'PER-c')];
    const older = [m('DSR-z', 1, 'PER-c')];
    const out = assignCanonicalIds([younger, older], [canon('PER-c', 5, ['DSR-a', 'DSR-z'])], stampOf, mint);
    expect(out.find((a) => a.members.includes(older[0]!))!.id).toBe('PER-c');
  });

  it('prefers a live canonical row over a retired one, and revives a retired one only when needed', () => {
    const cluster = [m('DSR-1', 1, 'PER-retired'), m('DSR-2', 1, 'PER-live')];
    const live = canon('PER-live', 50, ['DSR-2']);
    const retired = canon('PER-retired', 1, ['DSR-1'], true);
    expect(assignCanonicalIds([cluster], [retired, live], stampOf, mint)[0]!.id).toBe('PER-live');
    expect(assignCanonicalIds([[m('DSR-1', 1, 'PER-retired')]], [retired], stampOf, mint)[0]!.id).toBe('PER-retired');
  });

  it('is independent of cluster and candidate input order', () => {
    const c1 = [m('DSR-1', 1, 'PER-a'), m('DSR-2', 2, 'PER-b')];
    const c2 = [m('DSR-3', 3, 'PER-b')];
    const cs = [canon('PER-a', 10, ['DSR-1']), canon('PER-b', 20, ['DSR-2', 'DSR-3'])];
    const ids = (out: ReturnType<typeof assignCanonicalIds<M>>) => out.map((a) => [a.members.map((x) => x.id).join(','), a.id]).sort();
    expect(ids(assignCanonicalIds([c2, c1], [...cs].reverse(), stampOf, mint))).toEqual(ids(assignCanonicalIds([c1, c2], cs, stampOf, mint)));
  });
});

describe('canonicalEntityId', () => {
  it('is deterministic per (workspace, datatype, anchor) and carries the datatype prefix', () => {
    const a = canonicalEntityId('ws', 'person', 'DSR-1');
    expect(a).toBe(canonicalEntityId('ws', 'person', 'DSR-1'));
    expect(a).not.toBe(canonicalEntityId('ws2', 'person', 'DSR-1'));
    expect(a).toMatch(/^PER-[0-9a-f]{24}$/);
    expect(canonicalEntityId('ws', 'organization', 'DSR-1')).toMatch(/^ORG-/);
    expect(isCanonicalEntityId('person', a)).toBe(true);
    expect(isCanonicalEntityId('person', 'DSR-1')).toBe(false);
  });
});
