// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReporterStatusSection, type WorkItemDetailRow } from './DetailPanel';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const item = { id: 'EI-source', origin: 'local', reporterStatus: {
  sourceId: 'EI-source', canonicalId: 'EI-fix', status: 'being-fixed', label: 'Being fixed', release: null,
  followUp: { question: { id: 'q1', text: 'Which file triggers it?', askedBy: 'su-fixer', askedAt: '2026-10-07T00:00:00Z' } },
} } as WorkItemDetailRow;
describe('report status follow-up preview and reply', () => {
  it('sends exactly the redacted preview only after the reporter presses Send', async () => {
    const request = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', request);
    render(<ReporterStatusSection slug="papercusp" workItem={item} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'sample.csv; OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456' } });
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Review reply'));
    const preview = document.querySelector('pre')!.textContent!;
    expect(preview).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Send reply'));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toEqual({ operation: 'answer-follow-up', id: 'EI-source', harness: 'papercusp', questionId: 'q1', text: preview });
    await waitFor(() => expect(screen.getByText('Your reply was saved and queued for delivery.')).toBeTruthy());
  });
  it('shows a matching saved reply without offering another answer', () => {
    render(<ReporterStatusSection slug="papercusp" workItem={{ ...item, reporterStatus: { ...item.reporterStatus!, followUp: {
      ...item.reporterStatus!.followUp!, answer: { questionId: 'q1', text: 'sample.csv', answeredAt: '2026-10-07T01:00:00Z' },
    } } }} />);
    expect(screen.getByText('Your reply: sample.csv')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
