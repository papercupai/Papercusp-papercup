/**
 * userpromptsubmit-memory.sh — turn-start memory delta at prompt submit
 * (memory-delivery-unification-2026-07-12 P-003a).
 *
 * Drives the shell hook exactly as Claude Code does — the UserPromptSubmit
 * JSON on stdin, an additionalContext JSON (or silence) on stdout — against a
 * HERMETIC local HTTP stub standing in for the operator
 * (PAPERCUSP_OPERATOR_URL), so the suite touches no real operator. Fail-open
 * everywhere: the hook must NEVER block a prompt (exit ≠ 0) whatever the
 * input or the operator's health.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHookProcess } from './spawn-hook';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'userpromptsubmit-memory.sh');
const SID = 'su-hook-test';
const LONG_PROMPT = 'please investigate the flaky epoch ledger integration on the papercusp harness';

let server: Server;
let baseUrl = '';
let lastBody: Record<string, unknown> | null = null;
let nextResponse: { status?: number; body?: unknown } = { body: { ok: true, text: '' } };

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', async () => {
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
        // A loopback pin also falls back to the local MCP proxy (inject/core.mjs
        // operatorBases, WI-10005007; default port 9071). Point that fallback at
        // the stub too, or a case that cannot reach the stub silently reaches the
        // REAL operator through the box's proxy and gets a live Orientation back.
        PAPERCUSP_MCP_PROXY_PORT: new URL(baseUrl).port,
        PAPERCUSP_WORKSPACE: 'ws-test',
        PAPERCUSP_HARNESS_SLUG: 'papercusp',
        // Never inherit real proxy env into the hermetic call.
        http_proxy: undefined,
        https_proxy: undefined,
        ...env,
      }).filter(([, v]) => v !== undefined),
    ) as Record<string, string>,
  });
}

function contextOf(out: { stdout: string }): string | null {
  const line = out.stdout.trim();
  if (!line) return null;
  const parsed = JSON.parse(line) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return parsed.hookSpecificOutput?.additionalContext ?? null;
}

describe('userpromptsubmit-memory.sh', () => {
  it('no PAPERCUSP_SID → silent no-op, exit 0', async () => {
    const out = await runHook({ prompt: LONG_PROMPT }, { PAPERCUSP_SID: undefined });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  it('memory kill switch keeps the CTRL check enrolled', async () => {
    lastBody = null;
    nextResponse = { body: { ok: true, text: `⟦CTRL:transition⟧ {"generation":2,"targetOwnerId":"${SID}"}` } };
    const out = await runHook({ prompt: LONG_PROMPT }, { PAPERCUSP_TURN_START_MEMORY: 'off' });
    expect(out.status).toBe(0);
    expect(contextOf(out)).toContain('CTRL:transition');
    expect(lastBody).toMatchObject({ memoryEnabled: false });
  });

  it('low-signal prompt still checks for a pending CTRL transition', async () => {
    lastBody = null;
    nextResponse = { body: { ok: true, text: `⟦CTRL:full-resync⟧ {"generation":4,"targetOwnerId":"${SID}"}` } };
    const out = await runHook({ prompt: 'continue' });
    expect(out.status).toBe(0);
    expect(contextOf(out)).toContain('CTRL:full-resync');
    expect(lastBody).toMatchObject({ owner: SID, prompt: 'continue', memoryEnabled: true });
  });

  it('emits additionalContext with the endpoint text; POST carries owner/prompt/dims', async () => {
    nextResponse = { body: { ok: true, text: '## Relevant memory\n\n- [ref] fact' } };
    const out = await runHook({ prompt: LONG_PROMPT });
    expect(out.status).toBe(0);
    expect(contextOf(out)).toContain('## Relevant memory');
    expect(lastBody).toMatchObject({
      owner: SID,
      prompt: LONG_PROMPT,
      workspace: 'ws-test',
      harness: 'papercusp',
    });
  });

  it('empty text from the endpoint → silent', async () => {
    nextResponse = { body: { ok: true, text: '' } };
    const out = await runHook({ prompt: LONG_PROMPT });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  it('operator down (unreachable port) → fail-open silent, exit 0', async () => {
    const out = await runHook(
      { prompt: LONG_PROMPT },
      // Both transports down: the pin AND its loopback proxy fallback. Leaving the
      // fallback on the real :9071 made this case pass or fail with the live box.
      { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1', PAPERCUSP_MCP_PROXY_PORT: '1' },
    );
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  it('malformed stdin JSON → fail-open silent, exit 0', async () => {
    const out = await runHook('not-json{');
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });
});
