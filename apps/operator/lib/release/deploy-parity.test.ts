/**
 * P-015 deploy honesty (gate-verdict-liveness-and-repair-reliability-2026-08-31,
 * D-002/D-004) — recordDeployParity drives every branch against injected
 * fixtures per D-004's verification contract: simulated force-deploy facts and
 * simulated tested/deployed divergence, no PG, no coord, no git.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  recordDeployParity,
  deployParityRefs,
  realDeployParityDeps,
  deployParityConditionKey,
  DEPLOY_PARITY_FACT_KEY,
  type DeployParityDeps,
  type DeployParityEvent,
} from './deploy-parity';

const SHA = 'abc123def4567890abc123def4567890abc123de';

function makeDeps(over: Partial<DeployParityDeps> = {}): DeployParityDeps {
  return {
    assertFact: vi.fn(async () => ({})),
    retractFact: vi.fn(async () => true),
    broadcastSevereEvent: vi.fn(async () => true),
    broadcastSevereEventResolved: vi.fn(async () => true),
    hasOpenParityCondition: vi.fn(async () => false),
    factKeyState: vi.fn(async () => 'not-found'),
    readRefUnification: vi.fn(async () => ({
      localRef: 'main', originRef: 'refs/remotes/origin/main', localSha: SHA, originSha: SHA, unified: true as const,
    })),
    now: () => new Date('2026-09-01T07:00:00Z'),
    ...over,
  };
}

describe('deployParityRefs', () => {
  it('uses the configured release ref and derives its origin tracking ref', () => {
    expect(deployParityRefs('refs/heads/release-candidate')).toEqual({
      localRef: 'refs/heads/release-candidate',
      originRef: 'refs/remotes/origin/release-candidate',
    });
    expect(deployParityRefs('refs/remotes/upstream/release')).toEqual({
      localRef: 'refs/remotes/upstream/release',
      originRef: 'refs/remotes/upstream/release',
    });
  });

  it('real ref verification follows release-config when it names a non-main branch', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'deploy-parity-release-ref-'));
    const previousReleaseRef = process.env.PAPERCUSP_RELEASE_REF;
    process.env.PAPERCUSP_RELEASE_REF = 'refs/heads/release-candidate';
    try {
      execFileSync('git', ['init', '--quiet', '-b', 'release-candidate', root]);
      execFileSync('git', ['-C', root, 'config', 'user.name', 'Papercusp test']);
      execFileSync('git', ['-C', root, 'config', 'user.email', 'papercusp-test@example.invalid']);
      writeFileSync(join(root, 'tracked.txt'), 'release ref fixture\n');
      execFileSync('git', ['-C', root, 'add', 'tracked.txt']);
      execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'fixture']);
      const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['-C', root, 'update-ref', 'refs/remotes/origin/release-candidate', sha]);

      const deps = await realDeployParityDeps();
      await expect(deps.readRefUnification(root)).resolves.toEqual({
        localRef: 'refs/heads/release-candidate',
        originRef: 'refs/remotes/origin/release-candidate',
        localSha: sha,
        originSha: sha,
        unified: true,
      });
    } finally {
      if (previousReleaseRef === undefined) delete process.env.PAPERCUSP_RELEASE_REF;
      else process.env.PAPERCUSP_RELEASE_REF = previousReleaseRef;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function makeEvent(over: Partial<DeployParityEvent> = {}): DeployParityEvent {
  return {
    ok: true,
    green: false,
    targetSha: SHA,
    installSlug: 'papercusp',
    integrationRoot: '/tmp/integration',
    ...over,
  };
}

describe('deployParityConditionKey', () => {
  it('is harness-scoped and stable', () => {
    expect(deployParityConditionKey('papercusp')).toBe('deploy-parity:papercusp');
  });
});

describe('recordDeployParity — failed deploy', () => {
  it('changes nothing (rollback restores the prior state, parity unchanged)', async () => {
    const deps = makeDeps();
    await recordDeployParity(makeEvent({ ok: false, green: false }), deps);
    await recordDeployParity(makeEvent({ ok: false, green: true }), deps);
    expect(deps.assertFact).not.toHaveBeenCalled();
    expect(deps.broadcastSevereEvent).not.toHaveBeenCalled();
    expect(deps.broadcastSevereEventResolved).not.toHaveBeenCalled();
    expect(deps.retractFact).not.toHaveBeenCalled();
  });
});

describe('recordDeployParity — FORCED (un-green) success', () => {
  it('asserts the standing fact AND opens the deploy-parity condition', async () => {
    const deps = makeDeps();
    await recordDeployParity(makeEvent(), deps);

    expect(deps.assertFact).toHaveBeenCalledTimes(1);
    const fact = vi.mocked(deps.assertFact).mock.calls[0][0];
    expect(fact.scope).toBe('harness');
    expect(fact.scopeRef).toBe('papercusp');
    expect(fact.key).toBe(DEPLOY_PARITY_FACT_KEY);
    expect(fact.body).toContain(SHA.slice(0, 12));
    expect(fact.body).toContain('tested≠deployed');
    expect(fact.body).toContain('FORCE-DEPLOY');

    expect(deps.broadcastSevereEvent).toHaveBeenCalledTimes(1);
    const ev = vi.mocked(deps.broadcastSevereEvent).mock.calls[0][0];
    expect(ev.conditionKey).toBe('deploy-parity:papercusp');
    expect(ev.summary).toContain('UNTESTED');
    // the harness slug survives inbox truncation: named in summary more than once
    expect(ev.summary.split('papercusp').length).toBeGreaterThan(2);

    expect(deps.broadcastSevereEventResolved).not.toHaveBeenCalled();
    expect(deps.retractFact).not.toHaveBeenCalled();
  });

  it('one failing leg never suppresses the other (independent best-effort guards)', async () => {
    const deps = makeDeps({ assertFact: vi.fn(async () => Promise.reject(new Error('pg down'))) });
    await expect(recordDeployParity(makeEvent(), deps)).resolves.toBeUndefined();
    expect(deps.broadcastSevereEvent).toHaveBeenCalledTimes(1);
  });
});

describe('recordDeployParity — GENUINE GREEN success', () => {
  it('with the condition open: resolves it, retracts the fact, and never re-alarms', async () => {
    const deps = makeDeps({ hasOpenParityCondition: vi.fn(async () => true) });
    await recordDeployParity(makeEvent({ green: true }), deps);

    expect(deps.broadcastSevereEventResolved).toHaveBeenCalledTimes(1);
    const res = vi.mocked(deps.broadcastSevereEventResolved).mock.calls[0][0];
    expect(res.conditionKey).toBe('deploy-parity:papercusp');
    expect(res.summary).toContain('RESTORED');
    expect(res.summary).toContain('Refs unified');

    expect(deps.retractFact).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.retractFact).mock.calls[0][0].key).toBe(DEPLOY_PARITY_FACT_KEY);
    expect(deps.broadcastSevereEvent).not.toHaveBeenCalled();
    expect(deps.assertFact).not.toHaveBeenCalled();
  });

  it('with NOTHING open (the routine auto-serve green): does nothing — no resolve spam', async () => {
    const deps = makeDeps(); // condition closed, fact not-found
    await recordDeployParity(makeEvent({ green: true }), deps);
    expect(deps.broadcastSevereEventResolved).not.toHaveBeenCalled();
    expect(deps.retractFact).not.toHaveBeenCalled();
  });

  it('condition closed but the fact still live: clears via the fallback guard', async () => {
    const deps = makeDeps({ factKeyState: vi.fn(async () => 'live') });
    await recordDeployParity(makeEvent({ green: true }), deps);
    expect(deps.broadcastSevereEventResolved).toHaveBeenCalledTimes(1);
    expect(deps.retractFact).toHaveBeenCalledTimes(1);
  });

  it('condition probe unreadable but the fact live: still clears (guard falls through)', async () => {
    const deps = makeDeps({
      hasOpenParityCondition: vi.fn(async () => Promise.reject(new Error('pg down'))),
      factKeyState: vi.fn(async () => 'live'),
    });
    await recordDeployParity(makeEvent({ green: true }), deps);
    expect(deps.broadcastSevereEventResolved).toHaveBeenCalledTimes(1);
  });

  it('NEITHER guard readable: does nothing rather than spam', async () => {
    const deps = makeDeps({
      hasOpenParityCondition: vi.fn(async () => Promise.reject(new Error('pg down'))),
      factKeyState: vi.fn(async () => Promise.reject(new Error('pg down'))),
    });
    await recordDeployParity(makeEvent({ green: true }), deps);
    expect(deps.broadcastSevereEventResolved).not.toHaveBeenCalled();
    expect(deps.retractFact).not.toHaveBeenCalled();
  });

  it('refs NOT unified: reports the divergence + the laundering warning, never an all-clear', async () => {
    const deps = makeDeps({
      hasOpenParityCondition: vi.fn(async () => true),
      readRefUnification: vi.fn(async () => ({
        localRef: 'refs/heads/release-candidate',
        originRef: 'refs/remotes/origin/release-candidate',
        localSha: 'a2d69cef50d5e5dbce0931767a8ff2c005a9c40c',
        originSha: 'c26586dd4bc4916e6707b06b8a2f0b190df0094e',
        unified: false as const,
      })),
    });
    await recordDeployParity(makeEvent({ green: true }), deps);
    const res = vi.mocked(deps.broadcastSevereEventResolved).mock.calls[0][0];
    expect(res.summary).toContain('NOT unified');
    expect(res.summary).toContain('launder');
    expect(res.summary).not.toContain('Refs unified:');
  });

  it('refs unreadable: says UNVERIFIED — never claims unified from a failed probe', async () => {
    const deps = makeDeps({
      hasOpenParityCondition: vi.fn(async () => true),
      readRefUnification: vi.fn(async () => Promise.reject(new Error('git gone'))),
    });
    await recordDeployParity(makeEvent({ green: true }), deps);
    const res = vi.mocked(deps.broadcastSevereEventResolved).mock.calls[0][0];
    expect(res.summary).toContain('UNVERIFIED');
    expect(res.summary).not.toContain('Refs unified:');
  });
});
