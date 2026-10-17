import { describe, expect, it, vi } from 'vitest';
import { renderCarryNote } from '../../carry-note';
import { shapeWorkItemsGet } from './get-shape';
import { buildWorkItemResume, readWorkItemResume, RESUME_PACKET_BUDGET } from './resume';
import type { TaskBrief } from '../../code-intelligence/task-brief';

const item = { id: 'WI-resume', harness: 'h1', assignee: 'su-current', state: 'open',
  payload: { plan_item: { plan_slug: 'resume-plan', item_id: 'P-001' } } };
const next = 'Bind test-run:17717253 to the current clause, then request independent acceptance.';
const checkpoint = { checkpoint: renderCarryNote({ did: 'Historical detail. '.repeat(900), next }), updatedAtMs: 1234 };
const build = (overrides: Partial<Parameters<typeof buildWorkItemResume>[0]> = {}) => buildWorkItemResume({
  item, checkpoint, freshness: { verdict: 'fresh' }, evidence: [], ...overrides,
});

describe('bounded work-item resume', () => {
  it('preserves the complete next action beyond a long historical prefix through the real payload shaper', () => {
    const legacy = shapeWorkItemsGet({ ok: true, results: [{ ok: true, id: item.id, workItem: item,
      checkpoint: checkpoint.checkpoint }], counts: { ok: 1, failed: 0 } }, 'trimmed');
    // Counterexample: the ordinary historical read cannot deliver this tail intact.
    expect(JSON.stringify(legacy)).not.toContain(next);
    const packet = build();
    for (const tier of ['standard', 'trimmed'] as const) {
      const result = shapeWorkItemsGet({ ok: true, __resumeOnly: true,
        results: [{ ok: true, id: item.id, resume: packet }], counts: { ok: 1, failed: 0 } }, tier) as any;
      expect(result.results[0].resume.nextAction).toEqual({ status: 'available', text: next });
      expect(result.results[0].resume.claim.assignee).toBe('su-current');
      expect(result).not.toHaveProperty('__resumeOnly');
      expect(JSON.stringify(result).length).toBeLessThan(6_000);
    }
  });

  it('keeps unavailable, absent, unstructured and oversized next actions distinct', () => {
    expect(build({ checkpoint: { checkpoint: null, updatedAtMs: null, readFailed: true } }).nextAction.status).toBe('unknown');
    expect(build({ checkpoint: { checkpoint: null, updatedAtMs: null } }).checkpoint.status).toBe('absent');
    expect(build({ checkpoint: { checkpoint: 'Historical prose only', updatedAtMs: 1 } }).nextAction.status).toBe('missing');
    expect(build({ checkpoint: { checkpoint: renderCarryNote({ next: 'Long instruction '.repeat(500) }), updatedAtMs: 1 } }).nextAction)
      .toEqual({ status: 'oversized', text: null });
  });

  it.each(['append', 'refresh'])('uses the stored latest update, independent of %s history order', order => {
    const previous = renderCarryNote({ next: 'Acquire run.ts; add recheckReason.' });
    const latest = renderCarryNote({ next: 'The wiring is complete. Review the saved acceptance evidence.' });
    const text = order === 'append' ? `${previous}\n\n---\n${latest}` : `${latest}\n\n---\n${previous}`;
    const packet = build({ checkpoint: { checkpoint: text, updatedAtMs: 1,
      latestUpdate: { status: 'available', text: latest } } as any });
    expect(packet.nextAction.text).toBe('The wiring is complete. Review the saved acceptance evidence.');
  });

  it('keeps the checkpoint next action when the latest update only records an insight', () => {
    const previousNext = 'Resume the review after the independent reproduction receipt arrives.';
    const previous = renderCarryNote({ next: previousNext });
    const latest = renderCarryNote({ insight: 'Recorded an evidence attestation for the prior review.' });
    const text = `${previous}\n\n---\n${latest}`;
    const packet = build({ checkpoint: { checkpoint: text, updatedAtMs: 1,
      latestUpdate: { status: 'available', text: latest } } as any });
    expect(packet.nextAction).toEqual({ status: 'available', text: previousNext, source: 'checkpoint' });
  });

  it('does not promote latest-update prose to an action when neither update has a next field', () => {
    const latest = renderCarryNote({ insight: 'The evidence is still inconclusive.' });
    const packet = build({ checkpoint: { checkpoint: latest, updatedAtMs: 1,
      latestUpdate: { status: 'available', text: latest } } as any });
    expect(packet.nextAction).toEqual({ status: 'missing', text: null });
  });

  it('does not guess which unmarked historical segment is current', () => {
    const packet = build({ checkpoint: { checkpoint: `${renderCarryNote({ next: 'Old action' })}\n\n---\nNew progress`, updatedAtMs: 1 } });
    expect(packet.nextAction).toMatchObject({ status: 'unknown', text: null });
  });

  it('keeps a complete action larger than 2000 characters when the packet budget permits it', () => {
    const instruction = 'Review each saved assertion carefully. '.repeat(70);
    const packet = build({ checkpoint: { checkpoint: renderCarryNote({ next: instruction }), updatedAtMs: 1 } });
    expect(packet.nextAction).toMatchObject({ status: 'available', text: instruction.trim() });
    expect(JSON.stringify(packet).length).toBeLessThanOrEqual(RESUME_PACKET_BUDGET);
  });

  it('fits source evidence around a complete next action without losing attribution or mutating the claim brief', () => {
    const instruction = 'Review each saved assertion carefully. '.repeat(65).trim();
    const brief: TaskBrief = { status: 'current', scope: { harness: 'h1', paths: ['target.ts'] },
      repository: { workspaceId: 'w1', rootPath: '/registered/repo' }, sourceFingerprint: 'measured-current-source',
      commit: 'accepted', files: [{ path: 'target.ts', sha256: 'current-hash', kind: 'implementation' }],
      excerpts: Array.from({ length: 5 }, () => ({ path: 'target.ts', text: 'literal source '.repeat(24) })),
      graph: { status: 'measured', consumers: ['consumer.ts:2'], relationships: ['target → consumer'] },
      exclusions: [], recover: { tool: 'code:pack', args: { op: 'pack', include: ['target.ts'], rootPath: '/registered/repo' } } };
    const original = structuredClone(brief);
    const packet = build({ checkpoint: { checkpoint: renderCarryNote({ next: instruction }), updatedAtMs: 1 }, taskBrief: brief });
    expect(packet.nextAction.text).toBe(instruction);
    expect(packet.taskBrief).toMatchObject({ status: 'current', repository: brief.repository,
      scope: brief.scope, sourceFingerprint: brief.sourceFingerprint, files: brief.files, recover: brief.recover });
    expect((packet.taskBrief as TaskBrief).excerpts.length).toBeLessThan(brief.excerpts.length);
    expect((packet.taskBrief as TaskBrief).exclusions).toContain('Additional inline evidence omitted; use the scoped recovery readers.');
    expect(JSON.stringify(packet).length).toBeLessThanOrEqual(RESUME_PACKET_BUDGET);
    expect(brief).toEqual(original);
  });

  it('budgets whole proof and check rows while preserving outcome, currentness and omitted counts', () => {
    const proofs = Array.from({ length: 9 }, (_, id) => ({ id, specId: 'S-1', specRevision: 2,
      evidenceKind: 'test', evidenceRef: 'test-run:' + id, testRunId: id + 1, coverageEvidenceRef: null,
      details: { adequacy: { outcome: id === 0 ? 'fail' : 'pass', causalPairIds: ['original-failure'] } },
      currentness: { overall: id === 0 ? 'stale' : 'current' } })) as never;
    const result = build({ evidence: proofs, checkpoint: { ...checkpoint, checkpoint: renderCarryNote({
      next, checks: Array.from({ length: 12 }, (_, id) => ({ id: String(id), claim: 'Large claim '.repeat(100),
        verified: 'test-run:' + id })), walls: [{ claim: 'Preserve independent approval.' }],
    }) } });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(RESUME_PACKET_BUDGET);
    expect(result.evidence.rows[0]).toMatchObject({ testRunId: 1, outcome: 'fail', currentness: 'stale' });
    expect(result.evidence.hasMore).toBe(true);
    expect(result.evidence.rows.length + result.evidence.omittedFromWindow!).toBe(9);
    expect(result.checks.rows.length + result.checks.omitted).toBe(12);
    expect(result.checkpoint.readRef.args).toEqual({ id: item.id, harness: 'h1', resume: true });
    expect(result.nextAction.text).toBe(next);
  });

  it('reads the canonical item scope once and exposes evidence-store failures as unknown', async () => {
    const deps = { checkpoint: vi.fn().mockResolvedValue(checkpoint), freshness: vi.fn().mockResolvedValue(undefined),
      evidence: vi.fn().mockRejectedValue(new Error('database unavailable')) };
    const result = await readWorkItemResume(item, deps);
    expect(deps.checkpoint).toHaveBeenCalledExactlyOnceWith({ harness: 'h1', workItemId: item.id });
    expect(deps.evidence).toHaveBeenCalledExactlyOnceWith({ harnessSlug: 'h1', planSlugs: ['resume-plan'],
      workItemIds: [item.id], limit: 9 });
    expect(result.evidence).toMatchObject({ status: 'unknown', hasMore: null, omittedFromWindow: null });
    expect(result.checkpoint.freshness).toMatchObject({ verdict: 'unknown' });
    expect(result.nextAction.text).toBe(next);
  });
});
