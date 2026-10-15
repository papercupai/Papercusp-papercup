/**
 * report-problem.test.ts — the desktop Report a problem door (P-014, D-048 pt 3-6).
 * Only what the preview showed can be sent, it is filed through the one intake,
 * and a ticked log lands in the consented-attachment store.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildProblemReport, previewDigest, type ProblemReportPayload } from '../../../harness/improvements/problem-report';
import type { EndUserReportInput, EndUserReportResult } from '../../../harness/improvements/end-user-intake';
import type { PutReportAttachmentInput } from '../../../harness/improvements/report-attachments';
import { REPORT_PROBLEM_DOOR, defaultReportProblemDeps, handleReportProblem, type ReportProblemDeps } from './report-problem';
import * as contribution from '../../../pot/contribute-upstream';

function payload(overrides: Partial<Parameters<typeof buildProblemReport>[0]> = {}): ProblemReportPayload {
  return buildProblemReport({
    text: 'Export to CSV fails with an error',
    appVersion: '0.9.3 (abc1234)',
    route: '/harness/papercusp/board',
    search: '?view=kanban&report=1',
    recentErrors: [{ at: '2026-10-06T21:00:00.000Z', source: 'window.error', message: 'TypeError: rows is undefined' }],
    ...overrides,
  });
}

function deps(result?: EndUserReportResult) {
  const intakeCalls: EndUserReportInput[] = [];
  const putCalls: PutReportAttachmentInput[] = [];
  const d: ReportProblemDeps = {
    intake: vi.fn(async (input: EndUserReportInput): Promise<EndUserReportResult> => {
      intakeCalls.push(input);
      return (
        result ?? {
          routed: 'work-item',
          classification: { kind: 'bug', basis: 'defect-cue' },
          capture: { ok: true, created: true, possibleDuplicates: [], issue: { id: 'EI-42' } } as never,
        }
      );
    }),
    putAttachment: vi.fn(async (input: PutReportAttachmentInput) => {
      putCalls.push(input);
      return { ok: true as const, id: 'att-1', deduplicated: false, redaction: 'redacted' as const, byteSize: 3 };
    }),
    workspaceId: () => 'ws-test',
  };
  return { d, intakeCalls, putCalls };
}

async function send(p: ProblemReportPayload, extra: Record<string, unknown> = {}) {
  return { payload: p, previewDigest: await previewDigest(p), ...extra };
}

describe('handleReportProblem', () => {
  it('stores only consented PNG bytes through the existing attachment seam', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=';
    const { d, putCalls } = deps();
    await handleReportProblem(await send(payload({ screenshotDataUrl: png })), d);
    expect(putCalls).toHaveLength(0);
    const p = payload({ screenshotDataUrl: png, attachScreenshot: true });
    const out = await handleReportProblem(await send(p), d);
    expect(out).toMatchObject({ status: 200, body: { attachments: [{ kind: 'screenshot', ok: true }] } });
    expect(putCalls[0]).toMatchObject({ kind: 'screenshot', mime: 'image/png', door: 'desktop', workItemId: 'EI-42' });
    expect(putCalls[0]!.content).toBeInstanceOf(Uint8Array);
    expect([...putCalls[0]!.content as Uint8Array].slice(0, 8)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const body = await send(p);
    const changed = { ...p, attachments: [{ ...p.attachments[0]!, content: 'eA==' }] };
    expect((await handleReportProblem({ ...body, payload: changed }, d)).status).toBe(409);
    expect((await handleReportProblem(await send(changed), d)).status).toBe(422);
    expect(putCalls).toHaveLength(1);
  });
  it('production dependencies route Send through the existing contribution core with explicit consent', async () => {
    const result: EndUserReportResult = { routed: 'work-item', classification: { kind: 'bug', basis: 'defect-cue' }, capture: { ok: true, issue: { id: 'EI-report' } } as never };
    const spy = vi.spyOn(contribution, 'contributeUpstream').mockResolvedValue({ ok: true, kind: 'report', queued: true, result, summary: 'queued' });
    try {
      const production = defaultReportProblemDeps();
      expect(production.contribute).toBeTypeOf('function');
      await production.contribute!({ text: 'Export crashes', workspaceId: 'install-ws', reporterId: 'not-forwarded' });
      expect(spy).toHaveBeenCalledWith({ kind: 'report', confirm: true, workspaceId: 'install-ws',
        report: { text: 'Export crashes', title: undefined, reportContext: undefined } });
    } finally {
      spy.mockRestore();
    }
  });

  it('uses contribution once after preview validation and exposes only queued delivery (P-015)', async () => {
    const { d } = deps();
    const result: EndUserReportResult = { routed: 'work-item', classification: { kind: 'bug', basis: 'defect-cue' }, capture: { issue: { id: 'EI-upstream' } } as never };
    d.contribute = vi.fn(async () => ({ ok: true as const, kind: 'report' as const, queued: true as const, result, summary: 'queued' }));
    const out = await handleReportProblem(await send(payload()), d);
    expect(out).toMatchObject({ status: 200, body: { id: 'EI-upstream', delivery: 'queued-for-federation' } });
    expect(d.contribute).toHaveBeenCalledOnce();
    expect(d.intake).not.toHaveBeenCalled();
  });

  it('does not fall back to local capture when canonical contribution prerequisites are missing', async () => {
    const { d } = deps();
    d.contribute = vi.fn(async () => ({ ok: true as const, kind: 'report' as const, prepared: true as const, needs: ['canonical-Pot membership'], plan: {}, summary: 'not submitted' }));
    expect(await handleReportProblem(await send(payload()), d)).toMatchObject({ status: 503, body: { error: 'report-not-submitted' } });
    expect(d.intake).not.toHaveBeenCalled();
    expect(d.putAttachment).not.toHaveBeenCalled();
  });

  it('does not claim a locally stored log was queued with the report text', async () => {
    const { d, putCalls } = deps();
    const result: EndUserReportResult = { routed: 'work-item', classification: { kind: 'bug', basis: 'defect-cue' }, capture: { issue: { id: 'EI-upstream' } } as never };
    d.contribute = vi.fn(async () => ({ ok: true as const, kind: 'report' as const, queued: true as const, result, summary: 'queued' }));
    const out = await handleReportProblem(await send(payload({ attachLog: true, logLines: ['export failed'] })), d);
    expect(out).toMatchObject({ status: 200, body: { delivery: 'queued-for-federation', attachments: [{ ok: true, delivery: 'local-only' }] } });
    expect(putCalls).toHaveLength(1);
  });

  it('rejects a changed preview before calling contribution', async () => {
    const { d } = deps();
    d.contribute = vi.fn();
    const body = await send(payload());
    expect((await handleReportProblem({ ...body, payload: { ...body.payload, text: 'Changed' } }, d)).status).toBe(409);
    expect(d.contribute).not.toHaveBeenCalled();
  });

  it('reports a saved note as local memory, not an upstream bug receipt', async () => {
    const { d } = deps();
    d.contribute = vi.fn(async () => ({ ok: true as const, kind: 'report' as const, localOnly: true as const,
      result: { routed: 'memory' as const, classification: { kind: 'note' as const, basis: 'explicit-note' as const }, memoryIds: ['mem-local'], scope: 'harness:papercusp' }, summary: 'saved locally' }));
    const out = await handleReportProblem(await send(payload({ text: 'FYI: a note', recentErrors: [] })), d);
    expect(out).toEqual({ status: 200, body: { routed: 'memory', id: 'mem-local', attachments: [] } });
    expect(d.intake).not.toHaveBeenCalled();
  });

  it('files the previewed payload through the one intake with the captured context', async () => {
    const { d, intakeCalls, putCalls } = deps();
    const out = await handleReportProblem(await send(payload()), d);
    expect(out).toEqual({ status: 200, body: { routed: 'work-item', id: 'EI-42', attachments: [] } });
    expect(intakeCalls).toHaveLength(1);
    expect(intakeCalls[0]).toMatchObject({
      text: 'Export to CSV fails with an error',
      workspaceId: 'ws-test',
      noteScope: 'harness:papercusp',
      reportContext: {
        app: 'papercusp-desktop',
        appVersion: '0.9.3 (abc1234)',
        screen: { url: null, route: '/harness/papercusp/board', state: { view: 'kanban' } },
        recentErrors: [{ message: 'TypeError: rows is undefined' }],
      },
    });
    // Anonymous: nothing identifies the reporter.
    expect(intakeCalls[0].reporterId).toBeUndefined();
    expect(putCalls).toHaveLength(0);
  });

  it('stores a ticked log excerpt in the attachment store, idempotent per digest', async () => {
    const { d, putCalls } = deps();
    const p = payload({ attachLog: true, logLines: ['warn: slow query', 'error: export failed'] });
    const body = await send(p);
    const out = await handleReportProblem(body, d);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ routed: 'work-item', id: 'EI-42', attachments: [{ kind: 'log', ok: true, id: 'att-1' }] });
    expect(putCalls).toEqual([
      {
        workspaceId: 'ws-test',
        workItemId: 'EI-42',
        door: REPORT_PROBLEM_DOOR,
        kind: 'log',
        mime: 'text/plain',
        content: 'warn: slow query\nerror: export failed',
        externalId: `${body.previewDigest}:0`,
      },
    ]);
  });

  it('refuses 409 when the payload differs from the one the preview showed', async () => {
    const { d, intakeCalls } = deps();
    const shown = payload();
    const body = await send(shown);
    const tampered = { ...body, payload: { ...shown, text: 'something the preview never showed' } };
    const out = await handleReportProblem(tampered, d);
    expect(out).toMatchObject({ status: 409, body: { error: 'preview-mismatch' } });
    expect(intakeCalls).toHaveLength(0);
  });

  it('refuses 409 when a log the preview did not show is added', async () => {
    const { d, putCalls } = deps();
    const shown = payload();
    const body = await send(shown);
    const smuggled = {
      ...body,
      payload: { ...shown, attachments: [{ kind: 'log', mime: 'text/plain', lineCount: 1, content: 'hidden' }] },
    };
    expect((await handleReportProblem(smuggled, d)).status).toBe(409);
    expect(putCalls).toHaveLength(0);
  });

  it('refuses 400 on any unknown key (strict schema)', async () => {
    const { d, intakeCalls } = deps();
    const p = payload();
    expect((await handleReportProblem(await send(p, { email: 'a@b.c' }), d)).status).toBe(400);
    const withExtra = { ...p, context: { ...p.context, userId: 'u-1' } } as unknown as ProblemReportPayload;
    expect((await handleReportProblem(await send(withExtra), d)).status).toBe(400);
    expect((await handleReportProblem(null, d)).status).toBe(400);
    expect(intakeCalls).toHaveLength(0);
  });

  it('refuses 422 a self-consistent payload the dialog would not have built', async () => {
    const { d, intakeCalls } = deps();
    const raw: ProblemReportPayload = { ...payload(), text: `leak token=${'q'.repeat(30)}` };
    const out = await handleReportProblem(await send(raw), d);
    expect(out).toMatchObject({ status: 422, body: { error: 'not-as-previewed' } });
    expect(intakeCalls).toHaveLength(0);
  });

  it('answers routed:memory for a note, with no attachment written', async () => {
    const { d, putCalls } = deps({
      routed: 'memory',
      classification: { kind: 'note', basis: 'explicit-note' },
      memoryIds: ['mem-7'],
      scope: 'harness:papercusp',
    });
    const out = await handleReportProblem(
      await send(payload({ text: 'FYI I use the compact layout', recentErrors: [], attachLog: true, logLines: ['x'] })),
      d,
    );
    expect(out).toEqual({ status: 200, body: { routed: 'memory', id: 'mem-7', attachments: [] } });
    expect(putCalls).toHaveLength(0);
  });

  it('keeps the filed report when the attachment write fails', async () => {
    const { d } = deps();
    d.putAttachment = vi.fn(async () => ({ ok: false as const, reason: 'too-many' as const, detail: 'cap 5' }));
    const out = await handleReportProblem(await send(payload({ attachLog: true, logLines: ['x'] })), d);
    expect(out).toMatchObject({
      status: 200,
      body: { routed: 'work-item', id: 'EI-42', attachments: [{ kind: 'log', ok: false, reason: 'too-many: cap 5' }] },
    });
  });
});
