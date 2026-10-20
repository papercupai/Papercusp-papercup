/**
 * P-018 (D-027 §1, §2, §4): worn async-rule resolution, subscription/receipt
 * addressing, the live wearer read and the pure allowlist.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  declaredNeedCovers,
  identityReactionAllowlist,
  identityReactionReceiptId,
  identityRevisionTag,
  identityRuleSubscriberId,
  parseIdentityRuleSubscriberId,
  readIdentityWearer,
  wornAsyncRules,
} from './identity-async-rules';
import { SU_WEARER_ROLE, identityWearerRole } from './wearer-authority';
import { wornRulePins, type AppliedIdentityRules } from './sync-hook-rules';

const REVISION = 'a'.repeat(64);
const TARGET = { classId: 'demo.tasks', classVersion: '1.2.0', classRef: 'demo.tasks@1.2.0' };
const NO_CEILING = { ceilings: [], protectedAdditions: [] };

const rulePin = (ref: string, value: Record<string, unknown>) =>
  ({ kind: 'package', packageKind: 'rule', ref, revision: '1.0.0', contentHash: 'h', value: { ...value, ref } });
const meta = (id: string) => ({ id, title: id, description: `${id} rule`, version: '1.0.0' });

describe('wornAsyncRules', () => {
  it('keeps the async pins, attributed to the blueprint layer that depends on them', () => {
    const pins = wornRulePins({
      inputs: [
        { kind: 'package', packageKind: 'blueprint', ref: 'ops-identity', revision: '1', contentHash: 'b',
          dependencies: [{ packageKind: 'rule', ref: 'file-task' }] },
        rulePin('file-task', { ...meta('file-task'), delivery: 'async', on: 'demo.fired', fire: 'class:demo.tasks@1.2.0#create' }),
        rulePin('no-rm', { ...meta('no-rm'), delivery: 'sync', sink: 'pre-tool', guard: { deny: { 'input.command': { matches: 'rm -rf' } } } }),
        rulePin('broken', { ...meta('broken'), delivery: 'async' }),
      ],
    } as never);
    const worn = wornAsyncRules(pins);
    expect(worn.rules).toEqual([expect.objectContaining({
      identityId: 'ops-identity', pinRef: 'file-task', rule: expect.objectContaining({ on: 'demo.fired' }),
    })]);
    expect(worn.unreadable.map((entry) => entry.pinRef)).toEqual(['broken']);
  });
});

describe('addressing', () => {
  it('tags a hex specification revision by prefix and anything else by digest, always fixed-width', () => {
    expect(identityRevisionTag(REVISION)).toBe('a'.repeat(16));
    expect(identityRevisionTag('spec-owner')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('round-trips a subscriber id whatever the ownerId or ref contains', () => {
    const tag = identityRevisionTag(REVISION);
    for (const [ownerId, pinRef] of [['su-1', 'file-task'], ['harness:ops@x', 'scope:rule@2'], ['a', 'b:c']]) {
      const id = identityRuleSubscriberId(ownerId, tag, pinRef);
      expect(parseIdentityRuleSubscriberId(id, ownerId)).toEqual({ revisionTag: tag, pinRef });
    }
    const id = identityRuleSubscriberId('su-1', tag, 'file-task');
    expect(parseIdentityRuleSubscriberId(id, 'su-2')).toBeNull();
    expect(parseIdentityRuleSubscriberId('identity-rule:su-1@short:file-task', 'su-1')).toBeNull();
    expect(parseIdentityRuleSubscriberId(`identity-rule:su-1@${tag}:`, 'su-1')).toBeNull();
  });

  it('gives two wearers of one fire two receipts, and one wearer one receipt per fire', () => {
    const base = { fireId: 42, revisionTag: identityRevisionTag(REVISION), pinRef: 'file-task' };
    const first = identityReactionReceiptId({ ...base, ownerId: 'su-1' });
    expect(identityReactionReceiptId({ ...base, ownerId: 'su-2' })).not.toBe(first);
    expect(identityReactionReceiptId({ ...base, ownerId: 'su-1' })).toBe(first);
    expect(identityReactionReceiptId({ ...base, ownerId: 'su-1', fireId: 43 })).not.toBe(first);
  });
});

describe('readIdentityWearer', () => {
  const rules = { applied: { specificationRevision: REVISION, stateRevision: 's1' } } as AppliedIdentityRules;

  it('is null when the owner has no applied identity (detached), without reading an artifact', async () => {
    const rulesAt = vi.fn();
    for (const anchor of [null, { applied: null, harnessSlug: 'ops' }]) {
      expect(await readIdentityWearer('su-1', 'ws', { readAnchor: async () => anchor, rulesAt })).toBeNull();
    }
    expect(rulesAt).not.toHaveBeenCalled();
  });

  it('resolves the live wearer at the anchor\'s applied revision', async () => {
    const rulesAt = vi.fn(async () => rules);
    const wearer = await readIdentityWearer('su-1', 'ws', {
      readAnchor: async () => ({ applied: rules.applied, harnessSlug: 'ops' }), rulesAt,
    });
    expect(rulesAt).toHaveBeenCalledWith('su-1', 'ws', rules.applied);
    expect(wearer).toEqual({
      ownerId: 'su-1', workspaceId: 'ws', role: SU_WEARER_ROLE, harnessSlug: 'ops',
      revisionTag: 'a'.repeat(16), rules,
    });
  });

  // identity-system-everything-migration-2026-10-18 P-003: a non-su launch record's role
  // is the wearer's role; a role-less (SU) record stays su.
  it('takes the wearer role from its identity-bearing launch record', async () => {
    const read = (launchRecord: unknown) => readIdentityWearer('judge-1', 'ws', {
      readAnchor: async () => ({ applied: rules.applied, harnessSlug: 'ops', launchRecord }),
      rulesAt: async () => rules,
    });
    expect((await read({ role: 'judge' }))?.role).toBe('judge');
    expect((await read({ role: null }))?.role).toBe(SU_WEARER_ROLE);
    expect((await read({ role: '  ' }))?.role).toBe(SU_WEARER_ROLE);
    expect(identityWearerRole(undefined)).toBe(SU_WEARER_ROLE);
    expect(identityWearerRole({ v: 1, agent: 'claude', profile: 'engineer' })).toBe(SU_WEARER_ROLE);
  });

  it('throws a lookup failure instead of reading it as detached', async () => {
    await expect(readIdentityWearer('su-1', 'ws', {
      readAnchor: async () => ({ applied: rules.applied, harnessSlug: 'ops' }),
      rulesAt: async () => { throw new Error('applied identity artifact unreadable'); },
    })).rejects.toThrow('unreadable');
    await expect(readIdentityWearer('su-1', 'ws', {
      readAnchor: async () => { throw new Error('connection closed'); },
    })).rejects.toThrow('connection closed');
  });
});

describe('identityReactionAllowlist (D-008)', () => {
  it('is exactly the class verb capability when nothing narrows it', () => {
    expect(identityReactionAllowlist({
      capability: 'tasks:write', target: TARGET, declaredClassNeeds: null, ceiling: NO_CEILING,
    })).toEqual({ ok: true, capabilities: ['tasks:write'] });
  });

  it('honours an identity\'s declared needs, exact or by major', () => {
    expect(declaredNeedCovers('demo.tasks@1', TARGET)).toBe(true);
    expect(declaredNeedCovers('demo.tasks@1.2.0', TARGET)).toBe(true);
    expect(declaredNeedCovers('demo.tasks@2', TARGET)).toBe(false);
    expect(declaredNeedCovers('demo.other@1', TARGET)).toBe(false);
    expect(identityReactionAllowlist({
      capability: 'tasks:write', target: TARGET, declaredClassNeeds: ['crm.email@1.0.0'], ceiling: NO_CEILING,
    })).toMatchObject({ ok: false, code: 'capability-empty', reason: expect.stringContaining('demo.tasks@1.2.0') });
  });

  it('refuses a never-auto protected capability even for the su role, and runtime additions too', () => {
    expect(identityReactionAllowlist({
      capability: 'secrets:read', target: TARGET, declaredClassNeeds: null, ceiling: NO_CEILING,
    })).toMatchObject({ ok: false, code: 'capability-empty' });
    expect(identityReactionAllowlist({
      capability: 'billing:charge', target: TARGET, declaredClassNeeds: null,
      ceiling: { ceilings: [], protectedAdditions: ['billing:*'] },
    })).toMatchObject({ ok: false, code: 'capability-empty' });
  });

  it('applies every pot/role ceiling: a deny, or an allowlist that does not name it, empties it', () => {
    const run = (ceilings: { allowCapabilities?: string[]; denyCapabilities?: string[] }[]) =>
      identityReactionAllowlist({ capability: 'tasks:write', target: TARGET, declaredClassNeeds: null,
        ceiling: { ceilings, protectedAdditions: [] } });
    expect(run([{ allowCapabilities: ['tasks:*'] }, {}])).toEqual({ ok: true, capabilities: ['tasks:write'] });
    expect(run([{ denyCapabilities: ['tasks:*'] }])).toMatchObject({ ok: false, code: 'capability-empty' });
    expect(run([{ allowCapabilities: ['tasks:*'] }, { allowCapabilities: ['mail:send'] }]))
      .toMatchObject({ ok: false, code: 'capability-empty' });
  });

  it('refuses a verb with no capability rather than inventing one', () => {
    expect(identityReactionAllowlist({
      capability: '  ', target: TARGET, declaredClassNeeds: null, ceiling: NO_CEILING,
    })).toMatchObject({ ok: false, code: 'capability-empty' });
  });
});
