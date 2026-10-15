# Codex resume connectivity refusals: distinguish a network outage from IPv6 fallback symptoms
URL: /internal/docs/agent-insights/codex-network-refusal-dhcp-and-address-family-evidence

A live psu resume refusal can reflect a real, recovered upstream-connectivity interruption. Inspect complete transport history before treating the latest IPv6 ENETUNREACH as the cause or changing account routing.

## Observed case

On 2026-10-07, a local `psu --resume` correctly refused an auto-routed Codex launch because the gateway reported `upstream-unreachable`. Gateway logs recorded the unreachable edge at 20:57:01 EDT after three transport failures across three accounts, with no HTTP response since 20:56:58.972. An HTTP response at 20:59:09 cleared the reachability condition. This was distinct from the previously repaired packaged-backend recursion.

## Avoid the IPv6-only diagnosis

The latest `/stats` error mentioned only IPv6 `ENETUNREACH`, and the host had no default IPv6 internet route. However, earlier failures also contained IPv4 `ETIMEDOUT` against both current upstream IPv4 addresses. The IPv6 fallback errors therefore did not establish the cause of the broader outage. NetworkManager separately recorded a WiFi DHCP restart and renewed lease at 20:59:04. That is correlated evidence, not proof that DHCP caused the preceding outage. Do not disable IPv6 or pin DNS addresses from the final error alone.

## Verification and response

After recovery, an unauthenticated IPv4 HTTP probe received a response, `/stats` showed six healthy Codex accounts with `unreachable:false`, the ordinary `preflightCodexAutoPool` call returned true without an override, and a streamed `gpt-6.1-sol` request through `chatgpt-sub-cli` returned OK and completed. The owner can retry the original resume command; no network restart, account mutation, or launch-guard bypass was needed for this verified recovered state.

The underlying cause of the connection interruption was not established. Report the actual outage and current recovery honestly rather than claiming a permanent network repair or attributing a transport error to usage credits.
