import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  extractClaimMentions,
  isRetracted,
  normalizeClaimId,
  readClaimStandings,
  recordClaimEvent,
  renderRetractedMarker,
  type ClaimStanding,
} from './claim-retractions';
import { collectClaimIds, renderRetractedClaimsSection } from './carry-brief';

type Ev = {
  event_seq: number;
  workspace_id: string;
  claim_id: string;
  event_kind: string;
  because: string;
  superseded_by: string | null;
  actor: string;
  recorded_at: Date;
};

/** A tagged-template fake of just the two statements the store issues, backed by an
 *  in-memory append-only log — so the standing semantics (latest event wins,
 *  idempotent repeat, reinstate refusal) run for real without a database. */
function fakeSql(log: Ev[] = []): { sql: Sql; log: Ev[]; calls: string[] } {
  const calls: string[] = [];
  const fn = (strings: TemplateStringsArray, ...v: unknown[]): Promise<Ev[]> => {
    const text = strings.join('?');
    calls.push(text.includes('INSERT') ? 'insert' : 'select');
    if (text.includes('INSERT INTO harness_shared.claim_retraction_events')) {
      const [workspace_id, claim_id, event_kind, because, superseded_by, actor] = v as [
        string, string, string, string, string | null, string,
      ];
      const row: Ev = {
        event_seq: log.length + 1,
        workspace_id, claim_id, event_kind, because, superseded_by, actor,
        recorded_at: new Date('2026-10-02T00:00:00.000Z'),
      };
      log.push(row);
      return Promise.resolve([row]);
    }
    const [ws, ids] = v as [string, string[]];
    const latest = new Map<string, Ev>();
    for (const e of log) {
      if (e.workspace_id === ws && ids.includes(e.claim_id)) latest.set(e.claim_id, e);
    }
    return Promise.resolve([...latest.values()]);
  };
  return { sql: fn as unknown as Sql, log, calls };
}

describe('normalizeClaimId', () => {
  it('strips claim:/id:/# prefixes and sanitizes to the check-row id charset', () => {
    expect(normalizeClaimId('claim:Gate-Green')).toBe('gate-green');
    expect(normalizeClaimId('#gate-green')).toBe('gate-green');
    expect(normalizeClaimId('id:my id')).toBe('my-id');
    expect(normalizeClaimId('  gate.green_at:tip ')).toBe('gate.green_at:tip');
  });
  it('returns null when nothing usable survives', () => {
    expect(normalizeClaimId('   ')).toBeNull();
    expect(normalizeClaimId('claim:')).toBeNull();
    expect(normalizeClaimId(42)).toBeNull();
  });
});

describe('extractClaimMentions', () => {
  it('finds claim:<id> mentions, normalized, de-duplicated, in first-seen order', () => {
    const text = 'see claim:Gate-Green and (claim:other-1), again CLAIM:gate-green; xclaim:nope';
    expect(extractClaimMentions(text)).toEqual(['gate-green', 'other-1']);
  });
  it('is empty for null/undefined/no mentions', () => {
    expect(extractClaimMentions(null)).toEqual([]);
    expect(extractClaimMentions(undefined)).toEqual([]);
    expect(extractClaimMentions('nothing here')).toEqual([]);
  });
});

describe('recordClaimEvent / readClaimStandings (latest event is the standing)', () => {
  const base = { claimId: 'gate-green', actor: 'su-a' };

  it('retract then read: standing is retracted with because/supersededBy', async () => {
    const { sql } = fakeSql();
    const r = await recordClaimEvent(
      { ...base, kind: 'retract', because: 'measured wrong', supersededBy: 'WI-1', workspaceId: 'ws' },
      sql,
    );
    expect(r).toMatchObject({ ok: true, changed: true });
    const s = (await readClaimStandings(['claim:Gate-Green'], { workspaceId: 'ws' }, sql)).get('gate-green');
    expect(s).toBeDefined();
    expect(isRetracted(s)).toBe(true);
    expect(s).toMatchObject({ because: 'measured wrong', supersededBy: 'WI-1', actor: 'su-a' });
  });

  it('repeating the identical event is a no-op (changed:false, no second INSERT)', async () => {
    const { sql, calls } = fakeSql();
    const first = await recordClaimEvent({ ...base, kind: 'retract', because: 'x', workspaceId: 'ws' }, sql);
    const again = await recordClaimEvent({ ...base, kind: 'retract', because: 'x', workspaceId: 'ws' }, sql);
    expect(first).toMatchObject({ ok: true, changed: true });
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(calls.filter((c) => c === 'insert')).toHaveLength(1);
  });

  it('a retract with a NEW because appends a new event (revisable, not frozen)', async () => {
    const { sql, log } = fakeSql();
    await recordClaimEvent({ ...base, kind: 'retract', because: 'first', workspaceId: 'ws' }, sql);
    const r = await recordClaimEvent({ ...base, kind: 'retract', because: 'better reason', workspaceId: 'ws' }, sql);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(log).toHaveLength(2);
  });

  it('reinstate reverses a retraction; the standing is then NOT retracted', async () => {
    const { sql } = fakeSql();
    await recordClaimEvent({ ...base, kind: 'retract', because: 'oops', workspaceId: 'ws' }, sql);
    const r = await recordClaimEvent({ ...base, kind: 'reinstate', because: 'over-retracted', workspaceId: 'ws' }, sql);
    expect(r).toMatchObject({ ok: true, changed: true });
    const s = (await readClaimStandings([base.claimId], { workspaceId: 'ws' }, sql)).get(base.claimId);
    expect(s?.kind).toBe('reinstate');
    expect(isRetracted(s)).toBe(false);
  });

  it('reinstate on a claim that was never retracted is refused', async () => {
    const { sql, log } = fakeSql();
    const r = await recordClaimEvent({ ...base, kind: 'reinstate', because: 'nothing to undo', workspaceId: 'ws' }, sql);
    expect(r).toMatchObject({ ok: false, error: 'not_retracted' });
    expect(log).toHaveLength(0);
  });

  it('refuses an unusable id, an empty reason, and over-long fields before touching the db', async () => {
    const { sql, calls } = fakeSql();
    expect(await recordClaimEvent({ ...base, claimId: '   ', kind: 'retract', because: 'x' }, sql)).toMatchObject({ error: 'invalid_claim_id' });
    expect(await recordClaimEvent({ ...base, kind: 'retract', because: '  ' }, sql)).toMatchObject({ error: 'because_required' });
    expect(await recordClaimEvent({ ...base, kind: 'retract', because: 'x'.repeat(1001) }, sql)).toMatchObject({ error: 'because_too_long' });
    expect(await recordClaimEvent({ ...base, kind: 'retract', because: 'x', supersededBy: 'y'.repeat(301) }, sql)).toMatchObject({ error: 'superseded_by_too_long' });
    expect(calls).toHaveLength(0);
  });

  it('readClaimStandings with no usable ids issues no query', async () => {
    const { sql, calls } = fakeSql();
    expect((await readClaimStandings(['   ', ''], { workspaceId: 'ws' }, sql)).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe('carry-brief claim rendering', () => {
  const standing: ClaimStanding = {
    claimId: 'gate-green',
    kind: 'retract',
    because: 'measured the wrong candidate',
    supersededBy: 'WI-9',
    actor: 'su-a',
    recordedAt: '2026-10-02T00:00:00.000Z',
    eventSeq: 7,
  };

  it('renderRetractedMarker names day, actor, reason, replacement and the do-not-act warning', () => {
    const line = renderRetractedMarker(standing);
    expect(line).toContain('⛔ RETRACTED 2026-10-02 by su-a');
    expect(line).toContain('measured the wrong candidate');
    expect(line).toContain('superseded by WI-9');
    expect(line).toContain('do NOT act on this claim');
  });

  it('renderRetractedClaimsSection is empty for none, and lists each retracted claim by id', () => {
    expect(renderRetractedClaimsSection(undefined)).toEqual([]);
    expect(renderRetractedClaimsSection([])).toEqual([]);
    const [section] = renderRetractedClaimsSection([standing]);
    expect(section).toContain('RETRACTED CLAIMS');
    expect(section).toContain('[#gate-green]');
  });

  it('collectClaimIds gathers check ids and claim: mentions from the loop note and held checkpoints', () => {
    const ids = collectClaimIds({
      loop: { carryNote: 'prose citing claim:from-note here' } as never,
      checks: [{ id: 'Check-A', claim: 'a' }, { claim: 'no id' }] as never,
      heldItems: [{ checkpoint: 'cites claim:from-checkpoint' }, { checkpoint: null }] as never,
    });
    expect(ids).toEqual(['check-a', 'from-note', 'from-checkpoint']);
  });
});
