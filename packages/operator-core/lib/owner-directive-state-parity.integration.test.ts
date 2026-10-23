/**
 * owner-directive-state-parity.integration.test.ts — real-PG proof for P-005 of plan
 * `turn-start-memory-two-class-2026-09-21` (the `orders:list` state filter), narrowed to
 * the three-state lifecycle by D-001 of `owner-directive-delivery-redesign-2026-09-22`.
 *
 * WHY THIS FILE EXISTS. The lifecycle precedence is expressed TWICE: once as the pure
 * `ownerDirectiveState()` in TypeScript, and once as a SQL `CASE` inside
 * `listOwnerDirectives()` so the predicate can run in the database. Two expressions of
 * one rule drift silently, and the drift is invisible in the worst way: the filter would
 * start disagreeing with the `state` field it returns on the very same row, so
 * `orders:list { state:'open' }` could omit a directive whose own rendered state reads
 * `open`. No typecheck sees that — the types are identical either way.
 *
 * The load-bearing assertion is therefore not "the filter returns rows" but the PARTITION
 * test plus the per-state agreement: filtering by S must return exactly the rows whose
 * INDEPENDENTLY-derived TS state is S, and the three states must classify every row exactly
 * once. Change either expression alone and that fails.
 *
 * The last test pins the property that motivated the filter at all: the predicate is
 * applied in SQL BEFORE `limit`. Filtering client-side over a limited page cannot do this
 * — a matching row truncated away by non-matching rows ahead of it reads as a genuine
 * absence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import {
  OWNER_DIRECTIVE_STATES,
  dispositionOwnerDirective,
  listOwnerDirectives,
  loadOpenOwnerDirectives,
  ownerDirectiveState,
  renderOwnerDirectivesBlock,
  recordOwnerDirective,
  type OwnerDirectiveState,
} from './owner-directives';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('owner-directive lifecycle state: SQL filter vs TS derivation (P-005)', () => {
  let db: OrgTestDb;
  const workspaceId = 'owner-directive-state-parity-ws';
  const expectedByState = new Map<OwnerDirectiveState, number>();

  async function record(turnRef: string, text: string): Promise<number> {
    const row = await recordOwnerDirective(
      {
        workspaceId,
        sessionRef: 'session-parity',
        sourceTurnRef: turnRef,
        verbatimText: text,
        recordedBy: 'su-parity-test',
        capturedByHook: true,
      },
      db.adminSql,
    );
    return row.id;
  }

  beforeAll(async () => {
    db = await createOrgTestDb();

    // open — every captured owner turn lands here (D-001).
    expectedByState.set('open', await record('turn-open', 'an open directive'));

    // done — carried out and dispositioned.
    const toDo = await record('turn-done', 'please do the thing');
    await dispositionOwnerDirective(
      { id: toDo, status: 'done', note: 'carried out, see WI-parity', dispositionedBy: 'su-parity-test' },
      db.adminSql,
    );
    expectedByState.set('done', toDo);

    // declined — consciously refused with a reason. Newest row, which the
    // limit-ordering test below depends on.
    const toDecline = await record('turn-declined', 'please do the other thing');
    await dispositionOwnerDirective(
      {
        id: toDecline,
        status: 'declined',
        note: 'out of scope; explained to owner',
        dispositionedBy: 'su-parity-test',
      },
      db.adminSql,
    );
    expectedByState.set('declined', toDecline);
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup?.();
  });

  it('CONTROL: the fixture really populates all three states (else every filter below passes vacuously)', async () => {
    const all = await listOwnerDirectives({ workspaceId, limit: 200 }, db.adminSql);
    expect(all).toHaveLength(3);
    expect(all.map((r) => ownerDirectiveState(r)).sort()).toEqual([...OWNER_DIRECTIVE_STATES].sort());
  });

  it.each([...OWNER_DIRECTIVE_STATES])(
    'state=%s returns exactly the rows whose independently-derived TS state matches',
    async (state) => {
      const rows = await listOwnerDirectives({ workspaceId, state, limit: 200 }, db.adminSql);
      // The SQL predicate selected precisely the expected row...
      expect(rows.map((r) => r.id)).toEqual([expectedByState.get(state)]);
      // ...and the TS derivation independently agrees about what that row is.
      expect(rows.map((r) => ownerDirectiveState(r))).toEqual([state]);
    },
  );

  it('the three states PARTITION the population — every row classified exactly once', async () => {
    const seen: number[] = [];
    for (const state of OWNER_DIRECTIVE_STATES) {
      const rows = await listOwnerDirectives({ workspaceId, state, limit: 200 }, db.adminSql);
      seen.push(...rows.map((r) => r.id));
    }
    const all = await listOwnerDirectives({ workspaceId, limit: 200 }, db.adminSql);
    expect([...seen].sort()).toEqual(all.map((r) => r.id).sort());
    expect(new Set(seen).size).toBe(seen.length); // no row claimed by two states
  });

  it('accepts a state ARRAY and unions them', async () => {
    const rows = await listOwnerDirectives({ workspaceId, state: ['done', 'declined'], limit: 200 }, db.adminSql);
    expect(rows.map((r) => ownerDirectiveState(r)).sort()).toEqual(['declined', 'done']);
  });

  it('the boolean `open` agrees with the state filter now that open is exactly one state', async () => {
    const openTrue = await listOwnerDirectives({ workspaceId, open: true, limit: 200 }, db.adminSql);
    expect(openTrue.map((r) => ownerDirectiveState(r))).toEqual(['open']);

    const openFalse = await listOwnerDirectives({ workspaceId, open: false, limit: 200 }, db.adminSql);
    expect(openFalse.map((r) => ownerDirectiveState(r)).sort()).toEqual(['declined', 'done']);
  });

  it('applies the predicate BEFORE limit — a match is not truncated away by non-matches ahead of it', async () => {
    // `declined` is the NEWEST row and ordering is created_at ASC, so two
    // non-matching rows sit ahead of it. A client-side filter over a 1-row page
    // would see nothing and read that as "no declined directives exist".
    const rows = await listOwnerDirectives({ workspaceId, state: 'declined', limit: 1 }, db.adminSql);
    expect(rows).toHaveLength(1);
    expect(ownerDirectiveState(rows[0])).toBe('declined');

    // CONTROL: the same limit WITHOUT the filter returns a different (older) row,
    // proving the limit really was small enough to have hidden the match.
    const unfiltered = await listOwnerDirectives({ workspaceId, limit: 1 }, db.adminSql);
    expect(unfiltered).toHaveLength(1);
    expect(ownerDirectiveState(unfiltered[0])).not.toBe('declined');
  });

  it('keeps own overflow separate from foreign counts when own rows fill the page', async () => {
    const countWorkspace = 'owner-directive-count-summary-ws';
    const viewerOwnerId = 'su-count-summary';
    await Promise.all(Array.from({ length: 20 }, (_, i) => recordOwnerDirective({
      workspaceId: countWorkspace,
      sourceTurnRef: `count-summary-turn-${i}`,
      verbatimText: `Count summary request ${i}`,
      recordedBy: i < 17 ? viewerOwnerId : 'su-count-summary-peer',
    }, db.adminSql)));

    const snapshot = await loadOpenOwnerDirectives(countWorkspace, { sql: db.adminSql, viewerOwnerId });
    expect(snapshot.rows).toHaveLength(12);
    expect(snapshot.rows.every((row) => row.recordedBy === viewerOwnerId)).toBe(true);
    expect(snapshot.totalOpen).toBe(20);
    expect(snapshot.totalOwnOpen).toBe(17);
    const out = renderOwnerDirectivesBlock(snapshot.rows, { ...snapshot, viewerOwnerId })!;
    expect(out).toContain('+5 more open for this session');
    expect(out).toContain('Other sessions: 3 open directives');
    expect(out).not.toContain('su-count-summary-peer');
  });

  it('applies the recordedBy ledger filter before limit', async () => {
    const filterWorkspace = 'owner-directive-recorded-by-filter-ws';
    const recordFor = (turnRef: string, recordedBy: string, text: string) => recordOwnerDirective(
      {
        workspaceId: filterWorkspace,
        sessionRef: 'session-recorded-by-filter',
        sourceTurnRef: turnRef,
        verbatimText: text,
        recordedBy,
        capturedByHook: true,
      },
      db.adminSql,
    );
    const peerId = (await recordFor('turn-peer', 'su-peer-filter-test', 'peer directive')).id;
    const mineId = (await recordFor('turn-mine', 'su-mine-filter-test', 'my directive')).id;

    const mine = await listOwnerDirectives({
      workspaceId: filterWorkspace,
      recordedBy: 'su-mine-filter-test',
      limit: 1,
    }, db.adminSql);
    expect(mine.map((row) => row.id)).toEqual([mineId]);

    const other = await listOwnerDirectives({
      workspaceId: filterWorkspace,
      excludeRecordedBy: 'su-mine-filter-test',
      limit: 1,
    }, db.adminSql);
    expect(other.map((row) => row.id)).toEqual([peerId]);

    // The peer row is older and would take the unfiltered one-row page first.
    const unfiltered = await listOwnerDirectives({ workspaceId: filterWorkspace, limit: 1 }, db.adminSql);
    expect(unfiltered.map((row) => row.id)).toEqual([peerId]);
  });

  it('a hook-verified all-agents resume closes only the system-wide pause it explicitly lifts', async () => {
    const supersessionWorkspace = 'owner-directive-resume-supersession-ws';
    const olderPause = await recordOwnerDirective(
      {
        workspaceId: supersessionWorkspace,
        sourceTurnRef: 'turn-older-system-pause',
        verbatimText: 'pause all agents system-wide, and pause their work until the previous maintenance ends.',
        recordedBy: 'su-older-pause-capture',
        capturedByHook: true,
      },
      db.adminSql,
    );
    const pause = await recordOwnerDirective(
      {
        workspaceId: supersessionWorkspace,
        sourceTurnRef: 'turn-system-pause',
        verbatimText: 'tell all agents system wide to get to a good stopping point and then to pause their work.',
        recordedBy: 'su-pause-capture',
        capturedByHook: true,
      },
      db.adminSql,
    );
    const unrelatedPause = await recordOwnerDirective(
      {
        workspaceId: supersessionWorkspace,
        sourceTurnRef: 'turn-project-pause',
        verbatimText: 'pause the release agent work until the packaging check finishes.',
        recordedBy: 'su-project-pause-capture',
        capturedByHook: true,
      },
      db.adminSql,
    );
    const resume = await recordOwnerDirective(
      {
        workspaceId: supersessionWorkspace,
        sourceTurnRef: 'turn-system-resume',
        verbatimText: 'Tell all agents that were active before the pause to resume their work.',
        recordedBy: 'su-resume-capture',
        capturedByHook: true,
      },
      db.adminSql,
    );

    const rows = await listOwnerDirectives({ workspaceId: supersessionWorkspace, limit: 200 }, db.adminSql);
    const lifted = rows.find((row) => row.id === pause.id)!;
    const older = rows.find((row) => row.id === olderPause.id)!;
    const unrelated = rows.find((row) => row.id === unrelatedPause.id)!;
    const newDirective = rows.find((row) => row.id === resume.id)!;

    expect(lifted.dispositionStatus).toBe('done');
    expect(lifted.dispositionNote).toContain('Superseded by owner directive #' + resume.id);
    expect(lifted.dispositionedBy).toBe('su-resume-capture');
    expect(ownerDirectiveState(lifted)).toBe('done');
    expect(ownerDirectiveState(older)).toBe('open');
    expect(unrelated.dispositionedAtMs).toBeNull();
    expect(newDirective.dispositionedAtMs).toBeNull();
    expect(ownerDirectiveState(newDirective)).toBe('open');
  });

  it('does not let a manually recorded, non-hook directive supersede a system-wide pause', async () => {
    const supersessionWorkspace = 'owner-directive-unverified-resume-ws';
    const pause = await recordOwnerDirective(
      {
        workspaceId: supersessionWorkspace,
        sourceTurnRef: 'turn-unverified-pause',
        verbatimText: 'tell all agents system wide to pause their work.',
        recordedBy: 'su-pause-capture',
        capturedByHook: true,
      },
      db.adminSql,
    );
    await recordOwnerDirective(
      {
        workspaceId: supersessionWorkspace,
        sourceTurnRef: 'turn-unverified-resume',
        verbatimText: 'Tell all agents that were active before the pause to resume their work.',
        recordedBy: 'su-manual-record',
        capturedByHook: false,
      },
      db.adminSql,
    );

    const rows = await listOwnerDirectives({ workspaceId: supersessionWorkspace, limit: 200 }, db.adminSql);
    expect(ownerDirectiveState(rows.find((row) => row.id === pause.id)!)).toBe('open');
  });
});
