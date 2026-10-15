/**
 * P-015 (plan pot-review-integration-mode-2026-10-05): a working-copy pot must have a
 * REAL test suite. pickPotSuiteCommand resolves it with the gate's precedence
 * (override → releaseGate.greenCmd → testCommand) and NEVER the build fallback.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_GREEN_CMD, pickPotSuiteCommand } from './hive-release-env';

describe('pickPotSuiteCommand', () => {
  it('prefers the owner override over the blueprint knob and the detected testCommand', () => {
    expect(pickPotSuiteCommand({ override: 'npm run ci', greenCmd: 'npm test', testCommand: 'vitest run' })).toBe(
      'npm run ci',
    );
  });

  it('falls back to the blueprint releaseGate.greenCmd when there is no override', () => {
    expect(pickPotSuiteCommand({ override: null, greenCmd: 'npm test', testCommand: 'vitest run' })).toBe('npm test');
  });

  it('falls back to the detected testCommand when neither override nor knob is set', () => {
    expect(pickPotSuiteCommand({ override: null, greenCmd: null, testCommand: 'pytest -q' })).toBe('pytest -q');
  });

  it('returns null, never the build fallback, when the pot has no suite', () => {
    const picked = pickPotSuiteCommand({ override: null, greenCmd: null, testCommand: null });
    expect(picked).toBeNull();
    expect(picked).not.toBe(DEFAULT_GREEN_CMD);
    expect(pickPotSuiteCommand({})).toBeNull();
  });

  it('treats blank strings as unset and trims the chosen command', () => {
    expect(pickPotSuiteCommand({ override: '   ', greenCmd: '', testCommand: '  npm test  ' })).toBe('npm test');
    expect(pickPotSuiteCommand({ override: ' ', greenCmd: ' ', testCommand: ' ' })).toBeNull();
  });
});
