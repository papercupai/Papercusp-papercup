/** P-015 (deterministic-context-carry) — turn-end sweeps: stale-held-WI
 *  auto-checkpoint composition/merge + unregistered-artifact detection. */
import { describe, expect, it } from 'vitest';
import {
  isUnpublishedReportTurn,
  MECHANICAL_CHECKPOINT_MARKER,
  STALE_CHECKPOINT_MS,
  UNGUARDED_HALT_NOTE,
  MAX_OPEN_TASK_REMINDER_ATTEMPTS,
  composeMechanicalCheckpoint,
  detectUnguardedHalt,
  decideOpenTaskReminder,
  detectEphemeralDeliverableReferences,
  extractFileWritePaths,
  extractShellWriteTargets,
  detectUnregisteredArtifacts,
  isDeliverableWrite,
  awaitGuaranteesRewake,
  isRewakeGuaranteed,
  isStaleHeldCheckpoint,
  mergeMechanicalCheckpoint,
  openTaskReminderSignature,
  renderEphemeralDeliverableWarning,
  settledMessagesCursor,
  unregisteredArtifactTripwire,
} from './turn-end-tracking';

describe('Reports unpublished-turn signal', () => {
  const report = '# Architecture audit\n\n## Findings\n' + 'Measured architecture evidence. '.repeat(16)
    + '\n## Recommendations\nPreserve these conclusions in the library.';
  it('signals a report-shaped fixture only before publication', () => {
    expect(isUnpublishedReportTurn(report, false)).toBe(true);
    expect(isUnpublishedReportTurn(report, true)).toBe(false);
  });
  it('ignores progress notes, quoted reports and report examples inside code', () => {
    expect(isUnpublishedReportTurn('The audit tests passed; capture verification remains open.', false)).toBe(false);
    expect(isUnpublishedReportTurn(report.split('\n').map(line => `> ${line}`).join('\n'), false)).toBe(false);
    expect(isUnpublishedReportTurn('```markdown\n' + report + '\n```', false)).toBe(false);
  });
});

const NOW = 1_784_000_000_000;

describe('isStaleHeldCheckpoint', () => {
  it('missing/blank checkpoint is stale', () => {
    expect(isStaleHeldCheckpoint({ checkpoint: null }, NOW)).toBe(true);
    expect(isStaleHeldCheckpoint({ checkpoint: '   ' }, NOW)).toBe(true);
  });

  it('old checkpoint is stale; fresh is not', () => {
    const old = { checkpoint: 'x', checkpointUpdatedAtMs: NOW - STALE_CHECKPOINT_MS - 1 };
    const fresh = { checkpoint: 'x', checkpointUpdatedAtMs: NOW - 60_000 };
    expect(isStaleHeldCheckpoint(old, NOW)).toBe(true);
    expect(isStaleHeldCheckpoint(fresh, NOW)).toBe(false);
  });

  it('an EXISTING checkpoint with unknown write time is NOT stale (cannot prove the gap)', () => {
    expect(isStaleHeldCheckpoint({ checkpoint: 'x', checkpointUpdatedAtMs: null }, NOW)).toBe(false);
    expect(isStaleHeldCheckpoint({ checkpoint: 'x' }, NOW)).toBe(false);
  });
});

describe('composeMechanicalCheckpoint / mergeMechanicalCheckpoint', () => {
  const block = composeMechanicalCheckpoint({
    atIso: '2026-07-14T18:30:00.000Z',
    journalNote: 'P-015 legs 1-2 landed; tests next.',
    toolLog: 'Edit assert.ts ✓\nBash vitest run ✓',
    sessionId: 'bf1881bc-9fd9',
  });

  it('block opens with the mechanical marker and carries note + log + session', () => {
    expect(block.startsWith(MECHANICAL_CHECKPOINT_MARKER)).toBe(true);
    expect(block).toContain('latest journal: P-015 legs 1-2 landed');
    expect(block).toContain('Bash vitest run ✓');
    expect(block).toContain('session: bf1881bc-9fd9');
  });

  it('merge onto an empty checkpoint is the block alone', () => {
    expect(mergeMechanicalCheckpoint(null, block)).toBe(block);
    expect(mergeMechanicalCheckpoint('', block)).toBe(block);
  });

  it('merge PRESERVES agent prose and appends the block', () => {
    const merged = mergeMechanicalCheckpoint('agent wrote this design note', block);
    expect(merged.startsWith('agent wrote this design note')).toBe(true);
    expect(merged).toContain(MECHANICAL_CHECKPOINT_MARKER);
  });

  it('a repeated sweep REPLACES the previous mechanical block, never stacks', () => {
    const first = mergeMechanicalCheckpoint('agent prose', block);
    const block2 = composeMechanicalCheckpoint({ atIso: '2026-07-14T19:30:00.000Z', journalNote: 'later turn' });
    const second = mergeMechanicalCheckpoint(first, block2);
    expect(second.startsWith('agent prose')).toBe(true);
    expect(second.match(new RegExp('⟦auto-checkpoint mechanical', 'g'))).toHaveLength(1);
    expect(second).toContain('later turn');
    expect(second).not.toContain('P-015 legs 1-2 landed');
  });

  it('preserves a newer authored checkpoint appended after a mechanical snapshot', async () => {
    const { renderCarryNote, readCarryLatestUpdate, shortCarryHash, splitCarryNoteChecks, splitCarryNoteWalls } =
      await import('./carry-note');
    const firstNote = renderCarryNote({ did: 'Original authored progress.', next: 'Continue the original action.' });
    const first = mergeMechanicalCheckpoint(firstNote, block);
    const latestNote = renderCarryNote({
      did: 'New authored progress after the prior mechanical snapshot.',
      next: 'Resume from this exact structured action.',
    });
    const latestUpdate = splitCarryNoteWalls(splitCarryNoteChecks(latestNote).body).body.trim();
    const appended = `${first}\n\n---\n${latestNote}`;
    const nextBlock = composeMechanicalCheckpoint({
      atIso: '2026-07-14T20:30:00.000Z',
      journalNote: 'Latest authored checkpoint is preserved.',
    });

    const merged = mergeMechanicalCheckpoint(appended, nextBlock);
    const offset = merged.indexOf(latestUpdate);
    const latestSpan = {
      noteHash: shortCarryHash(merged),
      offset,
      length: offset >= 0 ? latestUpdate.length : 0,
    };

    expect(merged).toContain('New authored progress after the prior mechanical snapshot.');
    expect(merged).toContain('Resume from this exact structured action.');
    expect(merged.match(new RegExp(MECHANICAL_CHECKPOINT_MARKER, 'g'))).toHaveLength(1);
    expect(merged).not.toContain('P-015 legs 1-2 landed');
    expect(readCarryLatestUpdate(merged, latestSpan)).toEqual({ status: 'available', text: latestUpdate });
  });

  it('keeps mechanical tool logs outside authored Checks and Walls rows', async () => {
    const { splitCarryNoteChecks, splitCarryNoteWalls } = await import('./carry-note');
    const prior = [
      '## Did',
      'The agent-authored checkpoint.',
      '',
      '## Checks',
      '- ✓ release gate is green — re-check: read the gate — evidence: observed green',
      '',
      '## Walls',
      '- owner approval remains — re-check: ask owner',
    ].join('\n');

    const merged = mergeMechanicalCheckpoint(prior, block);
    const { checks, body } = splitCarryNoteChecks(merged);
    const { walls } = splitCarryNoteWalls(merged);

    expect(checks).toHaveLength(1);
    expect(checks[0]?.claim).toBe('release gate is green');
    expect(walls).toHaveLength(1);
    expect(walls[0]?.claim).toBe('owner approval remains');
    expect(body).toContain(MECHANICAL_CHECKPOINT_MARKER);
    expect(merged.indexOf(MECHANICAL_CHECKPOINT_MARKER)).toBeLessThan(merged.indexOf('## Checks'));
  });

  it('preserves check evidence and walls through repeated snapshots and a successor checkpoint', async () => {
    const { mergeCarryRows, splitCarryNoteChecks, splitCarryNoteWalls, withCarryNoteChecks, withCarryNoteWalls } =
      await import('./carry-note');
    const prior = withCarryNoteWalls(withCarryNoteChecks('## Did\nAuthored progress.\n\n## Next action\nVerify the source.', [
      { id: 'real-mcp-spill-attribution', claim: 'The spill remains readable.', sinceMs: 1, verified: 'Passing fixture.', recheck: 'Run the spill fixture.' },
      { id: 'quota-scan-reuse', claim: 'Quota waiters share one scan.', sinceMs: 2, verified: 'One scan observed.', falsifier: 'More than one scan.' },
      { id: 'scratch-phase-attribution', claim: 'The diagnostic retains the original error.', sinceMs: 3, observed: 'Original error retained.' },
    ]), [{ id: 'source-custody', claim: 'Preserve the source lane.', sinceMs: 4, recheck: 'Read the governing decision.' }]);
    const originalChecks = splitCarryNoteChecks(prior).checks;
    const originalWalls = splitCarryNoteWalls(prior).walls;
    const first = mergeMechanicalCheckpoint(prior, block);
    const later = composeMechanicalCheckpoint({ atIso: '2026-07-14T19:30:00.000Z', journalNote: 'Later snapshot.' });
    const second = mergeMechanicalCheckpoint(first, later);

    expect(splitCarryNoteChecks(second).checks).toEqual(originalChecks);
    expect(splitCarryNoteWalls(second).walls).toEqual(originalWalls);
    expect(second).toContain('Authored progress.');
    expect(second.match(new RegExp(MECHANICAL_CHECKPOINT_MARKER, 'g'))).toHaveLength(1);
    expect(second).not.toContain('P-015 legs 1-2 landed');

    const successor = mergeCarryRows({
      priorNote: second, baseNote: '## Did\nSuccessor resumed.', hasNoteWrite: true, mode: 'merge',
    });
    expect(successor.checks).toEqual(originalChecks);
    expect(successor.walls).toEqual(originalWalls);
    expect(successor.droppedChecks).toEqual([]);
    expect(successor.droppedWalls).toEqual([]);
  });

  it('replaces a legacy mechanical tail without losing the preceding protected rows', async () => {
    const { splitCarryNoteChecks, splitCarryNoteWalls, withCarryNoteChecks, withCarryNoteWalls } = await import('./carry-note');
    const prior = withCarryNoteWalls(withCarryNoteChecks('Authored progress.', [
      { id: 'verified-check', claim: 'Keep this verified check.', sinceMs: 1, verified: 'Saved evidence.' },
    ]), [{ id: 'source-wall', claim: 'Keep source custody.', sinceMs: 2 }]);
    const legacy = `${prior}\n\n---\n${block}`;
    const later = composeMechanicalCheckpoint({ atIso: '2026-07-14T19:30:00.000Z', journalNote: 'New snapshot.' });
    const merged = mergeMechanicalCheckpoint(legacy, later);

    expect(splitCarryNoteChecks(merged).checks).toEqual(splitCarryNoteChecks(prior).checks);
    expect(splitCarryNoteWalls(merged).walls).toEqual(splitCarryNoteWalls(prior).walls);
    expect(merged.match(new RegExp(MECHANICAL_CHECKPOINT_MARKER, 'g'))).toHaveLength(1);
    expect(merged.indexOf(MECHANICAL_CHECKPOINT_MARKER)).toBeLessThan(merged.indexOf('## Checks'));
    expect(merged).not.toContain('P-015 legs 1-2 landed');
  });
});

describe('deliverable detection', () => {
  it('scratch-path reports are deliverables; repo/code/plumbing writes are not', () => {
    expect(isDeliverableWrite('/tmp/claude-1000/scratchpad/audit-report.md')).toBe(true);
    expect(isDeliverableWrite('/home/x/.papercusp/scratch/ws/export.csv')).toBe(true);
    expect(isDeliverableWrite('/home/x/repo/lib/foo.ts')).toBe(false);
    expect(isDeliverableWrite('/tmp/x/build.log')).toBe(false);
    expect(isDeliverableWrite('/tmp/x/tasks/run.output.md')).toBe(false);
    expect(isDeliverableWrite('/tmp/x/result-door-123.md')).toBe(false);
  });

  it('detectUnregisteredArtifacts matches registrations by basename and dedupes', () => {
    const writes = [
      '/tmp/s/scratchpad/report.md',
      '/tmp/s/scratchpad/report.md',
      '/tmp/s/scratchpad/summary.html',
      '/repo/lib/code.ts',
    ];
    const out = detectUnregisteredArtifacts(writes, ['reports/REPORT.md']);
    expect(out).toEqual(['/tmp/s/scratchpad/summary.html']);
  });

  it('tripwire is null when clean, populated + noted when not', () => {
    expect(unregisteredArtifactTripwire(['/repo/a.ts'], [])).toBeNull();
    const t = unregisteredArtifactTripwire(['/tmp/s/scratchpad/report.md'], []);
    expect(t?.kind).toBe('unregistered-artifact');
    expect(t?.files).toEqual(['/tmp/s/scratchpad/report.md']);
    expect(t?.note).toContain('artifacts:save');
  });

  it('keeps native sibling paths and finds shell heredoc/redirection writes', () => {
    const siblingA = '/home/x/.papercusp/scratch/p006/judge-A-scores.md';
    const siblingB = '/home/x/.papercusp/scratch/p006/judge-B-scores.md';
    const redirected = '/home/x/.papercusp/scratch/p006/combined.md';
    expect(
      extractFileWritePaths([
        { file: siblingA },
        { file: siblingB },
        { command: `cat > '${redirected}' <<'EOF'\ntext > /tmp/not-a-target.md\nEOF` },
      ]),
    ).toEqual([siblingA, siblingB, redirected]);
  });

  it('finds tee and supported interpreter write APIs', () => {
    const teePath = '/tmp/agent/scratchpad/tee-report.md';
    const nodePath = '/tmp/agent/scratchpad/node-report.md';
    const pythonPath = '/tmp/agent/scratchpad/python-report.md';
    expect(
      extractShellWriteTargets(
        `printf '%s' data | tee -a '${teePath}'; node -e "fs.writeFileSync('${nodePath}', 'x')"; ` +
          `python - <<'PY'\nfrom pathlib import Path\nPath('${pythonPath}').write_text('x')\nPY`,
      ),
    ).toEqual([teePath, nodePath, pythonPath]);
  });

  it('does not treat read-only shell commands or printed paths as writes', () => {
    const path = '/tmp/agent/scratchpad/report.md';
    expect(extractShellWriteTargets(`cat '${path}'`)).toEqual([]);
    expect(extractShellWriteTargets(`node -e "console.log('${path}')"`)).toEqual([]);
    expect(extractShellWriteTargets(`node -e "fs.readFileSync('${path}')"`)).toEqual([]);
    expect(extractShellWriteTargets(`python -c "open('${path}').read()"`)).toEqual([]);
  });
});

describe('ephemeral terminal-deliverable reference detection', () => {
  it('finds scratch paths and both Claude artifact URL forms, in text order', () => {
    const refs = detectEphemeralDeliverableReferences(
      'source .papercusp/scratch/report.md; published https://claude.ai/code/artifact/abc; ' +
        'also https://claude.ai/artifacts/def.',
    );
    expect(refs).toEqual([
      { kind: 'scratch-path', reference: '.papercusp/scratch/report.md' },
      { kind: 'artifact-url', reference: 'https://claude.ai/code/artifact/abc' },
      { kind: 'artifact-url', reference: 'https://claude.ai/artifacts/def' },
    ]);
  });

  it('finds loopback presentation URLs but not lookalike hostnames', () => {
    const refs = detectEphemeralDeliverableReferences(
      'mockup http://localhost:8765/mockups/; preview http://127.0.0.1:4173/; ' + 'desktop http://[::1]:3000/app',
    );
    expect(refs).toEqual([
      { kind: 'loopback-url', reference: 'http://localhost:8765/mockups/' },
      { kind: 'loopback-url', reference: 'http://127.0.0.1:4173/' },
      { kind: 'loopback-url', reference: 'http://[::1]:3000/app' },
    ]);
    expect(detectEphemeralDeliverableReferences('https://localhost.example/mockups/')).toEqual([]);
  });

  it('recognises home/absolute scratch paths and papercusp scratch URIs, but not repo files', () => {
    const refs = detectEphemeralDeliverableReferences(
      '~/.papercusp/scratch/ws/report.md /home/dev/.papercusp/scratch/ws/other.txt ' +
        'papercusp://scratch/ws/tool/run/report.md packages/operator-core/src/report.md',
    );
    expect(refs).toEqual([
      { kind: 'scratch-path', reference: '~/.papercusp/scratch/ws/report.md' },
      { kind: 'scratch-path', reference: '/home/dev/.papercusp/scratch/ws/other.txt' },
      { kind: 'scratch-uri', reference: 'papercusp://scratch/ws/tool/run/report.md' },
    ]);
  });

  it('deduplicates and bounds the result while trimming markdown punctuation', () => {
    const refs = detectEphemeralDeliverableReferences(
      [1, 2, 3, 4, 5, 6].map((n) => `.papercusp/scratch/report-${n}.md,`).join(' ') + ' .papercusp/scratch/report-1.md',
    );
    expect(refs).toHaveLength(5);
    expect(refs.every((ref) => !/[.,]$/.test(ref.reference))).toBe(true);
    expect(new Set(refs.map((ref) => ref.reference)).size).toBe(5);
  });

  it('renders an actionable warn-only message and stays silent for clean text', () => {
    expect(renderEphemeralDeliverableWarning('completion for EI-1', [])).toBeUndefined();
    const refs = detectEphemeralDeliverableReferences('.papercusp/scratch/report.md');
    const warning = renderEphemeralDeliverableWarning('plans:set-now for plan-a', refs);
    expect(warning).toContain('plans:set-now for plan-a names an ephemeral terminal-deliverable reference');
    expect(warning).toContain('Persist the deliverable first in committed repository, plan, or work-item storage');
    expect(warning).toContain('record its source path alongside any URL');
    expect(warning).toContain('write was recorded');
  });

  it('warns that loopback presentation reachability is transient', () => {
    const refs = detectEphemeralDeliverableReferences('mockup: http://localhost:8765/mockups/');
    const warning = renderEphemeralDeliverableWarning('completion for EI-20435285714990036', refs);
    expect(warning).toContain("loopback-url 'http://localhost:8765/mockups/'");
    expect(warning).toContain('re-verify reachability at handoff');
    expect(warning).toContain('serving process managed/alive');
  });
});

describe('isRewakeGuaranteed / detectUnguardedHalt (re-wake guarantee)', () => {
  const halt = { autonomousModeActive: true, loopActive: false, activeAwaitCount: 0 };

  it('an interactive (non-autonomous) session is ALWAYS guaranteed — never flagged', () => {
    expect(isRewakeGuaranteed({ ...halt, autonomousModeActive: false })).toBe(true);
    expect(detectUnguardedHalt({ ...halt, autonomousModeActive: false })).toBeNull();
  });

  it('a machine-injected turn is not guaranteed by an absent autonomous mode row', () => {
    const machineHalt = { ...halt, autonomousModeActive: false, machineTurn: true };
    expect(isRewakeGuaranteed(machineHalt)).toBe(false);
    expect(detectUnguardedHalt(machineHalt)).not.toBeNull();
  });

  it('a machine-injected turn remains safe when a concrete wake is active', () => {
    expect(isRewakeGuaranteed({ ...halt, autonomousModeActive: false, machineTurn: true, loopActive: true })).toBe(
      true,
    );
    expect(isRewakeGuaranteed({ ...halt, autonomousModeActive: false, machineTurn: true, activeAwaitCount: 1 })).toBe(
      true,
    );
  });

  it('an autonomous session with an armed loop is guaranteed', () => {
    expect(isRewakeGuaranteed({ ...halt, loopActive: true })).toBe(true);
    expect(detectUnguardedHalt({ ...halt, loopActive: true })).toBeNull();
  });

  it('an autonomous session with a real (non-inbox-wake) await is guaranteed', () => {
    expect(isRewakeGuaranteed({ ...halt, activeAwaitCount: 1 })).toBe(true);
    expect(detectUnguardedHalt({ ...halt, activeAwaitCount: 2 })).toBeNull();
  });

  it('an owner-interactive turn suppresses the flag even under autonomous mode', () => {
    expect(isRewakeGuaranteed({ ...halt, ownerInteractiveTurn: true })).toBe(true);
    expect(detectUnguardedHalt({ ...halt, ownerInteractiveTurn: true })).toBeNull();
  });

  /**
   * WI-6604 — what `activeAwaitCount` is allowed to COUNT.
   *
   * The count above is the guarantee this whole tripwire rests on, so an await that
   * cannot actually re-invoke the session must never reach it. On 2026-07-28 a session
   * slept on `release:deployed` after firing the gate; the gate went red, so no deploy
   * was attempted and the event could never fire. Because a sleeping await also
   * suppresses monitor-loop fires, it silenced the armed 60s loop too — active:true,
   * parked:true, zero turns for ~26 minutes until a human noticed.
   */
  describe('awaitGuaranteesRewake — registered is NOT the same as guaranteeing', () => {
    const PREFIX = 'coord:inbox-wake:';
    const bounded = { eventKey: 'release:deployed', expiresTs: '2026-07-28T08:34:12.000Z', once: true };

    it('counts a BOUNDED await that wakes on its deadline', () => {
      expect(awaitGuaranteesRewake(bounded, PREFIX)).toBe(true);
      // 'wake' is the store's default, so an absent field must not read as unbounded.
      expect(awaitGuaranteesRewake({ ...bounded, timeoutBehavior: 'wake' }, PREFIX)).toBe(true);
      expect(awaitGuaranteesRewake({ ...bounded, timeoutBehavior: null }, PREFIX)).toBe(true);
    });

    it('REFUSES an unbounded await — if the event never fires, nothing re-invokes you', () => {
      expect(awaitGuaranteesRewake({ ...bounded, expiresTs: null }, PREFIX)).toBe(false);
      expect(awaitGuaranteesRewake({ eventKey: 'release:deployed' }, PREFIX)).toBe(false);
    });

    it('REFUSES an await that expires SILENTLY instead of waking', () => {
      expect(awaitGuaranteesRewake({ ...bounded, timeoutBehavior: 'expire' }, PREFIX)).toBe(false);
    });

    it('counts an explicit bounded events:await on an inbox-wake key', () => {
      expect(awaitGuaranteesRewake({ ...bounded, eventKey: `${PREFIX}su-8d9a671c` }, PREFIX)).toBe(true);
    });

    it('REFUSES the always-armed inbox-wake keepalive — liveness, not a deliberate wake', () => {
      expect(
        awaitGuaranteesRewake(
          { eventKey: `${PREFIX}su-8d9a671c`, expiresTs: null, once: false, timeoutBehavior: 'expire' },
          PREFIX,
        ),
      ).toBe(false);
    });

    it('does not mistake an unbounded inbox-key await for a guarantee', () => {
      expect(
        awaitGuaranteesRewake(
          { eventKey: `${PREFIX}su-8d9a671c`, expiresTs: null, once: true, timeoutBehavior: 'wake' },
          PREFIX,
        ),
      ).toBe(false);
    });
  });

  it('autonomous + no loop + no await + no owner = UNGUARDED HALT', () => {
    expect(isRewakeGuaranteed(halt)).toBe(false);
    const t = detectUnguardedHalt(halt);
    expect(t?.kind).toBe('unguarded-halt');
    expect(t?.note).toBe(UNGUARDED_HALT_NOTE);
    expect(t?.note).toContain('session:request-compaction');
  });
});

describe('decideOpenTaskReminder (P-005 bounded task continuation)', () => {
  const task = (
    overrides: Partial<{
      id: string;
      content: string;
      activeForm: string;
      status: string;
      position: number;
      updatedAt: string;
    }> = {},
  ) => ({
    id: 'task-a',
    content: 'Finish the focused regression tests',
    activeForm: 'Finishing the focused regression tests',
    status: 'in_progress',
    position: 0,
    updatedAt: '2026-08-26T20:00:00.000Z',
    ...overrides,
  });

  it('reminds for pending/in_progress tasks and renders a visible bounded prompt', () => {
    const decision = decideOpenTaskReminder({
      tasks: [task(), task({ id: 'task-b', status: 'pending', content: 'Run typecheck' })],
      wakeGuaranteed: false,
    });

    expect(decision?.tripwire).toMatchObject({
      kind: 'open-task-reminder',
      attempt: 1,
      maxAttempts: MAX_OPEN_TASK_REMINDER_ATTEMPTS,
      taskCount: 2,
      taskIds: ['task-a', 'task-b'],
    });
    expect(decision?.prompt).toContain('⟦open-task-reminder 1/3⟧');
    expect(decision?.prompt).toContain('[in_progress] Finishing the focused regression tests');
    expect(decision?.prompt).toContain('[pending] Run typecheck');
  });

  it('suppresses completed/blocked-only lists and any concrete wake guarantee', () => {
    expect(
      decideOpenTaskReminder({
        tasks: [task({ status: 'completed' }), task({ id: 'task-b', status: 'blocked' })],
        wakeGuaranteed: false,
      }),
    ).toBeNull();
    expect(decideOpenTaskReminder({ tasks: [task()], wakeGuaranteed: true })).toBeNull();
  });

  it('increments an unchanged signature, resets after task mutation, and never exceeds the bound', () => {
    const tasks = [task()];
    const first = decideOpenTaskReminder({ tasks, wakeGuaranteed: false });
    const second = decideOpenTaskReminder({
      tasks,
      wakeGuaranteed: false,
      priorTripwire: first?.tripwire,
    });
    const third = decideOpenTaskReminder({
      tasks,
      wakeGuaranteed: false,
      priorTripwire: second?.tripwire,
    });
    const exhausted = decideOpenTaskReminder({
      tasks,
      wakeGuaranteed: false,
      priorTripwire: third?.tripwire,
    });

    expect(second?.tripwire.attempt).toBe(2);
    expect(third?.tripwire.attempt).toBe(3);
    expect(exhausted).toBeNull();

    const mutated = [task({ updatedAt: '2026-08-26T20:01:00.000Z' })];
    expect(openTaskReminderSignature(mutated)).not.toBe(openTaskReminderSignature(tasks));
    expect(
      decideOpenTaskReminder({
        tasks: mutated,
        wakeGuaranteed: false,
        priorTripwire: third?.tripwire,
      })?.tripwire.attempt,
    ).toBe(1);
  });
});

/** unread-count-truthfulness-2026-07-27 P-008 / D-008 — the coord-cursor settle.
 *  `messages_since_ts` becomes a strict, abort-safe FOLLOWER of the read receipt
 *  `messages_shown_ts`: monotone (never regresses an OMP-reported value) and
 *  clamped (never past what was demonstrably shown). */
describe('settledMessagesCursor (D-008 coord-cursor settle)', () => {
  const SHOWN = '2026-07-27T18:00:00.000Z';

  it('THE BUG: a never-settled cursor advances to the read receipt', () => {
    // The measured live shape: 14/14 clean-turn-end agents had a shown_ts and
    // 0/14 a current since_ts. An empty since_ts reads as "never read
    // anything" => count from log epoch => the 19k unread badge.
    expect(settledMessagesCursor({ sinceTs: '', shownTs: SHOWN })).toBe(SHOWN);
    expect(settledMessagesCursor({ sinceTs: null, shownTs: SHOWN })).toBe(SHOWN);
    expect(settledMessagesCursor({ sinceTs: undefined, shownTs: SHOWN })).toBe(SHOWN);
  });

  it('advances a genuinely-behind cursor (the 35h-stale row this plan found)', () => {
    expect(settledMessagesCursor({ sinceTs: '2026-07-26T07:02:52.000Z', shownTs: SHOWN })).toBe(SHOWN);
  });

  it('MONOTONE: never regresses a cursor that is already ahead', () => {
    // writeWatermark is deliberately last-write-wins and makes ordering safety
    // the caller's job — so an OMP session that reported a cursor AHEAD of the
    // receipt must not be walked backward by this settle.
    const ahead = '2026-07-27T19:00:00.000Z';
    expect(settledMessagesCursor({ sinceTs: ahead, shownTs: SHOWN })).toBeNull();
  });

  it('no-ops when already exactly at the receipt (no redundant write)', () => {
    expect(settledMessagesCursor({ sinceTs: SHOWN, shownTs: SHOWN })).toBeNull();
  });

  it('NEVER GUESSES: an absent receipt settles nothing rather than inventing "now"', () => {
    // Advancing on a missing receipt would silently SKIP mail — strictly worse
    // than the over-count this plan is fixing.
    expect(settledMessagesCursor({ sinceTs: '', shownTs: '' })).toBeNull();
    expect(settledMessagesCursor({ sinceTs: '', shownTs: null })).toBeNull();
    expect(settledMessagesCursor({ sinceTs: SHOWN, shownTs: undefined })).toBeNull();
  });

  it('CLAMPED: the only value ever returned is the receipt itself', () => {
    // P-008's `since_ts <= shown_ts` invariant holds BY CONSTRUCTION, matching
    // the substrate's stated contract (shown_ts is always >= since_ts).
    for (const sinceTs of ['', '2026-01-01T00:00:00.000Z', '2026-07-27T17:59:59.999Z']) {
      const next = settledMessagesCursor({ sinceTs, shownTs: SHOWN });
      expect(next).toBe(SHOWN);
      expect(next! <= SHOWN).toBe(true);
    }
  });

  it('is idempotent — settling twice writes once', () => {
    const first = settledMessagesCursor({ sinceTs: '', shownTs: SHOWN });
    expect(first).toBe(SHOWN);
    expect(settledMessagesCursor({ sinceTs: first, shownTs: SHOWN })).toBeNull();
  });
});
