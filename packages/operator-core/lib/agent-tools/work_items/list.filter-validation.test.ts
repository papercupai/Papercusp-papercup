import { describe, expect, it } from "vitest";
import workItemsList from "./list";

describe("work_items:list timestamp filters", () => {
  it.each(["createdSince", "updatedSince"] as const)(
    "%s rejects the reported relative duration before query execution",
    (filter) => {
      const parsed = workItemsList.args.safeParse({
        harness: "papercusp",
        [filter]: "30 min",
      });

      expect(parsed.success).toBe(false);
    },
  );

  it.each(["createdSince", "updatedSince"] as const)(
    "%s accepts an ISO 8601 timestamp with a timezone",
    (filter) => {
      const parsed = workItemsList.args.safeParse({
        harness: "papercusp",
        [filter]: "2026-10-09T15:25:00-04:00",
      });

      expect(parsed.success).toBe(true);
    },
  );
});
