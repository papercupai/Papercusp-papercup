// @vitest-environment jsdom
/**
 * PlanEditor.test.tsx — render-tier coverage for the decorated markdown surface.
 * The component's one real branch is readOnly → <PlanDocumentView> (the static
 * decorated preview) vs edit → <MarkdownEditor> (the IR editor). The heavy Vditor
 * children + the DOM-walking renderer helpers are stubbed; the preview/editor
 * stubs surface the props PlanEditor feeds them so we can assert the branch, the
 * value pass-through, the outline prop, and the onChange wiring.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
// Perf-marks: spy the interaction-timing hooks so the "close the plan-popup-open
// timing on body render" wiring (P-001) is asserted, keeping the real registry.
const { endInteractionSpy, phaseSpy } = vi.hoisted(() => ({ endInteractionSpy: vi.fn(), phaseSpy: vi.fn() }));
vi.mock('@/app/_components/perf/perf-marks', () => ({
  endInteraction: endInteractionSpy,
  beginInteraction: vi.fn(),
  markInteractionPhase: phaseSpy,
  PERF_INTERACTIONS: { planPopupOpen: 'plan-popup-open' },
}));
// Vditor-backed; stub both surfaces to plain DOM that echoes the key props.
// PlanDocumentView fires onParsed via a ref callback (mimicking the real "after
// Vditor.preview" call) so handleParsed's decorators + the endInteraction hook run.
vi.mock('@papercusp/ui-primitives', () => ({
  PlanDocumentView: ({ value, outline, onParsed, onRenderPhase }: { value: string; outline: unknown; onParsed?: (root: HTMLElement) => void; onRenderPhase?: (phase: string) => void }) => (
    <div
      data-testid="preview"
      data-outline={String(outline)}
      ref={(node) => { if (node) { onRenderPhase?.('content-ready'); onRenderPhase?.('renderer-ready'); onRenderPhase?.('preview-rendered'); onParsed?.(node); } }}
    >{value}</div>
  ),
}));
vi.mock('@/app/_components/MarkdownEditor', () => ({
  MarkdownEditor: ({
    value,
    onChange,
    readOnly,
  }: {
    value: string;
    onChange?: (next: string) => void;
    readOnly?: boolean;
  }) => (
    <div data-testid="editor" data-readonly={String(readOnly)}>
      <span>{value}</span>
      <button type="button" onClick={() => onChange?.('edited!')}>
        emit-change
      </button>
    </div>
  ),
}));
// The DOM-walking decoration helpers run against jsdom-less Vditor output; stub
// them out (they're exercised by their own renderer tests, not this one).
vi.mock('./plan-renderers', () => ({
  decoratePlanDom: vi.fn(),
  attachPlanRefClickHandler: vi.fn(() => () => {}),
  decoratePromotedBlock: vi.fn(),
  decoratePlanItemBadges: vi.fn(),
  attachFeatureBadgeClickHandler: vi.fn(() => () => {}),
}));
vi.mock('./plan-renderers-ir', () => ({
  attachStatusClickHandler: vi.fn(() => () => {}),
  buildPlanIRRenderers: vi.fn(() => ({})),
  readLuteWalk: vi.fn(() => null),
}));

import PlanEditor from './PlanEditor';

afterEach(() => { cleanup(); endInteractionSpy.mockClear(); phaseSpy.mockClear(); });

describe('PlanEditor (decorated plan markdown surface)', () => {
  it('renders the static preview in read-only mode (default)', () => {
    render(<PlanEditor value="# Hello plan" slug="p" />);
    const preview = screen.getByTestId('preview');
    expect(preview).toBeTruthy();
    expect(preview.textContent).toContain('# Hello plan');
    // The edit surface is NOT mounted.
    expect(screen.queryByTestId('editor')).toBeNull();
  });

  it('passes the outline prop through to the preview', () => {
    render(<PlanEditor value="x" slug="p" outline="right" />);
    expect(screen.getByTestId('preview').getAttribute('data-outline')).toBe('right');
  });

  it('ends the plan-popup-open interaction timing when the plan body renders (P-001 wiring)', () => {
    // handleParsed (fired on each Vditor.preview parse) closes the interaction
    // started by the PlansPane row click. The measure is a no-op unless a matching
    // begin ran, so this call is safe here — we only assert the wiring fires.
    render(<PlanEditor value="# Hello plan" slug="p" />);
    expect(endInteractionSpy).toHaveBeenCalledWith('plan-popup-open');
    expect(phaseSpy.mock.calls).toEqual([
      ['plan-popup-open', 'content-ready'],
      ['plan-popup-open', 'renderer-ready'],
      ['plan-popup-open', 'preview-rendered'],
    ]);
  });

  it('renders the editor surface when readOnly is false', () => {
    render(<PlanEditor value="draft body" slug="p" readOnly={false} onChange={() => {}} />);
    const editor = screen.getByTestId('editor');
    expect(editor).toBeTruthy();
    expect(editor.textContent).toContain('draft body');
    expect(editor.getAttribute('data-readonly')).toBe('false');
    // The read-mode preview is NOT mounted.
    expect(screen.queryByTestId('preview')).toBeNull();
  });

  it('wires onChange through the editor in edit mode', () => {
    const onChange = vi.fn();
    render(<PlanEditor value="draft" slug="p" readOnly={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'emit-change' }));
    expect(onChange).toHaveBeenCalledWith('edited!');
  });
});
