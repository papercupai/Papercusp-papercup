/**
 * `socialAdminFacts` unit tests, focused on the write-only platform case (P-021).
 *
 * The function is pure and exported "for direct testing", but until now was
 * only exercised through the admin snapshot integration test — which needs a
 * database and therefore did not run on the fast lane. The behaviour under test
 * here is a UI-correctness rule that has already been got wrong once at a lower
 * level (D-050), so it is worth pinning where it is cheap to run.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { socialAdminFacts as projectSocialAdminFacts } from './admin';
import { installDefaultSocialPackages, installSocialPackages } from '../capability-verbs/social-provider.fixture';
import { providerRegistry } from '../integrations/provider-registry';

const registry = providerRegistry();
const socialAdminFacts = (kind: string, cursor: unknown, nowMs: number) => projectSocialAdminFacts(kind, cursor, nowMs, registry);
beforeEach(installDefaultSocialPackages);
afterEach(() => registry.clear());

const NOW = Date.parse('2026-08-23T12:00:00.000Z');

describe('installed package rate budgets', () => {
  it('uses the current descriptor after unload and same-id replacement', async () => {
    expect(socialAdminFacts('reddit', {}, NOW)?.rateBudget).toMatchObject({ maxRuns: 30, basis: 'rate-budget' });
    registry.unregister('reddit');
    expect(socialAdminFacts('reddit', {}, NOW)).toBeNull();
    await installSocialPackages([{ platform: 'reddit', rateBudget: {
      verifiedAt: '2026-08-23', sources: ['https://example.test/limits'], requestsPerMinute: 2,
    } }], registry);
    expect(socialAdminFacts('reddit', {}, NOW)?.rateBudget).toMatchObject({ maxRuns: 1, basis: 'rate-budget' });
  });

  it('derives budgets for a newly installed provider without adding an app-side row', async () => {
    await installSocialPackages([{ platform: 'new-social-provider', rateBudget: {
      verifiedAt: '2026-08-23', sources: ['https://example.test/limits'], requestsPerMinute: 100,
    } }], registry);
    expect(socialAdminFacts('new-social-provider', {}, NOW)?.rateBudget).toMatchObject({ maxRuns: 50, basis: 'rate-budget' });
  });
});

describe('socialAdminFacts', () => {
  it('returns null for a kind the registry does not know', () => {
    // The pane's correctness rests on this: a gmail or slack source must never
    // pick up a social platform's rate budget by accident.
    expect(socialAdminFacts('gmail', {}, NOW)).toBeNull();
    expect(socialAdminFacts('slack', {}, NOW)).toBeNull();
  });

  describe('a write-only platform (linkedin)', () => {
    it('reports the cursor as not-readable rather than never-synced', () => {
      // THE D-050 rule applied one level up. LinkedIn will NEVER reconcile,
      // because no content read scope is available to us at any tier — so
      // `never-synced` would be permanently true, permanently alarming on the
      // owner's pane, and not actionable by anyone. The two states look
      // identical to a reader and mean opposite things: "nobody has run this
      // yet" versus "this can never run".
      const facts = socialAdminFacts('linkedin', {}, NOW);
      expect(facts).not.toBeNull();
      expect(facts!.cursor.state).toBe('not-readable');
      expect(facts!.cursor.at).toBeNull();
      expect(facts!.cursor.ageMs).toBeNull();
      expect(facts!.cursor.detail).toMatch(/write-only/i);
    });

    it('reports a null readTransport, distinct from an unknown one', () => {
      const facts = socialAdminFacts('linkedin', {}, NOW);
      expect(facts!.readTransport).toBeNull();
    });

    it('stays not-readable even when a cursor somehow got persisted', () => {
      // Defensive, and not hypothetical: a source row is created with `{}` and
      // could be written by a future code path before anyone notices the
      // platform cannot be read. The PLATFORM fact must win over the row's
      // contents, or the pane would start reporting sync health for a stream
      // that does not exist.
      const facts = socialAdminFacts('linkedin', { watermark: '2026-08-23T11:00:00.000Z' }, NOW);
      expect(facts!.cursor.state).toBe('not-readable');
    });

    it('still reports the write half, which is the half that works', () => {
      const facts = socialAdminFacts('linkedin', {}, NOW);
      expect(facts!.writeVerified).toBe(true);
      expect(facts!.writeVerbs).toEqual(['post', 'delete']);
      // Reply is absent — the platform limitation, surfaced to the owner.
      expect(facts!.writeVerbs).not.toContain('reply');
    });

    it('reports NO blockedOn, because the verbs it declares are not blocked', () => {
      // `blockedOn` is a hard usability gate, not a notes field:
      // `assertSocialPlatformUsable` throws on any row carrying one. LinkedIn's
      // post path is self-serve and verified, so a blockedOn here would have
      // disabled a working adapter at runtime while the unit tests stayed green.
      //
      // The consequence for the pane is a real gap and is recorded as such: the
      // 60-day re-authorisation is an operational caveat an owner would want,
      // and `blockedOn` is currently the only prose channel the pane renders —
      // so there is nowhere for a USABLE-but-caveated platform to say it.
      const facts = socialAdminFacts('linkedin', {}, NOW);
      expect(facts!.blockedOn).toBeNull();
      // It is usable, which is the fact that matters for the adapter.
      expect(facts!.verified).toBe(true);
    });
  });

  describe('a readable provider uses host sync progress', () => {
    it('reports never-synced for a cold readable source', () => {
      // The control for the write-only case above: if this ALSO returned
      // not-readable, the new branch would be swallowing every platform and the
      // assertions above would pass for the wrong reason.
      const facts = socialAdminFacts('reddit', {}, NOW);
      expect(facts).not.toBeNull();
      expect(facts!.cursor.state).toBe('never-synced');
      expect(facts!.readTransport).toBe('poll');
    });

    it('reports position-only without interpreting an opaque provider cursor', () => {
      const facts = socialAdminFacts('reddit', { provider: 'opaque:t3_abc' }, NOW);
      expect(facts!.cursor.state).toBe('position-only');
      expect(facts!.cursor.position).toBe('opaque:t3_abc');
    });

    it.each([null, undefined, {}, { provider: null }])('treats cold cursor %j as never-synced', (cursor) => {
      expect(socialAdminFacts('reddit', cursor, NOW)!.cursor).toMatchObject({
        state: 'never-synced', at: null, ageMs: null, position: null,
      });
    });

    it.each([
      { watermark: '2026-08-23T11:00:00Z', boundaryIds: ['m1'] },
      { newestFullname: 't3_abc' },
      { providerSync: { lastSyncedAt: '2026-08-23T11:00:00Z' } },
      { futureCursor: 'unknown' },
      [],
      'opaque-without-host-envelope',
    ])('reports nonempty or malformed cursor %j as unknown, never fresh', (cursor) => {
      expect(socialAdminFacts('reddit', cursor, NOW)!.cursor).toMatchObject({
        state: 'unrecognized', at: null, ageMs: null, position: null,
      });
    });
  });

  it('keeps the registry as the single source of the read/write split', () => {
    // Guards against the two facts drifting apart in different files: the pane
    // must report exactly what the row declares.
    const descriptor = registry.get('linkedin')!.descriptor;
    const facts = socialAdminFacts('linkedin', {}, NOW);
    expect(facts!.writeVerbs).toEqual(descriptor.capabilities.map((capability) => capability.slice('social.'.length)));
  });

  it('shows generic provider sync freshness and retained loss evidence (P-032)', () => {
    const lossRisk = { kind: 'retention-window-exceeded' as const, oldestReachableAt: '2026-08-20T00:00:00Z', detail: 'Older events are no longer reachable' };
    const facts = socialAdminFacts('reddit', { provider: 'opaque:v2:position',
      providerSync: { lastSyncedAt: '2026-08-23T11:00:00Z', lossRisk } }, NOW);
    expect(facts!.cursor).toMatchObject({ state: 'synced', at: '2026-08-23T11:00:00Z', ageMs: 3_600_000, lossRisk });
    expect(socialAdminFacts('reddit', { provider: 'any-new-cursor-shape' }, NOW)!.cursor.state).toBe('position-only');
  });

  it('keeps host sync time after an empty terminal page and exposes clock skew', () => {
    expect(socialAdminFacts('reddit', { provider: null,
      providerSync: { lastSyncedAt: '2026-08-23T13:00:00Z' } }, NOW)!.cursor)
      .toMatchObject({ state: 'synced', ageMs: -3_600_000, position: null });
  });

  it('does not surface malformed loss evidence as a confirmed provider gap', () => {
    const facts = socialAdminFacts('reddit', { provider: 'opaque', providerSync: {
      lastSyncedAt: 'invalid', lossRisk: { kind: 'retention-window-exceeded' },
    } }, NOW);
    expect(facts!.cursor).toMatchObject({ state: 'position-only', at: null, ageMs: null });
    expect(facts!.cursor).not.toHaveProperty('lossRisk');
  });

  it('uses the actual X package wall and contract verification instead of the obsolete curated row', () => {
    const descriptor = registry.get('x-twitter')!.descriptor;
    expect(socialAdminFacts('x-twitter', {}, NOW)).toMatchObject({
      label: descriptor.displayName,
      verified: true,
      blockedOn: descriptor.verification!.blockedOn,
      writeVerbs: ['post', 'reply', 'delete'],
    });
  });

  it('never fills an empty capability list or absent attestation from legacy rows', async () => {
    expect(socialAdminFacts('tiktok', {}, NOW)).toMatchObject({ writeVerbs: [], writeVerified: false });
    registry.unregister('reddit');
    await installSocialPackages([{ platform: 'reddit', verification: { verifiedAt: null, sources: [] } }], registry);
    expect(socialAdminFacts('reddit', {}, NOW)).toMatchObject({ verified: false, writeVerified: false });
  });

  it('discovers arbitrary installed social providers and removes their facts on unload', async () => {
    await installSocialPackages([{ platform: 'new-social', capabilities: ['social.post'] }], registry);
    expect(socialAdminFacts('new-social', { provider: 'opaque' }, NOW)).toMatchObject({
      platformId: 'new-social', writeVerbs: ['post'], verified: true,
      cursor: { state: 'position-only' }, rateBudget: { maxRuns: 12, windowSeconds: 300, basis: 'conservative-default' },
    });
    registry.unregister('new-social');
    registry.unregister('reddit');
    expect(socialAdminFacts('new-social', {}, NOW)).toBeNull();
    expect(socialAdminFacts('reddit', {}, NOW)).toBeNull();
  });

  it('reports the installed Mastodon HTTP sync instead of the retired streaming contract', () => {
    expect(socialAdminFacts('mastodon', {}, NOW)).toMatchObject({
      readTransport: 'poll', cursor: { state: 'never-synced' },
    });
    expect(socialAdminFacts('mastodon', {}, NOW)).not.toHaveProperty('wave');
  });

  it('reads sync support again after same-id replacement without a vendor branch', async () => {
    const original = registry.get('linkedin')!;
    const replace = async (sync: boolean) => {
      registry.unregister('linkedin');
      const descriptor = { ...original.descriptor, sync };
      await registry.register({ ...original, descriptor, adapter: { ...original.adapter, describe: () => descriptor } });
    };
    await replace(true);
    expect(socialAdminFacts('linkedin', {}, NOW)).toMatchObject({ readTransport: 'poll', cursor: { state: 'never-synced' } });
    await replace(false);
    expect(socialAdminFacts('linkedin', {}, NOW)).toMatchObject({ readTransport: null, cursor: { state: 'not-readable' } });

    await installSocialPackages([{ platform: 'arbitrary-write-only' }], registry);
    const entry = registry.get('arbitrary-write-only')!;
    registry.unregister('arbitrary-write-only');
    const descriptor = { ...entry.descriptor, sync: false };
    await registry.register({ ...entry, descriptor, adapter: { ...entry.adapter, describe: () => descriptor } });
    expect(socialAdminFacts('arbitrary-write-only', { provider: 'opaque' }, NOW))
      .toMatchObject({ readTransport: null, cursor: { state: 'not-readable' } });
  });
});
