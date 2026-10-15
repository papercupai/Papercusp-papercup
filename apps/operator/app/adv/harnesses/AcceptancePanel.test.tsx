// @vitest-environment jsdom
/**
 * AcceptancePanel.test.tsx — the harness Tests-tab "Acceptance" view.
 *
 * verification-system-improvements-2026-10-10 P-003 (SPEC-P-003-VAL-READERS):
 * inline VAL-* assertions are retired, so the panel no longer loads
 * `harness_plan_assertions` (the `testing.assertionsByHarness` sync query was
 * removed) nor POSTs per-VAL `requires_test` toggles (the route answers a typed
 * 410). It renders a static notice naming the successor — the plan requirement
 * contract — and must not touch the network or the sync layer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const useSyncQuery = vi.fn();
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: (...args: unknown[]) => useSyncQuery(...args),
}));

import AcceptancePanel from './AcceptancePanel';
import { VAL_RETIREMENT_DOC } from '@papercusp/operator-core/lib/agent-tools/plans/val-retirement';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useSyncQuery.mockReset();
});

describe('<AcceptancePanel> (VAL-* retired, P-003)', () => {
  it('renders the retirement notice naming the requirement contract as successor', () => {
    render(<AcceptancePanel slug="demo" />);
    const panel = screen.getByTestId('acceptance-retired');
    expect(panel.getAttribute('data-harness')).toBe('demo');
    expect(panel.textContent).toMatch(/assertions are retired/);
    expect(panel.textContent).toMatch(/requirement/);
    expect(panel.textContent).toContain('plans:get');
    expect(panel.textContent).toContain(VAL_RETIREMENT_DOC);
  });

  it('does not query the retired assertion store or call the retired routes', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    render(<AcceptancePanel slug="demo" />);
    expect(useSyncQuery).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('offers no requires_test toggle (the per-VAL write path is retired)', () => {
    render(<AcceptancePanel slug="demo" />);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});
