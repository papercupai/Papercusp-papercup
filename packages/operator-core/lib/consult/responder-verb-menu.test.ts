import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { consultCurrentReviewContext, consultReadDoorLine, consultResponderVerbMenu, consultVoidExitLine } from './responder-verb-menu';
import { cascadeWakeBody, cascadeWakeCopyForRouting } from './cascade-core';
import { consultDispatchBrief } from './consult-dispatch';

/** The first turn a DISPATCHED answering session actually receives: the cascade
 * wake copy, wrapped in the dispatch frame (D-002 replaced the revival brief
 * with this). Composed from the REAL builders, so a brief that stops routing
 * through the menu fails these guards. */
const dispatchedFirstTurn = (conversationId: string) =>
  consultDispatchBrief({
    conversationId,
    sourceOwnerId: 'su-expert',
    operation: 'fork',
    summary: `🧭 consult: why did the cross-run cache always miss?`,
    body: cascadeWakeBody({
      question: 'why did the cross-run cache always miss?',
      conversationId,
      position: 1,
      menuSize: 2,
      next: { ownerId: 'su-expert', score: 0.72, relevance: 0.74, similarity: 0.66, via: 'floor', liveness: 'ended' },
      digest: [],
    }),
  });

const CONSULT_DIR = resolve(dirname(fileURLToPath(import.meta.url)));

describe('simplicity in the existing review', () => {
  it('asks initial design simplicity questions in first and cascade review briefs', () => {
    const initial = consultResponderVerbMenu({ conversationId: 'conv-initial' });
    const cascade = dispatchedFirstTurn('conv-next');
    for (const brief of [initial, cascade]) {
      expect(brief).toContain('initial review: is this the simplest design that meets the original scenarios?');
      expect(brief).toContain('What existing components can be reused');
      expect(brief).toContain('which complexity is necessary');
      expect(brief).toContain('what can be removed');
    }
  });
  it('renders the revised whole-design simplicity question for material revisions', () => {
    const menu = consultResponderVerbMenu({ conversationId: 'conv-revised' });
    expect(menu).toContain('After a material design revision, reassess the revised design as a whole');
    expect(menu).toContain('against those original scenarios');
    expect(menu).toContain('whether the added complexity is still necessary');
    expect(menu).toContain('a simpler reused approach');
  });
  it('adds simplicity guidance without changing the responder routing menu', () => {
    const menu = consultResponderVerbMenu({ conversationId: 'conv-bounded' });
    for (const verb of ['conversations:get', 'consult:reply', 'consult:decline', 'consult:close']) expect(menu).toContain(verb);
    expect(menu).toContain('existing review and follow-up exchange limit');
    expect(menu).toContain('adds no review stage or requirement for a clean review');
    expect(menu).toContain('Cosmetic-only changes do not trigger another simplicity review');
    expect(menu).toContain('TERMINAL and NON-ADVANCING');
  });
});

// EI-21761566265989000 — a routed reviewer answered a real consult without reading the thread,
// because every wake that routes a consult named the WRITE verbs and none named the READ door.
// These guards pin both halves: the menu says the right thing, and it is the ONLY thing that
// says it — so a sixth wake variant cannot quietly reintroduce the omission.

describe('the amendment request remains answerable after a cascade', () => {
  it.each(['fork', 'convert', 'brief'] as const)('carries current amendment inputs through a %s dispatch', (operation) => {
    const question = 'Review new amendment {"key":"r-006","files":["soak.test.ts"]}; preserve literal24h; approve thread-post:12345.';
    const input = {
      question, conversationId: 'conv-amendment', position: 2, menuSize: 2,
      next: { ownerId: 'su-expert', score: 0.72, relevance: 0.74, similarity: 0.66, via: 'floor' as const, liveness: 'ended' },
      digest: [],
    };
    const routing = { policy: 'acceptance-bar-amendment-review' };
    for (const snapshot of [routing, JSON.stringify(routing)]) {
      const copy = cascadeWakeCopyForRouting(snapshot)(input);
      const brief = consultDispatchBrief({
        conversationId: input.conversationId, sourceOwnerId: 'su-expert', operation, ...copy,
      });
      expect(brief).toContain(question);
      expect(brief).toContain('CURRENT AMENDMENT');
      expect(brief).toContain('do not decline solely');
      expect(copy.body).not.toContain('answer FROM your transcript');
      expect(brief).toContain('ANSWER-ONLY');
      expect(brief).toContain('Do not claim work-items');
      expect(brief).toContain('consult:reply');
    }
    const generic = cascadeWakeCopyForRouting({})(input);
    expect(generic.body).toContain('answer FROM your transcript');
    expect(generic.body).not.toContain('CURRENT AMENDMENT');
  });
});

describe('current review evidence survives the dispatch frame', () => {
  it('BAR critics inspect the current contract without treating it as execution approval', () => {
    const context = consultCurrentReviewContext('bar-critique');
    expect(context).toContain('CURRENT BARS');
    expect(context).toContain('current plan');
    expect(context).toContain('spec clauses');
    expect(context).toContain('Verify reviewer independence');
    expect(context).toContain('does not authorize execution');
    expect(context).toContain('do not decline solely');
    expect(context).toContain('results[0].conversation.body');
    expect(consultCurrentReviewContext(undefined)).toBeNull();
    expect(consultCurrentReviewContext('consult-default')).toBeNull();
  });

  for (const policy of ['rubric-vetting', 'acceptance-bar-amendment-review', 'method-review', 'bar-critique']) {
    for (const via of ['floor', 'minimum'] as const) {
      it.each(['fork', 'convert', 'brief'] as const)(`${policy}/${via} reviews current evidence on a %s launch`, (operation) => {
        const conversationId = 'conv-current-review';
        const copy = cascadeWakeCopyForRouting({ policy })({
          question: 'Review the current mobile rubric revision; replay probes are in observed/tried.',
          conversationId, position: 2, menuSize: 2, digest: [],
          next: { ownerId: 'su-unrelated-history', score: 0.1, relevance: 0.1, similarity: 0.1, via, liveness: 'ended' },
        });
        const brief = consultDispatchBrief({
          conversationId, sourceOwnerId: 'su-unrelated-history', operation, ...copy,
        });
        expect(brief).toContain('results[0].conversation.body');
        expect(brief).toContain('results[0].posts');
        expect(brief).toContain('do not decline solely');
        expect(brief).toContain('Cite the evidence you actually checked');
        if (policy === 'method-review') {
          expect(brief).toContain('CURRENT METHOD');
          expect(brief).toContain('does not authorize execution');
          expect(brief).toContain('Verify reviewer independence');
        }
        if (policy === 'bar-critique') {
          expect(brief).toContain('CURRENT BARS');
          expect(brief).toContain('spec clauses');
          expect(brief).toContain('Verify reviewer independence');
          expect(brief).toContain('does not authorize execution');
        }
        expect(brief).not.toMatch(/you answer from the transcript you inherited|Answer from the cited turns|Answer from the transcript\.|answer FROM your transcript/);
        expect(brief).toContain('ANSWER-ONLY');
        expect(brief).toContain('Do not claim work-items');
      });
    }
  }
});

describe('the consult responder verb menu names the read door', () => {
  it('names conversations:get, and says what a wrong-door read looks like', () => {
    const line = consultReadDoorLine('conv-abc');
    // The door itself, addressed to THIS conversation — a reviewer should not have to construct it.
    expect(line).toContain("conversations:get { id: 'conv-abc' }");
    // The keyed-array envelope is easy to misread as a top-level thread. Pin the exact path so a
    // successful read cannot silently turn into postCount 0 through `result.posts ?? []`.
    expect(line).toContain('posts are at results[0].posts');
    expect(line).toContain('not a top-level .posts field');
    expect(line).toContain('undefined and looks like an empty thread');
    // The guessable name does not exist. Saying so is the whole discoverability fix: the reviewer
    // who reported this reached for `consult:read` and concluded the capability was missing.
    expect(line).toContain('consult:read');
    // ...and the SILENT half: an empty result is indistinguishable from an empty thread. Without
    // this sentence a reviewer reads "no replies" as fact and reviews without the requester's posts.
    expect(line).toMatch(/EMPTY/);
  });

  it('renders the write verbs alongside it, with per-branch qualifiers', () => {
    const menu = consultResponderVerbMenu({
      conversationId: 'conv-xyz',
      evidenceNote: 'first-principles reasoning is admissible here',
      declineNote: "if it's not your area",
    });
    expect(menu).toContain("conversations:get { id: 'conv-xyz' }");
    expect(menu).toContain('consult:reply { kind } (first-principles reasoning is admissible here)');
    expect(menu).toContain("consult:decline { reason } if it's not your area");
    expect(menu).toContain('consult:close { outcome }');
    expect(menu).toContain('Untyped conversations:post is refused.');
  });

  it('falls back to the default qualifiers when a branch does not override them', () => {
    const menu = consultResponderVerbMenu({ conversationId: 'conv-1' });
    expect(menu).toContain('consult:reply { kind } (answer requires evidence)');
    // WI-1700133: the default decline qualifier must NOT be the "cannot add value" phrasing —
    // that is the exact reasoning a reviewer facing a VOID question follows into the one exit
    // that spends the next reviewer. It states decline's precondition and its cost instead.
    expect(menu).toContain('consult:decline { reason } only when another reviewer might still cover it');
    expect(menu).not.toContain('only if you genuinely cannot add value');
  });
});

// ---------------------------------------------------------------------------
// WI-1700133 — the VOID EXIT. `consult:close` was always reachable by the current responder and
// always non-advancing (pinned against real PG in consult-verbs-core.integration.test.ts); the
// defect was that every routing surface conditioned it on "when settled" / "you engaged", so a
// reviewer who judged the QUESTION void saw only exits that advance the cascade. On an acceptance
// grading cascade each advance permanently disqualifies that grader (D-009), so the copy below is
// what stands between a void consult and walking the entire independent-grader pool.
// ---------------------------------------------------------------------------

describe('the menu names the non-advancing void exit', () => {
  it('names close as TERMINAL and NON-ADVANCING for a void question, addressed to this conversation', () => {
    const line = consultVoidExitLine('conv-void');
    // The verb, with the outcome that reaches it — a reviewer should not have to construct it.
    expect(line).toContain("consult:close { outcome: 'cant_help', reason }");
    expect(line).toContain('conv-void');
    // The property that makes it the right exit. Without BOTH words a reviewer cannot tell this
    // exit from decline, which is the confusion that filed the item.
    expect(line).toMatch(/TERMINAL/);
    expect(line).toMatch(/NON-ADVANCING/);
    // The cost of getting it wrong, which is what makes the choice matter rather than be a style
    // preference: the alternative exits spend a reviewer, and a spent grader is gone for good.
    expect(line).toMatch(/spend the next reviewer/);
    expect(line).toContain('D-009');
    // The dichotomy itself — the cell the menu previously had no room for.
    expect(line).toContain('Decline means "not me, try the next reviewer"');
    expect(line).toContain('close means "nobody should answer this"');
  });

  it('the assembled menu carries it, not just the standalone line', () => {
    const menu = consultResponderVerbMenu({ conversationId: 'conv-xyz' });
    expect(menu).toContain("consult:close { outcome: 'cant_help', reason }");
    expect(menu).toMatch(/NON-ADVANCING/);
  });
});

describe('every real responder wake body carries the void exit', () => {
  // Derived from the REAL builders for the same reason the read-door guards are: a wake that
  // stops routing through the menu fails here even while the menu module stays perfect.
  it('the cascade advance wake does — the wake most likely to be handed a void consult', () => {
    const body = cascadeWakeBody({
      question: 'grade the acceptance rubric for plan X',
      conversationId: 'conv-cascade-void',
      position: 2,
      menuSize: 3,
      next: { ownerId: 'su-peer', score: 0.41, relevance: 0.38, similarity: 0.33, via: 'minimum', liveness: 'live' },
      digest: [],
    });
    expect(body).toContain("consult:close { outcome: 'cant_help', reason }");
    expect(body).toMatch(/NON-ADVANCING/);
  });

  it('the dispatch brief does — a launched answering session has no inbox to find the menu in', () => {
    const body = dispatchedFirstTurn('conv-dispatch-void');
    expect(body).toContain("consult:close { outcome: 'cant_help', reason }");
    expect(body).toMatch(/NON-ADVANCING/);
  });

  // FALSIFIABILITY CONTROL, kept permanently rather than proven once by mutating the shared tree.
  // Replays this describe-block's predicate against the PRE-FIX menu text — the exact string every
  // wake carried before WI-1700133 — and asserts it is caught. Without this the guards above pass
  // vacuously if the predicate stops describing anything real.
  it('the same predicate catches the pre-fix menu, which offered no void cell (control)', () => {
    const PRE_FIX_MENU =
      "READ THE THREAD FIRST — conversations:get { id: 'conv-1' } returns every post oldest-first.\n" +
      'Reply in conversation conv-1 with consult:reply { kind } (answer requires evidence); ' +
      'consult:decline { reason } only if you genuinely cannot add value; consult:close { outcome } when settled. ' +
      'Untyped conversations:post is refused.';
    // It DID name close — which is precisely why the omission was invisible — but only as
    // "when settled", with no outcome, no terminal/non-advancing property, and no void cell.
    expect(PRE_FIX_MENU).toContain('consult:close { outcome }');
    expect(PRE_FIX_MENU).not.toContain("consult:close { outcome: 'cant_help', reason }");
    expect(PRE_FIX_MENU).not.toMatch(/NON-ADVANCING/);
    // ...and the current menu clears the same bar the pre-fix one fails (positive control, so a
    // predicate that matched nothing at all could not read as "the pre-fix text was fine").
    const current = consultResponderVerbMenu({ conversationId: 'conv-1' });
    expect(current).toContain("consult:close { outcome: 'cant_help', reason }");
    expect(current).toMatch(/NON-ADVANCING/);
  });
});

// Derived from the REAL builders, not from a copy of their text: if a builder stops routing
// through the menu, these fail even though the menu module itself is still perfect.
describe('every real responder wake body carries the read door', () => {
  it('the cascade advance wake does', () => {
    const body = cascadeWakeBody({
      question: 'does the cache identity strip the launcher seam?',
      conversationId: 'conv-cascade',
      position: 2,
      menuSize: 3,
      next: { ownerId: 'su-peer', score: 0.41, relevance: 0.38, similarity: 0.33, via: 'minimum', liveness: 'live' },
      digest: [],
    });
    expect(body).toContain("conversations:get { id: 'conv-cascade' }");
    expect(body).toContain('consult:reply { kind }');
  });

  it('the dispatch brief does', () => {
    const body = dispatchedFirstTurn('conv-dispatch');
    expect(body).toContain("conversations:get { id: 'conv-dispatch' }");
    // The dispatch frame's own provenance must survive the refactor: a fork has
    // to be told it is a fork, or it answers as if it were the original.
    expect(body).toContain('You are a FORK of su-expert');
    expect(body).toContain('They were NOT notified and must not be');
  });
});

// ---------------------------------------------------------------------------
// SINGLE-RENDERER guard. The bug was five hand-maintained copies of one menu, and the fix is
// only durable while there is exactly one. This is the derived half: it reads the real directory
// rather than a list someone has to remember to update.
// ---------------------------------------------------------------------------

/** The signature of a hand-rolled responder menu: the decline verb with its argument object. */
const INLINE_MENU_MARKER = 'consult:decline { reason }';

const sourceFilesRenderingTheMenu = (): string[] =>
  readdirSync(CONSULT_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'responder-verb-menu.ts')
    .filter((f) => readFileSync(join(CONSULT_DIR, f), 'utf8').includes(INLINE_MENU_MARKER))
    .sort();

describe('the verb menu has exactly one renderer', () => {
  // CALIBRATION. Without this the guard below passes vacuously if the marker stops matching
  // anything at all — an empty result set is a subset of an empty expectation, and reads exactly
  // like "no file hand-rolls the menu". Prove the marker still describes the real menu first.
  it('the marker actually appears in the one legitimate renderer (positive control)', () => {
    const canonical = readFileSync(join(CONSULT_DIR, 'responder-verb-menu.ts'), 'utf8');
    expect(canonical).toContain(INLINE_MENU_MARKER);
    // ...and the directory scan really is looking at a populated directory.
    const scanned = readdirSync(CONSULT_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(scanned.length).toBeGreaterThanOrEqual(5);
    expect(scanned).toContain('get-feedback-core.ts');
    expect(scanned).toContain('cascade-core.ts');
    expect(scanned).toContain('consult-verbs-core.ts');
  });

  it('no other consult source renders the responder menu inline', () => {
    expect(sourceFilesRenderingTheMenu()).toEqual([]);
  });

  // FALSIFIABILITY CONTROL, kept permanently rather than proven once by mutating the shared tree
  // (a probe that edits a tracked file can be committed by the git-sync sweep even when nothing
  // goes wrong). This replays the exact predicate against a source that hand-rolls the menu — the
  // shape all five sites had before the fix — and asserts it is caught.
  it('the same predicate catches a hand-rolled sixth copy (control)', () => {
    const SYNTHETIC_SIXTH_WAKE = [
      'export function newRoutingWakeBody(conversationId: string): string {',
      '  return (',
      '    `You were routed a consult.\\n` +',
      '    `Reply in conversation ${conversationId} with consult:reply { kind } (answer requires evidence); ` +',
      '    `consult:decline { reason } only if you genuinely cannot add value; consult:close { outcome } when settled.`',
      '  );',
      '}',
    ].join('\n');
    expect(SYNTHETIC_SIXTH_WAKE.includes(INLINE_MENU_MARKER)).toBe(true);
    // ...and it does NOT fire on a file that merely mentions the verb without rendering the menu,
    // so the guard is a menu detector rather than a `consult:decline` word detector.
    const MERE_MENTION = 'hint: "To end the consult, use consult:close or consult:decline (responder)."';
    expect(MERE_MENTION.includes(INLINE_MENU_MARKER)).toBe(false);
  });
});
