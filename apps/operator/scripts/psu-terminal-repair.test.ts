// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readlinkSync } from 'node:fs';
import { closeInspector, createCdpClient, discoverInspector, type CdpSocket } from '../../../scripts/cdp-inspector.mjs';
import { applyTerminalIdentityRepair, closeLateInspectorWhenAvailable, hasTerminalSafeInspectorPublication, repairTerminalHost, terminalIdentityRepairSource, LEGACY_IDENTITY_FUNCTION } from './psu-terminal-repair.mjs';
import { mockImplementationTyped, mockReturnTyped } from '../../../packages/operator-core/lib/testing/typed-mock';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync), readlinkSync: vi.fn(fs.readlinkSync) };
});
vi.mock('../../../scripts/cdp-inspector.mjs', async (original) => {
  const cdp = await original<typeof import('../../../scripts/cdp-inspector.mjs')>();
  return { ...cdp, discoverInspector: vi.fn(cdp.discoverInspector),
    createCdpClient: vi.fn(cdp.createCdpClient), closeInspector: vi.fn(cdp.closeInspector) };
});

const currentStart = () => String(readFileSync('/proc/' + process.pid + '/stat', 'utf8'))
  .split(')')[1].trim().split(/\s+/)[19];

function cleanupFixture(identity = { pid: process.pid, entry: '/launcher.mjs' }) {
  let polls = 0;
  const client = { connect: vi.fn(async () => {}),
    evaluate: vi.fn(async () => ({ result: { value: identity } })), close: vi.fn() };
  const close = vi.fn(async () => ({ closed: true }));
  return { client, close, options: { pid: process.pid, entry: '/launcher.mjs', started: currentStart(),
    maxWaitMs: 100, pollIntervalMs: 1,
    discover: vi.fn(async () => (++polls === 1 ? null : { port: 9229, wsUrl: 'ws://late' })),
    create: vi.fn(() => client) as any, close: close as any, sleepImpl: async () => {} } };
}

const legacy = LEGACY_IDENTITY_FUNCTION;

describe('terminal identity repair adoption', () => {
  it('requires HTTP-only inspector publication for interactive attachment', () => {
    expect(hasTerminalSafeInspectorPublication({
      environment: 'NODE_OPTIONS=--max-old-space-size=131072 --inspect-publish-uid=http\0',
      cmdline: ['node', '/psu-launcher.mjs'],
    })).toBe(true);
    expect(hasTerminalSafeInspectorPublication({
      environment: 'NODE_OPTIONS=--inspect-publish-uid=http,stderr\0',
    })).toBe(false);
    expect(hasTerminalSafeInspectorPublication({
      environment: 'NODE_OPTIONS=--max-old-space-size=131072\0',
      cmdline: ['node', '--inspect-publish-uid=http', '/psu-launcher.mjs'],
    })).toBe(true);
  });

  it('refuses unknown source and preserves unrelated loaded code byte for byte', () => {
    expect(() => terminalIdentityRepairSource('export function other() {}')).toThrow('Unknown');
    expect(() => terminalIdentityRepairSource(legacy + '\n' + legacy)).toThrow('ambiguous');
    const result = terminalIdentityRepairSource('/* prefix */\n' + legacy + '\n/* suffix */');
    expect(result.needed).toBe(true);
    expect(result.source.startsWith('/* prefix */\n')).toBe(true);
    expect(result.source.endsWith('\n/* suffix */')).toBe(true);
    expect(result.source).toContain('holderPid: nativePid');
    expect(result.source).toContain('if (holder.pid !== nativePid) return null;');
    expect(terminalIdentityRepairSource(result.source).needed).toBe(false);
    expect(terminalIdentityRepairSource('export function readLinuxProcessFlockText() {}\n' + legacy).needed).toBe(false);
  });

  it('does not mutate on preview, refuses a concurrent source change and surfaces V8 rejection', async () => {
    const send = vi.fn(async (method: string, args: any) => {
      if (method === 'Debugger.getScriptSource') return { scriptSource: legacy + '\nchanged' };
      return { status: 'Ok' };
    });
    const client = { send } as any;
    expect((await applyTerminalIdentityRepair(client, { scriptId: '1', source: legacy })).applied).toBe(false);
    expect(send.mock.calls).toHaveLength(1);
    expect(send.mock.calls[0][1].dryRun).toBe(true);
    await expect(applyTerminalIdentityRepair(client, { scriptId: '1', source: legacy, apply: true })).rejects.toThrow('changed after preview');
    expect(send.mock.calls.filter(([, args]) => args.dryRun === undefined && args.scriptSource)).toHaveLength(0);
    send.mockImplementation(async () => ({ status: 'BlockedByActiveFunction' }));
    await expect(applyTerminalIdentityRepair(client, { scriptId: '1', source: legacy, apply: true })).rejects.toThrow('V8 refused');
  });

  it('closes a delayed exact-PID/incarnation target and releases its transport', async () => {
    const { options, client, close } = cleanupFixture();
    await expect(closeLateInspectorWhenAvailable(options)).resolves.toEqual({ closed: true, port: 9229 });
    expect(options.discover).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledWith(client, 9229);
    expect(client.close).toHaveBeenCalled();
  });

  it.each(['pid', 'entry', 'incarnation'])('refuses a delayed target with a different %s', async (field) => {
    const identity = { pid: process.pid, entry: '/launcher.mjs' };
    if (field === 'pid') identity.pid++;
    if (field === 'entry') identity.entry = '/other.mjs';
    const { options, client, close } = cleanupFixture(identity);
    if (field === 'incarnation') options.started = 'not-the-current-incarnation';
    await expect(closeLateInspectorWhenAvailable(options)).resolves.toEqual({ closed: false, reason: 'identity-mismatch' });
    expect(client.evaluate).toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalled();
  });

  it('retains close failures and releases the verified transport', async () => {
    const { options, client, close } = cleanupFixture();
    close.mockRejectedValueOnce(new Error('inspector still open'));
    await expect(closeLateInspectorWhenAvailable(options)).resolves.toMatchObject({
      closed: false, reason: 'cleanup-error', error: 'inspector still open',
    });
    expect(client.close).toHaveBeenCalled();
  });

  it('reports an unresolved activation after its bounded cleanup window', async () => {
    const { options, close } = cleanupFixture();
    options.discover.mockImplementation(async () => null);
    await expect(closeLateInspectorWhenAvailable({ ...options, maxWaitMs: 0 })).resolves.toEqual({
      closed: false, reason: 'activation-timeout',
    });
    expect(close).not.toHaveBeenCalled();
  });

  it('keeps a timed-out repair pending until late cleanup settles and includes its receipt', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const ownerId = 'su-unit-late-inspector';
    const pid = 42;
    const entry = '/fixture/psu-launcher.mjs';
    const stat = '42 (node) ' + ['S', ...Array(18).fill('0'), '123'].join(' ');
    let polls = 0;
    let release!: () => void;
    const closing = new Promise<{ closed: boolean }>(resolve => { release = () => resolve({ closed: true }); });
    const client = { ws: { readyState: 1, send: vi.fn(), close: vi.fn() },
      send: vi.fn(async () => ({})), connect: vi.fn(async () => {}), close: vi.fn(),
      evaluate: vi.fn(async () => ({ result: { value: { pid, entry } } })) };
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    mockImplementationTyped(vi.mocked(readFileSync), (path, ...args) => {
      if (String(path).endsWith(ownerId + '.json')) return JSON.stringify({ pid, ownerId, bridgeTty: true, ptyPid: 43 });
      if (path === '/proc/42/cmdline') return 'node\0' + entry + '\0';
      if (path === '/proc/42/environ') return 'NODE_OPTIONS=--inspect-publish-uid=http\0';
      if (path === '/proc/42/stat') return stat;
      return (actualFs.readFileSync as any)(path, ...args);
    });
    vi.mocked(readlinkSync).mockReturnValue('/usr/bin/node');
    vi.mocked(discoverInspector).mockImplementation(async () => (++polls <= 31 ? null : { port: 9229, wsUrl: 'ws://late' }));
    mockReturnTyped(vi.mocked(createCdpClient<CdpSocket>), client);
    mockImplementationTyped(vi.mocked(closeInspector), () => closing);
    let settled = false;
    const result = repairTerminalHost({ pid, ownerId }).then(
      value => { settled = true; return value; }, error => { settled = true; return error; });
    try {
      await vi.waitFor(() => expect(closeInspector).toHaveBeenCalled(), { timeout: 5000 });
      expect(kill).toHaveBeenCalledWith(pid, 'SIGUSR1');
      expect(settled).toBe(false);
      release();
      const error = await result;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('Terminal inspector did not open');
      expect(error.inspectorCleanup).toEqual({ closed: true, port: 9229 });
    } finally {
      release();
      await result;
      vi.mocked(readFileSync).mockImplementation(actualFs.readFileSync);
      vi.mocked(readlinkSync).mockImplementation(actualFs.readlinkSync);
      kill.mockRestore();
      const cdp = await vi.importActual<typeof import('../../../scripts/cdp-inspector.mjs')>('../../../scripts/cdp-inspector.mjs');
      vi.mocked(discoverInspector).mockImplementation(cdp.discoverInspector);
      vi.mocked(createCdpClient).mockImplementation(cdp.createCdpClient);
      vi.mocked(closeInspector).mockImplementation(cdp.closeInspector);
    }
  }, 10_000);
});
