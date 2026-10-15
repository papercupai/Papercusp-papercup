/**
 * The local desktop thumbnail route's admission boundary (plan
 * agent-multi-desktops-grid-2026-10-06, P-005).
 *
 * WHY: this host also runs the owner's real X session. The route grabs pixels from
 * whatever display it resolves, so the only thing standing between a grid tile and a
 * screenshot of the human's own desktop is which registry rows it agrees to resolve.
 * Every refusal below is silent in the UI ("no recent frame"), so a regression would
 * never surface as an error — it is pinned here.
 */
import { describe, expect, it, vi } from 'vitest';
import { localDesktopThumbnail } from './local-desktop-thumbnail';
import type { DesktopSessionRecord } from '../../../desktop/desktop-session-registry';

const rec = (over: Partial<DesktopSessionRecord> = {}): DesktopSessionRecord => ({
  id: 'ds-1',
  workspaceId: 'ws',
  harnessSlug: 'alpha',
  kind: 'xvfb-local',
  scope: 'agent',
  scopeRef: 'su-1',
  name: 'browser',
  hostRef: null,
  ownerPid: 1,
  ownerBootId: 'boot',
  display: ':112',
  displayGeometry: { width: 1280, height: 1024, depth: 24 },
  captureGeometry: { width: 1024, height: 768 },
  state: 'ready',
  leaseHolder: null,
  viewerMode: 'none',
  viewerActor: null,
  capabilities: {},
  ttlSec: null,
  taskId: null,
  idleAfterSec: null,
  frozenAt: null,
  createdAt: new Date(),
  lastActiveAt: new Date(),
  releasedAt: null,
  ...over,
});

const frame = Buffer.from([0xff, 0xd8, 0x01]);

describe('localDesktopThumbnail (P-005)', () => {
  it('grabs the registered local display of a live desktop', async () => {
    const thumbnail = vi.fn(async () => frame);
    const out = await localDesktopThumbnail('ds-1', { getSession: async () => rec(), thumbnail });
    expect(out).toEqual({ jpeg: frame });
    expect(thumbnail).toHaveBeenCalledWith(112);
  });

  it.each([
    ['unknown', undefined],
    ['remote', rec({ hostRef: 'vm-7' })],
    ['frozen', rec({ state: 'frozen' })],
    ['bad-display', rec({ display: 'not-a-display' })],
  ] as const)('refuses to grab anything for a %s desktop', async (miss, session) => {
    const thumbnail = vi.fn(async () => frame);
    const out = await localDesktopThumbnail('ds-1', { getSession: async () => session, thumbnail });
    expect(out).toEqual({ miss });
    expect(thumbnail).not.toHaveBeenCalled();
  });

  it('answers no-frame when the grab yields nothing', async () => {
    const out = await localDesktopThumbnail('ds-1', { getSession: async () => rec(), thumbnail: async () => null });
    expect(out).toEqual({ miss: 'no-frame' });
  });
});
