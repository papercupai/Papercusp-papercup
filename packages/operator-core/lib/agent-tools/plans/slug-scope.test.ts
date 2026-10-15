/**
 * Recurrence guard for EI-21194994217912029 — plans:get / plans:items
 * exact-slug scope recovery. The decision logic here IS the fix: a caller
 * holding an exact plan slug with no resolvable harness gets the owning
 * harness RESOLVED (or an error naming what was searched and found) instead
 * of a bare `harness_required` demanding an undiscoverable input.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ planHarnessesForSlugs: vi.fn() }));
vi.mock('./source', () => ({ planHarnessesForSlugs: mocks.planHarnessesForSlugs }));

import * as slugScope from './slug-scope.js';
import {
  decideSlugScope,
  exactPlanSlugsFromArgs,
  harnessMismatchForMiss,
  recoverHarnessFromSlugs,
  slugScopeErrorResult,
  verifyExplicitPlanHarness,
} from './slug-scope.js';

describe('decideSlugScope', () => {
  it('resolves when every requested slug maps to one harness', () => {
    const d = decideSlugScope(['a', 'b'], { a: ['hive-1'], b: ['hive-1'] });
    expect(d).toEqual({ status: 'resolved', harnessSlug: 'hive-1', bySlug: { a: 'hive-1', b: 'hive-1' } });
  });

  // scope-unique-identifiers-2026-07-26 P-006: a slug held by several harnesses
  // used to RESOLVE to the most recently updated one, for reads; only writes
  // refused, through a separate wrapper every caller had to remember.
  it('REFUSES a slug held by more than one harness, naming every candidate', () => {
    const d = decideSlugScope(['a'], { a: ['hive-new', 'hive-old'] }, 'ws-x');
    expect(d).toEqual({
      status: 'ambiguous',
      candidates: { a: ['hive-new', 'hive-old'] },
      workspaceId: 'ws-x',
    });
  });

  it('carries only the ambiguous slugs as candidates when unique slugs ride along', () => {
    const d = decideSlugScope(['a', 'b'], { a: ['hive-1'], b: ['hive-1', 'hive-2'] }, 'ws-x');
    expect(d).toEqual({ status: 'ambiguous', candidates: { b: ['hive-1', 'hive-2'] }, workspaceId: 'ws-x' });
  });

  it('refuses ambiguity even when its newest candidate agrees with every other slug', () => {
    // The old pick (index 0) would have produced a clean 'resolved' here.
    const d = decideSlugScope(['a', 'b'], { a: ['hive-1'], b: ['hive-1', 'hive-2'] });
    expect(d.status).toBe('ambiguous');
  });

  it('reports missing before ambiguous: no harness choice can satisfy a missing slug', () => {
    const d = decideSlugScope(['a', 'gone'], { a: ['hive-1', 'hive-2'] }, 'ws-x');
    expect(d).toEqual({ status: 'missing', missing: ['gone'], found: {}, workspaceId: 'ws-x' });
  });

  it('reports missing slugs alongside what did resolve — never silently drops them', () => {
    const d = decideSlugScope(['a', 'gone'], { a: ['hive-1'] });
    expect(d).toEqual({ status: 'missing', missing: ['gone'], found: { a: 'hive-1' }, workspaceId: '' });
  });

  it('reports a split when slugs span distinct harnesses', () => {
    const d = decideSlugScope(['a', 'b'], { a: ['hive-1'], b: ['hive-2'] }, 'ws-x');
    expect(d).toEqual({ status: 'split', mapping: { a: 'hive-1', b: 'hive-2' }, workspaceId: 'ws-x' });
  });

  it('no production caller wraps the decider: the decider is the only gate', () => {
    // decideSlugScope refuses ambiguity itself; the old requireUnambiguousSlugScope wrapper
    // is gone and must not come back as a second gate a caller could forget.
    const root = path.resolve(__dirname, '..');
    const callers = (fs.readdirSync(root, { recursive: true }) as string[])
      .filter((rel) => rel.endsWith('.ts') && !rel.endsWith('.test.ts'))
      .filter((rel) => fs.readFileSync(path.join(root, rel), 'utf8').includes('requireUnambiguousSlugScope'));
    expect(callers).toEqual([]);
    expect('requireUnambiguousSlugScope' in slugScope).toBe(false);
  });
});

describe('harnessMismatchForMiss', () => {
  beforeEach(() => mocks.planHarnessesForSlugs.mockReset());

  it('explains a miss in a harness that holds none of an ambiguous slug, listing every holder', async () => {
    mocks.planHarnessesForSlugs.mockResolvedValue(new Map([['dup-plan', ['email', 'papercusp']]]));
    const m = await harnessMismatchForMiss({ workspaceId: 'ws-1' }, 'calendar', 'dup-plan', 'explicit');
    expect(m).toMatchObject({ callerHarness: 'calendar', availableHarnesses: ['email', 'papercusp'] });
    expect(m?.reportedHarness).toBeUndefined();
  });

  it('stays silent when the caller harness is one of the ambiguous holders', async () => {
    mocks.planHarnessesForSlugs.mockResolvedValue(new Map([['dup-plan', ['email', 'papercusp']]]));
    await expect(harnessMismatchForMiss({ workspaceId: 'ws-1' }, 'papercusp', 'dup-plan', 'ambient')).resolves.toBeNull();
  });

  it('names the single owner of a unique slug', async () => {
    mocks.planHarnessesForSlugs.mockResolvedValue(new Map([['one-plan', ['email']]]));
    const m = await harnessMismatchForMiss({ workspaceId: 'ws-1' }, 'papercusp', 'one-plan', 'ambient');
    expect(m).toMatchObject({ reportedHarness: 'email', availableHarnesses: ['email'] });
  });
});

describe('recoverHarnessFromSlugs', () => {
  beforeEach(() => mocks.planHarnessesForSlugs.mockReset());

  it('searches the concrete session workspace and returns the resolved scope', async () => {
    mocks.planHarnessesForSlugs.mockResolvedValue(new Map([['my-plan', ['hive-a']]]));
    const d = await recoverHarnessFromSlugs({ workspaceId: 'ws-123' }, ['my-plan']);
    expect(mocks.planHarnessesForSlugs).toHaveBeenCalledWith('ws-123', ['my-plan']);
    expect(d).toMatchObject({
      status: 'resolved',
      harnessSlug: 'hive-a',
      bySlug: { 'my-plan': 'hive-a' },
    });
  });

  it("falls back to the operator's OWN workspace when the session is unscoped ('*')", async () => {
    mocks.planHarnessesForSlugs.mockResolvedValue(new Map());
    const d = await recoverHarnessFromSlugs({ workspaceId: '*' }, ['nope']);
    expect(mocks.planHarnessesForSlugs).toHaveBeenCalledWith('papercusp-workspace', ['nope']);
    // The missing decision carries the workspace actually searched — the error
    // must say WHERE it looked (EI-21194994217912029's "undiscoverable" half).
    expect(d.status === 'missing' && d.workspaceId).toBe('papercusp-workspace');
  });
});

describe('exactPlanSlugsFromArgs', () => {
  it('merges slug and slugs with stable de-duplication and ignores non-identity values', () => {
    expect(
      exactPlanSlugsFromArgs({
        slug: ' primary-plan ',
        slugs: ['secondary-plan', 'primary-plan', '  ', 42, null],
        plan: 'must-not-be-inferred',
      }),
    ).toEqual(['primary-plan', 'secondary-plan']);
  });

  it('reads coord:declare-intent current_plan_slug as an explicit plan identity', () => {
    expect(
      exactPlanSlugsFromArgs({
        current_plan_slug: ' recovered-plan ',
        items: ['P-006'],
        intent: 'continue the bound plan lane',
      }),
    ).toEqual(['recovered-plan']);
  });

  it('returns no scope when the argument is not a plans:get identity object', () => {
    expect(exactPlanSlugsFromArgs(null)).toEqual([]);
    expect(exactPlanSlugsFromArgs({ plan: { slug: 'nested-plan' } })).toEqual([]);
    expect(exactPlanSlugsFromArgs('primary-plan')).toEqual([]);
  });
});

describe('verifyExplicitPlanHarness', () => {
  beforeEach(() => mocks.planHarnessesForSlugs.mockReset());

  it('requires every exact slug to be owned by the explicit harness', async () => {
    mocks.planHarnessesForSlugs.mockResolvedValue(
      new Map([
        ['primary-plan', ['papercusp']],
        ['secondary-plan', ['papercusp', 'legacy-harness']],
      ]),
    );

    await expect(
      verifyExplicitPlanHarness(
        { workspaceId: 'ws-123' },
        'papercusp',
        { slug: 'primary-plan', slugs: ['secondary-plan'] },
      ),
    ).resolves.toBe(true);
    expect(mocks.planHarnessesForSlugs).toHaveBeenCalledWith('ws-123', ['primary-plan', 'secondary-plan']);

    mocks.planHarnessesForSlugs.mockResolvedValue(
      new Map([
        ['primary-plan', ['papercusp']],
        ['secondary-plan', ['other-harness']],
      ]),
    );
    await expect(
      verifyExplicitPlanHarness(
        { workspaceId: 'ws-123' },
        'papercusp',
        { slug: 'primary-plan', slugs: ['secondary-plan'] },
      ),
    ).resolves.toBe(false);
  });

  it('fails closed for missing identity, a blank harness, or an index failure', async () => {
    await expect(verifyExplicitPlanHarness({ workspaceId: 'ws-123' }, 'papercusp', {})).resolves.toBe(false);
    await expect(verifyExplicitPlanHarness({ workspaceId: 'ws-123' }, '  ', { slug: 'primary-plan' })).resolves.toBe(false);

    mocks.planHarnessesForSlugs.mockResolvedValue({
      get: () => {
        throw new Error('workspace index unavailable');
      },
    } as unknown as Map<string, string[]>);
    await expect(
      verifyExplicitPlanHarness({ workspaceId: 'ws-123' }, 'papercusp', { slug: 'primary-plan' }),
    ).resolves.toBe(false);
  });
});

describe('slugScopeErrorResult', () => {
  it('missing → plan_not_found_in_workspace naming the searched workspace + hint', () => {
    const r = slugScopeErrorResult('plans:get', {
      status: 'missing',
      missing: ['ghost-plan'],
      found: {},
      workspaceId: 'ws-9',
    });
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.error).toBe('plan_not_found_in_workspace');
    expect(parsed.missing).toEqual(['ghost-plan']);
    expect(parsed.detail).toContain("'ws-9'");
    expect(parsed.detail).toContain('harness');
  });

  it('split → harness_split_across_plans carrying the slug→harness mapping', () => {
    const r = slugScopeErrorResult('plans:get', {
      status: 'split',
      mapping: { a: 'hive-1', b: 'hive-2' },
      workspaceId: 'ws-9',
    });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.error).toBe('harness_split_across_plans');
    expect(parsed.mapping).toEqual({ a: 'hive-1', b: 'hive-2' });
  });

  it('ambiguous → names every candidate and the workspace, and requires an explicit harness', () => {
    const r = slugScopeErrorResult('plans:get', {
      status: 'ambiguous',
      candidates: { a: ['hive-new', 'hive-old'] },
      workspaceId: 'ws-9',
    });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.error).toBe('plan_slug_ambiguous_across_harnesses');
    expect(parsed.candidates).toEqual({ a: ['hive-new', 'hive-old'] });
    expect(parsed.workspaceId).toBe('ws-9');
    expect(parsed.detail).toContain("'ws-9'");
    expect(parsed.detail).toContain('explicit `harness`');
  });
});
