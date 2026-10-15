/**
 * verification-system-improvements-2026-10-10#D-030: the contract-triage scope probe moves a plan
 * out of the triage gaps ONLY on a confirmed "no Hive plan scope" error from resolvePlanScope.
 * Anything else — a registry fault above all — must propagate, so the measurement fails
 * (D-019) instead of hiding plans as unreachable. Uses the real classifier, no DB.
 */
import { describe, expect, it } from 'vitest';
import { planScopeProbeFrom } from '../contract-triage';
import { isUnknownPlanScopeError } from '../source';

const notHiveHome = (slug: string) =>
  new Error(
    `resolvePlanScope: plans are Hive-scoped, but '${slug}' is not a Hive home and does not ` +
      `belong to one in workspace 'ws-1'. Add it to a Hive or pass the Hive home slug explicitly; ` +
      `refusing to create/read a non-Hive-scoped plan.`,
  );
const notRegistered = (slug: string) =>
  new Error(
    `resolvePlanScope: harness '${slug}' is not registered in the harness registry ` +
      `(harness_shared.harness_registry) or harness_shared.projects in any workspace, so its plan ` +
      `workspace cannot be resolved.`,
  );

describe('D-030 planScopeProbeFrom', () => {
  it('calls the resolver as the plans:* verbs do — harness only, no workspace (D-031)', async () => {
    const seen: unknown[] = [];
    const probe = planScopeProbeFrom(async (opts) => {
      seen.push(opts);
      return { workspaceId: 'ws-1', harnessSlug: opts.harnessSlug };
    }, isUnknownPlanScopeError);
    await expect(probe('ws-1', 'papercusp')).resolves.toBe('reachable');
    // An explicit workspace skips the registry lookup the verbs depend on, so a harness absent
    // from the registry would read reachable while every verb refuses it.
    expect(seen).toEqual([{ harnessSlug: 'papercusp' }]);
  });

  it('control: the pre-D-031 probe shape (explicit workspace) is caught by the call-shape check', async () => {
    // Deliberately-wrong implementation kept as a permanent falsifiability control: it is the
    // D-030 shape that read desktop-notes-demo as reachable while plans:get refused it.
    const preD031 =
      (resolve: (opts: { workspaceId?: string; harnessSlug: string }) => Promise<unknown>) =>
      async (workspaceId: string, harnessSlug: string) => {
        await resolve({ workspaceId, harnessSlug });
        return 'reachable' as const;
      };
    const callShape = async (
      build: (resolve: (opts: { workspaceId?: string; harnessSlug: string }) => Promise<{ workspaceId: string }>) =>
        (ws: string, h: string) => Promise<unknown>,
    ) => {
      const seen: unknown[] = [];
      await build(async (opts) => {
        seen.push(opts);
        return { workspaceId: 'ws-1' };
      })('ws-1', 'papercusp');
      return seen;
    };
    expect(await callShape((r) => planScopeProbeFrom(r, isUnknownPlanScopeError))).toEqual([
      { harnessSlug: 'papercusp' },
    ]);
    expect(await callShape(preD031)).not.toEqual([{ harnessSlug: 'papercusp' }]);
  });

  it('reads a harness the verbs resolve to a different workspace as no-plan-scope (D-031)', async () => {
    const probe = planScopeProbeFrom(
      async (opts) => ({ workspaceId: 'ws-other', harnessSlug: opts.harnessSlug }),
      isUnknownPlanScopeError,
    );
    await expect(probe('ws-1', 'shared-name')).resolves.toBe('no-plan-scope');
  });

  it('reads both resolvePlanScope absence errors as no-plan-scope', async () => {
    for (const err of [notHiveHome('desktop-notes-demo'), notRegistered('gone-harness')]) {
      const probe = planScopeProbeFrom(async () => {
        throw err;
      }, isUnknownPlanScopeError);
      await expect(probe('ws-1', 'x')).resolves.toBe('no-plan-scope');
    }
  });

  it('rethrows any other error instead of reporting the harness unreachable', async () => {
    const fault = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    const probe = planScopeProbeFrom(async () => {
      throw fault;
    }, isUnknownPlanScopeError);
    await expect(probe('ws-1', 'papercusp')).rejects.toBe(fault);
  });
});
