'use client';

import { VAL_RETIREMENT_DOC } from '@papercusp/operator-core/lib/agent-tools/plans/val-retirement';

/**
 * <AcceptancePanel> — the harness Tests tab's "Acceptance" (Project) view.
 *
 * Originally P-062 / P-063 of harness-tests-tab-and-tester-promotion-2026-05-26:
 * it listed the inline VAL-* assertions (`harness_plan_assertions`) with a
 * per-VAL `requires_test` toggle.
 *
 * RETIRED by verification-system-improvements-2026-10-10 P-003
 * (SPEC-P-003-VAL-READERS). Inline VAL-* assertions are no longer read or
 * written: a plan's acceptance contract is its `requirement` blocks (spec
 * clauses with bound evidence, read via `plans:get`) plus its graded acceptance
 * rubric. The `testing.assertionsByHarness` sync query and the
 * `/testing/assertions` routes are gone or answer a typed 410, so this panel
 * renders a static notice naming the successor instead of a list that would
 * always read as "no assertions".
 */

const wrap: React.CSSProperties = { padding: '16px 20px', color: 'var(--fg-mute, #7f9bb4)', fontSize: 13, lineHeight: 1.5 };

export default function AcceptancePanel({ slug }: { slug: string }) {
  return (
    <div style={wrap} data-harness={slug} data-testid="acceptance-retired">
      <h3 style={{ margin: '0 0 8px', fontSize: 15, color: 'var(--fg)' }}>Acceptance criteria</h3>
      <p style={{ margin: '0 0 8px' }}>
        Inline <code>[VAL-…]</code> assertions are retired. Each plan&apos;s acceptance contract is now its{' '}
        <strong>requirement</strong> blocks (spec clauses with bound evidence) plus its graded acceptance
        rubric. Read them from the plan itself (<code>plans:get</code>).
      </p>
      <p style={{ margin: 0 }}>
        Background and migration notes: <code>{VAL_RETIREMENT_DOC}</code>.
      </p>
    </div>
  );
}
