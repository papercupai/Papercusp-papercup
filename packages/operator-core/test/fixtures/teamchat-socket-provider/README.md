# teamchat-socket-provider (test fixture)

A chat integration written the way an author outside Papercusp writes one, with the same shape as
the first-party `slack` package (plan cupboard-distributable-integrations-2026-10-10, R-6):

- **Socket ingress the host holds.** `provider.ingress.socket` names the pasted credential that
  opens the gateway, the response field holding the socket URL, the field the host acks, and the
  notice that means "reconnect". The daemon only normalizes each delivery (`ingress.normalize`).
- **Pasted setup.** `provider.setup.credentials` declares two masked fields; the one with `hosts`
  is injected by the host into `host.fetch` calls to those hosts. `setup.appRegistration` carries
  the app definition the Integrations card offers to create.
- **Canonical datatype.** Messages become `chat-message` records; vendor fields live under
  `payload.extensions.teamchat`.

`daemon.mjs` imports only Node builtins and takes its types from `@papercusp/plugin-sdk`. The
journey test (`packages/operator-core/lib/integrations/socket-provider-author-journey.integration.test.ts`)
type-checks it outside the tree, pushes it to a stand-in GitHub, publishes it to a stand-in
Cupboard, installs it by listing id, connects it with pasted tokens, and receives a message over
the socket.
