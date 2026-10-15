/**
 * add-item-refusal-converges.test.ts — EI-23745289035139187.
 *
 * `plans:add-item` used to refuse a missing slug/phase/text/importance with ONE static
 * message from a boolean `.refine`. A boolean predicate cannot say WHICH field is still
 * unresolved, so a caller who satisfied one of the requirements got the byte-identical
 * refusal back ("a refusal that does not change when the input improves cannot be used to
 * converge") and only reached the real `phase` schema on the THIRD attempt, after
 * guessing `phase: null` — which `plans:items` invites by reporting phase:null for every
 * existing item.
 *
 * The contract pinned here is the PROPERTY, not a message string: each unresolved field
 * gets its own path-addressed issue, so the refusal SHRINKS as the input improves, and
 * the first refusal already names the field's domain.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { argsSchema } from '../add-item';

function issuesOf(input: Record<string, unknown>): Array<{ path: string; message: string }> {
  const r = argsSchema.safeParse(input);
  if (r.success) return [];
  return r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}
const paths = (input: Record<string, unknown>) => issuesOf(input).map((i) => i.path).sort();

describe('plans:add-item refusal converges as the input improves (EI-23745289035139187)', () => {
  it('names EACH unresolved field on the first refusal — attempt 1 { slug, text } → phase + importance', () => {
    expect(paths({ slug: 'p', text: 'x' })).toEqual(['importance', 'phase']);
  });

  it('SHRINKS when one requirement is satisfied — attempt 2 adds importance → only phase remains', () => {
    const first = issuesOf({ slug: 'p', text: 'x' });
    const second = issuesOf({ slug: 'p', text: 'x', importance: 'normal' });
    expect(second.map((i) => i.path)).toEqual(['phase']);
    // The falsifier for the original defect: the refusal text must NOT be identical
    // between attempt 1 and attempt 2 (it was, byte-for-byte, before this change).
    expect(JSON.stringify(second)).not.toEqual(JSON.stringify(first));
    expect(second.length).toBeLessThan(first.length);
  });

  it('the FIRST refusal already carries the field domain — phase says "Phase …", rejects null; importance lists the levels', () => {
    const [phase] = issuesOf({ slug: 'p', text: 'x', importance: 'normal' });
    expect(phase.message).toMatch(/Phase 1/);
    expect(phase.message).toMatch(/null/);
    expect(phase.message).toMatch(/auto-prefixed/);
    const imp = issuesOf({ slug: 'p', text: 'x', phase: 'Phase 1 — A' }).find((i) => i.path === 'importance');
    expect(imp?.message).toMatch(/urgent\|high\|normal\|low/);
  });

  it('a complete call is accepted (control — the superRefine does not over-refuse)', () => {
    expect(argsSchema.safeParse({ slug: 'p', text: 'x', phase: 'Phase 1 — A', importance: 'normal' }).success).toBe(true);
    expect(argsSchema.safeParse({ slug: 'p', title: 'x', phase: 'Baseline', importance: 'low' }).success).toBe(true);
  });

  it('missing slug and text are named too (all four fields are independently reported)', () => {
    expect(paths({ importance: 'normal', phase: 'Phase 1 — A' })).toEqual(['slug', 'text']);
  });

  it('bulk form: points at the exact item and field, and a clean item gets no issue', () => {
    expect(
      paths({
        slug: 'p',
        phase: 'Phase 1 — A',
        importance: 'normal',
        items: [{ text: 'ok' }, { importance: 'high' }],
      }),
    ).toEqual(['items.1.text']);
    expect(paths({ slug: 'p', importance: 'normal', items: [{ text: 'a' }] })).toEqual(['items.0.phase']);
  });

  it('bulk form: a per-item value satisfies a missing batch value (fallback semantics unchanged)', () => {
    expect(
      argsSchema.safeParse({
        slug: 'p',
        items: [{ text: 'a', phase: 'Phase 1 — A', importance: 'normal' }],
      }).success,
    ).toBe(true);
  });

  it('title+body together is reported ONCE by the alias refine — no misleading "text required" pile-on', () => {
    const issues = issuesOf({ slug: 'p', title: 't', body: 'b', phase: 'Phase 1 — A', importance: 'normal' });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/not BOTH at once/);
    expect(issues.some((i) => i.path === 'text')).toBe(false);
  });

  it('phase:null still refuses (the type issue is unchanged — only the missing-field path is new)', () => {
    const r = argsSchema.safeParse({ slug: 'p', text: 'x', importance: 'normal', phase: null });
    expect(r.success).toBe(false);
  });
});

/**
 * CONTROL — proves the convergence property above is FALSIFIABLE. This is the pre-fix
 * shape (one boolean refine, one static message) kept permanently as a deliberately-wrong
 * implementation, rather than mutating production code on the shared tree. If the
 * detector below ever stops seeing this legacy schema as non-converging, the real
 * assertions above have gone vacuous.
 */
describe('CONTROL — the legacy single-message refine does NOT converge (the defect, reproduced)', () => {
  const legacy = z
    .object({
      slug: z.string().optional(),
      phase: z.string().optional(),
      text: z.string().optional(),
      importance: z.string().optional(),
    })
    .refine((a) => Boolean(a.slug) && Boolean(a.phase) && Boolean(a.text) && Boolean(a.importance), {
      message: 'pass { slug, phase, text, importance }',
    });
  const sig = (input: Record<string, unknown>) => {
    const r = legacy.safeParse(input);
    return r.success ? 'ok' : JSON.stringify(r.error.issues.map((i) => [i.path.join('.'), i.message]));
  };

  it('attempt 2 (importance added) yields the BYTE-IDENTICAL refusal as attempt 1 — exactly what the fix removes', () => {
    expect(sig({ slug: 'p', text: 'x', importance: 'normal' })).toEqual(sig({ slug: 'p', text: 'x' }));
  });

  it('and the fixed schema is the opposite on the same two inputs (the detector discriminates)', () => {
    const fixed = (input: Record<string, unknown>) => JSON.stringify(issuesOf(input));
    expect(fixed({ slug: 'p', text: 'x', importance: 'normal' })).not.toEqual(fixed({ slug: 'p', text: 'x' }));
  });
});
