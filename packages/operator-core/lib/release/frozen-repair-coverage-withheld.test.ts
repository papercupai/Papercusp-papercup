import { describe, expect, it } from 'vitest';
import { frozenRepairRoundExecution, type FrozenRepairCoverageWithheldReason } from './frozen-candidate-repair-queue';

// P-005 (green-main-cycle-time-2026-10-08): a targeted round names why it recorded no
// selective-coverage receipt. The record is persisted on the queue row, so it is bounded and
// closed-set: unknown reasons are dropped (never thrown on) and full rounds never carry it.
describe('frozenRepairRoundExecution coverageWithheld', () => {
  it('keeps the closed-set reasons on a targeted round, de-duplicated and in order', () => {
    const record = frozenRepairRoundExecution({
      mode: 'targeted',
      gateIds: ['lint:remaining'],
      coverageWithheld: ['radius-census-incomplete', 'gate-run-incomplete', 'radius-census-incomplete'],
    });
    expect(record.coverageWithheld).toEqual(['radius-census-incomplete', 'gate-run-incomplete']);
  });

  it('drops reasons outside the closed set', () => {
    const record = frozenRepairRoundExecution({
      mode: 'targeted',
      gateIds: [],
      coverageWithheld: ['file-run-incomplete', 'not-a-reason' as FrozenRepairCoverageWithheldReason],
    });
    expect(record.coverageWithheld).toEqual(['file-run-incomplete']);
  });

  it('omits the field when nothing was withheld or the round ran the full gate', () => {
    expect(frozenRepairRoundExecution({ mode: 'targeted', gateIds: [], coverageWithheld: [] }))
      .not.toHaveProperty('coverageWithheld');
    expect(frozenRepairRoundExecution({
      mode: 'full', gateIds: [], trigger: 'promotion-proof', coverageWithheld: ['selection-incomplete'],
    })).not.toHaveProperty('coverageWithheld');
  });
});
