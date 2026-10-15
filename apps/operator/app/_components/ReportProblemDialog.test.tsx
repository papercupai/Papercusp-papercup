import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReportProblemReceipt } from './ReportProblemDialog';

describe('ReportProblemReceipt', () => {
  it('names screenshot receipts separately from logs', () => {
    const html = renderToStaticMarkup(<ReportProblemReceipt sent={{ routed: 'work-item', id: 'EI-42', attachments: [{ kind: 'screenshot', ok: true, delivery: 'upstream-received' }] }} />);
    expect(html).toContain('Screenshot received upstream');
    expect(html).not.toContain('Log attachment');
  });
  it('shows the verified attachment receipt independently of queued report delivery', () => {
    const html = renderToStaticMarkup(<ReportProblemReceipt sent={{ routed: 'work-item', id: 'EI-42', delivery: 'queued-for-federation', attachments: [{ kind: 'log', ok: true, delivery: 'upstream-received' }] }} />);
    expect(html).toContain('Log attachment received upstream');
    expect(html).not.toContain('It has not been sent upstream');
  });
  it('renders the attachment failure while retaining the successful report receipt', () => {
    const html = renderToStaticMarkup(<ReportProblemReceipt sent={{ routed: 'work-item', id: 'EI-42', attachments: [{ kind: 'log', ok: false, reason: 'cap 5' }] }} />);
    expect(html).toContain('your report was filed');
    expect(html).toContain('role="alert"');
    expect(html).toContain('cap 5');
    expect(html).toContain('Your report remains filed');
  });

  it('makes local attachment storage explicit while report federation is queued', () => {
    const html = renderToStaticMarkup(<ReportProblemReceipt sent={{ routed: 'work-item', id: 'EI-42', delivery: 'queued-for-federation', attachments: [{ kind: 'log', ok: true, delivery: 'local-only' }] }} />);
    expect(html).toContain('Upstream receipt has not yet been confirmed');
    expect(html).toContain('It has not been sent upstream');
  });

  it('treats a legacy queued receipt without attachment delivery metadata conservatively', () => {
    const html = renderToStaticMarkup(<ReportProblemReceipt sent={{ routed: 'work-item', id: 'EI-42', delivery: 'queued-for-federation', attachments: [{ kind: 'log', ok: true }] }} />);
    expect(html).toContain('It has not been sent upstream');
  });
});
