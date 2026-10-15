/**
 * Private-runtime fixture for plan cupboard-distributable-integrations-2026-10-10, R-2 (AUTO-BAR-R-2-P-005):
 * "Connecting Slack, choosing the channels and the destination project, and arming the workflow can
 * all be completed on Settings → Integrations without a terminal, an admin request, or editing a file."
 *
 * Runs under `scripts/with-test-pg.mjs --isolated-runtime=operator-api` (private Postgres, HOME,
 * PAPERCUSP_HOME and XDG), bundles and boots a private operator host, then performs the whole setup
 * with exactly the requests Settings → Integrations sends (apps/operator/app/settings/integrations):
 * install a chat provider package and a trigger pack through the Cupboard install route, paste the
 * provider's credentials, list the channels and destination projects the connected provider offers,
 * set the pack up with a channel and a project, and arm it against the review fingerprint. Every
 * request is a /api/user/integrations or /api/cupboard route; no admin route, terminal step or
 * file edit takes part in the journey. The private database is then read directly as an oracle
 * independent of the route responses.
 *
 * The provider and pack are the committed test packages under test/fixtures/integrations-setup-*:
 * an unknown provider (not Slack) proves the page needs nothing provider-specific, and its daemon
 * answers fixed lists without network. The Cupboard install route clones github.com URLs; before the
 * host boots, this worker commits each fixture into a local repository and points the fixture owner
 * at it with a url.insteadOf in the private XDG_CONFIG_HOME. That is test hosting standing in for
 * GitHub, not a user step, and it never leaves the private runtime.
 *
 * Prints one INTEGRATIONS_SETUP_RECEIPT line on success; any assertion failure prints an
 * INTEGRATIONS_SETUP_FAILURE line and exits 1.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import postgres from 'postgres';
import { readProcessIdentity } from '../lib/process-identity';
import { buildPrivateOperatorApiBundle, privateBundleRuntimeEnv, waitForPrivateOperator } from './private-http-workspace-preflight';

const PROVIDER = 'integrations-setup-chat';
const PACK = 'integrations-setup-triage';
const FIXTURE_OWNER = 'https://github.com/integrations-setup-fixture/';
const REPOS = [
  { dir: PROVIDER, repo: 'provider' },
  { dir: PACK, repo: 'triage' },
] as const;
const GOOD_TOKEN = 'fxb-ABCDEFGH12';
const GOOD_SECRET = 'deadbeefdeadbeef00';
const BAD_TOKEN = 'not-a-token';
const CHANNEL = 'C-bugs';
const PROJECT = 'PRJ-bugs';

let host: ChildProcess | undefined;
let hostIdentity: ReturnType<typeof readProcessIdentity>;

async function stopHost() {
  if (!host) return;
  if (host.exitCode === null && host.signalCode === null) {
    const closed = new Promise<void>(done => host!.once('close', () => done()));
    host.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([closed, new Promise<void>(done => { timer = setTimeout(done, 5_000); })]);
    clearTimeout(timer);
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
    await closed;
  }
  assert.notEqual(readProcessIdentity(host.pid!), hostIdentity, 'private host survived cleanup');
}

interface Reply { status: number; body: any; text: string }

async function main() {
  const e = process.env;
  const workspace = e.PAPERCUSP_WORKSPACE_ID!;
  const base = e.PAPERCUSP_OPERATOR_URL!;
  assert.match(workspace, /^test-runtime-/);
  assert.equal(e.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.notEqual(e.PAPERCUSP_PG_PORT, '5432');
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(![3070, 3170, 3271].includes(Number(new URL(base).port)), 'must not target a shared operator');
  const privateHome = e.PAPERCUSP_HOME;
  assert.ok(privateHome && existsSync(privateHome), 'private PAPERCUSP_HOME required');
  // The git rewrite below lands in XDG_CONFIG_HOME; it must be this runtime's own directory.
  const runtimeRoot = dirname(e.HOME!);
  assert.ok(basename(runtimeRoot).startsWith('papercusp-test-runtime-'), 'private HOME required');
  assert.equal(e.XDG_CONFIG_HOME, join(runtimeRoot, 'xdg-config'), 'private XDG_CONFIG_HOME required');
  const root = resolve(import.meta.dirname, '../../..');
  const evidenceDir = e.INTEGRATIONS_SETUP_EVIDENCE_DIR!;
  assert.ok(evidenceDir, 'retained evidence directory required');

  // ── Test hosting: the committed fixtures served as the GitHub repos the Cupboard route clones.
  const hosted = join(runtimeRoot, 'fixture-repos');
  const git = (cwd: string, args: string[]) => execFileSync('git', ['-c', 'user.name=papercusp-test',
    '-c', 'user.email=papercusp-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  { cwd, env: e, encoding: 'utf8' });
  const fixtureFiles: Record<string, string> = {};
  for (const { dir, repo } of REPOS) {
    const source = join(root, 'packages/operator-core/test/fixtures', dir);
    const target = join(hosted, repo);
    mkdirSync(target, { recursive: true });
    cpSync(source, target, { recursive: true });
    for (const name of ['papercusp.json', ...(dir === PROVIDER ? ['daemon.mjs'] : ['plan.md'])]) {
      fixtureFiles[`${dir}/${name}`] = createHash('sha256').update(readFileSync(join(source, name))).digest('hex');
    }
    git(target, ['init', '-q', '-b', 'main']);
    git(target, ['add', '-A']);
    git(target, ['commit', '-q', '-m', `fixture ${dir}`]);
  }
  mkdirSync(join(e.XDG_CONFIG_HOME!, 'git'), { recursive: true });
  execFileSync('git', ['config', '--file', join(e.XDG_CONFIG_HOME!, 'git', 'config'),
    `url.file://${hosted}/.insteadOf`, FIXTURE_OWNER], { env: e });
  console.log('INTEGRATIONS_SETUP_PHASE fixtures-hosted');

  // ── Boot the private operator from the current source.
  console.log('INTEGRATIONS_SETUP_PHASE bundle-start');
  const { path: bundle } = await buildPrivateOperatorApiBundle(root, evidenceDir, { timeoutMs: 240_000, maxMs: 420_000 });
  const bundleBytes = readFileSync(bundle);
  for (const module of ['install-plugin-core.ts', 'provider-credentials.ts', 'provider-options.ts', 'trigger-pack-lifecycle.ts']) {
    assert.ok(bundleBytes.includes(Buffer.from(module)), `${module} must be in the executed bundle`);
  }
  const bundleSha256 = createHash('sha256').update(bundleBytes).digest('hex');

  const hostEnv = privateBundleRuntimeEnv(e);
  host = spawn(process.execPath, [bundle], { cwd: root, env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout!.on('data', chunk => process.stdout.write(chunk));
  host.stderr!.on('data', chunk => process.stderr.write(chunk));
  hostIdentity = readProcessIdentity(host.pid!);
  assert.ok(hostIdentity, 'private host kernel identity required');
  const headers = { 'content-type': 'application/json', origin: base, 'x-papercusp-workspace': workspace };
  const health = await waitForPrivateOperator({ host, base, headers, evidenceDir, hostIdentity, environment: hostEnv });
  console.log('INTEGRATIONS_SETUP_PHASE request-ready');

  // ── The journey. Every request goes through `call`, which admits only the routes the page uses.
  const routes: string[] = [];
  const call = async (method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<Reply> => {
    assert.match(path, /^\/api\/(user\/integrations|cupboard)\//, `the journey must stay on page routes: ${path}`);
    routes.push(`${method} ${path}`);
    const response = await fetch(base + path, { method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* the status still decides */ }
    return { status: response.status, body: parsed, text };
  };
  const ok = (reply: Reply, what: string) => {
    assert.equal(reply.status, 200, `${what}: HTTP ${reply.status} ${reply.text.slice(0, 1_500)}`);
    assert.notEqual(reply.body?.ok, false, `${what}: ${reply.text.slice(0, 1_500)}`);
    return reply.body;
  };
  const overview = async () => ok(await call('GET', '/api/user/integrations/tickets'), 'integrations overview');
  const credentialsPath = `/api/user/integrations/providers/${PROVIDER}/credentials`;

  const before = await overview();
  assert.ok(!(before.providers ?? []).some((p: any) => p.id === PROVIDER), 'fixture provider listed before its install');
  assert.ok(![...(before.triggerPacks ?? []), ...(before.availableTriggerPacks ?? [])]
    .some((p: any) => p.pluginName === PACK), 'fixture pack listed before its install');

  // 1. Install both packages from the Cupboard route (provider: review, then accept).
  const providerUrl = FIXTURE_OWNER + 'provider';
  const first = await call('POST', '/api/cupboard/install-plugin', { githubUrl: providerUrl }, 180_000);
  const review = first.body?.data?.review ?? first.body?.review ?? first.body?.error?.data?.review;
  assert.equal(first.status, 409, `an unaccepted provider install must stop at its review: ${first.text.slice(0, 1_500)}`);
  assert.equal(review?.provider?.id, PROVIDER, 'review names the provider');
  const providerInstall = ok(await call('POST', '/api/cupboard/install-plugin',
    { githubUrl: providerUrl, acceptCapabilities: true, expectedReview: review }, 180_000), 'provider install');
  const packInstall = ok(await call('POST', '/api/cupboard/install-plugin', { githubUrl: FIXTURE_OWNER + 'triage' }, 180_000),
    'pack install');
  assert.ok(packInstall.triggerPack, 'pack installed as a trigger pack');
  for (const [install, name] of [[providerInstall, PROVIDER], [packInstall, PACK]] as const) {
    assert.equal(install.name, name);
    const installedTo = realpathSync(install.installedTo);
    assert.ok(!relative(realpathSync(privateHome), installedTo).startsWith('..'), `${name} installed outside the private home`);
    assert.equal(JSON.parse(readFileSync(join(installedTo, 'papercusp.json'), 'utf8')).name, name);
  }
  console.log('INTEGRATIONS_SETUP_PHASE installed');

  // 2. The page shows the provider's card: app registration and its declared credentials, unset.
  const installed = await overview();
  const card = (installed.providers ?? []).find((p: any) => p.id === PROVIDER);
  assert.ok(card, 'installed provider has no card on the overview');
  assert.ok(String(card.appRegistration?.createUrl ?? '').startsWith('https://integrations-setup.example/apps/new?definition='),
    'Create app does not open the declared vendor page');
  assert.equal(JSON.parse(new URL(card.appRegistration.createUrl).searchParams.get('definition')!).name, 'Papercusp setup fixture');
  assert.deepEqual(card.credentials.map((c: any) => [c.key, c.configured]), [['bot_token', false], ['signing_secret', false]]);
  assert.ok((installed.availableTriggerPacks ?? []).some((p: any) => p.pluginName === PACK), 'pack is not offered for set-up');

  // 3. Connect: a malformed secret is refused and nothing is stored; valid values connect the provider.
  const refused = await call('PUT', credentialsPath, { values: { bot_token: BAD_TOKEN, signing_secret: GOOD_SECRET } });
  assert.ok(refused.status >= 400 && refused.status < 500, `malformed credential accepted: HTTP ${refused.status}`);
  assert.ok(!refused.text.includes(BAD_TOKEN), 'refusal echoes the rejected value');
  const afterRefusal = ok(await call('GET', credentialsPath), 'credentials read');
  assert.ok(afterRefusal.credentials.every((c: any) => c.configured === false), 'a refused save stored a value');
  ok(await call('PUT', credentialsPath, { values: { bot_token: GOOD_TOKEN, signing_secret: GOOD_SECRET } }), 'credentials save');
  const saved = await call('GET', credentialsPath);
  ok(saved, 'credentials read');
  assert.ok(saved.body.credentials.every((c: any) => c.configured === true), 'valid values were not saved');
  assert.ok(!saved.text.includes(GOOD_TOKEN) && !saved.text.includes(GOOD_SECRET), 'a stored value is read back');
  const connected = await overview();
  const sources = (connected.sources ?? []).filter((s: any) => s.provider === PROVIDER);
  assert.equal(sources.length, 1, 'saving the credentials did not connect one source');
  console.log('INTEGRATIONS_SETUP_PHASE connected');

  // 4. The pack's pickers are filled by the connected provider: channels and destination projects.
  const options = async (capability: string, args?: Record<string, unknown>) => {
    const result = ok(await call('POST', '/api/user/integrations/options', { capability, ...(args ? { args } : {}) }),
      `${capability} options`);
    const group = (result.groups ?? []).find((g: any) => g.provider === PROVIDER);
    assert.ok(group && group.error === null, `${capability}: no answer from the connected provider ${JSON.stringify(result).slice(0, 800)}`);
    assert.equal(group.sourceId, sources[0].id);
    return group.options.map((o: any) => o.value);
  };
  const channelChoices = await options('chat.channels');
  const projectChoices = await options('ticket.containers', { purpose: 'create' });
  assert.deepEqual(channelChoices, ['C-general', 'C-bugs']);
  assert.deepEqual(projectChoices, ['PRJ-roadmap', 'PRJ-bugs']);

  // 5. Set the pack up with a chosen channel and destination project, then arm it after review.
  const inputs = { channels: [CHANNEL], destination: PROJECT };
  const setUp = ok(await call('POST', '/api/user/integrations/trigger-packs/set-up',
    { pluginName: PACK, harnessSlug: workspace, inputs }), 'pack set-up');
  assert.equal(setUp.status, 'configured', `set-up left the pack ${setUp.status}: ${JSON.stringify(setUp.unmet)}`);
  assert.deepEqual(setUp.unmet, []);
  assert.equal(setUp.armed, false, 'set-up armed the pack without a review');
  const configured = await overview();
  const pack = (configured.triggerPacks ?? []).find((p: any) => p.pluginName === PACK);
  assert.ok(pack, 'set-up pack has no settings section');
  assert.equal(pack.installationId, setUp.installationId);
  assert.deepEqual(pack.inputs, inputs);
  assert.deepEqual(pack.state.review.unmet, []);
  assert.ok(pack.state.bindingCount >= 1 && pack.state.armedBindingCount === 0, 'pack bindings before arming');
  assert.ok(!(configured.availableTriggerPacks ?? []).some((p: any) => p.pluginName === PACK), 'pack still offered for set-up');
  const armed = ok(await call('POST', `/api/user/integrations/trigger-packs/${setUp.installationId}/arm`,
    { fingerprint: pack.state.fingerprint }), 'arm');
  assert.equal(armed.armedBindingIds?.length, pack.state.bindingCount, 'arm did not turn every trigger on');
  const after = await overview();
  const armedPack = after.triggerPacks.find((p: any) => p.installationId === setUp.installationId);
  assert.ok(armedPack.state.current && armedPack.state.armedBindingCount === armedPack.state.bindingCount, 'pack not reported armed');
  console.log('INTEGRATIONS_SETUP_PHASE armed');

  // 6. Independent oracle: the private database holds the connected source and the armed pack.
  const adminUrl = e.HARNESS_ADMIN_DATABASE_URL!;
  assert.equal(new URL(adminUrl).port, e.PAPERCUSP_PG_PORT, 'oracle must read the private database');
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  let oracle: Record<string, unknown>;
  try {
    const dataSources = await sql<Array<{ id: string; status: string }>>`
      SELECT id::text AS id, status FROM harness_shared.data_sources WHERE workspace_id = ${workspace} AND kind = ${PROVIDER}`;
    assert.deepEqual(dataSources.map(s => s.id), [sources[0].id], 'database source differs from the route');
    const [installation] = await sql<Array<{ id: string; status: string; harness_slug: string; inputs: unknown; reviewed_fingerprint: string | null }>>`
      SELECT id::text AS id, status, harness_slug, inputs, reviewed_fingerprint FROM harness_shared.trigger_pack_installations
       WHERE workspace_id = ${workspace} AND plugin_name = ${PACK}`;
    assert.equal(installation?.id, setUp.installationId);
    assert.equal(installation.status, 'configured');
    assert.equal(installation.harness_slug, workspace);
    assert.deepEqual(installation.inputs, inputs);
    assert.equal(installation.reviewed_fingerprint, pack.state.fingerprint);
    const bindings = await sql<Array<{ armed: boolean; source_id: string | null }>>`
      SELECT armed, source_id::text AS source_id FROM harness_shared.trigger_bindings
       WHERE workspace_id = ${workspace} AND pack_installation_id = ${installation.id}::uuid AND detached_at IS NULL`;
    assert.equal(bindings.length, pack.state.bindingCount);
    assert.ok(bindings.every(b => b.armed === true), 'a binding is not armed in the database');
    assert.ok(bindings.every(b => b.source_id === sources[0].id), 'a binding does not watch the connected source');
    oracle = { sourceStatus: dataSources[0].status, installationStatus: installation.status, armedBindings: bindings.length };
  } finally { await sql.end({ timeout: 5 }); }

  assert.ok(routes.every(r => !/\/admin\//.test(r)), 'an admin route took part in the journey');
  await stopHost();
  console.log('INTEGRATIONS_SETUP_RECEIPT ' + JSON.stringify({ workspace, hostPid: host.pid, hostStopped: true,
    bundleSha256, health, fixtureFiles, provider: PROVIDER, pack: PACK, installationId: setUp.installationId,
    channelChoices, projectChoices, inputs, armedBindingIds: armed.armedBindingIds, oracle,
    routes: [...new Set(routes.map(r => r.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, ':installationId')))] }));
}

try { await main(); }
catch (error) {
  const assertion = error as { message?: string; stack?: string; actual?: unknown; expected?: unknown };
  console.error('INTEGRATIONS_SETUP_FAILURE ' + JSON.stringify({ message: assertion.message ?? String(error),
    stack: assertion.stack, actual: assertion.actual, expected: assertion.expected }));
  process.exitCode = 1;
} finally {
  await stopHost();
}
