// @vitest-environment jsdom
/**
 * Settings → Remote access (external-app-access P-010, D-025).
 *
 * The screen's contract: every phone, app key and service key of the workspace is listed with its
 * creator and last use and with pause / rotate / revoke controls (R-26); the switch posts the
 * workspace's kill switch (R-41); a confirmed revoke posts the entry's id AND kind so a phone goes
 * to the device store and a key to the app-key store (R-40). The end-to-end refusals themselves
 * are proven in the headless Tauri shell and by the route + store tests; this file pins the
 * screen's wiring to those routes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

const H = vi.hoisted(() => ({
  query: {} as Record<string, unknown>,
  setters: {} as Record<string, ReturnType<typeof vi.fn>>,
  rows: [] as unknown[],
}));

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock('nuqs', () => {
  const withDefault = (d: unknown) => ({ defaultValue: d });
  const parser = { withDefault };
  return {
    useQueryState: (k: string, p?: { defaultValue?: unknown }) => {
      H.setters[k] ??= vi.fn();
      return [k in H.query ? H.query[k] : (p?.defaultValue ?? null), H.setters[k]];
    },
    parseAsString: parser,
    parseAsBoolean: parser,
    parseAsStringEnum: () => parser,
  };
});
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: H.rows, loading: false, error: null }),
}));
vi.mock('@/app/harness/Select', () => ({
  Select: ({ value }: { value: string }) => <span data-testid="ws-select">{value}</span>,
}));
vi.mock('@/app/_components/SetupWizard/StepOwnTunnel', () => ({ StepOwnTunnel: () => <div data-testid="own-tunnel-step" /> }));
vi.mock('@/app/harness/ConfirmModal', () => ({
  ConfirmModal: (p: { open: boolean; title: string; body: ReactNode; confirmLabel?: string; onConfirm: () => void }) =>
    p.open ? (
      <div role="dialog" aria-label={p.title}>
        {p.body}
        <button type="button" onClick={() => void p.onConfirm()}>{p.confirmLabel}</button>
      </div>
    ) : null,
}));

import RemoteAccessSettingsPage, { entryTags, type PortalRelayStatusView, type RemoteAccessEntryView } from './page';

function entry(over: Partial<RemoteAccessEntryView>): RemoteAccessEntryView {
  return {
    id: 'x',
    kind: 'app',
    label: 'x',
    creator: 'owner@example.com',
    scopes: {},
    pairedAt: '2026-09-29T00:00:00Z',
    lastSeen: null,
    lastIp: null,
    expiresAt: null,
    pausedAt: null,
    spendCapCents: null,
    spendCapWindowSec: null,
    rotatedAt: null,
    previousKeyValidUntil: null,
    clientAuth: null,
    ...over,
  };
}

const ENTRIES = [
  entry({ id: 'dev-phone', kind: 'mobile', label: 'Avi phone', lastSeen: '2026-09-30T08:00:00Z', lastIp: '10.0.0.9' }),
  entry({ id: 'pcapp_app', kind: 'app', label: 'zapier', creator: 'avi@example.com', scopes: { tools: ['plans:list'] } }),
  entry({ id: 'pcapp_svc', kind: 'service', label: 'nightly', pausedAt: '2026-09-30T09:00:00Z', spendCapCents: 500 }),
];

function overview(enabled = true) {
  return {
    workspaceId: 'ws1',
    remoteAccess: { workspaceId: 'ws1', enabled, changedAt: null, changedBy: null },
    entries: ENTRIES,
    ownTunnel: null,
    ownTunnelError: null,
  };
}

let posts: Array<{ url: string; body: Record<string, unknown> }>;

beforeEach(() => {
  H.query = { ws: 'ws1' };
  H.setters = {};
  H.rows = [overview()];
  posts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === '/api/workspaces') {
        return new Response(JSON.stringify({ current: 'ws1', workspaces: [{ id: 'ws1', name: 'One' }] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Remote access screen', () => {
  it('offers session access only for a phone and enables its workspace-scoped grant', async () => {
    render(<RemoteAccessSettingsPage />);
    const grant = screen.getByRole('checkbox', { name: 'Agent sessions for Avi phone' });
    expect(grant.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('checkbox', { name: 'Agent sessions for zapier' })).toBeNull();
    fireEvent.click(grant);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: '/api/device/desktop/devices/dev-phone/agent-sessions', body: { workspaceId: 'ws1', enabled: true } });
  });

  it('can revoke a granted phone session capability without unpairing the phone', async () => {
    H.rows = [{ ...overview(), entries: [entry({ id: 'dev-phone', kind: 'mobile', label: 'Avi phone', scopes: { capabilities: ['agent-sessions'] } })] }];
    render(<RemoteAccessSettingsPage />);
    const grant = screen.getByRole('checkbox', { name: 'Agent sessions for Avi phone' });
    expect(grant.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(grant);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: '/api/device/desktop/devices/dev-phone/agent-sessions', body: { workspaceId: 'ws1', enabled: false } });
  });

  it('lists every phone, app key and service key with creator, last use and its controls (R-26)', () => {
    render(<RemoteAccessSettingsPage />);
    const items = screen.getAllByTestId('remote-access-entry');
    expect(items.map((li) => li.getAttribute('data-entry-id'))).toEqual(['dev-phone', 'pcapp_app', 'pcapp_svc']);
    for (const li of items) {
      for (const action of ['pause', 'rotate', 'revoke']) {
        expect(li.querySelector(`[data-action="${action}"]`), `${li.dataset.entryId} ${action}`).not.toBeNull();
      }
    }
    // Scope is a key property; a phone has none to edit.
    expect(items[0]!.querySelector('[data-action="edit-scope"]')).toBeNull();
    expect(items[1]!.querySelector('[data-action="edit-scope"]')).not.toBeNull();
    expect(within(items[1]!).getByText(/Added by avi@example.com/)).toBeTruthy();
    expect(within(items[0]!).getByText(/from 10\.0\.0\.9/)).toBeTruthy();
    expect(within(items[2]!).getByText('Resume')).toBeTruthy();
  });

  it('projects class-specific authority, status and revoke copy into each row', () => {
    render(<RemoteAccessSettingsPage />);
    const items = screen.getAllByTestId('remote-access-entry');
    expect(items.map((li) => li.dataset.connectionClass)).toEqual(['mobile-device', 'browser-session', 'browser-session']);
    expect(within(items[0]!).getByTestId('remote-access-entry-route').textContent)
      .toBe('Scope: Current workspace · Transport: Device HTTP');
    expect(within(items[1]!).getByTestId('remote-access-entry-route').textContent)
      .toBe('Scope: Current workspace · Transport: HTTPS');
    expect(within(items[0]!).getByTestId('remote-access-entry-authority').textContent).toContain('Paired mobile device · Connected');
    expect(within(items[0]!).getByRole('button', { name: 'Unpair phone' })).toBeTruthy();
    expect(within(items[1]!).getByTestId('remote-access-entry-authority').textContent).toContain('User app key access · Connected');
    expect(within(items[1]!).getByRole('button', { name: 'Revoke app access' })).toBeTruthy();
    expect(within(items[2]!).getByTestId('remote-access-entry-authority').textContent).toContain('Workspace service key access · Paused');
    expect(within(items[2]!).getByRole('button', { name: 'Revoke service key' })).toBeTruthy();
  });

  it('wraps each entry so its controls never overlap the label in a narrow pane', () => {
    // Measured in the Tauri shell: in the ~190px settings pane a non-wrapping row with
    // flexShrink:0 controls drew Pause over the key's name and clipped Rotate/Revoke.
    render(<RemoteAccessSettingsPage />);
    const rows = screen.getAllByTestId('remote-access-entry-row');
    const actions = screen.getAllByTestId('remote-access-entry-actions');
    expect(rows).toHaveLength(3);
    for (const el of [...rows, ...actions]) {
      expect(el.style.flexWrap).toBe('wrap');
      expect(el.style.flexShrink).not.toBe('0');
    }
  });

  it('the switch posts the workspace kill switch (R-41)', async () => {
    render(<RemoteAccessSettingsPage />);
    expect(screen.getByTestId('remote-access-state').dataset.enabled).toBe('true');
    fireEvent.click(screen.getByTestId('remote-access-toggle'));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: '/api/remote-access', body: { workspaceId: 'ws1', enabled: false } });
  });

  it('says what off means, including that phones keep working', () => {
    H.rows = [overview(false)];
    render(<RemoteAccessSettingsPage />);
    expect(screen.getByTestId('remote-access-state').textContent).toContain('off');
    expect(screen.getByText(/Paired phones are not affected/)).toBeTruthy();
    expect(screen.getByTestId('remote-access-toggle').textContent).toBe('Turn on');
  });

  it('asks before revoking, then revokes the key with its kind (R-40)', async () => {
    H.query = { ws: 'ws1', confirm: 'revoke:pcapp_app' };
    render(<RemoteAccessSettingsPage />);
    const dialog = screen.getByRole('dialog', { name: 'Revoke zapier?' });
    fireEvent.click(within(dialog).getByText('Revoke'));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: '/api/remote-access/revoke', body: { workspaceId: 'ws1', id: 'pcapp_app', kind: 'app' } });
    expect(H.setters.confirm).toHaveBeenCalledWith(null);
  });

  it('rotating a phone revokes it and opens pairing', async () => {
    H.query = { ws: 'ws1', confirm: 'rotate:dev-phone' };
    render(<RemoteAccessSettingsPage />);
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Rotate'));
    await waitFor(() => expect(H.setters.pair).toHaveBeenCalledWith(true));
    expect(posts[0]).toEqual({ url: '/api/remote-access/revoke', body: { workspaceId: 'ws1', id: 'dev-phone', kind: 'mobile' } });
  });

  it('opens nothing for a confirmation that names no listed entry', () => {
    H.query = { ws: 'ws1', confirm: 'revoke:pcapp_gone' };
    render(<RemoteAccessSettingsPage />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('pauses a phone through the device path', async () => {
    render(<RemoteAccessSettingsPage />);
    const phone = screen.getAllByTestId('remote-access-entry')[0]!;
    fireEvent.click(phone.querySelector('[data-action="pause"]')!);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ workspaceId: 'ws1', id: 'dev-phone', kind: 'mobile', paused: true });
  });
});

/** A relay status as relay-opt-in.ts reports it (external-app-access P-008, D-031). */
function relay(over: Partial<PortalRelayStatusView>): PortalRelayStatusView {
  return {
    state: 'off',
    available: true,
    unavailableReason: null,
    portalOrigin: 'https://papercusp.example',
    notice: { version: 2, text: 'Traffic to this computer passes through Papercusp servers.' },
    consent: { agreed: false, version: null, at: null },
    pending: null,
    linked: null,
    health: 'off',
    lastError: null,
    ...over,
  };
}

function withRelay(r: PortalRelayStatusView | null, portalRelayError: string | null = null) {
  H.rows = [{ ...overview(), portalRelay: r, portalRelayError }];
  render(<RemoteAccessSettingsPage />);
  return r ? screen.getByTestId('portal-relay') : null;
}

describe('Papercusp relay card (P-008)', () => {
  it.each([
    ['up', 'healthy', 'Connected'],
    ['down', 'offline', 'Not connected'],
    ['starting', 'degraded', 'Connecting…'],
  ] as const)('renders authoritative relay metadata and %s liveness through the inventory adapter', (health, normalizedHealth, label) => {
    const card = withRelay(relay({
      state: 'linked', health,
      linked: { appBaseUrl: null, mcpUrl: null, linkedAt: '2026-09-30T10:05:00Z' },
    }))!;
    expect(card.dataset.connectionClass).toBe('portal-relay');
    expect(card.dataset.connectionState).toBe('active');
    expect(card.dataset.connectionHealth).toBe(normalizedHealth);
    expect(within(card).getByTestId('portal-relay-authority').textContent).toBe(
      'Portal relay · Portal relay app channels · Scope: ws1 · Transport: WEBSOCKET',
    );
    expect(within(card).getByTestId('portal-relay-health').textContent).toBe(label);
    expect(within(card).getByTestId('portal-relay-disconnect').textContent).toContain('Disconnect');
  });

  it('shows the notice and offers no Connect until it is agreed to (R-20)', async () => {
    const card = withRelay(relay({}))!;
    expect(card.dataset.state).toBe('off');
    expect(within(card).getByTestId('portal-relay-notice').textContent).toContain('passes through Papercusp servers');
    expect(within(card).queryByTestId('portal-relay-connect')).toBeNull();
    const agree = within(card).getByTestId('portal-relay-accept') as HTMLButtonElement;
    expect(agree.disabled).toBe(true);
    fireEvent.click(within(card).getByTestId('portal-relay-understand'));
    expect(agree.disabled).toBe(false);
    fireEvent.click(agree);
    await waitFor(() => expect(posts).toHaveLength(1));
    // The agreement names the notice version the user actually saw.
    expect(posts[0]).toEqual({ url: '/api/remote-access/portal-relay/consent', body: { noticeVersion: 2 } });
  });

  it('once agreed, Connect starts the device sign-in', async () => {
    const card = withRelay(relay({ consent: { agreed: true, version: 2, at: '2026-09-30T10:00:00Z' } }))!;
    expect(within(card).queryByTestId('portal-relay-notice')).toBeNull();
    fireEvent.click(within(card).getByTestId('portal-relay-connect'));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: '/api/remote-access/portal-relay/connect', body: {} });
  });

  it('while linking, shows the code and the address to approve it, and can cancel', async () => {
    const card = withRelay(
      relay({
        state: 'linking',
        health: 'linking',
        consent: { agreed: true, version: 2, at: '2026-09-30T10:00:00Z' },
        pending: { userCode: 'WXYZ-1234', verificationUri: 'https://papercusp.example/device', expiresAt: '2026-09-30T10:15:00Z' },
      }),
    )!;
    expect(card.dataset.state).toBe('linking');
    expect(within(card).getByTestId('portal-relay-code').textContent).toBe('WXYZ-1234');
    expect(within(card).getByTestId('portal-relay-link').getAttribute('href')).toBe('https://papercusp.example/device');
    expect(within(card).queryByTestId('portal-relay-connect')).toBeNull();
    fireEvent.click(within(card).getByText('Cancel'));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe('/api/remote-access/portal-relay/cancel');
  });

  it('when linked, shows health, the app address and the MCP URL, and can disconnect', async () => {
    const card = withRelay(
      relay({
        state: 'linked',
        health: 'up',
        consent: { agreed: true, version: 2, at: '2026-09-30T10:00:00Z' },
        linked: {
          appBaseUrl: 'https://papercusp.example/api/workspaces/lw_1',
          mcpUrl: 'https://papercusp.example/api/workspaces/lw_1/mcp',
          linkedAt: '2026-09-30T10:05:00Z',
        },
      }),
    )!;
    expect(within(card).getByTestId('portal-relay-health').textContent).toBe('Connected');
    expect(within(card).getByTestId('portal-relay-address').textContent).toBe('https://papercusp.example/api/workspaces/lw_1');
    expect(within(card).getByTestId('portal-relay-mcp').textContent).toBe('https://papercusp.example/api/workspaces/lw_1/mcp');
    fireEvent.click(within(card).getByTestId('portal-relay-disconnect'));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe('/api/remote-access/portal-relay/disconnect');
  });

  it('names a link that is down and its last error', () => {
    const card = withRelay(
      relay({
        state: 'linked',
        health: 'down',
        consent: { agreed: true, version: 2, at: null },
        linked: { appBaseUrl: null, mcpUrl: null, linkedAt: null },
        lastError: 'connector refused: workspace_suspended',
      }),
    )!;
    expect(within(card).getByTestId('portal-relay-health').textContent).toBe('Not connected');
    expect(within(card).getByTestId('portal-relay-error').textContent).toBe('connector refused: workspace_suspended');
    expect(within(card).queryByTestId('portal-relay-address')).toBeNull();
  });

  it('on a machine Papercusp hosts, offers no relay controls at all', () => {
    const card = withRelay(relay({ available: false, unavailableReason: 'hosted_machine' }))!;
    expect(card.dataset.state).toBe('unavailable');
    for (const id of ['portal-relay-notice', 'portal-relay-accept', 'portal-relay-connect', 'portal-relay-disconnect']) {
      expect(within(card).queryByTestId(id), id).toBeNull();
    }
  });

  it('says when the relay status could not be read, and shows no card', () => {
    withRelay(null, 'relay store unreachable');
    expect(screen.queryByTestId('portal-relay')).toBeNull();
    expect(screen.getByText('Relay status unavailable: relay store unreachable')).toBeTruthy();
  });
});

describe('entryTags', () => {
  it('names paused, expired, overlap and cap state', () => {
    const now = Date.parse('2026-09-30T12:00:00Z');
    expect(entryTags(entry({ pausedAt: '2026-09-30T00:00:00Z', expiresAt: '2026-09-29T00:00:00Z' }), now)).toEqual(['Paused', 'Expired']);
    const tags = entryTags(entry({ previousKeyValidUntil: '2026-09-30T13:00:00Z', spendCapCents: 1234, clientAuth: 'client_secret' }), now);
    expect(tags[0]).toMatch(/^Old key works until/);
    expect(tags).toContain('OAuth client (secret)');
    expect(tags).toContain('Cap $12.34');
  });
});
