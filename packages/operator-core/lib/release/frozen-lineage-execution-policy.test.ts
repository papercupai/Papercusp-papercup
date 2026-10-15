import { homedir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { currentBuildTestRoute } from '../serving-runtimes';
import {
  assessFrozenLineageLaunchCas,
  type FrozenRepairQueuePreflight,
} from './checkpoint-required-ancestor';
import type { FrozenRepairEditMarker } from './frozen-repair-edit-marker';
import {
  compareFrozenLineageIdentity,
  classifyFrozenLineageShellCommand,
  detectUnsafeFrozenCarryInstruction,
  evaluateFrozenLineageShellCommand,
  evaluateFrozenLineagePolicy,
  evaluateFrozenLineageCarryText,
  frozenLineageCarryViolationPayload,
  frozenLineageShellCommandViolationPayload,
  frozenLineageIdentityFromQueue,
  frozenLineageIdentityFromMarker,
  frozenLineageIdentityMatches,
  isUnsafeFrozenCandidateSource,
  renderFrozenLineageCarryRefusal,
  renderFrozenLineagePolicyRefusal,
  renderFrozenLineageShellCommandRefusal,
  type FrozenLineageIdentity,
} from './frozen-lineage-execution-policy';

const CANDIDATE = 'c'.repeat(40);
const REPAIR_HEAD = 'r'.repeat(40);
const REVISION = 1_788_763_360_000;

const marker = (overrides: Partial<FrozenRepairEditMarker> = {}): FrozenRepairEditMarker => ({
  candidate: CANDIDATE,
  repairHead: REPAIR_HEAD,
  phase: 'repair-in-progress',
  failingPaths: [],
  updatedAtMs: REVISION,
  admittedPaths: [],
  legs: [],
  ...overrides,
});

const identity = (overrides: Partial<FrozenLineageIdentity> = {}): FrozenLineageIdentity => ({
  candidate: CANDIDATE,
  repairHead: REPAIR_HEAD,
  queueRevision: REVISION,
  ...overrides,
});

const launchPreflight = (
  overrides: Partial<FrozenRepairQueuePreflight> = {},
): FrozenRepairQueuePreflight => ({
  proceed: true,
  reason: 'clear',
  candidate: REPAIR_HEAD,
  candidateSource: 'frozen-repair-queue',
  repairQueue: null,
  frozenLineageIdentity: identity(),
  queueDecision: 'verify-repair',
  nextAttempt: null,
  fixerSpawnId: null,
  fixerAlive: false,
  ...overrides,
});

describe('frozen lineage identity', () => {
  it('projects the authoritative repair_queue identity fields', () => {
    expect(
      frozenLineageIdentityFromQueue({
        candidate: CANDIDATE,
        repairHead: REPAIR_HEAD,
        updatedAtMs: REVISION,
      }),
    ).toEqual(identity());
  });

  it('projects the queue update stamp as the typed queue revision', () => {
    expect(frozenLineageIdentityFromMarker(marker())).toEqual(identity());
  });

  it.each([
    ['candidate', identity({ candidate: 'd'.repeat(40) })],
    ['repairHead', identity({ repairHead: 's'.repeat(40) })],
    ['queueRevision', identity({ queueRevision: REVISION + 1 })],
  ] as const)('reports a one-field %s mismatch', (field, actual) => {
    expect(compareFrozenLineageIdentity(identity(), actual)).toMatchObject({
      matches: false,
      mismatchedFields: [field],
    });
    expect(frozenLineageIdentityMatches(identity(), actual)).toBe(false);
  });

  it('accepts only an exact three-field identity match', () => {
    expect(compareFrozenLineageIdentity(identity(), identity())).toMatchObject({
      matches: true,
      mismatchedFields: [],
    });
    expect(frozenLineageIdentityMatches(identity(), identity())).toBe(true);
  });
});

describe('frozen lineage execution policy', () => {
  it('allows ordinary staging work and explicit repair admission while the queue is frozen', () => {
    for (const operation of ['ordinary-edit', 'focused-test', 'repair-admission'] as const) {
      expect(
        evaluateFrozenLineagePolicy({ operation, selectionSource: 'staging' }, { marker: marker() }),
      ).toMatchObject({ allowed: true, reason: 'operation-not-governed' });
    }
  });

  it.each(['staging', 'current-head', 'integration-branch', 'caller-selected-sha'] as const)(
    'refuses governed candidate selection from %s even when its SHA happens to match repairHead',
    (selectionSource) => {
      const verdict = evaluateFrozenLineagePolicy(
        {
          operation: 'candidate-selection',
          selectionSource,
          checkoutHead: REPAIR_HEAD,
          expectedIdentity: identity(),
        },
        { marker: marker() },
      );
      expect(verdict).toMatchObject({ allowed: false, reason: 'unsafe-candidate-source' });
      expect(isUnsafeFrozenCandidateSource(selectionSource)).toBe(true);
    },
  );

  it('fails closed when a governed source is unknown', () => {
    expect(
      evaluateFrozenLineagePolicy(
        { operation: 'canonical-verification', selectionSource: 'unknown' },
        { marker: marker() },
      ),
    ).toMatchObject({ allowed: false, reason: 'selection-source-unknown' });
  });

  it('requires a captured identity and effective checkout HEAD', () => {
    expect(
      evaluateFrozenLineagePolicy(
        {
          operation: 'canonical-verification',
          selectionSource: 'live-repair-head',
          checkoutHead: REPAIR_HEAD,
        },
        { marker: marker() },
      ),
    ).toMatchObject({ allowed: false, reason: 'queue-identity-required' });

    expect(
      evaluateFrozenLineagePolicy(
        {
          operation: 'canonical-verification',
          selectionSource: 'live-repair-head',
          expectedIdentity: identity(),
        },
        { marker: marker() },
      ),
    ).toMatchObject({ allowed: false, reason: 'checkout-head-required' });
  });

  it.each([
    ['candidate', identity({ candidate: 'd'.repeat(40) })],
    ['repairHead', identity({ repairHead: 's'.repeat(40) })],
    ['queueRevision', identity({ queueRevision: REVISION - 1 })],
  ] as const)('refuses a stale captured %s before launch', (field, expectedIdentity) => {
    expect(
      evaluateFrozenLineagePolicy(
        {
          operation: 'canonical-verification',
          selectionSource: 'live-repair-head',
          checkoutHead: REPAIR_HEAD,
          expectedIdentity,
        },
        { marker: marker() },
      ),
    ).toMatchObject({
      allowed: false,
      reason: 'queue-identity-mismatch',
      mismatchedIdentityFields: [field],
    });
  });

  it('refuses a checkout that is not the current repairHead', () => {
    expect(
      evaluateFrozenLineagePolicy(
        {
          operation: 'canonical-verification',
          selectionSource: 'effective-checkout-head',
          checkoutHead: CANDIDATE,
          expectedIdentity: identity(),
        },
        { marker: marker() },
      ),
    ).toMatchObject({ allowed: false, reason: 'checkout-head-mismatch' });
  });

  it.each(['live-repair-head', 'effective-checkout-head'] as const)(
    'allows an exact current repairHead launch selected via %s',
    (selectionSource) => {
      expect(
        evaluateFrozenLineagePolicy(
          {
            operation: 'canonical-verification',
            selectionSource,
            checkoutHead: REPAIR_HEAD,
            expectedIdentity: identity(),
          },
          { marker: marker() },
        ),
      ).toMatchObject({ allowed: true, reason: 'repair-head-match' });
    },
  );

  it('allows the ordinary moving-tip regime when no frozen marker exists', () => {
    expect(
      evaluateFrozenLineagePolicy({ operation: 'candidate-selection', selectionSource: 'staging' }, { marker: null }),
    ).toMatchObject({ allowed: true, reason: 'no-frozen-queue', liveIdentity: null });
  });

  it('renders every refusal with the full queue identity, unsafe source, and sanctioned route', () => {
    const verdict = evaluateFrozenLineagePolicy(
      {
        operation: 'canonical-verification',
        selectionSource: 'current-head',
        checkoutHead: CANDIDATE,
        expectedIdentity: identity(),
      },
      { marker: marker() },
    );
    const rendered = renderFrozenLineagePolicyRefusal(verdict);
    expect(rendered).toContain(`candidate=${CANDIDATE}`);
    expect(rendered).toContain(`repairHead=${REPAIR_HEAD}`);
    expect(rendered).toContain(`queueRevision=${REVISION}`);
    expect(rendered).toContain("source 'current-head'");
    expect(rendered).toContain("release:repair-queue { op:'admit', paths:[...] }");
  });
});

describe('frozen lineage shell-command policy', () => {
  const ROOT = '/repo/papercusp';

  it.each([
    ['npm test', 'canonical-root-test', 'effective-checkout-head'],
    ['npm run test:affected -- --changed-paths=a.ts', 'canonical-root-test', 'effective-checkout-head'],
    ['node scripts/affected-tests.mjs --integration', 'canonical-root-test', 'effective-checkout-head'],
    ['git worktree add --detach /tmp/candidate staging', 'candidate-worktree-cut', 'staging'],
    ['git -C /repo/papercusp worktree add --detach /tmp/candidate HEAD', 'candidate-worktree-cut', 'current-head'],
  ] as const)('classifies %s as %s from %s', (command, kind, selectionSource) => {
    expect(classifyFrozenLineageShellCommand({ command, cwd: ROOT })).toMatchObject({ kind, selectionSource });
  });

  it.each([
    ['--dry'],
    ['--dry-run'],
    ['--print-affected'],
  ] as const)('leaves affected-tests plan probes outside frozen verification: %s', async (flag) => {
    const command = `node scripts/affected-tests.mjs --changed-paths libs/papercusp --base HEAD^ ${flag}`;
    const readMarker = vi.fn(() => marker());
    const readCheckoutHead = vi.fn(async () => CANDIDATE);
    const classification = classifyFrozenLineageShellCommand({ command, cwd: ROOT });

    expect(classification).toBeNull();
    await expect(
      evaluateFrozenLineageShellCommand(classification, ROOT, { readMarker, readCheckoutHead }),
    ).resolves.toMatchObject({ allowed: true, reason: 'operation-not-governed' });
    expect(readMarker).not.toHaveBeenCalled();
    expect(readCheckoutHead).not.toHaveBeenCalled();
  });

  it.each([
    'npm run test:file -- packages/operator-core/lib/a.test.ts',
    'npx vitest run packages/operator-core/lib/a.test.ts',
    'ptool release:repair-queue --json - <<JSON\n{"op":"admit","paths":["a.ts"]}\nJSON',
    'git status --short',
  ])('keeps focused/ordinary/repair work outside the governed set: %s', (command) => {
    expect(classifyFrozenLineageShellCommand({ command, cwd: ROOT })).toBeNull();
  });

  // Regression: an atom shellWords cannot tokenise must be UNCLASSIFIED, not
  // governed-with-unknown-cwd. Classifying it forced `applies` true while leaving
  // readCheckoutHead unreachable (it is skipped when checkoutCwd is falsy), so
  // 'checkout-head-required' fired and could never be satisfied by any caller.
  // Blast radius: every agent on the box lost its shell for the duration of a
  // freeze -- including ones working only in /tmp -- because an apostrophe in a
  // grep pattern is an unbalanced quote.
  it.each([
    [`grep -r don't /tmp/scratch`, 'unbalanced single quote'],
    ['echo hello \\', 'trailing escape'],
    [`sed -n 's/a/b/p' "unterminated`, 'unterminated double quote'],
  ])('leaves an untokenisable atom unclassified (%s -- %s)', (command) => {
    expect(classifyFrozenLineageShellCommand({ command, cwd: '/tmp/scratch' })).toBeNull();
    expect(classifyFrozenLineageShellCommand({ command, cwd: ROOT })).toBeNull();
  });

  it('does not refuse an untokenisable command that never touches the governed tree', async () => {
    const readMarker = vi.fn(() => marker());
    const readCheckoutHead = vi.fn(async () => REPAIR_HEAD);
    const classification = classifyFrozenLineageShellCommand({
      command: `grep -r don't /tmp/scratch`,
      cwd: '/tmp/scratch',
    });
    await expect(
      evaluateFrozenLineageShellCommand(classification, ROOT, { readMarker, readCheckoutHead }),
    ).resolves.toMatchObject({ allowed: true, reason: 'operation-not-governed' });
    expect(readMarker).not.toHaveBeenCalled();

    // Positive control -- the guard is still live, so the assertion above cannot
    // pass merely because the policy went inert.
    const governed = classifyFrozenLineageShellCommand({ command: 'npm test', cwd: ROOT });
    await expect(
      evaluateFrozenLineageShellCommand(governed, ROOT, {
        marker: marker(),
        readCheckoutHead: async () => CANDIDATE,
      }),
    ).resolves.toMatchObject({ allowed: false, reason: 'checkout-head-mismatch' });
  });

  it('distinguishes package-local npm test from a root test after a literal cd', async () => {
    const classification = classifyFrozenLineageShellCommand({
      command: 'cd packages/operator-core && npm test',
      cwd: ROOT,
    });
    const readMarker = vi.fn(() => marker());
    const readCheckoutHead = vi.fn(async () => CANDIDATE);
    expect(classification).toMatchObject({
      kind: 'canonical-root-test',
      checkoutCwd: `${ROOT}/packages/operator-core`,
    });
    await expect(
      evaluateFrozenLineageShellCommand(classification, ROOT, { readMarker, readCheckoutHead }),
    ).resolves.toMatchObject({ allowed: true, reason: 'operation-not-governed' });
    expect(readMarker).not.toHaveBeenCalled();
    expect(readCheckoutHead).not.toHaveBeenCalled();
  });

  it('keeps ordinary commands on the zero-marker, zero-Git hot path', async () => {
    const readMarker = vi.fn(() => marker());
    const readCheckoutHead = vi.fn(async () => CANDIDATE);
    await expect(
      evaluateFrozenLineageShellCommand(null, ROOT, { readMarker, readCheckoutHead }),
    ).resolves.toMatchObject({ allowed: true, reason: 'operation-not-governed' });
    expect(readMarker).not.toHaveBeenCalled();
    expect(readCheckoutHead).not.toHaveBeenCalled();
  });

  it('refuses a canonical root test whose effective checkout is not repairHead', async () => {
    const classification = classifyFrozenLineageShellCommand({ command: 'npm test', cwd: ROOT });
    const readCheckoutHead = vi.fn(async () => CANDIDATE);
    const verdict = await evaluateFrozenLineageShellCommand(classification, ROOT, {
      marker: marker(),
      readCheckoutHead,
    });
    expect(verdict).toMatchObject({ allowed: false, reason: 'checkout-head-mismatch' });
    expect(readCheckoutHead).toHaveBeenCalledOnce();
    expect(renderFrozenLineageShellCommandRefusal(verdict)).toContain(`repairHead=${REPAIR_HEAD}`);
    expect(frozenLineageShellCommandViolationPayload(verdict)).toMatchObject({
      ok: false,
      error: 'frozen_candidate_lineage_violation',
      commandKind: 'canonical-root-test',
      unsafeSource: 'effective-checkout-head',
      checkoutHead: CANDIDATE,
    });
  });

  it('allows a canonical root test only at the exact live repairHead', async () => {
    const classification = classifyFrozenLineageShellCommand({ command: 'npm run test:affected', cwd: ROOT });
    await expect(
      evaluateFrozenLineageShellCommand(classification, ROOT, {
        marker: marker(),
        readCheckoutHead: async () => REPAIR_HEAD,
      }),
    ).resolves.toMatchObject({ allowed: true, reason: 'repair-head-match' });
  });

  it('uses authoritative repair_queue identity instead of a stale marker projection', async () => {
    const readMarker = vi.fn(() => marker({ repairHead: CANDIDATE, updatedAtMs: REVISION - 1 }));
    const readFrozenRepairQueue = vi.fn(async () => ({
      candidate: CANDIDATE,
      repairHead: REPAIR_HEAD,
      updatedAtMs: REVISION,
      phase: 'ready-to-verify',
    }));
    const classification = classifyFrozenLineageShellCommand({ command: 'npm test', cwd: ROOT });

    await expect(
      evaluateFrozenLineageShellCommand(classification, ROOT, {
        readMarker,
        readFrozenRepairQueue,
        readCheckoutHead: async () => REPAIR_HEAD,
      }),
    ).resolves.toMatchObject({ allowed: true, reason: 'repair-head-match' });
    expect(readFrozenRepairQueue).toHaveBeenCalledTimes(2);
    expect(readMarker).not.toHaveBeenCalled();
  });

  it('treats authoritative ready-to-test as inactive even with a stale marker', async () => {
    const readMarker = vi.fn(() => marker());
    const readFrozenRepairQueue = vi.fn(async () => ({
      candidate: CANDIDATE,
      repairHead: REPAIR_HEAD,
      updatedAtMs: REVISION,
      phase: 'ready-to-test',
    }));
    const readCheckoutHead = vi.fn(async () => REPAIR_HEAD);

    await expect(
      evaluateFrozenLineageShellCommand(classifyFrozenLineageShellCommand({ command: 'npm test', cwd: ROOT }), ROOT, {
        readMarker,
        readFrozenRepairQueue,
        readCheckoutHead,
      }),
    ).resolves.toMatchObject({ allowed: true, reason: 'no-frozen-queue' });
    expect(readFrozenRepairQueue).toHaveBeenCalledOnce();
    expect(readMarker).not.toHaveBeenCalled();
    expect(readCheckoutHead).not.toHaveBeenCalled();
  });

  it('refuses a governed test when the effective checkout cwd is unresolved', async () => {
    const classification = classifyFrozenLineageShellCommand({ command: 'cd "$UNKNOWN_CWD" && npm test', cwd: ROOT });
    const readCheckoutHead = vi.fn(async () => REPAIR_HEAD);

    expect(classification).toMatchObject({
      kind: 'canonical-root-test',
      checkoutCwd: null,
    });
    await expect(
      evaluateFrozenLineageShellCommand(classification, ROOT, {
        marker: marker(),
        readCheckoutHead,
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: 'checkout-cwd-unresolved',
      policy: { sanctionedRoute: expect.stringContaining('explicit absolute cwd') },
    });
    expect(readCheckoutHead).not.toHaveBeenCalled();
  });

  // P-015 (plan green-main-cycle-time-2026-10-08): `cd X || exit 1` is the idiom
  // CLAUDE.md prescribes, and its fallback never continues — so every later atom
  // runs in X. The tracker used to fall back to the session cwd after `||`, which
  // governed a SIBLING checkout's `npm test` as a papercusp root test.
  it.each([
    'cd /tmp/crm || exit 1; npm test',
    'cd /tmp/crm || exit 1\nnpm run test:affected',
    'cd /tmp/crm || return 2; npm test',
    'cd /tmp/crm || { echo "no checkout"; exit 1; }; npm test',
    'cd /tmp/crm || { exit 1; }; npm test',
  ])('resolves a terminating cd fallback to the cd target: %s', async (command) => {
    const readMarker = vi.fn(() => marker());
    const readCheckoutHead = vi.fn(async () => CANDIDATE);
    const classification = classifyFrozenLineageShellCommand({ command, cwd: ROOT });

    expect(classification).toMatchObject({ kind: 'canonical-root-test', checkoutCwd: '/tmp/crm' });
    await expect(
      evaluateFrozenLineageShellCommand(classification, ROOT, { readMarker, readCheckoutHead }),
    ).resolves.toMatchObject({ allowed: true, reason: 'operation-not-governed' });
    expect(readMarker).not.toHaveBeenCalled();
    expect(readCheckoutHead).not.toHaveBeenCalled();
  });

  it.each([
    // The governed root itself, reached through the same idiom, stays governed.
    [`cd ${ROOT} || exit 1; npm test`, ROOT],
    // A fallback that CONTINUES leaves later atoms where the failed cd left them.
    ['cd /tmp/crm || echo failed; npm test', ROOT],
    // `( exit 1 )` only ends a subshell, so it is not a terminating fallback.
    ['cd /tmp/crm || (exit 1); npm test', ROOT],
  ])('keeps a root test governed when the cd fallback does not prove the move: %s', async (command, cwd) => {
    const classification = classifyFrozenLineageShellCommand({ command, cwd: ROOT });
    expect(classification).toMatchObject({ kind: 'canonical-root-test', checkoutCwd: cwd });
    await expect(
      evaluateFrozenLineageShellCommand(classification, ROOT, {
        marker: marker(),
        readCheckoutHead: async () => CANDIDATE,
      }),
    ).resolves.toMatchObject({ allowed: false, reason: 'checkout-head-mismatch' });
  });

  // P-015: a literal assignment earlier in the same command makes "$R" knowable.
  // Treating every `$` as unresolvable failed closed on a sibling repo's worktree cut.
  it.each([
    ['R=/tmp/pilot; git -C "$R" worktree add --detach /tmp/w staging', '/tmp/pilot'],
    ['export R=/tmp/pilot && git -C "${R}" worktree add /tmp/w staging', '/tmp/pilot'],
    ['R=/tmp/pilot; B="$R/sub"; git -C $B worktree add /tmp/w staging', '/tmp/pilot/sub'],
  ])('resolves a known literal variable in a worktree-cut -C target: %s', async (command, cwd) => {
    const readMarker = vi.fn(() => marker());
    const classification = classifyFrozenLineageShellCommand({ command, cwd: ROOT });

    expect(classification).toMatchObject({ kind: 'candidate-worktree-cut', checkoutCwd: cwd });
    await expect(evaluateFrozenLineageShellCommand(classification, ROOT, { readMarker })).resolves.toMatchObject({
      allowed: true,
      reason: 'operation-not-governed',
    });
    expect(readMarker).not.toHaveBeenCalled();
  });

  // EI-25213458345089181: `cd ~/.papercusp-workspaces/clones/<pot> && npm test` failed
  // closed because `~` was treated as unknowable. The command's shell runs as the same
  // user, so `~/…` and `$HOME/…` are the operator user's home.
  it.each([
    'cd ~/.papercusp-workspaces/clones/pot-review-pilot && npm test',
    'cd "$HOME/.papercusp-workspaces/clones/pot-review-pilot" || exit 1; npm test',
  ])('resolves a home-relative cd target: %s', (command) => {
    expect(classifyFrozenLineageShellCommand({ command, cwd: ROOT })).toMatchObject({
      kind: 'canonical-root-test',
      checkoutCwd: `${homedir()}/.papercusp-workspaces/clones/pot-review-pilot`,
    });
  });

  it('keeps ~user and a reassigned HOME unknowable', () => {
    expect(classifyFrozenLineageShellCommand({ command: 'cd ~other/x && npm test', cwd: ROOT })).toMatchObject({
      checkoutCwd: null,
    });
    expect(
      classifyFrozenLineageShellCommand({ command: 'HOME=$(mktemp -d); cd "$HOME" && npm test', cwd: ROOT }),
    ).toMatchObject({ checkoutCwd: null });
  });

  it('resolves a known literal variable in a cd target, governing the root when it names the root', () => {
    expect(
      classifyFrozenLineageShellCommand({ command: 'D=/tmp/crm; cd "$D" || exit 1; npm test', cwd: ROOT }),
    ).toMatchObject({ checkoutCwd: '/tmp/crm' });
    expect(
      classifyFrozenLineageShellCommand({ command: `D=${ROOT}; cd "$D" || exit 1; npm test`, cwd: ROOT }),
    ).toMatchObject({ checkoutCwd: ROOT });
  });

  it.each([
    // Single quotes suppress expansion.
    "R=/tmp/pilot; git -C '$R' worktree add /tmp/w staging",
    // Reassigned to something unknowable: the stale literal must be forgotten.
    'R=/tmp/pilot; R=$(pwd); git -C "$R" worktree add /tmp/w staging',
    'R=/tmp/pilot; unset R; git -C "$R" worktree add /tmp/w staging',
    'R=/tmp/pilot; read R; git -C "$R" worktree add /tmp/w staging',
    // An env-prefix assignment does not set the shell variable used for expansion.
    'R=/tmp/pilot git -C "$R" worktree add /tmp/w staging',
    // Never assigned in this command at all.
    'git -C "$UNKNOWN" worktree add /tmp/w staging',
  ])('fails closed when a variable target is not provably known: %s', async (command) => {
    const classification = classifyFrozenLineageShellCommand({ command, cwd: ROOT });
    expect(classification).toMatchObject({ kind: 'candidate-worktree-cut', checkoutCwd: null });
    await expect(
      evaluateFrozenLineageShellCommand(classification, ROOT, { marker: marker() }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('refuses a staging worktree cut without paying for a Git HEAD probe', async () => {
    const classification = classifyFrozenLineageShellCommand({
      command: 'git worktree add --detach /tmp/candidate staging',
      cwd: ROOT,
    });
    const readCheckoutHead = vi.fn(async () => CANDIDATE);
    const verdict = await evaluateFrozenLineageShellCommand(classification, ROOT, {
      marker: marker(),
      readCheckoutHead,
    });
    expect(verdict).toMatchObject({ allowed: false, reason: 'unsafe-candidate-source' });
    expect(readCheckoutHead).not.toHaveBeenCalled();
    expect(frozenLineageShellCommandViolationPayload(verdict)).toMatchObject({
      commandKind: 'candidate-worktree-cut',
      unsafeSource: 'staging',
      selectedRef: 'staging',
    });
  });

  it('fails closed when the marker identity changes during the HEAD probe', async () => {
    const classification = classifyFrozenLineageShellCommand({ command: 'npm test', cwd: ROOT });
    const markers = [marker(), marker({ repairHead: 's'.repeat(40), updatedAtMs: REVISION + 1 })];
    const verdict = await evaluateFrozenLineageShellCommand(classification, ROOT, {
      readMarker: () => markers.shift() ?? null,
      readCheckoutHead: async () => REPAIR_HEAD,
    });
    expect(verdict).toMatchObject({ allowed: false, reason: 'queue-identity-mismatch' });
    expect(verdict.policy).toMatchObject({ mismatchedIdentityFields: ['repairHead', 'queueRevision'] });
  });

  it('allows the moving-tip regime when no frozen marker exists', async () => {
    const readCheckoutHead = vi.fn(async () => CANDIDATE);
    await expect(
      evaluateFrozenLineageShellCommand(classifyFrozenLineageShellCommand({ command: 'npm test', cwd: ROOT }), ROOT, {
        marker: null,
        readCheckoutHead,
      }),
    ).resolves.toMatchObject({ allowed: true, reason: 'no-frozen-queue' });
    expect(readCheckoutHead).not.toHaveBeenCalled();
  });
});

describe('frozen lineage launch CAS', () => {
  it('allows only an exact second-read identity at the selected repairHead', () => {
    expect(assessFrozenLineageLaunchCas(identity(), launchPreflight(), REPAIR_HEAD)).toMatchObject({
      allowed: true,
      reason: 'repair-head-match',
      expectedIdentity: identity(),
      liveIdentity: identity(),
      checkoutHead: REPAIR_HEAD,
      mismatchedIdentityFields: [],
    });
  });

  it.each([
    ['candidate', identity({ candidate: 'd'.repeat(40) })],
    ['repairHead', identity({ repairHead: 's'.repeat(40) })],
    ['queueRevision', identity({ queueRevision: REVISION + 1 })],
  ] as const)('refuses a second-read %s mismatch before launch', (field, liveIdentity) => {
    const verdict = assessFrozenLineageLaunchCas(
      identity(),
      launchPreflight({ frozenLineageIdentity: liveIdentity }),
      REPAIR_HEAD,
    );

    expect(verdict).toMatchObject({
      allowed: false,
      reason: 'queue-identity-mismatch',
      expectedIdentity: identity(),
      liveIdentity,
      mismatchedIdentityFields: [field],
    });
    expect(verdict.detail).toContain(`candidate=${liveIdentity.candidate}`);
    expect(verdict.detail).toContain(`repairHead=${liveIdentity.repairHead}`);
    expect(verdict.detail).toContain(`queueRevision=${liveIdentity.queueRevision}`);
  });

  it('treats queue appearance, disappearance, and unreadability as failed CAS outcomes', () => {
    expect(assessFrozenLineageLaunchCas(null, launchPreflight(), REPAIR_HEAD)).toMatchObject({
      allowed: false,
      reason: 'queue-appeared',
      mismatchedIdentityFields: ['candidate', 'repairHead', 'queueRevision'],
    });
    expect(
      assessFrozenLineageLaunchCas(
        identity(),
        launchPreflight({ frozenLineageIdentity: null, candidate: null, queueDecision: 'run-normal-gate' }),
        REPAIR_HEAD,
      ),
    ).toMatchObject({
      allowed: false,
      reason: 'queue-disappeared',
      mismatchedIdentityFields: ['candidate', 'repairHead', 'queueRevision'],
    });
    expect(
      assessFrozenLineageLaunchCas(
        identity(),
        launchPreflight({
          proceed: false,
          reason: 'queue-unreadable',
          frozenLineageIdentity: null,
          queueDecision: null,
          detail: 'parse failed',
        }),
        REPAIR_HEAD,
      ),
    ).toMatchObject({ allowed: false, reason: 'queue-unreadable' });
  });

  it('refuses an exact identity when the checkout or queue disposition is not runnable', () => {
    expect(assessFrozenLineageLaunchCas(identity(), launchPreflight(), CANDIDATE)).toMatchObject({
      allowed: false,
      reason: 'checkout-head-mismatch',
    });
    expect(
      assessFrozenLineageLaunchCas(
        identity(),
        launchPreflight({ proceed: false, reason: 'repair-in-progress', queueDecision: 'wait-for-fixer' }),
        REPAIR_HEAD,
      ),
    ).toMatchObject({ allowed: false, reason: 'queue-not-runnable' });
  });
});

describe('frozen lineage carry policy', () => {
  it.each([
    ['staging', 'Then pin whatever `staging` resolves to at that instant, still never a quoted sha.'],
    ['current-head', 'Create the canonical verification worktree pinned to current HEAD and run the root test.'],
    ['current-head', 'It is not only selecting current-head as the judged candidate; also run the suite there.'],
    ['integration-branch', 'Use integrationBranch as the judged candidate for the canonical verdict.'],
    ['staging', 'Create the canonical verification worktree on staging and run the root test.'],
  ] as const)('detects a positive %s candidate instruction', (unsafeSource, text) => {
    expect(detectUnsafeFrozenCarryInstruction(text)).toMatchObject({ unsafeSource });
  });

  it.each([
    'Run focused unit tests on staging while the repair is admitted separately.',
    'Canonical tree is the shared checkout root on staging.',
    'Main editable tree measured by git status/worktree list is /workspace/papercusp on staging.',
    'The git worktree list shows the editable checkout on staging.',
    'Frozen candidate is 09d0c118d5df, 32 commits behind staging.',
    'gap-3 source is NOT in frozen candidate d4946901 / repairHead 87d557e7 (0 hits each) but IS on staging (4 hits each).',
    'The frozen candidate is 32 commits behind origin/staging; repair admission remains the sanctioned route.',
    'The candidate is 2 commits ahead of staging.',
    'The candidate is stale vs staging and must be repaired on the frozen lineage.',
    'The candidate is 4 commits behind staging relative to the last repair head.',
    'The candidate is compared with staging for staleness only.',
    'Ordinary staging work remains legal — The policy blocks selecting staging as the judged candidate...',
    'Ordinary staging work remains legal: The policy blocks selecting staging as the judged candidate.',
    'The earlier instruction to pin current staging/current HEAD was wrong and is retracted.',
    'Never derive the judged candidate from staging; use the live repairHead.',
    'I am NOT selecting current-head as the judged candidate',
    'It classified the sentence as selecting staging for the judged frozen candidate, although the note gave no instruction to judge or release staging.',
    'A checkpoint that instructs a successor to use current HEAD as the judged candidate is rejected.',
    'The policy refuses candidate selection from integrationBranch.',
    'The refusal says staging was selected as the judged candidate; this sentence describes the diagnostic, not a directive.',
    'A carry row describing the refusal contains selecting staging as the judged candidate.',
    'The frozen-candidate lineage guard reads as selecting staging as the judged candidate while explaining the refusal.',
    'The candidate fix is uncommitted and no approved staging route has been provided.',
    'The release checkpoint receipt explicitly reported that quiet-cut excluded unrelated newer staging commits and judged repairHead 7968c0cf.',
    'The checkpoint receipt says quiet-cut excluded unrelated newer staging commits; the judged repairHead was 7968c0cf.',
    'current-build verification on staging is available — re-check: curl http://127.0.0.1:3170/api/desktop/version',
    'staging availability for current-build verification — re-check: curl :3170',
    'staging is available for current-build verification — re-check: curl :3170',
  ])('allows ordinary, negated, or corrective prose: %s', (text) => {
    expect(detectUnsafeFrozenCarryInstruction(text)).toBeNull();
  });

  it.each([
    'Blob compare b72f26b6 vs staging: test file DIFF only for apps/operator-vite/dist-atomic-writes.test.ts.',
    'Test-file blobs at repairHead b72f26b6 differ from the working tree only for apps/operator-vite/dist-atomic-writes.test.ts.',
    'On the judged lineage, only these red test files have since been edited: apps/operator-vite/dist-atomic-writes.test.ts.',
    'Worktree remains on staging while the unrelated local check is investigated.',
    // EI-25213563657815886: a pot-git design decision describing a p2p MEMBER worktree
    // that diverged from hive staging was refused (build d740fc3802). "worktree" there is
    // a member checkout, not the judged release worktree.
    'Visible now: when the catch-up sweep finds the worktree diverged from the accepted staging, git-sync computes the conflicting paths with `git merge-tree` (no worktree change), persists them in routines.metadata.worktree_divergence {since, localHead, stagingSha, paths}, logs one warning when a divergence starts or its path set changes, and clears the key when the worktree contains staging again.',
    'when the catch-up sweep finds the worktree diverged from refs/hive/staging',
    // P-015 measured false positives (plan green-main-cycle-time-2026-10-08). Each is a
    // declarative observation with a bare "candidate" and no directive.
    // EI-25339412982747887 — runtime containment evidence on the staging operator.
    'Own maintained operator-api measurements verified staging-operator 7f880aeffb containsChange=true by blob for canonical scratch-gc.ts (b627354f).',
    // EI-25265950105082123 — "candidate" for an unrelated proof-measurement concept.
    'The candidate C is the canonical checkout superproject HEAD (always `staging`).',
    // EI-25241841627586793 — an observation echoing the cell's nextCandidateSha field…
    'The next candidate is now 9548d219 (staging 14:39Z), and it DOES descend from da36b814.',
    // …and a sentence that only DESCRIBES the guard (the relation must end at the nearest
    // "candidate", not run on to the one inside the quoted error code).
    "Carry text naming a staging sha as a 'candidate' is refused with frozen_candidate_lineage_violation.",
    // EI-25229988811743001 — "checkout" as a noun, in prose about the :3170 build directory.
    'It serves a candidate checkout (~/papercupai-workspace/papercusp-staging.generations/.candidate-<sha>) built from a LOCAL staging commit, so a locally committed fix reaches :3170 on the next staging-sync or dev:restart staging.',
    // EI-25697802394733001 — the :3170 staging-sync generation's candidate can be blob-equal
    // to staging without being selected as the green-checkpoint candidate.
    'staging candidate c571e22c9e @15:29Z contains it + all 6 fix files, blob-equal to staging)',
    // The detector must not infer candidate selection from a diagnostic sentence that reports a passing regression.
    'Reproduced the reported :3170 staging-sync candidate text as a passing regression at the current staging HEAD',
    // A directive may use current-build staging-probe evidence to complete an unrelated source item;
    // this is not an instruction to select staging as the frozen judged candidate (EI-25876752493857561).
    'Create and confirm-assignee on the final deployed verification task, add its typed gate blocker, then complete EI-25802391249880249 with root-cause and staging-probe evidence.',
    // EI-25198229614999965 — historical deletion correlation.
    'Root cause of candidate disappearance correlated to staging-sync prune 08:07:17Z, failed native precheck 08:07:14Z.',
  ])('allows descriptive checkpoint forensics without selecting a moving candidate: %s', (text) => {
    expect(detectUnsafeFrozenCarryInstruction(text)).toBeNull();
  });

  it('allows a descriptive green-pin distance measurement without treating pin as an instruction', () => {
    const text =
      'READING: the green pin lacks my fix ONLY because it IS the frozen lineage, 88 commits behind staging';

    expect(detectUnsafeFrozenCarryInstruction(text)).toBeNull();
  });

  it('allows structured operator-api runtime qualification metadata in a carry note', () => {
    const route = currentBuildTestRoute('operator-api');
    expect(route).not.toBeNull();

    const text = JSON.stringify({
      runtimeQualification: {
        currentBuildTestRoute: route,
        observedRuntime: {
          runtime: 'staging-operator',
          port: 3170,
          buildSha: '2a0b600917',
          evidence: 'Measured request/response on that build.',
        },
        staging: {
          runtime: 'staging-operator',
          role: 'owner',
          buildSha: '2a0b600917',
        },
      },
    });

    expect(detectUnsafeFrozenCarryInstruction(text)).toBeNull();
  });

  it('allows a factual current-build SHA attribution without selecting it as the judged candidate', () => {
    expect(
      detectUnsafeFrozenCarryInstruction(
        'Target SHA a906a9a29b1abaf67ce94abccd7ed263e64886a3 is loaded in the staging-operator current build',
      ),
    ).toBeNull();
  });

  it('allows a plain worktree branch-status note without selecting that branch as the judged candidate', () => {
    expect(detectUnsafeFrozenCarryInstruction('Worktree remains on staging.')).toBeNull();
  });

  it('allows verified descriptive prose that says the fixes are on staging', () => {
    const verdict = evaluateFrozenLineageCarryText(
      {
        surface: 'work-item-checkpoint',
        text: 'VERIFIED: the fixes are present on staging; the check still judges the prior frozen repair head.',
        target: null,
      },
      { marker: marker() },
    );

    expect(verdict).toMatchObject({
      allowed: true,
      reason: 'no-unsafe-candidate-instruction',
      liveIdentity: identity(),
    });
  });

  it.each([
    'Select staging as the judged candidate even though it is 32 commits behind the repair head.',
    'Run the canonical verification against staging as the judged candidate.',
    'Pin staging as the candidate for the next verdict.',
    'Cut staging as the judged candidate for the next canonical verdict.',
    'The judged worktree is on staging for the next canonical verdict.',
    // P-015: narrowing to directives must not lose directive forms with a bare "candidate".
    'Re-run the gate with the candidate cut from staging.',
    'Next: use staging as the candidate.',
    'If the gate is red again, run the candidate verification on staging.',
    'The successor should treat staging as the candidate.',
    'The runner will select staging for the candidate.',
    'We judge the judged candidate at staging.',
  ])('still detects an explicit selection or execution instruction: %s', (text) => {
    expect(detectUnsafeFrozenCarryInstruction(text)).toMatchObject({ unsafeSource: 'staging' });
  });

  it('does not pair an unrelated release-cut description with its source-check reference', () => {
    const text =
      'Committing the gitlink would make the worktree clean — and would have broken the next leg: ' +
      "release-local.sh:187-204 binds every cut to ONE full superproject sha (EI-20505417131773854) " +
      "and errors 'release source drift' when current HEAD != the passed sourceSha.";

    expect(detectUnsafeFrozenCarryInstruction(text)).toBeNull();
  });

  it('fails closed with the exact incident identity and actionable repair route', () => {
    const verdict = evaluateFrozenLineageCarryText(
      {
        surface: 'work-item-checkpoint',
        text: 'Then pin whatever staging resolves to at that instant.',
        target: null,
      },
      { marker: marker() },
    );
    expect(verdict).toMatchObject({
      allowed: false,
      errorCode: 'frozen_candidate_lineage_violation',
      unsafeSource: 'staging',
      liveIdentity: identity(),
    });
    const rendered = renderFrozenLineageCarryRefusal(verdict);
    expect(rendered).toContain(`candidate=${CANDIDATE}`);
    expect(rendered).toContain(`repairHead=${REPAIR_HEAD}`);
    expect(rendered).toContain(`queueRevision=${REVISION}`);
    expect(rendered).toContain("source");
    // EI-23481593402791453: a CARRY surface persists prose; it does not launch a run, so
    // the clearing action is to REWORD the text. Asserting only that the message mentions
    // release:repair-queue cannot distinguish prescribing it from explicitly negating it —
    // that assertion stayed green across the very fix that inverted the advice. Pin the
    // remediation itself, so reverting to the launch-time wording fails here.
    expect(rendered).toContain('REWORD the carry text');
    expect(rendered).not.toContain('Select and re-read live repairHead');
    expect(frozenLineageCarryViolationPayload(verdict)).toMatchObject({
      ok: false,
      error: 'frozen_candidate_lineage_violation',
      surface: 'work-item-checkpoint',
    });
  });

  it('allows the same text when no frozen marker exists', () => {
    expect(
      evaluateFrozenLineageCarryText(
        { surface: 'compaction-continuation', text: 'Pin staging as the canonical candidate.', target: null },
        { marker: null },
      ),
    ).toMatchObject({ allowed: true, reason: 'no-frozen-queue' });
  });
});
