import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  createSupervisionReconcileHandler,
  parseSystemdDropInCheckOutput,
  runSystemdDropInInstallCheck,
  type DropInCheckExecutor,
  type DropInInstallCheckResult,
} from './supervision-reconcile-action';
import { registerSystemAction, type SystemAction, type SystemActionCtx } from './system-actions';
import { reconcileTick, type ReconcilerDeps } from '../../supervision/unit-reconciler';

// Capture what the module REGISTERS, and what that registration hands the reconciler. The
// cases below that build their own handler inject every dependency, so these mocks only
// affect the registered production path.
vi.mock('./system-actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./system-actions')>()),
  registerSystemAction: vi.fn(),
}));
vi.mock('../../supervision/unit-reconciler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../supervision/unit-reconciler')>()),
  reconcileTick: vi.fn(async () => ({ checked: 0, actions: [], degraded: false })),
}));
// The registered drop-in check would fork a host script through the sidecar; refuse it so the
// sample reads 'unavailable' and nothing runs on the host.
vi.mock('../../fleet/git-via-sidecar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../fleet/git-via-sidecar')>()),
  execFileViaSidecar: vi.fn(async () => {
    throw new Error('sidecar disabled in test');
  }),
}));

const ctx = {
  installSlug: 'papercusp',
  workspaceId: 'papercusp-workspace',
  triggerConfig: {},
  payloadTemplate: null,
} as SystemActionCtx;

describe('systemd drop-in periodic check', () => {
  it('parses a measured missing population and its affected units', () => {
    const result = parseSystemdDropInCheckOutput(
      [
        '=== tracked systemd drop-ins (measured population) ===',
        '  INSTALLED    papercup-dev-api.service  20-start.conf',
        '  MISSING      gnome-terminal-server.service  10-survive-bus-drop.conf',
        '',
        'installed=1 missing=1 unit-absent=0',
      ].join('\n'),
    );

    expect(result).toEqual({
      status: 'missing',
      installed: 1,
      missingCount: 1,
      unitAbsent: 0,
      missing: [{ unit: 'gnome-terminal-server.service', confName: '10-survive-bus-drop.conf' }],
    });
  });

  it('does not resolve from a skipped, empty, or malformed sample', () => {
    expect(parseSystemdDropInCheckOutput('systemd drop-in install check: SKIPPED — no user systemd manager reachable.').status)
      .toBe('skipped');
    expect(parseSystemdDropInCheckOutput('systemd drop-in install check: no tracked *.service.d/*.conf found — nothing to verify.').status)
      .toBe('unavailable');
    expect(parseSystemdDropInCheckOutput('installed=2 missing=1 unit-absent=0').status).toBe('unavailable');
    expect(
      parseSystemdDropInCheckOutput(
        '  UNIT-ABSENT    gnome-terminal-server.service  10-survive-bus-drop.conf  (systemctl show failed)\n' +
          'installed=0 missing=0 unit-absent=1',
      ).status,
    ).toBe('unavailable');
  });

  it('runs the existing host checker with --list and a bounded timeout', async () => {
    let call: { command: string; args: string[]; options: Parameters<DropInCheckExecutor>[2] } | undefined;
    const execute: DropInCheckExecutor = async (command, args, options) => {
      call = { command, args, options };
      return {
        stdout: '  INSTALLED    gnome-terminal-server.service  10-survive-bus-drop.conf\ninstalled=1 missing=0 unit-absent=0',
        stderr: '',
      };
    };

    const result = await runSystemdDropInInstallCheck(execute);

    expect(result.status).toBe('healthy');
    expect(call?.command).toBe(process.execPath);
    expect(call?.args[0]).toMatch(/scripts\/check-systemd-dropins-installed\.mjs$/);
    expect(call && existsSync(call.args[0])).toBe(true);
    expect(call?.args[1]).toBe('--list');
    expect(call?.options.timeout).toBe(30_000);
  });

  it('records a durable condition when a periodic sample has missing drop-ins', async () => {
    const order: string[] = [];
    const check: DropInInstallCheckResult = {
      status: 'missing',
      installed: 37,
      missingCount: 1,
      unitAbsent: 0,
      missing: [{ unit: 'gnome-terminal-server.service', confName: '10-survive-bus-drop.conf' }],
    };
    const fileMissing = vi.fn(async () => 'EI-1');
    const resolveMissing = vi.fn(async () => []);
    const handler = createSupervisionReconcileHandler({
      reconcile: async () => { order.push('reconcile'); },
      checkDropIns: async () => { order.push('check'); return check; },
      fileMissing: async (episode) => {
        order.push('file');
        expect(episode.missingCount).toBe(1);
        return fileMissing();
      },
      resolveMissing,
    });

    const result = await handler(ctx);

    expect(order).toEqual(['reconcile', 'check', 'file']);
    expect(fileMissing).toHaveBeenCalledTimes(1);
    expect(resolveMissing).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      diagnostics: {
        conditionAction: 'file',
        conditionIds: ['EI-1'],
        systemdDropInInstall: { status: 'missing', missingCount: 1 },
      },
    });
  });

  it('resolves only after a measured clean sample', async () => {
    const resolveMissing = vi.fn(async () => ['EI-1']);
    const handler = createSupervisionReconcileHandler({
      reconcile: async () => {},
      checkDropIns: async () => ({
        status: 'healthy',
        installed: 38,
        missingCount: 0,
        unitAbsent: 0,
        missing: [],
      }),
      fileMissing: async () => 'unexpected',
      resolveMissing,
    });

    const result = await handler(ctx);

    expect(resolveMissing).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ diagnostics: { conditionAction: 'resolve', conditionIds: ['EI-1'] } });
  });

  it.each(['skipped', 'unavailable'] as const)(
    'preserves an open condition when the checker sample is %s',
    async (status) => {
      const resolveMissing = vi.fn(async () => ['EI-1']);
      const fileMissing = vi.fn(async () => 'unexpected');
      const handler = createSupervisionReconcileHandler({
        reconcile: async () => {},
        checkDropIns: async () => ({
          status,
          installed: null,
          missingCount: null,
          unitAbsent: null,
          missing: [],
        }),
        fileMissing,
        resolveMissing,
      });

      const result = await handler(ctx);

      expect(fileMissing).not.toHaveBeenCalled();
      expect(resolveMissing).not.toHaveBeenCalled();
      expect(result).toMatchObject({ diagnostics: { conditionAction: 'unchanged' } });
    },
  );
});

describe('registered supervision-reconcile routine (reboot-residue R-004a, D-004)', () => {
  it('asks the reconciler for the failed-unit census on every tick', async () => {
    // D-004: agenticmail and llama-ornith sat failed for days because nothing reported a
    // failed user unit outside the supervised registry. The census only runs when the
    // routine passes failedUnitCensus:true, so this pins the wiring, not just the census.
    const registration = vi
      .mocked(registerSystemAction)
      .mock.calls.find(([name]) => name === 'supervision-reconcile');
    // Positive control: the module really registered the routine and a tick reaches the
    // reconciler, or the census assertion below would be vacuous.
    expect(registration).toBeDefined();
    const handler = registration![1] as SystemAction;
    vi.mocked(reconcileTick).mockClear();

    await handler(ctx);

    expect(reconcileTick).toHaveBeenCalledTimes(1);
    const deps = vi.mocked(reconcileTick).mock.calls[0][0] as ReconcilerDeps;
    expect(deps.failedUnitCensus).toBe(true);
  });
});
