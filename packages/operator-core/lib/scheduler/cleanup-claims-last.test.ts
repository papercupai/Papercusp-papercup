/**
 * code-cleanup-campaigns-2026-10-26 P-003 (R-3): a 'cleanup' item is claimed only when no
 * feature, bug or change item is claimable. compileRank (the ONE ORDER BY compiler behind
 * scheduler:get_next and the issue-claim path) must lead every ordering with a hard
 * cleanup-last key, ahead of the authored rank and the soft lock-placement bit, in both
 * rank modes.
 */
import { describe, expect, it } from 'vitest';

import { compileRank } from './get-next';
import type { ClaimSpec } from './claim-spec';

type Frag = { strings: readonly string[]; vals: readonly unknown[] };
const fakeSql = ((strings: TemplateStringsArray, ...vals: unknown[]): Frag => ({ strings, vals })) as never;

function render(v: unknown): string {
  if (v && typeof v === 'object' && 'strings' in (v as Frag)) {
    const f = v as Frag;
    return f.strings.reduce((acc, s, i) => acc + s + (i < f.vals.length ? render(f.vals[i]) : ''), '');
  }
  return `<${JSON.stringify(v)}>`;
}

const spec = (mode: 'lexicographic' | 'weighted', terms: unknown[] = []): ClaimSpec =>
  ({ rank: { mode, terms } }) as unknown as ClaimSpec;

const CLEANUP_KEY = `(CASE WHEN COALESCE(item_kind, kind) = <"cleanup"> THEN 1 ELSE 0 END) ASC`;

describe('compileRank orders cleanup items after every other claimable item', () => {
  it('leads a lexicographic ordering with the cleanup-last key', () => {
    const out = render(compileRank(fakeSql, spec('lexicographic'), {} as never)).replace(/\s+/g, ' ');
    expect(out.startsWith(CLEANUP_KEY)).toBe(true);
    expect(out).toContain('created_ts ASC');
  });

  it('leads a weighted ordering with the cleanup-last key', () => {
    const out = render(compileRank(fakeSql, spec('weighted'), {} as never)).replace(/\s+/g, ' ');
    expect(out.startsWith(CLEANUP_KEY)).toBe(true);
  });

  it('keeps cleanup-last ahead of the soft lock-placement bit', () => {
    const out = render(
      compileRank(fakeSql, spec('lexicographic'), { contendedPaths: ['packages/x.ts'] } as never),
    ).replace(/\s+/g, ' ');
    expect(out.startsWith(CLEANUP_KEY)).toBe(true);
    expect(out.indexOf('jsonb_array_elements_text')).toBeGreaterThan(CLEANUP_KEY.length);
  });
});
