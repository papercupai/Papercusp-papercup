import { describe, expect, it } from 'vitest';
import { initialChangeScopeProblems } from './initial-change-scope';
import { unknownAnchor, resolvePlanItemAnchors } from '../../plan-items/anchors';

const content = (suffix = '') => ['---', 'title: Initial scope', 'status: draft', '---',
  '# Initial scope', '## Phase 1 — Work', '- **P-001** `todo` Change recovery' + suffix].join('\n');
const change = { action: 'modify' as const, summary: 'Persist recovery state', reason: 'Prevent lost work' };

describe('initial implementation scope', () => {
  it('requires coding targets without imposing them on explicitly non-code items', () => {
    expect(initialChangeScopeProblems({ content: content(), verificationProfile: 'coding', anchors: {} })).toHaveLength(1);
    expect(initialChangeScopeProblems({ content: content(' deliverable: doc'), verificationProfile: 'coding', anchors: {} })).toEqual([]);
    expect(initialChangeScopeProblems({ content: content(), verificationProfile: 'general', anchors: {} })).toEqual([]);
    expect(initialChangeScopeProblems({ content: content(' deliverable: papercusp/code'), verificationProfile: 'general', anchors: {} })).toHaveLength(1);
    expect(initialChangeScopeProblems({ content: content(' deliverable: papercusp/doc'), anchors: {} })).toEqual([]);
    expect(initialChangeScopeProblems({ content: content(), anchors: {} })).toHaveLength(1);
  });
  it('allows honest unknowns and planned code without pretending symbols already exist', async () => {
    const inputs = [{ path: 'recovery.ts', change: { ...change, action: 'create' as const } },
      { symbol: 'recover', path: 'queue.ts', change: { ...change, action: 'investigate' as const } }];
    const anchors = await resolvePlanItemAnchors(inputs, { root: '/unavailable', snapshot: null });
    expect(anchors.map(a => a.unknownReason)).toEqual(['planned', 'investigation']);
    expect(initialChangeScopeProblems({ content: content(), verificationProfile: 'coding', anchors: { 'P-001': anchors } })).toEqual([]);
    const unresolved = unknownAnchor({ symbol: 'recover', change }, 'no-snapshot');
    expect(initialChangeScopeProblems({ content: content(), verificationProfile: 'code', anchors: { 'P-001': [unresolved] } })).toHaveLength(1);
    unresolved.change = { ...change, unknowns: 'Inspect the recovery call sites before modifying this function' };
    expect(initialChangeScopeProblems({ content: content(), verificationProfile: 'code', anchors: { 'P-001': [unresolved] } })).toEqual([]);
  });
});
