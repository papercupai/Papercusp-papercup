# psu resume: tolerate legacy operator rows and avoid handoff directory scans
URL: /internal/docs/agent-insights/psu-resume-legacy-operator-and-handoff-scan

Diagnosing false missing-agent errors during operator version skew and unnecessary handoff scans on initial psu launches.

## Failure shape

A command such as `psu --resume su-<uuid>` can pause at `host-handoff-lookup` and then report that a valid agent has no resumable session. In WI-6554700010014956 the startup log recorded 29,718 ms inside that lookup. A later directory census found 11,649 entries, but the census alone does not explain that particular latency.

## Two code defects

A launcher newer than the serving operator can call `/api/adv/sessions/resumable?agentId=…` against an operator that predates this query. Its response has `sessions` but no `exact` marker. Treating the missing marker as absence hides a row that actually names the requested `coordOwnerId`. The affected owner resolved to adv row 44519 through the repaired launcher against that same legacy endpoint.

Separately, `reexecExitCodeFrom` proves that the parent shim supports re-execution; it does not prove that the current invocation is a restart. Treating every supported launch as an adoption made initial launches scan the shared PTY directory for a predecessor handoff that could not exist.

## Recovery rules

For a legacy response without `exact`, the recent picker window cannot establish the latest owner registration. The first compatibility fix searched that window; on 2026-10-16 the same owner aged out and the live lookup failed again. A historical matching row inside the window can also hide a newer registration outside it.

The resolver now reuses `/api/adv/roster/agent?owner=…`, whose existing native-session handle resolves that owner's latest registration independently of the picker. Claude supplies a native UUID for an exact session read. Codex/OMP native-store paths supply only numeric row hints for an exact row read. The returned row must prove the requested owner and backend (and the exact id/request binding); store names are never accepted as identity proof. Unsupported legacy handles name the operator upgrade or numeric-session-ID remedy. Modern `exact` responses keep the strict id/owner/request checks.

Both maintained wrappers export `PAPERCUSP_PSU_REEXEC_COUNT` on each pass. The initial invocation sets `0`, overwriting inherited values; actual sentinel restarts increment it. The launcher skips handoff discovery for explicit count `0`. A missing marker retains legacy-shim recovery until that installed wrapper is refreshed through `writeShim` (or the normal installer). This marker changes startup discovery only; `reexecExitCodeFrom` remains the authority for whether the parent can restart the host.

On actual restarts with a known owner, read `<owner>.handoff.json` directly while retaining the parent-PID check. When no owner is available, keep the legacy parent-PID directory lookup. Parent mismatch is refused.

## Recurrence guards

The launcher suite covers legacy responses, stale same-owner picker entries, out-of-window recovery for Claude/Codex/OMP, foreign owners/backends, malformed handles, registration ordering, and lookup failures. PTY and adoption tests preserve handoff identity and parent checks. The managed-shim and release-wrapper tests exercise initial and subsequent counter values with an inherited stale value. The Local-startup integration test places a blocking FIFO in the handoff directory: a first launch cannot reach its first menu if it accidentally scans that directory. No agent backend or live session is started by these probes.
