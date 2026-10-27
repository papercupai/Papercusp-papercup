/**
 * external-app-access-to-workspaces-2026-09-29 P-015 — service keys for unattended apps.
 *
 *   R-10  a service key keeps authenticating after its creator is removed from the organization
 *   R-11  during a rotation's overlap window both the old and the new key authenticate
 *   R-12  after the overlap window ends the old key is refused
 *   R-13  creating a service key without a spending cap is refused
 *
 * Only the database handle is faked. It holds ONE connected_apps row the test controls, applies
 * the rotate UPDATE to it the way Postgres does (every right-hand side reads the pre-update row),
 * and models organization membership as a set: any query that is not about connected_apps and
 * mentions a membership/member table answers with a row only while the creator is a member.
 * Everything above it is real — the key parser and digest check, `appKeyVerdictOf`,
 * `rotateAppKey`, `createAppKey`, the `/api/agent-tools/*` catch-all with its scope enforcement,
 * and the "Connect an app" route.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  members: new Set<string>(),
  inserts: [] as unknown[][],
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const sql = Object.assign(
    async (strings: TemplateStringsArray | unknown, ...values: unknown[]) => {
      const text = Array.isArray(strings) ? strings.join('?') : '';
      if (/INSERT INTO harness_shared\.connected_apps/.test(text)) {
        db.inserts.push(values);
        // Positional VALUES of insertAppKey: id, user_email, workspace_id, kind, label, scopes,
        // limits, token_hash, expires_at, spend_cap_cents, spend_cap_window_sec.
        return [{
          id: values[0], user_email: values[1], workspace_id: values[2], kind: values[3], label: values[4],
          scopes: JSON.parse(String(values[5])), limits: JSON.parse(String(values[6])), paired_at: new Date(),
          expires_at: values[8], paused_at: null, revoked_at: null, last_seen: null, last_ip: null,
          spend_cap_cents: values[9], spend_cap_window_sec: values[10], rotated_at: null, previous_token_valid_until: null,
        }];
      }
      if (/UPDATE harness_shared\.connected_apps[\s\S]*previous_token_hash\s*=\s*token_hash/.test(text)) {
        if (!db.row || db.row.revoked_at) return [];
        // rotateAppKey's SET order: previous_token_valid_until, token_hash, rotated_at.
        db.row = {
          ...db.row,
          previous_token_hash: db.row.token_hash,
          previous_token_valid_until: values[0],
          token_hash: values[1],
          rotated_at: values[2],
        };
        return [db.row];
      }
      if (db.row && /SELECT[\s\S]*FROM harness_shared\.connected_apps/.test(text)) return [db.row];
      if (/member/i.test(text)) return db.members.size > 0 ? [{ status: 'active' }] : [];
      return [];
    },
    {
      unsafe: (fragment: string) => fragment,
      // Transaction-capable like the production org client (WI-40234).
      begin: async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(sql),
    },
  );
  return {
    ...(await importOriginal<typeof import('@papercusp/db-org')>()),
    getOrgPg: () => ({ sql }),
    withWorkspace: async (_ws: string, fn: (tx: unknown) => Promise<unknown>) => fn(sql),
  };
});

// Mutation-probe seams (copy-out tier): `scripts/mutation-probe.sh --test
// 'PAPERCUSP_<MODULE>_PROBE={} …'` points one module at a mutated COPY inside the probe's repo
// mirror, so its relative imports still resolve and proving R-10..R-13 falsifiable never mutates
// the shared tree. Unset (every normal run): the real module.
vi.mock('./store', async (importOriginal) => {
  const probe = process.env.PAPERCUSP_STORE_PROBE;
  return probe ? await import(/* @vite-ignore */ probe) : await importOriginal();
});
vi.mock('./service-keys', async (importOriginal) => {
  const probe = process.env.PAPERCUSP_SERVICE_KEYS_PROBE;
  return probe ? await import(/* @vite-ignore */ probe) : await importOriginal();
});
vi.mock('./principal', async (importOriginal) => {
  const probe = process.env.PAPERCUSP_PRINCIPAL_PROBE;
  return probe ? await import(/* @vite-ignore */ probe) : await importOriginal();
});

import { registerProjectedTool, _resetProjectionRegistryForTests, type ProjectedTool } from '@papercusp/agent-mcp';
import catchall from '../endpoint-route/routes/agent-tools/catchall';
import type { RouteContext } from '../endpoint-route/define-route';
import { createConnectedAppRoutes } from '../endpoint-route/routes/connected-apps';
import type { DeviceGrantStore } from './device-grants';
import { mintAppKey } from './key';
import { resolveAppKeyToken } from './principal';
import { appKeyVerdictOf, createAppKey, createServiceKey, resolveAppKeyScopes, rotateAppKey, type StoredAppKeyRow } from './store';
import { DEFAULT_SPEND_CAP_WINDOW_SEC, SpendCapError, resolveSpendCap } from './service-keys';
import { setKernelEnforcementResolver } from '../projected-tool-deps';
// lib/events/index.ts installs the DB-backed control-anchor kernel resolver at import time.
// This fixture mocks @papercusp/db-org, so that control-anchor read rejects and every call is
// denied policy-unavailable. Uninstall it: app-key scope + structural kernel checks stay real.
beforeEach(() => { setKernelEnforcementResolver(null); });

const CTX: RouteContext = { principal: null, input: undefined, params: {}, log: () => {}, signal: new AbortController().signal };
const postRoute = catchall.find((d) => d.method === 'POST');
if (!postRoute) throw new Error('agent-tools catchall has no POST route');

const CREATOR = 'creator@example.com';
const WS = 'ws-svc';

function whoamiTool(): ProjectedTool {
  return {
    pluginName: 'agent-mcp',
    description: 'echoes the resolved principal',
    inputSchema: { type: 'object' },
    capabilities: [],
    public: true,
    expose: { http: { path: '/api/agent-tools/fix/svc-whoami', methods: ['POST'] }, mcp: { name: 'fix:svc-whoami' } },
    fn: async (_input, ctx) => ({
      content: [{ type: 'text', text: JSON.stringify({ slug: ctx.principal?.slug ?? null, workspace: ctx.principal?.workspaceId ?? null }) }],
    }),
  };
}

/** The principal the catch-all resolved for this bearer; nulls when the key was refused. */
async function whoami(bearer: string): Promise<{ slug: string | null; workspace: string | null }> {
  const res = await postRoute!.handler(
    new Request('http://x.test/api/agent-tools/fix/svc-whoami', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: '{}',
    }),
    CTX,
  );
  if (res.status !== 200) return { slug: null, workspace: null };
  const body = (await res.json()) as { content: Array<{ text: string }> };
  return JSON.parse(body.content[0].text);
}

function serviceRow(tokenHash: string, id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, user_email: CREATOR, workspace_id: WS, kind: 'service', label: 'nightly sync',
    scopes: { capabilities: [], tools: ['fix:svc-whoami'] }, limits: {},
    paired_at: new Date('2026-09-29T00:00:00Z'), expires_at: null, paused_at: null, revoked_at: null,
    last_seen: null, last_ip: null, spend_cap_cents: 5000, spend_cap_window_sec: DEFAULT_SPEND_CAP_WINDOW_SEC,
    rotated_at: null, previous_token_valid_until: null, token_hash: tokenHash, previous_token_hash: null,
    remote_access_enabled: true,
    ...over,
  };
}

let minted: ReturnType<typeof mintAppKey>;

beforeEach(() => {
  _resetProjectionRegistryForTests();
  registerProjectedTool(whoamiTool());
  minted = mintAppKey();
  db.row = serviceRow(minted.tokenHash, minted.id);
  db.members = new Set([CREATOR]);
  db.inserts = [];
});

describe('R-10 — a service key outlives its creator\'s membership', () => {
  it('keeps authenticating after its creator is removed from the organization', async () => {
    const expected = { slug: `app:${minted.id}`, workspace: WS };
    expect(await whoami(minted.key)).toEqual(expected);
    db.members.delete(CREATOR); // the creator leaves the organization
    expect(db.members.size).toBe(0);
    expect(await whoami(minted.key)).toEqual(expected);
  });

  it('resolves to a principal that names the key and never its creator', async () => {
    db.members.clear();
    const resolved = await resolveAppKeyToken(minted.key);
    expect(resolved?.ok).toBe(true);
    if (!resolved?.ok) return;
    expect(resolved.principal).toMatchObject({ kind: 'service', slug: `app:${minted.id}`, workspaceId: WS, label: 'nightly sync' });
    expect(JSON.stringify({ ...resolved.principal, capabilities: [...resolved.principal.capabilities] })).not.toContain(CREATOR);
  });
});

describe('R-11 — rotation has no downtime', () => {
  it('both the old and the new key authenticate during the overlap window', async () => {
    const oldKey = minted.key;
    const rotated = await rotateAppKey(WS, minted.id, { overlapSec: 3600 });
    expect(rotated).not.toBeNull();
    expect(rotated!.key).not.toBe(oldKey);
    expect(rotated!.key.startsWith(`pcapp_${minted.id}_`)).toBe(true); // same id: scopes, cap and audit identity carry over
    const expected = { slug: `app:${minted.id}`, workspace: WS };
    expect(await whoami(oldKey)).toEqual(expected);
    expect(await whoami(rotated!.key)).toEqual(expected);
  });

  it('reports the old key as the previous secret while the window is open', () => {
    const now = new Date('2026-09-30T12:00:00Z');
    const row = serviceRow('0'.repeat(64), minted.id, {
      token_hash: 'f'.repeat(64),
      previous_token_hash: minted.tokenHash,
      previous_token_valid_until: new Date(now.getTime() + 1000),
    }) as unknown as StoredAppKeyRow;
    expect(appKeyVerdictOf(row, minted.key, now)).toMatchObject({ ok: true, viaPreviousKey: true });
  });
});

describe('R-12 — a rotated-out key dies after the window', () => {
  it('refuses the old key once the overlap window has ended, while the new key keeps working', async () => {
    const oldKey = minted.key;
    // Rotated two minutes ago with a one-minute overlap: the window closed a minute ago.
    const rotated = await rotateAppKey(WS, minted.id, { overlapSec: 60, now: new Date(Date.now() - 120_000) });
    expect(await whoami(oldKey)).toEqual({ slug: null, workspace: null });
    expect(await whoami(rotated!.key)).toEqual({ slug: `app:${minted.id}`, workspace: WS });
  });

  it('refuses the old key at the deadline itself, and at once for a zero overlap', async () => {
    const at = new Date('2026-09-30T12:00:00Z');
    const row = serviceRow('f'.repeat(64), minted.id, { previous_token_hash: minted.tokenHash, previous_token_valid_until: at }) as unknown as StoredAppKeyRow;
    expect(appKeyVerdictOf(row, minted.key, at)).toEqual({ ok: false, reason: 'rotated' });
    const oldKey = minted.key;
    await rotateAppKey(WS, minted.id, { overlapSec: 0 });
    expect(await whoami(oldKey)).toEqual({ slug: null, workspace: null });
  });
});

describe('R-13 — a service key needs a spending cap', () => {
  it('createServiceKey without a cap is refused before anything is written', async () => {
    await expect(
      createServiceKey({ workspaceId: WS, userEmail: CREATOR, label: 'uncapped', spendCapCents: undefined as unknown as number }),
    ).rejects.toBeInstanceOf(SpendCapError);
    await expect(createAppKey({ workspaceId: WS, userEmail: CREATOR, label: 'uncapped', kind: 'service', spendCapCents: null })).rejects.toBeInstanceOf(SpendCapError);
    expect(db.inserts).toHaveLength(0);
  });

  it('a capped service key is created with its cap, and a plain app key still needs none', async () => {
    const created = await createServiceKey({ workspaceId: WS, userEmail: CREATOR, label: 'capped', spendCapCents: 2500 });
    expect(created.app).toMatchObject({ kind: 'service', spend_cap_cents: 2500, spend_cap_window_sec: DEFAULT_SPEND_CAP_WINDOW_SEC, expires_at: null });
    const zeroCapped = await createServiceKey({ workspaceId: WS, userEmail: CREATOR, label: 'read-only', spendCapCents: 0 });
    expect(zeroCapped.app).toMatchObject({ kind: 'service', spend_cap_cents: 0, spend_cap_window_sec: DEFAULT_SPEND_CAP_WINDOW_SEC });
    expect(resolveSpendCap('app', {})).toEqual({ spendCapCents: null, spendCapWindowSec: null });
    expect(resolveSpendCap('service', { spendCapCents: 0 })).toEqual({ spendCapCents: 0, spendCapWindowSec: DEFAULT_SPEND_CAP_WINDOW_SEC });
  });

  it('the Connect-an-app route refuses a service key without a cap', async () => {
    const [connectApp] = createConnectedAppRoutes({
      grants: {} as DeviceGrantStore,
      createKey: createAppKey,
      rotateKey: rotateAppKey,
      resolveScopes: (req) => resolveAppKeyScopes({ ...req, knownTools: new Map() }),
      workspaceExists: (id) => id === WS,
      listWorkspaces: () => [{ id: WS, name: 'Service' }],
      // Locality is P-004/P-005's concern (routes/connected-apps/index.test.ts); here the caller is
      // simply at the machine, so the only thing that can refuse the request is the missing cap.
      isLocal: () => true,
    });
    const res = await connectApp!.handler(
      new Request('http://127.0.0.1:3070/api/connected-apps', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'cron', workspaceId: WS, kind: 'service' }),
      }),
      CTX,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_spend_cap');
    expect(db.inserts).toHaveLength(0);
  });
});
