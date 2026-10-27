/**
 * wait-ref-admission.test.ts — event-wait-settlement-2026-10-20 P-006, D-010 item 2.
 *
 * `admitWaitRef` is the SHARED write-time validator for event/gate waits. D-010 makes it
 * the one predicate a second writer (one-work-graph-structured-holds-2026-10-26's hold
 * `reviewWhen`, its P-010) calls instead of a set_blocker-private check. These cases pin
 * its contract directly, independent of set_blocker/release:
 *  - every refusal code is reachable and keeps the reader's reachability verbatim;
 *  - the classifier is asked for a SPECIFIC condition (the releasing paths' predicate);
 *  - `read` is an injection seam a second caller can supply, and `surface` only words the
 *    refusal, so the verdict for one ref is the same for every surface.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalConditionReachability } from './external-condition-reachability';

vi.mock('./external-condition-reachability', () => ({ readEventConditionReachability: vi.fn() }));

import { readEventConditionReachability } from './external-condition-reachability';
import { WAIT_REF_OPTIONS, admitWaitRef } from './wait-ref-admission';

const readM = vi.mocked(readEventConditionReachability);

function reach(over: Partial<ExternalConditionReachability>): ExternalConditionReachability {
  return {
    verdict: 'reachable',
    basis: 'live-resolver',
    authoritative: true,
    evidence: 'catalogued emitter',
    checkedAt: '2026-10-27T01:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  readM.mockReset();
});

describe('admitWaitRef — the shared write-time wait validator (P-006, D-010 item 2)', () => {
  it('admits a reachable, not-yet-fired proving key and returns the reader result unchanged', async () => {
    const r = reach({});
    readM.mockResolvedValue(r);
    const out = await admitWaitRef('work-item:done:WI-1', { surface: 'blocker' });
    expect(out).toEqual({ ok: true, reachability: r });
    expect(readM).toHaveBeenCalledTimes(1);
    expect(readM).toHaveBeenCalledWith('work-item:done:WI-1', { requireSpecificCondition: true });
  });

  it.each([
    ['broad', 'coord:inbox-wake:su-1', 'is a broad wake'],
    ['change-notification', 'work-item:status:WI-1', 'is a change notification'],
    ['uncatalogued', 'free text', 'is not a catalogued event key'],
  ] as const)('refuses an unprovable %s ref as wait_ref_unprovable with the options', async (reason, ref, phrase) => {
    const r = reach({ verdict: 'unknown', basis: 'unmeasured', uncertifiedReason: reason });
    readM.mockResolvedValue(r);
    const out = await admitWaitRef(ref, { surface: 'blocker' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('wait_ref_unprovable');
    expect(out.reachability).toBe(r);
    expect(out.detail).toContain(`wait ref '${ref}' ${phrase}`);
    expect(out.detail).toContain(WAIT_REF_OPTIONS);
  });

  it('refuses a proving key whose latch already records a fire as wait_ref_already_satisfied', async () => {
    readM.mockResolvedValue(reach({ basis: 'fired', firedAt: '2026-10-26T12:00:00.000Z' }));
    const out = await admitWaitRef('work-item:done:WI-2', { surface: 'blocker' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('wait_ref_already_satisfied');
    expect(out.detail).toContain('already fired (2026-10-26T12:00:00.000Z)');
  });

  it('checks unprovable before already-fired: a fired broad key is still unprovable', async () => {
    readM.mockResolvedValue(reach({ basis: 'fired', firedAt: '2026-10-26T12:00:00.000Z', uncertifiedReason: 'broad' }));
    const out = await admitWaitRef('git-sync:committed', { surface: 'blocker' });
    expect(out.ok ? null : out.code).toBe('wait_ref_unprovable');
  });

  it('refuses a key whose producer announcement was cancelled as wait_ref_unreachable', async () => {
    readM.mockResolvedValue(reach({ verdict: 'impossible', basis: 'cancelled-registration', evidence: 'announcement cancelled' }));
    const out = await admitWaitRef('fleet:alpha:schema-ready', { surface: 'blocker' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('wait_ref_unreachable');
    expect(out.detail).toContain('can no longer fire: announcement cancelled');
  });

  it('fails closed as wait_ref_unmeasured when the reader could not measure (no uncertifiedReason)', async () => {
    readM.mockResolvedValue(reach({ verdict: 'unknown', basis: 'unmeasured', evidence: 'ledger read failed' }));
    const out = await admitWaitRef('work-item:done:WI-3', { surface: 'blocker' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('wait_ref_unmeasured');
    expect(out.detail).toContain('could not be validated (ledger read failed); nothing was written');
  });

  it('a second caller can inject its own reader: the module default is not consulted', async () => {
    const own = vi.fn(async () => reach({ basis: 'fired', firedAt: 't0' }));
    const out = await admitWaitRef('release:deployed:abc123def', { surface: 'park', read: own });
    expect(own).toHaveBeenCalledWith('release:deployed:abc123def', { requireSpecificCondition: true });
    expect(readM).not.toHaveBeenCalled();
    expect(out.ok ? null : out.code).toBe('wait_ref_already_satisfied');
  });

  it('surface words the refusal only: blocker and park give the same verdict for the same ref', async () => {
    readM.mockResolvedValue(reach({ verdict: 'unknown', basis: 'unmeasured', uncertifiedReason: 'broad' }));
    const asBlocker = await admitWaitRef('coord:inbox-wake:su-1', { surface: 'blocker' });
    const asPark = await admitWaitRef('coord:inbox-wake:su-1', { surface: 'park' });
    expect(asBlocker.ok || asPark.ok).toBe(false);
    if (asBlocker.ok || asPark.ok) return;
    expect(asPark.code).toBe(asBlocker.code);
    expect(asBlocker.detail.startsWith("wait ref 'coord:inbox-wake:su-1'")).toBe(true);
    expect(asPark.detail.startsWith("park trigger 'coord:inbox-wake:su-1'")).toBe(true);
    expect(asPark.detail.replace('park trigger', 'wait ref')).toBe(asBlocker.detail);
  });

  it('defaults to the blocker surface when no options are passed', async () => {
    readM.mockResolvedValue(reach({ verdict: 'impossible', basis: 'expired-registration', evidence: 'expired' }));
    const out = await admitWaitRef('fleet:alpha:schema-ready');
    expect(out.ok ? '' : out.detail.startsWith("wait ref 'fleet:alpha:schema-ready'")).toBe(true);
  });
});
