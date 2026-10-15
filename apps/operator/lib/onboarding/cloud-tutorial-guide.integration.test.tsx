// @vitest-environment jsdom
import { StrictMode, useReducer, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Button } from "@/app/harness/Button";
import { createTutorialState, tutorialReducer, type ProductObservation } from "@papercusp/operator-core/lib/onboarding/cloud-tutorial-lesson";
import { CloudTutorialGuide, CloudTutorialHelpEntry } from "./cloud-tutorial-guide";
import { AccountProductTutorial, type ProductTutorialAccount } from "@papercusp/operator-ui/onboarding";
import { PRODUCT_TUTORIAL_LESSONS } from "@papercusp/operator-core/lib/onboarding/product-tutorial-lesson";

// Match the maintained product-guide composition suites: telemetry is an
// observation sink, not part of the progress transport under this test.
vi.mock("../../../../packages/operator-ui/src/browser-telemetry", () => ({ captureBrowserTelemetry: vi.fn() }));

const scope = { tenantId: "tenant", userId: "user", workspaceId: "customer" };
let systemReducedMotion = false;
vi.mock("motion/react", async importOriginal => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => systemReducedMotion,
}));
beforeEach(() => {
  systemReducedMotion = false;
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 20, y: 20, top: 20, left: 20, width: 200, height: 40, right: 220, bottom: 60, toJSON: () => ({}) });
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

// R-6: the Cloud guide below is one module. Exercise the composed account guide
// with its real progress validation and destination controls for every lesson.
// Browser tests own geometric zoom/reflow and axe; jsdom asserts semantics/focus.
describe("Full-product guide accessibility composition", () => {
  for (const workspaceId of [null, "customer"]) {
    it(`preserves lesson Help, pause/resume focus and editable destinations with workspace=${workspaceId}`, async () => {
      const account: ProductTutorialAccount = { tenantId: "tenant", userId: "user", sessionId: "session", workspaceId };
      let record = { scope: { tenantId: account.tenantId, userId: account.userId }, version: 3,
        revision: 0, mutationId: null, disposition: "active", currentLessonId: "welcome", reviewedLessonIds: [] as string[] };
      const writes: Array<Record<string, unknown>> = [];
      const fetcher = vi.fn<typeof fetch>(async (url, init) => {
        // Validate the real account endpoint including its required scope/version
        // query before a permissive fixture can hide an unexpected transport.
        expect(String(url)).toBe("/api/hosted/browser/onboarding/tutorial-progress?scope=account&version=3");
        if (init?.method === "POST") {
          const patch = JSON.parse(String(init.body)); writes.push(patch);
          record = { ...record, ...patch, revision: record.revision + 1 };
        }
        return Response.json({ record });
      });
      vi.stubGlobal("fetch", fetcher);
      render(<AccountProductTutorial account={account}>{controls => <section aria-label="Product destination">
        {controls}<label>Product form field<input /></label>
      </section>}</AccountProductTutorial>);
      await screen.findByRole("heading", { name: "Welcome to Papercusp" });

      for (const lesson of PRODUCT_TUTORIAL_LESSONS) {
        const navigation = screen.getByRole("button", { name: lesson.title });
        navigation.focus(); fireEvent.click(navigation);
        const heading = await screen.findByRole("heading", { name: lesson.title });
        await waitFor(() => expect(document.activeElement).toBe(heading));
        expect(navigation.getAttribute("aria-current")).toBe("step");
        const help = screen.getByText("Help with this lesson", { exact: true });
        const disclosure = help.closest("details")!;
        disclosure.open = true; fireEvent(disclosure, new Event("toggle"));
        expect(screen.getByText(lesson.help, { exact: true })).toBeTruthy();
        const question = screen.getByRole("textbox", { name: "Lesson question" });
        question.focus(); fireEvent.change(question, { target: { value: `Explain ${lesson.title}` } });
        expect(document.activeElement).toBe(question);
        expect((question as HTMLTextAreaElement).value).toBe(`Explain ${lesson.title}`);
        const progressStatus = screen.getByText(/explanations reviewed\. Product tasks are verified separately\./);
        expect(progressStatus.getAttribute("role")).toBe("status");
        disclosure.open = false; fireEvent(disclosure, new Event("toggle"));

        const pause = screen.getByRole("button", { name: "Pause guide" }); pause.focus(); fireEvent.click(pause);
        const resume = await screen.findByRole("button", { name: "Resume product guide" });
        await waitFor(() => expect(document.activeElement).toBe(resume));
        const field = screen.getByRole("textbox", { name: "Product form field" });
        field.focus(); fireEvent.change(field, { target: { value: "My product input" } });
        expect(document.activeElement).toBe(field);
        expect((field as HTMLInputElement).value).toBe("My product input");
        expect(screen.queryByRole("heading", { name: lesson.title })).toBeNull();
        fireEvent.click(resume);
        const restored = await screen.findByRole("heading", { name: lesson.title });
        await waitFor(() => expect(document.activeElement).toBe(restored));
      }
      expect(writes.every(patch => Array.isArray(patch.reviewedLessonIds) && patch.reviewedLessonIds.length === 0)).toBe(true);
      expect(writes.every(patch => patch.expectedScope && ["active", "paused"].includes(String(patch.disposition)))).toBe(true);
      expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(
        Array(fetcher.mock.calls.length).fill("/api/hosted/browser/onboarding/tutorial-progress?scope=account&version=3"));
    });
  }
});

function Fixture({ observation = { scope, revision: 1, access: "allowed" } as ProductObservation, target = true, check = vi.fn(), reducedMotion = true }) {
  const [state, dispatch] = useReducer(tutorialReducer, tutorialReducer(createTutorialState(scope), { type: "observe", observation }));
  return <>
    <Button>App launcher</Button>
    {target && <label>Real connection label<input data-tutorial-target="cloud-connection" /></label>}
    <CloudTutorialGuide state={state} dispatch={dispatch} reducedMotion={reducedMotion} onCheckAgain={check} />
  </>;
}
describe("Persistent nonmodal Cloud Guide", () => {
  it("mounts the replay action only after opening the accessible Help disclosure", () => {
    const onStart = vi.fn();
    render(<CloudTutorialHelpEntry onStart={onStart} />);
    const help = screen.getByRole("button", { name: "Help" });
    expect(help.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Get your first agent running" })).toBeNull();
    fireEvent.click(help);
    expect(help.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Get your first agent running" }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });
  it("honors the system reduced-motion preference even when a caller does not request reduced motion", async () => {
    systemReducedMotion = true;
    render(<Fixture reducedMotion={false} />);
    await waitFor(() => expect(document.querySelector(".react-joyride__overlay")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Show me" }));
    expect(Element.prototype.scrollIntoView).toHaveBeenLastCalledWith({ behavior: "instant", block: "center" });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Real connection label" }));
  });
  it("keeps focus on the replacement controls when pause and resume remove the clicked button", async () => {
    render(<Fixture />);
    const pause = screen.getByRole("button", { name: "Pause" }); pause.focus(); fireEvent.click(pause);
    const resume = screen.getByRole("button", { name: "Resume guide" });
    await waitFor(() => expect(document.activeElement).toBe(resume));
    fireEvent.click(resume);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show me" })));
  });
  it("explains and highlights the current action while preserving keyboard and product input", async () => {
    render(<StrictMode><Fixture /></StrictMode>);
    expect(screen.getByRole("heading", { name: "Connect Google Cloud" })).toBeTruthy();
    expect(screen.getByText(/Use an injected credential reference in the connection form/).textContent)
      .toContain('Never paste API keys, service-account JSON or tokens into the form or Help.');
    expect(screen.getByText(/Contextual help is unavailable/)).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".react-joyride__overlay")).not.toBeNull());
    const input = screen.getByRole("textbox", { name: "Real connection label" });
    fireEvent.click(screen.getByRole("button", { name: "Show me" }));
    expect(document.activeElement).toBe(input);
    expect(fireEvent.keyDown(input, { key: "Tab", cancelable: true })).toBe(true);
    fireEvent.change(input, { target: { value: "My GCP project" } });
    expect(input).toHaveProperty("value", "My GCP project");
    expect(screen.getByText("0 of 6 steps confirmed")).toBeTruthy();
    expect(getComputedStyle(document.querySelector(".react-joyride__overlay path")!).pointerEvents).toBe("none");
  });
  it("pauses, resumes, skips, restarts and opens from Help without losing the domain position", async () => {
    render(<Fixture observation={{ scope, revision: 1, access: "allowed", connection: { id: "gcp", provider: "gcp", validated: true } }} />);
    expect(screen.getByRole("heading", { name: "Review configuration and cost" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByText("Your lesson is paused.")).toBeTruthy();
    expect(document.querySelector(".react-joyride__overlay")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume guide" }));
    expect(screen.getByRole("heading", { name: "Review configuration and cost" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip lesson" }));
    expect(screen.getByText(/You can start this lesson again from Help/)).toBeTruthy();
    fireEvent.click(screen.getByText("Help"));
    fireEvent.click(screen.getByRole("button", { name: "Get your first agent running" }));
    expect(screen.getByRole("heading", { name: "Connect Google Cloud" })).toBeTruthy();
    expect(screen.getByText("Already completed in this workspace.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next explanation" }));
    expect(screen.getByRole("heading", { name: "Review configuration and cost" })).toBeTruthy();
    expect(screen.getByText("1 of 6 steps confirmed")).toBeTruthy();
  });
  it("leaves missing targets recoverable and Check again never invokes a product action", async () => {
    const check = vi.fn();
    render(<Fixture target={false} check={check} />);
    fireEvent.click(screen.getByRole("button", { name: "Show me" }));
    expect(screen.getByRole("status").textContent).toMatch(/not visible/);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(check).toHaveBeenCalledTimes(1);
    expect(screen.getByText("0 of 6 steps confirmed")).toBeTruthy();
  });
  it("renders actionable failure/delay recovery while keeping deterministic controls available", () => {
    render(<Fixture observation={{ scope, revision: 1, access: "allowed", attempt: { step: "connection", status: "failed" } }} />);
    expect(screen.getByRole("alert").textContent).toMatch(/needs attention/);
    expect(screen.getByText(/Review the connection’s validation details/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close guide" })).toBeTruthy();
  });
  it("Show me focuses a control mounted by the user’s navigation request", async () => {
    function LateTarget() {
      const [mounted, setMounted] = useState(false);
      const [state, dispatch] = useReducer(tutorialReducer, tutorialReducer(createTutorialState(scope), { type: "observe", observation: { scope, revision: 1, access: "allowed" } }));
      return <>{mounted && <input aria-label="Navigated product control" data-tutorial-target="cloud-connection" />}
        <CloudTutorialGuide state={state} dispatch={dispatch} reducedMotion onShowStep={() => setMounted(true)} /></>;
    }
    render(<LateTarget />);
    fireEvent.click(screen.getByRole("button", { name: "Show me" }));
    const input = await screen.findByRole("textbox", { name: "Navigated product control" });
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(screen.getByRole("region", { name: "First agent guide" })).toBeTruthy();
    expect(screen.getByText("0 of 6 steps confirmed")).toBeTruthy();
  });
  it("restores entry focus and removes overlays on exit; Help can reopen the lesson", async () => {
    const trigger = document.createElement("button"); trigger.textContent = "Entry focus"; document.body.append(trigger); trigger.focus();
    const view = render(<Fixture />);
    await waitFor(() => expect(document.querySelector(".react-joyride__overlay")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Close guide" }));
    expect(document.querySelector("[data-cloud-tutorial-guide]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await waitFor(() => expect(document.querySelector(".react-joyride__overlay")).toBeNull());
    fireEvent.click(screen.getByText("Help"));
    fireEvent.click(screen.getByRole("button", { name: "Get your first agent running" }));
    await waitFor(() => expect(document.querySelectorAll(".react-joyride__overlay")).toHaveLength(1));
    await act(async () => view.unmount()); trigger.remove();
    expect(document.querySelector(".react-joyride__overlay")).toBeNull();
  });
  it.each(["automatic", "removed", "disabled", "nonfocusable"])("closes to Help when the %s entry cannot receive focus", async entry => {
    const trigger = entry === "nonfocusable" ? document.createElement("div") : document.createElement("button");
    if (entry !== "automatic") {
      if (entry === "nonfocusable") trigger.tabIndex = 0;
      document.body.append(trigger); trigger.focus();
    }
    const view = render(<Fixture />);
    if (entry === "removed") trigger.remove();
    if (entry === "disabled") (trigger as HTMLButtonElement).disabled = true;
    if (entry === "nonfocusable") trigger.removeAttribute("tabindex");
    const close = screen.getByRole("button", { name: "Close guide" }); close.focus(); fireEvent.click(close);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Help" })));
    expect(screen.queryByRole("region", { name: "First agent guide" })).toBeNull();
    expect(document.querySelector(".react-joyride__overlay")).toBeNull();
    // The restored control is usable: keyboard activation reopens the lesson.
    fireEvent.click(document.activeElement!);
    fireEvent.click(screen.getByRole("button", { name: "Get your first agent running" }));
    expect(screen.getByRole("region", { name: "First agent guide" })).toBeTruthy();
    view.unmount(); trigger.remove();
  });
});
