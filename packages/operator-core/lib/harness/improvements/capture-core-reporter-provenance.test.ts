/**
 * capture-core-reporter-provenance.test.ts — every filed bug records which
 * reporter kind filed it, with the reporter's captured context, and a fold
 * extends the corroboration record instead of minting a sibling
 * (unified-bug-pipeline-and-honest-queue-2026-10-05 P-010, SPEC-P-010, D-001/D-009).
 *
 * Falsifier (SPEC-P-010): a bug filed by the watchdog or an end user carries
 * no reporter provenance. Both are driven through the real captureImprovement
 * over a stateful fake store; the pure derivation is reporter-provenance.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { captureImprovement, type CaptureDeps } from './capture-core';
import type { CreateIssueInput, EngineerIssue } from '../../issues-engineer';
import type { RecordIssueOccurrenceInput } from '../../issue-occurrence-ledger';

vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

function issue(p: Partial<EngineerIssue> & { id: string; title: string }): EngineerIssue {
  return {
    kind: 'bug',
    scope: 'operator',
    body: '',
    severity: 'minor',
    source: 'su',
    state: 'open',
    assignee: null,
    assignedBy: null,
    assignedAt: null,
    payload: null,
    foundDuring: null,
    linkedFeatureId: null,
    parent: null,
    createdBy: null,
    signalOrigin: 'organic',
    assigneeRank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    lastProgressAt: null,
    origin: 'local',
    terminalOwner: null,
    terminalCompletionRef: null,
    completionAuthority: null,
    featureOrder: null,
    createdAt: '2026-10-06T00:00:00Z',
    updatedAt: '2026-10-06T00:00:00Z',
    closedAt: null,
    goalId: null,
    ...p,
  };
}

/** A store a second call genuinely reads back, so folds run the real loop. */
function storeDeps(): CaptureDeps & { created: CreateIssueInput[]; store: EngineerIssue[] } {
  const created: CreateIssueInput[] = [];
  const store: EngineerIssue[] = [];
  const occurrences: RecordIssueOccurrenceInput[] = [];
  let nextId = 900;
  return {
    created,
    store,
    recordIssueOccurrence: async (input) => {
      occurrences.push(input);
      return null;
    },
    searchIssues: async () => [],
    createIssue: async (input) => {
      created.push(input);
      const row = issue({
        id: `EI-${nextId++}`,
        title: input.title,
        kind: (input.kind as 'bug' | 'change') ?? 'bug',
        payload: input.payload ?? null,
        createdBy: input.createdBy ?? null,
      });
      store.push(row);
      return row;
    },
    findIssuesByWatchdogKeys: async (keys) =>
      store.filter((i) => {
        const k = (i.payload as Record<string, unknown> | null)?.watchdogKey;
        return typeof k === 'string' && keys.includes(k);
      }),
    mergeIssuePayload: async (id, patch) => {
      const i = store.find((x) => x.id === id);
      if (!i) return null;
      i.payload = { ...(i.payload as Record<string, unknown> | null), ...patch };
      return i;
    },
    updateIssuePatch: async (id, patch) => {
      const i = store.find((x) => x.id === id);
      if (!i) return null;
      if (patch.title !== undefined) i.title = patch.title;
      if (patch.body !== undefined) i.body = patch.body;
      return i;
    },
  };
}

const payloadOf = (input: CreateIssueInput) => input.payload as Record<string, unknown>;

describe('captureImprovement — reporter provenance on every filed bug (SPEC-P-010)', () => {
  it('an agent filing records reporter kind agent, its session, and an auto-captured context block', async () => {
    const d = storeDeps();
    const r = await captureImprovement(
      { title: 'work_items:get drops the checkpoint on a cold read', kind: 'bug', createdBy: 'su-4a152da3' },
      d,
    );
    expect(r.ok).toBe(true);
    const p = payloadOf(d.created[0]);
    expect(p.reporter).toMatchObject({ kind: 'agent', id: 'su-4a152da3', basis: 'agent-session' });
    expect(p.reporterKinds).toEqual(['agent']);
    expect(p.reportContext).toMatchObject({ schemaVersion: 1, app: 'papercusp' });
    expect((p.reportContext as { autoCaptured: string[] }).autoCaptured).toContain('app');
  });

  it('a watchdog filing records reporter kind watchdog (falsifier half 1)', async () => {
    const d = storeDeps();
    await captureImprovement(
      {
        title: 'LEARNING LOOP needs attention: regret (absent)',
        kind: 'bug',
        createdBy: 'system:improvement-watchdog',
        sourceRole: 'system',
        watchdogKey: 'learning-loop:regret',
      },
      d,
    );
    expect(payloadOf(d.created[0]).reporter).toMatchObject({ kind: 'watchdog', basis: 'system-identity' });
  });

  it('an end-user filing records reporter kind end-user and keeps the screen it was sent (falsifier half 2)', async () => {
    const d = storeDeps();
    await captureImprovement(
      {
        title: 'The queue view shows an empty list after switching tabs',
        kind: 'bug',
        reporterKind: 'end-user',
        reportContext: {
          app: 'papercusp-desktop',
          appVersion: '1.4.2',
          screen: { url: '/work?tab=queue', state: { tab: 'queue' } },
        },
      },
      d,
    );
    const p = payloadOf(d.created[0]);
    expect(p.reporter).toMatchObject({ kind: 'end-user', basis: 'explicit' });
    expect(p.reportContext).toMatchObject({
      app: 'papercusp-desktop',
      appVersion: '1.4.2',
      screen: { url: '/work?tab=queue', route: null, state: { tab: 'queue' } },
    });
  });

  it('a change filing carries the reporter stamp but no bug context block', async () => {
    const d = storeDeps();
    await captureImprovement({ title: 'Rename the queue tab to Ready', kind: 'change', createdBy: 'su-1' }, d);
    const p = payloadOf(d.created[0]);
    expect(p.reporter).toMatchObject({ kind: 'agent' });
    expect(p.reportContext).toBeUndefined();
  });

  it('a payloadExtra reporter cannot overwrite the derived stamp', async () => {
    const d = storeDeps();
    await captureImprovement(
      {
        title: 'Spoofed reporter in payloadExtra',
        kind: 'bug',
        createdBy: 'su-1',
        payloadExtra: { reporter: { kind: 'end-user', basis: 'explicit' } },
      },
      d,
    );
    expect(payloadOf(d.created[0]).reporter).toMatchObject({ kind: 'agent', basis: 'agent-session' });
  });
});

describe('captureImprovement — a fold extends the corroboration record (D-009)', () => {
  it('a watchdog report then an agent report of the same keyed condition is ONE row naming both kinds', async () => {
    const d = storeDeps();
    const first = await captureImprovement(
      {
        title: 'Hive canary papercusp/WI-1 breached its completion SLA',
        kind: 'bug',
        lane: 'improvement',
        createdBy: 'system:hive-canary',
        watchdogKey: 'hive-canary:papercusp:WI-1',
      },
      d,
    );
    expect(first.created).toBe(true);
    const second = await captureImprovement(
      {
        title: 'Hive canary papercusp/WI-1 breached its completion SLA again',
        kind: 'bug',
        lane: 'improvement',
        createdBy: 'su-4a152da3',
        watchdogKey: 'hive-canary:papercusp:WI-1',
      },
      d,
    );
    expect(second.created).toBe(false);
    expect(second.reason).toBe('coalesced');
    expect(d.store).toHaveLength(1);
    const p = d.store[0].payload as Record<string, unknown>;
    // The first reporter stays the row's reporter; the tally names everyone.
    expect(p.reporter).toMatchObject({ kind: 'watchdog', id: 'system:hive-canary' });
    expect(p.reporterKinds).toEqual(['agent', 'watchdog']);
    expect(p.repeatCount).toBe(2);
  });
});
