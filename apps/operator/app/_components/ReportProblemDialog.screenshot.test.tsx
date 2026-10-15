// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ capture: vi.fn(), requests: [] as Record<string, any>[] }));
vi.mock('html-to-image', () => ({ toPng: h.capture }));
vi.mock('nuqs', () => ({
  parseAsBoolean: { withDefault: () => null }, parseAsString: {},
  useQueryState: (key: string) => [key === 'report', vi.fn()],
}));
vi.mock('@/lib/use-workspace-id', () => ({ useWorkspaceId: () => 'screenshot-test' }));
vi.mock('../../lib/hotkeys', () => ({ useShortcutAction: vi.fn() }));
vi.mock('@papercusp/sync', async (original) => ({ ...await original<typeof import('@papercusp/sync')>(), useSyncQuery: () => ({ data: [] }) }));
vi.mock('sonner', () => ({ toast: vi.fn() }));
import ReportProblemDialog from './ReportProblemDialog';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=';
beforeEach(() => {
  h.requests = [];
  h.capture.mockReset().mockResolvedValue(PNG);
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'POST') h.requests.push(JSON.parse(String(options.body)));
    return { ok: true, json: async () => options?.method === 'POST'
      ? { routed: 'work-item', id: 'EI-screenshot', attachments: [] }
      : { appVersion: '0.9.5' } };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function preview() {
  render(<ReportProblemDialog />);
  fireEvent.change(screen.getByLabelText('What went wrong?'), { target: { value: 'Export crashes' } });
  fireEvent.click(screen.getByText('Review'));
  fireEvent.click(screen.getByText('Capture screenshot'));
  await screen.findByAltText('Screenshot preview');
}

describe('screenshot consent in the report preview', () => {
  it('uses the registered checkbox for optional recent-log attachment', async () => {
    await preview();
    const checkbox = screen.getByRole('checkbox', { name: 'Attach recent log lines' });
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(checkbox);
    expect(checkbox.getAttribute('aria-checked')).toBe('true');
  });

  it('shows the locally captured image before consent and sends no unchecked image', async () => {
    await preview();
    expect(h.requests).toHaveLength(0);
    const checkbox = screen.getByRole('checkbox', { name: 'Attach this screenshot' });
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByAltText('Screenshot preview').getAttribute('src')).toBe(PNG);
    const filter = h.capture.mock.calls[0]![1].filter;
    expect(filter(screen.getByRole('dialog'))).toBe(false);
    expect(filter(document.createElement('section'))).toBe(true);
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(h.requests).toHaveLength(1));
    expect(h.requests[0]!.payload.attachments).toEqual([]);
  });

  it('sends exactly the image shown after explicit selection', async () => {
    await preview();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Attach this screenshot' }));
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(h.requests).toHaveLength(1));
    expect(h.requests[0]!.payload.attachments).toEqual([{ kind: 'screenshot', mime: 'image/png', content: PNG.split(',')[1] }]);
    expect(h.requests[0]!.previewDigest).toMatch(/^sha256:/);
  });

  it('keeps report filing available when local capture fails', async () => {
    h.capture.mockRejectedValue(new Error('canvas cannot render'));
    render(<ReportProblemDialog />);
    fireEvent.change(screen.getByLabelText('What went wrong?'), { target: { value: 'Export crashes' } });
    fireEvent.click(screen.getByText('Review'));
    fireEvent.click(screen.getByText('Capture screenshot'));
    await screen.findByText('The screenshot could not be captured. You can still send your report.');
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(h.requests).toHaveLength(1));
    expect(h.requests[0]!.payload.attachments).toEqual([]);
  });
});
