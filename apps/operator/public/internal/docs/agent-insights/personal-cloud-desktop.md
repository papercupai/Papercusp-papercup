# Personal cloud desktop — a person's own desktop on their workspace machine
URL: /internal/docs/agent-insights/personal-cloud-desktop

What a personal cloud desktop is (scope 'user'), the account it runs as (papercusp-workspace, the customer account — not the papercusp-desktop sandbox user), who may open it, what the agent reaper does not do to it, its limits, and how to verify it end to end.

A **personal cloud desktop** is a person's own graphical desktop on their hosted (or BYOC) workspace machine. It is opened from the **Desktops** tab with **My desktop**, and it lands its owner in **Take control**. Plan: `personal-cloud-desktop-2026-10-06` (D-001 records the owner's choice and the identity decision).

It is a fourth desktop owner class beside agent, pot and the product's own workspace desktop: `harness_shared.desktop_sessions.scope = 'user'`, with `scope_ref` = the person's hosted userId (migration `1402-desktop-session-user-scope.sql`). The existing live-scope unique index keeps it to **one live personal desktop per person per workspace**.

## Identity: it runs as `papercusp-workspace`

A personal desktop runs as the **customer account `papercusp-workspace`**, with `HOME=/home/papercusp-workspace` — the same identity the person's hosted terminal already runs as, so their files are on the desktop. It does **not** run as `papercusp-desktop`, the isolated user that agent sandbox desktops use; sandbox desktops are unchanged.

The two classes are served by two separate D-363 socket workers installed by the desktop pack:

|                    | sandbox (agent / pot)                                  | personal (`user`)                                                                                                                      |
| ------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| socket             | `papercusp-desktop.socket`                             | `papercusp-personal-desktop.socket` → `/run/papercusp-personal-desktop/session.sock` (root:service-user, `0660`)                       |
| service            | `papercusp-desktop@.service`, `User=papercusp-desktop` | `papercusp-personal-desktop@.service`, `User=papercusp-workspace`, `BindsTo=papercusp-workspace.service`                               |
| worker mode        | default (sandbox)                                      | `session.cjs --personal`                                                                                                               |
| identity assertion | must be `papercusp-desktop`                            | `assertPersonalDesktopIdentity`: uid > 0, username `papercusp-workspace`, HOME `/home/papercusp-workspace`; refuses to start otherwise |
| X displays         | `:110`–`:209`                                          | `:210`–`:250`                                                                                                                          |
| state              | sandbox home                                           | `/home/papercusp-workspace/.local/state/papercusp-desktop`                                                                             |

The unit environment is discarded and rebuilt (`personalDesktopEnvironment`), so a credential set on the unit never reaches the session.

## How a start is routed

* The relay call is `desktop.start { personal: true }` on hosted-session-host. It always means **the caller's own** desktop; there is no way to name another person's.
* Operator side: `ensurePersonalDesktop(userId)` (`agent-tools/computer/desktop-lease.ts`) leases target `{ scope: 'user', userId }`. It is idempotent per user — a double click or a second tab returns the same lease and row.
* Provisioning routes by scope: `user` → `personal-socket` only; agent/pot → `sandbox-socket` (or `local`). A personal start never falls back to the sandbox worker.
* A host with no personal worker refuses with **`personal_desktop_unavailable`** before anything starts — no lease, no registry row.

## Who may see and open it

* **Open (watch or takeover)** and **thumbnail** of a `user` desktop by anyone other than its owner are refused with **`desktop_not_owner`**, and the refusal is audited as `operation_denied` naming the channel and operation. The KasmVNC control secret never leaves for a refused open.
* **Roster:** the desktop roster a person receives lists agent and pot desktops plus **only their own** personal desktop; other people's personal desktops are hidden (`hosted-desktop-backend.ts` `roster(viewer)`).
* An observer (watch-only member) cannot start one.

## What does NOT happen to it

* The agent idle reaper (`desktop-lifecycle.ts`) **refuses to govern** a `scope='user'` desktop: idle is the normal state of a desktop someone left open, so no agent idle clock freezes or kills it.
* It is not an agent sandbox and gets none of the sandbox's isolation from the person's own files — by design, since it is their seat.

## Limits

* One live personal desktop per person per workspace.
* Only machines whose desktop pack installed the personal worker can serve it (re-run the pack on older hosts).
* Personal displays are capped at the `:210`–`:250` range on a host.

## How to verify

1. **Tree:** `testing:run` over `packages/operator-core/lib/desktop/personal-desktop.test.ts`, `packages/operator-core/lib/workspace-host/hosted-session-host.personal-desktop.test.ts`, and the cloud-workspaces UI tests (`hosted-desktop-viewer-protocol.test.ts`, `HostedDesktopWorkspace.test.tsx`, `HostedWorkspaceSession.test.tsx`).
2. **Pack, on the host:** `systemctl is-active papercusp-personal-desktop.socket` and `stat -c '%U:%G %a' /run/papercusp-personal-desktop/session.sock` (expect root, the service group, `660`).
3. **Live, from the Desktops tab:** click **My desktop**; it opens in Take control. On the machine, the Xvnc process for the new display runs as `papercusp-workspace` (`ps -o user= -p <pid>`) and the desktop shows `/home/papercusp-workspace`. Reconnecting the viewer returns the **same** desktop session id and the same Xvnc pid. A second member's open of that desktop is refused with `desktop_not_owner`.

The live run for this plan is recorded at `docs/evidence/personal-cloud-desktop-2026-10-06/live-run.json` (P-006).
