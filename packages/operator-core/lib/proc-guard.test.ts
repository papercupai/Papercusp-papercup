/**
 * EI-18666147162251862: agents (and admin-commands.ts's `start-mac-vm`) guard
 * destructive/skip decisions with `pgrep -f <pattern>` / `pkill -f <pattern>`.
 * Since every such command runs as `bash -c '<the whole command string>'`, the
 * invoking shell's OWN cmdline contains the pattern text literally (it's the
 * pgrep argument itself) — and `pgrep -f` matches against every process
 * system-wide, not just descendants, so it self-matches its own ancestor.
 * Reproduced live (see scripts/proc-guard.mjs's header comment):
 *
 *   bash -c 'pgrep -f "definitely-not-a-real-process-zzqq" >/dev/null && echo MATCHED'
 *   # => MATCHED, though nothing by that name exists anywhere.
 *
 * scripts/proc-guard.mjs fixes this by excluding the caller's own pid + its
 * whole ancestor chain before matching. These tests build a fake /proc fixture
 * reproducing exactly that shape (a bash -c wrapper ancestor whose own cmdline
 * embeds the pattern) and assert the guard is immune to it while still catching
 * a genuinely unrelated external process.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getAncestryChain,
  isCapabilityBashSystemdRunWrapper,
  getOperationalArgv,
  matchesAdjacentArgvSequence,
  isStructuredPayloadArg,
  listProcesses,
  hostProcessVisibility,
  matchExternalProcesses,
  matchExternalProcessesDetailed,
  parseArgv,
  parseCmdline,
  parsePpid,
  parseCgroupPath,
  assertManagedTestCgroup,
  parseUsageUsec,
  computeCoresBusy,
  sampleCgroupBusy,
  sampleBusyMatches,
  formatBusy,
  formatProcessCmdline,
  walkProcessTree,
  resolveOwningTree,
  sameTreePath,
  filterByOwningTree,
} from '../../../scripts/proc-guard.mjs';

let fixtureRoot: string | null = null;

function fixtureProc(root: string, pid: number, ppid: number, argv: string[], comm = 'bash') {
  const dir = join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cmdline'), argv.join('\0') + '\0');
  // Minimal realistic /proc/<pid>/stat: "pid (comm) state ppid ...". Real
  // stat lines have 50+ fields; parsePpid only needs the ones up to ppid.
  writeFileSync(join(dir, 'stat'), `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 0 0 0 0 0`);
  mkdirSync(join(dir, 'task', String(pid)), { recursive: true });
  writeFileSync(join(dir, 'task', String(pid), 'children'), '');
}

function fixtureChildren(root: string, pid: number, children: number[]) {
  writeFileSync(join(root, String(pid), 'task', String(pid), 'children'), children.join(' '));
}

function fixtureIdentity(
  root: string,
  pid: number,
  options: { environment?: string[]; cgroupPath?: string; cwd?: string },
) {
  const dir = join(root, String(pid));
  if (options.environment) writeFileSync(join(dir, 'environ'), options.environment.join('\0') + '\0');
  if (options.cgroupPath) writeFileSync(join(dir, 'cgroup'), `0::${options.cgroupPath}\n`);
  // Real /proc/<pid>/cwd is a symlink to the working directory; resolveOwningTree
  // readlink()s it, so the fixture must be a symlink too and not a regular file.
  // The target need not exist — readlink reports the link body either way.
  if (options.cwd) symlinkSync(options.cwd, join(dir, 'cwd'));
}

afterEach(() => {
  if (fixtureRoot) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = null;
  }
});

describe('hostProcessVisibility', () => {
  it('refuses a sandbox PID 1 instead of treating unseen host processes as absent', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-visibility-fixture-'));
    fixtureProc(fixtureRoot, 1, 0, [
      '/usr/local/lib/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp',
      '/usr/bin/bash', '-c', 'node scripts/proc-guard.mjs check hono-host',
    ]);
    fixtureProc(fixtureRoot, 2, 1, ['node', 'scripts/proc-guard.mjs', 'check', 'hono-host']);
    expect(hostProcessVisibility(fixtureRoot)).toEqual({
      visible: false,
      reason: 'sandbox-pid-namespace',
    });
  });

  it('accepts a small host-visible fixture and refuses an unreadable PID 1', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-visibility-fixture-'));
    expect(hostProcessVisibility(fixtureRoot)).toEqual({ visible: false, reason: 'pid-1-unreadable' });
    fixtureProc(fixtureRoot, 1, 0, ['/usr/lib/systemd/systemd']);
    expect(hostProcessVisibility(fixtureRoot)).toEqual({ visible: true, reason: null });
  });
});

describe('walkProcessTree — PID-bounded diagnostics', () => {
  it('walks only descendants of the requested root and preserves depth', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-tree-fixture-'));
    fixtureProc(fixtureRoot, 10, 1, ['root']);
    fixtureProc(fixtureRoot, 11, 10, ['child']);
    fixtureProc(fixtureRoot, 12, 11, ['grandchild']);
    fixtureProc(fixtureRoot, 99, 1, ['unrelated']);
    fixtureChildren(fixtureRoot, 10, [11]);
    fixtureChildren(fixtureRoot, 11, [12]);

    const result = walkProcessTree(10, { procRoot: fixtureRoot });
    expect(result).toMatchObject({ truncated: false, reason: null });
    expect(result.rows.map(({ pid, depth }) => ({ pid, depth }))).toEqual([
      { pid: 10, depth: 0 },
      { pid: 11, depth: 1 },
      { pid: 12, depth: 2 },
    ]);
  });

  it('stops at the explicit node bound instead of expanding an unbounded tree', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-tree-fixture-'));
    fixtureProc(fixtureRoot, 10, 1, ['root']);
    fixtureProc(fixtureRoot, 11, 10, ['child-a']);
    fixtureProc(fixtureRoot, 12, 10, ['child-b']);
    fixtureChildren(fixtureRoot, 10, [11, 12]);

    const result = walkProcessTree(10, { procRoot: fixtureRoot, maxNodes: 2 });
    expect(result.rows.map((row) => row.pid)).toEqual([10, 11]);
    expect(result).toMatchObject({ truncated: true, reason: 'max-nodes' });
  });
});

describe('parseCmdline', () => {
  it('joins NUL-separated argv into a space-joined display string', () => {
    expect(parseCmdline(Buffer.from('pgrep\0-f\0qemu.*mac_hdd_ng\0'))).toBe('pgrep -f qemu.*mac_hdd_ng');
  });

  it('drops the trailing empty segment from the terminating NUL', () => {
    expect(parseCmdline(Buffer.from('node\0script.mjs\0'))).toBe('node script.mjs');
  });
});

describe('isCapabilityBashSystemdRunWrapper', () => {
  const taskId = '0mu5adly174temv1c19';
  const wrapper = [
    '/usr/bin/systemd-run',
    '--user',
    '--pipe',
    '--wait',
    '--quiet',
    `--unit=pc-${taskId}.service`,
    '--slice=papercusp-bash-job.slice',
    '--property=KillMode=control-group',
    '--',
    'bash',
    '-o',
    'pipefail',
    '-c',
    'node scripts/proc-guard.mjs check auto-apply-runner',
  ];

  it('recognizes only the exact current capability:bash service client shape', () => {
    expect(isCapabilityBashSystemdRunWrapper(wrapper, taskId)).toBe(true);
  });

  it('does not exclude a wrapper for a different task id', () => {
    expect(isCapabilityBashSystemdRunWrapper(wrapper, '0mu-other-task')).toBe(false);
  });

  it('does not exclude a real same-session target using the scope or another slice', () => {
    expect(
      isCapabilityBashSystemdRunWrapper(
        wrapper.map((arg) => (arg === '--pipe' ? '--scope' : arg)),
        taskId,
      ),
    ).toBe(false);
    expect(
      isCapabilityBashSystemdRunWrapper(
        wrapper.map((arg) => (arg === '--slice=papercusp-bash-job.slice' ? '--slice=papercusp-agent.slice' : arg)),
        taskId,
      ),
    ).toBe(false);
  });
});

describe('parseArgv and getOperationalArgv', () => {
  it('keeps raw argv boundaries while parseCmdline remains display-compatible', () => {
    const raw = Buffer.from('node\0script.mjs\0argument with spaces\0');
    expect(parseArgv(raw)).toEqual(['node', 'script.mjs', 'argument with spaces']);
    expect(parseCmdline(raw)).toBe('node script.mjs argument with spaces');
  });

  it('removes kickoff prompt payloads but retains the executable and real args', () => {
    const argv = [
      '/usr/bin/gnome-terminal',
      '--wait',
      'PAPERCUSP_KICKOFF_PROMPT=green-checkpoint',
      '--target',
      'mac_hdd_ng.img',
    ];
    expect(getOperationalArgv(argv)).toEqual(['/usr/bin/gnome-terminal', '--wait', '--target', 'mac_hdd_ng.img']);
  });

  it('removes a peer agent JSON payload but retains the executable and real args', () => {
    const argv = [
      'node',
      '/repo/scripts/ptool.mjs',
      'work_items:checkpoint',
      '{"id":"WI-38341","checkpoint":"waiting on green-checkpoint"}',
      '--json',
    ];
    expect(getOperationalArgv(argv)).toEqual(['node', '/repo/scripts/ptool.mjs', 'work_items:checkpoint', '--json']);
  });

  it('removes psu kickoff and label values as prose payloads', () => {
    const argv = [
      'node',
      '/repo/.papercusp/bin/psu',
      '--kickoff=the green-checkpoint gate is only mentioned in this brief',
      '--label=green-checkpoint-follow-up',
      '--model=sonnet:high',
    ];
    expect(getOperationalArgv(argv)).toEqual(['node', '/repo/.papercusp/bin/psu', '--model=sonnet:high']);
  });

  it('removes inline shell command text from process-name matching', () => {
    const argv = [
      '/usr/bin/bash',
      '-lc',
      "ptool work_items:checkpoint --json - <<'JSON'\\n{\\\"checkpoint\\\":\\\"green-checkpoint\\\"}\\nJSON",
    ];
    expect(getOperationalArgv(argv)).toEqual(['/usr/bin/bash', '-lc']);
  });

  it('redacts inline interpreter source and structured payloads even in verbose output', () => {
    const shellPayload = "ptool work_items:checkpoint --json - <<'JSON'\\nsecret green-checkpoint\\nJSON";
    const shellArgv = ['bash', '-lc', shellPayload];
    const verbose = formatProcessCmdline(shellArgv, { verbose: true });
    expect(verbose).toBe('bash -lc [inline command redacted]');
    expect(verbose).not.toContain('secret');
    expect(formatProcessCmdline([
      'node',
      '/repo/scripts/ptool.mjs',
      'work_items:checkpoint',
      '{"checkpoint":"private payload"}',
    ], { verbose: true })).toBe('node /repo/scripts/ptool.mjs work_items:checkpoint [payload redacted]');
  });
});

describe('formatProcessCmdline', () => {
  it('caps the default display at 200 characters and marks truncation', () => {
    const cmdline = `node ${'x'.repeat(240)}`;
    const formatted = formatProcessCmdline(cmdline);
    expect(formatted).toHaveLength(200);
    expect(formatted).toBe(`${cmdline.slice(0, 199)}…`);
  });

  it('returns the complete command line in verbose mode', () => {
    const cmdline = `node ${'x'.repeat(240)}`;
    expect(formatProcessCmdline(cmdline, { verbose: true })).toBe(cmdline);
  });

  it('leaves short command lines unchanged', () => {
    expect(formatProcessCmdline('node scripts/proc-guard.mjs check green-checkpoint')).toBe(
      'node scripts/proc-guard.mjs check green-checkpoint',
    );
  });
});

describe('matchesAdjacentArgvSequence', () => {
  const sequence = ['gitnexus', 'analyze'];

  it('matches npx when gitnexus and analyze are adjacent tokens', () => {
    expect(matchesAdjacentArgvSequence(['npx', '--yes', 'gitnexus', 'analyze', '/repo'], sequence)).toBe(true);
  });

  it('matches a node-launched gitnexus.js path by basename', () => {
    expect(
      matchesAdjacentArgvSequence(
        ['node', '/repo/node_modules/gitnexus/bin/gitnexus.js', 'analyze', '/repo'],
        sequence,
      ),
    ).toBe(true);
  });

  it('matches a node-launched gitnexus package entrypoint by node_modules path', () => {
    expect(
      matchesAdjacentArgvSequence(
        ['node', '/repo/node_modules/gitnexus/dist/cli/index.js', 'analyze', '/repo', '--skip-agents-md'],
        sequence,
      ),
    ).toBe(true);
  });

  it('matches the direct gitnexus executable', () => {
    expect(matchesAdjacentArgvSequence(['/usr/local/bin/gitnexus', 'analyze', '/repo'], sequence)).toBe(true);
  });

  it('rejects a python hook whose JSON payload merely names the command', () => {
    expect(
      matchesAdjacentArgvSequence(
        ['python3', '-', JSON.stringify({ tool_input: { command: 'npx --yes gitnexus analyze /repo' } })],
        sequence,
      ),
    ).toBe(false);
  });

  it('rejects the right executable with the wrong verb', () => {
    expect(matchesAdjacentArgvSequence(['npx', '--yes', 'gitnexus', 'cypher', '/repo'], sequence)).toBe(false);
  });

  it('rejects command text embedded in a node -e script', () => {
    expect(matchesAdjacentArgvSequence(['node', '-e', 'gitnexus analyze /repo'], sequence)).toBe(false);
  });
});

// EI-20303820187580514. Ancestor-exclusion cannot reach these: a peer's hook
// process is an unrelated third party, not the caller's ancestor, and its
// payload carries no fixed marker to match on. The discriminator is structural.
describe('isStructuredPayloadArg', () => {
  it('treats a hook envelope as payload, at the sizes really observed (12KB)', () => {
    const envelope = JSON.stringify({
      session_id: '019ff901-330d-7dd2-a4c4-88523cbe11e4',
      transcript_path: '/home/x/.papercusp/session-claude/t.jsonl',
      tool_name: 'Bash',
      tool_input: { command: "ptool work_items:checkpoint --json - <<'JSON' ... green-checkpoint ..." },
      padding: 'x'.repeat(12_000),
    });
    expect(isStructuredPayloadArg(envelope)).toBe(true);
  });

  it('treats a settings blob and a JSON array as payload', () => {
    expect(isStructuredPayloadArg('{"apiKeyHelper":"","env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:9073"}}')).toBe(
      true,
    );
    expect(isStructuredPayloadArg('["green-checkpoint","release-cut"]')).toBe(true);
  });

  it('tolerates surrounding whitespace, as a shell-quoted payload can carry it', () => {
    expect(isStructuredPayloadArg('  {"tool_name":"Bash"}\n')).toBe(true);
  });

  // The controls. These must stay operational: a jq program and a brace-glob
  // both START like JSON, so a naive first-character check would swallow them
  // and silently turn real matches into non-matches.
  it('does NOT treat a jq program as payload (starts with { but is not valid JSON)', () => {
    expect(isStructuredPayloadArg('{a:1}')).toBe(false);
    expect(isStructuredPayloadArg('{"green-checkpoint"')).toBe(false);
  });

  it('does NOT treat ordinary arguments as payload', () => {
    expect(isStructuredPayloadArg('green-checkpoint')).toBe(false);
    expect(isStructuredPayloadArg('/var/log/green-checkpoint.log')).toBe(false);
    expect(isStructuredPayloadArg('')).toBe(false);
    expect(isStructuredPayloadArg('{}')).toBe(true);
  });

  // Calibration: a JSON SCALAR is not a payload envelope. Without this, a
  // subject that returned true for everything parseable would still pass the
  // positive cases above.
  it('does NOT treat a bare JSON scalar as payload', () => {
    expect(isStructuredPayloadArg('123')).toBe(false);
    expect(isStructuredPayloadArg('"green-checkpoint"')).toBe(false);
    expect(isStructuredPayloadArg('null')).toBe(false);
  });
});

describe('parsePpid', () => {
  it('parses ppid from a normal comm field', () => {
    expect(parsePpid('1234 (bash) S 1000 1234 1234 0 -1 0')).toBe(1000);
  });

  it('resumes field-splitting after the LAST close-paren so a comm containing ")" is safe', () => {
    // A process named "weird)proc" would otherwise be mis-split mid-name.
    expect(parsePpid('55 (weird)proc) S 42 55 55 0 -1 0')).toBe(42);
  });

  it('returns null when the line has no comm parens at all', () => {
    expect(parsePpid('garbage line with no parens')).toBeNull();
  });
});

describe('getAncestryChain', () => {
  it('walks parent -> grandparent -> ... -> pid 1', () => {
    const byPid = new Map([
      [1, null],
      [50, 1],
      [100, 50],
      [200, 100],
    ]);
    expect(getAncestryChain(200, byPid)).toEqual(new Set([200, 100, 50, 1]));
  });

  it('is cycle-safe (a corrupt ppid chain never infinite-loops)', () => {
    const byPid = new Map([
      [10, 20],
      [20, 10], // cycle
    ]);
    const chain = getAncestryChain(10, byPid);
    expect(chain).toEqual(new Set([10, 20]));
  });

  it('stops cleanly on an unknown ppid', () => {
    const byPid = new Map([[5, 999]]); // 999 not in the map
    expect(getAncestryChain(5, byPid)).toEqual(new Set([5, 999]));
  });
});

describe('matchExternalProcesses — the EI-18666147162251862 regression', () => {
  it("does NOT self-match when the pattern only appears in the caller's own ancestor cmdline", () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    const PATTERN = 'definitely-not-a-real-process-zzqq';
    // pid 1: init. pid 50: the `bash -c '<whole command>'` wrapper — its own
    // cmdline embeds the pattern text (it's literally running `pgrep -f
    // "<PATTERN>"`), which is exactly what makes a bare `pgrep -f` self-match.
    // pid 100: "us" (e.g. the proc-guard CLI itself, or the pgrep it would spawn).
    fixtureProc(fixtureRoot, 1, 0, ['/sbin/init']);
    fixtureProc(fixtureRoot, 50, 1, ['bash', '-c', `if pgrep -f "${PATTERN}" >/dev/null; then echo MATCHED; fi`]);
    fixtureProc(fixtureRoot, 100, 50, ['node', 'scripts/proc-guard.mjs', 'check', PATTERN]);

    const matches = matchExternalProcesses(PATTERN, { procRoot: fixtureRoot, selfPid: 100 });
    expect(matches).toEqual([]); // the naive `pgrep -f` equivalent would have returned pid 50 here
  });

  it('DOES match a genuinely unrelated external process with the pattern in its cmdline', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    const PATTERN = 'qemu.*mac_hdd_ng';
    fixtureProc(fixtureRoot, 1, 0, ['/sbin/init']);
    fixtureProc(fixtureRoot, 50, 1, ['bash', '-c', `if pgrep -f "${PATTERN}" >/dev/null; then echo MATCHED; fi`]);
    fixtureProc(fixtureRoot, 100, 50, ['node', 'scripts/proc-guard.mjs', 'check', PATTERN]);
    // The real target: an unrelated qemu process, NOT an ancestor of pid 100.
    fixtureProc(fixtureRoot, 777, 1, ['qemu-system-x86_64', '-drive', 'file=./mac_hdd_ng.img'], 'qemu-system-x8');

    const matches = matchExternalProcesses(PATTERN, { procRoot: fixtureRoot, selfPid: 100 });
    expect(matches.map((m) => m.pid)).toEqual([777]);
  });

  it('excludes only the current capability:bash wrapper, retaining a different task and a same-session target', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    const PATTERN = 'auto-apply-runner';
    const currentTaskId = '0mu5adly174temv1c19';
    const sessionId = 'su-same-session';
    const wrapper = (taskId: string) => [
      'systemd-run',
      '--user',
      '--pipe',
      '--wait',
      '--quiet',
      `--unit=pc-${taskId}.service`,
      '--slice=papercusp-bash-job.slice',
      '--property=KillMode=control-group',
      '--',
      'bash',
      '-o',
      'pipefail',
      '-c',
      `node scripts/proc-guard.mjs check ${PATTERN}`,
    ];
    fixtureProc(fixtureRoot, 1, 0, ['/sbin/init']);
    fixtureProc(fixtureRoot, 100, 1, ['node', 'scripts/proc-guard.mjs', 'check', PATTERN]);
    fixtureProc(fixtureRoot, 200, 1, wrapper(currentTaskId));
    fixtureIdentity(fixtureRoot, 200, { environment: [`PAPERCUSP_SID=${sessionId}`] });
    fixtureProc(fixtureRoot, 201, 1, wrapper('0mu-other-task'));
    fixtureIdentity(fixtureRoot, 201, { environment: [`PAPERCUSP_SID=${sessionId}`] });
    fixtureProc(fixtureRoot, 202, 1, ['node', '/repo/real-auto-apply-runner.mjs']);
    fixtureIdentity(fixtureRoot, 202, { environment: [`PAPERCUSP_SID=${sessionId}`] });

    const report = matchExternalProcessesDetailed(PATTERN, {
      procRoot: fixtureRoot,
      selfPid: 100,
      capabilityBashTaskId: currentTaskId,
    });
    expect(report.matches.map((m) => m.pid)).toEqual([201, 202]);
    expect(report.fullMatches.map((m) => m.pid)).toEqual([201, 202]);
  });

  it('excludes an unrelated process that is merely a SIBLING ancestor-less match correctly, and excludes self', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    const PATTERN = 'target-thing';
    fixtureProc(fixtureRoot, 1, 0, ['/sbin/init']);
    fixtureProc(fixtureRoot, 100, 1, ['node', 'scripts/proc-guard.mjs', 'check', PATTERN]); // self
    fixtureProc(fixtureRoot, 200, 1, ['some-other-proc', PATTERN]); // unrelated sibling, real match

    const matches = matchExternalProcesses(PATTERN, { procRoot: fixtureRoot, selfPid: 100 });
    expect(matches.map((m) => m.pid)).toEqual([200]);
  });

  it('returns [] against a missing /proc root rather than throwing', () => {
    const matches = matchExternalProcesses('anything', { procRoot: '/no/such/proc/root', selfPid: 1 });
    expect(matches).toEqual([]);
  });

  it('ignores kickoff prompt text while retaining the real-vs-argv-text split', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    const PATTERN = 'green-checkpoint';
    fixtureProc(fixtureRoot, 1, 0, ['/sbin/init']);
    fixtureProc(fixtureRoot, 100, 1, ['node', 'scripts/proc-guard.mjs', 'check', PATTERN]);
    fixtureProc(fixtureRoot, 777, 1, ['node', 'apps/operator/lib/release/green-checkpoint.ts']);
    fixtureProc(fixtureRoot, 778, 1, [
      'bun',
      '/home/dev/.papercusp/bin/omp',
      '--model',
      'model:low',
      '⟦turn-origin:fleet-kickoff nonce:abc⟧ The green-checkpoint gate is red.',
    ]);
    fixtureProc(fixtureRoot, 779, 1, [
      'bash',
      '-lc',
      "export PAPERCUSP_KICKOFF_PROMPT='The green-checkpoint gate is red.'; exec $SHELL",
    ]);
    fixtureProc(fixtureRoot, 780, 1, [
      'node',
      '/home/dev/.papercusp/bin/psu',
      '--kickoff=The green-checkpoint gate is red.',
    ]);
    fixtureProc(fixtureRoot, 781, 1, ['node', '/home/dev/.papercusp/bin/psu', '--label=green-checkpoint-follow-up']);

    const report = matchExternalProcessesDetailed(PATTERN, { procRoot: fixtureRoot, selfPid: 100 });
    expect(report.matches.map((m) => m.pid)).toEqual([777]);
    expect(report.fullMatches.map((m) => m.pid)).toEqual([777, 778, 779, 780, 781]);
    expect(report.argvTextOnly.map((m) => m.pid)).toEqual([778, 779, 780, 781]);
    expect(matchExternalProcesses(PATTERN, { procRoot: fixtureRoot, selfPid: 100 }).map((m) => m.pid)).toEqual([777]);
  });

  it('does not report a shell wrapper whose command text only contains a ptool payload match', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    fixtureProc(fixtureRoot, 1, 0, ['/sbin/init']);
    fixtureProc(fixtureRoot, 100, 1, ['node', 'scripts/proc-guard.mjs', 'check', 'green-checkpoint']);
    fixtureProc(fixtureRoot, 777, 1, [
      'bash',
      '-lc',
      "ptool work_items:checkpoint --json - <<'JSON'\\n{\\\"checkpoint\\\":\\\"green-checkpoint\\\"}\\nJSON",
    ]);

    const report = matchExternalProcessesDetailed('green-checkpoint', {
      procRoot: fixtureRoot,
      selfPid: 100,
    });
    expect(report.matches).toEqual([]);
    expect(report.argvTextOnly.map((row) => row.pid)).toEqual([777]);
    expect(formatProcessCmdline(report.fullMatches[0].argv, { verbose: true })).not.toContain('green-checkpoint');
  });

  // EI-20303820187580514, the live repro: `check green-checkpoint` reported 4
  // matches while exactly ONE green-checkpoint process existed. The other three
  // were peers' hook/tool processes whose JSON argv named the gate because those
  // agents were writing checkpoints ABOUT it. A false POSITIVE here reads as
  // concurrent gate runs, and the standing rule is to stand down for those.
  it('does NOT count a peer agent whose JSON payload merely NAMES the pattern', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    const PATTERN = 'green-checkpoint';
    fixtureProc(fixtureRoot, 1, 0, ['/sbin/init']);
    fixtureProc(fixtureRoot, 100, 1, ['node', 'scripts/proc-guard.mjs', 'check', PATTERN]);
    // The one real gate process — the ground truth the CLI must report.
    fixtureProc(fixtureRoot, 777, 1, ['node', 'apps/operator/lib/release/green-checkpoint.ts']);
    // A peer's PostToolUse hook: the gate name rides inside the tool_input.
    fixtureProc(fixtureRoot, 269555, 1, [
      'python3',
      '-',
      JSON.stringify({
        session_id: '21e71b6f-7059-41ed-bb16-54ee447c00ce',
        tool_name: 'Bash',
        tool_input: { command: 'ptool work_items:checkpoint ... green-checkpoint ...' },
      }),
    ]);
    // A peer's ptool call, checkpointing ABOUT the gate.
    fixtureProc(fixtureRoot, 269556, 1, [
      'node',
      '/repo/scripts/ptool.mjs',
      'work_items:checkpoint',
      '{"id":"WI-38341","checkpoint":"blocked on green-checkpoint"}',
    ]);
    // A peer claude launcher carrying a --settings blob.
    fixtureProc(fixtureRoot, 269557, 1, ['claude', '--settings', '{"env":{"PAPERCUSP_GATE":"green-checkpoint"}}']);

    const report = matchExternalProcessesDetailed(PATTERN, { procRoot: fixtureRoot, selfPid: 100 });
    // The verdict: one real process, not four.
    expect(report.matches.map((m) => m.pid)).toEqual([777]);
    // Nothing is silently dropped — the ignored rows stay auditable. Sorted
    // because row order follows /proc readdir order, which is lexicographic.
    expect(report.fullMatches.map((m) => m.pid).sort((a, b) => a - b)).toEqual([777, 269555, 269556, 269557]);
    expect(report.argvTextOnly.map((m) => m.pid).sort((a, b) => a - b)).toEqual([269555, 269556, 269557]);
  });

  // EI-21714274321083230: psu-launched agents carry their stable owner id in
  // PAPERCUSP_SID, but the launcher argv may not contain it at all. Matching
  // argv alone therefore reports a live agent as absent and can invite a
  // destructive force-release. Identity is read from the bounded environment
  // evidence instead; the environment contents are never returned.
  it('matches a live agent through PAPERCUSP_SID when its owner id is absent from argv', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    const PATTERN = 'su-live-agent-7f9d';
    fixtureProc(fixtureRoot, 1, 0, ['/sbin/init']);
    fixtureProc(fixtureRoot, 100, 1, ['node', 'scripts/proc-guard.mjs', 'check', PATTERN]);
    fixtureProc(fixtureRoot, 777, 1, ['node', '/home/dev/.papercusp/bin/psu', '--agent=codex']);
    fixtureIdentity(fixtureRoot, 777, { environment: [`PAPERCUSP_SID=${PATTERN}`] });

    const report = matchExternalProcessesDetailed(PATTERN, { procRoot: fixtureRoot, selfPid: 100 });
    expect(report.matches.map((m) => m.pid)).toEqual([777]);
    expect(report.identityMatches.map((m) => m.pid)).toEqual([777]);
    expect(report.fullMatches).toEqual([]);
    expect(report.argvTextOnly).toEqual([]);
  });

  it('uses argv adjacency mode to ignore gitnexus prose while retaining real commands', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    const PATTERN = 'gitnexus.*analyze';
    const sequence = ['gitnexus', 'analyze'];
    fixtureProc(fixtureRoot, 1, 0, ['/sbin/init']);
    fixtureProc(fixtureRoot, 100, 1, ['node', 'scripts/proc-guard.mjs', 'check', PATTERN]);
    fixtureProc(fixtureRoot, 777, 1, ['npx', '--yes', 'gitnexus', 'analyze', '/repo']);
    fixtureProc(fixtureRoot, 778, 1, ['node', '/repo/bin/gitnexus.js', 'analyze', '/repo']);
    fixtureProc(fixtureRoot, 779, 1, ['/usr/local/bin/gitnexus', 'analyze', '/repo']);
    fixtureProc(fixtureRoot, 780, 1, [
      'node',
      '/repo/node_modules/gitnexus/dist/cli/index.js',
      'analyze',
      '/repo',
      '--skip-agents-md',
    ]);
    fixtureProc(fixtureRoot, 888, 1, [
      'python3',
      '-',
      JSON.stringify({ tool_input: { command: 'npx --yes gitnexus analyze /repo' } }),
    ]);
    fixtureProc(fixtureRoot, 889, 1, ['node', '-e', 'gitnexus analyze /repo']);
    fixtureProc(fixtureRoot, 890, 1, ['npx', '--yes', 'gitnexus', 'cypher', '/repo']);

    const report = matchExternalProcessesDetailed(PATTERN, {
      procRoot: fixtureRoot,
      selfPid: 100,
      argvSequence: sequence,
    });
    expect(report.matches.map((m) => m.pid)).toEqual([777, 778, 779, 780]);
    expect(report.fullMatches.map((m) => m.pid).sort((a, b) => a - b)).toEqual([777, 778, 779, 780, 888, 889]);
    expect(report.argvTextOnly.map((m) => m.pid).sort((a, b) => a - b)).toEqual([888, 889]);
  });

  // Calibration for the test above: the payload rule must not be so broad that
  // it suppresses a real process. A gate process invoked WITH a JSON argument
  // still matches, because the pattern is in its script path, not the payload.
  it('still matches a real process that happens to also carry a JSON argument', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    const PATTERN = 'green-checkpoint';
    fixtureProc(fixtureRoot, 1, 0, ['/sbin/init']);
    fixtureProc(fixtureRoot, 100, 1, ['node', 'scripts/proc-guard.mjs', 'check', PATTERN]);
    fixtureProc(fixtureRoot, 777, 1, [
      'node',
      'apps/operator/lib/release/green-checkpoint.ts',
      '{"candidate":"bb026a02ba"}',
    ]);

    expect(matchExternalProcesses(PATTERN, { procRoot: fixtureRoot, selfPid: 100 }).map((m) => m.pid)).toEqual([777]);
  });

  it('matches argv-blind gate descendants through checkpoint cgroup identity', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    const PATTERN = 'green-checkpoint';
    fixtureProc(fixtureRoot, 1, 0, ['/sbin/init']);
    fixtureProc(fixtureRoot, 100, 1, ['node', 'scripts/proc-guard.mjs', 'check', PATTERN]);

    // A process with both gate markers but OUTSIDE the checkpoint cgroup is
    // not gate-owned: long-lived sidecars can inherit these markers.
    fixtureProc(fixtureRoot, 777, 1, ['node', '/repo/papercusp-checkpoint/scripts/affected-tests.mjs']);
    fixtureIdentity(fixtureRoot, 777, {
      environment: ['GREEN_CHECKPOINT=1', 'PC_HEAVY_RELEASE_GATE=1'],
      cgroupPath: '/user.slice/user-1000.slice/papercusp.slice/papercusp-sidecar.slice/pc-sidecar.scope',
    });

    // GREEN_CHECKPOINT alone is intentionally insufficient: agents can export
    // it to reproduce the gate's skip-set without being the release gate.
    fixtureProc(fixtureRoot, 778, 1, ['node', '/repo/papercusp-checkpoint/scripts/worker.mjs']);
    fixtureIdentity(fixtureRoot, 778, { environment: ['GREEN_CHECKPOINT=1'] });

    // The detached manual launcher supplies the authoritative identity at the
    // cgroup boundary even when a child does not expose the env files.
    fixtureProc(fixtureRoot, 779, 1, ['node', '/repo/papercusp-checkpoint/scripts/worker.mjs']);
    fixtureIdentity(fixtureRoot, 779, {
      cgroupPath: '/user.slice/user-1000.slice/papercup-green-checkpoint-manual-abc.service',
    });

    // A normal gate child may expose both markers as well as the checkpoint
    // cgroup; the cgroup leg remains the deciding identity evidence.
    fixtureProc(fixtureRoot, 780, 1, ['node', '/repo/papercusp-checkpoint/scripts/worker.mjs']);
    fixtureIdentity(fixtureRoot, 780, {
      environment: ['GREEN_CHECKPOINT=1', 'PC_HEAVY_RELEASE_GATE=1'],
      cgroupPath: '/user.slice/user-1000.slice/papercup-green-checkpoint.service',
    });

    const report = matchExternalProcessesDetailed(PATTERN, { procRoot: fixtureRoot, selfPid: 100 });
    expect(report.matches.map((m) => m.pid)).toEqual([779, 780]);
    expect(report.identityMatches.map((m) => m.pid)).toEqual([779, 780]);
    expect(report.fullMatches).toEqual([]);
    expect(report.argvTextOnly).toEqual([]);

    // Identity enrichment is scoped to the known workload; generic patterns
    // remain argv-only and therefore do not inherit gate marker semantics.
    expect(matchExternalProcesses('gate-only-sentinel', { procRoot: fixtureRoot, selfPid: 100 })).toEqual([]);
  });
});

describe('listProcesses', () => {
  it('skips a pid whose cmdline is empty (kernel threads / zombies)', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    mkdirSync(join(fixtureRoot, '2'), { recursive: true });
    writeFileSync(join(fixtureRoot, '2', 'cmdline'), ''); // kthread-like: empty cmdline
    writeFileSync(join(fixtureRoot, '2', 'stat'), '2 (kthreadd) S 0 0 0 0 -1 0');
    fixtureProc(fixtureRoot, 3, 0, ['real-process']);

    const procs = listProcesses(fixtureRoot);
    expect(procs.map((p) => p.pid)).toEqual([3]);
  });
});

/**
 * EI-20425164406230624 — `--busy`: "is it WORKING", as opposed to `check`'s
 * "is it RUNNING". Two agents measured the SAME live gate run within one
 * minute and reached OPPOSITE conclusions, because a hand-rolled /proc tree
 * walk false-idles here two ways (a depth-bounded walk halts on a 0-tick shell
 * wrapper; `c*` ticks are credited only on wait(), which vitest never does for
 * its own workers). The cgroup cannot be escaped, so it is the instrument.
 */
describe('managed test cgroup containment', () => {
  const env = {
    PAPERCUSP_TEST_RUN_GROUP: 'owned-calibration-123',
    PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '2000',
    PAPERCUSP_EXPECTED_TEST_CGROUP: '/user.slice/owned.service',
  };
  const options = { env, now: 1000, pid: 123, readFile: () => '0::/user.slice/owned.service\n' };

  it('accepts actual membership with both managed lifetime markers', () => {
    expect(assertManagedTestCgroup(options)).toEqual({
      pid: 123, cgroupPath: env.PAPERCUSP_EXPECTED_TEST_CGROUP,
      runGroup: env.PAPERCUSP_TEST_RUN_GROUP, deadlineEpochMs: 2000,
    });
  });

  it.each([
    { PAPERCUSP_TEST_RUN_GROUP: undefined },
    { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: undefined },
    { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '1000' },
    { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: 'Infinity' },
    { PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '1e9' },
    { PAPERCUSP_EXPECTED_TEST_CGROUP: '/' },
    { PAPERCUSP_EXPECTED_TEST_CGROUP: '/user.slice/../sibling.scope' },
  ])('refuses invalid context %j before a worker can run', (override) => {
    expect(() => assertManagedTestCgroup({ ...options, env: { ...env, ...override } }))
      .toThrow('PAPERCUSP_TEST_CGROUP_CONTAINMENT');
  });

  it('rejects a sibling scope and unknown or unreadable membership', () => {
    for (const readFile of [
      () => '0::/user.slice/papercusp-test-escaped.scope\n',
      () => '12:pids:/user.slice/owned.service\n',
      () => { throw new Error('unreadable'); },
    ]) expect(() => assertManagedTestCgroup({ ...options, readFile })).toThrow('PAPERCUSP_TEST_CGROUP_CONTAINMENT');
  });

  it.skipIf(process.platform !== 'linux')('checks a real Node fork and refuses a mismatched parent', () => {
    const cgroupPath = parseCgroupPath(readFileSync('/proc/self/cgroup', 'utf8'));
    expect(cgroupPath).toBeTruthy();
    expect(cgroupPath).not.toBe('/');
    const module = fileURLToPath(new URL('../../../scripts/proc-guard.mjs', import.meta.url));
    const command = `import { assertManagedTestCgroup } from ${JSON.stringify(module)}; console.log(JSON.stringify(assertManagedTestCgroup()));`;
    const childEnv = {
      ...process.env, ...env,
      PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(Date.now() + 60_000),
      PAPERCUSP_EXPECTED_TEST_CGROUP: cgroupPath!,
    };
    const contained = spawnSync(process.execPath, ['--input-type=module', '-e', command], { env: childEnv, encoding: 'utf8' });
    expect(contained.status, contained.stderr).toBe(0);
    expect(JSON.parse(contained.stdout)).toMatchObject({ cgroupPath, runGroup: env.PAPERCUSP_TEST_RUN_GROUP });
    const escaped = spawnSync(process.execPath, ['--input-type=module', '-e', command], {
      env: { ...childEnv, PAPERCUSP_EXPECTED_TEST_CGROUP: cgroupPath + '-sibling' }, encoding: 'utf8',
    });
    expect(escaped.status).not.toBe(0);
    expect(escaped.stderr).toContain('escaped');
  });

  it.skipIf(process.platform !== 'linux')('keeps the preload lifetime independent of runner-policy fixtures and mutable environment', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'managed-cgroup-preload-'));
    const cgroupPath = parseCgroupPath(readFileSync('/proc/self/cgroup', 'utf8'));
    const evidencePath = join(fixtureRoot, 'observations.jsonl');
    const preload = fileURLToPath(new URL('../../../scripts/lib/managed-test-cgroup-preload.mjs', import.meta.url));
    const context = { runGroup: 'real-calibration', deadlineEpochMs: Date.now() + 60_000, cgroupPath, evidencePath };
    const childEnv = {
      ...process.env,
      PAPERCUSP_TEST_CGROUP_CONTEXT: JSON.stringify(context),
      PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '1',
      PAPERCUSP_TEST_RUN_GROUP: '',
      PAPERCUSP_EXPECTED_TEST_CGROUP: '/fixture-controlled',
    };
    const command = "process.env.PAPERCUSP_TEST_CGROUP_CONTEXT = '{}'; console.log('fixture reached');";
    const run = (pins: typeof context) => spawnSync(process.execPath, ['--import', preload, '-e', command], {
      env: { ...childEnv, PAPERCUSP_TEST_CGROUP_CONTEXT: JSON.stringify(pins) }, encoding: 'utf8',
    });
    const contained = run(context);
    expect(contained.status, contained.stderr).toBe(0);
    expect(contained.stdout).toContain('fixture reached');
    const observations = readFileSync(evidencePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(observations.map(row => row.phase)).toEqual(['preload', 'exit']);
    for (const row of observations) expect(row).toMatchObject({ cgroupPath, runGroup: context.runGroup, deadlineEpochMs: context.deadlineEpochMs });
    for (const pins of [{ ...context, deadlineEpochMs: 1 }, { ...context, cgroupPath: cgroupPath + '-sibling' }]) {
      const refused = run(pins);
      expect(refused.status).not.toBe(0);
      expect(refused.stdout).not.toContain('fixture reached');
      expect(refused.stderr).toContain('PAPERCUSP_TEST_CGROUP_CONTAINMENT');
    }
  });
});

describe('proc-guard --busy: cgroup CPU sampling', () => {
  describe('parseCgroupPath', () => {
    it('extracts the cgroup-v2 path', () => {
      expect(parseCgroupPath('0::/user.slice/user-1000.slice/run-u123272.scope\n')).toBe(
        '/user.slice/user-1000.slice/run-u123272.scope',
      );
    });

    it('returns null on a v1-only host rather than guessing a path', () => {
      expect(parseCgroupPath('12:pids:/user.slice\n4:cpu,cpuacct:/user.slice\n')).toBeNull();
    });
  });

  describe('parseUsageUsec', () => {
    it('reads usage_usec out of a cpu.stat body', () => {
      expect(parseUsageUsec('usage_usec 123456\nuser_usec 100000\nsystem_usec 23456\n')).toBe(123456);
    });

    it('returns null when the field is absent', () => {
      expect(parseUsageUsec('nr_periods 0\nnr_throttled 0\n')).toBeNull();
    });
  });

  describe('computeCoresBusy', () => {
    it('converts a usec delta over elapsed ms into cores', () => {
      expect(computeCoresBusy(2_000_000, 1000)).toBeCloseTo(2.0, 5);
    });

    it('returns null rather than Infinity when elapsed is zero', () => {
      expect(computeCoresBusy(1_000_000, 0)).toBeNull();
    });
  });

  describe('sampleCgroupBusy', () => {
    function busyFixture(usageSeries: number[]): { procRoot: string; cgroupRoot: string; advance: () => void } {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-busy-'));
      const procRoot = join(fixtureRoot, 'proc');
      const cgroupRoot = join(fixtureRoot, 'cgroup');
      mkdirSync(join(procRoot, '42'), { recursive: true });
      writeFileSync(join(procRoot, '42', 'cgroup'), '0::/test.scope\n');
      mkdirSync(join(cgroupRoot, 'test.scope'), { recursive: true });
      const statPath = join(cgroupRoot, 'test.scope', 'cpu.stat');
      writeFileSync(join(cgroupRoot, 'test.scope', 'cgroup.procs'), '42\n43\n44\n');
      let i = 0;
      const write = () => writeFileSync(statPath, `usage_usec ${usageSeries[i]}\n`);
      write();
      return {
        procRoot,
        cgroupRoot,
        advance: () => {
          i = Math.min(i + 1, usageSeries.length - 1);
          write();
        },
      };
    }

    it('divides by MEASURED elapsed, not the requested sample window', async () => {
      // 1 core-second of CPU observed over a MEASURED 500ms => 2 cores.
      // If the implementation divided by sampleMs (10s) it would say 0.10 —
      // so this number is what pins the correct divisor.
      const { procRoot, cgroupRoot, advance } = busyFixture([1_000_000, 2_000_000]);
      let t = 0;
      const res = await sampleCgroupBusy(42, {
        procRoot,
        cgroupRoot,
        sampleMs: 10_000,
        sleep: async () => {
          advance();
          t = 500;
        },
        now: () => t,
      });

      expect(res.status).toBe('ok');
      if (res.status !== 'ok') throw new Error(`expected an ok sample, got ${res.status}`);
      expect(res.cores).toBeCloseTo(2.0, 5);
      expect(res.elapsedMs).toBe(500);
      expect(res.procs).toBe(3); // every descendant, not just the pid asked about
    });

    it('reports UNKNOWN — never 0 cores — when the cgroup cannot be read', async () => {
      // "could not measure" and "measured, idle" must not render alike: the
      // whole incident behind this feature was an unmeasurable read being
      // reported as an idle one.
      fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-busy-none-'));
      const procRoot = join(fixtureRoot, 'proc');
      mkdirSync(join(procRoot, '42'), { recursive: true });
      writeFileSync(join(procRoot, '42', 'cgroup'), '0::/test.scope\n');

      const res = await sampleCgroupBusy(42, {
        procRoot,
        cgroupRoot: join(fixtureRoot, 'cgroup-does-not-exist'),
        sampleMs: 1,
        sleep: async () => {},
      });

      expect(res.status).toBe('unknown');
      if (res.status !== 'unknown') throw new Error(`expected an unknown sample, got ${res.status}`);
      expect(res.reason).toBe('cpu-stat-unreadable');
      expect(res.cores).toBeUndefined();
    });

    it('fails closed before sleeping when the budget cannot fit one full sample', async () => {
      const { procRoot, cgroupRoot } = busyFixture([1_000_000, 2_000_000]);
      let sleeps = 0;
      const res = await sampleCgroupBusy(42, {
        procRoot,
        cgroupRoot,
        sampleMs: 1_000,
        budgetMs: 500,
        sleep: async () => {
          sleeps += 1;
        },
        now: () => 0,
      });

      expect(res.status).toBe('unknown');
      if (res.status !== 'unknown') throw new Error(`expected an unknown sample, got ${res.status}`);
      expect(res.reason).toBe('budget-exhausted');
      expect(sleeps).toBe(0);
    });

    it('shares one wall-clock budget across matches instead of serialising samples', async () => {
      const { procRoot, cgroupRoot, advance } = busyFixture([1_000_000, 2_000_000]);
      mkdirSync(join(procRoot, '43'), { recursive: true });
      writeFileSync(join(procRoot, '43', 'cgroup'), '0::/test.scope\n');

      let nowMs = 0;
      let active = 0;
      let maxActive = 0;
      const results = await sampleBusyMatches([{ pid: 42 }, { pid: 43 }], {
        procRoot,
        cgroupRoot,
        sampleMs: 1_000,
        budgetMs: 1_500,
        sleep: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          advance();
          nowMs = 1_000;
          active -= 1;
        },
        now: () => nowMs,
      });

      expect(maxActive).toBe(2);
      expect(results.map((sample) => sample.status)).toEqual(['ok', 'ok']);
    });
  });

  describe('formatBusy', () => {
    it('attaches the falsifier to a near-zero reading', () => {
      const lines = formatBusy({ status: 'ok', cores: 0.0, procs: 1, elapsedMs: 10_000, cgroupPath: '/t.scope' });
      expect(lines.join(' ')).toMatch(/near-zero/);
      expect(lines.join(' ')).toMatch(/DIFFERENT cgroup/);
    });

    it('does NOT cry wolf on a genuinely busy reading', () => {
      const lines = formatBusy({ status: 'ok', cores: 2.54, procs: 15, elapsedMs: 10_000, cgroupPath: '/t.scope' });
      expect(lines.join(' ')).toContain('2.54 core(s)');
      expect(lines.join(' ')).not.toMatch(/near-zero/);
    });

    it('renders an unknown sample as UNKNOWN and explicitly not idle', () => {
      const lines = formatBusy({ status: 'unknown', reason: 'no-cgroup-entry' });
      expect(lines.join(' ')).toContain('UNKNOWN');
      expect(lines.join(' ')).toMatch(/NOT "idle"/);
    });
  });
});

/**
 * EI-21295926764996833 — cross-pot attribution.
 *
 * Every pot executes the SAME `apps/operator/lib/release/green-checkpoint.ts`
 * out of the papercusp tree, so script path, node binary and tsx loader flags
 * are byte-identical across pots. A reader watching successive pids appear and
 * die reads N pots firing on the same hourly cron as ONE pot thrashing. That
 * misreading has already been paid for twice: a wrong "green-checkpoint is
 * CRASH-LOOPING" broadcast to two owners with wake:required (retracted ~12min
 * later), and a second agent claiming a work-item off the same misleading row.
 *
 * `PAPERCUSP_INTEGRATION_ROOT` is the field that ends it: the launcher sets it
 * explicitly on the detached spawn (release-checkpoint-launch.ts) and the
 * periodic routine inherits it from the operator's unit env, and it is the same
 * value green-checkpoint's own `cfg.integrationRoot` resolves from.
 */
describe('proc-guard: which TREE does this process belong to (EI-21295926764996833)', () => {
  const GATE_CGROUP = '/user.slice/user-1000.slice/papercup-green-checkpoint.service';

  it('prefers the DECLARED integration root over cwd, and reports which source it used', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    fixtureProc(fixtureRoot, 500, 1, ['node', 'apps/operator/lib/release/green-checkpoint.ts']);
    fixtureIdentity(fixtureRoot, 500, {
      environment: ['PAPERCUSP_INTEGRATION_ROOT=/home/x/papercupai-workspace/papercusp'],
      // cwd deliberately DISAGREES: the launcher's own statement must win over
      // an inference, or a gate started from a sibling directory misattributes.
      cwd: '/home/x/somewhere-else',
    });
    const [row] = listProcesses(fixtureRoot, { readIdentity: true });
    expect(resolveOwningTree(fixtureRoot, row)).toEqual({
      path: '/home/x/papercupai-workspace/papercusp',
      source: 'integration-root-env',
    });
  });

  it('falls back to cwd when the root was never declared, and LABELS it an inference', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    fixtureProc(fixtureRoot, 501, 1, ['node', 'apps/operator/lib/release/green-checkpoint.ts']);
    fixtureIdentity(fixtureRoot, 501, { cwd: '/home/x/.papercusp/hives/hello-world-3-pot' });
    const [row] = listProcesses(fixtureRoot, { readIdentity: true });
    expect(resolveOwningTree(fixtureRoot, row)).toEqual({
      path: '/home/x/.papercusp/hives/hello-world-3-pot',
      source: 'cwd',
    });
  });

  it('returns UNKNOWN rather than a confident answer when neither source resolves', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    fixtureProc(fixtureRoot, 502, 1, ['node', 'apps/operator/lib/release/green-checkpoint.ts']);
    const [row] = listProcesses(fixtureRoot, { readIdentity: true });
    // null is UNKNOWN — a failed measurement. It must never be read as "no
    // tree" or as "not the tree you asked about".
    expect(resolveOwningTree(fixtureRoot, row)).toBeNull();
  });

  it('distinguishes the four concurrent pots that were previously indistinguishable', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    // The measured 2026-08-24T01:20:40Z population, byte-identical in argv.
    const ARGV = ['node', 'apps/operator/lib/release/green-checkpoint.ts'];
    const roots: Record<number, string> = {
      3027831: '/tmp/papercusp-mobile-greenfield-20260821/stonebrook-android-20260821',
      3030113: '/home/x/.papercusp-workspaces/clones/hello-world-3',
      3033727: '/home/x/.papercusp-workspaces/clones/oddsmith',
      3046776: '/home/x/.papercusp/hives/hello-world-3-pot',
    };
    for (const [pid, root] of Object.entries(roots)) {
      fixtureProc(fixtureRoot, Number(pid), 1, ARGV);
      fixtureIdentity(fixtureRoot, Number(pid), {
        environment: [`PAPERCUSP_INTEGRATION_ROOT=${root}`],
        cgroupPath: GATE_CGROUP,
      });
    }
    const rows = listProcesses(fixtureRoot, { readIdentity: true });
    // The precondition that made this bug possible: argv alone cannot separate them.
    expect(new Set(rows.map((r) => r.cmdline)).size).toBe(1);
    // The fix: every row now resolves to its own distinct tree.
    const trees = rows.map((r) => resolveOwningTree(fixtureRoot as string, r)?.path);
    expect(new Set(trees).size).toBe(4);
    expect(trees).toEqual(expect.arrayContaining(Object.values(roots)));
  });

  it('sameTreePath normalises trailing slashes and relative segments', () => {
    expect(sameTreePath('/a/b', '/a/b/')).toBe(true);
    expect(sameTreePath('/a/b', '/a/b/../b')).toBe(true);
    expect(sameTreePath('/a/b', '/a/c')).toBe(false);
  });

  describe('--integration-root filtering', () => {
    const ARGV = ['node', 'apps/operator/lib/release/green-checkpoint.ts'];
    const MINE = '/home/x/papercupai-workspace/papercusp';
    const THEIRS = '/home/x/.papercusp-workspaces/clones/oddsmith';

    function population() {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
      fixtureProc(fixtureRoot, 600, 1, ARGV);
      fixtureIdentity(fixtureRoot, 600, { environment: [`PAPERCUSP_INTEGRATION_ROOT=${MINE}`] });
      fixtureProc(fixtureRoot, 601, 1, ARGV);
      fixtureIdentity(fixtureRoot, 601, { environment: [`PAPERCUSP_INTEGRATION_ROOT=${THEIRS}`] });
      // 602 is UNATTRIBUTABLE: no declared root, no readable cwd.
      fixtureProc(fixtureRoot, 602, 1, ARGV);
      return listProcesses(fixtureRoot, { readIdentity: true });
    }

    it('drops a row only on positive evidence it belongs to another tree', () => {
      const rows = population();
      const out = filterByOwningTree(fixtureRoot as string, rows, MINE);
      expect(out.selected.map((r: { pid: number }) => r.pid).sort()).toEqual([600, 602]);
      expect(out.excludedOtherTree).toBe(1);
    });

    /**
     * The safety property, stated as its own test because it is the one that
     * would regress silently: if an unattributable row were dropped, this
     * filter could report "nothing is running for your tree" while a live gate
     * it merely failed to read keeps running. A liveness check that can emit a
     * confident false negative is worse than no check at all.
     */
    it('RETAINS an unattributable row rather than silently excluding it', () => {
      const rows = population();
      // Ask for a tree that matches NOTHING attributable. The unattributable
      // row must still come back, and must be counted as retained.
      const out = filterByOwningTree(fixtureRoot as string, rows, '/home/x/some/other/tree');
      expect(out.selected.map((r: { pid: number }) => r.pid)).toEqual([602]);
      expect(out.unattributedRetained).toBe(1);
      expect(out.excludedOtherTree).toBe(2);
    });

    it('accounts for every input row across selected + excluded', () => {
      const rows = population();
      const out = filterByOwningTree(fixtureRoot as string, rows, MINE);
      // Nothing is silently dropped: the two buckets reconstruct the input.
      expect(out.selected.length + out.excludedOtherTree).toBe(rows.length);
    });
  });
});
