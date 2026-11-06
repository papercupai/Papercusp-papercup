// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ILink, ILinkProvider, Terminal, ITerminalOptions } from '@xterm/xterm';

const M = vi.hoisted(() => ({
  terminals: [] as Terminal[], providers: new Map<Terminal, ILinkProvider[]>(),
  navigate: vi.fn(), native: false,
}));
// Keep real xterm parsing, cells, addon activation and disposal. Only DOM
// rendering is omitted in jsdom; the maintained native journey renders pixels.
vi.mock('@xterm/xterm', async () => {
  const actual = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm');
  class MountedTerminal extends actual.Terminal {
    constructor(options: ITerminalOptions) {
      super({ ...options, allowProposedApi: true });
      M.terminals.push(this);
    }
    override open(_parent: HTMLElement) {}
    override registerLinkProvider(provider: ILinkProvider) {
      M.providers.set(this, [...(M.providers.get(this) ?? []), provider]);
      return super.registerLinkProvider(provider);
    }
  }
  return { ...actual, Terminal: MountedTerminal };
});
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { activate() {} dispose() {} fit() {} } }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {
  activate() {} dispose() {} clearDecorations() {} findNext() {} findPrevious() {}
} }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class { activate() {} dispose() {} } }));
vi.mock('@papercusp/operator-core/lib/client-navigation', () => ({
  navigateClient: M.navigate, shouldSoftNavigate: () => true,
}));
vi.mock('@papercusp/sse', () => ({
  createResilientEventSource: () => ({ close: vi.fn(), setUrl: vi.fn(), status: 'open' }),
}));
vi.mock('@papercusp/operator-core/lib/pty-tauri', () => ({
  isTauriNative: () => M.native, openNativeSession: vi.fn(),
}));
vi.mock('@papercusp/operator-core/lib/tauri-bindings', () => ({ commands: {
  ptySpawn: vi.fn(async () => ({ status: 'ok', data: { id: 'native-link-test' } })),
  ptyKill: vi.fn(async () => {}), ptyWrite: vi.fn(async () => {}), ptyResize: vi.fn(async () => {}),
} }));
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: () => [false, vi.fn()],
}));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (key: string) => key }));
vi.mock('../app/harness/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../app/cloud-workspaces/HostedDesktopViewer', () => ({ HostedDesktopViewer: () => null }));

import PiPanel from '../app/harness/PiPanel';
import { HostedWorkspaceSession } from '../app/cloud-workspaces/HostedWorkspaceSession';
import { InlinePtyTerminal } from '../app/_components/SetupWizard/InlinePtyTerminal';
import TerminalTab from '../app/dev/_components/TerminalTab';
import { StructuredStreamView } from '../app/_components/StructuredStreamView';

const REPORT = 'rpt_c6a650d3-4b68-4bef-9169-8bf4fe69f998';
const TARGET = `/reports?sel=${REPORT}&view=all#details`;
const HOSTS = ['host-pi', 'host-hosted', 'host-setup', 'host-dev', 'host-raw'] as const;
type Host = typeof HOSTS[number];

beforeEach(() => {
  M.terminals.length = 0;
  M.providers.clear();
  M.navigate.mockReset();
  M.native = false;
  sessionStorage.clear();
  vi.stubEnv('NEXT_PUBLIC_PAPERCUSP_PTY_WEBGL', '0');
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal('WebSocket', class {
    static OPEN = 1; static CLOSED = 3; readyState = 1;
    addEventListener() {} removeEventListener() {} send() {} close() { this.readyState = 3; }
  });
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(),
  });
  vi.spyOn(window, 'open').mockReturnValue(null);
  Object.assign(window, { __TAURI__: { event: { listen: async () => () => {} } }, __PAPERCUSP_PTY_WS__: null });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.endsWith('/api/installed') ? { projects: [{ slug: 'links-test', exists: true }] }
      : url.includes('/pty/spawn') ? { id: 'web-link-test', pid: 123, command: 'bash' }
      : url.endsWith('/api/hosted/auth/session') ? { session: { workspaceId: 'links-test' } }
      : url.endsWith('/session-ticket') ? { ticket: `ht_${'a'.repeat(43)}` } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => {
  cleanup();
  for (const terminal of M.terminals) terminal.dispose();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  delete (window as unknown as { __PAPERCUSP_PTY_WS__?: unknown }).__PAPERCUSP_PTY_WS__;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function mount(host: Host) {
  switch (host) {
    case 'host-pi': render(<PiPanel slug="links-test" />); break;
    case 'host-hosted':
      render(<HostedWorkspaceSession hostId="link-host" routeLabel="links" workspaceName="Links" />);
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
      break;
    case 'host-setup': M.native = true; render(<InlinePtyTerminal command="bash" />); break;
    case 'host-dev': render(<TerminalTab />); break;
    case 'host-raw':
      render(<StructuredStreamView url="/api/link-test" eventKinds={['line']} deriveSteps={() => []} />);
      fireEvent.click(screen.getByText(/raw output/i));
      break;
  }
  await waitFor(() => expect(M.terminals.length).toBe(1));
  await waitFor(() => expect(M.providers.get(M.terminals[0])?.length).toBeGreaterThan(0));
  return M.terminals[0];
}
function links(terminal: Terminal): ILink[] {
  return (M.providers.get(terminal) ?? []).flatMap(provider => {
    let result: ILink[] = [];
    provider.provideLinks(1, value => { result = value ?? []; });
    return result;
  });
}
const write = (terminal: Terminal, text: string) => new Promise<void>(done => terminal.write(text, done));

describe('mounted production terminal hosts install the actual reference addon', () => {
  it.each(HOSTS)('%s-positive activates exact report/query/hash in app', async host => {
    const terminal = await mount(host);
    await write(terminal, TARGET);
    const [link] = links(terminal);
    expect(link?.text).toBe(TARGET);
    link.activate(new MouseEvent('click'), link.text);
    expect(M.navigate).toHaveBeenCalledExactlyOnceWith(TARGET);
    expect(window.open).not.toHaveBeenCalled();
  });
  it.each(HOSTS)('%s-negative keeps unsafe and partial references inert', async host => {
    const terminal = await mount(host);
    await write(terminal, `javascript:${REPORT} /api/reports rpt_partial`);
    expect(links(terminal)).toEqual([]);
    expect(M.navigate).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });
});
