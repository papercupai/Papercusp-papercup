import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteDefinition } from '../../define-route';

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  getUser: vi.fn(),
  parsePlan: vi.fn(),
  enabled: vi.fn(),
  setEnabled: vi.fn(),
  stats: vi.fn(),
  listGrants: vi.fn(),
  replaceGrant: vi.fn(),
  revokeGrant: vi.fn(),
  purge: vi.fn(),
  reserveImport: vi.fn(),
  storeImport: vi.fn(),
  finalizeImport: vi.fn(),
  releaseImport: vi.fn(),
  removeImportArchive: vi.fn(),
  listImportJobs: vi.fn(),
  importStorage: vi.fn(),
  purgeImports: vi.fn(),
  cancelImport: vi.fn(),
  retryImport: vi.fn(),
  listSources: vi.fn(),
  getSource: vi.fn(),
  disconnectSources: vi.fn(),
  setCapability: vi.fn(),
  loadProviders: vi.fn(),
  getProvider: vi.fn(),
  providerRegistry: vi.fn(),
  tokenRead: vi.fn(),
  tokenUpdate: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: mocks.sql }),
}));
vi.mock('@papercusp/plan-parser', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/plan-parser')>()),
  parsePlan: mocks.parsePlan,
}));
vi.mock('../../../auth', () => ({ getSessionUserOrDefault: mocks.getUser }));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../../personal-vault/import-jobs', async () => {
  const actual = await vi.importActual<typeof import('../../../personal-vault/import-jobs')>(
    '../../../personal-vault/import-jobs',
  );
  return {
    ...actual,
    reservePersonalVaultImportUpload: mocks.reserveImport,
    storeReservedPersonalVaultImportArchive: mocks.storeImport,
    finalizePersonalVaultImportUpload: mocks.finalizeImport,
    releasePersonalVaultImportUpload: mocks.releaseImport,
    removePersonalVaultImportArchive: mocks.removeImportArchive,
    listPersonalVaultImportJobs: mocks.listImportJobs,
    personalVaultImportStorageUsage: mocks.importStorage,
    purgePersonalVaultImportArchives: mocks.purgeImports,
    requestPersonalVaultImportCancellation: mocks.cancelImport,
    retryPersonalVaultImportJob: mocks.retryImport,
  };
});
vi.mock('../../../external-triggers/source-store', () => ({
  listOwnedExternalTriggerSources: mocks.listSources,
  getExternalTriggerSource: mocks.getSource,
  disconnectOwnedExternalTriggerSources: mocks.disconnectSources,
  setOwnedExternalTriggerSourceCapability: mocks.setCapability,
}));
// The installed Google packages' declared scopes (D-036). Unregistered by default, so the
// static capability scopes stand in unless a test registers a descriptor.
vi.mock('../../../integrations/provider-registry', () => ({
  readyProviderRegistry: mocks.providerRegistry,
}));
vi.mock('../../../oauth/providers', () => ({
  GOOGLE_GMAIL_READONLY_SCOPE: 'https://www.googleapis.com/auth/gmail.readonly',
  GOOGLE_GMAIL_COMPOSE_SCOPE: 'https://www.googleapis.com/auth/gmail.compose',
  GOOGLE_CALENDAR_READONLY_SCOPE: 'https://www.googleapis.com/auth/calendar.readonly',
  GOOGLE_CALENDAR_EVENTS_SCOPE: 'https://www.googleapis.com/auth/calendar.events',
  GOOGLE_CONTACTS_READONLY_SCOPE: 'https://www.googleapis.com/auth/contacts.readonly',
  GOOGLE_YOUTUBE_READONLY_SCOPE: 'https://www.googleapis.com/auth/youtube.readonly',
  GOOGLE_YOUTUBE_FORCE_SSL_SCOPE: 'https://www.googleapis.com/auth/youtube.force-ssl',
  GOOGLE_WORKSPACE_SCOPES: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/contacts.readonly',
  ],
  loadAndRegisterProvidersFromDisk: mocks.loadProviders,
  getProvider: mocks.getProvider,
}));
vi.mock('../../../oauth/storage-fs', () => ({
  fsTokenStorage: { read: mocks.tokenRead, update: mocks.tokenUpdate },
}));
vi.mock('../../../personal-vault/store', async () => {
  const actual = await vi.importActual<typeof import('../../../personal-vault/store')>('../../../personal-vault/store');
  return {
    ...actual,
    isPersonalVaultEnabled: mocks.enabled,
    setPersonalVaultEnabled: mocks.setEnabled,
    personalVaultStats: mocks.stats,
    listPersonalGrants: mocks.listGrants,
    replacePersonalGrant: mocks.replaceGrant,
    revokePersonalGrant: mocks.revokeGrant,
    purgePersonalSource: mocks.purge,
  };
});

import routes, { declaredPersonalScopes } from './personal-vault';

const SOURCE_ID = '00000000-0000-4000-8000-000000000101';
const IMPORT_ID = '00000000-0000-4000-8000-000000000201';

const importJob = (overrides: Record<string, unknown> = {}) => ({
  id: IMPORT_ID,
  workspaceId: 'ws-test',
  userId: 'user-1',
  sourceId: null,
  providerAccountId: null,
  filename: 'takeout.mbox',
  storagePath: '/tmp/personal-vault/import.archive',
  contentType: 'application/mbox',
  contentSha256: 'a'.repeat(64),
  idempotencyKey: 'b'.repeat(64),
  sizeBytes: 4,
  status: 'queued',
  bytesProcessed: 0,
  entriesProcessed: 0,
  documentsSeen: 0,
  documentsImported: 0,
  checkpoint: { entryIndex: 0, recordIndex: 0 },
  warnings: [],
  cancelRequested: false,
  attemptCount: 0,
  maxAttempts: 5,
  nextAttemptAt: '2026-08-26T00:00:00.000Z',
  leaseOwner: null,
  leaseExpiresAt: null,
  retainedUntil: '2026-09-02T00:00:00.000Z',
  lastError: null,
  startedAt: null,
  completedAt: null,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
  ...overrides,
});

const route = (method: string, path: string): RouteDefinition => {
  const found = (routes as RouteDefinition[]).find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  if (!found) throw new Error(`missing route ${method} ${path}`);
  return found;
};

const invoke = (method: string, path: string, req: Request) => route(method, path).handler(req, {} as never);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ id: 'user-1', display_name: 'Owner' });
  mocks.enabled.mockResolvedValue(true);
  mocks.stats.mockResolvedValue({ sources: [{ source: 'gmail', documents: 2, newest_at: null }], unembedded: 1 });
  mocks.listGrants.mockResolvedValue([]);
  mocks.replaceGrant.mockResolvedValue({ id: 'grant-1', scopes: ['personal:mail'], revoked: 0 });
  mocks.revokeGrant.mockResolvedValue(true);
  mocks.purge.mockResolvedValue({ documents: 2, cursors: 1, aliases: 1, identities: 1 });
  mocks.reserveImport.mockResolvedValue({
    id: '00000000-0000-4000-8000-000000000202',
    workspaceId: 'ws-test',
    userId: 'user-1',
    filename: 'takeout.mbox',
    storagePath: '/tmp/personal-vault/import.partial',
    declaredSizeBytes: 4,
    reservedBytes: 4,
    receivedBytes: 0,
    expiresAt: '2026-08-27T00:00:00.000Z',
  });
  mocks.storeImport.mockResolvedValue({
    storagePath: '/tmp/personal-vault/import.archive',
    contentSha256: 'a'.repeat(64),
    sizeBytes: 4,
  });
  mocks.finalizeImport.mockResolvedValue(importJob());
  mocks.releaseImport.mockResolvedValue(undefined);
  mocks.removeImportArchive.mockResolvedValue(undefined);
  mocks.listImportJobs.mockResolvedValue([importJob()]);
  mocks.importStorage.mockResolvedValue({
    owner: {
      retainedBytes: 4,
      reservedBytes: 0,
      usedBytes: 4,
      remainingBytes: 32 * 1024 * 1024 * 1024 - 4,
      maxBytes: 32 * 1024 * 1024 * 1024,
      retainedJobs: 1,
      reservedJobs: 0,
      jobs: 1,
      remainingJobs: 7,
      maxJobs: 8,
    },
    workspace: {
      retainedBytes: 4,
      reservedBytes: 0,
      usedBytes: 4,
      remainingBytes: 256 * 1024 * 1024 * 1024 - 4,
      maxBytes: 256 * 1024 * 1024 * 1024,
      retainedJobs: 1,
      reservedJobs: 0,
      jobs: 1,
      remainingJobs: 63,
      maxJobs: 64,
    },
  });
  mocks.purgeImports.mockResolvedValue({ jobs: 1, archives: 1, cleanupFailures: 0 });
  mocks.cancelImport.mockResolvedValue(importJob({ status: 'cancelled', storagePath: null }));
  mocks.retryImport.mockResolvedValue(importJob());
  mocks.loadProviders.mockResolvedValue(['google']);
  mocks.getProvider.mockImplementation((id: string) => (id === 'google' ? { id: 'google' } : null));
  mocks.listSources.mockResolvedValue([
    {
      id: 'gmail-source',
      workspaceId: 'ws-test',
      kind: 'gmail',
      ownerUserId: 'user-1',
      providerAccountId: 'owner@example.com',
      credentialRef: 'provider:google:owner-user-1',
      status: 'connected',
      config: { privateSetting: 'never-serialize-source-config' },
      cursor: { historyId: 'never-serialize-me', lastSyncAt: '2026-08-23T00:00:00.000Z' },
      lastError: null,
      lastConnectedAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:00:00.000Z',
    },
  ]);
  mocks.getSource.mockResolvedValue({
    id: SOURCE_ID,
    workspaceId: 'ws-test',
    kind: 'gmail',
    ownerUserId: 'user-1',
    providerAccountId: 'owner@example.com',
  });
  mocks.disconnectSources.mockResolvedValue({
    sources: 3,
    credentialRefs: ['provider:google:owner-user-1'],
  });
  mocks.setCapability.mockResolvedValue({
    id: 'contacts-source',
    workspaceId: 'ws-test',
    kind: 'contacts',
    ownerUserId: 'user-1',
    providerAccountId: 'owner@example.com',
    credentialRef: 'provider:google:owner-user-1',
    status: 'disabled',
    config: { capabilityEnabled: false },
    cursor: {},
  });
  mocks.tokenRead.mockResolvedValue({
    'owner-user-1': 'never-serialize-google-access-token',
    'owner-user-1_refresh': 'never-serialize-google-refresh-token',
    'owner-user-1_scopes': [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/contacts.readonly',
    ],
  });
  mocks.parsePlan.mockReturnValue({ frontmatter: { raw: { personalScopes: ['personal:mail'] } } });
  mocks.sql.mockResolvedValue([
    { plan_slug: 'meeting-prep', harness_slug: 'papercusp', template_slug: null, content: 'plan' },
  ]);
});

describe('Personal Vault owner routes', () => {
  it('keeps reads public-compatible and every mutation loopback-only', () => {
    expect(route('GET', '/user/personal-vault').auth).toBe('public');
    expect(route('GET', '/user/personal-vault/grants').auth).toBe('public');
    for (const candidate of routes as RouteDefinition[]) {
      if (candidate.method !== 'GET') expect(candidate.auth).toBe('loopback');
    }
  });

  it('returns status from the canonical per-user store', async () => {
    const response = await invoke('GET', '/user/personal-vault', new Request('http://localhost/user/personal-vault'));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      enabled: true,
      workspaceId: 'ws-test',
      embedding: { mode: 'gemma', localOnly: true },
      stats: { unembedded: 1 },
      importStorage: {
        owner: { usedBytes: 4, maxBytes: 32 * 1024 * 1024 * 1024, jobs: 1, maxJobs: 8 },
      },
      integrations: {
        google: {
          configured: true,
          connected: true,
          status: 'connected',
          accounts: [
            expect.objectContaining({
              providerAccountId: 'owner@example.com',
              displayName: 'owner@example.com',
              connected: true,
            }),
          ],
          sources: [
            {
              kind: 'gmail',
              status: 'connected',
              lastSyncAt: '2026-08-23T00:00:00.000Z',
            },
          ],
          capabilities: [
            expect.objectContaining({ id: 'gmail', enabled: true, status: 'connected' }),
            expect.objectContaining({ id: 'calendar', enabled: true, status: 'connected' }),
            expect.objectContaining({ id: 'contacts', enabled: true, status: 'connected' }),
          ],
        },
        facebook: {
          configured: false,
          connected: false,
          status: 'needs-app-config',
          sources: [],
        },
      },
    });
    // D-038: only Google capabilities with an implemented Personal Vault ingest
    // path are surfaced. The YouTube social adapters are a separate pipeline.
    expect(payload.integrations.google.capabilities.map((capability: { id: string }) => capability.id)).toEqual([
      'gmail', 'calendar', 'contacts',
    ]);
    expect(mocks.stats).toHaveBeenCalledWith(mocks.sql, 'ws-test', 'user-1');
    const body = JSON.stringify(payload);
    expect(body).not.toContain('historyId');
    expect(body).not.toContain('credentialRef');
    expect(body).not.toContain('never-serialize-source-config');
    expect(body).not.toContain('never-serialize-google-access-token');
    expect(body).not.toContain('never-serialize-google-refresh-token');
  });

  it('groups legacy Google pseudo-account rows under the Gmail cursor identity', async () => {
    mocks.listSources.mockResolvedValueOnce([
      {
        id: 'canonical-gmail-source',
        workspaceId: 'ws-test',
        kind: 'gmail',
        ownerUserId: 'user-1',
        providerAccountId: 'owner@example.com',
        credentialRef: 'provider:google:owner-user-1',
        status: 'connected',
        config: {},
        cursor: { emailAddress: 'owner@example.com' },
        lastError: null,
        lastConnectedAt: null,
        updatedAt: '2026-08-23T00:00:00.000Z',
      },
      {
        id: 'legacy-gmail-source',
        workspaceId: 'ws-test',
        kind: 'gmail',
        ownerUserId: 'user-1',
        providerAccountId: 'provider:google:owner',
        credentialRef: 'provider:google:legacy-owner',
        status: 'disabled',
        config: {},
        cursor: { emailAddress: 'Owner@Example.com' },
        lastError: null,
        lastConnectedAt: null,
        updatedAt: '2026-08-23T00:00:00.000Z',
      },
      {
        id: 'legacy-calendar-source',
        workspaceId: 'ws-test',
        kind: 'gcal',
        ownerUserId: 'user-1',
        providerAccountId: 'provider:google:owner',
        credentialRef: 'provider:google:legacy-owner',
        status: 'disabled',
        config: {},
        cursor: {},
        lastError: null,
        lastConnectedAt: null,
        updatedAt: '2026-08-23T00:00:00.000Z',
      },
    ]);

    const response = await invoke('GET', '/user/personal-vault', new Request('http://localhost/user/personal-vault'));
    expect(response.status).toBe(200);
    const payload = await response.json();
    const google = payload.integrations.google;

    expect(google.accounts).toHaveLength(1);
    expect(google.accounts[0]).toMatchObject({
      providerAccountId: 'owner@example.com',
      connected: true,
      status: 'connected',
    });
    expect(google.accounts[0].sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'gmail', providerAccountId: 'provider:google:owner', status: 'disabled' }),
        expect.objectContaining({ kind: 'gcal', providerAccountId: 'provider:google:owner', status: 'disabled' }),
      ]),
    );
    expect(google.accounts.map((account: { providerAccountId: string }) => account.providerAccountId)).toEqual([
      'owner@example.com',
    ]);
  });

  it('does not surface a connected YouTube source as a Personal Vault capability without an ingest path', async () => {
    mocks.listSources.mockResolvedValueOnce([
      {
        id: 'gmail-source',
        workspaceId: 'ws-test',
        kind: 'gmail',
        ownerUserId: 'user-1',
        providerAccountId: 'owner@example.com',
        credentialRef: 'provider:google:owner-user-1',
        status: 'connected',
        config: {},
        cursor: {},
        lastError: null,
        lastConnectedAt: '2026-08-23T00:00:00.000Z',
        updatedAt: '2026-08-23T00:00:00.000Z',
      },
      {
        id: 'youtube-source',
        workspaceId: 'ws-test',
        kind: 'youtube',
        ownerUserId: 'user-1',
        providerAccountId: 'owner@example.com',
        credentialRef: 'provider:google:owner-user-1',
        status: 'connected',
        config: { capabilityEnabled: true },
        cursor: {},
        lastError: null,
        lastConnectedAt: '2026-08-23T00:00:00.000Z',
        updatedAt: '2026-08-23T00:00:00.000Z',
      },
    ]);

    const response = await invoke('GET', '/user/personal-vault', new Request('http://localhost/user/personal-vault'));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.integrations.google.capabilities.map((capability: { id: string }) => capability.id)).toEqual([
      'gmail', 'calendar', 'contacts',
    ]);
    expect(payload.integrations.google.accounts[0].sources.map((source: { kind: string }) => source.kind)).toEqual([
      'gmail',
    ]);
  });

  it('disconnects Google sources and clears server-side token fields without purging vault data', async () => {
    const response = await invoke(
      'DELETE',
      '/user/personal-vault/integrations/google',
      new Request('http://localhost/user/personal-vault/integrations/google', { method: 'DELETE' }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      provider: 'google',
      disconnectedSources: 3,
    });
    expect(mocks.disconnectSources).toHaveBeenCalledWith(
      mocks.sql,
      'ws-test',
      'user-1',
      ['gmail', 'gcal', 'contacts'],
      'owner@example.com',
    );
    expect(mocks.tokenUpdate).toHaveBeenCalledWith('provider:google', 'papercusp', {
      'owner-user-1': null,
      'owner-user-1_refresh': null,
      'owner-user-1_expires_at': null,
      'owner-user-1_scopes': null,
      'owner-user-1_expired': true,
    });
    expect(mocks.purge).not.toHaveBeenCalled();
  });

  it('toggles one Google capability without revoking the shared OAuth credential', async () => {
    const response = await invoke(
      'PATCH',
      '/user/personal-vault/integrations/google/capabilities',
      new Request('http://localhost/user/personal-vault/integrations/google/capabilities', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capability: 'contacts', enabled: false }),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      capability: 'contacts',
      enabled: false,
      source: { kind: 'contacts', status: 'disabled' },
    });
    expect(mocks.setCapability).toHaveBeenCalledWith(mocks.sql, {
      workspaceId: 'ws-test',
      ownerUserId: 'user-1',
      providerAccountId: 'owner@example.com',
      kind: 'contacts',
      credentialRef: 'provider:google:owner-user-1',
      enabled: false,
      createdBy: 'owner:user-1',
    });
    expect(mocks.disconnectSources).not.toHaveBeenCalled();
    expect(mocks.tokenUpdate).not.toHaveBeenCalled();
  });

  it('surfaces Calendar write consent as a capability-scoped upgrade', async () => {
    mocks.tokenRead.mockResolvedValueOnce({
      'owner-user-1': 'never-serialize-google-access-token',
      'owner-user-1_scopes': [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.compose',
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/contacts.readonly',
      ],
    });
    const response = await invoke('GET', '/user/personal-vault', new Request('http://localhost/user/personal-vault'));
    const payload = await response.json();
    expect(payload.integrations.google.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'calendar',
          status: 'needs-consent',
          missingScopes: ['https://www.googleapis.com/auth/calendar.events'],
        }),
      ]),
    );
  });

  // D-036: the installed google-contacts package's declared scopes are the requirement; the
  // static capability list only stands in while that package is not registered.
  it('requires the scopes a registered Google package declares over the static capability list', async () => {
    const otherContacts = 'https://www.googleapis.com/auth/contacts.other.readonly';
    mocks.providerRegistry.mockResolvedValueOnce(
      new Map([
        ['contacts', { descriptor: { oauth: { scopes: ['https://www.googleapis.com/auth/contacts.readonly', otherContacts] } } }],
      ]),
    );
    mocks.tokenRead.mockResolvedValueOnce({
      'owner-user-1': 'never-serialize-google-access-token',
      'owner-user-1_scopes': [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.compose',
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/contacts.readonly',
      ],
    });
    const response = await invoke('GET', '/user/personal-vault', new Request('http://localhost/user/personal-vault'));
    const payload = await response.json();
    expect(mocks.tokenRead).toHaveBeenCalledWith('provider:google', 'papercusp');
    expect(payload.integrations.google.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'contacts', status: 'needs-consent', missingScopes: [otherContacts] }),
        expect.objectContaining({ id: 'calendar', missingScopes: [] }),
      ]),
    );
  });

  it('projects multiple Facebook accounts and disconnects only the selected account without purging documents', async () => {
    mocks.getProvider.mockImplementation((id: string) => ({ id }));
    mocks.tokenRead.mockResolvedValue({
      'owner-user-1': 'never-serialize-facebook-access-token-1',
      'owner-user-2': 'never-serialize-facebook-access-token-2',
    });
    mocks.listSources.mockResolvedValue([
      {
        id: 'facebook-source-1',
        workspaceId: 'ws-test',
        kind: 'facebook',
        ownerUserId: 'user-1',
        providerAccountId: 'facebook-user-1',
        credentialRef: 'provider:facebook:owner-user-1',
        status: 'connected',
        config: { coverage: ['profile', 'posts', 'photo-metadata'], displayName: 'Owner One' },
        cursor: { since: 'secret-provider-watermark', lastSyncAt: '2026-08-23T00:15:00.000Z' },
        lastError: null,
        lastConnectedAt: '2026-08-23T00:00:00.000Z',
        updatedAt: '2026-08-23T00:15:00.000Z',
      },
      {
        id: 'facebook-source-2',
        workspaceId: 'ws-test',
        kind: 'facebook',
        ownerUserId: 'user-1',
        providerAccountId: 'facebook-user-2',
        credentialRef: 'provider:facebook:owner-user-2',
        status: 'connected',
        config: { coverage: ['profile', 'posts', 'photo-metadata'], displayName: 'Owner Two' },
        cursor: { since: 'other-secret-watermark', lastSyncAt: '2026-08-23T00:20:00.000Z' },
        lastError: null,
        lastConnectedAt: '2026-08-23T00:05:00.000Z',
        updatedAt: '2026-08-23T00:20:00.000Z',
      },
    ]);
    mocks.disconnectSources.mockResolvedValue({
      sources: 1,
      credentialRefs: ['provider:facebook:owner-user-2'],
    });

    const statusResponse = await invoke(
      'GET',
      '/user/personal-vault',
      new Request('http://localhost/user/personal-vault'),
    );
    const statusPayload = await statusResponse.json();
    expect(statusPayload.integrations.facebook).toMatchObject({
      provider: 'facebook',
      configured: true,
      connected: true,
      status: 'connected',
      accounts: [
        expect.objectContaining({
          providerAccountId: 'facebook-user-1',
          displayName: 'Owner One',
          connected: true,
        }),
        expect.objectContaining({
          providerAccountId: 'facebook-user-2',
          displayName: 'Owner Two',
          connected: true,
        }),
      ],
      sources: [
        { kind: 'facebook', providerAccountId: 'facebook-user-1', lastSyncAt: '2026-08-23T00:15:00.000Z' },
        { kind: 'facebook', providerAccountId: 'facebook-user-2', lastSyncAt: '2026-08-23T00:20:00.000Z' },
      ],
    });
    expect(JSON.stringify(statusPayload)).not.toContain('secret-provider-watermark');
    expect(JSON.stringify(statusPayload)).not.toContain('other-secret-watermark');
    expect(JSON.stringify(statusPayload)).not.toContain('credentialRef');

    const disconnectResponse = await invoke(
      'DELETE',
      '/user/personal-vault/integrations/facebook',
      new Request('http://localhost/user/personal-vault/integrations/facebook?account=facebook-user-2', {
        method: 'DELETE',
      }),
    );
    await expect(disconnectResponse.json()).resolves.toMatchObject({
      provider: 'facebook',
      providerAccountId: 'facebook-user-2',
      disconnectedSources: 1,
    });
    expect(mocks.disconnectSources).toHaveBeenCalledWith(
      mocks.sql,
      'ws-test',
      'user-1',
      ['facebook'],
      'facebook-user-2',
    );
    expect(mocks.tokenUpdate).toHaveBeenCalledWith('provider:facebook', 'papercusp', {
      'owner-user-2': null,
      'owner-user-2_refresh': null,
      'owner-user-2_expires_at': null,
      'owner-user-2_expired': true,
    });
    expect(mocks.tokenUpdate).not.toHaveBeenCalledWith(
      'provider:facebook',
      'papercusp',
      expect.objectContaining({ 'owner-user-1': null }),
    );
    expect(mocks.purge).not.toHaveBeenCalled();
  });

  it('requires a Facebook account selector when multiple owned accounts exist', async () => {
    mocks.listSources.mockResolvedValue([
      {
        kind: 'facebook',
        providerAccountId: 'facebook-user-1',
        credentialRef: 'provider:facebook:owner-user-1',
      },
      {
        kind: 'facebook',
        providerAccountId: 'facebook-user-2',
        credentialRef: 'provider:facebook:owner-user-2',
      },
    ]);
    const response = await invoke(
      'DELETE',
      '/user/personal-vault/integrations/facebook',
      new Request('http://localhost/user/personal-vault/integrations/facebook', { method: 'DELETE' }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'facebook_personal_vault_account_required',
    });
    expect(mocks.disconnectSources).not.toHaveBeenCalled();
    expect(mocks.tokenUpdate).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation before purge', async () => {
    const refused = await invoke(
      'DELETE',
      '/user/personal-vault',
      new Request('http://localhost/user/personal-vault', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'gmail' }),
      }),
    );
    expect(refused.status).toBe(400);
    expect(mocks.purge).not.toHaveBeenCalled();

    const accepted = await invoke(
      'DELETE',
      '/user/personal-vault',
      new Request('http://localhost/user/personal-vault', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'gmail', confirm: true }),
      }),
    );
    expect(accepted.status).toBe(200);
    expect(mocks.purge).toHaveBeenCalledWith(mocks.sql, 'ws-test', 'user-1', 'gmail', {
      sourceId: null,
      providerAccountId: null,
    });
    expect(mocks.purgeImports).toHaveBeenCalledWith(mocks.sql, 'ws-test', 'user-1', {
      sourceId: null,
      providerAccountId: null,
    });
  });

  it('forwards account provenance for a surgical purge', async () => {
    const accepted = await invoke(
      'DELETE',
      '/user/personal-vault',
      new Request('http://localhost/user/personal-vault', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'gmail',
          sourceId: SOURCE_ID,
          providerAccountId: 'owner@example.com',
          confirm: true,
        }),
      }),
    );
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      source: 'gmail',
      sourceId: SOURCE_ID,
      providerAccountId: 'owner@example.com',
    });
    expect(mocks.purge).toHaveBeenCalledWith(mocks.sql, 'ws-test', 'user-1', 'gmail', {
      sourceId: SOURCE_ID,
      providerAccountId: 'owner@example.com',
    });
    expect(mocks.purgeImports).toHaveBeenCalledWith(mocks.sql, 'ws-test', 'user-1', {
      sourceId: SOURCE_ID,
      providerAccountId: 'owner@example.com',
    });
  });

  it('streams a raw archive body into a durable background job', async () => {
    const response = await invoke(
      'POST',
      '/user/personal-vault/import',
      new Request('http://localhost/user/personal-vault/import', {
        method: 'POST',
        headers: {
          'content-length': '4',
          'content-type': 'application/mbox',
          'x-papercusp-filename': encodeURIComponent('takeout.mbox'),
        },
        body: 'mail',
      }),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      duplicate: false,
      job: { id: IMPORT_ID, filename: 'takeout.mbox', status: 'queued' },
    });
    expect(mocks.reserveImport).toHaveBeenCalledWith(mocks.sql, {
      workspaceId: 'ws-test',
      userId: 'user-1',
      filename: 'takeout.mbox',
      declaredSizeBytes: 4,
    });
    expect(mocks.storeImport).toHaveBeenCalledWith(
      mocks.sql,
      expect.objectContaining({ filename: 'takeout.mbox' }),
      expect.anything(),
    );
    expect(mocks.finalizeImport).toHaveBeenCalledWith(
      mocks.sql,
      expect.objectContaining({ filename: 'takeout.mbox' }),
      expect.objectContaining({ sizeBytes: 4 }),
      { contentType: 'application/mbox', sourceId: null, providerAccountId: null },
    );
  });

  it('reserves the fail-closed maximum for a body without Content-Length', async () => {
    const response = await invoke(
      'POST',
      '/user/personal-vault/import',
      new Request('http://localhost/user/personal-vault/import', {
        method: 'POST',
        headers: { 'x-papercusp-filename': 'history.zip' },
        body: 'mail',
      }),
    );
    expect(response.status).toBe(202);
    expect(mocks.reserveImport).toHaveBeenCalledWith(
      mocks.sql,
      expect.objectContaining({ declaredSizeBytes: null }),
    );
  });

  it('binds a raw archive import to the server-owned source account', async () => {
    mocks.finalizeImport.mockResolvedValueOnce(importJob({
      sourceId: SOURCE_ID,
      providerAccountId: 'owner@example.com',
    }));
    const response = await invoke(
      'POST',
      '/user/personal-vault/import',
      new Request(`http://localhost/user/personal-vault/import?sourceId=${SOURCE_ID}`, {
        method: 'POST',
        headers: {
          'content-length': '4',
          'content-type': 'application/mbox',
          'x-papercusp-filename': 'takeout.mbox',
        },
        body: 'mail',
      }),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      job: { sourceId: SOURCE_ID, providerAccountId: 'owner@example.com' },
    });
    expect(mocks.getSource).toHaveBeenCalledWith(mocks.sql, 'ws-test', SOURCE_ID);
    expect(mocks.finalizeImport).toHaveBeenCalledWith(
      mocks.sql,
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        sourceId: SOURCE_ID,
        providerAccountId: 'owner@example.com',
      }),
    );
  });

  it('refuses to import through a source owned by another user', async () => {
    mocks.getSource.mockResolvedValueOnce({
      id: SOURCE_ID,
      workspaceId: 'ws-test',
      kind: 'gmail',
      ownerUserId: 'user-2',
      providerAccountId: 'other@example.com',
    });
    const response = await invoke(
      'POST',
      '/user/personal-vault/import',
      new Request(`http://localhost/user/personal-vault/import?sourceId=${SOURCE_ID}`, {
        method: 'POST',
        headers: {
          'content-length': '4',
          'x-papercusp-filename': 'takeout.mbox',
        },
        body: 'mail',
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'personal_import_source_not_owned' });
    expect(mocks.reserveImport).not.toHaveBeenCalled();
  });

  it('removes a newly streamed duplicate after idempotent job finalization', async () => {
    mocks.finalizeImport.mockResolvedValueOnce(importJob({ storagePath: '/tmp/personal-vault/original.archive' }));
    const response = await invoke(
      'POST',
      '/user/personal-vault/import',
      new Request('http://localhost/user/personal-vault/import', {
        method: 'POST',
        headers: {
          'content-length': '4',
          'x-papercusp-filename': 'takeout.mbox',
        },
        body: 'mail',
      }),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ duplicate: true });
    expect(mocks.removeImportArchive).toHaveBeenCalledWith(
      'ws-test',
      '/tmp/personal-vault/import.archive',
    );
  });

  it('lists, cancels, and retries only the current owner import jobs', async () => {
    const listed = await invoke(
      'GET',
      '/user/personal-vault/imports',
      new Request('http://localhost/user/personal-vault/imports'),
    );
    await expect(listed.json()).resolves.toMatchObject({
      ok: true,
      jobs: [{ id: IMPORT_ID, status: 'queued' }],
      storage: { owner: { usedBytes: 4, jobs: 1 } },
    });
    expect(mocks.listImportJobs).toHaveBeenCalledWith(mocks.sql, 'ws-test', 'user-1', 50);
    expect(mocks.importStorage).toHaveBeenCalledWith(mocks.sql, 'ws-test', 'user-1');

    const cancelled = await invoke(
      'DELETE',
      '/user/personal-vault/imports',
      new Request(`http://localhost/user/personal-vault/imports?id=${IMPORT_ID}`, { method: 'DELETE' }),
    );
    await expect(cancelled.json()).resolves.toMatchObject({ job: { id: IMPORT_ID, status: 'cancelled' } });
    expect(mocks.cancelImport).toHaveBeenCalledWith(mocks.sql, 'ws-test', 'user-1', IMPORT_ID);

    const retried = await invoke(
      'POST',
      '/user/personal-vault/imports/retry',
      new Request('http://localhost/user/personal-vault/imports/retry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: IMPORT_ID }),
      }),
    );
    await expect(retried.json()).resolves.toMatchObject({ job: { id: IMPORT_ID, status: 'queued' } });
    expect(mocks.retryImport).toHaveBeenCalledWith(mocks.sql, 'ws-test', 'user-1', IMPORT_ID);
  });

  it('previews and approves only scopes declared by the plan template', async () => {
    const previewRequest = new Request('http://localhost/user/personal-vault/grants/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planSlug: 'meeting-prep', harnessSlug: 'papercusp' }),
    });
    const preview = await invoke('POST', '/user/personal-vault/grants/preview', previewRequest);
    await expect(preview.json()).resolves.toMatchObject({
      principalType: 'plan-template',
      principalId: 'meeting-prep',
      declaredScopes: ['personal:mail'],
    });

    const approval = await invoke(
      'POST',
      '/user/personal-vault/grants',
      new Request('http://localhost/user/personal-vault/grants', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // An injected scopes array is ignored for plan approval: the declaration
        // is the authority, so this cannot escalate the grant to calendar.
        body: JSON.stringify({
          planSlug: 'meeting-prep',
          harnessSlug: 'papercusp',
          scopes: ['personal:calendar'],
        }),
      }),
    );
    expect(approval.status).toBe(200);
    expect(mocks.replaceGrant).toHaveBeenCalledWith(
      mocks.sql,
      expect.objectContaining({
        principalType: 'plan-template',
        principalId: 'meeting-prep',
        scopes: ['personal:mail'],
      }),
    );
  });
});

describe('declaredPersonalScopes', () => {
  it('normalizes aliases and deduplicates them', () => {
    expect(declaredPersonalScopes({ personalScopes: ['Mail', 'personal:mail', 'calendar'] })).toEqual([
      'personal:calendar',
      'personal:mail',
    ]);
  });
});
