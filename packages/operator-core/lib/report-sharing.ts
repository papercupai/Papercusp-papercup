/** Selected-edition sharing. Publication and removal require explicit actions. */
import { createHash, randomUUID } from 'node:crypto';
import { Octokit } from '@octokit/rest';
import { getGhAuthToken } from './identity/gh-token';
import { makeTimeoutFetch, resolveGithubTimeoutMs } from './identity/octokit-client';
import type { ReportRecord } from './report-library';
import { buildReportViewer, REPORT_VIEWER_MARKER, REPORT_VIEWER_REPO, type ReportViewerAssets } from './report-sharing-viewer';

export interface ReportShare {
  workspaceId: string; reportId: string; accountId: number; login: string;
  operationId: string; digest: string; phase: 'intent' | 'creating' | 'cancelling' | 'active' | 'removing' | 'removed';
  gistId?: string; repoId?: number; viewerVersion?: string; viewerTreeSha?: string;
}
export interface SharePersistence {
  list(workspaceId: string, reportId: string): Promise<ReportShare[]>;
  get(workspaceId: string, reportId: string, accountId: number): Promise<ReportShare | null>;
  put(share: ReportShare): Promise<void>;
}
export interface ReportShareStore {
  locked<T>(key: string, work: (store: SharePersistence) => Promise<T>): Promise<T>;
}
export interface ReportShareStatus {
  phase: 'inactive' | 'pending' | 'ready' | 'uncertain';
  accountId: number; login: string; url?: string; message?: string;
}
type Gist = { id: string; public: boolean; owner?: { id: number } | null; files?: Record<string, { content?: string; truncated?: boolean } | null> | null };
export interface SharingGithub {
  user(): Promise<{ id: number; login: string }>;
  prepareViewer(assets: ReportViewerAssets, expectedRepoId?: number, expectedTreeSha?: string): Promise<{ repoId: number; ready: boolean; treeSha?: string }>;
  find(operationId: string): Promise<string[]>;
  create(operationId: string, body: string): Promise<Gist>;
  gist(id: string): Promise<Gist | null>;
  remove(id: string): Promise<void>;
  readable(login: string, gistId: string, version: string, digest: string, assets: ReportViewerAssets): Promise<boolean>;
}
export class ReportSharingError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ReportSharingError'; }
}
const digestOf = (body: string) => createHash('sha256').update(body).digest('hex');
const statusCode = (error: unknown) => typeof error === 'object' && error !== null && 'status' in error ? error.status : null;
const description = (operationId: string) => 'Papercusp report snapshot ' + operationId;

export async function changeReportSharing(input: {
  report: ReportRecord; accountId: number; action: 'share' | 'stop' | 'status';
}, deps: { store: ReportShareStore; github: SharingGithub; assets?: () => Promise<ReportViewerAssets> }): Promise<ReportShareStatus> {
  const { report, accountId, action } = input;
  const user = await deps.github.user();
  if (user.id !== accountId) throw new ReportSharingError('account_changed', 'The selected GitHub account changed. Reload the report before sharing.');
  return deps.store.locked(JSON.stringify([report.workspaceId, report.reportId]), async store => {
    let share = await store.get(report.workspaceId, report.reportId, user.id);
    const inactive: ReportShareStatus = { phase: 'inactive', accountId: user.id, login: user.login };
    const others = (await store.list(report.workspaceId, report.reportId)).filter(row => row.accountId !== user.id && row.phase !== 'removed');
    if (others.length) {
      const message = 'This edition is already shared or has a pending publication in ' + others.map(row => row.login).join(', ') + "'s GitHub account. Switch back to that account to check or stop it.";
      if (action === 'status') return { ...inactive, phase: 'uncertain', message };
      throw new ReportSharingError('other_account_share', message);
    }
    if (action === 'status') {
      if (!share || share.phase === 'removed') return inactive;
      return { ...inactive, phase: 'pending', message: 'Check sharing to verify the saved snapshot and viewer readiness.' };
    }
    const assertOwned = (gist: Gist) => {
      if (gist.owner?.id !== user.id || gist.public !== false || !/^[a-f0-9]{32}$/i.test(gist.id) || (share?.gistId && gist.id !== share.gistId))
        throw new ReportSharingError('ownership_mismatch', 'The saved Gist is not a secret report owned by the selected GitHub account.');
    };
    const validate = (gist: Gist) => {
      assertOwned(gist);
      const file = gist.files?.['report.md'];
      if (!file || file.truncated || typeof file.content !== 'string' || digestOf(file.content) !== share!.digest)
        throw new ReportSharingError('snapshot_changed', 'The Gist was changed outside Papercusp. Stop sharing before publishing a new snapshot.');
    };
    if (share?.phase === 'cancelling' && action !== 'stop')
      throw new ReportSharingError('removal_pending', 'Cancellation is saved. Retry Stop sharing to reconcile the previous publication; no new Gist will be created.');
    if (share?.phase === 'creating' || share?.phase === 'cancelling') {
      if (action === 'stop') {
        share = { ...share, phase: 'cancelling' }; await store.put(share);
        const found = [...new Set(await deps.github.find(share.operationId))];
        if (!found.length) return { ...inactive, phase: 'uncertain', message: 'Cancellation is saved, but the previous GitHub request is still unconfirmed. No new Gist will be created. Retry Stop sharing shortly.' };
        // Validate the entire discovered population before deleting anything.
        for (const id of found) { const candidate = await deps.github.gist(id); if (candidate) validate(candidate); }
        for (const id of found) await deps.github.remove(id);
        await store.put({ ...share, phase: 'removed' }); return inactive;
      }
      const found = await deps.github.find(share.operationId);
      if (found.length !== 1) return { ...inactive, phase: 'uncertain', message: 'GitHub has not confirmed the previous publication. No new Gist was created. Retry to reconcile it.' };
      const recovered = await deps.github.gist(found[0]);
      if (!recovered) return { ...inactive, phase: 'uncertain', message: 'The previous publication is still unconfirmed. Retry shortly.' };
      validate(recovered); share = { ...share, gistId: recovered.id, phase: 'active' }; await store.put(share);
    }
    if (action === 'stop') {
      if (!share || share.phase === 'removed') return inactive;
      if (share.gistId) {
        const current = await deps.github.gist(share.gistId);
        if (current) assertOwned(current);
        share = { ...share, phase: 'removing' }; await store.put(share);
        if (current) await deps.github.remove(share.gistId!);
      }
      await store.put({ ...share, phase: 'removed' }); return inactive;
    }
    if (share?.phase === 'removing') throw new ReportSharingError('removal_pending', 'Removal is pending. Retry Stop sharing before sharing again.');
    if (share?.phase === 'active' && share.gistId) {
      const current = await deps.github.gist(share.gistId);
      if (!current) { await store.put({ ...share, phase: 'removed' }); return { ...inactive, message: 'This Gist was removed on GitHub. Share again to publish a new snapshot.' }; }
      validate(current);
    }
    const assets = await (deps.assets ?? buildReportViewer)();
    const viewer = await deps.github.prepareViewer(assets, share?.repoId, share?.viewerTreeSha);
    if (!share || share.phase === 'removed') {
      share = { workspaceId: report.workspaceId, reportId: report.reportId, accountId: user.id, login: user.login,
        operationId: randomUUID(), digest: digestOf(report.bodyMd), phase: 'intent' };
      await store.put(share);
    }
    if (share.digest !== digestOf(report.bodyMd)) throw new ReportSharingError('edition_changed', 'The saved edition no longer matches its snapshot.');
    if (share.phase === 'intent') {
      share = { ...share, phase: 'creating', repoId: viewer.repoId, viewerVersion: assets.version, viewerTreeSha: viewer.treeSha }; await store.put(share);
      // Failure keeps a durable recovery key. Never blindly repeat POST /gists.
      const gist = await deps.github.create(share.operationId, report.bodyMd);
      validate(gist); share = { ...share, gistId: gist.id, phase: 'active' }; await store.put(share);
    }
    if (share.viewerTreeSha !== viewer.treeSha || share.viewerVersion !== assets.version) {
      share = { ...share, repoId: viewer.repoId, viewerTreeSha: viewer.treeSha, viewerVersion: assets.version }; await store.put(share);
    }
    const ready = viewer.ready && await deps.github.readable(user.login, share.gistId!, assets.version, share.digest, assets);
    return { ...inactive, phase: ready ? 'ready' : 'pending', ...(ready
      ? { url: 'https://' + user.login.toLowerCase() + '.github.io/' + REPORT_VIEWER_REPO + '/?v=' + assets.version + '#' + new URLSearchParams({ gist: user.login + '/' + share.gistId }) }
      : { message: 'The secret snapshot is saved. GitHub Pages is preparing the reader. Check again shortly.' }) };
  });
}

/** Pin selected credentials for the entire operation; no active-account fallback. */
export async function reportSharingGithub(): Promise<SharingGithub> {
  const token = await getGhAuthToken();
  if (token.kind !== 'ok') throw new ReportSharingError('github_auth_required', 'Sign in to GitHub with Gist and repository/Pages permissions, then retry.');
  const oc = new Octokit({ auth: token.token, request: { fetch: makeTimeoutFetch(resolveGithubTimeoutMs()) },
    log: { debug() {}, info() {}, warn() {}, error() {} } });
  const { data: user } = await oc.users.getAuthenticated();
  return reportSharingGithubClient(oc, user);
}

/** Same adapter in production and HTTP-contract tests; credentials stay in Octokit. */
export function reportSharingGithubClient(oc: Octokit, user: { id: number; login: string }, request = fetch): SharingGithub {
  const owner = user.login;
  const repo = REPORT_VIEWER_REPO;
  const repoArgs = { owner, repo };
  const anonymousGist = (id: string) => request('https://api.github.com/gists/' + id + '?read=' + randomUUID(), {
    credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  const assertAbsent = async (id: string) => {
    // GitHub uses 404 for both absence and credential visibility loss. Require
    // the pinned token's capability AND a fresh anonymous canonical absence.
    const identity = await oc.users.getAuthenticated();
    if (identity.data.id !== user.id || !identity.headers['x-oauth-scopes']?.split(',').map(scope => scope.trim()).includes('gist'))
      throw new ReportSharingError('gist_permission_required', 'Gist access cannot be verified. Restore Gist permission for this GitHub account and retry Stop sharing.');
    const response = await anonymousGist(id);
    if (response.status !== 404) throw new ReportSharingError('removal_unconfirmed', 'GitHub has not confirmed removal. Restore Gist access and retry Stop sharing.');
  };
  return {
    async user() { return { id: user.id, login: owner }; },
    async prepareViewer(assets, expectedRepoId, expectedTreeSha) {
      let repository;
      let created = false;
      try { repository = (await oc.repos.get(repoArgs)).data; }
      catch (error) {
        if (statusCode(error) !== 404) throw error;
        repository = (await oc.repos.createForAuthenticatedUser({ name: repo, private: false, auto_init: true, description: REPORT_VIEWER_MARKER })).data;
        created = true;
      }
      if (repository.owner.id !== user.id || repository.private || (expectedRepoId && repository.id !== expectedRepoId)) throw new ReportSharingError('repository_mismatch', 'The viewer repository identity does not match the selected account and saved share.');
      const branch = repository.default_branch;
      const head = (await oc.git.getRef({ ...repoArgs, ref: 'heads/' + branch })).data.object.sha;
      const tree = (await oc.git.getTree({ ...repoArgs, tree_sha: head, recursive: '1' })).data;
      if (tree.truncated) throw new ReportSharingError('repository_too_large', 'The viewer repository is unexpectedly large.');
      const blobSha = (content: string) => createHash('sha1').update('blob ' + Buffer.byteLength(content) + '\0').update(content).digest('hex');
      const hashes = Object.fromEntries(Object.entries(assets.files).filter(([path]) => path !== 'viewer.json').map(([path, content]) => [path, blobSha(content)]));
      const manifest = JSON.stringify({ kind: REPORT_VIEWER_MARKER, version: assets.version, files: hashes });
      const expected = { ...hashes, 'viewer.json': blobSha(manifest) };
      const matches = tree.tree.length === Object.keys(expected).length && tree.tree.every(entry => entry.type === 'blob' && entry.mode === '100644'
        && !!entry.path && Object.hasOwn(expected, entry.path) && expected[entry.path as keyof typeof expected] === entry.sha);
      const bootstrap = repository.description === REPORT_VIEWER_MARKER && tree.tree.every(item => item.path === 'README.md');
      // A mutable remote manifest is never its own trust root. Recognize only
      // the complete locally built tree or a prior tree pinned in local state.
      if (!created && !bootstrap && !matches && (!expectedTreeSha || tree.sha !== expectedTreeSha))
        throw new ReportSharingError('viewer_modified', 'The viewer does not match the locally verified assets. Restore the dedicated viewer repository before sharing.');
      let treeSha = tree.sha;
      if (!matches) {
        const entries = [];
        for (const [path, content] of Object.entries(assets.files)) {
          if (path === 'viewer.json') continue;
          const blob = (await oc.git.createBlob({ ...repoArgs, content, encoding: 'utf-8' })).data;
          hashes[path] = blob.sha; entries.push({ path, mode: '100644' as const, type: 'blob' as const, sha: blob.sha });
        }
        const marker = (await oc.git.createBlob({ ...repoArgs, content: manifest, encoding: 'utf-8' })).data;
        entries.push({ path: 'viewer.json', mode: '100644' as const, type: 'blob' as const, sha: marker.sha });
        const next = (await oc.git.createTree({ ...repoArgs, tree: entries })).data;
        treeSha = next.sha;
        const commit = (await oc.git.createCommit({ ...repoArgs, message: 'Update reusable Papercusp report viewer', tree: next.sha, parents: [head] })).data;
        await oc.git.updateRef({ ...repoArgs, ref: 'heads/' + branch, sha: commit.sha, force: false });
      }
      let pages;
      try { pages = (await oc.repos.getPages(repoArgs)).data; }
      catch (error) {
        if (statusCode(error) !== 404) throw error;
        pages = (await oc.repos.createPagesSite({ ...repoArgs, source: { branch, path: '/' } })).data;
      }
      if (pages.cname || pages.source?.branch !== branch || pages.source?.path !== '/')
        throw new ReportSharingError('pages_mismatch', 'Restore the viewer Pages default branch and root source before sharing.');
      return { repoId: repository.id, ready: pages.status === 'built', treeSha };
    },
    async find(operationId) {
      const found: string[] = [];
      const deadline = Date.now() + 60_000;
      for (let page = 1; ; page++) {
        if (Date.now() >= deadline) throw new ReportSharingError('recovery_incomplete', 'GitHub reconciliation is incomplete. Retry; no new Gist will be created.');
        const { data } = await oc.gists.list({ per_page: 100, page });
        found.push(...data.filter(gist => gist.description === description(operationId) && gist.owner?.id === user.id).map(gist => gist.id));
        if (data.length < 100) break;
      }
      return found;
    },
    async create(operationId, body) {
      return (await oc.gists.create({ public: false, description: description(operationId), files: { 'report.md': { content: body } } })).data as Gist;
    },
    async gist(id) {
      try { return (await oc.gists.get({ gist_id: id })).data as Gist; }
      catch (error) { if (statusCode(error) === 404) { await assertAbsent(id); return null; } throw error; }
    },
    async remove(id) {
      try { await oc.gists.delete({ gist_id: id }); }
      catch (error) { if (statusCode(error) !== 404) throw error; }
      await assertAbsent(id);
    },
    async readable(login, gistId, version, digest, assets) {
      const options: RequestInit = { credentials: 'omit', cache: 'no-store', referrerPolicy:'no-referrer', redirect:'error', signal: AbortSignal.timeout(15_000) };
      try {
        const canonical = await anonymousGist(gistId);
        if (!canonical.ok || Number(canonical.headers.get('content-length')) > 2097152) return false;
        const payload = await canonical.text();
        if (Buffer.byteLength(payload) > 2097152) return false;
        const data = JSON.parse(payload);
        const file = data.files?.['report.md'];
        if (data.id !== gistId || data.public !== false || data.owner?.login?.toLowerCase() !== login.toLowerCase()
          || !file || file.truncated || typeof file.content !== 'string' || Buffer.byteLength(file.content) > 524288 || digestOf(file.content) !== digest) return false;
        // A built Pages status can still serve an older deployment. Verify every
        // executable asset against local bytes before offering its shared URL.
        const origin = 'https://' + login.toLowerCase() + '.github.io/' + repo + '/';
        const checks = await Promise.all(Object.entries(assets.files).filter(([path]) => path === 'index.html' || /\.(?:js|css)$/.test(path)).map(async ([path, content]) => {
          const response = await request(origin + (path === 'index.html' ? '' : path) + '?v=' + version + '&read=' + randomUUID(), options);
          return response.ok && await response.text() === content;
        }));
        return checks.length >= 3 && checks.every(Boolean);
      } catch { return false; }
    },
  };
}
