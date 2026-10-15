// @vitest-environment node
/**
 * ScheduleEditor pure-helper tests (scheduled-recurring-plans-2026-06-16 P-020).
 * buildSchedulePayload is the RRULE/payload construction the plans:set-schedule
 * write path depends on; assert it tz-independently (structure + RRULE string).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSchedulePayload,
  describeForm,
  deriveInitialForm,
  parseRrule,
  runScheduleTool,
  type RecurrenceForm,
  type RawSchedule,
} from './ScheduleEditor';

const BASE: RecurrenceForm = {
  mode: 'recurring',
  oneShotAt: '2026-07-01T09:30',
  freq: 'WEEKLY',
  interval: 1,
  weekdays: [],
  startAt: '2026-07-01T09:30',
  until: '',
  tzid: 'America/New_York',
};

describe('buildSchedulePayload', () => {
  it('one-shot ⇒ scheduledAt set, schedule null', () => {
    const p = buildSchedulePayload({ ...BASE, mode: 'one-shot' });
    expect(p.schedule).toBeNull();
    expect(p.scheduledAt).toBeTruthy();
    expect(new Date(p.scheduledAt as string).toISOString()).toBe(p.scheduledAt);
    expect(p.expiresAt).toBeNull();
  });

  it('weekly with weekdays ⇒ FREQ=WEEKLY + BYDAY in canonical order', () => {
    const p = buildSchedulePayload({ ...BASE, freq: 'WEEKLY', weekdays: ['WE', 'MO'] });
    expect(p.schedule?.kind).toBe('rrule');
    expect(p.schedule?.rrule).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE');
    expect(p.schedule?.tzid).toBe('America/New_York');
    expect(p.schedule?.dtstart).toBeTruthy();
    expect(p.scheduledAt).toBeNull();
  });

  it('weekly without weekdays ⇒ no BYDAY (recurs on dtstart weekday)', () => {
    const p = buildSchedulePayload({ ...BASE, freq: 'WEEKLY', weekdays: [] });
    expect(p.schedule?.rrule).toBe('FREQ=WEEKLY;INTERVAL=1');
  });

  it('daily with interval ⇒ FREQ=DAILY;INTERVAL=n', () => {
    const p = buildSchedulePayload({ ...BASE, freq: 'DAILY', interval: 3, weekdays: ['MO'] });
    // BYDAY is weekly-only.
    expect(p.schedule?.rrule).toBe('FREQ=DAILY;INTERVAL=3');
  });

  it('monthly ⇒ FREQ=MONTHLY;INTERVAL=n', () => {
    const p = buildSchedulePayload({ ...BASE, freq: 'MONTHLY', interval: 2 });
    expect(p.schedule?.rrule).toBe('FREQ=MONTHLY;INTERVAL=2');
  });

  it('interval coerces to >=1', () => {
    const p = buildSchedulePayload({ ...BASE, freq: 'DAILY', interval: 0 });
    expect(p.schedule?.rrule).toBe('FREQ=DAILY;INTERVAL=1');
  });

  it('until ⇒ expiresAt end-of-day ISO; absent ⇒ null', () => {
    const withUntil = buildSchedulePayload({ ...BASE, until: '2026-12-31' });
    expect(withUntil.expiresAt).toBeTruthy();
    expect(new Date(withUntil.expiresAt as string).toISOString()).toBe(withUntil.expiresAt);
    const without = buildSchedulePayload({ ...BASE, until: '' });
    expect(without.expiresAt).toBeNull();
  });
});

describe('describeForm', () => {
  it('summarises recurring cadence', () => {
    expect(describeForm({ ...BASE, freq: 'WEEKLY', interval: 1, weekdays: ['MO', 'FR'] })).toContain('every week');
    expect(describeForm({ ...BASE, freq: 'DAILY', interval: 2 })).toContain('every 2 days');
  });

  it('summarises a one-shot', () => {
    expect(describeForm({ ...BASE, mode: 'one-shot' })).toContain('Fires once');
  });
});

describe('parseRrule (D-020 pre-fill)', () => {
  it('round-trips a weekly BYDAY rule', () => {
    expect(parseRrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE')).toEqual({ freq: 'WEEKLY', interval: 2, weekdays: ['MO', 'WE'] });
  });
  it('parses daily/monthly without BYDAY', () => {
    expect(parseRrule('FREQ=DAILY;INTERVAL=3')).toEqual({ freq: 'DAILY', interval: 3, weekdays: [] });
    expect(parseRrule('FREQ=MONTHLY')).toEqual({ freq: 'MONTHLY', interval: 1, weekdays: [] });
  });
  it('drops invalid BYDAY tokens and defaults a missing/garbage FREQ', () => {
    expect(parseRrule('FREQ=WEEKLY;BYDAY=MO,XX,FR')).toEqual({ freq: 'WEEKLY', interval: 1, weekdays: ['MO', 'FR'] });
    expect(parseRrule('nonsense')).toEqual({ freq: 'WEEKLY', interval: 1, weekdays: [] });
  });
  it('is the inverse of buildSchedulePayload for the supported subset', () => {
    const built = buildSchedulePayload({ ...BASE, freq: 'WEEKLY', interval: 2, weekdays: ['MO', 'WE'] });
    expect(parseRrule(built.schedule!.rrule)).toEqual({ freq: 'WEEKLY', interval: 2, weekdays: ['MO', 'WE'] });
  });
});

describe('deriveInitialForm (D-020 pre-fill)', () => {
  const TZ = 'America/New_York';
  it('no initial ⇒ fresh recurring default', () => {
    expect(deriveInitialForm({ tzid: TZ }).mode).toBe('recurring');
  });
  it('initial one-shot ⇒ one-shot mode', () => {
    const initial: RawSchedule = { schedule: null, scheduledAt: '2026-07-01T13:30:00.000Z', expiresAt: null, tzid: TZ };
    const f = deriveInitialForm({ initial, tzid: TZ });
    expect(f.mode).toBe('one-shot');
    expect(f.oneShotAt).toBeTruthy();
  });
  it('initial recurrence ⇒ pre-filled freq/interval/weekdays', () => {
    // Round-trip expiresAt through the production untilToIso (inside buildSchedulePayload)
    // so the `until` date is tz-independent — a raw midnight-UTC instant would resolve to
    // the prior local day in behind-UTC zones (that's correct behaviour, not a bug).
    const built = buildSchedulePayload({ ...BASE, freq: 'WEEKLY', interval: 2, weekdays: ['TU', 'TH'], until: '2026-12-31' });
    const initial: RawSchedule = {
      schedule: { kind: 'rrule', rrule: built.schedule!.rrule, dtstart: built.schedule!.dtstart },
      scheduledAt: null,
      expiresAt: built.expiresAt,
      tzid: TZ,
    };
    const f = deriveInitialForm({ initial, tzid: TZ });
    expect(f.mode).toBe('recurring');
    expect(f.freq).toBe('WEEKLY');
    expect(f.interval).toBe(2);
    expect(f.weekdays).toEqual(['TU', 'TH']);
    expect(f.until).toBe('2026-12-31');
  });
  it('an explicit seedMode (day-click) overrides the existing schedule', () => {
    const initial: RawSchedule = {
      schedule: { kind: 'rrule', rrule: 'FREQ=WEEKLY' },
      scheduledAt: null,
      expiresAt: null,
      tzid: TZ,
    };
    expect(deriveInitialForm({ initial, seedMode: 'one-shot', tzid: TZ }).mode).toBe('one-shot');
  });
});

function stubRunToolPayload(payload: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      ok: true,
      result: { content: [{ text: JSON.stringify(payload) }] },
    }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runScheduleTool payload handling', () => {
  it('rejects a bulk envelope whose request succeeded but whose item was refused', async () => {
    const fetchMock = stubRunToolPayload({
      ok: true,
      results: [{ ok: false, slug: 'blocked-plan', error: 'plan_inputs_not_ready', detail: 'Set required inputs first' }],
      counts: { ok: 0, failed: 1 },
    });

    await expect(runScheduleTool('plans:arm-schedule', { slug: 'blocked-plan' }))
      .resolves.toEqual({ ok: false, message: 'Set required inputs first' });
    expect(fetchMock).toHaveBeenCalledWith('/api/agent-mcp/run-tool', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        name: 'plans:arm-schedule',
        args: { slug: 'blocked-plan' },
        confirmed: true,
      }),
    }));
  });

  it('rejects failed counts even when a legacy envelope omits item rows', async () => {
    stubRunToolPayload({ ok: true, counts: { ok: 0, failed: 2 } });

    await expect(runScheduleTool('plans:arm-schedule', { slug: 'blocked-plan' }))
      .resolves.toEqual({ ok: false, message: '2 tool items failed' });
  });

  it('preserves direct errors and accepts a genuinely green bulk result', async () => {
    stubRunToolPayload({ ok: false, error: 'not_found', detail: 'Plan not found' });
    await expect(runScheduleTool('plans:arm-schedule', { slug: 'missing-plan' }))
      .resolves.toEqual({ ok: false, message: 'Plan not found' });

    stubRunToolPayload({
      ok: true,
      results: [{ ok: true, slug: 'ready-plan' }],
      counts: { ok: 1, failed: 0 },
    });
    await expect(runScheduleTool('plans:arm-schedule', { slug: 'ready-plan' }))
      .resolves.toEqual({ ok: true, data: {
        ok: true, results: [{ ok: true, slug: 'ready-plan' }], counts: { ok: 1, failed: 0 },
      } });
  });
});
