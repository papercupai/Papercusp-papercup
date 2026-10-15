import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  WORKSPACE_HOST_AGENT_CREDENTIAL_EXPIRY_PROTOCOL,
  WORKSPACE_HOST_AGENT_CREDENTIAL_EXPIRY_SCRIPT,
  WORKSPACE_HOST_AGENT_CREDENTIAL_EXPIRY_WARN_MS,
  buildWorkspaceHostAgentCredentialExpiryProbe,
  parseWorkspaceHostAgentCredentialExpiryOutput,
  workspaceHostAgentCredentialChecks,
  type WorkspaceHostAgentCredentialExpiryReading,
} from './agent-credential-expiry';
import type { GcpIapWorkspaceHostInitializationProfile } from './gcp-iap-initialization-operations';

const NOW = new Date('2026-10-01T18:00:00.000Z');
const HOUR = 3_600_000;

const PROFILE: GcpIapWorkspaceHostInitializationProfile = {
  projectId: 'active-alcove-504205-q3',
  zone: 'us-central1-a',
  instanceName: 'pc-workspace-1',
  instanceId: '4715512353118305137',
  sshUser: 'papercusp-workspace',
  knownHostsFile: '/var/lib/papercusp/controller/known_hosts',
  identityFile: '/var/lib/papercusp/controller/os-login',
  remoteEntrypoint: '/opt/papercusp/current/bin/papercusp-workspace-initialize',
};

// Distinctive token bodies, so the "no token byte leaves the host" assertion has something real
// to look for in the probe's stdout. Deliberately not key-shaped (the tree's secrets guard).
const CLAUDE_ACCESS = 'ACCESS-SENTINEL-c1a7';
const CLAUDE_REFRESH = 'REFRESH-SENTINEL-77aa';
const CODEX_REFRESH = 'CODEX-REFRESH-SENTINEL-c0de';
const CODEX_API_KEY = 'APIKEY-SENTINEL-9f9f';

function jwt(payload: Record<string, unknown>): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(payload)}.SIGNATURE-SENTINEL`;
}

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(files: { claude?: unknown; codex?: unknown }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pc-agent-cred-home-'));
  homes.push(dir);
  if (files.claude !== undefined) {
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(path.join(dir, '.claude', '.credentials.json'), JSON.stringify(files.claude));
  }
  if (files.codex !== undefined) {
    mkdirSync(path.join(dir, '.codex'));
    // Pretty-printed on purpose: the probe must not depend on the file being one line.
    writeFileSync(path.join(dir, '.codex', 'auth.json'), JSON.stringify(files.codex, null, 2));
  }
  return dir;
}

/** Run the exact remote program with the local POSIX sh, as the host would. */
function runProbe(homeDir: string): string {
  const result = spawnSync('/bin/sh', ['-c', WORKSPACE_HOST_AGENT_CREDENTIAL_EXPIRY_SCRIPT], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homeDir },
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  return result.stdout;
}

describe('the remote agent-login probe (run for real against fixture homes)', () => {
  it('reads a DELIVERED (refresh-stripped) pair: fixed expiries, and prints no token byte', () => {
    const claudeExpMs = Date.parse('2026-10-01T23:30:00.000Z');
    const codexExpS = Math.floor(Date.parse('2026-10-02T01:00:00.000Z') / 1000);
    const stdout = runProbe(
      home({
        claude: { claudeAiOauth: { accessToken: CLAUDE_ACCESS, refreshToken: '', expiresAt: claudeExpMs, scopes: ['user:inference'] } },
        codex: { OPENAI_API_KEY: null, tokens: { access_token: jwt({ exp: codexExpS, sub: 'user' }), refresh_token: '' } },
      }),
    );

    for (const sentinel of [CLAUDE_ACCESS, 'SIGNATURE-SENTINEL', 'sub']) expect(stdout).not.toContain(sentinel);
    expect(parseWorkspaceHostAgentCredentialExpiryOutput(stdout)).toEqual([
      { slot: 'claude', kind: 'fixed', accessExpiresAt: '2026-10-01T23:30:00.000Z' },
      { slot: 'codex', kind: 'fixed', accessExpiresAt: '2026-10-02T01:00:00.000Z' },
    ]);
  });

  it('reads a customer /login (refresh token present) and an API-key codex login as non-expiring', () => {
    const stdout = runProbe(
      home({
        claude: { claudeAiOauth: { accessToken: CLAUDE_ACCESS, refreshToken: CLAUDE_REFRESH, expiresAt: Date.parse('2026-10-01T10:00:00.000Z') } },
        codex: { OPENAI_API_KEY: CODEX_API_KEY, tokens: null },
      }),
    );

    for (const sentinel of [CLAUDE_ACCESS, CLAUDE_REFRESH, CODEX_API_KEY]) expect(stdout).not.toContain(sentinel);
    expect(parseWorkspaceHostAgentCredentialExpiryOutput(stdout)).toEqual([
      { slot: 'claude', kind: 'self-renewing', accessExpiresAt: '2026-10-01T10:00:00.000Z' },
      { slot: 'codex', kind: 'api-key' },
    ]);
  });

  it('reads a codex login whose refresh token is live as self-renewing', () => {
    const codexExpS = Math.floor(Date.parse('2026-10-01T12:00:00.000Z') / 1000);
    const stdout = runProbe(
      home({ codex: { tokens: { access_token: jwt({ exp: codexExpS }), refresh_token: CODEX_REFRESH } } }),
    );

    expect(stdout).not.toContain(CODEX_REFRESH);
    expect(parseWorkspaceHostAgentCredentialExpiryOutput(stdout)).toEqual([
      { slot: 'claude', kind: 'absent' },
      { slot: 'codex', kind: 'self-renewing', accessExpiresAt: '2026-10-01T12:00:00.000Z' },
    ]);
  });

  it('reports an empty home as absent, and a login with no readable expiry as unreadable', () => {
    expect(parseWorkspaceHostAgentCredentialExpiryOutput(runProbe(home({})))).toEqual([
      { slot: 'claude', kind: 'absent' },
      { slot: 'codex', kind: 'absent' },
    ]);
    const stdout = runProbe(
      home({
        claude: { claudeAiOauth: { accessToken: CLAUDE_ACCESS, refreshToken: '' } },
        codex: { tokens: { access_token: 'not-a-jwt', refresh_token: '' } },
      }),
    );
    expect(parseWorkspaceHostAgentCredentialExpiryOutput(stdout)).toEqual([
      { slot: 'claude', kind: 'unreadable' },
      { slot: 'codex', kind: 'unreadable' },
    ]);
  });

  it('runs over the pinned IAP transport as sh -c, with nothing on stdin', () => {
    const probe = buildWorkspaceHostAgentCredentialExpiryProbe(PROFILE);
    const remote = probe.args.at(-1) ?? '';
    expect(probe.command).toBe('ssh');
    expect(probe.args).toContain('StrictHostKeyChecking=yes');
    expect(probe.args.some((arg) => arg.startsWith('HostKeyAlias='))).toBe(true);
    expect(probe.args).toContain(`${PROFILE.sshUser}@${PROFILE.instanceName}`);
    expect(remote.startsWith("'/bin/sh' '-c' ")).toBe(true);
    expect(remote).toContain(WORKSPACE_HOST_AGENT_CREDENTIAL_EXPIRY_PROTOCOL);
    expect(probe.stdin).toBe('');
  });

  it('survives the ssh quoting round trip: the remote STRING, run as sshd runs it, still answers', () => {
    // sshd hands the remote command string to the user's shell as `sh -c '<string>'`; the script
    // is full of single quotes, so this is what proves quotePosixShellArg kept it intact.
    const remote = buildWorkspaceHostAgentCredentialExpiryProbe(PROFILE).args.at(-1) ?? '';
    const claudeExpMs = Date.parse('2026-10-01T23:30:00.000Z');
    const result = spawnSync('/bin/sh', ['-c', remote], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home({ claude: { claudeAiOauth: { accessToken: CLAUDE_ACCESS, refreshToken: '', expiresAt: claudeExpMs } } }),
      },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(parseWorkspaceHostAgentCredentialExpiryOutput(result.stdout)).toEqual([
      { slot: 'claude', kind: 'fixed', accessExpiresAt: '2026-10-01T23:30:00.000Z' },
      { slot: 'codex', kind: 'absent' },
    ]);
  });
});

describe('parseWorkspaceHostAgentCredentialExpiryOutput', () => {
  const ok = `${WORKSPACE_HOST_AGENT_CREDENTIAL_EXPIRY_PROTOCOL}\nclaude present=0\ncodex present=0\n`;

  it('accepts the exact protocol', () => {
    expect(parseWorkspaceHostAgentCredentialExpiryOutput(ok)).toHaveLength(2);
  });

  it.each([
    ['an unknown header', 'SOMETHING ELSE\nclaude present=0\ncodex present=0\n'],
    ['an unknown line', `${WORKSPACE_HOST_AGENT_CREDENTIAL_EXPIRY_PROTOCOL}\nclaude present=0\ncodex token=abc\n`],
    ['a duplicated slot', `${WORKSPACE_HOST_AGENT_CREDENTIAL_EXPIRY_PROTOCOL}\nclaude present=0\nclaude present=0\n`],
    ['a missing slot', `${WORKSPACE_HOST_AGENT_CREDENTIAL_EXPIRY_PROTOCOL}\nclaude present=0\n`],
  ])('refuses %s rather than trusting it', (_label, stdout) => {
    expect(() => parseWorkspaceHostAgentCredentialExpiryOutput(stdout)).toThrow();
  });
});

describe('workspaceHostAgentCredentialChecks', () => {
  const fixed = (slot: 'claude' | 'codex', atMs: number): WorkspaceHostAgentCredentialExpiryReading => ({
    kind: 'read',
    slots: [
      { slot, kind: 'fixed', accessExpiresAt: new Date(atMs).toISOString() },
      { slot: slot === 'claude' ? 'codex' : 'claude', kind: 'absent' },
    ],
  });

  it('passes a fixed login that is not yet near expiry, with no warning', () => {
    const [check, ...rest] = workspaceHostAgentCredentialChecks(fixed('claude', NOW.getTime() + 5 * HOUR), NOW);
    expect(rest).toEqual([]);
    expect(check).toMatchObject({ name: 'agent-credential:claude', ok: true });
    expect(check).not.toHaveProperty('warn');
  });

  it('goes AMBER inside the warning window: still passing, so the status stays healthy', () => {
    const checks = workspaceHostAgentCredentialChecks(
      fixed('codex', NOW.getTime() + WORKSPACE_HOST_AGENT_CREDENTIAL_EXPIRY_WARN_MS - 60_000),
      NOW,
    );
    expect(checks).toEqual([expect.objectContaining({ name: 'agent-credential:codex', ok: true, warn: true })]);
    expect(checks[0]!.detail).toContain('EXPIRES at');
    expect(checks[0]!.detail).toContain('agent-credentials');
  });

  it('goes RED once the access token has expired, naming the remedy', () => {
    const [check] = workspaceHostAgentCredentialChecks(fixed('claude', NOW.getTime() - 60_000), NOW);
    expect(check).toMatchObject({ name: 'agent-credential:claude', ok: false });
    expect(check!.detail).toContain('EXPIRED at');
    expect(check!.detail).toContain('signs in on the host');
  });

  it('never alarms on a self-renewing or API-key login, even when its access token has lapsed', () => {
    const checks = workspaceHostAgentCredentialChecks(
      {
        kind: 'read',
        slots: [
          { slot: 'claude', kind: 'self-renewing', accessExpiresAt: new Date(NOW.getTime() - 3 * HOUR).toISOString() },
          { slot: 'codex', kind: 'api-key' },
        ],
      },
      NOW,
    );
    expect(checks.map((check) => [check.name, check.ok, check.warn])).toEqual([
      ['agent-credential:claude', true, undefined],
      ['agent-credential:codex', true, undefined],
    ]);
  });

  it('emits nothing for an absent login, and ok:null for an unreadable one or a failed read', () => {
    expect(
      workspaceHostAgentCredentialChecks(
        { kind: 'read', slots: [{ slot: 'claude', kind: 'absent' }, { slot: 'codex', kind: 'absent' }] },
        NOW,
      ),
    ).toEqual([]);
    expect(
      workspaceHostAgentCredentialChecks(
        { kind: 'read', slots: [{ slot: 'claude', kind: 'unreadable' }, { slot: 'codex', kind: 'absent' }] },
        NOW,
      ),
    ).toEqual([expect.objectContaining({ name: 'agent-credential:claude', ok: null })]);
    expect(workspaceHostAgentCredentialChecks({ kind: 'transport-failure', detail: 'ssh exited 255' }, NOW)).toEqual([
      { name: 'agent-credentials', ok: null, detail: 'not measured: ssh exited 255' },
    ]);
  });
});
