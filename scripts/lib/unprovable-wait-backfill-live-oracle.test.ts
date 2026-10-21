import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG } from '../../packages/operator-core/lib/events/await/catalog';
import { ANY_FAMILY_TERMINAL_STATES } from '../../packages/operator-core/lib/work-item-dispatch-states';
import {
  judgeR12,
  parseR12Row,
  probeConditionFamilies,
  probeTerminalStates,
} from './unprovable-wait-backfill-live-oracle.mjs';

// AUTO-BAR-R-12-P-006@3 (event-wait-settlement-2026-10-20): the live probe's oracle, and the pins that keep
// the probe's literal lists equal to the code they restate.
const PROBE = resolve(__dirname, '../../docs/evidence/ews-p006-r12-backfill-live/probe.sql');

// active|stamped|concrete|announced_live|announced_fired|unprovable|backfill_rows|backfill_cleared|unattributed
const GOOD = '404|344|51|9|0|0|299|0|0';
const failing = (line: string) =>
  judgeR12(parseR12Row(line))
    .assertions.filter((a) => !a.passed)
    .map((a) => a.id);

describe('R-12 unprovable-wait backfill live oracle (event-wait-settlement-2026-10-20 AUTO-BAR-R-12-P-006)', () => {
  it('parses a probe row into named counts', () => {
    expect(parseR12Row(GOOD)).toMatchObject({ active_waits: 404, stamped: 344, backfill_stamped_rows: 299 });
  });

  it('refuses a malformed row instead of judging it', () => {
    expect(() => parseR12Row('404|344|51')).toThrow(/9 fields/);
    expect(() => parseR12Row('404|344|51|9|0||299|0|0')).toThrow(/not a count/);
  });

  it('passes a fully classified population with nothing unprovable left unstamped', () => {
    expect(judgeR12(parseR12Row(GOOD)).passed).toBe(true);
  });

  it('fails when an unprovable wait has no re-check date (the clause falsifier)', () => {
    expect(failing('405|344|51|9|0|1|299|0|0')).toEqual(['no-unprovable-unstamped']);
  });

  it('fails when the backfill cleared a row (the clause falsifier)', () => {
    expect(failing('404|344|51|9|0|0|299|1|0')).toEqual(['none-cleared-by-backfill']);
  });

  it('fails closed when a stamped row went inactive with no recorded clearer', () => {
    expect(failing('404|344|51|9|0|0|299|0|2')).toEqual(['no-unattributed-clear']);
  });

  it('fails when a wait falls into no bucket', () => {
    expect(failing('405|344|51|9|0|0|299|0|0')).toEqual(['every-wait-classified-once']);
  });

  it('fails when the backfill never ran on this database (a vacuous pass)', () => {
    expect(failing('60|0|51|9|0|0|0|0|0')).toEqual(['backfill-observed']);
  });

  it('treats an already-fired announced key as proved, not unprovable', () => {
    expect(judgeR12(parseR12Row('405|344|51|9|1|0|299|0|0')).passed).toBe(true);
  });

  it("pins the probe's terminal states to ANY_FAMILY_TERMINAL_STATES", () => {
    const probe = readFileSync(PROBE, 'utf8');
    expect([...probeTerminalStates(probe)].sort()).toEqual([...ANY_FAMILY_TERMINAL_STATES].sort());
  });

  it("pins the probe's concrete-key families to the catalog's condition-proving id-scoped families", () => {
    const probe = readFileSync(PROBE, 'utf8');
    const fromCatalog = EVENT_CATALOG.filter((e) => e.fireProves === 'condition')
      .map((e) => e.keyTemplate.split(':<')[0])
      .sort();
    expect(fromCatalog.length).toBeGreaterThan(0);
    expect([...probeConditionFamilies(probe)].sort()).toEqual(fromCatalog);
  });
});
