/**
 * agent-obligation-owner-directives.test.ts — P-006 of plan
 * `turn-start-memory-two-class-2026-09-21`.
 *
 * WHAT THIS EXISTS TO CATCH. WI-10002186 measured the `orders:record`
 * instruction reaching 0 of 334 live su renders: owner-directive capture was
 * dead and nothing failed. The repair is to make an undispositioned directive a
 * first-class OBLIGATION rather than a line in a block — so it is evaluated,
 * ranked and re-injected until dispositioned, on the same rail as every other
 * standing duty.
 *
 * The properties asserted below are the ones whose silent loss would recreate
 * that hole: one row per directive (never an aggregate count), the row's own
 * disposition VERB, the `orders:get` recovery pointer, the uncut D-004 text, a
 * stable id across turns, provenance that never upgrades an agent's claim into
 * owner authority, and — most important — a failed read that becomes an
 * explicit `unknown` instead of an empty queue.
 */
import { describe, expect, it, vi } from 'vitest';
import { agentObligationIsActionable, evaluateAgentObligations } from './agent-obligations';
import {
  ownerDirectiveObligations,
  OWNER_DIRECTIVE_OBLIGATION_REVISION,
  type OwnerDirectiveObligationRow,
  type OwnerDirectivesProviderInput,
} from './agent-obligation-providers';
import { readAgentObligationAgenda, type AgentObligationReaderDeps } from './agent-obligation-reader';
import { directiveDisplayText, OWNER_DIRECTIVE_VERBATIM_CAP } from './owner-directive-display';

const OBSERVED_AT = '2026-09-21T16:00:00.000Z';

/** A hook-captured owner turn: open the moment it lands (D-001, no triage). */
const HOOK_ROW: OwnerDirectiveObligationRow = {
  id: 17,
  state: 'open',
  displayText: '"Implement owner-directive capture as HYBRID"',
  recordedAt: '2026-09-21T15:27:44.000Z',
  recordedBy: 'su-c03852cb',
  capturedByHook: true,
};

const OPEN_ROW: OwnerDirectiveObligationRow = {
  id: 18,
  state: 'open',
  displayText: '"carry this plan to shipped status yourself now"',
  recordedAt: '2026-09-21T15:27:44.000Z',
  recordedBy: 'su-c03852cb',
  capturedByHook: false,
};

function input(read: OwnerDirectivesProviderInput['read']): OwnerDirectivesProviderInput {
  return {
    workspaceId: 'papercusp-workspace',
    ownerId: 'su-test',
    observedAt: OBSERVED_AT,
    sourceGeneration: 'gen-1',
    read,
  };
}

function known(rows: OwnerDirectiveObligationRow[]): OwnerDirectivesProviderInput {
  return input({ status: 'known', value: rows });
}

describe('ownerDirectiveObligations', () => {
  it('emits ONE obligation per directive, not one aggregate count', () => {
    const obligations = ownerDirectiveObligations(known([HOOK_ROW, OPEN_ROW]));
    expect(obligations).toHaveLength(2);
    expect(new Set(obligations.map((entry) => entry.id)).size).toBe(2);
    // An aggregate could be acknowledged without acting on any single row.
    expect(obligations.map((entry) => entry.applicableDemand)).toEqual([1, 1]);
  });

  it('routes every directive, hook-captured or recorded, to orders:disposition — there is no triage verb', () => {
    const obligations = ownerDirectiveObligations(known([HOOK_ROW, OPEN_ROW]));
    for (const entry of obligations) {
      expect(entry.action?.tool).toBe('orders:disposition');
      expect(entry.action?.summary).toMatch(/orders:disposition/);
      expect(entry.action?.summary).not.toMatch(/promote or dismiss|resolve-pending/i);
    }
  });

  it('carries the orders:get recovery pointer for every row', () => {
    const obligations = ownerDirectiveObligations(known([HOOK_ROW, OPEN_ROW]));
    expect(obligations.map((entry) => entry.action?.targetRef)).toEqual(['orders:get #17', 'orders:get #18']);
  });

  it('carries the D-004 display text in reason, never a paraphrase', () => {
    const [pending] = ownerDirectiveObligations(known([HOOK_ROW]));
    expect(pending!.reason).toContain(HOOK_ROW.displayText);
  });

  it('stays actionable so it re-injects until dispositioned', () => {
    const obligations = ownerDirectiveObligations(known([HOOK_ROW, OPEN_ROW]));
    expect(obligations.every((entry) => entry.status === 'due')).toBe(true);
    expect(obligations.every(agentObligationIsActionable)).toBe(true);
    const agenda = evaluateAgentObligations(obligations, OBSERVED_AT);
    expect(agenda.primary).toHaveLength(2);
  });

  it('keeps a STABLE id for the same undispositioned row across turns', () => {
    // A churning id would read as a brand-new obligation on every warm turn and
    // defeat the unchanged-agenda dedup the reader depends on.
    const first = ownerDirectiveObligations(known([HOOK_ROW]));
    const later = ownerDirectiveObligations({
      ...known([HOOK_ROW]),
      observedAt: '2026-09-21T18:00:00.000Z',
    });
    expect(later[0]!.id).toBe(first[0]!.id);
    expect(later[0]!.ageMs).toBeGreaterThan(first[0]!.ageMs!);
  });

  it('never upgrades an agent-recorded claim into verified owner authority', () => {
    const [hookCaptured] = ownerDirectiveObligations(known([HOOK_ROW]));
    const [agentRecorded] = ownerDirectiveObligations(known([OPEN_ROW]));
    expect(hookCaptured!.authority).toMatchObject({ kind: 'owner', turnOrigin: 'owner-typed' });
    // orders:record is an AGENT asserting the owner said it — real evidence,
    // not proof. Representing it as `owner` is how a note-to-self becomes an
    // owner directive.
    expect(agentRecorded!.authority).toMatchObject({ kind: 'owner-candidate', turnOrigin: 'unknown' });
  });

  it('sorts ahead of policy-sourced duties (an owner directive outranks the loop agenda)', () => {
    const [pending] = ownerDirectiveObligations(known([HOOK_ROW]));
    expect(pending!.causalRank).toBe(0);
    expect(pending!.priority).toBe('critical');
  });

  it('reports an empty queue as not-applicable, which never reaches the prompt', () => {
    const obligations = ownerDirectiveObligations(known([]));
    expect(obligations).toHaveLength(1);
    expect(obligations[0]!.status).toBe('not-applicable');
    expect(evaluateAgentObligations(obligations, OBSERVED_AT).primary).toEqual([]);
  });

  it('reports a FAILED read as unknown with a concrete retry, not as an empty queue', () => {
    // The whole point: "no directives" and "I could not read the directives"
    // must never render identically.
    const obligations = ownerDirectiveObligations(
      input({
        status: 'unknown',
        failure: {
          code: 'canonical-owner-directive-read-failed',
          detail: 'owner directives timed out after 900ms',
          retry: 'retry listOwnerDirectives for the pending and open states',
        },
      }),
    );
    expect(obligations).toHaveLength(1);
    expect(obligations[0]!.status).toBe('unknown');
    expect(obligations[0]!.measurementFailure?.retry).toMatch(/listOwnerDirectives/);
    expect(obligations[0]!.ruleRevision).toBe(OWNER_DIRECTIVE_OBLIGATION_REVISION);
  });
});

describe('directiveDisplayText (D-004)', () => {
  it('returns a directive up to the cap whole', () => {
    expect(directiveDisplayText({ id: 1, verbatimText: '  do the thing  ' })).toBe('"do the thing"');
    const atCap = 'x'.repeat(OWNER_DIRECTIVE_VERBATIM_CAP);
    expect(directiveDisplayText({ id: 1, verbatimText: atCap })).toBe(JSON.stringify(atCap));
  });

  it('over the cap, shows NO fragment of the text until a summary exists', () => {
    const long = 'x'.repeat(OWNER_DIRECTIVE_VERBATIM_CAP + 1);
    const shown = directiveDisplayText({ id: 9, verbatimText: long });
    expect(shown).not.toContain('xxxxx');
    expect(shown).toContain('summary not written yet');
    expect(shown).toContain('[full text: orders:get #9]');
  });

  it('over the cap, shows the summary labelled with its author', () => {
    const long = 'x'.repeat(OWNER_DIRECTIVE_VERBATIM_CAP + 1);
    const shown = directiveDisplayText({ id: 9, verbatimText: long, summaryText: 'Do x.', summaryBy: 'su-author-123456' });
    expect(shown).toBe('summary by su-author-12: "Do x." [full text: orders:get #9]');
  });
});

function readerDeps(
  ownerDirectives: AgentObligationReaderDeps['ownerDirectives'],
): Partial<AgentObligationReaderDeps> {
  return {
    ownerDirectives,
    goalSubject: async () => null,
    planSlugs: async () => [],
    // `waitingOn` is NOT goal-gated (P-011), so it runs even on this no-goal
    // fixture. Leaving it un-injected reached the REAL provider, which opens a
    // live Postgres pool and rejects unhandled — every assertion below still
    // passed, so the suite read green while the run exited non-zero.
    waitingOn: async () => [],
    
    fleetStaffing: async () => [],
    strandedGoalWork: async (_ws: string, goalId: string) => ({ goalId, thresholdMs: 0, total: 0, refusedCount: 0, sample: [], truncatedByLimit: false }),
  };
}

describe('readAgentObligationAgenda owner-directive wiring', () => {
  it('emits the class for a session with NO goal and NO plan', async () => {
    // Gating this on an active goal would recreate the measured hole for every
    // session that holds neither.
    const read = await readAgentObligationAgenda({
      workspaceId: 'papercusp-workspace',
      ownerId: 'su-test',
      goalId: null,
      planSlugs: [],
      deps: readerDeps(async () => [HOOK_ROW]),
    });
    const directive = read.agenda.evaluations.find((entry) => entry.family === 'owner-directive');
    expect(directive, 'the owner-directive class must reach the agenda without a goal').toBeDefined();
    expect(directive!.status).toBe('due');
    expect(read.agenda.primary[0]!.family).toBe('owner-directive');
  });

  it('degrades a throwing read to unknown rather than dropping the class', async () => {
    // The degrade is deliberately LOUD: bounded-timeout warns on the way past.
    // Asserting the warning rather than silencing it keeps the operator-visible
    // half of this behaviour measured too.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const read = await readAgentObligationAgenda({
        workspaceId: 'papercusp-workspace',
        ownerId: 'su-test',
        goalId: null,
        planSlugs: [],
        deps: readerDeps(async () => {
          throw new Error('directive store unreachable');
        }),
      });
      const directive = read.agenda.evaluations.find((entry) => entry.family === 'owner-directive');
      expect(directive?.status).toBe('unknown');
      expect(directive?.measurementFailure?.code).toBe('canonical-owner-directive-read-failed');
      expect(read.degradedSources.join(' ')).toMatch(/owner directives/);
      expect(warn.mock.calls.flat().join(' ')).toMatch(/agent-obligations:owner-directives failed/);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps an unchanged queue at an unchanged sourceGeneration across turns', async () => {
    const dep = vi.fn(async () => [HOOK_ROW]);
    // Deliberately NOT `as const`: that widens `planSlugs` to `readonly []`,
    // which the reader's `string[]` parameter rejects — a type-only break a
    // green vitest run cannot see, because esbuild never typechecks.
    const args = {
      workspaceId: 'papercusp-workspace',
      ownerId: 'su-test',
      goalId: null,
      planSlugs: [] as string[],
      deps: readerDeps(dep),
    };
    const first = await readAgentObligationAgenda({ ...args, now: new Date('2026-09-21T16:00:00.000Z') });
    const second = await readAgentObligationAgenda({ ...args, now: new Date('2026-09-21T17:00:00.000Z') });
    const generationOf = (agenda: typeof first.agenda) =>
      agenda.evaluations.find((entry) => entry.family === 'owner-directive')!.sourceGeneration;
    expect(generationOf(second.agenda)).toBe(generationOf(first.agenda));
    expect(dep).toHaveBeenCalledTimes(2);
  });
});
