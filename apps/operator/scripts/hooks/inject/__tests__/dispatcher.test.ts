/**
 * Tests for the shared context-injection dispatcher.
 * Plan: codex-context-injection-parity-2026-08-09 P-007 (D-001 invariants).
 *
 * ── WHAT IS ACTUALLY BEING ASSERTED, AND WHY IT IS ASSERTED THIS WAY ──
 * The contract is "EXIT 0 AND EMPTY STDOUT", as a PAIR. Each half alone passes
 * trivially and for the wrong reason: a hook that crashes emits empty stdout,
 * and a hook that injects garbage exits 0. Only the conjunction distinguishes
 * "failed silently, as designed" from "failed" and from "succeeded loudly".
 *
 * So the fail-silent cases drive the REAL CLI as a SUBPROCESS rather than
 * calling dispatch() directly: exit code is a property of the process, and a
 * unit test that only inspects a return value cannot observe it. A crash inside
 * an in-process call would surface as a rejected promise the test could catch —
 * i.e. the very failure mode being guarded would be invisible.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Overridable via PROBE_SCRIPT (CLAUDE.md's "Proving a guard is falsifiable"
// tier-2 shape) so scripts/mutation-probe.sh can point this suite at a
// mutated COPY of index.mjs — e.g. with the outer fail-silent catch removed —
// without ever mutating the tracked file (EI-19989482108652654).
const CLI = process.env.PROBE_SCRIPT || path.join(HERE, '..', 'index.mjs');

const claude = await import(path.join(HERE, '..', 'adapters', 'claude.mjs'));
const codex = await import(path.join(HERE, '..', 'adapters', 'codex.mjs'));
const ports = await import(path.join(HERE, '..', 'ports.mjs'));

/**
 * A fake operator. Records what it received; answers with injectable text.
 * `opts` is read per request, so a test may mutate it between turns.
 */
function fakeOperator(opts: { text?: string | null; delayMs?: number; deliveryToken?: string } = {}) {
  const received: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({ url: req.url ?? '', body: JSON.parse(raw || '{}') });
      const send = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            text: opts.text ?? 'INJECTED',
            ...(opts.deliveryToken ? { deliveryToken: opts.deliveryToken } : {}),
          }),
        );
      };
      if (opts.delayMs) setTimeout(send, opts.delayMs);
      else send();
    });
  });
  return {
    received,
    async start() {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const addr = server.address();
      return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    },
    async stop() {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Run the real CLI. Returns exit code + stdout — never throws on non-zero. */
async function runCli(
  args: string[],
  stdin: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, ...env }, timeout: 20_000 },
      (err, stdout, stderr) => {
        // Bind to a local before narrowing: two separate `(err as ...).code`
        // cast expressions don't narrow each other, which is what triggered
        // TS2352 here (a genuine, if pre-existing, type-safety gap).
        const rawCode = err ? (err as NodeJS.ErrnoException).code : undefined;
        const code = typeof rawCode === 'number' ? rawCode : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    child.stdin?.end(stdin);
  });
}

let running: { stop: () => Promise<void> } | null = null;
afterEach(async () => {
  await running?.stop();
  running = null;
});

describe('event -> port routing', () => {
  it('claude maps its five boundaries and ignores everything else', () => {
    expect(claude.portForEvent('UserPromptSubmit')).toBe('turn-start');
    expect(claude.portForEvent('PostToolBatch')).toBe('mid-turn');
    // PreToolUse is deliberately NOT mid-turn (D-027): injecting from there
    // requires a permissionDecision, which would auto-approve tool calls. It is
    // the identity GUARD port instead (P-011), which renders only as a deny.
    expect(claude.portForEvent('PreToolUse')).toBe('pre-tool');
    expect(claude.portForEvent('Stop')).toBe('stop');
    expect(claude.portForEvent('SessionStart')).toBe('compaction');
    expect(claude.portForEvent('PostToolUse')).toBeNull();
    expect(claude.portForEvent('SubagentStop')).toBeNull();
  });

  it('codex maps BOTH its config (kebab) and payload (Pascal) spellings', () => {
    const expected: Array<[string[], string]> = [
      [['UserPromptSubmit', 'user-prompt-submit'], 'turn-start'],
      [['PostToolUse', 'post-tool-use'], 'mid-turn'],
      [['PreToolUse', 'pre-tool-use'], 'pre-tool'],
      [['Stop', 'stop'], 'stop'],
      [['SessionStart', 'session-start'], 'compaction'],
    ];
    for (const [events, port] of expected) {
      for (const e of events) expect(codex.portForEvent(e)).toBe(port);
    }
    // Codex has no batch event at all; PostToolBatch is a Claude-only name and
    // must not silently map, or a mis-wired install would look like it worked.
    expect(codex.portForEvent('PostToolBatch')).toBeNull();
    expect(codex.portForEvent('pre-compact')).toBeNull();
  });
});

describe('identity hook ports (P-011): parse / render', () => {
  it('pre-tool ships the whole input, or flags it cut, never a lossy prefix', () => {
    expect(claude.parse('pre-tool', { tool_name: 'Bash', tool_input: { command: 'ls' } }))
      .toEqual({ tool: 'Bash', input: { command: 'ls' } });
    const big = { command: 'x'.repeat(ports.PORTS['pre-tool'].guardInputMaxBytes) };
    expect(claude.parse('pre-tool', { tool_name: 'Bash', tool_input: big })).toEqual({ tool: 'Bash', inputTruncated: true });
    expect(codex.parse('pre-tool', { tool_name: 'shell', tool_input: { command: 'ls' }, cwd: '/repo' }))
      .toEqual({ tool: 'shell', input: { command: 'ls' }, cwd: '/repo' });
    expect(claude.parse('pre-tool', { tool_input: {} })).toBeNull();
  });

  it('pre-tool renders ONLY as a deny, on both clients', () => {
    for (const adapter of [claude, codex]) {
      const out = JSON.parse(adapter.render('pre-tool', 'Refused by identity a rule b: no') as string);
      expect(out).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Refused by identity a rule b: no',
        },
      });
    }
  });

  it('stop never re-fires from a stop it already continued', () => {
    for (const adapter of [claude, codex]) {
      expect(adapter.parse('stop', { stop_hook_active: true })).toBeNull();
      expect(adapter.parse('stop', { stop_hook_active: false })).not.toBeNull();
    }
  });

  it('stop renders additionalContext on claude and a block reason on codex (no context channel there)', () => {
    expect(JSON.parse(claude.render('stop', 'S') as string)).toEqual({
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'S' },
    });
    expect(JSON.parse(codex.render('stop', 'S') as string)).toEqual({ decision: 'block', reason: 'S' });
  });

  it('compaction fires on startup/clear/compact only, and renders as SessionStart context', () => {
    for (const adapter of [claude, codex]) {
      for (const source of ['startup', 'clear', 'compact']) expect(adapter.parse('compaction', { source })).toMatchObject({ source });
      for (const source of ['resume', 'fork', undefined]) expect(adapter.parse('compaction', { source })).toBeNull();
      expect(JSON.parse(adapter.render('compaction', 'C') as string)).toEqual({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'C' },
      });
    }
  });
});

describe('adapter parse / render', () => {
  it('claude turn-start clamps the prompt to the contract length', () => {
    const parsed = claude.parse('turn-start', { prompt: 'x'.repeat(9_000) }) as { prompt: string };
    expect(parsed.prompt).toHaveLength(4_000);
  });

  it('claude mid-turn clamps to 12 calls x 400 chars per field', () => {
    const calls = Array.from({ length: 30 }, (_, i) => ({
      tool_name: `t${i}`,
      tool_input: 'i'.repeat(2_000),
      tool_response: 'r'.repeat(2_000),
    }));
    const parsed = claude.parse('mid-turn', { tool_calls: calls }) as {
      toolCalls: Array<{ toolInput: string; toolResponse: string }>;
    };
    expect(parsed.toolCalls).toHaveLength(12);
    expect(parsed.toolCalls[0].toolInput).toHaveLength(400);
    expect(parsed.toolCalls[0].toolResponse).toHaveLength(400);
  });

  it('preserves an edit path beyond the recall clamp for both native and MCP edits', () => {
    for (const tool of ['Edit', 'mcp__papercusp_su__capability_edit', 'capability:edit']) {
      const parsed = codex.parse('mid-turn', { tool_name: tool,
        tool_input: { old_string: 'x'.repeat(2000), file_path: '/repo/lib/example.ts' }, tool_response: 'ok' }) as any;
      expect(parsed.toolCalls[0].editedPath).toBe('/repo/lib/example.ts');
      expect(parsed.toolCalls[0].toolInput).toHaveLength(400);
    }
  });

  it('codex mid-turn is PER-CALL and normalises to a one-element array', () => {
    const parsed = codex.parse('mid-turn', {
      tool_name: 'shell',
      tool_input: { command: 'ls' },
      tool_response: 'ok',
      cwd: '/repo',
    }) as { toolCalls: Array<{ tool: string }>; cwd: string };
    // The shape the SERVER sees is identical to claude's, which is what lets one
    // client-agnostic endpoint serve a per-batch and a per-call client.
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].tool).toBe('shell');
    // Codex supplies cwd on every event; prefer it over the hook's own cwd.
    expect(parsed.cwd).toBe('/repo');
  });
  it('preserves all native patch headers beyond the recall clamp', () => {
    const patch = `*** Begin Patch\n*** Update File: lib/a.ts\n@@\n-${'x'.repeat(600)}\n+y\n*** Update File: lib/b.ts\n@@\n-a\n+b\n*** End Patch`;
    for (const tool of ['apply_patch', 'functions.apply_patch']) {
      const parsed = codex.parse('mid-turn', { tool_name: tool, tool_input: patch, tool_response: 'ok' }) as any;
      expect(parsed.toolCalls[0].editedPaths).toEqual(['lib/a.ts', 'lib/b.ts']);
      expect(parsed.toolCalls[0].toolInput).toHaveLength(400);
    }
  });

  it('parse returns null when there is no signal, so nothing is spent', () => {
    expect(claude.parse('turn-start', { prompt: 123 })).toBeNull();
    expect(claude.parse('mid-turn', { tool_calls: [] })).toBeNull();
    expect(codex.parse('mid-turn', { tool_name: '' })).toBeNull();
    expect(codex.parse('turn-start', {})).toBeNull();
  });

  it('render echoes the event name each client expects', () => {
    expect(JSON.parse(claude.render('mid-turn', 'T') as string)).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: 'T' },
    });
    expect(JSON.parse(codex.render('mid-turn', 'T') as string)).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'T' },
    });
  });
});

describe('kill-switch asymmetry (the load-bearing one)', () => {
  it('turn-start DEGRADES — still calls, with memoryEnabled false', () => {
    // A memory preference must never suppress the CTRL transition riding the
    // same request. If this ever flips to suppress, safety-critical mode/loop/
    // route transitions stop being delivered whenever a user turns memory off.
    const state = ports.killSwitchState('turn-start', { PAPERCUSP_TURN_START_MEMORY: 'off' });
    expect(state).toEqual({ off: true, mode: 'degrade' });
  });

  it('mid-turn SUPPRESSES — the whole port goes away', () => {
    const state = ports.killSwitchState('mid-turn', { PAPERCUSP_MID_TURN_CONTEXT: 'off' });
    expect(state).toEqual({ off: true, mode: 'suppress' });
  });

  it('the identity ports share ONE switch, and it suppresses', () => {
    for (const port of ['pre-tool', 'stop', 'compaction']) {
      expect(ports.killSwitchState(port, { PAPERCUSP_IDENTITY_HOOKS: 'off' })).toEqual({ off: true, mode: 'suppress' });
    }
  });
});

describe('identity hook ports through the real CLI (P-011)', () => {
  it('pre-tool: a refusal from the operator becomes a deny for that one call', async () => {
    const op = fakeOperator({ text: 'Refused by identity safe-coder rule no-rm: no recursive deletes' });
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=claude', '--event=PreToolUse'],
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }),
      { PAPERCUSP_SID: 'sid-guard', PAPERCUSP_OPERATOR_URL: base },
    );
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Refused by identity safe-coder rule no-rm: no recursive deletes',
    });
    expect(op.received[0].url).toContain('tool-guard');
    expect(op.received[0].body).toMatchObject({ tool: 'Bash', input: { command: 'rm -rf /' }, client: 'claude' });
  });

  it('pre-tool: no verdict emits NOTHING, so the client permission flow decides', async () => {
    const op = fakeOperator({ text: '' });
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=codex', '--event=PreToolUse'],
      JSON.stringify({ tool_name: 'shell', tool_input: { command: 'ls' }, cwd: '/repo' }),
      { PAPERCUSP_SID: 'sid-guard', PAPERCUSP_OPERATOR_URL: base },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('');
    expect(op.received).toHaveLength(1);
  });

  it('stop and compaction reach their endpoints and render per client', async () => {
    const op = fakeOperator({ text: 'IDENTITY CONTEXT' });
    const base = await op.start();
    running = op;
    const env = { PAPERCUSP_SID: 'sid-sinks', PAPERCUSP_OPERATOR_URL: base };
    const stop = await runCli(['--client=codex', '--event=Stop'], JSON.stringify({ stop_hook_active: false, cwd: '/repo' }), env);
    expect(JSON.parse(stop.stdout)).toEqual({ decision: 'block', reason: 'IDENTITY CONTEXT' });
    const compaction = await runCli(['--client=claude', '--event=SessionStart'], JSON.stringify({ source: 'compact' }), env);
    expect(JSON.parse(compaction.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'IDENTITY CONTEXT' },
    });
    expect(op.received.map((r) => r.url)).toEqual([
      expect.stringContaining('stop-context'), expect.stringContaining('compaction-context'),
    ]);
    expect(op.received[1].body).toMatchObject({ source: 'compact' });
  });

  it('the kill switch means no request at all', async () => {
    const op = fakeOperator();
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=claude', '--event=PreToolUse'],
      JSON.stringify({ tool_name: 'Bash', tool_input: {} }),
      { PAPERCUSP_SID: 'sid-off', PAPERCUSP_OPERATOR_URL: base, PAPERCUSP_IDENTITY_HOOKS: 'off' },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('');
    expect(op.received).toHaveLength(0);
  });
});

describe('the happy path (so the fail-silent tests below are not vacuous)', () => {
  it('injects, and stamps the client on the request', async () => {
    const op = fakeOperator();
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=codex', '--event=UserPromptSubmit'],
      JSON.stringify({ prompt: 'hello' }),
      { PAPERCUSP_SID: 'sid-1', PAPERCUSP_OPERATOR_URL: base },
    );
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'INJECTED' },
    });
    // P-005: without this the coverage query cannot tell "codex got nothing"
    // from "codex was never asked".
    expect(op.received).toHaveLength(1);
    expect(op.received[0].body.client).toBe('codex');
    expect(op.received[0].url).toContain('turn-start-memory');
  });

  it('carries the private mid-turn detector key separately from the public owner', async () => {
    const op = fakeOperator();
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=claude', '--event=PostToolBatch'],
      JSON.stringify({
        tool_calls: [{ tool_name: 'Grep', tool_input: { pattern: 'failure-loop' }, tool_response: 'hit' }],
      }),
      {
        PAPERCUSP_SID: 'public-owner',
        PAPERCUSP_FAILURE_LOOP_SESSION_KEY: 'private-detector',
        PAPERCUSP_OPERATOR_URL: base,
      },
    );
    expect(res.code).toBe(0);
    expect(op.received).toHaveLength(1);
    expect(op.received[0].body.owner).toBe('public-owner');
    expect(op.received[0].body.detectorSessionKey).toBe('private-detector');
  });

  it('falls back to the public owner for legacy hook environments without a carrier', async () => {
    const op = fakeOperator();
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=claude', '--event=PostToolBatch'],
      JSON.stringify({
        tool_calls: [{ tool_name: 'Grep', tool_input: { pattern: 'failure-loop' }, tool_response: 'hit' }],
      }),
      { PAPERCUSP_SID: 'legacy-owner', PAPERCUSP_OPERATOR_URL: base },
    );
    expect(res.code).toBe(0);
    expect(op.received).toHaveLength(1);
    expect(op.received[0].body.owner).toBe('legacy-owner');
    expect(op.received[0].body.detectorSessionKey).toBe('legacy-owner');
  });
});

describe('CTRL target-owner fence', () => {
  it('drops a foreign CTRL block but preserves following context', async () => {
    const op = fakeOperator({
      text: '⟦CTRL:transition⟧ {"targetOwnerId":"sid-previous"}\n\n## Orientation\nkeep this',
    });
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=codex', '--event=UserPromptSubmit'],
      JSON.stringify({ prompt: 'continue' }),
      { PAPERCUSP_SID: 'sid-current', PAPERCUSP_OPERATOR_URL: base },
    );

    expect(res.code).toBe(0);
    const output = JSON.parse(res.stdout).hookSpecificOutput.additionalContext as string;
    expect(output).not.toContain('CTRL:');
    expect(output).toContain('## Orientation\nkeep this');
  });

  it('keeps a CTRL block addressed to the requesting owner', async () => {
    const op = fakeOperator({ text: '⟦CTRL:full-resync⟧ {"targetOwnerId":"sid-current"}' });
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=codex', '--event=UserPromptSubmit'],
      JSON.stringify({ prompt: 'continue' }),
      { PAPERCUSP_SID: 'sid-current', PAPERCUSP_OPERATOR_URL: base },
    );

    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).hookSpecificOutput.additionalContext).toContain('CTRL:full-resync');
  });
});

describe('fail-silent: EXIT 0 AND EMPTY STDOUT (D-001 invariant 1)', () => {
  const cases: Array<{ name: string; args: string[]; stdin: string; env: Record<string, string> }> =
    [
      {
        name: 'no PAPERCUSP_SID (not a psu session)',
        args: ['--client=claude', '--event=UserPromptSubmit'],
        stdin: JSON.stringify({ prompt: 'hi' }),
        env: { PAPERCUSP_SID: '' },
      },
      {
        name: 'mid-turn kill-switch off',
        args: ['--client=claude', '--event=PostToolBatch'],
        stdin: JSON.stringify({ tool_calls: [{ tool_name: 'B' }] }),
        env: { PAPERCUSP_SID: 's', PAPERCUSP_MID_TURN_CONTEXT: 'off' },
      },
      {
        name: 'malformed stdin',
        args: ['--client=claude', '--event=UserPromptSubmit'],
        stdin: '{not json at all',
        env: { PAPERCUSP_SID: 's' },
      },
      {
        name: 'empty stdin',
        args: ['--client=claude', '--event=UserPromptSubmit'],
        stdin: '',
        env: { PAPERCUSP_SID: 's' },
      },
      {
        name: 'unknown client',
        args: ['--client=nosuchtui', '--event=UserPromptSubmit'],
        stdin: JSON.stringify({ prompt: 'hi' }),
        env: { PAPERCUSP_SID: 's' },
      },
      {
        name: 'unknown event',
        args: ['--client=claude', '--event=NoSuchEvent'],
        stdin: JSON.stringify({ prompt: 'hi' }),
        env: { PAPERCUSP_SID: 's' },
      },
      {
        name: 'missing flags entirely',
        args: [],
        stdin: JSON.stringify({ prompt: 'hi' }),
        env: { PAPERCUSP_SID: 's' },
      },
      {
        name: 'operator down (connection refused)',
        args: ['--client=claude', '--event=UserPromptSubmit'],
        stdin: JSON.stringify({ prompt: 'hi' }),
        // Reserved-by-convention discard port: nothing listens, connect fails fast.
        // The proxy fallback (WI-10005007) is pointed at a dead port too: a loopback
        // pin that is refused is retried on the MCP proxy, which on a dev box is a
        // LIVE operator — without this the case would quietly measure the real one.
        env: { PAPERCUSP_SID: 's', PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9', PAPERCUSP_MCP_PROXY_PORT: '9' },
      },
      {
        // EI-19989482108652654: the 8 cases above are all absorbed by dispatch()'s
        // OWN try/catch, so none of them can observe whether the OUTER catch at the
        // bottom of index.mjs (`dispatch().then(...).catch(() => process.exit(0))`)
        // still exists. This case forces dispatch() itself to reject (via the
        // test-only env seam), which only the outer catch can absorb — deleting
        // that line turns this into an unhandled promise rejection (Node exits
        // non-zero), so this case is what makes that line's removal detectable.
        name: 'unexpected throw reaching dispatch() (outer catch, not the inner one)',
        args: ['--client=claude', '--event=UserPromptSubmit'],
        stdin: JSON.stringify({ prompt: 'hi' }),
        env: { PAPERCUSP_SID: 's', PAPERCUSP_INJECT_TEST_FORCE_THROW: '1' },
      },
    ];

  for (const c of cases) {
    it(`${c.name} -> exit 0, no output`, async () => {
      const res = await runCli(c.args, c.stdin, c.env);
      expect(res.code).toBe(0);
      expect(res.stdout).toBe('');
    });
  }

  it('loopback pin refused -> the turn is served by the MCP proxy instead (WI-10005007)', async () => {
    // A staging-pinned session (PAPERCUSP_OPERATOR_URL=:3170) whose pin is down
    // used to get NOTHING at turn start: no CTRL, no orientation, no memory, and
    // no ACK-ON-PROOF token, so an in-place identity activation could not apply.
    const op = fakeOperator({ text: 'VIA-PROXY' });
    const base = await op.start();
    running = op;
    const proxyPort = new URL(base).port;
    const res = await runCli(['--client=claude', '--event=UserPromptSubmit'], JSON.stringify({ prompt: 'hi' }), {
      PAPERCUSP_SID: 'sid-fallback',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9',
      PAPERCUSP_MCP_PROXY_PORT: proxyPort,
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('VIA-PROXY');
    expect(op.received).toHaveLength(1);
    expect(op.received[0]?.url).toBe('/api/agent-mcp/turn-start-memory');
    expect(op.received[0]?.body.owner).toBe('sid-fallback');
  });

  it('operator SLOWER than the port wall -> exit 0, no output', async () => {
    // mid-turn's wall is 1.5s; answer at 4s. The turn must proceed un-augmented
    // rather than wait — a slow operator costs the turn nothing.
    const op = fakeOperator({ delayMs: 4_000 });
    const base = await op.start();
    running = op;
    const started = Date.now();
    const res = await runCli(
      ['--client=claude', '--event=PostToolBatch'],
      JSON.stringify({ tool_calls: [{ tool_name: 'B', tool_input: 'x', tool_response: 'y' }] }),
      { PAPERCUSP_SID: 's', PAPERCUSP_OPERATOR_URL: base },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('');
    // Bounded well under the 4s answer: proves the wall fired rather than the
    // request simply having failed for some other reason.
    expect(Date.now() - started).toBeLessThan(3_500);
  }, 20_000);

  it('empty/whitespace injection text -> nothing emitted', async () => {
    const op = fakeOperator({ text: '   ' });
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=claude', '--event=UserPromptSubmit'],
      JSON.stringify({ prompt: 'hi' }),
      { PAPERCUSP_SID: 's', PAPERCUSP_OPERATOR_URL: base },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('');
  });
});

/**
 * ACK-ON-PROOF (owner-directive-delivery-redesign-2026-09-22 P-005, D-005).
 * The operator acks a turn-start orientation block only when the next request
 * echoes the token it was delivered under, and the CLI records that token only
 * after its stdout write succeeded. Driven through the real subprocess because
 * "printed, then recorded" is a property of the process, not of dispatch().
 */
describe('turn-start delivery ledger (P-005)', () => {
  const turnStart = (env: Record<string, string>) =>
    runCli(['--client=claude', '--event=UserPromptSubmit'], JSON.stringify({ prompt: 'hi' }), env);
  const isolatedHome = () => mkdtempSync(path.join(tmpdir(), 'inject-ledger-'));

  it('echoes the token it printed on the NEXT turn, and nothing it did not print', async () => {
    const opts: { deliveryToken?: string; delayMs?: number } = { deliveryToken: 'tok-1' };
    const op = fakeOperator(opts);
    const base = await op.start();
    running = op;
    const env = { PAPERCUSP_SID: 'sid-ledger', PAPERCUSP_OPERATOR_URL: base, PAPERCUSP_HOME: isolatedHome() };

    const first = await turnStart(env);
    expect(first.stdout).toContain('INJECTED');
    // Nothing provable yet: the key is present (opted in) and null.
    expect(op.received[0].body).toHaveProperty('confirmedDelivery', null);

    // This turn's answer lands after the 2.5s wall, so the hook prints nothing —
    // the exact case where the server staged tok-2 and arrival would have acked it.
    opts.deliveryToken = 'tok-2';
    opts.delayMs = 3_000;
    const killed = await turnStart(env);
    expect(killed.stdout).toBe('');
    expect(op.received[1].body.confirmedDelivery).toBe('tok-1');

    opts.delayMs = 0;
    await turnStart(env);
    expect(op.received[2].body.confirmedDelivery).toBe('tok-1');
  }, 20_000);

  it('records nothing when the response has nothing to print', async () => {
    const opts: { text?: string; deliveryToken?: string } = { text: '   ', deliveryToken: 'tok-silent' };
    const op = fakeOperator(opts);
    const base = await op.start();
    running = op;
    const env = { PAPERCUSP_SID: 'sid-silent', PAPERCUSP_OPERATOR_URL: base, PAPERCUSP_HOME: isolatedHome() };

    await turnStart(env);
    await turnStart(env);
    expect(op.received[1].body.confirmedDelivery).toBeNull();
    expect(existsSync(path.join(env.PAPERCUSP_HOME, 'state', 'turn-start-delivery', 'sid-silent.emissions'))).toBe(false);
  });

  it('retains exact original emission proof across compaction and a new native turn', async () => {
    const owner = 'sid-carry-proof';
    const desired = { specificationRevision: '1'.repeat(64), stateRevision: '2'.repeat(64) };
    const applied = { ...desired, stateRevision: '3'.repeat(64) };
    const control = { targetOwnerId: owner, generation: 18, stateHash: '4'.repeat(64),
      state: { activation: { status: 'prepared', desired, prepared: desired, applied } } };
    const opts = { text: `⟦CTRL:transition⟧ ${JSON.stringify(control)}\n\nPRIVATE-CONTEXT`, deliveryToken: 'token-18' };
    const op = fakeOperator(opts);
    const base = await op.start();
    running = op;
    const env = { PAPERCUSP_SID: owner, PAPERCUSP_OPERATOR_URL: base, PAPERCUSP_HOME: isolatedHome() };
    const turn = (native: string) => runCli(['--client=codex', '--event=UserPromptSubmit'],
      JSON.stringify({ prompt: 'measure', session_id: native }), env);
    const first = await turn('native-before');
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('PRIVATE-CONTEXT');
    const receipts = path.join(env.PAPERCUSP_HOME, 'state', 'turn-start-delivery', `${owner}.emissions`);
    const originalPath = path.join(receipts, readdirSync(receipts)[0]);
    const original = readFileSync(originalPath, 'utf8');
    expect(JSON.parse(original)).toMatchObject({ token: 'token-18', stage: 'stdout-emitted',
      nativeSessionId: 'native-before', payloadSha256: createHash('sha256').update(first.stdout).digest('hex'),
      control: { generation: 18, desired, prepared: desired, applied } });
    expect(original).not.toContain('PRIVATE-CONTEXT');
    opts.deliveryToken = 'compaction-only-token';
    await runCli(['--client=codex', '--event=SessionStart'], JSON.stringify({ source: 'compact' }), env);
    expect(readdirSync(receipts)).toHaveLength(1);
    opts.deliveryToken = 'token-19';
    opts.text = `⟦CTRL:transition⟧ ${JSON.stringify({ ...control, generation: 19 })}\n\nSUCCESSOR`;
    const successor = await turn('native-after');
    expect(successor.code).toBe(0);
    expect(op.received[2].body.confirmedDelivery).toBe('token-18');
    expect(readFileSync(originalPath, 'utf8')).toBe(original);
    expect(readdirSync(receipts)).toHaveLength(2);
    expect(readFileSync(path.join(path.dirname(receipts), `${owner}.token`), 'utf8')).toBe('token-19');
    const newest = readdirSync(receipts).map(name => JSON.parse(readFileSync(path.join(receipts, name), 'utf8')))
      .find(receipt => receipt.token === 'token-19');
    expect(newest).toMatchObject({ nativeSessionId: 'native-after', control: { generation: 19 } });
  });

  it('mid-turn never carries a confirmation — the ledger is turn-start only', async () => {
    const op = fakeOperator({ deliveryToken: 'tok-mid' });
    const base = await op.start();
    running = op;
    await runCli(
      ['--client=claude', '--event=PostToolBatch'],
      JSON.stringify({ tool_calls: [{ tool_name: 'B', tool_input: 'x', tool_response: 'y' }] }),
      { PAPERCUSP_SID: 'sid-mid', PAPERCUSP_OPERATOR_URL: base, PAPERCUSP_HOME: isolatedHome() },
    );
    expect(op.received[0].body).not.toHaveProperty('confirmedDelivery');
  });

  it('an unwritable ledger keeps ack-on-arrival instead of proving nothing forever', async () => {
    const op = fakeOperator({ deliveryToken: 'tok-1' });
    const base = await op.start();
    running = op;
    // A regular FILE where the home directory should be: mkdir under it fails.
    const home = path.join(isolatedHome(), 'not-a-dir');
    writeFileSync(home, '');
    const res = await turnStart({ PAPERCUSP_SID: 'sid-ro', PAPERCUSP_OPERATOR_URL: base, PAPERCUSP_HOME: home });
    expect(res.stdout).toContain('INJECTED');
    expect(op.received[0].body).not.toHaveProperty('confirmedDelivery');
  });
});

describe('CONTROL — proves the assertions above can actually fail', () => {
  /**
   * Without this, every fail-silent assertion is satisfiable by a dispatcher
   * that does nothing at all, and a test suite that cannot distinguish a
   * working guard from a DELETED one is not a guard at all (P-007).
   *
   * These drive the SAME CLI with the SAME harness and assert the OPPOSITE
   * outcome, so if the fail-silent paths were removed — or if the runner were
   * silently not executing anything — the pair could not both hold.
   */
  it('a working path DOES produce stdout, so "empty stdout" is a real signal', async () => {
    const op = fakeOperator();
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=claude', '--event=UserPromptSubmit'],
      JSON.stringify({ prompt: 'hi' }),
      { PAPERCUSP_SID: 's', PAPERCUSP_OPERATOR_URL: base },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).not.toBe('');
    expect(res.stdout).toContain('additionalContext');
  });

  it('a NON-ZERO exit is observable by this harness, so "exit 0" is a real signal', async () => {
    // If runCli always reported 0 — a plausible bug in the helper — every
    // fail-silent test would pass against a dispatcher that crashes.
    const res = await new Promise<number>((resolve) => {
      const child = execFile(process.execPath, ['-e', 'process.exit(3)'], () => {});
      child.on('exit', (code) => resolve(code ?? -1));
    });
    expect(res).toBe(3);
  });

  it('the turn-start kill-switch is NOT suppress — catches a collapse to boolean', () => {
    // The specific regression: someone reads D-001's one-line summary, makes
    // both switches booleans, and turn-start stops delivering CTRL transitions.
    expect(ports.killSwitchState('turn-start', { PAPERCUSP_TURN_START_MEMORY: 'off' }).mode).not.toBe(
      'suppress',
    );
  });
});
