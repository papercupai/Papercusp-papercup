# Docker capacity read deadlines runbook
URL: /internal/docs/agent-insights/docker-capacity-read-deadlines-runbook

Diagnose a Docker disk-usage timeout with the maintained reader and distinguish a slow volume walk from an unavailable engine.

Use the existing `measureDocker()` in `packages/operator-core/lib/storage/disk-consumer-census.ts` for Docker category sizes. It checks the socket, reads `/info`, then reads `/system/df` with the maintained 180-second timeout. It returns parsed category totals or throws a timeout/error; a missing accessible socket returns null. This procedure reuses that reader and its existing test suite, rather than adding another collector.

A blanket `timeout 20s docker system df` can stop a legitimate disk walk before Docker emits any output. On 2026-10-14, Engine 29.4.0/API1.54 returned the volume-only disk-usage response in 21.754 seconds, while `_ping` took 1 ms, images 102 ms and build cache 27 ms. A later invocation of the maintained reader returned valid categories in 15.635 seconds. These are separate timed requests: they show variability and disprove treating 20 seconds as a reliable healthy-engine cutoff. They do not identify the phase of the historical 2026-10-12 timeout in EI-25740691402258538.

1. Recover the exact original command, deadline, exit code and durable outcome. Exit124 with zero output is a timed-out diagnostic, not an empty inventory.
2. Read the maintained reader before choosing a diagnostic budget. Keep request handles until completion and retain errors separately from category data.
3. If component attribution is needed, time read-only Engine requests for `_ping` and `/system/df?type=container`, `type=image`, `type=volume`, and `type=build-cache`. The resource names are singular; plural names return HTTP400. Use the types supported by the measured Engine API version. Record only bounded timing/status summaries; do not dump container configuration.
4. Use `measureDocker()` for the complete category result. For a shell-only diagnostic, keep enough bounded runtime for the maintained request budget and report a timeout explicitly. Do not infer CPU, memory or disk contention from a slow read without mechanism-level measurements.
5. Preserve the distinction between category totals and safe reclaim: these sizes do not establish dangling status, active references, exclusive allocated bytes, custody, or deletion eligibility. No prune or threshold change follows from this read alone.

The existing unit suite now guards a valid response delayed25seconds, an explicit20second timeout that rejects rather than returning an empty inventory, and the maintained default bound for an unresponsive engine. Run only new/changed/failed cases when prior passing evidence is already retained; the suite's describe name is `measureDocker response deadlines`.

Evidence: EI-25740691402258538, controlled native measurement b741ff, maintained reader native17891, testing:run1dd98a75-d301-45fb-81e6-2ddefb7046c7 and canonical test-run21232308 (3passed,0failed,4unselected). Historical command task0mv4nuiq61ctzzk21cp ended124 after20138ms with zero output; its original log is no longer present, so its internal phase remains unknown.
