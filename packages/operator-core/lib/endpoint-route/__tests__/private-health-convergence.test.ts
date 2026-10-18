import { expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedIntegrationDiagnosticArtifacts } from '../../../test/isolated-integration-proof';
import { reloadPrivateHealthSnapshot, waitForPrivateHealthSnapshot, withPrivateBrowserWorkspaceHeader } from '../../../test/portal-roster-browser-fixture';
import { installWorkspaceHeaderFetch } from '../../transport-adapters/workspace-header-fetch';

function clock() {
  let time = 0;
  return { now: () => time, pause: async (ms: number) => { time += ms; }, timeoutMs: 2_000 };
}

it('places the production workspace transport bootstrap before the standalone panel entry', () => {
  const productEntry = 'createRoot(document.getElementById("root"));';
  const entry = withPrivateBrowserWorkspaceHeader(productEntry);
  expect(entry.indexOf('installWorkspaceHeaderFetch();')).toBeGreaterThanOrEqual(0);
  expect(entry.indexOf('installWorkspaceHeaderFetch();')).toBeLessThan(entry.indexOf(productEntry));
});

it('stamps the workspace selected by ?ws onto operator API fetches', async () => {
  const inner = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'));
  vi.stubGlobal('window', {
    location: { href: 'http://127.0.0.1:3070/?ws=byoc-a', origin: 'http://127.0.0.1:3070' },
    fetch: inner,
  });
  try {
    installWorkspaceHeaderFetch();
    await window.fetch('/api/zero-harness/rest-query?name=health.snapshot');
    const init = inner.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('x-papercusp-workspace')).toBe('byoc-a');
  } finally {
    vi.unstubAllGlobals();
  }
});

it('preserves the Health publication and HTTP evidence when a failed run is pruned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'health-diagnostics-'));
  const names = ['portal-health-reads.json', 'portal-health-writes.json', 'portal-health-seed.json',
    'portal-health-publication.json', 'portal-cloud-health-observations.json'];
  try {
    await mkdir(join(root, 'phases/execute'), { recursive: true });
    for (const name of names) await writeFile(join(root, 'phases/execute', name), '{}');
    const retained = isolatedIntegrationDiagnosticArtifacts(root);
    for (const name of names) expect(retained).toContain('phases/execute/' + name);
    expect(retained).not.toContain('phases/execute/worker.log');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('waits for the selected workspace collector generation after an older successful response', async () => {
  const bodies = [
    { rows: [{ workspaceId: 'byoc-a', generation: 1 }] },
    { rows: [{ workspaceId: 'byoc-b', generation: 2 }] },
    { rows: [{ workspaceId: 'byoc-a', generation: 2 }] },
  ];
  let reads = 0;
  const body = await waitForPrivateHealthSnapshot(async () => bodies[reads++], 'byoc-a', row => row.generation === 2, clock());
  expect(body).toEqual(bodies[2]);
  expect(reads).toBe(3);
});

it.each(['byoc-a', 'byoc-b'])('fails at the deadline when %s never supplies the expected selected reading', async workspaceId => {
  let reads = 0;
  await expect(waitForPrivateHealthSnapshot(async () => {
    reads++;
    return { rows: [{ workspaceId, generation: workspaceId === 'byoc-a' ? 1 : 2 }] };
  }, 'byoc-a', row => row.generation === 2, clock())).rejects.toThrow('did not converge');
  expect(reads).toBe(3);
});

it('propagates query failures instead of disguising them as stale generations', async () => {
  await expect(waitForPrivateHealthSnapshot(async () => { throw new Error('private query denied'); },
    'byoc-a', () => true, clock())).rejects.toThrow('private query denied');
});

it('retains every mismatched HTTP generation before a convergence timeout', async () => {
  const observed: unknown[] = [];
  let generation = 0;
  await expect(waitForPrivateHealthSnapshot(async () => ({ rows: [{ workspaceId: 'byoc-a', generation: ++generation }] }),
    'byoc-a', row => row.generation === 4, { ...clock(), observe: async body => { observed.push(body); } }))
    .rejects.toThrow('did not converge');
  expect(observed).toEqual([1, 2, 3].map(value => ({ rows: [{ workspaceId: 'byoc-a', generation: value }] })));
});

it('fails when generation evidence cannot be retained even if the query matches', async () => {
  const failure = new Error('evidence write failed');
  await expect(waitForPrivateHealthSnapshot(async () => ({ rows: [{ workspaceId: 'byoc-a', generation: 2 }] }),
    'byoc-a', row => row.generation === 2, { ...clock(), observe: () => { throw failure; } })).rejects.toBe(failure);
});

it('captures the Health response body before reload releases its network resource', async () => {
  const body = { rows: [{ workspaceId: 'byoc-a', generation: 2 }] };
  let released = false;
  let read = false;
  const response = { json: async () => {
    if (released) throw new Error('No resource with given identifier found');
    read = true;
    return body;
  } };
  let receive!: (value: typeof response) => void;
  let finishReload!: () => void;
  const page = {
    waitForResponse: () => new Promise<typeof response>(resolve => { receive = resolve; }),
    reload: async () => {
      receive(response);
      await new Promise<void>(resolve => { finishReload = resolve; });
      released = true;
    },
  } as unknown as Parameters<typeof reloadPrivateHealthSnapshot>[0];
  const pending = reloadPrivateHealthSnapshot(page);
  await Promise.resolve();
  const readBeforeReload = read;
  finishReload();
  expect(await pending).toEqual(body);
  expect(readBeforeReload).toBe(true);
});

it('preserves response body errors while reload is still pending', async () => {
  const failure = new Error('original response read failure');
  const page = {
    waitForResponse: async () => ({ json: async () => { throw failure; } }),
    reload: () => new Promise(() => {}),
  } as unknown as Parameters<typeof reloadPrivateHealthSnapshot>[0];
  await expect(reloadPrivateHealthSnapshot(page)).rejects.toBe(failure);
});
