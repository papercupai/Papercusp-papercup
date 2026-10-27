import { beforeEach, describe, expect, it, vi } from 'vitest';

const getBeaconPublishConsent = vi.fn();

vi.mock('../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-test',
}));
vi.mock('../beacon-consent', () => ({
  getBeaconPublishConsent,
}));

import { knownQueryNamesV2, resolveNamedQueryV2 } from './index';
import { TABLE_TO_QUERY_NAMES, queryNamesForTriggerEvent } from './table-to-query-names';

describe('hive.beaconConsent named query (WI-4137)', () => {
  beforeEach(() => {
    getBeaconPublishConsent.mockReset().mockResolvedValue(true);
  });

  it('registers and resolves an ID-scoped consent row', async () => {
    expect(knownQueryNamesV2()).toContain('hive.beaconConsent');

    await expect(resolveNamedQueryV2('hive.beaconConsent', { potId: 'acme-hive' })).resolves.toEqual([
      { potId: 'acme-hive', consent: true },
    ]);
    expect(getBeaconPublishConsent).toHaveBeenCalledWith('ws-test', 'acme-hive');
  });

  it('defaults failed reads to OFF without breaking the header query', async () => {
    getBeaconPublishConsent.mockRejectedValue(new Error('settings unavailable'));

    await expect(resolveNamedQueryV2('hive.beaconConsent', { potId: 'acme-hive' })).resolves.toEqual([
      { potId: 'acme-hive', consent: false },
    ]);
  });

  it('bridges pot_settings writes to the matching query key', () => {
    expect(TABLE_TO_QUERY_NAMES['harness_shared.pot_settings']).toEqual(
      expect.arrayContaining(['hive.steering', expect.objectContaining({ name: 'hive.beaconConsent' })]),
    );
    expect(queryNamesForTriggerEvent('harness_shared.pot_settings.changed', { harness_slug: 'acme-hive' })).toEqual([
      // The pot directory reads pot_settings (hive-directory sharing flags), so it full-busts first.
      'network.hiveDirectory',
      'hive.steering',
      'learning.dream',
      { name: 'hive.beaconConsent', args: { potId: 'acme-hive' } },
      // pot-review-integration-mode P-017 (EI-25188362216785598): the integration-mode settings
      // section reads pot_settings too; it full-busts because its args are the harness slug.
      'potIntegration.settings',
    ]);
  });
});
