import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NuqsAdapter } from 'nuqs/adapters/react';
import { HostedDesktopWorkspace } from '../../app/cloud-workspaces/HostedDesktopWorkspace';
import type { HostedDesktopViewerState } from '../../app/cloud-workspaces/HostedDesktopViewer';
import type {
  HostedDesktopRosterEntry,
  HostedDesktopThumbnailResult,
} from '../../app/cloud-workspaces/hosted-desktop-viewer-protocol';
import { useDesktopGridState } from '../../app/_components/desktop-grid/use-desktop-grid-state';

// Plan agent-multi-desktops-grid-2026-10-06 P-006 (cloud grid) browser fixture.
// The real HostedDesktopWorkspace, DesktopGrid, HostedDesktopViewer and the real
// nuqs URL state run here; only the relay transport (WebSocket + session ticket)
// and the RFB framebuffer are substituted, exactly as desktop-render-matrix does.
// Six agent desktops on one hosted workspace, each with a distinct thumbnail.
class LocalSocket extends EventTarget {
  static OPEN = 1; static CLOSED = 3; static CONNECTING = 0; static CLOSING = 2;
  readyState = LocalSocket.OPEN;
  binaryType = 'arraybuffer';
  constructor(readonly url: string) { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
  send() {}
  close(code = 1000, reason = '') { this.readyState = LocalSocket.CLOSED; this.dispatchEvent(new CloseEvent('close', { code, reason })); }
}
window.WebSocket = LocalSocket as unknown as typeof WebSocket;
const originalFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (new URL(url, location.href).pathname === '/api/hosted/workspaces/grid-workspace/connectors/session-ticket') {
    return Promise.resolve(new Response(JSON.stringify({ ok: true, ticket: `ht_${'b'.repeat(43)}` }), { headers: { 'content-type': 'application/json' } }));
  }
  return originalFetch(input, init);
};

const AGENTS = [
  { id: 'grid-desktop-1', owner: 'su-alpha', name: 'research browser', workItemId: 'WI-101', workItemIntent: 'compare vendor pricing', color: '#1f4e79' },
  { id: 'grid-desktop-2', owner: 'su-beta', name: 'spreadsheet', workItemId: 'WI-102', workItemIntent: 'reconcile invoices', color: '#2e6b3a' },
  { id: 'grid-desktop-3', owner: 'su-gamma', name: 'terminal', workItemId: 'WI-103', workItemIntent: 'run the migration', color: '#6b2e5f' },
  { id: 'grid-desktop-4', owner: 'su-delta', name: 'design review', workItemId: null, workItemIntent: null, color: '#7a4b12' },
  { id: 'grid-desktop-5', owner: 'su-epsilon', name: 'email triage', workItemId: 'WI-105', workItemIntent: 'answer support queue', color: '#3b3b8f' },
  { id: 'grid-desktop-6', owner: 'su-zeta', name: 'form filler', workItemId: 'WI-106', workItemIntent: 'submit the permit', color: '#8f3b3b' },
] as const;

const ROSTER: HostedDesktopRosterEntry[] = AGENTS.map((agent, index) => ({
  desktopSessionId: agent.id,
  displayNumber: 101 + index,
  state: 'running',
  geometry: '1280x720',
  lastActiveAt: `2026-10-06T1${index}:00:00Z`,
  scope: 'agent',
  owner: agent.owner,
  name: agent.name,
  ...(agent.workItemId ? { workItemId: agent.workItemId } : {}),
  ...(agent.workItemIntent ? { workItemIntent: agent.workItemIntent } : {}),
}));

function thumbnailFor(agent: (typeof AGENTS)[number]): HostedDesktopThumbnailResult {
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 180;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = agent.color; ctx.fillRect(0, 0, 320, 180);
  ctx.fillStyle = '#ffffff'; ctx.font = '20px sans-serif';
  ctx.fillText(agent.name, 16, 96);
  const data = canvas.toDataURL('image/jpeg', 0.8).replace(/^data:image\/jpeg;base64,/, '');
  return { desktopSessionId: agent.id, data };
}

const THUMBNAILS: Record<string, HostedDesktopThumbnailResult> = Object.fromEntries(
  AGENTS.map((agent) => [agent.id, thumbnailFor(agent)]),
);

function Fixture() {
  // The page wires these through nuqs (useDesktopGridState); so does the fixture.
  const grid = useDesktopGridState();
  const [viewerState, setViewerState] = useState<HostedDesktopViewerState | null>(null);
  return <main>
    <p role="note">Controlled grid fixture · relay transport and framebuffer are substituted</p>
    <HostedDesktopWorkspace
      hostName="Grid acceptance workspace" workspaceId="grid-workspace" hostId="grid-host"
      routeLabel="grid-route"
      bridge={{ requestRoster: () => true, requestThumbnail: () => true, requestStart: () => true }}
      roster={ROSTER}
      rosterState="ready" rosterError={null}
      startState="idle" startError={null} thumbnails={THUMBNAILS}
      selectedDesktop={grid.selection} viewerState={viewerState}
      onSelectDesktop={grid.setSelection} onViewerStateChange={setViewerState}
      pinned={grid.pinned} onPinnedChange={grid.setPinned}
      filter={grid.filter} onFilterChange={grid.setFilter}
    />
  </main>;
}

createRoot(document.getElementById('root')!).render(<NuqsAdapter><Fixture /></NuqsAdapter>);
