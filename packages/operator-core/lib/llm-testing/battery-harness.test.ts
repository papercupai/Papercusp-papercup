import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultEvidenceRoot, pruneRunsWithReport } from '@papercusp/verification-harness';
import { llmBatteryEvidenceRoot, runScenarioBattery, scenarioPhaseOutcome } from './battery-harness';

const scenarios = [
  { id: 'op-S01-a', target: 'operator', description: 'first' },
  { id: 'op-S02-b', target: 'operator', description: 'second' },
  { id: 'su-S03-c', target: 'su', description: 'third' },
];

describe('LLM scenario battery on the verification-harness contract', () => {
  let retentionRoot: string;
  beforeEach(() => {
    retentionRoot = mkdtempSync(path.join(tmpdir(), 'llm-battery-mutex-'));
    vi.stubEnv('VH_EVIDENCE_ROOT_BASE', path.join(retentionRoot, 'canonical'));
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', path.join(retentionRoot, 'locks'));
    vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', path.join(retentionRoot, 'pins'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(retentionRoot, { recursive: true, force: true });
  });

  it.each(['executed', 'failed'] as const)('retains original %s diagnostics after later runs evict the run directory', async outcome => {
    const root = mkdtempSync(path.join(tmpdir(), 'llm-battery-retention-'));
    const scenario = scenarios[0]!;
    const summary = `${JSON.stringify({ scenarioId: scenario.id, verdict: outcome,
      runs: [{ llmCallDiagnostics: { events: [{ status: 400, error: 'unsupported model' }] } }] })}\n`;
    const { harness } = await runScenarioBattery({
      scenarios: [scenario], concurrency: 1, evidenceRoot: root,
      runScenario: async (_, dir) => {
        writeFileSync(path.join(dir, 'report-summary.json'), summary);
        return outcome;
      },
    });
    const retained = path.join(root, 'retained', harness.runId);
    expect(readFileSync(path.join(retained, 'phases', scenario.id, 'report-summary.json'), 'utf8')).toBe(summary);
    expect(JSON.parse(readFileSync(path.join(retained, 'result.json'), 'utf8')).verdict)
      .toBe(outcome === 'executed' ? 'pass' : 'fail');
    // Move latest to a later run, then exercise the real count-retention boundary.
    const later = '20991231T235959Z-999999';
    mkdirSync(path.join(root, later));
    unlinkSync(path.join(root, 'latest'));
    symlinkSync(later, path.join(root, 'latest'));
    const report = await pruneRunsWithReport(root, 1, Date.now(), {
      measureDisk: async () => ({ totalBytes: 100, availableBytes: 100 }), reserveBytes: () => 1,
    });
    expect(report.removed).toContain(harness.runId);
    expect(existsSync(harness.evidenceDir)).toBe(false);
    expect(readFileSync(path.join(retained, 'phases', scenario.id, 'report-summary.json'), 'utf8')).toBe(summary);
  });

  it('one phase per scenario, never-abort, evidence per scenario, outcomes in scenario order', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'llm-battery-'));
    const { outcomes, harness, summaryLine } = await runScenarioBattery({
      scenarios,
      concurrency: 2,
      evidenceRoot: root,
      runScenario: async (s, dir) => {
        writeFileSync(path.join(dir, 'report-summary.json'), JSON.stringify({ id: s.id }));
        return s.id === 'op-S02-b' ? 'failed' : s.id === 'su-S03-c' ? 'skipped' : 'executed';
      },
    });
    expect(outcomes).toEqual(['executed', 'failed', 'skipped']);
    expect(harness.phases.map((p) => [p.phase, p.status, p.reasonCode])).toEqual([
      ['op-S01-a', 'passed', null],
      ['op-S02-b', 'failed', 'scenario-failed'],
      ['su-S03-c', 'failed', 'claim-busy'],
    ]);
    expect(summaryLine).toMatch(/^HARNESS_RESULT harness=llm-scenario-battery verdict=fail .*first_failure=op-S02-b\/run-scenario\/scenario-failed/);
    const kept = JSON.parse(readFileSync(path.join(root, 'latest', 'phases', 'op-S01-a', 'report-summary.json'), 'utf8'));
    expect(kept).toEqual({ id: 'op-S01-a' });
  });

  it.each(['executed', 'failed'] as const)('runs and retains all 63 original %s summaries after eviction', async outcome => {
    const root = path.join(retentionRoot, 'large-battery');
    const population = Array.from({ length: 63 }, (_, i) => ({
      id: `su-S${i}`, target: 'su', description: `scenario ${i}`,
    }));
    const original = (id: string) => `${JSON.stringify({ id, outcome, diagnostic: 'original provider result' })}\n`;
    const { outcomes, harness } = await runScenarioBattery({
      scenarios: population, concurrency: 4, evidenceRoot: root,
      runScenario: async (scenario, dir) => {
        writeFileSync(path.join(dir, 'report-summary.json'), original(scenario.id));
        writeFileSync(path.join(dir, 'unrelated.json'), 'do not retain');
        return outcome;
      },
    });
    expect(outcomes).toEqual(population.map(() => outcome));
    expect(harness.phases.map(p => p.phase)).toEqual(population.map(s => s.id));
    expect(harness.verdict).toBe(outcome === 'executed' ? 'pass' : 'fail');
    const retained = path.join(root, 'retained', harness.runId);
    const manifest = JSON.parse(readFileSync(path.join(retained, 'retained-artifacts.json'), 'utf8'));
    expect(manifest.selectors).toEqual(['phases/*/report-summary.json']);
    expect(manifest.artifacts).toHaveLength(64); // 63 originals and result.json
    const later = '20991231T235959Z-999999';
    mkdirSync(path.join(root, later));
    unlinkSync(path.join(root, 'latest'));
    symlinkSync(later, path.join(root, 'latest'));
    const report = await pruneRunsWithReport(root, 1, Date.now(), {
      measureDisk: async () => ({ totalBytes: 100, availableBytes: 100 }), reserveBytes: () => 1,
    });
    expect(report.removed).toContain(harness.runId);
    expect(existsSync(harness.evidenceDir)).toBe(false);
    for (const scenario of population) {
      expect(readFileSync(path.join(retained, 'phases', scenario.id, 'report-summary.json'), 'utf8'))
        .toBe(original(scenario.id));
      expect(existsSync(path.join(retained, 'phases', scenario.id, 'unrelated.json'))).toBe(false);
    }
  });

  it('a scenario whose runner throws is a failed phase and a failed outcome, never a pass', async () => {
    const { outcomes, harness } = await runScenarioBattery({
      scenarios: scenarios.slice(0, 1),
      concurrency: 1,
      evidenceRoot: mkdtempSync(path.join(tmpdir(), 'llm-battery-')),
      runScenario: async () => {
        throw new Error('gateway down');
      },
    });
    expect(outcomes).toEqual(['failed']);
    expect(harness.verdict).toBe('fail');
  });

  it('claim-busy is not a pass, and LLM_TEST_EVIDENCE_ROOT overrides the shared default root', () => {
    expect(scenarioPhaseOutcome('skipped')).toMatchObject({ ok: false, reasonCode: 'claim-busy' });
    expect(scenarioPhaseOutcome('executed')).toEqual({ ok: true });
    expect(llmBatteryEvidenceRoot({ LLM_TEST_EVIDENCE_ROOT: '/x/y' })).toBe('/x/y');
    expect(llmBatteryEvidenceRoot({ VH_EVIDENCE_ROOT_BASE: '/base' })).toBe('/base/llm-scenario-battery');
    // The home-state fallback is host-independent only via an explicit XDG_STATE_HOME: with HOME alone the
    // shared resolver prefers a verified data volume when this host has one (/mnt/data/offload here).
    expect(llmBatteryEvidenceRoot({ XDG_STATE_HOME: '/h/.local/state' })).toBe('/h/.local/state/verification-harness/llm-scenario-battery');
    expect(llmBatteryEvidenceRoot({ HOME: '/h' })).toBe(defaultEvidenceRoot('llm-scenario-battery', { HOME: '/h' }));
  });
});
