import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const M = vi.hoisted(() => ({
  activeWorkspaceId: vi.fn(() => "ambient-workspace"),
  sql: vi.fn(),
}));

vi.mock("@papercusp/db-org", async (orig) => ({
  ...(await orig<typeof import("@papercusp/db-org")>()),
  getOrgPg: () => ({ sql: M.sql }),
}));

vi.mock("./workspace-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workspace-registry")>()),
  activeWorkspaceId: M.activeWorkspaceId,
}));

import {
  getLatestActivationAudit,
  getLatestPlanAudit,
  getPlanItemStatuses,
  resolvePlanItemHomeHarness,
  repoCitationDeps,
} from "./plan-audits";

async function nativeRoots(check: (root: string, workspace: string) => void | Promise<void>) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'native-citation-'));
  try {
    const root = path.join(workspace, 'parent');
    await mkdir(path.join(root, '.git'), { recursive: true });
    await mkdir(path.join(workspace, 'mobile', '.git'), { recursive: true });
    await writeFile(path.join(workspace, 'mobile', 'app.rs'), 'fn native() {}');
    await check(root, workspace);
  } finally { await rm(workspace, { recursive: true, force: true }); }
}

describe('R-1 native citation context', () => {
  it('preserves parent precedence', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'native-precedence-'));
    try {
      const root = path.join(workspace, 'parent');
      await mkdir(path.join(root, 'mobile'), { recursive: true });
      await mkdir(path.join(workspace, 'mobile', '.git'), { recursive: true });
      await writeFile(path.join(root, 'mobile', 'app.rs'), 'parent');
      await writeFile(path.join(workspace, 'mobile', 'app.rs'), 'sibling');
      const deps = repoCitationDeps(root);
      expect(deps.readFile('mobile/app.rs')).toBe('parent');
      expect(deps.locateRepository!('mobile/app.rs')).toEqual({ repoRoot: root, absolutePath: path.join(root, 'mobile', 'app.rs') });
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });
});

describe('R-3 native citation context', () => {
  it('refuses unadmitted roots and shadowing', async () => {
    await nativeRoots(async (root, workspace) => {
      await mkdir(path.join(workspace, 'unadmitted'), { recursive: true });
      await writeFile(path.join(workspace, 'unadmitted', '.git'), 'gitdir: elsewhere');
      await writeFile(path.join(workspace, 'unadmitted', 'app.rs'), 'fn unadmitted() {}');
      const deps = repoCitationDeps(root);
      expect(deps.locateRepository!('mobile/app.rs')).toEqual({ repoRoot: path.join(workspace, 'mobile'), absolutePath: path.join(workspace, 'mobile', 'app.rs') });
      expect(deps.locateRepository!('../mobile/app.rs')).toBeNull();
      expect(deps.locateRepository!(path.join(workspace, 'mobile', 'app.rs'))).toBeNull();
      expect(deps.statFile('unadmitted/app.rs')).toBeNull();
    });
  });
});

const row = {
  plan_slug: "scoped-plan",
  harness_slug: "papercusp",
  audit_seq: 1,
  created_by: "su-auditor",
  created_at: "2026-08-21T01:01:02.607Z",
  audited_sha: "2cda0139fa8864763823af5ed7f38d413dd4b950",
  items: [],
  findings: [],
  summary: "verified",
};

describe("getLatestPlanAudit workspace scope", () => {
  beforeEach(() => {
    M.sql.mockReset();
    M.activeWorkspaceId.mockClear();
  });

  it("uses the explicit plan workspace and harness instead of ambient workspace", async () => {
    M.sql.mockResolvedValue([row]);

    const result = await getLatestPlanAudit("scoped-plan", {
      workspaceId: "papercusp-workspace",
      harnessSlug: "papercusp",
    });

    expect(result).toMatchObject({
      planSlug: "scoped-plan",
      harnessSlug: "papercusp",
      auditSeq: 1,
    });
    expect(M.activeWorkspaceId).not.toHaveBeenCalled();
    expect(M.sql).toHaveBeenCalledTimes(1);
    expect(M.sql.mock.calls[0]?.[1]).toEqual("papercusp-workspace");
    expect(M.sql.mock.calls[0]?.[2]).toEqual("scoped-plan");
    expect(M.sql.mock.calls[0]?.[3]).toEqual("papercusp");
    expect(M.sql.mock.calls[0]?.[4]).toEqual("papercusp");
  });

  it("retains the ambient fallback for acceptance-gate callers", async () => {
    M.sql.mockResolvedValue([row]);

    await getLatestPlanAudit("scoped-plan");

    expect(M.activeWorkspaceId).toHaveBeenCalledTimes(1);
    expect(M.sql.mock.calls[0]?.[1]).toEqual("ambient-workspace");
    expect(M.sql.mock.calls[0]?.[3]).toBeNull();
    expect(M.sql.mock.calls[0]?.[4]).toBeNull();
  });

  it("reads activation audits independently from completion audits", async () => {
    M.sql.mockResolvedValue([{
      ...row,
      audit_kind: "activation",
      activation: { sourceRanges: [], mappings: [], repairedOmissions: [], rejectedOrSuperseded: [], unresolvedBlockers: [] },
      audited_plan_revision_id: 17,
      audited_plan_revision_seq: 4,
      audited_plan_content_hash: "a".repeat(64),
    }]);

    const result = await getLatestActivationAudit("scoped-plan", { workspaceId: "papercusp-workspace" });

    expect(result).toMatchObject({
      auditKind: "activation",
      auditedPlanRevision: { id: 17, seq: 4, contentHash: "a".repeat(64) },
    });
    expect(M.sql.mock.calls[0]?.[0]?.join(" ")).toContain("audit_kind = 'activation'");
  });

  // EI-21124863090048444: plans:get omitted latestAudit for a "SideStage"-shaped plan
  // (a Hive with member/sub-harnesses) even though the canonical plan_audits row
  // existed. Root cause: plans:audit stores harness_slug as the CITATION-CONTEXT
  // harness it ran from (e.g. a member/sub-harness like "sidestage-mobile" or
  // "papercusp/libs/generic/rrf"), while plans:get was passing the plan's Hive-HOME
  // slug (e.g. "sidestage" / "papercusp") as a strict-equality filter — a value that
  // routinely disagrees with what was written, so the real row matched nothing.
  it("finds a canonical audit row even when its stored harness_slug is a member/sub-harness, not the plan's Hive home", async () => {
    const sideStageAudit = {
      ...row,
      plan_slug: "sidestage-plan",
      // The audit was recorded from a MEMBER harness of the "sidestage" Hive —
      // not from the Hive home itself.
      harness_slug: "sidestage-mobile",
    };
    M.sql.mockResolvedValue([sideStageAudit]);

    // The fixed call shape (plans/get.ts): workspaceId only, matching how
    // recordPlanAudit's own audit_seq computation and getEffectiveItemAudits both
    // already scope the audit ledger purely by (workspaceId, planSlug).
    const result = await getLatestPlanAudit("sidestage-plan", {
      workspaceId: "papercusp-workspace",
    });

    expect(result).toMatchObject({ planSlug: "sidestage-plan", harnessSlug: "sidestage-mobile" });

    // Pins the FIXED contract: the harness_slug predicate is passed NULL (the
    // real WHERE clause is `harness_slug = ${harnessSlug}::text IS NULL OR ...`,
    // so NULL means unfiltered). Before the fix, plans:get threaded the plan's
    // Hive-home slug ("sidestage") through here — a value that never equals the
    // stored citation-context slug ("sidestage-mobile") for a Hive with
    // member/sub-harnesses, so that predicate would have matched zero rows
    // against a real database even though this row is the canonical audit.
    expect(M.sql.mock.calls[0]?.[3]).toBeNull();
    expect(M.sql.mock.calls[0]?.[4]).toBeNull();
  });
});

// WI-10005167: plan_items IS keyed by the plan's own harness, unlike plan_audits.
describe("getPlanItemStatuses harness scope", () => {
  beforeEach(() => {
    M.sql.mockReset();
    M.activeWorkspaceId.mockClear();
  });

  // Applies the real WHERE predicate shape to fixture rows, so a dropped or
  // inverted filter changes the RESULT, not just the bound values.
  const twoHarnessItems = [
    { harness_slug: "email", plan_slug: "shared-slug", item_id: "P-001", status: "done", item_text: "email item" },
    { harness_slug: "papercusp", plan_slug: "shared-slug", item_id: "P-001", status: "todo", item_text: "papercusp item" },
  ];
  const applyPredicate = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    const harness = values[2] as string | null;
    const filtered = text.includes("harness_slug =")
      ? twoHarnessItems.filter((r) => harness === null || r.harness_slug === harness)
      : twoHarnessItems;
    return Promise.resolve(filtered.filter((r) => r.plan_slug === values[1]));
  };

  it("returns only the named harness's items for a slug two harnesses share", async () => {
    M.sql.mockImplementation(applyPredicate);

    const items = await getPlanItemStatuses("shared-slug", { harnessSlug: "email" });

    expect(items).toEqual([{ itemId: "P-001", status: "done", itemText: "email item", deliverable: null }]);
    expect(M.sql.mock.calls[0]?.[3]).toEqual("email");
  });

  it("keeps the unscoped (workspace, slug) read when no harness is supplied", async () => {
    M.sql.mockImplementation(applyPredicate);

    const items = await getPlanItemStatuses("shared-slug", { harnessSlug: null });

    expect(items).toHaveLength(2);
    expect(M.sql.mock.calls[0]?.[1]).toEqual("ambient-workspace");
    expect(M.sql.mock.calls[0]?.[3]).toBeNull();
  });
});

// WI-10005174: callers that hold only a CANDIDATE harness (an explicit arg, a
// slug-recovered or ambient ctx harness) resolve the plan's home from harness_plans
// before scoping the item read. A wrong candidate must never become the scope.
describe("resolvePlanItemHomeHarness", () => {
  beforeEach(() => {
    M.sql.mockReset();
    M.activeWorkspaceId.mockClear();
  });

  const plans = [
    { workspace_id: "ambient-workspace", plan_slug: "shared-slug", harness_slug: "email" },
    { workspace_id: "ambient-workspace", plan_slug: "shared-slug", harness_slug: "papercusp" },
    { workspace_id: "ambient-workspace", plan_slug: "solo-slug", harness_slug: "papercusp" },
    { workspace_id: "other-workspace", plan_slug: "solo-slug", harness_slug: "email" },
  ];
  // Applies the real (workspace, slug) predicate to the fixture, so a dropped
  // workspace or slug filter changes the answer, not just the bound values.
  const applyPredicate = (_strings: TemplateStringsArray, ...values: unknown[]) =>
    Promise.resolve(plans.filter((r) => r.workspace_id === values[0] && r.plan_slug === values[1]));

  it("returns the candidate when the candidate owns the slug", async () => {
    M.sql.mockImplementation(applyPredicate);
    await expect(resolvePlanItemHomeHarness("shared-slug", "email")).resolves.toBe("email");
    await expect(resolvePlanItemHomeHarness("shared-slug", " papercusp ")).resolves.toBe("papercusp");
  });

  it("returns the unique owner when the candidate does not own the slug", async () => {
    M.sql.mockImplementation(applyPredicate);
    // other-workspace's email row is out of scope, so papercusp is the only owner.
    await expect(resolvePlanItemHomeHarness("solo-slug", "email")).resolves.toBe("papercusp");
    await expect(resolvePlanItemHomeHarness("solo-slug", null)).resolves.toBe("papercusp");
    await expect(resolvePlanItemHomeHarness("solo-slug")).resolves.toBe("papercusp");
  });

  it("returns null (unscoped) when two harnesses own the slug and the candidate is neither", async () => {
    M.sql.mockImplementation(applyPredicate);
    await expect(resolvePlanItemHomeHarness("shared-slug", "calendar")).resolves.toBeNull();
    await expect(resolvePlanItemHomeHarness("shared-slug", null)).resolves.toBeNull();
  });

  it("returns null when no harness owns the slug", async () => {
    M.sql.mockImplementation(applyPredicate);
    await expect(resolvePlanItemHomeHarness("missing-slug", "papercusp")).resolves.toBeNull();
  });

  it("returns null on a read failure rather than trusting the candidate", async () => {
    M.sql.mockRejectedValue(new Error("connection reset"));
    await expect(resolvePlanItemHomeHarness("shared-slug", "email")).resolves.toBeNull();
  });
});
