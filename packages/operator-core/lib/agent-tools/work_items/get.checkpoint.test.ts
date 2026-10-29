/**
 * work_items:get — checkpoint surfacing (EI-7252) + checkpoint recency (EI-8885).
 *
 * A work-item's in-flight CHECKPOINT (work_items:checkpoint → carry-note scope
 * `workitem:<harness>:<id>`) was previously invisible to work_items:get — an
 * investigator (or a compacted successor) reading the item had no way to know a
 * checkpoint existed and could wrongly conclude state was lost. Pins: the field
 * is always present (null when none was ever written), it reflects the resolved
 * work-item's OWN harness (not the request arg), a lookup failure degrades to
 * null rather than failing the whole read, and a harness-NULL item still reads its
 * checkpoint (EI-8805 — the store canonicalizes the null harness to the wildcard
 * namespace it was written under, instead of skipping the lookup and losing it).
 *
 * EI-8885: a checkpoint with no age signal reads as CURRENT even when it's several
 * wakes stale — checkpointAgeMs/checkpointUpdatedAtMs surface the write recency
 * alongside the content so a reader can downgrade trust on an old checkpoint
 * instead of discovering staleness only after acting on it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { ThreadPostRow } from '@papercusp/coordination/capabilities';

const getWorkItem = vi.fn();
const readReportAttachmentEvidence = vi.fn();
vi.mock('../../harness/improvements/report-attachments', () => ({
  readReportAttachmentEvidence: (...args: unknown[]) => readReportAttachmentEvidence(...args),
}));
const getWorkItemDetail = vi.fn();
const getWorkItemThreadWindow = vi.fn();
vi.mock('../../work-items', () => ({
  getWorkItem: (...a: unknown[]) => getWorkItem(...a),
  getWorkItemDetail: (...a: unknown[]) => getWorkItemDetail(...a),
  getWorkItemThreadWindow: (...a: unknown[]) => getWorkItemThreadWindow(...a),
  SETTLED_WORK_ITEM_STATES: ['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped'],
}));

const getWorkItemCheckpointWithMeta = vi.fn();
// P-007: `getWorkItemCheckpointFreshness` returns undefined by default = the
// checkpoint declared no dependencies, so these suites keep exercising the TIME
// heuristics (the documented fallback). The override case gets its own suite below.
const getWorkItemCheckpointFreshness = vi.fn();
const resolvePriorAttemptRefs = vi.fn();
const getClaimTimePriorAttemptBrief = vi.fn();
vi.mock('../../prior-attempt-context', () => ({
  resolvePriorAttemptRefs: (...a: unknown[]) => resolvePriorAttemptRefs(...a),
  getClaimTimePriorAttemptBrief: (...a: unknown[]) => getClaimTimePriorAttemptBrief(...a),
}));
const resumeEvidence = vi.fn();
vi.mock('../plans/spec-evidence-store', async (original) => ({
  ...(await original<typeof import('../plans/spec-evidence-store')>()),
  listSpecEvidence: (...args: unknown[]) => resumeEvidence(...args),
}));
vi.mock('../../work-item-checkpoint', () => ({
  getWorkItemCheckpointWithMeta: (...a: unknown[]) => getWorkItemCheckpointWithMeta(...a),
  getWorkItemCheckpointFreshness: (...a: unknown[]) => getWorkItemCheckpointFreshness(...a),
}));

// EI-15184: stub only getPresence (spread the real module so its other exports —
// PRESENCE_STALE_MS, writePresence, … some transitive importer may need — stay live).
const getPresence = vi.fn();
vi.mock('../coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordination/presence')>()),
  getPresence: (...a: unknown[]) => getPresence(...a),
}));

const getClaimTimePriorWorkHint = vi.fn();
vi.mock('../../work-item-prior-work', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../work-item-prior-work')>()),
  getClaimTimePriorWorkHint: (...a: unknown[]) => getClaimTimePriorWorkHint(...a),
}));

const completionFreshnessForEvidence = vi.fn();
vi.mock('./completion-freshness', () => ({
  completionFreshnessForEvidence: (...a: unknown[]) => completionFreshnessForEvidence(...a),
}));

const deploymentPositionForEvidence = vi.fn();
vi.mock('./deployment-position', () => ({
  deploymentPositionForEvidence: (...a: unknown[]) => deploymentPositionForEvidence(...a),
}));

// P-012 (D-049): the corroboration block's reader. Default: nothing corroborates the item.
const readCorroborationSummary = vi.fn(async (..._a: unknown[]): Promise<unknown> => null);
vi.mock('../../harness/improvements/corroboration', () => ({
  readCorroborationSummary: (...a: unknown[]) => readCorroborationSummary(...a),
}));

import get, { workItemsGetSourceReadOptions } from './get';
import { shapeWorkItemsGet } from './get-shape';
import {
  CARRY_NOTE_MAX_CHECKS,
  withCarryNoteChecks,
  shortCarryHash,
  computeWorkItemSubjectFingerprint,
} from '../../carry-note';

const ctxFields = { uiClientId: 'su-tester', workspaceId: 'default' };
const ctx = ctxFields as never;
const parse = (x: unknown) => (get.args as { parse: (x: unknown) => unknown }).parse(x);
type Out = { data: any };

it('attachment read returns bounded evidence without checkpoint enrichment and refuses mixed/bulk modes', async () => {
  getWorkItem.mockResolvedValue({ id: 'WI-attachment', harness: 'papercusp' });
  const evidence = { sourceWorkItemId: 'EI-source', attachments: [], page: null };
  readReportAttachmentEvidence.mockResolvedValue(evidence);
  const result = (await env({ id: 'WI-attachment', attachments: {} })).results[0];
  expect(result).toMatchObject({ ok: true, id: 'WI-attachment', reportAttachments: evidence });
  expect(readReportAttachmentEvidence).toHaveBeenCalledWith(expect.any(String), 'WI-attachment', {}, { harness: 'papercusp' });
  expect(getWorkItemCheckpointWithMeta).not.toHaveBeenCalled();
  expect(() => parse({ ids: ['WI-a', 'WI-b'], attachments: {} })).toThrow();
  expect(() => parse({ id: 'WI-a', attachments: {}, resume: true })).toThrow();
  expect(() => parse({ id: 'WI-a', attachments: { limit: 2049 } })).toThrow();
});

it('documents checkpointUpdatedAtMs as the checkpoint-change marker, not workItem.updatedAt', () => {
  const returns = (get as unknown as { guidance?: { returns?: string } }).guidance?.returns ?? '';
  expect(returns).toContain('\`checkpointUpdatedAtMs\` is the CANONICAL checkpoint-change marker');
  expect(returns).toContain('do not infer checkpoint authorship from \`workItem.updatedAt\`');
});

it('documents the projected work-item prose path and rejects body aliases', () => {
  const returns = (get as unknown as { guidance?: { returns?: string } }).guidance?.returns ?? '';
  expect(returns).toContain('`results[].workItem.summary`');
  expect(returns).toContain('`results[].workItem.body` and `results[].workItem.description` are not response fields');
  expect(returns).not.toContain('read `results[].workItem.body`');
});
// P-002 (WI-2145856) rewrote this contract rather than removing its guard. The
// cap used to REJECT: `threadLimit:11` threw, which is what this test pinned. It
// is now CLAMPED, because 50 filings of that rejection were pure round-trips that
// retried with 10 and succeeded, and the window's same-snapshot `total` means a
// shortened window cannot be misread as the whole thread. The assertions below
// pin the REPLACEMENT contract at the same strength: the value is accepted, the
// underlying reader is still never asked for more than the cap, and the clamp is
// disclosed rather than silent.
it('documents the threadLimit window and still accepts the in-range values', () => {
  const when = String((get as unknown as { guidance?: { when?: string } }).guidance?.when ?? '');
  expect(when).toContain('`threadLimit`');
  expect(when).toContain('(0–10');
  expect(() => parse({ id: 'WI-thread-limit', threadLimit: 10 })).not.toThrow();
  expect(() => parse({ id: 'WI-thread-limit', threadLimit: 0 })).not.toThrow();
  expect(() => parse({ id: 'WI-thread-limit', threadLimit: -1 })).toThrow();
});

it('clamps an over-cap threadLimit instead of rejecting it, and says so', async () => {
  getWorkItem.mockResolvedValue({ id: 'WI-clamp', title: 't' });
  getWorkItemThreadWindow.mockResolvedValue({ total: 37, posts: [{ body: 'c' }], topics: [] });
  const r = (await env({ id: 'WI-clamp', threadLimit: 25 })).results[0];
  // The reader is asked for the CAP, never the caller's larger number — the
  // clamp must happen before the query, not by trimming a bigger result.
  expect(getWorkItemThreadWindow).toHaveBeenCalledWith('WI-clamp', 10, undefined);
  expect(r).toMatchObject({ ok: true, threadLimitClamped: { requested: 25, applied: 10 } });
  // `total` is the other half of why clamping is safe: it reports the real size
  // of the thread, so 1 shown post out of 37 is legible as a window.
  expect(r.threadWindow.total).toBe(37);
});

it('omits the clamp marker when the request was within the cap', async () => {
  getWorkItem.mockResolvedValue({ id: 'WI-noclamp', title: 't' });
  getWorkItemThreadWindow.mockResolvedValue({ total: 2, posts: [], topics: [] });
  const r = (await env({ id: 'WI-noclamp', threadLimit: 5 })).results[0];
  expect(getWorkItemThreadWindow).toHaveBeenCalledWith('WI-noclamp', 5, undefined);
  // Absence must mean "you got what you asked for" — if the marker were always
  // present its presence would carry no information.
  expect(r).not.toHaveProperty('threadLimitClamped');
});

it('EI-21885040199084336: accepts detail as the boolean-or-string-enum convention other :get tools use', () => {
  expect((parse({ id: 'WI-detail', detail: 'full' }) as { detail?: boolean }).detail).toBe(true);
  expect((parse({ id: 'WI-detail', detail: 'summary' }) as { detail?: boolean }).detail).toBe(false);
  expect((parse({ id: 'WI-detail', detail: true }) as { detail?: boolean }).detail).toBe(true);
  expect((parse({ id: 'WI-detail', detail: false }) as { detail?: boolean }).detail).toBe(false);
  expect((parse({ id: 'WI-detail' }) as { detail?: boolean }).detail).toBeUndefined();
  expect(() => parse({ id: 'WI-detail', detail: 'verbose' })).toThrow();
});

it('accepts checksOnly as the narrow checkpoint-ledger read switch', () => {
  expect((parse({ id: 'WI-checks-only-schema', checksOnly: true }) as { checksOnly?: boolean }).checksOnly).toBe(true);
  expect((parse({ id: 'WI-checks-only-schema', checksOnly: false }) as { checksOnly?: boolean }).checksOnly).toBe(false);
});

it('checkpointOnly pages exact stored checkpoint text by Unicode code point and clamps the page size', async () => {
  const stored = 'A😀BCDEF';
  getWorkItem.mockResolvedValue({ id: 'WI-checkpoint-page', harness: 'canonical' });
  getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: stored, updatedAtMs: 123 });

  expect(() => parse({ id: 'WI-checkpoint-page', offset: 1 })).toThrow(/only valid with checkpointOnly/);
  expect(() => parse({ id: 'WI-checkpoint-page', checkpointOnly: true, limit: 0 })).toThrow();
  expect(() => parse({ id: 'WI-checkpoint-page', checkpointOnly: true, detail: true })).toThrow(/standalone/);
  const outputSchema = z.toJSONSchema(get.result as never) as any;
  expect(outputSchema.properties.results.items.properties.checkpointPage.anyOf[0]).toMatchObject({
    type: 'object',
    properties: expect.objectContaining({
      offset: expect.objectContaining({ type: 'integer' }),
      totalChars: expect.objectContaining({ type: 'integer' }),
      nextOffset: expect.objectContaining({ anyOf: expect.any(Array) }),
      text: expect.objectContaining({ type: 'string' }),
    }),
  });
  expect(outputSchema.properties.results.items.properties.checkpointSource.enum).toEqual([
    'live-checkpoint', 'terminal-completion-snapshot', 'prior-attempt-ref', 'none',
  ]);

  const first = await one({ id: 'WI-checkpoint-page', harness: 'requested', checkpointOnly: true, offset: 1, limit: 2 });
  expect(first).toMatchObject({
    id: 'WI-checkpoint-page',
    __checkpointOnly: true,
    checkpointPage: {
      offset: 1,
      limit: 2,
      totalChars: 7,
      returnedChars: 2,
      nextOffset: 3,
      text: '😀B',
    },
    checkpointUpdatedAtMs: 123,
    checkpointContentHash: shortCarryHash(stored),
  });
  expect(getWorkItemCheckpointWithMeta).toHaveBeenCalledWith({ harness: 'canonical', workItemId: 'WI-checkpoint-page' });
  expect(getWorkItemDetail).not.toHaveBeenCalled();
  expect(getWorkItemThreadWindow).not.toHaveBeenCalled();

  const clamped = await one({ id: 'WI-checkpoint-page', checkpointOnly: true, offset: 99, limit: 900 });
  expect(clamped.checkpointPage).toMatchObject({
    offset: Array.from(stored).length,
    limit: 768,
    returnedChars: 0,
    nextOffset: null,
    text: '',
    limitClamped: { requested: 900, applied: 768 },
  });
});

it('checkpointOnly pages the immutable terminal completion snapshot after live checkpoint cleanup', async () => {
  const stored = '## Terminal design\n😀 preserve every section exactly';
  getWorkItem.mockResolvedValue({
    id: 'WI-terminal-snapshot',
    harness: 'canonical',
    state: 'done',
    closedAt: '2026-10-20T12:00:00.000Z',
    terminalCompletionEvidence: { checkpointProseSnapshot: stored },
  });
  const raw = await env({ id: 'WI-terminal-snapshot', checkpointOnly: true, offset: 16, limit: 8 });
  const result = (shapeWorkItemsGet(raw, 'trimmed') as any).results[0];
  expect(result).toMatchObject({
    checkpointPage: {
      offset: 16,
      totalChars: Array.from(stored).length,
      text: Array.from(stored).slice(16, 24).join(''),
    },
    checkpointSource: 'terminal-completion-snapshot',
    checkpointUpdatedAtMs: Date.parse('2026-10-20T12:00:00.000Z'),
    checkpointContentHash: shortCarryHash(stored),
  });
  expect(getWorkItemCheckpointWithMeta).not.toHaveBeenCalled();
});

it('checkpointOnly pages the exact prior-attempt rawRef and reports unresolved sources distinctly', async () => {
  const rawRef = 'WI-parent#checkpoint-journal:1792952905841';
  const sourceText = '## Full prior checkpoint\n' + 'evidence '.repeat(300);
  expect(() => parse({ id: 'WI-current', sourceRef: rawRef })).toThrow(/sourceRef is only valid/);
  expect(() => parse({ id: 'WI-current', checkpointOnly: true, sourceRef: rawRef })).not.toThrow();
  getWorkItem.mockResolvedValue({ id: 'WI-current', harness: 'canonical' });
  resolvePriorAttemptRefs.mockResolvedValue({
    schemaVersion: 'prior-attempt-refs-v1',
    records: [{ rawRef, text: sourceText, at: '2026-10-20T12:00:00.000Z' }],
    unresolved: [],
    fingerprint: 'fp-source',
  });
  const rawPage = await env({ id: 'WI-current', checkpointOnly: true, sourceRef: rawRef, offset: 10, limit: 12 });
  const page = (shapeWorkItemsGet(rawPage, 'trimmed') as any).results[0];
  expect(page).toMatchObject({
    checkpointSource: 'prior-attempt-ref',
    checkpointSourceRef: rawRef,
    checkpointSourceStatus: 'resolved',
    checkpointPage: {
      offset: 10,
      totalChars: sourceText.length,
      text: sourceText.slice(10, 22),
    },
    checkpointContentHash: shortCarryHash(sourceText),
  });
  expect(resolvePriorAttemptRefs).toHaveBeenCalledWith(expect.objectContaining({
    workItem: expect.objectContaining({ id: 'WI-current' }),
    harness: 'canonical',
    rawRefs: [rawRef],
  }));
  expect(getWorkItemCheckpointWithMeta).not.toHaveBeenCalled();

  resolvePriorAttemptRefs.mockResolvedValue({ schemaVersion: 'prior-attempt-refs-v1', records: [], unresolved: [rawRef] });
  const rawMissing = await env({ id: 'WI-current', checkpointOnly: true, sourceRef: rawRef });
  const missing = (shapeWorkItemsGet(rawMissing, 'trimmed') as any).results[0];
  expect(missing).toMatchObject({
    checkpointPage: null,
    checkpointSource: 'prior-attempt-ref',
    checkpointSourceRef: rawRef,
    checkpointSourceStatus: 'unresolved',
  });
});

it('checkpointOnly keeps a failed checkpoint read distinct from no stored checkpoint', async () => {
  getWorkItem.mockResolvedValue({ id: 'WI-checkpoint-page-failed', harness: 'canonical' });
  getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: null, updatedAtMs: null, readFailed: true });
  const result = await one({ id: 'WI-checkpoint-page-failed', checkpointOnly: true });
  expect(result).toMatchObject({
    checkpointPage: null,
    checkpointReadFailed: true,
    checkpointContentHash: null,
  });
});

const env = async (x: unknown) => {
  const res = (await get.handler(parse(x) as never, ctx)) as Out;
  return res.data;
};
const one = async (x: unknown) => (await env(x)).results[0];

it('resume reaches the saved checkpoint and evidence without loading history or full item detail', async () => {
  getWorkItem.mockResolvedValue({ id: 'WI-resume', harness: 'canonical', assignee: 'su-current', state: 'open',
    payload: { plan_item: { plan_slug: 'resume-plan', item_id: 'P-001' } } });
  getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: '## Did\n' + 'history '.repeat(1500) + '\n\n## Next action\nUse test-run:44 for acceptance.', updatedAtMs: 123 });
  getWorkItemCheckpointFreshness.mockResolvedValue({ verdict: 'fresh' });
  resumeEvidence.mockResolvedValue([{ id: 1, specId: 'SPEC-001', specRevision: 1, evidenceKind: 'test',
    evidenceRef: 'saved-run:44', testRunId: 44, coverageEvidenceRef: null,
    currentness: { overall: 'current' }, details: { adequacy: { outcome: 'pass' } } }]);
  const calls: string[] = [];
  const read = async (resume: boolean, full = false) => {
    calls.push(resume ? 'resume' : full ? 'full checkpoint recovery' : 'ordinary trimmed read');
    const output = await env({ id: 'WI-resume', harness: 'requested', ...(resume ? { resume: true } : {}) });
    // Full recovery returns the public handler's complete body; ordinary reads
    // cross the real trimmed shaper, including the __resumeOnly delivery handoff.
    return full ? output : shapeWorkItemsGet(output, 'trimmed') as any;
  };
  const legacy = await read(false);
  expect(JSON.stringify(legacy)).not.toContain('Use test-run:44 for acceptance.');
  const recovered = await read(false, true);
  expect(recovered.results[0].checkpoint).toContain('Use test-run:44 for acceptance.');
  const legacySteps = calls.splice(0);
  const result = (await read(true)).results[0];
  expect(result.resume.nextAction).toEqual({ status: 'available', text: 'Use test-run:44 for acceptance.' });
  expect(result.resume.claim.assignee).toBe('su-current');
  expect(result.resume.evidence.rows).toContainEqual(expect.objectContaining({
    specId: 'SPEC-001', testRunId: 44, evidenceRef: 'saved-run:44', outcome: 'pass', currentness: 'current',
  }));
  expect(legacySteps).toEqual(['ordinary trimmed read', 'full checkpoint recovery']);
  expect(calls).toEqual(['resume']);
  expect({ legacySteps: legacySteps.length, resumeSteps: calls.length }).toEqual({ legacySteps: 2, resumeSteps: 1 });
  expect(resumeEvidence).toHaveBeenCalledWith(expect.objectContaining({ harnessSlug: 'canonical', workItemIds: ['WI-resume'] }));
  expect(getWorkItemDetail).not.toHaveBeenCalled();
  expect(getWorkItemThreadWindow).not.toHaveBeenCalled();
});

it('resume documents and enforces its standalone contract', () => {
  expect(get.args.description ?? '').toBeDefined();
  const argsShape = (get.args as { shape?: Record<string, { description?: string }> }).shape;
  const resumeDescription = String(argsShape?.resume?.description ?? '');
  const idsDescription = String(argsShape?.ids?.description ?? '');
  const callConstraint = (z.toJSONSchema(get.args as never) as { 'x-papercusp-call-constraint'?: string })['x-papercusp-call-constraint'] ?? '';
  expect(callConstraint).toContain('resume requires one item');
  expect(callConstraint).toContain('multi-id batches are not supported');
  expect(idsDescription).toContain('With resume:true, provide one ID only');
  expect(resumeDescription).toContain('Standalone one-item continuation view');
  expect(resumeDescription).toContain('a one-element ids array is accepted');
  expect(resumeDescription).toContain('multi-id batches are rejected');
  for (const excluded of ['detail', 'checksOnly', 'checkpointOnly', 'threadLimit', 'priorAttemptRefs', 'operationalBrief']) {
    expect(resumeDescription).toContain(excluded);
  }
  const json = z.toJSONSchema(get.args as never) as { 'x-papercusp-call-constraint'?: string };
  expect(json['x-papercusp-call-constraint']).toContain('operationalBrief');
  expect(() => parse({ id: 'WI-a', resume: true })).not.toThrow();
  expect(() => parse({ ids: ['WI-a'], resume: true })).not.toThrow();
  expect(() => parse({ ids: ['WI-a', 'WI-b'], resume: true })).toThrow(/resume requires one item/);
  expect(() => parse({ id: 'WI-a', resume: true, detail: true })).toThrow(/resume requires one item/);
  expect(() => parse({ id: 'WI-a', resume: true, checksOnly: true })).toThrow(/resume requires one item/);
  expect(() => parse({ id: 'WI-a', resume: true, threadLimit: 0 })).toThrow(/resume requires one item/);
  expect(() => parse({ id: 'WI-a', resume: true, priorAttemptRefs: ['WI-b#checkpoint'] })).toThrow(/resume requires one item/);
  expect(() => parse({ id: 'WI-a', resume: true, operationalBrief: true })).toThrow(/operationalBrief/);
});

it('declares resume checks as a rows ledger in the published output contract', () => {
  const schema = z.toJSONSchema(get.result as never) as any;
  const resume = schema.properties.results.items.properties.resume;
  expect(resume).toBeDefined();
  expect(resume.properties.schemaVersion.const).toBe('work-item-resume-v1');
  expect(resume.properties.checks.type).toBe('object');
  expect(resume.properties.checks.properties.rows.type).toBe('array');
  expect(resume.properties.checks.properties.rows.items.properties.claim.type).toBe('string');
  expect(resume.properties.checks.properties.omitted.type).toBe('integer');
  expect(resume.properties.checks.required).toEqual(expect.arrayContaining(['rows', 'omitted']));
});

it('validates the real resume check ledger and rejects the caller array assumption', async () => {
  getWorkItem.mockResolvedValue({ id: 'WI-resume-check-contract', harness: 'canonical' });
  getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: withCarryNoteChecks('Saved progress', [
    { id: 'saved-proof', claim: 'Saved proof is current', recheck: 'Read its source receipt' },
  ]), updatedAtMs: 123 });
  resumeEvidence.mockResolvedValue([]);
  const output = await env({ id: 'WI-resume-check-contract', resume: true });
  const schema = (get as unknown as {
    result: { safeParse: (value: unknown) => { success: boolean } };
  }).result;
  const packet = output.results[0].resume;
  expect(packet.checks).toMatchObject({ rows: [{ id: 'saved-proof' }], omitted: 0 });
  for (const tier of ['standard', 'trimmed'] as const) {
    expect(schema.safeParse(shapeWorkItemsGet(output, tier)).success).toBe(true);
  }
  for (const checks of [[], { rows: {}, omitted: 0 }, { rows: [], omitted: -1 }, { rows: [] }]) {
    const invalid = { ...output, results: [{ ...output.results[0], resume: { ...packet, checks } }] };
    expect(schema.safeParse(invalid).success, JSON.stringify(checks)).toBe(false);
  }
  const resumeDescription = String((get.args as any).shape.resume.description);
  expect(resumeDescription).toContain('resume.checks.rows');
  expect(resumeDescription).toContain('resume.checks.omitted');
});

it('declares the actual checkpoint/comment window output with writer-owned numeric post identity', async () => {
  getWorkItem.mockResolvedValue({ id: 'WI-contract', title: 'contract' });
  const post: ThreadPostRow = {
    id: 42, thread_id: 'thread-contract', author_id: null,
    body: 'Exact prior finding', created_ts: '2026-09-08T00:00:00.000Z',
  };
  getWorkItemThreadWindow.mockResolvedValue({
    total: 7, posts: [post], topics: [], createdAt: post.created_ts,
  });
  const output = await env({ id: 'WI-contract', threadLimit: 1 });
  const schema = (get as unknown as {
    result: { safeParse: (value: unknown) => { success: boolean } };
  }).result;
  expect(output.results[0].threadWindow).toMatchObject({ total: 7, posts: [post] });
  expect(schema.safeParse(output).success).toBe(true);
  const row = output.results[0];
  const withRow = (changes: Record<string, unknown>) => ({ ...output, results: [{ ...row, ...changes }] });
  expect(schema.safeParse(withRow({ checkpoint: null, threadWindow: null })).success).toBe(true);
  expect(schema.safeParse(withRow({ checkpoint: false })).success).toBe(false);
  expect(schema.safeParse(withRow({
    threadWindow: { total: 7, posts: [{ ...post, id: '42' }] },
  })).success).toBe(false);
});

it('opts out of the ambient workspace transaction because the handler never reads ctx.tx', () => {
  // Keeping this assertion beside the handler's existing wiring tests prevents
  // a future projection change from reintroducing a long-lived app-pool hold.
  expect((get as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
});

beforeEach(() => {
  getWorkItem.mockReset();
  getWorkItemDetail.mockReset();
  getWorkItemThreadWindow.mockReset();
  getWorkItemCheckpointWithMeta.mockReset().mockResolvedValue({ checkpoint: null, updatedAtMs: null });
  // P-007: default to "no dependencies declared" so every pre-existing suite keeps
  // exercising the time-heuristic fallback; the override suite opts in explicitly.
  getWorkItemCheckpointFreshness.mockReset();
  getWorkItemCheckpointFreshness.mockResolvedValue(undefined);
  resolvePriorAttemptRefs.mockReset().mockResolvedValue(null);
  getClaimTimePriorAttemptBrief.mockReset().mockResolvedValue(null);
  getPresence.mockReset();
  getPresence.mockResolvedValue(null);
  getClaimTimePriorWorkHint.mockReset();
  getClaimTimePriorWorkHint.mockResolvedValue(null);
  completionFreshnessForEvidence.mockReset().mockResolvedValue(undefined);
  deploymentPositionForEvidence.mockReset().mockResolvedValue(undefined);
});

describe('work_items:get — checkpoint field', () => {
  it('reports current, mismatch, and unknown subject identity for normal and checksOnly reads', async () => {
    const item = {
      id: 'WI-subject-read',
      harness: 'papercusp',
      kind: 'bug',
      title: 'subject title',
      summary: 'subject summary',
      state: 'open',
    };
    const current = computeWorkItemSubjectFingerprint(item);
    getWorkItem.mockResolvedValue(item);
    getWorkItemCheckpointWithMeta.mockResolvedValue({
      checkpoint: 'checkpoint body',
      updatedAtMs: 123,
      subjectFingerprint: current,
    });

    const currentRead = await one({ id: item.id });
    expect(currentRead.checkpointSubjectFingerprint).toEqual({
      status: 'current',
      current,
      stored: current,
    });

    const changed = computeWorkItemSubjectFingerprint({ ...item, title: 'changed title' });
    getWorkItemCheckpointWithMeta.mockResolvedValue({
      checkpoint: 'checkpoint body',
      updatedAtMs: 123,
      subjectFingerprint: changed,
    });
    const mismatchRead = await one({ id: item.id });
    expect(mismatchRead.checkpointSubjectFingerprint).toEqual({
      status: 'mismatch',
      current,
      stored: changed,
    });

    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'legacy checkpoint', updatedAtMs: 123 });
    const unknownRead = await one({ id: item.id, checksOnly: true });
    expect(unknownRead.checkpointSubjectFingerprint).toEqual({ status: 'unknown' });
    expect(unknownRead).not.toHaveProperty('checkpoint');
  });

  it('does not compare a bodyless issue subject against the stored full-subject fingerprint', async () => {
    const item = {
      id: 'WI-checks-only-subject',
      harness: 'papercusp',
      family: 'issue',
      kind: 'bug',
      title: 'bodyless issue subject',
      summary: 'The authoritative issue body.',
      state: 'open',
    };
    const current = computeWorkItemSubjectFingerprint(item);
    const checkpoint = 'checkpoint body';
    getWorkItem.mockImplementation(async (_id, _harness, options) =>
      options?.includeBody === false ? { ...item, summary: '' } : item,
    );
    getWorkItemCheckpointWithMeta.mockResolvedValue({
      checkpoint,
      updatedAtMs: 123,
      subjectFingerprint: current,
    });

    const fullRead = await one({ id: item.id });
    const checksOnlyRead = await one({ id: item.id, checksOnly: true });

    expect(fullRead.checkpointSubjectFingerprint).toEqual({ status: 'current', current, stored: current });
    expect(checksOnlyRead.checkpointSubjectFingerprint).toEqual({ status: 'unknown', stored: current });
    expect(checksOnlyRead.checkpointContentHash).toBe(fullRead.checkpointContentHash);
    expect(checksOnlyRead.checkpointUpdatedAtMs).toBe(fullRead.checkpointUpdatedAtMs);
    expect(getWorkItem).toHaveBeenNthCalledWith(1, item.id, undefined);
    expect(getWorkItem).toHaveBeenNthCalledWith(2, item.id, undefined, {
      includeBody: false,
      payloadProjection: 'none',
    });
  });

  it('includes the issue body when a result projection requests the subject fingerprint', () => {
    expect(workItemsGetSourceReadOptions({ pick: ['results[].checkpointSubjectFingerprint'] }, false)).toEqual({
      includeBody: true,
      payloadProjection: 'none',
    });
    expect(workItemsGetSourceReadOptions({ pick: ['results[0].checkpointSubjectFingerprint.current.sha256'] }, false)).toEqual({
      includeBody: true,
      payloadProjection: 'none',
    });
    expect(workItemsGetSourceReadOptions({ pick: ['results[].checkpointContentHash'] }, false)).toEqual({
      includeBody: false,
      payloadProjection: 'none',
    });
  });

  it('returns projected prose at results[].workItem.summary without body aliases', async () => {
    const item = {
      id: 'WI-summary-shorthand',
      harness: 'papercusp',
      family: 'issue',
      kind: 'bug',
      title: 'summary projection',
      summary: 'The authoritative issue body.',
      state: 'open',
    };
    getWorkItem.mockImplementation(async (_id, _harness, options) =>
      options?.includeBody === false ? { ...item, summary: '' } : item,
    );

    const result = await get.handler(
      { id: item.id } as never,
      { ...ctxFields, sourceProjection: { pick: ['summary'] } } as never,
    ) as Out;

    expect(workItemsGetSourceReadOptions({ pick: ['summary'] }, false)).toEqual({
      includeBody: true,
      payloadProjection: 'none',
    });
    expect(getWorkItem).toHaveBeenCalledWith(item.id, undefined, {
      includeBody: true,
      payloadProjection: 'none',
    });
    expect(result.data.results[0].workItem.summary).toBe(item.summary);
    expect(result.data.results[0].workItem).not.toHaveProperty('body');
    expect(result.data.results[0].workItem).not.toHaveProperty('description');
  });

  it('checksOnly reads only the stored row identities and skips the full enrichment ladder', async () => {
    getWorkItem.mockResolvedValue({
      id: 'WI-checks-only',
      harness: 'papercup',
      kind: 'bug',
      family: 'issue',
      title: 'checkpoint ledger',
      state: 'open',
      summary: 'S'.repeat(10_000),
      payload: { giant: 'P'.repeat(10_000) },
    });
    const checkpoint = withCarryNoteChecks(
      'private narrative that must not cross the checksOnly boundary',
      [
        { id: 'Gate Green', claim: 'gate is green', recheck: 'probe gate' },
        { claim: 'main points at the tested commit', recheck: 'git rev-parse HEAD' },
      ],
    );
    const updatedAtMs = Date.now() - 2_000;
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint, updatedAtMs });

    const r = await one({ id: 'WI-checks-only', detail: true, threadLimit: 5, checksOnly: true });

    expect(getWorkItem).toHaveBeenCalledWith(
      'WI-checks-only',
      undefined,
      { includeBody: false, payloadProjection: 'none' },
    );
    expect(getWorkItemDetail).not.toHaveBeenCalled();
    expect(getWorkItemThreadWindow).not.toHaveBeenCalled();
    expect(getClaimTimePriorWorkHint).not.toHaveBeenCalled();
    expect(getWorkItemCheckpointWithMeta).toHaveBeenCalledWith({
      harness: 'papercup',
      workItemId: 'WI-checks-only',
    });
    expect(r).toMatchObject({
      ok: true,
      id: 'WI-checks-only',
      __checksOnly: true,
      checkpointChecks: {
        count: 2,
        cap: CARRY_NOTE_MAX_CHECKS,
        remaining: CARRY_NOTE_MAX_CHECKS - 2,
        rows: [
          { id: 'gate-green', claim: 'gate is green' },
          { claim: 'main points at the tested commit' },
        ],
      },
      checkpointUpdatedAtMs: updatedAtMs,
      checkpointContentHash: shortCarryHash(checkpoint),
    });
    expect(r).not.toHaveProperty('checkpoint');
    expect(r).not.toHaveProperty('workItem');
  });

  it('keeps checksOnly shaped rows valid against the registered output schema', async () => {
    getWorkItem.mockResolvedValue({
      id: 'WI-checks-only-schema',
      harness: 'papercup',
      kind: 'bug',
      family: 'issue',
      title: 'checkpoint ledger',
      state: 'open',
    });
    const checkpoint = withCarryNoteChecks('private narrative', [
      { id: 'gate-green', claim: 'gate is green', recheck: 'probe gate' },
    ]);
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint, updatedAtMs: 123 });

    const raw = await env({ id: 'WI-checks-only-schema', checksOnly: true });
    const shaped = shapeWorkItemsGet(raw, 'trimmed');
    const schema = (get as unknown as {
      result: { safeParse: (value: unknown) => { success: boolean } };
    }).result;

    expect(raw.results[0]).not.toHaveProperty('workItem');
    const parsed = schema.safeParse(shaped);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });

  it('checksOnly reports a checkpoint-store failure without inventing an empty ledger', async () => {
    getWorkItem.mockResolvedValue({
      id: 'WI-checks-only-failed',
      harness: 'papercup',
      kind: 'bug',
      family: 'issue',
      title: 'checkpoint ledger',
      state: 'open',
    });
    getWorkItemCheckpointWithMeta.mockRejectedValue(new Error('pg down'));

    const r = await one({ id: 'WI-checks-only-failed', checksOnly: true });

    expect(r).toMatchObject({
      ok: true,
      id: 'WI-checks-only-failed',
      __checksOnly: true,
      checkpointChecks: null,
      checkpointAgeMs: null,
      checkpointUpdatedAtMs: null,
      checkpointContentHash: null,
      checkpointReadFailed: true,
    });
    expect(r).not.toHaveProperty('checkpoint');
    expect(r).not.toHaveProperty('workItem');
  });

  it('emits completion evidence through the result-level alias', async () => {
    const completion = {
      summary: 'implemented the completion-evidence read path',
      testsRun: 'npm run test:file -- get-shape.test.ts',
      testResult: '47 passed',
      verifiedHow: 'focused Vitest regression',
      addedTests: true,
      filesChanged: ['packages/operator-core/lib/agent-tools/work_items/get-shape.ts'],
    };
    getWorkItem.mockResolvedValue({
      id: 'WI-handler-completion',
      harness: 'papercup',
      kind: 'bug',
      family: 'issue',
      title: 'terminal item',
      state: 'done',
      terminalCompletionEvidence: completion,
    });

    const r = await one({ id: 'WI-handler-completion' });

    expect(r.completion).toEqual(completion);
    expect(r.hasCompletionEvidence).toBe(true);
  });

  it('emits an explicit false presence result for a terminal row without evidence', async () => {
    getWorkItem.mockResolvedValue({
      id: 'WI-handler-no-completion',
      harness: 'papercup',
      kind: 'bug',
      family: 'issue',
      title: 'legacy terminal item',
      state: 'done',
      terminalCompletionEvidence: null,
    });

    const r = await one({ id: 'WI-handler-no-completion' });

    expect(r.completion).toBeNull();
    expect(r.hasCompletionEvidence).toBe(false);
  });

  it('surfaces the terminal completion freshness verdict from the read-side detector', async () => {
    const evidence = {
      treeStamp: { repositoryRoot: '/repo', headSha: 'a'.repeat(40) },
    };
    const completionFreshness = {
      verdict: 'stale',
      storedTreeStamp: evidence.treeStamp,
      currentTreeStamp: { repositoryRoot: '/repo', headSha: 'b'.repeat(40) },
      reason: 'peer advanced HEAD',
    };
    getWorkItem.mockResolvedValue({
      id: 'WI-completion-freshness',
      harness: 'papercup',
      kind: 'bug',
      family: 'issue',
      title: 'terminal item',
      state: 'done',
      terminalCompletionEvidence: evidence,
    });
    completionFreshnessForEvidence.mockResolvedValue(completionFreshness);

    const r = await one({ id: 'WI-completion-freshness' });

    expect(completionFreshnessForEvidence).toHaveBeenCalledWith(evidence);
    expect(r.completionFreshness).toEqual(completionFreshness);
  });

  it('surfaces the independent deployment position for terminal completion paths', async () => {
    const evidence = { filesChanged: ['packages/example.ts'] };
    const deploymentPosition = {
      paths: [{ path: 'packages/example.ts', positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false } }],
      unknownPaths: [],
      totalPaths: 1,
      truncated: false,
    };
    getWorkItem.mockResolvedValue({
      id: 'WI-deployment-position',
      harness: 'papercup',
      kind: 'bug',
      family: 'issue',
      title: 'terminal item',
      state: 'done',
      terminalCompletionEvidence: evidence,
    });
    deploymentPositionForEvidence.mockResolvedValue(deploymentPosition);

    const r = await one({ id: 'WI-deployment-position' });

    expect(deploymentPositionForEvidence).toHaveBeenCalledWith(evidence);
    expect(r.deploymentPosition).toEqual(deploymentPosition);
  });

  it('surfaces an existing checkpoint + its age, keyed by the resolved work-item harness/id', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open' });
    const updatedAtMs = Date.now() - 5000;
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'did step 1; next: step 2', updatedAtMs });
    const r = await one({ id: 'WI-7' });
    expect(getWorkItemCheckpointWithMeta).toHaveBeenCalledWith({ harness: 'papercup', workItemId: 'WI-7' });
    expect(r).toMatchObject({ ok: true, id: 'WI-7', checkpoint: 'did step 1; next: step 2', checkpointUpdatedAtMs: updatedAtMs });
    expect(r.checkpointAgeMs).toBeGreaterThanOrEqual(5000);
  });

  it('is null (not omitted) when no checkpoint was ever written — age is also null', async () => {
    getWorkItem.mockResolvedValue({
      id: 'WI-8',
      harness: 'papercup',
      kind: 'bug',
      family: 'issue',
      title: 't',
      state: 'open',
    });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: null, updatedAtMs: null });
    const r = await one({ id: 'WI-8' });
    expect(r).toMatchObject({
      ok: true,
      id: 'WI-8',
      checkpoint: null,
      checkpointChecks: { count: 0, cap: CARRY_NOTE_MAX_CHECKS, remaining: CARRY_NOTE_MAX_CHECKS },
      checkpointAgeMs: null,
      checkpointUpdatedAtMs: null,
    });
  });

  it('surfaces checkpoint check-row capacity from the stored canonical rows', async () => {
    getWorkItem.mockResolvedValue({
      id: 'WI-8b',
      harness: 'papercup',
      kind: 'bug',
      family: 'issue',
      title: 't',
      state: 'open',
    });
    const checkpoint = withCarryNoteChecks(
      'work remains',
      Array.from({ length: 10 }, (_, i) => ({ claim: `check ${i + 1}`, recheck: `probe ${i + 1}` })),
    );
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint, updatedAtMs: Date.now() });

    const r = await one({ id: 'WI-8b' });

    expect(r.checkpointChecks).toEqual({
      count: 10,
      cap: CARRY_NOTE_MAX_CHECKS,
      remaining: 2,
      rows: Array.from({ length: 10 }, (_, i) => ({ claim: `check ${i + 1}` })),
    });
  });

  it('keeps normal checkpoint identities valid against the registered output schema', async () => {
    getWorkItem.mockResolvedValue({
      id: 'WI-normal-checks-schema',
      harness: 'papercup',
      kind: 'bug',
      family: 'issue',
      title: 'checkpoint ledger',
      state: 'open',
    });
    getWorkItemDetail.mockResolvedValue({
      id: 'WI-normal-checks-schema',
      harness: 'papercup',
      kind: 'bug',
      family: 'issue',
      title: 'checkpoint ledger',
      state: 'open',
    });
    const checkpoint = withCarryNoteChecks('private narrative', [
      { id: 'gate-green', claim: 'gate is green', recheck: 'probe gate' },
    ]);
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint, updatedAtMs: 123 });

    const raw = await env({ id: 'WI-normal-checks-schema', detail: true });
    const shaped = shapeWorkItemsGet(raw, 'trimmed');
    const schema = (get as unknown as {
      result: { safeParse: (value: unknown) => { success: boolean } };
    }).result;

    expect(raw.results[0].checkpointChecks).toMatchObject({
      rows: [{ id: 'gate-green', claim: 'gate is green' }],
    });
    const parsed = schema.safeParse(shaped);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });

  it.each(['rejected', 'in-band'] as const)('degrades explicitly when the checkpoint lookup fails (%s)', async (failure) => {
    getWorkItem.mockResolvedValue({ id: 'WI-9', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open' });
    if (failure === 'rejected') getWorkItemCheckpointWithMeta.mockRejectedValue(new Error('pg down'));
    else getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: null, updatedAtMs: null, readFailed: true });
    const r = await one({ id: 'WI-9' });
    expect(r).toMatchObject({ ok: true, id: 'WI-9', checkpoint: null, checkpointAgeMs: null, checkpointUpdatedAtMs: null });
    expect(r.checkpointChecks).toBeNull();
    // WI-6737: fail-soft is right, but SILENT fail-soft is not — the degraded null was previously
    // byte-identical to a successful "never checkpointed" read, so a reader (or a compacted
    // successor) concluded in-flight state was lost during a mere PG blip. That is the exact
    // conclusion EI-7252 added this field to prevent, re-created by its own error path.
    expect(r.checkpointReadFailed).toBe(true);
  });

  it('checksOnly preserves an in-band metadata read failure as an unknown check ledger', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-9', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open' });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: null, updatedAtMs: null, readFailed: true });
    const r = await one({ id: 'WI-9', checksOnly: true });
    expect(r).toMatchObject({
      checkpointReadFailed: true, checkpointChecks: null, checkpointContentHash: null, checkpointBody: null,
    });
  });

  it('does NOT mark checkpointReadFailed when the read succeeded and found nothing (WI-6737)', async () => {
    // The other half of the distinction, and the one that keeps the flag meaningful: an ordinary
    // never-checkpointed item must stay unmarked, or the signal degenerates into noise every read.
    getWorkItem.mockResolvedValue({ id: 'WI-9b', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open' });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: null, updatedAtMs: null });
    const r = await one({ id: 'WI-9b' });
    expect(r).toMatchObject({ ok: true, checkpoint: null });
    expect(r.checkpointReadFailed).toBeUndefined();
  });

  it('suppresses the never-checkpointed warning after terminal evidence replaced the cleared checkpoint', async () => {
    getWorkItem.mockResolvedValue({
      id: 'WI-terminal',
      harness: 'papercup',
      kind: 'bug',
      family: 'issue',
      title: 'finished item',
      // `done` is the unified terminal state used by the live issue-family writer.
      // Keep this exact shape covered: the original production repro was a DONE row,
      // while the legacy `resolved` alias is covered by the shared terminal-state set.
      state: 'done',
      terminalCompletionEvidence: { verifiedHow: 'unit', testResult: '3 passed' },
    });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: null, updatedAtMs: null });
    getClaimTimePriorWorkHint.mockResolvedValue({
      lastReleasedBy: 'su-prior',
      releasedAtMs: Date.now() - 1000,
      attempts: 1,
      priorWorkers: ['su-prior'],
    });

    const r = await one({ id: 'WI-terminal' });

    expect(r).toMatchObject({ ok: true, checkpoint: null });
    expect(r.priorWork).toBeUndefined();
    expect(r.priorWorkWarning).toBeUndefined();
  });

  it('retains the never-checkpointed warning for a terminal item with no completion evidence', async () => {
    // EI-21468098008124968: this is the mutation control for the fourth
    // `completionSupersedesClearedCheckpoint` conjunct. A settled state plus a
    // successful checkpoint:null read is NOT enough to infer that completion
    // harvested the checkpoint — only stored terminal evidence proves that
    // boundary. Removing the evidence conjunct must make this case fail.
    getWorkItem.mockResolvedValue({
      id: 'WI-terminal-without-evidence',
      harness: 'papercup',
      kind: 'bug',
      family: 'issue',
      title: 'terminal item without completion evidence',
      state: 'done',
      terminalCompletionEvidence: null,
    });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: null, updatedAtMs: null });
    getClaimTimePriorWorkHint.mockResolvedValue({
      lastReleasedBy: 'su-prior',
      releasedAtMs: Date.now() - 1000,
      attempts: 1,
      priorWorkers: ['su-prior'],
    });

    const r = await one({ id: 'WI-terminal-without-evidence' });

    expect(r).toMatchObject({ ok: true, checkpoint: null });
    expect(r.priorWorkWarning).toMatch(/NO checkpoint was ever written/);
  });

  it('retains the never-checkpointed warning for open prior work even when evidence is present', async () => {
    getWorkItem.mockResolvedValue({
      id: 'WI-open',
      harness: 'papercup',
      kind: 'bug',
      family: 'issue',
      title: 'open item',
      state: 'open',
      terminalCompletionEvidence: { verifiedHow: 'unit', testResult: 'stale evidence' },
    });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: null, updatedAtMs: null });
    getClaimTimePriorWorkHint.mockResolvedValue({
      lastReleasedBy: 'su-prior',
      releasedAtMs: Date.now() - 1000,
      attempts: 1,
      priorWorkers: ['su-prior'],
    });

    const r = await one({ id: 'WI-open' });

    expect(r.priorWorkWarning).toMatch(/NO checkpoint was ever written/);
  });

  it('keeps prior-work checkpoint state UNKNOWN when the read fails on a terminal item', async () => {
    getWorkItem.mockResolvedValue({
      id: 'WI-terminal-read-failed',
      harness: 'papercup',
      kind: 'bug',
      family: 'issue',
      title: 'finished item',
      state: 'resolved',
      terminalCompletionEvidence: { verifiedHow: 'unit', testResult: '3 passed' },
    });
    getWorkItemCheckpointWithMeta.mockRejectedValue(new Error('pg down'));
    getClaimTimePriorWorkHint.mockResolvedValue({
      lastReleasedBy: 'su-prior',
      releasedAtMs: Date.now() - 1000,
      attempts: 1,
      priorWorkers: ['su-prior'],
    });

    const r = await one({ id: 'WI-terminal-read-failed' });

    expect(r.checkpointReadFailed).toBe(true);
    expect(r.priorWorkWarning).toMatch(/could NOT BE READ/);
    expect(r.priorWorkWarning).toMatch(/UNKNOWN/);
  });

  it('reads the checkpoint for a harness-null item (EI-8805 — no longer skipped)', async () => {
    // A harness-null item (an EI filed from an unscoped session) previously skipped the
    // checkpoint lookup entirely and always read null, silently losing a written
    // checkpoint. Now the lookup runs (the store canonicalizes the null harness to the
    // wildcard namespace it was written under) so the checkpoint round-trips.
    getWorkItem.mockResolvedValue({ id: 'EI-10', harness: null, kind: 'bug', family: 'issue', title: 't', state: 'open' });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'harness-null continuity state', updatedAtMs: Date.now() });
    const r = await one({ id: 'EI-10' });
    expect(getWorkItemCheckpointWithMeta).toHaveBeenCalledWith({ harness: null, workItemId: 'EI-10' });
    expect(r).toMatchObject({ ok: true, id: 'EI-10', checkpoint: 'harness-null continuity state' });
  });

  it('also surfaces on the detail path (args.detail:true)', async () => {
    getWorkItemDetail.mockResolvedValue({ id: 'WI-11', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open', topics: [], posts: [], links: [] });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'detail-path checkpoint', updatedAtMs: Date.now() });
    const r = await one({ id: 'WI-11', detail: true });
    expect(getWorkItemDetail).toHaveBeenCalledWith('WI-11', undefined, { threadLimit: 10 });
    expect(r).toMatchObject({ ok: true, id: 'WI-11', checkpoint: 'detail-path checkpoint' });
  });

  it('exposes a bounded recent-comment window without loading full detail', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-12', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open' });
    getWorkItemThreadWindow.mockResolvedValue({
      posts: [{ id: 7, thread_id: 'thread-12', author_id: 'su-peer', body: 'comment', created_ts: '2026-08-12T10:00:00.000Z' }],
      total: 9,
      topics: ['release-gate'],
      createdAt: '2026-08-12T09:00:00.000Z',
    });

    const r = await one({ id: 'WI-12', threadLimit: 3 });

    expect(getWorkItem).toHaveBeenCalledWith('WI-12', undefined);
    expect(getWorkItemThreadWindow).toHaveBeenCalledWith('WI-12', 3, undefined);
    expect(getWorkItemDetail).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      ok: true,
      id: 'WI-12',
      threadWindow: { total: 9, posts: [{ body: 'comment' }], topics: ['release-gate'] },
    });
  });

  it('threadLimit wins over detail:true and keeps a thread read failure explicit', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-13', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open' });
    getWorkItemDetail.mockResolvedValue({ id: 'WI-13', harness: 'papercup', kind: 'bug', family: 'issue', title: 'wrong full path', state: 'open', topics: [], posts: [], links: [] });
    getWorkItemThreadWindow.mockRejectedValue(new Error('thread store unavailable'));

    const r = await one({ id: 'WI-13', detail: true, threadLimit: 2 });

    expect(getWorkItemDetail).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, id: 'WI-13', threadWindow: null, threadWindowReadFailed: true });
  });

  it('accepts threadLimit:0 as an explicit no-thread projection, even with detail:true', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-14', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open' });
    getWorkItemDetail.mockResolvedValue({ id: 'WI-14', harness: 'papercup', kind: 'bug', family: 'issue', title: 'wrong full path', state: 'open', topics: [], posts: [], links: [] });
    getWorkItemThreadWindow.mockResolvedValue({
      posts: [{ id: 1, thread_id: 'thread-14', author_id: 'su-peer', body: 'must not load', created_ts: '2026-08-12T10:00:00.000Z' }],
      total: 1,
      topics: [],
      createdAt: '2026-08-12T09:00:00.000Z',
    });

    const r = await one({ id: 'WI-14', detail: true, threadLimit: 0 });

    expect(getWorkItemDetail).not.toHaveBeenCalled();
    expect(getWorkItemThreadWindow).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, id: 'WI-14' });
    expect(r).not.toHaveProperty('threadWindow');
  });

  it('never calls the checkpoint store for a not-found item', async () => {
    getWorkItem.mockResolvedValue(null);
    const r = await one({ id: 'WI-404' });
    expect(getWorkItemCheckpointWithMeta).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, id: 'WI-404' });
  });
});

describe('work_items:get — checkpointStale (EI-15184 relative staleness)', () => {
  const cpMs = Date.now() - 60 * 60_000; // checkpoint written an hour ago

  it('flags checkpointStale when the assignee stayed active AFTER the checkpoint (the WI-5013 case)', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-20', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open', assignee: 'su-peer' });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'snapshot phase only', updatedAtMs: cpMs });
    // assignee kept working ~25m past the checkpoint (invisible later work)
    getPresence.mockResolvedValue({ ownerId: 'su-peer', lastActiveAt: new Date(cpMs + 25 * 60_000).toISOString() });
    const r = await one({ id: 'WI-20' });
    expect(getPresence).toHaveBeenCalledWith('su-peer');
    expect(r.checkpointStale).toBeDefined();
    expect(r.checkpointStale.stale).toBe(true);
    expect(r.checkpointStale.lagMs).toBe(25 * 60_000);
    expect(r.checkpointStale.reason).toMatch(/after this checkpoint/i);
  });

  it('omits checkpointStale when the assignee last acted before the checkpoint (checkpoint is the latest state)', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-21', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open', assignee: 'su-peer' });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'up to date', updatedAtMs: cpMs });
    getPresence.mockResolvedValue({ ownerId: 'su-peer', lastActiveAt: new Date(cpMs - 5 * 60_000).toISOString() });
    const r = await one({ id: 'WI-21' });
    expect(r.checkpointStale).toBeUndefined();
  });

  it('does not read presence (nor flag) when the item has no assignee', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-22', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open', assignee: null });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'x', updatedAtMs: cpMs });
    const r = await one({ id: 'WI-22' });
    expect(getPresence).not.toHaveBeenCalled();
    expect(r.checkpointStale).toBeUndefined();
  });

  it('fail-soft: a presence read failure omits the signal (never fails the read)', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-23', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open', assignee: 'su-peer' });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'x', updatedAtMs: cpMs });
    getPresence.mockRejectedValue(new Error('presence pg down'));
    const r = await one({ id: 'WI-23' });
    expect(r).toMatchObject({ ok: true, id: 'WI-23', checkpoint: 'x' });
    expect(r.checkpointStale).toBeUndefined();
  });

  // P-007/D-013: when the checkpoint's author DECLARED what it derives from, that
  // mechanical verdict is authoritative and the activity heuristic is suppressed —
  // the heuristic is a proxy for the same question and gets it wrong in both
  // directions (it cannot see a peer's change at all).
  it('OVERRIDES the activity heuristic with the declared-dependency verdict', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-24', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open', assignee: 'su-peer' });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'declared deps', updatedAtMs: cpMs });
    // The assignee kept working 25m past the checkpoint — the heuristic WOULD fire.
    getPresence.mockResolvedValue({ ownerId: 'su-peer', lastActiveAt: new Date(cpMs + 25 * 60_000).toISOString() });
    getWorkItemCheckpointFreshness.mockResolvedValue({
      verdict: 'fresh',
      declared: 2,
      changed: [],
      unresolvable: [],
      reason: 'all 2 declared dependencies are unchanged',
    });

    const r = await one({ id: 'WI-24' });
    expect(r.checkpointFreshness).toMatchObject({ verdict: 'fresh', declared: 2 });
    expect(r.checkpointStale).toBeUndefined();
    // and it skips the presence round-trip entirely rather than computing a
    // verdict it is going to discard.
    expect(getPresence).not.toHaveBeenCalled();
  });

  it('surfaces a stale declared verdict with the dependency that moved', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-25', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open', assignee: null });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'rig is intact', updatedAtMs: Date.now() });
    getWorkItemCheckpointFreshness.mockResolvedValue({
      verdict: 'stale',
      declared: 1,
      changed: [{ dep: 'file:shared.ts', was: 'sha256:before', now: 'sha256:after' }],
      unresolvable: [],
      reason: '1 of 1 declared dependency changed since this note was written: file:shared.ts.',
    });
    const r = await one({ id: 'WI-25' });
    expect(r.checkpointFreshness.verdict).toBe('stale');
    expect(r.checkpointFreshness.changed[0].dep).toBe('file:shared.ts');
  });

  it('fail-soft: a freshness read failure falls back to the heuristic', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-26', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open', assignee: 'su-peer' });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'x', updatedAtMs: cpMs });
    getWorkItemCheckpointFreshness.mockRejectedValue(new Error('freshness pg down'));
    getPresence.mockResolvedValue({ ownerId: 'su-peer', lastActiveAt: new Date(cpMs + 25 * 60_000).toISOString() });
    const r = await one({ id: 'WI-26' });
    expect(r).toMatchObject({ ok: true, id: 'WI-26' });
    expect(r.checkpointFreshness).toBeUndefined();
    expect(r.checkpointStale?.stale).toBe(true);
  });

  it('does not flag when there is no checkpoint even if the assignee is active', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-24', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open', assignee: 'su-peer' });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: null, updatedAtMs: null });
    getPresence.mockResolvedValue({ ownerId: 'su-peer', lastActiveAt: new Date().toISOString() });
    const r = await one({ id: 'WI-24' });
    expect(getPresence).not.toHaveBeenCalled();
    expect(r.checkpointStale).toBeUndefined();
  });
});

/**
 * EI-21379898054596220 — the checkpoint's contentHash must be readable through
 * work_items:get, and it must be the hash of the STORED note.
 *
 * THE FAILURE THIS PINS. A self-compaction handoff needed to confirm it was resuming
 * from checkpoint 81344e6f2817 — the digest `work_items:checkpoint` returned when it
 * wrote (EI-8987). work_items:get handed back the checkpoint and its write instant but
 * no hash, so the successor hashed the string it received and got 69adf041332c. That
 * mismatch is indistinguishable from a corrupted or superseded handoff, and the real
 * hash was recoverable only by reading harness_shared.carry_notes directly.
 *
 * WHY HASHING THE RETURNED STRING CANNOT WORK, AND WHY THAT IS THE INTERESTING CASE.
 * get-shape clips the checkpoint to a per-tier budget, so on exactly the long notes a
 * handoff cares about, the reader hashes a PREFIX. The clipped-note test below is
 * therefore the load-bearing one: it fails if anyone ever "simplifies" this field to a
 * hash of the projected checkpoint, which would pass every short-note test.
 *
 * The sibling loop carry-note has exposed this on its read side since loop/status.ts:78;
 * work_items:get was the asymmetry.
 */
describe('work_items:get — checkpointContentHash (EI-21379898054596220)', () => {
  const item = (id: string) => ({ id, harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open' });

  it('hashes the STORED note, matching the digest the write returned', async () => {
    // A checkpoint with structured checks: the report's exact shape, and the one where
    // stored text and any re-rendering of it are most likely to diverge.
    const stored = withCarryNoteChecks('work remains', [
      { claim: 'gate is green', recheck: 'dev:pipeline_position', verified: 'checked 20:41Z' },
      { claim: 'peer holds the file', recheck: 'locks:queue' },
    ]);
    getWorkItem.mockResolvedValue(item('WI-hash-1'));
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: stored, updatedAtMs: Date.now() });

    const r = await one({ id: 'WI-hash-1' });

    // The write side (work_items:checkpoint) returns shortCarryHash(stored); a
    // successor compares against THAT, so this must be the same function of the same
    // string, not merely "a" hash.
    expect(r.checkpointContentHash).toBe(shortCarryHash(stored));
    expect(r.checkpointContentHash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('hashes the whole stored note, however long — never a prefix of it', async () => {
    // The handler must digest what the STORE holds. Clipping happens a layer down in
    // shapeWorkItemsGet, so the invariant "the hash survives the clip" is pinned in
    // get-shape.test.ts; what this layer owes is a hash of the complete note.
    const stored = `${'x'.repeat(40_000)}\nTAIL-MARKER`;
    getWorkItem.mockResolvedValue(item('WI-hash-2'));
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: stored, updatedAtMs: Date.now() });

    const r = await one({ id: 'WI-hash-2' });

    expect(r.checkpointContentHash).toBe(shortCarryHash(stored));
    // Falsifier: any prefix-hashing implementation passes the line above only if it
    // happens not to truncate at all, so name the failure mode directly.
    expect(
      r.checkpointContentHash,
      'the hash matched a PREFIX of the note — it must digest the full stored text',
    ).not.toBe(shortCarryHash(stored.slice(0, 800)));
  });

  it('is null when nothing was ever checkpointed', async () => {
    getWorkItem.mockResolvedValue(item('WI-hash-3'));
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: null, updatedAtMs: null });

    const r = await one({ id: 'WI-hash-3' });

    expect(r.checkpointContentHash).toBeNull();
  });

  it('is null — alongside checkpointReadFailed — when the lookup throws', async () => {
    getWorkItem.mockResolvedValue(item('WI-hash-4'));
    getWorkItemCheckpointWithMeta.mockRejectedValue(new Error('pg down'));

    const r = await one({ id: 'WI-hash-4' });

    // WI-6737's discipline applied to this field: a failed read must not hand back a
    // hash, and its null must stay distinguishable from "never checkpointed" above.
    expect(r.checkpointContentHash).toBeNull();
    expect(r.checkpointReadFailed).toBe(true);
  });
});

describe('P-012 the corroboration count is shown on the item (D-049)', () => {
  const NOTE = 'Orders verification work only. It is never a verification receipt: a bug still needs a recorded reproduction receipt before it is claimable.';

  it('shows distinct reporters, filings and the not-a-receipt note, read for this item in its harness', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-corr', harness: 'papercusp', title: 't', payload: { reporterKinds: ['agent'] } });
    getWorkItemThreadWindow.mockResolvedValue({ total: 0, posts: [], topics: [] });
    readCorroborationSummary.mockResolvedValueOnce({
      reporters: 3, filings: 7, firstFiledAt: '2026-10-01T00:00:00.000Z', lastFiledAt: '2026-10-02T00:00:00.000Z',
      reporterKinds: ['agent'], note: NOTE,
    });
    const r = (await one({ id: 'WI-corr' })) as Record<string, unknown>;
    expect(r.corroboration).toEqual({
      reporters: 3, filings: 7, firstFiledAt: '2026-10-01T00:00:00.000Z', lastFiledAt: '2026-10-02T00:00:00.000Z',
      reporterKinds: ['agent'], note: NOTE,
    });
    expect(readCorroborationSummary).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'WI-corr', harness: 'papercusp', payload: { reporterKinds: ['agent'] } }),
    );
  });

  it('omits the block when nothing corroborates the item, and keeps the item when the ledger read fails', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-corr-none', harness: 'papercusp', title: 't' });
    getWorkItemThreadWindow.mockResolvedValue({ total: 0, posts: [], topics: [] });
    readCorroborationSummary.mockResolvedValueOnce(null);
    const quiet = (await one({ id: 'WI-corr-none' })) as Record<string, unknown>;
    expect(quiet.ok).toBe(true);
    expect(quiet).not.toHaveProperty('corroboration');

    readCorroborationSummary.mockRejectedValueOnce(new Error('ledger read failed'));
    const failed = (await one({ id: 'WI-corr-none' })) as Record<string, unknown>;
    expect(failed.ok).toBe(true);
    expect((failed.workItem as { id?: string }).id).toBe('WI-corr-none');
    expect(failed).not.toHaveProperty('corroboration');
  });
});
