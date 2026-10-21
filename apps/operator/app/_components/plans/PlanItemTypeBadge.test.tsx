// @vitest-environment jsdom
/**
 * plan-item-types-registry-cupboard-2026-10-20 P-007, R-19: every plan item with a resolved item
 * type renders its type badge, and the plan header renders its plan-type badge.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PlanItemTypeBadge, { PlanTypeBadge, itemTypeLabel } from "./PlanItemTypeBadge";

afterEach(cleanup);

// The shape of `plans.itemTypeView` items (PlanItemTypeViewItem), trimmed to what the badge reads.
const viewItems = [
  { itemId: "P-001", itemType: "papercusp/code-change", revision: 1, builtIn: true },
  { itemId: "P-002", itemType: "acme/memo", revision: 3, builtIn: false },
  { itemId: "P-003", itemType: null, revision: null, builtIn: false },
  { itemId: "P-004", itemType: "acme/review", revision: 1, builtIn: false },
];

describe("PlanItemTypeBadge (R-19)", () => {
  it("renders a badge for every item with a resolved item type and none for an unresolved one", () => {
    render(
      <ul>
        {viewItems.map((item) => (
          <li key={item.itemId} data-testid={`row-${item.itemId}`}>
            <PlanItemTypeBadge
              itemType={item.itemType}
              revision={item.revision}
              builtIn={item.builtIn}
              testId={`badge-${item.itemId}`}
            />
          </li>
        ))}
      </ul>,
    );
    for (const item of viewItems) {
      const row = screen.getByTestId(`row-${item.itemId}`);
      const badge = row.querySelector("[data-item-type]");
      if (item.itemType === null) {
        expect(badge).toBeNull();
        continue;
      }
      expect(badge).not.toBeNull();
      expect(badge!.getAttribute("data-item-type")).toBe(item.itemType);
      expect(badge!.textContent).toBe(itemTypeLabel(item.itemType, item.revision));
    }
    expect(document.querySelectorAll("[data-item-type]")).toHaveLength(3);
  });

  it("labels a registry item type with its revision and marks built-in types apart", () => {
    render(
      <>
        <PlanItemTypeBadge itemType="acme/memo" revision={3} builtIn={false} testId="registry" />
        <PlanItemTypeBadge itemType="papercusp/code-change" revision={1} builtIn testId="builtin" />
      </>,
    );
    const registry = screen.getByTestId("registry");
    expect(registry.textContent).toBe("acme/memo@3");
    expect(registry.getAttribute("aria-label")).toBe("Item type: acme/memo@3");
    expect(registry.getAttribute("data-item-type-revision")).toBe("3");
    expect(registry.getAttribute("data-item-type-builtin")).toBe("false");
    expect(registry.className).not.toContain("plan-dash__ibadge--builtin");
    const builtin = screen.getByTestId("builtin");
    expect(builtin.getAttribute("data-item-type-builtin")).toBe("true");
    expect(builtin.className).toContain("plan-dash__ibadge--builtin");
  });

  it("is a button that opens the type panel without triggering the row it sits in", () => {
    const onOpen = vi.fn();
    const onRow = vi.fn();
    render(
      <div onClick={onRow}>
        <PlanItemTypeBadge itemType="acme/memo" revision={3} builtIn={false} onOpen={onOpen} active testId="open" />
      </div>,
    );
    const badge = screen.getByTestId("open");
    expect(badge.tagName).toBe("BUTTON");
    expect(badge.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(badge);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onRow).not.toHaveBeenCalled();
  });
});

describe("PlanTypeBadge", () => {
  it("shows the declared plan type", () => {
    render(<PlanTypeBadge planType="acme/memo-plan" profile="general" testId="pt" />);
    const badge = screen.getByTestId("pt");
    expect(badge.textContent).toBe("acme/memo-plan");
    expect(badge.getAttribute("data-plan-type")).toBe("acme/memo-plan");
    expect(badge.getAttribute("data-plan-profile")).toBe("general");
  });

  it("falls back to the profile when the plan declares no type", () => {
    render(<PlanTypeBadge planType={null} profile="code" testId="pt" />);
    const badge = screen.getByTestId("pt");
    expect(badge.textContent).toBe("code");
    expect(badge.getAttribute("data-plan-type")).toBe("");
    expect(badge.className).toContain("plan-dash__ibadge--builtin");
  });
});
