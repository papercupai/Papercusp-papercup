import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicLinksSnapshot, reconcilePortal } from '../systemd/reconcile-cloud-portal.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'portal-reconcile-'));
  roots.push(root);
  const portalRoot = join(root, 'portal');
  const runtimeRoot = join(root, 'runtime');
  const releasePath = join(runtimeRoot, 'releases', 'release-1');
  mkdirSync(portalRoot, { recursive: true });
  mkdirSync(releasePath, { recursive: true });
  writeFileSync(join(releasePath, '.papercusp-release.json'), JSON.stringify({
    sourceRoot: portalRoot,
    sourceRootDigest: 'root-1',
  }));
  symlinkSync(join('releases', 'release-1'), join(runtimeRoot, 'current'), 'dir');
  return {
    config: {
      portalRoot,
      runtimeRoot,
      integrationRoot: root,
      deployScript: join(root, 'deploy-cloud-portal.sh'),
      npm: 'npm',
      port: 3801,
      publicLinksEnv: join(root, 'portal-public-links.env'),
      env: {},
    },
    release: {
      path: releasePath,
      manifest: { sourceRoot: portalRoot, sourceRootDigest: 'root-1' },
    },
  };
}

function makeDeps(config: any, release: any, overrides: Record<string, unknown> = {}): any {
  let current = release;
  const staged = {
    path: join(config.runtimeRoot, 'releases', 'candidate'),
    manifest: { sourceRoot: config.portalRoot, sourceRootDigest: 'root-1' },
  };
  return {
    fingerprint: vi.fn().mockResolvedValue({ digest: 'linked-1', rootDigest: 'root-1' }),
    releaseAt: vi.fn(async () => current),
    receiptAt: vi.fn().mockResolvedValue(null),
    writeReceipt: vi.fn().mockResolvedValue(undefined),
    candidateAt: vi.fn().mockResolvedValue(null),
    writeCandidate: vi.fn().mockResolvedValue(undefined),
    clearCandidate: vi.fn().mockResolvedValue(undefined),
    releaseNames: vi.fn().mockResolvedValue(['release-1']),
    findStagedRelease: vi.fn().mockResolvedValue(staged),
    promoteRelease: vi.fn(async (_runtimeRoot: string, path: string) => {
      current = path === release.path ? release : { path, manifest: staged.manifest };
      return current;
    }),
    healthy: vi.fn().mockResolvedValue(true),
    run: vi.fn().mockResolvedValue(undefined),
    linkLive: vi.fn().mockResolvedValue(true),
    withHandoffLock: vi.fn(async (handoff: () => Promise<unknown>) => handoff()),
    ...overrides,
  };
}

function immediateDeps(config: any, release: any, overrides: Record<string, unknown> = {}): any {
  return makeDeps(config, release, { stabilityWindowMs: 0, ...overrides });
}

describe('cloud portal source reconciliation', () => {
  it('requires the utility publisher before an acceptance build and loads the maintained snapshot', async () => {
    const { config } = fixture();
    const required = ['NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL'];
    await expect(publicLinksSnapshot(config.publicLinksEnv, {}, { required }))
      .rejects.toThrow('portal_public_links_required:NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL');
    writeFileSync(config.publicLinksEnv, 'NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL=https://releases.example/pui/index.html\n');
    const snapshot = await publicLinksSnapshot(config.publicLinksEnv,
      { NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL: 'https://stale.example/pui/index.html' }, { required });
    expect(snapshot.env.NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL).toBe('https://releases.example/pui/index.html');
    expect(snapshot.links.NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL).toBe(snapshot.env.NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL);
    writeFileSync(config.publicLinksEnv, 'NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL=\n');
    await expect(publicLinksSnapshot(config.publicLinksEnv,
      { NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL: 'https://stale.example/pui/index.html' }, { required }))
      .rejects.toThrow('portal_public_links_required:NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL');
  });

  it('builds with mobile download links and rebuilds when their configuration changes', async () => {
    const { config, release } = fixture();
    const links = 'NEXT_PUBLIC_PORTAL_ANDROID_DOWNLOAD_URL=https://releases.example/android.apk\nNEXT_PUBLIC_PORTAL_IPHONE_DOWNLOAD_URL=https://releases.example/iphone\n';
    writeFileSync(config.publicLinksEnv, links);
    const deps = immediateDeps(config, release);
    await reconcilePortal(config, deps);
    expect(deps.linkLive).toHaveBeenCalledWith('https://releases.example/android.apk');
    expect(deps.linkLive).toHaveBeenCalledWith('https://releases.example/iphone');
    expect(deps.run.mock.calls[0][3]).toMatchObject({
      NEXT_PUBLIC_PORTAL_ANDROID_DOWNLOAD_URL: 'https://releases.example/android.apk',
      NEXT_PUBLIC_PORTAL_IPHONE_DOWNLOAD_URL: 'https://releases.example/iphone',
    });
    deps.receiptAt.mockResolvedValue(deps.writeReceipt.mock.calls[0][1]);
    deps.run.mockClear();
    expect((await reconcilePortal(config, deps)).status).toBe('fresh');
    writeFileSync(config.publicLinksEnv, links.replace('android.apk', 'android-next.apk'));
    expect((await reconcilePortal(config, deps)).status).toBe('deployed');
    expect(deps.run.mock.calls[0][3].NEXT_PUBLIC_PORTAL_ANDROID_DOWNLOAD_URL).toBe('https://releases.example/android-next.apk');
  });

  it('refuses an unreachable Android download before building', async () => {
    const { config, release } = fixture();
    writeFileSync(config.publicLinksEnv, 'NEXT_PUBLIC_PORTAL_ANDROID_DOWNLOAD_URL=https://releases.example/missing.apk\n');
    const deps = immediateDeps(config, release, { linkLive: vi.fn().mockResolvedValue(false) });
    await expect(reconcilePortal(config, deps)).rejects.toThrow('portal_public_links_dead_link:NEXT_PUBLIC_PORTAL_ANDROID_DOWNLOAD_URL');
    expect(deps.run).not.toHaveBeenCalled();
  });

  it('builds with the fingerprinted file snapshot even when the inherited environment is stale', async () => {
    const { config, release } = fixture();
    const links = 'NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL=https://releases.example/pui\nNEXT_PUBLIC_PORTAL_DESKTOP_DOWNLOAD_URL=https://releases.example/desktop\n';
    writeFileSync(config.publicLinksEnv, links);
    config.env = { NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL: 'https://old.example/download' };
    const deps = immediateDeps(config, release);
    const { run, writeReceipt } = deps;
    await reconcilePortal(config, deps);
    expect(deps.linkLive).toHaveBeenCalledWith('https://releases.example/pui');
    expect(deps.linkLive).toHaveBeenCalledWith('https://releases.example/desktop');
    expect(run.mock.calls[0][3]).toMatchObject({
      NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL: 'https://releases.example/pui',
      NEXT_PUBLIC_PORTAL_DESKTOP_DOWNLOAD_URL: 'https://releases.example/desktop',
      PORTAL_BUILD_ONLY: '1',
      PORTAL_PROMOTE: '0',
    });
    const receipt = writeReceipt.mock.calls[0][1];
    deps.receiptAt.mockResolvedValue(receipt);
    run.mockClear();
    expect((await reconcilePortal(config, deps)).status).toBe('fresh');
    expect(run).not.toHaveBeenCalled();
    writeFileSync(config.publicLinksEnv, links.replace('/pui', '/pui-next'));
    expect((await reconcilePortal(config, deps)).status).toBe('deployed');
    expect(run.mock.calls[0][3].NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL).toBe('https://releases.example/pui-next');
  });

  it('refuses to build a Portal whose download link does not resolve (WI-10003250)', async () => {
    const { config, release } = fixture();
    writeFileSync(config.publicLinksEnv, 'NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL=https://releases.example/pui\nNEXT_PUBLIC_PORTAL_DESKTOP_DOWNLOAD_URL=https://releases.example/missing\n');
    const deps = immediateDeps(config, release, {
      linkLive: vi.fn(async (url: string) => !url.endsWith('/missing')),
    });
    await expect(reconcilePortal(config, deps))
      .rejects.toThrow('portal_public_links_dead_link:NEXT_PUBLIC_PORTAL_DESKTOP_DOWNLOAD_URL');
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.writeReceipt).not.toHaveBeenCalled();
  });

  // The child imports the whole module, whose static portal-reconcile-lock.mts import pulls the
  // operator-core resource-lock graph: measured 21.6s of a 24-27s child start at load ~220
  // (WI-6554700010009809), so a 30s cap timed out under gate load. The cap only bounds a hang:
  // without process.exit the setInterval below keeps the child alive forever.
  const ONE_SHOT_CHILD_TIMEOUT_MS = 120_000;
  it('exits a one-shot process after logging even when a dependency keeps a handle open', () => {
    const moduleUrl = new URL('../systemd/reconcile-cloud-portal.mjs', import.meta.url).href;
    const child = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e',
      `import { settleReconcileProcess } from ${JSON.stringify(moduleUrl)}; setInterval(() => {}, 60000); await settleReconcileProcess(Promise.resolve({ status: 'deployed', releasePath: '/tmp/release' }));`,
    ], { encoding: 'utf8', timeout: ONE_SHOT_CHILD_TIMEOUT_MS });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toContain('cloud-portal-reconcile: deployed /tmp/release');
  }, ONE_SHOT_CHILD_TIMEOUT_MS + 10_000);

  it('rebuilds when linked source changes even though rootDigest and release path match', async () => {
    const { config, release } = fixture();
    const deps = immediateDeps(config, release, {
      fingerprint: vi.fn().mockResolvedValue({ digest: 'linked-new', rootDigest: 'root-1' }),
      receiptAt: vi.fn().mockResolvedValue({
        releasePath: release.path,
        sourceDigest: 'linked-old',
        sourceRootDigest: 'root-1',
      }),
    });
    const result = await reconcilePortal(config, deps);
    expect(result.status).toBe('deployed');
    expect(deps.run.mock.calls.map(([command, args]: [string, string[]]) => [command, args])).toEqual([
      ['npm', ['run', 'build']],
      ['bash', [config.deployScript, '--handoff']],
    ]);
    expect(deps.writeReceipt).toHaveBeenCalledWith(
      join(config.runtimeRoot, '.papercusp-reconcile.json'),
      expect.objectContaining({ releasePath: join(config.runtimeRoot, 'releases', 'candidate'), sourceDigest: 'linked-new' }),
    );
    expect(deps.withHandoffLock).toHaveBeenCalledTimes(1);
  });

  it('skips a healthy release with an exact full-source receipt', async () => {
    const { config, release } = fixture();
    const deps = immediateDeps(config, release, {
      fingerprint: vi.fn().mockResolvedValue({ digest: 'linked-1', rootDigest: 'root-1' }),
      publicLinksDigest: vi.fn().mockResolvedValue('links-1'),
      receiptAt: vi.fn().mockResolvedValue({
        releasePath: release.path,
        sourceDigest: 'linked-1',
        sourceRootDigest: 'root-1',
        publicLinksDigest: 'links-1',
      }),
    });
    const result = await reconcilePortal(config, deps);
    expect(result.status).toBe('fresh');
    expect(deps.run).not.toHaveBeenCalled();
  });

  it('rebuilds when the durable public download links change without a source edit', async () => {
    const { config, release } = fixture();
    const deps = immediateDeps(config, release, {
      fingerprint: vi.fn().mockResolvedValue({ digest: 'linked-1', rootDigest: 'root-1' }),
      receiptAt: vi.fn().mockResolvedValue({
        releasePath: release.path,
        sourceDigest: 'linked-1',
        sourceRootDigest: 'root-1',
        publicLinksDigest: 'links-old',
      }),
      publicLinksDigest: vi.fn().mockResolvedValue('links-new'),
    });
    const result = await reconcilePortal(config, deps);
    expect(result.status).toBe('deployed');
    expect(deps.run.mock.calls.map(([command, args]: [string, string[]]) => [command, args])).toEqual([
      ['npm', ['run', 'build']],
      ['bash', [config.deployScript, '--handoff']],
    ]);
    expect(deps.writeReceipt).toHaveBeenCalledWith(
      join(config.runtimeRoot, '.papercusp-reconcile.json'),
      expect.objectContaining({ publicLinksDigest: 'links-new' }),
    );
  });

  it('defers a build if its public-link input changes mid-build', async () => {
    const { config, release } = fixture();
    const deps = immediateDeps(config, release, {
      fingerprint: vi.fn().mockResolvedValue({ digest: 'linked-1', rootDigest: 'root-1' }),
      publicLinksDigest: vi.fn()
        .mockResolvedValueOnce('links-before')
        .mockResolvedValueOnce('links-after'),
    });
    const result = await reconcilePortal(config, deps);
    expect(result).toMatchObject({ status: 'deferred', reason: 'public_links_changed_during_build' });
    expect(deps.run).toHaveBeenCalledTimes(1);
    expect(deps.promoteRelease).not.toHaveBeenCalled();
    expect(deps.writeReceipt).not.toHaveBeenCalled();
  });

  it('keeps current unchanged when the portal root source moves during the build', async () => {
    const { config, release } = fixture();
    const deps = immediateDeps(config, release, {
      fingerprint: vi.fn()
        .mockResolvedValueOnce({ digest: 'linked-before', rootDigest: 'root-1' })
        .mockResolvedValueOnce({ digest: 'linked-after', rootDigest: 'root-2' }),
    });
    const result = await reconcilePortal(config, deps);
    expect(result).toMatchObject({ status: 'deferred', reason: 'root_source_changed_during_build' });
    expect(deps.run).toHaveBeenCalledTimes(1);
    expect(deps.promoteRelease).not.toHaveBeenCalled();
    expect(deps.writeReceipt).not.toHaveBeenCalled();
  });

  it('recovers the existing unhealthy release without waiting for changing source to settle or promoting it', async () => {
    const { config, release } = fixture();
    const candidate = { schemaVersion: 1, sourceDigest: 'linked-before', sourceRootDigest: 'root-1', publicLinksDigest: 'links-1', firstSeenAtMs: 1_000 };
    const deps = makeDeps(config, release, {
      now: () => 2_000,
      fingerprint: vi.fn().mockResolvedValue({ digest: 'linked-changing', rootDigest: 'root-changing' }),
      candidateAt: vi.fn().mockResolvedValue(candidate),
      healthy: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
    });

    expect(await reconcilePortal(config, deps)).toEqual({ status: 'recovered', releasePath: release.path });
    expect(deps.run.mock.calls.map((call: unknown[]) => call.slice(0, 2))).toEqual([
      ['bash', [config.deployScript, '--install-only']],
      ['systemctl', ['--user', 'reset-failed', 'papercusp-cloud-portal.service']],
      ['systemctl', ['--user', 'restart', 'papercusp-cloud-portal.service']],
    ]);
    expect(deps.withHandoffLock).toHaveBeenCalledTimes(1);
    expect(deps.promoteRelease).not.toHaveBeenCalled();
    expect(deps.writeReceipt).not.toHaveBeenCalled();
    expect(deps.clearCandidate).not.toHaveBeenCalled();
    expect(realpathSync(join(config.runtimeRoot, 'current'))).toBe(release.path);
  });

  it('raises failed existing-release recovery instead of reporting a healthy source deferral', async () => {
    const { config, release } = fixture();
    const deps = makeDeps(config, release, { healthy: vi.fn().mockResolvedValue(false) });
    await expect(reconcilePortal(config, deps)).rejects.toThrow('portal_recovery_health_failed');
    expect(deps.promoteRelease).not.toHaveBeenCalled();
    expect(deps.writeReceipt).not.toHaveBeenCalled();
  });

  it('waits for a whole-source digest to remain stable for ten minutes before building', async () => {
    const { config, release } = fixture();
    let time = 1_000;
    let candidate: any = null;
    let digest = 'linked-before';
    const deps = makeDeps(config, release, {
      now: () => time,
      fingerprint: vi.fn(async () => ({ digest, rootDigest: 'root-1' })),
      candidateAt: vi.fn(async () => candidate),
      writeCandidate: vi.fn(async (_path: string, value: any) => { candidate = value; }),
      clearCandidate: vi.fn(async () => { candidate = null; }),
    });

    expect((await reconcilePortal(config, deps)).status).toBe('deferred');
    expect(deps.run).not.toHaveBeenCalled();
    time += 6 * 60 * 1000;
    digest = 'linked-after-change';
    expect((await reconcilePortal(config, deps)).status).toBe('deferred');
    expect(deps.run).not.toHaveBeenCalled();
    time += 5 * 60 * 1000;
    expect((await reconcilePortal(config, deps)).status).toBe('deferred');
    expect(deps.run).not.toHaveBeenCalled();
    time += 5 * 60 * 1000;
    expect((await reconcilePortal(config, deps)).status).toBe('deployed');
    expect(deps.run.mock.calls[0][3]).toMatchObject({ PORTAL_BUILD_ONLY: '1', PORTAL_PROMOTE: '0' });
    expect(deps.run).toHaveBeenCalledTimes(2);
    expect(candidate).toBeNull();
  });

  it('leaves current untouched if the root digest changes at the final pre-promotion check', async () => {
    const { config, release } = fixture();
    const deps = immediateDeps(config, release, {
      fingerprint: vi.fn()
        .mockResolvedValueOnce({ digest: 'linked-1', rootDigest: 'root-1' })
        .mockResolvedValueOnce({ digest: 'linked-1', rootDigest: 'root-1' })
        .mockResolvedValueOnce({ digest: 'linked-2', rootDigest: 'root-2' }),
    });

    const result = await reconcilePortal(config, deps);
    expect(result).toMatchObject({ status: 'deferred', reason: 'root_source_changed_before_promotion' });
    expect(deps.promoteRelease).not.toHaveBeenCalled();
    expect(deps.writeReceipt).not.toHaveBeenCalled();
  });

  it('builds after thirty minutes of changing fingerprints across timer invocations', async () => {
    const { config, release } = fixture();
    let time = 1_000;
    let candidate: any = null;
    let digest = 'linked-0';
    const overrides = {
      now: () => time,
      fingerprint: vi.fn(async () => ({ digest, rootDigest: 'root-1' })),
      candidateAt: vi.fn(async () => candidate),
      writeCandidate: vi.fn(async (_path: string, value: any) => { candidate = value; }),
      clearCandidate: vi.fn(async () => { candidate = null; }),
    };
    for (let tick = 0; tick < 6; tick += 1) {
      digest = `linked-${tick}`;
      const deps = makeDeps(config, release, overrides);
      expect((await reconcilePortal(config, deps)).status).toBe('deferred');
      expect(deps.run).not.toHaveBeenCalled();
      expect(candidate.pendingSinceAtMs).toBe(1_000);
      time += 5 * 60 * 1000;
    }
    digest = 'linked-final';
    const deps = makeDeps(config, release, overrides);
    expect((await reconcilePortal(config, deps)).status).toBe('deployed');
    expect(deps.run.mock.calls[0][3]).toMatchObject({ PORTAL_BUILD_ONLY: '1', PORTAL_PROMOTE: '0' });
    expect(candidate).toBeNull();
  });

  it('retains source validation after the deferral expires, including old candidate receipts', async () => {
    const { config, release } = fixture();
    const deps = makeDeps(config, release, {
      now: () => 1_000 + 30 * 60 * 1000,
      candidateAt: vi.fn().mockResolvedValue({
        schemaVersion: 1, sourceDigest: 'old', sourceRootDigest: 'root-1',
        publicLinksDigest: 'old-links', firstSeenAtMs: 1_000,
      }),
      fingerprint: vi.fn()
        .mockResolvedValueOnce({ digest: 'linked-1', rootDigest: 'root-1' })
        .mockResolvedValueOnce({ digest: 'linked-2', rootDigest: 'root-2' }),
    });
    expect(await reconcilePortal(config, deps)).toMatchObject({
      status: 'deferred', reason: 'root_source_changed_during_build',
    });
    expect(deps.run).toHaveBeenCalledTimes(1);
    expect(deps.promoteRelease).not.toHaveBeenCalled();
    expect(deps.writeReceipt).not.toHaveBeenCalled();
  });

  it('stages a release and atomically promotes it only after the final source check', async () => {
    const { config } = fixture();
    const stagedPath = join(config.runtimeRoot, 'releases', 'release-2');
    const run = vi.fn(async (command: string, _args: string[], _cwd: string, env: Record<string, string>) => {
      if (command === 'npm') {
        expect(env).toMatchObject({ PORTAL_BUILD_ONLY: '1', PORTAL_PROMOTE: '0' });
        mkdirSync(stagedPath, { recursive: true });
        writeFileSync(join(stagedPath, '.papercusp-release.json'), JSON.stringify({
          sourceRoot: config.portalRoot,
          sourceRootDigest: 'root-1',
        }));
      }
    });
    const deps = {
      stabilityWindowMs: 0,
      fingerprint: vi.fn().mockResolvedValue({ digest: 'linked-1', rootDigest: 'root-1' }),
      run,
      healthy: vi.fn().mockResolvedValue(true),
      withHandoffLock: vi.fn(async (handoff: () => Promise<unknown>) => handoff()),
    };

    const result = await reconcilePortal(config, deps);
    expect(result).toEqual({ status: 'deployed', releasePath: stagedPath });
    expect(realpathSync(join(config.runtimeRoot, 'current'))).toBe(stagedPath);
    expect(run.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ['npm', ['run', 'build']],
      ['bash', [config.deployScript, '--handoff']],
    ]);
  });

  it('restores the prior current release if the health-checked handoff fails', async () => {
    const { config, release } = fixture();
    const deps = immediateDeps(config, release, {
      run: vi.fn(async (command: string) => {
        if (command === 'bash') throw new Error('handoff_failed');
      }),
    });
    await expect(reconcilePortal(config, deps)).rejects.toThrow('handoff_failed');
    expect(deps.promoteRelease.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      join(config.runtimeRoot, 'releases', 'candidate'),
      release.path,
    ]);
    await expect(deps.releaseAt()).resolves.toEqual(release);
    expect(deps.writeReceipt).not.toHaveBeenCalled();
  });

  it('hands off linked-source drift while retaining the earlier digest for the next tick', async () => {
    const { config, release } = fixture();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = immediateDeps(config, release, {
      fingerprint: vi.fn()
        .mockResolvedValueOnce({ digest: 'linked-before', rootDigest: 'root-1' })
        .mockResolvedValueOnce({ digest: 'linked-during-build', rootDigest: 'root-1' })
        .mockResolvedValueOnce({ digest: 'linked-after-handoff', rootDigest: 'root-1' }),
    });
    const result = await reconcilePortal(config, deps);
    expect(result.status).toBe('deployed');
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('linked sources changed during build'));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('linked sources changed before promotion'));
    warning.mockRestore();
    expect(deps.withHandoffLock).toHaveBeenCalledTimes(1);
    expect(deps.writeReceipt).toHaveBeenCalledWith(
      join(config.runtimeRoot, '.papercusp-reconcile.json'),
      expect.objectContaining({ sourceDigest: 'linked-before', sourceRootDigest: 'root-1' }),
    );
  });

  it('keeps the reconcile service below interactive CPU and IO work', () => {
    const template = readFileSync(new URL('../systemd/papercusp-cloud-portal-reconcile.service.in', import.meta.url), 'utf8');
    expect(template).toContain('CPUWeight=10');
    expect(template).toContain('IOWeight=10');
    expect(template).toContain('IOSchedulingClass=idle');
  });
});
