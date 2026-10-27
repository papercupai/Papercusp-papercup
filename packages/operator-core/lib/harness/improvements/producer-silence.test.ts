import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { LEARNING_PRODUCERS } from '../../experiment/lifecycle-adapter';
import {
  ANY_POT,
  msOf,
  PRODUCER_SILENCE_PROBES,
  producerSilenceNote,
  producerSilenceVerdict,
  type ProducerSilenceFacts,
} from './producer-silence';

describe('msOf — a probe max(timestamptz) in every shape the transport returns', () => {
  // Regression 2026-10-08: Number('<pg text timestamp>') is NaN, so every real producer output
  // read as "never produced" and all five learning producers raised a false silence alarm.
  const at = Date.UTC(2026, 9, 8, 16, 0, 0, 123);
  it('parses a Postgres text timestamptz with a session offset to the right instant', () => {
    expect(msOf('2026-10-08 12:00:00.123-04')).toBe(at);
    expect(msOf('2026-10-08 16:00:00.123+00')).toBe(at);
  });
  it('parses Date, ISO text, epoch numbers, bigint and numeric text', () => {
    expect(msOf(new Date(at))).toBe(at);
    expect(msOf(new Date(at).toISOString())).toBe(at);
    expect(msOf(at)).toBe(at);
    expect(msOf(BigInt(at))).toBe(at);
    expect(msOf(String(at))).toBe(at);
  });
  it('returns null for absent or unparseable values, never a fake instant', () => {
    expect(msOf(null)).toBeNull();
    expect(msOf(undefined)).toBeNull();
    expect(msOf('not a time')).toBeNull();
    expect(msOf(new Date(NaN))).toBeNull();
  });
});

const NOW = Date.parse('2026-10-08T15:00:00Z');
const H = 3_600_000;

function facts(over: Partial<ProducerSilenceFacts> = {}): ProducerSilenceFacts {
  return {
    nowMs: NOW,
    loops: [],
    potScopes: [],
    routines: [],
    lastOutputMs: new Map(),
    ...over,
  };
}

const loop = (loopId: string, potSlug: string | null = 'papercusp', enabled = true) => ({ loopId, potSlug, enabled });

describe('producerSilenceVerdict', () => {
  it('passes a producer whose last output is inside its threshold', () => {
    const v = producerSilenceVerdict(facts({
      loops: [loop('blender:papercusp')],
      lastOutputMs: new Map([['scout:papercusp', NOW - 2 * H]]),
    }));
    expect(v.signals).toEqual([]);
    expect(v.checked).toEqual([{ producer: 'scout', pot: 'papercusp', loopId: 'blender:papercusp', disposition: 'producing' }]);
  });

  it('files a kind=bug major signal for an active producer silent past its threshold', () => {
    const v = producerSilenceVerdict(facts({
      loops: [loop('blender:papercusp')],
      routines: [{ name: 'bp-singleton-scout-0', installSlug: '@singleton', active: true }],
      lastOutputMs: new Map([['scout:papercusp', NOW - 30 * H]]),
    }));
    expect(v.signals).toHaveLength(1);
    const s = v.signals[0];
    expect(s).toMatchObject({
      source: 'producer-silence',
      key: 'producer-silence:scout:papercusp',
      title: 'Learning producer scout has gone silent on pot papercusp',
      severity: 'major',
      kind: 'bug',
      scope: 'harness:papercusp',
      findingClass: 'learning-slo:producer-silence',
    });
    expect(s.body).toContain('last produced 30.0h ago');
    expect(s.body).toContain("its 'bp-singleton-scout-0' routine is active");
  });

  it('does not flag Scout silence when every tick in the window was explicitly deep-throttle gated', () => {
    const v = producerSilenceVerdict(facts({
      loops: [loop('blender:papercusp')],
      routines: [{ name: 'bp-singleton-scout-0', installSlug: '@singleton', active: true }],
      lastOutputMs: new Map([['scout:papercusp', NOW - 30 * H]]),
      intentionalSilence: new Map([['scout:papercusp', 'all 48 Scout ticks were deep-throttle gated']]),
    }));
    expect(v.signals).toEqual([]);
    expect(v.checked).toEqual([
      { producer: 'scout', pot: 'papercusp', loopId: 'blender:papercusp', disposition: 'intentionally-gated' },
    ]);
    expect(producerSilenceNote(v)).toContain('intentionally-gated=1');
  });

  it('still flags silence without complete-window gating evidence', () => {
    const v = producerSilenceVerdict(facts({
      loops: [loop('blender:papercusp')],
      lastOutputMs: new Map([['scout:papercusp', NOW - 30 * H]]),
    }));
    expect(v.signals).toHaveLength(1);
    expect(v.checked[0]?.disposition).toBe('silent');
  });

  it('keeps the title stable across ticks (no counts or ages in it)', () => {
    const at = (age: number) => producerSilenceVerdict(facts({
      loops: [loop('blender:papercusp')],
      lastOutputMs: new Map([['scout:papercusp', NOW - age * H]]),
    })).signals[0]?.title;
    expect(at(30)).toBe(at(300));
  });

  it('reports a producer that never produced, and names an absent driving routine', () => {
    const v = producerSilenceVerdict(facts({ loops: [loop('regret-mining')] }));
    expect(v.signals).toHaveLength(1);
    expect(v.signals[0].body).toContain('has never produced');
    expect(v.signals[0].body).toContain("no 'bp-singleton-regret-0' routine row exists");
  });

  it('exempts a producer whose driving routine is explicitly inactive (the #1558 gym pause)', () => {
    const v = producerSilenceVerdict(facts({
      loops: [loop('gym:papercusp')],
      routines: [{ name: 'gym-cycle', installSlug: 'papercusp', active: false }],
      lastOutputMs: new Map([['gym:papercusp', NOW - 41 * 24 * H]]),
    }));
    expect(v.signals).toEqual([]);
    expect(v.checked[0].disposition).toBe('routine-inactive');
  });

  it('matches a per-pot routine on its own pot only', () => {
    const v = producerSilenceVerdict(facts({
      loops: [loop('gym:papercusp')],
      routines: [{ name: 'gym-cycle', installSlug: 'other-pot', active: false }],
      hints: new Map([['gym:papercusp', 'gym_autoloop_config.budget_usd is NULL']]),
    }));
    expect(v.checked[0].disposition).toBe('silent');
    expect(v.signals[0].body).toContain('Likely cause: gym_autoloop_config.budget_usd is NULL');
  });

  it('exempts a producer-specific off switch', () => {
    const v = producerSilenceVerdict(facts({
      loops: [loop('gym:papercusp')],
      switchedOff: new Map([['gym:papercusp', 'gym_autoloop_config.enabled is false']]),
    }));
    expect(v.signals).toEqual([]);
    expect(v.checked[0].disposition).toBe('switched-off');
  });

  it('never judges an unmeasured producer silent', () => {
    const v = producerSilenceVerdict(facts({ loops: [loop('red-queen')], unmeasured: new Set(['red-queen']) }));
    expect(v.signals).toEqual([]);
    expect(v.checked[0].disposition).toBe('unmeasured');
  });

  it('skips disabled governor loops entirely', () => {
    const v = producerSilenceVerdict(facts({ loops: [loop('gym:calendar', 'calendar', false)] }));
    expect(v.checked).toEqual([]);
    expect(v.signals).toEqual([]);
  });

  it('reads a workspace-level producer from its ANY_POT output', () => {
    const v = producerSilenceVerdict(facts({
      loops: [loop('red-queen')],
      lastOutputMs: new Map([[`red-queen:${ANY_POT}`, NOW - 5 * H]]),
    }));
    expect(v.checked[0]).toMatchObject({ producer: 'red-queen', pot: 'papercusp', disposition: 'producing' });
  });

  it('honours a per-producer threshold override', () => {
    const f = facts({ loops: [loop('blender:papercusp')], lastOutputMs: new Map([['scout:papercusp', NOW - 30 * H]]) });
    expect(producerSilenceVerdict(f, { producerSilenceHours: { scout: 48 } }).signals).toEqual([]);
  });

  describe('the pot learning switch', () => {
    const offUnexplained = { potSlug: 'recipe-app', enabled: false, pauseReason: null, ownerDirected: false, reviewBy: null };

    it('files one kind=change signal per unexplained-off pot and exempts its producers', () => {
      const v = producerSilenceVerdict(facts({
        loops: [loop('blender:recipe-app', 'recipe-app'), loop('gym:recipe-app', 'recipe-app')],
        potScopes: [offUnexplained],
      }));
      expect(v.signals).toHaveLength(1);
      expect(v.signals[0]).toMatchObject({
        key: 'producer-silence:pot-switch:recipe-app',
        kind: 'change',
        severity: 'minor',
        scope: 'harness:recipe-app',
      });
      expect(v.checked.map((c) => c.disposition)).toEqual(['pot-paused', 'pot-paused']);
    });

    it('flags an unexplained-off pot even when only unprobed loops target it', () => {
      const v = producerSilenceVerdict(facts({ loops: [loop('dream:recipe-app', 'recipe-app')], potScopes: [offUnexplained] }));
      expect(v.unprobedLoops).toEqual(['dream:recipe-app']);
      expect(v.signals.map((s) => s.key)).toEqual(['producer-silence:pot-switch:recipe-app']);
    });

    it('stays quiet on a deliberate pause until its review date passes', () => {
      const paused = { potSlug: 'crm', enabled: false, pauseReason: 'owner directive #42', ownerDirected: true, reviewBy: NOW + H };
      const quiet = producerSilenceVerdict(facts({ loops: [loop('blender:crm', 'crm')], potScopes: [paused] }));
      expect(quiet.signals).toEqual([]);
      const overdue = producerSilenceVerdict(facts({
        loops: [loop('blender:crm', 'crm')],
        potScopes: [{ ...paused, reviewBy: NOW - H }],
      }));
      expect(overdue.signals.map((s) => s.key)).toEqual(['producer-silence:pot-review:crm']);
    });
  });

  it('reports coverage in the tick note so a quiet tick is never read as nothing checked', () => {
    const v = producerSilenceVerdict(facts({
      loops: [loop('blender:papercusp'), loop('fleet-ekg')],
      lastOutputMs: new Map([['scout:papercusp', NOW - H]]),
    }));
    expect(producerSilenceNote(v)).toBe('checked 1 producer×pot (producing=1); unprobed loops 1');
  });

  describe('su-ideate dead passes (plan D-010)', () => {
    const circuit = { harnessSlug: 'email', attempts: 3, lastPassMs: null, lastLaunchMs: NOW - 3 * H };

    it('raises an open circuit as a major bug signal scoped to its harness', () => {
      const v = producerSilenceVerdict(facts({ suIdeateCircuits: { harnessesChecked: 2, open: [circuit] } }));
      expect(v.signals).toEqual([
        expect.objectContaining({
          source: 'producer-silence',
          key: 'producer-silence:su-ideate-circuit:email',
          severity: 'major',
          kind: 'bug',
          scope: 'harness:email',
          findingClass: 'learning-slo:producer-silence',
        }),
      ]);
      expect(v.signals[0].body).toContain('launched 3 pass(es)');
      expect(v.signals[0].body).toContain('never recorded a pass');
      expect(v.suIdeate).toEqual({ harnessesChecked: 2, openCircuits: ['email'] });
      expect(producerSilenceNote(v)).toBe('checked 0 producer×pot (none); unprobed loops 0; su-ideate circuits open 1 of 2 launched harness(es)');
    });

    it('closed circuits raise nothing but still report coverage', () => {
      const v = producerSilenceVerdict(facts({ suIdeateCircuits: { harnessesChecked: 4, open: [] } }));
      expect(v.signals).toEqual([]);
      expect(producerSilenceNote(v)).toContain('su-ideate circuits open 0 of 4 launched harness(es)');
    });

    it('a failed circuit read is unmeasured: no signal, and the note says so (never a quiet pass)', () => {
      const v = producerSilenceVerdict(facts({ suIdeateCircuits: 'unmeasured' }));
      expect(v.signals).toEqual([]);
      expect(v.suIdeate).toBe('unmeasured');
      expect(producerSilenceNote(v)).toContain('su-ideate circuits unmeasured');
    });
  });
});

describe('PRODUCER_SILENCE_PROBES', () => {
  it('has a probe for every learning producer and claims only its own loops', () => {
    expect(Object.keys(PRODUCER_SILENCE_PROBES).sort()).toEqual([...LEARNING_PRODUCERS].sort());
    const claims = (id: string) =>
      LEARNING_PRODUCERS.filter((p) => PRODUCER_SILENCE_PROBES[p].loopPot(id, 'papercusp') !== null);
    expect(claims('blender:papercusp')).toEqual(['scout']);
    expect(claims('gym:papercusp')).toEqual(['gym']);
    expect(claims('red-queen')).toEqual(['red-queen']);
    expect(claims('regret-mining')).toEqual(['regret']);
    expect(claims('calibration-markets')).toEqual(['calibration']);
    expect(claims('frontier:transfer-harness')).toEqual(['transfer']);
    expect(claims('dream:papercusp')).toEqual([]);
    expect(claims('blender:')).toEqual([]);
  });
});

describe('calibration producer silence activity', () => {
  const probe = PRODUCER_SILENCE_PROBES.calibration;

  it('counts a resolved prediction as calibration activity', async () => {
    const queries: string[] = [];
    const resolvedAt = new Date('2026-10-21T04:50:06.000Z');
    const sql = (async (parts: TemplateStringsArray) => {
      queries.push(parts.join('?'));
      return [{ last: resolvedAt }];
    }) as unknown as Sql;

    const output = await probe.readLastOutput(sql, 'ws');

    expect(output).toEqual(new Map([[ANY_POT, resolvedAt.getTime()]]));
    expect(queries[0]).toMatch(/greatest\s*\(\s*max\(created_at\)\s*,\s*max\(resolved_at\)/i);
  });

  it('does not report silence when there is no matured unresolved work', async () => {
    const queries: string[] = [];
    const params: unknown[][] = [];
    const sql = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
      queries.push(parts.join('?'));
      params.push(values);
      return [{ has_due: false }];
    }) as unknown as Sql;
    const readIntentionalSilence = probe.readIntentionalSilence;

    expect(readIntentionalSilence).toBeTypeOf('function');
    if (!readIntentionalSilence) return;

    const probeSilence = await readIntentionalSilence(sql, 'ws', NOW);
    const query = queries[0]?.toLowerCase() ?? '';
    expect(query).toContain('resolved_at is null');
    expect(query).toContain('horizon_ts <=');
    expect(params[0]).toContain(new Date(NOW).toISOString());
    expect(probeSilence.get(ANY_POT)).toBe('no matured unresolved calibration predictions are due');

    const verdict = producerSilenceVerdict(facts({
      loops: [loop('calibration-markets', 'papercusp')],
      routines: [{ name: 'bp-singleton-calibration-0', installSlug: '@singleton', active: true }],
      lastOutputMs: new Map([['calibration:papercusp', NOW - 8 * 24 * H]]),
      intentionalSilence: new Map([['calibration:' + ANY_POT, probeSilence.get(ANY_POT)!]]),
    }));

    expect(verdict.signals).toEqual([]);
    expect(verdict.checked[0]?.disposition).toBe('intentionally-gated');
  });

  it('keeps the alert when matured unresolved work is due', async () => {
    const sql = (async () => [{ has_due: true }]) as unknown as Sql;
    const readIntentionalSilence = probe.readIntentionalSilence;

    expect(readIntentionalSilence).toBeTypeOf('function');
    if (!readIntentionalSilence) return;

    const intentionalSilence = await readIntentionalSilence(sql, 'ws', NOW);
    const verdict = producerSilenceVerdict(facts({
      loops: [loop('calibration-markets', 'papercusp')],
      routines: [{ name: 'bp-singleton-calibration-0', installSlug: '@singleton', active: true }],
      lastOutputMs: new Map([['calibration:papercusp', NOW - 8 * 24 * H]]),
      intentionalSilence,
    }));

    expect(intentionalSilence).toEqual(new Map());
    expect(verdict.signals).toHaveLength(1);
    expect(verdict.checked[0]?.disposition).toBe('silent');
  });
});
