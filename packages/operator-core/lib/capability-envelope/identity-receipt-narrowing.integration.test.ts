/**
 * Real-PostgreSQL contract for the identity gate's narrowed body read
 * (WI-10004801, #1155): the SQL in `selectNarrowedLaunchSpecBody` must return
 * exactly what `narrowIdentityHistory` states, for every record shape the
 * column can hold, and must return the record whole when asked to. The
 * per-row form the wedged-identity watchdog reads through
 * (`narrowedLaunchSpecToAppliedPairSql`, WI-10004803) is held to the same
 * statement, for every shape the applied pair can take.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import {
  narrowedLaunchSpecToAppliedPairSql,
  narrowIdentityHistory,
  selectNarrowedLaunchSpecBody,
} from './identity-receipt-narrowing';

const { createOrgTestDb } = await import('../../test/_org-test-db');
const { readGateSelectedLaunchSpec } = await import('../agent-tools/coordination/control-anchor');
const { selectAppliedReceipt } = await import('./identity-grants-port');

const A = { specificationRevision: 'a'.repeat(64), stateRevision: 'state-a' };
const B = { specificationRevision: 'b'.repeat(64), stateRevision: 'state-b' };
const C = { specificationRevision: 'c'.repeat(64), stateRevision: 'state-c' };
const receipt = (pair: typeof A, tag: string) => ({ ...pair, specificationArtifact: { tag, bytes: 'x'.repeat(256) } });

const WORKSPACE = 'identity-receipt-narrowing-ws';
const OWNER = 'su-narrowing-owner';

const SPECS: Array<[string, unknown]> = [
  ['history matches once and other entries are dropped', {
    ...receipt(C, 'top'), workspaceId: WORKSPACE, harnessSlug: 'h',
    identityHistory: [receipt(B, 'b'), receipt(A, 'a'), receipt(C, 'older-c')],
  }],
  ['the state revision must match too, not just the specification revision', {
    ...receipt(C, 'top'),
    identityHistory: [{ ...receipt(A, 'same-spec-other-state'), stateRevision: 'state-other' }, receipt(A, 'a')],
  }],
  ['duplicates keep stored order', {
    ...receipt(C, 'top'), identityHistory: [receipt(A, 'first'), receipt(B, 'b'), receipt(A, 'second')],
  }],
  ['junk entries never survive', {
    ...receipt(C, 'top'), identityHistory: [7, 'x', null, [receipt(A, 'nested')], receipt(A, 'a')],
  }],
  ['type-exact equality: a numeric revision does not match its string', {
    ...receipt(C, 'top'), identityHistory: [{ specificationRevision: 1, stateRevision: 'state-a' }],
  }],
  ['history that is not an array is returned as stored', { ...receipt(C, 'top'), identityHistory: receipt(A, 'a') }],
  ['no history key is returned as stored', { ...receipt(A, 'top') }],
  ['a non-object record is returned as stored', ['not', 'an', 'object']],
  ['a scalar record is returned as stored', 'scalar'],
];

describe('selectNarrowedLaunchSpecBody (real PostgreSQL, WI-10004801)', () => {
  let db: OrgTestDb;
  const ids = new Map<string, number>();

  beforeAll(async () => {
    db = await createOrgTestDb();
    for (const [name, spec] of SPECS) {
      const [row] = await db.adminSql<Array<{ id: number }>>`
        INSERT INTO harness_shared.adv_sessions (workspace_id, mode, coord_owner_id, launch_spec)
        VALUES (${WORKSPACE}, 'console', ${OWNER}, ${JSON.stringify(spec)}::text::jsonb)
        RETURNING id`;
      ids.set(name, Number(row.id));
      // The gate-selected read (readGateSelectedLaunchSpec): one owner per shape,
      // holding the open row plus a NEWER ended decoy the selection must skip.
      await db.adminSql`
        INSERT INTO harness_shared.adv_sessions (workspace_id, mode, coord_owner_id, launch_spec, started_at, ended_at)
        VALUES (${WORKSPACE}, 'console', ${gateOwner(name)}, '{"decoy":true}'::jsonb, now(), now())`;
      await db.adminSql`
        INSERT INTO harness_shared.adv_sessions (workspace_id, mode, coord_owner_id, launch_spec, started_at)
        VALUES (${WORKSPACE}, 'console', ${gateOwner(name)}, ${JSON.stringify(spec)}::text::jsonb, now() - interval '1 hour')`;
    }
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  for (const [name, spec] of SPECS) {
    for (const revisions of [[A], [A, B], [], [{ specificationRevision: '1', stateRevision: 'state-a' }]]) {
      it(`${name} — ${JSON.stringify(revisions.map((pair) => pair.stateRevision))}`, async () => {
        const rows = await selectNarrowedLaunchSpecBody(db.adminSql, {
          advSessionId: ids.get(name)!, ownerId: OWNER, workspaceId: WORKSPACE, revisions,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].launch_spec).toEqual(narrowIdentityHistory(spec, revisions));
        expect(typeof rows[0].launch_spec_xmin).toBe('string');
      });
    }
  }

  it('reads the record whole when no receipts are requested, or when a pair is malformed', async () => {
    const name = SPECS[0][0];
    for (const revisions of [null, [{ specificationRevision: A.specificationRevision }]]) {
      const rows = await selectNarrowedLaunchSpecBody(db.adminSql, {
        advSessionId: ids.get(name)!, ownerId: OWNER, workspaceId: WORKSPACE, revisions,
      });
      expect(rows[0].launch_spec).toEqual(SPECS[0][1]);
    }
  });

  it('keeps the selection scoped to the row, owner and workspace', async () => {
    const id = ids.get(SPECS[0][0])!;
    const rows = await Promise.all([
      selectNarrowedLaunchSpecBody(db.adminSql, { advSessionId: id, ownerId: 'someone-else', workspaceId: WORKSPACE, revisions: [A] }),
      selectNarrowedLaunchSpecBody(db.adminSql, { advSessionId: id, ownerId: OWNER, workspaceId: 'other-ws', revisions: [A] }),
    ]);
    expect(rows.map((r) => r.length)).toEqual([0, 0]);
  });

  // WI-10004803: the watchdog's pair is a COLUMN of `n` (each owner's own
  // control_state->activation->applied), not one bound parameter. It must equal
  // narrowIdentityHistory(spec, [pair]) for every shape that column can hold:
  // only two jsonb strings narrow; anything else keeps the record whole.
  // `undefined` is the SQL-NULL case: JSON.stringify drops the key, so `->`
  // yields SQL NULL, and revisionsParam([undefined]) is null (whole) in JS.
  const APPLIED_PAIRS: Array<[string, unknown]> = [
    ['A', A],
    ['B', B],
    ['C', C],
    ['A with extra keys', { ...A, extra: 1 }],
    ['numeric specification revision', { specificationRevision: 1, stateRevision: A.stateRevision }],
    ['numeric state revision', { specificationRevision: A.specificationRevision, stateRevision: 7 }],
    ['missing state revision', { specificationRevision: A.specificationRevision }],
    ['jsonb null', null],
    ['an array holding the pair', [A]],
    ['a string', A.stateRevision],
    ['SQL NULL (no applied pair)', undefined],
  ];

  it('per-row applied-pair narrowing: each row narrowed to its OWN pair, in one statement', async () => {
    let narrowed = 0;
    let whole = 0;
    // Rotate the pairs across the rows so every (record, pair) combination is
    // covered, and every statement mixes pairs across rows.
    for (let shift = 0; shift < APPLIED_PAIRS.length; shift++) {
      const pairFor = (i: number) => APPLIED_PAIRS[(i + shift) % APPLIED_PAIRS.length];
      const pairById: Record<string, unknown> = {};
      SPECS.forEach(([name], i) => { pairById[String(ids.get(name))] = pairFor(i)[1]; });
      const rows = await db.adminSql<Array<{ id: number | string; launch_spec: unknown }>>`
        SELECT n.id, ${narrowedLaunchSpecToAppliedPairSql(db.adminSql)} AS launch_spec
          FROM (
            SELECT s.id, s.launch_spec, (${JSON.stringify(pairById)}::text::jsonb)->(s.id::text) AS applied_pair
              FROM harness_shared.adv_sessions s
             WHERE s.id IN ${db.adminSql([...ids.values()])}
          ) AS n`;
      expect(rows).toHaveLength(SPECS.length);
      const byId = new Map(rows.map((r) => [Number(r.id), r.launch_spec]));
      SPECS.forEach(([name, spec], i) => {
        const [pairName, pair] = pairFor(i);
        const expected = narrowIdentityHistory(spec, [pair]);
        expect(byId.get(ids.get(name)!), `${name} × ${pairName}`).toEqual(expected);
        if (JSON.stringify(expected) === JSON.stringify(spec)) whole++;
        else narrowed++;
      });
    }
    // Not vacuous: some combinations really narrow, and some really stay whole.
    expect(narrowed).toBeGreaterThan(0);
    expect(whole).toBeGreaterThan(0);
  });

  // readGateSelectedLaunchSpec shares the SQL fragment; these hold its selection
  // AND its narrowing to the same contract.
  for (const [name, spec] of SPECS) {
    it(`gate-selected read: ${name}`, async () => {
      for (const revisions of [[A], [A, B], [], [{ specificationRevision: '1', stateRevision: 'state-a' }]]) {
        expect(await readGateSelectedLaunchSpec(db.adminSql, gateOwner(name), WORKSPACE, revisions))
          .toEqual(narrowIdentityHistory(spec, revisions));
      }
      expect(await readGateSelectedLaunchSpec(db.adminSql, gateOwner(name), WORKSPACE)).toEqual(spec);
      // What every narrowed caller does with the record: select a receipt and
      // replay its specificationArtifact (appliedIdentityArtifact). Compare that,
      // not the receipt object: when the pair is the record's own, the receipt IS
      // the record, whose identityHistory the narrowing deliberately shortened.
      const selected = (record: unknown, pair: typeof A) => {
        const receipt = selectAppliedReceipt(record, pair);
        return { found: receipt !== null, artifact: receipt?.specificationArtifact };
      };
      for (const pair of [A, B, C]) {
        const narrowed = await readGateSelectedLaunchSpec(db.adminSql, gateOwner(name), WORKSPACE, [pair]);
        expect(selected(narrowed, pair)).toEqual(selected(spec, pair));
      }
    });
  }

  it('gate-selected read of an owner with no launch record is undefined, narrowed or not', async () => {
    expect(await readGateSelectedLaunchSpec(db.adminSql, 'su-no-record', WORKSPACE, [A])).toBeUndefined();
    expect(await readGateSelectedLaunchSpec(db.adminSql, 'su-no-record', WORKSPACE)).toBeUndefined();
  });

  for (const successorEnded of [false, true]) {
    it(`gate keeps the latest registration after a predecessor resume bump (successor ended: ${successorEnded})`, async () => {
      const owner = `${OWNER}-resume-${successorEnded}`;
      const predecessor = { ...receipt(A, 'predecessor') };
      const successor = { ...receipt(B, 'successor') };
      const [old] = await db.adminSql<Array<{ id: number }>>`
        INSERT INTO harness_shared.adv_sessions (workspace_id, mode, coord_owner_id, launch_spec)
        VALUES (${WORKSPACE}, 'console', ${owner}, ${JSON.stringify(predecessor)}::text::jsonb)
        RETURNING id`;
      await db.adminSql`
        INSERT INTO harness_shared.adv_sessions (workspace_id, mode, coord_owner_id, launch_spec, ended_at)
        VALUES (${WORKSPACE}, 'console', ${owner}, ${JSON.stringify(successor)}::text::jsonb,
                ${successorEnded ? new Date() : null})`;
      // Resume timestamps and a predecessor's live state do not create a new
      // registration, including after its actual successor has ended.
      await db.adminSql`
        UPDATE harness_shared.adv_sessions SET started_at = now() + interval '1 hour', ended_at = NULL
        WHERE id = ${old.id}`;
      expect(await readGateSelectedLaunchSpec(db.adminSql, owner, WORKSPACE)).toEqual(successor);
      expect(await readGateSelectedLaunchSpec(db.adminSql, owner, WORKSPACE, [B])).toEqual(successor);
    });
  }
});

function gateOwner(name: string): string {
  return `${OWNER}-gate-${SPECS.findIndex(([specName]) => specName === name)}`;
}
