# Connect Linear and Asana tasks to Papercusp
URL: /internal/docs/guides/linear-asana-ticket-sync

Configure ticket sources, admission and workflow write-back for Linear and Asana; current-build guide pending real-workspace acceptance.

This guide describes the current implementation. Real-workspace acceptance is still pending; it does not assert that this feature has shipped.

## Connect an account

In the Papercusp desktop app, open Settings → Integrations. Choose Linear or Asana and use Connect to authorize the account. The OAuth client must already be registered on this Papercusp installation. If Connect reports an unknown provider, check the installation's OAuth client registration before retrying. Client secrets belong in injected configuration outside the repository.

For staging acceptance, the OAuth app must allow `http://localhost:3170/api/oauth/callback`; the release callback is `http://localhost:3070/api/oauth/callback`. Consent remains the account owner's action.

## Choose what to sync

For Linear, select one or more teams. For Asana, select the workspace and one or more projects. Select the Papercusp project that will receive admitted work. Save the source configuration. Asana also lets you map project sections to workflow categories such as Todo, In Progress and In Review; task completion supplies Done.

Linear connects as an app actor. Delegate an issue to Papercusp when you want the app to handle it. Asana's account identity can be assigned tasks. The source records the authenticated account's role on each ticket; matching is based on that identity rather than a person's display name.

## Records and work

Synced issues and tasks become ticket records. Their status changes become events and their comments become documents. A matching admission rule or a manual promotion turns a ticket into linked Papercusp work. An unmatched ticket remains a record. Review the admission rule and target project before delegating production tasks.

Work-item claim and completion drive configured status write-back and summary comments. A person closing a source task mid-work holds the linked work and informs its holder. The live acceptance drill must still verify these behaviours with both real services.

## Push and polling

Polling remains the reconciliation path. Asana can subscribe one webhook per selected project when Remote access is enabled and the source has a public receiver URL. Its handshake secret is stored encrypted; a signed delivery only wakes that source's next reconciliation. The webhook body is not treated as ticket data. Without a public URL, polling continues.

The current Linear provider uses polling. Linear push routing is an open owner decision: a hosted app-level router or per-connection admin permission would be needed to enable it. This guide will be updated after that choice; it does not promise Linear push.

## Acceptance checklist

Use isolated test projects in the real workspaces. Check delegation or assignment creates one linked item in the selected project; unmatched tasks remain records; claim moves the source task to In Progress; completion posts the summary and configured final status; human closure mid-work holds the item and informs the holder; reconnect and repeated polling do not duplicate work or comments. Observe polling for 24 hours to check echo loops. Archive the test projects only after recording evidence and receiving the required account authorization.

## Provider examples

The maintained provider implementations are `libs/papercusp/plugins/linear` and `libs/papercusp/plugins/asana`. See [Authoring an integration provider and a trigger pack](/internal/docs/plugins/provider-and-trigger-pack-authoring) for the host/provider boundary.
