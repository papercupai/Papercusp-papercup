/**
 * EI-25188923369514003 — involuntary claim-release audit rows must identify the
 * process that made each release decision, so a later false-positive can be tied
 * to its serving host, process, and loaded build.
 */
import { describe, expect, it, vi } from 'vitest';

const servingIdentity = vi.hoisted(() => ({
  value: {
    host: 'port-3170',
    processId: 'linux:boot-test:1234',
    buildSha: 'a1b2c3d4',
  },
}));

vi.mock('./serving-host-identity', () => ({
  getServingHostIdentity: () => servingIdentity.value,
}));

import { INVOLUNTARY_RELEASE_ACTION, recordInvoluntaryClaimReleases } from './claim-release-notice';

describe('recordInvoluntaryClaimReleases audit provenance', () => {
  it('writes one host/process/build/reason audit row per released claim without changing notifications', async () => {
    const writes: Array<{ statement: string; params: unknown[] }> = [];
    const sql = {
      unsafe: vi.fn(async (statement: string, params: unknown[]) => {
        writes.push({ statement, params });
      }),
    } as never;

    const result = await recordInvoluntaryClaimReleases(sql, {
      workspaceId: 'ws-test',
      harness: 'papercusp',
      actor: 'stale-claim-sweep',
      reason: 'stale work-item claim sweep',
      notify: false,
      released: [
        { workItemId: 'EI-release-dead', takenBy: 'su-holder', reason: 'dead' },
        { workItemId: 'EI-release-exit', takenBy: 'su-holder', reason: 'spawn-exit' },
      ],
    });

    expect(result).toEqual({ audited: 2, notified: 0, failures: [] });
    expect(writes).toHaveLength(2);
    for (const [index, expectedReason] of ['dead', 'spawn-exit'].entries()) {
      const { statement, params } = writes[index]!;
      expect(statement).toContain('INSERT INTO harness_shared.audit_log');
      expect(params[3]).toBe(INVOLUNTARY_RELEASE_ACTION);
      const details = JSON.parse(String(params[5]));
      expect(details).toMatchObject({
        takenBy: 'su-holder',
        actor: 'stale-claim-sweep',
        reason: expectedReason,
        harness: 'papercusp',
        involuntary: true,
        emitter: {
          host: 'port-3170',
          pid: process.pid,
          processId: 'linux:boot-test:1234',
          buildSha: 'a1b2c3d4',
        },
      });
    }
  });
});
