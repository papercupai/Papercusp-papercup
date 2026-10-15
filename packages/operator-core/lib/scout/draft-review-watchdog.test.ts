/**
 * Scout-draft review backstop (queen-scout-feedback-loop-2026-06-20 D-003 #2, hardening).
 * Pure tests for the stale-draft selection + the per-hive nudge decision + the env
 * tunable / kill switch. The IO deps are mocked only so importing the module has no
 * load-time side effects (mirrors hive/watchdog-paused-recovery.test.ts).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { vi } from 'vitest';
import type { Sql } from 'postgres';

const { fixtureSql, disclosureTransaction } = vi.hoisted(() => {
  const sql = vi.fn(async (..._args: unknown[]) => []);
  const begin = vi.fn(async (run: (tx: typeof sql) => Promise<unknown>) => run(sql));
  return { fixtureSql: Object.assign(sql, { begin }), disclosureTransaction: begin };
});
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fixtureSql }),
}));
vi.mock('../pot/started', () => ({
  listBlenderMaintenanceScopes: vi.fn(),
  listBlenderMaintenanceWorkspaceIds: vi.fn(() => []),
}));
const { wakeMug } = vi.hoisted(() => ({ wakeMug: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../pot/placement-watchdog', () => ({ resolveMugOwner: vi.fn(), wakeMug }));
vi.mock('../pot/watchdog', () => ({ recentWatchdogFires: vi.fn(), recordFire: vi.fn() }));

import {
  selectStaleDrafts,
  hasDurableScoutReviewEvidence,
  shouldNudgeHive,
  scoutDraftReviewStaleSec,
  fireReviewWake,
  formatStaleDuration,
  readScoutDraftCandidates,
  decisionStillSuppresses,
  type ScoutDraftCandidate,
} from './draft-review-watchdog';
import type { CitedWorkItemRefState } from '../agent-tools/plans/cited-work-item-refs';

const HOUR = 3_600_000;
const NOW = 100 * HOUR;

function draft(slug: string, ageHours: number): ScoutDraftCandidate {
  return { planSlug: slug, title: null, updatedAtMs: NOW - ageHours * HOUR };
}

describe('selectStaleDrafts', () => {
  const opts = { now: NOW, thresholdMs: 12 * HOUR };

  it('selects only drafts past the staleness threshold', () => {
    const got = selectStaleDrafts([draft('fresh', 1), draft('stale', 24)], opts);
    expect(got.map((d) => d.planSlug)).toEqual(['stale']);
  });

  it('treats a draft exactly at the threshold as stale (>=)', () => {
    const got = selectStaleDrafts([draft('edge', 12)], opts);
    expect(got.map((d) => d.planSlug)).toEqual(['edge']);
  });

  it('returns the stale drafts oldest-first', () => {
    const got = selectStaleDrafts([draft('newer', 13), draft('oldest', 48), draft('mid', 20)], opts);
    expect(got.map((d) => d.planSlug)).toEqual(['oldest', 'mid', 'newer']);
  });

  it('selects nothing when nothing is stale (default-safe — no wake)', () => {
    expect(selectStaleDrafts([draft('a', 1), draft('b', 5)], opts)).toEqual([]);
  });

  it('selects nothing when the threshold is <= 0 (kill switch)', () => {
    expect(selectStaleDrafts([draft('stale', 999)], { now: NOW, thresholdMs: 0 })).toEqual([]);
    expect(selectStaleDrafts([draft('stale', 999)], { now: NOW, thresholdMs: -1 })).toEqual([]);
  });

  it('never selects a draft with a non-finite timestamp (never act blind)', () => {
    const bad: ScoutDraftCandidate = { planSlug: 'nan', title: null, updatedAtMs: Number.NaN };
    expect(selectStaleDrafts([bad], opts)).toEqual([]);
  });

  it('does not re-alert a draft carrying durable review evidence', () => {
    const reviewed: ScoutDraftCandidate = {
      ...draft('reviewed', 48),
      reviewEvidence: { hasDecision: true, hasNeedsHumanItem: false, hasRevisionHold: false },
    };
    const held: ScoutDraftCandidate = {
      ...draft('held', 48),
      reviewEvidence: { hasDecision: false, hasNeedsHumanItem: true, hasRevisionHold: false },
    };
    const plain = draft('plain', 48);

    expect(hasDurableScoutReviewEvidence(reviewed)).toBe(true);
    expect(hasDurableScoutReviewEvidence(held)).toBe(true);
    expect(selectStaleDrafts([reviewed, held, plain], opts).map((d) => d.planSlug)).toEqual(['plain']);
  });
});

describe('readScoutDraftCandidates SQL projection', () => {
  it('projects the structured review fields used by the durable evidence guard', async () => {
    const sql = vi.fn().mockResolvedValue([
      {
        plan_slug: 'scout-reviewed',
        title: 'reviewed draft',
        updated_at_ms: NOW - 48 * HOUR,
        items: [{ status: 'needs-human' }],
        decisions: [{ id: 'D-001' }],
        content: '\nrevision hold\n',
      },
    ]) as unknown as Sql;

    const got = await readScoutDraftCandidates(sql, 'ws-1', 'pot-1');
    const projection = (sql as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    const sqlText = Array.isArray(projection) ? projection.join(' ') : String(projection);

    expect(sqlText).toContain('items');
    expect(sqlText).toContain('decisions');
    expect(sqlText).toContain('content');
    expect(got[0].reviewEvidence).toEqual({
      hasDecision: true,
      hasNeedsHumanItem: true,
      hasRevisionHold: true,
    });
    // WI-2142684: this decision has no title/body text (only `{id: 'D-001'}'),
    // so hasConditionalDisposition returns false — the ref-resolution
    // query must be skipped entirely. Regression guard for the common case.
    expect((sql as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(1);
  });

  // WI-2142684: the measured bug shape — a CONDITIONAL hold citing a ref that has
  // since settled must LIFT (hasDecision:false), unlike the unconditional case above.
  it('lifts a CONDITIONAL hold once its cited ref has settled (terminal)', async () => {
    const calls: unknown[][] = [];
    const sql = vi.fn((...args: unknown[]) => {
      calls.push(args);
      if (calls.length === 1) {
        return Promise.resolve([
          {
            plan_slug: 'scout-conditional',
            title: 'conditional draft',
            updated_at_ms: NOW - 48 * HOUR,
            items: [],
            decisions: [
              { id: 'D-001', title: '', body: 'retry activation audit after this decision revision or that repair backfills the plan (EI-1)', date: '2026-09-01' },
            ],
            content: '',
          },
        ]);
      }
      // second call: the batched ref-state resolution
      return Promise.resolve([{ feature_id: 'EI-1', status: 'done' }]);
    }) as unknown as Sql;

    const got = await readScoutDraftCandidates(sql, 'ws-1', 'pot-1');
    expect(got[0].reviewEvidence?.hasDecision).toBe(false);
    expect(calls.length).toBe(2);
  });

  it('keeps a CONDITIONAL hold suppressing while its cited ref is still open', async () => {
    const calls: unknown[][] = [];
    const sql = vi.fn((...args: unknown[]) => {
      calls.push(args);
      if (calls.length === 1) {
        return Promise.resolve([
          {
            plan_slug: 'scout-conditional-open',
            title: 'conditional draft, open blocker',
            updated_at_ms: NOW - 48 * HOUR,
            items: [],
            decisions: [
              { id: 'D-001', title: '', body: 'retry once EI-2 resolves the flake', date: '2026-09-01' },
            ],
            content: '',
          },
        ]);
      }
      return Promise.resolve([{ feature_id: 'EI-2', status: 'open' }]);
    }) as unknown as Sql;

    const got = await readScoutDraftCandidates(sql, 'ws-1', 'pot-1');
    expect(got[0].reviewEvidence?.hasDecision).toBe(true);
  });
});

describe('decisionStillSuppresses (WI-2142684)', () => {
  const terminalRef: ReadonlyMap<string, CitedWorkItemRefState> = new Map([
    ['EI-1', { ref: 'EI-1', state: 'done', terminal: true }],
  ]);
  const openRef: ReadonlyMap<string, CitedWorkItemRefState> = new Map([
    ['EI-2', { ref: 'EI-2', state: 'open', terminal: false }],
  ]);
  const absentRef: ReadonlyMap<string, CitedWorkItemRefState> = new Map([
    ['EI-3', { ref: 'EI-3', state: null, terminal: false }],
  ]);
  const empty: ReadonlyMap<string, CitedWorkItemRefState> = new Map();

  it('keeps long decision text within a linear scan budget', () => {
    const decision = { title: '', body: 'x'.repeat(80_000) };
    const startedAt = Date.now();
    expect(decisionStillSuppresses(decision, empty)).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
  
  it('an unconditional decision (no conditional language) suppresses forever, ref or not', () => {
    expect(
      decisionStillSuppresses({ title: 'D-001', body: 'This plan is deprecated (EI-1).' }, terminalRef),
    ).toBe(true);
  });

  it('a conditional decision whose cited ref has terminated LIFTS the suppression', () => {
    expect(
      decisionStillSuppresses(
        { title: '', body: 'retry activation audit after this decision revision or that repair backfills the plan (EI-1)' },
        terminalRef,
      ),
    ).toBe(false);
  });

  it('a conditional decision whose cited ref is still OPEN keeps suppressing', () => {
    expect(
      decisionStillSuppresses({ title: '', body: 'retry once EI-2 resolves the flake' }, openRef),
    ).toBe(true);
  });

  it('a conditional decision whose cited ref is ABSENT (no matching row) LIFTS — nothing left to wait on', () => {
    expect(
      decisionStillSuppresses({ title: '', body: 'retry once EI-3 resolves the flake' }, absentRef),
    ).toBe(false);
  });

  it('conditional language with NO cited ref keeps suppressing (nothing to check against)', () => {
    expect(
      decisionStillSuppresses({ title: '', body: 'retry once the flake resolves' }, empty),
    ).toBe(true);
  });

  it('a decision citing a ref this evaluator never resolved fails toward suppress, not toward a spurious lift', () => {
    expect(
      decisionStillSuppresses({ title: '', body: 'retry once EI-999 resolves' }, empty),
    ).toBe(true);
  });

  it('a malformed decision (non-object) suppresses — fail toward the prior, safe behavior', () => {
    expect(decisionStillSuppresses(null, terminalRef)).toBe(true);
    expect(decisionStillSuppresses('D-001', terminalRef)).toBe(true);
  });

  it('multiple cited refs: ANY still-open ref keeps the whole decision suppressing', () => {
    const mixed: ReadonlyMap<string, CitedWorkItemRefState> = new Map([
      ['EI-1', { ref: 'EI-1', state: 'done', terminal: true }],
      ['EI-2', { ref: 'EI-2', state: 'open', terminal: false }],
    ]);
    expect(
      decisionStillSuppresses({ title: '', body: 'retry once EI-1 resolves and EI-2 lands' }, mixed),
    ).toBe(true);
  });
});

describe('shouldNudgeHive', () => {
  it('nudges when there is a stale draft and not debounced', () => {
    expect(shouldNudgeHive({ staleCount: 2, alreadyFiredRecently: false })).toBe(true);
  });
  it('skips when nothing is stale', () => {
    expect(shouldNudgeHive({ staleCount: 0, alreadyFiredRecently: false })).toBe(false);
  });
  it('skips when already fired within the window (debounce)', () => {
    expect(shouldNudgeHive({ staleCount: 5, alreadyFiredRecently: true })).toBe(false);
  });
});

describe('fireReviewWake (WI-2187 — stable Mug seam)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes the stale concrete owner to the shared stable Mug seam', async () => {
    await fireReviewWake('ws-1', 'queen-owner-stale-123', [draft('scout-x-2026-06-26', 24)], 43_200);
    expect(disclosureTransaction).toHaveBeenCalled();
    expect(fixtureSql.mock.calls.some(([strings]) =>
      Array.isArray(strings) && strings.join(' ').includes('harness_shared.personal_disclosures'),
    )).toBe(true);
    expect(wakeMug).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1', mugOwner: 'queen-owner-stale-123', source: 'scout-draft-review',
    }));
  });

  it('still invokes the durable seam when the prior wake has no current owner', async () => {
    await fireReviewWake('ws-1', null, [draft('scout-y', 24)], 43_200, 'pot-1');
    expect(wakeMug).toHaveBeenCalledWith(expect.objectContaining({ mugOwner: null, harnessSlug: 'pot-1' }));
  });

  // EI-13220: a draft stuck for WEEKS (confirmed live:
  // scout-rubric-hive-coordination-health-scorecard-2026-06-26 fired hourly for
  // ~3 weeks unreviewed) used to read identically to one that just crossed the
  // fixed threshold — indistinguishable from noise. Assert the real elapsed
  // staleness now reaches both the wake summary/body and the payload.
  it('surfaces each draft\'s ACTUAL elapsed staleness, not just the fixed threshold', async () => {
    const now = NOW;
    await fireReviewWake('ws-1', 'queen-owner-1', [draft('scout-stale-for-weeks', 21 * 24)], 3_600, 'pot-1', now);
    const call = wakeMug.mock.calls[0][0];
    expect(call.summary).toContain('21d');
    expect(call.body).toContain('21d');
    expect(call.payload.oldestStaleMs).toBe(21 * 24 * HOUR);
  });

  it('defaults `now` to Date.now() when omitted (real-world call sites never pass a stale clock)', async () => {
    const before = Date.now();
    await fireReviewWake('ws-1', 'queen-owner-1', [{ planSlug: 'x', title: null, updatedAtMs: before }], 3_600);
    const call = wakeMug.mock.calls[0][0];
    expect(call.payload.oldestStaleMs).toBeGreaterThanOrEqual(0);
    expect(call.payload.oldestStaleMs).toBeLessThan(5_000); // sanity: not some huge stale default
  });
});

describe('formatStaleDuration (EI-13220)', () => {
  it('reports sub-hour staleness as "<1h" (never a misleading "0h")', () => {
    expect(formatStaleDuration(0)).toBe('<1h');
    expect(formatStaleDuration(30 * 60_000)).toBe('<1h');
  });

  it('reports whole hours under a day', () => {
    expect(formatStaleDuration(5 * HOUR)).toBe('5h');
    expect(formatStaleDuration(23 * HOUR)).toBe('23h');
  });

  it('reports days once past 24h, with leftover hours', () => {
    expect(formatStaleDuration(24 * HOUR)).toBe('1d');
    expect(formatStaleDuration(25 * HOUR)).toBe('1d 1h');
    expect(formatStaleDuration(21 * 24 * HOUR)).toBe('21d');
  });

  it('never goes negative (a clock skew reads as "<1h", never "-3h")', () => {
    expect(formatStaleDuration(-10_000)).toBe('<1h');
  });
});

describe('scoutDraftReviewStaleSec tunable', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults to a 12h stale threshold', () => {
    delete process.env.PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC;
    expect(scoutDraftReviewStaleSec()).toBe(43_200);
  });

  it('honors PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC (and <=0 = kill switch)', () => {
    process.env.PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC = '7200';
    expect(scoutDraftReviewStaleSec()).toBe(7_200);
    process.env.PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC = '0';
    expect(scoutDraftReviewStaleSec()).toBe(0);
  });

  it('falls back to the default on a non-numeric value (fail-soft)', () => {
    process.env.PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC = 'nonsense';
    expect(scoutDraftReviewStaleSec()).toBe(43_200);
  });
});
