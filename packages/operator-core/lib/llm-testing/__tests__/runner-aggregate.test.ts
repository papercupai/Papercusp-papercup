/**
 * Tests for the matrix-aggregation logic in runner.ts.
 *
 * Plan §2.4: per-scenario runMatrix; variance > 0.5 stddev on any axis
 * becomes an `inconsistent_behavior` finding. Majority verdict over the
 * matrix decides pass/fail/preview.
 *
 * The aggregate function is internal; we exercise it via runScenario's
 * single-run preview path + a synthetic two-run path that doesn't need
 * an LLM (single-run goes through; multi-run is the matrix case).
 *
 * Because runScenario itself hits the LLM, we test the aggregate
 * function's behavior indirectly by importing the internals where
 * possible and otherwise asserting on the shape we already exercise
 * elsewhere.
 */

import { describe, it, expect } from 'vitest';

import { SCENARIOS, getScenario } from '../scenarios';
import { listTargets } from '../targets';

describe('scenario registry', () => {
  it('retains the required scenarios and registers each scenario ID once', () => {
    const ids = SCENARIOS.map((s) => s.id).sort();
    // Required coverage may not disappear, while new scenarios join the same
    // target/assertion/cap checks below without extending an exact manifest.
    expect(ids).toEqual(expect.arrayContaining([
      // operator legacy (S-prefixed; framework build-out)
      'op-S01-status-quick',
      'op-S02-multistep-investigation',
      'op-S03-continue-cap-count',
      'op-S04-continue-cap-time',
      'op-S05-sleep-tag',
      'op-S06-spawn-worker',
      'op-S07-passive-mode',
      'op-S08-silence-nudge-ready',
      'op-S09-generate-ideas',
      'op-S10-ask-choice',
      'op-S11-voice-card-answer',
      'op-S12-tool-error-recovery',
      'op-S12b-tool-error-injected',
      // voice-mode brain behaviors (voice-production-test-coverage-2026-06-01 P-019)
      'op-S13-voice-terse-complex',
      'op-S14-voice-no-code',
      'op-S15-voice-error-recovery',
      'op-S16-voice-disambiguation',
      // operator brain-emission contracts (M-prefixed; operator-behavior-tests-2026-05-14)
      'op-M1-continue-paired-with-say',
      'op-M2-mutex-card-vs-continue',
      'op-M3-opener-substance',
      'op-M4-one-question-per-turn',
      'op-M5-spawn-worker-has-chunk',
      'op-M6-sleep-no-say',
      'op-M7-after-says-ready-options',
      'op-M8-format-utterance',
      'op-M10-ideas-not-operators',
      'op-M11-no-implementation-asks',
      'op-M12-no-stacked-questions-prose',
      // oracle
      'oracle-O1-docs-question',
      'oracle-O2-refuse-speculation',
      'oracle-O3-harness-question',
      'oracle-O4-no-tool-use-for-simple-fact',
      'oracle-O5-harness-scoped-answer',
      'oracle-O6-graceful-not-found',
      // architect
      'architect-A1-clarifying-questions',
      'architect-A2-scope-pushback',
      'architect-A3-reject-then-refine',
      'architect-A4-no-hallucinated-plan-items',
      'architect-A5-tradeoff-explanation',
      'architect-A6-no-spec-without-reading',
      // operator T4 boot-recall tier (memory-backend-benchmark-2026-06-05 P-009)
      'op-MEM00-control-unseeded',
      'op-MEM01-staging-probe-port',
      'op-MEM02-relay-salt-env',
      'op-MEM03-migration-range',
      'op-MEM04-flaky-isolate-flag',
      'op-MEM05-signaling-owner',
      'op-MEM06-shop-cdn-check',
      'op-MEM07-column-rename',
      'op-MEM08-tts-rotation',
      'op-MEM09-mic-device',
      'op-MEM10-explicit-search',
      // su engineer-collaborator playbook (su-scenario-suite-2026-05-31)
      'su-S01-harness-scope',
      'su-S02-tauri-only',
      'su-S03-push-not-poll',
      'su-S04-design-first',
      'su-S05-no-invent-write',
      'su-S06-shared-tree-git',
      'su-S07-keyed-write',
      'su-S08-compact-read',
      'su-S09-coord-injection-read',
      'su-S10-claim-before-work',
      'su-S11-lock-contention-protocol',
      'su-S12-same-turn-insight',
      // code:run adoption (code-execution-tool-orchestration B-CX-3)
      'su-S13-code-run-batch',
      'su-S14-code-run-not-for-single',
      'su-S15-code-run-small-batch',
      'su-S16-code-run-batch-write',
      // compound wrappers — reach + over-application guards (tool-call-batching-wrappers-2026-06-21 P-008)
      'su-S17-orient-bootstrap',
      'su-S18-orient-not-for-single',
      'su-S19-overview-state-of-x',
      'su-S20-overview-not-for-single',
      // bulk dual-arity reach + over-application guards (bulk-endpoint-standardization-2026-06-21 P-007)
      'su-S21-bulk-read-not-hand-loop',
      'su-S22-bulk-not-for-single',
      // delta-protocol Lane-C de-risk gate (agent-tool-delta-protocol-2026-06-22 P-007)
      'su-S23-delta-merge-base-present',
      'su-S24-delta-fallback-compacted',
      'su-S25-delta-wrong-merge-detector',
      'su-S26-take-charge-dont-wait',
      'su-S27-woke-to-dispatch-claims',
      'su-S28-ideate-pass-closes-loop',
      'su-S29-grade-low-wakes-originator',
      'su-S30-bug-filing-unconditional',
      // information-asymmetry experiment (agent-protocol-authority-semantics-2026-07-26 P-011):
      // three matched arms, identical task + description, differing only in the peer handoff.
      'su-S31a-asymmetry-control',
      'su-S31b-asymmetry-prose',
      'su-S31c-asymmetry-field',
      'su-S31d-asymmetry-provenance',
      'su-S32-audit-mode-whole-picture',
      'su-S33-agenda-delegate',
      'su-S33-agenda-verify',
      'su-S33-agenda-report',
      'su-S33-agenda-continue',
      'su-S33-agenda-wait',
      'su-S33-agenda-unknown',
      'su-S33-agenda-no-demand',
      'su-S33-agenda-paused',
      'su-S33-agenda-achieved',
      'su-S33-agenda-killed',
      'su-S34-grader-r1-evidence-record',
      'su-S34-grader-r3-no-opportunity',
      'su-S34-grader-r4-unmatched-effect',
      'su-S34-grader-r7-verdict-complete',
      // S35 completion residue discipline (D-041, goal-agent-behavior-feedback-2026-09-06 R-18)
      'su-S35-completion-clean',
      'su-S35-completion-proof-missing',
      'su-S35-completion-residue',
      // S36 drain claims only agent work (enterprise-data-sources-2026-10-01 P-012, R-6)
      'su-S36-drain-claims-only-agent-work',
      // S37 / W01 code-search discipline (gitnexus-deterministic-integration-2026-10-05 P-015)
      'su-S37a-absence-claim',
      'su-S37b-signature-impact',
      'su-S37c-definition-lookup',
      'su-S38-reports-capture',
      'su-S39-verification-map-doors',
      'su-S40-grade-checker-rules',
      'su-S41-scheduler-independent',
      'su-S41-scheduler-blocked',
      'su-S41-scheduler-no-event',
      'su-S41-scheduler-finished',
      'worker-W01a-absence-claim',
      'worker-W01b-signature-impact',
      'worker-W01c-definition-lookup',
      // pui-loop — the owned loop's su-derived prompt profile (D-034)
      'pui-loop-P01-owned-door-read',
      // onboarding-tutor scenario suite (onboarding-tutor target)
      'onboarding-tutor-OT1-section-protocol',
      'onboarding-tutor-OT2-progress-checkpoint',
      'onboarding-tutor-OT3-question-detour',
      // overwatch persona boundaries (overwatch-role-2026-06-15 B-11)
      'overwatch-OW01-nudge-not-replace',
      'overwatch-OW02-observe-not-idea',
      // sentinel voice→Mug handoff (sentinel-as-claude-tui-2026-06-22)
      'sn-S01-handoff-planning-ask',
      'sn-S02-no-handoff-trivial',
      // sentinel P2 hive-knowledge scenarios
      'sn-H01-fleet-status',
      'sn-H02-plans-and-blocked',
      'sn-H03-mug-explainer',
      'sn-H04-assign-to-mug',
      // sentinel P3 handoff-depth scenarios
      'sn-H05-urgent-handoff',
      'sn-H06-respect-no-handoff',
      'sn-H07-multi-item-handoff',
      'sn-D01-delegate-hard-thinking',
      'sn-D02-work-not-delegated',
      'sn-D03-existing-delegation-status',
      // sentinel P1 mirrors of operator chat-hygiene contracts (./sentinel/_mirror)
      'sn-S10-ask-choice',
      'sn-S11-voice-card-answer',
      'sn-S13-voice-terse-complex',
      'sn-S14-voice-no-code',
      'sn-S15-voice-error-recovery',
      'sn-S16-voice-disambiguation',
      'sn-M4-one-question-per-turn',
      'sn-M8-format-utterance',
    ]));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('throws on unknown scenario', () => {
    expect(() => getScenario('nope')).toThrow();
  });

  it('every scenario references a known target', () => {
    // DERIVED from the target registry, never hand-maintained. This list
    // DESCRIBES targets/index.ts, so a hardcoded copy goes stale the moment a
    // target is registered — which is exactly how 'pui-loop' (D-034) red the
    // gate while the scenario and its target were both correct.
    // Deriving keeps the assertion sharp rather than vacuous: a scenario
    // naming an UNREGISTERED target still fails, which is the property under
    // test. The length guard is what stops an empty registry from making the
    // loop trivially satisfiable.
    const registeredTargets = listTargets();
    expect(registeredTargets.length).toBeGreaterThan(0);
    for (const s of SCENARIOS) {
      expect(registeredTargets).toContain(s.target);
    }
  });

  it('every scenario has at least one assertion', () => {
    for (const s of SCENARIOS) {
      expect(s.asserts.length).toBeGreaterThan(0);
    }
  });

  it('every scenario declares caps', () => {
    for (const s of SCENARIOS) {
      expect(s.caps.maxTurns).toBeGreaterThan(0);
      expect(s.caps.maxWallSecs).toBeGreaterThan(0);
      expect(s.caps.maxCostUsd).toBeGreaterThan(0);
    }
  });

  it('judge-heavy scenarios opt into runMatrix.repeat >= 3', () => {
    const judgeHeavyIds = ['op-S01-status-quick', 'op-S02-multistep-investigation'];
    for (const id of judgeHeavyIds) {
      const s = getScenario(id);
      expect(s.runMatrix?.repeat ?? 1).toBeGreaterThanOrEqual(3);
    }
  });
});
