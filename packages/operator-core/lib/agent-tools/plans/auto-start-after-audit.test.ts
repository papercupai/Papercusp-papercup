import { describe, expect, it, vi } from 'vitest';
import { autoStartAfterActivationAudit } from './auto-start-after-audit';

const plan = (status: string) => `---\ntitle: T\nstatus: ${status}\n---\n\n## Items\n\n- [ ] **P-001** — one\n`;

describe('autoStartAfterActivationAudit (WI-10008137)', () => {
  it('runs plans:start for a draft plan and reports a start', async () => {
    const start = vi.fn().mockResolvedValue({
      data: { ok: true, results: [{ ok: true, slug: 's', transitioned: true, autoApproved: true }] },
    });
    const out = await autoStartAfterActivationAudit({ slug: 's', harness: 'h', planContent: plan('draft'), start });
    expect(start).toHaveBeenCalledWith({ slug: 's', harness: 'h' });
    expect(out).toEqual({ attempted: true, started: true, transitioned: true, autoApproved: true });
  });

  it('does not start a plan that is not draft', async () => {
    const start = vi.fn();
    for (const status of ['ready', 'active', 'shipped', 'superseded']) {
      const out = await autoStartAfterActivationAudit({ slug: 's', planContent: plan(status), start });
      expect(out).toEqual({ attempted: false, reason: 'not-draft', status });
    }
    expect(start).not.toHaveBeenCalled();
  });

  it('does not start when the plan content is unavailable', async () => {
    const start = vi.fn();
    const out = await autoStartAfterActivationAudit({ slug: 's', planContent: null, start });
    expect(out).toEqual({ attempted: false, reason: 'no-content', status: null });
    expect(start).not.toHaveBeenCalled();
  });

  it("returns plans:start's refusal unchanged so the auditor sees what is missing", async () => {
    const start = vi.fn().mockResolvedValue({
      data: {
        ok: false,
        results: [{ ok: false, slug: 's', error: 'spec_quality_not_current', message: 'evaluate spec quality first' }],
      },
    });
    const out = await autoStartAfterActivationAudit({ slug: 's', planContent: plan('draft'), start });
    expect(out).toEqual({
      attempted: true,
      started: false,
      refusal: { error: 'spec_quality_not_current', message: 'evaluate spec quality first' },
    });
  });

  it('uses the hint when a refusal carries no message (consult_available shape)', async () => {
    const start = vi.fn().mockResolvedValue({
      data: { ok: false, results: [{ ok: false, error: 'consult_available', hint: 'review candidates' }] },
    });
    const out = await autoStartAfterActivationAudit({ slug: 's', planContent: plan('draft'), start });
    expect(out).toEqual({
      attempted: true,
      started: false,
      refusal: { error: 'consult_available', message: 'review candidates' },
    });
  });

  it('never throws: a crashing start becomes a refusal', async () => {
    const start = vi.fn().mockRejectedValue(new Error('boom'));
    const out = await autoStartAfterActivationAudit({ slug: 's', planContent: plan('draft'), start });
    expect(out).toEqual({ attempted: true, started: false, refusal: { error: 'auto_start_failed', message: 'boom' } });
  });

  it('reports an unreadable plans:start result as a refusal, not a start', async () => {
    const start = vi.fn().mockResolvedValue({ data: { ok: true, results: [] } });
    const out = await autoStartAfterActivationAudit({ slug: 's', planContent: plan('draft'), start });
    expect(out).toMatchObject({ attempted: true, started: false, refusal: { error: 'auto_start_unreadable' } });
  });
});
