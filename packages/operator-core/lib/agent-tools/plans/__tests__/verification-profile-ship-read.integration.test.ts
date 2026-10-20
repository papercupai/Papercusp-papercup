/**
 * The R-15 ship check fails closed when it cannot read its inputs
 * (plan-verification-profiles-2026-10-17 P-005, R-15; D-008).
 *
 * At ship, the acceptance gate re-reads every closed work item against the deliverable
 * declarations in force now (readNonCodeDeliverableShipEvidence). If that read throws, the
 * gate must refuse with `non_code_deliverable_check_unavailable` rather than pass the plan as
 * if no code evidence existed, and force must not waive it (a waiver would re-open the escape
 * the check closes). The control runs the same plan with the real reader and shows the code is
 * raised only by the failed read.
 *
 * The reader is replaced through a module mock that keeps every other export real, and the
 * gate runs against a private (isolated) integration PG, as the sibling escape test does.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { dispatchProjectedTool, lookupByMcpName } from '@papercusp/agent-mcp';
import '../new';
import '../add-item';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { evaluatePlanAcceptanceGate } from '../../../plan-acceptance-gate';
import { runWithWorkspace } from '../../../workspace-als';
import { setupPlanPgFixture, cleanupPlans, registerHarnessProject, type PlanPgFixture } from './_pg-tool-fixture';

const shipRead = vi.hoisted(() => ({ fail: false }));

vi.mock('../../../plan-verification-escape', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../plan-verification-escape')>();
  return {
    ...real,
    readNonCodeDeliverableShipEvidence: async (...args: Parameters<typeof real.readNonCodeDeliverableShipEvidence>) => {
      if (shipRead.fail) throw new Error('fixture: ship evidence read failed');
      return real.readNonCodeDeliverableShipEvidence(...args);
    },
  };
});

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-vshipread-${RUN}`;
const WS = DEFAULT_WORKSPACE_ID;
const SLUG = 'zzz-vshipread-r15-2026-10-20';

let fx: PlanPgFixture;
let admin: postgres.Sql;

function ctx(): never {
  return {
    workspaceId: WS,
    harnessSlug: HARNESS,
    runId: 'plans-verification-profile-ship-read',
    role: 'su',
    gateBypass: { role: true, capability: true, quota: true },
    transport: 'mcp',
    requestedFormat: 'json',
    requestedStructured: true,
  } as never;
}

async function call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const projected = lookupByMcpName(tool);
  expect(projected, `${tool} must be registered in the projection registry`).toBeTruthy();
  const d = await dispatchProjectedTool(projected!, tool, { harness: HARNESS, ...args }, ctx(), {});
  const structured = (d.result as { structuredContent?: unknown } | undefined)?.structuredContent;
  if (structured && typeof structured === 'object') return structured as Record<string, unknown>;
  const text = (d.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text;
  if (!text) return { error: d.error ?? null };
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { text };
  }
}

const brief = (x: unknown): string => JSON.stringify(x).slice(0, 900);

async function shipCodes(force?: { reason: string }): Promise<string[]> {
  const verdict = await runWithWorkspace(WS, () =>
    evaluatePlanAcceptanceGate(SLUG, { harnessSlug: HARNESS, collectAllBlockers: true, ...(force ? { force } : {}) }));
  expect(verdict.satisfied, brief(verdict)).toBe(false);
  return (verdict.blockers ?? []).map((b) => b.code);
}

beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  admin = fx.admin;
  await registerHarnessProject(admin, WS, HARNESS);
  const created = await call('plans:new', { slug: SLUG, title: 'Vshipread fixture', verificationProfile: 'general', force: true });
  expect(created?.ok, brief(created)).toBe(true);
  const added = await call('plans:add-item', {
    slug: SLUG,
    phase: 'Phase 1',
    importance: 'normal',
    items: [{ text: 'Write the runbook' }],
  });
  expect(added?.ok, brief(added)).toBe(true);
}, 180_000);

beforeEach(() => {
  shipRead.fail = false;
});

afterAll(async () => {
  if (admin) await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  await fx?.dispose();
});

describe('R-15 at ship: an unreadable non-code evidence check refuses', () => {
  it('control: with a readable check the plan is not refused for the R-15 read', async () => {
    const codes = await shipCodes();
    expect(codes, brief(codes)).not.toContain('non_code_deliverable_check_unavailable');
    expect(codes, brief(codes)).not.toContain('non_code_deliverable_code_evidence');
  });

  it('refuses with non_code_deliverable_check_unavailable when the ship evidence read throws', async () => {
    shipRead.fail = true;
    const codes = await shipCodes();
    expect(codes, brief(codes)).toContain('non_code_deliverable_check_unavailable');
  });

  it('force does not waive non_code_deliverable_check_unavailable', async () => {
    shipRead.fail = true;
    const codes = await shipCodes({ reason: 'fixture: force must not waive the R-15 read' });
    expect(codes, brief(codes)).toContain('non_code_deliverable_check_unavailable');
  });
});
