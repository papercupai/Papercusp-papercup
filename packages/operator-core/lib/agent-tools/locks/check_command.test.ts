/**
 * check_command.test.ts — the locks:check_command HANDLER (checkBashCommand mocked; its
 * matcher logic is covered in resource-command-match.integration.test.ts). Thin, but pins
 * that the handler resolves identity and forwards the command + coordinationDomain + owner
 * to the verdict engine, then spreads { ok:true, ...verdict } (decision + matched). A
 * regression that drops the identity scoping or the verdict spread is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/check_command.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// WI-38252: file locks resolve their default domain via readFileLockIdentity.
vi.mock('./identity', () => {
  const identity = vi.fn(() => ({ ownerId: 'me', coordinationDomain: 'dom' }));
  return { readIdentity: identity, readFileLockIdentity: identity };
});
vi.mock('./resource-command-match', () => ({ checkBashCommand: vi.fn() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws') }));
vi.mock('../../bash-substitution/registry', () => ({ getSubstitutionRows: vi.fn() }));
vi.mock('./goal-mode-edit-guard', () => ({ checkGoalModeEditGuard: vi.fn() }));
const identityM = vi.hoisted(() => ({ read: vi.fn(), wears: vi.fn() }));
vi.mock('../../agent-identities/sync-hook-rules', () => ({
  readAppliedIdentityRules: identityM.read,
  wearsPapercuspEngineer: identityM.wears,
}));
vi.mock('../capability/base-dir', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../capability/base-dir')>()),
  resolveCapabilityIntegrationRoot: vi.fn(() => '/repo'),
}));
const frozenM = vi.hoisted(() => ({
  classify: vi.fn(),
  evaluate: vi.fn(),
  payload: vi.fn(),
}));
const queueIo = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../harness/routines/release-actions', () => ({
  readFrozenCandidateRepairQueue: queueIo.read,
}));
vi.mock('../../release/frozen-lineage-execution-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../release/frozen-lineage-execution-policy')>()),
  classifyFrozenLineageShellCommand: frozenM.classify,
  evaluateFrozenLineageShellCommand: frozenM.evaluate,
  frozenLineageShellCommandViolationPayload: frozenM.payload,
}));

import { checkBashCommand } from './resource-command-match';
import { getSubstitutionRows } from '../../bash-substitution/registry';
import { fileLockCoordinationDomain } from './coordination-domain';
import { unsafeDependencyInstall } from '../../bash-substitution/pairs/dependency-install';
import { checkGoalModeEditGuard } from './goal-mode-edit-guard';
const checkM = vi.mocked(checkBashCommand);
const rowsM = vi.mocked(getSubstitutionRows);
const goalEditM = vi.mocked(checkGoalModeEditGuard);
const tool = (await import('./check_command')).default;
type CheckVerdict = Awaited<ReturnType<typeof checkBashCommand>>;
type ToolArgs = Parameters<typeof tool.handler>[0];
type ToolContext = Parameters<typeof tool.handler>[1];

/** A registry row shaped as the matcher consumes it. */
const sedRow = {
  intentLabel: 'file-range-read',
  bashPattern: String.raw`sed\s+-n\s+['"]?\s*\d+\s*,\s*\d+\s*p['"]?\s+\S`,
  bashPatternFlags: '',
  toolName: 'capability:read',
  tier: 'advise' as const,
  advisoryText: 'capability:read { file_path, offset, limit } reads a line range directly.',
  equivalenceVerdict: 'equivalent' as const,
};

const dependencyRow = {
  intentLabel: unsafeDependencyInstall.intentLabel,
  bashPattern: unsafeDependencyInstall.bashPattern.source,
  bashPatternFlags: unsafeDependencyInstall.bashPattern.flags,
  toolName: unsafeDependencyInstall.toolName,
  tier: 'deny' as const,
  advisoryText: unsafeDependencyInstall.advisoryText,
  equivalenceVerdict: unsafeDependencyInstall.expectedVerdict,
};

type Out = { content: { text: string }[] };
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  rowsM.mockResolvedValue([]);
  identityM.read.mockResolvedValue({ packagePins: [] });
  identityM.wears.mockReturnValue(true);
  goalEditM.mockResolvedValue(null);
  frozenM.classify.mockReturnValue(null);
  frozenM.evaluate.mockResolvedValue({
    allowed: true,
    reason: 'operation-not-governed',
    classification: null,
    policy: null,
  });
  frozenM.payload.mockReturnValue(null);
  queueIo.read.mockResolvedValue(null);
});

describe('locks:check_command handler', () => {
  it('forwards command + identity and spreads the verdict', async () => {
    checkM.mockResolvedValue({ decision: 'block', matched: ['dev-server'] } as never);
    const out = (await tool.handler({ command: 'systemctl restart papercup' } as never, {} as never)) as Out;
    expect(checkM).toHaveBeenCalledWith({ command: 'systemctl restart papercup', coordinationDomain: 'dom', ownerId: 'me' });
    expect(body(out)).toMatchObject({ ok: true, decision: 'block', matched: ['dev-server'] });
  });

  it('passes an allow verdict through', async () => {
    checkM.mockResolvedValue({ decision: 'allow', matched: [] } as CheckVerdict);
    expect(body((await tool.handler({ command: 'ls' } as never, {} as never)) as Out)).toMatchObject({ ok: true, decision: 'allow' });
  });

  it('applies the existing GOAL edit guard to a hook-confirmed tracked Bash mutation', async () => {
    checkM.mockResolvedValue({ decision: 'allow', matched: [] } as never);
    goalEditM.mockResolvedValue('GOAL mode: you never implement');

    const out = body((await tool.handler(
      { command: 'git mv old.ts new.ts', tracked_mutation: true } as never,
      { workspaceId: 'ws-live' } as never,
    )) as Out);

    expect(goalEditM).toHaveBeenCalledWith({
      workspaceId: 'ws-live',
      ownerId: 'me',
      intent: 'PreToolUse:BashTrackedMutation',
    });
    expect(out.goalModeEditDenyReason).toBe('GOAL mode: you never implement');
  });

  it('does not read GOAL mode for a shell command with no tracked mutation', async () => {
    checkM.mockResolvedValue({ decision: 'allow', matched: [] } as never);
    const out = body((await tool.handler({ command: 'git status' } as never, {} as never)) as Out);
    expect(goalEditM).not.toHaveBeenCalled();
    expect(out.goalModeEditDenyReason).toBeNull();
  });

  it('turns a frozen-lineage refusal into the blocking hook verdict and preserves its actionable reason', async () => {
    checkM.mockResolvedValue({ decision: 'allow', matched: [] } as never);
    const classification = {
      kind: 'canonical-root-test',
      operation: 'canonical-verification',
      selectionSource: 'effective-checkout-head',
      checkoutCwd: '/repo',
    };
    const frozenVerdict = {
      allowed: false,
      reason: 'checkout-head-mismatch',
      classification,
      policy: { allowed: false },
    };
    const message =
      'frozen_candidate_lineage_violation — candidate=ccc, repairHead=rrr, queueRevision=42; use repairHead/admit.';
    frozenM.classify.mockReturnValue(classification);
    frozenM.evaluate.mockResolvedValue(frozenVerdict);
    frozenM.payload.mockReturnValue({ message });

    const out = body(
      (await tool.handler({ command: 'npm test', cwd: '/repo' } as ToolArgs, {} as ToolContext)) as Out,
    );
    expect(out).toMatchObject({
      decision: 'block',
      frozenLineageDenyReason: message,
      frozenLineage: frozenVerdict,
    });
  });

  it('wires the authoritative repair_queue reader with the handler workspace', async () => {
    checkM.mockResolvedValue({ decision: 'allow', matched: [] } as never);
    frozenM.classify.mockReturnValue({
      kind: 'canonical-root-test',
      operation: 'canonical-verification',
      selectionSource: 'effective-checkout-head',
      checkoutCwd: '/repo',
    });
    frozenM.evaluate.mockResolvedValue({
      allowed: true,
      reason: 'no-frozen-queue',
      classification: null,
      policy: null,
    });

    await tool.handler(
      { command: 'npm test', cwd: '/repo' } as ToolArgs,
      { workspaceId: 'ws-live' } as ToolContext,
    );

    const probe = frozenM.evaluate.mock.calls[0]?.[2] as {
      readFrozenRepairQueue?: () => Promise<unknown>;
    };
    expect(probe.readFrozenRepairQueue).toEqual(expect.any(Function));
    await probe.readFrozenRepairQueue?.();
    expect(queueIo.read).toHaveBeenCalledWith({
      workspaceId: 'ws-live',
      installSlug: expect.any(String),
    });
  });
});

describe('substitution verdict fold (P-015)', () => {
  it('reports the matched registry row and its tier alongside the lock verdict', async () => {
    checkM.mockResolvedValue({ decision: 'allow', matched: [] } as never);
    rowsM.mockResolvedValue([sedRow]);

    const out = body((await tool.handler(
      { command: "cd /repo && sed -n '1,40p' a.ts" } as never, {} as never,
    )) as Out);

    expect(out.substitutionTier).toBe('advise');
    expect(out.substitutions).toHaveLength(1);
    expect(out.substitutions[0]).toMatchObject({
      intentLabel: 'file-range-read',
      toolName: 'capability:read',
      atom: "sed -n '1,40p' a.ts",
    });
  });

  it('does not expose engineering advisories to a non-engineering identity', async () => {
    checkM.mockResolvedValue({ decision: 'allow', matched: [] } as never);
    rowsM.mockResolvedValue([sedRow]);
    identityM.wears.mockReturnValue(false);

    const out = body((await tool.handler({ command: "sed -n '1,40p' a.ts" } as never, {} as never)) as Out);
    expect(out.substitutions).toEqual([]);
    expect(out.substitutionTier).toBeNull();
  });

  it('NEVER lets a substitution match change the lock decision', async () => {
    // Existing consumers key on `decision === 'block'`. A registry row about
    // `cat` has nothing to say about whether a peer is mid-migration, and
    // conflating them would give a routine advisory a resource gate's power.
    checkM.mockResolvedValue({ decision: 'allow', matched: [] } as never);
    rowsM.mockResolvedValue([{ ...sedRow, tier: 'deny' as const }]);

    const out = body((await tool.handler({ command: "sed -n '1,40p' a.ts" } as never, {} as never)) as Out);
    expect(out.decision).toBe('allow');
    expect(out.substitutionTier).toBe('deny');
  });

  it('fails open: a registry read error yields no substitutions but keeps the lock verdict', async () => {
    checkM.mockResolvedValue({ decision: 'block', matched: ['dev-server'] } as never);
    rowsM.mockRejectedValue(new Error('pg down'));

    const out = body((await tool.handler({ command: "sed -n '1,40p' a.ts" } as never, {} as never)) as Out);
    expect(out).toMatchObject({ ok: true, decision: 'block', substitutions: [], substitutionTier: null });
  });

  it('scopes the registry read to the caller workspace when ctx carries one', async () => {
    checkM.mockResolvedValue({ decision: 'allow', matched: [] } as never);
    await tool.handler({ command: 'ls' } as never, { workspaceId: 'other-ws' } as never);
    expect(rowsM).toHaveBeenCalledWith('other-ws');
  });

  it('falls back to the active workspace for a wildcard/absent ctx scope', async () => {
    checkM.mockResolvedValue({ decision: 'allow', matched: [] } as never);
    await tool.handler({ command: 'ls' } as never, { workspaceId: '*' } as never);
    expect(rowsM).toHaveBeenCalledWith('ws');
  });

  it('uses the handler cwd to exempt an install in an independent tree', async () => {
    checkM.mockResolvedValue({ decision: 'allow', matched: [] } as CheckVerdict);
    rowsM.mockResolvedValue([dependencyRow]);

    const out = body((await tool.handler(
      { command: 'npm install', cwd: '/tmp/wi204040-scratch' } as never,
      {} as never,
    )) as Out);

    expect(out.substitutions).toEqual([]);
    expect(out.substitutionTier).toBeNull();
  });

  it('keeps the deny for an install in the canonical file-lock tree', async () => {
    checkM.mockResolvedValue({ decision: 'allow', matched: [] } as CheckVerdict);
    rowsM.mockResolvedValue([dependencyRow]);

    const out = body((await tool.handler(
      { command: 'npm install', cwd: fileLockCoordinationDomain() } as never,
      {} as never,
    )) as Out);

    expect(out.substitutions).toHaveLength(1);
    expect(out.substitutionTier).toBe('deny');
  });
});
