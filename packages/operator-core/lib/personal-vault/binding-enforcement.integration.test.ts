/**
 * BAR R-11 — the label binds native tools (plan
 * personal-data-reader-set-labels-2026-10-01, P-007).
 *
 * Condition: a restricted session reaches a mail, chat, calendar or social
 * provider only through the gated verbs — provider credentials are absent from
 * its environment and its direct egress to provider hosts is refused — while an
 * unrestricted session is unchanged.
 *
 * Measured on a migrated throwaway database, through the production seams:
 *   - environment: the wake-launch seam (`sanitizeInheritedWakeEnv`) and the
 *     shared scrub (`scrubProviderCredentials`) drop every provider credential
 *     and keep every other variable byte-for-byte;
 *   - egress: `checkRestrictedEgress` with its default deps reads the real
 *     disclosure ledger through getOrgPg; the loopback route the PreToolUse hook
 *     calls returns the same verdicts; capability:bash refuses a restricted
 *     session's provider-bound command before anything runs.
 *   - network layer (WI-10005589, D-012): the route reports the session's
 *     restriction status; capability:bash runs a restricted session's command in
 *     an empty network namespace, so even a host assembled at run time is
 *     unreachable. The client-native Bash half (the PreToolUse rewrite) is proven
 *     with real bwrap in apps/operator/scripts/hooks/cc/__tests__/restricted-egress-guard.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const holder = vi.hoisted(() => ({ sql: null as postgres.Sql | null, ownerId: '', integrationRoot: '' }));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: holder.sql }),
}));

// capability:bash attributes the caller through resolveAgentIdentity; pin it to
// the session under test so the ledger lookup is the only variable.
vi.mock('../agent-tools/coordination/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-tools/coordination/identity')>()),
  resolveAgentIdentity: () => ({ ownerId: holder.ownerId }),
}));

// The source-hold gate must inspect this fixture's real Git tree. Pairing the
// fixture's disclosure ledger with a peer-edited staging tree invents holds.
vi.mock('../agent-tools/capability/base-dir', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-tools/capability/base-dir')>()),
  resolveCapabilityIntegrationRoot: () => holder.integrationRoot,
}));

const { createOrgTestDb } = await import('../../test/_org-test-db');
const { checkRestrictedEgress, readSessionRestriction, isAgentRuntimePath, EGRESS_REFUSAL_CODE } = await import(
  './binding-enforcement'
);
const { default: writeTool } = await import('../agent-tools/capability/write');
const { default: editTool } = await import('../agent-tools/capability/edit');
const { capabilityBwrapWorks } = await import('../agent-tools/capability/exec-sandbox');
const { readRestrictedSourceHoldState } = await import('./git-sync-hold');
const { scrubProviderCredentials, findProviderEgressTargets, providerEgressRules } = await import('./provider-egress.mjs');
const { sanitizeInheritedWakeEnv } = await import('../inference-gateway/spawn-env');
const { default: bashTool } = await import('../agent-tools/capability/bash');
const { default: egressRoutes } = await import('../endpoint-route/routes/agent-mcp/restricted-egress-check');
type OrgTestDb = import('../../test/_org-test-db').OrgTestDb;

const WS = 'binding-enforcement-test';
const RESTRICTED = 'su-binding-restricted';
const RELEASED = 'su-binding-released';
const UNRESTRICTED = 'su-binding-unrestricted';

let org: OrgTestDb;
let sql: postgres.Sql;
let userId: string;

/** A launch environment carrying one credential per provider family plus ordinary state. */
const INHERITED_ENV: Record<string, string> = {
  EMAIL_AUTH_SECRET: 'email-sidecar-secret',
  EMAIL_DATABASE_URL: 'postgresql://u:p@localhost:5432/email_app',
  CALENDAR_AUTH_SECRET: 'calendar-sidecar-secret',
  CALENDAR_DATABASE_URL: 'postgresql://u:p@localhost:5432/calendar_app',
  GMAIL_REFRESH_TOKEN: 'gmail-refresh',
  GOOGLE_OAUTH_CLIENT_SECRET: 'oauth-secret',
  SLACK_BOT_TOKEN: 'xoxb-1',
  SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x',
  DISCORD_BOT_TOKEN: 'discord-1',
  TELEGRAM_BOT_TOKEN: 'telegram-1',
  TWITTER_BEARER_TOKEN: 'twitter-1',
  BLUESKY_APP_PASSWORD: 'bsky-1',
  LINKEDIN_ACCESS_TOKEN: 'linkedin-1',
  MS_GRAPH_CLIENT_SECRET: 'graph-1',
  IMAP_PASSWORD: 'imap-1',
  SMTP_PASS: 'smtp-1',
  // Kept: not provider credentials.
  PATH: '/usr/bin:/bin',
  HOME: '/home/agent',
  PAPERCUSP_SID: 'su-x',
  GOOGLE_CLOUD_PROJECT: 'vertex-project',
  GOOGLE_APPLICATION_CREDENTIALS: '/keys/vertex.json',
  GOOGLE_CLIENT_ID: 'public-client-id',
  SLACK_TEAM: 'team-name',
};
const PROVIDER_CREDENTIALS = [
  'EMAIL_AUTH_SECRET',
  'EMAIL_DATABASE_URL',
  'CALENDAR_AUTH_SECRET',
  'CALENDAR_DATABASE_URL',
  'GMAIL_REFRESH_TOKEN',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'SLACK_BOT_TOKEN',
  'SLACK_WEBHOOK_URL',
  'DISCORD_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'TWITTER_BEARER_TOKEN',
  'BLUESKY_APP_PASSWORD',
  'LINKEDIN_ACCESS_TOKEN',
  'MS_GRAPH_CLIENT_SECRET',
  'IMAP_PASSWORD',
  'SMTP_PASS',
];
const KEPT = ['PATH', 'HOME', 'PAPERCUSP_SID', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLIENT_ID', 'SLACK_TEAM'];

/** One provider-bound command per family the requirement names, plus the sidecar routes. */
const PROVIDER_COMMANDS = providerEgressRules().map((rule) => rule.sample);

async function disclose(agent: string, released: boolean): Promise<void> {
  await sql`
    INSERT INTO harness_shared.personal_disclosures
      (workspace_id, user_id, agent_owner_id, document_id, source, level, reader_set,
       delivered_via, delivered_at, released_at, released_by, release_ref)
    VALUES (${WS}, ${userId}, ${agent}, gen_random_uuid(), 'email', 'sender-only',
            ${['alice@example.com']}::text[], 'personal:search', now() - interval '1 hour',
            ${released ? new Date().toISOString() : null}::timestamptz, ${released ? 'owner' : null},
            ${released ? 'fixture-release' : null})`;
}

async function routeVerdict(owner: string, texts: string[]): Promise<Record<string, unknown>> {
  const route = egressRoutes[0] as unknown as { handler(req: Request): Promise<Response> };
  const res = await route.handler(
    new Request('http://127.0.0.1/api/agent-mcp/restricted-egress-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner, tool: 'Bash', texts }),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

beforeAll(async () => {
  holder.integrationRoot = mkdtempSync(join(tmpdir(), 'binding-source-'));
  execFileSync('git', ['init', '--quiet', holder.integrationRoot]);
  org = await createOrgTestDb();
  sql = org.adminSql;
  holder.sql = sql;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'binding-enforcement-' + Date.now()}, 'binding enforcement')
    RETURNING id`;
  userId = user.id;
  await disclose(RESTRICTED, false);
  await disclose(RELEASED, true);
});

afterAll(async () => {
  if (org && userId) {
    await org.adminSql`DELETE FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`.catch(() => {});
    await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${userId}`.catch(() => {});
  }
  holder.sql = null;
  await org?.cleanup();
  if (holder.integrationRoot) rmSync(holder.integrationRoot, { recursive: true, force: true });
});

describe('R-11 environment: provider credentials never reach an agent launch', () => {
  it('the wake-launch seam drops every provider credential and keeps everything else byte-for-byte', () => {
    const env = sanitizeInheritedWakeEnv(INHERITED_ENV);
    for (const key of PROVIDER_CREDENTIALS) expect(env, key).not.toHaveProperty(key);
    for (const key of KEPT) expect(env[key], key).toBe(INHERITED_ENV[key]);
  });

  it('the shared scrub reports exactly the provider credentials it removed', () => {
    const { env, removed } = scrubProviderCredentials(INHERITED_ENV);
    expect(removed).toEqual([...PROVIDER_CREDENTIALS].sort());
    expect(Object.keys(env).sort()).toEqual([...KEPT].sort());
  });
});

describe('R-11 egress: a restricted session cannot name a provider; an unrestricted one is unchanged', () => {
  it('every rule sample is recognised as provider egress (the fixture covers every family)', () => {
    for (const command of PROVIDER_COMMANDS) expect(findProviderEgressTargets(command), command).not.toHaveLength(0);
  });

  it('refuses every provider-bound command for the restricted session', async () => {
    for (const command of PROVIDER_COMMANDS) {
      const verdict = await checkRestrictedEgress({ ownerId: RESTRICTED, tool: 'Bash', texts: [command] });
      expect(verdict.verdict, command).toBe('refuse');
      expect(verdict.code, command).toBe(EGRESS_REFUSAL_CODE);
      expect(verdict.restricted, command).toBe(true);
    }
  });

  it('allows the same commands for an unrestricted session and for one whose disclosure was released', async () => {
    for (const owner of [UNRESTRICTED, RELEASED]) {
      for (const command of PROVIDER_COMMANDS) {
        const verdict = await checkRestrictedEgress({ ownerId: owner, tool: 'Bash', texts: [command] });
        expect(verdict, `${owner}: ${command}`).toMatchObject({ verdict: 'allow', restricted: false, code: null });
      }
    }
  });

  it('allows a restricted session a command that names no provider, without reading the ledger', async () => {
    const verdict = await checkRestrictedEgress({ ownerId: RESTRICTED, tool: 'Bash', texts: ['ls -la && git status'] });
    expect(verdict).toMatchObject({ verdict: 'allow', restricted: null, targets: [] });
  });

  it('fails closed when the ledger cannot be read', async () => {
    const saved = holder.sql;
    holder.sql = (() => Promise.reject(new Error('ledger down'))) as unknown as postgres.Sql;
    try {
      const verdict = await checkRestrictedEgress({ ownerId: UNRESTRICTED, tool: 'Bash', texts: [PROVIDER_COMMANDS[0]] });
      expect(verdict).toMatchObject({ verdict: 'refuse', code: 'disclosure_ledger_unavailable' });
    } finally {
      holder.sql = saved;
    }
  });

  it('the loopback route the client-native hook calls returns the same verdicts', async () => {
    const command = 'curl -X POST https://slack.com/api/chat.postMessage -d text=hi';
    await expect(routeVerdict(RESTRICTED, [command])).resolves.toMatchObject({
      ok: true,
      verdict: 'refuse',
      code: EGRESS_REFUSAL_CODE,
      targets: ['slack'],
    });
    await expect(routeVerdict(UNRESTRICTED, [command])).resolves.toMatchObject({ ok: true, verdict: 'allow' });
  });

  it('capability:bash refuses a restricted session before the command runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'binding-enforcement-'));
    const marker = join(dir, 'ran');
    holder.ownerId = RESTRICTED;
    const ctx = { projectDir: dir, stateDir: dir, signal: new AbortController().signal, emit: () => {}, role: 'cup' };
    const result = (await bashTool.handler(
      { command: `touch ${marker} && curl -s https://gmail.googleapis.com/gmail/v1/users/me/messages/send`, cwd: dir },
      ctx as never,
    )) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text) as { reason: string; targets: string[] };
    expect(payload.reason).toBe(EGRESS_REFUSAL_CODE);
    expect(payload.targets).toContain('google-mail-calendar-api');
    expect(existsSync(marker)).toBe(false);
  });
});

// WI-10005589 / D-012: name matching cannot see a host built at run time, so a
// restricted session's shell runs with NO network at all.
describe('R-11 network layer: a restricted session’s shell has no network; an unrestricted one is unchanged', () => {
  it('the hook route reports the restriction status even when no provider is named', async () => {
    const status = async (owner: string) => {
      const route = egressRoutes[0] as unknown as { handler(req: Request): Promise<Response> };
      const res = await route.handler(
        new Request('http://127.0.0.1/api/agent-mcp/restricted-egress-check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ owner, tool: 'Bash', texts: ['ls -la'], status: true }),
        }),
      );
      return (await res.json()) as Record<string, unknown>;
    };
    await expect(status(RESTRICTED)).resolves.toMatchObject({ ok: true, verdict: 'allow', restricted: true });
    await expect(status(UNRESTRICTED)).resolves.toMatchObject({ ok: true, restricted: false });
    await expect(status(RELEASED)).resolves.toMatchObject({ ok: true, restricted: false });
  });

  it('an unreadable ledger reads as unknown (null), which every caller treats as restricted', async () => {
    const saved = holder.sql;
    holder.sql = (() => Promise.reject(new Error('ledger down'))) as unknown as postgres.Sql;
    try {
      await expect(readSessionRestriction(UNRESTRICTED)).resolves.toBeNull();
    } finally {
      holder.sql = saved;
    }
    await expect(readSessionRestriction(null)).resolves.toBe(false); // D-004: never delivered, never restricted
  });

  it.skipIf(!capabilityBwrapWorks())(
    'capability:bash: a restricted session runs in an empty network namespace — a host built at run time has no route (real bwrap)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'binding-net-'));
      // The job runs as a transient service in the HOST network namespace, not the
      // test process's, so it reports on itself: its netns, its interfaces, and what
      // a connect to an address assembled at run time (invisible to name matching) does.
      writeFileSync(
        join(dir, 'probe.py'),
        [
          'import os, socket',
          "print('NETNS=' + os.readlink('/proc/self/ns/net'))",
          "print('IFACES=' + ','.join(sorted(n for _, n in socket.if_nameindex())))",
          'try:',
          "    socket.create_connection(('1.1.1.' + '1', 443), 2)",
          "    print('EGRESS=open')",
          'except OSError as e:',
          "    print('EGRESS=errno%d' % e.errno)",
        ].join('\n'),
      );
      // A TRUSTED (superuser) caller: a confined role already runs offline under the
      // exec sandbox, so only a trusted caller shows the restriction is what removes the network.
      const ctx = { projectDir: dir, stateDir: dir, signal: new AbortController().signal, emit: () => {}, isSuperuser: true };
      const run = async (owner: string) => {
        holder.ownerId = owner;
        const result = (await bashTool.handler({ command: 'python3 probe.py', cwd: dir }, ctx as never)) as {
          content: Array<{ text: string }>;
        };
        const text = result.content.map((c) => c.text).join('\n');
        const field = (name: string) => new RegExp(`${name}=(\\S*)`).exec(text)?.[1] ?? null;
        return { text, netns: field('NETNS'), ifaces: field('IFACES'), egress: field('EGRESS') };
      };
      const unrestricted = await run(UNRESTRICTED);
      const released = await run(RELEASED);
      const restricted = await run(RESTRICTED);
      for (const r of [unrestricted, released, restricted]) expect(r.netns, r.text).toMatch(/^net:\[\d+\]$/);
      // Unrestricted sessions run in this process's own network namespace, interfaces and all.
      const ownNetns = readlinkSync('/proc/self/ns/net');
      expect(unrestricted.netns, unrestricted.text).toBe(ownNetns);
      expect(released.netns, released.text).toBe(ownNetns);
      expect(unrestricted.ifaces, unrestricted.text).toBe(released.ifaces);
      // The restricted session: a FRESH namespace created for the command — loopback
      // only, and no route off the machine for a host built at run time.
      expect(restricted.netns, restricted.text).not.toBe(ownNetns);
      expect(restricted.ifaces, restricted.text).toBe('lo');
      expect(restricted.egress, restricted.text).toBe('errno101'); // ENETUNREACH

      // A trusted session is also offline when this SAME fixture has an
      // unattributed source edit during the active disclosure window.
      const dirtySource = join(holder.integrationRoot, 'unattributed.ts');
      writeFileSync(dirtySource, 'export const held = true;\n');
      try {
        expect(await readRestrictedSourceHoldState(holder.integrationRoot)).toBe('held');
        const sourceHeld = await run(UNRESTRICTED);
        expect(sourceHeld.netns, sourceHeld.text).not.toBe(ownNetns);
        expect(sourceHeld.ifaces, sourceHeld.text).toBe('lo');
        expect(sourceHeld.egress, sourceHeld.text).toBe('errno101');
      } finally {
        rmSync(dirtySource, { force: true });
      }
      expect(await readRestrictedSourceHoldState(holder.integrationRoot)).toBe('clear');
    },
    60_000,
  );

  it('recognises the files the agent CLI executes', () => {
    const home = '/home/u';
    for (const p of [
      `${home}/.claude/settings.json`,
      `${home}/.claude.json`,
      `${home}/.papercusp/hooks/cc/x.sh`,
      '/repo/.claude/settings.local.json',
      '/repo/.mcp.json',
      '/repo/.git/hooks/post-commit',
    ]) {
      expect(isAgentRuntimePath(p, home), p).toBe(true);
    }
    for (const p of ['/repo/src/a.ts', `${home}/.papercusp/scratch/x`, '/repo/.git/config', '/repo/docs/claude.md']) {
      expect(isAgentRuntimePath(p, home), p).toBe(false);
    }
  });

  it('capability:write and capability:edit refuse a restricted session’s write of a runtime file, and only that', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'binding-runtime-'));
    const ctx = { projectDir: dir, stateDir: dir, signal: new AbortController().signal, emit: () => {}, isSuperuser: true };
    const settings = join(dir, '.claude', 'settings.json');
    const gitHook = join(dir, '.git', 'hooks', 'post-commit');
    const ordinary = join(dir, 'src', 'a.ts');
    const write = (file_path: string) =>
      writeTool.handler({ file_path, content: '{"hooks":{}}\n' }, ctx as never) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

    holder.ownerId = RESTRICTED;
    for (const target of [settings, gitHook]) {
      const refused = await write(target);
      expect(refused.isError, target).toBe(true);
      expect(JSON.parse(refused.content[0].text), target).toMatchObject({ ok: false, reason: EGRESS_REFUSAL_CODE });
      expect(existsSync(target), target).toBe(false);
    }
    expect((await write(ordinary)).isError).toBeFalsy();

    holder.ownerId = UNRESTRICTED;
    expect((await write(settings)).isError).toBeFalsy();
    holder.ownerId = RESTRICTED;
    const edited = (await editTool.handler(
      { file_path: settings, old_string: '{"hooks":{}}', new_string: '{"hooks":{"x":1}}' },
      ctx as never,
    )) as { isError?: boolean; content: Array<{ text: string }> };
    expect(edited.isError).toBe(true);
    expect(JSON.parse(edited.content[0].text)).toMatchObject({ ok: false, reason: EGRESS_REFUSAL_CODE });
  });
});
