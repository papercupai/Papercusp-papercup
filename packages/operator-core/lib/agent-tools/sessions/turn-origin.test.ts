/**
 * turn-origin.test.ts — EI-20034001963934568 regression.
 *
 * `loop:arm { goal }` replays into every wake as a turn whose `speaker` is
 * literally `'user'`, so the compaction rules' prescribed verification
 * (`sessions:search { session:'self' }` for the quoted directive) FINDS the
 * agent's own words and PASSES. This suite pins the two properties that make
 * the `turn_origin` field an answer rather than a second false confirmation:
 *
 *   1. the verdict comes from the turn HEAD, never from a hit excerpt;
 *   2. a miss renders `unknown` — NEVER "agent-authored".
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/sessions/turn-origin.test.ts
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  STORED_UNENROLLED_ORIGIN,
  TURN_ORIGIN_HEAD_CHARS,
  TURN_ORIGIN_TAIL_CHARS,
  classifyHitTurnOrigin,
  resolveHitTurnOrigins,
  turnOriginKey,
  unknownTurnOrigin,
} from './turn-origin';
import { dialogAnswerText } from '../../transcript-wire';

const NONCE = 'b95e490f98516e92';
const envelope = (origin: string) => `⟦turn-origin:${origin} nonce:${NONCE}⟧`;

/** A realistic loop-fire wake: envelope at the head, the quotable "directive"
 *  hundreds of chars below it — the exact geometry that fools a reader. */
const LOOP_FIRE_TURN =
  `${envelope('loop-fire')}\n` +
  '❄️ COLD LOOP WAKE (fire #69) — continue from the carry-note below.\n' +
  'x'.repeat(400) +
  '\n[owner 2026-08-10] My leg-contribution run recorded lexical churn and I never read those columns.';

/** The head, as the corpus re-read supplies it. */
const head = (text: string) => text.slice(0, TURN_ORIGIN_HEAD_CHARS);

describe('classifyHitTurnOrigin — the false-confirmation cases', () => {
  it('stamps a loop-fire wake as machine-injected even though speaker is "user"', () => {
    const got = classifyHitTurnOrigin('user', head(LOOP_FIRE_TURN));
    expect(got.verdict).toBe('agent-injected');
    expect(got.origin).toBe('loop-fire');
    expect(got.note).toMatch(/AGENT-AUTHORED/);
    // The [owner:…] tag inside the goal must not be treated as corroboration.
    expect(got.note).toMatch(/replayed VERBATIM every fire/);
  });

  it.each(['fleet-kickoff', 'self-compaction', 'wake-pump'])(
    'stamps %s injections as machine-injected too',
    (origin) => {
      const got = classifyHitTurnOrigin('user', `${envelope(origin)}\nwake preamble`);
      expect(got.verdict).toBe('agent-injected');
      expect(got.origin).toBe(origin);
    },
  );

  it('leaves a genuine owner turn affirmatively owner-typed, with no hedging note', () => {
    const got = classifyHitTurnOrigin('user', 'please stop the fleet and fix the gate first');
    expect(got.verdict).toBe('owner-typed');
    expect(got.origin).toBeNull();
    // Property 2's other direction: repeating a caution on every owner hit
    // pushes agents toward disbelieving real directives (EI-13472).
    expect(got.note).toBeUndefined();
  });

  it('reports a promoted AskUserQuestion answer as affirmative owner-dialog provenance', () => {
    const got = classifyHitTurnOrigin(
      'user',
      dialogAnswerText('The user answered: "Which route?"="visible fleet".', 'human'),
    );
    expect(got).toEqual({ verdict: 'owner-dialog', origin: null });
  });
});

describe('property 1 — the verdict is read from the HEAD, never from an excerpt', () => {
  it('does NOT treat a mid-body QUOTE of an envelope as the turn own origin', () => {
    // Agents paste provenance blocks as evidence (13 such turns in the measured
    // 3-day window, this work included). A substring test would misfire here.
    const turn =
      'Here is the evidence I gathered while triaging:\n' +
      `  turnProvenance: { ref: "${envelope('loop-fire')}", verdict: "agent-injected" }\n` +
      'so the checkpoint write path already resolves it.';
    expect(turn).toContain('⟦turn-origin:'); // the naive test WOULD match
    expect(classifyHitTurnOrigin('user', head(turn)).verdict).toBe('owner-typed');
  });

  it('CONTROL: the same turn classified from a hybrid-style mid-body excerpt reports owner-typed — which is why the head is re-read from the corpus', () => {
    // This is the trap the DB round trip exists to avoid. A hybrid hit excerpt
    // is a relevance-selected snippet; here it is the quotable "directive"
    // sentence, with the head envelope nowhere in it.
    const midBodyExcerpt = LOOP_FIRE_TURN.slice(-120);
    expect(midBodyExcerpt).not.toContain('⟦turn-origin:');

    const fromExcerpt = classifyHitTurnOrigin('user', midBodyExcerpt);
    const fromHead = classifyHitTurnOrigin('user', head(LOOP_FIRE_TURN));

    expect(fromExcerpt.verdict).toBe('owner-typed'); // confidently WRONG
    expect(fromHead.verdict).toBe('agent-injected'); // correct
    expect(fromExcerpt.verdict).not.toBe(fromHead.verdict);
  });

  it('fetches enough head for the classifier own 240-char scan window', () => {
    // Under-fetching silently changes verdicts; over-fetching cannot, because
    // classifyRecordedTurn re-slices internally.
    expect(TURN_ORIGIN_HEAD_CHARS).toBeGreaterThanOrEqual(240);
    const late = `${'/compact '.repeat(20)}<command-name>foo</command-name>`;
    expect(late.indexOf('<command-name>')).toBeGreaterThan(150);
    expect(classifyHitTurnOrigin('user', head(late)).verdict).toBe('synthetic');
  });
});

describe('property 2 — a miss is UNKNOWN, never "agent-authored"', () => {
  it('renders unknown when the turn text could not be read', () => {
    for (const missing of [null, undefined, '', '   ']) {
      const got = classifyHitTurnOrigin('user', missing);
      expect(got.verdict).toBe('unknown');
      expect(got.verdict).not.toBe('agent-injected');
      expect(got.origin).toBeNull();
    }
  });

  it('renders unknown when the speaker was not recorded', () => {
    const got = classifyHitTurnOrigin(null, 'some text');
    expect(got.verdict).toBe('unknown');
  });

  it('says in words that a miss is not proof of fabrication', () => {
    // The inverse failure is measured and real: an AskUserQuestion-delivered
    // owner directive is not turn-stamped, so an agent that reads "no stamp"
    // as "manufactured" calls a REAL directive fake (EI-13472 / WI-37419).
    const note = unknownTurnOrigin('the lookup failed').note ?? '';
    expect(note).toMatch(/never as\s+agent-authored/);
    expect(note).toMatch(/AskUserQuestion/);
  });

  it('never stamps an assistant turn owner-typed', () => {
    // Unguarded, classifyRecordedTurn would: assistant turns carry no envelope,
    // so all 25,198 in the measured window would have qualified as owner-typed.
    const got = classifyHitTurnOrigin('assistant', 'I will now fix the gate.');
    expect(got.verdict).toBe('not-user-turn');
    expect(got.verdict).not.toBe('owner-typed');
  });
});

/**
 * FALSIFIABILITY (CLAUDE.md "Proving a guard is falsifiable", tier 1).
 *
 * A guard that has never failed is a guard nobody has tested. The copy-out
 * mutation probe is NOT available here: this suite imports the subject
 * statically, so `PROBE_SCRIPT` would be ignored and the probe would measure
 * the REAL module and report a confident "MUTANT SURVIVED" — accusing a sound
 * guard of being weak. Tier 1 is the right instrument for an imported module:
 * keep the plausible-but-wrong implementations here, permanently, and show the
 * assertions above DISCRIMINATE rather than passing for anything.
 *
 * Each control is a shape someone would actually write.
 */
describe('controls — the wrong implementations these assertions must reject', () => {
  /** WRONG #1: "does the text contain an envelope?" — ignores head-anchoring. */
  const naiveSubstring = (head: string) =>
    (head.includes('⟦turn-origin:') ? 'agent-injected' : 'owner-typed');

  /** WRONG #2: classify every turn, no speaker guard. */
  const unguardedBySpeaker = (head: string) => classifyHitTurnOrigin('user', head).verdict;

  /** WRONG #3: "no owner stamp ⇒ someone made it up" — the EI-13472 inverse failure. */
  const pessimisticOnMiss = () => 'agent-injected' as const;

  it('rejects the substring classifier: it misreads a QUOTED envelope as the turn own origin', () => {
    const quoting = head(
      `I am pasting evidence: "${envelope('loop-fire')}" — note it is agent-injected.`,
    );
    expect(naiveSubstring(quoting)).toBe('agent-injected'); // the control is WRONG here
    expect(classifyHitTurnOrigin('user', quoting).verdict).toBe('owner-typed'); // subject is right
  });

  it('rejects the unguarded classifier: it stamps assistant output owner-typed', () => {
    const assistantText = head('I will now fix the gate and re-run the suite.');
    expect(unguardedBySpeaker(assistantText)).toBe('owner-typed'); // WRONG for a non-user turn
    expect(classifyHitTurnOrigin('assistant', assistantText).verdict).toBe('not-user-turn');
  });

  it('rejects the pessimistic classifier: a miss is not proof of fabrication', () => {
    expect(pessimisticOnMiss()).toBe('agent-injected'); // WRONG — calls a real directive fake
    expect(classifyHitTurnOrigin('user', null).verdict).toBe('unknown');
  });

  it('CALIBRATION: the subject still catches the real thing, so the controls above are not passing vacuously', () => {
    expect(classifyHitTurnOrigin('user', head(LOOP_FIRE_TURN)).verdict).toBe('agent-injected');
  });
});

describe('resolveHitTurnOrigins', () => {
  type Row = {
    source_kind: string; session_id: string; turn_idx: number;
    speaker: string | null; head: string | null; tail?: string | null;
  };
  const fakeSql = (rows: Row[], captured?: unknown[][]) =>
    ((_strings: TemplateStringsArray, ...values: unknown[]) => {
      captured?.push(values);
      return Promise.resolve(rows);
    }) as unknown as Sql;

  const key = { sourceKind: 'claude', sessionId: 'sess-1', turnIdx: 7 };

  it('keys each classified turn by its full coordinate', async () => {
    const got = await resolveHitTurnOrigins(
      fakeSql([{ source_kind: 'claude', session_id: 'sess-1', turn_idx: 7, speaker: 'user', head: head(LOOP_FIRE_TURN) }]),
      'ws',
      [key],
    );
    expect(got.get(turnOriginKey(key))?.verdict).toBe('agent-injected');
  });

  it('omits a turn the corpus did not return, so the caller renders unknown rather than guessing', async () => {
    const got = await resolveHitTurnOrigins(fakeSql([]), 'ws', [key]);
    expect(got.has(turnOriginKey(key))).toBe(false);
  });

  it('makes no query at all for an empty page', async () => {
    const captured: unknown[][] = [];
    const got = await resolveHitTurnOrigins(fakeSql([], captured), 'ws', []);
    expect(got.size).toBe(0);
    expect(captured).toHaveLength(0);
  });

  it('passes the page coordinates as parallel arrays in one round trip', async () => {
    const captured: unknown[][] = [];
    const keys = [key, { sourceKind: 'omp', sessionId: 'sess-2', turnIdx: 3 }];
    await resolveHitTurnOrigins(fakeSql([], captured), 'ws', keys);
    expect(captured).toHaveLength(1); // batched, not N+1
    expect(captured[0]).toContainEqual(['claude', 'omp']);
    expect(captured[0]).toContainEqual(['sess-1', 'sess-2']);
    expect(captured[0]).toContainEqual([7, 3]);
  });

  it('WI-10004057: reads the tail so a long paste-wrapped injection is not owner speech', async () => {
    const full = pasted(LOOP_FIRE_TURN + 'y'.repeat(2000));
    const got = await resolveHitTurnOrigins(
      fakeSql([{ source_kind: 'claude', session_id: 'sess-1', turn_idx: 7, speaker: 'user', head: head(full), tail: tail(full) }]),
      'ws',
      [key],
    );
    expect(got.get(turnOriginKey(key))?.verdict).toBe('agent-injected');
  });

  it('EI-24443430418223338: keeps a long paste-wrapped wake-pump turn out of owner provenance', async () => {
    const full = pasted(
      envelope('wake-pump') +
        '\n[await-event] coord:inbox-wake:agent fired — ' +
        'wake payload '.repeat(40),
    );
    expect(head(full)).not.toContain('</pasted_content');
    expect(tail(full)).toContain('</pasted_content');
    expect(classifyHitTurnOrigin('user', head(full)).verdict).toBe('owner-typed');

    const got = await resolveHitTurnOrigins(
      fakeSql([{ source_kind: 'claude', session_id: 'sess-1', turn_idx: 7, speaker: 'user', head: head(full), tail: tail(full) }]),
      'ws',
      [key],
    );

    expect(got.get(turnOriginKey(key))).toMatchObject({
      verdict: 'agent-injected',
      origin: 'wake-pump',
    });
  });
});

/**
 * WI-10004057 — the head-bounded read of a PASTE-WRAPPED turn.
 *
 * PTY injectors (wake-pump, loop-fire, self-compaction) arrive wrapped in a Claude Code
 * paste block. The whole-paste unwrap needs the closing tag at the tail, and a bounded
 * head of a long paste has none — measured: a loop-fire turn surfaced by
 * `sessions:search` as `owner-typed`, and the same head fed the activation audit's
 * owner-evidence check. The tail restores the verdict the full text would get; owner
 * words on either side of a paste must still keep the owner verdict.
 */
const PASTE_ID = '9879';
const pasted = (inner: string) => `<pasted_content id="${PASTE_ID}">\n${inner}\n</pasted_content id="${PASTE_ID}">\n`;
const tail = (text: string) => text.slice(-TURN_ORIGIN_TAIL_CHARS);

describe('WI-10004057 — a paste-wrapped injection longer than the head', () => {
  const full = pasted(LOOP_FIRE_TURN + 'y'.repeat(2000));

  it('the head alone has lost the closing tag (the geometry of the bug)', () => {
    expect(head(full)).not.toContain('</pasted_content');
    // The pre-fix reading: without the tail the machine turn passes as the owner.
    expect(classifyHitTurnOrigin('user', head(full)).verdict).toBe('owner-typed');
  });

  it('with the tail, it classifies as the injection the full text is', () => {
    const got = classifyHitTurnOrigin('user', head(full), tail(full));
    expect(got.verdict).toBe('agent-injected');
    expect(got.origin).toBe('loop-fire');
  });

  it('owner words AFTER the paste keep the owner verdict (whole-prompt rule)', () => {
    const quoted = `${full}please look at this wake`;
    expect(classifyHitTurnOrigin('user', head(quoted), tail(quoted)).verdict).toBe('owner-typed');
  });

  it('owner words BEFORE the paste keep the owner verdict', () => {
    const quoted = `what is this?\n${full}`;
    expect(classifyHitTurnOrigin('user', head(quoted), tail(quoted)).verdict).toBe('owner-typed');
  });

  it('a different paste closing at the tail does not unwrap the first', () => {
    const two = `${pasted(LOOP_FIRE_TURN + 'y'.repeat(2000))}owner note\n<pasted_content id="aaaa">\nquoted\n</pasted_content id="aaaa">`;
    expect(classifyHitTurnOrigin('user', head(two), tail(two)).verdict).toBe('owner-typed');
  });

  it('a short paste that fits in the head classifies the same with or without the tail', () => {
    const short = pasted(`${envelope('wake-pump')}\nwake`);
    expect(classifyHitTurnOrigin('user', head(short)).verdict).toBe('agent-injected');
    expect(classifyHitTurnOrigin('user', head(short), tail(short)).verdict).toBe('agent-injected');
  });
});

describe('WI-10004510: the stored ingest verdict downgrades a text owner-typed residual, never grants owner', () => {
  const CLEAN = 'please stop the fleet and fix the gate first';

  it('calibration: a clean user turn with no stored verdict is the owner-typed residual', () => {
    expect(classifyHitTurnOrigin('user', CLEAN).verdict).toBe('owner-typed');
    // NULL = never classified (pre-794): the text verdict stands, never `unknown`.
    expect(classifyHitTurnOrigin('user', CLEAN, null, { verdict: null }).verdict).toBe('owner-typed');
  });

  it('a stored unenrolled-origin turn reads as unknown, never as owner speech', () => {
    const got = classifyHitTurnOrigin('user', CLEAN, null, { verdict: 'unenrolled-origin' });
    expect(got.verdict).toBe('unknown');
    expect(got.note).toMatch(/unenrolled-origin/);
    expect(got.note).toMatch(/never as agent-authored/);
  });

  it('a stored machine verdict downgrades the residual and keeps its origin', () => {
    const injected = classifyHitTurnOrigin('user', CLEAN, null, { verdict: 'agent-injected', origin: 'loop-fire' });
    expect(injected).toMatchObject({ verdict: 'agent-injected', origin: 'loop-fire' });
    expect(classifyHitTurnOrigin('user', CLEAN, null, { verdict: 'machine-surface' }).verdict).toBe('machine-surface');
    expect(classifyHitTurnOrigin('user', CLEAN, null, { verdict: 'synthetic' }).verdict).toBe('synthetic');
  });

  it('a stored owner verdict keeps the owner reading', () => {
    for (const verdict of ['owner-typed', 'owner-turn', 'owner-dialog']) {
      expect(classifyHitTurnOrigin('user', CLEAN, null, { verdict }).verdict).toBe('owner-typed');
    }
  });

  it('a stored owner verdict cannot upgrade a turn the text proves machine-injected', () => {
    const got = classifyHitTurnOrigin('user', head(LOOP_FIRE_TURN), null, { verdict: 'owner-typed' });
    expect(got.verdict).toBe('agent-injected');
    expect(classifyHitTurnOrigin('assistant', 'I will fix it', null, { verdict: 'owner-typed' }).verdict).toBe('not-user-turn');
  });

  it('an unrecognised stored verdict is unknown — never owner, never agent', () => {
    expect(classifyHitTurnOrigin('user', CLEAN, null, { verdict: 'some-future-verdict' }).verdict).toBe('unknown');
  });

  it('the literal is pinned to the ingest constant it mirrors', async () => {
    const { UNENROLLED_ORIGIN_VERDICT } = await import('../../search/session-ingest');
    expect(STORED_UNENROLLED_ORIGIN).toBe(UNENROLLED_ORIGIN_VERDICT);
  });

  it('resolveHitTurnOrigins selects and applies the stored verdict', async () => {
    const captured: TemplateStringsArray[] = [];
    const sql = ((strings: TemplateStringsArray) => {
      captured.push(strings);
      return Promise.resolve([
        { source_kind: 'claude', session_id: 'sess-1', turn_idx: 7, speaker: 'user', head: CLEAN, tail: CLEAN, turn_origin: null, turn_origin_verdict: 'unenrolled-origin' },
      ]);
    }) as unknown as Sql;
    const key = { sourceKind: 'claude', sessionId: 'sess-1', turnIdx: 7 };
    const got = await resolveHitTurnOrigins(sql, 'ws', [key]);
    expect(got.get(turnOriginKey(key))?.verdict).toBe('unknown');
    expect(captured[0].join('?')).toMatch(/turn_origin_verdict/);
  });
});
