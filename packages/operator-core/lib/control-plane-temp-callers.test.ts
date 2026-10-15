import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = (path: string) => readFileSync(join(repoRoot, path), 'utf8');

describe('parent control-plane temp writers', () => {
  it('keeps the audited receipt, socket, and log writers off hardcoded /tmp paths', () => {
    const consoleLaunch = source('packages/operator-core/lib/endpoint-route/routes/agent-mcp/console-launch.ts');
    expect(consoleLaunch).toContain("controlPlaneTempRoot('log')");
    expect(consoleLaunch).not.toContain('/tmp/console-launch.log');

    const scoper = source('packages/operator-core/lib/endpoint-route/routes/harness/scoper-actions.ts');
    expect(scoper).toContain('createControlPlaneTempFile');
    expect(scoper).not.toContain('/tmp/harness-replan-');

    const harnessTests = source('packages/operator-core/lib/endpoint-route/routes/harness/testing.ts');
    expect(harnessTests).toContain('createControlPlaneTempFile');
    expect(harnessTests).not.toContain('tmpdir()');

    const ptyHost = source('apps/operator/scripts/psu-pty-host.mjs');
    expect(ptyHost).toContain("controlPlaneTempCandidates('socket')");
    expect(ptyHost).not.toContain('/tmp/pc-pty-');

    const cleanup = source('packages/operator-core/lib/plan-cleanup/start-run.ts');
    expect(cleanup).toContain("logDir: join(papercuspPathForWorkspace(workspaceId), 'fleet-logs')");
  });
});
