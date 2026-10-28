import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { monitoredCensusRunId, scheduledCensusWorkflowId } from './fire-provenance';

it('prebinds a census slot independently of tick/executor identity and separates scopes and due slots', () => {
  const due = new Date('2026-10-28T04:17:00Z');
  const first = scheduledCensusWorkflowId('workspace', 'routine', due);
  expect(scheduledCensusWorkflowId('workspace', 'routine', new Date(due))).toBe(first);
  expect(new Set([first,
    scheduledCensusWorkflowId('other-workspace', 'routine', due),
    scheduledCensusWorkflowId('workspace', 'other-routine', due),
    scheduledCensusWorkflowId('workspace', 'routine', new Date(due.getTime() + 60_000)),
  ]).size).toBe(4);
  // Compatibility with retained census rows: factoring out the original hash
  // must not change the run identifier for an already persisted workflow.
  const hex = createHash('sha256').update(JSON.stringify(['workspace', first])).digest('hex');
  expect(monitoredCensusRunId('workspace', first)).toBe(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`);
});
it('refuses a missing or invalid canonical due slot instead of making an uncorrelated fire', () => {
  for (const due of [null, new Date('invalid')])
    expect(() => scheduledCensusWorkflowId('workspace', 'routine', due)).toThrow('invalid_census_due_slot');
});
