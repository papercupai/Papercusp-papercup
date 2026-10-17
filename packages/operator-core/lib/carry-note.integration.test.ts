/**
 * carry-note.integration.test.ts — the ONE shared carry-note substrate against
 * real Postgres (su-cold-auto-mode-2026-07-03 Phase 1 / P-001·P-002).
 *
 * Proves the durable read/write round-trip (P-002's test), the D-003 semantics
 * shared by all three carriers, and the two journaling modes:
 *   - journaling ON (Queen / su loop): a write appends to the trajectory ring;
 *     a CLEAR keeps the row (note→null) while the journal survives.
 *   - journaling OFF (bee checkpoint): pure note, no ring, a CLEAR deletes the row.
 * Plus scope + workspace isolation, and that the three roles converge on ONE store.
 *
 * The inline DDL mirrors migration 472's table; the grants/RLS are validated by
 * fresh-migrate.integration.test.ts. Gated on Docker like the other *-integration.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type postgres from 'postgres';
import { acquireSnapshot } from '@papercusp/db-org';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

// Keep the contention regression fast. The production default remains 8s; this
// test only needs to prove the loop path installs a DB-side lock bound.
const priorLoopLockTimeout = process.env.PAPERCUSP_COORD_WRITE_LOCK_TIMEOUT_MS;
process.env.PAPERCUSP_COORD_WRITE_LOCK_TIMEOUT_MS = '100';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
const ordersNotify = vi.hoisted(() => ({
  notifyAgentOrdersChanged: vi.fn(async (_ownerId: string | null | undefined) => {}),
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./agent-orders-notify', () => ordersNotify);
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const {
  setCarryNote,
  getCarryNote,
  getCarryJournal,
  setCarryNoteWithPrior,
  setLoopCarryNote,
  setLoopCarryNoteWithPrior,
  getLoopCarryNote,
  getLoopCarryNoteWithMeta,
  getLoopCarryJournal,
  shortCarryHash,
  hiveScope,
  workItemScope,
  loopScope,
  renderCarryNote,
  parseCarryNote,
  attestCarryNoteUnchanged,
  CARRY_NOTE_ATTESTATION_MAX_CHAIN,
  CARRY_NOTE_ATTESTATION_MAX_BODY_AGE_MS,
} = await import('./carry-note');

if (priorLoopLockTimeout === undefined) delete process.env.PAPERCUSP_COORD_WRITE_LOCK_TIMEOUT_MS;
else process.env.PAPERCUSP_COORD_WRITE_LOCK_TIMEOUT_MS = priorLoopLockTimeout;

const CARRY_NOTES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.carry_notes (
    workspace_id text NOT NULL,
    scope text NOT NULL,
    note text,
    journal jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_ts bigint NOT NULL,
    deps jsonb,
    -- migration 1118 (P-007/R-06) unchanged-attestation state. body_ts = when the note
    -- TEXT last actually changed (NULL on pre-1118 rows; readers coalesce to
    -- updated_ts); attested_count = the consecutive-attestation chain since the last
    -- real body write. Kept in step with the real schema deliberately: this fixture
    -- tracks harness_shared.carry_notes rather than stubbing a minimal subset.
    body_ts bigint,
    attested_count integer NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, scope))`;

let db: FreshPgDb;
beforeAll(async () => {
  db = await createFreshPgDb('carry-note');
  h.sql = db.sql;
  await db.sql.unsafe(CARRY_NOTES_DDL);
}, 60_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  ordersNotify.notifyAgentOrdersChanged.mockClear();
  await db.sql`DELETE FROM harness_shared.carry_notes`;
});

async function rowCount(): Promise<number> {
  const r = await db.sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM harness_shared.carry_notes`;
  return Number(r[0]?.n ?? 0);
}

const LOOP = { harness: 'papercusp', ownerId: 'su-94b69' } as const;

describe('su-loop carry-note read/write round-trip (P-002)', () => {
  it('persists all four cited reference kinds from the session workspace through the loop checkpoint writer (R-13)', async () => {
    await db.sql`CREATE TABLE IF NOT EXISTS harness_shared.work_items (
      workspace_id text NOT NULL, feature_id text NOT NULL, status text, updated_ts bigint,
      PRIMARY KEY (workspace_id, feature_id))`;
    await db.sql`INSERT INTO harness_shared.work_items (workspace_id, feature_id, status, updated_ts)
      VALUES ('reference-session', 'WI-1313', 'open', 10), ('default', 'WI-1313', 'done', 99)
      ON CONFLICT (workspace_id, feature_id) DO UPDATE SET status = EXCLUDED.status, updated_ts = EXCLUDED.updated_ts`;
    await db.sql`CREATE TABLE harness_shared.harness_plans (
      workspace_id text, harness_slug text, plan_slug text, decisions jsonb)`;
    await db.sql`INSERT INTO harness_shared.harness_plans VALUES
      ('reference-session', 'papercusp', 'reference-plan', '[{"id":"D-001","title":"Keep baseline","body":"Read before replacing"}]'::jsonb)`;
    await db.sql`CREATE TABLE harness_shared.agent_facts (
      workspace_id text, key text, id bigint, updated_at timestamptz,
      retracted_at timestamptz, superseded_at timestamptz, evicted_at timestamptz, expires_at timestamptz)`;
    await db.sql`INSERT INTO harness_shared.agent_facts (workspace_id, key, id, updated_at)
      VALUES ('reference-session', 'reference-fact', 1313, ${new Date(10)})`;
    const ref = { ...LOOP, workspaceId: 'reference-session' };
    const citations = 'WI-1313 reference-plan#D-001 fact:reference-fact packages/operator-core/lib/carry-ref-stamps.test.ts';
    const hash = (value: string | Buffer) => `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
    const expected = [
      { dep: 'work-item:WI-1313', token: 'open@10', at: expect.any(Number) },
      { dep: 'decision:reference-plan#D-001', token: hash('Keep baseline\nRead before replacing'), at: expect.any(Number) },
      { dep: 'fact:reference-fact', token: 'live:1313@10', at: expect.any(Number) },
      { dep: 'file:packages/operator-core/lib/carry-ref-stamps.test.ts', token: hash(readFileSync(new URL('./carry-ref-stamps.test.ts', import.meta.url))), at: expect.any(Number) },
    ];

    await setLoopCarryNoteWithPrior(ref, `Waiting on ${citations}`);
    const [saved] = await db.sql<{ deps: { refs: unknown[] } }[]>`
      SELECT deps FROM harness_shared.carry_notes WHERE scope = ${loopScope(LOOP.harness, LOOP.ownerId)}`;
    expect(saved?.deps.refs).toEqual(expected);

    await db.sql`UPDATE harness_shared.work_items SET updated_ts = 20
      WHERE workspace_id = 'reference-session' AND feature_id = 'WI-1313'`;
    const [baseline] = await db.sql<{ deps: { refs: unknown[] } }[]>`
      SELECT deps FROM harness_shared.carry_notes WHERE scope = ${loopScope(LOOP.harness, LOOP.ownerId)}`;
    expect(baseline?.deps).toEqual(saved?.deps);
    await setLoopCarryNoteWithPrior(ref, `Still waiting on ${citations}`);
    const [refreshed] = await db.sql<{ deps: { refs: unknown[] } }[]>`
      SELECT deps FROM harness_shared.carry_notes WHERE scope = ${loopScope(LOOP.harness, LOOP.ownerId)}`;
    expect(refreshed?.deps.refs).toEqual([{ ...expected[0], token: 'open@20' }, ...expected.slice(1)]);
  });

  it('records the production admin-pool acquisition for a bounded loop write', async () => {
    const before = acquireSnapshot('org-admin').totalAcquired;
    const result = await setLoopCarryNoteWithPrior(LOOP, 'diagnostic checkpoint');

    expect(result.stored).toBe('diagnostic checkpoint');
    expect(acquireSnapshot('org-admin').totalAcquired).toBeGreaterThan(before);
  });

  it('write → read round-trips; replace-on-write keeps ONE row', async () => {
    expect(await getLoopCarryNote(LOOP)).toBeNull(); // fresh
    expect(await setLoopCarryNote(LOOP, '  did X; next Y  ')).toBe('did X; next Y'); // trimmed
    expect(await getLoopCarryNote(LOOP)).toBe('did X; next Y');
    await setLoopCarryNote(LOOP, 'second');
    expect(await getLoopCarryNote(LOOP)).toBe('second');
    expect(await rowCount()).toBe(1);
  });

  it('distinguishes a failed meta read from a confirmed-empty meta read', async () => {
    expect(await getLoopCarryNoteWithMeta(LOOP)).toEqual({
      note: null,
      updatedAtMs: null,
      readFailed: false,
    });

    const previousSql = h.sql;
    h.sql = (() => {
      throw new Error('simulated carry-note read failure');
    }) as never;
    try {
      await expect(getLoopCarryNoteWithMeta(LOOP)).resolves.toEqual({
        note: null,
        updatedAtMs: null,
        readFailed: true,
      });
    } finally {
      h.sql = previousSql;
    }
  });

  it('a cold wake reads the SAME note the warm session left (the whole point)', async () => {
    await setLoopCarryNote(LOOP, 'reconstruct: mid-Phase-2, psu-host verbs half-wired');
    // A "cold" reader is just a fresh read on the same (harness, ownerId).
    expect(await getLoopCarryNote(LOOP)).toBe('reconstruct: mid-Phase-2, psu-host verbs half-wired');
  });

  it('returns after commit when the derived Orders invalidation never settles (EI-21390376601596579)', async () => {
    let release!: () => void;
    const stalledNotification = new Promise<void>((resolve) => {
      release = resolve;
    });
    ordersNotify.notifyAgentOrdersChanged.mockImplementationOnce(() => stalledNotification);

    let timer!: ReturnType<typeof setTimeout>;
    const result = await Promise.race([
      setLoopCarryNoteWithPrior(LOOP, 'near-limit carry anchor').then(() => 'settled' as const),
      new Promise<'timed_out'>((resolve) => {
        timer = setTimeout(() => resolve('timed_out'), 250);
      }),
    ]);
    clearTimeout(timer);

    // Release the deliberately stalled best-effort push so the test leaves no
    // pending promise behind, then verify the write itself completed.
    release();
    expect(result).toBe('settled');
    expect(await getLoopCarryNote(LOOP)).toBe('near-limit carry anchor');
  });

  it('the structured shape round-trips end-to-end (render → store → read → parse)', async () => {
    const fields = { did: 'built the substrate', left: 'psu-host', insight: 'reuse bee lifecycle', next: 'P-004' };
    await setLoopCarryNote(LOOP, renderCarryNote(fields));
    const read = await getLoopCarryNote(LOOP);
    expect(parseCarryNote(read ?? '')).toEqual(fields);
  });

  it('journaling ON: the loop trajectory accumulates newest-first and survives a clear', async () => {
    await setLoopCarryNote(LOOP, 'wake 1');
    await setLoopCarryNote(LOOP, 'wake 2');
    const j = await getLoopCarryJournal(LOOP);
    expect(j.map((e) => e.note)).toEqual(['wake 2', 'wake 1']); // newest-first
    // Clear the active note — the journal (trajectory) persists, row stays.
    expect(await setLoopCarryNote(LOOP, null)).toBeNull();
    expect(await getLoopCarryNote(LOOP)).toBeNull();
    expect((await getLoopCarryJournal(LOOP)).map((e) => e.note)).toEqual(['wake 2', 'wake 1']);
    expect(await rowCount()).toBe(1); // row lingers to hold the journal
  });

  it('bounded loop writes return a typed retryable contention error and preserve the prior note', async () => {
    const scope = loopScope(LOOP.harness, LOOP.ownerId);
    await setLoopCarryNote(LOOP, 'prior cold-wake anchor');

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lockedResolve!: () => void;
    const locked = new Promise<void>((resolve) => {
      lockedResolve = resolve;
    });
    const blocker = db.sql.begin(async (tx) => {
      await tx`
        SELECT note
          FROM harness_shared.carry_notes
         WHERE workspace_id = 'default' AND scope = ${scope}
         FOR UPDATE`;
      lockedResolve();
      await held;
    });

    await locked;
    const startedAt = Date.now();
    let error: unknown;
    try {
      await setLoopCarryNoteWithPrior(LOOP, 'blocked replacement');
    } catch (caught) {
      error = caught;
    } finally {
      release();
      await blocker;
    }

    expect(error).toMatchObject({ name: 'OrgTxnTimeoutError', pgCode: '55P03' });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(await getLoopCarryNote(LOOP)).toBe('prior cold-wake anchor');
  });

  it('expectedHash prevents a stale successor from replacing a newer note', async () => {
    await setLoopCarryNote(LOOP, 'newer checkpoint');

    const result = await setLoopCarryNoteWithPrior(LOOP, 'stale successor checkpoint', {
      expectedHash: shortCarryHash('older checkpoint'),
    });

    expect(result).toMatchObject({
      stored: 'newer checkpoint',
      blockedReason: 'expected_hash_mismatch',
      conflict: {
        expectedHash: shortCarryHash('older checkpoint'),
        currentHash: shortCarryHash('newer checkpoint'),
      },
    });
    expect(await getLoopCarryNote(LOOP)).toBe('newer checkpoint');
  });

  it('serializes same-baseline writers so exactly one wins the CAS', async () => {
    await setLoopCarryNote(LOOP, 'baseline checkpoint');
    const expectedHash = shortCarryHash('baseline checkpoint');

    const results = await Promise.all([
      setLoopCarryNoteWithPrior(LOOP, 'first successor', { expectedHash }),
      setLoopCarryNoteWithPrior(LOOP, 'second successor', { expectedHash }),
    ]);

    expect(results.filter((result) => result.conflict)).toHaveLength(1);
    expect(results.filter((result) => !result.conflict && result.stored !== 'baseline checkpoint')).toHaveLength(1);
    expect(['first successor', 'second successor']).toContain(await getLoopCarryNote(LOOP));
  });

  it('discards an older in-flight writer that commits after a newer checkpoint', async () => {
    await setLoopCarryNote(LOOP, 'baseline checkpoint');
    const scope = loopScope(LOOP.harness, LOOP.ownerId);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lockedResolve!: () => void;
    const locked = new Promise<void>((resolve) => {
      lockedResolve = resolve;
    });
    const blocker = db.sql.begin(async (tx) => {
      await tx`
        SELECT note
          FROM harness_shared.carry_notes
         WHERE workspace_id = 'default' AND scope = ${scope}
         FOR UPDATE`;
      lockedResolve();
      await held;
    });

    await locked;
    // Queue the newer writer first, then queue the stale writer with an older
    // admission watermark. Once the blocker releases, the newer commit wins
    // the lock queue and the stale writer must be rejected by the store guard.
    // Use the underlying unbounded writer so this ordering test is not coupled
    // to the loop wrapper's deliberately short contention budget. The separate
    // bounded-loop test above owns the 100ms lock-timeout regression.
    const write = (value: string) =>
      setCarryNoteWithPrior(
        { scope, workspaceId: 'default' },
        value,
        { bounded: false },
      );
    const newer = write('newer checkpoint');
    await new Promise((resolve) => setTimeout(resolve, 25));
    const staleClock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 10_000);
    const stale = write('stale checkpoint');
    staleClock.mockRestore();

    release();
    const [newerResult, staleResult] = await Promise.all([newer, stale]);
    await blocker;

    expect(newerResult.stored).toBe('newer checkpoint');
    expect(staleResult).toMatchObject({
      stored: 'newer checkpoint',
      blockedReason: 'stale_write_older_than_current',
      staleWrite: {
        currentUpdatedAtMs: expect.any(Number),
      },
    });
    expect(await getLoopCarryNote(LOOP)).toBe('newer checkpoint');
  });

  it('discards an older in-flight writer when admission timestamps are equal', async () => {
    await setLoopCarryNote(LOOP, 'baseline checkpoint');
    const scope = loopScope(LOOP.harness, LOOP.ownerId);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lockedResolve!: () => void;
    const locked = new Promise<void>((resolve) => {
      lockedResolve = resolve;
    });
    const blocker = db.sql.begin(async (tx) => {
      await tx`
        SELECT note
          FROM harness_shared.carry_notes
         WHERE workspace_id = 'default' AND scope = ${scope}
         FOR UPDATE`;
      lockedResolve();
      await held;
    });

    await locked;
    // Force both callers to capture the same admission watermark. The newer
    // request is queued first and commits first; the older request then sees
    // an equal updated_ts. A strict `>` stale-write guard incorrectly admits
    // that older write and loses the newer checkpoint.
    const fixedNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    // Use the underlying writer without the loop wrapper's deliberately short
    // lock budget. This test owns the row lock and must isolate ordering from
    // unrelated test-container contention.
    const write = (value: string) =>
      setCarryNoteWithPrior(
        { scope, workspaceId: 'default' },
        value,
        { bounded: false },
      );
    const newer = write('newer checkpoint');
    await new Promise((resolve) => setTimeout(resolve, 25));
    const stale = write('stale checkpoint');
    clock.mockRestore();

    release();
    const [newerResult, staleResult] = await Promise.all([newer, stale]);
    await blocker;

    expect(newerResult.stored).toBe('newer checkpoint');
    expect(staleResult).toMatchObject({
      stored: 'newer checkpoint',
      blockedReason: 'stale_write_older_than_current',
      staleWrite: {
        writeStartedAtMs: fixedNow,
        currentUpdatedAtMs: fixedNow,
      },
    });
    expect(await getLoopCarryNote(LOOP)).toBe('newer checkpoint');
  });
});

describe('D-003 shared semantics + journaling modes', () => {
  it('journaling OFF (bee checkpoint): no ring, and a CLEAR deletes the row', async () => {
    const wi = { scope: workItemScope('h1', 'WI-1') };
    expect(await setCarryNote(wi, 'phase 2 of 5', { journal: false })).toBe('phase 2 of 5');
    expect(await getCarryNote(wi)).toBe('phase 2 of 5');
    expect(await getCarryJournal(wi)).toEqual([]); // no trajectory ring
    expect(await rowCount()).toBe(1);
    // Clear ⇒ row deleted (graceful degradation, mig 281 semantics).
    expect(await setCarryNote(wi, '  ', { journal: false })).toBeNull();
    expect(await getCarryNote(wi)).toBeNull();
    expect(await rowCount()).toBe(0);
  });

  it('any length round-trips (no cap on the active note)', async () => {
    const big = 'x'.repeat(200_000);
    await setCarryNote({ scope: workItemScope('h1', 'WI-BIG') }, big, { journal: false });
    expect(await getCarryNote({ scope: workItemScope('h1', 'WI-BIG') })).toBe(big);
  });

  it('reading a missing / cleared note returns null; missing journal returns []', async () => {
    expect(await getCarryNote({ scope: 'nope' })).toBeNull();
    expect(await getCarryJournal({ scope: 'nope' })).toEqual([]);
  });
});

describe('the three roles converge on ONE store, isolated by scope + workspace', () => {
  it('hive / workitem / loop are distinct rows in the same table', async () => {
    await setCarryNote({ scope: hiveScope() }, 'queen note');
    await setCarryNote({ scope: workItemScope('h1', 'WI-9') }, 'bee note', { journal: false });
    await setLoopCarryNote(LOOP, 'loop note');
    expect(await rowCount()).toBe(3);
    expect(await getCarryNote({ scope: hiveScope() })).toBe('queen note');
    expect(await getCarryNote({ scope: workItemScope('h1', 'WI-9') })).toBe('bee note');
    expect(await getLoopCarryNote(LOOP)).toBe('loop note');
  });

  it('base store is workspace-scoped; LOOP notes are workspace-PINNED + skew-tolerant', async () => {
    // The generic store isolates by workspace…
    await setCarryNote({ scope: 'iso-scope', workspaceId: 'other-ws' }, 'theirs', { journal: false });
    expect(await getCarryNote({ scope: 'iso-scope' })).toBeNull(); // default ws
    expect(await getCarryNote({ scope: 'iso-scope', workspaceId: 'other-ws' })).toBe('theirs');
    // …but the LOOP wrapper deliberately PINS the coord workspace on write and
    // falls back to any-workspace on read (2026-07-03 cold-auto host-skew fix:
    // the producer and the wake-executor must address the same row no matter
    // which host/ctx they run under) — a caller-supplied workspaceId is ignored,
    // so the note resolves for the same (harness, ownerId) from ANY ctx.
    await setLoopCarryNote({ ...LOOP, workspaceId: 'other-ws' }, 'mine');
    expect(await getLoopCarryNote(LOOP)).toBe('mine');
    expect(await getLoopCarryNote({ ...LOOP, workspaceId: 'other-ws' })).toBe('mine');
  });

  it('loop readers choose the newest host-skew row; the coord workspace only breaks timestamp ties', async () => {
    const scope = loopScope(LOOP.harness, LOOP.ownerId);
    await db.sql`
      INSERT INTO harness_shared.carry_notes (workspace_id, scope, note, journal, updated_ts)
      VALUES
        ('default', ${scope}, 'stale pinned checkpoint', '[{"at":1,"note":"stale"}]'::jsonb, 1700000000000),
        ('old-host-workspace', ${scope}, 'new fallback checkpoint', '[{"at":2,"note":"new"}]'::jsonb, 1700000001000)`;

    expect(await getLoopCarryNote(LOOP)).toBe('new fallback checkpoint');
    expect(await getLoopCarryNoteWithMeta(LOOP)).toEqual({
      note: 'new fallback checkpoint',
      updatedAtMs: 1700000001000,
      readFailed: false,
    });
    expect((await getLoopCarryJournal(LOOP)).map((entry) => entry.note)).toEqual(['new']);

    await db.sql`
      UPDATE harness_shared.carry_notes
         SET updated_ts = 1700000000000
       WHERE workspace_id = 'old-host-workspace' AND scope = ${scope}`;
    expect(await getLoopCarryNoteWithMeta(LOOP)).toEqual({
      note: 'stale pinned checkpoint',
      updatedAtMs: 1700000000000,
      readFailed: false,
    });
  });

  it('loopScope keys by ownerId — two loops on the same harness do not collide', async () => {
    await setLoopCarryNote({ harness: 'papercusp', ownerId: 'su-a' }, 'A');
    await setLoopCarryNote({ harness: 'papercusp', ownerId: 'su-b' }, 'B');
    expect(await getLoopCarryNote({ harness: 'papercusp', ownerId: 'su-a' })).toBe('A');
    expect(await getLoopCarryNote({ harness: 'papercusp', ownerId: 'su-b' })).toBe('B');
    expect(loopScope('papercusp', 'su-a')).not.toBe(loopScope('papercusp', 'su-b'));
  });
});

describe("WI-3648: a '*' workspaceId (the unscoped-superuser read wildcard) never keys its own row", () => {
  // Same bug class as EI-8824/EI-3409/WI-892, but on the READ side: '*' is
  // TRUTHY, so a bare `ref.workspaceId ?? activeWorkspaceId()` let it win
  // outright instead of falling back — silently keying a wildcard-scoped
  // caller's read/write under the literal workspace_id='*', divergent from
  // every concrete-workspace write/read of the SAME scope. Observed live: a
  // work_items:checkpoint write (which resolves through
  // resolveConcreteWorkspaceId, per EI-8824) landed under the concrete ws, but
  // orient's post-compaction recovery fold (carry-brief.ts's
  // readHeldWorkItems → getWorkItemCheckpoint) passed ctx.workspaceId — '*'
  // for an unscoped su session — straight through, so the read missed the
  // fresh write and silently returned a stale row (or nothing).
  it("'*' resolves to the SAME concrete row as omitting workspaceId — not its own separate row", async () => {
    const scope = workItemScope('h1', 'WI-wildcard');
    expect(await setCarryNote({ scope }, 'written under the concrete default ws', { journal: false })).toBe(
      'written under the concrete default ws',
    );
    // A caller passing the wildcard explicitly (e.g. an unscoped superuser
    // ctx.workspaceId) must read back the SAME row as a caller that omitted
    // workspaceId entirely — never a distinct, always-empty '*'-keyed row.
    expect(await getCarryNote({ scope, workspaceId: '*' })).toBe('written under the concrete default ws');
    // And a write under the wildcard lands on that same concrete row too —
    // round-trips through the wildcard exactly like omitting it.
    expect(await setCarryNote({ scope, workspaceId: '*' }, 'updated via wildcard', { journal: false })).toBe(
      'updated via wildcard',
    );
    expect(await getCarryNote({ scope })).toBe('updated via wildcard');
    expect(await rowCount()).toBe(1); // never a second, orphaned '*' row
  });

  it('an empty-string workspaceId is treated the same as omitted/wildcard — not its own row', async () => {
    const scope = workItemScope('h1', 'WI-empty-ws');
    await setCarryNote({ scope, workspaceId: '' }, 'via empty string', { journal: false });
    expect(await getCarryNote({ scope })).toBe('via empty string');
    expect(await rowCount()).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// P-007/R-06 — unchanged attestation.
//
// The measured problem: 347 flush-gate refusals in 48h provoked 339 checkpoint
// writes whose only purpose was to clear the gate, and only 0.2% of same-item
// rewrites were byte-identical — i.e. agents pay to invent fresh prose about
// state that did not move. Attestation lets an agent say "still current" instead
// of rewriting, WITHOUT letting it conceal state that did move.
//
// Every test below is about that second clause. The value of the feature is the
// bound, not the convenience: an attestation must be able to DEFER a flush and
// never to REPLACE one, so the suite is weighted toward the refusals.
// ───────────────────────────────────────────────────────────────────────────────

type AttestRow = { note: string | null; updated_ts: number; body_ts: number | null; attested_count: number };
async function attestRow(scope: string): Promise<AttestRow> {
  const rows = await db.sql<
    Array<{ note: string | null; updated_ts: string; body_ts: string | null; attested_count: number }>
  >`
    SELECT note, updated_ts, body_ts, attested_count
      FROM harness_shared.carry_notes WHERE scope = ${scope}`;
  const row = rows[0];
  if (!row) throw new Error(`no carry_notes row for scope ${scope}`);
  return {
    note: row.note,
    updated_ts: Number(row.updated_ts),
    body_ts: row.body_ts == null ? null : Number(row.body_ts),
    attested_count: Number(row.attested_count),
  };
}

describe('P-007/R-06 unchanged attestation — freshness without a rewrite', () => {
  it('records the production admin-pool acquisition for a bounded attestation', async () => {
    const scope = workItemScope('h1', 'WI-attest-acquire');
    await setCarryNote({ scope }, 'stable body', { journal: false });
    const before = acquireSnapshot('org-admin').totalAcquired;

    const result = await attestCarryNoteUnchanged({ scope }, {
      contentHash: shortCarryHash('stable body'),
      bounded: true,
    });

    expect(result.ok).toBe(true);
    expect(acquireSnapshot('org-admin').totalAcquired).toBeGreaterThan(before);
  });

  it('refreshes freshness while leaving the body byte-identical (updated_ts moves, body_ts does not)', async () => {
    const scope = workItemScope('h1', 'WI-attest-happy');
    const body = 'did: read the gate code. left: tests. next: write them.';
    await setCarryNote({ scope }, body, { journal: false });

    const before = await attestRow(scope);
    // A real write pins BOTH stamps together and zeroes the chain; that shared
    // starting point is what makes the divergence below meaningful.
    expect(before.body_ts).toBe(before.updated_ts);
    expect(before.attested_count).toBe(0);

    const res = await attestCarryNoteUnchanged({ scope }, {
      contentHash: shortCarryHash(body),
      nowMs: before.updated_ts + 60_000,
    });
    expect(res.ok).toBe(true);
    expect(res.refusedReason).toBeUndefined();
    expect(res.currentHash).toBe(shortCarryHash(body));
    expect(res.attestedCount).toBe(1);
    expect(res.bodyAgeMs).toBe(60_000);
    expect(res.remainingAttestations).toBe(CARRY_NOTE_ATTESTATION_MAX_CHAIN - 1);

    const after = await attestRow(scope);
    expect(after.note).toBe(body); // the whole point: no rewrite
    expect(after.updated_ts).toBe(before.updated_ts + 60_000); // freshness refreshed
    // The decisive one. If body_ts moved with it, the body's age would restart on
    // every attestation and the absolute-age ceiling below could be evaded forever.
    expect(after.body_ts).toBe(before.body_ts);
    expect(after.attested_count).toBe(1);
    // …and no second row: attestation writes the SAME key, never a parallel one.
    expect(await rowCount()).toBe(1);
  });

  it('G1: a hash that does not match the stored body refuses, names the real hash, and consumes no budget', async () => {
    const scope = workItemScope('h1', 'WI-attest-g1');
    await setCarryNote({ scope }, 'the stored body', { journal: false });
    const before = await attestRow(scope);

    const res = await attestCarryNoteUnchanged({ scope }, {
      contentHash: shortCarryHash('a body the agent never read'),
      nowMs: before.updated_ts + 1_000,
    });
    expect(res.ok).toBe(false);
    expect(res.refusedReason).toBe('attestation_hash_mismatch');
    // Returned so the caller can re-read what is actually there rather than guess.
    expect(res.currentHash).toBe(shortCarryHash('the stored body'));

    // A refusal must be inert. If it consumed a chain slot, a caller that guessed
    // wrong once would silently shrink the allowance left for a legitimate one.
    expect(await attestRow(scope)).toEqual(before);
  });

  it('G1: a hash captured BEFORE another writer replaced the body is refused, not re-blessed', async () => {
    const scope = workItemScope('h1', 'WI-attest-raced');
    await setCarryNote({ scope }, 'state as this agent last saw it', { journal: false });
    const staleHash = shortCarryHash('state as this agent last saw it');

    // A peer (or this agent's own successor) writes real new state.
    await setCarryNote({ scope }, 'state after somebody else wrote', { journal: false });

    const res = await attestCarryNoteUnchanged({ scope }, { contentHash: staleHash });
    expect(res.ok).toBe(false);
    expect(res.refusedReason).toBe('attestation_hash_mismatch');
    expect(res.currentHash).toBe(shortCarryHash('state after somebody else wrote'));
    // The replaced body is untouched — an attestation can never resurrect the old one.
    expect((await attestRow(scope)).note).toBe('state after somebody else wrote');
  });

  it('refuses when nothing is stored — a missing checkpoint is writable, never attestable', async () => {
    // No row at all.
    const empty = await attestCarryNoteUnchanged({ scope: workItemScope('h1', 'WI-attest-none') }, {
      contentHash: shortCarryHash('anything'),
    });
    expect(empty).toMatchObject({ ok: false, refusedReason: 'attestation_no_checkpoint', currentHash: null });

    // A row that survives a CLEAR (journaling on keeps the row with note → null) is
    // the same answer: there is no body to be still-current about.
    const scope = workItemScope('h1', 'WI-attest-cleared');
    await setCarryNote({ scope }, 'something', { journal: true });
    await setCarryNote({ scope }, null, { journal: true });
    expect((await attestRow(scope)).note).toBeNull(); // row survived the clear
    const cleared = await attestCarryNoteUnchanged({ scope }, { contentHash: shortCarryHash('something') });
    expect(cleared.refusedReason).toBe('attestation_no_checkpoint');
  });

  it('G3: the chain ceiling is real — attestation N+1 against one body is refused', async () => {
    const scope = workItemScope('h1', 'WI-attest-chain');
    const body = 'unchanged for a while now';
    await setCarryNote({ scope }, body, { journal: false });
    const hash = shortCarryHash(body);
    const base = (await attestRow(scope)).updated_ts;

    for (let n = 1; n <= CARRY_NOTE_ATTESTATION_MAX_CHAIN; n++) {
      const ok = await attestCarryNoteUnchanged({ scope }, { contentHash: hash, nowMs: base + n * 1_000 });
      expect(ok.ok).toBe(true);
      expect(ok.attestedCount).toBe(n);
      expect(ok.remainingAttestations).toBe(CARRY_NOTE_ATTESTATION_MAX_CHAIN - n);
    }

    const spent = await attestCarryNoteUnchanged({ scope }, {
      contentHash: hash,
      nowMs: base + (CARRY_NOTE_ATTESTATION_MAX_CHAIN + 1) * 1_000,
    });
    expect(spent.ok).toBe(false);
    expect(spent.refusedReason).toBe('attestation_exhausted');
    expect(spent.attestedCount).toBe(CARRY_NOTE_ATTESTATION_MAX_CHAIN);
    expect(spent.remainingAttestations).toBe(0);
    // The exhausted attestation refreshed nothing — the body's freshness is frozen
    // at the last admitted attestation, which is what forces the real write.
    expect(await attestRow(scope)).toMatchObject({
      updated_ts: base + CARRY_NOTE_ATTESTATION_MAX_CHAIN * 1_000,
      attested_count: CARRY_NOTE_ATTESTATION_MAX_CHAIN,
    });
  });

  it('G3: a real body write resets the chain — attestation DEFERS a flush, it never replaces one', async () => {
    const scope = workItemScope('h1', 'WI-attest-reset');
    await setCarryNote({ scope }, 'first body', { journal: false });
    const hash = shortCarryHash('first body');
    for (let n = 0; n < CARRY_NOTE_ATTESTATION_MAX_CHAIN; n++) {
      expect((await attestCarryNoteUnchanged({ scope }, { contentHash: hash })).ok).toBe(true);
    }
    expect((await attestCarryNoteUnchanged({ scope }, { contentHash: hash })).refusedReason).toBe(
      'attestation_exhausted',
    );

    // The agent does what the refusal told it to do: writes real state.
    await setCarryNote({ scope }, 'second body, actually rewritten', { journal: false });
    const afterWrite = await attestRow(scope);
    expect(afterWrite.attested_count).toBe(0); // budget restored by the WRITE, not by time
    expect(afterWrite.body_ts).toBe(afterWrite.updated_ts); // the body's age restarts too

    const again = await attestCarryNoteUnchanged({ scope }, {
      contentHash: shortCarryHash('second body, actually rewritten'),
    });
    expect(again.ok).toBe(true);
    expect(again.attestedCount).toBe(1);
  });

  it('G3: a body older than the absolute age ceiling is refused even with the chain untouched', async () => {
    const scope = workItemScope('h1', 'WI-attest-old');
    const body = 'written long ago';
    await setCarryNote({ scope }, body, { journal: false });
    const bodyTs = (await attestRow(scope)).body_ts!;
    const hash = shortCarryHash(body);

    // Exactly AT the ceiling still passes — the bound is `>`, and a boundary that
    // silently refused early would make the ceiling untestable from its own value.
    const atCeiling = await attestCarryNoteUnchanged({ scope }, {
      contentHash: hash,
      nowMs: bodyTs + CARRY_NOTE_ATTESTATION_MAX_BODY_AGE_MS,
    });
    expect(atCeiling.ok).toBe(true);
    expect(atCeiling.bodyAgeMs).toBe(CARRY_NOTE_ATTESTATION_MAX_BODY_AGE_MS);

    const past = await attestCarryNoteUnchanged({ scope }, {
      contentHash: hash,
      nowMs: bodyTs + CARRY_NOTE_ATTESTATION_MAX_BODY_AGE_MS + 1,
    });
    expect(past.ok).toBe(false);
    expect(past.refusedReason).toBe('attestation_exhausted');
    // Chain budget was NOT the thing that ran out — this is the age backstop, and it
    // is what makes "cannot conceal changed state" true by construction rather than
    // by the agent's good faith.
    expect(past.attestedCount).toBeLessThan(CARRY_NOTE_ATTESTATION_MAX_CHAIN);
    expect(past.bodyAgeMs).toBe(CARRY_NOTE_ATTESTATION_MAX_BODY_AGE_MS + 1);
  });

  it('a pre-1118 row (NULL body_ts) reads its last touch as the body write, instead of refusing forever', async () => {
    const scope = workItemScope('h1', 'WI-attest-pre1118');
    const body = 'written before migration 1118 existed';
    await setCarryNote({ scope }, body, { journal: false });
    // Simulate a row the backfill did not reach.
    await db.sql`UPDATE harness_shared.carry_notes SET body_ts = NULL WHERE scope = ${scope}`;
    const updatedTs = (await attestRow(scope)).updated_ts;

    const res = await attestCarryNoteUnchanged({ scope }, {
      contentHash: shortCarryHash(body),
      nowMs: updatedTs + 5_000,
    });
    // Reading a NULL body_ts as 0 instead of coalescing to updated_ts would make every
    // such row look ~56 years old and refuse permanently — a silent, total regression
    // for exactly the rows that predate the feature.
    expect(res.ok).toBe(true);
    expect(res.bodyAgeMs).toBe(5_000);
  });

  it('the chain ceiling holds under CONCURRENT attestations — the read and the increment are atomic', async () => {
    const scope = workItemScope('h1', 'WI-attest-race');
    const body = 'contended body';
    await setCarryNote({ scope }, body, { journal: false });
    const hash = shortCarryHash(body);

    // Four in flight against a ceiling of two, on a pool of four connections. Without
    // the FOR UPDATE the concurrent transactions read the SAME count and each commits
    // an increment, admitting more than the ceiling allows — the bound stops being a
    // bound exactly when contention is highest.
    const results = await Promise.all(
      Array.from({ length: 4 }, () => attestCarryNoteUnchanged({ scope }, { contentHash: hash, maxChain: 2 })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => r.refusedReason === 'attestation_exhausted')).toHaveLength(2);
    expect((await attestRow(scope)).attested_count).toBe(2);
    // Admitted attestations are numbered 1..N with no duplicates — proof the counter
    // was serialized rather than each caller having read a shared stale value.
    expect(
      results
        .filter((r) => r.ok)
        .map((r) => r.attestedCount)
        .sort(),
    ).toEqual([1, 2]);
  });

  it('an attestation never touches a DIFFERENT scope, and never invents a row', async () => {
    const mine = workItemScope('h1', 'WI-attest-mine');
    const other = workItemScope('h1', 'WI-attest-other');
    await setCarryNote({ scope: mine }, 'mine', { journal: false });
    await setCarryNote({ scope: other }, 'other', { journal: false });
    const otherBefore = await attestRow(other);

    expect((await attestCarryNoteUnchanged({ scope: mine }, { contentHash: shortCarryHash('mine') })).ok).toBe(true);
    expect(await attestRow(other)).toEqual(otherBefore);
    expect(await rowCount()).toBe(2); // a refused/absent scope must not upsert a row
  });
});
