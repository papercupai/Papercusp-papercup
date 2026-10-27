/** Disposable real-SQLite catalog behind the maintained Cupboard listings route. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';

/**
 * The slice of apps/operator-public this fixture drives. Those sources compile
 * only under @cloudflare/workers-types (operator-public's own tsconfig, gated
 * by lint:tsc:workspaces). A STATIC import here drags them into operator-core's
 * node-only program, where KVNamespace / D1Database do not exist — that held
 * green-checkpoint candidate 70e89c73 red (WI-10006055). Adding the Workers
 * types to operator-core instead would collide with Node's fetch/Request
 * globals, so the boundary is a runtime load: non-literal specifiers are not
 * followed by tsc, and vitest resolves them relative to this file.
 */
interface OperatorPublicCatalog {
  makeSqliteDb(): {
    db: unknown;
    raw: { prepare(sql: string): { all(): unknown[]; run(...values: never[]): unknown }; close(): void };
  };
  makeEnv(overrides: { DB: unknown }): { env: unknown };
  makeListingRow(overrides: Record<string, unknown>): Record<string, unknown>;
  listingsRoute(): { fetch(request: Request, env: unknown): Promise<Response> };
}

async function loadOperatorPublicCatalog(): Promise<OperatorPublicCatalog> {
  const src = '../../../apps/operator-public/src/';
  // Resolve to an absolute file URL against THIS file: vitest resolves a bare
  // relative non-literal specifier against the server root ('/apps/…', not found).
  const load = (path: string) =>
    import(new URL(`${src}${path}.ts`, import.meta.url).href) as Promise<Partial<OperatorPublicCatalog>>;
  const [sqlite, fake, listings] = await Promise.all([
    load('__tests__/sqlite-d1'), load('__tests__/fake-d1'), load('routes/listings'),
  ]);
  const surface = {
    makeSqliteDb: sqlite.makeSqliteDb, makeEnv: fake.makeEnv,
    makeListingRow: fake.makeListingRow, listingsRoute: listings.listingsRoute,
  };
  for (const [name, fn] of Object.entries(surface)) {
    assert.equal(typeof fn, 'function', `apps/operator-public no longer exports ${name}`);
  }
  return surface as OperatorPublicCatalog;
}

export async function startPrivateCupboardCatalog(evidence: string) {
  const { makeSqliteDb, makeEnv, makeListingRow, listingsRoute } = await loadOperatorPublicCatalog();
  const { db, raw } = makeSqliteDb();
  const { env } = makeEnv({ DB: db });
  const marker = `private-cupboard-${process.pid}`;
  const selectedTitle = marker + ' pack', neighborTitle = marker + ' plugin', hiddenTitle = marker + ' private';
  const columns = new Set((raw.prepare('PRAGMA table_info(harnesses)').all() as Array<{ name: string }>).map(row => row.name));
  for (const [id, title, kind, visibility] of [
    [marker + '-selected', selectedTitle, 'pack', 'public'],
    [marker + '-neighbor', neighborTitle, 'plugin', 'public'],
    [marker + '-hidden', hiddenTitle, 'pack', 'private'],
  ]) {
    const row = Object.entries(makeListingRow({ id, title, listing_kind: kind, visibility, review_status: 'approved',
      claim_status: 'unclaimed', github_repository_id: id === marker + '-selected' ? 901 : id === marker + '-neighbor' ? 902 : 903,
      github_name: id, description: 'Disposable catalog acceptance input' })).filter(([key]) => columns.has(key));
    raw.prepare(`INSERT INTO harnesses (${row.map(([key]) => key).join(',')}) VALUES (${row.map(() => '?').join(',')})`)
      .run(...row.map(([, value]) => value as never));
  }
  const api = listingsRoute();
  const observations: Array<{ url: string; status: number; body: string }> = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'GET', 'private catalog must never publish, claim or install');
      const url = new URL(request.url!, 'http://private-cupboard.invalid');
      assert.equal(url.pathname, '/listings');
      const result = await api.fetch(new Request(url), env);
      const body = await result.text();
      observations.push({ url: url.href, status: result.status, body });
      writeFileSync(join(evidence, 'portal-cupboard-upstream.json'), JSON.stringify(observations, null, 2));
      response.writeHead(result.status, { 'content-type': 'application/json' }); response.end(body);
    } catch (error) { response.writeHead(503); response.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const initial = await fetch(base + '/listings?limit=100');
    const body = await initial.json() as { results: Array<{ title: string }> };
    assert.equal(initial.status, 200);
    assert.deepEqual(body.results.map(row => row.title).sort(), [selectedTitle, neighborTitle].sort());
  } catch (error) {
    await new Promise<void>(done => server.close(() => done())); raw.close(); throw error;
  }
  return { base, marker, selectedTitle, neighborTitle, hiddenTitle,
    close: async () => { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); raw.close(); } };
}

export async function runPrivateCupboardPage(page: Page, context: BrowserContext, input: {
  evidence: string; workspace: string; selected: string;
  cupboardSeed: { marker: string; selectedTitle: string; neighborTitle: string; hiddenTitle: string };
}, url: URL) {
  const seed = input.cupboardSeed;
  url.searchParams.set('slug', input.selected);
  url.searchParams.set('q', seed.marker);
  const reads: Array<{ url: string; status: number; body: string }> = [], writes: string[] = [];
  const captures = new Set<Promise<void>>();
  let denied = false;
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET') writes.push(request.url()); });
  page.on('response', response => {
    if (new URL(response.url()).pathname !== '/api/cupboard/listings') return;
    const capture = response.text().then(body => {
      reads.push({ url: response.url(), status: response.status(), body });
      writeFileSync(join(input.evidence, 'portal-cupboard-reads.json'), JSON.stringify(reads, null, 2));
    });
    captures.add(capture); void capture.catch(() => {});
    void capture.then(() => captures.delete(capture), () => captures.delete(capture));
  });
  await context.route('**/api/cupboard/listings?*', async route => {
    if (!denied) { await route.continue(); return; }
    const response = await context.request.get(route.request().url(), { headers: { host: 'foreign-cupboard.invalid' } });
    assert.equal(response.status(), 403);
    assert.equal((await response.json()).error.code, 'host_not_allowed');
    await route.fulfill({ response });
  });
  await page.goto(url.href);
  await page.getByText(seed.selectedTitle, { exact: true }).waitFor();
  await page.getByText(seed.neighborTitle, { exact: true }).waitFor();
  assert.equal(await page.getByText(seed.hiddenTitle, { exact: true }).count(), 0);
  const packs = page.getByRole('button', { name: /^Packs\b/ });
  await packs.focus(); await page.keyboard.press('Enter');
  await page.getByRole('textbox').fill(seed.marker);
  const unclaimed = page.getByRole('button', { name: 'unclaimed', exact: true });
  await unclaimed.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(marker => new URL(location.href).searchParams.get('q') === marker
    && new URL(location.href).searchParams.get('kind') === 'pack'
    && new URL(location.href).searchParams.get('claim') === 'unclaimed', seed.marker);
  const assertScope = () => {
    const params = new URL(page.url()).searchParams;
    for (const [key, value] of Object.entries({ app: 'cupboard', ws: input.workspace, slug: input.selected,
      q: seed.marker, kind: 'pack', claim: 'unclaimed' })) assert.equal(params.get(key), value);
  };
  await page.getByText(seed.selectedTitle, { exact: true }).waitFor();
  assert.equal(await page.getByText(seed.neighborTitle, { exact: true }).count(), 0);
  assertScope(); await page.reload(); await page.getByText(seed.selectedTitle, { exact: true }).waitFor(); assertScope();
  denied = true;
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  await refresh.focus(); await page.keyboard.press('Enter');
  await page.getByTestId('cupboard-error-state').getByText("Couldn't load listings (HTTP 403).", { exact: true }).waitFor();
  assert.equal(await page.getByText(seed.selectedTitle, { exact: true }).count(), 0);
  assertScope(); await page.reload(); await page.getByTestId('cupboard-error-state').waitFor(); assertScope();
  denied = false;
  await page.getByTestId('cupboard-error-retry').focus(); await page.keyboard.press('Enter');
  await page.getByText(seed.selectedTitle, { exact: true }).waitFor(); assertScope();
  await Promise.all([...captures]);
  assert.ok(reads.filter(read => read.status === 403).length >= 2);
  const filtered = reads.filter(read => read.status === 200 && new URL(read.url).searchParams.get('kind') === 'pack'
    && new URL(read.url).searchParams.get('q') === seed.marker && new URL(read.url).searchParams.get('claim') === 'unclaimed');
  assert.ok(filtered.length >= 2, 'real filtered reads must survive reload and retry');
  for (const read of filtered) assert.deepEqual(JSON.parse(read.body).listings.map((row: { title: string }) => row.title), [seed.selectedTitle]);
  assert.deepEqual(writes, []);
  return { workspace: input.workspace, privateSqliteCatalog: true, publicOperatorProxy: true, keyboardFilters: true,
    filterReload: true, warmHostDenialRecovery: true, coldHostDenialRecovery: true, hiddenListingExcluded: true, writes,
    scope: 'Actual Cupboard page and public proxy with maintained worker listings handler on migrated private SQLite; seeded catalog and test KV, actual Host denials. No workerd, production Cupboard, hosted tenant, install or shipment proof.' };
}
