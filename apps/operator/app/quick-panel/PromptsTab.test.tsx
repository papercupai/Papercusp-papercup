// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PromptsTab from './PromptsTab';

vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => ({ data: [{
  id: 'private-prompt', workspaceId: 'test-workspace', harnessSlug: null, name: 'canary',
  title: 'Canary prompt', body: 'Exact saved note', parentId: null, position: 'a0',
  collapsed: false, pinned: false, archivedAt: null, completedAt: null,
  usageCount: 0, lastUsedAt: null,
}], invalidate: vi.fn() }) }));

afterEach(cleanup);

describe('Quick Panel prompt zoom accessibility', () => {
  it.each(['', '&qpq=Canary'])('keeps zoom usable with filter %s and preserves host query state', async filter => {
    const onUrlUpdate = vi.fn();
    render(<NuqsTestingAdapter searchParams={'?q=host-search' + filter} hasMemory onUrlUpdate={onUrlUpdate}>
      <PromptsTab queryPrefix="qp" />
    </NuqsTestingAdapter>);
    const zoom = screen.getByRole('button', { name: 'Zoom into Canary prompt (drag to move)' });
    expect(zoom.getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(zoom);
    const title = await screen.findByRole('textbox', { name: 'Zoomed node title' });
    expect((title as HTMLTextAreaElement).value).toBe('Canary prompt');
    const update = onUrlUpdate.mock.calls.at(-1)?.[0];
    expect(update.searchParams.get('qpzoom')).toBe('private-prompt');
    expect(update.searchParams.get('q')).toBe('host-search');
    expect(update.searchParams.get('qpq')).toBe(filter ? 'Canary' : null);
  });
});
