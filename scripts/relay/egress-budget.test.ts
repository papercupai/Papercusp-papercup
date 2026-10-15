/**
 * Egress budget state transitions for the blind-relay VM (WI-10004956).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { advanceEgress, monthKey, parseProcNetDevTx, readEgressState, writeEgressState } from './egress-budget';

const DEV = [
  'Inter-|   Receive                                                |  Transmit',
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
  '    lo:  700 7 0 0 0 0 0 0  700 7 0 0 0 0 0 0',
  '  ens4: 99252917 192856 0 0 0 0 0 0 34391452 189588 0 0 0 0 0 0',
  'docker0: 10 1 0 0 0 0 0 0 20 2 0 0 0 0 0 0',
].join('\n');

describe('parseProcNetDevTx', () => {
  it('sums transmit bytes of every non-loopback interface', () => {
    expect(parseProcNetDevTx(DEV)).toBe(34391452 + 20);
  });
  it('counts only the named interface when one is given', () => {
    expect(parseProcNetDevTx(DEV, 'ens4')).toBe(34391452);
  });
  it('throws instead of reading a missing interface as zero usage', () => {
    expect(() => parseProcNetDevTx(DEV, 'eth0')).toThrow(/eth0/);
    expect(() => parseProcNetDevTx('Inter-|\n    lo: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0')).toThrow(/non-loopback/);
  });
});

describe('advanceEgress', () => {
  const at = (iso: string) => new Date(iso);
  it('takes the first observation as the baseline and charges nothing', () => {
    const t = advanceEgress(null, 5_000, at('2026-10-01T00:00:00Z'), 1_000);
    expect(t).toEqual({ state: { month: '2026-10', usedBytes: 0, lastTxBytes: 5_000 }, deltaBytes: 0, monthRolled: false, overBudget: false });
  });
  it('charges the counter delta and flags the month over budget at the boundary', () => {
    const prev = { month: '2026-10', usedBytes: 400, lastTxBytes: 5_000 };
    expect(advanceEgress(prev, 5_599, at('2026-10-09T00:00:00Z'), 1_000).overBudget).toBe(false);
    const t = advanceEgress(prev, 5_600, at('2026-10-09T00:00:00Z'), 1_000);
    expect(t.state.usedBytes).toBe(1_000);
    expect(t.deltaBytes).toBe(600);
    expect(t.overBudget).toBe(true);
  });
  it('charges everything since a reboot when the kernel counter went down', () => {
    const prev = { month: '2026-10', usedBytes: 400, lastTxBytes: 9_000_000 };
    const t = advanceEgress(prev, 250, at('2026-10-09T00:00:00Z'), 1_000);
    expect(t.deltaBytes).toBe(250);
    expect(t.state.usedBytes).toBe(650);
  });
  it('restarts usage in a new UTC month', () => {
    const prev = { month: '2026-10', usedBytes: 2_000, lastTxBytes: 100 };
    const t = advanceEgress(prev, 130, at('2026-11-01T00:00:01Z'), 1_000);
    expect(t).toEqual({ state: { month: '2026-11', usedBytes: 30, lastTxBytes: 130 }, deltaBytes: 30, monthRolled: true, overBudget: false });
  });
  it('never flags over budget when the guard is off (budget 0)', () => {
    expect(advanceEgress({ month: '2026-10', usedBytes: 9e15, lastTxBytes: 0 }, 1, at('2026-10-02T00:00:00Z'), 0).overBudget).toBe(false);
  });
  it('uses the UTC month, not local time', () => {
    expect(monthKey(at('2026-10-31T23:59:59Z'))).toBe('2026-10');
    expect(monthKey(at('2026-11-01T00:00:00Z'))).toBe('2026-11');
  });
});

describe('egress state file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'egress-state-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips, and a missing file reads as no state', () => {
    const f = join(dir, 'state.json');
    expect(readEgressState(f)).toBeNull();
    writeEgressState(f, { month: '2026-10', usedBytes: 12, lastTxBytes: 34 });
    expect(readEgressState(f)).toEqual({ month: '2026-10', usedBytes: 12, lastTxBytes: 34 });
  });
  it('refuses a malformed file instead of silently resetting the month', () => {
    const f = join(dir, 'bad.json');
    writeFileSync(f, JSON.stringify({ month: 'October', usedBytes: 1, lastTxBytes: 2 }));
    expect(() => readEgressState(f)).toThrow(/malformed/);
  });
});
