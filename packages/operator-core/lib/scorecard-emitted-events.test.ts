/**
 * scorecard-emitted-events — the bridge that lets an implementer PARK on the independent
 * grade their plan requires, instead of polling scorecards:list (EI-21434202765745827).
 *
 * What these tests actually pin, beyond "it calls emit": the key is rubric-scoped (so one
 * implementer's wait is not woken by every card in the workspace), the payload carries the
 * fields a payload_filter needs to distinguish an INDEPENDENT card from the implementer's
 * own acceptance re-emit, and a failing emit cannot take down the scorecard write that
 * already succeeded — that last one is the property that matters most, because the card is
 * the durable truth and the event is only its notification.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  scorecardEmittedKey,
  scorecardGradingAuditKey,
  emitScorecardEmitted,
  type ScorecardEmittedPayload,
  type ScorecardGradingAuditSettledPayload,
} from './scorecard-emitted-events';
import { EVENT_CATALOG } from './events/await/catalog';

const basePayload = (over: Partial<ScorecardEmittedPayload> = {}): ScorecardEmittedPayload => ({
  issueId: 'EI-1',
  rubricRef: 'acceptance-my-plan-2026-08-25',
  rubricKind: 'acceptance',
  subjectKind: 'plan',
  subjectRef: 'my-plan-2026-08-25',
  createdBy: 'su-grader',
  hasAcceptance: false,
  ...over,
});

describe('scorecardEmittedKey', () => {
  it('scopes the key to the rubric, so an implementer wakes only for their own rubric', () => {
    expect(scorecardEmittedKey('acceptance-a')).toBe('scorecard:emitted:acceptance-a');
    expect(scorecardEmittedKey('acceptance-b')).not.toBe(scorecardEmittedKey('acceptance-a'));
  });

  it('matches the keyTemplate registered in the await catalog', () => {
    // catalog.ts declares `scorecard:emitted:<rubricRef>` — if this builder ever drifts
    // from that template, awaiters registered off the catalog would never rendezvous.
    const template = 'scorecard:emitted:<rubricRef>';
    expect(scorecardEmittedKey('R')).toBe(template.replace('<rubricRef>', 'R'));
  });
});

describe('emitScorecardEmitted', () => {
  it('fires the rubric-scoped key plus the plan acceptance change key and carries the filed card', async () => {
    const emit = vi.fn().mockResolvedValue({ ok: true, key: 'k' });
    await emitScorecardEmitted(basePayload(), { emit: emit as never });

    expect(emit).toHaveBeenCalledTimes(2);
    const opts = emit.mock.calls[0]![0] as { key: string; payload: ScorecardEmittedPayload };
    expect(opts.key).toBe('scorecard:emitted:acceptance-my-plan-2026-08-25');
    expect(opts.payload.issueId).toBe('EI-1');
    expect(opts.payload.subjectRef).toBe('my-plan-2026-08-25');
    expect((emit.mock.calls[1]![0] as { key: string }).key).toBe('plan:acceptance:my-plan-2026-08-25');
  });

  it('carries createdBy + hasAcceptance so a filter can tell an INDEPENDENT card from the implementer own re-emit', async () => {
    const emit = vi.fn().mockResolvedValue({ ok: true, key: 'k' });

    await emitScorecardEmitted(basePayload({ createdBy: 'su-grader', hasAcceptance: false }), {
      emit: emit as never,
    });
    await emitScorecardEmitted(
      basePayload({ issueId: 'EI-2', createdBy: 'su-implementer', hasAcceptance: true }),
      { emit: emit as never },
    );

    const rubricCalls = emit.mock.calls
      .map((call) => call[0] as { key: string; payload: ScorecardEmittedPayload })
      .filter((call) => call.key.startsWith('scorecard:emitted:'));
    const first = rubricCalls[0]!;
    const second = rubricCalls[1]!;
    // Both land on the SAME key by design, so the two cards are only separable by
    // payload — which is exactly what an implementer's payload_filter reads.
    expect(first.payload.createdBy).not.toBe(second.payload.createdBy);
    expect(first.payload.hasAcceptance).toBe(false);
    expect(second.payload.hasAcceptance).toBe(true);
  });

  it('passes workspaceId through only when present', async () => {
    const emit = vi.fn().mockResolvedValue({ ok: true, key: 'k' });

    await emitScorecardEmitted(basePayload(), { emit: emit as never, workspaceId: 'ws-1' });
    expect((emit.mock.calls[0]![0] as { workspaceId?: string }).workspaceId).toBe('ws-1');
    expect((emit.mock.calls[1]![0] as { workspaceId?: string }).workspaceId).toBe('ws-1');

    await emitScorecardEmitted(basePayload(), { emit: emit as never });
    expect('workspaceId' in (emit.mock.calls[2]![0] as object)).toBe(false);
    expect('workspaceId' in (emit.mock.calls[3]![0] as object)).toBe(false);
  });

  it('NEVER throws when the emit fails — the card is durable, the event is only its notification', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn().mockRejectedValue(new Error('event bus exploded'));

    await expect(emitScorecardEmitted(basePayload(), { emit: emit as never })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('stays SILENT on the expected fail-soft noise (partial test schema / torn-down pool)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (const err of [
      new Error('relation "events" does not exist'),
      Object.assign(new Error('write CONNECTION_ENDED'), { code: 'CONNECTION_ENDED' }),
      Object.assign(new Error('boom'), { code: 'CONNECTION_DESTROYED' }),
    ]) {
      await emitScorecardEmitted(basePayload(), { emit: vi.fn().mockRejectedValue(err) as never });
    }

    // Warning on these would make every rig that tears down its pool flake.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('grading-audit settlement key (EI-24852356444105284)', () => {
  const settled = (over: Partial<ScorecardGradingAuditSettledPayload> = {}): ScorecardGradingAuditSettledPayload => ({
    issueId: 'EI-AUDITED',
    state: 'passed',
    auditIssueId: 'EI-AUDIT-CARD',
    auditor: 'su-auditor',
    auditedAt: '2026-10-02T08:10:17.712Z',
    rubricRevision: 10,
    ...over,
  });

  it('matches the keyTemplate registered in the await catalog, keyed by the AUDITED card', () => {
    const entry = EVENT_CATALOG.find((e) => e.family === 'scorecard-grading-audit');
    expect(entry?.keyTemplate).toBe('scorecard:grading-audit:<id>');
    expect(scorecardGradingAuditKey('EI-AUDITED')).toBe(entry!.keyTemplate.replace('<id>', 'EI-AUDITED'));
  });

  it('fires the settled key with the verdict when settledAudit is passed', async () => {
    const emit = vi.fn().mockResolvedValue({ ok: true, key: 'k' });
    // An audit card's subject is a scorecard, not a plan: no plan:acceptance key.
    await emitScorecardEmitted(basePayload({ subjectKind: 'scorecard', subjectRef: 'EI-AUDITED' }), {
      emit: emit as never,
      workspaceId: 'ws-1',
      settledAudit: settled({ state: 'failed' }),
    });

    const keys = emit.mock.calls.map((call) => (call[0] as { key: string }).key);
    expect(keys).toEqual(['scorecard:emitted:acceptance-my-plan-2026-08-25', 'scorecard:grading-audit:EI-AUDITED']);
    const fired = emit.mock.calls[1]![0] as {
      payload: ScorecardGradingAuditSettledPayload;
      workspaceId?: string;
      summary: string;
    };
    expect(fired.payload).toMatchObject({ issueId: 'EI-AUDITED', state: 'failed', auditIssueId: 'EI-AUDIT-CARD' });
    expect(fired.workspaceId).toBe('ws-1');
    expect(fired.summary).toContain('failed');
  });

  it('fires NO settled key for an ordinary card (no settledAudit)', async () => {
    const emit = vi.fn().mockResolvedValue({ ok: true, key: 'k' });
    await emitScorecardEmitted(basePayload(), { emit: emit as never });
    const keys = emit.mock.calls.map((call) => (call[0] as { key: string }).key);
    expect(keys.some((k) => k.startsWith('scorecard:grading-audit:'))).toBe(false);
  });

  it('a recovered settlement wakes its target without announcing another card filing', async () => {
    const emit = vi.fn().mockResolvedValue({ ok: true, key: 'k' });
    await emitScorecardEmitted(basePayload(), { emit: emit as never, filed: false, settledAudit: settled() });
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0]).toMatchObject({ key: 'scorecard:grading-audit:EI-AUDITED', payload: settled() });
  });

  it('a failed rubric-key emit does not suppress the settled key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn().mockRejectedValueOnce(new Error('bus down')).mockResolvedValue({ ok: true, key: 'k' });
    await emitScorecardEmitted(basePayload({ subjectKind: 'scorecard', subjectRef: 'EI-AUDITED' }), {
      emit: emit as never,
      settledAudit: settled(),
    });
    expect((emit.mock.calls[1]![0] as { key: string }).key).toBe('scorecard:grading-audit:EI-AUDITED');
    warn.mockRestore();
  });
});
