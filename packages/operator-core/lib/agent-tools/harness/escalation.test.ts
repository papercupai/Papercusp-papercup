/**
 * escalation.test.ts — harness:escalation args schema (EI-7146: accept `harness`
 * as an alias for `slug` — the dominant cross-tool convention).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/harness/escalation.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../harness-readers', () => ({ getEscalation: vi.fn() }));

import { getEscalation } from '../../harness-readers';
const getEscalationM = vi.mocked(getEscalation);
const tool = (await import('./escalation')).default;

type Out = { hasEscalation: boolean; escalation: string | null; supervisorNotes: string | null; mtimeMs: number | null };
const body = async (args: unknown) => {
  const res = (await tool.handler(args as never, {} as never)) as { content: [{ type: 'text'; text: string }] };
  return JSON.parse(res.content[0].text) as Out;
};

beforeEach(() => {
  vi.clearAllMocks();
  getEscalationM.mockResolvedValue({
    ok: true,
    data: { escalation: 'E', supervisorNotes: 'N', mtimeMs: 123 },
  });
});

describe('harness:escalation args schema (EI-7146)', () => {
  it('accepts `slug` (the primary/original name)', async () => {
    const out = await body({ slug: 'papercusp' });
    expect(out.hasEscalation).toBe(true);
    expect(getEscalationM).toHaveBeenCalledWith('papercusp', undefined);
  });

  it('accepts `harness` as an alias for `slug`', async () => {
    const out = await body({ harness: 'papercusp' });
    expect(out.hasEscalation).toBe(true);
    expect(getEscalationM).toHaveBeenCalledWith('papercusp', undefined);
  });

  it('passes `phase` through with either name', async () => {
    await body({ harness: 'papercusp', phase: 'staging' });
    expect(getEscalationM).toHaveBeenCalledWith('papercusp', 'staging');
  });

  it('reports a reader failure instead of disguising it as an empty escalation', async () => {
    getEscalationM.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: 'unknown project',
    } as never);

    const res = (await tool.handler({ slug: 'unknown' } as never, {} as never)) as {
      content: [{ type: 'text'; text: string }];
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text)).toEqual({
      ok: false,
      status: 404,
      error: 'unknown project',
    });
  });

  it('rejects a call with neither `slug` nor `harness`', () => {
    const r = tool.args.safeParse({});
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toMatch(/slug.*harness/);
    }
  });
});
