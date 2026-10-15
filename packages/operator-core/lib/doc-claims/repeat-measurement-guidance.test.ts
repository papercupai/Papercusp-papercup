/**
 * repeat-measurement-guidance.test.ts — plan test-rubric-unification-2026-10-12 P-009 (R-9).
 *
 * The rule "a repeatable measurement belongs in a rubric check recorded to the results ledger,
 * never in a hand rating" must stay stated on every guidance SOURCE surface an agent learns it
 * from. A surface that drops it fails this file.
 *
 * Drift markers — the three source surfaces (never CLAUDE.md, a `.materialized/` copy or a
 * rendered launch-context file):
 *   (1) the papercusp-way routing table ROW in the su playbook source
 *       libs/papercusp/packages/harness/blueprints/base/prompts/su.md (the papercusp-engineer
 *       agent-base-overlay.md copy of the table is GENERATED from it by
 *       scripts/check-prompt-projections.mjs --write, so it is deliberately not read here);
 *   (2) the AUDIT mode definition source libs/papercusp/packages/harness/blueprints/su.mode-audit/prompts/audit.md;
 *   (3) the agent-insights doc repeat-measurements-are-rubric-checks (its projected .mdx, the
 *       file every doc-claims test reads; Postgres is canonical and docs:author writes both).
 *
 * Every detector keeps a permanent in-file control proving it can fail.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './corpus-subject';

const RULE = 'A repeatable measurement belongs in a rubric check recorded to the results ledger, never in a hand rating';

const ROUTING_TABLE_SOURCES = ['libs/papercusp/packages/harness/blueprints/base/prompts/su.md'] as const;
const AUDIT_MODE_SOURCE = 'libs/papercusp/packages/harness/blueprints/su.mode-audit/prompts/audit.md';
const INSIGHT_DOC = 'apps/operator-docs/src/content/docs/agent-insights/repeat-measurements-are-rubric-checks.mdx';

const read = (relpath: string): string => readFileSync(join(ROOT, relpath), 'utf8');

/** Collapse whitespace (line wraps) and case so a re-wrapped paragraph still matches. */
const norm = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** True when `text` states the rule sentence (wrapping and case ignored). */
export function statesRule(text: string): boolean {
  return norm(text).includes(norm(RULE));
}

/**
 * The rows of the papercusp-way routing gate table: the `|` lines between the
 * `### The papercusp-way routing gate` heading and the next heading.
 */
export function routingGateRows(markdown: string): string[] {
  const start = markdown.indexOf('### The papercusp-way routing gate');
  if (start < 0) return [];
  const rest = markdown.slice(start + 1);
  const next = rest.search(/\n#{2,3} /);
  const section = next < 0 ? rest : rest.slice(0, next);
  return section.split('\n').filter((line) => line.trimStart().startsWith('|'));
}

/** True when some routing-table ROW (not surrounding prose) states the rule. */
export function routingRowStatesRule(markdown: string): boolean {
  return routingGateRows(markdown).some(statesRule);
}

/** The body of an .mdx doc, frontmatter removed (a description-only mention does not count). */
function mdxBody(text: string): string {
  const match = /^---\n[\s\S]*?\n---\n/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

describe('R-9 repeat-measurement guidance — source surfaces state the rule', () => {
  it.each(ROUTING_TABLE_SOURCES)('(1) a papercusp-way routing table row in %s states the rule', (relpath) => {
    const markdown = read(relpath);
    expect(routingGateRows(markdown).length, `${relpath}: routing gate table not found`).toBeGreaterThan(5);
    expect(routingRowStatesRule(markdown), `${relpath}: no routing row states the repeat-measurement rule`).toBe(true);
  });

  it('(2) the audit-mode definition source states the rule', () => {
    expect(statesRule(read(AUDIT_MODE_SOURCE))).toBe(true);
  });

  it('(3) the agent-insights doc body states the rule', () => {
    expect(statesRule(mdxBody(read(INSIGHT_DOC)))).toBe(true);
  });

  it('reads only source surfaces, never a generated or rendered copy', () => {
    for (const relpath of [...ROUTING_TABLE_SOURCES, AUDIT_MODE_SOURCE, INSIGHT_DOC]) {
      expect(relpath).not.toMatch(/\.materialized\/|(^|\/)CLAUDE\.md$|(^|\/)AGENTS\.md$|launch-context|agent-base-overlay\.md$/);
    }
  });
});

describe('R-9 detector controls — each detector can fail', () => {
  const su = read(ROUTING_TABLE_SOURCES[0]);

  it('a routing table with the row removed fails', () => {
    const dropped = su
      .split('\n')
      .filter((line) => !(line.trimStart().startsWith('|') && statesRule(line)))
      .join('\n');
    expect(routingRowStatesRule(su)).toBe(true);
    expect(routingRowStatesRule(dropped)).toBe(false);
  });

  it('the rule stated in prose OUTSIDE the table does not count as the row', () => {
    const prose = `### The papercusp-way routing gate\n\n${RULE}.\n\n| when | way |\n|---|---|\n| a | b |\n\n## Next\n`;
    expect(routingRowStatesRule(prose)).toBe(false);
  });

  it('a row after the next heading is outside the table', () => {
    const later = `### The papercusp-way routing gate\n\n| when | way |\n|---|---|\n\n### Other table\n\n| x | ${RULE} |\n`;
    expect(routingRowStatesRule(later)).toBe(false);
  });

  it('an audit definition with the sentence removed fails', () => {
    const audit = read(AUDIT_MODE_SOURCE);
    const stripped = norm(audit).replace(norm(RULE), '');
    expect(statesRule(stripped)).toBe(false);
  });

  it('a paraphrase that drops "never in a hand rating" fails', () => {
    expect(statesRule('A repeatable measurement belongs in a rubric check recorded to the results ledger.')).toBe(false);
  });

  it('a doc that states the rule only in its frontmatter description fails', () => {
    const frontmatterOnly = `---\ntitle: x\ndescription: ${RULE}.\n---\n\n## Body\n\nNothing here.\n`;
    expect(statesRule(frontmatterOnly)).toBe(true);
    expect(statesRule(mdxBody(frontmatterOnly))).toBe(false);
  });

  it('re-wrapping the sentence across lines still matches', () => {
    expect(statesRule('a repeatable measurement\n   belongs in a rubric check recorded to the\nresults ledger, never in a hand rating')).toBe(true);
  });
});
