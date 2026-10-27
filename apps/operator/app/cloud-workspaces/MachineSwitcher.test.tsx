// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withNuqsTestingAdapter } from "nuqs/adapters/testing";
import { parseAsString, useQueryState } from "nuqs";
import MachineSwitcher, { MachineSwitcherView } from "./MachineSwitcher";
import { getBrowserMachineId } from "@papercusp/operator-core/lib/browser-workspace";
import type { WorkspaceHostControlRow } from "./workspace-view-model";

const query = vi.hoisted(() => vi.fn());
vi.mock("@papercusp/sync", () => ({ useSyncQuery: query }));
vi.mock("@/app/harness/Select", () => ({
  Select: ({ value, options, onChange, ariaLabel, disabled, placeholder }: {
    value: string; options: { value: string; label: string }[];
    onChange: (value: string) => void; ariaLabel: string; disabled?: boolean; placeholder?: string;
  }) => <select aria-label={ariaLabel} value={value} disabled={disabled}
    onChange={(event) => onChange(event.target.value)}>
    <option value="">{placeholder}</option>
    {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>,
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); window.sessionStorage.clear(); });
const rows = [
  { kind: "workspace", id: "a", name: "Home desktop", observedState: "running" },
  { kind: "workspace", id: "b", name: "Laptop", observedState: "stopped" },
] as WorkspaceHostControlRow[];

describe("persistent machine selection", () => {
  it.each([true, false])("binds the visible default to request routing (localMode=%s) without moving apps", async (localMode) => {
    query.mockReturnValue({ data: rows, loading: false, error: null });
    const update = vi.fn();
    const onSelect = vi.fn();
    render(<MachineSwitcher localMode={localMode} onSelect={onSelect} />, {
      wrapper: withNuqsTestingAdapter({ searchParams: "?app=mail&ws=own", onUrlUpdate: update }),
    });
    const expected = localMode ? "local" : "a";
    await vi.waitFor(() => expect(getBrowserMachineId()).toBe(expected));
    await vi.waitFor(() => expect(update).toHaveBeenCalled());
    const params = update.mock.calls.at(-1)![0].searchParams as URLSearchParams;
    expect(params.get("desktopHost")).toBe(expected);
    expect(params.get("app")).toBe("mail");
    expect(params.get("ws")).toBe("own");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("preserves an explicitly selected remote machine in a local GUI", () => {
    query.mockReturnValue({ data: rows, loading: false, error: null });
    const update = vi.fn();
    render(<MachineSwitcher localMode onSelect={vi.fn()} />, {
      wrapper: withNuqsTestingAdapter({ searchParams: "?desktopHost=b&host=b", onUrlUpdate: update }),
    });
    expect((screen.getByRole("combobox", { name: "Machine" }) as HTMLSelectElement).value).toBe("b");
    expect(update).not.toHaveBeenCalled();
  });

  it("does not establish an implicit target from a refused inventory", () => {
    query.mockReturnValue({ data: rows, loading: false, error: new Error("denied") });
    const update = vi.fn();
    render(<MachineSwitcher onSelect={vi.fn()} />, {
      wrapper: withNuqsTestingAdapter({ searchParams: "?app=mail", onUrlUpdate: update }),
    });
    expect(getBrowserMachineId()).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it("uses the authorized inventory, shows availability and leaves missing selections explicit", () => {
    const onSelect = vi.fn();
    render(<MachineSwitcherView localMode={false} value="removed" rows={rows}
      loading={false} error={null} onSelect={onSelect} />);
    expect((screen.getByRole("combobox", { name: "Machine" }) as HTMLSelectElement).value).toBe("removed");
    expect(screen.getByRole("option", { name: "Machine unavailable" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Laptop — stopped" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "This computer" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "b" } });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("b");
  });

  it("keeps a new hosted account inert until it has an authorized workspace", () => {
    render(<MachineSwitcher localMode={false} workspaceSelected={false} />);
    expect(screen.getByRole("status").textContent).toContain("Choose a workspace");
    expect(query).not.toHaveBeenCalled();
  });

  it("does not claim a machine is connected when no inventory exists", () => {
    render(<MachineSwitcherView localMode={false} value={null} rows={[]}
      loading={false} error={null} onSelect={vi.fn()} />);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("");
    expect(screen.getByRole("link", { name: "Manage machines" }).getAttribute("href")).toBe("/cloud-workspaces?step=connect");
  });

  it("batches portal app navigation with the chosen machine", async () => {
    query.mockReturnValue({ data: rows, loading: false, error: null });
    const update = vi.fn();
    function Portal() {
      const [, setApp] = useQueryState("app", parseAsString);
      return <MachineSwitcher onSelect={() => { void setApp("desktops"); }} />;
    }
    render(<Portal />, { wrapper: withNuqsTestingAdapter({
      searchParams: "?app=mail&ws=own&desktopHost=a", onUrlUpdate: update,
    }) });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "b" } });
    await vi.waitFor(() => expect(update).toHaveBeenCalled());
    const transitions = update.mock.calls.map(([event]) => event.searchParams as URLSearchParams);
    expect(transitions.every((params) => params.get("app") === "desktops" && params.get("desktopHost") === "b")).toBe(true);
  });

  it("opens the shared Remote access setup without requiring a hosted workspace", async () => {
    render(<MachineSwitcher localMode={false} workspaceSelected={false} />);
    const help = screen.getByRole("link", { name: "Connect your computer" });
    expect(help.getAttribute("href")).toBe("/settings/remote-access#connect-computer");
    fireEvent.focus(help);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toBe("Choose a connection method");
    expect(help.getAttribute("aria-describedby")).toBe(tooltip.id);
    expect(query).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clears old machine desktop state only in the selecting window", async () => {
    query.mockReturnValue({ data: rows, loading: false, error: null });
    const update = vi.fn();
    const onSelect = vi.fn();
    render(<MachineSwitcher onSelect={onSelect} />, { wrapper: withNuqsTestingAdapter({
      searchParams: "?ws=own&desktopHost=a&host=a&desktop=watch:old&desktopPins=old&desktopFilter=old",
      onUrlUpdate: update,
    }) });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "b" } });
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledExactlyOnceWith("b"));
    await vi.waitFor(() => expect(update).toHaveBeenCalled());
    const params = update.mock.calls.at(-1)?.[0].searchParams as URLSearchParams;
    expect(params.get("desktopHost")).toBe("b");
    expect(params.get("host")).toBe("b");
    expect(params.get("ws")).toBe("own");
    expect(params.has("desktop")).toBe(false);
    expect(params.has("desktopPins")).toBe(false);
    expect(params.has("desktopFilter")).toBe(false);
  });
});
