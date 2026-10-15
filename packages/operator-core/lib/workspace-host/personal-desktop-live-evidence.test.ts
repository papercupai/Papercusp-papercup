import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const evidencePath = resolve(
  __dirname,
  '../../../../docs/evidence/personal-cloud-desktop-2026-10-06/live-run.json',
);

type ReconnectObservation = {
  desktopSessionIdBefore: string;
  desktopSessionIdAfter: string;
  desktopSessionIdAfterProvenance: {
    source: string;
    independentlyMeasured: boolean;
    note: string;
  };
  desktopSessionIdAfterObserved: string;
  desktopSessionIdAfterObservedProvenance: {
    source: string;
    requestId: string;
    observedAt: string;
    independentlyMeasured: boolean;
  };
  rosterStillLists: boolean;
  reopenedReady: { action: string; inputAllowed: boolean };
  xvncPidBefore: string;
  xvncPidAfter: string;
};

type LiveRunEvidence = {
  summary: string;
  assertions: Array<{ id: string; passed: boolean; evidence: string }>;
  observations: { 'personal-desktop-reconnect': ReconnectObservation };
  transcript: string[];
};

const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as LiveRunEvidence;

describe('personal desktop P-006 R-19 evidence provenance', () => {
  it('does not present the echoed starting id as an independent post-reconnect reading', () => {
    const reconnect = evidence.observations['personal-desktop-reconnect'];
    const assertion = evidence.assertions.find(({ id }) => id === 'personal-desktop-reconnect');
    const echoed = reconnect.desktopSessionIdAfterProvenance;
    const observed = reconnect.desktopSessionIdAfterObservedProvenance;
    const rosterFrame = evidence.transcript.find((line) =>
      line.includes(`"requestId":"${observed.requestId}"`),
    );

    expect(assertion).toBeDefined();
    expect(assertion?.passed).toBe(true);
    expect(echoed.source).toBe('starting-id-variable');
    expect(echoed.independentlyMeasured).toBe(false);
    expect(echoed.note).toMatch(/initial id/i);
    expect(reconnect.desktopSessionIdAfter).toBe(reconnect.desktopSessionIdBefore);

    expect(observed.source).toBe('owner-session desktop.roster.result');
    expect(observed.independentlyMeasured).toBe(true);
    expect(rosterFrame).toBeDefined();
    expect(rosterFrame?.startsWith(observed.observedAt)).toBe(true);
    const rosterResult = JSON.parse(rosterFrame?.slice(rosterFrame.indexOf('{')) ?? 'null') as {
      requestId: string;
      desktops: Array<{ desktopSessionId: string; scope: string; owner: string }>;
    };
    const ownerDesktop = rosterResult.desktops.find(
      ({ scope, owner }) => scope === 'user' && owner === 'pcd-owner-p006-pcd006b-1',
    );
    expect(rosterResult.requestId).toBe(observed.requestId);
    expect(ownerDesktop).toBeDefined();
    expect(reconnect.desktopSessionIdAfterObserved).toBe(ownerDesktop?.desktopSessionId);

    // These are the independent observations supporting the historical continuity claim.
    expect(reconnect.rosterStillLists).toBe(true);
    expect(reconnect.reopenedReady).toEqual({ action: 'takeover', inputAllowed: true });
    expect(reconnect.xvncPidAfter).toBe(reconnect.xvncPidBefore);
    expect(assertion?.evidence).toMatch(/not independently re-read/i);
    expect(assertion?.evidence).toMatch(/not an additional identity measurement/i);
    expect(evidence.summary).toMatch(/does not constitute a new live run/i);
  });
});
