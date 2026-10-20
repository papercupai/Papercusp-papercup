/**
 * PreToolUse restricted-egress guard (plan personal-data-reader-set-labels-2026-10-01,
 * P-007, BAR R-11): the client-native Bash / WebFetch half of the egress binding.
 *
 * Pins (1) the hook's coarse prefilter to the operator's authoritative rule list —
 * an installed hook cannot import that list, so a rule added there without a
 * prefilter entry would silently skip the check — and (2) the decision flow,
 * including the fail-closed branches, and (3) the script's stdin/stdout wiring.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  RESTRICTED_EGRESS_MATCHER,
  RTK_BIN_ENV,
  RTK_EARLY_EXIT_PIPE,
  RTK_GREP_NO_FILENAME,
  decideEgress,
  egressTexts,
  prefilterHits,
  resolveRtkBin,
  rtkRewriteSync,
  sandboxedBashCommand,
} from '../pretooluse-restricted-egress-guard.mjs';
import {
  RTK_EARLY_EXIT_PIPE as CAPABILITY_BASH_EARLY_EXIT_PIPE,
  RTK_GREP_NO_FILENAME as CAPABILITY_BASH_GREP_NO_FILENAME,
} from '../../../../../../packages/operator-core/lib/agent-tools/capability/rtk-rewrite';

/** A stand-in for `rtk rewrite <cmd>` covering the exit codes rtk uses. */
function fakeRtk() {
  const dir = mkdtempSync(join(tmpdir(), 'egress-guard-rtk-'));
  const bin = join(dir, 'rtk');
  writeFileSync(
    bin,
    `#!/bin/sh
[ "$1" = rewrite ] || exit 64
case "$2" in
  "git status") echo "rtk git status"; exit 0 ;;
  "git log -n 3") echo "warn" >&2; echo "rtk git log -n 3"; exit 3 ;;
  "rg -n x . | "*) echo "rtk $2"; exit 0 ;;
  "grep "*) echo "rtk $2"; exit 0 ;;
  deny*) exit 2 ;;
  *vitest*) echo "rtk vitest"; exit 0 ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
import { providerEgressRules } from '../../../../../../packages/operator-core/lib/personal-vault/provider-egress.mjs';

const HOOK = fileURLToPath(new URL('../pretooluse-restricted-egress-guard.mjs', import.meta.url));
const ENV = { PAPERCUSP_SID: 'su-test', PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:59999' } as NodeJS.ProcessEnv;
const PROVIDER_COMMAND = 'curl -X POST https://slack.com/api/chat.postMessage -d text=hi';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('prefilter covers the operator rule list', () => {
  it('matches every rule sample in provider-egress.mjs', () => {
    for (const rule of providerEgressRules()) expect(prefilterHits([rule.sample]), rule.id).toBe(true);
  });

  it('does not match ordinary commands', () => {
    for (const command of ['ls -la', 'git status', 'npm run test:file -- a.test.ts', 'curl http://127.0.0.1:3070/api/health']) {
      expect(prefilterHits([command]), command).toBe(false);
    }
  });
});

describe('decideEgress', () => {
  it('reads the Bash command and the WebFetch URL, nothing else', () => {
    expect(egressTexts('Bash', { command: 'echo hi' })).toEqual(['echo hi']);
    expect(egressTexts('WebFetch', { url: 'https://slack.com', prompt: 'x' })).toEqual(['https://slack.com']);
    expect(egressTexts('Read', { file_path: '/x' })).toEqual([]);
  });

  it('allows a non-psu session (no PAPERCUSP_SID) without calling the operator', async () => {
    const fetchImpl = vi.fn();
    const result = await decideEgress({ toolName: 'Bash', toolInput: { command: PROVIDER_COMMAND }, env: {}, fetchImpl });
    expect(result).toEqual({ decision: 'allow' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('denies with the operator reason when a provider is named, and asks for the restriction status', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, verdict: 'refuse', code: 'disclosure_egress_refused', reason: 'restricted session', restricted: true }),
    );
    const result = await decideEgress({ toolName: 'Bash', toolInput: { command: PROVIDER_COMMAND }, env: ENV, fetchImpl });
    expect(result).toEqual({ decision: 'deny', reason: 'restricted session' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:59999/api/agent-mcp/restricted-egress-check');
    expect(JSON.parse(String(init.body))).toEqual({ owner: 'su-test', tool: 'Bash', texts: [PROVIDER_COMMAND], status: true });
  });

  it('allows every tool unchanged when the operator says the session is unrestricted', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, verdict: 'allow', restricted: false, sourceHold: 'clear' }));
    for (const [toolName, toolInput] of [
      ['Bash', { command: 'ls' }],
      ['WebFetch', { url: 'https://example.com', prompt: 'x' }],
      ['mcp__tsenta__search', { q: 'x' }],
    ] as const) {
      await expect(decideEgress({ toolName, toolInput, env: ENV, fetchImpl }), toolName).resolves.toEqual({ decision: 'allow' });
    }
  });

  // WI-10005589 / D-012: the network layer, not name matching.
  describe('a restricted session', () => {
    const restricted = () => vi.fn(async () => jsonResponse({ ok: true, verdict: 'allow', restricted: true, sourceHold: 'clear' }));
    const RUNTIME_HOOK = `${process.env.HOME}/.papercusp/hooks/cc/x.sh`;

    it('has Bash rewritten to run with no network — even a host built at run time', async () => {
      const command = `python3 -c "import urllib.request; urllib.request.urlopen('https://' + 'slack' + '.com')"`;
      const result = await decideEgress({
        toolName: 'Bash',
        toolInput: { command, description: 'd', run_in_background: true },
        env: ENV,
        fetchImpl: restricted(),
        sandbox: (c) => `SANDBOX[${c}]`,
      });
      expect(result).toEqual({
        decision: 'rewrite',
        updatedInput: { command: `SANDBOX[${command}]`, description: 'd', run_in_background: true },
      });
    });

    it.each(['held', 'unknown'] as const)('treats a %s integration-tree hold as globally restricted', async (sourceHold) => {
      const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, verdict: 'allow', restricted: false, sourceHold }));
      await expect(
        decideEgress({
          toolName: 'Bash',
          toolInput: { command: 'ls -la' },
          env: ENV,
          fetchImpl,
          sandbox: (command) => `SANDBOX[${command}]`,
        }),
      ).resolves.toMatchObject({ decision: 'rewrite', updatedInput: { command: 'SANDBOX[ls -la]' } });
      await expect(
        decideEgress({ toolName: 'WebFetch', toolInput: { url: 'https://example.com' }, env: ENV, fetchImpl }),
      ).resolves.toMatchObject({ decision: 'deny' });
      await expect(
        decideEgress({ toolName: 'mcp__slack__post_message', toolInput: {}, env: ENV, fetchImpl }),
      ).resolves.toMatchObject({ decision: 'deny' });
    });

    it('denies user-systemd probes when bwrap masks the host runtime directory', async () => {
      const command = 'systemctl --user list-units --type=service --state=running --no-legend | wc -l';
      const result = await decideEgress({
        toolName: 'Bash',
        toolInput: { command },
        env: ENV,
        fetchImpl: restricted(),
        sandbox: (c) => `'/usr/bin/bwrap' '--dev-bind' '/' '/' '--unshare-net' '--tmpfs' '/run/user/1000' '--' '/bin/bash' '-c' ${JSON.stringify(c)}`,
      });

      expect(result).toMatchObject({ decision: 'deny' });
      if (result.decision === 'deny') {
        expect(result.reason).toContain('masks `/run/user/<uid>`');
        expect(result.reason).toContain('zero count would be misleading');
        expect(result.reason).toContain('ps -eo pid,user,unit,args');
        expect(result.reason).toContain('the process’s procfs cgroup entry');
      }
    });

    it('keeps user-systemd probes available with the unshare fallback, and ignores quoted mentions', async () => {
      const fetchImpl = restricted();
      const unshare = (command: string) => `'/usr/bin/unshare' '--user' '--map-current-user' '--net' '--' '/bin/bash' '-c' ${JSON.stringify(command)}`;
      const query = await decideEgress({
        toolName: 'Bash',
        toolInput: { command: 'systemctl --user list-units --no-legend' },
        env: ENV,
        fetchImpl,
        sandbox: unshare,
      });
      expect(query.decision).toBe('rewrite');

      const quoted = await decideEgress({
        toolName: 'Bash',
        toolInput: { command: `printf '%s\\n' 'systemctl --user list-units'` },
        env: ENV,
        fetchImpl,
        sandbox: (command) => `'/usr/bin/bwrap' '--unshare-net' '--tmpfs' '/run/user/1000' '--' '/bin/bash' '-c' ${JSON.stringify(command)}`,
      });
      expect(quoted.decision).toBe('rewrite');
    });

    it('is denied Bash when no network sandbox exists on the host', async () => {
      const result = await decideEgress({ toolName: 'Bash', toolInput: { command: 'ls' }, env: ENV, fetchImpl: restricted(), sandbox: () => null });
      expect(result).toMatchObject({ decision: 'deny' });
    });

    it('is denied WebFetch and every non-Papercusp MCP tool, but not Papercusp’s own (gated) tools', async () => {
      const fetchImpl = restricted();
      for (const [toolName, toolInput] of [
        ['WebFetch', { url: 'https://example.com', prompt: 'x' }],
        ['mcp__slack__post_message', { text: 'hi' }],
      ] as const) {
        await expect(decideEgress({ toolName, toolInput, env: ENV, fetchImpl }), toolName).resolves.toMatchObject({ decision: 'deny' });
      }
      const calls = fetchImpl.mock.calls.length;
      await expect(decideEgress({ toolName: 'mcp__papercusp-su__mail_send', toolInput: {}, env: ENV, fetchImpl })).resolves.toEqual({
        decision: 'allow',
      });
      expect(fetchImpl.mock.calls.length).toBe(calls);
    });

    it('is denied edits of the files the CLI executes, and allowed every other edit without an operator call', async () => {
      const fetchImpl = restricted();
      for (const file_path of [RUNTIME_HOOK, `${process.env.HOME}/.claude/settings.json`, '/repo/.git/hooks/post-commit', '/repo/.mcp.json']) {
        await expect(
          decideEgress({ toolName: 'Edit', toolInput: { file_path }, cwd: '/repo', env: ENV, fetchImpl }),
          file_path,
        ).resolves.toMatchObject({ decision: 'deny' });
      }
      const calls = fetchImpl.mock.calls.length;
      await expect(
        decideEgress({ toolName: 'Write', toolInput: { file_path: '/repo/src/a.ts' }, cwd: '/repo', env: ENV, fetchImpl }),
      ).resolves.toEqual({ decision: 'allow' });
      expect(fetchImpl.mock.calls.length).toBe(calls);
    });
  });

  it('keeps WebFetch denied for unknown operator status while distinguishing request failures', async () => {
    const failing = vi.fn(async () => jsonResponse({ ok: false, error: 'boom' }, 500));
    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const unknownStatus = vi.fn(async () => jsonResponse({ ok: true, verdict: 'allow', restricted: null }));
    for (const fetchImpl of [failing, down, unknownStatus]) {
      await expect(
        decideEgress({ toolName: 'Bash', toolInput: { command: 'ls' }, env: ENV, fetchImpl, sandbox: (c) => `S[${c}]` }),
      ).resolves.toEqual({ decision: 'rewrite', updatedInput: { command: 'S[ls]' } });
    }
    for (const fetchImpl of [failing, down]) {
      const webFetch = await decideEgress({
        toolName: 'WebFetch',
        toolInput: { url: 'https://x.example' },
        env: ENV,
        fetchImpl,
      });
      expect(webFetch.decision).toBe('deny');
      if (webFetch.decision !== 'deny') throw new Error('an unverified WebFetch must stay denied');
      expect(webFetch.reason).toContain('restriction status is unknown, not a restriction verdict');
      expect(webFetch.reason).toContain('Retry after the operator responds');
    }
    await expect(
      decideEgress({ toolName: 'WebFetch', toolInput: { url: 'https://x.example' }, env: ENV, fetchImpl: unknownStatus }),
    ).resolves.toMatchObject({ decision: 'deny' });
  });

  it('distinguishes an operator timeout from a restriction verdict and names a recovery path', async () => {
    const timedOut = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });

    const result = await decideEgress({
      toolName: 'WebFetch',
      toolInput: { url: 'https://github.com/example/repo' },
      env: ENV,
      fetchImpl: timedOut,
    });

    expect(result.decision).toBe('deny');
    if (result.decision !== 'deny') throw new Error('a timeout must keep WebFetch denied');
    expect(result.reason).toContain('restriction check timed out after 4000 ms');
    expect(result.reason).toContain('restriction status is unknown, not a restriction verdict');
    expect(result.reason).toContain('Retry after the operator responds');
    expect(result.reason).toContain('dev:service_health');
    expect(result.reason).toContain('/api/agent-mcp/restricted-egress-check');
  });
});

/**
 * RTK (WI-6554700010009291, owner #1759/#1764). Several hooks that each return
 * Bash `updatedInput` resolve by completion order, so this guard is the ONE
 * writer: RTK rewrites first, the sandbox wraps that, and every deny check
 * judges the original command.
 */
describe('RTK composed into the single Bash rewrite', () => {
  const rtk = (command: string) => (command === 'ls' || command.startsWith('git ') ? `rtk ${command}` : null);

  it('rewrites a non-psu session’s command without calling the operator', async () => {
    const fetchImpl = vi.fn();
    const result = await decideEgress({ toolName: 'Bash', toolInput: { command: 'git status' }, env: {}, fetchImpl, rtk });
    expect(result).toEqual({ decision: 'rewrite', updatedInput: { command: 'rtk git status' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rewrites for an unrestricted psu session, keeping every other input field', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, restricted: false, sourceHold: 'clear' }));
    const result = await decideEgress({
      toolName: 'Bash',
      toolInput: { command: 'ls', description: 'list', timeout: 5000 },
      env: ENV,
      fetchImpl,
      rtk,
    });
    expect(result).toEqual({
      decision: 'rewrite',
      updatedInput: { command: 'rtk ls', description: 'list', timeout: 5000 },
    });
  });

  it('sandboxes the RTK form for a restricted session, so both survive', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, restricted: true }));
    const result = await decideEgress({
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      env: ENV,
      fetchImpl,
      rtk,
      sandbox: (c) => `SANDBOX[${c}]`,
    });
    expect(result).toEqual({ decision: 'rewrite', updatedInput: { command: 'SANDBOX[rtk ls]' } });
  });

  it('a deny still wins over the rewrite', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, verdict: 'refuse', reason: 'use chat:post' }));
    const result = await decideEgress({
      toolName: 'Bash',
      toolInput: { command: PROVIDER_COMMAND },
      env: ENV,
      fetchImpl,
      rtk: (c) => `rtk ${c}`,
    });
    expect(result).toEqual({ decision: 'deny', reason: 'use chat:post' });
    // The operator judged the ORIGINAL command, not the RTK form.
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).texts).toEqual([PROVIDER_COMMAND]);
  });

  it('allows unchanged when rtk has no equivalent', async () => {
    const result = await decideEgress({ toolName: 'Bash', toolInput: { command: 'echo hi' }, env: {}, rtk });
    expect(result).toEqual({ decision: 'allow' });
  });

  it('never rewrites a non-Bash tool', async () => {
    const rtkSpy = vi.fn(rtk);
    const result = await decideEgress({ toolName: 'Read', toolInput: { file_path: '/tmp/x' }, env: {}, rtk: rtkSpy });
    expect(result).toEqual({ decision: 'allow' });
    expect(rtkSpy).not.toHaveBeenCalled();
  });
});

describe('rtkRewriteSync', () => {
  it('honours rtk exit 0 and 3 (stdout only), and fails open on 1, 2 and a missing binary', () => {
    const fake = fakeRtk();
    try {
      const env = { [RTK_BIN_ENV]: fake.bin };
      expect(rtkRewriteSync('git status', { env })).toBe('rtk git status');
      expect(rtkRewriteSync('git log -n 3', { env })).toBe('rtk git log -n 3');
      expect(rtkRewriteSync('echo hi', { env })).toBeNull();
      expect(rtkRewriteSync('deny this', { env })).toBeNull();
      expect(rtkRewriteSync('git status', { env: { [RTK_BIN_ENV]: join(tmpdir(), 'no-such-rtk-bin') } })).toBeNull();
    } finally {
      fake.cleanup();
    }
  });

  it('never offers vitest (EI-9471) or an RTK_DISABLED=1 command to rtk', () => {
    const fake = fakeRtk();
    try {
      const env = { [RTK_BIN_ENV]: fake.bin };
      expect(rtkRewriteSync('npx vitest run a.test.ts', { env })).toBeNull();
      expect(rtkRewriteSync('RTK_DISABLED=1 git status', { env })).toBeNull();
    } finally {
      fake.cleanup();
    }
  });

  it('never offers a pipe into an early-exit consumer, though rtk would rewrite it (WI-6554700010009543)', () => {
    const fake = fakeRtk();
    try {
      const env = { [RTK_BIN_ENV]: fake.bin };
      // control: the fake rewrites this pipe shape (tail reads everything, so RTK costs nothing extra)
      expect(rtkRewriteSync('rg -n x . | tail -5', { env })).toBe('rtk rg -n x . | tail -5');
      expect(rtkRewriteSync('rg -n x . | head -5', { env })).toBeNull();
      expect(rtkRewriteSync('rg -n x . |& head -5', { env })).toBeNull();
      expect(rtkRewriteSync('rg -n x . | grep -m 3 y', { env })).toBeNull();
      expect(rtkRewriteSync('rg -n x . | sed 20q', { env })).toBeNull();
    } finally {
      fake.cleanup();
    }
  });

  it('keeps its early-exit rule identical to capability:bash (rtk-rewrite.ts)', () => {
    expect(RTK_EARLY_EXIT_PIPE.source).toBe(CAPABILITY_BASH_EARLY_EXIT_PIPE.source);
    expect(RTK_EARLY_EXIT_PIPE.flags).toBe(CAPABILITY_BASH_EARLY_EXIT_PIPE.flags);
  });

  it('never offers grep -h / --no-filename, which rtk grep reads as --help (WI-6554700010009627)', () => {
    const fake = fakeRtk();
    try {
      const env = { [RTK_BIN_ENV]: fake.bin };
      // control: the fake rewrites any grep, and a grep without -h still gets the RTK form
      expect(rtkRewriteSync('grep -n foo a.log', { env })).toBe('rtk grep -n foo a.log');
      expect(rtkRewriteSync("grep -E 'h|x' a.log", { env })).toBe("rtk grep -E 'h|x' a.log");
      expect(rtkRewriteSync("grep -h -E 'foo|bar' a.log b.log", { env })).toBeNull();
      expect(rtkRewriteSync('grep -hn foo a.log', { env })).toBeNull();
      expect(rtkRewriteSync('grep -rh foo src', { env })).toBeNull();
      expect(rtkRewriteSync("grep -E 'a|b' -h a.log", { env })).toBeNull();
      expect(rtkRewriteSync('grep --no-filename foo a.log b.log', { env })).toBeNull();
    } finally {
      fake.cleanup();
    }
  });

  it('keeps its grep -h rule identical to capability:bash (rtk-rewrite.ts)', () => {
    expect(RTK_GREP_NO_FILENAME.source).toBe(CAPABILITY_BASH_GREP_NO_FILENAME.source);
    expect(RTK_GREP_NO_FILENAME.flags).toBe(CAPABILITY_BASH_GREP_NO_FILENAME.flags);
  });

  it('never picks up the host binary implicitly under vitest', () => {
    expect(resolveRtkBin({ PATH: process.env.PATH })).toBeNull();
  });
});

describe('the installed matcher', () => {
  const asRegex = [(m: string) => new RegExp(m), (m: string) => new RegExp(`^(?:${m})$`)];
  it('matches the guarded tools and no Papercusp MCP tool, under either regex reading', () => {
    for (const toRe of asRegex) {
      const re = toRe(RESTRICTED_EGRESS_MATCHER);
      for (const name of ['Bash', 'WebFetch', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'mcp__slack__post', 'mcp__tsenta__x']) {
        expect(re.test(name), name).toBe(true);
      }
    }
    const anchored = asRegex[1](RESTRICTED_EGRESS_MATCHER);
    for (const name of ['mcp__papercusp-su__coord_send', 'mcp__papercusp__x', 'Read', 'Grep']) expect(anchored.test(name), name).toBe(false);
  });

  it('is the matcher the desktop installer writes', () => {
    const installer = readFileSync(
      fileURLToPath(new URL('../../../../../../packages/operator-core/lib/desktop-install/papercusp-files.ts', import.meta.url)),
      'utf8',
    );
    expect(installer).toContain(`matcher: '${RESTRICTED_EGRESS_MATCHER}'`);
  });
});

describe('sandboxedBashCommand', () => {
  const home = '/home/u';
  const env = { HOME: home } as NodeJS.ProcessEnv;
  const present = new Set(['/usr/bin/bwrap', '/run/user/1000', '/run/docker.sock', `${home}/.claude`, `${home}/.papercusp/hooks`]);

  it('unshares the network, hides host-service sockets, and makes runtime config read-only', () => {
    const script = `echo 'it''s'`;
    const encoded = Buffer.from(script, 'utf8').toString('base64');
    const cmd = sandboxedBashCommand(script, { env, cwd: '/repo', uid: 1000, exists: (p) => present.has(p) })!;
    expect(cmd.startsWith(`'printf' '%s' '${encoded}' | 'base64' '--decode' | '/usr/bin/bwrap' '--dev-bind' '/' '/' '--unshare-net'`)).toBe(true);
    expect(cmd).not.toContain(script);
    expect(cmd).not.toContain("'-c'");
    expect(cmd).toContain(`'--tmpfs' '/run/user/1000'`);
    expect(cmd).toContain(`'--ro-bind' '/dev/null' '/run/docker.sock'`);
    expect(cmd).toContain(`'--ro-bind' '${home}/.claude' '${home}/.claude'`);
    expect(cmd).toContain(`'--ro-bind' '${home}/.papercusp/hooks' '${home}/.papercusp/hooks'`);
    expect(cmd).not.toContain('.mcp.json'); // absent paths are skipped (bwrap cannot bind a missing path)
    expect(cmd.endsWith(`'--' '/bin/bash'`)).toBe(true);
  });

  it('falls back to unshare --net, and to null when neither exists', () => {
    expect(sandboxedBashCommand('ls', { env, uid: 1000, exists: (p) => p === '/usr/bin/unshare' })).toBe(
      `'printf' '%s' '${Buffer.from('ls', 'utf8').toString('base64')}' | 'base64' '--decode' | '/usr/bin/unshare' '--user' '--map-current-user' '--net' '--' '/bin/bash'`,
    );
    expect(sandboxedBashCommand('ls', { env, uid: 1000, exists: () => false })).toBeNull();
  });

  const bwrapWorks = spawnSync('/usr/bin/bwrap', ['--dev-bind', '/', '/', '--unshare-net', '/bin/true']).status === 0;

  it.skipIf(!bwrapWorks)('really has no network: a host listener is reachable outside and unreachable inside (real bwrap)', async () => {
    // The probe closes as soon as it connects; swallow the resulting reset so it is not an unhandled error.
    const server = createServer((socket) => {
      socket.on('error', () => {});
      socket.end();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    try {
      const probe = `python3 -c "import socket; s=socket.create_connection(('127.0.0.1', ${port}), 2); print('CONNECTED')"`;
      const run = (command: string) => spawnAsync('/bin/bash', ['-c', command]);
      expect((await run(probe)).stdout).toContain('CONNECTED');
      const decision = await decideEgress({
        toolName: 'Bash',
        toolInput: { command: probe },
        env: ENV,
        fetchImpl: vi.fn(async () => jsonResponse({ ok: true, verdict: 'allow', restricted: false, sourceHold: 'held' })),
        sandbox: (command) => sandboxedBashCommand(command, { cwd: process.cwd() }),
      });
      expect(decision.decision).toBe('rewrite');
      if (decision.decision !== 'rewrite') throw new Error('source-held Bash was not isolated');
      const inside = await run(decision.updatedInput.command as string);
      expect(inside.stdout).not.toContain('CONNECTED');
      expect(inside.code).not.toBe(0);
      // An ordinary command still works and its exit status passes through.
      const ordinary = await run(sandboxedBashCommand('echo ok; exit 3', { cwd: process.cwd() })!);
      expect(ordinary).toMatchObject({ code: 3 });
      expect(ordinary.stdout).toContain('ok');
    } finally {
      server.close();
    }
  });
});

/** Spawn without blocking the event loop (the in-process listener must keep serving). */
function spawnAsync(file: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((done) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('close', (code) => done({ code, stdout }));
  });
}

describe('script wiring', () => {
  // The child does not inherit VITEST, so RTK is pinned off unless a case opts in;
  // otherwise the host's installed rtk would rewrite these commands.
  function run(payload: unknown, env: NodeJS.ProcessEnv) {
    return spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      env: { PATH: process.env.PATH, [RTK_BIN_ENV]: '', ...env },
      encoding: 'utf8',
      timeout: 20_000,
    });
  }

  it('prints an RTK updatedInput for a non-psu session when rtk has an equivalent', () => {
    const fake = fakeRtk();
    try {
      const res = run({ tool_name: 'Bash', tool_input: { command: 'git status' } }, { [RTK_BIN_ENV]: fake.bin });
      expect(res.status).toBe(0);
      const out = JSON.parse(res.stdout) as { hookSpecificOutput: Record<string, unknown> };
      expect(out.hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', updatedInput: { command: 'rtk git status' } });
    } finally {
      fake.cleanup();
    }
  });

  it('prints nothing outside a psu session', () => {
    const res = run({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }, {});
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  it('prints an updatedInput running the command offline when the operator cannot clear the session', () => {
    const res = run({ tool_name: 'Bash', tool_input: { command: 'ls -la' }, cwd: process.cwd() }, ENV);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as { hookSpecificOutput: Record<string, unknown> };
    if (sandboxedBashCommand('ls -la') === null) {
      expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
    } else {
      expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse' });
      expect(String((out.hookSpecificOutput.updatedInput as { command: string }).command)).toMatch(/--unshare-net|--net/);
    }
  });

  it('prints a PreToolUse deny when a provider command cannot be cleared', () => {
    const res = run({ tool_name: 'Bash', tool_input: { command: PROVIDER_COMMAND } }, ENV);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as { hookSpecificOutput: Record<string, string> };
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
  });
});
