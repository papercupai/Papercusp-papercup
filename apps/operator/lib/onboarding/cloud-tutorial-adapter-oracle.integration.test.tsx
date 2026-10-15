// @vitest-environment jsdom
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { driver } from "driver.js";
import { Button } from "@/app/harness/Button";
import { CloudTutorialHighlight } from "./cloud-tutorial-adapter";

// Permanent calibrated counterexample seam. The identical browser-event oracle
// runs on the selected adapter normally and on the rejected real engine only
// when the targeted negative proof explicitly selects it. No source is mutated.
function RejectedDriver() {
  useEffect(() => {
    const tour = driver({ animate: false, allowKeyboardControl: false, disableActiveInteraction: false });
    tour.highlight({ element: "[data-tutorial-target='oracle']" });
    return () => tour.destroy();
  }, []);
  return null;
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 20, y: 20, top: 20, left: 20, width: 200, height: 40, right: 220, bottom: 60, toJSON: () => ({}) });
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("selected engine leaves native Tab available to reach the nonmodal Guide", async () => {
  render(<>
    <input aria-label="Real product input" data-tutorial-target="oracle" />
    <Button>Guide help</Button>
    {process.env.CLOUD_TUTORIAL_COUNTEREXAMPLE === "driver"
      ? <RejectedDriver />
      : <CloudTutorialHighlight target="[data-tutorial-target='oracle']" active contextKey="oracle-workspace" reducedMotion />}
  </>);
  await waitFor(() => expect(document.querySelector(".react-joyride__overlay, .driver-overlay")).not.toBeNull());
  const input = screen.getByRole("textbox", { name: "Real product input" });
  const help = screen.getByRole("button", { name: "Guide help" });
  expect(help.isConnected).toBe(true);
  input.focus();
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  if (!input.dispatchEvent(tab)) throw new Error("Selected engine trapped Tab in nonmodal Guide");
  expect(tab.defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(input);
  help.focus();
  expect(document.activeElement).toBe(help);
});
