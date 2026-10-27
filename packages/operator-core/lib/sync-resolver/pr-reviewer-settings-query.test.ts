import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildPrReviewerSettingsResponse = vi.fn();

vi.mock('../endpoint-route/routes/harness/pr-reviewer-settings', () => ({
  buildPrReviewerSettingsResponse,
}));

import { knownQueryNamesV2, resolveNamedQueryV2 } from './index';
import { TABLE_TO_QUERY_NAMES, queryNamesForTriggerEvent } from './table-to-query-names';

describe('prReviewerSettings.byHarness named query (WI-4138)', () => {
  const RESP = {
    settings: { pr_reviewer_role_enabled: true, auto_review: false, auto_merge: false, merge_method: 'squash' },
    trustList: [],
    audit: [],
    viewer: { github_user_id: 1, github_login: 'ada' },
    editable: true,
    claimOwner: true,
    autoModeEditable: true,
    inheritedFrom: null,
    grantedByOwnership: false,
  };

  beforeEach(() => {
    buildPrReviewerSettingsResponse.mockReset().mockResolvedValue(RESP);
  });

  it('registers and resolves the single-row-per-harness response, trimmed', async () => {
    expect(knownQueryNamesV2()).toContain('prReviewerSettings.byHarness');

    await expect(
      resolveNamedQueryV2('prReviewerSettings.byHarness', { harnessSlug: '  papercusp  ' }),
    ).resolves.toEqual([RESP]);
    expect(buildPrReviewerSettingsResponse).toHaveBeenCalledWith('papercusp');
  });

  it('rejects an empty/blank harnessSlug', async () => {
    await expect(resolveNamedQueryV2('prReviewerSettings.byHarness', { harnessSlug: '  ' })).rejects.toBeTruthy();
    expect(buildPrReviewerSettingsResponse).not.toHaveBeenCalled();
  });

  it('bridges its 3 contributing tables (pr_reviewer_settings / trusted_authors / auto_review_audit)', () => {
    // harnessPrs.detail (the PR viewer) also reads pr_reviewer_settings, so a settings write busts it too.
    expect(TABLE_TO_QUERY_NAMES['harness_shared.pr_reviewer_settings']).toEqual([
      'prReviewerSettings.byHarness',
      'harnessPrs.detail',
    ]);
    expect(TABLE_TO_QUERY_NAMES['harness_shared.trusted_authors']).toEqual(['prReviewerSettings.byHarness']);
    expect(TABLE_TO_QUERY_NAMES['harness_shared.auto_review_audit']).toEqual(
      expect.arrayContaining(['contributors.byHarness', 'prReviewerSettings.byHarness']),
    );

    // Full-bust (no scoped natural key on these viewer-keyed tables today) —
    // the bridge emits the bare name regardless of the trigger's row id.
    expect(queryNamesForTriggerEvent('harness_shared.pr_reviewer_settings.changed', { id: '7' })).toEqual([
      'prReviewerSettings.byHarness',
      'harnessPrs.detail',
    ]);
    expect(queryNamesForTriggerEvent('harness_shared.trusted_authors.changed', { id: '9' })).toEqual([
      'prReviewerSettings.byHarness',
    ]);
    expect(queryNamesForTriggerEvent('harness_shared.auto_review_audit.changed', { id: '3' })).toEqual([
      'contributors.byHarness',
      'prReviewerSettings.byHarness',
    ]);
  });
});
