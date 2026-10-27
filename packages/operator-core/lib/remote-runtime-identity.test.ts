/**
 * remote-runtime-identity: environment fingerprints for live evidence whose runtime is a
 * remote managed resource (WI-6554700010011907). The describe call is injected; the default
 * gcloud reader is exercised live by the cloud-portal SPEC-P-004 binding, not here.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { hostname } from 'node:os';
import { readProcessIdentity } from './process-identity';
import { measureRuntimeVintageEnvironment, type RuntimeVintageRow } from './runtime-vintage';
import {
  isRemoteRuntimeUnit,
  measureRemoteRuntimeIdentity,
  measureRuntimeEnvironment,
  type RemoteDescribe,
} from './remote-runtime-identity';
const configured = vi.hoisted(() => ({ host: 'https://flags.example.test', projectKey: 'capture-key', personalApiKey: 'server-secret' }));
vi.mock('./posthog-config', () => ({ getPosthogConfigWithSource: () => ({ config: configured }) }));
afterEach(() => vi.unstubAllGlobals());

const UNIT = 'gcp-cloudsql:papercusp-cloud-prod/pc-cloud-prod-pg';

const instance = (over: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) => ({
  name: 'pc-cloud-prod-pg',
  project: 'papercusp-cloud-prod',
  selfLink: 'https://sqladmin.googleapis.com/sql/v1beta4/projects/papercusp-cloud-prod/instances/pc-cloud-prod-pg',
  createTime: '2026-10-14T03:25:36.604Z',
  databaseVersion: 'POSTGRES_18',
  maintenanceVersion: 'POSTGRES_18_6.R20260712.01_33',
  state: 'RUNNABLE',
  settings: { settingsVersion: '8', ipConfiguration: { sslMode: 'ENCRYPTED_ONLY' }, ...settings },
  ...over,
});

const describing = (doc: unknown): RemoteDescribe & { calls: string[][] } => {
  const calls: string[][] = [];
  const fn = (async (argv: readonly string[]) => {
    calls.push([...argv]);
    return typeof doc === 'string' || doc === null ? doc : JSON.stringify(doc);
  }) as RemoteDescribe & { calls: string[][] };
  fn.calls = calls;
  return fn;
};

describe('installed focused compiler identity', () => {
  const unit = 'focused-tsc:installed';
  const doc = { identity: { root: '/installed', compilerInstall: '/installed/compiler', compilerVersion: '1',
    serviceSourceSha256: 'a'.repeat(64), compilerArtifactsSha256: 'b'.repeat(64), projectConfigSha256: 'c'.repeat(64),
    namedSources: [{ path: 'scripts/tsc-service/server.mjs', sha256: 'd'.repeat(64) }] },
    runtime: { pid: process.pid, startedAt: 1 }, processIdentity: readProcessIdentity(process.pid) };
  it('independently remeasures source, compiler and process lifetime', async () => {
    const baseline = await measureRuntimeEnvironment([], [unit], { describe: describing(doc) });
    expect(baseline).toMatch(/^[a-f0-9]{64}$/);
    for (const identity of [{ ...doc.identity, serviceSourceSha256: 'e'.repeat(64) },
      { ...doc.identity, compilerArtifactsSha256: 'e'.repeat(64) }])
      expect(await measureRuntimeEnvironment([], [unit], { describe: describing({ ...doc, identity }) })).not.toBe(baseline);
    expect(await measureRuntimeEnvironment([], [unit], { describe: describing({ ...doc,
      runtime: { ...doc.runtime, startedAt: 2 } }) })).not.toBe(baseline);
  });
  it('refuses missing identity, a replaced PID and arbitrary installed selectors', async () => {
    for (const invalid of [null, {}, { ...doc, processIdentity: 'replaced' },
      { ...doc, identity: { ...doc.identity, compilerArtifactsSha256: null } }])
      expect(await measureRuntimeEnvironment([], [unit], { describe: describing(invalid) })).toBeNull();
    const reader = describing(doc);
    expect(await measureRemoteRuntimeIdentity('focused-tsc:/foreign/socket', reader)).toBeNull();
    expect(reader.calls).toEqual([]);
  });
});

describe('configured PostHog project identity', () => {
  const unit = 'posthog-project:flags.example.test/1';
  const project = { id: 1, uuid: 'project-uuid', organization: 'organization-uuid', created_at: '2026-07-09T00:00:00Z',
    event_retention_months: 84, events_retention_enforced: false, captureStatus: 400 };
  it('measures a stable identity and invalidates recreation or retention changes', async () => {
    const identity = await measureRemoteRuntimeIdentity(unit, describing(project));
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    for (const changed of [{ ...project, uuid: 'replacement' }, { ...project, created_at: '2026-10-14T00:00:00Z' },
      { ...project, events_retention_enforced: true }, { ...project, event_retention_months: 1 }]) {
      expect(await measureRemoteRuntimeIdentity(unit, describing(changed))).not.toBe(identity);
    }
  });
  it.each([null, {}, { ...project, id: 2 }, { ...project, captureStatus: 502 },
    { ...project, organization: null }, { ...project, created_at: 'invalid' }, { ...project, events_retention_enforced: null }])
    ('fails closed for unavailable or ambiguous project identity %j', async doc => {
      expect(await measureRemoteRuntimeIdentity(unit, describing(doc))).toBeNull();
    });
  it('uses the configured authenticated reader and keeps credentials out of the identity document', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/batch/')
      ? new Response('missing data', { status: 400 })
      : Response.json({ ...project, api_token: 'capture-key' }));
    vi.stubGlobal('fetch', fetcher);
    expect(await measureRemoteRuntimeIdentity(unit)).toMatch(/^[a-f0-9]{64}$/);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await measureRemoteRuntimeIdentity('posthog-project:foreign.example.test/1')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockImplementation(async () => Response.json({ ...project, api_token: 'another-key' }));
    expect(await measureRemoteRuntimeIdentity(unit)).toBeNull();
  });
  it('rejects malformed selectors before calling any reader', async () => {
    const d = describing(project);
    for (const invalid of ['posthog-project:--url=evil/1', 'posthog-project:flags.example.test/../1',
      'posthog-project:flags.example.test/0', 'posthog-project:flags.example.test/1?token=secret']) {
      expect(await measureRemoteRuntimeIdentity(invalid, d)).toBeNull();
    }
    expect(d.calls).toEqual([]);
  });
  it('folds project identity into the existing environment evaluator without a local PID', async () => {
    const measured = await measureRuntimeEnvironment([], [unit], { describe: describing(project) });
    expect(measured).toMatch(/^[a-f0-9]{64}$/);
    expect(await measureRuntimeEnvironment([], [unit], { describe: describing({ ...project, captureStatus: 502 }) })).toBeNull();
  });
});

describe('remote runtime units', () => {
  it('recognises provider-prefixed units only', () => {
    expect(isRemoteRuntimeUnit(UNIT)).toBe(true);
    expect(isRemoteRuntimeUnit('bg-host')).toBe(false);
    expect(isRemoteRuntimeUnit('postgres:5432')).toBe(false);
    expect(isRemoteRuntimeUnit('cloudsql:papercusp-cloud-prod/pc-cloud-prod-pg')).toBe(false);
  });

  it('reads the instance through a bounded describe and returns a stable digest', async () => {
    const d = describing(instance());
    const a = await measureRemoteRuntimeIdentity(UNIT, d);
    const b = await measureRemoteRuntimeIdentity(UNIT, describing(instance()));
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(b).toBe(a);
    expect(d.calls).toEqual([[
      'sql', 'instances', 'describe', 'pc-cloud-prod-pg', '--project=papercusp-cloud-prod', '--format=json', '--quiet',
    ]]);
  });

  it.each([
    ['a settings change (settingsVersion bump)', instance({}, { settingsVersion: '9' })],
    ['a recreated instance (new createTime)', instance({ createTime: '2026-10-15T00:00:00.000Z' })],
    ['a maintenance update (new maintenanceVersion)', instance({ maintenanceVersion: 'POSTGRES_18_7.R20260901.00_01' })],
    ['an engine upgrade (new databaseVersion)', instance({ databaseVersion: 'POSTGRES_19' })],
  ])('changes identity on %s, so bound proof goes stale', async (_name, changed) => {
    const before = await measureRemoteRuntimeIdentity(UNIT, describing(instance()));
    const after = await measureRemoteRuntimeIdentity(UNIT, describing(changed));
    expect(after).toMatch(/^[a-f0-9]{64}$/);
    expect(after).not.toBe(before);
  });

  it.each([
    ['the describe fails', null],
    ['the describe prints non-JSON', 'ERROR: (gcloud.sql.instances.describe) permission denied'],
    ['the describe prints a JSON array', '[]'],
    ['the instance is not RUNNABLE', instance({ state: 'SUSPENDED' })],
    ['the document names another instance', instance({ name: 'other-instance' })],
    ['the document names another project', instance({ project: 'other-project-1' })],
    ['settingsVersion is missing', instance({}, { settingsVersion: undefined })],
    ['createTime is missing', instance({ createTime: undefined })],
  ])('is unknown (null), never a pass, when %s', async (_name, doc) => {
    expect(await measureRemoteRuntimeIdentity(UNIT, describing(doc))).toBeNull();
  });

  it('is unknown when the describe throws', async () => {
    const throwing: RemoteDescribe = async () => { throw new Error('spawn gcloud ENOENT'); };
    expect(await measureRemoteRuntimeIdentity(UNIT, throwing)).toBeNull();
  });

  it.each([
    'gcp-cloudsql:--impersonate-service-account=x/pc',
    'gcp-cloudsql:papercusp-cloud-prod/--format=yaml',
    'gcp-cloudsql:papercusp-cloud-prod',
    'gcp-cloudsql:Papercusp-Cloud-Prod/pc-cloud-prod-pg',
    'gcp-cloudsql:papercusp-cloud-prod/pc-cloud-prod-pg/extra',
  ])('refuses malformed unit %s without calling describe', async (unit) => {
    const d = describing(instance());
    expect(await measureRemoteRuntimeIdentity(unit, d)).toBeNull();
    expect(d.calls).toEqual([]);
  });
});

describe('Cloudflare Pages production deployment identity (WI-6554700010015755)', () => {
  const account = 'f896982ea2f6d507e4f29eeecbd26e94';
  const unit = `cloudflare-pages:${account}/papercusp-com`;
  const deployment = (over: Record<string, unknown> = {}) => ({ id: 'dep-1', created_on: '2026-10-16T05:33:33Z',
    environment: 'production', commit_hash: '1072f004', stage: 'deploy', status: 'success', ...over });
  const doc = (over: Record<string, unknown> = {}, dep: Record<string, unknown> = {}) => ({ id: 'project-uuid',
    name: 'papercusp-com', created_on: '2026-07-12T15:47:22Z', deployment: deployment(dep), ...over });

  it('is a remote unit and measures a stable identity that a new production deployment invalidates', async () => {
    expect(isRemoteRuntimeUnit(unit)).toBe(true);
    const identity = await measureRemoteRuntimeIdentity(unit, describing(doc()));
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    expect(await measureRemoteRuntimeIdentity(unit, describing(doc()))).toBe(identity);
    for (const changed of [doc({}, { id: 'dep-2' }), doc({}, { created_on: '2026-10-17T00:00:00Z' }),
      doc({}, { commit_hash: 'ffffffff' }), doc({ id: 'recreated-project' }), doc({ created_on: '2026-10-01T00:00:00Z' })]) {
      expect(await measureRemoteRuntimeIdentity(unit, describing(changed))).not.toBe(identity);
    }
  });

  it.each([null, {}, doc({ name: 'another-project' }), doc({}, { environment: 'preview' }),
    doc({}, { status: 'failure' }), doc({}, { stage: 'build' }), doc({}, { id: null }), doc({ created_on: null })])
    ('fails closed for an unavailable, foreign or not-yet-serving deployment %j', async (d) => {
      expect(await measureRemoteRuntimeIdentity(unit, describing(d))).toBeNull();
    });

  it('rejects malformed selectors before calling any reader', async () => {
    const d = describing(doc());
    for (const invalid of ['cloudflare-pages:not-hex/papercusp-com', `cloudflare-pages:${account}/-bad`,
      `cloudflare-pages:${account}/a/../b`, `cloudflare-pages:${account}/papercusp-com?x=1`, `cloudflare-pages:${account}`]) {
      expect(await measureRemoteRuntimeIdentity(invalid, d)).toBeNull();
    }
    expect(d.calls).toEqual([]);
  });

  it('reads the project API with the server-side token and keeps it out of the identity document', async () => {
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'cf-server-secret');
    try {
      const api = { success: true, result: { id: 'project-uuid', name: 'papercusp-com', created_on: '2026-07-12T15:47:22Z',
        canonical_deployment: { id: 'dep-1', created_on: '2026-10-16T05:33:33Z', environment: 'production',
          deployment_trigger: { metadata: { commit_hash: '1072f004', commit_message: 'secret-ish message' } },
          latest_stage: { name: 'deploy', status: 'success', ended_on: '2026-10-16T05:33:35Z' } } } };
      const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(api));
      vi.stubGlobal('fetch', fetcher);
      const live = await measureRemoteRuntimeIdentity(unit);
      expect(live).toBe(await measureRemoteRuntimeIdentity(unit, describing(doc())));
      expect(String(fetcher.mock.calls[0]![0])).toBe(`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/papercusp-com`);
      expect(new Headers(fetcher.mock.calls[0]![1]!.headers).get('authorization')).toBe('Bearer cf-server-secret');
      fetcher.mockImplementation(async () => Response.json({ success: false, errors: [{ code: 9106 }] }, { status: 403 }));
      expect(await measureRemoteRuntimeIdentity(unit)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('measureRuntimeEnvironment', () => {
  const selfIdentity = readProcessIdentity(process.pid);
  const localRow: RuntimeVintageRow = {
    workspaceId: 'ws', unit: 'self', host: hostname(), treeSha: 'a'.repeat(40), buildTime: null,
    bundleVersion: null, pid: process.pid, extra: selfIdentity ? { kernelProcessIdentity: selfIdentity } : {},
    reportedAt: new Date(0).toISOString(),
  };

  it.skipIf(!selfIdentity)('keeps the exact local-only fingerprint, so existing bindings do not go stale', async () => {
    const local = measureRuntimeVintageEnvironment([localRow], ['self']);
    expect(local).toMatch(/^[a-f0-9]{64}$/);
    const d = describing(instance());
    expect(await measureRuntimeEnvironment([localRow], ['self'], { describe: d })).toBe(local);
    expect(d.calls).toEqual([]);
  });

  it('fingerprints a remote-only unit list without any runtime-vintage row', async () => {
    const fp = await measureRuntimeEnvironment([], [UNIT], { describe: describing(instance()) });
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
    expect(await measureRuntimeEnvironment([], [UNIT], { describe: describing(instance({}, { settingsVersion: '9' })) }))
      .not.toBe(fp);
  });

  it.skipIf(!selfIdentity)('folds local and remote units together and needs both', async () => {
    const both = await measureRuntimeEnvironment([localRow], ['self', UNIT], { describe: describing(instance()) });
    expect(both).toMatch(/^[a-f0-9]{64}$/);
    expect(both).not.toBe(await measureRuntimeEnvironment([], [UNIT], { describe: describing(instance()) }));
    expect(await measureRuntimeEnvironment([], ['self', UNIT], { describe: describing(instance()) })).toBeNull();
    expect(await measureRuntimeEnvironment([localRow], ['self', UNIT], { describe: describing(null) })).toBeNull();
  });

  it('rejects empty, duplicate and oversized unit lists like the local measurer', async () => {
    const d = describing(instance());
    expect(await measureRuntimeEnvironment([], [], { describe: d })).toBeNull();
    expect(await measureRuntimeEnvironment([], [UNIT, UNIT], { describe: d })).toBeNull();
    expect(await measureRuntimeEnvironment([], Array.from({ length: 33 }, (_, i) => `u${i}`), { describe: d })).toBeNull();
    expect(d.calls).toEqual([]);
  });

  it('reads each remote resource once per memo', async () => {
    const d = describing(instance());
    const memo = new Map<string, Promise<string | null>>();
    const first = await measureRuntimeEnvironment([], [UNIT], { describe: d, memo });
    const second = await measureRuntimeEnvironment([], [UNIT], { describe: d, memo });
    expect(second).toBe(first);
    expect(d.calls).toHaveLength(1);
  });
});
