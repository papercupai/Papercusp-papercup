import { describe, expect, it } from 'vitest';
import {
  CRITICAL_AREAS,
  RISK_ACKNOWLEDGEMENT_MIN_CHARS,
  classifyCriticalArea,
  criticalAreaAcknowledgementProblem,
  criticalAreaWarning,
} from './critical-area-registry';

describe('P-003 critical-area registry', () => {
  it('classifies one representative test path into each of the seven critical areas', () => {
    const cases: Array<[string, string]> = [
      ['apps/operator/lib/release/green-checkpoint.test.ts', 'gate'],
      ['packages/operator-core/lib/release/frozen-candidate-repair-queue.test.ts', 'gate'],
      ['libs/papercusp/libs/db/src/migrate.test.ts', 'migrations-schema'],
      ['packages/operator-core/lib/schema/columns.test.ts', 'migrations-schema'],
      ['packages/operator-core/lib/connected-apps/mcp-oauth.integration.test.ts', 'auth-secrets'],
      ['packages/operator-core/lib/secrets/vault.test.ts', 'auth-secrets'],
      ['packages/operator-core/lib/backup/snapshot-create.test.ts', 'data-integrity'],
      ['lint:tsc:operator', 'typecheck-build'],
      ['build', 'typecheck-build'],
      ['packages/operator-core/lib/agent-tools/coordination/send.test.ts', 'agent-control-plane'],
      ['packages/operator-core/lib/agent-tools/work-items/claim.test.ts', 'agent-control-plane'],
      ['orchestrator/src/no-subagent-deny.test.ts', 'agent-control-plane'],
      ['apps/operator/lib/release/deploy.test.ts', 'deploy-release'],
      ['packages/operator-core/lib/rollback-plan.test.ts', 'deploy-release'],
    ];
    for (const [path, area] of cases) expect(classifyCriticalArea(path)?.id, path).toBe(area);
    expect(new Set(cases.map(([, area]) => area))).toEqual(new Set(CRITICAL_AREAS.map((area) => area.id)));
  });

  it('does not classify ordinary product code as critical (R-2 falsifier 3)', () => {
    for (const path of [
      'apps/operator/app/settings/remote-access/page.test.tsx',
      'packages/operator-core/lib/dream/dream-control-observations.test.ts',
      'packages/operator-core/lib/sync-resolver/learning-dream-metrics.test.ts',
      'packages/operator-core/lib/author-profile.test.ts',
      'packages/operator-core/lib/releases-notes-ui.test.ts',
      'apps/operator/components/Tokenizer.test.tsx',
      'packages/operator-core/lib/snapshot-render.test.ts',
    ]) {
      expect(classifyCriticalArea(path), path).toBeNull();
    }
  });

  it('accepts only an acknowledgement that names the same area and states the risk', () => {
    const area = classifyCriticalArea('libs/papercusp/libs/db/sql/1201-example-table.sql')!;
    expect(area.id).toBe('migrations-schema');
    expect(criticalAreaAcknowledgementProblem(area, undefined)).toMatch(/missing acknowledgement/);
    expect(criticalAreaAcknowledgementProblem(area, { area: 'gate', risk: 'x'.repeat(40) })).toMatch(/names area 'gate'/);
    expect(criticalAreaAcknowledgementProblem(area, { area: 'migrations-schema', risk: 'ok' })).toMatch(/at least/);
    expect(
      criticalAreaAcknowledgementProblem(area, { area: 'migrations-schema', risk: 'x'.repeat(RISK_ACKNOWLEDGEMENT_MIN_CHARS) }),
    ).toBeNull();
  });

  it('warns forcefully that main may ship broken behaviour in the area', () => {
    const warning = criticalAreaWarning(classifyCriticalArea('apps/operator/lib/release/deploy.test.ts')!);
    expect(warning).toContain('CRITICAL AREA');
    expect(warning).toContain('may ship broken behaviour in deploy/rollback/release');
    expect(warning).toContain('owner has been notified');
  });
});
