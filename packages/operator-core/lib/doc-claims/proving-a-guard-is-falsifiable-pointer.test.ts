/**
 * Pins the projected agent guide's "Proving a guard is falsifiable" section to a SHORT
 * pointer, and the agent-insights doc it points at to the full guidance it replaced
 * (plan mutation-probe-evidence-value-2026-10-11, P-005 / BAR R-5).
 *
 * The section used to carry the whole tier table, both invocation forms, the exit codes
 * and the sweep-lock recipe inline (~9,000 characters) in a guide every agent loads. The
 * guidance now lives in `agent-insights/proving-a-guard-is-falsifiable` (authored with
 * docs:author); the guide keeps a pointer of at most 1,200 characters, measured from the
 * section heading to the next heading. Every probe flag the doc names is checked against
 * the script itself, so a renamed flag fails here until the doc moves with it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const REPO = new URL('../../../../', import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, REPO), 'utf8');

// Overridable so scripts/mutation-probe.sh can point this test at a mutated COPY of the
// guide or the doc (copy-out mode) instead of mutating the shared tree. An absolute path
// resolves as-is.
const GUIDE = read(process.env.FALSIFIABLE_POINTER_GUIDE_PATH ?? 'CLAUDE.md');
const DOC = read(
  process.env.FALSIFIABLE_POINTER_DOC_PATH ??
    'apps/operator-docs/src/content/docs/agent-insights/proving-a-guard-is-falsifiable.mdx',
);
const PROBE = read('scripts/mutation-probe.sh');

const HEADING = '## Proving a guard is falsifiable';
const DOC_LINK = '/internal/docs/agent-insights/proving-a-guard-is-falsifiable';
const POINTER_BUDGET_CHARS = 1_200;

/** The section from its heading line up to (not including) the next heading of any level. */
function guideSection(guide: string, heading: string): string | null {
  const at = guide.startsWith(heading) ? 0 : guide.indexOf(`\n${heading}`) + 1;
  if (at <= 0 && !guide.startsWith(heading)) return null;
  const rest = guide.slice(at + heading.length);
  const next = rest.search(/\n#{1,6} /);
  return guide.slice(at, next >= 0 ? at + heading.length + next : undefined);
}

/** Characters as a reader counts them (code points, not UTF-16 units). */
const chars = (text: string): number => Array.from(text).length;

const PROBE_FLAGS = [
  '--fake-destructive',
  '--i-know-this-deletes',
  '--sandbox-root',
  '--against-commit',
  '--must-be-absent',
  '--against-last-without',
  '--positive-control',
  '--calibration',
  '--sweep-lock-held',
  '--accept-sweep-race',
  '--mutate',
  '--test',
  '--file',
];

describe('section measurement (CONTROL)', () => {
  it('measures heading-to-next-heading and fails an over-budget section', () => {
    const long = `intro\n${HEADING} — x\n\n${'y'.repeat(1_300)}\n\n## Next section\nbody`;
    const section = guideSection(long, HEADING);
    expect(section).not.toBeNull();
    expect(section!.startsWith(HEADING)).toBe(true);
    expect(section).not.toContain('## Next section');
    expect(chars(section!)).toBeGreaterThan(POINTER_BUDGET_CHARS);
    expect(guideSection('no such heading here', HEADING)).toBeNull();
  });
});

describe('agent guide: "Proving a guard is falsifiable" is a pointer (R-5)', () => {
  const section = guideSection(GUIDE, HEADING);

  it('exists in the projected guide', () => {
    expect(section, `missing section: ${HEADING}`).not.toBeNull();
  });

  it(`is at most ${POINTER_BUDGET_CHARS} characters, heading to next heading`, () => {
    expect(chars(section ?? '')).toBeLessThanOrEqual(POINTER_BUDGET_CHARS);
  });

  it('points at the agent-insights doc that holds the guidance', () => {
    expect(section).toContain(DOC_LINK);
  });

  it('no longer carries the moved guidance inline', () => {
    expect(section).not.toContain('| your subject | how to prove falsifiability |');
    expect(section).not.toContain('locks:acquire');
    expect(section).not.toMatch(/`3` in-tree restore FAILED/);
  });
});

describe('agent-insights doc holds the full guidance (R-5)', () => {
  it('carries the tier table with every tier', () => {
    expect(DOC).toContain('| your subject | how to prove falsifiability |');
    for (const tier of [
      'TIER-0: `--fake-destructive`',
      'a MODULE / logic you `import`',
      'the SOURCE TREE itself',
      'a FILE artifact the test reads by path',
      'HISTORICAL MODE',
      'genuinely unavoidable in-tree mutation',
    ]) {
      expect(DOC, `tier row: ${tier}`).toContain(tier);
    }
  });

  it('carries all four exit codes', () => {
    const exitCodes = DOC.slice(DOC.indexOf('## Exit codes'));
    expect(exitCodes).toContain('`0` mutant/historical source CAUGHT');
    expect(exitCodes).toContain('`1` mutant/historical source SURVIVED');
    expect(exitCodes).toContain('`2` misuse');
    expect(exitCodes).toContain('`3` in-tree restore FAILED');
  });

  it('carries both invocation forms, and every flag it names exists in the probe script', () => {
    expect(DOC).toContain('### Invocation forms');
    expect(DOC).toMatch(/scripts\/mutation-probe\.sh \\\n\s+--file [^\n]+\n\s+--fake-destructive/);
    expect(DOC).toMatch(/scripts\/mutation-probe\.sh \\\n\s+--file [^\n]+\n\s+--against-last-without/);
    for (const flag of PROBE_FLAGS) {
      expect(DOC, `doc names ${flag}`).toContain(flag);
      expect(PROBE, `probe script implements ${flag}`).toContain(flag);
    }
  });

  it('carries the sweep-lock recipe the probe enforces', () => {
    const recipe = DOC.slice(DOC.indexOf('## Sweep-lock recipe'));
    expect(recipe).toContain('locks:acquire');
    expect(recipe).toContain("intent: 'mutation probe'");
    expect(recipe).toContain('ttl_sec: 1200');
    expect(recipe).toContain('locks:release');
    expect(PROBE).toContain('mutation probe');
  });
});
