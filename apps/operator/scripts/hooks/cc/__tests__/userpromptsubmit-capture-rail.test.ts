/**
 * userpromptsubmit-provenance.sh — the HYBRID OWNER-DIRECTIVE CAPTURE RAIL
 * (P-004 of turn-start-memory-two-class-2026-09-21).
 *
 * The clause under test (AUTO-BAR-R-1-P-004): "After a turn the owner typed in
 * a live session, a directive record for that turn is readable in the pending
 * state, and that session performed no directive-recording call." Its stated
 * falsifier is the pre-hybrid world: "Capture depends on the agent choosing to
 * make a call, so a turn the agent ignores leaves no record."
 *
 * So the property that actually has to hold is about the HOOK, not the agent:
 * on an owner turn the hook itself must issue `orders:capture-pending`, with a
 * stable idempotent key, without the session doing anything — and it must NOT
 * do so on a machine-injected turn.
 *
 * The sibling suite (userpromptsubmit-provenance.test.ts) asserts only that the
 * call FAILING is loud, because its harness pins HOME=/nonexistent-home so the
 * bearer is unreadable and capture can never succeed. That is the wrong half of
 * the rail: the assertions there stay green whether or not the hook ever makes
 * the call at all. The one pre-existing "rail is wired" test greps the SOURCE
 * for the tool name, which stays true no matter what the hook does at runtime —
 * it was green throughout a real outage in which the rail captured nothing.
 *
 * This suite closes that gap HERMETICALLY. It stands up a throwaway HTTP stub
 * speaking the same JSON-RPC envelope the local MCP endpoint speaks, points the
 * hook at it with PAPERCUSP_OPERATOR_URL, and gives the hook a temp HOME holding
 * a fake superuser token — so the capture path executes for real and every call
 * it makes is observable. No live operator, no database, no network.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * PROBE_SCRIPT makes the subject path overridable for the mutation probe
 * (CLAUDE.md, "Proving a guard is falsifiable"). Unset — the default, and
 * always so in CI — it resolves the real hook.
 *
 * ⛔ THE SNAPSHOT MUST LIVE IN THE HOOK'S OWN DIRECTORY. The copy-out tier's
 * usual form (mutate a copy in /tmp, point the suite at it) does NOT work here
 * and fails DISHONESTLY. The hook runs `python3 - "$PAPERCUSP_SID"
 * "$(dirname "$0")"` and imports its sibling `mcp_response` module from that
 * directory, so a snapshot anywhere else dies with `ModuleNotFoundError`,
 * exits 0 with EMPTY stdout, and every case in this file then fails inside
 * `contextOf`'s `JSON.parse` — which is indistinguishable from a caught
 * mutant. Measured 2026-09-22: a historical-mode probe scored 12 of 13 cases
 * "failing" against a snapshot that had never executed a line of
 * classification logic. `mutation-probe.sh` caught it only because its
 * CURRENT-source leg failed too and it refused to score
 * (`verdict=harness-error`); a probe without that leg would have recorded a
 * confident false pass.
 *
 * So: either place the snapshot beside the real hook, or use `--in-tree` while
 * holding `locks:acquire` on the hook path (git-sync excludes locked paths).
 */
const SCRIPT =
  process.env.PROBE_SCRIPT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'userpromptsubmit-provenance.sh');
const SID = 'su-capture-rail-test';

type ToolCall = { name: string; args: Record<string, unknown> };

let ledgerDir = '';
let homeDir = '';
let server: Server | undefined;
let baseUrl = '';
let calls: ToolCall[] = [];
/** The stub answers these tools with a rejected result instead of ok. */
let rejectTools = new Set<string>();
/** Simulate a committed capture whose HTTP response is lost once. */
let dropOnceTools = new Set<string>();
/** Model recordOwnerDirective's unique sourceTurnRef lookup on retry. */
let persistedCaptures = new Map<string, Record<string, unknown>>();
let captureTrace: string[] = [];
/** What a successful capture reports back; `needsSummary` drives the D-004 notice. */
let captureReply: Record<string, unknown> = { ok: true, id: 1, needsSummary: false };
let continuationReply: Record<string, unknown> = { ok: true, launched: false, status: 'ineligible' };

function sha256Normalized(s: string): string {
  return createHash('sha256').update(s.replace(/\r\n?/g, '\n').trim(), 'utf8').digest('hex');
}

/**
 * The local MCP endpoint's success envelope: a JSON-RPC result whose first text
 * content block carries the tool's own JSON payload. parse_mcp_response treats
 * anything else (isError, no result, non-JSON text) as a failure, which is what
 * the rejection branch below exercises.
 */
function okEnvelope(payload: unknown): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
  });
}

function rejectedEnvelope(message: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { isError: true, content: [{ type: 'text', text: message }] },
  });
}

beforeEach(async () => {
  ledgerDir = mkdtempSync(join(tmpdir(), 'cap-rail-ledger-'));
  homeDir = mkdtempSync(join(tmpdir(), 'cap-rail-home-'));
  mkdirSync(join(homeDir, '.papercusp'), { recursive: true });
  // The hook refuses to call out at all without a readable bearer, so the temp
  // HOME must carry one. Its VALUE is never checked by the stub — only that the
  // hook got far enough to send a request.
  writeFileSync(join(homeDir, '.papercusp', 'superuser-token'), 'test-token-not-a-real-credential\n');
  calls = [];
  rejectTools = new Set();
  dropOnceTools = new Set();
  persistedCaptures = new Map();
  captureTrace = [];
  captureReply = { ok: true, id: 1, needsSummary: false };
  continuationReply = { ok: true, launched: false, status: 'ineligible' };

  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let name = '';
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(body);
        name = String(parsed?.params?.name ?? '');
        args = (parsed?.params?.arguments ?? {}) as Record<string, unknown>;
      } catch {
        /* recorded below as an empty-name call, which fails the assertions loudly */
      }
      calls.push({ name, args });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (rejectTools.has(name)) {
        res.end(rejectedEnvelope('refused by the stub'));
        return;
      }
      if (CAPTURE_VERBS.has(name)) {
        const sourceTurnRef = String(args.sourceTurnRef ?? '');
        let reply = persistedCaptures.get(sourceTurnRef);
        if (!reply) {
          reply = { ...captureReply };
          persistedCaptures.set(sourceTurnRef, reply);
          captureTrace.push('insert');
        } else {
          captureTrace.push('dedupe-read');
        }
        if (dropOnceTools.delete(name)) {
          // The request reached the server and the write is durable; only the
          // response is lost, reproducing the outcome-unknown transport window.
          captureTrace.push('response-lost');
          res.destroy();
          return;
        }
        res.end(okEnvelope(reply));
        return;
      }
      if (name === 'sessions:continue-released-operation') {
        res.end(okEnvelope(continuationReply));
        return;
      }
      res.end(okEnvelope(captureReply));
    });
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((done) => server!.close(() => done()));
  server = undefined;
  rmSync(ledgerDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

function writeMachineRow(over: Record<string, unknown> = {}): void {
  const row = {
    sid: SID,
    nonce: 'aabbccddeeff0011',
    origin: 'wake-pump',
    sha256: sha256Normalized('the injected payload'),
    ts: Date.now(),
    ...over,
  };
  writeFileSync(join(ledgerDir, `${SID}.jsonl`), JSON.stringify(row) + '\n');
}

/**
 * ⚠ ASYNC ON PURPOSE — do NOT "simplify" this back to spawnSync.
 *
 * The stub server lives in THIS process, and spawnSync blocks the event loop for
 * the child's whole lifetime. Under spawnSync the server can never accept the
 * hook's request, so the hook's 1s capture timeout expires, `_mcp_call` returns
 * None, and the suite observes ZERO calls — which reads exactly like "the hook
 * never tried to capture", the very defect this file exists to detect. Measured:
 * with spawnSync every capture assertion failed while the identical hook
 * invocation from a shell recorded `orders:capture` on the first try.
 */
function runHook(
  payload: unknown,
  env: Record<string, string> = {},
): Promise<{ stdout: string; status: number | null }> {
  return new Promise((done, fail) => {
    const child = spawn('bash', [SCRIPT], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: homeDir,
        PAPERCUSP_OPERATOR_URL: baseUrl,
        PAPERCUSP_TURN_PROVENANCE_DIR: ledgerDir,
        PAPERCUSP_SID: SID,
        // A real egress proxy in the environment must not be consulted for a
        // loopback stub; the hook already builds a proxy-free opener, and clearing
        // these keeps the test honest about what it measured.
        http_proxy: '',
        https_proxy: '',
        no_proxy: '127.0.0.1,localhost',
        ...env,
      },
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', fail);
    child.on('close', (status) => done({ stdout, status }));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

function contextOf(out: { stdout: string; status: number | null }): string {
  expect(out.status).toBe(0);
  const parsed = JSON.parse(out.stdout);
  expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
  return parsed.hookSpecificOutput.additionalContext as string;
}

/** Every capture attempt, under either verb (the fallback is a second attempt). */
const CAPTURE_VERBS = new Set(['orders:capture', 'orders:capture-pending']);
function captureCalls(): ToolCall[] {
  return calls.filter((c) => CAPTURE_VERBS.has(c.name));
}

function continuationCalls(): ToolCall[] {
  return calls.filter((c) => c.name === 'sessions:continue-released-operation');
}

describe('userpromptsubmit-provenance.sh — hybrid owner-directive capture rail', () => {
  it('captures the complete long owner prompt with its original source hash', async () => {
    writeMachineRow();
    const prompt = 'x'.repeat(15_999) + '🚀\nKeep the final requirement.\n' + 'é'.repeat(5_000);
    const ctx = contextOf(await runHook({ prompt, session_id: 'native-session-long' }));

    expect(ctx).toContain('OWNER (interactive)');
    const captures = captureCalls();
    expect(captures).toHaveLength(1);
    expect(captures[0]!.args.verbatim).toBe(prompt);
    expect(captures[0]!.args.sourceTurnRef).toBe(`native-session-long:${sha256Normalized(prompt)}`);
  });

  it('an OWNER turn makes the hook itself capture the verbatim prompt as an open directive — the session calls nothing', async () => {
    writeMachineRow();
    const prompt = 'please stop the release and roll back to the previous pin';
    const ctx = contextOf(await runHook({ prompt, session_id: 'native-session-aaa' }));

    // The turn classified OWNER, which is the precondition the clause names.
    expect(ctx).toContain('OWNER (interactive)');

    const captures = captureCalls();
    expect(captures).toHaveLength(1);
    // The current verb first; the older one is only a fallback.
    expect(captures[0]!.name).toBe('orders:capture');
    // VERBATIM: the owner's literal words, not a paraphrase or a hash.
    expect(captures[0]!.args.verbatim).toBe(prompt);
    // Keyed on the turn, and carrying the session that produced it.
    expect(captures[0]!.args.sessionRef).toBe('native-session-aaa');
    expect(String(captures[0]!.args.sourceTurnRef ?? '')).toContain('native-session-aaa');

    // The whole point of the hybrid rail: nothing in the session had to ask for
    // this. A successful capture is silent — no notice is appended.
    expect(ctx).not.toContain('OWNER-DIRECTIVE CAPTURE FAILED');
  });

  it('offers the exact captured owner turn to the released-operation continuation door', async () => {
    writeMachineRow();
    continuationReply = { ok: true, launched: true,
      assignmentRef: 'released-operation-engineering:' + 'b'.repeat(64) };
    const prompt = 'Fix the stale operation assignment now.';
    const ctx = contextOf(await runHook({ prompt, session_id: 'native-session-transition', turn_id: 'turn-9' }));

    const [capture] = captureCalls();
    const [continuation] = continuationCalls();
    expect(continuationCalls()).toHaveLength(1);
    expect(continuation!.args).toEqual({
      prompt,
      sourceTurnRef: capture!.args.sourceTurnRef,
      sessionRef: 'native-session-transition',
      directiveId: 1,
    });
    expect(ctx).toContain('fresh, separately receipted SU continuation');
    expect(ctx).toContain('old worker remains restricted');
  });

  it('a Codex owner turn records Codex provenance and keys repeated prompts by native turn id', async () => {
    writeMachineRow();
    const prompt = 'Pause the Codex task and capture this owner turn.';
    const payload = {
      hook_event_name: 'UserPromptSubmit',
      cwd: '/workspace/papercusp',
      model: 'gpt-5.6',
      permission_mode: 'bypass',
      prompt,
      session_id: 'codex-session-capture-rail',
      transcript_path: '/tmp/codex-capture-rail.jsonl',
      turn_id: 'codex-turn-001',
    };

    for (const event of [payload, payload, { ...payload, turn_id: 'codex-turn-002' }]) {
      const ctx = contextOf(await runHook(event, { PAPERCUSP_AGENT: 'codex' }));
      expect(ctx).toContain('OWNER (interactive)');
    }

    const captures = captureCalls();
    expect(captures).toHaveLength(3);
    expect(captures[0]!.args.sourceTurnRef).toBe(captures[1]!.args.sourceTurnRef);
    expect(captures[2]!.args.sourceTurnRef).not.toBe(captures[0]!.args.sourceTurnRef);
    expect(captures[0]!.args.sourceTurnRef).toContain('codex-turn-001');
    expect(captures[0]!.args.sessionRef).toBe('codex-session-capture-rail');

    const provenance = calls.filter((call) => call.name === 'sessions:record-prompt-origin');
    expect(provenance).toHaveLength(3);
    expect(provenance.map((call) => call.args.sourceKind)).toEqual(['codex', 'codex', 'codex']);
    expect(provenance.map((call) => call.args.sessionId)).toEqual([
      'codex-session-capture-rail',
      'codex-session-capture-rail',
      'codex-session-capture-rail',
    ]);
  });

  it('the turn key is STABLE across submissions, so a retry of the same turn is idempotent at the server', async () => {
    writeMachineRow();
    const prompt = 'ship it';
    contextOf(await runHook({ prompt, session_id: 'native-session-bbb' }));
    contextOf(await runHook({ prompt, session_id: 'native-session-bbb' }));

    const captures = captureCalls();
    expect(captures).toHaveLength(2);
    // Idempotency is enforced server-side by a partial unique index on
    // (workspace_id, owner_id, source_turn_ref). That index can only do its job
    // if the hook derives the SAME ref for the same turn, which is what this
    // pins. A ref that embedded a timestamp or a random id would defeat it while
    // every other assertion in this file still passed.
    expect(captures[0]!.args.sourceTurnRef).toBe(captures[1]!.args.sourceTurnRef);
  });

  it('a DIFFERENT owner turn in the same session gets a DIFFERENT key — the key is per-turn, not per-session', async () => {
    writeMachineRow();
    contextOf(await runHook({ prompt: 'first directive', session_id: 'native-session-ccc' }));
    contextOf(await runHook({ prompt: 'second, unrelated directive', session_id: 'native-session-ccc' }));

    const captures = captureCalls();
    expect(captures).toHaveLength(2);
    // CALIBRATION for the test above: without this, a hook that returned one
    // constant ref for everything would satisfy the stability assertion and
    // silently collapse every owner turn in a session into a single record.
    expect(captures[0]!.args.sourceTurnRef).not.toBe(captures[1]!.args.sourceTurnRef);
  });

  /**
   * AUTO-BAR-R-2-P-006: "A turn carrying any verified agent-origin provenance —
   * loop fire, wake pump, self-compaction, fleet kickoff, watchdog or
   * coordination injection — yields no directive record."
   *
   * That clause is UNIVERSAL over the origins it names, so one wake-pump case
   * cannot establish it: capture sits in the hook's final else-branch, and the
   * branch is only reached when classification declines to label the turn
   * machine-generated. A per-origin regression — a new origin string the ledger
   * writes but the classifier does not recognise — would fall straight through
   * to the owner branch and start recording injected turns as owner directives,
   * while a single-origin control stayed green. Each origin is therefore its own
   * case, and the enumeration below is the clause's own list, verbatim.
   */
  const VERIFIED_ORIGINS = [
    'loop-fire',
    'wake-pump',
    'self-compaction',
    'fleet-kickoff',
    'watchdog',
    'coord-inject:coord:inbox-wake',
  ] as const;

  it('a mismatched prompt during a fresh scripted launch stays unverified and is not captured', async () => {
    writeMachineRow({
      origin: 'fleet-kickoff',
      sha256: sha256Normalized('the complete scripted judge brief'),
      ts: Date.now() - 4_000,
    });
    const prompt =
      'over only with these read-only Papercusp tools. Use recovered evidence only when plans:get still reports frozenIdentity.';
    const ctx = contextOf(
      await runHook({ prompt, session_id: 'native-session-truncated-fleet-kickoff' }),
    );

    expect(ctx).toContain('UNVERIFIED SCRIPTED-LAUNCH INPUT');
    expect(ctx).not.toContain('OWNER (interactive)');
    expect(ctx).not.toContain('OWNER-DIRECTIVE CAPTURE FAILED');
    expect(captureCalls()).toHaveLength(0);
    expect(continuationCalls()).toHaveLength(0);
  });

  it('a human prompt after the scripted-launch startup window remains capturable', async () => {
    writeMachineRow({
      origin: 'fleet-kickoff',
      sha256: sha256Normalized('the earlier scripted judge brief'),
      ts: Date.now() - 120_001,
    });
    const prompt = 'please fix the login page';
    const ctx = contextOf(
      await runHook({ prompt, session_id: 'native-session-owner-after-launch' }),
    );

    expect(ctx).toContain('OWNER (interactive)');
    expect(captureCalls()).toHaveLength(1);
    expect(captureCalls()[0]!.args.verbatim).toBe(prompt);
  });

  it('an envelope-less partial loop-fire carry wake is unverified and never captured as owner', async () => {
    writeMachineRow({
      origin: 'loop-fire',
      sha256: sha256Normalized('the complete loop-fire payload'),
      ts: Date.now() - 560,
    });
    const prompt =
      '• ✓ R-18-P-004@6 fails only correct-layer and freshness — re-check the carried result.\n' +
      'Before you END this turn you MUST refresh this carry-note so the NEXT cold wake can continue —\n' +
      '    loop:checkpoint { did, left, insight, next } (compressed facts, not a transcript)';
    const ctx = contextOf(
      await runHook({ prompt, session_id: 'native-session-partial-loop-fire' }),
    );

    expect(ctx).toContain('UNVERIFIED partial loop-fire input');
    expect(ctx).not.toContain('OWNER (interactive)');
    expect(captureCalls()).toHaveLength(0);
    expect(continuationCalls()).toHaveLength(0);
    expect(calls.some((call) => call.name === 'sessions:record-prompt-origin')).toBe(false);
  });

  it('the captured cold-loop-wake tail with no envelope is not captured after a fresh loop-fire', async () => {
    writeMachineRow({
      origin: 'loop-fire',
      sha256: sha256Normalized('the complete cold-loop-wake payload'),
      ts: Date.now() - 560,
    });
    const prompt =
      'or it (that reflex is exactly how conclusions get lost across cold wakes).\n' +
      'If the goal is DONE or you are blocked, call loop:end instead of leaving the loop spinning.';
    const ctx = contextOf(
      await runHook({ prompt, session_id: 'native-session-cold-loop-tail' }),
    );

    expect(ctx).toContain('UNVERIFIED partial loop-fire input');
    expect(ctx).not.toContain('OWNER (interactive)');
    expect(captureCalls()).toHaveLength(0);
    expect(continuationCalls()).toHaveLength(0);
    expect(calls.some((call) => call.name === 'sessions:record-prompt-origin')).toBe(false);
  });

  it('a plain owner prompt shortly after loop-fire remains capturable', async () => {
    writeMachineRow({
      origin: 'loop-fire',
      sha256: sha256Normalized('the complete loop-fire payload'),
      ts: Date.now() - 560,
    });
    const prompt = 'please fix the login page';
    const ctx = contextOf(
      await runHook({ prompt, session_id: 'native-session-owner-after-loop-fire' }),
    );

    expect(ctx).toContain('OWNER (interactive)');
    expect(captureCalls()).toHaveLength(1);
    expect(captureCalls()[0]!.args.verbatim).toBe(prompt);
  });

  for (const origin of VERIFIED_ORIGINS) {
    it(`CONTROL: a VERIFIED ${origin} turn is classified agent-origin and captures nothing`, async () => {
      const payload = `the injected payload for ${origin}`;
      writeMachineRow({ origin, sha256: sha256Normalized(payload) });
      const ctx = contextOf(
        await runHook({
          prompt: `⟦turn-origin:${origin} nonce:aabbccddeeff0011⟧${payload}`,
          session_id: 'native-session-ddd',
        }),
      );
      // CALIBRATION: without this the case could pass vacuously — a prompt the
      // hook failed to classify at all would also produce zero captures, and the
      // control would read as proof of the branch guard rather than of a miss.
      expect(ctx).toContain('VERIFIED AGENT-ORIGIN');
      // The falsifier this control exists for: capture escaping the owner branch
      // and recording injected turns as if the human had typed them.
      expect(captureCalls()).toHaveLength(0);
      // Continuation is a second owner-only side effect. A regression that
      // bypassed capture but still exposed this door must fail the same control.
      expect(continuationCalls()).toHaveLength(0);
    });
  }

  /**
   * The clause (AUTO-BAR-R-2-P-002 / -P-006) names this fixture explicitly: "A
   * carry-respawn turn-0 fixture, stamped owner-typed while its body is the
   * agent's own carry note, is required and must yield no record." The controls
   * above deliver the envelope BARE, and that is not how a carry-respawn turn-0
   * actually arrives — the host wraps the whole continuation in a paste block,
   * so the envelope is no longer at the head of the prompt.
   *
   * That gap was not hypothetical. Owner-directives #170–#181 are twelve
   * machine-injected turns the hook recorded as pending OWNER directives
   * between 2026-09-22T20:30Z and 20:57Z — every one a wrapped carry-respawn or
   * wake prompt, each `captured_by_hook = true`. Classification declined to
   * label them machine-generated, so they fell through to the affirmative owner
   * default and were captured. `unwrap_whole_paste` (landed 20:42Z, committed
   * 619fe9f50f) is the fix; no envelope-carrying capture has been recorded
   * since. This case is what keeps it fixed — the per-origin controls above
   * stayed green throughout that entire window.
   */
  it('a carry-respawn turn-0 arrives PASTE-WRAPPED and is still agent-origin — captures nothing', async () => {
    const carryNote =
      '⟦turn-origin:self-compaction nonce:aabbccddeeff0011⟧' +
      'ADDRESSED TO su-capture-rail-test — continue where you left off; your carry document is in ' +
      'the system prompt. Re-orient, then resume the active plan and its open items.';
    writeMachineRow({ origin: 'self-compaction', sha256: sha256Normalized(carryNote.slice(carryNote.indexOf('⟧') + 1)) });
    const ctx = contextOf(
      await runHook({
        prompt: `<pasted_content id="78f9">\n${carryNote}\n</pasted_content id="78f9">`,
        session_id: 'native-session-fff',
      }),
    );
    // CALIBRATION, as for the per-origin controls: a prompt the hook failed to
    // classify at all would also capture nothing, and would read as proof.
    expect(ctx).toContain('VERIFIED AGENT-ORIGIN');
    expect(ctx).not.toContain('OWNER (interactive)');
    expect(captureCalls()).toHaveLength(0);
  });

  /**
   * The clause's "regardless of how that turn's provenance is stamped" half. The
   * hook's own stated invariant is that an absent or expired ledger row must
   * never yield a MORE authoritative verdict than a live row would have — so an
   * unbacked envelope must not be promoted to the owner default, which is the
   * only branch that captures (and the only one that honours a mode grant).
   */
  it('a paste-wrapped carry-respawn whose ledger row is ABSENT is still not owner — and captures nothing', async () => {
    writeMachineRow({ nonce: 'ffffffffffffffff' }); // a live row, but for a DIFFERENT nonce
    const carryNote =
      '⟦turn-origin:self-compaction nonce:aabbccddeeff0011⟧' +
      'ADDRESSED TO su-capture-rail-test — this continuation was written for that session.';
    const ctx = contextOf(
      await runHook({
        prompt: `<pasted_content id="c854">\n${carryNote}\n</pasted_content id="c854">`,
        session_id: 'native-session-ggg',
      }),
    );
    expect(ctx).toContain('UNVERIFIED ORIGIN CLAIM');
    expect(ctx).not.toContain('OWNER (interactive)');
    expect(captureCalls()).toHaveLength(0);
  });

  it('owner words followed by a wake-pump envelope are not stored as literal owner text', async () => {
    const prompt =
      'Please ship the approved change. ' +
      '⟦turn-origin:wake-pump nonce:aabbccddeeff0011⟧\n' +
      '[await-event] coord:inbox-wake:session-123 fired — continue the work that was waiting on it.';
    const ctx = contextOf(await runHook({ prompt, session_id: 'native-session-mixed' }));

    // The envelope is embedded after ordinary words, so the head-anchored
    // classifier would otherwise call this OWNER and capture the whole string.
    expect(ctx).toContain('MACHINE-GENERATED SURFACE');
    expect(ctx).not.toContain('OWNER (interactive)');
    expect(captureCalls()).toHaveLength(0);
    expect(calls.some((c) => c.name === 'sessions:record-prompt-origin')).toBe(false);
  });

  it('a self-compaction continuation suffix is never captured as an owner directive', async () => {
    const prompt =
      'continued context before the self-compaction envelope\n' +
      '⟦turn-origin:self-compaction nonce:aabbccddeeff0011⟧\n' +
      'ADDRESSED TO su-capture-rail-test — this continuation was written for that session.\n' +
      '## Post-compaction recovery (automatically delivered)\n' +
      'automatic recovery was complete for this session.\n' +
      'ds; deferred unclaimed work EI-24017132083176421 — this session filed/commented on it; ' +
      'keep the ids and re-check before declaring idle; armed loop @papercusp 300s — its ' +
      'loop:checkpoint re-delivers on wake, pointer only; drop resolved tool output and superseded state.';
    const ctx = contextOf(await runHook({ prompt, session_id: 'native-session-self-compaction' }));

    expect(ctx).toContain('MACHINE-GENERATED SURFACE');
    expect(ctx).not.toContain('OWNER (interactive)');
    expect(captureCalls()).toHaveLength(0);
    expect(calls.some((c) => c.name === 'sessions:record-prompt-origin')).toBe(false);
  });

  it('Claude usage-limit reset continuation never invokes directive capture', async () => {
    const prompt =
      'Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.';
    const ctx = contextOf(
      await runHook({ prompt, session_id: 'native-session-claude-usage-reset' }),
    );

    expect(ctx).toContain('MACHINE-GENERATED SURFACE');
    expect(ctx).not.toContain('OWNER (interactive)');
    expect(ctx).not.toContain('OWNER-DIRECTIVE CAPTURE FAILED');
    expect(captureCalls()).toHaveLength(0);
    expect(calls.some((call) => call.name === 'sessions:record-prompt-origin')).toBe(false);
  });

  it('a checkpoint-only carry prompt with no owner words is never captured as an owner directive', async () => {
    const prompt =
      'loop:checkpoint { checks }):\n' +
      '  • ✓ On plan example-plan the stored checkpoint was refreshed by the prior agent.\n' +
      'work_items:checkpoint { id: "EI-123", checkpoint: "continue the prior task" }';
    const ctx = contextOf(await runHook({ prompt, session_id: 'native-session-checkpoint' }));

    // Mirrors the observed #77 shape: a machine carry starts with a checkpoint
    // render and contains no actual owner-typed words.
    expect(ctx).toContain('MACHINE-GENERATED SURFACE');
    expect(ctx).not.toContain('OWNER (interactive)');
    expect(captureCalls()).toHaveLength(0);
    expect(calls.some((c) => c.name === 'sessions:record-prompt-origin')).toBe(false);
  });

  it('CONTROL: an empty prompt is a silent no-op and captures nothing', async () => {
    writeMachineRow();
    const out = await runHook({ prompt: '   ', session_id: 'native-session-eee' });
    expect(out.status).toBe(0);
    expect(captureCalls()).toHaveLength(0);
  });

  it('an operator without orders:capture (the older green release) falls back to orders:capture-pending', async () => {
    writeMachineRow();
    rejectTools = new Set(['orders:capture']);
    const ctx = contextOf(await runHook({ prompt: 'the release is older than this hook', session_id: 'native-session-hhh' }));

    expect(captureCalls().map((c) => c.name)).toEqual(['orders:capture', 'orders:capture-pending']);
    // Same turn, same key: the fallback is the same capture, not a second record.
    expect(captureCalls()[0]!.args.sourceTurnRef).toBe(captureCalls()[1]!.args.sourceTurnRef);
    expect(ctx).not.toContain('OWNER-DIRECTIVE CAPTURE FAILED');
  });

  it('a directive over the cap tells the addressed agent to write its summary (D-004)', async () => {
    writeMachineRow();
    captureReply = { ok: true, id: 4242, needsSummary: true };
    const ctx = contextOf(await runHook({ prompt: 'a long directive stands in here', session_id: 'native-session-iii' }));

    expect(ctx).toContain('Owner directive #4242 is over 500 characters');
    expect(ctx).toContain('orders:summarize { id: 4242');
  });

  it('CONTROL: a directive under the cap gets no summary instruction', async () => {
    writeMachineRow();
    const ctx = contextOf(await runHook({ prompt: 'short directive', session_id: 'native-session-jjj' }));
    expect(ctx).not.toContain('orders:summarize');
  });

  // directive-ownership-clarity-2026-09-23 P-001: on 2026-09-23 an agent that was never
  // told its directive id found "its" row by matching text and closed five OTHER
  // sessions' copies of the same pasted report. The id must reach the session on EVERY
  // captured turn, short or long, so no agent ever has to match on text.
  it('a SHORT captured directive tells the session its own id and to refer to it by number', async () => {
    writeMachineRow();
    captureReply = { ok: true, id: 7777, needsSummary: false };
    const ctx = contextOf(await runHook({ prompt: 'short directive', session_id: 'native-session-kkk' }));

    expect(ctx).toContain('YOUR owner directive #7777');
    expect(ctx).toContain('never by matching its text');
    expect(ctx).toContain('orders:disposition { id: 7777');
  });

  it('a LONG captured directive carries both its id and the summary instruction', async () => {
    writeMachineRow();
    captureReply = { ok: true, id: 7778, needsSummary: true };
    const ctx = contextOf(await runHook({ prompt: 'a long directive stands in here', session_id: 'native-session-lll' }));

    expect(ctx).toContain('YOUR owner directive #7778');
    expect(ctx).toContain('orders:summarize { id: 7778');
  });

  it('a capture reply without an id is unconfirmed, never an invented directive id', async () => {
    writeMachineRow();
    captureReply = { ok: true };
    const ctx = contextOf(await runHook({ prompt: 'short directive', session_id: 'native-session-mmm' }));

    expect(ctx).not.toContain('YOUR owner directive #');
    expect(ctx).toContain('OWNER-DIRECTIVE CAPTURE UNCONFIRMED');
  });

  it('a REJECTED capture stays explicitly unconfirmed and fail-open', async () => {
    writeMachineRow();
    rejectTools = new Set(['orders:capture', 'orders:capture-pending']);
    const out = await runHook({
      prompt: 'this directive must not vanish quietly',
      session_id: 'native-session-fff',
    });
    const ctx = contextOf(out);

    // Both verbs and one same-key verification retry were attempted. A refusal is
    // not used to claim that no prior request committed.
    expect(captureCalls().map((call) => call.name)).toEqual([
      'orders:capture',
      'orders:capture-pending',
      'orders:capture',
    ]);
    expect(ctx).toContain('OWNER-DIRECTIVE CAPTURE UNCONFIRMED');
    expect(ctx).toContain('orders:record');
    expect(ctx).toContain('this same `sourceTurnRef`');
    expect(ctx).toContain(String(captureCalls()[0]!.args.sourceTurnRef));
    expect(ctx).not.toContain('Retry orders:capture');
    // Fail-OPEN: the owner's turn is never blocked and the stamp survives.
    expect(out.status).toBe(0);
    expect(ctx).toContain('OWNER (interactive)');
  });

  it('a committed capture whose response is lost is recovered by the same sourceTurnRef', async () => {
    writeMachineRow();
    captureReply = { ok: true, id: 4243, needsSummary: false };
    dropOnceTools.add('orders:capture');
    rejectTools.add('orders:capture-pending');

    const ctx = contextOf(
      await runHook({ prompt: 'resume this owner directive', session_id: 'native-session-lost-response' }),
    );
    const captures = captureCalls();

    expect(captures.map((call) => call.name)).toEqual([
      'orders:capture',
      'orders:capture-pending',
      'orders:capture',
    ]);
    expect(captures[0]!.args.sourceTurnRef).toBe(captures[1]!.args.sourceTurnRef);
    expect(captures[1]!.args.sourceTurnRef).toBe(captures[2]!.args.sourceTurnRef);
    expect(persistedCaptures.size).toBe(1);
    expect(captureTrace).toEqual(['insert', 'response-lost', 'dedupe-read']);
    expect(ctx).toContain('YOUR owner directive #4243');
    expect(ctx).not.toContain('OWNER-DIRECTIVE CAPTURE UNCONFIRMED');
  });
});

/**
 * EI-24091823697677465 — a DEAD operator pin must not cost the owner's turn.
 *
 * Measured 2026-09-23: a session launched from a staging console inherited
 * PAPERCUSP_OPERATOR_URL=http://localhost:3170 and kept it across every
 * carry-respawn. Each time staging restarted, the hook's only target refused the
 * connection and the owner's words went unrecorded (directives #404, #416 had to be
 * recorded by hand). The hook now retries a REFUSED loopback pin once against the
 * local MCP proxy (PAPERCUSP_MCP_PROXY_PORT). In these cases the stub plays the
 * proxy, so nothing here can reach a real :9071.
 */
describe('userpromptsubmit-provenance.sh — dead operator pin falls back to the MCP proxy', () => {
  /** A loopback port with nothing listening: bind an ephemeral port, then free it. */
  async function deadLoopbackPort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((done) => probe.close(() => done()));
    return port;
  }

  function stubPort(): string {
    return String((server!.address() as AddressInfo).port);
  }

  it('a REFUSED loopback pin is retried against the proxy, the capture lands, and the dead pin is named', async () => {
    writeMachineRow();
    const dead = `http://localhost:${await deadLoopbackPort()}`;
    const prompt = 'record me even though staging is down';
    const ctx = contextOf(
      await runHook(
        { prompt, session_id: 'native-session-pin-1' },
        { PAPERCUSP_OPERATOR_URL: dead, PAPERCUSP_MCP_PROXY_PORT: stubPort() },
      ),
    );

    const captures = captureCalls();
    expect(captures).toHaveLength(1);
    expect(captures[0]!.args.verbatim).toBe(prompt);
    expect(ctx).not.toContain('OWNER-DIRECTIVE CAPTURE FAILED');
    // Loud, and it names the dead address, so the session learns its pin is broken.
    expect(ctx).toContain('OPERATOR PIN DEAD');
    expect(ctx).toContain(dead);
  });

  it('CALIBRATION: a LIVE pin answers directly and reports no dead pin', async () => {
    writeMachineRow();
    const ctx = contextOf(
      await runHook(
        { prompt: 'a normal turn', session_id: 'native-session-pin-2' },
        { PAPERCUSP_MCP_PROXY_PORT: stubPort() },
      ),
    );
    expect(captureCalls()).toHaveLength(1);
    expect(ctx).not.toContain('OPERATOR PIN DEAD');
  });

  it('a pin to ANOTHER host never falls back to the local proxy', async () => {
    writeMachineRow();
    const ctx = contextOf(
      await runHook(
        { prompt: 'this belongs to a different operator', session_id: 'native-session-pin-3' },
        { PAPERCUSP_OPERATOR_URL: 'http://operator.invalid:3170', PAPERCUSP_MCP_PROXY_PORT: stubPort() },
      ),
    );
    // The stub is the configured proxy and was never contacted.
    expect(calls).toHaveLength(0);
    expect(ctx).toContain('OWNER-DIRECTIVE CAPTURE UNCONFIRMED');
  });

  it('a pin that ANSWERED with an error stays pinned for same-key verification', async () => {
    writeMachineRow();
    const pinnedVerbs: string[] = [];
    const pinnedRefs: string[] = [];
    const failing = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          pinnedVerbs.push(String(parsed?.params?.name ?? ''));
          if (parsed?.params?.arguments?.sourceTurnRef) {
            pinnedRefs.push(String(parsed.params.arguments.sourceTurnRef));
          }
        } catch {
          pinnedVerbs.push('');
        }
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('internal error after the request was received');
      });
    });
    await new Promise<void>((done) => failing.listen(0, '127.0.0.1', done));
    try {
      const pinned = `http://127.0.0.1:${(failing.address() as AddressInfo).port}`;
      const ctx = contextOf(
        await runHook(
          { prompt: 'do not record me twice', session_id: 'native-session-pin-4' },
          { PAPERCUSP_OPERATOR_URL: pinned, PAPERCUSP_MCP_PROXY_PORT: stubPort() },
        ),
      );
      // CALIBRATION: the pin received both capture verbs and the bounded
      // same-key verification retry. With no durable directive id, the
      // continuation door is not called; the local proxy still received nothing.
      expect(pinnedVerbs.filter((v) => CAPTURE_VERBS.has(v))).toEqual([
        'orders:capture',
        'orders:capture-pending',
        'orders:capture',
      ]);
      expect(pinnedVerbs).not.toContain('sessions:continue-released-operation');
      expect(pinnedRefs).toHaveLength(3);
      expect(new Set(pinnedRefs).size).toBe(1);
      expect(calls).toHaveLength(0);
      expect(ctx).toContain('OWNER-DIRECTIVE CAPTURE UNCONFIRMED');
      expect(ctx).not.toContain('OPERATOR PIN DEAD');
    } finally {
      await new Promise<void>((done) => failing.close(() => done()));
    }
  });
});
