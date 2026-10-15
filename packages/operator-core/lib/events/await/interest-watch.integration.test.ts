/**
 * interest-watch.integration.test.ts — the P-008 interest-watch sweep against a
 * real Postgres (pgvector), get-feedback-relevance-consults-2026-08-16.
 *
 * Fixture geometry (same trick as relevance-router.integration.test.ts):
 * 768-d unit vectors from a single direction angle, v(θ) = [cos θ, sin θ, 0, …],
 * so cosine similarity between the stored interest v(0) and a turn v(θ) is
 * exactly cos θ and every floor decision is analytically checkable.
 *
 * What only a real-PG test can prove here:
 *  - the sweep SQL (workspace OR 'default', self-exclusion, machine-surface
 *    exclusion with NULL-verdict pass, floor, window bounds) on real pgvector;
 *  - THE FRONTIER: embeddings are ASYNC-backfilled in prod, so a turn can be
 *    ingested now and embedded later. The frontier test is this suite's
 *    falsifiability control — a naive "scan since last sweep" watermark passes
 *    every other case and FAILS that one (the late-embedded turn is silently
 *    skipped forever, the classic never-fires bug);
 *  - exactly-once delivery across sweeps (watermark advance, no duplicates);
 *  - GC against real event_awaits / coord_entity_subscriptions liveness shapes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { randomBytes, randomUUID } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import {
  resolveProseProfileSelection,
  type ProseProfileSelection,
} from '../../search/prose-vector-dims';
import {
  claimDueInterestWatches,
  computeSweepWindow,
  gcOrphanedInterestWatches,
  registerInterestWatch,
  sweepInterestWatch,
  INTEREST_MATCHES_PER_SWEEP,
  INTEREST_WATERMARK_LAG_MS,
  type InterestEmitOpts,
  type InterestSweepDeps,
  type InterestWatchRow,
} from './interest-watch';

const WS = 'ws-interest';
const ME = 'agent-me';
const NOW = new Date('2026-08-16T12:00:00Z');
const SEC = 1000;
const GEMMA_QUERY_PROFILE = resolveProseProfileSelection('gemma', EMBEDDER_DIM_SPECS.gemma)!;

/** 768-d unit vector at angle θ in the (0,1) plane. */
const vecAt = (theta: number): number[] => {
  const v = new Array<number>(768).fill(0);
  v[0] = Math.cos(theta);
  v[1] = Math.sin(theta);
  return v;
};

let rootSql: Sql;

let turnSeq = 0;
async function insertTurn(
  owner: string,
  theta: number | null, // null = NOT yet embedded (the async-backfill state)
  ingestedAgoMs: number,
  over: {
    verdict?: string | null;
    ws?: string;
    text?: string;
    mode?: string | null;
    profile?: string | null;
  } = {},
): Promise<{ session_id: string; turn_idx: number }> {
  turnSeq += 1;
  const sessionId = `sess-${owner}`;
  await rootSql`
    INSERT INTO harness_shared.session_turns
      (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text,
       ingested_at, text_embedding, text_embedding_mode, text_embedding_profile, turn_origin_verdict)
    VALUES (${over.ws ?? 'default'}, 'claude', ${sessionId}, ${turnSeq},
            ${new Date(NOW.getTime() - ingestedAgoMs).toISOString()}::timestamptz,
            ${owner}, 'assistant', ${over.text ?? `turn ${turnSeq} of ${owner}`},
            ${new Date(NOW.getTime() - ingestedAgoMs).toISOString()}::timestamptz,
            ${theta === null ? null : JSON.stringify(vecAt(theta))}::vector,
            ${over.mode === undefined ? (theta === null ? null : 'gemma') : over.mode},
            ${over.profile === undefined ? (theta === null ? null : EMBEDDER_DIM_SPECS.gemma.profileId) : over.profile},
            ${over.verdict ?? null})`;
  return { session_id: sessionId, turn_idx: turnSeq };
}

/** Register a watch whose watermark sits 60s+LAG before NOW (so turns ingested
 *  in the last minute are candidates), floored at cos-similarity `floor`. */
async function mkWatch(over: {
  floor?: number;
  once?: boolean;
  ownerId?: string;
  theta?: number;
  mode?: string;
  profile?: ProseProfileSelection;
} = {}): Promise<InterestWatchRow> {
  const id = randomUUID();
  return registerInterestWatch(rootSql, {
    id,
    workspaceId: WS,
    ownerId: over.ownerId ?? ME,
    eventKey: `interest:${id}`,
    interest: 'test interest',
    embedding: vecAt(over.theta ?? 0),
    embeddingMode: over.mode ?? 'gemma',
    embeddingProfile: over.profile ?? GEMMA_QUERY_PROFILE,
    simFloor: over.floor ?? 0.55,
    once: over.once ?? false,
    now: new Date(NOW.getTime() - 60 * SEC),
  });
}

function recordingDeps(): { deps: InterestSweepDeps; emits: InterestEmitOpts[] } {
  const emits: InterestEmitOpts[] = [];
  return {
    deps: {
      getSql: () => rootSql,
      emit: async (o) => {
        emits.push(o);
      },
      now: () => NOW,
    },
    emits,
  };
}

async function reload(id: string): Promise<{ active: boolean; fire_count: number; watermark: Date; last_error: string | null; consecutive_errors: number }> {
  const rows = await rootSql`
    SELECT active, fire_count, watermark, last_error, consecutive_errors
      FROM harness_shared.interest_watches WHERE id = ${id}`;
  const r = rows[0] as { active: boolean; fire_count: number; watermark: Date; last_error: string | null; consecutive_errors: number };
  return r;
}

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `interestw_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
  await rootSql.unsafe('CREATE SCHEMA harness_shared');
  // Mirrors of the migration-owned tables, only the columns this module touches
  // (session_turns per migrations 501+; interest_watches per migration 839).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.session_turns (
      workspace_id text NOT NULL DEFAULT 'default',
      source_kind text NOT NULL,
      session_id text NOT NULL,
      turn_idx integer NOT NULL,
      ts timestamptz,
      owner text,
      speaker text NOT NULL,
      text text NOT NULL,
      ingested_at timestamptz NOT NULL DEFAULT now(),
      text_embedding vector(768),
      text_embedding_mode text,
      text_embedding_profile text,
      turn_origin_verdict text,
      PRIMARY KEY (workspace_id, source_kind, session_id, turn_idx)
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.interest_watches (
      id uuid PRIMARY KEY,
      workspace_id text NOT NULL,
      owner_id text NOT NULL,
      harness_slug text,
      event_key text NOT NULL,
      interest text NOT NULL,
      embedding vector(768),
      embedding_mode text,
      embedding_profile text,
      sim_floor double precision NOT NULL,
      interval_sec integer NOT NULL DEFAULT 120,
      once boolean NOT NULL DEFAULT false,
      watermark timestamptz NOT NULL DEFAULT now(),
      last_swept_at timestamptz,
      last_match_count integer,
      fire_count integer NOT NULL DEFAULT 0,
      last_error text,
      consecutive_errors integer NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.event_awaits (
      id bigserial PRIMARY KEY,
      workspace_id text NOT NULL,
      event_key text NOT NULL,
      once boolean NOT NULL DEFAULT true,
      fired_at timestamptz,
      cancelled_at timestamptz,
      expires_ts timestamptz
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.coord_entity_subscriptions (
      id bigserial PRIMARY KEY,
      workspace_id text NOT NULL DEFAULT 'default',
      subscriber_id text NOT NULL,
      target_kind text NOT NULL,
      target_ref text NOT NULL,
      cancelled_at timestamptz,
      expires_ts timestamptz
    )`);
});

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

// Each test builds its own corpus — turns from a previous test must not leak
// into exact-owner assertions (every watch sees the shared 'default' corpus).
beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.session_turns`;
});

describe('sweepInterestWatch', () => {
  it('fires ONE coalesced emit with owner/sim/excerpt evidence, advances the watermark, and never re-fires', async () => {
    const watch = await mkWatch();
    const t = await insertTurn('peer-a', 0.2, 30 * SEC, { text: 'working on the release gate refire path' });
    const { deps, emits } = recordingDeps();

    const r1 = await sweepInterestWatch(watch, deps);
    expect(r1.fired).toBe(true);
    expect(r1.matchCount).toBe(1);
    expect(emits).toHaveLength(1);
    expect(emits[0].key).toBe(watch.eventKey);
    expect(emits[0].summary).toContain('interest matched');
    const payload = emits[0].payload as { matches: Array<{ owner: string; sim: number; excerpt: string; session_id: string }> };
    expect(payload.matches[0].owner).toBe('peer-a');
    expect(payload.matches[0].session_id).toBe(t.session_id);
    expect(payload.matches[0].sim).toBeCloseTo(Math.cos(0.2), 2);
    expect(payload.matches[0].excerpt).toContain('release gate');

    const after = await reload(watch.id);
    expect(after.fire_count).toBe(1);
    expect(after.active).toBe(true); // standing — not once
    // The watermark advanced to the window end (claimNow - lag), past the turn.
    expect(after.watermark.getTime()).toBe(NOW.getTime() - INTEREST_WATERMARK_LAG_MS);

    // Second sweep over the SAME state: nothing new → no emit (exactly-once).
    const reread = { ...watch, watermark: after.watermark.toISOString() };
    const r2 = await sweepInterestWatch(reread, deps);
    expect(r2.fired).toBe(false);
    expect(emits).toHaveLength(1);
  });

  it('holds the floor honestly — and the SAME turn fires when the floor is lowered (calibration control)', async () => {
    const far = 1.4; // cos(1.4) ≈ 0.17 — well below 0.55
    const strict = await mkWatch({ floor: 0.55 });
    await insertTurn('peer-b', far, 30 * SEC);
    const { deps, emits } = recordingDeps();
    const r = await sweepInterestWatch(strict, deps);
    expect(r.fired).toBe(false);
    expect(emits).toHaveLength(0);

    // Control: prove the no-fire came from the FLOOR, not from the turn being
    // invisible for an unrelated reason (scope bug, window bug, embedding bug).
    const lax = await mkWatch({ floor: 0.1 });
    const rLax = await sweepInterestWatch(lax, deps);
    expect(rLax.fired).toBe(true);
  });

  it('never matches the watcher own-turns; a peer turn in the same shape fires', async () => {
    const watch = await mkWatch();
    await insertTurn(ME, 0.1, 30 * SEC);
    const { deps, emits } = recordingDeps();
    const r = await sweepInterestWatch(watch, deps);
    expect(r.fired).toBe(false);
    expect(emits).toHaveLength(0);

    const watch2 = await mkWatch();
    await insertTurn('peer-self-ctl', 0.1, 25 * SEC);
    const r2 = await sweepInterestWatch(watch2, deps);
    expect(r2.fired).toBe(true);
    // Only the peer turn — never the watcher's own.
    const owners = (emits[0].payload as { matches: Array<{ owner: string }> }).matches.map((m) => m.owner);
    expect(owners).toEqual(['peer-self-ctl']);
  });

  it('excludes machine-surface turns; a NULL (never-classified) verdict passes — router-corpus parity', async () => {
    const watch = await mkWatch();
    await insertTurn('peer-mach', 0.05, 30 * SEC, { verdict: 'machine-surface' });
    await insertTurn('peer-null', 0.3, 28 * SEC, { verdict: null });
    const { deps, emits } = recordingDeps();
    const r = await sweepInterestWatch(watch, deps);
    expect(r.fired).toBe(true);
    const owners = (emits[0].payload as { matches: Array<{ owner: string }> }).matches.map((m) => m.owner);
    expect(owners).toEqual(['peer-null']);
  });

  it('FRONTIER: a young un-embedded turn halts the window; once embedded, BOTH turns fire on the next sweep (kills the naive watermark)', async () => {
    const watch = await mkWatch();
    // T1 ingested first, NOT yet embedded (async backfill in flight); T2 after
    // it, already embedded and matching.
    const t1 = await insertTurn('peer-late', null, 40 * SEC);
    await insertTurn('peer-early', 0.25, 30 * SEC);
    const { deps, emits } = recordingDeps();

    // Sweep 1: the frontier stops 1ms before T1 → T2 is NOT yet scanned (it is
    // beyond the frontier), and nothing fires. A naive since-last-sweep
    // watermark fires T2 here and then SKIPS T1 FOREVER — this is the control
    // that makes that implementation fail.
    const r1 = await sweepInterestWatch(watch, deps);
    expect(r1.fired).toBe(false);
    expect(emits).toHaveLength(0);
    const after1 = await reload(watch.id);
    expect(after1.watermark.getTime()).toBe(NOW.getTime() - 40 * SEC - 1);

    // The backfill lands T1's embedding (matching too).
    await rootSql`
      UPDATE harness_shared.session_turns
         SET text_embedding = ${JSON.stringify(vecAt(0.15))}::vector,
             text_embedding_mode = 'gemma',
             text_embedding_profile = ${EMBEDDER_DIM_SPECS.gemma.profileId}
       WHERE session_id = ${t1.session_id} AND turn_idx = ${t1.turn_idx}`;

    // Sweep 2: window now runs to claimNow - lag → BOTH turns fire, once.
    const reread = { ...watch, watermark: after1.watermark.toISOString() };
    const r2 = await sweepInterestWatch(reread, deps);
    expect(r2.fired).toBe(true);
    expect(r2.matchCount).toBe(2);
    const owners = (emits[0].payload as { matches: Array<{ owner: string }> }).matches.map((m) => m.owner).sort();
    expect(owners).toEqual(['peer-early', 'peer-late']);
  });

  it('an ABANDONED un-embedded turn (older than the horizon) stops blocking the frontier', async () => {
    const watch = await mkWatch();
    // Un-embedded, 40 min old — the backfill has abandoned it. Insert it inside
    // the window by giving the watch an old watermark.
    await rootSql`
      UPDATE harness_shared.interest_watches
         SET watermark = ${new Date(NOW.getTime() - 60 * 60 * SEC).toISOString()}::timestamptz
       WHERE id = ${watch.id}`;
    await insertTurn('peer-abandoned', null, 40 * 60 * SEC);
    await insertTurn('peer-fresh', 0.2, 30 * SEC);
    const { deps, emits } = recordingDeps();
    const reread = { ...watch, watermark: new Date(NOW.getTime() - 60 * 60 * SEC).toISOString() };
    const r = await sweepInterestWatch(reread, deps);
    expect(r.fired).toBe(true);
    const owners = (emits[0].payload as { matches: Array<{ owner: string }> }).matches.map((m) => m.owner);
    expect(owners).toContain('peer-fresh');
  });

  it('caps a burst at INTEREST_MATCHES_PER_SWEEP in ONE coalesced emit, best matches first', async () => {
    const watch = await mkWatch();
    for (let i = 0; i < INTEREST_MATCHES_PER_SWEEP + 2; i++) {
      await insertTurn(`peer-burst-${i}`, 0.1 + i * 0.02, 30 * SEC - i);
    }
    const { deps, emits } = recordingDeps();
    const r = await sweepInterestWatch(watch, deps);
    expect(r.fired).toBe(true);
    expect(emits).toHaveLength(1);
    const matches = (emits[0].payload as { matches: Array<{ sim: number }> }).matches;
    expect(matches).toHaveLength(INTEREST_MATCHES_PER_SWEEP);
    // Best-first ordering.
    for (let i = 1; i < matches.length; i++) expect(matches[i - 1].sim).toBeGreaterThanOrEqual(matches[i].sim);
  });

  it('rejects same-mode foreign exact profiles but accepts legacy NULL only for the mode current profile', async () => {
    const strict = await mkWatch();
    await insertTurn('peer-foreign-profile', 0.05, 30 * SEC, {
      mode: 'gemma',
      profile: EMBEDDER_DIM_SPECS.openai.profileId,
    });
    const first = recordingDeps();
    expect((await sweepInterestWatch(strict, first.deps)).fired).toBe(false);
    expect(first.emits).toHaveLength(0);

    const legacy = await mkWatch();
    await insertTurn('peer-legacy-current', 0.05, 25 * SEC, {
      mode: 'gemma',
      profile: null,
    });
    const second = recordingDeps();
    const result = await sweepInterestWatch(legacy, second.deps);
    expect(result.fired).toBe(true);
    const owners = (second.emits[0].payload as { matches: Array<{ owner: string }> }).matches.map((m) => m.owner);
    expect(owners).toContain('peer-legacy-current');
    expect(owners).not.toContain('peer-foreign-profile');
  });

  it('once:true deactivates after the first fire', async () => {
    const watch = await mkWatch({ once: true });
    await insertTurn('peer-once', 0.2, 30 * SEC);
    const { deps } = recordingDeps();
    const r = await sweepInterestWatch(watch, deps);
    expect(r.fired).toBe(true);
    expect(r.deactivated).toBe(true);
    expect((await reload(watch.id)).active).toBe(false);
  });

  it('a 5th consecutive sweep error deactivates the watch instead of erroring forever', async () => {
    // The deactivation path legitimately logs (the error-payload emit also
    // fails here, by design of this fixture) — assert the log fired instead of
    // letting vitest-fail-on-console treat it as an accident.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const watch = await mkWatch();
    await insertTurn('peer-err', 0.2, 30 * SEC);
    await rootSql`UPDATE harness_shared.interest_watches SET consecutive_errors = 4 WHERE id = ${watch.id}`;
    const deps: InterestSweepDeps = {
      getSql: () => rootSql,
      emit: async () => {
        throw new Error('emit transport down');
      },
      now: () => NOW,
    };
    const reread = { ...watch, consecutiveErrors: 4 };
    const r = await sweepInterestWatch(reread, deps);
    expect(r.error).toContain('emit transport down');
    expect(r.deactivated).toBe(true);
    const after = await reload(watch.id);
    expect(after.active).toBe(false);
    expect(after.last_error).toContain('emit transport down');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('claimDueInterestWatches', () => {
  it('claims never-swept rows once and respects the interval on the second claim', async () => {
    const a = await mkWatch();
    const b = await mkWatch();
    const claimed = await claimDueInterestWatches(rootSql, 50);
    const ids = claimed.map((c) => c.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    const again = await claimDueInterestWatches(rootSql, 50);
    expect(again.map((c) => c.id)).not.toContain(a.id);
    expect(again.map((c) => c.id)).not.toContain(b.id);
  });
});

describe('gcOrphanedInterestWatches', () => {
  it('deactivates a watch with NO live delivery target; live await / live subscription rows keep theirs', async () => {
    const orphan = await mkWatch();
    const awaited = await mkWatch();
    const subscribed = await mkWatch();
    const cancelled = await mkWatch();

    await rootSql`
      INSERT INTO harness_shared.event_awaits (workspace_id, event_key, once)
      VALUES ('coord-ws', ${awaited.eventKey}, true)`;
    await rootSql`
      INSERT INTO harness_shared.coord_entity_subscriptions (subscriber_id, target_kind, target_ref)
      VALUES (${ME}, 'event', ${subscribed.eventKey})`;
    await rootSql`
      INSERT INTO harness_shared.event_awaits (workspace_id, event_key, once, cancelled_at)
      VALUES ('coord-ws', ${cancelled.eventKey}, true, now())`;

    await gcOrphanedInterestWatches(rootSql, 'coord-ws');
    expect((await reload(orphan.id)).active).toBe(false);
    expect((await reload(awaited.id)).active).toBe(true);
    expect((await reload(subscribed.id)).active).toBe(true);
    expect((await reload(cancelled.id)).active).toBe(false);
  });
});

describe('workspace scope', () => {
  it("matches the watch's own workspace AND the 'default' operational corpus, nothing else", async () => {
    const watch = await mkWatch();
    await insertTurn('peer-ws-own', 0.1, 30 * SEC, { ws: WS });
    await insertTurn('peer-ws-other', 0.1, 29 * SEC, { ws: 'ws-somebody-else' });
    const { deps, emits } = recordingDeps();
    const r = await sweepInterestWatch(watch, deps);
    expect(r.fired).toBe(true);
    const owners = (emits[0].payload as { matches: Array<{ owner: string }> }).matches.map((m) => m.owner);
    expect(owners).toContain('peer-ws-own');
    expect(owners).not.toContain('peer-ws-other');
  });
});

describe('computeSweepWindow ↔ sweep agreement', () => {
  it('the sweep records exactly the window computeSweepWindow predicts', async () => {
    const watch = await mkWatch();
    const { deps } = recordingDeps();
    const predicted = computeSweepWindow({
      watermarkMs: new Date(watch.watermark).getTime(),
      blockerMinIngestedAtMs: null,
      claimNowMs: NOW.getTime(),
    });
    const r = await sweepInterestWatch(watch, deps);
    expect(r.window).toEqual(predicted);
  });
});
