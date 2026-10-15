/**
 * P-017 (D-013 rule 5): the rg arm passes the conformance gate against REAL
 * ripgrep on the materialized micro repo, not only against captured output.
 * Integration because it spawns an external binary (PAPERCUSP_RG_BIN, else
 * `rg` on PATH); a missing rg fails loudly rather than skipping.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRgFairArm, materializeMicroRepo, RG_INTENTS, runConformance } from './fair-comparison-arms';
import { MICRO_CASES, microRepoKeys } from './fair-comparison-micro-repo';

const rgBin = process.env.PAPERCUSP_RG_BIN ?? 'rg';

describe('rg arm on the materialized micro repo (real ripgrep)', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fair-rg-'));
    await materializeMicroRepo(dir);
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('ripgrep is installed', () => {
    expect(execFileSync(rgBin, ['--version'], { encoding: 'utf8' })).toMatch(/^ripgrep \d+/);
  });

  it('passes conformance: no crash, every plain declared case exact', async () => {
    const arm = createRgFairArm(dir, { loadAvg1: () => null }, rgBin);
    expect(arm.capabilities.intents).toEqual(RG_INTENTS);
    const report = await runConformance(arm, MICRO_CASES, microRepoKeys());
    expect(report.defects).toEqual([]);
    expect(report.ok).toBe(true);
    // Every declared case was actually asked: none came back declined.
    const declared = report.scores.filter((s) => RG_INTENTS.includes(s.intent));
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.every((s) => s.outcome !== 'declined')).toBe(true);
  });
});
