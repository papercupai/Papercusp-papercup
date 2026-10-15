/**
 * WI-10006010 — the pure half of physical-row pinning. The DB-backed proof that a write leaves
 * every slug twin byte-identical lives in issues-engineer.integration.test.ts.
 *
 * P-013 (plan scope-unique-identifiers-2026-07-26, requirement R-5): a by-id lookup without a
 * harness never chooses among several rows by recency; it refuses with the candidates.
 */
import { describe, expect, it } from 'vitest';
import {
  WorkItemIdAmbiguousError,
  WorkItemWorkspaceAmbiguousError,
  assertWorkspaceChoice,
  choosePhysicalSlug,
  harnessPreference,
  harnessSlugMatches,
  isWorkItemIdAmbiguousError,
  pickPhysicalSlug,
  stripTwinCensus,
} from './work-items-physical-row';

describe('harnessPreference', () => {
  it('treats blank, null and the * wildcard as no preference', () => {
    expect(harnessPreference(undefined)).toBeNull();
    expect(harnessPreference(null)).toBeNull();
    expect(harnessPreference('  ')).toBeNull();
    expect(harnessPreference('*')).toBeNull();
    expect(harnessPreference(' papercusp ')).toBe('papercusp');
  });
});

describe('harnessSlugMatches', () => {
  it('matches bare, prefixed and verbatim non-harness slugs', () => {
    expect(harnessSlugMatches('papercusp', 'papercusp')).toBe(true);
    expect(harnessSlugMatches('harness:papercusp', 'papercusp')).toBe(true);
    expect(harnessSlugMatches('papercusp', 'harness:papercusp')).toBe(true);
    expect(harnessSlugMatches('operator:papercusp-workspace', 'operator:papercusp-workspace')).toBe(true);
  });

  it('control: does not match a different harness or a prefix of one', () => {
    expect(harnessSlugMatches('operator:papercusp-workspace', 'papercusp')).toBe(false);
    expect(harnessSlugMatches('papercusp-public-site-pot', 'papercusp')).toBe(false);
  });
});

describe('pickPhysicalSlug', () => {
  // Ordered as resolveIssuePhysicalSlug returns them: most recently updated first.
  const twins = ['operator:papercusp-workspace', 'papercusp'];

  it('pins the named harness even when it is not the most recent row', () => {
    expect(pickPhysicalSlug(twins, 'papercusp')).toBe('papercusp');
    expect(pickPhysicalSlug(twins, 'harness:papercusp')).toBe('papercusp');
    expect(pickPhysicalSlug(twins, 'operator:papercusp-workspace')).toBe('operator:papercusp-workspace');
  });

  it('R-5: refuses twins when no harness, a wildcard, or a non-matching harness is named — never picks the most recent', () => {
    for (const harness of [undefined, null, '*', 'some-other-pot']) {
      let thrown: unknown;
      try {
        pickPhysicalSlug(twins, harness, { id: 'WI-1', workspaceId: 'ws-a' });
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `harness=${String(harness)}`).toBeInstanceOf(WorkItemIdAmbiguousError);
      const err = thrown as WorkItemIdAmbiguousError;
      expect(err.code).toBe('work_item_id_ambiguous');
      expect(err.id).toBe('WI-1');
      expect(err.workspaceId).toBe('ws-a');
      expect(err.candidates).toEqual(['operator:papercusp-workspace', 'papercusp']);
      expect(err.message).toContain('Pass harness');
    }
  });

  it('a loosely passed harness never turns a single-row id into "not found"', () => {
    expect(pickPhysicalSlug(['papercusp'], 'some-other-pot')).toBe('papercusp');
    expect(pickPhysicalSlug(['papercusp'])).toBe('papercusp');
  });

  it('returns null only when the id has no row', () => {
    expect(pickPhysicalSlug([], 'papercusp')).toBeNull();
    expect(pickPhysicalSlug([])).toBeNull();
  });
});

describe('choosePhysicalSlug (P-013 / R-5)', () => {
  it('a single row is unique whatever harness is passed', () => {
    expect(choosePhysicalSlug(['papercusp'])).toEqual({ kind: 'unique', slug: 'papercusp' });
    expect(choosePhysicalSlug(['papercusp'], 'email')).toEqual({ kind: 'unique', slug: 'papercusp' });
    // A census that repeats one slug is still one physical slug.
    expect(choosePhysicalSlug(['papercusp', 'papercusp'])).toEqual({ kind: 'unique', slug: 'papercusp' });
  });

  it('a named harness that matches exactly one twin picks it and reports the others', () => {
    expect(choosePhysicalSlug(['papercup', 'papercusp'], 'harness:papercusp')).toEqual({
      kind: 'named',
      slug: 'papercusp',
      twins: ['papercup'],
    });
  });

  it('the decision is independent of input order, so recency cannot leak into it', () => {
    const a = choosePhysicalSlug(['papercusp', 'papercup']);
    const b = choosePhysicalSlug(['papercup', 'papercusp']);
    expect(a).toEqual({ kind: 'ambiguous', candidates: ['papercup', 'papercusp'] });
    expect(b).toEqual(a);
  });

  it('a harness that matches several twins (bare and prefixed forms) is still ambiguous', () => {
    expect(choosePhysicalSlug(['harness:papercusp', 'papercusp'], 'papercusp')).toEqual({
      kind: 'ambiguous',
      candidates: ['harness:papercusp', 'papercusp'],
    });
  });

  it('no rows is none', () => {
    expect(choosePhysicalSlug([])).toEqual({ kind: 'none' });
  });
});

describe('assertWorkspaceChoice (cross-workspace half, WI-6554700010008365)', () => {
  it('refuses a fallback from the ambient workspace to one of several others, naming them sorted', () => {
    let caught: unknown;
    try {
      assertWorkspaceChoice('WI-7', 'ambient', 'ws-b', ['ws-b', 'ws-a', 'ws-b']);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkItemWorkspaceAmbiguousError);
    // Same code as the harness twin refusal, so every existing handler surfaces it.
    expect(isWorkItemIdAmbiguousError(caught)).toBe(true);
    expect(caught).toMatchObject({ code: 'work_item_id_ambiguous', scope: 'workspace', candidates: ['ws-a', 'ws-b'] });
    expect((caught as Error).message).toContain("not in the current workspace 'ambient'");
  });

  it('passes a choice in the ambient workspace, the only foreign holder, or no row at all', () => {
    expect(() => assertWorkspaceChoice('WI-7', 'ambient', 'ambient', ['ambient', 'ws-a'])).not.toThrow();
    expect(() => assertWorkspaceChoice('WI-7', 'ambient', 'ws-a', ['ws-a', 'ws-a'])).not.toThrow();
    expect(() => assertWorkspaceChoice('WI-7', 'ambient', null, null)).not.toThrow();
  });

  it('control: a harness twin refusal keeps scope "harness"', () => {
    expect(new WorkItemIdAmbiguousError('WI-7', 'ws', ['a', 'b'], null).scope).toBe('harness');
  });
});

describe('stripTwinCensus (the by-id READ side of R-5)', () => {
  const row = { issue_id: 'WI-7', title: 't' };

  it('strips the census and returns the row when the id has one physical row', () => {
    expect(stripTwinCensus('WI-7', { ...row, __ws: 'ws', __ws_slugs: ['papercusp'] })).toEqual(row);
    // A row read without a census (a mocked or legacy read) is treated as unique.
    expect(stripTwinCensus('WI-7', { ...row })).toEqual(row);
  });

  it('returns the named twin when the caller harness picks exactly one', () => {
    expect(
      stripTwinCensus('WI-7', { ...row, __ws: 'ws', __ws_slugs: ['papercup', 'papercusp'] }, 'papercusp'),
    ).toEqual(row);
  });

  it('refuses twins without a disambiguating harness instead of returning the first (most recent) row', () => {
    expect(() => stripTwinCensus('WI-7', { ...row, __ws: 'ws', __ws_slugs: ['papercusp', 'papercup'] })).toThrow(
      WorkItemIdAmbiguousError,
    );
    try {
      stripTwinCensus('WI-7', { ...row, __ws: 'ws', __ws_slugs: ['papercusp', 'papercup'] }, 'email');
    } catch (err) {
      expect(err).toMatchObject({ id: 'WI-7', workspaceId: 'ws', candidates: ['papercup', 'papercusp'], harness: 'email' });
    }
  });
});

describe('isWorkItemIdAmbiguousError', () => {
  it('recognises the class and a structurally identical copy from a split module', () => {
    expect(isWorkItemIdAmbiguousError(new WorkItemIdAmbiguousError('WI-1', null, ['a', 'b'], null))).toBe(true);
    expect(isWorkItemIdAmbiguousError({ code: 'work_item_id_ambiguous', candidates: ['a', 'b'] })).toBe(true);
  });

  it('control: rejects other errors', () => {
    expect(isWorkItemIdAmbiguousError(new Error('work_item_id_ambiguous'))).toBe(false);
    expect(isWorkItemIdAmbiguousError({ code: 'work_item_id_ambiguous' })).toBe(false);
    expect(isWorkItemIdAmbiguousError(null)).toBe(false);
  });
});
