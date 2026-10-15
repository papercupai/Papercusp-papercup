# Slack setup — Cupboard package, bug triage, and report-bug gestures
URL: /internal/docs/reference/slack-external-trigger-setup

Install the Slack package from the Cupboard and connect it on Settings → Integrations, turn Slack bug reports and the report-bug gestures (shortcut, :bug: reaction, bug mention) into tickets with the Bug triage trigger pack, optionally add organization-wide history and live search, and check that it works.

## What this installs

Slack connects through the **Slack** package from the Cupboard (`libs/papercusp/plugins/slack`, published as `Papercusp/papercusp-slack`). It uses Slack Socket Mode: the host makes an outbound WebSocket connection and exposes no public webhook, acknowledges each envelope immediately, and deduplicates deliveries by Slack `event_id`. Messages arrive as provider-neutral `chat-message` records and `ext:slack:<event>` events. The same package handles the Slack report-bug gestures (the **Report a bug** shortcut, a :bug: reaction and a bug mention), and an organization-wide source can also bring in channel history and live search.

Turning Slack messages into tickets is a separate package, the **Bug triage** trigger pack (`libs/papercusp/plugins/bug-triage`). It reads `chat-message` events from the channels you pick and files the ones that report a software bug as tickets in the project you pick, through an installed ticket provider (Asana or Linear). It also files every message someone reports with one of the gestures.

## Connect Slack from the Cupboard

1. Open the **Cupboard**, find **Slack**, and install it. The install review lists what the package may reach (`slack.com` only) and asks for your consent.
2. Go to **Settings → Integrations** and open the **Slack** card. Choose **Create app**: Slack opens with the package's app definition filled in (Socket Mode, the `/papercusp` command, the **Report a bug** message shortcut, the message, mention and reaction events, and only the scopes those need). If the link cannot open, copy the definition from the card and paste it into **Create New App → From a manifest**.
3. Install the app to your Slack workspace. Under **Basic Information → App-Level Tokens**, generate an app-level token with `connections:write`; it starts with `xapp-`. Copy the bot token from **OAuth & Permissions**; it starts with `xoxb-`.
4. Paste both tokens into the card's masked fields and connect. Each value is checked against the format the package declares before it is saved. Tokens are stored host-side, are never shown again, and are never given to the package; the host attaches the bot token only to requests for `slack.com`.
5. Invite the bot to every channel it should read.

⚠ Connect each Slack app once. Slack spreads one app's events across all of its open Socket Mode connections, so connecting the same app to two sources splits the traffic between them and each sees only part of it.

## Turn Slack bug reports into tickets

1. Install and connect a ticket provider (**Asana** or **Linear**) from the Cupboard if you have not already.
2. Install **Bug triage** from the Cupboard. Installing does not turn it on.
3. On **Settings → Integrations**, open the **Bug triage** section, choose the project, then pick the channels to watch and where to file bugs. Both are pickers filled from the connected providers; nothing is typed.
4. Review the bindings, which start disarmed, and arm them. There are four: messages posted in the watched channels, the :bug: reaction, the **Report a bug** shortcut, and a bug mention.

A bug report posted in a watched channel becomes one ticket at the chosen destination. Other messages file nothing. The destination is fixed by the installation, so a message cannot redirect a ticket.

## Report a bug from Slack

Each of these files the message as one ticket at the installation's destination, quoting it, without asking whether it is a bug:

* **Report a bug shortcut**: on a message, open the message menu and choose **Report a bug**. A short form opens in Slack where you can add a note; submitting it files the message.
* **:bug: reaction**: react to the message with :bug:.
* **Bug mention**: mention the app followed by `bug` (for example `@Papercusp bug` or `@Papercusp report this bug`). In a thread, the mention files the message it replies to, plus anything you add.

A message outside the watched channels is not filed. A bug mention is not also triaged as an ordinary message.

Known issue: reacting with :bug: to a message that triage already filed can file a second ticket (WI-6554700010008873).

## Organization-wide history and live search

Both are optional switches on the Slack card.

* **Organization-wide**: the source brings in the history of every channel the app is in, thread replies included. Each channel's readers are exactly its current Slack members, so a message is readable only by people in its channel. History arrives as `history` records, so workflows bound to new messages do not fire on old ones.
* **Live search**: searches Slack directly for the person searching. Each person pastes their own user token (`xoxp-…`, from **OAuth & Permissions → User OAuth Token**). It is theirs alone and is sent to `slack.com` only for their searches. Slack decides what they can see, and nothing is stored.

## Check that it works

* The Slack card shows the connection as connected. A bad or revoked token shows an error on the card instead.
* Post a bug report in a watched channel: one `ext:slack:message` delivery, one run of the bug-triage binding, and one ticket at the destination. Replaying the same Slack `event_id` neither launches again nor files a second ticket.
* Use **Report a bug** on a message in a watched channel: one `ext:slack:report` delivery and one ticket at the destination.
* `ext:slack:<event>` keys are awaitable (`events:catalog`, family `external-trigger`), so an acceptance check can wait on the event instead of polling.

Slack protocol references: [https://docs.slack.dev/apis/events-api/using-socket-mode/](https://docs.slack.dev/apis/events-api/using-socket-mode/) · [https://docs.slack.dev/reference/app-manifest/](https://docs.slack.dev/reference/app-manifest/) · [https://docs.slack.dev/reference/methods/conversations.history/](https://docs.slack.dev/reference/methods/conversations.history/) · [https://docs.slack.dev/apis/web-api/rate-limits/](https://docs.slack.dev/apis/web-api/rate-limits/)

## Support, freshness and recovery

Papercusp maintains the Slack package and host integration. The workspace administrator owns app installation, Slack scopes, token renewal, channel membership and identity mapping. Organization reads use `source-acl`; stored corpus reads also require the reader's mapped identity and corpus grant. A channel access change takes effect after a successful membership refresh, which unfinished backfill or provider backoff can delay. Live search uses the searching person's own Slack token and current Slack access; revoking their identity mapping prevents that search. Read access never grants permission to post: `chat.reply` also requires its applicable write policy and Slack's `chat:write` scope.

While connected, the socket delivers edits and deletions. After an outage, each successful sync round rotates a seven-day scan across known channels. Whole-history re-walks rotate about once every 30 days, covering older posts and threads. Recovery depends on completing those paginated scans; throttling, missing scopes and an offline host extend the lag. A recent successful pass alone does not certify complete backfill or immediate source revocation.

Authorized administrators can inspect the shared `/admin/triggers` snapshot, also used by `triggers:list` and `triggers:status`. Source fields include `scope`, `scopeRef`, `permissionMode`, `backfillStatus`, `lastSyncAt`, `nextAttemptAt`, `failureCount`, `status` and `lastError`. `lastSyncAt` records a successful driver pass, including a pass with more pages remaining; read it with `backfillStatus`. A null value means no successful driver pass is recorded. The projection includes the policy mode without expanding ACLs or credentials.

* `rate_limited`: honor `nextAttemptAt` and Slack's `Retry-After`. The driver keeps the uncommitted cursor and resumes it after backoff.
* `reconnect_required`: restore the revoked token or missing Slack scope, then reconnect on Settings → Integrations. The source remains in error without automatic retries until reconnected.
* After recovery, verify a new successful pass, cleared error/failure count, completed backfill, and a scoped read as the affected person.

The maintained package support contract in `libs/papercusp/plugins/slack/README.md` describes version 0.2.0. Internal stand-in Slack acceptance demonstrates the host/package paths; customer-tenant and packaged-release qualification remain separate. Private network reachability does not apply to this package's `slack.com`-only egress.
