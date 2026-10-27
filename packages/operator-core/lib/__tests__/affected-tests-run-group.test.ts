import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ciTestRunGroupGuardFailure } from '../../../../scripts/lib/test-run-group-guard.mjs';
import { nativeProcessTraceEnv } from '../../../../scripts/lib/vitest-startup-trace.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

describe('affected-tests run-group propagation', () => {
  it('fails closed for missing or changed CI groups and accepts the candidate group', () => {
    const common = { required: true, boundary: 'before-admission' };
    expect(ciTestRunGroupGuardFailure({ ...common, actualRunGroupId: 'candidate-run' }))
      .toMatchObject({ message: 'ci-test-run-group-missing', code: 'AFFECTED_TEST_RUN_GROUP_GUARD' });
    expect(ciTestRunGroupGuardFailure({ ...common, expectedRunGroupId: 'candidate-run',
      actualRunGroupId: undefined }))
      .toMatchObject({ message: 'ci-test-run-group-changed-before-admission',
        code: 'AFFECTED_TEST_RUN_GROUP_GUARD' });
    expect(ciTestRunGroupGuardFailure({ ...common, expectedRunGroupId: 'candidate-run',
      actualRunGroupId: 'other-run' }))
      .toMatchObject({ message: 'ci-test-run-group-changed-before-admission',
        code: 'AFFECTED_TEST_RUN_GROUP_GUARD' });
    expect(ciTestRunGroupGuardFailure({ ...common, expectedRunGroupId: 'candidate-run',
      actualRunGroupId: 'candidate-run' })).toBeNull();
    expect(ciTestRunGroupGuardFailure({ ...common, required: false })).toBeNull();
  });

  it('requires a CI group and checks both environment boundaries before spawning', () => {
    const runner = readFileSync(join(root, 'scripts/affected-tests.mjs'), 'utf8');
    const childEnv = runner.indexOf('const childEnv = {');
    const ciDetection = runner.indexOf('const requiresCiRunGroup = Boolean(');
    const preflight = runner.indexOf('const runGroupGuardFailure = ciTestRunGroupGuardFailure', childEnv);
    const governedOptions = runner.indexOf('const governedOptions = {', preflight);
    const runExecution = runner.indexOf('const runExecution = runGroupGuardFailure', governedOptions);
    const admission = runner.indexOf('runGovernedTestProcess(', runExecution);
    const postAdmission = runner.indexOf('const admissionRunGroupGuardFailure = ciTestRunGroupGuardFailure', admission);
    const spawn = runner.indexOf('child = spawn(cmd, argv', postAdmission);

    expect(childEnv).toBeGreaterThanOrEqual(0);
    expect(ciDetection).toBeGreaterThan(0);
    expect(runner.slice(ciDetection, childEnv)).toContain(
      'process.env.PAPERCUSP_TEST_RUN_SOURCE === "ci"',
    );
    expect(preflight).toBeGreaterThan(childEnv);
    expect(governedOptions).toBeGreaterThan(preflight);
    expect(runExecution).toBeGreaterThan(governedOptions);
    expect(admission).toBeGreaterThan(runExecution);
    expect(postAdmission).toBeGreaterThan(admission);
    expect(spawn).toBeGreaterThan(postAdmission);

    const preflightSource = runner.slice(preflight, governedOptions);
    expect(preflightSource).toContain('expectedRunGroupId: expectedCiRunGroupId');
    expect(preflightSource).toContain('actualRunGroupId: childEnv.PAPERCUSP_TEST_RUN_GROUP');

    const postAdmissionSource = runner.slice(postAdmission, spawn);
    expect(postAdmissionSource).toContain('actualRunGroupId: governedEnv.PAPERCUSP_TEST_RUN_GROUP');
    expect(postAdmissionSource).toContain(
      'governedEnv.PAPERCUSP_TEST_RUN_GROUP !== childEnv.PAPERCUSP_TEST_RUN_GROUP',
    );
    expect(runner.indexOf('env: nativeProcessTraceEnv(governedEnv)', spawn)).toBeGreaterThan(spawn);
  });

  it('records the actual group from a spawned child in its node-entry trace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'affected-run-group-trace-'));
    const out = join(dir, 'out.json');
    const childScript = join(dir, 'child.mjs');
    const runGroupId = 'candidate-child-run-group';
    try {
      writeFileSync(childScript, 'process.exit(0);\n');
      const env = nativeProcessTraceEnv({
        PATH: process.env.PATH ?? '',
        PC_EXECUTED_SOURCE_MAP_OUT: out,
        PAPERCUSP_TEST_RUN_GROUP: runGroupId,
        PAPERCUSP_TEST_STARTUP_TRACE: '0',
      });
      execFileSync(process.execPath, [childScript], { cwd: dir, env, timeout: 10_000 });

      const traceDir = out + '.native-processes';
      const rows = readdirSync(traceDir).filter(name => name.endsWith('.json'))
        .map(name => JSON.parse(readFileSync(join(traceDir, name), 'utf8')));
      const entry = rows.find(row => row.event === 'node-entry' && row.argv?.includes(childScript));
      expect(entry).toMatchObject({ runGroupId, reporterOut: out });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
