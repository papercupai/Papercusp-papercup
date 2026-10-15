/**
 * host-docs.test.ts — the `/internal/docs/*` gate.
 *
 * WI-2143103 / D-256. The engineering docs mount is 293MB of internal runbooks
 * and postmortems. On the desktop it is correctly loopback-gated. On a
 * `vm-release` customer workspace host that gate is not an identity boundary:
 * the customer holds an interactive SSH login on the same box the operator
 * binds 127.0.0.1 on, so their own `curl http://127.0.0.1:$PORT/internal/docs/...`
 * satisfies `isLoopbackHost` BY CONSTRUCTION. This file pins the refusal, pins
 * that the debug bypass cannot re-open it there, and pins that the desktop
 * behaviour is unchanged.
 *
 * These tests deliberately do NOT depend on a `Host` request header: the Fetch
 * spec makes `Host` a forbidden header name, so a header set on an
 * `app.request()` Request may be dropped and a host-dependent assertion would
 * be testing the test harness rather than the gate. `PAPERCUSP_INTERNAL_DOCS_BYPASS=1`
 * makes the loopback leg unconditionally true, which isolates the vm-release
 * leg cleanly. The host-dependent half is covered by the pure-predicate
 * falsifiability control at the bottom, which calls `isLoopbackHost` directly.
 *
 * Run: npm run test:file -- apps/operator/bin/host-docs.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLoopbackHost } from '@papercusp/operator-core/lib/endpoint-route/loopback-guard';
import { docsRoutes } from './host-docs';

const DOCS_URL = 'http://127.0.0.1:3070/internal/docs/agent-insights/derived-truth-ladder';

let savedProfile: string | undefined;
let savedBypass: string | undefined;

beforeEach(() => {
  savedProfile = process.env.PAPERCUSP_DISTRIBUTION_PROFILE;
  savedBypass = process.env.PAPERCUSP_INTERNAL_DOCS_BYPASS;
  delete process.env.PAPERCUSP_DISTRIBUTION_PROFILE;
  delete process.env.PAPERCUSP_INTERNAL_DOCS_BYPASS;
});

afterEach(() => {
  if (savedProfile === undefined) delete process.env.PAPERCUSP_DISTRIBUTION_PROFILE;
  else process.env.PAPERCUSP_DISTRIBUTION_PROFILE = savedProfile;
  if (savedBypass === undefined) delete process.env.PAPERCUSP_INTERNAL_DOCS_BYPASS;
  else process.env.PAPERCUSP_INTERNAL_DOCS_BYPASS = savedBypass;
});

describe('/internal/docs on a vm-release workspace host', () => {
  it('refuses the surface even for a request the loopback gate would admit', async () => {
    process.env.PAPERCUSP_DISTRIBUTION_PROFILE = 'vm-release';
    process.env.PAPERCUSP_INTERNAL_DOCS_BYPASS = '1';

    const res = await docsRoutes.request(DOCS_URL);

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('not served on a workspace host');
  });

  it('is checked BEFORE the debug bypass, so the bypass cannot re-open it', async () => {
    // The ordering is the point: PAPERCUSP_INTERNAL_DOCS_BYPASS is a debugging
    // affordance, and the failure mode it guards against is someone leaving it
    // set on an image. If the vm-release check ever moves below it, this fails.
    process.env.PAPERCUSP_DISTRIBUTION_PROFILE = 'vm-release';
    process.env.PAPERCUSP_INTERNAL_DOCS_BYPASS = '1';

    const res = await docsRoutes.request(DOCS_URL);
    const body = await res.text();

    expect(res.status).toBe(403);
    // Specifically NOT the loopback-only refusal — that one advertises the
    // bypass as the way in, which must never be the answer on a customer VM.
    expect(body).not.toContain('PAPERCUSP_INTERNAL_DOCS_BYPASS=1 to expose them');
  });

  it('refuses every path under the mount, not just the index', async () => {
    process.env.PAPERCUSP_DISTRIBUTION_PROFILE = 'vm-release';
    process.env.PAPERCUSP_INTERNAL_DOCS_BYPASS = '1';

    for (const path of [
      '/internal/docs',
      '/internal/docs/',
      '/internal/docs/llms-full.txt',
      '/internal/docs/agent-insights/some-runbook.html',
      '/internal/docs/_astro/style.css',
    ]) {
      const res = await docsRoutes.request(`http://127.0.0.1:3070${path}`);
      expect(res.status, path).toBe(403);
    }
  });
});

describe('/internal/docs off vm-release (desktop + dev) is unchanged', () => {
  // CALIBRATION. Without this, the assertions above would pass just as happily
  // against a gate that 403s unconditionally — which would be a broken product,
  // not a fixed one. This proves the refusal is caused by the vm-release leg.
  it('does NOT refuse when the distribution profile is not vm-release', async () => {
    process.env.PAPERCUSP_INTERNAL_DOCS_BYPASS = '1';

    const res = await docsRoutes.request(DOCS_URL);

    // 200 if the built docs happen to be present in this checkout, 404 if not.
    // Either is fine; the gate must simply not be what answers.
    expect(res.status).not.toBe(403);
  });

  it('still refuses a non-loopback request off vm-release (original gate intact)', async () => {
    // No bypass, and app.request() carries no usable Host header, so the
    // loopback leg is false — the pre-existing gate must still answer.
    const res = await docsRoutes.request(DOCS_URL);

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('loopback-only');
  });

  it('treats a non-vm-release profile as ordinary', async () => {
    process.env.PAPERCUSP_DISTRIBUTION_PROFILE = 'dogfood';
    process.env.PAPERCUSP_INTERNAL_DOCS_BYPASS = '1';

    const res = await docsRoutes.request(DOCS_URL);

    expect(res.status).not.toBe(403);
  });
});

describe('Docs documents embedded in the isolated native Quick Panel', () => {
  let fixtureRoot: string;
  let fixtureRoutes: typeof docsRoutes;

  beforeAll(async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'papercusp-host-docs-'));
    writeFileSync(join(fixtureRoot, 'search-palette.html'), '<html>Docs search</html>');
    writeFileSync(join(fixtureRoot, 'index.html'), '<html>Docs index</html>');
    writeFileSync(join(fixtureRoot, '404.html'), '<html>Not found</html>');
    const savedRoot = process.env.PAPERCUSP_DOCS_ROOT;
    process.env.PAPERCUSP_DOCS_ROOT = fixtureRoot;
    try {
      vi.resetModules();
      fixtureRoutes = (await import('./host-docs')).docsRoutes;
    } finally {
      if (savedRoot === undefined) delete process.env.PAPERCUSP_DOCS_ROOT;
      else process.env.PAPERCUSP_DOCS_ROOT = savedRoot;
    }
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it.each([
    ['/internal/docs/search-palette.html', 200, 'Docs search'],
    ['/internal/docs/search-palette', 200, 'Docs search'],
    ['/internal/docs/', 200, 'Docs index'],
    ['/internal/docs/missing', 404, 'Not found'],
  ])('serves %s with a compatible iframe embedder policy', async (path, status, body) => {
    process.env.PAPERCUSP_INTERNAL_DOCS_BYPASS = '1';
    const res = await fixtureRoutes.request(`http://127.0.0.1:16582${path}`);

    expect(res.status).toBe(status);
    expect(await res.text()).toContain(body);
    // An iframe navigation must have compatible COEP even when it is same-origin.
    // Without this, WebKit blocks Docs beneath the Quick Panel's require-corp policy.
    expect(res.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
  });
});

describe('falsifiability control — the pre-fix gate admitted the customer', () => {
  /**
   * The shipped predicate and the obvious wrong one, side by side on the same
   * fixture. `customerRequest` is the exact shape the finding describes: the
   * workspace SSH user running `curl http://127.0.0.1:$SERVICE_PORT/internal/docs/...`
   * from their own shell on the workspace host.
   *
   * Deliberately-wrong implementation, kept permanently as a control (it is the
   * code as it stood before this fix). If it ever stops admitting the customer,
   * the fixture has drifted and the tests above are passing vacuously.
   */
  const customerRequest = { host: '127.0.0.1:3070', bypass: false, vmRelease: true };

  const preFixGateAdmits = (r: typeof customerRequest): boolean =>
    isLoopbackHost(r.host) || r.bypass;

  const shippedGateAdmits = (r: typeof customerRequest): boolean =>
    !r.vmRelease && (isLoopbackHost(r.host) || r.bypass);

  it('the pre-fix predicate ADMITS the customer (this is the defect)', () => {
    expect(preFixGateAdmits(customerRequest)).toBe(true);
  });

  it('the shipped predicate REFUSES the same request', () => {
    expect(shippedGateAdmits(customerRequest)).toBe(false);
  });

  it('the shipped predicate still admits the same request off vm-release', () => {
    // Both predicates agree everywhere except on a vm-release host — the change
    // is surgical, not a blanket tightening of the desktop gate.
    const desktop = { ...customerRequest, vmRelease: false };
    expect(preFixGateAdmits(desktop)).toBe(true);
    expect(shippedGateAdmits(desktop)).toBe(true);
  });

  it('both predicates refuse an off-box host, on and off vm-release', () => {
    const offBox = { host: 'evil.example.com', bypass: false, vmRelease: false };
    expect(preFixGateAdmits(offBox)).toBe(false);
    expect(shippedGateAdmits(offBox)).toBe(false);
    expect(shippedGateAdmits({ ...offBox, vmRelease: true })).toBe(false);
  });
});

describe('packaged keyword search over the release-sanitized filesystem', () => {
  let packageRoot: string;
  let packagedRoutes: typeof docsRoutes;
  let docsRoot: string;
  let sourceRoot: string;

  beforeAll(async () => {
    packageRoot = mkdtempSync(join(tmpdir(), 'papercusp-packaged-docs-'));
    docsRoot = join(packageRoot, 'internal-docs');
    sourceRoot = join(packageRoot, 'apps/operator-docs/src/content/docs');
    mkdirSync(join(docsRoot, 'pagefind'), { recursive: true });
    mkdirSync(join(sourceRoot, 'build-system'), { recursive: true });
    mkdirSync(join(sourceRoot, 'guide'), { recursive: true });
    writeFileSync(join(sourceRoot, 'guide/shortcuts.mdx'),
      '---\ntitle: Shortcut settings\n---\nChoose Off to release the global accelerator.');
    writeFileSync(join(sourceRoot, 'build-system/private.mdx'),
      '---\ntitle: Forbidden corpus canary\n---\nprivatecorpuscanary');
    writeFileSync(join(docsRoot, 'pagefind/private.pf_meta'), 'privatecorpuscanary');
    writeFileSync(join(docsRoot, 'guide.html'), '<html>Shortcut settings</html>');
    // The package audit, rather than a test-maintained exclusion list, defines
    // which files survive. Search must keep working after its Pagefind prune.
    const prune = spawnSync('python3', [
      join(__dirname, '../../../papercusp-desktop/bin/audit-release-bundle.py'),
      '--prune-docs', docsRoot, sourceRoot,
    ], { encoding: 'utf8' });
    expect(prune.status, prune.stderr || prune.stdout).toBe(0);
    const savedRoot = process.env.PAPERCUSP_DOCS_ROOT;
    process.env.PAPERCUSP_DOCS_ROOT = docsRoot;
    try {
      vi.resetModules();
      packagedRoutes = (await import('./host-docs')).docsRoutes;
    } finally {
      if (savedRoot === undefined) delete process.env.PAPERCUSP_DOCS_ROOT;
      else process.env.PAPERCUSP_DOCS_ROOT = savedRoot;
    }
  });

  afterAll(() => rmSync(packageRoot, { recursive: true, force: true }));

  const query = (q: string) => packagedRoutes.request(
    `http://127.0.0.1:16582/internal/docs/search.json?q=${encodeURIComponent(q)}`,
  );

  it('returns real keyword hits without Pagefind shards or a database', async () => {
    process.env.PAPERCUSP_INTERNAL_DOCS_BYPASS = '1';
    expect(existsSync(join(docsRoot, 'pagefind/private.pf_meta'))).toBe(false);
    const res = await query('accelerator');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toMatchObject({
      hitCount: 1,
      hits: [{ title: 'Shortcut settings', url: '/internal/docs/guide/shortcuts',
        excerpt: expect.stringContaining('release the global accelerator') }],
    });
  });

  it('cannot refill the pruned corpus from the ambient engineering store', async () => {
    process.env.PAPERCUSP_INTERNAL_DOCS_BYPASS = '1';
    expect(existsSync(join(sourceRoot, 'build-system/private.mdx'))).toBe(false);
    expect(await (await query('privatecorpuscanary')).json()).toMatchObject({ hitCount: 0, hits: [] });
    // This doc exists in the monorepo, outside the selected sanitized package.
    expect(await (await query('derived-truth-ladder')).json()).toMatchObject({ hitCount: 0, hits: [] });
  });

  it('keeps both access guards on the search route, including the bypass refusal', async () => {
    expect((await query('accelerator')).status).toBe(403);
    process.env.PAPERCUSP_INTERNAL_DOCS_BYPASS = '1';
    process.env.PAPERCUSP_DISTRIBUTION_PROFILE = 'vm-release';
    expect((await query('accelerator')).status).toBe(403);
  });

  it('bounds query input and returns an empty result for blank input', async () => {
    process.env.PAPERCUSP_INTERNAL_DOCS_BYPASS = '1';
    expect((await query('x'.repeat(201))).status).toBe(400);
    expect(await (await query(' ')).json()).toMatchObject({ hitCount: 0, hits: [] });
  });
});
