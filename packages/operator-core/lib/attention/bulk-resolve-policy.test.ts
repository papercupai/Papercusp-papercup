/**
 * BULK RESOLVE policy + contract coverage (inbox-bulk-resolve-2026-08-23,
 * P-004/P-007). Three things are pinned here, all of them cross-file
 * invariants that no single file's own tests can hold:
 *
 *  1. THE NAVIGATE SINGLE-DECLARATION RULE. `NAVIGATE_ACTION_IDS` decides "is
 *     this action terminal" for BOTH terminal paths — the owner's click and
 *     the agent's action — so the two must agree. It USED to be declared
 *     TWICE (client card + agent tool) and this test parsed one file's source
 *     to compare the lists: rung 2 (PIN) of the derived-truth ladder. It is now
 *     declared ONCE, in `./types`, and both former sites re-export it: rung 1
 *     (DERIVE), where the drift cannot be expressed at all.
 *
 *     So what is pinned here is no longer "the two lists agree" (they cannot
 *     disagree) but "there is still only ONE list" — a future edit that
 *     reintroduces a local `new Set` in either former site re-creates the
 *     drift vector. The dangerous direction is unchanged: an id the SERVER
 *     thinks is terminal but the CLIENT treats as navigation is an action a
 *     resolver may auto-resolve with and that resolves nothing. That exact
 *     drift (`discuss` missing from the set) once let the Discuss button
 *     silently close real owner gates (EI-13037).
 *
 *  2. THE RESOLVER BRIEF'S POLICY (D-001/D-002). The brief is what carries the
 *     plan's decisions into the run, and it is prose — so nothing but a test
 *     stops a later edit from quietly dropping the clause that keeps the agent
 *     from inventing option ids or from resolving what the owner must decide.
 *
 *  3. THE SYNC RESOLVER'S SHAPE. `plans.attentionBulkRun` must return ONE row
 *     with an explicit `run: null` when there is no run — never an empty row
 *     set, which is indistinguishable from a read that failed, and would render
 *     the strip's idle state on "unknown" rather than on "no run".
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  buildResolverBrief,
  buildResolverLaunchCommand,
  resolverSpawnOutcome,
} from '../endpoint-route/routes/admin/attention-bulk-resolve';
// Deliberately imported via the AGENT TOOL's own export path, so the identity
// assertion below fails if that re-export is ever swapped back for a copy.
import { NAVIGATE_ACTION_IDS } from '../agent-tools/inbox/bulk-run';
import {
  NAVIGATE_ACTION_IDS as CANONICAL_NAVIGATE_ACTION_IDS,
  isNavigateAction,
} from './types';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

describe('NAVIGATE_ACTION_IDS — exactly one declaration, shared by both terminal paths', () => {
  // The two former declaration sites. Each must now REFERENCE the canonical
  // set rather than build its own.
  const REEXPORTERS = [
    'apps/operator/app/admin/plans/attention-card.ts', // the owner's click
    'packages/operator-core/lib/agent-tools/inbox/bulk-run.ts', // the agent's action
  ] as const;

  it('the agent tool re-exports the canonical set itself, not a copy of it', () => {
    // Object IDENTITY, not deep equality: two sets with equal contents today
    // is exactly the state that used to drift. Only identity proves there is
    // one set. (Imported via the agent tool's own export path, so this fails
    // if that re-export is ever replaced by a local declaration.)
    expect(NAVIGATE_ACTION_IDS).toBe(CANONICAL_NAVIGATE_ACTION_IDS);
  });

  it('still names the EI-13037 id, and is not empty', () => {
    // Positive control: an empty set would make every "is it navigate?"
    // assertion below vacuously pass.
    expect(NAVIGATE_ACTION_IDS.size).toBeGreaterThan(0);
    expect(NAVIGATE_ACTION_IDS.has('discuss')).toBe(true);
    // `discuss` opening a sub-surface is the whole point of the incident.
    expect(isNavigateAction('discuss')).toBe(true);
    // ...and a genuinely terminal id must NOT be in it, or the predicate is
    // inverted and every terminal action would read as navigation.
    expect(isNavigateAction('resolve')).toBe(false);
  });

  it.each(REEXPORTERS)('%s declares no NAVIGATE_ACTION_IDS set of its own', (relPath) => {
    // The drift vector is REINTRODUCTION of a second copy. A re-export cannot
    // disagree with the canonical set; a fresh `new Set` can, and would restore
    // exactly the hazard the single declaration removed.
    const src = readFileSync(join(REPO_ROOT, relPath), 'utf8');

    // Positive control: we are reading the file we think we are, and it does
    // mention the symbol — so a zero-match below means "no local declaration",
    // never "wrong path" or "file moved".
    expect(src, `${relPath}: unreadable or unexpectedly empty`).toContain('NAVIGATE_ACTION_IDS');

    const localDecl = src.match(/(?:const|let|var)\s+NAVIGATE_ACTION_IDS\b[^=]*=\s*new\s+Set/);
    expect(
      localDecl,
      `${relPath} declares its own NAVIGATE_ACTION_IDS set. Re-export it from ` +
        `packages/operator-core/lib/attention/types instead — a second copy is how the ` +
        `owner-click path and the agent path drift (EI-13037).`,
    ).toBeNull();
  });
});

describe('resolver brief — the D-001/D-002 policy it carries into the run', () => {
  const brief = buildResolverBrief('run-abc123', 12);

  it('names the run and its size, so the agent is bound to THIS run', () => {
    expect(brief).toContain('run-abc123');
    expect(brief).toContain('12');
    // The manifest call must carry the run id, or the agent reads whatever run
    // happens to be active.
    expect(brief).toMatch(/inbox:bulk-run-manifest \{ runId: "run-abc123" \}/);
  });

  it('forbids inventing an option id', () => {
    expect(brief).toMatch(/NEVER invent an option id/i);
    expect(brief).toMatch(/Only ids the manifest listed/i);
  });

  it('requires a rationale on every auto-resolve — it is the audit note', () => {
    expect(brief).toMatch(/rationale is REQUIRED on every auto_resolved/i);
    expect(brief).toMatch(/reason is REQUIRED on skipped\/failed/i);
  });

  it('prefers RECOMMEND over resolve for owner-preference, money and irreversible calls', () => {
    // The resolver can recommend around these owner-only decisions even when
    // the standing policy otherwise permits some terminal actions.
    expect(brief).toMatch(/Prefer recommending over resolving/i);
    expect(brief).toMatch(/owner's preference/i);
    expect(brief).toMatch(/money/i);
    expect(brief).toMatch(/irreversible/i);
  });

  it('makes L0/review-all recommendation-only, even for high-confidence items', () => {
    const reviewOnlyBrief = buildResolverBrief('run-l0', 1, {
      mode: 'review-all',
      minConfidence: 'high',
      level: 'L0',
    });
    expect(reviewOnlyBrief).toContain('review-only under L0/review-all');
    expect(reviewOnlyBrief).toMatch(/Never call inbox:bulk-run-act and never\s+report auto_resolved/i);
    expect(reviewOnlyBrief).toContain('recommendation for every item instead');
    expect(reviewOnlyBrief).toContain('report a recommendation and take no terminal action');
    expect(reviewOnlyBrief).not.toContain('report auto_resolved only after');
  });

  it('treats the launch policy as a snapshot and trusts the live action gate', () => {
    expect(brief).toContain('This is the launch snapshot');
    expect(brief).toContain('rechecks current standing policy');
    expect(brief).toMatch(/Mark auto_resolved only after this call\s+reports success/);
    expect(brief).toMatch(/do not use another path/);
  });

  it('encodes the D-002 consult loop: a bounded window, and a LAPSE downgrades confidence', () => {
    expect(brief).toMatch(/CONSULT/);
    expect(brief).toMatch(/coord:presence/);
    expect(brief).toMatch(/bounded window/i);
    // The honesty requirement: a lapsed consult is an inference, and must be
    // labelled as one rather than presented like a confirmed answer.
    expect(brief).toMatch(/confidence:"high"/);
    expect(brief).toMatch(/confidence:"low"/);
    expect(brief).toMatch(/lapse/i);
  });

  it('tells the agent a non-terminal option resolves nothing', () => {
    expect(brief).toMatch(/terminal:false/);
    expect(brief).toMatch(/never treat one as a resolution/i);
  });

  it('gives it a way to give up VISIBLY rather than stalling the run', () => {
    expect(brief).toMatch(/inbox:bulk-run-settle \{ failed: true, error \}/);
  });

  it('carries the owner-selected confidence mode into the resolver brief', () => {
    const policyBrief = buildResolverBrief('run-policy', 4, {
      mode: 'safe-medium-plus',
      minConfidence: 'medium',
    });
    expect(policyBrief).toContain('safe-medium-plus');
    expect(policyBrief).toContain('minimum confidence medium');
    expect(policyBrief).toMatch(/confidence \(high\|medium\|low\|insufficient\)/i);
  });
});

describe('resolver launch — a real supervised headless agent, never a shell greeting', () => {
  const ownerId = 'su-11111111-1111-4111-8111-111111111111';

  it('uses the shared scripted-agent command with every non-interactive launch rail', () => {
    const command = buildResolverLaunchCommand({
      workspaceId: 'papercusp-workspace',
      harness: 'papercusp',
      ownerId,
    });

    expect(command).toContain('psu --no-picker');
    expect(command).toContain('--account=default');
    expect(command).toContain('--agent=claude');
    expect(command).toContain(`--owner-id=${ownerId}`);
    expect(command).toContain('--harness=papercusp');
    expect(command).toContain('--workspace=papercusp-workspace');
    expect(command).toContain('--headless');
    expect(command).toContain('--carry=warm');
    expect(command).toContain('--role=su');
    expect(command).not.toContain('papercup status');
  });

  it('propagates an explicit spawn error instead of marking the run running', () => {
    const outcome = resolverSpawnOutcome(
      { status: 'error', error: 'psu exited at boot', code: 502 },
      ownerId,
    );
    expect(outcome).toEqual({ ok: false, error: 'psu exited at boot' });
  });

  it('requires a process handle so post-launch death remains observable', () => {
    const outcome = resolverSpawnOutcome(
      {
        status: 'ok',
        pid: 42,
        terminal: 'headless',
        child: null,
        display: null,
        desktopEnvResolvedVia: null,
      },
      ownerId,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ error: expect.stringMatching(/no process handle/i) });
  });

  it('uses the pre-pinned coord owner as the run resolver identity', () => {
    const child = {} as ChildProcess;
    const outcome = resolverSpawnOutcome(
      {
        status: 'ok',
        pid: 42,
        terminal: 'headless',
        child,
        display: null,
        desktopEnvResolvedVia: null,
      },
      ownerId,
    );
    expect(outcome).toEqual({ ok: true, sessionId: ownerId, child });
  });

  it('preserves the spawn-time child-exit observer for exits before listener attachment', () => {
    const child = {} as ChildProcess;
    const childExit = Promise.resolve({ code: 137, signal: null });
    const outcome = resolverSpawnOutcome(
      {
        status: 'ok',
        pid: 42,
        terminal: 'headless',
        child,
        childExit,
        display: null,
        desktopEnvResolvedVia: null,
      },
      ownerId,
    );

    expect(outcome).toEqual({ ok: true, sessionId: ownerId, child, childExit });
  });
});

describe('plans.attentionBulkRun sync resolver', () => {
  it('returns ONE row with an explicit null run when no run exists', async () => {
    vi.doMock('../attention/bulk-run-store', () => ({
      classifyRunLiveness: vi.fn(),
      getRun: vi.fn(),
      getLatestRun: vi.fn(async () => null),
      getRunItems: vi.fn(async () => []),
    }));
    const { getRegistryEntryV2 } = await import('../sync-resolver/index');
    const entry = getRegistryEntryV2('plans.attentionBulkRun');
    expect(entry, 'plans.attentionBulkRun is not registered').toBeTruthy();

    const rows = await entry!.resolve!({} as never);
    // NOT `[]`: an empty set is indistinguishable from a failed read, and the
    // strip must render IDLE on "no run", never on "unknown".
    expect(rows).toEqual([{ run: null, items: [] }]);
    vi.doUnmock('../attention/bulk-run-store');
  });

  it('degrades to the same idle row when the store THROWS', async () => {
    vi.resetModules();
    vi.doMock('../attention/bulk-run-store', () => ({
      classifyRunLiveness: vi.fn(),
      getRun: vi.fn(),
      getLatestRun: vi.fn(async () => {
        throw new Error('pg down');
      }),
      getRunItems: vi.fn(async () => []),
    }));
    const { getRegistryEntryV2 } = await import('../sync-resolver/index');
    const rows = await getRegistryEntryV2('plans.attentionBulkRun')!.resolve!({} as never);
    // The inbox itself must stay usable when the bulk substrate is unavailable —
    // every item remains resolvable by hand.
    expect(rows).toEqual([{ run: null, items: [] }]);
    vi.doUnmock('../attention/bulk-run-store');
    vi.resetModules();
  });

  it('reads the SPECIFIC run when one is named (the ?opcbr= deep link)', async () => {
    vi.resetModules();
    const getRun = vi.fn(async () => ({ runId: 'run-x', phase: 'review' }));
    const getLatestRun = vi.fn();
    vi.doMock('../attention/bulk-run-store', () => ({
      classifyRunLiveness: vi.fn(() => ({ state: 'not-executing', phase: 'review' })),
      getRun,
      getLatestRun,
      getRunItems: vi.fn(async () => [{ itemId: 'a' }]),
    }));
    const { getRegistryEntryV2 } = await import('../sync-resolver/index');
    const rows = (await getRegistryEntryV2('plans.attentionBulkRun')!.resolve!({
      runId: 'run-x',
    } as never)) as Array<{ run: { runId: string }; items: unknown[] }>;

    expect(getRun).toHaveBeenCalledWith('run-x');
    // A named run must NOT fall through to "latest" — that would silently show
    // a different run than the link asked for.
    expect(getLatestRun).not.toHaveBeenCalled();
    expect(rows[0]!.run).toMatchObject({
      runId: 'run-x',
      liveness: { state: 'not-executing', phase: 'review' },
    });
    expect(rows[0]!.items).toHaveLength(1);
    vi.doUnmock('../attention/bulk-run-store');
    vi.resetModules();
  });
});
