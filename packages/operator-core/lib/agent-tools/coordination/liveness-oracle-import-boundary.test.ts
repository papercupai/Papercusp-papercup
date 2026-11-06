import { expect, it, vi } from 'vitest';

// Governor lease admission reads liveness in the focused runner's parent.
// Loading the wake dispatcher here also loads cell-read, so a worker-only
// mutation contaminates the launcher and cannot produce valid proof.
vi.mock('./inbox-wake', () => {
  throw new Error('liveness eagerly evaluated the wake dispatcher');
});
vi.mock('../../cell-read', () => {
  throw new Error('liveness eagerly evaluated the cell dispatcher');
});

it('reads liveness without evaluating wake or cell dispatch', async () => {
  const { resolveSessionStates } = await import('./liveness-oracle');
  const { fetchSelfWake } = await import('./presence-selfwake');
  expect(resolveSessionStates).toBeTypeOf('function');

  const queries: string[] = [];
  const sql = vi.fn(async (parts: TemplateStringsArray) => {
    queries.push(parts.join('?'));
    return [];
  });
  const states = await fetchSelfWake(['su-import-boundary'], sql as never);
  expect(states.get('su-import-boundary')).toMatchObject({
    loopArmed: false,
    standingEventAwait: false,
    selfWake: 'none',
  });
  expect(queries.some(query => query.includes('harness_shared.routines'))).toBe(true);
  expect(queries.some(query => query.includes('harness_shared.event_awaits'))).toBe(true);
});
