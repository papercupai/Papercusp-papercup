/**
 * WI-10004982 — a fresh headless launch got its fleet kickoff TWICE.
 *
 * The host decides whether the kickoff turn RAN by looking for a model-activity row
 * (claude: `type:'assistant'`) after the kickoff's provenance marker in the session's
 * isolated native transcript. If it sees none within its poll budget, it re-sends
 * the kickoff text. That retry is right for a turn that never started, and wrong
 * (a duplicate turn) for one that did.
 *
 * The reader used to scan only the last 256 KiB of the transcript. A fresh Claude
 * session writes rows bigger than that right after its reply. Measured on transcript
 * 98404f60: the prompt was row 3, the reply row 19 (offset ~500 KB), then a 258 KB
 * `prompt_snapshot` and a `last-prompt` row that repeats the marker. The 256 KiB window
 * began past the reply and bound to that LATER `last-prompt` copy, so it never saw the
 * reply. The host reported "no native turn activity after kickoff" and re-sent the
 * kickoff 40 s after the model had already answered it.
 *
 * Each fixture below is laid out like that transcript. The first test carries a
 * deliberately-wrong control that re-implements the old tail-window read. It proves
 * the fixture really reproduces the failure, so a pass from the real reader means
 * something.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  kickoffMarkerPromptRow,
  nativeKickoffTurnActivityAfterMarker,
} from '../scripts/psu-pty-host.mjs';

const MARKER = '⟦turn-origin:fleet-kickoff nonce:01af4968d0c05f04⟧';
const KICKOFF = `${MARKER} WI-10004663 probe: reply OK and end your turn.`;
const OLD_TAIL_BYTES = 256 * 1024;

const scratch = mkdtempSync(join(tmpdir(), 'kickoff-activity-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let fixtureCount = 0;
function claudeTranscript(): { root: string; file: string; env: Record<string, string> } {
  fixtureCount += 1;
  const root = join(scratch, `claude-${fixtureCount}`);
  const dir = join(root, 'projects', '-home-probe');
  mkdirSync(dir, { recursive: true });
  return { root, file: join(dir, `98404f60-${fixtureCount}.jsonl`), env: { CLAUDE_CONFIG_DIR: root } };
}

const at = () => new Date().toISOString();
const line = (row: unknown) => `${JSON.stringify(row)}\n`;
const userPrompt = (content: unknown = KICKOFF) => ({
  type: 'user', uuid: 'u-1', timestamp: at(), message: { role: 'user', content },
});
const lastPrompt = () => ({ type: 'last-prompt', lastPrompt: KICKOFF, leafUuid: 'leaf', sessionId: 's' });
const attachment = (kind: string, bytes: number) => ({
  type: 'attachment', timestamp: at(), attachment: { type: kind, content: 'x'.repeat(bytes) },
});
const assistant = (uuid = 'a-1') => ({
  type: 'assistant', uuid, timestamp: at(),
  message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'OK' }] },
});

/** The row sequence of transcript 98404f60, rows 0-21, with the attachment sizes
 * measured there. One change: the post-reply `prompt_snapshot` is 270 KB, not
 * 258,666 bytes. In the real file, the bytes from the reply to the first check
 * exceeded 256 KiB by only ~370 bytes. Padding keeps this fixture reliably past
 * the old window, whatever the JSON overhead. */
function measuredLayout(): unknown[] {
  return [
    { type: 'mode', mode: 'auto' },
    { type: 'permission-mode', permissionMode: 'bypassPermissions' },
    userPrompt(),
    attachment('skill_listing', 31_313),
    attachment('instructions', 276_339),
    attachment('prompt_snapshot', 168_433),
    lastPrompt(),
    { type: 'ai-title', title: 'probe' },
    assistant(),
    attachment('prompt_snapshot', 270_000),
    lastPrompt(),
  ];
}

/** The pre-fix reader, kept as a deliberately-wrong CONTROL: read the last 256 KiB,
 * drop the partial first row, bind to the first row containing the marker, look for
 * an assistant row after it. Not production code. */
function oldTailWindowReader(file: string): { available: boolean; started: boolean } {
  const bytes = readFileSync(file);
  let tail = bytes.subarray(Math.max(0, bytes.length - OLD_TAIL_BYTES));
  if (bytes.length > OLD_TAIL_BYTES) tail = tail.subarray(tail.indexOf(0x0a) + 1);
  const rows = tail.toString('utf8').split('\n').filter(Boolean).map((text) => JSON.parse(text));
  const index = rows.findIndex((row) => JSON.stringify(row).includes(MARKER));
  if (index < 0) return { available: false, started: false };
  return { available: true, started: rows.slice(index + 1).some((row) => row.type === 'assistant') };
}

const freshAnchor = () => ({
  fileIdentity: null as string | null,
  markerStartOffset: null as number | null,
  markerEndOffset: null as number | null,
  scannedEndOffset: null as number | null,
});

describe('nativeKickoffTurnActivityAfterMarker (WI-10004982)', () => {
  it('never attributes a later owner turn to a pending anchored kickoff', () => {
    const { file, env } = claudeTranscript();
    writeFileSync(file, line(userPrompt()));
    const anchor = freshAnchor();
    const call = () => nativeKickoffTurnActivityAfterMarker({
      agent: 'claude', env, transcriptPath: file, marker: MARKER, anchor,
    });
    expect(call()).toEqual({ available: true, started: false });
    appendFileSync(file, line(userPrompt('new owner request')) + line(assistant('later-turn')));
    expect(call()).toEqual({ available: false, started: false });
    expect(call()).toEqual({ available: false, started: false });
  });

  it('sees the reply when large attachment rows follow it (the measured 98404f60 layout)', () => {
    const { file, env } = claudeTranscript();
    const rows = measuredLayout();
    writeFileSync(file, rows.map(line).join(''));
    const text = readFileSync(file, 'utf8');
    const promptOffset = Buffer.byteLength(text.slice(0, text.indexOf('"type":"user"') - 1));
    const replyEnd = Buffer.byteLength(text.slice(0, text.indexOf('"type":"assistant"')));
    // Shape check: more than one old window of bytes was written after the reply.
    expect(statSync(file).size - replyEnd).toBeGreaterThan(OLD_TAIL_BYTES);

    // CONTROL: the old reader reproduces the incident on this fixture.
    expect(oldTailWindowReader(file)).toEqual({ available: true, started: false });

    const anchor = freshAnchor();
    expect(nativeKickoffTurnActivityAfterMarker({
      agent: 'claude', env, transcriptPath: file, marker: MARKER, anchor,
    })).toEqual({ available: true, started: true });
    expect(anchor.markerStartOffset).toBe(promptOffset);
    // Asking again through the anchor stays true: the abort-before-retry check
    // and the post-retry observation both call this again.
    expect(nativeKickoffTurnActivityAfterMarker({
      agent: 'claude', env, transcriptPath: file, marker: MARKER, anchor,
    })).toEqual({ available: true, started: true });
  });

  it('binds a queued kickoff to its user row, not the queue copy, so the previous turn does not count', () => {
    const { file, env } = claudeTranscript();
    writeFileSync(file, [
      { type: 'queue-operation', operation: 'enqueue', timestamp: at(), content: KICKOFF },
      assistant('previous-turn'),
      { type: 'queue-operation', operation: 'dequeue', timestamp: at() },
      userPrompt(),
      attachment('hook_additional_context', 1_000),
    ].map(line).join(''));

    const anchor = freshAnchor();
    expect(nativeKickoffTurnActivityAfterMarker({
      agent: 'claude', env, transcriptPath: file, marker: MARKER, anchor,
    })).toEqual({ available: true, started: false });

    appendFileSync(file, line(assistant('kickoff-turn')));
    expect(nativeKickoffTurnActivityAfterMarker({
      agent: 'claude', env, transcriptPath: file, marker: MARKER, anchor,
    })).toEqual({ available: true, started: true });
  });

  it('keeps reading forward through the anchor as the transcript grows past any tail window', () => {
    const { file, env } = claudeTranscript();
    writeFileSync(file, [userPrompt(), attachment('instructions', 276_339)].map(line).join(''));
    const anchor = freshAnchor();
    const call = () => nativeKickoffTurnActivityAfterMarker({
      agent: 'claude', env, transcriptPath: file, marker: MARKER, anchor,
    });
    expect(call()).toEqual({ available: true, started: false });
    const firstCursor = anchor.scannedEndOffset;
    expect(firstCursor).toBe(statSync(file).size);

    appendFileSync(file, line(attachment('prompt_snapshot', 300_000)));
    expect(call()).toEqual({ available: true, started: false });
    expect(anchor.scannedEndOffset).toBeGreaterThan(firstCursor as number);

    appendFileSync(file, line(attachment('prompt_snapshot', 300_000)) + line(assistant()));
    expect(call()).toEqual({ available: true, started: true });
  });

  it('treats a half-written newest row as no evidence yet, not as a failure', () => {
    const { file, env } = claudeTranscript();
    writeFileSync(file, line(userPrompt()));
    const anchor = freshAnchor();
    const call = () => nativeKickoffTurnActivityAfterMarker({
      agent: 'claude', env, transcriptPath: file, marker: MARKER, anchor,
    });
    expect(call()).toEqual({ available: true, started: false });
    const reply = line(assistant());
    appendFileSync(file, reply.slice(0, 40));
    expect(call()).toEqual({ available: true, started: false });
    appendFileSync(file, reply.slice(40));
    expect(call()).toEqual({ available: true, started: true });
  });

  it('refuses when the anchored file is replaced or its prompt row changed', () => {
    const { file, env } = claudeTranscript();
    writeFileSync(file, line(userPrompt()));
    const anchor = freshAnchor();
    const call = () => nativeKickoffTurnActivityAfterMarker({
      agent: 'claude', env, transcriptPath: file, marker: MARKER, anchor,
    });
    expect(call()).toEqual({ available: true, started: false });

    // Same inode, rewritten so the anchored bytes are no longer the prompt row.
    writeFileSync(file, line({ type: 'system', content: 'y'.repeat(Buffer.byteLength(line(userPrompt()))) }) +
      line(assistant()));
    expect(call()).toEqual({ available: false, started: false });

    // A different file at the same path. The filesystem may reuse the freed
    // inode number, so the prompt row also moves: either check alone refuses.
    rmSync(file);
    writeFileSync(file, line({ type: 'mode', mode: 'auto' }) + line(userPrompt()) + line(assistant()));
    expect(call()).toEqual({ available: false, started: false });
  });

  it('is unavailable without the isolated root or a prompt row, and never matches an assistant echo', () => {
    const { file, env } = claudeTranscript();
    writeFileSync(file, [lastPrompt(), {
      ...assistant(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: KICKOFF }] },
    }].map(line).join(''));
    expect(nativeKickoffTurnActivityAfterMarker({
      agent: 'claude', env, transcriptPath: file, marker: MARKER, anchor: freshAnchor(),
    })).toEqual({ available: false, started: false });

    writeFileSync(file, line(userPrompt()) + line(assistant()));
    expect(nativeKickoffTurnActivityAfterMarker({
      agent: 'claude', env: {}, transcriptPath: file, marker: MARKER, anchor: freshAnchor(),
    })).toEqual({ available: false, started: false });
  });

  it('codex: finds the activity row after the marker past 256 KiB, including a truncated marker', () => {
    fixtureCount += 1;
    const root = join(scratch, `codex-${fixtureCount}`);
    const dir = join(root, 'sessions', '2026', '10', '01');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'rollout.jsonl');
    const lostChars = 20;
    writeFileSync(file, [
      { type: 'response_item', timestamp: at(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: KICKOFF.slice(lostChars) }] } },
      { type: 'system', payload: { text: 'x'.repeat(300 * 1024) } },
      { type: 'event_msg', timestamp: at(), payload: { type: 'task_started', turn_id: 't-1' } },
    ].map(line).join(''));
    expect(nativeKickoffTurnActivityAfterMarker({
      agent: 'codex', env: { CODEX_HOME: root }, transcriptPath: file, marker: MARKER,
      markerLostChars: lostChars, anchor: freshAnchor(),
    })).toEqual({ available: true, started: true });
  });
});

describe('kickoffMarkerPromptRow (WI-10004982)', () => {
  it('accepts only a real claude prompt row', () => {
    expect(kickoffMarkerPromptRow('claude', userPrompt(), MARKER)).toBe(true);
    expect(kickoffMarkerPromptRow('claude', userPrompt([{ type: 'text', text: KICKOFF }]), MARKER)).toBe(true);
    expect(kickoffMarkerPromptRow('claude', lastPrompt(), MARKER)).toBe(false);
    expect(kickoffMarkerPromptRow('claude', { type: 'queue-operation', operation: 'enqueue', content: KICKOFF }, MARKER)).toBe(false);
    expect(kickoffMarkerPromptRow('claude', { ...userPrompt(), isMeta: true }, MARKER)).toBe(false);
    expect(kickoffMarkerPromptRow('claude', userPrompt([{ type: 'tool_result', content: KICKOFF }]), MARKER)).toBe(false);
    expect(kickoffMarkerPromptRow('claude', userPrompt('unrelated prompt'), MARKER)).toBe(false);
  });
});
