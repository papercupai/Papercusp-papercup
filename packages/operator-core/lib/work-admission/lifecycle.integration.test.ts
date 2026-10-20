/**
 * Admission lifecycle rules against real Postgres (linear-asana-task-sync-2026-10-05 P-003).
 *
 * The shared connector driver with its datatype sinks, admission rules, admitWorkItem, the record
 * resolver, the write-back verbs, the ledger and the work-item state writers all run, with every
 * migration applied. Only the tracker is a fixture: its tickets live in memory, a sync returns them,
 * and a `ticket.transition` moves one (as Linear or Asana would). The holder notification is
 * captured instead of sent.
 *
 * Properties under test:
 *   - claim → the ticket moves to in-progress and gets one "picked up" comment, however many
 *     syncs follow (the lifecycle key in the ledger);
 *   - needs-human/blocked → one comment carrying the question;
 *   - completion → the completion summary as a comment and a move to `done` (owner #1417), and the
 *     host's own move is not then read as an outside close;
 *   - an outside close of an unclaimed item drops it, naming who closed it;
 *   - an outside close of a claimed item holds it for its holder (computed source-closed blocker +
 *     a message to the holder), never drops it, and a reopen clears the hold;
 *   - an outside reopen of a dropped item re-admits it through the same rule;
 *   - a source without `ticket.transition` still gets the comment; the move is skipped, not failed;
 *   - a rule's lifecycle switches turn reactions off.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { completionHeadBlobMap } from '../agent-tools/work_items/completion-freshness';
import type { ProviderAdapter, ProviderDescriptor } from '@papercusp/plugin-sdk';
import { validateProviderDescriptor } from '@papercusp/plugin-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { TICKET_STATUS_CATEGORIES, isTicketStatusCategory, ticketStateForCategory } from '../data-sources/ticket-vocabulary';
import { providerRegistry } from '../integrations/provider-registry';
import { ingestExternalTriggerEvent, type IngestExternalTriggerInput } from '../external-triggers/ingestion';
import { connectorSinksFor, runConnectorSync, type ConnectorSourceRow } from '../providers/connector-runtime';
import { createDatatypeDestinationSinks, dataSourceRecordId } from '../data-sources/datatype-destination-sink';
import { claimWorkItem, getWorkItem, mergeWorkItemPayload, setWorkItemStateWithAliasInfo } from '../work-items';
import { activeExternalBlockers, applyExternalBlockerUpdate } from '../external-blockers';
import { setAdmissionRule } from './admission-rules';
import { writeBacksForWorkItem } from './write-back-ledger';
import { applySourceLifecycle, sourceClosedRef, correlateAdmissionStandingPr, reconcileAdmissionLifecycle } from './lifecycle';
import { auditGit } from './pr-delivery-audit';
import type { Pr, PrHost } from '../pr-host/types';
import { STANDING_PR_BRANCH } from '../harness/git-sync/decide-standing-pr';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql, ws: 'papercusp-workspace' }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async (orig) => ({
  ...(await orig<typeof import('../workspace-registry')>()),
  activeWorkspaceId: () => h.ws,
}));

const WS = 'papercusp-workspace';
const HARNESS = 'papercusp';
const TRACKER = 'lifecycle-tracker';
const COMMENTER = 'lifecycle-commenter';
const HOLDER = 'su-lifecycle-holder';
const KINDS = [TRACKER, COMMENTER];

let org: OrgTestDb;
let sql: Sql;
let alice: string;

/** Each fixture tracker's tickets, by external id. */
const tickets: Record<string, Map<string, Record<string, unknown>>> = { [TRACKER]: new Map(), [COMMENTER]: new Map() };
const calls: Array<{ provider: string; capability: string; externalId: string; args: Record<string, unknown> }> = [];
const notified: Array<{ holder: string; workItemId: string; body: string }> = [];

function ticket(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'tracker', externalId: id, identifier: id, title: `Ticket ${id}`, body: 'b',
    state: 'open', statusCategory: 'todo', assignees: [], labels: ['papercusp'], ...over,
  };
}

/**
 * The fixture tracker's own open/closed rule for a moved ticket, written independently of the
 * production vocabulary (as Linear/Asana report it: done and canceled are closed). The
 * calibration test pins it to `ticketStateForCategory` for every category.
 */
function fixtureStateFor(category: string): 'open' | 'closed' {
  return category === 'done' || category === 'canceled' ? 'closed' : 'open';
}

function trackerAdapter(descriptor: ProviderDescriptor): ProviderAdapter {
  const own = tickets[descriptor.id]!;
  return {
    describe: () => descriptor,
    syncPage: async () => ({
      records: [...own.values()].map((p) => ({ datatype: 'ticket', nativeId: String(p.externalId), event: 'ticket-updated', payload: { ...p } })),
      nextCursor: null,
      hasMore: false,
    }),
    invoke: async (request) => {
      const externalId = String(request.args.externalId);
      calls.push({ provider: descriptor.id, capability: request.capability, externalId, args: request.args });
      if (request.capability === 'ticket.transition') {
        const current = own.get(externalId);
        const to = String(request.args.toCategory);
        if (!current || current.statusCategory === to) return { changed: false };
        own.set(externalId, { ...current, statusCategory: to, state: fixtureStateFor(to) });
        return { changed: true, updateId: `history:${externalId}:${calls.length}` };
      }
      return { externalRef: `comment-${calls.length}`, updateId: `comment:${calls.length}` };
    },
  };
}

const trackerDescriptor: ProviderDescriptor = {
  id: TRACKER, contractVersion: 1, datatypes: ['ticket'],
  capabilities: ['ticket.read', 'ticket.comment', 'ticket.transition'], egressHosts: ['tracker.example.com'],
};
const commenterDescriptor: ProviderDescriptor = {
  id: COMMENTER, contractVersion: 1, datatypes: ['ticket'],
  capabilities: ['ticket.read', 'ticket.comment'], egressHosts: ['commenter.example.com'],
};

async function ingest(db: Sql, input: IngestExternalTriggerInput) {
  return ingestExternalTriggerEvent(db, input, {
    emit: async (event) => ({ ok: true, key: event.key, woken: 0, notified: [], msgId: null, waiters: 0 }),
  });
}

/** The production sinks, with only the holder notification captured. */
function sinksFor(db: Sql, source: ConnectorSourceRow, datatype: string) {
  return connectorSinksFor(db, source, datatype, {
    createDatatypeSinks: (s, input) =>
      createDatatypeDestinationSinks(s, input, {
        applyLifecycle: (i) => applySourceLifecycle(s, i, { notifyHolder: async (n) => void notified.push(n) }),
      }),
  });
}

/** One pass of the shared driver over one source; its default afterSourceSynced is the lifecycle pass. */
async function sync(sourceId: string): Promise<void> {
  await sql`UPDATE harness_shared.data_sources SET sync_next_attempt_at = NULL WHERE id = ${sourceId}::uuid`;
  const result = await runConnectorSync(sql, { workspaceId: WS, harness: HARNESS, sourceIds: [sourceId] }, { ingest, sinksFor, leaseOwner: 'lifecycle-it' });
  expect(result.sources).toEqual([expect.objectContaining({ sourceId, outcome: 'synced', rejected: 0 })]);
  expect(result.sources[0]!.afterSyncError).toBeUndefined();
}

async function connect(kind: string, lifecycle?: Record<string, unknown>): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources
      (workspace_id, kind, owner_user_id, provider_account_id, status, config, scope, destination_policy, permission_mapping)
    VALUES (${WS}, ${kind}, ${alice}, ${`${kind}-account-${Date.now()}-${Math.random()}`}, 'connected',
            ${sql.json({ harnessSlug: HARNESS })}, 'organization', ${sql.json({ ticket: ['record'] })},
            ${sql.json({ mode: 'source-acl' })})
    RETURNING id::text`;
  await setAdmissionRule(
    { workspaceId: WS, dataSourceId: row!.id, title: 'labelled papercusp', match: { labels: { contains: 'papercusp' } }, harness: HARNESS, createdBy: 'lifecycle-it', ...(lifecycle ? { lifecycle } : {}) },
    sql,
  );
  return row!.id;
}

/** The work item admitted from one synced ticket. */
async function admitted(sourceId: string, externalId: string): Promise<string> {
  const recordId = dataSourceRecordId(WS, sourceId, 'ticket', externalId);
  const [row] = await sql<{ work_item_id: string }[]>`
    SELECT work_item_id FROM harness_shared.work_admissions WHERE workspace_id = ${WS} AND source_key = ${recordId}`;
  expect(row, `no admission for ${externalId}`).toBeDefined();
  return row!.work_item_id;
}

async function item(id: string) {
  const wi = await getWorkItem(id, HARNESS);
  if (!wi) throw new Error(`missing ${id}`);
  return wi;
}

const callsFor = (externalId: string) => calls.filter((c) => c.externalId === externalId).map((c) => [c.capability, c.args.toCategory ?? c.args.text]);

async function clean(): Promise<void> {
  const ids = (await sql<{ id: string }[]>`
    SELECT id::text FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND kind = ANY(${KINDS})`).map((s) => s.id);
  if (ids.length > 0) {
    await sql`DELETE FROM harness_shared.admission_write_backs WHERE workspace_id = ${WS} AND data_source_id = ANY(${ids}::uuid[])`;
    await sql`
      DELETE FROM harness_shared.work_items w USING harness_shared.work_admissions a
       WHERE a.workspace_id = ${WS} AND w.workspace_id = a.workspace_id AND w.feature_id = a.work_item_id
         AND a.data_source_id = ANY(${ids}::uuid[])`;
    await sql`DELETE FROM harness_shared.work_admissions WHERE workspace_id = ${WS} AND data_source_id = ANY(${ids}::uuid[])`;
    await sql`DELETE FROM harness_shared.admission_rules WHERE workspace_id = ${WS} AND data_source_id = ANY(${ids}::uuid[])`;
    await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS} AND payload->>'dataSourceId' = ANY(${ids}::text[])`;
    await sql`DELETE FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS} AND source_id = ANY(${ids}::uuid[])`;
  }
  await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND kind = ANY(${KINDS})`;
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  const [a] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name) VALUES (${`lifecycle-alice-${Date.now()}`}, 'alice') RETURNING id`;
  alice = a!.id;
  // The process-wide registry: the record resolver the lifecycle pass uses by default reads it.
  await providerRegistry().register({ descriptor: trackerDescriptor, adapter: trackerAdapter(trackerDescriptor), pluginName: TRACKER, runtime: 'js' } as never);
  await providerRegistry().register({ descriptor: commenterDescriptor, adapter: trackerAdapter(commenterDescriptor), pluginName: COMMENTER, runtime: 'js' } as never);
});

afterAll(async () => {
  providerRegistry().unregister(TRACKER);
  providerRegistry().unregister(COMMENTER);
  if (org) await clean().catch(() => {});
  if (alice) await sql`DELETE FROM harness_shared.users WHERE id = ${alice}`.catch(() => {});
  await org?.cleanup();
});

beforeEach(async () => {
  await clean();
  calls.length = 0;
  notified.length = 0;
  for (const own of Object.values(tickets)) own.clear();
});

describe('admission lifecycle (P-003)', () => {
  it.each(['merged', 'merged-after-comment', 'merged-after-default-change', 'wrong-fork', 'wrong-head', 'wrong-base', 'closed',
    'base-already-fixed', 'merge-lacks-fix', 'reopened', 'completion-changed'])(
    'reconciles completion after publication and merge, refusing unrelated evidence: %s', async (scenario) => {
      const root = mkdtempSync(join(tmpdir(), 'admission-late-completion-'));
      const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
      try {
        git('init', '-q', '-b', 'main');
        git('config', 'user.name', 'Admission test');
        git('config', 'user.email', 'admission-test@example.invalid');
        writeFileSync(join(root, 'bug.txt'), 'broken\n');
        git('add', '.'); git('commit', '-qm', 'broken fixture');
        const broken = git('rev-parse', 'HEAD');
        git('checkout', '-qb', 'fix');
        writeFileSync(join(root, 'bug.txt'), 'fixed\n');
        git('add', '.'); git('commit', '-qm', 'fix fixture');
        const head = git('rev-parse', 'HEAD');
        const blob = git('rev-parse', 'HEAD:bug.txt');
        git('checkout', '-q', 'main');
        writeFileSync(join(root, 'other.txt'), 'independent target change\n');
        git('add', '.'); git('commit', '-qm', 'target fixture');
        const target = git('rev-parse', 'HEAD');
        git('merge', '--no-ff', '-qm', 'merged standing PR fixture', 'fix');
        let merge = git('rev-parse', 'HEAD');
        let prHead = head;
        if (scenario === 'base-already-fixed') {
          // A later PR changes another file after the fix already reached its target.
          git('checkout', '-qb', 'later', 'fix');
          writeFileSync(join(root, 'later.txt'), 'unrelated change\n');
          git('add', '.'); git('commit', '-qm', 'later unrelated PR');
          prHead = git('rev-parse', 'HEAD');
          git('checkout', '-q', 'main');
          git('merge', '--no-ff', '-qm', 'later merge', 'later');
          merge = git('rev-parse', 'HEAD');
        }
        const source = await connect(TRACKER);
        tickets[TRACKER]!.set('LATE-PR', ticket('LATE-PR'));
        await sync(source);
        const id = await admitted(source, 'LATE-PR');
        const publication = { workspaceId: WS, harnesses: [HARNESS], repositoryRoot: root,
          testedSha: head, targetSha: target, url: 'https://github.com/acme/widgets/pull/7', number: 7 };
        // Publication precedes completion, so the original publication hook cannot link it.
        expect(await correlateAdmissionStandingPr(sql, publication)).toEqual({ linked: [], failed: [] });
        const payload = { ...(await item(id)).payload as Record<string, unknown>, _completionEvidence: {
          summary: 'Late completion of the merged fix.',
          settlementManifest: { version: 1, generation: 1, evidenceHash: 'd'.repeat(64), repositoryRoot: root,
            headSha: head, normalizedPaths: ['bug.txt'],
            contentIdentity: [{ path: 'bug.txt', workingTreeBlobSha: blob, headBlobSha: blob }], residualPaths: [] },
        } };
        await sql`UPDATE harness_shared.work_items SET item_kind = 'bug', status = 'done', authority = 'committed',
          payload = ${sql.json(payload)} WHERE workspace_id = ${WS} AND feature_id = ${id}`;
        // Admissions retain the repository member; the physical item lives at its pot home.
        await sql`UPDATE harness_shared.work_admissions SET harness_slug = 'repo-member'
          WHERE workspace_id = ${WS} AND work_item_id = ${id}`;
        const pr: Pr = { ref: { remote: 'github.com/acme/widgets', number: 7 }, state: 'merged',
          title: 'Standing PR', body: null, head_ref: STANDING_PR_BRANCH, base_ref: 'main',
          head_sha: prHead, head_repo: 'pot/widgets', merge_commit_sha: merge,
          author: { github_user_id: 1, github_login: 'fixture' }, reviewers_requested: [],
          review_decision: 'approved', checks_state: 'success', mergeable_state: 'mergeable',
          is_draft: false, url: publication.url, updated_at: Date.now() };
        if (scenario === 'wrong-fork') pr.head_repo = 'another/widgets';
        if (scenario === 'wrong-head') pr.head_sha = broken;
        if (scenario === 'wrong-base') pr.base_ref = 'another-branch';
        if (scenario === 'closed') pr.state = 'closed';
        if (scenario === 'merge-lacks-fix') pr.merge_commit_sha = target;
        let changed = false;
        const host: Pick<PrHost, 'listPrs' | 'getPr'> = {
          listPrs: vi.fn(async () => ({ ok: true as const, data: [pr] })),
          getPr: vi.fn(async () => {
            if (!changed && scenario === 'reopened') {
              changed = true;
              await sql`UPDATE harness_shared.work_items SET status = 'open'
                WHERE workspace_id = ${WS} AND feature_id = ${id}`;
            }
            if (!changed && scenario === 'completion-changed') {
              changed = true;
              await sql`UPDATE harness_shared.work_items SET payload = payload || '{"newCompletion":true}'::jsonb
                WHERE workspace_id = ${WS} AND feature_id = ${id}`;
            }
            return { ok: true as const, data: pr };
          }),
        };
        const deps = { standingPr: { projects: async () => [{ slug: 'repo-member', hive_slug: HARNESS, path: root,
          github_remote: 'https://github.com/acme/widgets', fork_remote: 'https://github.com/pot/widgets',
          github_default_branch: scenario === 'merged-after-default-change' ? 'staging' : 'main' }], host,
          git: async (dir: string, args: string[]) => args[0] === 'ls-remote'
            ? { code: 0, stdout: `${merge}\trefs/heads/main` } : auditGit(dir, args),
        } };
        if (scenario === 'merged-after-comment') {
          await reconcileAdmissionLifecycle(sql, { workspaceId: WS, dataSourceId: source }, {
            standingPr: { projects: async () => [] },
          });
          expect((await writeBacksForWorkItem(sql, WS, id)).some(w => w.lifecycleKey?.startsWith('complete:'))).toBe(true);
        }
        await reconcileAdmissionLifecycle(sql, { workspaceId: WS, dataSourceId: source }, deps);
        // A changed completion can be reconciled on its next pass, after a fresh audit.
        if (scenario !== 'completion-changed') await reconcileAdmissionLifecycle(sql, { workspaceId: WS, dataSourceId: source }, deps);
        const receipt = ((await item(id)).payload as Record<string, unknown>).standingPr;
        if (scenario === 'merged' || scenario === 'merged-after-comment' || scenario === 'merged-after-default-change') {
          expect(receipt).toMatchObject({ url: publication.url, testedSha: head, targetSha: target, mergedSha: merge });
          const comments = callsFor('LATE-PR').filter(([capability, text]) => capability === 'ticket.comment'
            && String(text).includes(publication.url));
          expect(comments).toHaveLength(1);
          expect(String(comments[0]![1])).toContain('Merged');
          expect(String(comments[0]![1])).not.toContain('Awaiting');
          expect(host.listPrs).toHaveBeenCalledTimes(1);
        } else expect(receipt).toBeUndefined();
        if (scenario === 'reopened') expect(callsFor('LATE-PR').some(([, text]) => String(text).includes('Completed'))).toBe(false);
      } finally { rmSync(root, { recursive: true, force: true }); }
    },
  );

  it('links an admitted fix only when its recorded content is in the tested PR diff, with one provider comment across retries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'admission-standing-pr-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    try {
      git('init', '-q');
      git('config', 'user.name', 'Admission test');
      git('config', 'user.email', 'admission-test@example.invalid');
      writeFileSync(join(root, 'bug.txt'), 'broken\n');
      git('add', 'bug.txt'); git('commit', '-qm', 'independent broken fixture');
      const target = git('rev-parse', 'HEAD');
      writeFileSync(join(root, 'bug.txt'), 'fixed\n');
      git('add', 'bug.txt'); git('commit', '-qm', 'tested fix fixture');
      const head = git('rev-parse', 'HEAD');
      const fixedBlob = git('rev-parse', 'HEAD:bug.txt');
      const source = await connect(TRACKER);
      tickets[TRACKER]!.set('PR-1', ticket('PR-1'));
      await sync(source);
      const id = await admitted(source, 'PR-1');
      const payload = { ...(await item(id)).payload as Record<string, unknown>, _completionEvidence: {
        summary: 'Fixed the independently recorded behavior.',
        settlementManifest: { version: 1, generation: 1, evidenceHash: 'c'.repeat(64), repositoryRoot: root,
          headSha: head, normalizedPaths: ['bug.txt'],
          contentIdentity: [{ path: 'bug.txt', workingTreeBlobSha: fixedBlob, headBlobSha: fixedBlob }], residualPaths: [] },
      } };
      await sql`UPDATE harness_shared.work_items SET item_kind = 'bug', status = 'done', authority = 'committed',
        payload = ${sql.json(payload)} WHERE workspace_id = ${WS} AND feature_id = ${id}`;
      const input = { workspaceId: WS, harnesses: [HARNESS], repositoryRoot: root,
        testedSha: head, targetSha: target, url: 'https://github.com/acme/widgets/pull/7', number: 7 };
      expect(await correlateAdmissionStandingPr(sql, { ...input, testedSha: target })).toEqual({ linked: [], failed: [] });
      expect((await item(id)).payload).not.toHaveProperty('standingPr');
      expect(await correlateAdmissionStandingPr(sql, { ...input, harnesses: ['another-pot'] })).toEqual({ linked: [], failed: [] });
      let reopened = false;
      expect(await correlateAdmissionStandingPr(sql, input, {
        headBlobs: async (...args) => {
          if (!reopened) {
            reopened = true;
            await sql`UPDATE harness_shared.work_items SET status = 'open' WHERE workspace_id = ${WS} AND feature_id = ${id}`;
          }
          return completionHeadBlobMap(...args);
        },
      })).toEqual({ linked: [], failed: [{ workItemId: id, error: expect.stringContaining('source completion changed') }] });
      expect((await item(id)).payload).not.toHaveProperty('standingPr');
      await sql`UPDATE harness_shared.work_items SET status = 'done' WHERE workspace_id = ${WS} AND feature_id = ${id}`;
      expect(await correlateAdmissionStandingPr(sql, input)).toEqual({ linked: [id], failed: [] });
      expect(await correlateAdmissionStandingPr(sql, input)).toEqual({ linked: [], failed: [] });
      await sync(source); await sync(source);
      expect(callsFor('PR-1').filter(([capability, text]) => capability === 'ticket.comment'
        && String(text).includes(input.url))).toHaveLength(1);
      expect((await writeBacksForWorkItem(sql, WS, id)).filter((write) => write.lifecycleKey?.startsWith('standing-pr:'))).toHaveLength(1);
      // Sync-back has advanced the target to the fix: the next PR must not claim this old issue.
      expect(await correlateAdmissionStandingPr(sql, { ...input, targetSha: head,
        url: 'https://github.com/acme/widgets/pull/8', number: 8 })).toEqual({ linked: [], failed: [] });
      expect((await item(id)).payload).toMatchObject({ standingPr: { url: input.url } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs on calibrated fixtures', async () => {
    // (1) Both fixture trackers are valid provider descriptors (the production registry's
    // register() also validates them in beforeAll; this states it explicitly).
    expect(validateProviderDescriptor(trackerDescriptor)).toEqual([]);
    expect(validateProviderDescriptor(commenterDescriptor)).toEqual([]);
    // (2) The fixture's open/closed rule agrees with the production vocabulary for every category.
    for (const category of TICKET_STATUS_CATEGORIES) {
      expect({ category, state: fixtureStateFor(category) }).toEqual({ category, state: ticketStateForCategory(category) });
    }
    // (3) A fixture ticket carries a real category whose state matches it.
    const t = ticket('CAL-1');
    expect(isTicketStatusCategory(t.statusCategory)).toBe(true);
    expect(t.state).toBe(ticketStateForCategory(t.statusCategory as (typeof TICKET_STATUS_CATEGORIES)[number]));
    // (4) The transition result contract: a move reports changed:true with an update id; a move to
    // the current category reports changed:false (record-source reads `changed !== false`).
    tickets[TRACKER]!.set('CAL-1', t);
    const adapter = trackerAdapter(trackerDescriptor);
    const req = (toCategory: string) => ({ capability: 'ticket.transition', args: { externalId: 'CAL-1', toCategory } }) as never;
    const host = {} as never; // the fixture tracker never reaches the network
    expect(await adapter.invoke(req('in-progress'), host)).toMatchObject({ changed: true, updateId: expect.any(String) });
    expect(await adapter.invoke(req('in-progress'), host)).toEqual({ changed: false });
    expect(tickets[TRACKER]!.get('CAL-1')).toMatchObject({ statusCategory: 'in-progress', state: 'open' });
  });

  it('moves a claimed ticket to in-progress and comments the holder once, however many syncs follow', async () => {
    tickets[TRACKER]!.set('T-1', ticket('T-1'));
    const source = await connect(TRACKER);
    await sync(source);
    const wi = await admitted(source, 'T-1');
    expect(calls).toEqual([]);

    await claimWorkItem(wi, HOLDER, { harness: HARNESS });
    await sync(source);
    expect(callsFor('T-1')).toEqual([
      ['ticket.transition', 'in-progress'],
      ['ticket.comment', `Picked up in Papercusp as ${wi}; ${HOLDER} is working on it.`],
    ]);
    expect(tickets[TRACKER]!.get('T-1')).toMatchObject({ statusCategory: 'in-progress' });

    await sync(source);
    await sync(source);
    expect(calls).toHaveLength(2);
    const keys = (await writeBacksForWorkItem(sql, WS, wi)).map((w) => w.lifecycleKey).sort();
    expect(keys).toEqual([`claim:${HOLDER}`, `claim:${HOLDER}:move`]);
  });

  it('comments the question a held item waits on', async () => {
    tickets[TRACKER]!.set('T-2', ticket('T-2'));
    const source = await connect(TRACKER);
    await sync(source);
    const wi = await admitted(source, 'T-2');
    await claimWorkItem(wi, HOLDER, { harness: HARNESS });
    const before = await item(wi);
    const update = applyExternalBlockerUpdate(
      before.payload,
      { kind: 'event', capability: 'live-dependency', ref: 'trial-plan', summary: 'Which billing plan should the trial use?', nextVerb: 'events:await' },
      HOLDER,
      { autoAuthority: false },
    );
    await mergeWorkItemPayload(wi, { externalBlockers: update.blockers }, { harness: HARNESS });
    await setWorkItemStateWithAliasInfo(wi, 'blocked', { harness: HARNESS, by: HOLDER });
    await sync(source);
    await sync(source);
    expect(callsFor('T-2').filter(([cap]) => cap === 'ticket.comment')).toEqual([
      ['ticket.comment', `Picked up in Papercusp as ${wi}; ${HOLDER} is working on it.`],
      ['ticket.comment', `Papercusp is waiting on this (${wi}): Which billing plan should the trial use? Next: events:await`],
    ]);
  });

  it.each(['committed', 'proposed'] as const)('syncs a verified-existing dropped resolution only when authority is %s', async (authority) => {
    tickets[TRACKER]!.set('EXISTING-1', ticket('EXISTING-1'));
    const source = await connect(TRACKER);
    await sync(source);
    const wi = await admitted(source, 'EXISTING-1');
    await claimWorkItem(wi, HOLDER, { harness: HARNESS });
    await setWorkItemStateWithAliasInfo(wi, 'dropped', {
      harness: HARNESS, by: HOLDER, completionRef: 'verified-existing-lifecycle-it',
      completionAuthority: authority,
      completionEvidence: { summary: 'Existing fix verified.', workOutcome: 'verified-existing',
        verifiedHow: 'manual', testResult: 'Existing behavior checked.' },
    });
    expect((await item(wi)).completionAuthority).toBe(authority);
    calls.length = 0;

    await sync(source);
    await sync(source);
    const expected = authority === 'committed' ? [
      ['ticket.comment', `Verified existing resolution in Papercusp (${wi}).\n\nExisting fix verified.`],
      ['ticket.transition', 'done'],
    ] : [];
    expect(callsFor('EXISTING-1')).toEqual(expected);
    expect(tickets[TRACKER]!.get('EXISTING-1')).toMatchObject({
      statusCategory: authority === 'committed' ? 'done' : 'todo',
      state: authority === 'committed' ? 'closed' : 'open',
    });
    expect((await item(wi)).state).toBe('dropped');
    expect(await writeBacksForWorkItem(sql, WS, wi)).toHaveLength(expected.length);
    expect(notified).toEqual([]);
  });

  it('comments the completion summary and moves the ticket to done, without reading its own move as an outside close', async () => {
    tickets[TRACKER]!.set('T-3', ticket('T-3'));
    const source = await connect(TRACKER);
    await sync(source);
    const wi = await admitted(source, 'T-3');
    await claimWorkItem(wi, HOLDER, { harness: HARNESS });
    await sync(source);
    calls.length = 0;

    await setWorkItemStateWithAliasInfo(wi, 'done', { harness: HARNESS, by: HOLDER, completionRef: 'lifecycle-it' });
    await mergeWorkItemPayload(wi, { _completionEvidence: { summary: 'Fixed the export button.' } }, { harness: HARNESS });
    await sync(source);
    expect(callsFor('T-3')).toEqual([
      ['ticket.comment', `Completed in Papercusp (${wi}).\n\nFixed the export button.`],
      ['ticket.transition', 'done'],
    ]);
    expect(tickets[TRACKER]!.get('T-3')).toMatchObject({ statusCategory: 'done', state: 'closed' });

    // The next sync delivers the ticket as done: the item is already finished, so nothing reacts.
    await sync(source);
    expect((await item(wi)).state).toBe('done');
    expect(calls).toHaveLength(2);
    expect(notified).toEqual([]);
  });

  it('drops an unclaimed item that is closed outside, naming who closed it', async () => {
    tickets[TRACKER]!.set('T-4', ticket('T-4'));
    const source = await connect(TRACKER);
    await sync(source);
    const wi = await admitted(source, 'T-4');

    tickets[TRACKER]!.set('T-4', ticket('T-4', { statusCategory: 'canceled', state: 'closed', closedBy: { name: 'Dana' } }));
    await sync(source);
    const dropped = await item(wi);
    expect(dropped.state).toBe('dropped');
    expect(dropped.terminalCompletionRef).toBe('source closed: T-4 was moved to canceled by Dana in tracker');
    expect(calls).toEqual([]);
  });

  it('holds a claimed item closed outside for its holder, and clears the hold when the ticket reopens', async () => {
    tickets[TRACKER]!.set('T-5', ticket('T-5'));
    const source = await connect(TRACKER);
    await sync(source);
    const wi = await admitted(source, 'T-5');
    await claimWorkItem(wi, HOLDER, { harness: HARNESS });
    await sync(source);
    const recordId = dataSourceRecordId(WS, source, 'ticket', 'T-5');

    const closedTicket = { ...tickets[TRACKER]!.get('T-5')!, statusCategory: 'done', state: 'closed', closedBy: 'Dana' };
    tickets[TRACKER]!.set('T-5', closedTicket);
    await sync(source);
    const held = await item(wi);
    expect(held.state).toBe('blocked');
    expect(held.assignee).toBe(HOLDER);
    const [hold] = activeExternalBlockers(held.payload);
    expect(hold).toMatchObject({ ref: sourceClosedRef(recordId), kind: 'event' });
    expect(hold!.summary).toContain(`while ${HOLDER} holds ${wi}`);
    expect(hold!.summary).toContain('by Dana in tracker');
    expect(notified).toEqual([expect.objectContaining({ holder: HOLDER, workItemId: wi })]);
    // The source is not told about its own close, and a later sync does not hold or message twice.
    await sync(source);
    expect(callsFor('T-5').filter(([cap]) => cap === 'ticket.comment')).toHaveLength(1);
    expect(notified).toHaveLength(1);

    tickets[TRACKER]!.set('T-5', { ...closedTicket, statusCategory: 'todo', state: 'open' });
    await sync(source);
    const resumed = await item(wi);
    expect(activeExternalBlockers(resumed.payload)).toEqual([]);
    expect(resumed.state).toBe('wip');
    expect(resumed.assignee).toBe(HOLDER);
  });

  it('blocker history CAS preserves a concurrent hold and the source watermark after a stale close read', async () => {
    tickets[TRACKER]!.set('T-CAS', ticket('T-CAS'));
    const source = await connect(TRACKER);
    await sync(source);
    const id = await admitted(source, 'T-CAS');
    await claimWorkItem(id, HOLDER, { harness: HARNESS });
    const recordId = dataSourceRecordId(WS, source, 'ticket', 'T-CAS');
    const original = await item(id);
    const [before] = await sql`SELECT source_category FROM harness_shared.work_admissions WHERE work_item_id = ${id}`;
    const concurrent = applyExternalBlockerUpdate({}, { kind: 'event', ref: 'event:concurrent', summary: 'independent condition' }, HOLDER, { autoAuthority: false }).blockers;
    const setState = vi.fn(async () => null);
    const notifyHolder = vi.fn(async () => {});
    await expect(applySourceLifecycle(sql, { workspaceId: WS, recordId, payload: ticket('T-CAS', { statusCategory: 'done', state: 'closed' }) }, {
      getWorkItem: async () => {
        await mergeWorkItemPayload(id, { externalBlockers: concurrent }, { harness: HARNESS });
        return original;
      }, setState, notifyHolder,
    })).rejects.toThrow('blocker history conflict');
    expect(setState).not.toHaveBeenCalled();
    expect(notifyHolder).not.toHaveBeenCalled();
    expect((await item(id)).payload).toMatchObject({ externalBlockers: concurrent });
    const [after] = await sql`SELECT source_category FROM harness_shared.work_admissions WHERE work_item_id = ${id}`;
    expect(after?.source_category).toBe(before?.source_category);
  });

  it('re-admits a dropped item when its ticket is reopened outside', async () => {
    tickets[TRACKER]!.set('T-6', ticket('T-6'));
    const source = await connect(TRACKER);
    await sync(source);
    const wi = await admitted(source, 'T-6');
    tickets[TRACKER]!.set('T-6', ticket('T-6', { statusCategory: 'canceled', state: 'closed' }));
    await sync(source);
    expect((await item(wi)).state).toBe('dropped');

    tickets[TRACKER]!.set('T-6', ticket('T-6', { statusCategory: 'triage' }));
    await sync(source);
    expect((await item(wi)).state).toBe('open');
  });

  it('comments on a source without ticket.transition and skips the move without failing the sync', async () => {
    tickets[COMMENTER]!.set('C-1', ticket('C-1'));
    const source = await connect(COMMENTER);
    await sync(source);
    const wi = await admitted(source, 'C-1');
    await claimWorkItem(wi, HOLDER, { harness: HARNESS });
    await sync(source);
    await sync(source);
    expect(calls).toEqual([
      expect.objectContaining({ provider: COMMENTER, capability: 'ticket.comment', args: { externalId: 'C-1', text: `Picked up in Papercusp as ${wi}; ${HOLDER} is working on it.` } }),
    ]);
  });

  it("follows the rule's lifecycle switches", async () => {
    tickets[TRACKER]!.set('T-7', ticket('T-7'));
    const source = await connect(TRACKER, { claim: false, externalClose: false });
    await sync(source);
    const wi = await admitted(source, 'T-7');
    await claimWorkItem(wi, HOLDER, { harness: HARNESS });
    await sync(source);
    expect(calls).toEqual([]);
    tickets[TRACKER]!.set('T-7', ticket('T-7', { statusCategory: 'done', state: 'closed' }));
    await sync(source);
    expect((await item(wi)).state).not.toBe('blocked');
    expect(notified).toEqual([]);
    await expect(
      setAdmissionRule({ workspaceId: WS, dataSourceId: source, title: 'x', match: { labels: { contains: 'x' } }, harness: HARNESS, createdBy: 'it', lifecycle: { onClaim: true } }, sql),
    ).rejects.toThrow(/admission_rule_invalid: unknown lifecycle key/);
  });
});
