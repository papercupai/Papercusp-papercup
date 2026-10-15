/**
 * WI-6554700010010307: a caller projection/view must leave an audit record on
 * the tool context, because the host strips `projection` from the dispatched
 * args and the invocation ledger otherwise cannot tell a projection-promoted
 * full-tier call from an ordinary one.
 */
import { describe, expect, it } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/tooldef';
import { describeSourceMaterialization } from './materialization-audit';
import { nestedProjectionContext } from './nested-dispatch';
import type { ProjectionSpec } from './types';

describe('describeSourceMaterialization', () => {
  it('records a pipe-only projection that promoted its source to full', () => {
    const spec: ProjectionSpec = { pipe: [{ op: 'grep', pattern: 'x' }, { op: 'head', n: 5 }] };
    expect(
      describeSourceMaterialization({ sourceProjection: spec, needsFullSource: true, needsStructuredSource: false }),
    ).toEqual({ trigger: 'projection', pipeOps: ['grep', 'head'], promotedToFull: true, structuredSource: false });
  });

  it('records the pick path count and the structured source for a pick', () => {
    const spec: ProjectionSpec = { pick: ['results[].id', 'results[].state'] };
    expect(
      describeSourceMaterialization({ sourceProjection: spec, needsFullSource: true, needsStructuredSource: true }),
    ).toEqual({ trigger: 'projection', pickPaths: 2, promotedToFull: true, structuredSource: true });
  });

  it('records a non-promoted projection when the caller fixed the payload tier', () => {
    const spec: ProjectionSpec = { pipe: [{ op: 'count' }] };
    expect(
      describeSourceMaterialization({ sourceProjection: spec, needsFullSource: false, needsStructuredSource: false }),
    ).toEqual({ trigger: 'projection', pipeOps: ['count'], promotedToFull: false, structuredSource: false });
  });

  it('attributes a spec-less full-source materialization to a named view', () => {
    expect(
      describeSourceMaterialization({ sourceProjection: null, needsFullSource: true, needsStructuredSource: false }),
    ).toEqual({ trigger: 'view', promotedToFull: true, structuredSource: false });
  });

  it('returns null when nothing was projected or promoted', () => {
    expect(
      describeSourceMaterialization({ sourceProjection: null, needsFullSource: false, needsStructuredSource: false }),
    ).toBeNull();
  });
});

describe('nestedProjectionContext stamps the audit record', () => {
  const base = { requestedFormat: undefined } as UnifiedToolContext;

  it('stamps a promoted pipe projection', () => {
    const out = nestedProjectionContext(base, {}, { pipe: [{ op: 'head', n: 3 }] });
    expect(out.sourceMaterialization).toEqual({
      trigger: 'projection',
      pipeOps: ['head'],
      promotedToFull: true,
      structuredSource: false,
    });
    expect(out.contextTier).toBe('full');
  });

  it('stamps a non-promoted projection without promoting the tier', () => {
    const out = nestedProjectionContext(base, { payloadTier: 'trimmed' }, { pipe: [{ op: 'count' }] });
    expect(out.sourceMaterialization).toMatchObject({ trigger: 'projection', promotedToFull: false });
    expect(out.contextTier).toBeUndefined();
    expect(out.transportCapExempt).toBeUndefined();
  });

  it('leaves a context with no projection untouched', () => {
    expect(nestedProjectionContext(base, {}, null)).toBe(base);
  });
});
