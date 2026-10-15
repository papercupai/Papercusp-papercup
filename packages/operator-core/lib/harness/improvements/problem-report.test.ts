/**
 * problem-report.test.ts — SPEC-P-014: the Report a problem dialog shows the
 * user exactly what will be sent before consent (D-048 pt 3). The preview is
 * the payload, and the digest binds the two.
 */
import { describe, expect, it } from 'vitest';
import {
  PROBLEM_REPORT_LIMITS,
  buildProblemReport,
  canonicalJson,
  isNormalizedProblemReport,
  previewDigest,
  type ProblemReportPayload,
} from './problem-report';

const SECRET = `token=${'q'.repeat(30)}`;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=';

function draft(overrides: Partial<Parameters<typeof buildProblemReport>[0]> = {}) {
  return buildProblemReport({
    text: 'The board goes blank after I drag a card',
    appVersion: '0.9.3 (abc1234)',
    route: '/harness/papercusp/board',
    search: '?view=kanban&report=1&card=WI-1',
    recentErrors: [{ at: '2026-10-06T21:00:00.000Z', source: 'window.error', message: 'TypeError: x is undefined' }],
    ...overrides,
  });
}

describe('buildProblemReport', () => {
  it('keeps a captured screenshot off the wire until explicitly attached', () => {
    expect(draft({ screenshotDataUrl: PNG }).attachments).toEqual([]);
    const p = draft({ screenshotDataUrl: PNG, attachScreenshot: true, attachLog: true, logLines: ['failed'] });
    expect(p.attachments.map((attachment) => attachment.kind)).toEqual(['log', 'screenshot']);
    expect(p.attachments[1]).toEqual({ kind: 'screenshot', mime: 'image/png', content: PNG.split(',')[1] });
    expect(isNormalizedProblemReport(p)).toBe(true);
  });

  it('rejects invalid, non-PNG and oversized screenshot bytes', () => {
    for (const screenshotDataUrl of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,eA==', `data:image/png;base64,${'A'.repeat(3_000_000)}`]) {
      expect(() => draft({ screenshotDataUrl, attachScreenshot: true })).toThrow(/Screenshot/);
    }
  });

  it('binds screenshot bytes to the preview digest and refuses duplicated images', async () => {
    const p = draft({ screenshotDataUrl: PNG, attachScreenshot: true });
    expect(await previewDigest(p)).not.toBe(await previewDigest(draft({ screenshotDataUrl: PNG })));
    expect(isNormalizedProblemReport({ ...p, attachments: [p.attachments[0]!, p.attachments[0]!] })).toBe(false);
  });
  it('builds the automatic context: app, version, screen, recent errors', () => {
    const p = draft();
    expect(p.schemaVersion).toBe(1);
    expect(p.context.app).toBe('papercusp-desktop');
    expect(p.context.appVersion).toBe('0.9.3 (abc1234)');
    expect(p.context.screen).toEqual({ route: '/harness/papercusp/board', state: { view: 'kanban', card: 'WI-1' } });
    expect(p.context.recentErrors).toEqual([
      { at: '2026-10-06T21:00:00.000Z', source: 'window.error', message: 'TypeError: x is undefined' },
    ]);
  });

  it("drops the dialog's own open flag from the captured screen state", () => {
    expect(draft({ search: 'report=1' }).context.screen).toEqual({ route: '/harness/papercusp/board', state: null });
  });

  it('collapses the description to one line and caps it at 280 characters', () => {
    const p = draft({ text: `line one\n\nline   two ${'x'.repeat(400)}` });
    expect(p.text.startsWith('line one line two ')).toBe(true);
    expect(p.text).not.toContain('\n');
    expect(p.text.length).toBe(PROBLEM_REPORT_LIMITS.text);
  });

  it('refuses an empty description', () => {
    expect(() => draft({ text: '  \n ' })).toThrow(/needs a sentence/);
  });

  it('redacts secrets on the device, in every field the preview shows', () => {
    const p = draft({
      text: `login fails with ${SECRET}`,
      search: `?q=${encodeURIComponent(SECRET)}`,
      recentErrors: [{ message: `auth error ${SECRET}` }],
      attachLog: true,
      logLines: [`request ${SECRET}`],
    });
    expect(canonicalJson(p)).not.toContain('q'.repeat(30));
    expect(p.text).toContain('[redacted]');
  });

  it('keeps only the most recent 5 errors', () => {
    const errors = Array.from({ length: 8 }, (_, i) => ({ message: `error ${i}` }));
    expect(draft({ recentErrors: errors }).context.recentErrors.map((e) => e.message)).toEqual([
      'error 3',
      'error 4',
      'error 5',
      'error 6',
      'error 7',
    ]);
  });

  it('attaches log lines only when the reporter ticks the box (default off)', () => {
    const lines = ['a', 'b'];
    expect(draft({ logLines: lines }).attachments).toEqual([]);
    expect(draft({ attachLog: false, logLines: lines }).attachments).toEqual([]);
    expect(draft({ attachLog: true, logLines: lines }).attachments).toEqual([
      { kind: 'log', mime: 'text/plain', lineCount: 2, content: 'a\nb' },
    ]);
  });

  it('has no field that could carry contact details', () => {
    const p = draft({ attachLog: true, logLines: ['x'] });
    const keys = canonicalJson(p).match(/"[a-zA-Z]+":/g)?.map((k) => k.slice(1, -2)) ?? [];
    for (const forbidden of ['email', 'name', 'reporterId', 'contact', 'user', 'account']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe('preview binding', () => {
  it('canonicalJson is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
  });

  it('the digest of the previewed payload matches the digest of the sent payload', async () => {
    const shown = draft({ attachLog: true, logLines: ['x'] });
    const sent: ProblemReportPayload = JSON.parse(JSON.stringify(shown));
    expect(await previewDigest(sent)).toBe(await previewDigest(shown));
    expect(await previewDigest(shown)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('any content the preview did not show changes the digest', async () => {
    const shown = draft();
    const digest = await previewDigest(shown);
    const extraLog: ProblemReportPayload = {
      ...shown,
      attachments: [{ kind: 'log', mime: 'text/plain', lineCount: 1, content: 'hidden' }],
    };
    const changedText: ProblemReportPayload = { ...shown, text: `${shown.text}!` };
    expect(await previewDigest(extraLog)).not.toBe(digest);
    expect(await previewDigest(changedText)).not.toBe(digest);
  });

  it('a payload the builder produced is normalized; a hand-made one is not', () => {
    const p = draft({ attachLog: true, logLines: ['one', 'two'] });
    expect(isNormalizedProblemReport(p)).toBe(true);
    expect(isNormalizedProblemReport(draft())).toBe(true);
    expect(isNormalizedProblemReport({ ...p, text: `raw ${SECRET}` })).toBe(false);
    expect(isNormalizedProblemReport({ ...p, text: 'x'.repeat(PROBLEM_REPORT_LIMITS.text + 1) })).toBe(false);
    expect(
      isNormalizedProblemReport({
        ...p,
        context: { ...p.context, screen: { route: '/a', state: { report: '1' } } },
      }),
    ).toBe(false);
    expect(isNormalizedProblemReport({ ...p, attachments: [...p.attachments, ...p.attachments] })).toBe(false);
    expect(
      isNormalizedProblemReport({ ...p, attachments: [{ kind: 'log', mime: 'text/plain', content: 'x', lineCount: 99 }] }),
    ).toBe(false);
  });
});
