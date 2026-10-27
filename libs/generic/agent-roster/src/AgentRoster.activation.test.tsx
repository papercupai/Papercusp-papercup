// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRoster } from './AgentRoster';
import type { RosterAgent } from './types';

const agent: RosterAgent = {
  ownerId: 'su-portal-agent',
  label: 'su · portal',
  agent: 'codex',
  role: 'worker',
  intent: 'checking the portal',
  feature: null,
  currentPlanSlug: null,
  liveness: 'live',
  sessionState: 'live',
  heartbeatAt: '2026-08-31T19:00:00.000Z',
  lastActiveAt: '2026-08-31T19:00:00.000Z',
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('AgentRoster host-owned row activation', () => {
  it('activates a row even when the host has no transcript handle', () => {
    const onRowActivate = vi.fn();
    render(<AgentRoster agents={[agent]} nowMs={Date.parse('2026-08-31T19:01:00.000Z')} onRowActivate={onRowActivate} />);

    fireEvent.click(screen.getByTestId('agent-row-su-portal-agent'));

    expect(onRowActivate).toHaveBeenCalledTimes(1);
    expect(onRowActivate).toHaveBeenCalledWith(agent);
  });

  it('uses the same host action for keyboard activation', () => {
    const onRowActivate = vi.fn();
    render(<AgentRoster agents={[agent]} nowMs={Date.parse('2026-08-31T19:01:00.000Z')} onRowActivate={onRowActivate} />);
    const row = screen.getByTestId('agent-row-su-portal-agent');

    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });

    expect(onRowActivate).toHaveBeenCalledTimes(2);
  });
});

describe('AgentRoster thinking indicators', () => {
  it.each([
    { sessionState: 'live', transcriptFresh: false, expected: true },
    { sessionState: 'parked', transcriptFresh: true, expected: false },
    { sessionState: 'ended', transcriptFresh: true, expected: false },
    { sessionState: null, transcriptFresh: true, expected: false },
  ])('keeps the row and detail consistent for $sessionState with transcriptFresh=$transcriptFresh',
    ({ sessionState, transcriptFresh, expected }) => {
      render(<AgentRoster agents={[{ ...agent, sessionState, transcriptFresh }]}
        nowMs={Date.parse('2026-08-31T19:01:00.000Z')} />);
      const row = screen.getByTestId('agent-row-su-portal-agent');
      expect(row.querySelector('[data-liveness="thinking"]') != null).toBe(expected);
      fireEvent.mouseEnter(row);
      expect(screen.getByTestId('agent-detail').querySelector('[data-liveness="thinking"]') != null)
        .toBe(expected);
    });
});

describe('AgentRoster stop outcome', () => {
  const nowMs = Date.parse('2026-08-31T19:01:00.000Z');

  it('cancels without dispatching and requires a fresh confirmation for the retained selection', () => {
    const kill = vi.fn().mockResolvedValue('Stop requested for 1 session');
    render(<AgentRoster agents={[agent]} nowMs={nowMs} bulk={{ kill, killLabel: 'Stop' }} />);
    fireEvent.click(screen.getByTestId('agent-select-su-portal-agent'));
    fireEvent.click(screen.getByTestId('agents-bulk-kill'));

    fireEvent.click(screen.getByTestId('agents-bulk-kill-cancel'));

    expect(kill).not.toHaveBeenCalled();
    expect((screen.getByTestId('agent-select-su-portal-agent') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId('agents-bulk-kill-cancel')).toBeNull();
    expect(screen.getByTestId('agents-bulk-kill').textContent).toBe('✕ Stop');

    fireEvent.click(screen.getByTestId('agents-bulk-kill'));

    expect(kill).not.toHaveBeenCalled();
    expect(screen.getByTestId('agents-bulk-kill-cancel')).toBeTruthy();
  });

  it('keeps the successful receipt visible after clearing the completed selection', async () => {
    const kill = vi.fn().mockResolvedValue('Stop requested for 1 session');
    render(<AgentRoster agents={[agent]} nowMs={nowMs} bulk={{ kill, killLabel: 'Stop' }} />);
    fireEvent.click(screen.getByTestId('agent-select-su-portal-agent'));
    fireEvent.click(screen.getByTestId('agents-bulk-kill'));
    expect(kill).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('agents-bulk-kill'));

    await waitFor(() => expect(screen.getByTestId('agents-bulk-note').textContent).toBe('Stop requested for 1 session'));
    expect(kill).toHaveBeenCalledWith([agent]);
    expect((screen.getByTestId('agent-select-su-portal-agent') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByTestId('agents-bulk-bar')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Stop requested for 1 session');
  });

  it('preserves a refused selection and displays the terminal successful retry', async () => {
    const kill = vi.fn().mockRejectedValueOnce(new Error('workspace denied')).mockResolvedValueOnce('Stop requested for 1 session');
    render(<AgentRoster agents={[agent]} nowMs={nowMs} bulk={{ kill, killLabel: 'Stop' }} />);
    fireEvent.click(screen.getByTestId('agent-select-su-portal-agent'));
    fireEvent.click(screen.getByTestId('agents-bulk-kill'));
    fireEvent.click(screen.getByTestId('agents-bulk-kill'));
    await waitFor(() => expect(screen.getByTestId('agents-bulk-note').textContent).toBe('workspace denied'));
    expect((screen.getByTestId('agent-select-su-portal-agent') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByTestId('agents-bulk-kill'));
    fireEvent.click(screen.getByTestId('agents-bulk-kill'));
    await waitFor(() => expect(screen.getByTestId('agents-bulk-note').textContent).toBe('Stop requested for 1 session'));
    expect(kill.mock.calls).toEqual([[[agent]], [[agent]]]);
    expect((screen.getByTestId('agent-select-su-portal-agent') as HTMLInputElement).checked).toBe(false);
  });
});
