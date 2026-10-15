/**
 * RSR-P-008-B (review-system-rework-reduction-2026-09-23): coord:send delivers a
 * body over the delivery cap in full, as chunks. Falsifier: "the recipient
 * receives a truncated body". Probe: send an over-cap body and reassemble the
 * delivered chunks. The handler-level half of the probe lives in send.test.ts;
 * this file pins the pure contract the handler relies on.
 */
import { describe, expect, it } from 'vitest';

import { sectionsToText, type MessageSection } from '../message-fields';
import { COORD_SEND_MAX_CHUNK_PARTS, DEFAULT_INBOX_BODY_CAP } from './inbox-content-bounds';
import {
  chunkContentBudget,
  chunkHeaderText,
  chunkOverCapMessage,
  reassembleChunkedBodies,
  splitTextForChunks,
  type ChunkableMessage,
} from './send-chunking';

type Msg = ChunkableMessage & Record<string, unknown>;

const baseMessage = (body: MessageSection[], extra: Record<string, unknown> = {}): Msg => ({
  to: ['bee-1'],
  summary: 'the headline',
  expects: 'action',
  body,
  ...extra,
});

/** The probe: every delivered part fits the cap, and reassembly returns the
 *  authored sections exactly. Extracted so the SAME predicate also runs against
 *  a deliberately wrong chunker below. */
function assertDeliveredInFull(authored: MessageSection[], partBodies: MessageSection[][]): void {
  for (const body of partBodies) expect(sectionsToText(body).length).toBeLessThanOrEqual(DEFAULT_INBOX_BODY_CAP);
  expect(reassembleChunkedBodies(partBodies)).toEqual(authored);
}

function chunkedBodies(msg: Msg): MessageSection[][] {
  const plan = chunkOverCapMessage(msg);
  if (plan.kind !== 'chunked') throw new Error(`expected chunked, got ${plan.kind}`);
  return plan.parts.map((part) => part.message.body as MessageSection[]);
}

describe('chunkOverCapMessage (RSR-P-008-B)', () => {
  it('leaves a body at the cap untouched, as one message', () => {
    const msg = baseMessage([{ text: 'x'.repeat(DEFAULT_INBOX_BODY_CAP) }]);
    expect(chunkOverCapMessage(msg)).toEqual({ kind: 'single', message: msg });
  });

  it('delivers one long section in full: every part fits the cap, reassembly is exact', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} explains one more detail.`).join(' ');
    const authored: MessageSection[] = [{ text, forYouBecause: { relation: 'owns', ref: 'WI-1' }, premises: ['WI-1'] }];
    const bodies = chunkedBodies(baseMessage(authored));
    expect(bodies.length).toBeGreaterThan(1);
    assertDeliveredInFull(authored, bodies);
  });

  it('delivers many sections in full, keeping each section’s metadata', () => {
    const authored: MessageSection[] = Array.from({ length: 7 }, (_, i) => ({
      text: `Section ${i}: ${'body text '.repeat(25 + i * 7)}`,
      ...(i % 2 ? { premises: [`WI-${i}`] } : {}),
      ...(i === 3 ? { couldNotDetermine: [{ what: 'whether the fix is deployed' }] } : {}),
    }));
    assertDeliveredInFull(authored, chunkedBodies(baseMessage(authored)));
  });

  it('never splits a UTF-16 surrogate pair across parts', () => {
    const authored: MessageSection[] = [{ text: '😀'.repeat(900) }];
    const bodies = chunkedBodies(baseMessage(authored, { expects: 'none' }));
    for (const body of bodies) {
      for (const section of body.slice(1)) {
        const first = section.text.charCodeAt(0);
        expect(first >= 0xdc00 && first <= 0xdfff, 'a part begins with a low surrogate').toBe(false);
      }
    }
    assertDeliveredInFull(authored, bodies);
  });

  it('puts the ask on the final part only; continuations route identically but carry no ask', () => {
    const authored: MessageSection[] = [
      { text: 'y'.repeat(DEFAULT_INBOX_BODY_CAP * 2), forYouBecause: { relation: 'owns', ref: 'WI-9' } },
    ];
    const msg = baseMessage(authored, {
      wake: 'required',
      related_msg_id: 'msg-parent',
      blocking: true,
      harness: 'papercusp',
      plan_slug: 'some-plan',
      noBodyRefs: true,
    });
    const plan = chunkOverCapMessage(msg);
    if (plan.kind !== 'chunked') throw new Error('expected chunked');
    const { parts } = plan;
    const final = parts[parts.length - 1].message as Msg;
    expect(final).toMatchObject({ expects: 'action', wake: 'required', related_msg_id: 'msg-parent', blocking: true });
    // The ask's forYouBecause must be on the message that carries the ask.
    expect((final.body as MessageSection[]).some((section) => section.forYouBecause)).toBe(true);
    for (const { message, meta } of parts.slice(0, -1)) {
      const continuation = message as Msg;
      expect(continuation.expects).toBe('none');
      expect(continuation.wake).toBeUndefined();
      expect(continuation.related_msg_id).toBeUndefined();
      expect(continuation.recipientAuthRelatedMsgId).toBe('msg-parent');
      expect(continuation.blocking).toBeUndefined();
      expect(continuation).toMatchObject({ to: ['bee-1'], harness: 'papercusp', plan_slug: 'some-plan', noBodyRefs: true });
      expect(continuation.summary).toBe(`the headline (part ${meta.part}/${meta.of})`);
    }
    expect(new Set(parts.map((part) => part.meta.group)).size).toBe(1);
  });

  it('packs exactly the documented number of full parts, and refuses one more', () => {
    const full = 'z'.repeat(chunkContentBudget());
    const fits = chunkOverCapMessage(
      baseMessage(Array.from({ length: COORD_SEND_MAX_CHUNK_PARTS }, () => ({ text: full }))),
    );
    expect(fits.kind).toBe('chunked');
    if (fits.kind === 'chunked') expect(fits.parts).toHaveLength(COORD_SEND_MAX_CHUNK_PARTS);

    const tooMany = chunkOverCapMessage(
      baseMessage(Array.from({ length: COORD_SEND_MAX_CHUNK_PARTS + 1 }, () => ({ text: full }))),
    );
    expect(tooMany).toMatchObject({ kind: 'refused', error: 'body_exceeds_chunk_limit' });
    if (tooMany.kind === 'refused') {
      expect(tooMany.partsNeeded).toBe(COORD_SEND_MAX_CHUNK_PARTS + 1);
      expect(tooMany.message).toMatch(/Nothing was sent/);
    }
  });

  it('is deterministic, so an idempotent retry re-derives the same parts', () => {
    const msg = baseMessage([{ text: 'q '.repeat(800) }]);
    expect(chunkOverCapMessage(msg)).toEqual(chunkOverCapMessage(msg));
  });
});

describe('reassembleChunkedBodies', () => {
  it('reassembles parts delivered out of order', () => {
    const authored: MessageSection[] = [{ text: 'w'.repeat(DEFAULT_INBOX_BODY_CAP * 3) }];
    const bodies = chunkedBodies(baseMessage(authored));
    expect(reassembleChunkedBodies([...bodies].reverse())).toEqual(authored);
  });

  it('refuses to present an incomplete message as whole', () => {
    const bodies = chunkedBodies(baseMessage([{ text: 'w'.repeat(DEFAULT_INBOX_BODY_CAP * 3) }]));
    expect(() => reassembleChunkedBodies(bodies.slice(1))).toThrow(/expected parts/);
  });
});

describe('splitTextForChunks', () => {
  it('prefers a paragraph break and keeps the concatenation exact', () => {
    const text = `${'a'.repeat(300)}\n\n${'b'.repeat(300)}`;
    const slices = splitTextForChunks(text, 400);
    expect(slices).toEqual([`${'a'.repeat(300)}\n\n`, 'b'.repeat(300)]);
    expect(slices.join('')).toBe(text);
  });
});

describe('falsifiability control — the probe catches a chunker that loses content', () => {
  // Kept PERMANENTLY in the test file (never a mutation of production code on
  // this swept tree). Each wrong chunker is a plausible regression.
  const authored: MessageSection[] = [{ text: `${'k'.repeat(700)}\n\n${'m'.repeat(700)}` }];

  it('CALIBRATION — the real chunker passes the probe', () => {
    expect(() => assertDeliveredInFull(authored, chunkedBodies(baseMessage(authored)))).not.toThrow();
  });

  it('WRONG #1 — clipping to the cap (the pre-fix lossy send) is caught', () => {
    const clipped = [[{ text: chunkHeaderText(1, 1, 'deadbeef', false) }, { text: authored[0].text.slice(0, 500) }]];
    expect(() => assertDeliveredInFull(authored, clipped)).toThrow();
  });

  it('WRONG #2 — splitting without the continuation flag is caught', () => {
    const real = chunkedBodies(baseMessage(authored));
    const unflagged = real.map((body, index) => [
      { text: chunkHeaderText(index + 1, real.length, 'deadbeef', false) },
      ...body.slice(1),
    ]);
    expect(() => assertDeliveredInFull(authored, unflagged)).toThrow();
  });
});
