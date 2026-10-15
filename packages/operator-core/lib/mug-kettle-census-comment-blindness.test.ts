/**
 * The mug/kettle surface census must not report findings that live in COMMENTS.
 *
 * WI-37661 (2026-08-10). `scripts/mug-kettle-surface-census.mjs` text-matches tokens, and
 * before this guard it scanned RAW source. D7's `D7_TAB_RE` matches a QUOTED role token —
 * and its backtick alternative, there to catch template literals, also matches ordinary
 * markdown code-quoting in prose. So a JSX comment in `OperatorChatSidebar.tsx` explaining
 * why the kettle glyph was removed (it names the cast glyph for `kettle`/`overwatch`) was
 * reported as a NEW UNGATED entry point "mounts tier tab token(s): kettle", and red-pinned
 * the fleet gate on a comment.
 *
 * This is structural for THIS census rather than bad luck: the plan it enforces
 * (retire-mug-kettle-su-only-2026-08-09) is EXECUTED by writing comments that name the
 * retired roles. The guard was primed to fire on its own plan's documentation, so rewording
 * the one offending comment would have left the trap armed for the next one.
 *
 * Two earlier detectors had already worked AROUND comment-blindness instead of removing it
 * (the SELF_FILE exclusion, and D1_DEFINITION_SITES skipping a "header comment") — evidence
 * the class recurs and gets papered over locally each time.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsOnly } from '../../../scripts/lib/strip-comments-and-strings.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CENSUS = join(REPO_ROOT, 'scripts/mug-kettle-surface-census.mjs');
const GATE_POPULATION = 'packages/operator-core/lib/agent-tools/_mug-kettle-gate-population.ts';

type Finding = {
  category: string;
  subject: string;
  file: string;
  line: number;
  detail?: string;
  substrate?: boolean;
  why?: string;
};

/**
 * TEMPORARY MITIGATION (EI-20088302984457398), not a fix — sized, not guessed.
 *
 * `census()` shells out to a full-repo AST scan of ~7,200 files. MEASURED on this box:
 * 33s quiet (EI-20068047132832988), 49.7s and 57.8s on two runs at load ~95. Against the
 * 60s default this test is not occasionally flaky — its headroom is smaller than the box's
 * normal variance, so it reds whenever the box is busy and then reads as an unrelated flake
 * inside someone else's gate triage. That MISATTRIBUTION is the expensive part: it trains
 * readers to wave this file's reds through, which is how a real regression eventually gets
 * waved through too.
 *
 * THE DURABLE FIX IS CENSUS COST, TRACKED AS EI-20068047132832988 — the scan went 7s -> 33s
 * when the shared stripper became AST-based. Until that lands, a budget sized to ~3x the
 * worst measured run stops the false reds without disarming the guard.
 *
 * ⚠ WHY NOT THE OTHER TWO OPTIONS, both considered and rejected on evidence:
 *   - Marking this integration: `affected-tests.mjs:1156` gates integration behind
 *     `--integration` and the gate runs plain `test:affected`, so that DISARMS the guard
 *     rather than relocating it.
 *   - Bounding CONTROL to a subtree: the census has no `--roots` (SCAN_ROOTS is hardcoded),
 *     and the comment that originally red-pinned the fleet gate lived in `apps/operator`,
 *     which an operator-core-only scan would stop covering.
 *
 * Do NOT read this number as headroom to spend. If the census gets slower again, fix the
 * census — raising this further only widens the window.
 */
const CENSUS_TIMEOUT_MS = 180_000;

let cached: Finding[] | null = null;
function census(): Finding[] {
  if (!cached) {
    const raw = execFileSync('node', [CENSUS, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 1e8,
      timeout: 120_000,
      killSignal: 'SIGKILL',
    });
    cached = (JSON.parse(raw).findings ?? []) as Finding[];
  }
  return cached;
}

describe('mug/kettle census — comment blindness (WI-37661)', () => {
  /**
   * THE CALIBRATION, deliberately first: every assertion below is satisfied by a census
   * that reports NOTHING, so without this the guard would pass most loudly at the moment
   * the census went blind. That is the failure direction the fix itself risked — masking
   * comments could just as easily have masked the code.
   */
  it('CONTROL: the census still sees a substantial population of REAL entry points', { timeout: CENSUS_TIMEOUT_MS }, () => {
    const findings = census();
    expect(findings.length).toBeGreaterThan(100);

    // A code-resident door that must never stop being seen. `role === 'mug'` in
    // dbos/durable-spawn.ts is real branching code, not prose.
    const src = readFileSync(join(REPO_ROOT, 'packages/operator-core/lib/dbos/durable-spawn.ts'), 'utf8');
    expect(stripCommentsOnly(src)).toMatch(/role\s*===\s*'mug'/);
  });

  it('counts executable tooldefs, not the canonical disposition table rows', { timeout: CENSUS_TIMEOUT_MS }, () => {
    const toolFindings = census().filter((finding) => finding.category === 'tool');

    // D4's `name:` shape is shared by the pure-data disposition registry, but that file
    // lists gated/excluded/deleted verbs rather than registering runtime tools. Keep the
    // actual registration path visible so the exclusion cannot make the detector vacuous.
    expect(toolFindings.filter((finding) => finding.file === GATE_POPULATION)).toEqual([]);
    expect(toolFindings).toContainEqual(
      expect.objectContaining({
        subject: 'pot:start',
        file: 'packages/operator-core/lib/agent-tools/pot/start.ts',
      }),
    );
  });

  /**
   * The guard proper. A finding whose line is entirely blank once comments are masked was
   * matched in a comment — the token is not code.
   *
   * Scoped to `line > 1` because several detectors record a finding with index 0 (a
   * whole-FILE classification: "component file named for the retiring tier"), which
   * resolves to line 1 and is not a token position at all. Line 1 is very often `/**`,
   * so including those would fail on correct behaviour.
   */
  it('reports no finding whose token lives in a comment', { timeout: CENSUS_TIMEOUT_MS }, () => {
    const offenders = census()
      .filter((f) => f.line > 1)
      .filter((f) => {
        const abs = join(REPO_ROOT, f.file);
        if (!existsSync(abs)) return false;
        const masked = stripCommentsOnly(readFileSync(abs, 'utf8')).split('\n');
        const line = masked[f.line - 1];
        return line !== undefined && line.trim() === '';
      })
      .map((f) => `${f.file}:${f.line}  [${f.category}/${f.subject}] ${f.detail ?? ''}`);

    expect(
      offenders,
      'These census findings point at a line that is empty once comments are masked, i.e. the ' +
        'token was matched in a COMMENT. Scan `code(abs)` (comment-masked), not `read(abs)`. ' +
        'Use stripCommentsOnly — NOT stripCommentsAndStrings: these detectors read quoted ' +
        "VALUES ('kettle', role: 'cup'), so stripping string contents would blind the census.",
    ).toEqual([]);
  });

  it('classifies live per-pot learning controls as non-tier UI substrate', { timeout: CENSUS_TIMEOUT_MS }, () => {
    const expected = new Map([
      ['LearningPotDrawer', 'apps/operator-vite/src/components/adv/LearningPotDrawer.tsx'],
      ['LearningPotPicker', 'apps/operator-vite/src/components/adv/LearningPotPicker.tsx'],
      // LearningPotRail was the third until 2026-09-07, when its chips were
      // folded into the start/pause dropdown and the component was deleted.
      // Its successor, LearningLoopControl, is deliberately NOT listed: this
      // census raises a 'ui' finding off a basename that NAMES THE TIER, and
      // that name does not — it writes learning:set-pot-scope without ever
      // being flagged, so it needs no substrate exemption.
    ]);
    const findings = census().filter(
      (finding) => finding.category === 'ui' && expected.has(finding.subject),
    );

    expect(findings).toHaveLength(expected.size);
    for (const finding of findings) {
      expect(finding.file).toBe(expected.get(finding.subject));
      expect(finding.substrate).toBe(true);
      expect(finding.why).toMatch(/learning:set-pot-scope/);
      expect(finding.why).toMatch(/no retired-tier route/i);
    }
  });

  /**
   * The mechanism, proven both ways on a fixture — so a future reader can see that the
   * masking distinguishes prose from code rather than merely deleting things.
   */
  it('CONTROL: masking removes a comment-resident token and keeps a code-resident one', () => {
    const fixture = [
      "const tab = 'kettle';                       // real code, must survive",
      '/* prose naming the cast glyph for `kettle`/`overwatch` — must NOT survive */',
      "// another mention of 'kettle' in a line comment — must NOT survive",
    ].join('\n');

    const masked = stripCommentsOnly(fixture).split('\n');

    expect(masked[0]).toContain("'kettle'"); // code-resident token survives
    expect(masked[1].trim()).toBe(''); // block comment fully masked
    expect(masked[2].trim()).toBe(''); // line comment fully masked
    expect(masked).toHaveLength(3); // line-preserving: offsets/line numbers stay true
  });
});
