import { describe, expect, it } from 'vitest';
import { assertProducerBuildIdentity, verifyEngineeringJourneySources } from './engineering-evidence-producer';

describe('engineering journey source preflight', () => {
  const pins = ['one.ts', 'two.ts', 'three.ts'].map(path => ({ path, sha256: 'a'.repeat(64) }));
  const accepted = { acceptedSource: { matches: true, runtimeContainment: { 'staging-operator': true } } };

  it('starts every pin read before waiting, and joins them before the final health check', async () => {
    const pending: (() => void)[] = [];
    const events: string[] = [];
    const run = verifyEngineeringJourneySources({ pins, runtime: 'staging-operator',
      health: async () => { events.push('health'); return 'selected'; },
      read: async pin => { events.push(pin.path); await new Promise<void>(resolve => pending.push(resolve)); return accepted; } });
    await Promise.resolve();
    expect(events).toEqual(['health', 'one.ts', 'two.ts', 'three.ts']);
    pending.forEach(resolve => resolve());
    await run;
    expect(events.at(-1)).toBe('health');
    expect(events.filter(event => event === 'health')).toHaveLength(2);
  });

  it.each(['source-mismatch', 'wrong-runtime', 'read-failure'])(
    'refuses %s while retaining the outcome of every pin', async failure => {
      const readings: { path: string; status: string }[] = [];
      await expect(verifyEngineeringJourneySources({ pins, runtime: 'staging-operator',
        health: async () => 'selected', retain: reading => readings.push(reading),
        read: async pin => {
          if (pin.path !== 'two.ts') return accepted;
          if (failure === 'read-failure') throw new Error('reader refused');
          return { acceptedSource: { matches: failure !== 'source-mismatch',
            runtimeContainment: { 'staging-operator': failure !== 'wrong-runtime' } } };
        } })).rejects.toThrow('source preflight failed');
      expect(readings.map(reading => reading.path).sort()).toEqual(pins.map(pin => pin.path).sort());
      expect(readings.find(reading => reading.path === 'two.ts')?.status).toBe('fail');
    });

  it('refuses a runtime transition even when every source pin matches', async () => {
    let healthReads = 0;
    await expect(verifyEngineeringJourneySources({ pins, runtime: 'staging-operator',
      health: async () => ++healthReads === 1 ? 'selected' : 'replacement', read: async () => accepted }))
      .rejects.toThrow('runtime changed');
  });

  it('refuses an empty source census', async () => {
    await expect(verifyEngineeringJourneySources({ pins: [], runtime: 'staging-operator',
      health: async () => 'selected', read: async () => accepted })).rejects.toThrow('requires source pins');
  });
});

describe('engineering live producer source identity', () => {
  const selected = 'b0b5d23760' + 'a'.repeat(30);

  it('ee.producer-build: accepts the exact committed source with a matching or absent reporter stamp', () => {
    expect(() => assertProducerBuildIdentity(selected, selected)).not.toThrow();
    expect(() => assertProducerBuildIdentity(selected, selected, ' ' + selected + ' ')).not.toThrow();
    const sha256 = 'b'.repeat(64);
    expect(() => assertProducerBuildIdentity(sha256, sha256)).not.toThrow();
  });

  it('ee.producer-build-mismatch: refuses a different runner even when the selected build and reporter stamp agree', () => {
    expect(() => assertProducerBuildIdentity(selected, '67228bbb71' + '6'.repeat(30), selected))
      .toThrow('--ref=' + selected);
    expect(() => assertProducerBuildIdentity(selected, selected.slice(0, 10) + 'f'.repeat(30)))
      .toThrow('exact selected serving commit');
  });

  it('ee.producer-build-unknown: refuses missing, abbreviated or malformed source identity', () => {
    for (const runner of [null, '', selected.slice(0, 10), 'z'.repeat(40)])
      expect(() => assertProducerBuildIdentity(selected, runner)).toThrow('exact selected serving commit');
    expect(() => assertProducerBuildIdentity(selected.slice(0, 10), selected)).toThrow();
  });

  it('ee.producer-reporter-mismatch: refuses a stamp that would record another commit', () => {
    expect(() => assertProducerBuildIdentity(selected, selected, 'c'.repeat(40)))
      .toThrow('test runner and reporter');
  });
});
