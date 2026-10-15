/**
 * WI-10005199 — consumer attestation for a landed `work_items:complete` close.
 *
 * Falsifiable in both directions: every DIVERGED case would fail an implementation that
 * never reports a block (the first-version defect this slice exists to prevent), and every
 * AGREES case would fail one that always reports it. The DIVERGED fixture is the real
 * migration-972 shape: the call computed `committed`, the BEFORE trigger stored `proposed`.
 *
 * Wiring (the call site actually spreads the block into the close response, from the value
 * `reconcileStampedAuthority` returned) is pinned separately at the bottom, because a
 * correct leaf behind a dropped spread is the exact failure class this file guards.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { reconcileStampedAuthority } from '../../work-item-completion-authority';
import { attestCompletionConsumerView, COMPLETION_CONSUMER_READ_PATH } from './complete-consumer-view';

describe('attestCompletionConsumerView', () => {
  it('reports a consumerView when the floor trigger stored a weaker authority than the call computed', () => {
    const out = attestCompletionConsumerView({
      stamped: true,
      computedAuthority: 'committed',
      stampedAuthority: 'proposed',
    });
    expect(out).toEqual({
      consumerView: {
        readPath: COMPLETION_CONSUMER_READ_PATH,
        value: { completionAuthority: 'proposed' },
        divergedFromWrite: true,
      },
    });
  });

  it('also reports the opposite direction (stored STRONGER than computed) — divergence is symmetric', () => {
    const out = attestCompletionConsumerView({
      stamped: true,
      computedAuthority: 'proposed',
      stampedAuthority: 'committed',
    });
    expect(out?.consumerView.divergedFromWrite).toBe(true);
    expect(out?.consumerView.value).toEqual({ completionAuthority: 'committed' });
  });

  it('is exception-only: agreement returns undefined so an ordinary close response is unchanged', () => {
    expect(
      attestCompletionConsumerView({ stamped: true, computedAuthority: 'committed', stampedAuthority: 'committed' }),
    ).toBeUndefined();
    expect(
      attestCompletionConsumerView({ stamped: true, computedAuthority: 'proposed', stampedAuthority: 'proposed' }),
    ).toBeUndefined();
  });

  it('treats a writer that stamps no authority on either side as agreement (null == null)', () => {
    expect(
      attestCompletionConsumerView({ stamped: true, computedAuthority: null, stampedAuthority: null }),
    ).toBeUndefined();
  });

  it('attests nothing when the call stamped no close — there is no authority write to read back', () => {
    // Even a would-be divergence is not reported: an unstamped call wrote no authority.
    expect(
      attestCompletionConsumerView({ stamped: false, computedAuthority: 'committed', stampedAuthority: null }),
    ).toBeUndefined();
  });

  it('composes with reconcileStampedAuthority: a DB-side downgrade surfaces as a consumerView', () => {
    // The real chain the handler runs: persisted ('proposed', post-trigger) beats computed.
    const reconciled = reconcileStampedAuthority({
      stamped: true,
      persisted: 'proposed',
      computed: 'committed',
      authorityByEvidence: 'committed',
      declaredFilesCount: 2,
      inProcessContentIdentityMissing: false,
    });
    expect(reconciled.divergedFromComputed).toBe(true);
    const out = attestCompletionConsumerView({
      stamped: true,
      computedAuthority: 'committed',
      stampedAuthority: reconciled.stampedAuthority,
    });
    expect(out?.consumerView.divergedFromWrite).toBe(true);
    // ...and the block and the reconciler can never disagree about whether a divergence happened.
    expect(Boolean(out)).toBe(reconciled.divergedFromComputed);
  });

  it('does not attribute another in-process downgrade to content identity just because files were declared', () => {
    const reconciled = reconcileStampedAuthority({
      stamped: true,
      persisted: 'proposed',
      computed: 'proposed',
      authorityByEvidence: 'committed',
      declaredFilesCount: 4,
      inProcessContentIdentityMissing: false,
    });

    expect(reconciled.stampedAuthority).toBe('proposed');
    expect(reconciled.contentIdentityDowngrade).toBe(false);
  });
});

describe('complete.ts wiring (source pin — a correct leaf behind a dropped spread is a no-op)', () => {
  // Overridable so scripts/mutation-probe.sh can point this at a mutated COPY (copy-out mode:
  // zero dirty window on a hot shared file) — the default is the real subject.
  const source = readFileSync(
    process.env.COMPLETE_TS_UNDER_TEST ?? fileURLToPath(new URL('./complete.ts', import.meta.url)),
    'utf8',
  );
  // Strip line + block comments so prose that mentions a token cannot satisfy the pin.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('feeds the attestation from reconcileStampedAuthority\'s stampedAuthority, not a re-derivation', () => {
    expect(code).toMatch(/const\s*\{\s*stampedAuthority[^}]*\}\s*=\s*reconcileStampedAuthority\(/);
    expect(code).toMatch(
      /const\s+consumerAttestation\s*=\s*attestCompletionConsumerView\(\{[^}]*computedAuthority:\s*completionAuthority[^}]*stampedAuthority[^}]*\}\)/,
    );
  });

  it('spreads the attestation into the close response', () => {
    expect(code).toContain('...(consumerAttestation ?? {}),');
  });
});
