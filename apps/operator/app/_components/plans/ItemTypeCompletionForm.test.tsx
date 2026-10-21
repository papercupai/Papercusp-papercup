// @vitest-environment jsdom
/**
 * plan-item-types-registry-cupboard-2026-10-20 P-007, R-20: the completion form renders a field for
 * each property of the item type's completion schema, and submitting it reaches completion-schema
 * validation. The fetch stand-in for POST /api/admin/plan-item-type-fields runs the real
 * `checkTypeFields`, the check `work_items:complete` applies to `completion.typeFields`.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkTypeFields } from "@papercusp/operator-core/lib/plan-types/item-type-contract";
import ItemTypeCompletionForm, {
  PLAN_ITEM_TYPE_FIELDS_API,
  completionFields,
  typeFieldsFrom,
} from "./ItemTypeCompletionForm";

const schema = {
  type: "object",
  required: ["summary", "pages"],
  additionalProperties: false,
  properties: {
    summary: { type: "string", title: "Summary" },
    pages: { type: "integer", minimum: 1 },
    reviewed: { type: "boolean", description: "A second reader signed off" },
    audience: { type: "string", enum: ["internal", "public"] },
    sources: { type: "array", items: { type: "string" } },
    extra: { type: "object" },
  },
};

const contract = { id: "acme/memo", completion: { schema } };
const noDatatypes = async () => undefined;

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url !== PLAN_ITEM_TYPE_FIELDS_API || init?.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: `unexpected ${init?.method} ${url}` }), { status: 404 });
  }
  const body = JSON.parse(String(init.body)) as { typeFields: Record<string, unknown> };
  const result = await checkTypeFields(contract, body.typeFields, noDatatypes);
  return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
});

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function lastRequestBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.at(-1);
  expect(call).toBeDefined();
  return JSON.parse(String(call![1]!.body)) as Record<string, unknown>;
}

describe("completionFields", () => {
  it("derives one field per schema property with its kind and required flag", () => {
    expect(completionFields(schema).map((f) => [f.name, f.kind, f.required])).toEqual([
      ["summary", "string", true],
      ["pages", "integer", true],
      ["reviewed", "boolean", false],
      ["audience", "enum", false],
      ["sources", "string-list", false],
      ["extra", "json", false],
    ]);
  });

  it("converts drafts to typed values and omits empty optional fields", () => {
    const fields = completionFields(schema);
    expect(
      typeFieldsFrom(fields, { summary: "Ok", pages: "4", sources: "a\n\n b ", extra: '{"k":1}', audience: "" }),
    ).toEqual({ summary: "Ok", pages: 4, sources: ["a", "b"], extra: { k: 1 } });
  });
});

describe("ItemTypeCompletionForm (R-20)", () => {
  it("renders a field for every property of the completion schema", () => {
    render(<ItemTypeCompletionForm planSlug="memo-plan" itemId="P-002" schema={schema} testId="form" />);
    const form = screen.getByTestId("form");
    const rendered = [...form.querySelectorAll("[data-field]")].map((el) => el.getAttribute("data-field"));
    expect(rendered).toEqual(Object.keys(schema.properties));
    for (const name of Object.keys(schema.properties)) {
      const label = form.querySelector(`label[for="ptf-P-002-${name}"]`);
      expect(label, `label for ${name}`).not.toBeNull();
      expect(form.querySelector(`#ptf-P-002-${name}`), `control for ${name}`).not.toBeNull();
    }
    expect(screen.getByLabelText(/Summary/)).toBeTruthy();
  });

  it("submits the typed fields to the completion-schema check and shows the accepted typeFields", async () => {
    render(
      <ItemTypeCompletionForm planSlug="memo-plan" harness="papercusp" itemId="P-002" schema={schema} testId="form" />,
    );
    fireEvent.change(screen.getByLabelText(/Summary/), { target: { value: "Quarterly memo" } });
    fireEvent.change(screen.getByLabelText(/pages/), { target: { value: "3" } });
    fireEvent.click(screen.getByLabelText(/reviewed/));
    fireEvent.change(screen.getByLabelText(/audience/), { target: { value: "public" } });
    fireEvent.change(screen.getByLabelText(/sources/), { target: { value: "https://a.example\nhttps://b.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Check fields" }));

    await screen.findByTestId("form-ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastRequestBody()).toEqual({
      slug: "memo-plan",
      harness: "papercusp",
      itemId: "P-002",
      typeFields: {
        summary: "Quarterly memo",
        pages: 3,
        reviewed: true,
        audience: "public",
        sources: ["https://a.example", "https://b.example"],
      },
    });
    expect(screen.getByTestId("form-ok").textContent).toContain('"pages": 3');
    expect(screen.queryByTestId("form-errors")).toBeNull();
  });

  it("shows the check's refusal for a wrongly typed or missing field", async () => {
    render(<ItemTypeCompletionForm planSlug="memo-plan" itemId="P-002" schema={schema} testId="form" />);
    fireEvent.change(screen.getByLabelText(/pages/), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Check fields" }));

    const errors = await screen.findByTestId("form-errors");
    expect(lastRequestBody()).toMatchObject({ itemId: "P-002", typeFields: { pages: 0 } });
    expect(lastRequestBody()).not.toHaveProperty("harness");
    const direct = await checkTypeFields(contract, { pages: 0 }, noDatatypes);
    expect(direct.ok).toBe(false);
    const expected = direct.ok ? [] : direct.errors;
    expect(expected.length).toBeGreaterThan(0);
    for (const message of expected) expect(errors.textContent).toContain(message);
    expect(screen.queryByTestId("form-ok")).toBeNull();
  });

  it("reports a failed request instead of a silent success", async () => {
    const failing = vi.fn(async () => {
      throw new Error("network down");
    });
    render(<ItemTypeCompletionForm planSlug="memo-plan" itemId="P-002" schema={schema} submit={failing} testId="form" />);
    fireEvent.click(screen.getByRole("button", { name: "Check fields" }));
    await waitFor(() => expect(screen.getByTestId("form-errors").textContent).toContain("network down"));
    // An untouched optional boolean is omitted rather than sent as false.
    expect(failing).toHaveBeenCalledWith({ slug: "memo-plan", itemId: "P-002", typeFields: {} });
  });
});
