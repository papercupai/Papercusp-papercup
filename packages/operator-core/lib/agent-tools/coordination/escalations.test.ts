/**
 * escalations.test.ts — listEscalationsPaginated bounds the READ at the storage
 * layer (EI-1548) instead of loading the whole surface then truncating. Drives
 * the fold + bounding through the swappable InMemoryCoordLog seam (no PG).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';
import { configureCoordLog, resetCoordLog, coordLog } from './log';
import {
  detectOwnerAuthorshipClaim,
  expireStaleAdvisoryEscalations,
  foldEscalationResolution,
  getEscalation,
  listEscalations,
  listEscalationsPaginated,
  openEscalation,
  reopenEscalation,
  resolveEscalation,
  resolveEscalationsBatch,
  UNVERIFIED_OWNER_AUTHORSHIP_CLAIM_TAG,
  type OwnerAuthorshipClaimLocation,
} from './escalations';
import { resolvedEventId } from '@papercusp/coordination/core';
import type { AgentIdentity } from './identity';

afterEach(() => resetCoordLog());

/** An InMemoryCoordLog that counts how many times the FULL surface is scanned
 *  (`readEvents`) — the O(n²) signal the batch resolve must NOT trip. */
class CountingCoordLog extends InMemoryCoordLog {
  readEventsCalls = 0;
  override readEvents(surface: Parameters<InMemoryCoordLog['readEvents']>[0]) {
    this.readEventsCalls += 1;
    return super.readEvents(surface);
  }
}

async function seedOpen(n: number): Promise<void> {
  configureCoordLog(new InMemoryCoordLog());
  for (let i = 1; i <= n; i++) {
    await coordLog.putEvent('escalations', `e${i}`, {
      ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      msg_id: `e${i}`,
      from: 'A',
      to: ['human'],
      kind: 'escalation',
      severity: 'question',
      summary: `esc ${i}`,
      resolved: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }
}

describe('listEscalationsPaginated — bounded read (EI-1548)', () => {
  it('bounds the page to maxRecords (newest-first) and flags truncated', async () => {
    await seedOpen(5);
    const r = await listEscalationsPaginated({ maxRecords: 2 });
    expect(r.escalations).toHaveLength(2);
    expect(r.truncated).toBe(true);
    // The bounded read selected the 2 NEWEST (e4,e5) — not the oldest. (Post-fold
    // ordering is foldEscalations' concern, so assert the SET, not the sequence.)
    expect(r.escalations.map((e) => e.msg_id).sort()).toEqual(['e4', 'e5']);
  });

  it('returns the full set when under the page size and is not truncated', async () => {
    await seedOpen(3);
    const r = await listEscalationsPaginated({ maxRecords: 50 });
    expect(r.escalations).toHaveLength(3);
    expect(r.truncated).toBe(false);
  });

  it('clamps an over-large maxRecords to the 500 ceiling', async () => {
    await seedOpen(3);
    // maxRecords 9999 must not throw / must still return; ceiling is internal.
    const r = await listEscalationsPaginated({ maxRecords: 9999 });
    expect(r.escalations).toHaveLength(3);
    expect(r.truncated).toBe(false);
  });

  it('folds a resolve out of the open set (status filter still works)', async () => {
    configureCoordLog(new InMemoryCoordLog());
    await coordLog.putEvent('escalations', 'e1', {
      ts: '2026-01-01T00:00:01.000Z', msg_id: 'e1', from: 'A', to: ['human'],
      kind: 'escalation', summary: 'needs a human', resolved: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await coordLog.putEvent('escalations', 'r1', {
      ts: '2026-01-01T00:00:02.000Z', msg_id: 'r1', from: 'A', to: ['human'],
      kind: 'escalation_resolved', related_msg_id: 'e1', choice: 'ok', summary: 'resolved',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const open = await listEscalationsPaginated({ status: 'open', maxRecords: 50 });
    expect(open.escalations.map((e) => e.msg_id)).toEqual([]); // e1 is resolved

    const resolved = await listEscalationsPaginated({ status: 'resolved', maxRecords: 50 });
    expect(resolved.escalations.map((e) => e.msg_id)).toEqual(['e1']);
  });

  it('empty surface → no escalations, not truncated', async () => {
    configureCoordLog(new InMemoryCoordLog());
    const r = await listEscalationsPaginated({ maxRecords: 50 });
    expect(r.escalations).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it('EI-16170: status:open + a small maxRecords still reports the TRUE unbounded open count via trueOpenTotal, distinct from the bounded page total', async () => {
    await seedOpen(5);
    const r = await listEscalationsPaginated({ status: 'open', maxRecords: 2 });
    // The bounded page itself still only holds 2 (matches `total`/`escalations.length`) —
    // this is the exact "total:2" reading that got misread as ground truth (EI-16170).
    expect(r.escalations).toHaveLength(2);
    expect(r.total).toBe(2);
    expect(r.truncated).toBe(true);
    // But trueOpenTotal is the REAL unbounded backlog size (all 5 seeded opens) —
    // the honest ground truth a caller should compare against, not `total`.
    expect(r.trueOpenTotal).toBe(5);
  });

  it('EI-16170: trueOpenTotal is omitted when status is not "open" (resolved / unfiltered reads have no single "true open" figure to report)', async () => {
    await seedOpen(3);
    const resolved = await listEscalationsPaginated({ status: 'resolved', maxRecords: 50 });
    expect(resolved.trueOpenTotal).toBeUndefined();
    const unfiltered = await listEscalationsPaginated({ maxRecords: 50 });
    expect(unfiltered.trueOpenTotal).toBeUndefined();
  });

  it('EI-1548 (#3): a fat body is truncated in list mode and flagged, short bodies are untouched', async () => {
    configureCoordLog(new InMemoryCoordLog());
    const fatBody = 'x'.repeat(2_000);
    await coordLog.putEvent('escalations', 'fat1', {
      ts: '2026-01-01T00:00:01.000Z', msg_id: 'fat1', from: 'A', to: ['human'],
      kind: 'escalation', summary: 'has a huge body', body: fatBody, resolved: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await coordLog.putEvent('escalations', 'short1', {
      ts: '2026-01-01T00:00:02.000Z', msg_id: 'short1', from: 'A', to: ['human'],
      kind: 'escalation', summary: 'has a short body', body: 'tiny', resolved: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const r = await listEscalationsPaginated({ status: 'open', maxRecords: 50 });
    const fat = r.escalations.find((e) => e.msg_id === 'fat1') as (typeof r.escalations)[number] & {
      bodyTruncated?: boolean;
      bodyLength?: number;
    };
    const short = r.escalations.find((e) => e.msg_id === 'short1') as (typeof r.escalations)[number] & {
      bodyTruncated?: boolean;
      bodyLength?: number;
    };
    expect(fat.body).toHaveLength(500);
    expect(fat.bodyTruncated).toBe(true);
    expect(fat.bodyLength).toBe(2_000);
    expect(short.body).toBe('tiny');
    expect(short.bodyTruncated).toBeUndefined();
  });

  it('EI-6624: a resolve-heavy window does not starve status:open opens out of the page', async () => {
    // Reproduces the reported symptom: an active fleet resolving many escalations
    // recently means a maxRecords-sized COMBINED window (old behavior) could be
    // almost entirely `escalation_resolved` events, crowding out genuinely open
    // escalations and returning escalations:[] with a misleading nonzero total.
    configureCoordLog(new InMemoryCoordLog());
    // One still-open escalation, oldest of all events.
    await coordLog.putEvent('escalations', 'open1', {
      ts: '2026-01-01T00:00:00.000Z', msg_id: 'open1', from: 'A', to: ['human'],
      kind: 'escalation', summary: 'still open', resolved: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // A burst of 10 unrelated resolve events, all NEWER than open1 — under the
    // old shared-window design with maxRecords:5 these alone would fill the
    // entire window and open1 would never be scanned.
    for (let i = 1; i <= 10; i++) {
      await coordLog.putEvent('escalations', `resolve${i}`, {
        ts: `2026-01-01T00:01:${String(i).padStart(2, '0')}.000Z`,
        msg_id: `resolve${i}`, from: 'A', to: ['human'],
        kind: 'escalation_resolved', related_msg_id: `unrelated${i}`, choice: 'ok', summary: 'resolved',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    }

    const r = await listEscalationsPaginated({ status: 'open', maxRecords: 5 });
    expect(r.escalations.map((e) => e.msg_id)).toEqual(['open1']);
    expect(r.total).toBe(1); // total matches what's actually returned — never a misleading nonzero-with-empty-array
    expect(r.trueOpenTotal).toBe(1); // and the unbounded true count agrees here (only 1 open exists)
  });

  it('EI-16170: `total` is page-bounded, not the backlog size — `trueOpenTotal` gives the real unbounded open count', async () => {
    // Reproduces the false-alarm shape: a small maxRecords window's `total`
    // (== escalations.length) looks like "how many are open" but is really
    // just "how many fit in this window". A maxRecords:10 open-scan once read
    // `total:2` and was mistaken for "only 2 escalations open" when the real
    // backlog was 279+ (EI-16170). `trueOpenTotal` must reflect the full,
    // unbounded open count regardless of maxRecords.
    configureCoordLog(new InMemoryCoordLog());
    for (let i = 1; i <= 8; i++) {
      await coordLog.putEvent('escalations', `many${i}`, {
        ts: `2026-01-01T00:0${i}:00.000Z`, msg_id: `many${i}`, from: 'A', to: ['human'],
        kind: 'escalation', summary: `open ${i}`, resolved: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    }

    const r = await listEscalationsPaginated({ status: 'open', maxRecords: 3 });
    expect(r.escalations).toHaveLength(3); // page bounded to maxRecords
    expect(r.total).toBe(3); // total is just this page's size — NOT ground truth
    expect(r.truncated).toBe(true);
    expect(r.trueOpenTotal).toBe(8); // the real, unbounded backlog size

    // status:'resolved' (and the no-status default) never claim an unbounded
    // total — computing one isn't cheap for that surface, so the field stays
    // absent rather than silently lying with a stale/partial number.
    const resolved = await listEscalationsPaginated({ status: 'resolved', maxRecords: 3 });
    expect(resolved.trueOpenTotal).toBeUndefined();
    const noStatus = await listEscalationsPaginated({ maxRecords: 3 });
    expect(noStatus.trueOpenTotal).toBeUndefined();
  });

  it('WI-4181: an old RESOLVED escalation whose resolution was evicted from the resolves window does not re-materialize as open (the zombie that stormed the infra-liveness recovery broadcast)', async () => {
    // The EI-6624 dual: there, resolve-heavy traffic starved OPENS out of the
    // window; here it starves an old open's RESOLUTION out — the open (still
    // inside the newest-N opens window) then folded as a zombie "open" forever,
    // because resolveEscalation on it is a no-op ('already_resolved', no write)
    // so nothing ever re-enters the window. The fix pages the resolves cursor
    // back until it covers the oldest open's ts.
    configureCoordLog(new InMemoryCoordLog());
    // z1: the oldest open — resolved 1s later.
    await coordLog.putEvent('escalations', 'z1', {
      ts: '2026-01-01T00:00:00.000Z', msg_id: 'z1', from: 'A', to: ['human'],
      kind: 'escalation', severity: 'blocker', summary: 'tick stale', resolved: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await coordLog.putEvent('escalations', 'rz', {
      ts: '2026-01-01T00:00:01.000Z', msg_id: 'rz', from: 'A', to: ['human'],
      kind: 'escalation_resolved', related_msg_id: 'z1', choice: 'auto-resolved', summary: 'resolved',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // 4 newer still-open escalations keep z1 INSIDE the newest-5 opens window…
    for (let i = 2; i <= 5; i++) {
      await coordLog.putEvent('escalations', `o${i}`, {
        ts: `2026-01-01T00:02:${String(i).padStart(2, '0')}.000Z`, msg_id: `o${i}`, from: 'A', to: ['human'],
        kind: 'escalation', summary: `open ${i}`, resolved: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    }
    // …while 6 newer unrelated resolves EVICT rz from the newest-5 resolves window.
    for (let i = 1; i <= 6; i++) {
      await coordLog.putEvent('escalations', `r${i}`, {
        ts: `2026-01-01T00:03:${String(i).padStart(2, '0')}.000Z`, msg_id: `r${i}`, from: 'A', to: ['human'],
        kind: 'escalation_resolved', related_msg_id: `unrelated${i}`, choice: 'ok', summary: 'resolved',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    }

    const open = await listEscalationsPaginated({ status: 'open', maxRecords: 5 });
    // Pre-fix this returned ['z1','o2'..'o5'] — z1 back from the dead.
    expect(open.escalations.map((e) => e.msg_id).sort()).toEqual(['o2', 'o3', 'o4', 'o5']);

    const resolved = await listEscalationsPaginated({ status: 'resolved', maxRecords: 5 });
    expect(resolved.escalations.map((e) => e.msg_id)).toContain('z1');
  });
});

describe('listEscalationsPaginated — conditionKey/q lookup filters (EI-15377)', () => {
  // These exercise the LEGACY windowed fold path (no PG fast path configured in
  // this file's seam), which is the leg that must carry `filterWindowCaveat`.
  // The projection fast path (status:'open' + the flag ON) is covered separately
  // in coord-open-escalations-projection.integration.test.ts, where it can run
  // against a real PG-backed projection.

  it('conditionKey does an exact match against subjectSignature, not a substring', async () => {
    configureCoordLog(new InMemoryCoordLog());
    await coordLog.putEvent('escalations', 'e1', {
      ts: '2026-01-01T00:00:01.000Z', msg_id: 'e1', from: 'A', to: ['human'],
      kind: 'escalation', summary: 'dead-routines stale', resolved: null,
      subjectSignature: 'dead-routines-papercusp',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await coordLog.putEvent('escalations', 'e2', {
      ts: '2026-01-01T00:00:02.000Z', msg_id: 'e2', from: 'A', to: ['human'],
      kind: 'escalation', summary: 'git-sync-stall', resolved: null,
      subjectSignature: 'git-sync-stall-papercusp',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const hit = await listEscalationsPaginated({ conditionKey: 'dead-routines-papercusp', maxRecords: 50 });
    expect(hit.escalations.map((e) => e.msg_id)).toEqual(['e1']);

    // A substring of a real subjectSignature must NOT match (exact, not fuzzy).
    const miss = await listEscalationsPaginated({ conditionKey: 'dead-routines', maxRecords: 50 });
    expect(miss.escalations).toEqual([]);
  });

  it('q does a case-insensitive substring match over summary AND body', async () => {
    configureCoordLog(new InMemoryCoordLog());
    await coordLog.putEvent('escalations', 'e1', {
      ts: '2026-01-01T00:00:01.000Z', msg_id: 'e1', from: 'A', to: ['human'],
      kind: 'escalation', summary: 'GIT-SYNC stall detected', resolved: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await coordLog.putEvent('escalations', 'e2', {
      ts: '2026-01-01T00:00:02.000Z', msg_id: 'e2', from: 'A', to: ['human'],
      kind: 'escalation', summary: 'unrelated advisory', body: 'mentions git-sync in the body only', resolved: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await coordLog.putEvent('escalations', 'e3', {
      ts: '2026-01-01T00:00:03.000Z', msg_id: 'e3', from: 'A', to: ['human'],
      kind: 'escalation', summary: 'totally unrelated', resolved: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const r = await listEscalationsPaginated({ q: 'git-sync', maxRecords: 50 });
    expect(r.escalations.map((e) => e.msg_id).sort()).toEqual(['e1', 'e2']);
  });

  it('a filtered read on the legacy windowed path carries filterWindowCaveat:true — a miss does not prove absence', async () => {
    await seedOpen(3);
    const r = await listEscalationsPaginated({ q: 'no-such-condition', maxRecords: 50 });
    expect(r.escalations).toEqual([]);
    expect(r.filterWindowCaveat).toBe(true);
  });

  it('an UNFILTERED read never carries filterWindowCaveat', async () => {
    await seedOpen(3);
    const r = await listEscalationsPaginated({ maxRecords: 50 });
    expect(r.filterWindowCaveat).toBeUndefined();
  });

  it('conditionKey and q compose as AND when both are supplied', async () => {
    configureCoordLog(new InMemoryCoordLog());
    await coordLog.putEvent('escalations', 'e1', {
      ts: '2026-01-01T00:00:01.000Z', msg_id: 'e1', from: 'A', to: ['human'],
      kind: 'escalation', summary: 'stale condition', resolved: null,
      subjectSignature: 'shared-key',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await coordLog.putEvent('escalations', 'e2', {
      ts: '2026-01-01T00:00:02.000Z', msg_id: 'e2', from: 'A', to: ['human'],
      kind: 'escalation', summary: 'unrelated text', resolved: null,
      subjectSignature: 'shared-key',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const both = await listEscalationsPaginated({ conditionKey: 'shared-key', q: 'stale', maxRecords: 50 });
    expect(both.escalations.map((e) => e.msg_id)).toEqual(['e1']);
  });
});

describe('resolveEscalationsBatch — single-load drain (EI-1490)', () => {
  async function seedOpens(log: InMemoryCoordLog, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 1; i <= n; i++) {
      const id = `e${i}`;
      ids.push(id);
      await log.putEvent('escalations', id, {
        ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        msg_id: id,
        from: 'system:hive-placement-watchdog',
        to: ['human'],
        kind: 'escalation',
        severity: 'advisory',
        summary: `esc ${id}`,
        resolved: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    }
    return ids;
  }

  it('reads the FULL surface exactly ONCE regardless of batch size (no O(n²))', async () => {
    const log = new CountingCoordLog();
    configureCoordLog(log);
    const ids = await seedOpens(log, 25);
    log.readEventsCalls = 0; // ignore the seeding reads (putEvent does none, but be safe)

    const r = await resolveEscalationsBatch(
      ids.map((id) => ({ msg_id: id, choice: 'auto-reconciled', resolver: 'system:test' })),
    );

    expect(r.resolved).toBe(25);
    // The whole batch drained from ONE load — the regression: the old per-item
    // path scanned the entire surface once PER item (would be 25 here).
    expect(log.readEventsCalls).toBe(1);

    // And they really are folded out of the open set afterwards.
    const open = await listEscalationsPaginated({ status: 'open', maxRecords: 500 });
    expect(open.escalations).toHaveLength(0);
  });

  it('reports notFound / alreadyResolved / duplicate-in-batch without extra loads', async () => {
    const log = new CountingCoordLog();
    configureCoordLog(log);
    const [e1] = await seedOpens(log, 1);
    log.readEventsCalls = 0;

    const r = await resolveEscalationsBatch([
      { msg_id: e1, choice: 'x' }, // resolves
      { msg_id: e1, choice: 'x' }, // duplicate in same batch → alreadyResolved
      { msg_id: 'missing', choice: 'x' }, // notFound
    ]);

    expect(r).toMatchObject({ resolved: 1, alreadyResolved: 1, notFound: 1, requiresSpawnApprove: 0 });
    expect(log.readEventsCalls).toBe(1);
  });

  it('never auto-resolves a spawn-approval request', async () => {
    const log = new CountingCoordLog();
    configureCoordLog(log);
    await log.putEvent('escalations', 'spawn1', {
      ts: '2026-01-01T00:00:01.000Z', msg_id: 'spawn1', from: 'bee-7', to: ['human'],
      kind: 'escalation', severity: 'blocker', summary: 'approve spawn?', resolved: null,
      spawnRequest: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const r = await resolveEscalationsBatch([{ msg_id: 'spawn1', choice: 'auto-reconciled' }]);
    expect(r).toMatchObject({ resolved: 0, requiresSpawnApprove: 1 });
  });

  it('empty batch → no load, zero counts', async () => {
    const log = new CountingCoordLog();
    configureCoordLog(log);
    const r = await resolveEscalationsBatch([]);
    expect(r).toEqual({ resolved: 0, notFound: 0, alreadyResolved: 0, requiresSpawnApprove: 0 });
    expect(log.readEventsCalls).toBe(0);
  });
});

describe('openEscalation dedup + advisory expiry (WI-1503)', () => {
  const identity = { ownerId: 'bee-7' } as AgentIdentity;

  describe('WI-6943 — second-person owner-authorship guard', () => {
    const claimCases: Array<[string, OwnerAuthorshipClaimLocation, string | undefined]> = [
      ['Your change broke the release gate', 'summary', undefined],
      ['You wrote the failing resolver', 'summary', undefined],
      ['You have updated this config before', 'summary', undefined],
      ['The regression needs review', 'body', 'You authored the affected patch'],
    ];

    it.each(claimCases)('tags an unverified claim in %s', async (summary, location, body) => {
      configureCoordLog(new InMemoryCoordLog());
      expect(detectOwnerAuthorshipClaim(summary, body)).toBe(location);

      const rec = await openEscalation(identity, {
        severity: 'question',
        summary,
        ...(body ? { body } : {}),
      });

      expect(rec.summary).toBe(`${UNVERIFIED_OWNER_AUTHORSHIP_CLAIM_TAG} ${summary}`);
    });

    it('stays quiet on text that does not attribute owner authorship', async () => {
      configureCoordLog(new InMemoryCoordLog());
      const rec = await openEscalation(identity, {
        severity: 'question',
        summary: 'The proposed change needs review',
        body: 'The release fixer wrote the patch and recorded its evidence.',
      });

      expect(detectOwnerAuthorshipClaim(rec.summary ?? '', rec.body)).toBeNull();
      expect(rec.summary).toBe('The proposed change needs review');
    });

    it('keeps the guard presentation-only for dedup and never stacks the tag', async () => {
      configureCoordLog(new InMemoryCoordLog());
      const summary = 'Your commit still fails the focused test';
      const first = await openEscalation(identity, { severity: 'question', summary });
      const repeated = await openEscalation(identity, { severity: 'question', summary });

      expect(repeated.msg_id).toBe(first.msg_id);
      expect((repeated as Record<string, unknown>).subjectSignature).toBe(summary.toLowerCase());
      expect(repeated.summary).toBe(`${UNVERIFIED_OWNER_AUTHORSHIP_CLAIM_TAG} ${summary}`);
      expect((repeated.summary ?? '').match(/\[UNVERIFIED owner-authorship claim\]/g)).toHaveLength(1);
    });
  });

  it('dedups a repeat open escalation onto the existing row instead of stacking a second open event', async () => {
    configureCoordLog(new InMemoryCoordLog());
    const first = await openEscalation(identity, { severity: 'advisory', summary: 'same subject' });
    const second = await openEscalation(identity, { severity: 'advisory', summary: 'same subject' });

    expect(second.msg_id).toBe(first.msg_id);
    expect((second as Record<string, unknown>).repeatCount).toBe(2);

    const open = await listEscalations({ status: 'open' });
    expect(open.map((e) => e.msg_id)).toEqual([first.msg_id]);

    const raw = await coordLog.readEvents('escalations');
    expect(raw.filter((r) => r.kind === 'escalation')).toHaveLength(1);
  });

  it('EI-20068390701347529: persists a refreshed summary on the non-PG coalescing fallback', async () => {
    const log = new InMemoryCoordLog();
    configureCoordLog(log);
    const meta = { dedupKind: 'infra-liveness', subjectSignature: 'dead-routines' };
    const first = await openEscalation(identity, {
      severity: 'blocker',
      summary: '[infra-liveness] 1 of 151 dead routine(s) overdue >10m: pr-poll',
      meta,
    });
    const refreshed = await openEscalation(identity, {
      severity: 'blocker',
      summary: '[infra-liveness] 101 of 151 dead routine(s) overdue >10m: git-sync',
      meta,
    });

    expect(refreshed.msg_id).toBe(first.msg_id);
    expect(refreshed.summary).toContain('101 of 151');
    expect((await listEscalations({ status: 'open' }))[0]?.summary).toContain('101 of 151');
    const raw = await log.readEvents('escalations');
    expect(raw.filter((r) => r.kind === 'escalation')).toHaveLength(1);
    expect(raw.find((r) => r.msg_id === first.msg_id)?.summary).toContain('101 of 151');
  });

  it('does not dedup across dedupKind boundaries', async () => {
    configureCoordLog(new InMemoryCoordLog());
    const advisory = await openEscalation(identity, { severity: 'advisory', summary: 'same subject' });
    const blocker = await openEscalation(identity, { severity: 'blocker', summary: 'same subject' });

    expect(blocker.msg_id).not.toBe(advisory.msg_id);
    expect((await listEscalations({ status: 'open' })).map((e) => e.msg_id).sort()).toEqual(
      [advisory.msg_id, blocker.msg_id].sort(),
    );
  });

  it('WI-7353: summaries differing ONLY by an embedded duration coalesce onto one row', async () => {
    // Live repro (green-stall:oddsmith, 2026-08-03): the condition-staleness reminder
    // templates the live age into its summary, so a caller omitting meta.subjectSignature
    // derived a FRESH dedup key every tick — 4 open rows for ONE condition (05:04 / 05:08 /
    // 05:19 / 05:40Z) and 97 such rows in 24h. A dedup key containing a monotonically
    // changing value can never dedup, so the derived key must be duration-independent.
    configureCoordLog(new InMemoryCoordLog());
    const at = (m: number) =>
      `[condition-stale] condition 'green-stall:oddsmith' has been OPEN for ${m}m (severe-event)`;

    const first = await openEscalation(identity, { severity: 'advisory', summary: at(50) });
    const second = await openEscalation(identity, { severity: 'advisory', summary: at(51) });
    const third = await openEscalation(identity, { severity: 'advisory', summary: at(81) });

    expect(second.msg_id).toBe(first.msg_id);
    expect(third.msg_id).toBe(first.msg_id);
    expect((await listEscalations({ status: 'open' })).map((e) => e.msg_id)).toEqual([first.msg_id]);
  });

  it('WI-7353: neutralizing durations does NOT collapse subjects that merely contain digits', async () => {
    // The guard must stay NARROW. Over-collapsing is a worse failure than the flood it
    // replaces — it would silently merge unrelated conditions onto one row, hiding real
    // alerts. Each pair below differs by a digit that is NOT a duration: an ordinal, a
    // percentage, and a hyphen-attached token (not whitespace-preceded).
    configureCoordLog(new InMemoryCoordLog());
    const distinct = [
      'pot alpha-1 is down',
      'pot alpha-2 is down',
      'disk 80% full',
      'disk 90% full',
      'harness-3d backlog stalled',
      'harness-5d backlog stalled',
    ];
    const ids: string[] = [];
    for (const summary of distinct) {
      ids.push((await openEscalation(identity, { severity: 'advisory', summary })).msg_id);
    }
    expect(new Set(ids).size).toBe(distinct.length);
  });

  it('EI-12546: a conditionKey (meta.subjectSignature) coalesces across a severity escalation instead of forking a parallel open row', async () => {
    // Live repro: 'kettle-invalid-model-config' was first filed severity:advisory,
    // then re-escalated severity:blocker as the anomaly graduated. Pre-fix, dedupKind
    // defaulted to severity even with an explicit conditionKey, so the blocker
    // call missed the advisory row and coord:escalations showed TWO open rows with
    // the same subjectSignature. Post-fix it must be ONE row, upgraded to blocker.
    configureCoordLog(new InMemoryCoordLog());
    const meta = { subjectSignature: 'kettle-invalid-model-config' };
    const advisory = await openEscalation(identity, { severity: 'advisory', summary: 'invalid model config (warning)', meta });
    const blocker = await openEscalation(identity, { severity: 'blocker', summary: 'invalid model config (critical)', meta });

    // Coalesced onto the ONE existing open row (same msg_id), no new escalation event.
    expect(blocker.msg_id).toBe(advisory.msg_id);
    expect((blocker as Record<string, unknown>).repeatCount).toBe(2);
    // Row's severity upgraded to the latest (escalated) call — the escalation is
    // not lost/hidden under the original advisory.
    expect(blocker.severity).toBe('blocker');

    const open = await listEscalations({ status: 'open' });
    expect(open.map((e) => e.msg_id)).toEqual([advisory.msg_id]);

    const raw = await coordLog.readEvents('escalations');
    expect(raw.filter((r) => r.kind === 'escalation')).toHaveLength(1);
  });

  it('auto-expires only stale advisory escalations; blocker/question rows remain open', async () => {
    configureCoordLog(new InMemoryCoordLog());
    await coordLog.putEvent('escalations', 'adv-old', {
      ts: '2026-01-01T00:00:00.000Z',
      msg_id: 'adv-old',
      from: 'bee-1',
      to: ['human'],
      kind: 'escalation',
      severity: 'advisory',
      summary: 'old advisory',
      resolved: null,
      dedupKind: 'advisory',
      subjectSignature: 'old advisory',
      repeatCount: 1,
      lastSeenTs: '2026-01-01T00:00:00.000Z',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await coordLog.putEvent('escalations', 'ask-old', {
      ts: '2026-01-01T00:00:00.000Z',
      msg_id: 'ask-old',
      from: 'bee-2',
      to: ['human'],
      kind: 'escalation',
      severity: 'question',
      summary: 'old question',
      resolved: null,
      dedupKind: 'question',
      subjectSignature: 'old question',
      repeatCount: 1,
      lastSeenTs: '2026-01-01T00:00:00.000Z',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await coordLog.putEvent('escalations', 'block-old', {
      ts: '2026-01-01T00:00:00.000Z',
      msg_id: 'block-old',
      from: 'bee-3',
      to: ['human'],
      kind: 'escalation',
      severity: 'blocker',
      summary: 'old blocker',
      resolved: null,
      dedupKind: 'blocker',
      subjectSignature: 'old blocker',
      repeatCount: 1,
      lastSeenTs: '2026-01-01T00:00:00.000Z',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const out = await expireStaleAdvisoryEscalations({
      olderThanMs: 60 * 60 * 1000,
      limit: 10,
    });

    expect(out).toMatchObject({ scanned: 3, eligible: 1, expired: 1, truncated: false });
    expect((await listEscalations({ status: 'open' })).map((e) => e.msg_id).sort()).toEqual(['ask-old', 'block-old']);
    expect((await listEscalations({ status: 'resolved' })).map((e) => e.msg_id)).toContain('adv-old');
  });
});

describe('openEscalation — harness_slug federation (WI-1375)', () => {
  const identity = { ownerId: 'bee-7' } as AgentIdentity;

  it('stamps harness_slug on the record when a harness-scoped agent escalates (federates to the hub)', async () => {
    const log = new InMemoryCoordLog();
    configureCoordLog(log);
    const rec = await openEscalation(identity, {
      severity: 'blocker',
      summary: 'need a human',
      harness_slug: 'shared-hive',
    });
    // Federation column PgCoordLog projects to coord_event_log.harness_slug: a
    // peer-machine escalation "to human" now reaches the hub inbox (NOT NULL ⇒ capture enqueues).
    expect(rec.harness_slug).toBe('shared-hive');
    expect(rec.to).toEqual(['human']); // still addressed to the human — the scope only routes it there
    const persisted = await log.getEvent('escalations', rec.msg_id);
    expect((persisted as { harness_slug?: string }).harness_slug).toBe('shared-hive');
  });

  it('leaves harness_slug unset for an operator/SU escalation (stays workspace-local)', async () => {
    const log = new InMemoryCoordLog();
    configureCoordLog(log);
    // The coord:escalate tool passes NO harness_slug for a '*'/unset scope; the adapter
    // must not invent one, so the record stays LOCAL (unfederated).
    const rec = await openEscalation(identity, { severity: 'advisory', summary: 'fyi' });
    expect('harness_slug' in rec).toBe(false);
  });

  it('keeps meta.harnessSlug (inbox chat-scoping) distinct from the top-level harness_slug (federation)', async () => {
    const log = new InMemoryCoordLog();
    configureCoordLog(log);
    const rec = await openEscalation(identity, {
      severity: 'question',
      summary: 'which way?',
      harness_slug: 'shared-hive',
      meta: { harnessSlug: 'shared-hive' },
    });
    expect(rec.harness_slug).toBe('shared-hive'); // federation column (snake_case)
    expect((rec as { harnessSlug?: string }).harnessSlug).toBe('shared-hive'); // human-inbox chat scope (camelCase, via meta)
  });
});

/**
 * WI-10769 — the recurrence guard, driving the REAL `resolveEscalation` (not a
 * restatement of its gate, which is how writer and gate drifted apart before).
 *
 * The defect: the presence check and the write were not atomic and the write was
 * keyed on a FRESH msg_id, so N concurrent workers each wrote a DISTINCT resolve
 * row and each got a record back — while `liveness-alarm.ts` gates its recovery
 * announcement on exactly that return value, under a comment promising "only the
 * worker whose resolve actually landed announces it". Measured 3.10x
 * amplification on papercusp (65 events / 21 real recoveries).
 */
describe('resolveEscalation — concurrent resolves elect ONE announcer (WI-10769)', () => {
  const identity = { ownerId: 'su-test' } as AgentIdentity;

  async function openOne(log: InMemoryCoordLog) {
    configureCoordLog(log);
    return openEscalation(identity, { severity: 'question', summary: 'flapping condition' });
  }

  it('awaits a linked card decision before recording success and leaves a refused decision open', async () => {
    const log = new InMemoryCoordLog();
    const opened = await openOne(log);
    await expect(resolveEscalation({ msg_id: opened.msg_id, choice: 'yes' }, {
      beforeResolve: async () => { throw new Error('card-needs-reconciliation'); },
    })).rejects.toThrow('card-needs-reconciliation');
    expect((await log.readEvents('escalations')).filter(row => row.kind === 'escalation_resolved')).toEqual([]);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const pending = resolveEscalation({ msg_id: opened.msg_id, choice: 'yes' }, {
      beforeResolve: async open => { expect(open.msg_id).toBe(opened.msg_id); started(); await gate; },
    });
    await entered;
    expect((await log.readEvents('escalations')).filter(row => row.kind === 'escalation_resolved')).toEqual([]);
    release();
    expect(await pending).toMatchObject({ msg_id: opened.msg_id });
    expect((await log.readEvents('escalations')).filter(row => row.kind === 'escalation_resolved')).toHaveLength(1);
  });

  it('N concurrent resolves: exactly ONE returns a record, the rest report already_resolved', async () => {
    const log = new InMemoryCoordLog();
    const opened = await openOne(log);

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        resolveEscalation({ msg_id: opened.msg_id, choice: 'auto-resolved', note: `worker ${i}`, resolver: `w${i}` }),
      ),
    );

    const winners = outcomes.filter((o) => typeof o !== 'string');
    const losers = outcomes.filter((o) => o === 'already_resolved');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(7);
    // No outcome may be a DIFFERENT sentinel — 'not_found' here would mean the open
    // row went missing, a different bug wearing the same "did not announce" costume.
    expect(outcomes.filter((o) => o === 'not_found' || o === 'requires_spawn_approve')).toHaveLength(0);
  });

  it('N concurrent resolves write exactly ONE escalation_resolved row', async () => {
    const log = new InMemoryCoordLog();
    const opened = await openOne(log);

    await Promise.all(
      Array.from({ length: 8 }, () =>
        resolveEscalation({ msg_id: opened.msg_id, choice: 'auto-resolved', resolver: 'w' }),
      ),
    );

    const rows = (await log.readEvents('escalations')).filter((r) => r.kind === 'escalation_resolved');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.related_msg_id).toBe(opened.msg_id);
    // The row's identity is DERIVED from its target — that is what makes a second
    // row impossible at the key level, not merely unlikely.
    expect(rows[0]?.msg_id).toBe(resolvedEventId(opened.msg_id));
  });

  it('CONTROL: the pre-fix keying (a fresh id per writer) would have written 8 rows', async () => {
    // Proves the guard above is measuring the fix and not something incidental —
    // with the OLD key derivation, the same 8 concurrent writers collide on nothing.
    const log = new InMemoryCoordLog();
    configureCoordLog(log);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        log.putEventIfAbsent('escalations', `fresh-id-${i}`, {
          ts: '2026-01-01T00:00:00.000Z', msg_id: `fresh-id-${i}`, from: 'w', to: ['human'],
          kind: 'escalation_resolved', related_msg_id: 'target-1', summary: 'resolved: auto-resolved',
        } as never),
      ),
    );
    const rows = (await log.readEvents('escalations')).filter((r) => r.related_msg_id === 'target-1');
    expect(rows).toHaveLength(8); // ← the measured production symptom
  });

  it('a resolve of an ALREADY-resolved row still reports already_resolved (sequential path unchanged)', async () => {
    const log = new InMemoryCoordLog();
    const opened = await openOne(log);
    const first = await resolveEscalation({ msg_id: opened.msg_id, choice: 'auto-resolved', resolver: 'w1' });
    expect(typeof first).not.toBe('string');
    expect(await resolveEscalation({ msg_id: opened.msg_id, choice: 'auto-resolved', resolver: 'w2' })).toBe('already_resolved');
  });

  it('an unknown msg_id still reports not_found (the gate did not swallow it)', async () => {
    configureCoordLog(new InMemoryCoordLog());
    expect(await resolveEscalation({ msg_id: 'nope', choice: 'auto-resolved', resolver: 'w' })).toBe('not_found');
  });

  it('reopen appends a compensation and the next resolve closes generation 1', async () => {
    const log = new InMemoryCoordLog();
    const opened = await openOne(log);
    await resolveEscalation({ msg_id: opened.msg_id, choice: 'first', resolver: 'resolver-1' });

    const reopened = await reopenEscalation({
      msg_id: opened.msg_id,
      by: 'owner',
      note: 'undo unattended pass',
    });
    expect(typeof reopened).not.toBe('string');
    expect((await listEscalations({ status: 'open' })).map((row) => row.msg_id)).toEqual([opened.msg_id]);

    await resolveEscalation({ msg_id: opened.msg_id, choice: 'second', resolver: 'resolver-2' });
    const events = await log.readEvents('escalations');
    expect(events.filter((event) => event.kind === 'escalation_reopened')).toHaveLength(1);
    const resolves = events.filter((event) => event.kind === 'escalation_resolved');
    expect(resolves.map((event) => event.msg_id).sort()).toEqual([
      resolvedEventId(opened.msg_id),
      resolvedEventId(opened.msg_id, 1),
    ].sort());
    expect(resolves.find((event) => event.msg_id === resolvedEventId(opened.msg_id, 1))?.generation).toBe(1);
  });
});

/**
 * WI-10769 (BATCH path) — the same read-then-write shape as `resolveEscalation`
 * above, and the site that actually drains the backlog: one load at the top, the
 * `alreadyResolved` check against that snapshot, one batched `putEvents` at the
 * bottom. Two sweeps racing the same backlog each load a snapshot in which the
 * escalation is still open, so both write.
 *
 * The asymmetry with the single path is DELIBERATE: a drain sweep reports COUNTS
 * and pages nobody, so it needs the ROW to be unique but does not need to elect a
 * single announcer. Both sweeps may therefore report `resolved: 1`. What must
 * never happen is two rows — that is the amplification WI-10769 measured.
 */
describe('resolveEscalationsBatch — concurrent sweeps collapse onto ONE row (WI-10769)', () => {
  const identity = { ownerId: 'su-test' } as AgentIdentity;

  it('two sweeps racing the same escalation write exactly ONE escalation_resolved row', async () => {
    const log = new InMemoryCoordLog();
    configureCoordLog(log);
    const opened = await openEscalation(identity, { severity: 'question', summary: 'drained twice' });

    await Promise.all([
      resolveEscalationsBatch([{ msg_id: opened.msg_id, choice: 'auto-reconciled', resolver: 'sweepA' }]),
      resolveEscalationsBatch([{ msg_id: opened.msg_id, choice: 'auto-reconciled', resolver: 'sweepB' }]),
    ]);

    const rows = (await log.readEvents('escalations')).filter((r) => r.kind === 'escalation_resolved');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.related_msg_id).toBe(opened.msg_id);
    // Identity DERIVED from the target — what makes the second write a no-op at the
    // key level rather than merely unlikely to interleave.
    expect(rows[0]?.msg_id).toBe(resolvedEventId(opened.msg_id));
  });

  it('8 sweeps over a 3-escalation backlog write exactly 3 rows, one per escalation', async () => {
    const log = new InMemoryCoordLog();
    configureCoordLog(log);
    const opens = await Promise.all(
      ['a', 'b', 'c'].map((s) => openEscalation(identity, { severity: 'question', summary: `backlog ${s}` })),
    );
    const batch = opens.map((o) => ({ msg_id: o.msg_id, choice: 'auto-reconciled', resolver: 'sweep' }));

    await Promise.all(Array.from({ length: 8 }, () => resolveEscalationsBatch(batch)));

    const rows = (await log.readEvents('escalations')).filter((r) => r.kind === 'escalation_resolved');
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.msg_id))).toEqual(
      new Set(opens.map((o) => resolvedEventId(o.msg_id))),
    );
  });

  it('CONTROL: the pre-fix keying (a fresh id per sweep) would have written 2 rows', async () => {
    // Proves the guard above measures the DERIVED KEY and not some incidental
    // serialization of the two sweeps — with the old keying they collide on nothing.
    const log = new InMemoryCoordLog();
    configureCoordLog(log);
    await Promise.all(
      ['sweepA', 'sweepB'].map((w) =>
        log.putEvents('escalations', [
          {
            msgId: `fresh-${w}`,
            record: {
              ts: '2026-01-01T00:00:00.000Z', msg_id: `fresh-${w}`, from: w, to: ['human'],
              kind: 'escalation_resolved', related_msg_id: 'target-batch', summary: 'resolved: auto-reconciled',
            } as never,
          },
        ]),
      ),
    );
    const rows = (await log.readEvents('escalations')).filter((r) => r.related_msg_id === 'target-batch');
    expect(rows).toHaveLength(2); // ← the measured production symptom
  });

  it('a sweep over an ALREADY-resolved row reports alreadyResolved and writes nothing new', async () => {
    const log = new InMemoryCoordLog();
    configureCoordLog(log);
    const opened = await openEscalation(identity, { severity: 'question', summary: 'already done' });

    const first = await resolveEscalationsBatch([{ msg_id: opened.msg_id, choice: 'auto-reconciled' }]);
    expect(first.resolved).toBe(1);
    const second = await resolveEscalationsBatch([{ msg_id: opened.msg_id, choice: 'auto-reconciled' }]);
    expect(second.resolved).toBe(0);
    expect(second.alreadyResolved).toBe(1);

    const rows = (await log.readEvents('escalations')).filter((r) => r.kind === 'escalation_resolved');
    expect(rows).toHaveLength(1);
  });
});

/**
 * WI-10005375 — an escalation is resolved by a SIBLING event (`escalation_resolved`, keyed
 * `related_msg_id`), so the stored open record says `resolved:null` forever. coord:read
 * returned that raw record, so a withdrawn ask read as still open. `foldEscalationResolution`
 * is the single-record fold coord:read now applies. InMemoryCoordLog has no `getSql`, so this
 * drives the replay fallback; the PG targeted read is pinned in
 * resolve-message-ref.integration.test.ts.
 */
describe('foldEscalationResolution — single-record fold (WI-10005375)', () => {
  const identity = { ownerId: 'su-test' } as AgentIdentity;

  it('folds ONLY the target escalation, and follows a reopen back to open', async () => {
    configureCoordLog(new InMemoryCoordLog());
    const target = await openEscalation(identity, { severity: 'question', summary: 'withdrawn ask' });
    const other = await openEscalation(identity, { severity: 'question', summary: 'still open ask' });
    expect(target.msg_id).not.toBe(other.msg_id);
    await resolveEscalation({ msg_id: target.msg_id, choice: 'superseded', resolver: 'su-test' });

    // The raw stored record is what coord:read used to return: unresolved by construction.
    const rawTarget = await coordLog.getEvent('escalations', target.msg_id);
    expect(rawTarget?.resolved).toBeNull();

    const folded = await foldEscalationResolution(rawTarget as never);
    expect(folded.resolved?.choice).toBe('superseded');
    expect(folded.resolved?.by).toBe('su-test');
    expect((await getEscalation(target.msg_id))?.resolved?.choice).toBe('superseded');

    // A resolution of ONE escalation must not leak onto another.
    const rawOther = await coordLog.getEvent('escalations', other.msg_id);
    expect((await foldEscalationResolution(rawOther as never)).resolved).toBeNull();

    await reopenEscalation({ msg_id: target.msg_id, by: 'owner', note: 'not withdrawn after all' });
    expect((await foldEscalationResolution(rawTarget as never)).resolved).toBeNull();
  });
});
