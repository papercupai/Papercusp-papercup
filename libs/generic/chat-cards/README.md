# @papercusp/chat-cards

Host-free React renderers for the interactive-card contract in
`@papercusp/chat-protocol`.

The package owns card presentation and response shaping. Hosts supply current
cards, I/O callbacks, optional rich report rendering, and their own theme CSS.
It never fetches and imports no operator or portal path.

`StructuredResults` extends this props seam for typed results with provenance.
Supply a host-owned `authorizationKey` (caller/scope plus revocation epoch),
`resolve`, and optionally `activate` and selected kind renderers. No result
content appears before resolution. IDs, source references and offered action
identities must match. A missing selected renderer has an explicit unsupported
outcome; failed resolution/activation clears the content.

The backend must recheck current scope and resource/action identity during both
resolution and activation. `activate` owns authorization and its effect together;
separate authorize-then-dispatch callbacks would introduce a race. UI abort/epoch
fences suppress late responses; they do not enforce backend access. Replay never
activates actions. Host renderers and Markdown callbacks are trusted application
code, never result payloads. Default rendering reuses `ui-primitives/markdown`
with safe external links and inert images. Hosts compose existing product,
report, work-reference and interactive card views. No persistence or durable
execution is added. DOM fixtures are tree evidence; actual host, backend,
browser and release acceptance remains separate.
