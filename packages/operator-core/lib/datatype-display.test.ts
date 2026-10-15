import { describe, expect, it } from 'vitest';
import {
  BUILTIN_DATATYPE_SPECS,
  DATATYPE_DISPLAY_WIDGETS,
  DATATYPE_REF_PICKER_REGISTRY,
  parseDatatypeDisplay,
  renderDatatypeSummary,
  serializeDatatypeReference,
} from './datatype-display';

describe('datatype display contract', () => {
  it('pins the complete fixed widget vocabulary', () => {
    expect(DATATYPE_DISPLAY_WIDGETS).toEqual([
      'text', 'textarea', 'markdown', 'number', 'toggle', 'select', 'tags', 'date', 'list', 'record', 'ref-picker',
    ]);
  });

  it('accepts compositional list/record specs and rejects code or unknown widgets', () => {
    expect(parseDatatypeDisplay({ widget: 'list', params: { itemDatatype: 'string', maxItems: 5 }, summary: '{{length}} items' }).ok).toBe(true);
    expect(parseDatatypeDisplay({
      widget: 'record',
      params: { fields: [{ name: 'owner', datatype: 'string', required: true }, { name: 'plan', datatype: 'plan-ref' }] },
      summary: '{{owner}} · {{plan}}',
    }).ok).toBe(true);
    expect(parseDatatypeDisplay({ widget: 'component', summary: '{{value}}' }).ok).toBe(false);
    expect(parseDatatypeDisplay({ widget: 'text', params: { renderer: 'eval(source)' }, summary: '{{value}}' }).ok).toBe(false);
  });

  it('requires safe summary placeholders', () => {
    expect(parseDatatypeDisplay({ widget: 'text', summary: '{{owner.name}}' }).ok).toBe(true);
    expect(parseDatatypeDisplay({ widget: 'text', summary: '{{ owner[' }).ok).toBe(false);
  });

  it('extends the existing list editor with opt-in ordering and selection metadata', () => {
    expect(parseDatatypeDisplay({ widget: 'list', params: {
      itemDatatype: 'plan-ref', order: 'priority', selectable: true, defaultSelected: true,
    }, summary: '{{length}} plans' }).ok).toBe(true);
    expect(parseDatatypeDisplay({ widget: 'list', params: {
      itemDatatype: 'string', order: 'display', selectable: true, defaultSelected: false,
    }, summary: '{{length}} choices' }).ok).toBe(true);
    for (const params of [{ order: 'random' }, { selectable: 'yes' }, { defaultSelected: 1 }, { execute: 'code' }]) {
      expect(parseDatatypeDisplay({ widget: 'list', params, summary: '{{length}}' }).ok).toBe(false);
    }
  });

  it('has one ref-kind registry and serializes plan refs in D-004 qualified form', () => {
    expect(DATATYPE_REF_PICKER_REGISTRY.plan.searchTool).toBe('plans:list');
    expect(DATATYPE_REF_PICKER_REGISTRY.goal.searchTool).toBe('goals:list');
    expect(DATATYPE_REF_PICKER_REGISTRY['work-item'].searchTool).toBe('work_items:list');
    expect(serializeDatatypeReference('plan', { harnessSlug: 'engineering', slug: 'ship-it' })).toBe('plan:engineering/ship-it');
    expect(serializeDatatypeReference('plan', { slug: 'ambiguous' })).toBeNull();
    expect(serializeDatatypeReference('goal', { id: 'goal-ab12cd' })).toBe('goal-ab12cd');
  });

  it('renders the same summary template for object, scalar, and list values', () => {
    expect(renderDatatypeSummary({ summary: '{{owner.name}} — {{status}}' }, { owner: { name: 'Avi' }, status: 'active' })).toBe('Avi — active');
    expect(renderDatatypeSummary({ summary: '{{value}}' }, 42)).toBe('42');
    expect(renderDatatypeSummary({ summary: '{{length}} items' }, ['a', 'b'])).toBe('2 items');
  });

  it('ships the primitive datatype vocabulary as valid display specs', () => {
    expect(BUILTIN_DATATYPE_SPECS.map((datatype) => datatype.id)).toEqual(['string', 'number', 'boolean', 'list', 'record']);
    for (const datatype of BUILTIN_DATATYPE_SPECS) expect(parseDatatypeDisplay(datatype.display).ok).toBe(true);
  });
});
