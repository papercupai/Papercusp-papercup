/**
 * P-008 — VALUE-level arg refusals must carry their own correction.
 *
 * `invalidInputCorrections` (libs/generic/tooldef/src/define-tool.ts) returns [] unless
 * `unrecognizedArgKeys` is non-empty. So for a key the tool DOES declare, whose VALUE is
 * the wrong shape, every authored `argRedirects` entry, near-name guess and
 * corrected-call hint is unreachable by construction — an argRedirect authored for a
 * declared key silently never fires. What the caller reads is the bare Zod leaf.
 *
 * The seam that does reach them is a field-level Zod `error`, which replaces exactly
 * that leaf and is NOT emitted into the JSON Schema (so it costs no prompt weight — the
 * reason it is available on tools with single-digit budget headroom).
 *
 * These assertions RENDER the refusal through `formatIssues`, the same function the
 * transport uses. Asserting that a schema merely CARRIES a message would pass while the
 * caller still saw Zod's generic line — and inside a `z.union` that is a live risk,
 * because the rendered text comes from whichever branch `issueLeaves`/`bestUnionBranch`
 * selects, not from the branch the author had in mind.
 *
 * dev:pg_query's own case (EI-21596258009994255) is pinned in dev/pg_query.test.ts,
 * beside the rest of that tool's contract.
 */
import { describe, expect, it } from 'vitest';
import { formatIssues } from '@papercusp/tooldef';

import declareIntentTool from './coordination/tools/declare-intent';
import timelineTool from './sessions/timeline';

/** What a caller actually reads back for these args. */
function refusalFor(tool: { args: { safeParse: (i: unknown) => { success: boolean; data?: unknown; error?: { issues: unknown } } } }, input: unknown): string {
  const parsed = tool.args.safeParse(input);
  if (parsed.success) throw new Error(`expected a refusal, got acceptance: ${JSON.stringify(parsed.data)}`);
  return formatIssues(parsed.error!.issues as never, input);
}

describe('coord:declare-intent items — a WI-/EI- id names its route (EI-21139039044360936)', () => {
  it('CONTROL: a real P-NNN lane is still accepted', () => {
    const parsed = declareIntentTool.args.safeParse({ intent: 'x', current_plan_slug: 'p', items: ['P-008'] });
    expect(parsed.success).toBe(true);
  });

  it('names scheduler:get_next rather than only the required FORM', () => {
    const rendered = refusalFor(declareIntentTool, { intent: 'x', items: ['EI-21138909427733492'] });
    expect(rendered).toContain('scheduler:get_next');
    // The measured recovery was "retry without items", which drops the lane entirely —
    // so the refusal must also say what to do INSTEAD of declaring no lane at all.
    expect(rendered).toMatch(/name the work-item in `intent`/i);
  });

  it('POSITIVE CONTROL: the bare form-only string is no longer the whole message', () => {
    // Before this change the caller read exactly `P-NNN form required` and nothing else.
    // The arg description had named scheduler:get_next since 2026-08-12 and the filing is
    // from 2026-08-22, so the description alone demonstrably did not prevent it.
    const rendered = refusalFor(declareIntentTool, { intent: 'x', items: ['WI-2145862'] });
    expect(rendered).not.toMatch(/P-NNN form required['"]?\s*$/);
    expect(rendered.length).toBeGreaterThan('P-NNN form required'.length + 40);
  });
});

describe('sessions:timeline owner — a cursor does not carry it (EI-22069000224788496)', () => {
  it('CONTROL: a normal call is still accepted', () => {
    const parsed = timelineTool.args.safeParse({ owner: 'self' });
    expect(parsed.success).toBe(true);
  });

  it('a `{ cursor }`-only continuation is told the cursor is a POSITION only', () => {
    const rendered = refusalFor(timelineTool, { cursor: 'opaque-cursor-from-a-prior-call' });
    expect(rendered).toMatch(/position only/i);
    expect(rendered).toMatch(/re-send the SAME owner and filters/i);
  });

  it('the plain missing-owner call gets the same correction, since it is the same question', () => {
    const rendered = refusalFor(timelineTool, {});
    expect(rendered).toMatch(/pass 'self' for yourself/);
  });

  it('POSITIVE CONTROL: the generic Zod line is no longer what the caller sees', () => {
    // Without the substitution this is EXACTLY the text measured in the field.
    const rendered = refusalFor(timelineTool, { cursor: 'opaque-cursor-from-a-prior-call' });
    expect(rendered).not.toMatch(/expected string, received undefined/);
  });

  it('the published cursor description states the same requirement, so the fix is not refusal-only', () => {
    const schema = timelineTool.args as unknown as { shape: Record<string, { description?: string }> };
    const cursorDescription = schema.shape.cursor?.description ?? '';
    expect(cursorDescription).toMatch(/POSITION only/);
    expect(cursorDescription).toMatch(/re-send the same `owner` and filters/i);
    expect(cursorDescription).toMatch(/pass it under this `cursor` argument/i);
    expect(cursorDescription).toMatch(/`nextCursor` is the response field name, not an accepted argument key/i);
    expect(Object.keys(schema.shape)).toContain('cursor');
    expect(Object.keys(schema.shape)).not.toContain('nextCursor');
    expect((timelineTool as unknown as { description: string }).description).toMatch(
      /returned `nextCursor` value in the `cursor` argument/i,
    );
  });
});
