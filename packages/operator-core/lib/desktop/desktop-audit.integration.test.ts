/**
 * desktop-audit.integration.test.ts — `recordDesktopAudit`'s REAL Postgres write,
 * against a fully-migrated throwaway database
 * (agent-virtual-desktops-2026-08-23, A-bar clause 5).
 *
 * ## Why this file exists
 *
 * Clause 5 of the plan's ship bar is "local desktop watch/takeover works from the
 * operator UI **with an audit_log row**". Everything that claimed to cover the
 * audit half of that was satisfied by an INJECTED writer:
 *
 *   - `frame-vnc.test.ts` injects `audit` and asserts the event object;
 *   - `hosted-desktop-channel.test.ts` asserts `grant.auditAction` — a field on the
 *     grant OBJECT, before any writer is reached;
 *   - `hosted-desktop-backend.test.ts` / `hosted-session-host.test.ts` collect
 *     actions into an in-memory array.
 *
 * So `recordDesktopAudit`'s DEFAULT branch — `activeWorkspaceId()` →
 * `withWorkspace()` → a drizzle insert into `harness_shared.audit_log` — was
 * exercised by nothing. That branch is the whole feature: an auditor asking "who
 * took over a desktop" reads the TABLE, not a mock. And it is the worst possible
 * shape to leave unasserted, because the writer is deliberately fire-and-forget
 * (`void (async () => …)` with a catch that only calls `onError`), so a broken
 * insert produces no exception, no failed request, and no red test — it produces
 * a quiet week that looks exactly like a week in which nobody took over a desktop.
 * Measured on the dev box 2026-08-30: `audit_log` held zero `frame-vnc%` rows ever,
 * beside 3.6k+ rows under other actions.
 *
 * ## What is still injected, and why that is not the same hole again
 *
 * Only `workspaceId` and `now`. `workspaceId` replaces `activeWorkspaceId()`, a
 * process-global registry read that has nothing to do with the write; `now` makes
 * the `ts` assertion exact. `write` is deliberately LEFT UNDEFINED in every test
 * here — that is the point — so the drizzle insert, the jsonb binding and the
 * table's own constraints are all real.
 *
 * ## The negative controls
 *
 * Two, because the failures they catch are at different depths and a single one
 * would silently pass for the wrong reason. (a) an empty workspace is refused
 * UPSTREAM by `withWorkspace` itself, before any SQL is sent. (b) a null `actor`
 * violates `audit_log_actor_not_null`, which only Postgres can raise and only
 * after the statement is on the wire — so (b) is what proves the `catch` wraps
 * the AWAIT rather than just the setup. Without (b), a writer that let its insert
 * reject unhandled (a process-level crash, not a warning) would still be green.
 * Both are preceded by a POSITIVE control on the same probe, so "no row" can
 * never be satisfied by a probe that cannot see rows at all.
 *
 * Run: npm run test:file -- packages/operator-core/lib/desktop/desktop-audit.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createOrgTestDb } from '../../test/_org-test-db';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache getOrgPg() memoizes (not re-exported from the index) — same idiom as read-cursors.integration.test.ts
import { _resetUrlCacheForTests } from '../../../../libs/papercusp/libs/db/src/connection';
import {
  recordDesktopAudit,
  desktopAuditAction,
  desktopAuditSubject,
  DESKTOP_AUDIT_ACTION_PREFIX,
  hostedDesktopAuditRow,
} from './desktop-audit';

let db: OrgTestDb;
let prevAppUrl: string | undefined;
let prevAdminUrl: string | undefined;
let prevPgb: string | undefined;
let prevSkipDisc: string | undefined;

/** A fresh workspace per assertion, so one test's rows can never satisfy another's. */
const ws = () => `ds_audit_${randomBytes(4).toString('hex')}`;

/**
 * The writer is fire-and-forget, so there is no promise to await. Poll for the row
 * rather than sleeping a fixed amount: a fixed sleep either flakes under load or
 * pads every green run. Bounded, so a write that never lands FAILS instead of hanging.
 */
async function waitForRows(
  workspaceId: string,
  expected: number,
  timeoutMs = 20_000,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await db.adminSql<Array<Record<string, unknown>>>`
      SELECT id, ts, actor, action, subject, details, workspace_id
        FROM harness_shared.audit_log
       WHERE workspace_id = ${workspaceId}
       ORDER BY ts ASC, id ASC`;
    if (rows.length >= expected) return rows;
    if (Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Flatten an Error's `cause` chain to text — postgres.js's reason (the constraint
 *  name and the `null value in column …` detail) is nested under drizzle's own
 *  "Failed query" wrapper, so asserting on `.message` alone reads only the wrapper. */
function errorChainText(err: unknown, depth = 6): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < depth && cur; i++) {
    const e = cur as { message?: unknown; detail?: unknown; constraint_name?: unknown; cause?: unknown };
    parts.push(String(e.message ?? cur), String(e.detail ?? ''), String(e.constraint_name ?? ''));
    cur = e.cause;
  }
  return parts.join(' | ');
}

/** Bounded wait on an in-process condition — the fire-and-forget writer reports
 *  failures through `onError` on its own microtask, with no promise to await. */
async function waitFor(cond: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
}

beforeAll(async () => {
  db = await createOrgTestDb();
  prevAppUrl = process.env.HARNESS_DATABASE_URL;
  prevAdminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
  prevPgb = process.env.PAPERCUSP_PGBOUNCER;
  prevSkipDisc = process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
  process.env.PAPERCUSP_PGBOUNCER = '0';
  process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
  process.env.HARNESS_DATABASE_URL = db.appDsn;
  process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
  _resetUrlCacheForTests();
}, 180_000);

afterAll(async () => {
  process.env.HARNESS_DATABASE_URL = prevAppUrl;
  process.env.HARNESS_ADMIN_DATABASE_URL = prevAdminUrl;
  if (prevPgb === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
  else process.env.PAPERCUSP_PGBOUNCER = prevPgb;
  if (prevSkipDisc === undefined) delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
  else process.env.PAPERCUSP_SKIP_PG_DISCOVERY = prevSkipDisc;
  _resetUrlCacheForTests();
  await db?.cleanup();
});

describe('recordDesktopAudit — the default (uninjected) Postgres write path', () => {
  it('censuses hosted adapter detail persistence and database failure warnings with distinct content markers', async () => {
    const workspaceId = ws();
    const marker = 'customer-content-' + randomBytes(8).toString('hex');
    const ignored = 'customer-unmapped-' + randomBytes(8).toString('hex');
    const event = hostedDesktopAuditRow({
      action: 'desktop_watch_started', organizationId: 'org-a', customerWorkspaceId: 'customer-a',
      hostId: 'host-a', generation: 3, userId: 'user-a', channelId: 'channel-a', detail: marker,
      ...{ customerPayload: ignored },
    });
    const errors: unknown[] = [];
    recordDesktopAudit(event, { workspaceId: () => workspaceId, onError: (error) => errors.push(error) });
    const rows = await waitForRows(workspaceId, 1);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({ target: 'hosted', detail: marker });
    expect(JSON.stringify(rows)).not.toContain(ignored);

    // Customer tenant B cannot see tenant A's real audit row.
    const { withWorkspace } = await import('@papercusp/db-org');
    const foreign = await withWorkspace(ws(), (tx) => tx<Array<{ id: string }>>`
      SELECT id FROM harness_shared.audit_log WHERE id = ${String(rows[0]!.id)}`);
    expect(foreign).toEqual([]);

    // Exercise the default console sink after an actual database rejection.
    // Drizzle's error object may hold binding values even when its message does not.
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      recordDesktopAudit({ ...event, actor: null as unknown as string }, { workspaceId: () => ws() });
      await waitFor(() => warning.mock.calls.length > 0);
      expect(warning).toHaveBeenCalledTimes(1);
      const [prefix, code] = warning.mock.calls[0]!;
      expect(prefix).toBe('[desktop-audit] write failed:');
      expect(code).toBe('desktop_audit_write_failed');
      expect(JSON.stringify(warning.mock.calls)).not.toContain(marker);
      expect(JSON.stringify(warning.mock.calls)).not.toContain('insert into');
    } finally {
      warning.mockRestore();
    }
  }, 60_000);

  it('lands a real audit_log row for a LOCAL desktop takeover, with details as a jsonb OBJECT', async () => {
    const workspaceId = ws();
    const at = 1_788_000_000_000;
    const errors: unknown[] = [];

    recordDesktopAudit(
      {
        action: desktopAuditAction('takeover', 'started'),
        actor: 'user:default',
        subject: desktopAuditSubject('local', 'abar-proof', 110),
        details: { slug: 'abar-proof', display: 110, mode: 'takeover', target: 'local', desktopSessionId: 'ds-1' },
      },
      // `write` is deliberately absent — the real drizzle insert is what is under test.
      { workspaceId: () => workspaceId, now: () => at, idPrefix: 'vnc', onError: (e) => errors.push(e) },
    );

    const rows = await waitForRows(workspaceId, 1);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe('frame-vnc.takeover-started');
    expect(row.actor).toBe('user:default');
    expect(row.subject).toBe('local:abar-proof:110');
    expect(row.workspace_id).toBe(workspaceId);
    expect(Number(row.ts)).toBe(at);
    expect(String(row.id).startsWith('vnc-')).toBe(true);

    // A jsonb OBJECT, not a double-encoded string scalar — the classic binding bug
    // that a mocked writer cannot see, because the mock is handed the object.
    expect(row.details).toEqual({
      slug: 'abar-proof',
      display: 110,
      mode: 'takeover',
      target: 'local',
      desktopSessionId: 'ds-1',
    });
    const [{ t }] = await db.adminSql<Array<{ t: string }>>`
      SELECT jsonb_typeof(details) AS t FROM harness_shared.audit_log WHERE workspace_id = ${workspaceId}`;
    expect(t).toBe('object');
  }, 60_000);

  it('keeps every viewer lane in ONE queryable population: frame, local and hosted rows all match the shared action prefix', async () => {
    const workspaceId = ws();
    const errors: unknown[] = [];
    const deps = (n: number, idPrefix: string) => ({
      workspaceId: () => workspaceId,
      now: () => 1_788_000_100_000 + n,
      idPrefix,
      onError: (e: unknown) => errors.push(e),
    });

    // The frame lane keeps its historical UNPREFIXED subject; the other two are
    // lane-prefixed. desktop-audit.ts calls that asymmetry load-bearing (renaming
    // it would orphan existing rows), so pin it against the real column.
    recordDesktopAudit(
      { action: desktopAuditAction('watch', 'started'), actor: 'user:a', subject: desktopAuditSubject('frame', 'h1', 99), details: { target: 'frame' } },
      deps(0, 'vnc'),
    );
    recordDesktopAudit(
      { action: desktopAuditAction('takeover', 'started'), actor: 'user:a', subject: desktopAuditSubject('local', 'h1', 99), details: { target: 'local' } },
      deps(1, 'vnc'),
    );
    recordDesktopAudit(
      { action: desktopAuditAction('watch', 'denied'), actor: 'user:a', subject: desktopAuditSubject('hosted', 'h1', 99), details: { target: 'hosted' } },
      deps(2, 'hosted'),
    );

    const rows = await waitForRows(workspaceId, 3);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.subject)).toEqual(['h1:99', 'local:h1:99', 'hosted:h1:99']);

    // The whole point of the shared prefix: ONE filter answers "who viewed a
    // desktop", across every lane. A per-lane namespace would answer for a subset
    // and look identical to a quiet week.
    const [{ n }] = await db.adminSql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.audit_log
       WHERE workspace_id = ${workspaceId} AND action LIKE ${`${DESKTOP_AUDIT_ACTION_PREFIX}.%`}`;
    expect(n).toBe(3);
    // …and the lane stays filterable without parsing the subject string.
    const [{ locals }] = await db.adminSql<Array<{ locals: number }>>`
      SELECT count(*)::int AS locals FROM harness_shared.audit_log
       WHERE workspace_id = ${workspaceId} AND details->>'target' = 'local'`;
    expect(locals).toBe(1);
  }, 60_000);

  it('NEGATIVE CONTROL — a write the database refuses is routed to onError, never thrown, and leaves no row', async () => {
    const good = ws();
    const errors: unknown[] = [];
    const event = {
      action: desktopAuditAction('takeover', 'started'),
      actor: 'user:default',
      subject: desktopAuditSubject('local', 'abar-proof', 110),
      details: { target: 'local' },
    };

    // POSITIVE CONTROL FIRST: the same call, same probe, a valid workspace. Without
    // this, "no row" below would be equally consistent with a broken probe.
    expect(() =>
      recordDesktopAudit(event, { workspaceId: () => good, now: () => 1_788_000_200_000, onError: (e) => errors.push(e) }),
    ).not.toThrow();
    expect(await waitForRows(good, 1)).toHaveLength(1);
    expect(errors).toEqual([]);

    // REFUSAL (a) — BEFORE the database. `withWorkspace` rejects an empty tenant
    // itself, so this never reaches `audit_log`'s CHECK (workspace_id <> '').
    // Worth pinning separately from (b): it proves the guard is upstream, which is
    // why (b) has to exist at all to reach the insert.
    expect(() =>
      recordDesktopAudit(event, { workspaceId: () => '', now: () => 1_788_000_300_000, onError: (e) => errors.push(e) }),
    ).not.toThrow();
    await waitFor(() => errors.length === 1);
    expect(String((errors[0] as Error)?.message ?? errors[0])).toMatch(/workspaceId is empty/i);

    const [{ n }] = await db.adminSql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.audit_log WHERE workspace_id = ''`;
    expect(n).toBe(0);

    // REFUSAL (b) — INSIDE the awaited insert. A null actor violates
    // audit_log_actor_not_null, which only Postgres can raise, and only after the
    // statement is sent. This is the case that proves the try/catch wraps the
    // AWAIT and not merely the setup: a catch around the setup alone would leave
    // this an unhandled rejection, which is a process-level crash, not a warning.
    const dbSide = ws();
    expect(() =>
      recordDesktopAudit(
        { ...event, actor: null as unknown as string },
        { workspaceId: () => dbSide, now: () => 1_788_000_400_000, onError: (e) => errors.push(e) },
      ),
    ).not.toThrow();
    await waitFor(() => errors.length === 2);
    // The driver's own message names the failed statement — that is the evidence
    // this reached the insert. Postgres' reason rides in the cause chain, so read
    // both: matching only the outer text would also pass for a query that failed
    // for some entirely different reason.
    expect(String((errors[1] as Error)?.message ?? errors[1])).toMatch(/failed query: insert into/i);
    expect(errorChainText(errors[1])).toMatch(/not-null|null value in column/i);

    const [{ m }] = await db.adminSql<Array<{ m: number }>>`
      SELECT count(*)::int AS m FROM harness_shared.audit_log WHERE workspace_id = ${dbSide}`;
    expect(m).toBe(0);
  }, 60_000);
});
