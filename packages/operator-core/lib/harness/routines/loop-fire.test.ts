import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  fireLoopWake,
  defaultLoopKickoff,
  spliceCurrentLoopCheckpoint,
  clipLoopCheckpointForWake,
  renderLoopCheckpointBlock,
  renderLoopWakeText,
  renderLoopWallsBlock,
  renderLoopChecksBlock,
  loopCheckpointStaleMs,
  decideLoopAwaitSuppression,
  rescheduleLoopAfterAwaitSuppression,
  rebaseLoopAfterAwaitCancellation,
  LOOP_WAKE_FULL_TEMPLATE_EVERY,
  LOOP_WAKE_CHECKPOINT_MAX_CHARS,
  LOOP_WAKE_EXPANDED_VERIFIED_CHECKS,
  LOOP_WAKE_SCAFFOLD_BYTE_BUDGETS,
  LOOP_AWAIT_SUPPRESSION_MAX_QUIET_MS,
  LOOP_AWAIT_HEARTBEAT_MS,
  LOOP_NON_PARKING_AWAIT_BINDING_KINDS,
  LOOP_AWAIT_SUPPRESSION_MAX_ACTIONABLE_HELD,
  defaultOwnerStewardsActiveGoal,
  type LoopFireDeps,
  type OwnerStewardshipDeps,
} from './loop-fire';
import { AGENT_OBLIGATION_REMINDER_BINDING_KIND } from '../../agent-obligation-reminders';
import { renderCheckLine, splitCarryNoteChecks, splitCarryNoteWalls, type CheckEntry } from '../../carry-note';

/** A fresh set of injected deps with sensible "allow + woke 1" defaults; override per test. */
function mkDeps(
  over: Partial<LoopFireDeps> = {},
): Required<
  Pick<
    LoopFireDeps,
    | 'checkFireGate'
    | 'readWakeDelta'
    | 'recordFire'
    | 'recordWithheld'
    | 'wake'
    | 'costCap'
    | 'getLoopCarryNoteWithMeta'
    | 'readFireCount'
    | 'incrementFireCount'
    | 'findWakeRecipe'
    | 'takeWallNag'
    | 'renderOwnerDirectives'
    | 'listBlockingAwaits'
    | 'countActionableHeldItems'
    | 'ownerStewardsActiveGoal'
    | 'readGoalHolderWakeState'
    | 'readLastDeliveredAt'
    | 'rescheduleSuppressedWake'
    | 'ensureWakeArmed'
    | 'armWakeForResume'
    | 'readBlockerLiveness'
  >
> {
  return {
    readWakeDelta: vi.fn(async () => null),
    checkFireGate: vi.fn(async () => ({ allow: true, consecutiveErrors: 0 })) as never,
    // EI-21526226279199560: defaults to the UNMEASURED verdict, so every unrelated test
    // keeps its wake text stamp-free — an unresolved blocker yields no line by design.
    readBlockerLiveness: vi.fn(async () => ({
      sessionState: null,
      lastActiveMsAgo: null,
    })) as never,
    recordFire: vi.fn(async () => {}) as never,
    recordWithheld: vi.fn(async () => {}) as never,
    wake: vi.fn(async () => ({
      targets: ['su-pinned'],
      keys: ['coord:inbox-wake:su-pinned'],
      woken: 1,
      staged: 0,
    })) as never,
    costCap: vi.fn(async () => ({ breach: false, spendCents: 0, capCents: null })) as never,
    getLoopCarryNoteWithMeta: vi.fn(async () => ({ note: null, updatedAtMs: null })) as never,
    readFireCount: vi.fn(async () => 0) as never,
    incrementFireCount: vi.fn(async () => {}) as never,
    findWakeRecipe: vi.fn(async () => null) as never,
    takeWallNag: vi.fn(async () => null) as never,
    renderOwnerDirectives: vi.fn(async () => null) as never,
    listBlockingAwaits: vi.fn(async () => []) as never,
    // WI-10004466: hermetic default — an UNKNOWN count keeps the pre-fix decision, so
    // every existing suppression test is unaffected and no test reaches real PG.
    countActionableHeldItems: vi.fn(async () => null) as never,
    // WI-10005778: hermetic default — UNKNOWN stewardship keeps the decision above, and no
    // test reaches real PG.
    ownerStewardsActiveGoal: vi.fn(async () => null) as never,
    // P-007: hermetic default — no goal-holder state block, and no test reaches the real agenda read.
    readGoalHolderWakeState: vi.fn(async () => null) as never,
    // P-024: hermetic default — "never delivered" keeps the pre-heartbeat ceiling.
    readLastDeliveredAt: vi.fn(async () => null) as never,
    rescheduleSuppressedWake: vi.fn(async () => true) as never,
    ensureWakeArmed: vi.fn(async () => false) as never,
    // EI-21417550055038906: mirrors the production default (armInboxWake succeeds);
    // hermetic so a cold-path unit test can never reach the real PG-backed arm.
    armWakeForResume: vi.fn(async () => ({
      awaitId: 1,
      eventKey: 'coord:inbox-wake:su-pinned',
      handleNote: 'resumable',
      minSleepSec: 60,
    })) as never,
    ...over,
  };
}

const baseInput = {
  routineId: 'rt_papercusp_loop_su-pinned',
  routineName: 'loop-su-pinned',
  workspaceId: 'papercusp-workspace',
  installSlug: 'papercusp',
  targetOwnerId: 'su-pinned',
  payloadTemplate: null as Record<string, unknown> | null,
};

describe('rescheduleLoopAfterAwaitSuppression — parked-loop CAS (EI-21350609923930437)', () => {
  it('moves a pure loop from infinity to the computed resume threshold', async () => {
    const statements: string[] = [];
    const values: unknown[][] = [];
    const sql = ((strings: TemplateStringsArray, ...args: unknown[]) => {
      statements.push(strings.join(' ? '));
      values.push(args);
      return Promise.resolve([{ id: 'rt-parked' }]);
    }) as never;
    const resumeAtMs = Date.parse('2026-08-24T16:30:00.000Z');

    await expect(
      rescheduleLoopAfterAwaitSuppression({
        sql,
        routineId: 'rt-parked',
        workspaceId: 'ws-1',
        installSlug: 'papercusp',
        routineName: 'loop-su-pinned',
        targetOwnerId: 'su-pinned',
        intervalSec: 300,
        resumeAtMs,
        drivingEventKey: 'work-item:claimable',
      }),
    ).resolves.toBe(true);

    expect(statements[0]).toContain('SET next_fire_at = GREATEST(now()');
    expect(statements[0]).toContain("next_fire_at = 'infinity'::timestamptz");
    expect(statements[0]).toContain("NOT jsonb_exists(trigger_config, 'cron')");
    expect(statements[0]).toContain("NOT jsonb_exists(trigger_config, 'rrule')");
    expect(values[0]).toContain('2026-08-24T16:30:00.000Z');
    expect(values[0]).toContain('rt-parked');

    // EI-21388574737613226: a successful await-suppression CAS must close the parked
    // transition with a forensic re-arm row.
    await new Promise((resolve) => setImmediate(resolve));
    const insertIndex = statements.findIndex((statement) =>
      statement.includes('INSERT INTO harness_shared.routine_loop_transitions'),
    );
    expect(insertIndex).toBeGreaterThan(0);
    expect(values[insertIndex]).toEqual(
      expect.arrayContaining([
        'ws-1',
        'papercusp',
        'rt-parked',
        'loop-su-pinned',
        'su-pinned',
        'rearmed',
        'await-suppression',
        '2026-08-24T16:30:00.000Z',
        300,
        JSON.stringify({ via: 'await-suppression', drivingEventKey: 'work-item:claimable' }),
      ]),
    );
  });
});

describe('rebaseLoopAfterAwaitCancellation — clear a deferred deadline (EI-24186993763548105)', () => {
  it('moves a finite delayed pure-loop wake back to one configured interval after cancellation', async () => {
    const statements: string[] = [];
    const values: unknown[][] = [];
    const sql = ((strings: TemplateStringsArray, ...args: unknown[]) => {
      statements.push(strings.join(' ? '));
      values.push(args);
      if (statements.length === 1) {
        return Promise.resolve([{
          id: 'rt-delayed',
          workspace_id: 'papercusp-workspace',
          install_slug: 'papercusp',
          name: 'loop-su-pinned',
          target_owner_id: 'su-pinned',
          reschedule_interval_sec: 60,
          next_fire_at: '2026-10-01T14:05:00.000Z',
        }]);
      }
      return Promise.resolve([]);
    }) as never;

    await expect(rebaseLoopAfterAwaitCancellation({
      sql,
      workspaceId: 'papercusp-workspace',
      targetOwnerId: 'su-pinned',
      eventKey: 'session:compacted:su-pinned',
    })).resolves.toBe(1);

    expect(statements[0]).toContain("SET next_fire_at = now() + (reschedule_interval_sec * interval '1 second')");
    expect(statements[0]).toContain("next_fire_at <> 'infinity'::timestamptz");
    expect(statements[0]).toContain("next_fire_at > now() + (reschedule_interval_sec * interval '1 second')");
    expect(statements[0]).toContain("NOT jsonb_exists(trigger_config, 'cron')");
    expect(statements[0]).toContain("NOT jsonb_exists(trigger_config, 'rrule')");
    expect(values[0]).toEqual(expect.arrayContaining(['papercusp-workspace', 'su-pinned']));

    await new Promise((resolve) => setImmediate(resolve));
    const insertIndex = statements.findIndex((statement) =>
      statement.includes('INSERT INTO harness_shared.routine_loop_transitions'),
    );
    expect(insertIndex).toBeGreaterThan(0);
    expect(values[insertIndex]).toEqual(expect.arrayContaining([
      'papercusp-workspace',
      'papercusp',
      'rt-delayed',
      'loop-su-pinned',
      'su-pinned',
      'rearmed',
      'await-cancel-recheck',
      '2026-10-01T14:05:00.000Z',
      60,
      JSON.stringify({ via: 'await-cancel-recheck', canceledEventKey: 'session:compacted:su-pinned' }),
    ]));
  });

  it('does not record a re-arm when no loop schedule is moved', async () => {
    const statements: string[] = [];
    const sql = ((strings: TemplateStringsArray) => {
      statements.push(strings.join(' ? '));
      return Promise.resolve([]);
    }) as never;

    await expect(rebaseLoopAfterAwaitCancellation({
      sql,
      workspaceId: 'papercusp-workspace',
      targetOwnerId: 'su-pinned',
      eventKey: 'work-item:claimable',
    })).resolves.toBe(0);
    expect(statements).toHaveLength(1);
  });
});

describe('renderLoopChecksBlock — contested verification is explicit on wake', () => {
  it('labels contested evidence ⚠ so a successor is told to re-check it', () => {
    const out = renderLoopChecksBlock([
      { claim: 'the suite is green', recheck: 'run the suite', contested: 'STILL RUNNING at compaction' },
    ]);
    expect(out).toContain('⚠ CONTESTED');
    expect(out).toContain('• ⚠ ');
    expect(out).toContain('STILL RUNNING');
    expect(out).not.toContain('✓ verified w/ evidence · ? PREDICTED');
  });

  it('keeps unsettled checks expanded and compacts older verified history by stable id', () => {
    const verified = Array.from({ length: 12 }, (_, index) => ({
      id: `settled-${index + 1}`,
      claim: `historical verified claim ${index + 1} ${'x'.repeat(180)}`,
      recheck: `probe-${index + 1}`,
      verified: `evidence-${index + 1}`,
    }));
    const out = renderLoopChecksBlock([
      ...verified,
      { id: 'pending', claim: 'audit is pending', recheck: 'read audit' },
      { id: 'contested', claim: 'gate is green', recheck: 'read gate', verified: 'pass', contested: 'red' },
    ])!;

    expect(out).toContain(`✓ ${verified.length - LOOP_WAKE_EXPANDED_VERIFIED_CHECKS} older verified check(s)`);
    expect(out).toContain('#settled-1');
    expect(out).toContain('#settled-12');
    expect(out).toContain('[#pending] audit is pending');
    expect(out).toContain('[#contested] gate is green');
    expect(out).not.toContain(`historical verified claim 1 ${'x'.repeat(180)}`);
    expect(out.length).toBeLessThan(1_500);
  });

  it('never compacts verified rows that lack a stable address', () => {
    const out = renderLoopChecksBlock(
      Array.from({ length: 4 }, (_, index) => ({ claim: `unaddressed ${index}`, verified: `evidence ${index}` })),
    )!;
    expect(out).not.toContain('older verified check(s)');
    expect(out).toContain('unaddressed 0');
    expect(out).toContain('unaddressed 3');
  });
});

describe('R-004 matched production check-renderer inputs', () => {
  const snapshot = JSON.parse(readFileSync(new URL(
    '../../../../../docs/evidence/byoc-p009-r004-matched-input-2026-10-13.json', import.meta.url,
  ), 'utf8')) as { snapshots: Array<{ kind: string; note: string }>;
    injectedBaseline: { summary: string; checksBlock: string; utf8_bytes: number } };
  // Exact pre-compactor algorithm at 61b1c090369cd89cd7445ec4ba7d06b744a08b18,
  // sharing the current parser/line renderer so only history compaction differs.
  const baseline = (checks: ReadonlyArray<CheckEntry>): string | null => checks.length ? (
    '🧪 CARRIED CHECKS — claims + probes (✓ verified w/ evidence · ⚠ CONTESTED: evidence contradicts verification; ' +
    '? PREDICTED: run the re-check before ' +
    'relying on it; update/clear via loop:checkpoint { checks }):\n' +
    checks.map((c) => `  ${renderCheckLine(c).replace(/^-\s*/, '• ')}`).join('\n')
  ) : null;
  const bytes = (text: string | null) => Buffer.byteLength(text ?? '', 'utf8');

  it('reduces the frozen historical check block by at least half without changing its source rows', () => {
    const note = snapshot.snapshots.find(row => row.kind === 'historical-production-note')!.note;
    const { body, walls } = splitCarryNoteWalls(note);
    const { checks } = splitCarryNoteChecks(body);
    const original = JSON.stringify({ note, checks, walls });
    expect(checks).toHaveLength(12);
    const candidate = renderLoopChecksBlock(checks)!;
    expect(bytes(candidate)).toBeLessThanOrEqual(bytes(baseline(checks)) / 2);
    expect(bytes(candidate)).toBeGreaterThan(candidate.length); // Unicode is measured as UTF-8.
    for (const check of checks) expect(candidate).toContain(`#${check.id}`);
    for (const check of checks.filter(c => !c.verified || c.contested || !c.id)) {
      expect(candidate).toContain(renderCheckLine(check).replace(/^-\s*/, '• '));
    }
    expect(candidate).toContain(renderCheckLine(checks.at(-1)!).replace(/^-\s*/, '• '));
    expect(JSON.stringify({ note, checks, walls })).toBe(original);
  });

  it('reduces the complete original injected wake using exactly its original check rows', () => {
    const { summary, checksBlock, utf8_bytes } = snapshot.injectedBaseline;
    expect(summary.split(checksBlock)).toHaveLength(2);
    const note = '## Checks\n' + checksBlock.split('\n').slice(1)
      .map(line => line.replace(/^  • /, '- ')).join('\n');
    const { checks } = splitCarryNoteChecks(note);
    expect(checks).toHaveLength(12);
    const original = JSON.stringify(checks);
    const candidateBlock = renderLoopChecksBlock(checks)!;
    const candidate = summary.replace(checksBlock, candidateBlock);
    expect(bytes(summary)).toBe(utf8_bytes);
    expect(bytes(candidate)).toBeLessThanOrEqual(utf8_bytes / 2);
    const [prefix, suffix] = summary.split(checksBlock);
    expect(candidate).toBe(prefix + candidateBlock + suffix); // Every non-check byte survives.
    for (const check of checks) expect(candidate).toContain(`#${check.id}`);
    expect(candidateBlock).toContain(renderCheckLine(checks.at(-1)!).replace(/^-\s*/, '• '));
    expect(JSON.stringify(checks)).toBe(original);
  });

  it('reports no check-block savings for the active production note with no check history', () => {
    const note = snapshot.snapshots.find(row => row.kind === 'active-production-note')!.note;
    const { body, walls } = splitCarryNoteWalls(note);
    const { body: narrative, checks } = splitCarryNoteChecks(body);
    expect(checks).toHaveLength(0);
    expect(walls).toHaveLength(1);
    expect(renderLoopChecksBlock(checks)).toBe(baseline(checks));
    const wake = renderLoopWakeText({ kickoff: 'P-009 matched input control', fireNumber: 145,
      checkpoint: narrative, checks, walls, nowMs: 1791912360000 });
    expect(wake).toContain(narrative);
    expect(wake).toContain(walls[0].claim);
    expect(wake).toContain(walls[0].recheck);
  });

  it('keeps Unicode authorizations, retractions and spent IDs expanded when evidence is unsettled', () => {
    const checks: CheckEntry[] = [
      { id: 'authorization', claim: '授权仅限 P-009', recheck: 'read current scope' },
      { id: 'retracted', claim: 'R-004 ≥50% was retracted', verified: 'old pass', contested: 'no pickup proof' },
      { id: 'spent', claim: 'Spent request ID 🔒 remains consumed', verified: 'receipt persisted' },
      { claim: 'Evidence without a stable ID cannot disappear ✅', verified: 'saved receipt' },
    ];
    const candidate = renderLoopChecksBlock(checks)!;
    expect(bytes(candidate)).toBeGreaterThan(candidate.length);
    for (const check of checks) expect(candidate).toContain(renderCheckLine(check).replace(/^-\s*/, '• '));
    expect(candidate).not.toContain('older verified check(s)');
  });
});

describe('fireLoopWake — the warm-wake fire (B-LOOP-3)', () => {
  it('wakes the SAME pinned session warm (the loop-continuity invariant)', async () => {
    const deps = mkDeps();
    const res = await fireLoopWake(baseInput, deps);

    expect(res).toMatchObject({ fired: true, woken: 1 });
    // Exactly one warm wake, to exactly the bound owner (never a broadcast).
    expect(deps.wake).toHaveBeenCalledTimes(1);
    const [recipients, opts] = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(recipients).toEqual(['su-pinned']);
    expect(opts).toMatchObject({ source: 'loop:rt_papercusp_loop_su-pinned', workspaceId: 'papercusp-workspace' });
    // Fire history (loop-wake-rate-limit-robustness P0b): a pre-fire 'attempt' then a
    // 'queued' 'attempt' — both PRESERVE the streak. The enqueue is NOT an 'ok': a queued
    // wake is not a survived turn. The turn OUTCOME owns ok/error (reconcile records 'ok' on
    // completion; the resume-exit handler / stuck-park backstop record 'error' on a death).
    expect(deps.recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-pinned', 'firing', 'attempt');
    expect(deps.recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-pinned', 'queued', 'attempt');
    // Crucially, the enqueue NEVER records an 'ok' outcome (that would prematurely reset the streak).
    expect(deps.recordFire).not.toHaveBeenCalledWith('papercusp', 'loop-su-pinned', expect.anything(), 'ok');
    // EI-14483: a PASSING gate never calls recordWithheld — that write is exclusive to
    // the fire-gate-deny path (asserted in the "FAILURE-STREAK gate trips" test below).
    expect(deps.recordWithheld).not.toHaveBeenCalled();
  });

  it('delivers the routine kickoff as the wake-turn text, falling back to the default', async () => {
    // Explicit kickoff from payload_template. A confirmed-empty carry-note also appends
    // the WI-5092 first-carry-note mandate (asserted in detail in the render suite below).
    const deps1 = mkDeps();
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: 'work plan X' } }, deps1);
    const summary1 = (deps1.wake as ReturnType<typeof vi.fn>).mock.calls[0][1].summary as string;
    expect(summary1.startsWith('work plan X')).toBe(true);
    expect(summary1).toContain('NO loop:checkpoint carry-note exists for this loop yet');

    // No kickoff → the default self-assign-work-items prompt.
    const deps2 = mkDeps();
    await fireLoopWake(baseInput, deps2);
    const summary2 = (deps2.wake as ReturnType<typeof vi.fn>).mock.calls[0][1].summary as string;
    expect(summary2.startsWith(defaultLoopKickoff(baseInput.routineId))).toBe(true);
  });

  it('re-resolves a persisted blockedOn at FIRE time and stamps a DEAD blocker into the wake (EI-21526226279199560)', async () => {
    // The bug: `blockedOn` reached the wake only as frozen prose prepended to the kickoff,
    // so a premise naming a peer that had since ENDED was re-delivered verbatim on every
    // wake — 2.5h and 6 clean wakes in the measured incident. Re-DELIVERING is not
    // re-EVALUATING; this test is the difference between the two.
    const deps = mkDeps({
      readBlockerLiveness: vi.fn(async () => ({
        sessionState: 'ended',
        lastActiveMsAgo: 3 * 60 * 60 * 1000,
      })) as never,
    });

    await fireLoopWake(
      {
        ...baseInput,
        payloadTemplate: {
          kickoff: 'work plan X',
          blockedOn: {
            reason: 'freeze imposed by su-d6ae254f, cannot touch the tree until it lifts',
            kind: 'agent',
            ref: 'su-d6ae254f',
            since: new Date(Date.now() - 2.5 * 60 * 60 * 1000).toISOString(),
          },
        },
      },
      deps,
    );

    expect(deps.readBlockerLiveness).toHaveBeenCalledWith('su-d6ae254f', expect.anything());
    const summary = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0][1].summary as string;
    expect(summary).toContain('THE AGENT YOU ARE BLOCKED ON IS DEAD');
    expect(summary).toContain('su-d6ae254f');
    // The stamp ANNOTATES the kickoff; it never replaces it.
    expect(summary).toContain('work plan X');
  });

  it('reads no liveness at all when the loop declared no blocker — the overwhelming majority of fires', async () => {
    const deps = mkDeps({ readBlockerLiveness: vi.fn() as never });
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: 'work plan X' } }, deps);
    expect(deps.readBlockerLiveness).not.toHaveBeenCalled();
  });

  it('appends open owner directives without replacing the routine kickoff', async () => {
    const deps = mkDeps({
      renderOwnerDirectives: vi.fn(async () => '📌 OPEN OWNER DIRECTIVES\n  • #3 "pin it"') as never,
    });

    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: 'work plan X' } }, deps);

    // P-008 / D-008: the wake renders the banner FOR the pinned target session,
    // so the viewer id rides with the read and rows THAT session cleared off its
    // own agenda drop out. Kept as an EXACT call-shape assertion rather than
    // objectContaining — a viewerOwnerId that silently went missing (or became
    // some other session's) is the whole failure mode, and is invisible to a
    // looser matcher.
    expect(deps.renderOwnerDirectives).toHaveBeenCalledWith('papercusp-workspace', {
      sql: undefined,
      viewerOwnerId: baseInput.targetOwnerId,
    });
    const summary = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0][1].summary as string;
    // Directives ride ABOVE everything after the kickoff; the WI-5092 first-carry-note
    // mandate (confirmed-empty note here) renders after them.
    expect(summary.startsWith('work plan X\n\n📌 OPEN OWNER DIRECTIVES\n  • #3 "pin it"')).toBe(true);
    expect(summary).toContain('NO loop:checkpoint carry-note exists for this loop yet');
  });

  it('splices the CURRENT loop:checkpoint into the wake-turn text at fire time (EI-7809)', async () => {
    const deps = mkDeps({
      getLoopCarryNoteWithMeta: vi.fn(async () => ({
        note: '## Did\nclosed WI-1\n\n## Next action\nclaim_next again',
        updatedAtMs: Date.now() - 60_000,
      })) as never,
    });
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: 'arm-time goal text' } }, deps);

    expect(deps.getLoopCarryNoteWithMeta).toHaveBeenCalledWith({
      harness: 'papercusp',
      ownerId: 'su-pinned',
      workspaceId: 'papercusp-workspace',
    });
    const [, opts] = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.summary).toContain('arm-time goal text');
    expect(opts.summary).toContain('Current loop:checkpoint');
    expect(opts.summary).toContain('this is the authority for what to do this wake');
    expect(opts.summary).toContain('## Next action\nclaim_next again');
  });

  it('a legacy getLoopCarryNote dep (no meta) still splices the note, with no age claim (back-compat)', async () => {
    const deps = mkDeps({
      getLoopCarryNoteWithMeta: undefined,
      getLoopCarryNote: vi.fn(async () => '## Next action\nresume the edit') as never,
    } as never);
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: 'arm-time goal text' } }, deps);
    const [, opts] = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.summary).toContain('you wrote it earlier');
    expect(opts.summary).toContain('## Next action\nresume the edit');
  });

  it('confirmed-empty note ⇒ kickoff + first-carry-note mandate; READ FAILURE stays byte-equivalent (WI-5092)', async () => {
    // A successful read that finds NO note appends the mandate — the audited gap is a
    // loop whose carry-note is never written.
    const depsNoNote = mkDeps();
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: 'work plan X' } }, depsNoNote);
    expect((depsNoNote.wake as ReturnType<typeof vi.fn>).mock.calls[0][1].summary).toBe(
      'work plan X\n\n⚠ NO loop:checkpoint carry-note exists for this loop yet. Write the FIRST one before this turn ends — loop:checkpoint { did, left, insight, next } — even on a quiet wake: with no carry-note, a cold wake, a successor, or a post-compaction resume reconstructs this loop from its arm-time goal text alone.',
    );

    // A FAILED read must NOT assert emptiness (a real note may exist behind the error) —
    // the wake prompt stays byte-equivalent to the kickoff, exactly as before.
    const depsReadFail = mkDeps({
      getLoopCarryNoteWithMeta: vi.fn(async () => {
        throw new Error('carry store down');
      }) as never,
    });
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: 'work plan Y' } }, depsReadFail);
    expect((depsReadFail.wake as ReturnType<typeof vi.fn>).mock.calls[0][1].summary).toBe('work plan Y');

    // The production reader fails soft and resolves with a sentinel instead of
    // rejecting. loop-fire must preserve that sentinel or it will reintroduce
    // the false "no checkpoint" assertion.
    const depsSwallowedReadFail = mkDeps({
      getLoopCarryNoteWithMeta: vi.fn(async () => ({
        note: null,
        updatedAtMs: null,
        readFailed: true,
      })) as never,
    });
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: 'work plan Z' } }, depsSwallowedReadFail);
    expect((depsSwallowedReadFail.wake as ReturnType<typeof vi.fn>).mock.calls[0][1].summary).toBe('work plan Z');
  });

  it('caps an oversized checkpoint before putting it in the wake prompt', () => {
    const out = spliceCurrentLoopCheckpoint('kickoff', 'x'.repeat(3_100));
    expect(out).toContain('kickoff');
    expect(out).toContain('MIDDLE elided for the wake prompt');
    expect(out.length).toBeLessThan(3_300);

    const block = renderLoopCheckpointBlock('y'.repeat(3_100), {});
    expect(block).toContain('MIDDLE elided for the wake prompt');
    expect(block!.length).toBeLessThan(3_400);
  });

  it('EI-18187: an over-cap carry-note keeps the load-bearing TAIL (## Next action), not just the head', () => {
    // Realistic Did/Left/Insight/Next carry-note whose head is padded past the cap so a
    // plain head-keep slice would drop ## Next action entirely.
    const note = [
      '## Did',
      'w'.repeat(LOOP_WAKE_CHECKPOINT_MAX_CHARS + 1_000),
      '## Left',
      'finish the deploy',
      '## Key insight',
      'the gate re-runs periodically, it does not react to the commit',
      '## Next action',
      'NEXT_ACTION_SENTINEL: release:deploy{op:status} then op:trigger if greenPin advanced',
    ].join('\n');
    const clipped = clipLoopCheckpointForWake(note);
    // The single most load-bearing line — the concrete next command — survives verbatim…
    expect(clipped).toContain('## Next action');
    expect(clipped).toContain('NEXT_ACTION_SENTINEL: release:deploy{op:status}');
    // …the middle was elided (not a full copy)…
    expect(clipped).toContain('MIDDLE elided for the wake prompt');
    expect(clipped.length).toBeLessThanOrEqual(LOOP_WAKE_CHECKPOINT_MAX_CHARS);
    // …and it still shows the start of the note for context.
    expect(clipped.startsWith('## Did')).toBe(true);

    // The same guarantee through renderLoopCheckpointBlock (the live wake path).
    const block = renderLoopCheckpointBlock(note, {})!;
    expect(block).toContain('NEXT_ACTION_SENTINEL: release:deploy{op:status}');
  });

  it('EI-26768687964947174: keeps ## Next action when rendered ## Checks follow it', () => {
    const checks = Array.from(
      { length: 12 },
      (_, index) => ({
        id: `check-${index}`,
        claim: `verified evidence retained in loop:checkpoint ${index}`,
        verified: `result-${index}`,
      }),
    );
    const note = [
      '## Did',
      'd'.repeat(LOOP_WAKE_CHECKPOINT_MAX_CHARS + 100),
      '## Next action',
      'NEXT_ACTION_SENTINEL: resume the held scheduler lane',
      '## Checks',
      ...checks.map((check) => renderCheckLine(check)),
    ].join('\n');

    const clipped = clipLoopCheckpointForWake(note);
    expect(clipped).toContain('## Next action');
    expect(clipped).toContain('NEXT_ACTION_SENTINEL: resume the held scheduler lane');
    expect(clipped.length).toBeLessThanOrEqual(LOOP_WAKE_CHECKPOINT_MAX_CHARS);

    const rendered = renderLoopWakeText({
      kickoff: '🔁 Continue the loop.',
      fireNumber: 1,
      checkpoint: note,
      checks,
    });
    expect(rendered).toContain('NEXT_ACTION_SENTINEL: resume the held scheduler lane');
    expect(rendered).toContain('CARRIED CHECKS');
    expect(rendered).toContain('#check-0');
    expect(rendered).toContain('#check-11');
  });

  it('FAILURE-STREAK gate trips → fire WITHHELD, no wake', async () => {
    const deps = mkDeps({
      checkFireGate: vi.fn(async () => ({
        allow: false,
        reason: 'backoff',
        consecutiveErrors: 4,
        retryAfterSec: 120,
      })) as never,
    });
    const res = await fireLoopWake(baseInput, deps);

    expect(res).toMatchObject({ fired: false, reason: 'fire-gate' });
    expect(deps.wake).not.toHaveBeenCalled();
    // No wake recorded — the gate withheld before any fire attempt.
    expect(deps.recordFire).not.toHaveBeenCalled();
    // EI-14483: the withhold IS durably recorded — to the separate last_withheld_*
    // columns, never last_fired_at/consecutive_errors (recordFire, asserted above).
    expect(deps.recordWithheld).toHaveBeenCalledTimes(1);
    expect(deps.recordWithheld).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-pinned',
      'fire-gate',
      expect.stringContaining('backoff'),
    );
  });

  it('COST-CAP breach → fire WITHHELD, no wake, recorded as an error', async () => {
    const deps = mkDeps({
      costCap: vi.fn(async () => ({ breach: true, spendCents: 750, capCents: 500 })) as never,
    });
    const res = await fireLoopWake({ ...baseInput, payloadTemplate: { costCapCents: 500 } }, deps);

    expect(res).toMatchObject({ fired: false, reason: 'cost-cap' });
    expect(deps.wake).not.toHaveBeenCalled();
    expect(deps.costCap).toHaveBeenCalledWith(
      expect.objectContaining({ routineId: baseInput.routineId, capCents: 500 }),
    );
    expect(deps.recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-pinned',
      expect.stringContaining('cost-cap'),
      'error',
    );
  });

  it('no cost-cap configured → the cost guard is never consulted', async () => {
    const deps = mkDeps();
    await fireLoopWake(baseInput, deps); // payloadTemplate null → no costCapCents
    expect(deps.costCap).not.toHaveBeenCalled();
  });

  describe('BLOCKING-AWAIT suppression (EI-10901)', () => {
    it('re-arms a parked pure loop at the earliest suppression threshold before withholding', async () => {
      const rearm = vi.fn(async () => true) as never;
      const deps = mkDeps({
        listBlockingAwaits: vi.fn(async () => [
          {
            eventKey: 'work-item:claimable',
            expiresTs: new Date(Date.now() + 5 * 60_000).toISOString(),
            createdAt: new Date().toISOString(),
          },
        ]) as never,
        rescheduleSuppressedWake: rearm,
      });
      const res = await fireLoopWake(baseInput, deps);

      expect(res).toMatchObject({ fired: false, reason: 'await-blocking' });
      expect(rearm).toHaveBeenCalledTimes(1);
      expect(rearm).toHaveBeenCalledWith(
        expect.objectContaining({
          routineId: baseInput.routineId,
          resumeAtMs: expect.any(Number),
        }),
      );
      const resumeAtMs = (rearm as ReturnType<typeof vi.fn>).mock.calls[0][0].resumeAtMs as number;
      expect(resumeAtMs).toBeGreaterThan(Date.now());
      expect(deps.wake).not.toHaveBeenCalled();
    });

    it('a re-arm write failure fails open and delivers the wake instead of leaving the row parked', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const deps = mkDeps({
        listBlockingAwaits: vi.fn(async () => [
          {
            eventKey: 'work-item:claimable',
            expiresTs: new Date(Date.now() + 5 * 60_000).toISOString(),
            createdAt: new Date().toISOString(),
          },
        ]) as never,
        rescheduleSuppressedWake: vi.fn(async () => {
          throw new Error('routine update unavailable');
        }) as never,
      });
      const res = await fireLoopWake(baseInput, deps);

      expect(res).toMatchObject({ fired: true, woken: 1 });
      expect(deps.wake).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('await suppression re-arm failed'));
      warn.mockRestore();
    });

    it('a zero-row re-arm CAS fails open and delivers instead of silently stranding infinity', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const deps = mkDeps({
        listBlockingAwaits: vi.fn(async () => [
          {
            eventKey: 'work-item:claimable',
            expiresTs: new Date(Date.now() + 5 * 60_000).toISOString(),
            createdAt: new Date().toISOString(),
          },
        ]) as never,
        rescheduleSuppressedWake: vi.fn(async () => false) as never,
      });
      const res = await fireLoopWake(baseInput, deps);

      expect(res).toMatchObject({ fired: true, woken: 1 });
      expect(deps.wake).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('compare-and-set matched no parked pure-loop row'));
      warn.mockRestore();
    });

    it('an active blocking await → fire WITHHELD, no wake, no fire recorded, withhold stamped', async () => {
      const deps = mkDeps({
        listBlockingAwaits: vi.fn(async () => [
          { eventKey: 'work-item:claimable', expiresTs: new Date(Date.now() + 5 * 60_000).toISOString(), createdAt: new Date().toISOString() },
        ]) as never,
      });
      const res = await fireLoopWake(baseInput, deps);

      expect(res).toMatchObject({ fired: false, reason: 'await-blocking' });
      expect(res.detail).toContain('work-item:claimable');
      expect(deps.wake).not.toHaveBeenCalled();
      // Matches the fire-gate pattern: a deliberate, expected skip is not fire-history noise.
      expect(deps.recordFire).not.toHaveBeenCalled();
      // WI-10005352: …but it IS stamped to last_withheld_*, so the stalled-loops guard's
      // withheld-fire veto sees it. Without this stamp the guard read every suppressed fire
      // as turnless and disarmed a session correctly parked on its await.
      expect(deps.recordWithheld).toHaveBeenCalledTimes(1);
      expect(deps.recordWithheld).toHaveBeenCalledWith(
        'papercusp',
        'loop-su-pinned',
        'await-blocking',
        expect.stringContaining('work-item:claimable'),
      );
    });

    it('a failed re-arm that fails open delivers the wake and stamps NO withhold (WI-10005352)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const deps = mkDeps({
        listBlockingAwaits: vi.fn(async () => [
          { eventKey: 'work-item:claimable', expiresTs: new Date(Date.now() + 5 * 60_000).toISOString(), createdAt: new Date().toISOString() },
        ]) as never,
        rescheduleSuppressedWake: vi.fn(async () => false) as never,
      });
      const res = await fireLoopWake(baseInput, deps);

      expect(res).toMatchObject({ fired: true, woken: 1 });
      // The wake was delivered, so a withhold stamp would wrongly veto a genuinely stalled loop.
      expect(deps.recordWithheld).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('no blocking awaits → fires normally (today’s behavior, unchanged)', async () => {
      const deps = mkDeps({ listBlockingAwaits: vi.fn(async () => []) as never });
      const res = await fireLoopWake(baseInput, deps);
      expect(res).toMatchObject({ fired: true, woken: 1 });
    });

    it('automatic blocked-item interest does not pause an active work loop', async () => {
      const deps = mkDeps({ listBlockingAwaits: vi.fn(async () => [{
        eventKey: 'work-item:unblocked:WI-aggregate', expiresTs: new Date(Date.now() + 30 * 60_000).toISOString(),
        createdAt: new Date().toISOString(), boundTo: { kind: 'work-item-blocked', ref: 'WI-aggregate' },
      }]) as never });
      const res = await fireLoopWake(baseInput, deps);
      expect(res).toMatchObject({ fired: true, woken: 1 });
      expect(deps.wake).toHaveBeenCalledTimes(1);
      expect(deps.rescheduleSuppressedWake).not.toHaveBeenCalled();
    });

    it('WI-10004466: a platform obligation-reminder await does not pause an active work loop', async () => {
      const deps = mkDeps({ listBlockingAwaits: vi.fn(async () => [{
        eventKey: 'plan:acceptance:agent-economy-flywheel-2026-08-30', expiresTs: null,
        createdAt: new Date().toISOString(),
        boundTo: { kind: 'agent-obligation', ref: 'obl:plan-independent-verification:x' },
      }]) as never });
      const res = await fireLoopWake(baseInput, deps);
      expect(res).toMatchObject({ fired: true, woken: 1 });
      expect(deps.rescheduleSuppressedWake).not.toHaveBeenCalled();
    });

    it('WI-10004466: a caller await does not pause the loop while the owner holds 2+ actionable items', async () => {
      const count = vi.fn(async () => 2);
      const deps = mkDeps({
        listBlockingAwaits: vi.fn(async () => [{
          eventKey: 'plan-item:done:su-mode-contract-identity-unification-2026-09-24:P-008',
          expiresTs: new Date(Date.now() + 60 * 60_000).toISOString(),
          createdAt: new Date().toISOString(),
        }]) as never,
        countActionableHeldItems: count as never,
      });
      const res = await fireLoopWake(baseInput, deps);
      expect(res).toMatchObject({ fired: true, woken: 1 });
      expect(deps.wake).toHaveBeenCalledTimes(1);
      expect(deps.rescheduleSuppressedWake).not.toHaveBeenCalled();
      expect(count).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: baseInput.targetOwnerId, workspaceId: baseInput.workspaceId }),
      );
    });

    it('WI-10004466: a caller await still parks the loop when the owner holds one actionable item (EI-10901 shape)', async () => {
      const deps = mkDeps({
        listBlockingAwaits: vi.fn(async () => [{
          eventKey: 'deploy:done', expiresTs: new Date(Date.now() + 10 * 60_000).toISOString(),
          createdAt: new Date().toISOString(),
        }]) as never,
        countActionableHeldItems: vi.fn(async () => 1) as never,
      });
      const res = await fireLoopWake(baseInput, deps);
      expect(res).toMatchObject({ fired: false, reason: 'await-blocking' });
      expect(deps.wake).not.toHaveBeenCalled();
    });

    it('WI-10004466: a failed actionable-count read keeps the suppression decision (never flips on a read error)', async () => {
      const deps = mkDeps({
        listBlockingAwaits: vi.fn(async () => [{
          eventKey: 'deploy:done', expiresTs: new Date(Date.now() + 10 * 60_000).toISOString(),
          createdAt: new Date().toISOString(),
        }]) as never,
        countActionableHeldItems: vi.fn(async () => {
          throw new Error('work_items read timed out');
        }) as never,
      });
      const res = await fireLoopWake(baseInput, deps);
      expect(res).toMatchObject({ fired: false, reason: 'await-blocking' });
    });

    it('WI-10004466: the actionable count is read only when an await would suppress', async () => {
      const count = vi.fn(async () => 5);
      const deps = mkDeps({ listBlockingAwaits: vi.fn(async () => []) as never, countActionableHeldItems: count as never });
      await fireLoopWake(baseInput, deps);
      expect(count).not.toHaveBeenCalled();
    });

    /** WI-10005778: the await coord:ask-owner auto-arms for its requester. */
    const ownerQuestionAwait = () => [{
      eventKey: 'conversation:answered:conv-owner-question',
      expiresTs: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
      createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      boundTo: { kind: 'conversation-question', ref: 'conv-owner-question' },
    }];

    it('WI-10005778: a goal holder with an open owner question still gets its stewardship wake', async () => {
      const stewardship = vi.fn(async () => true);
      const deps = mkDeps({
        listBlockingAwaits: vi.fn(async () => ownerQuestionAwait()) as never,
        countActionableHeldItems: vi.fn(async () => 0) as never,
        ownerStewardsActiveGoal: stewardship as never,
      });
      const res = await fireLoopWake(baseInput, deps);
      expect(res).toMatchObject({ fired: true, woken: 1 });
      expect(deps.wake).toHaveBeenCalledTimes(1);
      expect(deps.rescheduleSuppressedWake).not.toHaveBeenCalled();
      expect(stewardship).toHaveBeenCalledWith(expect.objectContaining({ ownerId: baseInput.targetOwnerId }));
    });

    it('WI-10005778: a non-holder parked on an owner question stays parked (RSR-P-024-A)', async () => {
      const deps = mkDeps({
        listBlockingAwaits: vi.fn(async () => ownerQuestionAwait()) as never,
        countActionableHeldItems: vi.fn(async () => 1) as never,
        ownerStewardsActiveGoal: vi.fn(async () => false) as never,
      });
      const res = await fireLoopWake(baseInput, deps);
      expect(res).toMatchObject({ fired: false, reason: 'await-blocking' });
      expect(deps.wake).not.toHaveBeenCalled();
    });

    it('WI-10005778: a failed goal-lease read keeps the suppression decision', async () => {
      const deps = mkDeps({
        listBlockingAwaits: vi.fn(async () => ownerQuestionAwait()) as never,
        ownerStewardsActiveGoal: vi.fn(async () => {
          throw new Error('goals read timed out');
        }) as never,
      });
      const res = await fireLoopWake(baseInput, deps);
      expect(res).toMatchObject({ fired: false, reason: 'await-blocking' });
    });

    // P-007 superseded "read only when an await would suppress": the goal-holder state block
    // needs the same verdict on every fire, so the lease is read exactly ONCE per fire and
    // shared by the suppression guard and the wake block — never twice.
    it('P-007: the goal lease is read once per fire, shared by suppression and the wake block', async () => {
      const quiet = vi.fn(async () => true);
      await fireLoopWake(baseInput, mkDeps({ listBlockingAwaits: vi.fn(async () => []) as never, ownerStewardsActiveGoal: quiet as never }));
      expect(quiet).toHaveBeenCalledTimes(1);

      const suppressing = vi.fn(async () => true);
      await fireLoopWake(
        baseInput,
        mkDeps({
          listBlockingAwaits: vi.fn(async () => ownerQuestionAwait()) as never,
          countActionableHeldItems: vi.fn(async () => 0) as never,
          ownerStewardsActiveGoal: suppressing as never,
        }),
      );
      expect(suppressing).toHaveBeenCalledTimes(1);
    });

    it('P-007: a goal holder wake carries the goal-holder state block beneath the priority stack', async () => {
      const block = 'GOAL-HOLDER STATE — goal g-1, read at fire time 2026-10-08T00:00:00.000Z.';
      const readGoalHolderWakeState = vi.fn(async () => block);
      const deps = mkDeps({
        listBlockingAwaits: vi.fn(async () => []) as never,
        ownerStewardsActiveGoal: vi.fn(async () => true) as never,
        readGoalHolderWakeState: readGoalHolderWakeState as never,
      });
      await fireLoopWake({ ...baseInput, intervalSec: 900 } as never, deps);
      expect(readGoalHolderWakeState).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: baseInput.targetOwnerId,
          loop: expect.objectContaining({ intervalSec: 900 }),
        }),
      );
      const summary = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0][1].summary as string;
      expect(summary).toContain(block);
    });

    it('P-007: a non-holder wake never reads or renders the goal-holder state block', async () => {
      for (const stewards of [false, null]) {
        const readGoalHolderWakeState = vi.fn(async () => 'GOAL-HOLDER STATE — must not render');
        const deps = mkDeps({
          listBlockingAwaits: vi.fn(async () => []) as never,
          ownerStewardsActiveGoal: vi.fn(async () => stewards) as never,
          readGoalHolderWakeState: readGoalHolderWakeState as never,
        });
        await fireLoopWake(baseInput, deps);
        expect(readGoalHolderWakeState).not.toHaveBeenCalled();
        const summary = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0][1].summary as string;
        expect(summary).not.toContain('GOAL-HOLDER STATE');
      }
    });

    it('P-007: a failed goal-holder state read ships the wake without the block', async () => {
      const deps = mkDeps({
        listBlockingAwaits: vi.fn(async () => []) as never,
        ownerStewardsActiveGoal: vi.fn(async () => true) as never,
        readGoalHolderWakeState: vi.fn(async () => {
          throw new Error('agenda read failed');
        }) as never,
      });
      const res = await fireLoopWake(baseInput, deps);
      expect(res).toMatchObject({ fired: true });
      const summary = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0][1].summary as string;
      expect(summary).not.toContain('GOAL-HOLDER STATE');
    });

    it('a monitor loop keeps its heartbeat despite an active blocking await', async () => {
      const deps = mkDeps({
        listBlockingAwaits: vi.fn(async () => [
          {
            eventKey: 'green-checkpoint:inconclusive:papercusp',
            expiresTs: new Date(Date.now() + 10 * 60_000).toISOString(),
            createdAt: new Date().toISOString(),
          },
        ]) as never,
      });
      const res = await fireLoopWake(
        { ...baseInput, intervalSec: 60, payloadTemplate: { mode: 'monitor' } },
        deps,
      );

      expect(res).toMatchObject({ fired: true, woken: 1 });
      expect(deps.wake).toHaveBeenCalledTimes(1);
    });

    it('a blocking-await READ FAILURE fails OPEN — the loop still fires (fail-soft, never wedges a loop)', async () => {
      const deps = mkDeps({
        listBlockingAwaits: vi.fn(async () => {
          throw new Error('await store down');
        }) as never,
      });
      const res = await fireLoopWake(baseInput, deps);
      expect(res).toMatchObject({ fired: true, woken: 1 });
    });

    it('a blocking await already past ITS OWN deadline → not suppressed (the sweeper owns firing it)', async () => {
      const deps = mkDeps({
        listBlockingAwaits: vi.fn(async () => [
          { eventKey: 'foo:bar', expiresTs: new Date(Date.now() - 1_000).toISOString(), createdAt: new Date(Date.now() - 60_000).toISOString() },
        ]) as never,
      });
      const res = await fireLoopWake(baseInput, deps);
      expect(res).toMatchObject({ fired: true, woken: 1 });
    });

    it('a deadline-less await older than the max-quiet ceiling → not suppressed (cannot silence the loop forever)', async () => {
      const deps = mkDeps({
        listBlockingAwaits: vi.fn(async () => [
          {
            eventKey: 'stuck:forever',
            expiresTs: null,
            createdAt: new Date(Date.now() - (LOOP_AWAIT_SUPPRESSION_MAX_QUIET_MS + 60_000)).toISOString(),
          },
        ]) as never,
      });
      const res = await fireLoopWake(baseInput, deps);
      expect(res).toMatchObject({ fired: true, woken: 1 });
    });

    it('a deadline-less await still within the max-quiet ceiling → suppressed', async () => {
      const deps = mkDeps({
        listBlockingAwaits: vi.fn(async () => [
          { eventKey: 'stuck:fresh', expiresTs: null, createdAt: new Date().toISOString() },
        ]) as never,
      });
      const res = await fireLoopWake(baseInput, deps);
      expect(res).toMatchObject({ fired: false, reason: 'await-blocking' });
    });
  });

  it('EI-16166: a missed wake (woke 0, staged 0) records an error and stays PARKED — it does NOT auto-end the loop on the first miss', async () => {
    const deps = mkDeps({
      wake: vi.fn(async () => ({
        targets: ['su-pinned'],
        keys: ['coord:inbox-wake:su-pinned'],
        woken: 0,
        staged: 0,
      })) as never,
    });
    const res = await fireLoopWake(baseInput, deps);

    expect(res).toMatchObject({ fired: false, reason: 'no-session-now', woken: 0 });
    // No immediate deactivation — a single miss must not silently kill the loop with no
    // owner alert (EI-16166). The error is recorded to feed the SAME failure-streak
    // circuit / stuck-park+quick-retry ladder every other death signal goes through;
    // only that ladder's reachability-vetoed terminal guard may eventually auto-pause it,
    // and it does so LOUDLY (escalateDeadLoop), unlike this fast path.
    expect(deps.recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-pinned', 'no-session-now', 'error');
    // The direct arm fallback retries once. Since this fixture's retry still misses,
    // the failure is recorded without auto-ending the loop.
    expect(deps.armWakeForResume).toHaveBeenCalledTimes(1);
    expect(deps.wake).toHaveBeenCalledTimes(2);
  });

  describe('WI-5862: self-heal a missed wake when a live session has no active standing await', () => {
    it('ensureWakeArmed heals it → the wake is RETRIED and the retry reaching the session counts as fired (no error recorded)', async () => {
      const wake = vi
        .fn()
        // First attempt: nobody was listening (the standing inbox-wake await was missing).
        .mockResolvedValueOnce({ targets: ['su-pinned'], keys: [], woken: 0, staged: 0 })
        // Retry, after ensureWakeArmed re-armed the standing await: now reached.
        .mockResolvedValueOnce({ targets: ['su-pinned'], keys: ['coord:inbox-wake:su-pinned'], woken: 1, staged: 0 });
      const ensureWakeArmed = vi.fn(async () => true);
      const deps = mkDeps({ wake: wake as never, ensureWakeArmed: ensureWakeArmed as never });

      const res = await fireLoopWake(baseInput, deps);

      expect(ensureWakeArmed).toHaveBeenCalledWith({ ownerId: 'su-pinned', workspaceId: 'papercusp-workspace' });
      expect(wake).toHaveBeenCalledTimes(2);
      expect(res).toMatchObject({ fired: true, woken: 1, staged: 0 });
      expect(deps.recordFire).not.toHaveBeenCalledWith('papercusp', 'loop-su-pinned', 'no-session-now', 'error');
      expect(deps.incrementFireCount).toHaveBeenCalledTimes(1); // the healed retry consumes a fire slot
    });

    it('ensureWakeArmed heals it but the retry STILL misses (genuinely gone) → falls through to no-session-now, exactly one retry (no loop)', async () => {
      const wake = vi.fn(async () => ({ targets: ['su-pinned'], keys: [], woken: 0, staged: 0 }));
      const ensureWakeArmed = vi.fn(async () => true);
      const deps = mkDeps({ wake: wake as never, ensureWakeArmed: ensureWakeArmed as never });

      const res = await fireLoopWake(baseInput, deps);

      expect(wake).toHaveBeenCalledTimes(2); // original attempt + exactly one retry, never more
      expect(res).toMatchObject({ fired: false, reason: 'no-session-now', woken: 0, staged: 0 });
      expect(deps.recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-pinned', 'no-session-now', 'error');
    });

    it('ensureWakeArmed reports false → direct arm retries once before no-session-now', async () => {
      const wake = vi.fn(async () => ({ targets: ['su-pinned'], keys: [], woken: 0, staged: 0 }));
      const ensureWakeArmed = vi.fn(async () => false);
      const deps = mkDeps({ wake: wake as never, ensureWakeArmed: ensureWakeArmed as never });

      const res = await fireLoopWake(baseInput, deps);

      expect(deps.armWakeForResume).toHaveBeenCalledTimes(1);
      expect(wake).toHaveBeenCalledTimes(2); // direct arm + exactly one retry
      expect(res).toMatchObject({ fired: false, reason: 'no-session-now' });
    });

    it('ensureWakeArmed throwing still falls through to direct arm and retry (fail-soft)', async () => {
      const wake = vi
        .fn()
        .mockResolvedValueOnce({ targets: ['su-pinned'], keys: [], woken: 0, staged: 0 })
        .mockResolvedValueOnce({ targets: ['su-pinned'], keys: [], woken: 1, staged: 0 });
      const ensureWakeArmed = vi.fn(async () => {
        throw new Error('pg unreachable');
      });
      const deps = mkDeps({ wake: wake as never, ensureWakeArmed: ensureWakeArmed as never });

      const res = await fireLoopWake(baseInput, deps);

      expect(deps.armWakeForResume).toHaveBeenCalledTimes(1);
      expect(wake).toHaveBeenCalledTimes(2);
      expect(res).toMatchObject({ fired: true, woken: 1 });
    });

    it('a normally-reached wake never consults ensureWakeArmed at all (no self-heal cost on the healthy path)', async () => {
      const ensureWakeArmed = vi.fn(async () => true);
      const deps = mkDeps({ ensureWakeArmed: ensureWakeArmed as never }); // default wake ⇒ woken:1
      await fireLoopWake(baseInput, deps);
      expect(ensureWakeArmed).not.toHaveBeenCalled();
    });
  });

  describe('EI-21417550055038906: a COLD fire with no watcher takes the resume channel, not the void', () => {
    const coldInput = { ...baseInput, payloadTemplate: { carry: 'cold' } as Record<string, unknown> };

    it('cold + no live session (ensure refuses) → arms the await DIRECTLY and the retried wake counts as fired', async () => {
      // The measured black-hole: each one-turn cold session dies, SessionEnd cancels
      // the standing await, the live-session-gated self-heal refuses (no live adv
      // row), and every fire emitted into the void (0/17 delivered). The direct arm
      // gives the emit a matching await whose executor ladder resumes the exited
      // session — the external coord:send wake:'required' babysitting, automated.
      const wake = vi
        .fn()
        .mockResolvedValueOnce({ targets: ['su-pinned'], keys: [], woken: 0, staged: 0 })
        .mockResolvedValueOnce({ targets: ['su-pinned'], keys: [], woken: 1, staged: 0 });
      const ensureWakeArmed = vi.fn(async () => false);
      const armWakeForResume = vi.fn(async (_req: { ownerId: string; note?: string }) => ({
        awaitId: 42,
        eventKey: 'coord:inbox-wake:su-pinned',
        handleNote: 'resumable',
        minSleepSec: 60,
      }));
      const deps = mkDeps({
        wake: wake as never,
        ensureWakeArmed: ensureWakeArmed as never,
        armWakeForResume: armWakeForResume as never,
      });

      const res = await fireLoopWake(coldInput, deps);

      expect(res).toMatchObject({ fired: true, woken: 1 });
      expect(armWakeForResume).toHaveBeenCalledTimes(1);
      expect(armWakeForResume.mock.calls[0][0]).toMatchObject({ ownerId: 'su-pinned' });
      expect(wake).toHaveBeenCalledTimes(2); // original miss + the post-arm retry
      expect(deps.recordFire).not.toHaveBeenCalledWith('papercusp', 'loop-su-pinned', 'no-session-now', 'error');
    });

    it('a WARM loop with a no-watcher miss directly arms and retries through the resume channel', async () => {
      const wake = vi
        .fn()
        .mockResolvedValueOnce({ targets: ['su-pinned'], keys: [], woken: 0, staged: 0 })
        .mockResolvedValueOnce({ targets: ['su-pinned'], keys: [], woken: 1, staged: 0 });
      const ensureWakeArmed = vi.fn(async () => false);
      const armWakeForResume = vi.fn(async (_req: { ownerId: string; note?: string }) => ({
        awaitId: 1,
        eventKey: 'coord:inbox-wake:su-pinned',
        handleNote: 'resumable',
        minSleepSec: 60,
      }));
      const deps = mkDeps({
        wake: wake as never,
        ensureWakeArmed: ensureWakeArmed as never,
        armWakeForResume: armWakeForResume as never,
      });

      const res = await fireLoopWake(baseInput, deps); // warm (no carry)

      expect(armWakeForResume).toHaveBeenCalledTimes(1);
      expect(armWakeForResume.mock.calls[0][0]).toMatchObject({ ownerId: 'su-pinned' });
      expect(wake).toHaveBeenCalledTimes(2);
      expect(res).toMatchObject({ fired: true, woken: 1 });
      expect(deps.recordFire).not.toHaveBeenCalledWith('papercup', 'loop-su-pinned', 'no-session-now', 'error');
    });

    it('the direct arm THROWING degrades fail-soft to no-session-now (never breaks the fire)', async () => {
      const wake = vi.fn(async () => ({ targets: ['su-pinned'], keys: [], woken: 0, staged: 0 }));
      const armWakeForResume = vi.fn(async () => {
        throw new Error('pg unreachable');
      });
      const deps = mkDeps({ wake: wake as never, armWakeForResume: armWakeForResume as never });

      const res = await fireLoopWake(coldInput, deps);

      expect(wake).toHaveBeenCalledTimes(1); // no retry without a successful arm
      expect(res).toMatchObject({ fired: false, reason: 'no-session-now' });
    });

    it('when ensureWakeArmed ALREADY healed (live session, lost arm), the cold direct-arm is not consulted', async () => {
      const wake = vi
        .fn()
        .mockResolvedValueOnce({ targets: ['su-pinned'], keys: [], woken: 0, staged: 0 })
        .mockResolvedValueOnce({ targets: ['su-pinned'], keys: [], woken: 1, staged: 0 });
      const ensureWakeArmed = vi.fn(async () => true);
      const armWakeForResume = vi.fn(async () => ({
        awaitId: 1,
        eventKey: 'k',
        handleNote: '',
        minSleepSec: 60,
      }));
      const deps = mkDeps({
        wake: wake as never,
        ensureWakeArmed: ensureWakeArmed as never,
        armWakeForResume: armWakeForResume as never,
      });

      const res = await fireLoopWake(coldInput, deps);

      expect(res).toMatchObject({ fired: true });
      expect(armWakeForResume).not.toHaveBeenCalled();
    });
  });

  it('a staged wake (manual wake-mode / hive pause) counts as reached → queued (attempt, streak preserved)', async () => {
    const deps = mkDeps({
      wake: vi.fn(async () => ({ targets: ['su-pinned'], keys: [], woken: 0, staged: 1 })) as never,
    });
    const res = await fireLoopWake(baseInput, deps);
    expect(res).toMatchObject({ fired: true, staged: 1 });
    // Reached (staged) ⇒ 'queued'/'attempt' (preserve the streak), NOT 'ok' — the turn outcome owns ok.
    expect(deps.recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-pinned', 'queued', 'attempt');
    expect(deps.recordFire).not.toHaveBeenCalledWith('papercusp', 'loop-su-pinned', expect.anything(), 'ok');
  });

  it('Guard 3 (dead-man): a breach auto-pauses + withholds the wake + records an error (P2a)', async () => {
    const deadMan = vi.fn(async () => ({ breach: true, reason: 'max-duration 7200s > 3600s (since arm)' }));
    const deps = mkDeps({ deadMan: deadMan as never, incrementFireCount: vi.fn(async () => {}) as never });
    const res = await fireLoopWake({ ...baseInput, payloadTemplate: { maxDurationSec: 3600 } }, deps);
    expect(res).toMatchObject({ fired: false, reason: 'dead-man' });
    expect(deps.wake).not.toHaveBeenCalled(); // the wake was withheld
    expect(deps.recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-pinned',
      expect.stringContaining('dead-man'),
      'error',
    );
  });

  it('the fire counter is incremented UNCONDITIONALLY after a reached fire (P-001b — the full/short wake cadence reads it), but never on a non-reached one', async () => {
    // Plain warm loop, no maxFires, no cold — the previously-stuck-at-0 case.
    const deps = mkDeps({ deadMan: vi.fn(async () => ({ breach: false })) as never });
    await fireLoopWake({ ...baseInput, payloadTemplate: { maxDurationSec: 3600 } }, deps);
    expect(deps.incrementFireCount).toHaveBeenCalledTimes(1);
    await fireLoopWake(baseInput, deps);
    expect(deps.incrementFireCount).toHaveBeenCalledTimes(2);

    // A fire that reaches NO session consumes no slot.
    const depsMissed = mkDeps({
      wake: vi.fn(async () => ({ targets: ['su-pinned'], keys: [], woken: 0, staged: 0 })) as never,
    });
    await fireLoopWake(baseInput, depsMissed);
    expect(depsMissed.incrementFireCount).not.toHaveBeenCalled();
  });

  it('no target_owner_id → withheld with no gate/wake calls', async () => {
    const deps = mkDeps();
    const res = await fireLoopWake({ ...baseInput, targetOwnerId: '' }, deps);
    expect(res).toMatchObject({ fired: false, reason: 'no-target' });
    expect(deps.checkFireGate).not.toHaveBeenCalled();
    expect(deps.wake).not.toHaveBeenCalled();
  });
});

describe('fireLoopWake — cold-auto marker (su-cold-auto-mode-2026-07-03 P-003)', () => {
  it('a COLD loop stamps a {carry, wakeCount, harness} marker on the wake (wakeCount = priorFires+1) and advances the counter', async () => {
    const readFireCount = vi.fn(async () => 7); // 7 prior fires → this is the 8th
    const incrementFireCount = vi.fn(async () => {});
    const deps = mkDeps({ readFireCount: readFireCount as never, incrementFireCount: incrementFireCount as never });
    const res = await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: 'work plan X', carry: 'cold' } }, deps);

    expect(res).toMatchObject({ fired: true, woken: 1 });
    const [, opts] = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0];
    // harness = the loop's install_slug (the carry-note scope key); wakeCount = 8 → the
    // consumer's HYBRID cadence recycles this wake (8 % 8 === 0). WI-5510: `routineId`
    // additionally rides the marker for the delivery-side stale-fire guard.
    expect(opts.payload).toEqual({ carry: 'cold', wakeCount: 8, harness: 'papercusp', routineId: baseInput.routineId });
    // Counter advances so the NEXT cold wake's wakeCount is monotonic.
    expect(incrementFireCount).toHaveBeenCalledTimes(1);
  });

  it('the first cold fire (no prior fires) is wakeCount 1 (a RESET)', async () => {
    const deps = mkDeps({
      readFireCount: vi.fn(async () => 0) as never,
      incrementFireCount: vi.fn(async () => {}) as never,
    });
    await fireLoopWake({ ...baseInput, payloadTemplate: { carry: 'cold' } }, deps);
    expect((deps.wake as ReturnType<typeof vi.fn>).mock.calls[0][1].payload).toMatchObject({
      carry: 'cold',
      wakeCount: 1,
    });
  });

  it('a fire-count read miss fails soft to wakeCount 1 — never a throw', async () => {
    const deps = mkDeps({
      readFireCount: vi.fn(async () => {
        throw new Error('pg down');
      }) as never,
      incrementFireCount: vi.fn(async () => {}) as never,
    });
    const res = await fireLoopWake({ ...baseInput, payloadTemplate: { carry: 'cold' } }, deps);
    expect(res).toMatchObject({ fired: true });
    expect((deps.wake as ReturnType<typeof vi.fn>).mock.calls[0][1].payload).toMatchObject({
      carry: 'cold',
      wakeCount: 1,
    });
  });

  it('a WARM loop stamps a NO-carry {wakeCount, harness} marker (P-021: the wake-executor needs the loop identity + carry-note scope for cold-by-default), and its fire counter still advances', async () => {
    const readFireCount = vi.fn(async () => 3);
    const incrementFireCount = vi.fn(async () => {});
    const deps = mkDeps({ readFireCount: readFireCount as never, incrementFireCount: incrementFireCount as never });
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: 'x' } }, deps); // carry absent → warm
    const [, opts] = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0];
    // No carry field: decideColdWake treats it as warm unless the P-021 verdict
    // (classDefaultCold) is resolved by the executor — so with the flag off this
    // marker is inert downstream.
    expect(opts.payload).toEqual({ wakeCount: 4, harness: 'papercusp', routineId: baseInput.routineId });
    expect(readFireCount).toHaveBeenCalledTimes(1);
    expect(incrementFireCount).toHaveBeenCalledTimes(1);
  });

  it('an explicit carry:"warm" is also warm — same NO-carry marker, never a carry field', async () => {
    const deps = mkDeps({
      readFireCount: vi.fn(async () => 5) as never,
      incrementFireCount: vi.fn(async () => {}) as never,
    });
    await fireLoopWake({ ...baseInput, payloadTemplate: { carry: 'warm' } }, deps);
    expect((deps.wake as ReturnType<typeof vi.fn>).mock.calls[0][1].payload).toEqual({
      wakeCount: 6,
      harness: 'papercusp',
      routineId: baseInput.routineId,
    });
  });

  it('a COLD fire that does NOT reach a session does NOT advance the counter (no wakeCount slot consumed)', async () => {
    const incrementFireCount = vi.fn(async () => {});
    const deps = mkDeps({
      wake: vi.fn(async () => ({ targets: ['su-pinned'], keys: [], woken: 0, staged: 0 })) as never,
      readFireCount: vi.fn(async () => 2) as never,
      incrementFireCount: incrementFireCount as never,
    });
    const res = await fireLoopWake({ ...baseInput, payloadTemplate: { carry: 'cold' } }, deps);
    expect(res).toMatchObject({ fired: false, reason: 'no-session-now' });
    expect(incrementFireCount).not.toHaveBeenCalled();
  });
});

// ── compaction-continuity-hardening-2026-07-07 P-001 (wake diet) + P-002 (staleness stamp) ──
//
// Measured: the ~3KB arm-time kickoff was re-delivered verbatim on all 263 wakes of one
// live session (~200k tokens of repeated boilerplate), and the spliced checkpoint claimed
// "fresh at fire time" when only its READ was fresh — a stale note kept instructing an
// already-done next action after compaction (the re-report trap).

const FULL_KICKOFF = ['🔁 Loop wake toward: goal G', '', 'Each wake:', '1. do things', '2. more things'].join('\n');

/**
 * EI-19501119110607678 — the measured staleness verdict has to REACH the reader, and
 * has to sit next to the text it judges. P-017 already established that placement is
 * the whole game here: the same caution filed away from the goal was ignored for
 * ~14 hours across 171 fires.
 */
describe('renderLoopWakeText — the goal-staleness verdict rides both forms', () => {
  const note = '## Next action\ncontinue the edit';
  const STALE = '⚠⚠ THIS GOAL IS STALE — every work-item it names is already TERMINAL: EI-1 (done).';

  it('SHORT form: the verdict lands directly beneath the arm-time goal line', () => {
    const out = renderLoopWakeText({
      kickoff: FULL_KICKOFF,
      fireNumber: 2,
      checkpoint: note,
      goalStalenessNote: STALE,
    });
    expect(out).toContain(STALE);
    // Adjacency is the requirement, not mere presence: a reader must not be able to
    // accept the goal before meeting the verdict on it.
    const goalAt = out.indexOf('Arm-time goal');
    expect(goalAt).toBeGreaterThan(-1);
    expect(out.indexOf(STALE)).toBeGreaterThan(goalAt);
    expect(out.slice(goalAt, out.indexOf(STALE))).not.toContain('\n\n');
  });

  it('FULL form: the verdict follows the kickoff immediately, because there the goal LEADS', () => {
    const out = renderLoopWakeText({
      kickoff: FULL_KICKOFF,
      fireNumber: 1,
      checkpoint: note,
      goalStalenessNote: STALE,
    });
    expect(out).toContain(STALE);
    expect(out.indexOf(STALE)).toBeLessThan(out.indexOf('## Next action'));
  });

  it('renders NOTHING when there is no verdict — a healthy wake is unchanged', () => {
    const withOut = renderLoopWakeText({ kickoff: FULL_KICKOFF, fireNumber: 2, checkpoint: note });
    const withNull = renderLoopWakeText({
      kickoff: FULL_KICKOFF,
      fireNumber: 2,
      checkpoint: note,
      goalStalenessNote: null,
    });
    expect(withNull).toBe(withOut);
    expect(withOut).not.toContain('STALE');
  });
});

/**
 * EI-21459285533379701 — the goal-vs-corrected-fact verdict rides the same slots, for
 * the same placement reason. It is COMPLEMENTARY to the staleness verdict above, not a
 * replacement: that one judges the work-item ids the goal names, this one judges a
 * claim the goal makes that its author has since withdrawn via facts:assert. A
 * retracted claim names no id, so both can be live on the same wake.
 */
describe('renderLoopWakeText — the goal↔fact divergence verdict rides both forms', () => {
  const note = '## Next action\ncontinue the edit';
  const DIVERGED =
    '⚠⚠ THIS GOAL MAY ECHO A CLAIM YOU HAVE SINCE WITHDRAWN — a standing fact covering ' +
    'the same subject was CORRECTED after this loop was armed: guard-rail:poll.';
  const STALE = '⚠⚠ THIS GOAL IS STALE — every work-item it names is already TERMINAL: EI-1 (done).';

  it('SHORT form: the verdict lands directly beneath the arm-time goal line', () => {
    const out = renderLoopWakeText({
      kickoff: FULL_KICKOFF,
      fireNumber: 2,
      checkpoint: note,
      goalFactDivergenceNote: DIVERGED,
    });
    const goalAt = out.indexOf('Arm-time goal');
    expect(goalAt).toBeGreaterThan(-1);
    expect(out.indexOf(DIVERGED)).toBeGreaterThan(goalAt);
    expect(out.slice(goalAt, out.indexOf(DIVERGED))).not.toContain('\n\n');
  });

  it('FULL form: the verdict follows the kickoff immediately, because there the goal LEADS', () => {
    const out = renderLoopWakeText({
      kickoff: FULL_KICKOFF,
      fireNumber: 1,
      checkpoint: note,
      goalFactDivergenceNote: DIVERGED,
    });
    expect(out).toContain(DIVERGED);
    expect(out.indexOf(DIVERGED)).toBeLessThan(out.indexOf('## Next action'));
  });

  it('renders NOTHING when there is no verdict — a healthy wake is byte-identical', () => {
    const withOut = renderLoopWakeText({ kickoff: FULL_KICKOFF, fireNumber: 2, checkpoint: note });
    const withNull = renderLoopWakeText({
      kickoff: FULL_KICKOFF,
      fireNumber: 2,
      checkpoint: note,
      goalFactDivergenceNote: null,
    });
    expect(withNull).toBe(withOut);
    expect(withOut).not.toContain('WITHDRAWN');
  });

  it('both verdicts render together when both fire — neither displaces the other', () => {
    for (const fireNumber of [1, 2]) {
      const out = renderLoopWakeText({
        kickoff: FULL_KICKOFF,
        fireNumber,
        checkpoint: note,
        goalStalenessNote: STALE,
        goalFactDivergenceNote: DIVERGED,
      });
      expect(out, `fire #${fireNumber}`).toContain(STALE);
      expect(out, `fire #${fireNumber}`).toContain(DIVERGED);
    }
  });
});

describe('renderLoopWakeText — the full/short wake cadence (P-001b)', () => {
  const note = '## Next action\ncontinue the edit';

  it('fire 1 gets the FULL kickoff + checkpoint block', () => {
    const out = renderLoopWakeText({ kickoff: FULL_KICKOFF, fireNumber: 1, checkpoint: note });
    expect(out).toContain('Each wake:');
    expect(out).toContain('## Next action');
  });

  it('fires 2..N-1 get the SHORT form: first kickoff line + checkpoint + footer, NOT the full contract', () => {
    for (const fireNumber of [2, 5, LOOP_WAKE_FULL_TEMPLATE_EVERY]) {
      const out = renderLoopWakeText({ kickoff: FULL_KICKOFF, fireNumber, checkpoint: note });
      expect(out).toContain('🔁 Loop wake toward: goal G');
      // P-006 (fleet-member-dx, EI-9018): labeled as the LOOP's own counter so it
      // can't be misread against the event-wake delivery-log id.
      expect(out).toContain(`Loop wake #${fireNumber} — short form`);
      expect(out).not.toContain('Each wake:');
      expect(out).toContain('## Next action');
      expect(out).toContain('refresh loop:checkpoint { did, left, insight, next }; END YOUR TURN');
      // P-017 (fleet-lead-instrumentation-audit-2026-08-09): the contract is POSITIONAL,
      // not lexical — the wake must LEAD with what is always true and must NOT lead with
      // the arm-time goal, which is frozen and routinely names torn-down PIDs/run-ids.
      // Asserting only the wording would let a future edit re-promote the stale text
      // while every assertion still passed; that re-promotion IS the defect P-017 fixed.
      expect(out.startsWith(`Loop wake #${fireNumber} — short form`)).toBe(true);
      expect(out.indexOf('Arm-time goal (frozen at arm time')).toBeGreaterThan(out.indexOf('## Next action'));
      // The goal text itself must still be DELIVERED — demoted, never dropped.
      expect(out).toContain('goal G');
    }
  });

  it(`every ${LOOP_WAKE_FULL_TEMPLATE_EVERY}th wake after the first (11, 21, …) re-delivers the FULL contract as a refresher`, () => {
    for (const fireNumber of [LOOP_WAKE_FULL_TEMPLATE_EVERY + 1, 2 * LOOP_WAKE_FULL_TEMPLATE_EVERY + 1]) {
      const out = renderLoopWakeText({ kickoff: FULL_KICKOFF, fireNumber, checkpoint: note });
      expect(out).toContain('Each wake:');
    }
  });

  it('NO checkpoint ⇒ the full kickoff regardless of fire number + the first-carry-note mandate (WI-5092)', () => {
    const out = renderLoopWakeText({ kickoff: FULL_KICKOFF, fireNumber: 5, checkpoint: null });
    expect(out).toContain(FULL_KICKOFF);
    // WI-5092 su-behavior audit: a loop with NO carry-note ever written is the audited
    // continuity gap — the wake names the empty-note condition concretely.
    expect(out).toContain('NO loop:checkpoint carry-note exists for this loop yet');
    // With a note present the mandate must NOT render — it is the empty-note conditional
    // made concrete, never boilerplate on every wake.
    expect(renderLoopWakeText({ kickoff: FULL_KICKOFF, fireNumber: 1, checkpoint: note })).not.toContain(
      'NO loop:checkpoint carry-note',
    );
  });

  it('a warm fireLoopWake threads the fire number: prior fires 4 ⇒ wake #5 short form', async () => {
    const deps = mkDeps({
      readFireCount: vi.fn(async () => 4) as never,
      getLoopCarryNoteWithMeta: vi.fn(async () => ({ note, updatedAtMs: Date.now() - 30_000 })) as never,
    });
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: FULL_KICKOFF } }, deps);
    const [, opts] = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.summary).toContain('Loop wake #5 — short form');
    expect(opts.summary).not.toContain('Each wake:');
  });
});

describe('the short-form recipe splice (P-005c — the moment-of-need reuse pointer)', () => {
  const note = '## Next action\nbatch-triage the open observations';

  it('renderLoopWakeText splices a recipeLine into the SHORT form only, above the footer', () => {
    const short = renderLoopWakeText({
      kickoff: FULL_KICKOFF,
      fireNumber: 5,
      checkpoint: note,
      recipeLine: "Recipe on point (cosine 0.72): recipes:run { id: 'r1' } — \"Batch triage\" (run 3×).",
    });
    expect(short).toContain("recipes:run { id: 'r1' }");
    expect(short.indexOf('## Next action')).toBeLessThan(short.indexOf("recipes:run { id: 'r1' }"));
    expect(short.indexOf("recipes:run { id: 'r1' }")).toBeLessThan(short.indexOf('END YOUR TURN'));

    // The FULL form (fire 1 / refresher) never carries it — the kickoff is the brief there.
    const full = renderLoopWakeText({
      kickoff: FULL_KICKOFF,
      fireNumber: 1,
      checkpoint: note,
      recipeLine: 'should not appear',
    });
    expect(full).not.toContain('should not appear');
  });

  it('a SHORT-form fire queries the recipe seam with the checkpoint next-action and splices the hit', async () => {
    const findWakeRecipe = vi.fn(async () => ({ id: 'r-triage', title: 'Batch triage', runCount: 3, sim: 0.72 }));
    const deps = mkDeps({
      readFireCount: vi.fn(async () => 4) as never, // wake #5 → short form
      getLoopCarryNoteWithMeta: vi.fn(async () => ({ note, updatedAtMs: Date.now() - 30_000 })) as never,
      findWakeRecipe: findWakeRecipe as never,
    });
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: FULL_KICKOFF } }, deps);

    expect(findWakeRecipe).toHaveBeenCalledWith('batch-triage the open observations', { sql: undefined });
    const [, opts] = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.summary).toContain("recipes:run { id: 'r-triage' }");
    expect(opts.summary).toContain('run 3×');
  });

  it('a FULL-form fire (fire 1 / no checkpoint) never runs the lookup', async () => {
    const findWakeRecipe = vi.fn(async () => null);
    // Fire 1 with a checkpoint.
    const deps1 = mkDeps({
      getLoopCarryNoteWithMeta: vi.fn(async () => ({ note, updatedAtMs: Date.now() })) as never,
      findWakeRecipe: findWakeRecipe as never,
    });
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: FULL_KICKOFF } }, deps1);
    // Wake #8 but NO checkpoint.
    const deps2 = mkDeps({
      readFireCount: vi.fn(async () => 7) as never,
      findWakeRecipe: findWakeRecipe as never,
    });
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: FULL_KICKOFF } }, deps2);
    expect(findWakeRecipe).not.toHaveBeenCalled();
  });

  it('a throwing / empty lookup degrades to the plain short form (fail-soft)', async () => {
    const deps = mkDeps({
      readFireCount: vi.fn(async () => 4) as never,
      getLoopCarryNoteWithMeta: vi.fn(async () => ({ note, updatedAtMs: Date.now() - 30_000 })) as never,
      findWakeRecipe: vi.fn(async () => {
        throw new Error('embedder down');
      }) as never,
    });
    const res = await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: FULL_KICKOFF } }, deps);
    expect(res).toMatchObject({ fired: true });
    const [, opts] = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.summary).toContain('Loop wake #5 — short form');
    expect(opts.summary).not.toContain('recipes:run {');
  });
});

describe('renderLoopCheckpointBlock — the write-age staleness stamp (P-002)', () => {
  const note = '## Next action\nre-report the fix to the owner';

  it('a FRESH note is stamped with its write age and asserted as the wake authority', () => {
    const out = renderLoopCheckpointBlock(note, { updatedAtMs: Date.now() - 90_000, intervalSec: 120 });
    expect(out).toContain('you wrote it');
    expect(out).toContain('this is the authority for what to do this wake');
    expect(out).not.toContain('STALE');
  });

  it('a STALE note (older than max(3 intervals, 30min)) is demoted to a LEAD with a do-not-re-execute warning', () => {
    const out = renderLoopCheckpointBlock(note, { updatedAtMs: Date.now() - 45 * 60_000, intervalSec: 120 });
    expect(out).toContain('⚠ Your loop:checkpoint is STALE');
    expect(out).toContain('Treat it as a LEAD');
    expect(out).toContain('do NOT re-execute its "next action" verbatim');
    expect(out).toContain('Refresh it with loop:checkpoint');
  });

  it('the staleness ceiling scales with the loop interval: max(3×interval, 30min)', () => {
    expect(loopCheckpointStaleMs(120)).toBe(30 * 60_000); // 3×120s < 30min floor
    expect(loopCheckpointStaleMs(3600)).toBe(3 * 3600 * 1000); // 3h for an hourly loop
    expect(loopCheckpointStaleMs(null)).toBe(30 * 60_000); // no interval ⇒ the floor
    // The same 45min-old note is NOT stale under an hourly loop's 3h ceiling.
    const out = renderLoopCheckpointBlock(note, { updatedAtMs: Date.now() - 45 * 60_000, intervalSec: 3600 });
    expect(out).not.toContain('STALE');
  });

  it('no write instant available ⇒ no age claim, no false "fresh at fire time" assertion of content freshness', () => {
    const out = renderLoopCheckpointBlock(note, {});
    expect(out).toContain('you wrote it earlier');
    expect(out).not.toContain('STALE');
  });

  it('EI-13592: stamps an ABSOLUTE write-time (independent of relative "X ago") so a reader can detect a fire→delivery gap the relative age cannot reveal on its own', () => {
    const writtenAtMs = Date.parse('2026-07-17T04:52:00Z');
    const fresh = renderLoopCheckpointBlock(note, { updatedAtMs: writtenAtMs, nowMs: writtenAtMs + 5_000, intervalSec: 120 });
    expect(fresh).toContain('[07-17T04:52:00Z]');
    const stale = renderLoopCheckpointBlock(note, {
      updatedAtMs: writtenAtMs,
      nowMs: writtenAtMs + 45 * 60_000,
      intervalSec: 120,
    });
    expect(stale).toContain('[07-17T04:52:00Z]');
  });
});

describe('decideLoopAwaitSuppression — the pure suppression decision (EI-10901)', () => {
  const now = Date.parse('2026-07-18T12:00:00.000Z');

  it('uses lifecycle provenance rather than guessing from a work-item event name', () => {
    const awaitRow = { eventKey: 'work-item:done:WI-dependency', createdAt: new Date(now).toISOString(),
      expiresTs: new Date(now + 60_000).toISOString() };
    const automatic = { ...awaitRow, boundTo: { kind: 'work-item-blocked', ref: 'WI-aggregate' } };
    expect(decideLoopAwaitSuppression({ awaits: [automatic], nowMs: now }).suppress).toBe(false);
    expect(decideLoopAwaitSuppression({ awaits: [awaitRow], nowMs: now }).suppress).toBe(true);
    expect(decideLoopAwaitSuppression({ awaits: [automatic, awaitRow], nowMs: now }).suppress).toBe(true);
    expect(decideLoopAwaitSuppression({ awaits: [{ ...awaitRow, boundTo: { kind: 'consultation', ref: 'c' } }], nowMs: now }).suppress).toBe(true);
  });

  it('no awaits ⇒ never suppress', () => {
    expect(decideLoopAwaitSuppression({ awaits: [], nowMs: now })).toEqual({ suppress: false, resumeAtMs: null });
  });

  it('a standing once:false watch does not suppress loop recurrence', () => {
    const standing = {
      eventKey: 'work-item:claimable',
      expiresTs: null,
      createdAt: new Date(now).toISOString(),
      once: false,
    };
    expect(decideLoopAwaitSuppression({ awaits: [standing], nowMs: now })).toEqual({
      suppress: false,
      resumeAtMs: null,
    });
    expect(decideLoopAwaitSuppression({
      awaits: [{ ...standing, once: true }],
      nowMs: now,
    })).toMatchObject({ suppress: true, drivingEventKey: 'work-item:claimable' });
  });

  it('WI-10004466: an agent-obligation reminder binding never parks the loop', () => {
    const reminder = {
      eventKey: 'plan:acceptance:p', createdAt: new Date(now).toISOString(), expiresTs: null,
      boundTo: { kind: 'agent-obligation', ref: 'obl:x' },
    };
    expect(decideLoopAwaitSuppression({ awaits: [reminder], nowMs: now }).suppress).toBe(false);
  });

  it('WI-10004466: the non-parking kind set tracks the obligation-reminder binding constant', () => {
    expect(LOOP_NON_PARKING_AWAIT_BINDING_KINDS.has(AGENT_OBLIGATION_REMINDER_BINDING_KIND)).toBe(true);
    expect(LOOP_NON_PARKING_AWAIT_BINDING_KINDS.has('work-item-blocked')).toBe(true);
  });

  it('WI-10005778: holding an active goal lease lifts suppression and says why', () => {
    const question = {
      eventKey: 'conversation:answered:conv-q', createdAt: new Date(now).toISOString(),
      expiresTs: new Date(now + 2 * 60 * 60_000).toISOString(),
      boundTo: { kind: 'conversation-question', ref: 'conv-q' },
    };
    expect(decideLoopAwaitSuppression({
      awaits: [question], nowMs: now, actionableHeldItemCount: 0, ownerStewardsActiveGoal: true,
    })).toEqual({
      suppress: false,
      resumeAtMs: null,
      drivingEventKey: 'conversation:answered:conv-q',
      overriddenByGoalStewardship: true,
    });
  });

  it('WI-10005778: unknown or false goal stewardship keeps the owner-answer park', () => {
    const question = {
      eventKey: 'conversation:answered:conv-q', createdAt: new Date(now).toISOString(),
      expiresTs: new Date(now + 2 * 60 * 60_000).toISOString(),
      boundTo: { kind: 'conversation-question', ref: 'conv-q' },
    };
    for (const ownerStewardsActiveGoal of [false, null, undefined]) {
      expect(decideLoopAwaitSuppression({ awaits: [question], nowMs: now, ownerStewardsActiveGoal }).suppress).toBe(true);
    }
  });

  it('WI-10004466: more actionable held items than the bound lifts suppression and says why', () => {
    const awaitRow = {
      eventKey: 'plan-item:done:x:P-008', createdAt: new Date(now).toISOString(),
      expiresTs: new Date(now + 60 * 60_000).toISOString(),
    };
    const over = LOOP_AWAIT_SUPPRESSION_MAX_ACTIONABLE_HELD + 1;
    expect(decideLoopAwaitSuppression({ awaits: [awaitRow], nowMs: now, actionableHeldItemCount: over })).toEqual({
      suppress: false,
      resumeAtMs: null,
      drivingEventKey: 'plan-item:done:x:P-008',
      overriddenByActionableHeldItems: over,
    });
    for (const n of [0, LOOP_AWAIT_SUPPRESSION_MAX_ACTIONABLE_HELD, null, undefined]) {
      expect(decideLoopAwaitSuppression({ awaits: [awaitRow], nowMs: now, actionableHeldItemCount: n }).suppress).toBe(true);
    }
  });

  it('a fresh await with a future deadline ⇒ suppress until that deadline', () => {
    const deadline = now + 5 * 60_000;
    const out = decideLoopAwaitSuppression({
      awaits: [{ eventKey: 'gate:x', expiresTs: new Date(deadline).toISOString(), createdAt: new Date(now).toISOString() }],
      nowMs: now,
    });
    expect(out).toEqual({ suppress: true, resumeAtMs: deadline, drivingEventKey: 'gate:x' });
  });

  it('an await already past its deadline ⇒ not suppressed', () => {
    const out = decideLoopAwaitSuppression({
      awaits: [{ eventKey: 'gate:x', expiresTs: new Date(now - 1_000).toISOString(), createdAt: new Date(now - 60_000).toISOString() }],
      nowMs: now,
    });
    expect(out.suppress).toBe(false);
  });

  it('a deadline-less await is bounded by max-quiet from ITS OWN creation, not the deadline', () => {
    const createdAt = now - 10 * 60_000;
    const out = decideLoopAwaitSuppression({
      awaits: [{ eventKey: 'gate:x', expiresTs: null, createdAt: new Date(createdAt).toISOString() }],
      nowMs: now,
      maxQuietMs: 30 * 60_000,
    });
    expect(out).toEqual({ suppress: true, resumeAtMs: createdAt + 30 * 60_000, drivingEventKey: 'gate:x' });
  });

  it('a deadline-less await older than max-quiet ⇒ not suppressed (the fallback bound)', () => {
    const out = decideLoopAwaitSuppression({
      awaits: [{ eventKey: 'gate:x', expiresTs: null, createdAt: new Date(now - 31 * 60_000).toISOString() }],
      nowMs: now,
      maxQuietMs: 30 * 60_000,
    });
    expect(out.suppress).toBe(false);
  });

  it('a deadline BEYOND max-quiet is still capped by max-quiet — "must not silence past its fallback"', () => {
    const createdAt = now;
    const farDeadline = now + 60 * 60_000; // 1h out
    const out = decideLoopAwaitSuppression({
      awaits: [{ eventKey: 'gate:x', expiresTs: new Date(farDeadline).toISOString(), createdAt: new Date(createdAt).toISOString() }],
      nowMs: now,
      maxQuietMs: 30 * 60_000,
    });
    expect(out.resumeAtMs).toBe(createdAt + 30 * 60_000); // NOT the 1h-out deadline
  });

  it('multiple awaits ⇒ suppressed while ANY is still fresh; resumeAtMs is the EARLIEST threshold', () => {
    const out = decideLoopAwaitSuppression({
      awaits: [
        { eventKey: 'gate:soon', expiresTs: new Date(now + 60_000).toISOString(), createdAt: new Date(now).toISOString() },
        { eventKey: 'gate:later', expiresTs: new Date(now + 10 * 60_000).toISOString(), createdAt: new Date(now).toISOString() },
      ],
      nowMs: now,
    });
    expect(out).toEqual({ suppress: true, resumeAtMs: now + 60_000, drivingEventKey: 'gate:soon' });
  });

  it('a malformed createdAt is skipped rather than throwing or wrongly suppressing', () => {
    const out = decideLoopAwaitSuppression({
      awaits: [{ eventKey: 'gate:bad', expiresTs: null, createdAt: 'not-a-date' }],
      nowMs: now,
    });
    expect(out.suppress).toBe(false);
  });
});

describe('RSR-P-024-A — no loop fire while parked on an await, beyond a slow heartbeat', () => {
  const MIN = 60_000;

  /** Replays a loop's scheduler against the pure decision: a suppressed tick re-arms at
   *  `resumeAtMs` (rescheduleLoopAfterAwaitSuppression); a delivered tick stamps
   *  last-delivered, runs a turn, then re-arms `intervalSec` after it settles. */
  function replay(opts: {
    awaitCreatedAtMs: number;
    firstTickMs: number;
    untilMs: number;
    intervalSec: number;
    turnMs: number;
    useHeartbeat: boolean;
  }): number[] {
    const awaits = [{
      eventKey: 'conversation:answered:conv-owner-question',
      expiresTs: null,
      createdAt: new Date(opts.awaitCreatedAtMs).toISOString(),
      boundTo: { kind: 'conversation-question', ref: 'conv-owner-question' },
    }];
    const delivered: number[] = [];
    let lastDeliveredAtMs: number | null = null;
    let t = opts.firstTickMs;
    for (let guard = 0; guard < 1000 && t <= opts.untilMs; guard++) {
      const d = decideLoopAwaitSuppression({
        awaits,
        nowMs: t,
        lastDeliveredAtMs: opts.useHeartbeat ? lastDeliveredAtMs : null,
      });
      if (d.suppress && d.resumeAtMs != null) {
        t = d.resumeAtMs;
        continue;
      }
      delivered.push(t);
      lastDeliveredAtMs = t;
      t = t + opts.turnMs + opts.intervalSec * 1000;
    }
    return delivered;
  }

  // Measured 2026-09-23 (routine_loop_transitions + event_awaits, su-77b3a99d): the owner-
  // answer await was created 01:46:13Z with no deadline and stayed open until 09:12Z; the
  // 900s loop was quiet until 02:16Z and then took 8 turns by 04:22:20Z.
  const created = Date.parse('2026-09-23T01:46:13.000Z');
  const incident = {
    awaitCreatedAtMs: created,
    firstTickMs: Date.parse('2026-09-23T01:46:33.000Z'),
    untilMs: Date.parse('2026-09-23T04:22:20.000Z'),
    intervalSec: 900,
    turnMs: 150_000,
  };

  it('calibration: the pre-heartbeat ceiling reproduces the measured 8 turns', () => {
    expect(replay({ ...incident, useHeartbeat: false }).length).toBeGreaterThanOrEqual(7);
  });

  it('the same timeline with the heartbeat takes one liveness turn per heartbeat period', () => {
    const fires = replay({ ...incident, useHeartbeat: true });
    expect(fires.length).toBeLessThanOrEqual(3);
    expect(fires[0]).toBe(created + LOOP_AWAIT_SUPPRESSION_MAX_QUIET_MS);
    for (let i = 1; i < fires.length; i++) {
      expect(fires[i]! - fires[i - 1]!).toBeGreaterThanOrEqual(LOOP_AWAIT_HEARTBEAT_MS);
    }
  });

  it('a 60s loop parked on an owner answer takes no turn inside the quiet window', () => {
    const fires = replay({
      awaitCreatedAtMs: created,
      firstTickMs: created + 30_000,
      untilMs: created + 29 * MIN,
      intervalSec: 60,
      turnMs: 30_000,
      useHeartbeat: true,
    });
    expect(fires).toEqual([]);
  });

  it('a delivery DURING the await stretches the ceiling to lastDelivered + heartbeat', () => {
    const lastDeliveredAtMs = created + 30 * MIN;
    const out = decideLoopAwaitSuppression({
      awaits: [{ eventKey: 'gate:x', expiresTs: null, createdAt: new Date(created).toISOString() }],
      nowMs: created + 31 * MIN,
      lastDeliveredAtMs,
      heartbeatMs: 60 * MIN,
    });
    expect(out).toEqual({ suppress: true, resumeAtMs: lastDeliveredAtMs + 60 * MIN, drivingEventKey: 'gate:x' });
  });

  it('a delivery from BEFORE the await was created keeps the pre-heartbeat ceiling', () => {
    const out = decideLoopAwaitSuppression({
      awaits: [{ eventKey: 'gate:x', expiresTs: null, createdAt: new Date(created).toISOString() }],
      nowMs: created + 31 * MIN,
      lastDeliveredAtMs: created - MIN,
    });
    expect(out.suppress).toBe(false);
  });

  it("the await's own deadline still caps the heartbeat (the fallback wake is never silenced)", () => {
    const deadline = created + 45 * MIN;
    const out = decideLoopAwaitSuppression({
      awaits: [{ eventKey: 'gate:x', expiresTs: new Date(deadline).toISOString(), createdAt: new Date(created).toISOString() }],
      nowMs: created + 31 * MIN,
      lastDeliveredAtMs: created + 30 * MIN,
    });
    expect(out.resumeAtMs).toBe(deadline);
  });

  it('fireLoopWake withholds a post-quiet tick once a heartbeat was delivered during the await', async () => {
    const nowMs = Date.now();
    const awaitRow = {
      eventKey: 'conversation:answered:conv-q',
      expiresTs: null,
      createdAt: new Date(nowMs - 31 * MIN).toISOString(),
    };
    const withHeartbeat = mkDeps({
      listBlockingAwaits: vi.fn(async () => [awaitRow]) as never,
      readLastDeliveredAt: vi.fn(async () => nowMs - MIN) as never,
    });
    const r = await fireLoopWake(baseInput, withHeartbeat);
    expect(r).toMatchObject({ fired: false, reason: 'await-blocking' });
    expect(withHeartbeat.wake).not.toHaveBeenCalled();
    expect(withHeartbeat.readLastDeliveredAt).toHaveBeenCalledWith(undefined, baseInput.routineId);

    // A failed/unknown delivery read fails OPEN to the pre-heartbeat ceiling: the wake goes out.
    const unknown = mkDeps({
      listBlockingAwaits: vi.fn(async () => [awaitRow]) as never,
      readLastDeliveredAt: vi.fn(async () => { throw new Error('pg down'); }) as never,
    });
    expect(await fireLoopWake(baseInput, unknown)).toMatchObject({ fired: true });
  });

  it('no blocking await ⇒ the delivery read is never paid', async () => {
    const deps = mkDeps();
    await fireLoopWake(baseInput, deps);
    expect(deps.readLastDeliveredAt).not.toHaveBeenCalled();
  });
});

describe('walls + turn-settle nag in the wake text (compaction-continuity-hardening P-006)', () => {
  const FULL_KICKOFF = ['🔁 Work the plan toward the goal.', 'line 2 of the contract.'].join('\n');
  const NOTE_WITH_WALLS = [
    '## Next action',
    'ship P-006',
    '',
    '## Walls',
    '- [origin:owner] 3 zombie PIDs await owner OK to kill — re-check: ps -p 95902 (since 2026-07-07T12:00:00.000Z)',
  ].join('\n');

  it('renderLoopWakeText renders the walls block in BOTH forms, outside the truncatable note', () => {
    const walls = [{
      claim: 'zombie PIDs await owner OK',
      origin: 'owner' as const,
      recheck: 'ps -p 95902',
      sinceMs: Date.now() - 3_600_000,
    }];
    const short = renderLoopWakeText({ kickoff: FULL_KICKOFF, fireNumber: 5, checkpoint: '## Next action\ngo', walls });
    expect(short).toContain('⛔ OPEN WALLS');
    expect(short).toContain('  • [origin:owner] zombie PIDs await owner OK — re-check: ps -p 95902 (standing 60m)');
    const full = renderLoopWakeText({ kickoff: FULL_KICKOFF, fireNumber: 1, checkpoint: '## Next action\ngo', walls });
    expect(full).toContain('⛔ OPEN WALLS');
    expect(full).toContain('line 2 of the contract.'); // still the full kickoff
    // No walls ⇒ no block.
    expect(renderLoopWakeText({ kickoff: FULL_KICKOFF, fireNumber: 1, checkpoint: null })).not.toContain('OPEN WALLS');
  });

  it('legacy and self-imposed walls require revalidation instead of becoming unconditional blockers', () => {
    const legacy = renderLoopWallsBlock([{ claim: 'Do not rerun the gate' }])!;
    expect(legacy).toContain('⚠ REVALIDATE CARRIED WALLS');
    expect(legacy).not.toContain('⛔ OPEN WALLS');
    const conditional = renderLoopWallsBlock([{
      claim: 'Do not mutate the repair queue',
      origin: 'self',
      appliesWhile: 'gate run rr-123 is active',
      recheck: 'release:repair-queue status rr-123',
    }])!;
    expect(conditional).toContain('gate run rr-123 is active');
    expect(conditional).toContain('release:repair-queue status rr-123');
    expect(conditional).not.toContain('⛔ OPEN WALLS');
    expect(renderLoopWallsBlock([{ claim: 'Owner approval pending', origin: 'owner' }])).toContain('⛔ OPEN WALLS');
  });

  it('renderLoopWakeText splices the nag line in BOTH forms, ahead of the checkpoint block', () => {
    const nag = '⚠ TURN-SETTLE NAG: your previous turn ended with an owner-ask';
    const short = renderLoopWakeText({
      kickoff: FULL_KICKOFF,
      fireNumber: 5,
      checkpoint: '## Next action\ngo',
      wallNagLine: nag,
    });
    expect(short).toContain(nag);
    expect(short.indexOf(nag)).toBeLessThan(short.indexOf('Current loop:checkpoint'));
    const full = renderLoopWakeText({ kickoff: FULL_KICKOFF, fireNumber: 1, checkpoint: null, wallNagLine: nag });
    expect(full).toContain(nag);
  });

  it('fireLoopWake parses walls OUT of the note: the wake carries the block, and the checkpoint body loses the section', async () => {
    const deps = mkDeps({
      readFireCount: vi.fn(async () => 4) as never,
      getLoopCarryNoteWithMeta: vi.fn(async () => ({ note: NOTE_WITH_WALLS, updatedAtMs: Date.now() - 30_000 })) as never,
    });
    const res = await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: FULL_KICKOFF } }, deps);
    expect(res).toMatchObject({ fired: true });
    const [, opts] = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.summary).toContain('⛔ OPEN WALLS');
    expect(opts.summary).toContain('  • [origin:owner] 3 zombie PIDs await owner OK to kill — re-check: ps -p 95902');
    expect(opts.summary).not.toContain('## Walls'); // the section never rides the truncatable body
    expect(opts.summary).toContain('ship P-006'); // the narrative body still renders
  });

  it('fireLoopWake takes the pending nag (read-and-clear) and splices the hard mandate', async () => {
    const takeWallNag = vi.fn(async () => ({ atMs: 1, excerpt: 'awaiting owner OK on the teardown' }));
    const deps = mkDeps({
      readFireCount: vi.fn(async () => 4) as never,
      getLoopCarryNoteWithMeta: vi.fn(async () => ({ note: '## Next action\ngo', updatedAtMs: Date.now() })) as never,
      takeWallNag: takeWallNag as never,
    });
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: FULL_KICKOFF } }, deps);
    expect(takeWallNag).toHaveBeenCalledWith({ harness: 'papercusp', ownerId: 'su-pinned' });
    const [, opts] = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.summary).toContain('TURN-SETTLE NAG');
    expect(opts.summary).toContain('"awaiting owner OK on the teardown"');
  });

  it('a throwing nag-take degrades to a plain wake (fail-soft)', async () => {
    const deps = mkDeps({
      readFireCount: vi.fn(async () => 4) as never,
      getLoopCarryNoteWithMeta: vi.fn(async () => ({ note: '## Next action\ngo', updatedAtMs: Date.now() })) as never,
      takeWallNag: vi.fn(async () => {
        throw new Error('pg down');
      }) as never,
    });
    const res = await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: FULL_KICKOFF } }, deps);
    expect(res).toMatchObject({ fired: true });
    const [, opts] = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.summary).not.toContain('TURN-SETTLE NAG');
  });

  it('a walls-ONLY note counts as no checkpoint (full form) but still renders the walls block', async () => {
    const deps = mkDeps({
      readFireCount: vi.fn(async () => 4) as never,
      getLoopCarryNoteWithMeta: vi.fn(async () => ({
        note: '## Walls\n- [origin:owner] zombie PIDs await owner OK',
        updatedAtMs: Date.now(),
      })) as never,
    });
    await fireLoopWake({ ...baseInput, payloadTemplate: { kickoff: FULL_KICKOFF } }, deps);
    const [, opts] = (deps.wake as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.summary).toContain('line 2 of the contract.'); // full form — no narrative checkpoint to shorten on
    expect(opts.summary).toContain('⛔ OPEN WALLS');
    expect(opts.summary).toContain('  • [origin:owner] zombie PIDs await owner OK');
  });
});

// ── P-008 context-burn ratchet: the wake template's scaffold stays under its byte budget ──
//
// Scaffold = rendered bytes MINUS caller content bytes, measured on minimal 1-byte
// fixtures — pure template overhead, re-injected on EVERY wake of every loop. Reds
// when a template edit grows the boilerplate past LOOP_WAKE_SCAFFOLD_BYTE_BUDGETS
// (the P-011 tool prompt-weight pattern). Fix by trimming the template; raise a
// budget only as a deliberate trade-off.
describe('P-008: wake-template scaffold byte budgets', () => {
  const NOW = 1_800_000_000_000;
  const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

  it('short form (fresh checkpoint header) fits the shortForm budget', () => {
    const rendered = renderLoopWakeText({
      kickoff: 'K',
      fireNumber: 2,
      checkpoint: 'C',
      checkpointUpdatedAtMs: NOW - 5_000,
      intervalSec: 120,
      nowMs: NOW,
    });
    expect(bytes(rendered) - 2).toBeLessThanOrEqual(LOOP_WAKE_SCAFFOLD_BYTE_BUDGETS.shortForm);
  });

  it('short form with a STALE checkpoint header (the biggest scaffold) fits the shortForm budget', () => {
    const rendered = renderLoopWakeText({
      kickoff: 'K',
      fireNumber: 2,
      checkpoint: 'C',
      checkpointUpdatedAtMs: NOW - 3 * 3_600_000,
      intervalSec: 120,
      nowMs: NOW,
    });
    expect(bytes(rendered) - 2).toBeLessThanOrEqual(LOOP_WAKE_SCAFFOLD_BYTE_BUDGETS.shortForm);
  });

  it('full form adds only the checkpoint block header beyond the kickoff', () => {
    const rendered = renderLoopWakeText({
      kickoff: 'K',
      fireNumber: 1,
      checkpoint: 'C',
      checkpointUpdatedAtMs: NOW - 5_000,
      intervalSec: 120,
      nowMs: NOW,
    });
    expect(bytes(rendered) - 2).toBeLessThanOrEqual(LOOP_WAKE_SCAFFOLD_BYTE_BUDGETS.fullForm);
  });

  it('walls block header + per-row overhead fit their budgets', () => {
    const one = renderLoopWallsBlock([{ claim: 'W', recheck: 'R', sinceMs: NOW - 60_000 }], NOW)!;
    const two = renderLoopWallsBlock(
      [
        { claim: 'W', recheck: 'R', sinceMs: NOW - 60_000 },
        { claim: 'W', recheck: 'R', sinceMs: NOW - 60_000 },
      ],
      NOW,
    )!;
    const perRow = bytes(two) - bytes(one);
    expect(perRow).toBeLessThanOrEqual(LOOP_WAKE_SCAFFOLD_BYTE_BUDGETS.wallsPerRow);
    expect(bytes(one) - perRow).toBeLessThanOrEqual(LOOP_WAKE_SCAFFOLD_BYTE_BUDGETS.wallsHeader);
  });

  it('an over-cap checkpoint truncates: total short form stays bounded', () => {
    const huge = 'x'.repeat(LOOP_WAKE_CHECKPOINT_MAX_CHARS + 5_000);
    const rendered = renderLoopWakeText({
      kickoff: 'K',
      fireNumber: 2,
      checkpoint: huge,
      checkpointUpdatedAtMs: NOW - 5_000,
      intervalSec: 120,
      nowMs: NOW,
    });
    // scaffold + the capped note + the truncation marker — never the full note.
    expect(bytes(rendered)).toBeLessThanOrEqual(
      LOOP_WAKE_SCAFFOLD_BYTE_BUDGETS.shortForm + LOOP_WAKE_CHECKPOINT_MAX_CHARS + 60,
    );
  });
});

describe('defaultOwnerStewardsActiveGoal — only the ELECTED holder of an active goal is exempt (WI-10005778)', () => {
  const OWNER = 'su-holder';
  const PREDECESSOR = 'su-predecessor';
  const row = (ownerId: string, goalId = 'goal-1') => ({ goalId, workspaceId: 'ws', ownerId, setAtMs: 1 });
  const mk = (over: Partial<OwnerStewardshipDeps>): OwnerStewardshipDeps => ({
    readRows: vi.fn(async () => [row(OWNER), row(PREDECESSOR)]),
    readActiveGoals: vi.fn<OwnerStewardshipDeps['readActiveGoals']>(async (_sql, ids) =>
      ids.map((goalId) => ({ goalId, workspaceId: 'ws' })),
    ),
    resolveBatch: vi.fn<OwnerStewardshipDeps['resolveBatch']>(async (_sql, goals) =>
      new Map(goals.map((g) => [g.goalId, { elected: { ...row(OWNER, g.goalId) } as never }] as const)),
    ),
    ...over,
  });

  it('is true for the elected lease holder of an active goal, resolved from the same row read', async () => {
    const deps = mk({});
    expect(await defaultOwnerStewardsActiveGoal({ ownerId: OWNER, sql: {} as never }, deps)).toBe(true);
    const [, , opts] = (deps.resolveBatch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.rows).toHaveLength(2);
  });

  it('is false for a predecessor whose goal-mode row outlived the election', async () => {
    expect(await defaultOwnerStewardsActiveGoal({ ownerId: PREDECESSOR, sql: {} as never }, mk({}))).toBe(false);
  });

  it('is false when the only goal the owner has a row for is not active', async () => {
    const deps = mk({ readActiveGoals: vi.fn(async () => []) });
    expect(await defaultOwnerStewardsActiveGoal({ ownerId: OWNER, sql: {} as never }, deps)).toBe(false);
    expect(deps.resolveBatch).not.toHaveBeenCalled();
  });

  it('is false without reading goals when the owner has no goal-mode row', async () => {
    const deps = mk({});
    expect(await defaultOwnerStewardsActiveGoal({ ownerId: 'su-stranger', sql: {} as never }, deps)).toBe(false);
    expect(deps.readActiveGoals).not.toHaveBeenCalled();
  });
});
