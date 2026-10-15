/**
 * Pure unit tests for the AgentsNet ingest mapping (plan
 * benchmark-suite-agentsnet-2026-06-17, P-004) — no DB. Verifies the D-003 dual
 * metric mapping (binary resolved + continuous score), the infra-failure path, the
 * stable task id, and the results-dir reader.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentsnetTaskId,
  agentsnetResultToEmitInput,
  readAgentsnetResults,
  agentsnetResultsModelId,
  type AgentsnetResultFile,
  type AgentsnetIngestCtx,
} from './agentsnet-ingest';

describe('agentsnetResultsModelId — the ingested model comes from the results, never a default (R-9)', () => {
  const row = (model_name: string) => ({ model_name }) as AgentsnetResultFile;
  it('returns the single model the result files name', () => {
    expect(agentsnetResultsModelId([row('model-a'), row(' model-a ')])).toBe('model-a');
  });
  it('refuses an empty or mixed set instead of guessing', () => {
    expect(() => agentsnetResultsModelId([])).toThrow(/no model.*pass modelId/);
    expect(() => agentsnetResultsModelId([row('')])).toThrow(/no model/);
    expect(() => agentsnetResultsModelId([row('model-a'), row('model-b')])).toThrow(/2 models \(model-a, model-b\)/);
  });
});

const ctx: AgentsnetIngestCtx = {
  runId: 'run-an-1',
  preregHash: 'hash',
  arm: 'baseline-b-native',
  modelId: 'claude-opus-4-8',
  harnessVersion: 'agentsnet@abc',
};

const base: AgentsnetResultFile = {
  task: 'consensus',
  num_nodes: 4,
  graph_generator: 'ws',
  graph_index: 0,
  rounds: 3,
  model_name: 'claude-opus-4-8',
  score: 1.0,
  successful: true,
  tokens_in: 38303,
  tokens_out: 9748,
};

describe('agentsnetTaskId', () => {
  it('is stable per graph×task', () => {
    expect(agentsnetTaskId(base)).toBe('agentsnet_ws_4_0_consensus');
  });
});

describe('agentsnetResultToEmitInput', () => {
  it('a perfect score → resolved=true (binary headline), score=1 (continuous), passed', () => {
    const e = agentsnetResultToEmitInput(base, ctx);
    expect(e.suite).toBe('agentsnet');
    expect(e.arm).toBe('baseline-b-native');
    expect(e.modality).toBe('in-container');
    expect(e.taskId).toBe('agentsnet_ws_4_0_consensus');
    expect(e.grading.resolved).toBe(true);
    expect(e.grading.score).toBe(1.0);
    expect(e.grading.status).toBe('passed');
    expect(e.generation.status).toBe('completed');
    expect(e.generation.tokensTotal).toBe(38303 + 9748);
    expect(e.generation.modelId).toBe('claude-opus-4-8');
  });

  it('a partial score → resolved=false (binary), score preserved (continuous nuance)', () => {
    const e = agentsnetResultToEmitInput({ ...base, task: 'coloring', score: 0.67 }, ctx);
    expect(e.grading.resolved).toBe(false);
    expect(e.grading.score).toBeCloseTo(0.67);
    expect(e.grading.status).toBe('failed');
    expect(e.generation.status).toBe('completed');
  });

  it('a failed run (score null / successful false) → infra row: resolved null, score null, error', () => {
    const e = agentsnetResultToEmitInput(
      { ...base, score: null, successful: false, error_message: 'boom' },
      ctx,
    );
    expect(e.grading.resolved).toBeNull();
    expect(e.grading.score).toBeNull();
    expect(e.grading.status).toBe('error');
    expect(e.generation.status).toBe('error');
    expect(e.generation.error).toContain('boom');
  });

  it('route B sets arm=papercusp (substrate-as-transport)', () => {
    const e = agentsnetResultToEmitInput(base, { ...ctx, arm: 'papercusp' });
    expect(e.arm).toBe('papercusp');
  });
});

describe('readAgentsnetResults', () => {
  it('reads agentsnet result jsons, skips malformed / non-agentsnet / non-json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'an-res-'));
    try {
      writeFileSync(join(dir, 'a.json'), JSON.stringify(base));
      writeFileSync(join(dir, 'b.json'), JSON.stringify({ ...base, graph_index: 1, score: 0.5 }));
      writeFileSync(join(dir, 'notjson.txt'), 'x');
      writeFileSync(join(dir, 'malformed.json'), '{not json');
      writeFileSync(join(dir, 'other.json'), JSON.stringify({ foo: 1 }));
      const rows = readAgentsnetResults(dir);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.graph_index).sort()).toEqual([0, 1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] for a missing dir', () => {
    expect(readAgentsnetResults('/no/such/dir/xyz')).toEqual([]);
  });
});
