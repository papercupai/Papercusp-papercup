// @vitest-environment jsdom
import { StrictMode, useEffect, useRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOUD_TUTORIAL_ID, CLOUD_TUTORIAL_STEPS, CLOUD_TUTORIAL_VERSION, type ProductObservation, type SavedTutorialProgress } from '@papercusp/operator-core/lib/onboarding/cloud-tutorial-lesson';
import { hostedBrowserApiMarker } from '../hosted-browser-api';
import { CloudTutorialGuide } from './cloud-tutorial-guide';
import { useCloudTutorialProgress } from './use-cloud-tutorial-progress';

const scope = { tenantId: 'journey-tenant', userId: 'journey-user', workspaceId: 'journey-workspace' };
const connected: ProductObservation = { scope, revision: 1, access: 'allowed', connection: { id: 'gcp', provider: 'gcp', validated: true } };
const configured: ProductObservation = { ...connected, configuration: { connectionId: 'gcp', valid: true, costReviewed: true } };
const healthy: ProductObservation = { ...configured, workspace: { id: scope.workspaceId, connectionId: 'gcp', healthy: true } };
const launched: ProductObservation = { ...healthy, agent: { id: 'session-1', workspaceId: scope.workspaceId, available: true, launchedByUser: true } };
const answered: ProductObservation = { ...launched, task: { id: 'task-1', sessionId: 'session-1', sampleTask: true, submittedByUser: true, status: 'succeeded', resultId: 'answer-1' } };
let saved: SavedTutorialProgress;
let revision: number;
let refusal: number;
const writes: Record<string, unknown>[] = [];

// Only the authenticated persistence and domain-observation boundaries are
// replaced. The reducer, progress hook, Guide, real Button and Joyride run
// together. Actual Cloud actions/connector/session journeys run in Playwright.
function Journey({ observation, targets = true }: { observation?: ProductObservation; targets?: boolean }) {
  const { state, dispatch, notice, retry } = useCloudTutorialProgress('selected-workspace');
  const generation = useRef(0);
  useEffect(() => {
    if (state && observation) dispatch({ type: 'observe', observation: { ...observation, revision: ++generation.current } });
  }, [state?.scope, observation, dispatch]);
  return <>
    <label>Product draft<input aria-label="Product draft" /></label>
    {targets && CLOUD_TUTORIAL_STEPS.map(step => <button key={step.id} data-tutorial-target={`cloud-${step.id}`}>{step.title} product control</button>)}
    {notice && <p role="status">{notice}</p>}
    {!state ? <button onClick={retry}>Check lesson again</button> : <>
      <CloudTutorialGuide state={state} dispatch={dispatch} reducedMotion onCheckAgain={retry} />
      <button disabled={!observation?.task?.resultId} onClick={() => dispatch({ type: 'inspect-result', scope: state.scope,
        sessionId: observation!.task!.sessionId, taskId: observation!.task!.id, resultId: observation!.task!.resultId! })}>Inspect product answer</button>
    </>}
  </>;
}
const mount = (observation?: ProductObservation, targets = true) => render(<StrictMode><Journey observation={observation} targets={targets} /></StrictMode>);
beforeEach(() => {
  saved = { scope, lessonId: CLOUD_TUTORIAL_ID, version: CLOUD_TUTORIAL_VERSION, disposition: 'active' };
  revision = 0; refusal = 0; writes.length = 0;
  window.__PAPERCUSP_HOSTED_BROWSER__ = hostedBrowserApiMarker('control');
  delete window.__PAPERCUSP_HOSTED_BROWSER_API__;
  // This fixture forces the Guide's explicit reducedMotion prop. The actual
  // OS/browser preference is exercised in the Chromium accessibility check.
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 20, y: 20, top: 20, left: 20, width: 200, height: 40, right: 220, bottom: 60, toJSON: () => ({}) });
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get: () => document.body });
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe('/api/hosted/browser/onboarding/tutorial-progress');
    if (refusal) return new Response('{}', { status: refusal });
    if (init?.method === 'POST') {
      const patch = JSON.parse(init.body as string); writes.push(patch);
      expect(patch.expectedScope).toEqual(scope); expect(patch.expectedRevision).toBe(revision);
      revision++; saved = { ...saved, disposition: patch.disposition, inspectedResult: patch.inspectedResult };
    }
    return Response.json({ record: { revision, progress: saved } });
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.__PAPERCUSP_HOSTED_BROWSER__; });

describe('Whole lesson recovery with the real Guide and hosted progress client', () => {
  it('confirms six ordered steps only from current observations and the correlated user inspection', async () => {
    const view = mount({ scope, revision: 1, access: 'allowed' });
    await screen.findByRole('heading', { name: 'Connect Google Cloud' });
    for (const [observation, title, count] of [
      [connected, 'Review configuration and cost', 1], [configured, 'Wait for a healthy workspace', 2],
      [healthy, 'Launch your first agent', 3], [launched, 'Submit a small read-only task', 4], [answered, 'Inspect the result', 5],
    ] as const) {
      view.rerender(<StrictMode><Journey observation={observation} /></StrictMode>);
      await screen.findByRole('heading', { name: title }); expect(screen.getByText(`${count} of 6 steps confirmed`)).toBeTruthy();
    }
    expect(writes).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect product answer' }));
    await screen.findByText('Your first agent lesson is complete.');
    await waitFor(() => expect(saved.inspectedResult).toEqual({ sessionId: 'session-1', taskId: 'task-1', resultId: 'answer-1' }));
    expect(writes.at(-1)).not.toHaveProperty('completedSteps');
    view.rerender(<StrictMode><Journey observation={{ ...answered, task: { ...answered.task!, id: 'unrelated-task' } }} /></StrictMode>);
    await screen.findByRole('heading', { name: 'Inspect the result' });
    expect(screen.getByText('5 of 6 steps confirmed')).toBeTruthy();
  });

  it('reloads saved pause/inspection without trusting saved domain success, then resumes from fresh product state', async () => {
    const view = mount(answered);
    await screen.findByText('5 of 6 steps confirmed');
    fireEvent.click(screen.getByRole('button', { name: 'Inspect product answer' }));
    await waitFor(() => expect(saved.inspectedResult?.taskId).toBe('task-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(saved.disposition).toBe('paused')); view.unmount();
    const reload = mount();
    await screen.findByText('Your lesson is paused.'); expect(screen.getByText('0 of 6 steps confirmed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume guide' }));
    await screen.findByRole('heading', { name: 'Connect Google Cloud' });
    reload.rerender(<StrictMode><Journey observation={answered} /></StrictMode>);
    await screen.findByText('Your first agent lesson is complete.');
    expect(screen.getByText('6 of 6 steps confirmed')).toBeTruthy();
  });

  it('leaves the product draft operable across permission refusal and only restores after an authorized reload', async () => {
    refusal = 403; mount(connected);
    const draft = screen.getByRole('textbox', { name: 'Product draft' });
    fireEvent.change(draft, { target: { value: 'Keep my project draft' } });
    await screen.findByText(/Sign in and select an authorized workspace/);
    expect(screen.queryByRole('region', { name: 'First agent guide' })).toBeNull(); expect(writes).toEqual([]);
    refusal = 0; fireEvent.click(screen.getByRole('button', { name: 'Check lesson again' }));
    await screen.findByRole('heading', { name: 'Review configuration and cost' });
    expect(draft).toHaveProperty('value', 'Keep my project draft');
    refusal = 401; fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await screen.findByText(/Your session or workspace changed/);
    expect(screen.queryByRole('region', { name: 'First agent guide' })).toBeNull();
    expect(document.querySelector('.react-joyride__overlay')).toBeNull(); expect(writes).toEqual([]);
  });

  it('keeps delayed/failed provisioning recoverable and never retries product work through guide controls', async () => {
    const view = mount({ ...configured, attempt: { step: 'workspace', status: 'delayed' } }, false);
    await screen.findByText(/taking longer than expected/);
    expect(screen.getByText('2 of 6 steps confirmed')).toBeTruthy();
    view.rerender(<StrictMode><Journey targets={false} observation={{ ...configured, attempt: { step: 'workspace', status: 'failed' } }} /></StrictMode>);
    await screen.findByText(/This step needs attention/);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await screen.findByRole('heading', { name: 'Wait for a healthy workspace' });
    expect(writes).toEqual([]);
    view.rerender(<StrictMode><Journey observation={healthy} /></StrictMode>);
    await screen.findByRole('heading', { name: 'Launch your first agent' });
    expect(screen.getByText('3 of 6 steps confirmed')).toBeTruthy(); expect(writes).toEqual([]);
  });

  it('recovers missing targets, preserves form input through Help replay, and cleans focus/overlays on exit', async () => {
    const entry = document.createElement('button'); document.body.append(entry); entry.focus();
    const view = mount(connected, false);
    await screen.findByRole('heading', { name: 'Review configuration and cost' });
    const draft = screen.getByRole('textbox', { name: 'Product draft' }); fireEvent.change(draft, { target: { value: 'Preserved input' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show me' })); await screen.findByText(/control is not visible yet/);
    view.rerender(<StrictMode><Journey observation={connected} /></StrictMode>);
    await waitFor(() => expect(document.querySelector('.react-joyride__overlay')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Show me' }));
    expect(document.activeElement).toBe(document.querySelector('[data-tutorial-target="cloud-configuration"]'));
    expect(Element.prototype.scrollIntoView).toHaveBeenLastCalledWith({ behavior: 'instant', block: 'center' });
    fireEvent.click(screen.getByRole('button', { name: 'Skip lesson' })); await waitFor(() => expect(saved.disposition).toBe('skipped'));
    fireEvent.click(screen.getByText('Help')); fireEvent.click(screen.getByRole('button', { name: 'Get your first agent running' }));
    await screen.findByRole('heading', { name: 'Connect Google Cloud' });
    expect(screen.getByText('Already completed in this workspace.')).toBeTruthy(); expect(draft).toHaveProperty('value', 'Preserved input');
    fireEvent.click(screen.getByRole('button', { name: 'Close guide' }));
    expect(screen.queryByRole('region', { name: 'First agent guide' })).toBeNull();
    await waitFor(() => expect(document.querySelector('.react-joyride__overlay')).toBeNull());
    expect(document.activeElement).toBe(entry); await act(async () => view.unmount()); entry.remove();
    expect(document.querySelector('[data-cloud-tutorial-highlight]')).toBeNull();
  });
});
