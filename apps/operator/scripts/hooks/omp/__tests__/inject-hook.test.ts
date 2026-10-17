/**
 * inject-hook.test.ts — P-006 coverage for the OMP context-injection parity
 * work (plan omp-context-injection-parity-2026-08-09, D-001 + D-002).
 *
 * Two subjects:
 *   - the PURE adapter (../../inject/adapters/omp.mjs): portForEvent / parse /
 *     render, including the clamps that D-001 declares contract rather than
 *     tuning, and the toolCallId correlation that omp forces on us.
 *   - the omp client-native ARTIFACT (../inject-hook.ts): the fail-silent
 *     invariants. D-001 invariant 1 says any failure must inject NOTHING and
 *     surface NOTHING; on omp the concrete form of "exit 0 and empty output" is
 *     "runDispatcher resolves null and never rejects", because the dispatcher is
 *     a child process whose stdout we consume rather than our own exit code.
 *
 * ⚠ THE CALIBRATION TEST IS LOAD-BEARING — read before adding cases.
 * Every fail-silent assertion here has the shape `expect(result).toBeNull()`,
 * which is ALSO what a `runDispatcher` that was deleted, stubbed to
 * `return null`, or short-circuited by a bad env check would produce. A suite of
 * only-null assertions cannot tell a working guard from a removed one, and would
 * stay green through exactly the regression it exists to catch. The
 * "CALIBRATION" test below drives a real stub dispatcher end-to-end and asserts
 * a NON-null result; if it ever fails, treat every null assertion in this file
 * as vacuous until it passes again.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// @ts-ignore — pure JS adapter, no .d.ts; the dispatcher's frozen CLI contract is the seam.
import adapter, { portForEvent, parse, render } from '../../inject/adapters/omp.mjs';
import register, {
  MISS_LOG_BASENAME,
  MISS_LOG_MAX_BYTES,
  PENDING_MAX_AGE_MS,
  PORT_TIMEOUT_MS,
  SUBPROCESS_KILL_MARGIN_MS,
  appendBlock,
  clearMidTurnStash,
  noteInjectionMiss,
  papercuspHomeDir,
  resolveDispatcherPath,
  runDispatcher,
  stashMidTurn,
  takeMidTurn,
  shouldSkip,
} from '../inject-hook';
import { stashAdvisory } from '../non-preempting-delivery';

// ── fixtures ────────────────────────────────────────────────────────────────

let dir: string;
/** A stub standing in for the shared index.mjs. Echoes a fixed payload and,
 *  when asked, records the stdin it was fed so we can assert the wire shape. */
let echoDispatcher: string;
let stdinRecorder: string;
let recordedStdinFile: string;
let crashDispatcher: string;
let hangDispatcher: string;
let whitespaceDispatcher: string;

// NODE_ENV is REQUIRED on NodeJS.ProcessEnv in this tsconfig — not by @types/node
// (whose ProcessEnv is a bare `extends Dict<string>`) but by next/types/global.d.ts,
// which is still in apps/operator's ambient type graph even though the standalone
// Next webapp is retired. Without it every `env:` literal below is TS2741
// ("Property 'NODE_ENV' is missing"), which is the same systemic class already
// sitting in the tsc baseline for ~100 pre-existing sites. Typing the fixture here
// keeps all of them satisfied from ONE place; the code under test reads only
// PAPERCUSP_* keys, so the added value is inert.
const SID_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  PAPERCUSP_SID: 'su-test-0001',
  PAPERCUSP_WORKSPACE: 'ws',
  PAPERCUSP_HARNESS_SLUG: 'papercusp',
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'omp-inject-hook-'));

  echoDispatcher = join(dir, 'echo.mjs');
  writeFileSync(echoDispatcher, `process.stdout.write('INJECTED CONTEXT');\n`);

  recordedStdinFile = join(dir, 'stdin.json');
  stdinRecorder = join(dir, 'record.mjs');
  writeFileSync(
    stdinRecorder,
    `import { writeFileSync } from 'node:fs';
let buf = '';
process.stdin.on('data', c => { buf += c; });
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(recordedStdinFile)}, JSON.stringify({ stdin: buf, argv: process.argv.slice(2) }));
  process.stdout.write('RECORDED');
});
`,
  );

  crashDispatcher = join(dir, 'crash.mjs');
  writeFileSync(crashDispatcher, `process.stdout.write('partial'); process.exit(3);\n`);

  hangDispatcher = join(dir, 'hang.mjs');
  writeFileSync(hangDispatcher, `setInterval(() => {}, 1000);\n`);

  whitespaceDispatcher = join(dir, 'ws.mjs');
  writeFileSync(whitespaceDispatcher, `process.stdout.write('   \\n  ');\n`);

  for (const f of [echoDispatcher, stdinRecorder, crashDispatcher, hangDispatcher, whitespaceDispatcher]) {
    chmodSync(f, 0o755);
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ⚠ PAPERCUSP_HOME IS PINNED HERE ON PURPOSE — do not drop it as redundant.
// SID_ENV deliberately carries no home, and today every envWith() case resolves
// a dispatcher via the explicit pin, so nothing reaches the miss-log write.
// That is a property of the CURRENT wiring, not a guarantee: the moment anyone
// instruments the spawn-error / timeout / non-zero-exit paths (all of which run
// under envWith), an unpinned home would send those writes into the developer's
// REAL ~/.papercusp. That is the same isolation-escape class that made an
// earlier unit test write a live row into production telemetry
// (EI-20001110634702380). Pinning here disarms it once, mechanically, instead
// of relying on the next author noticing.
const envWith = (dispatcher: string, extra: Record<string, string> = {}) => ({
  ...SID_ENV,
  PAPERCUSP_HOME: join(dir, 'home'),
  PAPERCUSP_INJECT_DISPATCHER: dispatcher,
  ...extra,
});

// ── adapter: event mapping ──────────────────────────────────────────────────

describe('adapters/omp.mjs — portForEvent', () => {
  it('maps before_agent_start to turn-start and turn_end to mid-turn', () => {
    expect(portForEvent('before_agent_start')).toBe('turn-start');
    expect(portForEvent('turn_end')).toBe('mid-turn');
  });

  it('does NOT map tool_result to mid-turn', () => {
    // tool_result fires once per individual call. Mapping it would over-fire on
    // every tool and mis-shape the 12-call batch digest D-001 specifies. The
    // batch analogue is turn_end, which carries toolResults[] for the turn.
    expect(portForEvent('tool_result')).toBeNull();
  });

  it('ignores unknown/unsubscribed events rather than guessing a port', () => {
    for (const e of ['turn_start', 'agent_start', 'session_start', 'context', '']) {
      expect(portForEvent(e)).toBeNull();
    }
  });

  it('exposes the D-001 adapter surface', () => {
    expect(adapter.client).toBe('omp');
    expect(typeof adapter.portForEvent).toBe('function');
    expect(typeof adapter.parse).toBe('function');
    expect(typeof adapter.render).toBe('function');
  });
});

// ── adapter: parse ──────────────────────────────────────────────────────────

describe('adapters/omp.mjs — parse (turn-start)', () => {
  const withSid = <T>(fn: () => T): T => {
    const prev = { ...process.env };
    Object.assign(process.env, SID_ENV);
    try {
      return fn();
    } finally {
      for (const k of Object.keys(SID_ENV)) delete process.env[k as keyof typeof SID_ENV];
      Object.assign(process.env, prev);
    }
  };

  it('builds an InjectionRequest carrying client=omp and the per-session owner', () => {
    const req = withSid(() => parse('turn-start', { type: 'before_agent_start', prompt: 'hello' }));
    expect(req).toMatchObject({
      owner: 'su-test-0001',
      workspace: 'ws',
      harness: 'papercusp',
      client: 'omp',
      prompt: 'hello',
    });
    // D-001's NEW/REQUIRED field — the whole point of recording which client
    // received an injection. A request without it is unattributable.
    expect(req?.client).toBe('omp');
  });

  it('clamps the prompt to 4000 chars (D-001 invariant 5 — contract, not tuning)', () => {
    const req = withSid(() => parse('turn-start', { prompt: 'x'.repeat(9000) }));
    expect(req?.prompt).toHaveLength(4000);
  });

  it('returns null for an empty/whitespace prompt — no signal, spend nothing', () => {
    expect(withSid(() => parse('turn-start', { prompt: '' }))).toBeNull();
    expect(withSid(() => parse('turn-start', { prompt: '   ' }))).toBeNull();
    expect(withSid(() => parse('turn-start', {}))).toBeNull();
  });

  it('returns null when PAPERCUSP_SID is absent (invariant 3 — not a psu session)', () => {
    const prev = process.env.PAPERCUSP_SID;
    delete process.env.PAPERCUSP_SID;
    try {
      expect(parse('turn-start', { prompt: 'hello' })).toBeNull();
    } finally {
      if (prev !== undefined) process.env.PAPERCUSP_SID = prev;
    }
  });
});

describe('adapters/omp.mjs — parse (mid-turn)', () => {
  const turnEnd = (toolResults: unknown[], toolCalls: unknown[] = []) => ({
    type: 'turn_end',
    turnIndex: 1,
    message: { role: 'assistant', content: toolCalls },
    toolResults,
  });

  const withSid = <T>(fn: () => T): T => {
    const prev = { ...process.env };
    Object.assign(process.env, SID_ENV);
    try {
      return fn();
    } finally {
      Object.assign(process.env, prev);
    }
  };

  it('correlates a tool INPUT from message.content onto its RESULT by toolCallId', () => {
    // omp splits what claude delivers as one record: the result carries the
    // output, the assistant message carries the arguments. If this join breaks,
    // every digest silently ships an empty toolInput and the server's query
    // quality degrades with nothing failing.
    const req = withSid(() =>
      parse(
        'mid-turn',
        turnEnd(
          [{ toolCallId: 'tc-1', toolName: 'bash', content: [{ type: 'text', text: 'total 12' }] }],
          [{ type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'ls -la' } }],
        ),
      ),
    );
    expect(req?.toolCalls).toEqual([
      { tool: 'bash', toolInput: JSON.stringify({ command: 'ls -la' }), toolResponse: 'total 12' },
    ]);
  });

  it('replays D-012\'s exact 00:06:17Z XD pair and preserves both correlated content envelopes', () => {
    const path = 'xd://mcp__papercusp_su_tools_invoke';
    const inbox = { path, content: '{"args": {}, "name": "coord:inbox"}' };
    const next = { path, content: '{"args": {}, "name": "scheduler:get_next"}' };
    const req = withSid(() =>
      parse(
        'mid-turn',
        turnEnd(
          [
            {
              toolCallId: 'call_526485',
              toolName: 'write',
              content: [{ type: 'text', text: '{"owner_id":"su-0e500929"}' }],
            },
            {
              toolCallId: 'call_526498',
              toolName: 'write',
              content: [{ type: 'text', text: 'Error: invalid_input: harness is required' }],
            },
          ],
          [
            { type: 'toolCall', id: 'call_526485', name: 'write', arguments: inbox },
            { type: 'toolCall', id: 'call_526498', name: 'write', arguments: next },
          ],
        ),
      ),
    );

    expect(req?.toolCalls).toEqual([
      {
        tool: 'write',
        toolInput: JSON.stringify(inbox),
        toolResponse: '{"owner_id":"su-0e500929"}',
      },
      {
        tool: 'write',
        toolInput: JSON.stringify(next),
        toolResponse: 'Error: invalid_input: harness is required',
      },
    ]);
    expect(req?.toolCalls?.every((call: { toolInput: string }) => call.toolInput.length <= 400)).toBe(true);
  });

  it('still emits a result whose call cannot be correlated (output alone is signal)', () => {
    const req = withSid(() =>
      parse('mid-turn', turnEnd([{ toolCallId: 'orphan', toolName: 'grep', content: [{ type: 'text', text: 'hit' }] }])),
    );
    expect(req?.toolCalls).toEqual([{ tool: 'grep', toolInput: '', toolResponse: 'hit' }]);
  });
  it('keeps edited paths from full OMP arguments before clamping recall input', () => {
    const req = withSid(() => parse('mid-turn', turnEnd(
      [{ toolCallId: 'edit-1', toolName: 'edit', content: [{ type: 'text', text: 'ok' }] }],
      [{ type: 'toolCall', id: 'edit-1', name: 'edit', arguments: { oldText: 'x'.repeat(900), path: '/repo/lib/target.ts' } }],
    )));
    expect(req?.toolCalls?.[0]).toMatchObject({ editedPaths: ['/repo/lib/target.ts'] });
    expect(req?.toolCalls?.[0].toolInput).toHaveLength(400);
  });

  it('clamps to 12 calls and 400 chars per field', () => {
    const results = Array.from({ length: 30 }, (_, i) => ({
      toolCallId: `tc-${i}`,
      toolName: 'read',
      content: [{ type: 'text', text: 'y'.repeat(5000) }],
    }));
    const calls = Array.from({ length: 30 }, (_, i) => ({
      type: 'toolCall',
      id: `tc-${i}`,
      name: 'read',
      arguments: { blob: 'z'.repeat(5000) },
    }));
    const req = withSid(() => parse('mid-turn', turnEnd(results, calls)));
    expect(req?.toolCalls).toHaveLength(12);
    for (const c of req!.toolCalls!) {
      expect(c.toolResponse).toHaveLength(400);
      expect(c.toolInput).toHaveLength(400);
    }
  });

  it('drops image parts but keeps text when flattening result content', () => {
    const req = withSid(() =>
      parse(
        'mid-turn',
        turnEnd([
          {
            toolCallId: 't',
            toolName: 'read',
            content: [{ type: 'image', data: 'BASE64' }, { type: 'text', text: 'real' }],
          },
        ]),
      ),
    );
    expect(req?.toolCalls?.[0].toolResponse).toBe('real');
  });

  it('returns null for an empty batch', () => {
    expect(withSid(() => parse('mid-turn', turnEnd([])))).toBeNull();
    expect(withSid(() => parse('mid-turn', { type: 'turn_end' }))).toBeNull();
  });

  it('survives circular tool arguments without throwing', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const req = withSid(() =>
      parse(
        'mid-turn',
        turnEnd(
          [{ toolCallId: 'c', toolName: 'x', content: [{ type: 'text', text: 'ok' }] }],
          [{ type: 'toolCall', id: 'c', name: 'x', arguments: circular }],
        ),
      ),
    );
    expect(req?.toolCalls?.[0]).toEqual({ tool: 'x', toolInput: '', toolResponse: 'ok' });
  });
});

// ── adapter: render ─────────────────────────────────────────────────────────

describe('adapters/omp.mjs — render', () => {
  it('returns PLAIN TEXT, not a claude-style JSON envelope', () => {
    const out = render('turn-start', 'some memory', {});
    expect(out).toBe('some memory');
    expect(() => JSON.parse(out as string)).toThrow();
  });

  it('returns null for empty/whitespace so nothing at all is injected', () => {
    expect(render('turn-start', '', {})).toBeNull();
    expect(render('mid-turn', '   \n ', {})).toBeNull();
    expect(render('mid-turn', undefined as unknown as string, {})).toBeNull();
  });
});

// ── artifact: dispatcher resolution + skip gates ────────────────────────────

describe('inject-hook — resolveDispatcherPath', () => {
  it('prefers the explicit env override', () => {
    expect(
      resolveDispatcherPath({ NODE_ENV: 'test', PAPERCUSP_INJECT_DISPATCHER: '/x/index.mjs' }, undefined, () => true),
    ).toBe(
      '/x/index.mjs',
    );
  });

  it('falls back to the installed layout under PAPERCUSP_HOME', () => {
    const got = resolveDispatcherPath(
      { NODE_ENV: 'test', PAPERCUSP_HOME: '/ph' },
      undefined,
      p => p === '/ph/hooks/inject/index.mjs',
    );
    expect(got).toBe('/ph/hooks/inject/index.mjs');
  });

  it('returns null when nothing is installed (never a fabricated path)', () => {
    expect(resolveDispatcherPath({ NODE_ENV: 'test', PAPERCUSP_HOME: '/ph' }, undefined, () => false)).toBeNull();
  });

  // ── ISOLATION GUARD (EI-20001110634702380) ────────────────────────────────
  // PAPERCUSP_HOME is an ISOLATION PIN, not a first preference: when it is set
  // and holds no dispatcher, resolution must return null rather than reaching
  // into the shared ~/.papercusp.
  //
  // This pins a change that was made and then REVERTED with measurements. The
  // `||` on the home line reads like a bug — it contradicted the docstring,
  // which promised ordered fallbacks — and "make the code match its comment"
  // looks obviously right. It is not: with the fallback in place, the
  // fail-silent test below (which points PAPERCUSP_HOME at an empty temp dir)
  // reached the REAL installed dispatcher and wrote a live `client='omp'` row
  // into harness_shared.memory_recall_stats in production, session_id
  // 'su-test-0001' at 2026-08-09T19:35:32Z. The docstring was corrected instead.
  //
  // Nothing real is stranded by the exclusive form: a psu session resolves via
  // the selfDir candidate, verified live under the exact production env.
  it('does NOT escape a pinned PAPERCUSP_HOME to the shared ~/.papercusp (isolation, not fallback)', () => {
    const shared = join(homedir(), '.papercusp', 'hooks', 'inject', 'index.mjs');
    // Only the SHARED dispatcher exists; the pinned home has none.
    const got = resolveDispatcherPath(
      { NODE_ENV: 'test', PAPERCUSP_HOME: '/home/u/.papercusp-workspaces/ws/.papercusp' },
      undefined,
      p => p === shared,
    );
    expect(got).toBeNull();
  });

  // The production path, and the reason the exclusive form strands nobody: the
  // installer writes the omp artifact and the dispatcher into the SAME hooks/
  // tree, so the sibling candidate resolves even when PAPERCUSP_HOME is pinned
  // somewhere that has no dispatcher. Measured live 2026-08-09 against a real
  // `psu --agent=omp --headless` session.
  it('resolves via selfDir even when PAPERCUSP_HOME is pinned elsewhere (the real psu shape)', () => {
    const sibling = '/home/u/.papercusp/hooks/inject/index.mjs';
    const got = resolveDispatcherPath(
      { NODE_ENV: 'test', PAPERCUSP_HOME: '/home/u/.papercusp-workspaces/ws/.papercusp' },
      '/home/u/.papercusp/hooks/omp',
      p => p === sibling,
    );
    expect(got).toBe(sibling);
  });
});

describe('inject-hook — shouldSkip', () => {
  it('skips without PAPERCUSP_SID (invariant 3)', () => {
    // NODE_ENV only satisfies ProcessEnv's required key (see SID_ENV above); the
    // point of this case is the ABSENCE of PAPERCUSP_SID, which is preserved.
    expect(shouldSkip('turn-start', { NODE_ENV: 'test' })).toBe(true);
  });

  it('suppresses mid-turn when PAPERCUSP_MID_TURN_CONTEXT=off (recall-only port)', () => {
    expect(shouldSkip('mid-turn', { ...SID_ENV, PAPERCUSP_MID_TURN_CONTEXT: 'off' })).toBe(true);
    expect(shouldSkip('turn-start', { ...SID_ENV, PAPERCUSP_MID_TURN_CONTEXT: 'off' })).toBe(false);
  });

  it('does NOT skip turn-start on PAPERCUSP_TURN_START_MEMORY=off — that switch DEGRADES, it does not suppress', () => {
    // REGRESSION GUARD, and this was a real bug here before ports.mjs was read
    // (caught 2026-08-09, pre-merge). Inferring the semantics from D-001's
    // one-line summary ("PER-PORT KILL-SWITCH env: PAPERCUSP_TURN_START_MEMORY
    // =off, PAPERCUSP_MID_TURN_CONTEXT=off") reads as though both simply
    // disable their port. They do not.
    //
    // turn-start carries TWO payloads on one request: the memory delta AND the
    // one-shot CTRL transition (mode / loop / route changes). The env var is a
    // MEMORY preference; core.mjs honours it by sending memoryEnabled=false and
    // STILL making the call. If the artifact skipped the spawn instead, the
    // CTRL transition would be silently dropped — invisibly, since the turn
    // just proceeds without the transition it was owed.
    //
    // If someone "tidies" SUPPRESSING_KILL_SWITCH by adding a turn-start entry,
    // this test is what stops it.
    expect(shouldSkip('turn-start', { ...SID_ENV, PAPERCUSP_TURN_START_MEMORY: 'off' })).toBe(false);
  });

  it('runs when a psu session has neither switch off', () => {
    expect(shouldSkip('turn-start', SID_ENV)).toBe(false);
    expect(shouldSkip('mid-turn', SID_ENV)).toBe(false);
  });
});

describe('inject-hook — per-port budgets match D-001 invariant 2', () => {
  it('pins the contract values', () => {
    expect(PORT_TIMEOUT_MS['turn-start']).toBe(2500);
    expect(PORT_TIMEOUT_MS['mid-turn']).toBe(1500);
  });

  it('kills only ABOVE the port budget, so core.mjs own timeout wins normally', () => {
    // If the margin went <= 0 we would pre-empt core's clean timeout with a
    // SIGKILL, losing its fail-silent path for every slow-operator turn.
    expect(SUBPROCESS_KILL_MARGIN_MS).toBeGreaterThan(0);
  });
});

// ── artifact: the CALIBRATION control, then the fail-silent invariants ──────

describe('inject-hook — runDispatcher', () => {
  it('CALIBRATION (must pass or every null assertion below is vacuous): a working dispatcher yields its stdout', async () => {
    const out = await runDispatcher('turn-start', 'before_agent_start', { prompt: 'hi' }, {
      env: envWith(echoDispatcher),
    });
    expect(out).toBe('INJECTED CONTEXT');
  });

  it('feeds the native event as JSON on STDIN and passes --client/--event as argv', async () => {
    // This pins the contract the shared index.mjs must honour. A mismatch here
    // is invisible in production: both sides fail silent, so it looks exactly
    // like "no memories were relevant".
    const out = await runDispatcher('mid-turn', 'turn_end', { type: 'turn_end', turnIndex: 4 }, {
      env: envWith(stdinRecorder),
    });
    expect(out).toBe('RECORDED');
    const rec = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(recordedStdinFile, 'utf8')));
    expect(JSON.parse(rec.stdin)).toEqual({ type: 'turn_end', turnIndex: 4 });
    expect(rec.argv).toEqual(['--client=omp', '--event=turn_end']);
  });

  it('FAIL-SILENT: missing PAPERCUSP_SID injects nothing and spawns nothing', async () => {
    expect(await runDispatcher('turn-start', 'before_agent_start', { prompt: 'hi' }, {
      env: { NODE_ENV: 'test', PAPERCUSP_INJECT_DISPATCHER: echoDispatcher },
    })).toBeNull();
  });

  it('the mid-turn kill switch suppresses the spawn entirely', async () => {
    expect(await runDispatcher('mid-turn', 'turn_end', { toolResults: [] }, {
      env: envWith(echoDispatcher, { PAPERCUSP_MID_TURN_CONTEXT: 'off' }),
    })).toBeNull();
  });

  it('the turn-start memory switch still dispatches, so CTRL transitions survive', async () => {
    // The paired end-to-end half of the shouldSkip guard above: with memory
    // off, the dispatcher MUST still be invoked (core.mjs then degrades the
    // request via memoryEnabled=false rather than skipping it).
    expect(await runDispatcher('turn-start', 'before_agent_start', { prompt: 'hi' }, {
      env: envWith(echoDispatcher, { PAPERCUSP_TURN_START_MEMORY: 'off' }),
    })).toBe('INJECTED CONTEXT');
  });

  it('FAIL-SILENT: no dispatcher installed resolves null (never throws)', async () => {
    expect(await runDispatcher('turn-start', 'before_agent_start', { prompt: 'hi' }, {
      env: { ...SID_ENV, PAPERCUSP_HOME: join(dir, 'nope') },
    })).toBeNull();
  });

  it('FAIL-SILENT: a non-zero exit discards even partial stdout', async () => {
    // 'partial' was printed before the crash. Injecting a truncated payload is
    // worse than injecting nothing — it would look like real context.
    expect(await runDispatcher('turn-start', 'before_agent_start', { prompt: 'hi' }, {
      env: envWith(crashDispatcher),
    })).toBeNull();
  });

  it('FAIL-SILENT: a hung dispatcher is killed at the deadline and injects nothing', async () => {
    const started = Date.now();
    const out = await runDispatcher('mid-turn', 'turn_end', { toolResults: [] }, {
      env: envWith(hangDispatcher),
      killAfterMs: 250,
    });
    expect(out).toBeNull();
    // The point of the deadline is that the turn is not held hostage: omp's own
    // only bound is 30s, and it abandons rather than cancels.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('FAIL-SILENT: whitespace-only stdout injects nothing', async () => {
    expect(await runDispatcher('turn-start', 'before_agent_start', { prompt: 'hi' }, {
      env: envWith(whitespaceDispatcher),
    })).toBeNull();
  });

  it('FAIL-SILENT: a non-serialisable event resolves null instead of throwing', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(await runDispatcher('turn-start', 'before_agent_start', circular, {
      env: envWith(echoDispatcher),
    })).toBeNull();
  });

  it('FAIL-SILENT: an unexecutable dispatcher path resolves null', async () => {
    expect(await runDispatcher('turn-start', 'before_agent_start', { prompt: 'hi' }, {
      env: envWith(echoDispatcher),
      execPath: join(dir, 'no-such-runtime'),
    })).toBeNull();
  });
});

// ── mid-turn delivery (EI-20212277790978719) ────────────────────────────────
//
// The bug this block exists to prevent, stated so it cannot be re-argued from
// first principles the way it was the first time: in the pi runtime ANY queued
// message (steer OR followUp) makes the agent loop DISCARD the tool calls it
// was about to run and hand the model "Skipped due to pending system advisory
// … retry the skipped tool if it is still needed". Measured on one Gemini su
// session: 17 injections, 13 cancelled tool calls, 13/13 of those cancellations
// immediately preceded by one of our blocks. `deliverAs:'nextTurn'` is not the
// escape — while streaming it lands in a buffer whose only drain is a later
// triggerTurn delivery, i.e. a silent hole instead of a loud tax.
//
// So mid-turn context must ride IN a tool result (the `tool_result` seam, whose
// returned content the runtime merges), never in a message.

describe('inject-hook — mid-turn delivery rides in a tool result, never a message', () => {
  const withEcho = async (fn: (handlers: Map<string, (event: unknown) => Promise<unknown> | unknown>, sent: unknown[]) => Promise<void>) => {
    const previousEnv = { ...process.env };
    Object.assign(process.env, envWith(echoDispatcher));
    clearMidTurnStash();
    try {
      const handlers = new Map<string, (event: unknown) => Promise<unknown> | unknown>();
      const sent: unknown[] = [];
      register({
        on: (event, handler) => handlers.set(event, handler),
        sendMessage: (message, options) => sent.push({ message, options }),
      });
      await fn(handlers, sent);
    } finally {
      clearMidTurnStash();
      for (const key of Object.keys(process.env)) {
        if (!(key in previousEnv)) delete process.env[key];
      }
      Object.assign(process.env, previousEnv);
    }
  };

  it('CALIBRATION (must pass or every assertion below is vacuous): turn_end really does fetch a block', async () => {
    await withEcho(async handlers => {
      const turnEnd = handlers.get('turn_end');
      expect(turnEnd).toBeDefined();
      await turnEnd!({ type: 'turn_end', toolResults: [{ toolCallId: 'call-1' }] });
      // Observed through the delivery seam, since that is the only way out now.
      const toolResult = handlers.get('tool_result');
      expect(toolResult).toBeDefined();
      expect(await toolResult!({ content: 'ORIGINAL' })).toEqual({ content: 'ORIGINAL\n\nINJECTED CONTEXT' });
    });
  });

  it('NEVER queues a message — the regression that cancelled 13 tool calls', async () => {
    await withEcho(async (handlers, sent) => {
      await handlers.get('turn_end')!({ type: 'turn_end', toolResults: [{ toolCallId: 'call-1' }] });
      await handlers.get('tool_result')!({ content: 'ORIGINAL' });
      expect(sent).toEqual([]);
    });
  });

  it('appends to array content instead of replacing it (emitToolResult REPLACES what we return)', async () => {
    await withEcho(async handlers => {
      await handlers.get('turn_end')!({ type: 'turn_end', toolResults: [{ toolCallId: 'call-1' }] });
      expect(await handlers.get('tool_result')!({ content: [{ type: 'text', text: 'REAL OUTPUT' }] })).toEqual({
        content: [{ type: 'text', text: 'REAL OUTPUT' }, { type: 'text', text: 'INJECTED CONTEXT' }],
      });
    });
  });

  it('delivers to exactly ONE tool result — the stash is take-and-clear', async () => {
    await withEcho(async handlers => {
      await handlers.get('turn_end')!({ type: 'turn_end', toolResults: [{ toolCallId: 'call-1' }] });
      const toolResult = handlers.get('tool_result')!;
      expect(await toolResult({ content: 'FIRST' })).toEqual({ content: 'FIRST\n\nINJECTED CONTEXT' });
      expect(await toolResult({ content: 'SECOND' })).toBeUndefined();
    });
  });

  it('returns undefined when nothing is stashed, so an untouched result stays untouched', async () => {
    await withEcho(async handlers => {
      expect(await handlers.get('tool_result')!({ content: 'ORIGINAL' })).toBeUndefined();
    });
  });
});

describe('inject-hook — mid-turn stash', () => {
  it('newest wins: a later turn supersedes an undelivered earlier block', () => {
    clearMidTurnStash();
    stashMidTurn('OLD', 1_000);
    stashMidTurn('NEW', 2_000);
    expect(takeMidTurn(2_001)).toBe('NEW');
    expect(takeMidTurn(2_002)).toBeNull();
  });

  it('drops a stash older than the max age rather than injecting stale context', () => {
    clearMidTurnStash();
    stashMidTurn('STALE', 1_000);
    expect(takeMidTurn(1_000 + PENDING_MAX_AGE_MS + 1)).toBeNull();
  });

  it('CONTROL: the same stash one millisecond INSIDE the window is delivered', () => {
    // Calibration for the case above — without this, a takeMidTurn stubbed to
    // `return null` would pass the staleness test for the wrong reason.
    clearMidTurnStash();
    stashMidTurn('FRESH', 1_000);
    expect(takeMidTurn(1_000 + PENDING_MAX_AGE_MS)).toBe('FRESH');
  });

  it('a taken stash is cleared even when it was stale (no zombie replay)', () => {
    clearMidTurnStash();
    stashMidTurn('STALE', 1_000);
    expect(takeMidTurn(1_000 + PENDING_MAX_AGE_MS + 1)).toBeNull();
    expect(takeMidTurn(1_000 + PENDING_MAX_AGE_MS + 2)).toBeNull();
  });

  it('preserves independent hook advisories instead of letting one overwrite another', () => {
    clearMidTurnStash();
    stashMidTurn('MEMORY', 1_000);
    stashAdvisory('coord-turn-start', 'COORD', 1_001);
    expect(takeMidTurn(1_002)).toBe('MEMORY\n\nCOORD');
    expect(takeMidTurn(1_003)).toBeNull();
  });
});

describe('inject-hook — appendBlock', () => {
  it('preserves string content', () => {
    expect(appendBlock('tool said this', 'BLOCK')).toBe('tool said this\n\nBLOCK');
  });

  it('preserves every part of array content, including images it does not understand', () => {
    expect(appendBlock([{ type: 'image', data: 'x' }, { type: 'text', text: 'out' }], 'BLOCK')).toEqual([
      { type: 'image', data: 'x' },
      { type: 'text', text: 'out' },
      { type: 'text', text: 'BLOCK' },
    ]);
  });

  it('emits the block alone for absent/unknown content rather than fabricating a wrapper', () => {
    expect(appendBlock(undefined, 'BLOCK')).toEqual([{ type: 'text', text: 'BLOCK' }]);
    expect(appendBlock({ weird: true }, 'BLOCK')).toEqual([{ type: 'text', text: 'BLOCK' }]);
  });
});

// ── the injection-miss record (EI-20006285243973245) ────────────────────────
//
// The gap this closes: fail-silent + zero logging made "injection is broken"
// and "no memories were relevant" indistinguishable from every vantage point,
// including forensically — a real outage resolved cause-UNDETERMINED because
// nothing recorded that the hook ran and found nothing.
//
// ⚠ These assertions are mostly "a file was NOT written", which is exactly what
// a noteInjectionMiss that was deleted or stubbed to `return` would also
// produce. The CALIBRATION test below asserts a miss IS written; if it fails,
// treat every negative in this block as vacuous until it passes again.

describe('inject-hook — injection-miss record', () => {
  let missSeq = 0;
  /** A fresh, never-shared home per case, so one case cannot see another's log. */
  const freshHome = () => join(dir, `miss-home-${missSeq++}`);
  const missLogIn = (home: string) => join(home, MISS_LOG_BASENAME);
  const readMisses = (home: string) =>
    readFileSync(missLogIn(home), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l));

  it('CALIBRATION (must pass or every negative below is vacuous): a SID session with no dispatcher records a miss', async () => {
    const home = freshHome();
    expect(await runDispatcher('turn-start', 'before_agent_start', { prompt: 'hi' }, {
      env: { ...SID_ENV, PAPERCUSP_HOME: home },
    })).toBeNull();
    expect(existsSync(missLogIn(home))).toBe(true);
    expect(readMisses(home)).toHaveLength(1);
  });

  it('records the SID, the port and the candidates it tried', async () => {
    // The candidate list is the fact no other surface can reconstruct: it is what
    // separates a half-install (dispatcher absent beside a present hook) from a
    // session pinned at the wrong home.
    const home = freshHome();
    await runDispatcher('mid-turn', 'turn_end', { toolResults: [] }, {
      env: { ...SID_ENV, PAPERCUSP_HOME: home },
      selfDir: '/opt/papercusp/hooks/omp',
    });
    const [rec] = readMisses(home);
    expect(rec.sid).toBe('su-test-0001');
    expect(rec.port).toBe('mid-turn');
    expect(rec.reason).toBe('dispatcher-missing');
    expect(rec.triedCandidates).toContain('/opt/papercusp/hooks/inject/index.mjs');
    expect(rec.triedCandidates).toContain(join(home, 'hooks', 'inject', 'index.mjs'));
  });

  it('writes NOTHING when there is no PAPERCUSP_SID — nothing was owed, so a miss would be noise', async () => {
    const home = freshHome();
    await runDispatcher('turn-start', 'before_agent_start', { prompt: 'hi' }, {
      env: { NODE_ENV: 'test', PAPERCUSP_HOME: home },
    });
    expect(existsSync(missLogIn(home))).toBe(false);
  });

  it('writes NOTHING on the happy path — a healthy box never touches this file', async () => {
    const home = freshHome();
    expect(await runDispatcher('turn-start', 'before_agent_start', { prompt: 'hi' }, {
      env: { ...SID_ENV, PAPERCUSP_HOME: home, PAPERCUSP_INJECT_DISPATCHER: echoDispatcher },
    })).toBe('INJECTED CONTEXT');
    expect(existsSync(missLogIn(home))).toBe(false);
  });

  it('NEVER writes to stdout — stdout IS the injection payload the caller reads back', () => {
    // A single stray byte here would corrupt injected context rather than fail loudly.
    const home = freshHome();
    const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      noteInjectionMiss('turn-start', 'dispatcher-missing', {
        env: { NODE_ENV: 'test', PAPERCUSP_SID: 'su-test-0001', PAPERCUSP_HOME: home },
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(missLogIn(home))).toBe(true); // control: it did run
  });

  it('NEVER throws when the home cannot be created — a diagnostic must not cost a turn', () => {
    // echoDispatcher is a FILE, so mkdir of a path beneath it fails ENOTDIR.
    expect(() =>
      noteInjectionMiss('turn-start', 'dispatcher-missing', {
        env: { NODE_ENV: 'test', PAPERCUSP_SID: 'su-test-0001', PAPERCUSP_HOME: join(echoDispatcher, 'sub') },
      }),
    ).not.toThrow();
  });

  it('restarts past MISS_LOG_MAX_BYTES instead of growing without bound', () => {
    // A permanently-broken install misses on EVERY turn, so an unbounded log
    // would itself become the next thing someone has to diagnose.
    const home = freshHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(missLogIn(home), 'x'.repeat(MISS_LOG_MAX_BYTES + 1));
    noteInjectionMiss('turn-start', 'dispatcher-missing', {
      env: { NODE_ENV: 'test', PAPERCUSP_SID: 'su-test-0001', PAPERCUSP_HOME: home },
    });
    const after = readFileSync(missLogIn(home), 'utf8');
    expect(after.length).toBeLessThan(MISS_LOG_MAX_BYTES);
    expect(JSON.parse(after.trim()).reason).toBe('dispatcher-missing');
  });

  it('stays inside a pinned PAPERCUSP_HOME — the same isolation rule as resolution', () => {
    // The miss log must not become the thing that escapes the pin that
    // resolveDispatcherPath is so careful to respect (EI-20001110634702380).
    const home = freshHome();
    noteInjectionMiss('turn-start', 'dispatcher-missing', {
      env: { NODE_ENV: 'test', PAPERCUSP_SID: 'su-test-0001', PAPERCUSP_HOME: home },
    });
    expect(papercuspHomeDir({ NODE_ENV: 'test', PAPERCUSP_HOME: home })).toBe(home);
    expect(existsSync(missLogIn(home))).toBe(true);
    expect(existsSync(join(homedir(), '.papercusp', MISS_LOG_BASENAME))).toBe(false);
  });
});
