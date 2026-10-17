/**
 * EI-20288629053504794 — prescribed recurrence-guard/test detector.
 *
 * This suite pins the obligation detector in both directions and verifies the
 * warning is wired into work_items:complete. A source-only wiring check is
 * intentional: a perfect pure predicate that is never called is still absent
 * from the product.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';

import { prescribedRecurrenceGuardCoverageGap } from './complete';

const item = {
  title: 'Completion integrity',
  summary: 'Proposed durable fix: add a recurrence guard asserting no refusal string survives.',
};

describe('prescribedRecurrenceGuardCoverageGap', () => {
  it('fires when the item prescribes a guard and completion only reports ordinary tests', () => {
    const result = prescribedRecurrenceGuardCoverageGap(item, {
      summary: 'focused suite passed',
      testsRun: 'complete.test.ts',
      testResult: '55/55 passed',
      filesChanged: ['packages/operator-core/lib/complete.ts'],
    });

    expect(result?.prescriptions).toHaveLength(1);
    expect(result?.prescriptions[0]).toContain('add a recurrence guard');
  });

  it('stays silent when completion points to the guard and its focused test', () => {
    expect(
      prescribedRecurrenceGuardCoverageGap(item, {
        summary: 'Added the recurrence guard and regression test.',
        addedTests: true,
        filesChanged: ['packages/operator-core/lib/complete.prescribed-guard.test.ts'],
        testsRun: 'focused recurrence guard suite',
        testResult: '6/6 passed',
      }),
    ).toBeUndefined();
  });

  it('accepts an explicit waiver with a reason', () => {
    expect(
      prescribedRecurrenceGuardCoverageGap(item, {
        summary: 'Waived the recurrence guard because an existing assertion covers it.',
        testsRun: 'existing assertion suite',
        testResult: 'green',
      }),
    ).toBeUndefined();
  });

  it('does not warn for an item with no prescribed guard or added-test obligation', () => {
    expect(
      prescribedRecurrenceGuardCoverageGap(
        { title: 'Routine bug fix', summary: 'Update the null check and run the existing tests.' },
        { summary: 'fixed the null check', testsRun: 'existing suite', testResult: 'green' },
      ),
    ).toBeUndefined();
  });

  it('ignores filesChanged path-shape guidance that mentions a test path', () => {
    expect(
      prescribedRecurrenceGuardCoverageGap(
        {
          title: 'Completion guard detector mistakes filesChanged path guidance for a required test',
          summary:
            'The source item text said only: "filesChanged should contain only the source test path" — ' +
            'a path-format correction for an invalid caller payload, not a recurrence-test prescription.',
        },
        {
          summary: 'corrected the completion payload shape',
          testsRun: 'existing completion suite',
          testResult: 'passed',
          filesChanged: ['packages/operator-core/lib/agent-tools/work_items/complete.ts'],
        },
      ),
    ).toBeUndefined();
  });

  it('still warns on a real explicit regression-test prescription', () => {
    expect(
      prescribedRecurrenceGuardCoverageGap(
        { title: 'Completion integrity', summary: 'Add a regression test for this detector.' },
        {
          summary: 'updated the detector',
          testsRun: 'existing completion suite',
          testResult: 'passed',
          filesChanged: ['packages/operator-core/lib/agent-tools/work_items/complete.ts'],
        },
      ),
    ).toBeDefined();
  });

  it('ignores a quoted historical anecdote instead of treating it as a live prescription', () => {
    expect(
      prescribedRecurrenceGuardCoverageGap(
        {
          title: 'Completion evidence should require a machine-checkable ref',
          summary:
            "The item summary quoted Avi describing a prior agent who had 'added a recurrence-guard health-check'. " +
            'That quotation explains the motivating incident; it does not prescribe a new guard for this item.',
        },
        {
          summary: 'closed with committed authority',
          testsRun: 'packages/operator-core/lib/work-item-completion-authority.test.ts',
          testResult: 'passed',
        },
      ),
    ).toBeUndefined();
  });

  it('credits an exact declared test path cited by testsRun', () => {
    expect(
      prescribedRecurrenceGuardCoverageGap(
        {
          title: 'Completion integrity',
          summary: 'The fix must add a recurrence guard for this behavior.',
          payload: {
            paths: [
              'packages/operator-core/lib/agent-tools/work_items/complete.ts',
              'packages/operator-core/lib/agent-tools/work_items/complete.prescribed-guard.test.ts',
            ],
          },
        },
        {
          summary: 'closed with committed authority',
          testsRun: 'packages/operator-core/lib/agent-tools/work_items/complete.prescribed-guard.test.ts',
          testResult: '10 passed',
        },
      ),
    ).toBeUndefined();
  });

  it('credits an exact declared packaging test path in filesChanged when testsRun uses only its basename', () => {
    const declaredTestPath = 'papercusp-desktop/test/build-desktop-sidecar-workspace-install.test.js';
    expect(
      prescribedRecurrenceGuardCoverageGap(
        {
          title: 'Packaged Server does not ship the boot-start helper',
          summary:
            'Fix: ship the helper, print its path from postinst, and add a packaging regression assertion beside the existing unit assertions.',
          payload: {
            paths: [
              'papercusp-desktop/src-tauri/tauri.server.conf.json',
              declaredTestPath,
            ],
          },
        },
        {
          summary: 'Linux Server packages ship the executable boot-start helper; no-login reboot is healthy.',
          testsRun: 'Canonical build-desktop-sidecar-workspace-install.test.js 53/53',
          testResult: 'PASS: committed operational evidence; 53/53 tests passed.',
          filesChanged: [
            'papercusp-desktop/src-tauri/tauri.server.conf.json',
            declaredTestPath,
          ],
        },
      ),
    ).toBeUndefined();
  });

  it('credits a repo-relative prescribed test path in structured evidence when filesChanged names only the writer', () => {
    const item = {
      title: 'dev:restart guidance exceeds the enforced prompt-weight budget',
      summary:
        'The writer-backed assertion requires the guidance to stay below 1500 characters; rerun the focused budget suite after trimming.',
      payload: {
        paths: [
          'packages/operator-core/lib/__tests__/tools-md-sync.test.ts',
          'packages/operator-core/lib/__tests__/tool-guidance-budget.shared.ts',
        ],
      },
    };
    const evidence = {
      testsRun: 'npx vitest run --silent=true lib/__tests__/tools-md-sync.test.ts',
      testResult: 'PASS: tools-md-sync.test.ts 57/57',
      verifiedHow: 'Read the prompt-weight writer, then reran the focused budget suite.',
      filesChanged: ['packages/operator-core/lib/agent-tools/dev/restart.ts'],
    };

    expect(prescribedRecurrenceGuardCoverageGap(item, { verification: evidence })).toBeUndefined();
    expect(prescribedRecurrenceGuardCoverageGap(item, evidence)).toBeUndefined();
  });

  it('credits a passing replacement test when the prescribed test path is explicitly deleted', () => {
    const deletedPath =
      'packages/operator-core/lib/endpoint-route/__tests__/mcp-handler-gating-matrix.integration.test.ts';
    const replacementPath = 'packages/operator-core/lib/endpoint-route/__tests__/mcp-handler-gating-matrix.test.ts';

    expect(
      prescribedRecurrenceGuardCoverageGap(
        {
          title: `Reproduce and repair ${deletedPath}`,
          summary: 'The fix must add a recurrence guard and preserve effective replacement coverage.',
        },
        {
          summary: 'Removed the obsolete wrapper; the replacement test remains effective.',
          verification: {
            filesDeleted: [deletedPath],
            filesChanged: [replacementPath],
            testsRun: `npm run test:file -- ${replacementPath}`,
            testResult: `PASS ${replacementPath}: 3 passed, 0 failed`,
          },
        },
      ),
    ).toBeUndefined();
  });

  it('keeps warning when a deleted prescribed test has no passing replacement evidence', () => {
    const deletedPath =
      'packages/operator-core/lib/endpoint-route/__tests__/mcp-handler-gating-matrix.integration.test.ts';
    const replacementPath = 'packages/operator-core/lib/endpoint-route/__tests__/mcp-handler-gating-matrix.test.ts';

    expect(
      prescribedRecurrenceGuardCoverageGap(
        {
          title: `Reproduce and repair ${deletedPath}`,
          summary: 'The fix must add a recurrence guard and preserve effective replacement coverage.',
        },
        {
          summary: 'Removed the obsolete wrapper.',
          filesDeleted: [deletedPath],
          testsRun: `npm run test:file -- ${replacementPath}`,
          testResult: `${replacementPath}: 1 failed`,
        },
      ),
    ).toBeDefined();
  });

  it('keeps warning when replacement evidence explicitly disclaims the guard', () => {
    const deletedPath =
      'packages/operator-core/lib/endpoint-route/__tests__/mcp-handler-gating-matrix.integration.test.ts';
    const replacementPath = 'packages/operator-core/lib/endpoint-route/__tests__/mcp-handler-gating-matrix.test.ts';

    expect(
      prescribedRecurrenceGuardCoverageGap(
        {
          title: `Reproduce and repair ${deletedPath}`,
          summary: 'The fix must add a recurrence guard and preserve effective replacement coverage.',
        },
        {
          summary: 'Removed the obsolete wrapper; the replacement test was not added.',
          filesDeleted: [deletedPath],
          filesChanged: [replacementPath],
          testsRun: `npm run test:file -- ${replacementPath}`,
          testResult: `${replacementPath}: 3 passed, 0 failed`,
        },
      ),
    ).toBeDefined();
  });

  // EI-20551121122206657 — the three cases below pin the PER-PART matching rule. The first
  // is the observed false alarm; the second is the flag placement the tool's own description
  // recommends; the third is the calibration that keeps the fix from being a blanket
  // weakening (a real disclaimer must still suppress, wherever it lives).
  it('does not manufacture a negation across two independent completion fields', () => {
    // Observed on the close of EI-20547482952043431. Each string is innocuous alone; joined
    // with "\n" they read as "not <25 chars> guard" to the 45-char negation window, which
    // cancelled a summary that cited its guard by path three separate times.
    expect(
      prescribedRecurrenceGuardCoverageGap(item, {
        summary:
          'RECURRENCE GUARD: apps/operator/lib/release/windows-rootfs-preflight.test.ts — 4 passing. ' +
          'The join_leg half is covered by EI-20549139616021387 — read before filing, not duplicated.',
        whatLanded: ["ordering guard generalized from 'before the win leg' to 'before the FIRST leg'"],
        testsRun: 'windows-rootfs-preflight.test.ts',
        testResult: '4 passed / 0 failed',
      }),
    ).toBeUndefined();
  });

  it('credits addedTests declared under verification, not only at the top level', () => {
    expect(
      prescribedRecurrenceGuardCoverageGap(item, {
        summary: 'closed it',
        verification: {
          addedTests: true,
          filesChanged: ['packages/operator-core/lib/agent-tools/work_items/complete.prescribed-guard.test.ts'],
        },
      }),
    ).toBeUndefined();
  });

  it('still honours a real disclaimer that lives outside the summary', () => {
    // CALIBRATION for the two cases above: per-part matching must not degrade into "never
    // negative". The only guard-ish mention here is inside deferred[0], and it disclaims —
    // so the part that mentions the guard is the part that negates it, and the warning must
    // still fire. Without this case, the fix above could have been an unconditional
    // `pointsToGuard = true` and the suite would not have noticed.
    expect(
      prescribedRecurrenceGuardCoverageGap(item, {
        summary: 'closed it out',
        deferred: ['no recurrence guard added — deferred to a follow-up item'],
      }),
    ).toBeDefined();
  });

  it('does not read a contrastive "guard, not X" clause as a disclaimer', () => {
    // EI-21447362440754444, measured on the close of WI-41672 — this is the string VERBATIM
    // from that completion, not a paraphrase. It AFFIRMS the test it mentions: the negation
    // attaches to `maybe`, what FOLLOWS the comma. It nonetheless matched the guard-word-
    // then-negation alternative, and `negativeSomewhere` then cancelled a structured
    // addedTests + real-test-path citation on a close that added both a property-based
    // guard and a falsifiability control test.
    //
    // A first paraphrase of this case passed for the wrong reason and had to be discarded:
    // shortening the prose pulled an unrelated "not ... guard" pair inside the FIRST
    // alternative's 45-char window, so the warning fired via a path this fix does not
    // touch. Keep the observed wording — the window makes paraphrases untrustworthy here.
    expect(
      prescribedRecurrenceGuardCoverageGap(item, {
        whatLanded: [
          'control test uses plain `it`, not `maybe`, so it gates even on a checkout without the papercusp-desktop submodule',
        ],
        addedTests: true,
        filesChanged: ['packages/operator-core/lib/desktop-acl-command-sync.test.ts'],
      }),
    ).toBeUndefined();
  });

  it('still fires on a contrastive clause whose NEGATED side is the guard', () => {
    // CALIBRATION for the case above: the lookbehind must exempt only a guard-word on the
    // AFFIRMED (left) side of the contrast. Here the guard is what is being denied, so the
    // first alternative — negation THEN guard-word — must still catch it. Without this
    // case, the fix could have dropped the second alternative wholesale unnoticed.
    expect(
      prescribedRecurrenceGuardCoverageGap(item, {
        summary: 'I landed a fix, not a regression test.',
        addedTests: true,
        filesChanged: ['packages/operator-core/lib/agent-tools/work_items/complete.prescribed-guard.test.ts'],
      }),
    ).toBeDefined();
  });

  it('still fires on a non-contrastive guard-word-then-negation disclaimer', () => {
    // CALIBRATION: the lookbehind is keyed on the comma, so an ordinary "guard ... not"
    // sentence must be unaffected. This is the shape the second alternative exists for.
    expect(
      prescribedRecurrenceGuardCoverageGap(item, {
        summary: 'the recurrence guard was not added in this pass',
        addedTests: true,
        filesChanged: ['packages/operator-core/lib/agent-tools/work_items/complete.prescribed-guard.test.ts'],
      }),
    ).toBeDefined();
  });

  it('fails open for malformed item data and warns on an explicit missing guard', () => {
    expect(prescribedRecurrenceGuardCoverageGap({ title: null, summary: 42 }, null)).toBeUndefined();
    expect(
      prescribedRecurrenceGuardCoverageGap(
        { summary: 'Add a regression guard.' },
        { summary: 'guard was not added because the source is unavailable' },
      ),
    ).toBeDefined();
  });
});

describe('complete.ts wiring', () => {
  const source = readFileSync(nodePath.join(__dirname, 'complete.ts'), 'utf8');

  it('computes the detector from the fetched item and raw completion', () => {
    expect(source).toMatch(/prescribedRecurrenceGuardCoverageGap\(\s*existing,\s*it\.completion\s*\)/);
  });

  it('returns the warning instead of silently discarding the detector result', () => {
    expect(source).toMatch(/\.\.\.\(prescribedGuardWarning \? \{ prescribedGuardWarning \} : \{\}\)/);
  });
});
