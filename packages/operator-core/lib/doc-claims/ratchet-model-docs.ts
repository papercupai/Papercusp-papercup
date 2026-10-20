/**
 * Doc-claim detector: the agent guide and the su/engineer personas describe the RATCHET
 * promotion model (plan green-main-ratchet-convergence-2026-10-17, P-011 / R-10).
 *
 * The rule itself lives in `packages/operator-core/lib/release/promotion-ratchet.ts`
 * (`decidePromotionRatchet`): `main` advances when no BLOCKING failure remains, where only a
 * failure covered by an active downgrade record (`harness_shared.test_downgrades`) is
 * non-blocking. Before the ratchet, the docs said `main` advances only when the suite is fully
 * green and told agents to hand-quarantine a test that could not be fixed quickly. Those two
 * statements now contradict the code, so this detector reports them.
 *
 * R-10's falsifiers, one check each:
 *   (1) the guide still states main must be fully green to advance;
 *   (2) the gate-ownership guidance omits fix → eject → downgrade;
 *   (3) the hand-quarantine rule omits the downgrade store.
 *
 * Pure: callers pass the text. The live test reads the projected CLAUDE.md, the two persona
 * sources and the rendered promotion-model section.
 */

export type RatchetDocFalsifier = 1 | 2 | 3;

export interface RatchetDocViolation {
  falsifier: RatchetDocFalsifier;
  /** Which input the violation was found in (a label the caller chose). */
  where: string;
  detail: string;
}

export interface RatchetDocText {
  label: string;
  text: string;
}

export interface RatchetModelDocsInput {
  /** The agent guide (projected CLAUDE.md / AGENTS.md). */
  guide: RatchetDocText;
  /** Generated sections that state the promotion model to agents (promotion-model.ts). */
  promotionSections: readonly RatchetDocText[];
  /** Persona sources carrying the red-gate ownership bullet (su.md, agent-base-overlay.md). */
  personas: readonly RatchetDocText[];
}

/** Phrasings that state the retired "main must be fully green" model. */
export const RETIRED_GREEN_ONLY_PHRASES: readonly RegExp[] = [
  /GREEN-ONLY/,
  /is the GREEN branch/i,
  /passed the green-checkpoint suite/i,
  /fully green to (advance|promote)/i,
  /only when (the suite|it) passes/i,
];

/** What the guide must name so a reader can find the rule and the store it reads. */
export const GUIDE_RULE_ANCHORS: readonly string[] = [
  'no BLOCKING failure',
  'harness_shared.test_downgrades',
  'decidePromotionRatchet',
  'release:test-downgrade',
];

const LADDER = /fix\s*(→|->)\s*eject\s*(→|->)\s*downgrade/i;
const RETIRED_QUARANTINE_RULE = /Hand-quarantine a test ONLY when/i;
const GATE_OWNERSHIP_HEAD = '- **A red release/CI gate has exactly ONE fixer';

/**
 * The persona's red-gate ownership bullet: from its heading to the next top-level bullet.
 * Returns null when the bullet is missing, which the detector reports as a violation rather
 * than a pass (a deleted bullet must not read as compliant).
 */
export function extractGateOwnershipBullet(persona: string): string | null {
  const start = persona.indexOf(GATE_OWNERSHIP_HEAD);
  if (start < 0) return null;
  const rest = persona.slice(start + GATE_OWNERSHIP_HEAD.length);
  const next = rest.search(/\n- \*\*/);
  return GATE_OWNERSHIP_HEAD + (next < 0 ? rest : rest.slice(0, next));
}

export function judgeRatchetModelDocs(input: RatchetModelDocsInput): RatchetDocViolation[] {
  const out: RatchetDocViolation[] = [];

  // (1) No text tells agents main must be fully green; the guide names the ratchet rule.
  for (const doc of [input.guide, ...input.promotionSections]) {
    for (const re of RETIRED_GREEN_ONLY_PHRASES) {
      const m = doc.text.match(re);
      if (m) out.push({ falsifier: 1, where: doc.label, detail: `states the retired green-only model: "${m[0]}"` });
    }
  }
  for (const anchor of GUIDE_RULE_ANCHORS) {
    if (!input.guide.text.includes(anchor)) {
      out.push({ falsifier: 1, where: input.guide.label, detail: `does not name the ratchet rule anchor "${anchor}"` });
    }
  }
  for (const section of input.promotionSections) {
    if (!section.text.includes('no BLOCKING failure')) {
      out.push({ falsifier: 1, where: section.label, detail: 'does not state that main advances when no BLOCKING failure remains' });
    }
  }

  // (2) and (3) per persona, inside the red-gate ownership bullet.
  for (const persona of input.personas) {
    const bullet = extractGateOwnershipBullet(persona.text);
    if (bullet === null) {
      out.push({ falsifier: 2, where: persona.label, detail: 'the red-gate ownership bullet is missing' });
      continue;
    }
    if (!LADDER.test(bullet)) {
      out.push({ falsifier: 2, where: persona.label, detail: 'the gate-ownership guidance omits fix → eject → downgrade' });
    }
    if (!/downgrade store/i.test(bullet)) {
      out.push({ falsifier: 3, where: persona.label, detail: 'the quarantine rule omits the downgrade store' });
    }
    const retired = bullet.match(RETIRED_QUARANTINE_RULE);
    if (retired) {
      out.push({ falsifier: 3, where: persona.label, detail: `still carries the hand-quarantine rule: "${retired[0]}"` });
    }
  }

  return out;
}
