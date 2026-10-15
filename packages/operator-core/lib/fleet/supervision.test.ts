/**
 * supervision.test.ts — pure unit coverage for the WI-5541 relaunch-input mapping.
 *
 * `buildRelaunchInput` reconstructs the `spawnAgentInHarness` input for re-launching a
 * 'restarting' spawn from its recorded nursery row — no DB, no process, so this is a
 * plain unit test (the SQL/relaunch wiring itself is covered against real PG in
 * supervision.integration.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { buildRelaunchInput } from './supervision';

const ROW = {
  harnessSlug: 'papercusp',
  childRole: 'cup',
  parentSpawnId: 'queen-1',
  parentRole: 'mug',
  featureId: 'WI-1',
  chunkId: null,
  planSlug: 'plan-1',
  itemId: 'WI-1',
  modelSpec: 'sonnet:high',
  modelTier: 'standard',
  brief: 'resume the work',
};

describe('buildRelaunchInput (WI-5541)', () => {
  it('reconstructs the spawn input from a full row, preferring the recorded modelSpec over re-resolving the tier', () => {
    const res = buildRelaunchInput('ws-1', 'dead-spawn', ROW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input).toMatchObject({
      workspaceId: 'ws-1',
      harness: 'papercusp',
      role: 'cup',
      featureId: 'WI-1',
      chunkId: null,
      planSlug: 'plan-1',
      itemId: 'WI-1',
      brief: 'resume the work',
      modelSpec: 'sonnet:high',
      tier: undefined,
      parentSpawnId: 'queen-1',
      parentRole: 'mug',
      turnTrigger: 'supervised-restart',
      replacesSpawnId: 'dead-spawn',
      idempotencyKey: 'supervised-restart:dead-spawn',
    });
  });

  it('falls back to the recorded model TIER only when no modelSpec was persisted', () => {
    const res = buildRelaunchInput('ws-1', 'dead-spawn', { ...ROW, modelSpec: null });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input.modelSpec).toBeUndefined();
    expect(res.input.tier).toBe('standard');
  });

  it('refuses to build an input when harness_slug is missing — nothing to relaunch into', () => {
    const res = buildRelaunchInput('ws-1', 'dead-spawn', { ...ROW, harnessSlug: null });
    expect(res).toEqual({ ok: false, error: expect.stringContaining('harness_slug') });
  });

  it('refuses to build an input when child_role is missing', () => {
    const res = buildRelaunchInput('ws-1', 'dead-spawn', { ...ROW, childRole: null });
    expect(res).toEqual({ ok: false, error: expect.stringContaining('child_role') });
  });

  it('idempotency key is keyed on the CRASHED spawn id, so a duplicate crash report dedupes to one relaunch', () => {
    const a = buildRelaunchInput('ws-1', 'spawn-a', ROW);
    const b = buildRelaunchInput('ws-1', 'spawn-a', ROW);
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect(a.input.idempotencyKey).toBe(b.input.idempotencyKey);
    expect(a.input.idempotencyKey).toBe('supervised-restart:spawn-a');
  });
});
