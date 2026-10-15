import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Keep this fixture synchronized with the persisted recipe via recipes:revise.
const script = readFileSync(
  new URL('./fixtures/read-live-green-checkpoint-verdict-candidate-cells-routine-health.recipe.txt', import.meta.url),
  'utf8',
);

function trackMissingReads(value: unknown, path: string, misses: string[]): unknown {
  if (!value || typeof value !== 'object') return value;
  const probeKeys = new Set(['then', 'toJSON', 'constructor', 'inspect', 'nodeType', '$$typeof']);
  return new Proxy(value, {
    get(target, key, receiver) {
      if (
        typeof key === 'string'
        && !(key in target)
        && !probeKeys.has(key)
        && !(Array.isArray(target) && /^\d+$/.test(key))
      ) misses.push(`${path}.${key}`);
      const child = Reflect.get(target, key, receiver);
      return trackMissingReads(child, `${path}.${String(key)}`, misses);
    },
  });
}

function run(routineResult: unknown) {
  const misses: string[] = [];
  const cells: Record<string, unknown> = {
    'gate.greenCheckpoint.verdict': {
      ok: true,
      status: 'value',
      cell: 'gate.greenCheckpoint.verdict',
      value: { state: 'green', failingTests: [] },
      source: { authoritative: true },
    },
    'gate.greenCheckpoint.candidate': {
      ok: true,
      status: 'unknown',
      cell: 'gate.greenCheckpoint.candidate',
      unknown: { code: 'not-measured', detail: 'No candidate has been measured.' },
    },
    'gate.greenCheckpoint.ownership': {
      ok: true,
      status: 'absent',
      cell: 'gate.greenCheckpoint.ownership',
    },
    'git.mainBehindStaging': {
      ok: true,
      status: 'value',
      cell: 'git.mainBehindStaging',
      value: 0,
    },
    'deploy.3070.sha': {
      ok: true,
      status: 'unknown',
      cell: 'deploy.3070.sha',
      unknown: { code: 'insufficient-data', detail: 'No deployed SHA was supplied.' },
    },
  };
  const readCell = vi.fn(async ({ cell }: { cell: string }) =>
    trackMissingReads(cells[cell], `state.read.${cell}`, misses));
  const listRoutines = vi.fn(async () => trackMissingReads(routineResult, 'routines.list', misses));
  const context = vm.createContext({ tools: { state: { read: readCell }, routines: { list: listRoutines } } });
  const result = vm.runInContext('(async () => {\n' + script + '\n})()', context) as Promise<Record<string, unknown>>;
  return { result, misses, readCell, listRoutines };
}

function runLegacyOptionalFieldProbe() {
  const misses: string[] = [];
  const cell = trackMissingReads({
    ok: true,
    status: 'unknown',
    cell: 'gate.greenCheckpoint.candidate',
    unknown: { code: 'not-measured', detail: 'No candidate has been measured.' },
  }, 'state.read.candidate', misses);
  const readCell = vi.fn(async () => cell);
  const context = vm.createContext({ tools: { state: { read: readCell } } });
  const legacyScript = `
    const result = await tools.state.read({ cell: 'gate.greenCheckpoint.candidate' });
    return { status: result.status, value: result.value, src: result.source && result.source.authoritative };
  `;
  const result = vm.runInContext('(async () => {\n' + legacyScript + '\n})()', context) as Promise<unknown>;
  return { result, misses };
}

const routine = {
  name: 'green-checkpoint',
  active: true,
  lastFiredAt: '2026-10-15T12:00:00.000Z',
  nextFireAt: '2026-10-15T13:00:00.000Z',
  health: { status: 'healthy' },
};

describe('read-live-green-checkpoint-verdict-candidate-cells-routine-health saved recipe', () => {
  it('identifies unguarded value/source reads on an unknown state:read result', async () => {
    const probe = runLegacyOptionalFieldProbe();
    await probe.result;

    expect(probe.misses).toEqual(expect.arrayContaining([
      'state.read.candidate.value',
      'state.read.candidate.source',
    ]));
  });

  it.each([
    ['routines result', { count: 1, routines: [routine] }],
    ['data envelope', { data: { count: 1, routines: [routine] } }],
    ['results envelope', { results: [routine] }],
    ['optional routine fields', { routines: [{ name: 'green-checkpoint', active: true }] }],
  ])('handles %s without reading absent fields', async (_label, routineResult) => {
    const scan = run(routineResult);
    const result = await scan.result;

    expect(scan.misses).toEqual([]);
    expect(scan.readCell).toHaveBeenCalledTimes(5);
    expect(scan.listRoutines).toHaveBeenCalledTimes(1);
    expect(result['gate.greenCheckpoint.verdict']).toMatchObject({ status: 'value', src: true });
    expect(result['gate.greenCheckpoint.candidate']).toMatchObject({ status: 'unknown' });
    expect(result['gate.greenCheckpoint.ownership']).toMatchObject({ status: 'absent' });
    expect(result['git.mainBehindStaging']).toMatchObject({ status: 'value', value: 0 });
    expect(result['deploy.3070.sha']).toMatchObject({ status: 'unknown' });
  });
});
