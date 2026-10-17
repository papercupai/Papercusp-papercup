"use client";

import { parseAsString, useQueryStates } from "nuqs";
import { useState } from "react";
import { useSyncQuery } from "@papercusp/sync";
import { getBrowserMachineId, setBrowserMachineId } from "@papercusp/operator-core/lib/browser-workspace";
import { Select } from "@/app/harness/Select";
import { Modal } from "@/app/harness/Modal";
import { Tooltip } from "@/app/harness/Tooltip";
import { LOCAL_DESKTOP_HOST } from "./local-desktop-protocol";
import type { CloudWorkspacesControlRow, WorkspaceHostControlRow } from "./workspace-view-model";
import { desktopMachineSelection, preferredDesktopWorkspace } from "./workspace-view-model";
import { normalizeSshProfile } from "../settings/remote-access/connection-inventory";

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
  return <MachineSwitcherView
    localMode={localMode === true}
    value={target.desktopHost ?? target.host ?? getBrowserMachineId() ?? null}
    rows={control.data ?? []}
    loading={control.loading}
    error={control.error?.message ?? null}
    connectHref={connectHref}
    onSelect={(hostId) => {
      setBrowserMachineId(hostId);
      // The viewer, pins and filter belong to the old machine. No shared registry
      // default or agent lifecycle is written; each window keeps its own URL.
      const updated = setTarget(desktopMachineSelection(hostId));
      // Batch portal navigation with the target so surface-param isolation
      // never sees a target belonging to a different app.
      if (onSelect) onSelect(hostId);
      else void updated.then(() => {
          const url = new URL(window.location.href);
          url.pathname = "/desktops";
          window.location.assign(url.toString());
      });
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
  const selected = value ?? preferredDesktopWorkspace(machines)?.id ?? (localMode ? LOCAL_DESKTOP_HOST : "");
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

/** Same personal-machine instructions in both shells; credentials stay with OpenSSH. */
function MachineConnectionHelp() {
  const [open, setOpen] = useState(false);
  const connection = normalizeSshProfile({ id: "local-ssh", label: "Connect your computer", scope: "Private network" });
  return <>
    <Tooltip label="SSH connection profile">
      <button type="button" data-connection-class={connection.class}
        onClick={() => setOpen(true)}>Connect your computer</button>
    </Tooltip>
    <Modal open={open} onOpenChange={setOpen} title="Connect your computer"
      contentStyle={{ maxWidth: 560, padding: 24, background: "var(--surface-1, #151922)" }}>
      <h2>Connect your computer</h2>
      <p data-testid="machine-connection-authority"><strong>{connection.authoritySummary}</strong> — this is the SSH profile path. The portal relay and phone pairing are managed separately under Remote access.</p>
      <p>Use the psu utility on this computer to reach a desktop or laptop over your private network or VPN.</p>
      <ol>
        <li>On the remote computer, enable SSH and approve your SSH public key. Install Papercusp and tmux there; its operator should listen on loopback port 3070.</li>
        <li>Verify its host key and configure an SSH alias such as <code>my-computer</code> with the address, user, port and identity you use to sign in.</li>
        <li>Save it locally: <code>psu --connect-add-ssh=my-computer --connect-host=my-computer</code></li>
      </ol>
      <p>Remote terminal: <code>psu --connect=my-computer</code>. Machine selection happens before the remote launch choices.</p>
      <p>Browser GUI: <code>psu --connect=my-computer --connect-gui</code>. Keep that terminal open while using the private browser tunnel.</p>
      <p>An offline computer or refused SSH key cannot connect. Forget a saved entry with <code>psu --connect-remove=my-computer</code>; revoke its SSH key on the remote computer to remove access. Forgetting an entry alone does not revoke that key or stop running agents.</p>
      <button type="button" onClick={() => setOpen(false)}>Close</button>
    </Modal>
  </>;
}
