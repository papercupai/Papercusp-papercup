import { describe, expect, it } from 'vitest';
import { FLAGS } from '@papercusp/flags';
import { GLOBAL_FLAG_OVERRIDES_WORKSPACE_ID } from './flag-override-store';
import { collectDarkFlagFindings } from '../../../scripts/audit-dark-flags-live-state';

const key = FLAGS.CAPABILITY_EXEC_SANDBOX;
const legacy = { workspace_id: 'generic-test', payload: { [key]: true } };
const global = (payload: Record<string, boolean> | null) => ({ workspace_id: GLOBAL_FLAG_OVERRIDES_WORKSPACE_ID, payload });

describe('maintained dark flag live-state audit resolution', () => {
  it('does not report legacy true values hidden by an empty global row', () => {
    const result = collectDarkFlagFindings([legacy, global({})], {});
    expect(result.critical).toEqual([]);
    expect(result.effectiveOverrideWorkspaces).toEqual([GLOBAL_FLAG_OVERRIDES_WORKSPACE_ID]);
    expect(result.shadowedWorkspaceOverrides).toEqual(['generic-test']);
  });

  it('reports the legacy value while no global map exists', () => {
    const result = collectDarkFlagFindings([legacy], {});
    expect(result.critical).toEqual([expect.objectContaining({ key, workspace: 'generic-test', via: 'override' })]);
    expect(result.shadowedWorkspaceOverrides).toEqual([]);
  });

  it('preserves the production fallback for a null global payload', () => {
    expect(collectDarkFlagFindings([global(null), legacy], {}).critical).toEqual([
      expect.objectContaining({ key, workspace: 'generic-test' }),
    ]);
  });

  it('honors a false global value over a true legacy value', () => {
    expect(collectDarkFlagFindings([legacy, global({ [key]: false })], {}).critical).toEqual([]);
  });

  it('reports a true global value once instead of duplicating it across shadowed rows', () => {
    expect(collectDarkFlagFindings([legacy, global({ [key]: true })], {}).critical).toEqual([
      expect.objectContaining({ key, workspace: GLOBAL_FLAG_OVERRIDES_WORKSPACE_ID, via: 'override' }),
    ]);
  });

  it('honors an explicit false env override over a true stored value', () => {
    const envKey = `PAPERCUSP_FLAG_${key.toUpperCase().replace(/-/g, '_')}`;
    expect(collectDarkFlagFindings([global({ [key]: true })], { [envKey]: 'false' }).critical).toEqual([]);
  });

  it('reports an explicit true env override over a false stored value', () => {
    const envKey = `PAPERCUSP_FLAG_${key.toUpperCase().replace(/-/g, '_')}`;
    expect(collectDarkFlagFindings([global({ [key]: false }), legacy], { [envKey]: '1' }).critical).toEqual([
      expect.objectContaining({ key, workspace: '(env, this process)', via: 'env' }),
    ]);
  });
});
