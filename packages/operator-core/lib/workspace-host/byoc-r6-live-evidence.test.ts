/**
 * R-6 (plan byoc-cloud-workspaces-gcp-aws-azure-2026-08-22, item P-318): the live
 * lifecycle/recovery evidence document is checked here, part by part, so the bar's
 * e2e proof is a test that can fail rather than a JSON file recorded as a pass.
 *
 * The live journeys themselves ran on real GCP (see the document's `command` and
 * `receiptRefs`). This test asserts that the recorded evidence satisfies every
 * required part of the bar, including positive controls so an empty census or a
 * zero-failure soak cannot pass vacuously.
 *
 * The subject path is overridable (R6_EVIDENCE_PATH) so scripts/mutation-probe.sh can
 * prove falsifiability against a COPY without touching the tracked file.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GCP_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS } from './gcp-safety';

const DEFAULT_PATH = resolve(
  __dirname,
  '../../../../docs/evidence/byoc-r6-live-journeys-r62b-2026-10-02.json',
);
const evidencePath = process.env.R6_EVIDENCE_PATH || DEFAULT_PATH;

// The R-4 artifact: release 0.0.21-p318r62b on release task 0munwgut01uzlcjdajh.
const R4_RELEASE = {
  releaseTaskId: '0munwgut01uzlcjdajh',
  version: '0.0.21-p318r62b',
  bundleSha256: 'dea508a82409b4f3ba6273df398c044f4306034f42dc735f6b86c62dd01e4ab8',
};

type Json = Record<string, any>;
const doc: Json = JSON.parse(readFileSync(evidencePath, 'utf8'));

describe('auto-bar-r-6-p-318: live lifecycle evidence for the R-4 release', () => {
  it('is pinned to the R-4 release bytes, not only its version label', () => {
    expect(doc.kind).toBe('operational-test-evidence');
    expect(doc.exitCode).toBe(0);
    expect(doc.release.releaseTaskId).toBe(R4_RELEASE.releaseTaskId);
    expect(doc.release.version).toBe(R4_RELEASE.version);
    expect(doc.release.bundleSha256).toBe(R4_RELEASE.bundleSha256);
  });

  it('records exactly the four required journeys as passed, with J5 descoped per D-445', () => {
    for (const id of ['J1', 'J2', 'J3', 'J4']) {
      const j = doc.journeys[id];
      expect(j, id).toBeDefined();
      expect(j.passed, `${id}.passed`).toBe(true);
    }
    expect(doc.journeys.J5.required).toBe(false);
    expect(doc.journeys.J5.passed).toBeUndefined();
  });

  it('J1 names the forward upgrade onto r62b and the rollback-by-second-upgrade (D-390)', () => {
    const ops: string[] = doc.journeys.J1.operations;
    expect(ops).toContain('avi-test-accept-r62b-20261001-1');
    expect(ops).toContain('avi-test-upgrade-r63-20261001-back-1');
    expect(doc.journeys.J1.note).toMatch(/r62b/);
    expect(doc.journeys.J1.note).toMatch(/r63/);
  });

  it('J2 restores from a snapshot only after the original host was destroyed', () => {
    const ops: string[] = doc.journeys.J2.operations;
    const snap = ops.indexOf('p318-j23-r62b2-snapshot-a-1');
    const destroyA = ops.indexOf('p318-j23-r62b2-destroy-a-1');
    const restore = ops.indexOf('p318-j23-r62b2-restore-b-1');
    expect(snap).toBeGreaterThanOrEqual(0);
    expect(destroyA).toBeGreaterThan(snap);
    expect(restore).toBeGreaterThan(destroyA);
    expect(ops.some((o) => /p318-j23b-20261001-r62b2:initialize$/.test(o))).toBe(true);
  });

  it('J3 preserves repository data and ownership across the VM replacement', () => {
    const { before, after } = doc.journeys.J3;
    expect(before.host).not.toBe(after.host);
    expect(before.head).toMatch(/^[0-9a-f]{40}$/);
    for (const k of ['head', 'owner', 'mode', 'birth']) {
      expect(after[k], `J3.${k}`).toBe(before[k]);
    }
    expect(doc.journeys.J3.acl).toMatch(/user:papercusp-workspace:rwx/);
  });

  it('J4 covers rotate, revoke and reconnect', () => {
    const ops: string[] = doc.journeys.J4.operations;
    for (const step of ['rotate', 'revoke', 'reconnect']) {
      expect(ops.some((o) => o.endsWith(`:${step}`)), step).toBe(true);
    }
  });

  it('the one-hour soak passed with every expected sample measured (positive control)', () => {
    const { soak } = doc;
    expect(soak.verdict).toBe('pass');
    const [measured, expected] = String(soak.samples).split('/').map(Number);
    expect(expected).toBeGreaterThanOrEqual(61);
    expect(measured / expected).toBeGreaterThanOrEqual(0.95);
    const [start, end] = String(soak.window).split('/').map((t) => Date.parse(t));
    expect(end - start).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });

  it('teardown: resources existed before destroy and the final census is empty', () => {
    const { teardown } = doc;
    // Positive control: the hosts being torn down were real (restore succeeded, destroy ran).
    expect(teardown.j23HostB.status).toBe('succeeded');
    expect(teardown.r62Canary.status).toBe('succeeded');
    expect(teardown.j23HostA.providerAbsence).toMatch(/no instance/);
    expect(teardown.snapshot.status).toBe('deleted');
    const census = teardown.finalCensus;
    for (const kind of ['instances', 'disks', 'networks', 'firewallRules', 'routers']) {
      expect(census[kind], kind).toBe(0);
    }
  });

  it('the eight-kind GCP census is zero for both run labels, with live-scanner positive controls', () => {
    const c = doc.teardown.eightKindCensus;
    expect([...c.kinds].sort()).toEqual([...GCP_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS].sort());
    const runs = Object.keys(c.runs);
    expect(runs.sort()).toEqual(['p318-j23a-20261001-r62b2', 'p318-j23b-20261001-r62b2']);
    for (const run of runs) {
      for (const kind of GCP_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS) {
        expect(c.runs[run][kind], `${run}.${kind}`).toBe(0);
      }
    }
    // An empty census is only a verdict if the scanner can see resources at all.
    expect(c.positiveControls.labelFilterSnapshots).toBeGreaterThan(0);
    expect(c.positiveControls.projectNetworks).toBeGreaterThan(0);
    expect(c.positiveControls.preDestroyExistence).toMatch(/restore-b-1/);
  });

  it('records a disposition for leftover snapshots and a rating for the failed host-A destroy op', () => {
    const { leftoverSnapshots, hostADestroyRating } = doc.teardown;
    expect(leftoverSnapshots.names.length).toBeGreaterThan(0);
    expect(leftoverSnapshots.disposition).toMatch(/not to this run/);
    expect(hostADestroyRating).toMatch(/EI-24818981551847665/);
  });

  it('does not claim a reboot observation for this cut (descoped by D-447)', () => {
    expect(doc.rebootObservation.required).toBe(false);
    expect(doc.rebootObservation.decision).toBe('D-447');
    expect(doc.rebootObservation.passed).toBeUndefined();
  });

  it('records budget caps within the USD 25 plan ceiling and measured spend', () => {
    const { budget } = doc;
    expect(budget.budgetEvidenceRef).toMatch(/^gcp:\/\/billing\//);
    for (const cents of Object.values<number>(budget.admittedMaxSpendCents)) {
      expect(cents).toBeLessThanOrEqual(2500);
    }
    expect(budget.measured.length).toBeGreaterThan(0);
  });

  it('cites a receipt for each committed live step', () => {
    const refs: string[] = doc.receiptRefs;
    expect(refs).toContain('task:0munwgut01uzlcjdajh#acceptance.soak');
    expect(refs).toContain('task:0munwgut01uzlcjdajh#teardown.resource-census');
    expect(refs).toContain('workspace-host-operation:p318-j23-r62b2-restore-b-1');
    expect(refs).toContain('workspace-host-operation:avi-test-upgrade-r63-20261001-back-1');
  });
});
