import { describe, expect, it } from "vitest";
import { buildCorrectedCall, correctedCallHint } from "@papercusp/tooldef";
import { invalidInputCorrections, unknownArgHint } from "@papercusp/tooldef/define-tool";
import tool from "./get";

describe("plans:get decision selection contract", () => {
  it("rejects a decisionId-only read with a plan-local identity explanation", () => {
    const result = tool.args.safeParse({ decisionId: "D-074", mode: "full" });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toContain("D-NNN ids are plan-local");
  });

  it("accepts decision selection when the owning plan slug is supplied", () => {
    expect(
      tool.args.safeParse({ slug: "example-plan", decisionId: "D-074", mode: "full" }).success,
    ).toBe(true);
  });

  it("does not redirect plural section filters to the decisions selector", () => {
    const input = { slug: "example-plan", sections: ["Requirements", "Design"] };
    const parsed = tool.args.safeParse(input);

    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const corrections = invalidInputCorrections(
      parsed.error.issues,
      tool.args,
      tool.guidance?.argRedirects,
      input,
    );
    expect(corrections).toEqual([
      {
        rejectedArg: "sections",
        target: "",
        kind: "authored-drop",
        note: "For one section, pass its exact heading with `heading`; multiple section headings are not supported in one call.",
      },
    ]);

    const corrected = buildCorrectedCall({
      toolName: "plans:get",
      input,
      corrections,
      unknownKeys: ["sections"],
    });
    const message =
      correctedCallHint(corrected) +
      unknownArgHint(parsed.error.issues, tool.args, tool.guidance?.argRedirects, input, "plans:get");

    expect(message).toContain("`heading`");
    expect(message).toContain("multiple section headings are not supported in one call");
    expect(message).not.toContain("Did you mean `decisions` for `sections`");
    expect(message).not.toContain("this tool declares no counterpart");
    expect(corrected?.args).toEqual({ slug: "example-plan" });
  });
});
