/**
 * WI-10006722: when an app's blueprint edit fails validation, the last valid
 * specification stays in effect and the new operation is absent from it. The submit
 * path must say WHY (the loader's error) instead of a bare composition
 * `operation-not-found`, and must not change behaviour when no edit failed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const attempt = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));

vi.mock('./project-to-pg', async () => {
  const actual = await vi.importActual<typeof import('./project-to-pg')>('./project-to-pg');
  return { ...actual, readBlueprintReprojectionAttempt: () => attempt.value };
});

import { operationFromCurrentSpecification } from './operation-service';
import { isBlueprintOperationRefusal } from './operation-refusal';

const specification = {
  specificationRevision: 'r'.repeat(64),
  configuration: { operations: [{ id: 'summarize', target: { kind: 'work-item' } }] },
} as never;
const input = { workspaceId: 'ws', harnessSlug: 'crm', operationId: 'escalate-to-owner' };

describe('operationFromCurrentSpecification', () => {
  beforeEach(() => { attempt.value = null; });

  it('returns a declared operation regardless of any re-projection attempt', () => {
    attempt.value = { ok: false, path: '/x/blueprint.yaml', error: 'boom', mtimeMs: 1, size: 1, at: 'now' };
    expect(operationFromCurrentSpecification(specification, { ...input, operationId: 'summarize' }).operation.id)
      .toBe('summarize');
  });

  it('keeps the composition error when no edit failed to load', () => {
    expect(() => operationFromCurrentSpecification(specification, input)).toThrow(/operation-not-found|absent from the compiled blueprint/);
    attempt.value = { ok: true, path: '/x/blueprint.yaml', error: null, mtimeMs: 1, size: 1, at: 'now' };
    let caught: unknown;
    try { operationFromCurrentSpecification(specification, input); } catch (error) { caught = error; }
    expect(isBlueprintOperationRefusal(caught)).toBe(false);
  });

  it('refuses as undeclared with the loader error when the edited blueprint failed to load', () => {
    attempt.value = {
      ok: false, path: '/apps/crm/.papercusp/blueprint.yaml', error: 'workItem: expected object',
      mtimeMs: 1, size: 1, at: 'now',
    };
    let caught: unknown;
    try { operationFromCurrentSpecification(specification, input); } catch (error) { caught = error; }
    expect(isBlueprintOperationRefusal(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('undeclared');
    expect((caught as Error).message).toContain('/apps/crm/.papercusp/blueprint.yaml');
    expect((caught as Error).message).toContain('workItem: expected object');
  });
});
