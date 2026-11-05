/** Selected-edition sharing. Publication and removal require explicit actions. */
import { createHash, randomUUID } from 'node:crypto';
import { Octokit } from '@octokit/rest';
import { getGhAuthToken } from './identity/gh-token';
import { makeTimeoutFetch, resolveGithubTimeoutMs } from './identity/octokit-client';
import type { ReportRecord } from './report-library';
import { buildReportViewer, REPORT_VIEWER_MARKER, REPORT_VIEWER_REPO, type ReportViewerAssets } from './report-sharing-viewer';

export interface ReportShare {
  workspaceId: string; reportId: string; accountId: number; login: string;
  operationId: string; digest: string; phase: 'intent' | 'creating' | 'active' | 'removing' | 'removed';
  gistId?: string; repoId?: number; viewerVersion?: string;
}
export interface SharePersistence {
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
  prepareViewer(assets: ReportViewerAssets, expectedRepoId?: number): Promise<{ repoId: number; ready: boolean }>;
  find(operationId: string): Promise<string[]>;
  create(operationId: string, body: string): Promise<Gist>;
  gist(id: string): Promise<Gist | null>;
  remove(id: string): Promise<void>;
  readable(login: string, gistId: string, version: string, digest: string): Promise<boolean>;
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
  return deps.store.locked(JSON.stringify([report.workspaceId, report.reportId, user.id]), async store => {
    let share = await store.get(report.workspaceId, report.reportId, user.id);
    const inactive: ReportShareStatus = { phase: 'inactive', accountId: user.id, login: user.login };
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
    if (share?.phase === 'creating') {
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
    const viewer = await deps.github.prepareViewer(assets, share?.repoId);
    if (!share || share.phase === 'removed') {
      share = { workspaceId: report.workspaceId, reportId: report.reportId, accountId: user.id, login: user.login,
        operationId: randomUUID(), digest: digestOf(report.bodyMd), phase: 'intent' };
      await store.put(share);
    }
    if (share.digest !== digestOf(report.bodyMd)) throw new ReportSharingError('edition_changed', 'The saved edition no longer matches its snapshot.');
    if (share.phase === 'intent') {
      share = { ...share, phase: 'creating', repoId: viewer.repoId, viewerVersion: assets.version }; await store.put(share);
      // Failure keeps a durable recovery key. Never blindly repeat POST /gists.
      const gist = await deps.github.create(share.operationId, report.bodyMd);
      validate(gist); share = { ...share, gistId: gist.id, phase: 'active' }; await store.put(share);
    }
    const ready = viewer.ready && await deps.github.readable(user.login, share.gistId!, assets.version, share.digest);
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
  const owner = user.login;
  const repo = REPORT_VIEWER_REPO;
  const repoArgs = { owner, repo };
  return {
    async user() { return { id: user.id, login: owner }; },
    async prepareViewer(assets, expectedRepoId) {
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
      let prior: { kind: string; version: string; files?: Record<string, string> } | null = null;
      const marker = tree.tree.find(item => item.path === 'viewer.json');
      if (marker?.sha) {
        const blob = (await oc.git.getBlob({ ...repoArgs, file_sha: marker.sha })).data;
        try { prior = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8')); } catch { /* refused below */ }
      }
      const bootstrap = repository.description === REPORT_VIEWER_MARKER && tree.tree.every(item => item.path === 'README.md');
      if (!created && !bootstrap && prior?.kind !== REPORT_VIEWER_MARKER)
        throw new ReportSharingError('unrelated_repository', 'An unrelated papercusp-reports repository already exists. Rename it before sharing.');
      if (prior?.kind === REPORT_VIEWER_MARKER) {
        for (const entry of tree.tree) {
          if (entry.path === 'viewer.json') continue;
          if (!entry.path || !prior.files?.[entry.path] || prior.files[entry.path] !== entry.sha)
            throw new ReportSharingError('viewer_modified', 'The managed viewer was edited on GitHub. Restore it before upgrading.');
        }
      }
      if (prior?.version !== assets.version) {
        const entries = [];
        const hashes: Record<string, string> = {};
        for (const [path, content] of Object.entries(assets.files)) {
          if (path === 'viewer.json') continue;
          const blob = (await oc.git.createBlob({ ...repoArgs, content, encoding: 'utf-8' })).data;
          hashes[path] = blob.sha; entries.push({ path, mode: '100644' as const, type: 'blob' as const, sha: blob.sha });
        }
        const manifest = (await oc.git.createBlob({ ...repoArgs, content: JSON.stringify({ kind: REPORT_VIEWER_MARKER, version: assets.version, files: hashes }), encoding: 'utf-8' })).data;
        entries.push({ path: 'viewer.json', mode: '100644' as const, type: 'blob' as const, sha: manifest.sha });
        const next = (await oc.git.createTree({ ...repoArgs, tree: entries })).data;
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
      return { repoId: repository.id, ready: pages.status === 'built' };
    },
    async find(operationId) {
      const found: string[] = [];
      for (let page = 1; page <= 10; page++) {
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
      catch (error) { if (statusCode(error) === 404) return null; throw error; }
    },
    async remove(id) {
      try { await oc.gists.delete({ gist_id: id }); }
      catch (error) { if (statusCode(error) !== 404) throw error; }
    },
    async readable(login, gistId, version, digest) {
      const options: RequestInit = { credentials: 'omit', cache: 'no-store', referrerPolicy:'no-referrer', signal: AbortSignal.timeout(15_000) };
      try {
        const [html, raw] = await Promise.all([
          fetch('https://' + login.toLowerCase() + '.github.io/' + repo + '/?v=' + version, options),
          fetch('https://gist.githubusercontent.com/' + login + '/' + gistId + '/raw/report.md?read=' + randomUUID(), options),
        ]);
        return html.ok && raw.ok && new URL(html.url).hostname === login.toLowerCase()+'.github.io'
          && new URL(raw.url).hostname === 'gist.githubusercontent.com'
          && (await html.text()).includes('content="' + version + '"') && digestOf(await raw.text()) === digest;
      } catch { return false; }
    },
  };
}
