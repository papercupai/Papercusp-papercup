/**
 * CLAUDE.md's gate-triage claim "the candidate is cut from the LOCAL integration
 * branch" must stay true of green-checkpoint.ts (EI-20022093720663793; sibling of
 * `retired-surfaces.test.ts` / `executable-claims.test.ts`, same P-004 family).
 *
 * The FIXTURE controls are load-bearing for the reason the siblings state: once the
 * live assertion goes green it stops being evidence that the detector works at all.
 * Each fixture below reproduces a shape that MUST be caught — including the exact
 * belief two agents held during WI-37590 (candidate cut from `origin/staging`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeGateCandidateRef, stripComments } from './gate-candidate-ref';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const GREEN_CHECKPOINT = join(ROOT, 'apps/operator/lib/release/green-checkpoint.ts');

/** Pad a fixture past the min-length refusal so we test the RULE, not the guard. */
const pad = (body: string): string => `${body}\n${'// filler\n'.repeat(120)}`;

describe('CLAUDE.md gate-candidate-ref claim', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches a candidate cut from a remote-tracking ref — the WI-37590 belief', () => {
      const verdict = judgeGateCandidateRef(
        pad(`
          let candidate = await revParse(cfg.integrationRoot, 'origin/staging');
        `),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.remoteRefSites).toHaveLength(1);
      expect(verdict.violations.join('\n')).toMatch(/remote-tracking ref/);
    });

    it('catches a gate that fetches before cutting', () => {
      const verdict = judgeGateCandidateRef(
        pad(`
          await exec('git', ['-C', cfg.integrationRoot, 'fetch', 'origin']);
          let candidate = await revParse(cfg.integrationRoot, cfg.integrationBranch);
        `),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.fetchSites).toHaveLength(1);
      expect(verdict.violations.join('\n')).toMatch(/git fetch/);
    });

    it('recognizes a local integration-branch resolution split across continuation lines', () => {
      const verdict = judgeGateCandidateRef(
        pad(`
          let candidate = await revParse(
            cfg.integrationRoot,
            cfg.integrationBranch,
          );
        `),
      );
      expect(verdict.ok).toBe(true);
      expect(verdict.candidateSites).toHaveLength(1);
    });

    it('catches the candidate site disappearing entirely', () => {
      const verdict = judgeGateCandidateRef(pad('const unrelated = 1;'));
      expect(verdict.ok).toBe(false);
      expect(verdict.candidateSites).toHaveLength(0);
      expect(verdict.violations.join('\n')).toMatch(/no longer holds/);
    });

    it('does not mistake a candidate diagnostic string containing origin/ for a remote resolution', () => {
      const source = [
        'let candidate = await revParse(cfg.integrationRoot, cfg.integrationBranch);',
        "log('green-checkpoint held: origin/${cfg.releaseRef} diverged from ${candidate.slice(0, 8)}');",
      ].join('\n');
      const verdict = judgeGateCandidateRef(pad(source));
      expect(verdict.remoteRefSites).toEqual([]);
      expect(verdict.ok).toBe(true);
    });

    it('catches a candidateRef assigned from a remote-tracking ref', () => {
      const source = [
        "const candidateRef = 'origin/staging';",
        'let candidate = await revParse(cfg.integrationRoot, candidateRef);',
      ].join('\n');
      const verdict = judgeGateCandidateRef(pad(source));
      expect(verdict.remoteRefSites).toHaveLength(1);
      expect(verdict.violations.join('\n')).toMatch(/remote-tracking ref/);
    });

    it('does NOT fire on a remote ref mentioned only in a comment', () => {
      const verdict = judgeGateCandidateRef(
        pad(`
          // test.yml defaults to origin/main on a workflow_dispatch run at ref=main
          /* the candidate is NOT origin/main — see the note above */
          let candidate = await revParse(cfg.integrationRoot, cfg.integrationBranch);
        `),
      );
      expect(verdict.remoteRefSites).toEqual([]);
      expect(verdict.ok).toBe(true);
    });

    it('REFUSES a short/empty read instead of reporting it clean', () => {
      // The false-absence shape: a failed read must never look like a passing gate.
      expect(() => judgeGateCandidateRef('')).toThrow(/Refusing to judge/);
      expect(() => judgeGateCandidateRef('let candidate = 1;')).toThrow(/Refusing to judge/);
    });
  });

  describe('the live claim', () => {
    const source = readFileSync(GREEN_CHECKPOINT, 'utf8');

    it('positive control: the real file was actually read', () => {
      // Guards against the whole suite passing over an empty/moved file.
      expect(source.split('\n').length).toBeGreaterThan(1000);
      expect(source).toMatch(/integrationBranch/);
    });

    // WI-41765 / D-008 — THE TWO ASSERTIONS BELOW USED TO SHARE ONE it(), AND MUST NOT AGAIN.
    //
    // They are different KINDS of claim and deserve different consequences on failure:
    //
    //   SUBSTANTIVE  — "the gate cuts from the LOCAL branch and never fetches" is a statement
    //                  about the RUNNING SYSTEM. If it breaks, the gate may be judging a sha
    //                  nobody asked for. That must hold `main` red.
    //
    //   COVERAGE     — "the detector can still see both sites" is a statement about the
    //                  INSTRUMENT, not the system. If it breaks, we have learned that the
    //                  detector went partially blind — real and worth fixing, but it freezes
    //                  the whole fleet's promotion over a measurement artifact.
    //
    // On 2026-08-25 ONLY the coverage assertion failed: green-checkpoint.ts grew past 14,500
    // lines, its resolution calls became multi-line, the line-based detector saw 1 site instead
    // of 2 — while `violations` stayed empty and `ok` stayed true. The claim itself never
    // stopped holding. That red helped freeze the gate (WI-41762).
    //
    // Bundled together, they were indistinguishable to every consumer: the failing entry named
    // one it() block, so a reader could not tell "the gate is fetching" from "the regex drifted",
    // and any file- or test-level exemption aimed at the drift would have ALSO switched off the
    // pin guarding against a remote-ref cut. Separated, each can be read — and classified — for
    // what it actually asserts.
    it('cuts the candidate from the LOCAL integration branch, and never fetches', () => {
      const verdict = judgeGateCandidateRef(source);
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
    });

    it('detector coverage: still sees both candidate-resolution sites (instrument health, not a system claim)', () => {
      // At least the primary cut site + the CLI path.
      //
      // ⚠ WIDEN THE DETECTOR, NEVER LOWER THIS FLOOR. Dropping `2` to `1` would make the 2026-08-25
      // drift pass silently while the "never fetches" pin above scanned a file whose second
      // resolution site it could no longer see — converting a loud instrument failure into a
      // quiet false-clean, which is strictly worse than the red it removes. The correct fix when
      // this fails is to teach the detector the new shape: that is what refResolutionWindow()
      // in gate-candidate-ref.ts already does for multi-line calls.
      const verdict = judgeGateCandidateRef(source);
      expect(verdict.candidateSites.length).toBeGreaterThanOrEqual(2);
    });

    it('no `origin/` mention participates in candidate resolution', () => {
      // MEASURED 2026-08-10, and deliberately NOT asserted as "comments only" — an
      // earlier draft of this test claimed that and FAILED, which is the point of
      // having it. Of the three `origin/main` hits, two are comments and one is a
      // LOG STRING (`test.yml defaults to origin/main`) that survives comment
      // stripping. All three are about GitHub Actions' base-ref default; none of
      // them resolves the gate's candidate, which is the property that matters.
      const verdict = judgeGateCandidateRef(source);
      expect(verdict.remoteRefSites).toEqual([]);

      const codeHits = stripComments(source).filter((l) => l.includes('origin/'));
      expect(codeHits.every((l) => !/revParse|rev-parse|candidate/i.test(l))).toBe(true);
      expect(source).toMatch(/origin\/main/); // control: they DO exist
    });
  });
});
