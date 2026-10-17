/**
 * consult:get_feedback does NOT wake the expert — pin the project guide's
 * prose to that code fact (WI-6554700010015726).
 *
 * The consult router's reach step is the fork/convert dispatcher: it launches an
 * ISOLATED answer session from the selected expert's transcript, and the expert's
 * own live session is never woken (get-feedback.ts header + tool description).
 * The CLAUDE.md / AGENTS.md guide part `a-blocker-is-work-not-a-stop-hit-a-blocker-somet`
 * nevertheless told every agent the router "wakes the best-qualified peer" — a
 * description of an older design that survived the dispatcher rewrite, and was
 * copied onward to papercusp.com/architecture §05.
 *
 * Two halves, so the guard fails in BOTH drift directions:
 *   1. the tool still declares the no-wake contract — if the code ever goes back
 *      to waking experts, this fails and points at the prose that must change too;
 *   2. no guide paragraph that names consult:get_feedback claims it wakes a peer.
 * A permanent fixture control proves the detector in (2) can still fail.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './corpus-subject';

const TOOL_RELPATH = 'packages/operator-core/lib/agent-tools/consult/get-feedback.ts';
const GUIDE_RELPATHS = ['CLAUDE.md', 'AGENTS.md'] as const;

const read = (relpath: string): string => readFileSync(join(ROOT, relpath), 'utf8');

/**
 * Every claim, inside a paragraph that names consult:get_feedback, that the
 * router WAKES a peer/expert. Paragraph-scoped so an unrelated "wakes the …" line
 * elsewhere in a guide is not attributed to the consult router.
 */
export function findConsultWakeClaims(text: string): string[] {
  const hits: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    if (!para.includes('consult:get_feedback')) continue;
    const flat = para.replace(/\s+/g, ' ');
    const re = /\bwakes? (?:up )?(?:the )?(?:best[- ]qualified|top|matched|selected|chosen)? ?(?:peer|expert|responder|agent)\b[^.]*/gi;
    for (const m of flat.matchAll(re)) hits.push(m[0]);
  }
  return hits;
}

describe('consult:get_feedback no-wake contract', () => {
  it('the tool still declares that the expert live session is not woken', () => {
    const src = read(TOOL_RELPATH);
    expect(src).toMatch(/does not wake the expert/);
    expect(src).toMatch(/live session is not woken/);
    // the tool's own arg descriptions are agent-facing too: max_agents once said
    // "the top selectee is woken", contradicting the header two screens up
    expect(src).not.toMatch(/selectee is woken/);
  });

  it.each(GUIDE_RELPATHS)('%s never claims the consult router wakes a peer', (relpath) => {
    const text = read(relpath);
    // vacuity floor: the guide must still discuss the router, or this rule judges nothing
    expect(text).toContain('consult:get_feedback');
    expect(findConsultWakeClaims(text)).toEqual([]);
  });

  it('control: the detector flags the pre-fix wording', () => {
    const preFix =
      'ask the router: `consult:get_feedback { question }`. It searches every agent\'s real\n' +
      'transcript history (yours excluded), wakes the best-qualified peer with\n' +
      'why-they-were-chosen evidence.';
    expect(findConsultWakeClaims(preFix)).toHaveLength(1);
    // and stays paragraph-scoped: the same verb outside a consult paragraph is not a hit
    expect(findConsultWakeClaims('a reply wakes the peer who asked.')).toEqual([]);
  });
});
