/** Private verifier fixture, never a live human-market pilot or payment. */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function assertWorkPerfIsolation(env: NodeJS.ProcessEnv, runtime: NodeJS.ProcessEnv): void {
  const keys = ['PAPERCUSP_HOME', 'PAPERCUSP_WORKSPACE', 'PAPERCUSP_WORKSPACE_ID', 'HARNESS_ADMIN_DATABASE_URL',
    'HARNESS_DATABASE_URL'] as const;
  if (env.VERIFY_TAURI_ISOLATED_DB !== '1' || env.PAPERCUSP_VERIFY_TAURI_ISOLATED !== '1' ||
      runtime.PAPERCUSP_VERIFY_TAURI_ISOLATED !== '1' ||
      !/^verify-tauri-isolated-\d+$/.test(env.PAPERCUSP_WORKSPACE ?? '') ||
      env.PAPERCUSP_WORKSPACE_ID !== env.PAPERCUSP_WORKSPACE ||
      !/^[1-9]\d*$/.test(env.VERIFY_TAURI_PID ?? '') ||
      !/^[1-9]\d*$/.test(env.VERIFY_TAURI_PORT ?? '') ||
      runtime.OPERATOR_DEV_PORT !== env.VERIFY_TAURI_PORT ||
      !env.PAPERCUSP_HOME?.endsWith('/papercusp-home') ||
      keys.some(key => !env[key]?.trim() || env[key] !== runtime[key])) {
    throw new Error('Work performance fixture requires the exact owned isolated verifier runtime');
  }
  for (const key of ['HARNESS_ADMIN_DATABASE_URL', 'HARNESS_DATABASE_URL'] as const) {
    const url = new URL(env[key]!);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port ||
        url.port === '5432' || !url.pathname || url.pathname === '/') {
      throw new Error('Work performance fixture requires private loopback Postgres');
    }
  }
}

export async function seedWorkPerfFixture(env: NodeJS.ProcessEnv = process.env) {
  const phase = (value: string) => console.log('[work-perf-fixture] phase=' + value);
  // Validate BOTH the assertion and its actual server before acquiring a DB
  // pool. Do not accept an isolation flag pointing at an unrelated/live API.
  if (!/^[1-9]\d*$/.test(env.VERIFY_TAURI_PID ?? '')) throw new Error('Missing private verifier PID');
  const runtime = Object.fromEntries(readFileSync('/proc/' + env.VERIFY_TAURI_PID + '/environ', 'utf8')
    .split('\0').filter(row => row.includes('='))
    .map(row => [row.slice(0, row.indexOf('=')), row.slice(row.indexOf('=') + 1)]));
  assertWorkPerfIsolation(env, runtime);
  phase('isolation-verified');
  const [{ signup }, { createWorkItem, setWorkItemState }, { mutateHarnessRegistry },
    { getHumanMarketItem }, { updateExternalBlockerHistory }, { hasActiveStrictHumanAsk },
    { activeWorkspaceId }, { issuesScopeWorkspace }, { withPlanLock }, { getPlanRow }] = await Promise.all([
    import('../../packages/operator-core/lib/auth'),
    import('../../packages/operator-core/lib/work-items'),
    import('../../packages/operator-core/lib/harness-registry'),
    import('../../packages/operator-core/lib/work-items-human-market-store'),
    import('../../packages/operator-core/lib/external-blockers'),
    import('../../packages/operator-core/lib/hold-registry'),
    import('../../packages/operator-core/lib/workspace-registry'),
    import('../../packages/operator-core/lib/issues-engineer'),
    import('../../packages/operator-core/lib/agent-tools/plans/with-plan-lock'),
    import('../../packages/operator-core/lib/agent-tools/plans/source'),
  ]);
  phase('stores-loaded');
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const harness = 'perf-work-' + suffix;
  const workspace = env.PAPERCUSP_WORKSPACE!;
  if (activeWorkspaceId() !== workspace || issuesScopeWorkspace() !== workspace) {
    throw new Error('Canonical stores do not resolve to the private fixture workspace');
  }
  phase('store-workspace-verified');
  const { blockers } = updateExternalBlockerHistory({}, { kind: 'human',
    capability: 'external-service-action', ref: 'fixture:claim:' + suffix,
    summary: 'Private fixture: claim the offered test job?', nextVerb: 'Click Claim this work in the private verifier.',
    defaultIfUnanswered: 'Leave the private offer unclaimed; discard the fixture at verifier teardown.',
  }, 'fixture:desktop-work-perf');
  if (!hasActiveStrictHumanAsk({ externalBlockers: blockers })) throw new Error('Fixture human ask is invalid');
  phase('human-ask-verified');
  const owner = await signup('perf-owner-' + suffix, 'Performance fixture owner', null);
  const human = await signup('perf-human-' + suffix, 'Performance fixture claimant', null);
  phase('accounts-created');
  await mutateHarnessRegistry(reg => ({ ...reg, projects: [...reg.projects, {
    slug: harness, name: 'Private work journey fixture', path: path.join(env.PAPERCUSP_HOME!, harness),
    hasState: true, hasSpec: true, harness_kind: 'hive',
  }] }), workspace);
  phase('harness-registered');
  // Reuse the canonical plan writer and index, so the existing plan-opening
  // driver exercises a real persisted plan in this same private workspace.
  const planSlug = 'perf-plan-' + suffix;
  const today = new Date().toISOString().slice(0, 10);
  const planBody = `---\nslug: ${planSlug}\ntitle: Private performance plan fixture\nstatus: draft\ncreated: ${today}\nupdated: ${today}\n---\n\n## Now\n\nPrivate native rendering fixture. No execution or external work is authorized.\n\n## Background\n\nOpen this persisted body through the product plan reader.\n`;
  const planWrite = await withPlanLock(null, { slug: planSlug, harnessSlug: harness, workspaceId: workspace,
    intent: 'Private desktop performance fixture' }, async current => {
    if (current !== null) throw new Error('Private plan fixture already exists');
    return { newBody: planBody, value: true };
  });
  if (planWrite.kind !== 'applied' || !planWrite.value ||
      (await getPlanRow(planSlug, { harnessSlug: harness, workspaceId: workspace }))?.content !== planBody) {
    throw new Error('Private performance plan did not persist through the canonical writer');
  }
  phase('plan-readback-verified');
  const item = await createWorkItem({ kind: 'task', title: 'Private performance claim fixture',
    summary: 'Fixture only. No submission, review or payment is performed.', harness, workspaceId: workspace,
    createdBy: 'fixture:desktop-work-perf', payload: { externalBlockers: blockers, humanWork: {
      route: 'market', version: 0, ownerUserId: owner.id,
      brief: 'Read the private fixture brief and claim it. No real work or payment is offered.',
      rubricRef: 'fixture:desktop-work-perf', amountCents: 1, currency: 'USD',
    } } });
  phase('work-item-created');
  await setWorkItemState(item.id, 'needs-human', { harness, by: 'fixture:desktop-work-perf' });
  phase('offered');
  const offered = await getHumanMarketItem({ workspaceId: workspace, harness, id: item.id });
  if (offered?.state !== 'needs-human' || offered.assignee || owner.id === human.id) {
    throw new Error('Private human-work fixture did not persist an unclaimed offer');
  }
  phase('offer-readback-verified');
  return { workspace, harness, planSlug, itemId: item.id, username: human.username };
}

if (typeof require === 'function' && typeof module !== 'undefined' && require.main === module) {
  seedWorkPerfFixture().then(fixture => {
    // The manifest has only fixture identifiers. The browser mints and keeps
    // its HttpOnly session through /auth/login; no credential enters this file.
    const target = path.join(process.env.PAPERCUSP_HOME!, 'work-perf-fixture.json');
    writeFileSync(target, JSON.stringify(fixture) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ fixturePath: target, ...fixture }));
    process.exit(0);
  }, () => { console.error('Private work performance fixture setup failed'); process.exit(1); });
}
