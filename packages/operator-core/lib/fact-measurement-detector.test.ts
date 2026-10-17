import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import assertTool from './agent-tools/facts/assert';
import {
  detectFactAbsenceClaims,
  detectFactMeasurements,
  factAbsenceHint,
  factMeasurementHint,
  formatFactAbsenceHint,
  formatFactMeasurementHint,
  MEASUREMENT_CONTEXT_WINDOW,
} from './fact-measurement-detector';

type AssertSchemaField = { description?: string };

const assertSchemaField = (name: string): AssertSchemaField => {
  // EI-22064465906366039: read the PUBLISHED JSON Schema, not zod internals.
  // The old form reached into `.options` — the root union's BRANCH LIST — so
  // retiring that union broke four identical copies of this helper at once, in
  // files that have nothing to do with the union. The projection is what callers
  // actually see, and it is shape-agnostic.
  const json = z.toJSONSchema(assertTool.args as never) as {
    properties?: Record<string, AssertSchemaField>;
  };
  const field = json.properties?.[name];
  if (!field) throw new Error(`facts:assert schema field missing: ${name}`);
  return field;
};

describe('fact measurement detector — moving numbers get an advisory', () => {
  it('flags the incident shape: measured status counts that can change after the write', () => {
    const signals = detectFactMeasurements(
      'Measured at 20:50Z: 0 adjudicated, 142 keyword-triage candidates, 214 unchecked. Recheck the file later.',
    );
    expect(signals.map((signal) => signal.value)).toEqual(['0', '142', '214']);
  });

  it('flags an as-of status count and a working-tree delta', () => {
    const signals = detectFactMeasurements(
      'As of now the status has 7 open items; the working tree reports +31/-8 uncommitted changes.',
    );
    expect(signals.length).toBeGreaterThanOrEqual(2);
    expect(signals.some((signal) => signal.value === '7')).toBe(true);
    expect(signals.some((signal) => signal.value.includes('+31'))).toBe(true);
  });

  it('does not warn on fixed numeric prose without moving-state language', () => {
    const fixed = [
      'Migration 689 has a 3-step process.',
      'The convention requires 3 claims before review.',
      'The suite runs 155 tests in 12 seconds.',
      'See commit abc1234 for the rationale; the 1200-char cap is intentional.',
    ];
    for (const body of fixed) expect(detectFactMeasurements(body), body).toEqual([]);
  });

  it('does not treat a labelled HN item ID as a measurement when current wording is nearby', () => {
    const body = 'Kredit Financial historical HN item 39921317 and current first-party role verification remains open.';
    expect(detectFactMeasurements(body)).toEqual([]);
    expect(factMeasurementHint('currently 4 unchecked rows')).toMatch(/measurement-like|Advisory only/);
  });

  it('keeps distant state language from making an unrelated number look measured', () => {
    const body = `12345 ${'x'.repeat(MEASUREMENT_CONTEXT_WINDOW * 3)} current status is stable`;
    expect(detectFactMeasurements(body)).toEqual([]);
  });

  it('is fail-soft for non-string input and bounded large input', () => {
    expect(detectFactMeasurements(null)).toEqual([]);
    const body = 'currently 12 open items '.repeat(5_000);
    const started = Date.now();
    expect(factMeasurementHint(body)).toMatch(/measurement-like|Advisory only/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('renders a null clean case and a useful non-blocking advisory', () => {
    expect(formatFactMeasurementHint([])).toBeNull();
    const hint = factMeasurementHint('currently 4 unchecked rows')!;
    expect(hint).toContain('invariant conclusion');
    expect(hint).toContain('remeasure');
    expect(hint).toMatch(/write succeeded|nothing was blocked/i);
  });

  it('documents the right authoring path in live facts:assert guidance', () => {
    const notWhen = assertTool.guidance?.notWhen ?? '';
    expect(notWhen).toMatch(/not a live measurement/i);
    expect(notWhen).toMatch(/invariant conclusion/i);
    expect(notWhen).toMatch(/remeasure/i);
    expect(notWhen).toMatch(/historical/i);
    expect(assertSchemaField('subjectVolatile').description).toMatch(/SNAPSHOT|15 minutes/);
    expect(assertSchemaField('measuredAt').description).toMatch(/ISO timestamp|subjectVolatile/);
  });
});

describe('fact absence detector — a worded absence gets its own advisory (EI-20307375669832848)', () => {
  // CALIBRATION. This is the measured gap the absence scan exists to close: the
  // measurement scan is driven by NUMBER matches, so a worded absence never
  // reaches its context check. If this ever starts firing, the absence detector
  // is duplicating the measurement one and this pair should be reconciled.
  it('confirms the measurement scan is structurally blind to a worded absence', () => {
    expect(detectFactMeasurements('no membership exists for this agent')).toEqual([]);
    expect(detectFactMeasurements('EI-20307375669832848 was never touched by any routine')).toEqual([]);
    expect(detectFactMeasurements('the census found nothing in that relation')).toEqual([]);
    // ...while it still catches an absence that happens to be written numerically.
    expect(detectFactMeasurements('observed surfacedAsPattern of 0')).not.toEqual([]);
  });

  it('flags the absence shapes the measurement scan cannot see', () => {
    for (const body of [
      'no membership exists for this agent',
      'EI-20307375669832848 was never touched by any routine',
      'the census found nothing in that relation',
      'there are no emitters for this event key',
      'the callers query returned no rows',
      'that migration does not exist in the candidate',
    ]) {
      expect(detectFactAbsenceClaims(body), body).not.toEqual([]);
    }
  });

  // WI-2145990 class: a domain term that merely CONTAINS a negation is not an
  // absence claim. The anchors reject hyphen adjacency so these cannot trip it.
  it('does not fire on hyphenated domain terms that contain a negation', () => {
    expect(detectFactAbsenceClaims('the deliberate-no-pair decision is recorded and the no-op path exists')).toEqual(
      [],
    );
    expect(detectFactAbsenceClaims('no-fall routing is implemented for this lane')).toEqual([]);
  });

  it('does not fire on ordinary prose negation with no existence claim near it', () => {
    expect(detectFactAbsenceClaims('This is not the preferred approach for new plans.')).toEqual([]);
    expect(detectFactAbsenceClaims('Prefer a library over rolling your own; none of that is urgent work.')).toEqual([]);
  });

  it('does not mistake a normative must-not rule for an observed absence', () => {
    const rule = 'Oversized metadata overflow must not refuse the result.';
    expect(detectFactAbsenceClaims(rule), rule).toEqual([]);
    expect(detectFactAbsenceClaims('The result was not emitted.')).not.toEqual([]);
  });

  it('does not mistake an imperative do-not instruction for an observed absence', () => {
    const rule =
      'Do not draft or send from that listing alone, while the original recipient probe recorded a historical CATCH_ALL result.';
    expect(detectFactAbsenceClaims(rule), rule).toEqual([]);
    expect(detectFactAbsenceClaims('The original recipient probe did not record a CATCH_ALL result.')).not.toEqual(
      [],
    );
    expect(detectFactAbsenceClaims('I do not record a CATCH_ALL result.')).not.toEqual([]);
  });

  it('keeps a literal scheduler sentinel separate from an unrelated nearby match', () => {
    const body = 'Scheduler read-back: none [mq-deadline]; installed script matches the source SHA-256.';
    expect(detectFactAbsenceClaims(body)).toEqual([]);
    expect(factAbsenceHint(body)).toBeNull();
    expect(detectFactAbsenceClaims('none of the active scheduler entries matched the policy')).not.toEqual([]);
  });

  it('is fail-soft on non-string and empty input, like the measurement scan', () => {
    expect(detectFactAbsenceClaims(undefined)).toEqual([]);
    expect(detectFactAbsenceClaims(null)).toEqual([]);
    expect(detectFactAbsenceClaims(42)).toEqual([]);
    expect(detectFactAbsenceClaims('')).toEqual([]);
  });

  it('renders a null clean case and an advisory naming the instrument risk', () => {
    expect(formatFactAbsenceHint([])).toBeNull();
    const hint = factAbsenceHint('no membership exists for this agent')!;
    expect(hint).toContain('ttlSec');
    expect(hint).toContain('falsifier');
    expect(hint).toMatch(/instrument/i);
    expect(hint).toMatch(/write succeeded|nothing was blocked/i);
  });
});
