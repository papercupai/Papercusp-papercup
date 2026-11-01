/** Turn refs (deterministic-context-carry P-014) — ref format/parse, recorded-
 *  turn owner-vs-agent classification, and transcript verification. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyRecordedTurn,
  classifyRecordedUserTurn,
  HOOK_PROVENANCE_STAMP_PREFIXES,
  OWNER_DIALOG_TURN_MARKER,
  formatTurnRef,
  parseHookProvenanceStamp,
  parseTurnRefs,
  parseUserTurns,
  quoteMatchesTurn,
  resolveCurrentTurnStamp,
  UNVERIFIED_HOOK_ORIGIN,
  verifyTurnRefs,
} from './turn-ref';

const SID = 'bf1881bc-9fd9-4875-bb24-3b40796205db';
import { dialogAnswerText } from '../transcript-wire';

const userLine = (text: string, ts: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text }, ...extra });
const assistantLine = (text: string, ts: string) =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] } });

describe('formatTurnRef / parseTurnRefs', () => {
  it('round-trips: format produces what parse recognizes', () => {
    const ref = formatTurnRef(SID, '2026-07-14T17:42:41.307Z');
    expect(ref).toBe('[turn:bf1881bc@2026-07-14T17:42:41.307Z]');
    const parsed = parseTurnRefs(`the owner said to ship dark ${ref}`);
    expect(parsed).toEqual([
      { sessionPrefix: 'bf1881bc', ts: '2026-07-14T17:42:41.307Z', raw: ref },
    ]);
  });

  it('finds multiple refs; empty/none yields []', () => {
    const text = `a [turn:abcd1234@2026-07-14T10:00:00Z] b [turn:ffff0000@2026-07-13T09:30:00.123Z] c`;
    expect(parseTurnRefs(text)).toHaveLength(2);
    expect(parseTurnRefs('no refs here')).toEqual([]);
    expect(parseTurnRefs(null)).toEqual([]);
  });

  it('parses namespaced Codex refs emitted by the current session surface', () => {
    const ref = '[turn:codex:01a029f0-dec6-7022-871d-92e4ca8f28ed@2026-08-22T14:51:07.729Z]';
    expect(parseTurnRefs(`posted evidence ${ref}`)).toEqual([
      expect.objectContaining({
        sessionPrefix: 'codex:01a029f0-dec6-7022-871d-92e4ca8f28ed',
        ts: '2026-08-22T14:51:07.729Z',
        raw: ref,
      }),
    ]);
  });

  // EI-12890: the ref alone only proves a turn EXISTS — the attached quote is
  // what a fabricated citation gets wrong, so it must be extracted too.
  it('captures the quote immediately following a ref (the documented `[turn:…]: "…"` shape)', () => {
    const ref = formatTurnRef(SID, '2026-07-15T19:50:23Z');
    const [parsed] = parseTurnRefs(`OWNER DIRECTIVE (interactive) ${ref}: "now get our 0.0.11 release out on all 3 platforms"`);
    expect(parsed.quote).toBe('now get our 0.0.11 release out on all 3 platforms');
  });

  it('captures a quote immediately preceding a ref, when no quote follows it', () => {
    const ref = formatTurnRef(SID, '2026-07-15T19:50:23Z');
    const [parsed] = parseTurnRefs(`the owner said "ship it now" ${ref}`);
    expect(parsed.quote).toBe('ship it now');
  });

  it('a ref with no nearby quote leaves `quote` undefined (not a wrong guess)', () => {
    const ref = formatTurnRef(SID, '2026-07-15T19:50:23Z');
    const [parsed] = parseTurnRefs(`carried forward per ${ref}`);
    expect(parsed.quote).toBeUndefined();
  });

  // Two quoted directives whose combined span exceeds the lookback window: the
  // window clips the FIRST quote's opening char, and an unanchored scan then
  // pairs its leftover closing quote with the second quote's opener — the
  // extracted "claim" becomes the prose BETWEEN the directives and the lint
  // flags a genuine owner quote as fabricated (seen live 2026-07-17).
  it('a clipped earlier quote must not shift pairing — the second ref still gets ITS adjacent quote', () => {
    const q1 = 'continue with all the remaining steps required to finish these remaining items';
    const q2 = 'put yourself on auto mode and continue where you left off';
    const ref1 = formatTurnRef(SID, '2026-07-17T04:50:14.437Z');
    const ref2 = formatTurnRef(SID, '2026-07-17T07:16:26.253Z');
    const text = `Authority:\n- owner directive "${q1}" ${ref1}\n- AUTO mode owner-directed "${q2}" ${ref2}`;
    const parsed = parseTurnRefs(text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].quote).toBe(q1);
    expect(parsed[1].quote).toBe(q2);
  });
});

describe('quoteMatchesTurn', () => {
  it('matches case/whitespace-insensitively as a substring', () => {
    expect(quoteMatchesTurn('ship it now', 'okay,   SHIP   it NOW please')).toBe(true);
    expect(quoteMatchesTurn('now get our 0.0.11 release out on all 3 platforms', 'I got logged out. Continue where you left off.')).toBe(false);
  });
});

describe('classifyRecordedTurn', () => {
  it('an enrolled-injector envelope is decisive: agent-injected, origin extracted', () => {
    const r = classifyRecordedTurn('⟦turn-origin:wake-pump nonce:a1b2c3d4e5f60718⟧\ndo the thing');
    expect(r).toEqual({ verdict: 'agent-injected', origin: 'wake-pump' });
  });

  it('does not treat a legacy dialog marker as proof of human authorship', () => {
    expect(
      classifyRecordedTurn(`${OWNER_DIALOG_TURN_MARKER}\nThe user answered: "Ship?"="yes".`),
    ).toEqual({ verdict: 'unknown', origin: 'unverified-dialog' });
  });

  it('system-notification banners and compaction continuations are machine-surface', () => {
    expect(
      classifyRecordedTurn('[SYSTEM NOTIFICATION - NOT USER INPUT]\nbackground task done').verdict,
    ).toBe('machine-surface');
    expect(
      classifyRecordedTurn('This session is being continued from a previous conversation that ran out of context.')
        .verdict,
    ).toBe('machine-surface');
  });

  it('local-command plumbing is synthetic; a plain prompt is owner-typed', () => {
    expect(classifyRecordedTurn('<local-command-stdout>ok</local-command-stdout>').verdict).toBe('synthetic');
    expect(classifyRecordedTurn('please ship the release')).toEqual({
      verdict: 'owner-typed',
      origin: null,
    });
  });

  it('a mid-text envelope (quoted content) does NOT classify the turn', () => {
    expect(
      classifyRecordedTurn('note: injectors prefix ⟦turn-origin:loop-fire nonce:aabbccdd00112233⟧ to turns').verdict,
    ).toBe('owner-typed');
  });

  // The transcript classifier feeds the carry-doc continuation (P-010): a
  // machine turn misread as owner-typed would become a successor's "open owner
  // message" first prompt. These are the un-enrolled machine surfaces observed
  // in real psu transcripts — each must land NOT-owner (machine-surface).
  it('a Task-subsystem completion notification is machine-surface, not owner', () => {
    expect(
      classifyRecordedTurn(
        '<task-notification> <task-id>btjclo7aj</task-id> <summary>Monitor event fired</summary> </task-notification>',
      ).verdict,
    ).toBe('machine-surface');
  });

  it('classifies Codex Stop-hook wrappers without attributing quoted wrappers to the owner', () => {
    const wrapped =
      '<hook_prompt hook_run_id=stop:22:/tmp/hooks.json>\n' +
      '⟦turn-origin:stop-hook nonce:a1b2c3d4e5f60718⟧\nSTOP CONTEXT';
    expect(classifyRecordedTurn(wrapped)).toEqual({ verdict: 'agent-injected', origin: 'stop-hook' });
    expect(classifyRecordedTurn('<hook_prompt hook_run_id=stop:22:/tmp/hooks.json>\nSTOP CONTEXT').verdict).toBe(
      'machine-surface',
    );
    expect(classifyRecordedTurn('Owner quoted ' + wrapped).verdict).toBe('owner-typed');
  });

  it('the TUI interrupt marker is machine-surface (owner action, but not an owner directive)', () => {
    expect(classifyRecordedTurn('[Request interrupted by user]').verdict).toBe('machine-surface');
    expect(classifyRecordedTurn('[Request interrupted by user for tool use]').verdict).toBe('machine-surface');
  });

  it('a self-issued /compact command self-declares machine provenance (rides after the slash prefix)', () => {
    expect(
      classifyRecordedTurn(
        '/compact ⟦machine-issued self-compaction — not owner-typed⟧ Resume Phase 6; keep the identity block.',
      ).verdict,
    ).toBe('machine-surface');
  });

  it('the compaction UI status echo is machine-surface', () => {
    expect(
      classifyRecordedTurn(' ✻ Conversation compacted (ctrl+o for history)   ● Compaction is queued').verdict,
    ).toBe('machine-surface');
  });

  it('an owner turn that merely MENTIONS these surfaces mid-sentence stays owner-typed', () => {
    // No special bracket / head marker → the owner discussing the feature is
    // not mistaken for the machine surface itself.
    expect(
      classifyRecordedTurn('can we make the task notification and the request interrupted marker classify correctly?')
        .verdict,
    ).toBe('owner-typed');
    // A plain owner /compact-shaped sentence without the ⟦machine-issued⟧ marker
    // (no bracket glyph) is still owner prose.
    expect(classifyRecordedTurn('compact the plan into fewer items please').verdict).toBe('owner-typed');
  });
});

describe('verifyTurnRefs / resolveCurrentTurnStamp (tmp transcript)', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'papercusp-turn-ref-test-'));
    file = join(dir, `${SID}.jsonl`);
    writeFileSync(
      file,
      [
        userLine('ship the release when green', '2026-07-14T10:00:00.000Z'),
        assistantLine('on it', '2026-07-14T10:00:05.000Z'),
        userLine('⟦turn-origin:loop-fire nonce:a1b2c3d4e5f60718⟧\ncontinue the loop', '2026-07-14T11:00:00.000Z'),
        userLine('<local-command-stdout>ok</local-command-stdout>', '2026-07-14T11:30:00.000Z'),
      ].join('\n') + '\n',
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('verifies an owner-typed ref (found + owner-typed + snippet)', async () => {
    const refs = parseTurnRefs(formatTurnRef(SID, '2026-07-14T10:00:00.000Z'));
    const [v] = await verifyTurnRefs('owner-x', refs, { filePath: file, sessionId: SID });
    expect(v.found).toBe(true);
    expect(v.verdict).toBe('owner-typed');
    expect(v.snippet).toContain('ship the release');
  });

  // EI-12890 reproduction: the ref resolves to a REAL, owner-typed turn — but
  // the quote attached to it is NOT what that turn actually said (a fabricated
  // citation, exactly the shape that defeated the guard live). A resolvable
  // ref must not be treated as sufficient on its own.
  it('EI-12890: a resolvable owner-typed ref with a FABRICATED quote reports quoteMatch:false', async () => {
    const text = `OWNER DIRECTIVE (interactive, this session) ${formatTurnRef(SID, '2026-07-14T10:00:00.000Z')}: "now get our 0.0.11 release out on all 3 platforms"`;
    const refs = parseTurnRefs(text);
    expect(refs[0].quote).toBe('now get our 0.0.11 release out on all 3 platforms');
    const [v] = await verifyTurnRefs('owner-x', refs, { filePath: file, sessionId: SID });
    expect(v.found).toBe(true);
    expect(v.verdict).toBe('owner-typed'); // the turn is genuine and owner-typed…
    expect(v.quote).toBe('now get our 0.0.11 release out on all 3 platforms');
    expect(v.quoteMatch).toBe(false); // …but never said what's claimed
  });

  it('a resolvable ref with a quote that genuinely matches reports quoteMatch:true', async () => {
    const text = `${formatTurnRef(SID, '2026-07-14T10:00:00.000Z')}: "ship the release when green"`;
    const refs = parseTurnRefs(text);
    const [v] = await verifyTurnRefs('owner-x', refs, { filePath: file, sessionId: SID });
    expect(v.quoteMatch).toBe(true);
  });

  it('a ref with no attached quote reports quote:null, quoteMatch:null (nothing to check)', async () => {
    const refs = parseTurnRefs(formatTurnRef(SID, '2026-07-14T10:00:00.000Z'));
    const [v] = await verifyTurnRefs('owner-x', refs, { filePath: file, sessionId: SID });
    expect(v.quote).toBeNull();
    expect(v.quoteMatch).toBeNull();
  });

  it('classifies a machine-injected ref agent-injected with its origin', async () => {
    const refs = parseTurnRefs(formatTurnRef(SID, '2026-07-14T11:00:00.000Z'));
    const [v] = await verifyTurnRefs('owner-x', refs, { filePath: file, sessionId: SID });
    expect(v.found).toBe(true);
    expect(v.verdict).toBe('agent-injected');
    expect(v.origin).toBe('loop-fire');
  });

  it('matches a seconds-truncated ref timestamp', async () => {
    const refs = parseTurnRefs(`[turn:bf1881bc@2026-07-14T10:00:00Z]`);
    const [v] = await verifyTurnRefs('owner-x', refs, { filePath: file, sessionId: SID });
    // ref ts 'T10:00:00Z' vs recorded 'T10:00:00.000Z' — prefix-to-seconds match
    expect(v.found).toBe(true);
  });

  it('matches equivalent local-offset and UTC timestamp representations', async () => {
    await writeFile(file, `${userLine('stored local timestamp', '2026-07-14 06:00:00.123-04')}\n`, { flag: 'a' });

    const localRef = parseTurnRefs('[turn:bf1881bc@2026-07-14T06:00:00.123-04:00]');
    const [localVerdict] = await verifyTurnRefs('owner-x', localRef, { filePath: file, sessionId: SID });
    expect(localVerdict.found).toBe(true);

    const utcRef = parseTurnRefs('[turn:bf1881bc@2026-07-14T10:00:00.123Z]');
    const [utcVerdict] = await verifyTurnRefs('owner-x', utcRef, { filePath: file, sessionId: SID });
    expect(utcVerdict.found).toBe(true);
  });

  it('a ref into a DIFFERENT session never matches this transcript', async () => {
    const refs = parseTurnRefs('[turn:deadbeef@2026-07-14T10:00:00.000Z]');
    const [v] = await verifyTurnRefs('owner-x', refs, { filePath: file, sessionId: SID });
    expect(v.found).toBe(false);
  });

  it('unknown timestamp → found:false; unresolvable transcript → all miss (fail-soft)', async () => {
    const refs = parseTurnRefs(formatTurnRef(SID, '2026-07-14T23:59:59.000Z'));
    const [v] = await verifyTurnRefs('owner-x', refs, { filePath: file, sessionId: SID });
    expect(v.found).toBe(false);
    const [v2] = await verifyTurnRefs('owner-x', refs, { filePath: join(dir, 'missing.jsonl'), sessionId: SID });
    expect(v2.found).toBe(false);
  });

  it('resolveCurrentTurnStamp: latest non-synthetic turn, classified + ref formatted', async () => {
    const stamp = await resolveCurrentTurnStamp('owner-x', { filePath: file, sessionId: SID });
    // The last user entry is synthetic plumbing — the stamp lands on the
    // loop-fire injection before it.
    expect(stamp).toEqual({
      ref: '[turn:bf1881bc@2026-07-14T11:00:00.000Z]',
      verdict: 'agent-injected',
      origin: 'loop-fire',
    });
  });

  it('parseUserTurns keeps machine-injected turns (classification is per turn, not dropped)', () => {
    const turns = parseUserTurns(
      [userLine('hi', '2026-07-14T09:00:00Z'), userLine('⟦turn-origin:wake-pump nonce:aabbccdd00112233⟧\nwake', '2026-07-14T09:05:00Z')].join('\n'),
    );
    expect(turns).toHaveLength(2);
  });

  it('parseUserTurns reads native Codex response_item user messages', () => {
    const ts = '2026-08-26T13:46:56.884Z';
    const turns = parseUserTurns(JSON.stringify({
      timestamp: ts,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '⟦turn-origin:fleet-kickoff nonce:f5abd41d8d21b75f⟧\nresume' }],
      },
    }));

    expect(turns).toEqual([{
      ts,
      text: '⟦turn-origin:fleet-kickoff nonce:f5abd41d8d21b75f⟧\nresume',
    }]);
  });

  // EI-22171324436610992: an AskUserQuestion answer arrives as a `tool_result`
  // user line with NO plain-text block. session-ingest.ts's parseClaudeLine
  // already promotes this shape into the recall index (see its own tests),
  // but this raw-transcript reader used to drop it as "tool_result-only
  // plumbing" — so a ref pointing at a real, resolvable-by-sessions:read
  // owner-dialog turn came back found:false from verifyTurnRefs's default
  // (owner-chain / current-session) scope. It must resolve the same way here.
  it('parseUserTurns promotes a Claude AskUserQuestion tool_result-only turn (owner-dialog)', () => {
    const answer = 'The user answered: "Ship?"="yes". Read the answers carefully.';
    const ts = '2026-09-01T15:49:35.226Z';
    const turns = parseUserTurns(
      JSON.stringify({
        type: 'user',
        timestamp: ts,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_ask', content: answer }],
        },
      }),
    );
    expect(turns).toEqual([{ ts, text: dialogAnswerText(answer) }]);
    expect(classifyRecordedTurn(turns[0].text)).toEqual({ verdict: 'unknown', origin: 'unverified-dialog' });
  });

  // Regression guard for the same change: an ordinary (non-dialog) tool_result
  // -only line must still be dropped as plumbing, not swept up by the new check.
  it('parseUserTurns still drops an ordinary tool_result-only line', () => {
    const turns = parseUserTurns(
      JSON.stringify({
        type: 'user',
        timestamp: '2026-09-01T15:49:35.226Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'command output' }],
        },
      }),
    );
    expect(turns).toEqual([]);
  });

  // WI-2141807: a prompt the owner typed WHILE A TURN WAS RUNNING is queued
  // and absorbed once the turn completes — recorded as a top-level
  // `attachment`/`queued_command` line, never the ordinary `type:'user'`
  // shape. session-ingest.ts's parseClaudeLine already promotes this shape
  // (see its own tests), but this raw-transcript reader used to only match
  // `type:'user'`/`type:'response_item'` and silently dropped it — so a ref
  // pointing at a real, resolvable-by-sessions:search owner-typed turn came
  // back found:false from verifyTurnRefs's default (owner-chain) scope.
  it('parseUserTurns promotes a Claude queued_command (owner-typed-while-busy) turn', () => {
    const prompt = 'ONCE THEY ARE PAUSED KILL THEM ALL';
    const ts = '2026-09-01T23:01:08.844Z';
    const turns = parseUserTurns(
      JSON.stringify({
        type: 'attachment',
        timestamp: ts,
        sessionId: SID,
        attachment: {
          type: 'queued_command',
          commandMode: 'prompt',
          origin: { kind: 'human' },
          prompt,
          timestamp: ts,
        },
      }),
    );
    expect(turns).toEqual([{ ts, text: prompt }]);
    expect(classifyRecordedTurn(turns[0].text)).toEqual({ verdict: 'owner-typed', origin: null });
  });

  // Regression guards for the same change: a non-human origin, a non-'prompt'
  // commandMode, and an empty prompt must all still be dropped — the gate is
  // exactly as narrow as session-ingest.ts's parseClaudeQueuedCommand.
  it('parseUserTurns drops a non-human or non-prompt queued_command attachment', () => {
    const base = {
      type: 'attachment',
      timestamp: '2026-09-01T23:01:08.844Z',
      attachment: {
        type: 'queued_command',
        commandMode: 'prompt',
        origin: { kind: 'human' },
        prompt: 'ignored either way',
        timestamp: '2026-09-01T23:01:08.844Z',
      },
    };
    expect(parseUserTurns(JSON.stringify({ ...base, attachment: { ...base.attachment, origin: { kind: 'assistant' } } }))).toEqual([]);
    expect(parseUserTurns(JSON.stringify({ ...base, attachment: { ...base.attachment, commandMode: 'other' } }))).toEqual([]);
    expect(parseUserTurns(JSON.stringify({ ...base, attachment: { ...base.attachment, prompt: '   ' } }))).toEqual([]);
    expect(parseUserTurns(JSON.stringify({ ...base, attachment: { ...base.attachment, type: 'other' } }))).toEqual([]);
  });

  it('verifyTurnRefs resolves an owner-dialog (AskUserQuestion) ref via the raw transcript (owner-chain default scope)', async () => {
    const answer = 'The user answered: "provision the WorkOS values credentials now"="yes".';
    const ts = '2026-09-01T15:49:35.226Z';
    await writeFile(
      file,
      JSON.stringify({
        type: 'user',
        timestamp: ts,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_ask', content: answer }],
        },
      }) + '\n',
      { flag: 'a' },
    );
    const refs = parseTurnRefs(formatTurnRef(SID, ts));
    // No explicit `scope` — this is verifyTurnRefs's DEFAULT (owner-chain /
    // current-session, reading the raw transcript), the exact path the bug
    // report showed disagreeing with sessions:read.
    const [v] = await verifyTurnRefs('owner-x', refs, { filePath: file, sessionId: SID });
    expect(v.found).toBe(true);
    expect(v.checked).toBe(true);
    expect(v.verdict).toBe('unknown');
    expect(v.snippet).toContain('provision the WorkOS values credentials now');
  });

  // WI-2141807 end-to-end: the exact repro shape from the live bug report —
  // a genuinely owner-typed queued_command ref must resolve as owner-typed
  // via the same default (owner-chain) scope loop:checkpoint actually uses,
  // not just be recognized by parseUserTurns in isolation.
  it('verifyTurnRefs resolves a queued_command (owner-typed-while-busy) ref via the raw transcript (owner-chain default scope)', async () => {
    const prompt = 'ONCE THEY ARE PAUSED KILL THEM ALL';
    const ts = '2026-09-01T23:01:08.844Z';
    await writeFile(
      file,
      JSON.stringify({
        type: 'attachment',
        timestamp: ts,
        sessionId: SID,
        attachment: {
          type: 'queued_command',
          commandMode: 'prompt',
          origin: { kind: 'human' },
          prompt,
          timestamp: ts,
        },
      }) + '\n',
      { flag: 'a' },
    );
    const refs = parseTurnRefs(formatTurnRef(SID, ts));
    const [v] = await verifyTurnRefs('owner-x', refs, { filePath: file, sessionId: SID });
    expect(v.found).toBe(true);
    expect(v.checked).toBe(true);
    expect(v.verdict).toBe('owner-typed');
    expect(v.snippet).toContain('ONCE THEY ARE PAUSED KILL THEM ALL');
  });
});

// EI-19297300002186512: a checkpoint's [turn:…] ref was reported found:false
// for a GENUINE owner anchor because it lived in an OLDER session of the same
// owner's carry-respawn chain — verifyTurnRefs only ever loaded the
// current/newest transcript (resolveSelfSession's return). These reproduce
// the reported scenario end-to-end with no `opts.filePath` pin, so the
// resolution actually exercises the owner-isolation-dir fallback.
describe('verifyTurnRefs — cross-session (owner carry-respawn chain, EI-19297300002186512)', () => {
  // The exact session ids from the live report: ORIGINAL is where the owner
  // turn was actually spoken; CURRENT is the session the checkpoint write
  // happened FROM, after a cold carry-respawn.
  const ORIGINAL = '413a34fe-4e7c-4ca2-8e32-8135f52090b6';
  const CURRENT = 'e6fd19e9-1234-4abc-9def-012345678901';
  const OWNER = 'su-07374fbd-e848-4204-a92a-bb86a31e5a92';

  let home: string;
  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function seedOwnerIsolationDir(
    sessions: Array<{ id: string; lines: string[]; mtime: number }>,
  ): Promise<void> {
    home = await mkdtemp(join(tmpdir(), 'papercusp-turn-ref-crosssession-'));
    const proj = join(home, '.papercusp', 'session-claude', OWNER, 'projects', '-home-testuser-proj');
    await mkdir(proj, { recursive: true });
    for (const s of sessions) {
      const p = join(proj, `${s.id}.jsonl`);
      await writeFile(p, `${s.lines.join('\n')}\n`);
      await utimes(p, new Date(s.mtime), new Date(s.mtime));
    }
  }

  it('resolves a ref anchored to an OLDER session in the same owner chain — not just the current one', async () => {
    await seedOwnerIsolationDir([
      {
        id: ORIGINAL,
        mtime: 1_600_000_000_000,
        lines: [
          userLine(
            'this was to help agents have a theory of mind for eachother, I dont want to drop it',
            '2026-08-01T20:01:45.283Z',
          ),
        ],
      },
      {
        id: CURRENT,
        mtime: 1_600_000_600_000, // newer — this is the transcript resolveSelfSession alone would pick
        lines: [userLine('continue', '2026-08-02T16:07:00.000Z')],
      },
    ]);

    const refs = parseTurnRefs(formatTurnRef(ORIGINAL, '2026-08-01T20:01:45.283Z'));
    const [v] = await verifyTurnRefs(OWNER, refs, { home, loadActiveSessions: async () => [] });

    // Pre-fix: found:false — the ref's session prefix never matched CURRENT
    // (the only transcript ever checked), even though the cited turn is real.
    expect(v.found).toBe(true);
    expect(v.checked).toBe(true);
    expect(v.verdict).toBe('owner-typed');
    expect(v.snippet).toContain('theory of mind');
  });

  it('a ref for the CURRENT session still resolves without the fallback (no regression)', async () => {
    await seedOwnerIsolationDir([
      { id: CURRENT, mtime: 1_600_000_600_000, lines: [userLine('ship it', '2026-08-02T16:07:00.000Z')] },
    ]);

    const refs = parseTurnRefs(formatTurnRef(CURRENT, '2026-08-02T16:07:00.000Z'));
    const [v] = await verifyTurnRefs(OWNER, refs, { home, loadActiveSessions: async () => [] });

    expect(v.found).toBe(true);
    expect(v.checked).toBe(true);
  });

  it('a ref for a session outside this owner\'s known chain reports checked:false — unresolvable, not verified-absent', async () => {
    await seedOwnerIsolationDir([
      { id: CURRENT, mtime: 1_600_000_600_000, lines: [userLine('continue', '2026-08-02T16:07:00.000Z')] },
    ]);

    const refs = parseTurnRefs('[turn:deadbeef@2026-08-01T20:01:45.283Z]');
    const [v] = await verifyTurnRefs(OWNER, refs, { home, loadActiveSessions: async () => [] });

    expect(v.found).toBe(false);
    // Distinguishes "we never located a transcript to search" from a genuine
    // verified-absent (searched the right transcript, turn wasn't in it).
    expect(v.checked).toBe(false);
  });

  it('a timestamp genuinely absent from a correctly-resolved OLDER session reports checked:true, found:false', async () => {
    await seedOwnerIsolationDir([
      { id: ORIGINAL, mtime: 1_600_000_000_000, lines: [userLine('ship the release', '2026-08-01T20:01:45.283Z')] },
      { id: CURRENT, mtime: 1_600_000_600_000, lines: [userLine('continue', '2026-08-02T16:07:00.000Z')] },
    ]);

    const refs = parseTurnRefs(formatTurnRef(ORIGINAL, '2026-08-01T23:59:59.000Z')); // wrong ts, right session
    const [v] = await verifyTurnRefs(OWNER, refs, { home, loadActiveSessions: async () => [] });

    expect(v.found).toBe(false);
    expect(v.checked).toBe(true); // the OLDER session WAS located and searched
  });
});

describe('verifyTurnRefs — managed Codex carry chain (EI-21394895717783013)', () => {
  const SESSION = '01a036e4-878d-7a70-8351-cd21b5fe742b';
  const OWNER = 'su-codex-owner';
  let home: string;

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it('finds a Codex user turn through the same managed-home mapping as sessions:read', async () => {
    home = await mkdtemp(join(tmpdir(), 'papercusp-turn-ref-codex-'));
    const rolloutDir = join(home, '.papercusp', 'su-codex-homes', 'session-11801', 'sessions', '2026', '08', '25');
    await mkdir(rolloutDir, { recursive: true });
    const rolloutPath = join(rolloutDir, `rollout-2026-08-25T03-24-24-${SESSION}.jsonl`);
    await writeFile(rolloutPath, `${userLine('current Codex wake turn', '2026-08-25T03:24:24.026Z')}\n`);

    const refs = parseTurnRefs(formatTurnRef(SESSION.slice(0, 8), '2026-08-25T03:24:24.026Z'));
    const [verdict] = await verifyTurnRefs(OWNER, refs, {
      home,
      loadActiveSessions: async () => [{
        id: 11801,
        agent: 'codex',
        session_id: SESSION,
        omp_thread_id: null,
      }],
    });

    expect(verdict).toMatchObject({ found: true, checked: true, verdict: 'owner-typed' });
    expect(verdict.snippet).toContain('current Codex wake turn');
  });
});

// EI-21394655128717996: an explicit cross-session scope uses the durable
// session_turns index when the predecessor is outside the successor's
// owner-isolated transcript directory.
describe('verifyTurnRefs — indexed cross-owner predecessor scope', () => {
  const PREDECESSOR = '21dfdd94-e8d7-43b0-a30f-4a9a2d066bf4';
  const CURRENT = '9aa2b64c-0000-4000-8000-000000000000';
  const OWNER = 'su-successor-owner';
  const TS = '2026-08-25T02:21:27.909Z';

  it('proves an authenticated clean predecessor owner turn as owner-turn with explicit scope', async () => {
    const refs = parseTurnRefs(`${formatTurnRef(PREDECESSOR, TS)}: "continue the owner directive"`);
    const calls: Array<{ prefix: string; scope: string }> = [];
    const [verdict] = await verifyTurnRefs(OWNER, refs, {
      filePath: join(tmpdir(), 'successor-only.jsonl'),
      sessionId: CURRENT,
      scope: 'cross-session',
      loadIndexedTurns: async (prefix, scope) => {
        calls.push({ prefix, scope });
        return [{
          sessionId: PREDECESSOR,
          ts: TS,
          speaker: 'user',
          text: 'continue the owner directive',
          turnOrigin: 'hook-authenticated-prompt',
          turnOriginVerdict: 'owner-typed',
        }];
      },
    });

    expect(calls).toEqual([{ prefix: PREDECESSOR.slice(0, 8).toLowerCase(), scope: 'cross-session' }]);
    expect(verdict).toMatchObject({
      found: true,
      checked: true,
      verdict: 'owner-turn',
      scope: 'cross-session',
      quoteMatch: true,
    });
  });

  it.each([
    ['unenrolled-origin', 'unenrolled-origin'],
    ['legacy row without a stored verdict', null],
    ['an unrecognized future verdict', 'future-non-owner-verdict'],
  ])('keeps an indexed clean row as unknown when authorship is not positive (%s)', async (_label, turnOriginVerdict) => {
    const refs = parseTurnRefs(`${formatTurnRef(PREDECESSOR, TS)}: "continue the owner directive"`);
    const [verdict] = await verifyTurnRefs(OWNER, refs, {
      filePath: join(tmpdir(), 'successor-only.jsonl'),
      sessionId: CURRENT,
      scope: 'cross-session',
      loadIndexedTurns: async () => [{
        sessionId: PREDECESSOR,
        ts: TS,
        speaker: 'user',
        text: 'continue the owner directive',
        turnOrigin: null,
        turnOriginVerdict,
      }],
    });

    expect(verdict).toMatchObject({
      found: true,
      checked: true,
      verdict: 'unknown',
      scope: 'cross-session',
      quoteMatch: true,
    });
  });

  it('keeps indexed machine-injected predecessor turns non-owner', async () => {
    const refs = parseTurnRefs(formatTurnRef(PREDECESSOR, TS));
    const [verdict] = await verifyTurnRefs(OWNER, refs, {
      filePath: join(tmpdir(), 'successor-only.jsonl'),
      sessionId: CURRENT,
      scope: 'cross-session',
      loadIndexedTurns: async () => [{
        sessionId: PREDECESSOR,
        ts: TS,
        speaker: 'user',
        text: '⟦turn-origin:loop-fire nonce:aabbccdd00112233⟧\nreplay the loop goal',
        turnOrigin: 'loop-fire',
        turnOriginVerdict: 'agent-injected',
      }],
    });

    expect(verdict).toMatchObject({
      found: true,
      checked: true,
      verdict: 'agent-injected',
      origin: 'loop-fire',
      scope: 'cross-session',
    });
  });

  it('preserves checked:false when the indexed predecessor cannot be resolved', async () => {
    const refs = parseTurnRefs(formatTurnRef(PREDECESSOR, TS));
    const [verdict] = await verifyTurnRefs(OWNER, refs, {
      filePath: join(tmpdir(), 'successor-only.jsonl'),
      sessionId: CURRENT,
      scope: 'cross-session',
      loadIndexedTurns: async () => null,
    });

    expect(verdict).toMatchObject({ found: false, checked: false, scope: 'cross-session' });
  });

  it('production loader keeps the indexed unenrolled row non-owner and includes the corpus namespace', async () => {
    const sqlCalls: Array<{ text: string; values: unknown[] }> = [];
    const sql = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        sqlCalls.push({ text: Array.from(strings).join('?'), values });
        return [{
          sessionId: PREDECESSOR,
          ts: TS,
          speaker: 'user',
          text: 'the indexed owner directive',
          turnOrigin: null,
          turnOriginVerdict: 'unenrolled-origin',
        }];
      },
      { begin: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(sql) },
    );
    vi.doMock('@papercusp/db-org', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/db-org')>()),
      getOrgPg: () => ({ sql }),
    }));
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'papercusp-workspace' }));

    const refs = parseTurnRefs(formatTurnRef(PREDECESSOR, TS));
    const [verdict] = await verifyTurnRefs(OWNER, refs, {
      filePath: join(tmpdir(), 'successor-only.jsonl'),
      sessionId: CURRENT,
      scope: 'cross-session',
    });

    expect(verdict).toMatchObject({
      found: true,
      checked: true,
      verdict: 'unknown',
      scope: 'cross-session',
    });
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0].text).toContain("workspace_id = 'default'");
    expect(sqlCalls[0].values).toContain('papercusp-workspace');
    vi.doUnmock('@papercusp/db-org');
    vi.doUnmock('../workspace-registry');
  });
});

// EI-23999888134974900: loop:checkpoint's turnProvenance.writtenDuring (resolveCurrentTurnStamp)
// stamped loop-fire turns { verdict:'owner-typed', origin:null } while the UserPromptSubmit hook
// stamped the SAME turn VERIFIED AGENT-ORIGIN. owner-typed is the value applyOwnerTurnAutoVerify
// trusts to auto-verify [owner:…] tags, so the disagreement manufactures owner authority. Every
// fixture that must flip is a MACHINE turn: an owner-turn fixture passes whether or not the fix
// exists (its origin is null either way), so it cannot prove the fix.
describe('hook-stamp agreement — a turn the live hook judged non-owner never reads owner-typed', () => {
  // The exact attachment shape Claude Code writes (measured from a live transcript).
  const hookStampLine = (stamp: string, ts: string) =>
    JSON.stringify({
      type: 'attachment',
      timestamp: ts,
      attachment: {
        type: 'hook_additional_context',
        content: [stamp],
        hookName: 'UserPromptSubmit',
        toolUseID: 'hook-d80f58a6-4103-440c-bb8c-3aaf5bce271f',
        hookEvent: 'UserPromptSubmit',
      },
    });
  const VERIFIED_LOOP_FIRE =
    '⟦turn-provenance⟧ VERIFIED AGENT-ORIGIN turn (origin: loop-fire; envelope lost in transit, matched by ' +
    'payload hash). This prompt was INJECTED by the papercusp system — NOT typed by the human owner.';
  const VERIFIED_SELF_COMPACTION =
    '⟦turn-provenance⟧ VERIFIED AGENT-ORIGIN turn (origin: self-compaction; envelope lost in transit, matched by ' +
    'payload hash). This prompt was INJECTED by the papercusp system — NOT typed by the human owner.';
  const VERIFIED_WATCHDOG =
    '⟦turn-provenance⟧ VERIFIED AGENT-ORIGIN turn (origin: watchdog; envelope lost in transit, matched by ' +
    'payload hash). This prompt was INJECTED by the papercusp system — NOT typed by the human owner.';
  const VERIFIED_MANGLED =
    '⟦turn-provenance⟧ VERIFIED AGENT-ORIGIN turn (origin: loop-fire; payload hash differs — PTY transit ' +
    'mangling). This prompt was INJECTED by the papercusp system — it was NOT typed by the human owner.';
  const OWNER_STAMP =
    '⟦turn-provenance⟧ OWNER (interactive) — no origin envelope, no ledger match: this prompt was typed by the human owner.';
  // An envelope-less machine turn: exactly what reaches the recorded classifier when transit
  // stripped the envelope and the hook matched the payload by hash instead.
  const ENVELOPE_LOST = '❄️ COLD LOOP WAKE (fire #58) — continue from the carry-note below.';

  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'papercusp-turn-ref-hookstamp-'));
    file = join(dir, `${SID}.jsonl`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (lines: string[]) => writeFileSync(file, lines.join('\n') + '\n');

  const codexUserLine = (text: string, ts: string) =>
    JSON.stringify({
      type: 'response_item',
      timestamp: ts,
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });

  it('the observed 11:41Z shape: /clear, then a whole-paste loop-fire wake that QUOTES earlier same-id pastes', async () => {
    // Recorded 2026-09-23 in su-07b72cf6's transcript a036854f: the wake payload carries four
    // `<pasted_content id="668b">` open/close pairs, because the cold-wake carry quotes prior turns.
    const wake =
      '<pasted_content id="668b">\n⟦turn-origin:loop-fire nonce:81c2812a5a6b4a08⟧\n' +
      '❄️ COLD LOOP WAKE (fire #58)\nverbatim tail:\n<pasted_content id="668b">\nolder wake\n</pasted_content id="668b">\n' +
      'If the goal is DONE or you are blocked, call loop:end.\n</pasted_content id="668b">';
    write([
      userLine('<local-command-caveat>Caveat: generated by local commands.</local-command-caveat>', '2026-09-23T11:41:31.638Z', { isMeta: true }),
      userLine('<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>', '2026-09-23T11:41:29.745Z'),
      userLine(wake, '2026-09-23T11:41:31.793Z'),
      hookStampLine(VERIFIED_MANGLED, '2026-09-23T11:41:31.868Z'),
    ]);
    const stamp = await resolveCurrentTurnStamp('owner-x', { filePath: file, sessionId: SID });
    expect(stamp).toEqual({ ref: '[turn:bf1881bc@2026-09-23T11:41:31.793Z]', verdict: 'agent-injected', origin: 'loop-fire' });
  });

  it('classifies an envelope-less cold-loop banner as machine without the hook stamp', async () => {
    // The fixed banner is enough to prevent an owner-typed fallback; the stamp below
    // still supplies the specific loop-fire origin when the envelope is missing.
    write([userLine(ENVELOPE_LOST, '2026-09-23T12:00:00.000Z')]);
    const stamp = await resolveCurrentTurnStamp('owner-x', { filePath: file, sessionId: SID });
    expect(stamp).toEqual({ ref: '[turn:bf1881bc@2026-09-23T12:00:00.000Z]', verdict: 'machine-surface', origin: null });
  });

  it('writtenDuring keeps a native Codex Stop-hook prompt non-owner through the resolver', async () => {
    const wrapped = '<hook_prompt hook_run_id=stop:22:/tmp/hooks.json>\nSTOP CONTEXT';
    const ts = '2026-09-23T12:30:00.000Z';
    write([codexUserLine(wrapped, ts)]);
    const unwrappedStamp = await resolveCurrentTurnStamp('owner-x', { filePath: file, sessionId: SID });
    expect(unwrappedStamp).toEqual({ ref: `[turn:bf1881bc@${ts}]`, verdict: 'machine-surface', origin: null });

    write([
      codexUserLine(
        '<hook_prompt hook_run_id=stop:22:/tmp/hooks.json>\n' +
          '⟦turn-origin:stop-hook nonce:a1b2c3d4e5f60718⟧\nSTOP CONTEXT',
        ts,
      ),
    ]);
    const enrolledStamp = await resolveCurrentTurnStamp('owner-x', { filePath: file, sessionId: SID });
    expect(enrolledStamp).toEqual({ ref: `[turn:bf1881bc@${ts}]`, verdict: 'agent-injected', origin: 'stop-hook' });
  });

  it('writtenDuring defers to a VERIFIED AGENT-ORIGIN hook stamp when the envelope was lost in transit', async () => {
    write([
      userLine(ENVELOPE_LOST, '2026-09-23T12:00:00.000Z'),
      hookStampLine(VERIFIED_LOOP_FIRE, '2026-09-23T12:00:00.080Z'),
    ]);
    const stamp = await resolveCurrentTurnStamp('owner-x', { filePath: file, sessionId: SID });
    expect(stamp).toEqual({ ref: '[turn:bf1881bc@2026-09-23T12:00:00.000Z]', verdict: 'agent-injected', origin: 'loop-fire' });
  });

  it('writtenDuring preserves self-compaction as non-owner when the envelope is lost in transit', async () => {
    write([
      userLine(ENVELOPE_LOST, '2026-09-23T12:00:00.000Z'),
      hookStampLine(VERIFIED_SELF_COMPACTION, '2026-09-23T12:00:00.080Z'),
    ]);
    const stamp = await resolveCurrentTurnStamp('owner-x', { filePath: file, sessionId: SID });
    expect(stamp).toEqual({ ref: '[turn:bf1881bc@2026-09-23T12:00:00.000Z]', verdict: 'agent-injected', origin: 'self-compaction' });
  });

  it('writtenDuring preserves watchdog compaction as non-owner when the envelope is lost in transit', async () => {
    write([
      userLine(ENVELOPE_LOST, '2026-09-23T12:00:00.000Z'),
      hookStampLine(VERIFIED_WATCHDOG, '2026-09-23T12:00:00.080Z'),
    ]);
    const stamp = await resolveCurrentTurnStamp('owner-x', { filePath: file, sessionId: SID });
    expect(stamp).toEqual({ ref: '[turn:bf1881bc@2026-09-23T12:00:00.000Z]', verdict: 'agent-injected', origin: 'watchdog' });
  });

  it('verifyTurnRefs (the work_items:checkpoint refs path) agrees with the hook stamp too', async () => {
    write([
      userLine(ENVELOPE_LOST, '2026-09-23T12:00:00.000Z'),
      hookStampLine(VERIFIED_LOOP_FIRE, '2026-09-23T12:00:00.080Z'),
    ]);
    const [v] = await verifyTurnRefs('owner-x', parseTurnRefs('[turn:bf1881bc@2026-09-23T12:00:00.000Z]'), {
      filePath: file,
      sessionId: SID,
    });
    expect(v.found).toBe(true);
    expect(v.verdict).toBe('agent-injected');
    expect(v.origin).toBe('loop-fire');
  });

  it('UNVERIFIED and MACHINE-GENERATED stamps also remove the owner default', () => {
    const unverified = parseUserTurns(
      [
        userLine(ENVELOPE_LOST, '2026-09-23T12:00:00.000Z'),
        hookStampLine('⟦turn-provenance⟧ UNVERIFIED ORIGIN CLAIM — no origin envelope, but the payload hash matches an EXPIRED row.', '2026-09-23T12:00:00.050Z'),
      ].join('\n'),
    );
    expect(classifyRecordedUserTurn(unverified[0])).toEqual({ verdict: 'agent-injected', origin: UNVERIFIED_HOOK_ORIGIN });

    const machine = parseUserTurns(
      [
        userLine('background task finished', '2026-09-23T12:01:00.000Z'),
        hookStampLine('⟦turn-provenance⟧ MACHINE-GENERATED SURFACE — this prompt carries a known CLI-internal marker.', '2026-09-23T12:01:00.050Z'),
      ].join('\n'),
    );
    expect(classifyRecordedUserTurn(machine[0])).toEqual({ verdict: 'machine-surface', origin: null });
  });

  it('DOWNGRADE-ONLY: an OWNER stamp never promotes a machine turn; it leaves a real owner turn owner-typed', () => {
    const turns = parseUserTurns(
      [
        userLine('⟦turn-origin:loop-fire nonce:a1b2c3d4e5f60718⟧\ncontinue', '2026-09-23T12:00:00.000Z'),
        hookStampLine(OWNER_STAMP, '2026-09-23T12:00:00.050Z'),
        assistantLine('ok', '2026-09-23T12:00:05.000Z'),
        userLine('ship it when the gate is green', '2026-09-23T12:05:00.000Z'),
        hookStampLine(OWNER_STAMP, '2026-09-23T12:05:00.050Z'),
      ].join('\n'),
    );
    expect(classifyRecordedUserTurn(turns[0])).toEqual({ verdict: 'agent-injected', origin: 'loop-fire' });
    expect(classifyRecordedUserTurn(turns[1])).toEqual({ verdict: 'owner-typed', origin: null });
  });

  it('a stamp is attached only to the prompt it follows: never across an assistant line or tool_result plumbing', () => {
    const toolResult = JSON.stringify({
      type: 'user',
      timestamp: '2026-09-23T12:00:07.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    });
    const turns = parseUserTurns(
      [
        userLine('owner words', '2026-09-23T12:00:00.000Z'),
        assistantLine('working', '2026-09-23T12:00:05.000Z'),
        hookStampLine(VERIFIED_LOOP_FIRE, '2026-09-23T12:00:06.000Z'),
        userLine('more owner words', '2026-09-23T12:01:00.000Z'),
        toolResult,
        hookStampLine(VERIFIED_LOOP_FIRE, '2026-09-23T12:01:08.000Z'),
      ].join('\n'),
    );
    expect(turns.map((t) => t.hookStamp)).toEqual([undefined, undefined]);
    expect(turns.map((t) => classifyRecordedUserTurn(t).verdict)).toEqual(['owner-typed', 'owner-typed']);
  });

  it('a prompt queued mid-turn (queued_command attachment) receives the stamp that follows it', () => {
    const queued = JSON.stringify({
      type: 'attachment',
      timestamp: '2026-09-23T12:02:00.000Z',
      attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, prompt: ENVELOPE_LOST },
    });
    const turns = parseUserTurns([queued, hookStampLine(VERIFIED_LOOP_FIRE, '2026-09-23T12:02:00.040Z')].join('\n'));
    expect(turns).toHaveLength(1);
    expect(classifyRecordedUserTurn(turns[0])).toEqual({ verdict: 'agent-injected', origin: 'loop-fire' });
  });

  it('parseHookProvenanceStamp reads origin, ignores non-provenance hook text', () => {
    expect(parseHookProvenanceStamp(VERIFIED_MANGLED)).toEqual({ kind: 'agent-origin', origin: 'loop-fire' });
    expect(parseHookProvenanceStamp('⟦CTRL:transition⟧ {"state":{}}')).toBeNull();
    expect(parseHookProvenanceStamp(OWNER_STAMP)).toEqual({ kind: 'owner' });
  });

  it('PIN: every stamp prefix this parser recognizes is emitted verbatim by the live hook script', () => {
    // If the hook rewords a stamp, the parser would silently stop matching it and the
    // recorded classifier would fall back to its owner-typed default. Fail here instead.
    let root = resolve(__dirname);
    while (!(existsSync(join(root, 'apps')) && existsSync(join(root, 'packages'))) && dirname(root) !== root) {
      root = dirname(root);
    }
    const hook = readFileSync(join(root, 'apps/operator/scripts/hooks/cc/userpromptsubmit-provenance.sh'), 'utf8');
    for (const prefix of Object.values(HOOK_PROVENANCE_STAMP_PREFIXES)) {
      expect(hook, `hook no longer emits "${prefix}"`).toContain(prefix);
    }
  });
});
