/**
 * plans:items exact-item aliases (WI-6554700010029562).
 *
 * Six compatibility spellings of the one exact-item selector used to be declared as sibling
 * schema fields, shipping ~0.4 KB of compact schema on every seeded turn while only ever
 * meaning `itemIds`. They are now folded into `itemIds` before parse. This pins both halves:
 * every spelling still works with the documented precedence, and none is advertised.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import tool from "./items";

const ALIASES = {
  item: "P-003",
  ids: ["P-004"],
  itemId: "P-005",
  items: ["P-006"],
  item_ids: ["P-007"],
  item_id: "P-008",
} as const;

describe("plans:items exact-item aliases are accepted but never advertised", () => {
  it("advertises itemIds as the only exact-item selector", () => {
    const schema = z.toJSONSchema(tool.args as z.ZodType, { io: "output" }) as { properties?: Record<string, unknown> };
    const props = Object.keys(schema.properties ?? {});
    expect(props).toContain("itemIds");
    for (const alias of Object.keys(ALIASES)) expect(props).not.toContain(alias);
  });

  it.each(Object.entries(ALIASES))("folds %s into itemIds", (key, value) => {
    const parsed = tool.args.safeParse({ harness: "papercup", slug: "plan-a", [key]: value });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect((parsed.data as { itemIds?: string[] }).itemIds).toEqual(typeof value === "string" ? [value] : value);
    expect(parsed.data).not.toHaveProperty(key);
  });

  it("keeps the documented precedence: itemIds > item > ids > itemId > items > item_ids > item_id", () => {
    const all = { harness: "papercup", slug: "plan-a", ...ALIASES };
    const itemIdsOf = (args: Record<string, unknown>) => (tool.args.parse(args) as { itemIds?: string[] }).itemIds;
    expect(itemIdsOf({ ...all, itemIds: ["P-001"] })).toEqual(["P-001"]);
    expect(itemIdsOf(all)).toEqual(["P-003"]);
    const { item: _item, ...withoutItem } = all;
    expect(itemIdsOf(withoutItem)).toEqual(["P-004"]);
    const { ids: _ids, itemId: _itemId, items: _items, item_ids: _itemIds, ...onlyLast } = withoutItem;
    expect(itemIdsOf(onlyLast)).toEqual(["P-008"]);
  });

  it("still requires an exact slug and the P-NNN form through any alias", () => {
    expect(tool.args.safeParse({ harness: "papercup", item_id: "P-001" }).success).toBe(false);
    expect(tool.args.safeParse({ harness: "papercup", plan: "plan-a", item_id: "P-001" }).success).toBe(true);
    expect(tool.args.safeParse({ harness: "papercup", slug: "plan-a", itemId: "P-1" }).success).toBe(false);
    expect(tool.args.safeParse({ harness: "papercup", slug: "plan-a", items: [] }).success).toBe(false);
  });
});
