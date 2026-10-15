/**
 * ask-gate-mirror.test.ts — regression guard for the P-001 owner-gate
 * mirror hook (owner-inbox-single-pane-2026-07-17). Two halves, per the repo
 * convention (see pretooluse-plans-read-guard.test.ts / workitem-verify-nudge.test.ts):
 *
 *   - OPERATOR-INDEPENDENT: the psu/install gates, malformed input, tool-name
 *     matcher filtering, the Stop loop-guard (stop_hook_active), the
 *     question-shaped-ending BOUNCE decision, and the fail-open contract
 *     against an unreachable operator (mirrors workitem-verify-nudge's
 *     `http://127.0.0.1:1` trick — never a real network hop).
 *   - OPERATOR-DEPENDENT: an in-process HTTP stub (the pretooluse-locks-decision
 *     / posttooluse-activity-report-bundle pattern — async `spawn`, never
 *     `spawnSync`, so the stub can actually answer) asserting the EXACT
 *     `sessions:ingest-gate-event` / `coord:escalate` request bodies for the
 *     PreToolUse open, PostToolUse close, Notification permission-wait, and
 *     Stop `<ask>`-tag mirror branches.
 *
 * Cardinal contract shared with every sibling cc/ hook: this hook must NEVER
 * exit non-zero, and every branch except the Stop bounce prints EMPTY stdout
 * (the bounce is the one deliberate exception — that IS its job).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runHookProcess } from './spawn-hook';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';

const HOOK = join(__dirname, '..', 'ask-gate-mirror.sh');

// ── OPERATOR-INDEPENDENT ────────────────────────────────────────────────────

describe('ask-gate-mirror — operator-independent paths', () => {
  let home: string, tmp: string;

  beforeAll(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), 'askgate-home-'));
    fs.mkdirSync(join(home, '.papercusp'), { recursive: true });
    fs.writeFileSync(join(home, '.papercusp', 'superuser-token'), 'test-token\n');
    tmp = fs.mkdtempSync(join(os.tmpdir(), 'askgate-tmp-'));
  });
  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function run(input: string, extraEnv: Record<string, string> = {}, withSid = true) {
    const env: Record<string, string> = { HOME: home, PATH: process.env.PATH ?? '' };
    if (withSid) env.PAPERCUSP_SID = 'su-test';
    // Unreachable operator: any accidental real network call fails fast + fail-open.
    env.PAPERCUSP_OPERATOR_URL = 'http://127.0.0.1:1';
    Object.assign(env, extraEnv);
    const r = spawnSync('bash', [HOOK], { input, encoding: 'utf8', env });
    return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
  }
  const payload = (o: object) => JSON.stringify(o);
  const transcriptWith = (text: string) => {
    const p = join(tmp, `t-${Math.random().toString(36).slice(2)}.jsonl`);
    fs.writeFileSync(p, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n');
    return p;
  };

  const transcriptWithToolUseThenText = (text: string, toolName = 'session:request-compaction') => {
    const p = join(tmp, 'tool-use-then-text.jsonl');
    const entries = [
      { type: 'user', message: { content: [{ type: 'text', text: 'Continue.' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: toolName, input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text }] } },
    ];
    fs.writeFileSync(p, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    return p;
  };

  it('no PAPERCUSP_SID → exit 0, empty stdout', () => {
    const r = run(payload({ hook_event_name: 'Stop' }), {}, false);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('no install (missing token) → exit 0, empty stdout', () => {
    const bareHome = fs.mkdtempSync(join(os.tmpdir(), 'askgate-bare-'));
    try {
      const r = spawnSync('bash', [HOOK], {
        input: payload({ hook_event_name: 'Stop' }),
        encoding: 'utf8',
        env: { HOME: bareHome, PAPERCUSP_SID: 'su-test', PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1' },
      });
      expect(r.status).toBe(0);
      expect((r.stdout ?? '').trim()).toBe('');
    } finally {
      fs.rmSync(bareHome, { recursive: true, force: true });
    }
  });

  it('malformed JSON → fail-open, exit 0, empty stdout', () => {
    const r = run('not json {');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('PreToolUse on an unrelated tool (Bash) → no-op', () => {
    const r = run(payload({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('PostToolUse on an unrelated tool (Read) → no-op', () => {
    const r = run(payload({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {} }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('Notification with a non-permission message → no-op (never mirrored)', () => {
    const r = run(payload({ hook_event_name: 'Notification', message: 'Claude is waiting for your input' }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('Stop with a normal (non-question) ending → allow, empty stdout', () => {
    const r = run(payload({ hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptWith('All done, tests pass.') }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  describe('claimed-action-without-tool-call bounce (EI-22981386187027177)', () => {
    const bounced = (text: string, extra: object = {}) => {
      const r = run(
        payload({
          hook_event_name: 'Stop',
          session_id: 'claimed-action-session',
          transcript_path: transcriptWith(text),
          ...extra,
        }),
      );
      expect(r.status).toBe(0);
      return r.stdout ? JSON.parse(r.stdout) : null;
    };

    it.each([
      'Compacting now',
      'Compacting now, at 104%',
      'Going quiet now so the cut lands',
      "I'm compacting now.",
      "I'll request compaction right now.",
    ])('BOUNCES an imminent action claim with no tool call: %s', (text) => {
      const out = bounced(text);
      expect(out?.decision).toBe('block');
      expect(out.reason).toMatch(/CLAIMING that an imminent action/);
      expect(out.reason).toMatch(/session:request-compaction/);
    });

    it('uses the documented last_assistant_message field when it is present', () => {
      const out = bounced('A stale transcript ending.', { last_assistant_message: 'Compacting now' });
      expect(out?.decision).toBe('block');
    });

    it('allows the same wording when the current turn contains the matching tool call', () => {
      const r = run(
        payload({
          hook_event_name: 'Stop',
          session_id: 'claimed-action-session',
          transcript_path: transcriptWithToolUseThenText('Compacting now'),
        }),
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('still bounces when the current turn contains only an unrelated tool call', () => {
      const p = transcriptWithToolUseThenText('Compacting now', 'Bash');
      const r = run(payload({ hook_event_name: 'Stop', session_id: 'claimed-action-session', transcript_path: p }));
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.decision).toBe('block');
      expect(out.reason).toMatch(/matching session:request-compaction/);
    });

    // EI-23745075736001151 — a colon-form tool dispatched through tools:invoke
    // appears in the transcript under the DISPATCHER's name, with the tool that
    // really ran named only in its arguments. Reading the outer name alone
    // reported a genuine session:request-compaction as never made and refused
    // the stop, livelocking the carry-respawn (which needs a quiet pty) on
    // precisely the door the su playbook mandates for colon-form names.
    const transcriptWithDispatchedToolUse = (
      text: string,
      dispatchedName: string,
      outerName = 'mcp__papercusp-su__tools_invoke',
      argsKey = 'input',
    ) => {
      const p = join(tmp, `dispatched-${Math.random().toString(36).slice(2)}.jsonl`);
      const entries = [
        { type: 'user', message: { content: [{ type: 'text', text: 'Continue.' }] } },
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: outerName,
                [argsKey]: { name: dispatchedName, args: { autoContinue: true } },
              },
            ],
          },
        },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text }] } },
      ];
      fs.writeFileSync(p, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      return p;
    };

    const stopWith = (transcript_path: string) =>
      run(payload({ hook_event_name: 'Stop', session_id: 'claimed-action-session', transcript_path }));

    it.each([
      ['mcp__papercusp-su__tools_invoke', 'input'],
      ['mcp__papercusp__tools_invoke', 'input'],
      ['tools:invoke', 'input'],
      ['tools_invoke', 'tool_input'],
    ])('ALLOWS a real session:request-compaction dispatched via %s', (outerName, argsKey) => {
      const r = stopWith(transcriptWithDispatchedToolUse('Compacting now', 'session:request-compaction', outerName, argsKey));
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('still BOUNCES when tools:invoke dispatched an unrelated tool', () => {
      const r = stopWith(transcriptWithDispatchedToolUse('Compacting now', 'work_items:get'));
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.decision).toBe('block');
      expect(out.reason).toMatch(/matching session:request-compaction/);
    });

    it('still BOUNCES when tools:invoke carries no dispatched name at all', () => {
      const p = join(tmp, `dispatched-nameless-${Math.random().toString(36).slice(2)}.jsonl`);
      const entries = [
        { type: 'user', message: { content: [{ type: 'text', text: 'Continue.' }] } },
        {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'mcp__papercusp-su__tools_invoke', input: {} }] },
        },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Compacting now' }] } },
      ];
      fs.writeFileSync(p, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      const r = stopWith(p);
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.decision).toBe('block');
    });

    it.each([
      'I will compact after the owner confirms the route.',
      'The report explains why the prior agent wrote “Compacting now” as an example.',
      'The compaction detector is covered by the focused suite.',
    ])('allows non-imminent or quoted action language: %s', (text) => {
      const r = run(payload({ hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptWith(text) }));
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });
  });

  it('Stop with a bare question-shaped ending and NO <ask> tag → BOUNCE (decision:block)', () => {
    const r = run(
      payload({ hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptWith('Should I proceed with the migration now?') }),
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(/coord:escalate/);
  });

  // inbox-pane-active-scope-dates-filters-2026-07-19 P-403 (D-2/b): the bounce
  // must steer the re-emit to the NATIVE AskUserQuestion tool (renders a proper
  // terminal dialog + is mirrored to the Inbox), NOT to a raw <ask> text tag
  // (which a TUI renders as unreadable XML — the owner's 2026-07-19 complaint).
  it('the bounce steers to the native AskUserQuestion tool and warns AGAINST a raw <ask> tag', () => {
    const r = run(
      payload({ hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptWith('Should I proceed with the migration now?') }),
    );
    const out = JSON.parse(r.stdout);
    expect(out.reason).toMatch(/AskUserQuestion/);
    // It may MENTION <ask> only to prohibit it — assert the prohibition wording
    // is present, so the reason never reads as a recommendation to emit the tag.
    expect(out.reason).toMatch(/Do NOT emit a raw <ask>/i);
  });

  // WI-5865 — the DEFERRED-DELIVERABLE bounce. Owner-reported 2026-07-25: an su
  // ended two consecutive turns with "next turn I'll put the plan in front of
  // you" while already holding the finished plan. The PreToolUse delivery guard
  // is blind to it by construction (a turn that asks nothing never trips it), so
  // the Stop branch is the only place it can be caught.
  describe('deferred-deliverable bounce (WI-5865)', () => {
    const bounced = (text: string) => {
      const r = run(payload({ hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptWith(text) }));
      expect(r.status).toBe(0);
      return r.stdout ? JSON.parse(r.stdout) : null;
    };

    it.each([
      "Next turn I'll put the plan and the route choice in front of you.",
      "I'll lay out the full options next turn.",
      "Investigated all six. I will present the analysis in my next message.",
      "Let me write up the comparison next turn.",
    ])('BOUNCES a withheld deliverable: %s', (text) => {
      const out = bounced(text);
      expect(out?.decision).toBe('block');
      expect(out.reason).toMatch(/DEFERRING something/);
      // The reason must TEACH the fix (write it now → end → ask next turn),
      // not merely refuse the stop.
      expect(out.reason).toMatch(/in THIS turn/i);
    });

    // EI-19412167276099357 defect 2: a deferred QUESTION ("I'll ask … next
    // message") used to slip past — the delivery-verb list only covered
    // deliverable-handoff verbs, not asking. Measured live 2026-08-03.
    it.each([
      "I'll ask how you want this executed in the next message.",
      "I'll confirm the route with you in the next message.",
      "Let me check with you next turn on which lane to take.",
    ])('BOUNCES a deferred question: %s', (text) => {
      const out = bounced(text);
      expect(out?.decision).toBe('block');
      expect(out.reason).toMatch(/DEFERRING something/);
      // The reason must teach "ask NOW", not just "write the content now" —
      // this class of bounce has no deliverable to write out.
      expect(out.reason).toMatch(/ask it NOW/i);
    });

    it.each([
      // Real future WORK, not withheld content — the loop-cadence false positive
      // this heuristic exists to avoid.
      "Next turn I'll re-check whether the deploy landed.",
      "I'll continue with lane B next turn.",
      // "next wake" is legitimate armed-loop cadence and must never bounce.
      "Next wake I'll send the burn-down summary to the leader.",
      // A deliverable DELIVERED this turn, with no future-turn promise.
      'Here is the plan: lane A ships first. All done, tests pass.',
    ])('ALLOWS legitimate future work: %s', (text) => {
      const r = run(payload({ hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptWith(text) }));
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('the three signals must co-occur in ONE sentence, not merely somewhere in a long report', () => {
      const r = run(
        payload({
          hook_event_name: 'Stop',
          session_id: 's1',
          transcript_path: transcriptWith(
            'Here is the full plan, written out in detail. The migration lands first.\n' +
              "Next turn I'll start on it.",
          ),
        }),
      );
      expect(r.stdout).toBe('');
    });

    it('a deferring turn that ALSO carries an <ask> tag still bounces (mirror fires, then bounce)', () => {
      const out = bounced('Which route do you want? <ask>{"question":"Which route?"}</ask>\nNext turn I\'ll send the plan.');
      expect(out?.decision).toBe('block');
      expect(out.reason).toMatch(/DEFERRING something/);
    });

    // EI-19412167276099357 defect 3: a turn that QUOTES the banned pattern as
    // evidence — a fenced/indented example, an inline-code fixture, a
    // |-delimited table row — must never be scanned as if it were the
    // agent's own closing sentence. Mirrors the real false positive: a reply
    // that fully delivered its analysis, but cited the pattern's fixtures.
    it.each([
      'Root-caused it. The trap looks like:\n\n    I\'ll put the plan in front of you next turn.\n\nThis turn delivers the fix in full; nothing is withheld.',
      'Fixture: `I\'ll lay out the options next turn` was the exact string that tripped it. This turn is done; everything above is the complete write-up.',
      '| example | trips it |\n| --- | --- |\n| I\'ll present the plan next turn | yes |\n\nAll findings are above in full; nothing deferred.',
    ])('ALLOWS a turn that only QUOTES the pattern as evidence: %s', (text) => {
      const r = run(payload({ hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptWith(text) }));
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('a REAL deferral is still caught even alongside a quoted table elsewhere in the turn', () => {
      const out = bounced('| col1 | col2 |\n| a | b |\n\nI\'ll lay out the options next turn.');
      expect(out?.decision).toBe('block');
      expect(out.reason).toMatch(/DEFERRING something/);
    });

    it('is loop-guarded: stop_hook_active:true → allow, so the bounce can never double-fire', () => {
      const r = run(
        payload({
          hook_event_name: 'Stop',
          session_id: 's1',
          transcript_path: transcriptWith("Next turn I'll put the plan in front of you."),
          stop_hook_active: true,
        }),
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });
  });

  it('Stop with a question ending but stop_hook_active:true → loop-guarded, allow (no bounce)', () => {
    const r = run(
      payload({
        hook_event_name: 'Stop',
        session_id: 's1',
        transcript_path: transcriptWith('Should I proceed with the migration now?'),
        stop_hook_active: true,
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('Stop with a <ask> tag present → allow (structured mirror found, no bounce)', () => {
    const r = run(
      payload({
        hook_event_name: 'Stop',
        session_id: 's1',
        transcript_path: transcriptWith('Status update. <ask>{"question":"Which route?"}</ask>'),
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('Stop with a malformed <ask> tag body → falls through to question-shaped-ending check (no <ask> text left after the tag, so no bounce here since the line before the tag is not itself question-shaped)', () => {
    const r = run(
      payload({
        hook_event_name: 'Stop',
        session_id: 's1',
        transcript_path: transcriptWith('Update. <ask>{not valid json</ask>'),
      }),
    );
    expect(r.status).toBe(0);
    // The final non-blank line is the whole malformed-tag line, which does not end in
    // "?" — so this is neither a valid mirror NOR a question-shaped ending: allow.
    expect(r.stdout).toBe('');
  });

  it('Stop with a code-fence last line ending in "?" → NOT question-shaped (narrow heuristic), allow', () => {
    const r = run(
      payload({
        hook_event_name: 'Stop',
        session_id: 's1',
        transcript_path: transcriptWith('Here:\n```ts\nconst x = a ?? b?\n```'),
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('Stop with no transcript_path (unreadable) → allow, never throws', () => {
    const r = run(payload({ hook_event_name: 'Stop', session_id: 's1', transcript_path: '/nonexistent/path.jsonl' }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('an unrecognized hook_event_name → no-op, allow', () => {
    const r = run(payload({ hook_event_name: 'SessionStart' }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  // EI-14208: the Stop-branch mirror calls (notify-clear, ask-escalate) used to
  // fail completely silently against an unreachable/wedged operator — this hit
  // in production with zero trace left behind. They now retry once and, on
  // final failure, append a one-line marker to a local errors log so a real
  // miss is distinguishable, after the fact, from "legitimately nothing to
  // mirror" — while the hook itself still stays fail-open (exit 0, empty
  // stdout: the owner-facing contract is unchanged).
  it('EI-14208: a Stop mirror-call failure against an unreachable operator is logged, not silently dropped', () => {
    const logPath = join(home, '.papercusp', 'hooks', 'cc', 'ask-gate-mirror.errors.log');
    fs.rmSync(logPath, { force: true });
    const r = run(
      payload({
        hook_event_name: 'Stop',
        session_id: 'log-test-session',
        transcript_path: transcriptWith('Status: done. <ask>{"question":"Ship it now?"}</ask>'),
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    const log = fs.readFileSync(logPath, 'utf8');
    expect(log).toContain('log-test-session');
    expect(log).toContain('stop-ask-escalate-failed');
    expect(log).toContain('stop-notify-clear-failed');
  });

  it('EI-14208: a malformed operator URL (Request() itself raises) still fail-opens, and is caught + logged by call_tool rather than crashing the hook process', () => {
    // http://[::1 is an invalid IPv6 literal — urllib.request.Request() raises
    // ValueError at construction, BEFORE urlopen is ever reached. This used to
    // sit outside call_tool's try/except (see EI-14208), which would crash the
    // whole python body uncaught; it's now inside the try, so it funnels
    // through the same retry+log path as any other request failure.
    const logPath = join(home, '.papercusp', 'hooks', 'cc', 'ask-gate-mirror.errors.log');
    fs.rmSync(logPath, { force: true });
    const r = run(
      payload({ hook_event_name: 'Stop', session_id: 'bad-url-session', transcript_path: transcriptWith('All good.') }),
      { PAPERCUSP_OPERATOR_URL: 'http://[::1' },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    const log = fs.readFileSync(logPath, 'utf8');
    expect(log).toContain('bad-url-session');
    expect(log).toContain('stop-notify-clear-failed');
  });
});

// ── OPERATOR-DEPENDENT (in-process HTTP stub) ───────────────────────────────

describe('ask-gate-mirror — operator-dependent request bodies', () => {
  let home: string;
  let server: Server;
  let port: number;
  let lastCalls: Array<{ tool: string; args: Record<string, any>; url: string }>;

  beforeAll(async () => {
    home = fs.mkdtempSync(join(os.tmpdir(), 'askgate-stub-home-'));
    fs.mkdirSync(join(home, '.papercusp'), { recursive: true });
    fs.writeFileSync(join(home, '.papercusp', 'superuser-token'), 'test-token\n');

    server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const rpc = JSON.parse(body) as { params: { name: string; arguments: Record<string, any> } };
        lastCalls.push({ tool: rpc.params.name, args: rpc.params.arguments, url: req.url ?? '' });
        const result = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  });
  beforeEach(() => {
    lastCalls = [];
  });

  const tmp = fs.mkdtempSync(join(os.tmpdir(), 'askgate-stub-tmp-'));
  afterEach(() => {
    for (const f of fs.readdirSync(tmp)) fs.rmSync(join(tmp, f), { force: true });
  });
  const transcriptWith = (text: string) => {
    const p = join(tmp, `t-${Math.random().toString(36).slice(2)}.jsonl`);
    fs.writeFileSync(p, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n');
    return p;
  };

  async function run(input: object) {
    return runHookProcess('bash', [HOOK], {
      input: JSON.stringify(input),
      env: { HOME: home, PAPERCUSP_SID: 'su-test', PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${port}` },
    });
  }

  it.each(['session_id', 'sessionId'])('binds %s to the request context for successive incarnations of the same owner', async (sessionKey) => {
    const sessions = ['b498efb5-b135-4cc8-8266-82833e929d52', 'd7fa5010-bb1f-4d17-841d-f31a1fb4cb95'];
    for (const sessionId of sessions) {
      const r = await run({
        hook_event_name: 'PostToolUse',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'same-ref',
        [sessionKey]: sessionId,
        tool_input: {},
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    }
    expect(lastCalls).toHaveLength(2);
    expect(lastCalls.map((call) => call.args.sessionId)).toEqual(sessions);
    const contexts = lastCalls.map((call) => new URL(call.url, 'http://127.0.0.1'));
    expect(contexts.map((url) => url.searchParams.get('native_session'))).toEqual(sessions);
    for (const url of contexts) {
      expect(url.pathname).toBe('/api/mcp');
      expect(url.searchParams.get('client')).toBe('su-test');
      expect(url.searchParams.get('origin')).toBe('hook');
      expect(url.searchParams.get('superuser')).toBe('1');
    }
  });

  it('PreToolUse AskUserQuestion → opens a gate with kind:ask, the question + options + refId', async () => {
    const r = await run({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-1',
      session_id: 'sess-1',
      tool_input: {
        questions: [
          {
            question: 'Which route?',
            header: 'Route',
            multiSelect: false,
            options: [
              { label: 'Yourself', description: 'do it now' },
              { label: 'Fleet' },
            ],
          },
        ],
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(lastCalls).toHaveLength(1);
    expect(lastCalls[0].tool).toBe('sessions:ingest-gate-event');
    expect(lastCalls[0].args).toMatchObject({
      sessionId: 'sess-1',
      client: 'claude',
      kind: 'ask',
      refId: 'tu-1',
      question: 'Which route?',
      ownerId: 'su-test',
    });
    expect(lastCalls[0].args.options).toEqual([
      { label: 'Yourself', description: 'do it now' },
      { label: 'Fleet' },
    ]);
  });

  it('PreToolUse AskUserQuestion with MULTIPLE questions → mirrors the first, notes the rest', async () => {
    const r = await run({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-2',
      session_id: 'sess-1',
      tool_input: { questions: [{ question: 'First?', header: 'H', multiSelect: false, options: [] }, { question: 'Second?', header: 'H2', multiSelect: false, options: [] }] },
    });
    expect(r.status).toBe(0);
    expect(lastCalls[0].args.question).toBe('First? (+1 more question)');
  });

  it('PreToolUse ExitPlanMode → opens a gate with a fixed question + the plan as text', async () => {
    const r = await run({
      hook_event_name: 'PreToolUse',
      tool_name: 'ExitPlanMode',
      tool_use_id: 'tu-3',
      session_id: 'sess-1',
      tool_input: { plan: '## My plan\n1. do a thing' },
    });
    expect(r.status).toBe(0);
    expect(lastCalls[0].args).toMatchObject({
      kind: 'ask',
      refId: 'tu-3',
      question: 'Approve this plan?',
      text: '## My plan\n1. do a thing',
    });
  });

  it('PostToolUse AskUserQuestion → closes the SAME refId with kind:cleared', async () => {
    const r = await run({
      hook_event_name: 'PostToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-1',
      session_id: 'sess-1',
      tool_input: {},
      tool_response: { optionId: 'yourself' },
    });
    expect(r.status).toBe(0);
    expect(lastCalls[0].args).toMatchObject({ sessionId: 'sess-1', kind: 'cleared', refId: 'tu-1' });
  });

  it('Notification mentioning "permission" → opens a permission_wait gate keyed on notify:<session>', async () => {
    const r = await run({
      hook_event_name: 'Notification',
      session_id: 'sess-9',
      message: 'Claude needs your permission to use Bash',
    });
    expect(r.status).toBe(0);
    expect(lastCalls[0].args).toMatchObject({
      sessionId: 'sess-9',
      kind: 'permission_wait',
      refId: 'notify:sess-9',
      ownerId: 'su-test',
    });
    expect(lastCalls[0].args.text).toContain('permission');
  });

  it('Stop mirrors a structured <ask> tag to coord:escalate (severity:question, options mapped)', async () => {
    const r = await run({
      hook_event_name: 'Stop',
      session_id: 'sess-1',
      transcript_path: transcriptWith(
        'Status: done. <ask>{"question":"Ship it now?","options":[{"id":"y","label":"Yes"},{"id":"n","label":"No"}],"refs":["WI-1"]}</ask>',
      ),
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
    // Two calls: the best-effort notify-gate clear, then the escalate mirror.
    const escalate = lastCalls.find((c) => c.tool === 'coord:escalate');
    expect(escalate).toBeDefined();
    expect(escalate!.args).toMatchObject({ severity: 'question', summary: 'Ship it now?', body: 'refs: WI-1' });
    expect(escalate!.args.options).toEqual([
      { id: 'y', label: 'Yes' },
      { id: 'n', label: 'No' },
    ]);
  });

  it('Stop always best-effort-clears the notify:<session> gate first', async () => {
    await run({ hook_event_name: 'Stop', session_id: 'sess-5', transcript_path: transcriptWith('All good.') });
    const clear = lastCalls.find((c) => c.tool === 'sessions:ingest-gate-event' && c.args.kind === 'cleared');
    expect(clear).toBeDefined();
    expect(clear!.args.refId).toBe('notify:sess-5');
  });
});
