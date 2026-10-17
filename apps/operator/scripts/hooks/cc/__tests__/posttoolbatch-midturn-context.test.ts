/**
 * posttoolbatch-midturn-context.sh — mid-turn context push at batch resolution
 * (context-injection-audit-2026-07-28 P-015, decisions D-026 + D-027).
 *
 * Drives the shell hook exactly as Claude Code does — the PostToolBatch JSON on
 * stdin, an additionalContext JSON (or silence) on stdout — against a HERMETIC
 * local HTTP stub standing in for the operator (PAPERCUSP_OPERATOR_URL).
 *
 * THREE invariants carry the weight here:
 *
 *  1. THE EVENT NAME. `hookEventName` must be PostToolBatch. This hook was FIRST
 *     built on PreToolUse and it delivered nothing while every unit test passed,
 *     because PreToolUse only injects additionalContext alongside a
 *     permissionDecision (D-027). The name is not cosmetic — it is the whole
 *     difference between working and silently inert.
 *  2. NO PERMISSION VOTE. The output must never carry permissionDecision. That
 *     is what a context hook would have to emit to be delivered on PreToolUse,
 *     and it would blanket auto-approve every matched call.
 *  3. FAIL-OPEN, AND NEVER exit 2. On this event exit code 2 STOPS the agentic
 *     loop, so a crash here would be far worse than missing recall.
 *
 * It also clamps the batch before sending: a tool_response can be megabytes, and
 * this fires on every batch, so an unclamped transport would itself be the cost.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runHookProcess } from './spawn-hook';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'posttoolbatch-midturn-context.sh');
const SID = 'su-midturn-test';

describe('P-038 shared hook attribution producer', () => {
  it('keeps observed failing identities beyond the recall clamp while discarding passes and refusals', async () => {
    const { buildDigest } = await import('../../inject/core.mjs');
    const response = { content: [{ type: 'text', text: JSON.stringify({ padding: 'x'.repeat(900), byFile: {
      'target.test.ts': { failed: 1, runId: 42 }, 'passing.test.ts': { failed: 0, status: 'pass' },
    } }) }] };
    const [call] = buildDigest([{ tool: 'mcp__papercusp_su__testing_run', toolResponse: response }]);
    expect(call.toolResponse.length).toBeLessThanOrEqual(400);
    expect(call.incidentResult).toEqual({ byFile: { 'target.test.ts': { status: 'fail', failed: 1, runId: 42 } } });
    expect(buildDigest([{ tool: 'testing:run', toolResponse: { ok: false, files: ['requested.test.ts'] } }])[0].incidentResult)
      .toBeUndefined();
  });
  it('retains source observations for a later test call and excludes a foreign harness', async () => {
    const { collectInterfaceEdits } = await import('../../inject/core.mjs');
    const env = { PAPERCUSP_HOME: mkdtempSync(join(tmpdir(), 'incident-observation-')) };
    const scope = { owner: 'su-observer', workspace: 'ws', harness: 'h', cwd: '/repo' };
    const sourceChange = { root: '/repo', path: 'a.ts', base: 'a'.repeat(40), at: Date.now(),
      beforeSha256: 'b'.repeat(64), sha256: 'c'.repeat(64), symbols: [{ name: 'changed', line: 1 }] };
    try {
      await collectInterfaceEdits({ ...scope, toolCalls: [{ editedPaths: ['a.ts'] }] },
        async () => ({ path: sourceChange.path, base: sourceChange.base, checks: [], changes: [], sourceChange }), env);
      const failure: any = { ...scope, toolCalls: [{ tool: 'testing:run' }] };
      await collectInterfaceEdits(failure, undefined, env);
      expect(failure.incidentAttribution.recentEdits).toEqual([{ ...sourceChange,
        workspace: 'ws', harness: 'h', agentId: 'su-observer' }]);
      const foreign: any = { ...scope, harness: 'other', toolCalls: [] };
      await collectInterfaceEdits(foreign, undefined, env);
      expect(foreign.incidentAttribution).toBeUndefined();
      const expired: any = { ...scope, toolCalls: [{ editedPaths: ['a.ts'] }] };
      await collectInterfaceEdits(expired, async () => ({ path: sourceChange.path, base: sourceChange.base, checks: [], changes: [],
        sourceChange: { ...sourceChange, at: Date.now() - 86_400_001 } }), env);
      expect(expired.incidentAttribution.recentEdits[0].at).toBe(sourceChange.at);
    } finally { rmSync(env.PAPERCUSP_HOME, { recursive: true, force: true }); }
  });
});

const BATCH = {
  hook_event_name: 'PostToolBatch',
  session_id: 's-1',
  tool_calls: [
    {
      tool_name: 'Grep',
      tool_input: { pattern: 'WI-6512', path: 'packages' },
      tool_response: 'No matches found',
      tool_use_id: 't1',
    },
  ],
};

let server: Server;
let baseUrl = '';
let lastBody: Record<string, unknown> | null = null;
const receivedBody = (): Record<string, unknown> | null => lastBody;
let nextResponse: { status?: number; body?: unknown } = { body: { ok: true, text: '' } };

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      try {
        lastBody = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        lastBody = null;
      }
      res.writeHead(nextResponse.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(nextResponse.body ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

// Async spawn + EPIPE-tolerant stdin: see ./spawn-hook.ts, which owns both invariants.
function runHook(
  input: unknown,
  env: Record<string, string | undefined> = {},
): Promise<{ stdout: string; status: number | null }> {
  return runHookProcess('bash', [SCRIPT], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: Object.fromEntries(
      Object.entries({
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PAPERCUSP_SID: SID,
        PAPERCUSP_OPERATOR_URL: baseUrl,
        PAPERCUSP_WORKSPACE: 'ws-test',
        PAPERCUSP_HARNESS_SLUG: 'papercusp',
        http_proxy: undefined,
        https_proxy: undefined,
        ...env,
      }).filter(([, v]) => v !== undefined),
    ) as Record<string, string>,
  });
}

function outputOf(out: { stdout: string }): Record<string, unknown> | null {
  const line = out.stdout.trim();
  if (!line) return null;
  return (JSON.parse(line) as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput ?? null;
}

describe('posttoolbatch-midturn-context.sh', () => {
  it('emits hookEventName PostToolBatch — NOT PreToolUse, which silently injects nothing (D-027)', async () => {
    nextResponse = { body: { ok: true, text: 'WI-6512 is documented in three docstrings' } };
    const out = await runHook(BATCH);

    const hookOutput = outputOf(out);
    expect(hookOutput).toMatchObject({
      hookEventName: 'PostToolBatch',
      additionalContext: 'WI-6512 is documented in three docstrings',
    });
    // The load-bearing negatives: wrong event, or any permission vote.
    expect(hookOutput!.hookEventName).not.toBe('PreToolUse');
    expect(hookOutput).not.toHaveProperty('permissionDecision');
    expect(hookOutput).not.toHaveProperty('permissionDecisionReason');
  });

  it('POSTs a batch digest carrying the tool RESPONSE, not just the input', async () => {
    // Firing after the tools ran is the point: an empty result is the strongest
    // "about to re-derive something" signal available, and only exists here.
    lastBody = null;
    nextResponse = { body: { ok: true, text: 'x' } };
    await runHook(BATCH);
    expect(lastBody).toMatchObject({
      owner: SID,
      workspace: 'ws-test',
      harness: 'papercusp',
      toolCalls: [{ tool: 'Grep', toolResponse: 'No matches found' }],
    });
  });

  it('CLAMPS a huge tool_response so the transport is never the cost', async () => {
    lastBody = null;
    nextResponse = { body: { ok: true, text: 'x' } };
    await runHook({
      tool_calls: [{ tool_name: 'Read', tool_input: { file_path: '/a.ts' }, tool_response: 'y'.repeat(100_000) }],
    });
    const calls = (receivedBody() as { toolCalls: { toolResponse: string }[] }).toolCalls;
    expect(calls[0]!.toolResponse.length).toBeLessThanOrEqual(400);
  });

  it('caps how many calls of one batch it ships', async () => {
    lastBody = null;
    nextResponse = { body: { ok: true, text: 'x' } };
    await runHook({
      tool_calls: Array.from({ length: 40 }, (_, i) => ({
        tool_name: 'Grep',
        tool_input: { pattern: `p${i}` },
        tool_response: 'ok',
      })),
    });
    expect((receivedBody() as { toolCalls: unknown[] }).toolCalls.length).toBeLessThanOrEqual(12);
  });

  it('no PAPERCUSP_SID → silent no-op, exit 0 (psu sessions only)', async () => {
    const out = await runHook(BATCH, { PAPERCUSP_SID: undefined });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  it('kill switch disables it without touching the operator', async () => {
    lastBody = null;
    const out = await runHook(BATCH, { PAPERCUSP_MID_TURN_CONTEXT: 'off' });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
    expect(lastBody).toBeNull();
  });

  it('empty text from the endpoint → silent (the common case: epoch dedup said nothing new)', async () => {
    nextResponse = { body: { ok: true, text: '' } };
    const out = await runHook(BATCH);
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  it('operator down → fail-open silent, exit 0 (never exit 2 — that stops the loop)', async () => {
    const out = await runHook(BATCH, { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1', PAPERCUSP_MCP_PROXY_PORT: '1' });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  it('operator 500 → fail-open silent, exit 0', async () => {
    nextResponse = { status: 500, body: { error: 'boom' } };
    const out = await runHook(BATCH);
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  it('malformed stdin JSON → fail-open silent, exit 0', async () => {
    const out = await runHook('not-json{');
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  it('a batch with no tool_calls → silent, and never calls the operator', async () => {
    lastBody = null;
    nextResponse = { body: { ok: true, text: 'should not be reached' } };
    const out = await runHook({ hook_event_name: 'PostToolBatch', tool_calls: [] });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
    expect(lastBody).toBeNull();
  });
});
