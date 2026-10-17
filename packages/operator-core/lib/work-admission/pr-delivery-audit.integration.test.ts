import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { auditPrDelivery, inspectPrDeliveryRow, loadPrDeliveryAuditPopulation, auditGit, type PrDeliveryAuditRow } from './pr-delivery-audit';
import { completionHeadBlobMap } from '../agent-tools/work_items/completion-freshness';
import { TERMINAL_COMPLETION_EVIDENCE_KEY } from '../coord-lifecycle/records';
import { STANDING_PR_BRANCH } from '../harness/git-sync/decide-standing-pr';
import type { Pr, PrHost } from '../pr-host/types';
import type { ProjectEntry } from '../harness-registry';

const ruleId = randomUUID();
const upstreamUrl = 'https://github.com/acme/subject.git';
const forkUrl = 'https://github.com/acme-bot/subject.git';
const url = 'https://github.com/acme/subject/pull/7';
let root: string, upstream: string, repo: string, base: string, fix: string;
let row: PrDeliveryAuditRow, project: ProjectEntry;
const git = (path: string, ...args: string[]) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('PR bypass falsifier against real upstream Git', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pr-delivery-audit-'));
    upstream = join(root, 'upstream.git'); repo = join(root, 'working');
    execFileSync('git', ['init', '--bare', upstream], { stdio: 'ignore' });
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
    git(repo, 'config', 'user.name', 'audit fixture'); git(repo, 'config', 'user.email', 'audit@example.invalid');
    git(repo, 'config', `url.${upstream}.insteadOf`, upstreamUrl);
    git(repo, 'remote', 'add', 'origin', upstreamUrl);
    writeFileSync(join(repo, 'product.ts'), 'broken\n');
    git(repo, 'add', 'product.ts'); git(repo, 'commit', '-m', 'broken baseline');
    base = git(repo, 'rev-parse', 'HEAD'); git(repo, 'push', 'origin', 'HEAD:main');
    writeFileSync(join(repo, 'product.ts'), 'fixed\n');
    git(repo, 'add', 'product.ts'); git(repo, 'commit', '-m', 'real fix');
    fix = git(repo, 'rev-parse', 'HEAD');
    project = { slug: 'subject', path: repo, github_remote: upstreamUrl,
      github_default_branch: 'main', fork_remote: forkUrl };
    row = { id: 'EI-fixture', harness: 'subject', ruleId, state: 'done', authority: 'committed',
      payload: { [TERMINAL_COMPLETION_EVIDENCE_KEY]: { settlementManifest: {
        version: 1, generation: 1, evidenceHash: 'e'.repeat(64), repositoryRoot: repo,
        headSha: base, normalizedPaths: ['product.ts'], contentIdentity: [{ path: 'product.ts',
          workingTreeBlobSha: git(repo, 'rev-parse', 'HEAD:product.ts'),
          headBlobSha: git(repo, 'rev-parse', `${base}:product.ts`) }], residualPaths: [],
      } } } };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const link = () => { row.payload.standingPr = { schemaVersion: 'admission-standing-pr-v1',
    url, number: 7, testedSha: fix, targetSha: base }; };
  const pr = (over: Partial<Pr> = {}): Pr => ({ ref: { remote: 'github.com/acme/subject', number: 7 },
    state: 'merged', title: 'standing', body: '', head_ref: STANDING_PR_BRANCH, head_sha: fix,
    base_ref: 'main', head_repo: 'acme-bot/subject', merge_commit_sha: fix,
    author: { login: 'acme-bot' }, reviewers_requested: [], review_decision: 'approved',
    checks_state: 'success', mergeable_state: 'clean', is_draft: false, url, updated_at: Date.now(), ...over } as Pr);
  const host = (value: Pr): Pick<PrHost, 'getPr'> => ({ getPr: async () => ({ ok: true, data: value }) });

  it('fails a direct upstream push without a standing PR', async () => {
    git(repo, 'push', 'origin', 'HEAD:main');
    expect(await inspectPrDeliveryRow(row, project, { host: null }))
      .toMatchObject({ verdict: 'fail', upstreamSha: fix, fixSha: fix });
  });
  it('returns a proven bypass without scanning unrelated unreadable historical trees', async () => {
    git(repo, 'push', 'origin', 'HEAD:main');
    const read: string[] = [];
    const result = await inspectPrDeliveryRow(row, project, { host: null,
      blobs: async (path, commit, paths) => {
        read.push(commit);
        return commit === base ? undefined : completionHeadBlobMap(path, commit, paths);
      },
    });
    expect(result).toMatchObject({ verdict: 'fail', fixSha: fix });
    expect(read).toEqual([fix]);
  });
  it('audits a terminal cohort with bounded concurrent upstream reads and preserves row order', async () => {
    git(repo, 'push', 'origin', 'HEAD:main');
    const cohort = Array.from({ length: 6 }, (_, i) => ({ ...row, id: `EI-parallel-${i}` }));
    let active = 0, maximum = 0;
    const result = await auditPrDelivery('ws', { ruleIds: [ruleId] }, {
      population: async () => ({ rows: cohort, total: cohort.length, missingRuleIds: [] }),
      projects: async () => [project], host: null,
      git: async (path, args) => {
        if (args[0] !== 'ls-remote') return auditGit(path, args);
        active++; maximum = Math.max(maximum, active);
        try { return await auditGit(path, args); } finally { active--; }
      },
    });
    expect(result).toMatchObject({ verdict: 'fail', complete: true, checked: 6 });
    expect(result.rows.map(r => r.id)).toEqual(cohort.map(r => r.id));
    expect(result.rows.every(r => r.verdict === 'fail')).toBe(true);
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(4);
  });
  it('still detects the direct fix after it is reverted upstream', async () => {
    git(repo, 'push', 'origin', 'HEAD:main'); git(repo, 'revert', '--no-edit', fix); git(repo, 'push', 'origin', 'HEAD:main');
    expect(await inspectPrDeliveryRow(row, project, { host: null }))
      .toMatchObject({ verdict: 'fail', fixSha: fix });
  });
  it('bounds concurrent history blob reads and still detects a reverted direct fix', async () => {
    git(repo, 'push', 'origin', 'HEAD:main');
    git(repo, 'revert', '--no-edit', fix);
    git(repo, 'push', 'origin', 'HEAD:main');
    let active = 0, maximum = 0;
    const result = await inspectPrDeliveryRow(row, project, {
      host: null,
      blobs: async (path, commit, paths) => {
        active++; maximum = Math.max(maximum, active);
        try { return await completionHeadBlobMap(path, commit, paths); }
        finally { active--; }
      },
    });
    expect(result).toMatchObject({ verdict: 'fail', fixSha: fix });
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(4);
  });
  it('does not claim a bypass while the fix remains on the working copy', async () => {
    expect(await inspectPrDeliveryRow(row, project, { host: null })).toMatchObject({ verdict: 'pass', upstreamSha: base });
  });
  it('accepts the actual fix introduced by the matching merged standing PR', async () => {
    git(repo, 'push', 'origin', 'HEAD:main'); link();
    expect(await inspectPrDeliveryRow(row, project, { host: host(pr()) }))
      .toMatchObject({ verdict: 'pass', upstreamSha: fix, prUrl: url });
  });
  it('accepts a two-parent PR merge when the completion baseline is its fork head', async () => {
    git(repo, 'branch', 'standing', fix); git(repo, 'reset', '--hard', base);
    git(repo, 'merge', '--no-ff', '-m', 'reviewed standing PR', 'standing');
    const merge = git(repo, 'rev-parse', 'HEAD'); git(repo, 'push', 'origin', 'HEAD:main'); link();
    const evidence = row.payload[TERMINAL_COMPLETION_EVIDENCE_KEY] as {
      settlementManifest: { headSha: string };
    };
    evidence.settlementManifest.headSha = fix;
    expect(git(repo, 'merge-base', '--is-ancestor', fix, merge)).toBe('');
    expect(git(repo, 'rev-list', '--first-parent', merge).split('\n')).not.toContain(fix);
    expect(await inspectPrDeliveryRow(row, project, { host: host(pr({ merge_commit_sha: merge })) }))
      .toMatchObject({ verdict: 'pass', upstreamSha: merge, prUrl: url });
  });
  it('detects a directly pushed completion baseline after an upstream revert', async () => {
    const evidence = row.payload[TERMINAL_COMPLETION_EVIDENCE_KEY] as {
      settlementManifest: { headSha: string };
    };
    evidence.settlementManifest.headSha = fix;
    git(repo, 'push', 'origin', 'HEAD:main'); git(repo, 'revert', '--no-edit', fix); git(repo, 'push', 'origin', 'HEAD:main');
    expect(await inspectPrDeliveryRow(row, project, { host: null }))
      .toMatchObject({ verdict: 'fail', fixSha: fix });
  });
  it('accepts the merged standing PR when its base differs from the registered default branch', async () => {
    git(repo, 'push', 'origin', `${base}:refs/heads/staging`);
    git(repo, 'push', 'origin', 'HEAD:main'); link();
    project.github_default_branch = 'staging';
    expect(await inspectPrDeliveryRow(row, project, { host: host(pr()) }))
      .toMatchObject({ verdict: 'pass', upstreamSha: fix, prUrl: url });
  });
  it('detects a direct fix on an upstream branch other than the default', async () => {
    git(repo, 'push', 'origin', 'HEAD:staging');
    expect(await inspectPrDeliveryRow(row, project, { host: null }))
      .toMatchObject({ verdict: 'fail', upstreamSha: fix, fixSha: fix });
  });
  it('keeps a capped upstream branch census unknown', async () => {
    expect(await inspectPrDeliveryRow(row, project, { host: null,
      git: async (path, args) => args[0] === 'ls-remote'
        ? { code: 0, stdout: Array.from({ length: 101 }, (_, i) => `${base}\trefs/heads/branch-${i}`).join('\n') }
        : auditGit(path, args),
    })).toMatchObject({ verdict: 'unknown', reason: 'The upstream branch census is incomplete.' });
  });
  it.each([
    { state: 'open' }, { head_repo: 'another/subject' }, { head_sha: 'a'.repeat(40) },
    { head_ref: 'one-pr-per-agent' }, { base_ref: 'wrong-branch' }, { is_draft: true },
  ] as Partial<Pr>[])('refuses an open or mismatched standing PR: %j', async (over) => {
    git(repo, 'push', 'origin', 'HEAD:main'); link();
    expect(await inspectPrDeliveryRow(row, project, { host: host(pr(over)) })).toMatchObject({ verdict: 'fail' });
  });
  it('rejects a later PR receipt whose base already contained the direct fix', async () => {
    git(repo, 'push', 'origin', 'HEAD:main'); link();
    (row.payload.standingPr as Record<string, unknown>).targetSha = fix;
    expect(await inspectPrDeliveryRow(row, project, { host: host(pr()) })).toMatchObject({ verdict: 'fail' });
  });
  it('rejects a later merged PR that tries to legitimize an earlier direct push', async () => {
    git(repo, 'push', 'origin', 'HEAD:main'); link();
    git(repo, 'commit', '--allow-empty', '-m', 'later standing PR merge');
    const merge = git(repo, 'rev-parse', 'HEAD'); git(repo, 'push', 'origin', 'HEAD:main');
    expect(await inspectPrDeliveryRow(row, project, { host: host(pr({ merge_commit_sha: merge })) }))
      .toMatchObject({ verdict: 'fail', reason: 'The fix was already on upstream before this standing PR merged.' });
  });
  it('keeps unreadable upstream refs unknown', async () => {
    expect(await inspectPrDeliveryRow(row, project, { host: null,
      git: async (path, args) => args[0] === 'ls-remote' ? { code: 128, stdout: '' } : auditGit(path, args) }))
      .toMatchObject({ verdict: 'unknown' });
  });
  it('keeps a capped history census unknown instead of claiming absence', async () => {
    expect(await inspectPrDeliveryRow(row, project, { host: null,
      git: async (path, args) => args[0] === 'log'
        ? { code: 0, stdout: Array.from({ length: 101 }, (_, i) => String(i).padStart(40, '0')).join('\n') }
        : auditGit(path, args),
      blobs: async (_root, _sha, paths) => new Map(paths.map(path => [path, { status: 'resolved' as const, sha: 'b'.repeat(40) }])),
    })).toMatchObject({ verdict: 'unknown', reason: 'The upstream history census is incomplete.' });
  });
});

describe('actual admission-rule cohort query', () => {
  let org: OrgTestDb, sql: Sql, source: string, directRule: string;
  beforeAll(async () => {
    org = await createOrgTestDb(); sql = org.adminSql;
    const [user] = await sql`INSERT INTO harness_shared.users (username, display_name)
      VALUES (${`pr-audit-${randomUUID()}`}, 'PR audit') RETURNING id`;
    const [s] = await sql`INSERT INTO harness_shared.data_sources
      (workspace_id, kind, owner_user_id, provider_account_id, status, config, scope, destination_policy, permission_mapping)
      VALUES ('papercusp-workspace', 'audit-fixture', ${user!.id}, ${randomUUID()}, 'connected',
        ${sql.json({ harnessSlug: 'papercusp' })}, 'organization',
        ${sql.json({ ticket: ['record'] })}, ${sql.json({ mode: 'source-acl' })}) RETURNING id`;
    source = s!.id;
    const [r] = await sql`INSERT INTO harness_shared.admission_rules
      (workspace_id, data_source_id, title, match, harness_slug, enabled, created_by, lifecycle)
      VALUES ('papercusp-workspace', ${source}, 'no PR opt-in', '{"labels":{"contains":"bug"}}', 'papercusp', false, 'fixture', '{}') RETURNING id`;
    directRule = r!.id;
    await sql`INSERT INTO harness_shared.work_admissions
      (workspace_id, work_item_id, harness_slug, source_kind, source_key, admitted_via, admitted_by, rule_id)
      VALUES ('papercusp-workspace', 'EI-audit-missing', 'papercusp', 'record', ${randomUUID()}, 'rule', 'fixture', ${directRule})`;
  }, 120000);
  afterAll(async () => { await org?.cleanup(); });
  it('includes disabled rules omitting delivery:pr and retains missing work items', async () => {
    const result = await loadPrDeliveryAuditPopulation('papercusp-workspace', [directRule], sql);
    expect(result).toMatchObject({ total: 1, missingRuleIds: [], rows: [{ id: 'EI-audit-missing', ruleId: directRule, state: null }] });
  });
  it.each(['open', 'done'])('resolves a %s issue at its pot home while retaining the admitted member Git route', async state => {
    const id = `EI-home-${randomUUID()}`;
    const member = `audit-member-${randomUUID()}`;
    const home = `${member}-pot`;
    const payload = { standingPr: { url: 'https://github.com/acme/subject/pull/7' } };
    const [rule] = await sql`INSERT INTO harness_shared.admission_rules
      (workspace_id, data_source_id, title, match, harness_slug, enabled, created_by, lifecycle)
      VALUES ('papercusp-workspace', ${source}, 'member route', '{"labels":{"contains":"bug"}}', ${member}, true, 'fixture', '{}') RETURNING id`;
    await sql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, authority, payload)
      VALUES ('papercusp-workspace', ${home}, ${id}, 'home issue', 'home issue', ${state}, 'bug', 'committed', ${sql.json(payload)})`;
    await sql`INSERT INTO harness_shared.work_admissions
      (workspace_id, work_item_id, harness_slug, source_kind, source_key, admitted_via, admitted_by, rule_id)
      VALUES ('papercusp-workspace', ${id}, ${member}, 'record', ${randomUUID()}, 'rule', 'fixture', ${rule!.id})`;
    const result = await loadPrDeliveryAuditPopulation('papercusp-workspace', [rule!.id], sql);
    expect(result).toMatchObject({ total: 1, missingRuleIds: [], rows: [{
      id, harness: member, ruleId: rule!.id, state, authority: 'committed', payload,
    }] });
    // A loose member hint may resolve only inside the requested workspace.
    expect(await loadPrDeliveryAuditPopulation('another-workspace', [rule!.id], sql))
      .toMatchObject({ total: 0, rows: [], missingRuleIds: [rule!.id] });
  });
  it('reports exact missing and foreign-workspace rule scope', async () => {
    const absent = randomUUID();
    expect(await loadPrDeliveryAuditPopulation('papercusp-workspace', [absent], sql))
      .toMatchObject({ total: 0, missingRuleIds: [absent] });
    expect(await loadPrDeliveryAuditPopulation('another-workspace', [directRule], sql))
      .toMatchObject({ total: 0, missingRuleIds: [directRule], rows: [] });
  });
});
