import React from 'react';
import { createRoot } from 'react-dom/client';
import { NuqsAdapter } from 'nuqs/adapters/react';
import { LocalDesktopWorkspace } from '../../app/cloud-workspaces/LocalDesktopWorkspace';
import type { LocalDesktopSyncRow } from '../../app/cloud-workspaces/local-desktop-protocol';
import { setDesktopGridRows } from './desktop-grid-sync';

// Plan agent-multi-desktops-grid-2026-10-06 P-007 (R-5) browser fixture: "This computer"
// on the Desktops page. The real LocalDesktopWorkspace, DesktopGrid, LocalDesktopViewer,
// thumbnail refresh loop and nuqs URL state run here. Substituted: the roster stream
// (@papercusp/sync -> __fixtures__/desktop-grid-sync.ts), the HTTP seam (fetchImpl:
// thumbnails are real JPEG blobs, vnc-session mints a fixture ticket) and the RFB
// framebuffer. The isolated-sidecar run against real Xvfb desktops is the separate live
// e2e recorded on WI-10006486.
declare global {
  interface Window {
    __thumbnailRequests: Record<string, number>;
    __vncSessions: Array<{ display: number; mode: string; target: string }>;
  }
}
window.__thumbnailRequests = {};
window.__vncSessions = [];

const COLORS = ['#1f4e79', '#2e6b3a', '#6b2e5f', '#7a4b12', '#3b3b8f', '#8f3b3b'];

export function localRow(index: number, name: string, owner: string, workItem: [string, string] | null): LocalDesktopSyncRow {
  return {
    id: `local-desktop-${index}`,
    slug: 'papercusp',
    kind: 'xvfb-local',
    scope: 'agent',
    scopeRef: `${owner}:main`,
    display: 110 + index,
    displayRaw: `:${110 + index}`,
    displayGeometry: { width: 1280, height: 800, depth: 24 },
    captureGeometry: { width: 1280, height: 800 },
    state: 'ready',
    viewerMode: 'none',
    viewerActor: null,
    capabilities: {},
    lastActiveAt: `2026-10-06T0${index}:30:00.000Z`,
    owner,
    name,
    workItemId: workItem?.[0] ?? null,
    workItemIntent: workItem?.[1] ?? null,
  };
}

const empty = new URL(location.href).searchParams.get('empty') === '1';
const rows = empty ? [] : [
  localRow(1, 'browser', 'su-alpha', ['WI-201', 'book the venue']),
  localRow(2, 'terminal', 'su-beta', ['WI-202', 'bisect the regression']),
  localRow(3, 'spreadsheet', 'su-gamma', null),
  localRow(4, 'editor', 'su-delta', ['WI-204', 'draft the release notes']),
  localRow(5, 'mail', 'su-epsilon', ['WI-205', 'reply to the vendor']),
];

function jpeg(id: string): Promise<Blob> {
  const index = Number(id.replace(/\D+/g, '')) || 0;
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 200;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = COLORS[index % COLORS.length]!; ctx.fillRect(0, 0, 320, 200);
  ctx.fillStyle = '#ffffff'; ctx.font = '20px sans-serif';
  ctx.fillText(`${id} · frame ${window.__thumbnailRequests[id]}`, 12, 104);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/jpeg', 0.8));
}

const fetchImpl: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const thumbnail = /\/api\/deploy\/local-desktops\/([^/]+)\/thumbnail$/.exec(url);
  if (thumbnail) {
    const id = decodeURIComponent(thumbnail[1]!);
    window.__thumbnailRequests[id] = (window.__thumbnailRequests[id] ?? 0) + 1;
    return new Response(await jpeg(id), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  }
  if (url.endsWith('/vnc-session')) {
    const body = JSON.parse(String(init?.body)) as { display: number; mode: string; target: string };
    window.__vncSessions.push(body);
    const row = (window.__desktopGridSync?.rows as LocalDesktopSyncRow[] | undefined)
      ?.find((candidate) => candidate.display === body.display);
    return new Response(JSON.stringify({
      ok: true,
      wsUrl: `ws://127.0.0.1:3078/vnc?ticket=fixture-${body.mode}-${body.display}`,
      desktopSessionId: row?.id ?? null,
      rfb: 'standard',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(null, { status: 404 });
};

function Fixture() {
  return <main>
    <p role="note">Controlled local fixture · roster stream, HTTP and framebuffer are substituted</p>
    <LocalDesktopWorkspace fetchImpl={fetchImpl} />
  </main>;
}

// The first roster snapshot, as the stream would deliver it; later deltas come from the
// spec through window.__desktopGridSync.set (same store: the alias resolves here).
setDesktopGridRows(rows);
createRoot(document.getElementById('root')!).render(<NuqsAdapter><Fixture /></NuqsAdapter>);
