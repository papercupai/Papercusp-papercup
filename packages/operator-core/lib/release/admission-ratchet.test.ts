/**
 * green-main-ratchet-convergence-2026-10-17 P-006 / R-5 — the admission ratchet.
 *
 * Each case pins one clause of the R-5 falsifier: an admission that turns a passing test red, or
 * adds a new failing test, never advances the repair head; the refusal names the attributed tests
 * and is routed to the admitting actor; an admission adding no new failure is never rejected by
 * the ratchet. The S3 shape (a fix for one red turns a previously green test red) is a fixture.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateAdmissionRatchet,
  impliedPreviousHead,
  ratchetAllowsPublication,
} from './admission-ratchet';
import { evaluateFixPrecheck, precheckPopulation } from './admission-fix-precheck';

const ACTOR = 'su-author-0001';

describe('admission ratchet (P-006, R-5)', () => {
  it('rejects an admission that turns a passing test red (falsifier 1)', () => {
    const d = evaluateAdmissionRatchet({
      admission: { actor: ACTOR },
      radius: ['a.test.ts', 'b.test.ts'],
      previousHead: { 'a.test.ts': 'pass', 'b.test.ts': 'pass' },
      postAdmission: { 'a.test.ts': 'pass', 'b.test.ts': 'fail' },
    });
    expect(d.verdict).toBe('reject');
    if (d.verdict !== 'reject') return;
    expect(d.newFailures).toEqual([{ test: 'b.test.ts', before: 'pass' }]);
  });

  it('rejects an admission that adds a new test which fails (falsifier 2)', () => {
    const d = evaluateAdmissionRatchet({
      admission: { actor: ACTOR },
      radius: ['new.test.ts'],
      previousHead: {},
      postAdmission: { 'new.test.ts': 'fail' },
    });
    expect(d.verdict).toBe('reject');
    if (d.verdict !== 'reject') return;
    expect(d.newFailures).toEqual([{ test: 'new.test.ts', before: 'absent' }]);
  });

  it('names every attributed test in the refusal (falsifier 3)', () => {
    const d = evaluateAdmissionRatchet({
      admission: { actor: ACTOR },
      radius: ['x.test.ts', 'y.test.ts', 'z.test.ts'],
      previousHead: { 'x.test.ts': 'pass', 'y.test.ts': 'fail' },
      postAdmission: { 'x.test.ts': 'fail', 'y.test.ts': 'fail', 'z.test.ts': 'fail' },
    });
    expect(d.verdict).toBe('reject');
    if (d.verdict !== 'reject') return;
    expect(d.newFailures.map((f) => f.test)).toEqual(['x.test.ts', 'z.test.ts']);
    expect(d.message).toContain('x.test.ts');
    expect(d.message).toContain('z.test.ts');
    // y was already red at the previous head: carried, never blamed on this admission.
    expect(d.message).not.toContain('y.test.ts (');
  });

  it('routes the refusal to the admitting actor, and flags an unknown actor (falsifier 4)', () => {
    const base = {
      radius: ['a.test.ts'],
      previousHead: { 'a.test.ts': 'pass' as const },
      postAdmission: { 'a.test.ts': 'fail' as const },
    };
    const known = evaluateAdmissionRatchet({ ...base, admission: { actor: ACTOR } });
    expect(known.verdict === 'reject' && known.routeTo).toEqual({ actor: ACTOR, unattributed: false });
    expect(known.verdict === 'reject' && known.message).toContain(ACTOR);
    const unknown = evaluateAdmissionRatchet({ ...base, admission: { actor: null } });
    expect(unknown.verdict === 'reject' && unknown.routeTo).toEqual({ actor: null, unattributed: true });
  });

  it('accepts an admission that adds no new failure, even when old reds remain (falsifier 5)', () => {
    const d = evaluateAdmissionRatchet({
      admission: { actor: ACTOR },
      radius: ['a.test.ts', 'b.test.ts', 'c.test.ts'],
      previousHead: { 'a.test.ts': 'fail', 'b.test.ts': 'fail', 'c.test.ts': 'pass' },
      postAdmission: { 'a.test.ts': 'pass', 'b.test.ts': 'fail', 'c.test.ts': 'pass' },
    });
    expect(d).toEqual({ verdict: 'accept', carriedFailures: ['b.test.ts'], fixed: ['a.test.ts'] });
  });

  it('S3 shape: a fix that greens its red but turns a green test red is rejected', () => {
    // The admission fixes the signature red (s3-fixed) and breaks a neighbour (s3-neighbour).
    const d = evaluateAdmissionRatchet({
      admission: { actor: ACTOR },
      radius: ['s3-fixed.test.ts', 's3-neighbour.test.ts'],
      previousHead: { 's3-fixed.test.ts': 'fail', 's3-neighbour.test.ts': 'pass' },
      postAdmission: { 's3-fixed.test.ts': 'pass', 's3-neighbour.test.ts': 'fail' },
    });
    expect(d.verdict).toBe('reject');
    if (d.verdict !== 'reject') return;
    expect(d.newFailures).toEqual([{ test: 's3-neighbour.test.ts', before: 'pass' }]);
  });

  it('is inconclusive — never accepting — when a radius test is unmeasured', () => {
    const d = evaluateAdmissionRatchet({
      admission: { actor: ACTOR },
      radius: ['a.test.ts', 'b.test.ts'],
      previousHead: { 'a.test.ts': 'pass', 'b.test.ts': 'pass' },
      postAdmission: { 'a.test.ts': 'pass', 'b.test.ts': 'unmeasured' },
    });
    expect(d.verdict).toBe('inconclusive');
  });

  it('a proven new failure rejects even when another radius test is unmeasured', () => {
    const d = evaluateAdmissionRatchet({
      admission: { actor: ACTOR },
      radius: ['a.test.ts', 'b.test.ts'],
      previousHead: { 'a.test.ts': 'pass', 'b.test.ts': 'pass' },
      postAdmission: { 'a.test.ts': 'fail' },
    });
    expect(d.verdict).toBe('reject');
    if (d.verdict !== 'reject') return;
    expect(d.inconclusive).toEqual(['b.test.ts']);
  });

  it('impliedPreviousHead marks signature files red and guarded radius files green', () => {
    expect(impliedPreviousHead({ signatureTestFiles: ['s.test.ts'], guardedRadius: ['./g.test.ts'] }))
      .toEqual({ 's.test.ts': 'fail', 'g.test.ts': 'pass' });
  });

  it('publication: only a measured result or nothing-to-run publishes; a busy tree defers', () => {
    expect(ratchetAllowsPublication({ ok: true, ran: true })).toBe(true);
    expect(ratchetAllowsPublication({ ok: true, ran: false, reason: 'nothing-to-run' })).toBe(true);
    expect(ratchetAllowsPublication({ ok: true, ran: false, reason: 'checkpoint-tree-busy' })).toBe(false);
    expect(ratchetAllowsPublication({ ok: false, ran: true })).toBe(false);
  });
});

describe('admission ratchet through the R6 pre-check verdict (P-006 wiring)', () => {
  const signature = [{ kind: 'test-file' as const, id: 'red.test.ts' }];

  it('an S3 admission measured on its radius refuses admission-imports-red, routed to the actor', () => {
    const population = precheckPopulation({
      signature,
      admittedPaths: ['src/lib.ts'],
      radius: { status: 'measured', reason: 'ok', guarded: ['neighbour.test.ts'], reportOnly: [], legs: {} },
    });
    const verdict = evaluateFixPrecheck(population, {
      ran: true,
      commit: 'c0ffee000000',
      results: [
        { path: 'red.test.ts', status: 'pass' },
        { path: 'neighbour.test.ts', status: 'fail' },
      ],
    }, { actor: ACTOR });
    expect(verdict.ok).toBe(false);
    if (verdict.ok || !verdict.ran) return;
    expect(verdict.code).toBe('admission-imports-red');
    expect(verdict.importedRed).toEqual(['neighbour.test.ts']);
    expect(verdict.ratchet).toEqual({
      newFailures: [{ test: 'neighbour.test.ts', before: 'pass' }],
      routeTo: { actor: ACTOR, unattributed: false },
    });
    expect(verdict.detail).toContain(ACTOR);
  });

  it('an admitted new test that fails refuses admission-imports-red as a new failing test', () => {
    const population = precheckPopulation({ signature, admittedPaths: ['added.test.ts'] });
    const verdict = evaluateFixPrecheck(population, {
      ran: true,
      commit: 'c0ffee000001',
      results: [
        { path: 'red.test.ts', status: 'pass' },
        { path: 'added.test.ts', status: 'fail' },
      ],
    }, { actor: ACTOR });
    expect(verdict.ok).toBe(false);
    if (verdict.ok || !verdict.ran) return;
    expect(verdict.code).toBe('admission-imports-red');
    expect(verdict.ratchet?.newFailures).toEqual([{ test: 'added.test.ts', before: 'absent' }]);
  });

  it('an admission whose radius was skipped never publishes on the ratchet\'s behalf', () => {
    const population = precheckPopulation({
      signature,
      admittedPaths: ['src/wide.ts'],
      radius: { status: 'skipped', reason: 'over-cap(900/400)', guarded: [], reportOnly: [], legs: {} },
    });
    const verdict = evaluateFixPrecheck(population, {
      ran: true,
      commit: 'c0ffee000002',
      results: [{ path: 'red.test.ts', status: 'pass' }],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok || !verdict.ran) return;
    expect(verdict.code).toBe('admission-precheck-unavailable');
    expect(verdict.detail).toContain('radius was not measured');
  });

  it('an admission that fixes its red and adds nothing new is accepted', () => {
    const population = precheckPopulation({
      signature,
      admittedPaths: ['src/lib.ts'],
      radius: { status: 'measured', reason: 'ok', guarded: ['neighbour.test.ts'], reportOnly: [], legs: {} },
    });
    const verdict = evaluateFixPrecheck(population, {
      ran: true,
      commit: 'c0ffee000003',
      results: [
        { path: 'red.test.ts', status: 'pass' },
        { path: 'neighbour.test.ts', status: 'pass' },
      ],
    }, { actor: ACTOR });
    expect(verdict.ok).toBe(true);
  });
});
