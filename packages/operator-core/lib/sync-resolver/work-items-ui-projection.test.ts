// projectWorkItemsListForUi — the `workItems.byHarness` wire projection.
//
// P-006 (precompute-sync-reads-phase2) blanked the heavy per-row `summary`;
// P-028 / D-022 (no-http-anywhere-2026-07-28) turned the projection into an
// ALLOW-LIST, which cut the measured live payload 429KB → 258KB (−40%) by
// dropping 14 fields no consumer of the query reads. Mirrors
// coord-ui-projection.test.ts.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { projectWorkItemsListForUi, WORK_ITEMS_LIST_UI_FIELDS } from './work-items-ui-projection';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** A row shaped like a real `listEnrichedWorkItems` output (post-slimListRow). */
function enrichedRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'WI-1',
    kind: 'change',
    family: 'issue',
    harness: 'papercusp',
    title: 'a title',
    summary: 'x'.repeat(5000),
    state: 'open',
    assignee: 'su-1',
    takenAt: '2026-08-02T00:00:00.000Z',
    lastProgressAt: '2026-08-02T00:00:00.000Z',
    assignedBy: 'su-2',
    severity: 'major',
    parent: null,
    payload: null,
    origin: 'local',
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
    rank: 3,
    rankWriter: 'cup',
    rankUpdatedAt: '2026-08-02T00:00:00.000Z',
    priority: 7,
    terminalOwner: null,
    terminalCompletionRef: null,
    terminalCompletionEvidence: null,
    completionAuthority: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    closedAt: null,
    planSlug: 'p',
    planItemIds: ['P-001'],
    spineRole: 'worker',
    spineStatus: 'running',
    presentation: { stage: 'candidate', reason: 'awaiting-qualifying-acceptance', evidenceRefs: ['WI-2'], completionRef: null },
    ...over,
  };
}

describe('projectWorkItemsListForUi', () => {
  it('emits exactly the allow-list plus a blanked summary', () => {
    const out = projectWorkItemsListForUi([enrichedRow()]) as Array<Record<string, unknown>>;
    expect(Object.keys(out[0]).sort()).toEqual([...WORK_ITEMS_LIST_UI_FIELDS, 'summary'].sort());
    expect(out[0].summary).toBe('');
  });

  it('keeps every field a panel renders, verbatim', () => {
    const out = projectWorkItemsListForUi([enrichedRow()]) as Array<Record<string, unknown>>;
    const row = out[0];
    expect(row.id).toBe('WI-1');
    expect(row.kind).toBe('change');
    expect(row.family).toBe('issue');
    expect(row.title).toBe('a title');
    expect(row.state).toBe('open');
    expect(row.assignee).toBe('su-1');
    expect(row.assignedBy).toBe('su-2');
    expect(row.severity).toBe('major');
    expect(row.priority).toBe(7);
    expect(row.rank).toBe(3);
    expect(row.planSlug).toBe('p');
    expect(row.spineRole).toBe('worker');
    expect(row.spineStatus).toBe('running');
    expect(row.updatedAt).toBe('2026-08-02T00:00:00.000Z');
    expect(row.origin).toBe('local');
    expect(row.presentation).toEqual({ stage: 'candidate', reason: 'awaiting-qualifying-acceptance', evidenceRefs: ['WI-2'], completionRef: null });
  });

  it('drops the fields no workItems.byHarness consumer reads', () => {
    const out = projectWorkItemsListForUi([enrichedRow()]) as Array<Record<string, unknown>>;
    // The three slimListRow already forces to null (pure key-name overhead on
    // the wire) plus the eleven nothing renders.
    for (const dropped of [
      'payload',
      'terminalCompletionRef',
      'terminalCompletionEvidence',
      'harness',
      'takenAt',
      'lastProgressAt',
      'parent',
      'rankWriter',
      'rankUpdatedAt',
      'terminalOwner',
      'completionAuthority',
      'createdAt',
      'closedAt',
      'planItemIds',
    ]) {
      expect(out[0], `${dropped} must not reach the wire`).not.toHaveProperty(dropped);
    }
  });

  it('covers every field WorkItemsPanel declares on WorkItemRow', () => {
    // The panel's exported row type IS the consumer contract (its own doc says
    // so). A field added there but not here arrives `undefined` in the grid —
    // this is the drift guard for that.
    const panel = readFileSync(join(REPO_ROOT, 'apps/operator/app/adv/harnesses/WorkItemsPanel.tsx'), 'utf8');
    const block = /export interface WorkItemRow \{([\s\S]*?)\n\}/.exec(panel);
    expect(block, 'WorkItemsPanel must still export interface WorkItemRow').toBeTruthy();
    const declared = [...(block?.[1] ?? '').matchAll(/^\s{2}([A-Za-z_$][\w$]*)\??:/gm)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(10); // the regex actually matched fields
    const wire = new Set<string>([...WORK_ITEMS_LIST_UI_FIELDS, 'summary']);
    expect(declared.filter((f) => !wire.has(f))).toEqual([]);
  });

  it('keeps reporter enrichment on the detail contract and off the grid wire', () => {
    const detail = readFileSync(join(REPO_ROOT, 'apps/operator/app/adv/harnesses/DetailPanel.tsx'), 'utf8');
    const contract = /export interface WorkItemDetailRow extends WorkItemRow \{([\s\S]*?)\n\}/.exec(detail);
    expect(contract, 'the single-item query must retain its reporter enrichment').toBeTruthy();
    expect(contract?.[1]).toMatch(/reporterStatus\??:/);
    expect(detail).toMatch(/useSyncQuery<WorkItemDetailRow>\(\{\s*queryName: 'workItems\.detail'/);
    const out = projectWorkItemsListForUi([enrichedRow({ reporterStatus: { status: 'being-fixed' } })]);
    expect(out[0]).not.toHaveProperty('reporterStatus');
  });

  it('preserves the list _meta on row[0] (the authoritative total)', () => {
    const rows = [enrichedRow({ _meta: { total: 1821 } }), enrichedRow({ id: 'WI-2' })];
    const out = projectWorkItemsListForUi(rows) as Array<Record<string, unknown>>;
    expect(out[0]._meta).toEqual({ total: 1821 });
    expect(out[0].summary).toBe('');
    expect(out[1].summary).toBe('');
    expect(out[1]._meta).toBeUndefined();
  });

  it('leaves an absent field absent rather than adding an explicit undefined', () => {
    const out = projectWorkItemsListForUi([{ id: 'WI-1' }]) as Array<Record<string, unknown>>;
    expect(Object.keys(out[0]).sort()).toEqual(['id', 'summary']);
  });

  it('slims the wire dramatically for a realistic enriched row', () => {
    const rows = [enrichedRow({ summary: 'y'.repeat(346_000) })];
    const before = JSON.stringify(rows).length;
    const after = JSON.stringify(projectWorkItemsListForUi(rows)).length;
    expect(after).toBeLessThan(before / 100); // ~346KB → a couple of hundred bytes
  });

  it('beats the old deny-list projection on a summary-free row (the P-028 win)', () => {
    // The measured win is NOT about summary — that was already blanked. It is
    // the ~14 unread keys, worth ~40% of the live payload.
    const rows = Array.from({ length: 50 }, (_, i) => enrichedRow({ id: `WI-${i}`, summary: '' }));
    const denyList = JSON.stringify(rows.map((r) => ({ ...r, summary: '' }))).length;
    const allowList = JSON.stringify(projectWorkItemsListForUi(rows)).length;
    expect(allowList).toBeLessThan(denyList * 0.75);
  });

  it('passes a non-array through defensively', () => {
    expect(projectWorkItemsListForUi(null)).toBeNull();
    expect(projectWorkItemsListForUi(undefined as unknown)).toBeUndefined();
  });
});
