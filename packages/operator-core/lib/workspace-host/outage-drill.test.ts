import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE_HOST_OMP_LOCAL_MODEL } from '@papercusp/deployment-driver';
import { describe, expect, it } from 'vitest';
import {
  agentTaskInvocation,
  awsSubnetNetworkAcl,
  buildAwsNetworkAclEgressDeny,
  buildEgressDenyRule,
  classifyConnections,
  evaluateGatedAgentTask,
  evaluateOutageDrill,
  GATE_RELEASED_MARKER,
  gateReleaseCommand,
  normalizeAddress,
  parseEstablishedConnections,
  runGatedAgentTask,
  runOutageDrill,
  sha256Hex,
  type GatedAgentTaskConfig,
  type HostCommandResult,
  type OutageDrillConfig,
  type OutageDrillDeps,
  type OutageDrillEvidence,
} from './outage-drill';

const PAPERCUSP = ['104.21.73.140', '172.67.145.145'];
const MODEL = ['160.79.104.10'];

// This is calibration of the verifier against an immutable historical live
// measurement, NOT a fresh cloud drill or a replacement for live acceptance.
function preservedGcpOutageReceipt() {
  const bytes = readFileSync(new URL('../../../../docs/evidence/j5-outage-drill-2026-10-02.json', import.meta.url));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    'b3f5e13aea609c496687170abce984464b6859759977bbdbe588e700f7ac7481',
  );
  return JSON.parse(bytes.toString('utf8')) as {
    config: { secret: string };
    evidence: OutageDrillEvidence;
  };
}

describe('AUTO-BAR-R-12-P-017 preserved live GCP receipt calibration', () => {
  it('accepts the original measured outage and independently checks its task digest', () => {
    const { config: recordedConfig, evidence } = preservedGcpOutageReceipt();
    const independentDigest = createHash('sha256').update(recordedConfig.secret).digest('hex');
    expect(evidence.agent.expected).toBe(independentDigest);
    expect(evidence.agent.output).toBe(independentDigest);
    expect(evidence.agent.exitCode).toBe(0);
    expect(evidence.during.papercuspReachable).toBe(false);
    expect(evidence.after.connectorLastSeenAt! > evidence.liftedAt!).toBe(true);
    expect(evaluateOutageDrill(evidence)).toEqual({ passed: true, failures: [] });
  });

  it('rejects a wrong task digest in the otherwise valid preserved receipt', () => {
    const { evidence } = preservedGcpOutageReceipt();
    const verdict = evaluateOutageDrill({
      ...evidence,
      agent: { ...evidence.agent, output: '0'.repeat(64) },
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.failures).toContain('the agent output is missing or not the expected digest');
  });

  it('rejects an ineffective egress block in the otherwise valid preserved receipt', () => {
    const { evidence } = preservedGcpOutageReceipt();
    const verdict = evaluateOutageDrill({
      ...evidence,
      during: { ...evidence.during, papercuspReachable: true },
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.failures).toContain('Papercusp was still reachable from the host during the block');
  });

  it('rejects a heartbeat that never resumes after the recorded block lifts', () => {
    const { evidence } = preservedGcpOutageReceipt();
    const verdict = evaluateOutageDrill({
      ...evidence,
      after: { ...evidence.after, connectorLastSeenAt: evidence.liftedAt },
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.failures).toContain("the control plane did not hear from the host's connector after the block was lifted");
  });
});

const config: OutageDrillConfig = {
  target: { cloud: 'gcp', project: 'pc-canary', network: 'pc-host-net', ruleName: 'pc-j5-outage-drill-n1' },
  papercuspOrigin: 'https://app.papercusp.com',
  modelProviderOrigin: 'https://api.anthropic.com',
  serviceUnit: 'papercusp-workspace.service',
  agentCommand: '/usr/local/lib/papercusp-agent-toolchain/bin/claude',
  workspaceDir: '/srv/papercusp/workspaces/ws',
  nonce: 'n1',
  secret: 's3cret-value',
  pollMs: 1_000,
  agentTimeoutMs: 60_000,
  reconnectTimeoutMs: 60_000,
};

interface FakeOptions {
  /** The connector reconnects this many ms after the block lifts; null = never. */
  readonly reconnectAfterMs?: number | null;
  /** The agent finishes this many ms after it reads its gate (or after launch, with agentSkipsGate). */
  readonly agentRunsMs?: number;
  /** The agent ignores its gate pipe and exits on its own (the 2026-10-02 live failure shape). */
  readonly agentSkipsGate?: boolean;
  /** The agent never opens its gate pipe, so the drill's write times out. */
  readonly agentNeverReadsGate?: boolean;
  /** What the agent writes; defaults to the correct digest. */
  readonly agentOutput?: string;
  readonly agentExitCode?: number;
  /** The firewall rule never takes effect. */
  readonly blockIneffective?: boolean;
  readonly deleteFails?: boolean;
  /** The Nth create call (1-based) fails, e.g. an AWS ACL entry refused for the entry limit. */
  readonly createFailsAt?: number;
}

/** create/delete for both clouds: gcloud `compute firewall-rules <verb>`, aws `ec2 <verb>-network-acl-entry`. */
function cloudVerb(args: readonly string[]): string | undefined {
  if (args[1] === 'create-network-acl-entry') return 'create';
  if (args[1] === 'delete-network-acl-entry') return 'delete';
  return args[2];
}

/** A host whose behaviour depends on whether the egress rule exists, driven by a fake clock. */
function fakeHost(options: FakeOptions = {}) {
  let clock = Date.parse('2026-10-02T10:00:00Z');
  let blocked = false;
  let connectorUp = true;
  let connectorConnectedAt: number | null = clock - 60_000;
  let liftedAt: number | null = null;
  let agentStartedAt: number | null = null;
  let gateReadAt: number | null = null;
  let gateReadWhileBlocked: boolean | null = null;
  const commands: string[] = [];
  const cloud: string[][] = [];
  const tick = () => {
    if (blocked) connectorUp = false;
    if (!blocked && !connectorUp && liftedAt !== null && options.reconnectAfterMs !== null) {
      if (clock - liftedAt >= (options.reconnectAfterMs ?? 3_000)) {
        connectorUp = true;
        connectorConnectedAt = clock;
      }
    }
  };
  const agentDone = () => {
    if (options.agentSkipsGate) return agentStartedAt !== null && clock - agentStartedAt >= (options.agentRunsMs ?? 1_000);
    return gateReadAt !== null && clock - gateReadAt >= (options.agentRunsMs ?? 8_000);
  };
  const ok = (stdout = ''): HostCommandResult => ({ code: 0, stdout, stderr: '' });
  const deps: OutageDrillDeps = {
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
      tick();
    },
    resolveAddresses: async (hostname) => (hostname === 'app.papercusp.com' ? PAPERCUSP : MODEL),
    readConnectorLastSeenAt: async () => (connectorConnectedAt === null ? null : new Date(connectorConnectedAt)),
    cloudExec: async (args) => {
      cloud.push([...args]);
      clock += 2_000;
      if (cloudVerb(args) === 'create') {
        if (cloud.filter((call) => cloudVerb(call) === 'create').length === options.createFailsAt) {
          return { code: 1, stdout: '', stderr: 'NetworkAclEntryLimitExceeded' };
        }
        blocked = !options.blockIneffective;
      }
      if (cloudVerb(args) === 'delete') {
        if (options.deleteFails) return { code: 1, stdout: '', stderr: 'permission denied' };
        blocked = false;
        liftedAt = clock;
      }
      tick();
      return ok();
    },
    hostExec: async (command) => {
      commands.push(command);
      clock += 500;
      tick();
      if (command.startsWith('ss ')) {
        const rows = ['0 0 10.0.0.2:22 35.235.241.7:51234'];
        if (connectorUp) rows.push('0 0 10.0.0.2:40000 104.21.73.140:443');
        if (agentStartedAt !== null && !agentDone()) rows.push('0 0 10.0.0.2:40100 160.79.104.10:443');
        return ok(rows.join('\n'));
      }
      if (command.startsWith('systemctl is-active')) return ok('active\n');
      if (command.startsWith('curl')) {
        const toPapercusp = command.includes('papercusp.com');
        return toPapercusp && blocked ? { code: 28, stdout: '', stderr: 'timed out' } : ok();
      }
      if (command.includes('nohup')) {
        agentStartedAt = clock;
        return ok();
      }
      if (command.startsWith('test -e')) return { code: agentDone() ? 0 : 1, stdout: '', stderr: '' };
      if (command.startsWith('timeout') && command.includes('.gate')) {
        // The write blocks until the agent's `cat` opens the pipe; a finished or absent reader times out.
        if (options.agentNeverReadsGate || agentDone()) return { code: 124, stdout: '', stderr: '' };
        gateReadAt = clock;
        gateReadWhileBlocked = blocked;
        return ok(`${GATE_RELEASED_MARKER}\n`);
      }
      if (command.startsWith('rm -f')) return ok();
      if (command.startsWith('cat') && command.includes('.exit')) return ok(agentDone() ? `${options.agentExitCode ?? 0}\n` : '');
      if (command.startsWith('cat')) return ok(`${options.agentOutput ?? sha256Hex(config.secret)}\n`);
      return { code: 127, stdout: '', stderr: `unexpected ${command}` };
    },
  };
  return { deps, commands, cloud, gateReadWhileBlocked: () => gateReadWhileBlocked };
}

describe('parseEstablishedConnections', () => {
  it('reads ss rows, normalises v4-mapped IPv6 peers, and drops unparseable lines', () => {
    const rows = parseEstablishedConnections(
      ['0 0 10.0.0.2:40000 104.21.73.140:443', '0 0 [::ffff:10.0.0.2]:22 [::ffff:35.235.241.7]:5', 'garbage', ''].join('\n'),
    );
    expect(rows).toEqual([
      { localAddress: '10.0.0.2', localPort: 40000, remoteAddress: '104.21.73.140', remotePort: 443 },
      { localAddress: '10.0.0.2', localPort: 22, remoteAddress: '35.235.241.7', remotePort: 5 },
    ]);
    expect(normalizeAddress('[2606:4700::1]')).toBe('2606:4700::1');
  });

  it('classifies peers by the addresses resolved at drill time', () => {
    const classes = classifyConnections(parseEstablishedConnections('0 0 a:1 104.21.73.140:443\n0 0 a:2 160.79.104.10:443\n0 0 a:3 8.8.8.8:53'), {
      papercusp: PAPERCUSP,
      modelProvider: MODEL,
    }).map((connection) => connection.class);
    expect(classes).toEqual(['papercusp', 'model-provider', 'other']);
  });
});

describe('buildEgressDenyRule', () => {
  it('denies exactly the resolved addresses on the host network, and deletes the same rule', () => {
    const rule = buildEgressDenyRule({ project: 'p', network: 'n', ruleName: 'pc-j5-x', addresses: ['172.67.145.145', '104.21.73.140', '104.21.73.140'] });
    expect(rule.createArgs).toEqual(expect.arrayContaining(['--network', 'n', '--direction', 'EGRESS', '--action', 'DENY']));
    expect(rule.createArgs[rule.createArgs.indexOf('--destination-ranges') + 1]).toBe('104.21.73.140/32,172.67.145.145/32');
    expect(rule.deleteArgs).toEqual(['compute', 'firewall-rules', 'delete', 'pc-j5-x', '--project', 'p', '--quiet']);
  });

  it('refuses an empty block, a non-IPv4 address, and an invalid rule name', () => {
    expect(() => buildEgressDenyRule({ project: 'p', network: 'n', ruleName: 'pc-j5-x', addresses: [] })).toThrow(/no Papercusp addresses/);
    expect(() => buildEgressDenyRule({ project: 'p', network: 'n', ruleName: 'pc-j5-x', addresses: ['2606:4700::1'] })).toThrow(/IPv4/);
    expect(() => buildEgressDenyRule({ project: 'p', network: 'n', ruleName: 'Bad_Name', addresses: PAPERCUSP })).toThrow(/rule name/);
  });
});

const ACL_ENTRIES = [
  { ruleNumber: 100, ruleAction: 'allow' as const },
  { ruleNumber: 32767, ruleAction: 'deny' as const },
];
const awsTarget = { cloud: 'aws' as const, region: 'us-east-2', networkAclId: 'acl-0123456789abcdef0', egressEntries: ACL_ENTRIES };
const awsConfig: OutageDrillConfig = { ...config, target: awsTarget };

describe('buildAwsNetworkAclEgressDeny', () => {
  it('denies each address with its own entry, numbered ahead of the first allow, and deletes the same entries', () => {
    const block = buildAwsNetworkAclEgressDeny(
      { ...awsTarget, egressEntries: [{ ruleNumber: 1, ruleAction: 'deny' }, ...ACL_ENTRIES] },
      ['172.67.145.145', '104.21.73.140', '104.21.73.140'],
    );
    const scope = ['--region', 'us-east-2', '--network-acl-id', 'acl-0123456789abcdef0', '--egress'];
    expect(block.steps.map((step) => step.createArgs)).toEqual([
      ['ec2', 'create-network-acl-entry', ...scope, '--rule-number', '2', '--protocol', '-1', '--rule-action', 'deny', '--cidr-block', '104.21.73.140/32'],
      ['ec2', 'create-network-acl-entry', ...scope, '--rule-number', '3', '--protocol', '-1', '--rule-action', 'deny', '--cidr-block', '172.67.145.145/32'],
    ]);
    expect(block.steps.map((step) => step.deleteArgs)).toEqual([
      ['ec2', 'delete-network-acl-entry', ...scope, '--rule-number', '2'],
      ['ec2', 'delete-network-acl-entry', ...scope, '--rule-number', '3'],
    ]);
  });

  it('refuses an ACL with no room ahead of its first allow, a bad ACL id, and a non-IPv4 address', () => {
    expect(() => buildAwsNetworkAclEgressDeny({ ...awsTarget, egressEntries: [{ ruleNumber: 2, ruleAction: 'allow' }] }, PAPERCUSP))
      .toThrow(/1 free egress rule number\(s\) below its first allow \(rule 2\); 2 needed/);
    expect(() => buildAwsNetworkAclEgressDeny({ ...awsTarget, networkAclId: 'sg-0123456789abcdef0' }, PAPERCUSP)).toThrow(/network ACL id/);
    expect(() => buildAwsNetworkAclEgressDeny(awsTarget, ['2606:4700::1'])).toThrow(/IPv4/);
  });
});

describe('awsSubnetNetworkAcl', () => {
  it('picks the ACL associated with the subnet and keeps only its egress entries', () => {
    const json = JSON.stringify({
      NetworkAcls: [
        {
          NetworkAclId: 'acl-0aaaaaaaaaaaaaaaa',
          Associations: [{ SubnetId: 'subnet-1' }],
          Entries: [
            { RuleNumber: 100, RuleAction: 'allow', Egress: true },
            { RuleNumber: 100, RuleAction: 'allow', Egress: false },
            { RuleNumber: 32767, RuleAction: 'deny', Egress: true },
          ],
        },
        { NetworkAclId: 'acl-0bbbbbbbbbbbbbbbb', Associations: [{ SubnetId: 'subnet-2' }], Entries: [] },
      ],
    });
    expect(awsSubnetNetworkAcl(json, 'subnet-1')).toEqual({
      networkAclId: 'acl-0aaaaaaaaaaaaaaaa',
      egressEntries: [{ ruleNumber: 100, ruleAction: 'allow' }, { ruleNumber: 32767, ruleAction: 'deny' }],
    });
    expect(() => awsSubnetNetworkAcl(json, 'subnet-9')).toThrow(/found 0/);
  });
});

describe('runOutageDrill + evaluateOutageDrill', () => {
  it('passes when the agent finishes during the block and the connector reconnects after the lift', async () => {
    const host = fakeHost();
    const evidence = await runOutageDrill(config, host.deps);
    const verdict = evaluateOutageDrill(evidence);
    expect(verdict).toEqual({ passed: true, failures: [] });
    expect(evidence.during).toMatchObject({ papercuspReachable: false, modelProviderReachable: true, agentRunningWhenBlocked: true, papercuspConnectionsWhileBlocked: 0 });
    expect(host.cloud.map((args) => args[2])).toEqual(['create', 'delete']);
    // The agent is launched detached BEFORE the block, so the outage lands mid-task.
    const launchIndex = host.commands.findIndex((command) => command.includes('nohup'));
    expect(launchIndex).toBeGreaterThan(-1);
  });

  it('fails, naming the cause, when the host never reconnects after the lift', async () => {
    const verdict = evaluateOutageDrill(await runOutageDrill(config, fakeHost({ reconnectAfterMs: null }).deps));
    expect(verdict.passed).toBe(false);
    expect(verdict.failures).toEqual(expect.arrayContaining([
      "the control plane did not hear from the host's connector after the block was lifted",
      'after the lift the host held no connection to Papercusp',
    ]));
  });

  it('fails when the agent output is wrong or the agent exits non-zero', async () => {
    const wrong = evaluateOutageDrill(await runOutageDrill(config, fakeHost({ agentOutput: 'deadbeef' }).deps));
    expect(wrong.failures).toContain('the agent output is missing or not the expected digest');
    const crashed = evaluateOutageDrill(await runOutageDrill(config, fakeHost({ agentExitCode: 1 }).deps));
    expect(crashed.failures).toContain('the agent task exited 1');
  });

  it('fails when the block never took effect, so a vacuous outage cannot pass', async () => {
    const verdict = evaluateOutageDrill(await runOutageDrill(config, fakeHost({ blockIneffective: true }).deps));
    expect(verdict.failures).toContain('Papercusp was still reachable from the host during the block');
  });

  it('fails when the agent ignored its gate and finished before the block landed', async () => {
    const verdict = evaluateOutageDrill(await runOutageDrill(config, fakeHost({ agentSkipsGate: true }).deps));
    expect(verdict.failures).toEqual(expect.arrayContaining([
      'the agent task was not running when the block landed',
      'the agent was never handed its secret during the outage',
    ]));
  });

  it('hands the agent its secret only through the pipe, and only once Papercusp is unreachable', async () => {
    const host = fakeHost();
    const evidence = await runOutageDrill(config, host.deps);
    expect(host.gateReadWhileBlocked()).toBe(true);
    expect(evidence.agent.gateReleasedAt! > evidence.blockedAt!).toBe(true);
    const launch = host.commands.find((command) => command.includes('nohup'))!;
    expect(launch).toContain('mkfifo');
    expect(launch).not.toContain(config.secret);
    // Only the agent is backgrounded, with every stream detached; a trailing bare `&` would background the
    // whole `&&` list holding the SSH channel open, so the launch call would return only when the agent exits.
    expect(launch).toMatch(/ && \{ nohup sh -c .* < \/dev\/null > \/dev\/null 2>&1 & \}$/);
    expect(evidence.agent.expected).toBe(sha256Hex(config.secret));
  });

  it('serves a reader that re-opens the gate path after its read, instead of leaving it blocked', async () => {
    // Real FIFO, real shell. The reader reads the pipe, then opens the same path again: the Claude Code
    // behaviour that stalled live run #4 for 5 minutes in the kernel's wait_for_partner.
    const dir = mkdtempSync(join(tmpdir(), 'j5-gate-'));
    try {
      const gate = join(dir, 'drill.gate');
      execFileSync('mkfifo', ['-m', '600', gate]);
      const reader = spawn('sh', ['-c', `cat '${gate}'; echo; timeout 5 cat '${gate}' > /dev/null; echo reopen=$?`]);
      let read = '';
      reader.stdout.setEncoding('utf8').on('data', (chunk: string) => { read += chunk; });
      // 'close', not 'exit': 'exit' can fire before the reader's last stdout chunk is delivered.
      const exited = new Promise<number | null>((resolve) => reader.on('close', resolve));
      const released = execFileSync('sh', ['-c', `timeout 10 sh -c '${gateReleaseCommand(gate, 's3cret').replace(/'/g, `'\\''`)}'`]).toString();
      expect(released).toContain(GATE_RELEASED_MARKER);
      expect(await exited).toBe(0);
      expect(read).toContain('s3cret');
      // 124 here means the re-open blocked until `timeout` killed it.
      expect(read).toContain('reopen=0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never leaves the gate path missing while it swaps the pipe for the empty file', async () => {
    // WI-10006055: the release used to move the pipe aside and only THEN create the empty file, so a re-open
    // landing in between got ENOENT (`reopen=1` on the gate at f07043ba). Sample the path continuously from
    // the moment the secret is taken until the regular file is in place: it must never be absent.
    const dir = mkdtempSync(join(tmpdir(), 'j5-gate-'));
    try {
      const gate = join(dir, 'drill.gate');
      execFileSync('mkfifo', ['-m', '600', gate]);
      const reader = spawn('sh', [
        '-c',
        `cat '${gate}' > /dev/null; miss=0; while [ ! -f '${gate}' ]; do [ -e '${gate}' ] || miss=$((miss+1)); done; echo miss=$miss`,
      ]);
      let read = '';
      reader.stdout.setEncoding('utf8').on('data', (chunk: string) => { read += chunk; });
      // 'close', not 'exit': 'exit' can fire before the reader's last stdout chunk is delivered.
      const exited = new Promise<number | null>((resolve) => reader.on('close', resolve));
      const released = execFileSync('sh', ['-c', `timeout 10 sh -c '${gateReleaseCommand(gate, 's3cret').replace(/'/g, `'\\''`)}'`]).toString();
      expect(released).toContain(GATE_RELEASED_MARKER);
      expect(await exited).toBe(0);
      expect(read).toContain('miss=0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails, naming the cause, when the agent never opens its gate pipe', async () => {
    const host = fakeHost({ agentNeverReadsGate: true });
    const evidence = await runOutageDrill(config, host.deps);
    expect(host.cloud.map((args) => args[2])).toEqual(['create', 'delete']);
    expect(evaluateOutageDrill(evidence).failures).toEqual(expect.arrayContaining([
      'drill error: the agent never read its gate pipe within 60s (exit 124)',
      'the agent was never handed its secret during the outage',
    ]));
  });

  it('never releases the secret when the block did not take effect', async () => {
    const host = fakeHost({ blockIneffective: true });
    const evidence = await runOutageDrill(config, host.deps);
    expect(host.gateReadWhileBlocked()).toBeNull();
    expect(evidence.agent.gateReleasedAt).toBeNull();
  });

  it('always tries to lift the block, and reports a block it could not remove', async () => {
    const host = fakeHost({ deleteFails: true });
    const evidence = await runOutageDrill(config, host.deps);
    expect(host.cloud.map((args) => args[2])).toEqual(['create', 'delete']);
    expect(evaluateOutageDrill(evidence).failures).toEqual(expect.arrayContaining([
      'drill error: egress block NOT removed (pc-j5-outage-drill-n1): permission denied',
      'the egress block was not removed',
    ]));
  });

  it('runs on AWS: one ACL deny entry per address, lifted in reverse after the agent finishes', async () => {
    const host = fakeHost();
    const evidence = await runOutageDrill(awsConfig, host.deps);
    expect(evaluateOutageDrill(evidence).failures).toEqual([]);
    expect(evaluateOutageDrill(evidence).passed).toBe(true);
    expect(host.cloud.map((args) => `${args[1]} ${args[8]}`)).toEqual([
      'create-network-acl-entry 1', 'create-network-acl-entry 2', 'delete-network-acl-entry 2', 'delete-network-acl-entry 1',
    ]);
  });

  it('undoes the AWS entries that applied when a later entry fails, and fails the drill', async () => {
    const host = fakeHost({ createFailsAt: 2 });
    const evidence = await runOutageDrill(awsConfig, host.deps);
    expect(host.cloud.map((args) => `${args[1]} ${args[8]}`)).toEqual([
      'create-network-acl-entry 1', 'create-network-acl-entry 2', 'delete-network-acl-entry 1',
    ]);
    expect(evidence.blockedAt).toBeNull();
    expect(evidence.ruleDeleted).toBe(true);
    expect(evaluateOutageDrill(evidence).failures).toEqual(expect.arrayContaining([
      'drill error: egress block failed: NetworkAclEntryLimitExceeded',
    ]));
  });

  it('never blocks anything when Papercusp and the model provider share an address', async () => {
    const host = fakeHost();
    const shared: OutageDrillDeps = { ...host.deps, resolveAddresses: async () => ['104.21.73.140'] };
    const evidence = await runOutageDrill(config, shared);
    expect(host.cloud).toEqual([]);
    expect(evaluateOutageDrill(evidence).failures[0]).toMatch(/share addresses 104\.21\.73\.140/);
  });

  it('launches OMP with its own argv when the drill names agentKind omp', async () => {
    const host = fakeHost();
    const evidence = await runOutageDrill({ ...config, agentKind: 'omp', agentCommand: '/usr/local/bin/omp' }, host.deps);
    const launch = host.commands.find((command) => command.includes('nohup'))!;
    expect(launch).toContain('--print');
    expect(launch).not.toContain('--allowedTools');
    expect(evaluateOutageDrill(evidence)).toEqual({ passed: true, failures: [] });
  });
});

describe('agentTaskInvocation', () => {
  it('runs Claude non-interactively with only the Bash and Write tools', () => {
    expect(agentTaskInvocation('claude', '/bin/claude', 'do it')).toBe(`'/bin/claude' -p 'do it' --allowedTools Bash,Write`);
  });

  it("runs OMP on the host's local-inference model with only bash and write, auto-approved", () => {
    const omp = agentTaskInvocation('omp', '/usr/local/bin/omp', "it's");
    expect(omp.startsWith(`'/usr/local/bin/omp' --model 'ollama/${WORKSPACE_HOST_OMP_LOCAL_MODEL}' `)).toBe(true);
    expect(omp).toContain(' --print --tools bash,write --approval-mode yolo ');
    expect(omp).toContain('--no-session');
    expect(omp.endsWith(` 'it'\\''s'`)).toBe(true);
  });
});

describe('runGatedAgentTask + evaluateGatedAgentTask', () => {
  const task: GatedAgentTaskConfig = {
    agentKind: 'omp',
    agentCommand: '/usr/local/bin/omp',
    workspaceDir: config.workspaceDir,
    nonce: 't1',
    secret: config.secret,
    pollMs: 1_000,
    agentTimeoutMs: 60_000,
  };

  it('passes when the agent takes its secret from the gate and writes its digest, and never touches the network', async () => {
    const host = fakeHost();
    const evidence = await runGatedAgentTask(task, host.deps);
    expect(evaluateGatedAgentTask(evidence)).toEqual({ passed: true, failures: [] });
    expect(host.cloud).toEqual([]);
    const launch = host.commands.find((command) => command.includes('nohup'))!;
    expect(launch).toMatch(/ && \{ nohup sh -c .* < \/dev\/null > \/dev\/null 2>&1 & \}$/);
    expect(launch).toContain(`ollama/${WORKSPACE_HOST_OMP_LOCAL_MODEL}`);
    expect(launch).not.toContain(task.secret);
    expect(evidence.secretInInvocation).toBe(false);
    expect(evidence.agent.expected).toBe(sha256Hex(task.secret));
    const release = host.commands.findIndex((command) => command.startsWith('timeout') && command.includes('.gate'));
    expect(release).toBeGreaterThan(host.commands.indexOf(launch));
    expect(host.commands.at(-1)).toMatch(/^rm -f '.*\.gate'$/);
  });

  it('fails, naming the cause, when the output is wrong or the agent exits non-zero', async () => {
    const wrong = evaluateGatedAgentTask(await runGatedAgentTask(task, fakeHost({ agentOutput: 'deadbeef' }).deps));
    expect(wrong.failures).toEqual(['the agent output is missing or not the expected digest']);
    const crashed = evaluateGatedAgentTask(await runGatedAgentTask(task, fakeHost({ agentExitCode: 1 }).deps));
    expect(crashed.failures).toEqual(['the agent task exited 1']);
  });

  it('fails when the agent never opens its gate pipe, and still removes the gate', async () => {
    const host = fakeHost({ agentNeverReadsGate: true });
    const evidence = await runGatedAgentTask(task, host.deps);
    expect(evaluateGatedAgentTask(evidence).failures).toEqual(expect.arrayContaining([
      'task error: the agent never read its gate pipe within 60s (exit 124)',
      'the agent never read its secret from the gate pipe',
    ]));
    expect(host.commands.at(-1)).toMatch(/^rm -f '.*\.gate'$/);
  });

  it('fails a task whose secret is visible in its own invocation', async () => {
    const leaky = { ...task, agentCommand: `/usr/local/bin/omp-${task.secret}` };
    const evidence = await runGatedAgentTask(leaky, fakeHost().deps);
    expect(evidence.secretInInvocation).toBe(true);
    expect(evaluateGatedAgentTask(evidence).failures).toEqual([
      'the secret appears in the agent invocation, so the output proves nothing',
    ]);
  });
});
