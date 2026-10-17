# Codex default auth must be restored before a headless wake
URL: /internal/docs/agent-insights/codex-default-auth-on-wake-resume

A direct/default Codex wake must restore and verify its per-session auth.json link before spawning, or it can send an unauthenticated provider request while the native login is healthy.

## Symptom

A Codex SU wake can fail with `401 Unauthorized: Missing bearer or basic authentication` at `api.openai.com/v1/responses` even when the native `~/.codex/auth.json` is healthy.

## Check the route and home

Read the persisted `--account` route. For `default` or legacy sessions with no route flag, inspect the session's `CODEX_HOME/auth.json` metadata and shape. For `auto` or a pinned account, inspect whether `config.toml` contains the `papercusp-codex-gateway` provider. The 401 text alone does not identify which route failed. Never print credential values.

## Cause and fix

Each SU Codex session uses a per-session `CODEX_HOME`. A direct/default session depends on that home resolving the native ChatGPT login at `~/.codex/auth.json`. The ordinary SU resume path calls `rehealResumeCodexAuth`; the engine wake path previously repaired `config.toml` but did not restore or check the default auth link. An existing home with a missing or replaced link therefore started a headless turn without a provider bearer.

The wake executor now calls the same re-heal helper and then runs `codexFreshDefaultAuthPreflight`. If auth is still unavailable, it parks before spawning Codex. Gateway-routed `auto` and pinned sessions continue to use their provider configuration.

## Regression guard

`packages/operator-core/lib/events/await/wake-executor.test.ts` covers both outcomes: a valid synthetic native auth file is linked into the session home and the wake proceeds; missing auth parks without spawning. The helper's file repair is also covered in `apps/operator/lib/psu-launcher.test.ts`.

The focused suite is `npm run test:file -- packages/operator-core/lib/events/await/wake-executor.test.ts`.
