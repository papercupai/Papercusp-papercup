import type { AdvSessionRow } from './adv-sessions';

export interface RoleCodexHomeRepairResult {
  status: number;
  body: { ok: boolean; repaired?: boolean; reason?: string; error?: string; [key: string]: unknown };
}

/** Shared restricted-role repair for interactive resumes and event wakes.
 * Reuses the recorded identity, accepted-operation gate and in-place writer;
 * neither caller may fall through to the superuser home writer.
 */
export async function repairRoleCodexHome(input: {
  advSessionId: number;
  owner: string;
  sessionRow: AdvSessionRow;
  rawRecord: unknown;
  operatorBaseUrl: string;
  body: { model?: unknown; requireGatewayProvider?: unknown; headless?: unknown };
  measure?: <T>(phase: string, work: () => T | PromiseLike<T>) => Promise<T>;
}): Promise<RoleCodexHomeRepairResult> {
  const { advSessionId, owner, sessionRow, rawRecord, operatorBaseUrl, body } = input;
  const measure = input.measure ?? (<T>(_phase: string, work: () => T | PromiseLike<T>): Promise<T> =>
    Promise.resolve().then(work));
  const [{ recordSuLaunchSpec }, { parseSuLaunchSpecRecord }, { CODEX_DEFAULT_MODEL },
    { requestSessionIdentityActivation }, { wakeAccountRouteFromArgv }, { codexWakeGatewayInputs }] =
    await Promise.all([
      import('./adv-sessions'), import('./su-persona-render'), import('./model-context-budget.mjs'),
      import('./agent-tools/coordination/control-anchor'), import('./inference-gateway/spawn-env'),
      import('./events/await/wake-executor'),
    ]);
  const persistedRecord = parseSuLaunchSpecRecord(rawRecord);
  if (sessionRow?.role && sessionRow.role !== 'su') {
    const saved = rawRecord && typeof rawRecord === 'object'
      ? rawRecord as Record<string, unknown> : {};
    const { flagValueFromArgv, modelSpecFromArgv } = await import('./agent-config-constants');
    const harnessSlug = typeof saved.harnessSlug === 'string' ? saved.harnessSlug
      : !sessionRow.feature ? flagValueFromArgv(sessionRow.launchArgv, 'harness') : null;
    if (!harnessSlug || !sessionRow.sessionId || sessionRow.agent !== 'codex' || sessionRow.coordOwnerId !== owner) {
      return { status: 200, body: { ok: true, repaired: false, reason: 'role-home-preserved' } };
    }
    const recordedModel = modelSpecFromArgv(sessionRow.launchArgv);
    if (!sessionRow.feature) {
      if ((saved.role && saved.role !== sessionRow.role)
        || flagValueFromArgv(sessionRow.launchArgv, 'role') !== sessionRow.role || !recordedModel) {
        return { status: 409, body: { ok: false, error: 'role_launch_provenance_unavailable' } };
      }
      const { existsSync, readFileSync } = await import('node:fs');
      const { join, isAbsolute } = await import('node:path');
      const { parse } = await import('@iarna/toml');
      const { codexHomeForSessionKey } = await import('@papercusp/orchestrator/session-launch-dirs');
      let stateHome: unknown = saved.codexSqliteHome;
      const configPath = join(codexHomeForSessionKey(advSessionId), 'config.toml');
      if (stateHome === undefined && existsSync(configPath)) {
        try { stateHome = parse(readFileSync(configPath, 'utf8')).sqlite_home; } catch { /* refuse below */ }
      }
      if (typeof stateHome !== 'string' || !isAbsolute(stateHome) || stateHome.includes('\0')) {
        return { status: 409, body: { ok: false, error: 'role_state_binding_unavailable' } };
      }
    }
    const { resolveAcceptedOperationWorkerBinding, selectAcceptedOperationWorkerModel } =
      await import('./blueprint/operation-worker-binding');
    const { resolveProjectDir } = await import('./spawn-config');
    const { getOrgPg } = await import('@papercusp/db-org');
    // notify-classification: {"id":"packages/operator-core/lib/role-codex-home-repair.ts#<module>/repairRoleCodexHome:e9a39b6eb1c58d59b580:1","classification":"durable","reason":"Accepted-operation binding reaches lifecycle notification paths; retain their terminal delivery obligation during role repair.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
    const accepted = sessionRow.feature ? await resolveAcceptedOperationWorkerBinding({
      sql: getOrgPg().sql, workspaceId: sessionRow.workspaceId, harnessSlug,
      workItemId: sessionRow.feature, role: sessionRow.role,
      // notify-classification: {"id":"packages/operator-core/lib/role-codex-home-repair.ts#<module>/repairRoleCodexHome:13d6cb7f424b0fab084c:1","classification":"durable","reason":"Project resolution can reach lifecycle notifications; retain their terminal delivery requirement through role repair.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
      repoDir: await resolveProjectDir(harnessSlug, sessionRow.workspaceId) ?? '',
    }) : null;
    if (sessionRow.feature && !accepted) {
      return { status: 200, body: { ok: true, repaired: false, reason: 'role-home-preserved' } };
    }
    const selection = accepted ? selectAcceptedOperationWorkerModel(accepted,
      typeof body.model === 'string' ? body.model : null, 'codex') : null;
    const { buildRoleLaunchSpec } = await import('./role-launch-spec');
    // notify-classification: {"id":"packages/operator-core/lib/role-codex-home-repair.ts#<module>/repairRoleCodexHome:f723fa87d6b9447673bb:1","classification":"durable","reason":"Role launch-spec construction reaches lifecycle notification paths; preserve their terminal delivery obligation.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
    const spec = await buildRoleLaunchSpec({
      role: sessionRow.role, workspaceId: sessionRow.workspaceId, harnessSlug,
      featureId: sessionRow.feature, operatorBaseUrl: operatorBaseUrl,
      ...(saved.mcpTarget === 'spawn-host' ? { mcpTarget: 'spawn-host' as const } : {}),
      acceptedOperation: accepted && selection ? { ...accepted, modelSelection: selection } : accepted,
      ...(!accepted && Array.isArray(saved.stack) ? { stack: saved.stack as string[] } : {}),
      launchIdentity: { sid: owner, nativeSessionId: sessionRow.sessionId },
    });
    const { admitIdentityActivation } = await import('./cupboard/identity-activation-gate-io');
    const funding = await admitIdentityActivation({
      stack: spec.stack, repoDir: spec.cwd, workspaceId: sessionRow.workspaceId,
    });
    if (!funding.ok) {
      return { status: 402, body: { ok: false, error: 'identity_activation_refused', refused: funding.refused } };
    }
    const route = codexWakeGatewayInputs(wakeAccountRouteFromArgv(sessionRow.launchArgv, owner));
    const { writeRoleCodexHomeAsync } = await import('./role-codex-home');
    const home = await measure('handler.write-role-codex-home', () => writeRoleCodexHomeAsync({
      sessionKey: advSessionId, preserveExisting: true, sid: owner,
      recordedSqliteHome: typeof saved.codexSqliteHome === 'string' ? saved.codexSqliteHome : null,
      mcpUrl: spec.mcpUrl, promptText: spec.promptText,
      model: selection?.model ?? recordedModel ?? persistedRecord?.model ?? CODEX_DEFAULT_MODEL,
      codexGatewayAuto: route.requireGatewayProvider === true || body.requireGatewayProvider === true,
      codexGatewayAccountId: route.codexGatewayAccountId,
      codexGatewayPriority: sessionRow.role,
      headless: body.headless === true || sessionRow.launchArgv?.includes('--headless') === true, trustDir: spec.cwd,
    }));
    const binding = accepted ? {
      kind: 'blueprint-operation-worker', workItemId: accepted.workItemId,
      operationId: accepted.operationId, specificationRevision: accepted.specificationRevision,
      pin: accepted.pin, identity: accepted.identity, requiredTools: accepted.requiredTools,
      ...(accepted.modelPolicy ? { modelPolicy: accepted.modelPolicy, modelSelection: selection } : {}),
    } : null;
    if (!(await measure('handler.persist-launch-spec', () => recordSuLaunchSpec(advSessionId, owner, {
      ...saved, v: 1, workspaceId: sessionRow.workspaceId, harnessSlug, role: sessionRow.role,
      acceptedOperation: binding, stack: spec.stack,
      codexSqliteHome: home.sqliteHome,
      specificationRevision: spec.specificationRevision, stateRevision: spec.stateRevision,
      specificationArtifact: spec.specificationArtifact,
    })))) throw new Error('repaired role launch specification receipt was not persisted');
    await measure('handler.identity-activation', () => requestSessionIdentityActivation({
      ownerId: owner, workspaceId: sessionRow.workspaceId,
      revision: { specificationRevision: spec.specificationRevision, stateRevision: spec.stateRevision },
      attribution: { actorId: owner, principalId: owner, sessionId: owner }, source: 'restart', restart: true,
    }));
    return { status: 200, body: { ok: true, owner, advSessionId, repaired: true,
      role: sessionRow.role, acceptedOperation: Boolean(accepted) } };
  }
  return { status: 409, body: { ok: false, error: 'restricted_role_required' } };
}
