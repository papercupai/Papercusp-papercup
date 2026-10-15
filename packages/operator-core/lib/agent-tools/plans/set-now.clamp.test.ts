/**
 * `state` is a SOFT-capped field, not a hard reject (EI-20020322245949080).
 *
 * `plans:set-now { state }` used to be `z.string().max(2000, ...)`, so an
 * over-length Now block was BOUNCED. The caller cannot act on that without
 * re-sending the whole block, and each re-send is a full round-trip. Measured
 * 2026-08-09 on plan retire-mug-kettle-su-only-2026-08-09: FIVE consecutive
 * rejections at 2011 → 2099 → 2055 → 2037 → 2014 → 2004 chars before landing at
 * 2000 — the tail attempts shaving 4-14 characters each.
 *
 * It was also an internal inconsistency: the SIBLING field `next` on this very
 * tool is `softText(8000)` and auto-truncates, so an agent that had just been
 * silently truncated on one field was hard-bounced on the other.
 *
 * limits.ts states the policy this restores: `hardText` is for values
 * "genuinely invalid downstream (an id/key ... a stored body with a real
 * bound)"; `softText` is for "advisory/echoed free-text ... bouncing them on
 * length is pure friction". The `## Now` block is echoed markdown prose with no
 * downstream length bound, so it is a soft field.
 *
 * WHY THE SCHEMA-LEVEL TESTS BELOW ARE THE LOAD-BEARING ONES: the rejection
 * lived in zod, and `tool.handler(args)` is called directly here, bypassing arg
 * validation entirely. A handler-only test would pass just as happily against
 * the unfixed hard-max and prove nothing about the round-trip this item is
 * about. The clamp is asserted at BOTH layers on purpose.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_harness: unknown, ctx: unknown) => ctx,
}));
vi.mock('./_ctx-opts', () => ({ resolveCtxHarnessSlug: () => null }));
vi.mock('./revisions', () => ({
  planRevisionCapture: () => ({ afterWrite: undefined, recorded: { current: null } }),
}));
vi.mock('../coordination/plan-events', () => ({ emitPlanEventForCaller: vi.fn(async () => {}) }));
vi.mock('./with-plan-lock', () => ({
  withPlanLock: vi.fn(),
  bumpUpdatedDate: (body: string) => body,
}));

import { withPlanLock } from './with-plan-lock';
import tool from './set-now';
import { renderNowNoteRaw, type PlanNowNote } from './now-note-store';

const lockM = vi.mocked(withPlanLock);
type ToolEnvelope = { data: any };

const BASE = `---\ntitle: t\nslug: plan-a\nstatus: active\n---\n\n# Plan\n\n## Now\n\n**State:** old\n\n**Next:** old\n\n## Work\n\n- P-002\n`;

/** The Now the write stored, rendered as State/Next markdown (P-004: a structured note, not content). */
let writtenBody: string | null | undefined;

function lockReturnsBody(body = BASE) {
  lockM.mockImplementation(async (_ctx: unknown, _options: unknown, mutate: unknown) => {
    const result = await (
      mutate as (current: string | null) => Promise<{ newBody: string | null; nowNote?: PlanNowNote; value: unknown }>
    )(body);
    writtenBody = result.nowNote ? renderNowNoteRaw(result.nowNote) : null;
    return { kind: 'ok', value: result.value, filePath: 'plan.md' } as never;
  });
}

async function run(args: Record<string, unknown>) {
  return ((await tool.handler(args as never, {} as never)) as ToolEnvelope).data;
}

/** The exact shape that used to bounce: a hair over the 2000-char cap. */
const OVER_STATE = 'S'.repeat(2011);

beforeEach(() => {
  vi.clearAllMocks();
  writtenBody = undefined;
});

describe('plans:set-now state clamp (schema layer — where the reject lived)', () => {
  it('ACCEPTS an over-length state instead of bouncing it', () => {
    const parsed = tool.args.safeParse({
      slug: 'plan-a',
      state: OVER_STATE,
      next: 'Do the thing.',
    });

    // The regression this item is about: this used to be success:false, and every
    // false here cost the caller a full round-trip.
    expect(parsed.success).toBe(true);
  });

  it('still rejects an EMPTY state — soft means unbounded-above, not unvalidated', () => {
    const parsed = tool.args.safeParse({ slug: 'plan-a', state: '', next: 'Do the thing.' });
    expect(parsed.success).toBe(false);
  });

  it('accepts an over-length next too (the sibling field, unchanged)', () => {
    const parsed = tool.args.safeParse({
      slug: 'plan-a',
      state: 'fine',
      next: 'N'.repeat(8011),
    });
    expect(parsed.success).toBe(true);
  });
});

describe('plans:set-now state clamp (handler layer — truncation + disclosure)', () => {
  it('truncates the stored state to exactly the 2000-char cap', async () => {
    lockReturnsBody();

    await run({ slug: 'plan-a', state: OVER_STATE, next: 'Do the thing.' });

    expect(writtenBody).toContain(`**State:** ${'S'.repeat(2000)}\n`);
    // 2011 in, 2000 stored — the 11-char tail is gone, which is exactly why the
    // next assertion (that it is REPORTED) matters.
    expect(writtenBody).not.toContain('S'.repeat(2001));
  });

  it('REPORTS the clamp — a silent truncation of the cold-resume anchor is the risk', async () => {
    lockReturnsBody();

    const out = await run({ slug: 'plan-a', state: OVER_STATE, next: 'Do the thing.' });

    expect(out.results[0].ok).toBe(true);
    expect(out.results[0].clamped).toEqual([
      { field: 'state', fromChars: 2011, toChars: 2000 },
    ]);
  });

  it('reports a clamped next as well (this was previously silent)', async () => {
    lockReturnsBody();

    const out = await run({ slug: 'plan-a', state: 'fine', next: 'N'.repeat(8011) });

    expect(out.results[0].clamped).toEqual([{ field: 'next', fromChars: 8011, toChars: 8000 }]);
  });

  it('reports BOTH fields when both overflow', async () => {
    lockReturnsBody();

    const out = await run({ slug: 'plan-a', state: OVER_STATE, next: 'N'.repeat(8011) });

    expect(out.results[0].clamped.map((c: any) => c.field)).toEqual(['state', 'next']);
  });

  it('omits `clamped` entirely for a within-cap call — no false positive', async () => {
    lockReturnsBody();

    const out = await run({
      slug: 'plan-a',
      state: 'P-002 in progress; the clamp is landing.',
      next: 'Ship it.',
    });

    expect(out.results[0].ok).toBe(true);
    expect(out.results[0]).not.toHaveProperty('clamped');
    // An exactly-at-cap value is NOT over the cap and must not be reported.
    writtenBody = undefined;
    const atCap = await run({ slug: 'plan-a', state: 'S'.repeat(2000), next: 'Ship it.' });
    expect(atCap.results[0]).not.toHaveProperty('clamped');
  });

  it('writes the CLAMPED text downstream, not the original', async () => {
    lockReturnsBody();

    await run({ slug: 'plan-a', state: OVER_STATE, next: 'Do the thing.' });

    // The body is the durable artifact; if any consumer were handed args.state
    // instead of the clamped value the cap would be cosmetic.
    const stateLine = String(writtenBody).split('\n').find((l) => l.startsWith('**State:**'));
    expect(stateLine).toBeDefined();
    expect(String(stateLine).length).toBe('**State:** '.length + 2000);
  });
});
