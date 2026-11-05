import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLiveHealthMonitorSpawnPlan } from './live-health-supervisor';

describe('live-health managed-child topology', () => {
  it('uses explicit Node with the tsx loader in source and bundled self-reexec for packaged/service builds', () => {
    const dev = buildLiveHealthMonitorSpawnPlan({
      selfPath: '/repo/packages/operator-core/lib/resource-governor/live-health-supervisor.ts',
      moduleDirOverride: '/repo/packages/operator-core/lib/resource-governor',
      execPath: '/node',
      spawnerPid: 42,
    });
    expect(dev).toEqual({
      cmd: '/node',
      args: [
        '--import',
        createRequire(import.meta.url).resolve('tsx'),
        '/repo/packages/operator-core/lib/resource-governor/live-health-monitor-bin.ts',
      ],
      env: { PAPERCUSP_DESKTOP_PARENT_PID: '42' },
      mode: 'dev-tsx',
    });

    const bundled = buildLiveHealthMonitorSpawnPlan({
      selfPath: '/app/sidecar/serve.mjs',
      execPath: '/app/sidecar/bin/node',
      spawnerPid: 43,
    });
    expect(bundled).toEqual({
      cmd: '/app/sidecar/bin/node',
      args: ['/app/sidecar/serve.mjs'],
      env: { PAPERCUSP_RESOURCE_GOVERNOR_MONITOR_MODE: '1', PAPERCUSP_DESKTOP_PARENT_PID: '43' },
      mode: 'bundled-reexec',
    });
  });

  it('pins the same default-on divert into desktop, Hono service, and host bootstrap paths', () => {
    const root = join(import.meta.dirname, '../../../../');
    const serve = readFileSync(join(root, 'apps/operator/bin/serve.ts'), 'utf8');
    const hono = readFileSync(join(root, 'apps/operator/bin/hono-host.ts'), 'utf8');
    const bootstrap = readFileSync(join(root, 'apps/operator/bin/host-bootstrap.ts'), 'utf8');
    expect(serve).toContain('PAPERCUSP_RESOURCE_GOVERNOR_MONITOR_MODE');
    expect(serve).toContain('runLiveHealthMonitorMain');
    expect(hono).toContain('resource-health');
    expect(hono).toContain('runLiveHealthMonitorMain');
    expect(bootstrap).toContain('startProcessLiveHealthPublisher');
    expect(bootstrap).toContain('ensureLiveHealthMonitor');
    expect(bootstrap).toMatch(/PAPERCUSP_RESOURCE_GOVERNOR_MONITOR\s*!==\s*["']0["']/);
  });
});
