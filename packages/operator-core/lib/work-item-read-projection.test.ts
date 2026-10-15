import { describe, expect, it } from 'vitest';
import { FLEET_METRIC_ARCHIVE_KEYS, projectWorkItemColumns } from './work-item-read-projection';

describe('work-item source read projection', () => {
  const columns = 'id, body, payload, state';

  it('keeps the canonical columns untouched for full reads', () => {
    expect(projectWorkItemColumns(columns)).toBe(columns);
  });

  it('projects a typed NULL payload without changing row arity', () => {
    const projected = projectWorkItemColumns(columns, 'none');
    expect(projected).toBe('id, body, NULL::jsonb AS payload, state');
  });

  it('keeps only completion evidence under the original payload key', () => {
    const projected = projectWorkItemColumns(columns, 'completionEvidence');
    expect(projected).toContain(
      "jsonb_build_object('_completionEvidence', payload -> '_completionEvidence') AS payload",
    );
    expect(projected).toBe(
      "id, body, jsonb_build_object('_completionEvidence', payload -> '_completionEvidence') AS payload, state",
    );
  });

  it('does not silently no-op when payload formatting changes', () => {
    expect(projectWorkItemColumns('id,payload,state', 'none')).toContain('NULL::jsonb AS payload');
  });

  it('keeps fleet controls by subtracting only archival keys, preserving malformed shapes', () => {
    const projected = projectWorkItemColumns(columns, 'fleetMetrics');
    expect(projected).toContain("CASE WHEN jsonb_typeof(payload) = 'object'");
    expect(projected).toContain('ELSE payload END) AS payload');
    for (const key of FLEET_METRIC_ARCHIVE_KEYS) expect(projected).toContain(`'${key}'`);
    for (const key of ['agentReview', 'admissionReview', 'implementationReadiness', '_claimHold', 'externalBlockers',
      'claim_hold_release', 'plan_item', 'ideaLifecycle', 'paths', 'tags']) {
      expect(FLEET_METRIC_ARCHIVE_KEYS as readonly string[]).not.toContain(key);
    }
  });

  it('avoids unmapped issue metadata while keeping matcher and lifecycle columns', () => {
    const issueColumns = 'id, source, signal_origin, found_during, linked_feature_id, severity, created_by, body, payload, state';
    expect(projectWorkItemColumns(issueColumns)).toBe(issueColumns);
    const projected = projectWorkItemColumns(issueColumns, 'fleetMetrics');
    for (const key of ['source', 'signal_origin', 'found_during', 'linked_feature_id']) {
      expect(projected).toContain(`NULL::text AS ${key}`);
    }
    expect(projected).toContain('severity, created_by, body,');
    expect(projected).toContain(' AS payload, state');
  });

  it('keeps non-terminal controls and selects the physical family state for a metric census', () => {
    const issue = projectWorkItemColumns(columns, 'fleetMetricsCensus', 'state');
    const feature = projectWorkItemColumns('id, summary, payload, status', 'fleetMetricsCensus');
    expect(issue).toContain('CASE WHEN state = ANY(');
    expect(feature).toContain('CASE WHEN status = ANY(');
    expect(issue).toContain('ELSE payload - ARRAY[');
    expect(issue).toContain('ELSE payload END) AS payload');
    expect(issue).toContain('jsonb_object_agg(key, value)');
    expect(issue).toContain('body,');
  });
});
