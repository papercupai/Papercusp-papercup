"use client";

import { useMemo } from "react";
import { Monitor, RefreshCw } from "lucide-react";
import { parseAsString, useQueryStates } from "nuqs";
import { useSyncQuery } from "@papercusp/sync";
import { getBrowserMachineId, setBrowserMachineId } from "@papercusp/operator-core/lib/browser-workspace";
import { useOperatorWorkspaceLocation } from "@papercusp/operator-ui/seam";
import { Button } from "@/app/harness/Button";
import { Select } from "@/app/harness/Select";
import { HostedDesktopConnection } from "./HostedDesktopConnection";
import { LocalDesktopWorkspace } from "./LocalDesktopWorkspace";
import { LOCAL_DESKTOP_HOST } from "./local-desktop-protocol";
import { desktopMachineSelection, preferredDesktopWorkspace } from "./workspace-view-model";
import type {
  CloudWorkspacesControlRow,
  WorkspaceHostControlRow,
} from "./workspace-view-model";
import styles from "./hosted-workspace-session.module.css";

/** D-062 option B: Desktops is a workspace, not a selected cloud-management tab. */
export default function DesktopWorkspacePage() {
  const localMode = useOperatorWorkspaceLocation() === "local";
  const control = useSyncQuery<CloudWorkspacesControlRow>({
    queryName: "workspaceHosts.control",
  });
  const [target, setTarget] = useQueryStates({
    desktopHost: parseAsString, host: parseAsString, desktop: parseAsString,
    desktopPins: parseAsString, desktopFilter: parseAsString,
  }, { history: "push" });
  const requestedHost = target.desktopHost ?? target.host ?? getBrowserMachineId();
  const workspaces = useMemo(
    () =>
      (control.data ?? []).filter(
        (row): row is WorkspaceHostControlRow =>
          row.kind === "workspace" &&
          row.observedState !== "absent" &&
          row.observedState !== "destroying",
      ),
    [control.data],
  );
  // "This computer" is available only on a local host. An empty hosted inventory
  // (including a session with no selected workspace) grants no local machine.
  const showLocal =
    localMode &&
    (requestedHost === LOCAL_DESKTOP_HOST ||
      (!requestedHost && !control.loading && !control.error && workspaces.length === 0));
  // Preserve explicit deep links; a missing subject must not silently select another machine.
  const selected = showLocal
    ? undefined
    : requestedHost
      ? workspaces.find((row) => row.id === requestedHost)
      : preferredDesktopWorkspace(workspaces);

  return (
    <section
      className={styles.desktopDestination}
      aria-label="Desktop workspace"
    >
      <header className={styles.desktopDestinationHeader}>
        <h1>
          <Monitor size={20} aria-hidden="true" /> Desktops
        </h1>
        <div className={styles.desktopDestinationActions}>
          <Select
            ariaLabel="Desktop workspace"
            value={showLocal ? LOCAL_DESKTOP_HOST : (selected?.id ?? "")}
            placeholder="Choose a workspace"
            options={[
              ...(localMode
                ? [{ value: LOCAL_DESKTOP_HOST, label: "This computer" }]
                : []),
              ...workspaces.map((row) => ({
                value: row.id,
                label: row.name,
              })),
            ]}
            onChange={(value) => {
              setBrowserMachineId(value);
              void setTarget(desktopMachineSelection(value));
            }}
          />
          <Button
            variant="ghost"
            aria-label="Refresh desktop workspaces"
            disabled={control.loading || control.fetching}
            onClick={() => void control.invalidate?.()}
          >
            <RefreshCw size={16} aria-hidden="true" /> Refresh
          </Button>
        </div>
      </header>
      {showLocal ? (
        <LocalDesktopWorkspace />
      ) : control.loading ? (
        <div className={styles.desktopWorkspaceEmpty} role="status">
          <h2>Loading desktop workspaces…</h2>
        </div>
      ) : control.error ? (
        <div className={styles.desktopWorkspaceEmpty} role="alert">
          <h2>Workspaces could not be loaded</h2>
          <p>{control.error.message}</p>
        </div>
      ) : selected ? (
        <HostedDesktopConnection workspace={selected} />
      ) : (
        <div className={styles.desktopWorkspaceEmpty} role="status">
          <Monitor size={36} aria-hidden="true" />
          <h2>
            {requestedHost
              ? "Workspace unavailable"
              : "No desktop workspaces yet"}
          </h2>
          <p>
            {requestedHost
              ? "Choose another workspace to view its desktops."
              : "Your desktops will appear here when a workspace is available."}
          </p>
        </div>
      )}
    </section>
  );
}
