# Authoring an integration provider and a trigger pack
URL: /internal/docs/plugins/provider-and-trigger-pack-authoring

How an outside author builds, type-checks, installs, connects, syncs and arms a sandboxed daemon provider plus a trigger pack, following the independent-author journey suite (an Outlook-shaped Graph provider): manifest, JSON-RPC daemon protocol, cursor and delivery identity, host.fetch trust model, consent, review and arm. Includes the Slack chat-provider and bug-triage trigger-pack worked example.

This guide walks an outside author through shipping an integration provider and a trigger pack for Papercusp. Every step below is exercised end to end by one test suite, `packages/operator-core/lib/integrations/independent-author-journey.integration.test.ts`. That suite builds an Outlook-shaped mail and calendar provider outside the source tree, installs it into a clean workspace, connects it through the real OAuth routes, syncs it, and fires its pack. The package it builds is `packages/operator-core/test/fixtures/outlook-graph-provider/`. Read that package next to this guide: it is the smallest complete example.

The first-party Gmail and Google Calendar providers (`libs/papercusp/plugins/gmail/`, `libs/papercusp/plugins/google-calendar/`) implement the same contract. They run in-process because they ship with Papercusp. A Cupboard-installed provider always runs as a sandboxed daemon.

## What you are building

One package can carry two things:

* **A provider.** It turns an external account (a mailbox, a calendar, a ticket tracker) into canonical records, such as `email-message` and `calendar-event`. It optionally serves write capabilities, such as `mail.draft`. Records land in the owner's Vault. Apps and workflows read them without knowing which provider produced them.
* **A trigger pack.** It ships workflows: plan targets plus the bindings that start them when a matching event arrives. A pack installs disarmed. Nothing runs until the owner reviews it and arms it.

A pack can depend on any provider that produces the datatype it binds to. It does not have to ship with one. The example ships both, so one install exercises both.

## The trust model

A provider never holds a credential and never opens a socket. These rules are enforced by the host, not by convention:

* **No tokens.** The daemon reaches the network only through `host.fetch`. The host checks the URL against the declared `egressHosts`, injects the access token for the one source the current call serves, and returns the response. No frame in either direction carries a token. The journey suite scans every frame to prove it.
* **No ambient network.** A Cupboard-installed provider must declare `runtime.kind: "daemon"`. The install refuses anything else with `provider_runtime_not_sandboxed`. The daemon runs under bubblewrap with no network namespace. When bubblewrap is unavailable it does not run at all; it never falls back to an unsandboxed process.
* **One account per call.** Each host call carries a `callToken` that is valid only while that call is in flight, and only for that call's `source`. A daemon cannot act for an account it was not called for.
* **Declared egress only.** A request to a host outside `egressHosts` is refused, and the sync cursor stops at the refused request instead of skipping past it.
* **Consent before install.** The owner pins the exact review of what the provider asks for (datatypes, capabilities, OAuth scopes and egress hosts) before anything is written.

## 1. Lay out the package

```
outlook-graph-provider/
  package.json        # your npm package; devDependencies only
  papercusp.json      # the manifest: plugin, provider descriptor, trigger pack
  daemon.mjs          # the provider daemon
  plan-reply.md       # a plan target the pack instantiates
  tsconfig.json       # type-checks daemon.mjs (checkJs)
```

Depend only on the SDK's provider contract, the service's own published types (the example uses `@microsoft/microsoft-graph-types`), and Node builtins. Import the contract from `@papercusp/plugin-sdk/provider`. That entry has no imports of its own, so it type-checks with nothing else installed; `packages/plugin-sdk/src/clean-install-types.test.ts` proves this in a directory holding only the SDK. The main entry `@papercusp/plugin-sdk` also carries the UI and tool-definition types. It needs `@types/react` (an optional peer) and compiles the private `@papercusp/tooldef` sources into your program, so a provider package should not import it. The example's `daemon.mjs` still imports the main entry, which type-checks only because the journey suite links a Papercusp checkout. The journey suite copies the package out of the tree, type-checks it there, and proves the check can fail on a planted drift. Your package should pass the same check on its own.

## 2. Write the manifest

`papercusp.json` declares the plugin, the provider and the pack:

```json
{
  "kind": "plugin",
  "name": "outlook-graph-provider",
  "version": "1.0.0",
  "papercusp": "^0.1.0",
  "runtime": { "kind": "daemon", "daemonCommand": ["node", "daemon.mjs"] },
  "provider": {
    "id": "outlook-graph",
    "contractVersion": 1,
    "displayName": "Outlook (Microsoft Graph)",
    "datatypes": ["email-message", "calendar-event"],
    "capabilities": ["mail.read", "calendar.read"],
    "egressHosts": ["graph.microsoft.com", "login.microsoftonline.com"],
    "oauth": {
      "authorizeUrl": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      "tokenUrl": "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      "scopes": ["offline_access", "Mail.Read", "Calendars.Read", "User.Read"],
      "pkce": true,
      "clientRegistrationRef": "microsoft",
      "identity": { "url": "https://graph.microsoft.com/v1.0/me", "idField": "id", "displayNameField": "userPrincipalName" }
    }
  },
  "triggerPack": { "...": "see section 5" }
}
```

The descriptor (`ProviderDescriptor` in `packages/plugin-sdk/src/provider.ts`) is validated on install:

| field                | rule                                                                                                                                                                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | lowercase, `^[a-z][a-z0-9-]{1,62}$`. It appears in provenance keys as `ext:<id>:<event>`. Never change it after release.                                                                                                                                                                                             |
| `contractVersion`    | must be a version the SDK lists in `PROVIDER_CONTRACT_VERSIONS` (currently `1`).                                                                                                                                                                                                                                     |
| `datatypes`          | canonical datatype ids. Every record `syncPage` returns must use one of them.                                                                                                                                                                                                                                        |
| `capabilities`       | `<domain>.<verb>`, such as `mail.read` or `calendar.write`. `invoke` accepts only these.                                                                                                                                                                                                                             |
| `egressHosts`        | exact hostnames, or a single leading `*.` label. Everything else is refused.                                                                                                                                                                                                                                         |
| `oauth`              | omit it for providers that need no account grant. `clientRegistrationRef` names a client registration the host holds; never put a client secret in the manifest. The host calls `identity.url` with the fresh token after consent to read the stable account id, so that URL must be https and inside `egressHosts`. |
| `configSchema`       | optional JSON Schema for per-source settings. The host validates each source's config against it and passes the result to `syncPage` as `config`.                                                                                                                                                                    |
| `serviceCredentials` | optional host-held service credentials, by reference. Their hosts must also be in `egressHosts`.                                                                                                                                                                                                                     |

## 3. Implement the daemon

The daemon speaks newline-delimited JSON-RPC 2.0 on stdin and stdout (`PROVIDER_DAEMON_METHODS`):

| direction     | method              | params                                             | result                             |
| ------------- | ------------------- | -------------------------------------------------- | ---------------------------------- |
| host → daemon | `papercup.ping`     | none                                               | any value; supervisor health check |
| host → daemon | `provider.describe` | none                                               | the `ProviderDescriptor`           |
| host → daemon | `provider.syncPage` | `{ request: ProviderSyncRequest, callToken }`      | `ProviderSyncPage`                 |
| host → daemon | `provider.invoke`   | `{ request: ProviderInvokeRequest, callToken }`    | capability result                  |
| daemon → host | `host.fetch`        | `{ callToken, source, request: HostFetchRequest }` | `HostFetchResponse`                |

The example returns `manifest.provider` from `provider.describe`, so the descriptor has one copy. It rejects `provider.invoke` with JSON-RPC error `-32601` because it serves no write capability.

### Sync

`syncPage` returns one page at a time:

```ts
interface ProviderSyncRequest { source: string; cursor: string | null; mode: 'backfill' | 'incremental'; config?: Record<string, unknown> }
interface ProviderSyncPage   { records: ProviderRecord[]; nextCursor: string | null; hasMore: boolean }
```

* **The cursor is yours and opaque.** The host commits `nextCursor` only after it has durably admitted the page's records. If a pass dies mid-way, the next pass resumes from the last committed cursor. Put everything you need to resume in it. The example stores, for each stream, the pending `@odata.nextLink` and the last `@odata.deltaLink`, so the next round resumes from the delta link instead of re-reading the mailbox.
* **Records** carry `datatype`, `nativeId` (unique within the source; the host adds the source id), `event` (the native event name used in `ext:<id>:<event>`), and `payload` in the datatype's canonical shape. Service-specific fields go under `payload.extensions.<provider-id>`; the example keeps Graph conversation ids and categories there. Set `deleted: true` for a remote delete.
* **Delivery identity.** Set `version` on a once-only event, such as a received message. The host then dedupes on it instead of on a payload hash, so a label edit or a replayed page never re-delivers the event. Leave it unset for objects whose edits are new deliveries.
* **Errors.** Throw (or return) a `ProviderSyncError` instead of retrying yourself: `cursor-expired` (the host restarts the source with a full resync), `rate-limited` (with `retryAfterSeconds`), `auth` (the connection needs the owner), or `transient`.

### Writes

When you declare a write capability such as `mail.draft`, `invoke` receives `{ source, capability, args, config? }` and performs the write through `host.fetch`. Apps call the shared verbs (for example `mail:draft`), and the host routes them to whichever provider serves the selected source.

## 4. Type-check it the way the journey does

`@papercusp/plugin-sdk` is not on the npm registry. Build its distributable tarball from a Papercusp checkout, then install that tarball:

```bash
# in the Papercusp checkout
npm run pack:dist --workspace @papercusp/plugin-sdk -- --out /tmp/sdk
# prints PLUGIN_SDK_TARBALL=/tmp/sdk/papercusp-plugin-sdk-<version>.tgz

# in your package
npm install --save-dev /tmp/sdk/papercusp-plugin-sdk-<version>.tgz
npm install --save-dev @microsoft/microsoft-graph-types @types/node typescript
npx tsc --noEmit -p tsconfig.json
```

The tarball is self-contained: compiled JavaScript plus declarations, no dependencies, and a vendored copy of the few `@papercusp/tooldef` type declarations the SDK uses. It installs and type-checks with nothing else from the monorepo. Do not install the source package by path (`npm install /path/to/papercusp/packages/plugin-sdk`) outside a Papercusp workspace: its main entry imports the private `@papercusp/tooldef` package, which cannot be installed there.

The SDK has two optional peers. Install only the ones you need:

| peer           | needed when                                               |
| -------------- | --------------------------------------------------------- |
| `@types/node`  | you import the main entry (`PluginStorage` uses `Buffer`) |
| `@types/react` | you import the main entry's UI types                      |

The `./provider` subpath, which is all a provider needs, requires neither.

TypeScript 6 defaults `compilerOptions.types` to an empty list, so installed `@types` packages are not loaded automatically. If you import the main entry, name Node explicitly:

```json
{
  "compilerOptions": {
    "strict": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"]
  }
}
```

Both `NodeNext` and `Bundler` module resolution work. `packages/plugin-sdk/src/dist-install.test.ts` builds the tarball, installs it into a fresh directory outside the tree, and type-checks the main entry and every subpath under both resolutions with `skipLibCheck` off.

With `// @ts-check` and JSDoc `@typedef` imports at the top of `daemon.mjs` (see the example), a JavaScript daemon gets the same checking as TypeScript. The suite runs exactly this check in a fresh directory outside the tree.

## 5. Declare the trigger pack

```json
"triggerPack": {
  "inputs": { "type": "object", "additionalProperties": false, "required": ["tone"], "properties": { "tone": { "type": "string" } } },
  "defaultStormPolicy": { "maxRuns": 5, "windowSeconds": 3600 },
  "targets": [
    { "id": "reply", "kind": "plan", "path": "plan-reply.md",
      "inputSchema": { "type": "object", "additionalProperties": false, "required": ["trigger", "tone"],
        "properties": { "trigger": { "type": "object", "additionalProperties": true }, "tone": { "type": "string" } } } }
  ],
  "bindings": [
    { "id": "inbound-mail",
      "source": { "kind": "external", "datatype": "email-message", "capabilities": ["mail.read"] },
      "target": "reply",
      "eventPattern": "ext:*:message.received",
      "filter": { "direction": "inbound" } }
  ],
  "edges": []
}
```

* **Targets** are plans. The plan file ships in the package and is instantiated into the installer's harness. A target's `inputSchema` receives the pack `inputs` plus `trigger`.
* **Read the triggering event through `triggers:read-payload`.** Do not rely on the event body arriving in the plan's inputs. The verb resolves the event server-side from the plan run, so the plan should read it there (see `plan-reply.md`).
* **Bind by datatype, not by provider.** An external binding names a `datatype` and the capabilities it needs. At install, the host binds it to a local data source that produces that datatype. The pattern `ext:*:message.received` matches the same event from any provider, so the pack works with Gmail, Outlook, or a provider written later.
* **`defaultStormPolicy`** caps runs per window, so a burst of mail cannot launch an unbounded number of plans.
* **`edges`** chain bindings: a `binding-run-completed` edge starts a downstream binding when an upstream run succeeds. Cycles are refused.

Validate the declaration with `validateTriggerPackDeclaration` from the SDK before you publish.

## 6. Install, connect, sync, arm

These are the doors the journey suite drives, in order.

1. **Publish.** `cupboard:publish-plugin` lists the package on the Cupboard from its GitHub repository. Publishing is outward-facing; it is not needed to test locally (`cupboard:install-plugin` also takes a `githubUrl`).
2. **Install, with consent.** `cupboard:install-plugin { listingId | githubUrl, harness }` refuses a provider the first time with `provider_install_consent_required`, writes nothing, and returns `data.review`: the exact datatypes, capabilities, scopes and egress hosts. The owner re-calls with `acceptCapabilities: true` and `expectedReview` set to that review. If the package changed in between, the install refuses with `plugin_review_changed` and returns the new review. Pack settings go in `triggerPackConfig: { sourceMappings, inputs }`.
3. **Run.** Plugin discovery registers the provider and starts the daemon in the sandbox.
4. **Connect.** The owner connects an account through the OAuth start route and its callback. The journey suite calls `GET /api/oauth/start?provider=…&plugin=…&harness=…&field=…`, then follows the authorize redirect to `/api/oauth/callback`. The host holds the token and creates a data source of kind `<provider id>`. The route has no provider-specific branch; your descriptor's `oauth` block is all it needs.
5. **Sync.** The connector runtime calls `syncPage` on its cadence and lands records in the owner's Vault. Re-installing after connecting binds the pack's external bindings to the new source by datatype; the bindings stay disarmed.
6. **Review and arm.** `trigger-packs:review { installationId }` returns everything the pack can do once armed, plus a fingerprint. `trigger-packs:arm { installationId, fingerprint }` arms every binding the pack owns. A stale fingerprint is refused with the current review. Any later change to the pack (an update, a re-configure) disarms its bindings and clears the review, so the owner reviews again.

`trigger-packs:export { installationId, outDir }` writes an installed pack back out as a portable package (its plans sanitized into templates). `trigger-packs:uninstall` detaches the bindings, archives the plans and revokes grants.

## 7. Test it the way the journey does

Copy the shape of the journey suite for your own provider. Every negative control there has a positive control beside it, so a check that stopped detecting cannot pass vacuously:

| control           | what it proves                                                                |
| ----------------- | ----------------------------------------------------------------------------- |
| consent           | without a pinned review the install refuses and writes nothing                |
| replay            | a redelivered event and a re-served delta page admit and launch nothing twice |
| arm               | the pack fires exactly once after an explicit arm, and never on replay        |
| token leak        | no frame carries a token; a deliberately leaky fake service is caught         |
| account isolation | a call cannot fetch for a source it was not called for                        |
| egress            | an undeclared host is refused and the cursor stops at the refused request     |
| sandbox           | without bubblewrap the daemon does not run                                    |

Run your fake service API as a stub `fetch` behind the host: the daemon then reaches it only through `host.fetch`, as it does in production. Type the fixtures against the service's published types, so a drifted fixture fails to compile.

## Reference

* SDK contract: `packages/plugin-sdk/src/provider.ts` (`ProviderDescriptor`, `ProviderAdapter`, `ProviderRecord`, `ProviderSyncError`, `PROVIDER_DAEMON_METHODS`).
* Example package: `packages/operator-core/test/fixtures/outlook-graph-provider/`.
* Journey suite: `packages/operator-core/lib/integrations/independent-author-journey.integration.test.ts`.
* Install and consent: `packages/operator-core/lib/cupboard/install-plugin-core.ts`.
* Pack materialization and lifecycle: `packages/operator-core/lib/cupboard/trigger-pack-materialize.ts`, `trigger-pack-lifecycle.ts`.
* First-party providers on the same contract: `libs/papercusp/plugins/gmail/`, `libs/papercusp/plugins/google-calendar/`.
* Design and decisions: plan `generalized-integrations-google-migration-cupboard-workflows-2026-10-05` (D-006 daemon protocol, D-013 materialization, D-016 pack lifecycle, D-017 delivery identity, D-026 this journey).
* Chat provider with pasted credentials, app registration and socket ingress: `libs/papercusp/plugins/slack/` (see the worked example below).
* Provider-neutral trigger pack with picker inputs: `libs/papercusp/plugins/bug-triage/`.
* Socket-provider journey suite: `packages/operator-core/lib/integrations/socket-provider-author-journey.integration.test.ts`, fixture `packages/operator-core/test/fixtures/teamchat-socket-provider/`.
* Public mirror export for first-party Cupboard packages: `scripts/plugin-mirror-export.mjs`.
* Chat provider decisions: plan `cupboard-distributable-integrations-2026-10-10` (D-014 public mirrors, D-015 cupboard-only distribution, D-017 pack setup on Settings, D-023 source config in ingress).

## Ticket-provider examples: Linear and Asana

The maintained ticket-provider examples are `libs/papercusp/plugins/linear` and `libs/papercusp/plugins/asana`. Both declare contractVersion 1, datatypes `ticket`, `ticket-status-change`, and `ticket-comment`, and capabilities `ticket.read`, `ticket.comment`, `ticket.transition`, and `ticket.containers`. Tickets default to record destinations; status changes to events; comments to documents. An admission rule or manual promotion makes a ticket into work.

Linear uses GraphQL through host.fetch and its OAuth descriptor requests an app actor with read, write, app:assignable and app:mentionable scopes. Its source config requires teamIds. Canonical ticket selfRoles are derived from authenticated assignee/delegate identities. Workflow types map to the shared ticket status vocabulary. Linear does not currently declare push capabilities.

Asana uses REST through host.fetch, requires projectGids, and supports workspaceGid and sectionCategories mapping. The driver starts with project crawls and continues with per-project Events API tokens; a stale token requires a new crawl. Multi-homed tasks retain one canonical task identity.

Asana additionally declares push.subscribe and push.unsubscribe plus a data-only push descriptor: x-hook-secret handshake and hex HMAC-SHA256 x-hook-signature. The host owns signature verification and encrypted handshake-secret storage. Subscribe reconciles one webhook per configured project; a delivery only wakes reconciliation, never supplies authoritative ticket data. Polling remains the fallback.

Regression examples: packages/operator-core/lib/providers/linear/linear-provider.test.ts and linear-provider.integration.test.ts; providers/asana/asana-provider.test.ts and asana-provider.integration.test.ts; providers/connector-push.integration.test.ts. The current real-workspace acceptance remains pending under linear-asana-task-sync-2026-10-05; these examples describe implementation, not a shipment receipt.

## Chat-provider worked example: Slack and bug-triage

The maintained chat example is a pair of packages: the provider `libs/papercusp/plugins/slack` and the trigger pack `libs/papercusp/plugins/bug-triage`. Together they replace the Slack ingestion and Slack-to-ticket bug workflow that used to be built into the app (plan `cupboard-distributable-integrations-2026-10-10`). Both declare `"distribution": "cupboard"`, so the bundled plugin root never loads them; a workspace gets them only by installing from the Cupboard (D-015). Each is published as its own public repository (`Papercusp/papercusp-slack`, `Papercusp/papercusp-bug-triage`), exported from the in-tree package by `scripts/plugin-mirror-export.mjs` (D-014).

Slack shows provider features that the ticket examples above do not use: pasted credentials (one of them pasted by each person for themselves), an app definition the user creates the app from, a host-held socket with a fast path for interactive envelopes, channel membership, and live search.

### The provider: credentials, app registration, socket

```json
"provider": {
  "id": "slack",
  "contractVersion": 1,
  "datatypes": ["chat-message"],
  "capabilities": ["ingress.normalize", "chat.channels", "chat.reply", "search.live"],
  "egressHosts": ["slack.com"],
  "defaultDestinations": { "chat-message": ["document", "event"] },
  "membership": { "identityProvider": "slack", "containers": true },
  "ingress": {
    "socket": {
      "credential": "app_token",
      "open": { "url": "https://slack.com/api/apps.connections.open", "method": "POST", "urlField": "url" },
      "ackField": "envelope_id",
      "reconnect": { "field": "type", "values": ["disconnect"] },
      "immediate": { "field": "type", "values": ["interactive"] }
    }
  },
  "setup": {
    "credentials": [
      { "key": "app_token", "label": "App-level token", "pattern": "xapp-[A-Za-z0-9-]{10,}", "placeholder": "xapp-1-...", "help": "..." },
      { "key": "bot_token", "label": "Bot token", "pattern": "xoxb-[A-Za-z0-9-]{10,}", "placeholder": "xoxb-...", "help": "...", "hosts": ["slack.com"] },
      { "key": "user_token", "label": "Your Slack user token", "pattern": "xoxp-[A-Za-z0-9-]{10,}", "placeholder": "xoxp-...", "help": "...", "hosts": ["slack.com"], "perPrincipal": true }
    ],
    "appRegistration": {
      "createUrl": "https://api.slack.com/apps?new_app=1&manifest_json={definition}",
      "docsUrl": "https://api.slack.com/reference/manifests#creating_apps",
      "copyHint": "Create New App → From a manifest → paste this JSON.",
      "definition": { "...": "the full Slack app manifest" }
    }
  }
}
```

* **`setup.credentials`** declares masked paste-a-secret fields. The host checks each pasted value against its `pattern` (anchored, via the SDK) before saving it, stores it host-side the same way it stores OAuth tokens, and never returns it to the page or the package. The bot token lists `hosts: ["slack.com"]`, so `host.fetch` attaches it only to requests for that host. The app token is the one the socket descriptor names. A credential marked `perPrincipal: true` belongs to one person: each person pastes their own value, the host stores it under that person and attaches it only to requests made for them. Slack's user token is one, so live search runs with the searcher's own Slack access.
* **`setup.appRegistration`** lets the provider's card on Settings → Integrations offer **Create app**: the host substitutes the bundled `definition` into `createUrl`. A copy-the-definition fallback uses `copyHint`. Slack's definition enables Socket Mode, registers `/papercusp`, adds the **Report a bug** message shortcut and turns on interactivity, subscribes the bot to `app_mention`, `message.channels`, `message.groups`, `message.im` and `reaction_added`, and requests only the scopes those need (`app_mentions:read`, the four `*:history` scopes, `channels:read`, `groups:read`, `commands`, `chat:write`, `reactions:read`, and the user scopes `search:read.public`, `search:read.private`, `search:read.mpim` and `search:read.im`).
* **`ingress.socket`** is a descriptor, not code. The host opens the connection: it calls `open.url` with the credential named by `credential`, reads the WebSocket address from `urlField`, acknowledges every envelope by echoing its `ackField`, and reconnects when a frame's `type` is one of `reconnect.values`. Each envelope goes to the daemon's `ingress.normalize` capability as `{ envelope, sourceConfig }`, where `sourceConfig` is the connected source's non-secret config (never a credential; the SDK type is `ProviderIngressNormalizeArgs`). The capability returns canonical `chat-message` records. A frame whose `immediate.field` is one of `immediate.values` (Slack's `interactive` envelopes, such as the shortcut that opens the report form) is processed on its own chain instead of waiting behind queued envelopes, so the package can answer inside a short vendor response window. The package never holds the socket or the app token.
* **`membership`** with `containers: true` says the provider reports containers (Slack channels) and their current members, as ids from `identityProvider`. Each record names its container as `aclRef`, so a message is readable only by members of its channel.

The daemon (`daemon.mjs` over `provider.mjs`) implements four capabilities, plus `provider.syncPage` for organization sources:

* `ingress.normalize`: `normalizeEnvelope` turns an Events API envelope or a slash command into zero or more `chat-message` records (channel, author, text, thread, mentions, timestamp). It drops bot-authored posts so the package never reacts to its own replies. The one exception is a test identity the source declares in `sourceConfig.testBotAllowance`: a post that matches its bot, app, user and channel exactly, in one of the source's watched channels, is kept as a plain message, so an automated drill can post as a bot (D-023). A provider with no source-scoped rules ignores `sourceConfig`.
* `chat.channels`: `listChannels` returns the workspace's channels. Trigger-pack forms use it to fill channel pickers.
* `chat.reply`: `replyInThread` posts a threaded reply through `host.fetch`.
* `search.live`: `{ query, limit }` searches Slack with the searching person's own user token, so Slack decides what they can see. Nothing is stored.
* `provider.syncPage`: on an organization source, each round starts with a membership page (every channel the app is in, with its members), then backfills newly seen channels one history page at a time as `history` records, so workflows bound to new messages never fire on old ones.

`ingress.normalize` also turns a :bug: reaction (`reaction`) and a message reported through the **Report a bug** form (`report`) into records, which is how Bug triage receives the report gestures.

### The trigger pack: bug-triage

```json
"triggerPack": {
  "inputs": {
    "type": "object", "additionalProperties": false, "required": ["channels", "destination"],
    "properties": {
      "channels": { "type": "array", "title": "Channels to watch", "minItems": 1,
        "items": { "type": "string", "minLength": 1 },
        "x-options": { "capability": "chat.channels" } },
      "destination": { "type": "string", "title": "File bugs in", "minLength": 1,
        "x-options": { "capability": "ticket.containers", "args": { "purpose": "create" } } }
    }
  },
  "defaultStormPolicy": { "maxRuns": 20, "windowSeconds": 300 },
  "targets": [ { "id": "triage-message", "kind": "plan", "path": "plan.md" } ],
  "bindings": [
    { "id": "message-to-triage",
      "source": { "kind": "external", "datatype": "chat-message" },
      "target": "triage-message",
      "eventPattern": "ext:*:message",
      "filter": { "all": [ { "text": { "exists": true } } ] },
      "mapping": { "mode": "payload-context" } }
  ]
}
```

* **It names no provider.** The binding asks for the `chat-message` datatype, and `ext:*:message` matches that event from any chat provider, so the same pack works with Slack today and with a chat provider written later.
* **`x-options` turns inputs into pickers.** The settings form fills the channel list from whichever installed provider offers `chat.channels`, and the destination list from whichever offers `ticket.containers` (Asana or Linear). The user picks; nothing is typed.
* **The destination is fixed by the installation.** The plan (`plan.md`) treats the message as untrusted. It files through `ticket:file`, which resolves the destination from the installation that owns the run's binding and refuses a message from a channel the installation does not watch; neither the message nor the worker can redirect a ticket, and a replayed run returns the ticket it already filed instead of filing again (D-012).
* **Installing does not arm it.** Installed from the Cupboard without a project, the pack appears as a section on Settings → Integrations; choosing the project there materializes it (D-017). The user then picks channels and a destination, reviews the disarmed binding, and arms it.

### Building and publishing these two packages

1. **Build and test in the tree.** Change `libs/papercusp/plugins/slack` or `libs/papercusp/plugins/bug-triage`, then run `packages/operator-core/lib/providers/slack/slack-package.test.ts` and `scripts/plugin-mirror-export.test.mjs`. The second test exports both packages the way publishing does and fails on anything a standalone checkout could not use: an import outside the package, an undeclared dependency, a missing licence, or text that cites internal context (a work-item or session id, a dated plan slug, a home-directory path, an operator port). In plugin source, describe the behaviour rather than the plan that asked for it.
2. **Let the change commit.** The export reads committed content only, so an uncommitted edit can never reach a public repository.
3. **Push the mirror.** `node scripts/plugin-mirror-export.mjs --package slack --out /tmp/papercusp-slack-publish --push https://github.com/Papercusp/papercusp-slack.git` clones the mirror repository, replaces its tree with the export, and pushes one commit on top of its history; unchanged content pushes nothing. A new package's repository is created once beforehand (`gh repo create Papercusp/papercusp-<name> --public`).
4. **List it.** `cupboard:publish-plugin { slug, githubUrl }` creates the Cupboard listing from that repository (step 6 above), and the listing becomes installable once it is approved. Workspaces get a pushed revision when they next install or update the package from the listing.

### What the user does

1. In the Cupboard, install **Slack** and **Bug triage**.
2. On Settings → Integrations, open the Slack card, choose **Create app**, install the app to the workspace, and paste the app-level token and bot token.
3. In the Bug triage section, choose the project, the channels to watch and the destination, review, and arm.
4. A bug report posted in a watched channel becomes one ticket at the destination; other messages file nothing.

The Slack report-bug message shortcut and reaction gestures are not part of these packages. They belong to the app's own Slack connection, which does not run for a Slack source connected through the package (D-022); they move to packages under `provider-adapters-to-packages-2026-10-11#P-008` (D-019).

### Tests to copy

* `packages/operator-core/lib/providers/slack/slack-package.test.ts` and `slack-package.integration.test.ts`: the manifest contract, envelope normalisation (including the drill identity), and the capabilities against a stubbed Slack API.
* `packages/operator-core/lib/integrations/socket-provider-author-journey.integration.test.ts` with the fixture `packages/operator-core/test/fixtures/teamchat-socket-provider/`: an outside author's socket provider taken through publish, install, connect, arm and fire on the real Cupboard and host paths. Start a new socket provider from this fixture.
* `packages/operator-core/lib/capability-verbs/ticket.integration.test.ts`: `ticket:file` resolving and pinning the destination from the bug-triage installation.
* `packages/plugin-loader/src/loader.test.ts`: the bundled plugin root skipping `distribution: "cupboard"` packages.
