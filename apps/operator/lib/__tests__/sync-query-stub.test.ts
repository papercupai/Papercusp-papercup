// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { stubSyncQueries } from '../../e2e/_sync-stub';

class FixtureSource extends EventTarget {
  static CLOSED = 2;
  readyState = 0;
  url = 'http://fixture/api/zero-harness/sse';
  close() { this.readyState = FixtureSource.CLOSED; }
}

afterEach(() => {
  Reflect.deleteProperty(window, '__syncQueryFixtureSources');
  vi.unstubAllGlobals();
});

function fixture(sources: Set<FixtureSource>, replaceClosed?: () => void) {
  vi.stubGlobal('EventSource', FixtureSource);
  Object.assign(window, { __syncQueryFixtureSources: sources });
  const page = {
    addInitScript: vi.fn(),
    route: vi.fn(),
    waitForFunction: async (predicate: (arg?: unknown) => unknown, arg?: unknown) => {
      let result = predicate(arg);
      if (!result && replaceClosed) {
        replaceClosed();
        result = predicate(arg);
      }
      if (!result) throw new Error('fixture readiness deadline expired');
      // A reconnect can close the source as soon as this browser task ends,
      // before a separate Playwright evaluate call starts its dispatch.
      for (const source of sources) source.close();
    },
    evaluate: async (fn: (arg?: unknown) => unknown, arg?: unknown) => fn(arg),
  } as unknown as Page;
  return page;
}

describe('sync fixture push delivery across reconnects', () => {
  it('delivers before a ready source closes between browser tasks', async () => {
    const source = new FixtureSource();
    const received: unknown[] = [];
    source.addEventListener('invalidate', event => received.push(JSON.parse((event as MessageEvent).data)));
    const stub = await stubSyncQueries(fixture(new Set([source])), () => [], { push: true });

    await stub.invalidate('goals.detail', { goalId: 'arbitrary-goal' });

    expect(received).toEqual([expect.objectContaining({ name: 'goals.detail', args: { goalId: 'arbitrary-goal' } })]);
  });

  it('waits for a replacement generation and delivers exactly once', async () => {
    const old = new FixtureSource();
    old.close();
    const sources = new Set([old]);
    const replacement = new FixtureSource();
    const received = vi.fn();
    replacement.addEventListener('invalidate', received);
    const stub = await stubSyncQueries(fixture(sources, () => sources.add(replacement)), () => [], { push: true });

    await stub.invalidate('goals.detail');

    expect(received).toHaveBeenCalledOnce();
  });

  it('refuses an invalidation when no source can receive it', async () => {
    const source = new FixtureSource();
    source.close();
    const received = vi.fn();
    source.addEventListener('invalidate', received);
    const stub = await stubSyncQueries(fixture(new Set([source])), () => [], { push: true });

    await expect(stub.invalidate('goals.detail')).rejects.toThrow('SYNC_FIXTURE_PUSH_UNAVAILABLE query=goals.detail');
    expect(received).not.toHaveBeenCalled();
  });
});
