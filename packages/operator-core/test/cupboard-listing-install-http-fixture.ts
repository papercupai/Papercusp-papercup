/**
 * Private-runtime fixture for plan cupboard-distributable-integrations-2026-10-10, SPEC-R-1-P-011:
 * "The Slack and bug-triage packages are listed in the Cupboard and can be installed from that
 * listing."
 *
 * Runs under `scripts/with-test-pg.mjs --isolated-runtime=operator-api`, which gives this process a
 * private Postgres, HOME, PAPERCUSP_HOME and XDG directories, so nothing installed here reaches the
 * operators that share this machine. It bundles and boots a private operator host, then installs
 * each package through POST /api/cupboard/install-plugin by its PUBLIC Cupboard listing id (the
 * request the Settings > Integrations install sends), with the review-then-accept two step. The
 * live dependencies are real: the hosted Cupboard resolves the listing, and the package is cloned
 * from its public GitHub mirror. No credentials are saved, so the Slack provider never dials Slack.
 *
 * Prints one CUPBOARD_LISTING_INSTALL_RECEIPT line on success; any assertion failure prints a
 * CUPBOARD_LISTING_INSTALL_FAILURE line and exits 1.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { readProcessIdentity } from '../lib/process-identity';
import { buildPrivateOperatorApiBundle, privateBundleRuntimeEnv, waitForPrivateOperator } from './private-http-workspace-preflight';

/** The public first-party listings P-011 published. */
const LISTINGS = [
  { name: 'slack', listingId: 'ccd90bf0-f04c-486d-93cd-2c84d8241efe',
    githubUrl: 'https://github.com/Papercusp/papercusp-slack', providerId: 'slack' },
  { name: '@papercupai/bug-triage', listingId: '508f85df-cb5a-4e92-9fdb-26c26eafd00f',
    githubUrl: 'https://github.com/Papercusp/papercusp-bug-triage', providerId: null },
] as const;

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

interface PostResult { status: number; body: any }

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
  const root = resolve(import.meta.dirname, '../../..');
  const evidenceDir = e.CUPBOARD_LISTING_INSTALL_EVIDENCE_DIR!;
  assert.ok(evidenceDir, 'retained evidence directory required');

  console.log('CUPBOARD_LISTING_INSTALL_PHASE bundle-start');
  const { path: bundle } = await buildPrivateOperatorApiBundle(root, evidenceDir, { timeoutMs: 240_000, maxMs: 420_000 });
  const bundleBytes = readFileSync(bundle);
  assert.ok(bundleBytes.includes(Buffer.from('install-plugin-core.ts')), 'install core must be in the executed bundle');
  const bundleSha256 = createHash('sha256').update(bundleBytes).digest('hex');

  const hostEnv = privateBundleRuntimeEnv(e);
  host = spawn(process.execPath, [bundle], { cwd: root, env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout!.on('data', chunk => process.stdout.write(chunk));
  host.stderr!.on('data', chunk => process.stderr.write(chunk));
  hostIdentity = readProcessIdentity(host.pid!);
  assert.ok(hostIdentity, 'private host kernel identity required');
  const headers = { 'content-type': 'application/json', origin: base, 'x-papercusp-workspace': workspace };
  const health = await waitForPrivateOperator({ host, base, headers, evidenceDir, hostIdentity, environment: hostEnv });
  console.log('CUPBOARD_LISTING_INSTALL_PHASE request-ready');

  const post = async (body: Record<string, unknown>): Promise<PostResult> => {
    const response = await fetch(base + '/api/cupboard/install-plugin', { method: 'POST', headers,
      body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  // What Settings → Integrations renders: GET /api/user/integrations/tickets (the same
  // ticketIntegrationsOverview the page's `integrations.tickets` sync query resolves). The
  // provider registry is built per request, so the SAME running host must list a package
  // right after its install, with no restart (R-1: "without an app update").
  const integrations = async () => {
    const response = await fetch(base + '/api/user/integrations/tickets', { headers, signal: AbortSignal.timeout(30_000) });
    const body = await response.json().catch(() => null) as any;
    assert.equal(response.status, 200, 'integrations overview: ' + JSON.stringify(body).slice(0, 1_500));
    const providerIds: string[] = (body?.providers ?? []).map((p: { id: string }) => p.id);
    const packNames: string[] = [...(body?.triggerPacks ?? []), ...(body?.availableTriggerPacks ?? [])]
      .map((p: { pluginName?: string; name?: string }) => p.pluginName ?? p.name ?? '');
    return { providerIds, packNames };
  };
  const visible = (view: { providerIds: string[]; packNames: string[] }, listing: (typeof LISTINGS)[number]) =>
    listing.providerId ? view.providerIds.includes(listing.providerId) : view.packNames.includes(listing.name);
  const before = await integrations();
  for (const listing of LISTINGS) {
    assert.equal(visible(before, listing), false, `${listing.name}: already on Settings → Integrations before its install`);
  }
  console.log('CUPBOARD_LISTING_INSTALL_PHASE integrations-before ' + JSON.stringify(before));

  const installs = [];
  for (const listing of LISTINGS) {
    const request = { listingId: listing.listingId };
    const first = await post(request);
    const review = first.body?.data?.review ?? first.body?.review;
    assert.ok(review, `${listing.name}: no install review from the listing (status ${first.status}): `
      + JSON.stringify(first.body).slice(0, 1_500));
    // Only a package that ships a provider (it reaches accounts and the network) stops at the
    // consent review; install-plugin-core refuses it with 409 until the caller pins that review.
    // A trigger pack with no provider installs on the first call.
    let second: PostResult | null = null;
    if (listing.providerId) {
      assert.equal(first.status, 409, `${listing.name}: an unaccepted provider install must stop at the review`);
      assert.equal(review.provider?.id, listing.providerId, `${listing.name}: review provider`);
      second = await post({ ...request, acceptCapabilities: true, expectedReview: review });
    } else {
      assert.equal(review.provider ?? null, null, `${listing.name}: a provider-free package reviewed a provider`);
    }
    const installed = second ?? first;
    assert.equal(installed.status, 200, `${listing.name}: install failed: ` + JSON.stringify(installed.body).slice(0, 1_500));
    const result = installed.body;
    assert.equal(result?.ok, true, `${listing.name}: install result not ok`);
    assert.equal(result.name, listing.name, `${listing.name}: installed package name`);
    // The request carried ONLY the listing id, so the storefront resolved the source: the
    // install came from the Cupboard listing, not from a caller-supplied URL. A signed
    // provenance receipt exists only for listings that pin a release (content hash or
    // commit+tree pin); when one is returned it must name this listing.
    assert.equal(result.source, listing.githubUrl, `${listing.name}: the listing resolved to a different source repo`);
    if (result.provenance) {
      assert.equal(result.provenance.listing?.listingId, listing.listingId, `${listing.name}: provenance listing id`);
    }
    // Independent of the response: the package landed inside the private home, with its manifest.
    const installedTo = realpathSync(result.installedTo);
    assert.ok(!relative(realpathSync(privateHome), installedTo).startsWith('..'),
      `${listing.name}: installed outside the private home (${installedTo})`);
    const manifest = JSON.parse(readFileSync(join(installedTo, 'papercusp.json'), 'utf8'));
    assert.equal(manifest.name, listing.name, `${listing.name}: installed manifest name`);
    assert.equal(manifest.distribution, 'cupboard', `${listing.name}: installed manifest distribution`);
    installs.push({ name: listing.name, listingId: listing.listingId, firstStatus: first.status,
      secondStatus: second?.status ?? null, version: result.version, source: result.source,
      provenance: result.provenance ? { contentSource: result.provenance.contentSource,
        contentFingerprint: result.provenance.contentFingerprint } : null,
      providerId: result.provider?.id ?? null, triggerPack: Boolean(result.triggerPack) });
    console.log('CUPBOARD_LISTING_INSTALL_PHASE installed ' + listing.name);
  }

  const after = await integrations();
  for (const listing of LISTINGS) {
    assert.equal(visible(after, listing), true, `${listing.name}: not on Settings → Integrations after its install `
      + JSON.stringify(after));
  }
  console.log('CUPBOARD_LISTING_INSTALL_PHASE integrations-after ' + JSON.stringify(after));

  await stopHost();
  console.log('CUPBOARD_LISTING_INSTALL_RECEIPT ' + JSON.stringify({ workspace, hostPid: host.pid,
    hostStopped: true, bundleSha256, health, installs, integrations: { before, after } }));
}

try { await main(); }
catch (error) {
  const assertion = error as { message?: string; stack?: string; actual?: unknown; expected?: unknown };
  console.error('CUPBOARD_LISTING_INSTALL_FAILURE ' + JSON.stringify({ message: assertion.message ?? String(error),
    stack: assertion.stack, actual: assertion.actual, expected: assertion.expected }));
  process.exitCode = 1;
} finally {
  await stopHost();
}
