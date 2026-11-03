import { beforeEach, describe, expect, it, vi } from 'vitest';
const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock('../events/await/predicate-watch', async importOriginal => ({
  ...(await importOriginal<typeof import('../events/await/predicate-watch')>()),
  dispatchReadOnlyTool: (...args: unknown[]) => dispatch(...args),
}));
import { readCell } from '../cell-read';
import { __resetCellRegistryForTests, getCell, validateCellSpec } from '../cell-registry';
import { registerBuiltinCells, GIT_PIPELINE_POSITION_CELL, GATE_RUN_CELL, GATE_VERDICT_CELL } from '../cell-registrations';
import { HARNESS_CHECKPOINT_CELL } from './harness-checkpoint-cell';
import { readHarnessCheckpointState } from './harness-checkpoint-state';

beforeEach(() => { __resetCellRegistryForTests(); dispatch.mockReset(); registerBuiltinCells(); });

describe('gate.harnessCheckpoint registry and caller context', () => {
  it('registers a caller-relative cell while keeping home pipeline audiences restricted', () => {
    expect(validateCellSpec(HARNESS_CHECKPOINT_CELL)).toEqual([]);
    const reader = { ownerId: 'su-drill', harnessSlug: 'isolated-drill', roles: ['su'] };
    expect(getCell(HARNESS_CHECKPOINT_CELL.cell, reader)).toEqual(HARNESS_CHECKPOINT_CELL);
    for (const home of [GIT_PIPELINE_POSITION_CELL, GATE_RUN_CELL, GATE_VERDICT_CELL]) {
      expect(home.visibility).toEqual({ kind: 'harness', ref: 'papercusp' });
      expect(getCell(home.cell, reader)).toBeUndefined();
    }
  });

  it('uses each authenticated dispatch context, including concurrent callers', async () => {
    dispatch.mockImplementation(async (_tool: string, _args: unknown, env: { workspaceId: string; harnessSlug: string }) => ({
      checkpoint: await readHarnessCheckpointState(env, async () => ({}), 100),
    }));
    const read = (workspaceId: string, harnessSlug: string) => readCell(HARNESS_CHECKPOINT_CELL.cell,
      { ownerId: 'su-reader', roles: ['su'], harnessSlug },
      { workspaceId, harnessSlug, role: 'su' });
    const [first, second] = await Promise.all([read('workspace-a', 'isolated-drill'), read('workspace-b', 'other-pot')]);
    expect(first).toMatchObject({ status: 'value', value: { target: { workspaceId: 'workspace-a', installSlug: 'isolated-drill' } } });
    expect(second).toMatchObject({ status: 'value', value: { target: { workspaceId: 'workspace-b', installSlug: 'other-pot' } } });
    expect(dispatch).toHaveBeenCalledTimes(2);
    for (const call of dispatch.mock.calls) expect(call.slice(0, 2)).toEqual(['checkpoint:state_snapshot', {}]);
  });

  it('preserves a failed metadata read as an explicit unknown on the cell value', async () => {
    dispatch.mockResolvedValue({ checkpoint: await readHarnessCheckpointState(
      { workspaceId: 'workspace-a', harnessSlug: 'isolated-drill' }, async () => { throw new Error('unreadable'); }, 100) });
    const result = await readCell(HARNESS_CHECKPOINT_CELL.cell,
      { ownerId: 'su-reader', roles: ['su'], harnessSlug: 'isolated-drill' },
      { workspaceId: 'workspace-a', harnessSlug: 'isolated-drill', role: 'su' });
    expect(result).toMatchObject({ status: 'value', value: {
      assessment: 'unavailable', unknown: ['checkpoint-record-read-failed'],
    } });
  });
});
