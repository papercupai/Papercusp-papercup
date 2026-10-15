import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceContextSources } from './voice-context-projection';
import { createVoiceContextSources, resolveVoiceContextProjection } from './voice-context-projection';
import { createVoiceTurnRouter } from './voice-turn-router';
import { searchPersonalDocuments, setPersonalVaultEnabled, upsertPersonalDocuments } from './personal-vault/store';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';

const WORKSPACE_ID = 'voice-context-projection-integration';
const NOW = new Date('2026-08-31T19:00:00.000Z');

let org: OrgTestDb;
let ownerUserId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  // Mint-time nature comes from the workspace registry, not an INSERT override.
  // Materialize the maintained person registration into this isolated fixture workspace.
  const registered = await org.adminSql`
    INSERT INTO harness_shared.datatype_registry
      (id, workspace_id, pot_slug, title, description, tier, work_item_kind,
       payload_schema, authoritative_writer, self_improvement, status, published,
       review_status, tags, created_by, nature, audience)
    SELECT id, ${WORKSPACE_ID}, pot_slug, title, description, tier, work_item_kind,
           payload_schema, authoritative_writer, self_improvement, status, published,
           review_status, tags, created_by, nature, audience
      FROM harness_shared.datatype_registry
      WHERE workspace_id = 'papercusp-workspace' AND id = 'person'
    RETURNING nature`;
  expect(registered).toEqual([{ nature: 'record' }]);
  const [user] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'voice-context-' + Date.now()}, 'Voice Context Owner')
    RETURNING id`;
  ownerUserId = user.id;
});

afterAll(async () => {
  if (org && ownerUserId) {
    await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${ownerUserId}`.catch(() => {});
  }
  await org?.cleanup();
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.documents WHERE user_id = ${ownerUserId}`;
  await org.adminSql`DELETE FROM harness_shared.personal_vault_settings WHERE user_id = ${ownerUserId}`;
  await upsertPersonalDocuments(org.adminSql, WORKSPACE_ID, ownerUserId, [
    {
      source: 'mail',
      kind: 'message',
      externalId: 'fresh-mail',
      occurredAt: '2026-08-30T12:00:00.000Z',
      title: 'Cobalt renewal current',
      text: 'The cobalt renewal is scheduled for Friday.',
      dedupeKey: 'voice:fresh-mail',
    },
    {
      source: 'mail',
      kind: 'message',
      externalId: 'stale-mail',
      occurredAt: '2025-01-01T12:00:00.000Z',
      title: 'Cobalt renewal obsolete',
      text: 'The old cobalt renewal date is no longer valid.',
      dedupeKey: 'voice:stale-mail',
    },
  ]);
});

describe('voice context projection (real Personal Vault store)', () => {
  it('reads real graph persons with Vault disabled and denies callers and guests', async () => {
    await org.adminSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, item_kind, nature, payload)
      VALUES (${WORKSPACE_ID}, 'papercusp', 'PER-voice-context-fixture', 'Cobalt Contact', 'person', 'record',
        ${org.adminSql.json({ displayName: 'Cobalt Contact', emails: ['cobalt@example.com'], phones: [], memberRecordIds: [] })})`;
    await setPersonalVaultEnabled(org.adminSql, WORKSPACE_ID, ownerUserId, false, ownerUserId);
    const source = createVoiceContextSources({ sql: org.adminSql, now: () => NOW });
    expect(await source.resolvePeople!({ workspaceId: WORKSPACE_ID, query: 'Cobalt' })).toMatchObject({
      available: true, candidates: [{ capability: 'contacts', title: 'Cobalt Contact' }],
    });
    const resolvePeople = vi.fn(source.resolvePeople!);
    const resolveOwnerVault = vi.fn(source.resolveOwnerVault);
    const sources = { ...source, resolvePeople, resolveOwnerVault };
    const input = {
      workspaceId: WORKSPACE_ID, query: 'Cobalt',
      principal: { kind: 'owner' as const, subjectId: ownerUserId, authenticated: true, authoritySource: 'owner-session' as const },
      capabilities: { read: ['contacts' as const, 'email' as const], write: [], tools: [] },
    };
    const projection = await resolveVoiceContextProjection(input, sources);
    expect(projection.sources.find(row => row.capability === 'contacts')).toMatchObject({ status: 'ready', items: [{
      title: 'Cobalt Contact', text: 'cobalt@example.com',
      provenance: { system: 'relationship-graph', source: 'person', id: 'PER-voice-context-fixture' },
    }] });
    expect(projection.sources.find(row => row.capability === 'email')).toMatchObject({ status: 'empty', reason: 'vault-disabled' });
    for (const kind of ['caller', 'guest'] as const) {
      const denied = await resolveVoiceContextProjection({ ...input, principal: { ...input.principal, kind } }, sources);
      expect(denied.sources.find(row => row.capability === 'contacts')).toMatchObject({ status: 'denied', items: [] });
    }
    expect(resolvePeople).toHaveBeenCalledOnce();
    expect(resolveOwnerVault).toHaveBeenCalledOnce();
  });

  it('searches owner data per turn, filters stale rows, and never searches it for a caller', async () => {
    const baseSources = createVoiceContextSources({
      sql: org.adminSql,
      now: () => NOW,
      embedQuery: async () => null,
      resolveCallerHistory: async ({ subjectId }) => ({
        available: true,
        candidates: [{
          capability: 'caller-history',
          title: 'Prior support call',
          text: `Caller ${subjectId} asked about the renewal.`,
          occurredAt: '2026-08-25T12:00:00.000Z',
          provenance: {
            system: 'caller-history',
            source: 'phone-call-ledger',
            id: 'call-history-1',
            externalId: 'call-previous',
            providerAccountId: null,
            scope: null,
          },
        }],
      }),
    });
    const resolveOwnerVault = vi.fn(baseSources.resolveOwnerVault);
    const seededRows = await org.adminSql`
      SELECT external_id, scope_key, text_tsv::text AS tsv,
             text_tsv @@ websearch_to_tsquery('english', 'cobalt') AS matches
      FROM harness_shared.documents
      WHERE workspace_id = ${WORKSPACE_ID} AND user_id = ${ownerUserId}
      ORDER BY external_id`;
    expect(seededRows, JSON.stringify(seededRows)).toEqual([
      expect.objectContaining({ external_id: 'fresh-mail', scope_key: 'personal:mail', matches: true }),
      expect.objectContaining({ external_id: 'stale-mail', scope_key: 'personal:mail', matches: true }),
    ]);
    const seededMatches = await searchPersonalDocuments(org.adminSql, WORKSPACE_ID, ownerUserId, {
      query: 'cobalt', scopes: ['personal:mail'], queryEmbedding: null,
    });
    expect(seededMatches.map((row) => row.externalId).sort()).toEqual(['fresh-mail', 'stale-mail']);
    const vaultResult = await baseSources.resolveOwnerVault({
      workspaceId: WORKSPACE_ID, userId: ownerUserId,
      query: 'What is the cobalt renewal status?',
      capabilities: { read: ['email'], write: [], tools: [] },
    });
    expect(vaultResult.available).toBe(true);
    if (vaultResult.available) {
      expect(vaultResult.candidates.map((row) => ({ capability: row.capability, title: row.title })))
        .toEqual(expect.arrayContaining([
          { capability: 'email', title: 'Cobalt renewal current' },
          { capability: 'email', title: 'Cobalt renewal obsolete' },
        ]));
    }
    const voiceContextSources: VoiceContextSources = { ...baseSources, resolveOwnerVault };
    const route = createVoiceTurnRouter({
      getOrCreateActiveOperatorConversation: async () => ({ id: 'operator-active' }),
      getOrCreateCallConversation: async ({ callSessionId }) => ({ id: `call:${callSessionId}` }),
      resolveOwnerTools: async () => ['calendar:list'],
      voiceContextSources,
    });

    const ownerResult = await route({
      workspaceId: WORKSPACE_ID,
      turnId: 'owner-turn',
      sequence: 0,
      occurredAt: NOW.toISOString(),
      transport: 'papercup-local',
      latencyClass: 'deliberative',
      transcript: 'What is the cobalt renewal status?',
      resolvedPrincipal: {
        kind: 'owner',
        subjectId: ownerUserId,
        authenticated: true,
        authoritySource: 'owner-session',
      },
    });

    const email = ownerResult.context.sources.find((source) => source.capability === 'email');
    expect(email).toMatchObject({
      status: 'ready',
      droppedStale: 1,
      items: [{
        title: 'Cobalt renewal current',
        provenance: {
          system: 'personal-vault',
          source: 'mail',
          externalId: 'fresh-mail',
          retrievedAt: NOW.toISOString(),
        },
      }],
    });
    expect(email?.items.some((item) => item.title.includes('obsolete'))).toBe(false);
    expect(resolveOwnerVault).toHaveBeenCalledOnce();

    const callerResult = await route({
      workspaceId: WORKSPACE_ID,
      turnId: 'caller-turn',
      sequence: 1,
      occurredAt: NOW.toISOString(),
      transport: 'phone-livekit',
      latencyClass: 'interactive',
      transcript: 'What did we discuss?',
      callSessionId: 'room-caller',
      resolvedPrincipal: {
        kind: 'caller',
        subjectId: 'contact-44',
        authenticated: false,
        authoritySource: 'call-ledger',
      },
    });

    // The count remains one: the caller branch never touched ownerUserId's vault.
    expect(resolveOwnerVault).toHaveBeenCalledOnce();
    expect(callerResult.context.sources.find((source) => source.capability === 'email')).toMatchObject({
      status: 'denied',
      items: [],
    });
    expect(callerResult.context.sources.find((source) => source.capability === 'caller-history'))
      .toMatchObject({
        status: 'ready',
        items: [{
          title: 'Prior support call',
          provenance: { system: 'caller-history', source: 'phone-call-ledger' },
        }],
      });
  });
});
