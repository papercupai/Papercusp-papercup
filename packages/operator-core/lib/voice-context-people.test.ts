import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { VoiceCapabilityEnvelope, VoicePrincipal } from '@papercusp/chat-protocol';
import { createVoiceContextSources, personToVoiceContextCandidate, resolveVoiceContextProjection,
  type VoiceContextSources } from './voice-context-projection';

const owner: VoicePrincipal = { kind: 'owner', subjectId: 'owner-test', authenticated: true, authoritySource: 'owner-session' };
const capabilities: VoiceCapabilityEnvelope = { read: ['contacts'], write: [], tools: [] };
const person = { id: 'PER-phone-test', displayName: 'Avi', emails: ['avi@example.com'], phones: ['+15555550123'],
  organizationId: null, title: null, sourceRecordCount: 1 };
const graphCandidate = personToVoiceContextCandidate(person);
const input = { workspaceId: 'ws-people', principal: owner, capabilities, query: 'Avi' };
function sources(): VoiceContextSources {
  return { resolvePeople: vi.fn(async () => ({ available: true as const, candidates: [graphCandidate] })),
    resolveOwnerVault: vi.fn(async () => ({ available: false as const, reason: 'vault-disabled' as const })),
    resolveCallerHistory: vi.fn(async () => ({ available: true as const, candidates: [] })) };
}

describe('Phone graph people context (CRM P-003 D-033)', () => {
  it('uses canonical graph identities with a disabled Vault and never calls Vault for contacts-only permission', async () => {
    const source = sources();
    const projection = await resolveVoiceContextProjection(input, source);
    expect(projection.sources.find(x => x.capability === 'contacts')).toMatchObject({ status: 'ready', items: [{
      title: 'Avi', text: 'avi@example.com, +15555550123', provenance: { system: 'relationship-graph', id: 'PER-phone-test' },
    }] });
    expect(source.resolvePeople).toHaveBeenCalledWith({ workspaceId: 'ws-people', query: 'Avi' });
    expect(source.resolveOwnerVault).not.toHaveBeenCalled();
  });

  it.each(['guest', 'caller', 'unknown'] as const)('does not read graph persons for %s even with forged contacts permission', async kind => {
    const source = sources();
    const projection = await resolveVoiceContextProjection({ ...input, principal: { ...owner, kind } }, source);
    expect(source.resolvePeople).not.toHaveBeenCalled();
    expect(projection.sources.find(x => x.capability === 'contacts')).toMatchObject({ status: 'denied', items: [] });
  });

  it('does not read graph people without contacts capability', async () => {
    const source = sources();
    await resolveVoiceContextProjection({ ...input, capabilities: { ...capabilities, read: [] } }, source);
    expect(source.resolvePeople).not.toHaveBeenCalled();
  });

  it('rejects a Vault contact returned by the graph source rather than dual-reading', async () => {
    const source = sources();
    source.resolvePeople = vi.fn(async () => ({ available: true as const, candidates: [{ ...graphCandidate,
      provenance: { ...graphCandidate.provenance, system: 'personal-vault' as const },
    }] }));
    const projection = await resolveVoiceContextProjection(input, source);
    expect(projection.sources.find(x => x.capability === 'contacts')).toMatchObject({ items: [], droppedInvalid: 1 });
  });

  it('records a degraded graph slice with no Vault fallback on graph failure', async () => {
    const source = sources();
    source.resolvePeople = vi.fn(async () => { throw new Error('graph down'); });
    const projection = await resolveVoiceContextProjection(input, source);
    expect(projection.sources.find(x => x.capability === 'contacts')).toMatchObject({ status: 'degraded', items: [] });
    expect(source.resolveOwnerVault).not.toHaveBeenCalled();
  });

  it('production source reuses bounded searchPeople and only identity metadata', async () => {
    const sql = {} as Sql;
    const searchPeople = vi.fn(async () => [person]);
    const source = createVoiceContextSources({ sql, searchPeople });
    expect(await source.resolvePeople!({ workspaceId: 'ws-people', query: ' Avi ' })).toEqual({ available: true, candidates: [graphCandidate] });
    expect(searchPeople).toHaveBeenCalledWith(sql, 'ws-people', { query: 'Avi', limit: 12 });
    expect(graphCandidate.text).not.toContain('sourceRecordCount');
  });
});
