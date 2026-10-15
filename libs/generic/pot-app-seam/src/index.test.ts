import { describe, expect, it } from 'vitest';
import {
  BLUEPRINT_OPERATION_TOOL_NAMES,
  blueprintOperationHostFromInvoker,
  createPotAppSeam,
  deriveRequestKey,
  operationDraftFromPlanRun,
  scorecardHostFromInvoker,
  parseScorecardReviewerProof,
  OperationOutputRejectedError,
  type BlueprintOperationHandle,
  type BlueprintOperationStatus,
  type IngestEvent,
  type PotAppSeamHost,
} from './index';

function statusOf(handle: BlueprintOperationHandle, over: Partial<BlueprintOperationStatus> = {}): BlueprintOperationStatus {
  return {
    handle, phase: 'terminal', outcome: 'succeeded', items: [],
    planRun: { status: 'done', outcome: 'success' }, cancellationRequested: false, wait: null, ...over,
  };
}

function host(): PotAppSeamHost & {
  markers: Map<string, string>;
  pots: string[];
  operations: Map<string, { handle: BlueprintOperationHandle; input: string }>;
  cancels: Map<string, string>;
  eventCalls: unknown[];
} {
  const markers = new Map<string, string>();
  const pots: string[] = [];
  const operations = new Map<string, { handle: BlueprintOperationHandle; input: string }>();
  const cancels = new Map<string, string>();
  const eventCalls: unknown[] = [];
  return {
    markers, pots, operations, cancels, eventCalls,
    readBootstrapMarker: (marker) => markers.get(marker) ?? null,
    writeBootstrapMarker: (marker, fingerprint) => {
      markers.set(marker, fingerprint);
    },
    ensurePot: (spec) => {
      pots.push(spec.slug);
      return { slug: spec.slug, created: true, ref: `pot:${spec.slug}` };
    },
    submitBlueprintOperation: (draft) => {
      const key = `${draft.harnessSlug}:${draft.operationId}:${draft.requestKey}`;
      const input = JSON.stringify(draft.input);
      const prior = operations.get(key);
      if (prior) {
        if (prior.input !== input) throw new Error('input_conflict: request key reused with different input');
        return prior.handle;
      }
      const handle: BlueprintOperationHandle = {
        workspaceId: 'workspace-fixture', harnessSlug: draft.harnessSlug, receiptId: operations.size + 1,
        operationId: draft.operationId, specificationRevision: 'a'.repeat(64),
        target: { kind: 'work-item', id: `WI-${operations.size + 1}` },
      };
      operations.set(key, { handle, input });
      return handle;
    },
    readBlueprintOperationStatus: (handle) => statusOf(handle),
    readBlueprintOperationResult: (handle) => ({ state: 'pending', status: statusOf(handle, { phase: 'dispatched', outcome: null }) }),
    readBlueprintOperationEvents: (handle, options) => {
      eventCalls.push(options);
      return {
        status: statusOf(handle, { phase: 'dispatched', outcome: null }),
        events: [{ kind: 'work-item', cursor: '1', at: '2026-10-06T00:00:00Z', state: 'open' }],
        cursor: '1', hasMore: false,
      };
    },
    cancelBlueprintOperation: (_handle, input) => {
      const replayed = cancels.has(input.requestKey);
      cancels.set(input.requestKey, input.reason);
      return { eventId: `evt-${input.requestKey}`, replayed, accepted: true, wakeQueued: !replayed, handled: false, effected: false };
    },
  };
}

async function* events(items: IngestEvent[]): AsyncIterable<IngestEvent> {
  for (const item of items) yield item;
}

const draft = (requestKey: string, input: Record<string, string> = { candidateId: 'a' }) => ({
  harnessSlug: 'shop', operationId: 'review-candidate', requestKey, input,
});

describe('canonical app scorecards', () => {
  const card = { issueId: 'EI-1', rubricRef: 'quality', rubricRevision: 4,
    criteriaHash: 'a'.repeat(64), evidenceFingerprint: 'fingerprint',
    criteria: [{ key: 'claims', rating: 'pass', evidence: 'Source reviewed.' }] };
  const draft = { rubricRef: card.rubricRef, rubricRevision: card.rubricRevision,
    criteriaHash: card.criteriaHash, subject: { kind: 'work-item' as const, ref: 'WI-42' },
    ratings: { claims: { rating: 'pass', evidence: 'Source reviewed.' } } };

  it('uses canonical replay receipts and passes complete readback through the app parser', async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    let emitted = false;
    const h = { ...host(), scorecards: scorecardHostFromInvoker(async (name, args) => {
      calls.push({ name, args });
      if (name === 'scorecards:get') return { ok: true, scorecard: card, evidenceRead: { complete: true } };
      const created = !emitted;
      emitted = true;
      return { ok: true, issueId: 'EI-1', created, evidenceFingerprint: 'fingerprint' };
    }) };
    const seam = createPotAppSeam(h);
    expect(await seam.emitScorecard(draft)).toMatchObject({ issueId: 'EI-1', created: true });
    expect(await seam.emitScorecard(draft)).toMatchObject({ issueId: 'EI-1', created: false });
    expect(calls[0]).toEqual({ name: 'scorecards:emit', args: { ...draft, terminal: true } });
    expect(await seam.readScorecard('EI-1', (raw) => (raw as typeof card).criteria[0]?.rating)).toBe('pass');
    await expect(seam.readScorecard('EI-1', () => { throw new Error('app gate refused'); })).rejects.toThrow('app gate refused');
  });

  it.each([
    { ok: false, error: 'refused' },
    { ok: true, scorecard: card, evidenceRead: { complete: false } },
    { ok: true, scorecard: { ...card, issueId: 'EI-other' }, evidenceRead: { complete: true } },
  ])('rejects refused, partial or mismatched readback %j before parsing', async (response) => {
    let parsed = false;
    const h = { ...host(), scorecards: scorecardHostFromInvoker(async () => response) };
    await expect(createPotAppSeam(h).readScorecard('EI-1', () => { parsed = true; })).rejects.toThrow();
    expect(parsed).toBe(false);
  });

  it('preserves the canonical reviewer receipt and attribution on complete readback', async () => {
    const handle: BlueprintOperationHandle = {
      workspaceId: 'workspace-fixture', harnessSlug: 'crm', receiptId: 8,
      operationId: 'call-review', specificationRevision: 'b'.repeat(64),
      target: { kind: 'work-item', id: 'WI-43' },
    };
    const proof = { ownerId: 'independent-reviewer', completionRef: 'completion:43',
      outputEvidenceRef: 'operation-output:43', handle };
    const adapter = scorecardHostFromInvoker(async (name, args) => {
      if (name === 'scorecards:emit') {
        expect(args.interactionReviewerHandle).toEqual(handle);
        expect(args.subject).toEqual(draft.subject);
        return { ok: true, issueId: 'EI-1', created: true, evidenceFingerprint: 'fingerprint' };
      }
      return { ok: true, scorecard: { ...card, observation: { interactionReviewer: proof } },
        evidenceRead: { complete: true } };
    });
    await adapter.emitScorecard({ ...draft, interactionReviewerHandle: handle });
    const seam = createPotAppSeam({ ...host(), scorecards: adapter });
    expect(await seam.readScorecard('EI-1', (raw) =>
      parseScorecardReviewerProof((raw as { observation: { interactionReviewer: unknown } }).observation.interactionReviewer))).toEqual(proof);
    for (const outputEvidenceRef of [undefined, null, '', ' ']) {
      expect(() => parseScorecardReviewerProof({ ...proof, outputEvidenceRef })).toThrow();
    }
    expect(() => parseScorecardReviewerProof({ ...proof, handle: { ...handle, receiptId: 0 } })).toThrow();
    expect(() => parseScorecardReviewerProof({ ...proof, handle: { ...handle,
      target: { kind: 'plan', runId: 1, instanceSlug: 'review' } } })).toThrow();
  });

  it('refuses an unconnected grading host and a malformed canonical receipt', async () => {
    await expect(createPotAppSeam(host()).emitScorecard(draft)).rejects.toThrow('not connected');
    await expect(scorecardHostFromInvoker(async () => ({ ok: false, error: 'producer lineage' })).emitScorecard(draft)).rejects.toThrow();
    await expect(scorecardHostFromInvoker(async () => ({ ok: true, issueId: null, created: true,
      evidenceFingerprint: 'fp' })).emitScorecard(draft)).rejects.toThrow('canonical receipt');
  });

  it.each([false, true])('assembles index and exact evidence pages; rejects identity drift=%s', async (drift) => {
    const calls: Record<string, unknown>[] = [];
    const adapter = scorecardHostFromInvoker(async (_name, args) => {
      calls.push(args);
      if (args.criterionKey === undefined) return { ok: true, scorecard: { ...card, criteria: [] }, evidenceRead: {
        complete: false, scope: 'criterion-index', offset: 0, totalCriteria: 1,
        criteria: [{ key: 'claims', rating: 'pass', evidenceChars: 15 }],
      } };
      const offset = args.evidenceOffset as number;
      return { ok: true, scorecard: { ...card,
        evidenceFingerprint: drift && offset > 0 ? 'changed' : card.evidenceFingerprint,
        criteria: [{ key: 'claims', rating: 'pass', evidence: offset === 0 ? 'Source ' : 'reviewed' }],
      }, evidenceRead: { scope: 'selected-criterion', offset, totalChars: 15, complete: offset > 0,
        ...(offset === 0 ? { next: { tool: 'scorecards:get', args: { issueId: 'EI-1', criterionKey: 'claims', evidenceOffset: 7 } } } : {}),
      } };
    });
    if (drift) await expect(adapter.readScorecard('EI-1')).rejects.toThrow('identity changed');
    else expect(await adapter.readScorecard('EI-1')).toMatchObject({ criteria: [{ key: 'claims', evidence: 'Source reviewed' }] });
    expect(calls).toHaveLength(3);
  });
});

describe('createPotAppSeam', () => {
  it('bootstraps pots once per stable fingerprint marker', async () => {
    const h = host();
    const seam = createPotAppSeam(h);
    const first = await seam.bootstrapPots({
      pots: [{ slug: 'shop', title: 'Shop' }, { slug: 'shop-ops', blueprint: 'generic-pot' }],
    });
    expect(first.skipped).toBe(false);
    expect(h.pots).toEqual(['shop', 'shop-ops']);
    const second = await seam.bootstrapPots({
      pots: [{ slug: 'shop-ops', blueprint: 'generic-pot' }, { slug: 'shop', title: 'Shop' }],
    });
    expect(second).toMatchObject({ skipped: true, pots: [] });
    expect(h.pots).toEqual(['shop', 'shop-ops']);
  });

  it('exposes the operation and grade lifecycles without direct plan-run or work-item enqueue', () => {
    const seam = createPotAppSeam(host());
    expect(Object.keys(seam).sort()).toEqual([
      'bootstrapPots', 'cancelOperation', 'emitScorecard', 'operationEvents', 'operationResult', 'operationStatus',
      'readScorecard', 'reviewOperation', 'startIngestLoop', 'submitOperations',
    ]);
  });

  it('maps a legacy plan draft to one operation request without changing replay identity or input', () => {
    const legacy = {
      templateSlug: 'candidate-review', input: { candidateId: 'a' }, provenance: { eventId: 'evt-a' },
      execution: { appHarnessSlug: 'shop', agentName: 'shop-reviewer' },
    };
    expect(operationDraftFromPlanRun({ ...legacy, dedupeKey: 'candidate:a' }, 'review-candidate')).toEqual({
      harnessSlug: 'shop', operationId: 'review-candidate', requestKey: 'candidate:a',
      input: { candidateId: 'a', provenance: { eventId: 'evt-a' } },
    });
    expect(() => operationDraftFromPlanRun(legacy, 'review-candidate')).toThrow(/requires dedupeKey/);
    expect(() => operationDraftFromPlanRun({ ...legacy, input: { provenance: 'x' }, dedupeKey: 'k' }, 'r'))
      .toThrow(/reserved provenance/);
  });

  it('replays one durable handle for the same request key and refuses the key with different input', async () => {
    const h = host();
    const seam = createPotAppSeam(h);
    const [first] = await seam.submitOperations([draft('candidate:a')]);
    const [replay] = await seam.submitOperations([draft('candidate:a')]);
    expect(replay).toEqual(first);
    expect(h.operations.size).toBe(1);
    await expect(seam.submitOperations([draft('candidate:a', { candidateId: 'b' })])).rejects.toThrow(/input_conflict/);
    expect(h.operations.size).toBe(1);
    await expect(seam.submitOperations([draft('x'.repeat(201))])).rejects.toThrow(/exceeds 200/);
  });

  it('lets ready output into the app only through its parse gate', async () => {
    const h = host();
    const seam = createPotAppSeam(h);
    const [handle] = await seam.submitOperations([draft('candidate:a')]);
    h.readBlueprintOperationResult = (same) => ({
      state: 'ready', status: statusOf(same), output: { candidateId: 'a', verdict: 'accepted' }, evidenceRef: 'plan-run:1',
    });
    const parse = (output: unknown) => {
      const o = output as { candidateId?: unknown; verdict?: unknown };
      if (typeof o.candidateId !== 'string' || (o.verdict !== 'accepted' && o.verdict !== 'rejected')) {
        throw new Error('not a review verdict');
      }
      return { candidateId: o.candidateId, verdict: o.verdict, parsed: true as const };
    };
    await expect(seam.operationResult(handle!, parse)).resolves.toMatchObject({
      state: 'ready', output: { candidateId: 'a', verdict: 'accepted', parsed: true },
    });
    // A ready output the app's parser rejects never reaches the caller.
    h.readBlueprintOperationResult = (same) => ({
      state: 'ready', status: statusOf(same), output: { candidateId: 'a', verdict: 'maybe' }, evidenceRef: 'plan-run:1',
    });
    const rejected = seam.operationResult(handle!, parse);
    await expect(rejected).rejects.toBeInstanceOf(OperationOutputRejectedError);
    await expect(rejected).rejects.toThrow(/parse gate: not a review verdict/);
    await expect(seam.operationResult(handle!, undefined as never)).rejects.toThrow(/requires the app parse gate/);
  });

  it('returns non-ready terminal results without invoking the parser, and refuses smuggled output', async () => {
    const h = host();
    const seam = createPotAppSeam(h);
    const [handle] = await seam.submitOperations([draft('candidate:a')]);
    let parsed = 0;
    const parse = (o: unknown) => { parsed += 1; return o; };
    h.readBlueprintOperationResult = (same) => ({
      state: 'failed', reason: 'agent failed', status: statusOf(same, { outcome: 'failed' }),
    });
    await expect(seam.operationResult(handle!, parse)).resolves.toMatchObject({ state: 'failed', reason: 'agent failed' });
    h.readBlueprintOperationResult = (same) => ({
      state: 'failed', reason: 'agent failed', output: { leak: true }, status: statusOf(same, { outcome: 'failed' }),
    } as never);
    await expect(seam.operationResult(handle!, parse)).rejects.toThrow(/must not carry output/);
    expect(parsed).toBe(0);
  });

  it('pages events with the caller cursor and limit, and bounds the limit', async () => {
    const h = host();
    const seam = createPotAppSeam(h);
    const [handle] = await seam.submitOperations([draft('candidate:a')]);
    const page = await seam.operationEvents(handle!, { cursor: '7', limit: 10 });
    expect(page).toMatchObject({ cursor: '1', hasMore: false, events: [{ kind: 'work-item', cursor: '1' }] });
    expect(h.eventCalls).toEqual([{ cursor: '7', limit: 10 }]);
    await seam.operationEvents(handle!);
    expect(h.eventCalls[1]).toEqual({});
    await expect(seam.operationEvents(handle!, { limit: 0 })).rejects.toThrow(/1\.\.100/);
  });

  it('keeps execution readiness separate from durable business review and applies the output parse gate to reviewer reads', async () => {
    const h = host();
    const seam = createPotAppSeam(h);
    const [handle] = await seam.submitOperations([draft('reviewable')]);
    const seen: unknown[] = [];
    const businessReview = { state: 'pending' as const, accountableOwner: 'support-lead', resultFingerprint: 'b'.repeat(64) };
    h.readBlueprintOperationResult = (same, options) => {
      seen.push(options);
      return { state: 'ready', status: statusOf(same), output: { summary: 'Cited case' }, evidenceRef: 'work-item:1', businessReview };
    };
    const result = await seam.operationResult(handle!, (raw) => ({ summary: (raw as { summary: string }).summary }), { review: true });
    expect(result).toMatchObject({ state: 'ready', businessReview: { state: 'pending' }, output: { summary: 'Cited case' } });
    expect(seen).toEqual([{ review: true }]);
    await expect(seam.operationResult(handle!, () => { throw new Error('uncited result'); }, { review: true }))
      .rejects.toBeInstanceOf(OperationOutputRejectedError);
    await seam.operationEvents(handle!, { review: true, cursor: '12' });
    expect(h.eventCalls).toEqual([{ review: true, cursor: '12' }]);
  });

  it.each(['accepted', 'rejected', 'rework'] as const)('preserves the %s reviewer decision and its evidence', async (state) => {
    const h = host();
    const seam = createPotAppSeam(h);
    const [handle] = await seam.submitOperations([draft(state)]);
    const businessReview = { state, accountableOwner: 'support-lead', resultFingerprint: 'b'.repeat(64),
      decision: { eventId: '19', reviewerPrincipal: 'reviewer', reason: 'Compared the cited case', at: '2026-10-15T00:00:00Z' } };
    h.readBlueprintOperationResult = (same) => ({ state: 'ready', status: statusOf(same), output: {}, evidenceRef: 'work-item:1', businessReview });
    expect(await seam.operationResult(handle!, (raw) => raw)).toMatchObject({ businessReview });
  });

  it('refuses missing decision evidence, malformed fingerprints, cancelled results and review smuggling before parsing output', async () => {
    const h = host();
    const seam = createPotAppSeam(h);
    const [handle] = await seam.submitOperations([draft('malformed')]);
    const review = { state: 'accepted', accountableOwner: 'lead', resultFingerprint: 'b'.repeat(64),
      decision: { eventId: '19', reviewerPrincipal: 'reviewer', reason: 'Checked', at: '2026-10-15T00:00:00Z' } };
    let parses = 0;
    for (const businessReview of [{ ...review, decision: undefined }, { ...review, state: 'pending' },
      { ...review, resultFingerprint: 'bad' }, { ...review, accountableOwner: '' },
      { ...review, decision: { ...review.decision, reviewerPrincipal: '' } },
      { ...review, decision: { ...review.decision, at: 'not a date' } }]) {
      h.readBlueprintOperationResult = (same) => ({ state: 'ready', status: statusOf(same), output: {},
        evidenceRef: 'work-item:1', businessReview } as never);
      await expect(seam.operationResult(handle!, () => { parses++; })).rejects.toThrow(/business review/);
    }
    h.readBlueprintOperationResult = (same) => ({ state: 'ready', status: statusOf(same, { cancellationRequested: true }),
      output: {}, evidenceRef: 'work-item:1', businessReview: review } as never);
    await expect(seam.operationResult(handle!, () => { parses++; })).rejects.toThrow(/validated successful result/);
    h.readBlueprintOperationResult = (same) => ({ state: 'pending', status: statusOf(same), businessReview: review } as never);
    await expect(seam.operationResult(handle!, () => { parses++; })).rejects.toThrow(/must not carry business review/);
    expect(parses).toBe(0);
  });

  it('records a review using the canonical signal and does not turn the receipt into a business outcome', async () => {
    const calls: unknown[] = [];
    const h = host();
    h.signalBlueprintOperation = (handle, input) => {
      calls.push({ handle, input });
      return { eventId: '19', replayed: false, accepted: true, wakeQueued: false, handled: false };
    };
    const seam = createPotAppSeam(h);
    const [handle] = await seam.submitOperations([draft('review')]);
    const input = { decision: 'accept' as const, reason: ' Checked citations ', resultFingerprint: 'b'.repeat(64), requestKey: 'decision:1' };
    expect(await seam.reviewOperation(handle!, input)).toEqual({ eventId: '19', replayed: false, accepted: true, wakeQueued: false, handled: false });
    expect(calls).toEqual([{ handle, input: { channel: 'business-review', requestKey: 'decision:1',
      payload: { decision: 'accept', reason: 'Checked citations', resultFingerprint: input.resultFingerprint } } }]);
    for (const bad of [{ ...input, decision: 'approve' }, { ...input, reason: ' ' },
      { ...input, resultFingerprint: 'old' }, { ...input, requestKey: '' }, { ...input, requestKey: 'x'.repeat(201) }]) {
      await expect(seam.reviewOperation(handle!, bad as typeof input)).rejects.toThrow();
    }
    expect(calls).toHaveLength(1);
    h.signalBlueprintOperation = () => ({ eventId: '', accepted: true } as never);
    await expect(seam.reviewOperation(handle!, input)).rejects.toThrow(/canonical input receipt/);
    delete h.signalBlueprintOperation;
    await expect(seam.reviewOperation(handle!, input)).rejects.toThrow(/not connected/);
  });

  it('cancels through the handle with an idempotent request key and a required reason', async () => {
    const h = host();
    const seam = createPotAppSeam(h);
    const [handle] = await seam.submitOperations([draft('candidate:a')]);
    const first = await seam.cancelOperation(handle!, { requestKey: 'cancel:a', reason: 'candidate withdrew' });
    expect(first).toMatchObject({ accepted: true, handled: false, replayed: false });
    expect(await seam.cancelOperation(handle!, { requestKey: 'cancel:a', reason: 'candidate withdrew' }))
      .toMatchObject({ eventId: first.eventId, replayed: true });
    await expect(seam.cancelOperation(handle!, { requestKey: 'cancel:b', reason: ' ' })).rejects.toThrow(/cancel.reason/);
    h.cancelBlueprintOperation = () => ({ accepted: false } as never);
    await expect(seam.cancelOperation(handle!, { requestKey: 'cancel:c', reason: 'r' })).rejects.toThrow(/not accepted/);
  });

  it('refuses status, result and events reads that drift to a different durable target', async () => {
    const h = host();
    const seam = createPotAppSeam(h);
    const [handle] = await seam.submitOperations([draft('candidate:a')]);
    const drifted: BlueprintOperationHandle = { ...handle!, target: { kind: 'work-item', id: 'WI-999' } };
    h.readBlueprintOperationStatus = () => statusOf(drifted);
    await expect(seam.operationStatus(handle!)).rejects.toThrow(/status returned a different durable handle/);
    h.readBlueprintOperationResult = () => ({ state: 'pending', status: statusOf(drifted) });
    await expect(seam.operationResult(handle!, (o) => o)).rejects.toThrow(/result returned a different durable handle/);
    h.readBlueprintOperationEvents = () => ({ status: statusOf(drifted), events: [], cursor: '0', hasMore: false });
    await expect(seam.operationEvents(handle!)).rejects.toThrow(/events returned a different durable handle/);
  });

  it('parses and stores ingest events with resumable cursors', async () => {
    const seam = createPotAppSeam(host());
    const stored: Array<{ text: string; cursor: string }> = [];
    const sub = seam.startIngestLoop({
      source: events([{ id: 'evt-1', payload: { text: 'accepted' } }]),
      parse: (event) => (event.payload as { text: string }).text.toUpperCase(),
      store: (text, cursor) => {
        stored.push({ text, cursor: cursor.eventId });
      },
    });
    await sub.done;
    expect(stored).toEqual([{ text: 'ACCEPTED', cursor: 'evt-1' }]);
  });

  it('fails fast on invalid pot and operation boundaries', async () => {
    const seam = createPotAppSeam(host());
    await expect(seam.bootstrapPots({ pots: [] })).rejects.toThrow(/at least one/);
    await expect(seam.bootstrapPots({ pots: [{ slug: '' }] })).rejects.toThrow(/pot.slug/);
    await expect(seam.submitOperations([{ ...draft('k'), operationId: '' }])).rejects.toThrow(/operation.operationId/);
    await expect(seam.submitOperations([draft(' ')])).rejects.toThrow(/operation.requestKey/);
  });
});

describe('deriveRequestKey', () => {
  it('is a pure function of the domain identity, encoded so separators cannot collide', () => {
    expect(deriveRequestKey('draft-reply', 'mbx-1', 'thr-1')).toBe('draft-reply:mbx-1:thr-1');
    expect(deriveRequestKey('draft-reply', 'mbx-1', 'thr-1')).toBe(deriveRequestKey('draft-reply', 'mbx-1', 'thr-1'));
    expect(deriveRequestKey('op', 'a:b', 'c')).not.toBe(deriveRequestKey('op', 'a', 'b:c'));
    expect(() => deriveRequestKey('op')).toThrow(/at least one domain part/);
    expect(() => deriveRequestKey('op', 'a', '')).toThrow(/domain part 1/);
    expect(() => deriveRequestKey('op', 'x'.repeat(200))).toThrow(/bound is 200/);
  });
});

describe('blueprintOperationHostFromInvoker', () => {
  const handle: BlueprintOperationHandle = {
    workspaceId: 'w', harnessSlug: 'email', receiptId: 3, operationId: 'draft-reply',
    specificationRevision: 'a'.repeat(64), target: { kind: 'work-item', id: 'WI-3' },
  };

  it('calls the public blueprint:* tools with the contract argument shapes', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const replies: Record<string, unknown> = {
      'blueprint:submit': { handle },
      'blueprint:status': statusOf(handle),
      'blueprint:result': { state: 'pending', status: statusOf(handle) },
      'blueprint:events': { status: statusOf(handle), events: [], cursor: '0', hasMore: false },
      'blueprint:cancel': { eventId: 'e', replayed: false, accepted: true, wakeQueued: true, handled: false, effected: false },
    };
    const h = blueprintOperationHostFromInvoker(async (name, args) => {
      calls.push([name, args]);
      return replies[name];
    });
    expect(await h.submitBlueprintOperation({ harnessSlug: 'email', operationId: 'draft-reply', requestKey: 'k',
      input: { threadId: 't' }, title: 'Draft' })).toEqual(handle);
    await h.readBlueprintOperationStatus(handle);
    await h.readBlueprintOperationResult(handle);
    await h.readBlueprintOperationEvents(handle, { cursor: '4' });
    await h.cancelBlueprintOperation(handle, { requestKey: 'c', reason: 'r' });
    expect(calls).toEqual([
      ['blueprint:submit', { harness: 'email', operationId: 'draft-reply', requestKey: 'k', input: { threadId: 't' }, title: 'Draft' }],
      ['blueprint:status', { handle }],
      ['blueprint:result', { handle }],
      ['blueprint:events', { handle, cursor: '4' }],
      ['blueprint:cancel', { handle, requestKey: 'c', reason: 'r' }],
    ]);
    expect(Object.values(BLUEPRINT_OPERATION_TOOL_NAMES)).toEqual(expect.arrayContaining(calls.map(([n]) => n)));
  });

  it('forwards the displayed approved revision without selecting another workflow', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const h = blueprintOperationHostFromInvoker(async (_name, args) => {
      calls.push(args);
      return { handle };
    });
    await h.submitBlueprintOperation({ harnessSlug: 'email', operationId: 'draft-reply', requestKey: 'approved',
      input: {}, expectedSpecificationRevision: 'a'.repeat(64) });
    expect(calls[0]).toMatchObject({ harness: 'email', operationId: 'draft-reply',
      expectedSpecificationRevision: 'a'.repeat(64) });
  });

  it('forwards privateInput to blueprint:submit only when the draft carries it (D-014)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const h = blueprintOperationHostFromInvoker(async (_name, args) => {
      calls.push(args);
      return { handle };
    });
    const segments = [[1, 'agent', 'hi'], [2, 'guest', 'bye']];
    await h.submitBlueprintOperation({ harnessSlug: 'phone', operationId: 'call-wrap-up', requestKey: 'k1',
      input: { callKey: 'c' }, privateInput: segments });
    await h.submitBlueprintOperation({ harnessSlug: 'phone', operationId: 'call-brief', requestKey: 'k2',
      input: { callKey: 'c' } });
    expect(calls[0]).toEqual({ harness: 'phone', operationId: 'call-wrap-up', requestKey: 'k1',
      input: { callKey: 'c' }, privateInput: segments });
    expect(calls[1]).not.toHaveProperty('privateInput');
  });

  it('forwards reviewer mode and the existing review signal without accepting a client-supplied identity', async () => {
    const calls: unknown[] = [];
    const h = blueprintOperationHostFromInvoker(async (name, args) => {
      calls.push([name, args]);
      if (name === 'blueprint:signal') return { eventId: '19', accepted: true, handled: false, replayed: false, wakeQueued: false };
      if (name === 'blueprint:events') return { status: statusOf(handle), events: [], cursor: '0', hasMore: false };
      return { state: 'pending', status: statusOf(handle) };
    });
    await h.readBlueprintOperationResult(handle, { review: true });
    await h.readBlueprintOperationEvents(handle, { review: true, cursor: '4' });
    await h.signalBlueprintOperation!(handle, { channel: 'business-review', requestKey: 'review:1',
      payload: { decision: 'rework', reason: 'Missing steps', resultFingerprint: 'b'.repeat(64) } });
    expect(calls).toEqual([
      ['blueprint:result', { handle, review: true }],
      ['blueprint:events', { handle, review: true, cursor: '4' }],
      ['blueprint:signal', { handle, channel: 'business-review', requestKey: 'review:1',
        payload: { decision: 'rework', reason: 'Missing steps', resultFingerprint: 'b'.repeat(64) } }],
    ]);
  });

  it('refuses a malformed tool result instead of passing it to the app', async () => {
    const h = blueprintOperationHostFromInvoker(async () => ({ ok: true }));
    await expect(h.submitBlueprintOperation({ harnessSlug: 'email', operationId: 'o', requestKey: 'k', input: {} }))
      .rejects.toThrow(/blueprint:submit result is missing handle/);
    await expect(h.cancelBlueprintOperation(handle, { requestKey: 'c', reason: 'r' })).rejects.toThrow(/missing eventId/);
    const refusing = blueprintOperationHostFromInvoker(async () => {
      throw new Error('input_conflict');
    });
    await expect(refusing.readBlueprintOperationStatus(handle)).rejects.toThrow(/input_conflict/);
  });
});
