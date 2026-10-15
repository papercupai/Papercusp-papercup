/**
 * provisioning.integration.test.ts — plan harness-test-coverage-for-launch P-023.
 *
 * Exercises the REAL `provisionSystemPrincipal` / `startPiSession` /
 * `endPiSession` (packages/agent-mcp/src/provisioning.ts) — which write the auth
 * source-of-truth (`harness_shared.system_principals` / `token_index` /
 * `pi_sessions`) through `withWorkspace` (harness_app role, RLS-subject) — against
 * a real migrated Postgres via the `createOrgTestDb` fixture. Until now these
 * security-critical writes had ZERO coverage.
 *
 * First test to use the db-org test seam (createOrgTestDb). NOTE its caveat: the
 * fixture applies only the self-contained migration PREFIX, so token_index still
 * has the pre-091 GLOBAL UNIQUE(harness_slug). We therefore give each case a
 * globally-distinct principal name so the test exercises provisioning LOGIC
 * without tripping the (soon-to-be-workspace-scoped) constraint.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createOrgTestDb, type OrgTestDb } from './_org-test-db';

// Mock only withWorkspace (provisioning's sole db-org import), reproducing its
// real behavior — a harness_app txn with the workspace GUC set so RLS applies —
// against the fixture's appSql. This is the repo's established pattern (the real
// getOrgPgApp can't build Drizzle under vitest; see _org-test-db.ts). The holder
// is populated in beforeAll; vi.hoisted keeps it visible to the hoisted factory.
const H = vi.hoisted(() => ({ appSql: null as null | { begin: (cb: (tx: unknown) => unknown) => Promise<unknown> } }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  withWorkspace: async (ws: string, cb: (tx: unknown) => unknown) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (H.appSql as any).begin(async (tx: any) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      return cb(tx);
    }),
}));

// eslint-disable-next-line import/no-relative-packages -- exercise the REAL provisioning code
import {
  provisionSystemPrincipal,
  startPiSession,
  endPiSession,
} from '../../../packages/agent-mcp/src/provisioning';

const hash = (b: string) => createHash('sha256').update(b).digest('hex');
const ROOT = '/tmp/papercusp-test';

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  H.appSql = db.appSql as any;
}, 90_000);

afterAll(async () => {
  if (db) await db.cleanup();
});

describe('provisionSystemPrincipal', () => {
  it('writes system_principals + token_index with the bearer hash (secret never stored)', async () => {
    const ws = 'ws-create';
    const name = 'op-create';
    const r = await provisionSystemPrincipal({ workspaceId: ws, name, capabilities: ['*'], papercuspRoot: ROOT });
    expect(r).not.toBeNull();
    expect(r!.rotated).toBe(false);
    expect(r!.bearer).toBeTruthy();
    if (!r?.bearer) throw new Error('initial provision must return a fresh bearer');

    const sp = await db.adminSql`
      SELECT bearer_hash FROM harness_shared.system_principals
       WHERE workspace_id = ${ws} AND name = ${name}`;
    expect(sp).toHaveLength(1);
    expect(sp[0].bearer_hash).toBe(hash(r!.bearer));
    expect(sp[0].bearer_hash).not.toBe(r!.bearer);

    const ti = await db.adminSql`
      SELECT token FROM harness_shared.token_index
       WHERE workspace_id = ${ws} AND harness_slug = ${`system:${name}`}`;
    expect(ti).toHaveLength(1);
    expect(ti[0].token).toBe(r!.bearer);
  });

  it('is idempotent without force — a re-run skips (returns null) and leaves the token unchanged', async () => {
    const ws = 'ws-idem';
    const name = 'op-idem';
    const first = await provisionSystemPrincipal({ workspaceId: ws, name, capabilities: ['*'], papercuspRoot: ROOT });
    const second = await provisionSystemPrincipal({ workspaceId: ws, name, capabilities: ['*'], papercuspRoot: ROOT });
    expect(second).toBeNull();

    const ti = await db.adminSql`
      SELECT token FROM harness_shared.token_index
       WHERE workspace_id = ${ws} AND harness_slug = ${`system:${name}`}`;
    expect(ti).toHaveLength(1);
    expect(ti[0].token).toBe(first!.bearer);
  });

  it('force-rotates: new bearer, updated hash, and the OLD token_index row is replaced (revoked)', async () => {
    const ws = 'ws-rotate';
    const name = 'op-rotate';
    const first = await provisionSystemPrincipal({ workspaceId: ws, name, capabilities: ['*'], papercuspRoot: ROOT });
    const rotated = await provisionSystemPrincipal({ workspaceId: ws, name, capabilities: ['*'], papercuspRoot: ROOT, force: true });

    expect(rotated).not.toBeNull();
    expect(rotated!.rotated).toBe(true);
    expect(rotated!.bearer).not.toBe(first!.bearer);
    if (!rotated?.bearer) throw new Error('rotation must return a fresh bearer');

    const sp = await db.adminSql`
      SELECT bearer_hash FROM harness_shared.system_principals
       WHERE workspace_id = ${ws} AND name = ${name}`;
    expect(sp[0].bearer_hash).toBe(hash(rotated!.bearer));

    // token_index holds ONLY the new bearer — the old one is gone, so a stale
    // bearer can no longer resolve (the rotation's whole point).
    const ti = await db.adminSql`
      SELECT token FROM harness_shared.token_index
       WHERE workspace_id = ${ws} AND harness_slug = ${`system:${name}`}`;
    expect(ti).toHaveLength(1);
    expect(ti[0].token).toBe(rotated!.bearer);
    expect(ti.map((r) => r.token)).not.toContain(first!.bearer);
  });
});

describe('pi session lifecycle', () => {
  it('startPiSession writes a live session + token; endPiSession sets ended_at and revokes the token', async () => {
    const ws = 'ws-pi';
    const sessionId = 'sess-pi-1';
    const s = await startPiSession({ workspaceId: ws, sessionId, capabilities: ['harness:read'], allowedTools: ['harness:get'] });
    expect(s.bearer).toBeTruthy();

    const live = await db.adminSql`
      SELECT bearer_hash, ended_at FROM harness_shared.pi_sessions
       WHERE workspace_id = ${ws} AND session_id = ${sessionId}`;
    expect(live).toHaveLength(1);
    expect(live[0].bearer_hash).toBe(hash(s.bearer));
    expect(live[0].ended_at).toBeNull();
    const tiBefore = await db.adminSql`
      SELECT token FROM harness_shared.token_index
       WHERE workspace_id = ${ws} AND harness_slug = ${`pi:${sessionId}`}`;
    expect(tiBefore).toHaveLength(1);

    await endPiSession(ws, sessionId);

    const ended = await db.adminSql`
      SELECT ended_at FROM harness_shared.pi_sessions
       WHERE workspace_id = ${ws} AND session_id = ${sessionId}`;
    expect(ended[0].ended_at).not.toBeNull();
    // Token revoked — the row is physically gone from the index (auth.ts ALSO
    // guards on ended_at, but here the bearer simply no longer resolves).
    const tiAfter = await db.adminSql`
      SELECT token FROM harness_shared.token_index
       WHERE workspace_id = ${ws} AND harness_slug = ${`pi:${sessionId}`}`;
    expect(tiAfter).toHaveLength(0);
  });
});
