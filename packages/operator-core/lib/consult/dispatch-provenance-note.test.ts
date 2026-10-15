import { describe, expect, it } from 'vitest';
import { renderDispatchProvenanceNote } from './get-feedback-core';

// D-002 + consult-backed-parking-2026-10-12 P-002 / D-008: the requester-facing
// note must say HOW the answer was produced, and a cited-turn brief must never
// be described as the expert's own (forked/converted) session.
const base = {
  sourceOwnerId: 'su-expert',
  answeringOwnerId: 'su-answer',
  agent: 'codex',
  model: 'sol',
  verified: true,
  detail: 'launched',
} as const;

describe('renderDispatchProvenanceNote', () => {
  it('is empty when no answering session was launched', () => {
    expect(renderDispatchProvenanceNote(undefined)).toBe('');
    expect(renderDispatchProvenanceNote(null)).toBe('');
  });

  it('describes a brief as a fresh session holding only quoted turns, never the expert session', () => {
    const note = renderDispatchProvenanceNote({ ...base, operation: 'brief' });
    expect(note).toContain('launched a FRESH session on codex/sol as su-answer');
    expect(note).toContain("briefed with turns cited from su-expert's transcript (live)");
    expect(note).toContain('holds only those quoted turns, not their session');
    expect(note).not.toMatch(/FORKED|CONVERTED/);
    expect(note).not.toContain("su-expert's session onto");
  });

  it('marks a brief that has not confirmed pickup as booting', () => {
    const note = renderDispatchProvenanceNote({ ...base, operation: 'brief', verified: null });
    expect(note).toContain('(booting — the cascade expiry guards the reply)');
  });

  it.each([
    ['convert', 'CONVERTED'],
    ['fork', 'FORKED'],
  ] as const)('keeps the %s wording for session-reusing launches', (operation, word) => {
    const note = renderDispatchProvenanceNote({ ...base, operation });
    expect(note).toContain(`${word} su-expert's session onto codex/sol as su-answer (live)`);
    expect(note).toContain('The answer reasons over their transcript');
    expect(note).not.toContain('FRESH session');
  });

  it('omits the answering id on a fork that answers as the source owner', () => {
    const note = renderDispatchProvenanceNote({ ...base, operation: 'fork', answeringOwnerId: 'su-expert' });
    expect(note).not.toContain(' as su-expert');
  });
});
