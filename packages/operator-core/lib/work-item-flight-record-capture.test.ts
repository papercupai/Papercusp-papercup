/**
 * EI-21360972070006156 — guards for the CAPTURE SITE of the work-item flight record.
 *
 * `work-item-lease-release.test.ts` mocks `captureWorkItemFlightRecordsForItems`
 * wholesale, so until this file existed the capture site had NO coverage at all: the
 * behaviour that produced two false "no source edits yet" records (WI-41347, WI-41351)
 * lived entirely in untested code, and a regression back to it would pass every suite.
 *
 * The defect being guarded: ONE record used to be composed per capture and cloned onto
 * every held item, so a SESSION-level `intent` was persisted as though it were a
 * per-item reading. That is why the machine half appeared to corroborate the false
 * human claim — both surfaces came from a single non-measurement.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** Prior checkpoint text per work-item id, so each item can be given a different one. */
  priors: new Map<string, string | null>(),
  /** Final merged checkpoint text actually persisted, per work-item id. */
  persisted: new Map<string, string>(),
  setCheckpoint: vi.fn(),
  brief: vi.fn(),
}));

h.setCheckpoint.mockImplementation(
  async (
    ref: { workItemId: string },
    checkpoint: string | null | undefined,
    opts?: { transform?: (prior: string | null, note: string | null | undefined) => string },
  ) => {
    const prior = h.priors.get(ref.workItemId) ?? null;
    h.persisted.set(ref.workItemId, opts?.transform ? (opts.transform(prior, checkpoint) ?? '') : checkpoint ?? '');
    return { ok: true };
  },
);

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  // Only tool_invocations is read through sql here; an empty history is enough.
  getOrgPg: () => ({ sql: async () => [] }),
}));
vi.mock('./session-brief', () => ({ getSessionBrief: h.brief }));
vi.mock('./work-item-checkpoint', () => ({ setWorkItemCheckpointWithPrior: h.setCheckpoint }));
vi.mock('./workspace-registry', () => ({ resolveConcreteWorkspaceId: (ws: string) => ws }));

const { captureWorkItemFlightRecordsForItems } = await import('./work-item-flight-record');

/** The exact lane note from the confirmed instances: generic, never item-specific. */
const LANE_INTENT = 'this item is one of the two initial claimed lanes; no source edits yet';

beforeEach(() => {
  h.priors.clear();
  h.persisted.clear();
  h.setCheckpoint.mockClear();
  h.brief.mockReset();
  h.brief.mockResolvedValue({ intent: LANE_INTENT, currentFiles: [] });
});

function capturedAtOf(record: string): string | undefined {
  return /captured_at: (\S+)/.exec(record)?.[1];
}

describe('work-item flight record capture site', () => {
  it('keeps flight metadata separate from the latest authored checkpoint update', async () => {
    h.priors.set('WI-resume', '## Next action\nContinue the saved acceptance action.');

    await captureWorkItemFlightRecordsForItems({
      ownerId: 'su-successor',
      workspaceId: 'ws',
      cause: 'lease-release',
      items: [{ id: 'WI-resume', harness: 'papercusp' }],
    });

    // Undefined input preserves the prior hash-bound authored span in the store.
    // Passing a machine record here would replace it with activity metadata.
    expect(h.setCheckpoint.mock.calls[0]?.[1]).toBeUndefined();
    expect(h.persisted.get('WI-resume')).toContain('Continue the saved acceptance action.');
    expect(h.persisted.get('WI-resume')).toContain('cause: lease-release');
  });

  it('does not clone one session-level record across several items', async () => {
    const res = await captureWorkItemFlightRecordsForItems({
      ownerId: 'su-8973ac94',
      workspaceId: 'ws',
      cause: 'lease-release',
      items: [
        { id: 'WI-41347', harness: 'papercusp' },
        { id: 'WI-41351', harness: 'papercusp' },
      ],
    });

    expect(res.capturedIds).toEqual(['WI-41347', 'WI-41351']);
    const a = h.persisted.get('WI-41347') ?? '';
    const b = h.persisted.get('WI-41351') ?? '';

    // The regression this file exists to catch: identical text on both items.
    expect(a).not.toEqual(b);

    // Each record names the OTHER item, and says the intent is not a reading of itself.
    expect(a).toContain('also_stamped_on: ["WI-41351"]');
    expect(b).toContain('also_stamped_on: ["WI-41347"]');
    for (const record of [a, b]) {
      expect(record).toContain('intent_scope: session-lane');
      expect(record).toContain('stamped identically onto 2 items');
      // The lane note itself is still persisted verbatim — provenance is ADDED, never
      // substituted for what the agent wrote.
      expect(record).toContain(LANE_INTENT);
    }

    // One capture, one instant: the per-item composition must not re-clock each record,
    // or two items released together would look like two separate captures.
    expect(capturedAtOf(a)).toBeDefined();
    expect(capturedAtOf(a)).toEqual(capturedAtOf(b));
  });

  it('omits the session-lane warning for a genuine single-item capture', async () => {
    await captureWorkItemFlightRecordsForItems({
      ownerId: 'su-8973ac94',
      workspaceId: 'ws',
      cause: 'lease-release',
      items: [{ id: 'WI-41347', harness: 'papercusp' }],
    });

    const only = h.persisted.get('WI-41347') ?? '';
    expect(only).toContain('captured_at:');
    // Control: were the warning unconditional it would be noise on every record and
    // would mean nothing on the multi-item records that actually need it.
    expect(only).not.toContain('intent_scope:');
    expect(only).not.toContain('also_stamped_on:');
  });

  it('dates authored prose per item, from that item own prior checkpoint', async () => {
    const stale = 'Claim-time note: no source edits yet.';
    h.priors.set('WI-41347', stale);
    h.priors.set('WI-41351', null);

    await captureWorkItemFlightRecordsForItems({
      ownerId: 'su-8973ac94',
      workspaceId: 'ws',
      cause: 'lease-release',
      items: [
        { id: 'WI-41347', harness: 'papercusp' },
        { id: 'WI-41351', harness: 'papercusp' },
      ],
    });

    const withProse = h.persisted.get('WI-41347') ?? '';
    const withoutProse = h.persisted.get('WI-41351') ?? '';

    // Both directions, so the provenance line cannot be a constant.
    expect(withProse).toContain('authored_prose_above: PRESENT and PREDATES this capture');
    expect(withoutProse).toContain('authored_prose_above: none');

    // The stale prose survives and sits ABOVE the record that dates it.
    expect(withProse.startsWith(stale)).toBe(true);
    expect(withProse.indexOf(stale)).toBeLessThan(withProse.indexOf('authored_prose_above:'));
  });

  it('stays fail-soft: a checkpoint write that throws never rejects the capture', async () => {
    h.setCheckpoint.mockRejectedValueOnce(new Error('store unavailable'));

    const res = await captureWorkItemFlightRecordsForItems({
      ownerId: 'su-8973ac94',
      workspaceId: 'ws',
      cause: 'lease-release',
      items: [
        { id: 'WI-41347', harness: 'papercusp' },
        { id: 'WI-41351', harness: 'papercusp' },
      ],
    });

    // Recovery evidence must never become an availability dependency of lease release:
    // the failing item is dropped, the surviving one is still captured.
    expect(res.capturedIds).toEqual(['WI-41351']);
  });
});
