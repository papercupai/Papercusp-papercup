// Plan benchmark-coverage-frontierswe-v2-2026-10-10 P-022 / D-009 (clause FSWE-P022-BUNDLE@1):
// each completed benchmark campaign writes a dated bundle holding every task's trace with its scorer output.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCampaignBundle, campaignEntriesFromFrontierSweResults, campaignEntryFromRollout, writeCampaignBundle, type CampaignEntry,
} from './campaign-bundle';
import type { RolloutRecord } from './schema';

const COMPLETED = '2026-10-11T23:59:30.000Z';

/** A completed two-task fixture campaign: one scored pass, one integrity-invalid attempt. */
function twoTaskCampaign(): CampaignEntry[] {
  return [
    { suite: 'frontier-swe', taskId: 'org/repo:cranelift-opt', arm: 'su', seed: 0,
      trace: { ref: 'traces/su/cranelift-opt-0.jsonl', kind: 'claude-jsonl' },
      scorer: { status: 'passed', score: 0.75, resolved: true, detail: { rewardSource: 'reward.txt' }, raw: '0.75' },
      prediction: 'diff --git a/x b/x' },
    { suite: 'frontier-swe', taskId: 'org/repo:astro-toolkit', arm: 'su', seed: 0,
      trace: { ref: 'traces/su/astro-toolkit-0.jsonl', kind: 'claude-jsonl' },
      scorer: { status: 'invalid', score: null, resolved: null, detail: { integrity: { verdict: 'tampered', violations: ['/tests/test.sh'] } } } },
  ];
}

const tmpDirs: string[] = [];
afterEach(() => { for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('buildCampaignBundle — FSWE-P022-BUNDLE@1', () => {
  it('a completed two-task campaign yields a dated bundle with every task\'s trace and scorer output', () => {
    const b = buildCampaignBundle({ campaignId: 'fswe-v2/pilot', completedAt: COMPLETED, entries: twoTaskCampaign() });
    expect(b.root).toBe('benchmarks/campaigns/2026-10-11-fswe-v2_pilot');
    expect(b.manifest).toMatchObject({ schemaVersion: 1, date: '2026-10-11', complete: true, taskCount: 2, missing: [] });
    const tasks = b.files.filter((f) => f.rel.startsWith('tasks/'));
    expect(tasks.map((f) => f.rel).sort()).toEqual([
      'tasks/su/frontier-swe__org_repo_astro-toolkit__seed-0.json',
      'tasks/su/frontier-swe__org_repo_cranelift-opt__seed-0.json',
    ]);
    for (const f of tasks) {
      const body = f.body as CampaignEntry;
      expect(body.trace).toMatchObject({ ref: expect.stringMatching(/^traces\//) });
      expect(body.scorer?.status).toBeTruthy();
    }
    expect(b.manifest.files).toEqual(tasks.map((f) => f.rel).sort());
    expect(b.files.some((f) => f.rel === 'manifest.json')).toBe(true);
  });

  it('writes the bundle to disk and every task file round-trips with its trace and scorer output', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'campaign-bundle-'));
    tmpDirs.push(dir);
    const b = buildCampaignBundle({ campaignId: 'pilot', completedAt: COMPLETED, entries: twoTaskCampaign() });
    const written = writeCampaignBundle(b, dir);
    expect(written).toContain('benchmarks/campaigns/2026-10-11-pilot/manifest.json');
    const manifest = JSON.parse(readFileSync(path.join(dir, b.root, 'manifest.json'), 'utf8'));
    expect(manifest.complete).toBe(true);
    for (const rel of manifest.files as string[]) {
      const body = JSON.parse(readFileSync(path.join(dir, b.root, rel), 'utf8'));
      expect(body.trace.ref).toMatch(/^traces\//);
      expect(body.scorer.status).toMatch(/^(passed|invalid)$/);
    }
  });

  it.each([
    ['a task with no trace', (e: CampaignEntry[]) => { e[1]!.trace = null; }, ['trace']],
    ['a task with an empty trace ref', (e: CampaignEntry[]) => { e[1]!.trace = { ref: ' ' }; }, ['trace']],
    ['a task with no scorer output', (e: CampaignEntry[]) => { e[1]!.scorer = null; }, ['scorer']],
    ['a not-graded task with no reason', (e: CampaignEntry[]) => { e[1]!.scorer = { status: 'not-graded', score: null }; }, ['scorer']],
    ['a task with neither', (e: CampaignEntry[]) => { e[1]!.trace = null; e[1]!.scorer = null; }, ['trace', 'scorer']],
  ])('%s makes the bundle incomplete and names the gap', (_label, mutate, lacks) => {
    const entries = twoTaskCampaign();
    mutate(entries);
    const b = buildCampaignBundle({ campaignId: 'pilot', completedAt: COMPLETED, entries });
    expect(b.manifest.complete).toBe(false);
    expect(b.manifest.missing).toEqual([{ suite: 'frontier-swe', taskId: 'org/repo:astro-toolkit', arm: 'su', seed: 0, lacks }]);
    // The incomplete bundle is still built — the gap is evidence, not a silently dropped task.
    expect(b.manifest.taskCount).toBe(2);
  });

  it('an explicitly absent trace with a reason, or a not-graded attempt with a reason, still counts as complete', () => {
    const entries = twoTaskCampaign();
    entries[0]!.trace = { absentReason: 'agent crashed before the first turn; no transcript exists' };
    entries[1]!.scorer = { status: 'not-graded', score: null, reason: 'generation failed: budget exhausted' };
    expect(buildCampaignBundle({ campaignId: 'pilot', completedAt: COMPLETED, entries }).manifest.complete).toBe(true);
  });

  it('records a label correction beside the raw score and reports raw and corrected aggregates', () => {
    const entries = twoTaskCampaign();
    const b = buildCampaignBundle({ campaignId: 'pilot', completedAt: COMPLETED, entries, labelCorrections: [
      { suite: 'frontier-swe', taskId: 'org/repo:cranelift-opt', correctedScore: 1, reason: 'gold expected output was stale upstream',
        sourceRef: 'https://example.invalid/issue/1' }] });
    expect(b.manifest.labelCorrections).toEqual([{ suite: 'frontier-swe', taskId: 'org/repo:cranelift-opt', arm: 'su', seed: 0,
      rawScore: 0.75, correctedScore: 1, reason: 'gold expected output was stale upstream', sourceRef: 'https://example.invalid/issue/1' }]);
    expect(b.manifest.aggregates.raw.su).toEqual({ attempts: 2, scored: 1, meanScore: 0.75 });
    expect(b.manifest.aggregates.corrected.su).toEqual({ attempts: 2, scored: 1, meanScore: 1 });
    const task = b.files.find((f) => f.rel.includes('cranelift-opt'))!.body as CampaignEntry;
    expect(task.scorer?.score).toBe(0.75); // the correction never overwrites the scorer output
  });

  it('refuses ambiguous input instead of guessing', () => {
    const dup = [...twoTaskCampaign(), twoTaskCampaign()[0]!];
    expect(() => buildCampaignBundle({ campaignId: 'p', completedAt: COMPLETED, entries: dup })).toThrow(/duplicate campaign entry/);
    expect(() => buildCampaignBundle({ campaignId: 'p', completedAt: 'not a date', entries: [] })).toThrow(/not a valid date/);
    expect(() => buildCampaignBundle({ campaignId: 'p', completedAt: COMPLETED, entries: twoTaskCampaign(), labelCorrections: [
      { suite: 'frontier-swe', taskId: 'nope', correctedScore: 1, reason: 'r', sourceRef: 's' }] })).toThrow(/matches no attempt/);
    expect(() => buildCampaignBundle({ campaignId: 'p', completedAt: COMPLETED, entries: twoTaskCampaign(), labelCorrections: [
      { suite: 'frontier-swe', taskId: 'org/repo:cranelift-opt', correctedScore: 1, reason: '', sourceRef: 's' }] })).toThrow(/needs a reason/);
  });
});

describe('campaignEntriesFromFrontierSweResults', () => {
  it('keeps the latest record per attempt, carries scorer detail, and leaves an uncaptured trace as a visible gap', () => {
    const entries = campaignEntriesFromFrontierSweResults([
      { instanceId: 'cranelift-opt', seed: 0, arm: 'su', score: null, resolved: null, graderStatus: 'error' },
      { instanceId: 'cranelift-opt', seed: 0, arm: 'su', score: 0.5, resolved: false, graderStatus: 'failed',
        graderDetail: { rewardSource: 'reward.json' }, traceRefs: ['traces/c-0.jsonl', 'traces/c-0-judge.jsonl'] },
      { instanceId: 'astro-toolkit', seed: 0, arm: 'su', score: null, resolved: null, graderStatus: 'invalid',
        graderDetail: { integrity: { verdict: 'tampered' } } },
    ], 'frontier-swe-v2');
    expect(entries).toEqual([
      { suite: 'frontier-swe-v2', taskId: 'cranelift-opt', arm: 'su', seed: 0,
        trace: { ref: 'traces/c-0.jsonl', related: ['traces/c-0-judge.jsonl'] }, // graded agent first, the rest related
        scorer: { status: 'failed', score: 0.5, resolved: false, detail: { rewardSource: 'reward.json' } } },
      { suite: 'frontier-swe-v2', taskId: 'astro-toolkit', arm: 'su', seed: 0, trace: null,
        scorer: { status: 'invalid', score: null, resolved: null, detail: { integrity: { verdict: 'tampered' } } } },
    ]);
    const m = buildCampaignBundle({ campaignId: 'fswe', completedAt: COMPLETED, entries }).manifest;
    expect(m.complete).toBe(false);
    expect(m.missing).toEqual([{ suite: 'frontier-swe-v2', taskId: 'astro-toolkit', arm: 'su', seed: 0, lacks: ['trace'] }]);
  });
});

describe('campaignEntryFromRollout', () => {
  const rollout = {
    rolloutId: 'r1', runId: 'run', preregHash: 'h', suite: 'frontier-swe', taskId: 't', arm: 'su', seed: 2, modelId: 'm',
    harnessVersion: 'v', graderFamily: 'g', graderVersion: '1', createdAt: COMPLETED,
    graderOutput: { report: 'ok' }, rawGraderOutput: '1.0', submission: 'diff', trajectoryRef: 'traces/t.jsonl', trajectoryKind: 'jsonl',
  } as unknown as RolloutRecord;

  it('maps the rollout card\'s trajectory, grader output and submission onto the entry', () => {
    expect(campaignEntryFromRollout({ suite: 'frontier-swe', taskId: 't', arm: 'su', seed: 2, score: 1, resolved: true, graderStatus: 'passed' }, rollout))
      .toEqual({ suite: 'frontier-swe', taskId: 't', arm: 'su', seed: 2, trace: { ref: 'traces/t.jsonl', kind: 'jsonl' },
        scorer: { status: 'passed', score: 1, resolved: true, detail: { report: 'ok' }, raw: '1.0' }, prediction: 'diff' });
  });

  it('a missing rollout card leaves the trace gap visible rather than inventing one', () => {
    const e = campaignEntryFromRollout({ suite: 'frontier-swe', taskId: 't', arm: 'su', seed: 2, score: null, graderStatus: 'error' }, null);
    expect(e.trace).toBeNull();
    expect(buildCampaignBundle({ campaignId: 'p', completedAt: COMPLETED, entries: [e] }).manifest.missing[0]!.lacks).toEqual(['trace']);
  });
});
