/**
 * The store-vs-render drift guard (EI-20637908167729753).
 *
 * The bug this pins: the ingest store capped transcript parts at 2,000 chars
 * while the pane that renders them budgeted 8,000, so every prose part in
 * between was destroyed at ingest — 16.9% of the whole store — and a 7,051-char
 * report written for the owner rendered with 5,051 chars missing. Nothing
 * failed; a COMMENT claimed the two agreed, and comments do not hold invariants.
 *
 * These tests are deliberately BEHAVIOURAL. Asserting
 * `PART_TEXT_CAP_PROSE === TRANSCRIPT_RENDER_TEXT_CAP` would pass against two
 * independently-hardcoded 8000s — which is precisely the state that produced
 * the bug. So instead each test drives the REAL ingest cleaner with a body
 * sized from the RENDER cap and asserts the reader gets it, which can only hold
 * while the two are genuinely wired together.
 */
import { describe, it, expect } from 'vitest';
import { cleanPartText } from './search/session-ingest';
import { capEntryText, THINKING_ENTRY_TEXT_CAP } from './owner-sessions/transcript';
import {
  TRANSCRIPT_RENDER_TEXT_CAP,
  TRUNCATION_MARKER_POSIX_RE,
  partTextCapFor,
  truncationMarker,
} from './transcript-text-caps';

/** Matches what the ingest cleaner and the render capper both stamp. */
const MARKER = /… \[truncated \d+ chars\]$/;

describe('store cap vs render budget — the drift guard', () => {
  it('stores a prose part the pane has room for, WITHOUT truncating it', () => {
    // The regression, expressed exactly: a body under the render budget must
    // survive ingest whole. At the old 2,000 store cap this text came back
    // stamped with a truncation marker despite the pane having room for it.
    const body = 'x'.repeat(TRANSCRIPT_RENDER_TEXT_CAP - 1);
    const stored = cleanPartText(body, 'text');
    expect(stored).not.toMatch(MARKER);
    expect(stored).toBe(body);
  });

  it('round-trips a prose part through ingest AND render with nothing lost', () => {
    // The end-to-end property the owner actually cares about: what the agent
    // wrote is what the pane shows.
    const body = 'y'.repeat(TRANSCRIPT_RENDER_TEXT_CAP - 1);
    const rendered = capEntryText({ kind: 'text', text: cleanPartText(body, 'text') });
    expect(rendered.text).toBe(body);
  });

  it('covers the real-world case that exposed the bug (a 7,051-char report)', () => {
    const audit = 'z'.repeat(7051);
    expect(cleanPartText(audit, 'text')).toBe(audit);
    expect(capEntryText({ kind: 'text', text: audit }).text).toBe(audit);
  });

  it('keeps thinking parts at the prose cap too — they are prose a human reads', () => {
    const body = 'w'.repeat(TRANSCRIPT_RENDER_TEXT_CAP - 1);
    expect(cleanPartText(body, 'thinking')).toBe(body);
  });

  it('the store is never NARROWER than the pane, for any part kind', () => {
    // Stated as the general invariant: whatever the pane will render, some
    // store cap must be able to hold — otherwise a reader loses text no one
    // ever decided to drop. Tool kinds may be tighter (see below), but the
    // prose path must reach the budget.
    expect(partTextCapFor('text')).toBeGreaterThanOrEqual(THINKING_ENTRY_TEXT_CAP);
    expect(partTextCapFor('thinking')).toBeGreaterThanOrEqual(THINKING_ENTRY_TEXT_CAP);
  });

  it('the render alias is the canonical cap, not a second copy of the number', () => {
    expect(THINKING_ENTRY_TEXT_CAP).toBe(TRANSCRIPT_RENDER_TEXT_CAP);
  });
});

describe('tool payloads stay tighter — deliberately, and detectably', () => {
  it('truncates an oversized tool_result rather than storing 218 MB of them', () => {
    const big = 'q'.repeat(partTextCapFor('tool_result') + 500);
    const stored = cleanPartText(big, 'tool_result');
    expect(stored).toMatch(MARKER);
    expect(stored).toContain(truncationMarker(500));
  });

  it('is tighter than prose, so the volume saving is real', () => {
    expect(partTextCapFor('tool_result')).toBeLessThan(partTextCapFor('text'));
    expect(partTextCapFor('tool_use')).toBeLessThan(partTextCapFor('text'));
  });

  it('leaves a marker the store-truncation SQL can actually find', () => {
    // The fallback that rescues these rows keys off this marker from SQL, so
    // the regex and the writer must agree. Checked here because they are used
    // in different languages and could otherwise drift silently — the exact
    // failure mode this whole file exists to prevent.
    const stored = cleanPartText('r'.repeat(partTextCapFor('tool_result') + 42), 'tool_result');
    expect(new RegExp(TRUNCATION_MARKER_POSIX_RE.replace('[0-9]+', '\\d+')).test(stored)).toBe(true);
    // ...and a row the pane could render in full must NOT be flagged, or every
    // read would abandon the DB path for no gain.
    expect(stored.length).toBeLessThan(TRANSCRIPT_RENDER_TEXT_CAP);
  });
});

describe('cleanPartText defaults', () => {
  it('defaults to the PROSE cap — the safe direction to be wrong in', () => {
    // An over-wide store costs bytes; an over-narrow one destroys a reader's
    // content irrecoverably. A caller that forgets the kind gets the former.
    const body = 'p'.repeat(TRANSCRIPT_RENDER_TEXT_CAP - 1);
    expect(cleanPartText(body)).toBe(body);
  });
});
