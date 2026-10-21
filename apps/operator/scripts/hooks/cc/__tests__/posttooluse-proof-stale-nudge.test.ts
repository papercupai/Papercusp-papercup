/**
 * posttooluse-proof-stale-nudge — P-040 of review-system-rework-reduction-2026-09-23 (R-9):
 * tell the editor, AT THE EDIT, which live proof it just staled, and tell each peer holder
 * once per edit burst.
 *
 * The real path is driven end to end: a real temp git repo, a real edited file, the real
 * hook process reading real stdin, and an in-test HTTP server standing in for the operator
 * (it answers plans:evidence-measuring-paths and records coord:send). Reading the code gives
 * a confident answer about what fires; only running it shows what actually does.
 *
 * The burst gate is also proven falsifiable on a COPY of the hook outside the tree (never the
 * tracked file — git-sync sweeps the shared tree and would commit an in-tree mutant).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatNotice, harnessFromEnv, parseToolResult, planBurst } from '../posttooluse-proof-stale-nudge.mjs';

// Overridable so scripts/mutation-probe.sh can point the spawned hook at a mutated COPY
// (copy-out tier) and never dirty the tracked file.
const HOOK =
  process.env.PROOF_STALE_NUDGE_HOOK ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'posttooluse-proof-stale-nudge.mjs');
const EDITOR = 'su-editor01-0000-0000-0000-000000000000';
const PEER = 'su-peer0001-0000-0000-0000-000000000000';
const HARNESS = 'test-harness';
const BOUND = 'lib/bound.ts';
const UNBOUND = 'lib/unbound.ts';

const CLAUSES = [
  {
    plan: 'plan-a',
    clause: 'RSR-P-016-A@2',
    bar: false,
    workItemId: 'WI-1',
    holder: PEER,
    holderSource: 'assignee',
    kinds: ['test'],
    bindingIds: [10506],
    bindingCount: 1,
    matched: [BOUND],
    remeasure: {
      bindingId: 10506,
      rerunFirst: true,
      call: {
        tool: 'plans:bind-spec-evidence',
        args: { harness: 'papercusp', slug: 'plan-a', supersedeAtRevision: true, binding: { specId: 'RSR-P-016-A' } },
      },
    },
  },
  {
    plan: 'plan-a',
    clause: 'AUTO-BAR-R-5-P-016@1',
    bar: true,
    workItemId: 'WI-2',
    holder: EDITOR,
    holderSource: 'assignee',
    kinds: ['test'],
    bindingIds: [10510],
    bindingCount: 1,
    matched: [BOUND],
    remeasure: { bindingId: 10510, rerunFirst: true },
  },
];

// PEER2's 30 clauses fell off the budget-truncated clause list (a hot file) — it appears
// ONLY in the holders summary, and must still be told.
const PEER2 = 'su-peer0002-0000-0000-0000-000000000000';
const HOLDERS = [
  { holder: PEER2, clauses: 30, bars: 0, workItems: ['WI-9'], sample: ['RSR-P-200-A@1', 'RSR-P-201-A@1'] },
  { holder: PEER, clauses: 1, bars: 0, workItems: ['WI-1'], sample: ['RSR-P-016-A@2'] },
  { holder: EDITOR, clauses: 1, bars: 1, workItems: ['WI-2'], sample: ['AUTO-BAR-R-5-P-016@1'] },
];

interface Seen {
  tool: string;
  args: Record<string, unknown>;
  client: string | null;
}

let server: Server;
let port = 0;
const seen: Seen[] = [];
let tmpRoot = '';
let repo = '';
let clone = '';
let home = '';

function sse(res: ServerResponse, data: unknown) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(`:stream-open\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(data) }] } })}\n\n`);
}

function handle(req: IncomingMessage, res: ServerResponse) {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const rpc = JSON.parse(body);
    const { name, arguments: args } = rpc.params;
    seen.push({ tool: name, args, client: new URL(req.url ?? '/', 'http://x').searchParams.get('client') });
    if (name === 'plans:evidence-measuring-paths') {
      // The real tool's contract (harnessArg): an operator-scope call WITHOUT `harness` is
      // refused `harness_required` — 608 such refusals/72h before WI-10004549. Enforcing it
      // here makes every advisory assertion below prove the hook supplies the harness.
      if (typeof args.harness !== 'string' || !args.harness) {
        sse(res, { ok: false, error: 'No harness specified. Pass `harness` or run in a harness-scoped session.' });
        return;
      }
      const bound = (args.paths as string[]).includes(BOUND) && args.checkoutRoot === repo;
      sse(res, bound ? { ok: true, clauses: CLAUSES, totalClauses: 32, holders: HOLDERS } : { ok: true, clauses: [], totalClauses: 0, holders: [] });
    } else if (name === 'coord:send') {
      sse(res, { ok: true, results: [{ ok: true, msg_id: 'coord-send-test' }] });
    } else {
      sse(res, { ok: false, error: `unknown tool ${name}` });
    }
  });
}

// `harness: null` runs the hook in a session with NO harness slug in its env.
function runHook(
  file: string,
  opts: { hook?: string; operatorUrl?: string; harness?: string | null; editRoot?: string } = {},
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolveRun) => {
    const editRoot = opts.editRoot ?? repo;
    const env = { ...process.env };
    delete env.PAPERCUSP_LOCK_SID;
    delete env.CODEX_HOME;
    // Pinned, never inherited: the developer's own session exports PAPERCUSP_HARNESS_SLUG.
    delete env.PAPERCUSP_HARNESS_SLUG;
    if (opts.harness !== null) env.PAPERCUSP_HARNESS_SLUG = opts.harness ?? HARNESS;
    Object.assign(env, {
      HOME: home,
      PAPERCUSP_SID: EDITOR,
      PAPERCUSP_OPERATOR_URL: opts.operatorUrl ?? `http://127.0.0.1:${port}`,
      PAPERCUSP_STAGING_OPERATOR_URL: opts.operatorUrl ?? `http://127.0.0.1:${port}`,
    });
    const child = spawn(process.execPath, [opts.hook ?? HOOK], { cwd: editRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('close', (code) => resolveRun({ code, out }));
    child.stdin.end(
      JSON.stringify({ tool_name: 'Edit', cwd: editRoot, tool_input: { file_path: join(editRoot, file) }, tool_response: { success: true } }),
    );
  });
}

function advisoryOf(out: string): string | null {
  if (!out.trim()) return null;
  return JSON.parse(out).hookSpecificOutput.additionalContext as string;
}

function resetState() {
  rmSync(join(repo, '.papercusp'), { recursive: true, force: true });
  rmSync(join(clone, '.papercusp'), { recursive: true, force: true });
  seen.length = 0;
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
  tmpRoot = mkdtempSync(join(tmpdir(), 'proof-stale-nudge-'));
  repo = join(tmpRoot, 'repo');
  clone = join(tmpRoot, 'clone');
  home = join(tmpRoot, 'home');
  mkdirSync(join(repo, 'lib'), { recursive: true });
  mkdirSync(join(home, '.papercusp'), { recursive: true });
  writeFileSync(join(home, '.papercusp', 'superuser-token'), 'test-token\n');
  execFileSync('git', ['init', '-q', repo]);
  mkdirSync(join(clone, 'lib'), { recursive: true });
  execFileSync('git', ['init', '-q', clone]);
  writeFileSync(join(repo, BOUND), 'export const x = 1;\n');
  writeFileSync(join(repo, UNBOUND), 'export const y = 1;\n');
  writeFileSync(join(clone, BOUND), 'export const x = 1;\n');
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('posttooluse-proof-stale-nudge (real hook process)', () => {
  it('editing a bound source path yields the advisory naming that spec, its BAR and holders', async () => {
    resetState();
    const { code, out } = await runHook(BOUND);
    expect(code).toBe(0);
    const msg = advisoryOf(out);
    expect(msg).not.toBeNull();
    expect(msg).toContain('PROOF STALED');
    expect(msg).toContain(BOUND);
    expect(msg).toContain('RSR-P-016-A@2');
    expect(msg).toContain('BAR AUTO-BAR-R-5-P-016@1');
    expect(msg).toContain('holder su-peer0001');
    expect(msg).toContain('holder su-editor01 (you)');
    expect(msg).toContain('plans:bind-spec-evidence {');
    expect(msg).toContain('Holders across all 32 clause(s): su-peer0002 30, su-peer0001 1, su-editor01 (you) 1 (1 BAR).');
    const lookup = seen.find((s) => s.tool === 'plans:evidence-measuring-paths');
    // WI-10004549: the lookup carries the session's harness — without it the real tool refuses.
    expect(lookup?.args).toEqual({ harness: HARNESS, checkoutRoot: repo, paths: [BOUND] });
    expect(lookup?.client).toBe(EDITOR);
  });

  it('editing the same relative path in a different checkout does not stale canonical proof', async () => {
    resetState();
    const { code, out } = await runHook(BOUND, { editRoot: clone });
    expect(code).toBe(0);
    expect(out.trim()).toBe('');
    const lookup = seen.find((s) => s.tool === 'plans:evidence-measuring-paths');
    expect(lookup?.args).toEqual({ harness: HARNESS, checkoutRoot: realpathSync(clone), paths: [BOUND] });
    expect(seen.filter((s) => s.tool === 'coord:send')).toHaveLength(0);
  });

  it('a session with NO harness slug skips silently: no operator call, no breaker, no advisory (WI-10004549)', async () => {
    resetState();
    const { code, out } = await runHook(BOUND, { harness: null });
    expect(code).toBe(0);
    expect(out.trim()).toBe('');
    // The doomed call was never made, so no `harness_required` tool-call-failure row exists to file.
    expect(seen).toHaveLength(0);
    // And the skip is not a failure: it must not trip the operator-fault circuit breaker.
    expect(existsSync(join(repo, '.papercusp', 'scratch', `proof-stale-nudge.${EDITOR}.json`))).toBe(false);
  });

  it('an unbound path yields no advisory and no notice', async () => {
    resetState();
    const { code, out } = await runHook(UNBOUND);
    expect(code).toBe(0);
    expect(advisoryOf(out)).toBeNull();
    expect(seen.filter((s) => s.tool === 'coord:send')).toHaveLength(0);
  });

  it('each peer holder gets ONE notice per edit burst, the editor none, and the advisory does not repeat', async () => {
    resetState();
    const first = advisoryOf((await runHook(BOUND)).out);
    const second = advisoryOf((await runHook(BOUND)).out);
    expect(first).toContain('Peer holders told once for this edit burst: su-peer0002, su-peer0001');
    expect(second).toBeNull();
    const sends = seen.filter((s) => s.tool === 'coord:send');
    // PEER2 is told although none of its clauses made the truncated list.
    expect(sends.map((s) => (s.args.to as string[])[0])).toEqual([PEER2, PEER]);
    expect(sends[0].args).toMatchObject({ expects: 'none', body: [{ forYouBecause: { relation: 'owns', ref: 'WI-9' } }] });
    // The second edit reused the 2-minute cache: one lookup for the whole burst.
    expect(seen.filter((s) => s.tool === 'plans:evidence-measuring-paths')).toHaveLength(1);
  });

  it('fails open and silent when the operator is unreachable, then trips the breaker', async () => {
    resetState();
    const dead = 'http://127.0.0.1:1';
    const { code, out } = await runHook(BOUND, { operatorUrl: dead });
    expect(code).toBe(0);
    expect(out.trim()).toBe('');
    const state = JSON.parse(readFileSync(join(repo, '.papercusp', 'scratch', `proof-stale-nudge.${EDITOR}.json`), 'utf8'));
    expect(typeof state.breakerAtMs).toBe('number');
  });

  it('the burst gate is falsifiable: a copy that always opens a burst re-notifies (caught)', async () => {
    const mutantDir = mkdtempSync(join(tmpdir(), 'proof-stale-nudge-mutant-'));
    const mutant = join(mutantDir, 'posttooluse-proof-stale-nudge.mjs');
    copyFileSync(HOOK, mutant);
    copyFileSync(join(dirname(HOOK), 'pc_home.mjs'), join(mutantDir, 'pc_home.mjs'));
    const src = readFileSync(mutant, 'utf8');
    const gate = 'const opened = !prior || nowMs - prior.lastEditAtMs > gapMs;';
    expect(src).toContain(gate);
    writeFileSync(mutant, src.replace(gate, 'const opened = true;'));
    try {
      resetState();
      await runHook(BOUND, { hook: mutant });
      await runHook(BOUND, { hook: mutant });
      // Two peers × two edits: the burst no longer suppresses the repeat.
      expect(seen.filter((s) => s.tool === 'coord:send')).toHaveLength(4);
    } finally {
      rmSync(mutantDir, { recursive: true, force: true });
    }
  });
});

describe('posttooluse-proof-stale-nudge pure parts', () => {
  const NOW = 1_790_000_000_000;

  it('a quiet gap longer than the burst window re-opens the burst', () => {
    const one = planBurst({ state: {}, holders: HOLDERS, editor: EDITOR, path: BOUND, nowMs: NOW });
    expect(one.advisoryDue).toBe(true);
    expect([...one.notices.keys()]).toEqual([PEER2, PEER]);
    const within = planBurst({ state: one.next, holders: HOLDERS, editor: EDITOR, path: BOUND, nowMs: NOW + 9 * 60_000 });
    expect(within.advisoryDue).toBe(false);
    expect(within.notices.size).toBe(0);
    // Every edit extends the burst: 9 + 9 minutes of edits is still one burst.
    const extended = planBurst({ state: within.next, holders: HOLDERS, editor: EDITOR, path: BOUND, nowMs: NOW + 18 * 60_000 });
    expect(extended.notices.size).toBe(0);
    const later = planBurst({ state: extended.next, holders: HOLDERS, editor: EDITOR, path: BOUND, nowMs: NOW + 29 * 60_000 });
    expect(later.advisoryDue).toBe(true);
    expect([...later.notices.keys()]).toEqual([PEER2, PEER]);
    // A different file is its own burst: editing it tells the same holder about THAT file.
    const other = planBurst({ state: one.next, holders: HOLDERS, editor: EDITOR, path: 'lib/other.ts', nowMs: NOW + 60_000 });
    expect([...other.notices.keys()]).toEqual([PEER2, PEER]);
  });

  it('harnessFromEnv reads PAPERCUSP_HARNESS_SLUG and rejects unset / blank / malformed values', () => {
    expect(harnessFromEnv({ PAPERCUSP_HARNESS_SLUG: 'papercusp' })).toBe('papercusp');
    expect(harnessFromEnv({ PAPERCUSP_HARNESS_SLUG: '  papercusp  ' })).toBe('papercusp');
    expect(harnessFromEnv({})).toBeNull();
    expect(harnessFromEnv({ PAPERCUSP_HARNESS_SLUG: '' })).toBeNull();
    expect(harnessFromEnv({ PAPERCUSP_HARNESS_SLUG: '   ' })).toBeNull();
    expect(harnessFromEnv({ PAPERCUSP_HARNESS_SLUG: '../etc' })).toBeNull();
    expect(harnessFromEnv({ PAPERCUSP_HARNESS_SLUG: 'a b' })).toBeNull();
  });

  it('the peer notice fits the 600-char inbox body cap', () => {
    const holder = {
      holder: PEER,
      clauses: 34,
      bars: 10,
      workItems: ['WI-10000432', 'WI-10000434', 'WI-10000435'],
      sample: ['AUTO-BAR-R-06-P-009@6', 'AUTO-BAR-R-02-P-009@6'],
    };
    const { summary, text } = formatNotice({ editor: EDITOR, path: 'packages/operator-core/lib/very/long/path/to/a/module.ts', holder });
    expect(text.length).toBeLessThanOrEqual(600);
    expect(summary.length).toBeLessThanOrEqual(280);
    expect(text).toContain('34 clause(s) incl. 10 BAR');
    expect(text).toContain('plans:evidence-measuring-paths');
  });

  it('parses SSE-framed and plain JSON tool results, and surfaces a tool error', () => {
    const data = { ok: true, clauses: [] };
    const framed = `:stream-open\n\nevent: message\ndata: ${JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(data) }] } })}\n`;
    expect(parseToolResult(framed)).toEqual({ ok: true, data });
    expect(parseToolResult(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(data) }] } }))).toEqual({ ok: true, data });
    expect(parseToolResult(JSON.stringify({ error: { message: 'Unknown tool' } }))).toMatchObject({ ok: false });
    expect(parseToolResult('not json')).toMatchObject({ ok: false });
  });
});
