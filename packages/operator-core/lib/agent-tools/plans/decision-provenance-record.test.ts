import { describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: (ctx: { testOwner?: string }) => {
    if (!ctx?.testOwner) throw new Error('unattributable');
    return { ownerId: ctx.testOwner };
  },
}));

import {
  decisionProvenanceArg,
  findOwnerTag,
  resolveDecisionProvenance,
  rowToView,
  type DecisionProvenanceDeps,
} from './decision-provenance-record';
import type { TurnRefVerdict } from '../../turn-provenance/turn-ref';

const ME = { testOwner: 'su-test-recorder' };
const REF = '[turn:abcdef12@2026-10-28T11:00:00.000Z]';
const TAG = '[owner' + ':Someone 2026-10-28]';

function verdict(over: Partial<TurnRefVerdict>): TurnRefVerdict {
  return { ref: REF, found: true, verdict: 'owner-typed', origin: null, snippet: null, quote: null, quoteMatch: null, checked: true, ...over };
}
function deps(v: TurnRefVerdict | null): DecisionProvenanceDeps & { calls: string[] } {
  const calls: string[] = [];
  return { calls, verify: async (ownerId) => { calls.push(ownerId); return v ? [v] : []; } };
}

describe('findOwnerTag', () => {
  it('finds a closed owner tag in prose', () => {
    expect(findOwnerTag(`Ruling ${TAG} applies.`)).toBe(TAG);
  });
  it('ignores a sentence naming the tag syntax, and tags inside code', () => {
    expect(findOwnerTag('1,043 bodies carry an [owner' + ': tag (264 dated October)')).toBeNull();
    expect(findOwnerTag('quote: `' + TAG + '` and\n```\n' + TAG + '\n```')).toBeNull();
  });
});

describe('decisionProvenanceArg', () => {
  it('accepts agent and owner shapes and rejects owner without turnRef or extra keys', () => {
    expect(decisionProvenanceArg.safeParse({ kind: 'agent' }).success).toBe(true);
    expect(decisionProvenanceArg.safeParse({ kind: 'owner', turnRef: REF }).success).toBe(true);
    expect(decisionProvenanceArg.safeParse({ kind: 'owner' }).success).toBe(false);
    expect(decisionProvenanceArg.safeParse({ kind: 'agent', agentId: 'spoof' }).success).toBe(false);
  });
});

describe('resolveDecisionProvenance', () => {
  it('rule 1: default is agent kind with the CALLER identity', async () => {
    const r = await resolveDecisionProvenance(undefined, 'a body', ME, deps(null));
    expect(r).toEqual({ ok: true, provenance: { kind: 'agent', agentId: 'su-test-recorder' } });
  });
  it('rule 1 negative: an unattributable caller records no row instead of inventing an agent', async () => {
    const r = await resolveDecisionProvenance({ kind: 'agent' }, 'a body', {}, deps(null));
    expect(r).toMatchObject({ ok: true, provenance: null });
  });

  it('rule 2: owner kind with a turn that verifies as the owner is recorded with its verdict', async () => {
    const d = deps(verdict({ verdict: 'owner-dialog' }));
    const r = await resolveDecisionProvenance({ kind: 'owner', turnRef: REF }, 'body', ME, d);
    expect(r).toEqual({
      ok: true,
      provenance: { kind: 'owner', agentId: 'su-test-recorder', ownerTurnRef: REF, ownerTurnVerdict: 'owner-dialog' },
    });
    expect(d.calls).toEqual(['su-test-recorder']);
  });
  it('rule 2: a bare session@ts ref is accepted and normalised', async () => {
    const r = await resolveDecisionProvenance({ kind: 'owner', turnRef: 'abcdef12@2026-10-28T11:00:00.000Z' }, 'b', ME, deps(verdict({})));
    expect(r).toMatchObject({ ok: true, provenance: { kind: 'owner', ownerTurnRef: REF } });
  });
  it('rule 2 negative: a non-owner verdict is refused', async () => {
    const r = await resolveDecisionProvenance({ kind: 'owner', turnRef: REF }, 'b', ME, deps(verdict({ verdict: 'agent-injected' as never })));
    expect(r).toMatchObject({ ok: false, error: 'provenance_owner_turn_not_owner', field: 'provenance.turnRef' });
  });
  it('rule 2 negative: an unresolvable or unchecked turn is refused (owner needs positive evidence)', async () => {
    const notFound = await resolveDecisionProvenance({ kind: 'owner', turnRef: REF }, 'b', ME, deps(verdict({ found: false, verdict: null })));
    expect(notFound).toMatchObject({ ok: false, error: 'provenance_owner_turn_unverified' });
    const unchecked = await resolveDecisionProvenance({ kind: 'owner', turnRef: REF }, 'b', ME, deps(verdict({ found: false, checked: false, verdict: null })));
    expect(unchecked).toMatchObject({ ok: false, error: 'provenance_owner_turn_unverified' });
    const verifierDown: DecisionProvenanceDeps = { verify: async () => { throw new Error('io'); } };
    expect(await resolveDecisionProvenance({ kind: 'owner', turnRef: REF }, 'b', ME, verifierDown)).toMatchObject({ ok: false, error: 'provenance_owner_turn_unverified' });
  });
  it('rule 2 negative: an unparseable ref and an unattributable caller are refused', async () => {
    expect(await resolveDecisionProvenance({ kind: 'owner', turnRef: 'yesterday' }, 'b', ME, deps(verdict({})))).toMatchObject({
      ok: false,
      error: 'provenance_owner_turn_unparseable',
    });
    expect(await resolveDecisionProvenance({ kind: 'owner', turnRef: REF }, 'b', {}, deps(verdict({})))).toMatchObject({
      ok: false,
      error: 'provenance_unattributable',
    });
  });

  it('rule 3 negative: an owner tag in the body is refused unless provenance is owner', async () => {
    for (const arg of [undefined, { kind: 'agent' as const }]) {
      const r = await resolveDecisionProvenance(arg, `Decided ${TAG}.`, ME, deps(null));
      expect(r).toMatchObject({ ok: false, error: 'provenance_owner_tag_without_owner_kind', field: 'provenance' });
    }
  });
  it('rule 3: the same body is accepted with verified owner provenance, and a turn ref alone stays allowed', async () => {
    const owner = await resolveDecisionProvenance({ kind: 'owner', turnRef: REF }, `Decided ${TAG}.`, ME, deps(verdict({})));
    expect(owner).toMatchObject({ ok: true, provenance: { kind: 'owner' } });
    const cite = await resolveDecisionProvenance(undefined, `See ${REF} for context.`, ME, deps(null));
    expect(cite).toMatchObject({ ok: true, provenance: { kind: 'agent' } });
  });
});

describe('rowToView', () => {
  it('maps owner and agent rows', () => {
    const at = new Date('2026-10-28T12:00:00Z');
    expect(rowToView({ decision_id: 'D-001', kind: 'agent', owner_turn_ref: null, owner_turn_verdict: null, agent_id: 'a', source: 'write', recorded_at: at })).toEqual({
      kind: 'agent', agentId: 'a', source: 'write', recordedAt: '2026-10-28T12:00:00.000Z',
    });
    expect(rowToView({ decision_id: 'D-002', kind: 'owner', owner_turn_ref: REF, owner_turn_verdict: 'owner-typed', agent_id: 'a', source: 'conversion', recorded_at: at })).toMatchObject({
      kind: 'owner', ownerTurnRef: REF, ownerTurnVerdict: 'owner-typed', source: 'conversion',
    });
  });
});
