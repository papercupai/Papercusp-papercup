// @vitest-environment jsdom
/**
 * Settings nav — per-path FLAG gating (SETTINGS_PATH_FLAGS).
 *
 * `settings-audit-nav.test.ts` next door asserts the nav's plain DATA (which
 * hrefs exist, no duplicates). It imports SETTINGS_GROUPS and never renders, so
 * it cannot see `linkAllowed` — the flag composition lives inside the component.
 * This file covers that half.
 *
 * The case that motivated it (retire-mug-kettle-su-only-2026-08-09 P-011 / D-021):
 * /settings/autonomy must take BOTH gates. `MUG_AUTONOMY_SETTINGS` is the
 * pre-existing per-page kill-switch (ON by default); `MUG_KETTLE_SYSTEM` (DEFAULT
 * OFF) retires the tier the page steers. They answer different questions and both
 * must hold, so dropping either one from the `&&` has to fail here.
 *
 * NOTE ON SCOPE — this gates the NAV ENTRY ONLY. `linkAllowed` filters
 * SETTINGS_GROUPS and nothing else, so the route stays reachable by a typed URL.
 * The page's own early return is what makes it safe; see page.test.tsx's
 * "Mug/Kettle retired" block. Neither half is sufficient alone, which is exactly
 * why both are tested.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FLAGS } from '@papercusp/flags';
import { OperatorWorkspaceLocationProvider } from '@papercusp/operator-ui';

/** Per-key so one flag can be flipped without disturbing the others — a blanket
 *  `() => true` / `() => false` mock cannot express "both gates" at all, which is
 *  the entire subject of this file. */
const flagValues: Record<string, boolean> = {};
vi.mock('@/lib/flag-hooks', () => ({
  useFlag: (k: string) => flagValues[k] ?? true,
}));

vi.mock('@/lib/router-compat/navigation', () => ({
  usePathname: () => '/settings/profile',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
vi.mock('../_components/RouteLink', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('../harness/Select', () => ({
  Select: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

import SettingsLayout from './layout';

beforeEach(() => {
  for (const k of Object.keys(flagValues)) delete flagValues[k];
  // The wizard-state probe is fire-and-forget and its failure is swallowed by the
  // component; stub it so the test never touches the network.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderNav = () => render(<SettingsLayout>{null}</SettingsLayout>);
const autonomyLink = () =>
  document.querySelector('nav a[href="/settings/autonomy"]');

describe('Settings setup progress per workspace location', () => {
  it('does not request desktop setup state from a hosted account', () => {
    render(<OperatorWorkspaceLocationProvider location="cloud">
      <SettingsLayout>{null}</SettingsLayout>
    </OperatorWorkspaceLocationProvider>);
    expect(screen.getByRole('navigation', { name: 'Settings pages' })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the desktop setup progress request on the local profile', () => {
    renderNav();
    expect(fetch).toHaveBeenCalledWith('/api/desktop/setup-wizard-state', { cache: 'no-store' });
  });
});

describe('settings nav — /settings/autonomy is permanently hidden (P-011 / D-021, P-068 / D-098)', () => {
  // This block used to assert a two-flag AND, with a SHOW CONTROL that turned both
  // ON to prove the link was producible. P-068 deleted the tier flag and the entry
  // is now hard `false`, so the link can never be shown and that control is gone.
  //
  // A hide-assertion with no show control is the vacuity trap, so the calibration
  // moved to a DIFFERENT flag-gated entry: /settings/p2p. If `flagValues` no longer
  // reached `linkAllowed` at all — a broken fixture, a renamed key, a nav that threw
  // — the p2p case below would fail, and only then is the autonomy null evidence.
  const p2pLink = () => document.querySelector('nav a[href="/settings/p2p"]');

  it('CALIBRATION: the flag map still drives the nav (a different gated entry toggles)', () => {
    flagValues[FLAGS.P2P] = true;
    const on = renderNav();
    expect(p2pLink()).not.toBeNull();
    expect(screen.getByRole('navigation', { name: 'Settings pages' })).toBeTruthy();
    on.unmount();

    flagValues[FLAGS.P2P] = false;
    renderNav();
    expect(p2pLink()).toBeNull();
  });

  it('shows current queue autonomy controls independently of the retired Queen page flag', () => {
    // The strongest form the deletion allows: the surviving half of the old AND is
    // forced ON, and the entry is still absent.
    flagValues[FLAGS.MUG_AUTONOMY_SETTINGS] = true;
    renderNav();
    expect(autonomyLink()).not.toBeNull();
    expect(document.querySelector('nav a[href="/settings/profile"]')).not.toBeNull();
  });

  it('leaves ungated entries alone — the retirement does not leak', () => {
    renderNav();
    // A gate that hid more than its one entry would satisfy the assertion above
    // for entirely the wrong reason.
    expect(document.querySelector('nav a[href="/settings/profile"]')).not.toBeNull();
    expect(document.querySelector('nav a[href="/settings/api-keys"]')).not.toBeNull();
  });
});
