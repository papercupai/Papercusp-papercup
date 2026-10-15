/**
 * pot-integration-mode-suite.integration.test.ts — plan pot-review-integration-mode-2026-10-05,
 * P-015 (spec SPEC-P-015-require-suite; decision D-007).
 *
 * The INTEGRATION leg of "choosing working-copy mode is refused for a pot that has no
 * green-gate test command configured". The unit tests in pot-integration-mode.test.ts
 * pin the guard with injected deps; this file drives the production functions against
 * the REAL hive-settings store (createOrgTestDb, real migrations) and reads the stored
 * row back. The spec's falsifier — "working-copy mode is saved for a pot whose green-gate
 * test command is empty" — is observed directly: if the guard regressed, getHiveSetting
 * would return 'review' and these assertions would fail.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { insertHiveIfAbsent } from '../../hive-store';
import { getHiveSetting } from '../../hive-settings-store';
import {
  choosePotIntegrationMode,
  POT_INTEGRATION_SETTING_KEY,
  setPotIntegrationMode,
} from './pot-integration-mode';
import { findStandingPr } from './standing-pr';
import { STANDING_PR_BRANCH } from './decide-standing-pr';
import type { Pr } from '../../pr-host/types';

const WS = 'ws-p015';
const pk = (fill: number): string => Buffer.alloc(32, fill).toString('base64');
const FORK = 'https://github.com/pot-owner/repo.git';
/** FORK as the "owner/repo" GitHub reports in a PR's head.repo.full_name. */
const FORK_REPO = 'pot-owner/repo';

describe('SPEC-P-015-require-suite — working-copy mode needs a test suite (real hive-settings store)', () => {
  let db: OrgTestDb;
  let sql: Sql;

  beforeAll(async () => {
    db = await createOrgTestDb();
    sql = db.adminSql;
    for (const [i, slug] of ['empty-cmd', 'blank-cmd', 'choose-empty', 'keeps-direct', 'has-suite'].entries()) {
      await insertHiveIfAbsent({ workspaceId: WS, homeSlug: slug, pubkeyBase64: pk(i + 1), keychainId: 'k' }, sql);
    }
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  const stored = async (slug: string): Promise<unknown> =>
    (await getHiveSetting(WS, slug, POT_INTEGRATION_SETTING_KEY, sql))?.value ?? null;

  it('an empty test command refuses working-copy mode and stores nothing', async () => {
    const r = await setPotIntegrationMode({
      workspaceId: WS,
      potHomeSlug: 'empty-cmd',
      mode: 'review',
      greenCmd: '',
      forkRemote: FORK,
      sql,
    });
    expect(r).toMatchObject({ ok: false, error: 'green_cmd_required' });
    expect(await stored('empty-cmd')).toBeNull();
  });

  it('a whitespace-only or missing test command is refused the same way', async () => {
    for (const greenCmd of ['   ', null, undefined]) {
      const r = await setPotIntegrationMode({
        workspaceId: WS,
        potHomeSlug: 'blank-cmd',
        mode: 'review',
        greenCmd,
        forkRemote: FORK,
        sql,
      });
      expect(r).toMatchObject({ ok: false, error: 'green_cmd_required' });
    }
    expect(await stored('blank-cmd')).toBeNull();
  });

  it('the guided switch refuses before creating a fork, and stores nothing', async () => {
    const ensureFork = vi.fn();
    const setForkRemote = vi.fn();
    const r = await choosePotIntegrationMode(
      {
        workspaceId: WS,
        potHomeSlug: 'choose-empty',
        harnessSlug: 'choose-empty',
        upstreamRemote: 'https://github.com/main-owner/repo.git',
        mode: 'review',
        greenCmd: '',
        forkRemote: null,
        sql,
      },
      { ensureFork, setForkRemote },
    );
    expect(r).toMatchObject({ ok: false, error: 'green_cmd_required' });
    expect(ensureFork).not.toHaveBeenCalled();
    expect(setForkRemote).not.toHaveBeenCalled();
    expect(await stored('choose-empty')).toBeNull();
  });

  it('a refused switch leaves an existing direct setting untouched', async () => {
    const set = await setPotIntegrationMode({
      workspaceId: WS,
      potHomeSlug: 'keeps-direct',
      mode: 'direct',
      greenCmd: '',
      forkRemote: null,
      sql,
    });
    expect(set).toEqual({ ok: true, mode: 'direct' });
    const r = await setPotIntegrationMode({
      workspaceId: WS,
      potHomeSlug: 'keeps-direct',
      mode: 'review',
      greenCmd: '',
      forkRemote: FORK,
      sql,
    });
    expect(r).toMatchObject({ ok: false, error: 'green_cmd_required' });
    expect(await stored('keeps-direct')).toBe('direct');
  });

  it('control: with a test command and a fork, working-copy mode IS saved', async () => {
    const r = await setPotIntegrationMode({
      workspaceId: WS,
      potHomeSlug: 'has-suite',
      mode: 'review',
      greenCmd: 'npm test',
      forkRemote: FORK,
      sql,
    });
    expect(r).toEqual({ ok: true, mode: 'review' });
    expect(await stored('has-suite')).toBe('review');
  });
});

describe('SPEC-P-019-guarded-switch — leaving a working copy waits for its open PR (real hive-settings store)', () => {
  let db: OrgTestDb;
  let sql: Sql;
  const UPSTREAM = 'https://github.com/main-owner/repo.git';

  beforeAll(async () => {
    db = await createOrgTestDb();
    sql = db.adminSql;
    await insertHiveIfAbsent({ workspaceId: WS, homeSlug: 'guarded', pubkeyBase64: pk(9), keychainId: 'k' }, sql);
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  const stored = async (slug: string): Promise<unknown> =>
    (await getHiveSetting(WS, slug, POT_INTEGRATION_SETTING_KEY, sql))?.value ?? null;

  /** GitHub at its one boundary: the main repository's open PRs, matched by the REAL findStandingPr. */
  // Same matching as the default lookup: scoped to the pot's fork, unreported head repo counted.
  const openPrs = (prs: Array<{ number: number; head_ref: string; base_ref: string; head_repo?: string }>) =>
    vi.fn(async (remote: string, forkRepo?: string) => {
      expect(remote).toBe('github.com/main-owner/repo');
      const listed = prs.map(
        (p) =>
          ({
            ref: { remote, number: p.number },
            state: 'open',
            head_ref: p.head_ref,
            base_ref: p.base_ref,
            head_sha: 'a'.repeat(40),
            head_repo: p.head_repo ?? FORK_REPO,
            url: `https://github.com/main-owner/repo/pull/${p.number}`,
          }) as unknown as Pr,
      );
      const pr = findStandingPr(listed, { forkRepo, unknownHeadRepo: 'include' });
      return { ok: true as const, pr: pr ? { number: pr.ref.number, url: pr.url } : null };
    });

  const switchToDirect = (findOpenStandingPr: ReturnType<typeof openPrs>) =>
    choosePotIntegrationMode(
      {
        workspaceId: WS,
        potHomeSlug: 'guarded',
        harnessSlug: 'guarded',
        upstreamRemote: UPSTREAM,
        mode: 'direct',
        greenCmd: 'npm test',
        forkRemote: FORK,
        sql,
      },
      { findOpenStandingPr },
    );

  it('refuses while the standing PR is open (any base branch), and the stored mode stays the working copy', async () => {
    expect(
      await setPotIntegrationMode({ workspaceId: WS, potHomeSlug: 'guarded', mode: 'review', greenCmd: 'npm test', forkRemote: FORK, sql }),
    ).toEqual({ ok: true, mode: 'review' });

    const lookup = openPrs([
      { number: 3, head_ref: 'feature/unrelated', base_ref: 'main' },
      { number: 7, head_ref: STANDING_PR_BRANCH, base_ref: 'develop' },
    ]);
    const r = await switchToDirect(lookup);

    expect(r).toMatchObject({ ok: false, error: 'standing_pr_open' });
    expect(!r.ok && r.message).toContain('#7');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(await stored('guarded')).toBe('review');
  });

  it("another pot's standing PR (same branch name, different fork) does not hold this pot's switch", async () => {
    expect(
      await setPotIntegrationMode({ workspaceId: WS, potHomeSlug: 'guarded', mode: 'review', greenCmd: 'npm test', forkRemote: FORK, sql }),
    ).toEqual({ ok: true, mode: 'review' });

    const lookup = openPrs([{ number: 5, head_ref: STANDING_PR_BRANCH, base_ref: 'main', head_repo: 'other-pot-bot/repo' }]);
    const r = await switchToDirect(lookup);

    expect(lookup).toHaveBeenCalledWith('github.com/main-owner/repo', FORK_REPO);
    expect(r).toEqual({ ok: true, mode: 'direct', fork: null });
    expect(await stored('guarded')).toBe('direct');
  });

  it('after the PR is merged or closed (only unrelated PRs open), the switch goes through and is stored', async () => {
    const r = await switchToDirect(openPrs([{ number: 3, head_ref: 'feature/unrelated', base_ref: 'main' }]));

    expect(r).toEqual({ ok: true, mode: 'direct', fork: null });
    expect(await stored('guarded')).toBe('direct');
  });
});
