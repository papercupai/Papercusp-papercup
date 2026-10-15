// @vitest-environment jsdom
import { StrictMode, useEffect, useState } from "react";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { Joyride } from "react-joyride";
import { driver } from "driver.js";
import "driver.js/dist/driver.css";
import { NuqsAdapter } from "../../../operator-vite/src/lib/nuqs-tanstack-router-adapter";
import { Button } from "@/app/harness/Button";
import { Modal } from "@/app/harness/Modal";
import CloudWorkspacesPage from "@/app/cloud-workspaces/page";
import { CloudTutorialHighlight } from "./cloud-tutorial-adapter";

describe("Assessed walkthrough dependencies", () => {
  it("pins the installed and locked stable MIT Joyride release and keeps Driver test-only", () => {
    const manifest = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(resolve(__dirname, "../../../../package-lock.json"), "utf8"));
    const require = createRequire(import.meta.url);
    const installed = JSON.parse(readFileSync(resolve(dirname(require.resolve("react-joyride")), "../package.json"), "utf8"));
    // D-014 assessed this exact release on React 19. A changed engine/version or
    // license requires fresh assessment, rather than silently inheriting proof.
    expect(manifest.dependencies["react-joyride"]).toBe("3.2.0");
    expect(installed).toMatchObject({ name: "react-joyride", version: "3.2.0", license: "MIT",
      peerDependencies: { react: "16.8 - 19", "react-dom": "16.8 - 19" } });
    expect(lock.packages["node_modules/react-joyride"]).toMatchObject({ version: "3.2.0", license: "MIT" });
    expect(lock.packages["apps/operator"].dependencies["react-joyride"]).toBe("3.2.0");
    expect(manifest.dependencies["driver.js"]).toBeUndefined();
    expect(manifest.devDependencies["driver.js"]).toBe("1.8.0");
  });

  it("uses one production engine and only assessed existing frontend dependencies", () => {
    const directory = __dirname;
    const imports = new Map<string, string[]>();
    const files = readdirSync(directory).filter(file => file.includes("cloud-tutorial")
      && /\.tsx?$/.test(file) && !file.includes(".test."));
    expect(files).toContain("cloud-tutorial-adapter.tsx");
    for (const file of files) {
      const source = ts.createSourceFile(file, readFileSync(resolve(directory, file), "utf8"), ts.ScriptTarget.Latest, true);
      const modules: string[] = [];
      const visit = (node: ts.Node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
          && ts.isStringLiteral(node.moduleSpecifier)) modules.push(node.moduleSpecifier.text);
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
          && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) modules.push(node.arguments[0].text);
        ts.forEachChild(node, visit);
      };
      visit(source);
      imports.set(file, modules);
      for (const module of modules) {
        if (module.startsWith(".") || module.startsWith("@/")) continue;
        // Both internal modules expose the existing deterministic lesson/public
        // recovery contract; this adds no frontend engine or external library.
        expect(module, `Unassessed tutorial dependency in ${file}`).toMatch(/^(?:react|react-joyride|motion\/react|@papercusp\/operator-core\/lib\/onboarding\/cloud-tutorial-(?:lesson|help))$/);
      }
    }
    expect(imports.get("cloud-tutorial-adapter.tsx")).toEqual(["react", "react-joyride"]);
  });
});

const cloudBoundary = vi.hoisted(() => ({ mutate: vi.fn(), invalidate: vi.fn() }));
// Only the authenticated data boundary is substituted; page, forms, Radix controls,
// URL state and routing use the maintained application implementations.
vi.mock("@papercusp/sync", () => ({
  useSyncQuery: () => ({ data: [], loading: false, fetching: false, error: null, invalidate: cloudBoundary.invalidate }),
  useSyncMutate: () => cloudBoundary.mutate,
  planChunks: vi.fn(),
}));

// The alternative stays test-only. The production adapter has one engine.
function JoyrideCandidate({ target, active }: { target: string; active: boolean }) {
  return <Joyride run={active} stepIndex={0} steps={[{
    target, content: "Use the real app control", skipBeacon: true,
    disableFocusTrap: true, blockTargetInteraction: false, skipScroll: true,
    targetWaitTimeout: 2000,
  }]} options={{ dismissKeyAction: false, overlayClickAction: false, scrollDuration: 0 }} />;
}

// Rejected candidate retained only for comparative evidence, using its public API.
function DriverCandidate({ target, active }: { target: string; active: boolean }) {
  useEffect(() => {
    if (!active) return;
    const highlight = driver({ animate: false, allowKeyboardControl: false,
      disableActiveInteraction: false, advanceOnClick: false, smoothScroll: false });
    let current: Element | null = null;
    const observe = () => {
      const next = document.querySelector(target);
      if (next === current) return;
      if (current) highlight.destroy();
      current = next;
      if (next) highlight.highlight({ element: next });
    };
    const observer = new MutationObserver(observe);
    observer.observe(document.body, { childList: true, subtree: true });
    observe();
    return () => { observer.disconnect(); highlight.destroy(); };
  }, [target, active]);
  return null;
}

beforeEach(() => {
  cloudBoundary.mutate.mockReset().mockResolvedValue({ ok: true });
  cloudBoundary.invalidate.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() })));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 20, y: 20, top: 20, left: 20, width: 200, height: 40, right: 220, bottom: 60, toJSON: () => ({}) });
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body });
  Element.prototype.scrollIntoView = vi.fn();
  window.scrollTo = vi.fn();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each(["driver", "joyride"] as const)("%s on the maintained React/TanStack controls", (candidate) => {
  function Fixture() {
    const [active, setActive] = useState(true);
    const [late, setLate] = useState(false);
    const [open, setOpen] = useState(false);
    const [saved, setSaved] = useState(false);
    const [target, setTarget] = useState("[data-tutorial-target='late']");
    return <>
      <Button onClick={() => setLate(true)}>Mount target</Button>
      <Button onClick={() => setActive(false)}>Exit guide</Button>
      <Button onClick={() => { setOpen(true); setTarget("[data-tutorial-target='dialog']"); }}>Open app dialog</Button>
      {late && <label>Workspace name<input data-tutorial-target="late" /></label>}
      <Modal title="Workspace configuration" open={open} onOpenChange={setOpen}>
        <label>Machine size<input data-tutorial-target="dialog" /></label>
        <Button onClick={() => setSaved(true)}>Save configuration</Button>
      </Modal>
      {saved && <p>Saved by product action</p>}
      {candidate === "driver" ? <DriverCandidate target={target} active={active} /> : <JoyrideCandidate target={target} active={active} />}
    </>;
  }
  function mount() {
    const root = createRootRoute({
      component: () => <main><Outlet /></main>,
      errorComponent: ({ error }) => <p role="alert">Candidate fixture failed: {error.message}</p>,
    });
    const cloud = createRoute({ getParentRoute: () => root, path: "/cloud", component: Fixture });
    const other = createRoute({ getParentRoute: () => root, path: "/other", component: () => <h1>Other app view</h1> });
    const router = createRouter({ routeTree: root.addChildren([cloud, other]), history: createMemoryHistory({ initialEntries: ["/cloud"] }) });
    const view = render(<StrictMode><RouterProvider router={router} /></StrictMode>);
    return { ...view, router };
  }
  it("observes a late target without operating the product form, then permits user input", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Mount target" }));
    const input = await screen.findByRole("textbox", { name: "Workspace name" });
    await waitFor(() => expect(document.querySelector(candidate === "driver" ? ".driver-active-element" : "[data-testid='spotlight']")).not.toBeNull());
    input.focus();
    fireEvent.change(input, { target: { value: "my workspace" } });
    expect(input).toHaveProperty("value", "my workspace");
    expect(document.activeElement).toBe(input);
    expect(screen.queryByText("Saved by product action")).toBeNull();
  });
  it("keeps the real nested dialog operable and cleans overlays on route exit", async () => {
    const { router } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Open app dialog" }));
    const input = await screen.findByRole("textbox", { name: "Machine size" });
    input.focus();
    fireEvent.change(input, { target: { value: "small" } });
    expect(document.activeElement).toBe(input);
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    expect(await screen.findByText("Saved by product action")).toBeTruthy();
    await act(async () => { await router.navigate({ to: "/other" }); });
    expect(await screen.findByRole("heading", { name: "Other app view" })).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".driver-overlay, .react-joyride__overlay")).toBeNull());
    expect(document.body.classList.contains("driver-active")).toBe(false);
  });
  it("removes overlays when paused and remounts just one overlay on replay in StrictMode", async () => {
    const view = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Mount target" }));
    const selector = candidate === "driver" ? ".driver-overlay" : ".react-joyride__overlay";
    await waitFor(() => expect(document.querySelectorAll(selector)).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Exit guide" }));
    await waitFor(() => expect(document.querySelectorAll(selector)).toHaveLength(0));
    view.unmount();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Mount target" }));
    await waitFor(() => expect(document.querySelectorAll(selector)).toHaveLength(1));
  });

  it("observes the actual Cloud connection form through the app's nuqs/TanStack adapter", async () => {
    function ActualCloud() {
      const [active, setActive] = useState(true);
      const target = "input[aria-label='Connection label']";
      return <>
        <Button onClick={() => setActive(false)}>Pause prototype</Button>
        <CloudWorkspacesPage />
        {candidate === "driver"
          ? <DriverCandidate target={target} active={active} />
          : <JoyrideCandidate target={target} active={active} />}
      </>;
    }
    const root = createRootRoute({ component: () => <NuqsAdapter><main><Outlet /></main></NuqsAdapter> });
    const cloud = createRoute({ getParentRoute: () => root, path: "/cloud-workspaces", component: ActualCloud });
    const router = createRouter({ routeTree: root.addChildren([cloud]), history: createMemoryHistory({ initialEntries: ["/cloud-workspaces"] }) });
    render(<StrictMode><RouterProvider router={router} /></StrictMode>);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Google Cloud" }));
    const input = await screen.findByRole("textbox", { name: "Connection label" });
    await waitFor(() => expect(document.querySelector(candidate === "driver" ? ".driver-active-element" : "[data-testid='spotlight']")).not.toBeNull());
    input.focus();
    fireEvent.change(input, { target: { value: "tutorial-gcp" } });
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(input).toHaveProperty("value", "tutorial-gcp");
    expect(document.activeElement).toBe(input);
    expect(cloudBoundary.mutate).not.toHaveBeenCalled();
    // URL selection comes from the real product action, never the highlight adapter.
    await waitFor(() => expect(router.state.location.search).toMatchObject({ connect: "gcp" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause prototype" }));
    await waitFor(() => expect(document.querySelector(".driver-overlay, .react-joyride__overlay")).toBeNull());
    expect(screen.getByRole("textbox", { name: "Connection label" })).toBe(input);
  });
});

describe("Selected nonmodal Joyride highlight lifecycle", () => {
  it("honors reduced motion, preserves focus, passes pointer events through and ignores navigation keys", async () => {
    const view = render(<><Button>Guide trigger</Button><input aria-label="Product target" data-tutorial-target="focus" /></>);
    const trigger = screen.getByRole("button", { name: "Guide trigger" });
    trigger.focus();
    view.rerender(<><Button>Guide trigger</Button><input aria-label="Product target" data-tutorial-target="focus" /><CloudTutorialHighlight target="[data-tutorial-target='focus']" active contextKey="workspace-a" reducedMotion /></>);
    await waitFor(() => expect(document.querySelector(".react-joyride__overlay")).not.toBeNull());
    const overlayPath = document.querySelector<SVGElement>(".react-joyride__overlay path")!;
    expect(getComputedStyle(overlayPath).pointerEvents).toBe("none");
    expect(getComputedStyle(overlayPath).transition).toBe("none");
    expect(document.querySelector("[role='dialog']")).toBeNull();
    const input = screen.getByRole("textbox", { name: "Product target" });
    input.focus();
    for (const key of ["ArrowRight", "ArrowLeft", "Escape", "Tab"]) expect(fireEvent.keyDown(input, { key, cancelable: true })).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(document.querySelector(".react-joyride__spotlight")).not.toBeNull();
    view.rerender(<><Button>Guide trigger</Button><input aria-label="Product target" data-tutorial-target="focus" /></>);
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector(".react-joyride__overlay")).toBeNull();
  });

  it("reports missing targets and can recover when the target later mounts", async () => {
    const status = vi.fn();
    const view = render(<CloudTutorialHighlight target="[data-tutorial-target='late-recovery']" active contextKey="workspace-a" reducedMotion onStatus={status} />);
    expect(status).toHaveBeenLastCalledWith("waiting");
    await waitFor(() => expect(status).toHaveBeenLastCalledWith("missing"), { timeout: 2500 });
    view.rerender(<><input data-tutorial-target="late-recovery" /><CloudTutorialHighlight target="[data-tutorial-target='late-recovery']" active contextKey="workspace-a" reducedMotion onStatus={status} /></>);
    await waitFor(() => expect(status).toHaveBeenLastCalledWith("ready"));
    await waitFor(() => expect(document.querySelector(".react-joyride__spotlight")).not.toBeNull());
    view.unmount();
    const countAtExit = status.mock.calls.length;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1600)); });
    expect(status).toHaveBeenCalledTimes(countAtExit);
    expect(document.querySelector(".react-joyride__overlay")).toBeNull();
  });

  it("characterizes Driver's unsupported nonmodal Tab behavior before rejecting that engine", async () => {
    render(<><input data-tutorial-target="rejected-driver" /><DriverCandidate target="[data-tutorial-target='rejected-driver']" active /></>);
    await waitFor(() => expect(document.querySelector(".driver-overlay")).not.toBeNull());
    const input = screen.getByRole("textbox");
    input.focus();
    expect(fireEvent.keyDown(input, { key: "Tab", cancelable: true })).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it("restarts missing-target recovery after a previously ready control unmounts", async () => {
    const status = vi.fn();
    const view = render(<><span><input data-tutorial-target="removed" /></span><CloudTutorialHighlight target="[data-tutorial-target='removed']" active contextKey="workspace-a" onStatus={status} /></>);
    await waitFor(() => expect(status).toHaveBeenLastCalledWith("ready"));
    view.rerender(<><span /><CloudTutorialHighlight target="[data-tutorial-target='removed']" active contextKey="workspace-a" onStatus={status} /></>);
    await waitFor(() => expect(status).toHaveBeenLastCalledWith("missing"), { timeout: 2500 });
    expect(document.querySelector(".react-joyride__overlay")).toBeNull();
  });
});
