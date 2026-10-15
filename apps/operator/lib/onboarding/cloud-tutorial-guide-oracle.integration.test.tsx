// @vitest-environment jsdom
import { useReducer } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createTutorialState, tutorialReducer } from "@papercusp/operator-core/lib/onboarding/cloud-tutorial-lesson";
import type * as Guide from "./cloud-tutorial-guide";

// Reuse the calibrated copy-out oracle seam from the lesson controller. Both
// phases execute the same DOM assertions against the production module bytes.
const { CloudTutorialGuide }: typeof Guide = await import(process.env.CLOUD_TUTORIAL_GUIDE_PROBE ?? "./cloud-tutorial-guide");
const scope = { tenantId: "tenant", userId: "user", workspaceId: "customer" };
function Fixture() {
  const [state, dispatch] = useReducer(tutorialReducer, tutorialReducer(createTutorialState(scope), {
    type: "observe", observation: { scope, revision: 1, access: "allowed" },
  }));
  return <><input aria-label="Product field" data-tutorial-target="cloud-connection" />
    <CloudTutorialGuide state={state} dispatch={dispatch} reducedMotion /></>;
}
beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 20, y: 20, top: 20, left: 20, width: 200, height: 40, right: 220, bottom: 60, toJSON: () => ({}) });
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("the Guide honors Pause and removes the highlight while retaining product input", async () => {
  render(<Fixture />);
  await waitFor(() => expect(document.querySelector(".react-joyride__overlay")).not.toBeNull());
  const input = screen.getByRole("textbox", { name: "Product field" });
  fireEvent.change(input, { target: { value: "Keep my draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  expect(screen.getByRole("status").textContent, "Pause was ignored by the guide").toBe("Your lesson is paused.");
  expect(document.querySelector(".react-joyride__overlay")).toBeNull();
  expect(input).toHaveProperty("value", "Keep my draft");
});
it("the Guide honors Exit and cleans its region and highlight while Help remains available", async () => {
  render(<Fixture />);
  await waitFor(() => expect(document.querySelector(".react-joyride__overlay")).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Close guide" }));
  expect(screen.queryByRole("region", { name: "First agent guide" }), "Exit left the guide region behind").toBeNull();
  expect(document.querySelector(".react-joyride__overlay")).toBeNull();
  expect(screen.getByText("Help")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Product field" })).toBeTruthy();
});
