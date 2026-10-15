/**
 * The project guide's "how to ARM a migration" sentence must name the LINTED arm
 * executor that `scripts/next-migration.mjs` actually prints, never a hand `mv`
 * (WI-10006549).
 *
 * Why this exists: `next-migration.mjs --arm` (since 2026-10-01) lints a DRAFT with
 * the same pre-apply gate boot auto-apply and db:migrate use, then publishes the
 * `.sql`. The CLAUDE.md/AGENTS.md doc part still said the arm_command was
 * `mv <path>.DRAFT <path>`. Migration 1389 was armed that way on 2026-10-06, skipped
 * the forward-compat lint, and was then refused at boot apply — wedging bg-host's
 * background plane until it was acknowledged and applied by hand.
 *
 * The fixture controls are load-bearing: they prove the detector can FAIL on the
 * exact stale sentence, so a green live assertion is evidence, not a vacuous pass.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { armCommandFor } from '../../../../scripts/next-migration.mjs';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The sentence that tells an agent how to arm a migration, or null if absent. */
function armSentence(guide: string): string | null {
  const m = guide.match(/ARM it with the printed `arm_command`[^\n]*/);
  return m ? m[0] : null;
}

/** Judge one guide body: the arm sentence must exist, name `--arm`, and not prescribe a hand mv. */
function judgeArmProse(guide: string): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  const s = armSentence(guide);
  if (!s) return { ok: false, violations: ['no "ARM it with the printed `arm_command`" sentence found'] };
  if (!/next-migration\.mjs --arm\b/.test(s)) violations.push('arm sentence does not name `next-migration.mjs --arm`');
  if (/`mv [^`]*\.DRAFT[^`]*`\)/.test(s)) violations.push('arm sentence prescribes a hand `mv` of the DRAFT');
  return { ok: violations.length === 0, violations };
}

describe('project guide: migration arm instruction', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches the stale WI-10006549 sentence that prescribed a raw mv', () => {
      const stale =
        'When it is finished and tested, ARM it with the printed `arm_command` (`mv <path>.DRAFT <path>`) at `libs/papercusp/libs/db/sql/<NNN>-…sql` (≥107), then run pull-schema.';
      const v = judgeArmProse(stale);
      expect(v.ok).toBe(false);
      expect(v.violations.join('\n')).toMatch(/does not name/);
      expect(v.violations.join('\n')).toMatch(/hand `mv`/);
    });

    it('catches a guide that dropped the arm sentence entirely', () => {
      expect(judgeArmProse('Write the migration and apply it.').ok).toBe(false);
    });

    it('accepts the corrected sentence', () => {
      const good =
        'ARM it with the printed `arm_command` (`next-migration.mjs --arm <draft>`: it lints like boot, then publishes `x.sql`) — never a hand `mv`, which skips the lint.';
      expect(judgeArmProse(good)).toEqual({ ok: true, violations: [] });
    });
  });

  it('the arm command the allocator prints is the linted executor', () => {
    expect(armCommandFor('libs/papercusp/libs/db/sql/9999-x.sql.DRAFT')).toMatch(/next-migration\.mjs --arm /);
  });

  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    it(`${file} names the linted arm executor, not a hand mv`, () => {
      const v = judgeArmProse(readFileSync(join(ROOT, file), 'utf8'));
      expect(v.violations).toEqual([]);
    });
  }
});
