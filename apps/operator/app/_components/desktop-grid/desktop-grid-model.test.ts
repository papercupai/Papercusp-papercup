import { describe, expect, it } from "vitest";
import {
  DESKTOP_GRID_MAX_PINS,
  filterDesktopTiles,
  livePins,
  parseDesktopSelection,
  serializeDesktopSelection,
  toggleDesktopPin,
  type DesktopGridTile,
} from "./desktop-grid-model";

function tile(id: string, extra: Partial<DesktopGridTile> = {}): DesktopGridTile {
  return {
    desktopSessionId: id,
    title: `desktop ${id}`,
    ownerLabel: null,
    workItemLabel: null,
    state: "running",
    thumbnailSrc: null,
    ...extra,
  };
}

describe("desktop grid model (agent-multi-desktops-grid P-006)", () => {
  it("allows at most two live pins", () => {
    expect(DESKTOP_GRID_MAX_PINS).toBe(2);
  });

  describe("filterDesktopTiles", () => {
    const tiles = [
      tile("a", { title: "browser", ownerLabel: "Agent su-1a2b", workItemLabel: "WI-12 · build grid" }),
      tile("b", { title: "terminal", ownerLabel: "Agent cup-99", state: "starting" }),
      tile("c-xyz", { title: "spare" }),
    ];

    it("returns every tile for a blank query", () => {
      expect(filterDesktopTiles(tiles, "   ").map((t) => t.desktopSessionId)).toEqual([
        "a",
        "b",
        "c-xyz",
      ]);
    });

    it("matches title, owner, work-item, state and id case-insensitively", () => {
      expect(filterDesktopTiles(tiles, "BROWSER").map((t) => t.desktopSessionId)).toEqual(["a"]);
      expect(filterDesktopTiles(tiles, "cup-99").map((t) => t.desktopSessionId)).toEqual(["b"]);
      expect(filterDesktopTiles(tiles, "wi-12").map((t) => t.desktopSessionId)).toEqual(["a"]);
      expect(filterDesktopTiles(tiles, "starting").map((t) => t.desktopSessionId)).toEqual(["b"]);
      expect(filterDesktopTiles(tiles, "xyz").map((t) => t.desktopSessionId)).toEqual(["c-xyz"]);
    });

    it("returns nothing when no tile matches", () => {
      expect(filterDesktopTiles(tiles, "nope")).toEqual([]);
    });
  });

  describe("toggleDesktopPin", () => {
    it("pins and unpins", () => {
      expect(toggleDesktopPin([], "a")).toEqual(["a"]);
      expect(toggleDesktopPin(["a", "b"], "a")).toEqual(["b"]);
    });

    it("refuses a third pin instead of evicting one", () => {
      const pinned = ["a", "b"];
      const next = toggleDesktopPin(pinned, "c");
      expect(next).toEqual(["a", "b"]);
      expect(next).not.toBe(pinned);
    });
  });

  describe("livePins", () => {
    it("drops pins for desktops that ended, dedupes, and caps at the limit", () => {
      expect(livePins(["gone", "a", "a", "b", "c"], new Set(["a", "b", "c"]))).toEqual(["a", "b"]);
    });
  });

  describe("selection URL form", () => {
    it("round-trips watch and takeover", () => {
      for (const mode of ["watch", "takeover"] as const) {
        const value = serializeDesktopSelection({ desktopSessionId: "dsk:1", mode });
        expect(value).toBe(`${mode}:dsk:1`);
        expect(parseDesktopSelection(value)).toEqual({ desktopSessionId: "dsk:1", mode });
      }
      expect(serializeDesktopSelection(null)).toBeNull();
    });

    it("rejects malformed values", () => {
      for (const bad of [null, undefined, "", "watch", ":abc", "watch:", "steal:abc"]) {
        expect(parseDesktopSelection(bad)).toBeNull();
      }
    });
  });
});
