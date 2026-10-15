import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLoopbackIdentitySpawn, LOOPBACK_IDENTITY_WRAPPER_SOURCE, type AgentSpawnTransform } from '@papercusp/papercusp-shared/agent';
import { createHostedPrincipalResolver, type HostedPrincipalResolver } from '../auth/hosted-principal-resolver';
import { HOSTED_SESSION_COOKIE, HostedSessionCookieCodec, type HostedSession } from '../auth/hosted-session';
import { hostedPermissionsForMembership } from '../auth/hosted-role-permissions';
import { bindHostedCustomerCommandExecutor } from './hosted-customer-command';

vi.mock('../task-manager/enroll-sync', () => ({
  beginSyncEnrolment: vi.fn(() => ({ taskId: 'testcustomertask', enrolled: true })),
  completeSyncEnrolment: vi.fn(), finishSyncEnrolment: vi.fn(),
}));

let root: string, home: string, project: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'customer-command-'));
  home = join(root, 'customer-home');
  project = join(home, "project ' $literal");
  mkdirSync(project, { recursive: true });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function authority() {
  const now = new Date();
  const session: HostedSession = {
    id: `hs_${'A'.repeat(43)}`, userId: 'customer-user', organizationId: 'customer-org',
    workspaceId: 'customer-workspace', permissionVersion: 1, upstreamProvider: 'workos',
    upstreamSessionId: 'upstream', createdAt: now, rotatedAt: null,
    expiresAt: new Date(now.getTime() + 60_000), lastSeenAt: null,
    revokedAt: null, revocationReason: null, updatedAt: now,
  };
  let role = 'member' as 'member' | 'billing';
  let active = true, owned = true, version = 1;
  const codec = new HostedSessionCookieCodec('test-cookie-key-'.repeat(3));
  const headers = new Headers({ cookie: `${HOSTED_SESSION_COOKIE}=${codec.encode(session.id)}` });
  const resolver = createHostedPrincipalResolver({
    controlPlaneWorkspaceId: 'control-workspace', sessionCookieCodec: codec,
    sessionStore: { async resolve(id) {
      return id === session.id && !session.revokedAt && session.expiresAt.getTime() > Date.now()
        ? { ...session } : null;
    } },
    membershipAuthority: {
      async resolveActive({ userId, organizationId }) {
        return active ? { userId, organizationId, role, status: 'active', permissionVersion: version,
          permissions: hostedPermissionsForMembership({ role, status: 'active' }) } : null;
      },
      async workspaceBelongsToOrganization({ customerWorkspaceId }) {
        return owned && customerWorkspaceId === 'customer-workspace';
      },
    },
  });
  return { session, headers, resolve: vi.fn(resolver),
    demote: () => { role = 'billing'; }, deactivate: () => { active = false; },
    unown: () => { owned = false; }, bump: () => { version += 1; } };
}

function transport(): AgentSpawnTransform {
  // Executes the REAL generic wrapper, but stays under this test user's UID.
  // The test proves process/argv/env composition, not a customer OS transition.
  return buildLoopbackIdentitySpawn({
    transportCommand: '/bin/bash', transportArgs: ['-c'], identity: 'test-customer',
    nodePath: process.execPath, remoteHome: home, spawnRoot: join(home, 'spawns'),
    localHome: root, baseEnv: process.env, remotePath: ['/usr/bin', '/bin'],
  });
}

async function bind(a = authority(), transform = vi.fn(transport())) {
  const executor = await bindHostedCustomerCommandExecutor({ resolvePrincipal: a.resolve,
    sessionHeaders: a.headers, customerWorkspaceId: 'customer-workspace', projectDir: project, transform });
  return { ...a, transform, executor };
}

describe('signed-session customer command execution', () => {
  it('executes the requested command and literal cwd through the existing identity wrapper', async () => {
    const { executor, resolve, transform } = await bind();
    const result = await executor.run({ command: "printf '%s\\n' \"$PWD\"; printf '%s' 'literal $() apostrophe '\"'\"" });
    expect(result).toMatchObject({ exitCode: 0, stderr: '', signal: null });
    expect(result.stdout).toBe(`${project}\nliteral $() apostrophe '`);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(transform).toHaveBeenCalledWith(expect.objectContaining({ env: {}, stagedDirs: [], backend: 'native-command' }));
  });

  it('never sends operator, provider or session environment into the customer process', async () => {
    vi.stubEnv('OPERATOR_DB_URL', 'private-db');
    vi.stubEnv('OPENROUTER_API_KEY', 'private-provider-key');
    vi.stubEnv('PAPERCUSP_SID', 'private-session');
    const { executor } = await bind();
    const result = await executor.run({ command: 'printf "%s|%s|%s|%s" "$OPERATOR_DB_URL" "$OPENROUTER_API_KEY" "$PAPERCUSP_SID" "$HOME"' });
    expect(result.stdout).toBe(`|||${home}`);
  });

  it('copies authentication headers before awaiting and gives each resolution its own copy', async () => {
    const a = authority();
    const resolve: HostedPrincipalResolver = async (headers) => {
      const result = await a.resolve(headers); headers.delete('cookie'); return result;
    };
    const pending = bindHostedCustomerCommandExecutor({ resolvePrincipal: resolve,
      sessionHeaders: a.headers, customerWorkspaceId: 'customer-workspace', projectDir: project, transform: transport() });
    a.headers.set('cookie', 'forged');
    const executor = await pending;
    expect((await executor.run({ command: 'printf success' })).stdout).toBe('success');
  });

  it.each(['revoke', 'expire', 'demote', 'deactivate', 'unown', 'version', 'tenant', 'user', 'organization'])(
    'rechecks %s before another command and never reaches the transport', async (change) => {
      const a = await bind();
      expect((await a.executor.run({ command: 'printf first' })).exitCode).toBe(0);
      a.transform.mockClear();
      if (change === 'revoke') a.session.revokedAt = new Date();
      if (change === 'expire') a.session.expiresAt = new Date(0);
      if (change === 'demote') a.demote();
      if (change === 'deactivate') a.deactivate();
      if (change === 'unown') a.unown();
      if (change === 'version') { a.bump(); a.session.permissionVersion += 1; }
      if (change === 'tenant') a.session.workspaceId = 'foreign-workspace';
      if (change === 'user') a.session.userId = 'another-user';
      if (change === 'organization') a.session.organizationId = 'another-org';
      await expect(a.executor.run({ command: 'touch forbidden' })).rejects.toThrow('hosted_customer_execution_denied');
      expect(a.transform).not.toHaveBeenCalled();
      expect(existsSync(join(project, 'forbidden'))).toBe(false);
    },
  );

  it.each(['forged-cookie', 'foreign-host', 'no-selection'])(
    'refuses %s before binding an executor', async (condition) => {
      const a = authority(), transform = vi.fn(transport());
      if (condition === 'forged-cookie') a.headers.set('cookie', `${HOSTED_SESSION_COOKIE}=v1.forged.forged`);
      if (condition === 'no-selection') a.session.workspaceId = null;
      await expect(bindHostedCustomerCommandExecutor({ resolvePrincipal: a.resolve, sessionHeaders: a.headers,
        customerWorkspaceId: condition === 'foreign-host' ? 'foreign-host' : 'customer-workspace',
        projectDir: project, transform })).rejects.toThrow('hosted_customer_execution_denied');
      expect(transform).not.toHaveBeenCalled();
    },
  );

  it('cancels pending reauthorization and ignores its late result', async () => {
    const a = authority(), transform = vi.fn(transport());
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    let calls = 0;
    const resolve: HostedPrincipalResolver = async (headers) => {
      if (++calls === 2) await paused;
      return a.resolve(headers);
    };
    const executor = await bindHostedCustomerCommandExecutor({ resolvePrincipal: resolve, sessionHeaders: a.headers,
      customerWorkspaceId: 'customer-workspace', projectDir: project, transform });
    const controller = new AbortController();
    const pending = executor.run({ command: 'touch forbidden', signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow('hosted_customer_execution_denied');
    controller.abort(); await rejected; resume();
    await paused; await Promise.resolve();
    expect(transform).not.toHaveBeenCalled();
  });

  it('applies the command deadline to a stalled authorization read', async () => {
    const a = await bind();
    a.resolve.mockImplementationOnce(() => new Promise(() => {}));
    await expect(a.executor.run({ command: 'touch forbidden', timeoutMs: 20 }))
      .rejects.toThrow('hosted_customer_execution_denied');
    expect(a.transform).not.toHaveBeenCalled();
  });

  it('snapshots command input before an authorization await', async () => {
    const a = await bind();
    const input = { command: 'printf original', cwd: project };
    const pending = a.executor.run(input); input.command = 'touch forbidden'; input.cwd = '/';
    expect((await pending).stdout).toBe('original');
    expect(existsSync(join(project, 'forbidden'))).toBe(false);
  });

  it('preserves a command failure and its stdout/stderr', async () => {
    const { executor } = await bind();
    expect(await executor.run({ command: 'printf out; printf err >&2; exit 7' }))
      .toMatchObject({ exitCode: 7, stdout: 'out', stderr: 'err' });
  });

  it('bounds combined output and closes the foreground process', async () => {
    const a = authority();
    const transform = vi.fn(() => ({ command: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(200000));process.stderr.write('y'.repeat(200000));setInterval(()=>{},1000)"],
      cwd: project, env: {} }));
    const { executor } = await bind(a, transform);
    await expect(executor.run({ command: 'unused' })).rejects.toThrow('hosted_customer_execution_output_limit');
  });

  it('kills a foreground process that ignores TERM before settling cancellation', async () => {
    const marker = join(project, 'pid');
    const transform = vi.fn(() => ({ command: process.execPath,
      args: ['-e', 'process.on("SIGTERM",()=>{});require("fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)', marker],
      cwd: project, env: {} }));
    const { executor } = await bind(authority(), transform);
    const controller = new AbortController();
    const pending = executor.run({ command: 'unused', signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow('hosted_customer_execution_aborted');
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
    const pid = Number(readFileSync(marker, 'utf8'));
    controller.abort(); await rejected;
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);

  it('reaps a TERM-ignoring command behind the real identity wrapper', async () => {
    const marker = join(project, 'remote-pid');
    const program = 'process.on("SIGTERM",()=>{});require("fs").writeFileSync("remote-pid",String(process.pid));setInterval(()=>{},1000)';
    const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const { executor } = await bind();
    const controller = new AbortController();
    const pending = executor.run({ command: `exec ${quote(process.execPath)} -e ${quote(program)}`, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow('hosted_customer_execution_aborted');
    let pid: number | undefined;
    try {
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
      pid = Number(readFileSync(marker, 'utf8'));
      controller.abort(); await rejected;
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      controller.abort();
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ } }
    }
  }, 15_000);

  it('cancels during wrapper startup without orphaning the detached payload', async () => {
    const marker = join(root, 'wrapper-started.json');
    // Hold the real wrapper immediately after spawning its detached payload.
    // Cancellation must be armed before that spawn, even while startup work
    // prevents the JS event loop from delivering the pending signal.
    const source = LOOPBACK_IDENTITY_WRAPPER_SOURCE.replace(
      "const cleanup = () => {",
      `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ wrapper: process.pid, payload: child.pid }));
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
       const cleanup = () => {`,
    );
    expect(source).not.toBe(LOOPBACK_IDENTITY_WRAPPER_SOURCE);
    const original = transport();
    const transform: AgentSpawnTransform = input => {
      const plan = original(input);
      return { ...plan, command: process.execPath, args: ['-e', source] };
    };
    const { executor } = await bind(authority(), vi.fn(transform));
    const controller = new AbortController();
    const pending = executor.run({ command: 'exec sleep 30', signal: controller.signal });
    const settled = pending.then(() => 'resolved', error => (error as Error).message);
    let pids: { wrapper: number; payload: number } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
      pids = JSON.parse(readFileSync(marker, 'utf8'));
      const started = performance.now();
      controller.abort();
      const outcome = await Promise.race([settled,
        new Promise<string>(resolve => { timer = setTimeout(() => resolve('shutdown deadline exceeded'), 2_000); })]);
      expect(outcome).toBe('hosted_customer_execution_aborted');
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(() => process.kill(pids!.payload, 0)).toThrow();
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      // Clean up exactly this test's measured subtree after a failing detector.
      if (pids) {
        try { process.kill(-pids.payload, 'SIGKILL'); } catch { /* already reaped */ }
        try { process.kill(pids.wrapper, 'SIGKILL'); } catch { /* already reaped */ }
      }
      await settled;
    }
  }, 10_000);

  it('sanitizes authority and transport failures instead of leaking their details', async () => {
    const a = await bind();
    a.resolve.mockRejectedValueOnce(new Error('private-db-password'));
    await expect(a.executor.run({ command: 'unused' })).rejects.toThrow(/^hosted_customer_execution_denied$/);
    a.transform.mockImplementationOnce(() => { throw new Error('private-operator-token'); });
    await expect(a.executor.run({ command: 'unused' })).rejects.toThrow(/^hosted_customer_execution_unavailable$/);
  });
});
