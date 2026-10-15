import { describe, expect, it, vi, beforeEach } from 'vitest';
vi.mock('./presence', () => ({ listPresence: vi.fn() }));
vi.mock('../../adv-sessions', async (orig) => ({ ...(await orig<typeof import('../../adv-sessions')>()), endedRecordedOwnerIds: vi.fn(async () => new Set<string>()), listRecordedLiveSessions: vi.fn() }));
vi.mock('../../sync/hyperbee/session-presence-store', () => ({ listLiveSessionPresence: vi.fn() }));
vi.mock('./nursery-alias-liveness', () => ({ listRunningNurseryAliasRows: vi.fn() }));
import {
  isSelectorOrWildcard,
  resolveBestEffort,
  resolveRecipientsAgainst,
  resolveRecipients,
  resolveExplicitAgentOwnerId,
  resolveBestEffortAgainstRoster,
  resetKnownOwnerIdsCache,
  knownOwnerIdSet,
} from './recipient-resolve';
import { listPresence } from './presence';
import { listRecordedLiveSessions } from '../../adv-sessions';
import { listLiveSessionPresence } from '../../sync/hyperbee/session-presence-store';
import { listRunningNurseryAliasRows } from './nursery-alias-liveness';

const mockedList = vi.mocked(listPresence);
const mockedRecorded = vi.mocked(listRecordedLiveSessions);
const mockedRemote = vi.mocked(listLiveSessionPresence);
const mockedNursery = vi.mocked(listRunningNurseryAliasRows);
const remoteSess = (ids: string[]) =>
  ids.map((owner_id) => ({ owner_id, last_seen_ms: 1 })) as unknown as Awaited<
    ReturnType<typeof listLiveSessionPresence>
  >;
const roster = (ids: string[]) => ids.map((ownerId) => ({ ownerId })) as Awaited<ReturnType<typeof listPresence>>;
const recorded = (ids: string[]) =>
  ids.map((coordOwnerId) => ({ coordOwnerId })) as Awaited<ReturnType<typeof listRecordedLiveSessions>>;
const nursery = (aliases: string[]) =>
  aliases.map((alias) => ({ alias, spawnId: 's-nursery-1', workspaceId: 'ws-1', heartbeatAt: null })) as Awaited<
    ReturnType<typeof listRunningNurseryAliasRows>
  >;

beforeEach(() => {
  mockedNursery.mockReset();
  mockedNursery.mockResolvedValue([]);
});

// Two `su-` agents (distinct uuids) + a `pus-` agent — the prefix `su-df00939e`
// uniquely picks the first; the prefix `su-` is ambiguous across both.
const KNOWN = [
  'su-df00939e-1f16-410d-ac0d-ef1aebd41d96',
  'su-fc2fd592-e760-42bd-8057-beb4d06eef52',
  'pus-abcdef01-2345',
];
const STALE_SU_SESSION = 'su-38150967-c71c-49ce-8f6f-b13541ca4d7e';
const UNRELATED_SU_SESSION = 'su-44d9d024-f986-4033-aa23-0381508e5938';

describe('resolveRecipientsAgainst', () => {
  it('resolves a unique short prefix to the full ownerId (the wake-key bug)', () => {
    const r = resolveRecipientsAgainst(['su-df00939e'], KNOWN);
    expect(r.resolved).toEqual(['su-df00939e-1f16-410d-ac0d-ef1aebd41d96']);
    expect(r.unknown).toEqual([]);
    expect(r.ambiguous).toEqual([]);
  });

  it('resolves a SHORT HANDLE (mid-uuid segment shown in [coord+N]) via substring — not a prefix', () => {
    // The injection shows '93a38' for 'su-93a3872a-…' (the post-'su-' segment, NOT a
    // prefix). Owner ask 2026-06-19: reply without a separate coord:presence lookup.
    // Here 'df009' is the mid-segment of the first agent; 'beb4d' a tail segment.
    expect(resolveRecipientsAgainst(['df009'], KNOWN).resolved).toEqual([
      'su-df00939e-1f16-410d-ac0d-ef1aebd41d96',
    ]);
    expect(resolveRecipientsAgainst(['beb4d'], KNOWN).resolved).toEqual([
      'su-fc2fd592-e760-42bd-8057-beb4d06eef52',
    ]);
  });

  it('does not route a stale full su id through a handle substring in an unrelated UUID', () => {
    const r = resolveRecipientsAgainst([STALE_SU_SESSION], [UNRELATED_SU_SESSION]);
    expect(r).toEqual({
      resolved: [],
      unknown: [STALE_SU_SESSION],
      ambiguous: [],
    });
  });

  it('prefers a PREFIX match over substring (prefix tried first)', () => {
    // exact-prefix still wins; substring is only the fallback when prefix yields none.
    expect(resolveRecipientsAgainst(['su-df00939e'], KNOWN).resolved).toEqual([
      'su-df00939e-1f16-410d-ac0d-ef1aebd41d96',
    ]);
  });

  it('keeps an exact ownerId match unchanged', () => {
    const id = 'su-fc2fd592-e760-42bd-8057-beb4d06eef52';
    expect(resolveRecipientsAgainst([id], KNOWN).resolved).toEqual([id]);
  });

  it('accepts an exact role-session owner when boot presence makes it known', () => {
    const id = 'role-5fe8f8dc-3468-4457-823b-0619769326fe';
    expect(resolveRecipientsAgainst([id], [id])).toEqual({
      resolved: [id],
      unknown: [],
      ambiguous: [],
    });
  });

  it('flags a concrete id that matches no known agent as unknown — nothing resolved', () => {
    const r = resolveRecipientsAgainst(['su-zzz99999'], KNOWN);
    expect(r.unknown).toEqual(['su-zzz99999']);
    expect(r.resolved).toEqual([]);
  });

  it('flags an ambiguous prefix that matches >1 known agent', () => {
    const r = resolveRecipientsAgainst(['su-'], KNOWN);
    expect(r.ambiguous).toHaveLength(1);
    expect(r.ambiguous[0].id).toBe('su-');
    expect(r.ambiguous[0].matches).toHaveLength(2);
    expect(r.resolved).toEqual([]);
  });

  it('passes wildcards + audience selectors straight through (no roster check)', () => {
    const to = ['*', 'human', '@plan:my-plan', '@role:bee', ''];
    const r = resolveRecipientsAgainst(to, KNOWN);
    expect(r.resolved).toEqual(to);
    expect(r.unknown).toEqual([]);
    expect(r.ambiguous).toEqual([]);
  });

  it('mixes resolved + unknown across a multi-recipient send', () => {
    const r = resolveRecipientsAgainst(['su-df00939e', 'su-zzz99999', '*'], KNOWN);
    expect(r.resolved).toContain('su-df00939e-1f16-410d-ac0d-ef1aebd41d96');
    expect(r.resolved).toContain('*');
    expect(r.unknown).toEqual(['su-zzz99999']);
  });
});

describe('isSelectorOrWildcard', () => {
  it('recognizes wildcards + audience selectors', () => {
    for (const s of ['*', 'human', '', '@plan:x', '@role:bee', '@wave:2', '@user:gh:1']) {
      expect(isSelectorOrWildcard(s)).toBe(true);
    }
  });
  it('treats a concrete ownerId as not-a-selector', () => {
    expect(isSelectorOrWildcard('su-df00939e')).toBe(false);
    expect(isSelectorOrWildcard('pus-abcdef01-2345')).toBe(false);
  });
});

describe('resolveBestEffort (the silent shared-layer twin)', () => {
  it('rewrites a unique prefix to the full ownerId', () => {
    expect(resolveBestEffort(['su-df00939e'], KNOWN)).toEqual([
      'su-df00939e-1f16-410d-ac0d-ef1aebd41d96',
    ]);
  });
  it('resolves a short handle (mid-uuid substring) to the full ownerId', () => {
    expect(resolveBestEffort(['fc2fd'], KNOWN)).toEqual([
      'su-fc2fd592-e760-42bd-8057-beb4d06eef52',
    ]);
  });
  it('leaves an UNKNOWN id unchanged (best-effort never rejects)', () => {
    expect(resolveBestEffort(['su-zzz99999'], KNOWN)).toEqual(['su-zzz99999']);
  });
  it('leaves an AMBIGUOUS prefix unchanged', () => {
    expect(resolveBestEffort(['su-'], KNOWN)).toEqual(['su-']);
  });
  it('leaves a stale full su id unchanged when its handle only occurs inside an unrelated UUID', () => {
    expect(resolveBestEffort([STALE_SU_SESSION], [UNRELATED_SU_SESSION])).toEqual([
      STALE_SU_SESSION,
    ]);
  });
  it('passes selectors/wildcards + exact ids through untouched', () => {
    const to = ['*', 'human', '@plan:x', 'su-fc2fd592-e760-42bd-8057-beb4d06eef52'];
    expect(resolveBestEffort(to, KNOWN)).toEqual(to);
  });
});

// ── Host wrappers (depth pass, su-7f3e0376) — the fail-open / fail-soft semantics ──
describe('resolveRecipients (host wrapper — fail-open against the live roster)', () => {
  beforeEach(() => {
    resetKnownOwnerIdsCache();
    mockedList.mockReset();
    mockedRecorded.mockReset();
    mockedRecorded.mockResolvedValue([]);
  });

  it('resolves against the live roster when present', async () => {
    mockedList.mockResolvedValue(roster(KNOWN));
    const r = await resolveRecipients(['su-df00939e']);
    expect(r.resolved).toEqual(['su-df00939e-1f16-410d-ac0d-ef1aebd41d96']);
  });

  it('FAILS OPEN (passes everything through) when the roster is EMPTY — never a false unknown', async () => {
    // Both an empty roster AND an unavailable roster (listPresence throws → [] in the catch) converge
    // on this same passthrough; the throw-path is the catch's twin, left to integration coverage.
    mockedList.mockResolvedValue(roster([]));
    const r = await resolveRecipients(['su-zzz99999', 'whoever']);
    expect(r).toEqual({ resolved: ['su-zzz99999', 'whoever'], unknown: [], ambiguous: [] });
  });

  it('accepts recorded-live session owners that have not self-registered presence yet', async () => {
    mockedList.mockResolvedValue(roster([]));
    mockedRecorded.mockResolvedValue(recorded(['s-1782352639138-43ed80c0']));
    const r = await resolveRecipients(['s-1782352639138']);
    expect(r).toEqual({
      resolved: ['s-1782352639138-43ed80c0'],
      unknown: [],
      ambiguous: [],
    });
  });

  it('accepts running nursery spawn_id/session_owner/run_id aliases before presence or adv_sessions exists', async () => {
    mockedList.mockResolvedValue(roster([]));
    mockedRecorded.mockResolvedValue([]);
    mockedNursery.mockResolvedValue(
      nursery(['s-release-fixer-1', 'session-owner-release-fixer', 'run-release-fixer-1']),
    );
    const r = await resolveRecipients(
      ['s-release-fixer', 'session-owner-release-fixer', 'run-release-fixer-1'],
      'ws-1',
    );
    expect(r).toEqual({
      resolved: ['s-release-fixer-1', 'session-owner-release-fixer', 'run-release-fixer-1'],
      unknown: [],
      ambiguous: [],
    });
    expect(mockedNursery).toHaveBeenCalledWith({ workspaceId: 'ws-1' });
  });

  it('keeps nursery alias lookup fail-soft when that roster leg is unavailable', async () => {
    mockedList.mockResolvedValue(roster(KNOWN));
    mockedNursery.mockRejectedValue(new Error('spawned_agents unavailable'));
    const r = await resolveRecipients(['su-df00939e']);
    expect(r.resolved).toEqual(['su-df00939e-1f16-410d-ac0d-ef1aebd41d96']);
    expect(r.unknown).toEqual([]);
    expect(r.ambiguous).toEqual([]);
  });
});

describe('H1 (audit D-013) — remote session presence never shadows a LOCAL identity', () => {
  beforeEach(() => {
    resetKnownOwnerIdsCache();
    mockedList.mockReset();
    mockedRecorded.mockReset();
    mockedRemote.mockReset();
    mockedRecorded.mockResolvedValue([]);
    mockedRemote.mockResolvedValue(remoteSess([]));
  });

  it('a genuine remote session id resolves like a local one (the P-007 parity path)', async () => {
    mockedList.mockResolvedValue(roster([]));
    mockedRemote.mockResolvedValue(remoteSess(['su-remote-abc123']));
    const r = await resolveRecipients(['su-remote-abc123'], 'ws-1');
    expect(r.resolved).toEqual(['su-remote-abc123']);
    expect(r.unknown).toEqual([]);
  });

  it('a remote session CLAIMING a local ownerId stays resolvable to the LOCAL agent — never doubled/ambiguous', async () => {
    // Local presence owns 'mug'; a hostile admitted member ALSO gossips a session
    // claiming 'mug'. The local agent is authoritative: 'mug' resolves cleanly,
    // the colliding remote claim never introduces a phantom/ambiguity.
    mockedList.mockResolvedValue(roster(['mug', 'su-local-xyz']));
    mockedRemote.mockResolvedValue(remoteSess(['mug']));
    const r = await resolveRecipients(['mug'], 'ws-1');
    expect(r.resolved).toEqual(['mug']);
    expect(r.ambiguous).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  it('a remote session echoing a running nursery alias never makes the local alias ambiguous', async () => {
    mockedList.mockResolvedValue(roster([]));
    mockedNursery.mockResolvedValue(nursery(['s-nursery-local']));
    mockedRemote.mockResolvedValue(remoteSess(['s-nursery-local']));
    const r = await resolveRecipients(['s-nursery-local'], 'ws-1');
    expect(r.resolved).toEqual(['s-nursery-local']);
    expect(r.ambiguous).toEqual([]);
    expect(r.unknown).toEqual([]);
  });
});

describe('resolveBestEffortAgainstRoster (host wrapper — broadcast short-circuit + fail-soft)', () => {
  beforeEach(() => {
    resetKnownOwnerIdsCache();
    mockedList.mockReset();
    mockedRecorded.mockReset();
    mockedRecorded.mockResolvedValue([]);
  });

  it('SKIPS the roster read entirely when every entry is a selector/wildcard (broadcasts pay nothing)', async () => {
    const out = await resolveBestEffortAgainstRoster(['*', 'human', '@plan:x']);
    expect(out).toEqual(['*', 'human', '@plan:x']);
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('resolves a unique prefix against the roster when a concrete id is present', async () => {
    mockedList.mockResolvedValue(roster(KNOWN));
    expect(await resolveBestEffortAgainstRoster(['su-df00939e'])).toEqual([
      'su-df00939e-1f16-410d-ac0d-ef1aebd41d96',
    ]);
  });

  it('resolves against live recorded sessions when raw presence has not registered the owner yet', async () => {
    mockedList.mockResolvedValue(roster([]));
    mockedRecorded.mockResolvedValue(recorded(['s-1782352639138-43ed80c0']));
    expect(await resolveBestEffortAgainstRoster(['s-1782352639138'])).toEqual([
      's-1782352639138-43ed80c0',
    ]);
  });

  it('resolves a running nursery alias when raw presence and recorded sessions have no owner', async () => {
    mockedList.mockResolvedValue(roster([]));
    mockedRecorded.mockResolvedValue([]);
    mockedNursery.mockResolvedValue(nursery(['s-release-fixer-1']));
    expect(await resolveBestEffortAgainstRoster(['s-release-fixer'])).toEqual(['s-release-fixer-1']);
  });
});

// EI-9971: the roster-membership set a caller uses to gate a PERSISTENT side
// effect (staging a pending_wakes row) on "is this a real agent", distinct
// from resolveBestEffortAgainstRoster's deliberate passthrough-on-no-match.
describe('knownOwnerIdSet (EI-9971 — membership check for gating persistent side effects)', () => {
  beforeEach(() => {
    resetKnownOwnerIdsCache();
    mockedList.mockReset();
    mockedRecorded.mockReset();
    mockedRecorded.mockResolvedValue([]);
  });

  it('returns a Set containing every known local agent', async () => {
    mockedList.mockResolvedValue(roster(KNOWN));
    const set = await knownOwnerIdSet();
    expect(set).not.toBeNull();
    expect(set!.has('su-df00939e-1f16-410d-ac0d-ef1aebd41d96')).toBe(true);
    expect(set!.has('su-garbage-id-nobody-owns')).toBe(false);
  });

  it('returns null (fail OPEN, not "nothing known") when the roster is empty', async () => {
    mockedList.mockResolvedValue(roster([]));
    expect(await knownOwnerIdSet()).toBeNull();
  });

  it('returns null (fail OPEN) when the roster read throws', async () => {
    mockedList.mockRejectedValue(new Error('transient PG error'));
    expect(await knownOwnerIdSet()).toBeNull();
  });

  it('shares the same memoized roster fetch resolveBestEffortAgainstRoster reads (no extra DB cost)', async () => {
    mockedList.mockResolvedValue(roster(KNOWN));
    await resolveBestEffortAgainstRoster(['su-df00939e']);
    await knownOwnerIdSet();
    expect(mockedList).toHaveBeenCalledTimes(1);
  });
});

// EI-9299: a short in-process TTL memo on the roster read collapses a burst of
// near-simultaneous coord writes (each resolving recipients) into ONE shared
// fetch instead of one per call — the fix for the measured "coord write path
// slow, DB baseline fine" probe-canary breach (3 parallel roster reads fired
// on every send/ack with a concrete recipient).
describe('readKnownOwnerIds roster memoization (EI-9299)', () => {
  beforeEach(() => {
    resetKnownOwnerIdsCache();
    mockedList.mockReset();
    mockedRecorded.mockReset();
    mockedRecorded.mockResolvedValue([]);
  });

  it('shares ONE underlying roster fetch across concurrent/rapid calls within the TTL window', async () => {
    mockedList.mockResolvedValue(roster(KNOWN));
    await Promise.all([
      resolveBestEffortAgainstRoster(['su-df00939e']),
      resolveBestEffortAgainstRoster(['su-fc2fd592']),
      resolveBestEffortAgainstRoster(['su-df00939e']),
    ]);
    expect(mockedList).toHaveBeenCalledTimes(1);
  });

  it('does NOT cross-contaminate different workspaces (separate cache key per workspaceId)', async () => {
    mockedList.mockResolvedValueOnce(roster(['su-ws1-only']));
    mockedList.mockResolvedValueOnce(roster(['su-ws2-only']));
    const [a, b] = await Promise.all([
      resolveBestEffortAgainstRoster(['su-ws1-o'], 'ws-1'),
      resolveBestEffortAgainstRoster(['su-ws2-o'], 'ws-2'),
    ]);
    expect(a).toEqual(['su-ws1-only']);
    expect(b).toEqual(['su-ws2-only']);
    expect(mockedList).toHaveBeenCalledTimes(2);
  });

  it('re-fetches after resetKnownOwnerIdsCache (a fresh mock takes effect immediately, no stale carry-over)', async () => {
    mockedList.mockResolvedValueOnce(roster(['su-old-agent12']));
    await resolveBestEffortAgainstRoster(['su-old-age']);
    resetKnownOwnerIdsCache();
    mockedList.mockResolvedValueOnce(roster(['su-new-agent12']));
    const out = await resolveBestEffortAgainstRoster(['su-new-age']);
    expect(out).toEqual(['su-new-agent12']);
    expect(mockedList).toHaveBeenCalledTimes(2);
  });

  it('a degraded roster (one source failing) resolves fail-soft and is memoized like any other result within the TTL window', async () => {
    // readKnownOwnerIds aggregates via Promise.allSettled — one leg rejecting
    // never rejects the aggregate; it just contributes no ids from that leg.
    // So this is NOT a "poisoned cache" scenario to guard against; it's the
    // existing fail-soft behavior, now also memoized for the TTL window like
    // any successful fetch (a fresh call still gets it via resetKnownOwnerIdsCache
    // — see the preceding test).
    mockedList.mockRejectedValueOnce(new Error('transient PG error'));
    mockedRecorded.mockResolvedValue([]);
    const first = await resolveBestEffortAgainstRoster(['su-df00939e']);
    expect(first).toEqual(['su-df00939e']);
    const second = await resolveBestEffortAgainstRoster(['su-df00939e']);
    expect(second).toEqual(['su-df00939e']);
    // Both calls served from the ONE memoized fetch — no re-fetch within the TTL window.
    expect(mockedList).toHaveBeenCalledTimes(1);
  });
});

describe('resolveExplicitAgentOwnerId (strict work-item placement)', () => {
  beforeEach(() => {
    resetKnownOwnerIdsCache();
    mockedList.mockReset().mockResolvedValue(roster(KNOWN));
    mockedRecorded.mockReset().mockResolvedValue(recorded([]));
    mockedRemote.mockReset().mockResolvedValue(remoteSess([]));
    mockedNursery.mockReset().mockResolvedValue(nursery([]));
  });

  it('resolves a unique known owner prefix and the caller self token', async () => {
    await expect(resolveExplicitAgentOwnerId('su-df00939e', 'su-caller', 'ws-1')).resolves.toEqual({
      ok: true,
      ownerId: 'su-df00939e-1f16-410d-ac0d-ef1aebd41d96',
    });
    await expect(resolveExplicitAgentOwnerId('self', 'su-caller', 'ws-1')).resolves.toEqual({
      ok: true,
      ownerId: 'su-caller',
    });
  });

  it('rejects unknown owners even when the roster is empty', async () => {
    mockedList.mockResolvedValue(roster([]));
    const result = await resolveExplicitAgentOwnerId('noop-do-not-use', 'su-caller', 'ws-1');
    expect(result).toMatchObject({ ok: false, code: 'assignee_unknown' });
  });

  it('rejects ambiguous handles and audience selectors as non-concrete assignees', async () => {
    mockedList.mockResolvedValue(roster(KNOWN));
    const ambiguous = await resolveExplicitAgentOwnerId('su-', 'su-caller', 'ws-1');
    const selector = await resolveExplicitAgentOwnerId('@fleet:bugs', 'su-caller', 'ws-1');
    expect(ambiguous).toMatchObject({ ok: false, code: 'assignee_ambiguous' });
    expect(selector).toMatchObject({ ok: false, code: 'assignee_not_agent' });
  });
});
