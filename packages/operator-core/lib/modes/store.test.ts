/**
 * Mode store semantics (modes-and-intake-ux-2026-07-05 P-006):
 * axis auto-switch (D-006), owner-sticky refusal (D-003), clear/no-op paths,
 * and the append-only audit — over a mock sql seam (no PG).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import {
  setMode,
  getModes,
  getModesForOwners,
  reconcileImpliedModes,
  clearImpliedModes,
  RECONCILE_SET_BY,
} from './store';
import { MODES, modeById, axisKeyFor, modeIndexMarkdown } from './registry';

describe('GOAL verifier identity separation', () => {
  it('refuses GRADE and TEST on a GOAL holder and GOAL on an existing verifier', async () => {
    const { sql } = mockSql();
    const base = { workspaceId: 'ws', ownerId: 'su-holder', reason: 'verify', setBy: 'su-holder', sql };
    expect((await setMode({ ...base, modeId: 'goal', subject: 'goal-1', enabled: true })).ok).toBe(true);
    for (const modeId of ['grade', 'test']) {
      const result = await setMode({ ...base, modeId, enabled: true });
      expect(result).toMatchObject({ ok: false, error: 'goal_holder_self_verification_refused' });
    }
    const verifier = { ...base, ownerId: 'su-verifier', setBy: 'su-verifier' };
    expect((await setMode({ ...verifier, modeId: 'test', enabled: true })).ok).toBe(true);
    expect(await setMode({ ...verifier, modeId: 'goal', subject: 'goal-1', enabled: true }))
      .toMatchObject({ ok: false, error: 'goal_holder_self_verification_refused' });
  });
});

interface Row {
  workspace_id: string;
  owner_id: string;
  axis_key: string;
  mode: string;
  reason: string;
  set_by: string;
  owner_directed: boolean;
  set_at: string;
  /* Modelled because GOAL's whole provenance chain hangs off it —
     work_items.goal_id is stamped FROM agent_modes.subject. A mock that drops
     the column answers "subject: null" to every question, which is
     indistinguishable from the bug where the column is never written. */
  subject: string | null;
  implied_by: { mode: string; subject: string | null } | null;
  goal_lease_epoch: number | null;
  goal_handoff_from_owner_id: string | null;
  goal_handoff_expires_at: string | null;
}

/** In-memory agent_modes + agent_mode_changes behind a postgres.js-shaped tagged template. */
function mockSql(options: { failImpliedMode?: string } = {}) {
  const modes = new Map<string, Row>();
  const changes: Array<Record<string, unknown>> = [];
  const key = (ws: string, o: string, a: string) => `${ws}|${o}|${a}`;

  const fn = (first: unknown, ...vals: unknown[]): unknown => {
    // A tagged-template call receives a TemplateStringsArray (has .raw);
    // sql(array) — the IN (...) helper — receives a plain array.
    if (!Array.isArray(first) || !('raw' in (first as object))) return { __in: first };
    const text = (first as string[]).join('¤').replace(/\s+/g, ' ');
    if (text.includes('pg_advisory_xact_lock')) return Promise.resolve([]);
    if (text.includes('INSERT INTO harness_shared.agent_mode_changes')) {
      const [ws, owner, axis, oldMode, newMode, reason, setBy, ownerDirected, subject, goalLeaseEpoch] = vals;
      changes.push({
        ws,
        owner,
        axis,
        oldMode,
        newMode,
        reason,
        setBy,
        ownerDirected,
        subject: subject ?? null,
        goalLeaseEpoch: goalLeaseEpoch ?? null,
      });
      return Promise.resolve([]);
    }
    if (text.includes('INSERT INTO harness_shared.agent_modes')) {
      const [
        ws,
        owner,
        axis,
        mode,
        reason,
        setBy,
        ownerDirected,
        subject,
        impliedBy,
        callerIsOwnerAuthority,
        expectedOwnerId,
        expectedEpoch,
      ] = vals as Array<string | number | boolean | null>;
      const wsText = String(ws);
      const ownerText = String(owner);
      const axisText = String(axis);
      const k = key(wsText, ownerText, axisText);
      const existingRow = modes.get(k) ?? null;
      /* TWO different inserts hit this branch and they must NOT be modelled the
         same way (D-003). The primary write is ON CONFLICT DO UPDATE — an upsert
         that displaces the same-axis incumbent. The implication cascade is
         ON CONFLICT DO NOTHING … RETURNING mode — "adopt this axis only if it is
         free", whose whole purpose is that it CANNOT displace.
         A mock that ignores the conflict clause returns a well-formed answer to
         the question asked while doing the opposite of what PG would: it
         overwrites on conflict (breaking the never-displace property this mock
         is supposed to prove) and returns no RETURNING row (so the caller reads
         a successful insert as a conflict). Both errors are invisible from a
         green run — the row is there either way. */
      const doNothing = text.includes('DO NOTHING');
      if (doNothing && mode === options.failImpliedMode) {
        throw new Error(`injected implied ${mode} write failure`);
      }
      if (doNothing && existingRow) return Promise.resolve([]); // PK conflict: no write, no row
      const isGoalElection = text.includes('goal_lease_epoch');
      const storedImpliedBy =
        impliedBy == null
          ? null
          : typeof impliedBy === 'string'
            ? (JSON.parse(impliedBy) as { mode: string; subject: string | null })
            : (impliedBy as unknown as { mode: string; subject: string | null });
      const prior = isGoalElection
        ? [...modes.values()]
            .filter(
              (r) =>
                r.workspace_id === wsText &&
                r.mode === 'goal' &&
                r.subject === subject &&
                r.owner_id !== owner &&
                r.goal_lease_epoch != null,
            )
            .sort(
              (a, b) =>
                (b.goal_lease_epoch ?? 0) - (a.goal_lease_epoch ?? 0) ||
                a.owner_id.localeCompare(b.owner_id),
            )[0] ?? null
        : null;
      // WI-10005240: live rows AND election history, as the real next_epoch CTE.
      const nextEpoch = isGoalElection
        ? Math.max(
            0,
            ...[...modes.values()]
            .filter((r) => r.workspace_id === wsText && r.mode === 'goal' && r.subject === subject)
              .map((r) => r.goal_lease_epoch ?? 0),
            ...changes
              .filter((c) => c.ws === wsText && c.subject === subject && c.goalLeaseEpoch != null)
              .map((c) => Number(c.goalLeaseEpoch)),
          ) + 1
        : null;
      const authorized =
        !prior ||
        Boolean(callerIsOwnerAuthority) ||
        prior.owner_id === setBy ||
        (expectedOwnerId != null &&
          prior.owner_id === expectedOwnerId &&
          prior.goal_lease_epoch === expectedEpoch);
      if (isGoalElection && !authorized) {
        return Promise.resolve([
          {
            applied: false,
            owner_id: owner,
            subject,
            goal_lease_epoch: null,
            goal_handoff_from_owner_id: null,
            goal_handoff_expires_at: null,
            elected_owner_id: prior?.owner_id ?? null,
            elected_epoch: prior?.goal_lease_epoch ?? null,
          },
        ]);
      }
      const handoffExpiresAt = prior ? '2026-07-05T00:02:00.000Z' : null;
      modes.set(k, {
        workspace_id: wsText,
        owner_id: ownerText,
        axis_key: axisText,
        mode: String(mode),
        reason: String(reason),
        set_by: String(setBy),
        owner_directed: Boolean(ownerDirected),
        set_at: '2026-07-05T00:00:00Z',
        subject: subject == null ? null : String(subject),
        implied_by: storedImpliedBy,
        goal_lease_epoch: isGoalElection ? nextEpoch : (existingRow?.goal_lease_epoch ?? null),
        goal_handoff_from_owner_id: isGoalElection
          ? (prior?.owner_id ?? null)
          : (existingRow?.goal_handoff_from_owner_id ?? null),
        goal_handoff_expires_at: isGoalElection
          ? handoffExpiresAt
          : (existingRow?.goal_handoff_expires_at ?? null),
      });
      if (isGoalElection) {
        return Promise.resolve([
          {
            applied: true,
            owner_id: owner,
            subject,
            goal_lease_epoch: nextEpoch,
            goal_handoff_from_owner_id: prior?.owner_id ?? null,
            goal_handoff_expires_at: handoffExpiresAt,
            elected_owner_id: null,
            elected_epoch: null,
          },
        ]);
      }
      return Promise.resolve(doNothing ? [{ mode }] : []); // RETURNING mode
    }
    // The cascade's "who holds this axis instead" report read.
    if (text.includes('SELECT mode FROM harness_shared.agent_modes')) {
      const [ws, owner, axis] = vals as string[];
      const row = modes.get(key(ws, owner, axis));
      return Promise.resolve(row ? [{ mode: row.mode }] : []);
    }
    if (text.includes("implied_by->>'mode'")) {
      const [ws, owner, sourceMode, sourceSubject] = vals as [string, string, string, string | null];
      const deleted: Array<{ axis_key: string; mode: string; owner_directed: boolean }> = [];
      for (const [modeKey, row] of modes) {
        if (
          row.workspace_id === ws &&
          row.owner_id === owner &&
          row.implied_by?.mode === sourceMode &&
          row.implied_by.subject === sourceSubject
        ) {
          deleted.push({ axis_key: row.axis_key, mode: row.mode, owner_directed: row.owner_directed });
          modes.delete(modeKey);
        }
      }
      return Promise.resolve(deleted);
    }
    if (text.includes('DELETE FROM harness_shared.agent_modes')) {
      const [ws, owner, axis] = vals as string[];
      modes.delete(key(ws, owner, axis));
      return Promise.resolve([]);
    }
    if (text.includes('SELECT * FROM harness_shared.agent_modes')) {
      if (text.includes('axis_key =')) {
        const [ws, owner, axis] = vals as string[];
        const row = modes.get(key(ws, owner, axis));
        return Promise.resolve(row ? [row] : []);
      }
      if (text.includes('IN')) {
        const [ws, inArg] = vals as [string, { __in: string[] }];
        const owners = new Set(inArg.__in);
        return Promise.resolve([...modes.values()].filter((r) => r.workspace_id === ws && owners.has(r.owner_id)));
      }
      const [ws, owner] = vals as string[];
      return Promise.resolve([...modes.values()].filter((r) => r.workspace_id === ws && r.owner_id === owner));
    }
    throw new Error(`mockSql: unrecognized query: ${text.slice(0, 80)}`);
  };
  const sql = fn as unknown as Sql;
  (
    sql as unknown as {
      begin: <T>(callback: (tx: Sql) => Promise<T>) => Promise<T>;
    }
  ).begin = async <T>(callback: (tx: Sql) => Promise<T>) => {
    const beforeModes = new Map(modes);
    const beforeChanges = changes.length;
    try {
      return await callback(sql);
    } catch (error) {
      modes.clear();
      for (const [k, row] of beforeModes) modes.set(k, row);
      changes.length = beforeChanges;
      throw error;
    }
  };
  return { sql, modes, changes };
}

const WS = 'test-ws';
const ME = 'su-me';
const PEER = 'su-peer';

describe('mode registry', () => {
  it('covers the eight official modes with correct axes (owner correction: ideate/drain are stackable overlays)', () => {
    expect(MODES.map((m) => m.id).sort()).toEqual([
      'audit',
      'auto',
      'cold-auto',
      'drain',
      'goal',
      'grade',
      'ideate',
      'test',
    ]);
    expect(modeById('auto')?.axis).toBe('autonomy');
    expect(modeById('cold-auto')?.axis).toBe('autonomy');
    expect(modeById('ideate')?.axis).toBe('overlay');
    expect(modeById('drain')?.axis).toBe('overlay');
    expect(modeById('grade')?.axis).toBe('overlay');
    expect(modeById('goal')?.axis).toBe('overlay');
    // TEST (goal-mode-hardening-2026-08-10 P-006): an overlay that deliberately
    // implies nothing — testing is not an autonomy posture.
    expect(modeById('test')?.axis).toBe('overlay');
    expect(modeById('audit')?.axis).toBe('overlay');
  });

  it('axis keys: the autonomy family shares a key; each overlay gets its own', () => {
    expect(axisKeyFor(modeById('auto')!)).toBe('autonomy');
    expect(axisKeyFor(modeById('cold-auto')!)).toBe('autonomy');
    expect(axisKeyFor(modeById('ideate')!)).toBe('overlay:ideate');
    expect(axisKeyFor(modeById('drain')!)).toBe('overlay:drain');
    expect(axisKeyFor(modeById('grade')!)).toBe('overlay:grade');
    expect(axisKeyFor(modeById('goal')!)).toBe('overlay:goal');
    expect(axisKeyFor(modeById('test')!)).toBe('overlay:test');
  });

  it('every mode has a one-liner and a non-trivial contract; the index lists them all', () => {
    for (const m of MODES) {
      expect(m.oneLiner.length).toBeGreaterThan(20);
      expect(m.oneLiner).not.toContain('\n');
      expect(m.contract.length).toBeGreaterThan(200);
    }
    const idx = modeIndexMarkdown();
    for (const m of MODES) expect(idx).toContain(`**${m.id}**`);
  });

  it('P-014 (su-ideate-learning-substrate): IDEATE contract splices the su closed-loop ritual; GRADE notes the originator-wake', () => {
    const ideate = modeById('ideate')!.contract;
    // The su learning ritual: ground → file lens-tagged → route broad → close with a ledgered tick.
    expect(ideate).toContain('blender:ideation-feedback');
    expect(ideate).toContain('blender:route-idea');
    expect(ideate).toContain('blender:ideate-pass-record');
    const grade = modeById('grade')!.contract;
    expect(grade).toContain('blender:grade-idea');
    expect(grade).toMatch(/WAKES its\s+originator/);
    // one-liners stay stable (P-014: the always-present index is untouched).
    expect(modeById('ideate')!.oneLiner).not.toContain('\n');
    expect(modeById('grade')!.oneLiner).not.toContain('\n');
  });
});

describe('setMode semantics', () => {
  let m: ReturnType<typeof mockSql>;
  beforeEach(() => {
    m = mockSql();
  });

  it('self-set enables a mode and audits it', async () => {
    const res = await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'auto',
      enabled: true,
      reason: 'owner said auto',
      setBy: ME,
      ownerDirected: true,
      sql: m.sql,
    });
    expect(res.ok).toBe(true);
    expect(res.switchedFrom).toBeNull();
    const rows = await getModes(WS, ME, m.sql);
    expect(rows).toHaveLength(1);
    expect(rows[0].mode).toBe('auto');
    expect(rows[0].ownerDirected).toBe(true);
    expect(m.changes).toHaveLength(1);
    expect(m.changes[0]).toMatchObject({ oldMode: null, newMode: 'auto' });
  });

  it('AUTO-SWITCH: setting cold-auto replaces auto (same autonomy axis) and reports switchedFrom', async () => {
    await setMode({ workspaceId: WS, ownerId: ME, modeId: 'auto', enabled: true, reason: 'r1', setBy: ME, sql: m.sql });
    const res = await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'cold-auto',
      enabled: true,
      reason: 'r2',
      setBy: ME,
      sql: m.sql,
    });
    expect(res.ok).toBe(true);
    expect(res.switchedFrom).toBe('auto');
    const rows = await getModes(WS, ME, m.sql);
    expect(rows.map((r) => r.mode)).toEqual(['cold-auto']);
    expect(m.changes.at(-1)).toMatchObject({ oldMode: 'auto', newMode: 'cold-auto' });
  });

  it('overlays stack — including ideate + drain together (owner correction 2026-07-05)', async () => {
    for (const mode of ['auto', 'ideate', 'drain', 'grade']) {
      await setMode({
        workspaceId: WS,
        ownerId: ME,
        modeId: mode,
        enabled: true,
        reason: 'stack',
        setBy: ME,
        sql: m.sql,
      });
    }
    const rows = await getModes(WS, ME, m.sql);
    expect(rows.map((r) => r.mode).sort()).toEqual(['auto', 'drain', 'grade', 'ideate']);
  });

  it('OWNER-STICKY: a peer cannot override or clear an owner-directed mode', async () => {
    await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'auto',
      enabled: true,
      reason: 'owner freeze posture',
      setBy: ME,
      ownerDirected: true,
      sql: m.sql,
    });
    const override = await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'cold-auto',
      enabled: true,
      reason: 'peer thinks cold is better',
      setBy: PEER,
      sql: m.sql,
    });
    expect(override.ok).toBe(false);
    expect(override.stickyConflict).toBe(true);
    const clear = await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'auto',
      enabled: false,
      reason: 'peer clears',
      setBy: PEER,
      sql: m.sql,
    });
    expect(clear.ok).toBe(false);
    expect(clear.stickyConflict).toBe(true);
    const rows = await getModes(WS, ME, m.sql);
    expect(rows.map((r) => r.mode)).toEqual(['auto']); // untouched
    expect(m.changes).toHaveLength(1); // refusals write NOTHING
  });

  it('a peer CAN set a non-sticky mode, and the write is attributed to the peer', async () => {
    await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'ideate',
      enabled: true,
      reason: 'self',
      setBy: ME,
      sql: m.sql,
    });
    const res = await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'drain',
      enabled: true,
      reason: 'backlog is critical',
      setBy: PEER,
      sql: m.sql,
    });
    expect(res.ok).toBe(true);
    expect(res.switchedFrom).toBeNull(); // overlays stack — ideate survives
    const rows = await getModes(WS, ME, m.sql);
    // 'auto' is here because DRAIN implies it and the store now writes it (D-003) —
    // this expectation moved from ['drain','ideate'] on purpose.
    expect(rows.map((r) => r.mode).sort()).toEqual(['auto', 'drain', 'ideate']);
    expect(res.implied).toEqual([{ mode: 'auto', status: 'set' }]);
    // A peer-driven implication is still attributed to the peer, and a peer can
    // no more arm sticky through an implication than through a direct set.
    const auto = rows.find((r) => r.mode === 'auto')!;
    expect(auto.setBy).toBe(PEER);
    expect(auto.ownerDirected).toBe(false);
    const drain = rows.find((r) => r.mode === 'drain')!;
    expect(drain.setBy).toBe(PEER);
    expect(drain.ownerDirected).toBe(false); // peers can never arm sticky for others
  });

  it('peers cannot arm ownerDirected for someone else even if they pass it', async () => {
    const res = await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'auto',
      enabled: true,
      reason: 'x',
      setBy: PEER,
      ownerDirected: true,
      sql: m.sql,
    });
    expect(res.ok).toBe(true);
    const rows = await getModes(WS, ME, m.sql);
    expect(rows[0].ownerDirected).toBe(false);
  });

  it('clearing an unset mode is a no-op; re-setting the same mode+reason is a no-op', async () => {
    const clear = await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'drain',
      enabled: false,
      reason: 'not on',
      setBy: ME,
      sql: m.sql,
    });
    expect(clear.ok).toBe(true);
    expect(clear.noop).toBe(true);
    await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'grade',
      enabled: true,
      reason: 'same',
      setBy: ME,
      sql: m.sql,
    });
    const again = await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'grade',
      enabled: true,
      reason: 'same',
      setBy: ME,
      sql: m.sql,
    });
    expect(again.noop).toBe(true);
    // First entry writes GRADE plus its implied AUTO row. Re-entry writes
    // neither, so the audit population stays at two.
    expect(m.changes).toHaveLength(2);
  });

  it('unknown mode is rejected', async () => {
    const res = await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'turbo',
      enabled: true,
      reason: 'x',
      setBy: ME,
      sql: m.sql,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('unknown mode');
  });

  it('getModesForOwners fans in per owner', async () => {
    await setMode({ workspaceId: WS, ownerId: ME, modeId: 'auto', enabled: true, reason: 'a', setBy: ME, sql: m.sql });
    await setMode({
      workspaceId: WS,
      ownerId: PEER,
      modeId: 'grade',
      enabled: true,
      reason: 'b',
      setBy: PEER,
      sql: m.sql,
    });
    const map = await getModesForOwners(WS, [ME, PEER, 'su-nobody'], m.sql);
    expect(map.get(ME)?.map((r) => r.mode)).toEqual(['auto']);
    expect(
      map
        .get(PEER)
        ?.map((r) => r.mode)
        .sort(),
    ).toEqual(['auto', 'grade']);
    expect(map.has('su-nobody')).toBe(false);
  });
});

describe('setMode callerIsOwnerAuthority (P-003: admin-UI peer-set is a verified owner-authority channel)', () => {
  let m: ReturnType<typeof mockSql>;
  const ADMIN = 'pc-admin-coord-ui';
  beforeEach(() => {
    m = mockSql();
  });

  it('self-set: ownerAuthorized is implied — arms sticky without callerIsOwnerAuthority', async () => {
    const res = await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'auto',
      enabled: true,
      reason: 'owner said auto',
      setBy: ME,
      ownerDirected: true,
      sql: m.sql,
    });
    expect(res.ok).toBe(true);
    const rows = await getModes(WS, ME, m.sql);
    expect(rows[0].ownerDirected).toBe(true);
  });

  it('admin-UI peer-set with callerIsOwnerAuthority:true CAN arm the sticky flag (the P-003 fix)', async () => {
    const res = await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'auto',
      enabled: true,
      reason: 'owner clicked Autonomy: auto in the chat UI',
      setBy: ADMIN,
      ownerDirected: true,
      callerIsOwnerAuthority: true,
      sql: m.sql,
    });
    expect(res.ok).toBe(true);
    const rows = await getModes(WS, ME, m.sql);
    expect(rows).toHaveLength(1);
    expect(rows[0].mode).toBe('auto');
    expect(rows[0].ownerDirected).toBe(true);
    expect(rows[0].setBy).toBe(ADMIN);
  });

  it('ordinary peer-set (no callerIsOwnerAuthority) claiming ownerDirected:true is DOWNGRADED — sticky never arms', async () => {
    const res = await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'auto',
      enabled: true,
      reason: 'peer claims owner authority',
      setBy: PEER,
      ownerDirected: true,
      sql: m.sql,
    });
    expect(res.ok).toBe(true);
    const rows = await getModes(WS, ME, m.sql);
    expect(rows[0].ownerDirected).toBe(false);
    expect(rows[0].setBy).toBe(PEER);
  });

  it('admin-UI peer-set (callerIsOwnerAuthority:true) BYPASSES an existing owner-directed incumbent — an ordinary peer still cannot', async () => {
    await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'auto',
      enabled: true,
      reason: 'owner froze this posture',
      setBy: ME,
      ownerDirected: true,
      sql: m.sql,
    });
    // An ordinary peer is still refused (unchanged D-003 behavior).
    const peerAttempt = await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'cold-auto',
      enabled: true,
      reason: 'peer thinks cold is better',
      setBy: PEER,
      sql: m.sql,
    });
    expect(peerAttempt.ok).toBe(false);
    expect(peerAttempt.stickyConflict).toBe(true);

    // The admin-UI, acting for the owner, CAN override it — even without
    // re-claiming ownerDirected on this particular call.
    const adminOverride = await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'cold-auto',
      enabled: true,
      reason: 'owner switched to cold-auto from the chat UI',
      setBy: ADMIN,
      callerIsOwnerAuthority: true,
      sql: m.sql,
    });
    expect(adminOverride.ok).toBe(true);
    expect(adminOverride.stickyConflict).toBeFalsy();
    expect(adminOverride.switchedFrom).toBe('auto');
    const rows = await getModes(WS, ME, m.sql);
    expect(rows.map((r) => r.mode)).toEqual(['cold-auto']);
  });

  it('admin-UI peer-set without ownerDirected:true does NOT itself arm sticky — callerIsOwnerAuthority only widens WHO can bypass/arm it', async () => {
    const res = await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'ideate',
      enabled: true,
      reason: 'owner toggled the Overlays checkbox',
      setBy: ADMIN,
      callerIsOwnerAuthority: true,
      sql: m.sql,
    });
    expect(res.ok).toBe(true);
    const rows = await getModes(WS, ME, m.sql);
    expect(rows[0].ownerDirected).toBe(false);
  });
});

/**
 * THE IMPLICATION CASCADE (D-003).
 *
 * [owner 2026-08-10] "make sure goal mode implies both auto and ideate mode."
 * The mechanism is the deliverable: entering GOAL must LEAVE the agent holding
 * auto + ideate whether or not anyone remembered a second call. These are
 * properties of the STORE, not of the `mode:set` tool, because three doors enter
 * a mode and only one of them is that tool.
 *
 * WHAT THIS SUITE CANNOT PROVE. The never-displace property rests on PG's
 * `ON CONFLICT … DO NOTHING`, which mockSql models by hand — so green here means
 * "the store asks for the right thing", not "PG does it". A live rolled-back
 * round-trip is what closes that half; this file is deliberately not trusted for
 * it.
 */
describe('implication cascade (D-003)', () => {
  let m: ReturnType<typeof mockSql>;
  beforeEach(() => {
    m = mockSql();
  });

  const enterGoal = (over: Partial<Parameters<typeof setMode>[0]> = {}) =>
    setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'goal',
      enabled: true,
      reason: 'owns goal g-1',
      setBy: ME,
      subject: 'g-1',
      sql: m.sql,
      ...over,
    });

  it('GOAL writes the auto AND ideate rows itself, and reports both', async () => {
    const res = await enterGoal();
    expect(res.ok).toBe(true);
    expect(res.implied).toEqual([
      { mode: 'auto', status: 'set' },
      { mode: 'ideate', status: 'set' },
    ]);
    const rows = await getModes(WS, ME, m.sql);
    expect(rows.map((r) => r.mode).sort()).toEqual(['auto', 'goal', 'ideate']);
    expect(rows.find((r) => r.mode === 'auto')?.impliedBy).toEqual({ mode: 'goal', subject: 'g-1' });
    expect(rows.find((r) => r.mode === 'ideate')?.impliedBy).toEqual({ mode: 'goal', subject: 'g-1' });
    expect(rows.find((r) => r.mode === 'goal')?.impliedBy).toBeNull();
  });

  it('rolls back the GOAL row, election and AUTO when IDEATE cannot be implied', async () => {
    const failing = mockSql({ failImpliedMode: 'ideate' });
    const res = await setMode({
      workspaceId: WS, ownerId: ME, modeId: 'goal', enabled: true,
      reason: 'owns goal g-1', setBy: ME, subject: 'g-1', sql: failing.sql,
    });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('goal_mode_implication_failed') });
    expect(await getModes(WS, ME, failing.sql)).toEqual([]);
    expect(failing.changes).toEqual([]);
  });

  it('elects one GOAL holder epoch and records a bounded predecessor handoff', async () => {
    const first = await enterGoal();
    expect(first.goalElection).toEqual({
      ownerId: ME,
      goalId: 'g-1',
      epoch: 1,
      predecessorOwnerId: null,
      handoffExpiresAt: null,
    });

    const unrelated = await setMode({
      workspaceId: WS,
      ownerId: PEER,
      modeId: 'goal',
      enabled: true,
      reason: 'bounded takeover',
      setBy: PEER,
      subject: 'g-1',
      sql: m.sql,
    });
    expect(unrelated).toMatchObject({
      ok: false,
      goalElectionConflict: {
        goalId: 'g-1',
        electedOwnerId: ME,
        electedEpoch: 1,
      },
    });
    expect((await getModes(WS, PEER, m.sql)).find((row) => row.mode === 'goal')).toBeUndefined();

    // The current elected holder explicitly hands off to the peer. `setBy` is
    // checked against the elected row while the goal advisory lock is held.
    const second = await setMode({
      workspaceId: WS,
      ownerId: PEER,
      modeId: 'goal',
      enabled: true,
      reason: 'bounded takeover',
      setBy: ME,
      subject: 'g-1',
      sql: m.sql,
    });
    expect(second.goalElection).toEqual({
      ownerId: PEER,
      goalId: 'g-1',
      epoch: 2,
      predecessorOwnerId: ME,
      handoffExpiresAt: '2026-07-05T00:02:00.000Z',
    });
    const peerGoal = (await getModes(WS, PEER, m.sql)).find((row) => row.mode === 'goal')!;
    expect(peerGoal).toMatchObject({
      goalLeaseEpoch: 2,
      goalHandoffFromOwnerId: ME,
      goalHandoffExpiresAt: '2026-07-05T00:02:00.000Z',
    });

    // Reasserting the predecessor's unchanged row is a no-op repair, not a new
    // election that silently steals sovereignty back from the successor.
    const reasserted = await enterGoal();
    expect(reasserted.noop).toBe(true);
    expect(reasserted.goalElection).toBeUndefined();
    const predecessor = (await getModes(WS, ME, m.sql)).find((row) => row.mode === 'goal')!;
    expect(predecessor.goalLeaseEpoch).toBe(1);
  });

  it('WI-10005240: records the minted epoch on the election audit row (the durable lease high-water)', async () => {
    await enterGoal();
    const electionAudit = m.changes.find((c) => c.newMode === 'goal' && c.owner === ME);
    expect(electionAudit).toMatchObject({ subject: 'g-1', goalLeaseEpoch: 1 });
    // The implied AUTO/IDEATE rows elect nothing, so they carry no epoch.
    expect(m.changes.filter((c) => c.goalLeaseEpoch != null)).toHaveLength(1);
  });

  it('recovery CAS refuses a stale elected lease and never allocates another epoch', async () => {
    await enterGoal();
    await setMode({
      workspaceId: WS,
      ownerId: PEER,
      modeId: 'goal',
      enabled: true,
      reason: 'current holder handoff',
      setBy: ME,
      subject: 'g-1',
      sql: m.sql,
    });

    const stale = await setMode({
      workspaceId: WS,
      ownerId: 'su-stale-replacement',
      modeId: 'goal',
      enabled: true,
      reason: 'stale recovery',
      setBy: 'goal-holder-respawner',
      subject: 'g-1',
      goalElectionExpectation: { ownerId: ME, epoch: 1 },
      sql: m.sql,
    });
    expect(stale).toMatchObject({
      ok: false,
      goalElectionConflict: { electedOwnerId: PEER, electedEpoch: 2 },
    });
    expect((await getModes(WS, 'su-stale-replacement', m.sql))).toEqual([]);

    const recovered = await setMode({
      workspaceId: WS,
      ownerId: 'su-current-replacement',
      modeId: 'goal',
      enabled: true,
      reason: 'lease-bound recovery',
      setBy: 'goal-holder-respawner',
      subject: 'g-1',
      goalElectionExpectation: { ownerId: PEER, epoch: 2 },
      sql: m.sql,
    });
    expect(recovered.goalElection).toMatchObject({
      ownerId: 'su-current-replacement',
      epoch: 3,
      predecessorOwnerId: PEER,
    });
  });

  it('GRADE writes the AUTO row itself, so remediation never starts ask-first', async () => {
    const res = await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'grade',
      enabled: true,
      reason: 'grade and repair target',
      setBy: ME,
      sql: m.sql,
    });
    expect(res.ok).toBe(true);
    expect(res.implied).toEqual([{ mode: 'auto', status: 'set' }]);
    expect((await getModes(WS, ME, m.sql)).map((r) => r.mode).sort()).toEqual(['auto', 'grade']);
  });

  it('audits every implied entry — "who put this agent in AUTO" answers "the goal cascade"', async () => {
    await enterGoal();
    expect(m.changes.map((c) => c.newMode).sort()).toEqual(['auto', 'goal', 'ideate']);
    const autoChange = m.changes.find((c) => c.newMode === 'auto')!;
    expect(autoChange.oldMode).toBeNull();
    expect(String(autoChange.reason)).toContain("implied by 'goal'");
  });

  /**
   * THE PROPERTY MOST WORTH GUARDING. cold-auto already satisfies "implies
   * auto"; replacing it with plain auto would silently downgrade a posture the
   * agent deliberately chose. An ordinary upsert WOULD have replaced it — which
   * is precisely why the cascade is a DO NOTHING insert and not a setMode call.
   */
  it('NEVER displaces an occupied axis — cold-auto survives and is reported as holding it', async () => {
    await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'cold-auto',
      enabled: true,
      reason: 'unattended wakes',
      setBy: ME,
      sql: m.sql,
    });
    const res = await enterGoal();
    expect(res.implied).toEqual([
      { mode: 'auto', status: 'axis-held', by: 'cold-auto' },
      { mode: 'ideate', status: 'set' },
    ]);
    const rows = await getModes(WS, ME, m.sql);
    expect(rows.map((r) => r.mode).sort()).toEqual(['cold-auto', 'goal', 'ideate']);
    // untouched, not merely present — a rewrite with the cascade's reason would
    // still leave cold-auto "there" while destroying who set it and why.
    expect(rows.find((r) => r.mode === 'cold-auto')!.reason).toBe('unattended wakes');
  });

  it('reports an implied mode the agent was already in as already-on, without a second write', async () => {
    await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'ideate',
      enabled: true,
      reason: 'was already ideating',
      setBy: ME,
      sql: m.sql,
    });
    const before = m.changes.length;
    const res = await enterGoal();
    expect(res.implied).toContainEqual({ mode: 'ideate', status: 'already-on' });
    const rows = await getModes(WS, ME, m.sql);
    expect(rows.find((r) => r.mode === 'ideate')!.reason).toBe('was already ideating');
    expect(m.changes.length - before).toBe(2); // goal + auto only — ideate was not re-audited
  });

  /**
   * THE REPAIR PATH — and the reason the cascade is not gated on "something
   * changed". An agent whose auto row was cleared (a peer, a wipe) re-asserts
   * its mode to fix it; if a no-op mode write skipped the cascade, that one
   * natural call would be the one call that does nothing.
   */
  it('is IDEMPOTENT and REPAIRS: a no-op re-entry restores a missing implied row', async () => {
    await enterGoal();
    await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'auto',
      enabled: false,
      reason: 'a peer cleared it',
      setBy: ME,
      sql: m.sql,
    });
    expect((await getModes(WS, ME, m.sql)).map((r) => r.mode).sort()).toEqual(['goal', 'ideate']);

    const again = await enterGoal(); // identical args ⇒ the mode write itself is a noop
    expect(again.noop).toBe(true);
    expect(again.implied).toEqual([
      { mode: 'auto', status: 'set' },
      { mode: 'ideate', status: 'already-on' },
    ]);
    expect((await getModes(WS, ME, m.sql)).map((r) => r.mode).sort()).toEqual(['auto', 'goal', 'ideate']);
  });

  /**
   * NOT MIRRORED ON EXIT, on purpose: the agent may have been in AUTO before it
   * ever entered GOAL, and revoking a posture the owner set independently is a
   * destructive guess. "Entering this means entering those" ≠ "these are mine".
   */
  it('does NOT clear implied modes when the implying mode is turned off', async () => {
    await enterGoal();
    await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'goal',
      enabled: false,
      reason: 'goal shipped',
      setBy: ME,
      sql: m.sql,
    });
    expect((await getModes(WS, ME, m.sql)).map((r) => r.mode).sort()).toEqual(['auto', 'ideate']);
  });

  it('does not propagate the implying mode SUBJECT to the modes it implies', async () => {
    await enterGoal();
    const rows = await getModes(WS, ME, m.sql);
    expect(rows.find((r) => r.mode === 'goal')!.subject).toBe('g-1');
    expect(rows.find((r) => r.mode === 'auto')!.subject).toBeNull();
  });

  it('clears only exact derived provenance and preserves an independently chosen posture', async () => {
    await enterGoal();

    // Re-asserting AUTO explicitly converts the implied row into an independent
    // posture. Terminal GOAL cleanup must leave it in place.
    await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'auto',
      enabled: true,
      reason: 'owner independently chose auto',
      setBy: ME,
      sql: m.sql,
    });

    expect(
      await clearImpliedModes({
        workspaceId: WS,
        ownerId: ME,
        source: { mode: 'goal', subject: 'different-goal' },
        reason: 'wrong source must not clear anything',
        setBy: ME,
        sql: m.sql,
      }),
    ).toEqual([]);

    expect(
      await clearImpliedModes({
        workspaceId: WS,
        ownerId: ME,
        source: { mode: 'goal', subject: 'g-1' },
        reason: 'terminal goal cleanup',
        setBy: 'goal-stop-fanout',
        sql: m.sql,
      }),
    ).toEqual(['ideate']);

    const rows = await getModes(WS, ME, m.sql);
    expect(rows.map((r) => r.mode).sort()).toEqual(['auto', 'goal']);
    expect(rows.find((r) => r.mode === 'auto')?.impliedBy).toBeNull();
  });

  it('does not forge owner-directed provenance on implied rows', async () => {
    await enterGoal({ ownerDirected: true });
    const rows = await getModes(WS, ME, m.sql);
    expect(rows.find((r) => r.mode === 'goal')!.ownerDirected).toBe(true);
    expect(rows.find((r) => r.mode === 'auto')!.ownerDirected).toBe(false);
    expect(rows.find((r) => r.mode === 'ideate')!.ownerDirected).toBe(false);
    const peerClear = await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'auto',
      enabled: false,
      reason: 'peer clears',
      setBy: PEER,
      sql: m.sql,
    });
    expect(peerClear.ok).toBe(true);
    expect(peerClear.stickyConflict).toBeUndefined();
  });

  it('a mode with no implications reports none (no empty `implied` noise)', async () => {
    const res = await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'test',
      enabled: true,
      reason: 'verify a contract',
      setBy: ME,
      sql: m.sql,
    });
    expect(res.implied).toBeUndefined();
  });

  it('rolls back GOAL when AUTO cannot be implied', async () => {
    const failing = mockSql({ failImpliedMode: 'auto' });
    const res = await setMode({
      workspaceId: WS,
      ownerId: ME,
      modeId: 'goal',
      enabled: true,
      reason: 'owns goal g-1',
      setBy: ME,
      subject: 'g-1',
      sql: failing.sql,
    });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('goal_mode_implication_failed') });
    expect(await getModes(WS, ME, failing.sql)).toEqual([]);
    expect(failing.changes).toEqual([]);
  });
});

/**
 * WI-37856 — the RECONCILE, over the STORED population.
 *
 * WHY THIS SUITE EXISTS AND WHY THE EXISTING ONES DID NOT CATCH THE BUG: every
 * cascade test above drives `setMode`, i.e. the WRITE path. The write path was
 * never broken. The defect lived in rows written BEFORE the mode declared its
 * implications — a population no write-path test constructs, which is why 83
 * green tests coexisted with three live agents whose mode set the contract says
 * is impossible. A guard that can only see writes cannot see this class, so the
 * property under test here is deliberately stated over stored ROWS.
 */
describe('reconcileImpliedModes (WI-37856) — repairs the stored population, not the write path', () => {
  let m: ReturnType<typeof mockSql>;
  beforeEach(() => {
    m = mockSql();
  });

  const axisOf = (id: string) => axisKeyFor(modeById(id)!);

  /**
   * Seed a row exactly as it existed before its mode declared implications:
   * straight into the table, no cascade. `setMode` can NO LONGER produce this
   * shape — which is precisely why the gap outlived a green write-path suite,
   * and why seeding directly is the honest fixture rather than a shortcut.
   */
  const seedPreCascade = (mode: string, o?: { ownerDirected?: boolean; subject?: string | null }) => {
    m.modes.set(`${WS}|${ME}|${axisOf(mode)}`, {
      workspace_id: WS,
      owner_id: ME,
      axis_key: axisOf(mode),
      mode,
      reason: 'written before the implication existed',
      set_by: ME,
      owner_directed: o?.ownerDirected ?? false,
      set_at: '2026-08-10T07:05:19Z',
      subject: o?.subject ?? null,
      goal_lease_epoch: mode === 'goal' ? 1 : null,
      goal_handoff_from_owner_id: null,
      goal_handoff_expires_at: null,
      implied_by: null,
    });
  };

  it('fills the modes a pre-existing GOAL row never got — and the BEFORE state proves the fixture was really broken', async () => {
    seedPreCascade('goal', { subject: 'g-cute-bears' });

    // THE FALSIFIER. Without this half, the assertions below would pass just as
    // happily against a fixture that had been complete all along.
    const before = (await getModes(WS, ME, m.sql)).map((r) => r.mode).sort();
    expect(before).toEqual(['goal']);

    const out = await reconcileImpliedModes({ workspaceId: WS, ownerId: ME, sql: m.sql });
    expect(out).toEqual([
      { mode: 'auto', status: 'set' },
      { mode: 'ideate', status: 'set' },
    ]);

    const after = (await getModes(WS, ME, m.sql)).map((r) => r.mode).sort();
    expect(after).toEqual(['auto', 'goal', 'ideate']);
  });

  it('stamps backfilled rows as system-authored, and leaves the agent-authored row untouched', async () => {
    seedPreCascade('goal', { subject: 'g-1' });
    await reconcileImpliedModes({ workspaceId: WS, ownerId: ME, sql: m.sql });
    const by = Object.fromEntries((await getModes(WS, ME, m.sql)).map((r) => [r.mode, r.setBy]));
    /* Grading turns on this: goal-mode-e2e's `mode-and-subject-integrity` reads
       these rows, and a backfilled row credited to the agent would read as
       compliance the agent never performed. */
    expect(by.auto).toBe(RECONCILE_SET_BY);
    expect(by.ideate).toBe(RECONCILE_SET_BY);
    expect(by.goal).toBe(ME); // untouched — the reconcile only ever ADDS
  });

  it('does not forge owner-directed provenance when reconciling implied rows', async () => {
    seedPreCascade('goal', { subject: 'g-1', ownerDirected: true });
    await reconcileImpliedModes({ workspaceId: WS, ownerId: ME, sql: m.sql });
    const rows = await getModes(WS, ME, m.sql);
    expect(rows.find((r) => r.mode === 'goal')?.ownerDirected).toBe(true);
    expect(rows.find((r) => r.mode === 'auto')?.ownerDirected).toBe(false);
    expect(rows.find((r) => r.mode === 'ideate')?.ownerDirected).toBe(false);
  });

  it('is idempotent — a second pass writes nothing and audits nothing (safe to call on every bootstrap)', async () => {
    seedPreCascade('goal', { subject: 'g-1' });
    await reconcileImpliedModes({ workspaceId: WS, ownerId: ME, sql: m.sql });
    const auditsAfterFirst = m.changes.length;

    const second = await reconcileImpliedModes({ workspaceId: WS, ownerId: ME, sql: m.sql });
    expect(second).toEqual([
      { mode: 'auto', status: 'already-on' },
      { mode: 'ideate', status: 'already-on' },
    ]);
    expect(m.changes.length).toBe(auditsAfterFirst); // no second audit row
    expect((await getModes(WS, ME, m.sql)).length).toBe(3);
  });

  it('never displaces a deliberately-chosen posture — cold-auto already satisfies "implies auto"', async () => {
    seedPreCascade('goal', { subject: 'g-1' });
    seedPreCascade('cold-auto');

    const out = await reconcileImpliedModes({ workspaceId: WS, ownerId: ME, sql: m.sql });
    expect(out).toContainEqual({ mode: 'auto', status: 'axis-held', by: 'cold-auto' });

    const rows = await getModes(WS, ME, m.sql);
    /* The autonomy axis must still hold cold-auto. Downgrading it to plain
       `auto` would satisfy the letter of "implies auto" while silently undoing
       a choice someone made on purpose. */
    expect(rows.find((r) => r.axisKey === axisOf('cold-auto'))?.mode).toBe('cold-auto');
    expect(rows.map((r) => r.mode).sort()).toEqual(['cold-auto', 'goal', 'ideate']);
  });

  it('does nothing for an agent whose modes imply nothing, and nothing for an agent with no modes at all', async () => {
    expect(await reconcileImpliedModes({ workspaceId: WS, ownerId: ME, sql: m.sql })).toEqual([]);
    seedPreCascade('test'); // an overlay that deliberately implies nothing
    expect(await reconcileImpliedModes({ workspaceId: WS, ownerId: ME, sql: m.sql })).toEqual([]);
    expect(m.changes.length).toBe(0);
  });
});
