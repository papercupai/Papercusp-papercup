// @vitest-environment jsdom
//
// SchemaForm — JSON-Schema → form renderer. The genuine logic is the per-field
// type router (renderField) + the object/non-object top-level split, both of
// which decide which control renders and how its onChange marshals back into
// the value object. There's no clean pure fn to extract (the routing is the
// render), so this is a render-smoke driving each branch: enum→select,
// boolean→checkbox, number→number input, array/long-string→textarea,
// short-string→text input, and the non-object JSON escape hatch. Checkbox +
// Select are mocked to native controls so onChange marshalling is observable.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/app/harness/Checkbox', () => ({
  Checkbox: ({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) => (
    <input type="checkbox" aria-label="bool" checked={checked} onChange={(e) => onChange(e.target.checked)} />
  ),
}));
vi.mock('@/app/harness/Select', () => ({
  Select: ({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label: React.ReactNode }> }) => (
    <select aria-label="enum" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{String(o.label)}</option>)}
    </select>
  ),
}));

import SchemaForm from './SchemaForm';

afterEach(cleanup);

function renderForm(schema: Record<string, unknown>, value: Record<string, unknown> = {}) {
  const onChange = vi.fn();
  render(<SchemaForm schema={schema} value={value} onChange={onChange} />);
  return onChange;
}

describe('<SchemaForm /> top-level split', () => {
  it('falls through to a JSON textarea for a non-object schema', () => {
    const onChange = renderForm({ type: 'string' }, { a: 1 });
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(ta.value).toContain('"a": 1');
    fireEvent.change(ta, { target: { value: '{"b":2}' } });
    expect(onChange).toHaveBeenCalledWith({ b: 2 });
  });

  it('renders one labeled row per property with a required marker', () => {
    renderForm({ type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] });
    expect(screen.getByText('slug')).toBeTruthy();
    expect(screen.getByText('*')).toBeTruthy();
  });
});

describe('<SchemaForm /> field routing', () => {
  it('renders an enum as a Select and emits the chosen value', () => {
    const onChange = renderForm({ type: 'object', properties: { mode: { enum: ['a', 'b'] } } }, {});
    fireEvent.change(screen.getByLabelText('enum'), { target: { value: 'a' } });
    expect(onChange).toHaveBeenCalledWith({ mode: 'a' });
  });

  it('maps the (none) enum sentinel back to an empty string', () => {
    const onChange = renderForm({ type: 'object', properties: { mode: { enum: ['a', 'b'] } } }, { mode: 'a' });
    fireEvent.change(screen.getByLabelText('enum'), { target: { value: '_none' } });
    expect(onChange).toHaveBeenCalledWith({ mode: '' });
  });

  it('renders a boolean as a checkbox and marshals the checked state', () => {
    const onChange = renderForm({ type: 'object', properties: { flag: { type: 'boolean' } } }, {});
    fireEvent.click(screen.getByLabelText('bool'));
    expect(onChange).toHaveBeenCalledWith({ flag: true });
  });

  it('renders a number field that coerces typed text to Number', () => {
    const onChange = renderForm({ type: 'object', properties: { n: { type: 'integer' } } }, {});
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '5' } });
    expect(onChange).toHaveBeenCalledWith({ n: 5 });
  });

  it('marshals a cleared number field back to undefined', () => {
    const onChange = renderForm({ type: 'object', properties: { n: { type: 'integer' } } }, { n: 5 });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({ n: undefined });
  });

  it('renders an array field as a JSON textarea that parses on input', () => {
    const onChange = renderForm({ type: 'object', properties: { tags: { type: 'array' } } }, {});
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '["x","y"]' } });
    expect(onChange).toHaveBeenCalledWith({ tags: ['x', 'y'] });
  });

  it.each([false, true])('preserves arrays and null for nullable activity workspaceIds (null first: %s)', nullFirst => {
    const array = { type: 'array', items: { type: 'string' } };
    const nil = { type: 'null' };
    const onChange = vi.fn();
    const schema = { type: 'object', properties: { workspaceIds: { anyOf: nullFirst ? [nil, array] : [array, nil] } } };
    const view = render(<SchemaForm schema={schema} value={{ workspaceIds: ['selected'] }} onChange={onChange} />);
    const control = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(control.tagName).toBe('TEXTAREA');
    expect(control.value).toBe('["selected"]');
    fireEvent.change(control, { target: { value: '["neighbor"]' } });
    expect(onChange).toHaveBeenLastCalledWith({ workspaceIds: ['neighbor'] });
    fireEvent.change(control, { target: { value: 'null' } });
    expect(onChange).toHaveBeenLastCalledWith({ workspaceIds: null });
    view.rerender(<SchemaForm schema={schema} value={{ workspaceIds: null }} onChange={onChange} />);
    expect(control.value).toBe('null');
    fireEvent.change(control, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ workspaceIds: undefined });
  });

  it('uses typed JSON for a heterogeneous union rather than converting values to strings', () => {
    const onChange = renderForm({ type: 'object', properties: { choice: { anyOf: [{ type: 'string' }, { type: 'number' }] } } });
    const control = screen.getByRole('textbox');
    expect(control.tagName).toBe('TEXTAREA');
    fireEvent.change(control, { target: { value: '7' } });
    expect(onChange).toHaveBeenLastCalledWith({ choice: 7 });
  });

  it('renders a multi-line textarea for long-ish string keys (description)', () => {
    const onChange = renderForm({ type: 'object', properties: { description: { type: 'string' } } }, {});
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(ta.tagName).toBe('TEXTAREA');
    fireEvent.change(ta, { target: { value: 'hello' } });
    expect(onChange).toHaveBeenCalledWith({ description: 'hello' });
  });

  it('renders a plain text input for short string keys and emits undefined when cleared', () => {
    const onChange = renderForm({ type: 'object', properties: { slug: { type: 'string' } } }, { slug: 'x' });
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({ slug: undefined });
  });
});
