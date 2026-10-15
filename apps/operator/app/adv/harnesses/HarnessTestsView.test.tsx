// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Profiler } from 'react';
import type { TestingShellProps } from '@papercusp/testing-shell';
import { HARNESS_TESTING_TIER_LABELS, harnessTestingRegistry } from '@papercusp/operator-core/lib/harness-testing-registry';

const shell = vi.hoisted(() => ({ current: undefined as TestingShellProps | undefined }));
vi.mock('@papercusp/testing-shell', async (importOriginal) => {
  const original = await importOriginal<typeof import('@papercusp/testing-shell')>();
  return {
    ...original,
    // Observe the actual wrapper's props; registry projection and data source stay real.
    TestingShell: (props: TestingShellProps) => {
      shell.current = props;
      return <div>
        <div data-testid="tabs">{JSON.stringify(props.tabs.map((tab) => tab.id))}</div>
        <div data-testid="tiers">{JSON.stringify(props.tierLabels)}</div>
        <button onClick={() => void props.dataSource.fetchDomain('domain/qa')}>Read domain</button>
      </div>;
    },
  };
});
vi.mock('@/app/admin/testing/testing-custom-tabs', () => {
  const tabs = [{ id: 'live-web', label: 'Live', tier: 'universal', kind: 'panel' }];
  const customTabs = {};
  return { useUniversalTestingTabs: () => tabs, useTestingCustomTabs: () => customTabs };
});
vi.mock('./AcceptancePanel', () => ({ default: () => null }));

import HarnessTestsView from './HarnessTestsView';

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((finish) => { resolve = finish; });
  return { promise, resolve };
}
function declared(id: string, tier = 'Project') {
  return new Response(JSON.stringify({
    domains: [{ id, label: id, tier: 'project', description: '', sections: [] }],
    tierLabels: { project: tier },
  }), { status: 200 });
}
function tabIds() { return JSON.parse(screen.getByTestId('tabs').textContent!) as string[]; }
function expectFallback() {
  expect(tabIds()).toEqual([...harnessTestingRegistry.map((domain) => domain.id), 'live-web']);
  expect(JSON.parse(screen.getByTestId('tiers').textContent!)).toEqual(HARNESS_TESTING_TIER_LABELS);
}
async function loadedOldPot(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock);
  const view = render(<HarnessTestsView slug="old-pot" />);
  await waitFor(() => expect(tabIds()).toEqual(['old-private-domain', 'live-web']));
  expect(screen.getByTestId('tiers').textContent).toContain('Old private tier');
  return view;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); shell.current = undefined; });

describe('HarnessTestsView registry identity', () => {
  it('uses fallback navigation on the first committed new-pot render while its registry is pending', async () => {
    const pending = deferred();
    const fetchMock = vi.fn().mockResolvedValueOnce(declared('old-private-domain', 'Old private tier'))
      .mockReturnValueOnce(pending.promise);
    vi.stubGlobal('fetch', fetchMock);
    const commits: string[][] = [];
    const view = render(<Profiler id="tests" onRender={() => commits.push(tabIds())}>
      <HarnessTestsView slug="old-pot" />
    </Profiler>);
    await waitFor(() => expect(tabIds()).toContain('old-private-domain'));
    commits.length = 0;
    view.rerender(<Profiler id="tests" onRender={() => commits.push(tabIds())}>
      <HarnessTestsView slug="new pot/qa" />
    </Profiler>);
    expectFallback();
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.every((ids) => !ids.includes('old-private-domain'))).toBe(true);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/harness/new%20pot%2Fqa/testing/domains?phase=staging');
  });

  it.each([
    ['HTTP 403', () => Promise.resolve(new Response(null, { status: 403 }))],
    ['HTTP 500', () => Promise.resolve(new Response(null, { status: 500 }))],
    ['network rejection', () => Promise.reject(new Error('offline'))],
    ['empty domains', () => Promise.resolve(new Response(JSON.stringify({ domains: [] })))],
    ['missing domains', () => Promise.resolve(new Response(JSON.stringify({ ok: true })))],
    ['invalid JSON', () => Promise.resolve(new Response('{'))],
  ])('keeps the new pot fallback after %s instead of restoring old navigation', async (_label, outcome) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(declared('old-private-domain', 'Old private tier'))
      .mockImplementationOnce(outcome);
    const view = await loadedOldPot(fetchMock);
    view.rerender(<HarnessTestsView slug="denied-pot" />);
    await act(async () => { await Promise.resolve(); });
    expectFallback();
  });

  it('replaces both navigation and tier labels when the new pot succeeds and reads from its data source', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(declared('old-private-domain', 'Old private tier'))
      .mockResolvedValueOnce(declared('new-domain', 'New tier'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'domain/qa' })));
    const view = await loadedOldPot(fetchMock);
    const oldDataSource = shell.current!.dataSource;
    view.rerender(<HarnessTestsView slug="new pot/qa" />);
    await waitFor(() => expect(tabIds()).toEqual(['new-domain', 'live-web']));
    expect(screen.getByTestId('tiers').textContent).toBe(JSON.stringify({ project: 'New tier' }));
    expect(shell.current!.dataSource).not.toBe(oldDataSource);
    fireEvent.click(screen.getByRole('button', { name: 'Read domain' }));
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/harness/new%20pot%2Fqa/testing/domain-detail?domainId=domain%2Fqa&phase=staging',
    ));
  });

  it('ignores a late old-pot response after the new pot succeeds', async () => {
    const old = deferred();
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(declared('current-domain', 'Current tier')));
    const view = render(<HarnessTestsView slug="old-pending-pot" />);
    expectFallback();
    view.rerender(<HarnessTestsView slug="current-pot" />);
    await waitFor(() => expect(tabIds()).toEqual(['current-domain', 'live-web']));
    await act(async () => old.resolve(declared('late-old-domain', 'Late old tier')));
    expect(tabIds()).toEqual(['current-domain', 'live-web']);
    expect(screen.getByTestId('tiers').textContent).toBe(JSON.stringify({ project: 'Current tier' }));
  });

  it('keeps a successful same-pot registry and data source across ordinary rerenders', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(declared('old-private-domain', 'Old private tier'));
    const view = await loadedOldPot(fetchMock);
    const dataSource = shell.current!.dataSource;
    view.rerender(<HarnessTestsView slug="old-pot" />);
    expect(tabIds()).toEqual(['old-private-domain', 'live-web']);
    expect(shell.current!.dataSource).toBe(dataSource);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
