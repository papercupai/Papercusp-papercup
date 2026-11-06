import { createHash } from 'node:crypto';
import { Octokit } from '@octokit/rest';
import { describe, expect, it } from 'vitest';
import { reportSharingGithubClient } from './report-sharing';
import { REPORT_VIEWER_MARKER, type ReportViewerAssets } from './report-sharing-viewer';

const id = 'a'.repeat(32);
const body = '# Harmless snapshot';
const digest = createHash('sha256').update(body).digest('hex');
const assets: ReportViewerAssets = { version: 'v1', files: { 'index.html': '<html>safe</html>', 'viewer.v1.js': 'safe()', 'viewer.v1.css': 'body{}', '.nojekyll': '', 'viewer.json': '{}' } };
const blobSha = (text: string) => createHash('sha1').update('blob ' + Buffer.byteLength(text) + '\0').update(text).digest('hex');
const fileHashes = Object.fromEntries(Object.entries(assets.files).filter(([name]) => name !== 'viewer.json').map(([name, text]) => [name, blobSha(text)]));
const manifest = JSON.stringify({ kind: REPORT_VIEWER_MARKER, version: assets.version, files: fileHashes });
const treeFiles = { ...fileHashes, 'viewer.json': blobSha(manifest) };
function fixture() {
  const state = {
    tree: Object.entries(treeFiles).map(([path, sha]) => ({ path, sha, type: 'blob', mode: '100644' })),
    requests: [] as { url: string; method: string }[], scopes: 'gist, repo', anonymousStatus: 200, authenticatedStatus: 200,
    snapshot: { id, public: false, owner: { id: 7, login: 'alice' }, files: { 'report.md': { content: body, truncated: false } } },
    deployedFiles: { ...assets.files }, pages: 1, treeSha: 'trusted-tree',
  };
  const response = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET'; state.requests.push({ url: url.href, method });
    if (url.hostname === 'alice.github.io') return new Response(state.deployedFiles[url.pathname.split('/').pop() || 'index.html'], { status: 200 });
    if (url.pathname === '/user') return response({ id: 7, login: 'alice' }, 200, { 'x-oauth-scopes': state.scopes });
    if (url.pathname === '/gists') {
      const page = Number(url.searchParams.get('page'));
      return response(page < state.pages ? Array.from({ length: 100 }, (_, n) => ({ id: String(n), description: 'unrelated', owner: { id: 7 } }))
        : [{ id, description: 'Papercusp report snapshot operation', owner: { id: 7 } }]);
    }
    if (url.pathname === '/gists/' + id) {
      if (url.searchParams.has('read')) return response(state.snapshot, state.anonymousStatus);
      return method === 'DELETE' ? response({ message: 'Not Found' }, 404) : response(state.snapshot, state.authenticatedStatus);
    }
    if (url.pathname === '/repos/alice/papercusp-reports') return response({ id: 9, owner: { id: 7 }, private: false, default_branch: 'main', description: REPORT_VIEWER_MARKER });
    if (decodeURIComponent(url.pathname).endsWith('/git/ref/heads/main')) return response({ object: { sha: 'head' } });
    if (url.pathname.endsWith('/git/trees/head')) return response({ sha: state.treeSha, truncated: false, tree: state.tree });
    if (method === 'POST' && url.pathname.endsWith('/git/blobs')) return response({sha:blobSha(JSON.parse(String(init?.body)).content)});
    if (method === 'POST' && url.pathname.endsWith('/git/trees')) return response({sha:'next-trusted-tree'});
    if (method === 'POST' && url.pathname.endsWith('/git/commits')) return response({sha:'next-commit'});
    if (method === 'PATCH' && decodeURIComponent(url.pathname).endsWith('/git/refs/heads/main')) return response({object:{sha:'next-commit'}});
    if (url.pathname.endsWith('/pages')) return response({ status: 'built', cname: null, source: { branch: 'main', path: '/' } });
    throw new Error('Unexpected provider call: ' + method + ' ' + url.href);
  };
  const github = reportSharingGithubClient(new Octokit({ auth: 'test-credential', request: { fetch: transport } }), { id: 7, login: 'alice' }, transport);
  return { state, github };
}

describe('owned GitHub sharing HTTP contract', () => {
  it('reuses the exact locally derived complete viewer tree without writing remote files', async () => {
    const f = fixture();
    expect(await f.github.prepareViewer(assets, 9)).toEqual({ repoId: 9, ready: true, treeSha: 'trusted-tree' });
    expect(f.state.requests.every(request => request.method === 'GET')).toBe(true);
  });
  it.each(['self-signed modification', 'missing asset', 'extra asset', 'symlink'])('refuses a %s even when the remote manifest claims the current version', async attack => {
    const f = fixture();
    if (attack === 'self-signed modification') {
      const script = f.state.tree.find(entry => entry.path.endsWith('.js'))!; script.sha = blobSha('exfiltrate()');
      f.state.tree.find(entry => entry.path === 'viewer.json')!.sha = blobSha(JSON.stringify({ kind: REPORT_VIEWER_MARKER, version: 'v1', files: { ...fileHashes, [script.path]: script.sha } }));
    } else if (attack === 'missing asset') f.state.tree.pop();
    else if (attack === 'extra asset') f.state.tree.push({ path: 'tracking.js', sha: blobSha('track()'), mode: '100644', type: 'blob' });
    else f.state.tree[0].mode = '120000';
    await expect(f.github.prepareViewer(assets, 9)).rejects.toMatchObject({ code: 'viewer_modified' });
    expect(f.state.requests.every(request => request.method === 'GET')).toBe(true);
  });
  it('does not stop reconciliation at the first thousand unrelated Gists', async () => {
    const f = fixture(); f.state.pages = 11;
    expect(await f.github.find('operation')).toEqual([id]);
    expect(f.state.requests.filter(request => new URL(request.url).pathname === '/gists')).toHaveLength(11);
  });
  it('upgrades a locally pinned previous tree and refuses a modified previous tree',async()=>{
    const f=fixture();f.state.tree[0].sha=blobSha('previous safe HTML');f.state.treeSha='previous-trusted-tree';
    expect(await f.github.prepareViewer(assets,9,'previous-trusted-tree')).toMatchObject({treeSha:'next-trusted-tree'});
    expect(f.state.requests.some(request=>request.method==='PATCH')).toBe(true);
    const modified=fixture();modified.state.tree[0].sha=blobSha('tampered HTML');modified.state.treeSha='different-tree';
    await expect(modified.github.prepareViewer(assets,9,'previous-trusted-tree')).rejects.toMatchObject({code:'viewer_modified'});
    expect(modified.state.requests.every(request=>request.method==='GET')).toBe(true);
  });
  it('proves readiness with canonical metadata and every locally built executable asset', async () => {
    const f = fixture(); expect(await f.github.readable('alice', id, 'v1', digest, assets)).toBe(true);
    expect(f.state.requests.some(request => request.url.includes('gist.githubusercontent.com'))).toBe(false);
    expect(f.state.requests.find(request => request.url.includes('/gists/'))!.url).toContain('?read=');
    f.state.deployedFiles['viewer.v1.js'] = 'exfiltrate()';
    expect(await f.github.readable('alice', id, 'v1', digest, assets)).toBe(false);
  });
  it.each(['deleted', 'public', 'wrong owner', 'truncated'])('refuses backend readiness for a %s canonical snapshot', async condition => {
    const f = fixture();
    if (condition === 'deleted') f.state.anonymousStatus = 404;
    if (condition === 'public') f.state.snapshot.public = true;
    if (condition === 'wrong owner') f.state.snapshot.owner.login = 'mallory';
    if (condition === 'truncated') f.state.snapshot.files['report.md'].truncated = true;
    expect(await f.github.readable('alice', id, 'v1', digest, assets)).toBe(false);
  });
  it('does not interpret credential-hidden 404 as deletion or a successfully stopped share', async () => {
    const f = fixture(); f.state.authenticatedStatus = 404;
    await expect(f.github.gist(id)).rejects.toMatchObject({ code: 'removal_unconfirmed' });
    await expect(f.github.remove(id)).rejects.toMatchObject({ code: 'removal_unconfirmed' });
    f.state.scopes = 'repo'; f.state.anonymousStatus = 404;
    await expect(f.github.remove(id)).rejects.toMatchObject({ code: 'gist_permission_required' });
    f.state.scopes = 'gist, repo';
    expect(await f.github.gist(id)).toBeNull();
    await expect(f.github.remove(id)).resolves.toBeUndefined();
  });
});
