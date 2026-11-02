import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  resolveDevOperators,
  resolveReleaseOrigin,
  readStagingBuildIdentity,
  DEV_OPERATORS,
} from './dev-operators';
// Imported from the LAUNCHER on purpose: the readback's whole claim is that the two
// surfaces share one vocabulary, so the test branches with the launcher's own predicate.
import { defaultDetectSourceRootAsync, isTransientSkip } from './env-operator-launcher';

vi.mock('./env-operator-launcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./env-operator-launcher')>();
  return { ...actual, defaultDetectSourceRootAsync: vi.fn(actual.defaultDetectSourceRootAsync) };
});

function versionResponse(sha: string): Response {
  return new Response(JSON.stringify({ sidecarSha: sha }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('resolveDevOperators', () => {
  it('yields during source discovery and does not treat its pending promise as a source tree', async () => {
    let release!: (root: string | null) => void;
    const pending = new Promise<string | null>((resolve) => { release = resolve; });
    vi.mocked(defaultDetectSourceRootAsync).mockReturnValueOnce(pending);
    let finished = false;
    const result = resolveDevOperators({
      fetch: vi.fn(async () => versionResponse('aaaaaaaa')) as unknown as typeof fetch,
      selfPort: null,
      sourceArchivePending: false,
    }).then((value) => { finished = true; return value; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    release(null);
    const resolved = await result;
    expect(resolved.operators.some((op) => op.id === 'dev' || op.id === 'local')).toBe(false);
  });

  it('returns only the single immutable operator for vm-release', async () => {
    const fetchMock = vi.fn();
    const { operators, selfPort } = await resolveDevOperators({
      fetch: fetchMock as unknown as typeof fetch,
      selfPort: 45821,
      env: { PAPERCUSP_DISTRIBUTION_PROFILE: 'vm-release' },
    });
    expect(selfPort).toBe(45821);
    expect(operators).toEqual([
      expect.objectContaining({ id: 'release', port: 45821, isSelf: true, kind: 'release' }),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns one entry per canonical env PLUS a trailing release entry', async () => {
    const fetchMock = vi.fn(async () => versionResponse('aaaaaaaa'));
    const { operators } = await resolveDevOperators({
      fetch: fetchMock as unknown as typeof fetch,
      selfPort: null,
    });
    expect(operators).toHaveLength(DEV_OPERATORS.length + 1);
    const envOps = operators.filter((o) => o.kind === 'env');
    expect(envOps).toHaveLength(DEV_OPERATORS.length);
    for (const op of envOps) {
      expect(op.origin).toBe(`http://127.0.0.1:${op.port}`);
    }
    const release = operators.find((o) => o.kind === 'release');
    expect(release).toBeTruthy();
    expect(release!.id).toBe('release');
    // Dev-box fallback: release origin = the prod :3070 green-release origin.
    expect(release!.origin).toBe('http://127.0.0.1:3070');
  });

  it('marks the self port reachable WITHOUT probing it', async () => {
    const fetchMock = vi.fn(async (_url: string) => versionResponse('bbbbbbbb'));
    const { operators, selfPort } = await resolveDevOperators({
      fetch: fetchMock as unknown as typeof fetch,
      selfPort: 3270,
    });
    expect(selfPort).toBe(3270);
    const self = operators.find((o) => o.port === 3270)!;
    expect(self.isSelf).toBe(true);
    expect(self.reachable).toBe(true);
    // self (:3270) is never probed
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain(':3270/');
    }
  });

  it('reports reachable + sha for operators that answer /version', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes(':3070/')) return versionResponse('deadbeef');
      throw new Error('ECONNREFUSED');
    });
    const { operators } = await resolveDevOperators({
      fetch: fetchMock as unknown as typeof fetch,
      selfPort: null,
    });
    const prod = operators.find((o) => o.id === 'prod')!;
    expect(prod.reachable).toBe(true);
    expect(prod.sha).toBe('deadbeef');
    // release falls back to :3070 → also reachable here
    const release = operators.find((o) => o.kind === 'release')!;
    expect(release.reachable).toBe(true);
    // unreachable peers never throw out of resolve — just reachable:false
    const staging = operators.find((o) => o.id === 'staging')!;
    expect(staging.reachable).toBe(false);
    expect(staging.sha).toBeNull();
  });

  it('reflects disabledIds as enabled:false on those envs; release stays enabled', async () => {
    const fetchMock = vi.fn(async () => versionResponse('cccccccc'));
    const { operators } = await resolveDevOperators({
      fetch: fetchMock as unknown as typeof fetch,
      selfPort: null,
      disabledIds: ['staging', 'local'],
    });
    expect(operators.find((o) => o.id === 'staging')!.enabled).toBe(false);
    expect(operators.find((o) => o.id === 'local')!.enabled).toBe(false);
    expect(operators.find((o) => o.id === 'dev')!.enabled).toBe(true);
    expect(operators.find((o) => o.kind === 'release')!.enabled).toBe(true);
  });

  it('treats a non-ok or aborted probe as unreachable (never throws)', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 502 }));
    const { operators } = await resolveDevOperators({
      fetch: fetchMock as unknown as typeof fetch,
      selfPort: null,
      timeoutMs: 50,
    });
    expect(operators.every((o) => !o.reachable)).toBe(true);
  });
});

describe('source-tree-only env omission (WI-3284 / env-switcher-packaged-all-platforms-2026-07-06)', () => {
  it('omits dev + local entirely when no papercup source tree exists (packaged install)', async () => {
    const fetchMock = vi.fn(async () => versionResponse('dddddddd'));
    const { operators } = await resolveDevOperators({
      fetch: fetchMock as unknown as typeof fetch,
      selfPort: null,
      hasSourceTree: false,
    });
    const ids = operators.map((o) => o.id);
    expect(ids).not.toContain('dev');
    expect(ids).not.toContain('local');
    // prod/staging stay — the per-branch BUNDLED sidecars serve them.
    expect(ids).toContain('prod');
    expect(ids).toContain('staging');
    expect(ids).toContain('release');
  });

  it('keeps all four envs when the source tree is present (dev box)', async () => {
    const fetchMock = vi.fn(async () => versionResponse('eeeeeeee'));
    const { operators } = await resolveDevOperators({
      fetch: fetchMock as unknown as typeof fetch,
      selfPort: null,
      hasSourceTree: true,
    });
    const ids = operators.map((o) => o.id);
    for (const id of ['dev', 'prod', 'staging', 'local', 'release']) expect(ids).toContain(id);
  });

  it('DEFAULT detection counts a packaged install’s extracted tree (PAPERCUSP_DEV_SOURCE_ROOT) — WI-3307: local spawned but was omitted from the list', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { join, resolve } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const saved = process.env.PAPERCUSP_DEV_SOURCE_ROOT;
    const root = mkdtempSync(join(tmpdir(), 'pc-devops-extract-'));
    try {
      mkdirSync(join(root, 'apps', 'operator'), { recursive: true });
      mkdirSync(join(root, 'libs', 'papercusp'), { recursive: true });
      writeFileSync(join(root, 'apps', 'operator', 'package.json'), '{}');
      writeFileSync(join(root, 'libs', 'papercusp', 'package.json'), '{}');
      process.env.PAPERCUSP_DEV_SOURCE_ROOT = resolve(root);
      const fetchMock = vi.fn(async () => versionResponse('ffffffff'));
      // No hasSourceTree passed — exercises the default (launcher-shared) detection.
      const { operators } = await resolveDevOperators({
        fetch: fetchMock as unknown as typeof fetch,
        selfPort: null,
      });
      const ids = operators.map((o) => o.id);
      expect(ids).toContain('dev');
      expect(ids).toContain('local');
    } finally {
      if (saved === undefined) delete process.env.PAPERCUSP_DEV_SOURCE_ROOT;
      else process.env.PAPERCUSP_DEV_SOURCE_ROOT = saved;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('EI-19421499550693822: the source-tree axis is a READBACK, not an inference from absence', () => {
  const savedArchive = process.env.PAPERCUSP_SOURCE_ARCHIVE;
  afterEach(() => {
    if (savedArchive === undefined) delete process.env.PAPERCUSP_SOURCE_ARCHIVE;
    else process.env.PAPERCUSP_SOURCE_ARCHIVE = savedArchive;
  });

  it('NO TREE, NONE COMING: names dev+local as omitted with the TERMINAL reason', async () => {
    const fetchMock = vi.fn(async () => versionResponse('11111111'));
    const { operators, sourceTree, omitted } = await resolveDevOperators({
      fetch: fetchMock as unknown as typeof fetch,
      selfPort: null,
      hasSourceTree: false,
      sourceArchivePending: false,
    });
    // The omission itself is unchanged — this item added the readback, not a render.
    expect(operators.map((o) => o.id)).not.toContain('dev');
    expect(sourceTree).toEqual({ status: 'measured', present: false });
    expect(omitted).toEqual([
      { id: 'dev', reason: 'no-source-tree' },
      { id: 'local', reason: 'no-source-tree' },
    ]);
  });

  it('TREE STILL EXTRACTING: the same absence reports the TRANSIENT reason, and isTransientSkip separates them', async () => {
    const fetchMock = vi.fn(async () => versionResponse('22222222'));
    const { sourceTree, omitted } = await resolveDevOperators({
      fetch: fetchMock as unknown as typeof fetch,
      selfPort: null,
      hasSourceTree: false,
      sourceArchivePending: true,
    });
    expect(sourceTree).toEqual({ status: 'measured', present: false });
    expect(omitted).toEqual([
      { id: 'dev', reason: 'source-tree-pending' },
      { id: 'local', reason: 'source-tree-pending' },
    ]);
    // The WHOLE point of the split (EI-19442842364710969): a machine reader branches on
    // the launcher's own predicate, and the two reasons must genuinely disagree there.
    expect(isTransientSkip(omitted[0].reason)).toBe(true);
    expect(isTransientSkip('no-source-tree')).toBe(false);
  });

  it('TREE PRESENT: nothing is omitted, and the empty list is an assertion rather than a silence', async () => {
    const fetchMock = vi.fn(async () => versionResponse('33333333'));
    const { operators, sourceTree, omitted } = await resolveDevOperators({
      fetch: fetchMock as unknown as typeof fetch,
      selfPort: null,
      hasSourceTree: true,
    });
    expect(sourceTree).toEqual({ status: 'measured', present: true });
    expect(omitted).toEqual([]);
    expect(operators.map((o) => o.id)).toContain('dev');
  });

  it('VM-RELEASE: the axis is NOT_MEASURED (nothing probed the filesystem), and the dropped envs are still named', async () => {
    const fetchMock = vi.fn();
    const { sourceTree, omitted } = await resolveDevOperators({
      fetch: fetchMock as unknown as typeof fetch,
      selfPort: 45821,
      env: { PAPERCUSP_DISTRIBUTION_PROFILE: 'vm-release' },
    });
    // D-052: a boolean here would report a measurement this path never took.
    expect(sourceTree).toEqual({ status: 'not_measured', reason: 'vm-release-distribution' });
    expect(omitted.map((o) => o.id)).toEqual(DEV_OPERATORS.map((d) => d.id));
    for (const o of omitted) expect(o.reason).toBe('vm-release-distribution');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('DEFAULT pending detection is the launcher’s own (PAPERCUSP_SOURCE_ARCHIVE), and a missing archive still reads terminal', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'pc-devops-archive-'));
    try {
      const archive = join(dir, 'source.tar.zst');
      writeFileSync(archive, 'not-really-an-archive');
      const fetchMock = vi.fn(async () => versionResponse('44444444'));

      process.env.PAPERCUSP_SOURCE_ARCHIVE = archive;
      const pending = await resolveDevOperators({
        fetch: fetchMock as unknown as typeof fetch,
        selfPort: null,
        hasSourceTree: false,
        // No sourceArchivePending passed — exercises the default (launcher-shared) check.
      });
      expect(pending.omitted.map((o) => o.reason)).toEqual([
        'source-tree-pending',
        'source-tree-pending',
      ]);

      // Control: the SAME code path with no archive on disk reports the terminal reason,
      // so the assertion above is measuring the archive and not a constant.
      process.env.PAPERCUSP_SOURCE_ARCHIVE = join(dir, 'does-not-exist.tar.zst');
      const terminal = await resolveDevOperators({
        fetch: fetchMock as unknown as typeof fetch,
        selfPort: null,
        hasSourceTree: false,
      });
      expect(terminal.omitted.map((o) => o.reason)).toEqual(['no-source-tree', 'no-source-tree']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveReleaseOrigin (WI-3284: dead release button on packaged installs)', () => {
  const ENV_KEYS = ['PAPERCUSP_RELEASE_ORIGIN', 'PAPERCUSP_DESKTOP', 'PAPERCUSP_HONO_PORT', 'PORT'] as const;
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('an explicit PAPERCUSP_RELEASE_ORIGIN always wins', () => {
    process.env.PAPERCUSP_RELEASE_ORIGIN = 'http://127.0.0.1:9999/';
    process.env.PAPERCUSP_DESKTOP = '1';
    expect(resolveReleaseOrigin()).toBe('http://127.0.0.1:9999');
  });

  it('packaged desktop (PAPERCUSP_DESKTOP=1, dynamic port): falls back to SELF, not the nonexistent :3070', () => {
    delete process.env.PAPERCUSP_RELEASE_ORIGIN;
    process.env.PAPERCUSP_DESKTOP = '1';
    process.env.PAPERCUSP_HONO_PORT = '17174';
    expect(resolveReleaseOrigin()).toBe('http://127.0.0.1:17174');
  });

  it('dev box (no PAPERCUSP_DESKTOP): keeps the :3070 green-release fallback', () => {
    delete process.env.PAPERCUSP_RELEASE_ORIGIN;
    delete process.env.PAPERCUSP_DESKTOP;
    process.env.PAPERCUSP_HONO_PORT = '3170';
    expect(resolveReleaseOrigin()).toBe('http://127.0.0.1:3070');
  });

  it('packaged desktop with an undeterminable self port: still falls back to :3070 rather than a broken origin', () => {
    delete process.env.PAPERCUSP_RELEASE_ORIGIN;
    process.env.PAPERCUSP_DESKTOP = '1';
    delete process.env.PAPERCUSP_HONO_PORT;
    delete process.env.PORT;
    expect(resolveReleaseOrigin()).toBe('http://127.0.0.1:3070');
  });
});

describe('WI-40893 / D-052: readStagingBuildIdentity never renders absence as a build', () => {
  const okJson = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  it('MEASURED: reports the sha and the sidecar start time, from the staging port', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({ appVersion: '0.0.0', sidecarSha: 'e23facf5fe', sidecarStartedAtMs: 1787476682602 }),
    );

    const identity = await readStagingBuildIdentity({ doFetch: fetchMock as unknown as typeof fetch });

    expect(identity).toEqual({
      status: 'measured',
      sidecarSha: 'e23facf5fe',
      sidecarStartedAtMs: 1787476682602,
      origin: 'http://127.0.0.1:3170',
    });
    // Derived from the canonical descriptor, not a hardcoded port.
    const stagingPort = DEV_OPERATORS.find((d) => d.id === 'staging')?.port;
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://127.0.0.1:${stagingPort}/api/desktop/version`);
  });

  // THE CASE THIS WHOLE TYPE EXISTS FOR. `/api/desktop/version` emits the literal string
  // 'unknown' when build info carries no sha, so a bare typeof-string check accepts it as
  // an identity — which is precisely how unattributable evidence got recorded as attributed.
  it('SENTINEL: the literal "unknown" sha is not_measured, never a sidecarSha', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({ appVersion: '0.0.0', sidecarSha: 'unknown', sidecarStartedAtMs: 1787476682602 }),
    );

    const identity = await readStagingBuildIdentity({ doFetch: fetchMock as unknown as typeof fetch });

    expect(identity.status).toBe('not_measured');
    expect(identity.sidecarSha).toBeNull();
    if (identity.status === 'not_measured') expect(identity.reason).toBe('unknown-sentinel');
    // The string must not survive anywhere on the value — a caller serialising this into
    // evidence must not be able to find 'unknown' sitting in a sha-shaped field.
    expect(JSON.stringify(identity)).not.toContain('"sidecarSha":"unknown"');
  });

  it('UNREACHABLE: a refused connection is not_measured, not a null sha to be misread', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const identity = await readStagingBuildIdentity({ doFetch: fetchMock as unknown as typeof fetch });

    expect(identity.status).toBe('not_measured');
    if (identity.status === 'not_measured') expect(identity.reason).toBe('unreachable');
  });

  it('NON-JSON: a 200 with an unparseable body is not_measured, distinctly from unreachable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );

    const identity = await readStagingBuildIdentity({ doFetch: fetchMock as unknown as typeof fetch });

    expect(identity.status).toBe('not_measured');
    // Reached the server but learned no sha — a DIFFERENT remediation from unreachable,
    // which is why reason is an enum rather than a boolean.
    if (identity.status === 'not_measured') expect(identity.reason).toBe('no-sha-in-response');
  });

  it('an HTTP error status is not_measured, and never reports a stale sha', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 502 }));

    const identity = await readStagingBuildIdentity({ doFetch: fetchMock as unknown as typeof fetch });

    expect(identity.status).toBe('not_measured');
    expect(identity.sidecarSha).toBeNull();
    expect(identity.sidecarStartedAtMs).toBeNull();
  });

  // Calibration: without this, every assertion above would still pass if the function
  // simply always returned not_measured — the failure mode a "fails closed" guard invites.
  it('control: the measured and sentinel paths genuinely differ', async () => {
    const good = vi.fn().mockResolvedValue(okJson({ sidecarSha: 'abc1234def', sidecarStartedAtMs: 1 }));
    const bad = vi.fn().mockResolvedValue(okJson({ sidecarSha: 'unknown', sidecarStartedAtMs: 1 }));

    const measured = await readStagingBuildIdentity({ doFetch: good as unknown as typeof fetch });
    const notMeasured = await readStagingBuildIdentity({ doFetch: bad as unknown as typeof fetch });

    expect(measured.status).not.toBe(notMeasured.status);
    expect(measured.status).toBe('measured');
  });
});
