/** Caller wiring for the durable Now-block warning (EI-20268156880922192). */
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

const BASE = `---\ntitle: t\nslug: plan-a\nstatus: active\n---\n\n# Plan\n\n## Now\n\n**State:** old\n\n**Next:** old\n\n## Work\n\n- P-001\n`;

/** The Now the write stored, rendered as State/Next markdown (P-004: a structured note, not content). */
let writtenBody: string | null | undefined;

function lockReturnsBody(body = BASE) {
  lockM.mockImplementation(async (_ctx: unknown, _options: unknown, mutate: unknown) => {
    const result = await (mutate as (current: string | null) => Promise<{ newBody: string | null; nowNote?: PlanNowNote; value: unknown }>)
      (body);
    writtenBody = result.nowNote ? renderNowNoteRaw(result.nowNote) : null;
    return { kind: 'ok', value: result.value, filePath: 'plan.md' } as never;
  });
}

async function run(args: Record<string, unknown>) {
  return ((await tool.handler(args as never, {} as never)) as ToolEnvelope).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  writtenBody = undefined;
});

describe('plans:set-now ephemeral terminal-deliverable warning', () => {
  it('warns after the durable Now write when state/next cite ephemeral references', async () => {
    lockReturnsBody();

    const out = await run({
      slug: 'plan-a',
      state: 'report is ready at .papercusp/scratch/readiness.md',
      next: 'read https://claude.ai/code/artifact/abc before shipping',
    });

    expect(out.results[0].ok).toBe(true);
    expect(out.results[0].ephemeralDeliverableWarning).toMatch(/deliverable-durability guard/);
    expect(out.results[0].ephemeralDeliverableWarning).toContain('.papercusp/scratch/readiness.md');
    expect(out.results[0].ephemeralDeliverableWarning).toContain('claude.ai/code/artifact/abc');
    expect(writtenBody).toContain('**State:** report is ready');
    expect(writtenBody).toContain('**Next:** read https://claude.ai/code/artifact/abc');
  });

  it('stays silent for a durable Now block', async () => {
    lockReturnsBody();

    const out = await run({ slug: 'plan-a', state: 'verified', next: 'run the exact tests' });

    expect(out.results[0].ok).toBe(true);
    expect(out.results[0].ephemeralDeliverableWarning).toBeUndefined();
  });
});
