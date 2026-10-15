/**
 * @vitest-environment jsdom
 *
 * CupboardBlueprintForm — the picker's "New hive from a Comb blueprint" entry
 * (domain-generic-hive P-006 / Brief 3). The CreateHarnessPicker integration
 * tests exercise the happy path (search → install → create); this file covers
 * the component's own edge states: empty results, an install failure, and the
 * Back affordance. @testing-library/react + vitest only (no jest-dom).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { CupboardBlueprintForm } from '../CupboardBlueprintForm';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// Lexicon reads THE_HIVE via the flag hook; mocking the hook keeps jsdom away
// from the real flag bootstrap (fetch + EventSource). Same posture as the
// CreateHarnessPicker test suite — t('cupboard') resolves to "Comb".
vi.mock('@/lib/flag-hooks', () => ({ useFlag: () => true }));

const mockFetch = vi.fn<typeof fetch>();
beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});
afterEach(() => cleanup());

describe('CupboardBlueprintForm', () => {
  it('shows the empty state when no published blueprints match', async () => {
    const user = userEvent.setup();
    mockFetch.mockImplementation(async () => new Response(JSON.stringify({ listings: [] }), { status: 200 }));
    render(<CupboardBlueprintForm onBack={vi.fn()} onCreated={vi.fn()} hiveLabel="Hive" />);

    await user.type(screen.getByPlaceholderText(/research, writing/), 'nope');
    await screen.findByTestId('comb-blueprint-empty');
  });

  it('surfaces an install failure inline and never creates a hive', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes('/api/cupboard/listings')) {
        return new Response(
          JSON.stringify({ listings: [{ id: 3, slug: 'x-bp', title: 'X BP', description: 'd', blueprint_kind: 'hive' }] }),
          { status: 200 },
        );
      }
      if (url.includes('/api/cupboard/install-blueprint')) {
        return new Response(JSON.stringify({ ok: false, error: 'clone failed' }), { status: 500 });
      }
      // /api/harness/pots — should never be reached on an install failure.
      return new Response(JSON.stringify({ ok: true, project: { slug: 'x', path: '/x' } }), { status: 200 });
    });
    render(<CupboardBlueprintForm onBack={vi.fn()} onCreated={onCreated} hiveLabel="Hive" />);

    await user.type(screen.getByPlaceholderText(/research, writing/), 'x');
    await user.click(await screen.findByText('X BP'));
    await user.type(screen.getByPlaceholderText('my-hive'), 'my-x');
    await user.click(screen.getByRole('button', { name: 'Create Hive' }));

    await screen.findByRole('alert');
    expect(onCreated).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalledWith('/api/harness/pots', expect.anything());
  });

  it('reports successful Pot creation without claiming to provision a fleet', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    vi.mocked(toast.success).mockClear();
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes('/api/cupboard/listings')) {
        return new Response(
          JSON.stringify({ listings: [{ id: 3, slug: 'x-bp', title: 'X BP', description: 'd', blueprint_kind: 'hive' }] }),
          { status: 200 },
        );
      }
      if (url.includes('/api/cupboard/install-blueprint')) {
        return new Response(JSON.stringify({ ok: true, id: 'installed-x' }), { status: 200 });
      }
      if (url.includes('/api/harness/pots')) {
        return new Response(JSON.stringify({ ok: true, project: { slug: 'my-x', path: '/my-x' }, waked: false }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    render(<CupboardBlueprintForm onBack={vi.fn()} onCreated={onCreated} hiveLabel="Hive" />);

    await user.type(screen.getByPlaceholderText(/research, writing/), 'x');
    await user.click(await screen.findByText('X BP'));
    await user.type(screen.getByPlaceholderText('my-hive'), 'my-x');
    await user.click(screen.getByRole('button', { name: 'Create Hive' }));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith('my-x');
      expect(toast.success).toHaveBeenCalledWith("Hive 'my-x' created from X BP.");
    });
  });

  it('the Back button returns to the picker (onBack)', async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    mockFetch.mockImplementation(async () => new Response(JSON.stringify({ listings: [] }), { status: 200 }));
    render(<CupboardBlueprintForm onBack={onBack} onCreated={vi.fn()} hiveLabel="Hive" />);

    await user.click(screen.getByRole('button', { name: /Back/ }));
    expect(onBack).toHaveBeenCalled();
  });
});
