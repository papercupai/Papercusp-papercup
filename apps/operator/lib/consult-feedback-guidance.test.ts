import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
// operator.tools.md is DELIBERATELY absent. It drives the `operator-converse`
// chat surface, whose tool surface does NOT include `consult:get_feedback`, and
// `tools-md-sync.test.ts` fails any *.tools.md that NAMES a tool absent from its
// own role surface. Requiring the literal here made the two guards contradict
// each other outright: satisfying one necessarily reddened the other, which is
// what commit 565eec8d8e hit when it de-named the tool to green tools-md-sync
// and thereby blanked guidanceBlock()'s marker. R-3/R-4 scope the block to
// prompts that drive a WORKING agent, which operator-converse is not.
// FOLLOW-UP (WI-10002729): worker.tools.md drives working agents and carries
// the tool. Its first-pass and exclusion rules use equivalent wording, so the
// predicates accept those established variants rather than requiring copied
// prose. The prompt was missing dispatch behavior; this guard now covers it.
// The negative controls below read THIS file BY NAME, never by list position:
// each mutates a real block and asserts the predicate then fails, so if the list
// order shifts under them they would mutate a file that never carried the phrase,
// the .replace() would be a no-op, and the control would pass VACUOUSLY.
const NEGATIVE_CONTROL_FILE = 'apps/operator/prompts/papercup.tools.md';
const GUIDANCE_FILES = [
  'apps/operator/prompts/papercup.tools.md',
  'apps/operator/prompts/papercup-deep.tools.md',
  'apps/operator/prompts/worker.tools.md',
  'libs/papercusp/packages/harness/blueprints/base/prompts/agent-base-preamble.md',
];

function normalizedGuidance(block: string): string {
  return block.toLowerCase()
    .replace(/-/g, ' ')
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function guidanceBlock(text: string): string {
  const marker = text.toLowerCase().indexOf('consult:get_feedback');
  if (marker < 0) return '';
  const nextHeading = text.slice(marker).search(/\n#{1,6} /);
  return text.slice(marker, nextHeading < 0 ? undefined : marker + nextHeading)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join(' ');
}

function hasWhenGuidance(block: string): boolean {
  const lower = normalizedGuidance(block);
  const checkedLocalSources = /\bfirst pass check\b.{0,32}\blocal code\b.{0,24}\bdocs?\b.{0,16}\b(?:and|or)\b.{0,16}\bsearch\b/.test(lower);
  const asksOneQuestion = lower.includes('use it once') ||
    lower.includes('use it for one') ||
    /\bone (?:concrete|narrow|substantial) question\b/.test(lower);
  return checkedLocalSources && asksOneQuestion && lower.includes('what you tried');
}

function hasWhenNotGuidance(block: string): boolean {
  const lower = normalizedGuidance(block);
  const knownAgent = lower.includes('known agent') || lower.includes('agent you can already name');
  const ownerDecision = lower.includes('owner decisions') || lower.includes('decision that is the owner');
  const workHandoff = lower.includes('work handoffs') ||
    lower.includes('handing work off') ||
    lower.includes('handing off work');
  const answerableLocally = /\bcode\b.{0,32}\bdocs?\b.{0,32}\bsearch\b.{0,32}\balready answer\b/.test(lower);
  return lower.includes('live state') && knownAgent && ownerDecision && workHandoff &&
    lower.includes('no_available_responder') && answerableLocally;
}

function hasDispatchGuidance(block: string): boolean {
  const lower = normalizedGuidance(block);
  return lower.includes('archive') && lower.includes('isolated answer session') &&
    lower.includes('does not wake the expert') && lower.includes('walled backend') &&
    lower.includes('skip');
}

describe('consult:get_feedback prompt guidance (P-008)', () => {
  for (const relativePath of GUIDANCE_FILES) {
    it(`${relativePath} carries the bounded when/when-not block`, () => {
      const block = guidanceBlock(readFileSync(join(REPO, relativePath), 'utf8'));
      expect(block).toContain('consult:get_feedback');
      expect(hasWhenGuidance(block)).toBe(true);
      expect(hasWhenNotGuidance(block)).toBe(true);
      expect(hasDispatchGuidance(block)).toBe(true);
    });
  }
});

describe('consult:get_feedback prompt guard negative controls (P-008)', () => {
  it('positive guard accepts a prompt block that contains both calibrated-use rules', () => {
    const source = readFileSync(join(REPO, NEGATIVE_CONTROL_FILE), 'utf8');
    const block = guidanceBlock(source);
    expect(hasWhenGuidance(block)).toBe(true);
    expect(hasWhenNotGuidance(block)).toBe(true);
  });

  it('negative control: removing the when condition is detected', () => {
    const source = readFileSync(join(REPO, NEGATIVE_CONTROL_FILE), 'utf8');
    const broken = guidanceBlock(source).replace('first-pass check of local code, docs, or search', 'first-pass check');
    expect(hasWhenGuidance(broken)).toBe(false);
  });

  it('negative control: removing a when-not exclusion is detected', () => {
    const source = readFileSync(join(REPO, NEGATIVE_CONTROL_FILE), 'utf8');
    const broken = guidanceBlock(source).replace('live state', 'fresh status');
    expect(hasWhenNotGuidance(broken)).toBe(false);
  });
});
