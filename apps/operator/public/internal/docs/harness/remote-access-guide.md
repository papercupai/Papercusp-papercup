# Remote access: a user guide
URL: /internal/docs/harness/remote-access-guide

App and device access, full personal-computer terminal and browser GUI connections, managed process flow, SSH trust, relay consent, revocation and offline behavior.

Remote access lets apps that run somewhere else call this workspace: another server, a laptop on
another network, a CI job, a chat product such as Claude.ai or ChatGPT, or a provider that sends
webhooks. Everything is managed on one screen, **Settings → Remote access**, on the computer that
runs Papercusp. For the developer side (keys, curl, MCP and TypeScript examples), see the
[External-app quickstart](/internal/docs/harness/external-app-quickstart).

## 1. The on/off switch

The top of the screen shows the workspace's **Remote access** switch.

* **Turn off now** is the instant kill switch. While it is off, every connected app, service key
  and OAuth client of the workspace is refused (`403 remote_access_off`), and so is every signed
  webhook. Paired phones are not affected.
* **Turn on** restores access. Keys you did not revoke work again with the scopes they had.

Turning it off does not delete or change any key.

## 2. How outside apps reach this computer

A workspace hosted by Papercusp is already reachable through the Papercusp portal. For Papercusp
running on your own computer, pick one of two routes.

### Your own tunnel (the default)

A tunnel gives your computer a public HTTPS address without opening ports on your router. The
**Your own tunnel** card, also a step of the setup wizard, sets one up:

* **Cloudflare**: sign in to Cloudflare once (or paste an API token) and choose a hostname on a
  domain you have there. Papercusp creates the tunnel and its DNS record, downloads `cloudflared`
  and keeps it running. **Stop the tunnel** and **Change the tunnel** are on the same card.
* **Manual** (Tailscale Funnel, ngrok or similar): Papercusp opens its external-ingress listener
  and you run the tunnel yourself.

Either way, the tunnel must point at the external-ingress port (`PAPERCUSP_EXTERNAL_INGRESS_PORT`),
never at the app's own port such as `:3070`, and must pass the original `Host` header through
unchanged. The external-ingress listener serves only three things:

| Path                                       | Used for                        |
| ------------------------------------------ | ------------------------------- |
| `/api/mcp` and its OAuth sign-in endpoints | MCP clients and chat connectors |
| `/api/hooks/<sourceId>`                    | signed webhooks                 |

Every other path answers `404 not_served_on_external_ingress`. The rest of the app, including
its settings and plain-HTTP tool routes, is never exposed through the tunnel, so over a tunnel
apps call tools through MCP. Sign-in with a code (see section 3) is not served there either, nor
through the relay: an app that uses it must reach the computer's own address.

### The Papercusp relay (opt-in)

If you cannot run a tunnel, the **Papercusp relay** card links this computer to the Papercusp
portal. Apps then use the same address as a hosted workspace,
`https://<portal>/api/workspaces/<workspaceId>`.

1. Read the notice and accept it. **Traffic to this computer passes through Papercusp servers**
   and is readable there. You are asked again when the notice changes.
2. Click **Connect this computer**. The card shows a link and a code. Open the link, sign in to the portal and
   approve the code.
3. The card shows the relay as connected, with the app address and MCP URL.

Relay limits for each linked computer:

| Limit     | Value                     | When exceeded                           |
| --------- | ------------------------- | --------------------------------------- |
| Requests  | 600 per minute            | `429 rate_limited`, `retry-after: 60`   |
| Bandwidth | 10 GiB per calendar month | `429 rate_limited` until the next month |

You get an alert as usage approaches either limit and again when it is reached.

When this computer is off, asleep or disconnected, the portal answers `503 workspace_offline`
with `retry-after: 30`. Nothing is queued: the app retries later.

## 3. Apps and devices

**Apps and devices** lists every paired phone, app key and service key, with who created it and
when it was last used. For each key:

* **Pause** stops it working until you **Resume** it. Nothing else changes.
* **Rotate** issues a new secret. The old one keeps working for an overlap window (one day by
  default) so the app can switch without downtime.
* **Revoke** ends it permanently. A revoked key refuses every secret it ever had, including one
  still inside a rotation overlap.

### Connecting an app

**Connect an app** asks how the app reaches this computer and offers three choices:

* **Claude.ai or ChatGPT, as a connector.** Copy the connector URL (the MCP URL) into Claude.ai
  (Settings → Connectors → Add custom connector) or ChatGPT (Settings → Connectors → Create). The
  chat product then sends you back to this computer to approve what it may do (OAuth). This needs
  a route from the internet first: your own tunnel or the relay.
* **An app that signs in with a code.** The app shows you a short code. This choice lists the
  waiting sign-ins; approve the matching code and the app receives its key.
* **A script or service.** Create a key (`pcapp_…`) and choose what it may use. The key is shown
  **once**, together with a ready curl line and an MCP configuration.

Keys are default-deny. A key reaches only what its scope lists: blueprint operations
(`blueprint:*`) and any exact tools you choose. Shell, file, process, credential, admin and
agent-spawn tools can never be granted to an app.

### Service keys

A service key is for an unattended app, such as a server job:

* It needs a **spending cap**. When the key's recorded LLM spend reaches the cap, new LLM work is
  refused (`spend_cap_reached`) until you raise the cap or its window resets.
* It does not expire unless you give it an expiry.
* It keeps working after the person who created it leaves the organization.
* It can use OAuth client credentials: the app exchanges the key for short-lived access tokens
  (`pcat_…`, one hour by default) and sends those instead.

## 4. Activity, spend and alerts

Open a key's activity to see its recorded spend and its recent calls.

Papercusp raises an owner alert, once per condition, when:

| Alert                     | Condition                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Spend near cap            | a key has used 80% of its spending cap                                                                         |
| Spend cap reached         | a key has reached its cap                                                                                      |
| Usage spike               | calls in the last hour reach at least 200 and at least ten times the key's average hour over the previous week |
| Repeated sign-in failures | 10 or more refused uses of a key within the current and previous hour                                          |
| Key expiring              | a key expires within 7 days                                                                                    |
| Creator removed           | the person who created the key is no longer an active member of the organization                               |
| Relay limit               | this computer's relay usage nears or reaches a limit in section 2                                              |

The spend alerts are raised when the key is used. The others come from a sweep that runs every 15
minutes.

## 5. Webhooks

A provider (a payment processor, a form service, a CI system) can start a blueprint operation by
posting to a webhook. Each webhook has its own URL and signing key:

* Through your own tunnel: `https://<your-tunnel>/api/hooks/<sourceId>`
* Through the portal or the relay: `https://<portal>/api/workspaces/<workspaceId>/hooks/<sourceId>`

Every delivery must carry a `papercusp-signature` header (`t=<unix seconds>,v1=<hex>`, where the
hex is an HMAC-SHA256 of `<t>.<raw body>` under the signing key). Unsigned, stale (more than five
minutes old) or wrongly signed deliveries are refused with `401 signature_invalid` and nothing is
recorded. Rotating a webhook's signing key keeps the previous key valid for an overlap window. The
signing key is shown once, when the webhook is created. The quickstart has a signing example.

## 6. If something does not work

| Response                             | Meaning                                                           |
| ------------------------------------ | ----------------------------------------------------------------- |
| `403 remote_access_off`              | The switch in section 1 is off.                                   |
| `401 app_key_required`               | The app sent an owner or admin sign-in; apps must use an app key. |
| `404 not_served_on_external_ingress` | The app called a non-MCP path through your own tunnel; use MCP.   |
| `429 rate_limited`                   | A relay limit in section 2 was reached.                           |
| `503 workspace_offline`              | The relay cannot reach this computer; retry later.                |
| `spend_cap_reached`                  | The key's spending cap was reached.                               |

## 7. Full remote terminal and browser GUI

External-app keys and the scoped relay above do not provide full GUI or shell access. The machine control beside workspace selection in the portal and local GUI offers Connect your computer for the private SSH path. Use a utility version that includes the personal SSH profile options below.

For a complete remote terminal and GUI session, use a customer-owned computer and its OpenSSH trust boundary. Enable SSH there, authorize your public key, install Papercusp and tmux, and make the operator listen on loopback port 3070. Verify the host key and add an SSH alias or private/VPN address locally:

`psu --connect-add-ssh=my-computer --connect-host=my-computer`

Use `psu --connect=my-computer` for a remote psu session. The front controller chooses the machine before the remote launch choices, forwards the remaining argv unchanged, and runs the remote process in a reattachable tmux session. Use `psu --connect=my-computer --connect-gui` for the browser GUI; it forwards 127.0.0.1:3070 to a local port, checks the operator health endpoint, opens the browser, and keeps the tunnel until you press Enter or interrupt. The SSH host key, identity and authorization remain OpenSSH policy. Removing the saved profile forgets it locally; revoke the SSH key on the remote computer to remove access. An offline host or refused key cannot open a terminal or browser.

This is full computer access. It is separate from an external-app MCP key and from the scoped hosted relay. The browser tunnel is local-only and does not publish the GUI.

### Local, managed and BYOC machines

Local psu stays on this computer. A Papercusp cloud sign-in lists workspaces for that account and organization. For your own cloud machine, saved GCP IAP and AWS SSM profiles use customer-controlled OpenSSH tunnels with host-key verification. Personal SSH profiles use an SSH config alias or reachable private/VPN address. Your SSH config may specify a user, port and identity. Machine choice precedes remote launch context; subsequent argv is forwarded, with the connection picker suppressed on the remote psu.

An external-app pairing code does not authorize a full shell. BYOC content must use an authorized sealed channel or customer-controlled ingress. The managed cloud terminal must never be treated as evidence that an unsealed BYOC relay works.

### What runs where

For a personal SSH connection, the laptop terminal runs the local front controller; OpenSSH reaches the customer computer; the remote tmux session runs psu; psu starts the customer-account agent in its workspace; the agent reads the selected context and sends model requests through the configured provider account. Only the credentials authorized on that computer are used. A hosted relay adds the portal connector and its ticket before the host supervisor starts psu. The relay is a transport boundary, not a replacement for the host's identity or workspace authorization.

```mermaid
sequenceDiagram
  participant L as Laptop psu front controller
  participant P as Portal ticket and connector relay
  participant H as Host psu supervisor
  participant A as Customer-account agent
  participant O as Workspace operator
  participant M as Model provider
  L->>P: Account-scoped token and selected workspace
  P-->>L: Single-use terminal ticket
  L->>P: Attach with ticket
  P->>H: psu channel and allowlisted argv
  H->>A: Launch with customer identity and workspace cwd
  A->>O: Retrieve context and call authorized tools
  A->>M: Model requests using configured account route
  M-->>A: Model replies
  A-->>H: Terminal output
  H-->>P: Connector output
  P-->>L: Output; keyboard input travels in reverse
```

The laptop keeps its portal CLI token. The host starts psu as its supervisor, then uses the customer identity wrapper to start the agent in the workspace directory. The agent does not receive arbitrary service credentials or a service-user shell. Context and tool calls belong to the selected remote workspace; model-provider authentication uses that agent's configured account route. For a personal machine, SSH replaces the portal relay and uses the remote account you approved.

After the last terminal channel detaches, the host retains the managed terminal for 15 minutes after detachment by default, then ends that terminal. A host may configure a different idle window. Reconnecting before expiry attaches to the retained session; a reboot, process exit or expired window can require a new session.

A managed reconnect obtains a fresh one-use ticket and reuses the hosted session key. Waiting for a dropped machine link has one bounded budget; failure names a resume command when a session was bound, and does not claim a session exists when none started. A personal connection uses remote tmux so the same profile and arguments can reattach. Closing the local browser tunnel does not terminate running agents.

The utility archive includes psu (the launcher) and pui (the terminal interface). The signup welcome requests one compatible published download, offers a manual retry, and lets you continue to the GUI. A requested download does not prove that a file was saved or installed. Unsupported or unpublished platforms show a fallback rather than success.
