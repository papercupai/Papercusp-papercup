/**
 * WI-6554700010017006 — pins WHO may write completionAuthority `validated`.
 *
 * work-item-completion-authority.ts declared `validated` RESERVED with "no writer ships
 * in this phase" for weeks after 5a8ba13ecf (2026-09-25) began stamping it from the
 * blueprint-program settlement. That settlement also stamped it on cancelled and failed
 * roots, which nothing had corroborated. Nothing caught either, because no writer
 * consults canTransition() and the transition table's own tests only check the table.
 *
 * This test checks the SOURCE instead:
 *   1. the set of non-test files that write `validated` is exactly the documented one;
 *   2. in that file, no `dropped` settlement writes `validated`;
 *   3. the authority module's prose names the writer it documents.
 * The fixture controls prove each detector can fail.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const WRITER = 'packages/operator-core/lib/dbos/coord-program-workflow.ts';
const AUTHORITY_MODULE = 'packages/operator-core/lib/work-item-completion-authority.ts';
const SCAN_ROOTS = ['packages/operator-core/lib', 'apps/operator/lib', 'apps/operator/bin', 'packages/agent-mcp/src'];

/** Drop block and line comments so prose mentioning the literal is not a writer. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Object-literal WRITES of the value — never a comparison like `=== 'validated'`. */
export function validatedWriteCount(source: string): number {
  return (stripComments(source).match(/\b(?:completionAuthority|authority)\s*:\s*['"]validated['"]/g) ?? []).length;
}

/** `setWorkItemState(x, 'dropped', { … })` calls whose options stamp `validated`. */
export function droppedSettlementsStampingValidated(source: string): number {
  const segments = stripComments(source).split(/setWorkItemState\(/).slice(1);
  return segments
    .map((s) => s.slice(0, 700))
    .filter((s) => /^[^,]+,\s*'dropped'/.test(s) && /completionAuthority\s*:\s*['"]validated['"]/.test(s))
    .length;
}

function trackedSourceFiles(): string[] {
  const out = execFileSync('git', ['-C', ROOT, 'ls-files', '--', ...SCAN_ROOTS.map((r) => `${r}/*.ts`)], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\n').filter((p) => p && !/\.(test|spec)\.ts$/.test(p) && !p.includes('/__tests__/'));
}

describe('completionAuthority `validated` writer claim (WI-6554700010017006)', () => {
  describe('fixture controls (the detectors must be able to FAIL)', () => {
    it('counts object-literal writes and ignores comparisons and comments', () => {
      expect(validatedWriteCount(`x({ completionAuthority: 'validated' })`)).toBe(1);
      expect(validatedWriteCount(`x({ authority: "validated" })`)).toBe(1);
      expect(validatedWriteCount(`if (a.completionAuthority === 'validated') {}`)).toBe(0);
      expect(validatedWriteCount(`// completionAuthority: 'validated'\n/* authority: 'validated' */`)).toBe(0);
    });

    it('catches a dropped settlement stamped validated — the pre-fix shape', () => {
      const preFix = `
        return setWorkItemState(rootId, 'dropped', {
          harness: rootHarness, by: OWNER,
          completionAuthority: 'validated',
        });`;
      expect(droppedSettlementsStampingValidated(preFix)).toBe(1);
      expect(droppedSettlementsStampingValidated(preFix.replace("'validated'", "'committed'"))).toBe(0);
      expect(droppedSettlementsStampingValidated(`setWorkItemState(id, 'done', { completionAuthority: 'validated' })`)).toBe(0);
    });
  });

  it('has exactly one non-test writer, the blueprint-program success settlement', () => {
    const writers: Record<string, number> = {};
    for (const rel of trackedSourceFiles()) {
      let text: string;
      try { text = readFileSync(join(ROOT, rel), 'utf8'); } catch { continue; }
      if (!text.includes('validated')) continue;
      const n = validatedWriteCount(text);
      if (n > 0) writers[rel] = n;
    }
    // A new writer must be added to COMPLETION_AUTHORITY_TRANSITIONS (with its actor and
    // reason) and to this expectation in the same change.
    expect(writers).toEqual({ [WRITER]: 1 });
  });

  it('never stamps `validated` on a dropped (cancelled or failed) settlement', () => {
    const source = readFileSync(join(ROOT, WRITER), 'utf8');
    expect(source).toMatch(/setWorkItemState\(rootId, 'dropped'/);
    expect(droppedSettlementsStampingValidated(source)).toBe(0);
  });

  it('keeps the authority module prose naming the writer it documents', () => {
    const prose = readFileSync(join(ROOT, AUTHORITY_MODULE), 'utf8');
    expect(prose).toContain('dbos/coord-program-workflow.ts');
    expect(prose).toContain('doc-claims/completion-authority-validated-writer.test.ts');
    expect(prose).not.toMatch(/No writer ships in this phase/);
  });
});
