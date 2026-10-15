import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentSpawnRefusedError,
  agentSpawnTransformConfigured,
  configureAgentSpawnTransform,
  planAgentSpawn,
  type AgentSpawnRequest,
} from '@papercusp/papercusp-shared/agent';
import {
  DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
  WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN,
  WORKSPACE_HOST_TSC_SERVICE_SOCKET_UNIT_FILE,
  WORKSPACE_HOST_TSC_SERVICE_UNIT_FILE,
} from '@papercusp/deployment-driver';
import {
  hostedCustomerAgentCommand,
  hostedCustomerAgentIdentitySpec,
  hostedCustomerAgentSpawnTransform,
  hostedCustomerCommandSpawnTransform,
  hostedHeavyAdmissionEnv,
  hostedTscServiceEnv,
  installHostedCustomerAgentIdentity,
  type HostedCustomerAgentIdentityOptions,
} from './hosted-agent-identity';
import { hostedAgentIdentityPsuEnv, setHostedAgentIdentityPsuSpec } from './hosted-agent-identity-psu-env';
import { AGENT_IDENTITY_SPEC_ENV, parseAgentIdentitySpec } from '@papercusp/papercusp-shared/agent';
import { HOSTED_WORKSPACE_ACCOUNT_HOME, hostedWorkspacePtySpawnSpec, hostedWorkspaceSshArgs } from './hosted-session-host';

// D-421 (byoc plan) / WI-10003195: on a hosted host the chat brain's agent CLI must run as the
// customer workspace account, never in-process as the operator service account.

let root: string;
let stagedCodexHome: string;
let serviceHome: string;

function codexRequest(extraEnv: NodeJS.ProcessEnv = {}): AgentSpawnRequest {
  return {
    backend: 'codex',
    command: '/opt/papercusp/current/bin/codex',
    args: ['exec', '--json', '-s', 'danger-full-access', '-'],
    cwd: undefined,
    env: { PATH: `${serviceHome}/.local/bin:/opt/papercusp/current/bin:/usr/bin:/bin`, CODEX_HOME: stagedCodexHome, ...extraEnv },
    stagedDirs: [{ path: stagedCodexHome, persistent: false }],
  };
}

/** Options for a host whose customer agent toolchain is fully installed. */
function withToolchain(extra: HostedCustomerAgentIdentityOptions = {}): HostedCustomerAgentIdentityOptions {
  return { localHome: serviceHome, baseEnv: {}, forbiddenSecrets: [], exists: () => true, ...extra };
}

function header(prelude: Buffer | undefined) {
  expect(prelude).toBeInstanceOf(Buffer);
  const text = prelude!.toString('utf8');
  const newline = text.indexOf('\n');
  return JSON.parse(text.slice(newline + 1));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hosted-agent-identity-'));
  serviceHome = join(root, 'var-lib-papercusp');
  stagedCodexHome = join(root, 'codex-chat-abc123');
  mkdirSync(join(serviceHome, '.papercusp'), { recursive: true });
  mkdirSync(stagedCodexHome, { recursive: true });
  writeFileSync(join(stagedCodexHome, 'AGENTS.md'), 'persona');
  writeFileSync(join(stagedCodexHome, 'config.toml'), 'headers = { Authorization = "Bearer customer-principal-token" }\n');
});

afterEach(() => {
  configureAgentSpawnTransform(undefined);
  rmSync(root, { recursive: true, force: true });
});

describe('hosted customer agent identity (D-421)', () => {
  it('plans native commands with the same pinned customer SSH identity and no shipped runtime', () => {
    const plan = hostedCustomerCommandSpawnTransform(withToolchain())({
      backend: 'native-command', command: '/bin/bash', args: ['-c', 'printf customer'],
      cwd: undefined, env: {}, stagedDirs: [],
    });
    expect(plan.command).toBe('/usr/bin/ssh');
    expect(plan.args.slice(0, -1)).toEqual(expect.arrayContaining(hostedWorkspaceSshArgs({ tty: false })));
    const h = header(plan.stdinPrelude);
    expect(h.argv).toEqual(['/bin/bash', '-c', 'printf customer']);
    expect(h.env.HOME).toBe(HOSTED_WORKSPACE_ACCOUNT_HOME);
    expect(h.env.PATH).not.toContain('/opt/papercusp');
    expect(h.files).toEqual([]);
    expect(h.links).toEqual([]);
  });

  it('refuses native commands when the customer Node toolchain is absent', () => {
    expect(() => hostedCustomerCommandSpawnTransform(withToolchain({ exists: () => false }))({
      backend: 'native-command', command: '/bin/bash', args: [], cwd: undefined, env: {}, stagedDirs: [],
    })).toThrow(/toolchain unavailable/);
  });

  it('refuses a substituted executable or runtime staging on the native command seam', () => {
    const transform = hostedCustomerCommandSpawnTransform(withToolchain());
    for (const request of [codexRequest(), { ...codexRequest(), backend: 'native-command', command: '/bin/bash' },
      { ...codexRequest(), backend: 'native-command', stagedDirs: [] }]) {
      expect(() => transform(request)).toThrow(/invalid customer command execution plan/);
    }
  });

  it('runs the agent over the pinned loopback SSH vector as the customer account, without a TTY', () => {
    const plan = hostedCustomerAgentSpawnTransform(withToolchain())(codexRequest());
    expect(plan.command).toBe('/usr/bin/ssh');
    const args = [...plan.args];
    expect(args).toContain('-T');
    expect(args).not.toContain('-tt');
    const destination = args.indexOf('-l');
    expect(args.slice(destination, destination + 3)).toEqual(['-l', DEFAULT_WORKSPACE_HOST_WORKSPACE_USER, '127.0.0.1']);
    expect(args.indexOf('LogLevel=ERROR')).toBeLessThan(destination);
    // The remote command is the last argv entry and runs the inline wrapper with node.
    expect(args).toHaveLength(destination + 4);
    expect(args[destination + 3]).toMatch(/^exec '.+' -e '/);
    expect(plan.identity).toBe(`${DEFAULT_WORKSPACE_HOST_WORKSPACE_USER}@127.0.0.1`);
  });

  it('materializes CODEX_HOME under the customer home and links the customer credential, not the operator one', () => {
    const plan = hostedCustomerAgentSpawnTransform(withToolchain())(codexRequest());
    const h = header(plan.stdinPrelude);
    expect(h.env.HOME).toBe(HOSTED_WORKSPACE_ACCOUNT_HOME);
    expect(h.env.CODEX_HOME.startsWith(`${HOSTED_WORKSPACE_ACCOUNT_HOME}/.papercusp/agent-spawns/`)).toBe(true);
    expect(h.links).toEqual([{ path: `${h.env.CODEX_HOME}/auth.json`, target: `${HOSTED_WORKSPACE_ACCOUNT_HOME}/.codex/auth.json` }]);
    // The service account's own PATH entries never cross.
    expect(h.env.PATH.split(':')).not.toContain(`${serviceHome}/.local/bin`);
  });

  it('links the customer Claude credential into an isolated CLAUDE_CONFIG_DIR (P-325)', () => {
    // runAgentChat symlinks the OPERATOR's ~/.claude/.credentials.json into its local config dir;
    // symlinks are never shipped, so without this link a hosted claude spawn finds no credential.
    const stagedClaudeDir = join(root, 'claude-chat-xyz789');
    mkdirSync(stagedClaudeDir, { recursive: true });
    const plan = hostedCustomerAgentSpawnTransform(withToolchain())({
      backend: 'claude',
      command: '/opt/papercusp/current/bin/claude',
      args: ['-p'],
      cwd: undefined,
      env: { PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: stagedClaudeDir },
      stagedDirs: [{ path: stagedClaudeDir, persistent: false }],
    });
    const h = header(plan.stdinPrelude);
    expect(h.env.CLAUDE_CONFIG_DIR.startsWith(`${HOSTED_WORKSPACE_ACCOUNT_HOME}/.papercusp/agent-spawns/`)).toBe(true);
    expect(h.links).toEqual([
      { path: `${h.env.CLAUDE_CONFIG_DIR}/.credentials.json`, target: `${HOSTED_WORKSPACE_ACCOUNT_HOME}/.claude/.credentials.json` },
    ]);
  });

  // D-423: the customer account cannot read the Papercusp runtime (D-043), so neither the
  // release's Node nor its psu wrappers may appear anywhere in what crosses to that account.
  it('runs the wrapper Node and the agent CLI from the customer toolchain, never the release tree', () => {
    const plan = hostedCustomerAgentSpawnTransform(withToolchain())(codexRequest());
    const remoteCommand = plan.args[plan.args.length - 1]!;
    expect(remoteCommand.startsWith(`exec '${WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN}/node' -e `)).toBe(true);
    const h = header(plan.stdinPrelude);
    expect(h.argv[0]).toBe(`${WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN}/codex`);
    expect(h.argv.slice(1)).toEqual(['exec', '--json', '-s', 'danger-full-access', '-']);
    const path = h.env.PATH.split(':');
    expect(path[0]).toBe(WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN);
    expect(path).toContain(`${HOSTED_WORKSPACE_ACCOUNT_HOME}/.local/bin`);
    // The operator PATH carried the release bin (the psu wrappers); it must not be forwarded.
    expect(JSON.stringify({ argv: h.argv, path })).not.toContain('/opt/papercusp');
    expect(remoteCommand).not.toContain('/opt/papercusp');
  });

  it('maps every chat backend onto its toolchain executable by backend, not by requested command', () => {
    const bin = '/toolchain/bin';
    expect(hostedCustomerAgentCommand('codex', bin)).toBe('/toolchain/bin/codex');
    expect(hostedCustomerAgentCommand('claude-code', bin)).toBe('/toolchain/bin/claude');
    expect(hostedCustomerAgentCommand('omp', bin)).toBe('/toolchain/bin/omp');
  });

  it('refuses by name when the host has no customer agent toolchain', () => {
    const missing = `${WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN}/codex`;
    const transform = hostedCustomerAgentSpawnTransform(withToolchain({ exists: (p) => p !== missing }));
    let caught: unknown;
    try {
      transform(codexRequest());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentSpawnRefusedError);
    expect((caught as AgentSpawnRefusedError).code).toBe('agent_toolchain_missing');
    expect((caught as Error).message).toContain(missing);
  });

  it('refuses when the operator superuser token would reach the customer account', () => {
    writeFileSync(join(serviceHome, '.papercusp', 'superuser-token'), 'su-token-0123456789abcdef');
    writeFileSync(join(stagedCodexHome, 'config.toml'), 'headers = { Authorization = "Bearer su-token-0123456789abcdef" }\n');
    const transform = hostedCustomerAgentSpawnTransform({ localHome: serviceHome, baseEnv: {}, exists: () => true });
    expect(() => transform(codexRequest())).toThrow(AgentSpawnRefusedError);
  });

  // WI-10006617: with a scoped PAPERCUSP_HOME the operator's REAL token lives there
  // (superuser-token.ts), not under <localHome>/.papercusp — the scrub must cover it.
  it('refuses the scoped-PAPERCUSP_HOME superuser token too', () => {
    const scopedHome = join(serviceHome, 'scoped-home');
    mkdirSync(scopedHome, { recursive: true });
    writeFileSync(join(scopedHome, 'superuser-token'), 'scoped-su-token-0123456789abcdef');
    writeFileSync(join(stagedCodexHome, 'config.toml'), 'headers = { Authorization = "Bearer scoped-su-token-0123456789abcdef" }\n');
    const transform = hostedCustomerAgentSpawnTransform({
      localHome: serviceHome,
      baseEnv: { PAPERCUSP_HOME: scopedHome },
      exists: () => true,
    });
    expect(() => transform(codexRequest())).toThrow(AgentSpawnRefusedError);
  });

  it('forbids the superuser-token FILE under a scoped PAPERCUSP_HOME', () => {
    const spec = hostedCustomerAgentIdentitySpec({ localHome: '/var/lib/papercusp', baseEnv: { PAPERCUSP_HOME: '/srv/scoped' } });
    expect(spec.forbiddenSecretFiles).toContain('/var/lib/papercusp/.papercusp/superuser-token');
    expect(spec.forbiddenSecretFiles).toContain('/srv/scoped/superuser-token');
  });

  it('once installed, every planned agent spawn is routed away from the service account', () => {
    expect(agentSpawnTransformConfigured()).toBe(false);
    installHostedCustomerAgentIdentity(withToolchain());
    expect(agentSpawnTransformConfigured()).toBe(true);
    const plan = planAgentSpawn(codexRequest());
    expect(plan.command).toBe('/usr/bin/ssh');
    expect(plan.command).not.toBe(codexRequest().command);
  });

  it('keeps the customer terminal on the same pinned vector with a forced TTY', () => {
    if (process.platform !== 'linux') return;
    const spec = hostedWorkspacePtySpawnSpec({ scope: 'workspace', workspaceRoot: '/srv/w', hostedSessionId: 's', cols: 80, rows: 24 } as never);
    const ttyArgs = hostedWorkspaceSshArgs({ tty: true });
    expect(spec.args.slice(0, ttyArgs.length)).toEqual(ttyArgs);
    expect(ttyArgs).toContain('-tt');
  });
});

// D-424 / P-326: New Session's psu keeps supervising as the service user; its agent CLI crosses to
// the customer account through the spec below, built from the SAME vector/toolchain as D-423.
describe('hosted New Session agent identity spec (D-424)', () => {
  afterEach(() => {
    setHostedAgentIdentityPsuSpec(undefined);
  });

  it('stages over the non-TTY vector and execs over the forced-TTY one, as the customer account', () => {
    const spec = parseAgentIdentitySpec(hostedCustomerAgentIdentitySpec({ localHome: '/var/lib/papercusp', baseEnv: {} }));
    expect(spec.identity).toBe(`${DEFAULT_WORKSPACE_HOST_WORKSPACE_USER}@127.0.0.1`);
    expect(spec.stageTransport.args).toContain('-T');
    expect(spec.stageTransport.args).not.toContain('-tt');
    expect(spec.execTransport.args).toContain('-tt');
    for (const args of [spec.stageTransport.args, spec.execTransport.args]) {
      // Quiet diagnostics precede the destination, which stays last before the remote command.
      expect(args.indexOf('LogLevel=ERROR')).toBeLessThan(args.indexOf('-l'));
      expect(args.slice(-3)).toEqual(['-l', DEFAULT_WORKSPACE_HOST_WORKSPACE_USER, '127.0.0.1']);
    }
    expect(spec.nodePath).toBe(`${WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN}/node`);
    expect(spec.remoteHome).toBe(HOSTED_WORKSPACE_ACCOUNT_HOME);
    expect(spec.remotePath[0]).toBe(WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN);
    // Only the operator's own state dir ships (psu's rendered prompt); its superuser token and
    // embedded-PG credentials (WI-10003627) never cross.
    expect(spec.shipFileRoots).toEqual(['/var/lib/papercusp/.papercusp']);
    expect(spec.forbiddenSecretFiles).toEqual([
      '/var/lib/papercusp/.papercusp/superuser-token',
      '/var/lib/papercusp/.papercusp/embedded-pg.json',
      '/var/lib/papercusp/.papercusp/embedded-pg-credentials.json',
    ]);
  });

  it('psu launches carry the spec only once the hosted runtime installed it', () => {
    expect(hostedAgentIdentityPsuEnv()).toEqual({});
    installHostedCustomerAgentIdentity({ localHome: '/var/lib/papercusp', forbiddenSecrets: [], baseEnv: {} });
    const env = hostedAgentIdentityPsuEnv();
    expect(Object.keys(env)).toEqual([AGENT_IDENTITY_SPEC_ENV]);
    expect(parseAgentIdentitySpec(env[AGENT_IDENTITY_SPEC_ENV]!).identity).toBe(
      `${DEFAULT_WORKSPACE_HOST_WORKSPACE_USER}@127.0.0.1`,
    );
    expect(agentSpawnTransformConfigured()).toBe(true);
  });
});

// WI-10005296 (plan agent-capacity-and-cost-gcp-2026-09-30 D-031 ruling 2c): heavy-job admission is
// activated by a FIXED operator-set env, and only when the published toolchain carries both files.
describe('hosted heavy-job admission env (D-031)', () => {
  const bin = '/opt/tc/bin';
  const preload = '/opt/tc/lib/heavy-admission/heavy-admission.cjs';
  const script = '/opt/tc/lib/heavy-admission/pc-heavy.sh';
  const both = (p: string) => p === preload || p === script || p.startsWith(`${bin}/`);

  it('is the preload NODE_OPTIONS plus the hosted pc-heavy profile when both files exist, else nothing', () => {
    expect(hostedHeavyAdmissionEnv(bin, both)).toEqual({
      NODE_OPTIONS: `--require=${preload}`,
      PC_HEAVY_ADMISSION_SCRIPT: script,
      PC_HEAVY_BYPASS: '',
      PC_HEAVY_DIR: `${HOSTED_WORKSPACE_ACCOUNT_HOME}/.local/state/pc-heavy`,
      PC_HEAVY_TYPECHECK_GUARD: '0',
      PC_HEAVY_GATE_RESERVE: '0',
      PC_HEAVY_ALLOW_DURING_GATE: '1',
      PC_HEAVY_COALESCE: '0',
      // D-033: pinned, so a fresh hosted host never starts at pc-heavy's 14 GiB default.
      PC_HEAVY_MEM_PER_SLOT_GIB: '4',
    });
    expect(hostedHeavyAdmissionEnv(bin, (p) => p !== script)).toBeUndefined();
    expect(hostedHeavyAdmissionEnv(bin, (p) => p !== preload)).toBeUndefined();
  });

  it('the chat transform carries it to the customer agent, overriding a forwarded NODE_OPTIONS', () => {
    const on = hostedCustomerAgentSpawnTransform(withToolchain({ toolchainBin: bin, exists: both }))(
      codexRequest({ NODE_OPTIONS: '--max-old-space-size=99999', PC_HEAVY_BYPASS: '1' }),
    );
    const h = header(on.stdinPrelude);
    expect(h.env.NODE_OPTIONS).toBe(`--require=${preload}`);
    expect(h.env.PC_HEAVY_TYPECHECK_GUARD).toBe('0');
    expect(h.env.PC_HEAVY_ADMISSION_SCRIPT).toBe(script);
    expect(h.env.PC_HEAVY_BYPASS).toBe(''); // a forwarded bypass must not disable admission
    expect(h.env.PATH.split(':')[0]).toBe(bin);

    const off = hostedCustomerAgentSpawnTransform(withToolchain({ toolchainBin: bin, exists: (p) => p.startsWith(`${bin}/`) }))(codexRequest());
    const o = header(off.stdinPrelude);
    expect(Object.keys(o.env).filter((k) => k === 'NODE_OPTIONS' || k.startsWith('PC_HEAVY_'))).toEqual([]);
  });

  it('the psu spec carries it as fixedEnv (which the TTY host accepts) only when both files exist', () => {
    const spec = hostedCustomerAgentIdentitySpec({ localHome: '/var/lib/papercusp', baseEnv: {}, toolchainBin: bin, exists: both });
    expect(spec.fixedEnv).toEqual(hostedHeavyAdmissionEnv(bin, both));
    expect(parseAgentIdentitySpec(JSON.stringify(spec)).fixedEnv?.NODE_OPTIONS).toBe(`--require=${preload}`);
    const without = hostedCustomerAgentIdentitySpec({ localHome: '/var/lib/papercusp', baseEnv: {}, toolchainBin: bin, exists: () => false });
    expect(without.fixedEnv).toBeUndefined();
  });
});

// WI-10005362: the shared typecheck service is advertised only when the bootstrap installed both
// template units (it skips hosts under 24 GiB), and rides in the same operator-fixed env.
describe('hosted shared typecheck service env (WI-10005362)', () => {
  const bin = '/opt/tc/bin';
  const units = (p: string) =>
    p === WORKSPACE_HOST_TSC_SERVICE_SOCKET_UNIT_FILE || p === WORKSPACE_HOST_TSC_SERVICE_UNIT_FILE || p.startsWith(`${bin}/`);

  it('names the template only when both unit files exist', () => {
    expect(hostedTscServiceEnv(units)).toEqual({ PAPERCUSP_TSC_SERVICE_UNIT_TEMPLATE: 'papercusp-tsc-service' });
    expect(hostedTscServiceEnv((p) => p === WORKSPACE_HOST_TSC_SERVICE_SOCKET_UNIT_FILE)).toBeUndefined();
    expect(hostedTscServiceEnv(() => false)).toBeUndefined();
  });

  it('reaches both agent paths, alone or beside heavy admission', () => {
    const spec = hostedCustomerAgentIdentitySpec({ localHome: '/var/lib/papercusp', baseEnv: {}, toolchainBin: bin, exists: units });
    expect(spec.fixedEnv).toEqual({ PAPERCUSP_TSC_SERVICE_UNIT_TEMPLATE: 'papercusp-tsc-service' });
    const h = header(hostedCustomerAgentSpawnTransform(withToolchain({ toolchainBin: bin, exists: units }))(codexRequest()).stdinPrelude);
    expect(h.env.PAPERCUSP_TSC_SERVICE_UNIT_TEMPLATE).toBe('papercusp-tsc-service');

    const all = (p: string) => units(p) || p.startsWith('/opt/tc/lib/heavy-admission/');
    const both = hostedCustomerAgentIdentitySpec({ localHome: '/var/lib/papercusp', baseEnv: {}, toolchainBin: bin, exists: all });
    expect(both.fixedEnv).toEqual({ ...hostedHeavyAdmissionEnv(bin, all), PAPERCUSP_TSC_SERVICE_UNIT_TEMPLATE: 'papercusp-tsc-service' });
  });
});
