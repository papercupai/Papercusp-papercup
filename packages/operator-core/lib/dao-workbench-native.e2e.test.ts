/** The maintained Workbench journey, executed in the owned native rig. */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runNativeChild } from '../../../scripts/tauri-surface-verify-reports.mts';

const isolated = process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED === '1';
const sections = ['directory', 'overview', 'join', 'members', 'proposals', 'vote', 'delegation', 'work',
  'jobs', 'treasury', 'funding', 'billing', 'ownership', 'returns', 'reputation', 'marketplace', 'records', 'settings', 'inbox'];
let evidence: string;
let width: number;
let workspaceId: string;

describe.skipIf(!isolated)('DAO Workbench in the isolated native desktop', () => {
  beforeAll(async () => {
    const profilePath = process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE!;
    const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
    workspaceId = profile.workspaceId;
    expect(profile.tauriPID).toBe(Number(process.env.VERIFY_TAURI_PID));
    expect(profile.tauriPID).toBeGreaterThan(0);
    expect(process.env.PAPERCUSP_TEST_RUNS_DB_URL).toBeTruthy();
    const sourceRoot = process.env.OPERATOR_SOURCE_ROOT!;
    const receipt = JSON.parse(readFileSync(process.env.VERIFY_TAURI_SOURCE_RECEIPT!, 'utf8'));
    expect(receipt.sourceCommit).toBe(process.env.VERIFY_TAURI_SOURCE_REF);
    width = Number(process.env.DAO_WORKBENCH_VIEWPORT!.split('x')[0]);
    expect([1440, 390]).toContain(width);
    // The runner moves TMPDIR; bridge discovery must retain the owned rig's root.
    const result = await runNativeChild(profile, sourceRoot,
      'scripts/tauri-surface-verify-dao-workbench.mts', width === 390 ? ['--viewport-only'] : []);
    const match = result.stdout.match(/P019_TAURI_SURFACE_VERIFY_OK leg=dao-workbench output=(.+)/);
    expect(match, result.stdout + '\n' + result.stderr).not.toBeNull();
    evidence = join(match![1].trim(), 'phases/native');
    const manifest = JSON.parse(readFileSync(join(match![1].trim(), 'result.json'), 'utf8'));
    expect(manifest.verdict).toBe('pass');
    expect(manifest.reuseFromRunId).toBeNull();
    expect(manifest.phases.map((phase: { status: string }) => phase.status)).toEqual(['passed']);
    const identity = JSON.parse(readFileSync(join(evidence, 'host-source-identity.json'), 'utf8'));
    expect(identity.sourceCommit).toBe(receipt.sourceCommit);
    expect(identity.health.sha).toBe(receipt.sourceCommit.slice(0, 12));
    writeFileSync(profilePath + '.dao.json', JSON.stringify({ evidence,
      workspaceId, sourceCommit: receipt.sourceCommit }));
    console.log('DAO_NATIVE_E2E_MANIFEST=' + join(match![1].trim(), 'result.json'));
    console.log('DAO_NATIVE_E2E_SOURCE_RECEIPT=' + process.env.VERIFY_TAURI_SOURCE_RECEIPT);
  }, 330_000);

  it('retains the native journey, all nineteen visible areas and an actual capture preflight', () => {
    for (const id of sections) {
      const page = JSON.parse(readFileSync(join(evidence, 'section-' + id + '.json'), 'utf8'));
      expect(new URL(page.url).searchParams.get('daoSection')).toBe(id);
      const image = readFileSync(join(evidence, 'section-' + id + '.png'));
      expect(image.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(Math.abs(image.readUInt32BE(16) - width)).toBeLessThanOrEqual(4);
      expect(image.length).toBeGreaterThan(1000);
    }
    expect(statSync(join(evidence, 'capture-preflight.png')).size).toBeGreaterThan(1000);
    if (width === 1440) {
      const response = JSON.parse(readFileSync(join(evidence, 'proposal-response.json'), 'utf8'));
      expect(response.status).toBe(200);
      const slug = JSON.parse(response.body).slug;
      const scopes = JSON.parse(readFileSync(join(evidence, 'proposal-scopes.json'), 'utf8'));
      expect(scopes).toEqual([expect.objectContaining({ plan_slug: slug,
        workspace_id: workspaceId, harness_slug: 'workbench-native' })]);
      expect(readFileSync(join(evidence, 'signed-decision.json'), 'utf8')).toContain('Plan admission approved');
    }
  });

  it('measures usable native work fields and linked-plan label spacing', () => {
    const controls = JSON.parse(readFileSync(join(evidence, 'work-control-layout.json'), 'utf8'));
    expect(controls.map((control: { name: string }) => control.name))
      .toEqual(['Project scope', 'Find work', 'Work title', 'Work brief']);
    for (const control of controls) {
      expect(control.fieldTop - control.titleBottom).toBeGreaterThanOrEqual(3);
      expect(control.fieldLeft).toBeGreaterThanOrEqual(control.left - 1);
      expect(control.fieldRight).toBeLessThanOrEqual(control.right + 1);
      expect(control.fieldWidth).toBeGreaterThanOrEqual(Math.min(240, control.width * .75));
    }
    if (width === 1440) {
      const plans = JSON.parse(readFileSync(join(evidence, 'work-linked-plan-layout.json'), 'utf8'));
      expect(plans.length).toBeGreaterThan(0);
      for (const plan of plans) expect(plan.statusTop - plan.titleBottom).toBeGreaterThanOrEqual(3);
    }
  });
});
