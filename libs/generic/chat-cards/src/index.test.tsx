/// <reference types="node" />
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { serializeGoalOwnerReportSnapshot } from '@papercusp/chat-protocol';
import { goalOwnerReportFixture } from '../../../../packages/operator-core/test/fixtures/goal-owner-report';
import { CardRenderer, PendingCardsBar, ReportBlockCard, type ResolvedGoalOwnerReport } from './index';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('@papercusp/chat-cards', () => {
  it('submits empty form input and checkbox selections only with schema opt-in', () => {
    const onResponse = vi.fn();
    const textCard = { correlationId: 'empty', prompt: 'Empty form', createdAt: 1,
      presentation: { kind: 'text' as const, allowEmpty: true } };
    const view = render(<CardRenderer card={textCard} onResponse={onResponse} />);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onResponse).toHaveBeenLastCalledWith({ action: 'submit', correlationId: 'empty', value: { value: '' } });
    view.rerender(<CardRenderer card={{ ...textCard, presentation: { kind: 'checkbox', allowEmpty: true,
      options: [{ id: '0', label: 'one' }] } }} onResponse={onResponse} />);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onResponse).toHaveBeenLastCalledWith({ action: 'submit', correlationId: 'empty', value: { picks: [] } });
  });

  it('masks and clears private card input, without rendering it as a saved answer', () => {
    const onResponse = vi.fn();
    render(<CardRenderer card={{ correlationId: 'private', createdAt: 1, prompt: 'Credential',
      presentation: { kind: 'text', sensitive: true, multiline: true } }} onResponse={onResponse} />);
    const input = screen.getByLabelText('response') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    fireEvent.change(input, { target: { value: 'private-for-native' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onResponse).toHaveBeenCalledWith({ action: 'submit', correlationId: 'private', value: { value: 'private-for-native' } });
    expect(input.value).toBe('');
    expect(screen.queryByText('private-for-native')).toBeNull();
  });

  it('renders only a live, exact same-origin card authentication link', () => {
    const card = { correlationId: 'auth', createdAt: 1, prompt: 'Authenticate',
      presentation: { kind: 'radio' as const, options: [{ id: 'continue', label: 'Continue' }], link: '/api/ui/cards/auth/link' } };
    const view = render(<CardRenderer card={card} onResponse={() => {}} />);
    expect(screen.getByRole('link', { name: 'Open secure link' }).getAttribute('href')).toBe('/api/ui/cards/auth/link');
    view.rerender(<CardRenderer card={card} expired onResponse={() => {}} />);
    expect(screen.queryByRole('link')).toBeNull();
    view.rerender(<CardRenderer card={{ ...card, presentation: { ...card.presentation, link: 'https://untrusted.example/' } }} onResponse={() => {}} />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shapes a shared choice card submission as CardResponse', () => {
    const onResponse = vi.fn();
    render(<CardRenderer card={{
      correlationId: 'card-1',
      createdAt: 1,
      prompt: 'Choose',
      presentation: { kind: 'radio', options: [{ id: 'a', label: 'A' }] },
    }} onResponse={onResponse} />);
    fireEvent.click(screen.getByRole('button', { name: 'A' }));
    expect(onResponse).toHaveBeenCalledWith({
      action: 'submit',
      correlationId: 'card-1',
      value: { picks: ['a'] },
    });
  });

  it('renders one current card and states the remaining queue', () => {
    render(<PendingCardsBar cards={[
      { correlationId: 'a', createdAt: 1, prompt: 'First' },
      { correlationId: 'b', createdAt: 2, prompt: 'Second' },
    ]} onResponse={() => {}} />);
    expect(screen.getByText('First')).toBeTruthy();
    expect(screen.queryByText('Second')).toBeNull();
    expect(screen.getByText('1 more card after this')).toBeTruthy();
  });
});

describe('REPORT-PINNED-DETAIL-P003 shared in-card expansion', () => {
  beforeEach(() => vi.stubGlobal('crypto', webcrypto));
  const snapshot = goalOwnerReportFixture('workspace-card');
  const bodyMd = serializeGoalOwnerReportSnapshot(snapshot);
  const bodySha256 = createHash('sha256').update(bodyMd).digest('hex');
  const reference = { schemaVersion: 1 as const, goalId: snapshot.goalId, reportId: 'report-original', bodySha256 };
  const report = { title: 'Goal progress', plans: [], goalReport: reference };
  const resolved: ResolvedGoalOwnerReport = {
    reportId: reference.reportId, workspaceId: snapshot.workspaceId, goalId: snapshot.goalId,
    bodyMd, bodySha256, snapshot,
  };

  it('opens the exact long snapshot in the existing card without fabricated plan rows', async () => {
    const resolveGoalReport = vi.fn().mockResolvedValue(resolved);
    const { container } = render(<ReportBlockCard report={report} resolveGoalReport={resolveGoalReport} />);
    expect(screen.getByRole('group', { name: 'Goal progress' })).toBeTruthy();
    expect(resolveGoalReport).not.toHaveBeenCalled();
    expect(container.querySelector('.report-block-plan')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand full report' }));
    await waitFor(() => expect(container.querySelector('.report-block-goal-body')?.textContent).toBe(bodyMd));
    expect(bodyMd.length).toBeGreaterThan(600);
    expect(resolveGoalReport).toHaveBeenCalledWith(reference);
    expect(screen.getByText(`Historical snapshot · observed at ${snapshot.observedAt}`)).toBeTruthy();
    for (const action of snapshot.ownerWalls) expect(container.textContent).toContain(action.exactAction);
    for (const value of ['receipt:complete-19', 'partial; legacy unpriced', 'Historical disposition:',
      'unchecked=WI-unread', 'not applicable=WI-archived', 'residue=WI-unread',
      'Historical cost coverage is incomplete.', snapshot.cost.readAt, snapshot.cost.measuredAt!]) {
      expect(container.textContent).toContain(value);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Collapse full report' }));
    expect(container.querySelector('.report-block-goal-body')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand full report' }));
    await waitFor(() => expect(container.querySelector('.report-block-goal-body')?.textContent).toBe(bodyMd));
    expect(resolveGoalReport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['latest lineage ID', { reportId: 'report-successor' }],
    ['another goal', { goalId: 'other-goal' }],
    ['another workspace', { workspaceId: 'other-workspace' }],
    ['substituted hash', { bodySha256: 'f'.repeat(64) }],
    ['changed body', { bodyMd: bodyMd + '\nChanged' }],
    ['changed snapshot', { snapshot: { ...snapshot, observedAt: '2026-10-04T10:00:00.000Z' } }],
  ])('refuses %s rather than displaying a substituted snapshot', async (_label, mutation) => {
    const { container } = render(<ReportBlockCard report={report}
      resolveGoalReport={vi.fn().mockResolvedValue({ ...resolved, ...mutation })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand full report' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(container.querySelector('.report-block-goal-body')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry loading report' })).toBeTruthy();
  });

  it('verifies the UTF-8 hash even when the metadata and canonical body agree', async () => {
    const forged = { ...reference, bodySha256: 'f'.repeat(64) };
    render(<ReportBlockCard report={{ ...report, goalReport: forged }}
      resolveGoalReport={vi.fn().mockResolvedValue({ ...resolved, bodySha256: forged.bodySha256 })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand full report' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.queryByText(bodyMd)).toBeNull();
  });

  it('exposes transport failure and retries the same pinned reference', async () => {
    const resolveGoalReport = vi.fn().mockRejectedValueOnce(new Error('not found')).mockResolvedValueOnce(resolved);
    const { container } = render(<ReportBlockCard report={report} resolveGoalReport={resolveGoalReport} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand full report' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading report' }));
    await waitFor(() => expect(container.querySelector('.report-block-goal-body')?.textContent).toBe(bodyMd));
    expect(resolveGoalReport.mock.calls).toEqual([[reference], [reference]]);
  });

  it('ignores a late response after the pinned reference changes', async () => {
    let finishOld!: (value: ResolvedGoalOwnerReport) => void;
    const resolveGoalReport = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce({ ...resolved, reportId: 'report-next' });
    const { container, rerender } = render(<ReportBlockCard report={report} expanded resolveGoalReport={resolveGoalReport} />);
    await waitFor(() => expect(resolveGoalReport).toHaveBeenCalledTimes(1));
    rerender(<ReportBlockCard report={{ ...report, goalReport: { ...reference, reportId: 'report-next' } }}
      expanded resolveGoalReport={resolveGoalReport} />);
    await waitFor(() => expect(container.querySelector('.report-block-goal-body')?.getAttribute('data-report-id')).toBe('report-next'));
    finishOld(resolved);
    await waitFor(() => expect(container.querySelector('.report-block-goal-body')?.getAttribute('data-report-id')).toBe('report-next'));
  });

  it('keeps ordinary inline reports and an unavailable resolver honest', () => {
    const { container, rerender } = render(<ReportBlockCard report={{ plans: [{ title: 'Real plan', items: [{ text: 'Existing inline item' }] }] }} />);
    expect(screen.getByText('Existing inline item')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Expand full report' })).toBeNull();
    rerender(<ReportBlockCard report={report} />);
    expect(screen.getByText('Full snapshot is unavailable in this view.')).toBeTruthy();
    expect(container.querySelector('.report-block-plan')).toBeNull();
  });
});
