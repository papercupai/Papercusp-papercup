/**
 * EI-22647418629976526 — capability:bash is a write-capability by default, but
 * code:run must not describe a fully observational diagnostic as a mutation.
 *
 * The classifier is intentionally conservative: unknown shell syntax remains a
 * write so dry-run safety is never weakened by an incomplete shell parser.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookupByMcpName } from '@papercusp/agent-mcp';
import { runToolOrchestration } from '@papercusp/tooldef';
import type { ProjectedTool, UnifiedToolContext } from '@papercusp/tooldef';
import bashTool, { classifyCapabilityBashEffect } from './bash';
import './bash_output';
import { sedIsObservational } from './bash-effect';
import { normalizeExpectedSigpipeResult, runForeground } from './bash-jobs';

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});

const context = (): UnifiedToolContext =>
  ({
    log: () => {},
    signal: new AbortController().signal,
    progress: () => {},
    emit: () => {},
    workspaceId: 'test-workspace',
    harnessSlug: 'papercusp',
    role: 'worker',
    runId: 'ei-226474-test',
  }) as unknown as UnifiedToolContext;

describe('capability:bash per-call effect classifier (EI-22647418629976526)', () => {
  it('classifies the reported systemctl/ss/bounded-strace diagnostic as read-only', () => {
    expect(
      classifyCapabilityBashEffect({
        command: 'systemctl show papercusp-staging-api.service && ss -ltnp && timeout 5s strace -f -p 123',
      }),
    ).toBe('read');

    const registered = lookupByMcpName('capability:bash');
    expect(registered?.effect).toBe('write');
    expect(registered?.effectForCall?.({ command: 'ss -ltnp' })).toBe('read');
  });

  it('does not count a non-consuming bash_output peek failure as a write', async () => {
    const registered = lookupByMcpName('capability:bash_output');
    expect(registered).toBeDefined();
    expect(registered?.effect).toBe('write'); // consuming polls advance the output cursor
    expect(registered?.effectForCall?.({ task_id: 'missing', peek: true })).toBe('read');
    expect(registered?.effectForCall?.({ task_id: 'missing' })).toBe('write');

    const child = {
      ...registered!,
      fn: vi.fn(async () => json({ ok: false, reason: 'unknown_task_id' })),
    } as ProjectedTool;
    const result = await runToolOrchestration(
      `const poll = await tools.capability.bash_output({ task_id: 'missing', peek: true });
       return { ok: poll.ok, reason: poll.reason };`,
      { ctx: context(), deps: {}, tools: [child] },
    );

    expect(result.ok).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.plannedMutations).toEqual([]);
    expect(result.okFalseMutations).toEqual([]);
    expect(result.childFailures).toEqual([
      expect.objectContaining({ tool: 'capability:bash_output', kind: 'semantic' }),
    ]);
    expect(result.callRecords).toEqual([
      expect.objectContaining({ tool: 'capability:bash_output', effect: 'read', disposition: 'semantic_rejected' }),
    ]);
  });

  it('classifies the df/findmnt filesystem diagnostic as read-only', async () => {
    const command = 'df -P . && findmnt -T .';
    expect(classifyCapabilityBashEffect({ command })).toBe('read');

    const bash = {
      pluginName: 'agent-mcp',
      description: 'capability:bash',
      inputSchema: { type: 'object' },
      capabilities: ['capability:bash'],
      effect: 'write' as const,
      effectForCall: classifyCapabilityBashEffect,
      expose: { mcp: { name: 'capability:bash' } },
      fn: vi.fn(async () => json({ ok: true, status: 'completed', output: 'filesystem diagnostic' })),
    } as unknown as ProjectedTool;

    const result = await runToolOrchestration(
      `const probe = await tools.capability.bash({ command: '${command}' });
       return { ok: probe.ok, status: probe.status };`,
      { ctx: context(), deps: {}, tools: [bash], dryRun: true },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toEqual({ ok: true, status: 'completed' });
    expect(result.plannedMutations).toEqual([]);
    expect(result.callRecords).toEqual([
      expect.objectContaining({ tool: 'capability:bash', effect: 'read', disposition: 'settled' }),
    ]);
  });

  it.each([
    ['unknown command', 'custom-diagnostic --json'],
    ['redirection', 'ss -ltnp > /tmp/ports.txt'],
    ['substitution', 'echo "$(ss -ltnp)"'],
    ['file mutation', 'printf x > report.txt'],
    ['service mutation', 'systemctl restart papercusp-staging-api.service'],
    ['network mutation', 'ip route add 10.0.0.0/8 via 127.0.0.1'],
    ['git mutation', 'git branch -D old-branch'],
  ])('keeps %s classified as write', (_label, command) => {
    expect(classifyCapabilityBashEffect({ command })).toBe('write');
  });

  it('treats a bounded find/sort/head listing as read-only and normalizes producer SIGPIPE', () => {
    const command = 'find /tmp/artifacts -type f -printf "%s %p\\n" | sort -nr | head -80';

    expect(classifyCapabilityBashEffect({ command })).toBe('read');
    expect(normalizeExpectedSigpipeResult(command, 'failed', 141)).toEqual({
      status: 'completed',
      exitCode: 0,
    });
  });

  it('normalizes expected SIGPIPE for a sudo-wrapped read-only find/sort/head listing', () => {
    const command = 'sudo find /tmp/artifacts -type f -printf "%s %p\\n" | sort -rn | head -20';

    expect(classifyCapabilityBashEffect({ command })).toBe('read');
    expect(normalizeExpectedSigpipeResult(command, 'failed', 141)).toEqual({
      status: 'completed',
      exitCode: 0,
    });
  });

  it('keeps mutating sudo find pipelines write-classified and preserves SIGPIPE failure', () => {
    const command = 'sudo find /tmp/artifacts -type f -delete | sort -rn | head -20';

    expect(classifyCapabilityBashEffect({ command })).toBe('write');
    expect(normalizeExpectedSigpipeResult(command, 'failed', 141)).toEqual({
      status: 'failed',
      exitCode: 141,
    });
  });

  it('classifies a bounded lsof/awk/sort/head diagnostic as read-only and normalizes producer SIGPIPE', () => {
    const command = "lsof -nP | awk '{print $1}' | sort -u | head -n 1";

    expect(classifyCapabilityBashEffect({ command })).toBe('read');
    expect(normalizeExpectedSigpipeResult(command, 'failed', 141)).toEqual({
      status: 'completed',
      exitCode: 0,
    });
  });

  it('classifies a bounded head/strings/head diagnostic as read-only and normalizes producer SIGPIPE', () => {
    const command =
      'head -c 16000 packages/operator-core/lib/cell-transcription-detector.test.ts | strings -a | head -n 120';

    expect(classifyCapabilityBashEffect({ command })).toBe('read');
    expect(normalizeExpectedSigpipeResult(command, 'failed', 141)).toEqual({
      status: 'completed',
      exitCode: 0,
    });
  });

  it('classifies an rg-to-wc no-match count probe as read-only', () => {
    const command = 'rg -l -F absent fixture.txt | wc -l';
    expect(classifyCapabilityBashEffect({ command })).toBe('read');
  });

  it('classifies only numeric-parent ps --ppid field probes as read-only', () => {
    expect(classifyCapabilityBashEffect({ command: "ps --ppid 12345 -o pid=,cmd= | awk '{print $1}'" })).toBe('read');
    expect(classifyCapabilityBashEffect({ command: 'ps --ppid 12345 -o pid=' })).toBe('read');
    expect(classifyCapabilityBashEffect({ command: "ps --ppid '$PPID' -o pid= | awk '{print $1}'" })).toBe('write');
    expect(classifyCapabilityBashEffect({ command: "ps --ppid 12345 -o pid= | awk '{system(\"touch x\")}'" })).toBe('write');
    expect(classifyCapabilityBashEffect({ command: "ps --ppid 12345 -o pid= | awk '{print $1}' && echo done" })).toBe('write');
  });

  it('completes a real bounded find/sort/head listing', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'cap-bash-find-'));
    const nested = join(fixture, 'nested');
    mkdirSync(nested);
    for (let i = 0; i < 2_000; i += 1) {
      writeFileSync(join(nested, `artifact-${String(i).padStart(4, '0')}-${'x'.repeat(48)}`), 'x');
    }
    const command = `find ${JSON.stringify(fixture)} -type f -printf "%s %p\\n" | sort -nr | head -80`;

    const result = await runForeground(
      { command, cwd: fixture, stateDir: fixture },
      new AbortController().signal,
      10_000,
    );

    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.output.split('\n').filter(Boolean)).toHaveLength(80);
  });

  it.each([
    ['command execution', 'find /tmp -type f -exec sh -c "echo {}" \\; | head -1'],
    ['directory command execution', 'find /tmp -type f -execdir printf "%s\\n" {} \\; | head -1'],
    ['delete action', 'find /tmp -type f -delete | head -1'],
    ['file print action', 'find /tmp -type f -fprint /tmp/paths.txt | head -1'],
    ['interactive command', 'find /tmp -type f -ok rm {} \\; | head -1'],
  ])('keeps find %s classified as write', (_label, command) => {
    expect(classifyCapabilityBashEffect({ command })).toBe('write');
    expect(normalizeExpectedSigpipeResult(command, 'failed', 141)).toEqual({
      status: 'failed',
      exitCode: 141,
    });
  });

  it('preserves a failed read probe without recording a planned mutation', async () => {
    const bash = {
      pluginName: 'agent-mcp',
      description: 'capability:bash',
      inputSchema: { type: 'object' },
      capabilities: ['capability:bash'],
      effect: 'write' as const,
      effectForCall: classifyCapabilityBashEffect,
      expose: { mcp: { name: 'capability:bash' } },
      fn: async () => json({ ok: false, status: 'completed', exit_code: 1, output: 'trace failed' }),
    } as unknown as ProjectedTool;

    const result = await runToolOrchestration(
      `const probe = await tools.capability.bash({ command: 'strace -f -p 123' });
       return { ok: probe.ok, exit: probe.exit_code };`,
      { ctx: context(), deps: {}, tools: [bash] },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toEqual({ ok: false, exit: 1 });
    expect(result.plannedMutations).toEqual([]);
    expect(result.writeAttempts).toBeUndefined();
    expect(result.callRecords).toEqual([
      expect.objectContaining({
        tool: 'capability:bash',
        effect: 'read',
        disposition: 'semantic_rejected',
      }),
    ]);
    expect(result.childFailures).toEqual([
      expect.objectContaining({ tool: 'capability:bash', kind: 'semantic' }),
    ]);
  });
});

/**
 * WI-10005084 — the dispatcher and the always-up MCP proxy use this classifier to decide whether
 * a capability:bash call may be retried (the proxy replays a `read` after a refused upstream) or
 * run under dryRun. It used to refuse only the exact tokens `-i` / `--in-place`, so every other
 * way sed writes a file or runs a command classified as a READ and would have executed again.
 */
describe('capability:bash sed replay safety (WI-10005084)', () => {
  it.each([
    ['attached in-place suffix', "sed -i.bak 's/a/b/' f"],
    ['in-place inside a short cluster', "sed -ni 's/a/b/p' f"],
    ['in-script write command', "sed -n 'w /tmp/x' f"],
    ['in-script execute flag', "sed 's/a/b/e' f"],
    ['in-script write flag', "sed 's/a/b/w /tmp/x' f"],
    ['script file', 'sed -f script.sed f'],
    ['script file, long form', 'sed --file=script.sed f'],
    // The script is ATTACHED to -e (getopt takes the rest of the cluster); the next token is a FILE.
    ['write script attached to -e', 'sed -ew/tmp/x p f'],
    ['write script attached to -e inside a cluster', 'sed -nes/a/b/w/tmp/x p f'],
    // GNU getopt_long accepts any unique abbreviation of a long option.
    ['abbreviated --in-place', "sed --in-p 's/a/b/' f"],
    ['shortest --in-place abbreviation', "sed --in 's/a/b/' f"],
    ['abbreviated --file', 'sed --fi=x.sed f'],
    ['unknown long option', "sed --no-such-option 's/a/b/' f"],
    ['unknown short option', "sed -x 's/a/b/' f"],
    ['no script at all', 'sed'],
    ['dangling -e', 'sed -n -e'],
    ['select chain with a write part', "sed -n '1p;w /tmp/x' f"],
    ['select chain with an unrecognised part', "sed -n '1p;N' f"],
  ])('keeps %s classified as write', (_label, command) => {
    expect(classifyCapabilityBashEffect({ command })).toBe('write');
  });

  it.each([
    ['line range print', "sed -n '200,235p' f"],
    ['address regex print', "sed -n '/re/p' f"],
    ['substitution to stdout', "sed 's/a/b/' f"],
    ['extended regexp substitution', "sed -nE 's/(a)/\\1/p' f"],
    ['separate files, last line', "sed -s -n '$p' a b"],
    ['long quiet flag with -e', 'sed --quiet -e p f'],
    ['repeated -e select scripts', "sed -n -e p -e '5q' f"],
    ['attached -e select script', "sed -ne5q f"],
    ['select chain', "sed -n '1,5p;10q' f"],
    ['select chain with trailing semicolon', "sed -n '1,5p;' f"],
    ['line-length option', 'sed -l 5 -n p f'],
    ['stdin through a pipe', 'cat f | sed -n 2p'],
  ])('keeps %s classified as read', (_label, command) => {
    expect(classifyCapabilityBashEffect({ command })).toBe('read');
  });

  it('sedIsObservational walks short clusters the way getopt does', () => {
    // `-e` takes the REST of its cluster, so what follows in the next token is a file.
    expect(sedIsObservational(['sed', '-ne5q', 'f'])).toBe(true);
    expect(sedIsObservational(['sed', '-new/x', 'p'])).toBe(false);
    // `-l` takes a length, never a script.
    expect(sedIsObservational(['sed', '-l', '5', '-n', 'p', 'f'])).toBe(true);
    expect(sedIsObservational(['sed', '-l', 'p', 'f'])).toBe(false);
  });
});

/**
 * WI-10005111 — the same hole as sed, on every other command whose option parser can write. The
 * guards used to be an exact-token denylist (`token === '-o'`), so an attached short argument, a
 * short cluster and a GNU getopt_long abbreviation all fell through to "read" and a retry or
 * dry-run would have executed the write. Every form below was measured as READ before the fix.
 */
describe('capability:bash write-capable options replay safety (WI-10005111)', () => {
  it.each([
    // The ten forms measured as READ in the filing.
    ['sort: attached short argument', 'sort -o/tmp/x f'],
    ['sort: output inside a short cluster', 'sort -ro/tmp/x f'],
    ['sort: abbreviated --output with a value', 'sort --out=/tmp/x f'],
    ['sort: abbreviated --output', 'sort --o /tmp/x f'],
    ['rg: abbreviated --pre', 'rg --pr=cmd x'],
    ['date: attached -s argument', 'date -s2020-01-01'],
    ['date: abbreviated --set', 'date --s=2020-01-01'],
    ['dmesg: abbreviated --clear', 'dmesg --cl'],
    ['fuser: kill inside a short cluster', 'fuser -km 22/tcp'],
    ['fuser: abbreviated --kill', 'fuser --ki 22/tcp'],
    // The exact spellings the old denylist knew must keep working.
    ['sort: -o', 'sort -o /tmp/x f'],
    ['sort: --output=', 'sort --output=/tmp/x f'],
    ['rg: --pre', 'rg --pre cmd x'],
    ['date: -s', 'date -s 2020-01-01'],
    ['dmesg: -C', 'dmesg -C'],
    ['fuser: -k', 'fuser -k 22/tcp'],
    // Census of the rest of the read-only set against each command's man page.
    ['sort: --compress-program executes a program', 'sort --compress-program=sh f'],
    ['rg: --hostname-bin executes a program', 'rg --hostname-bin=cmd x'],
    ['date: a bare MMDDhhmm operand sets the clock', 'date 100122002026'],
    ['date: -u does not hide an operand', 'date -u 100122002026'],
    ['dmesg: -c clears the ring buffer', 'dmesg -c'],
    ['dmesg: -c inside a cluster', 'dmesg -Tc'],
    ['dmesg: -n sets the console level', 'dmesg -n 1'],
    ['dmesg: abbreviated --console-level', 'dmesg --console-l=1'],
    ['dmesg: -D switches console logging off', 'dmesg -D'],
    ['ss: kill inside a cluster', 'ss -tK'],
    ['ss: -D dumps socket data to a file', 'ss -D /tmp/x'],
    ['ss: abbreviated --diag', 'ss --di=/tmp/x'],
    ['file: -C writes magic.mgc', 'file -C -m magic'],
    ['file: abbreviated --compile', 'file --comp -m magic'],
    ['journalctl: abbreviated --vacuum-size', 'journalctl --vacuum-s=1G'],
    ['journalctl: abbreviated --rotate', 'journalctl --rot'],
    ['journalctl: --smart-relinquish-var', 'journalctl --smart-relinquish-var'],
    ['journalctl: --setup-keys', 'journalctl --setup-keys'],
    ['journalctl: --update-catalog', 'journalctl --update-catalog'],
    ['hostname: a NAME operand sets the hostname', 'hostname newname'],
    ['hostname: -F reads the name from a file', 'hostname -F /etc/hostname'],
    ['uniq: the second operand is an output file', 'uniq in out'],
    ['strace: output inside a cluster', 'strace -fo /tmp/out -p 123'],
    ['strace: attached -o argument', 'strace -o/tmp/out -p 123'],
    ['strace: abbreviated --output', 'strace --out=/tmp/out -p 123'],
    ['git: --set-upstream-to rewrites config', 'git branch --set-upstream-to=origin/main'],
    ['git: --unset-upstream rewrites config', 'git branch --unset-upstream'],
    ['git: abbreviated --edit-description', 'git branch --edit'],
    ['git: abbreviated --output', 'git diff --out=/tmp/x'],
    ['git: --ext-diff runs the configured external diff program', 'git diff --ext-diff'],
    ['git: abbreviated --ext-diff', 'git log -p --ext-d'],
    ['git: attached global config', 'git -ccore.pager=sh log'],
    ['git: attached global directory', 'git -C/tmp log'],
    ['a write option in a later pipeline segment', 'cat f | sort -o/tmp/x'],
  ])('keeps %s classified as write', (_label, command) => {
    expect(classifyCapabilityBashEffect({ command })).toBe('write');
  });

  it.each([
    ['sort: reverse', 'sort -r f'],
    ['sort: separator argument that spells an output letter', 'sort -to f'],
    ['sort: key and separator', 'sort -t, -k2,2 -n f'],
    ['sort: a file literally named -o after --', 'sort -- -o'],
    ['rg: plain search', 'rg foo f'],
    ['rg: --pretty is not --pre', 'rg --pretty foo f'],
    ['rg: --pre-glob is not --pre', "rg --pre-glob '*.gz' foo f"],
    ['date: bare', 'date'],
    ['date: format operand', 'date +%s'],
    ['date: utc', 'date -u'],
    ['date: -d takes the next token as its argument', 'date -d 20260101'],
    ['date: attached -d argument', 'date -dyesterday +%F'],
    ['date: attached optional -I argument', 'date -Iseconds'],
    ['date: long --date with a separate argument', 'date --date 20260101 +%F'],
    ['date: reference file', 'date -r f'],
    ['dmesg: bare', 'dmesg'],
    ['dmesg: human-readable follow', 'dmesg -wH'],
    ['dmesg: level filter', 'dmesg -l err'],
    ['dmesg: --color is not --clear', 'dmesg --color=always --ctime'],
    ['fuser: plain query', 'fuser 22/tcp'],
    ['fuser: namespace and verbose', 'fuser -v -n tcp 22'],
    ['ss: listening sockets', 'ss -ltnp'],
    ['ss: no header, established', 'ss -Htan state established'],
    ['file: plain', 'file -b f'],
    ['file: magic file argument', 'file -m magic f'],
    ['journalctl: unit window', 'journalctl -u svc --since=today -n 50 --no-pager'],
    ['journalctl: --system and --user are not --sync', 'journalctl --system --user -o cat'],
    ['hostname: bare', 'hostname'],
    ['hostname: fqdn', 'hostname -f'],
    ['uniq: count', 'uniq -c f'],
    ['uniq: skip-fields takes the next token', 'uniq -f 1 f'],
    ['uniq: attached skip-fields', 'uniq -f1 f'],
    ['uniq: stdin through a pipe', 'sort f | uniq -c'],
    ['strace: bounded attach', 'timeout 5s strace -f -p 123'],
    ['strace: attached -e argument is not an output option', 'timeout 5s strace -f -etrace=openat -p 123'],
    ['git: untracked-files mode is an attached optional argument', 'git status -uno'],
    ['git: attached count', 'git log -n5 --format=%H'],
    ['git: pickaxe string attached', 'git log -Sfoo --oneline'],
    ['git: stat of the index', 'git diff --stat --cached'],
    ['git: current branch', 'git branch --show-current'],
    ['git: verbose branch list', 'git branch -vv'],
  ])('keeps %s classified as read', (_label, command) => {
    expect(classifyCapabilityBashEffect({ command })).toBe('read');
  });
});

void bashTool;
