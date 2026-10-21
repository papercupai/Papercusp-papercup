/**
 * Filing-time deploy-wait advisory (plan staging-build-tool-routing-2026-10-21, R-5 / P-005).
 * A new item that defers non-final work until main/:3070 is deployed gets one advisory line
 * naming the per-call staging route; final, deployed-only, staging-only and negated
 * phrasings get none, so the advisory does not fire on items that legitimately need main.
 */
import { describe, expect, it } from 'vitest';
import { deployWaitAdvisory } from './deploy-wait-advisory';
import { nonFinalDeployWaitClauses } from '../plans/staging-first-activation-guard';

describe('deployWaitAdvisory — fires on a non-final deploy wait', () => {
  it('names build:staging, the tools:find → tools:invoke route, and the post-ship split', () => {
    const text = deployWaitAdvisory(
      'Accept the new rubric tool',
      'Blocked until the fix is deployed to :3070, then run the acceptance check.',
    );
    expect(text).not.toBeNull();
    expect(text).toContain("tools:find { query, build: 'staging' }");
    expect(text).toContain("tools:invoke { name, args, build: 'staging' }");
    expect(text).toContain('SEPARATE post-ship item');
    expect(text).toContain('It was created');
    expect(text).toContain('Blocked until the fix is deployed to :3070');
  });

  it('reads the title too', () => {
    expect(deployWaitAdvisory('Wait for main to carry the change before closing P-004')).not.toBeNull();
  });
});

describe('deployWaitAdvisory — stays silent where waiting on main is legitimate or absent', () => {
  it('final lifecycle work', () => {
    expect(deployWaitAdvisory('Final shipment verification', 'Wait for the :3070 deploy, then verify.')).toBeNull();
  });

  it('a stated deployed-only property with a concrete staging limitation', () => {
    expect(
      deployWaitAdvisory(
        'Check the upgrade path',
        'Wait for the :3070 deploy to check the deployed-only host certificate, because staging cannot present it.',
      ),
    ).toBeNull();
  });

  it('a wait that names only staging', () => {
    expect(deployWaitAdvisory('Re-run the probe', 'Blocked until the staging deploy at :3170 lands.')).toBeNull();
  });

  it('a negated wait', () => {
    expect(deployWaitAdvisory('Ship the fix', 'This must not wait for the :3070 deploy.')).toBeNull();
  });

  it('an item with no deploy language at all', () => {
    expect(deployWaitAdvisory('fix the login race condition', 'The second tab loses its session.')).toBeNull();
  });
});

describe('nonFinalDeployWaitClauses — shared with the blocker and activation guards', () => {
  it('returns the clause that defers the work', () => {
    expect(nonFinalDeployWaitClauses('Do the work. Blocked until main is deployed.')).toEqual([
      'Blocked until main is deployed.',
    ]);
  });
  it('returns nothing for empty text', () => {
    expect(nonFinalDeployWaitClauses('   ')).toEqual([]);
  });
});
