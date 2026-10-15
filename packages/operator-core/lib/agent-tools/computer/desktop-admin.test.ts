/**
 * desktop-admin.test.ts — the explicit per-hive desktop lease tools
 * (computer:provision_desktop / release_desktop / list_desktops, Gap A). Driven through
 * the injectable provisioner seam so no real Xvfb is spawned; asserts the handler output
 * shape + the lease-Map side effects.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const desktopRegistry = vi.hoisted(() => ({
  registerDesktopSession: vi.fn(async (input: { scope: string; scopeRef: string; name?: string | null }) => ({
    id: 'desktop-admin-test-session',
    ...input,
  })),
  markDesktopReady: vi.fn(async () => undefined),
  closeDesktopSession: vi.fn(async () => true),
  resolveDesktopForScope: vi.fn(async (): Promise<unknown> => undefined),
  getDesktopSession: vi.fn(async (): Promise<unknown> => undefined),
  listDesktopSessions: vi.fn(async (): Promise<unknown[]> => []),
}));
vi.mock('../../desktop/desktop-session-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../desktop/desktop-session-registry')>()),
  ...desktopRegistry,
}));

const headroomAdmission = vi.hoisted(() =>
  vi.fn(async (): Promise<unknown> => ({ verdict: { admit: true }, releasable: [] })),
);
vi.mock('./desktop-headroom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./desktop-headroom')>()),
  admitNewDesktop: headroomAdmission,
}));

import {
  __setProvisionerForTests,
  __resetProvisioner,
  releaseAllHiveDesktops,
  releaseDesktop,
  leasedHiveDesktops,
} from './desktop-lease';
import type { DesktopAppDiagnostic, ProvisionOptions, SandboxDesktop } from './desktop-provisioner';
import { NO_GL_STRATEGY } from '../../desktop/gl-strategy';
import provisionTool from './provision-desktop';
import releaseTool from './release-desktop';
import listTool from './list-desktops';

type Tool = { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> };
const parse = (r: { content: Array<{ text: string }> }): Record<string, unknown> => JSON.parse(r.content[0].text);
const CTX = {} as never;

const provision = provisionTool as unknown as Tool;
const release = releaseTool as unknown as Tool;
const list = listTool as unknown as Tool;

/** A fake provisioner that records the opts it was handed and hands back a fake desktop. */
function fakeProvisioner(diagnostics: DesktopAppDiagnostic[] = []) {
  const seen: ProvisionOptions[] = [];
  let n = 200;
  __setProvisionerForTests(async (opts) => {
    seen.push(opts ?? {});
    const display = `:${n++}`;
    const d: SandboxDesktop = {
      display,
      number: Number(display.slice(1)),
      width: opts?.width ?? 1024,
      height: opts?.height ?? 768,
      // No live X server here, so no GL was measured — the honest zero value.
      gl: NO_GL_STRATEGY,
      // WI-1223202: nothing was probed at all here, so it was certainly not probed inside a
      // sandbox. `false` is the honest value, not a placeholder.
      glProbeSandboxed: false,
      // WI-1105361: by default this fake spawned no apps, so there is nothing to diagnose.
      // Selected tests inject one row to check that the handler returns it unchanged.
      appDiagnostics: () => diagnostics,
      // P-012: the default local backend, for the same reason the GL value is the zero
      // one — nothing was really started, so claiming the KasmVNC backend would assert
      // a listener this fake does not have.
      xServer: 'xvfb',
      // P-005: no task ledger in a fake provisioner — the honest "unenrolled"
      // value, which is exactly what the governor reports as unfreezable.
      taskId: null,
      release: async () => {},
    };
    return d;
  });
  return seen;
}

describe('computer desktop-lease admin tools', () => {
  afterEach(async () => {
    await releaseAllHiveDesktops();
    __resetProvisioner();
  });

  it('provision_desktop stands up a sandbox display for a hive and forwards apps/geometry', async () => {
    const seen = fakeProvisioner();
    const r = parse(await provision.handler({ pot: 'demo', apps: [['firefox']], width: 800, height: 600 }, CTX));
    expect(r.ok).toBe(true);
    expect(r.pot).toBe('demo');
    expect(typeof r.display).toBe('string');
    expect((r.display as string).startsWith(':')).toBe(true);
    expect(r.display).not.toBe(':0'); // never the host
    expect(r.reused).toBe(false);
    expect(r.width).toBe(800);
    expect(seen[0]).toMatchObject({ apps: [['firefox']], width: 800, height: 600 }); // forwarded to the provisioner
    expect(leasedHiveDesktops()).toContain('demo');
  });

  it('provision_desktop is idempotent — a second call reuses the lease (reused:true), no relaunch', async () => {
    const seen = fakeProvisioner();
    const first = parse(await provision.handler({ pot: 'demo' }, CTX));
    const second = parse(await provision.handler({ pot: 'demo', apps: [['xterm']] }, CTX));
    expect(second.reused).toBe(true);
    expect(second.display).toBe(first.display); // same desktop
    expect(seen).toHaveLength(1); // provisioner called ONCE — apps on the 2nd call are not relaunched
  });

  it('provision_desktop returns bounded diagnostics for apps on the caller-owned lease', async () => {
    const ownerId = 'desktop-admin-test-owner';
    const name = 'diagnostics-test';
    const diagnostic: DesktopAppDiagnostic = {
      argv: ['firefox', '--no-remote'],
      pid: 4242,
      alive: false,
      exitCode: 46,
      exitSignal: null,
      stderrTail: '[VGL] ERROR: display initialization failed',
    };
    const seen = fakeProvisioner([diagnostic]);
    const ctx = { isSuperuser: true, uiClientId: ownerId, harnessSlug: 'papercusp' };
    try {
      desktopRegistry.listDesktopSessions.mockResolvedValue([]);
      const r = parse(await provision.handler({ name, apps: [['firefox', '--no-remote']] }, ctx));
      expect(r.ok).toBe(true);
      expect(r.appDiagnostics).toEqual([diagnostic]);
      expect(seen[0]).toMatchObject({ apps: [['firefox', '--no-remote']] });
    } finally {
      await releaseDesktop({ scope: 'agent', ownerId, name, harnessSlug: 'papercusp' });
      desktopRegistry.listDesktopSessions.mockReset();
      desktopRegistry.registerDesktopSession.mockReset();
      desktopRegistry.markDesktopReady.mockReset();
      desktopRegistry.closeDesktopSession.mockReset();
      headroomAdmission.mockReset();
      await releaseAllHiveDesktops();
    }
  });

  it('list_desktops reports every leased hive with its display/geometry', async () => {
    fakeProvisioner();
    await provision.handler({ pot: 'alpha' }, CTX);
    await provision.handler({ pot: 'beta', width: 1280, height: 720 }, CTX);
    const r = parse(await list.handler({}, CTX));
    expect(r.count).toBe(2);
    const rows = r.desktops as Array<{ pot: string; display: string; width: number }>;
    expect(rows.map((d) => d.pot).sort()).toEqual(['alpha', 'beta']);
    expect(rows.find((d) => d.pot === 'beta')?.width).toBe(1280);
  });

  it('release_desktop tears down the lease (released:true), then is a no-op (released:false)', async () => {
    fakeProvisioner();
    await provision.handler({ pot: 'demo' }, CTX);
    const r1 = parse(await release.handler({ pot: 'demo' }, CTX));
    expect(r1.released).toBe(true);
    expect(leasedHiveDesktops()).not.toContain('demo');
    const r2 = parse(await release.handler({ pot: 'demo' }, CTX));
    expect(r2.released).toBe(false); // idempotent no-op
  });
});
