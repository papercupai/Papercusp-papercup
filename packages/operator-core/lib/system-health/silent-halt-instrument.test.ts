import { describe, expect, it } from 'vitest';
import { AGENT_STRANDED_ALARM_THRESHOLD } from './agent-strand-census';
import {
  SILENT_HALT_STRANDED_INSTRUMENT_KEY,
  measureSilentHaltStranded,
  silentHaltStrandedVerdict,
  type SilentHaltStrandedReading,
} from './silent-halt-instrument';
import { getRegisteredInstrument } from '../rubric-instrument-registry';

const owners = (n: number) => Array.from({ length: n }, (_, i) => `su-${String(i).padStart(3, '0')}`);
const reading = (halted: string[], wakeOnly: string[] = [], checked = halted.length + 3): SilentHaltStrandedReading => ({
  checked, halted, wakeOnly,
});

describe('silentHaltStrandedVerdict', () => {
  it('passes below the alarm threshold and fails at it (one shared bar with agents-stranded)', () => {
    expect(silentHaltStrandedVerdict(reading(owners(0))).verdict).toBe('pass');
    expect(silentHaltStrandedVerdict(reading(owners(AGENT_STRANDED_ALARM_THRESHOLD - 1))).verdict).toBe('pass');
    expect(silentHaltStrandedVerdict(reading(owners(AGENT_STRANDED_ALARM_THRESHOLD))).verdict).toBe('fail');
    expect(silentHaltStrandedVerdict(reading(owners(180))).verdict).toBe('fail');
  });

  it('counts distinct owners and reports the measured value in the detail', () => {
    const r = silentHaltStrandedVerdict(reading(['su-b', 'su-a', 'su-b'], ['su-a', 'su-z'], 40));
    const detail = JSON.parse(r.detail);
    expect(detail).toMatchObject({ stranded: 2, wakeOnly: 1, checked: 40, threshold: AGENT_STRANDED_ALARM_THRESHOLD });
    expect(detail.sample).toEqual(['su-a', 'su-b']);
  });

  it('reports unknown, never a zero pass, when the sweep gave no reading', () => {
    const r = silentHaltStrandedVerdict(null, 'boom');
    expect(r.verdict).toBe('unknown');
    expect(JSON.parse(r.detail)).toEqual({ unknown: 'boom' });
    expect(r.detail).not.toMatch(/stranded/);
  });
});

describe('measureSilentHaltStranded', () => {
  it('measures the sweep reading for the requested workspace', async () => {
    const seen: string[] = [];
    const r = await measureSilentHaltStranded({ workspaceId: 'ws-1' }, {
      readSweep: async (ws) => { seen.push(ws); return reading(owners(7)); },
    });
    expect(seen).toEqual(['ws-1']);
    expect(r.verdict).toBe('fail');
    expect(JSON.parse(r.detail).stranded).toBe(7);
  });

  it('turns a failed sweep read into unknown with the error named', async () => {
    const r = await measureSilentHaltStranded({ workspaceId: 'ws-1' }, {
      readSweep: async () => { throw new Error('pg down'); },
    });
    expect(r.verdict).toBe('unknown');
    expect(r.detail).toMatch(/pg down/);
  });
});

describe('registry binding', () => {
  it('is a scheduled workspace-scoped platform instrument', () => {
    const instrument = getRegisteredInstrument(SILENT_HALT_STRANDED_INSTRUMENT_KEY);
    expect(instrument?.evaluator).toBe('platform');
    if (instrument?.evaluator !== 'platform') throw new Error('expected platform instrument');
    expect(instrument.rescore).toMatchObject({ unit: 'count', scope: 'workspace', windowMs: 60 * 60_000 });
  });
});
