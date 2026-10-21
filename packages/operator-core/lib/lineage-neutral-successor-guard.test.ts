import { describe, expect, it, vi } from 'vitest';
import type { WorkItem } from './work-items';
import {
  findLineageNeutralSuccessorRefusal,
  type LineageNeutralSuccessorEligibilityDeps,
} from './lineage-neutral-successor-guard';

const PLAN = 'change-kind-declared-proof-2026-10-15';
const ITEM = 'WI-6554700010017145';
const AUTHOR = 'su-f71daefd-a45f-4562-b327-97b48cdce740';
const manifest = {
  revision: 1,
  bindingId: 55305,
  planSlug: PLAN,
  redRunIds: [21362565, 21363663],
  frozenAt: '2026-10-18T14:59:18.893Z',
};
const workItem = (state = 'open'): WorkItem => ({
  id: ITEM,
  state,
  harness: 'papercusp',
  sourcePlanSlug: PLAN,
  payload: { _frozenTests: manifest },
} as unknown as WorkItem);
const binding = {
  id: 55305,
  workItemId: ITEM,
  planSlug: PLAN,
  evidenceKind: 'manual',
  createdBy: AUTHOR,
  withdrawal: { at: '2026-10-21T08:44:36.208Z', by: 'su-683eb783-a1be-42e1-871b-8aa330ae0088' },
};

function makeDeps(overrides: Partial<LineageNeutralSuccessorEligibilityDeps> = {}) {
  const evidence = vi.fn(async () => [binding] as never);
  const deps = {
    workItem: vi.fn(async () => workItem()),
    plan: vi.fn(async () => ({ parsed: { frontmatter: { frozenTests: 'pilot' } } }) as never),
    evidence,
    ...overrides,
  } as unknown as LineageNeutralSuccessorEligibilityDeps;
  return { deps, evidence };
}

const input = {
  workspaceId: 'ws-test',
  harnessSlug: 'papercusp',
  workItemId: ITEM,
  sourceOwnerId: AUTHOR,
};

describe('lineage-neutral successor eligibility', () => {
  it('accepts the exact manifest author and audits a withdrawn binding by exact id', async () => {
    const { deps, evidence } = makeDeps();

    await expect(findLineageNeutralSuccessorRefusal(input, deps)).resolves.toBeNull();
    expect(evidence).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      harnessSlug: 'papercusp',
      planSlugs: [PLAN],
      workItemIds: [ITEM],
      bindingIds: [55305],
      includeRetracted: true,
    });
  });

  it('refuses a terminal item before reading evidence', async () => {
    const { deps, evidence } = makeDeps({ workItem: vi.fn(async () => workItem('done')) });

    await expect(findLineageNeutralSuccessorRefusal(input, deps)).resolves.toMatchObject({
      code: 'source-work-item-terminal',
    });
    expect(evidence).not.toHaveBeenCalled();
  });

  it('requires the source identity to match the immutable binding author', async () => {
    const { deps } = makeDeps();

    await expect(findLineageNeutralSuccessorRefusal({ ...input, sourceOwnerId: 'su-other' }, deps))
      .resolves.toMatchObject({ code: 'frozen-tests-author-mismatch', bindingId: 55305 });
  });

  it('requires the manifest plan to remain opted into frozen-tests', async () => {
    const { deps, evidence } = makeDeps({
      plan: vi.fn(async () => ({ parsed: { frontmatter: { frozenTests: null } } }) as never),
    });

    await expect(findLineageNeutralSuccessorRefusal(input, deps)).resolves.toMatchObject({
      code: 'frozen-tests-plan-not-opted-in',
    });
    expect(evidence).not.toHaveBeenCalled();
  });

  it('requires the exact immutable binding named by the manifest', async () => {
    const { deps } = makeDeps({ evidence: vi.fn(async () => [] as never) as never });

    await expect(findLineageNeutralSuccessorRefusal(input, deps)).resolves.toMatchObject({
      code: 'frozen-tests-binding-unavailable',
      bindingId: 55305,
    });
  });

  it('fails closed when the audit evidence read fails', async () => {
    const { deps } = makeDeps({ evidence: vi.fn(async () => { throw new Error('evidence read failed'); }) as never });

    await expect(findLineageNeutralSuccessorRefusal(input, deps)).rejects.toThrow('evidence read failed');
  });
});
