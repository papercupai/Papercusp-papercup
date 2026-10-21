// @vitest-environment jsdom
/**
 * plan-item-types-registry-cupboard-2026-10-20 P-007, R-25: the Plans-pane checklist lists every
 * module of an item's resolved module set.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ResolvedModuleChecklist from "./ResolvedModuleChecklist";

afterEach(cleanup);

describe("ResolvedModuleChecklist (R-25)", () => {
  it.each([
    [["generic-core"]],
    [["generic-core", "code"]],
    [["generic-core", "code", "acme/legal-review"]],
  ])("lists every module of the resolved module set %j", (modules) => {
    render(<ResolvedModuleChecklist modules={modules} testId="check" />);
    const list = screen.getByRole("list", { name: "Resolved verification modules" });
    const entries = within(list).getAllByRole("listitem");
    expect(entries.map((entry) => entry.getAttribute("data-module"))).toEqual(modules);
    expect(entries.map((entry) => entry.textContent)).toEqual(modules);
    expect(screen.getByTestId("check").textContent).toContain(`Verification modules · ${modules.length}`);
  });

  it("says so when the item is held to no module", () => {
    render(<ResolvedModuleChecklist modules={[]} testId="check" />);
    expect(screen.queryByRole("list", { name: "Resolved verification modules" })).toBeNull();
    expect(screen.getByTestId("check").textContent).toContain("held to no verification module");
  });

  it("lists the item type's acceptance criteria beside the modules", () => {
    render(
      <ResolvedModuleChecklist
        modules={["generic-core"]}
        criteria={[
          { key: "sources-cited", title: "Every claim cites a source" },
          { key: "reviewed", title: "A second reader reviewed it" },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "Item-type acceptance criteria" });
    const entries = within(list).getAllByRole("listitem");
    expect(entries.map((entry) => entry.getAttribute("data-criterion"))).toEqual(["sources-cited", "reviewed"]);
    expect(entries[0]!.textContent).toBe("Every claim cites a source");
  });
});
