/**
 * session-brief.test.ts — unit coverage for the durable successor-brief adapter (EI-1742).
 *
 * Mocks @papercusp/db-org's getOrgPg with a fake tagged-template `sql` (no PG needed).
 * The load-bearing contract is the BEST-EFFORT isolation: writeSessionBrief must NEVER
 * throw (it rides the hot presence write path), and getSessionBrief must degrade to null
 * — a brief failure can never affect coord:declare-intent / presence. Uses the
 * importOriginal spread form (TESTING.md EI-362) so generated.* stays intact.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Swappable fake `sql` tagged template; each test sets it before exercising the module.
let fakeSql: (strings: TemplateStringsArray, ...vals: unknown[]) => unknown = () =>
  Promise.resolve([]);

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => ({
    sql: Object.assign(
      (s: TemplateStringsArray, ...v: unknown[]) => fakeSql(s, ...v),
      { begin: vi.fn() },
    ),
  }),
}));

import {
  attestLifecycleConsumerView,
  clearSessionBriefReleasedForFleet,
  clearPendingCarryRespawn,
  consumePendingCarryRespawn,
  getSessionBriefAmbientExcludedRefs,
  getSessionBrief,
  getSessionBriefLifecycle,
  markSessionBriefPoisoned,
  markSessionBriefReleased,
  markSessionBriefShutdown,
  PENDING_CARRY_RESPAWN_TTL_MS,
  restorePendingCarryRespawn,
  savePendingCarryRespawn,
  writeSessionBrief,
} from './session-brief';
import type { PendingCarryRespawn } from './session-brief';
import type { AgentIdentity } from './agent-tools/coordination/identity';

const identity: AgentIdentity = {
  ownerId: 'su-test-ei1742',
  ownerLabel: 'su · test',
  source: 'omp-hook-session',
  workspaceId: 'papercusp-workspace',
  userId: null,
};

/** A fake `sql` that records each call's interpolated values and returns `rows`. */
function recordingSql(rows: unknown[] = []) {
  const calls: unknown[][] = [];
  const statements: string[] = [];
  const sql = (_s: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push(vals);
    statements.push(_s.join(' ? '));
    return Promise.resolve(rows);
  };
  return { sql, calls, statements };
}

afterEach(() => {
  fakeSql = () => Promise.resolve([]);
  vi.restoreAllMocks();
});

describe('writeSessionBrief (best-effort upsert)', () => {
  it('swallows a throwing sql — never throws (the isolation contract)', async () => {
    fakeSql = () => {
      throw new Error('db exploded mid-presence-write');
    };
    await expect(
      writeSessionBrief(identity, { intent: 'x' }),
    ).resolves.toBeUndefined();
  });

  it('swallows a rejected-promise sql too', async () => {
    fakeSql = () => Promise.reject(new Error('connection reset'));
    await expect(writeSessionBrief(identity, { intent: 'x' })).resolves.toBeUndefined();
  });

  it('no-ops (no sql call) when ownerId is missing', async () => {
    const rec = recordingSql();
    fakeSql = rec.sql;
    await writeSessionBrief({ ...identity, ownerId: '' }, { intent: 'x' });
    expect(rec.calls).toHaveLength(0);
  });

  it('issues one upsert with the identity + brief fields interpolated', async () => {
    const rec = recordingSql();
    fakeSql = rec.sql;
    await writeSessionBrief(identity, {
      intent: 'shipping EI-1742',
      currentPlanSlug: 'plan-x',
      currentFiles: ['a.ts', 'b.ts'],
      harnessSlug: 'papercusp',
      potSlug: null,
    });
    expect(rec.calls).toHaveLength(1);
    const vals = rec.calls[0];
    expect(vals).toContain('su-test-ei1742');
    expect(vals).toContain('shipping EI-1742');
    expect(vals).toContain('plan-x');
    // current_files is serialized to a JSON string before the ::jsonb cast.
    expect(vals).toContain(JSON.stringify(['a.ts', 'b.ts']));
  });

  /**
   * EI-18776963284535761 — the brief carries the SAME omitted-means-untouched sentinel
   * as coord_presence: a write that omits currentFiles must bind NULL (which the query
   * COALESCEs to the stored value), never the literal '[]' that would wipe it. This one
   * matters doubly because the brief is what a SUCCESSOR reads after its predecessor
   * dies — a wipe here loses the declared lane exactly when it is most needed.
   */
  it('omitting currentFiles binds no "[]" literal (the untouched sentinel)', async () => {
    const rec = recordingSql();
    fakeSql = rec.sql;
    await writeSessionBrief(identity, { intent: 'a bare re-declare' });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).not.toContain('[]');
  });

  it('an explicit [] DOES bind "[]" (a real clear)', async () => {
    const rec = recordingSql();
    fakeSql = rec.sql;
    await writeSessionBrief(identity, { intent: 'off those files', currentFiles: [] });
    expect(rec.calls[0]).toContain('[]');
  });

  it('omitting ambientExcludedRefs binds the untouched NULL sentinel', async () => {
    const rec = recordingSql();
    fakeSql = rec.sql;
    await writeSessionBrief(identity, { intent: 'keep the existing fence' });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).not.toContain('[]');
  });

  it('an explicit ambientExcludedRefs list is serialized verbatim for the JSONB cast', async () => {
    const rec = recordingSql();
    fakeSql = rec.sql;
    await writeSessionBrief(identity, {
      intent: 'exclude held-out refs',
      ambientExcludedRefs: ['WI-40293', 'EI-21096338043071922'],
    });
    expect(rec.calls[0]).toContain(JSON.stringify(['WI-40293', 'EI-21096338043071922']));
  });

  it('an explicit empty ambientExcludedRefs list is a real clear', async () => {
    const rec = recordingSql();
    fakeSql = rec.sql;
    await writeSessionBrief(identity, { intent: 'clear the fence', ambientExcludedRefs: [] });
    expect(rec.calls[0]).toContain('[]');
  });
});

describe('getSessionBrief (fail-soft read)', () => {
  it('returns null when neither ownerId nor nativeSessionId is given', async () => {
    const rec = recordingSql([{ owner_id: 'x' }]);
    fakeSql = rec.sql;
    expect(await getSessionBrief({})).toBeNull();
    expect(rec.calls).toHaveLength(0); // never queries without a key
  });

  it('returns null (not throw) when sql errors', async () => {
    fakeSql = () => Promise.reject(new Error('boom'));
    expect(await getSessionBrief({ ownerId: 'su-test-ei1742' })).toBeNull();
  });

  it('returns null when the owner has no brief row', async () => {
    fakeSql = recordingSql([]).sql;
    expect(await getSessionBrief({ ownerId: 'nobody' })).toBeNull();
  });

  it('maps a row to a SessionBriefRecord (by ownerId)', async () => {
    fakeSql = recordingSql([
      {
        owner_id: 'su-test-ei1742',
        workspace_id: 'papercusp-workspace',
        owner_label: 'su · test',
        source: 'omp-hook-session',
        intent: 'continue the lane',
        current_plan_slug: 'plan-x',
        current_files: ['a.ts'],
        ambient_excluded_refs: [' WI-40293 ', 'WI-40293', 'EI-21096338043071922'],
        harness_slug: 'papercusp',
        hive_slug: null,
        native_session_id: null,
        first_seen_at: '2026-06-20T00:00:00Z',
        updated_at: '2026-06-20T05:00:00Z',
      },
    ]).sql;
    const rec = await getSessionBrief({ ownerId: 'su-test-ei1742' });
    expect(rec).not.toBeNull();
    expect(rec?.ownerId).toBe('su-test-ei1742');
    expect(rec?.intent).toBe('continue the lane');
    expect(rec?.currentPlanSlug).toBe('plan-x');
    expect(rec?.currentFiles).toEqual(['a.ts']);
    expect(rec?.ambientExcludedRefs).toEqual(['WI-40293', 'EI-21096338043071922']);
    expect(rec?.updatedAt).toBe('2026-06-20T05:00:00Z');
  });

  it('queries by native_session_id when only that is given', async () => {
    const rec = recordingSql([]);
    fakeSql = rec.sql;
    await getSessionBrief({ nativeSessionId: '6b161799-abcd' });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).toContain('6b161799-abcd');
  });

  it('reads a typed release marker from control_state', async () => {
    fakeSql = recordingSql([
      {
        control_state: {
          lifecycle: { released: { fleet: 'backend', at: '2026-08-20T10:00:00Z', by: 'su-leader' } },
        },
      },
    ]).sql;
    await expect(getSessionBriefLifecycle('su-test-ei1742')).resolves.toEqual({
      released: { fleet: 'backend', at: '2026-08-20T10:00:00Z', by: 'su-leader' },
    });
  });

  it('ignores malformed release markers', async () => {
    fakeSql = recordingSql([{ control_state: { lifecycle: { released: { fleet: '' } } } }]).sql;
    await expect(getSessionBriefLifecycle('su-test-ei1742')).resolves.toBeNull();
  });

  it('reads an accepted managed-shutdown cutoff alongside the existing lifecycle markers', async () => {
    const shutdown = { at: '2026-10-06T22:07:55.842Z', by: identity.ownerId };
    const released = { fleet: 'backend', at: '2026-08-20T10:00:00Z', by: 'su-leader' };
    fakeSql = recordingSql([{ control_state: { lifecycle: { shutdown, released } } }]).sql;
    await expect(getSessionBriefLifecycle(identity.ownerId)).resolves.toEqual({ shutdown, released });
  });

  it.each([{ at: 'not-a-date', by: identity.ownerId }, { at: '2026-10-06T22:07:55.842Z', by: '' }])
    ('does not turn malformed shutdown metadata into a terminal cutoff: %j', async (shutdown) => {
      fakeSql = recordingSql([{ control_state: { lifecycle: { shutdown } } }]).sql;
      await expect(getSessionBriefLifecycle(identity.ownerId)).resolves.toBeNull();
    });

  it('writes the cutoff into the existing control envelope, preserving sibling markers and attesting the consumer', async () => {
    const shutdown = { at: '2026-10-06T22:07:55.842Z', by: identity.ownerId };
    const rec = recordingSql([{ control_state: { lifecycle: { shutdown } } }]);
    fakeSql = rec.sql;
    await expect(markSessionBriefShutdown(identity.ownerId, 'ws-1', shutdown)).resolves.toBe(true);
    expect(rec.calls[0]).toContain(JSON.stringify(shutdown));
    // Setting the parent creates lifecycle even on an existing empty brief;
    // JSONB merge keeps release/poison/control metadata rather than replacing it.
    expect(rec.statements[0]).toContain("'{lifecycle}'");
    expect(rec.statements[0]).toContain("|| (EXCLUDED.control_state->'lifecycle')");
    expect(rec.statements[0]).toContain('control_transition = CASE');
    expect(rec.statements[0]).toContain('IS DISTINCT FROM');
  });

  it('refuses a foreign shutdown writer and flags an unreadable consumer result', async () => {
    const shutdown = { at: '2026-10-06T22:07:55.842Z', by: identity.ownerId };
    const rec = recordingSql([{ control_state: { shutdown } }]);
    fakeSql = rec.sql;
    await expect(markSessionBriefShutdown(identity.ownerId, 'ws-1', { ...shutdown, by: 'su-other' })).resolves.toBe(false);
    expect(rec.calls).toHaveLength(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(markSessionBriefShutdown(identity.ownerId, 'ws-1', shutdown)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('shutdown marker write'));
  });

  it('reports persistence exceptions instead of hiding their cause behind a false receipt', async () => {
    fakeSql = () => { throw new Error('fixture SQL failure'); };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(markSessionBriefShutdown(identity.ownerId, 'ws-1', {
      at: '2026-10-06T22:07:55.842Z', by: identity.ownerId,
    })).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fixture SQL failure'));
  });

  it('reads release and poison markers from the shared lifecycle envelope', async () => {
    const released = { fleet: 'backend', at: '2026-08-20T10:00:00Z', by: 'su-leader' };
    const poisoned = {
      advSessionId: 77,
      sessionId: 'native-77',
      startedAt: '2026-09-24T10:00:00.123456Z',
      at: '2026-09-24T10:04:00.000Z',
      by: 'resume-turn-detector',
      reason: 'three consecutive unavailable tool references',
      evidence: "API Error: 400 Tool reference 'mcp__papercusp-su__plans_audit' not found in available tools",
    };
    fakeSql = recordingSql([{ control_state: { lifecycle: { released, poisoned } } }]).sql;
    await expect(getSessionBriefLifecycle('su-test-ei1742')).resolves.toEqual({ released, poisoned });
  });

  const poisonMarker = {
    advSessionId: 77,
    sessionId: 'native-77',
    startedAt: '2026-09-24T10:00:00.123456Z',
    at: '2026-09-24T10:04:00.000Z',
    by: 'resume-turn-detector',
    reason: 'three consecutive unavailable tool references',
    evidence: "API Error: 400 Tool reference 'mcp__papercusp-su__plans_audit' not found in available tools",
  };

  it('writes a bounded poison marker for an exact adv-session incarnation', async () => {
    const rec = recordingSql([{ control_state: { lifecycle: { poisoned: poisonMarker } } }]);
    fakeSql = rec.sql;
    await expect(markSessionBriefPoisoned('su-member', 'ws-1', poisonMarker)).resolves.toBe(true);
    expect(rec.calls[0]).toEqual(expect.arrayContaining(['su-member', 'ws-1']));
    expect(rec.calls[0]).toContain(JSON.stringify(poisonMarker));
  });

  it('reports failure — and logs the consumer view — when the stored poison marker is unreadable by the stop gate (WI-10005195)', async () => {
    // The upsert "landed" (a row came back) but its marker lacks `evidence`, so
    // parseSessionBriefLifecycle — the stop gate's read — drops it: the write
    // succeeded and the consumer still sees NO poison marker.
    const { evidence: _dropped, ...unreadable } = poisonMarker;
    fakeSql = recordingSql([{ control_state: { lifecycle: { poisoned: unreadable } } }]).sql;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(markSessionBriefPoisoned('su-member', 'ws-1', poisonMarker)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('poisoned marker write for su-member');
    expect(line).toContain('"divergedFromWrite":true');
    expect(line).toContain('"value":null');
  });

  it('is exception-only: an agreeing poison read stays silent', async () => {
    fakeSql = recordingSql([{ control_state: { lifecycle: { poisoned: poisonMarker } } }]).sql;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(markSessionBriefPoisoned('su-member', 'ws-1', poisonMarker)).resolves.toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('attestLifecycleConsumerView (consumer-attested lifecycle writes, WI-10005195)', () => {
  const released = { fleet: 'backend', at: '2026-08-20T10:00:00Z', by: 'su-leader' };

  it('agrees when the consumer parser returns exactly the written marker', () => {
    expect(
      attestLifecycleConsumerView('released', released, { lifecycle: { released } }),
    ).toEqual({
      readPath: 'session_briefs.control_state -> parseSessionBriefLifecycle().released',
      value: released,
      divergedFromWrite: false,
    });
  });

  it('diverges when the row has the marker at a path the consumer does not read', () => {
    // Decoy placement: marker stored beside, not under, control_state.lifecycle.
    const view = attestLifecycleConsumerView('released', released, { released });
    expect(view.value).toBeNull();
    expect(view.divergedFromWrite).toBe(true);
  });

  it('diverges when the consumer sees a DIFFERENT marker than the one written', () => {
    const view = attestLifecycleConsumerView('released', released, {
      lifecycle: { released: { ...released, fleet: 'other-fleet' } },
    });
    expect(view.value).toEqual({ ...released, fleet: 'other-fleet' });
    expect(view.divergedFromWrite).toBe(true);
  });

  it('diverges when the RETURNING row is missing (nothing the consumer could read)', () => {
    expect(attestLifecycleConsumerView('released', released, undefined).divergedFromWrite).toBe(true);
  });
});

describe('getSessionBriefAmbientExcludedRefs (durable retrieval fence)', () => {
  it('treats a missing row as an available empty fence', async () => {
    fakeSql = recordingSql([]).sql;
    await expect(getSessionBriefAmbientExcludedRefs('su-test-ei1742')).resolves.toEqual({
      available: true,
      refs: new Set(),
    });
  });

  it('treats a legacy NULL column as an available empty fence', async () => {
    fakeSql = recordingSql([{ ambient_excluded_refs: null }]).sql;
    await expect(getSessionBriefAmbientExcludedRefs('su-test-ei1742')).resolves.toEqual({
      available: true,
      refs: new Set(),
    });
  });

  it('normalizes a valid stored list into a de-duplicated set', async () => {
    fakeSql = recordingSql([
      { ambient_excluded_refs: [' WI-40293 ', 'WI-40293', 'EI-21096338043071922'] },
    ]).sql;
    await expect(getSessionBriefAmbientExcludedRefs('su-test-ei1742')).resolves.toEqual({
      available: true,
      refs: new Set(['WI-40293', 'EI-21096338043071922']),
    });
  });

  it('fails closed when the stored fence is malformed', async () => {
    fakeSql = recordingSql([{ ambient_excluded_refs: ['WI-40293', 42] }]).sql;
    await expect(getSessionBriefAmbientExcludedRefs('su-test-ei1742')).resolves.toEqual({
      available: false,
      refs: new Set(),
    });
  });

  it('fails closed when the fence read errors', async () => {
    fakeSql = () => Promise.reject(new Error('session brief database unavailable'));
    await expect(getSessionBriefAmbientExcludedRefs('su-test-ei1742')).resolves.toEqual({
      available: false,
      refs: new Set(),
    });
  });

  it('fails closed without querying when the owner id is empty', async () => {
    const rec = recordingSql([{ ambient_excluded_refs: ['WI-40293'] }]);
    fakeSql = rec.sql;
    await expect(getSessionBriefAmbientExcludedRefs('')).resolves.toEqual({
      available: false,
      refs: new Set(),
    });
    expect(rec.calls).toHaveLength(0);
  });
});

describe('fleet release lifecycle helpers (EI-203843)', () => {
  it('marks a member with the durable fleet/freshness/actor tuple', async () => {
    const released = { fleet: 'backend', at: '2026-08-20T10:00:00Z', by: 'su-leader' };
    const rec = recordingSql([{ control_state: { lifecycle: { released } } }]);
    fakeSql = rec.sql;
    await expect(markSessionBriefReleased('su-member', 'ws-1', released)).resolves.toBe(true);
    expect(rec.calls[0]).toEqual(expect.arrayContaining(['su-member', 'ws-1']));
    expect(rec.calls[0]).toContain(JSON.stringify(released));
  });

  it('reports failure — and logs the consumer view — when the stored release marker is unreadable by the stop gate (WI-10005195)', async () => {
    // Upsert returned a row, but its marker's `by` is empty so the stop gate's
    // parser drops it; before this attestation the write still reported `true`.
    fakeSql = recordingSql([
      { control_state: { lifecycle: { released: { fleet: 'backend', at: '2026-08-20T10:00:00Z', by: '' } } } },
    ]).sql;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      markSessionBriefReleased('su-member', 'ws-1', {
        fleet: 'backend',
        at: '2026-08-20T10:00:00Z',
        by: 'su-leader',
      }),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('"divergedFromWrite":true');
  });

  it('is exception-only: an agreeing release read stays silent', async () => {
    const released = { fleet: 'backend', at: '2026-08-20T10:00:00Z', by: 'su-leader' };
    fakeSql = recordingSql([{ control_state: { lifecycle: { released } } }]).sql;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(markSessionBriefReleased('su-member', 'ws-1', released)).resolves.toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('clears only rows matching the resumed workspace and fleet', async () => {
    const rec = recordingSql([{ owner_id: 'su-member' }]);
    fakeSql = rec.sql;
    await expect(clearSessionBriefReleasedForFleet('ws-1', 'backend')).resolves.toBe(1);
    expect(rec.calls[0]).toEqual(expect.arrayContaining(['ws-1', 'backend']));
  });

  it('keeps lifecycle writes fail-soft', async () => {
    fakeSql = () => Promise.reject(new Error('db unavailable'));
    await expect(
      markSessionBriefReleased('su-member', 'ws-1', { fleet: 'backend', at: 'now', by: 'leader' }),
    ).resolves.toBe(false);
    await expect(clearSessionBriefReleasedForFleet('ws-1', 'backend')).resolves.toBe(0);
  });
});

describe('pending carry-respawn session-brief helpers', () => {
  const slot: PendingCarryRespawn = {
    nonce: 'carry-nonce-1',
    createdAtMs: 1_000,
    expiresAtMs: 1_000 + PENDING_CARRY_RESPAWN_TTL_MS,
    firstPrompt: 'continue the current work',
    systemPromptAddendum: 'persisted carry document',
  };

  it('saves a bounded one-shot payload without replacing the existing brief fields', async () => {
    const rec = recordingSql([{ pending_carry_respawn: slot }]);
    fakeSql = rec.sql;

    await expect(
      savePendingCarryRespawn(
        identity,
        { firstPrompt: slot.firstPrompt, systemPromptAddendum: slot.systemPromptAddendum },
        { nowMs: slot.createdAtMs, nonce: slot.nonce },
      ),
    ).resolves.toEqual(slot);

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).toEqual(expect.arrayContaining([
      identity.ownerId,
      identity.workspaceId,
      JSON.stringify(slot),
    ]));
    expect(rec.statements[0]).toContain('pending_carry_respawn = EXCLUDED.pending_carry_respawn');
    expect(rec.statements[0]).not.toContain('control_state = EXCLUDED.control_state');
  });

  it('refuses to create an empty payload without touching Postgres', async () => {
    const rec = recordingSql([]);
    fakeSql = rec.sql;

    await expect(
      savePendingCarryRespawn(identity, { firstPrompt: ' ', systemPromptAddendum: 'carry' }),
    ).resolves.toBeNull();
    expect(rec.calls).toHaveLength(0);
  });

  it('atomically consumes and validates a current payload', async () => {
    const rec = recordingSql([{ pending_carry_respawn: slot }]);
    fakeSql = rec.sql;

    await expect(consumePendingCarryRespawn(identity.ownerId, { nowMs: slot.createdAtMs })).resolves.toEqual(slot);
    expect(rec.statements[0]).toContain('UPDATE harness_shared.session_briefs');
    expect(rec.statements[0]).toContain('WITH pending AS MATERIALIZED');
    expect(rec.statements[0]).toContain('FOR UPDATE');
    expect(rec.statements[0]).toContain('pending_carry_respawn IS NOT NULL');
    expect(rec.statements[0]).toContain('RETURNING pending.pending_carry_respawn');
    expect(rec.calls[0]).toContain(identity.ownerId);
  });

  it('drops an expired consumed payload instead of returning it to a later launch', async () => {
    fakeSql = recordingSql([{ pending_carry_respawn: slot }]).sql;
    await expect(
      consumePendingCarryRespawn(identity.ownerId, { nowMs: slot.expiresAtMs }),
    ).resolves.toBeNull();
  });

  it('restores a failed bootstrap slot only when no newer request has replaced it', async () => {
    const newer = { ...slot, nonce: 'carry-nonce-2' };
    const rec = recordingSql([{ pending_carry_respawn: newer }]);
    fakeSql = rec.sql;

    await expect(
      restorePendingCarryRespawn(identity.ownerId, identity.workspaceId!, slot, { nowMs: slot.createdAtMs }),
    ).resolves.toBe(false);
    expect(rec.calls[0]).toContain(JSON.stringify(slot));
    expect(rec.statements[0]).toContain('COALESCE(');
    expect(rec.statements[0]).toContain('harness_shared.session_briefs.pending_carry_respawn');
  });

  it('clears only the request whose host delivery was refused', async () => {
    const rec = recordingSql([{ owner_id: identity.ownerId }]);
    fakeSql = rec.sql;

    await expect(clearPendingCarryRespawn(identity.ownerId, slot.nonce)).resolves.toBe(true);
    expect(rec.calls[0]).toEqual(expect.arrayContaining([identity.ownerId, slot.nonce]));
    expect(rec.statements[0]).toContain("pending_carry_respawn->>'nonce'");
  });
});
