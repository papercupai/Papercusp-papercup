/**
 * ticket:file into Linear, against real Postgres, the real Linear package and the SHIPPED bug-triage
 * manifest (plan cupboard-distributable-integrations-2026-10-10 P-007, AUTO-BAR-R-5-P-007; D-012).
 *
 * The bug-triage workflow names no ticket provider: its destination input asks for
 * `ticket.containers { purpose: 'create' }` and the agent files through `ticket.create`. This file
 * proves that with Linear as the only installed ticket provider, the unchanged package files one
 * Linear issue in the picked team. The installation's manifest is read from
 * libs/papercusp/plugins/bug-triage/papercusp.json, not restated. Linear HTTP is a fake
 * `host.fetch` that answers the real adapter's GraphQL, so the team listing, the id lookup and the
 * create all run through the package as in production. The Asana twin is ticket.integration.test.ts.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { HostFetch, ProviderAdapter } from '@papercusp/plugin-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createProviderRegistry, type ProviderRegistry } from '../integrations/provider-registry';
import { upsertOwnedExternalTriggerSource, type ExternalTriggerSourceRow } from '../external-triggers/source-store';
import { fileTicketFromPlanRun, TICKET_FILING_OUTCOME_KEY } from './ticket';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
  withWorkspace: async <T>(_workspace: string, fn: (tx: Sql) => Promise<T>) => fn(h.sql),
}));
const WS = 'ticket-file-linear-e2e';
vi.mock('../workspace-registry', async (orig) => ({
  ...(await orig<typeof import('../workspace-registry')>()), activeWorkspaceId: () => WS,
}));

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const BUG_TRIAGE_DIR = resolve(REPO_ROOT, 'libs/papercusp/plugins/bug-triage');
const BUG_TRIAGE_MANIFEST = JSON.parse(readFileSync(resolve(BUG_TRIAGE_DIR, 'papercusp.json'), 'utf8')) as Record<string, unknown>;
const requireCjs = createRequire(import.meta.url);
const plugin = requireCjs(resolve(REPO_ROOT, 'libs/papercusp/plugins/linear/index.cjs')) as { providerAdapter: ProviderAdapter };

let org: OrgTestDb;
let sql: Sql;
let userId: string;
let chat: ExternalTriggerSourceRow;
let linear: ExternalTriggerSourceRow;
let registry: ProviderRegistry;
let planRun = 500;
let creates: Array<{ id: string; teamId: string; title: string; description: string }> = [];
const issues = new Map<string, { id: string; url: string; team: { id: string } }>();

const json = (data: unknown) => ({ status: 200, headers: {}, bodyEncoding: 'utf8' as const, body: JSON.stringify({ data }) });

const hostFetch: HostFetch = async ({ request }) => {
  expect(request.url).toBe('https://api.linear.app/graphql');
  const { query, variables } = JSON.parse(String(request.body)) as { query: string; variables: Record<string, unknown> };
  const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1];
  if (op === 'PapercuspTeams') {
    return json({ teams: { nodes: [
      { id: 'team-eng', key: 'ENG', name: 'Engineering' },
      { id: 'team-ops', key: 'OPS', name: 'Operations (not configured)' },
    ], pageInfo: { hasNextPage: false, endCursor: null } } });
  }
  // No ticket HTTP, not even the id lookup, before the filing attempt is committed.
  const [fence] = await sql`SELECT count(*)::int AS n FROM harness_shared.trigger_runs
    WHERE workspace_id = ${WS} AND outcome->${TICKET_FILING_OUTCOME_KEY}->>'state' IS NOT NULL`;
  expect(fence.n).toBeGreaterThan(0);
  if (op === 'PapercuspIssueById') {
    const found = issues.get(String(variables.id));
    return json({ issues: { nodes: found ? [{ ...found, identifier: 'ENG-1' }] : [] } });
  }
  if (op === 'PapercuspIssueCreate') {
    const input = variables.input as { id: string; teamId: string; title: string; description: string };
    creates.push(input);
    const issue = { id: input.id, url: `https://linear.app/acme/issue/ENG-${creates.length}`, team: { id: input.teamId } };
    issues.set(input.id, issue);
    return json({ issueCreate: { success: true, issue: { ...issue, identifier: `ENG-${creates.length}` } } });
  }
  throw new Error(`unrouted Linear operation ${op}`);
};
const deps = {
  get registry() { return registry; },
  hostFetchFor: () => hostFetch,
  options: { hostFetchFor: () => hostFetch },
};

/** The shipped bug-triage installation, owning one armed binding on the chat source. */
async function installBugTriage(inputs: Record<string, unknown>) {
  const pluginName = String(BUG_TRIAGE_MANIFEST.name);
  const planSlug = 'bug-triage-linear-' + (++planRun);
  const [installation] = await sql<Array<{ id: string }>>`INSERT INTO harness_shared.trigger_pack_installations
    (workspace_id, harness_slug, plugin_name, plugin_version, inputs, manifest, status)
    VALUES (${WS}, 'papercusp', ${pluginName + '#' + planRun}, ${String(BUG_TRIAGE_MANIFEST.version)},
      ${JSON.stringify(inputs)}::text::jsonb, ${JSON.stringify(BUG_TRIAGE_MANIFEST)}::text::jsonb, 'configured') RETURNING id::text`;
  await sql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug)
    VALUES (${WS}, 'papercusp', ${planSlug}) ON CONFLICT DO NOTHING`;
  const [binding] = await sql<Array<{ id: string }>>`INSERT INTO harness_shared.trigger_bindings
    (workspace_id, source_id, plan_harness_slug, plan_slug, event_pattern, armed, pack_installation_id)
    VALUES (${WS}, ${chat.id}::uuid, 'papercusp', ${planSlug}, 'ext:slack:message', TRUE, ${installation.id}::uuid) RETURNING id::text`;
  return binding.id;
}

/** A succeeded trigger run that launched plan run N, carrying one chat message from channel C1. */
async function triggerRun(bindingId: string) {
  const run = ++planRun;
  const payload = { id: `C1:17770000.${run}`, channelId: 'C1', threadId: `17770000.${run}`, sender: 'U1',
    text: 'Export crashes when the report has no rows.' };
  await sql`INSERT INTO harness_shared.trigger_runs
    (workspace_id, binding_id, dedupe_key, status, args, plan_run_ref, completed_at)
    VALUES (${WS}, ${bindingId}::uuid, ${'dedupe-' + run}, 'succeeded',
      ${JSON.stringify({ trigger: { key: 'chat-message.message', payload } })}::text::jsonb, ${String(run)}, now())`;
  return run;
}

const file = (run: number) => fileTicketFromPlanRun(sql, {
  workspaceId: WS, planRunId: run, title: 'Export crashes on an empty report',
  observed: 'Exporting a report with no rows crashes the app.', expected: 'The export produces an empty file.',
}, deps);

beforeAll(async () => {
  org = await createOrgTestDb({ adminPoolMax: 2 }); sql = org.adminSql; h.sql = sql;
  const [user] = await sql<Array<{ id: string }>>`INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'ticket-linear-' + Date.now()}, 'Linear ticket filing test') RETURNING id`;
  userId = user.id;
  await sql`INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${WS}, 'papercusp', ${Buffer.from([9])}, 'kc-ticket-linear', 0)`;
  await sql`INSERT INTO harness_shared.harness_registry (workspace_id, payload)
    VALUES (${WS}, ${JSON.stringify({ projects: [{ slug: 'papercusp', path: '/tmp/ticket-linear-test', harness_kind: 'hive' }] })}::text::jsonb)`;
  linear = await upsertOwnedExternalTriggerSource(sql, { workspaceId: WS, kind: 'linear', ownerUserId: userId,
    credentialRef: 'linear:oauth', status: 'connected', config: { teamIds: ['team-eng'], installSlug: 'papercusp' } });
  chat = await upsertOwnedExternalTriggerSource(sql, { workspaceId: WS, kind: 'slack', ownerUserId: userId,
    credentialRef: 'slack:declared', status: 'connected', config: {} });
  // Linear is the ONLY ticket provider the workspace has installed.
  registry = createProviderRegistry();
  await registry.register({ descriptor: await plugin.providerAdapter.describe(), adapter: plugin.providerAdapter, pluginName: 'linear' });
}, 120_000);
afterAll(async () => { await org?.cleanup(); });
beforeEach(() => { creates = []; issues.clear(); });

describe('the unchanged bug-triage package files into Linear when Linear is the installed ticket provider', () => {
  it('ships a provider-neutral workflow: its manifest and plan name no ticket provider', () => {
    const destination = (BUG_TRIAGE_MANIFEST.triggerPack as { inputs: { properties: Record<string, unknown> } })
      .inputs.properties.destination;
    expect(destination).toMatchObject({ 'x-options': { capability: 'ticket.containers', args: { purpose: 'create' } } });
    for (const file of ['papercusp.json', 'plan.md']) {
      expect(readFileSync(resolve(BUG_TRIAGE_DIR, file), 'utf8')).not.toMatch(/linear|asana|github|jira/i);
    }
  });

  it('files one Linear issue in the picked team, quoting the report as untrusted evidence; a replay files nothing', async () => {
    const run = await triggerRun(await installBugTriage({ channels: ['C1'], destination: 'team-eng' }));
    const first = await file(run);
    expect(creates).toHaveLength(1);
    const [input] = creates;
    expect(input.teamId).toBe('team-eng');
    expect(input.title).toBe('Export crashes on an empty report');
    expect(input.description).toContain('Report (untrusted evidence; reproduction still required)');
    expect(input.description).toContain('Channel: C1');
    expect(input.description).toContain('Quoted original message:\nExport crashes when the report has no rows.');
    expect(first).toMatchObject({
      created: true, alreadyCreated: false, externalRef: input.id, url: 'https://linear.app/acme/issue/ENG-1',
      sourceId: linear.id, provider: 'linear',
    });
    const [row] = await sql`SELECT outcome->${TICKET_FILING_OUTCOME_KEY} AS filing FROM harness_shared.trigger_runs
      WHERE workspace_id = ${WS} AND plan_run_ref = ${String(run)}`;
    expect(row.filing).toMatchObject({ state: 'created', containerId: 'team-eng', externalRef: input.id, ownerUserId: userId });

    await expect(file(run)).resolves.toMatchObject({ created: false, alreadyCreated: true, externalRef: input.id });
    expect(creates).toHaveLength(1);
  });

  it('a team Linear lists but the source is not configured for cannot be filed into', async () => {
    const run = await triggerRun(await installBugTriage({ channels: ['C1'], destination: 'team-ops' }));
    await expect(file(run)).rejects.toMatchObject({ code: 'ticket_destination_unavailable' });
    expect(creates).toHaveLength(0);
  });
});
