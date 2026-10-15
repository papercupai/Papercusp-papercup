// @vitest-environment jsdom
/**
 * A settings field whose choices come from a connected provider (cupboard-distributable-
 * integrations-2026-10-10 P-004, D-005; SPEC-R-2-P-004): the control asks for the declared option
 * source, uses the registered Select for single choices, presents array choices as accessible
 * checkboxes grouped by account, retains saved values providers no longer list, and falls back to
 * typing when nothing can answer or the read fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProviderOptionsGroup } from '@papercusp/operator-core/lib/integrations/provider-options';

const H = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; url: string; body: unknown }>,
  response: { status: 200, body: { ok: true, capability: 'chat.channels', groups: [] } as unknown },
}));

import { PROVIDER_OPTIONS_API, ProviderOptionsSelect } from './ProviderOptionsSelect';

const CHANNEL = { type: 'string', description: 'Where bug reports are posted.', 'x-options': { capability: 'chat.channels', args: { types: 'public' } } };
const CHANNELS = { type: 'array', items: { type: 'string' }, 'x-options': { capability: 'chat.channels' } };

const group = (overrides: Partial<ProviderOptionsGroup> = {}): ProviderOptionsGroup => ({
  sourceId: 's1',
  provider: 'fixture-chat',
  providerName: 'Fixture Chat',
  accountLabel: 'Acme',
  options: [
    { value: 'C1', label: '#bugs' },
    { value: 'C2', label: '#general' },
  ],
  truncated: false,
  error: null,
  ...overrides,
});

const answer = (groups: ProviderOptionsGroup[]) => {
  H.response = { status: 200, body: { ok: true, capability: 'chat.channels', groups } };
};

beforeEach(() => {
  H.calls.length = 0;
  answer([]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      H.calls.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(H.response.body), { status: H.response.status, headers: { 'content-type': 'application/json' } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ProviderOptionsSelect', () => {
  it('asks for the declared option source and offers the answers as a dropdown', async () => {
    answer([group()]);
    const onChange = vi.fn();
    render(<ProviderOptionsSelect id="channel" label="Bug channel" property={CHANNEL} value={undefined} onChange={onChange} />);

    expect(screen.getByRole('status').textContent).toContain('Asking connected providers');
    const select = await screen.findByRole('combobox', { name: 'Bug channel' });
    expect(H.calls).toEqual([
      { method: 'POST', url: PROVIDER_OPTIONS_API, body: { capability: 'chat.channels', args: { types: 'public' } } },
    ]);
    expect(screen.getByText('Where bug reports are posted.')).toBeTruthy();

    fireEvent.click(select);
    fireEvent.click(await screen.findByRole('option', { name: '#general' }));
    expect(onChange).toHaveBeenCalledWith('C2');
  });

  it('groups the choices by account when several sources answer, and names a source that failed', async () => {
    answer([
      group(),
      group({ sourceId: 's2', accountLabel: 'Beta', options: [{ value: 'D1', label: '#triage' }] }),
      group({ sourceId: 's3', accountLabel: 'Gamma', options: [], error: { code: 'provider_auth', message: 'token revoked' } }),
    ]);
    render(<ProviderOptionsSelect id="channel" label="Bug channel" property={CHANNEL} value="C1" onChange={vi.fn()} />);
    const select = await screen.findByRole('combobox', { name: 'Bug channel' });
    expect(select.textContent).toContain('#bugs');
    fireEvent.click(select);
    expect(await screen.findByText('Fixture Chat · Acme')).toBeTruthy();
    expect(screen.getByText('Fixture Chat · Beta')).toBeTruthy();
    expect(screen.getByRole('option', { name: '#triage' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(screen.getByRole('alert').textContent).toBe('Fixture Chat · Gamma: token revoked');
  });

  it('keeps a saved value the provider no longer lists', async () => {
    answer([group()]);
    render(<ProviderOptionsSelect id="channel" label="Bug channel" property={CHANNEL} value="C9" onChange={vi.fn()} />);
    const select = await screen.findByRole('combobox', { name: 'Bug channel' });
    expect(select.textContent).toContain('C9 (no longer listed)');
  });

  it('is a multiple choice for an array property', async () => {
    answer([group()]);
    const onChange = vi.fn();
    const props = { id: 'channels', label: 'Channels', property: CHANNELS, onChange };
    const { rerender } = render(<ProviderOptionsSelect {...props} value={['C1']} />);
    const bugs = await screen.findByRole('checkbox', { name: 'Channels: #bugs' });
    const general = screen.getByRole('checkbox', { name: 'Channels: #general' });
    expect(bugs.getAttribute('aria-checked')).toBe('true');
    expect(general.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(general);
    expect(onChange).toHaveBeenCalledWith(['C1', 'C2']);
    rerender(<ProviderOptionsSelect {...props} value={['C1', 'C2']} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Channels: #general' }));
    expect(onChange).toHaveBeenLastCalledWith(['C1']);
  });

  it('falls back to typing the value when nothing connected can answer', async () => {
    answer([]);
    const onChange = vi.fn();
    render(<ProviderOptionsSelect id="channel" label="Bug channel" property={CHANNEL} value="" onChange={onChange} />);
    expect(await screen.findByText(/No connected provider lists these choices/)).toBeTruthy();
    const input = screen.getByLabelText('Bug channel') as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    fireEvent.change(input, { target: { value: 'C7' } });
    expect(onChange).toHaveBeenCalledWith('C7');
  });

  it('shows a failed read with Retry, and still lets the value be typed', async () => {
    H.response = { status: 503, body: { ok: false, error: 'provider_registry_not_ready', detail: 'plugins are still loading' } };
    render(<ProviderOptionsSelect id="channel" label="Bug channel" property={CHANNEL} value="" onChange={vi.fn()} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Could not list the choices: plugins are still loading');
    expect((screen.getByLabelText('Bug channel') as HTMLElement).tagName).toBe('INPUT');

    answer([group()]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Bug channel' })).toBeTruthy());
    expect(H.calls).toHaveLength(2);
  });

  it('asks nothing for a field without an option source', () => {
    render(<ProviderOptionsSelect id="note" label="Note" property={{ type: 'string' }} value="hi" onChange={vi.fn()} />);
    expect((screen.getByLabelText('Note') as HTMLInputElement).value).toBe('hi');
    expect(H.calls).toEqual([]);
  });
});
