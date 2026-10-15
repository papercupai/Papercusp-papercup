/**
 * end-user-intake.test.ts — the in-app report door classifies a person's text and
 * routes it through the ONE intake (captureImprovement) or, for a note, to memory
 * (unified-bug-pipeline-and-honest-queue-2026-10-05 P-011, D-046 pt 4).
 */
import { describe, expect, it, vi } from 'vitest';
import type { CaptureImprovementInput, CaptureImprovementResult } from './capture-core';
import { ANONYMOUS_END_USER_FILER, classifyEndUserReport, intakeEndUserReport, type EndUserIntakeDeps } from './end-user-intake';
import { END_USER_NOTE_HEADER, isQuotedEndUserText } from './untrusted-evidence';

function deps() {
  const capture = vi.fn(async (_input: CaptureImprovementInput) => ({ ok: true, created: true, possibleDuplicates: [] }) as unknown as CaptureImprovementResult);
  const rememberNote = vi.fn(async (_content: string, _opts: { scope: string; metadata: Record<string, unknown> }) => ['mem-1']);
  return { capture, rememberNote, all: { capture, rememberNote } satisfies EndUserIntakeDeps };
}

describe('classifyEndUserReport', () => {
  it.each([
    ['The board crashes when I open a card', 'bug', 'defect-cue'],
    ["Saving doesn't work since the update", 'bug', 'defect-cue'],
    ['FYI the export is broken', 'bug', 'defect-cue'],
    ['It would be nice to have a dark theme', 'idea', 'idea-cue'],
    ['Could you add keyboard shortcuts for the board?', 'idea', 'idea-cue'],
    ['Note: I plan my sprints on the board every Monday', 'note', 'explicit-note'],
    ['Remember that I prefer the compact layout', 'note', 'explicit-note'],
    ['the sidebar', 'bug', 'ambiguous'],
  ] as const)('%s -> %s', (text, kind, basis) => {
    expect(classifyEndUserReport(text)).toEqual({ kind, basis });
  });

  it('treats any report carrying recent errors as a bug, whatever the wording', () => {
    expect(classifyEndUserReport('Note: I prefer the compact layout', { recentErrors: [{ message: 'TypeError: x is undefined' }] })).toEqual({
      kind: 'bug',
      basis: 'recent-errors',
    });
  });
});

describe('intakeEndUserReport', () => {
  it.each([undefined, null, '   '])('attributes an anonymous filing to the door for independent verification (%s)', async (reporterId) => {
    const d = deps();
    await intakeEndUserReport({ text: 'Export crashes', reporterId }, d.all);
    const input = d.capture.mock.calls[0]?.[0];
    expect(input).toMatchObject({ createdBy: ANONYMOUS_END_USER_FILER, reporterKind: 'end-user' });
    expect(input?.payloadExtra).not.toHaveProperty('contact');
    expect(input?.payloadExtra).not.toHaveProperty('reporterId');
  });

  it('files a bug through the one intake as an end-user report with its captured context', async () => {
    const d = deps();
    const reportContext = { appVersion: '0.9.3', recentErrors: [{ message: 'TypeError: cannot read properties of undefined', source: 'renderer' }] };
    const result = await intakeEndUserReport(
      { text: 'Opening a card shows a blank panel\nsteps: open any card', reporterId: 'user-7', reportContext, scope: 'harness:board' },
      d.all,
    );

    expect(result.routed).toBe('work-item');
    expect(d.rememberNote).not.toHaveBeenCalled();
    expect(d.capture).toHaveBeenCalledTimes(1);
    expect(d.capture.mock.calls[0]?.[0]).toMatchObject({
      title: 'Opening a card shows a blank panel',
      kind: 'bug',
      reporterKind: 'end-user',
      sourceRole: 'human',
      reportContext,
      createdBy: 'user-7',
      scope: 'harness:board',
      payloadExtra: { endUserIntake: { classification: 'recent-errors' } },
    });
  });

  it('files a report with no scope under the platform Pot, where agents file the same defect', async () => {
    const d = deps();
    await intakeEndUserReport({ text: 'The export button crashes the app' }, d.all);
    expect(d.capture.mock.calls[0]?.[0]).toMatchObject({ scope: 'harness:papercusp' });
  });

  it('files an idea as a feature candidate', async () => {
    const d = deps();
    await intakeEndUserReport({ text: 'It would be great if the board could show due dates' }, d.all);
    expect(d.capture.mock.calls[0]?.[0]).toMatchObject({ kind: 'feature', reporterKind: 'end-user' });
  });

  it('stores a note in memory as quoted, redacted, untrusted text and files no work item', async () => {
    const d = deps();
    const result = await intakeEndUserReport(
      { text: 'Note: I paste "api_key=abcd1234efgh5678" into the settings', scope: 'harness:board', reporterId: 'user-7' },
      d.all,
    );

    expect(result).toMatchObject({ routed: 'memory', scope: 'harness:board', memoryIds: ['mem-1'] });
    expect(d.capture).not.toHaveBeenCalled();
    const [content, opts] = d.rememberNote.mock.calls[0]!;
    // P-013: the note is a quoted-evidence block — the fixed header, then every line quoted.
    expect(isQuotedEndUserText(content)).toBe(true);
    expect(content.startsWith(`${END_USER_NOTE_HEADER}\n\n> `)).toBe(true);
    expect(content).not.toContain('abcd1234efgh5678');
    expect(content).toContain('[redacted]');
    expect(opts.metadata).toMatchObject({ source: 'end-user-report', untrusted: true, reporterId: 'user-7' });
  });

  it('files a note as a bug rather than dropping it when there is no memory pool to hold it', async () => {
    const d = deps();
    const result = await intakeEndUserReport({ text: 'FYI: I use the compact layout' }, d.all);
    expect(result.routed).toBe('work-item');
    expect(result.classification).toEqual({ kind: 'bug', basis: 'ambiguous' });
    expect(d.rememberNote).not.toHaveBeenCalled();
    expect(d.capture.mock.calls[0]?.[0]).toMatchObject({ kind: 'bug', title: 'I use the compact layout' });
  });

  it('refuses an empty report', async () => {
    const d = deps();
    await expect(intakeEndUserReport({ text: '   ' }, d.all)).rejects.toThrow(/needs text/);
    expect(d.capture).not.toHaveBeenCalled();
  });
});
