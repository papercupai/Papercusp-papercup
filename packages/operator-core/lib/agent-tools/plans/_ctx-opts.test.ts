/**
 * Unit coverage for the ctx → plan-source-opts resolver (_ctx-opts.ts).
 *
 * The load-bearing case is the SU wildcard `'*'` (set by http-projection on
 * `?superuser=1` with no `?harness=`): it must collapse to "no harness in scope"
 * (resolveCtxHarnessSlug → undefined; ctxToPlanSourceOpts → the papercup default)
 * — passing `'*'` through unfiltered would make the downstream PG queries match
 * nothing instead of the papercup-default plans.
 */
import { describe, it, expect } from 'vitest';
import { resolveCtxHarnessSlug, ctxToPlanSourceOpts } from './_ctx-opts';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';

describe('resolveCtxHarnessSlug', () => {
  it.each([null, undefined])('treats nullish context %j as absent', ctx => {
    expect(resolveCtxHarnessSlug(ctx)).toBeUndefined();
  });

  it('returns undefined for empty / missing / whitespace / wildcard scope', () => {
    expect(resolveCtxHarnessSlug({})).toBeUndefined();
    expect(resolveCtxHarnessSlug({ harnessSlug: '' })).toBeUndefined();
    expect(resolveCtxHarnessSlug({ harnessSlug: '   ' })).toBeUndefined();
    expect(resolveCtxHarnessSlug({ harnessSlug: '*' })).toBeUndefined(); // SU wildcard ≠ a real harness
  });

  it('returns the trimmed slug for a real harness', () => {
    expect(resolveCtxHarnessSlug({ harnessSlug: 'my-harness' })).toBe('my-harness');
    expect(resolveCtxHarnessSlug({ harnessSlug: '  spaced  ' })).toBe('spaced');
  });

  it('tolerates a primitive ctx with no harnessSlug field', () => {
    expect(resolveCtxHarnessSlug(42)).toBeUndefined();
  });
});

describe('ctxToPlanSourceOpts', () => {
  const HOME = operatorHomeHarnessSlug(); // 'papercusp' (post-migration default)
  it.each([null, undefined])('defaults nullish context %j to the operator-home harness', async ctx => {
    expect(await ctxToPlanSourceOpts(ctx)).toEqual({ harnessSlug: HOME });
  });

  it('defaults to the operator-home harness for empty / wildcard / home scope', async () => {
    expect(await ctxToPlanSourceOpts({})).toEqual({ harnessSlug: HOME });
    expect(await ctxToPlanSourceOpts({ harnessSlug: '*' })).toEqual({ harnessSlug: HOME });
    expect(await ctxToPlanSourceOpts({ harnessSlug: HOME })).toEqual({ harnessSlug: HOME });
  });

  it('threads a real harness slug through (trimmed)', async () => {
    expect(await ctxToPlanSourceOpts({ harnessSlug: 'web' })).toEqual({ harnessSlug: 'web' });
    expect(await ctxToPlanSourceOpts({ harnessSlug: '  web  ' })).toEqual({ harnessSlug: 'web' });
  });

  it.each(['*', HOME, 'web'])('retains the admitted concrete workspace for harness %s', async harnessSlug => {
    expect(await ctxToPlanSourceOpts({ harnessSlug, workspaceId: '  private-plan-workspace  ' }))
      .toEqual({ harnessSlug: harnessSlug === '*' ? HOME : harnessSlug, workspaceId: 'private-plan-workspace' });
  });

  it.each(['*', '', '   '])('omits an unbound workspace %j instead of treating it as a concrete PG key', async workspaceId => {
    expect(await ctxToPlanSourceOpts({ harnessSlug: HOME, workspaceId })).toEqual({ harnessSlug: HOME });
  });
});
