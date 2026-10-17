/**
 * P-017 — the D-001 routing contract, pinned to the live guidance surfaces.
 *
 * Sibling of `gate-candidate-ref.test.ts` / `retired-surfaces.test.ts`, and it
 * follows their discipline for the same reason: once the live assertion goes
 * green it stops being evidence that the detector works at all. Every fixture
 * below reproduces a shape that MUST be caught — including the two routes that
 * were genuinely live in shipped guidance when P-017 opened.
 *
 * The false-positive controls matter as much as the catches here. A banned tool
 * name appears in CORRECT guidance (the "not" column, the ⚠ warning), so a
 * presence-based detector would flag the fix and reward deleting the warning.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  judgeCodeIntelRouting,
  formatRoutingViolations,
  BANNED_ROUTES,
} from './code-intel-routing-authority';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * The DENSE authority surfaces — every one carries routing tables, so a verdict
 * that inspected almost nothing is a parser regression rather than a clean file.
 * These get the non-vacuity floor below.
 */
const GUIDANCE_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  // Deferred parts remain retrievable guidance even when no client projects them.
  'packages/operator-core/lib/doc-projection/claude-md-corpus.generated.md',
  'apps/operator/prompts/papercusp-su-engineer.tools.md',
  'apps/operator/prompts/papercusp-su-power.tools.md',
] as const;

const CALLER_ROUTING_DOCS = [
  'CLAUDE.md',
  'AGENTS.md',
  'packages/operator-core/lib/doc-projection/claude-md-corpus.generated.md',
] as const;

const PROMPTS_DIR = 'apps/operator/prompts';

/**
 * EVERY role prompt, enumerated rather than hand-listed (P-019).
 *
 * The hand-list above was the whole coverage until P-019, and the gap it left
 * was not hypothetical: `debugger.tools.md` and `scoper.tools.md` both routed
 * call-site questions to `gitnexus.query` — the exact D-021 route P-017
 * removed from CLAUDE.md — and survived P-017 untouched purely because no
 * assertion ever opened them. A hand-list cannot cover a file that does not
 * exist yet, so a NEW role prompt would inherit the same free pass.
 *
 * These are judged for violations only, with NO per-file position floor: most
 * role prompts carry one or two routing positions, and imposing the dense-file
 * floor here would fail them for being short rather than for being wrong. The
 * non-vacuity guarantee moves to the SET (below) — if the enumeration breaks,
 * it reports zero files instead of silently judging nothing.
 */
function roleToolPrompts(): string[] {
  return readdirSync(join(ROOT, PROMPTS_DIR))
    .filter((f) => f.endsWith('.tools.md'))
    .map((f) => `${PROMPTS_DIR}/${f}`)
    .sort();
}

describe('D-001 code-intelligence routing authority', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches the exact CLAUDE.md row P-017 removed — gitnexus.query as the code-graph authority', () => {
      const verdict = judgeCodeIntelRouting(
        [
          '| you want | use | not |',
          '|---|---|---|',
          '| code graph / call sites | `gitnexus.query` (dot, not colon) | a hand-walk of the tree |',
        ].join('\n'),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations).toHaveLength(1);
      expect(verdict.violations[0]!.tool).toBe('gitnexus.query');
      expect(verdict.violations[0]!.position).toBe('authority-cell');
      expect(verdict.violations[0]!.reason).toMatch(/unavailable/i);
    });

    it('catches the exact su-playbook bullet P-017 removed — raw repomix.pack advertised as high-value', () => {
      const verdict = judgeCodeIntelRouting(
        '- **`repomix.pack`** — pack a repo (subset) into one LLM-friendly document.',
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations).toHaveLength(1);
      expect(verdict.violations[0]!.tool).toBe('repomix.pack');
      expect(verdict.violations[0]!.position).toBe('recommendation-bullet');
      expect(verdict.violations[0]!.instead).toBe('code:pack');
    });

    it('catches a banned route in a TWO-column authority table (the su playbook shape)', () => {
      const verdict = judgeCodeIntelRouting(
        ['| the question | the authority |', '|---|---|', '| call chains | `gitnexus.query` |'].join(
          '\n',
        ),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations[0]!.position).toBe('authority-cell');
    });

    it('catches a banned route in a row whose EARLIER cell contains an escaped pipe', () => {
      // Regression pin: splitting on a bare /\|/ shifts cells left, so the judge
      // would inspect the "not" column and vacuously pass. This row is the shape
      // that breaks a naive splitter — the `plans:list` enum spelling.
      const verdict = judgeCodeIntelRouting(
        "| a \\| b \\| c | `gitnexus.query` | not this |",
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations[0]!.tool).toBe('gitnexus.query');
    });
  });

  describe('false-positive controls (correct guidance must NOT be flagged)', () => {
    it('does not flag a banned tool named in the "not" column — that IS the fix', () => {
      const verdict = judgeCodeIntelRouting(
        '| call chains | `graph:query` | `gitnexus.query` — unavailable; may SIGSEGV the shared MCP process (D-065) |',
      );
      expect(verdict.violations).toEqual([]);
      expect(verdict.positionsChecked).toBeGreaterThan(0);
    });

    it('does not flag a banned tool named in a ⚠ prose warning', () => {
      const verdict = judgeCodeIntelRouting(
        '⚠ Two raw backends are deliberately NOT the route. `gitnexus.query` is unavailable and fail-closed, and raw `repomix.pack` skips the pinned version.',
      );
      expect(verdict.ok).toBe(true);
    });

    it('does not flag the sanctioned authorities', () => {
      const verdict = judgeCodeIntelRouting(
        [
          '| the question | the authority |',
          '|---|---|',
          '| definition, references, type truth | `lsp:query` |',
          '| call chains, impact radius | `graph:query` |',
          '| a syntax pattern or codemod | `code:structural` |',
          '| packaging evidence for a reader | `code:pack` |',
        ].join('\n'),
      );
      expect(verdict.ok).toBe(true);
      expect(verdict.positionsChecked).toBe(4);
    });
  });

  describe('query outcome vintage (EI-26178649957036371)', () => {
    it('catches the stale absolute outcome even in the permitted not column', () => {
      const verdict = judgeCodeIntelRouting(
        '| topology | `graph:query` | `gitnexus.query` — UNRANKED NOISE, not empty (D-021) |',
      );
      expect(verdict.violations).toEqual([expect.objectContaining({
        tool: 'gitnexus.query', position: 'status-claim', line: 1,
      })]);
    });

    it('catches a multiline prose claim without misclassifying it as a recommendation', () => {
      const verdict = judgeCodeIntelRouting(
        'Do not use `gitnexus.query`; it returns\nunranked noise, not empty results.',
      );
      expect(verdict.violations).toEqual([expect.objectContaining({ position: 'status-claim' })]);
    });

    it('accepts dated history alongside the current fail-closed contract', () => {
      const verdict = judgeCodeIntelRouting(
        '| topology | `graph:query` | `gitnexus.query` fails closed before dispatch (D-065); historical builds returned unranked noise (D-021) |',
      );
      expect(verdict.ok).toBe(true);
    });

    it('does not treat a historical measurement or fenced reproduction as a current claim', () => {
      const verdict = judgeCodeIntelRouting([
        'Do not use `gitnexus.query`: historical builds returned unranked noise (D-021).',
        '', '```md', '`gitnexus.query` — UNRANKED NOISE, not empty', '```',
      ].join('\n'));
      expect(verdict.ok).toBe(true);
    });
  });

  describe('prose recommendations (P-019 — the position a shape-only detector could not see)', () => {
    // The two shapes above judge a table cell and a bolded bullet. Both returned
    // positionsChecked:0 on the guidance that was genuinely stale, so their green
    // was vacuous rather than clean. These fixtures are the real defect, verbatim.
    const ORIGINAL_DEBUGGER_LINE =
      '- Then code: when the gitnexus-bridge plugin is installed, its code-graph tools (`gitnexus.query`, `gitnexus.impact`) are the fastest way to find call sites + downstream impact.';
    const ORIGINAL_SCOPER_LINE =
      '- The gitnexus-bridge plugin (when installed) exposes code-graph queries (`gitnexus.query`, `gitnexus.context`); call `agent_tools:list` to see what is loaded in the current workspace.';

    it('catches the exact debugger.tools.md sentence that survived P-017', () => {
      const verdict = judgeCodeIntelRouting(ORIGINAL_DEBUGGER_LINE);
      expect(verdict.ok).toBe(false);
      expect(verdict.violations[0]!.tool).toBe('gitnexus.query');
      expect(verdict.violations[0]!.position).toBe('prose-recommendation');
    });

    it('catches the exact scoper.tools.md sentence that survived P-017', () => {
      const verdict = judgeCodeIntelRouting(ORIGINAL_SCOPER_LINE);
      expect(verdict.ok).toBe(false);
      expect(verdict.violations[0]!.position).toBe('prose-recommendation');
    });

    // ── The controls that must grade the OTHER way. A presence-based rule would
    // pass the two catches above and then flag every correct warning, which
    // rewards deleting the warning. These pin that it does not.
    it('does NOT flag a multi-line warning whose negation is lines above the tool name', () => {
      // Reproduces the su-playbook block shape exactly: the ban is stated first,
      // and `repomix.pack` is named six lines later in the SAME paragraph. A
      // line-scoped rule flags that continuation line; a paragraph-scoped one
      // must not. This was measured against the live playbooks, not assumed.
      const verdict = judgeCodeIntelRouting(
        [
          '⚠ **Two raw backends are deliberately NOT the route.** `gitnexus.query`',
          'is unavailable — historical builds returned empty or unranked noise and',
          'current probes SIGSEGV the shared MCP process (D-065). Raw `repomix.pack` skips',
          'the pinned version and the secret-scanning rails `code:pack` enforces.',
        ].join('\n'),
      );
      expect(
        verdict.ok,
        verdict.ok ? '' : `\n${formatRoutingViolations('<warning fixture>', verdict.violations)}\n`,
      ).toBe(true);
      expect(verdict.positionsChecked).toBeGreaterThan(0);
    });

    it('does NOT flag a banned name inside a fenced code block', () => {
      const verdict = judgeCodeIntelRouting(
        ['```bash', 'gitnexus.query --symbol foo', '```'].join('\n'),
      );
      expect(verdict.ok).toBe(true);
    });
  });

  describe('a sanctioned tool routed for the wrong question (gitnexus-deterministic-integration R-2)', () => {
    // The live sentence this rule was written for, verbatim. It passed the ban rule
    // because `gitnexus.context` is sanctioned AND because the paragraph's later
    // "NOT `gitnexus.query`" excused it — so the rule is sentence-scoped.
    const PRE_R2_DEBUGGER_LINE =
      '- Then code: when the gitnexus-bridge plugin is installed, `gitnexus.context` (definition + callers/callees) and `gitnexus.impact` (downstream radius) are the fastest way to find call sites + impact. NOT `gitnexus.query` — historical builds returned empty or unranked noise and current probes SIGSEGV the shared MCP process, so the bridge fails it closed before dispatch (D-065).';

    it('catches the exact debugger.tools.md sentence that pitched gitnexus.context for definitions', () => {
      const verdict = judgeCodeIntelRouting(PRE_R2_DEBUGGER_LINE);
      expect(verdict.ok).toBe(false);
      expect(verdict.violations).toContainEqual(expect.objectContaining({ tool: 'gitnexus.context', position: 'prose-recommendation', instead: 'lsp:query' }));
    });

    it('catches gitnexus.context as the authority of a definition row', () => {
      const verdict = judgeCodeIntelRouting('| definition, references | `gitnexus.context` | `grep` |\n');
      expect(verdict.ok).toBe(false);
      expect(verdict.violations[0]!).toMatchObject({ tool: 'gitnexus.context', position: 'authority-cell' });
    });

    it('catches the deferred corpus definition recommendation across a hard wrap', () => {
      const verdict = judgeCodeIntelRouting([
        'For "where is this symbol defined" use',
        '`gitnexus.context { name }` (no path argument to get wrong); for "does this TOOL',
        'exist", `tools:find`.',
      ].join('\n'));
      expect(verdict.violations).toContainEqual(expect.objectContaining({
        tool: 'gitnexus.context', instead: 'lsp:query', position: 'prose-recommendation',
      }));
    });

    it('preserves a fenced historical recommendation with its current replacement', () => {
      const verdict = judgeCodeIntelRouting([
        'Current definition lookups use `lsp:query`; the historical recommendation below is superseded.',
        '', '```md',
        'For "where is this symbol defined" use `gitnexus.context { name }`.',
        '```',
      ].join('\n'));
      expect(verdict.ok, formatRoutingViolations('historical corpus fixture', verdict.violations)).toBe(true);
    });

    it('preserves optional internal comparisons while routing default topology to the native surface', () => {
      const source = [
        '| call chains, impact radius, topology | `graph:query` | `gitnexus.query` |',
        '',
        'Optional internal `gitnexus.context` / `gitnexus.impact` comparisons retain index freshness and D-005 authority.',
      ].join('\n');
      const verdict = judgeCodeIntelRouting(source);
      expect(verdict.ok, formatRoutingViolations('fixture', verdict.violations)).toBe(true);
      expect(verdict.positionsChecked).toBeGreaterThan(1);
    });

    it('does NOT flag a sentence that negates the pairing', () => {
      const verdict = judgeCodeIntelRouting('`gitnexus.context` is not the route for a definition lookup; use `lsp:query`.');
      expect(verdict.ok, formatRoutingViolations('fixture', verdict.violations)).toBe(true);
    });

    it('catches the former debugger topology default even when its definition route is correct', () => {
      const verdict = judgeCodeIntelRouting(
        '- Then code: find where a symbol is defined with `lsp:query` (compiler semantics). When the gitnexus-bridge plugin is installed, `gitnexus.context` (callers/callees of a known symbol) and `gitnexus.impact` (downstream radius) are the fastest way to find call sites + impact.',
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations).toContainEqual(expect.objectContaining({
        tool: 'gitnexus.context', instead: 'graph:query (bounded first-party topology)',
      }));
      expect(verdict.positionsChecked).toBeGreaterThan(0);
    });

    it('catches the former topology table and an unqualified scoper recommendation', () => {
      for (const source of [
        '| call chains, impact radius, subsystem/route topology | `gitnexus.context` / `gitnexus.impact` |',
        '- The gitnexus-bridge plugin exposes code-graph queries (`gitnexus.context`, `gitnexus.impact`).',
      ]) {
        const verdict = judgeCodeIntelRouting(source);
        expect(verdict.ok).toBe(false);
        expect(verdict.violations.map(v => v.tool)).toEqual(['gitnexus.context', 'gitnexus.impact']);
      }
    });

    it('does not let a later optional sentence excuse a default topology recommendation', () => {
      const verdict = judgeCodeIntelRouting('Use `gitnexus.context` for call sites. Optional internal comparisons remain authorized.');
      expect(verdict.violations).toContainEqual(expect.objectContaining({ tool: 'gitnexus.context' }));
    });

    it('preserves the wrong-direction warning and its native replacement', () => {
      const verdict = judgeCodeIntelRouting('Failure modes include `gitnexus.impact` silently answering CALLEES on an out-of-enum direction — ask `graph:query` for callers.');
      expect(verdict.ok, formatRoutingViolations('fixture', verdict.violations)).toBe(true);
    });
  });

  describe('API-impact defaults (EI-26184007961589078)', () => {
    const ORIGINAL_ARCHITECT_STEP =
      '3. When the gitnexus-bridge plugin is installed, `gitnexus.api_impact` shows the API-surface blast radius of the proposed change.';

    it('catches the exact architect workflow step, including a hard wrap', () => {
      for (const source of [ORIGINAL_ARCHITECT_STEP, ORIGINAL_ARCHITECT_STEP.replace('shows the ', 'shows the\n')]) {
        const verdict = judgeCodeIntelRouting(source);
        expect(verdict.violations).toEqual([expect.objectContaining({
          tool: 'gitnexus.api_impact', position: 'prose-recommendation',
          instead: 'graph:query (bounded first-party topology)',
        })]);
        expect(verdict.positionsChecked).toBeGreaterThan(0);
      }
    });

    it('catches API-surface and blast-radius authority cells without relying on the tool name', () => {
      for (const question of ['API surface', 'blast-radius']) {
        const verdict = judgeCodeIntelRouting(`| ${question} | \`gitnexus.api_impact\` |`);
        expect(verdict.violations).toEqual([expect.objectContaining({
          tool: 'gitnexus.api_impact', position: 'authority-cell',
        })]);
      }
    });

    it('permits explicitly optional internal comparisons in prose and authority cells', () => {
      for (const source of [
        'Use `graph:query` for bounded first-party topology; `gitnexus.api_impact` is an optional internal comparison of API-surface blast radius.',
        '| API surface | `graph:query`; optional internal `gitnexus.api_impact` comparison |',
      ]) {
        const verdict = judgeCodeIntelRouting(source);
        expect(verdict.ok, formatRoutingViolations('optional API comparison', verdict.violations)).toBe(true);
        expect(verdict.positionsChecked).toBeGreaterThan(0);
      }
    });

    it('preserves a negative warning and fenced historical evidence', () => {
      const verdict = judgeCodeIntelRouting([
        'Do not use `gitnexus.api_impact` as the default API-surface route; use `graph:query` for bounded topology.',
        '', '```md', ORIGINAL_ARCHITECT_STEP, '```',
      ].join('\n'));
      expect(verdict.ok, formatRoutingViolations('historical API recommendation', verdict.violations)).toBe(true);
      expect(verdict.positionsChecked).toBeGreaterThan(0);
    });

    it('does not let a later optional sentence excuse a default API recommendation', () => {
      const verdict = judgeCodeIntelRouting(`${ORIGINAL_ARCHITECT_STEP} Optional internal comparisons remain available.`);
      expect(verdict.violations).toEqual([expect.objectContaining({ tool: 'gitnexus.api_impact' })]);
    });
  });

  describe('the live guidance surfaces', () => {
    for (const rel of GUIDANCE_FILES) {
      it(`${rel} routes no question class to a raw backend`, () => {
        const source = readFileSync(join(ROOT, rel), 'utf8');
        const verdict = judgeCodeIntelRouting(source);

        // A zero-inspection verdict is vacuous, not clean: if the parser stopped
        // matching (a table reformatted, a bullet style changed) this file would
        // report ok:true forever while nothing was actually judged.
        expect(
          verdict.positionsChecked,
          `${rel}: judged ZERO recommendation positions — the detector is not reading this file, so its green is vacuous`,
        ).toBeGreaterThan(5);

        expect(
          verdict.ok,
          verdict.ok ? '' : `\n${formatRoutingViolations(rel, verdict.violations)}\n`,
        ).toBe(true);
      });
    }

    for (const rel of CALLER_ROUTING_DOCS) {
      it(`${rel} keeps the measured callers caveat in the authority cell`, () => {
        const source = readFileSync(join(ROOT, rel), 'utf8');
        const rows = source
          .split('\n')
          .filter((line) => line.startsWith('| who CALLS this symbol |'));
        expect(rows, `${rel} should have exactly one callers row`).toHaveLength(1);

        const cells = rows[0]!.split('|').slice(1, -1).map((cell) => cell.trim());
        expect(cells).toHaveLength(3);
        expect(cells[0]).toBe('who CALLS this symbol');
        expect(cells[1]).toMatch(/graph:query.*op:'callers'/);
        expect(cells[1]).toMatch(/empty is not proof of no callers/i);
        expect(cells[1]).toMatch(/measured needs-widening/i);
        expect(cells[1]).toMatch(/held at observe/i);
        expect(cells[1]).toContain('WI-10006543');
      });
    }

    it('the role-prompt enumeration finds a realistic file set, not zero', () => {
      // This is the non-vacuity floor for the enumerated tier. Without it a
      // renamed prompts dir or a changed suffix would yield an EMPTY list, and
      // a for-loop over nothing registers no tests at all — which reads as a
      // green suite rather than as absent coverage.
      const prompts = roleToolPrompts();
      expect(
        prompts.length,
        `${PROMPTS_DIR}: enumerated ${prompts.length} *.tools.md files — the glob is broken, so every role prompt is UNJUDGED`,
      ).toBeGreaterThan(10);
      // The two files P-019 found stale must be in the judged set by name: they
      // are the concrete regression this tier exists to prevent.
      expect(prompts).toContain(`${PROMPTS_DIR}/debugger.tools.md`);
      expect(prompts).toContain(`${PROMPTS_DIR}/scoper.tools.md`);
    });

    for (const rel of roleToolPrompts()) {
      it(`${rel} routes no question class to a raw backend`, () => {
        const verdict = judgeCodeIntelRouting(readFileSync(join(ROOT, rel), 'utf8'));
        expect(
          verdict.ok,
          verdict.ok ? '' : `\n${formatRoutingViolations(rel, verdict.violations)}\n`,
        ).toBe(true);
      });
    }

    it('every banned route names a concrete replacement and a measured reason', () => {
      expect(BANNED_ROUTES.length).toBeGreaterThan(0);
      for (const banned of BANNED_ROUTES) {
        expect(banned.instead, `${banned.tool} must name what to use instead`).toBeTruthy();
        expect(banned.instead).not.toBe(banned.tool);
        // The reason must cite the decision that measured it, so a future reader
        // can re-check the evidence rather than trusting the prohibition.
        expect(banned.reason, `${banned.tool} must cite the measuring decision`).toMatch(
          /D-\d{3}/,
        );
      }
    });
  });
});
