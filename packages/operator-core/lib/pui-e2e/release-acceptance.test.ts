import { describe, expect, it, vi } from 'vitest';
import { parseCLI, resolveConfig } from 'vitest/node';
import { ADMIN_TEST_RUNS_REPORTER_PATH } from '@papercusp/test-config/vitest-config';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SuSessionEvent } from '@papercusp/chat-protocol';
import * as path from 'node:path';
import { assertInstalledPuiStore, checkReleaseAcceptance, disqualification, HARNESS_TAG, loadAcceptanceMatrix, loadRequiredMatrix, nativeApprovalFollowupDecline, nativeApprovalRequest, nativeApprovalTurnSettled, nativeInterruptRequest, parseAcceptanceLines, parseHarnessLine, REPO_ROOT, suToolApproval, type Candidate, type EvidenceRow } from './release-acceptance';
import {
  CLOUD_DEVICE_START_ATTEMPTS, cloudDeviceStartBlocksLegs, cloudDeviceStartTransient, DOCKER_START_PROBE_TIMEOUT_MS,
  legsBlocked, measureCloudDeviceStart, measureRunnerTree, prepareOperatorRuntimePackages, probeDockerCreateStart, probeRoutedCodexModel, remeasureCloudDeviceStart, remeasureStockMachines,
  RELEASE_ACCEPTANCE_REPORTER_ARGS, runCloudDeviceStartSmoke, runnerTreeRefusals, runReleaseAcceptance, runStockMachineSmoke, stockMachineRefusal, stockMachinesBlockLegs,
  sweepOrphanedProbeContainers, type CloudDeviceStartResult,
} from './release-acceptance-run';

describe('native SU prerequisite approvals', () => {
  it.each([
    'Write(xd://mcp_papercusp-su_work_items_get)',
    'Write(xd://mcp__papercusp_su_work_items_get)',
    'Write(xd://mcp__papercusp_su__work_items_get)',
  ])('answers the mounted MCP call once without allowing later native writes: %s', (title) => {
    expect(suToolApproval(title)).toEqual({ tool: 'papercusp-su · work items get', remember: false });
  });

  it('keeps the existing direct MCP per-tool approval', () => {
    expect(suToolApproval('papercusp-su · work items get (MCP)'))
      .toEqual({ tool: 'papercusp-su · work items get', remember: true });
  });

  it.each([
    'Write(/tmp/requested-note.txt)',
    'Bash(printf note > /tmp/requested-note.txt)',
    'Write(xd://mcp__other_server__work_items_get)',
    'Write(/tmp/xd://mcp__papercusp_su__work_items_get)',
    'Write(xd://mcp__papercusp_su__work_items_get/another-path)',
  ])('leaves native effects and unrelated devices for their explicit card: %s', (title) => {
    expect(suToolApproval(title)).toBeUndefined();
  });
});

describe('native approval terminal wait', () => {
  const event = (value: Record<string, unknown>) => value as unknown as SuSessionEvent;
  const reply = event({ type: 'transcript', phase: 'completed', role: 'assistant',
    channel: 'text', turnId: 'requested-turn', sequence: 10 });
  const idle = event({ type: 'lifecycle', state: 'waiting-for-owner', sequence: 11 });

  it('fails promptly when the requested turn replies and settles without a card', () => {
    expect(nativeApprovalTurnSettled([reply, idle], 'requested-turn', false)).toBe(true);
  });
  it('keeps waiting for a pending card, including a prerequisite MCP approval', () => {
    expect(nativeApprovalTurnSettled([reply, idle], 'requested-turn', true)).toBe(false);
  });
  it('does not mistake an earlier turn, reasoning completion, or initial idle for a refusal', () => {
    expect(nativeApprovalTurnSettled([reply, idle], 'next-turn', false)).toBe(false);
    expect(nativeApprovalTurnSettled([event({ ...reply, channel: 'reasoning' }), idle], 'requested-turn', false)).toBe(false);
    expect(nativeApprovalTurnSettled([idle, event({ ...reply, sequence: 12 })], 'requested-turn', false)).toBe(false);
  });
  it.each(['failed', 'ended'])('stops a %s native session without a card', (state) => {
    expect(nativeApprovalTurnSettled([event({ type: 'lifecycle', state, sequence: 12 })], 'requested-turn', false)).toBe(true);
  });

  it('does not complete at the post-effect verification card, but completes after its denial and final reply', () => {
    const effect = event({ type: 'tool', phase: 'completed', sequence: 30, turnId: 'requested-turn', isError: false });
    const cardIdle = event({ type: 'lifecycle', state: 'waiting-for-owner', sequence: 34 });
    // The native trace parked at seq 34 with a second card open. It had
    // already emitted assistant text, so lifecycle alone is not sufficient.
    expect(nativeApprovalTurnSettled([reply, effect, cardIdle], 'requested-turn', true)).toBe(false);
    expect(nativeApprovalTurnSettled([reply, effect, cardIdle,
      event({ ...reply, sequence: 37 }), event({ ...idle, sequence: 38 }),
    ], 'requested-turn', false)).toBe(true);
  });
});

describe('native approval follow-up scope', () => {
  const input = { turnId: 'requested-turn', afterSequence: 30, notePath: '/owned/note.txt' };
  const followup = {
    type: 'card', phase: 'opened', sequence: 33, turnId: input.turnId,
    card: {
      correlationId: 'verification', prompt: 'Read /owned/note.txt', allowDecline: true,
      approval: { title: 'Bash(cat /owned/note.txt)', question: 'Do you want to run this command?', body: ['cat /owned/note.txt'] },
      presentation: { kind: 'radio', options: [
        { id: 'yes', label: 'Yes' }, { id: 'always', label: "Yes, and don't ask again" },
        { id: 'no', label: 'No, and tell Codex what to do instead' },
      ] },
    },
  };
  const decline = (value: unknown) => nativeApprovalFollowupDecline(value as SuSessionEvent, input);

  it('only selects the one-request denial, never Yes or remembered permission', () => {
    expect(decline(followup)).toEqual({ key: '3', question: 'Do you want to run this command?',
      label: 'No, and tell Codex what to do instead' });
  });
  it.each([
    { ...followup, turnId: 'other-turn' },
    { ...followup, sequence: 30 },
    { ...followup, phase: 'closed' },
    { ...followup, card: { ...followup.card, allowDecline: false } },
    { ...followup, card: { ...followup.card, approval: undefined } },
    { ...followup, card: { ...followup.card, presentation: { kind: 'text' } } },
    { ...followup, card: { ...followup.card, prompt: '/other/note.txt',
      approval: { ...followup.card.approval, body: ['/other/note.txt'] } } },
    { ...followup, card: { ...followup.card, prompt: '/owned/note.txt.backup',
      approval: { ...followup.card.approval, body: ['/owned/note.txt.backup'] } } },
    { ...followup, card: { ...followup.card, prompt: '/other/owned/note.txt',
      approval: { ...followup.card.approval, body: ['/other/owned/note.txt'] } } },
    { ...followup, card: { ...followup.card, approval: { ...followup.card.approval,
      title: 'papercusp-su · work items get (MCP)' } } },
    { ...followup, card: { ...followup.card, presentation: { kind: 'radio',
      options: followup.card.presentation.options.slice(0, 2) } } },
  ])('leaves unrelated or unsupported card %# unanswered', (value) => {
    expect(decline(value)).toBeUndefined();
  });
});

describe('installed acceptance canonical test ledger', () => {
  it('retains the ledger reporter when Vitest replaces configured reporters with CLI options', async () => {
    const resolveReporters = async (args: string[]) => {
      const { options } = parseCLI(['vitest', 'run', ...args]);
      const { vitestConfig } = await resolveConfig(
        { ...options, root: REPO_ROOT, config: false },
        { test: { reporters: ['default', ADMIN_TEST_RUNS_REPORTER_PATH] } },
      );
      return vitestConfig.reporters.map((entry) => Array.isArray(entry) ? entry[0] : entry);
    };
    // Positive control: exercise Vitest's actual CLI/config merge, which loses
    // the configured recorder when the CLI supplies only the release reporter.
    const legacy = RELEASE_ACCEPTANCE_REPORTER_ARGS.filter(arg => !arg.includes(ADMIN_TEST_RUNS_REPORTER_PATH));
    expect(await resolveReporters(legacy)).not.toContain(ADMIN_TEST_RUNS_REPORTER_PATH);
    const reporters = await resolveReporters(RELEASE_ACCEPTANCE_REPORTER_ARGS);
    expect(reporters).toContain(ADMIN_TEST_RUNS_REPORTER_PATH);
    expect(reporters).toContain(path.join(REPO_ROOT, 'packages/operator-core/lib/pui-e2e/release-acceptance-reporter.ts'));
  });
});

describe('cold operator runtime package admission', () => {
  it('builds the missing CommonJS export from pinned workspace source and refuses a broken source build', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pui-runtime-package-'));
    const packageRoot = path.join(root, 'libs/generic/sse');
    try {
      mkdirSync(packageRoot, { recursive: true });
      for (const file of ['package.json', 'tsconfig.json', 'src']) {
        cpSync(path.join(REPO_ROOT, 'libs/generic/sse', file), path.join(packageRoot, file), { recursive: true });
      }
      symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(packageRoot, 'node_modules'), 'dir');
      const requireFromPackage = createRequire(path.join(packageRoot, 'package.json'));
      // The observed failure: the source tree and toolchain exist, but the
      // CommonJS package export does not exist until the maintained build runs.
      expect(() => requireFromPackage('@papercusp/sse')).toThrow(/Cannot find module/);
      prepareOperatorRuntimePackages(root);
      const loaded = requireFromPackage('@papercusp/sse') as Record<string, unknown>;
      expect(loaded.sseResponse).toBeTypeOf('function');
      expect(loaded.getChannel).toBeTypeOf('function');
      writeFileSync(path.join(packageRoot, 'src/index.ts'), 'this is invalid TypeScript (');
      expect(() => prepareOperatorRuntimePackages(root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('native interruption response budget admission', () => {
  it('admits a numeric stream that fits one response and rejects the observed 10,000-line refusal trigger before inference', () => {
    const prompt = nativeInterruptRequest('ordinary-list');
    const count = Number(prompt.match(/1 through (\d+)/)?.[1]);
    const expectedReply = Array.from({ length: count }, (_, index) => `${index + 1}\n`).join('');
    expect(count).toBeGreaterThanOrEqual(100);
    expect(Buffer.byteLength(expectedReply, 'utf8')).toBeLessThanOrEqual(4096);
    // A real Claude turn interpreted "write the numbers" as a file task and
    // waited on a Write approval. The probe must request inline text only.
    expect(prompt).toContain('Reply directly in this chat');
    expect(prompt).toContain('Do not create or edit files, run commands, or use any tools');
    expect(prompt).not.toMatch(/write the numbers/i);
    expect(() => nativeInterruptRequest('ordinary-list', 10000)).toThrow(/reply budget/);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid line count %s before creating an inference request', (count) => {
    expect(() => nativeInterruptRequest('ordinary-list', count)).toThrow(/numeric lines/);
  });
});

describe('native approval tool contract', () => {
  it.each(['claude', 'codex'])('does not require unavailable framework tools from the bare %s client', (backend) => {
    const prompt = nativeApprovalRequest({ backend, workItem: 'EI-123', ownerId: 'su-owned',
      notePath: '/owned/note.txt', noteText: 'exact note' });
    expect(prompt).not.toContain('work_items:get');
    expect(prompt).not.toContain('EI-123');
    expect(prompt).toContain("'/owned/note.txt'");
    expect(prompt).toContain("'exact note' followed by a newline");
    expect(prompt).toContain('Create it using Bash');
  });

  it('retains actual task-owner verification for the framework OMP client', () => {
    const prompt = nativeApprovalRequest({ backend: 'omp', workItem: 'EI-123', ownerId: 'su-owned',
      notePath: '/owned/note.txt', noteText: 'exact note' });
    expect(prompt).toContain('Task EI-123 is assigned to your session su-owned');
    expect(prompt).toContain('verify it with work_items:get');
  });
});

describe('installed PUI store admission', () => {
  it('rejects a missing, absent, or different store and accepts the installed release through its current symlink', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pui-store-admission-'));
    try {
      const release = path.join(root, 'releases', 'candidate');
      mkdirSync(path.join(release, 'bin'), { recursive: true });
      const binary = path.join(release, 'bin', 'pui');
      writeFileSync(binary, 'installed candidate');
      writeFileSync(path.join(root, 'other-pui'), 'another candidate');
      expect(() => assertInstalledPuiStore(binary, undefined)).toThrow(/PUI_RELEASE_STORE/);
      expect(() => assertInstalledPuiStore(binary, root)).toThrow(/no installed/);
      symlinkSync(release, path.join(root, 'current'));
      expect(() => assertInstalledPuiStore(path.join(root, 'other-pui'), root)).toThrow(/does not match/);
      expect(() => assertInstalledPuiStore(binary, root)).not.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('release acceptance checkout helper snapshot', () => {
  it('keeps the admitted helper stable when the shared source changes during checkout', async () => {
    const wrapper = readFileSync(path.join(REPO_ROOT, 'apps/tui/scripts/release-acceptance.sh'), 'utf8');
    const invocation = wrapper.match(/node "\$ROOT\/scripts\/npm-install-safe\.mjs"[\s\S]*?(?=\nlanded=)/)?.[0];
    expect(invocation).toBeDefined();
    const root = mkdtempSync(path.join(tmpdir(), 'pui-helper-snapshot-'));
    const helper = path.join(root, 'apps/operator/bin/release/setup-release-checkout.sh');
    const snapshot = path.join(root, 'apps/operator/scripts/systemd/papercusp-script-snapshot.sh');
    const installSafe = path.join(root, 'scripts/npm-install-safe.mjs');
    const started = path.join(root, 'started');
    const resume = path.join(root, 'resume');
    const admittedArgs = path.join(root, 'admitted-args');
    const checkouts = path.join(root, 'acceptance-cache');
    mkdirSync(path.dirname(helper), { recursive: true });
    mkdirSync(path.dirname(snapshot), { recursive: true });
    mkdirSync(path.dirname(installSafe), { recursive: true });
    writeFileSync(snapshot, readFileSync(path.join(REPO_ROOT, 'apps/operator/scripts/systemd/papercusp-script-snapshot.sh')));
    // Check the actual shell call enters the maintained reader boundary before
    // executing the snapshotted helper. Its lock arbitration has its own suite.
    writeFileSync(installSafe, `import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] !== '--repo-root' || args[1] !== process.env.ROOT || args[2] !== '--exec-under-lock' || args[3] !== '--' || args[4] !== 'bash') process.exit(42);
const result = spawnSync(args[4], args.slice(5), { stdio: 'inherit', env: { ...process.env, PUI_SNAPSHOT_INSTALL_READER: '1' } });
process.exit(result.status ?? 1);
`);
    // Put the completion beyond Bash's read-ahead buffer. The wait lets the
    // test replace the original only after the admitted program has started.
    writeFileSync(helper, `[ "$PUI_SNAPSHOT_INSTALL_READER" = 1 ] || exit 43\nprintf '%s\\n' "$@" > "$PUI_SNAPSHOT_ARGS"\nprintf '%s' "$0" > "$PUI_SNAPSHOT_STARTED"\nwhile [ ! -f "$PUI_SNAPSHOT_RESUME" ]; do sleep 0.01; done\n`
      + '# padding beyond lazy shell read buffer\n'.repeat(2048)
      + 'printf "CHECKOUT_HELPER_COMPLETED\\n"\n');
    const child = spawn('bash', ['-c', `fail() { exit 2; }\n${invocation}`], {
      env: { ...process.env, ROOT: root, checkouts, checkout: path.join(checkouts, 'slot-1'), sha: 'a'.repeat(40),
        PUI_SNAPSHOT_STARTED: started, PUI_SNAPSHOT_RESUME: resume,
        PUI_SNAPSHOT_ARGS: admittedArgs },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    try {
      await vi.waitFor(() => expect(existsSync(started), `snapshot child exit=${child.exitCode} signal=${child.signalCode}\n${output}`).toBe(true), { timeout: 5_000, interval: 10 });
      expect(readFileSync(started, 'utf8')).not.toBe(helper);
      const args = readFileSync(admittedArgs, 'utf8').trim().split('\n');
      expect(args[args.indexOf('--node-modules-copy') + 1]).toBe('copy');
      expect(args[args.indexOf('--node-modules-generation') + 1]).toBe('required');
      expect(args[args.indexOf('--dependency-generation-root') + 1]).toBe(path.join(checkouts, 'dependency-generations'));
      writeFileSync(helper, 'this is an invalid concurrent edit (\n');
      writeFileSync(resume, 'continue');
      expect(await exit).toBe(0);
      expect(output).toContain('CHECKOUT_HELPER_COMPLETED');
    } finally {
      child.kill();
      writeFileSync(resume, 'continue');
      await exit;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Docker create/start release preflight', () => {
  it('passes on the first bounded offline stock-container launch that succeeds', () => {
    const calls: Array<{ args: string[]; timeout: number }> = [];
    const problem = probeDockerCreateStart((args, timeout) => {
      calls.push({ args, timeout });
      return { status: 0 };
    });
    expect(problem).toBeNull();
    expect(calls[0]).toEqual({ args: ['image', 'inspect', 'ubuntu:24.04'], timeout: 5_000 });
    const launches = calls.filter(({ args }) => args[0] === 'run');
    expect(launches).toHaveLength(1);
    expect(launches[0].timeout).toBe(DOCKER_START_PROBE_TIMEOUT_MS);
    expect(launches[0].args).toEqual(expect.arrayContaining(['--pull=never', '--network=none', 'ubuntu:24.04', '--name']));
  });

  // WI-10004239: on the release host an ordinary first launch took 24.6s (the
  // next 1.4s) while the WI-10003403 wedge lasts minutes. A 20s budget refused
  // every attempt of that healthy host before any leg ran.
  it('gives each launch a budget above a slow loaded-host start and below a minutes-long wedge', () => {
    expect(DOCKER_START_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    expect(DOCKER_START_PROBE_TIMEOUT_MS).toBeLessThan(120_000);
  });

  // EI-24453068584648808: one ~20s stall on a loaded host refused a whole
  // candidate before any leg ran, though the next launch took ~2s.
  it('retries a stalled launch, removes the abandoned container, and passes when a later attempt succeeds', () => {
    const calls: string[][] = [];
    let launches = 0;
    const problem = probeDockerCreateStart((args) => {
      calls.push(args);
      if (args[0] !== 'run') return { status: 0 };
      launches++;
      return launches === 1 ? { status: null, error: { message: 'spawnSync docker ETIMEDOUT' } } : { status: 0 };
    });
    expect(problem).toBeNull();
    expect(launches).toBe(2);
    const first = calls.findIndex((args) => args[0] === 'run');
    const stalledName = calls[first][calls[first].indexOf('--name') + 1];
    expect(stalledName).toMatch(/^pui-release-preflight-/);
    expect(calls[first + 1]).toEqual(['rm', '--force', stalledName]);
    expect(calls[first + 2][0]).toBe('run');
  });

  // WI-10004239: a timed-out client does not cancel the daemon's create, so a
  // per-attempt removal can lose the race and leave a Created container. Eight
  // such containers from three runs were found on the release host.
  it('removes probe containers left by exited runs and keeps those of live runs', () => {
    const calls: string[][] = [];
    const listed = [
      'pui-release-preflight-111-1790766510125-1',
      'pui-release-preflight-111-1790766510125-smoke-0',
      'pui-release-preflight-222-1790766530190-2',
      `pui-release-preflight-${process.pid}-1790766550268-3`,
      'other-pui-release-preflight-333-1-1',
      'pui-release-preflight-notapid-1-1',
    ].join('\n');
    const removed = sweepOrphanedProbeContainers((args) => {
      calls.push(args);
      return args[0] === 'ps' ? { status: 0, stdout: `${listed}\n` } : { status: 0 };
    }, (pid) => pid === 222);
    expect(removed).toEqual(['pui-release-preflight-111-1790766510125-1', 'pui-release-preflight-111-1790766510125-smoke-0']);
    expect(calls[0]).toEqual(expect.arrayContaining(['ps', '--all', '--filter', 'name=pui-release-preflight-']));
    expect(calls[1]).toEqual(['rm', '--force', ...removed]);
    expect(calls).toHaveLength(2);
  });

  it('sweeps orphans before the first launch and removes nothing when docker cannot list', () => {
    const calls: string[][] = [];
    expect(probeDockerCreateStart((args) => {
      calls.push(args);
      if (args[0] === 'ps') return { status: 0, stdout: 'pui-release-preflight-444-1-1\n' };
      return { status: 0 };
    }, () => false)).toBeNull();
    expect(calls.map((args) => args[0])).toEqual(['image', 'ps', 'rm', 'run']);
    expect(sweepOrphanedProbeContainers(() => ({ status: 1 }), () => false)).toEqual([]);
  });

  it('refuses only when every attempt fails, naming each failure and removing each attempt', () => {
    const calls: string[][] = [];
    const problem = probeDockerCreateStart((args) => {
      calls.push(args);
      return args[0] === 'run' ? { status: null, error: { message: 'spawnSync docker ETIMEDOUT' } } : { status: 0 };
    });
    const launches = calls.filter((args) => args[0] === 'run');
    const removals = calls.filter((args) => args[0] === 'rm');
    expect(launches).toHaveLength(3);
    expect(removals.map((args) => args[2])).toEqual(launches.map((args) => args[args.indexOf('--name') + 1]));
    expect(new Set(removals.map((args) => args[2])).size).toBe(3);
    expect(problem).toContain('failed on all 3 attempts');
    expect(problem).toContain('attempt 1/3');
    expect(problem).toContain('attempt 3/3');
    expect(problem).toContain('ETIMEDOUT');
  });

  it('defers image pulling to the stock smoke on a fresh host', () => {
    let calls = 0;
    expect(probeDockerCreateStart(() => {
      calls++;
      return { status: 1 };
    })).toBeNull();
    expect(calls).toBe(1);
  });

  it('skips every stock smoke when the create/start preflight fails', () => {
    const result = runStockMachineSmoke('/missing-candidate', ['ubuntu:24.04', 'debian:stable-slim'],
      () => 'Docker create/start preflight timed out');
    expect(result).toHaveLength(2);
    expect(result.every(({ status, output, unmeasured }) => status === null && unmeasured === true
      && output.includes('preflight timed out'))).toBe(true);
  });

  it.each([null, 143, 0])('keeps a timed-out Docker smoke inconclusive even with status %s', (status) => {
    const calls: Array<{ args: string[]; timeout: number }> = [];
    const root = mkdtempSync(path.join(tmpdir(), 'pui-stock-timeout-'));
    try {
      const machines = runStockMachineSmoke(root, ['ubuntu:24.04'], () => null, (args, timeout) => {
        calls.push({ args, timeout });
        return args[0] === 'run'
          ? { status, stdout: 'partial smoke output', stderr: 'Docker interrupted', error: { message: 'spawnSync docker ETIMEDOUT' } }
          : { status: 0 };
      });
      expect(machines[0]).toMatchObject({ status, unmeasured: true });
      expect(machines[0].output).toContain('partial smoke output\nDocker interrupted\nspawnSync docker ETIMEDOUT');
      expect(stockMachinesBlockLegs(machines)).toBe(false);
      expect(stockMachineRefusal(machines[0])).toContain('was not measured');
      const name = calls[0].args[calls[0].args.indexOf('--name') + 1];
      expect(name).toMatch(/^pui-release-preflight-\d+-\d+-smoke-0$/);
      expect(calls[0].timeout).toBe(300_000);
      expect(calls[1]).toEqual({ args: ['rm', '--force', name], timeout: DOCKER_START_PROBE_TIMEOUT_MS });
      const passed = [{ image: 'ubuntu:24.04', status: 0, output: 'ok' }];
      const remeasure = vi.fn(() => passed);
      expect(remeasureStockMachines(machines, remeasure)).toBe(passed);
      expect(remeasure).toHaveBeenCalledOnce();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([0, 1])('preserves completed smoke status %s and only blocks on actual failure', (status) => {
    const root = mkdtempSync(path.join(tmpdir(), 'pui-stock-completed-'));
    try {
      const run = vi.fn(() => ({ status, stdout: 'finished' }));
      const machines = runStockMachineSmoke(root, ['ubuntu:24.04'], () => null, run);
      expect(machines[0].unmeasured).toBeUndefined();
      expect(stockMachinesBlockLegs(machines)).toBe(status !== 0);
      expect(run).toHaveBeenCalledOnce();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a Docker invocation without a terminal status unmeasured', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pui-stock-interrupted-'));
    try {
      const machines = runStockMachineSmoke(root, ['ubuntu:24.04'], () => null, () => ({ status: null }));
      expect(machines[0]).toMatchObject({ status: null, unmeasured: true });
      expect(stockMachinesBlockLegs(machines)).toBe(false);
      expect(stockMachineRefusal(machines[0])).toContain('was not measured');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // WI-10004247 run 7: a Docker stall on the host (WI-10003403) refused the
  // preflight, and every PTY leg was skipped as if the binary had failed.
  it('lets the legs run past an unmeasured smoke but not past a failed one', () => {
    const unmeasured = runStockMachineSmoke('/missing-candidate', ['ubuntu:24.04'], () => 'stalled');
    expect(stockMachinesBlockLegs(unmeasured)).toBe(false);
    expect(stockMachinesBlockLegs([{ image: 'ubuntu:24.04', status: 1, output: 'install.sh: not found' }])).toBe(true);
    expect(stockMachinesBlockLegs([{ image: 'ubuntu:24.04', status: null, output: 'timed out' }])).toBe(true);
    expect(stockMachinesBlockLegs([{ image: 'ubuntu:24.04', status: 0, output: 'pui 0.1.0' }])).toBe(false);
  });

  it('measures an unmeasured smoke again after the legs, and only then', () => {
    const passed = [{ image: 'ubuntu:24.04', status: 0, output: 'ok' }];
    let calls = 0;
    const smoke = () => { calls++; return passed; };
    expect(remeasureStockMachines(passed, smoke)).toBe(passed);
    expect(calls).toBe(0);
    const unmeasured = [{ image: 'ubuntu:24.04', unmeasured: true, status: null, output: 'stalled' }];
    expect(remeasureStockMachines(unmeasured, smoke)).toBe(passed);
    expect(calls).toBe(1);
  });

  it('refuses an unmeasured smoke as unmeasured, a failed one as failed, a passed one not at all', () => {
    expect(stockMachineRefusal({ image: 'debian:stable-slim', unmeasured: true, status: null, output: 'stalled' }))
      .toBe('stock-machine smoke on debian:stable-slim was not measured: the host could not complete the smoke '
        + 'before or after the legs: stalled');
    expect(stockMachineRefusal({ image: 'debian:stable-slim', status: 2, output: 'boom' }))
      .toBe('stock-machine smoke on debian:stable-slim failed (status 2): boom');
    expect(stockMachineRefusal({ image: 'debian:stable-slim', status: 0, output: 'ok' })).toBeNull();
  });
});

describe('release acceptance test-process verdict', () => {
  it('refuses a failed or interrupted leg even when every required evidence row passes', () => {
    const required = loadRequiredMatrix();
    const matrix = loadAcceptanceMatrix();
    const candidate: Candidate = {
      sourceSha: 'f'.repeat(40), artifact: 'linux-x86_64', archive: '/fixture/pui.tar.gz',
      archiveSha256: 'c'.repeat(64), installRoot: '/fixture/install', installedBinarySha256: 'a'.repeat(64),
      advertise: [{ platform: 'Linux x86_64', backend: 'Claude' }],
    };
    const row = (tag: string, engine: string): EvidenceRow => ({
      tag, engine, test: tag, module: 'fixture', state: 'passed', harness: { operator: 'production' },
      platform: 'Linux x86_64', model: engine === 'claude' ? 'sonnet' : null,
      binary: '/fixture/install/bin/pui', binaryRealpath: '/fixture/install/bin/pui',
      binarySha256: candidate.installedBinarySha256, correlation: null,
    });
    const rows = [
      ...Object.values(matrix.capabilities).flat().map((tag) => row(tag, 'scripted')),
      ...matrix.backends.Claude.journeys.map((tag) => row(tag, matrix.backends.Claude.engine)),
    ];
    const check = (legs: Array<{ engine: string; status: number | null }>) =>
      checkReleaseAcceptance(required, matrix, candidate, rows, legs);
    expect(check([{ engine: 'scripted', status: 0 }, { engine: 'claude', status: 0 }]).ok).toBe(true);
    for (const engine of ['scripted', 'claude']) {
      for (const status of [1, null]) {
        const verdict = check(['scripted', 'claude'].map((name) => ({ engine: name, status: name === engine ? status : 0 })));
        expect(verdict.evidence.every((entry) => entry.qualifies)).toBe(true);
        expect(verdict.ok).toBe(false);
        expect(verdict.refusals).toContain(`installed-product ${engine} test leg did not exit successfully (status ${status})`);
      }
    }
    expect(check([])).toMatchObject({ ok: false, refusals: ['no installed-product acceptance legs ran'] });
  });
});

describe('public cloud device-start release guard', () => {
  it('requires a usable grant through HTTP and never records its credentials', async () => {
    let status = 200;
    let body: unknown;
    const requests: Array<{ method?: string; url?: string; body: string }> = [];
    const server = createServer(async (req, res) => {
      let input = '';
      for await (const chunk of req) input += chunk.toString();
      requests.push({ method: req.method, url: req.url, body: input });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const grant = {
      ok: true, deviceCode: 'pdc_PRIVATE_CODE', userCode: 'PRIVATE-USER-CODE',
      verificationUri: `${origin}/api/hosted/cli/device`,
      verificationUriComplete: `${origin}/api/hosted/cli/device?user_code=PRIVATE-USER-CODE`,
      expiresIn: 600, interval: 5,
    };
    try {
      body = grant;
      const passed = await runCloudDeviceStartSmoke(origin);
      expect(passed).toMatchObject({ ok: true, status: 200, problem: null });
      expect(JSON.stringify(passed)).not.toContain('PRIVATE');
      expect(requests).toEqual([{ method: 'POST', url: '/api/hosted/cli/device/code', body: '{}' }]);

      // The ingress regression required portal auth before granting a code.
      // Neither that 401 nor a missing route may hide behind a JSON ok flag.
      for (status of [401, 404]) {
        expect(await runCloudDeviceStartSmoke(origin)).toMatchObject({ ok: false, status });
      }
      status = 200;
      body = '<html>sign in</html>';
      expect(await runCloudDeviceStartSmoke(origin)).toMatchObject({ ok: false, status: 200 });
      for (const malformed of [
        { ...grant, deviceCode: '' }, { ...grant, userCode: '' },
        { ...grant, expiresIn: 0 }, { ...grant, interval: 0 },
        { ...grant, verificationUriComplete: 'https://other.invalid/device' },
      ]) {
        body = malformed;
        const failed = await runCloudDeviceStartSmoke(origin);
        expect(failed).toMatchObject({ ok: false, status: 200 });
        expect(JSON.stringify(failed)).not.toContain('PRIVATE');
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(await runCloudDeviceStartSmoke(origin)).toMatchObject({ ok: false, status: null });
  });

  const smokeResult = (status: number | null, ok = false): CloudDeviceStartResult => ({
    endpoint: 'https://cloud.invalid/api/hosted/cli/device/code', checkedAt: '2026-10-01T01:12:00.000Z',
    status, ok, problem: ok ? null : `HTTP ${status}`,
  });

  it('tells an ingress that did not answer from one that measurably refused', () => {
    for (const status of [null, 500, 502, 503]) {
      expect(cloudDeviceStartTransient(smokeResult(status))).toBe(true);
      expect(cloudDeviceStartBlocksLegs(smokeResult(status))).toBe(false);
    }
    for (const status of [200, 401, 404]) {
      expect(cloudDeviceStartTransient(smokeResult(status))).toBe(false);
      expect(cloudDeviceStartBlocksLegs(smokeResult(status))).toBe(true);
    }
    expect(cloudDeviceStartTransient(smokeResult(200, true))).toBe(false);
    expect(cloudDeviceStartBlocksLegs(smokeResult(200, true))).toBe(false);
  });

  // WI-10004247 run 13: one HTTP 502 at 01:12Z, beside a Docker stall, skipped
  // every leg; the same endpoint answered 200 at 01:24Z.
  it('runs the legs past a 502 and an unmeasured stock smoke, but not past a measured refusal', () => {
    const unmeasured = [{ image: 'ubuntu:24.04', unmeasured: true, status: null, output: 'stalled' }];
    expect(legsBlocked(unmeasured, smokeResult(502))).toBe(false);
    expect(legsBlocked(unmeasured, smokeResult(null))).toBe(false);
    expect(legsBlocked(unmeasured, smokeResult(401))).toBe(true);
    expect(legsBlocked([{ image: 'ubuntu:24.04', status: 1, output: 'boom' }], smokeResult(200, true))).toBe(true);
    expect(legsBlocked([{ image: 'ubuntu:24.04', status: 0, output: 'ok' }], smokeResult(200, true))).toBe(false);
  });

  it('asks again after a transient failure and stops at the first answer that is not transient', async () => {
    const answers = [smokeResult(502), smokeResult(null), smokeResult(200, true), smokeResult(200, true)];
    let calls = 0;
    const history = await measureCloudDeviceStart(async () => answers[calls++], 5, 0);
    expect(history.map(({ status, ok }) => [status, ok])).toEqual([[502, false], [null, false], [200, true]]);
    expect(calls).toBe(3);

    calls = 0;
    const refused = await measureCloudDeviceStart(async () => { calls++; return smokeResult(401); }, 5, 0);
    expect(refused).toHaveLength(1);
    expect(calls).toBe(1);

    calls = 0;
    const down = await measureCloudDeviceStart(async () => { calls++; return smokeResult(502); }, CLOUD_DEVICE_START_ATTEMPTS, 0);
    expect(down).toHaveLength(CLOUD_DEVICE_START_ATTEMPTS);
    expect(calls).toBe(CLOUD_DEVICE_START_ATTEMPTS);
  });

  it('measures a transient failure again after the legs and keeps every attempt in the record', async () => {
    let calls = 0;
    const measure = async () => { calls++; return [smokeResult(200, true)]; };
    const passed = [smokeResult(200, true)];
    expect(await remeasureCloudDeviceStart(passed, measure)).toBe(passed);
    const refused = [smokeResult(401)];
    expect(await remeasureCloudDeviceStart(refused, measure)).toBe(refused);
    expect(calls).toBe(0);
    const recovered = await remeasureCloudDeviceStart([smokeResult(502), smokeResult(502)], measure);
    expect(recovered.map(({ status }) => status)).toEqual([502, 502, 200]);
    expect(recovered[recovered.length - 1].ok).toBe(true);
    expect(calls).toBe(1);
  });
});

describe('release acceptance evidence parsing', () => {
  it('reads every record when Vitest batches two console writes into one chunk', () => {
    // The exact shape the installed-candidate run printed on 2026-09-23: PUI-TASK
    // logged its task row and its promote row back to back, and Vitest delivered
    // them as ONE log. The single-record parser dropped both.
    const chunk = [
      'PUI_TASK_ACCEPTANCE {"binary":"/r/bin/pui","binarySha256":"abc","chatId":"chat-1"}',
      'PUI_TASK_PROMOTE_ACCEPTANCE {"binary":"/r/bin/pui","binarySha256":"abc","chatId":"chat-1","taskId":"t-2"}',
      '',
    ].join('\n');

    const { lines, unparsed } = parseAcceptanceLines(chunk);

    expect(lines.map((line) => line.tag)).toEqual(['PUI_TASK_ACCEPTANCE', 'PUI_TASK_PROMOTE_ACCEPTANCE']);
    expect(lines[1].payload).toMatchObject({ chatId: 'chat-1', taskId: 't-2' });
    expect(unparsed).toEqual([]);
  });

  it('still reads a single record, including a pretty-printed payload', () => {
    expect(parseAcceptanceLines('AUTO_BAR_R_12_P_012_ACCEPTANCE {"binarySha256":"abc"}').lines)
      .toEqual([{ tag: 'AUTO_BAR_R_12_P_012_ACCEPTANCE', payload: { binarySha256: 'abc' } }]);
    const pretty = `PUI_USAGE_ACCEPTANCE ${JSON.stringify({ chatId: 'c', traffic: [{ path: '/api/x' }] }, null, 2)}`;
    expect(parseAcceptanceLines(pretty).lines[0].payload).toEqual({ chatId: 'c', traffic: [{ path: '/api/x' }] });
  });

  it('reports a printed tag whose JSON does not parse instead of dropping it', () => {
    const chunk = 'PUI_ABOUT_SUPPORT_ACCEPTANCE {"binary":\nPUI_TASK_ACCEPTANCE {"chatId":"c"}';
    const { lines, unparsed } = parseAcceptanceLines(chunk);
    expect(lines.map((line) => line.tag)).toEqual(['PUI_TASK_ACCEPTANCE']);
    expect(unparsed).toEqual(['PUI_ABOUT_SUPPORT_ACCEPTANCE']);
  });

  it('ignores prose and non-acceptance tags, and finds a harness stamp batched with a record', () => {
    const chunk = [
      '[session-archive] adv 13 looks LIVE — nothing touched',
      `${HARNESS_TAG} {"operator":"production","binary":"/r/bin/pui","binarySha256":"abc"}`,
      'PUI_SETTINGS_FAILURE {"stage":"pick"}',
      'PUI_SETTINGS_PICKERS_ACCEPTANCE {"chatId":"c"}',
    ].join('\n');

    expect(parseAcceptanceLines(chunk).lines.map((line) => line.tag)).toEqual(['PUI_SETTINGS_PICKERS_ACCEPTANCE']);
    expect(parseHarnessLine(chunk)).toMatchObject({ operator: 'production', binarySha256: 'abc' });
    expect(parseHarnessLine(`${HARNESS_TAG} {"operator":"mock"}`)).toBeNull();
  });

  it('never lets an unparsed row qualify, even with an otherwise passing test', () => {
    const candidate = { installedBinarySha256: 'abc', installRoot: '/r' } as Candidate;
    const row: EvidenceRow = {
      tag: 'PUI_TASK_ACCEPTANCE', test: 't', module: 'm', state: 'passed',
      harness: { operator: 'production' } as EvidenceRow['harness'], platform: 'Linux x86_64', engine: 'scripted',
      model: null, binary: '/r/bin/pui', binaryRealpath: '/r/bin/pui', binarySha256: 'abc', correlation: null,
    };
    expect(disqualification(row, candidate)).toBeNull();
    expect(disqualification({ ...row, unparsed: true }, candidate)).toBe('its acceptance line did not parse');
  });
});

describe('release acceptance account preflight', () => {
  it('requires completed inference and attributes the auto route without pinning an account', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      'data: {"type":"response.output_text.delta","delta":"OK"}\n\n'
      + 'data: {"type":"response.completed"}\n\n',
      { headers: { 'content-type': 'text/event-stream', 'x-papercusp-routed-account': 'codex-account' } },
    ));
    await expect(probeRoutedCodexModel('catalog-model', 'probe-owner', fetchImpl))
      .resolves.toMatchObject({ model: 'catalog-model', verdict: 'completed', terminal: 'response.completed', account: 'codex-account' });
    const init = fetchImpl.mock.calls[0][1]!;
    const headers = new Headers(init.headers);
    expect(headers.get('x-papercusp-owner')).toBe('probe-owner');
    expect(headers.has('x-papercusp-account')).toBe(false);
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'catalog-model', stream: true, store: false });
  });

  it('does not count an opened or incomplete stream as completed inference', async () => {
    for (const body of ['data: {"type":"response.created"}\n\n', 'data: {"type":"response.incomplete"}\n\n']) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(probeRoutedCodexModel('catalog-model', 'probe-owner', fetchImpl))
        .resolves.toMatchObject({ verdict: 'unmeasured' });
    }
  });

  it.each([400, 401, 429, 503])('distinguishes model refusal from an inconclusive HTTP %s', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ detail: "The 'old-model' model is not supported when using Codex with a ChatGPT account." }), { status },
    ));
    await expect(probeRoutedCodexModel('old-model', 'probe-owner', fetchImpl))
      .resolves.toMatchObject({ status, verdict: status === 400 ? 'refused' : 'unmeasured' });
  });

  it('stops a refused model before the archive and expensive suites are opened', async () => {
    const work = mkdtempSync(path.join(tmpdir(), 'pui-model-preflight-'));
    const catalog = path.join(work, 'accounts.json');
    writeFileSync(catalog, '{"accounts":[{"id":"codex-account","provider":"codex"}]}');
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      '{"detail":"unsupported model"}', { status: 400 },
    ));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.stubEnv('PAPERCUSP_SID', 'probe-owner');
    try {
      await expect(runReleaseAcceptance({ archive: path.join(work, 'missing.tar.gz'), advertise: [],
        real: [{ backend: 'codex', model: 'old-model', env: {
          PUI_REAL_ACCOUNT: 'auto', PUI_NATIVE_ACCOUNT_CATALOG: catalog,
        } }] })).rejects.toThrow('Native Codex model preflight refused old-model');
      expect(request).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith('PUI_ROUTED_CODEX_MODEL_PREFLIGHT', expect.stringContaining('"verdict":"refused"'));
    } finally {
      request.mockRestore(); info.mockRestore(); vi.unstubAllEnvs(); rmSync(work, { recursive: true, force: true });
    }
  });

  it('refuses historical baseline capture before opening a current candidate or running suites', async () => {
    const options = { archive: '/missing-pui-current-candidate.tar.gz', advertise: [] };
    vi.stubEnv('PUI_CAPTURE_BASELINE', '1');
    try {
      await expect(runReleaseAcceptance(options)).rejects.toThrow(/pre-fix counterexample.*installed release acceptance/);
      vi.stubEnv('PUI_CAPTURE_BASELINE', '');
      await expect(runReleaseAcceptance({ ...options, real: [{ backend: 'codex', env: { PUI_CAPTURE_BASELINE: '1' } }] }))
        .rejects.toThrow(/pre-fix counterexample.*installed release acceptance/);
      // Positive control: an ordinary release reaches archive admission.
      await expect(runReleaseAcceptance(options)).rejects.toThrow(/ENOENT/);
    } finally { vi.unstubAllEnvs(); }
  });

  it('refuses a missing or invalid routed catalog before opening the archive or running suites', async () => {
    const work = mkdtempSync(path.join(tmpdir(), 'pui-acceptance-preflight-'));
    const archive = path.join(work, 'missing.tar.gz');
    try {
      await expect(runReleaseAcceptance({ archive, advertise: [], real: [{ backend: 'claude', env: {
        PUI_REAL_ACCOUNT: 'auto', PUI_NATIVE_ACCOUNT_CATALOG: '',
      } }] })).rejects.toThrow(/PUI_NATIVE_ACCOUNT_CATALOG.*before installed suites run/);
      await expect(runReleaseAcceptance({ archive, advertise: [], real: [{ backend: 'claude', env: {
        PUI_REAL_ACCOUNT: 'auto', PUI_NATIVE_ACCOUNT_CATALOG: 'relative-accounts.json',
      } }] })).rejects.toThrow(/must be an absolute path/);

      const catalog = path.join(work, 'accounts.json');
      writeFileSync(catalog, '{"accounts":[{"id":"bad id","provider":"claude"}]}');
      await expect(runReleaseAcceptance({ archive, advertise: [], real: [{ backend: 'claude', env: {
        PUI_REAL_ACCOUNT: 'auto', PUI_NATIVE_ACCOUNT_CATALOG: catalog,
      } }] })).rejects.toThrow(/valid id\/provider metadata/);

      writeFileSync(catalog, '{"accounts":[{"id":"claude-main","provider":"claude"}]}');
      await expect(runReleaseAcceptance({ archive, advertise: [], real: [{ backend: 'claude', env: {
        PUI_REAL_ACCOUNT: 'auto', PUI_NATIVE_ACCOUNT_CATALOG: catalog,
      } }] })).rejects.toThrow(/ENOENT/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

// EI-24692155752067316: rehearsal 37bc2d4c32 ran its legs from the shared working
// tree and two peers' half-written edits (scripts/, operator-core) broke both real
// legs. The verdict must refuse evidence from any checkout that is not the
// candidate's commit, clean.
describe('release acceptance runner checkout', () => {
  const sha = 'f'.repeat(40);
  const gitIn = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir,
    '-c', 'user.email=acceptance@test', '-c', 'user.name=acceptance', ...args], { encoding: 'utf8' }).trim();

  it('accepts only a clean checkout at the candidate commit; untracked files do not count', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'pui-acceptance-runner-'));
    try {
      gitIn(repo, 'init', '-q');
      writeFileSync(path.join(repo, 'gateway.ts'), 'export const ok = 1;\n');
      gitIn(repo, 'add', '.');
      gitIn(repo, 'commit', '-qm', 'candidate');
      const candidate = gitIn(repo, 'rev-parse', 'HEAD');

      const clean = measureRunnerTree(repo);
      expect(clean).toEqual({ root: repo, head: candidate, changed: [], problem: null });
      expect(runnerTreeRefusals(clean, candidate, 'before the legs')).toEqual([]);

      const elsewhere = runnerTreeRefusals(clean, sha, 'before the legs');
      expect(elsewhere).toHaveLength(1);
      expect(elsewhere[0]).toContain(`was at ${candidate} before the legs, not the candidate source ${sha}`);

      writeFileSync(path.join(repo, 'next-migration.js'), 'await 1;\n');
      expect(runnerTreeRefusals(measureRunnerTree(repo), candidate, 'after the legs')).toEqual([]);

      writeFileSync(path.join(repo, 'gateway.ts'), 'export const ok = ;\n');
      const edited = measureRunnerTree(repo);
      expect(edited.changed).toEqual([' M gateway.ts']);
      const refusals = runnerTreeRefusals(edited, candidate, 'after the legs');
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toMatch(/had 1 uncommitted tracked change\(s\) after the legs \(M gateway\.ts\)/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('treats a checkout git cannot read as unmeasured, never as clean', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pui-acceptance-runner-'));
    try {
      const tree = measureRunnerTree(path.join(dir, 'missing'));
      expect(tree.head).toBeNull();
      expect(tree.problem).toMatch(/git exited/);
      const refusals = runnerTreeRefusals(tree, sha, 'before the legs');
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toContain('could not be measured before the legs');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
