/**
 * R-10 (plan green-main-ratchet-convergence-2026-10-17, P-011): the guide and the personas
 * describe the ratchet promotion model, pinned to the rule `decidePromotionRatchet` exports.
 *
 * Falsifiers: (1) the guide still states main must be fully green to advance; (2) the
 * gate-ownership guidance omits fix → eject → downgrade; (3) the hand-quarantine rule omits
 * the downgrade store. Each has a fixture control that must FAIL, then the live claim.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractGateOwnershipBullet,
  judgeRatchetModelDocs,
  type RatchetModelDocsInput,
} from './ratchet-model-docs';
import {
  decidePromotionRatchet,
  type RatchetDowngrade,
  type RatchetFailingFile,
} from '../release/promotion-ratchet';
import { renderPromotionModelSection } from '../desktop-install/promotion-model';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const SU_BASE = 'libs/papercusp/packages/harness/blueprints/base/prompts/su.md';
const ENGINEER_OVERLAY = 'libs/papercusp/packages/harness/blueprints/papercusp-engineer/prompts/agent-base-overlay.md';

const GOOD_GUIDE =
  '`main` advances on a RATCHET: no BLOCKING failure remains unless an active record in ' +
  '`harness_shared.test_downgrades` covers it (`decidePromotionRatchet`); downgrade with ' +
  '`release:test-downgrade`.';
const GOOD_SECTION = 'main advances only when no BLOCKING failure remains.';
const GOOD_PERSONA = [
  '- **A red release/CI gate has exactly ONE fixer — READ OWNERSHIP BEFORE YOU ACT.**',
  '  Each red takes the ladder fix → eject → downgrade: fix it; else eject; only then',
  '  downgrade it in the downgrade store.',
  '- **A mitigation is not a fix.**',
].join('\n');

const input = (over: Partial<{ guide: string; section: string; persona: string }> = {}): RatchetModelDocsInput => ({
  guide: { label: 'guide', text: over.guide ?? GOOD_GUIDE },
  promotionSections: [{ label: 'promotion-model', text: over.section ?? GOOD_SECTION }],
  personas: [{ label: 'persona', text: over.persona ?? GOOD_PERSONA }],
});
const falsifiersOf = (i: RatchetModelDocsInput) => judgeRatchetModelDocs(i).map((v) => v.falsifier);

describe('ratchet-model docs detector (R-10)', () => {
  describe('fixture controls (each falsifier must be able to FAIL)', () => {
    it('passes a compliant guide, section and persona (over-fire calibration)', () => {
      expect(judgeRatchetModelDocs(input())).toEqual([]);
    });

    it('(1) catches a guide that still says main is green-only', () => {
      const v = judgeRatchetModelDocs(input({ guide: `${GOOD_GUIDE} \`main\` is GREEN-ONLY.` }));
      expect(v.map((x) => x.falsifier)).toEqual([1]);
      expect(v[0]?.detail).toContain('GREEN-ONLY');
    });

    it('(1) catches the old branch-discipline wording', () => {
      const guide = `${GOOD_GUIDE} It only fast-forwards to a staging commit that passed the green-checkpoint suite.`;
      expect(falsifiersOf(input({ guide }))).toEqual([1]);
    });

    it('(1) catches a guide that drops the rule entirely (no anchor names it)', () => {
      expect(falsifiersOf(input({ guide: 'Fix forward on staging.' }))).toEqual([1, 1, 1, 1]);
    });

    it('(1) catches a generated promotion section that says main advances only when the suite passes', () => {
      const section = 'fast-forwards main to a staging commit ONLY when it passes.';
      expect(falsifiersOf(input({ section }))).toEqual([1, 1]);
    });

    it('(2) catches gate-ownership guidance that omits fix → eject → downgrade', () => {
      const persona = GOOD_PERSONA.replace('fix → eject → downgrade', 'fix the reds');
      expect(falsifiersOf(input({ persona }))).toEqual([2]);
    });

    it('(2) reports a missing ownership bullet instead of passing it', () => {
      expect(falsifiersOf(input({ persona: '- **Something else.**\n' }))).toEqual([2]);
    });

    it('(3) catches a quarantine rule that omits the downgrade store', () => {
      const persona = GOOD_PERSONA.replace('in the downgrade store', 'somewhere');
      expect(falsifiersOf(input({ persona }))).toEqual([3]);
    });

    it('(3) catches the retired hand-quarantine rule left beside the ladder', () => {
      const persona = GOOD_PERSONA.replace(
        'downgrade it in the downgrade store.',
        'downgrade it in the downgrade store. Hand-quarantine a test ONLY when it is CONFIRMED-unrelated.',
      );
      expect(falsifiersOf(input({ persona }))).toEqual([3]);
    });

    it('reads only the ownership bullet, not text after the next top-level bullet', () => {
      const persona = GOOD_PERSONA.replace('fix → eject → downgrade', 'fix') + '\n  fix → eject → downgrade';
      expect(extractGateOwnershipBullet(persona)).not.toMatch(/eject → downgrade/);
      expect(falsifiersOf(input({ persona }))).toEqual([2]);
    });
  });

  describe('the rule the docs name is the rule the code runs', () => {
    const repoPathOf = (f: RatchetFailingFile) => `packages/ui/${f.file}`;
    const failing: RatchetFailingFile[] = [{ workspace: 'ui', file: 'src/button.test.tsx' }];
    const active: RatchetDowngrade = {
      testFile: 'packages/ui/src/button.test.tsx',
      testCase: '',
      revokedAt: null,
      criticalArea: null,
      riskAcknowledgement: null,
    };

    it('an active downgrade record makes the failure non-blocking (main may advance)', () => {
      const v = decidePromotionRatchet({ failingTests: ['ui'], failingFiles: failing, downgrades: [active], repoPathOf });
      expect(v.allFailuresDowngraded).toBe(true);
      expect(v.blocking).toEqual([]);
    });

    it('without the record the same failure blocks (main holds: "fully green" is not the rule, coverage is)', () => {
      const v = decidePromotionRatchet({ failingTests: ['ui'], failingFiles: failing, downgrades: [], repoPathOf });
      expect(v.allFailuresDowngraded).toBe(false);
      expect(v.blocking).toEqual(['packages/ui/src/button.test.tsx']);
    });

    it('a revoked record does not count', () => {
      const revoked: RatchetDowngrade = { ...active, revokedAt: '2026-10-18T00:00:00Z' };
      const v = decidePromotionRatchet({ failingTests: ['ui'], failingFiles: failing, downgrades: [revoked], repoPathOf });
      expect(v.allFailuresDowngraded).toBe(false);
    });

    it('the store and verb the guide names are the ones the code uses', () => {
      expect(read('packages/operator-core/lib/release/test-downgrade-store.ts')).toContain('harness_shared.test_downgrades');
      expect(read('packages/operator-core/lib/agent-tools/release/test-downgrade.ts')).toContain("name: 'release:test-downgrade'");
    });
  });

  describe('the live claim', () => {
    const live: RatchetModelDocsInput = {
      guide: { label: 'CLAUDE.md', text: read('CLAUDE.md') },
      promotionSections: [
        {
          label: 'promotion-model (rendered)',
          text: renderPromotionModelSection({
            enabled: true,
            integrationBranch: 'staging',
            releaseRef: 'main',
            greenCmd: 'npm run test:affected',
          }),
        },
      ],
      personas: [
        { label: SU_BASE, text: read(SU_BASE) },
        { label: ENGINEER_OVERLAY, text: read(ENGINEER_OVERLAY) },
      ],
    };

    it('holds for the projected guide, the rendered promotion section and both personas', () => {
      expect(judgeRatchetModelDocs(live)).toEqual([]);
    });

    it('holds for AGENTS.md (the Codex projection of the same guide)', () => {
      expect(judgeRatchetModelDocs({ ...live, guide: { label: 'AGENTS.md', text: read('AGENTS.md') } })).toEqual([]);
    });
  });
});
