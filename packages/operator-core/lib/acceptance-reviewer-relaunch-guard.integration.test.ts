import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';
import { findReviewerRelaunchConflict, reviewerRelaunchSqlDeps } from './acceptance-reviewer-relaunch-guard';

describe('reviewer recovery with durable task provenance', () => {
  let db: OrgTestDb;
  const workspaceId = 'reviewer-recovery-provenance';
  const recruiter = 'system:acceptance-bar-amendment-review';

  beforeAll(async () => {
    db = await createOrgTestDb();
    await db.adminSql`INSERT INTO harness_shared.adv_sessions ${db.adminSql([
      { workspace_id: workspaceId, mode: 'console', coord_owner_id: 'reviewer-null-parent', launch_spec: {} },
      { workspace_id: workspaceId, mode: 'console', coord_owner_id: 'ordinary-worker',
        launch_spec: { launchedBy: 'su-leader' } },
      { workspace_id: workspaceId, mode: 'console', coord_owner_id: 'cross-workspace-worker', launch_spec: {} },
    ])}`;
    await db.adminSql`INSERT INTO harness_shared.task_ledger ${db.adminSql([
      ['reviewer-null-parent', workspaceId, recruiter],
      ['reviewer-no-session', workspaceId, recruiter],
      ['ordinary-worker', workspaceId, 'su-leader'],
      ['cross-workspace-worker', 'another-workspace', recruiter],
    ].map(([owner, workspace, launcher]) => ({
      task_id: `reviewer-provenance-${owner}`,
      root_task_id: `reviewer-provenance-${owner}`,
      workspace_id: workspace,
      class: 'agent-session', title: 'reviewer provenance fixture',
      launched_by: launcher,
      detail: db.adminSql.json({ coordOwnerId: owner }),
    })))}`;
  }, 180_000);

  afterAll(async () => { await db?.cleanup(); });

  const conflict = (owner: string, launcher = 'su-implementer') => findReviewerRelaunchConflict({
    workspaceId, launcherOwnerId: launcher, retainedOwnerId: owner,
  }, reviewerRelaunchSqlDeps(db.adminSql));

  it('refuses a recruited BAR reviewer whose session parent is null', async () => {
    expect(await conflict('reviewer-null-parent')).toMatchObject({
      kind: 'recruited-reviewer-unprovable', reviewerOwnerId: 'reviewer-null-parent', recruiter,
    });
  });

  it('refuses a recruited reviewer before its session registration arrives', async () => {
    expect(await conflict('reviewer-no-session')).toMatchObject({
      kind: 'recruited-reviewer-unprovable', reviewerOwnerId: 'reviewer-no-session', recruiter,
    });
  });

  it('keeps ordinary worker recovery available', async () => {
    expect(await conflict('ordinary-worker')).toBeNull();
  });

  it('does not attribute another workspace task to this reviewer', async () => {
    expect(await conflict('cross-workspace-worker')).toBeNull();
  });

  it('lets the system recruiter recover its reviewer', async () => {
    expect(await conflict('reviewer-null-parent', recruiter)).toBeNull();
  });
});
