// @vitest-environment jsdom
/**
 * Unit coverage for the P-106 read-mode decoration logic
 * (decoratePlanDom + attachPlanRefClickHandler).
 *
 * These run the three DOM-walking passes against hand-built markup
 * mirroring what Vditor.preview() emits, then assert the data
 * attributes / badge / ref-anchor outcomes. The regex + TreeWalker
 * logic is subtle (status-enum match, P-NNN vs item-header strong,
 * skip-inside-anchor) — exactly what regresses silently without tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decoratePlanDom, attachPlanRefClickHandler } from './plan-renderers';
import type { PlanItem } from './plans-api';

function root(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

function item(partial: Partial<PlanItem> & Pick<PlanItem, 'id'>): PlanItem {
  return {
    storedStatus: 'todo',
    effectiveStatus: 'todo',
    text: '',
    ...partial,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('decoratePlanDom — status tokens', () => {
  it('marks an inline <code> holding an enum value', () => {
    const r = root('<p>status <code>todo</code> here</p>');
    decoratePlanDom(r, undefined);
    const code = r.querySelector('code')!;
    expect(code.dataset.planStatus).toBe('todo');
    expect(code.classList.contains('pc-plan-status')).toBe(true);
    expect(code.classList.contains('pc-plan-status--todo')).toBe(true);
  });

  it('marks every status enum value', () => {
    for (const s of ['todo', 'wip', 'blocked', 'needs-human', 'done', 'dropped']) {
      const r = root(`<p><code>${s}</code></p>`);
      decoratePlanDom(r, undefined);
      expect(r.querySelector('code')!.dataset.planStatus).toBe(s);
    }
  });

  it('leaves a non-enum <code> untouched', () => {
    const r = root('<p><code>HashMap::new()</code></p>');
    decoratePlanDom(r, undefined);
    expect(r.querySelector('code')!.dataset.planStatus).toBeUndefined();
  });

  it('skips <code> inside a <pre> block', () => {
    const r = root('<pre><code>todo</code></pre>');
    decoratePlanDom(r, undefined);
    expect(r.querySelector('code')!.dataset.planStatus).toBeUndefined();
  });
});

describe('decoratePlanDom — list-item ids', () => {
  it('tags an <li> whose leading <strong> is a P-NNN id', () => {
    const r = root('<ul><li><strong>P-001</strong> do the thing</li></ul>');
    decoratePlanDom(r, undefined);
    expect(r.querySelector('li')!.dataset.planItem).toBe('P-001');
  });

  it('tags a D-NNN id too', () => {
    const r = root('<ul><li><strong>D-012</strong> a decision</li></ul>');
    decoratePlanDom(r, undefined);
    expect(r.querySelector('li')!.dataset.planItem).toBe('D-012');
  });

  it('ignores an <li> whose leading <strong> is not an id', () => {
    const r = root('<ul><li><strong>Note:</strong> something</li></ul>');
    decoratePlanDom(r, undefined);
    expect(r.querySelector('li')!.dataset.planItem).toBeUndefined();
  });

  it('requires 3+ digits — P-01 is not an id', () => {
    const r = root('<ul><li><strong>P-01</strong> too short</li></ul>');
    decoratePlanDom(r, undefined);
    expect(r.querySelector('li')!.dataset.planItem).toBeUndefined();
  });
});

describe('decoratePlanDom — effective-status badge', () => {
  it('appends a badge when effectiveStatus differs from storedStatus', () => {
    const r = root('<ul><li><strong>P-001</strong> <code>todo</code> blocked work</li></ul>');
    decoratePlanDom(r, [item({ id: 'P-001', storedStatus: 'todo', effectiveStatus: 'blocked' })]);
    const badge = r.querySelector('.pc-plan-badge');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('blocked');
    expect(badge!.classList.contains('pc-plan-badge--blocked')).toBe(true);
  });

  it('does not append a badge when effective === stored', () => {
    const r = root('<ul><li><strong>P-002</strong> <code>todo</code> ready work</li></ul>');
    decoratePlanDom(r, [item({ id: 'P-002', storedStatus: 'todo', effectiveStatus: 'todo' })]);
    expect(r.querySelector('.pc-plan-badge')).toBeNull();
  });

  it('does not append a badge when no items model is supplied', () => {
    const r = root('<ul><li><strong>P-003</strong> <code>todo</code> work</li></ul>');
    decoratePlanDom(r, undefined);
    expect(r.querySelector('.pc-plan-badge')).toBeNull();
  });
});

describe('decoratePlanDom — P-NNN / D-NNN references', () => {
  it('wraps a bare reference in prose', () => {
    const r = root('<p>see P-002 for the rationale</p>');
    decoratePlanDom(r, undefined);
    const a = r.querySelector('a.pc-plan-ref');
    expect(a).not.toBeNull();
    expect(a!.getAttribute('data-plan-ref')).toBe('P-002');
    expect(a!.textContent).toBe('P-002');
  });

  it('does not wrap the leading <strong> id of a tagged item', () => {
    const r = root('<ul><li><strong>P-001</strong> implements P-002</li></ul>');
    decoratePlanDom(r, undefined);
    const refs = Array.from(r.querySelectorAll('a.pc-plan-ref')).map((a) => a.textContent);
    // P-001 (the item's own id) stays a plain <strong>; P-002 (a real
    // reference in the item text) gets linked.
    expect(refs).toEqual(['P-002']);
    expect(r.querySelector('strong')!.textContent).toBe('P-001');
  });

  it('does not double-wrap a reference already inside an anchor', () => {
    const r = root('<p>see <a href="#x">P-002</a> here</p>');
    decoratePlanDom(r, undefined);
    expect(r.querySelectorAll('a.pc-plan-ref').length).toBe(0);
  });

  it('does not wrap a reference inside <code>', () => {
    const r = root('<p><code>P-002</code></p>');
    decoratePlanDom(r, undefined);
    expect(r.querySelector('a.pc-plan-ref')).toBeNull();
  });

  it('wraps multiple references in one text node', () => {
    const r = root('<p>depends on P-002 and D-004 both</p>');
    decoratePlanDom(r, undefined);
    const refs = Array.from(r.querySelectorAll('a.pc-plan-ref')).map((a) => a.textContent);
    expect(refs).toEqual(['P-002', 'D-004']);
  });
});

describe('attachPlanRefClickHandler', () => {
  it('scrolls the matching item into view and pulses the highlight', () => {
    const scrollSpy = vi.fn();
    // jsdom does not implement scrollIntoView — stub it.
    Element.prototype.scrollIntoView = scrollSpy;
    vi.useFakeTimers();

    const r = root(
      '<ul><li><strong>P-001</strong> target</li></ul><p>see P-001 above</p>',
    );
    decoratePlanDom(r, undefined);
    const detach = attachPlanRefClickHandler(r);

    const ref = r.querySelector('a.pc-plan-ref') as HTMLElement;
    expect(ref).not.toBeNull();
    ref.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const target = r.querySelector('[data-plan-item="P-001"]') as HTMLElement;
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(target.classList.contains('pc-plan-highlight')).toBe(true);

    vi.advanceTimersByTime(1600);
    expect(target.classList.contains('pc-plan-highlight')).toBe(false);

    detach();
    vi.useRealTimers();
  });

  it('detach() removes the listener', () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;

    const r = root(
      '<ul><li><strong>P-001</strong> target</li></ul><p>see P-001 above</p>',
    );
    decoratePlanDom(r, undefined);
    const detach = attachPlanRefClickHandler(r);
    detach();

    (r.querySelector('a.pc-plan-ref') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(scrollSpy).not.toHaveBeenCalled();
  });
});

it('no longer exports the retired VAL test-coverage badge decorator (P-003)', async () => {
  const mod = (await import('./plan-renderers')) as Record<string, unknown>;
  expect(mod).not.toHaveProperty('decoratePlanItemTestBadges');
});
