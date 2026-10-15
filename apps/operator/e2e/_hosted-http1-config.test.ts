import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isForcedHttp1,
  readHostedHttp1AcceptanceConfig,
  readHostedWorkspaceAcceptanceBinding,
  readHostedWorkspaceAcceptanceIdentity,
  redactEvidenceUrl,
} from './_hosted-http1-config';

const dirs: string[] = [];

function storageState(mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), 'p029-http1-config-'));
  dirs.push(dir);
  const file = join(dir, 'state.json');
  writeFileSync(file, '{"cookies":[],"origins":[]}\n', { mode });
  chmodSync(file, mode);
  return file;
}

afterEach(() => {
  // Temp files intentionally age out with the system tmp cleaner. Avoid a
  // recursive delete in a test that exists partly to guard credential files.
  dirs.length = 0;
});

describe('real hosted workspace acceptance identity joins', () => {
  const target = { organizationId: 'tenant-a', workspaceId: 'workspace-a', hostId: 'host-a' };
  const session = { sessionId: 'session-a', userId: 'user-a', organizationId: 'tenant-a',
    workspaceId: 'workspace-a', permissionVersion: 3 };
  const frame = { type: 'session.bound', protocol: 'papercusp-hosted-workspace.v1',
    channelId: 'channel-a', kind: 'pty', role: 'controller', binding: {
      organizationId: 'tenant-a', customerWorkspaceId: 'workspace-a', hostId: 'host-a',
      hostedSessionId: 'session-a', generation: 7,
    } };
  const expected = { kind: 'pty' as const, role: 'controller' as const, generation: 7 };
  const identity = () => readHostedWorkspaceAcceptanceIdentity({ ok: true, session }, target);

  it('joins legitimate PTY, resume and desktop channels and strips unrelated private data', () => {
    const principal = readHostedWorkspaceAcceptanceIdentity({ ok: true,
      identity: { primaryEmail: 'private@example.test' },
      session: { ...session, cookie: 'private-cookie', upstreamToken: 'private-token' } }, target);
    expect(principal).toEqual(session);
    expect(readHostedWorkspaceAcceptanceIdentity({ ok: true,
      session: { ...session, permissionVersion: 0 } }, target).permissionVersion).toBe(0);
    expect(readHostedWorkspaceAcceptanceBinding(frame, principal, target, expected)).toEqual({
      channelId: 'channel-a', kind: 'pty', role: 'controller', ...frame.binding,
    });
    for (const role of ['observer', 'controller'] as const) {
      expect(readHostedWorkspaceAcceptanceBinding({ ...frame, kind: 'desktop', role },
        principal, target, { ...expected, kind: 'desktop', role })).toMatchObject({
        kind: 'desktop', role, generation: 7,
      });
    }
  });

  it.each([
    { organizationId: 'tenant-b' }, { workspaceId: 'workspace-b' },
    { sessionId: '' }, { userId: undefined }, { permissionVersion: -1 },
  ])('refuses a wrong or incomplete browser identity: %j', (change) => {
    expect(() => readHostedWorkspaceAcceptanceIdentity({ ok: true,
      session: { ...session, ...change } }, target)).toThrow(/hosted acceptance/);
  });

  it.each([
    { organizationId: 'tenant-b' }, { customerWorkspaceId: 'workspace-b' },
    { hostId: 'host-b' }, { hostedSessionId: 'session-b' },
    { generation: 0 }, { generation: 8 }, { generation: '7' },
  ])('refuses a contradictory connector binding before guest writes: %j', (change) => {
    expect(() => readHostedWorkspaceAcceptanceBinding({ ...frame,
      binding: { ...frame.binding, ...change } }, identity(), target, expected))
      .toThrow(/connector binding does not match/);
  });

  it.each([{ kind: 'desktop' }, { role: 'observer' }, { protocol: 'old-protocol' },
    { type: 'pty.ready' }, { channelId: '' }])('refuses a degraded or unbound channel: %j', (change) => {
    expect(() => readHostedWorkspaceAcceptanceBinding({ ...frame, ...change },
      identity(), target, expected)).toThrow(/hosted acceptance/);
  });
});

describe('hosted HTTP/1.1 acceptance configuration', () => {
  it('requires a private storage-state file and exact HTTPS origin', () => {
    const state = storageState();
    const config = readHostedHttp1AcceptanceConfig({
      PAPERCUSP_HOSTED_ACCEPTANCE_STORAGE_STATE: state,
      PAPERCUSP_HOSTED_ACCEPTANCE_ORIGIN: 'https://app.papercusp.com',
      PAPERCUSP_HOSTED_ACCEPTANCE_PROXY: 'socks5://127.0.0.1:18029',
    });
    expect(config.origin).toBe('https://app.papercusp.com');
    expect(config.storageStatePath).toBe(state);
    expect(config.proxyServer).toBe('socks5://127.0.0.1:18029');

    expect(() =>
      readHostedHttp1AcceptanceConfig({
        PAPERCUSP_HOSTED_ACCEPTANCE_STORAGE_STATE: state,
        PAPERCUSP_HOSTED_ACCEPTANCE_ORIGIN: 'https://user:pw@app.papercusp.com/path',
      }),
    ).toThrow(/exact HTTPS origin/);
    expect(() =>
      readHostedHttp1AcceptanceConfig({
        PAPERCUSP_HOSTED_ACCEPTANCE_STORAGE_STATE: storageState(0o644),
      }),
    ).toThrow(/chmod 600/);
    expect(() =>
      readHostedHttp1AcceptanceConfig({
        PAPERCUSP_HOSTED_ACCEPTANCE_STORAGE_STATE: state,
        PAPERCUSP_HOSTED_ACCEPTANCE_PROXY: 'socks5://storewolf:18029',
      }),
    ).toThrow(/loopback SOCKS5/);
  });

  it('rejects absent auth instead of silently running anonymous acceptance', () => {
    expect(() => readHostedHttp1AcceptanceConfig({})).toThrow(/STORAGE_STATE is required/);
  });

  it('redacts query and fragment data and accepts only measured HTTP\/1.1', () => {
    expect(redactEvidenceUrl('https://app.papercusp.com/a?ticket=secret#x')).toBe(
      'https://app.papercusp.com/a',
    );
    expect(isForcedHttp1('http/1.1')).toBe(true);
    expect(isForcedHttp1('h2')).toBe(false);
    expect(isForcedHttp1('h3')).toBe(false);
  });
});
