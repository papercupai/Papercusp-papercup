import { describe, expect, it, vi } from 'vitest';
import {
  PAPERCUSP_HOSTED_HOST_PERMISSIONS,
  PAPERCUSP_HOSTED_HOST_ROLE_ID,
  PAPERCUSP_HOSTED_OBSERVER_PERMISSIONS,
  PAPERCUSP_HOSTED_OBSERVER_ROLE_ID,
} from './hosted-gcp-hosting';
import {
  PAPERCUSP_HOSTED_ROLE_SPECS,
  papercuspHostedRoleAttestationSummary,
  papercuspHostedRoleAttestationUnreadableKey,
  papercuspHostedRoleDrift,
  papercuspHostedRoleDrifted,
  papercuspHostedRoleRepairCommand,
  papercuspHostedRoleWatchdogKey,
  reconcilePapercuspHostedRoles,
  runPapercuspHostedRoleAttestation,
  type PapercuspHostedRoleAttestationRuntime,
  type PapercuspHostedRoleFinding,
} from './hosted-gcp-roles';

const PROJECT = 'papercusp-hosted-workspaces';
const HOST = PAPERCUSP_HOSTED_HOST_ROLE_ID;
const OBSERVER = PAPERCUSP_HOSTED_OBSERVER_ROLE_ID;

interface FakeRole {
  includedPermissions: string[];
  etag: string;
  deleted?: boolean;
  title?: string;
}

/** An in-memory IAM custom-roles API: GET, PATCH (etag-checked), POST create, POST :undelete. */
function fakeIam(initial: Record<string, FakeRole | undefined>, options: { staleWritesBeforeSuccess?: number; status?: number } = {}) {
  const roles = new Map<string, FakeRole>(Object.entries(initial).filter((entry): entry is [string, FakeRole] => !!entry[1]));
  const writes: { method: string; roleId: string; body: unknown }[] = [];
  let staleWrites = options.staleWritesBeforeSuccess ?? 0;
  let version = 0;
  const nextEtag = () => `etag-${(version += 1)}`;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (options.status) return new Response('{"error":"denied"}', { status: options.status });
    const match = /\/v1\/projects\/([^/]+)\/roles(?:\/([^/:?]+))?(:undelete)?$/.exec(url.pathname);
    if (!match || decodeURIComponent(match[1]!) !== PROJECT) return new Response('not routed', { status: 500 });
    const roleId = match[2] ? decodeURIComponent(match[2]) : undefined;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    if (method === 'GET' && roleId) {
      const role = roles.get(roleId);
      return role ? Response.json(role) : new Response('{}', { status: 404 });
    }
    if (method === 'POST' && !roleId) {
      const id = body!.roleId as string;
      writes.push({ method: 'CREATE', roleId: id, body });
      if (roles.has(id)) return new Response('{}', { status: 409 });
      const role = body!.role as { includedPermissions: string[]; title: string };
      roles.set(id, { includedPermissions: role.includedPermissions, title: role.title, etag: nextEtag() });
      return Response.json(roles.get(id));
    }
    if (method === 'POST' && roleId && match[3]) {
      writes.push({ method: 'UNDELETE', roleId, body });
      const role = roles.get(roleId)!;
      roles.set(roleId, { ...role, deleted: false, etag: nextEtag() });
      return Response.json(roles.get(roleId));
    }
    if (method === 'PATCH' && roleId) {
      writes.push({ method: 'PATCH', roleId, body });
      expect(url.searchParams.get('updateMask')).toBe('includedPermissions');
      const role = roles.get(roleId)!;
      if (staleWrites > 0) {
        staleWrites -= 1;
        // A concurrent hand edit moved the etag between our read and our write.
        roles.set(roleId, { ...role, etag: nextEtag() });
        return new Response('{}', { status: 409 });
      }
      if ((body as { etag?: string }).etag !== role.etag) return new Response('{}', { status: 409 });
      roles.set(roleId, { ...role, includedPermissions: (body as { includedPermissions: string[] }).includedPermissions, etag: nextEtag() });
      return Response.json(roles.get(roleId));
    }
    return new Response('unexpected', { status: 500 });
  });
  return { roles, writes, fetch: fetchImpl as unknown as typeof fetch };
}

const matching = () => ({
  [HOST]: { includedPermissions: [...PAPERCUSP_HOSTED_HOST_PERMISSIONS], etag: 'h0' },
  [OBSERVER]: { includedPermissions: [...PAPERCUSP_HOSTED_OBSERVER_PERMISSIONS], etag: 'o0' },
});

describe('the role specs are the code constants (WI-10005251)', () => {
  it('derives each role from its permission constant, not a copy', () => {
    expect(PAPERCUSP_HOSTED_ROLE_SPECS.map((spec) => spec.roleId)).toEqual([HOST, OBSERVER]);
    expect(PAPERCUSP_HOSTED_ROLE_SPECS[0]!.permissions).toBe(PAPERCUSP_HOSTED_HOST_PERMISSIONS);
    expect(PAPERCUSP_HOSTED_ROLE_SPECS[1]!.permissions).toBe(PAPERCUSP_HOSTED_OBSERVER_PERMISSIONS);
  });
});

describe('papercuspHostedRoleDrift', () => {
  const spec = PAPERCUSP_HOSTED_ROLE_SPECS[0]!;

  it('is clean when the live role holds exactly the code list, in any order', () => {
    const drift = papercuspHostedRoleDrift(spec, { includedPermissions: [...spec.permissions].reverse(), etag: 'e', deleted: false });
    expect(papercuspHostedRoleDrifted(drift)).toBe(false);
  });

  it('names the permission the live role lacks: the exact 2026-10-02 incident', () => {
    const live = spec.permissions.filter((permission) => permission !== 'compute.instances.setScheduling');
    const drift = papercuspHostedRoleDrift(spec, { includedPermissions: live, etag: 'e', deleted: false });
    expect(drift).toMatchObject({ missing: ['compute.instances.setScheduling'], extra: [], absent: false, deleted: false });
    expect(papercuspHostedRoleDrifted(drift)).toBe(true);
  });

  it('treats a live permission the code does not list as drift (a wider grant than reviewed)', () => {
    const drift = papercuspHostedRoleDrift(spec, {
      includedPermissions: [...spec.permissions, 'iam.serviceAccounts.actAs'],
      etag: 'e',
      deleted: false,
    });
    expect(drift.extra).toEqual(['iam.serviceAccounts.actAs']);
    expect(papercuspHostedRoleDrifted(drift)).toBe(true);
  });

  it('treats an absent or deleted role as drift', () => {
    expect(papercuspHostedRoleDrift(spec, null)).toMatchObject({ absent: true, missing: [...spec.permissions].sort() });
    const deleted = papercuspHostedRoleDrift(spec, { includedPermissions: [...spec.permissions], etag: 'e', deleted: true });
    expect(papercuspHostedRoleDrifted(deleted)).toBe(true);
  });
});

describe('reconcilePapercuspHostedRoles (DERIVE)', () => {
  it('reports drift and writes nothing on a dry run', async () => {
    const iam = fakeIam({ ...matching(), [HOST]: { includedPermissions: ['compute.networks.get'], etag: 'h0' } });
    const outcomes = await reconcilePapercuspHostedRoles({ projectId: PROJECT, accessToken: 't', fetch: iam.fetch, apply: false });
    expect(outcomes.map((outcome) => [outcome.roleId, outcome.action])).toEqual([
      [HOST, 'would-change'],
      [OBSERVER, 'unchanged'],
    ]);
    expect(iam.writes).toEqual([]);
  });

  it('sets a drifted role to exactly the code list under the read etag', async () => {
    const iam = fakeIam({ ...matching(), [HOST]: { includedPermissions: ['compute.networks.get', 'iam.serviceAccounts.actAs'], etag: 'h0' } });
    const outcomes = await reconcilePapercuspHostedRoles({ projectId: PROJECT, accessToken: 't', fetch: iam.fetch, apply: true });
    expect(outcomes[0]).toMatchObject({ roleId: HOST, action: 'updated' });
    expect(outcomes[0]!.before.extra).toEqual(['iam.serviceAccounts.actAs']);
    expect(iam.writes).toEqual([
      { method: 'PATCH', roleId: HOST, body: { includedPermissions: [...PAPERCUSP_HOSTED_HOST_PERMISSIONS], etag: 'h0' } },
    ]);
    expect(iam.roles.get(HOST)!.includedPermissions).toEqual([...PAPERCUSP_HOSTED_HOST_PERMISSIONS]);
  });

  it('creates a role that does not exist', async () => {
    const iam = fakeIam({ ...matching(), [OBSERVER]: undefined });
    const outcomes = await reconcilePapercuspHostedRoles({ projectId: PROJECT, accessToken: 't', fetch: iam.fetch, apply: true });
    expect(outcomes[1]).toMatchObject({ roleId: OBSERVER, action: 'created' });
    expect(iam.roles.get(OBSERVER)!.includedPermissions).toEqual([...PAPERCUSP_HOSTED_OBSERVER_PERMISSIONS]);
    expect(iam.roles.get(OBSERVER)!.title).toBe('Papercusp hosted workspace observer');
  });

  it('undeletes a soft-deleted role before setting its permissions', async () => {
    const iam = fakeIam({ ...matching(), [HOST]: { includedPermissions: ['compute.networks.get'], etag: 'h0', deleted: true } });
    const outcomes = await reconcilePapercuspHostedRoles({ projectId: PROJECT, accessToken: 't', fetch: iam.fetch, apply: true });
    expect(outcomes[0]).toMatchObject({ action: 'undeleted-and-updated' });
    expect(iam.writes.map((write) => write.method)).toEqual(['UNDELETE', 'PATCH']);
    expect(iam.roles.get(HOST)).toMatchObject({ deleted: false, includedPermissions: [...PAPERCUSP_HOSTED_HOST_PERMISSIONS] });
  });

  it('re-reads after a concurrent edit instead of overwriting blind', async () => {
    const iam = fakeIam(
      { ...matching(), [HOST]: { includedPermissions: ['compute.networks.get'], etag: 'h0' } },
      { staleWritesBeforeSuccess: 1 },
    );
    const outcomes = await reconcilePapercuspHostedRoles({ projectId: PROJECT, accessToken: 't', fetch: iam.fetch, apply: true });
    expect(outcomes[0]).toMatchObject({ action: 'updated' });
    const patches = iam.writes.filter((write) => write.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect((patches[1]!.body as { etag: string }).etag).not.toBe('h0');
  });

  it('refuses loudly on any other GCP answer', async () => {
    const iam = fakeIam(matching(), { status: 403 });
    await expect(reconcilePapercuspHostedRoles({ projectId: PROJECT, accessToken: 't', fetch: iam.fetch, apply: true })).rejects.toThrow(
      /gcp_papercusp_hosted_role_read_failed:403/,
    );
  });
});

function attestationRuntime(
  iam: ReturnType<typeof fakeIam>,
  overrides: Partial<PapercuspHostedRoleAttestationRuntime> = {},
): PapercuspHostedRoleAttestationRuntime & { filed: PapercuspHostedRoleFinding[] } {
  const filed: PapercuspHostedRoleFinding[] = [];
  return {
    projectId: PROJECT,
    accessToken: async () => 't',
    fetch: iam.fetch,
    openFindingExists: async () => false,
    fileFinding: async (finding) => {
      filed.push(finding);
    },
    ...overrides,
    filed,
  };
}

describe('runPapercuspHostedRoleAttestation (ATTEST)', () => {
  it('is skipped on a controller without a hosting project', async () => {
    const iam = fakeIam(matching());
    const result = await runPapercuspHostedRoleAttestation(attestationRuntime(iam, { projectId: null }));
    expect(result.kind).toBe('skipped');
    expect(iam.fetch).not.toHaveBeenCalled();
    expect(papercuspHostedRoleAttestationSummary(result)).toBeNull();
  });

  it('files nothing and stays quiet when both roles match code', async () => {
    const iam = fakeIam(matching());
    const runtime = attestationRuntime(iam);
    const result = await runPapercuspHostedRoleAttestation(runtime);
    expect(result).toMatchObject({ kind: 'attested', filed: [] });
    expect(runtime.filed).toEqual([]);
    expect(papercuspHostedRoleAttestationSummary(result)).toBeNull();
    expect(iam.writes).toEqual([]);
  });

  it('files one finding per drifted role, naming the missing permission and the repair command', async () => {
    const live = PAPERCUSP_HOSTED_HOST_PERMISSIONS.filter((permission) => permission !== 'compute.instances.setScheduling');
    const iam = fakeIam({ ...matching(), [HOST]: { includedPermissions: [...live], etag: 'h0' } });
    const runtime = attestationRuntime(iam);
    const result = await runPapercuspHostedRoleAttestation(runtime);
    expect(result).toMatchObject({ kind: 'attested', filed: [papercuspHostedRoleWatchdogKey(PROJECT, HOST)] });
    expect(runtime.filed).toHaveLength(1);
    expect(runtime.filed[0]!.body).toContain('compute.instances.setScheduling');
    expect(runtime.filed[0]!.body).toContain(papercuspHostedRoleRepairCommand(PROJECT));
    expect(papercuspHostedRoleAttestationSummary(result)).toContain('missing=[compute.instances.setScheduling]');
    // Attesting never writes to GCP.
    expect(iam.writes).toEqual([]);
  });

  it('does not re-file while a finding for that role is still open', async () => {
    const iam = fakeIam({ ...matching(), [OBSERVER]: undefined });
    const runtime = attestationRuntime(iam, { openFindingExists: async () => true });
    const result = await runPapercuspHostedRoleAttestation(runtime);
    expect(result).toMatchObject({ kind: 'attested', filed: [] });
    expect(runtime.filed).toEqual([]);
  });

  it('files the blind detector itself when the role read is refused', async () => {
    const iam = fakeIam(matching(), { status: 403 });
    const runtime = attestationRuntime(iam);
    const result = await runPapercuspHostedRoleAttestation(runtime);
    expect(result).toMatchObject({ kind: 'read-failed', filed: [papercuspHostedRoleAttestationUnreadableKey(PROJECT)] });
    expect(runtime.filed[0]!.body).toContain('roles/iam.roleViewer');
  });

  it('leaves a transient read failure to the next tick without filing', async () => {
    const iam = fakeIam(matching(), { status: 503 });
    const runtime = attestationRuntime(iam);
    const result = await runPapercuspHostedRoleAttestation(runtime);
    expect(result).toMatchObject({ kind: 'read-failed', filed: [] });
    expect(runtime.filed).toEqual([]);
  });

  it('never throws when filing fails, so the health tick that runs it is not broken', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const iam = fakeIam({ ...matching(), [OBSERVER]: undefined });
    const result = await runPapercuspHostedRoleAttestation(
      attestationRuntime(iam, {
        fileFinding: async () => {
          throw new Error('db down');
        },
      }),
    );
    expect(result).toMatchObject({ kind: 'attested', filed: [] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
    warn.mockRestore();
  });
});
