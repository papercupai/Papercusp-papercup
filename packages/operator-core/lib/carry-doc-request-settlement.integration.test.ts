/**
 * P-005 (goal-agent-behavior-feedback-2026-09-06, AUTO-BAR-R-9-P-005): an owner
 * request stays unresolved until a MATCHING substantive delivered answer.
 *
 * Integration layer: a real Claude transcript file on disk is read by the
 * production tail reader (turn-journal `readVerbatimTail`), classified by the
 * production provenance classifier, and settled by `buildCarryDoc` →
 * `deriveContinuation`. Only the DB-backed legs that are unrelated to request
 * settlement (brief, recovery, modes, plan items, asks, background tasks,
 * owner-speech census) are replaced, so the subject path is the one a real
 * carry-respawn walks from transcript to successor continuation.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCarryDoc, type BuildCarryDocOpts } from './carry-doc';

const OWNER = 'su-request-settlement-fixture';
let sandbox: string;

type Line = Record<string, unknown>;
const owner = (uuid: string, parentUuid: string | null, text: string): Line => ({
  type: 'user', uuid, parentUuid, message: { role: 'user', content: text },
});
const loopWake = (uuid: string, parentUuid: string | null): Line => ({
  type: 'user', uuid, parentUuid,
  message: { role: 'user', content: '⟦turn-origin:loop-fire nonce:0123456789abcdef⟧\nCOLD LOOP WAKE — continue the standing work.' },
});
const assistant = (
  uuid: string,
  parentUuid: string,
  text: string,
  stopReason: 'end_turn' | 'tool_use' | 'stop_sequence',
  extra: Line = {},
): Line => ({
  type: 'assistant', uuid, parentUuid, ...extra,
  message: { role: 'assistant', stop_reason: stopReason, content: [{ type: 'text', text }] },
});

const toolResult = (uuid: string, parentUuid: string): Line => ({
  type: 'user', uuid, parentUuid, promptId: 'prompt-1',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${uuid}`, content: 'ok' }] },
});
// The exact shape Claude Code records for an owner message typed while a turn is
// still running: an attachment row, NOT a user row, and with no node id of its own
// in the parsed turn — it joins the running turn's request through its parent.
const queuedOwner = (uuid: string, parentUuid: string, text: string): Line => ({
  type: 'attachment', uuid, parentUuid,
  attachment: {
    type: 'queued_command', prompt: text, commandMode: 'prompt',
    origin: { kind: 'human' }, timestamp: '2026-09-28T14:43:07.116Z', humanTurn: true,
  },
});

function transcript(name: string, lines: Line[]): string {
  const path = join(sandbox, `${name}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

function opts(transcriptPath: string): BuildCarryDocOpts {
  return {
    workspaceId: 'request-settlement-ws',
    transcriptPath,
    transcriptSourceKind: 'claude',
    boundaryDeliberate: false,
    buildCarryBriefFn: async () => ({
      ownerId: OWNER, loop: null, heldItems: [], directives: [], directivesTotalOpen: 0,
      walls: [], facts: [], awaits: [], fleet: null,
    }),
    // The seam is typed Promise<AutomaticCompactionRecovery>; buildCarryDoc maps a
    // REJECTION to `automaticRecovery: null`, so reject rather than resolve null.
    buildAutomaticRecoveryFn: () => Promise.reject(new Error('fixture: no automatic recovery')),
    getModesFn: async () => [],
    getPlanItemsFn: async () => [],
    getAsksFn: async () => [],
    getBackgroundTasksFn: async () => [],
    getClosedDirectivesFn: async () => [],
    ownerSpeechCensusFn: async () => 'unknown',
    projectedToolsFn: () => [],
  } as BuildCarryDocOpts;
}

beforeAll(() => { sandbox = mkdtempSync(join(tmpdir(), 'carry-request-settlement-')); });
afterAll(() => { rmSync(sandbox, { recursive: true, force: true }); });

describe('P-005-request-settlement: transcript → carry continuation', () => {
  it('a delivered answer to a LATER machine wake does not settle the earlier owner request', async () => {
    const path = transcript('wake-answer', [
      owner('o1', null, 'Please audit the release gate and report what blocks main.'),
      assistant('a1', 'o1', 'Looking into it now.', 'tool_use'),
      loopWake('w1', 'a1'),
      assistant('a2', 'w1', 'Loop wake handled; nothing new on the lane.', 'end_turn'),
    ]);
    const doc = await buildCarryDoc(OWNER, opts(path));
    expect(doc.tail.map((t) => t.provenance?.verdict ?? null)).toEqual(
      ['owner-typed', null, 'agent-injected', null],
    );
    expect(doc.continuation.lastOwnerMessage?.text).toContain('audit the release gate');
    expect(doc.continuation.answered).toBe(false);
  });

  it('an acknowledgement (non-final progress) does not settle the owner request', async () => {
    const path = transcript('ack-only', [
      owner('o1', null, 'Summarize the open walls for me.'),
      assistant('a1', 'o1', 'On it.', 'tool_use'),
    ]);
    const doc = await buildCarryDoc(OWNER, opts(path));
    expect(doc.continuation.answered).toBe(false);
  });

  it('an interrupted reply does not settle the owner request', async () => {
    const path = transcript('interrupted', [
      owner('o1', null, 'Summarize the open walls for me.'),
      // Real shape (measured on 37 recorded Claude transcripts): isApiErrorMessage,
      // stop_reason 'stop_sequence', model '<synthetic>'.
      {
        ...assistant('a1', 'o1', 'API Error: overloaded', 'stop_sequence', { isApiErrorMessage: true }),
        message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: overloaded' }] },
      },
    ]);
    const doc = await buildCarryDoc(OWNER, opts(path));
    expect(doc.continuation.answered).toBe(false);
  });

  it('the matching delivered answer settles the owner request (calibration)', async () => {
    const path = transcript('answered', [
      owner('o1', null, 'Summarize the open walls for me.'),
      assistant('a1', 'o1', 'Checking the walls.', 'tool_use'),
      assistant('a2', 'a1', 'Open walls: R-16 and R-18 await the leader ruling.', 'end_turn'),
    ]);
    const doc = await buildCarryDoc(OWNER, opts(path));
    expect(doc.continuation.lastOwnerMessage?.text).toContain('Summarize the open walls');
    expect(doc.continuation.answered).toBe(true);
  });

  // WI-10003691: an owner message queued MID-TURN is answered by that turn's
  // delivered reply, together with the prompt that opened the turn.
  it('a queued mid-turn owner message is settled by the turn’s delivered answer', async () => {
    const path = transcript('queued-complete', [
      owner('o1', null, 'Can you explain more about his PhD?'),
      assistant('a1', 'o1', 'Looking it up.', 'tool_use'),
      toolResult('t1', 'a1'),
      queuedOwner('q1', 't1', 'Regarding Tesla, any advancements in this direction?'),
      assistant('a2', 'q1', 'His PhD … and, on Tesla in 2026: …', 'end_turn'),
    ]);
    const doc = await buildCarryDoc(OWNER, opts(path));
    expect(doc.continuation.lastOwnerMessage?.text).toContain('Regarding Tesla');
    expect(doc.continuation.answered).toBe(true);
    expect(doc.continuation.pendingOwnerMessages).toBeUndefined();
  });

  // WI-10003691 (the incident): the tail reader's byte window opened MID-TURN, so
  // the chain's parent was outside the read. The queued owner message and the
  // reply that answered it both resolved to a null request, nothing could settle
  // it, and the carry successor was handed an already-answered question as the
  // owner's "open final message". A parent outside the window is simulated by a
  // parentUuid that no row in the file carries — the same resolution path.
  it('a window that opens mid-turn still settles the queued owner message', async () => {
    const path = transcript('queued-orphan-window', [
      toolResult('t1', 'assistant-before-the-window'),
      queuedOwner('q1', 't1', 'Regarding Tesla, any advancements in this direction?'),
      assistant('a1', 'q1', 'Checking the latest.', 'tool_use'),
      toolResult('t2', 'a1'),
      assistant('a2', 't2', 'Tesla in 2026: FSD v14, v15, the neural world simulator …', 'end_turn'),
      owner('o2', 'a2', 'Can you go into more depth into how the system works?'),
      assistant('a3', 'o2', 'The pipeline has six stages …', 'end_turn'),
    ]);
    const doc = await buildCarryDoc(OWNER, opts(path));
    expect(doc.continuation.pendingOwnerMessages).toBeUndefined();
    expect(doc.continuation.answered).toBe(true);
  });

  // WI-10003691 second safeguard: whatever the tail heuristics conclude, a request
  // whose own capture is already CLOSED in the directive ledger is not re-delivered.
  it('a pending request whose exact directive capture is already closed is not re-delivered', async () => {
    const asked = '2026-09-28T14:43:07.116Z';
    const path = transcript('ledger-closed', [
      { ...owner('o1', null, 'Regarding Tesla, any advancements in this direction?'), timestamp: asked },
      assistant('a1', 'o1', 'Looking into it.', 'tool_use'),
    ]);
    const closedAt = Date.parse(asked) + 180;
    const doc = await buildCarryDoc(OWNER, {
      ...opts(path),
      getClosedDirectivesFn: async () => [
        { text: 'Regarding  Tesla, any advancements in this direction?\n', createdAtMs: closedAt },
      ],
    });
    expect(doc.continuation.pendingOwnerMessages).toBeUndefined();
    expect(doc.continuation.answered).toBe(true);
  });

  // Calibration: the SAME text typed again later is a NEW message — a closed
  // directive captured far from this turn's timestamp must not settle it.
  it('an identical text captured at a different time stays open', async () => {
    const asked = '2026-09-28T16:00:00.000Z';
    const path = transcript('ledger-closed-other-time', [
      { ...owner('o1', null, 'publish it now'), timestamp: asked },
      assistant('a1', 'o1', 'Publishing.', 'tool_use'),
    ]);
    const doc = await buildCarryDoc(OWNER, {
      ...opts(path),
      getClosedDirectivesFn: async () => [
        { text: 'publish it now', createdAtMs: Date.parse(asked) - 60 * 60_000 },
      ],
    });
    expect(doc.continuation.pendingOwnerMessages?.map((r) => r.text)).toEqual(['publish it now']);
    expect(doc.continuation.answered).toBe(false);
  });

  // Calibration for the case above: the synthetic window key must not settle a
  // queued owner message that was never actually answered.
  it('a window that opens mid-turn keeps an UNANSWERED queued owner message open', async () => {
    const path = transcript('queued-orphan-window-open', [
      toolResult('t1', 'assistant-before-the-window'),
      assistant('a1', 't1', 'Earlier answer to the prompt that opened this turn.', 'end_turn'),
      queuedOwner('q1', 'a1', 'Regarding Tesla, any advancements in this direction?'),
      assistant('a2', 'q1', 'Checking the latest.', 'tool_use'),
    ]);
    const doc = await buildCarryDoc(OWNER, opts(path));
    expect(doc.continuation.answered).toBe(false);
    expect(doc.continuation.pendingOwnerMessages?.map((r) => r.text)).toEqual([
      'Regarding Tesla, any advancements in this direction?',
    ]);
  });

  // EI-25227743201307257 — the exact shape Claude Code records for an
  // AskUserQuestion round trip: an assistant tool_use node, then the owner's
  // answer as a synthetic tool_result user row parented on it. The agent acts on
  // the first answer and raises a second dialog inside the SAME running turn, so
  // only the second answer ever meets an end_turn. Measured twice in production
  // (directives #1379 and #1460): the first answer was re-delivered as OPEN.
  const askDialog = (uuid: string, parentUuid: string): Line => ({
    type: 'assistant', uuid, parentUuid,
    message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `toolu_${uuid}`, name: 'AskUserQuestion', input: {} }] },
  });
  const dialogAnswer = (uuid: string, parentUuid: string, answer: string): Line => ({
    type: 'user', uuid, parentUuid, promptId: 'prompt-1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${parentUuid}`, content: `Your questions have been answered: "Is the mic connected?"="${answer}".` }] },
  });
  const dialogChain = (final: Line): Line[] => [
    owner('o1', null, 'Start the guided microphone session when I am ready.'),
    assistant('a1', 'o1', 'Checking for the microphone first.', 'tool_use'),
    askDialog('q1', 'a1'),
    dialogAnswer('d1', 'q1', 'Re-plugged — check again'),
    assistant('a2', 'd1', 'Still not detected; asking again.', 'tool_use'),
    askDialog('q2', 'a2'),
    dialogAnswer('d2', 'q2', 'Not at the machine now'),
    final,
  ];

  it('a dialog answer acted on before the next dialog is settled by the final delivered answer', async () => {
    const path = transcript('dialog-chain-delivered', dialogChain(
      assistant('a3', 'd2', 'Understood — nothing starts until you are back.', 'end_turn'),
    ));
    const doc = await buildCarryDoc(OWNER, opts(path));
    // Positive control: both answers really are classified as owner speech.
    expect(doc.tail.filter((t) => t.provenance?.verdict === 'owner-dialog')).toHaveLength(2);
    expect(doc.continuation.lastOwnerMessage?.text).toContain('Not at the machine now');
    expect(doc.continuation.answered).toBe(true);
    expect(doc.continuation.pendingOwnerMessages).toBeUndefined();
  });

  // Calibration: the chain settles only on a RESPONSE. If the final answer was
  // never delivered, every link — including the typed request — stays open.
  it('an undelivered final dialog keeps the whole chain open', async () => {
    const path = transcript('dialog-chain-open', dialogChain(
      assistant('a3', 'd2', 'Noted.', 'tool_use'),
    ));
    const doc = await buildCarryDoc(OWNER, opts(path));
    expect(doc.continuation.answered).toBe(false);
    const pending = doc.continuation.pendingOwnerMessages?.map((r) => r.text) ?? [];
    expect(pending).toHaveLength(3);
    expect(pending[0]).toContain('guided microphone session');
    expect(pending[1]).toContain('Re-plugged');
    expect(pending[2]).toContain('Not at the machine now');
  });
});
