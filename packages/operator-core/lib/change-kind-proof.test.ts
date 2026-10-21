/**
 * The change-kind close gate (plan change-kind-declared-proof-2026-10-15, P-002).
 *
 *   R-2 — work_items:complete refuses a successful close that lacks any proof the bundled
 *         catalog lists for a declared kind, naming each missing proof.
 *   R-6 — a close that owes no change-kind reason lands as done once it carries every proof
 *         the catalog lists for each declared kind, for every single kind and multi-kind.
 *   D-001 — a declaration that first arrives at close must carry a reason.
 *   D-003 — a claim taken before the cutover with no declaration closes with a warning.
 *
 * These drive `evaluateChangeKindGate` directly. The handler wiring (stateError, record kept,
 * item left open) is covered in agent-tools/work_items/complete.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { CHANGE_KIND_CATALOG, CHANGE_KINDS, type ChangeKind, type ChangeKindEvidence } from './change-kind-catalog';
import {
  CHANGE_KIND_GATE_CUTOVER,
  claimPredatesChangeKindCutover,
  evaluateChangeKindGate,
  type ChangeKindGateInput,
  type ChangeKindGateResult,
} from './change-kind-proof';
import type { ChangeKindsView } from './work-item-change-kinds';

const AFTER_CUTOVER = new Date(Date.parse(CHANGE_KIND_GATE_CUTOVER) + 3_600_000).toISOString();
const BEFORE_CUTOVER = new Date(Date.parse(CHANGE_KIND_GATE_CUTOVER) - 3_600_000).toISOString();

/** A stored declaration made at claim time, so the close owes no reason. */
function storedAtClaim(kinds: ChangeKind[]): ChangeKindsView {
  return {
    current: kinds,
    history: [{ kinds, step: 'claim', declaredBy: 'su-tester', declaredAt: AFTER_CUTOVER, reason: null }],
  };
}

function input(over: Partial<ChangeKindGateInput> & { kinds?: ChangeKind[] }): ChangeKindGateInput {
  const { kinds, ...rest } = over;
  return {
    itemId: 'WI-9001',
    successfulClose: true,
    stored: kinds ? storedAtClaim(kinds) : { current: null, history: [] },
    claimStartedAt: AFTER_CUTOVER,
    root: {},
    ...rest,
  };
}

/** Complete proof for each kind — what R-6 says must land. */
const FULL_PROOF: Record<ChangeKind, ChangeKindEvidence> = {
  ui: {
    kind: 'ui',
    summary: 'drove the queue panel in the headless Tauri shell',
    testsRun: 'scripts/verify-tauri-headless.sh -- tauri-agent-tools check --selector .queue-row',
    testResult: 'check passed; capture saved',
    artifacts: ['reports/ui/queue-panel-after.png'],
    build: 'operator build 258ed96687 from /api/health',
    states: [
      { name: 'empty queue', evidence: 'queue-panel-after.png top half' },
      { name: 'three rows', evidence: 'check --selector .queue-row count=3' },
    ],
    distinguishingChecks: [{ assertion: '.queue-row count', expected: '3', plausibleWrong: '0' }],
  },
  service: {
    kind: 'service',
    testsRun: 'curl -s 127.0.0.1:3170/api/health on papercup-staging.service',
    testResult: 'GET /api/health -> 200 {"sha":"258ed96687"}',
    build: '258ed96687',
  },
  migration: {
    kind: 'migration',
    database: 'ckdp_disposable_1518',
    testsRun: 'psql -d ckdp_disposable_1518 -f 1518-work-item-change-kind-declarations.sql',
    testResult: '\\d harness_shared.work_item_change_kind_declarations shows 8 columns and the feature index',
  },
  'background-job': {
    kind: 'background-job',
    runtime: 'isolated sidecar from verify-tauri-headless (port 4123, throwaway PG)',
    testsRun: 'fired system:change-kind-sweep once',
    testResult: 'one row moved to swept=true; the other two unchanged',
  },
  logic: {
    kind: 'logic',
    testsRun: 'testing:run { files: ["packages/operator-core/lib/change-kind-proof.test.ts"] }',
    testResult: '41 passed',
  },
  config: { kind: 'config', readBack: 'config:get change-kind.cutover returned 2026-10-18T04:00:00.000Z' },
  'test-only': {
    kind: 'test-only',
    testsRun: 'npx vitest run packages/operator-core/lib/change-kind-proof.test.ts',
    testResult: '41 passed, 0 failed',
  },
  docs: { kind: 'docs', readBack: 'docs:get agent-insights/change-kinds shows the new proof table' },
  'no-code-change': { kind: 'no-code-change' },
};

function expectRefused(r: ChangeKindGateResult): Extract<ChangeKindGateResult, { outcome: 'refuse' }> {
  expect(r.applicable).toBe(true);
  if (!r.applicable) throw new Error('not applicable');
  expect(r.outcome).toBe('refuse');
  if (r.outcome !== 'refuse') throw new Error(`expected refuse, got ${r.outcome}`);
  expect(r.error).toMatch(/^REJECTED/);
  expect(r.error).toContain('the item stays open');
  return r;
}

function missingFor(r: Extract<ChangeKindGateResult, { outcome: 'refuse' }>, kind: ChangeKind): string {
  const m = r.missing.find((x) => x.kind === kind);
  expect(m, `no missing-proof entry for ${kind}: ${r.error}`).toBeDefined();
  return m!.missing.join(' | ');
}

describe('R-2 — a successful close lacking a declared kind\'s catalog proof is refused, naming each missing proof', () => {
  it('a ui-declared close citing only Vitest is refused for the missing real-app run artifact', async () => {
    const r = expectRefused(
      await evaluateChangeKindGate(
        input({
          kinds: ['ui'],
          root: { testsRun: 'npm run test:file -- hud.test.ts', testResult: '2/2 vitest green', filesChanged: ['apps/operator/app/hud.css'] },
        }),
      ),
    );
    const gaps = missingFor(r, 'ui');
    expect(gaps).toContain('a recorded run of the real app');
    expect(gaps).toContain('`build`');
    expect(gaps).toContain('`states:');
    expect(gaps).toContain('`distinguishingChecks:');
    // The reply shows the catalog's whole requirement for the kind, not just the gap.
    expect(r.error).toContain(`Required for ui: ${CHANGE_KIND_CATALOG.ui.proof.join('; ')}`);
  });

  it.each([
    ['build', { build: undefined }, '`build` proving the run used a build containing this change'],
    ['states', { states: undefined }, '`states: [{ name, evidence }]`'],
    ['distinguishingChecks', { distinguishingChecks: undefined }, '`distinguishingChecks: [{ assertion, expected, plausibleWrong }]`'],
    [
      'a distinguishing check that cannot distinguish',
      { distinguishingChecks: [{ assertion: 'row count', expected: '3', plausibleWrong: ' 3 ' }] },
      'a distinguishing check whose `expected` differs from its `plausibleWrong`',
    ],
    ['a build field with no sha', { build: 'the current build' }, '`build` proving'],
  ] as const)('a ui close without %s is refused and names it', async (_label, override, expected) => {
    const entry = { ...FULL_PROOF.ui, ...override } as ChangeKindEvidence;
    const r = expectRefused(await evaluateChangeKindGate(input({ kinds: ['ui'], kindEvidence: [entry] })));
    expect(missingFor(r, 'ui')).toContain(expected);
  });

  it('a ui artifact that fails the live-drove-ui artifact check is refused with that check\'s reason', async () => {
    const r = expectRefused(
      await evaluateChangeKindGate(input({ kinds: ['ui'], kindEvidence: [FULL_PROOF.ui] }), {
        verifyUiArtifacts: async () => ({ ok: false, basis: 'none', reason: 'queue-panel-after.png is a blank image', artifacts: [] }),
      }),
    );
    expect(missingFor(r, 'ui')).toContain('a real-app artifact that holds up — queue-panel-after.png is a blank image');
  });

  it('a ui artifact kept only in session scratch is refused as unretained', async () => {
    const r = expectRefused(
      await evaluateChangeKindGate(input({ kinds: ['ui'], kindEvidence: [FULL_PROOF.ui] }), {
        unretainedUiArtifacts: async () => ['.papercusp/scratch/queue.png'],
      }),
    );
    expect(missingFor(r, 'ui')).toContain('retained artifacts — .papercusp/scratch/queue.png live only in session scratch');
  });

  it('a service close without a live call is refused', async () => {
    const r = expectRefused(
      await evaluateChangeKindGate(
        input({ kinds: ['service'], kindEvidence: [{ kind: 'service', testsRun: 'vitest run', testResult: '4 passed', build: '258ed96687' }] }),
      ),
    );
    expect(missingFor(r, 'service')).toContain('a live call');
  });

  it('a service close whose call does not name the build is refused for build containment', async () => {
    const r = expectRefused(
      await evaluateChangeKindGate(input({ kinds: ['service'], kindEvidence: [{ ...FULL_PROOF.service, build: undefined }] })),
    );
    expect(missingFor(r, 'service')).toContain('`build` proving the call used a build containing this change');
  });

  it('a migration close without a disposable database is refused', async () => {
    const r = expectRefused(
      await evaluateChangeKindGate(input({ kinds: ['migration'], kindEvidence: [{ ...FULL_PROOF.migration, database: undefined }] })),
    );
    expect(missingFor(r, 'migration')).toContain('`database` naming the disposable database');
  });

  it('a migration applied to the live operator database is refused', async () => {
    const r = expectRefused(
      await evaluateChangeKindGate(input({ kinds: ['migration'], kindEvidence: [{ ...FULL_PROOF.migration, database: 'papercusp' }] })),
    );
    expect(missingFor(r, 'migration')).toContain('"papercusp" is the live operator database');
  });

  it('a background-job close without an isolated runtime is refused', async () => {
    const missing = expectRefused(
      await evaluateChangeKindGate(input({ kinds: ['background-job'], kindEvidence: [{ ...FULL_PROOF['background-job'], runtime: undefined }] })),
    );
    expect(missingFor(missing, 'background-job')).toContain('`runtime` naming the isolated runtime');

    const shared = expectRefused(
      await evaluateChangeKindGate(
        input({ kinds: ['background-job'], kindEvidence: [{ ...FULL_PROOF['background-job'], runtime: 'staging operator 127.0.0.1:3170' }] }),
      ),
    );
    expect(missingFor(shared, 'background-job')).toContain('is a shared operator');
  });

  it.each(['logic', 'test-only'] as const)('a %s close without a test run is refused', async (kind) => {
    const r = expectRefused(
      await evaluateChangeKindGate(input({ kinds: [kind], root: { testsRun: 'read the code carefully', testResult: 'looks right' } })),
    );
    const gaps = missingFor(r, kind);
    expect(gaps).toContain('`testsRun` naming the test command or test files that ran');
    expect(gaps).toContain('`testResult` reporting a passing run (got "looks right")');
  });

  it('a logic close whose test run failed is refused', async () => {
    const r = expectRefused(
      await evaluateChangeKindGate(input({ kinds: ['logic'], root: { testsRun: 'testing:run { files }', testResult: '40 passed, 1 failed' } })),
    );
    expect(missingFor(r, 'logic')).toContain('`testResult` reporting a passing run');
  });

  it.each(['config', 'docs'] as const)('a %s close without a read-back is refused', async (kind) => {
    const r = expectRefused(await evaluateChangeKindGate(input({ kinds: [kind], root: { testsRun: 'npm test', testResult: 'pass' } })));
    expect(missingFor(r, kind)).toContain('`readBack` with');
  });

  it('a no-code-change close with a non-empty filesChanged is refused', async () => {
    const r = expectRefused(
      await evaluateChangeKindGate(input({ kinds: ['no-code-change'], root: { filesChanged: ['packages/x.ts'], filesDeleted: ['packages/y.ts'] } })),
    );
    expect(missingFor(r, 'no-code-change')).toContain('this close lists 2 changed or deleted path(s)');
  });

  it('a multi-kind close names every kind whose proof is missing, and only those', async () => {
    const r = expectRefused(
      await evaluateChangeKindGate(
        input({ kinds: ['logic', 'migration', 'service'], kindEvidence: [FULL_PROOF.logic, { kind: 'migration', testsRun: 'psql -f x.sql' }] }),
      ),
    );
    expect(r.missing.map((m) => m.kind).sort()).toEqual(['migration', 'service']);
    expect(missingFor(r, 'service')).toContain("a `kindEvidence` entry for 'service'");
    expect(missingFor(r, 'migration')).toContain('`database`');
    expect(r.error).toContain('- migration: missing');
    expect(r.error).toContain('- service: missing');
  });

  it('proof for an undeclared kind, or two entries for one kind, is refused as a problem', async () => {
    const r = expectRefused(
      await evaluateChangeKindGate(
        input({ kinds: ['logic'], kindEvidence: [FULL_PROOF.logic, FULL_PROOF.logic, FULL_PROOF.docs] }),
      ),
    );
    expect(r.problems.join('\n')).toContain("more than one entry for 'logic'");
    expect(r.problems.join('\n')).toContain("carries proof for 'docs', which is not declared");
  });

  it('a claim taken after the cutover with no declaration is refused and told how to declare', async () => {
    const r = expectRefused(await evaluateChangeKindGate(input({ claimStartedAt: AFTER_CUTOVER })));
    expect(r.kinds).toBeNull();
    expect(r.error).toContain('has no change-kind declaration');
    expect(r.error).toContain('`changeKinds: [...]`');
    for (const kind of CHANGE_KINDS) expect(r.error).toContain(kind);
  });

  it('an unreadable stored declaration does not let a post-cutover close through', async () => {
    const r = expectRefused(
      await evaluateChangeKindGate(input({ stored: null, storedReadError: 'connection reset', claimStartedAt: AFTER_CUTOVER })),
    );
    expect(r.error).toContain('could not be read (connection reset)');
  });
});

describe('D-001 — a declaration first made at close must say why', () => {
  it('refuses a first declaration at close without changeKindReason, even with full proof', async () => {
    const r = expectRefused(
      await evaluateChangeKindGate(
        input({ stored: { current: null, history: [] }, declaredAtClose: ['logic'], kindEvidence: [FULL_PROOF.logic] }),
      ),
    );
    expect(r.missing).toEqual([]);
    expect(r.problems.join('\n')).toContain('`changeKindReason` — no change kind was declared before close');
  });

  it('a reasonless declaration recorded by a refused close does not satisfy D-001 on the retry', async () => {
    // completeChangeKindEligibility stores the close-time declaration even when the close is
    // refused, so the retry sees history — but none of it predates close or carries a reason.
    const refusedAttempt: ChangeKindsView = {
      current: ['logic'],
      history: [{ kinds: ['logic'], step: 'complete', declaredBy: 'su-tester', declaredAt: AFTER_CUTOVER, reason: null }],
    };
    const retryWithoutKinds = expectRefused(
      await evaluateChangeKindGate(input({ stored: refusedAttempt, kindEvidence: [FULL_PROOF.logic] })),
    );
    expect(retryWithoutKinds.problems.join('\n')).toContain('`changeKindReason`');
    const retryRedeclaring = expectRefused(
      await evaluateChangeKindGate(
        input({ stored: refusedAttempt, declaredAtClose: ['logic'], kindEvidence: [FULL_PROOF.logic] }),
      ),
    );
    expect(retryRedeclaring.problems.join('\n')).toContain('`changeKindReason`');
  });

  it('a close-time declaration that carried a reason satisfies D-001 on the retry', async () => {
    const reasoned: ChangeKindsView = {
      current: ['logic'],
      history: [
        { kinds: ['logic'], step: 'complete', declaredBy: 'su-tester', declaredAt: AFTER_CUTOVER, reason: 'claimed via scheduler' },
      ],
    };
    const r = await evaluateChangeKindGate(input({ stored: reasoned, kindEvidence: [FULL_PROOF.logic] }));
    expect(r).toEqual({ applicable: true, outcome: 'pass', kinds: ['logic'] });
  });

  it('accepts a first declaration at close that carries a reason', async () => {
    const r = await evaluateChangeKindGate(
      input({
        stored: { current: null, history: [] },
        declaredAtClose: ['logic'],
        declaredReason: 'claimed through scheduler:get_next before the item was read',
        kindEvidence: [FULL_PROOF.logic],
      }),
    );
    expect(r).toEqual({ applicable: true, outcome: 'pass', kinds: ['logic'] });
  });

  it('does not ask for a reason when re-declaring at close an item already declared earlier', async () => {
    const r = await evaluateChangeKindGate(
      input({ kinds: ['logic'], declaredAtClose: ['logic', 'docs'], kindEvidence: [FULL_PROOF.logic, FULL_PROOF.docs] }),
    );
    expect(r).toEqual({ applicable: true, outcome: 'pass', kinds: ['logic', 'docs'] });
  });

  it('asks for a reason when the stored declaration cannot be read to confirm an earlier one', async () => {
    const r = expectRefused(
      await evaluateChangeKindGate(
        input({ stored: null, storedReadError: 'timeout', declaredAtClose: ['logic'], kindEvidence: [FULL_PROOF.logic] }),
      ),
    );
    expect(r.problems.join('\n')).toContain('cannot confirm an earlier declaration exists');
  });
});

describe('D-003 — claims taken before the cutover close with a warning', () => {
  it('warns instead of refusing an undeclared close whose claim predates the cutover', async () => {
    const r = await evaluateChangeKindGate(input({ claimStartedAt: BEFORE_CUTOVER }));
    expect(r.applicable && r.outcome).toBe('warn');
    if (!r.applicable || r.outcome !== 'warn') throw new Error('expected warn');
    expect(r.warning).toContain(`began ${BEFORE_CUTOVER}`);
    expect(r.warning).toContain(CHANGE_KIND_GATE_CUTOVER);
  });

  it('treats a claim with no recorded start as pre-cutover', async () => {
    expect(claimPredatesChangeKindCutover(null)).toBe(true);
    expect(claimPredatesChangeKindCutover('not a date')).toBe(true);
    const r = await evaluateChangeKindGate(input({ claimStartedAt: null }));
    expect(r.applicable && r.outcome).toBe('warn');
  });

  it('enforces a claim taken exactly at the cutover', () => {
    expect(claimPredatesChangeKindCutover(CHANGE_KIND_GATE_CUTOVER)).toBe(false);
    expect(claimPredatesChangeKindCutover(new Date(Date.parse(CHANGE_KIND_GATE_CUTOVER) - 1))).toBe(true);
  });

  it('still checks proof for a pre-cutover claim that did declare kinds', async () => {
    const r = expectRefused(
      await evaluateChangeKindGate(input({ kinds: ['logic'], claimStartedAt: BEFORE_CUTOVER, root: { testResult: 'pass' } })),
    );
    expect(missingFor(r, 'logic')).toContain('`testsRun`');
  });
});

describe('R-6 — a close that owes no reason and carries every catalog proof for each declared kind lands', () => {
  it.each(CHANGE_KINDS.map((k) => [k] as const))('a single-kind %s close with its full proof passes', async (kind) => {
    const r = await evaluateChangeKindGate(input({ kinds: [kind], kindEvidence: [FULL_PROOF[kind]] }));
    expect(r).toEqual({ applicable: true, outcome: 'pass', kinds: [kind] });
  });

  it('a single-kind logic close may carry its proof in the root testsRun/testResult', async () => {
    const r = await evaluateChangeKindGate(
      input({ kinds: ['logic'], root: { testsRun: 'testing:run { files: ["a.test.ts"] }', testResult: '12 passed', filesChanged: ['a.ts'] } }),
    );
    expect(r).toEqual({ applicable: true, outcome: 'pass', kinds: ['logic'] });
  });

  it('a single-kind ui close may cite its artifact in the root filesChanged', async () => {
    const { artifacts: _artifacts, ...rest } = FULL_PROOF.ui;
    const r = await evaluateChangeKindGate(
      input({ kinds: ['ui'], kindEvidence: [rest], root: { filesChanged: ['apps/operator/app/hud.css', 'reports/ui/hud-after.png'] } }),
    );
    expect(r).toEqual({ applicable: true, outcome: 'pass', kinds: ['ui'] });
  });

  it('a multi-kind close with one complete entry per kind passes', async () => {
    const kinds: ChangeKind[] = ['ui', 'service', 'migration', 'logic', 'config'];
    const r = await evaluateChangeKindGate(
      input({ kinds, kindEvidence: kinds.map((k) => FULL_PROOF[k]) }),
      { verifyUiArtifacts: async () => ({ ok: true, basis: 'image', artifacts: [] }), unretainedUiArtifacts: async () => [] },
    );
    expect(r).toEqual({ applicable: true, outcome: 'pass', kinds });
  });

  it('a multi-kind close that includes no-code-change needs no entry for it', async () => {
    const r = await evaluateChangeKindGate(input({ kinds: ['docs', 'no-code-change'], kindEvidence: [FULL_PROOF.docs] }));
    expect(r).toEqual({ applicable: true, outcome: 'pass', kinds: ['docs', 'no-code-change'] });
  });

  it('a declaration made at close replaces the stored one for this check', async () => {
    const r = await evaluateChangeKindGate(
      input({
        kinds: ['ui'],
        declaredAtClose: ['docs'],
        declaredReason: 'The UI half moved to a follow-up item; this item only updates the guide.',
        kindEvidence: [FULL_PROOF.docs],
      }),
    );
    expect(r).toEqual({ applicable: true, outcome: 'pass', kinds: ['docs'] });
  });

  // R-4 (P-004): the same replacement without a reason drops 'ui' silently — it lands proposed.
  it('a close-time replacement that drops a kind without a reason proposes rather than passes', async () => {
    const r = await evaluateChangeKindGate(
      input({ kinds: ['ui'], declaredAtClose: ['docs'], kindEvidence: [FULL_PROOF.docs] }),
    );
    expect(r).toMatchObject({ applicable: true, outcome: 'propose', kinds: ['docs'], narrowed: ['ui'], mismatchFiles: [] });
    expect(JSON.stringify(r)).toMatch(/changeKindReason/);
  });

  // R-4 (P-004): UI-looking files without 'ui' are a non-blocking tripwire, explained by a reason.
  it('UI-looking files without a ui declaration propose unless a reason explains them', async () => {
    const root = { testsRun: 'npx vitest run ranking.test.ts', testResult: '2 passed', filesChanged: ['apps/operator/app/dao/page.tsx', 'lib/ranking.ts'] };
    const reasonless = await evaluateChangeKindGate(input({ kinds: ['logic'], root }));
    expect(reasonless).toMatchObject({ applicable: true, outcome: 'propose', narrowed: [], mismatchFiles: ['apps/operator/app/dao/page.tsx'] });
    const reasoned = await evaluateChangeKindGate(input({ kinds: ['logic'], root, declaredReason: 'Type-only import change in the page.' }));
    expect(reasoned).toEqual({ applicable: true, outcome: 'pass', kinds: ['logic'], mismatchFiles: ['apps/operator/app/dao/page.tsx'] });
    const withUi = await evaluateChangeKindGate(input({ kinds: ['ui', 'logic'], root, kindEvidence: [FULL_PROOF.ui, { ...FULL_PROOF.logic }] }, ), { verifyUiArtifacts: async () => ({ ok: true, basis: 'image', artifacts: [] }), unretainedUiArtifacts: async () => [] });
    expect(withUi).toMatchObject({ applicable: true, outcome: 'pass' });
    expect(withUi).not.toHaveProperty('mismatchFiles');
  });
});

describe('only a successful close is gated', () => {
  it('is not applicable to anything but a successful close', async () => {
    expect(await evaluateChangeKindGate(input({ successfulClose: false, claimStartedAt: AFTER_CUTOVER }))).toEqual({
      applicable: false,
    });
  });
});
