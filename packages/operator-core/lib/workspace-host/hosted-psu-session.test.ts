import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_IDENTITY_SPEC_ENV } from '@papercusp/papercusp-shared/agent';
import {
  HOSTED_PSU_CUSTOMER_ENV,
  HOSTED_PSU_ENTRYPOINT,
  HOSTED_PSU_MAX_ARGS,
  hostedPsuPtySpawnSpec,
  parseHostedPsuCustomerArgv,
} from './hosted-psu-session';
import { setHostedAgentIdentityPsuSpec } from './hosted-agent-identity-psu-env';
import { hostedCustomerAgentIdentitySpec } from './hosted-agent-identity';

afterEach(() => setHostedAgentIdentityPsuSpec(undefined));

describe('parseHostedPsuCustomerArgv (D-002 allowlist)', () => {
  it('preserves exact resume host restrictions and refuses malformed host cells', () => {
    expect(parseHostedPsuCustomerArgv(['--resume=42', '--resume-host', 'remote-1'])).toEqual({
      ok: true, argv: ['--resume=42', '--resume-host=remote-1'],
    });
    for (const host of ['', '../remote', 'remote host', '--no-picker', 'remote\nother']) {
      expect(parseHostedPsuCustomerArgv([`--resume-host=${host}`])).toEqual({
        ok: false, reason: 'flag_value_refused:--resume-host',
      });
    }
  });

  it('admits the allowlisted flags and normalises the space form to --flag=value', () => {
    expect(
      parseHostedPsuCustomerArgv([
        '--agent',
        'claude',
        '--model=opus[1m]:high',
        '--label=my session',
        '--no-picker',
        '--resume=0c1f2e3d-aaaa-bbbb-cccc-1234567890ab',
        '--fork',
      ]),
    ).toEqual({
      ok: true,
      argv: [
        '--agent=claude',
        '--model=opus[1m]:high',
        '--label=my session',
        '--no-picker',
        '--resume=0c1f2e3d-aaaa-bbbb-cccc-1234567890ab',
        '--fork',
      ],
    });
    expect(parseHostedPsuCustomerArgv(undefined)).toEqual({ ok: true, argv: [] });
    expect(parseHostedPsuCustomerArgv(['--resume'])).toEqual({ ok: true, argv: ['--resume'] });
  });

  // Every flag the WI-10003949 review measured as reaching service-user state or identity.
  it.each([
    ['--launch-context=/var/lib/papercusp/.papercusp/superuser-token', 'flag_not_allowed:--launch-context'],
    ['--set-claude-token', 'flag_not_allowed:--set-claude-token'],
    ['--set-claude-token=sk-ant-x', 'flag_not_allowed:--set-claude-token'],
    ['--clear-claude-token', 'flag_not_allowed:--clear-claude-token'],
    ['--recovery-authorize', 'flag_not_allowed:--recovery-authorize'],
    ['--recovery-grant=abc', 'flag_not_allowed:--recovery-grant'],
    ['--owner-id=su-someone-else', 'flag_not_allowed:--owner-id'],
    ['--identity-revision=r1', 'flag_not_allowed:--identity-revision'],
    ['--launched-by=su-x', 'flag_not_allowed:--launched-by'],
    ['--session-id=x', 'flag_not_allowed:--session-id'],
    ['--fleet=ops', 'flag_not_allowed:--fleet'],
    ['--harness=papercusp', 'flag_not_allowed:--harness'],
    ['--workspace=other', 'flag_not_allowed:--workspace'],
    ['--user=root', 'flag_not_allowed:--user'],
    ['--add-dir=/var/lib/papercusp', 'flag_not_allowed:--add-dir'],
    ['--', 'flag_not_allowed:--'],
    ['bare-positional', 'flag_not_allowed:bare-positional'],
  ])('refuses %s', (arg, reason) => {
    expect(parseHostedPsuCustomerArgv(['--agent=claude', arg])).toEqual({ ok: false, reason });
  });

  it('refuses bad values, a missing value, and malformed lists', () => {
    expect(parseHostedPsuCustomerArgv(['--agent=bash'])).toEqual({ ok: false, reason: 'flag_value_refused:--agent' });
    expect(parseHostedPsuCustomerArgv(['--agent'])).toEqual({ ok: false, reason: 'flag_needs_value:--agent' });
    expect(parseHostedPsuCustomerArgv(['--model=--launch-context=/x'])).toEqual({
      ok: false,
      reason: 'flag_value_refused:--model',
    });
    expect(parseHostedPsuCustomerArgv(['--resume=../../etc/passwd'])).toEqual({
      ok: false,
      reason: 'flag_value_refused:--resume',
    });
    expect(parseHostedPsuCustomerArgv(['--label=a\u001b]0;x\u0007'])).toEqual({
      ok: false,
      reason: 'flag_value_refused:--label',
    });
    expect(parseHostedPsuCustomerArgv('--agent=claude')).toEqual({ ok: false, reason: 'argv_not_a_list' });
    expect(parseHostedPsuCustomerArgv([7])).toEqual({ ok: false, reason: 'argv_malformed' });
    expect(parseHostedPsuCustomerArgv(Array(HOSTED_PSU_MAX_ARGS + 1).fill('--no-picker'))).toEqual({
      ok: false,
      reason: 'argv_too_long',
    });
  });

  it('takes the space-form value verbatim, so a flag-shaped value is checked as a value', () => {
    expect(parseHostedPsuCustomerArgv(['--agent', '--owner-id=x'])).toEqual({
      ok: false,
      reason: 'flag_value_refused:--agent',
    });
  });
});

describe('hostedPsuPtySpawnSpec', () => {
  const input = {
    scope: {} as never,
    hostedSessionId: 'cli.token-1.psu',
    workspaceRoot: '/srv/papercusp/workspaces',
    cols: 80,
    rows: 24,
    argv: ['--agent=claude'],
  };

  it('runs the release psu itself, never a shell, in the workspace root', () => {
    const spec = hostedPsuPtySpawnSpec(input, { PAPERCUSP_HONO_PORT: '3070' });
    expect(spec.command).toBe(HOSTED_PSU_ENTRYPOINT);
    expect(spec.command.endsWith('/current/bin/psu')).toBe(true);
    expect(spec.args).toEqual(['--agent=claude']);
    expect(spec.cwd).toBe('/srv/papercusp/workspaces');
    expect([spec.command, ...spec.args].some((part) => /(^|\/)(ba|z|da)?sh$|-c$/.test(part))).toBe(false);
  });

  it('builds the env on the host: hosted-customer mode, loopback operator, the D-424 identity spec', () => {
    setHostedAgentIdentityPsuSpec(hostedCustomerAgentIdentitySpec({ localHome: '/var/lib/papercusp' }));
    const spec = hostedPsuPtySpawnSpec(input, { PAPERCUSP_HONO_PORT: '3999', LANG: 'en_US.UTF-8' });
    expect(spec.env[HOSTED_PSU_CUSTOMER_ENV]).toBe('1');
    expect(spec.env.PAPERCUSP_OPERATOR_URL).toBe('http://127.0.0.1:3999');
    expect(spec.env.LANG).toBe('en_US.UTF-8');
    expect(JSON.parse(spec.env[AGENT_IDENTITY_SPEC_ENV]!)).toMatchObject({ identity: expect.stringContaining('@127.0.0.1') });
    // Per-session launch state from the operator's own env is dropped, not inherited.
    for (const name of ['PAPERCUSP_SID', 'PAPERCUSP_KICKOFF_PROMPT', 'PAPERCUSP_PSU_HEADLESS']) {
      expect(name in spec.env && spec.env[name] === undefined).toBe(true);
    }
  });
});
