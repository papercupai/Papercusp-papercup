// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRoster } from './AgentRoster';
import type { RosterAgent } from './types';

const nowMs = Date.parse('2026-08-31T19:01:00.000Z');
const agents: RosterAgent[] = ['selected-a', 'selected-b', 'unselected'].map(name => ({
  ownerId: `su-${name}`, label: name, agent: 'codex', role: 'worker',
  intent: 'Message control', feature: null, currentPlanSlug: null,
  liveness: 'live', sessionState: 'live',
  heartbeatAt: '2026-08-31T19:00:00.000Z', lastActiveAt: '2026-08-31T19:00:00.000Z',
}));

afterEach(cleanup);

describe('AgentRoster message composer', () => {
  it('keeps a whitespace-only draft disabled without dispatching', () => {
    const message = vi.fn();
    render(<AgentRoster agents={agents} nowMs={nowMs} bulk={{ message }} />);
    fireEvent.click(screen.getByTestId('agent-select-su-selected-a'));
    fireEvent.click(screen.getByTestId('agents-bulk-message'));
    fireEvent.change(screen.getByTestId('agents-bulk-msg'), { target: { value: ' \n  ' } });
    const send = screen.getByTestId('agents-bulk-msg-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(message).not.toHaveBeenCalled();
  });

  it('retains the exact draft and selection after a refused delivery', async () => {
    const text = '  Keep this draft\nwith its formatting  ';
    const message = vi.fn().mockRejectedValue(new Error('HTTP 503'));
    render(<AgentRoster agents={agents} nowMs={nowMs} bulk={{ message }} />);
    fireEvent.click(screen.getByTestId('agent-select-su-selected-a'));
    fireEvent.click(screen.getByTestId('agents-bulk-message'));
    fireEvent.change(screen.getByTestId('agents-bulk-msg'), { target: { value: text } });
    fireEvent.click(screen.getByTestId('agents-bulk-msg-send'));

    await waitFor(() => expect(screen.getByTestId('agents-bulk-note').textContent).toBe('HTTP 503'));
    expect((screen.getByTestId('agents-bulk-msg') as HTMLTextAreaElement).value).toBe(text);
    expect((screen.getByTestId('agent-select-su-selected-a') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('agent-select-su-unselected') as HTMLInputElement).checked).toBe(false);
    expect(message).toHaveBeenCalledExactlyOnceWith(['su-selected-a'], text);
  });

  it('delivers verbatim text to the selected identities and clears only after acknowledgement', async () => {
    const text = '  Selected recipients only\nkeep these spaces  ';
    let acknowledge!: (note: string) => void;
    const message = vi.fn(() => new Promise<string>(resolve => { acknowledge = resolve; }));
    render(<AgentRoster agents={agents} nowMs={nowMs} bulk={{ message }} />);
    for (const owner of ['su-selected-a', 'su-selected-b']) fireEvent.click(screen.getByTestId('agent-select-' + owner));
    fireEvent.click(screen.getByTestId('agents-bulk-message'));
    fireEvent.change(screen.getByTestId('agents-bulk-msg'), { target: { value: text } });
    fireEvent.click(screen.getByTestId('agents-bulk-msg-send'));

    expect((screen.getByTestId('agents-bulk-msg') as HTMLTextAreaElement).value).toBe(text);
    expect((screen.getByTestId('agents-bulk-msg-send') as HTMLButtonElement).disabled).toBe(true);
    acknowledge('Sent to 2 agents');
    await waitFor(() => expect(screen.queryByTestId('agents-bulk-compose')).toBeNull());
    expect(screen.getByTestId('agents-bulk-note').textContent).toBe('Sent to 2 agents');
    expect((screen.getByTestId('agent-select-su-unselected') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByTestId('agents-bulk-message'));
    expect((screen.getByTestId('agents-bulk-msg') as HTMLTextAreaElement).value).toBe('');
    expect(message).toHaveBeenCalledExactlyOnceWith(['su-selected-a', 'su-selected-b'], text);
  });
});
