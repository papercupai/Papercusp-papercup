// @vitest-environment jsdom
//
// AdminShell routing/layout coverage — the /admin section shell. The lexicon
// behavior of the Cupboard tab is pinned separately in
// AdminShell.lexicon.test.tsx; this file covers everything else: the header
// chrome (kicker / title / host badge / children), the full tab rail (hrefs +
// order + static labels), and the pathname → active-tab derivation (exact
// match, child-route prefix match, and the /admin/run fallback). TSR is mocked
// the same way as the lexicon sibling, with a mutable pathname so each test
// can place the router wherever it needs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

// Render the TSR primitives AdminShell needs without a real router. The Link
// mock spreads the rest props so Radix's asChild Tabs.Trigger attributes
// (role="tab", aria-selected, data-state) land on the anchor.
let mockPathname = "/admin/run";
let mockTriggersEnabled = true;
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    ...rest
  }: { to: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={to} {...(rest as object)}>
      {children}
    </a>
  ),
  // The component calls useRouterState({ select }) — the mock ignores the
  // selector and hands back the pathname directly (sibling idiom).
  useRouterState: () => mockPathname,
}));
vi.mock("@/lib/flag-hooks", () => ({
  useFlag: () => mockTriggersEnabled,
}));

import AdminShell from "./AdminShell";

beforeEach(() => {
  mockPathname = "/admin/run";
  mockTriggersEnabled = true;
});

afterEach(() => cleanup());

// The full rail, in declaration order. The Cupboard label is lexicon-driven
// (covered by the sibling test) so this file asserts that tab by href only.
const TAB_HREFS = [
  "/admin/run",
  "/admin/features",
  "/admin/admission",
  "/admin/triggers",
  "/admin/recipes",
  "/admin/git",
  "/admin/dogfood-substrate",
  "/admin/dbos",
  "/admin/schedules",
  "/admin/tasks",
  "/admin/work-scope",
  // P-005 (WI-6554700010011434): inherited governance policy section (bb0fc5540b).
  "/admin/governance-policy",
  "/admin/cupboard-moderation",
];

function selectedTabs(): HTMLElement[] {
  return screen
    .getAllByRole("tab")
    .filter((t) => t.getAttribute("aria-selected") === "true");
}

describe("AdminShell", () => {
  it("renders the header chrome, default title, host badge, and children", () => {
    render(
      <AdminShell>
        <div>panel-body-content</div>
      </AdminShell>,
    );

    expect(screen.getByText("Admin console")).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 1, name: "Admin" }),
    ).toBeTruthy();
    expect(screen.getByText("localhost · :3055")).toBeTruthy();
    expect(screen.getByText("panel-body-content")).toBeTruthy();
  });

  it("renders a custom title in the h1", () => {
    render(
      <AdminShell title="Testing dashboard">
        <div />
      </AdminShell>,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Testing dashboard" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { level: 1, name: "Admin" }),
    ).toBeNull();
  });

  it("renders one tab link per admin section, in order, with the right hrefs", () => {
    render(
      <AdminShell>
        <div />
      </AdminShell>,
    );

    expect(
      screen.getByRole("tablist", { name: "Admin sections" }),
    ).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("href"))).toEqual(TAB_HREFS);

    // Static (non-lexicon) labels render verbatim.
    for (const label of [
      "Run",
      "Features",
      "Admission",
      "Triggers",
      "Recipes",
      "Git",
      "Substrate",
      "DBOS",
      "Schedules",
      "Tasks",
      "Work scope",
    ]) {
      expect(screen.getByRole("tab", { name: label })).toBeTruthy();
    }
  });

  it("hides the Triggers tab when the external-triggers kill-switch is off", () => {
    mockTriggersEnabled = false;
    render(
      <AdminShell>
        <div />
      </AdminShell>,
    );

    expect(screen.queryByRole("tab", { name: "Triggers" })).toBeNull();
    expect(
      screen.getAllByRole("tab").map((t) => t.getAttribute("href")),
    ).toEqual(TAB_HREFS.filter((href) => href !== "/admin/triggers"));
  });

  it("selects the tab whose href matches the pathname exactly", () => {
    mockPathname = "/admin/git";
    render(
      <AdminShell>
        <div />
      </AdminShell>,
    );

    expect(
      screen.getByRole("tab", { name: "Git", selected: true }),
    ).toBeTruthy();
    expect(selectedTabs()).toHaveLength(1);
  });

  it("keeps the parent tab selected on child routes (prefix match)", () => {
    mockPathname = "/admin/git/pipeline";
    render(
      <AdminShell>
        <div />
      </AdminShell>,
    );

    expect(
      screen.getByRole("tab", { name: "Git", selected: true }),
    ).toBeTruthy();
    expect(selectedTabs()).toHaveLength(1);
  });

  it("selects the Triggers tab on its route and child paths", () => {
    mockPathname = "/admin/triggers/runs";
    render(
      <AdminShell>
        <div />
      </AdminShell>,
    );

    expect(
      screen.getByRole("tab", { name: "Triggers", selected: true }),
    ).toBeTruthy();
    expect(selectedTabs()).toHaveLength(1);
  });

  it("falls back to the Run tab for unrecognized admin paths", () => {
    mockPathname = "/admin/does-not-exist";
    render(
      <AdminShell>
        <div />
      </AdminShell>,
    );

    expect(
      screen.getByRole("tab", { name: "Run", selected: true }),
    ).toBeTruthy();
    expect(selectedTabs()).toHaveLength(1);
  });

  it("defaults to /admin/run when the router has no pathname yet", () => {
    mockPathname = "";
    render(
      <AdminShell>
        <div />
      </AdminShell>,
    );

    expect(
      screen.getByRole("tab", { name: "Run", selected: true }),
    ).toBeTruthy();
    expect(selectedTabs()).toHaveLength(1);
  });
});
