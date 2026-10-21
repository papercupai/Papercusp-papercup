/**
 * WI-6554700010019329 / plan slack-asana-reproduced-bug-fix-pr-workflow-2026-10-08 D-064:
 * a working-copy (review-mode) pot's gate env names the upstream tracking ref, so the
 * gate's selection base judges only the fork's own delta. A direct pot gets nothing new.
 * D-065 (WI-6554700010019417): when the pot names an upstream install, the env also names it,
 * so the gate can inherit non-test legs that install's measured result shows red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const readMode = vi.fn();
const readUpstreamInstall = vi.fn();

vi.mock('../git-sync/pot-integration-mode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git-sync/pot-integration-mode')>();
  return {
    ...actual,
    readPotIntegrationMode: (...args: unknown[]) => readMode(...args),
    readPotUpstreamInstall: (...args: unknown[]) => readUpstreamInstall(...args),
  };
});

import { GATE_UPSTREAM_REF_ENV, WORKING_COPY_INTEGRATION_BRANCH } from '../git-sync/pot-integration-mode';
import { GATE_UPSTREAM_INSTALL_ENV } from '../../release/upstream-inherited-legs';
import { workingCopyGateRefsFor } from './hive-release-env';

describe('workingCopyGateRefsFor (D-064)', () => {
  beforeEach(() => {
    readMode.mockReset();
    readUpstreamInstall.mockReset();
    readUpstreamInstall.mockResolvedValue(null);
  });

  it('gives a review-mode pot its integration branch and the upstream tracking ref env', async () => {
    readMode.mockResolvedValue({ mode: 'review', source: 'set', upstreamBranch: 'staging' });
    const refs = await workingCopyGateRefsFor('ws', { slug: 'papercusp-pr-drill', self_repo: true });
    expect(refs).toEqual({
      integrationBranch: WORKING_COPY_INTEGRATION_BRANCH,
      gateEnv: { [GATE_UPSTREAM_REF_ENV]: 'refs/remotes/origin/staging' },
    });
    expect(readMode).toHaveBeenCalledWith('ws', 'papercusp-pr-drill');
  });

  it('defaults the upstream branch to main when the pot did not set one', async () => {
    readMode.mockResolvedValue({ mode: 'review', source: 'set' });
    const refs = await workingCopyGateRefsFor('ws', { slug: 'member', hive_slug: 'home' });
    expect(refs.gateEnv).toEqual({ [GATE_UPSTREAM_REF_ENV]: 'refs/remotes/origin/main' });
    expect(readMode).toHaveBeenCalledWith('ws', 'home');
  });

  it('adds nothing for a direct pot, and never reads the upstream install', async () => {
    readMode.mockResolvedValue({ mode: 'direct', source: 'set' });
    expect(await workingCopyGateRefsFor('ws', { slug: 'x', self_repo: true })).toEqual({ gateEnv: {} });
    expect(readUpstreamInstall).not.toHaveBeenCalled();
  });

  it('adds nothing, and reads no setting, for a harness with no pot home', async () => {
    expect(await workingCopyGateRefsFor('ws', { slug: 'loose' })).toEqual({ gateEnv: {} });
    expect(readMode).not.toHaveBeenCalled();
  });
});

describe('workingCopyGateRefsFor (D-065 upstream install)', () => {
  beforeEach(() => {
    readMode.mockReset();
    readUpstreamInstall.mockReset();
  });

  it('names the upstream install in the gate env when the review pot sets one', async () => {
    readMode.mockResolvedValue({ mode: 'review', source: 'set', upstreamBranch: 'staging' });
    readUpstreamInstall.mockResolvedValue('papercusp');
    const refs = await workingCopyGateRefsFor('ws', { slug: 'papercusp-pr-drill', self_repo: true });
    expect(refs.gateEnv).toEqual({
      [GATE_UPSTREAM_REF_ENV]: 'refs/remotes/origin/staging',
      [GATE_UPSTREAM_INSTALL_ENV]: 'papercusp',
    });
    expect(readUpstreamInstall).toHaveBeenCalledWith('ws', 'papercusp-pr-drill');
  });

  it('omits the install env when the pot names none (no inheritance)', async () => {
    readMode.mockResolvedValue({ mode: 'review', source: 'set' });
    readUpstreamInstall.mockResolvedValue(null);
    const refs = await workingCopyGateRefsFor('ws', { slug: 'member', hive_slug: 'home' });
    expect(refs.gateEnv).not.toHaveProperty(GATE_UPSTREAM_INSTALL_ENV);
  });
});
