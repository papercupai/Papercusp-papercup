// @vitest-environment jsdom
/**
 * nuqs-tanstack-router-adapter.test.tsx — the pure round-trip helpers at the
 * heart of the custom nuqs↔TanStack-Router adapter. These encode two shipped
 * regressions: the type-faithful decode ("clicking the dev rail closes it" —
 * values must NOT accrete JSON quotes) and the watched-key merge that preserves
 * TanStack's native typed params + applies nuqs deletions.
 *
 * Pure round-trip helpers plus a controlled adapter-lifecycle probe for nuqs's
 * module-global throttle queue across router mounts.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { useQueryState } from 'nuqs';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  decodeQueryValue,
  searchObjectToParams,
  composedSearchToObject,
  NuqsAdapter,
} from './nuqs-tanstack-router-adapter';

function QueueWriteButton({ name, value }: { name: string; value: string }) {
  const [, setValue] = useQueryState(name);
  return <button onClick={() => { void setValue(value); }}>Write {name}</button>;
}

function resetNuqsUpdateQueue() {
  render(<NuqsTestingAdapter />).unmount();
}

async function mountQueueWriter(name: string, value: string) {
  resetNuqsUpdateQueue();
  const root = createRootRoute({
    component: () => <NuqsAdapter><Outlet /><QueueWriteButton name={name} value={value} /></NuqsAdapter>,
  });
  const probe = createRoute({ getParentRoute: () => root, path: '/probe', component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([probe]),
    history: createMemoryHistory({ initialEntries: ['/probe'] }),
  });
  const view = render(<RouterProvider router={router} />);
  await act(async () => { await router.load(); });
  return { ...view, router };
}

describe('adapter lifecycle — nuqs global queue across router mounts', () => {
  it('clears a pending update before an independent router mount', async () => {
    let useFakeTimers = false;
    try {
      const first = await mountQueueWriter('stale', 'from-old-mount');
      vi.useFakeTimers();
      useFakeTimers = true;
      fireEvent.click(screen.getByRole('button', { name: 'Write stale' }));
      first.unmount();

      // mountQueueWriter clears nuqs's module-global queue; the new router
      // must receive its own write instead of sharing the prior flush.
      const second = await mountQueueWriter('fresh', 'from-new-mount');
      fireEvent.click(screen.getByRole('button', { name: 'Write fresh' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

      expect(first.router.state.location.search).not.toHaveProperty('stale');
      expect(first.router.state.location.search).not.toHaveProperty('fresh');
      expect(second.router.state.location.search).not.toHaveProperty('stale');
      expect(second.router.state.location.search).toMatchObject({ fresh: 'from-new-mount' });
    } finally {
      cleanup();
      if (useFakeTimers) vi.useRealTimers();
    }
  });
});

describe('decodeQueryValue — type-faithful nuqs→TanStack decode', () => {
  it('decodes canonical booleans to real booleans (not the quoted strings)', () => {
    expect(decodeQueryValue('true')).toBe(true);
    expect(decodeQueryValue('false')).toBe(false);
  });

  it('decodes canonical numbers to real numbers', () => {
    expect(decodeQueryValue('42')).toBe(42);
    expect(decodeQueryValue('0')).toBe(0);
    expect(decodeQueryValue('-5')).toBe(-5);
    expect(decodeQueryValue('3.14')).toBe(3.14);
  });

  it('keeps plain strings as strings', () => {
    expect(decodeQueryValue('hello')).toBe('hello');
    expect(decodeQueryValue('')).toBe('');
  });

  it('keeps a numeric-looking string that would not round-trip (1e2 ≠ 100)', () => {
    // The documented anti-case: the literal string "1e2" must NOT become 100,
    // because String(100) !== "1e2".
    expect(decodeQueryValue('1e2')).toBe('1e2');
  });

  it('decodes a JSON object string back to an object that re-encodes identically', () => {
    expect(decodeQueryValue('{"a":1}')).toEqual({ a: 1 });
  });

  it('does NOT strip quotes off an already-quoted legacy value (no round-trip)', () => {
    // '"true"' would JSON.parse to the string 'true', which re-encodes to
    // 'true' ≠ '"true"', so the guard keeps the raw input verbatim.
    expect(decodeQueryValue('"true"')).toBe('"true"');
  });
});

describe('searchObjectToParams — typed search → nuqs URLSearchParams', () => {
  it('keeps only the watched keys', () => {
    const p = searchObjectToParams({ a: 1, b: 2 }, ['a']);
    expect(p.get('a')).toBe('1');
    expect(p.has('b')).toBe(false);
  });

  it('stringifies scalars and booleans', () => {
    const p = searchObjectToParams({ n: 42, flag: true, off: false }, ['n', 'flag', 'off']);
    expect(p.get('n')).toBe('42');
    expect(p.get('flag')).toBe('true');
    expect(p.get('off')).toBe('false');
  });

  it('expands arrays into repeated keys', () => {
    const p = searchObjectToParams({ tags: ['x', 'y'] }, ['tags']);
    expect(p.getAll('tags')).toEqual(['x', 'y']);
  });

  it('JSON-stringifies plain objects', () => {
    const p = searchObjectToParams({ o: { a: 1 } }, ['o']);
    expect(p.get('o')).toBe('{"a":1}');
  });

  it('drops an unwatched key even when present in the search object', () => {
    const p = searchObjectToParams({ dock: '1', ws: 'team' }, ['ws']);
    expect(p.has('dock')).toBe(false);
    expect(p.get('ws')).toBe('team');
  });
});

describe('composedSearchToObject — the composed flush state → next search object', () => {
  // The composed URLSearchParams IS the complete next search (unfiltered
  // snapshot + every pending update applied by nuqs's global queue) — native
  // params survive by being in the snapshot, not by merging over prev. See the
  // adapter header's FLUSH SCOPE note (the plan-popup-close regression).
  it("carries TanStack's native typed params through the compose", () => {
    const next = composedSearchToObject(new URLSearchParams('dock=1&foo=baz'));
    expect(next).toEqual({ dock: 1, foo: 'baz' });
  });

  it('a key absent from the composed state (deleted by the flush) does not survive', () => {
    const next = composedSearchToObject(new URLSearchParams('keep=9'));
    expect(next).toEqual({ keep: 9 });
    expect('foo' in next).toBe(false);
  });

  it('decodes values to their typed form (true, not "true")', () => {
    const next = composedSearchToObject(new URLSearchParams('flag=true&n=42'));
    expect(next.flag).toBe(true);
    expect(next.n).toBe(42);
  });

  it('groups repeated keys into an array', () => {
    const next = composedSearchToObject(new URLSearchParams('tag=a&tag=b'));
    expect(next.tag).toEqual(['a', 'b']);
  });
});
