/**
 * The documented responder bound must stay DERIVED from `selection-policies.ts`
 * (unified-responder-selection-critique-and-grading-2026-08-30 P-006).
 *
 * Sibling of `gate-candidate-ref.test.ts` / `retired-surfaces.test.ts`, and it
 * follows their discipline for the same reason: once the live assertions go
 * green they stop being evidence that the detector works at all. Every rule
 * below therefore keeps a permanent FIXTURE CONTROL reproducing the exact text
 * that was live before P-006 — the pre-fix CLAUDE.md line, the runbook's
 * `max_agents` instruction, both refusal messages. Those fixtures are the
 * falsifiability proof, and they never mutate the shared tree to get it
 * (CLAUDE.md's mutation-probe rule, the "module you import" tier).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SUBJECT_LABEL, readCorpus } from './corpus-subject';
import { trackedTextFiles, readTrackedText } from './tracked-text-files';
import {
  judgeSelectionPolicyProse,
  formatViolations,
  REQUIRED_POLICY_KEY,
  REQUIRED_RENDERER,
  censusHandTypedBoundSites,
  formatBoundSites,
  type ProseSubject,
} from './selection-policy-prose';

const RUNBOOK_RELPATH = 'apps/operator-docs/src/content/docs/agent-insights/acceptance-rubric-vetting.mdx';
const SHIP_GATE_RELPATH = 'packages/operator-core/lib/plan-acceptance-gate.ts';
const GOAL_GATE_RELPATH = 'packages/operator-core/lib/goals/wind-down-disposition.ts';
/**
 * The vetting FLAG's description comment — the seventh copy, found by sweeping for the
 * bound after the two sites P-006 was scoped to were fixed. It is judged as `prose`
 * rather than `source` because it explains the flow to a reader instead of rendering a
 * message: it must name the key and spell no count, but it calls nothing.
 */
const FLAGS_RELPATH = 'libs/flags/src/types.ts';

const read = (relpath: string): string => readFileSync(join(ROOT, relpath), 'utf8');

/** A prose fixture that satisfies every rule, so a control isolates ONE defect. */
const cleanProse = [
  '4. **Vet its current revision** — `consult:get_feedback { policy:\'rubric-vetting\' }` — pass that key',
  'and NO responder count, so the bound stays in `selection-policies.ts` where it is enforced.',
].join('\n');

/** The same, for a source subject: derives via the shared renderer. */
const cleanSource = [
  "import { rubricVettingConsultHint } from './consult/selection-policies';",
  '// the rubric AUTHOR vets it (a get_feedback consult) before a non-implementer grades',
  'const message = `critique of the rubric — ${rubricVettingConsultHint()}, (2) improve it`;',
].join('\n');

const judgeOne = (subject: ProseSubject) => judgeSelectionPolicyProse([subject]);

describe('selection-policy prose stays derived (P-006)', () => {
  describe('fixture controls — the detector must be able to FAIL', () => {
    it('distinguishes the no-expert result description from a prescribed zero count', () => {
      const description = '`min_agents: 0` returns\n"no one knows more than you do — proceed", never a costumed expert.';
      const clean = `${cleanProse}\n\n${description}`;
      expect(judgeOne({ label: 'fixture/result-description', kind: 'prose', text: clean }).ok).toBe(true);
      expect(censusHandTypedBoundSites({ files: ['fixture'], read: () => clean }).sites).toEqual([]);
      for (const prescription of [
        `Pass ${description}`,
        'Use `min_agents: 0` for rubric vetting.',
        '`min_agents: 1` returns "no one knows more than you do — proceed".',
        '`max_agents: 0` returns "no one knows more than you do — proceed".',
      ]) {
        const text = `${cleanProse}\n\n${prescription}`;
        expect(judgeOne({ label: 'fixture/prescription', kind: 'prose', text }).ok).toBe(false);
        expect(censusHandTypedBoundSites({ files: ['fixture'], read: () => text }).sites.length).toBeGreaterThan(0);
      }
    });

    it('catches the pre-P-006 CLAUDE.md line verbatim', () => {
      const verdict = judgeOne({
        label: 'fixture/CLAUDE.md',
        kind: 'prose',
        text:
          '4. **Vet its current revision** — `consult:get_feedback` (min 1 / max 3), improve the rubric, ' +
          'then attest with `scorecards:emit` against `meta-acceptance-rubric`.',
      });
      expect(verdict.ok).toBe(false);
      expect(formatViolations(verdict.violations)).toMatch(/hand-typed min\/max responder bound/);
    });

    it("catches the runbook's `max_agents:3` instruction verbatim", () => {
      const verdict = judgeOne({
        label: 'fixture/runbook.mdx',
        kind: 'prose',
        text:
          "2. **Open the critique consult** — `get_feedback` with the rubric's criteria; pass " +
          '`max_agents:3` (the minimum defaults to 1 — D-003 guarantees at least one reviewer). ' +
          "policy:'rubric-vetting'",
      });
      expect(verdict.ok).toBe(false);
      expect(formatViolations(verdict.violations)).toMatch(/hand-typed responder count/);
    });

    it("catches the runbook frontmatter's compact `min:1/max:3` form", () => {
      const verdict = judgeOne({
        label: 'fixture/frontmatter',
        kind: 'prose',
        text: "description: 'vets against meta-acceptance-rubric (get_feedback min:1/max:3 critique consult)' rubric-vetting",
      });
      expect(verdict.ok).toBe(false);
      expect(formatViolations(verdict.violations)).toMatch(/hand-typed min\/max responder bound/);
    });

    it('catches both refusal messages spelling the bound in prose', () => {
      const shipGate = judgeOne({
        label: 'fixture/plan-acceptance-gate.ts',
        kind: 'source',
        text:
          '// vetting: a get_feedback consult\n' +
          '`critique of the rubric (selection is automatic, min 1 / max 3 responders), (2) improve`',
      });
      expect(shipGate.ok).toBe(false);

      const goalGate = judgeOne({
        label: 'fixture/wind-down-disposition.ts',
        kind: 'source',
        text:
          '// vetting: a get_feedback consult\n' +
          '`of the rubric (min 1 / max 3 responders — selection is automatic), (2) improve it`',
      });
      expect(goalGate.ok).toBe(false);
      expect(formatViolations(goalGate.violations)).toMatch(/hand-typed min\/max responder bound/);
    });

    it('catches a bound spelled without a slash ("max 2 responders")', () => {
      const verdict = judgeOne({
        label: 'fixture/prose',
        kind: 'prose',
        text: `${cleanProse}\nSelection is automatic, max 2 responders.`,
      });
      expect(verdict.ok).toBe(false);
      expect(formatViolations(verdict.violations)).toMatch(/spells a responder bound in prose/);
    });

    it('catches prose that describes the vetting consult but drops the policy key', () => {
      const verdict = judgeOne({
        label: 'fixture/prose',
        kind: 'prose',
        text: '4. **Vet its current revision** — open a `get_feedback` critique consult for vetting, then attest.',
      });
      expect(verdict.ok).toBe(false);
      expect(formatViolations(verdict.violations)).toMatch(
        new RegExp(`without naming the '${REQUIRED_POLICY_KEY}' policy key`),
      );
    });

    it('catches a refusal message that stopped calling the shared renderer', () => {
      const verdict = judgeOne({
        label: 'fixture/source',
        kind: 'source',
        text: '// vetting\nconst message = `critique of the rubric via get_feedback, (2) improve it`;',
      });
      expect(verdict.ok).toBe(false);
      expect(formatViolations(verdict.violations)).toMatch(new RegExp(`does not call ${REQUIRED_RENDERER}`));
    });

    it('refuses a subject that no longer describes the vetting flow at all', () => {
      const verdict = judgeOne({ label: 'fixture/prose', kind: 'prose', text: 'Unrelated documentation body.' });
      expect(verdict.ok).toBe(false);
      expect(formatViolations(verdict.violations)).toMatch(/no longer describes the rubric-vetting consult/);
    });

    it('refuses an empty subject and an empty subject list rather than passing vacuously', () => {
      expect(judgeOne({ label: 'fixture/prose', kind: 'prose', text: '   ' }).ok).toBe(false);
      const none = judgeSelectionPolicyProse([]);
      expect(none.ok).toBe(false);
      expect(none.measured).toBe(0);
    });

    it('CALIBRATION — the clean fixtures pass, so the controls above indict the defect, not the rule', () => {
      const verdict = judgeSelectionPolicyProse([
        { label: 'fixture/clean-prose', kind: 'prose', text: cleanProse },
        { label: 'fixture/clean-source', kind: 'source', text: cleanSource },
      ]);
      expect(formatViolations(verdict.violations)).toBe('');
      expect(verdict.ok).toBe(true);
      expect(verdict.measured).toBe(2);
    });
  });

  describe('the live subjects', () => {
    const subjects = (): ProseSubject[] => [
      { label: SUBJECT_LABEL, kind: 'prose', text: readCorpus() },
      { label: RUNBOOK_RELPATH, kind: 'prose', text: read(RUNBOOK_RELPATH) },
      { label: SHIP_GATE_RELPATH, kind: 'source', text: read(SHIP_GATE_RELPATH) },
      { label: GOAL_GATE_RELPATH, kind: 'source', text: read(GOAL_GATE_RELPATH) },
      { label: FLAGS_RELPATH, kind: 'prose', text: read(FLAGS_RELPATH) },
    ];

    it('every guarded surface is non-empty and still carries the claim (non-vacuity floor)', () => {
      for (const subject of subjects()) {
        expect(subject.text.length, `${subject.label} is empty — the guard would measure nothing`).toBeGreaterThan(500);
      }
      const corpus = readCorpus();
      expect(corpus).toContain('Every plan ships with a graded acceptance rubric');
      expect(corpus).toContain('Vet its current revision');
    });

    it('no surface spells the responder bound by hand; prose names the key, messages call the renderer', () => {
      const verdict = judgeSelectionPolicyProse(subjects());
      expect(formatViolations(verdict.violations)).toBe('');
      expect(verdict.ok).toBe(true);
      expect(verdict.measured).toBe(5);
    });
  });

  /**
   * The DERIVED census (EI-21929043331389136 / WI-1409611).
   *
   * The five pinned subjects above are the SOURCE surfaces. That list passed
   * for ten days while `apps/operator/public/internal/docs/agent-insights/
   * acceptance-rubric-vetting.md` — the twin agents actually read at
   * /internal/docs — still instructed them to `pass max_agents:3`, because
   * P-006 fixed the `.mdx` and nobody rebuilt the mirror. Five greens, one live
   * regression, no contradiction: a pinned guard cannot report a subject it was
   * never given.
   *
   * `check-docs-mirror.mjs` did not catch it either — it is a path-based
   * COMPLETENESS check ("does every source page have a twin"), deliberately
   * pure so it never reads the mirror's content. Existence was never the
   * failure mode.
   *
   * So this asks the repo for its own population instead. The served mirror is
   * IN scope here on purpose: build output that agents read is a real subject.
   */
  describe('the derived census — every tracked file, not a pinned list', () => {
    const EXCLUDED = new Map<string, string>([
      [
        'packages/operator-core/lib/consult/selection-policies.ts',
        'the registry\'s own decision changelog at the definition site — pinning it would make recording a bound CHANGE impossible',
      ],
      [
        'packages/operator-core/lib/doc-claims/selection-policy-prose.ts',
        'this guard\'s own pattern catalogue: it must contain the literal strings it detects',
      ],
    ]);

    const census = () =>
      censusHandTypedBoundSites({
        files: trackedTextFiles({ root: ROOT }),
        read: (relpath) => readTrackedText(ROOT, relpath),
      });

    it('scans a real, non-empty population (the vacuity floor a derived guard needs most)', () => {
      expect(census().scanned).toBeGreaterThan(1000);
    });

    it('FIXTURE CONTROL — the census reports the exact regression that escaped the pinned list', () => {
      // Verbatim shape of the stale served twin, which no pinned subject covered.
      const result = censusHandTypedBoundSites({
        files: ['fixture/served-mirror/acceptance-rubric-vetting.md'],
        read: () =>
          '2. **Open the critique consult** — `get_feedback` with the rubric-vetting flow; pass `max_agents:3`.',
      });
      expect(result.sites.map((s) => s.path)).toEqual(['fixture/served-mirror/acceptance-rubric-vetting.md']);
      expect(formatBoundSites(result.sites)).toMatch(/instructs a hand-typed responder count/);
    });

    it('FIXTURE CONTROL — an off-topic file carrying the same bound is NOT an offender', () => {
      const result = censusHandTypedBoundSites({
        files: ['fixture/unrelated.ts'],
        read: () => '// batch sizing is min 1 / max 3 per sweep',
      });
      expect(result.sites).toEqual([]);
      expect(result.scanned).toBe(1);
    });

    it('the served docs mirror is INSIDE the scanned population, not filtered out', () => {
      const files = trackedTextFiles({ root: ROOT });
      // The Markdown twin — the representation this census actually reads.
      expect(files).toContain('apps/operator/public/internal/docs/agent-insights/acceptance-rubric-vetting.md');
      // Its HTML sibling is deliberately OUT: both are emitted from one source in
      // one build, so the twin covers the drift, at a fraction of the bytes. This
      // pins that as a choice rather than an accident of the extension list.
      expect(files).not.toContain('apps/operator/public/internal/docs/agent-insights/acceptance-rubric-vetting.html');
    });

    it('no tracked file spells the responder bound by hand, except the reasoned exclusions', () => {
      const unexcused = census().sites.filter((s) => !EXCLUDED.has(s.path));
      expect(formatBoundSites(unexcused)).toBe('');
    });

    it('every exclusion is still a real offender — a stale excuse is deleted, not carried', () => {
      const found = new Set(census().sites.map((s) => s.path));
      for (const [path, reason] of EXCLUDED) {
        expect(
          found.has(path),
          `${path} no longer carries a hand-typed bound — drop this exclusion (${reason})`,
        ).toBe(true);
      }
    });
  });
});
