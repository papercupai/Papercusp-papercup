// @vitest-environment node
/**
 * psu-launcher-fork.integration.test.ts — the `psu --resume --fork` identity
 * model, proven against a REAL, fully-migrated `harness_shared` schema
 * (P-015 baseline globalSetup → `inject('baselineSchemaDsn')`).
 *
 * WHY this exists (and what it adds over psu-launcher.test.ts's 10 fork UNIT
 * tests): the unit tests cover the pure launcher fns in isolation. What no
 * fake-sql test can prove is the end-to-end IDENTITY-ISOLATION guarantee the
 * fork rests on — that a tracked Claude fork mints a genuinely fresh, persisted
 * adv_sessions row (distinct coord identity + native id) that runs CONCURRENTLY
 * with the still-live original WITHOUT mutating it. This drives the real
 * launcher fork fns (`forkBootstrapBody`/`resumeArgsFor`/`resumeEnvFor`/
 * `nativeSessionIdFromLaunchArgs`) into the real adv-sessions store against real
 * PG, mirroring bootstrap-su's fork-mint seam (bootstrap-su.ts §821-900) — the
 * one seam that can't be spawned in CI (it would launch a real Claude + need
 * creds). It does NOT spawn Claude; it asserts the store-level contract that
 * "new id + new history, safe alongside the original" reduces to.
 *
 * Investigated + specced in the `psu-resume-ghost-sessions` insight
 * (## The fork identity model).
 */
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import postgres from 'postgres';
import {
  acquireBaselineSchemaMutex,
  releaseBaselineSchemaMutex,
} from '@papercusp/test-config/baseline-schema-mutex';
import { randomBytes, randomUUID } from 'node:crypto';

// Mock the org PG accessor so the real adv-sessions store writes to the baseline
// schema this test connects to. getOrgPg is read at CALL time, so h.sql (set in
// beforeAll) is live by the time any store fn runs. Same pattern as the other
// operator-core PG integration tests.
const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

// The REAL launcher fork fns (pure) — imported, not re-implemented, so the seam
// this test asserts is the one psu actually runs.
import {
  forkBootstrapBody,
  resumeArgsFor,
  resumeEnvFor,
  nativeSessionIdFromLaunchArgs,
} from '../scripts/psu-launcher.mjs';

// The REAL adv-sessions store (imported after the db-org mock is registered).
const { recordAdvSession, listResumableSessions, markAdvSessionEnded } =
  await import('@papercusp/operator-core/lib/adv-sessions');

// Every row this file writes is namespaced to a unique workspace so it never
// collides with (or reads) rows other integration files write to the shared
// baseline DB. Cleaned up in afterEach.
const WS = `fork-it-${randomBytes(6).toString('hex')}`;

// Namespacing our own rows by workspace is NOT sufficient isolation on its own:
// operator-core's adv-sessions integration files wipe this same shared table
// UNQUALIFIED (`TRUNCATE harness_shared.adv_sessions`) from a separate Vitest
// process against the same `.withReuse()`d container, which annihilates our
// workspace-scoped rows mid-test. Hold the shared baseline-schema mutex for the
// lifetime of this file so we are serialized against those writers.
let lockClient: postgres.Sql | undefined;

beforeAll(async () => {
  lockClient = await acquireBaselineSchemaMutex(inject('baselineSchemaDsn'), {
    label: 'psu-launcher-fork.integration.test.ts',
  });
  h.sql = postgres(inject('baselineSchemaDsn'), { max: 2, onnotice: () => {} });
});
afterEach(async () => {
  await h.sql`DELETE FROM harness_shared.adv_sessions WHERE workspace_id = ${WS}`;
});
afterAll(async () => {
  if (h.sql) await h.sql.end({ timeout: 5 });
  if (lockClient) await releaseBaselineSchemaMutex(lockClient);
});

/**
 * Record a tracked interactive Claude session as bootstrap-su would for a fresh
 * launch — a forkable ORIGINAL: a native id + coord owner id + cwd + plan.
 */
async function recordOriginal(over: { planSlug?: string | null; cwd?: string } = {}) {
  const coordOwnerId = `su-${randomUUID()}`;
  const nativeId = randomUUID();
  const id = await recordAdvSession({
    agent: 'claude',
    mode: 'console',
    workspaceId: WS,
    planSlug: over.planSlug ?? 'my-plan-2026-07-02',
    cwd: over.cwd ?? '/home/dev/papercupai-workspace/papercusp',
    coordOwnerId,
    sessionId: nativeId,
  });
  // adv_sessions.id is bigint → postgres-js returns it as a string; the store's
  // `number` type is nominal. We only ever compare / round-trip it, so the
  // runtime string is fine — just assert the insert succeeded.
  expect(id).not.toBeNull();
  return { id: id as number, coordOwnerId, nativeId };
}

/**
 * Mint a tracked fork of `original` the way bootstrap-su's fork path does
 * (bootstrap-su.ts §821-900): the launch fields come from the REAL
 * `forkBootstrapBody`; the server mints a FRESH coord owner id (§828) + a FRESH
 * forced native id (§837, Claude supports `--session-id`) and records the row.
 */
async function mintFork(original: { id: number; coordOwnerId: string; nativeId: string }) {
  const source = {
    agent: 'claude' as const,
    sessionId: original.nativeId,
    coordOwnerId: original.coordOwnerId,
    id: original.id,
    workspaceId: WS,
    cwd: '/home/dev/papercupai-workspace/papercusp',
    planSlug: 'my-plan-2026-07-02',
  };
  const forkSid = `su-${randomUUID()}`;
  const forkNativeId = randomUUID();
  const body = forkBootstrapBody(source, null, null, forkSid, {
    launchedBy: original.coordOwnerId,
    headless: true,
    sessionPortSourceAdvSessionId: original.id,
    sessionPortToken: 'inherited-port-token',
    sessionPortProtocol: 1,
  }); // REAL launcher fn, including the recorded fork provenance
  const forkRowId = await recordAdvSession({
    agent: body.agent,
    mode: 'console',
    workspaceId: body.workspace,
    planSlug: body.plan_slug,
    cwd: body.cwd,
    coordOwnerId: forkSid,
    sessionId: forkNativeId,
    launchArgv: body.launch_argv,
  });
  expect(forkRowId).not.toBeNull();
  return { id: forkRowId as number, sid: forkSid, nativeId: forkNativeId, body, source };
}

/**
 * Read a row back by id, isolated. (getAdvSession scopes to activeWorkspaceId(),
 * which isn't this file's namespaced WS — the real resume picker reads the
 * UNSCOPED listResumableSessions, which the enumeration test exercises directly.)
 */
async function readRow(id: number) {
  const rows = await h.sql<
    Array<{
      id: string;
      coord_owner_id: string | null;
      session_id: string | null;
      workspace_id: string;
      plan_slug: string | null;
      agent: string | null;
      cwd: string | null;
      ended_at: Date | null;
      launch_argv: string[] | null;
      port_id: string | null;
      port_source_adv_session_id: string | null;
    }>
  >`SELECT id, coord_owner_id, session_id, workspace_id, plan_slug, agent, cwd, ended_at,
           launch_argv, port_id, port_source_adv_session_id
      FROM harness_shared.adv_sessions WHERE id = ${id} LIMIT 1`;
  return rows[0] ?? null;
}

describe('psu --resume --fork — server-side fork identity model (real PG)', () => {
  it('forkBootstrapBody carries workspace + plan + cwd, drops harness scope, pins agent=claude', () => {
    const body = forkBootstrapBody({
      agent: 'claude',
      workspaceId: WS,
      planSlug: 'my-plan-2026-07-02',
      cwd: '/some/cwd',
      coordOwnerId: 'su-orig',
      sessionId: 'native-orig',
    });
    expect(body).toMatchObject({
      agent: 'claude', // tracked forks force a native id — only Claude supports that
      workspace: WS, // workspace scope is carried onto the fork
      plan_slug: 'my-plan-2026-07-02', // plan context is carried
      cwd: '/some/cwd', // fork runs in the ORIGINAL's cwd (seeded transcript is keyed by it)
      harness_slug: null, // harness scope is intentionally dropped (server must not relocate cwd)
    });
    // No `account` key unless an account is passed (byte-identical to a fresh launch).
    expect('account' in body).toBe(false);
  });

  it('a fork mints a FRESH adv row (distinct coord identity + native id); the original is untouched', async () => {
    const original = await recordOriginal();
    const fork = await mintFork(original);

    const forkRow = await readRow(fork.id);
    const origRow = await readRow(original.id);
    expect(forkRow).not.toBeNull();
    expect(origRow).not.toBeNull();

    // Distinct persisted identity — the guarantee that makes a fork safe to run
    // alongside the still-live original (no shared coord owner / native id / row).
    expect(String(forkRow!.id)).not.toBe(String(original.id));
    expect(forkRow!.coord_owner_id).toBe(fork.sid);
    expect(forkRow!.coord_owner_id).not.toBe(original.coordOwnerId);
    expect(forkRow!.session_id).toBe(fork.nativeId);
    expect(forkRow!.session_id).not.toBe(original.nativeId);

    // Context carried, live, and forkable (agent + cwd present → resumable).
    expect(forkRow!.workspace_id).toBe(WS);
    expect(forkRow!.plan_slug).toBe('my-plan-2026-07-02');
    expect(forkRow!.agent).toBe('claude');
    expect(forkRow!.ended_at).toBeNull();
    expect(forkRow!.launch_argv).toEqual(fork.body.launch_argv);
    expect(forkRow!.launch_argv).toEqual(expect.arrayContaining([
      `--resume=${original.nativeId}`, '--fork', '--headless',
      `--owner-id=${fork.sid}`, `--launched-by=${original.coordOwnerId}`,
    ]));
    expect(forkRow!.launch_argv!.filter((arg) => /^--resume(?:=|$)/.test(arg)))
      .toEqual([`--resume=${original.nativeId}`]);
    expect(forkRow!.launch_argv!.some((arg) => arg.startsWith('--session-port'))).toBe(false);
    expect(forkRow!.port_id).toBeNull();
    expect(forkRow!.port_source_adv_session_id).toBeNull();
    expect(fork.body).not.toHaveProperty('session_port_token');
    expect(fork.body).not.toHaveProperty('session_port_protocol');
    expect(fork.body).not.toHaveProperty('session_port_source_adv_session_id');

    // The original row is byte-for-byte its old self — forking mutates nothing on it.
    expect(origRow!.coord_owner_id).toBe(original.coordOwnerId);
    expect(origRow!.session_id).toBe(original.nativeId);
    expect(origRow!.ended_at).toBeNull();
  });

  it('N forks of ONE original yield N distinct identities (concurrency-safe)', async () => {
    const original = await recordOriginal();
    const forks = [await mintFork(original), await mintFork(original), await mintFork(original)];

    const ids = new Set(forks.map((f) => f.id));
    const sids = new Set(forks.map((f) => f.sid));
    const natives = new Set(forks.map((f) => f.nativeId));
    expect(ids.size).toBe(3);
    expect(sids.size).toBe(3);
    expect(natives.size).toBe(3);
    // None of the forks collide with the original either.
    expect(ids.has(original.id)).toBe(false);
    expect(sids.has(original.coordOwnerId)).toBe(false);
    expect(natives.has(original.nativeId)).toBe(false);
  });

  it('listResumableSessions surfaces BOTH the original and the fork', async () => {
    const original = await recordOriginal();
    const fork = await mintFork(original);

    const mine = (await listResumableSessions(2000)).filter((s) => s.workspaceId === WS);
    const ids = mine.map((s) => s.id);
    expect(ids).toContain(original.id);
    expect(ids).toContain(fork.id);
    // Both are resumable-shaped (agent + cwd present — the endpoint's filter).
    for (const s of mine) {
      expect(s.agent).toBe('claude');
      expect(s.cwd).toBeTruthy();
    }
  });

  it('ending the fork does NOT end the original (the branch is independent)', async () => {
    const original = await recordOriginal();
    const fork = await mintFork(original);

    await markAdvSessionEnded(fork.id, 0, 'self');

    expect((await readRow(fork.id))!.ended_at).not.toBeNull();
    // The original keeps running — a fork's exit stamps only the fork's own row.
    expect((await readRow(original.id))!.ended_at).toBeNull();
  });

  it('the fork argv names the FORK id as its own session, and its env takes a fresh, unlinked identity', () => {
    const original = { agent: 'claude', nativeId: randomUUID() };
    const forkNativeId = randomUUID();

    // resumeArgsFor(fork) branches the ORIGINAL into the FORCED fork id.
    const { args } = resumeArgsFor(
      { agent: 'claude', sessionId: original.nativeId },
      { fork: true, forkSessionId: forkNativeId },
    );
    expect(args).toEqual(
      expect.arrayContaining(['--resume', original.nativeId, '--fork-session', '--session-id', forkNativeId]),
    );

    // The identity-split guard: this argv IS the FORK's session, never the
    // original's — so a future untracked resume recovers the fork's identity,
    // not the branch point's (would poison the owner index otherwise).
    expect(nativeSessionIdFromLaunchArgs(args)).toBe(forkNativeId);
    expect(nativeSessionIdFromLaunchArgs(args)).not.toBe(original.nativeId);

    // The (untracked-fallback) fork env: a FRESH coord id and NO adv-row link —
    // so even the untracked fork can't collide with the live original on
    // presence / locks / inbox-wake.
    const env = resumeEnvFor(
      { agent: 'claude', coordOwnerId: 'su-original', id: 41, workspaceId: WS },
      { fork: true, mintSid: () => 'su-FRESH-FORK' },
    );
    expect(env.PAPERCUSP_SID).toBe('su-FRESH-FORK');
    expect(env.PAPERCUSP_SID).not.toBe('su-original');
    expect(env.PAPERCUSP_ADV_SESSION_ID).toBeUndefined();
  });
});
