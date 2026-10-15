// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import QuickPanelPage from '../app/quick-panel/page';

const { close } = vi.hoisted(() => ({ close: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ close }) }));
vi.mock('@/lib/flag-hooks', () => ({ useFlag: () => true }));
vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => ({ data: [] }) }));
vi.mock('@papercusp/operator-core/lib/lazy-with-retry', () => ({ lazyWithRetry: () => () => null }));
vi.mock('@/app/harness/Select', () => ({ Select: () => null }));
vi.mock('@/app/_components/OperatorChatSidebar', () => ({ OperatorChatSidebar: () => null }));
vi.mock('../app/quick-panel/PromptsTab', () => ({ default: () => <input aria-label="Prompts" /> }));

afterEach(() => {
  cleanup();
  close.mockClear();
  delete (window as unknown as Record<string, unknown>).__PAPERCUSP_QUICK_PANEL_WINDOW__;
});

describe('the native Quick Panel Docs frame lifecycle', () => {
  it('dismisses after switching to a deferred Docs pane, and cleans up on unmount', async () => {
    (window as unknown as Record<string, unknown>).__PAPERCUSP_QUICK_PANEL_WINDOW__ = true;
    const view = render(
      <NuqsTestingAdapter searchParams="?tab=prompts" hasMemory>
        <QuickPanelPage chatSidebar={false} />
      </NuqsTestingAdapter>,
    );
    expect(screen.queryByTitle('Docs search')).toBeNull();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Docs' }), { button: 0, ctrlKey: false });
    const frame = await screen.findByTitle('Docs search') as HTMLIFrameElement;
    const child = frame.contentWindow!;
    // Simulate the real load after Radix has mounted its previously absent pane.
    fireEvent.load(frame);
    child.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    view.unmount();
    child.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not close a host that embeds Quick Panel outside the native palette', async () => {
    render(<NuqsTestingAdapter searchParams="?tab=docs"><QuickPanelPage chatSidebar={false} /></NuqsTestingAdapter>);
    const frame = await screen.findByTitle('Docs search') as HTMLIFrameElement;
    fireEvent.load(frame);
    frame.contentWindow!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    fireEvent.keyDown(window, { key: 'Escape' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(close).not.toHaveBeenCalled();
  });
});
