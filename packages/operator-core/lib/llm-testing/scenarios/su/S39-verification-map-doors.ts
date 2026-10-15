import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { RunSummary, Scenario, ToolDispatchOverride } from '@papercusp/testing-shell/llm';
import { SU_RUBRIC } from '../../rubrics/su';
import { CONTRACT_GATE_CODE_TYPES } from '../../../doc-claims/verification-system-map';

/**
 * S39 — a fresh agent given ONLY the verification-system map names the doors that
 * enforce a plan's requirement contract, and does not describe VAL-* as current.
 *
 * Plan verification-system-improvements-2026-10-10 P-001, clause
 * SPEC-P-001-FRESH-AGENT r2: at least two of three recorded runs must name every
 * enforcing door correctly, and no run may describe VAL-* as current.
 *
 * The expected doors are DERIVED from CONTRACT_GATE_CODE_TYPES (the registry the
 * doc-claims test pins the map to), never hand-listed, so a door added to the code
 * is a door this scenario expects.
 */

export const MAP_DOC_REL = 'apps/operator-docs/src/content/docs/agent-insights/verification-system-map.mdx';

/** The doors the requirement contract is enforced at, from the code registry. */
export const EXPECTED_DOORS: readonly string[] = [...new Set(CONTRACT_GATE_CODE_TYPES.map((g) => g.door))];

/** Walk up from this module to the repo root (the dir holding the map doc). */
function findRepoRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, MAP_DOC_REL))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The map body without its YAML frontmatter (the projection header lives there). */
export function stripFrontmatter(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  return (m ? text.slice(m[0].length) : text).trim();
}

/** Null when the doc cannot be found (e.g. a bundled copy of this module). */
export function loadMapDocBody(): string | null {
  try {
    const root = findRepoRoot();
    return root ? stripFrontmatter(readFileSync(join(root, MAP_DOC_REL), 'utf8')) : null;
  } catch {
    return null;
  }
}

const MAP_BODY = loadMapDocBody();
export const MAP_DOC_MISSING = 'MAP DOCUMENT UNAVAILABLE';

export const QUESTION = 'I am new to papercusp. Using ONLY the document below (no tools are available in this session), '
  + 'answer: does papercusp have validation contracts for plans, and how are they enforced? Name every tool that refuses '
  + 'when a plan\'s requirement contract is not met, and say what VAL-* assertion blocks are today. '
  + 'End your answer with exactly these two lines:\n'
  + 'DOORS: <comma-separated exact tool names of every enforcing door, and nothing else>\n'
  + 'VAL-STATUS: <current or retired>';

export const TRIGGER_TEXT = QUESTION + '\n\n--- BEGIN DOCUMENT ---\n' + (MAP_BODY ?? MAP_DOC_MISSING) + '\n--- END DOCUMENT ---';

const denied = (name: string) => ({ ok: true as const, content: [{ type: 'text' as const, text: JSON.stringify({
  ok: false, error: 'tool_unavailable',
  message: `${name} is unavailable: this session has no tools. Answer from the document in the message.` }) }] });

/** Every tool is refused, so the answer can only come from the inlined map. */
export function createNoToolsWorld(): ToolDispatchOverride {
  return { override: (name) => denied(name) };
}

const DOOR_TOKEN = /\bplans[:_][a-z][a-z-]*[a-z]/g;
const DOORS_LINE = /^[ \t>*_`-]*DOORS[*_`]*[ \t]*:[ \t]*(.+)$/im;
const VAL_LINE = /^[ \t>*_`-]*VAL-STATUS[*_`]*[ \t]*:[ \t]*(.+)$/im;
/**
 * Prose that calls VAL-* current. Deliberately narrow: the subject is VAL-* (optionally
 * "assertions"/"blocks"/"contracts") and the predicate is current/supported, with no
 * negation in between. The VAL-STATUS line is the primary signal.
 */
const VAL_CURRENT_PROSE = /\bVAL-(?:\*|[A-Z0-9]+)?\s+(?:assertion\s+)?(?:assertions|blocks?|contracts?)?\s*(?:is|are|remains?)\s+(?:still\s+)?(?:the\s+)?(?:current|supported)\b/i;

export interface MapDoorsViolation {
  readonly assertKind: string;
  readonly severity: 'error';
  readonly claim: string;
}

/** Judge one answer against the derived doors. Empty = the answer is correct. */
export function judgeMapDoorsAnswer(texts: readonly string[], expectedDoors: readonly string[] = EXPECTED_DOORS): MapDoorsViolation[] {
  const out: MapDoorsViolation[] = [];
  const answer = texts.find((t) => DOORS_LINE.test(t));
  if (!answer) {
    return [{ assertKind: 'custom:map-doors-structured-answer', severity: 'error',
      claim: 'The answer must end with a DOORS: line naming the enforcing doors.' }];
  }
  const named = new Set((DOORS_LINE.exec(answer)?.[1].match(DOOR_TOKEN) ?? []).map((t) => t.replace('_', ':')));
  const missing = expectedDoors.filter((d) => !named.has(d));
  const extra = [...named].filter((d) => !expectedDoors.includes(d));
  if (missing.length > 0 || extra.length > 0) {
    out.push({ assertKind: 'custom:map-doors-named-exactly', severity: 'error',
      claim: `DOORS must name exactly the enforcing doors. Missing: [${missing.join(', ')}]; not a door: [${extra.join(', ')}].` });
  }
  const val = VAL_LINE.exec(answer)?.[1] ?? '';
  if (!/^\W*retired\b/i.test(val)) {
    out.push({ assertKind: 'custom:map-val-status-retired', severity: 'error',
      claim: `VAL-STATUS must say retired; got "${val.trim() || '(missing)'}".` });
  }
  const prose = texts.map((t) => VAL_CURRENT_PROSE.exec(t)?.[0]).find(Boolean);
  if (prose) {
    out.push({ assertKind: 'custom:map-val-not-described-current', severity: 'error',
      claim: `The answer describes VAL-* as current: "${prose}".` });
  }
  return out;
}

export function judgeRun(run: RunSummary): MapDoorsViolation[] {
  if (!MAP_BODY) {
    return [{ assertKind: 'custom:map-doc-loaded', severity: 'error',
      claim: `The scenario could not load ${MAP_DOC_REL}; the run did not test the map.` }];
  }
  return judgeMapDoorsAnswer(run.turns.map((t) => t.assistantText ?? ''));
}

export const SU_S39_VERIFICATION_MAP_DOORS: Scenario = {
  id: 'su-S39-verification-map-doors', version: 1, target: 'su', transport: 'in-process',
  description: 'A fresh engineer has only the verification-system map (inlined; every tool is unavailable) and is asked '
    + 'whether papercusp has validation contracts, which tools enforce them, and what VAL-* blocks are today. '
    + 'Pass = names exactly the enforcing doors derived from CONTRACT_GATE_CODE_TYPES and calls VAL-* retired.',
  persona: BRIEF_ADMIN, goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  // The document must reach the SUT verbatim; a free-form simulator would paraphrase it.
  triggers: [{ on: 'after_turn', param: 0, fire: 'user_message', text: TRIGGER_TEXT }],
  simUserContext: 'You asked a factual question about the verification system and supplied the map document. '
    + 'Accept the first answer that ends with the DOORS and VAL-STATUS lines. Never suggest door names, corrections or '
    + 'the VAL-* status. If those two lines are missing, ask once for them.',
  caps: { maxTurns: 2, maxWallSecs: 240, maxCostUsd: 1 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  toolOverride: createNoToolsWorld(), rubric: SU_RUBRIC,
  asserts: [{ kind: 'custom', name: 'map-doors-named-and-val-retired', eval: judgeRun }],
};
