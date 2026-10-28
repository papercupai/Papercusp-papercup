"use client";

import { parseAsString, useQueryStates } from "nuqs";
import { useEffect } from "react";
import { useSyncQuery } from "@papercusp/sync";
import { getBrowserMachineId, setBrowserMachineId } from "@papercusp/operator-core/lib/browser-workspace";
import { navigateClient } from "@papercusp/operator-core/lib/client-navigation";
import { Select } from "@/app/harness/Select";
import { Tooltip } from "@/app/harness/Tooltip";
import { LOCAL_DESKTOP_HOST } from "./local-desktop-protocol";
import type { CloudWorkspacesControlRow, WorkspaceHostControlRow } from "./workspace-view-model";
import { desktopMachineSelection, preferredDesktopWorkspace } from "./workspace-view-model";

export interface MachineSwitcherProps {
  localMode?: boolean;
  workspaceSelected?: boolean;
  onSelect?: (hostId: string) => void;
  connectHref?: string;
}

/** Both shells use the existing host inventory; the hosted SyncProvider applies tenant scope. */
export default function MachineSwitcher({ localMode = true, workspaceSelected = true, ...props }: MachineSwitcherProps) {
  if (!localMode && !workspaceSelected) {
    return <span><span role="status">Choose a workspace to connect a machine</span> <MachineConnectionHelp /></span>;
  }
  return <AuthorizedMachineSwitcher {...props} localMode={localMode} />;
}

function AuthorizedMachineSwitcher({ localMode, onSelect, connectHref }: MachineSwitcherProps) {
  const control = useSyncQuery<CloudWorkspacesControlRow>({ queryName: "workspaceHosts.control" });
  const [target, setTarget] = useQueryStates({
    desktopHost: parseAsString, host: parseAsString, desktop: parseAsString,
    desktopPins: parseAsString, desktopFilter: parseAsString,
  }, { history: "push" });
  const value = target.desktopHost ?? target.host ?? getBrowserMachineId() ?? null;
  const machines = (control.data ?? []).filter((row): row is WorkspaceHostControlRow =>
    row.kind === "workspace" && row.observedState !== "absent" && row.observedState !== "destroying");
  const defaultMachine = localMode ? LOCAL_DESKTOP_HOST : preferredDesktopWorkspace(machines)?.id ?? null;
  useEffect(() => {
    if (value !== null || control.loading || control.error || !defaultMachine) return;
    // The visible default must also route workspace reads and launches. This
    // establishes this window's context without an app or lifecycle action.
    setBrowserMachineId(defaultMachine);
    void setTarget(desktopMachineSelection(defaultMachine), { history: "replace" });
  }, [value, control.loading, control.error, defaultMachine, setTarget]);
  return <MachineSwitcherView
    localMode={localMode === true}
    value={value}
    rows={control.data ?? []}
    loading={control.loading}
    error={control.error?.message ?? null}
    connectHref={connectHref}
    onSelect={(hostId) => {
      setBrowserMachineId(hostId);
      // The viewer, pins and filter belong to the old machine. No shared registry
      // default or agent lifecycle is written; each window keeps its own URL.
      const selection = desktopMachineSelection(hostId);
      // Batch portal navigation with the target so surface-param isolation
      // never sees a target belonging to a different app.
      if (onSelect) {
        void setTarget(selection);
        onSelect(hostId);
      } else {
        // Commit target and route in one navigation. Pushing the target first
        // leaves an intermediate history entry that Back restores instead.
        const url = new URL(window.location.href);
        url.pathname = "/desktops";
        for (const [key, value] of Object.entries(selection)) {
          if (value === null) url.searchParams.delete(key);
          else url.searchParams.set(key, value);
        }
        // This changes the machine within the same workspace. Keep the shell
        // mounted; the navigation helper still reloads for a workspace change.
        navigateClient(url.toString());
      }
    }}
  />;
}

export function MachineSwitcherView({ localMode, value, rows, loading, error, onSelect,
  connectHref = "/cloud-workspaces?step=connect" }: {
  localMode: boolean;
  value: string | null;
  rows: CloudWorkspacesControlRow[];
  loading: boolean;
  error: string | null;
  onSelect: (hostId: string) => void;
  connectHref?: string;
}) {
  const machines = rows.filter((row): row is WorkspaceHostControlRow => row.kind === "workspace"
    && row.observedState !== "absent" && row.observedState !== "destroying");
  const selected = value ?? (localMode ? LOCAL_DESKTOP_HOST : preferredDesktopWorkspace(machines)?.id ?? "");
  const options = [
    ...(localMode ? [{ value: LOCAL_DESKTOP_HOST, label: "This computer" }] : []),
    ...machines.map((row) => ({ value: row.id, label: `${row.name} — ${row.observedState}` })),
  ];
  const missing = selected !== "" && !options.some((option) => option.value === selected);
  if (missing) options.push({ value: selected, label: "Machine unavailable" });
  return <span role="group" aria-label="Machine selection" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
    <Select ariaLabel="Machine" value={selected} options={options}
      placeholder={loading ? "Loading machines…" : "Choose a machine"}
      disabled={loading}
      onChange={(hostId) => {
        if (options.some((option) => option.value === hostId) && !(missing && hostId === selected)) onSelect(hostId);
      }} />
    <MachineConnectionHelp />
    <a href={connectHref}>Manage machines</a>
    {error ? <span role="alert">Machines unavailable: {error}</span> : null}
    {missing && !error ? <span role="status">Choose another machine</span> : null}
  </span>;
}

/** Both shells lead to the same connection choices and setup. */
function MachineConnectionHelp() {
  return <Tooltip label="Choose a connection method">
    <a href="/settings/remote-access#connect-computer">Connect your computer</a>
  </Tooltip>;
}
