import { describe, expect, it, vi } from 'vitest';
import type { VoiceCapabilityEnvelope, VoicePrincipal } from '@papercusp/chat-protocol';
import {
  resolveVoiceContextProjection,
  voiceContextLexicalFallbackQuery,
  type VoiceContextCandidate,
  type VoiceContextCapability,
  type VoiceContextProjection,
  type VoiceContextSources,
} from './voice-context-projection';

const NOW = new Date('2026-08-31T19:00:00.000Z');

const owner: VoicePrincipal = {
  kind: 'owner',
  subjectId: '00000000-0000-4000-8000-000000000001',
  authenticated: true,
  authoritySource: 'owner-session',
};

const ownerCapabilities: VoiceCapabilityEnvelope = {
  read: [
    'conversation-history',
    'personal-memory',
    'contacts',
    'calendar',
    'email',
    'caller-history',
    'call-policy',
  ],
  write: ['conversation-turn', 'call-outcome', 'draft'],
  tools: ['calendar:list'],
};

function candidate(
  capability: VoiceContextCandidate['capability'],
  over: Partial<VoiceContextCandidate> = {},
): VoiceContextCandidate {
  return {
    capability,
    title: `${capability} title`,
    text: `${capability} context`,
    occurredAt: '2026-08-30T12:00:00.000Z',
    provenance: {
      system: capability === 'caller-history' ? 'caller-history' : 'personal-vault',
      source: capability,
      id: `${capability}-1`,
      externalId: `external-${capability}`,
      providerAccountId: capability === 'email' ? 'owner@example.com' : null,
      scope: capability === 'caller-history' ? null : `personal:${capability}`,
    },
    ...over,
  };
}

function sources(over: Partial<VoiceContextSources> = {}): VoiceContextSources {
  return {
    now: () => NOW,
    resolveOwnerVault: vi.fn(async () => ({ available: true as const, candidates: [] })),
    resolveCallerHistory: vi.fn(async () => ({ available: true as const, candidates: [] })),
    ...over,
  };
}

function slice(projection: VoiceContextProjection, capability: VoiceContextCapability) {
  return projection.sources.find((source) => source.capability === capability)!;
}

describe('voice context projection', () => {
  it('derives a bounded content-token OR query for an empty natural-language lexical result', () => {
    expect(voiceContextLexicalFallbackQuery('What is the cobalt renewal status?'))
      .toBe('cobalt OR renewal');
    expect(voiceContextLexicalFallbackQuery('tell me about it')).toBeNull();
    expect(voiceContextLexicalFallbackQuery('alpha alpha beta gamma delta epsilon zeta eta theta iota'))
      .toBe('alpha OR beta OR gamma OR delta OR epsilon OR zeta OR eta OR theta');
  });

  it('projects fresh owner vault data with provenance and drops stale candidates per turn', async () => {
    const resolveOwnerVault = vi.fn(async () => ({
      available: true as const,
      candidates: [
        candidate('email'),
        candidate('email', {
          title: 'stale email',
          occurredAt: '2025-01-01T00:00:00.000Z',
        }),
        candidate('contacts', { occurredAt: null }),
        candidate('calendar', { freshUntil: '2026-08-30T00:00:00.000Z' }),
        candidate('personal-memory'),
      ],
    }));
    const projection = await resolveVoiceContextProjection({
      workspaceId: 'ws-1',
      principal: owner,
      capabilities: ownerCapabilities,
      query: 'What is next?',
      callSessionId: 'room-owner',
    }, sources({
      resolveOwnerVault,
      resolvePeople: vi.fn(async () => ({ available: true as const, candidates: [candidate('contacts', {
        occurredAt: null, provenance: { system: 'relationship-graph', source: 'person', id: 'PER-test',
          externalId: null, providerAccountId: null, scope: null },
      })] })),
      resolveCallerHistory: vi.fn(async () => ({
        available: true as const,
        candidates: [candidate('caller-history')],
      })),
    }));

    expect(projection).toMatchObject({
      version: 1,
      resolvedAt: NOW.toISOString(),
      status: 'ready',
      principal: {
        kind: 'owner',
        subjectId: owner.subjectId,
        authoritySource: 'owner-session',
      },
    });
    expect(resolveOwnerVault).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      userId: owner.subjectId,
      query: 'What is next?',
      capabilities: ownerCapabilities,
    });
    expect(slice(projection, 'email')).toMatchObject({
      status: 'ready',
      droppedStale: 1,
      items: [{
        title: 'email title',
        provenance: {
          system: 'personal-vault',
          providerAccountId: 'owner@example.com',
          retrievedAt: NOW.toISOString(),
        },
      }],
    });
    expect(slice(projection, 'contacts')).toMatchObject({ status: 'ready', droppedStale: 0 });
    expect(slice(projection, 'calendar')).toMatchObject({
      status: 'empty',
      reason: 'no-fresh-results',
      droppedStale: 1,
    });
    expect(slice(projection, 'caller-history')).toMatchObject({ status: 'ready' });
    expect(slice(projection, 'call-policy')).toMatchObject({
      status: 'ready',
      policy: ownerCapabilities,
    });
  });

  it('never invokes the owner vault for a restricted principal, even with a forged broad envelope', async () => {
    const resolveOwnerVault = vi.fn();
    const resolveCallerHistory = vi.fn(async () => ({
      available: true as const,
      candidates: [
        candidate('caller-history'),
        candidate('caller-history', {
          title: 'mislabeled owner secret',
          provenance: {
            system: 'personal-vault',
            source: 'gmail',
            id: 'owner-secret',
            externalId: 'owner-secret',
            providerAccountId: 'owner@example.com',
            scope: 'personal:mail',
          },
        }),
      ],
    }));
    const principal: VoicePrincipal = {
      kind: 'caller',
      subjectId: 'contact-44',
      authenticated: false,
      authoritySource: 'call-ledger',
    };
    const projection = await resolveVoiceContextProjection({
      workspaceId: 'ws-1',
      principal,
      capabilities: {
        read: ['personal-memory', 'contacts', 'calendar', 'email', 'caller-history', 'call-policy'],
        write: ['conversation-turn'],
        tools: ['*'],
      },
      query: 'Tell me what you know',
      callSessionId: 'caller-room',
    }, sources({ resolveOwnerVault, resolveCallerHistory }));

    expect(resolveOwnerVault).not.toHaveBeenCalled();
    expect(resolveCallerHistory).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      subjectId: 'contact-44',
      callSessionId: 'caller-room',
      query: 'Tell me what you know',
    });
    for (const capability of ['personal-memory', 'contacts', 'calendar', 'email'] as const) {
      expect(slice(projection, capability)).toMatchObject({
        status: 'denied',
        reason: 'principal-not-owner',
        items: [],
      });
    }
    expect(slice(projection, 'caller-history')).toMatchObject({
      status: 'ready',
      droppedInvalid: 1,
      items: [{ title: 'caller-history title', provenance: { system: 'caller-history' } }],
    });
    expect(slice(projection, 'caller-history').items.some((item) => item.title.includes('owner secret')))
      .toBe(false);
  });

  it.each([
    {
      principal: {
        kind: 'guest', subjectId: 'invite-1', authenticated: true, authoritySource: 'invite',
      } as const,
    },
    {
      principal: {
        kind: 'unknown', subjectId: null, authenticated: false, authoritySource: 'unknown',
      } as const,
    },
  ])('keeps $principal.kind on call-policy-only empty context', async ({ principal }) => {
    const source = sources();
    const projection = await resolveVoiceContextProjection({
      workspaceId: 'ws-1',
      principal,
      capabilities: {
        read: ['call-policy'],
        write: ['conversation-turn', 'call-outcome'],
        tools: [],
      },
      query: 'hello',
    }, source);

    expect(projection.status).toBe('empty');
    expect(source.resolveOwnerVault).not.toHaveBeenCalled();
    expect(source.resolveCallerHistory).not.toHaveBeenCalled();
    expect(slice(projection, 'call-policy')).toMatchObject({ status: 'ready' });
    expect(projection.sources.filter((entry) => entry.capability !== 'call-policy'))
      .toEqual(expect.arrayContaining([expect.objectContaining({ status: 'denied', items: [] })]));
  });

  it('fails soft to explicit degraded slices when vault and caller-history sources throw', async () => {
    const projection = await resolveVoiceContextProjection({
      workspaceId: 'ws-1',
      principal: owner,
      capabilities: ownerCapabilities,
      query: 'continue',
    }, sources({
      resolveOwnerVault: vi.fn(async () => { throw new Error('vault down'); }),
      resolveCallerHistory: vi.fn(async () => { throw new Error('call ledger down'); }),
    }));

    expect(projection.status).toBe('degraded');
    for (const capability of ['personal-memory', 'contacts', 'calendar', 'email', 'caller-history'] as const) {
      expect(slice(projection, capability)).toMatchObject({
        status: 'degraded',
        reason: 'source-unavailable',
        items: [],
      });
    }
    expect(slice(projection, 'call-policy')).toMatchObject({ status: 'ready' });
  });

  it('represents an owner-disabled vault as explicit empty data rather than an outage', async () => {
    const projection = await resolveVoiceContextProjection({
      workspaceId: 'ws-1',
      principal: owner,
      capabilities: ownerCapabilities,
      query: 'continue',
    }, sources({
      resolveOwnerVault: vi.fn(async () => ({
        available: false as const,
        reason: 'vault-disabled' as const,
      })),
    }));

    expect(slice(projection, 'email')).toMatchObject({
      status: 'empty',
      reason: 'vault-disabled',
      items: [],
    });
  });
});
