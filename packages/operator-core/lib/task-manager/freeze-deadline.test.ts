import { describe, expect, it } from 'vitest';
import {
  findInnerTimeouts,
  ledgerDeadline,
  reportFreezeDeadlines,
  THAW_LOW_BUDGET_SEC,
} from './freeze-deadline';

const NOW = Date.parse('2026-10-01T18:00:00.000Z');
const iso = (offsetSec: number) => new Date(NOW + offsetSec * 1000).toISOString();

describe('findInnerTimeouts — GNU timeout wrapper in the stored command line', () => {
  it('reads the EI-24796665684871321 incident shape: `timeout -k 30 1800 <cmd>`', () => {
    const hits = findInnerTimeouts(['bash', '-o', 'pipefail', '-c', 'timeout -k 30 1800 gitnexus analyze --force']);
    expect(hits).toEqual([{ seconds: 1800, matched: 'timeout -k 30 1800' }]);
  });

  it('converts s/m/h/d suffixes and defaults a bare number to seconds', () => {
    const secs = (cmd: string) => findInnerTimeouts(['bash', '-c', cmd]).map((h) => h.seconds);
    expect(secs('timeout 90 x')).toEqual([90]);
    expect(secs('timeout 30m x')).toEqual([1800]);
    expect(secs('timeout 2h x')).toEqual([7200]);
    expect(secs('timeout 1d x')).toEqual([86400]);
    expect(secs('timeout 1.5m x')).toEqual([90]);
  });

  it('consumes value-taking options so the option value is not read as the duration', () => {
    // `-k 30` / `--kill-after=30` / `-s KILL` carry a value; `--foreground` does not.
    const secs = (cmd: string) => findInnerTimeouts(['bash', '-c', cmd]).map((h) => h.seconds);
    expect(secs('timeout --kill-after=30 --foreground 2h x')).toEqual([7200]);
    expect(secs('timeout -s KILL -k 5 600 x')).toEqual([600]);
    expect(secs('/usr/bin/timeout 45 x')).toEqual([45]);
  });

  it('finds every wrapper in a multi-stage command', () => {
    const hits = findInnerTimeouts(['bash', '-c', 'timeout 60 a && timeout -k 10 120 b | timeout 5 c']);
    expect(hits.map((h) => h.seconds)).toEqual([60, 120, 5]);
  });

  it('does NOT match lookalikes: mid-word, prose, assignments, zero, or no duration', () => {
    const none = (cmd: string) => expect(findInnerTimeouts(['bash', '-c', cmd])).toEqual([]);
    none('mytimeout 5 x');
    none('echo a timeout of 5 seconds');
    none('timeout=5 ./run');
    none('timeout 0 x'); // GNU: 0 disables the timeout
    none('timeout --help');
    none('sleep 5');
  });

  it('is empty for missing/empty argv, and bounds the scan on a huge command', () => {
    expect(findInnerTimeouts(null)).toEqual([]);
    expect(findInnerTimeouts(undefined)).toEqual([]);
    expect(findInnerTimeouts([])).toEqual([]);
    // A wrapper sitting past the 64 KiB scan bound is deliberately not found — the scan
    // is bounded so a pathological command cannot stall a freeze. Positive control: the
    // same wrapper inside the bound IS found, so the empty result is the bound, not a
    // broken pattern.
    const filler = 'x'.repeat(70 * 1024);
    expect(findInnerTimeouts(['bash', '-c', `${filler} timeout 30 y`])).toEqual([]);
    expect(findInnerTimeouts(['bash', '-c', `timeout 30 y ${filler}`])).toHaveLength(1);
  });
});

describe('ledgerDeadline', () => {
  it('is null with no deadline, or one that does not parse', () => {
    expect(ledgerDeadline({}, NOW)).toBeNull();
    expect(ledgerDeadline({ deadlineAt: null }, NOW)).toBeNull();
    expect(ledgerDeadline({ deadlineAt: 'not-a-date' }, NOW)).toBeNull();
  });

  it('reports whole seconds left, and expiry', () => {
    expect(ledgerDeadline({ deadlineAt: iso(90.9) }, NOW)).toEqual({
      deadlineAt: iso(90.9),
      remainingSec: 90,
      expired: false,
    });
    expect(ledgerDeadline({ deadlineAt: iso(-5) }, NOW)).toMatchObject({ remainingSec: 0, expired: true });
    expect(ledgerDeadline({ deadlineAt: iso(0) }, NOW)).toMatchObject({ remainingSec: 0, expired: true });
  });
});

describe('reportFreezeDeadlines', () => {
  it('FREEZE with a live ledger deadline warns that the clock keeps running', () => {
    const r = reportFreezeDeadlines({ deadlineAt: iso(50) }, NOW, 'freeze');
    expect(r.ledgerDeadline).toMatchObject({ remainingSec: 50, expired: false });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('KEEPS RUNNING');
    expect(r.warnings[0]).toContain('processes:kill');
  });

  it('FREEZE of an already-expired task says the freeze saves nothing', () => {
    const r = reportFreezeDeadlines({ deadlineAt: iso(-1) }, NOW, 'freeze');
    expect(r.ledgerDeadline?.expired).toBe(true);
    expect(r.warnings[0]).toContain('ALREADY passed');
  });

  it('THAW warns only when the remaining ledger budget is low or gone', () => {
    const low = reportFreezeDeadlines({ deadlineAt: iso(THAW_LOW_BUDGET_SEC) }, NOW, 'thaw');
    expect(low.warnings[0]).toContain('frozen time counted against it');
    const gone = reportFreezeDeadlines({ deadlineAt: iso(-30) }, NOW, 'thaw');
    expect(gone.warnings[0]).toContain('passed while it was frozen');
    // Positive control for the two above: plenty of budget stays silent — and the
    // deadline is still reported, so silence is a verdict, not a missing read.
    const ok = reportFreezeDeadlines({ deadlineAt: iso(THAW_LOW_BUDGET_SEC + 600) }, NOW, 'thaw');
    expect(ok.warnings).toEqual([]);
    expect(ok.ledgerDeadline).not.toBeNull();
  });

  it('FREEZE of the incident command flags the inner GNU timeout as a heuristic', () => {
    const r = reportFreezeDeadlines(
      { argv: ['bash', '-o', 'pipefail', '-c', 'timeout -k 30 1800 gitnexus analyze'], startedAt: iso(-60) },
      NOW,
      'freeze',
    );
    expect(r.ledgerDeadline).toBeNull();
    expect(r.innerTimeouts).toEqual([{ seconds: 1800, matched: 'timeout -k 30 1800' }]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('HEURISTIC');
    expect(r.warnings[0]).toContain('SIGTERM');
  });

  it('carries BOTH warnings when the ledger deadline and an inner wrapper coexist', () => {
    const r = reportFreezeDeadlines(
      { deadlineAt: iso(600), argv: ['bash', '-c', 'timeout 1800 build'] },
      NOW,
      'freeze',
    );
    expect(r.warnings).toHaveLength(2);
  });

  it('a task with no wall-clock deadline of either kind has NO warnings (and a freeze stays unqualified)', () => {
    const r = reportFreezeDeadlines({ argv: ['bash', '-c', 'npm test'] }, NOW, 'freeze');
    expect(r).toEqual({ ledgerDeadline: null, innerTimeouts: [], warnings: [] });
  });
});
