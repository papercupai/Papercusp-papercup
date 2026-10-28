import { describe, it, expect, vi, beforeEach } from 'vitest';

// WI-6584: recordEditAttribution's plan_slug fix reads presence + the work-item claim —
// mock both seams plus the raw SQL handle so the INSERT's actual bound values are
// inspectable without a real Postgres connection.
const insertCalls: unknown[][] = [];
// WI-37668: readEditAttributionRoster's tests need the tagged-template to RETURN rows (and to be
// able to fail), so the stub reads from a mutable holder. Defaults keep every pre-existing
// recordEditAttribution test byte-identical (they only inspect insertCalls, never the result).
const sqlStub: { rows: unknown[]; throws: boolean } = { rows: [], throws: false };
// P-005 (change-provenance-and-admission-throughput-2026-10-27): the writer reads the
// editor's HELD set from harness_shared.work_items before the INSERT. That read is routed
// to its own stub so insertCalls keeps holding only ledger statements.
const heldCalls: unknown[][] = [];
const heldStub: { rows: Array<{ harness_slug: string | null; feature_id: string }>; throws: boolean } = {
  rows: [],
  throws: false,
};
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    sql: Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join('?').includes('FROM harness_shared.work_items')) {
          heldCalls.push(values);
          return heldStub.throws ? Promise.reject(new Error('pg unreachable')) : Promise.resolve(heldStub.rows);
        }
        insertCalls.push(values);
        if (sqlStub.throws) return Promise.reject(new Error('pg unreachable'));
        return Promise.resolve(sqlStub.rows);
      },
      { begin: vi.fn(), unsafe: () => Promise.resolve([]) },
    ),
  }),
}));

let mockPresence: { currentPlanSlug: string | null; intent?: string | null } | null = null;
vi.mock('./agent-tools/coordination/presence', () => ({
  getPresence: async () => mockPresence,
}));

import {
  parsePapercuspTrailers,
  readEditAttributionRoster,
  recordEditAttribution,
  resolveEditWorkItem,
} from './edit-attribution';
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';

beforeEach(() => {
  heldCalls.length = 0;
  heldStub.rows = [];
  heldStub.throws = false;
});

describe('readEditAttributionRoster — workspace-scoped, never repo_root-scoped (WI-37668)', () => {
  beforeEach(() => {
    insertCalls.length = 0;
    sqlStub.rows = [];
    sqlStub.throws = false;
  });

  const row = (over: Partial<Record<string, unknown>> = {}) => ({
    agent_id: 'su-70b6af5b',
    file: 'packages/operator-core/lib/doc-projection/project-doc-parts.test.ts',
    work_item_id: null,
    plan_slug: null,
    intent: null,
    session_id: null,
    contributor: null,
    ...over,
  });

  // THE REGRESSION GUARD. The old implementation bound the syncing repo's ABSOLUTE ROOT as the
  // scope key (`WHERE repo_root = …/papercusp`), while every ledger row is written under the
  // repo root of whichever operator process served locks:acquire (…/papercup-release). That
  // matched 0 of ~3.4k rows/day and made derived attribution silently inert. This test fails
  // against that implementation, because a filesystem path would appear in the bound values.
  it('binds the workspace id as the scope — and never a filesystem path', async () => {
    await readEditAttributionRoster({ workspaceId: 'papercusp-workspace' });
    expect(insertCalls).toHaveLength(1);
    const bound = insertCalls[0].filter((v): v is string => typeof v === 'string');
    expect(bound).toContain('papercusp-workspace');
    expect(bound.filter((v) => v.startsWith('/'))).toEqual([]);
  });

  it('attributes a row whose repo_root differs from the syncing repo (the live shape)', async () => {
    sqlStub.rows = [row({ work_item_id: 'WI-37668', intent: 'fix attribution scope' })];
    const roster = await readEditAttributionRoster({ workspaceId: 'papercusp-workspace' });
    expect(roster).toEqual([
      {
        agent: 'su-70b6af5b',
        files: ['packages/operator-core/lib/doc-projection/project-doc-parts.test.ts'],
        workItems: ['WI-37668'],
        intent: 'fix attribution scope',
      },
    ]);
  });

  it('returns the latest edit timestamp per file for fair commit-group ordering', async () => {
    const editedAt = '2026-10-14T23:45:08.212Z';
    sqlStub.rows = [row({ file: 'a.ts', edited_at_ms: Date.parse(editedAt) })];

    const roster = await readEditAttributionRoster({ workspaceId: 'papercusp-workspace' });

    expect(roster[0]?.editedAtMsByFile).toEqual({ 'a.ts': Date.parse(editedAt) });
  });

  it('groups multiple files under one agent and keeps distinct agents apart', async () => {
    sqlStub.rows = [
      row({ agent_id: 'su-aaa', file: 'a.ts', work_item_id: 'WI-1' }),
      row({ agent_id: 'su-aaa', file: 'b.ts', work_item_id: 'WI-1' }),
      row({ agent_id: 'su-bbb', file: 'c.ts', work_item_id: 'WI-2' }),
    ];
    const roster = await readEditAttributionRoster({ workspaceId: 'papercusp-workspace' });
    expect(roster).toHaveLength(2);
    expect(roster.find((e) => e.agent === 'su-aaa')?.files).toEqual(['a.ts', 'b.ts']);
    expect(roster.find((e) => e.agent === 'su-aaa')?.workItems).toEqual(['WI-1']); // deduped
    expect(roster.find((e) => e.agent === 'su-bbb')?.files).toEqual(['c.ts']);
  });

  it('keeps one agent\'s different work-item cohorts separate', async () => {
    sqlStub.rows = [
      row({ agent_id: 'su-aaa', file: 'old.ts', work_item_id: 'WI-40700', intent: 'old lane' }),
      row({ agent_id: 'su-aaa', file: 'new.ts', work_item_id: null, intent: 'WI-40703 new lane' }),
    ];
    const roster = await readEditAttributionRoster({ workspaceId: 'papercusp-workspace' });
    expect(roster).toEqual([
      { agent: 'su-aaa', files: ['old.ts'], workItems: ['WI-40700'], intent: 'old lane' },
      { agent: 'su-aaa', files: ['new.ts'], workItems: [], intent: 'WI-40703 new lane' },
    ]);
  });

  it('returns [] without a workspace id rather than reading across every workspace', async () => {
    expect(await readEditAttributionRoster({ workspaceId: null })).toEqual([]);
    expect(await readEditAttributionRoster({ workspaceId: undefined })).toEqual([]);
    expect(await readEditAttributionRoster({ workspaceId: '' })).toEqual([]);
    expect(insertCalls).toHaveLength(0); // never even issues the query
  });

  it('honours a custom lookback window', async () => {
    await readEditAttributionRoster({ workspaceId: 'papercusp-workspace', lookbackHours: 3 });
    expect(insertCalls[0]).toContain(3);
  });

  it('degrades to [] when the ledger read fails, so git-sync falls back to presence', async () => {
    sqlStub.throws = true;
    await expect(readEditAttributionRoster({ workspaceId: 'papercusp-workspace' })).resolves.toEqual([]);
  });
});

describe('recordEditAttribution — plan_slug fill (WI-6584)', () => {
  beforeEach(() => {
    insertCalls.length = 0;
    mockPresence = null;
  });

  it('fills plan_slug from the agent\'s live presence row when declared', async () => {
    mockPresence = { currentPlanSlug: 'bug-drain-nonp2p-2026-07-11' };
    await recordEditAttribution({
      repoRoot: '/repo',
      files: ['a.ts'],
      agentId: 'su-1',
      workspaceId: 'ws-1',
    });
    expect(insertCalls).toHaveLength(1);
    // SELECT $1, f, $2, $3, $4, $5, $6, $7, $8, $9 FROM unnest($10::text[]) — plan_slug is
    // the 8th bound value (0-indexed 7): repoRoot, agentId, sessionId, contributor,
    // workspaceId, harnessSlug, workItemId, planSlug, intent, files.
    expect(insertCalls[0][7]).toBe('bug-drain-nonp2p-2026-07-11');
  });

  it('leaves plan_slug null when the agent has no declared plan (never guesses)', async () => {
    mockPresence = { currentPlanSlug: null };
    await recordEditAttribution({
      repoRoot: '/repo',
      files: ['a.ts'],
      agentId: 'su-1',
      workspaceId: 'ws-1',
    });
    expect(insertCalls[0][7]).toBeNull();
  });

  it('leaves plan_slug null when presence lookup fails (best-effort, never throws)', async () => {
    mockPresence = null; // simulate no presence row / lookup miss
    await recordEditAttribution({
      repoRoot: '/repo',
      files: ['a.ts'],
      agentId: 'su-1',
      workspaceId: 'ws-1',
    });
    expect(insertCalls[0][7]).toBeNull();
  });

  it('still fills harnessSlug/workItemId from the single held item alongside plan_slug from presence', async () => {
    heldStub.rows = [{ harness_slug: 'papercusp', feature_id: 'WI-6584' }];
    mockPresence = { currentPlanSlug: 'my-plan' };
    await recordEditAttribution({
      repoRoot: '/repo',
      files: ['a.ts'],
      agentId: 'su-1',
      workspaceId: 'ws-1',
    });
    const [, , , , , harnessSlug, workItemId, planSlug] = insertCalls[0];
    expect(harnessSlug).toBe('papercusp');
    expect(workItemId).toBe('WI-6584');
    expect(planSlug).toBe('my-plan');
  });
});

describe('recordEditAttribution — authoritative state-stamp goal (WI-39137)', () => {
  beforeEach(() => {
    insertCalls.length = 0;
    sqlStub.rows = [];
    sqlStub.throws = false;
    mockPresence = null;
  });

  const recordedWorkItem = () => {
    const insert = insertCalls.at(-1)!;
    return { harnessSlug: insert[5], workItemId: insert[6] };
  };

  const recordedResolution = () => {
    const insert = insertCalls.at(-1)!;
    return { resolution: insert[11], candidates: insert[12] };
  };

  it('uses the goal pointer when it names an item the editor holds', async () => {
    heldStub.rows = [
      { harness_slug: 'papercusp', feature_id: 'WI-39137' },
      { harness_slug: 'papercusp', feature_id: 'WI-wrong-newest' },
    ];

    await recordEditAttribution({
      repoRoot: '/repo',
      files: ['a.ts'],
      agentId: 'su-1',
      workspaceId: 'ws-1',
      goalRef: 'WI-39137',
    });

    expect(heldCalls).toHaveLength(1); // one held-set read
    expect(heldCalls[0]).toEqual(expect.arrayContaining(['ws-1', 'su-1']));
    expect(heldCalls[0]).toContainEqual([...ANY_FAMILY_TERMINAL_STATES]);
    expect(insertCalls).toHaveLength(1); // the ledger INSERT only
    expect(recordedWorkItem()).toEqual({ harnessSlug: 'papercusp', workItemId: 'WI-39137' });
    expect(recordedResolution()).toEqual({ resolution: 'goal-ref', candidates: null });
  });

  it('writes honest nulls for an invalid explicit goal instead of guessing from a competing claim', async () => {
    heldStub.rows = [{ harness_slug: 'papercusp', feature_id: 'WI-wrong-newest' }];

    await recordEditAttribution({
      repoRoot: '/repo',
      files: ['a.ts'],
      agentId: 'su-1',
      workspaceId: 'ws-1',
      goalRef: 'plan:history#P-003',
    });

    expect(insertCalls).toHaveLength(1);
    expect(recordedWorkItem()).toEqual({ harnessSlug: null, workItemId: null });
    expect(recordedResolution()).toEqual({ resolution: 'goal-ref-unowned', candidates: ['WI-wrong-newest'] });
  });

  it('records lookup-failed (not none) when the held-set read fails', async () => {
    heldStub.throws = true;
    await recordEditAttribution({ repoRoot: '/repo', files: ['a.ts'], agentId: 'su-1', workspaceId: 'ws-1' });
    expect(recordedWorkItem()).toEqual({ harnessSlug: null, workItemId: null });
    expect(recordedResolution()).toEqual({ resolution: 'lookup-failed', candidates: null });
  });

  it('stamps the single held item when no goal pointer was supplied', async () => {
    heldStub.rows = [{ harness_slug: 'legacy-harness', feature_id: 'WI-legacy' }];

    await recordEditAttribution({
      repoRoot: '/repo',
      files: ['a.ts'],
      agentId: 'su-1',
      workspaceId: 'ws-1',
    });

    expect(heldCalls).toHaveLength(1);
    expect(insertCalls).toHaveLength(1);
    expect(recordedWorkItem()).toEqual({ harnessSlug: 'legacy-harness', workItemId: 'WI-legacy' });
    expect(recordedResolution()).toEqual({ resolution: 'single-holder', candidates: null });
  });
});

describe('resolveEditWorkItem — choose from the held set (P-005, R-4)', () => {
  const held = [
    { harnessSlug: 'papercusp', workItemId: 'WI-12' },
    { harnessSlug: 'papercusp', workItemId: 'WI-123' },
  ];
  const base = { goalRef: null, held, lockIntent: null, declaredIntent: null };

  it('records none when the editor holds nothing', () => {
    expect(resolveEditWorkItem({ ...base, held: [] })).toEqual({
      harnessSlug: null, workItemId: null, resolution: 'none', candidates: null,
    });
  });

  it('picks the item the lock intent names when several are held', () => {
    expect(resolveEditWorkItem({ ...base, lockIntent: 'fixing WI-123 stamping' })).toMatchObject({
      workItemId: 'WI-123', resolution: 'lock-intent',
    });
  });

  it('falls back to the declared intent when the lock intent names none', () => {
    expect(resolveEditWorkItem({ ...base, lockIntent: 'tidy', declaredIntent: 'working WI-12 now' })).toMatchObject({
      workItemId: 'WI-12', resolution: 'declared-intent',
    });
  });

  it('matches ids as whole tokens (WI-12 never matches WI-123)', () => {
    expect(resolveEditWorkItem({ ...base, declaredIntent: 'on WI-123' })).toMatchObject({ workItemId: 'WI-123' });
  });

  it('leaves several-held unstamped with candidates when no intent singles one out', () => {
    expect(resolveEditWorkItem({ ...base, declaredIntent: 'WI-12 and WI-123' })).toEqual({
      harnessSlug: null, workItemId: null, resolution: 'ambiguous', candidates: ['WI-12', 'WI-123'],
    });
  });
});

describe('recordEditAttribution — intent is DECLARED work, never the lock hook label (EI-20055604348536487)', () => {
  // THE REGRESSION GUARD. Before this fix, `intent` was written straight from the lock's own
  // `args.intent`, which for the automatic per-edit file-lock hook is the literal
  // `PreToolUse:{tool_name}`. Measured over 24h (n=3,257): 3,047 'PreToolUse:Edit' + 210
  // 'PreToolUse:Write' vs ~50 rows with a real intent — 97.5% of the column was the name of the
  // hook. git-sync renders this field as a commit SUBJECT, so the sentinel was one reader-side
  // filter away from becoming the fleet's commit messages.
  //
  // The failure is silent in the expensive direction: a sentinel is NON-EMPTY, so every
  // "did we record an intent?" check passes while the recorded value describes no work at all.
  // These assertions pin the value, not its presence.
  const call = (over: Record<string, unknown> = {}) =>
    recordEditAttribution({
      repoRoot: '/repo',
      files: ['a.ts'],
      agentId: 'su-1',
      workspaceId: 'ws',
      ...over,
    });
  /** [repoRoot, agentId, sessionId, contributor, workspaceId, harnessSlug, workItemId, planSlug, intent, acquiredVia, files] */
  const recorded = () => ({ intent: insertCalls[0][8], acquiredVia: insertCalls[0][9] });

  beforeEach(() => {
    insertCalls.length = 0;
    mockPresence = null;
  });

  it('records the DECLARED intent and files the hook label under acquired_via', async () => {
    mockPresence = { currentPlanSlug: null, intent: 'WI-42: fix the sync resolver' };
    await call({ intent: 'PreToolUse:Edit' });
    expect(recorded()).toEqual({
      intent: 'WI-42: fix the sync resolver',
      acquiredVia: 'PreToolUse:Edit',
    });
  });

  it('writes NULL intent rather than a sentinel when the agent declared nothing', async () => {
    // D-003: an honest unattributed edit beats a confident wrong one. NULL is what every
    // consumer already handles ("no usable intent, fall back"); 'PreToolUse:Edit' is not.
    mockPresence = { currentPlanSlug: null, intent: null };
    await call({ intent: 'PreToolUse:Write' });
    expect(recorded()).toEqual({ intent: null, acquiredVia: 'PreToolUse:Write' });
  });

  it('treats the presence PLACEHOLDER as no-intent, not as intent', async () => {
    // The turn-start hook heartbeats this exact string every turn, so it is present far more
    // often than a real intent — recovering it would have re-created the bug with a new literal.
    mockPresence = { currentPlanSlug: null, intent: '(active — see coord:presence for current work)' };
    await call({ intent: 'PreToolUse:Edit' });
    expect(recorded()).toEqual({ intent: null, acquiredVia: 'PreToolUse:Edit' });
  });

  it('leaves a hand-declared lock intent alone (acquired_via stays NULL)', async () => {
    // A multi-file hold acquired by hand already carries real intent; presence must NOT override
    // it — the lock's own intent is the more specific statement about THIS edit.
    mockPresence = { currentPlanSlug: null, intent: 'something else entirely' };
    await call({ intent: 'WI-7: hold across the package-lock regeneration' });
    expect(recorded()).toEqual({
      intent: 'WI-7: hold across the package-lock regeneration',
      acquiredVia: null,
    });
  });

  it('does NOT misclassify a declared intent that talks ABOUT the hook label', async () => {
    // The anchoring falsifier: the predicate matches a PREFIX, not a substring. This is the
    // intent that produced this very fix, and a substring test would have silently discarded it —
    // the failure mode being fixed, re-created by the fix.
    mockPresence = {
      currentPlanSlug: null,
      intent: 'EI-20055604348536487: stop PreToolUse:Edit leaking into the attribution ledger',
    };
    await call({ intent: 'PreToolUse:Edit' });
    expect(recorded().intent).toBe(
      'EI-20055604348536487: stop PreToolUse:Edit leaking into the attribution ledger',
    );
  });

  it('records neither when the caller passed no intent at all', async () => {
    // apply-on-grant and other non-hook callers: absent stays absent, and must not invent a label.
    mockPresence = { currentPlanSlug: null, intent: null };
    await call({});
    expect(recorded()).toEqual({ intent: null, acquiredVia: null });
  });
});

describe('parsePapercuspTrailers (deterministic-commit-workitem-attribution P-004)', () => {
  it('parses Papercusp-Agent/Work-Item/Session/Plan from a per-agent commit body', () => {
    const body = [
      'fix a [skip ci]',
      '',
      'Co-Authored-By: ag1 <ag1@agents.papercusp>',
      'Papercusp-Agent: su-abc',
      'Papercusp-Work-Item: WI-1, WI-2',
      'Papercusp-Session: sess-9',
      'Papercusp-Plan: plan-x',
    ].join('\n');
    expect(parsePapercuspTrailers(body)).toEqual({
      agent: 'su-abc',
      workItems: ['WI-1', 'WI-2'],
      sessionId: 'sess-9',
      planSlug: 'plan-x',
    });
  });

  it('returns empty workItems and no fields for a plain (un-attributed) commit', () => {
    expect(parsePapercuspTrailers('chore(git-sync): auto-commit [skip ci]')).toEqual({ workItems: [] });
  });

  it('tolerates a single work-item and missing optional trailers', () => {
    const body = 'subj\n\nPapercusp-Agent: a\nPapercusp-Work-Item: WI-9';
    expect(parsePapercuspTrailers(body)).toEqual({ agent: 'a', workItems: ['WI-9'] });
  });

  it('keeps the FIRST agent as primary and lists every author of a multi-author commit (WI-6554700010029864)', () => {
    const body = 'subj\n\nPapercusp-Agent: a\nPapercusp-Agent: b\nPapercusp-Agent: a\nPapercusp-Work-Item: WI-1, WI-2';
    expect(parsePapercuspTrailers(body)).toEqual({ agent: 'a', agents: ['a', 'b'], workItems: ['WI-1', 'WI-2'] });
  });

  it('round-trips the exact trailer lines run-git-sync writes', () => {
    // mirrors the `-m` values commitAttributedGroups pushes onto `git commit`.
    const body = ['s', '', 'Papercusp-Agent: ag', 'Papercusp-Work-Item: WI-1, WI-2'].join('\n');
    const p = parsePapercuspTrailers(body);
    expect(p.agent).toBe('ag');
    expect(p.workItems).toEqual(['WI-1', 'WI-2']);
  });

  it('ignores a Papercusp-Work-Item with empty/whitespace tokens', () => {
    expect(parsePapercuspTrailers('s\n\nPapercusp-Work-Item: , WI-1 ,').workItems).toEqual(['WI-1']);
  });

  it('handles an empty / undefined body without throwing', () => {
    expect(parsePapercuspTrailers('')).toEqual({ workItems: [] });
    expect(parsePapercuspTrailers(undefined as unknown as string)).toEqual({ workItems: [] });
  });
});
